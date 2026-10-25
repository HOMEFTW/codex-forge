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

function rewriteExtension(extension, symbols) {
  if (symbols === legacyNativeSymbols) return extension;
  const replacements = [
    ['E(tb)', symbols.routeScope], ['Z(cb)', symbols.fullWidthRead],
    ['QL', symbols.registryMap], ['ZL', symbols.register], ['aR', symbols.controller],
    ['nb', symbols.routeUnavailable], ['cb', symbols.fullWidth], ['kCi', symbols.react],
    ['fB', symbols.openPanel], ['vY', symbols.layout],
  ];
  let result = extension;
  for (const [from, to] of replacements) result = result.replaceAll(from, to);
  // Retained-route matching is optional; the current renderer removed these
  // private signals, so avoid carrying unresolved identifiers into its scope.
  result = result.replaceAll("typeof By !== 'undefined' && scope.get(By) === threadId", 'false');
  result = result.replaceAll("typeof HE === 'undefined' ? null : scope.get(HE)", 'null');
  result = result.replaceAll('Ol(value.clientThreadId) === threadId', 'value.clientThreadId.replace(/^client:/, ``) === threadId');
  return result;
}

export function patchNativeTabs(source, extension, { version = 'legacy', symbols } = {}) {
  const selected = symbols || (version === 'current' ? currentNativeSymbols : legacyNativeSymbols);
  for (const anchor of [selected.registryAnchor, selected.scopeAnchor]) {
    assert.equal(source.split(anchor).length, 2, 'Native workspace anchor changed: ' + anchor);
  }
  assert(extension.includes('function fastWorkspaceRegisterTabs('));
  assert(extension.includes('function fastWorkspaceRememberScope('));
  const registryReplacement = selected === currentNativeSymbols
    ? 'Ksi=[`left`,`right`],mH=new Map,fastWorkspaceRegisterTabs(),qsi='
    : 'FSi=[`left`,`right`],QL=new Map,fastWorkspaceRegisterTabs(),ISi=';
  return source.replace(selected.registryAnchor, registryReplacement)
    .replace(selected.scopeAnchor, selected.scopeInjection)
    + '\n/* FAST_NATIVE_WORKSPACE_TABS */\n' + rewriteExtension(extension, selected);
}
