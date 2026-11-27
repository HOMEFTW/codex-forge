'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {RemoteChat} = require('../runtime/remote-chat.cjs');
const {ForgeRegistry} = require('../runtime/forge-registry.cjs');
const {ForgeAPI5} = require('../runtime/forge-api5.cjs');
const {validate} = require('../runtime/forge-manifest.cjs');
const {compatibility} = require('../runtime/forge-versions.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function native() {
  const notifications = new Set(), states = new Set(), principals = new Set(), calls = [], replies = [], dispatched = [];
  const add = set => fn => { set.add(fn); return () => set.delete(fn); };
  const connection = {
    state: 'connected', getConnectionState() { return this.state; },
    registerInternalNotificationHandler: add(notifications), registerInternalConnectionStateHandler: add(states), registerInternalAuthenticatedPrincipalChangeHandler: add(principals),
    async sendAppServerRequest(method, params, before) { before?.(); calls.push({method, params}); return method === 'config/read' ? {config: {model: 'gpt-6.2-astra', model_reasoning_effort: 'ultra', service_tier: 'priority', secret: 'MUST NOT LEAK'}} : {data: [], nextCursor: 'native-cursor', thread: {id: 'new-thread'}}; },
    dispatchServerRequest(request) { dispatched.push(request); },
    async handleClientResponse(message, threadId, guard) { await tick(); if (guard?.() !== false) replies.push({message, threadId}); },
  };
  return {connection, calls, replies, dispatched, notifications, notify: (method, params) => { for (const fn of notifications) fn({method, params}); }, state: value => {connection.state = value; for (const fn of states) fn(value);}, principal: () => {for (const fn of principals) fn({});}};
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api6-')), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const transport = native(), service = new RemoteChat({defaultCwd: () => cwd, ...options}); service.bind(transport.connection);
  const cleanup={before:async()=>{}}; t.after(async () => {await cleanup.before(); service.dispose(); fs.rmSync(root, {recursive: true, force: true});});
  return {...transport, service, root, cwd, cleanup};
}
function request(f, method, params) { return f.service.request({method, params}); }
test('API6 reuses one native connection for non-selected threads, paging and full turn model/speed/mode input', async t => {
  const f = fixture(t), attachment = path.join(f.cwd, 'image.png'); fs.writeFileSync(attachment, 'fixture');
  const params = {threadId:'background-thread',model:'gpt-6.2-sol',effort:'ultra',serviceTier:'priority',serviceTierForTurn:'ultrafast',input:[{type:'text',text:'inspect'},{type:'localImage',path:attachment}],collaborationMode:{mode:'plan',settings:{model:'gpt-6.2-sol',reasoning_effort:'ultra',developer_instructions:null}}};
  await request(f,'turn/start',params); assert.deepEqual(f.calls.at(-1),{method:'turn/start',params});
  const page = await request(f,'thread/turns/list',{threadId:'background-thread',cursor:'opaque/native',limit:2}); assert.equal(page.nextCursor,'native-cursor'); assert.equal(f.calls.at(-1).params.cursor,'opaque/native');
  await request(f,'thread/start',{model:'gpt-6.2-astra'}); assert.deepEqual(f.calls.at(-1).params,{model:'gpt-6.2-astra',cwd:f.cwd});
  assert.equal(f.notifications.size,1);
});
test('API6 denies unknown methods, safety overrides, invalid input paths and malformed pagination before dispatch', async t => {
  const f=fixture(t);
  for(const [method,params]of [['config/read',{}],['turn/start',{threadId:'A',input:[{type:'text',text:'x'}],approvalPolicy:'never'}],['thread/resume',{threadId:'A',path:'C:/other.jsonl'}],['turn/start',{threadId:'A',input:[{type:'localImage',path:'relative.png'}]}],['thread/list',{limit:101}],['turn/start',{threadId:'A',input:[{type:'image',url:'https://example.test/img'}]}]])await assert.rejects(request(f,method,params));
  assert.equal(f.calls.length,0);
});
test('API6 bootstrap projects only safe defaults and does not return full config',async t=>{
  const f=fixture(t),result=await f.service.bootstrap();assert.equal(result.apiVersion,6);assert.equal(result.defaults.model,'gpt-6.2-astra');assert.equal(result.defaults.cwd,f.cwd);assert(!JSON.stringify(result).includes('MUST NOT LEAK'));
  f.state('disconnected');assert.equal((await f.service.bootstrap()).connected,false);await assert.rejects(request(f,'model/list',{}),{code:'STALE_CONNECTION'});
});

