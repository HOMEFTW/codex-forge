'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { probeWithRpc } = require('../runtime/information-probe.cjs');

const context = { threadId: 'source_thread', model: 'gpt-6-sol', provider: 'fixture', effort: 'high', cwd: 'C:/project' };
function fixture({ startPatch, onStart, turnError, tool = false, itemType, completedOnly = false } = {}) {
  const calls = [], listeners = new Set();
  const probeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-probe-cwd-'));
  let threads = 0;
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { sample: { enabled: true } } } };
    if (method === 'thread/read') return { thread: params.threadId === context.threadId
      ? { id: context.threadId, path: 'C:/sessions/source.jsonl', ephemeral: false, model: context.model, modelProvider: context.provider }
      : null };
    if (method === 'thread/start') {
      assert.equal(params.threadId, undefined, 'probe threads never inherit the active thread');
      assert.equal(params.parentThreadId, undefined, 'probe threads never inherit a parent turn');
      assert.equal(params.cwd, probeCwd, 'probe threads use a clean directory without project instruction files');
      assert.equal(fs.existsSync(path.join(probeCwd, 'AGENTS.md')), false);
      const response = {
        model: context.model, modelProvider: context.provider, reasoningEffort: context.effort,
        thread: { id: 'probe_' + ++threads, ephemeral: true, path: null, forkedFromId: null, model: context.model, modelProvider: context.provider, reasoningEffort: context.effort },
      };
      startPatch?.(response);
      onStart?.();
      return response;
    }
    if (method === 'turn/start') {
      if (turnError) throw Error(turnError);
      const id = 'turn_' + threads;
      const count = Number(params.input[0].text.match(/\d+/)[0]);
      setImmediate(() => {
        const emit = message => { for (const listener of listeners) listener(message); };
        if (itemType) emit({ method: completedOnly ? 'item/completed' : 'item/started', params: { threadId: params.threadId, turnId: id, item: { type: itemType } } });
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
    run: async extra => {
      try { return await probeWithRpc({ ...context, probeCwd, call, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, ...extra }); }
      finally { fs.rmSync(probeCwd, { recursive: true, force: true }); }
    },
    listeners,
  };
}

test('probe uses three fresh ephemeral threads and never copies conversation history or tool instructions', async () => {
  const f = fixture();
  const outputs = await f.run();
  assert.equal(outputs.length, 3);
  const starts = f.calls.filter(call => call.method === 'thread/start');
  assert.equal(starts.length, 3);
  for (const { params } of starts) {
    assert.equal(params.ephemeral, true);
    assert.equal(params.model, context.model);
    assert.equal(params.modelProvider, context.provider);
    assert.notEqual(params.cwd, 'C:/project');
    assert.equal(params.sandbox, 'read-only');
    assert.match(params.developerInstructions, /Do not use tools/);
    assert.equal(params.config['features.multi_agent'], false);
    assert.equal(params.config['mcp_servers.sample.enabled'], false);
  }
  assert.equal(f.calls.some(call => call.method === 'thread/turns/list'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/fork'), false);
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['probe_1', 'probe_2', 'probe_3']);
});

test('probe verifies effective settings on each fresh thread and never reads a copied thread', async () => {
  const f = fixture();
  assert.equal((await f.run()).length, 3);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/read').map(call => call.params.threadId), [context.threadId]);
  assert.equal(f.listeners.size, 0);
});

test('probe rejects unconfirmed or different effective settings and releases only its own temporary thread', async () => {
  for (const patch of [
    response => { response.model = 'gpt-5.6-sol'; },
    response => { response.modelProvider = 'other'; },
    response => { response.reasoningEffort = 'low'; },
    response => { response.reasoningEffort = null; response.thread.reasoningEffort = null; },
  ]) {
    const f = fixture({ startPatch: patch });
    await assert.rejects(f.run(), /模型设置|临时检测/);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['probe_1']);
    assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
  }
});

test('probe rejects a thread/start response that is not a separate in-memory conversation', async () => {
  for (const [patch, cleanup] of [
    [response => { response.thread.id = context.threadId; }, false],
    [response => { response.thread.ephemeral = false; response.thread.path = 'C:/sessions/unexpected.jsonl'; }, false],
    [response => { response.thread.forkedFromId = context.threadId; }, true],
  ]) {
    const f = fixture({ startPatch: patch });
    await assert.rejects(f.run(), /临时检测/);
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), cleanup ? ['probe_1'] : []);
  }
});

test('cancelling during thread creation releases the probe thread without starting a model turn', async () => {
  const controller = new AbortController();
  const f = fixture({ onStart: () => controller.abort() });
  await assert.rejects(f.run({ signal: controller.signal }), /取消/);
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['probe_1']);
  assert.equal(f.listeners.size, 0);
});

test('probe cleans up a failed turn and rejects tool use without retaining a sample', async () => {
  for (const options of [{ turnError: 'Provider unavailable' }, { tool: true }]) {
    const progress = [], f = fixture(options);
    await assert.rejects(f.run({ onProgress: count => progress.push(count) }), /Provider unavailable|工具/);
    assert.deepEqual(progress, []);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), ['probe_1']);
    assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), !!options.tool);
  }
});

test('probe accepts protocol lifecycle items but rejects actual or unknown tools even without a start notification', async () => {
  for (const itemType of ['plan','contextCompaction','enteredReviewMode','exitedReviewMode']) {
    assert.equal((await fixture({ itemType }).run()).length, 3);
  }
  for (const itemType of ['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','collabAgentToolCall','futureTool']) {
    const progress=[];
    await assert.rejects(fixture({ itemType, completedOnly: true }).run({ onProgress: count => progress.push(count) }), /工具/);
    assert.deepEqual(progress, []);
  }
});

test('probe cannot fall back to the active project directory', async () => {
  await assert.rejects(fixture().run({ probeCwd: undefined }), /隔离检测目录/);
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
  let probeCwd;
  vm.runInNewContext(fs.readFileSync(require.resolve('../runtime/information-probe.cjs'), 'utf8'), {
    module, process: { env: {} }, AbortController, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: (_exe,_args,options) => { probeCwd=options.cwd; return child; } } : runtimeRequire(name),
  });
  try {
    await assert.rejects(module.exports.runInformationProbe({ ...context, executable: 'fixture.exe' }), /Fixture initialization rejected/);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(fs.existsSync(probeCwd), false);
  } finally {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});
