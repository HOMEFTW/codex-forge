'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { NexusService, templateText, MUTATIONS } = require('../runtime/nexus.cjs');
const { hash } = require('../runtime/nexus-files.cjs');
const { expression } = require('../runtime/nexus-query.cjs');
const { invokeNexusTool } = require('../runtime/nexus-tools.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-obsidian-')), vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (file, value) => { const p = path.join(vault, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  put('主页.md', '---\ntags: [设计, 项目/轮机]\nstatus: active\n---\n# 首页\n\n[[设备/主机|主机]] ![[图片.png]]\n\n## 计划\n- [ ] 校审\n\n> [!note] 提示\n> ==重点==\n\n```text\n[[假链接]] #假标签\n- [ ] 非任务\n```\n');
  put('设备/主机.md', '---\naliases: [引擎]\ntags: [设备]\n功率: 1200\nstatus: active\n---\n# 主机\n[[主页]] #轮机/系统\n');
  put('设备/辅机.md', '---\ntags: [设备]\n功率: 300\nstatus: done\n---\n# 辅机\n[主机](主机.md)\n');
  put('模板/日记.md', '# {{title}}\n日期 {{date}}\n<% tp.file.title %>\n<% tp.date.now("YYYY-MM-DD") %>\n');
  put('模板/设备.md', '# {{NAME}}\n{{VALUE:描述}}\n');
  put('.obsidian/templates.json', { folder: '模板' }); put('.obsidian/daily-notes.json', { folder: '日记', template: '模板/日记', format: 'YYYY-MM-DD' });
  put('.obsidian/plugins/homepage/data.json', { version: 4, homepages: { Home: { value: '主页', kind: 'File' } } });
  const service = new NexusService({ root: path.join(dir, 'state') }), vaultId = service.connect(vault).vault.id;
  const call = (method, args = {}) => service.dispatch(method, { vaultId, ...args });
  return { dir, vault, put, service, vaultId, call };
}
test('vault index resolves aliases, relative links, backlinks, headings, tasks and Chinese statistics', t => {
  const { call } = fixture(t), snapshot = call('snapshot'), home = call('inspect', { path: '主页.md' }), engine = call('inspect', { path: '设备/主机.md' });
  assert.equal(snapshot.settings.homepage, '主页'); assert.equal(snapshot.totals.notes, 5);
  assert(home.links.some(l => l.path === '设备/主机.md')); assert(!home.links.some(l => l.target === '假链接'));
  assert.equal(home.tasks.length, 1); assert.equal(home.headings.length, 2); assert(home.stats.words > 0);
  assert.deepEqual(engine.backlinks.map(b => b.path).sort(), ['主页.md', '设备/辅机.md'].sort());
  assert.equal(call('resolve', { target: '引擎' }).path, '设备/主机.md');
  assert.equal(call('resolve', { target: '#计划', source: '主页.md' }).path, '主页.md');
  assert(call('graph', { path: '主页.md' }).edges.some(e => e.target === '设备/主机.md'));
  assert(!call('tags').some(t => t.tag === '假标签'));
});
test('search supports phrases, field selectors, boolean operators and nested tags', t => {
  const { call } = fixture(t);
  assert.equal(call('search', { query: 'path:设备 tag:设备 -file:辅机' }).results[0].path, '设备/主机.md');
  assert.equal(call('search', { query: '(file:主页 OR file:主机) AND NOT content:300' }).total, 2);
  assert.equal(call('search', { query: 'tag:项目' }).total, 1);
  assert.throws(() => call('search', { query: '(file:主机' }), /括号/);
});
test('write conflicts preserve outside edits; history, trash and restoration are recoverable', t => {
  const { call, put, vault } = fixture(t), old = call('read', { path: '主页.md' });
  put('主页.md', old.content + '\n外部编辑');
  assert.throws(() => call('write', { path: old.path, content: '覆盖', expectedRevision: old.revision }), /变化/);
  assert.match(fs.readFileSync(path.join(vault, old.path), 'utf8'), /外部编辑/);
  const fresh = call('read', { path: old.path }), write = call('write', { path: old.path, content: '\n新增', mode: 'append', expectedRevision: fresh.revision });
  assert(write.historyToken); assert.match(call('read', { path: old.path }).content, /外部编辑\n新增$/);
  const deleted = call('trash', { path: old.path, expectedRevision: write.revision }); assert(!fs.existsSync(path.join(vault, old.path)));
  const restored = call('restore', { token: deleted.restoreToken, expectedRevision: '' }); assert.equal(restored.path, old.path);
  assert.throws(() => call('restore', { token: deleted.restoreToken, expectedRevision: '' }), /变化/);
  assert.equal(call('history', { path: old.path }).length, 2);
});
test('vault boundary rejects traversal, hidden configs, ADS, device names, junctions and unconnected vaults', t => {
  const { call, vault, dir, service } = fixture(t);
  for (const bad of ['../secret.md', '/secret.md', 'C:/secret.md', 'a\\b.md', '.obsidian/plugins/x/main.js', 'x.md:stream', 'nul.md', 'a./b.md']) {
    assert.throws(() => call('write', { path: bad, content: 'bad', expectedRevision: '' }));
  }
  assert.throws(() => service.dispatch('read', { vaultId: 'unconnected', path: '主页.md' }), /未连接/);
  fs.mkdirSync(path.join(dir, 'outside')); fs.writeFileSync(path.join(dir, 'outside', 'secret.md'), 'private');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(vault, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => call('read', { path: 'junction/secret.md' }), /链接|联接/);
  assert(call('snapshot').warnings.some(x => x.includes('junction')));
});
test('cross-process lock prevents competing writes without stealing locks', t => {
  const { call, service, vaultId } = fixture(t), lockDir = path.join(service.root, 'locks'); fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, vaultId + '.lock'), 'busy');
  assert.throws(() => call('write', { path: '新.md', content: '', expectedRevision: '' }), /另一个 Forge/);
  assert(fs.existsSync(path.join(lockDir, vaultId + '.lock')));
});
test('properties preserve note body; task updates use source line and revision', t => {
  const { call } = fixture(t); let doc = call('read', { path: '主页.md' });
  call('properties', { path: doc.path, values: { status: 'done', 日期: '2026-11-04' }, remove: ['tags'], expectedRevision: doc.revision });
  doc = call('read', { path: doc.path }); assert.equal(doc.properties.status, 'done'); assert(!doc.properties.tags); assert(doc.content.includes('## 计划'));
  call('task', { path: doc.path, line: doc.tasks[0].line, completed: true, expectedRevision: doc.revision });
  assert.equal(call('read', { path: doc.path }).tasks[0].completed, true);
  assert.throws(() => call('task', { path: doc.path, line: 0, completed: true, expectedRevision: doc.revision }), /变化/);
});
test('Dataview supports real filtered table/list/task results and rejects script or unsupported syntax', t => {
  const { call } = fixture(t);
  const result = call('query', { language: 'dataview', query: 'TABLE 功率 AS "功率"\nFROM "设备"\nWHERE 功率 >= 300\nSORT 功率 DESC\nLIMIT 1' });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].path, '设备/主机.md'); assert.equal(result.rows[0].values[1], 1200);
  assert.equal(call('query', { query: 'LIST\nFROM #设备\nWHERE status = "done"' }).rows.length, 1);
  assert.equal(call('query', { query: 'TASK\nWHERE !completed' }).rows[0].task.text, '校审');
  assert.throws(() => call('query', { query: 'TABLE\nGROUP BY status' }), /尚未支持/);
  assert.throws(() => call('query', { language: 'dataviewjs', query: 'process.exit()' }), /仅支持/);
  for (const expr of ['file.constructor', 'constructor("return process")()', 'file["__proto__"]', 'require("fs")', 'file.name.replace("a","b")']) assert.throws(() => expression(expr));
});
test('Bases supports filters, recursive formulas, views, summaries and explicit unsupported failures', t => {
  const { call } = fixture(t);
  const query = 'filters: file.hasTag("设备")\nformulas:\n  双倍: "功率 * 2"\n  四倍: "formula.双倍 * 2"\nviews:\n  - type: table\n    name: 设备\n    order: [file.name, 功率, formula.四倍]\n    summaries:\n      功率: Sum\n  - type: cards\n    name: 卡片\n    filters: status == "active"\n    order: [file.name]\n';
  const table = call('query', { language: 'base', query }); assert.equal(table.total, 2); assert.equal(table.summaries.功率, 1500); assert(table.rows.some(r => r.values[2] === 4800));
  assert.equal(call('query', { language: 'base', query, view: '卡片' }).rows.length, 1);
  assert.throws(() => call('query', { language: 'base', query: 'views: [{type: map, name: Map}]' }), /暂不支持地图/);
  assert.throws(() => call('query', { language: 'base', query: 'formulas: {a: formula.b, b: formula.a}\nviews: [{type: table, name: Main, order: [formula.a]}]' }), /循环/);
});
test('daily and template compatibility honors existing settings and rejects execution before writes', t => {
  const { call, put, vault } = fixture(t);
  const day = call('daily', { date: '2026-11-04', expectedRevision: '' }); assert.equal(day.path, '日记/2026-11-04.md'); assert.match(day.content, /日期 2026-11-04/);
  assert.equal(call('daily', { date: '2026-11-04', expectedRevision: '' }).revision, day.revision);
  assert.throws(() => call('daily', { date: '../../oops' }), /日期/);
  put('模板/危险.md', '<%* require("fs").writeFileSync("x","x") %>');
  assert.throws(() => call('template', { template: '模板/危险.md', path: '不应创建.md', expectedRevision: '' }), /不支持/);
  assert(!fs.existsSync(path.join(vault, '不应创建.md')));
  assert.equal(templateText('<% tp.file.title %> {{VALUE:名字}}', { file: '甲.md', variables: { 名字: '乙' } }), '甲 乙');
  assert.throws(() => templateText('{{VALUE:缺失}}', { file: '甲.md' }), /缺少模板变量/);
});
test('QuickAdd nested Template and Capture workflows use revisions and reject macros', t => {
  const { call, put } = fixture(t);
  put('.obsidian/plugins/quickadd/data.json', { choices: [{ type: 'Multi', name: '轮机', choices: [{ id: 't', name: '设备', type: 'Template', templatePath: '模板/设备.md', folder: { enabled: true, folders: ['设备'] }, fileNameFormat: { enabled: true, format: '{{VALUE:设备名称}}' } }, { id: 'c', name: '捕获', type: 'Capture', captureTo: '收件.md', createFileIfItDoesntExist: { enabled: true }, format: { enabled: true, format: '- {{VALUE}}' } }, { id: 'm', name: '宏', type: 'Macro' }] }] });
  assert.equal(call('quickadd_choices')[0].label, '轮机 / 设备');
  const created = call('quickadd', { choiceId: 't', expectedRevision: '', variables: { 设备名称: '发电机', 描述: '测试描述' } }); assert.equal(created.path, '设备/发电机.md');
  call('quickadd', { choiceId: 'c', expectedRevision: '', variables: { value: '第一条' } });
  assert.throws(() => call('quickadd', { choiceId: 'c', variables: { value: '第二条' } }), /变化/);
  call('quickadd', { choiceId: 'c', variables: { value: '第二条' }, expectedRevision: call('read', { path: '收件.md' }).revision });
  assert.match(call('read', { path: '收件.md' }).content, /第一条\n- 第二条/);
  assert.throws(() => call('quickadd', { choiceId: 'm' }), /Macro/);
});
test('Advanced Tables, Outliner and bookmark edits persist and guard revisions', t => {
  const { call, put } = fixture(t);
  put('列表.md', '- A\n  - A1\n- B\n  - B1\n'); let doc = call('read', { path: '列表.md' });
  call('outline', { path: doc.path, line: 0, action: 'down', expectedRevision: doc.revision }); assert.match(call('read', { path: doc.path }).content, /^- B\n  - B1\n- A/);
  put('表格.md', '| 名称 | 数量 |\n| --- | ---: |\n| 主机 | 1 |\n'); doc = call('read', { path: '表格.md' });
  call('table', { path: doc.path, line: 0, action: 'add_row', values: ['辅机', '2'], expectedRevision: doc.revision }); assert.match(call('read', { path: doc.path }).content, /辅机/);
  const initial = call('bookmarks'); assert.equal(initial.revision, '');
  call('bookmarks_write', { items: [{ type: 'group', title: '设计', items: [{ type: 'file', path: '主页.md' }] }], expectedRevision: initial.revision });
  assert.equal(call('bookmarks').items[0].items[0].path, '主页.md');
  assert.throws(() => call('bookmarks_write', { items: [], expectedRevision: '' }), /变化/);
});
test('rename reports references, does not overwrite destination and retains recovery history', t => {
  const { call, vault } = fixture(t), doc = call('read', { path: '设备/主机.md' });
  assert.throws(() => call('rename', { path: doc.path, destination: '设备/辅机.md', expectedRevision: doc.revision }), /已存在/);
  const changed = call('rename', { path: doc.path, destination: '设备/主推进机.md', expectedRevision: doc.revision });
  assert(changed.referencesToUpdate.includes('主页.md')); assert(!fs.existsSync(path.join(vault, doc.path))); assert(changed.historyToken);
});
test('model tools cannot connect vaults or bypass operation lists', t => {
  const { service, vaultId } = fixture(t);
  assert.throws(() => invokeNexusTool(service, 'nexus_browse', { vaultId, method: 'connect' }), /不支持/);
  const doc = invokeNexusTool(service, 'nexus_read', { vaultId, path: '主页.md' }); assert.equal(doc.revision, hash(doc.content));
  assert(invokeNexusTool(service, 'nexus_vaults', {}).vaults.some(v => v.id === vaultId));
  // Simulate a future service operation changing from read to write without a schema edit.
  MUTATIONS.add('inspect');
  try {
    assert.throws(() => invokeNexusTool({ dispatch() { assert.fail('write reached dispatch'); } }, 'nexus_browse', { vaultId, method: 'inspect' }), { code: 'PERMISSION_DENIED' });
  } finally { MUTATIONS.delete('inspect'); }
});

