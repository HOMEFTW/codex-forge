import assert from 'node:assert/strict';
import { patchOct27Network } from './native-fast-patch.mjs';

export function patchNov23Network(source, host = false) {
  const name = host ? 'X' : 'er', config = host ? 'U' : 'j', args = host ? 'B' : 'D';
  const original = 'function ' + name + '(){let e=' + config + '.flatMap(({configKey:e,envVar:t})=>{let r=process.env[t]?.trim();return null==r||""===r?[]:["-c",`${e}=${JSON.stringify(r)}`]});return 0===e.length?[...' + args + ',"app-server","--analytics-default-enabled"]:["app-server",...' + args + ',...e,"--analytics-default-enabled"]}';
  assert.equal(source.split(original).length, 2, 'Nov 23 backend arguments changed');
  const canonical = original.replace('function '+name+'()', 'function Z()').replace('e='+config+'.flatMap', 'e=R.flatMap').replaceAll('...'+args+',', '...A,');
  const patched = patchOct27Network(canonical, {version:'nov09'}).replace('function Z()', 'function '+name+'()').replace('e=R.flatMap', 'e='+config+'.flatMap').replaceAll('...A,', '...'+args+',');
  return source.replace(original, () => patched);
}

export function patchNov23Metadata(source) {
  for (const [from, to] of [
    ['config:{mcp_servers:await async function(e,t,r,n){', 'config:{...await async function(e,t,r,n){'],
    ['Object.fromEntries(Object.keys(o.data).filter(e=>!r||"codex_apps"!==e).map(e=>[e,{enabled:!1}]))', 'Object.fromEntries(Object.keys(o.data).filter(e=>!r||"codex_apps"!==e).map(e=>["mcp_servers."+e+".enabled",!1]))'],
  ]) {
    assert.equal(source.split(from).length, 2, 'Nov 23 metadata anchor changed: ' + from);
    source = source.replace(from, () => to);
  }
  return source;
}
