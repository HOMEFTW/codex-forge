'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { CollaborationBridge, createConversationCall } = require('../runtime/collaboration-bridge.cjs');
const { CollaborationService } = require('../runtime/collaboration.cjs');
const { ThreadContexts } = require('../runtime/context.cjs');
const { request, tools } = require('../runtime/collaboration-mcp.cjs');
const user = { trusted: true, source: 'host', threadId: 'thread-a' };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-'));
  const calls = [], state = { threadId: 'thread-a', bridge: {}, win: { isDestroyed: () => false } };
  const contexts = new ThreadContexts(root), threads = new Map(['thread-a', 'thread-b'].map(id => [id, { id, name: id + ' 标题', cwd: root, status: { type: 'idle' } }]));
  let pluginEnabled = true, activeTurn = 'turn-1';
  const nativeCall = async (_state, method, args, options) => {
    calls.push({ method, args, options });
    if (overrides.call) { const value = await overrides.call(method, args, options); if (value !== undefined) return value; }
    if (method === 'thread/loaded/list') return { data: [...threads.values()].filter(thread => thread.status.type !== 'notLoaded').map(thread => thread.id), nextCursor: null };
    const thread = threads.get(args.threadId); if (!thread) throw Error('thread not found');
    if (method === 'thread/read') return { thread: { ...thread } };
    if (method === 'thread/resume') { thread.status = { type: 'idle' }; return { thread }; }
    if (method === 'thread/turns/list') return { data: [{ id: args.cursor || activeTurn, itemsView: 'summary', status: 'inProgress', items: [{ type: 'agentMessage', text: '摘要' }] }], nextCursor: args.cursor ? null : 'turn-older' };
    if (method === 'thread/items/list') return { data: [{ turnId: activeTurn, item: { type: 'agentMessage', text: args.cursor ? '第二页完整内容' : '第一页完整内容' } }], nextCursor: args.cursor ? null : 'items-2' };
    if (method === 'turn/steer') { if (args.expectedTurnId !== activeTurn) throw Error('turn changed'); return { turnId: activeTurn }; }
    if (method === 'turn/start') { thread.status = { type: 'active' }; return { turn: { id: activeTurn, status: 'inProgress' } }; }
    throw Error('unexpected native method ' + method);
  };
  const call = createConversationCall({ states: new Map([[1, state]]), nativeCall, contexts });
  const bridge = new CollaborationBridge({ root, call, enabled: () => pluginEnabled, nodePath: process.execPath });
  t.after(async () => { await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, calls, bridge, threads, contexts, state, nativeCall,
    enable: async (access = 'send') => { await bridge.manage('access_grant', { access }, user); await bridge.manage('access_enabled', { enabled: true }, user); },
    disablePlugin: async () => { pluginEnabled = false; await bridge.sync(); },
    send: (extra = {}) => request(root, 'forge_conversation_send', { threadId: 'thread-a', sender: 'Claude Code', text: '修复完成，请检查', requestId: 'request-1', ...extra }),
    setTurn: id => { activeTurn = id; } };
}

test('external access defaults off, is host managed and does not inherit delegation authorization', async t => {
  const f = fixture(t); await f.bridge.sync(); assert.equal(f.bridge.broker, null);
  const service = new CollaborationService({ root: path.join(f.root, 'jobs') }); service.bridge = f.bridge;
  await assert.rejects(service.dispatch('access_enabled', { enabled: true }, { source: 'plugin', threadId: 'thread-a' }), /真实用户操作/);
  await assert.rejects(f.bridge.manage('access_grant', { threadId: 'thread-b', access: 'send' }, user), { code: 'PERMISSION_DENIED' });
  await assert.rejects(f.send(), { code: 'HOST_UNAVAILABLE' });
  await f.enable(); assert.equal((await service.dispatch('thread', {}, user)).enabled, false);
  assert.equal((await service.dispatch('access_snapshot', {}, user)).running, true);
  assert.equal(service.store.jobs('thread-a').length, 0);
});

