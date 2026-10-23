'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { dshInvocation, attachDshApprovalSession } = require('../runtime/dsh-approval-session.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const modelOptions = () => [
  { id: 'model', category: 'model', type: 'select', currentValue: '["official","small"]', options: [{ group: 'official', name: 'Official', options: [{ value: '["official","small"]', name: 'Small' }, { value: '["official","large"]', name: 'Large' }] }] },
  { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
function setup(t, { onPrompt, onFrame, permission, config = {}, resume = '', initialize = {}, responseOptions = modelOptions() } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const frames = [], events = [], actions = [], ready = deferred();
  let buffer = '', prompt;
  const send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
  const reply = (frame, result) => send({ jsonrpc: '2.0', id: frame.id, result });
  const update = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: resume || 'dsh-session', update } });
  const done = text => { if (text) update({ sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text } }); reply(prompt, { stopReason: 'end_turn' }); };
  child.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); frames.push(frame);
      onFrame?.(frame, { send, reply, update, done });
      if (frame.method === 'initialize') reply(frame, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, ...initialize });
      else if (frame.method === 'session/new') reply(frame, { sessionId: 'dsh-session', configOptions: responseOptions });
      else if (frame.method === 'session/resume') reply(frame, { configOptions: responseOptions });
      else if (frame.method === 'session/set_config_option') reply(frame, { configOptions: responseOptions });
      else if (frame.method === 'session/prompt') { prompt = frame; ready.resolve(); onPrompt?.({ send, reply, update, done, prompt }); }
      else if (frame.method === 'session/close') reply(frame, {});
    }
  });
  const session = attachDshApprovalSession({ child, task: '请修复中文 🦆', cwd: path.resolve(__dirname), config, sessionId: resume, emit: (type, text) => events.push({ type, text }), requestPermission: async action => { actions.push(action); return permission ? permission(action) : { behavior: 'deny', reason: 'not approved' }; } });
  t.after(() => { session.dispose(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return { child, frames, events, actions, ready: ready.promise, ...session, send, reply, update, done };
}
function ask(send, id = 'approval-1', extra = {}) {
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'dsh-session', toolCall: { toolCallId: 'call-1', title: 'pwsh', rawInput: { command: 'Get-Item requested' } }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Allow always' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }], ...extra } });
}

test('DSH invocation uses the native ACP profile and only a task-local selection overlay', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-invocation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const patchFile = path.join(directory, 'selection.json');
  const resolved = { command: 'node', prefix: ['/installed/dsh/lib/bin.js'], source: '/installed/dsh/lib/bin.js' };
  const command = dshInvocation({ args: [], profile: 'headless', provider: 'official', model: 'large', reasoningEffort: 'high' }, resolved, { patchFile });
  assert.deepEqual(command.args, ['/installed/dsh/lib/bin.js', '--profile', 'acp', '--patch', patchFile]);
  assert.equal(command.protocol, 'acp'); assert.equal(command.keepStdin, true); assert.equal(command.stdin, false);
  const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  assert.deepEqual(patch.find(row => row.id === 'acp').config, { provider: 'official', model: 'large' });
  assert.equal(patch.some(row => ['approval', 'sandbox', 'permission'].includes(row.id)), false);
  assert.deepEqual(fs.readdirSync(directory), ['selection.json']);
});

test('DSH invocation refuses destructive profile initialization and missing selection identity', () => {
  const resolved = { command: 'node', prefix: ['dsh.js'] };
  assert.throws(() => dshInvocation({ args: ['--from-default-profile', 'web'] }, resolved), /profile|配置/i);
  assert.throws(() => dshInvocation({ args: [], model: 'large' }, resolved), /provider|提供商/i);
});

test('default invocation reads the native default selection in its temporary overlay', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-default-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const patchFile = path.join(directory, 'run.json');
  dshInvocation({ args: [] }, { command: 'node', prefix: ['dsh.js'] }, { patchFile });
  const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  assert.equal(patch.length, 1);
  assert.deepEqual(patch[0].inject, ['acpAppStartup', 'agentDefaultModel']);
  assert.match(patch[0].config.model.__jsExpr, /currentSelection/);
  assert.equal(patch.some(row => row.id === 'agent-default-model'), false);
});

