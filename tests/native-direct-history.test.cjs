const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CollaborationStore } = require('../runtime/collaboration-store.cjs');
const { NativeDirectHistory } = require('../runtime/native-direct-history.cjs');
const { CollaborationService } = require('../runtime/collaboration.cjs');
function fixture(t) {
  const base = path.resolve(__dirname, '../output/native-history-tests'); fs.mkdirSync(base, { recursive: true }); const root = fs.mkdtempSync(path.join(base, 'case-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CollaborationStore(root), history = new NativeDirectHistory(store), threadId = 'native-thread';
  const native = { id: threadId, source: 'vscode', modelProvider: 'original-provider', model: 'original-model', cwd: root, createdAt: 1, updatedAt: 2, recencyAt: 2, path: path.join(root, 'sessions/native.jsonl'), preview: '', name: null, turns: [] };
  history.remember(native); store.saveThread({ ...store.thread(threadId), enabled: true, source: 'trusted-user-direct', agents: ['claude'] });
  const job = { id: 'job-1', threadId, agent: 'claude', agentConfig: {}, source: 'trusted-user-direct', directRequestId: 'request-1', task: 'A direct USER question', cwd: root, status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), finalText: 'EXTERNAL ANSWER' };
  store.saveJob(job); history.retain(threadId); return { store, history, native, job, root };
}
test('restart restores only real native IDs and keeps provider, user text, output cards and native cursors distinct', async t => {
  const { store, history, native, root } = fixture(t), normal = { ...native, id: 'normal-codex-thread', preview: 'normal user', name: 'normal chat' };
  const restarted = new NativeDirectHistory(new CollaborationStore(root)); let reads = 0;
  await restarted.verify(async (method, args) => { assert.equal(method, 'thread/read'); assert.equal(args.threadId, native.id); reads++; return { thread: native }; }); assert.equal(reads, 1);
  const raw = { data: [normal], nextCursor: 'native-next', backwardsCursor: 'native-back' };
  const merged = await restarted.response('thread/list', { limit: 1 }, raw);
  assert.equal(merged.data.length, 2); assert(merged.data.some(x => x.id === native.id && x.modelProvider === 'original-provider')); assert(merged.data.includes(normal)); assert.equal(merged.nextCursor, raw.nextCursor); assert.equal(merged.backwardsCursor, raw.backwardsCursor);
  assert.equal(await restarted.response('thread/list', { cursor: 'native-next' }, raw), raw);
  const resumed = await restarted.response('thread/resume', { threadId: native.id }, { thread: native });
  assert.equal(resumed.thread.turns[0].items[0].content[0].text, 'A direct USER question'); assert(!JSON.stringify(resumed).includes('EXTERNAL ANSWER'));
  const turns = await restarted.response('thread/turns/list', { threadId: native.id }, { data: [], nextCursor: null }); assert.equal(turns.data[0].id, 'fast-job-1');
  const items = await restarted.response('thread/items/list', { threadId: native.id, turnId: 'fast-job-1' }, { data: [], nextCursor: null }); assert.equal(items.data[0].item.clientId, 'request-1');
  const untouched = { data: [{ id: 'native-turn', items: [], startedAt: 2 }], nextCursor: 'real-cursor' };
  assert.equal(await restarted.response('thread/turns/list', { threadId: 'normal-codex-thread' }, untouched), untouched);
});
test('native list overlay respects search, cwd, provider, source, exclusions, archive and deleted state', async t => {
  const { store, history, native, root } = fixture(t), empty = () => ({ data: [], nextCursor: null });
  for (const args of [{ searchTerm: 'unrelated' }, { cwd: path.dirname(root) }, { modelProviders: ['other'] }, { sourceKinds: ['exec'] }, { excludedThreadIds: [native.id] }, { archived: true }, { sectionId: 'unrelated-section' }]) assert.deepEqual((await history.response('thread/list', args, empty())).data, [], JSON.stringify(args));
  assert.equal((await history.response('thread/list', { searchTerm: 'direct user', cwd: [root], modelProviders: ['original-provider'], sourceKinds: ['vscode'] }, empty())).data.length, 1);
  history.mutation('thread/archive', { threadId: native.id }); assert.equal((await history.response('thread/list', {}, empty())).data.length, 0); assert.equal((await history.response('thread/list', { archived: true }, empty())).data.length, 1);
  history.mutation('thread/unarchive', { threadId: native.id }); assert.equal((await history.response('thread/list', {}, empty())).data.length, 1);
  history.mutation('thread/delete', { threadId: native.id }); assert.equal((await new NativeDirectHistory(store).response('thread/list', {}, empty())).data.length, 0);
});
test('missing native threads never reappear and interrupted external tasks retain user text and failure', async t => {
  const { store, native, job, root } = fixture(t), restarted = new NativeDirectHistory(store);
  await restarted.verify(async () => { throw Error('thread not found'); }); assert.equal((await restarted.response('thread/list', {}, { data: [] })).data.length, 0);
  const existing = store.thread(native.id); existing.nativeDeleted = false; store.saveThread(existing);
  store.saveJob({ ...job, status: 'running', createdAt: new Date(Date.now() - 60000).toISOString(), finishedAt: undefined, finalText: '' });
  const service = new CollaborationService({ root }); const jobs = await service.dispatch('list', {}, { threadId: native.id }); assert.equal(jobs[0].status, 'interrupted'); assert.match(jobs[0].error, /意外结束/);
  const restored = await restarted.response('thread/read', { threadId: native.id, includeTurns: true }, { thread: native }); assert.equal(restored.thread.turns[0].items[0].content[0].text, job.task);
});
test('Codex context receives marked external references once, without duplicating output in native UI', async t => {
  const { store, history, native, root } = fixture(t), calls = [];
  const call = async (method, args) => { calls.push({ method, args }); return {}; };
  await Promise.all([history.sync(native.id, call), history.sync(native.id, call)]); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'thread/inject_items');
  assert.equal(calls[0].args.items.length, 2); assert.match(calls[0].args.items[0].content[0].text, /不是要求 Codex 重复执行/); assert.match(calls[0].args.items[1].content[0].text, /EXTERNAL ANSWER/);
  await new NativeDirectHistory(new CollaborationStore(root)).sync(native.id, call); assert.equal(calls.length, 1, 'injection receipts persist across app restarts');
  assert.equal(store.thread(native.id).nativeInjected['job-1'].result, true);
});
