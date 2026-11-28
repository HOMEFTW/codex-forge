'use strict';
// Runs in the native manager utility, behind its existing account-bound control.
const crypto = require('node:crypto');
const {ForgeError} = require('./forge-errors.cjs');
const {jsonValue, schemaDefinition} = require('./forge-backend-values.cjs');
const {APPROVAL_METHODS, validateResponse} = require('./remote-chat.cjs');
const bridges = new WeakMap();
const need = (ok, message, code = 'STALE_REQUEST') => { if (!ok) throw new ForgeError(code, message); };

function open({manager, router, assertCurrent, lease}) {
  assertCurrent();
  if (bridges.has(router)) return bridges.get(router);
  const records = new Map(), listeners = new Set(), retired = new WeakSet();
  let invocation, scheduled = false;
  const current = record => { assertCurrent(); return !retired.has(record.request) && router.isCurrent() && router.requests.get(record.nativeId) === record.admission; };
  function support(request, context) {
    if (request.method === 'mcpServer/elicitation/request') {
      const p = request.params;
      if (p.mode !== 'form') return {supported:false,reason:'此验证或专用表单需要在桌面完成'};
      if (['browser_auth','browser_email_otp','tool_suggestion'].includes(p._meta?.codex_approval_kind)) return {supported:false,reason:'账户验证与安装操作需要在桌面完成'};
      if (context.getEquivalentConnectorAuthRequests(request, context.getConversationRequests(p.threadId)).length !== 1) return {supported:false,reason:'关联的授权请求需要在桌面逐项处理'};
      try { schemaDefinition(p.requestedSchema); } catch { return {supported:false,reason:'此表单格式需要在桌面完成'}; }
    }
    return {supported:true,reason:null};
  }
  function snapshot() {
    assertCurrent();
    const context = manager.getApprovalActionContext(), seen = new Set(), requests = [];
    for (const [nativeId, admission] of router.requests) {
      if (!APPROVAL_METHODS.includes(admission.method) || !admission.threadId || admission.admission == null) continue;
      const request = context.getConversationRequests(admission.threadId).find(item => item.id === nativeId && item.method === admission.method);
      if (!request || retired.has(request)) continue;
      let record = records.get(nativeId);
      if (!record || record.admission !== admission || record.request !== request) {
        record = {id:crypto.randomUUID(),nativeId,admission,request}; records.set(nativeId,record);
      }
      seen.add(nativeId);
      try { requests.push(jsonValue({id:record.id,method:request.method,params:request.params,remoteApproval:support(request,context)}, 128 * 1024)); } catch { /* Oversized forms remain on the desktop. */ }
      if (requests.length >= 256) break;
    }
    for (const [id, record] of records) if (!seen.has(id) && !record.sending) records.delete(id);
    return requests;
  }
  function changed() {
    if (scheduled || !listeners.size) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      let value; try { value = snapshot(); } catch { value = []; }
      for (const listener of listeners) Promise.resolve().then(() => listener(value)).catch(() => {});
    });
  }
  const originalSend = router.sendResponse;
  router.sendResponse = function(method, response, ...rest) {
    const call = invocation;
    if (call) need(method === call.record.request.method && response.id === call.record.nativeId && !call.delivery, '原生审批试图回复其他请求');
    const promise = Promise.resolve(originalSend.call(this, method, response, rest[0], call?.authorize)).finally(changed);
    if (call) call.delivery = promise;
    return promise;
  };
  router.cleanup.push(() => { router.sendResponse = originalSend; records.clear(); });
  const bridge = {
    snapshot,
    subscribe(listener) {
      assertCurrent();
      const subscription = lease.subscribe(listener, notify => {
        listeners.add(notify);
        const events = manager.events;
        const cleanups = ['addApprovalRequestListener','addMcpElicitationRequestListener','addUserInputRequestListener','addApprovalResolvedListener','addConversationRemovedListener'].map(name => events[name](changed));
        cleanups.push(events.addTurnCompletedListener(({conversationId,turnId}) => {
          for (const request of manager.getApprovalActionContext().getConversationRequests(conversationId)) if (request.params.turnId === turnId) retired.add(request);
          changed();
        }), events.addNotificationCallback('serverRequest/resolved',changed));
        changed();
        return () => { listeners.delete(notify); for (const dispose of cleanups) dispose(); };
      });
      return typeof subscription === 'function' ? new lease(subscription) : subscription;
    },
    async respond({requestId,threadId,result,userConfirmed}, authorize) {
      assertCurrent();
      need(userConfirmed === true, '需要用户逐次确认', 'PERMISSION_DENIED');
      need(typeof authorize === 'function', '缺少调用方授权检查', 'PERMISSION_DENIED');
      snapshot();
      const record = [...records.values()].find(item => item.id === requestId);
      need(record && record.request.params.threadId === threadId && current(record) && !record.sending && !record.admission.sending, '人工请求已过期或与聊天不匹配');
      const context = manager.getApprovalActionContext();
      need(context.getConversationRequests(threadId).includes(record.request), '原生审批已被处理');
      const supported = support(record.request,context);
      need(supported.supported,supported.reason,'PERMISSION_DENIED');
      validateResponse(record.request,result,{nativeManager:true});
      record.sending = true;
      const call = {record, authorize:async () => { need(current(record),'原生审批已过期'); need(await authorize() === true,'调用方授权已撤销','PERMISSION_DENIED'); need(current(record),'原生审批已过期'); return true; }};
      const effects = [], originalContext = manager.getApprovalActionContext;
      const deferredContext = {...context};
      for (const name of ['approvalResolved','removeConversationRequest','applyUserInputResponse','applyMcpServerElicitationResponse','discardMcpServerElicitation','applyPermissionsRequestApprovalResponse']) {
        deferredContext[name] = (...args) => effects.push(() => context[name](...args));
      }
      try {
        await call.authorize();
        // Public actions synchronously dispatch through router.sendResponse.
        // The native admission guard and authorizer still run at actual send.
        invocation = call;
        // Native form actions optimistically remove their UI request. Defer
        // only those effects until the real guarded send succeeds; retain all
        // native lookup and execution-bound validation functions verbatim.
        manager.getApprovalActionContext = () => deferredContext;
        let action;
        try {
          switch (record.request.method) {
            case 'item/commandExecution/requestApproval': action = manager.replyWithCommandExecutionApprovalDecision(threadId,record.nativeId,result.decision); break;
            case 'item/fileChange/requestApproval': action = manager.replyWithFileChangeApprovalDecision(threadId,record.nativeId,result.decision); break;
            case 'item/permissions/requestApproval': action = manager.replyWithPermissionsRequestApprovalResponse(threadId,record.nativeId,result); break;
            case 'item/tool/requestUserInput': action = manager.replyWithUserInputResponse(threadId,record.nativeId,result); break;
            case 'mcpServer/elicitation/request': action = manager.replyWithMcpServerElicitationResponse(threadId,record.nativeId,result); break;
          }
        } finally { invocation = undefined; manager.getApprovalActionContext = originalContext; }
        // Command actions return a promise; MCP actions dispatch and return void.
        await Promise.all([action, call.delivery]);
        need(call.delivery && await call.delivery === true,'原生连接未接收该回复');
        assertCurrent();
        for (const effect of effects) effect();
        return true;
      } finally { record.sending = false; changed(); }
    },
  };
  bridges.set(router,bridge);
  return bridge;
}
module.exports = {open};
