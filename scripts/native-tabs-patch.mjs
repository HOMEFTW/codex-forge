import assert from 'node:assert/strict';

export const legacyNativeSymbols = {
  registryAnchor: 'FSi=[`left`,`right`],QL=new Map,ISi=',
  scopeAnchor: 'workspaceWidth:u}=e,d=E(tb),f=Wc(),p,m;',
  scopeInjection: 'workspaceWidth:u}=e,d=E(tb),f=(fastWorkspaceRememberScope(d),Wc()),p,m;',
  registryMap: 'QL', register: 'ZL', controller: 'aR', routeUnavailable: 'nb',
  fullWidth: 'cb', react: 'kCi', openPanel: 'fB', layout: 'vY',
  routeScope: 'E(tb)', fullWidthRead: 'Z(cb)',
};

export const currentNativeSymbols = {
  registryAnchor: 'Ksi=[`left`,`right`],mH=new Map,qsi=',
  scopeAnchor: 'function fGt(e){let t=(0,pGt.c)(14),{layout:n,fallback:r}=e,i=r!==void 0&&r,a=bs(Ux),o=i?qWt:KWt,s=',
  scopeInjection: 'function fGt(e){let t=(0,pGt.c)(14),{layout:n,fallback:r}=e,i=r!==void 0&&r,a=bs(Ux);fastWorkspaceRememberScope(a);let o=i?qWt:KWt,s=',
  registryMap: 'mH', register: 'pH', controller: 'CH', routeUnavailable: 'Wx',
  fullWidth: 'qx', react: 'Bci', openPanel: 'pG', layout: 'q0',
  routeScope: 'bs(Ux)', fullWidthRead: 'bs(Ux).get(qx)',
};

export const oct23NativeSymbols = {
  registryAnchor: 'nri=[`left`,`right`],JH=new Map,rri=',
  scopeAnchor: 'function yzt(e){let t=(0,bzt.c)(14),{layout:n,fallback:r}=e,i=r!==void 0&&r,a=Or(SS),o=i?ezt:$Rt,s=',
  scopeInjection: 'function yzt(e){let t=(0,bzt.c)(14),{layout:n,fallback:r}=e,i=r!==void 0&&r,a=Or(SS);fastWorkspaceRememberScope(a);let o=i?ezt:$Rt,s=',
  registryMap: 'JH', register: 'KH', controller: 'iU', routeUnavailable: 'CS',
  fullWidth: 'DS', react: 'Yri', openPanel: 'yK', layout: 'c2',
  routeScope: 'Or(SS)', fullWidthRead: 'Or(SS).get(DS)',
};

// 两个字符的符号（nb/cb）如果按字面量整体替换，会误改 inbound、callback 这类
// 子串；表达式锚点（E(tb)、Z(cb)）又必须先于标识符替换，否则会被拆开。这里对
// 标识符使用词边界正则，并对关键符号断言必须命中，避免静默产出坏补丁。
function rewriteExtension(extension, symbols) {
  if (symbols === legacyNativeSymbols) return extension;
  let result = extension;
  for (const [from, to] of [['E(tb)', symbols.routeScope], ['Z(cb)', symbols.fullWidthRead]]) result = result.replaceAll(from, () => to);
  for (const [from, to, required] of [
    ['QL', symbols.registryMap, true], ['ZL', symbols.register, true], ['aR', symbols.controller, true],
    ['nb', symbols.routeUnavailable, false], ['cb', symbols.fullWidth, false], ['kCi', symbols.react, false],
    ['fB', symbols.openPanel, false], ['vY', symbols.layout, false],
  ]) {
    const pattern = new RegExp(`\\b${from}\\b`, 'g'), hits = (result.match(pattern) || []).length;
    if (required) assert(hits > 0, `Native symbol ${from} missing from the workspace extension`);
    result = result.replace(pattern, () => to);
  }
  // Retained-route matching is optional; the current renderer removed these
  // private signals, so avoid carrying unresolved identifiers into its scope.
  result = result.replaceAll("typeof By !== 'undefined' && scope.get(By) === threadId", 'false');
  result = result.replaceAll("typeof HE === 'undefined' ? null : scope.get(HE)", 'null');
  result = result.replaceAll('Ol(value.clientThreadId) === threadId', 'value.clientThreadId.replace(/^client:/, ``) === threadId');
  return result;
}

export function patchNativeTabs(source, extension, { version = 'legacy', symbols } = {}) {
  const selected = symbols || (version === 'oct23' ? oct23NativeSymbols : version === 'current' ? currentNativeSymbols : legacyNativeSymbols);
  for (const anchor of [selected.registryAnchor, selected.scopeAnchor]) {
    assert.equal(source.split(anchor).length, 2, 'Native workspace anchor changed: ' + anchor);
  }
  assert(extension.includes('function fastWorkspaceRegisterTabs('));
  assert(extension.includes('function fastWorkspaceRememberScope('));
  const registryMapAnchor = selected.registryMap + '=new Map,';
  assert.equal(selected.registryAnchor.split(registryMapAnchor).length, 2, 'Native registry map anchor changed');
  const registryReplacement = selected.registryAnchor.replace(registryMapAnchor, registryMapAnchor + 'fastWorkspaceRegisterTabs(),');
  return source.replace(selected.registryAnchor, registryReplacement)
    .replace(selected.scopeAnchor, selected.scopeInjection)
    + '\n/* FAST_NATIVE_WORKSPACE_TABS */\n' + rewriteExtension(extension, selected);
}
