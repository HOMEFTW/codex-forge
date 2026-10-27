'use strict';

// Forge 的组合包（bundle）——DSH 的 profile/bundle/patch 层叠的最小可移植形态。
// 只做三件事：
//   1. profile.json 按顺序列出组合包与用户 patch；
//   2. 每个组合包用 bundle.json 指向一个 patch 文件，patch 条目只能是
//      {id, enabled?, settings?}，同一层内不许重复 id；
//   3. compose 按 id 后者整段覆盖前者（last-write-wins），结果可 dump、可回滚。
// 刻意不引入 pnpm、依赖解析或 HMR：Forge 的插件就是目录，组合只描述"期望状态"。
const fs = require('node:fs'), path = require('node:path');

const maxBytes = 1024 * 1024;
const idPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]+)+$/;
const bundleIdPattern = /^[A-Za-z0-9_.-]{1,80}$/;
const check = (value, message) => { if (!value) throw Error(message); };

function readJSON(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { throw Error(`${label} 不可读（${error.code || error.message}）：${file}`); }
  check(Buffer.byteLength(text) <= maxBytes, `${label} 超过 1MB`);
  try { return JSON.parse(text); } catch (error) { throw Error(`${label} 不是合法 JSON：${error.message}`); }
}

// 所有 patch 路径都是相对路径且必须落在根目录内，避免 bundle 引用外部文件。
function safeResolve(root, relative) {
  check(typeof relative === 'string' && relative.length > 0 && relative.length < 250, '文件路径无效');
  const clean = relative.startsWith('./') ? relative.slice(2) : relative;
  check(clean && !path.isAbsolute(clean) && !clean.includes('\\') && !clean.includes(':') &&
    !clean.split('/').some(part => !part || part === '.' || part === '..'), `文件路径必须为包内相对路径：${relative}`);
  const base = fs.realpathSync(root), target = path.resolve(base, clean);
  check(target.startsWith(base + path.sep), `文件路径越出根目录：${relative}`);
  check(fs.existsSync(target), `文件不存在：${relative}`);
  return target;
}

function validateEntry(entry, source) {
  check(entry && typeof entry === 'object' && !Array.isArray(entry), `${source} 的 patch 条目必须为对象`);
  check(typeof entry.id === 'string' && idPattern.test(entry.id), `${source} 的插件 ID 无效：${String(entry?.id)}`);
  if (entry.enabled !== undefined) check(typeof entry.enabled === 'boolean', `${source} 的 ${entry.id}.enabled 必须为布尔值`);
  if (entry.settings !== undefined) {
    check(entry.settings && typeof entry.settings === 'object' && !Array.isArray(entry.settings), `${source} 的 ${entry.id}.settings 必须为对象`);
  }
  const unknown = Object.keys(entry).find(key => !['id', 'enabled', 'settings'].includes(key));
  check(!unknown, `${source} 的 ${entry.id} 有未知字段：${unknown}`);
}

function loadBundle(directory, { builtin = false } = {}) {
  const manifest = readJSON(path.join(directory, 'bundle.json'), 'bundle 清单');
  check(manifest.schemaVersion === 1, '不支持的 bundle 清单版本');
  check(typeof manifest.id === 'string' && bundleIdPattern.test(manifest.id), 'bundle ID 无效');
  check(typeof manifest.name === 'string' && manifest.name.length <= 100, 'bundle 名称无效');
  check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version), 'bundle 版本无效');
  const patchFile = manifest.patch === undefined ? null : safeResolve(directory, manifest.patch);
  const entries = patchFile ? readJSON(patchFile, 'bundle patch').entries : [];
  check(entries === undefined || Array.isArray(entries), 'bundle patch 的 entries 必须为数组');
  for (const entry of entries) validateEntry(entry, `bundle ${manifest.id}`);
  return { id: manifest.id, name: manifest.name, version: manifest.version, builtin, directory, patch: patchFile, entries };
}

