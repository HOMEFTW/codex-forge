'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({ html: false });
const MAX_TEXT = 8 * 1024 * 1024;
const CONFIGS = new Set(['core-plugins.json', 'community-plugins.json', 'daily-notes.json', 'templates.json', 'bookmarks.json', 'plugins/homepage/data.json', 'plugins/templater-obsidian/data.json', 'plugins/quickadd/data.json']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const check = (condition, message, code = 'INVALID_ARGUMENT') => { if (!condition) throw Object.assign(Error(message), { code }); };
function relative(value, { hidden = false } = {}) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\\:\x00-\x1f<>"|?*]/.test(value), '使用知识库内相对路径，不允许绝对路径或特殊字符');
  const parts = value.split('/');
  check(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) && (hidden || !p.startsWith('.'))), '路径不能越出知识库、指向隐藏目录或设备');
  return value;
}
function safePath(root, value, options = {}) {
  const parts = relative(value, options).split('/');
  check(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), '知识库根目录无效或为链接', 'PERMISSION_DENIED');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      // A dangling symlink also needs rejecting.
      try { check(!fs.lstatSync(current).isSymbolicLink(), '不允许符号链接', 'PERMISSION_DENIED'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      continue;
    }
    check(!fs.lstatSync(current).isSymbolicLink(), '不允许符号链接或目录联接', 'PERMISSION_DENIED');
  }
  return current;
}
function readText(root, value, options) {
  const file = safePath(root, value, options), stat = fs.statSync(file);
  check(stat.isFile() && stat.size <= MAX_TEXT, '文件不是普通文件或超过 8 MiB');
  return fs.readFileSync(file, 'utf8');
}
function readConfig(root, name) {
  check(CONFIGS.has(name), '未开放此 Obsidian 配置');
  try { return JSON.parse(readText(root, '.obsidian/' + name, { hidden: true })); }
  catch (e) { if (e.code === 'ENOENT') return null; throw Error(`配置 ${name}：${e.message}`); }
}
function yaml(text) {
  const doc = YAML.parseDocument(text, { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length) throw Error('YAML：' + doc.errors[0].message);
  return doc.toJS({ maxAliasCount: 30 });
}
function frontmatter(content) {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { properties: {}, body: content, prefix: '', offset: 0 };
  const properties = yaml(match[1]) || {};
  check(typeof properties === 'object' && !Array.isArray(properties), '笔记属性必须是 YAML 对象');
  return { properties, body: content.slice(match[0].length), prefix: match[0], offset: match[0].split('\n').length - 1 };
}
function strings(value) { return (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，]/) : []).map(String).map(x => x.trim()).filter(Boolean); }
function metadata(file, content) {
  const warnings = []; let parsed;
  try { parsed = frontmatter(content); } catch (e) { parsed = { properties: {}, body: content, offset: 0 }; warnings.push(e.message); }
  const { properties, body, offset } = parsed;
  const tokens = md.parse(body.replace(/%%[\s\S]*?%%/g, s => s.replace(/[^\n]/g, ' ')), {}), headings = [], links = [], tasks = [], texts = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') headings.push({ text: tokens[i + 1]?.content || '', level: Number(token.tag.slice(1)), line: token.map[0] + offset });
    if (token.type !== 'inline') continue;
    const text = (token.children || []).filter(c => c.type === 'text').map(c => c.content).join(' '); texts.push(text);
    for (const match of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) links.push({ target: match[2].split('|')[0], alias: match[2].split('|')[1] || '', embed: !!match[1], line: (token.map?.[0] || 0) + offset });
    for (const c of token.children || []) {
      const target = c.type === 'link_open' ? c.attrGet('href') : c.type === 'image' ? c.attrGet('src') : null;
      if (target && !/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) { let decoded = target; try { decoded = decodeURI(target); } catch {} links.push({ target: decoded, embed: c.type === 'image', line: (token.map?.[0] || 0) + offset }); }
    }
    if (token.map) for (let line = token.map[0]; line < token.map[1]; line++) {
      const task = lines[line]?.match(/^\s*(?:[-+*]|\d+\.)\s+\[([ xX])\]\s+(.*)$/);
      if (task) tasks.push({ line: line + offset, text: task[2], completed: task[1] !== ' ' });
    }
  }
  const tags = new Set(strings(properties.tags).map(x => x.replace(/^#/, '')));
  for (const match of texts.join('\n').matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(match[1]);
  const plain = texts.join(' '), han = plain.match(/\p{Script=Han}/gu) || [], words = plain.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return { path: file, name: path.posix.basename(file, path.posix.extname(file)), properties, aliases: strings(properties.aliases), tags: [...tags], headings, links, tasks, stats: { words: han.length + words.length, characters: [...body].length, lines: content.split('\n').length, tasks: tasks.length, completed: tasks.filter(t => t.completed).length }, warnings };
}
function scan(root, cache = new Map()) {
  const files = [], notes = [], seen = new Set(), warnings = []; let bytes = 0;
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) { warnings.push('跳过链接：' + name); continue; }
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), name + '/'); continue; }
      if (!entry.isFile()) continue;
      check(files.length < 30000, '知识库超过 30000 文件，请连接更小的知识库目录');
      const stat = fs.statSync(safePath(root, name)), ext = path.extname(name).slice(1).toLowerCase();
      files.push({ path: name, ext, size: stat.size, mtime: stat.mtimeMs, ctime: stat.birthtimeMs }); seen.add(name);
      if (ext !== 'md') continue;
      if (stat.size > MAX_TEXT || (bytes += stat.size) > 128 * 1024 * 1024) { warnings.push('未索引过大的笔记：' + name); continue; }
      const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      let cached = cache.get(name);
      if (!cached || cached.signature !== signature) {
        const content = readText(root, name); cached = { signature, content, meta: metadata(name, content) }; cache.set(name, cached);
      }
      notes.push({ ...cached.meta, content: cached.content, mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size });
    }
  }
  walk(root); for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  return { files, notes, warnings };
}
function resolveLink(index, target, source = '') {
  check(typeof target === 'string' && target.length <= 2000, '链接目标无效');
  if (!index.linkIndex) {
    const files = new Set(index.files.map(f => f.path)), names = new Map();
    const add = (name, file) => { if (!names.has(name)) names.set(name, new Set()); names.get(name).add(file); };
    for (const file of index.files) { add(path.posix.basename(file.path), file.path); add(path.posix.basename(file.path, '.md'), file.path); }
    for (const note of index.notes) for (const alias of note.aliases) add(alias, note.path);
    Object.defineProperty(index, 'linkIndex', { value: { files, names } });
  }
  let raw; try { raw = decodeURIComponent(target.split('|')[0]); } catch { raw = target.split('|')[0]; }
  const at = raw.indexOf('#'), fragment = at >= 0 ? raw.slice(at + 1) : '', value = at >= 0 ? raw.slice(0, at) : raw;
  if (!value) return { path: source || null, fragment };
  const candidates = [path.posix.join(path.posix.dirname(source), value), value];
  for (const name of candidates) for (const p of [name, name + '.md']) if (index.linkIndex.files.has(p)) return { path: p, fragment };
  const matches = [...(index.linkIndex.names.get(value) || [])];
  if (matches.length === 1) return { path: matches[0], fragment };
  return { path: null, fragment, ambiguous: matches.length > 1, candidates: matches };
}
function publicNote(note) { const { content, ...rest } = note; return rest; }
module.exports = { fs, path, YAML, MAX_TEXT, hash, check, relative, safePath, readText, readConfig, yaml, frontmatter, metadata, scan, resolveLink, publicNote };
