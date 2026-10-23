'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { validate, validateSettings, safeFile, compatibility, check } = require('./forge-manifest.cjs');
const { satisfies } = require('./forge-versions.cjs');
const { atomic, json } = require('./collaboration-store.cjs');
function fingerprint(root) {
  const hash = crypto.createHash('sha256');
  const walk = directory => { for (const name of fs.readdirSync(directory).sort()) { const file=path.join(directory,name), stat=fs.lstatSync(file); check(!stat.isSymbolicLink(), '插件不能包含链接'); if(stat.isDirectory()) walk(file); else { check(stat.isFile(), '插件文件无效'); hash.update(path.relative(root,file)); hash.update(fs.readFileSync(file)); } } };
  walk(root); return hash.digest('hex');
}
class ForgeRegistry {
  constructor({ root, bundledRoot = path.join(__dirname, 'plugins'), versions }) {
    this.root = root; this.bundledRoot = bundledRoot; this.versions = versions; this.entries = new Map(); this.errors = [];
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true }); fs.mkdirSync(path.join(root, 'storage'), { recursive: true });
    this.stateFile = path.join(root, 'plugins.json'); this.reload();
  }
  state() { return json(this.stateFile, { schemaVersion: 1, plugins: {} }); }
  reload() {
    this.entries.clear(); this.errors = [];
    for (const [directory, builtin] of [[this.bundledRoot, true], [path.join(this.root, 'plugins'), false]]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        const root = path.join(directory, name);
        try {
          if (fs.lstatSync(root).isSymbolicLink()) throw Error('插件目录不能是链接');
          if (!fs.statSync(root).isDirectory()) continue;
          const manifest = validate(json(safeFile(root, 'plugin.json')), root, { builtin });
          check(!this.entries.has(manifest.id), '重复插件 ID');
          this.entries.set(manifest.id, { manifest, root, builtin, fingerprint: fingerprint(root) });
        } catch (error) { this.errors.push({ directory: name, message: error.message }); }
      }
    }
    return this.list();
  }
  status(id, visiting = new Set()) {
    const entry = this.entries.get(id); if (!entry) return { enabled: false, requestedEnabled: false, reasons: ['插件不存在'] };
    const { manifest: m, builtin } = entry, saved = this.state().plugins[id];
    const requestedEnabled = saved?.enabled ?? builtin;
    const reasons = [...compatibility(m, this.versions).reasons];
    if (!builtin && saved?.fingerprint !== entry.fingerprint) reasons.push('插件清单已变化或尚未启用，请审阅权限后启用');
    if (visiting.has(id)) return { enabled: false, requestedEnabled, reasons: ['循环依赖：'+id] };
    const next = new Set([...visiting, id]);
    for (const [dependency, version] of Object.entries(m.dependencies || {})) {
      const target = this.entries.get(dependency);
      if (!target || !satisfies(target.manifest.version, version)) reasons.push('缺少兼容依赖：'+dependency);
      else if (!this.status(dependency, next).enabled) reasons.push('依赖未启用：'+dependency);
    }
    return { enabled: requestedEnabled && reasons.length === 0, requestedEnabled, reasons };
  }
  list() { return { versions: this.versions, plugins: [...this.entries.values()].map(e => ({ ...e.manifest, builtin: e.builtin, fingerprint: e.fingerprint, ...this.status(e.manifest.id) })), errors: this.errors }; }
  get(id, active = true) { const e = this.entries.get(id); check(e, '插件不存在'); if (active) check(this.status(id).enabled, '插件未启用或不兼容'); return e; }
  setEnabled(id, enabled) {
    check(typeof enabled === 'boolean', '启用值无效'); const entry = this.get(id, false), state = this.state();
    if (enabled) { const match = compatibility(entry.manifest, this.versions); check(match.compatible, match.reasons.join('；')); }
    state.plugins[id] = { ...state.plugins[id], enabled, fingerprint: entry.fingerprint }; atomic(this.stateFile, state);
    return this.list();
  }
  settings(id, value) {
    const entry = this.get(id, false), file = path.join(this.root, 'storage', id + '.settings.json');
    if (value !== undefined) atomic(file, validateSettings(entry.manifest, value));
    return validateSettings(entry.manifest, json(file, {}));
  }
  permission(id, name) { const e = this.get(id); check(e.manifest.permissions.includes(name), '插件未声明权限：'+name); return e; }
  storage(id, op, key, value) {
    this.permission(id, 'storage'); check(typeof key === 'string' && /^[\w.-]{1,100}$/.test(key) && !['__proto__','constructor','prototype'].includes(key), '存储键无效');
    const file = path.join(this.root, 'storage', id + '.json'), data = json(file, {});
    if (op === 'get') return Object.hasOwn(data, key) ? data[key] : null;
    if (op === 'delete') delete data[key]; else { check(op === 'set' && Buffer.byteLength(JSON.stringify(value ?? null)) <= 65536, '存储值超过64KB'); data[key] = value; }
    check(Buffer.byteLength(JSON.stringify(data)) <= 1048576, '插件存储超过1MB'); atomic(file, data); return true;
  }
  source(id, relative) { return fs.readFileSync(safeFile(this.get(id).root, relative), 'utf8'); }
  install(directory) {
    const source = fs.realpathSync(directory), manifest = validate(json(safeFile(source, 'plugin.json')), source);
    const match = compatibility(manifest, this.versions); check(match.compatible, match.reasons.join('；'));
    const destination = path.join(this.root, 'plugins', manifest.id); check(!fs.existsSync(destination), '插件已存在；先卸载再安装');
    const staging = path.join(this.root, 'plugins', '.install-' + crypto.randomUUID());
    let bytes = 0, count = 0;
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        const file = path.join(from, name), stat = fs.lstatSync(file); check(!stat.isSymbolicLink(), '插件不能包含目录链接');
        if (stat.isDirectory()) { check(!['node_modules','.git'].includes(name), '插件不能包含 node_modules 或 .git'); copy(file, path.join(to, name)); }
        else { check(stat.isFile() && ++count <= 1000 && (bytes += stat.size) <= 20*1024*1024, '插件超过1000文件或20MB'); fs.copyFileSync(file, path.join(to, name)); }
      }
    };
    try { copy(source, staging); fs.renameSync(staging, destination); } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
    this.reload(); return { id: manifest.id, enabled: false, permissions: manifest.permissions };
  }
  uninstall(id) {
    const e = this.get(id, false); check(!e.builtin, '内置插件只能停用'); this.setEnabled(id, false);
    const destination = path.join(this.root, 'plugins', id); check(path.resolve(e.root) === path.resolve(destination), '插件目录不匹配');
    const queueFile=path.join(this.root,'pending-updates.json'),queue=json(queueFile,{});delete queue[id];atomic(queueFile,queue);const pending=path.join(this.root,'pending',id);if(fs.existsSync(pending))fs.rmSync(pending,{recursive:true,force:true});
    fs.rmSync(destination, { recursive: true }); this.reload(); return { removed: id, settingsPreserved: true };
  }
}
module.exports = { ForgeRegistry, fingerprint };
