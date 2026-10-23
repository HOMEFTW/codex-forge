import React, { useEffect, useRef, useState } from 'react';
import { TodoSession } from './todo-session.js';
import './workspace.css';
export default function TodosPanel({ api, threadId, mode, onMode, onClose }) {
  const [scope, setScope] = useState(threadId ? 'conversation' : 'personal'), [doc, setDoc] = useState(null), [title, setTitle] = useState(''), [filter, setFilter] = useState('active'), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [lastDeleted, setLastDeleted] = useState(null), [removing, setRemoving] = useState([]), [restoring, setRestoring] = useState(false);
  const session = useRef(null), removingIds = useRef(new Set());
  if (!session.current) session.current = new TodoSession({ api, onDocument: setDoc, onError: setError, onBusy: setBusy });
  const target = scope === 'personal' ? 'personal' : threadId;
  useEffect(() => {
    setLastDeleted(null); session.current.setTarget(target);
    return api.subscribe(value => { if (value.type === 'refresh') session.current.load(); });
  }, [target, api]);
  useEffect(() => () => session.current.dispose(), []);
  const apply = operations => session.current.mutate(operations);
  async function remove(id) {
    if (removingIds.current.has(id)) return;
    removingIds.current.add(id); setRemoving([...removingIds.current]);
    try {
      await session.current.mutate([{ op: 'remove', id }], (_next, before) => {
        const index = before.items.findIndex(item => item.id === id), item = before.items[index];
        if (item) setLastDeleted({ target, item, index, token: crypto.randomUUID() });
      });
    } finally { removingIds.current.delete(id); setRemoving([...removingIds.current]); }
  }
  async function restore() {
    const removed = lastDeleted;
    if (!removed || removed.target !== target || restoring) return;
    setRestoring(true);
    try {
      if (await session.current.mutate([{ op: 'restore', item: removed.item, index: removed.index }])) setLastDeleted(value => value?.token === removed.token ? null : value);
    } finally { setRestoring(false); }
  }
  const visible = doc?.items.filter(item => filter === 'all' || (filter === 'completed' ? item.status === 'completed' : item.status !== 'completed')) || [];
  async function add() {
    const text = title.trim();
    if (!text || !doc || session.current.pending) return;
    if (await apply([{ op: 'add', title: text }])) setTitle(value => value.trim() === text ? '' : value);
  }
  return <main className="fast-workspace"><header className="topbar"><strong>待办清单</strong><span className="badge">FAST r4</span><span className="spacer"/><button onClick={onMode} aria-label={mode === 'right' ? '展开面板' : '在右侧栏打开'}>{mode === 'right' ? '⛶' : '◧'}</button><button onClick={onClose} aria-label="关闭面板">×</button></header>
    <div className="workspace-body"><div className="workspace-controls"><select aria-label="待办范围" value={scope} onChange={e => setScope(e.target.value)}><option value="conversation" disabled={!threadId}>当前对话</option><option value="personal">个人清单</option></select><select aria-label="待办筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">未完成</option><option value="all">全部</option><option value="completed">已完成</option></select></div>
    <div className="todo-add"><input aria-label="新待办" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} maxLength={500} placeholder="添加一项待办…"/><button type="button" onClick={add} className="primary" disabled={!doc || !title.trim() || busy}>添加</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {lastDeleted?.target === target && <div className="todo-delete-notice" role="status"><span>已删除“{lastDeleted.item.title}”</span><button onClick={restore} disabled={restoring}>{restoring ? '恢复中…' : '撤销删除'}</button><button onClick={() => setLastDeleted(null)} aria-label="关闭待办删除提示">×</button></div>}
    <div className="todo-progress">{doc ? `${doc.items.filter(x => x.status === 'completed').length} / ${doc.items.length} 项已完成` : '加载中…'}</div>
    {!visible.length && doc && <div className="workspace-empty">{filter === 'completed' ? '还没有已完成的待办' : '清单已整理好，可以添加新任务'}</div>}
    <ul className="todo-list">{visible.map(item => <li key={item.id} className={item.status === 'completed' ? 'done' : ''}><input type="checkbox" aria-label={`完成：${item.title}`} checked={item.status === 'completed'} onChange={e => apply([{ op: 'update', id: item.id, status: e.target.checked ? 'completed' : 'pending' }])}/><div className="todo-content"><input aria-label="待办标题" key={item.id + item.title} defaultValue={item.title} maxLength={500} onBlur={e => { if (e.target.value !== item.title) apply([{ op: 'update', id: item.id, title: e.target.value }]); }}/><details><summary>备注</summary><textarea aria-label="待办备注" key={item.id + item.notes} defaultValue={item.notes} maxLength={10000} placeholder="补充说明…" onBlur={e => { if (e.target.value !== item.notes) apply([{ op: 'update', id: item.id, notes: e.target.value }]); }}/></details><select aria-label={`状态：${item.title}`} value={item.status} onChange={e => apply([{ op: 'update', id: item.id, status: e.target.value }])}><option value="pending">待办</option><option value="in_progress">进行中</option><option value="completed">已完成</option></select></div><button className="danger todo-delete" aria-label={`删除：${item.title}`} title="删除此待办" disabled={removing.includes(item.id)} onClick={() => remove(item.id)}>删除</button></li>)}</ul>
    </div><footer><span>{busy ? '正在保存…' : '自动保存 · 模型可读写'}</span><span className="muted">{doc ? `修订 ${doc.revision}` : ''}</span></footer></main>;
}
