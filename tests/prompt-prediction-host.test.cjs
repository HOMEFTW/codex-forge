const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {EventEmitter}=require('node:events');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-predict-host-')),app=new EventEmitter(),handlers=new Map(),sent=[],forwarded=[];
 const win=new EventEmitter();win.id=1;win.isDestroyed=()=>false;
 const contents={id:1,getURL:()=> 'app://-/index.html',mainFrame:{processId:20,routingId:1},send:(...args)=>sent.push(args)};win.webContents=contents;
 const fake={app,BrowserWindow:{fromWebContents:()=>win,getAllWindows:()=>[win],getFocusedWindow:()=>win},ipcMain:{on:(k,v)=>handlers.set(k,v),handle:(k,v)=>handlers.set(k,v)},Menu:{setApplicationMenu(){},getApplicationMenu(){}},MenuItem:class{},dialog:{},shell:{}};
 const beforeLoad=Module._load,beforeHome=process.env.CODEX_FORGE_HOME,beforeCanvas=process.env.CODEX_FAST_CANVAS_DIR;
 process.env.CODEX_FORGE_HOME=path.join(root,'forge');process.env.CODEX_FAST_CANVAS_DIR=root;
 Module._load=function(name,...args){return name==='electron'?fake:beforeLoad.call(this,name,...args)};
 const service=require('../runtime/main.cjs').install();Module._load=beforeLoad;
 app.emit('web-contents-created',null,contents);
 const respond=(id,result)=>contents.send('codex_desktop:message-for-view',{type:'mcp-response',hostId:'local',message:{id,result}});
 fake.ipcMain.handle('codex_desktop:message-from-view',async(event,message)=>{
  forwarded.push(message);const req=message.request;
  if(req?.method==='thread/read')respond(req.id,{thread:{id:req.params.threadId,cwd:root}});
  if(req?.method==='thread/sample/cancel')respond(req.id,{});
 });
 const event={sender:contents,senderFrame:contents.mainFrame};
 const submit=message=>handlers.get('codex_desktop:message-from-view')(event,message);
 const navigate=threadId=>submit({type:'remote-hosted-pip-active-thread-changed',conversationId:threadId});
 const observe=(method,id,status='completed',hostId='local',threadId='A')=>contents.send('codex_desktop:message-for-view',{type:'mcp-notification',hostId,method,params:{threadId,turn:{id,status}}});
 const status=()=>service.predictions.snapshot(service.states.get(1));
 const request=(action,extra={})=>handlers.get('forge:prediction')(event,{...status(),action,expectedText:'',...extra});
 t.after(()=>{app.emit('will-quit');if(beforeHome===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=beforeHome;if(beforeCanvas===undefined)delete process.env.CODEX_FAST_CANVAS_DIR;else process.env.CODEX_FAST_CANVAS_DIR=beforeCanvas;fs.rmSync(root,{recursive:true,force:true});});
 return {app,service,event,handlers,contents,forwarded,sent,respond,navigate,observe,status,request,async initialize(){service.nativePredictionPolicy.attach({settings:{getEffective:()=>true,onDidChange:()=>()=>{}},connections:{subscribe:()=>()=>{},getMaybeConnection:()=>({getAccount:async()=>({requiresOpenaiAuth:true,account:{type:'apiKey'}}),registerInternalNotificationHandler:()=>()=>{},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{}})},hostId:'local'});await tick();await navigate('A');await submit({type:'mcp-request',hostId:'local',request:{id:'load-A',method:'thread/read',params:{threadId:'A'}}});}};
}
test('trusted completed turns sample once; accepting authorizes only a draft and never sends a turn',async t=>{
 const h=harness(t);await h.initialize();
 h.observe('turn/completed','remote','completed','remote');assert.equal(h.status().phase,'idle');
 h.observe('turn/completed','other','completed','local','B');assert.equal(h.status().phase,'idle');
 h.observe('turn/started','one','inProgress');h.observe('turn/completed','one');assert.equal(h.status().phase,'offer');
 assert.throws(()=>h.handlers.get('forge:prediction')({...h.event,senderFrame:{processId:20,routingId:2}},{action:'ready',...h.status()}),/Untrusted/);
 const pending=h.request('ready');await tick();const sample=h.forwarded.find(m=>m.request?.method==='thread/sample').request;
 assert.equal(sample.params.threadId,'A');assert.equal(sample.params.expectedTurnId,'one');assert.equal(sample.params.disableMcp,true);assert.equal(sample.params.threadSource,'forge_prompt_prediction');assert(!('model' in sample.params));
 h.observe('turn/completed','one');assert.equal(h.status().phase,'pending');
 h.respond(sample.id,{sourceTurnId:'one',text:'{"suggestion":"继续检查"}'});await pending;
 assert.equal(h.status().text,'继续检查');
 const accepted=await h.request('accept');assert.equal(accepted.text,'继续检查');assert.equal(accepted.expectedText,'');
 await assert.rejects(h.request('accept'),/失效/);
 assert.equal(h.forwarded.filter(m=>m.request?.method==='thread/sample').length,1);
 assert.equal(h.forwarded.filter(m=>m.request?.method==='turn/start').length,0);
});
test('navigation and new turns cancel by original request ID; late replies cannot reach UI or another thread',async t=>{
 const h=harness(t);await h.initialize();h.observe('turn/completed','one');const pending=h.request('ready');await tick();
 const sample=h.forwarded.find(m=>m.request?.method==='thread/sample').request;
 await h.navigate('B');await tick();await pending;
 assert.equal(h.forwarded.find(m=>m.request?.method==='thread/sample/cancel').request.params.requestId,sample.id);
 h.respond(sample.id,{sourceTurnId:'one',text:'{"suggestion":"late"}'});
 assert(!h.sent.some(([,m])=>m?.type==='mcp-response'&&m.message?.id===sample.id));assert.equal(h.status().threadId,'B');assert.equal(h.status().text,null);
 await h.navigate('A');h.observe('turn/started','two','inProgress');h.observe('turn/completed','two');const again=h.request('ready');await tick();
 h.observe('turn/started','three','inProgress');await again;await tick();
 assert.equal(h.forwarded.filter(m=>m.request?.method==='thread/sample/cancel').length,2);assert.equal(h.status().text,null);
 h.observe('turn/completed','two');assert.equal(h.status().phase,'idle');
});
test('disable and changed settings invalidate pending samples, and another window cannot fulfill a request',async t=>{
 const h=harness(t);await h.initialize();h.observe('turn/completed','one');const pending=h.request('ready');await tick();
 const sample=h.forwarded.find(m=>m.request?.method==='thread/sample').request;
 const other={id:2,send(){}};h.app.emit('web-contents-created',null,other);
 other.send('codex_desktop:message-for-view',{type:'mcp-response',hostId:'local',message:{id:sample.id,result:{sourceTurnId:'one',text:'{"suggestion":"wrong window"}'}}});await tick();assert.equal(h.status().phase,'pending');
 await h.service.forge.management(h.event,'enable',{id:'forge.prompt-prediction',enabled:false});await pending;await tick();assert.equal(h.status().phase,'idle');
 assert(h.forwarded.some(m=>m.request?.method==='thread/sample/cancel'));
 h.observe('turn/started','two','inProgress');h.observe('turn/completed','two');assert.equal(h.status().phase,'idle');
 await h.service.forge.management(h.event,'enable',{id:'forge.prompt-prediction',enabled:true});assert.equal(h.status().phase,'idle');
});

