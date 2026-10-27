const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareModelCatalog } = require('../runtime/model-catalog.cjs');
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
