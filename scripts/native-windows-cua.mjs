import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
export const globalsPath = 'resources/cua_node/bin/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/globals.js';
export function patchCuaGlobals(source) {
  const anchor = 'Object.assign(n,{initialize:n.getState}),Reflect.set(globalThis,"cua",n);';
  assert.equal(source.split(anchor).length, 2, 'Windows CUA globals changed');
  return 'import{installWindowsApps}from"./forge_windows_apps.js";' + source.replace(anchor, 'Object.assign(n,{initialize:n.getState});installWindowsApps(n);Reflect.set(globalThis,"cua",n);');
}
export function installCua(source, target, runtime, expectedHash) {
  const destination = path.join(target, globalsPath);
  const original = fs.readFileSync(path.join(source, globalsPath));
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), expectedHash, 'Windows CUA source digest changed');
  fs.writeFileSync(destination, patchCuaGlobals(original.toString('utf8')));
  fs.copyFileSync(path.join(runtime, 'windows-cua.mjs'), path.join(path.dirname(destination), 'forge_windows_apps.js'));
}
