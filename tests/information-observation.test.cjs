const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CodexMetrics } = require('../runtime/information-stats.cjs');
function fixture() {
  const metrics = new CodexMetrics(); let seconds = 0;
  const line = (type, payload) => metrics.line(JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 27, 0, 0, seconds++)).toISOString(), type, payload }));
  line('session_meta', { id: 'test', model_provider: 'fixture' });
  return { metrics, line };
}
test('passive scanner distinguishes applied changes, hidden models and unexplained reasoning reductions', () => {
  const { metrics, line } = fixture();
  line('turn_context', { model: 'gpt-6.1-sol', effort: 'high', turn_id: 'a' });
  line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-sol', reasoning_effort: 'medium' } });
  line('turn_context', { model: 'gpt-6-sol', effort: 'medium', turn_id: 'b' });
  line('turn_context', { model: 'gpt-6-sol', collaboration_mode: { settings: { reasoning_effort: 'low' } }, turn_id: 'c' });
  line('turn_context', { model: 'gpt-reserve', effort: 'low', turn_id: 'd' });
  const observation = metrics.snapshot().observation;
  assert.equal(observation.turns, 4);
  assert.equal(observation.events.filter(event => event.severity === 'warning').length, 3);
  assert(observation.events.some(event => event.kind === 'internal_model'));
  assert(observation.events.some(event => event.kind === 'model_change' && event.severity === 'info'));
  assert.equal(metrics.effort, 'low');
});
test('context usage uses last request rather than cumulative tokens and warns only within one model', () => {
  const { metrics, line } = fixture();
  line('turn_context', { model: 'gpt-6.1-sol', effort: 'high' });
  const usage = window => line('event_msg', { type: 'token_count', info: { model_context_window: window, total_token_usage: { input_tokens: 4000000, output_tokens: 1000, total_tokens: 4001000 }, last_token_usage: { input_tokens: 100000, cached_input_tokens: 90000, output_tokens: 1000, total_tokens: 101000 } } });
  usage(475000); usage(258400);
  const speed = metrics.snapshot();
  assert.equal(speed.observation.contextUsed, 101000);
  assert.equal(speed.observation.contextWindow, 258400);
  assert.equal(speed.observation.warnings, 1);
  assert.equal(speed.cachedInputTokens, 90000);
  line('turn_context', { model: 'other', effort: 'high' });
  usage(128000);
  assert.equal(metrics.snapshot().observation.events.filter(event => event.kind === 'context_change').length, 1);
});
test('copied history never contributes passive warnings', () => {
  const { metrics, line } = fixture();
  metrics.line(JSON.stringify({ timestamp: '2026-10-26T00:00:00Z', type: 'turn_context', payload: { model: 'gpt-reserve', effort: 'low' } }));
  line('turn_context', { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(metrics.snapshot().observation.events.length, 0);
});

test('token normalization saturates numeric overflow instead of displaying zero', () => {
  const { metrics, line } = fixture();
  line('turn_context', { model: 'gpt-6.1-sol' });
  metrics.line('{"timestamp":"2026-10-27T00:00:03Z","type":"token_usage_record","payload":{"response_id":"overflow","usage":{"input_tokens":1e999,"output_tokens":12.9,"cached_input_tokens":-7}}}');
  assert.equal(metrics.snapshot().inputTokens, 1e12);
  assert.equal(metrics.snapshot().outputTokens, 12);
  assert.equal(metrics.snapshot().cachedInputTokens, 0);
});
