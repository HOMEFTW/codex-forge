const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {ForgeAPI5}=require('../runtime/forge-api5.cjs');
const {ForgeIO}=require('../runtime/forge-api5-io.cjs');
const {CanvasStore}=require('../runtime/store.cjs');
const {TodoStore}=require('../runtime/todos.cjs');
function fixture(t,permissions,services={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-host-')),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);const id='test.extension',directory=path.join(root,'plugins',id);fs.mkdirSync(directory,{recursive:true});
 const manifest={schemaVersion:1,apiVersion:5,id,name:'Fixture',version:'1.0.0',compatibility:{forge:['>=0.7.0 <0.8.0']},permissions,contributes:{settings:{properties:{name:{type:'string',title:'Name',default:'first'}}}}};
 if(!permissions.includes('settings'))delete manifest.contributes.settings;
 fs.writeFileSync(path.join(directory,'plugin.json'),JSON.stringify(manifest));const registry=new ForgeRegistry({root,bundledRoot:path.join(root,'empty'),versions:{forge:'0.7.0',apiVersion:5,codex:'26.1106.6628.0'}});registry.setEnabled(id,true);
 const state={win:{webContents:{id:10},isDestroyed:()=>false}},event={sender:{id:10}},context={threadId:'thread-a',cwd};
 const backends={workers:new Map(),sync:async()=>{},dispose:async()=>{},disposePlugin:async()=>{},tools:()=>[],providers:()=>[],hooks:()=>[],applyHooks:async(_name,value)=>value};
 const tasks={dispatch:()=>({started:true}),dispose:async()=>{}};
 const api=new ForgeAPI5({root,registry,services,states:new Map([[10,state]]),contextFor:()=>({...context}),backendManager:backends,taskRuntime:tasks});let sequence=0;
 const frameToken='fixture-frame-123456';api.registerFrame(event,{id,frameToken,fingerprint:registry.get(id).fingerprint});
 const call=(method,args={},extra={})=>api.handle(event,state,{id,frameToken,requestId:++sequence,method,args,threadId:context.threadId,generation:state.api5Generation||0,...extra});
 t.after(async()=>{await api.dispose();fs.rmSync(root,{recursive:true,force:true});});return {api,registry,root,cwd,context,state,event,id,frameToken,call,backends};
}
test('API5 public canvas/todo services perform real revisioned edits and reject read-only escalation',async t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-business-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const canvas=new CanvasStore(base),todos=new TodoStore(base),f=fixture(t,['canvas.read','canvas.write','todos.read','todos.write'],{canvas,todos});
 const created=await f.call('canvas.request',{method:'create',args:{title:'Owned'}});assert.equal(created.title,'Owned');assert.equal((await f.call('canvas.request',{method:'read',args:{canvasId:created.id}})).revision,0);
 const todo=await f.call('todos.request',{method:'read'});const changed=await f.call('todos.request',{method:'apply',args:{expectedRevision:todo.revision,operations:[{op:'add',title:'real task'}]}});assert.equal(changed.items[0].title,'real task');
 await assert.rejects(f.call('todos.request',{method:'apply',args:{expectedRevision:todo.revision,operations:[{op:'add',title:'stale'}]}}));
 await assert.rejects(f.call('todos.request',{method:'read',args:{threadId:'other-thread'}}),{code:'PERMISSION_DENIED'});
 const ro=fixture(t,['canvas.read'],{canvas});await assert.rejects(ro.call('canvas.request',{method:'create',args:{title:'denied'}}),{code:'PERMISSION_DENIED'});
});
test('API5 frame, thread and generation identities cannot be rebound by a stale caller',async t=>{
 const f=fixture(t,['shell.execute','files.read','jobs.manage']);let executed=0;f.api.io.shell=async()=>{executed++;return {};};
 f.context.threadId='thread-b';await assert.rejects(f.call('shell.execute',{executable:'node'},{threadId:'thread-a'}),{code:'STALE_CONTEXT'});assert.equal(executed,0);
 f.context.threadId='thread-a';f.api.invalidateWindow(f.state);await assert.rejects(f.call('shell.execute',{executable:'node'},{generation:0}),{code:'STALE_CONTEXT'});
 await assert.rejects(f.call('shell.execute',{executable:'node'},{frameToken:'unregistered-frame'}),{code:'PERMISSION_DENIED'});
 await f.call('shell.execute',{executable:'node'});assert.equal(executed,1);
 f.registry.setEnabled(f.id,false);await assert.rejects(f.call('shell.execute',{executable:'node'}),{code:'PLUGIN_DISABLED'});
});
test('API5 settings require the observed revision and keep legacy get storage intact',async t=>{
 const f=fixture(t,['settings','settings.write']);const read=await f.call('settings.snapshot');assert.deepEqual(read.value,{name:'first'});
 const written=await f.call('settings.set',{value:{name:'second'},expectedRevision:read.revision});assert.equal(written.value.name,'second');
 await assert.rejects(f.call('settings.set',{value:{name:'lost'},expectedRevision:read.revision}),{code:'REVISION_CONFLICT'});assert.equal(f.registry.settings(f.id).name,'second');
});
test('API5 theme registration exposes an ID that can actually be selected',async t=>{
 const f=fixture(t,['theme.read','theme.write','theme.register']);await f.call('theme.register',{id:'night',tokens:{'--forge-background':'#121212'}});const state=await f.call('theme.get');assert.equal(state.themes[0].id,f.id+':night');await f.call('theme.set',{id:'night'});assert.equal(f.api.uiSnapshot().theme.tokens['--forge-background'],'#121212');
 await assert.rejects(f.call('theme.register',{id:'bad',tokens:{'--forge-background':'url(https://external/)'}}),{code:'INVALID_ARGUMENT'});
});
test('API5 event streams expose content only with history permission and stop on window invalidation',async t=>{
 const f=fixture(t,['conversation.read','conversation.events']);const opened=await f.call('rpc.stream.open',{method:'conversation.events'});
 const pending=f.call('rpc.stream.next',{streamId:opened.streamId});f.api.observe(f.state,'item/agentMessage/delta',{threadId:'thread-a',turnId:'t',delta:'private content'});f.api.observe(f.state,'turn/completed',{threadId:'thread-a',turn:{id:'t',status:'completed'}});const event=await pending;assert.equal(event.value.method,'turn/completed');
 const next=f.call('rpc.stream.next',{streamId:opened.streamId});f.api.invalidateWindow(f.state);await assert.rejects(next);assert.equal(f.api.events.size,0);
});
test('API5 file IO enforces revisions, links and connected-directory identities',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const workspace=path.join(root,'workspace'),outside=path.join(root,'outside');fs.mkdirSync(workspace);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret'),'outside');
 const io=new ForgeIO({root}),context={cwd:workspace};const first=io.files('test.plugin','write',{path:'note.txt',content:'first',expectedRevision:''},context);assert.equal(io.files('test.plugin','read',{path:'note.txt'},context).content,'first');
 fs.writeFileSync(path.join(workspace,'note.txt'),'external edit');assert.throws(()=>io.files('test.plugin','write',{path:'note.txt',content:'lost',expectedRevision:first.revision},context),{code:'REVISION_CONFLICT'});
 assert.throws(()=>io.files('test.plugin','read',{path:'../outside/secret'},context));fs.symlinkSync(outside,path.join(workspace,'link'),'junction');assert.throws(()=>io.files('test.plugin','read',{path:'link/secret'},context),{code:'PERMISSION_DENIED'});
 const connection=io.connect('test.plugin',outside);assert.equal(io.files('test.plugin','read',{root:connection.id,path:'secret'},context).content,'outside');assert.throws(()=>io.files('other.plugin','read',{root:connection.id,path:'secret'},context),{code:'PERMISSION_DENIED'});
 fs.renameSync(outside,outside+'-old');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret'),'replacement');assert.throws(()=>io.files('test.plugin','read',{root:connection.id,path:'secret'},context),{code:'PERMISSION_DENIED'});
});
test('API5 credentials remain encrypted at rest and are injected only into declared origins',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-secrets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let seen;
 const io=new ForgeIO({root,encrypt:value=>Buffer.from(value.split('').reverse().join('')),decrypt:value=>value.toString().split('').reverse().join(''),fetchImpl:async(url,options)=>{seen={url,options};return new Response('ok');}});
 io.credential('test.plugin','set',{name:'service',value:'private-fixture-key'});assert(!fs.readFileSync(io.secretFile,'utf8').includes('private-fixture-key'));assert.deepEqual(io.credential('test.plugin','describe',{name:'service'}),{name:'service',configured:true});
 await io.fetch('test.plugin',{networkOrigins:['https://example.com']},{url:'https://example.com/query',credential:'service'});assert.equal(seen.options.headers.get('authorization'),'Bearer private-fixture-key');assert.equal(seen.options.redirect,'error');await assert.rejects(io.fetch('test.plugin',{networkOrigins:['https://example.com']},{url:'https://other.example/query',credential:'service'}),{code:'PERMISSION_DENIED'});
});
test('API5 shell uses the captured workspace and cancellation terminates its process',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-shell-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const io=new ForgeIO({root});const result=await io.shell({executable:process.execPath,args:['-e','process.stdout.write(process.cwd())']},{cwd:root});assert.equal(result.code,0);assert.equal(result.stdout,root);
 const controller=new AbortController(),pending=io.shell({executable:process.execPath,args:['-e','setInterval(()=>{},1000)']},{cwd:root},{signal:controller.signal});setTimeout(()=>controller.abort(),30);await assert.rejects(pending);
});