test('DSH handshake does not advertise host filesystem or terminal execution', async t => {
  const h = setup(t, { onPrompt: ({ done }) => done('完成') });
  const result = await h.completion;
  const init = h.frames.find(frame => frame.method === 'initialize');
  assert.deepEqual(init.params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
  assert.equal(init.params.clientCapabilities.terminal, false);
  assert.deepEqual(h.frames.find(frame => frame.method === 'session/new').params.mcpServers, []);
  assert.equal(h.frames.find(frame => frame.method === 'session/prompt').params.prompt[0].text, '请修复中文 🦆');
  assert.equal(result.finalText, '完成'); assert.equal(result.failure, ''); assert.equal(result.sessionId, 'dsh-session');
});

test('DSH remains suspended until the broker grants only its native allow_once option', async t => {
  const decision = deferred();
  const h = setup(t, { permission: () => decision.promise, onPrompt: ({ update, send }) => {
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'pwsh', rawInput: { command: 'Get-Item ../requested', sandbox_permissions: 'danger-full-access' } });
    ask(send, 'approval-1', { toolCall: { toolCallId: 'call-1' } });
  }, onFrame: (frame, { done }) => { if (frame.id === 'approval-1' && frame.result) done('approved result'); } });
  await h.ready; await tick();
  assert.equal(h.frames.some(frame => frame.id === 'approval-1'), false);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].toolName, 'pwsh');
  assert.equal(h.actions[0].nativeDecision, 'ask');
  assert.equal(h.actions[0].forceHuman, undefined);
  assert.deepEqual(h.actions[0].input, { command: 'Get-Item ../requested', sandbox_permissions: 'danger-full-access' });
  decision.resolve({ behavior: 'allow', reason: 'Codex approved this operation' });
  const result = await h.completion;
  assert.deepEqual(h.frames.find(frame => frame.id === 'approval-1').result, { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal(result.permissionDenied, false);
});

test('broker denial returns the native rejection and records permissionDenied', async t => {
  const h = setup(t, { onPrompt: ({ send }) => ask(send), onFrame: (frame, { done }) => { if (frame.id === 'approval-1' && frame.result) done('已停止操作'); } });
  const result = await h.completion;
  assert.deepEqual(h.frames.find(frame => frame.id === 'approval-1').result, { outcome: { outcome: 'selected', optionId: 'no' } });
  assert.equal(result.permissionDenied, true);
});

test('DSH cannot substitute allow_always when no allow_once was advertised', async t => {
  const h = setup(t, { permission: async () => ({ behavior: 'allow' }), onPrompt: ({ send }) => ask(send, 'approval-1', { options: [{ optionId: 'always', kind: 'allow_always' }] }), onFrame: (frame, { done }) => { if (frame.id === 'approval-1' && frame.result) done('not executed'); } });
  const result = await h.completion;
  assert.equal(h.actions.length, 0);
  assert.deepEqual(h.frames.find(frame => frame.id === 'approval-1').result, { outcome: { outcome: 'cancelled' } });
  assert.equal(result.permissionDenied, true);
});

test('a native hard-deny marker is never upgraded into an approvable action', async t => {
  const h = setup(t, { permission: async () => ({ behavior: 'allow' }), onPrompt: ({ send }) => ask(send, 'denied', { nativeDecision: 'deny' }), onFrame: (frame, { done }) => { if (frame.id === 'denied' && frame.result) done('denied'); } });
  assert.equal((await h.completion).permissionDenied, true);
  assert.equal(h.actions.length, 0);
  assert.equal(h.frames.find(frame => frame.id === 'denied').result.outcome.optionId, 'no');
});

test('a native forced-human annotation only raises the review requirement', async t => {
  const h = setup(t, { permission: async () => ({ behavior: 'allow' }), onPrompt: ({ send }) => ask(send, 'approval-1', { _meta: { forceHuman: true } }), onFrame: (frame, { done }) => { if (frame.id === 'approval-1' && frame.result) done('human-approved'); } });
  await h.completion;
  assert.equal(h.actions[0].forceHuman, true);
});

test('a permission request without complete rawInput is rejected before the broker', async t => {
  const h = setup(t, { permission: async () => ({ behavior: 'allow' }), onPrompt: ({ send }) => ask(send, 'incomplete', { toolCall: { toolCallId: 'missing', title: 'pwsh' } }), onFrame: (frame, { done }) => { if (frame.id === 'incomplete' && frame.result) done('not executed'); } });
  const result = await h.completion;
  assert.equal(h.actions.length, 0);
  assert.equal(h.frames.find(frame => frame.id === 'incomplete').result.outcome.optionId, 'no');
  assert.equal(result.permissionDenied, true);
  assert.ok(h.events.some(event => event.type === 'notice' && /rawInput|参数|不完整/.test(event.text)));
});

for (const method of ['$/cancel_request', '$/cancelRequest', 'notifications/cancelled']) test(method + ' withdraws only its pending approval and ignores a late grant', async t => {
  const decision = deferred();
  const h = setup(t, { permission: () => decision.promise, onPrompt: ({ send }) => ask(send) });
  await h.ready; await tick();
  h.send({ jsonrpc: '2.0', method, params: { requestId: 'approval-1' } });
  await tick();
  assert.equal(h.actions[0].signal.aborted, true);
  assert.equal(h.frames.find(frame => frame.id === 'approval-1').result.outcome.outcome, 'cancelled');
  decision.resolve({ behavior: 'allow' }); await tick(); h.done('withdrawn');
  await h.completion;
  assert.equal(h.frames.filter(frame => frame.id === 'approval-1').length, 1);
});

