'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const CATEGORY_LABELS = Object.freeze({
  core: '核心记忆',
  notes: '自定义备注',
  summaries: '系统摘要',
  history: '历史摘要',
  skills: '技能说明',
});
const VALID_CATEGORIES = new Set(['all', ...Object.keys(CATEGORY_LABELS)]);
const ROOT_DOCUMENTS = new Map([
  ['memory.md', 'core'],
  ['memory_summary.md', 'summaries'],
  ['raw_memories.md', 'summaries'],
]);
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ITEMS = 10000;
const MAX_DEPTH = 10;
const MAX_PREVIEW_LENGTH = 180;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isLink(stat) {
  return stat.isSymbolicLink();
}

function normalizeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    fail('记忆路径无效');
  }
  const pieces = value.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.includes(':'))) {
    fail('记忆路径无效');
  }
  return pieces.join('/');
}

function categoryFor(relative) {
  const normalized = relative.toLowerCase();
  const rootCategory = ROOT_DOCUMENTS.get(normalized);
  if (rootCategory) return rootCategory;
  if (normalized.startsWith('extensions/ad_hoc/notes/') && normalized.endsWith('.md')) return 'notes';
  if (normalized.startsWith('rollout_summaries/') && normalized.endsWith('.md')) return 'history';
  if (normalized.startsWith('skills/') && normalized.endsWith('.md')) return 'skills';
  return null;
}

function isEditable(relative, category) {
  return relative.toLowerCase() === 'memory.md' || category === 'notes';
}

function isDeletable(relative, category) {
  return category === 'notes' && relative.toLowerCase().startsWith('extensions/ad_hoc/notes/');
}

function cleanPreview(content) {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW_LENGTH);
}

function validateContent(content) {
  if (typeof content !== 'string') fail('记忆内容必须是文本');
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) fail('记忆文件超过 8 MiB 上限');
  return content;
}

function ensureRegularFile(root, relative, { allowMissing = false } = {}) {
  const parts = normalizeRelative(relative).split('/');
  let current = path.resolve(root);
  let rootStat;
  try {
    rootStat = fs.lstatSync(current);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') fail('记忆文件不存在');
    throw error;
  }
  if (isLink(rootStat)) fail('记忆目录不能是符号链接');
  if (!rootStat.isDirectory()) fail('记忆目录无效');

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT' && index === parts.length - 1) return null;
      if (error.code === 'ENOENT') fail('记忆文件不存在');
      throw error;
    }
    if (isLink(stat)) fail('记忆路径包含符号链接');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('记忆路径无效');
    if (index === parts.length - 1 && !stat.isFile()) fail('记忆文件不是普通文件');
  }
  return { file: current, stat: fs.lstatSync(current) };
}

function readUtf8(root, relative, { preview = false } = {}) {
  const result = ensureRegularFile(root, relative);
  if (result.stat.size > MAX_DOCUMENT_BYTES) fail('记忆文件超过 8 MiB 上限');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(result.file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_DOCUMENT_BYTES) fail('记忆文件无效或超过大小上限');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    const content = bytes.subarray(0, offset).toString('utf8');
    return preview ? { content, stat: result.stat } : { content, hash: sha256(bytes.subarray(0, offset)), stat: result.stat };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (isLink(stat) || !stat.isDirectory()) fail('记忆目录包含不安全路径');
}

function ensureNoteDirectory(root) {
  const resolved = path.resolve(root);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const rootStat = fs.lstatSync(resolved);
  if (isLink(rootStat) || !rootStat.isDirectory()) fail('记忆目录包含不安全路径');
  let parent = resolved;
  for (const part of ['extensions', 'ad_hoc', 'notes']) {
    parent = path.join(parent, part);
    ensureDirectory(parent);
  }
  return parent;
}

function atomicWrite(file, content, mode) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function validateName(value) {
  if (typeof value !== 'string') fail('标题无效，请使用 1 至 64 个字符');
  const name = value.trim().replace(/\.md$/i, '');
  if (!name || name.length > 64 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || RESERVED_WINDOWS_NAME.test(name)) {
    fail('标题无效，请使用 1 至 64 个普通字符');
  }
  return name;
}

