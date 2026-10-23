'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic, json, identifier, terminal, check, alive } = require('./collaboration-store.cjs');
const { clean } = require('./agent-cli.cjs');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settled = new Set(['allowed', 'denied', 'cancelled', 'expired']);

class ApprovalQueue {
  constructor(store) {
    this.store = store; this.root = path.join(store.root, 'approvals');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  file(id) { return path.join(this.root, identifier(id) + '.json'); }
  read(id) { const value = json(this.file(id)); check(value.id === id, '审批记录无效'); return value; }
  list() { return fs.readdirSync(this.root).filter(n => /^[\w-]+\.json$/.test(n)).flatMap(n => { try { return [this.read(n.slice(0, -5))]; } catch { return []; } }); }
  valid(request) {
    try {
      const job = this.store.reconcile(this.store.job(request.jobId)), thread = this.store.thread(job.threadId);
      return request.action.nativeDecision === 'ask' && job.threadId === request.threadId && job.agent === request.agent && job.cwd === request.cwd &&
        !terminal.has(job.status) && !this.store.cancelled(job.id) && thread.enabled && thread.agents.includes(job.agent) &&
        Date.now() < request.expiresAt && request.actionHash === digest(request.action);
    } catch { return false; }
  }
  update(id, state, detail = {}) {
    const request = this.read(id);
    if (settled.has(request.state)) return request;
    if (!this.valid(request)) { state = Date.now() >= request.expiresAt ? 'expired' : 'cancelled'; detail = { reason: '审批已过期、任务结束或协作授权已撤销' }; }
    check(['pending', 'reviewing', 'human', ...settled].includes(state), '无效审批状态');
    const result = { ...request, state, ...detail, updatedAt: Date.now() };
    atomic(this.file(id), result); return result;
  }
  async request(job, action, { signal, onState, timeoutMs = 10 * 60 * 1000 } = {}) {
    check(action?.nativeDecision === undefined || action.nativeDecision === 'ask', '原生禁止动作不能升级审批');
    check(action && typeof action.toolName === 'string' && action.toolName.length > 0 && action.toolName.length <= 300, '审批缺少工具名称');
    check(Buffer.byteLength(JSON.stringify(action)) <= 256 * 1024, '审批动作过大，无法完整审阅');
    const value = { requestId: String(action.requestId || ''), toolName: action.toolName, input: action.input ?? {}, nativeDecision: action.nativeDecision || 'ask', forceHuman: action.forceHuman === true };
    const request = { schemaVersion: 1, id: crypto.randomUUID(), jobId: job.id, threadId: job.threadId, agent: job.agent, cwd: job.cwd,
      action: value, actionHash: digest(value), state: 'pending', reason: '', createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + timeoutMs };
    check(this.valid(request), '任务已失效，不能发起审批'); atomic(this.file(request.id), request);
    let lastState;
    while (true) {
      let current = this.read(request.id);
      check(current.actionHash === request.actionHash && digest(current.action) === request.actionHash && current.jobId === job.id && current.threadId === job.threadId, '审批动作发生变化，已拒绝');
      if (signal?.aborted || !this.valid(current)) current = this.update(request.id, 'cancelled', { reason: '任务取消或审批已过期' });
      if (current.state !== lastState) { lastState = current.state; onState?.(current); }
      if (settled.has(current.state)) return { behavior: current.state === 'allowed' && !signal?.aborted && this.valid(current) ? 'allow' : 'deny', reason: current.reason || '此次操作未获批准' };
      await pause(100);
    }
  }
}

class ApprovalProcessor {
  constructor({ queue, review, human, onChange = () => {} }) { this.queue = queue; this.review = review; this.human = human; this.onChange = onChange; this.active = new Map(); }
  async process(id) {
    if (this.active.has(id)) return this.active.get(id).promise;
    const abort = new AbortController();
    const entry = { abort };
    const promise = Promise.resolve().then(async () => {
      const claim = this.queue.file(id) + '.claim';
      try { if (fs.existsSync(claim) && !alive(Number(fs.readFileSync(claim, 'utf8')))) fs.unlinkSync(claim); } catch { return; }
      let fd;
      try { fd = fs.openSync(claim, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); }
      catch (error) { if (error.code === 'EEXIST') return; throw error; }
      try {
      let request = this.queue.read(id);
      if (settled.has(request.state)) return request;
      const job = this.queue.store.job(request.jobId);
      const monitor = setInterval(() => { try { const current = this.queue.read(id); if (settled.has(current.state) || !this.queue.valid(current)) abort.abort(); } catch { abort.abort(); } }, 200);
      monitor.unref?.();
      const change = (state, detail) => { request = this.queue.update(id, state, detail); this.onChange(request); return request; };
      try {
        if (!this.queue.valid(request)) return change('cancelled');
        let assessment;
        if (!request.action.forceHuman) {
          change('reviewing', { reason: 'Codex 正在审核此操作' });
          try { assessment = await this.review({ request, job, signal: abort.signal }); }
          catch (error) { assessment = { decision: 'manual', reason: 'Codex 审批不可用：' + clean(error.message, 500) }; }
          if (assessment?.decision === 'allow' && !abort.signal.aborted) return change('allowed', { reason: clean(assessment.reason || 'Codex 批准此次操作', 2000), approvedBy: 'codex' });
        }
        if (abort.signal.aborted || !this.queue.valid(request)) return change('cancelled');
        change('human', { reason: clean(request.action.forceHuman ? '原生规则要求人工审批' : assessment?.reason || 'Codex 未批准，请人工决定', 2000) });
        const answer = await this.human({ request, job, signal: abort.signal });
        return change(answer?.approved === true && !abort.signal.aborted ? 'allowed' : 'denied', { reason: answer?.approved === true ? '用户批准此次操作' : '用户未批准此次操作', approvedBy: answer?.approved === true ? 'user' : null });
      } catch (error) { return change('denied', { reason: clean(error.message, 1000) }); }
      finally { clearInterval(monitor); this.active.delete(id); }
      } finally { try { fs.unlinkSync(claim); } catch { /* Another shutdown already released it. */ } }
    }).finally(() => this.active.delete(id));
    entry.promise = promise; this.active.set(id, entry); return promise;
  }
  stop() { for (const value of this.active.values()) value.abort.abort(); }
}
function approvalSummary(queue, jobId) {
  const value = queue.list().filter(r => r.jobId === jobId).sort((a, b) => b.createdAt - a.createdAt)[0];
  return value ? { id: value.id, state: value.state, toolName: value.action.toolName, reason: value.reason, approvedBy: value.approvedBy || null } : null;
}
module.exports = { ApprovalQueue, ApprovalProcessor, approvalSummary, digest, settled };
