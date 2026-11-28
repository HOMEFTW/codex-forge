'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {createNativeApprovalHost} = require('../fixtures/remote-approval-host.cjs');
const {loopback} = require('../fixtures/native-rpc-loopback.cjs');
const {RemoteChat} = require('../../runtime/remote-chat.cjs');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const form = (id,extra={}) => ({id,method:'mcpServer/elicitation/request',params:{threadId:'background',turnId:'T',serverName:'node_repl',mode:'form',message:'Allow this computer operation?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_name:'click',tool_params:{app:'fixture'}},...extra}});
async function host(t) { const h=await createNativeApprovalHost();t.after(()=>h.dispose());return h; }
const answer = (h,result={action:'accept',content:{}},extra={}) => h.bridge.respond({requestId:h.bridge.snapshot()[0].id,threadId:'background',result,userConfirmed:true,...extra},async()=>true);

test('actual manager/router/admission exposes background CU and replies only on explicit confirmation',async t=>{
  const h=await host(t),snapshots=[];const lease=h.bridge.subscribe(value=>snapshots.push(value));t.after(()=>lease[Symbol.dispose]());
  h.humanRequest(form(11));await tick();
  assert.equal(snapshots.at(-1)[0].params.serverName,'node_repl');assert.equal(h.replies.length,0);
  await assert.rejects(answer(h,undefined,{userConfirmed:false}),/逐次确认/);
  await assert.rejects(answer(h,undefined,{threadId:'different'}),/聊天不匹配/);
  assert.equal(await answer(h),true);await tick();assert.equal(h.replies.length,1);assert.equal(h.replies[0].id,11);assert.equal(h.bridge.snapshot().length,0);
});

test('actual codex_apps execution binding rejects malformed/canonical mismatch; valid per-request acceptance uses public action',async t=>{
  const h=await host(t),summary={approval_version:1,binding_name:'db',column:'value',deployment_id:'deployment',new_value:'new',old_value:'old',primary_key_column:'id',primary_key_value:'1',project_id:'project',table_name:'table'};
  const metadata={codex_approval_kind:'mcp_tool_call',connector_id:'connector_20205bf7d4e99a89d7154bb849718324',tool_name:'sites.execute_database_update',tool_params:{plan_token:'bound-plan',confirmation_summary:JSON.stringify(summary)}};
  h.humanRequest(form(12,{serverName:'codex_apps',_meta:{...metadata,tool_params:{...metadata.tool_params,confirmation_summary:JSON.stringify(summary,null,2)}}}));
  await assert.rejects(answer(h),/Unsafe MCP server elicitation approval/);assert.equal(h.replies.length,0);assert.equal(h.bridge.snapshot().length,1);
  await answer(h,{action:'decline',content:null});
  h.humanRequest(form(13,{serverName:'codex_apps',_meta:metadata}));
  await assert.rejects(answer(h,{action:'accept',content:{},_meta:{persist:'always'}}),/持久授权/);
  assert.equal(await answer(h),true);assert.equal(h.replies.length,2);
});

test('actual permissions action grants only requested scope for this turn; rejects expansion and session persistence',async t=>{
  const h=await host(t),permissions={network:{enabled:true},fileSystem:{write:['D:\\fixture']}};
  h.humanRequest({id:14,method:'item/permissions/requestApproval',params:{threadId:'background',turnId:'T',itemId:'tool',cwd:'D:\\fixture',startedAtMs:1,permissions}});
  for(const result of [{permissions,scope:'session'},{permissions:{fileSystem:{write:['C:\\']}},scope:'turn'},{permissions,scope:'turn',strictAutoReview:false}])await assert.rejects(answer(h,result));
  assert.equal(await answer(h,{permissions,scope:'turn'}),true);
  h.humanRequest({id:15,method:'item/permissions/requestApproval',params:{threadId:'background',turnId:'T',permissions}});
  assert.equal(await answer(h,{permissions:{},scope:'turn'}),true);assert.deepEqual(h.replies.at(-1).result.permissions,{});
});

test('native ingestion preserves pre-existing automatic browser policy and only publishes requests needing a person',async t=>{
  const h=await host(t);
  h.manager.conversations.set('background',{requests:[],turns:[{id:'T',params:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}}]});
  h.humanRequest(form(20,{_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'browser-use',tool_name:'access_browser_origin',tool_params:{origin:'https://example.test'}}}));
  await tick();assert.equal(h.bridge.snapshot().length,0);assert.equal(h.replies.length,1);
  h.humanRequest(form(21));await tick();assert.equal(h.bridge.snapshot().length,1);assert.equal(h.replies.length,1);
});

test('final native send rechecks authorization; failed delivery keeps native request answerable',async t=>{
  const h=await host(t);h.humanRequest(form(16));let checks=0;
  const id=h.bridge.snapshot()[0].id;
  await assert.rejects(h.bridge.respond({requestId:id,threadId:'background',result:{action:'accept',content:{}},userConfirmed:true},async()=>++checks===1),/授权已撤销/);
  assert.equal(h.replies.length,0);assert.equal(h.bridge.snapshot()[0].id,id);
  assert.equal(await answer(h),true);
});

test('completed turns retire request tokens, including an approval already waiting at native send',async t=>{
  const h=await host(t),subscription=h.bridge.subscribe(()=>{});t.after(()=>subscription[Symbol.dispose]());
  h.humanRequest(form(23));let release;h.connection.ensureReady=()=>new Promise(resolve=>{release=resolve;});
  const response=answer(h);await tick();
  h.events.emitTurnCompleted({conversationId:'background',turnId:'T'});release();
  await assert.rejects(response,/过期/);assert.equal(h.replies.length,0);assert.equal(h.bridge.snapshot().length,0);
});

test('native account retirement, disconnect and desktop race cannot send a stale/duplicate acceptance',async t=>{
  for(const kind of ['account','disconnect','desktop'])await t.test(kind,async t=>{
    const h=await host(t);h.humanRequest(form(17));let release;h.connection.ensureReady=()=>new Promise(resolve=>{release=resolve;});
    const response=answer(h);await tick();
    if(kind==='account')h.retire();
    if(kind==='disconnect')h.setState('disconnected');
    if(kind==='desktop'){
      const competing=h.manager.replyWithMcpServerElicitationResponse('background',17,{action:'decline',content:null});
      await competing;
    }
    release();
    if(kind==='desktop') { await response;assert.equal(h.replies.length,1); }
    else { await assert.rejects(response);assert.equal(h.replies.length,0); }
  });
});

test('verification, browser account forms and connector URL consent stay visible with desktop-only metadata',async t=>{
  const h=await host(t);
  for(const extra of [{mode:'openai/userVerification'},{requestedSchema:{type:'object',properties:{approved:{type:'boolean'}},required:['approved']},_meta:{codex_approval_kind:'browser_email_otp',connector_id:'browser-use',origin:'https://example.test',frame_origin:'https://example.test',browser_auth_challenge_id:'a'.repeat(32),otp_handle:'a'.repeat(21)+'A'}},{mode:'url',url:'https://chatgpt.com/connector',serverName:'codex_apps',_meta:{_codex_apps:{connector_auth_failure:{is_auth_failure:true,connector_id:'fixture',connector_name:'Fixture',install_url:'https://chatgpt.com/connector'}}}}]){
    h.humanRequest(form(crypto.randomUUID(),extra));
  }
  const requests=h.bridge.snapshot();assert.equal(requests.length,3);assert(requests.every(r=>!r.remoteApproval.supported));
  await assert.rejects(answer(h),/桌面/);assert.equal(h.replies.length,0);
});

test('real native RPC bridge carries snapshot subscriptions and final user authorizer end-to-end',async t=>{
  const h=await host(t),wire=loopback(h.rpc,h.bridge),service=new RemoteChat();
  t.after(()=>{service.dispose();wire.close();});
  service.bind({getConnectionState:()=> 'connected',registerInternalNotificationHandler:()=>()=>{},registerInternalConnectionStateHandler:()=>()=>{},registerInternalAuthenticatedPrincipalChangeHandler:()=>()=>{},sendAppServerRequest:async()=>({config:{}})});
  const instance={resource:{control:wire.control}};
  service.attachManagers({subscribe:(_host,fn)=>{fn(instance);return()=>{};},getCurrent:()=>instance});
  for(let i=0;i<20&&!service.approvalsAvailable;i++)await tick();
  assert.equal((await service.bootstrap()).approvalStatus.state,'ready');
  h.humanRequest(form(25));
  for(let i=0;i<20&&!service.pending.size;i++)await tick();
  const request=(await service.dispatch('remoteChat.pending',{})).requests[0];assert(request);
  assert.deepEqual(await service.respond({requestId:request.id,threadId:'background',result:{action:'accept',content:{}},userConfirmed:true}),{accepted:true});
  assert.equal(h.replies.length,1);assert.equal(h.replies[0].id,25);
});
