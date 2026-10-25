'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DshCompatibilityLayer, inspectDshBundle, compatibility } = require('../runtime/dsh-compat.cjs');

function bundle(root, name = '@deepseek-ai/example-bundle') {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.3', description: 'fixture', peerDependencies: { '@deepseek-ai/dsh-app-boot': '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  fs.writeFileSync(path.join(directory, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n');
  return directory;
}

test('DSH compatibility layer inspects bundle metadata without evaluating its patch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dsh-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = bundle(root), info = inspectDshBundle(directory);
  assert.equal(info.kind, 'dsh-bundle'); assert.equal(info.name, '@deepseek-ai/example-bundle');
  assert.equal(info.patch, 'cordis.patch.yml'); assert.equal(info.patchBytes > 0, true);
  assert.equal(compatibility(info, { runtimeVersion: '1.2.0' }).compatible, true);
  assert.equal(compatibility(info, { runtimeVersion: '2.0.0' }).compatible, false);
});

test('DSH profile discovery is read-only and reports missing or incompatible bundles', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dsh-home-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, 'profiles', 'acp'); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/example-bundle'] } } }));
  bundle(profile);
  const layer = new DshCompatibilityLayer({ home, runtimeVersion: '2.0.0' }), result = layer.snapshot();
  assert.equal(result.available, true); assert.equal(result.readOnly, true); assert.equal(result.manager, 'native-dsh-plugin-manager');
  assert.equal(result.bundles[0].available, true); assert.equal(result.bundles[0].compatibility.compatible, false);
  assert.equal(layer.snapshot('missing').available, false);
});

test('DSH compatibility layer rejects patch traversal and non-bundles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dsh-invalid-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0', dsh: { bundle: { patch: '../outside.yml' } } }));
  assert.throws(() => inspectDshBundle(root), /路径|越出/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));
  assert.throws(() => inspectDshBundle(root), /bundle/);
});
