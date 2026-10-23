const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('native composer creates real threads, routes external text once, rejects stale UI, and leaves Codex transport intact', async t => {
  const output = path.resolve(__dirname, '../output/composer-routing-tests'); fs.mkdirSync(output, { recursive: true }); const root = fs.mkdtempSync(path.join(output, 'case-'));
  const app = new EventEmitter(), handlers = new Map(), sent = [], forwarded = [];
  const win = new EventEmitter(); win.id = 1; win.isDestroyed = () => false;
  win.webContents = { id: 1, getURL: () => 'app://-/index.html', mainFrame: { processId: 20, routingId: 1 }, send: (...args) => sent.push(args) };
  class MenuItem { constructor(options) { Object.assign(this, options); } }
  const fake = { app, BrowserWindow: { fromWebContents: () => win, getAllWindows: () => [win], getFocusedWindow: () => win }, ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) }, Menu: { setApplicationMenu() {}, getApplicationMenu() {} }, MenuItem, dialog: {}, shell: {} };
  const oldLoad = Module._load, oldRoot = process.env.CODEX_FAST_CANVAS_DIR; let services;
  const oldForgeRoot=process.env.CODEX_FORGE_HOME;process.env.CODEX_FORGE_HOME=path.join(root,'forge');t.after(()=>{if(oldForgeRoot===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=oldForgeRoot;});
 process.env.CODEX_FAST_CANVAS_DIR = root; Module._load = function(name, ...args) { return name === 'electron' ? fake : oldLoad.call(this, name, ...args); };
  const event = { sender: win.webContents, senderFrame: { processId: 20, routingId: 1 } };
  try {
    services = require('../runtime/main.cjs').install(); app.emit('web-contents-created', null, win.webContents);
    fake.ipcMain.handle('codex_desktop:message-from-view', async (_event, message) => {
      forwarded.push(message);
      if (message.request?.method === 'thread/start') win.webContents.send('codex_desktop:message-for-view', { type: 'mcp-response', hostId: 'local', message: { id: message.request.id, result: { thread: { id: 'real-native-thread', cwd: root } } } });
      if (message.request?.id.startsWith('fast-history-')) win.webContents.send('codex_desktop:message-for-view', { type: 'mcp-response', hostId: 'local', message: { id: message.request.id, result: message.request.method === 'thread/read' ? { thread: { id: message.request.params.threadId, cwd: root } } : {} } });
      return 'native-handler';
    });
    const submit = message => handlers.get('codex_desktop:message-from-view')(event, message);
    const native = (method, args, threadId) => handlers.get('fast-ext:collaboration-native')(event, { method, args, threadId });
    const overview = () => handlers.get('fast-ext:overview')(event);
    const fixture = path.join(root, 'agent fixture.cjs');
    fs.copyFileSync(path.join(__dirname, 'fixtures/agent.cjs'), fixture);
    await services.collaboration.dispatch('configure', { agents: Object.fromEntries(['claude', 'grok'].map(agent => [agent, { command: process.execPath, args: [fixture, '--fixture-agent=' + agent, '--fixture-prefix=external:'] }])) }, { trusted: true, source: 'host' });
    assert.deepEqual((await overview()).composerTarget, { agent: 'codex', model: '', reasoningEffort: '' });
    await native('composer_target', { agent: 'grok' }, null);
    assert.equal(await submit({ type: 'mcp-request', hostId: 'local', request: { id: 'create-1', method: 'thread/start', params: { cwd: root } } }), 'native-handler');
    await submit({ type: 'remote-hosted-pip-active-thread-changed', conversationId: 'real-native-thread' });
    assert.equal((await overview()).threadId, 'real-native-thread'); assert.equal((await overview()).composerTarget.agent, 'grok');
    await assert.rejects(native('composer_target', { agent: 'claude' }, null), /当前对话已变化/);
    await assert.rejects(handlers.get('fast-ext:canvas')(event, { method: 'collaboration', args: { method: 'set_thread', args: { enabled: true } } }), /原生客户端协作入口/);
    await assert.rejects(handlers.get('fast-ext:collaboration-native')({ ...event, senderFrame: { processId: 20, routingId: 2 } }, { method: 'set_thread', args: { enabled: true } }), /Untrusted/);
    const turn = { type: 'mcp-request', hostId: 'local', request: { id: 'external-turn', method: 'turn/start', params: { threadId: 'real-native-thread', clientUserMessageId: 'same-message', input: [{ type: 'text', text: 'hello external' }] } } };
    assert.equal(await submit({ ...turn, hostId: 'remote-host' }), 'native-handler'); assert.equal(services.collaboration.store.jobs('real-native-thread').length, 0, 'remote-host requests bypass all local routing');
    const before = forwarded.length; await submit(turn); await submit(turn);
    assert.equal(forwarded.filter(message => message.hostId === 'local' && message.request?.method === 'turn/start').length, 0, 'external turn never reaches the Codex app-server handler');
    const response = sent.filter(([channel, message]) => channel === 'codex_desktop:message-for-view' && message.message?.id === 'external-turn').at(-1)[1];
    assert.equal(response.message.result.turn.status, 'completed');
    const jobs = services.collaboration.store.jobs('real-native-thread'); assert.equal(jobs.length, 1); assert.equal(jobs[0].task, 'hello external'); assert.equal(jobs[0].cwd, root);
    const result = await services.collaboration.dispatch('wait', { jobId: jobs[0].id, waitMs: 10000 }, { threadId: 'real-native-thread' }); assert.equal(result.status, 'completed'); assert.match(result.finalText, /^external:hello external/);
    await submit({ type: 'remote-hosted-pip-active-thread-changed', conversationId: null }); assert.equal((await overview()).composerTarget.agent, 'codex', 'a fresh chat defaults to Codex after an external draft was used');
    await submit({ type: 'remote-hosted-pip-active-thread-changed', conversationId: 'real-native-thread' }); assert.equal((await overview()).composerTarget.agent, 'grok');
    await native('composer_target', { agent: 'grok', reasoningEffort: 'invented' }, 'real-native-thread');
    const beforeFailure = forwarded.length;
    await submit({ ...turn, request: { ...turn.request, id: 'bad-external', params: { ...turn.request.params, clientUserMessageId: 'bad-message' } } });
    const failure = sent.filter(([, message]) => message?.message?.id === 'bad-external').at(-1)[1]; assert.match(failure.message.error.message, /未声明/); assert.equal(forwarded.filter(message => message.hostId === 'local' && message.request?.method === 'turn/start').length, 0);
    await native('composer_target', { agent: 'codex' }, 'real-native-thread');
    assert.equal(await submit({ ...turn, request: { ...turn.request, id: 'codex-turn' } }), 'native-handler'); assert.equal(forwarded.at(-1).request.id, 'codex-turn');
    await submit({ type: 'remote-hosted-pip-active-thread-changed', conversationId: 'unrelated-existing-thread' }); assert.equal((await overview()).composerTarget.agent, 'codex');
    await native('composer_target', { agent: 'claude' }, 'unrelated-existing-thread');
    await submit({ type: 'remote-hosted-pip-active-thread-changed', conversationId: 'real-native-thread' }); assert.equal((await overview()).composerTarget.agent, 'codex');
  } finally {
    if (services) for (const thread of services.collaboration.store.threads()) for (const job of services.collaboration.store.jobs(thread.id)) if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) services.collaboration.store.cancel(job.id);
    app.emit('will-quit'); Module._load = oldLoad; if (oldRoot === undefined) delete process.env.CODEX_FAST_CANVAS_DIR; else process.env.CODEX_FAST_CANVAS_DIR = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
