import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { patchSettingsPage, patchSettingsVisibility } from './native-settings-patch.mjs';
import { patchNativeTabs } from './native-tabs-patch.mjs';
import { patchFastAccess, patchModelCatalogArgs } from './native-fast-patch.mjs';
const root = path.resolve(import.meta.dirname, '..');
const config=JSON.parse(fs.readFileSync(path.join(root,'forge.config.json'),'utf8'));
const adapter=JSON.parse(fs.readFileSync(path.join(root,'adapters',config.codexVersion+'.json'),'utf8'));
const sourceArg=process.argv[2]||process.env.CODEX_FORGE_SOURCE;
assert(sourceArg,'Provide the verified official app directory');
const source = path.resolve(sourceArg);
const target = path.resolve(process.argv[3] || path.join(root, 'release', 'package-full'));
// patchSet 由适配器显式声明，避免用某个符号字面量推断客户端代际。旧适配器没有
// 该字段时才回退到符号判断。members 必须由适配器提供：静默回退到 legacy 文件名
// 会把旧补丁套到新客户端上。
const nativeVersion = adapter.patchSet || (adapter.nativeSymbols?.registryMap === 'QL' ? 'legacy' : 'current');
assert(['legacy', 'current'].includes(nativeVersion), `适配器 patchSet 无效：${nativeVersion}`);
const currentAdapter = nativeVersion === 'current';
const members = adapter.members;
assert(members && ['renderer', 'settingsPage', 'visibleSettings', 'network'].every(key => typeof members[key] === 'string' && members[key]), '适配器必须声明 members.renderer/settingsPage/visibleSettings/network');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const payloadManifest = JSON.parse(fs.readFileSync(path.join(root, 'forge-payload.json'), 'utf8'));
const payloadFiles = payloadManifest.files || [];
const forgePayloadSHA256 = payloadManifest.payloadDigest || hash(payloadFiles.map(file => `${file.path}\0${file.bytes}\0${file.sha256}`).sort().join('\n'));
assert.match(forgePayloadSHA256, /^[a-f0-9]{64}$/);
fs.mkdirSync(target, { recursive: true });
if (!fs.existsSync(path.join(target, 'app', 'resources', 'app.asar'))) fs.cpSync(source, path.join(target,'app'), { recursive: true });
const base = fs.readFileSync(path.join(source, 'resources', 'app.asar'));
assert.equal(hash(base), adapter.baseASARSHA256);
const oldHeaderSize = base.readUInt32LE(4), oldJsonSize = base.readUInt32LE(12);
const oldJSON = base.subarray(16, 16 + oldJsonSize), header = JSON.parse(oldJSON.toString());
const all = [];
function walk(directory, prefix = '') {
  for (const [name, entry] of Object.entries(directory.files || {})) {
    const member = prefix + name;
    if (entry.files) walk(entry, member + '/');
    else if (!entry.unpacked && !entry.link) all.push({ member, entry, offset: Number(entry.offset) });
  }
}
walk(header); all.sort((a, b) => a.offset - b.offset);
const modifications = [], payloads = [];
let position = 0;
for (const { member, entry, offset } of all) {
  const original = base.subarray(8 + oldHeaderSize + offset, 8 + oldHeaderSize + offset + entry.size);
  let changed = original;
  if(!process.env.FAST_NO_PATCH && member === 'webview/index.html'){
    const anchor='frame-src &#39;self&#39;';assert.equal(original.toString().split(anchor).length,2);changed=Buffer.from(original.toString().replace(anchor,anchor+' codex-forge:'));
  } else if (!process.env.FAST_NO_PATCH && member === '.vite/build/early-bootstrap.js') {
    const guard = (process.env.FAST_EXTENSION_DEBUG ? 'require("node:fs").writeFileSync(require("node:path").join(process.env.CODEX_HOME,"early-reached.txt"),"reached");try{' : '') + 'require(require("node:path").join(process.resourcesPath,"fast-extension/main.cjs")).install();' + (process.env.FAST_EXTENSION_DEBUG ? '}catch(error){require("node:fs").writeFileSync(require("node:path").join(process.env.CODEX_HOME,"extension-error.txt"),error.stack);throw error}' : '') + '\n';
    changed = Buffer.from(guard + original.toString());
  } else if (!process.env.FAST_NO_PATCH && member === '.vite/build/preload.js') {
    const version = hash(fs.readFileSync(path.join(root, 'dist/fast-extension/ui/app.js'))).slice(0, 16);
    const preload = fs.readFileSync(path.join(root,'runtime','forge-preload.cjs'),'utf8')+'\n'+fs.readFileSync(path.join(root, 'runtime', 'host-preload.cjs'), 'utf8').replaceAll('__FAST_UI_VERSION__', version) + '\n' + fs.readFileSync(path.join(root, 'runtime', 'host-workspace.cjs'), 'utf8');
    changed = Buffer.concat([original, Buffer.from('\n' + preload)]);
  } else if (!process.env.FAST_NO_PATCH && member === members.renderer) {
    let renderer=original.toString();
    if (!currentAdapter) {
      const labelAnchor='function oPl(e,t=!1,n=!1){';assert.equal(renderer.split(labelAnchor).length,2);
      renderer=renderer.replace(labelAnchor,labelAnchor+'if(e===`codex-forge`)return {id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`};');
    }
    renderer=patchFastAccess(renderer,{version:nativeVersion});
    changed = Buffer.from(patchNativeTabs(renderer, fs.readFileSync(path.join(root, 'runtime/native-tabs-renderer.js'), 'utf8'), {version:nativeVersion}));
  } else if(!process.env.FAST_NO_PATCH && member===members.settingsPage) {
    changed=Buffer.from(patchSettingsPage(original.toString(),{version:nativeVersion}));
  } else if(!process.env.FAST_NO_PATCH && member===members.visibleSettings) {
    changed=Buffer.from(patchSettingsVisibility(original.toString(),{version:nativeVersion}));
  } else if (!process.env.FAST_NO_PATCH && member === members.network) {
    const sourceText = original.toString(), start = sourceText.indexOf(`function ${currentAdapter ? 'Oc' : 'rc'}(`), end = sourceText.indexOf(`function ${currentAdapter ? 'kc' : 'ic'}(`, start);
    assert(start >= 0 && end > start);
    const replacement = currentAdapter
      ? 'function Oc(){let e=tc.flatMap(({configKey:e,envVar:t})=>{let n=process.env[t]?.trim();return n==null||n===``?[]:[`-c`,`${e}=${JSON.stringify(n)}`]}),t=process.env;if(t.CODEX_FORGE_FAST===`1`)e.push(`-c`,`features.fast_mode=true`);if(t.CODEX_FORGE_FAST===`1`&&t.CODEX_FORGE_SPEED===`fast`)e.push(`-c`,`service_tier="fast"`);if(t.CODEX_FAST_IAB===`1`)e.push(`-c`,`desktop.conversationDetailMode="STEPS_COMMANDS"`);if(t.CODEX_FAST_CANVAS===`1`){let n=process.resourcesPath.replace(/\\\\/g,`/`);e.push(`-c`,`mcp_servers.fast_canvas.command=`+JSON.stringify(n+`/cua_node/bin/node.exe`),`-c`,`mcp_servers.fast_canvas.args=`+JSON.stringify([n+`/fast-extension/mcp.cjs`]),`-c`,`mcp_servers.fast_canvas.enabled=true`,`-c`,`mcp_servers.fast_canvas.startup_timeout_sec=25`);if(t.CODEX_FORGE_HOME)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FORGE_HOME=`+JSON.stringify(t.CODEX_FORGE_HOME));if(t.CODEX_FAST_CANVAS_DIR)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FAST_CANVAS_DIR=`+JSON.stringify(t.CODEX_FAST_CANVAS_DIR))}return e.length===0?[...ec,`app-server`,`--analytics-default-enabled`]:[`app-server`,...ec,...e,`--analytics-default-enabled`]}'
      : 'function rc(){let e=[...Os,`app-server`,`--analytics-default-enabled`],t=process.env;for(let n of ks){let r=t[n.envVar]?.trim();r&&e.push(`-c`,n.configKey+`=`+JSON.stringify(r))}if(t.CODEX_FORGE_FAST===`1`)e.push(`-c`,`features.fast_mode=true`);if(t.CODEX_FORGE_FAST===`1`&&t.CODEX_FORGE_SPEED===`fast`)e.push(`-c`,`service_tier="fast"`);if(t.CODEX_FAST_IAB===`1`)e.push(`-c`,`desktop.conversationDetailMode="STEPS_COMMANDS"`);if(t.CODEX_FAST_CANVAS===`1`){let r=process.resourcesPath.replace(/\\\\/g,`/`);e.push(`-c`,`mcp_servers.fast_canvas.command=`+JSON.stringify(r+`/cua_node/bin/node.exe`),`-c`,`mcp_servers.fast_canvas.args=`+JSON.stringify([r+`/fast-extension/mcp.cjs`]),`-c`,`mcp_servers.fast_canvas.enabled=true`,`-c`,`mcp_servers.fast_canvas.startup_timeout_sec=25`);if(t.CODEX_FORGE_HOME)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FORGE_HOME=`+JSON.stringify(t.CODEX_FORGE_HOME));if(t.CODEX_FAST_CANVAS_DIR)e.push(`-c`,`mcp_servers.fast_canvas.env.CODEX_FAST_CANVAS_DIR=`+JSON.stringify(t.CODEX_FAST_CANVAS_DIR))}return e}';
    const withCatalog = patchModelCatalogArgs(replacement);
    changed = Buffer.from(sourceText.slice(0, start) + withCatalog + sourceText.slice(end));
  }
  if (!changed.equals(original)) {
    assert(entry.integrity?.algorithm === 'SHA256');
    const blockSize = entry.integrity.blockSize;
    entry.integrity.hash = hash(changed); entry.integrity.blocks = [];
    for (let block = 0; block < changed.length; block += blockSize) entry.integrity.blocks.push(hash(changed.subarray(block, block + blockSize)));
    modifications.push({ member, beforeSHA256: hash(original), afterSHA256: hash(changed), sizeBefore: original.length, sizeAfter: changed.length });
  }
  entry.size = changed.length; entry.offset = String(position); position += changed.length; payloads.push(changed);
}
assert.equal(modifications.length, process.env.FAST_NO_PATCH ? 0 : 7);
if (!process.env.FAST_NO_PATCH) {
  header.files.webview.files['fast-canvas'] = { files: {} };
  for (const name of fs.readdirSync(path.join(root, 'dist', 'fast-extension', 'ui'))) {
    const bytes = fs.readFileSync(path.join(root, 'dist', 'fast-extension', 'ui', name));
    const integrity = { algorithm: 'SHA256', hash: hash(bytes), blockSize: 4194304, blocks: [] };
    for (let block = 0; block < bytes.length; block += integrity.blockSize) integrity.blocks.push(hash(bytes.subarray(block, block + integrity.blockSize)));
    header.files.webview.files['fast-canvas'].files[name] = { size: bytes.length, offset: String(position), integrity };
    payloads.push(bytes); position += bytes.length;
    modifications.push({ member: 'webview/fast-canvas/' + name, added: true, afterSHA256: hash(bytes), sizeAfter: bytes.length });
  }
}
const json = Buffer.from(JSON.stringify(header)), padded = Math.ceil(json.length / 4) * 4;
const prefix = Buffer.alloc(16 + padded);
prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + padded, 4); prefix.writeUInt32LE(4 + padded, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
const fd = fs.openSync(path.join(target, 'app', 'resources', 'app.asar'), 'w');
const digest = crypto.createHash('sha256');
for (const buffer of [prefix, ...payloads]) { fs.writeSync(fd, buffer); digest.update(buffer); }
fs.closeSync(fd);
const exe = fs.readFileSync(path.join(source, 'ChatGPT.exe'));
assert.equal(hash(exe), adapter.baseExecutableSHA256);
const oldHash = hash(oldJSON), newHash = hash(json), at = exe.indexOf(Buffer.from(oldHash));
assert(at >= 0 && exe.indexOf(Buffer.from(oldHash), at + 1) < 0);
Buffer.from(newHash).copy(exe, at); fs.writeFileSync(path.join(target, 'app', 'ChatGPT.exe'), exe);
// Replace the extension directory instead of merging into it, so files removed
// from runtime/ (for example the retired apply-update.ps1) cannot survive in a
// rebuilt client.
const extensionTarget = path.join(target, 'app', 'resources', 'fast-extension');
fs.rmSync(extensionTarget, { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist', 'fast-extension'), extensionTarget, { recursive: true });
fs.copyFileSync(path.join(root,'scripts','Launch-Codex-Forge.ps1'),path.join(target,'Launch-Codex-Forge.ps1'));
fs.copyFileSync(path.join(root,'dist','CodexForge.exe'),path.join(target,'CodexForge.exe'));
fs.copyFileSync(path.join(root,'dist','CodexForge.exe.config'),path.join(target,'CodexForge.exe.config'));
fs.copyFileSync(path.join(root,'assets','codex-forge.ico'),path.join(target,'codex-forge.ico'));
const oldCmd=path.join(target,'Start-Codex-Forge.cmd');if(fs.existsSync(oldCmd))fs.unlinkSync(oldCmd);
const manifest = { product: 'Codex Forge', forgeVersion: config.version, apiVersion:config.apiVersion, fullInstallation:true, forgePayloadSHA256, sourceMSIXVersion: config.codexVersion, sourceBuildVersion: config.codexBuildVersion || adapter.codexBuildVersion || config.codexVersion, baseASARSHA256: hash(base), asarSHA256: digest.digest('hex'), headerSHA256: newHash, executableSHA256: hash(exe), executableIntegrityOffset: at, integrityChecksEnabled: true, fusesChanged: false, modifications };
const files=[];function inventory(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())inventory(file);else if(file!==path.join(target,'forge-install.json'))files.push({path:path.relative(target,file).replaceAll('\\','/'),bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});}}inventory(target);manifest.files=files;
fs.writeFileSync(path.join(target,'forge-install.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({...manifest,files:manifest.files.length}, null, 2));
