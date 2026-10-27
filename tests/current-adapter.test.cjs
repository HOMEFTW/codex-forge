const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const currentFast = 'function Jlo(e){let t=(0,Ylo.c)(10),n=Ua(Dj),r=e?.hostId??n,i=VO(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ns(mD,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?tn(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}';

test('26.1021.2667.0 Fast patch matches Jlo and fails closed on unknown code', async () => {
  const { patchFastAccess } = await import('../scripts/native-fast-patch.mjs');
  const patched = patchFastAccess(currentFast, { version: 'current' });
  assert.match(patched, /globalThis\.__codexForgeStartup/);
  assert.match(patched, /features|serviceTierAccess/);
  assert.throws(() => patchFastAccess(currentFast), /does not match/);
  assert.throws(() => patchFastAccess('changed', { version: 'current' }), /does not match/);
});

test('26.1021.2667.0 native tabs patch rewrites current registry symbols', async () => {
  const { patchNativeTabs, currentNativeSymbols } = await import('../scripts/native-tabs-patch.mjs');
  const extension = fs.readFileSync(path.join(__dirname, '../runtime/native-tabs-renderer.js'), 'utf8');
  const source = currentNativeSymbols.registryAnchor + 'function fGt(e){let t=(0,pGt.c)(14),{layout:n,fallback:r}=e,i=r!==void 0&&r,a=bs(Ux),o=i?qWt:KWt,s=';
  const patched = patchNativeTabs(source, extension, { version: 'current' });
  assert.match(patched, /Ksi=\[\`left\`,\`right\`\],mH=new Map,fastWorkspaceRegisterTabs\(\),qsi=/);
  assert.match(patched, /fastWorkspaceRememberScope\(a\)/);
  assert.match(patched, /mH\.get\('fast-workspace'\)/);
  assert.doesNotMatch(patched, /\bQL\.get\('fast-workspace'\)/);
});

const settingsFixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

async function settingsHarness() {
  const { patchSettingsPage } = await import('../scripts/native-settings-patch.mjs');
  const prefetched = [], selected = [], errors = [];
  const messages = { 'plugins-settings': { id: 'plugins.title', defaultMessage: 'Plugins' } };
  const intl = { formatMessage: message => message.defaultMessage };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, ...props };
  const scope = {
    intl, Q: { jsx }, $: { jsx }, URLSearchParams,
    hn: slug => messages[slug],
    dn: props => intl.formatMessage(messages[props.slug]),
    F: props => intl.formatMessage(props),
    jn: () => ({ component: { 16: 'plugin icon' }, navigation: 'plugin asset' }),
    select: slug => selected.push(slug),
    Yt: async slug => { prefetched.push(slug); if (!messages[slug]) throw Error('Missing native route'); },
    Qr: error => errors.push(error), me: 'tooltip', Wt: 'button', de: 'icon', pt: 'external'
  };
  vm.runInNewContext(patchSettingsPage(settingsFixture('native-settings-current.js'), { version: 'current' }), scope);
  return { scope, prefetched, selected, errors };
}

test('current settings navigation renders native and Forge titles, expanded and collapsed', async () => {
  const { scope } = await settingsHarness();
  for (const collapsed of [false, true]) {
    const [native, forge] = scope.renderNavigation([{ slug: 'plugins-settings' }, { slug: 'codex-forge' }], 'codex-forge', collapsed);
    assert.equal(native.children['aria-label'], 'Plugins');
    assert.equal(native.children.label, 'Plugins');
    assert.equal(forge.children['aria-label'], 'Codex Forge 插件设置');
    assert.equal(forge.children.label, 'Codex Forge 插件设置');
    assert.equal(forge.children.isActive, true);
    if (collapsed) assert.equal(forge.content, 'Codex Forge 插件设置');
  }
});

test('current Forge navigation selects its route without native lazy prefetch', async () => {
  const { scope, prefetched, selected, errors } = await settingsHarness();
  const [forge, native, disabled, appRoute] = scope.renderNavigation([
    { slug: 'codex-forge' }, { slug: 'plugins-settings' },
    { slug: 'plugins-settings', disabled: true }, { slug: 'plugins-settings', appRoute: '/plugins' }
  ], 'plugins-settings', false).map(item => item.children);
  forge.onClick(); forge.onFocus(); forge.onPointerEnter();
  disabled.onClick(); disabled.onFocus(); appRoute.onPointerEnter();
  assert.deepEqual(selected, ['codex-forge']);
  assert.deepEqual(prefetched, []);
  native.onFocus(); native.onPointerEnter();
  await Promise.resolve();
  assert.deepEqual(prefetched, ['plugins-settings', 'plugins-settings']);
  assert.deepEqual(errors, []);
});

test('current settings mounts Forge and decodes the requested plugin', async () => {
  const { scope } = await settingsHarness();
  const mount = scope.renderContent('codex-forge', { search: '?plugin=example.hello%2Fsettings' });
  assert.equal(mount['data-forge-settings-mount'], 'true');
  assert.equal(mount['data-forge-settings-plugin'], 'example.hello/settings');
  assert.equal(scope.renderContent('codex-forge', { search: '' })['data-forge-settings-plugin'], '');
  assert.equal(scope.renderContent('plugins-settings', { search: '' }), 'native content');
});

test('current visibility preserves Forge deeplinks and reuses the plugin icon', async () => {
  const { patchSettingsVisibility } = await import('../scripts/native-settings-patch.mjs');
  const scope = {};
  vm.runInNewContext(patchSettingsVisibility(settingsFixture('native-settings-visibility-current.js'), { version: 'current' }), scope);
  assert.equal(scope.visibility('codex-forge', false).visible, true);
  assert.equal(scope.visibility('plugins-settings', false).visible, false);
  const visible = scope.visible('codex-forge');
  assert.equal(visible.activeSettingsSection, 'codex-forge');
  assert.equal(visible.shouldRedirectToVisibleSettingsSection, false);
  assert.equal(visible.visibleSettingsSections.filter(section => section.slug === 'codex-forge').length, 1);
  assert.equal(scope.Va('codex-forge'), scope.Va('plugins-settings'));
  assert.equal(scope.Va('codex-forge').component[16], 'plugin icon');
  assert.equal(scope.visible('unknown').shouldRedirectToVisibleSettingsSection, true);
});

test('current settings patches reject changed or duplicate native anchors', async () => {
  const { patchSettingsPage, patchSettingsVisibility } = await import('../scripts/native-settings-patch.mjs');
  for (const [patch, fixture, anchor] of [
    [patchSettingsPage, 'native-settings-current.js', 'l=hn(e.slug,O,t),'],
    [patchSettingsVisibility, 'native-settings-visibility-current.js', 'function Va(e,t){return e===`cloud-environments`?']
  ]) {
    const source = settingsFixture(fixture);
    assert.throws(() => patch(source.replace(anchor, 'changed'), { version: 'current' }), /Native settings anchor changed/);
    assert.throws(() => patch(source + '\n' + anchor, { version: 'current' }), /Native settings anchor changed/);
    assert.throws(() => patch(patch(source, { version: 'current' }), { version: 'current' }), /Native settings anchor changed/);
  }
});

test('new adapter separates MSIX identity and official feed build versions', () => {
  const adapter = JSON.parse(fs.readFileSync(path.join(__dirname, '../adapters/26.1021.2667.0.json'), 'utf8'));
  assert.equal(adapter.codexVersion, '26.1021.2667.0');
  assert.equal(adapter.codexBuildVersion, '26.1021.3705.0');
  assert.equal(adapter.members.network, '.vite/build/application-network-startup-Bu9OoKJq.js');
  assert.equal(adapter.nativeSymbols.registryMap, 'mH');
  assert.match(adapter.nativeSymbols.scopeAnchor, /function fGt/);
  assert.equal(adapter.patchSet, 'current');
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, '../adapters/26.1016.8622.0.json'), 'utf8'));
  assert.equal(legacy.patchSet, 'legacy');
});
