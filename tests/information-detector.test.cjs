'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InformationStats, analyze, assess } = require('../runtime/information-stats.cjs');
const { bank, modelClass, samplingContext, ENGINE_VERSION } = require('../runtime/information-modeltrace.cjs');
const { providerIdentity, requiresAccount } = require('../runtime/information-identity.cjs');
const fixtures = require('./fixtures/information-lm-detector.json');
const outputs = fixtures[0].outputs;
const context = { threadId: 'first', model: 'gpt-6-astra', provider: 'custom', effort: 'low', providerKey: 'channel-one' };
function harness(t, runner = async () => outputs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-information-v2-'));
  let enabled = false, now = Date.parse('2026-11-12T06:00:00Z'), calls = 0;
  const options = { root, codexHome: root, now: () => now, settings: () => ({ autoDetect: enabled }),
    probeRunner: async args => { calls++; return runner(args); } };
  const create = () => {
    const service = new InformationStats(options);
    service.readMetrics = async () => ({ found: true, phase: 'idle', model: context.model });
    return service;
  };
  const service = create();
  t.after(() => { service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, create, root, enable(value = true) { enabled = value; service.settingsChanged(); },
    advance(ms) { now += ms; }, calls: () => calls,
    async finish(threadId = context.threadId) { await service.jobs.get(threadId)?.work; } };
}

test('the pinned 69-class offline ranker scores complete reference fixtures', () => {
  assert.equal(bank.models.length, 69);
  assert.equal(bank.models.reduce((sum, model) => sum + model.response_count, 0), 2560);
  for (const item of fixtures) {
    const result = analyze(item.outputs);
    assert.equal(result.prediction, item.model);
    assert.equal(result.method, 'shared-detector-v2');
    assert.equal(result.used_outputs, 3);
    assert.equal(result.results.length, 69);
    assert(result.probability > 0.9);
    assert(Math.abs(result.results.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-9);
  }
});

test('Sol and Astra share a class, while old Claude spellings resolve without merging other GPTs', () => {
  assert.equal(modelClass('GPT_6.1-SOL').id, 'gpt-6-astra');
  assert.equal(modelClass('claude-haiku-4-5-20251001').id, 'claude-haiku-4.5');
  assert.equal(modelClass('claude-opus-5-5').id, 'claude-opus-5.5');
  assert.notEqual(modelClass('gpt-6-sol').id, modelClass('gpt-6.1-sol').id);
  const result = samplingContext(analyze(outputs), 'gpt-6.1-sol', 'low', true);
  assert.equal(assess('gpt-6.1-sol', result).verdict, 'SHARED');
  assert.equal(assess('gpt-6-astra', result).warning, false);
});

test('different or unknown reasoning effort hides probabilities and cannot raise a mismatch warning', () => {
  const result = analyze(outputs);
  for (const effort of ['high', 'xhigh', '']) {
    const conditioned = samplingContext(result, 'gpt-6.1-terra', effort, true);
    assert.equal(conditioned.probability, null);
    assert(conditioned.results.every(item => item.probability === null));
    assert.equal(assess('gpt-6.1-terra', conditioned).verdict, 'REFERENCE_ONLY');
    assert.equal(assess('gpt-6.1-terra', conditioned).warning, false);
  }
  const comparable = samplingContext(result, 'gpt-6.1-terra', 'low', true);
  assert.equal(assess('gpt-6.1-terra', comparable).verdict, 'MISMATCH');
});

test('partial answers retain ranking but never manufacture a calibrated probability', () => {
  const result = analyze(outputs.slice(0, 1));
  assert.equal(result.decision, 'partial');
  assert.equal(result.probability, null);
  assert.equal(result.results.length, 69);
  assert(result.results.every(item => item.probability === null));
});

test('generated sequences and legacy results are never treated as current identity evidence', () => {
  const generated = analyze([{ text: JSON.stringify(Array.from({ length: 300 }, (_, i) => i % 355 + 1)), expected_count: 300 }]);
  assert.equal(generated.decision, 'not_model');
  assert.equal(assess(context.model, generated).verdict, 'INVALID_SAMPLE');
  assert.equal(assess(context.model, { results: [{ model: context.model, probability: 1 }] }).verdict, 'LEGACY');
  assert.equal(assess('gpt-new-model', null).verdict, 'UNLISTED');
  assert.equal(assess('gpt-6.1-sol', null).verdict, 'NO_SAMPLE');
});

test('external pasted answers do not claim the standard challenge calibration', async t => {
  const h = harness(t);
  const value = await h.service.dispatch('analyze', { outputs }, context);
  assert.equal(value.fingerprint.verdict, 'REFERENCE_ONLY');
  assert.equal(value.fingerprint.sampling.standardChallenge, false);
  assert.equal(h.calls(), 0);
});

test('channel identity changes with endpoint, credential or account without returning those values', () => {
  const config = { model_providers: { custom: { base_url: 'https://one.example', env_key: 'TEST_SECRET' } } };
  const one = providerIdentity(config, 'custom', null, { TEST_SECRET: 'secret-one' });
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.notEqual(one, providerIdentity(config, 'custom', null, { TEST_SECRET: 'secret-two' }));
  assert.notEqual(one, providerIdentity({ model_providers: { custom: { ...config.model_providers.custom, base_url: 'https://two.example' } } }, 'custom', null, { TEST_SECRET: 'secret-one' }));
  assert.notEqual(providerIdentity({}, 'openai', { account: { type: 'chatgpt', email: 'one@example' } }, {}), providerIdentity({}, 'openai', { account: { type: 'chatgpt', email: 'two@example' } }, {}));
  assert.equal(providerIdentity({}, 'unknown', null), '');
  assert.equal(providerIdentity({}, 'openai', { account: { type: 'apiKey' } }, {}), '');
});

test('automatic detection is off by default and waits for idle, known channel settings', async t => {
  const h = harness(t);
  await h.service.automatic(context);
  assert.equal(h.calls(), 0);
  h.enable();
  await h.service.automatic({ ...context, providerKey: '' });
  await h.service.automatic({ ...context, nativeIdle: false });
  h.service.readMetrics = async () => ({ found: true, phase: 'generating' });
  await h.service.automatic(context);
  assert.equal(h.calls(), 0);
});

test('automatic samples are shared across chats and process instances for 24 hours', async t => {
  const h = harness(t); h.enable();
  await h.service.automatic(context); await h.finish();
  assert.equal(h.calls(), 1);
  const other = { ...context, threadId: 'second' };
  assert.equal((await h.service.snapshot(other)).fingerprint.reused, true);
  await h.service.automatic(other);
  const restarted = h.create();
  await restarted.automatic(other);
  assert.equal(h.calls(), 1);
  h.advance(24 * 60 * 60 * 1000 + 1);
  await h.service.automatic(other); await h.finish('second');
  assert.equal(h.calls(), 2);
  assert.equal((await h.service.snapshot(other)).fingerprint.source, 'auto');
});

test('effort, endpoint identity and model changes cannot reuse another configuration result', async t => {
  const seen = [], h = harness(t, async args => { seen.push(args.effort); return outputs; }); h.enable();
  await h.service.automatic(context); await h.finish();
  for (const change of [{ effort: 'xhigh' }, { providerKey: 'channel-two' }, { model: 'gpt-6.1-sol' }]) {
    const next = { ...context, ...change, threadId: 'different' };
    assert.equal((await h.service.snapshot(next)).fingerprint.reused, false);
    await h.service.automatic(next); await h.finish('different');
  }
  assert.deepEqual(seen, ['low', 'xhigh', 'low', 'low']);
});

test('failed automatic attempts survive restart and cool down; manual retry remains available', async t => {
  const h = harness(t, async () => { throw Error('fixture failure'); }); h.enable();
  await h.service.automatic(context); await h.finish();
  assert.equal(h.service.publicJob('first').status, 'failed');
  await h.create().automatic(context);
  assert.equal(h.calls(), 1);
  await h.service.dispatch('probe', {}, context); await h.finish();
  assert.equal(h.calls(), 2);
});

for (const trigger of ['setting', 'turn', 'navigation']) test('automatic cancellation on ' + trigger + ' cannot save a late result', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(t, async () => { started(); return new Promise(resolve => { finish = resolve; }); }); h.enable();
  await h.service.automatic(context); await ready;
  if (trigger === 'setting') h.enable(false);
  else if (trigger === 'turn') h.service.observeNotification('turn/started', { threadId: 'another', turn: { id: 'running' } });
  else h.service.cancelAutomatic('first');
  finish(outputs); await h.finish();
  assert.equal(h.service.publicJob('first').status, 'cancelled');
  assert.equal((await h.service.records('first')).length, 0);
});

test('late duplicate lifecycle events cannot make a running task eligible for automatic sampling', async t => {
  const h = harness(t); h.enable();
  h.service.observeNotification('turn/started', { threadId: 'first', turn: { id: 'old' } });
  h.service.observeNotification('turn/completed', { threadId: 'first', turn: { id: 'old' } });
  h.service.observeNotification('turn/started', { threadId: 'first', turn: { id: 'new' } });
  h.service.observeNotification('turn/completed', { threadId: 'first', turn: { id: 'old' } });
  await h.service.automatic(context);
  assert.equal(h.calls(), 0);
  h.service.observeNotification('turn/completed', { threadId: 'first', turn: { id: 'new' } });
  h.service.observeNotification('turn/started', { threadId: 'first', turn: { id: 'old' } });
  await h.service.automatic(context); await h.finish();
  assert.equal(h.calls(), 1);
});

test('manual detection still runs with automatic detection off and preserves xhigh', async t => {
  const seen = [], h = harness(t, async args => { seen.push(args.effort); return outputs; });
  await h.service.dispatch('probe', {}, { ...context, effort: 'xhigh' }); await h.finish();
  const snapshot = await h.service.snapshot({ ...context, effort: 'xhigh' });
  assert.deepEqual(seen, ['xhigh']);
  assert.equal(snapshot.fingerprint.verdict, 'REFERENCE_ONLY');
  assert.equal(snapshot.automatic.enabled, false);
  assert.equal(JSON.stringify(snapshot).includes('providerKey'), false);
});

test('a result copied under the wrong channel cache key cannot be reused', async t => {
  const h = harness(t); h.enable();
  await h.service.automatic(context); await h.finish();
  const other = { ...context, providerKey: 'different-account', threadId: 'second' };
  const file = path.join(h.root, 'configuration-cache.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].key = h.service.cacheKey(other);
  fs.writeFileSync(file, JSON.stringify(rows));
  assert.equal((await h.service.snapshot(other)).fingerprint.prediction, null);
});

test('an incomplete or malformed cache result does not break the statistics panel', async t => {
  const h = harness(t); h.enable();
  await h.service.automatic(context); await h.finish();
  const file = path.join(h.root, 'configuration-cache.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  rows[0].result.analysis.results = {};
  fs.writeFileSync(file, JSON.stringify(rows));
  const snapshot = await h.service.snapshot({ ...context, threadId: 'second' });
  assert.equal(snapshot.fingerprint.prediction, null);
  assert.equal(snapshot.fingerprint.reused, false);
});

test('a fresh user submission defers automatic work even before its native start notification', async t => {
  const h = harness(t); h.enable();
  h.service.userSubmitted();
  await h.service.automatic(context);
  assert.equal(h.calls(), 0);
  h.advance(5001);
  await h.service.automatic(context); await h.finish();
  assert.equal(h.calls(), 1);
});

test('custom endpoints that use OpenAI login also require an identifiable account', () => {
  const config = { model_providers: { custom: { base_url: 'https://fixture.example', requires_openai_auth: true } } };
  assert.equal(requiresAccount(config, 'custom'), true);
  assert.equal(providerIdentity(config, 'custom', null, {}), '');
  const account = { account: { type: 'chatgpt', email: 'fixture@example' } };
  assert.match(providerIdentity(config, 'custom', account, {}), /^[a-f0-9]{64}$/);
});

test('old Astra histories stay visible without being presented as the new shared class', async t => {
  const h = harness(t);
  await h.service.save(context, { prediction: 'gpt-6-astra', probability: 1,
    results: [{ model: 'gpt-6-astra', score: 1, probability: 1 }] }, 'probe');
  const value = await h.service.snapshot(context);
  assert.equal(value.fingerprint.verdict, 'LEGACY');
  assert.equal(value.fingerprint.sharedClass, false);
  assert.equal(value.fingerprint.probability, null);
  assert.equal(value.fingerprint.warning, false);
});
