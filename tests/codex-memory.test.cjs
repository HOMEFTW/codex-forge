'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexMemory } = require('../runtime/codex-memory.cjs');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memories = path.join(root, 'codex', 'memories');
  fs.mkdirSync(memories, { recursive: true });
  return { root, memories, service: new CodexMemory({ root: memories }) };
}

test('lists only supported memory documents and searches their names and contents', t => {
  const { memories, service } = fixture(t);
  fs.writeFileSync(path.join(memories, 'MEMORY.md'), '# Project memory\nA local test phrase.');
  fs.mkdirSync(path.join(memories, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(memories, 'rollout_summaries', 'session.md'), '{"type":"event_msg"}\n');
  fs.mkdirSync(path.join(memories, 'skills', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(memories, 'skills', 'sample', 'SKILL.md'), '# Read only skill');
  fs.mkdirSync(path.join(memories, 'extensions', 'ad_hoc', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(memories, 'extensions', 'ad_hoc', 'notes', 'local.md'), 'My second phrase.');
  fs.mkdirSync(path.join(memories, 'extensions', 'private'), { recursive: true });
  fs.writeFileSync(path.join(memories, 'extensions', 'private', 'other.md'), 'Must stay outside this manager.');

  const all = service.list();
  assert.deepEqual(all.map(item => item.id).sort(), ['MEMORY.md', 'extensions/ad_hoc/notes/local.md', 'rollout_summaries/session.md', 'skills/sample/SKILL.md']);
  assert.equal(service.list({ category: 'notes' }).length, 1);
  assert.equal(service.list({ query: 'second phrase' })[0].id, 'extensions/ad_hoc/notes/local.md');
  assert.equal(all.find(item => item.id === 'MEMORY.md').editable, true);
  assert.equal(all.find(item => item.id === 'rollout_summaries/session.md').editable, false);
});

test('edits core memory atomically with a content hash and rejects stale writes', t => {
  const { memories, service } = fixture(t);
  const filename = path.join(memories, 'MEMORY.md'); fs.writeFileSync(filename, 'before');
  const current = service.read('MEMORY.md');
  const saved = service.write(current.id, 'after', current.hash);
  assert.equal(saved.content, 'after');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'after');
  assert.equal('target' in saved, false, 'absolute paths stay inside the main process');
  assert.throws(() => service.write('MEMORY.md', 'stale', current.hash), /已发生变化/);
});

test('creates and deletes only explicitly selected custom notes', t => {
  const { service } = fixture(t);
  const created = service.create('项目约定', '# Notes');
  assert.equal(created.id, 'extensions/ad_hoc/notes/项目约定.md');
  assert.equal(created.content, '# Notes');
  assert.throws(() => service.create('../outside'), /标题/);
  assert.throws(() => service.create('项目约定'), /同名/);
  assert.throws(() => service.remove(created.id, 'stale'), /已发生变化/);
  assert.deepEqual(service.remove(created.id, created.hash), { deleted: true, id: created.id });
  assert.throws(() => service.read(created.id), /不存在/);
});

test('blocks traversal, unsupported files, read-only records, and invalid operations', t => {
  const { memories, service } = fixture(t);
  fs.writeFileSync(path.join(memories, 'MEMORY.md'), 'core');
  fs.mkdirSync(path.join(memories, 'rollout_summaries'));
  fs.writeFileSync(path.join(memories, 'rollout_summaries', 'run.md'), 'append only');
  const log = service.read('rollout_summaries/run.md');
  assert.throws(() => service.write(log.id, 'changed', log.hash), /只读/);
  assert.throws(() => service.remove('MEMORY.md', service.read('MEMORY.md').hash), /只能删除/);
  assert.throws(() => service.read('../outside.md'), /路径无效/);
  assert.throws(() => service.read('extensions/private/other.md'), /不属于/);
  assert.throws(() => service.list({ category: 'unknown' }), /分类无效/);
  assert.throws(() => service.dispatch('run'), /不支持/);
});

test('does not follow symbolic links in the memory tree', t => {
  const { root, memories, service } = fixture(t);
  const outside = path.join(root, 'outside.md'); fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(memories, 'linked.md'), 'file'); }
  catch { t.skip('当前 Windows 权限不允许创建符号链接'); return; }
  assert.equal(service.list().some(item => item.id === 'linked.md'), false);
  assert.throws(() => service.read('linked.md'), /符号链接/);
});

