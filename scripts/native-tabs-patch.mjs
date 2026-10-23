import assert from 'node:assert/strict';

// These anchors belong to the verified 26.1016.8622.0 renderer. Fail closed
// when the upstream registry or workspace component changes.
export const registryAnchor = 'FSi=[`left`,`right`],QL=new Map,ISi=';
export const scopeAnchor = 'workspaceWidth:u}=e,d=E(tb),f=Wc(),p,m;';
export function patchNativeTabs(source, extension) {
  for (const anchor of [registryAnchor, scopeAnchor]) {
    assert.equal(source.split(anchor).length, 2, 'Native workspace anchor changed: ' + anchor);
  }
  assert(extension.includes('function fastWorkspaceRegisterTabs('));
  assert(extension.includes('function fastWorkspaceRememberScope('));
  return source.replace(registryAnchor, 'FSi=[`left`,`right`],QL=new Map,fastWorkspaceRegisterTabs(),ISi=')
    .replace(scopeAnchor, 'workspaceWidth:u}=e,d=E(tb),f=(fastWorkspaceRememberScope(d),Wc()),p,m;')
    + '\n/* FAST_NATIVE_WORKSPACE_TABS */\n' + extension;
}
