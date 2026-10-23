const test = require('node:test');
const assert = require('node:assert/strict');
const draftModule = import('../ui/canvas-draft.js');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function editor(CanvasDraft, options = {}) {
  const values = [], statuses = [], writes = [];
  const draft = new CanvasDraft({ value: { title: '原始', text: '内容', color: 'neutral' }, revision: 2, save: async (patch, revision) => { writes.push({ patch, revision }); return { revision: revision + 1 }; }, onChange: value => values.push(value), onStatus: value => statuses.push(value), delay: 20, ...options });
  return { draft, values, statuses, writes };
}
test('disposing a dirty editor cancels timers and never writes a stale draft', async () => {
  const { CanvasDraft } = await draftModule, { draft, writes } = editor(CanvasDraft);
  draft.change('text', '旧草稿'); draft.dispose(); await pause(35); await draft.flush(); assert.deepEqual(writes, []);
});
test('flushing before navigation saves only changed fields; discard cannot resurrect a deleted node draft', async () => {
  const { CanvasDraft } = await draftModule, { draft, writes } = editor(CanvasDraft);
  draft.change('text', '新文本'); await draft.flush();
  assert.deepEqual(writes, [{ patch: { text: '新文本' }, revision: 2 }]); assert.equal(draft.dirty, false);
  draft.change('title', '不应复活'); draft.discard(); draft.dispose(); await pause(35); assert.equal(writes.length, 1);
});
test('external revisions preserve dirty fields and explicit retry keeps unrelated model changes', async () => {
  const { CanvasDraft } = await draftModule, { draft, values, statuses, writes } = editor(CanvasDraft);
  draft.change('text', '用户草稿'); draft.context({ title: '模型标题', text: '模型正文', color: 'blue' }, 3);
  await pause(35); assert.deepEqual(writes, []); assert.match(statuses.at(-1), /草稿已保留/);
  assert.deepEqual(values.at(-1), { title: '模型标题', text: '用户草稿', color: 'blue' });
  await draft.flush(true); assert.deepEqual(writes, [{ patch: { text: '用户草稿' }, revision: 3 }]); draft.dispose();
});
test('typing during an in-flight save drains the newest draft once, without stale snapshots', async () => {
  const { CanvasDraft } = await draftModule; let resolveSave, count = 0; const writes = [];
  const { draft, values } = editor(CanvasDraft, { delay: 10000, save: async (patch, revision) => { writes.push({ patch, revision }); if (++count === 1) await new Promise(resolve => { resolveSave = resolve; }); return { revision: revision + 1 }; } });
  draft.change('text', '第一版'); const first = draft.flush(); await Promise.resolve();
  draft.change('text', '第二版'); draft.change('color', 'green'); resolveSave(); await first;
  assert.deepEqual(writes, [{ patch: { text: '第一版' }, revision: 2 }, { patch: { text: '第二版', color: 'green' }, revision: 3 }]);
  assert.equal(draft.dirty, false); assert.equal(values.at(-1).text, '第二版'); draft.dispose();
});
test('a rejected autosave retains its patch and disposal after an in-flight request cannot restart saving', async () => {
  const { CanvasDraft } = await draftModule; let resolveSave;
  const failed = editor(CanvasDraft, { save: async () => { throw new Error('Revision conflict'); } });
  failed.draft.change('text', '保留'); await assert.rejects(failed.draft.flush(), /Revision conflict/); assert.equal(failed.draft.dirty, true); assert.match(failed.statuses.at(-1), /未保存/); failed.draft.dispose();
  const writes = [], pending = editor(CanvasDraft, { save: async (patch, revision) => { writes.push(patch); await new Promise(resolve => { resolveSave = resolve; }); return { revision: revision + 1 }; } });
  pending.draft.change('text', '请求已发出'); const flush = pending.draft.flush(); await Promise.resolve(); pending.draft.change('title', '未发出的旧草稿'); pending.draft.dispose(); resolveSave(); await flush; await pause(35); assert.equal(writes.length, 1);
});
test('a late own-save reply cannot echo old fields over a newer model revision', async () => {
  const { CanvasDraft } = await draftModule; let resolveSave;
  const { draft, values } = editor(CanvasDraft, { delay: 10000, save: async () => { await new Promise(resolve => { resolveSave = resolve; }); return { revision: 3 }; } });
  draft.change('text', '已发出的用户版本'); const saving = draft.flush(); await Promise.resolve();
  draft.context({ title: '最新模型标题', text: '最新模型文本', color: 'blue' }, 4);
  resolveSave(); await saving;
  assert.deepEqual(values.at(-1), { title: '最新模型标题', text: '最新模型文本', color: 'blue' }); assert.equal(draft.dirty, false); draft.dispose();
});