test('API6 defers large tool output in history and reads selected native items without changing their content',async t=>{
  const f=fixture(t),params={threadId:'A',turnId:'T',limit:10,deferOutput:{commandExecution:true,mcpToolCall:true}};
  await request(f,'thread/items/list',params);assert.deepEqual(f.calls.at(-1),{method:'thread/items/list',params});
  const result={data:[{id:'call_1',type:'commandExecution',aggregatedOutput:'complete saved output'}]};
  f.connection.sendAppServerRequest=async(method,params,before)=>{before?.();f.calls.push({method,params});return result;};
  const read={threadId:'A',turnId:'T',itemIds:['call_1']};
  assert.deepEqual(await request(f,'thread/items/read',read),result);
  assert.deepEqual(f.calls.at(-1),{method:'thread/items/read',params:read});
  const count=f.calls.length;
  for(const itemIds of [[],[''],Array(101).fill('call_1')])await assert.rejects(request(f,'thread/items/read',{...read,itemIds}),/itemIds/);
  assert.equal(f.calls.length,count);
});
test('API6 global event subscription keeps identical consecutive deltas; overflow and reconnect require resync',async t=>{
  const f=fixture(t,{maxEvents:2});const epoch=f.service.epoch;
  f.notify('item/reasoning/textDelta',{threadId:'unselected',delta:'a'});f.notify('item/reasoning/textDelta',{threadId:'unselected',delta:'a'});
  const first=await f.service.events({after:0});assert.equal(first.events.length,2);assert.equal(first.events[0].params.delta,first.events[1].params.delta);
  f.notify('thread/tokenUsage/updated',{threadId:'unselected',tokenUsage:{total:20}});assert.equal((await f.service.events({after:0})).reset,true);
  const wait=f.service.events({after:3,waitMs:1000,connectionEpoch:epoch});f.state('disconnected');assert.equal((await wait).reset,true);
  assert.equal((await f.service.events({after:1000})).reset,true);
});
test('API6 long polling wakes, cancels and releases its listeners',async t=>{
  const f=fixture(t),controller=new AbortController();const waiting=f.service.events({after:0,waitMs:20000},{signal:controller.signal});controller.abort();await assert.rejects(waiting);assert.equal(f.service.waiters.size,0);
  const result=f.service.events({after:0,waitMs:20000});f.notify('turn/started',{threadId:'A',turn:{id:'T'}});assert.equal((await result).events.length,1);assert.equal(f.service.waiters.size,0);
});
test('API6 captures real human requests, replies once, checks thread identity and validates answers',async t=>{
  const f=fixture(t);f.connection.dispatchServerRequest({id:23,method:'item/tool/requestUserInput',params:{threadId:'A',turnId:'T',questions:[{id:'q',question:'Which?'}]}});await tick();
  const pending=f.service.dispatch('remoteChat.pending',{});const id=pending.requests[0].id;assert.notEqual(id,23);assert.equal((await f.service.events()).events[0].params.id,id);
  await assert.rejects(f.service.respond({requestId:id,threadId:'B',result:{answers:{q:{answers:['one']}}}}),{code:'STALE_REQUEST'});
  await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{answers:{unknown:{answers:['one']}}}}));
  assert.deepEqual(await f.service.respond({requestId:id,threadId:'A',result:{answers:{q:{answers:['one']}}}}),{accepted:true});
  await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{answers:{}}}),{code:'STALE_REQUEST'});assert.equal(f.replies.length,1);assert.equal(f.replies[0].message.id,23);
});
test('API6 desktop and remote approval races deliver once; native resolution and disconnect retire pending requests',async t=>{
  const f=fixture(t),incoming={id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'A',turnId:'T',availableDecisions:['accept','decline']}};
  f.connection.dispatchServerRequest(incoming);await tick();let id=f.service.dispatch('remoteChat.pending',{}).requests[0].id;
  const desktop=f.connection.handleClientResponse({id:'approval',result:{decision:'decline'}},'A');await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{decision:'accept'}}),{code:'STALE_REQUEST'});await desktop;assert.equal(f.replies.length,1);
  f.connection.dispatchServerRequest({...incoming,id:'another'});id=f.service.dispatch('remoteChat.pending',{}).requests[0].id;f.notify('serverRequest/resolved',{threadId:'A',requestId:'another'});await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{decision:'accept'}}));
  f.connection.dispatchServerRequest({...incoming,id:'third'});f.state('disconnected');assert.equal(f.service.pending.size,0);
});
test('API6 supports command/file approval and ordinary MCP forms while retaining special native verification',async t=>{
  const f=fixture(t);
  for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval']){f.connection.dispatchServerRequest({id:method,method,params:{threadId:'A',turnId:'T'}});const {id}=f.service.dispatch('remoteChat.pending',{}).requests[0];await f.service.respond({requestId:id,threadId:'A',result:{decision:'decline'}});}
  const params={threadId:'A',serverName:'fixture',mode:'form',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}};
  f.connection.dispatchServerRequest({id:1,method:'mcpServer/elicitation/request',params});let {id}=f.service.dispatch('remoteChat.pending',{}).requests[0];await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{action:'accept',content:{name:12}}}));await f.service.respond({requestId:id,threadId:'A',result:{action:'accept',content:{name:'ok'}}});
  f.connection.dispatchServerRequest({id:2,method:'mcpServer/elicitation/request',params:{...params,serverName:'codex_apps'}});id=f.service.dispatch('remoteChat.pending',{}).requests[0].id;await assert.rejects(f.service.respond({requestId:id,threadId:'A',result:{action:'accept',content:{name:'ok'}}}),{code:'PERMISSION_DENIED'});
  f.connection.dispatchServerRequest({id:3,method:'mcpServer/elicitation/request',params:{...params,mode:'openai/userVerification'}});assert.equal(f.service.pending.size,1);
});
test('API6 connection replacement rejects late reads, disposes native observers and retains desktop functions',async t=>{
  const f=fixture(t),second=native();let done;f.connection.sendAppServerRequest=()=>new Promise(resolve=>{done=resolve;});const operation=request(f,'thread/read',{threadId:'A'});await tick();f.service.bind(second.connection);done({thread:{id:'A'}});await assert.rejects(operation,{code:'STALE_CONNECTION'});assert.equal(f.notifications.size,0);assert.equal(second.notifications.size,1);
  f.service.bind(second.connection);assert.equal(second.notifications.size,1);
});
test('API6 a disabled remote feature leaves native approvals alone and revocation blocks queued dispatch',async t=>{
  const f=fixture(t,{enabled:()=>false});
  f.connection.dispatchServerRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'A'}});
  assert.equal(f.service.pending.size,0);await f.connection.handleClientResponse({id:1,result:{decision:'decline'}},'A');assert.equal(f.replies.length,1);
  let ready,authorized=true;f.connection.sendAppServerRequest=async(method,params,before)=>{await new Promise(resolve=>{ready=resolve;});before();f.calls.push({method,params});return {};};
  const operation=f.service.request({method:'thread/start',params:{}},{check:()=>{if(!authorized)throw Error('revoked');}});await tick();authorized=false;ready();await assert.rejects(operation,/revoked/);assert.equal(f.calls.length,0);
});
test('API6 pending response aborts before delivery while the native request remains answerable',async t=>{
  const f=fixture(t),controller=new AbortController();
  f.connection.dispatchServerRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'A'}});const {id}=f.service.dispatch('remoteChat.pending',{}).requests[0];
  const response=f.service.respond({requestId:id,threadId:'A',result:{decision:'accept'}},{signal:controller.signal});controller.abort();await assert.rejects(response);await tick();assert.equal(f.replies.length,0);assert.equal(f.service.pending.size,1);
});
function hostFixture(t,{apiVersion=6,permissions=['backend.node','remote.control'],builtin=false}={}){
  const f=fixture(t),id=builtin?'forge.remote-fixture':'test.remote',directory=path.join(f.root,builtin?'bundled':'plugins',id);fs.mkdirSync(directory,{recursive:true});
  const manifest={schemaVersion:1,apiVersion,id,name:'Remote fixture',version:'1.0.0',compatibility:{forge:['>=0.7.0 <0.9.0']},permissions,backend:{entry:'backend.cjs',scope:'global',methods:['request']}};
  fs.writeFileSync(path.join(directory,'plugin.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'backend.cjs'),"exports.activate=forge=>forge.handle('request',args=>forge.request(args.method,args.args));");
  const registry=new ForgeRegistry({root:f.root,bundledRoot:path.join(f.root,'bundled'),versions:{forge:'0.8.0',apiVersion:6,codex:'26.1120.5083.0'}});
  const api=new ForgeAPI5({registry,services:{remoteChat:f.service},nodePath:process.execPath});f.cleanup.before=()=>api.dispose();return {...f,id,api,registry,directory,manifest};
}
test('API6 manifest enforces global trusted backend and API5 host rejects API6',t=>{
  const f=hostFixture(t);assert.equal(compatibility(f.manifest,{forge:'0.7.6',apiVersion:5,codex:'26.1120.5083.0'}).compatible,false);
  assert.throws(()=>validate({...f.manifest,apiVersion:5},f.directory),/API 6/);assert.throws(()=>validate({...f.manifest,backend:{...f.manifest.backend,scope:'session'}},f.directory),/global/);
  for(const apiVersion of [1,2,3,4,5])assert.equal(compatibility({...f.manifest,apiVersion},{forge:'0.8.0',apiVersion:6,codex:'26.1120.5083.0'}).compatible,true);
});
test('API6 actual worker path supports global remote calls, refuses renderer and aborts on disable',async t=>{
  const f=hostFixture(t,{builtin:true});assert.equal(f.registry.status(f.id).enabled,false);assert.equal(f.registry.reviewed(f.id),false);
  f.registry.setEnabled(f.id,true);f.registry.recordReview(f.id);await f.api.sync();
  await assert.rejects(f.api.dispatch(f.id,'remoteChat.bootstrap',{}),{code:'PERMISSION_DENIED'});
  const call=(method,args={})=>f.api.backends.call(f.id,'request',{method,args},{threadId:null,cwd:null});
  assert.equal((await call('remoteChat.bootstrap')).apiVersion,6);
  await call('remoteChat.request',{method:'turn/steer',params:{threadId:'not-current',expectedTurnId:'T',input:[{type:'text',text:'continue'}]}});assert.equal(f.calls.at(-1).params.threadId,'not-current');
  const waiting=assert.rejects(call('remoteChat.events',{after:f.service.sequence,waitMs:20000}));await tick();f.registry.setEnabled(f.id,false);await f.api.sync();await waiting;assert.equal(f.service.waiters.size,0);
});
test('API5 conversation-only plugins cannot acquire remote control through the backend',async t=>{
  const f=hostFixture(t,{apiVersion:5,permissions:['backend.node','conversation.history']});f.registry.setEnabled(f.id,true);f.registry.recordReview(f.id);await f.api.sync();await assert.rejects(f.api.backends.call(f.id,'request',{method:'remoteChat.bootstrap',args:{}},{threadId:null}),/权限|能力/);assert.equal(f.calls.length,0);
});
