'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {ForgeBackendManager}=require('../runtime/forge-backends.cjs');
const {pluginResponse}=require('../runtime/forge-content.cjs');
const config=require('../forge.config.json');
const bundledRoot=path.join(__dirname,'../plugins'),id='forge.web-chat';
const versions={forge:config.version,apiVersion:config.apiVersion,codex:config.codexVersion};

test('built-in web chat requires review and serves its complete panel under the existing CSP',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-web-panel-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const registry=new ForgeRegistry({root,bundledRoot,versions});
  assert.deepEqual(registry.errors,[]);
  assert.equal(registry.status(id).enabled,false);
  assert.equal(registry.reviewed(id),false);
  assert.equal(pluginResponse(registry,'codex-forge://plugin/'+id+'/main').status,404);
  registry.recordReview(id);registry.setEnabled(id,true);
  const response=pluginResponse(registry,'codex-forge://plugin/'+id+'/main'),html=await response.text();
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Security-Policy'),/script-src 'unsafe-inline';/);
  assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none';/);
  assert.doesNotMatch(html,/<script\b[^>]*\bsrc\s*=/i);
  assert.match(html,/apiVersion: 6,/);
  assert.match(html,/backend\.call\(['"]status['"]/);
  assert(registry.get(id).manifest.contributes.sidebar.some(item=>item.panel==='main'));
});

test('web-chat background events survive the configure RPC returning in a real worker',async t=>{
  const http=require('node:http'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-web-lifecycle-'));
  const pluginRoot=path.join(root,'bundled',id),connectionFile=path.join(root,'pairing.json');
  fs.cpSync(path.join(bundledRoot,id),pluginRoot,{recursive:true});
  // The production connector/lifecycle runs unchanged, with HTTP restricted to
  // this loopback fixture. No real pairing files or external network are used.
  fs.writeFileSync(path.join(pluginRoot,'isolated-entry.cjs'),
    "exports.activate=forge=>{const connector=require('./backend.cjs').createConnector(forge,{allowLocal:true,connectionFile:"+JSON.stringify(connectionFile)+"});"+
    "for(const name of ['status','configure','reconnect','disconnect'])forge.handle(name,args=>connector[name](args));forge.onDispose(()=>connector.stop());void connector.start();};");
  const manifestFile=path.join(pluginRoot,'plugin.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  manifest.backend.entry='isolated-entry.cjs';fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const sockets=new Set(),server=http.createServer();
  server.on('upgrade',(req,socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const registry=new ForgeRegistry({root:path.join(root,'data'),bundledRoot:path.join(root,'bundled'),versions});
  let arrived,failed,timer,bootstrapArrived;
  const nextEvent=()=>{const pending=new Promise((resolve,reject)=>{arrived=value=>{clearTimeout(timer);resolve(value);};failed=reject;timer=setTimeout(()=>reject(Error('No background events request')),3000);});pending.catch(()=>{});return pending;};
  const stopped=[],events=nextEvent();
  const manager=new ForgeBackendManager({registry,nodePath:process.execPath,onEvent:event=>{if(event.type==='backend.stopped'){stopped.push(event);failed(Error(event.error.code+': '+event.error.message));}},request:async(_id,method,args,context,{signal})=>{
    if(method==='remoteChat.bootstrap'){bootstrapArrived?.(context);return {connected:true,cursor:0,connectionEpoch:'test-epoch'};}
    assert.equal(method,'remoteChat.events');arrived(context);
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
  }});
  t.after(async()=>{clearTimeout(timer);await manager.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  registry.recordReview(id);registry.setEnabled(id,true);await manager.sync();
  await manager.call(id,'configure',{url:'http://127.0.0.1:'+server.address().port,token:'isolated-lifecycle-token-00000000000000'},{});
  const context=await events;
  assert.equal(context.threadId,null);
  assert.equal(context.source,'backend');
  assert.equal((await manager.call(id,'status',{},{})).connected,true);
  const again=nextEvent();
  await manager.call(id,'reconnect',{},{});
  assert.equal((await again).source,'backend');
  assert.equal((await manager.call(id,'status',{},{})).connected,true);
  const webCall=new Promise((resolve,reject)=>{bootstrapArrived=context=>{clearTimeout(timer);resolve(context);};timer=setTimeout(()=>reject(Error('No browser request forwarded')),3000);});
  const body=Buffer.from(JSON.stringify({type:'call',id:'page',requestId:'once',method:'bootstrap',params:{}}));
  assert(body.length<126);
  [...sockets].at(-1).write(Buffer.concat([Buffer.from([0x81,body.length]),body]));
  assert.equal((await webCall).source,'backend');
  assert.equal(stopped.length,0,'returned RPCs never retire the background worker');
});

test('packaged web-chat worker rereads late pairing configuration and stops cleanly without network',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-web-worker-'));
  const pluginRoot=path.join(root,'bundled',id),home=path.join(root,'isolated-home');
  fs.cpSync(path.join(bundledRoot,id),pluginRoot,{recursive:true});fs.mkdirSync(home);
  // Only the test worker's home lookup is redirected. The bundled backend and
  // its real activate/register lifecycle are exercised without user config.
  fs.writeFileSync(path.join(pluginRoot,'isolated-entry.cjs'),
    "require('node:os').homedir=()=>"+JSON.stringify(home)+";\n"+
    "const fail=()=>{throw Error('Unexpected network while unconfigured');};\n"+
    "require('node:net').connect=fail;require('node:net').createConnection=fail;require('node:tls').connect=fail;\n"+
    "module.exports=require('./backend.cjs');\n");
  const manifestFile=path.join(pluginRoot,'plugin.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  manifest.backend.entry='isolated-entry.cjs';fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const registry=new ForgeRegistry({root:path.join(root,'data'),bundledRoot:path.join(root,'bundled'),versions});
  const requests=[],manager=new ForgeBackendManager({registry,nodePath:process.execPath,request:async(...args)=>{requests.push(args);assert.equal(args[1],'remoteChat.bootstrap');return {connected:false};}});
  t.after(async()=>{await manager.dispose();fs.rmSync(root,{recursive:true,force:true});});
  await manager.sync();assert.equal(manager.workers.size,0);
  registry.recordReview(id);registry.setEnabled(id,true);await manager.sync();
  assert.equal(manager.workers.size,1);
  const status=await manager.call(id,'status',{},{});
  assert.equal(status.configured,false);assert.equal(status.connected,false);assert.equal(status.error,null);
  await manager.call(id,'reconnect',{},{});
  assert.equal((await manager.call(id,'status',{},{})).configured,false);
  assert.deepEqual(requests,[]);
  assert.equal(fs.existsSync(path.join(home,'.codex','forge-web','connection.json')),false);
  // Pairing may be written after the worker started. Reconnect must reread it.
  const connectionFile=path.join(home,'.codex','forge-web','connection.json');
  fs.mkdirSync(path.dirname(connectionFile),{recursive:true});
  fs.writeFileSync(connectionFile,JSON.stringify({url:'https://127.0.0.1:1',token:'isolated-test-token-0000000000000000'}));
  await manager.call(id,'reconnect',{},{});
  assert.equal((await manager.call(id,'status',{},{})).configured,true);
  assert.equal(requests.length,1,'new configuration reaches the real host request bridge');
  fs.writeFileSync(connectionFile,'invalid-json');
  await manager.call(id,'reconnect',{},{});
  const invalid=await manager.call(id,'status',{},{});
  assert.equal(invalid.configured,false);
  assert.match(invalid.error,/连接配置读取失败/);
  assert.equal(requests.length,1,'invalid replacement never reuses old credentials');
  registry.setEnabled(id,false);await manager.sync();assert.equal(manager.workers.size,0);
});

test('a reviewed web-chat revision reloads only its worker and preserves pairing',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-web-reload-'));
  let manager;
  t.after(async()=>{await manager?.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const pluginRoot=path.join(root,'bundled',id),connectionFile=path.join(root,'pairing.json');
  fs.cpSync(path.join(bundledRoot,id),pluginRoot,{recursive:true});
  fs.writeFileSync(connectionFile,JSON.stringify({url:'https://127.0.0.1:1',token:'isolated-reload-token-00000000000000'}));
  const pairing=fs.readFileSync(connectionFile);
  fs.writeFileSync(path.join(pluginRoot,'isolated-entry.cjs'),
    "exports.activate=forge=>{const connector=require('./backend.cjs').createConnector(forge,{connectionFile:"+JSON.stringify(connectionFile)+"});"+
    "forge.handle('status',()=>connector.status());forge.onDispose(()=>connector.stop());void connector.start();};");
  const manifestFile=path.join(pluginRoot,'plugin.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  manifest.backend.entry='isolated-entry.cjs';fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const manifestBytes=fs.readFileSync(manifestFile),peer='test.web-peer',peerRoot=path.join(root,'bundled',peer);
  fs.mkdirSync(peerRoot);
  fs.writeFileSync(path.join(peerRoot,'plugin.json'),JSON.stringify({
    schemaVersion:1,apiVersion:6,id:peer,name:'Unrelated backend',version:'1.0.0',
    compatibility:manifest.compatibility,
    permissions:['backend.node'],capabilities:[{name:'backend',version:1}],
    backend:{entry:'backend.cjs',methods:['peerStatus'],scope:'global'},
  }));
  fs.writeFileSync(path.join(peerRoot,'backend.cjs'),"exports.activate=forge=>forge.handle('peerStatus',()=>({active:true}));");
  const registry=new ForgeRegistry({root:path.join(root,'data'),bundledRoot:path.join(root,'bundled'),versions});
  assert.deepEqual(registry.errors,[]);
  const backendEvents=[];
  manager=new ForgeBackendManager({registry,nodePath:process.execPath,onEvent:event=>backendEvents.push(event),request:async(_id,method)=>{
    assert.equal(method,'remoteChat.bootstrap');return {connected:false};
  }});
  registry.recordReview(id);registry.setEnabled(id,true);await manager.sync();
  assert(manager.workers.has(peer),JSON.stringify(backendEvents));
  const oldPID=manager.workers.get(id).child.pid,peerPID=manager.workers.get(peer).child.pid;
  const previousFingerprint=registry.get(id).fingerprint;
  assert.equal((await manager.call(id,'status',{},{})).configured,true);
  // A content-only revision changes the fingerprint even with identical permissions.
  fs.appendFileSync(path.join(pluginRoot,'backend.cjs'),'\n// Isolated revision for reload verification.\n');
  registry.reload();await manager.sync();
  assert.equal(registry.status(id).requestedEnabled,true);
  assert.equal(registry.status(id).enabled,false);
  assert.equal(registry.reviewed(id),false);
  assert.equal(manager.workers.has(id),false);
  assert.equal(manager.workers.get(peer).child.pid,peerPID);
  assert.deepEqual(fs.readFileSync(manifestFile),manifestBytes);
  assert.deepEqual(fs.readFileSync(connectionFile),pairing);
  registry.recordReview(id);registry.setEnabled(id,true);await manager.sync();
  assert.notEqual(registry.get(id).fingerprint,previousFingerprint);
  assert.notEqual(manager.workers.get(id).child.pid,oldPID);
  assert.equal(manager.workers.get(peer).child.pid,peerPID);
  assert.equal(registry.reviewed(id),true);
  assert.equal((await manager.call(id,'status',{},{})).configured,true);
  assert.deepEqual(await manager.call(peer,'peerStatus',{},{}),{active:true});
  assert.deepEqual(fs.readFileSync(connectionFile),pairing);
});
