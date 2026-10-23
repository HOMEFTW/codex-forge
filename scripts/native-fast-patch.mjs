import assert from 'node:assert/strict';

// Exact adapter for 26.1016.8622.0. Keep the native rules for signed-in accounts
// and managed requirements; only add ordinary Fast for API-key/no-login hosts.
export function patchFastAccess(source) {
  const original = 'function _Lo(e){let t=(0,vLo.c)(10),n=Z(vk),r=e?.hostId??n,i=OT(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=Nc(xC,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?fCe(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}';
  assert.equal(source.split(original).length, 2, 'Fast adapter does not match the official client');
  const replacement = 'function _Lo(e){let t=(0,vLo.c)(8),n=Z(vk),r=e?.hostId??n,i=OT(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=Nc(xC,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?fCe(c):b&&o===`apikey`?{...fCe(c??{}),ultrafast:!1}:null,isLoading:u})}';
  return source.replace(original, replacement);
}
