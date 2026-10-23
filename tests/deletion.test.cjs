const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CanvasStore } = require('../runtime/store.cjs');
const { TodoStore } = require('../runtime/todos.cjs');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-delete-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const node = id => ({ id, type: 'sticky', x: 0, y: 0, width: 260, height: 180, data: { title: id, text: '保留内容' } });
test('whole canvas deletion moves only that document to trash; undo restores IDs and invalidates old writes', async t => {
  const store = new CanvasStore(fixture(t)); let doc = await store.create('删除验收', 'first'); await store.create('保留画布', 'second');
  doc = await store.apply(doc.id, 0, [{ op: 'upsert_node', node: node('a') }, { op: 'upsert_node', node: node('b') }, { op: 'upsert_edge', edge: { id: 'link', source: 'a', target: 'b', label: '关系' } }]);
  const asset = path.join(store.assetsRoot, 'shared-resource-sentinel'); fs.writeFileSync(asset, 'keep');
  await assert.rejects(store.delete(doc.id, 0), /Revision conflict/); assert.deepEqual(store.read(doc.id), doc);
  const removed = await store.delete(doc.id, doc.revision);
  assert.equal(removed.deleted, true); assert.equal(removed.id, doc.id); assert.deepEqual(removed.canvases.map(value => value.id), ['second']);
  assert.equal(fs.existsSync(store.file(doc.id)), false); assert.equal(fs.readFileSync(asset, 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.root, '.trash', removed.restoreToken + '.json'), 'utf8')), doc);
  await assert.rejects(store.apply(doc.id, doc.revision, [{ op: 'set_title', title: '不能复活' }]), /ENOENT/);
  const restored = await store.restore(removed.restoreToken);
  assert.equal(restored.restored, true); assert.equal(restored.canvas.id, doc.id); assert.equal(restored.canvas.revision, doc.revision + 1);
  assert.deepEqual(restored.canvas.nodes, doc.nodes); assert.deepEqual(restored.canvas.edges, doc.edges); assert.equal(restored.canvas.createdAt, doc.createdAt);
  await assert.rejects(store.apply(doc.id, doc.revision, [{ op: 'set_title', title: '旧草稿' }]), /Revision conflict/);
  await assert.rejects(store.restore(removed.restoreToken), /ENOENT/); assert.equal(store.read('second').title, '保留画布');
});
test('canvas restore refuses ID collisions and invalid tokens without overwriting a newer document', async t => {
  const store = new CanvasStore(fixture(t)); const doc = await store.create('旧画布', 'same'); const removed = await store.delete(doc.id, 0);
  await store.create('新画布', 'same'); await assert.rejects(store.restore(removed.restoreToken), /already exists/);
  assert.equal(store.read('same').title, '新画布'); assert.equal(fs.existsSync(path.join(store.root, '.trash', removed.restoreToken + '.json')), true);
  await assert.rejects(store.restore('../same'), /Invalid ID/); await assert.rejects(store.delete('same'), /expectedRevision/);
});
test('a concurrent model update and canvas delete cannot both consume the same revision', async t => {
  const store = new CanvasStore(fixture(t)); const doc = await store.create('并发', 'first');
  const results = await Promise.allSettled([store.apply(doc.id, 0, [{ op: 'upsert_node', node: node('model-node') }], 'model'), store.delete(doc.id, 0)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  if (results[0].status === 'fulfilled') { assert.equal(store.read(doc.id).nodes[0].id, 'model-node'); assert.match(String(results[1].reason), /Revision conflict/); }
  else { assert.equal(store.list().length, 0); assert.match(String(results[0].reason), /ENOENT/); }
});
test('todo delete/restore preserves position, ID, status and notes while keeping later model changes', async t => {
  const store = new TodoStore(fixture(t)); let doc = await store.apply('thread', 0, [{ op: 'add', id: 'a', title: '第一项' }, { op: 'add', id: 'b', title: '第二项', notes: '备注' }]);
  doc = await store.apply('thread', doc.revision, [{ op: 'update', id: 'a', status: 'completed', notes: '保留备注' }]);
  const item = structuredClone(doc.items[0]); doc = await store.apply('thread', doc.revision, [{ op: 'remove', id: item.id }]);
  doc = await store.apply('thread', doc.revision, [{ op: 'update', id: 'b', title: '模型的新标题' }], 'model');
  const restored = await store.apply('thread', doc.revision, [{ op: 'restore', item, index: 0 }]);
  assert.deepEqual(restored.items[0], item); assert.equal(restored.items[1].title, '模型的新标题');
  await assert.rejects(store.apply('thread', restored.revision, [{ op: 'restore', item, index: 0 }]), /duplicate/);
  await assert.rejects(store.apply('thread', doc.revision, [{ op: 'remove', id: 'b' }]), /Revision conflict/);
  assert.deepEqual(store.read('thread').items, restored.items); assert.deepEqual(store.read('other').items, []);
});
