'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const MAX_LINE = 8 * 1024 * 1024;
const MAX_FINAL = 4 * 1024 * 1024;
function safe(value, max = MAX_FINAL) {
  return String(value ?? '').slice(0, max)
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@');
}
function check(value, message) { if (!value) throw new Error(message); }

/** Only this run's supplied patch file is written. Native DSH owns its derived profile root. */
function dshInvocation(config = {}, resolved, { patchFile } = {}) {
  check(resolved?.command && Array.isArray(resolved.prefix), 'DSH 可执行入口无效');
  const extra = config.args || [];
  check(Array.isArray(extra) && extra.every(value => typeof value === 'string' && !/[\r\n\0]/.test(value)), 'DSH 启动参数无效');
  check(!extra.some(value => /^(?:--(?:profile|from-default-profile|dump-config|dump-default-config|dump-config-schema|json|session-id|help|version)(?:=|$)|-h$|-V$)/.test(value)), 'DSH 配置参数不能覆盖 ACP profile 或初始化用户配置');
  check(!extra.includes('plugin'), 'DSH ACP 不通过启动参数安装或修改插件');
  check(!config.model && !config.reasoningEffort || config.provider && config.model, '覆盖 DSH 模型或思考强度时需有效的提供商 provider 与模型 ID');
  check(typeof patchFile === 'string' && path.isAbsolute(patchFile), 'DSH ACP 需要本任务临时 patchFile 的绝对路径');
  const selection = config.model ? { provider: config.provider, model: config.model } : {
    provider: { __jsExpr: "ctx.get('agentDefaultModel').currentSelection().provider" },
    model: { __jsExpr: "ctx.get('agentDefaultModel').currentSelection().model" },
  };
  const patches = [{ id: 'acp', inject: ['acpAppStartup', 'agentDefaultModel'], config: selection }];
  if (config.model) patches.unshift({ id: 'agent-default-model', config: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) } });
  fs.writeFileSync(patchFile, JSON.stringify(patches), { mode: 0o600 });
  return { ...resolved, args: [...resolved.prefix, ...extra, '--profile', 'acp', '--patch', patchFile], protocol: 'acp', stdin: false, keepStdin: true };
}

function choices(option) {
  return (option?.options || []).flatMap(item => Array.isArray(item.options) ? item.options.map(value => ({ ...value, provider: item.group })) : [item]);
}
function modelChoice(option, config) {
  return choices(option).find(item => {
    if (item.value === config.model) return !config.provider || item.provider === config.provider;
    try { const value = JSON.parse(item.value); return Array.isArray(value) && value[1] === config.model && (!config.provider || value[0] === config.provider); }
    catch { return false; }
  });
}

