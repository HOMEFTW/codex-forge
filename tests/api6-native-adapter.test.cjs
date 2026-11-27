'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {RemoteChat} = require('../runtime/remote-chat.cjs');
const {NativePredictionPolicy} = require('../runtime/native-prediction-policy.cjs');
const upstream = require('./fixtures/remote-chat-native-261120.json');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('API6 adapter exercises actual 26.1120 host request/notification/response methods, including guard timing', async t => {
  const methods = vm.runInNewContext('({' + Object.values(upstream.methods).join(',') + '})', {ei:require('node:crypto'), $:{PpM:()=>undefined,DDP:value=>String(value),ZJQ:()=>false}, console});
  const sent = [], nativeRequests = [], handlers = new Set();
  const connection = Object.assign(Object.create(methods), {
    getConnectionState:()=> 'connected', ensureReady:async()=>{},
    options:{hostId:'local'}, logger:{trace(){},info(){},warning(){}},
    userVerification:{remove(){}},turnCwds:{observeClientResponse(){}},requestUserInputAutoResolution:{stopTrackingRequest(){}},
    internalNotificationHandlers:new Map(),executorRequests:{handleNotification(){}},
    configuration:{handleSuccessfulRequest(){}},
    registerInternalConnectionStateHandler:fn=>{handlers.add(fn);return()=>handlers.delete(fn);},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},
    messageDelivery:{sendMessage:message=>sent.push(message),broadcastToWindows:()=>{}},
    sendInternalRequest:async request=>{nativeRequests.push(request);return {result:{thread:{id:'background'}}};},
    // Same native entry used by host manager after desktop/internal handlers.
    hostEventHandler:{onRequest:()=>true},
  });
  const service=new RemoteChat();t.after(()=>service.dispose());service.bind(connection);
  await service.request({method:'thread/read',params:{threadId:'background'}});assert.equal(nativeRequests[0].method,'thread/read');
  const incoming={id:72,method:'item/fileChange/requestApproval',params:{threadId:'background',turnId:'T'}};
  connection.dispatchServerRequest(incoming,'background');await tick();const pending=service.dispatch('remoteChat.pending',{}).requests[0];
  assert.deepEqual(await service.respond({requestId:pending.id,threadId:'background',result:{decision:'decline'}}),{accepted:true});assert.equal(sent.length,1);assert.equal(sent[0].id,72);
  await connection.handleClientResponse({id:72,result:{decision:'accept'}},'background');assert.equal(sent.length,1);
  connection.notifyInternalNotificationHandlers({method:'item/agentMessage/delta',params:{threadId:'unselected',delta:'hello'}});assert.equal((await service.events({after:service.sequence-1})).events[0].params.threadId,'unselected');
  connection.dispatchServerRequest({...incoming,id:73},'background');const retry=service.dispatch('remoteChat.pending',{}).requests[0];
  let calls=0;await assert.rejects(service.respond({requestId:retry.id,threadId:'background',result:{decision:'accept'}},{check:()=>{if(++calls>1)throw Error('permission revoked');}}),/permission revoked/);assert.equal(sent.length,1);assert.equal(service.pending.size,1);
  service.dispose();assert.equal(connection.dispatchServerRequest,methods.dispatchServerRequest);assert.equal(connection.internalNotificationHandlers.size,0);
});
test('API6 policy injection binds/replaces/releases only the existing registry connection',async t=>{
  const seen=[],notifications=new Set(),accounts=new Set(),states=new Set(),add=set=>fn=>{set.add(fn);return()=>set.delete(fn);};let registryChanged;
  const connection={getAccount:async()=>({requiresOpenaiAuth:false}),registerInternalNotificationHandler:add(notifications),registerInternalAuthenticatedPrincipalChangeHandler:add(accounts),registerInternalConnectionStateHandler:add(states)};
  const policy=new NativePredictionPolicy(()=>{},()=>{},value=>seen.push(value));t.after(()=>policy.dispose());
  policy.attach({settings:{getEffective:()=>false,onDidChange:()=>()=>{}},connections:{subscribe:fn=>{registryChanged=fn;return()=>{};},getMaybeConnection:()=>connection},hostId:'local'});
  assert.equal(seen.at(-1),connection);registryChanged({hostId:'other',type:'added',connection:{}});assert.equal(seen.at(-1),connection);
  registryChanged({hostId:'local',type:'removed',connection});assert.equal(seen.at(-1),null);assert.equal(notifications.size,0);
});
