const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { invocation, validateAgentConfig, createParser } = require('../runtime/agent-cli.cjs');
const { attachApprovalSession } = require('../runtime/agent-approval-session.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(agent = 'claude', options = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const sent = [], events = [], actions = []; let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString('utf8'); let at;
    while ((at = input.indexOf('\n')) >= 0) { const line = input.slice(0, at); input = input.slice(at + 1); if (line) sent.push(JSON.parse(line)); }
  });
  const attachment = attachApprovalSession({ agent, child, task: 'Carry out the requested task', cwd: 'D:/fixture', config: {}, emit: (type, text) => events.push({ type, text }), requestPermission: async action => { actions.push(action); return { behavior: 'allow' }; }, ...options });
  const receive = value => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  function claudeReady() {
    const init = sent.find(value => value.type === 'control_request' && value.request.subtype === 'initialize');
    assert(init); receive({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: {} } });
    assert(sent.some(value => value.type === 'user'));
  }
  async function acpReady({ sessionId = 'native-acp-session', loadSession = true, sessionOptions = {} } = {}) {
    assert.equal(sent[0].method, 'initialize');
    receive({ jsonrpc: '2.0', id: sent[0].id, result: { protocolVersion: 1, agentCapabilities: { loadSession }, ...sessionOptions } });
    await tick();
    const opening = sent.at(-1); assert(['session/new', 'session/load', 'session/resume'].includes(opening.method));
    receive({ jsonrpc: '2.0', id: opening.id, result: { sessionId } }); await tick();
    return opening;
  }
  return { child, sent, events, actions, receive, attachment, claudeReady, acpReady };
}

test('invocation selects bidirectional permission protocols, keeps native defaults and never injects full access', () => {
  assert.equal(validateAgentConfig({}).approvalMode, 'native');
  assert.throws(() => validateAgentConfig({ approvalMode: 'bypassPermissions' }), /审批/);
  for (const approvalMode of ['native', 'auto', 'codex']) {
    const config = validateAgentConfig({ command: process.execPath, approvalMode, model: 'chosen', reasoningEffort: 'high' });
    const claude = invocation('claude', config, { sessionId: 'existing' });
    assert.equal(claude.protocol, 'claude-control'); assert.equal(claude.stdin, true);
    assert(claude.args.includes('--permission-prompt-tool=stdio'));
    assert.equal(claude.args[claude.args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(claude.args[claude.args.indexOf('--permission-prompts') + 1], 'host');
    assert.equal(claude.args[claude.args.indexOf('--resume') + 1], 'existing');
    if (approvalMode === 'native') assert(!claude.args.includes('--permission-mode'));
    else assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], approvalMode === 'auto' ? 'auto' : 'manual');
    const grok = invocation('grok', config, { taskFile: 'ignored.prompt', sessionId: 'existing' });
    assert.equal(grok.protocol, 'acp'); assert.equal(grok.stdin, true);
    assert(grok.args.indexOf('--model') < grok.args.indexOf('agent'));
    assert.deepEqual(grok.args.slice(-3), ['agent', '--no-leader', 'stdio']);
    assert(!grok.args.includes('--prompt-file')); assert(!grok.args.includes('--resume'));
    for (const args of [claude.args, grok.args]) assert(!args.some(arg => /dangerously-skip|always-approve|bypassPermissions/.test(arg)));
  }
});

test('Claude waits for one-shot approval while stdin stays open and echoes the original input', async () => {
  let settle;
  const f = fixture('claude', { requestPermission: action => { f.actions.push(action); return new Promise(resolve => { settle = resolve; }); } });
  f.claudeReady();
  const request = { type: 'control_request', request_id: 'native-request', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-1', input: { file_path: 'output.txt', content: 'exact content' }, decision_reason_type: 'mode' } };
  f.receive(request); f.receive(request); await tick();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].nativeDecision, 'ask'); assert.equal(f.child.stdin.writableEnded, false);
  settle({ behavior: 'allow', updatedInput: { file_path: 'elsewhere' } }); await tick();
  const response = f.sent.find(value => value.response?.request_id === 'native-request').response.response;
  assert.equal(response.behavior, 'allow'); assert.deepEqual(response.updatedInput, request.request.input); assert.equal(response.updatedPermissions, undefined);
  assert.equal(response.toolUseID, 'tool-1');
  f.receive(request); await tick(); assert.equal(f.sent.filter(value => value.response?.request_id === 'native-request').length, 1);
  f.receive({ type: 'result', subtype: 'success', session_id: 'claude-native-session', result: 'done' });
  const result = await f.attachment.completion;
  assert.equal(result.finalText, 'done'); assert.equal(result.sessionId, 'claude-native-session'); assert.equal(result.failure, '');
  assert.equal(f.child.stdin.writableEnded, true); f.attachment.dispose();
});

