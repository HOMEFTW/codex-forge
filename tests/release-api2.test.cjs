const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { validate } = require('../runtime/forge-manifest.cjs');
const { validateRelease, checkUpdates, matchUpdate } = require('../runtime/forge-updates.cjs');
const root = path.resolve(__dirname, '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const config = read('forge.config.json');
const versions = { codex: config.codexVersion, forge: config.version, apiVersion: config.apiVersion };

test('0.3.0 release metadata, API 2 SDK, adapters, bundle and builtins agree', t => {
  assert.equal(config.version, '0.3.0'); assert.equal(config.apiVersion, 2);
  assert.equal(read('package.json').version, config.version);
  const lock = read('package-lock.json');
  assert.equal(lock.version, config.version); assert.equal(lock.packages[''].version, config.version);
  for (const name of fs.readdirSync(path.join(root, 'adapters'))) {
    const adapter = read('adapters/' + name);
    assert.equal(adapter.forgeVersion, config.version); assert.equal(adapter.apiVersion, config.apiVersion);
  }
  assert.equal(read('sdk/plugin.schema.json').properties.apiVersion.const, config.apiVersion);
  const window = { parent: { postMessage() {} }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'runtime/forge-sdk.js'), 'utf8'), { window, parent: window.parent, setTimeout() {}, clearTimeout() {} });
  assert.equal(window.CodexForge.apiVersion, config.apiVersion);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registry = new ForgeRegistry({ root: home, bundledRoot: path.join(root, 'plugins'), versions });
  const state = registry.list(); assert.deepEqual(state.errors, []); assert.equal(state.plugins.length, 9);
  for (const plugin of state.plugins) {
    assert.equal(plugin.apiVersion, config.apiVersion); assert.equal(plugin.version, config.version);
    assert.equal(plugin.enabled, true, plugin.id + ': ' + plugin.reasons.join(';'));
  }
  assert.equal(read('bundles/forge.builtin/bundle.json').version, config.version);
  assert.deepEqual(read('bundles/forge.builtin/bundle.patch.json').entries.map(item => item.id).sort(), state.plugins.map(item => item.id).sort());
  assert.equal(read('examples/hello-forge/plugin.json').apiVersion, 2);
});

test('API 1 manifests remain diagnosable while API 2 host refuses to enable them', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api1-migration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pluginRoot = path.join(home, 'plugins/test.legacy'); fs.mkdirSync(pluginRoot, { recursive: true });
  const manifest = { schemaVersion: 1, apiVersion: 1, id: 'test.legacy', name: 'Legacy', version: '1.0.0', compatibility: { codex: [config.codexVersion], forge: ['>=0.1.0 <0.4.0'] }, permissions: [] };
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify(manifest));
  assert.equal(validate(manifest, pluginRoot).apiVersion, 1);
  assert.throws(() => validate({ ...manifest, apiVersion: 3 }, pluginRoot), /API/);
  const registry = new ForgeRegistry({ root: home, bundledRoot: path.join(home, 'empty'), versions });
  assert.deepEqual(registry.list().errors, []);
  assert.equal(registry.status(manifest.id).enabled, false);
  assert.match(registry.status(manifest.id).reasons.join(';'), /需要 Forge API 1，当前 2/);
  assert.throws(() => registry.setEnabled(manifest.id, true), /需要 Forge API 1/);
  assert.equal(readLegacy().apiVersion, 1);
  function readLegacy() { return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')); }
});

test('mixed API 1/API 2 release history does not block API 2 update discovery', async () => {
  const repository = 'test/forge';
  const release = { schemaVersion: 3, platform: 'win32-x64', apiVersion: 2, forgeVersion: '0.3.0', codexVersion: config.codexVersion, codexBuildVersion: config.codexBuildVersion, repository, distribution: 'msi-portable', containsOfficialClient: false, url: 'https://github.com/test/forge/releases/download/v0.3.0/Forge.msi', sha256: 'a'.repeat(64), bytes: 100, portableUrl: 'https://github.com/test/forge/releases/download/v0.3.0/Forge.zip', portableSha256: 'b'.repeat(64), portableBytes: 200 };
  const legacy = { ...release, apiVersion: 1, forgeVersion: '0.2.0' };
  assert.equal(validateRelease(release, repository).apiVersion, 2);
  assert.equal(validateRelease(legacy, repository).apiVersion, 1);
  assert.throws(() => validateRelease({ ...release, apiVersion: 3 }, repository), /格式不兼容/);
  const feed = [release, legacy].map(item => ({ assets: [{ name: 'codex-forge-release.json', browser_download_url: 'https://github.com/test/forge/releases/download/v' + item.forgeVersion + '/codex-forge-release.json' }] }));
  const oldConfig = { ...config, version: '0.2.0', apiVersion: 1, githubRepository: repository };
  const result = await checkUpdates({ config: oldConfig, plugins: [], readJSON: async url => url.includes('windows-store-update') ? { schemaVersion: 1, packageIdentity: 'OpenAI.Codex', storeProductId: '9PLM9XGG6VKS', buildVersion: config.codexBuildVersion } : url.includes('api.github.com') ? feed : url.includes('/v0.3.0/') ? release : legacy });
  assert.equal(result.plan.forgeVersion, '0.3.0'); assert.equal(result.plan.apiVersion, 2);
  const external = { id: 'test.legacy', name: 'Legacy', apiVersion: 1, compatibility: { codex: [config.codexVersion], forge: ['>=0.1.0 <0.4.0'] } };
  const blocked = matchUpdate({ config: oldConfig, plugins: [external], releases: [release] });
  assert.equal(blocked.plan, null); assert.match(blocked.candidates[0].reasons.join(';'), /当前 2/);
});
