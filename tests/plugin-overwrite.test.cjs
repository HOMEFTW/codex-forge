const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const updates = require('../runtime/forge-plugin-updates.cjs');
const config = require('../forge.config.json');
const id = 'test.overwrite';
function setup(t) {
  const output = path.join(__dirname, '../output/overwrite-tests'); fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'case-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const registry = new ForgeRegistry({ root: path.join(root, 'data'), bundledRoot: path.join(root, 'bundled'), versions: { forge: config.version, codex: config.codexVersion, apiVersion: 4 } });
  const manifest = { schemaVersion: 1, apiVersion: 4, id, name: 'Overwrite', version: '1.0.0', compatibility: { forge: ['>=0.6.0 <0.7.0'], codex: [config.codexVersion] }, permissions: ['storage', 'settings', 'network'], networkOrigins: ['https://one.example'], contributes: { settings: { properties: { greeting: { title: 'Greeting', type: 'string', default: 'hello' } } } } };
  const write = (change = {}, text = 'new') => { const next = { ...manifest, version: '1.1.0', ...change }; fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(next)); fs.writeFileSync(path.join(source, 'data.txt'), text); return next; };
  write({ version: '1.0.0' }, 'old'); registry.install(source); registry.setEnabled(id, true);
  registry.settings(id, { greeting: '保留设置' }); registry.storage(id, 'set', 'note', { text: '保留数据' });
  return { root, source, registry, manifest, write };
}
function apply(registry) { return updates.applyPending(registry)[0]; }
function unchanged(registry) { assert.equal(registry.get(id).manifest.version, '1.0.0'); assert.equal(registry.source(id, 'data.txt'), 'old'); }

test('directory overwrite stages until restart, preserves settings/data and removes obsolete files', t => {
  const f = setup(t); fs.writeFileSync(path.join(f.registry.get(id).root, 'obsolete.txt'), 'old'); f.registry.reload(); f.registry.setEnabled(id, true);
  f.write(); const result = f.registry.install(f.source);
  assert.equal(result.restartRequired, true); assert.match(result.message, /重启/); unchanged(f.registry);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.get(id).manifest.version, '1.1.0');
  assert.equal(f.registry.source(id, 'data.txt'), 'new'); assert(!fs.existsSync(path.join(f.registry.get(id).root, 'obsolete.txt')));
  assert.equal(f.registry.settings(id).greeting, '保留设置'); assert.deepEqual(f.registry.storage(id, 'get', 'note'), { text: '保留数据' });
  assert.deepEqual(updates.pendingUpdates(f.registry), {}); assert.deepEqual(f.registry.errors, []);
});

for (const type of ['zip', '7z', 'forge-plugin.json']) test(type + ' can directly upgrade an installed plugin', t => {
  const f = setup(t); f.write(); const file = path.join(f.root, 'upgrade.' + type);
  if (type === 'forge-plugin.json') fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, files: fs.readdirSync(f.source).map(name => ({ path: name, encoding: 'base64', content: fs.readFileSync(path.join(f.source, name)).toString('base64') })) }));
  else execFileSync(path.join(__dirname, '../vendor/7zip/7za.exe'), ['a', '-t' + type, file, '.'], { cwd: f.source, windowsHide: true, stdio: 'pipe' });
  assert(f.registry.install(file).restartRequired); unchanged(f.registry); assert.equal(apply(f.registry).status, 'installed');
  assert.equal(f.registry.source(id, 'data.txt'), 'new'); assert(!fs.readdirSync(f.registry.root).some(name => /^\.(?:install|import)-/.test(name)));
});

test('same-version revision installs and downgrade is rejected without changing queued content', t => {
  const f = setup(t); f.write({ version: '1.0.0' }, 'revision'); f.registry.install(f.source);
  const queue = updates.pendingUpdates(f.registry); f.write({ version: '0.9.0' });
  assert.throws(() => f.registry.install(f.source), /降级/); assert.deepEqual(updates.pendingUpdates(f.registry), queue);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.source(id, 'data.txt'), 'revision');
});

test('disabled state and disablement after import both survive replacement', t => {
  const f = setup(t); f.registry.setEnabled(id, false); f.write(); f.registry.install(f.source); assert.equal(apply(f.registry).status, 'installed');
  assert.equal(f.registry.status(id).requestedEnabled, false);
  f.registry.setEnabled(id, true); f.write({ version: '1.2.0' }); f.registry.install(f.source); f.registry.setEnabled(id, false);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.status(id).requestedEnabled, false);
});

for (const change of [{ permissions: ['storage', 'settings', 'network', 'browser'] }, { networkOrigins: ['https://one.example', 'https://two.example'] }]) test('permission or network-scope changes require review after overwrite: ' + JSON.stringify(change), t => {
  const f = setup(t); f.write(change); assert.equal(f.registry.install(f.source).permissionsChanged, true);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.status(id).enabled, false);
  assert.equal(f.registry.settings(id).greeting, '保留设置'); f.registry.setEnabled(id, true); assert.equal(f.registry.status(id).enabled, true);
});

