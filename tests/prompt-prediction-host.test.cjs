const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {EventEmitter}=require('node:events');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-predict-host-')),app=new EventEmitter(),handlers=new Map(),sent=[],forwarded=[],samples=[],sourceRequests=[];
 const win=new EventEmitter();win.id=1;win.isDestroyed=()=>false;
 const contents={id:1,getURL:()=> 'app://-/index.html',mainFrame:{processId:20,routingId:1},send:(...args)=>sent.push(args)};win.webContents=contents;
 const fake={app,BrowserWindow:{fromWebContents:()=>win,getAllWindows:()=>[win],getFocusedWindow:()=>win},ipcMain:{on:(k,v)=>handlers.set(k,v),handle:(k,v)=>handlers.set(k,v)},Menu:{setApplicationMenu(){},getApplicationMenu(){}},MenuItem:class{},dialog:{},shell:{}};
 const beforeLoad=Module._load,beforeHome=process.env.CODEX_FORGE_HOME,beforeCanvas=process.env.CODEX_FAST_CANVAS_DIR;
 process.env.CODEX_FORGE_HOME=path.join(root,'forge');process.env.CODEX_FAST_CANVAS_DIR=root;
 Module._load=function(name,...args){return name==='electron'?fake:beforeLoad.call(this,name,...args)};
 const service=require('../runtime/main.cjs').install();Module._load=beforeLoad;
 service.predictions.sample=options=>new Promise((resolve,reject)=>{samples.push({...options,resolve});options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 app.emit('web-contents-created',null,contents);
 const respond=(id,result)=>contents.send('codex_desktop:message-for-view',{type:'mcp-response',hostId:'local',message:{id,result}});
 let deferSource=false;
 const sourceResult=req=>({thread:{id:req.params.threadId},model:'gpt-6-astra',modelProvider:'fixture',reasoningEffort:'xhigh',initialTurnsPage:{data:[{id:service.predictions.latest.get(req.params.threadId)?.turnId,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'请检查。'}]},{type:'agentMessage',phase:'final_answer',text:'已完成检查。'}]}]}});
 fake.ipcMain.handle('codex_desktop:message-from-view',async(event,message)=>{
  forwarded.push(message);const req=message.request;
  if(req?.method==='thread/read')respond(req.id,{thread:{id:req.params.threadId,cwd:root}});
  if(req?.method==='thread/resume'){sourceRequests.push(req);if(!deferSource)respond(req.id,sourceResult(req));}
 });
 const event={sender:contents,senderFrame:contents.mainFrame};
 const submit=message=>handlers.get('codex_desktop:message-from-view')(event,message);
 const navigate=threadId=>submit({type:'remote-hosted-pip-active-thread-changed',conversationId:threadId});
 const observe=(method,id,status='completed',hostId='local',threadId='A')=>contents.send('codex_desktop:message-for-view',{type:'mcp-notification',hostId,method,params:{threadId,turn:{id,status}}});
 const status=()=>service.predictions.snapshot(service.states.get(1));
 const request=(action,extra={})=>handlers.get('forge:prediction')(event,{...status(),action,expectedText:'',...extra});
 t.after(()=>{app.emit('will-quit');if(beforeHome===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=beforeHome;if(beforeCanvas===undefined)delete process.env.CODEX_FAST_CANVAS_DIR;else process.env.CODEX_FAST_CANVAS_DIR=beforeCanvas;fs.rmSync(root,{recursive:true,force:true});});
 return {app,service,event,handlers,contents,forwarded,sent,samples,sourceRequests,sourceResult,respond,navigate,observe,status,request,deferSource:()=>deferSource=true,resolveSource:req=>respond(req.id,sourceResult(req)),async initialize(){service.nativePredictionPolicy.attach({settings:{getEffective:()=>true,onDidChange:()=>()=>{}},connections:{subscribe:()=>()=>{},getMaybeConnection:()=>({getAccount:async()=>({requiresOpenaiAuth:true,account:{type:'apiKey'}}),registerInternalNotificationHandler:()=>()=>{},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{}})},hostId:'local'});await tick();await navigate('A');await submit({type:'mcp-request',hostId:'local',request:{id:'load-A',method:'thread/read',params:{threadId:'A'}}});}};
}

