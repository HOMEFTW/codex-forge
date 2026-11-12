import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

export function patchNativePredictionPolicy(original, patched, spec) {
  assert.equal(createHash('sha256').update(original).digest('hex'), spec.sha256, 'Native prediction policy module changed');
  const anchor = 'this.disposables.add(this.cumberbatchController)';
  assert.equal(original.split(anchor).length, 2, 'Native prediction controller anchor changed');
  assert.equal(patched.split(anchor).length, 2, 'Native prediction controller anchor duplicated');
  const setting = spec.settingSymbol || 'NF', host = spec.hostSymbol || 'sy';
  assert([setting, host].every(value => /^[A-Za-z_$][\w$]*$/.test(value)), 'Invalid native policy symbol');
  assert(original.includes('key:"composer-predictions-enabled"') && original.includes('this.settings.getEffective(' + setting + '.key)'), 'Native prediction setting contract changed');
  return patched.replace(anchor, anchor + ',this.disposables.add(require(require("node:path").join(process.resourcesPath,"fast-extension/main.cjs")).attachNativePredictionPolicy({settings:e.settingsStore,connections:this.appServerConnectionRegistry,hostId:' + host + '.n}))');
}
