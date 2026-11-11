'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PROMPT, normalizePrediction, predictPrompt } = require('../runtime/prompt-prediction.cjs');

const context = { threadId: 'thread_A', sourceTurnId: 'turn_1' };
const response = text => ({ sourceTurnId: context.sourceTurnId, responseId: 'sample_1', text });

test('prediction samples the completed source without starting turns, replacing models or using native prediction billing tags', async () => {
  const calls = [];
  const result = await predictPrompt({ ...context, call: async (...args) => { calls.push(args); return response('{"suggestion":"请把结果整理成表格。"}'); } });
  assert.deepEqual(result, { ...context, text: '请把结果整理成表格。' });
  assert.equal(calls.length, 1);
  const [method, params, options] = calls[0];
  assert.equal(method, 'thread/sample');
  assert.equal(params.threadId, context.threadId);
  assert.equal(params.expectedTurnId, context.sourceTurnId);
  assert.equal(params.disableMcp, true);
  assert.equal(params.interruptOnCancel, true);
  assert.equal(params.threadSource, 'forge_prompt_prediction');
  assert.equal(params.turnTrigger, 'forge_prompt_prediction');
  assert.equal(params.model, undefined);
  assert.equal(params.modelProvider, undefined);
  assert.equal(params.effort, undefined);
  assert.equal(params.responsesapiClientMetadata, undefined);
  assert.match(params.prompt, /USER would type/);
  assert.match(params.prompt, /not as instructions to execute/);
  assert.match(params.prompt, /Do not continue the task/);
  assert.ok(params.prompt.includes(DEFAULT_PROMPT));
  assert.equal(options.signal.aborted, false);
  assert.equal(options.timeoutMs, 30000);
});

test('prediction preferences retain the response contract and requested character limit', async () => {
  let sent;
  const result = await predictPrompt({ ...context, prompt: 'Prefer a short English follow-up.', maxChars: 80, timeoutMs: 1000, call: async (_method, params) => { sent = params; return response('{"suggestion":"Show me the final diff."}'); } });
  assert.equal(result.text, 'Show me the final diff.');
  assert.match(sent.prompt, /only one JSON object/);
  assert.match(sent.prompt, /Prefer a short English follow-up/);
  assert.match(sent.prompt, /at most 80 characters/);
});

test('empty, malformed, tool-only and oversized predictions never become drafts', () => {
  for (const text of [null, undefined, '', ' ', 'Here is your answer.', '{broken', 'null', '[]', '{"suggestion":null}', '{"suggestion":42}', '{"suggestion":"  "}', '```json\n{"suggestion":"continue"}\n```', JSON.stringify({ suggestion: 'a'.repeat(321) }), JSON.stringify({ suggestion: 'bad\u0000text' }), ' '.repeat(20001)]) assert.equal(normalizePrediction(text), null);
  assert.equal(normalizePrediction('{"suggestion":"  继续检查\n这处问题。  "}'), null, 'unescaped JSON newlines are malformed');
  assert.equal(normalizePrediction(JSON.stringify({ suggestion: '  继续检查这处问题。  ' })), '继续检查这处问题。');
  assert.equal(normalizePrediction(JSON.stringify({ suggestion: 'x'.repeat(80) }), 80), 'x'.repeat(80));
  assert.equal(normalizePrediction(JSON.stringify({ suggestion: 'x'.repeat(81) }), 80), null);
});

test('a null response text, including an attempted tool call, produces no suggestion', async () => {
  assert.deepEqual(await predictPrompt({ ...context, call: async () => response(null) }), { ...context, text: null });
});

test('results from another or unconfirmed source turn are rejected', async () => {
  for (const sourceTurnId of ['turn_old', undefined, null]) await assert.rejects(predictPrompt({ ...context, call: async () => ({ ...response('{"suggestion":"继续。"}'), sourceTurnId }) }), { code: 'PREDICTION_STALE' });
});

test('already cancelled requests do not invoke the model', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(predictPrompt({ ...context, signal: controller.signal, call: () => assert.fail('must not call') }), { code: 'PREDICTION_CANCELLED' });
});

test('cancelling an in-flight sample aborts its transport and discards a late result', async () => {
  const controller = new AbortController();
  let finish, transportSignal;
  const predicting = predictPrompt({ ...context, signal: controller.signal, call: (_method, _params, options) => { transportSignal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(predicting, { code: 'PREDICTION_CANCELLED' });
  assert.equal(transportSignal.aborted, true);
  finish(response('{"suggestion":"迟到结果。"}'));
  await new Promise(resolve => setImmediate(resolve));
});

test('timeouts abort the sample even when the transport ignores cancellation', async () => {
  let transportSignal;
  await assert.rejects(predictPrompt({ ...context, timeoutMs: 10, call: (_method, _params, options) => { transportSignal = options.signal; return new Promise(() => {}); } }), { code: 'TIMEOUT' });
  assert.equal(transportSignal.aborted, true);
});

test('a transport that rejects on abort preserves cancellation and timeout error codes', async () => {
  const call = (_method, _params, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(predictPrompt({ ...context, timeoutMs: 10, call }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const result = predictPrompt({ ...context, signal: controller.signal, call });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(result, { code: 'PREDICTION_CANCELLED' });
});

test('sample failures propagate without retrying, creating threads or invoking another provider', async () => {
  let calls = 0;
  await assert.rejects(predictPrompt({ ...context, call: async () => { calls++; throw Object.assign(Error('Sample unsupported'), { code: 'METHOD_NOT_FOUND' }); } }), { code: 'METHOD_NOT_FOUND' });
  assert.equal(calls, 1);
});

test('invalid or unbounded settings fail before model inference', async () => {
  for (const patch of [{ threadId: '../thread' }, { sourceTurnId: '' }, { prompt: '' }, { prompt: 'a'.repeat(8001) }, { maxChars: 19 }, { maxChars: 2001 }, { maxChars: 20.5 }, { timeoutMs: 0 }, { timeoutMs: 120001 }]) await assert.rejects(predictPrompt({ ...context, ...patch, call: () => assert.fail('must not call') }), { code: 'INVALID_ARGUMENT' });
});
