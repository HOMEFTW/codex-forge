'use strict';
// Opt-in integration: real app-server + isolated CODEX_HOME + local model fixture.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn, execFileSync } = require('node:child_process'), { once } = require('node:events');
const readline = require('node:readline');
const { CollaborationBridge, createConversationCall } = require('../runtime/collaboration-bridge.cjs');
const { ThreadContexts } = require('../runtime/context.cjs');
const { request } = require('../runtime/collaboration-mcp.cjs');

test('connector sends, steers and reads real native history with an isolated local model', { skip: !process.env.FORGE_NATIVE_CODEX, timeout: 60000 }, async t => {
  const output = path.resolve(__dirname, '../output'); fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'forge-native-agent-')), modelRequests = [], waitingResponses = [];
  let release = false;
  const complete = response => {
    if (response.destroyed) return;
    const item = { id: 'msg-fixture-' + modelRequests.length, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '本机模型测试回复', annotations: [] }], status: 'completed' };
    const event = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: '本机模型测试回复' });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'resp-local-' + modelRequests.length, object: 'response', model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } }); response.end();
  };
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
    modelRequests.push(JSON.parse(Buffer.concat(parts).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp-local-' + modelRequests.length, status: 'in_progress' } }) + '\n\n');
    if (release) complete(res); else waitingResponses.push(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const child = spawn(process.env.FORGE_NATIVE_CODEX, ['app-server', '--listen', 'stdio://'], { cwd: root, env: { ...process.env, CODEX_HOME: root }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, stderr = '', bridge; const pending = new Map(), notifications = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error('Native timeout: ' + method + '\n' + stderr.slice(-2000))); }, 20000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line), waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(Error(JSON.stringify(value.error))) : waiter.resolve(value.result); }
    else if (value.method) notifications.push(value);
  });
  t.after(async () => {
    await bridge?.dispose(); for (const waiter of pending.values()) clearTimeout(waiter.timer);
    if (child.exitCode === null && child.signalCode === null) {
      // EOF lets app-server finish its background tasks before removing its cwd.
      const closed = once(child, 'close'), timer = setTimeout(() => child.kill(), 5000);
      child.stdin.end(); try { await closed; } finally { clearTimeout(timer); }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      // Native Windows sandbox setup can make Node's recursive removal fail;
      // use LiteralPath, with the exact fixture parent checked inside one shell.
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$target = [IO.Path]::GetFullPath($env:FORGE_NATIVE_TEST_ROOT); $parent = [IO.Path]::GetFullPath($env:FORGE_NATIVE_TEST_PARENT); if ((Split-Path $target -Parent) -ne $parent -or (Split-Path $target -Leaf) -notlike "forge-native-agent-*") { throw "Unexpected fixture path" }; Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop'],
      { windowsHide: true, env: { ...process.env, FORGE_NATIVE_TEST_ROOT: root, FORGE_NATIVE_TEST_PARENT: output }, stdio: 'pipe' });
    }
  });
  await call('initialize', { clientInfo: { name: 'forge_agent_integration', version: '1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const started = await call('thread/start', { cwd: root, model: 'fixture', modelProvider: 'fixture', approvalPolicy: 'never' });
  const threadId = started.thread.id, user = { threadId, source: 'host', trusted: true };
  const state = { threadId, bridge: {}, win: { isDestroyed: () => false } };
  bridge = new CollaborationBridge({ root, enabled: () => true, nodePath: process.execPath,
    call: createConversationCall({ states: new Map([[1, state]]), contexts: new ThreadContexts(root), nativeCall: (_state, method, args) => call(method, args) }) });
  await bridge.manage('access_grant', { access: 'send' }, user); await bridge.manage('access_enabled', { enabled: true }, user);
  const sent = await request(root, 'forge_conversation_send', { threadId, sender: 'native fixture', text: '初始测试任务', requestId: 'native-start' });
  assert.equal(sent.accepted, true); const turnId = sent.result.turn.id;
  const steered = await request(root, 'forge_conversation_steer', { threadId, sender: 'native fixture', text: '追加测试指令', requestId: 'native-steer', expectedTurnId: turnId }); assert.equal(steered.accepted, true);
  release = true; for (const response of waitingResponses) complete(response);
  const deadline = Date.now() + 15000;
  while (!notifications.some(event => event.method === 'turn/completed' && event.params.turn.id === turnId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const completed = notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === turnId);
  assert.equal(completed?.params.turn.status, 'completed', JSON.stringify(completed) + stderr.slice(-1500)); assert(modelRequests.length > 0);
  const history = await request(root, 'forge_conversation_items', { threadId, turnId, limit: 100 });
  assert.match(JSON.stringify(history), /初始测试任务/); assert.match(JSON.stringify(history), /追加测试指令/); assert.match(JSON.stringify(history), /本机模型测试回复/);
  const read = await request(root, 'forge_conversation_read', { threadId }); assert.equal(read.turns[0].id, turnId);
  await assert.rejects(request(root, 'forge_conversation_steer', { threadId, sender: 'fixture', text: '过期指令', requestId: 'stale-steer', expectedTurnId: turnId }));
});
