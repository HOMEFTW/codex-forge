'use strict';
const os = require('node:os');
const crypto = require('node:crypto');
const moment = require('moment');
const F = require('./nexus-files.cjs');
const Q = require('./nexus-query.cjs');
const { fs, path, check, hash, relative, safePath, readText, readConfig, yaml, frontmatter, scan, resolveLink, publicNote, MAX_TEXT } = F;
const EDITABLE = /\.(md|base|canvas)$/i;
const MUTATIONS = new Set(['write', 'properties', 'rename', 'trash', 'restore', 'task', 'template', 'daily', 'bookmarks_write', 'settings_write', 'table', 'outline', 'quickadd']);
const READ_METHODS = new Set(['vaults', 'snapshot', 'read', 'resolve', 'search', 'inspect', 'tags', 'graph', 'asset', 'templates', 'bookmarks', 'settings', 'history', 'query', 'quickadd_choices', 'quickadd_plan']);
function methodKind(method) { if (MUTATIONS.has(method)) return 'write'; if (READ_METHODS.has(method)) return 'read'; throw Object.assign(Error('未知 Nexus 操作：' + method), { code: 'INVALID_ARGUMENT' }); }
const COMPATIBILITY = [
  { name: 'Advanced Tables', id: 'table-editor-obsidian', supported: 'Markdown 表格渲染、对齐、添加/删除行列', unsupported: '电子表格公式与原插件快捷键' },
  { name: 'Charts', id: 'obsidian-charts', supported: 'chart YAML：bar/line/pie/doughnut/radar/polarArea/scatter；外部插件可支持用户运行的 DataviewJS renderChart 子集', unsupported: '外部文件引用、自定义 JS 回调' },
  { name: 'Homepage', id: 'homepage', supported: '读取主页配置、打开 Markdown/Base 主页、Forge 主页设置', unsupported: 'Obsidian workspace 布局与启动命令' },
  { name: 'Outliner', id: 'obsidian-outliner', supported: '列表分支缩进、反缩进、上下移动', unsupported: '原插件拖动、标题折叠、编辑器快捷键配置' },
  { name: 'Templater', id: 'templater-obsidian', supported: 'tp.file.title/path/folder、tp.date.now、tp.frontmatter 属性；核心模板日期/时间', unsupported: '执行块、用户脚本、系统命令、交互式 suggester/prompt' },
  { name: 'Dataview', id: 'dataview', supported: 'TABLE/LIST/TASK、FROM/WHERE/SORT/LIMIT、TASK GROUP BY、多行查询、常用安全表达式、行内查询；外部插件可在用户点击后隔离运行 DataviewJS 常用子集', unsupported: '服务端/MCP 执行 DataviewJS、FLATTEN、TABLE/LIST GROUP BY、自定义 DQL 函数、完整 DQL 语法' },
  { name: 'QuickAdd', id: 'quickadd', supported: '嵌套菜单、Template/Capture、DATE/VALUE/NAME、变量与目标路径', unsupported: 'Macro、脚本、AI、光标定位、复杂插入规则' },
];
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, data, { flag: 'wx' }); fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function json(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function contentValue(value) { check(typeof value === 'string' && Buffer.byteLength(value) <= MAX_TEXT, '内容必须为不超过 8 MiB 的文本'); return value; }
function editable(file) { relative(file); check(EDITABLE.test(file), '只允许编辑 .md / .base / .canvas'); }
function revision(content, expected) { check(typeof expected === 'string' && hash(content) === expected, '笔记已变化：请重新读取并合并，不能覆盖新版本', 'REVISION_CONFLICT'); }
function templateText(text, { file, variables = {}, properties = {}, now = new Date(), dateFormat = 'YYYY-MM-DD', timeFormat = 'HH:mm' } = {}) {
  const name = path.posix.basename(file, '.md'), folder = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  const format = fmt => moment(now).format(fmt);
  let result = text.replace(/<%([\s\S]*?)%>/g, (_all, source) => {
    const expr = source.trim();
    if (expr === 'tp.file.title') return name;
    if (/^tp\.file\.path\(\s*(?:true|false)?\s*\)$/.test(expr)) return file;
    if (/^tp\.file\.folder\(\s*(?:true|false)?\s*\)$/.test(expr)) return folder;
    const date = expr.match(/^tp\.date\.now\(\s*(["'])(.*?)\1(?:\s*,\s*(-?\d+))?\s*\)$/);
    if (date) return moment(now).add(Number(date[3]) || 0, 'days').format(date[2]);
    const prop = expr.match(/^tp\.frontmatter(?:\.([\p{L}\p{N}_-]+)|\[(["'])(.*?)\2\])$/u);
    if (prop) { const key = prop[1] || prop[3]; check(Object.hasOwn(properties, key), '缺少模板属性：' + key); return String(properties[key]); }
    throw Object.assign(Error('独立模式不支持此 Templater 表达式：' + expr.slice(0, 150)), { code: 'UNSUPPORTED_SYNTAX' });
  });
  result = result.replace(/\{\{([^{}]+)\}\}/g, (_all, expr) => {
    if (expr === 'title' || expr === 'NAME') return name;
    if (expr === 'date') return format(dateFormat); if (expr.startsWith('date:')) return format(expr.slice(5));
    if (expr === 'time') return format(timeFormat); if (expr.startsWith('time:')) return format(expr.slice(5));
    if (expr === 'DATE') return format(dateFormat); if (expr.startsWith('DATE:')) return format(expr.slice(5));
    const key = expr === 'VALUE' ? 'value' : expr.startsWith('VALUE:') ? expr.slice(6) : expr;
    check(Object.hasOwn(variables, key) && ['string', 'number', 'boolean'].includes(typeof variables[key]), '缺少模板变量：' + key);
    return String(variables[key]);
  });
  return result;
}
function searchPredicate(query) {
  check(typeof query === 'string' && query.length <= 2000, '搜索词无效');
  if (!query.trim()) return () => true;
  const tokens = query.match(/(?:[^\s"()]+:)?"(?:[^"\\]|\\.)*"|[()]|[^\s()]+/g) || []; let pos = 0;
  function term() {
    const t = tokens[pos++]; check(t, '搜索条件不完整');
    if (t === '(') { const p = or(); check(tokens[pos++] === ')', '搜索缺少右括号'); return p; }
    if (t === 'NOT' || t === '-') { const p = term(); return n => !p(n); }
    const negative = t.startsWith('-'), raw = negative ? t.slice(1) : t, m = raw.match(/^(tag|path|file|content):(.+)$/i);
    const value = (m ? m[2] : raw).replace(/^"|"$/g, '').toLowerCase(), kind = m?.[1].toLowerCase();
    check(value && !['AND', 'OR', ')'].includes(raw), '搜索条件无效');
    const test = n => kind === 'tag' ? n.tags.some(x => x.toLowerCase() === value.replace(/^#/, '') || x.toLowerCase().startsWith(value.replace(/^#/, '') + '/')) : kind === 'file' ? n.name.toLowerCase().includes(value) : kind === 'path' ? n.path.toLowerCase().includes(value) : kind === 'content' ? n.content.toLowerCase().includes(value) : (n.path + '\n' + n.content).toLowerCase().includes(value);
    return negative ? n => !test(n) : test;
  }
  function and() { const predicates = [term()]; while (pos < tokens.length && !['OR', ')'].includes(tokens[pos])) { if (tokens[pos] === 'AND') pos++; predicates.push(term()); } return n => predicates.every(p => p(n)); }
  function or() { const predicates = [and()]; while (tokens[pos] === 'OR') { pos++; predicates.push(and()); } return n => predicates.some(p => p(n)); }
  const fn = or(); check(pos === tokens.length, '搜索条件含多余括号'); return fn;
}
function tableEdit(content, args) {
  const lines = content.split('\n'), line = args.line; check(Number.isInteger(line) && line >= 0 && line < lines.length, '表格行号无效');
  let start = line, end = line; while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--; while (end < lines.length && /^\s*\|/.test(lines[end])) end++;
  check(end - start >= 2, '在指定行未找到管道表格');
  const cells = s => s.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim());
  const rows = lines.slice(start, end).map(cells); check(rows[1].every(c => /^:?-{3,}:?$/.test(c)), '表格缺少分隔行');
  const column = args.column ?? rows[0].length - 1, row = args.row ?? rows.length;
  if (args.action === 'add_row') { check(Number.isInteger(row) && row >= 2 && row <= rows.length, '数据行索引无效'); rows.splice(row, 0, Array.from({ length: rows[0].length }, (_, i) => String(args.values?.[i] ?? ''))); }
  else if (args.action === 'remove_row') { check(Number.isInteger(row) && row >= 2 && row < rows.length, '不能删除表头或不存在的行'); rows.splice(row, 1); }
  else if (['add_column', 'remove_column'].includes(args.action)) {
    check(Number.isInteger(column) && column >= 0 && column < rows[0].length, '列索引无效');
    check(args.action !== 'remove_column' || rows[0].length > 1, '至少保留一列');
    rows.forEach((r, i) => args.action === 'add_column' ? r.splice(column + 1, 0, i === 1 ? '---' : String(args.values?.[i] ?? '')) : r.splice(column, 1));
  } else check(args.action === 'format', '不支持的表格操作');
  check(rows.every(r => r.every(c => !/[\r\n]/.test(c))), '单元格不能包含换行');
  const count = rows[0].length, widths = Array.from({ length: count }, (_, i) => Math.max(3, ...rows.map(r => (r[i] || '').length)));
  lines.splice(start, end - start, ...rows.map((r, j) => '| ' + widths.map((w, i) => j === 1 ? ((r[i] || '').startsWith(':') ? ':' : '-') + '-'.repeat(w - 2) + ((r[i] || '').endsWith(':') ? ':' : '-') : (r[i] || '').replace(/(?<!\\)\|/g, '\\|').padEnd(w)).join(' | ') + ' |'));
  return lines.join('\n');
}
function outlineEdit(content, args) {
  const lines = content.split('\n'), at = args.line; check(Number.isInteger(at) && at >= 0 && at < lines.length, '列表行号无效');
  const indent = line => line.match(/^([ \t]*)(?:[-+*]|\d+\.)\s/)?.[1].replace(/\t/g, '    ').length;
  const level = indent(lines[at]); check(level != null, '指定行不是列表项');
  const endAt = start => { const base = indent(lines[start]); let end = start + 1; while (end < lines.length && (lines[end].trim() && (indent(lines[end]) ?? lines[end].match(/^\s*/)[0].length) > base)) end++; return end; };
  const end = endAt(at), block = lines.slice(at, end);
  if (args.action === 'indent' || args.action === 'outdent') { check(args.action !== 'outdent' || level >= 2, '该分支已经在顶层'); lines.splice(at, block.length, ...block.map(l => args.action === 'indent' ? '  ' + l : l.replace(/^(?: {1,2}|\t)/, ''))); }
  else if (args.action === 'up') { let previous = at - 1; while (previous >= 0 && (indent(lines[previous]) == null || indent(lines[previous]) > level)) previous--; check(previous >= 0 && indent(lines[previous]) === level && endAt(previous) === at, '没有可交换的上一分支'); lines.splice(previous, end - previous, ...block, ...lines.slice(previous, at)); }
  else if (args.action === 'down') { check(indent(lines[end] || '') === level, '没有可交换的下一分支'); const nextEnd = endAt(end); lines.splice(at, nextEnd - at, ...lines.slice(end, nextEnd), ...block); }
  else throw Error('不支持的大纲操作');
  return lines.join('\n');
}
class NexusService {
  constructor({ root } = {}) { this.root = path.resolve(root || path.join(os.homedir(), '.codex', 'fast-canvas', 'nexus')); this.configFile = path.join(this.root, 'vaults.json'); this.caches = new Map(); }
  config() { return json(this.configFile, { vaults: [] }); }
  vaults() { return this.config().vaults.map(v => ({ id: v.id, name: v.name, root: v.root, available: fs.existsSync(v.root) })); }
  connect(directory) {
    return this.withLock('configuration', () => this.connectDirectory(directory));
  }
  connectDirectory(directory) {
    check(typeof directory === 'string' && path.isAbsolute(directory), '知识库必须是本地绝对目录');
    const selected = path.resolve(directory), stat = fs.lstatSync(selected); check(stat.isDirectory() && !stat.isSymbolicLink(), '知识库不能是文件或目录联接');
    const root = fs.realpathSync(selected), identity = fs.statSync(root, { bigint: true });
    const config = this.config(), id = hash(root.toLowerCase()).slice(0, 24);
    const record = { id, name: path.basename(root), root, identity: `${identity.dev}:${identity.ino}`, settings: config.vaults.find(v => v.id === id)?.settings || {} };
    config.vaults = [...config.vaults.filter(v => v.id !== id), record];
    atomic(this.configFile, JSON.stringify(config, null, 2)); return { vault: this.vaults().find(v => v.id === id) };
  }
  disconnect(id) { return this.withLock('configuration', () => { const config = this.config(); config.vaults = config.vaults.filter(v => v.id !== id); atomic(this.configFile, JSON.stringify(config, null, 2)); this.caches.delete(id); return this.vaults(); }); }
  vault(id) {
    const v = this.config().vaults.find(v => v.id === id); check(v, '知识库未连接，请先在星枢面板选择目录', 'VAULT_NOT_CONNECTED');
    check(fs.existsSync(v.root) && !fs.lstatSync(v.root).isSymbolicLink(), '知识库离线或路径变为链接');
    const stat = fs.statSync(v.root, { bigint: true });
    check(v.identity === `${stat.dev}:${stat.ino}` && fs.realpathSync(v.root) === v.root, '知识库目录身份已变化，请在面板重新连接', 'PERMISSION_DENIED');
    return v;
  }
  index(v) {
    if (!this.caches.has(v.id)) this.caches.set(v.id, new Map()); const index = scan(v.root, this.caches.get(v.id));
    const byPath = new Map(index.notes.map(n => [n.path, n]));
    for (const note of index.notes) { note.links = note.links.map(l => ({ ...l, ...resolveLink(index, l.target, note.path) })); note.backlinks = []; }
    for (const note of index.notes) for (const link of note.links) { const target = byPath.get(link.path); if (target && !target.backlinks.some(b => b.path === note.path)) target.backlinks.push({ path: note.path, line: link.line }); }
    return index;
  }
  settings(v) {
    const templates = readConfig(v.root, 'templates.json') || {}, daily = readConfig(v.root, 'daily-notes.json') || {}, templater = readConfig(v.root, 'plugins/templater-obsidian/data.json') || {}, home = readConfig(v.root, 'plugins/homepage/data.json') || {};
    const homepage = Object.values(home.homepages || {}).find(h => h.kind === 'File')?.value || (typeof home.homepage === 'string' ? home.homepage : '');
    const values = { templatesFolder: templates.folder || templater.templates_folder || '', dateFormat: templates.dateFormat || 'YYYY-MM-DD', timeFormat: templates.timeFormat || 'HH:mm', dailyFolder: daily.folder || '', dailyFormat: daily.format || 'YYYY-MM-DD', dailyTemplate: daily.template || '', homepage, ...v.settings };
    return { ...values, revision: hash(JSON.stringify(values)) };
  }
  read(v, file) { editable(file); const content = readText(v.root, file); return { path: file, content, revision: hash(content), ...(file.endsWith('.md') ? F.metadata(file, content) : {}) }; }
  backup(v, file, content, kind, extra = {}) {
    const token = crypto.randomUUID(), record = { token, path: file, content, kind, at: new Date().toISOString(), ...extra };
    atomic(path.join(this.root, 'history', v.id, token + '.json'), JSON.stringify(record)); return token;
  }
  retain(v, file, expectedRevision, { config = false } = {}) {
    // Move the original inode into the vault's trash, retaining even late writes
    // through external open handles. Never unlink a user file after a mere copy.
    const source = safePath(v.root, file, { hidden: config }), retainedPath = '.trash/forge-' + crypto.randomUUID() + '/' + file;
    revision(readText(v.root, file, { hidden: config }), expectedRevision);
    const target = safePath(v.root, retainedPath, { hidden: true }); fs.mkdirSync(path.dirname(target), { recursive: true });
    this.vault(v.id); safePath(v.root, retainedPath, { hidden: true });
    fs.renameSync(source, target);
    const content = readText(v.root, retainedPath, { hidden: true });
    if (hash(content) !== expectedRevision) {
      try { fs.copyFileSync(target, safePath(v.root, file, { hidden: config }), fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      throw Error('文件在操作期间变化，已保留外部修改；恢复副本位于 ' + retainedPath);
    }
    return { retainedPath, content };
  }
  write(v, file, content, expectedRevision, { config = false, kind = 'write' } = {}) {
    if (!config) editable(file); else check(file === '.obsidian/bookmarks.json', '不支持写入此配置');
    contentValue(content); if (file.endsWith('.base')) yaml(content); if (file.endsWith('.canvas') || config) JSON.parse(content);
    const target = safePath(v.root, file, { hidden: config }), exists = fs.existsSync(target), before = exists ? readText(v.root, file, { hidden: config }) : '';
    if (exists) revision(before, expectedRevision); else check(expectedRevision === '', '文件不存在，创建需要 expectedRevision 为空字符串');
    let historyToken = null, retained;
    if (exists) {
      retained = this.retain(v, file, expectedRevision, { config });
      try { historyToken = this.backup(v, file, before, kind, { retainedPath: retained.retainedPath }); }
      catch (e) { try { fs.copyFileSync(safePath(v.root, retained.retainedPath, { hidden: true }), target, fs.constants.COPYFILE_EXCL); } catch {} throw e; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); this.vault(v.id); safePath(v.root, file, { hidden: config });
    const temp = path.join(path.dirname(target), '.forge-' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, content, { flag: 'wx' }); fs.linkSync(temp, target);
    } catch (e) {
      if (retained) { try { fs.copyFileSync(safePath(v.root, retained.retainedPath, { hidden: true }), safePath(v.root, file, { hidden: config }), fs.constants.COPYFILE_EXCL); } catch {} }
      if (e.code === 'EEXIST') throw Error('文件在保存期间已变化；外部文件与恢复副本均已保留，请重新读取');
      throw e;
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    this.caches.get(v.id)?.delete(file); return { path: file, revision: hash(content), historyToken };
  }
  lock(v, fn) { return this.withLock(v.id, fn); }
  withLock(key, fn) {
    const dir = path.join(this.root, 'locks'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, key + '.lock'); let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw Error('知识库正在被另一个 Forge 操作修改；请稍后重试。异常退出遗留锁需人工检查后移除。'); throw e; }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
  }
  dispatch(method, args = {}) {
    try { return this.dispatchChecked(method, args); }
    catch (error) {
      if (!error.code || error.code === 'INVALID_ARGUMENT') {
        if (/变化|修订/.test(error.message)) error.code = 'REVISION_CONFLICT';
        else if (method === 'query' || /不支持此|不执行|未支持/.test(error.message)) error.code = 'UNSUPPORTED_SYNTAX';
        else error.code = 'INVALID_ARGUMENT';
      }
      if (error.code === 'ENOENT') error.code = 'NOT_FOUND';
      if (error.code === 'EACCES' || error.code === 'EPERM') error.code = 'PERMISSION_DENIED';
      throw error;
    }
  }
  dispatchChecked(method, args = {}) {
    const kind = methodKind(method);
    if (method === 'vaults') return { vaults: this.vaults(), compatibility: COMPATIBILITY };
    const v = this.vault(args.vaultId);
    const execute = () => kind === 'write' ? this.lock(v, () => this.perform(this.vault(v.id), method, args)) : this.perform(v, method, args);
    return method === 'settings_write' ? this.withLock('configuration', execute) : execute();
  }
  perform(v, method, a) {
    switch (method) {
      case 'snapshot': {
        const index = this.index(v), installed = readConfig(v.root, 'community-plugins.json') || [];
        const offset = a.offset ?? 0, limit = a.limit ?? 500; check(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 1000, '分页需要非负 offset 和 1–1000 的 limit');
        const files = index.files.slice(offset, offset + limit), paths = new Set(files.map(f => f.path));
        return { vault: { id: v.id, name: v.name, root: v.root }, files, notes: index.notes.filter(n => paths.has(n.path)).map(publicNote), offset, nextOffset: offset + limit < index.files.length ? offset + limit : null, truncated: offset + limit < index.files.length, warnings: index.warnings, settings: this.settings(v), compatibility: COMPATIBILITY.map(c => ({ ...c, installed: installed.includes(c.id) })), totals: { notes: index.notes.length, files: index.files.length, words: index.notes.reduce((n, x) => n + x.stats.words, 0) } };
      }
      case 'read': return this.read(v, a.path);
      case 'resolve': return resolveLink(this.index(v), a.target, a.source || '');
      case 'search': {
        const predicate = searchPredicate(a.query || ''), notes = this.index(v).notes.filter(predicate), limit = Math.min(1000, Math.max(1, a.limit || 100));
        return { total: notes.length, truncated: notes.length > limit, results: notes.slice(0, limit).map(n => ({ ...publicNote(n), excerpt: n.content.slice(0, 400) })) };
      }
      case 'inspect': {
        const index = this.index(v), note = index.notes.find(n => n.path === a.path); check(note, '笔记不存在或未索引'); return publicNote(note);
      }
      case 'tags': { const tags = new Map(); for (const n of this.index(v).notes) for (const t of n.tags) tags.set(t, (tags.get(t) || 0) + 1); return [...tags].map(([tag, count]) => ({ tag, count })).sort((x, y) => y.count - x.count); }
      case 'graph': {
        const index = this.index(v); let notes = index.notes;
        if (a.path) { const center = notes.find(n => n.path === a.path); check(center, '中心笔记不存在'); const ids = new Set([a.path, ...center.links.map(l => l.path), ...center.backlinks.map(b => b.path)]); notes = notes.filter(n => ids.has(n.path)); }
        const total = notes.length; notes = notes.slice(0, 1500); const ids = new Set(notes.map(n => n.path));
        return { total, truncated: total > notes.length, nodes: notes.map(n => ({ id: n.path, title: n.name, tags: n.tags })), edges: notes.flatMap(n => n.links.filter(l => ids.has(l.path)).map(l => ({ source: n.path, target: l.path }))) };
      }
      case 'asset': {
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' }[path.extname(a.path || '').slice(1).toLowerCase()];
        check(mime, '附件预览支持位图、PDF、音频和视频'); const file = safePath(v.root, a.path), stat = fs.statSync(file); check(stat.isFile() && stat.size <= 20 * 1024 * 1024, '附件超过 20 MiB 预览上限'); return { mime, data: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
      }
      case 'write': {
        let text = contentValue(a.content); if (a.mode && a.mode !== 'replace') { check(['append', 'prepend'].includes(a.mode), '写入模式无效'); const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); text = a.mode === 'append' ? doc.content + text : text + doc.content; }
        return this.write(v, a.path, text, a.expectedRevision);
      }
      case 'properties': {
        check(a.path?.endsWith('.md'), '属性编辑仅支持 Markdown'); const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); const front = frontmatter(doc.content);
        check(a.values && typeof a.values === 'object' && !Array.isArray(a.values), '属性值必须是对象');
        const y = F.YAML.parseDocument(front.prefix ? front.prefix.replace(/^\uFEFF?---\r?\n/, '').replace(/\r?\n---(?:\r?\n)?$/, '') : '{}');
        for (const [key, value] of Object.entries(a.values)) { check(!['__proto__', 'constructor', 'prototype'].includes(key), '属性名无效'); y.set(key, value); }
        for (const key of a.remove || []) y.delete(key);
        return this.write(v, a.path, '---\n' + y.toString() + '---\n' + front.body, a.expectedRevision);
      }
      case 'task': {
        const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); check(typeof a.completed === 'boolean' && doc.tasks?.some(t => t.line === a.line), '任务行或完成状态无效');
        const lines = doc.content.split('\n'); lines[a.line] = lines[a.line].replace(/^(\s*(?:[-+*]|\d+\.)\s+\[)[ xX](\])/, '$1' + (a.completed ? 'x' : ' ') + '$2'); return this.write(v, a.path, lines.join('\n'), a.expectedRevision);
      }
      case 'table': case 'outline': {
        const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); return this.write(v, a.path, method === 'table' ? tableEdit(doc.content, a) : outlineEdit(doc.content, a), a.expectedRevision);
      }
      case 'rename': {
        const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); editable(a.destination); check(path.extname(a.path) === path.extname(a.destination), '重命名不能改变文件类型');
        const destination = safePath(v.root, a.destination); check(!fs.existsSync(destination), '目标文件已存在');
        const references = this.index(v).notes.filter(n => n.links.some(l => l.path === a.path)).map(n => n.path);
        const retained = this.retain(v, a.path, a.expectedRevision); let token;
        try {
          token = this.backup(v, a.path, retained.content, 'rename', { retainedPath: retained.retainedPath });
          fs.mkdirSync(path.dirname(destination), { recursive: true }); safePath(v.root, a.destination);
          fs.linkSync(safePath(v.root, retained.retainedPath, { hidden: true }), destination);
        } catch (e) {
          try { fs.copyFileSync(safePath(v.root, retained.retainedPath, { hidden: true }), safePath(v.root, a.path), fs.constants.COPYFILE_EXCL); } catch { /* Retained copy remains available. */ }
          throw e;
        }
        return { path: a.destination, revision: doc.revision, historyToken: token, referencesToUpdate: references, notice: '文件已重命名；返回的引用笔记需单独校对更新。' };
      }
      case 'trash': {
        const doc = this.read(v, a.path); revision(doc.content, a.expectedRevision); const retained = this.retain(v, a.path, a.expectedRevision);
        try { return { path: a.path, restoreToken: this.backup(v, a.path, retained.content, 'trash', { retainedPath: retained.retainedPath }) }; }
        catch (e) { try { fs.copyFileSync(safePath(v.root, retained.retainedPath, { hidden: true }), safePath(v.root, a.path), fs.constants.COPYFILE_EXCL); } catch {} throw e; }
      }
      case 'history': {
        const dir = path.join(this.root, 'history', v.id); if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => /^[0-9a-f-]+\.json$/.test(f)).map(f => json(path.join(dir, f))).filter(r => !a.path || r.path === a.path).map(({ content, ...r }) => r).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 200);
      }
      case 'restore': {
        check(typeof a.token === 'string' && /^[0-9a-f-]{36}$/.test(a.token), '历史凭据无效'); const record = json(path.join(this.root, 'history', v.id, a.token + '.json')); check(record, '历史记录不存在');
        const content = record.retainedPath && record.kind === 'trash' ? readText(v.root, record.retainedPath, { hidden: true }) : record.content;
        return this.write(v, record.path, content, a.expectedRevision, { config: record.path === '.obsidian/bookmarks.json', kind: 'restore' });
      }
      case 'templates': {
        const settings = this.settings(v), folders = [...new Set([settings.templatesFolder, (readConfig(v.root, 'plugins/templater-obsidian/data.json') || {}).templates_folder].filter(Boolean))];
        return this.index(v).files.filter(f => f.ext === 'md' && folders.some(folder => f.path.startsWith(folder + '/')));
      }
      case 'template': {
        const template = this.read(v, a.template), current = a.expectedRevision ? this.read(v, a.path) : null;
        const content = templateText(template.content, { ...this.settings(v), file: a.path, variables: a.variables, properties: current?.properties });
        return this.write(v, a.path, a.append && current ? current.content + '\n' + content : content, a.expectedRevision);
      }
      case 'daily': {
        const settings = this.settings(v), date = a.date ? moment(a.date, 'YYYY-MM-DD', true) : moment(); check(date.isValid(), '日记日期格式为 YYYY-MM-DD');
        const file = [settings.dailyFolder, date.format(settings.dailyFormat) + '.md'].filter(Boolean).join('/');
        if (fs.existsSync(safePath(v.root, file))) { const doc = this.read(v, file); if (a.expectedRevision && a.expectedRevision !== doc.revision) throw Error('日记已变化，请重新读取'); return doc; }
        check(a.expectedRevision === '', '创建日记需要 expectedRevision 为空字符串');
        const index = this.index(v), template = settings.dailyTemplate ? resolveLink(index, settings.dailyTemplate).path : null;
        check(!settings.dailyTemplate || template, '日记模板未找到');
        const content = template ? templateText(this.read(v, template).content, { ...settings, file, now: date.toDate(), variables: a.variables }) : '# ' + date.format('YYYY-MM-DD') + '\n';
        return { ...this.write(v, file, content, ''), content };
      }
      case 'bookmarks': {
        const file = '.obsidian/bookmarks.json'; let content;
        try { content = readText(v.root, file, { hidden: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        return { items: content ? JSON.parse(content).items || [] : [], revision: content == null ? '' : hash(content) };
      }
      case 'bookmarks_write': {
        check(Array.isArray(a.items) && a.items.length <= 1000, '书签需要数组，最多 1000 项');
        let count = 0; const validate = (items, depth = 0) => { check(depth < 12, '书签嵌套过深'); for (const item of items) { check(++count <= 2000 && item && typeof item === 'object' && typeof item.type === 'string', '书签格式无效'); if (item.type === 'group') { check(Array.isArray(item.items), '书签分组需要 items'); validate(item.items, depth + 1); } if (item.type === 'file') relative(item.path); } }; validate(a.items);
        const old = readConfig(v.root, 'bookmarks.json') || {};
        return this.write(v, '.obsidian/bookmarks.json', JSON.stringify({ ...old, items: a.items }, null, 2), a.expectedRevision, { config: true });
      }
      case 'settings': return this.settings(v);
      case 'settings_write': {
        check(a.expectedRevision === this.settings(v).revision, '知识库设置已变化，请重新读取设置');
        const allowed = new Set(['templatesFolder', 'dateFormat', 'timeFormat', 'dailyFolder', 'dailyFormat', 'dailyTemplate', 'homepage']);
        check(a.values && typeof a.values === 'object' && Object.entries(a.values).every(([k, val]) => allowed.has(k) && typeof val === 'string' && val.length <= 1000), '知识库设置无效');
        for (const key of ['templatesFolder', 'dailyFolder', 'dailyTemplate', 'homepage']) if (a.values[key]) relative(a.values[key]);
        const config = this.config(), record = config.vaults.find(x => x.id === v.id); record.settings = { ...record.settings, ...a.values }; atomic(this.configFile, JSON.stringify(config, null, 2)); return this.settings(record);
      }
      case 'query': {
        const index = this.index(v);
        if (a.language === 'base') { const doc = a.path ? this.read(v, a.path) : { content: a.query }; return Q.bases(doc.content, index.notes, a.view, index.notes.find(n => n.path === a.source)); }
        if (a.language === 'expression') { const note = index.notes.find(n => n.path === a.source); check(note, '行内查询需要来源笔记'); const ctx = Q.context(note); return { value: Q.expression(a.query)({ ...ctx, this: ctx }) }; }
        check(!a.language || a.language === 'dataview', '仅支持 dataview/base/expression'); return Q.dataview(a.query, index.notes, index.notes.find(n => n.path === a.source));
      }
      case 'quickadd_choices': return this.choices(v);
      case 'quickadd_plan': return this.quickadd(v, a, true);
      case 'quickadd': return this.quickadd(v, a);
      default: throw Error('未知 Obsidian 操作：' + method);
    }
  }
  choices(v) {
    const result = [], visit = (choices, parents = []) => { for (const choice of choices || []) { if (choice.type === 'Multi') visit(choice.choices, [...parents, choice.name]); else result.push({ ...choice, label: [...parents, choice.name].join(' / '), supported: ['Template', 'Capture'].includes(choice.type) }); } };
    visit((readConfig(v.root, 'plugins/quickadd/data.json') || {}).choices); return result;
  }
  quickadd(v, a, planOnly = false) {
    const choice = this.choices(v).find(c => c.id === a.choiceId); check(choice, 'QuickAdd 项目不存在'); check(choice.supported, '独立模式不执行 QuickAdd Macro/脚本');
    check(!choice.appendLink && !choice.copyLinkToClipboard, '暂不支持 QuickAdd 附加链接/剪贴板副作用');
    const vars = a.variables || {}, settings = this.settings(v), render = (text, file = a.path || '新笔记.md') => templateText(text, { ...settings, file, variables: vars });
    const write = (file, content, expectedRevision) => {
      if (!planOnly) return this.write(v, file, content, expectedRevision);
      editable(file); const exists = fs.existsSync(safePath(v.root, file));
      return { path: file, content, expectedRevision: exists ? this.read(v, file).revision : '', exists };
    };
    if (choice.type === 'Template') {
      const template = this.read(v, choice.templatePath); let file = a.path;
      if (!file) {
        check(!choice.folder?.chooseWhenCreatingNote && !choice.folder?.createInSameFolderAsActiveFile && !choice.folder?.chooseFromSubfolders, '此 QuickAdd 需要明确提供目标 path');
        const folder = choice.folder?.enabled ? choice.folder.folders?.[0] || '' : '';
        check(choice.fileNameFormat?.enabled, '此 QuickAdd 需要明确提供目标 path');
        file = [folder, render(choice.fileNameFormat.format) + '.md'].filter(Boolean).join('/');
      }
      return write(file, render(template.content, file), a.expectedRevision);
    }
    check(!choice.captureToActiveFile && !choice.captureToCanvasNodeId && !choice.insertAfter?.enabled && !choice.insertBefore?.enabled && (!choice.templater?.afterCapture || choice.templater.afterCapture === 'none'), '此 Capture 使用了尚未支持的光标/插入规则/Templater，请改用明确的笔记写入操作');
    const file = a.path || render(choice.captureTo), exists = fs.existsSync(safePath(v.root, file));
    check(exists || choice.createFileIfItDoesntExist?.enabled, 'Capture 目标不存在且配置不允许创建');
    let before = exists ? this.read(v, file).content : '';
    if (!exists && choice.createFileIfItDoesntExist?.createWithTemplate) before = render(this.read(v, choice.createFileIfItDoesntExist.template).content, file);
    const capture = (choice.task ? '- [ ] ' : '') + render(choice.format?.enabled ? choice.format.format : '{{VALUE}}', file);
    const after = choice.prepend ? capture + '\n' + before : before + (before && !before.endsWith('\n') ? '\n' : '') + capture + '\n';
    return write(file, after, a.expectedRevision);
  }
}
module.exports = { NexusService, MUTATIONS, READ_METHODS, methodKind, COMPATIBILITY, templateText, searchPredicate, tableEdit, outlineEdit };
