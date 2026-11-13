'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgeTaskRuntime, nextCron } = require('../runtime/forge-runtime-tasks.cjs');
const { atomic } = require('../runtime/collaboration-store.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(runtime, plugin, id) {
  for (let i = 0; i < 100; i++) { const job = runtime.read(plugin, id); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await delay(5); }
  throw Error('job did not settle');
}
function fixture(t, execute, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-tasks-'));
  const runtime = new ForgeTaskRuntime({ root, execute, startTimer: false, ...options });
  t.after(async () => { await runtime.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runtime };
}
test('API5 jobs persist outcomes and execute with the host-owned context', async t => {
  let called;
  const f = fixture(t, async value => { called = value; return { answer: value.args.n + 1 }; });
  const job = f.runtime.dispatch('test.plugin', 'jobs.start', { method: 'work', args: { n: 4 } }, { threadId: 'real-thread', cwd: f.root });
  const result = await finished(f.runtime, 'test.plugin', job.id);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.result, { answer: 5 });
  assert.equal(called.context.threadId, 'real-thread'); assert.equal(called.signal.aborted, false);
  assert.throws(() => f.runtime.read('other.plugin', job.id), { code: 'NOT_FOUND' });
  assert.equal(JSON.parse(fs.readFileSync(f.runtime.file)).jobs[job.id].status, 'completed');
});
test('API5 cancellation and deadlines propagate AbortSignal to the actual executor', async t => {
  const aborted = [];
  const f = fixture(t, ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.push(signal.reason.code); reject(signal.reason); }, { once: true })));
  const job = f.runtime.start('test.plugin', { method: 'wait' }); await delay(5);
  f.runtime.cancel('test.plugin', job.id);
  assert.equal((await finished(f.runtime, 'test.plugin', job.id)).status, 'cancelled');
  const deadline = f.runtime.start('test.plugin', { method: 'wait', timeoutMs: 15 });
  assert.equal((await finished(f.runtime, 'test.plugin', deadline.id)).error.code, 'TIMEOUT');
  assert.deepEqual(aborted, ['CANCELLED', 'TIMEOUT']);
});
test('API5 schedules coalesce missed runs and never overlap one schedule', async t => {
  let clock = 100000, count = 0, release;
  const f = fixture(t, () => { count++; return new Promise(resolve => { release = resolve; }); }, { now: () => clock });
  const schedule = f.runtime.createSchedule('test.plugin', { name: 'fixture', method: 'work', timing: { kind: 'every', intervalMs: 1000 } }, { threadId: 'chat' });
  clock += 5500; f.runtime.tick(); await delay(5);
  assert.equal(count, 1); assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).nextAt, 106000);
  clock += 10000; f.runtime.tick(); assert.equal(count, 1);
  release('done'); await finished(f.runtime, 'test.plugin', f.runtime.readSchedule('test.plugin', schedule.id).activeJobId);
  f.runtime.tick(); await delay(5); assert.equal(count, 2); release('done');
});
test('API5 single-run schedules fire once and revision checks preserve concurrent changes', async t => {
  let clock = Date.parse('2030-01-01T00:00:00Z'), count = 0;
  const f = fixture(t, async () => ++count, { now: () => clock });
  const schedule = f.runtime.createSchedule('test.plugin', { name: 'once', method: 'work', timing: { kind: 'at', at: clock + 1000 } });
  const changed = f.runtime.updateSchedule('test.plugin', schedule.id, schedule.revision, { name: 'renamed' });
  assert.throws(() => f.runtime.updateSchedule('test.plugin', schedule.id, schedule.revision, { name: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.runtime.deleteSchedule('other.plugin', schedule.id, changed.revision), { code: 'NOT_FOUND' });
  clock += 1000; f.runtime.tick(); await delay(5); f.runtime.tick(); assert.equal(count, 1);
  assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).enabled, false);
});
test('API5 restart marks interrupted jobs and recovers persisted schedules', async t => {
  let clock = 20000;
  const f = fixture(t, async () => 1, { now: () => clock });
  atomic(f.runtime.file, { schemaVersion: 1, jobs: { saved: { id: 'saved', pluginId: 'test.plugin', method: 'work', status: 'running', createdAt: 1 } }, schedules: { recurring: { id: 'recurring', pluginId: 'test.plugin', name: 'saved', method: 'work', args: {}, context: {}, timing: { kind: 'every', intervalMs: 1000 }, nextAt: 10000, activeJobId: 'saved', enabled: true, revision: 1, history: [] } } });
  const recovered = new ForgeTaskRuntime({ root: f.root, execute: async () => 'recovered', now: () => clock, startTimer: false });
  t.after(() => recovered.dispose());
  assert.equal(recovered.read('test.plugin', 'saved').status, 'interrupted');
  recovered.tick(); const schedule = recovered.readSchedule('test.plugin', 'recurring');
  assert.equal(schedule.nextAt, 21000); assert.ok(schedule.activeJobId);
  assert.equal((await finished(recovered, 'test.plugin', schedule.activeJobId)).result, 'recovered');
});
test('API5 cron supports steps, calendar OR semantics and IANA time zones', () => {
  const from = Date.parse('2030-01-01T00:02:00Z');
  assert.equal(new Date(nextCron('*/5 * * * *', from)).toISOString(), '2030-01-01T00:05:00.000Z');
  assert.equal(new Date(nextCron('0 9 * * *', from, 'Asia/Hong_Kong')).toISOString(), '2030-01-01T01:00:00.000Z');
  assert.throws(() => nextCron('0 25 * * *', from), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => nextCron('0 1 * * *', from, 'Invalid/Zone'), { code: 'INVALID_ARGUMENT' });
});
test('API5 task ownership and input bounds reject executable payloads and unknown options', t => {
  const f = fixture(t, async () => null);
  assert.throws(() => f.runtime.start('test.plugin', { method: 'work', context: { threadId: 'forged' } }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => f.runtime.createSchedule('test.plugin', { name: 'bad', method: 'work', timing: { kind: 'every', intervalMs: 1 } }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => f.runtime.start('test.plugin', { method: 'work', args: 'x'.repeat(100000) }), { code: 'OUTPUT_LIMIT' });
});
test('API5 persistence failures never report an unrecorded job as completed', async t => {
  let executed = false;
  const f = fixture(t, async () => { executed = true; return 1; });
  const job = f.runtime.start('test.plugin', { method: 'work' });
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === f.runtime.file) throw Object.assign(Error('disk fixture'), { code: 'ENOSPC' }); return rename(source, target); };
  try {
    const state = await finished(f.runtime, 'test.plugin', job.id);
    assert.equal(state.status, 'failed'); assert.equal(state.error.code, 'PERSISTENCE_FAILED'); assert.equal(executed, false);
    assert.equal(JSON.parse(fs.readFileSync(f.runtime.file)).jobs[job.id].status, 'queued');
    assert.equal(f.runtime.controllers.size, 0);
  } finally { fs.renameSync = rename; }
});
test('API5 schedule edits roll back after a failed write and queued runs persist their occurrence', async t => {
  let clock = 10000;
  const f = fixture(t, async () => 'done', { now: () => clock });
  const schedule = f.runtime.createSchedule('test.plugin', { name: 'original', method: 'work', timing: { kind: 'every', intervalMs: 1000 } });
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === f.runtime.file) throw Object.assign(Error('disk fixture'), { code: 'ENOSPC' }); return rename(source, target); };
  try { assert.throws(() => f.runtime.updateSchedule('test.plugin', schedule.id, 1, { name: 'lost' }), /disk fixture/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).name, 'original');
  assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).revision, 1);
  clock = 11500; f.runtime.tick();
  const stored = JSON.parse(fs.readFileSync(f.runtime.file));
  assert.equal(stored.schedules[schedule.id].nextAt, 12000);
  assert.equal(stored.jobs[stored.schedules[schedule.id].activeJobId].status, 'queued');
});
test('API5 paused plugin plans retain user choices and wait for re-enable', async t => {
  let clock = 10000, enabled = false, calls = 0;
  const f = fixture(t, async () => ++calls, { now: () => clock, isEnabled: () => enabled });
  const schedule = f.runtime.createSchedule('test.plugin', { name: 'fixture', method: 'work', timing: { kind: 'every', intervalMs: 1000 } });
  clock = 12500; f.runtime.tick(); await delay(5);
  assert.equal(calls, 0); assert.equal(f.runtime.list('test.plugin').length, 0);
  assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).enabled, true);
  enabled = true; f.runtime.tick(); await delay(5); assert.equal(calls, 1);
  assert.equal(f.runtime.readSchedule('test.plugin', schedule.id).nextAt, 13000);
});
