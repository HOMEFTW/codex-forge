'use strict';
// DSH browser clients run in Forge panels. No external DSH profile or server is used.
const fs = require('node:fs'), path = require('node:path');
const { check, safeFile } = require('./forge-manifest.cjs');
const { atomic, json } = require('./collaboration-store.cjs');
const { inspectDshClient, idForPackage, packageName, download, verifyIntegrity, unpackNpm } = require('./dsh-package.cjs');
const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const emptyPreferences = () => ({ notes: {}, favorites: [], blocked: [], updateExempt: [], groups: {}, groupOrder: [] });
class DshCompatibilityLayer {
  constructor({ registry, fetchImpl = globalThis.fetch } = {}) {
    check(registry, 'DSH UI 兼容层需要 Forge 插件宿主');
    this.registry = registry; this.fetchImpl = fetchImpl; this.catalog = null; this.catalogAt = 0; this.busy = false;
    this.importsFile = path.join(registry.root, 'dsh-imports.json');
    this.preferencesFile = path.join(registry.root, 'dsh-market.json');
  }
  records() { return json(this.importsFile, {}); }
  entries() {
    return Object.entries(this.records()).flatMap(([id, record]) => {
      const entry = this.registry.entries.get(id);
      return entry?.manifest.dshClient?.packageName === record.name && entry.fingerprint === record.fingerprint ? [{ id, record, entry, status: this.registry.status(id) }] : [];
    });
  }
  snapshot() {
    return { available: true, manager: 'codex-forge', mode: 'browser-ui', externalRuntime: false, plugins: this.entries().map(({ id, record, status }) => ({ id, name: record.name, version: record.version, enabled: status.enabled, market: record.market, reasons: status.reasons })) };
  }
  importDirectory(directory, { market = false } = {}) {
    const info = inspectDshClient(directory), id = idForPackage(info.name);
    check(!market || info.name === 'dshmarket', '市场管理入口仅用于导入 dshmarket');
    check(!this.registry.entries.has(id), 'DSH 插件已存在；请先卸载再导入');
    const stagingRoot = path.join(this.registry.root, 'dsh-staging'); fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = fs.mkdtempSync(path.join(stagingRoot, 'import-'));
    try {
      fs.mkdirSync(path.join(staging, 'client'));
      fs.copyFileSync(safeFile(info.root, info.entry), path.join(staging, 'client', 'client.js'));
      if (info.css) fs.copyFileSync(safeFile(info.root, info.css), path.join(staging, 'client', 'client.css'));
      for (const name of fs.readdirSync(info.root).filter(name => /^licen[cs]e(?:\.|$)/i.test(name))) fs.copyFileSync(safeFile(info.root, name), path.join(staging, name));
      fs.writeFileSync(path.join(staging, 'ui.html'), '<!doctype html><html><head></head><body><p class="forge-dsh-notice">此页面运行于 Codex Forge。导入后请在 Forge 插件管理中审阅权限并启用；浏览器插件无需重启。依赖 DSH 服务端的功能暂不支持。</p><div id="forge-dsh-root"></div><div id="forge-dsh-status" role="status"></div></body></html>');
      const manifest = { schemaVersion: 1, apiVersion: this.registry.versions.apiVersion, id, name: info.name.slice(0, 100), version: info.version, description: info.description,
        compatibility: { codex: [this.registry.versions.codex], forge: [this.registry.versions.forge] },
        permissions: ['panels', 'sidebar', 'storage', 'dsh', ...(market ? ['dsh.manage', 'network'] : [])], ...(market ? { networkOrigins: ['https://avatars.githubusercontent.com', 'https://raw.githubusercontent.com', 'https://awesome-dsh-plugin.com'] } : {}),
        dshClient: { packageName: info.name, entry: 'client/client.js', ...(info.css ? { css: 'client/client.css' } : {}) },
        contributes: { panels: [{ id: 'ui', title: info.name.slice(0, 100), entry: 'ui.html', placement: 'right' }], sidebar: [{ id: 'ui', title: info.name.slice(0, 100), panel: 'ui' }] } };
      fs.writeFileSync(path.join(staging, 'plugin.json'), JSON.stringify(manifest, null, 2));
      const result = this.registry.install(staging);
      this.registry.setEnabled(id, false);
      const entry = this.registry.get(id, false), records = this.records();
      // Import provenance is host-owned. A manifest named dshmarket alone cannot manage plugins.
      records[id] = { name: info.name, version: info.version, fingerprint: entry.fingerprint, market, importedAt: new Date().toISOString() };
      atomic(this.importsFile, records);
      return { ...result, packageName: info.name, browserOnly: true };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  preferences() { return { ...emptyPreferences(), ...json(this.preferencesFile, {}) }; }
  savePreferences(value) { check(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, '市场偏好超过128KB'); atomic(this.preferencesFile, value); }
  installed() {
    const installed = {}, activation = {}, disabled = [];
    for (const { record, status } of this.entries()) {
      installed[record.name] = record.version;
      if (!status.enabled) disabled.push(record.name);
      activation[record.name] = { state: status.enabled ? 'live' : 'disabled', bundle: true, hot: true,
        reasons: status.enabled ? ['Forge 浏览器 UI 已启用；从插件管理或左栏打开页面。DSH 服务端入口不会运行。'] : [...status.reasons, '请在 Forge 插件管理中审阅权限并启用。'] };
    }
    return { installed, present: Object.keys(installed), profile: 'codex-forge', disabled, bundles: Object.keys(installed), activation, live: this.entries().filter(item => item.status.enabled).map(item => item.record.name), ...this.preferences() };
  }
  authorize(id, manager = false) {
    const entry = this.registry.permission(id, 'dsh'), record = this.records()[id];
    check(record && entry.fingerprint === record.fingerprint && entry.manifest.dshClient?.packageName === record.name, '仅支持由 Forge 导入并审阅的 DSH 浏览器插件');
    if (manager) { this.registry.permission(id, 'dsh.manage'); check(record.market === true, '此导入未授予 DSH 插件管理权限；请使用 Forge 的“导入 DSH 市场”入口'); }
    return record;
  }
  async registryCatalog(force = false) {
    if (!force && this.catalog && Date.now() - this.catalogAt < 300000) return this.catalog;
    const bytes = await download(REGISTRY_URL, { fetchImpl: this.fetchImpl, maxBytes: 8 * 1024 * 1024, hostname: 'awesome-dsh-plugin.com' });
    const value = JSON.parse(bytes.toString('utf8'));
    check(Array.isArray(value.plugins) && value.plugins.length <= 10000, 'DSH 市场目录格式无效');
    this.catalog = { ...value, count: value.plugins.length, plugins: value.plugins.map(item => ({ ...item, install: undefined })) };
    this.catalogAt = Date.now(); return this.catalog;
  }
  async installNpm(name, version = 'latest', options = {}) {
    packageName(name); check(typeof version === 'string' && /^(?:latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.test(version), '不支持此 npm 版本');
    check(!this.busy, '已有 DSH 插件导入正在进行'); this.busy = true;
    let staging;
    try {
      const metadata = JSON.parse((await download('https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + version, { fetchImpl: this.fetchImpl, maxBytes: 2 * 1024 * 1024, hostname: 'registry.npmjs.org' })).toString('utf8'));
      check(metadata.name === name && metadata.dist?.tarball, 'npm 发布包身份不匹配');
      const bytes = await download(metadata.dist.tarball, { fetchImpl: this.fetchImpl, hostname: 'registry.npmjs.org' }); verifyIntegrity(bytes, metadata.dist.integrity);
      const parent = path.join(this.registry.root, 'dsh-staging'); fs.mkdirSync(parent, { recursive: true }); staging = fs.mkdtempSync(path.join(parent, 'npm-'));
      unpackNpm(bytes, staging);
      const pkg = JSON.parse(fs.readFileSync(safeFile(staging, 'package.json'), 'utf8'));
      check(pkg.name === name && pkg.version === metadata.version, 'npm 包内容身份不匹配');
      return this.importDirectory(staging, options);
    } finally { this.busy = false; if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
  }
  find(name) { const found = this.entries().find(item => item.record.name === name); check(found, '此 DSH 插件未导入 Forge'); return found; }
  reviewed(id) {
    const records = this.records(), entry = this.registry.get(id, false);
    if (records[id] && this.registry.status(id).enabled && entry.fingerprint === records[id].fingerprint) {
      records[id].reviewedFingerprint = entry.fingerprint; atomic(this.importsFile, records);
    }
  }
  toggle(name, enabled) {
    const { id, entry } = this.find(name); check(typeof enabled === 'boolean', '启用状态无效');
    if (enabled) check(this.records()[id]?.reviewedFingerprint === entry.fingerprint, '请先在 Forge 插件管理中审阅权限并启用此插件，再使用市场开关。');
    this.registry.setEnabled(id, enabled); return { ok: true, hot: true, ...this.installed() };
  }
  forget(id) { const records = this.records(); if (Object.hasOwn(records, id)) { delete records[id]; atomic(this.importsFile, records); } }
  uninstall(name) {
    const { id } = this.find(name); this.registry.uninstall(id); this.forget(id);
    return { ok: true, hot: true, ...this.installed() };
  }
  async request(id, endpoint, { method = 'GET', body = {} } = {}) {
    try {
      check(typeof endpoint === 'string' && endpoint.length <= 500, 'DSH 请求路径无效');
      const url = new URL(endpoint, 'https://forge.invalid/'); check(url.origin === 'https://forge.invalid', 'DSH 请求路径无效');
      const route = url.pathname.slice(1); this.authorize(id, route !== 'open-plugin');
      check(['GET', 'POST'].includes(method) && body && typeof body === 'object' && !Array.isArray(body) && Buffer.byteLength(JSON.stringify(body)) <= 65536, 'DSH 请求无效');
      const ok = value => ({ status: 200, body: value });
      if (method === 'GET') {
        if (route === 'installed') return ok(this.installed());
        if (route === 'registry') return ok({ registry: await this.registryCatalog(url.searchParams.has('force')), hostVersion: null });
        if (route === 'status') return ok({ version: this.records()[id].version, selfManaged: false, active: this.busy, busy: this.busy, installed: this.installed().installed, packageManager: 'codex-forge', browserOnly: true, boot: 'forge-browser-ui', restart: null, restartReachable: false, runningAgents: [] });
        if (route === 'updates') return { status: 501, body: { error: 'Forge 暂不支持 DSH 包的原位更新；可卸载后重新导入。' } };
        if (route === 'sidebar-entry') return ok({ enabled: true, chosen: true });
      } else {
        if (route === 'open-plugin') { const { id: target } = this.find(body.name); this.registry.get(target); return ok({ openPlugin: { id: target, view: 'ui' } }); }
        if (route === 'discovery-compatibility') {
          check(Array.isArray(body.packages) && body.packages.length <= 64 && body.packages.every(name => typeof name === 'string' && name.length <= 214), '兼容检查列表无效');
          return ok({ hostVersion: null, plugins: Object.fromEntries(body.packages.map(name => [name, { status: 'unknown', basis: 'unavailable', requirement: null, declarations: [] }])) });
        }
        if (route === 'install') {
          const catalog = await this.registryCatalog(), plugin = catalog.plugins.find(p => p.url === body.url);
          check(plugin, '仅支持公开市场目录中的插件'); check(typeof plugin.npm === 'string' && plugin.npm, '此插件没有 npm 浏览器发布包，请从本地目录导入');
          check(!this.preferences().blocked.includes(plugin.npm), '此插件已被屏蔽');
          const result = await this.installNpm(plugin.npm, body.version || 'latest');
          return ok({ ok: true, hot: true, ...this.installed(), message: '已导入 ' + result.packageName + '；请在 Forge 插件管理中审阅权限并启用，无需重启。' });
        }
        if (route === 'toggle') return ok(this.toggle(body.name, body.enabled));
        if (route === 'uninstall') return ok(this.uninstall(body.name));
        const preferences = this.preferences();
        if (route === 'note') {
          packageName(body.name); check(typeof body.text === 'string' && body.text.length <= 4000, '备注过长'); preferences.notes[body.name] = body.text;
        } else if (['favorite', 'block', 'update-exempt'].includes(route)) {
          const key = { favorite: 'favorites', block: 'blocked', 'update-exempt': 'updateExempt' }[route], value = route === 'favorite' ? body.url : packageName(body.name), flag = body[route === 'favorite' ? 'favorited' : route === 'block' ? 'blocked' : 'exempt'];
          check(typeof value === 'string' && value.length <= 2000 && typeof flag === 'boolean', '市场偏好无效');
          preferences[key] = [...new Set(flag ? [...preferences[key], value] : preferences[key].filter(item => item !== value))];
        } else if (route === 'groups') {
          const name = body.name; check(typeof name === 'string' && name.trim() && name.length <= 80 && !['__proto__', 'constructor', 'prototype'].includes(name), '分组名无效');
          const groups = preferences.groups, exists = Object.hasOwn(groups, name);
          if (body.action === 'create') { check(!exists, '分组已存在'); groups[name] = []; preferences.groupOrder.push(name); }
          else {
            check(exists, '分组不存在');
            if (body.action === 'delete') { delete groups[name]; preferences.groupOrder = preferences.groupOrder.filter(item => item !== name); }
            else if (body.action === 'rename') { const next = body.newName; check(typeof next === 'string' && next.trim() && next.length <= 80 && !Object.hasOwn(groups, next) && !['__proto__', 'constructor', 'prototype'].includes(next), '新分组名无效'); groups[next] = groups[name]; delete groups[name]; preferences.groupOrder = preferences.groupOrder.map(item => item === name ? next : item); }
            else if (body.action === 'set-members') { check(Array.isArray(body.members) && body.members.length <= 200, '分组成员无效'); groups[name] = [...new Set(body.members.map(packageName))]; }
            else if (body.action === 'toggle') { const members = groups[name].map(member => this.find(member)); if (body.enabled) for (const item of members) check(this.records()[item.id]?.reviewedFingerprint === item.entry.fingerprint, '请先在 Forge 插件管理中审阅分组成员权限'); for (const item of members) this.toggle(item.record.name, body.enabled); }
            else return { status: 501, body: { error: 'Forge 尚不支持此 DSH 分组操作' } };
          }
        } else return { status: 501, body: { error: 'Forge 浏览器 UI 兼容层尚不支持 DSH 服务端操作：' + route } };
        this.savePreferences(preferences); return ok({ ok: true, ...this.installed() });
      }
      return { status: 501, body: { error: 'Forge 浏览器 UI 兼容层尚不支持 DSH 服务端操作：' + route } };
    } catch (error) { return { status: 400, body: { error: error.message } }; }
  }
}
module.exports = { DshCompatibilityLayer, inspectDshClient, idForPackage };
