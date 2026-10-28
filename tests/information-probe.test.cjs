'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { probeWithRpc } = require('../runtime/information-probe.cjs');

const context = { threadId: 'source_thread', model: 'gpt-6-sol', provider: 'fixture', effort: 'high', cwd: 'C:/project' };
function fixture({ turns = [{ id: 'completed_turn', status: 'completed' }], forkPatch, onFork, turnError, tool = false } = {}) {
  const calls = [], listeners = new Set();
  let forks = 0;
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { sample: { enabled: true } } } };
    if (method === 'thread/read') return { thread: params.threadId === context.threadId
      ? { id: context.threadId, path: 'C:/sessions/source.jsonl', ephemeral: false, model: context.model, modelProvider: context.provider }
      // The actual target CLI returns null here even when thread/fork provided the source ID.
      : { id: params.threadId, path: null, ephemeral: true, forkedFromId: null, model: context.model, modelProvider: context.provider, reasoningEffort: context.effort } };
    if (method === 'thread/turns/list') return { data: turns };
    if (method === 'thread/fork') {
      if (params.ephemeral && params.deferGoalContinuation) throw Error('`deferGoalContinuation` cannot be combined with `ephemeral`');
      const selected = turns.find(turn => turn.id === params.lastTurnId);
      if (selected?.id === 'active_turn') throw Error("lastTurnId 'active_turn' identifies an in-progress turn");
      const response = {
        model: context.model, modelProvider: context.provider, reasoningEffort: context.effort,
        thread: { id: 'fork_' + ++forks, ephemeral: true, path: null, forkedFromId: context.threadId },
      };
      forkPatch?.(response);
      onFork?.();
      return response;
    }
    if (method === 'turn/start') {
      if (turnError) throw Error(turnError);
      const id = 'turn_' + forks;
      const count = Number(params.input[0].text.match(/(?:choose |选择 )(\d+)/)[1]);
      setImmediate(() => {
        const emit = message => { for (const listener of listeners) listener(message); };
        if (tool) emit({ method: 'item/started', params: { threadId: params.threadId, turnId: id, item: { type: 'commandExecution' } } });
        else {
          emit({ method: 'item/completed', params: { threadId: params.threadId, turnId: id, item: { type: 'agentMessage', phase: 'final', text: JSON.stringify(Array.from({ length: count }, (_, i) => i % 355 + 1)) } } });
          emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed' } } });
        }
      });
      return { turn: { id } };
    }
    return {};
  };
  return {
    calls,
    run: extra => probeWithRpc({ ...context, call, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, ...extra }),
    listeners,
  };
}

test('probe forks an active saved conversation without pinning a disk-synthesized interrupted turn', async () => {
  const f = fixture({ turns: [{ id: 'active_turn', status: 'interrupted' }, { id: 'completed_turn', status: 'completed' }] });
  const outputs = await f.run();
  assert.equal(outputs.length, 3);
  const forks = f.calls.filter(call => call.method === 'thread/fork');
  assert.equal(forks.length, 3);
  for (const { params } of forks) {
    assert.equal(params.ephemeral, true);
    assert.equal(params.excludeTurns, true);
    assert.equal('deferGoalContinuation' in params, false);
    assert.equal('lastTurnId' in params, false);
    assert.equal('beforeTurnId' in params, false);
  }
  assert.equal(f.calls.some(call => call.method === 'thread/turns/list'), false);
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['fork_1', 'fork_2', 'fork_3']);
});

test('probe verifies the creation response instead of overwriting its fork lineage with thread/read nulls', async () => {
  const f = fixture();
  assert.equal((await f.run()).length, 3);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/read').map(call => call.params.threadId), [context.threadId]);
  assert.equal(f.listeners.size, 0);
});

test('probe needs no completed-turn lookup when the saved conversation has no finished turns', async () => {
  const f = fixture({ turns: [] });
  assert.equal((await f.run()).length, 3);
});

test('probe rejects unconfirmed or different effective settings and releases only its own temporary fork', async () => {
  for (const patch of [
    response => { response.model = 'gpt-5.6-sol'; },
    response => { response.modelProvider = 'other'; },
    response => { response.reasoningEffort = 'low'; },
    response => { response.reasoningEffort = null; },
    response => { response.thread.forkedFromId = 'other_thread'; },
  ]) {
    const f = fixture({ forkPatch: patch });
    await assert.rejects(f.run(), /模型设置|临时分支/);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['fork_1']);
    assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
  }
});

test('probe never unsubscribes the source thread or treats a durable thread as temporary', async () => {
  for (const patch of [
    response => { response.thread.id = context.threadId; },
    response => { response.thread.ephemeral = false; response.thread.path = 'C:/sessions/unexpected.jsonl'; },
  ]) {
    const f = fixture({ forkPatch: patch });
    await assert.rejects(f.run(), /临时分支/);
    assert.equal(f.calls.some(call => ['turn/start', 'turn/interrupt', 'thread/unsubscribe'].includes(call.method)), false);
  }
});

test('cancelling during fork creation releases the fork without starting a model turn', async () => {
  const controller = new AbortController();
  const f = fixture({ onFork: () => controller.abort() });
  await assert.rejects(f.run({ signal: controller.signal }), /取消/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['fork_1']);
  assert.equal(f.listeners.size, 0);
});

test('probe cleans up a failed turn and rejects tool use without retaining a sample', async () => {
  for (const options of [{ turnError: 'Provider unavailable' }, { tool: true }]) {
    const progress = [], f = fixture(options);
    await assert.rejects(f.run({ onProgress: count => progress.push(count) }), /Provider unavailable|工具/);
    assert.deepEqual(progress, []);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['fork_1']);
    assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), !!options.tool);
  }
});

test('probe process teardown closes every pipe even when a descendant holds the stream open', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
    kill() { this.exitCode = 0; this.emit('exit', 0); return true; },
  });
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    child.stdout.write(JSON.stringify({ id: request.id, error: { message: 'Fixture initialization rejected' } }) + '\n');
  });
  const module = { exports: {} };
  const runtimeRequire = require('node:module').createRequire(require.resolve('../runtime/information-probe.cjs'));
  vm.runInNewContext(fs.readFileSync(require.resolve('../runtime/information-probe.cjs'), 'utf8'), {
    module, process: { env: {} }, AbortController, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => child } : runtimeRequire(name),
  });
  try {
    await assert.rejects(module.exports.runInformationProbe({ ...context, executable: 'fixture.exe' }), /Fixture initialization rejected/);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});
