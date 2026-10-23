const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { metadataToml, claudeMetadata, grokMetadata, dshMetadata } = require('../runtime/agent-capabilities.cjs');

function directory(t) { const base = path.resolve(__dirname, '../output/capability-tests'); fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'case-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('Grok metadata accepts inline and table-array efforts per model without returning auth or endpoint fields', t => {
  const root = directory(t), dir = path.join(root, '.grok'); fs.mkdirSync(dir);
  const source = `[models]
default = 'grok-4.7'
default_reasoning_effort = "high"
[model."grok-4.7"]
model = "wire-model"
name = "Grok # local"
api_key = "sk-fixture-private-value"
base_url = "https://private.invalid/secret"
[[model."grok-4.7".reasoning_efforts]]
id = "low"
value = "low"
[[model."grok-4.7".reasoning_efforts]]
id = 'high'
default = true
[model.fast]
model = "fast-wire"
supports_reasoning_effort = false
reasoning_efforts = [{ id = "high" }]
[model.custom]
reasoning_efforts = [
  { id = "medium", label = "Balanced" },
  { id = "xhigh", label = "Max" }, # comma is valid TOML
]
`;
  fs.writeFileSync(path.join(dir, 'config.toml'), source);
  const before = fs.readFileSync(path.join(dir, 'config.toml'));
  const value = grokMetadata({}, '--model --reasoning-effort --resume', { home: root, env: {} });
  assert.equal(value.defaultModel, 'grok-4.7'); assert.equal(value.defaultReasoningEffort, 'high');
  assert.deepEqual(value.models.find(x => x.id === 'grok-4.7').reasoningEfforts, ['low', 'high']);
  assert.deepEqual(value.models.find(x => x.id === 'fast').reasoningEfforts, []);
  assert.deepEqual(value.models.find(x => x.id === 'custom').reasoningEfforts, ['medium', 'xhigh']);
  assert.equal(value.models[0].label, 'Grok # local');
  assert(!JSON.stringify(value).includes('sk-fixture')); assert(!JSON.stringify(value).includes('private.invalid'));
  assert(!Object.hasOwn(metadataToml(source).get('model.grok-4.7'), 'api_key'));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'config.toml')), before);
});

test('Claude discovery exposes configured model names and the installed CLI effort choices only', t => {
  const root = directory(t), dir = path.join(root, '.claude'); fs.mkdirSync(dir);
  const original = JSON.stringify({ model: 'configured-model', effortLevel: 'medium', availableModels: ['approved-one'], env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider-opus', ANTHROPIC_API_KEY: 'sk-fixture-private-value', ANTHROPIC_BASE_URL: 'https://private.invalid' } });
  fs.writeFileSync(path.join(dir, 'settings.json'), original);
  const value = claudeMetadata({}, "--model <id> e.g. 'sonnet' or 'opus'\n--effort <level> Effort level for this session (low, high)\n--resume <id>", { home: root, env: {} });
  assert.deepEqual(value.reasoningEfforts, ['low', 'high']);
  assert.deepEqual(value.models.map(x => x.id), ['configured-model', 'provider-opus', 'approved-one', 'opus', 'sonnet']);
  assert(!JSON.stringify(value).includes('sk-fixture')); assert(!JSON.stringify(value).includes('private.invalid'));
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original);
  assert.deepEqual(claudeMetadata({}, '--model <id>', { home: root, env: {} }).reasoningEfforts, []);
});

test('DSH source discovery never invokes a profile or evaluates its config expressions', t => {
  const root = directory(t), base = path.join(root, 'dsh'), deps = path.join(base, 'node_modules/@deepseek-ai'); fs.mkdirSync(deps, { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' })); fs.mkdirSync(path.join(base, 'lib')); fs.writeFileSync(path.join(base, 'lib/bin.js'), 'throw new Error("must not execute")');
  for (const name of ['dsh-headless', 'dsh-llm-deepseek', 'dsh-agent-default-model']) fs.mkdirSync(path.join(deps, name, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(deps, 'dsh-headless/lib/startup.js'), 'description: --json; --session-id; - reads stdin');
  fs.writeFileSync(path.join(deps, 'dsh-agent-default-model/lib/index.js'), 'reasoningEffort');
  fs.writeFileSync(path.join(deps, 'dsh-llm-deepseek/lib/index.js'), `const DEFAULT_MODELS = [{id:"official-model",name:"Official"}]; const OFF_REASONING_EFFORT = ReasoningEffortId("off"); const HIGH_REASONING_EFFORT = ReasoningEffortId("high");`);
  const value = dshMetadata({ profile: 'headless' }, { source: path.join(base, 'lib/bin.js') }, { home: root, env: {} });
  assert.equal(value.protocolVerified, true); assert.equal(value.supportsResume, true); assert.deepEqual(value.models.map(x => x.id), ['official-model']); assert.deepEqual(value.reasoningEfforts, ['off', 'high']);
  assert(!fs.existsSync(path.join(root, '.dsh')));
});
