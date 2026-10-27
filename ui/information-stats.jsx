import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './information-stats.css';

const VERDICT_LABELS = {
  MATCH: '指纹一致',
  MISMATCH: '指纹不一致',
  SUSPICIOUS: '存在差异 · 待复核',
  UNLISTED: '参考库未收录',
  UNKNOWN: '当前模型未知',
  NO_SAMPLE: '等待检测',
};

const SOURCE_LABELS = {
  probe: '内置检测',
  manual: '粘贴样本',
  'is-gpt-nerfed': '导入样本',
};

const errorText = error => String(error?.message || error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
    : '—';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function formatTime(value) {
  if (!value || !Number.isFinite(value)) return '尚未检测';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function Trend({ samples = [] }) {
  if (!samples.length) return <div className="info-trend-empty">完成一次生成后显示速度趋势</div>;
  const maximum = Math.max(1, ...samples.map(item => item.tps));
  const points = samples.map((item, index) => {
    const x = samples.length === 1 ? 148 : 4 + index / (samples.length - 1) * 288;
    const y = 53 - item.tps / maximum * 44;
    return `${x},${y}`;
  }).join(' ');
  const singleY = samples.length === 1 ? 53 - samples[0].tps / maximum * 44 : 0;

  return <svg className="info-trend" viewBox="0 0 296 60" role="img" aria-label={`最近 ${samples.length} 次生成速度趋势`}>
    <path d="M0 54H296M0 30H296" className="info-chart-grid" />
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    {samples.length === 1 && <circle cx="148" cy={singleY} r="3" fill="currentColor" />}
  </svg>;
}

function TokenGrid({ speed }) {
  const values = [
    ['输入 Token', speed.inputTokens],
    ['缓存命中', speed.cachedInputTokens],
    ['输出 Token', speed.outputTokens],
    ['其中推理', speed.reasoningTokens],
    ['模型响应', speed.responses],
  ];
  return <div className="info-token-grid">
    {values.map(([label, value]) => <div key={label}>
      <span>{label}</span><strong>{formatNumber(value || 0)}</strong>
    </div>)}
  </div>;
}

function CandidateList({ candidates, expected }) {
  if (!candidates.length) {
    return <div className="info-empty"><strong>还没有指纹样本</strong><span>运行检测，或粘贴已有数字回答。</span></div>;
  }
  return <ol className="info-candidates">
    {candidates.map((item, index) => <li key={item.model}>
      <div>
        <span className="info-rank">{index + 1}</span>
        <code>{item.model}</code>
        {item.model === expected && <small>当前</small>}
        <b>{formatPercent(item.probability)}</b>
      </div>
      <div className="info-bar"><i style={{ width: `${Math.min(100, Math.max(0, item.probability * 100))}%` }} /></div>
    </li>)}
  </ol>;
}

function useStats(api, threadId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const current = useMemo(() => ({ active: true, sequence: 0, reading: false, readPromise: null, acting: false }), [api, threadId]);

  const request = useCallback(async (method = 'snapshot', args = {}) => {
    const action = method !== 'snapshot';
    if (!current.active || current.acting && method !== 'cancel') return;
    if (action && current.readPromise) await current.readPromise.catch(() => {});
    if (!current.active || current.acting || !action && current.reading) return;
    if (action) current.acting = true;
    else current.reading = true;

    const sequence = ++current.sequence;
    if (action) setPending(true);
    const operation = (async () => {
      try {
        const result = await api.request('statistics', { method, args, threadId });
        if (current.active && sequence === current.sequence && result.threadId === (threadId || null)) {
          setData(result);
          setError('');
        }
      } catch (failure) {
        if (current.active && sequence === current.sequence) setError(errorText(failure));
      } finally {
        if (action) {
          current.acting = false;
          if (current.active) setPending(false);
        } else {
          current.reading = false;
        }
      }
    })();
    if (!action) current.readPromise = operation;
    try { await operation; }
    finally { if (!action && current.readPromise === operation) current.readPromise = null; }
  }, [api, threadId, current]);

  useEffect(() => {
    current.active = true;
    setData(null); setError(''); setPending(false);
    request();
    const timer = setInterval(() => request(), 1_800);
    const unsubscribe = api.subscribe?.(event => {
      if (event?.type === 'refresh') request();
    });
    return () => {
      current.active = false;
      current.sequence += 1;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [api, request, current]);

  return { data, error, pending, request, setError };
}

export default function InformationStatsPanel({ api, threadId, mode, onMode, onClose }) {
  const { data, error, pending, request, setError } = useStats(api, threadId);
  const [tab, setTab] = useState('overview');
  const [samples, setSamples] = useState([{ text: '', expected_count: 320 }]);
  const speed = data?.speed || {};
  const fingerprint = data?.fingerprint || {};
  const observation = speed.observation || {};
  const contextPercent = observation.contextPercent;
  const latest = speed.latest;
  const job = data?.job;
  const running = job?.status === 'running';
  const candidates = (fingerprint.results || []).slice(0, 5);
  const expected = fingerprint.results?.find(item => item.model === fingerprint.expected);
  if (expected && !candidates.some(item => item.model === expected.model)) candidates.push(expected);

  function updateSample(index, patch) {
    setSamples(current => current.map((item, itemIndex) => itemIndex === index
      ? { ...item, ...patch }
      : item));
  }

  function analyzeSamples(event) {
    event.preventDefault();
    request('analyze', { outputs: samples.filter(item => item.text.trim()) });
  }

  const warning = fingerprint.warning;
  const tone = warning ? 'warning' : fingerprint.verdict === 'MATCH' && !fingerprint.stale ? 'match' : '';
  const status = fingerprint.stale
    ? '结果已过期 · 请重新检测'
    : VERDICT_LABELS[fingerprint.verdict] || '等待检测';
  const modeChange = () => Promise.resolve().then(() => onMode?.()).catch(failure => setError(errorText(failure)));

  return <main className={`information-stats ${mode}`}>
    <header className="info-topbar">
      <span className="info-mark" aria-hidden="true">⌁</span>
      <strong>信息统计</strong>
      <small>SESSION / LOCAL</small>
      <div className="spacer" />
      <button onClick={modeChange} aria-label="切换面板宽度" title="切换面板宽度">{mode === 'right' ? '⛶' : '◧'}</button>
      <button onClick={onClose} aria-label="关闭信息统计">×</button>
    </header>

    <div className="info-scroll">
      <div className="info-context">
        <span>当前对话 <b className={`info-phase ${speed.phase || 'idle'}`}>{({ generating: '生成中', tools: '工具执行中', idle: '空闲' })[speed.phase] || '等待日志'}</b></span>
        <code title={data?.model || ''}>{data?.model || '尚未确认模型'}</code>
        <small>{data?.provider || '等待提供商信息'}{data?.effort ? ` / ${data.effort}` : ''}</small>
      </div>
      <nav className="info-tabs info-main-tabs" aria-label="统计视图">
        {[['overview', '会话概览'], ['evidence', '模型检测'], ['history', '检测历史']].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      {error && <div className="info-error" role="alert">
        <span>{error}</span><button onClick={() => request()} disabled={pending}>重试</button>
      </div>}
      {!threadId && <p className="info-note">打开一个已保存的对话，即可查看该对话的速度和模型指纹。</p>}

      {tab === 'overview' && <><section className="info-card info-speed" aria-label="Agent 速度统计">
        <div className="info-label">
          <span><i className="info-pulse" />AGENT SPEED</span>
          <small>{speed.phase === 'generating' ? '正在生成' : speed.phase === 'tools' ? '工具与回合间隔' : '等待下一次生成'}</small>
        </div>
        <div className="info-speed-value">
          <strong>{formatNumber(speed.latest?.tps)}</strong><span>tokens / s</span>
          <div><small>会话均速</small><b>{formatNumber(speed.average)}</b></div>
        </div>
        <Trend samples={speed.samples} />
        <div className="info-caption">
          <span>最近 {speed.samples?.length || 0} 次响应</span>
          <time>{speed.latest ? formatTime(speed.latest.endMs) : '暂无速度样本'}</time>
        </div>
        <div className="info-speed-details"><span>最近耗时 <b>{latest?.durationMs ? `${(latest.durationMs / 1000).toFixed(1)} s` : '—'}</b></span><span>输出 / 推理 <b>{latest ? `${formatNumber(latest.output)} / ${formatNumber(latest.reasoning)}` : '—'}</b></span></div>
        <TokenGrid speed={speed} />
        <p className="info-note">端到端速度包含首 Token 等待与推理；均速按总输出和总耗时加权。</p>
        {speed.reading && <p className="info-note" role="status">正在增量读取会话日志…</p>}
      </section>
      <section className="info-card info-window" aria-label="上下文窗口">
        <div className="info-label"><span>CONTEXT WINDOW</span><small>日志实际报告</small></div>
        <div className="info-window-value"><strong>{formatNumber(observation.contextUsed)}</strong><span>/ {formatNumber(observation.contextWindow)} Token</span></div>
        <div className="info-window-track" role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number.isFinite(contextPercent) ? Math.min(100, contextPercent * 100) : undefined}><i style={{ width: `${Math.min(100, Math.max(0, (contextPercent || 0) * 100))}%` }} /></div>
        <p className="info-note">{Number.isFinite(contextPercent) ? `占用 ${formatPercent(contextPercent)} · 最近请求输入与输出` : '等待会话 token_count 记录；累计输入 Token 不等于当前上下文。'}{data?.model === 'gpt-6.1-sol' && ' Forge 目标为 500,000，原生 95% 可用窗口为 475,000。'}</p>
      </section>
      <section className="info-card" aria-label="被动一致性检查">
        <div className="info-label"><span>被动一致性检查</span><b className={observation.warnings ? 'info-alert-text' : 'info-status'}>{observation.warnings ? `${observation.warnings} 条待复核` : speed.found ? '未见异常变更' : '等待日志'}</b></div>
        <p className="info-note">比较日志中的模型、思考强度和上下文窗口。设置变更单独标记，日志无法证明服务端真实模型身份。</p>
        <div className="info-events">{observation.events?.length ? observation.events.slice(0, 8).map((event, index) => <article key={`${event.at}-${index}`} className={event.severity}><div><b>{({ model_change: '模型变更', effort_change: '思考强度', context_change: '上下文变更', internal_model: '内部模型' })[event.kind] || event.kind}</b><time>{formatTime(event.at)}</time></div><p>{event.detail}</p></article>) : <div className="info-event-empty">{speed.found ? '尚无变更记录' : '尚未找到当前对话的日志'}</div>}</div>
      </section>
      <section className="info-card info-responses" aria-label="最近响应"><div className="info-label"><span>最近响应</span><small>{speed.responses || 0} 次累计</small></div>{speed.samples?.length ? <table><thead><tr><th>时间</th><th>输出</th><th>耗时</th><th>tok/s</th></tr></thead><tbody>{speed.samples.slice(-8).reverse().map(item => <tr key={item.id}><td>{new Date(item.endMs).toLocaleTimeString('zh-CN', { hour12: false })}</td><td>{formatNumber(item.output)}</td><td>{(item.durationMs / 1000).toFixed(1)}s</td><td>{formatNumber(item.tps)}</td></tr>)}</tbody></table> : <p className="info-note">完成一次生成后显示。</p>}</section></>}

      {tab === 'evidence' && <section className={`info-card info-fingerprint ${tone}`} aria-label="模型指纹对照">
        <div className="info-label"><span>◉ 模型指纹</span><b className="info-status">{status}</b></div>
        <div className="info-models">
          <div><span>正在使用</span><strong>{data?.model || '未知模型'}</strong></div>
          <span className="info-arrow" aria-hidden="true">↓</span>
          <div>
            <span>{fingerprint.verdict === 'UNLISTED' ? '参考库内最近候选' : '数字指纹候选'}</span>
            <strong className="info-prediction">{fingerprint.prediction || '尚无数字样本'}</strong>
          </div>
        </div>
        {fingerprint.prediction && <div className="info-confidence">
          <b>{formatPercent(fingerprint.probability)}</b>
          <span>参考库内概率 · {fingerprint.usedOutputs} 组有效回答</span>
        </div>}
        <p className={`info-note ${warning ? 'info-warning-copy' : ''}`}>
          {fingerprint.verdict === 'UNLISTED'
            ? '参考库未包含当前模型。最近候选仅供观察，不能据此判断模型被替换。'
            : warning
              ? fingerprint.verdict === 'MISMATCH'
                ? '多组样本与声明模型差异较大，建议复测并核对提供商。'
                : '当前样本偏向其他模型，但证据不足；建议补齐样本后复测。'
              : '数字偏好用于辅助判断；参考库内概率不代表真实模型身份认证。'}
        </p>
        <div className="info-actions">
          <button className="info-primary" disabled={pending || running || !threadId || !data?.model || !data?.provider} onClick={() => request('probe')}>
            {running ? `检测中 ${job.completed} / 3` : '运行检测'}
          </button>
          {running
            ? <button disabled={pending} onClick={() => request('cancel')}>取消检测</button>
            : <button disabled={pending || !threadId} onClick={() => request('import')}>导入已有样本</button>}
        </div>
        {running && <progress max="3" value={job.completed} aria-label="模型检测进度" />}
        <p className="info-note" role="status">
          {running
            ? '顺序采集三组数字回答，完成后自动分析。'
            : '手动运行会使用当前模型额度，发送 3 次数字采样请求。'}
        </p>
        {job?.status === 'failed' && <p className="info-error" role="alert">检测失败：{job.error}</p>}
        {job?.status === 'cancelled' && <p className="info-note" role="status">检测已取消，可重新运行。</p>}
        <div className="info-caption info-result">
          <span>{SOURCE_LABELS[fingerprint.source] || '尚无检测结果'}</span>
          <time>{formatTime(fingerprint.createdAt)}</time>
        </div>
      </section>}

      {tab === 'evidence' ? <section className="info-evidence" aria-label="检测依据">
        <div className="info-label"><span>MODELTRACE × IS-GPT-NERFED</span><small>{data?.bank?.models?.length || 18} 个参考模型</small></div>
        <CandidateList candidates={candidates} expected={fingerprint.expected} />
        {!!fingerprint.families?.length && <div className="info-diagnostics" aria-label="模型家族概率">{fingerprint.families.map(family => <div key={family.family}><span>{family.display_name}</span><b>{formatPercent(family.probability)}</b></div>)}</div>}
        {!!fingerprint.diagnostics?.length && <div className="info-diagnostics">
          {fingerprint.diagnostics.map((item, index) => <div key={index}>
            <span>样本 {index + 1}</span><span>{item.parsed_numbers} 个数字</span><b>{item.accepted ? '已采纳' : '不足，已跳过'}</b>
          </div>)}
        </div>}
        <details className="info-disclosure">
          <summary>统计口径与判断依据</summary>
          <p>速度 = 输出 Token ÷ 该次请求耗时，包含推理 Token；会话均速按总输出与总耗时加权。数据来自当前对话的本地日志。</p>
          <p>ModelTrace 分析 1–355 整数的频数与顺序特征。高置信差异要求至少两组有效样本、候选概率 ≥ 80%、当前模型概率 ≤ 20%、得分差 ≥ 0.5。弱差异标为待复核。</p>
          <p>参考库更新于 {data?.bank?.builtAt?.slice(0, 10) || '2026-10-09'}；结果 {data?.bank?.ttlHours || 24} 小时后过期。输出随机性、上下文和模型版本都可能影响判断。</p>
        </details>
        <details className="info-disclosure">
          <summary>粘贴数字样本分析</summary>
          <p>每组粘贴待测模型输出的整数序列；允许重复，不排序。样本只在本机计算。</p>
          <form onSubmit={analyzeSamples}>
            {samples.map((item, index) => <div className="info-sample" key={index}>
              <label htmlFor={`info-sample-${index}`}>样本 {index + 1}</label>
              <textarea id={`info-sample-${index}`} value={item.text} maxLength={50_000} placeholder="[42, 17, 289, …]" onChange={event => updateSample(index, { text: event.target.value })} />
              <label className="info-count">要求的数字个数
                <input type="number" min="80" max="500" value={item.expected_count} onChange={event => updateSample(index, { expected_count: Number(event.target.value) })} />
              </label>
            </div>)}
            <div className="info-actions">
              {samples.length < 3 && <button type="button" onClick={() => setSamples(current => [...current, { text: '', expected_count: 320 }])}>添加一组</button>}
              <button className="info-primary" disabled={pending || running || !threadId || !data?.model || !samples.some(item => item.text.trim())}>本地分析</button>
            </div>
          </form>
        </details>
        <p className="info-note info-import-hint">导入只接受与当前对话、模型、提供商和思考强度一致的近期本地样本，并重新计算指纹。</p>
      </section> : tab === 'history' && <section className="info-history" aria-label="检测历史">
        {data?.history?.length ? data.history.map(item => <article key={item.id}>
          <div><strong>{item.prediction || '无有效候选'}</strong><b>{VERDICT_LABELS[item.verdict] || item.verdict}</b></div>
          <span>{item.model} · {SOURCE_LABELS[item.source] || item.source}</span>
          <time>{formatTime(item.createdAt)}</time>
        </article>) : <div className="info-empty"><strong>暂无检测历史</strong><span>本机保留最近 20 条检测结果。</span></div>}
      </section>}

      <footer className="info-attribution">Agent Speed · ModelTrace · is-gpt-nerfed <span>MIT · 仅主动检测消耗额度</span></footer>
    </div>
  </main>;
}
