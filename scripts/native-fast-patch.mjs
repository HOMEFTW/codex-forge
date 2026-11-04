import assert from 'node:assert/strict';

const adapters = {
  legacy: {
    original: 'function _Lo(e){let t=(0,vLo.c)(10),n=Z(vk),r=e?.hostId??n,i=OT(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=Nc(xC,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?fCe(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}',
    replacement: 'function _Lo(e){let t=(0,vLo.c)(8),n=Z(vk),r=e?.hostId??n,i=OT(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=Nc(xC,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?fCe(c):b&&o===`apikey`?{...fCe(c??{}),ultrafast:!1}:null,isLoading:u})}'
  },
  current: {
    original: 'function Jlo(e){let t=(0,Ylo.c)(10),n=Ua(Dj),r=e?.hostId??n,i=VO(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ns(mD,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?tn(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}',
    replacement: 'function Jlo(e){let t=(0,Ylo.c)(8),n=Ua(Dj),r=e?.hostId??n,i=VO(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=ns(mD,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?tn(c):b&&o===`apikey`?{...tn(c??{}),ultrafast:!1}:null,isLoading:u})}'
  },
  oct23: {
    original: 'function Moo(e){let t=(0,Noo.c)(10),n=xr(Nj),r=e?.hostId??n,i=zO(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=An(lO,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?Pue(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}',
    replacement: 'function Moo(e){let t=(0,Noo.c)(8),n=xr(Nj),r=e?.hostId??n,i=zO(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=An(lO,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?Pue(c):b&&o===`apikey`?{...Pue(c??{}),ultrafast:!1}:null,isLoading:u})}'
  },
  oct27: {
    original: 'function VAo(e){let t=(0,HAo.c)(10),n=uo(bD),r=e?.hostId??n,i=Ik(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=_s(TO,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?Wt(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}',
    replacement: 'function VAo(e){let t=(0,HAo.c)(8),n=uo(bD),r=e?.hostId??n,i=Ik(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=_s(TO,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?Wt(c):b&&o===`apikey`?{...Wt(c??{}),ultrafast:!1}:null,isLoading:u})}'
  },
  oct27b: {
    original: 'function JAo(e){let t=(0,YAo.c)(10),n=ao(BD),r=e?.hostId??n,i=qk(r),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=fs(BO,s),u=!!i?.isLoading||a&&l,d;t[3]!==c||t[4]!==u||t[5]!==a?(d=a&&!u&&c!=null?Wt(c):null,t[3]=c,t[4]=u,t[5]=a,t[6]=d):d=t[6];let f=d,p;return t[7]!==u||t[8]!==f?(p={serviceTierAccess:f,isLoading:u},t[7]=u,t[8]=f,t[9]=p):p=t[9],p}',
    replacement: 'function JAo(e){let t=(0,YAo.c)(8),n=ao(BD),r=e?.hostId??n,i=qk(r),b=globalThis.__codexForgeStartup?.fastEnabled===!0,o=i?.authMethod??(b&&i?.requiresAuth===!1?`apikey`:null),a=o===`chatgpt`||o===`personalAccessToken`||o===`amazonBedrock`,s=t[0]===r&&t[1]===o?t[2]:(t[0]=r,t[1]=o,t[2]={authMethod:o,hostId:r});let{data:c,isPending:l}=fs(BO,s),u=!!i?.isLoading||a&&l;return t[3]===c&&t[4]===u&&t[5]===o&&t[6]===b?t[7]:(t[3]=c,t[4]=u,t[5]=o,t[6]=b,t[7]={serviceTierAccess:u?null:a&&c!=null?Wt(c):b&&o===`apikey`?{...Wt(c??{}),ultrafast:!1}:null,isLoading:u})}'
  }
};

// Fail closed when upstream minification changes. Add a new adapter instead of
// applying a stale Fast policy to an unverified client.
export function patchFastAccess(source, { version = 'legacy' } = {}) {
  const adapter = adapters[version] || adapters.legacy;
  assert.equal(source.split(adapter.original).length, 2, `Fast adapter does not match the official client (${version})`);
  return source.replace(adapter.original, adapter.replacement);
}

export function patchModelCatalogArgs(source) {
  const anchor = 'return e';
  assert.equal(source.split(anchor).length, 2, 'Model catalog adapter requires exactly one argument return');
  return source.replace(anchor, 'if(t.CODEX_FORGE_MODEL_CATALOG)e.push(`-c`,`model_catalog_json=`+JSON.stringify(t.CODEX_FORGE_MODEL_CATALOG));return e');
}

export function patchOct27Network(source) {
  const original = 'function Q(){let e=R.flatMap(({configKey:e,envVar:t})=>{let r=process.env[t]?.trim();return null==r||""===r?[]:["-c",`${e}=${JSON.stringify(r)}`]});return 0===e.length?[...A,"app-server","--analytics-default-enabled"]:["app-server",...A,...e,"--analytics-default-enabled"]}';
  assert.equal(source.split(original).length, 2, 'Oct 27 native backend arguments changed');
  const injected = 'let t=process.env;if(t.CODEX_FORGE_FAST===`1`)e.push(`-c`,`features.fast_mode=true`);if(t.CODEX_FORGE_FAST===`1`&&t.CODEX_FORGE_SPEED===`fast`)e.push(`-c`,`service_tier="fast"`);if(t.CODEX_FAST_IAB===`1`)e.push(`-c`,`desktop.conversationDetailMode="STEPS_COMMANDS"`);if(t.CODEX_FAST_CANVAS===`1`){let n=process.resourcesPath;e.push(`-c`,`mcp_servers.fast_canvas.command=`+JSON.stringify(n+`/cua_node/bin/node.exe`),`-c`,`mcp_servers.fast_canvas.args=`+JSON.stringify([n+`/fast-extension/mcp.cjs`]),`-c`,`mcp_servers.fast_canvas.enabled=true`,`-c`,`mcp_servers.fast_canvas.startup_timeout_sec=25`);if(t.CODEX_FORGE_HOME)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FORGE_HOME=`+JSON.stringify(t.CODEX_FORGE_HOME));if(t.CODEX_FAST_CANVAS_DIR)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FAST_CANVAS_DIR=`+JSON.stringify(t.CODEX_FAST_CANVAS_DIR))}if(t.CODEX_FORGE_MODEL_CATALOG)e.push(`-c`,`model_catalog_json=`+JSON.stringify(t.CODEX_FORGE_MODEL_CATALOG));';
  return source.replace(original, original.replace('return 0===e.length', injected + 'return 0===e.length'));
}
