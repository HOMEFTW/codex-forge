'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { CollaborationStore, identifier, terminal, check, alive, atomic, json } = require('./collaboration-store.cjs');
const { clean, invocation, resolveCommand } = require('./agent-cli.cjs');
const { attachApprovalSession } = require('./agent-approval-session.cjs');
const { dshInvocation, attachDshApprovalSession } = require('./dsh-approval-session.cjs');
const { ApprovalQueue } = require('./approval-broker.cjs');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const code = await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', () => resolve(-1)); killer.once('close', resolve);
    });
    if (code !== 0) try { child.kill(); } catch { /* Already closed. */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* Already closed. */ } }
    await pause(100);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already closed. */ }
  }
}
async function acquireSlot(store, job, stopped) {
  const directory = path.join(store.root, 'slots'), guard = path.join(directory, '.scheduler');
  while (!stopped()) {
    const thread = store.thread(job.threadId);
    if (!thread.enabled || !thread.agents.includes(job.agent)) return null;
    let fd;
    try {
      try { fd = fs.openSync(guard, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(guard, 'utf8'));
        if (!alive(pid)) try { fs.unlinkSync(guard); } catch { /* Another worker reclaimed it. */ }
      }
      if (fd !== undefined) {
        const holders = [];
        for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.slot'))) {
          const target = path.join(directory, file), holder = json(target, null);
          let live = false;
          if (holder && alive(holder.pid)) {
            try {
              const held = store.job(holder.jobId), owner = store.owner(holder.jobId);
              live = !terminal.has(held.status) && owner?.pid === holder.pid && Date.now() - Date.parse(owner.updatedAt || owner.createdAt) <= 60000;
            } catch { /* Invalid holders do not block the queue forever. */ }
          }
          if (live) holders.push(holder);
          else try { fs.unlinkSync(target); } catch { /* Already reclaimed. */ }
        }
        const pending = fs.readdirSync(path.join(store.root, 'jobs')).filter(file => file.endsWith('.json')).flatMap(file => {
          try { const other = store.job(file.slice(0, -5)), owner = store.owner(other.id); return other.status === 'queued' && owner && alive(owner.pid) && !store.cancelled(other.id) ? [other] : []; } catch { return []; }
        }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        if (holders.length < store.config().concurrency && pending[0]?.id === job.id) {
          const slot = path.join(directory, `${job.id}.slot`); atomic(slot, { pid: process.pid, jobId: job.id }); return slot;
        }
      }
    } finally { if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(guard); } catch { /* Process shutdown. */ } } }
    await pause(120);
  }
  return null;
}
async function runWorker(root, jobId) {
  const store = new CollaborationStore(root), job = store.job(identifier(jobId));
  if (terminal.has(job.status)) return;
  const ownerFile = store.file('control', job.id, '.owner');
  let owner;
  try { owner = fs.openSync(ownerFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  const ownerState = { pid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(owner, JSON.stringify(ownerState)); fs.closeSync(owner);
  let child = null, slot = null, tick, timeout, session, interrupted = false, timedOut = false, cancelled = false, stopped = false, lastSave = 0;
  const approvalQueue = new ApprovalQueue(store), approvalAbort = new AbortController(), approvals = new Map();
  const heartbeat = setInterval(() => {
    try {
      if (terminal.has(store.job(job.id).status)) { interrupted = true; if (child) killTree(child).catch(() => {}); return; }
      ownerState.updatedAt = new Date().toISOString(); atomic(ownerFile, ownerState);
    } catch { interrupted = true; if (child) killTree(child).catch(() => {}); }
  }, 1500);
  const taskFile = store.file('control', job.id, '.prompt'), patchFile = store.file('control', job.id, '.patch.json');
  const save = () => { job.updatedAt = new Date().toISOString(); job.workerPid = process.pid; store.saveJob(job); lastSave = Date.now(); };
  const append = (type, value) => {
    if (!value || stopped) return;
    const max = 4 * 1024 * 1024;
    let remaining = max - job.outputChars;
    if (remaining <= 0) { job.truncated = true; return; }
    const text = clean(value, remaining);
    for (let at = 0; at < text.length; at += 16000) {
      const part = text.slice(at, at + 16000);
      fs.appendFileSync(store.file('events', job.id, '.jsonl'), JSON.stringify({ seq: ++job.sequence, type, text: part, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      job.outputChars += part.length;
    }
    if (String(value).length > remaining) job.truncated = true;
    if (Date.now() - lastSave > 120) save();
  };
  const requestStop = async reason => {
    approvalAbort.abort(); session?.dispose();
    if (reason === 'interrupted') interrupted = true;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'cancelled') cancelled = true;
    if (child) await killTree(child);
  };
  const signal = () => { requestStop('interrupted').catch(() => {}); };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  try {
    save();
    slot = await acquireSlot(store, job, () => interrupted || store.cancelled(job.id));
    if (!slot) { job.status = interrupted ? 'interrupted' : 'cancelled'; job.error = interrupted ? '后台进程已停止' : '用户取消或已停用此对话协作'; return; }
    const current = store.thread(job.threadId);
    check(current.enabled && current.agents.includes(job.agent), '本对话协作授权已撤销');
    check(!store.cancelled(job.id), '任务已取消');
    fs.writeFileSync(taskFile, job.prompt, { mode: 0o600 });
    const command = job.agent === 'dsh' ? dshInvocation(job.agentConfig, resolveCommand('dsh', job.agentConfig, process.execPath), { patchFile }) : invocation(job.agent, job.agentConfig, { nodePath: process.execPath, taskFile, patchFile, sessionId: job.resumeSessionId });
    const decoder = new StringDecoder('utf8'); let stderr = '';
    const stderrLine = chunk => {
      stderr += decoder.write(chunk);
      let at; while ((at = stderr.indexOf('\n')) >= 0) { append('stderr', stderr.slice(0, at)); stderr = stderr.slice(at + 1); }
      if (stderr.length > 64000) { append('stderr', stderr); stderr = ''; }
    };
    child = spawn(command.command, command.args, { cwd: job.cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_FAST_COLLABORATION_CHILD: '1' } });
    const exited = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    child.stderr.on('data', chunk => { try { stderrLine(chunk); } catch (error) { job.error = clean(error.message); requestStop('interrupted').catch(() => {}); } });
    child.stdin.on('error', () => {});
    job.status = 'running'; job.childPid = child.pid || null; job.startedAt = new Date().toISOString(); save();
    const requestPermission = async action => {
      const key = Symbol(), abort = new AbortController(), cancel = () => abort.abort();
      action.signal?.addEventListener('abort', cancel, { once: true }); approvalAbort.signal.addEventListener('abort', cancel, { once: true });
      if (action.signal?.aborted || approvalAbort.signal.aborted) abort.abort();
      approvals.set(key, null);
      try {
        return await approvalQueue.request(job, action, { signal: abort.signal, onState: value => {
          const summary = { id: value.id, state: value.state, toolName: value.action.toolName, reason: value.reason, approvedBy: value.approvedBy || null };
          approvals.set(key, summary); job.approval = summary; job.status = 'awaiting_approval'; save();
          append('approval', `${summary.toolName} · ${summary.reason || '等待 Codex 审批'}`);
        } });
      } finally {
        action.signal?.removeEventListener('abort', cancel); approvalAbort.signal.removeEventListener('abort', cancel); approvals.delete(key);
        if (!stopped && !approvalAbort.signal.aborted) { job.status = approvals.size ? 'awaiting_approval' : 'running'; if (approvals.size) job.approval = [...approvals.values()].find(Boolean) || job.approval; save(); }
      }
    };
    const attach = job.agent === 'dsh' ? attachDshApprovalSession : attachApprovalSession;
    session = attach({ agent: job.agent, child, task: job.prompt, cwd: job.cwd, config: job.agentConfig, sessionId: job.resumeSessionId, emit: append, requestPermission });
    let stopping = false;
    tick = setInterval(() => {
      if (stopping) return;
      try {
        const thread = store.thread(job.threadId);
        if (store.cancelled(job.id) || !thread.enabled || !thread.agents.includes(job.agent)) { stopping = true; requestStop('cancelled').catch(() => {}); }
        else if (Date.now() - lastSave > 250) save();
      } catch (error) { job.error = clean(error.message); stopping = true; requestStop('interrupted').catch(() => {}); }
    }, 120);
    timeout = setTimeout(() => { requestStop('timeout').catch(() => {}); }, job.timeoutMs);
    const parsed = await session.completion;
    approvalAbort.abort();
    // Reap ACP servers which keep running after their completed prompt.
    let exit = await Promise.race([exited, pause(1500).then(() => null)]);
    if (!exit) { await killTree(child); exit = await exited; exit.protocolCompleted = true; }
    clearInterval(tick); clearTimeout(timeout);
    stderr += decoder.end(); if (stderr) append('stderr', stderr);
    job.finalText = parsed.finalText; job.sessionId = parsed.sessionId; job.finalTruncated = parsed.finalTruncated;
    if (interrupted) { job.status = 'interrupted'; job.error ||= '协作后台进程已停止'; }
    else if (cancelled || store.cancelled(job.id)) { job.status = 'cancelled'; job.error = '任务已取消'; }
    else if (timedOut) { job.status = 'failed'; job.error = '智能体运行超时，已停止进程树'; }
    else if (exit.error || (exit.code !== 0 && !exit.protocolCompleted) || parsed.failure || parsed.permissionDenied) { job.status = 'failed'; job.error = clean(exit.error?.message || parsed.failure || (parsed.permissionDenied ? '此次任务包含未获批准的操作，请检查保留的输出' : `智能体退出码 ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`)); }
    else { job.status = 'completed'; }
    job.exitCode = exit.code ?? null;
  } catch (error) {
    if (child) await killTree(child);
    job.status = store.cancelled(job.id) ? 'cancelled' : 'failed'; job.error = clean(error.message);
  } finally {
    stopped = true; approvalAbort.abort(); session?.dispose(); clearInterval(tick); clearTimeout(timeout); clearInterval(heartbeat); process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal);
    job.finishedAt = new Date().toISOString(); save();
    for (const target of [slot, taskFile, patchFile]) if (target) try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') { /* Preserve completed state even if cleanup fails. */ } }
  }
}
if (require.main === module) runWorker(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
module.exports = { runWorker, killTree, acquireSlot };
