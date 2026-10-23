const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TodoStore } = require('../runtime/todos.cjs');
const sessionModule = import('../ui/todo-session.js');
async function fixture(t, wrap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-session-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TodoStore(root); await store.apply('thread', 0, [{ op: 'add', id: 'a', title: '原始标题', notes: '保留备注' }]);
  const requests = [], docs = [], errors = [];
  const perform = async (method, args) => method === 'todo_read' ? store.read(args.threadId) : store.apply(args.threadId, args.expectedRevision, args.operations);
  const api = { request: (method, args) => { requests.push({ method, args }); return wrap ? wrap(method, args, perform) : perform(method, args); } };
  const { TodoSession } = await sessionModule;
  const session = new TodoSession({ api, onDocument: value => docs.push(value), onError: value => errors.push(value), onBusy() {} });
  t.after(() => session.dispose()); await session.setTarget('thread'); return { session, store, requests, docs, errors };
}
test('blur-save and delete queue serially with the latest revision, and deleted edited text can be restored', async t => {
  let release, entered, first = true; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { session, store, requests } = await fixture(t, async (method, args, perform) => { if (method === 'todo_apply' && first) { first = false; entered(); await gate; } return perform(method, args); });
  let removed;
  const blur = session.mutate([{ op: 'update', id: 'a', title: '刚编辑的标题' }]);
  await started;
  const deletion = session.mutate([{ op: 'remove', id: 'a' }], (_next, before) => { removed = before.items[0]; });
  assert.equal(requests.filter(value => value.method === 'todo_apply').length, 1);
  release(); assert.equal(await blur, true); assert.equal(await deletion, true);
  assert.deepEqual(requests.filter(value => value.method === 'todo_apply').map(value => value.args.expectedRevision), [1, 2]);
  assert.deepEqual(store.read('thread').items, []); assert.equal(removed.title, '刚编辑的标题');
  assert.equal(await session.mutate([{ op: 'restore', item: removed, index: 0 }]), true); assert.deepEqual(store.read('thread').items[0], removed);
});
test('an invalid blur edit does not prevent an intentional delete of that item', async t => {
  const { session, store } = await fixture(t);
  const blur = session.mutate([{ op: 'update', id: 'a', title: '' }]);
  const deletion = session.mutate([{ op: 'remove', id: 'a' }]);
  assert.equal(await blur, false); assert.equal(await deletion, true); assert.deepEqual(store.read('thread').items, []);
});
test('scope navigation discards queued old-scope actions and ignores their late document response', async t => {
  let release, entered, first = true; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { session, store, requests, docs } = await fixture(t, async (method, args, perform) => { if (method === 'todo_apply' && first) { first = false; entered(); await gate; } return perform(method, args); });
  const firstSave = session.mutate([{ op: 'update', id: 'a', title: '已发出的编辑' }]); await started;
  const oldDelete = session.mutate([{ op: 'remove', id: 'a' }]);
  await session.setTarget('personal'); release(); await firstSave; assert.equal(await oldDelete, false);
  assert.equal(requests.filter(value => value.method === 'todo_apply').length, 1); assert.equal(store.read('thread').items[0].title, '已发出的编辑');
  assert.equal(docs.at(-1).threadId, 'personal'); assert.deepEqual(docs.at(-1).items, []);
});
test('a stale refresh reply cannot put a deleted todo back into the UI', async t => {
  let releaseRead, held = false;
  const { session, store, docs } = await fixture(t, async (method, args, perform) => {
    const value = await perform(method, args);
    if (method === 'todo_read' && held) { held = false; await new Promise(resolve => { releaseRead = resolve; }); }
    return value;
  });
  held = true; const reading = session.load(); await Promise.resolve(); await Promise.resolve();
  assert.equal(await session.mutate([{ op: 'remove', id: 'a' }]), true); releaseRead(); await reading;
  assert.deepEqual(docs.at(-1).items, []); assert.equal(docs.at(-1).revision, store.read('thread').revision);
});
test('a model update conflicts with stale deletion, refreshes, and is preserved until a deliberate retry', async t => {
  const { session, store, errors, docs } = await fixture(t);
  await store.apply('thread', 1, [{ op: 'update', id: 'a', title: '模型的新标题' }], 'model');
  assert.equal(await session.mutate([{ op: 'remove', id: 'a' }]), false);
  assert.match(errors.at(-1), /清单已有新修改/); assert.equal(docs.at(-1).items[0].title, '模型的新标题');
  assert.equal(await session.mutate([{ op: 'remove', id: 'a' }]), true); assert.deepEqual(store.read('thread').items, []);
});
