'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { ForgeAPI5 } = require('../runtime/forge-api5.cjs');
const updates = require('../runtime/forge-plugin-updates.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-trust-'));
  const managerId = 'test.manager', targetId = 'test.trusted', compatibility = { forge: ['>=0.7.0 <0.8.0'] };
  const writePackage = (directory, version = '1.0.0', permissions = ['backend.node']) => {
    fs.mkdirSync(directory, { recursive: true });
    const manifest = { schemaVersion: 1, apiVersion: 5, id: targetId, name: 'Trusted backend fixture', version, compatibility, permissions, backend: { entry: 'backend.cjs', methods: ['echo'] } };
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, 'backend.cjs'), `exports.activate=forge=>forge.handle('echo',()=>${JSON.stringify(version)});`);
    return directory;
  };
  const managerDirectory = path.join(root, 'plugins', managerId); fs.mkdirSync(managerDirectory, { recursive: true });
  fs.writeFileSync(path.join(managerDirectory, 'plugin.json'), JSON.stringify({ schemaVersion: 1, apiVersion: 5, id: managerId, name: 'Manager fixture', version: '1.0.0', compatibility, permissions: ['plugins.read', 'plugins.manage'] }));
  const registry = new ForgeRegistry({ root, bundledRoot: path.join(root, 'empty'), versions: { forge: '0.7.0', apiVersion: 5, codex: '26.1106.6628.0' } });
  registry.setEnabled(managerId, true); registry.recordReview(managerId); registry.install(writePackage(path.join(root, 'source')));
  const backends = { workers: new Map(), sync: async () => {}, dispose: async () => {}, disposePlugin: async () => {}, tools: () => [], providers: () => [], hooks: () => [] };
  const api = new ForgeAPI5({ root, registry, backendManager: backends, taskRuntime: { dispose: async () => {} } });
  t.after(async () => { await api.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const toggle = enabled => api.dispatch(managerId, 'plugins.enable', { id: targetId, enabled });
  const review = () => { registry.setEnabled(targetId, true); registry.recordReview(targetId); };
  const stage = (version, permissions) => registry.install(writePackage(path.join(root, 'source-' + version), version, permissions));
  return { root, registry, api, targetId, toggle, review, stage };
}

test('API5 plugins.manage cannot first-enable an unreviewed trusted Node backend', async t => {
  const f = fixture(t);
  assert.equal(f.registry.reviewed(f.targetId), false);
  await assert.rejects(f.toggle(true), { code: 'PERMISSION_DENIED' });
  assert.equal(f.registry.status(f.targetId).enabled, false);
});

test('API5 plugin false-to-true toggles cannot mint a human review receipt', async t => {
  const f = fixture(t); await f.toggle(false);
  assert.equal(f.registry.state().plugins[f.targetId].fingerprint, f.registry.get(f.targetId, false).fingerprint);
  assert.equal(f.registry.reviewed(f.targetId), false);
  await assert.rejects(f.toggle(true), { code: 'PERMISSION_DENIED' });
  f.review(); await f.toggle(false); await f.toggle(true);
  assert.equal(f.registry.status(f.targetId).enabled, true);
});

test('API5 changing reviewed package contents invalidates later plugin enable requests', async t => {
  const f = fixture(t); f.review();
  fs.appendFileSync(path.join(f.registry.get(f.targetId).root, 'backend.cjs'), '\n// changed package\n');
  f.registry.reload(); await f.toggle(false);
  assert.equal(f.registry.reviewed(f.targetId), false);
  await assert.rejects(f.toggle(true), { code: 'PERMISSION_DENIED' });
});

test('API5 a permission-preserving update migrates a real host review receipt', async t => {
  const f = fixture(t); f.review();
  const oldFingerprint = f.registry.get(f.targetId).fingerprint;
  f.stage('1.1.0'); const result = updates.applyPending(f.registry);
  assert.equal(result[0].status, 'installed'); assert.equal(result[0].permissionsChanged, false);
  assert.notEqual(f.registry.get(f.targetId).fingerprint, oldFingerprint);
  assert.equal(f.registry.reviewed(f.targetId), true);
  await f.toggle(false); await f.toggle(true);
  assert.equal(f.registry.status(f.targetId).enabled, true);
});

test('API5 an expanded-permission update requires another host review', async t => {
  const f = fixture(t); f.review(); f.stage('1.1.0', ['backend.node', 'settings']);
  const result = updates.applyPending(f.registry);
  assert.equal(result[0].status, 'installed'); assert.equal(result[0].permissionsChanged, true);
  assert.equal(f.registry.status(f.targetId).enabled, false); assert.equal(f.registry.reviewed(f.targetId), false);
  await f.toggle(false); await assert.rejects(f.toggle(true), { code: 'PERMISSION_DENIED' });
});

test('API5 a permission-preserving update cannot create a missing host review receipt', async t => {
  const f = fixture(t); await f.toggle(false); f.stage('1.1.0');
  const result = updates.applyPending(f.registry);
  assert.equal(result[0].status, 'installed'); assert.equal(result[0].permissionsChanged, false);
  assert.equal(f.registry.status(f.targetId).enabled, false); assert.equal(f.registry.reviewed(f.targetId), false);
  await assert.rejects(f.toggle(true), { code: 'PERMISSION_DENIED' });
});


test('API5 expanding consumed services invalidates the previous human review',async t=>{
 const f=fixture(t);f.review();const source=path.join(f.root,'service-expansion');fs.cpSync(f.registry.get(f.targetId).root,source,{recursive:true});
 const file=path.join(source,'plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));manifest.version='1.2.0';manifest.permissions.push('services.call');manifest.consumes={services:['test.provider.extra']};fs.writeFileSync(file,JSON.stringify(manifest));
 f.registry.install(source);let result=updates.applyPending(f.registry);assert.equal(result[0].permissionsChanged,true);f.review();
 const second=path.join(f.root,'another-service');fs.cpSync(f.registry.get(f.targetId).root,second,{recursive:true});manifest.version='1.3.0';manifest.consumes.services.push('test.provider.expanded');fs.writeFileSync(path.join(second,'plugin.json'),JSON.stringify(manifest));
 f.registry.install(second);result=updates.applyPending(f.registry);assert.equal(result[0].permissionsChanged,true);assert.equal(f.registry.reviewed(f.targetId),false);await assert.rejects(f.toggle(true),{code:'PERMISSION_DENIED'});
});
