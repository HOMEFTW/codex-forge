'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SkillsStore, SKILL_MCP_TOOLS, invokeSkillTool, AGENTS } = require('../runtime/skills.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-skills-test-'));
  t.after(() => {
    assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('fast-skills-test-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const bundleRoot = path.join(temporary, 'bundle'), root = path.join(temporary, 'state');
  const specs = [
    ['test-method', 'experts', { 'SKILL.md': '---\nname: test-method\n---\n方法正文\n', 'scripts/helper.py': 'print("fixture only")\n', 'references/guide.md': '中文参考\n'.repeat(12), 'assets/sample.bin': Buffer.from([0, 255, 1]) }],
    ['test-science', 'science', { 'SKILL.md': '# Science fixture\n', 'references/data.csv': 'value,unit\n2,m\n' }],
  ];
  const skills = [], files = [];
  for (const [id, pack, contents] of specs) {
    const directory = `${pack}/skills/${id}`;
    const resources = Object.entries(contents).map(([relative, content]) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const target = path.join(bundleRoot, directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      const resource = { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
      files.push({ ...resource, path: `${directory}/${relative}` }); return resource;
    });
    skills.push({ id, pack, directory, name: id === 'test-method' ? '测试方法' : '科学测试', description: 'Fixture for persistence and safe reads', category: pack, license: 'MIT', source: { repository: 'https://example.test/skills', commit: 'a'.repeat(40), path: directory }, compatibility: { status: 'adapted', detail: 'Use actual available tools.' }, availability: 'bundled', needsEnv: false, needsKey: false, fileCount: resources.length, bytes: resources.reduce((sum, file) => sum + file.bytes, 0), files: resources });
  }
  const catalog = { schemaVersion: 1, source: { commit: 'a'.repeat(40) }, inventory: { packs: 2, skills: skills.length, files: files.length, resourceFiles: files.length - skills.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }, packs: [{ id: 'experts', name: 'Experts', count: 1 }, { id: 'science', name: 'Science', count: 1 }], skills, files };
  fs.writeFileSync(path.join(bundleRoot, 'catalog.json'), JSON.stringify(catalog));
  return { temporary, root, bundleRoot, catalog, store: new SkillsStore({ root, bundleRoot }) };
}

test('all four Codeg packs preserve all 37 skills and every committed resource', t => {
  const { root } = fixture(t);
  const store = new SkillsStore({ root });
  const snapshot = store.list();
  assert.equal(snapshot.inventory.skills, 37);
  assert.deepEqual(Object.fromEntries(snapshot.packs.map(pack => [pack.id, pack.count])), { experts: 14, science: 13, office: 9, ui: 1 });
  assert.equal(snapshot.source.commit, 'bed8931485d2de6ab65c83e182fbd4a79c72e12b');
  assert.equal(snapshot.source.officeCommit, '06ab520135a5289d0556d3e47fc2d42523f86547');
  assert.equal(snapshot.skills.filter(skill => skill.enabled).length, 0);
  const verified = store.verify();
  assert.equal(verified.ok, true);
  assert.equal(verified.files, store.catalog.files.length);
  assert.equal(store.catalog.skills.reduce((sum, skill) => sum + skill.fileCount - 1, 0), snapshot.inventory.resourceFiles);
  const morph = store.files('morph-ppt', { requireEnabled: false });
  assert.equal(morph.files.length, 111);
  assert.ok(morph.files.some(file => file.path === 'reference/morph-helpers.py'));
  assert.ok(morph.files.some(file => file.path.startsWith('reference/styles/') && file.path.endsWith('build.sh')));
  const scientific = store.files('scientific-visualization', { requireEnabled: false });
  assert.ok(scientific.files.some(file => file.path.endsWith('.mplstyle')));
  assert.ok(store.read('ui-render', { requireEnabled: false }).instructions.includes('不能宣称') || store.read('ui-render', { requireEnabled: false }).compatibility.detail.includes('不能宣称'));
});

test('default disabled state and per-agent choices persist without touching native skills', async t => {
  const { store, root, bundleRoot, temporary } = fixture(t);
  const nativeSkills = path.join(temporary, 'skills', 'user-skill');
  fs.mkdirSync(nativeSkills, { recursive: true }); fs.writeFileSync(path.join(nativeSkills, 'SKILL.md'), 'user-owned');
  assert.equal(store.list({ enabledOnly: true }).skills.length, 0);
  assert.match(store.promptCatalog(), /无。技能包默认关闭/);
  await store.setEnabled('test-method', true, 'codex');
  const reopened = new SkillsStore({ root, bundleRoot });
  assert.equal(reopened.list({ enabledOnly: true }).skills[0].id, 'test-method');
  for (const agent of AGENTS.filter(item => item !== 'codex')) assert.equal(reopened.list({ enabledOnly: true, agent }).skills.length, 0);
  await reopened.setEnabled('test-method', true, 'claude');
  const externalInstructions = reopened.promptCatalog('claude');
  assert.ok(externalInstructions.includes(path.join(bundleRoot, 'experts', 'skills', 'test-method', 'SKILL.md')));
  assert.match(externalInstructions, /自己的原生文件读取工具/);
  assert.match(externalInstructions, /SKILL.md（已核对 SHA256）/);
  await store.setEnabled('test-method', false, 'codex');
  assert.deepEqual(store.list({ agent: 'claude', enabledOnly: true }).skills[0].enabledAgents, ['claude']);
  assert.equal(store.list({ enabledOnly: true }).skills.length, 0);
  assert.equal(fs.readFileSync(path.join(nativeSkills, 'SKILL.md'), 'utf8'), 'user-owned');
  assert.deepEqual(fs.readdirSync(root), ['enabled.json']);
});

test('concurrent stores merge enable changes under one process-safe lock', async t => {
  const { store, root, bundleRoot } = fixture(t);
  const other = new SkillsStore({ root, bundleRoot });
  await Promise.all([store.setEnabled('test-method', true), other.setEnabled('test-science', true)]);
  assert.equal(store.list({ enabledOnly: true }).skills.length, 2);
  assert.equal(store.list().revision, 2);
  assert.equal(fs.existsSync(path.join(root, 'enabled.lock')), false);
});

test('search, pack filters and validation use the real catalog', async t => {
  const { store } = fixture(t);
  assert.equal(store.list({ query: '测试方法' }).skills[0].id, 'test-method');
  assert.equal(store.list({ pack: 'science' }).skills[0].id, 'test-science');
  assert.equal(store.list({ query: 'not-found' }).skills.length, 0);
  assert.throws(() => store.list({ pack: '../' }), /Unknown skill pack/);
  assert.throws(() => store.list({ agent: 'unknown' }), /Unsupported skill agent/);
  await assert.rejects(store.setEnabled('unknown', true), /Skill not found/);
  await assert.rejects(store.setEnabled('test-method', 'true'), /boolean/);
});

test('model tools can read enabled skill and resource pages, but cannot bypass user enablement', async t => {
  const { store } = fixture(t);
  assert.deepEqual(SKILL_MCP_TOOLS.map(tool => tool.name), ['skill_list', 'skill_read', 'skill_files']);
  assert.equal(invokeSkillTool(store, 'skill_list').skills.length, 0);
  assert.throws(() => invokeSkillTool(store, 'skill_read', { id: 'test-method' }), /disabled/);
  assert.throws(() => invokeSkillTool(store, 'skill_read', { id: 'test-method', requireEnabled: false }), /Unknown skill tool argument/);
  assert.throws(() => invokeSkillTool(store, 'skill_list', { agent: 'claude' }), /Unknown skill tool argument/);
  assert.ok(store.read('test-method', { requireEnabled: false }).content.includes('方法正文'));
  await store.setEnabled('test-method', true);
  const header = invokeSkillTool(store, 'skill_read', { id: 'test-method' });
  assert.match(header.instructions, /用户与当前系统\/开发者指令优先/);
  assert.match(store.promptCatalog(), /test-method/);
  const first = invokeSkillTool(store, 'skill_read', { id: 'test-method', path: 'references/guide.md', limit: 7 });
  const second = invokeSkillTool(store, 'skill_read', { id: 'test-method', path: 'references/guide.md', offset: first.nextOffset, limit: 7 });
  assert.equal(first.content + second.content, '中文参考\n'.repeat(12).slice(0, 14));
  assert.equal(invokeSkillTool(store, 'skill_files', { id: 'test-method' }).files.length, 4);
  assert.equal(store.read('test-method', { path: 'assets/sample.bin' }).binary, true);
  assert.throws(() => invokeSkillTool(store, 'skill_read', { id: 'test-method' }, 'grok'), /disabled/);
});

test('rejects traversal, absolute paths, alternate separators, and files outside the manifest', t => {
  const { store } = fixture(t);
  for (const relative of ['../SKILL.md', 'references/../../secret', 'C:/secret', '/secret', 'references\\guide.md', 'SKILL.md:stream', './SKILL.md', 'references//guide.md', '%2e%2e/secret', 'missing.md']) {
    assert.throws(() => store.read('test-method', { path: relative, requireEnabled: false }), /path|manifest/);
  }
  assert.throws(() => store.files('../test-method', { requireEnabled: false }), /Invalid skill ID/);
  assert.throws(() => store.read('test-method', { requireEnabled: false, limit: 100001 }), /range/);
  assert.throws(() => store.read('test-method', { requireEnabled: false, offset: -1 }), /range/);
});

test('detects changed bytes before returning instructions or executable resources', t => {
  const { store, bundleRoot } = fixture(t);
  fs.writeFileSync(path.join(bundleRoot, 'experts/skills/test-method/scripts/helper.py'), 'injected modified code\n');
  assert.throws(() => store.read('test-method', { path: 'scripts/helper.py', requireEnabled: false }), /integrity/);
  assert.throws(() => store.verify(), /integrity/);
});

test('rejects directory junctions to resources outside the bundle', t => {
  const { store, bundleRoot, temporary } = fixture(t);
  const directory = path.join(bundleRoot, 'experts/skills/test-method/scripts');
  const outside = path.join(temporary, 'outside');
  fs.renameSync(directory, outside);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.read('test-method', { path: 'scripts/helper.py', requireEnabled: false }), /symbolic links/);
});

test('invalid state surfaces an error and does not overwrite user data', async t => {
  const { store, root } = fixture(t);
  const invalid = '{broken user-owned settings';
  fs.writeFileSync(path.join(root, 'enabled.json'), invalid);
  assert.throws(() => store.list(), /JSON|Unexpected|Expected/);
  await assert.rejects(store.setEnabled('test-method', true));
  assert.equal(fs.readFileSync(path.join(root, 'enabled.json'), 'utf8'), invalid);
});

test('rejects a manifest entry attempting to escape the bundle', t => {
  const { root, bundleRoot, catalog } = fixture(t);
  catalog.files[0].path = '../outside';
  fs.writeFileSync(path.join(bundleRoot, 'catalog.json'), JSON.stringify(catalog));
  assert.throws(() => new SkillsStore({ root, bundleRoot }), /Invalid skill resource path/);
});
