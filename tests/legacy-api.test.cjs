const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), Module = require('node:module');
const { installForge } = require('../runtime/forge-host.cjs');
const { pluginBundle } = require('../runtime/forge-content.cjs');
const { applyPending } = require('../runtime/forge-plugin-updates.cjs');

for (const apiVersion of [1, 2, 3, 4]) test(`historical API ${apiVersion} SDK uses the current host with unchanged RPC and permissions`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-'));
  const previous = process.env.CODEX_FORGE_HOME, originalLoad = Module._load;
  process.env.CODEX_FORGE_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_FORGE_HOME; else process.env.CODEX_FORGE_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map(), state = { win: { isDestroyed: () => false } }, events = [], opened = [], threadId = 'fixture-thread';
  let forge;
  Module._load = function(name, ...args) { return name === 'electron' ? {} : originalLoad.call(this, name, ...args); };
  try { forge = installForge({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, host: () => state, threadContext: () => ({ threadId }), states: new Map([[1, state]]), notify: (_state, value) => events.push(value), open: (_state, value) => opened.push(value) }); }
  finally { Module._load = originalLoad; }
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const manifest = { schemaVersion: 1, apiVersion, id: 'test.legacy', name: 'Legacy', version: '1.0.0', compatibility: { forge: ['>=0.6.1 <0.8.0'] },
    permissions: ['storage', 'settings', 'events', 'composer', 'conversation.read', 'panels'], entry: 'main.js',
    contributes: { commands: [{ id: 'hello', title: 'Hello' }], panels: [{ id: 'main', title: 'Main', entry: 'ui.html' }], events: [{ name: 'plugin.test.legacy.changed' }], settings: { properties: { greeting: { title: 'Greeting', type: 'string', default: 'kept' } } } } };
  fs.writeFileSync(path.join(source, 'main.js'), 'void 0'); fs.writeFileSync(path.join(source, 'ui.html'), '<html><head></head><body>Legacy</body></html>');
  const write = version => fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ ...manifest, version }));
  write('1.0.0'); forge.registry.install(source); forge.registry.setEnabled(manifest.id, true);
  const bundle = pluginBundle(forge.registry, manifest.id); const received = [], listeners = [];
  const parent = { postMessage: async message => {
    if (message.forgePluginCommandReply) { received.push(message.forgePluginCommandReply); return; }
    const request = message.forgePluginRequest;
    const response = await handlers.get('forge:api')({}, { ...request, id: manifest.id });
    for (const fn of listeners) fn({ source: parent, data: { forgePluginReply: { id: request.id, ...(response.ok ? { result: response.result } : { error: apiVersion === 1 ? response.error.message : response.error }) } } });
  } };
  const window = { parent, addEventListener: (_name, fn) => listeners.push(fn) };
  // Run the historical SDK verbatim, as well as the host-injected compatibility SDK.
  for (const sdk of [fs.readFileSync(path.join(__dirname, `fixtures/forge-sdk-api${apiVersion}.js`), 'utf8'), bundle.sdk]) {
    listeners.length = 0; const page = { ...window };
    vm.runInNewContext(sdk, { window: page, parent, setTimeout, clearTimeout, console });
    const api = page.CodexForge;
    assert.equal(api.apiVersion, apiVersion);
    const context = await api.context.get(); assert.equal(context.apiVersion, apiVersion); assert.equal(context.hostApiVersion, 5); assert.equal(context.threadId, threadId);
    const caps = await api.capabilities.get(); assert.equal(caps.apiVersion, apiVersion); assert.equal(caps.hostApiVersion, 5);
    await api.storage.set('note', { keep: true }); assert.deepEqual(await api.storage.get('note'), { keep: true });
    assert.equal((await api.settings.get()).greeting, 'kept');
    assert.equal((await api.metadata.get()).apiVersion, apiVersion);
    await api.panels.open('main'); assert(opened.some(item => item.page === 'forge-plugin:test.legacy:main'));
    assert.equal((await api.composer.setText('draft', '')).nativeAction, 'composer.set');
    await api.events.emit('plugin.test.legacy.changed', { value: 1 }); assert(events.some(item => item.name === 'plugin.test.legacy.changed'));
    await assert.rejects(api.output.append('denied'), /output/);
    api.commands.register('hello', () => 'legacy result');
    await listeners[0]({ source: parent, data: { forgePluginCommand: { id: 1, command: 'hello', args: {}, context } } }); assert.equal(received.at(-1).result, 'legacy result');
  }
  write('1.1.0'); assert(forge.registry.install(source).restartRequired); assert.equal(applyPending(forge.registry)[0].status, 'installed');
  assert.equal(forge.registry.get(manifest.id).manifest.apiVersion, apiVersion); assert.deepEqual(forge.registry.storage(manifest.id, 'get', 'note'), { keep: true });
  forge.registry.setEnabled(manifest.id, false);
  const disabled = await handlers.get('forge:api')({}, { id: manifest.id, method: 'storage.get', args: { key: 'note' } }); assert.equal(disabled.error.code, 'PLUGIN_DISABLED');
});