test('API5 discovers registered model providers and retains scoped backend logs',async t=>{
 const f=fixture(t,['llm.call','logs.read']);f.backends.providers=()=>[{name:'test.provider/local',models:[{id:'local'}]}];
 assert.equal((await f.call('llm.providers')).providers[0].name,'test.provider/local');
 f.api.backendEvent({type:'backend.log',pluginId:f.id,level:'info',message:'backend output'});
 assert.equal((await f.call('logs.read')).items[0].message,'backend output');
 await assert.rejects(f.call('logs.write',{message:'no write permission'}),{code:'PERMISSION_DENIED'});
});

test('API5 history uses the read-only paged native endpoint and passes the cursor',async t=>{
 const f=fixture(t,['conversation.history']);const calls=[];f.api.nativeCall=async(_state,method,args)=>{calls.push({method,args});return {data:[{id:'turn'}],nextCursor:'page-2'};};
 const result=await f.call('conversation.read',{cursor:'page-1',limit:5});assert.equal(result.turns[0].id,'turn');assert.equal(result.cursor,'page-2');
 assert.deepEqual(calls,[{method:'thread/turns/list',args:{threadId:'thread-a',limit:5,itemsView:'summary',sortDirection:'desc',cursor:'page-1'}}]);
});

test('native send hooks edit the actual request while retaining attachments and reject stale sends',async t=>{
 const f=fixture(t,[]);f.backends.hooks=()=>[{name:'conversation.beforeSend'},{name:'conversation.afterSend'}];const hooks=[];
 f.backends.applyHooks=async(name,value,context)=>{hooks.push({name,value,context});return name==='conversation.beforeSend'?{text:'rewritten'}:value;};
 const request={id:71,method:'turn/start',params:{threadId:'thread-a',input:[{type:'text',text:'first'},{type:'image',url:'local-image'},{type:'text',text:'second'}]}};
 await f.api.prepareNativeSend(f.state,request,f.context);assert.deepEqual(request.params.input,[{type:'text',text:'rewritten'},{type:'image',url:'local-image'}]);
 f.api.completeNativeSend(f.state,{id:71,result:{turn:{id:'accepted'}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(hooks[1].name,'conversation.afterSend');assert.equal(hooks[1].context.threadId,'thread-a');assert.equal(f.api.nativeHooks.size,0);
 let resolveHook;f.backends.applyHooks=()=>new Promise(resolve=>{resolveHook=resolve;});const pending=f.api.prepareNativeSend(f.state,{...request,id:72},f.context);f.api.invalidateWindow(f.state);resolveHook({text:'late'});await assert.rejects(pending);assert.equal(f.api.nativeHooks.size,0);
});


test('API5 global backends work on the home page and channels honor their own lifetime',async t=>{
 const f=fixture(t,['backend.node']);f.registry.get(f.id).manifest.backend={scope:'global'};f.context.threadId=null;f.backends.call=async()=>({home:true});
 assert.deepEqual(await f.call('backend.call',{method:'echo'}),{home:true});
 const stream=await f.call('rpc.stream.open',{method:'backend.channel',args:{method:'echo'},lifetimeMs:20},{options:{timeoutMs:2000}});
 const alive=setTimeout(()=>{},1000);try{await assert.rejects(f.call('rpc.stream.next',{streamId:stream.streamId}),{code:'TIMEOUT'});}finally{clearTimeout(alive);}
 assert.equal(f.api.rpc.streams.size,0);
});

test('native after-send hooks remain cancellable until settled and closed windows cannot reuse context',async t=>{
 const f=fixture(t,['shell.execute']);f.backends.hooks=()=>[{name:'conversation.afterSend'}];let afterSignal;
 f.backends.applyHooks=async(name,value,_context,options)=>{if(name==='conversation.beforeSend')return value;afterSignal=options.signal;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
 const request={id:99,method:'turn/start',params:{threadId:'thread-a',input:[{type:'text',text:'send'}]}};
 await f.api.prepareNativeSend(f.state,request,f.context);f.api.completeNativeSend(f.state,{id:99,result:{turn:{id:'t'}}});assert.equal(f.api.nativeHooks.size,1);
 f.api.invalidateWindow(f.state);assert.equal(afterSignal.aborted,true);assert.equal(f.api.nativeHooks.size,0);
 f.api.states.clear();const captured={...f.context,windowId:10,generation:0};assert.throws(()=>f.api.backendRequest(f.id,'shell.execute',{},captured,{}),{code:'STALE_CONTEXT'});
 f.api.io.shell=async(_args,context)=>({cwd:context.cwd});assert.equal((await f.api.backendRequest(f.id,'shell.execute',{}, {...captured,backgroundTask:true},{})).cwd,f.cwd);
});