test('managed native chats predict without a legacy renderer RPC bridge',async t=>{
 const h=harness(t);await h.initialize();
 const state=h.service.states.get(1);delete state.bridge;
 const nativeNotifications=new Set(),reads=[];
 const connection={getAccount:async()=>({requiresOpenaiAuth:true,account:{type:'apiKey'}}),
  registerInternalNotificationHandler:fn=>{nativeNotifications.add(fn);return()=>nativeNotifications.delete(fn);},
  registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{},
  sendAppServerRequest:async(method,params,beforeSend,options)=>{beforeSend();reads.push({method,params,options});return h.sourceResult({params});}};
 h.service.nativePredictionPolicy.attach({settings:{getEffective:()=>true,onDidChange:()=>()=>{}},connections:{subscribe:()=>()=>{},getMaybeConnection:()=>connection},hostId:'local'});await tick();
 const notify=(method,id,status)=>{for(const fn of nativeNotifications)fn({method,params:{threadId:'A',turn:{id,status}}});};
 notify('turn/started','managed','inProgress');notify('turn/completed','managed','completed');
 assert.equal(h.status().phase,'offer');
 const pending=h.request('ready');await tick();
 assert.equal(reads.length,1);assert.equal(reads[0].method,'thread/resume');assert.equal(h.sourceRequests.length,0);
 assert.equal(h.samples.length,1);assert.equal(h.samples[0].model,'gpt-6-astra');
 h.samples[0].resolve('{"suggestion":"继续检查"}');await pending;
 assert.equal(h.status().phase,'suggestion');
 notify('turn/completed','managed','completed');assert.equal(h.status().phase,'suggestion');assert.equal(h.samples.length,1);
 notify('turn/started','next','inProgress');
 assert.equal(h.status().phase,'idle');assert.equal(h.status().diagnostics.lastAttempt.phase,'suggestion');
 assert.equal(h.status().diagnostics.lastAttempt.sourceTurnId,'managed');
 // A late private context read after navigation must never start inference or
 // forward the source response into the renderer.
 let finishRead;connection.sendAppServerRequest=(method,params,beforeSend)=>{beforeSend();return new Promise(resolve=>{finishRead=()=>resolve(h.sourceResult({params}));});};
 notify('turn/completed','next','completed');const cancelled=h.request('ready');await tick();
 await h.navigate('B');await cancelled;finishRead();await tick();
 assert.equal(h.samples.length,1);assert.equal(h.sourceRequests.length,0);
 assert.equal(h.status().diagnostics.lastAttempt.phase,'cancelled');
});

test('trusted completed turns infer once on the current model; Tab authorizes only a draft',async t=>{
 const h=harness(t);await h.initialize();
 h.observe('turn/completed','remote','completed','remote');assert.equal(h.status().phase,'idle');h.observe('turn/completed','other','completed','local','B');assert.equal(h.status().phase,'idle');
 h.observe('turn/started','one','inProgress');h.observe('turn/completed','one');assert.equal(h.status().phase,'offer');
 assert.throws(()=>h.handlers.get('forge:prediction')({...h.event,senderFrame:{processId:20,routingId:2}},{action:'ready',...h.status()}),/Untrusted/);
 const pending=h.request('ready');await tick();const sample=h.samples[0];assert.equal(sample.model,'gpt-6-astra');assert.equal(sample.modelProvider,'fixture');assert.equal(sample.sourceThreadId,'A');
 const source=h.sourceRequests[0];assert.deepEqual(source.params,{threadId:'A',excludeTurns:true,initialTurnsPage:{limit:3,itemsView:'summary',sortDirection:'desc'}});
 h.observe('turn/completed','one');assert.equal(h.status().phase,'pending');sample.resolve('{"suggestion":"继续检查"}');await pending;
 assert.equal(h.status().text,'继续检查');const accepted=await h.request('accept');assert.equal(accepted.text,'继续检查');assert.equal(accepted.expectedText,'');await assert.rejects(h.request('accept'),/失效/);
 assert.equal(h.samples.length,1);assert.equal(h.forwarded.filter(m=>m.request?.method==='turn/start'||m.request?.method==='thread/start').length,0);
});