test('late broker approval after disposal cannot send a grant', async t => {
  const decision = deferred();
  const h = setup(t, { permission: () => decision.promise, onPrompt: ({ send }) => ask(send) });
  await h.ready; await tick(); h.dispose();
  decision.resolve({ behavior: 'allow' }); await tick();
  assert.equal(h.frames.filter(frame => frame.id === 'approval-1' && frame.result?.outcome?.optionId === 'once').length, 0);
  assert.match((await h.completion).failure, /停止|取消|closed|disposed/i);
});

test('DSH selects only advertised provider/model and reasoning values before prompting', async t => {
  const h = setup(t, { config: { provider: 'official', model: 'large', reasoningEffort: 'high' }, onPrompt: ({ done }) => done('done') });
  await h.completion;
  const selected = h.frames.filter(frame => frame.method === 'session/set_config_option');
  assert.deepEqual(selected.map(frame => frame.params), [
    { sessionId: 'dsh-session', configId: 'model', value: '["official","large"]' },
    { sessionId: 'dsh-session', configId: 'reasoning_effort', value: 'high' },
  ]);
  assert.ok(h.frames.indexOf(selected[1]) < h.frames.findIndex(frame => frame.method === 'session/prompt'));
});

test('unsupported reasoning or missing resume capability fails before sending a prompt', async t => {
  const effort = setup(t, { config: { reasoningEffort: 'ultra' } });
  assert.match((await effort.completion).failure, /思考|reason/i);
  assert.equal(effort.frames.some(frame => frame.method === 'session/prompt'), false);
  const resume = setup(t, { resume: 'existing', initialize: { agentCapabilities: {} } });
  assert.match((await resume.completion).failure, /续|resume/i);
  assert.equal(resume.frames.some(frame => frame.method === 'session/new'), false);
});

test('DSH resumes via native RPC without creating a replacement session', async t => {
  const h = setup(t, { resume: 'existing', onPrompt: ({ done }) => done('continued') });
  const result = await h.completion;
  assert.equal(h.frames.find(frame => frame.method === 'session/resume').params.sessionId, 'existing');
  assert.equal(h.frames.some(frame => frame.method === 'session/new'), false);
  assert.equal(result.finalText, 'continued');
  assert.equal(result.sessionId, 'existing');
});

test('cross-session permission requests and host execution calls never reach the broker', async t => {
  const h = setup(t, { onPrompt: ({ send }) => {
    ask(send, 'wrong-session', { sessionId: 'other' });
    send({ jsonrpc: '2.0', id: 'host-file', method: 'fs/write_text_file', params: { path: '/never', content: 'never' } });
  }, onFrame: (frame, { done }) => { if (frame.id === 'host-file' && frame.error) done('safe'); } });
  await h.completion;
  assert.equal(h.actions.length, 0);
  assert.equal(h.frames.find(frame => frame.id === 'wrong-session').result.outcome.outcome, 'cancelled');
  assert.equal(h.frames.find(frame => frame.id === 'host-file').error.code, -32601);
});

test('the final answer tracks the last committed message and preserves fragmented UTF-8', async t => {
  const h = setup(t, { onPrompt: ({ update, send, prompt }) => {
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'progress', content: { type: 'text', text: 'working' } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考' } });
    const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'dsh-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text: '最终 🦆' } } } }) + '\n');
    for (let at = 0; at < message.length; at += 3) h.child.stdout.write(message.subarray(at, at + 3));
    send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  } });
  const result = await h.completion;
  assert.equal(result.finalText, '最终 🦆'); assert.equal(result.finalTruncated, false);
  assert.ok(h.events.some(event => event.type === 'thinking' && event.text === '思考'));
});

test('native tool result text remains visible alongside its completed status', async t => {
  const h = setup(t, { onPrompt: ({ update, done }) => {
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read', rawInput: { path: 'source.txt' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '文件结果 🦆' } }] });
    done('done');
  } });
  await h.completion;
  assert.ok(h.events.some(event => event.type === 'tool' && event.text.includes('[completed]') && event.text.includes('文件结果 🦆')));
});

test('a large final answer is bounded and reports truncation', async t => {
  const text = 'x'.repeat(4 * 1024 * 1024 + 1);
  const h = setup(t, { onPrompt: ({ done }) => done(text) });
  const result = await h.completion;
  assert.equal(result.finalText.length, 4 * 1024 * 1024);
  assert.equal(result.finalTruncated, true);
});

test('RPC failure and process exit during approval settle without granting', async t => {
  const failed = setup(t, { onFrame: (frame, { send }) => { if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'native failure' } }); } });
  assert.match((await failed.completion).failure, /native failure/);
  const decision = deferred();
  const h = setup(t, { permission: () => decision.promise, onPrompt: ({ send }) => ask(send) });
  await h.ready; await tick(); h.child.emit('close', 7, null);
  const result = await h.completion;
  decision.resolve({ behavior: 'allow' }); await tick();
  assert.match(result.failure, /7|关闭|退出/);
  assert.equal(h.frames.some(frame => frame.id === 'approval-1' && frame.result?.outcome?.optionId === 'once'), false);
});
