import React, { useCallback, useEffect, useRef, useState } from 'react';
import './collaboration.css';

const names = { claude: 'Claude Code', grok: 'Grok Build', dsh: 'DeepSeek Harness' };
const states = { queued: '排队中', running: '运行中', awaiting_approval: '等待审批', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const efforts = { off: '关闭', none: '无', minimal: '极低', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra' };
const active = status => status === 'queued' || status === 'running' || status === 'awaiting_approval';
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export function CollaborationIcon({ size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="m8 7 8 0M6 10l4.5 7m7.5-7-4.5 7" /><rect x="2" y="3" width="7" height="7" rx="2.5" /><rect x="15" y="3" width="7" height="7" rx="2.5" /><rect x="8.5" y="15" width="7" height="7" rx="2.5" /><path d="m10.7 18.5 1 1 1.8-2" /></svg>;
}
function Job({ job, request, refresh }) {
  const [open, setOpen] = useState(false), [events, setEvents] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const cursor = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    let disposed = false, timer;
    async function load() {
      try {
        const value = await request('read', { jobId: job.id, afterSeq: cursor.current });
        if (disposed) return;
        if (value.events.length) { cursor.current = value.nextSeq; setEvents(old => [...old, ...value.events]); }
        setError('');
        if (value.hasMore || active(value.status)) timer = setTimeout(load, value.hasMore ? 40 : 1000);
      } catch (failure) { if (!disposed) setError(message(failure)); }
    }
    load(); return () => { disposed = true; clearTimeout(timer); };
  }, [open, request, job.id, job.status]);
  async function cancel() {
    setBusy(true);
    try { await request('cancel', { jobId: job.id }); await refresh(); }
    catch (failure) { setError(message(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const text = events.filter(event => event.type === 'text').map(event => event.text).join('');
  const reasoning = events.filter(event => event.type === 'thinking').map(event => event.text).join('');
  const diagnostics = events.filter(event => !['text', 'thinking', 'final'].includes(event.type));
  return <details className="fast-collab-job" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className={`fast-collab-dot ${job.status}`} /><span className="fast-collab-job-name">{job.name || names[job.agent]}<small>{job.task.slice(0, 90)}</small></span><span className={`fast-collab-status ${job.status}`}>{states[job.status] || job.status}</span></summary>
    <div className="fast-collab-job-body"><div className="fast-collab-job-meta"><code title={job.id}>{job.id.slice(0, 12)}</code><span>{job.model || '本地默认模型'}</span>{active(job.status) && <button className="fast-collab-danger" disabled={busy} onClick={cancel}>{busy ? '正在取消…' : '取消任务'}</button>}</div>
      <details className="fast-collab-prompt"><summary>任务与工作目录</summary><pre>{job.task}</pre><code>{job.cwd}</code></details>
      {job.approval && <p role="status" className="fast-collab-muted">{job.approval.toolName} · {job.approval.reason}</p>}
      {job.finalText ? <pre className="fast-collab-output">{job.finalText}</pre> : text ? <pre className="fast-collab-output">{text}</pre> : <p className="fast-collab-muted">{active(job.status) ? '等待智能体输出…' : '没有文本输出'}</p>}
      {reasoning && <details className="fast-collab-reasoning"><summary>思考过程</summary><pre>{reasoning}</pre></details>}
      {diagnostics.length > 0 && <details className="fast-collab-diagnostics"><summary>工具与运行记录（{diagnostics.length}）</summary>{diagnostics.map(event => <pre key={event.seq}><span>{event.type === 'stderr' ? '诊断' : event.type === 'tool' ? '工具' : '提示'} · </span>{event.text}</pre>)}</details>}
      {(error || job.error) && <p role="alert" className="fast-collab-error">{error || job.error}</p>}{job.truncated && <p className="fast-collab-muted">过程输出超过保存上限，后续记录已截断。</p>}{job.finalTruncated && <p className="fast-collab-muted">最终文本超过保存上限，已保留前 1 MB；请查看智能体原生会话记录。</p>}
    </div>
  </details>;
}
export default function CollaborationPanel({ api, threadId, mode = 'right', onMode, onClose, settingsOnly = false }) {
  const [config, setConfig] = useState(null), [thread, setThread] = useState(null), [jobs, setJobs] = useState([]), [tab, setTab] = useState(settingsOnly ? 'settings' : 'jobs');
  const [probes, setProbes] = useState({}), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [capabilities, setCapabilities] = useState({}), [selectedAgents, setSelectedAgents] = useState(['claude']), [customModels, setCustomModels] = useState({});
  const activeThread = useRef(threadId), threadOperation = useRef(0); activeThread.current = threadId;
  const request = useCallback((method, args = {}) => api.request('collaboration', { method, args, threadId }), [api, threadId]);
  const refresh = useCallback(async () => {
    const [values, state] = await Promise.all([request('list'), request('thread')]); if (activeThread.current === threadId) { setJobs(values); setThread(state); }
  }, [request]);
  useEffect(() => {
    let disposed = false;
    threadOperation.current++; setBusy(''); setConfig(null); setJobs([]); setThread(null); setError('');
    request('bootstrap').then(value => { if (!disposed) { setConfig(value.config); setThread(value.thread); setJobs(value.jobs); setSelectedAgents(value.thread?.agents?.length ? value.thread.agents : ['claude']); } }).catch(failure => { if (!disposed) setError(message(failure)); });
    request('capabilities').then(value => { if (!disposed) setCapabilities(value.agents || {}); }).catch(failure => { if (!disposed) setError(message(failure)); });
    return () => { disposed = true; };
  }, [request]);
  useEffect(() => {
    if (!threadId) return;
    let disposed = false, pending = false;
    const update = async () => { if (pending) return; pending = true; try { const [values, state] = await Promise.all([request('list'), request('thread')]); if (!disposed) { setJobs(values); setThread(state); } } catch (failure) { if (!disposed) setError(message(failure)); } finally { pending = false; } };
    const timer = setInterval(update, 1600), unsubscribe = api.subscribe?.(update);
    return () => { disposed = true; clearInterval(timer); unsubscribe?.(); };
  }, [api, request, threadId]);
  useEffect(() => { if (thread?.enabled && thread.agents?.length) setSelectedAgents(thread.agents); }, [thread?.enabled, JSON.stringify(thread?.agents)]);
  function change(agent, key, value) { setConfig(previous => ({ ...previous, agents: { ...previous.agents, [agent]: { ...previous.agents[agent], [key]: value } } })); setNotice(''); }
  async function enable(enabled, agents = selectedAgents) {
    const operation = ++threadOperation.current;
    setBusy('thread'); setError('');
    try { const value = await request('set_thread', { enabled, agents }); if (operation !== threadOperation.current || activeThread.current !== threadId) return; setThread(value); setSelectedAgents(value.agents?.length ? value.agents : agents); setNotice(enabled ? '本对话的协作已开启' : '本对话的协作已关闭'); }
    catch (failure) { if (operation === threadOperation.current) setError(message(failure)); } finally { if (operation === threadOperation.current) setBusy(''); }
  }
  function selectAgent(agent, checked) {
    const next = checked ? [...new Set([...selectedAgents, agent])] : selectedAgents.filter(value => value !== agent);
    setSelectedAgents(next); if (thread?.enabled) enable(next.length > 0, next);
  }
  function selectModel(agent, value) {
    setCustomModels(previous => ({ ...previous, [agent]: value === '__custom' }));
    if (value !== '__custom') setConfig(previous => ({ ...previous, agents: { ...previous.agents, [agent]: { ...previous.agents[agent], model: value, reasoningEffort: '' } } }));
  }
  async function save() {
    setBusy('save'); setError('');
    try { const value = await request('configure', { concurrency: config.concurrency, agents: config.agents }); setConfig(value); setNotice('配置已保存'); }
    catch (failure) { setError(message(failure)); } finally { setBusy(''); }
  }
  async function detect(agent) {
    setBusy(agent); setError('');
    try {
      await request('configure', { concurrency: config.concurrency, agents: config.agents });
      const values = await request('probe', { agent }); setProbes(previous => ({ ...previous, [agent]: values[0] }));
      const capability = await request('capabilities', { agent }); setCapabilities(previous => ({ ...previous, ...capability.agents })); setNotice('已检查本地 CLI 版本与输出协议');
    } catch (failure) { setError(message(failure)); } finally { setBusy(''); }
  }
  return <main className="fast-collab" aria-label="智能体协作">
    <header className="fast-collab-header"><div><CollaborationIcon size={23} /><h1>智能体协作</h1></div><div>{onMode && <button onClick={() => onMode(mode === 'expanded' ? 'right' : 'expanded')} aria-label={mode === 'expanded' ? '恢复右侧栏' : '展开协作面板'}>{mode === 'expanded' ? '并排' : '展开'}</button>}<button onClick={onClose} aria-label="关闭协作面板">×</button></div></header>
    <div className={`fast-collab-authorization ${thread?.enabled ? 'enabled' : ''} ${thread?.authorizationPending ? 'pending' : ''}`}>
      <label className="fast-collab-toggle"><strong>{thread?.authorizationPending ? '等待 Codex 手动审批' : thread?.enabled ? '本对话已启用协作' : '本对话尚未启用协作'}</strong><input type="checkbox" role="switch" aria-label="开启本对话智能体协作" checked={!!thread?.enabled} disabled={!threadId || !!busy || !!thread?.authorizationPending || !selectedAgents.length} onChange={event => enable(event.target.checked)} /></label>
      <p>{thread?.authorizationPending ? '你已在提示词中明确请求启动协作；当前对话的 Codex 审批通过后会自动开启。' : !threadId ? '先打开一个对话，即可设置协作。也可以在输入框选择智能体直接发送。' : '默认关闭。可在这里开启，或在提示词中明确要求协作；每个对话独立设置。'}</p>
      <div className="fast-collab-participants" aria-label="参与协作的智能体">{Object.entries(names).map(([agent, name]) => <label key={agent}><input type="checkbox" aria-label={`允许 ${name} 协作`} checked={selectedAgents.includes(agent)} disabled={!!busy} onChange={event => selectAgent(agent, event.target.checked)} />{name}</label>)}</div>
    </div>
    <nav className="fast-collab-tabs" aria-label="协作面板页签">{!settingsOnly && <button onClick={() => api.request('forge',{method:'openSettings',args:{id:'forge.collaboration'}})}>连接配置</button>}<button aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')}>协作任务<span>{jobs.length}</span></button></nav>
    {error && <p role="alert" className="fast-collab-error">{error}</p>}{notice && <p role="status" className="fast-collab-notice">{notice}</p>}
    {tab === 'settings' ? <section className="fast-collab-settings"><p className="fast-collab-muted">直接使用各智能体已有的本地配置和登录。留空路径自动检测，留空模型沿用默认模型。</p>
      {config ? <fieldset className="fast-collab-fields" disabled={!!busy}><label className="fast-collab-concurrency">同时运行的任务<select aria-label="协作并发数" value={config.concurrency} onChange={event => setConfig(previous => ({ ...previous, concurrency: Number(event.target.value) }))}><option value="1">1（默认）</option><option value="2">2</option><option value="3">3</option></select></label>
        {Object.entries(names).map(([agent, name]) => <section className="fast-collab-agent" key={agent}><header><h2>{name}</h2><button onClick={() => detect(agent)} disabled={!!busy}>{busy === agent ? '检测中…' : '检测连接'}</button></header>
          <label>可执行文件路径<input aria-label={`${name} 可执行文件路径`} value={config.agents[agent].command} onChange={event => change(agent, 'command', event.target.value)} placeholder={`自动检测 ${agent}`} spellCheck="false" /></label>
          <label>模型<select aria-label={`${name} 模型`} value={customModels[agent] ? '__custom' : config.agents[agent].model || ''} onChange={event => selectModel(agent, event.target.value)}><option value="">沿用本地配置{capabilities[agent]?.defaultModel ? `（${capabilities[agent].defaultModel}）` : ''}</option>{(capabilities[agent]?.models || []).map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}{config.agents[agent].model && !(capabilities[agent]?.models || []).some(model => model.id === config.agents[agent].model) && <option value={config.agents[agent].model}>{config.agents[agent].model}</option>}<option value="__custom">自定义模型…</option></select></label>
          {customModels[agent] && <label>模型 ID<input aria-label={`${name} 自定义模型 ID`} value={config.agents[agent].model} onChange={event => change(agent, 'model', event.target.value)} placeholder="输入服务商支持的模型 ID" spellCheck="false" /></label>}
          <label>思考强度<select aria-label={`${name} 思考强度`} value={config.agents[agent].reasoningEffort || ''} onChange={event => change(agent, 'reasoningEffort', event.target.value)}><option value="">沿用本地配置</option>{(capabilities[agent]?.models?.find(model => model.id === (config.agents[agent].model || capabilities[agent]?.defaultModel))?.reasoningEfforts || capabilities[agent]?.reasoningEfforts || []).map(effort => <option key={effort} value={effort}>{efforts[effort] || effort}</option>)}</select></label>
          {agent !== 'dsh' ? <label>审批模式<select aria-label={`${name} 审批模式`} value={config.agents[agent].approvalMode || 'native'} onChange={event => change(agent, 'approvalMode', event.target.value)}><option value="native">沿用原生设置 → Codex → 人工</option><option value="auto">原生自动审批 → Codex → 人工</option><option value="codex">Codex 审批 → 人工</option></select><small>保存后对新任务生效；原生硬性禁止规则仍生效。</small></label> : <p className="fast-collab-muted">审批：Codex → 人工（默认）。使用 DSH 官方 ACP 通道逐项审批。</p>}
          {agent === 'dsh' && <><label>提供商 ID<input aria-label="DSH 提供商 ID" value={config.agents[agent].provider} onChange={event => change(agent, 'provider', event.target.value)} placeholder="覆盖模型时填写，例如 deepseek-official" spellCheck="false" /></label></>}
          {probes[agent] && <p className={probes[agent].available ? 'fast-collab-probe-ok' : 'fast-collab-error'}>{probes[agent].available ? `${probes[agent].version} · 本地协议可用` : probes[agent].error}{probes[agent].available && <small>生成服务未在检测中调用</small>}</p>}
        </section>)}<div className="fast-collab-save"><button disabled={!!busy} onClick={save}>{busy === 'save' ? '保存中…' : '保存配置'}</button><span className="fast-collab-muted">配置仅保存在 Forge 数据目录</span></div></fieldset> : <p className="fast-collab-muted">正在读取配置…</p>}
    </section> : <section className="fast-collab-jobs" aria-label="本对话协作任务">{!threadId ? <p className="fast-collab-empty">请先打开一个对话。</p> : jobs.length ? jobs.map(job => <Job key={`${threadId}:${job.id}`} job={job} request={request} refresh={refresh} />) : <div className="fast-collab-empty"><CollaborationIcon size={36} /><p>本对话还没有协作任务</p><small>智能体的输出会在本对话内显示，并可折叠。</small></div>}</section>}
  </main>;
}
