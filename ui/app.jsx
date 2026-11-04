import './bridge.js';
import ForgePanel from './forge.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import TodosPanel from './todos.jsx';
import CollaborationPanel from './collaboration.jsx';
import SkillsPanel from './skills.jsx';
import InformationStatsPanel from './information-stats.jsx';
import CodexMemoryPanel from './codex-memory.jsx';
import { CanvasHistory, canvasContent, canvasHistoryShortcut, isEditingTarget } from './canvas-history.js';
import { CanvasDraft } from './canvas-draft.js';

const api = window.fastCanvas;
function errorText(error) {
  const value = String(error?.message ?? error);
  return value.includes('Revision conflict') ? '画布已有新修改，本次操作未写入。草稿已保留，请核对后保存。' : value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
const uuid = () => crypto.randomUUID();
const labels = { text: '文字', sticky: '便签', image: '图片', file: '文件', group: '分组' };
function ImageAsset({ asset, title }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let active = true; setSrc(''); if (asset) api.request('asset', { asset }).then(value => { if (active) setSrc(value); }).catch(() => {}); return () => { active = false; }; }, [asset]);
  return src ? <img src={src} alt={title || '画布图片'} draggable={false} /> : <div className="image-placeholder">{asset ? '图片加载中…' : '未添加图片'}</div>;
}
function Card({ data, selected }) {
  const item = data.item;
  const members = (item.data.members || []).map(id => data.allItems?.find(value => value.id === id)).filter(Boolean);
  return <article className={`card ${item.type} ${item.data.color || 'neutral'} ${data.highlight ? 'model-change' : ''} ${selected ? 'selected' : ''}`} style={{ width: item.width, minHeight: item.height }}>
    <Handle type="target" position={Position.Left} />
    <div className="card-label"><span>{labels[item.type]}</span>{data.highlight && <small>模型修改</small>}</div>
    <strong>{item.data.title || labels[item.type]}</strong>
    {item.type === 'group' && <div className="group-members" style={item.data.gridColumns > 0 ? { gridTemplateColumns: `repeat(${item.data.gridColumns}, minmax(0, 1fr))` } : undefined}>{item.data.collapsed ? <span className="muted">已折叠 · {members.length} 个成员</span> : members.length ? members.slice(0, item.data.gridRows > 0 && item.data.gridColumns > 0 ? item.data.gridRows * item.data.gridColumns : members.length).map(member => <span key={member.id} className="group-member">{member.data.title || labels[member.type] || member.id}</span>) : <span className="muted">暂无成员</span>}</div>}
    {item.type === 'image' && <ImageAsset asset={item.data.asset} title={item.data.title} />}
    {item.type === 'file' && <div className="file-path">{item.data.filePath || '未选择文件'}</div>}
    {item.data.text && <p>{item.data.text}</p>}
    <Handle type="source" position={Position.Right} />
  </article>;
}
const nodeTypes = { card: Card };
function Editor({ node, revision, save, remove, reveal, register, disabled, locked }) {
  const [draft, setDraft] = useState(node.data), [status, setStatus] = useState('');
  const saveRef = useRef(save); saveRef.current = save;
  const controller = useRef(null);
  if (!controller.current) controller.current = new CanvasDraft({ value: node.data, revision, save: (data, base) => saveRef.current({ op: 'update_node', id: node.id, patch: { data } }, undefined, base), onChange: setDraft, onStatus: setStatus, errorText });
  useEffect(() => controller.current.context(node.data, revision), [node.data, revision]);
  useEffect(() => { const editor = controller.current, unregister = register(editor); return () => { unregister(); editor.dispose(); }; }, [register]);
  const change = (key, value) => controller.current.change(key, value);
  const memberIds = node.type === 'group' ? (draft.members || []) : [];
  const toggleMember = id => controller.current.change('members', memberIds.includes(id) ? memberIds.filter(value => value !== id) : [...memberIds, id]);
  return <section className="editor" aria-label="编辑节点">
    <fieldset className="canvas-editor-fields" disabled={locked}>
    <div className="editor-heading"><span>编辑{labels[node.type]}</span><code title="可在对话中引用此 ID">{node.id.slice(0, 12)}</code><button className="danger" onClick={remove} disabled={disabled} aria-label="删除节点">删除</button></div>
    <input aria-label="节点标题" value={draft.title || ''} maxLength={300} onChange={event => change('title', event.target.value)} placeholder="标题" />
    <textarea aria-label="节点内容" value={draft.text || ''} maxLength={100000} onChange={event => change('text', event.target.value)} placeholder="输入文字，自动保存…" />
    {node.type === 'group' && <div className="group-editor"><label><input type="checkbox" checked={!!draft.collapsed} onChange={event => change('collapsed', event.target.checked)} /> 折叠分组</label><label>列数 <input type="number" min="0" max="50" value={draft.gridColumns ?? 0} onChange={event => change('gridColumns', Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label><label>行数 <input type="number" min="0" max="50" value={draft.gridRows ?? 0} onChange={event => change('gridRows', Math.max(0, Math.min(50, Number(event.target.value) || 0)))} /></label><div className="group-member-picker"><span>成员</span>{(node.allItems || []).filter(item => item.id !== node.id && item.type !== 'group').map(item => <label key={item.id}><input type="checkbox" checked={memberIds.includes(item.id)} onChange={() => toggleMember(item.id)} /> {item.data.title || labels[item.type]}</label>)}</div></div>}
    <div className="editor-actions"><select aria-label="节点颜色" value={draft.color || 'neutral'} onChange={event => change('color', event.target.value)}><option value="neutral">默认</option><option value="yellow">暖黄</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="pink">粉色</option></select><span className="muted" role="status">{status}</span>{node.type === 'file' && <button onClick={reveal}>在文件夹中显示</button>}{controller.current.dirty && /未保存|画布已更新/.test(status) && <button onClick={() => controller.current.discard()}>放弃修改</button>}<button onClick={() => controller.current.flush(true).catch(() => {})}>保存</button></div>
    </fieldset>
  </section>;
}
function Notes({ notes, close }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return <main className="notes"><header><span className="eyebrow">部署包功能</span><button onClick={close} aria-label="关闭面板">×</button></header><h1>{notes.title}</h1><p>{notes.subtitle}</p>
    <div className="package-features">{(notes.features || []).map(feature => <section key={feature.title}><h2>{feature.title}</h2><p>{feature.description}</p></section>)}</div>
    <footer className="package-history"><button aria-expanded={historyOpen} aria-controls="package-release-history" onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? '收起升级日志' : '查看升级日志'} <span aria-hidden="true">{historyOpen ? '⌃' : '⌄'}</span></button>
      {historyOpen && <div id="package-release-history">{notes.releases.map(release => <section key={release.version}><span className="date">{release.date}</span><h2>{release.version}</h2><ul>{release.items.map(item => <li key={item}>{item}</li>)}</ul></section>)}</div>}
    </footer></main>;
}
function EdgeEditor({ edge, revision, save, remove, register, disabled, locked }) {
  const [draft, setDraft] = useState({ label: edge.label || '' }), [status, setStatus] = useState('');
  const saveRef = useRef(save), edgeRef = useRef(edge), controller = useRef(null); saveRef.current = save; edgeRef.current = edge;
  if (!controller.current) controller.current = new CanvasDraft({ value: { label: edge.label || '' }, revision, save: (patch, base) => saveRef.current({ op: 'upsert_edge', edge: { ...edgeRef.current, ...patch } }, undefined, base), onChange: setDraft, onStatus: setStatus, errorText });
  useEffect(() => controller.current.context({ label: edge.label || '' }, revision), [edge.label, revision]);
  useEffect(() => { const editor = controller.current, unregister = register(editor); return () => { unregister(); editor.dispose(); }; }, [register]);
  return <fieldset className="edge-editor" disabled={locked}><input aria-label="连线标签" value={draft.label} maxLength={500} placeholder="连线说明" onChange={event => controller.current.change('label', event.target.value)} /><span className="muted" role="status">{status}</span>{controller.current.dirty && /未保存|画布已更新/.test(status) && <button onClick={() => controller.current.discard()}>放弃修改</button>}<button onClick={() => controller.current.flush(true).catch(() => {})}>保存</button><button className="danger" onClick={remove} disabled={disabled}>删除连线</button></fieldset>;
}
function CanvasMetaEditor({ doc, save, disabled }) {
  const [draft, setDraft] = useState({ title: doc.title, description: doc.description || '', color: doc.color || 'neutral' });
  const [status, setStatus] = useState('');
  const controller = useRef(null), saveRef = useRef(save); saveRef.current = save;
  if (!controller.current) controller.current = new CanvasDraft({ value: draft, revision: doc.revision, save: (patch, revision) => saveRef.current({ op: 'set_metadata', ...patch }, undefined, revision), onChange: setDraft, onStatus: setStatus, errorText });
  useEffect(() => { controller.current.context({ title: doc.title, description: doc.description || '', color: doc.color || 'neutral' }, doc.revision); }, [doc.title, doc.description, doc.color, doc.revision]);
  useEffect(() => () => controller.current.dispose(), []);
  return <section className="canvas-meta" aria-label="画布信息"><div className="canvas-meta-heading"><span>画布信息</span><span className="muted" role="status">{status}</span></div><input aria-label="画布标题" value={draft.title || ''} maxLength={200} disabled={disabled} onChange={event => controller.current.change('title', event.target.value)} /><textarea aria-label="画布描述" value={draft.description || ''} maxLength={2000} disabled={disabled} onChange={event => controller.current.change('description', event.target.value)} placeholder="描述这张画布的用途…" /><div className="canvas-meta-actions"><select aria-label="画布颜色" value={draft.color || 'neutral'} disabled={disabled} onChange={event => controller.current.change('color', event.target.value)}><option value="neutral">默认颜色</option><option value="yellow">暖黄</option><option value="blue">蓝色</option><option value="green">绿色</option><option value="pink">粉色</option></select>{controller.current.dirty && <button onClick={() => controller.current.flush(true).catch(() => {})} disabled={disabled}>保存信息</button>}</div></section>;
}
function CanvasApp() {
  const [canvases, setCanvases] = useState([]), [doc, setDoc] = useState(null), [nodes, setNodes] = useState([]), [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null), [edgeId, setEdgeId] = useState(null), [mode, setMode] = useState('right'), [page, setPage] = useState('canvas'), [notes, setNotes] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(null), [threadId, setThreadId] = useState(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false }), [historyNotice, setHistoryNotice] = useState(''), [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null), [lastDeleted, setLastDeleted] = useState(null), [changingCanvas, setChangingCanvas] = useState(false);
  const current = useRef(null), operations = useRef(Promise.resolve()), pendingFocus = useRef(null), flow = useReactFlow();
  const history = useRef(new CanvasHistory()), editorRef = useRef(null), queued = useRef(0), destination = useRef(null), loadSequence = useRef(0), navigationSequence = useRef(0), selectionSequence = useRef(0);
  const updateHistory = useCallback(() => setHistoryState(history.current.state()), []);
  const historyInvalidated = useCallback(() => setHistoryNotice('检测到模型或其他窗口的新修改，撤销历史已重置。'), []);
  const registerEditor = useCallback(editor => { editorRef.current = editor; return () => { if (editorRef.current === editor) editorRef.current = null; }; }, []);
  const clearCanvasView = useCallback(() => {
    ++loadSequence.current; ++selectionSequence.current; editorRef.current?.dispose(); editorRef.current = null;
    current.current = null; destination.current = null; pendingFocus.current = null; history.current = new CanvasHistory();
    setDoc(null); setNodes([]); setEdges([]); setSelected(null); setEdgeId(null); setNotice(null); setHistoryNotice(''); setDeleteConfirm(null); updateHistory();
  }, [updateHistory]);
  async function flushEditor() {
    try { await editorRef.current?.flush(); await operations.current.catch(() => {}); return true; }
    catch (failure) { setError(errorText(failure)); return false; }
  }
  const sync = useCallback(value => {
    if (current.current?.id === value.id && current.current.revision > value.revision) return;
    const changedCanvas = current.current?.id !== value.id;
    if (history.current.observe(value)) historyInvalidated(); updateHistory();
    current.current = value; setDoc(value);
    const highlights = new Set(value.lastChange?.source === 'model' ? value.lastChange.nodeIds : []);
    setNodes(old => value.nodes.map(item => ({ id: item.id, type: 'card', position: { x: item.x, y: item.y }, data: { item, allItems: value.nodes, highlight: highlights.has(item.id) }, selected: !changedCanvas && old.some(node => node.id === item.id && node.selected), style: { width: item.width }, width: item.width, height: item.height })));
    setEdges(value.edges.map(edge => ({ ...edge, type: 'smoothstep', markerEnd: { type: 'arrowclosed' }, selected: !changedCanvas && edge.id === edgeId })));
    if (changedCanvas) { setSelected(null); setEdgeId(null); setNotice(null); setHistoryNotice(''); setDeleteConfirm(null); setTimeout(() => flow.fitView({ padding: .25, duration: 250, maxZoom: 1 }), 100); }
    if (value.lastChange?.source === 'model') setNotice(value.lastChange);
  }, [flow, edgeId, historyInvalidated, updateHistory]);
  const syncRef = useRef(sync); syncRef.current = sync;
  async function load(canvasId, activate = false) {
    if (activate) destination.current = canvasId;
    if (destination.current !== canvasId) return;
    const sequence = ++loadSequence.current;
    if (activate) setLoading(true);
    try {
      const value = await api.request('read', { canvasId });
      if (sequence !== loadSequence.current || destination.current !== canvasId) return;
      syncRef.current(value); setError('');
    } catch (failure) { if (sequence === loadSequence.current) { destination.current = current.current?.id || null; setError(errorText(failure)); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  async function chooseCanvas(canvasId) {
    const sequence = ++navigationSequence.current;
    if (!await flushEditor() || sequence !== navigationSequence.current) return;
    await load(canvasId, true);
  }
  async function reconcileRemovedCanvas(canvasId, values) {
    setCanvases(values);
    if (current.current?.id !== canvasId && destination.current !== canvasId) return;
    if (destination.current && destination.current !== canvasId) return;
    clearCanvasView();
    if (values.length) await load(values[0].id, true);
    else setLoading(false);
  }
  async function refreshCanvasList(changedId) {
    const canvasId = current.current?.id, navigation = navigationSequence.current;
    const values = await api.request('list');
    if (navigation !== navigationSequence.current) return;
    setCanvases(values);
    if (canvasId && current.current?.id === canvasId && !values.some(value => value.id === canvasId)) {
      await reconcileRemovedCanvas(canvasId, values); return;
    }
    if (canvasId && (!changedId || changedId === canvasId)) await load(canvasId);
    else if (!current.current && !destination.current && values.length) await load(values[0].id, true);
  }
  const commit = useCallback((ops, message, expectedRevision, explicitCanvasId, action = 'edit') => {
    const canvasId = explicitCanvasId || current.current?.id;
    queued.current++; setBusy(true);
    const work = operations.current.catch(() => {}).then(async () => {
      let token;
      try {
        const before = current.current;
        if (!before || before.id !== canvasId || destination.current !== canvasId) throw new Error('画布已切换，请重新编辑');
        token = history.current.begin(before, action); updateHistory();
        if (!token) return before;
        const changes = action === 'edit' ? (typeof ops === 'function' ? ops(before) : ops) : [{ op: 'replace_content', content: token.target }];
        const result = await api.request('apply', { canvasId, expectedRevision: expectedRevision ?? before.revision, operations: Array.isArray(changes) ? changes : [changes], message });
        if (!history.current.complete(token, result) && current.current?.id === canvasId) historyInvalidated();
        if (current.current?.id === canvasId) syncRef.current(result); setError(''); return result;
      } catch (failure) {
        setError(errorText(failure));
        try {
          const latest = await api.request('read', { canvasId });
          if (token && history.current.fail(token, latest)) historyInvalidated();
          if (current.current?.id === canvasId && destination.current === canvasId) syncRef.current(latest);
        } catch { if (token) history.current.fail(token); }
        throw failure;
      } finally { queued.current--; setBusy(queued.current > 0); updateHistory(); }
    });
    operations.current = work; return work;
  }, [historyInvalidated, updateHistory]);
  useEffect(() => {
    const initialNavigation = navigationSequence.current;
    api.request('bootstrap').then(async value => {
      setCanvases(value.canvases); setNotes(value.notes);
      if (initialNavigation !== navigationSequence.current) return;
      setMode(value.panel?.mode || 'right'); setPage(value.panel?.page || 'canvas');
      setThreadId(value.threadId || null);
      const id = value.panel?.canvasId || value.canvases[0]?.id;
      if (id) await load(id, true);
    }).catch(failure => setError(errorText(failure)));
    return api.subscribe(value => {
      if (value.type === 'open') {
        const sequence = ++navigationSequence.current;
        flushEditor().then(async ok => {
          if (!ok || sequence !== navigationSequence.current) return;
          setMode(value.mode || 'right'); setPage(value.page || 'canvas'); setThreadId(value.threadId || null);
          if (value.nodeIds?.length) pendingFocus.current = value.nodeIds;
          if (value.canvasId) await load(value.canvasId, true);
        });
      }
      if (value.type === 'refresh') {
        refreshCanvasList(value.canvasId).catch(failure => setError(errorText(failure)));
      }
      if (value.type === 'context') setThreadId(value.threadId || null);
      if (value.type === 'mode') setMode(value.mode || 'right');
    });
  }, []);
  useEffect(() => {
    if (pendingFocus.current && nodes.length) {
      const ids = pendingFocus.current; pendingFocus.current = null;
      setTimeout(() => flow.fitView({ nodes: ids.map(id => ({ id })), padding: .4, duration: 300, maxZoom: 1.15 }), 100);
    }
  }, [nodes, flow]);
  async function createCanvas() {
    const sequence = ++navigationSequence.current;
    if (!await flushEditor() || sequence !== navigationSequence.current) return;
    try {
      const value = await api.request('create', { title: `画布 ${canvases.length + 1}` });
      if (sequence !== navigationSequence.current) { setCanvases(await api.request('list')); return; }
      ++loadSequence.current; destination.current = value.id; setLoading(false); syncRef.current(value); setCanvases(await api.request('list'));
    }
    catch (failure) { setError(errorText(failure)); }
  }
  async function addNode(type) {
    const canvasId = current.current?.id;
    if (deleteConfirm || !canvasId || !await flushEditor() || current.current?.id !== canvasId) return;
    try {
      let data = { title: type === 'sticky' ? '新便签' : `新${labels[type]}`, text: '', color: type === 'sticky' ? 'yellow' : 'neutral' };
      if (type === 'group') data = { title: '新分组', text: '', color: 'blue', members: [], collapsed: false, gridColumns: 0, gridRows: 0 };
      if (type === 'image' || type === 'file') { const attachment = await api.request('attach', { kind: type }); if (!attachment) return; data = { ...data, ...attachment }; }
      const position = flow.screenToFlowPosition({ x: innerWidth / 2 - 120, y: Math.min(innerHeight / 2, 330) });
      const item = { id: uuid(), type, x: Math.round(position.x), y: Math.round(position.y), width: type === 'image' ? 300 : 260, height: type === 'image' ? 260 : 180, data };
      await commit({ op: 'upsert_node', node: item }, undefined, undefined, canvasId); setSelected(item.id); setEdgeId(null);
    } catch (failure) { setError(errorText(failure)); }
  }
  function onNodesChange(changes) { setNodes(old => applyNodeChanges(changes.filter(change => change.type !== 'remove'), old)); }
  function onEdgesChange(changes) { setEdges(old => applyEdgeChanges(changes.filter(change => change.type !== 'remove'), old)); }
  async function selectItem(nodeId, selectedEdgeId) {
    const sequence = ++selectionSequence.current, canvasId = current.current?.id;
    if (!await flushEditor() || sequence !== selectionSequence.current || current.current?.id !== canvasId) return;
    setSelected(nodeId); setEdgeId(selectedEdgeId);
  }
  async function saveMovement(moved) {
    const canvasId = current.current?.id;
    if (!await flushEditor() || current.current?.id !== canvasId) { if (current.current) syncRef.current(current.current); return; }
    await commit(moved.map(node => ({ op: 'update_node', id: node.id, patch: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })), undefined, undefined, canvasId).catch(() => {});
  }
  async function connectNodes(connection) {
    const canvasId = current.current?.id;
    if (deleteConfirm || !await flushEditor() || current.current?.id !== canvasId) return;
    await commit({ op: 'upsert_edge', edge: { id: uuid(), source: connection.source, target: connection.target, label: '' } }, undefined, undefined, canvasId).catch(() => {});
  }
  const selectedNodeIds = nodes.filter(node => node.selected).map(node => node.id), selectedEdgeIds = edges.filter(edge => edge.selected).map(edge => edge.id);
  if (selected && !selectedNodeIds.includes(selected)) selectedNodeIds.push(selected);
  if (edgeId && !selectedEdgeIds.includes(edgeId)) selectedEdgeIds.push(edgeId);
  async function deleteItems(nodeIds, edgeIds) {
    if (deleteConfirm || queued.current || destination.current !== current.current?.id || (!nodeIds.length && !edgeIds.length)) return;
    editorRef.current?.discard();
    const removedNodes = new Set(nodeIds), removedEdges = new Set(edgeIds);
    try {
      await commit(before => ({ op: 'replace_content', content: { ...canvasContent(before), nodes: before.nodes.filter(node => !removedNodes.has(node.id)), edges: before.edges.filter(edge => !removedEdges.has(edge.id) && !removedNodes.has(edge.source) && !removedNodes.has(edge.target)) } }), '删除所选内容');
      setSelected(null); setEdgeId(null);
    } catch { /* The current document and draft remain visible on failure. */ }
  }
  async function travelHistory(action) {
    const canvasId = current.current?.id;
    if (deleteConfirm || queued.current || destination.current !== canvasId || !await flushEditor() || current.current?.id !== canvasId) return;
    await commit(null, action === 'undo' ? '撤销画布修改' : '重做画布修改', undefined, canvasId, action).catch(() => {});
  }
  async function beginDeleteCanvas() {
    const canvasId = current.current?.id;
    if (!canvasId || queued.current || !await flushEditor() || current.current?.id !== canvasId) return;
    setDeleteConfirm({ id: canvasId, title: current.current.title, revision: current.current.revision });
  }
  async function deleteCanvas() {
    const confirmed = deleteConfirm;
    if (!confirmed || queued.current || current.current?.id !== confirmed.id) return;
    if (current.current.revision !== confirmed.revision || editorRef.current?.dirty) { setDeleteConfirm(null); setError('画布有新修改，请核对后重新确认删除。'); return; }
    queued.current++; setBusy(true); setChangingCanvas(true);
    const work = operations.current.catch(() => {}).then(async () => {
      try {
        const result = await api.request('delete', { canvasId: confirmed.id, expectedRevision: confirmed.revision });
        setLastDeleted({ restoreToken: result.restoreToken, title: confirmed.title }); setDeleteConfirm(null); setError('');
        await reconcileRemovedCanvas(confirmed.id, result.canvases || await api.request('list'));
      } catch (failure) { setDeleteConfirm(null); setError(errorText(failure)); await refreshCanvasList().catch(() => {}); }
      finally { queued.current--; setBusy(queued.current > 0); setChangingCanvas(false); updateHistory(); }
    });
    operations.current = work; await work;
  }
  async function restoreCanvas() {
    const removed = lastDeleted;
    if (!removed?.restoreToken || queued.current || !await flushEditor()) return;
    queued.current++; setBusy(true); setChangingCanvas(true);
    const work = operations.current.catch(() => {}).then(async () => {
      try {
        const result = await api.request('restore', { restoreToken: removed.restoreToken });
        ++loadSequence.current; destination.current = result.canvas.id; setDeleteConfirm(null); setCanvases(result.canvases); syncRef.current(result.canvas); setError('');
        setLastDeleted(value => value?.restoreToken === removed.restoreToken ? null : value);
      } catch (failure) { setError(errorText(failure)); await refreshCanvasList().catch(() => {}); }
      finally { queued.current--; setBusy(queued.current > 0); setChangingCanvas(false); updateHistory(); }
    });
    operations.current = work; await work;
  }
  const actionsRef = useRef(null); actionsRef.current = { travelHistory, deleteItems: () => deleteItems(selectedNodeIds, selectedEdgeIds) };
  useEffect(() => {
    if (page !== 'canvas') return;
    const keydown = event => {
      const action = canvasHistoryShortcut(event);
      if (action) { event.preventDefault(); actionsRef.current.travelHistory(action); }
      else if (!event.defaultPrevented && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditingTarget(event.target) && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); actionsRef.current.deleteItems(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [page]);
  const selectedNode = doc?.nodes.find(node => node.id === selected);
  const blocked = busy || loading || !!deleteConfirm;
  const close = async () => { if (await flushEditor()) api.request('close').catch(failure => setError(errorText(failure))); };
  const onMode = async () => { const value = await api.request('mode', { mode: mode === 'right' ? 'expanded' : 'right' }); setMode(value.mode); };
  const panelProps = { api, threadId, mode, onMode, onClose: close };
  if (page.startsWith('forge-')) return <ForgePanel api={api} page={page} onClose={close}/>;
  if (page === 'todos') return <TodosPanel key={threadId || 'personal'} {...panelProps}/>;
  if (page === 'collaboration') return <CollaborationPanel key={threadId || 'settings'} {...panelProps}/>;
  if (page === 'skills') return <SkillsPanel {...panelProps}/>;
  if (page === 'information-stats') return <InformationStatsPanel key={threadId || 'global'} {...panelProps}/>;
  if (page === 'codex-memory') return <CodexMemoryPanel {...panelProps}/>;
  if (page === 'updates' && notes) return <Notes notes={notes} close={close} />;
  return <main className={`canvas-app ${mode}`}>
    <header className="topbar"><span className="canvas-symbol">▧</span><strong>无限画布</strong><span className="badge">Forge</span><div className="spacer"/><button onClick={onMode} title={mode === 'right' ? '展开画布' : '在右侧栏打开'} aria-label={mode === 'right' ? '展开画布' : '在右侧栏打开'}>{mode === 'right' ? '⛶' : '◧'}</button><button onClick={close} aria-label="关闭面板">×</button></header>
    <div className="canvas-picker"><select aria-label="选择画布" value={doc?.id || ''} disabled={blocked} onChange={event => chooseCanvas(event.target.value)}><option value="" disabled>选择画布</option>{canvases.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select><button onClick={createCanvas} disabled={blocked}>新建画布</button>{doc && <button className="danger" aria-label="删除当前画布" onClick={beginDeleteCanvas} disabled={blocked}>删除画布</button>}</div>
    <div className="canvas-preview-list" aria-label="画布预览">{canvases.map(value => <button key={value.id} className={`canvas-preview ${doc?.id === value.id ? 'active' : ''}`} onClick={() => chooseCanvas(value.id)} disabled={blocked}><span className={`canvas-swatch ${value.color || 'neutral'}`} /><span className="canvas-preview-copy"><strong>{value.title}</strong><small>{value.description || '暂无描述'} · {value.nodes || 0} 个节点{value.groups ? ` · ${value.groups} 个分组` : ''}</small></span><span className="canvas-thumbnail">{(value.preview || []).slice(0, 8).map(rect => <i key={rect.id} className={rect.type} style={{ left: `${Math.max(0, Math.min(86, rect.x / 12))}%`, top: `${Math.max(0, Math.min(72, rect.y / 12))}%`, width: `${Math.max(8, Math.min(44, rect.width / 12))}%`, height: `${Math.max(8, Math.min(30, rect.height / 12))}%` }} />)}</span></button>)}</div>
    {doc && <CanvasMetaEditor doc={doc} disabled={blocked} save={(ops, message, revision) => commit(ops, message, revision, doc.id)} />}
    {deleteConfirm && <div className="canvas-delete-confirm" role="alertdialog" aria-label="确认删除画布"><strong>删除“{deleteConfirm.title}”？</strong><p>所有节点和连线将一起移入回收站，可撤销删除。</p>{doc?.revision !== deleteConfirm.revision && <p>画布已有新修改，请取消后重新确认。</p>}<div><button onClick={() => setDeleteConfirm(null)} disabled={busy}>取消</button><button className="danger" aria-label="确认删除画布" onClick={deleteCanvas} disabled={busy || doc?.revision !== deleteConfirm.revision}>确认删除</button></div></div>}
    {lastDeleted && <div className="canvas-delete-notice" role="status"><span>已删除“{lastDeleted.title}”</span><button onClick={restoreCanvas} disabled={blocked}>撤销删除</button><button onClick={() => setLastDeleted(null)} aria-label="关闭画布删除提示">×</button></div>}
    {doc && <div className="tools">{Object.keys(labels).map(type => <button key={type} onClick={() => addNode(type)} disabled={blocked}>＋{labels[type]}</button>)}<div className="spacer"/><button aria-label="撤销画布修改" onClick={() => travelHistory('undo')} disabled={blocked || !historyState.canUndo} title="撤销（Ctrl/Cmd+Z；文字输入框使用文字撤销）">↶ 撤销</button><button aria-label="重做画布修改" onClick={() => travelHistory('redo')} disabled={blocked || !historyState.canRedo} title="重做（Ctrl+Y / Ctrl/Cmd+Shift+Z）">↷ 重做</button><button aria-label="删除所选内容" onClick={() => deleteItems(selectedNodeIds, selectedEdgeIds)} disabled={blocked || (!selectedNodeIds.length && !selectedEdgeIds.length)} title="删除所选节点和连线（Delete）">删除</button><button onClick={() => flow.fitView({ padding: .25, duration: 200, maxZoom: 1 })} title="显示全部节点">适应</button></div>}
    {historyNotice && <div className="history-notice" role="status"><span>{historyNotice}</span><button onClick={() => setHistoryNotice('')} aria-label="关闭撤销历史提示">×</button></div>}
    {error && <div role="alert" className="error"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
    {notice && doc && <div className="model-notice"><span>{notice.message || '模型已更新画布'}</span><button onClick={() => flow.fitView({ nodes: notice.nodeIds.map(id => ({ id })), padding: .35, duration: 250, maxZoom: 1.1 })}>定位修改</button><button onClick={() => setNotice(null)} aria-label="关闭修改提示">×</button></div>}
    <div className="flow-container">
      {!doc ? <div className="empty"><div className="empty-icon">▧</div><h2>让想法在这里连接</h2><p>添加文字、便签和文件。<br/>对模型说“帮我编辑无限画布”，即可协作。</p><button className="primary" onClick={createCanvas} disabled={blocked}>创建第一张画布</button></div> : <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_event, node) => selectItem(node.id, null)} onEdgeClick={(_event, edge) => selectItem(null, edge.id)} onPaneClick={() => selectItem(null, null)} onNodeDragStop={(_event, node, moved) => saveMovement(moved?.length ? moved : [node])} onConnect={connectNodes} nodesDraggable={!blocked} nodesConnectable={!blocked} deleteKeyCode={null} minZoom={.08} maxZoom={2.5} fitView attributionPosition="bottom-right"><Background gap={22} size={1} color="#c5cbd0"/><Controls showInteractive={false}/></ReactFlow>}
    </div>
    {selectedNode && <Editor key={doc.id + selectedNode.id} node={{ ...selectedNode, allItems: doc.nodes }} revision={doc.revision} register={registerEditor} disabled={blocked} locked={loading || changingCanvas || !!deleteConfirm} save={(ops, message, revision) => commit(ops, message, revision, doc.id)} remove={() => deleteItems([selectedNode.id], [])} reveal={() => api.request('reveal', { canvasId: doc.id, nodeId: selectedNode.id }).catch(failure => setError(errorText(failure)))} />}
    {edgeId && doc?.edges.some(edge => edge.id === edgeId) && <EdgeEditor key={doc.id + edgeId} edge={doc.edges.find(edge => edge.id === edgeId)} revision={doc.revision} register={registerEditor} disabled={blocked} locked={loading || changingCanvas || !!deleteConfirm} save={(ops, message, revision) => commit(ops, message, revision, doc.id)} remove={() => deleteItems([], [edgeId])} />}
    <footer><span>{loading ? '正在打开…' : busy ? '正在保存…' : doc ? `已保存 · 修订 ${doc.revision}` : '本地画布'}</span><span className="muted">{doc ? `${doc.nodes.length} 个节点 · ${doc.edges.length} 条连线` : '自动保存 · 模型可编辑'}</span><button onClick={() => api.request('data-folder')}>数据目录</button></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<ReactFlowProvider><CanvasApp/></ReactFlowProvider>);
