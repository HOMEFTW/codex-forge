'use strict';
const crypto = require('node:crypto');
const { AGENTS } = require('./agent-cli.cjs');

class NativeApprovals {
  constructor({ states }) { this.states = states; this.pending = new Map(); }
  request({ request, signal }) {
    if (signal?.aborted) return Promise.resolve({ approved: false });
    const id = 'fast-approval-' + crypto.randomUUID();
    return new Promise(resolve => {
      const entry = { request, state: null, resolve: value => {
        clearInterval(entry.timer); signal?.removeEventListener('abort', abort); this.pending.delete(id);
        resolve(value);
        try { if (entry.state && !entry.state.win.isDestroyed()) entry.state.win.webContents.send('codex_desktop:message-for-view', { type: 'mcp-notification', hostId: 'local', method: 'serverRequest/resolved', params: { threadId: request.threadId, requestId: id } }); } catch { /* The originating renderer has already closed. */ }
      } };
      const abort = () => entry.resolve({ approved: false });
      this.pending.set(id, entry); signal?.addEventListener('abort', abort, { once: true });
      const show = () => {
        if (entry.state) { if (entry.state.win.isDestroyed()) abort(); return; }
        const state = [...this.states.values()].find(s => s.bridge && !s.win.isDestroyed() && s.threadId === request.threadId);
        if (!state) return;
        entry.state = state;
        const message = request.kind === 'collaboration-authorization'
          ? `当前用户明确请求开启本对话智能体协作，但本对话尚未勾选协作开关。\n允许的智能体：${(request.agents || []).map(agent => AGENTS[agent] || agent).join('、') || '未指定'}\n用户提示词：\n${request.prompt || ''}\n\n${request.reason}\n\n批准后仅开启本对话智能体协作，不会自动执行其他操作。`
          : `${AGENTS[request.agent]} 请求执行一次操作。\n工作目录：${request.cwd}\n工具：${request.action.toolName}\n原生审批：${request.action.nativeDecision}\n转人工原因：${request.reason}\n\n完整操作参数：\n${JSON.stringify(request.action.input, null, 2)}\n\n批准仅适用于此次操作。`;
        state.win.webContents.send('codex_desktop:message-for-view', { type: 'mcp-request', hostId: 'local', request: { id, method: 'mcpServer/elicitation/request', params: {
          threadId: request.threadId, turnId: null, serverName: '外部智能体审批', mode: 'form', _meta: null, message,
          requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: '此次操作', enum: ['deny', 'approve'], enumNames: ['拒绝', '批准一次'], default: 'deny' } }, required: ['decision'] },
        } } });
      };
      const safeShow = () => { try { show(); } catch { abort(); } };
      entry.timer = setInterval(safeShow, 250); entry.timer.unref?.(); safeShow();
    });
  }
  respond(event, message) {
    const id = message?.response?.id;
    if (message?.type !== 'mcp-response' || typeof id !== 'string' || !id.startsWith('fast-approval-')) return false;
    const entry = this.pending.get(id);
    if (!entry || message.hostId !== 'local' || event.sender.id !== entry.state?.win.webContents.id || message.threadId !== entry.request.threadId) return true;
    const result = message.response.result;
    entry.resolve({ approved: result?.action === 'accept' && result.content?.decision === 'approve' });
    return true;
  }
  stop() { for (const entry of [...this.pending.values()]) entry.resolve({ approved: false }); }
}
module.exports = { NativeApprovals };