test('loopback token, scoped list and complete paginated history through real connector HTTP', async t => {
  const f = fixture(t); await f.enable('read');
  const connection = JSON.parse(fs.readFileSync(path.join(f.root, 'collaboration-broker.json')));
  assert.equal(f.bridge.broker.server.address().address, '127.0.0.1');
  const denied = await fetch(`http://127.0.0.1:${connection.port}/tools/call`, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
  const list = await request(f.root, 'forge_conversations_list', {}); assert.deepEqual(list.data.map(item => item.id), ['thread-a']);
  const first = await request(f.root, 'forge_conversation_read', { threadId: 'thread-a', limit: 1 });
  assert.equal(first.thread.title, 'thread-a 标题'); assert.equal(first.nextCursor, 'turn-older');
  const older = await request(f.root, 'forge_conversation_read', { threadId: 'thread-a', cursor: first.nextCursor }); assert.equal(older.turns[0].id, 'turn-older');
  const items = await request(f.root, 'forge_conversation_items', { threadId: 'thread-a', turnId: 'turn-1', limit: 1 });
  const next = await request(f.root, 'forge_conversation_items', { threadId: 'thread-a', cursor: items.nextCursor }); assert.equal(next.data[0].item.text, '第二页完整内容'); assert.equal(next.nextCursor, null);
  const before = f.calls.length;
  await assert.rejects(request(f.root, 'forge_conversation_read', { threadId: 'thread-b' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(f.send(), { code: 'PERMISSION_DENIED' }); assert.equal(f.calls.length, before);
  await assert.rejects(request(f.root, 'forge_conversation_items', { threadId: 'thread-a', limit: 0 }), /limit/);
});

test('send rehydrates inactive threads, preserves native permissions, labels input and deduplicates requests', async t => {
  const f = fixture(t); f.threads.get('thread-a').status = { type: 'notLoaded' }; await f.enable();
  const args = { approvalPolicy: 'never', model: 'malicious-model' };
  const [first, second] = await Promise.all([f.send(args), f.send(args)]); assert.deepEqual(first, second); assert.equal(first.accepted, true);
  assert.deepEqual(await request(f.root, 'forge_conversation_send', { requestId: 'request-1', text: '修复完成，请检查', sender: 'Claude Code', threadId: 'thread-a' }), first, 'JSON property order does not affect deduplication');
  const sends = f.calls.filter(call => call.method === 'turn/start'); assert.equal(sends.length, 1);
  assert.equal(sends[0].args.approvalPolicy, undefined); assert.equal(sends[0].args.model, undefined);
  assert.equal(sends[0].args.turnTrigger, 'forge_external_agent'); assert.match(sends[0].args.input[0].text, /外部智能体：Claude Code/);
  const resumed = f.calls.find(call => call.method === 'thread/resume'); assert.equal(resumed.args.excludeTurns, true);
  const token = resumed.args.config['mcp_servers.fast_canvas.env.CODEX_FAST_CONTEXT_TOKEN']; assert.equal(f.contexts.resolve(token).threadId, 'thread-a');
  await assert.rejects(f.send({ ...args, text: 'another' }), { code: 'CONFLICT' });
  const steer = await request(f.root, 'forge_conversation_steer', { threadId: 'thread-a', sender: 'Grok', text: '补充要求', requestId: 'steer-1', expectedTurnId: 'turn-1' }); assert.equal(steer.result.turnId, 'turn-1');
  f.setTurn('turn-2'); await assert.rejects(request(f.root, 'forge_conversation_steer', { threadId: 'thread-a', sender: 'Grok', text: '旧要求', requestId: 'steer-2', expectedTurnId: 'turn-1' }), /turn changed/);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('revocation during native resume prevents a pending send from being dispatched', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { call: async method => { if (method === 'thread/resume') { entered(); await new Promise(resolve => { release = resolve; }); } } });
  f.threads.get('thread-a').status = { type: 'notLoaded' };
  await f.enable(); const sending = f.send(); sending.catch(() => {}); await started;
  await f.bridge.manage('access_revoke', { threadId: 'thread-a' }, user); release();
  await assert.rejects(sending, /授权/); assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  assert.deepEqual((await request(f.root, 'forge_conversations_list', {})).data, []);
});

test('a fresh loaded conversation can receive its first message without a persisted rollout', async t => {
  const f = fixture(t, { call: async method => { if (method === 'thread/read' || method === 'thread/resume') throw Error('rollout is empty'); } });
  await f.enable(); assert.equal((await f.send()).accepted, true);
  assert.equal(f.calls.some(call => ['thread/read', 'thread/resume'].includes(call.method)), false);
});

test('plugin disable closes discovery and persisted grants work after a host restart', async t => {
  const f = fixture(t); await f.enable(); const oldToken = f.bridge.broker.token;
  const other = new CollaborationBridge({ root: f.root, call: async () => ({ thread: f.threads.get('thread-a') }), enabled: () => true, nodePath: process.execPath });
  t.after(() => other.dispose()); await other.sync(); assert.notEqual(other.broker.token, oldToken);
  await f.disablePlugin(); assert.equal(fs.existsSync(other.broker.file), true, 'older host cannot delete a newer connection');
  assert.equal((await request(f.root, 'forge_conversations_list', {})).data.length, 1);
  await other.manage('access_enabled', { enabled: false }, user); await assert.rejects(f.send(), { code: 'HOST_UNAVAILABLE' });
});

test('real Forge host owns connector lifecycle and plugin disable revokes it', async t => {
  const f = fixture(t), originalLoad = Module._load, previous = process.env.CODEX_FORGE_HOME;
  const collaboration = new CollaborationService({ root: path.join(f.root, 'collaboration') }); let host;
  process.env.CODEX_FORGE_HOME = f.root;
  Module._load = function(name, ...args) { return name === 'electron' ? {} : originalLoad.call(this, name, ...args); };
  try { host = require('../runtime/forge-host.cjs').installForge({ ipcMain: { handle() {} }, host: () => f.state, threadContext: () => user, states: new Map([[1, f.state]]), collaboration, notify() {}, open() {}, nodePath: process.execPath, services: { agentCall: f.bridge.call } }); }
  finally { Module._load = originalLoad; if (previous === undefined) delete process.env.CODEX_FORGE_HOME; else process.env.CODEX_FORGE_HOME = previous; }
  t.after(() => host.dispose());
  await collaboration.dispatch('access_grant', { access: 'send' }, user); await collaboration.dispatch('access_enabled', { enabled: true }, user);
  assert.equal((await f.send()).accepted, true);
  await host.management({}, 'enable', { id: 'forge.collaboration', enabled: false }); await host.agentBridge.sync();
  await assert.rejects(f.send(), { code: 'HOST_UNAVAILABLE' });
});

function mcp(t, root) {
  const entry = process.env.FORGE_CONNECTOR_TEST_ENTRY || path.join(__dirname, '../runtime/collaboration-mcp.cjs'), file = path.join(root, 'agent', 'mcp.json');
  const installed = spawnSync(process.execPath, [entry, '--home', root, '--install', file], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(installed.status, 0, installed.stderr);
  const config = JSON.parse(fs.readFileSync(file)).mcpServers.codex_forge;
  const child = spawn(config.command, config.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const msg = JSON.parse(line); const waiter = pending.get(msg.id); if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); waiter.resolve(msg); } });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { const exit = once(child, 'exit'); child.stdin.end(); await exit; assert.equal(stderr, ''); for (const waiter of pending.values()) clearTimeout(waiter.timer); });
  return { async call(method, params) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('MCP timeout: ' + stderr)), 10000); pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }, notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } };
}
test('standalone MCP process initializes, discovers tools, reads and sends through the host', async t => {
  const f = fixture(t); await f.enable(); const client = mcp(t, f.root);
  const init = await client.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' } }); assert.equal(init.result.protocolVersion, '2025-06-18');
  client.notify('notifications/initialized'); assert.equal((await client.call('tools/list')).result.tools.length, tools.length);
  const list = await client.call('tools/call', { name: 'forge_conversations_list', arguments: {} }); assert.equal(list.result.structuredContent.data[0].id, 'thread-a');
  const sent = await client.call('tools/call', { name: 'forge_conversation_send', arguments: { threadId: 'thread-a', text: '来自独立 MCP', sender: 'fixture', requestId: 'mcp-1' } }); assert.equal(sent.result.structuredContent.accepted, true);
  await f.bridge.manage('access_revoke', { threadId: 'thread-a' }, user);
  const denied = await client.call('tools/call', { name: 'forge_conversation_read', arguments: { threadId: 'thread-a' } }); assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /PERMISSION_DENIED/);
});

