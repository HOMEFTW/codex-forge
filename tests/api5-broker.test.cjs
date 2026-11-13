'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgePluginBroker, brokerRequest, alias } = require('../runtime/forge-api5-broker.cjs');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-broker-'));
  const tools = [{ name: 'test.plugin.echo', description: 'fixture', inputSchema: { type: 'object' } }];
  const broker = new ForgePluginBroker({ root, tools: () => tools, callTool: async (name, args, context) => ({ name, args, context }), contextFor: () => ({ threadId: 'host-thread', cwd: root }), ...overrides });
  t.after(async () => { await broker.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, broker, tools };
}
test('API5 loopback broker authenticates discovery and binds tool calls to host context', async t => {
  const f = fixture(t); await f.broker.start();
  const connection = JSON.parse(fs.readFileSync(f.broker.file));
  const denied = await fetch(`http://127.0.0.1:${connection.port}/tools/list`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 403);
  const listed = await brokerRequest(f.root, 'list'); assert.equal(listed[0].name, alias(f.tools[0].name));
  assert.match(listed[0].name, /^[A-Za-z0-9_-]{1,64}$/);
  const value = await brokerRequest(f.root, 'call', { name: listed[0].name, args: { n: 1 }, context: { threadId: 'forged' } });
  assert.equal(value.context.threadId, 'host-thread'); assert.equal(value.name, f.tools[0].name);
  assert.deepEqual(value.args, { n: 1 });
});
test('API5 broker rejects stale aliases after a tool is revoked', async t => {
  const f = fixture(t); await f.broker.start();
  const name = (await brokerRequest(f.root, 'list'))[0].name;
  f.tools.length = 0;
  assert.deepEqual(await brokerRequest(f.root, 'list'), []);
  await assert.rejects(brokerRequest(f.root, 'call', { name, args: {} }), { code: 'METHOD_NOT_FOUND' });
});
test('API5 broker bounds tool results and request bodies on the actual HTTP route', async t => {
  const f = fixture(t, { callTool: async () => 'x'.repeat(3 * 1024 * 1024) }); await f.broker.start();
  const name = alias(f.tools[0].name);
  await assert.rejects(brokerRequest(f.root, 'call', { name }), { code: 'RESOURCE_EXHAUSTED' });
  await assert.rejects(brokerRequest(f.root, 'call', { name, args: { text: 'x'.repeat(2 * 1024 * 1024) } }), { code: 'RESOURCE_EXHAUSTED' });
});
test('API5 broker shutdown cancels active tools and removes only its own connection file', async t => {
  let aborted = false, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { callTool: (name, args, context, { signal }) => new Promise((resolve, reject) => { entered(); signal.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')); }, { once: true }); }) });
  await f.broker.start();
  const pending = brokerRequest(f.root, 'call', { name: alias(f.tools[0].name) });
  pending.catch(() => {}); await started; await f.broker.dispose(); await assert.rejects(pending);
  assert.equal(aborted, true); assert.equal(fs.existsSync(f.broker.file), false);
});
test('API5 broker preserves a newer host connection record when the older host stops', async t => {
  const f = fixture(t); await f.broker.start();
  const second = new ForgePluginBroker({ root: f.root, tools: () => [], callTool: async () => null });
  t.after(() => second.dispose()); await second.start(); await f.broker.dispose();
  assert.equal(JSON.parse(fs.readFileSync(f.broker.file)).token, second.token);
  assert.deepEqual(await brokerRequest(f.root, 'list'), []);
});
test('API5 broker discovery degrades to an empty set when no GUI host is running', async t => {
  const f = fixture(t);
  assert.deepEqual(await brokerRequest(f.root, 'list'), []);
  await assert.rejects(brokerRequest(f.root, 'call', {}), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('API5 broker shutdown during startup cannot publish into a removed data root', { timeout: 5000 }, async t => {
  const f = fixture(t), starting = f.broker.start(), stopping = f.broker.dispose();
  fs.rmSync(f.root, { recursive: true, force: true });
  await Promise.all([starting, stopping]);
  assert.equal(f.broker.server?.listening, false);
  assert.equal(fs.existsSync(f.broker.file), false);
});

test('API5 broker stops publishing synchronously before asynchronous host cleanup', async t => {
  const f = fixture(t); await f.broker.start();
  f.broker.stopPublishing();
  assert.equal(fs.existsSync(f.broker.file), false);
  fs.rmSync(f.root, { recursive: true, force: true });
  assert.doesNotThrow(() => f.broker.publish());
  await f.broker.dispose();
  await assert.rejects(f.broker.start(), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(f.broker.server?.listening, false);
});

test('API5 broker concurrent starts share one listener and disposal is repeatable', async t => {
  const f = fixture(t), first = f.broker.start(), server = f.broker.server;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const second = f.broker.start();
  await Promise.all([first, second]);
  assert.equal(f.broker.server, server);
  assert.deepEqual(await brokerRequest(f.root, 'list'), [{ name: alias(f.tools[0].name), description: 'fixture', inputSchema: { type: 'object' } }]);
  await Promise.all([f.broker.dispose(), f.broker.dispose()]);
  assert.equal(server.listening, false);
});
test('API5 broker invokes a real installed backend tool and withdraws it after disable', async t => {
  const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
  const { ForgeBackendManager } = require('../runtime/forge-backends.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-broker-real-')), source = path.join(root, 'source');
  fs.mkdirSync(source);
  const inputSchema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }, outputSchema = { type: 'integer' };
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ schemaVersion: 1, apiVersion: 5, id: 'test.real', name: 'Real tool fixture', version: '1.0.0', compatibility: { forge: ['>=0.7.0 <0.8.0'] }, permissions: ['backend.node', 'tools.register'], backend: { entry: 'backend.cjs', methods: [] }, contributes: { tools: [{ name: 'test.real.add', inputSchema, outputSchema }] } }));
  fs.writeFileSync(path.join(source, 'backend.cjs'), `exports.activate=forge=>{forge.tools.register({name:'test.real.add',description:'fixture',inputSchema:${JSON.stringify(inputSchema)},outputSchema:${JSON.stringify(outputSchema)}},args=>args.n+1);};`);
  const registry = new ForgeRegistry({ root: path.join(root, 'home'), bundledRoot: path.join(root, 'empty'), versions: { forge: '0.7.0', codex: '26.1106.6628.0', apiVersion: 5 } });
  const manager = new ForgeBackendManager({ registry });
  const broker = new ForgePluginBroker({ root: registry.root, tools: () => manager.tools(), callTool: (name, args, context, options) => manager.callTool(name, args, context, options), contextFor: () => ({ threadId: 'fixture-thread', cwd: root }) });
  t.after(async () => { await broker.dispose(); await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  registry.install(source); registry.setEnabled('test.real', true); await manager.sync(); await broker.start();
  const tools = await brokerRequest(registry.root, 'list'); assert.equal(tools.length, 1);
  assert.equal(await brokerRequest(registry.root, 'call', { name: tools[0].name, args: { n: 5 } }), 6);
  registry.setEnabled('test.real', false); await manager.sync(); broker.publish();
  assert.deepEqual(await brokerRequest(registry.root, 'list'), []);
  await assert.rejects(brokerRequest(registry.root, 'call', { name: tools[0].name, args: { n: 5 } }), { code: 'METHOD_NOT_FOUND' });
});
