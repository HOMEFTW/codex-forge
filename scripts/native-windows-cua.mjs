import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
export const globalsPath = 'resources/cua_node/bin/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/globals.js';
export function patchCuaGlobals(source) {
  const matches = [...source.matchAll(/Object\.assign\(([\w$]+),\{initialize:\1\.getState\}\),Reflect\.set\(globalThis,"cua",\1\);/g)];
  assert.equal(matches.length, 1, 'Windows CUA globals changed');
  const [anchor, name] = matches[0];
  return 'import{installWindowsApps}from"./forge_windows_apps.js";' + source.replace(anchor, `Object.assign(${name},{initialize:${name}.getState});installWindowsApps(${name});Reflect.set(globalThis,"cua",${name});`);
}
export function installCua(source, target, runtime, expectedHash) {
  const destination = path.join(target, globalsPath);
  const original = fs.readFileSync(path.join(source, globalsPath));
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), expectedHash, 'Windows CUA source digest changed');
  fs.writeFileSync(destination, patchCuaGlobals(original.toString('utf8')));
  fs.copyFileSync(path.join(runtime, 'windows-cua.mjs'), path.join(path.dirname(destination), 'forge_windows_apps.js'));
}
