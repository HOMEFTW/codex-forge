const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { pluginResponse } = require('../runtime/forge-content.cjs');
const config = require('../forge.config.json');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ForgeRegistry({ root: path.join(root, 'data'), bundledRoot: path.join(root, 'empty'), versions: { forge: config.version, codex: config.codexVersion, apiVersion: config.apiVersion } });
  const manifest = { schemaVersion: 1, apiVersion: 3, id: 'homeftw.nexus', name: 'Nexus fixture', version: '0.1.0', compatibility: { forge: ['>=0.4.0 <0.5.0'], codex: [config.codexVersion] }, permissions: ['panels', 'nexus.read', 'nexus.write'], contributes: { panels: [{ id: 'main', title: 'Notes', entry: 'panel.html' }] } };
  const file = (name, data) => ({ path: name, encoding: 'base64', content: Buffer.from(data).toString('base64') });
  let count = 0;
  const pack = (extras = [], override = {}) => { const target = path.join(root, 'plugin-' + (++count) + '.forge-plugin.json'); fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, files: [file('plugin.json', JSON.stringify({ ...manifest, ...override })), file('panel.html', '<html><head></head><body>Standalone</body></html>'), ...extras] })); return target; };
  return { root, registry, manifest, file, pack };
}
test('standalone JSON plugin imports disabled, runs under plugin CSP and uninstalls while retaining settings', async t => {
  const f = fixture(t), result = f.registry.install(f.pack([f.file('assets/说明.txt', 'local')]));
  assert.equal(result.id, f.manifest.id); assert.equal(result.enabled, false);
  assert.equal(f.registry.get(result.id, false).builtin, false);
  f.registry.setEnabled(result.id, true);
  assert.equal(fs.readFileSync(path.join(f.registry.get(result.id).root, 'assets/说明.txt'), 'utf8'), 'local');
  const response = pluginResponse(f.registry, 'codex-forge://plugin/homeftw.nexus/main');
  assert.equal(response.status, 200); assert.match(await response.text(), /Standalone/);
  const csp = response.headers.get('Content-Security-Policy');
  assert.match(csp, /media-src data:/); assert.match(csp, /frame-src 'none'/); assert.match(csp, /object-src 'none'/);
  const settings = path.join(f.registry.root, 'storage/homeftw.nexus.settings.json'); fs.writeFileSync(settings, '{}');
  f.registry.uninstall(result.id); assert.equal(f.registry.entries.has(result.id), false); assert(fs.existsSync(settings));
  assert(!fs.readdirSync(f.registry.root).some(name => name.startsWith('.import-')));
});
test('package traversal, Windows aliases, duplicate paths and malformed base64 cannot partially install', t => {
  const f = fixture(t);
  for (const name of ['../escape', '/escape', 'C:/escape', 'a\\escape', 'nul.txt', 'x./file', 'a:stream', 'node_modules/x', '.git/config']) assert.throws(() => f.registry.install(f.pack([f.file(name, 'bad')])));
  assert.throws(() => f.registry.install(f.pack([f.file('A.txt', 'one'), f.file('a.txt', 'two')])));
  assert.throws(() => f.registry.install(f.pack([{ path: 'bad.txt', encoding: 'base64', content: '%%%%' }])));
  assert.throws(() => f.registry.install(f.pack([], { apiVersion: 2 })));
  assert.equal(f.registry.list().plugins.length, 0);
  assert(!fs.readdirSync(f.registry.root).some(name => name.startsWith('.import-')));
  assert(!fs.existsSync(path.join(f.root, 'escape')));
});
test('ordinary external panels do not gain local media CSP permission', t => {
  const f = fixture(t); f.registry.install(f.pack([], { permissions: ['panels'] })); f.registry.setEnabled(f.manifest.id, true);
  assert.match(pluginResponse(f.registry, 'codex-forge://plugin/homeftw.nexus/main').headers.get('Content-Security-Policy'), /media-src 'none'/);
});

test('isolated script workers require explicit read plus script permission without network', t => {
  const f=fixture(t);
  for(const permissions of [['panels','nexus.script'],['panels','nexus.read','nexus.script','network']])assert.throws(()=>f.registry.install(f.pack([], {permissions})),/nexus.script/);
  f.registry.install(f.pack([], {permissions:['panels','nexus.read','nexus.script']}));f.registry.setEnabled(f.manifest.id,true);
  const csp=pluginResponse(f.registry,'codex-forge://plugin/homeftw.nexus/main').headers.get('Content-Security-Policy');
  assert.match(csp,/worker-src blob:/);assert.match(csp,/connect-src 'none'/);assert.match(csp,/frame-src 'none'/);assert(!csp.includes('unsafe-eval'));
  f.registry.uninstall(f.manifest.id);f.registry.install(f.pack());f.registry.setEnabled(f.manifest.id,true);
  assert.match(pluginResponse(f.registry,'codex-forge://plugin/homeftw.nexus/main').headers.get('Content-Security-Policy'),/worker-src 'none'/);
});

test('oversized JSON, decoded content and file counts leave no partial installation', t => {
  const f = fixture(t);
  const oversized = path.join(f.root, 'oversized.forge-plugin.json');
  const fd = fs.openSync(oversized, 'w');
  try { fs.ftruncateSync(fd, 30 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  assert.throws(() => f.registry.install(oversized), /30MB/);
  assert.throws(() => f.registry.install(f.pack([f.file('large.bin', Buffer.alloc(20 * 1024 * 1024))])), /20MB/);
  assert.throws(() => f.registry.install(f.pack(Array.from({ length: 999 }, (_, i) => f.file(`file${i}`, '')))), /格式无效/);
  assert.equal(f.registry.list().plugins.length, 0);
  assert(!fs.readdirSync(f.registry.root).some(name => name.startsWith('.import-')));
});
