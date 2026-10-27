const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compose, loadBundle, loadProfile, plan, apply, safeResolve } = require('../runtime/forge-bundles.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, 'bundles'), { recursive: true });
  fs.mkdirSync(path.join(project, 'bundles'), { recursive: true });
  const bundle = (base, id, entries) => {
    const directory = path.join(base, 'bundles', id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify({ schemaVersion: 1, id, name: id, version: '1.0.0', patch: './patch.json' }));
    fs.writeFileSync(path.join(directory, 'patch.json'), JSON.stringify({ schemaVersion: 1, entries }));
  };
  const patch = (relative, entries) => {
    fs.writeFileSync(path.join(home, relative), JSON.stringify({ schemaVersion: 1, entries }));
  };
  const profile = value => fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify(value));
  return { root, home, project, bundle, patch, profile };
}

function fakeRegistry(manifests) {
  const entries = new Map(Object.entries(manifests).map(([id, manifest]) => [id, { manifest }]));
  const state = new Map(), settings = new Map();
  return {
    entries,
    status: id => ({ requestedEnabled: state.get(id)?.enabled ?? false, enabled: state.get(id)?.enabled ?? false, reasons: [] }),
    setEnabled: (id, enabled) => { assert(entries.has(id), '插件不存在'); state.set(id, { ...(state.get(id) || {}), enabled }); },
    settings: (id, value) => {
      if (value === undefined) return { ...(settings.get(id) || {}) };
      const allowed = Object.keys(manifests[id].contributes?.settings?.properties || {});
      for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error('未知设置：' + key);
      settings.set(id, { ...value });
      return value;
    },
  };
}

test('compose applies last-write-wins by id and records every source', () => {
  const result = compose([
    { name: 'bundle:a', kind: 'bundle', path: '/a', entries: [{ id: 'x.one', enabled: true, settings: { first: 1 } }, { id: 'x.two', enabled: true }] },
    { name: 'patch:user', kind: 'patch', path: '/u', entries: [{ id: 'x.one', settings: { second: 2 } }] },
  ]);
  assert.deepEqual(result.sources.map(item => item.name), ['bundle:a', 'patch:user']);
  assert.deepEqual(result.entries.map(item => item.id), ['x.one', 'x.two']);
  const one = result.entries[0];
  assert.deepEqual(one.settings, { second: 2 }, 'later layer replaces the settings object instead of merging it');
  assert.equal(one.enabled, true, 'enabled is inherited when the later layer omits it');
  assert.equal(one.source, 'patch:user');
});

test('compose rejects duplicate ids inside one layer and unknown entry fields', () => {
  assert.throws(() => compose([{ name: 'layer', kind: 'patch', entries: [{ id: 'x.one' }, { id: 'x.one' }] }]), /重复条目/);
  assert.throws(() => compose([{ name: 'layer', kind: 'patch', entries: [{ id: 'x.one', extra: 1 }] }]), /未知字段/);
  assert.throws(() => compose([{ name: 'layer', kind: 'patch', entries: [{ id: 'bad id' }] }]), /插件 ID 无效/);
  assert.throws(() => compose([{ name: 'layer', kind: 'patch', entries: [{ id: 'x.one', enabled: 'yes' }] }]), /必须为布尔值/);
});

test('bundle and profile load from JSON and reject path escapes', t => {
  const f = fixture(t);
  f.bundle(f.project, 'forge.builtin', [{ id: 'x.one', enabled: true }]);
  const bundle = loadBundle(path.join(f.project, 'bundles', 'forge.builtin'), { builtin: true });
  assert.equal(bundle.id, 'forge.builtin'); assert.equal(bundle.builtin, true);
  assert.deepEqual(bundle.entries.map(item => item.id), ['x.one']);

  const escaping = path.join(f.project, 'bundles', 'forge.bad');
  fs.mkdirSync(escaping, { recursive: true });
  fs.writeFileSync(path.join(escaping, 'bundle.json'), JSON.stringify({ schemaVersion: 1, id: 'forge.bad', name: 'bad', version: '1.0.0', patch: '../outside.json' }));
  assert.throws(() => loadBundle(escaping), /相对路径|越出/);

  f.profile({ schemaVersion: 1, bundles: ['forge.builtin'], patches: ['user.patch.json'] });
  assert.deepEqual(loadProfile(f.home).bundles, ['forge.builtin']);
  f.profile({ schemaVersion: 1, bundles: ['forge.builtin', 'forge.builtin'] });
  assert.throws(() => loadProfile(f.home), /不能重复/);
  assert.throws(() => safeResolve(f.home, 'file.txt'), /不存在/);
});

test('plan orders bundles, user patches and the CLI overlay', t => {
  const f = fixture(t);
  f.bundle(f.project, 'forge.builtin', [{ id: 'x.one', enabled: true, settings: { greeting: 'builtin' } }]);
  f.patch('user.patch.json', [{ id: 'x.one', settings: { greeting: 'user' } }, { id: 'x.two', enabled: false }]);
  f.profile({ schemaVersion: 1, bundles: ['forge.builtin'], patches: ['user.patch.json'] });
  const value = plan({ home: f.home, projectRoot: f.project, overlay: [{ name: 'cli', entries: [{ id: 'x.one', enabled: false }] }] });
  assert.deepEqual(value.sources.map(item => item.name), ['bundle:forge.builtin', 'patch:user.patch.json', 'overlay:cli']);
  const one = value.entries.find(item => item.id === 'x.one');
  assert.deepEqual(one.settings, { greeting: 'user' });
  assert.equal(one.enabled, false, 'CLI overlay wins');
  assert.equal(value.entries.find(item => item.id === 'x.two').enabled, false);
});

test('apply enables plugins, shallow-merges settings and reports missing plugins', t => {
  const f = fixture(t);
  f.bundle(f.project, 'forge.builtin', [{ id: 'x.one', enabled: true, settings: { greeting: 'hi' } }, { id: 'x.missing', enabled: true }, { id: 'x.two', settings: { nope: 1 } }]);
  f.profile({ schemaVersion: 1, bundles: ['forge.builtin'] });
  const registry = fakeRegistry({
    'x.one': { id: 'x.one', contributes: { settings: { properties: { greeting: { type: 'string', title: 'G' }, keep: { type: 'string', title: 'K' } } } } },
    'x.two': { id: 'x.two', contributes: { settings: { properties: { greeting: { type: 'string', title: 'G' } } } } },
  });
  registry.settings('x.one', { keep: 'existing' });
  const value = plan({ home: f.home, projectRoot: f.project });
  const result = apply(registry, value);
  assert.deepEqual(result.missing, ['x.missing']);
  assert.deepEqual(result.settingsErrors.map(item => item.id), ['x.two']);
  assert.equal(registry.status('x.one').requestedEnabled, true);
  assert.deepEqual(registry.settings('x.one'), { keep: 'existing', greeting: 'hi' }, 'unmentioned settings are preserved');
  assert.equal(apply(registry, value).applied.length, 1, 'applying twice is idempotent');
});
