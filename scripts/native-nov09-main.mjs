import assert from 'node:assert/strict';
export function patchNov09Metadata(source) {
  // Replacing the MCP table drops transports injected through app-server args.
  // Disable each server in place for native title/description/summary tasks.
  for (const [from, to] of [
    ['config:{mcp_servers:await async function(e,t,n,r){', 'config:{...await async function(e,t,n,r){'],
    ['Object.fromEntries(Object.keys(s.data).filter(e=>!n||"codex_apps"!==e).map(e=>[e,{enabled:!1}]))', 'Object.fromEntries(Object.keys(s.data).filter(e=>!n||"codex_apps"!==e).map(e=>["mcp_servers."+e+".enabled",!1]))'],
  ]) {
    assert.equal(source.split(from).length, 2, 'Nov 09 metadata anchor changed: ' + from);
    source = source.replace(from, () => to);
  }
  return source;
}
export function patchNov09Main(source, member) {
  function replace(from, to) {
    assert.equal(source.split(from).length, 2, 'Nov 09 main anchor changed: ' + from);
    source = source.replace(from, () => to);
  }
  if (member === '.vite/build/early-bootstrap.js') {
    replace('shouldIncludeWindowsUpdater:(e,t,n=process.env)=>d(e,t,"win32",n)&&null!=m(e)', 'shouldIncludeWindowsUpdater:()=>false');
    replace('shouldIncludeWindowsMsixUpdater:(e,t,n=process.env)=>d(e,t,"win32",n)&&m(e)?.kind==="msix"', 'shouldIncludeWindowsMsixUpdater:()=>false');
  } else {
    // Only startup defaults change. Keep the bundled plugin platform filter,
    // renderer requirements and native peer authorization intact.
    for (const [key, env] of Object.entries({ browserPane:'CODEX_FAST_IAB', inAppBrowserUse:'CODEX_FAST_IAB', inAppBrowserUseAllowed:'CODEX_FAST_IAB', externalBrowserUse:'CODEX_FORGE_EXTERNAL_BROWSER', externalBrowserUseAllowed:'CODEX_FORGE_EXTERNAL_BROWSER', computerUse:'CODEX_FORGE_COMPUTER_USE' })) {
      replace(key + ':!1', key + ':process.env.' + env + '==="1"');
    }
  }
  return source;
}