class CodexMemory {
  constructor({ root, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
    if (root) {
      const resolved = path.resolve(root);
      this.roots = [{ prefix: '', path: resolved, label: path.basename(resolved) || 'memories' }];
    } else {
      const home = path.resolve(codexHome);
      this.roots = ['memories', 'memories_v2'].map(name => ({ prefix: `${name}/`, path: path.join(home, name), label: name }));
    }
    this.noteRoot = this.roots.find(item => item.label === 'memories_v2') || this.roots[0];
    this.cache = new Map();
  }

  rootForId(id) {
    if (typeof id !== 'string' || !id || id.includes('\0') || id.includes('\\')) fail('记忆路径无效');
    const root = this.roots.find(item => item.prefix ? id.startsWith(item.prefix) : this.roots.length === 1);
    if (!root) fail('记忆路径不属于可管理范围');
    const relative = normalizeRelative(root.prefix ? id.slice(root.prefix.length) : id);
    const category = categoryFor(relative);
    if (!category) {
      let current = root.path;
      for (const part of relative.split('/')) {
        current = path.join(current, part);
        try { if (isLink(fs.lstatSync(current))) fail('记忆路径包含符号链接'); }
        catch (error) { if (error.message === '记忆路径包含符号链接') throw error; if (error.code === 'ENOENT') break; throw error; }
      }
      fail('记忆路径不属于可管理范围');
    }
    return { root, relative, category, id: `${root.prefix}${relative}` };
  }

  makeEntry(root, relative, stat, content = '') {
    const category = categoryFor(relative);
    if (!category) return null;
    const filename = path.posix.basename(relative);
    let name = filename.slice(0, -3);
    if (relative.toLowerCase() === 'memory.md') name = '核心记忆';
    else if (relative.toLowerCase() === 'memory_summary.md') name = '系统摘要';
    else if (relative.toLowerCase() === 'raw_memories.md') name = '原始记忆';
    const rootPrefix = root.prefix;
    return {
      id: `${rootPrefix}${relative}`,
      name,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      rootLabel: root.label,
      modifiedAt: stat.mtimeMs,
      size: stat.size,
      preview: cleanPreview(content),
      editable: isEditable(relative, category),
      deletable: isDeletable(relative, category),
    };
  }

  list({ category = 'all', query = '', root: rootLabel = 'all' } = {}) {
    if (!VALID_CATEGORIES.has(category)) fail('分类无效');
    if (typeof query !== 'string' || query.length > 200) fail('搜索词无效');
    if (rootLabel !== 'all' && !this.roots.some(item => item.label === rootLabel)) fail('记忆来源无效');
    const needle = query.trim().toLocaleLowerCase();
    const entries = [];
    this.truncated = false;
    let visited = 0;
    let scanned = 0;

    const addFile = (root, relative, expectedCategory) => {
      if (visited >= MAX_LIST_ITEMS) return;
      const actualCategory = categoryFor(relative);
      if (!actualCategory || actualCategory !== expectedCategory) return;
      if (category !== 'all' && category !== actualCategory) return;
      let safe;
      try { safe = ensureRegularFile(root.path, relative); }
      catch (error) { if (/不存在/.test(error.message)) return; throw error; }
      if (!safe || safe.stat.size > MAX_DOCUMENT_BYTES) return;
      visited += 1;
      let content = '';
      try {
        const key = `${root.prefix}${relative}`;
        const signature = `${safe.stat.ino}:${safe.stat.size}:${safe.stat.mtimeMs}:${safe.stat.ctimeMs}`;
        const cached = this.cache.get(key);
        content = cached?.signature === signature ? cached.content : readUtf8(root.path, relative, { preview: true }).content;
        if (Buffer.byteLength(content) <= 512 * 1024) {
          this.cache.delete(key); this.cache.set(key, { signature, content });
          while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
        }
      }
      catch { return; }
      const entry = this.makeEntry(root, relative, safe.stat, content);
      if (!entry || category !== 'all' && entry.category !== category) return;
      if (needle && !`${entry.name}\n${entry.id}\n${content}`.toLocaleLowerCase().includes(needle)) return;
      entries.push(entry);
    };

    const visitDirectory = (root, directory, relative, categoryName, depth) => {
      if (depth > MAX_DEPTH || visited >= MAX_LIST_ITEMS) return;
      let dirStat;
      try { dirStat = fs.lstatSync(directory); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (isLink(dirStat) || !dirStat.isDirectory()) return;
      let children;
      try { children = fs.readdirSync(directory, { withFileTypes: true }); }
      catch { return; }
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        scanned += 1;
        if (visited >= MAX_LIST_ITEMS || scanned >= MAX_LIST_ITEMS * 2) { this.truncated = true; break; }
        if (child.name.startsWith('.')) continue;
        const childRelative = `${relative}/${child.name}`;
        const childPath = path.join(directory, child.name);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) visitDirectory(root, childPath, childRelative, categoryName, depth + 1);
        else if (child.isFile() && child.name.toLowerCase().endsWith('.md')) addFile(root, childRelative, categoryName);
      }
    };

    for (const root of this.roots) {
      if (rootLabel !== 'all' && root.label !== rootLabel) continue;
      let rootStat;
      try { rootStat = fs.lstatSync(root.path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (isLink(rootStat) || !rootStat.isDirectory()) continue;

      for (const [filename, categoryName] of ROOT_DOCUMENTS) {
        const actual = fs.readdirSync(root.path).find(name => name.toLowerCase() === filename);
        if (actual) addFile(root, actual, categoryName);
      }
      for (const [directory, categoryName] of [
        ['extensions/ad_hoc/notes', 'notes'],
        ['rollout_summaries', 'history'],
        ['skills', 'skills'],
      ]) {
        const target = path.join(root.path, ...directory.split('/'));
        let current = root.path, safe = true;
        for (const part of directory.split('/')) {
          current = path.join(current, part);
          try { const stat = fs.lstatSync(current); if (isLink(stat) || !stat.isDirectory()) { safe = false; break; } }
          catch { safe = false; break; }
        }
        if (safe) visitDirectory(root, target, directory, categoryName, 1);
      }
    }

    return entries.sort((left, right) => right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id));
  }

  read(id) {
    const target = this.rootForId(id);
    const { content, hash, stat } = readUtf8(target.root.path, target.relative);
    return { ...this.makeEntry(target.root, target.relative, stat, content), content, hash };
  }

  catalog({ category = 'all', query = '', root = 'all', sort = 'modified' } = {}) {
    if (!VALID_CATEGORIES.has(category)) fail('分类无效');
    if (typeof query !== 'string' || query.length > 200) fail('搜索词无效');
    if (root !== 'all' && !this.roots.some(item => item.label === root)) fail('记忆来源无效');
    if (!['modified', 'name'].includes(sort)) fail('排序方式无效');
    const all = this.list({ root, query });
    const counts = Object.fromEntries(['all', ...Object.keys(CATEGORY_LABELS)].map(key => [key, key === 'all' ? all.length : all.filter(item => item.category === key).length]));
    const items = all.filter(item => category === 'all' || item.category === category);
    if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    return { items, counts, total: all.length, truncated: this.truncated, roots: this.roots.map(item => {
      let exists = false; try { const stat = fs.lstatSync(item.path); exists = stat.isDirectory() && !isLink(stat); } catch {}
      return { label: item.label, exists, preferred: item === this.noteRoot };
    }) };
  }

  rename(id, title, expectedHash) {
    const target = this.rootForId(id);
    if (!isDeletable(target.relative, target.category)) fail('只能重命名自定义备注');
    const name = validateName(title);
    const current = this.read(id);
    if (!expectedHash || current.hash !== expectedHash) fail('记忆文件已发生变化，请刷新后重试');
    const relative = path.posix.dirname(target.relative) + '/' + name + '.md';
    if (relative === target.relative) return current;
    const file = ensureRegularFile(target.root.path, target.relative).file;
    const destination = path.join(path.dirname(file), name + '.md');
    try { fs.linkSync(file, destination); }
    catch (error) { if (error.code === 'EEXIST') fail('已有同名自定义记忆'); throw error; }
    try { fs.unlinkSync(file); } catch (error) { fs.unlinkSync(destination); throw error; }
    return this.read(target.root.prefix + relative);
  }

  write(id, content, expectedHash) {
    const target = this.rootForId(id);
    if (!isEditable(target.relative, target.category)) fail('此记忆文件只读');
    validateContent(content);
    if (typeof expectedHash !== 'string' || !expectedHash) fail('缺少有效的文件版本标记，请重新读取');
    const current = readUtf8(target.root.path, target.relative);
    if (current.hash !== expectedHash) fail('记忆文件已发生变化，请刷新后重试');
    const mode = current.stat.mode & 0o777;
    const safe = ensureRegularFile(target.root.path, target.relative);
    atomicWrite(safe.file, content, mode || 0o600);
    return this.read(target.id);
  }

  create(title, content = '') {
    const name = validateName(title);
    validateContent(content);
    const directory = ensureNoteDirectory(this.noteRoot.path);
    const relative = 'extensions/ad_hoc/notes/' + name + '.md';
    const id = `${this.noteRoot.prefix}${relative}`;
    const file = path.join(directory, `${name}.md`);
    try { fs.lstatSync(file); fail('已有同名自定义记忆'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) { fs.closeSync(descriptor); descriptor = undefined; fs.unlinkSync(file); }
      if (error.code === 'EEXIST') fail('已有同名自定义记忆');
      throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    return this.read(id);
  }

  remove(id, expectedHash) {
    const target = this.rootForId(id);
    if (!isDeletable(target.relative, target.category)) fail('只能删除自定义备注');
    if (typeof expectedHash !== 'string' || !expectedHash) fail('缺少有效的文件版本标记，请重新读取');
    const current = readUtf8(target.root.path, target.relative);
    if (current.hash !== expectedHash) fail('记忆文件已发生变化，请刷新后重试');
    const file = ensureRegularFile(target.root.path, target.relative).file;
    fs.unlinkSync(file);
    return { deleted: true, id: target.id };
  }

  dispatch(method, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('记忆操作参数无效');
    if (method === 'list') return this.list(args);
    if (method === 'catalog') return this.catalog(args);
    if (method === 'rename') return this.rename(args.id, args.name, args.expectedHash);
    if (method === 'read') return this.read(args.id);
    if (method === 'write') return this.write(args.id, args.content, args.expectedHash);
    if (method === 'create') return this.create(args.name ?? args.title, args.content ?? '');
    if (method === 'delete' || method === 'remove') return this.remove(args.id, args.expectedHash);
    fail('不支持的记忆操作');
  }
}

module.exports = { CodexMemory, CATEGORY_LABELS, validateName, categoryFor };