test('prediction capability is builtin-only and fractional settings fail before saving',async t=>{
 const h=harness(t);await h.initialize();const registry=h.service.forge.registry;
 const manifest=registry.get('forge.prompt-prediction').manifest;
 const {validate}=require('../runtime/forge-manifest.cjs');
 assert.throws(()=>validate({...manifest,id:'test.predict'},'.'),/仅限内置/);
 assert.throws(()=>validate({...manifest,id:'forge.other'},'.',{builtin:true}),/仅限内置/);
 assert.throws(()=>validate({...manifest,apiVersion:3},'.',{builtin:true}),/仅限内置/);
 const settings=registry.settings(manifest.id);
 assert.throws(()=>registry.settings(manifest.id,{...settings,maxChars:320.5}),/整数/);
 assert.throws(()=>registry.settings(manifest.id,{...settings,timeoutSeconds:1.5}),/整数/);
 assert.throws(()=>registry.settings(manifest.id,{...settings,prompt:'   '}),/不能为空/);
 assert.deepEqual(registry.settings(manifest.id),settings);
});

test('saving unchanged prediction settings preserves an active sample; changing them cancels without resampling',async t=>{
 const h=harness(t);await h.initialize();
 const settings=h.service.forge.registry.settings('forge.prompt-prediction');
 // Establish the settings baseline, just as the settings page's first refresh does.
 await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:settings});
 h.observe('turn/completed','one');const pending=h.request('ready');await tick();
 const sample=h.forwarded.find(m=>m.request?.method==='thread/sample').request;
 await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:{...settings}});
 assert.equal(h.status().phase,'pending');
 assert.equal(h.forwarded.filter(m=>m.request?.method==='thread/sample/cancel').length,0);
 const generation=h.status().generation;
 await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:{...settings,maxChars:settings.maxChars+1}});
 await pending;await tick();assert.equal(h.status().phase,'idle');assert(h.status().generation>generation);
 assert.equal(h.forwarded.find(m=>m.request?.method==='thread/sample/cancel').request.params.requestId,sample.id);
 h.observe('turn/completed','one');assert.equal(h.status().phase,'idle');
 assert.equal(h.forwarded.filter(m=>m.request?.method==='thread/sample').length,1);
});

test('returning to a thread restores only its valid cache and dismissing prevents restoration',async t=>{
 const h=harness(t);await h.initialize();h.observe('turn/completed','one');const pending=h.request('ready');await tick();
 const sample=h.forwarded.find(m=>m.request?.method==='thread/sample').request;
 h.respond(sample.id,{sourceTurnId:'one',text:'{"suggestion":"恢复建议"}'});await pending;
 await h.navigate('B');assert.equal(h.status().text,null);
 await h.navigate('A');assert.equal(h.status().text,'恢复建议');assert.equal(h.status().phase,'suggestion');
 await h.request('dismiss');await h.navigate('B');await h.navigate('A');assert.equal(h.status().phase,'idle');
 assert.equal(h.forwarded.filter(m=>m.request?.method==='thread/sample').length,1);
});
