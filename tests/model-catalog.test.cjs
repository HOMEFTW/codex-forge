const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareModelCatalog } = require('../runtime/model-catalog.cjs');

test('unreadable Fast settings clear inherited catalog and Fast startup flags', () => {
  const { applyFastModelSettings } = require('../runtime/model-catalog.cjs');
  const env = { CODEX_FORGE_MODEL_CATALOG: 'stale.json', CODEX_FORGE_FAST: '1', CODEX_FORGE_SPEED: 'fast' };
  const registry = { status: () => ({ enabled: true }), settings: () => { throw Error('invalid settings'); } };
  assert.throws(() => applyFastModelSettings({ registry, env }), /invalid settings/);
  assert.deepEqual(env, { CODEX_FORGE_FAST: '0', CODEX_FORGE_SPEED: 'native' });
});
test('Forge supplies 500K only to 6.1-sol without changing the source catalog or config', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-models-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = { models: [{ slug: 'gpt-6-sol', context_window: 272000, max_context_window: 872000, supported_reasoning_levels: [{ effort: 'high' }] }, { slug: 'other', context_window: 128000 }] };
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(source));
  const result = prepareModelCatalog({ codexHome: home });
  const catalog = JSON.parse(fs.readFileSync(result.path));
  assert.deepEqual(catalog.models.slice(0, 2), source.models);
  assert.equal(catalog.models[2].context_window, 500000);
  assert.equal(catalog.models[2].effective_context_window_percent, 95);
  const terra = catalog.models.find(model => model.slug === 'gpt-6.1-terra');
  assert.equal(terra.visibility, 'list');
  assert.equal(terra.supported_in_api, true);
  assert.equal(terra.context_window, 272000, 'Terra must not inherit the Sol-only 500K override');
  assert.deepEqual(terra.service_tiers.map(tier => tier.id), ['priority']);
  assert.equal(result.effectiveWindow, 475000);
  assert.equal(result.derived, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'))), source);
  fs.writeFileSync(path.join(home, 'custom.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', context_window: 100000, display_name: 'Custom Sol', instructions: 'custom' }] }));
  fs.writeFileSync(path.join(home, 'config.toml'), "model_catalog_json = 'custom.json'\n[profiles.test]\nmodel_catalog_json = 'ignored.json'\n");
  const custom = prepareModelCatalog({ codexHome: home });
  assert.equal(custom.derived, false);
  const model = JSON.parse(fs.readFileSync(custom.path)).models[0];
  assert.equal(model.context_window, 500000);
  assert.equal(model.instructions, 'custom');
  assert.equal(model.display_name, 'Custom Sol');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'custom.json'))).models[0].context_window, 100000);
});

test('Terra uses compatible Terra capabilities, current reasoning levels and an explicit Fast tier', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-terra-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = { models: [
    { slug: 'gpt-6-sol', context_window: 272000, base_instructions: 'Sol template' },
    { slug: 'gpt-5.6-terra', display_name: 'Old Terra', description: 'Old description', context_window: 272000,
      base_instructions: 'Terra template', default_reasoning_level: 'ultra',
      supported_reasoning_levels: [{ effort: 'ultra' }], service_tiers: [{ id: 'priority', name: 'Fast', description: 'Old speed claim' }],
      upgrade: { model: 'old-replacement' }, availability_nux: { message: 'Old announcement' } },
  ] };
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(source));
  const result = prepareModelCatalog({ codexHome: home });
  const models = JSON.parse(fs.readFileSync(result.path)).models;
  const terra = models.find(model => model.slug === 'gpt-6.1-terra');
  assert.equal(terra.display_name, 'GPT-6.1-Terra');
  assert.equal(terra.base_instructions, 'Terra template');
  assert.equal(terra.default_reasoning_level, 'medium');
  assert.deepEqual(terra.supported_reasoning_levels.map(level => level.effort), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(terra.upgrade, null);
  assert.equal(terra.availability_nux, null);
  assert.equal(terra.context_window, 272000);
  assert.deepEqual(terra.service_tiers.map(tier => tier.id), ['priority']);
  assert.notEqual(terra.service_tiers[0].description, 'Old speed claim');
  assert.deepEqual(models.slice(0, 2), source.models);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'))), source);
});

