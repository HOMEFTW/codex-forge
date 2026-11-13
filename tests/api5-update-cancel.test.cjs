const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const updates=require('../runtime/forge-plugin-updates.cjs');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {ForgeError}=require('../runtime/forge-errors.cjs');
const base=()=>({schemaVersion:1,apiVersion:1,id:'review.update',name:'Fixture',version:'1.0.0',compatibility:{forge:['>=0.1.0']},permissions:[],update:{provider:'server',manifestUrl:'https://plugins.example/latest.json'}});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-update-')),source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(base()));
  const registry=new ForgeRegistry({root:path.join(root,'data'),bundledRoot:path.join(root,'empty'),versions:{apiVersion:5,forge:'0.7.0',codex:'26.1106.6628.0'}});registry.install(source);
  t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('forge-api5-update-'));fs.rmSync(root,{recursive:true,force:true});});
  const pack=(version='1.1.0')=>{const manifest={...base(),version},contents=Buffer.from(JSON.stringify({schemaVersion:1,files:[{path:'plugin.json',encoding:'base64',content:Buffer.from(JSON.stringify(manifest)).toString('base64')}]}));return {contents,plan:{id:manifest.id,source:manifest.update,release:{...manifest,url:'https://plugins.example/plugin.json',bytes:contents.length,sha256:sha(contents)}}};};
  return {root,registry,pack};
}
const abort=controller=>controller.abort(new ForgeError('CANCELLED','Fixture cancelled'));

test('plugin update check observes cancellation after a metadata reader completes',async t=>{
  const f=setup(t),controller=new AbortController();let finish;
  const pending=updates.checkPluginUpdate(f.registry,'review.update',()=>new Promise(resolve=>{finish=resolve;}),{signal:controller.signal});
  abort(controller);finish(f.pack().plan.release);
  await assert.rejects(pending,error=>error.code==='CANCELLED');assert.deepEqual(updates.pendingUpdates(f.registry),{});
});

test('default plugin update metadata transport receives the cancellation signal',async t=>{
  const f=setup(t),controller=new AbortController(),previous=global.fetch;let signal;
  global.fetch=async(_url,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  try{const pending=updates.checkPluginUpdate(f.registry,'review.update',undefined,{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));abort(controller);await assert.rejects(pending,error=>error.code==='CANCELLED');assert.equal(signal.aborted,true);}finally{global.fetch=previous;}
});

test('cancelled plugin downloads never enter the pending update queue',async t=>{
  const f=setup(t),pack=f.pack(),controller=new AbortController();let finish,transportSignal;
  const pending=updates.stagePluginUpdate(f.registry,pack.plan,(_url,options)=>{transportSignal=options.signal;return new Promise(resolve=>{finish=resolve;});},{signal:controller.signal});
  abort(controller);finish(new Response(pack.contents));await assert.rejects(pending,error=>error.code==='CANCELLED');
  assert.equal(transportSignal.aborted,true);assert.deepEqual(updates.pendingUpdates(f.registry),{});assert.equal(f.registry.get('review.update',false).manifest.version,'1.0.0');
});

test('plugin update authorization is rechecked after unpacking',async t=>{
  const f=setup(t),pack=f.pack();let unpacked=false;
  await assert.rejects(updates.stagePluginUpdate(f.registry,pack.plan,async()=>new Response(pack.contents),{revalidate(){const pending=path.join(f.registry.root,'pending');if(fs.existsSync(pending)&&fs.readdirSync(pending).some(name=>name.startsWith('review.update.')&&fs.existsSync(path.join(pending,name,'plugin.json')))){unpacked=true;throw new ForgeError('PERMISSION_DENIED','Permission revoked');}}}),error=>error.code==='PERMISSION_DENIED');
  assert.equal(unpacked,true);assert.deepEqual(updates.pendingUpdates(f.registry),{});assert.deepEqual(fs.readdirSync(path.join(f.registry.root,'pending')),[]);
});

test('revocation inside a staging replacement restores the previously queued package',async t=>{
  const f=setup(t),first=f.pack('1.1.0');await updates.stagePluginUpdate(f.registry,first.plan,async()=>new Response(first.contents));
  const old=updates.pendingUpdates(f.registry),second=f.pack('1.2.0');let duringCommit=false;
  await assert.rejects(updates.stagePluginUpdate(f.registry,second.plan,async()=>new Response(second.contents),{revalidate(){const pending=path.join(f.registry.root,'pending');if(fs.existsSync(pending)&&fs.readdirSync(pending).some(name=>name.startsWith('review.update.previous-'))){duringCommit=true;throw new ForgeError('PERMISSION_DENIED','Permission revoked');}}}),error=>error.code==='PERMISSION_DENIED');
  assert.equal(duringCommit,true);assert.deepEqual(updates.pendingUpdates(f.registry),old);assert.equal(JSON.parse(fs.readFileSync(path.join(f.registry.root,'pending/review.update/plugin.json'),'utf8')).version,'1.1.0');
  assert.deepEqual(fs.readdirSync(path.join(f.registry.root,'pending')),['review.update']);
});

test('plugin update downloads reject HTTPS downgrade and private-source redirects',async t=>{
  const f=setup(t),pack=f.pack();
  for(const url of ['http://plugins.example/plugin.json','https://other.example/plugin.json']){
    const response=new Response(pack.contents);Object.defineProperty(response,'url',{value:url});
    await assert.rejects(updates.stagePluginUpdate(f.registry,pack.plan,async()=>response),/重定向/);assert.deepEqual(updates.pendingUpdates(f.registry),{});
  }
});

test('update redirect validation happens before following a forbidden intermediate hop',async t=>{
  const f=setup(t),pack=f.pack(),seen=[];
  await assert.rejects(updates.stagePluginUpdate(f.registry,pack.plan,async url=>{seen.push(url);return new Response(null,{status:302,headers:{location:'http://plugins.example/insecure'}});}),/非 HTTPS/);
  assert.deepEqual(seen,['https://plugins.example/plugin.json']);assert.deepEqual(updates.pendingUpdates(f.registry),{});
});

test('GitHub update downloads follow only bounded official HTTPS CDN redirects',async t=>{
  const f=setup(t),update={provider:'github',repository:'test/plugins'};
  const current=f.registry.entries.get('review.update');current.manifest.update=update;
  const manifest={...base(),version:'1.1.0',update},contents=Buffer.from(JSON.stringify({schemaVersion:1,files:[{path:'plugin.json',encoding:'base64',content:Buffer.from(JSON.stringify(manifest)).toString('base64')}]}));
  const plan={id:manifest.id,source:update,release:{...manifest,url:'https://github.com/test/plugins/releases/download/v1/plugin.json',bytes:contents.length,sha256:sha(contents)}},seen=[];
  await updates.stagePluginUpdate(f.registry,plan,async url=>{seen.push(url);return seen.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset'}}):new Response(contents);});
  assert.deepEqual(seen,[plan.release.url,'https://release-assets.githubusercontent.com/asset']);assert.equal(updates.pendingUpdates(f.registry)['review.update'].version,'1.1.0');
});
