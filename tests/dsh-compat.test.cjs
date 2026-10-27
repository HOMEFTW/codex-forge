'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { DshCompatibilityLayer, inspectDshClient, idForPackage } = require('../runtime/dsh-compat.cjs');
const { pluginBundle, pluginResponse } = require('../runtime/forge-content.cjs');
const versions = { codex: '26.1021.2667.0', forge: '0.3.0', apiVersion: 2 };
const clientScript = '__ModuleLoader__.load({id:"fixture",factory:()=>({apply(){}})});';
function fixture(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dsh-ui-'));
  t.after(() => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const registry = new ForgeRegistry({ root: path.join(root, 'forge'), bundledRoot: path.join(root, 'bundled'), versions });
  return { root, registry, layer: new DshCompatibilityLayer({ registry, fetchImpl }) };
}
function client(root, name = 'example-dsh-ui', version = '1.2.3') {
  const directory = path.join(root, idForPackage(name));
  fs.mkdirSync(path.join(directory, 'client'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'lib'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version, description: 'isolated browser-client fixture', exports: { '.': './lib/index.js', './client': { browser: './client/client.js' } } }));
  fs.writeFileSync(path.join(directory, 'lib/index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(directory, 'client/client.js'), clientScript);
  fs.writeFileSync(path.join(directory, 'client/client.css'), '.fixture{color:blue}');
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'MIT fixture license');
  return directory;
}
function reviewed({ registry, layer }, id) { registry.setEnabled(id, true); layer.reviewed(id); }
function market(f) { const item = f.layer.importDirectory(client(f.root, 'dshmarket'), { market: true }); reviewed(f, item.id); return item.id; }
function archive(files) {
  const parts = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value), header = Buffer.alloc(512);
    header.write('package/' + name, 0, 100); header.write('0000644\0', 100, 8); header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); header.write('00000000000\0', 136, 12); header.fill(32, 148, 156); header.write('0', 156, 1);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

test('DSH import copies browser assets and license into Forge, initially disabled', t => {
  const f = fixture(t), directory = client(f.root), info = inspectDshClient(directory);
  assert.equal(info.name, 'example-dsh-ui'); assert.equal(info.entry, 'client/client.js'); assert.equal(info.css, 'client/client.css');
  const result = f.layer.importDirectory(directory), entry = f.registry.get(result.id, false);
  assert.equal(result.browserOnly, true); assert.equal(f.registry.status(result.id).enabled, false);
  assert.deepEqual(fs.readdirSync(entry.root).sort(), ['LICENSE', 'client', 'plugin.json', 'ui.html']);
  assert.equal(fs.readFileSync(path.join(entry.root, 'client/client.js'), 'utf8'), clientScript);
  assert.equal(fs.existsSync(path.join(entry.root, 'lib')), false);
  assert.deepEqual(f.layer.snapshot().plugins.map(item => item.name), ['example-dsh-ui']);
  assert.equal(f.layer.snapshot().externalRuntime, false);
});

test('reviewed DSH UI toggles without restart and uninstall preserves storage', t => {
  const f = fixture(t), directory = client(f.root), { id } = f.layer.importDirectory(directory);
  reviewed(f, id); f.registry.storage(id, 'set', 'note', 'retained');
  assert.equal(f.layer.installed().activation['example-dsh-ui'].state, 'live');
  assert.equal(f.layer.toggle('example-dsh-ui', false).activation['example-dsh-ui'].state, 'disabled');
  assert.equal(f.layer.toggle('example-dsh-ui', true).hot, true);
  assert.equal(f.layer.uninstall('example-dsh-ui').installed['example-dsh-ui'], undefined);
  assert.equal(f.layer.records()[id], undefined);
  f.layer.importDirectory(directory); assert.equal(f.registry.status(id).enabled, false);
  assert.equal(f.layer.records()[id].reviewedFingerprint, undefined);
  reviewed(f, id); assert.equal(f.registry.storage(id, 'get', 'note'), 'retained');
  f.registry.uninstall(id); f.layer.forget(id); assert.equal(f.layer.records()[id], undefined);
});

test('DSH panel loads SDK, adapter, browser client and start in order with both stylesheets', async t => {
  const f = fixture(t), { id } = f.layer.importDirectory(client(f.root)); reviewed(f, id);
  const assetsRoot = path.join(f.root, 'assets'); fs.mkdirSync(assetsRoot);
  fs.writeFileSync(path.join(assetsRoot, 'dsh-client.js'), 'window.adapterLoaded=true;');
  fs.writeFileSync(path.join(assetsRoot, 'dsh-client.css'), '.adapter{color:red}');
  const bundle = pluginBundle(f.registry, id, { viewId: 'ui', assetsRoot });
  assert.match(bundle.html, /\.adapter/); assert.match(bundle.html, /\.fixture/);
  assert(bundle.script.indexOf('window.adapterLoaded') < bundle.script.indexOf('__ModuleLoader__'));
  assert(bundle.script.indexOf('__ModuleLoader__') < bundle.script.indexOf('window.ForgeDshClient.start'));
  const response = pluginResponse(f.registry, 'codex-forge://plugin/' + id + '/ui', { assetsRoot }), html = await response.text();
  assert.equal(response.status, 200); assert(html.indexOf('Object.defineProperty(window') < html.indexOf('window.adapterLoaded'));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors app:\/\/-/);
  assert.equal(pluginBundle(f.registry, id).script, '', 'DSH client is loaded by its visible panel only');
});

