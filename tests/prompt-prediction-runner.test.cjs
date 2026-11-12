'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { lowPredictionWithRpc } = require('../runtime/prompt-prediction-runner.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ automatic = true, created = {} } = {}) {
  const listeners = new Set(), calls = [], stopped = [];
  const emit = (method, params) => { for (const fn of listeners) fn({ method, params: { threadId: 'child', ...params } }); };
  const options = { cwd: 'D:/fixture', sourceThreadId: 'source', model: 'gpt-6-astra', modelProvider: 'fixture', serviceTier: 'priority', prompt: 'Predict the next user message.', maxChars: 320,
    stop: error => stopped.push(error), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { fast_canvas: { command: 'must not run' }, other: { env: { PRIVATE: 'never forward' } } } } };
      if (method === 'thread/start') return { thread: { id: 'child', ephemeral: true }, model: 'gpt-6-astra', modelProvider: 'fixture', serviceTier: 'priority', reasoningEffort: 'low', ...created };
      if (method === 'turn/start') {
        if (automatic) setImmediate(() => { emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: '{"suggestion":"继续验证。"}' } }); emit('turn/completed', { turn: { id: 'turn', status: 'completed' } }); });
        return { turn: { id: 'turn' } };
      }
      assert.fail(method);
    } };
  return { options, calls, stopped, emit, listeners };
}

test('low prediction starts one tool-free ephemeral thread on the exact selected provider/model', async () => {
  const h = harness(); assert.equal(await lowPredictionWithRpc(h.options), '{"suggestion":"继续验证。"}');
  const created = h.calls.find(c => c.method === 'thread/start').params;
  assert.equal(created.model, 'gpt-6-astra'); assert.equal(created.modelProvider, 'fixture'); assert.equal(created.serviceTier, 'priority'); assert.equal(created.allowProviderModelFallback, false);
  assert.equal(created.ephemeral, true); assert.equal(created.experimentalRawEvents, true); assert.equal(created.approvalPolicy, 'never'); assert.equal(created.sandbox, 'read-only');
  assert.deepEqual(created.environments, []); assert.deepEqual(created.dynamicTools, []);
  assert.equal(created.config.model_reasoning_effort, 'low'); assert.equal(created.config['mcp_servers.fast_canvas.enabled'], false); assert.equal(created.config['mcp_servers.other.enabled'], false);
  assert.equal(created.config['features.shell_tool'], false); assert.equal(created.config['features.unified_exec'], false); assert.equal(created.config['features.hooks'], false); assert.equal(created.config['features.code_mode_host'], false);
  assert.equal(created.threadSource, 'forge_prompt_prediction'); assert(!JSON.stringify(created).includes('never forward'));
  const turn = h.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.threadId, 'child'); assert.equal(turn.effort, 'low'); assert.equal(turn.serviceTierForTurn, 'priority'); assert.equal(turn.turnTrigger, 'forge_prompt_prediction'); assert.equal(turn.outputSchema.additionalProperties, false);
  assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1); assert.equal(h.listeners.size, 0);
});

test('unconfirmed effort, provider, model or ephemeral identity stop before inference', async () => {
  for (const created of [{ reasoningEffort: 'xhigh' }, { model: 'other' }, { modelProvider: 'other' }, { thread: { id: 'source', ephemeral: true } }, { thread: { id: 'child', ephemeral: false } }, { thread: { id: 'child', ephemeral: true, path: 'persisted' } }, { thread: { id: 'child', ephemeral: true, forkedFromId: 'source' } }]) {
    const h = harness({ created }); await assert.rejects(lowPredictionWithRpc(h.options), { code: 'PREDICTION_UNAVAILABLE' }); assert(!h.calls.some(c => c.method === 'turn/start'));
  }
});

test('raw tool attempts stop the worker before accepting an answer or continuing', async () => {
  for (const type of ['function_call', 'custom_tool_call', 'web_search_call', 'function_call_output']) {
    const h = harness({ automatic: false }), pending = lowPredictionWithRpc(h.options); await tick();
    h.emit('rawResponseItem/completed', { item: { type } }); await assert.rejects(pending, { code: 'PREDICTION_TOOL_REQUESTED' });
    assert.equal(h.stopped.length, 1); assert.equal(h.calls.filter(c => c.method === 'turn/start').length, 1); assert.equal(h.listeners.size, 0);
  }
});

test('tool items and failed turns cannot become suggestions', async () => {
  for (const [method, params, code] of [['item/started', { item: { type: 'commandExecution' } }, 'PREDICTION_TOOL_REQUESTED'], ['turn/completed', { turn: { id: 'turn', status: 'failed' } }, 'PREDICTION_UNAVAILABLE']]) {
    const h = harness({ automatic: false }), pending = lowPredictionWithRpc(h.options); await tick(); h.emit(method, params); await assert.rejects(pending, { code }); assert.equal(h.stopped.length, 1);
  }
});

test('unrelated notifications are ignored and cancellation stops only the private worker', async () => {
  const h = harness({ automatic: false }), controller = new AbortController(), pending = lowPredictionWithRpc({ ...h.options, signal: controller.signal }); await tick();
  h.emit('turn/completed', { threadId: 'source', turn: { id: 'turn', status: 'completed' } }); assert.equal(h.stopped.length, 0);
  controller.abort(Object.assign(Error('cancelled'), { code: 'PREDICTION_CANCELLED' })); await assert.rejects(pending, { code: 'PREDICTION_CANCELLED' });
  assert.equal(h.stopped.length, 1); assert(!h.calls.some(c => c.method === 'turn/interrupt' && c.params.threadId === 'source'));
});

test('already cancelled workers cannot read configuration or start a thread', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(Object.assign(Error('cancelled'), { code: 'PREDICTION_CANCELLED' }));
  await assert.rejects(lowPredictionWithRpc({ ...h.options, signal: controller.signal }), { code: 'PREDICTION_CANCELLED' }); assert.equal(h.calls.length, 0);
});
