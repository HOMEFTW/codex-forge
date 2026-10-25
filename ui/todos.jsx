import React, { useEffect, useRef, useState } from 'react';
import { TodoSession } from './todo-session.js';
import './workspace.css';
const columns = [
  { id: 'todo', label: '待办', statuses: new Set(['pending', 'todo', 'queued']) },
  { id: 'in_progress', label: '进行中', statuses: new Set(['in_progress', 'preparing', 'running']) },
  { id: 'attention', label: '需要关注', statuses: new Set(['awaiting_input', 'review', 'merging', 'blocked', 'failed']) },
  { id: 'done', label: '已完成', statuses: new Set(['completed', 'done', 'canceled']) },
];
const statusLabels = { pending: '待办', todo: '待办', queued: '排队中', in_progress: '进行中', preparing: '准备中', running: '运行中', awaiting_input: '等待输入', review: '待审阅', merging: '合并中', blocked: '阻塞', failed: '失败', completed: '已完成', done: '完成', canceled: '已取消' };
const columnFor = status => columns.find(column => column.statuses.has(status))?.id || 'todo';
const columnForItem = item => item.deferredUntil && Date.parse(item.deferredUntil) > Date.now() ? 'done' : columnFor(item.status);
const localDateValue = iso => { if (!iso) return ''; const date = new Date(iso); if (Number.isNaN(date.getTime())) return ''; const pad = value => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const isoFromLocal = value => value ? new Date(value).toISOString() : null;
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
  const grouped = columns.reduce((result, column) => { result[column.id] = (doc?.items || []).filter(item => columnForItem(item) === column.id); return result; }, {});
  const columnsToRender = columns.filter(column => filter === 'all' || (filter === 'completed' ? column.id === 'done' : filter === 'active' ? column.id !== 'done' : column.id === filter));
  async function move(item, direction) {
    if (!doc || session.current.pending) return;
    const order = doc.items.map(value => value.id), column = columnForItem(item), groupedIds = doc.items.filter(value => columnForItem(value) === column).map(value => value.id), index = groupedIds.indexOf(item.id), next = index + direction;
    if (index < 0 || next < 0 || next >= groupedIds.length) return;
    [groupedIds[index], groupedIds[next]] = [groupedIds[next], groupedIds[index]];
    const slots = order.map((id, position) => groupedIds.includes(id) ? position : -1).filter(position => position >= 0); slots.forEach((position, index) => { order[position] = groupedIds[index]; });
    await apply([{ op: 'reorder', order }]);
  }
  async function schedule(item, value) { await apply([{ op: 'update', id: item.id, scheduledAt: isoFromLocal(value), message: '调整计划时间' }]); }
  async function defer(item) { await apply([{ op: 'defer', id: item.id, until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }]); }
  async function retry(item) { await apply([{ op: 'retry', id: item.id }]); }
  async function add() {
    const text = title.trim();
    if (!text || !doc || session.current.pending) return;
    if (await apply([{ op: 'add', title: text }])) setTitle(value => value.trim() === text ? '' : value);
  }
  return <main className="fast-workspace"><header className="topbar"><strong>待办清单</strong><span className="badge">FAST r4</span><span className="spacer"/><button onClick={onMode} aria-label={mode === 'right' ? '展开面板' : '在右侧栏打开'}>{mode === 'right' ? '⛶' : '◧'}</button><button onClick={onClose} aria-label="关闭面板">×</button></header>
    <div className="workspace-body"><div className="workspace-controls"><select aria-label="待办范围" value={scope} onChange={e => setScope(e.target.value)}><option value="conversation" disabled={!threadId}>当前对话</option><option value="personal">个人清单</option></select><select aria-label="待办筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">未完成</option><option value="all">全部看板</option><option value="completed">已完成</option>{columns.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></div>
    <div className="todo-add"><input aria-label="新待办" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} maxLength={500} placeholder="添加一项待办…"/><button type="button" onClick={add} className="primary" disabled={!doc || !title.trim() || busy}>添加</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {lastDeleted?.target === target && <div className="todo-delete-notice" role="status"><span>已删除“{lastDeleted.item.title}”</span><button onClick={restore} disabled={restoring}>{restoring ? '恢复中…' : '撤销删除'}</button><button onClick={() => setLastDeleted(null)} aria-label="关闭待办删除提示">×</button></div>}
    <div className="todo-progress">{doc ? `${doc.items.filter(x => ['completed', 'done'].includes(x.status)).length} / ${doc.items.length} 项已完成` : '加载中…'}</div>
    {doc && columnsToRender.map(column => <section className={`todo-column ${column.id}`} key={column.id}><header><strong>{column.label}</strong><span>{grouped[column.id]?.length || 0}</span></header>{!grouped[column.id]?.length ? <div className="workspace-empty compact">暂无任务</div> : <ul className="todo-list">{grouped[column.id].map((item, position) => <li key={item.id} className={['completed', 'done', 'canceled'].includes(item.status) ? 'done' : ''}><input type="checkbox" aria-label={`完成：${item.title}`} checked={['completed', 'done'].includes(item.status)} onChange={e => apply([{ op: 'update', id: item.id, status: e.target.checked ? 'completed' : 'pending' }])}/><div className="todo-content"><input aria-label="待办标题" key={item.id + item.title} defaultValue={item.title} maxLength={500} onBlur={e => { if (e.target.value !== item.title) apply([{ op: 'update', id: item.id, title: e.target.value }]); }}/><details><summary>备注与记录</summary><textarea aria-label="待办备注" key={item.id + item.notes} defaultValue={item.notes} maxLength={10000} placeholder="补充说明…" onBlur={e => { if (e.target.value !== item.notes) apply([{ op: 'update', id: item.id, notes: e.target.value }]); }}/><div className="todo-events">{(item.events || []).slice().reverse().map((event, index) => <div key={`${event.at}-${index}`}><time>{event.at ? new Date(event.at).toLocaleString() : ''}</time><span>{event.actor || 'system'} · {event.action}{event.message ? ` · ${event.message}` : ''}</span></div>)}</div></details><div className="todo-item-controls"><select aria-label={`状态：${item.title}`} value={item.status} onChange={e => apply([{ op: 'update', id: item.id, status: e.target.value }])}>{Object.keys(statusLabels).map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select><input aria-label={`计划时间：${item.title}`} type="datetime-local" value={localDateValue(item.scheduledAt)} onChange={e => schedule(item, e.target.value)} /><button onClick={() => move(item, -1)} disabled={position === 0}>↑</button><button onClick={() => move(item, 1)} disabled={position === grouped[column.id].length - 1}>↓</button>{column.id === 'attention' && <button onClick={() => retry(item)}>重试</button>}{column.id !== 'done' && <button onClick={() => defer(item)}>延后</button>}</div></div><button className="danger todo-delete" aria-label={`删除：${item.title}`} title="删除此待办" disabled={removing.includes(item.id)} onClick={() => remove(item.id)}>删除</button></li>)}</ul>}</section>)}
    </div><footer><span>{busy ? '正在保存…' : '自动保存 · 模型可读写'}</span><span className="muted">{doc ? `修订 ${doc.revision}` : ''}</span></footer></main>;
}
