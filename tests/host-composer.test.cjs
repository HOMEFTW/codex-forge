const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codex = () => ({ agent: 'codex', model: '', reasoningEffort: '' });
const target = (agent, model, reasoningEffort) => ({ agent, model, reasoningEffort });
const overview = (threadId, composerTarget = codex()) => ({ threadId, composerTarget, threads: [], jobs: [], thread: null });

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../runtime/host-workspace.cjs'), 'utf8');
  const end = source.lastIndexOf('})();'); assert(end > 0, 'host preload must have its isolation wrapper');
  // Expose the actual preload functions inside an isolated VM. No DOMContentLoaded
  // event is fired, so the test cannot start timers or touch a real native window.
  const instrumented = source.slice(0, end) + `
    globalThis.hostComposerTest = {
      change: changeComposerTarget,
      refresh,
      initialize(value) { overview = value; lastThread = value.threadId; composerTarget = value.composerTarget; },
      snapshot() { return JSON.stringify({ overview, composerTarget, composerSaving, composerError, composerEpoch }); }
    };
  ` + source.slice(end);
  const requests = [], queuedOverviews = [];
  const ipcRenderer = {
    on() {},
    invoke(channel, args) {
      if (channel === 'fast-ext:overview') {
        assert(queuedOverviews.length, 'unexpected overview request'); return Promise.resolve(queuedOverviews.shift());
      }
      assert.equal(channel, 'fast-ext:collaboration-native'); assert.equal(args.method, 'composer_target');
      return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
    }
  };
  const sandbox = {
    require(name) { assert.equal(name, 'electron'); return { ipcRenderer }; },
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    window: { addEventListener() {} }
  };
  vm.createContext(sandbox); vm.runInContext(instrumented, sandbox, { filename: 'host-workspace.cjs' });
  const host = sandbox.hostComposerTest;
  host.initialize(overview('A'));
  return {
    requests, change: value => host.change(value), state: () => JSON.parse(host.snapshot()),
    async navigate(threadId, composerTarget = codex()) { queuedOverviews.push(overview(threadId, composerTarget)); await host.refresh(); }
  };
}

test('composer selection in the same thread keeps the chosen agent/model/effort and request context', async () => {
  const host = harness(), chosen = target('claude', 'claude-sonnet-4-6', 'high');
  const changing = host.change(chosen);
  assert.equal(host.state().composerSaving, true); assert.equal(host.requests[0].args.threadId, 'A');
  assert.deepEqual(host.requests[0].args.args, chosen);
  host.requests[0].resolve(chosen); await changing;
  const state = host.state();
  assert.equal(state.overview.threadId, 'A'); assert.deepEqual(state.composerTarget, chosen); assert.deepEqual(state.overview.composerTarget, chosen);
  assert.equal(state.composerSaving, false); assert.equal(state.composerError, '');
});

test('a delayed selection reply for thread A cannot make thread B display an external target while B remains Codex', async () => {
  const host = harness(), chosen = target('claude', 'claude-sonnet-4-6', 'high');
  const changing = host.change(chosen);
  await host.navigate('B');
  host.requests[0].resolve(chosen); await changing;
  const state = host.state();
  assert.equal(state.overview.threadId, 'B'); assert.deepEqual(state.composerTarget, codex()); assert.deepEqual(state.overview.composerTarget, codex());
  assert.equal(state.composerSaving, false); assert.equal(state.composerError, '');
});

test('leaving and returning to the same thread invalidates an earlier selection generation', async () => {
  const host = harness(), oldChoice = target('claude', 'claude-sonnet-4-6', 'high'), currentChoice = target('dsh', 'deepseek-chat', 'medium');
  const changing = host.change(oldChoice);
  await host.navigate('B'); await host.navigate('A', currentChoice);
  host.requests[0].resolve(oldChoice); await changing;
  const state = host.state();
  assert.equal(state.overview.threadId, 'A'); assert.deepEqual(state.composerTarget, currentChoice); assert.deepEqual(state.overview.composerTarget, currentChoice);
});

test('an old-thread error cannot clear a new-thread pending choice or leak its error into the new composer', async () => {
  const host = harness(), first = host.change(target('claude', 'claude-sonnet-4-6', 'high'));
  await host.navigate('B');
  const chosen = target('grok', 'grok-code-fast-1', 'high'), second = host.change(chosen);
  host.requests[0].reject(new Error('thread A selection failed')); await first;
  assert.equal(host.state().composerSaving, true); assert.equal(host.state().composerError, '');
  assert.equal(host.requests[1].args.threadId, 'B');
  host.requests[1].resolve(chosen); await second;
  assert.deepEqual(host.state().composerTarget, chosen); assert.deepEqual(host.state().overview.composerTarget, chosen); assert.equal(host.state().composerSaving, false);
});
