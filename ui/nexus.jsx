import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import MarkdownView, { Attachment, QueryBlock, QueryResult } from './nexus-render.jsx';
import './nexus.css';

const tabs = [['files', '文件'], ['search', '搜索'], ['tags', '标签'], ['bookmarks', '书签'], ['graph', '图谱'], ['bases', '数据库'], ['templates', '模板'], ['quickadd', 'QuickAdd']];
const failText = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const savedDrafts = new Map();
function FileTree({ files, selected, open, prefix = '', depth = 0 }) {
  const direct = [], folders = new Map();
  for (const file of files) {
    const rest = file.path.slice(prefix.length), slash = rest.indexOf('/');
    if (slash < 0) direct.push(file); else { const name = rest.slice(0, slash); if (!folders.has(name)) folders.set(name, []); folders.get(name).push(file); }
  }
  return <div className="ob-file-tree">{[...folders].map(([name, children]) => <details key={name} open={depth === 0 || selected?.startsWith(prefix + name + '/')}><summary>{name}<small>{children.length}</small></summary><FileTree files={children} prefix={prefix + name + '/'} selected={selected} open={open} depth={depth + 1}/></details>)}{direct.map(file => <button key={file.path} className={selected === file.path ? 'selected' : ''} onClick={() => open(file.path)} title={file.path}><span>{file.ext === 'md' ? '▤' : file.ext === 'base' ? '▦' : '◇'}</span>{file.path.slice(prefix.length)}</button>)}</div>;
}
function Bookmarks({ items, open, search, remove, prefix = [] }) {
  return <div className="ob-bookmarks">{items.map((item, i) => <div key={i}>{item.type === 'group' ? <details open><summary>{item.title || '分组'}</summary><Bookmarks items={item.items || []} open={open} search={search} remove={remove} prefix={[...prefix, i]}/></details> : <button className="ob-link" onClick={() => item.type === 'search' ? search(item.query || '') : item.path ? open(item.path) : undefined}>{item.title || item.path || item.type}</button>}<button className="ob-small" aria-label="删除书签" onClick={() => remove([...prefix, i])}>×</button></div>)}</div>;
}
function Graph({ data, open }) {
  const nodes = useMemo(() => (data?.nodes || []).map((node, i, all) => {
    const ring = Math.floor(Math.sqrt(i)), theta = i * 2.3999632297, radius = 110 * ring;
    return { id: node.id, position: { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius }, data: { label: node.title }, style: { width: 150, borderRadius: 22, background: '#f0ecff', borderColor: '#8f7ac0', color: '#332b48', fontSize: all.length > 100 ? 10 : 12 } };
  }), [data]);
  const edges = useMemo(() => [...new Map((data?.edges || []).map(e => [e.source + '\0' + e.target, { id: e.source + '\0' + e.target, source: e.source, target: e.target, style: { stroke: '#9b92b0' } }])).values()], [data]);
  return <div className="ob-graph"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.02} maxZoom={2} onNodeClick={(_e, node) => open(node.id)} nodesDraggable nodesConnectable={false}><Background/><Controls showInteractive={false}/><MiniMap/></ReactFlow>{data?.truncated && <small>图谱仅展示前 1500 篇笔记，共 {data.total} 篇</small>}</div>;
}
function Dialog({ spec, close, submit }) {
  const [values, setValues] = useState(spec.initial || {}), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const accept = async () => { if (busy) return; setBusy(true); setError(''); try { for (const field of spec.fields) if (field.required && !String(values[field.key] || '').trim()) throw Error('请填写' + field.label); await submit(values); close(); } catch (err) { setError(failText(err)); } finally { setBusy(false); } };
  return <div className="ob-modal-shade"><div role="dialog" aria-label={spec.title} className="ob-dialog" onKeyDown={e => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); accept(); } }}><h2>{spec.title}</h2>{spec.description && <p>{spec.description}</p>}{spec.fields.map(field => <label key={field.key}>{field.label}{field.type === 'select' ? <select value={values[field.key] ?? ''} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}>{field.options.map(x => <option key={typeof x === 'string' ? x : x[0]} value={typeof x === 'string' ? x : x[0]}>{typeof x === 'string' ? x : x[1]}</option>)}</select> : field.type === 'text' ? <textarea value={values[field.key] ?? ''} readOnly={field.readOnly} placeholder={field.placeholder} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} rows={field.rows || 5}/> : <input autoFocus={field === spec.fields[0]} type={field.type || 'text'} required={field.required} value={values[field.key] ?? ''} placeholder={field.placeholder} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}/>}</label>)}{error && <p className="ob-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="button" className="ob-primary" disabled={busy} onClick={accept}>{busy ? '处理中…' : spec.confirm || '确定'}</button></footer></div></div>;
}
export default function NexusPanel({ api, mode, onMode, onClose }) {
  const [vaults, setVaults] = useState([]), [vaultId, setVaultId] = useState(''), [snapshot, setSnapshot] = useState(null), [tab, setTab] = useState('files'), [selected, setSelected] = useState(''), [doc, setDoc] = useState(null), [draft, setDraft] = useState(''), [view, setView] = useState('preview');
  const [query, setQuery] = useState(''), [results, setResults] = useState(null), [graph, setGraph] = useState(null), [localGraph, setLocalGraph] = useState(false), [bookmarks, setBookmarks] = useState(null), [templates, setTemplates] = useState([]), [choices, setChoices] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [dialog, setDialog] = useState(null), [showInfo, setShowInfo] = useState(false), [queryResult, setQueryResult] = useState(null), [refresh, setRefresh] = useState(0), [remoteChanged, setRemoteChanged] = useState(false);
  const selection = useRef(0), active = useRef({ vaultId, selected }), editor = useRef(), draftRef = useRef(draft), docRef = useRef(doc);
  active.current = { vaultId, selected }; draftRef.current = draft; docRef.current = doc;
  const request = useCallback((method, args = {}) => api.request('nexus', { method, args: { ...args, vaultId } }), [api, vaultId]);
  const dirty = !!doc && draft !== doc.content, currentKey = vaultId + '/' + selected;
  useEffect(() => { if (doc && doc.vaultId === vaultId && doc.path === selected) { if (dirty) savedDrafts.set(currentKey, { content: draft, doc }); else savedDrafts.delete(currentKey); } }, [draft, dirty, doc, currentKey]);
  async function loadVaults() { const result = await api.request('nexus', { method: 'vaults' }); setVaults(result.vaults); if (!vaultId && result.vaults.length) setVaultId(result.vaults[0].id); return result; }
  useEffect(() => { loadVaults().catch(e => setError(failText(e))); }, []);
  const reload = useCallback(async () => {
    const result = await request('snapshot', { limit: 1000 }); let next = result.nextOffset;
    while (next !== null && next !== undefined && active.current.vaultId === vaultId) { const page = await request('snapshot', { offset: next, limit: 1000 }); result.files.push(...page.files); result.notes.push(...page.notes); next = page.nextOffset; }
    if (active.current.vaultId === vaultId) { setSnapshot(result); setRefresh(n => n + 1); } return result;
  }, [request, vaultId]);
  useEffect(() => {
    let alive = true; selection.current++; setSnapshot(null); setSelected(''); setDoc(null); setDraft(''); setError(''); setResults(null); setQueryResult(null);
    if (!vaultId) return;
    reload().then(async result => { if (alive && result.settings.homepage) await openNote(result.settings.homepage); }).catch(e => alive && setError(failText(e)));
    return () => { alive = false; };
  }, [vaultId]);
  const execute = useCallback(async fn => { setBusy(true); setError(''); setNotice(''); try { return await fn(); } catch (e) { setError(failText(e)); } finally { setBusy(false); } }, []);
  async function openNote(target, source = '') {
    const ticket = ++selection.current, startVault = vaultId;
    const result = await request('resolve', { target, source });
    if (ticket !== selection.current || active.current.vaultId !== startVault) return;
    if (!result.path) throw Error(result.ambiguous ? '名称有多个匹配，请使用完整路径：' + result.candidates.join('、') : '文件不存在：' + target);
    const file = result.path, text = /\.(md|base|canvas)$/i.test(file), next = text ? await request('read', { path: file }) : null;
    if (ticket !== selection.current || active.current.vaultId !== startVault) return;
    if (next) next.vaultId = vaultId;
    const cached = savedDrafts.get(vaultId + '/' + file); setSelected(file); setDoc(cached?.doc || next); setDraft(cached?.content ?? next?.content ?? ''); setRemoteChanged(!!cached && next?.revision !== cached.doc.revision); setError(''); setQueryResult(null);
    if (result.fragment) setTimeout(() => document.getElementById('heading-' + result.fragment)?.scrollIntoView({ block: 'start' }), 100);
  }
  const open = (target, source) => /^https?:/i.test(target) ? execute(() => request('openExternal', { url: target })) : execute(() => openNote(target, source));
  async function afterChange(result) {
    await reload();
    if (result?.path && /\.(md|base|canvas)$/i.test(result.path)) { savedDrafts.delete(vaultId + '/' + result.path); await openNote(result.path); }
    setNotice('已保存到本地知识库');
  }
  const save = () => execute(async () => {
    if (!doc) return; const at = selected, text = draft; const result = await request('write', { path: at, content: text, expectedRevision: doc.revision });
    savedDrafts.delete(vaultId + '/' + at); await afterChange(result); setRemoteChanged(false);
  });
  useEffect(() => {
    if (!vaultId || !selected || !doc) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const latest = await request('read', { path: selected }); if (stopped) return;
        if (latest.revision !== docRef.current?.revision) {
          if (draftRef.current !== docRef.current?.content) setRemoteChanged(true);
          else { setDoc({ ...latest, vaultId }); setDraft(latest.content); await reload(); }
        }
      } catch (e) { if (!stopped) setError(failText(e)); }
    }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [request, selected, !!doc, reload]);
  useEffect(() => {
    if (!vaultId) return; let alive = true;
    const operation = tab === 'bookmarks' ? ['bookmarks', setBookmarks] : tab === 'templates' ? ['templates', setTemplates] : tab === 'quickadd' ? ['quickadd_choices', setChoices] : tab === 'graph' ? ['graph', setGraph] : null;
    if (operation) request(operation[0], tab === 'graph' && localGraph ? { path: selected || undefined } : {}).then(v => alive && operation[1](v)).catch(e => alive && setError(failText(e)));
    return () => { alive = false; };
  }, [tab, vaultId, refresh, localGraph, selected]);
  useEffect(() => {
    const handle = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty && !busy) save(); } };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [dirty, busy, draft, doc, selected]);
  const note = snapshot?.notes.find(n => n.path === selected), tags = useMemo(() => { const data = new Map(); for (const n of snapshot?.notes || []) for (const tag of n.tags) data.set(tag, (data.get(tag) || 0) + 1); return [...data].sort((a, b) => b[1] - a[1]); }, [snapshot]);
  const ask = (title, fields, run, initial = {}, description = '') => setDialog({ title, fields, run, initial, description });
  const textField = (key, label, extra = {}) => ({ key, label, ...extra });
  function requireClean() { if (dirty) throw Error('请先保存当前草稿，再执行此操作。'); }
  const mutate = async (method, args) => { requireClean(); const result = await request(method, { path: selected, expectedRevision: doc?.revision, ...args }); await afterChange(result); return result; };
  const task = useCallback((line, completed) => execute(async () => { if (draftRef.current !== docRef.current?.content) throw Error('请先保存草稿再更新任务'); const result = await request('task', { path: selected, expectedRevision: docRef.current.revision, line, completed }); await afterChange(result); }), [request, selected, reload]);
  function create() { ask('新建笔记或数据库', [textField('path', '知识库内路径', { required: true, placeholder: '资料/新笔记.md' }), textField('content', '内容', { type: 'text' })], async values => afterChange(await request('write', { ...values, expectedRevision: '' })), { content: '# 新笔记\n' }); }
  function insertTemplate(template) { ask('应用模板', [textField('path', '目标笔记路径', { required: true }), textField('variables', '变量（JSON）', { type: 'text' })], async values => { requireClean(); const existing = snapshot.files.some(f => f.path === values.path), read = existing ? await request('read', { path: values.path }) : null; await afterChange(await request('template', { template, path: values.path, variables: JSON.parse(values.variables || '{}'), expectedRevision: read?.revision || '', append: !!read })); }, { path: selected.endsWith('.md') ? selected : '', variables: '{}' }, '已有笔记会在末尾追加模板；新路径会创建笔记。'); }
  async function addBookmark() {
    const data = await request('bookmarks'); if (data.items.some(x => x.path === selected)) { setNotice('当前笔记已在书签中'); return; }
    await request('bookmarks_write', { items: [...data.items, { type: 'file', path: selected, ctime: Date.now() }], expectedRevision: data.revision }); setBookmarks(await request('bookmarks')); setNotice('已添加书签');
  }
  async function removeBookmark(indices) { const copy = structuredClone(bookmarks.items); let items = copy; for (const i of indices.slice(0, -1)) items = items[i].items; items.splice(indices.at(-1), 1); await request('bookmarks_write', { items: copy, expectedRevision: bookmarks.revision }); setBookmarks(await request('bookmarks')); }
  function quickadd(choice) {
    if (!choice.supported) { setError('此 QuickAdd 是 Macro/脚本，独立模式不执行。'); return; }
    ask(choice.label, [textField('path', '目标路径（留空按配置生成）'), textField('variables', '变量（JSON，例如 {"设备名称":"主机"}）', { type: 'text' })], async values => {
      const variables = JSON.parse(values.variables || '{}'), planned = await request('quickadd_plan', { choiceId: choice.id, path: values.path || undefined, variables });
      if (planned.exists && choice.type === 'Template') throw Error('模板目标已存在，请选择新路径以保留原笔记。');
      await afterChange(await request('quickadd', { choiceId: choice.id, path: planned.path, variables, expectedRevision: planned.expectedRevision }));
    }, { variables: choice.type === 'Capture' ? '{"value":""}' : '{}' }, '支持 Template / Capture。已有文件如提示冲突，请填写明确目标路径后重试。');
  }
  function settings() {
    const labels = { homepage: '主页路径', templatesFolder: '模板目录', dailyFolder: '日记目录', dailyFormat: '日记文件名格式', dailyTemplate: '日记模板', dateFormat: '日期格式', timeFormat: '时间格式' };
    ask('知识库设置', Object.entries(labels).map(([key, label]) => textField(key, label)), async values => { await request('settings_write', { values, expectedRevision: snapshot.settings.revision }); await reload(); }, Object.fromEntries(Object.keys(labels).map(k => [k, snapshot.settings[k]])), '这些设置仅覆盖 Forge 的行为，保留原 Obsidian 配置。');
  }
  function operations(action) {
    if (action === 'properties') ask('编辑笔记属性', [textField('values', '属性（JSON）', { type: 'text', rows: 10 })], async v => { const values = JSON.parse(v.values); return mutate('properties', { values, remove: Object.keys(doc.properties || {}).filter(k => !Object.hasOwn(values, k)) }); }, { values: JSON.stringify(doc.properties || {}, null, 2) });
    if (action === 'rename') ask('重命名文件', [textField('destination', '新路径', { required: true })], async v => { const result = await mutate('rename', v); if (result.referencesToUpdate.length) setNotice('需更新引用：' + result.referencesToUpdate.join('、')); }, { destination: selected }, '重命名后会列出需要更新的引用笔记。');
    if (action === 'trash') ask('移入回收站', [], async () => { requireClean(); await request('trash', { path: selected, expectedRevision: doc.revision }); savedDrafts.delete(currentKey); setDoc(null); setSelected(''); setDraft(''); await reload(); setNotice('已移入历史回收站，可在“历史”恢复'); }, {}, selected);
    if (action === 'table' || action === 'outline') {
      const options = action === 'table' ? ['format', 'add_row', 'remove_row', 'add_column', 'remove_column'] : ['indent', 'outdent', 'up', 'down'];
      const line = editor.current ? draft.slice(0, editor.current.selectionStart).split('\n').length : 1;
      ask(action === 'table' ? 'Advanced Tables · 表格操作' : 'Outliner · 列表分支操作', [textField('line', '起始行（从 1 开始）', { type: 'number' }), textField('action', '操作', { type: 'select', options }), ...(action === 'table' ? [textField('row', '表格行索引（从 0 开始；0 表头，1 分隔行）', { type: 'number' }), textField('column', '列索引（从 0 开始）', { type: 'number' }), textField('values', '新增单元格（JSON 数组）')] : [])], v => mutate(action, { line: Number(v.line) - 1, action: v.action, ...(action === 'table' ? { row: v.row === '' ? undefined : Number(v.row), column: v.column === '' ? undefined : Number(v.column), values: JSON.parse(v.values || '[]') } : {}) }), { line, action: options[0], row: '', column: '', values: '[]' });
    }
    if (action === 'query') ask('Dataview 查询', [textField('query', '查询语句', { type: 'text', rows: 8 })], async v => { setQueryResult(await request('query', { language: 'dataview', query: v.query, source: selected })); }, { query: 'TABLE file.mtime AS "修改时间"\nSORT file.mtime DESC\nLIMIT 20' });
    if (action === 'history') execute(async () => {
      const history = await request('history', { path: selected || undefined });
      if (!history.length) { setNotice('暂无历史或回收站记录'); return; }
      ask('恢复历史或已删除笔记', [textField('token', '记录', { type: 'select', options: history.map(h => [h.token, `${h.at} · ${h.kind} · ${h.path}`]) })], async v => { requireClean(); const record = history.find(x => x.token === v.token); const present = snapshot.files.some(f => f.path === record.path), latest = present ? await request('read', { path: record.path }) : null; await afterChange(await request('restore', { token: v.token, expectedRevision: latest?.revision || '' })); }, { token: history[0].token });
    });
  }
  const runSearch = (value = query) => execute(async () => { setQuery(value); setResults(await request('search', { query: value })); setTab('search'); });
  const goHome = () => snapshot.settings.homepage ? open(snapshot.settings.homepage) : setNotice('尚未设置主页，可在知识库设置中选择。');
  const close = () => { if ([...savedDrafts.keys()].length || dirty) ask('关闭笔记面板', [], () => { savedDrafts.clear(); onClose?.(); }, {}, '面板内有未保存草稿。关闭将丢弃这些草稿；可以取消后先保存。'); else onClose?.(); };
  return <main className={`ob-app ${mode}`}>
    <header className="ob-header"><span className="ob-logo">◈</span><div><strong>星枢 Nexus</strong><small>本地知识库</small></div><span className="ob-spacer"/><button aria-label="兼容性说明" onClick={() => setShowInfo(!showInfo)}>ⓘ</button><button aria-label="展开笔记面板" onClick={onMode}>⛶</button><button aria-label="关闭笔记面板" onClick={close}>×</button></header>
    <div className="ob-vault-bar"><select aria-label="选择知识库" value={vaultId} disabled={busy} onChange={e => setVaultId(e.target.value)}><option value="">选择知识库</option>{vaults.map(v => <option value={v.id} key={v.id}>{v.name}{v.available ? '' : '（离线）'}</option>)}</select><button disabled={busy} onClick={() => execute(async () => { const result = await api.request('nexus', { method: 'connect' }); if (result) { const list = await api.request('nexus', { method: 'vaults' }); setVaults(list.vaults); setVaultId(result.vault.id); } })}>连接目录</button>{vaultId && <button title="断开当前知识库，不删除文件" onClick={() => ask('断开知识库', [], async () => { const list = await request('disconnect'); setVaults(list); setVaultId(list[0]?.id || ''); }, {}, '断开后模型将无法访问此库；文件保留在原位置。')}>断开</button>}</div>
    {error && <div className="ob-error ob-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}{notice && <div className="ob-notice ob-banner" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    {showInfo && <section className="ob-compat"><h2>独立运行 · 兼容范围</h2><p>笔记保留在原目录。第三方插件以兼容实现运行，不执行知识库里的脚本。</p>{(snapshot?.compatibility || []).map(c => <details key={c.id}><summary>{c.name}{c.installed && ' · 已安装配置'}</summary><p>支持：{c.supported}</p><p>暂不支持：{c.unsupported}</p></details>)}<p>数据库支持 table/cards/list、筛选、公式和常用汇总子集。未知语法会报告错误。</p></section>}
    {!snapshot ? <div className="ob-empty"><span>◈</span><h2>{vaultId ? '正在读取知识库…' : '把知识库带进对话'}</h2><p>连接 Obsidian 知识库根目录，即可查看笔记、双向链接和图谱，并让模型帮助整理内容。</p><p>无需启动 Obsidian。不会自动运行社区插件脚本。</p></div> : <>
      <nav className="ob-tabs" aria-label="知识库功能">{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <div className="ob-actions"><button onClick={goHome}>⌂ 主页</button><button disabled={busy} onClick={() => execute(async () => afterChange(await request('daily', { expectedRevision: '' })))}>今日日记</button><button onClick={create}>＋ 新建</button><button onClick={() => execute(reload)}>刷新</button><button onClick={settings}>设置</button><button onClick={() => operations('history')}>历史</button><span className="ob-spacer"/><small>{snapshot.totals.notes} 篇 · {snapshot.totals.words.toLocaleString()} 字词</small></div>
      {snapshot.warnings.length > 0 && <details className="ob-warnings"><summary>索引提示（{snapshot.warnings.length}）</summary>{snapshot.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
      {tab === 'graph' ? <><div className="ob-actions"><label><input type="checkbox" checked={localGraph} onChange={e => setLocalGraph(e.target.checked)}/>当前笔记的局部图谱</label><small>点击节点打开笔记 · 滚轮缩放 · 拖动节点</small></div><Graph data={graph} open={p => { setTab('files'); open(p); }}/></> : <div className="ob-workspace">
        <aside className="ob-navigation">
          {tab === 'files' && <FileTree files={snapshot.files} selected={selected} open={open}/>}
          {tab === 'bases' && <><button onClick={() => ask('新建数据库', [textField('path', 'Base 文件路径', { required: true })], async v => afterChange(await request('write', { path: v.path, content: 'filters:\n  and:\n    - file.ext == "md"\nviews:\n  - type: table\n    name: 笔记列表\n    order:\n      - file.name\n      - file.mtime\n', expectedRevision: '' })), { path: '笔记数据库.base' })}>＋ 新建 Base</button><FileTree files={snapshot.files.filter(f => f.ext === 'base')} selected={selected} open={open}/></>}
          {tab === 'search' && <><div className="ob-search"><input aria-label="搜索笔记" onKeyDown={e => { if (e.key === "Enter") runSearch(); }} placeholder={'搜索或 tag:标签 path:目录'} value={query} onChange={e => setQuery(e.target.value)}/><button onClick={() => runSearch()}>搜索</button></div>{results && <small>{results.total} 个结果{results.truncated ? '（显示前 100 条）' : ''}</small>}{results?.results.map(n => <button className="ob-search-hit" key={n.path} onClick={() => open(n.path)}><strong>{n.name}</strong><small>{n.path}</small><p>{n.excerpt.slice(0, 100)}</p></button>)}</>}
          {tab === 'tags' && <div className="ob-tag-list">{tags.map(([tag, count]) => <button key={tag} onClick={() => runSearch('tag:' + tag)}>#{tag}<small>{count}</small></button>)}</div>}
          {tab === 'bookmarks' && <><button disabled={!selected} onClick={() => execute(addBookmark)}>收藏当前笔记</button><button onClick={() => ask('新建书签分组', [textField('title', '分组名称', { required: true })], async v => { const old = await request('bookmarks'); await request('bookmarks_write', { items: [...old.items, { type: 'group', title: v.title, items: [], ctime: Date.now() }], expectedRevision: old.revision }); setBookmarks(await request('bookmarks')); })}>新建分组</button><Bookmarks items={bookmarks?.items || []} open={open} search={runSearch} remove={indices => execute(() => removeBookmark(indices))}/></>}
          {tab === 'templates' && <>{templates.map(t => <div className="ob-template" key={t.path}><button className="ob-link" onClick={() => open(t.path)}>{t.path.split('/').at(-1)}</button><button onClick={() => insertTemplate(t.path)}>应用</button></div>)}{!templates.length && <p className="ob-muted">未找到模板，请在设置中指定模板目录。</p>}</>}
          {tab === 'quickadd' && <>{choices.map(c => <button className="ob-quick-choice" key={c.id} onClick={() => quickadd(c)}><strong>{c.label}</strong><small>{c.type}{c.supported ? '' : ' · 暂不支持'}</small></button>)}{!choices.length && <p className="ob-muted">未发现 QuickAdd 配置。</p>}</>}
        </aside>
        <section className="ob-content">
          {selected ? <><div className="ob-note-heading"><span title={selected}>{selected}</span><button aria-label="收藏笔记" onClick={() => execute(addBookmark)}>☆</button>{doc && <><button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>阅读</button><button className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')}>编辑</button><button className="ob-primary" disabled={!dirty || busy} onClick={save}>保存</button></>}</div>
            {doc && <div className="ob-note-tools">{[['properties', '属性'], ['table', '表格'], ['outline', '列表'], ['query', '查询'], ['rename', '重命名'], ['trash', '删除']].map(([action, label]) => <button key={action} disabled={busy || (['properties', 'table', 'outline'].includes(action) && !selected.endsWith('.md'))} onClick={() => operations(action)}>{label}</button>)}</div>}
            {remoteChanged && <div className="ob-conflict" role="alert">磁盘文件已改变，草稿已保留。<button onClick={() => execute(async () => { const latest = await request('read', { path: selected }); ask('合并笔记修改', [textField('disk', '磁盘中的新版本', { type: 'text', readOnly: true }), textField('merged', '合并后的内容（初始为你的草稿）', { type: 'text', rows: 12 })], async values => { await afterChange(await request('write', { path: selected, content: values.merged, expectedRevision: latest.revision })); setRemoteChanged(false); }, { disk: latest.content, merged: draft }); })}>查看并合并</button></div>}
            {queryResult && <section className="ob-query-panel"><button onClick={() => setQueryResult(null)}>关闭查询结果</button><QueryResult result={queryResult} request={request} onOpen={open}/></section>}
            {!doc ? <div className="ob-reading"><Attachment request={request} path={selected}/></div> : view === 'edit' ? <textarea ref={editor} className="ob-editor" aria-label="笔记 Markdown 编辑器" value={draft} readOnly={busy} onChange={e => setDraft(e.target.value)} spellCheck={false}/> : <div className="ob-reading">{selected.endsWith('.base') ? <QueryBlock request={request} language="base" query={draft} onOpen={open} source={selected} refresh={refresh}/> : selected.endsWith('.canvas') ? <pre>{draft}</pre> : <MarkdownView content={draft} source={selected} request={request} onOpen={open} onTask={task} tasks={doc.tasks || []} refresh={refresh}/>}</div>}
            {note && <div className="ob-metadata"><details open><summary>大纲 · {note.headings.length}</summary>{note.headings.map((h, i) => <button key={i} style={{ paddingLeft: h.level * 10 }} onClick={() => view === 'edit' ? (editor.current?.focus(), editor.current?.setSelectionRange(draft.split('\n').slice(0, h.line).join('\n').length + (h.line ? 1 : 0), draft.split('\n').slice(0, h.line).join('\n').length + (h.line ? 1 : 0))) : document.getElementById('heading-' + h.text)?.scrollIntoView({ block: 'start' })}>{h.text}</button>)}</details><details><summary>出链 · {note.links.length}</summary>{note.links.map((l, i) => <button key={i} className={!l.path ? 'ob-muted' : ''} onClick={() => open(l.target, selected)}>{l.target}{!l.path ? '（未解析）' : ''}</button>)}</details><details><summary>反向链接 · {note.backlinks.length}</summary>{note.backlinks.map(l => <button key={l.path} onClick={() => open(l.path)}>{l.path}</button>)}</details><details><summary>标签与属性</summary><p>{note.tags.map(t => <button key={t} onClick={() => runSearch('tag:' + t)}>#{t}</button>)}</p><pre>{JSON.stringify(note.properties, null, 2)}</pre></details></div>}
          </> : <div className="ob-empty"><span>▤</span><h2>选择一篇笔记</h2><p>浏览文件、搜索、标签和书签，或从主页开始。</p></div>}
        </section>
      </div>}
      <footer className="ob-footer"><span>{busy ? '处理中…' : dirty ? '有未保存草稿' : '本地文件 · 冲突保护'}{note && ` · ${note.stats.words} 字词 / ${note.stats.characters} 字符 · ${note.stats.completed}/${note.stats.tasks} 任务`}</span><span>Ctrl / ⌘ + S</span></footer>
    </>}
    {dialog && <Dialog key={dialog.title} spec={dialog} close={() => setDialog(null)} submit={dialog.run}/>}
  </main>;
}
