import React, { useEffect, useState } from 'react';

export default function CollaborationAccess({ request, threadId, expanded = false }) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
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
      <details><summary>连接其他智能体</summary><p>把以下配置合并到目标智能体的 MCP 设置后，重新连接 MCP。连接器随 Forge 提供，无需另外安装 Node.js。</p><textarea aria-label="外部智能体 MCP 配置" readOnly rows={10} value={JSON.stringify(value.mcpConfig, null, 2)} onFocus={event => event.target.select()} spellCheck="false" /><p className="fast-collab-muted">点击配置框即可全选。连接后先使用 forge_conversations_list 查找获准会话。</p></details>
    </fieldset>}
  </details>;
}