test('snapshot pagination covers every indexed file without duplicates', t => {
  const { call } = fixture(t), full = call('snapshot'), files = [], notes = []; let offset = 0;
  do { const page = call('snapshot', { offset, limit: 2 }); assert.equal(page.offset, offset); assert(page.files.length <= 2); files.push(...page.files); notes.push(...page.notes); offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(files.map(f => f.path), full.files.map(f => f.path));
  assert.deepEqual(notes.map(n => n.path), full.notes.map(n => n.path));
  assert.equal(new Set(files.map(f => f.path)).size, full.totals.files);
  assert.deepEqual(call('snapshot', { offset: full.totals.files, limit: 2 }).files, []);
});

test('service returns stable error codes for conflicts, invalid methods and unsupported queries', t => {
  const { call } = fixture(t);
  assert.throws(() => call('write', { path: '主页.md', content: 'stale', expectedRevision: '' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => call('missing-method'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => call('query', { language: 'dataviewjs', query: 'x' }), { code: 'UNSUPPORTED_SYNTAX' });
  assert.throws(() => call('read', { path: 'missing.md' }), { code: 'NOT_FOUND' });
});
test('canonical binding survives parent junction retarget and rejects replacement of the actual root', t => {
  const { service, dir, vault, put } = fixture(t); put('原始.md', 'authorized');
  const outside = path.join(dir, 'outside'), junction = path.join(dir, 'parent-link'); fs.mkdirSync(path.join(outside, 'vault'), { recursive: true }); fs.writeFileSync(path.join(outside, 'vault', '原始.md'), 'unauthorized');
  fs.symlinkSync(dir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const id = service.connect(path.join(junction, 'vault')).vault.id;
  fs.unlinkSync(junction); fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(service.dispatch('read', { vaultId: id, path: '原始.md' }).content, 'authorized');
  fs.renameSync(vault, vault + '-original'); fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, '原始.md'), 'replacement');
  assert.throws(() => service.dispatch('read', { vaultId: id, path: '原始.md' }), /身份已变化/);
});
test('trash race preserves the exact late external contents and does not silently delete them', t => {
  const { call, vault } = fixture(t), original = fs.renameSync, doc = call('read', { path: '主页.md' }); let injected = false;
  t.after(() => { fs.renameSync = original; });
  fs.renameSync = (source, target) => { if (!injected && String(source) === path.join(vault, '主页.md') && String(target).includes('.trash')) { injected = true; fs.writeFileSync(source, 'late external content'); } return original(source, target); };
  assert.throws(() => call('trash', { path: doc.path, expectedRevision: doc.revision }), /操作期间变化/);
  assert.equal(call('read', { path: doc.path }).content, 'late external content');
});
test('a late writer cannot be overwritten during save and backup failure restores the source', t => {
  const { call, service, vault } = fixture(t), doc = call('read', { path: '主页.md' }), original = service.backup.bind(service);
  service.backup = (...args) => { const token = original(...args); fs.writeFileSync(path.join(vault, doc.path), 'late replacement'); return token; };
  assert.throws(() => call('write', { path: doc.path, content: 'ours', expectedRevision: doc.revision }), /保存期间已变化/);
  assert.equal(call('read', { path: doc.path }).content, 'late replacement');
  service.backup = () => { throw Error('simulated disk failure'); };
  const next = call('read', { path: doc.path }); assert.throws(() => call('write', { path: next.path, content: 'ours', expectedRevision: next.revision }), /disk failure/);
  assert.equal(call('read', { path: next.path }).content, 'late replacement');
});
test('settings use revisions and one global lock; workflow creation rejects nonempty or missing revisions', t => {
  const { call, put, service } = fixture(t); let settings = call('settings');
  assert.throws(() => call('settings_write', { values: { homepage: '其他' }, expectedRevision: 'stale' }), /设置已变化/);
  call('settings_write', { values: { homepage: '设备/主机' }, expectedRevision: settings.revision });
  assert.throws(() => call('settings_write', { values: { homepage: '其他' }, expectedRevision: settings.revision }), /设置已变化/);
  assert.equal(call('settings').homepage, '设备/主机');
  assert.throws(() => call('daily', { date: '2030-01-01', expectedRevision: 'stale' }), /空字符串/);
  assert.throws(() => call('daily', { date: '2030-01-01' }), /空字符串/);
  put('.obsidian/plugins/quickadd/data.json', { choices: [{ id: 'c', type: 'Capture', name: 'capture', captureTo: 'new.md', createFileIfItDoesntExist: { enabled: true } }] });
  assert.throws(() => call('quickadd', { choiceId: 'c', variables: { value: 'x' }, expectedRevision: 'stale' }), /空字符串/);
  const planned = call('quickadd_plan', { choiceId: 'c', variables: { value: 'x' } }); assert.equal(planned.expectedRevision, '');
  call('quickadd', { choiceId: 'c', variables: { value: 'x' }, expectedRevision: planned.expectedRevision });
  fs.writeFileSync(path.join(service.root, 'locks', 'configuration.lock'), 'locked');
  assert.throws(() => service.disconnect(service.vaults()[0].id), /另一个 Forge/);
});
test('multiline DQL and task grouping reproduce dashboard queries', t => {
  const { call } = fixture(t);
  const result = call('query', { source: '主页.md', query: 'TABLE WITHOUT ID\n file.link AS 笔记,\n 功率,\n dateformat(file.mtime, "yyyy-MM-dd HH:mm") AS 最近更新\nFROM "设备"\nWHERE 功率 >= 300\nAND (status = "active" OR status = "done")\nAND file.path != this.file.path\nSORT 功率 DESC' });
  assert.deepEqual(result.headers, ['笔记', '功率', '最近更新']); assert.equal(result.rows.length, 2); assert.match(result.rows[0].values[2], /^\d{4}-\d{2}-\d{2}/);
  assert(call('query', { query: 'TASK\nWHERE !completed\nGROUP BY file.link' }).rows[0].group.path);
  assert.equal(call('query', { language: 'expression', source: '主页.md', query: 'this.file.name' }).value, '主页');
});