test('incompatible hosts and missing dependencies leave installed and previously staged versions intact', t => {
  const f = setup(t); f.write(); f.registry.install(f.source); const queue = updates.pendingUpdates(f.registry);
  for (const change of [{ apiVersion: 5 }, { compatibility: { ...f.manifest.compatibility, codex: ['99.0.0.0'] } }, { dependencies: { 'test.missing': '^1.0.0' } }]) {
    f.write(change); assert.throws(() => f.registry.install(f.source)); unchanged(f.registry); assert.deepEqual(updates.pendingUpdates(f.registry), queue);
  }
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.get(id).manifest.version, '1.1.0');
});

test('reverse dependency checks also apply to manual imports', t => {
  const f = setup(t); f.write({ id: 'test.dependent', dependencies: { [id]: '1.0.0' } }); f.registry.install(f.source); f.registry.setEnabled('test.dependent', true);
  f.write(); assert.throws(() => f.registry.install(f.source), /不接受此依赖版本/); unchanged(f.registry);
});

test('tampering and changed host compatibility at restart do not replace the installed plugin', t => {
  const f = setup(t); f.write(); f.registry.install(f.source);
  fs.writeFileSync(path.join(f.registry.root, 'pending', id, 'injected.js'), 'bad');
  assert.equal(apply(f.registry).status, 'failed'); unchanged(f.registry);
  f.registry.install(f.source); f.registry.versions = { ...f.registry.versions, codex: '99.0.0.0' };
  assert.equal(apply(f.registry).status, 'failed'); assert.equal(f.registry.get(id, false).manifest.version, '1.0.0');
});

test('failed pending-queue write preserves the previous queued upgrade', t => {
  const f = setup(t); f.write(); f.registry.install(f.source); const before = updates.pendingUpdates(f.registry);
  f.write({ version: '1.2.0' }, 'replacement');
  const rename = fs.renameSync; fs.renameSync = (from, to) => { if (to === path.join(f.registry.root, 'pending-updates.json')) throw Error('simulated queue failure'); return rename(from, to); };
  try { assert.throws(() => f.registry.install(f.source), /simulated queue failure/); } finally { fs.renameSync = rename; }
  assert.deepEqual(updates.pendingUpdates(f.registry), before); unchanged(f.registry);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.get(id).manifest.version, '1.1.0');
});

test('failed state write restores the old plugin and keeps the update retryable', t => {
  const f = setup(t); f.write(); f.registry.install(f.source);
  const rename = fs.renameSync; fs.renameSync = (from, to) => { if (to === f.registry.stateFile) throw Error('simulated state failure'); return rename(from, to); };
  try { assert.equal(apply(f.registry).status, 'failed'); } finally { fs.renameSync = rename; }
  unchanged(f.registry); assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.get(id).manifest.version, '1.1.0');
});

test('unreviewed changed code is not silently re-enabled by a manual upgrade', t => {
  const f = setup(t); fs.writeFileSync(path.join(f.registry.get(id).root, 'changed.js'), 'changed'); f.registry.reload();
  assert.equal(f.registry.status(id).enabled, false); f.write(); f.registry.install(f.source); assert.equal(apply(f.registry).status, 'installed');
  assert.equal(f.registry.status(id).enabled, false);
});

test('enabling an incompatible old plugin with a compatible pending upgrade explains the restart', t => {
  const f = setup(t);
  const nextCodex = '99.0.0.0'; f.registry.versions.codex = nextCodex;
  f.write({ compatibility: { ...f.manifest.compatibility, codex: [nextCodex] } });
  f.registry.install(f.source);
  assert.throws(() => f.registry.setEnabled(id, true), error => error.code === 'PLUGIN_UPDATE_PENDING' && /1\.1\.0.*重启/.test(error.message));
  assert.equal(f.registry.get(id, false).manifest.version, '1.0.0');
  assert.equal(apply(f.registry).status, 'installed');
  f.registry.setEnabled(id, true); assert.equal(f.registry.status(id).enabled, true);
  assert.deepEqual(f.registry.status(id).reasons, []);
  assert.deepEqual(f.registry.storage(id, 'get', 'note'), { text: '保留数据' });
});

test('a disabled plugin cannot review a queued package as if it were already installed', t => {
  const f = setup(t); f.registry.setEnabled(id, false); f.write(); f.registry.install(f.source);
  const before = f.registry.state();
  assert.throws(() => f.registry.setEnabled(id, true), error => error.code === 'PLUGIN_UPDATE_PENDING');
  assert.deepEqual(f.registry.state(), before);
  assert.equal(apply(f.registry).status, 'installed'); assert.equal(f.registry.status(id).enabled, false);
  f.registry.setEnabled(id, true); assert.equal(f.registry.status(id).enabled, true);
});
