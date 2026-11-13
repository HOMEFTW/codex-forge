'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgeBackendManager } = require('../runtime/forge-backends.cjs');
const { schemaDefinition, validateValue } = require('../runtime/forge-backend-values.cjs');
const { ForgeError } = require('../runtime/forge-errors.cjs');
const { fingerprint } = require('../runtime/forge-registry.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
const output = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
function fixture(t, { source, change, request } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-backend-'));
  const id = 'test.backend', pluginRoot = path.join(root, id); fs.mkdirSync(pluginRoot);
  const manifest = {
    id, apiVersion: 5, backend: { entry: 'backend.cjs', methods: ['echo', 'broker', 'hang', 'huge', 'slow'], scope: 'session' },
    permissions: ['backend.node', 'services.provide', 'tools.register', 'llm.providers', 'hooks.register', 'jobs.manage'],
    contributes: {
      tools: [{ name: id + '.sum', inputSchema: input, outputSchema: output }, { name: id + '.bad', inputSchema: input, outputSchema: output }],
      services: [{ name: id + '.metrics', methods: ['read'] }], providers: [{ name: id + '.local' }],
      hooks: [], jobs: [{ name: 'scheduled' }],
    },
  };
  change?.(manifest);
  fs.writeFileSync(path.join(pluginRoot, 'backend.cjs'), source || `
    exports.activate = forge => {
      forge.handle('echo', (args, {context}) => ({ args, threadId: context.threadId }));
      forge.handle('broker', async (args, {signal}) => forge.request('host.read', args, {signal}));
      forge.handle('hang', () => new Promise(() => {}));
      forge.handle('huge', () => 'x'.repeat(2 * 1024 * 1024));
      forge.handle('slow', (args, {signal}) => new Promise((resolve,reject) => {
        const timer=setTimeout(() => resolve('late'),10000);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(Error('cancelled'),{code:'CANCELLED'}));},{once:true});
      }));
      forge.tools.register({name:'test.backend.sum',description:'add one',inputSchema:${JSON.stringify(input)},outputSchema:${JSON.stringify(output)}}, args => ({value: args.n+1}));
      forge.tools.register({name:'test.backend.bad',description:'bad output fixture',inputSchema:${JSON.stringify(input)},outputSchema:${JSON.stringify(output)}}, args => ({value: String(args.n)}));
      forge.services.provide('test.backend.metrics',{read: (args,{context}) => ({value:args.n,threadId:context.threadId,caller:context.callerPluginId})});
      forge.llm.registerProvider({name:'test.backend.local',models:[{id:'fixture'}]}, async function*(args,{signal}) {
        yield {type:'text',text:args.prompt};
        await new Promise(resolve=>setTimeout(resolve,15));
        if(signal.aborted)return;
        yield {type:'text',text:'!'}; yield {type:'usage',usage:{outputTokens:2}};
      });
      forge.jobs.register('scheduled', args => ({ran:args}));
    };
  `);
  const entries = new Map([[id, { root: pluginRoot, manifest, fingerprint: fingerprint(pluginRoot) }]]), enabled = new Map([[id, true]]);
  const registry = {
    root, entries,
    list: () => ({ plugins: [...entries.values()].map(entry => ({ ...entry.manifest, fingerprint: entry.fingerprint, enabled: enabled.get(entry.manifest.id) === true })) }),
    status: plugin => ({ enabled: enabled.get(plugin) === true }),
    get(plugin) { const entry = entries.get(plugin); if (!entry) throw new ForgeError('PLUGIN_NOT_FOUND', 'missing'); if (!enabled.get(plugin)) throw new ForgeError('PLUGIN_DISABLED', 'disabled'); return entry; },
    permission(plugin, permission) { const entry = this.get(plugin); if (!entry.manifest.permissions.includes(permission)) throw new ForgeError('PERMISSION_DENIED', permission); return entry; },
  };
  const events = [], manager = new ForgeBackendManager({ registry, root, request, onEvent: event => events.push(event) });
  t.after(async () => { await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, id, manifest, entries, enabled, registry, manager, events, context: { threadId: 'chat-a', cwd: root, generation: 1 } };
}
test('API5 backend process calls handlers and preserves host-derived context in nested requests', async t => {
  const seen = [];
  const f = fixture(t, { request: async (id, method, args, context) => { seen.push({ id, method, context }); return { args, thread: context.threadId }; } });
  const value = await f.manager.call(f.id, 'echo', { hello: 1 }, f.context);
  assert.deepEqual(value, { args: { hello: 1 }, threadId: 'chat-a' });
  assert.ok(f.manager.workers.get(f.id).child.pid);
  const broker = await f.manager.call(f.id, 'broker', { context: { threadId: 'forged' } }, f.context);
  assert.equal(broker.thread, 'chat-a'); assert.equal(seen[0].context.threadId, 'chat-a');
  await assert.rejects(f.manager.call(f.id, 'echo', {}, {}), { code: 'STALE_CONTEXT' });
  await assert.rejects(f.manager.call(f.id, 'undeclared', {}, f.context), { code: 'PERMISSION_DENIED' });
});
test('API5 tools validate arguments and results through real worker calls', async t => {
  const f = fixture(t); await f.manager.sync();
  assert.equal(f.manager.tools().length, 2);
  assert.deepEqual(await f.manager.callTool(f.id + '.sum', { n: 3 }, f.context), { value: 4 });
  await assert.rejects(f.manager.callTool(f.id + '.sum', { n: '3' }, f.context), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.manager.callTool(f.id + '.sum', { n: 3, extra: true }, f.context), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.manager.callTool(f.id + '.bad', { n: 3 }, f.context), { code: 'INVALID_ARGUMENT' });
});
test('API5 services require declared consumers and route only registered methods', async t => {
  const f = fixture(t); await f.manager.sync();
  const consumer = { root: f.root, fingerprint: 'consumer', manifest: { id: 'test.consumer', permissions: ['services.call'], consumes: { services: [f.id + '.metrics'] } } };
  f.entries.set('test.consumer', consumer); f.enabled.set('test.consumer', true);
  const value = await f.manager.requestService('test.consumer', f.id + '.metrics', 'read', { n: 8 }, f.context);
  assert.deepEqual(value, { value: 8, threadId: 'chat-a', caller: 'test.consumer' });
  await assert.rejects(f.manager.requestService('test.consumer', f.id + '.metrics', 'write', {}, f.context), { code: 'METHOD_NOT_FOUND' });
  consumer.manifest.consumes.services = [];
  await assert.rejects(f.manager.requestService('test.consumer', f.id + '.metrics', 'read', {}, f.context), { code: 'PERMISSION_DENIED' });
});
test('API5 provider streams are pulled incrementally and unary sampling aggregates usage', async t => {
  const f = fixture(t); await f.manager.sync();
  const stream = f.manager.stream(f.id, { provider: f.id + '.local', model: 'fixture', prompt: 'hello' }, f.context);
  assert.deepEqual(await stream.next(), { value: { type: 'text', text: 'hello' }, done: false });
  assert.deepEqual(await stream.next(), { value: { type: 'text', text: '!' }, done: false });
  assert.equal((await stream.next()).value.type, 'usage');
  assert.deepEqual((await stream.next()).value, { type: 'result', result: { text: 'hello!', usage: { outputTokens: 2 } } });
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(await f.manager.sample(f.id, { provider: f.id + '.local', model: 'fixture', prompt: 'world' }, f.context), { text: 'world!', usage: { outputTokens: 2 } });
  await assert.rejects(f.manager.sample(f.id, { provider: f.id + '.local', model: 'unknown', prompt: '' }, f.context), { code: 'INVALID_ARGUMENT' });
});
test('API5 cancellation aborts the backend and uncooperative code is terminated', async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = f.manager.call(f.id, 'slow', {}, f.context, { signal: controller.signal });
  await f.manager.ensure(f.id); await delay(20); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  await delay(200); assert.equal(f.manager.workers.has(f.id), true, 'cooperative cancellation keeps the worker');
  const hanging = f.manager.call(f.id, 'hang', {}, f.context, { timeoutMs: 25 });
  await assert.rejects(hanging, { code: 'TIMEOUT' }); await delay(200);
  assert.equal(f.manager.workers.has(f.id), false); assert.equal(f.manager.tools().length, 0);
});
test('API5 disable and fingerprint change revoke every backend contribution', async t => {
  const f = fixture(t); await f.manager.sync();
  f.enabled.set(f.id, false); await f.manager.sync();
  assert.deepEqual(f.manager.providers(), []); assert.equal(f.manager.workers.size, 0);
  await assert.rejects(f.manager.call(f.id, 'echo', {}, f.context), { code: 'PLUGIN_DISABLED' });
  f.enabled.set(f.id, true); await f.manager.sync();
  f.entries.get(f.id).fingerprint = 'changed';
  await assert.rejects(f.manager.call(f.id, 'echo', {}, f.context), { code: 'PLUGIN_CHANGED' });
  assert.equal(f.manager.workers.size, 0); assert.deepEqual(f.manager.services(), []);
});
test('API5 backend registrations cannot claim undeclared permissions or other namespaces', async t => {
  const f = fixture(t, { source: "exports.activate = forge => { forge.services.provide('other.plugin.service',{read:()=>1}); };" });
  await assert.rejects(f.manager.ensure(f.id), /命名空间/);
  assert.equal(f.manager.services().length, 0);
  f.enabled.set(f.id, false); await f.manager.sync(); f.enabled.set(f.id, true);
  f.manifest.permissions = ['backend.node'];
  fs.writeFileSync(path.join(f.root, f.id, 'backend.cjs'), "exports.activate = forge => { forge.tools.register({name:'test.backend.sum',description:'fixture',inputSchema:{},outputSchema:{}},()=>1); };");
  f.entries.get(f.id).fingerprint = fingerprint(path.join(f.root, f.id));
  await assert.rejects(f.manager.ensure(f.id), { code: 'PERMISSION_DENIED' });
});
test('API5 hook chains can transform calls and explicitly reject execution', async t => {
  const f = fixture(t, {
    change: manifest => { manifest.backend.methods = ['echo']; manifest.contributes.hooks = [{ name: 'conversation.beforeSend', scope: 'session' }]; },
    source: "exports.activate = forge => { forge.handle('echo',args=>args); forge.hooks.on('conversation.beforeSend', args => args.block ? {cancel:true,reason:'blocked fixture'} : {...args,text:args.text+'!'}); };",
  });
  await f.manager.sync();
  assert.deepEqual(await f.manager.applyHooks('conversation.beforeSend', { text: 'hello' }, f.context), { text: 'hello!' });
  await assert.rejects(f.manager.applyHooks('conversation.beforeSend', { text: '', block: true }, f.context), { code: 'HOOK_REJECTED' });
});
test('API5 oversized backend results fail promptly instead of leaving a pending call', async t => {
  const f = fixture(t);
  await assert.rejects(f.manager.call(f.id, 'huge', {}, f.context), { code: 'OUTPUT_LIMIT' });
  assert.equal(f.manager.workers.get(f.id).calls.size, 0);
});
test('API5 crashed workers reject their pending calls and remove registered tools', async t => {
  const f = fixture(t, { source: "exports.activate = forge => { forge.handle('echo',()=>process.exit(19)); forge.services.provide('test.backend.metrics',{read:()=>1}); };" });
  await f.manager.sync(); assert.equal(f.manager.services().length, 1);
  await assert.rejects(f.manager.call(f.id, 'echo', {}, f.context), { code: 'BACKEND_EXITED' });
  assert.equal(f.manager.services().length, 0); assert.equal(f.manager.workers.has(f.id), false);
});
test('API5 JSON schema supports explicit unions and rejects silently ignored vocabulary', () => {
  const schema = schemaDefinition({ oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', minLength: 2 }] });
  assert.equal(validateValue(schema, 2), 2); assert.throws(() => validateValue(schema, false), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => schemaDefinition({ type: 'string', pattern: '.*' }), /不支持/);
});
test('API5 scheduled aliases resolve to their declared backend method', async t => {
  const f = fixture(t, { change: manifest => { manifest.backend.methods = []; manifest.contributes.jobs = [{ name: 'friendly-name', method: 'work' }]; }, source: "exports.activate = forge => { forge.jobs.register('work', args => ({done:args})); };" });
  assert.deepEqual(await f.manager.call(f.id, 'work', { n: 2 }, f.context), { done: { n: 2 } });
});
test('API5 restarted backends cannot execute changed files hidden by a cached registry fingerprint', async t => {
  const f = fixture(t); await f.manager.ensure(f.id); await f.manager.disposePlugin(f.id);
  fs.appendFileSync(path.join(f.root, f.id, 'backend.cjs'), '\nthrow Error("unreviewed code must not execute");\n');
  await assert.rejects(f.manager.ensure(f.id), { code: 'PLUGIN_CHANGED' });
  assert.equal(f.manager.workers.has(f.id), false);
});

test('API5 settings changes restart cached backend activation and revoke pending calls', async t => {
  const settings = { label: 'first', nested: { n: 1 } };
  const f = fixture(t, {
    change: manifest => { manifest.permissions.push('settings'); manifest.backend.methods = ['echo', 'hang']; },
    source: "exports.activate=async forge=>{const settings=await forge.request('settings.get');forge.handle('echo',()=>({settings,pid:process.pid}));forge.handle('hang',()=>new Promise(()=>{}));};",
    request: async (_id, method) => { assert.equal(method, 'settings.get'); return settings; },
  });
  f.registry.settings = () => settings;
  const initial = await f.manager.call(f.id, 'echo', {}, f.context);
  await f.manager.sync();
  assert.equal((await f.manager.call(f.id, 'echo', {}, f.context)).pid, initial.pid, 'unchanged settings keep the worker');
  const pending = f.manager.call(f.id, 'hang', {}, f.context); pending.catch(() => {});
  await f.manager.ensure(f.id);
  settings.label = 'second'; settings.nested.n = 2;
  await f.manager.sync();
  await assert.rejects(pending, { code: 'SETTINGS_CHANGED' });
  const changed = await f.manager.call(f.id, 'echo', {}, f.context);
  assert.notEqual(changed.pid, initial.pid); assert.deepEqual(changed.settings, settings);
  settings.label = 'third';
  const latest = await f.manager.call(f.id, 'echo', {}, f.context);
  assert.notEqual(latest.pid, changed.pid); assert.equal(latest.settings.label, 'third', 'calls also refresh settings before host sync');
});

test('API5 settings changes allow activation to recover from a configuration failure', async t => {
  const settings = { configured: false };
  const f = fixture(t, {
    change: manifest => { manifest.permissions.push('settings'); manifest.backend.methods = ['echo']; },
    source: "exports.activate=async forge=>{const settings=await forge.request('settings.get');if(!settings.configured)throw Error('fixture configuration missing');forge.handle('echo',()=>settings);};",
    request: async () => settings,
  });
  f.registry.settings = () => settings;
  await assert.rejects(f.manager.ensure(f.id), /fixture configuration missing/);
  await assert.rejects(f.manager.ensure(f.id), { code: 'BACKEND_START_FAILED' });
  settings.configured = true; await f.manager.sync();
  assert.deepEqual(await f.manager.call(f.id, 'echo', {}, f.context), { configured: true });
});
