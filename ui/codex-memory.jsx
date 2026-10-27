import React, { useCallback, useEffect, useRef, useState } from 'react';
import './codex-memory.css';

const categories = [['all', '全部'], ['notes', '自定义备注'], ['core', '核心记忆'], ['summaries', '系统摘要'], ['history', '历史摘要'], ['skills', '技能说明']];
const icons = { notes: '✎', core: '▤', summaries: '▥', history: '◷', skills: '◇' };
const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const date = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const size = value => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;

export default function CodexMemoryPanel({ api, mode, onMode, onClose }) {
  const [catalog, setCatalog] = useState({ items: [], counts: {}, roots: [] });
  const [category, setCategory] = useState('all');
  const [root, setRoot] = useState('all');
  const [sort, setSort] = useState('modified');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [document, setDocument] = useState(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState('');
  const [name, setName] = useState('');
  const [limit, setLimit] = useState(100);
  const [draftCount, setDraftCount] = useState(0);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const drafts = useRef(new Map());
  const listRequest = useRef(0), readRequest = useRef(0), selectedRef = useRef('');
  selectedRef.current = selected;
  const dirty = Boolean(document && draft !== document.content);

  const refresh = useCallback(async () => {
    const sequence = ++listRequest.current;
    setLoading(true);
    try {
      const result = await api.request('memory', { method: 'catalog', args: { category, root, query: search, sort } });
      if (sequence !== listRequest.current) return;
      setCatalog(result);
    } catch (failure) { if (sequence === listRequest.current) setError(errorText(failure)); }
    finally { if (sequence === listRequest.current) setLoading(false); }
  }, [api, category, root, search, sort, catalogVersion]);

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 220); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setLimit(100); refresh(); return () => { listRequest.current += 1; }; }, [refresh]);
  useEffect(() => api.subscribe?.(event => { if (event?.type === 'refresh') refresh(); }), [api, refresh]);
  useEffect(() => {
    const sequence = ++readRequest.current;
    setError(''); setNotice(''); setForm('');
    const cached = drafts.current.get(selected);
    if (!selected || cached) {
      setDocument(cached?.document || null); setDraft(cached?.draft || ''); setReading(false);
      return () => { readRequest.current += 1; };
    }
    setDocument(null); setDraft(''); setReading(true);
    api.request('memory', { method: 'read', args: { id: selected } }).then(value => {
      if (sequence === readRequest.current) { setDocument(value); setDraft(value.content); }
    }).catch(failure => { if (sequence === readRequest.current) setError(errorText(failure)); })
      .finally(() => { if (sequence === readRequest.current) setReading(false); });
    return () => { readRequest.current += 1; };
  }, [api, selected]);
  useEffect(() => {
    const prevent = event => { if (drafts.current.size) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);

  function edit(value) {
    setDraft(value);
    if (value === document.content) drafts.current.delete(document.id);
    else drafts.current.set(document.id, { document, draft: value });
    setDraftCount(drafts.current.size);
  }
  function close() {
    if (drafts.current.size && !window.confirm(`还有 ${drafts.current.size} 份未保存草稿，关闭并放弃？`)) return;
    onClose?.();
  }
  async function save() {
    const target = document, content = draft;
    if (!target || !dirty || busy) return;
    setBusy(true); setError('');
    try {
      const saved = await api.request('memory', { method: 'write', args: { id: target.id, content, expectedHash: target.hash } });
      drafts.current.delete(target.id); setDraftCount(drafts.current.size);
      if (selectedRef.current === target.id) { setDocument(saved); setDraft(saved.content); setNotice('已保存到本机'); }
      await refresh();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  async function reload() {
    const id = selected;
    if (dirty && !window.confirm('放弃此文件的草稿，重新读取磁盘版本？')) return;
    setBusy(true);
    try {
      const value = await api.request('memory', { method: 'read', args: { id } });
      drafts.current.delete(id); setDraftCount(drafts.current.size);
      if (selectedRef.current === id) { setDocument(value); setDraft(value.content); setError(''); setNotice('已重新读取磁盘版本'); }
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    const target = document;
    setBusy(true); setError('');
    try {
      const created = await api.request('memory', { method: form === 'rename' ? 'rename' : 'create', args: form === 'rename' ? { id: target.id, name: name.trim(), expectedHash: target.hash } : { name: name.trim(), content: '' } });
      setSelected(created.id); setForm(''); setName('');
      if (form === 'create') { setQuery(''); setSearch(''); setCategory('notes'); setRoot('all'); }
      setCatalogVersion(value => value + 1);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  async function remove() {
    const target = document;
    if (!target?.deletable || busy || !window.confirm(`删除自定义备注“${target.name}”？${dirty ? '该文件的草稿也将丢弃。' : ''}此操作无法撤销。`)) return;
    setBusy(true); setError('');
    try {
      await api.request('memory', { method: 'delete', args: { id: target.id, expectedHash: target.hash } });
      drafts.current.delete(target.id); setDraftCount(drafts.current.size);
      if (selectedRef.current === target.id) setSelected('');
      await refresh();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  const items = catalog.items || [];
  return <main className={`codex-memory ${mode} ${selected ? 'cm-detail-open' : ''}`}>
    <header className="cm-topbar"><span className="cm-mark" aria-hidden="true">◈</span><strong>记忆管理</strong><small>LOCAL MEMORY</small><div className="cm-spacer" />{onMode && <button onClick={() => Promise.resolve().then(() => onMode()).catch(failure => setError(errorText(failure)))} aria-label="切换面板宽度">⛶</button>}{onClose && <button onClick={close} aria-label="关闭记忆管理">×</button>}</header>
    <div className="cm-summary"><div><strong>{catalog.total ?? '—'}</strong><span>本地文件</span></div><p>系统生成文件只读<br /><b>{draftCount ? `${draftCount} 份草稿待保存` : '自定义备注可编辑与重命名'}</b></p></div>
    <div className="cm-toolbar"><label className="cm-search"><span aria-hidden="true">⌕</span><input aria-label="搜索记忆" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、路径或正文" /></label><button className="cm-create-button" disabled={busy} onClick={() => { setForm(form === 'create' ? '' : 'create'); setName(''); }}>＋ 新建</button><button onClick={refresh} disabled={loading} aria-label="刷新记忆列表">↻</button></div>
    <div className="cm-filters"><select aria-label="记忆来源" value={root} onChange={event => setRoot(event.target.value)}><option value="all">全部来源</option>{catalog.roots.map(item => <option key={item.label} value={item.label}>{item.label}{item.preferred ? ' · 默认' : ''}{item.exists ? '' : ' · 未创建'}</option>)}</select><select aria-label="记忆排序" value={sort} onChange={event => setSort(event.target.value)}><option value="modified">最近修改</option><option value="name">按名称</option></select><span>{loading ? '正在检索…' : `${items.length} 项`}</span></div>
    <nav className="cm-categories" aria-label="记忆分类">{categories.map(([id, label]) => <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}<span>{catalog.counts[id] || 0}</span></button>)}</nav>
    {form && <form className="cm-create-form" onSubmit={submit}><label htmlFor="cm-name">{form === 'rename' ? '重命名备注' : '新建自定义备注'}</label><div><input id="cm-name" autoFocus maxLength={64} value={name} onChange={event => setName(event.target.value)} placeholder="例如：项目约定" /><button disabled={busy || !name.trim()}>{form === 'rename' ? '重命名' : '创建'}</button><button type="button" onClick={() => setForm('')}>取消</button></div><small>备注保存在 memories_v2/extensions/ad_hoc/notes/；由后续记忆整理处理。</small></form>}
    {error && <div className="cm-error" role="alert"><span>{error} {dirty && '草稿仍保留，可复制或重新读取磁盘版本。'}</span><button onClick={() => setError('')}>关闭</button></div>}
    {catalog.truncated && <p className="cm-notice">目录达到扫描上限，当前结果不完整。</p>}
    <div className="cm-layout">
      <nav className="cm-files" aria-label="记忆文件">{!items.length ? <div className="cm-empty"><strong>{loading ? '正在检索记忆…' : '没有匹配的记忆'}</strong><p>{query ? '试试其他关键词或来源。' : '创建一条备注，记录长期约定。'}</p></div> : items.slice(0, limit).map(item => <button key={item.id} className={`cm-file ${selected === item.id ? 'selected' : ''}`} onClick={() => setSelected(item.id)} aria-current={selected === item.id ? 'page' : undefined}><span className="cm-file-symbol" aria-hidden="true">{icons[item.category]}</span><span className="cm-file-copy"><strong>{item.name}{drafts.current.has(item.id) && <i title="未保存草稿"> ●</i>}</strong><small>{item.rootLabel} · {item.categoryLabel}</small><span>{item.preview || '空白记忆'}</span><small>{date(item.modifiedAt)} · {size(item.size)} · {item.editable ? '可编辑' : '只读'}</small></span></button>)}{items.length > limit && <button className="cm-load-more" onClick={() => setLimit(value => value + 100)}>再显示 100 项（剩余 {items.length - limit}）</button>}</nav>
      {reading ? <section className="cm-placeholder" role="status">正在读取记忆…</section> : document ? <section className="cm-editor" aria-label="记忆内容">
        <div className="cm-doc-heading"><button className="cm-back" onClick={() => setSelected('')}>‹ 文件列表</button><div><h1>{document.name}</h1><small>{document.id}</small></div><span className={document.editable ? 'cm-editable' : 'cm-readonly'}>{document.editable ? '可编辑' : '系统只读'}</span></div>
        <div className="cm-document-meta"><span>{date(document.modifiedAt)} · {size(document.size)}</span><div><button disabled={busy} onClick={reload}>重新读取</button>{document.deletable && <button disabled={busy || dirty} title={dirty ? '请先保存修改' : '重命名备注'} onClick={() => { setForm('rename'); setName(document.name); }}>重命名</button>}</div></div>
        {!document.editable && <p className="cm-readonly-note">此文件由 Codex 整理生成。需要补充或纠正时，请新建自定义备注。</p>}
        <textarea aria-label="记忆正文" value={draft} readOnly={!document.editable || busy} onChange={event => edit(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save(); } }} spellCheck={false} />
        <div className="cm-editor-footer"><span role="status">{busy ? '正在处理…' : dirty ? `${draft.length.toLocaleString()} 字符 · 草稿保留在面板中` : notice || `${draft.length.toLocaleString()} 字符 · 已同步`}</span><div>{document.deletable && <button className="cm-danger" disabled={busy} onClick={remove}>删除</button>}{document.editable && <button className="cm-save" disabled={busy || !dirty} onClick={save}>保存修改</button>}</div></div>
      </section> : <section className="cm-placeholder"><span aria-hidden="true">▤</span><strong>{error && selected ? '无法读取文件' : '你的本地记忆库'}</strong><p>选择文件查看正文。切换文件和筛选时保留未保存草稿。</p></section>}
    </div>
    <footer className="cm-footer"><span>本地 Markdown · 版本冲突保护</span><span>{draftCount ? `${draftCount} 份草稿` : 'Ctrl / ⌘ + S 保存'}</span></footer>
  </main>;
}
