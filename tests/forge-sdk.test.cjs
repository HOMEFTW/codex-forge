const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSdk() {
  const listeners = new Map();
  const messages = [];
  const parent = { postMessage(message) { messages.push(message); } };
  const window = {
    parent,
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  const sandbox = { window, parent, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'forge-sdk.js'), 'utf8'), sandbox);
  const message = data => listeners.get('message')({ source: parent, data });
  const reply = (method, result) => {
    const item = messages.filter(entry => entry.forgePluginRequest.method === method).at(-1);
    return message({ forgePluginReply: { id: item.forgePluginRequest.id, result } });
  };
  const replyLast = result => message({ forgePluginReply: { id: messages.at(-1).forgePluginRequest.id, result } });
  return { api: window.CodexForge, messages, message, reply, replyLast };
}

test('Forge SDK negotiates capability grants before context and correlates plugin events', async () => {
  const { api, messages, message, reply, replyLast } = loadSdk();
  assert.equal(messages[0].forgePluginRequest.method, 'capabilities.get', 'SDK asks for capability grants first');
  assert.equal(messages[1].forgePluginRequest.method, 'context.get');
  reply('capabilities.get', { denied: {} });
  reply('context.get', { threadId: 'thread-1', codexVersion: '26.1016.8622.0', forgeVersion: '0.1.0', apiVersion: 1 });

  const capabilitiesPromise = api.capabilities.get();
  const capabilities = { apiVersion: 1, codexVersion: '26.1016.8622.0', forgeVersion: '0.1.0', permissions: ['events'], capabilities: [], available: {}, denied: {}, events: ['plugin.event'], surfaces: [] };
  reply('capabilities.get', capabilities);
  assert.deepEqual(await capabilitiesPromise, capabilities);

  const seen = [];
  const remove = api.events.on('plugin.example.status', (value, metadata) => seen.push({ value, metadata }));
  message({ forgePluginEvent: { name: 'plugin.example.status', value: { ready: true }, metadata: { sourcePluginId: 'example.sender', threadId: 'thread-1' } } });
  assert.deepEqual(seen, [{ value: { ready: true }, metadata: { sourcePluginId: 'example.sender', threadId: 'thread-1' } }]);
  remove();

  const eventPromise = api.events.emit('plugin.example.status', { ready: true });
  assert.equal(messages.at(-1).forgePluginRequest.method, 'events.emit');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).forgePluginRequest.args)), { name: 'plugin.example.status', value: { ready: true } });
  replyLast({ accepted: true, name: 'plugin.example.status' });
  assert.deepEqual(await eventPromise, { accepted: true, name: 'plugin.example.status' });
});

test('Forge SDK rejects a denied method without sending it to the host', async () => {
  const { api, messages, reply } = loadSdk();
  reply('capabilities.get', { denied: { 'storage.get': '插件未声明能力 "storage"，无法调用 storage.get。请在 plugin.json 中加入 "capabilities": [{"name":"storage","version":1}]。' } });
  reply('context.get', { threadId: null, codexVersion: '26.1016.8622.0', forgeVersion: '0.1.0', apiVersion: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = messages.length;
  await assert.rejects(api.storage.get('key'), /未声明能力 "storage"/);
  assert.equal(messages.length, before, 'denied calls never reach the host');
});

test('Forge SDK rejects pending requests when the host disposes the plugin', async () => {
  const { api, replyLast, message } = loadSdk();
  replyLast({ threadId: null, codexVersion: '26.1016.8622.0', forgeVersion: '0.1.0', apiVersion: 1 });
  const pending = api.metadata.get();
  message({ forgePluginEvent: { name: 'dispose', value: null } });
  await assert.rejects(pending, /插件已停止/);
  await assert.rejects(api.capabilities.get(), /插件已停止/);
});