test('Claude rule-forced and person-only asks are flagged for human review', async () => {
  const f = fixture(); f.claudeReady();
  for (const [index, extra] of [{ matched_ask_rule: { source: 'user', tool_name: 'Write' } }, { classifier_approvable: false }, { requires_user_interaction: true }, { decision_reason_type: 'rule' }].entries()) {
    f.receive({ type: 'control_request', request_id: 'ask-' + index, request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-' + index, input: {}, ...extra } });
  }
  await tick(); assert.equal(f.actions.length, 4); assert(f.actions.every(action => action.forceHuman === true));
  f.receive({ type: 'result', subtype: 'success', result: 'done' }); await f.attachment.completion;
});

test('explicit native denials mark a failed result even when the CLI exits successfully', async () => {
  const f = fixture(); f.claudeReady();
  f.receive({ type: 'result', subtype: 'success', result: 'I could not write the file', permission_denials: [{ tool_name: 'Write', tool_use_id: 'blocked', tool_input: {} }] });
  const result = await f.attachment.completion;
  assert.equal(result.permissionDenied, true); assert.match(result.failure, /拒绝|批准/); assert.equal(f.actions.length, 0);
  const parser = createParser('claude', () => {}); parser.write(Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Write' }] }) + '\n'));
  assert.equal(parser.finish().permissionDenied, true);
});

test('cancelled permission requests abort their broker signal and never send a late allow', async () => {
  let settle;
  const f = fixture('claude', { requestPermission: action => { f.actions.push(action); return new Promise(resolve => { settle = resolve; }); } }); f.claudeReady();
  f.receive({ type: 'control_request', request_id: 'withdrawn', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-1', input: {} } }); await tick();
  f.receive({ type: 'control_cancel_request', request_id: 'withdrawn' });
  assert.equal(f.actions[0].signal.aborted, true); settle({ behavior: 'allow' }); await tick();
  assert(!f.sent.some(value => value.response?.request_id === 'withdrawn'));
  f.receive({ type: 'result', subtype: 'success', result: 'finished' }); await f.attachment.completion;
});

test('Grok ACP declines host execution and approves only the returned allow_once option', async () => {
  const f = fixture('grok');
  assert.deepEqual(f.sent[0].params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
  assert.equal(f.sent[0].params.clientCapabilities.terminal, false); assert(f.sent[0].params.clientInfo.name);
  await f.acpReady(); assert.equal(f.sent.at(-1).method, 'session/prompt');
  f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part ' } } } });
  f.receive({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'native-acp-session', toolCall: { toolCallId: 'grok-tool', kind: 'edit', title: 'Write output.txt', rawInput: { path: 'output.txt' }, _meta: { 'x.ai/tool': { name: 'write_file' } } }, options: [{ optionId: 'persistent', kind: 'allow_always' }, { optionId: 'specific-once-id', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } });
  await tick();
  const approved = f.sent.find(value => value.id === 'permission-1');
  assert.deepEqual(approved.result.outcome, { outcome: 'selected', optionId: 'specific-once-id' });
  assert.equal(f.actions[0].toolName, 'write_file'); assert.deepEqual(f.actions[0].input, { path: 'output.txt' });
  f.receive({ jsonrpc: '2.0', id: 'host-write', method: 'fs/write_text_file', params: { path: 'must-not-write', content: 'no' } });
  assert.equal(f.sent.find(value => value.id === 'host-write').error.code, -32601);
  f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
  const prompt = f.sent.find(value => value.method === 'session/prompt'); f.receive({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  const result = await f.attachment.completion; assert.equal(result.finalText, 'part done'); assert.equal(result.sessionId, 'native-acp-session'); assert.equal(result.failure, '');
});

test('Grok resumes the native session, ignores history replay and applies model and effort before prompting', async () => {
  const f = fixture('grok', { sessionId: 'existing-session', config: { model: 'chosen-model', reasoningEffort: 'high' } });
  const init = f.sent[0]; f.receive({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); await tick();
  const loading = f.sent.at(-1); assert.equal(loading.method, 'session/load'); assert.equal(loading.params.sessionId, 'existing-session');
  f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'existing-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } } } });
  f.receive({ jsonrpc: '2.0', id: loading.id, result: {} }); await tick();
  const model = f.sent.at(-1); assert.equal(model.method, 'session/set_model'); assert.equal(model.params.modelId, 'chosen-model'); assert.equal(model.params._meta.reasoningEffort, 'high');
  f.receive({ jsonrpc: '2.0', id: model.id, result: {} }); await tick();
  const prompt = f.sent.at(-1); assert.equal(prompt.method, 'session/prompt');
  f.receive({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  assert.equal((await f.attachment.completion).finalText, ''); assert(!f.events.some(event => event.text.includes('old history')));
});

test('Grok refuses persistent-only permissions and records native policy denial without retry', async () => {
  const f = fixture('grok'); await f.acpReady();
  f.receive({ jsonrpc: '2.0', id: 'only-persistent', method: 'session/request_permission', params: { sessionId: 'native-acp-session', toolCall: { toolCallId: 'tool-1', title: 'write file', rawInput: {} }, options: [{ optionId: 'persistent', kind: 'allow_always' }] } }); await tick();
  assert.deepEqual(f.sent.find(value => value.id === 'only-persistent').result.outcome, { outcome: 'cancelled' });
  f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-acp-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'blocked', status: 'failed', rawOutput: 'Denied by permission policy: Write' } } });
  const prompt = f.sent.find(value => value.method === 'session/prompt'); f.receive({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  const result = await f.attachment.completion; assert.equal(result.permissionDenied, true); assert(result.failure); assert.equal(f.sent.filter(value => value.method === 'session/prompt').length, 1);
});

test('Grok missing or incomplete tool input is rejected while complete cached input remains usable', async () => {
  const f = fixture('grok'); await f.acpReady();
  const permission = (id, toolCall) => ({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'native-acp-session', toolCall, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } });
  f.receive(permission('missing', { toolCallId: 'missing', title: 'write file', kind: 'edit' }));
  f.receive(permission('partial', { toolCallId: 'partial', kind: 'edit', rawInput: { content: 'missing target' } }));
  await tick(); assert.equal(f.actions.length, 0); assert(f.events.some(event => event.text.includes('缺少完整工具输入')));
  assert.equal(f.sent.find(value => value.id === 'missing').result.outcome.optionId, 'reject');
  assert.equal(f.sent.find(value => value.id === 'partial').result.outcome.optionId, 'reject');
  f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-acp-session', update: { sessionUpdate: 'tool_call', toolCallId: 'cached', kind: 'edit', rawInput: { path: 'exact.txt', content: 'actual content' }, _meta: { 'x.ai/tool': { name: 'write_file' } } } } });
  f.receive(permission('cached-permission', { toolCallId: 'cached', title: 'Write exact.txt' })); await tick();
  assert.equal(f.actions.length, 1); assert.deepEqual(f.actions[0].input, { path: 'exact.txt', content: 'actual content' });
  assert.equal(f.sent.find(value => value.id === 'cached-permission').result.outcome.optionId, 'once');
  const prompt = f.sent.find(value => value.method === 'session/prompt'); f.receive({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } }); await f.attachment.completion;
});

test('early process exit, invalid initialization and disposal always settle completion', async () => {
  const early = fixture(); early.child.emit('close', 0, null); assert.match((await early.attachment.completion).failure, /最终结果/);
  const failed = fixture('grok'); failed.receive({ jsonrpc: '2.0', id: failed.sent[0].id, error: { code: -32603, message: 'handshake failed' } }); assert.match((await failed.attachment.completion).failure, /handshake failed/);
  const stopped = fixture(); stopped.attachment.dispose(); assert((await stopped.attachment.completion).failure); assert.equal(stopped.child.stdin.writableEnded, true);
});
