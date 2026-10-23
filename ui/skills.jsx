import React, { useCallback, useEffect, useRef, useState } from 'react';
import './skills.css';

const agents = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', dsh: 'DSH' };
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export default function SkillsPanel({ api, mode, onMode, onClose }) {
  const [data, setData] = useState(null), [query, setQuery] = useState(''), [pack, setPack] = useState(''), [agent, setAgent] = useState('codex');
  const [selected, setSelected] = useState(''), [resource, setResource] = useState('SKILL.md'), [resources, setResources] = useState([]), [preview, setPreview] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [enabledOnly, setEnabledOnly] = useState(false);
  const generation = useRef(0), previewGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await api.request('skills_list', { query, pack, agent, enabledOnly });
      if (request !== generation.current) return;
      setData(next); setSelected(current => next.skills.some(skill => skill.id === current) ? current : next.skills[0]?.id || ''); setError('');
    } catch (failure) { if (request === generation.current) setError(message(failure)); }
  }, [api, query, pack, agent, enabledOnly]);
  useEffect(() => { refresh(); return () => { generation.current += 1; }; }, [refresh]);
  useEffect(() => api.subscribe?.(event => { if (event?.type === 'skills' || event?.type === 'skills-changed') refresh(); }), [api, refresh]);
  useEffect(() => { setResource('SKILL.md'); setPreview(null); setResources([]); }, [selected, agent]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    api.request('skills_files', { id: selected, agent, requireEnabled: false }).then(next => { if (current) setResources(next.files); }).catch(failure => { if (current) setError(message(failure)); });
    return () => { current = false; };
  }, [api, selected, agent]);
  useEffect(() => {
    const request = ++previewGeneration.current;
    setPreview(null);
    if (!selected) { setReading(false); return; }
    setReading(true);
    api.request('skills_read', { id: selected, path: resource, agent, requireEnabled: false, limit: 30000 }).then(next => { if (request === previewGeneration.current) setPreview(next); }).catch(failure => { if (request === previewGeneration.current) setError(message(failure)); }).finally(() => { if (request === previewGeneration.current) setReading(false); });
    return () => { previewGeneration.current += 1; };
  }, [api, selected, resource, agent]);
  async function toggle(skill) {
    if (busy) return;
    setBusy(true); setError('');
    generation.current += 1;
    setData(current => ({ ...current, packs: current.packs.map(item => item.id === skill.pack ? { ...item, enabledCount: item.enabledCount + (skill.enabled ? -1 : 1) } : item), skills: current.skills.map(item => item.id === skill.id ? { ...item, enabled: !skill.enabled, enabledAgents: skill.enabled ? item.enabledAgents.filter(id => id !== agent) : [...new Set([...item.enabledAgents, agent])] } : item) }));
    try { await api.request('skills_set', { id: skill.id, enabled: !skill.enabled, agent }); await refresh(); }
    catch (failure) { await refresh(); setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function more() {
    if (reading || preview?.nextOffset === null || !preview) return;
    const request = previewGeneration.current;
    setReading(true);
    try {
      const next = await api.request('skills_read', { id: selected, path: resource, agent, requireEnabled: false, offset: preview.nextOffset, limit: 30000 });
      if (request === previewGeneration.current) setPreview(current => ({ ...next, content: current.content + next.content, offset: 0 }));
    } catch (failure) { if (request === previewGeneration.current) setError(message(failure)); }
    finally { if (request === previewGeneration.current) setReading(false); }
  }
  const skill = data?.skills.find(item => item.id === selected);
  const totalEnabled = data?.packs.reduce((sum, item) => sum + item.enabledCount, 0) || 0;
  return <main className="fast-skills" aria-label="技能包配置">
    <header className="fast-skills-header">
      <div><span className="fast-skills-eyebrow">CODEX FAST · r4</span><h1>技能包</h1></div>
      <div className="fast-skills-actions"><button onClick={refresh} aria-label="刷新技能包">↻</button><button onClick={() => onMode?.(mode === 'expanded' ? 'right' : 'expanded')}>{mode === 'expanded' ? '并排' : '展开'}</button><button onClick={onClose} aria-label="关闭技能包">×</button></div>
    </header>
    <p className="fast-skills-intro">{data ? `${data.inventory.packs} 组 · ${data.inventory.skills} 项技能 · ${data.inventory.resourceFiles} 个参考资源` : '正在读取内置技能…'}。按智能体启用，模型可在任务需要时读取原文与资源。</p>
    <div className="fast-skills-controls">
      <label>用于<select aria-label="技能目标智能体" value={agent} disabled={busy} onChange={event => setAgent(event.target.value)}>{Object.entries(agents).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label className="fast-skills-only"><input type="checkbox" checked={enabledOnly} onChange={event => setEnabledOnly(event.target.checked)} />仅看已启用（{totalEnabled}）</label>
    </div>
    <input className="fast-skills-search" aria-label="搜索技能" placeholder="搜索技能名称、用途…" value={query} onChange={event => setQuery(event.target.value)} />
    <nav className="fast-skills-packs" aria-label="技能包筛选"><button className={!pack ? 'active' : ''} onClick={() => setPack('')}>全部</button>{data?.packs.map(item => <button key={item.id} className={pack === item.id ? 'active' : ''} onClick={() => setPack(item.id)}>{item.name}<small>{item.count}</small></button>)}</nav>
    {error && <div className="fast-skills-error" role="alert">{error}</div>}
    <div className="fast-skills-layout">
      <section className="fast-skills-list" aria-label="技能列表">
        {data && !data.skills.length && <p className="fast-skills-empty">没有匹配的技能。</p>}
        {data?.skills.map(item => <article className={`fast-skills-item ${selected === item.id ? 'selected' : ''}`} key={item.id}>
          <button className="fast-skills-select" onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}><span className="fast-skills-item-title">{item.name}<small>{item.pack}</small></span><span>{item.description}</span><code>{item.id}</code></button>
          <label className="fast-skills-toggle"><input aria-label={`${agents[agent]} 启用 ${item.name}`} type="checkbox" checked={item.enabled} disabled={busy} onChange={() => toggle(item)} /><span>{item.enabled ? '已启用' : '启用'}</span></label>
        </article>)}
      </section>
      <section className="fast-skills-detail" aria-label="技能内容预览">
        {skill ? <>
          <div className="fast-skills-detail-title"><h2>{skill.name}</h2><span>{skill.fileCount} 个文件 · {skill.license}</span></div>
          <p className="fast-skills-compatibility">{skill.compatibility.detail}</p>
          <div className="fast-skills-model-note">{skill.enabled ? `${agents[agent]} 已可读取此技能。` : '启用后，模型才会通过技能工具读取。'}{skill.enabledAgents.length > 0 && ` 已启用：${skill.enabledAgents.map(id => agents[id]).join('、')}。`}</div>
          <label className="fast-skills-resource-label">文件<select aria-label="技能资源文件" value={resource} onChange={event => setResource(event.target.value)}>{(resources.length ? resources : [{ path: 'SKILL.md' }]).map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
          {reading && !preview && <p className="fast-skills-empty">正在读取…</p>}
          {preview && <><pre className="fast-skills-content">{preview.binary ? '二进制资源已列入清单，可用本地文件工具按格式读取。' : preview.content}</pre>{preview.nextOffset !== null && preview.nextOffset !== undefined && <button className="fast-skills-more" disabled={reading} onClick={more}>{reading ? '正在读取…' : `继续读取（${preview.nextOffset}/${preview.totalCharacters}）`}</button>}<details className="fast-skills-provenance"><summary>来源与 SHA256</summary><p>{preview.source?.repository}</p><code>{preview.source?.commit}</code><p>{preview.source?.path}</p><code>{preview.sha256}</code></details></>}
        </> : <p className="fast-skills-empty">选择一项技能查看正文、依赖和参考文件。</p>}
      </section>
    </div>
    <footer className="fast-skills-footer">保持现有用户技能不变；本面板仅管理随包技能。协作仍需用户在提示词中要求。</footer>
  </main>;
}