test('an existing Terra descriptor keeps custom capabilities and tiers without requiring a Sol entry', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-terra-native-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = { slug: 'gpt-6.1-terra', display_name: 'My Terra', visibility: 'hide', supported_in_api: false,
    context_window: 128000, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }],
    service_tiers: [{ id: 'flex', name: 'Flex', description: 'Custom tier' }], instructions: 'custom' };
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [target] }));
  const result = prepareModelCatalog({ codexHome: home });
  const { models } = JSON.parse(fs.readFileSync(result.path));
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], { ...target, visibility: 'list', supported_in_api: true, service_tiers: [...target.service_tiers, models[0].service_tiers[1]] });
  assert.equal(models[0].service_tiers[1].id, 'priority');
  assert.equal(result.contextWindow, null, 'Do not claim a Sol overlay when Sol is absent');
  const repeated = prepareModelCatalog({ codexHome: home, catalogPath: result.path });
  assert.deepEqual(JSON.parse(fs.readFileSync(repeated.path)).models, models);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'))).models, [target]);
});

test('an existing Terra Fast tier and unrelated catalogs are preserved without being rewritten', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-terra-tiers-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const target = { slug: 'gpt-6.1-terra', visibility: 'list', supported_in_api: true, context_window: 128000,
    service_tiers: [{ id: 'priority', name: 'Provider Fast', description: 'Provider terms' }] };
  const source = path.join(home, 'models_cache.json');
  fs.writeFileSync(source, JSON.stringify({ models: [target] }));
  const result = prepareModelCatalog({ codexHome: home });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.path)).models, [target]);
  const unrelated = JSON.stringify({ models: [{ slug: 'unrelated', context_window: 10000 }] });
  fs.writeFileSync(source, unrelated);
  const preserved = prepareModelCatalog({ codexHome: home });
  assert.deepEqual(JSON.parse(fs.readFileSync(preserved.path)).models, JSON.parse(unrelated).models);
  assert.equal(fs.readFileSync(source, 'utf8'), unrelated);
});

test('visibility hides picker entries without removing their descriptors or exposing native hidden models', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-visibility-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = { models: [{ slug: 'gpt-6-sol', visibility: 'list', context_window: 272000 }, { slug: 'internal', visibility: 'hide', instructions: 'internal' }] };
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(source));
  const { modelOptions } = require('../runtime/model-catalog.cjs');
  const settings = { enableTerra: true, hiddenModels: ['gpt-6-sol', 'gpt-6.1-terra'] };
  const result = prepareModelCatalog({ codexHome: home, settings });
  const models = JSON.parse(fs.readFileSync(result.path)).models;
  assert.equal(models.length, 4);
  assert.equal(models.find(m => m.slug === 'gpt-6-sol').visibility, 'hide');
  assert.equal(models.find(m => m.slug === 'gpt-6.1-terra').visibility, 'hide');
  assert.deepEqual(models.find(m => m.slug === 'internal'), source.models[1]);
  assert.deepEqual(modelOptions({ codexHome: home, settings }).map(m => m.id), ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'))), source);
  const reset = prepareModelCatalog({ codexHome: home, settings: { ...settings, hiddenModels: [] } });
  assert.equal(JSON.parse(fs.readFileSync(reset.path)).models.find(m => m.slug === 'gpt-6-sol').visibility, 'list');
});

test('saving rejects an empty picker while startup recovers if a refreshed catalog removes the last visible model', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-empty-picker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'provider-model', visibility: 'list' }] }));
  const settings = { enableTerra: false, hiddenModels: ['provider-model'] };
  const { validateModelSelection } = require('../runtime/model-catalog.cjs');
  assert.throws(() => validateModelSelection(settings, { codexHome: home }), /至少保留/);
  const result = prepareModelCatalog({ codexHome: home, settings });
  assert.equal(result.visibilityFallback, true);
  assert.equal(JSON.parse(fs.readFileSync(result.path)).models[0].visibility, 'list');
});

