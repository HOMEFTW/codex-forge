import assert from 'node:assert/strict';
import { patchOct27Network } from './native-fast-patch.mjs';

export function patchNov25Network(source, host = false) {
  const name = host ? 'X' : 'er', config = host ? 'B' : 'j', args = host ? 'U' : 'D';
  const original = 'function ' + name + '(){let e=' + config + '.flatMap(({configKey:e,envVar:t})=>{let r=process.env[t]?.trim();return null==r||""===r?[]:["-c",`${e}=${JSON.stringify(r)}`]});return 0===e.length?[...' + args + ',"app-server","--analytics-default-enabled"]:["app-server",...' + args + ',...e,"--analytics-default-enabled"]}';
  assert.equal(source.split(original).length, 2, 'Nov 25 backend arguments changed');
  const canonical = original.replace('function '+name+'()', 'function Z()').replace('e='+config+'.flatMap', 'e=R.flatMap').replaceAll('...'+args+',', '...A,');
  const patched = patchOct27Network(canonical, {version:'nov09'}).replace('function Z()', 'function '+name+'()').replace('e=R.flatMap', 'e='+config+'.flatMap').replaceAll('...A,', '...'+args+',');
  return source.replace(original, () => patched);
}
