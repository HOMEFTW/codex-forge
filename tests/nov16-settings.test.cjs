const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('typescript');
const fixture = require('./fixtures/native-rspack-nov16.json');
const adapter = require('../adapters/26.1111.2228.0.json');
const extension = fs.readFileSync(require('node:path').join(__dirname, '../runtime/native-tabs-renderer.js'), 'utf8');
const normalize = value => JSON.parse(JSON.stringify(value));

async function settings() {
  const { patchNov16Factory } = await import('../scripts/native-nov16-patch.mjs');
  const patched = patchNov16Factory(fixture.F4PH, 'F4PH');
  const tree = ts.createSourceFile('settings.js', '({' + patched + '})', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = [];
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name.text.startsWith('__forge')) functions.push(node.getText(tree));
    ts.forEachChild(node, walk);
  }
  walk(tree);
  const calls = [], icon = {}, title = {}, pending = Promise.resolve('native loaded');
  const native = kind => (...args) => {
    assert.notEqual(args[0], 'codex-forge', 'custom slug must not reach a native-only registry');
    calls.push({ kind, args });
    return kind === 'icon' ? icon : kind === 'title' ? title : pending;
  };
  const helpers = vm.runInNewContext(functions.join('\n') + ';({title:__forgeSettingsTitle,icon:__forgeSettingsIcon,preload:__forgePreloadSettings,targets:__forgeSettingsSearchTargets})', {
    ex: { G: native('title') }, eC: { y: native('icon') }, ek: { OU: native('preload') },
  });
  return { helpers, calls, icon, title, pending };
}

test('Nov16 settings navigation and search handle the custom title, icon and hover without importing an unknown page', async () => {
  const { helpers, calls, icon } = await settings();
  assert.deepEqual(normalize(helpers.title('codex-forge')), { id: 'codexForge.settings', defaultMessage: 'Codex Forge 插件设置' });
  assert.equal(helpers.icon('codex-forge', true), icon);
  await helpers.preload('codex-forge');
  assert.deepEqual(calls, [{ kind: 'icon', args: ['plugins-settings', true] }]);
});

test('Nov16 settings search indexes the Forge section without mutating the native catalog', async () => {
  const { helpers } = await settings();
  const native = Object.freeze([{ sectionSlug: 'general-settings', messages: [] }]);
  const targets = helpers.targets(native);
  assert.equal(targets[0], native[0]);
  assert.equal(native.length, 1);
  assert.deepEqual(normalize(targets[1]), { sectionSlug: 'codex-forge', messages: [], terms: ['Forge', '插件'] });
  assert.match(helpers.title(targets[1].sectionSlug).defaultMessage, /Forge/);
});

test('Nov16 settings preserve native title/icon arguments and the original preload promise', async () => {
  const { helpers, calls, icon, title, pending } = await settings();
  for (const slug of ['general-settings', 'plugins-settings', 'local-environments']) {
    assert.equal(helpers.title(slug, false, true), title);
    assert.equal(helpers.icon(slug, 'theme'), icon);
    assert.equal(helpers.preload(slug, 'option'), pending);
    assert.deepEqual(calls.splice(0), [
      { kind: 'title', args: [slug, false, true] },
      { kind: 'icon', args: [slug, 'theme'] },
      { kind: 'preload', args: [slug, 'option'] },
    ]);
  }
});

test('Nov16 new settings/workspace factories bind the verified original code and reject changed input', async () => {
  const { patchRspackMember } = await import('../scripts/native-rspack-patch.mjs');
  for (const id of ['HHvo', 'KM95', 'B6RU', 'RNoz', 'F4PH', 'LxTx', 'UTF2']) {
    const original = fixture[id], actual = adapter.rspackModules.find(m => m.id === id);
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), actual.sha256);
    const source = '({' + original + '})';
    const spec = [{ ...actual, start: 2, end: original.length + 2 }];
    const patched = patchRspackMember(source, actual.member, spec, extension, adapter.patchSet);
    const parsed = ts.createSourceFile(id + '.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.deepEqual(parsed.parseDiagnostics, [], id);
    assert.throws(() => patchRspackMember(source.replace(id + '(', 'xxxx('), actual.member, spec, extension, adapter.patchSet), /digest changed/);
  }
});
