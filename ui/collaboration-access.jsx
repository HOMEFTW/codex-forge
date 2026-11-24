import React, { useEffect, useRef, useState } from 'react';
import { connectorSetup } from './collaboration-setup.js';

function CopyField({ label, text, rows = 4, disabled = false }) {
  const field = useRef(null), [status, setStatus] = useState('');
  useEffect(() => setStatus(''), [text]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('已复制'); }
    catch {
      field.current.focus(); field.current.select();
      try { setStatus(document.execCommand('copy') ? '已复制' : '请按 Ctrl+C 复制已选中的内容'); }
      catch { setStatus('请按 Ctrl+C 复制已选中的内容'); }
    }
  }
  return <div className="fast-collab-copy">
    <div><strong>{label}</strong><button type="button" disabled={disabled} onClick={copy}>复制{label}</button></div>
    <textarea ref={field} aria-label={label} readOnly rows={rows} value={text} onFocus={event => event.target.select()} spellCheck="false" />
    {status && <p className="fast-collab-muted" role="status">{status}</p>}
  </div>;
}

export default function CollaborationAccess({ request, threadId, expanded = false }) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [targetFile, setTargetFile] = useState('');
  const setup = value && connectorSetup(value.mcpConfig, targetFile);
  useEffect(() => {
    let disposed = false;
    request('access_snapshot').then(result => { if (!disposed) setValue(result); }).catch(failure => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, [request]);
  async function change(method, args) {
    setBusy(true); setError('');
    try { setValue(await request(method, args)); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <details className="fast-collab-access" open={expanded || undefined}>
    <summary>外部智能体 MCP 接入<span>{value?.running ? '已开启' : '未开启'}</span></summary>
    <p className="fast-collab-muted">让同一台电脑上的其他智能体读取获准会话、发送任务和追加指令。下方权限独立于“派出协作智能体”。</p>
    {error && <p role="alert" className="fast-collab-error">{error}</p>}
    {value && <fieldset disabled={busy}>
      <label className="fast-collab-toggle"><strong>允许本机 MCP 访问</strong><input type="checkbox" role="switch" aria-label="允许本机 MCP 访问" checked={value.enabled} onChange={event => change('access_enabled', { enabled: event.target.checked })} /></label>
      <label>当前会话的访问权限<select aria-label="外部智能体访问当前会话" disabled={!threadId} value={value.threads[threadId]?.access || 'none'} onChange={event => change('access_grant', { access: event.target.value })}><option value="none">不共享</option><option value="read">只读内容</option><option value="send">读取内容并发送消息 / 指令</option></select></label>
      {!threadId && <p className="fast-collab-muted">打开目标会话后，可在这里授权。</p>}
      <p className="fast-collab-muted">“发送”会让目标会话开始或继续工作，沿用它的模型和审批设置。同一系统用户下的连接器共用这些授权。</p>
      {Object.keys(value.threads).length > 0 && <div className="fast-collab-shared"><strong>已共享的会话</strong>{Object.entries(value.threads).map(([id, grant]) => <div key={id}><code title={id}>{id === threadId ? `当前会话 · ${id}` : id}</code><span>{grant.access === 'send' ? '读写' : '只读'}</span><button onClick={() => change('access_revoke', { threadId: id })}>撤销</button></div>)}</div>}
      <details open><summary>安装到其他智能体</summary>
        <p>连接器已内置，直接使用 Forge 自带的 Node.js。复制安装提示词交给其他智能体，即可让它配置接入。</p>
        <label className="fast-collab-install-path">目标 MCP JSON 配置文件<input aria-label="目标 MCP JSON 配置文件" value={targetFile} onChange={event => setTargetFile(event.target.value)} placeholder="填写目标客户端配置文件的绝对路径" spellCheck="false" /></label>
        <p className="fast-collab-muted">支持 mcpServers 格式的 JSON，安装时保留其他设置并备份原文件。不清楚路径或格式时，可留空并复制安装提示词。</p>
        <CopyField label="安装命令" text={setup.installCommand} disabled={!targetFile.trim()} />
        <CopyField label="安装提示词" text={setup.prompt} rows={7} />
        <p className="fast-collab-muted">命令在 PowerShell 中运行。安装后重新连接 MCP，并调用 forge_conversations_list 检查共享会话。使用便携版移动目录后，请重新配置接入。</p>
        <details><summary>手动配置与其他客户端格式</summary>
          <CopyField label="配置查询命令" text={setup.configCommand} />
          <CopyField label="外部智能体 MCP 配置" text={JSON.stringify(value.mcpConfig, null, 2)} rows={10} />
          <p className="fast-collab-muted">TOML、JSONC 等格式请按目标客户端要求填写 command 和 args。</p>
        </details>
      </details>
    </fieldset>}
  </details>;
}