test('the Fast plugin owns Terra, visibility and speed settings across disable and re-enable', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fast-plugin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'list', context_window: 272000 }] }));
  const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
  const { applyFastModelSettings } = require('../runtime/model-catalog.cjs');
  const config = require('../forge.config.json');
  const options = { root: path.join(home, 'forge'), codexHome: home, bundledRoot: path.join(__dirname, '../plugins'), versions: { codex: config.codexVersion, forge: config.version, apiVersion: config.apiVersion } };
  const registry = new ForgeRegistry(options), env = {};
  assert.deepEqual(registry.settings('forge.fast'), { defaultSpeed: 'fast', enableTerra: true, hiddenModels: [] });
  registry.settings('forge.fast', { defaultSpeed: 'native', enableTerra: true, hiddenModels: ['gpt-6-sol'] });
  let result = applyFastModelSettings({ registry, codexHome: home, env });
  let models = JSON.parse(fs.readFileSync(result.path)).models;
  assert.equal(models.find(m => m.slug === 'gpt-6-sol').visibility, 'hide');
  assert(models.some(m => m.slug === 'gpt-6.1-terra'));
  assert.equal(env.CODEX_FORGE_FAST, '1'); assert.equal(env.CODEX_FORGE_SPEED, 'native');
  assert.equal(env.CODEX_FORGE_MODEL_CATALOG, result.path);
  assert.throws(() => registry.settings('forge.fast', { hiddenModels: models.map(m => m.slug) }), /至少保留/);
  assert.deepEqual(registry.settings('forge.fast').hiddenModels, ['gpt-6-sol']);
  registry.setEnabled('forge.fast', false);
  result = applyFastModelSettings({ registry, codexHome: home, env });
  models = JSON.parse(fs.readFileSync(result.path)).models;
  assert(!models.some(m => m.slug === 'gpt-6.1-terra'));
  assert.equal(models.find(m => m.slug === 'gpt-6-sol').visibility, 'list');
  assert.equal(models.find(m => m.slug === 'gpt-6.1-sol').context_window, 500000);
  assert.equal(env.CODEX_FORGE_FAST, '0');
  registry.setEnabled('forge.fast', true);
  const reloaded = new ForgeRegistry(options);
  result = applyFastModelSettings({ registry: reloaded, codexHome: home, env });
  assert.equal(JSON.parse(fs.readFileSync(result.path)).models.find(m => m.slug === 'gpt-6-sol').visibility, 'hide');
  reloaded.settings('forge.fast', { enableTerra: false });
  result = applyFastModelSettings({ registry: reloaded, codexHome: home, env });
  assert(!JSON.parse(fs.readFileSync(result.path)).models.some(m => m.slug === 'gpt-6.1-terra'));
  fs.rmSync(path.join(home, 'models_cache.json'));
  assert.throws(() => applyFastModelSettings({ registry: reloaded, codexHome: home, env }), /未找到模型目录/);
  assert.equal(env.CODEX_FORGE_MODEL_CATALOG, undefined);
});

test('both native network adapters forward the generated catalog as a model catalog override', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/build-client.mjs'), 'utf8');
  const vm = require('node:vm');
  const { patchModelCatalogArgs } = await import('../scripts/native-fast-patch.mjs');
  assert.throws(() => patchModelCatalogArgs('changed source'));
  const values = [...source.matchAll(/^\s+([?:]) '(function (?:Oc|rc)\(\)\{.*)'[;]?$/gm)];
  assert.equal(values.length, 2);
  for (const match of values) {
    const replacement = vm.runInNewContext("'" + match[2] + "'");
    const patched = patchModelCatalogArgs(replacement);
    const scope = { process: { env: { CODEX_FORGE_MODEL_CATALOG: 'D:/fixture/catalog.json' }, resourcesPath: 'D:/app/resources' }, tc: [], ec: [], Os: [], ks: [] };
    const args = vm.runInNewContext('(' + patched + ')()', scope);
    assert(args.includes('model_catalog_json="D:/fixture/catalog.json"'));
    assert(!args.some(arg => arg.startsWith('model_context_window=')), 'no global per-model limit leak');
  }
});