test('DSH market contract supports registry, installed state, preferences and groups', async t => {
  let catalogCalls = 0;
  const catalog = { updated: 'fixture', categories: { utility: { zh: '工具', en: 'Utility' } }, plugins: [{ name: 'UI fixture', owner: 'fixture', url: 'https://github.com/forge-fixtures/ui', npm: 'example-dsh-ui', category: 'utility', install: 'omitted by adapter' }] };
  const f = fixture(t, async () => { catalogCalls++; return new Response(JSON.stringify(catalog)); }), id = market(f);
  const first = await f.layer.request(id, 'registry'), second = await f.layer.request(id, 'registry');
  assert.equal(first.status, 200); assert.equal(second.body.registry.count, 1); assert.equal(catalogCalls, 1);
  assert.equal(first.body.registry.plugins[0].install, undefined);
  const imported = f.layer.importDirectory(client(f.root)); reviewed(f, imported.id);
  const post = (endpoint, body) => f.layer.request(id, endpoint, { method: 'POST', body });
  await post('note', { name: 'example-dsh-ui', text: 'fixture note' });
  await post('favorite', { url: catalog.plugins[0].url, favorited: true });
  await post('block', { name: 'example-dsh-ui', blocked: true });
  await post('update-exempt', { name: 'example-dsh-ui', exempt: true });
  await post('groups', { action: 'create', name: 'Tools' });
  await post('groups', { action: 'set-members', name: 'Tools', members: ['example-dsh-ui'] });
  await post('groups', { action: 'rename', name: 'Tools', newName: 'UI' });
  const toggled = await post('groups', { action: 'toggle', name: 'UI', enabled: false });
  assert.equal(toggled.status, 200); assert(toggled.body.disabled.includes('example-dsh-ui'));
  const value = (await f.layer.request(id, 'installed')).body;
  assert.equal(value.notes['example-dsh-ui'], 'fixture note'); assert.deepEqual(value.groups.UI, ['example-dsh-ui']);
  assert.deepEqual(value.groupOrder, ['UI']); assert.deepEqual(value.favorites, [catalog.plugins[0].url]);
  assert.deepEqual(value.blocked, ['example-dsh-ui']); assert.deepEqual(value.updateExempt, ['example-dsh-ui']);
  assert.equal((await f.layer.request(id, 'status')).body.packageManager, 'codex-forge');
  assert.equal((await f.layer.request(id, 'updates')).status, 501);
  const opened = await post('open-plugin', { name: 'dshmarket' }); assert.deepEqual(opened.body.openPlugin, { id, view: 'ui' });
  await post('groups', { action: 'delete', name: 'UI' }); assert.deepEqual(f.layer.preferences().groups, {});
});

test('market imports a valid npm browser package into Forge without a restart or activation', async t => {
  const name = 'example-dsh-ui', version = '1.2.3', url = 'https://github.com/forge-fixtures/ui';
  const bytes = archive({ 'package.json': JSON.stringify({ name, version, exports: { './client': './client/client.js' } }), 'client/client.js': clientScript, 'LICENSE': 'MIT fixture' });
  const integrity = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'), calls = [];
  const f = fixture(t, async input => {
    const request = new URL(input); calls.push(request.href);
    if (request.hostname === 'awesome-dsh-plugin.com') return new Response(JSON.stringify({ updated: 'fixture', categories: {}, plugins: [{ name, npm: name, url, category: 'utility' }] }));
    if (request.pathname.endsWith('.tgz')) return new Response(bytes);
    return new Response(JSON.stringify({ name, version, dist: { tarball: 'https://registry.npmjs.org/example-dsh-ui/-/example-dsh-ui-1.2.3.tgz', integrity } }));
  }), id = market(f);
  const response = await f.layer.request(id, 'install', { method: 'POST', body: { url } });
  assert.equal(response.status, 200); assert.equal(response.body.hot, true); assert.match(response.body.message, /审阅权限/);
  assert.equal(response.body.installed[name], version); assert.equal(response.body.activation[name].state, 'disabled');
  assert.equal(f.registry.status(idForPackage(name)).enabled, false); assert.equal(calls.length, 3);
  assert.equal(fs.readdirSync(path.join(f.registry.root, 'dsh-staging')).length, 0);
});
