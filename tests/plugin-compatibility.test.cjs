const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validate, compatibility } = require('../runtime/forge-manifest.cjs');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { applyPending } = require('../runtime/forge-plugin-updates.cjs');
const { matchUpdate } = require('../runtime/forge-updates.cjs');
const config = require('../forge.config.json');
const versions = { forge: config.version, codex: config.codexVersion, apiVersion: config.apiVersion };
const manifest = () => ({ schemaVersion: 1, apiVersion: 4, id: 'test.portable', name: 'Portable API plugin', version: '1.0.0', compatibility: { forge: ['>=0.6.1 <0.8.0'] }, permissions: ['storage'] });

test('API plugins can omit Codex ranges; explicit pins, API and Forge ranges remain enforced', () => {
  const plugin = validate(manifest(), __dirname);
  for (const codex of [versions.codex, '99.0.0.0']) assert(compatibility(plugin, { ...versions, codex }).compatible);
  assert(!compatibility(plugin, { ...versions, apiVersion: 3 }).compatible);
  assert(!compatibility(plugin, { ...versions, forge: '0.8.0' }).compatible);
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
  const release = { forgeVersion: config.version, codexVersion: '99.0.0.0', apiVersion: config.apiVersion };
  const plugin = manifest();
  assert(matchUpdate({config, releases: [release], plugins: [plugin]}).plan);
  assert(!matchUpdate({config, releases: [release], plugins: [{ ...plugin, compatibility: { ...plugin.compatibility, codex: [versions.codex] } }]}).plan);
});

for (const apiVersion of [1,2,3]) test('legacy API '+apiVersion+' is supported by API5 while API4 keeps its 0.6.1 introduction rule', () => {
 const m = {...manifest(), apiVersion, compatibility:{forge:['>=0.6.0 <0.8.0']}};
 assert(compatibility(m, versions).compatible);
 assert(compatibility(m, {...versions, apiVersion:4, forge:'0.6.1'}).compatible);
 assert(!compatibility(m, {...versions, apiVersion:4, forge:'0.6.0'}).compatible);
 assert(!compatibility({...m, apiVersion:5}, {...versions, apiVersion:4, forge:'0.6.3'}).compatible);
});

test('API5 support does not loosen a plugin Forge pin or make API5 available on old hosts', () => {
 const pinned={...manifest(),compatibility:{forge:['>=0.6.1 <0.7.0']}};
 assert(!compatibility(pinned,versions).compatible);
 assert(compatibility(pinned,{...versions,forge:'0.6.3',apiVersion:4}).compatible);
 const latest={...manifest(),apiVersion:5};
 assert(compatibility(latest,versions).compatible);
 for(const apiVersion of [1,2,3,4])assert(!compatibility(latest,{...versions,apiVersion}).compatible);
});
