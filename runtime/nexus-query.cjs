'use strict';
const { check, yaml } = require('./nexus-files.cjs');
const moment = require('moment');
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
function field(object, key) { check(!blocked.has(key), '禁止访问原型属性'); return object && Object.hasOwn(Object(object), key) ? object[key] : null; }
function split(text, separator = ',') {
  const result = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('(['.includes(c)) depth++;
    else if (')]'.includes(c)) depth--;
    else if (!depth && c === separator) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  result.push(text.slice(start).trim()); return result;
}
const funcs = new Set(['contains', 'icontains', 'startswith', 'endswith', 'lower', 'upper', 'length', 'default', 'choice', 'if', 'date', 'dateformat', 'now', 'today', 'number', 'string', 'round', 'list', 'link']);
const methods = new Set(['contains', 'includes', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'isEmpty', 'hasTag', 'inFolder', 'hasLink', 'format', 'round', 'floor', 'ceil', 'toFixed', 'toString', 'year', 'month', 'day']);
function expression(text) {
  check(typeof text === 'string' && text.length <= 5000, '表达式过长');
  const tokens = []; let offset = 0;
  const pattern = /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([\p{L}_$][\p{L}\p{N}_$-]*)|(>=|<=|!=|==|&&|\|\||[=><!+*/%().,\[\]-]))/uy;
  while (offset < text.trimEnd().length) {
    pattern.lastIndex = offset; const m = pattern.exec(text);
    check(m, '不支持的表达式语法：' + text.slice(offset, offset + 35)); offset = pattern.lastIndex;
    tokens.push(m[1] ? { kind: 'literal', value: Number(m[1]) } : m[2] ? { kind: 'literal', value: m[2][0] === '"' ? JSON.parse(m[2]) : m[2].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\') } : { kind: 'symbol', value: /^(and|or|not)$/i.test(m[3] || '') ? m[3].toLowerCase() : m[3] || m[4] });
  }
  let pos = 0, nesting = 0;
  const peek = () => tokens[pos]?.value, take = () => tokens[pos++], expect = value => check(take()?.value === value, '表达式缺少 ' + value);
  function argumentsList(end) { const args = []; if (peek() !== end) { do { args.push(parse(0)); if (peek() !== ',') break; take(); } while (true); } expect(end); return args; }
  function primary() {
    check(++nesting < 60, '表达式嵌套过深'); const token = take(); check(token, '表达式不完整'); let node;
    if (token.kind === 'literal') node = { type: 'value', value: token.value };
    else if (['!', 'not', '-'].includes(token.value)) node = { type: 'unary', op: token.value, arg: primary() };
    else if (token.value === '(') { node = parse(0); expect(')'); }
    else if (token.value === '[') node = { type: 'list', args: argumentsList(']') };
    else if (['true', 'false', 'null'].includes(token.value)) node = { type: 'value', value: JSON.parse(token.value) };
    else { check(/^[\p{L}_$]/u.test(token.value) && !blocked.has(token.value), '不支持的标识符'); node = { type: 'name', name: token.value }; }
    while (['.', '[', '('].includes(peek())) {
      const op = take().value;
      if (op === '(') { check(node.type === 'name' && funcs.has(node.name), '不支持的函数：' + node.name); node = { type: 'call', name: node.name, args: argumentsList(')') }; }
      else if (op === '[') { const key = take(); check(key?.kind === 'literal' && typeof key.value === 'string' && !blocked.has(key.value), '属性索引必须是字符串'); expect(']'); node = { type: 'field', target: node, name: key.value }; }
      else {
        const name = take()?.value; check(typeof name === 'string' && !blocked.has(name), '属性名称无效');
        if (peek() === '(') { take(); check(methods.has(name), '不支持的方法：' + name); node = { type: 'method', target: node, name, args: argumentsList(')') }; }
        else node = { type: 'field', target: node, name };
      }
    }
    nesting--; return node;
  }
  const priorities = { or: 1, '||': 1, and: 2, '&&': 2, '=': 3, '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5 };
  function parse(min) { let node = primary(); while ((priorities[peek()] || 0) > min) { const op = take().value; node = { type: 'binary', op, left: node, right: parse(priorities[op]) }; } return node; }
  const ast = parse(0); check(pos === tokens.length, '表达式含未支持的语法：' + tokens.slice(pos).map(t => t.value).join(' '));
  return ctx => evaluate(ast, ctx);
}
const scalar = value => value instanceof Date ? value.getTime() : value;
function evaluate(node, ctx) {
  const ev = item => evaluate(item, ctx);
  switch (node.type) {
    case 'value': return node.value;
    case 'name': return field(ctx, node.name);
    case 'field': return field(ev(node.target), node.name);
    case 'list': return node.args.map(ev);
    case 'unary': return node.op === '-' ? -Number(ev(node.arg)) : !ev(node.arg);
    case 'binary': {
      const a = ev(node.left); if (['and', '&&'].includes(node.op)) return a && ev(node.right); if (['or', '||'].includes(node.op)) return a || ev(node.right);
      const b = ev(node.right), x = scalar(a), y = scalar(b);
      switch (node.op) {
        case '=': case '==': return JSON.stringify(a) === JSON.stringify(b); case '!=': return JSON.stringify(a) !== JSON.stringify(b);
        case '>': return x > y; case '<': return x < y; case '>=': return x >= y; case '<=': return x <= y;
        case '+': return x + y; case '-': return a instanceof Date && b instanceof Date ? { milliseconds: x - y, days: (x - y) / 86400000, hours: (x - y) / 3600000 } : x - y;
        case '*': return x * y; case '/': return y ? x / y : null; case '%': return y ? x % y : null;
      }
      break;
    }
    case 'call': {
      if (['if', 'choice'].includes(node.name)) { check(node.args.length === 3, 'if/choice 需要三个参数'); return ev(node.args[0]) ? ev(node.args[1]) : ev(node.args[2]); }
      const a = node.args.map(ev), s = String(a[0] ?? '');
      switch (node.name) {
        case 'contains': return Array.isArray(a[0]) ? a[0].includes(a[1]) : s.includes(String(a[1]));
        case 'icontains': return s.toLowerCase().includes(String(a[1]).toLowerCase());
        case 'startswith': return s.startsWith(String(a[1])); case 'endswith': return s.endsWith(String(a[1]));
        case 'lower': return s.toLowerCase(); case 'upper': return s.toUpperCase(); case 'length': return a[0]?.length || 0;
        case 'default': return a[0] ?? a[1]; case 'number': return Number(a[0]); case 'string': return s;
        case 'date': { const date = moment(a[0] === 'today' ? undefined : a[0]); check(date.isValid(), '日期无效'); return date.toDate(); }
        case 'dateformat': { check(a[0] instanceof Date && typeof a[1] === 'string', 'dateformat 需要日期与格式'); return moment(a[0]).format(a[1].replace(/yyyy/g, 'YYYY').replace(/yy/g, 'YY').replace(/dd/g, 'DD')); }
        case 'today': return moment().startOf('day').toDate(); case 'now': return new Date();
        case 'round': return Number(Number(a[0]).toFixed(Math.max(0, Math.min(12, Number(a[1]) || 0))));
        case 'list': return a; case 'link': return { path: s, display: a[1] || s };
      }
      break;
    }
    case 'method': {
      const target = ev(node.target), a = node.args.map(ev), s = String(target ?? '');
      switch (node.name) {
        case 'hasTag': return (target?.tags || []).some(t => t.replace(/^#/, '') === String(a[0]).replace(/^#/, '') || t.replace(/^#/, '').startsWith(String(a[0]).replace(/^#/, '') + '/'));
        case 'hasLink': return (target?.links || []).some(t => t.path === a[0] || t.path === a[0] + '.md');
        case 'inFolder': return a[0] === '' || target?.folder === a[0] || target?.folder?.startsWith(a[0] + '/');
        case 'contains': case 'includes': return Array.isArray(target) ? target.includes(a[0]) : s.includes(String(a[0]));
        case 'startsWith': return s.startsWith(String(a[0])); case 'endsWith': return s.endsWith(String(a[0]));
        case 'toLowerCase': return s.toLowerCase(); case 'toUpperCase': return s.toUpperCase(); case 'toString': return s;
        case 'isEmpty': return target == null || target.length === 0;
        case 'format': check(target instanceof Date, 'format 仅支持日期'); return moment(target).format(a[0] || 'YYYY-MM-DD');
        case 'year': case 'month': case 'day': check(target instanceof Date, '日期方法需要 date()'); return moment(target)[node.name]();
        case 'round': return Math.round(Number(target)); case 'floor': return Math.floor(Number(target)); case 'ceil': return Math.ceil(Number(target));
        case 'toFixed': return Number(target).toFixed(Math.max(0, Math.min(12, Number(a[0]) || 0)));
      }
    }
  }
  throw Error('不支持的表达式');
}
function context(note) {
  const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
  const file = { path: note.path, name: note.name, basename: note.name, ext: 'md', folder, link: { path: note.path, display: note.name }, tags: note.tags.map(x => '#' + x), etags: note.tags.map(x => '#' + x), aliases: note.aliases, links: note.links.filter(l => l.path).map(l => ({ path: l.path })), backlinks: (note.backlinks || []).map(l => ({ path: l.path })), size: note.size, ctime: new Date(note.ctime), mtime: new Date(note.mtime), tasks: note.tasks, properties: note.properties };
  return { ...note.properties, note: note.properties, file };
}
function sourceFilter(text) {
  // Translate only the documented source subset; never evaluate JavaScript.
  const translated = text.replace(/#[\p{L}\p{N}_/-]+|"(?:[^"\\]|\\.)*"|\[\[[^\]]+\]\]/gu, token => {
    if (token.startsWith('#')) return `file.hasTag(${JSON.stringify(token)})`;
    if (token.startsWith('"')) return `file.inFolder(${token})`;
    return `file.hasLink(${JSON.stringify(token.slice(2, -2))})`;
  }).replace(/\bAND\b/gi, 'and').replace(/\bOR\b/gi, 'or');
  return expression(translated);
}
function dataview(query, notes, current) {
  check(typeof query === 'string' && query.length <= 20000, 'Dataview 查询无效或过长');
  const lines = [];
  for (const line of query.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (!lines.length || /^(FROM|WHERE|SORT|LIMIT|GROUP BY|FLATTEN)\b/i.test(line)) lines.push(line);
    else lines[lines.length - 1] += ' ' + line;
  }
  const first = lines.shift()?.match(/^(TABLE|LIST|TASK)(?:\s+(WITHOUT ID)\b)?(?:\s+(.+))?$/i);
  check(first, '支持 Dataview TABLE / LIST / TASK；不执行 DataviewJS');
  const type = first[1].toLowerCase(); let rows = notes.map(n => ({ note: n, ctx: { ...context(n), this: current ? context(current) : {} } }));
  if (type === 'task') rows = rows.flatMap(r => r.note.tasks.map(task => ({ ...r, task, ctx: { ...r.ctx, ...task } })));
  const headers = [], values = [];
  if (!first[2] && type === 'table') { headers.push('笔记'); values.push(ctx => ctx.file.link); }
  if (first[3]) for (const column of split(first[3])) { const m = column.match(/^(.*?)(?:\s+AS\s+(?:"([^"]+)"|([\p{L}\p{N}_ -]+)))?$/iu); headers.push(m[2] || m[3] || m[1]); values.push(expression(m[1])); }
  check(type !== 'task' || values.length === 0, 'TASK 不支持列选择');
  const used = new Set();
  for (const line of lines) {
    const m = line.match(/^(FROM|WHERE|SORT|LIMIT|GROUP BY)\s+(.+)$/i); check(m, '尚未支持 Dataview 子句：' + line);
    const kind = m[1].toUpperCase(); check(kind === 'WHERE' || !used.has(kind), '重复查询子句：' + kind); used.add(kind);
    if (kind === 'FROM' || kind === 'WHERE') { const predicate = kind === 'FROM' ? sourceFilter(m[2]) : expression(m[2]); rows = rows.filter(row => predicate(row.ctx)); }
    if (kind === 'SORT') {
      const orders = split(m[2]).map(value => { const x = value.match(/^(.*?)(?:\s+(ASC|DESC))?$/i); return { get: expression(x[1]), descending: x[2]?.toUpperCase() === 'DESC' }; });
      rows.sort((a, b) => { for (const o of orders) { const x = scalar(o.get(a.ctx)), y = scalar(o.get(b.ctx)), d = x == y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1; if (d) return o.descending ? -d : d; } return 0; });
    }
    if (kind === 'LIMIT') { check(/^\d+$/.test(m[2]), 'LIMIT 需要非负整数'); rows = rows.slice(0, Math.min(10000, Number(m[2]))); }
    if (kind === 'GROUP BY') { check(type === 'task', '尚未支持 TABLE/LIST GROUP BY；TASK 可以按笔记分组'); const group = expression(m[2]); rows = rows.map(r => ({ ...r, group: group(r.ctx) })).sort((a, b) => JSON.stringify(a.group).localeCompare(JSON.stringify(b.group))); }
  }
  const total = rows.length; rows = rows.slice(0, 1000);
  return { type, headers, total, truncated: total > rows.length, rows: rows.map(r => ({ path: r.note.path, values: values.map(fn => fn(r.ctx)), task: r.task, group: r.group, title: r.note.name })) };
}
function bases(content, notes, viewName, current) {
  const spec = yaml(content); check(spec && Array.isArray(spec.views) && spec.views.length, 'Base 需要至少一个视图');
  const view = viewName ? spec.views.find(v => v.name === viewName) : spec.views[0]; check(view, 'Base 视图不存在');
  check(['table', 'cards', 'list'].includes(view.type), '支持 Base table/cards/list 视图，暂不支持地图');
  function filter(value) {
    if (!value) return () => true;
    if (typeof value === 'string') return expression(value);
    check(typeof value === 'object' && Object.keys(value).length === 1, 'Base 筛选格式无效');
    const [op, items] = Object.entries(value)[0]; check(['and', 'or', 'not'].includes(op) && Array.isArray(items), 'Base 筛选需要 and/or/not 数组');
    const tests = items.map(filter); return c => op === 'and' ? tests.every(f => f(c)) : op === 'or' ? tests.some(f => f(c)) : !tests.some(f => f(c));
  }
  const formulas = Object.entries(spec.formulas || {}).map(([name, expr]) => [name, expression(expr)]), a = filter(spec.filters), b = filter(view.filters);
  let rows = notes.map(note => {
    const ctx = { ...context(note), this: current ? context(current) : {}, formula: {} }, resolving = new Set(), results = Object.create(null);
    for (const [name, fn] of formulas) { check(!blocked.has(name), '公式名无效'); Object.defineProperty(ctx.formula, name, { enumerable: true, get() { check(!resolving.has(name), 'Base 公式循环：' + name); if (Object.hasOwn(results, name)) return results[name]; resolving.add(name); try { return results[name] = fn(ctx); } finally { resolving.delete(name); } } }); }
    return { note, ctx };
  }).filter(row => a(row.ctx) && b(row.ctx));
  const columns = view.order || ['file.name']; check(Array.isArray(columns) && columns.every(c => typeof c === 'string'), 'Base order 无效');
  const get = key => c => key.startsWith('formula.') ? field(c.formula, key.slice(8)) : key.startsWith('file.') ? field(c.file, key.slice(5)) : field(c.note, key.replace(/^note\./, ''));
  if (view.sort) { check(Array.isArray(view.sort), 'Base sort 必须是数组'); for (const order of [...view.sort].reverse()) { const fn = get(order.property); rows.sort((x, y) => String(fn(x.ctx) ?? '').localeCompare(String(fn(y.ctx) ?? ''), 'zh-CN', { numeric: true }) * (order.direction === 'DESC' ? -1 : 1)); } }
  const grouping = view.groupBy; if (grouping) { const fn = get(grouping.property); rows.sort((x, y) => String(fn(x.ctx) ?? '').localeCompare(String(fn(y.ctx) ?? '')) * (grouping.direction === 'DESC' ? -1 : 1)); }
  if (view.limit != null) { check(Number.isInteger(view.limit) && view.limit >= 0, 'Base limit 无效'); rows = rows.slice(0, view.limit); }
  const summaries = {};
  for (const [key, op] of Object.entries(view.summaries || {})) {
    const values = rows.map(r => get(key)(r.ctx)), numbers = values.filter(v => typeof v === 'number' && Number.isFinite(v));
    const ops = { Sum: () => numbers.reduce((a, b) => a + b, 0), Average: () => numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null, Min: () => numbers.length ? Math.min(...numbers) : null, Max: () => numbers.length ? Math.max(...numbers) : null, Filled: () => values.filter(v => v != null && v !== '').length, Empty: () => values.filter(v => v == null || v === '').length, Unique: () => new Set(values.map(v => JSON.stringify(v))).size, Checked: () => values.filter(v => v === true).length, Unchecked: () => values.filter(v => v === false).length };
    check(Object.hasOwn(ops, op), '未支持的 Base 汇总：' + op); summaries[key] = ops[op]();
  }
  const total = rows.length;
  return { type: view.type, view: view.name, views: spec.views.map(v => ({ name: v.name, type: v.type })), columns, headers: columns.map(c => spec.properties?.[c]?.displayName || c), total, truncated: total > 1000, summaries, rows: rows.slice(0, 1000).map(r => ({ path: r.note.path, title: r.note.name, group: grouping ? get(grouping.property)(r.ctx) : null, values: columns.map(c => get(c)(r.ctx)) })) };
}
module.exports = { expression, dataview, bases, context, split };
