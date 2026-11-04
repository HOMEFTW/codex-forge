import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MarkdownIt from 'markdown-it';
import mark from 'markdown-it-mark';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { parse as parseYAML } from 'yaml';
import Chart from 'chart.js/auto';
import mermaid from 'mermaid';

const message = error => String(error?.message || error);
const EMPTY_TASKS = [];
const md = new MarkdownIt({ html: true, linkify: true, breaks: false }).use(mark).use(footnote).use(taskLists);
const escape = md.utils.escapeHtml;
md.inline.ruler.before('link', 'obsidian-link', (state, silent) => {
  const match = state.src.slice(state.pos).match(/^(!?)\[\[([^\]\n]+)\]\]/);
  if (!match) return false;
  if (!silent) { const token = state.push(match[1] ? 'ob_embed' : 'ob_link', '', 0); token.content = match[2]; }
  state.pos += match[0].length; return true;
});
md.renderer.rules.ob_link = (tokens, i) => { const [target, label] = tokens[i].content.split('|'); return `<a class="internal-link" href="#" data-note="${escape(target)}">${escape(label || target)}</a>`; };
md.renderer.rules.ob_embed = (tokens, i) => `<span class="ob-embedded" data-embed="${escape(tokens[i].content)}"></span>`;
md.inline.ruler.before('escape', 'obsidian-math', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  let end = state.pos + 1; while ((end = state.src.indexOf('$', end)) >= 0 && state.src[end - 1] === '\\') end++;
  if (end <= state.pos + 1 || state.src.slice(state.pos + 1, end).includes('\n')) return false;
  if (!silent) { const token = state.push('ob_math', '', 0); token.content = state.src.slice(state.pos + 1, end); }
  state.pos = end + 1; return true;
});
md.renderer.rules.ob_math = (tokens, i, _options, env) => { const id = env.blocks.push({ kind: 'inlineMath', content: tokens[i].content }) - 1; return `<span data-block="${id}"></span>`; };
const oldFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, options, env, self) => {
  const token = tokens[i], kind = token.info.trim().toLowerCase();
  if (['dataview', 'dataviewjs', 'chart', 'mermaid', 'base', 'obmath'].includes(kind)) { const id = env.blocks.push({ kind, content: token.content }) - 1; return `<div class="ob-block" data-block="${id}"></div>`; }
  return oldFence(tokens, i, options, env, self);
};
function prepared(content) {
  let body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/%%[\s\S]*?%%/g, '');
  // Preserve existing fenced code while converting display math into renderer blocks.
  const lines = body.split('\n'); let fence = '', math = false;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s*(`{3,}|~{3,})/); if (f && !math) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; }
    if (!fence && /^\s*\$\$\s*$/.test(lines[i])) { lines[i] = math ? '```' : '```obmath'; math = !math; }
  }
  return lines.join('\n');
}
export function markdown(content) {
  const env = { blocks: [] }, raw = md.render(prepared(content), env);
  const fragment = DOMPurify.sanitize(raw, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style', 'video', 'audio', 'source', 'link'], FORBID_ATTR: ['style', 'srcset'], ADD_ATTR: ['data-note', 'data-embed', 'data-block'] });
  fragment.querySelectorAll('img').forEach(el => {
    const src = el.getAttribute('src');
    if (src && !/^(?:[a-z][\w+.-]*:|\/\/)/i.test(src)) { const holder = document.createElement('span'); holder.className = 'ob-embedded'; holder.dataset.embed = src; el.replaceWith(holder); }
    else el.replaceWith(document.createTextNode('[外部图片未自动加载]'));
  });
  const holder = document.createElement('div'); holder.append(fragment);
  return { html: holder.innerHTML, blocks: env.blocks };
}
function useRequest(request, key, loader) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { let active = true; setState({ loading: true }); Promise.resolve().then(loader).then(value => active && setState({ value }), error => active && setState({ error: message(error) })); return () => { active = false; }; }, [request, key]);
  return state;
}
function Value({ value, onOpen }) {
  if (value == null) return <span className="ob-muted">—</span>;
  if (Array.isArray(value)) return <>{value.map((x, i) => <React.Fragment key={i}>{i > 0 && ', '}<Value value={x} onOpen={onOpen}/></React.Fragment>)}</>;
  if (typeof value === 'object' && value.path) return <button className="ob-link" onClick={() => onOpen(value.path)}>{value.display || value.path}</button>;
  return <>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</>;
}
export function QueryResult({ result, onOpen, request, onChanged }) {
  const [error, setError] = useState('');
  if (!result) return null;
  if (Object.hasOwn(result, 'value')) return <Value value={result.value} onOpen={onOpen}/>;
  async function task(row) {
    try { const doc = await request('read', { path: row.path }); await request('task', { path: row.path, expectedRevision: doc.revision, line: row.task.line, completed: !row.task.completed }); onChanged?.(); }
    catch (e) { setError(message(e)); }
  }
  return <div className="ob-query-result">{error && <p className="ob-error">{error}</p>}{['table'].includes(result.type) ? <div className="ob-table-scroll"><table><thead><tr>{result.headers.map((h, i) => <th key={i}>{h}</th>)}{result.columns && <th>打开笔记</th>}</tr></thead><tbody>{result.rows.map((row, i) => <tr key={i}>{row.values.map((v, j) => <td key={j}><Value value={v} onOpen={onOpen}/></td>)}{result.columns && <td><button className="ob-link" onClick={() => onOpen(row.path)}>{row.title}</button></td>}</tr>)}</tbody></table></div> : <ul className={result.type === 'cards' ? 'ob-cards' : 'ob-query-list'}>{result.rows.map((row, i) => <li key={i}>{row.task ? <label><input type="checkbox" checked={row.task.completed} onChange={() => task(row)}/>{row.task.text}</label> : <button className="ob-link" onClick={() => onOpen(row.path)}>{row.title}</button>}{row.group != null && <small><Value value={row.group} onOpen={onOpen}/></small>}{row.values?.map((v, j) => <div key={j}><Value value={v} onOpen={onOpen}/></div>)}</li>)}</ul>}{result.summaries && Object.keys(result.summaries).length > 0 && <p className="ob-muted">汇总：{Object.entries(result.summaries).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}<small className="ob-muted">{result.total} 条{result.truncated ? ' · 仅展示前 1000 条' : ''}</small></div>;
}
export function QueryBlock({ request, language = 'dataview', query, source, path, onOpen, refresh = 0 }) {
  const [view, setView] = useState(''), [revision, setRevision] = useState(0);
  const state = useRequest(request, JSON.stringify([language, query, source, path, view, revision, refresh]), () => request('query', { language, query, source, path, view: view || undefined }));
  return state.error ? <p className="ob-error">{state.error}</p> : state.loading ? <p className="ob-muted">查询中…</p> : <>{state.value.views && <select aria-label="数据库视图" value={view || state.value.view} onChange={e => setView(e.target.value)}>{state.value.views.map(v => <option key={v.name}>{v.name}</option>)}</select>}<QueryResult result={state.value} onOpen={onOpen} request={request} onChanged={() => setRevision(x => x + 1)}/></>;
}
function ChartBlock({ content }) {
  const canvas = useRef(), [error, setError] = useState('');
  useEffect(() => {
    let chart; setError('');
    try {
      const spec = parseYAML(content, { maxAliasCount: 30 });
      if (!['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter'].includes(spec?.type)) throw Error('不支持此 Charts 图表类型');
      if (!Array.isArray(spec.labels) || !Array.isArray(spec.series) || spec.series.some(s => !Array.isArray(s.data) || s.data.some(x => typeof x !== 'number' && !(spec.type === 'scatter' && typeof x?.x === 'number' && typeof x?.y === 'number')))) throw Error('Charts 需要 labels 与 series[].data 数值数组');
      if (spec.file || spec.dataview || spec.options || spec.data) throw Error('独立 Charts 不支持外部文件、Dataview 或自定义 JS/options');
      const colors = ['#8b73de', '#3aa6aa', '#d89b4a', '#d66c99', '#6795d5'];
      chart = new Chart(canvas.current, { type: spec.type, data: { labels: spec.labels, datasets: spec.series.map((s, i) => ({ label: s.title || `系列 ${i + 1}`, data: s.data, backgroundColor: ['pie', 'doughnut', 'polarArea'].includes(spec.type) ? colors : colors[i % colors.length], borderColor: colors[i % colors.length], fill: !!spec.fill, tension: Number(spec.tension) || 0 })) }, options: { responsive: true, maintainAspectRatio: false, animation: false, indexAxis: spec.horizontal ? 'y' : 'x', plugins: { legend: { display: spec.legend !== false } }, scales: ['bar', 'line'].includes(spec.type) ? { y: { beginAtZero: spec.beginAtZero !== false, stacked: !!spec.stacked }, x: { stacked: !!spec.stacked } } : undefined } });
    } catch (e) { setError(message(e)); }
    return () => chart?.destroy();
  }, [content]);
  return <div className="ob-chart">{error ? <p className="ob-error">{error}</p> : null}<canvas aria-label="笔记图表" role="img" ref={canvas} hidden={!!error}/></div>;
}
let mermaidId = 0, mermaidQueue = Promise.resolve();
function MermaidBlock({ content }) {
  const ref = useRef(), [error, setError] = useState('');
  useEffect(() => {
    let active = true; setError('');
    mermaidQueue = mermaidQueue.catch(() => {}).then(async () => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', maxTextSize: 50000, htmlLabels: false });
      const { svg } = await mermaid.render('ob-mermaid-' + ++mermaidId, content);
      if (active && ref.current) ref.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    }).catch(e => active && setError(message(e)));
    return () => { active = false; };
  }, [content]);
  return <div className="ob-mermaid" ref={ref}>{error && <p className="ob-error">{error}</p>}</div>;
}
export function Attachment({ request, path }) {
  const state = useRequest(request, path, () => request('asset', { path }));
  if (state.loading) return <span className="ob-muted">正在加载附件…</span>;
  if (state.error) return <span className="ob-error">{state.error}</span>;
  const { mime, data } = state.value;
  if (mime.startsWith('image/')) return <img className="ob-attachment" alt={path} src={data}/>;
  if (mime.startsWith('audio/')) return <audio controls src={data}/>;
  if (mime.startsWith('video/')) return <video className="ob-attachment" controls src={data}/>;
  return <div><p className="ob-muted">PDF 预览取决于客户端内置 PDF 支持。</p><iframe className="ob-pdf" title={path} src={data} sandbox=""/></div>;
}
function Embed({ target, source, request, onOpen, chain }) {
  const state = useRequest(request, target + source, async () => {
    const resolved = await request('resolve', { target: target.split('|')[0], source });
    if (!resolved.path) throw Error(resolved.ambiguous ? '嵌入名称不唯一，请使用完整路径' : '未找到嵌入：' + target);
    if (chain.includes(resolved.path) || chain.length > 4) throw Error('已停止循环或超过 5 层的笔记嵌入');
    return { ...resolved, doc: resolved.path.endsWith('.md') ? await request('read', { path: resolved.path }) : null };
  });
  if (state.error) return <span className="ob-error">{state.error}</span>;
  if (state.loading) return <span className="ob-muted">读取嵌入…</span>;
  const { path, fragment, doc } = state.value;
  if (path.endsWith('.base')) return <QueryBlock request={request} language="base" path={path} source={source} onOpen={onOpen}/>;
  if (!doc) return <Attachment request={request} path={path}/>;
  let content = doc.content;
  if (fragment?.startsWith('^')) {
    const lines = content.split('\n'), at = lines.findIndex(l => l.trimEnd().endsWith(fragment));
    if (at < 0) return <span className="ob-error">块引用未找到：{fragment}</span>;
    let start = at; while (start > 0 && lines[start - 1].trim()) start--; content = lines.slice(start, at + 1).join('\n').replace(fragment, '');
  } else if (fragment) {
    const heading = doc.headings.find(h => h.text === fragment), lines = content.split('\n');
    if (!heading) return <span className="ob-error">嵌入标题未找到：{fragment}</span>;
    const next = doc.headings.find(h => h.line > heading.line && h.level <= heading.level); content = lines.slice(heading.line, next?.line).join('\n');
  }
  return <div className="ob-note-embed"><button className="ob-link" onClick={() => onOpen(path)}>{path}</button><MarkdownView content={content} source={path} request={request} onOpen={onOpen} chain={[...chain, path]}/></div>;
}
export default function MarkdownView({ content, source, request, onOpen, onTask, tasks = EMPTY_TASKS, chain = [source], refresh = 0 }) {
  const ref = useRef(), [portals, setPortals] = useState([]), rendered = useMemo(() => markdown(content), [content]);
  useLayoutEffect(() => {
    const root = ref.current, widgets = [];
    root.querySelectorAll('[data-block]').forEach(el => { const block = rendered.blocks[Number(el.dataset.block)]; if (block) widgets.push({ el, ...block }); });
    root.querySelectorAll('[data-embed]').forEach(el => widgets.push({ el, kind: 'embed', content: el.dataset.embed }));
    root.querySelectorAll('code').forEach(el => { if (el.parentElement?.tagName !== 'PRE' && el.textContent.startsWith('=')) { const content = el.textContent.slice(1).trim(); el.textContent = ''; widgets.push({ el, kind: 'expression', content }); } });
    root.querySelectorAll('img').forEach(el => {
      const src = el.getAttribute('src'); el.removeAttribute('src');
      if (src && !/^(?:[a-z][\w+.-]*:|\/\/)/i.test(src)) { const holder = document.createElement('span'); el.replaceWith(holder); widgets.push({ el: holder, kind: 'embed', content: src }); }
      else el.replaceWith(document.createTextNode('[外部图片未自动加载]'));
    });
    root.querySelectorAll('blockquote').forEach(el => {
      const p = el.querySelector('p'), match = p?.textContent.match(/^\[!([\w-]+)\]([+-])?\s*(.*)/);
      if (!match) return; el.classList.add('ob-callout'); el.dataset.callout = match[1];
      const label = document.createElement(match[2] ? 'summary' : 'strong'); label.textContent = match[3].split('\n')[0] || match[1];
      if (p.firstChild?.nodeType === 3) p.firstChild.textContent = p.firstChild.textContent.replace(/^\[![\w-]+\][+-]?[^\n]*(?:\n|$)/, '');
      if (match[2]) { const details = document.createElement('details'); details.open = match[2] === '+'; details.append(label, ...el.childNodes); el.append(details); } else el.prepend(label);
    });
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => { el.id = 'heading-' + el.textContent; });
    setPortals(widgets);
  }, [rendered]);
  useLayoutEffect(() => { ref.current.querySelectorAll('input[type=checkbox]').forEach((el, i) => { el.disabled = !onTask || !tasks[i]; if (tasks[i]) el.dataset.taskLine = String(tasks[i].line); }); }, [rendered, onTask, tasks]);
  function clicked(e) {
    const task = e.target.closest('input[data-task-line]'); if (task && onTask) { const checked = task.checked; e.preventDefault(); onTask(Number(task.dataset.taskLine), checked); return; }
    const link = e.target.closest('a'); if (!link) return; e.preventDefault();
    const target = link.dataset.note || link.getAttribute('href'); if (!target) return;
    if (!link.dataset.note && target.startsWith('#')) { const anchor = ref.current.querySelector('[id="' + CSS.escape(target.slice(1)) + '"]'); if (anchor) { anchor.scrollIntoView({ block: 'start' }); return; } }
    if (/^https?:/i.test(target)) { onOpen(target); return; }
    if (/^[a-z][\w+.-]*:/i.test(target)) return;
    onOpen(target, source);
  }
  return <><div ref={ref} className="ob-markdown" onClick={clicked} dangerouslySetInnerHTML={{ __html: rendered.html }}/>{portals.map((block, i) => createPortal(
    block.kind === 'embed' ? <Embed target={block.content} source={source} request={request} onOpen={onOpen} chain={chain}/> :
    block.kind === 'chart' ? <ChartBlock content={block.content}/> :
    block.kind === 'mermaid' ? <MermaidBlock content={block.content}/> :
    block.kind === 'obmath' || block.kind === 'inlineMath' ? <span className="ob-math" dangerouslySetInnerHTML={{ __html: katex.renderToString(block.content, { displayMode: block.kind === 'obmath', throwOnError: false, trust: false, maxSize: 20 }) }}/> :
    block.kind === 'dataviewjs' ? <p className="ob-error">独立模式不执行 DataviewJS。请使用 dataview 查询块。</p> :
    <QueryBlock request={request} language={block.kind === 'base' ? 'base' : block.kind === 'expression' ? 'expression' : 'dataview'} query={block.content} source={source} onOpen={onOpen} refresh={refresh}/>, block.el, String(i)))}</>;
}
