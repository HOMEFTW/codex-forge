'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {ForgeError} = require('./forge-errors.cjs');
const {validateValue, jsonValue, schemaDefinition} = require('./forge-backend-values.cjs');
const protocol = require('./remote-chat-protocol.json');
const METHODS = Object.keys(protocol.requests);
const APPROVAL_METHODS = Object.keys(protocol.responses);
const need = (value, message, code = 'INVALID_ARGUMENT') => { if (!value) throw new ForgeError(code, message); };
const clone = value => jsonValue(value, 800 * 1024);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
async function cancellable(operation, signal) {
  signal?.throwIfAborted();
  let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(new ForgeError('CANCELLED', '请求已取消')); signal?.addEventListener('abort', abort, {once: true}); });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal?.removeEventListener('abort', abort); }
}
function expand(schema, definitions, depth = 0) {
  need(depth < 32, '原生协议 schema 深度超限');
  if (schema.$ref) return expand(definitions[schema.$ref.slice('#/definitions/'.length)], definitions, depth + 1);
  const copy = {...schema};
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (copy[key]) copy[key] = copy[key].map(item => expand(item, definitions, depth + 1));
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, value]) => [key, expand(value, definitions, depth + 1)]));
  if (copy.items) copy.items = expand(copy.items, definitions, depth + 1);
  if (object(copy.additionalProperties)) copy.additionalProperties = expand(copy.additionalProperties, definitions, depth + 1);
  return copy;
}
const requests = Object.fromEntries(Object.entries(protocol.requests).map(([key, value]) => [key, expand(value.schema, value.definitions)]));
const responses = Object.fromEntries(Object.entries(protocol.responses).map(([key, value]) => [key, expand(value.schema, value.definitions)]));
function localPath(value, directory = false) {
  need(typeof value === 'string' && value.length <= 32767 && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value), '需要本机绝对路径');
  // Network/device paths are not local attachments or workspace roots.
  need(!/^[\\/]{2}/.test(value), '不支持网络或设备路径');
  let stat; try { stat = fs.statSync(value); } catch { throw new ForgeError('INVALID_ARGUMENT', '本机路径不存在'); }
  need(directory ? stat.isDirectory() : stat.isFile(), directory ? '工作路径必须为目录' : '附件必须为本机文件');
}
function validateRequest(method, params) {
  need(METHODS.includes(method), '未开放的远程聊天方法', 'METHOD_NOT_FOUND');
  need(object(params), 'params 必须为对象');
  validateValue(requests[method], params, method);
  for (const name of ['threadId', 'turnId', 'expectedTurnId']) if (params[name] !== undefined && params[name] !== null) need(typeof params[name] === 'string' && /^[\w-]{1,200}$/.test(params[name]), name + ' 无效');
  if (params.limit !== undefined && params.limit !== null) need(params.limit >= 1 && params.limit <= 100, '分页 limit 必须为 1–100');
  if (method === 'thread/items/read') need(params.itemIds.length >= 1 && params.itemIds.length <= 100 && params.itemIds.every(id => id.length > 0), 'itemIds 需要 1–100 个非空 ID');
  if (params.cwd != null) for (const cwd of Array.isArray(params.cwd) ? params.cwd : [params.cwd]) localPath(cwd, true);
  if (params.input) {
    need(params.input.length > 0 && params.input.length <= 64, 'input 需要 1–64 项');
    for (const item of params.input) {
      need(['text', 'localImage', 'localAudio', 'mention', 'skill'].includes(item.type), '仅支持文本与本机附件');
      if (item.type !== 'text') localPath(item.path);
    }
  }
  if (params.collaborationMode) {
    need(['default', 'plan'].includes(params.collaborationMode.mode), '协作模式仅支持 default/plan');
    need(params.collaborationMode.settings.developer_instructions == null, '远程模式不可覆盖开发者指令');
  }
  return params;
}
function validateResponse(request, result, {nativeManager = false} = {}) {
  need(object(result), 'result 必须为对象');
  validateValue(responses[request.method], result, request.method);
  const p = request.params;
  if (request.method === 'item/permissions/requestApproval') {
    need(nativeManager, '权限请求需要原生 manager 审批', 'PERMISSION_DENIED');
    need(result.scope === 'turn', '远程权限仅允许本回合授权');
    need(result.strictAutoReview !== false, '远程回复不可关闭逐次审查');
    const subset = (granted, asked) => {
      if (granted == null || granted === false) return true;
      if (Array.isArray(granted)) return Array.isArray(asked) && granted.every(item => asked.some(value => require('node:util').isDeepStrictEqual(value,item)));
      if (object(granted)) return Object.keys(granted).every(key => Object.hasOwn(asked || {},key) && subset(granted[key],asked[key]));
      return granted === asked;
    };
    need(subset(result.permissions,p.permissions), '授予权限超过原生请求范围');
  } else if (request.method.endsWith('/requestApproval')) {
    need(typeof result.decision === 'string', '远程审批仅支持原生单次或会话决定');
    if (nativeManager) need(['accept','decline','cancel'].includes(result.decision), '远程审批仅允许单次决定');
    if (p.availableDecisions) need(p.availableDecisions.includes(result.decision), '审批决定不在原生允许列表中');
  }
  if (request.method === 'item/tool/requestUserInput') {
    const ids = new Set((p.questions || []).map(q => q.id));
    need(Object.keys(result.answers).every(id => ids.has(id)), '回答包含未知问题');
  }
  if (request.method === 'mcpServer/elicitation/request') {
    need(p.mode !== 'openai/userVerification', '此验证需要在桌面完成', 'PERMISSION_DENIED');
    // Codex Apps has an additional execution-bound confirmation check in its
    // native manager. Keep those approvals in that manager until an adapter
    // can call its public approval actions, rather than bypassing the check.
    need(nativeManager || result.action !== 'accept' || p.serverName !== 'codex_apps', 'Codex Apps 的确认需要在桌面完成', 'PERMISSION_DENIED');
    need(result._meta == null, '远程确认不接受额外持久授权元数据');
    if (result.action === 'accept' && p.mode === 'form') { schemaDefinition(p.requestedSchema); validateValue(p.requestedSchema, result.content, 'content'); }
  }
}
class RemoteChat {
  constructor({defaultCwd = () => null, enabled = () => true, maxEvents = 2048, maxBytes = 4 * 1024 * 1024} = {}) {
    Object.assign(this, {defaultCwd, enabled, maxEvents, maxBytes});
    this.connection = null; this.disposers = []; this.waiters = new Set(); this.sequence = 0;
    this.queue = []; this.bytes = 0; this.pending = new Map(); this.claimed = new Set(); this.reset();
  }
  reset() {
    this.epoch = crypto.randomUUID(); this.queue = []; this.bytes = 0; this.floor = this.sequence;
    this.pending.clear(); this.claimed.clear(); this.wake();
  }
  wake() { for (const wake of [...this.waiters]) wake(); }
  connected() { return !!this.connection && (!this.connection.getConnectionState || this.connection.getConnectionState() === 'connected'); }
  attachManagers(managers) {
    this.managerDispose?.();
    this.managers = managers;
    const dispose = managers.subscribe('local', instance => this.bindManager(instance));
    this.managerDispose = () => { dispose(); this.bindManager(null); this.managers = null; };
    return {dispose: () => { this.managerDispose?.(); this.managerDispose = null; }};
  }
  async bindManager(instance) {
    const generation = this.managerGeneration = (this.managerGeneration || 0) + 1;
    this.approvalLease?.[Symbol.dispose]?.(); this.approvalLease = null;
    this.approvalBridge = null; this.managerInstance = instance; this.approvalsAvailable = false;
    this.reset();
    if (!instance) return;
    const current = () => generation === this.managerGeneration && this.managers?.getCurrent('local') === instance;
    try {
      const bridge = await instance.resource.control.openForgeRemoteApprovals();
      if (!current()) return;
      const subscription = await bridge.subscribe(requests => { if (current() && this.approvalBridge === bridge) this.syncApprovals(requests); });
      if (!current()) { subscription[Symbol.dispose]?.(); return; }
      this.approvalBridge = bridge; this.approvalLease = subscription; this.approvalsAvailable = true;
      // A browser may have bootstrapped while this RPC subscription was opening.
      // Signal its existing resync path, then restore all current native requests.
      this.reset();
      await this.refreshApprovals();
    } catch { if (current()) {
      this.approvalLease?.[Symbol.dispose]?.(); this.approvalLease = null; this.approvalBridge = null;
      this.approvalsAvailable = false; this.reset();
    } }
  }
  syncApprovals(requests) {
    const live = new Set();
    for (const request of this.enabled() ? requests : []) {
      if (!APPROVAL_METHODS.includes(request.method) || !request.params?.threadId) continue;
      live.add(request.id);
      if (this.pending.has(request.id)) continue;
      const record = {...clone(request), epoch:this.epoch, managed:true};
      this.pending.set(record.id,record); this.push('server/request',this.publicRequest(record));
    }
    for (const [id,record] of this.pending) if (record.managed && !live.has(id)) {
      this.pending.delete(id); this.push('serverRequest/resolved',{threadId:record.params.threadId,requestId:id});
    }
  }
  async refreshApprovals({signal, check = () => {}} = {}) {
    const bridge = this.approvalBridge, epoch = this.epoch;
    if (!bridge) return;
    const snapshot = await cancellable(() => { check(); return bridge.snapshot(); },signal);
    check(); signal?.throwIfAborted();
    if (bridge === this.approvalBridge && epoch === this.epoch) this.syncApprovals(snapshot);
  }
  bind(connection) {
    if (connection === this.connection) return;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.connection = connection; this.approvalsAvailable = false; this.reset();
    if (!connection) return;
    this.disposers.push(connection.registerInternalNotificationHandler(event => this.observe(event)));
    this.disposers.push(connection.registerInternalConnectionStateHandler(() => this.reset()));
    this.disposers.push(connection.registerInternalAuthenticatedPrincipalChangeHandler(() => this.reset()));
    const service = this, dispatch = connection.dispatchServerRequest, respond = connection.handleClientResponse;
    this.approvalsAvailable = this.managers
      ? !!this.approvalBridge && this.managers.getCurrent('local') === this.managerInstance
      : typeof dispatch === 'function' && typeof respond === 'function';
    if (!this.approvalsAvailable || this.managers) return;
    // Observe only the dispatch AFTER internal/desktop request handlers. Do not
    // register an internal responder (that would steal native review requests).
    const dispatchWrapper = function(request, ...rest) {
      const record = service.capture(request);
      try {
        const result = dispatch.call(this, request, ...rest);
        queueMicrotask(() => { if (record && service.pending.get(record.id) === record) service.push('server/request', service.publicRequest(record)); });
        return result;
      } catch (error) { if (record) service.pending.delete(record.id); throw error; }
    };
    const responseWrapper = async function(message, threadId, guard) {
      const record = [...service.pending.values()].find(item => item.nativeId === message.id);
      if (!record) { if (service.claimed.has(message.id)) return; return respond.call(this, message, threadId, guard); }
      if (record.sending) return;
      record.sending = true;
      const checked = () => {
        if (service.pending.get(record.id) !== record || record.epoch !== service.epoch) return false;
        if (guard?.() === false) return false;
        service.pending.delete(record.id); service.claimed.add(message.id);
        service.push('serverRequest/resolved', {threadId: record.params.threadId, requestId: record.id});
        return true;
      };
      checked.authorize = guard?.authorize;
      try { return await respond.call(this, message, threadId, checked); }
      finally { record.sending = false; }
    };
    connection.dispatchServerRequest = dispatchWrapper; connection.handleClientResponse = responseWrapper;
    this.disposers.push(() => {
      if (connection.dispatchServerRequest === dispatchWrapper) connection.dispatchServerRequest = dispatch;
      if (connection.handleClientResponse === responseWrapper) connection.handleClientResponse = respond;
    });
  }
  capture(request) {
    if (!this.enabled()) return null;
    if (!APPROVAL_METHODS.includes(request.method) || !request.params?.threadId || request.params.mode === 'openai/userVerification') return null;
    if ([...this.pending.values()].some(item => item.nativeId === request.id)) return null;
    this.claimed.delete(request.id);
    if (this.pending.size >= 256) return null; // Native desktop still owns it.
    let params; try { params = clone(request.params); } catch { return null; }
    const record = {id: crypto.randomUUID(), nativeId: request.id, method: request.method, params, epoch: this.epoch};
    this.pending.set(record.id, record); return record;
  }
  publicRequest(record) { return {id: record.id, method: record.method, params: record.params, ...record.remoteApproval ? {remoteApproval:record.remoteApproval} : {}}; }
  observe({method, params = {}}) {
    if (!/^(?:thread\/|turn\/|item\/|hook\/|model\/|serverRequest\/|error$)/.test(method)) return;
    if (method === 'serverRequest/resolved') {
      const record = [...this.pending.values()].find(item => item.nativeId === params.requestId);
      if (record) { record.retired = true; this.pending.delete(record.id); this.push(method, {...params, requestId: record.id}); }
      return;
    }
    if (method === 'turn/completed' || /^thread\/(closed|deleted|archived)$/.test(method)) {
      for (const [id, item] of this.pending) if (item.params.threadId === params.threadId && (method !== 'turn/completed' || item.params.turnId === (params.turn?.id || params.turnId))) {
        item.retired = true;
        this.pending.delete(id); this.claimed.add(item.nativeId); this.push('serverRequest/resolved', {threadId: params.threadId, requestId: id});
      }
    }
    this.push(method, params);
  }
  push(method, params) {
    const sequence = ++this.sequence;
    let event; try { event = clone({sequence, method, params}); } catch { this.floor = sequence; this.queue = []; this.bytes = 0; this.wake(); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 480 * 1024) { this.floor = sequence; this.queue = []; this.bytes = 0; this.wake(); return; }
    this.queue.push({event, bytes}); this.bytes += bytes;
    while (this.queue.length > this.maxEvents || this.bytes > this.maxBytes) { const removed = this.queue.shift(); this.floor = removed.event.sequence; this.bytes -= removed.bytes; }
    while (this.claimed.size > 1024) this.claimed.delete(this.claimed.values().next().value);
    this.wake();
  }
  async events({after = 0, waitMs = 0, connectionEpoch} = {}, {signal, check = () => {}} = {}) {
    need(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 20000, '事件游标或等待时间无效');
    const epoch = this.epoch;
    const reset = () => after < this.floor || after > this.sequence || connectionEpoch !== undefined && connectionEpoch !== this.epoch || epoch !== this.epoch;
    check(); signal?.throwIfAborted();
    if (!reset() && after === this.sequence && waitMs) await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { done(); reject(new ForgeError('CANCELLED', '请求已取消')); };
      const timer = setTimeout(done, waitMs); this.waiters.add(done); signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
    });
    check(); signal?.throwIfAborted();
    if (reset()) return {events: [], cursor: this.sequence, reset: true, connectionEpoch: this.epoch};
    let size = 0; const events = [];
    for (const item of this.queue) if (item.event.sequence > after) { if (size + item.bytes > 480 * 1024) break; size += item.bytes; events.push(item.event); }
    return clone({events, cursor: events.at(-1)?.sequence ?? this.sequence, reset: false, connectionEpoch: this.epoch});
  }
  async call(method, params, {signal, check = () => {}} = {}) {
    const connection = this.connection, epoch = this.epoch;
    const guard = () => { check(); signal?.throwIfAborted(); need(this.connected() && connection === this.connection && epoch === this.epoch, '桌面连接已变化，请重新同步', 'STALE_CONNECTION'); };
    guard();
    const lifetime = connection.captureRequestLifetime?.();
    const beforeSend = () => { guard(); lifetime?.(); };
    const result = await cancellable(() => { beforeSend(); return connection.sendAppServerRequest(method, params, beforeSend, {timeoutMs: 20000}); }, signal);
    guard(); return clone(result);
  }
  async request({method, params = {}}, options) {
    params = clone(params); validateRequest(method, params);
    if (method === 'thread/start' && params.cwd == null) { const cwd = this.defaultCwd(); if (cwd) { localPath(cwd, true); params.cwd = cwd; } }
    return this.call(method, params, options);
  }
  async bootstrap(options) {
    await this.refreshApprovals(options);
    const defaults = {model: null, effort: null, serviceTier: null, cwd: this.defaultCwd()};
    if (this.connected()) {
      const result = await this.call('config/read', {includeLayers: false, cwd: defaults.cwd}, options);
      const config = result.config || {};
      defaults.model = typeof config.model === 'string' ? config.model : null;
      defaults.effort = typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : null;
      defaults.serviceTier = typeof config.service_tier === 'string' ? config.service_tier : null;
    }
    const available = this.connected() && this.approvalsAvailable;
    return {apiVersion: 6, capabilityVersion: 1, hostId: 'local', connected: this.connected(), connectionEpoch: this.epoch, cursor: this.sequence, defaults, methods: METHODS, approvalMethods: available ? APPROVAL_METHODS.filter(method => this.approvalBridge || method !== 'item/permissions/requestApproval') : [], approvalStatus:{state:available ? 'ready' : 'unavailable',reason:available ? null : '原生人工审批通道尚未连接，请在桌面处理'}};
  }
  async respond({requestId, threadId, result, userConfirmed}, {signal, check = () => {}} = {}) {
    check(); signal?.throwIfAborted();
    const record = this.pending.get(requestId), connection = this.connection;
    need(record && record.params.threadId === threadId && record.epoch === this.epoch && this.connected(), '人工请求已过期或与聊天不匹配', 'STALE_REQUEST');
    if (record.managed) {
      need(userConfirmed === true, '需要用户逐次确认', 'PERMISSION_DENIED');
      need(record.remoteApproval?.supported, record.remoteApproval?.reason || '此请求需要在桌面完成', 'PERMISSION_DENIED');
      need(!record.sending, '该请求已有回复正在发送', 'STALE_REQUEST');
      const bridge = this.approvalBridge, epoch = this.epoch, instance = this.managerInstance;
      const authorize = () => {
        check(); signal?.throwIfAborted();
        need(this.enabled() && !record.retired && bridge && bridge === this.approvalBridge && connection === this.connection && epoch === this.epoch && this.connected() && this.managers?.getCurrent('local') === instance, '审批连接或授权已变化', 'STALE_CONNECTION');
        return true;
      };
      validateResponse(record,result,{nativeManager:true});
      record.sending = true;
      try {
        const accepted = await cancellable(() => { authorize(); return bridge.respond({requestId,threadId,result:clone(result),userConfirmed:true},authorize); },signal);
        need(accepted === true,'原生连接未接收该回复','STALE_REQUEST');
        if (this.pending.get(requestId) === record) { this.pending.delete(requestId); this.push('serverRequest/resolved',{threadId,requestId}); }
        return {accepted:true};
      } finally { record.sending = false; }
    }
    validateResponse(record, result);
    const epoch = this.epoch; let delivered = false;
    await cancellable(() => { check(); signal?.throwIfAborted(); return connection.handleClientResponse({id: record.nativeId, result: clone(result)}, threadId, () => {
      check(); signal?.throwIfAborted(); need(connection === this.connection && epoch === this.epoch && this.connected(), '审批连接已变化', 'STALE_CONNECTION'); delivered = true; return true;
    }); }, signal);
    need(delivered, '原生连接未接收该回复', 'STALE_REQUEST');
    return {accepted: true};
  }
  dispatch(method, args, options) {
    if (method === 'remoteChat.request') return this.request(args, options);
    if (method === 'remoteChat.events') return this.events(args, options);
    if (method === 'remoteChat.respond') return this.respond(args, options);
    if (method === 'remoteChat.bootstrap') return this.bootstrap(options);
    if (method === 'remoteChat.pending') {
      const pending = () => clone({requests: [...this.pending.values()].map(item => this.publicRequest(item)), cursor: this.sequence, connectionEpoch: this.epoch});
      return this.approvalBridge ? this.refreshApprovals(options).then(pending) : pending();
    }
    throw new ForgeError('METHOD_NOT_FOUND', '未知远程聊天方法');
  }
  dispose() { this.managerDispose?.(); this.managerDispose = null; this.bind(null); }
}
module.exports = {RemoteChat, METHODS, APPROVAL_METHODS, validateRequest, validateResponse};