test('navigation and new turns abort the independent worker and discard late results',async t=>{
 const h=harness(t);await h.initialize();h.observe('turn/completed','one');const pending=h.request('ready');await tick();const sample=h.samples[0];
 await h.navigate('B');await pending;assert.equal(sample.signal.aborted,true);sample.resolve('{"suggestion":"late"}');await tick();assert.equal(h.status().threadId,'B');assert.equal(h.status().text,null);
 await h.navigate('A');h.observe('turn/started','two','inProgress');h.observe('turn/completed','two');const again=h.request('ready');await tick();h.observe('turn/started','three','inProgress');await again;
 assert.equal(h.samples.filter(s=>s.signal.aborted).length,2);h.observe('turn/completed','two');assert.equal(h.status().phase,'idle');
});

test('source replies from another window cannot trigger inference, and disabling kills the worker',async t=>{
 const h=harness(t);await h.initialize();h.deferSource();h.observe('turn/completed','one');const pending=h.request('ready');await tick();const source=h.sourceRequests[0];
 const other={id:2,send(){}};h.app.emit('web-contents-created',null,other);other.send('codex_desktop:message-for-view',{type:'mcp-response',hostId:'local',message:{id:source.id,result:h.sourceResult(source)}});await tick();assert.equal(h.samples.length,0);
 h.resolveSource(source);await tick();assert.equal(h.samples.length,1);
 await h.service.forge.management(h.event,'enable',{id:'forge.prompt-prediction',enabled:false});await pending;assert.equal(h.status().phase,'idle');assert.equal(h.samples[0].signal.aborted,true);
 h.observe('turn/completed','two');await h.service.forge.management(h.event,'enable',{id:'forge.prompt-prediction',enabled:true});assert.equal(h.status().phase,'idle');
});

test('late private context replies after cancellation never leak into the renderer or start a worker',async t=>{
 const h=harness(t);await h.initialize();h.deferSource();h.observe('turn/completed','one');const pending=h.request('ready');await tick();const source=h.sourceRequests[0];
 await h.navigate('B');await pending;h.resolveSource(source);await tick();assert.equal(h.samples.length,0);assert(!h.sent.some(([,m])=>m?.type==='mcp-response'&&m.message?.id===source.id));
});

test('prediction capability stays builtin-only and invalid settings fail before saving',async t=>{
 const h=harness(t);await h.initialize();const registry=h.service.forge.registry,manifest=registry.get('forge.prompt-prediction').manifest,{validate}=require('../runtime/forge-manifest.cjs');
 assert.throws(()=>validate({...manifest,id:'test.predict'},'.'),/仅限内置/);assert.throws(()=>validate({...manifest,id:'forge.other'},'.',{builtin:true}),/仅限内置/);assert.throws(()=>validate({...manifest,apiVersion:3},'.',{builtin:true}),/仅限内置/);
 const settings=registry.settings(manifest.id);assert.throws(()=>registry.settings(manifest.id,{...settings,maxChars:320.5}),/整数/);assert.throws(()=>registry.settings(manifest.id,{...settings,timeoutSeconds:1.5}),/整数/);assert.throws(()=>registry.settings(manifest.id,{...settings,prompt:'   '}),/不能为空/);assert.deepEqual(registry.settings(manifest.id),settings);
});

test('unchanged plugin settings preserve the worker; changed settings cancel without retry',async t=>{
 const h=harness(t);await h.initialize();const settings=h.service.forge.registry.settings('forge.prompt-prediction');await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:settings});
 h.observe('turn/completed','one');const pending=h.request('ready');await tick();const sample=h.samples[0];
 await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:{...settings}});assert.equal(h.status().phase,'pending');assert.equal(sample.signal.aborted,false);const generation=h.status().generation;
 await h.service.forge.management(h.event,'saveSettings',{id:'forge.prompt-prediction',value:{...settings,maxChars:settings.maxChars+1}});await pending;assert.equal(sample.signal.aborted,true);assert(h.status().generation>generation);h.observe('turn/completed','one');assert.equal(h.status().phase,'idle');assert.equal(h.samples.length,1);
});

test('returning restores only valid suggestions and dismissing prevents restoration',async t=>{
 const h=harness(t);await h.initialize();h.observe('turn/completed','one');const pending=h.request('ready');await tick();h.samples[0].resolve('{"suggestion":"恢复建议"}');await pending;
 await h.navigate('B');assert.equal(h.status().text,null);await h.navigate('A');assert.equal(h.status().text,'恢复建议');await h.request('dismiss');await h.navigate('B');await h.navigate('A');assert.equal(h.status().phase,'idle');assert.equal(h.samples.length,1);
});
