'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const THREAD = /^[a-zA-Z0-9_-]{1,100}$/;
// Each app-server thread receives its own MCP process environment override.
// The model never chooses this token or supplies the current thread identity.
class ThreadContexts {
  constructor(root) { this.root = path.join(root, 'contexts'); fs.mkdirSync(this.root, { recursive: true }); this.pending = new Map(); this.bindings = new Map(); }
  bind(threadId, cwd) {
    if (!THREAD.test(threadId || '') || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
    const value = { threadId, cwd }; this.bindings.set(threadId, value);
    const target = path.join(this.root, '.thread-' + threadId + '.json');
    try { if (JSON.parse(fs.readFileSync(target, 'utf8')).cwd === cwd) return; } catch { /* First binding. */ }
    const temp = target + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, target);
  }
  binding(threadId) {
    if (!THREAD.test(threadId || '')) return {};
    try { const persisted = JSON.parse(fs.readFileSync(path.join(this.root, '.thread-' + threadId + '.json'), 'utf8')); if (persisted.threadId === threadId && typeof persisted.cwd === 'string' && path.isAbsolute(persisted.cwd)) { this.bindings.set(threadId, persisted); return persisted; } } catch { /* Older clients recorded only the MCP token file. */ }
    if (this.bindings.has(threadId)) return this.bindings.get(threadId);
    const matches = fs.readdirSync(this.root).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).flatMap(file => { try { const value = JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8')); return value.threadId === threadId && value.cwd && path.isAbsolute(value.cwd) ? [value] : []; } catch { return []; } }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (matches[0]) this.bind(threadId, matches[0].cwd);
    return this.bindings.get(threadId) || {};
  }
  file(token) { if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('Invalid conversation context'); return path.join(this.root, token + '.json'); }
  write(token, value) { const target = this.file(token), temp = target + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, target); }
  prepare(message) {
    const request = message?.request;
    if (!['mcp-request', 'thread-prewarm-start'].includes(message?.type) || (message.hostId && message.hostId !== 'local') || !['thread/start', 'thread/resume', 'thread/fork'].includes(request?.method)) return false;
    const params = request.params ||= {}, token = crypto.randomBytes(32).toString('hex');
    const threadId = request.method === 'thread/resume' && THREAD.test(params.threadId) ? params.threadId : null;
    this.write(token, { token, threadId, cwd: params.cwd || this.binding(threadId).cwd || null, createdAt: new Date().toISOString() });
    this.bind(threadId, params.cwd);
    params.config = { ...(params.config || {}), 'mcp_servers.fast_canvas.env.CODEX_FAST_CONTEXT_TOKEN': token };
    this.pending.set(request.id, token);
    return true;
  }
  response(message) {
    if (message?.type !== 'mcp-response') return;
    const response = message.message, token = this.pending.get(response?.id);
    if (!token) return;
    this.pending.delete(response.id);
    if (response.error) { fs.rmSync(this.file(token), { force: true }); return; }
    const thread = response.result?.thread;
    if (!THREAD.test(thread?.id || '')) return;
    const previous = JSON.parse(fs.readFileSync(this.file(token), 'utf8'));
    this.write(token, { ...previous, threadId: thread.id, cwd: thread.cwd || previous.cwd });
    this.bind(thread.id, thread.cwd || previous.cwd);
    return { threadId: thread.id, cwd: thread.cwd || previous.cwd };
  }
  resolve(token = process.env.CODEX_FAST_CONTEXT_TOKEN) {
    if (!token) return {};
    const value = JSON.parse(fs.readFileSync(this.file(token), 'utf8'));
    if (!THREAD.test(value.threadId || '')) throw Error('Conversation is still starting; retry shortly.');
    return { threadId: value.threadId, cwd: this.binding(value.threadId).cwd || value.cwd };
  }
}
function userSubmission(message) {
  if (message?.type !== 'mcp-request' || (message.hostId && message.hostId !== 'local')) return null;
  const request = message.request, params = request?.params;
  if (!['turn/start', 'turn/steer', 'turn/addUserMessage'].includes(request?.method) || !THREAD.test(params?.threadId || '') || !Array.isArray(params.input)) return null;
  const text = params.input.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
  return text ? { threadId: params.threadId, text, eventId: String(params.clientUserMessageId || request.id), cwd: params.cwd } : null;
}
module.exports = { ThreadContexts, userSubmission };
