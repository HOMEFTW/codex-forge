'use strict';
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');
const { clean, createParser } = require('./agent-cli.cjs');

// Protocol sources: Claude Agent SDK 0.3.303 sdk.d.ts (CanUseTool,
// SDKControlPermissionRequest/Response) and sdk.mjs's --permission-prompt-tool=stdio.
// Grok 1.0.62's bundled 15-agent-mode/22-permissions-and-safety documentation;
// Codeg src-tauri/src/acp/connection.rs:2127,5457,8107 (launch, effort, ACP v1).
// No approval writes a persistent rule, changes the requested input, or retries a deny.
function attachApprovalSession({ agent, child, task, cwd, config = {}, sessionId = '', emit = () => {}, requestPermission }) {
  if (!['claude', 'grok'].includes(agent)) throw Error('不支持的审批会话协议');
  const decoder = new StringDecoder('utf8'), parser = createParser(agent, emit);
  const requests = new Map(), permissions = new Map(), answers = new Map(), tools = new Map();
  let buffer = '', finished = false, sequence = 0, nativeSessionId = sessionId || '', promptStarted = false, permissionDenied = false, resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const key = id => typeof id + ':' + String(id);
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 || typeof id === 'number' && Number.isFinite(id);
  function endInput() { try { if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end(); } catch { /* The worker owns process shutdown. */ } }
  function cleanup() {
    child.stdout.removeListener('data', onData); child.stdout.removeListener('error', onError);
    child.removeListener('close', onClose); child.removeListener('error', onError); child.stdin.removeListener('error', onError);
  }
  function finish(extra = {}) {
    if (finished) return;
    finished = true;
    for (const pending of permissions.values()) pending.controller.abort(); permissions.clear();
    for (const pending of requests.values()) pending.reject(Error('智能体会话已结束')); requests.clear();
    const parsed = parser.finish(); permissionDenied ||= parsed.permissionDenied;
    endInput(); cleanup();
    resolveCompletion({ ...parsed, sessionId: parsed.sessionId || nativeSessionId, permissionDenied,
      failure: clean(extra.failure || parsed.failure || (permissionDenied ? '部分工具请求未获批准，任务未完整执行' : '')),
      ...(typeof extra.exitCode === 'number' ? { exitCode: extra.exitCode } : {}) });
  }
  function write(value) {
    if (finished) return false;
    try { child.stdin.write(JSON.stringify(value) + '\n'); return true; }
    catch (error) { finish({ failure: '无法回复智能体审批协议：' + error.message }); return false; }
  }
  function denied(reason) { permissionDenied = true; emit('notice', clean(reason || '工具请求未获批准')); }
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (finished) { reject(Error('智能体会话已结束')); return; }
      const id = 'fast-rpc-' + ++sequence; requests.set(key(id), { resolve, reject });
      if (!write({ jsonrpc: '2.0', id, method, params })) { requests.delete(key(id)); reject(Error('无法写入智能体协议')); }
    });
  }
  function cancelPermission(id) {
    const pending = permissions.get(key(id));
    if (pending) { permissions.delete(key(id)); answers.set(key(id), { fingerprint: pending.fingerprint }); pending.controller.abort(); }
  }
  function ask(id, payload, action, reply) {
    const requestKey = key(id), fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = permissions.get(requestKey) || answers.get(requestKey);
    if (previous) {
      if (previous.fingerprint === fingerprint) return;
      cancelPermission(id); denied('智能体重复使用审批标识且改变了动作，已拒绝');
      const response = reply(false, '审批标识冲突'); answers.set(requestKey, { fingerprint, response }); write(response); return;
    }
    const controller = new AbortController(), entry = { fingerprint, controller }; permissions.set(requestKey, entry);
    const decide = async () => {
      try {
        if (typeof requestPermission !== 'function') return { behavior: 'deny', reason: '审批服务不可用' };
        return await requestPermission({ ...action, agent, requestId: String(id), cwd, sessionId: nativeSessionId, nativeDecision: 'ask', signal: controller.signal });
      } catch (error) { return { behavior: 'deny', reason: clean(error.message || error) }; }
    };
    Promise.resolve().then(decide).then(decision => {
      if (finished || controller.signal.aborted || permissions.get(requestKey) !== entry) return;
      const allow = decision?.behavior === 'allow', reason = clean(decision?.reason || (allow ? '' : '工具请求未获批准'));
      if (!allow) denied(reason);
      const response = reply(allow, reason); permissions.delete(requestKey); answers.set(requestKey, { fingerprint, response }); write(response);
    }).catch(error => { if (!finished) finish({ failure: error.message }); });
  }
  function claude(value) {
    if (typeof value.session_id === 'string' && value.session_id) nativeSessionId = value.session_id;
    if (value.type === 'control_cancel_request') { cancelPermission(value.request_id); return; }
    if (value.type === 'control_response' && value.response?.request_id === 'fast-claude-initialize') {
      if (value.response.subtype !== 'success') { finish({ failure: value.response.error || 'Claude 初始化失败' }); return; }
      if (!promptStarted) {
        promptStarted = true;
        write({ type: 'user', session_id: nativeSessionId, message: { role: 'user', content: [{ type: 'text', text: task }] }, parent_tool_use_id: null });
      }
      return;
    }
    if (value.type === 'control_request' && validId(value.request_id)) {
      const request = value.request || {}, id = value.request_id;
      if (request.subtype !== 'can_use_tool') {
        write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: '客户端未提供此控制能力' } }); return;
      }
      const originalInput = request.input;
      if (typeof request.tool_name !== 'string' || !originalInput || typeof originalInput !== 'object' || Array.isArray(originalInput)) {
        denied('智能体审批动作格式无效，已拒绝');
        write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: '审批动作格式无效', toolUseID: request.tool_use_id } } }); return;
      }
      ask(id, request, {
        toolName: request.tool_name, toolUseId: request.tool_use_id, input: JSON.parse(JSON.stringify(originalInput)),
        title: clean(request.title || request.display_name || request.tool_name, 4000),
        reason: clean(request.decision_reason || request.description || '', 4000), decisionReasonType: request.decision_reason_type,
        forceHuman: request.requires_user_interaction === true || request.classifier_approvable === false || !!request.matched_ask_rule || request.decision_reason_type === 'rule',
        ...(request.matched_ask_rule ? { matchedAskRule: request.matched_ask_rule } : {}),
      }, (allow, reason) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: allow
        ? { behavior: 'allow', updatedInput: originalInput, toolUseID: request.tool_use_id }
        : { behavior: 'deny', message: reason || '工具请求未获批准', toolUseID: request.tool_use_id } } }));
      return;
    }
    parser.write(Buffer.from(JSON.stringify(value) + '\n'));
    if (value.type === 'result') finish();
  }
  function nativeDenial(output) {
    if (output && typeof output === 'object') {
      const code = output.code || output.kind || output.type || output.error?.code || output.error?.kind;
      if (['permission_denied', 'PERMISSION_DENIED', 'auto_mode_blocked'].includes(code)) return true;
    }
    const text = typeof output === 'string' ? output : typeof output?.error === 'string' ? output.error : output?.error?.message || output?.message || '';
    return /^(?:Denied by permission policy:|Auto mode blocked this action|Permission denied(?:[.:]|$))/i.test(text.trim());
  }
  function acp(value) {
    if (value.method === '$/cancel_request') { cancelPermission(value.params?.requestId ?? value.params?.id); return; }
    if (value.method === 'session/request_permission' && validId(value.id)) {
      const params = value.params || {}, id = value.id;
      const offered = Array.isArray(params.options) ? params.options : [];
      const allowOnce = offered.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
      const rejectOnce = offered.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
      const response = (allow, reason) => ({ jsonrpc: '2.0', id, result: { outcome: allow && allowOnce
        ? { outcome: 'selected', optionId: allowOnce.optionId }
        : rejectOnce ? { outcome: 'selected', optionId: rejectOnce.optionId } : { outcome: 'cancelled' } } });
      if (!promptStarted || params.sessionId !== nativeSessionId || !allowOnce) {
        denied(!allowOnce ? '智能体未提供仅本次批准选项，已拒绝持久授权' : '审批请求不属于当前智能体对话'); write(response(false)); return;
      }
      const call = { ...tools.get(params.toolCall?.toolCallId), ...params.toolCall }, meta = call._meta?.['x.ai/tool'] || {};
      const toolName = meta.name || call.name || call.kind || '工具', input = call.rawInput ?? meta.input;
      const hasInput = typeof input === 'string' ? input.trim().length > 0 : input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0;
      const hasString = names => names.some(name => typeof input?.[name] === 'string' && input[name].trim().length > 0);
      const missingCommand = typeof input === 'object' && /^(?:bash|shell|run_command|run_shell_command|execute_command|exec|execute)$/i.test(toolName) && !hasString(['command', 'cmd', 'script', 'code']);
      const missingPath = typeof input === 'object' && /^(?:write|write_file|write_to_file|create_file|edit|edit_file|delete_file|remove_file)$/i.test(toolName) && !hasString(['path', 'file_path', 'filePath', 'target_file', 'filename', 'absolute_path']);
      if (!hasInput || missingCommand || missingPath) {
        denied('智能体审批请求缺少完整工具输入，已拒绝；未猜测命令或文件路径'); write(response(false)); return;
      }
      ask(id, { ...params, toolCall: call }, {
        toolName, toolUseId: call.toolCallId, input: JSON.parse(JSON.stringify(input)),
        title: clean(call.title || meta.label || meta.name || '工具请求', 4000),
        reason: clean(params.description || '', 4000),
        forceHuman: params.requires_user_interaction === true || !!params.matched_ask_rule,
      }, response);
      return;
    }
    if (value.method === 'session/update') {
      if (!promptStarted || value.params?.sessionId !== nativeSessionId) return;
      const update = value.params?.update;
      if (!update) return;
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        const call = { ...tools.get(update.toolCallId), ...update }; tools.set(update.toolCallId, call);
        if (update.sessionUpdate === 'tool_call') emit('tool', clean((call.title || call.kind || '工具') + ' ' + JSON.stringify(call.rawInput || {}), 16000));
        if (update.status === 'failed') {
          const content = Array.isArray(update.content) ? update.content.map(item => item.content?.text || '').join('\n') : '';
          if (nativeDenial(update.rawOutput) || nativeDenial(content)) denied('工具请求被原生权限规则拒绝，任务未完整执行');
        }
      }
      parser.write(Buffer.from(JSON.stringify(value) + '\n')); return;
    }
    if (validId(value.id) && typeof value.method === 'string') {
      write({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: '客户端未提供此能力；文件和命令由智能体本身执行' } }); return;
    }
    const pending = validId(value.id) && requests.get(key(value.id));
    if (pending) {
      requests.delete(key(value.id));
      if (value.error) pending.reject(Error(clean(value.error.message || 'Grok 协议请求失败'))); else pending.resolve(value.result);
    }
  }
  function line(text) {
    if (!text.trim() || finished) return;
    let value;
    try { value = JSON.parse(text); } catch { emit('notice', clean(text, 16000)); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    try { if (agent === 'claude') claude(value); else acp(value); }
    catch (error) { finish({ failure: error.message }); }
  }
  function onData(chunk) {
    if (finished) return;
    buffer += decoder.write(chunk); let at;
    while (!finished && (at = buffer.indexOf('\n')) >= 0) {
      const value = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (value.length > 2 * 1024 * 1024) { finish({ failure: '智能体单条输出超过 2 MB' }); return; }
      line(value);
    }
    if (buffer.length > 2 * 1024 * 1024) finish({ failure: '智能体单条输出超过 2 MB' });
  }
  function onClose(code) {
    if (finished) return;
    buffer += decoder.end(); if (buffer) line(buffer);
    if (!finished) finish({ failure: '智能体进程在返回最终结果前结束' + (code ? `（退出码 ${code}）` : ''), exitCode: code });
  }
  function onError(error) { if (!finished) finish({ failure: error.message || String(error) }); }
  child.stdout.on('data', onData); child.stdout.on('error', onError);
  child.on('close', onClose); child.on('error', onError); child.stdin.on('error', onError);
  if (agent === 'claude') write({ type: 'control_request', request_id: 'fast-claude-initialize', request: { subtype: 'initialize' } });
  else (async () => {
    const initialized = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'codex-desktop-extensions', version: 'r4' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (initialized?.protocolVersion !== 1) throw Error('Grok 未提供兼容的 ACP v1 协议');
    let opened;
    if (nativeSessionId) {
      if (initialized.agentCapabilities?.loadSession) opened = await rpc('session/load', { sessionId: nativeSessionId, cwd, mcpServers: [] });
      else if (initialized.agentCapabilities?.sessionCapabilities?.resume) opened = await rpc('session/resume', { sessionId: nativeSessionId, cwd, mcpServers: [] });
      else throw Error('Grok 未提供恢复现有对话的协议；未创建替代对话');
    } else {
      opened = await rpc('session/new', { cwd, mcpServers: [] });
      if (typeof opened?.sessionId !== 'string' || !opened.sessionId) throw Error('Grok 未返回有效的对话标识');
      nativeSessionId = opened.sessionId;
    }
    if (opened?.sessionId && opened.sessionId !== nativeSessionId) throw Error('Grok 恢复了不同的对话；未发送请求');
    if (config.model) await rpc('session/set_model', { sessionId: nativeSessionId, modelId: config.model, ...(config.reasoningEffort ? { _meta: { reasoningEffort: config.reasoningEffort } } : {}) });
    promptStarted = true;
    const result = await rpc('session/prompt', { sessionId: nativeSessionId, prompt: [{ type: 'text', text: task }] });
    finish({ failure: result?.stopReason === 'end_turn' ? '' : 'Grok 未正常完成当前请求：' + String(result?.stopReason || '未提供结束原因') });
  })().catch(error => finish({ failure: error.message }));
  return { completion, dispose() { if (!finished) finish({ failure: '智能体审批会话已停止' }); else cleanup(); } };
}

module.exports = { attachApprovalSession };