function loadProfile(home) {
  const file = path.join(home, 'profile.json');
  if (!fs.existsSync(file)) return { schemaVersion: 1, bundles: [], patches: [], file: null };
  const value = readJSON(file, 'profile.json');
  check(value.schemaVersion === 1, '不支持的 profile 版本');
  const bundles = value.bundles === undefined ? [] : value.bundles;
  check(Array.isArray(bundles) && bundles.every(item => typeof item === 'string' && bundleIdPattern.test(item)), 'profile.bundles 必须是 bundle ID 数组');
  const patches = value.patches === undefined ? [] : value.patches;
  check(Array.isArray(patches) && patches.length <= 32, 'profile.patches 必须为数组');
  check(new Set(bundles).size === bundles.length, 'profile.bundles 不能重复');
  return { schemaVersion: 1, bundles, patches, file };
}

function findBundle(id, roots) {
  for (const root of roots) {
    const directory = path.join(root.path, id);
    if (fs.existsSync(path.join(directory, 'bundle.json'))) return { directory, builtin: root.builtin };
  }
  return null;
}

// 纯函数：按层顺序合并。字段级覆盖（未提及的 enabled/settings 保留上一层），
// 但 settings 对象本身是整段替换，不做深合并。
function compose(layers) {
  const merged = new Map(), sources = [];
  for (const layer of layers) {
    sources.push({ name: layer.name, kind: layer.kind, path: layer.path || null });
    const seen = new Set();
    for (const entry of layer.entries) {
      validateEntry(entry, layer.name);
      check(!seen.has(entry.id), `${layer.name} 内重复条目：${entry.id}`);
      seen.add(entry.id);
      const previous = merged.get(entry.id);
      merged.set(entry.id, {
        id: entry.id,
        enabled: entry.enabled === undefined ? previous?.enabled : entry.enabled,
        settings: entry.settings === undefined ? previous?.settings : { ...entry.settings },
        source: layer.name,
      });
    }
  }
  return { entries: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)), sources };
}

function plan({ home, projectRoot, overlay = [] }) {
  const profile = loadProfile(home);
  const roots = [{ path: path.join(home, 'bundles'), builtin: false }, { path: path.join(projectRoot, 'bundles'), builtin: true }];
  const layers = [];
  for (const id of profile.bundles) {
    const found = findBundle(id, roots);
    check(found, `找不到 bundle：${id}`);
    const bundle = loadBundle(found.directory, { builtin: found.builtin });
    layers.push({ name: `bundle:${bundle.id}`, kind: 'bundle', path: found.directory, entries: bundle.entries });
  }
  for (const relative of profile.patches) {
    const file = safeResolve(home, relative);
    const value = readJSON(file, `profile patch ${relative}`);
    check(value.schemaVersion === 1 && Array.isArray(value.entries), `profile patch 格式无效：${relative}`);
    layers.push({ name: `patch:${relative}`, kind: 'patch', path: file, entries: value.entries });
  }
  for (const item of overlay) layers.push({ name: `overlay:${item.name || 'cli'}`, kind: 'overlay', path: item.file || null, entries: item.entries });
  return { profile, ...compose(layers) };
}

// 把组合结果落到 registry：缺失插件只记录，不中断；不兼容或未知设置单独汇报。
function apply(registry, value) {
  const result = { applied: [], missing: [], skipped: [], settingsErrors: [] };
  for (const entry of value.entries) {
    if (!registry.entries.has(entry.id)) { result.missing.push(entry.id); continue; }
    const status = registry.status(entry.id);
    if (entry.enabled !== undefined && status.requestedEnabled !== entry.enabled) {
      try { registry.setEnabled(entry.id, entry.enabled); }
      catch (error) { result.skipped.push({ id: entry.id, reason: error.message }); continue; }
    }
    if (entry.settings !== undefined) {
      try {
        // 组合结果里的 settings 是覆盖项，浅合并到当前值；未提及的键保持不变。
        registry.settings(entry.id, { ...registry.settings(entry.id), ...entry.settings });
      } catch (error) { result.settingsErrors.push({ id: entry.id, reason: error.message }); continue; }
    }
    result.applied.push({ id: entry.id, enabled: entry.enabled, settings: entry.settings, source: entry.source });
  }
  return result;
}

module.exports = { readJSON, safeResolve, loadBundle, loadProfile, findBundle, compose, plan, apply };
