const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CanvasStore } = require('../runtime/store.cjs');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-canvas-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return new CanvasStore(root); }
const item = (id = 'n1', type = 'text') => ({ id, type, x: 0, y: 0, width: 260, height: 180, data: { title: '标题', text: '你好', color: 'neutral' } });
test('model/user round trip preserves node IDs, edges and persistent revisions', async t => {
  const store = fixture(t), doc = await store.create('画布', 'test');
  const first = await store.apply(doc.id, 0, [{ op: 'upsert_node', node: item() }, { op: 'upsert_node', node: item('n2', 'sticky') }, { op: 'upsert_edge', edge: { id: 'edge', source: 'n1', target: 'n2', label: '关系' } }], 'model', '模型创建');
  assert.equal(first.revision, 1); assert.equal(first.lastChange.source, 'model');
  await store.apply(doc.id, 1, [{ op: 'update_node', id: 'n1', patch: { x: 200, data: { text: '用户编辑' } } }]);
  const reloaded = new CanvasStore(store.root).read(doc.id);
  assert.equal(reloaded.nodes[0].data.title, '标题'); assert.equal(reloaded.nodes[0].data.text, '用户编辑'); assert.equal(reloaded.nodes[0].x, 200); assert.equal(reloaded.edges.length, 1);
  await store.apply(doc.id, 2, [{ op: 'remove_node', id: 'n2' }]); assert.equal(store.read(doc.id).edges.length, 0);
});
test('concurrent writers conflict without overwriting either document', async t => {
  const store = fixture(t); await store.create('并发', 'test');
  const results = await Promise.allSettled([store.apply('test', 0, [{ op: 'upsert_node', node: item('a') }]), new CanvasStore(store.root).apply('test', 0, [{ op: 'upsert_node', node: item('b') }])]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal(store.read('test').nodes.length, 1); assert.equal(store.read('test').revision, 1);
});
test('invalid transactions roll back; traversal, dangling edges and oversized data rejected', async t => {
  const store = fixture(t); await store.create('原子', 'test');
  assert.throws(() => store.read('../private'), /Invalid ID/);
  await assert.rejects(store.apply('test', 0, [{ op: 'upsert_node', node: item() }, { op: 'upsert_edge', edge: { id: 'bad', source: 'n1', target: 'missing' } }]), /endpoint/);
  assert.deepEqual(store.read('test').nodes, []);
  await assert.rejects(store.apply('test', 0, [{ op: 'upsert_node', node: { ...item(), data: { text: 'a'.repeat(100001) } } }]), /too long/);
  await assert.rejects(store.apply('test', 0, [{ op: 'upsert_node', node: { ...item(), data: { __bad: true } } }]), /Unknown/);
});
test('image import copies safe raster assets and rejects SVG/arbitrary reads', async t => {
  const store = fixture(t), image = path.join(store.root, 'image.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY5sAAAAASUVORK5CYII=', 'base64'));
  const asset = store.importImage(image); assert.match(asset, /^[a-f0-9]{64}\.png$/); assert.match(store.imageData(asset), /^data:image\/png;base64,/);
  fs.writeFileSync(path.join(store.root, 'bad.svg'), '<svg></svg>'); assert.throws(() => store.importImage(path.join(store.root, 'bad.svg')), /Only PNG/); assert.throws(() => store.imageData('../image.png'), /Invalid asset/);
});
test('canvas metadata, previews and collapsible groups persist without changing existing node IDs', async t => {
  const store = fixture(t), created = await store.create('项目画布', 'meta', 'user', { description: '分组说明', color: 'blue' });
  let doc = await store.apply(created.id, 0, [
    { op: 'upsert_node', node: item('note') },
    { op: 'upsert_node', node: { id: 'group', type: 'group', x: 20, y: 250, width: 420, height: 260, data: { title: '阶段一', text: '', color: 'blue', members: [], collapsed: false, gridColumns: 2, gridRows: 1 } } },
    { op: 'set_group_members', id: 'group', members: ['note'] },
    { op: 'set_metadata', description: '已更新', color: 'green' },
  ]);
  assert.equal(doc.description, '已更新'); assert.equal(doc.color, 'green'); assert.deepEqual(doc.nodes[1].data.members, ['note']);
  assert.equal(store.list()[0].groups, 1); assert.equal(store.list()[0].preview.length, 2);
  doc = await store.apply(doc.id, doc.revision, [{ op: 'update_node', id: 'group', patch: { data: { collapsed: true } } }]);
  assert.equal(doc.nodes.find(value => value.id === 'group').data.collapsed, true);
  doc = await store.apply(doc.id, doc.revision, [{ op: 'remove_node', id: 'note' }]);
  assert.deepEqual(doc.nodes.find(value => value.id === 'group').data.members, []);
  await assert.rejects(store.apply(doc.id, doc.revision, [{ op: 'set_group_members', id: 'group', members: ['missing'] }]), /member/);
});
