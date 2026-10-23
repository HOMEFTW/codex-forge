const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CanvasStore } = require('../runtime/store.cjs');
const historyModule = import('../ui/canvas-history.js');
const node = (id, x = 0) => ({ id, type: 'sticky', x, y: 0, width: 260, height: 180, data: { title: id, text: '', color: 'yellow' } });
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-history-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return new CanvasStore(root); }
async function edit(history, store, doc, operations) {
  const token = history.begin(doc);
  const next = await store.apply(doc.id, doc.revision, operations);
  history.complete(token, next); return next;
}
async function travel(history, store, doc, direction) {
  const token = history.begin(doc, direction); assert(token);
  const next = await store.apply(doc.id, doc.revision, [{ op: 'replace_content', content: token.target }]);
  history.complete(token, next); return next;
}
test('canvas history restores node/edge IDs, content, position and cascaded deletion in both directions', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory(), store = fixture(t);
  let doc = await store.create('历史', 'first'); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'upsert_node', node: node('a') }, { op: 'upsert_node', node: node('b') }, { op: 'upsert_edge', edge: { id: 'link', source: 'a', target: 'b', label: '原始' } }]);
  doc = await edit(history, store, doc, [{ op: 'update_node', id: 'a', patch: { x: 123, y: 456, data: { text: '本地内容', color: 'blue' } } }, { op: 'upsert_edge', edge: { ...doc.edges[0], label: '标签' } }]);
  const content = structuredClone({ title: doc.title, nodes: doc.nodes, edges: doc.edges });
  doc = await edit(history, store, doc, [{ op: 'remove_node', id: 'a' }]); assert.equal(doc.edges.length, 0);
  doc = await travel(history, store, doc, 'undo'); assert.deepEqual({ title: doc.title, nodes: doc.nodes, edges: doc.edges }, content);
  doc = await travel(history, store, doc, 'undo'); assert.equal(doc.nodes[0].x, 0); assert.equal(doc.nodes[0].data.text, ''); assert.equal(doc.edges[0].label, '原始');
  doc = await travel(history, store, doc, 'redo'); assert.deepEqual({ title: doc.title, nodes: doc.nodes, edges: doc.edges }, content);
  doc = await travel(history, store, doc, 'redo'); assert.deepEqual(doc.nodes.map(value => value.id), ['b']); assert.equal(doc.edges.length, 0);
  doc = await travel(history, store, doc, 'undo');
  doc = await edit(history, store, doc, [{ op: 'update_node', id: 'b', patch: { data: { title: '新分支' } } }]); assert.equal(history.state().canRedo, false);
});
test('file-watcher replies before IPC preserve own history, while external revisions invalidate it', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory(), store = fixture(t);
  let doc = await store.create('并发', 'first'); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'upsert_node', node: node('a') }]);
  const token = history.begin(doc);
  const next = await store.apply(doc.id, doc.revision, [{ op: 'update_node', id: 'a', patch: { x: 1 } }]);
  assert.equal(history.observe(next), false); assert.equal(history.complete(token, next), true); assert.equal(history.undo.length, 2);
  const model = await store.apply(doc.id, next.revision, [{ op: 'update_node', id: 'a', patch: { data: { text: '模型的新内容' } } }], 'model');
  assert.equal(history.observe(model), true); assert.deepEqual(history.state(), { canUndo: false, canRedo: false }); assert.equal(history.begin(model, 'undo'), null);
  assert.equal(store.read(doc.id).nodes[0].data.text, '模型的新内容');
});
test('undo racing a model write is rejected atomically and clears stale history', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory(), store = fixture(t);
  let doc = await store.create('冲突', 'first'); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'upsert_node', node: node('a') }]);
  const undo = history.begin(doc, 'undo');
  const model = await store.apply(doc.id, doc.revision, [{ op: 'update_node', id: 'a', patch: { data: { text: '必须保留' } } }], 'model');
  history.observe(model);
  await assert.rejects(store.apply(doc.id, undo.revision, [{ op: 'replace_content', content: undo.target }]), /Revision conflict/);
  history.fail(undo, model); assert.equal(history.state().canUndo, false); assert.equal(store.read(doc.id).nodes[0].data.text, '必须保留');
});
test('changing canvases and an external write after an own transaction cannot revive stale history', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory(), store = fixture(t);
  let doc = await store.create('一', 'first'); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'upsert_node', node: node('a') }]);
  const token = history.begin(doc); const next = await store.apply(doc.id, doc.revision, [{ op: 'update_node', id: 'a', patch: { x: 1 } }]);
  const external = await store.apply(doc.id, next.revision, [{ op: 'update_node', id: 'a', patch: { y: 10 } }], 'model');
  history.observe(external); assert.equal(history.complete(token, next), false); assert.equal(history.state().canUndo, false);
  const second = await store.create('二', 'second'); history.observe(second); assert.equal(history.state().canUndo, false);
  history.observe(external); assert.equal(history.state().canUndo, false); assert.equal(history.id, 'first');
});
test('history bounds memory/count and no-op edits do not clear redo', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory({ maxEntries: 2 }), store = fixture(t);
  let doc = await store.create('边界', 'first'); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'upsert_node', node: node('a') }]);
  for (const x of [1, 2, 3]) doc = await edit(history, store, doc, [{ op: 'update_node', id: 'a', patch: { x } }]);
  assert.equal(history.undo.length, 2); doc = await travel(history, store, doc, 'undo');
  doc = await edit(history, store, doc, [{ op: 'update_node', id: 'a', patch: { x: doc.nodes[0].x } }]); assert.equal(history.state().canRedo, true);
  const tiny = new CanvasHistory({ maxBytes: 1 }); tiny.reset(doc); await edit(tiny, store, doc, [{ op: 'update_node', id: 'a', patch: { x: 9 } }]); assert.equal(tiny.state().canUndo, false);
});
test('content restore is validated atomically and keeps document identity/metadata', async t => {
  const { canvasContent } = await historyModule, store = fixture(t); let doc = await store.create('原始', 'first');
  doc = await store.apply(doc.id, 0, [{ op: 'upsert_node', node: node('a') }]);
  const bad = canvasContent(doc); bad.nodes.push(node('a'));
  await assert.rejects(store.apply(doc.id, 1, [{ op: 'replace_content', content: bad }]), /Duplicate/); assert.deepEqual(store.read(doc.id), doc);
  await assert.rejects(store.apply(doc.id, 1, [{ op: 'replace_content', content: { ...canvasContent(doc), revision: 500 } }]), /Unknown canvas content/);
  const restored = await store.apply(doc.id, 1, [{ op: 'replace_content', content: { title: '撤销', nodes: [], edges: [] } }]);
  assert.equal(restored.id, doc.id); assert.equal(restored.createdAt, doc.createdAt); assert.equal(restored.revision, 2); assert.equal(restored.title, '撤销');
});
test('deleting a node with more than 300 incident edges can be undone in one atomic restore', async t => {
  const { CanvasHistory } = await historyModule, history = new CanvasHistory(), store = fixture(t);
  let doc = await store.create('多连线', 'first');
  doc = await store.apply(doc.id, doc.revision, [{ op: 'upsert_node', node: node('a') }, { op: 'upsert_node', node: node('b') }]);
  const links = Array.from({ length: 301 }, (_, index) => ({ op: 'upsert_edge', edge: { id: `edge-${index}`, source: 'a', target: 'b', label: `${index}` } }));
  doc = await store.apply(doc.id, doc.revision, links.slice(0, 300)); doc = await store.apply(doc.id, doc.revision, links.slice(300)); history.reset(doc);
  doc = await edit(history, store, doc, [{ op: 'remove_node', id: 'a' }]); assert.equal(doc.edges.length, 0);
  doc = await travel(history, store, doc, 'undo'); assert.deepEqual(doc.edges, links.map(value => value.edge)); assert.equal(doc.nodes[0].id, 'a');
});
test('history shortcuts support platform conventions and preserve text-field native undo', async () => {
  const { canvasHistoryShortcut } = await historyModule;
  const event = { key: 'z', ctrlKey: true, target: { closest: () => null } };
  assert.equal(canvasHistoryShortcut(event), 'undo'); assert.equal(canvasHistoryShortcut({ ...event, shiftKey: true }), 'redo');
  assert.equal(canvasHistoryShortcut({ ...event, ctrlKey: false, metaKey: true }), 'undo'); assert.equal(canvasHistoryShortcut({ ...event, key: 'y' }), 'redo');
  for (const target of ['input', 'textarea', 'contenteditable']) assert.equal(canvasHistoryShortcut({ ...event, target: { closest: () => target } }), null);
  assert.equal(canvasHistoryShortcut({ ...event, altKey: true }), null); assert.equal(canvasHistoryShortcut({ ...event, isComposing: true }), null);
});
