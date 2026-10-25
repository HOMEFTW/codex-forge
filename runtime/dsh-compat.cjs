'use strict';

// Read-only bridge for DSH bundle packages. Forge remains the UI/permission
// host; DSH remains responsible for installing, composing and running its
// Cordis plugins. Keeping this boundary read-only avoids copying a second
// package manager or evaluating cordis.patch.yml inside the Forge process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { satisfies } = require('./forge-versions.cjs');

const check = (value, message) => { if (!value) throw Error(message); };
const profileName = value => {
  const name = value || 'acp';
  check(typeof name === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(name), 'DSH profile 名称无效');
  return name;
};
function inside(root, relative) {
  check(typeof relative === 'string' && relative.length < 250 && !relative.includes('\\') && !relative.includes(':'), 'DSH 资源路径无效');
  const clean = relative.replace(/^\.\//, '');
  check(clean && !clean.split('/').some(part => !part || part === '.' || part === '..'), 'DSH 资源路径无效');
  const base = fs.realpathSync(root), target = path.resolve(base, clean);
  check(target.startsWith(base + path.sep), 'DSH 资源越出包目录');
  return target;
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function packageRoot(root, packageName) {
  const target = path.resolve(root, 'node_modules', ...packageName.split('/'));
  try {
    const base = fs.realpathSync(root), resolved = fs.realpathSync(target);
    if (!resolved.startsWith(base + path.sep) || !fs.statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch { return null; }
}
function packagePeers(manifest) {
  return Object.fromEntries(Object.entries(manifest.peerDependencies || {})
    .filter(([name, range]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name) && typeof range === 'string')
    .map(([name, range]) => [name, range]));
}
function inspectDshBundle(directory) {
  const root = fs.realpathSync(directory), manifestPath = path.join(root, 'package.json'), manifest = readJSON(manifestPath);
  check(typeof manifest.name === 'string' && manifest.name && typeof manifest.version === 'string', 'DSH 包清单缺少 name/version');
  const bundle = manifest.dsh?.bundle;
  check(bundle && typeof bundle === 'object' && typeof bundle.patch === 'string', '不是可桥接的 DSH bundle（缺少 dsh.bundle.patch）');
  const patch = inside(root, bundle.patch), bytes = fs.readFileSync(patch);
  check(fs.statSync(patch).isFile(), 'DSH bundle patch 不是文件');
  return {
    kind: 'dsh-bundle', name: manifest.name, version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    root, patch: path.relative(root, patch).replaceAll(path.sep, '/'), patchBytes: bytes.length,
    patchSha256: crypto.createHash('sha256').update(bytes).digest('hex'), peers: packagePeers(manifest),
    optional: manifest.dsh?.bundle?.optional === true,
  };
}
function compatibility(info, { runtimeVersion } = {}) {
  const reasons = [], runtime = runtimeVersion || '';
  if (!runtime) reasons.push('未提供 DSH 运行时版本，无法确认 peerDependencies');
  else for (const [name, range] of Object.entries(info.peers || {})) {
    try { if (!satisfies(runtime, range)) reasons.push(`${name} ${runtime} 不满足 ${range}`); }
    catch { reasons.push(`${name} 的兼容范围无效：${range}`); }
  }
  return { compatible: reasons.length === 0, reasons, runtimeVersion: runtime || null };
}
class DshCompatibilityLayer {
  constructor({ home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), runtimeVersion = '' } = {}) {
    this.home = path.resolve(home); this.runtimeVersion = runtimeVersion;
  }
  inspect(directory) { return inspectDshBundle(directory); }
  profile(profile = 'acp') {
    const name = profileName(profile), root = path.join(this.home, 'profiles', name), file = path.join(root, 'package.json');
    if (!fs.existsSync(file)) return { profile: name, available: false, bundles: [], reason: 'DSH profile 未找到' };
    let manifest;
    try { manifest = readJSON(file); } catch (error) { return { profile: name, available: false, bundles: [], reason: 'DSH profile 清单无效：' + error.message }; }
    const selected = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    const bundles = selected.map(nameValue => {
      if (typeof nameValue !== 'string' || !/^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(nameValue)) return { name: String(nameValue), available: false, reason: 'bundle 名称无效' };
      const directory = packageRoot(root, nameValue);
      if (!directory) return { name: nameValue, available: false, reason: 'bundle 未安装' };
      try { const info = this.inspect(directory); return { ...info, available: true, compatibility: compatibility(info, { runtimeVersion: this.runtimeVersion }) }; }
      catch (error) { return { name: nameValue, available: false, reason: error.message }; }
    });
    return { profile: name, available: true, root, bundles };
  }
  snapshot(profile = 'acp') {
    const value = this.profile(profile);
    return { available: value.available, home: this.home, profile: value.profile, runtimeVersion: this.runtimeVersion || null, bundles: value.bundles, readOnly: true, manager: 'native-dsh-plugin-manager' };
  }
}

module.exports = { DshCompatibilityLayer, inspectDshBundle, compatibility, profileName };
