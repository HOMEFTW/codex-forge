const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('26.1021.2667.0 settings patches expose the Forge mount and visible route', async () => {
  const { patchSettingsPage, patchSettingsVisibility } = await import('../scripts/native-settings-patch.mjs');
  const visibility = [
    'case`plugins-settings`:return{visible:h,pending:!1};',
    'co=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`',
    '"plugins-settings":`codexOrWorkLocal`,"file-type-handlers"',
  ].join('\n');
  const visible = patchSettingsVisibility(visibility, { version: 'current' });
  assert.match(visible, /case`codex-forge`:return\{visible:!0/);
  assert.match(visible, /`plugins-settings`,`codex-forge`,`file-type-handlers`/);
  assert.match(visible, /"codex-forge":`codexOrWorkLocal`/);
  const page = [
    'slugs:[`plugins-settings`,`file-type-handlers`',
    'label:(0,Q.jsx)(dn,{codexMicroDeviceModel:D,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:O,slug:e.slug})',
    'Fe=a}let Ie;',
  ].join('\n');
  const patched = patchSettingsPage(page, { version: 'current' });
  assert.match(patched, /`plugins-settings`,`codex-forge`,`file-type-handlers`/);
  assert.match(patched, /data-forge-settings-mount/);
  assert.match(patched, /codexForge\.settings/);
});

test('new adapter separates MSIX identity and official feed build versions', () => {
  const adapter = JSON.parse(fs.readFileSync(path.join(__dirname, '../adapters/26.1021.2667.0.json'), 'utf8'));
  assert.equal(adapter.codexVersion, '26.1021.2667.0');
  assert.equal(adapter.codexBuildVersion, '26.1021.3705.0');
  assert.equal(adapter.members.network, '.vite/build/application-network-startup-Bu9OoKJq.js');
  assert.equal(adapter.nativeSymbols.registryMap, 'mH');
  assert.match(adapter.nativeSymbols.scopeAnchor, /function fGt/);
});