/** Official DSH ACP: reverse permission RPC remains pending until the broker settles. */
function attachDshApprovalSession({ child, task, cwd, config = {}, sessionId = '', emit = () => {}, requestPermission } = {}) {
  let finalText = '', failure = '', finalTruncated = false, permissionDenied = false;
  let currentSession = sessionId || '', messageId = '', buffer = '', sequence = 0, active = true;
  const decoder = new StringDecoder('utf8'), pending = new Map(), permissions = new Map(), tools = new Map();
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const publish = (type, value) => { if (value) emit(type, safe(value)); };
  function write(frame) {
    check(active && child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded, 'DSH ACP 输入连接已关闭');
    child.stdin.write(JSON.stringify(frame) + '\n');
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = 'fast-dsh-' + ++sequence;
      pending.set(id, { resolve, reject });
      try { write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function respond(id, result) { if (active) write({ jsonrpc: '2.0', id, result }); }
  function finish(error = '') {
    if (!active) return;
    if (error) failure ||= safe(error, 16000);
    for (const [id, controller] of permissions) {
      controller.abort();
      try { respond(id, { outcome: { outcome: 'cancelled' } }); } catch { /* The closed transport cannot accept cancellation. */ }
    }
    permissions.clear();
    active = false;
    for (const operation of pending.values()) operation.reject(new Error(failure || 'DSH ACP 会话已关闭'));
    pending.clear(); tools.clear();
    child?.stdout?.removeListener('data', onData);
    child?.stdout?.removeListener('error', onError);
    child?.removeListener('close', onClose);
    child?.removeListener('error', onError);
    child?.stdin?.removeListener('error', onError);
    if (child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.once('error', () => {});
      child.stdin.end();
    }
    if (failure) publish('error', failure);
    else publish('final', finalText);
    complete({ finalText: safe(finalText), sessionId: currentSession, failure, permissionDenied, finalTruncated });
  }
  function update(params) {
    if (params?.sessionId !== currentSession) return;
    const value = params.update;
    if (!value || typeof value !== 'object') return;
    if (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update') {
      const previous = tools.get(value.toolCallId) || {};
      if (typeof value.toolCallId === 'string') tools.set(value.toolCallId, { ...previous, ...value });
      const output = (Array.isArray(value.content) ? value.content : []).map(item => item.type === 'content' && item.content?.type === 'text' ? item.content.text : '').filter(Boolean).join('\n');
      publish('tool', `${value.title || previous.title || 'DSH 工具'}${value.rawInput !== undefined ? ' ' + JSON.stringify(value.rawInput) : ''}${value.status ? ' [' + value.status + ']' : ''}${output ? '\n' + output : ''}`);
    } else if (value.content?.type === 'text' && typeof value.content.text === 'string') {
      if (value.sessionUpdate === 'agent_thought_chunk') publish('thinking', value.content.text);
      if (value.sessionUpdate === 'agent_message_chunk') {
        if (typeof value.messageId === 'string' && value.messageId !== messageId) { messageId = value.messageId; finalText = ''; finalTruncated = false; }
        const remaining = MAX_FINAL - finalText.length;
        finalText += value.content.text.slice(0, remaining);
        if (value.content.text.length > remaining) finalTruncated = true;
        publish('text', value.content.text);
      }
    }
  }
  async function permission(frame) {
    const params = frame.params, call = params?.toolCall;
    const options = Array.isArray(params?.options) ? params.options : [];
    const allowed = options.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
    const rejected = options.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
    const reject = () => ({ outcome: rejected ? { outcome: 'selected', optionId: rejected.optionId } : { outcome: 'cancelled' } });
    if (params?.sessionId !== currentSession || !call || typeof call.toolCallId !== 'string' || !allowed || typeof requestPermission !== 'function' || params?.nativeDecision === 'deny') {
      permissionDenied = true;
      respond(frame.id, params?.sessionId !== currentSession ? { outcome: { outcome: 'cancelled' } } : reject());
      return;
    }
    if (permissions.has(frame.id)) return;
    const tool = { ...tools.get(call.toolCallId), ...call };
    if (tool.rawInput === undefined || tool.rawInput === null || !tool.title && !tool.name) {
      permissionDenied = true;
      publish('notice', 'DSH 审批动作的工具名称或 rawInput 参数不完整，已拒绝本次请求');
      respond(frame.id, reject());
      return;
    }
    const controller = new AbortController(); permissions.set(frame.id, controller);
    const forceHuman = params.forceHuman === true || params._meta?.forceHuman === true || tool._meta?.forceHuman === true;
    try {
      const decision = await requestPermission({ requestId: String(frame.id), toolName: tool.title || tool.name, input: tool.rawInput, nativeDecision: 'ask', ...(forceHuman ? { forceHuman: true } : {}), sessionId: currentSession, toolCallId: call.toolCallId, signal: controller.signal });
      if (!active || controller.signal.aborted || !permissions.has(frame.id)) return;
      permissions.delete(frame.id);
      if (decision?.behavior === 'allow') respond(frame.id, { outcome: { outcome: 'selected', optionId: allowed.optionId } });
      else { permissionDenied = true; respond(frame.id, reject()); publish('notice', decision?.reason || 'DSH 工具请求未获批准'); }
    } catch (error) {
      if (!active || controller.signal.aborted || !permissions.has(frame.id)) return;
      permissions.delete(frame.id); permissionDenied = true;
      respond(frame.id, reject()); publish('notice', 'DSH 审批失败：' + error.message);
    }
  }
  function frame(value) {
    if (!value || value.jsonrpc !== '2.0') throw new Error('DSH ACP 返回无效的 JSON-RPC 消息');
    if (typeof value.method === 'string') {
      if (value.method === 'session/update' && value.id === undefined) update(value.params);
      else if (['$/cancel_request', '$/cancelRequest', 'notifications/cancelled'].includes(value.method) && value.id === undefined) {
        const id = value.params?.requestId ?? value.params?.id;
        const controller = permissions.get(id);
        if (controller) {
          permissions.delete(id); controller.abort();
          respond(id, { outcome: { outcome: 'cancelled' } });
          publish('notice', 'DSH 已撤销本次审批请求');
        }
      }
      else if (value.method === 'session/request_permission' && (typeof value.id === 'string' || typeof value.id === 'number')) permission(value).catch(error => finish(error.message));
      else if (value.id !== undefined) write({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: '此客户端不提供文件或终端执行能力' } });
      return;
    }
    const operation = pending.get(value.id);
    if (!operation) return;
    pending.delete(value.id);
    if (value.error) operation.reject(new Error(safe(value.error.message || 'DSH ACP 请求失败', 16000)));
    else operation.resolve(value.result);
  }
  function onData(chunk) {
    if (!active) return;
    try {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let at;
      while (active && (at = buffer.indexOf('\n')) >= 0) {
        check(at <= MAX_LINE, 'DSH ACP 单条消息超过 8 MB');
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (line) frame(JSON.parse(line));
      }
      check(buffer.length <= MAX_LINE, 'DSH ACP 单条消息超过 8 MB');
    } catch (error) { finish(error.message); }
  }
  function onError(error) { finish(error.message); }
  function onClose(code, signal) { finish(`DSH ACP 连接提前关闭，退出码 ${code}${signal ? ' (' + signal + ')' : ''}`); }
  child?.stdout?.on('data', onData); child?.stdout?.on('error', onError);
  child?.on('error', onError); child?.on('close', onClose); child?.stdin?.on('error', onError);
  Promise.resolve().then(async () => {
    check(child?.stdin && child?.stdout, 'DSH ACP 进程没有双向 stdio');
    const initialized = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'codex-fast', version: '4.0.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    check(initialized?.protocolVersion === 1, 'DSH ACP 协议版本不受支持');
    const capabilities = initialized.agentCapabilities?.sessionCapabilities || {};
    if (sessionId) check(capabilities.resume, '本机 DSH ACP 未声明会话续接 resume 能力');
    const session = await request(sessionId ? 'session/resume' : 'session/new', { ...(sessionId ? { sessionId } : {}), cwd, mcpServers: [] });
    // ACP resume returns configuration only; the request remains the session identity.
    check(session && (sessionId ? session.sessionId === undefined || session.sessionId === sessionId : typeof session.sessionId === 'string' && session.sessionId), 'DSH ACP 未返回有效会话 ID');
    currentSession = sessionId || session.sessionId;
    let options = session.configOptions || [];
    if (config.model) {
      const option = options.find(value => value.category === 'model' || value.id === 'model'), selected = modelChoice(option, config);
      check(option && selected, 'DSH ACP 未声明所选提供商与模型');
      if (option.currentValue !== selected.value) options = (await request('session/set_config_option', { sessionId: currentSession, configId: option.id, value: selected.value }))?.configOptions || [];
    }
    if (config.reasoningEffort) {
      const option = options.find(value => value.category === 'thought_level' || value.id === 'reasoning_effort');
      check(option && choices(option).some(value => value.value === config.reasoningEffort), 'DSH ACP 未声明所选思考强度 reasoning effort');
      if (option.currentValue !== config.reasoningEffort) await request('session/set_config_option', { sessionId: currentSession, configId: option.id, value: config.reasoningEffort });
    }
    const result = await request('session/prompt', { sessionId: currentSession, prompt: [{ type: 'text', text: task }] });
    check(result?.stopReason === 'end_turn', `DSH ACP 任务未正常结束：${result?.stopReason || '未知原因'}`);
    if (capabilities.close) await request('session/close', { sessionId: currentSession });
    finish();
  }).catch(error => finish(error.message));
  return { completion, dispose: () => {
    if (!active) return;
    try { if (currentSession) write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: currentSession } }); } catch { /* Cancellation still fails closed if transport is gone. */ }
    finish('DSH ACP 会话已取消');
  } };
}

module.exports = { dshInvocation, attachDshApprovalSession };
