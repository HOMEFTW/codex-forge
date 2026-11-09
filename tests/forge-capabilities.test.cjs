const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITIES, METHOD_CAPABILITY, ALWAYS_ALLOWED, inferCapabilities, normalize, granted, denial, negotiate,
} = require('../runtime/forge-capabilities.cjs');

test('every forge:api method is classified as capability-gated or always allowed', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'forge-host.cjs'), 'utf8');
  const start = host.indexOf("ipcMain.handle('forge:api'");
  const end = host.indexOf("Forge API 不支持此操作", start);
  assert(start > 0 && end > start, 'forge:api handler not found');
  const methods = [...host.slice(start, end).matchAll(/case '([a-z][a-z.]*)'/g)].map(match => match[1]);
  assert(methods.length >= 18, 'forge:api method list changed unexpectedly, review the mapping');
  for (const method of methods) assert.ok(ALWAYS_ALLOWED.has(method) || METHOD_CAPABILITY[method], `unclassified method: ${method}`);
  assert.deepEqual(methods.filter(method => ALWAYS_ALLOWED.has(method)), ['context.get', 'metadata.get', 'capabilities.get']);
});

test('API 3 optional capabilities negotiate unknown names and versions without enabling unsupported calls', t => {
  const os = require('node:os');
  const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
  const { validate } = require('../runtime/forge-manifest.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-optional-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const manifest = { schemaVersion: 1, apiVersion: 3, id: 'test.optional', name: 'Optional', version: '1.0.0', compatibility: { codex: ['26.1027.6604.0'], forge: ['>=0.4.0 <0.6.0'] }, permissions: ['storage', 'nexus.read'], capabilities: [{ name: 'future.service', version: 1, optional: true }, { name: 'storage', version: 2, optional: true }, { name: 'nexus', version: 1, optional: true }] };
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
  const registry = new ForgeRegistry({ root: path.join(root, 'home'), bundledRoot: path.join(root, 'empty'), versions: { codex: '26.1027.6604.0', forge: '0.4.0', apiVersion: 3 } });
  registry.install(source); registry.setEnabled(manifest.id, true);
  assert.equal(registry.status(manifest.id).enabled, true);
  const state = negotiate(registry.get(manifest.id).manifest, { nexus: false });
  assert.equal(state[0].supported, false); assert.equal(state[0].granted, false);
  assert.equal(state[1].supported, false); assert.equal(state[1].granted, false);
  assert.equal(state[2].supported, true); assert.equal(state[2].enabled, false); assert.equal(state[2].granted, false);
  assert.equal(negotiate(manifest, { nexus: true })[2].granted, true);
  assert.match(granted(manifest, 'storage.set'), /版本 2/);
  assert.match(granted(manifest, 'nexus.request', { nexus: false }), /未启用/);
  for (const item of [{ name: 'unknown' }, { name: 'storage', version: 2 }, { name: 'unknown', optional: true }, { name: 'storage', version: -1, optional: true }]) assert.throws(() => validate({ ...manifest, capabilities: [item] }, source));
  assert.throws(() => validate({ ...manifest, permissions: ['nexus.write'], capabilities: [] }, source), /nexus.read/);
});

test('missing capability produces an actionable denial that names the fix', () => {
  const manifest = { permissions: ['panels'], capabilities: [{ name: 'panels', version: 1 }] };
  const reason = granted(manifest, 'storage.get');
  assert.match(reason, /未声明能力 "storage"/);
  assert.match(reason, /"capabilities"/);
  assert.match(reason, /permissions 包含 "storage"/);
  assert.equal(granted(manifest, 'panels.open'), null);
  assert.equal(granted(manifest, 'context.get'), null, 'reading context degrades instead of failing');
});

test('capability version mismatch fails with both versions', () => {
  const manifest = { permissions: ['storage'], capabilities: [{ name: 'storage', version: 2 }] };
  assert.match(granted(manifest, 'storage.get'), /版本 2.*版本 1/);
});

test('legacy manifests without capabilities infer from permissions', () => {
  assert.deepEqual(normalize({ permissions: ['storage', 'settings', 'panels'] }).map(item => item.name), ['panels', 'settings', 'storage']);
  assert.deepEqual(normalize({ permissions: ['composer'] }).map(item => item.name), ['composer', 'ui']);
  assert.deepEqual(normalize({ permissions: ['sidebar'] }).map(item => item.name), ['ui']);
  assert.deepEqual(normalize({ permissions: [] }), []);
  assert.deepEqual(inferCapabilities(['conversation.title']).map(item => item.name), ['conversation']);
});

test('declared capabilities keep optional flags and every name is actionable', () => {
  const declared = Object.keys(CAPABILITIES).map(name => ({ name, version: CAPABILITIES[name].version, optional: true }));
  assert.equal(normalize({ capabilities: declared, permissions: [] }).every(item => item.optional === true), true);
  for (const name of Object.keys(CAPABILITIES)) assert.match(denial('storage.get', name), new RegExp(`"${name}"`));
});
