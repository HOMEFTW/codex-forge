const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validate, compatibility } = require('../runtime/forge-manifest.cjs');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { applyPending } = require('../runtime/forge-plugin-updates.cjs');
const { matchUpdate } = require('../runtime/forge-updates.cjs');
const config = require('../forge.config.json');
const versions = { forge: config.version, codex: config.codexVersion, apiVersion: 4 };
const manifest = () => ({ schemaVersion: 1, apiVersion: 4, id: 'test.portable', name: 'Portable API plugin', version: '1.0.0', compatibility: { forge: ['>=0.6.1 <0.7.0'] }, permissions: ['storage'] });

test('API plugins can omit Codex ranges; explicit pins, API and Forge ranges remain enforced', () => {
  const plugin = validate(manifest(), __dirname);
  for (const codex of [versions.codex, '99.0.0.0']) assert(compatibility(plugin, { ...versions, codex }).compatible);
  assert(!compatibility(plugin, { ...versions, apiVersion: 3 }).compatible);
  assert(!compatibility(plugin, { ...versions, forge: '0.7.0' }).compatible);
  assert(!compatibility({ ...plugin, compatibility: { ...plugin.compatibility, codex: ['1.0.0.0'] } }, versions).compatible);
  for (const codex of [null, [], '', ['bad']]) assert.throws(() => validate({ ...manifest(), compatibility: { forge: ['>=0.6.1 <0.7.0'], codex } }, __dirname));
  for (const compatibility of [undefined, {}, { codex: [versions.codex] }, { forge: [] }]) assert.throws(() => validate({ ...manifest(), compatibility }, __dirname));
});

test('unpinned plugin import, enable, overwrite and host upgrade retain data and activation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const write = version => fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ ...manifest(), version }));
  write('1.0.0');
  const registry = new ForgeRegistry({ root: path.join(root, 'home'), bundledRoot: path.join(root, 'bundled'), versions });
  registry.install(source); registry.setEnabled('test.portable', true); registry.storage('test.portable', 'set', 'note', 'keep');
  write('1.1.0'); assert(registry.install(source).restartRequired);
  registry.versions = { ...versions, codex: '99.0.0.0' };
  assert.equal(applyPending(registry)[0].status, 'installed');
  assert.equal(registry.get('test.portable').manifest.version, '1.1.0');
  assert.equal(registry.storage('test.portable', 'get', 'note'), 'keep');
  assert.equal(registry.status('test.portable').enabled, true);
  assert(!Object.hasOwn(registry.get('test.portable').manifest.compatibility, 'codex'));
});

test('normal updater permits an unpinned plugin and still blocks explicit Codex restrictions', () => {
  const release = { forgeVersion: '0.6.2', codexVersion: '99.0.0.0', apiVersion: 4 };
  const plugin = manifest();
  assert(matchUpdate({config, releases: [release], plugins: [plugin]}).plan);
  assert(!matchUpdate({config, releases: [release], plugins: [{ ...plugin, compatibility: { ...plugin.compatibility, codex: [versions.codex] } }]}).plan);
});

for (const apiVersion of [1,2,3]) test('legacy API '+apiVersion+' is supported from Forge 0.6.1 only', () => {
 const m = {...manifest(), apiVersion, compatibility:{forge:['>=0.6.0 <0.7.0']}};
 assert(compatibility(m, versions).compatible);
 assert(!compatibility(m, {...versions, forge:'0.6.0'}).compatible);
 assert(!compatibility({...m, apiVersion:5}, versions).compatible);
});
