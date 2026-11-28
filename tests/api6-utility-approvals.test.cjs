'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {RemoteChat} = require('../runtime/remote-chat.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('API6 utility proxy exposes manager approvals without dispatchServerRequest', async t => {
  const service = new RemoteChat(); t.after(() => service.dispose());
  const callbacks = new Set();
  // The real main-process proxy has response RPC and notifications, but no
  // dispatchServerRequest: that method belongs to the utility process.
  service.bind({getConnectionState:()=> 'connected', registerInternalNotificationHandler:()=>()=>{}, registerInternalConnectionStateHandler:()=>()=>{}, registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{}, sendAppServerRequest:async()=>({config:{}}),handleClientResponse:async()=>{throw Error('raw response must not be used');}});
  let snapshot=[];
  const bridge = {snapshot:async()=>snapshot,subscribe:async listener=>{callbacks.add(listener);listener(snapshot);return {[Symbol.dispose](){callbacks.delete(listener);}};},respond:async()=>true};
  const instance = {resource:{control:{openForgeRemoteApprovals:async()=>bridge}}};
  service.attachManagers({subscribe:(_id,fn)=>{fn(instance);return()=>{};},getCurrent:()=>instance});
  await tick();
  const bootstrap = await service.bootstrap();
  assert(bootstrap.approvalMethods.includes('mcpServer/elicitation/request'));
  assert(bootstrap.approvalMethods.includes('item/permissions/requestApproval'));
  assert.equal(bootstrap.approvalStatus.state,'ready');
  const request={id:'opaque-utility-token',method:'mcpServer/elicitation/request',params:{threadId:'background',turnId:'turn',serverName:'node_repl',mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_name:'click',tool_params:{app:'fixture'}}},remoteApproval:{supported:true,reason:null}};
  snapshot=[request];
  for(const fn of callbacks)fn([request]);
  assert.equal((await service.dispatch('remoteChat.pending',{})).requests[0].params.threadId,'background');
  assert.equal((await service.events()).events.at(-1).method,'server/request');
  await assert.rejects(service.respond({requestId:request.id,threadId:'background',result:{action:'accept',content:{}}}),/逐次确认/);
  assert.deepEqual(await service.respond({requestId:request.id,threadId:'background',result:{action:'accept',content:{}},userConfirmed:true}),{accepted:true});
});

test('API6 manager replacement releases subscriptions and ignores late snapshots from the old account',async t=>{
  const service=new RemoteChat();t.after(()=>service.dispose());let listener,current,disposed=0,oldCallback;
  const bridge={snapshot:async()=>[],subscribe:async callback=>{oldCallback=callback;return {[Symbol.dispose](){disposed++;}};}};
  current={resource:{control:{openForgeRemoteApprovals:async()=>bridge}}};
  service.attachManagers({getCurrent:()=>current,subscribe:(_id,callback)=>{listener=callback;callback(current);return()=>{};}});await tick();
  current=null;listener(null);await tick();
  oldCallback([{id:'old',method:'item/fileChange/requestApproval',params:{threadId:'A'},remoteApproval:{supported:true,reason:null}}]);
  assert.equal(service.pending.size,0);assert.equal(disposed,1);assert.equal((await service.bootstrap()).approvalStatus.state,'unavailable');
});

test('API6 approval initialization signals resync after an unavailable bootstrap and restores existing requests',async t=>{
  const service=new RemoteChat();t.after(()=>service.dispose());let finish;
  service.bind({getConnectionState:()=> 'connected',registerInternalNotificationHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},sendAppServerRequest:async()=>({config:{}})});
  const request={id:'existing',method:'item/fileChange/requestApproval',params:{threadId:'A'},remoteApproval:{supported:true,reason:null}};
  const bridge={snapshot:async()=>[request],subscribe:async fn=>{fn([request]);return {[Symbol.dispose](){}};}};
  const instance={resource:{control:{openForgeRemoteApprovals:()=>new Promise(resolve=>{finish=resolve;})}}};
  service.attachManagers({getCurrent:()=>instance,subscribe:(_id,fn)=>{fn(instance);return()=>{};}});
  const initial=await service.bootstrap();assert.equal(initial.approvalStatus.state,'unavailable');
  const waiting=service.events({after:initial.cursor,connectionEpoch:initial.connectionEpoch,waitMs:1000});
  finish(bridge);await tick();
  assert.equal((await waiting).reset,true);assert.equal((await service.bootstrap()).approvalStatus.state,'ready');
  assert.equal((await service.dispatch('remoteChat.pending',{})).requests[0].id,'existing');
});

test('API6 manager ready before the connection proxy retains approval readiness on bind',async t=>{
  const service=new RemoteChat();t.after(()=>service.dispose());
  const request={id:'existing',method:'item/fileChange/requestApproval',params:{threadId:'A'},remoteApproval:{supported:true,reason:null}};
  const bridge={snapshot:async()=>[request],subscribe:async()=>({[Symbol.dispose](){}})};
  const instance={resource:{control:{openForgeRemoteApprovals:async()=>bridge}}};
  service.attachManagers({getCurrent:()=>instance,subscribe:(_id,fn)=>{fn(instance);return()=>{};}});await tick();
  assert.equal((await service.bootstrap()).approvalStatus.state,'unavailable');
  service.bind({getConnectionState:()=> 'connected',registerInternalNotificationHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},sendAppServerRequest:async()=>({config:{}})});
  assert.equal((await service.bootstrap()).approvalStatus.state,'ready');
  assert.equal((await service.dispatch('remoteChat.pending',{})).requests[0].id,'existing');
});