test('native preload routes external access settings only from the collaboration or settings page', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../runtime/host-preload.cjs'), 'utf8'), end = source.lastIndexOf('})();');
  const listeners = new Map(), calls = [], replies = [];
  const sandbox = { window: { addEventListener(name, handler) { listeners.set(name, handler); } }, require: () => ({ ipcRenderer: { on() {}, async invoke(channel, args) { calls.push({ channel, args }); return { enabled: false }; } } }) };
  vm.runInNewContext(source.slice(0, end) + 'globalThis.testFrames = frames;' + source.slice(end), sandbox);
  const frame = { isConnected: true, contentWindow: { postMessage: value => replies.push(value) } }, info = { page: 'collaboration' };
  sandbox.testFrames.set(frame, info);
  const send = () => listeners.get('message')({ source: frame.contentWindow, origin: 'null', data: { fastCanvasRequest: { id: 1, method: 'collaboration', args: { method: 'access_grant', threadId: 'thread-a', args: { access: 'read' } } } } });
  await send(); assert.equal(calls[0].channel, 'fast-ext:collaboration-native'); assert.equal(calls[0].args.threadId, 'thread-a');
  info.page = 'forge-settings'; await send(); assert.equal(calls.length, 2);
  info.page = 'canvas'; await send(); assert.equal(calls.length, 2); assert.match(replies.at(-1).error, /协作页面/);
});