test('registers the built-in memory manager by default with its right-sidebar page', t => {
  const { root } = fixture(t);
  const registry = new ForgeRegistry({ root: path.join(root, 'forge'), bundledRoot: path.join(__dirname, '../plugins'),
    versions: { forge: '0.3.0', codex: '26.1021.2667.0', apiVersion: 2 } });
  const plugin = registry.list().plugins.find(item => item.id === 'forge.codex-memory');
  assert.equal(registry.errors.some(item => item.directory === 'forge.codex-memory'), false);
  assert.equal(plugin.builtin, true);
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.contributes.panels[0].builtinPage, 'codex-memory');
  assert.equal(plugin.contributes.panels[0].placement, 'right');
});

test('default catalog reads both Codex memory roots and keeps generated Markdown read only', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'memories'), current = path.join(root, 'memories_v2');
  fs.mkdirSync(path.join(legacy, 'extensions', 'ad_hoc', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(current, 'extensions', 'ad_hoc', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(current, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'MEMORY.md'), 'editable core');
  fs.writeFileSync(path.join(legacy, 'memory_summary.md'), 'generated summary');
  fs.writeFileSync(path.join(legacy, 'raw_memories.md'), 'generated raw memory');
  fs.writeFileSync(path.join(legacy, 'extensions', 'ad_hoc', 'notes', 'legacy.md'), 'legacy note');
  fs.writeFileSync(path.join(current, 'memory_summary.md'), 'current summary');
  fs.writeFileSync(path.join(current, 'rollout_summaries', 'session.md'), 'history');
  fs.writeFileSync(path.join(current, 'extensions', 'ad_hoc', 'notes', 'current.md'), 'current note');

  const service = new CodexMemory({ codexHome: root });
  const files = service.list();
  const byId = new Map(files.map(file => [file.id, file]));
  assert.equal(byId.get('memories/MEMORY.md').editable, true);
  assert.equal(byId.get('memories/memory_summary.md').editable, false);
  assert.equal(byId.get('memories/raw_memories.md').editable, false);
  assert.equal(byId.get('memories_v2/memory_summary.md').editable, false);
  assert.equal(byId.get('memories_v2/rollout_summaries/session.md').editable, false);
  assert.equal(service.list({ category: 'summaries' }).length, 3);
  assert.equal(byId.get('memories/extensions/ad_hoc/notes/legacy.md').deletable, true);
  assert.equal(byId.get('memories_v2/extensions/ad_hoc/notes/current.md').deletable, true);
  assert.equal(files.some(file => file.id.includes('/.git/')), false);

  const note = service.create('新的记忆', '内容');
  assert.equal(note.id, 'memories_v2/extensions/ad_hoc/notes/新的记忆.md');
  assert.throws(() => service.write('memories/raw_memories.md', 'overwrite', service.read('memories/raw_memories.md').hash), /只读/);
});

test('catalog includes files after hidden entries, counts categories and sees external edits', t => {
  const { memories, service } = fixture(t);
  const first = service.create('Alpha', 'first');
  service.create('Beta', 'second');
  const directory = path.join(memories, 'extensions', 'ad_hoc', 'notes');
  fs.writeFileSync(path.join(directory, '.hidden.md'), 'skip');
  assert.equal(service.catalog().counts.notes, 2);
  assert.equal(service.catalog({ category: 'history' }).counts.notes, 2);
  assert.equal(service.catalog({ query: 'second' }).items[0].name, 'Beta');
  fs.writeFileSync(path.join(directory, 'Alpha.md'), 'external update');
  assert.equal(service.catalog({ query: 'external update' }).items[0].id, first.id);
  assert.equal(service.catalog({ root: 'memories' }).roots[0].exists, true);
  assert.throws(() => service.catalog({ root: '../' }), /来源无效/);
});

test('renames notes with conflict detection and preserves content without replacing another file', t => {
  const { service } = fixture(t);
  const note = service.create('Before', 'original');
  service.create('Existing', 'keep');
  assert.throws(() => service.rename(note.id, 'After', 'stale'), /已发生变化/);
  assert.throws(() => service.rename(note.id, 'Existing', note.hash), /同名/);
  const renamed = service.dispatch('rename', { id: note.id, name: 'After', expectedHash: note.hash });
  assert.equal(renamed.name, 'After');
  assert.equal(renamed.content, 'original');
  assert.throws(() => service.read(note.id), /不存在/);
});
