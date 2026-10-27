'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { AGENTS, validateAgentConfig } = require('./agent-cli.cjs');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
// Missing per-agent approval settings keep the conservative 0.1.0 behavior:
// Claude/Grok stay on their own CLI default (which asks before running tools)
// and only DSH enters the Codex approval path. Choosing 'auto' stays available
// in the collaboration panel, but it is never the silent default.
const approvalDefaults = Object.freeze({ claude: 'native', grok: 'native', dsh: 'codex' });
const check = (value, message) => { if (!value) throw new Error(message); };
function identifier(value) { check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value), '无效的对话或任务 ID'); return value; }
function defaultRoot() { return process.env.CODEX_FAST_COLLABORATION_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'fast-collaboration'); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function atomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    // Windows may briefly keep the destination open while another process
    // reads or replaces the same task record. Retry only transient rename
    // errors so a short collision does not kill a running worker.
    let renamed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { fs.renameSync(temporary, file); renamed = true; break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt === 7) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25 * (attempt + 1), 150));
      }
    }
    if (!renamed) throw Error('无法替换协作记录');
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function json(file, fallback) {
  try { check(fs.statSync(file).size <= 8 * 1024 * 1024, '协作记录过大'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
class CollaborationStore {
  constructor(root = defaultRoot()) {
    this.root = path.resolve(root);
    for (const directory of ['', 'threads', 'jobs', 'events', 'control', 'slots']) fs.mkdirSync(path.join(this.root, directory), { recursive: true, mode: 0o700 });
  }
  file(kind, id, suffix = '.json') { return path.join(this.root, kind, identifier(id) + suffix); }
  config() {
    const value = json(path.join(this.root, 'settings.json'), { schemaVersion: 1, concurrency: 1, agents: {} });
    // Existing r4 settings predate the per-agent approval selector. Keep an
    // explicit user choice; missing values fall back to CLI-native approval for
    // Claude/Grok and to the Codex path for DSH.
    return { schemaVersion: 1, concurrency: value.concurrency || 1, agents: Object.fromEntries(Object.keys(AGENTS).map(agent => [agent, validateAgentConfig({ approvalMode: approvalDefaults[agent], ...(value.agents?.[agent] || {}) })])) };
  }
  configure(value) {
    check(value && Object.keys(value).every(key => ['concurrency', 'agents'].includes(key)), '未知协作配置字段');
    const existing = this.config();
    const concurrency = value.concurrency ?? existing.concurrency;
    check(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 3, '并发数应为 1 到 3');
    check(!value.agents || Object.keys(value.agents).every(agent => AGENTS[agent]), '未知智能体');
    const agents = { ...existing.agents };
    for (const [agent, config] of Object.entries(value.agents || {})) agents[agent] = validateAgentConfig({ approvalMode: approvalDefaults[agent], ...config });
    check(!agents.dsh.model || agents.dsh.provider, 'DSH 模型覆盖需同时填写提供商 ID');
    const result = { schemaVersion: 1, concurrency, agents }; atomic(path.join(this.root, 'settings.json'), result); return result;
  }
  thread(id) { return json(this.file('threads', id), { schemaVersion: 1, id, enabled: false, agents: [], revision: 0 }); }
  saveThread(thread) { identifier(thread.id); atomic(this.file('threads', thread.id), thread); }
  threads() {
    return fs.readdirSync(path.join(this.root, 'threads')).filter(file => /^[A-Za-z0-9_-]+\.json$/.test(file)).flatMap(file => {
      try { return [this.thread(file.slice(0, -5))]; } catch { return []; }
    });
  }
  job(id) {
    const job = json(this.file('jobs', id));
    check(job.id === id && typeof job.threadId === 'string' && AGENTS[job.agent], '任务记录无效');
    return job;
  }
  saveJob(job) { atomic(this.file('jobs', job.id), job); }
  appendEvent(job, type, text) {
    identifier(job.id);
    const value = String(text ?? '');
    if (!value) return null;
    const event = { seq: (job.sequence || 0) + 1, type, text: value.slice(0, 16000), at: new Date().toISOString() };
    fs.appendFileSync(this.file('events', job.id, '.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    job.sequence = event.seq;
    job.outputChars = (job.outputChars || 0) + event.text.length;
    this.saveJob(job);
    return event;
  }
  jobs(threadId) {
    identifier(threadId);
    return fs.readdirSync(path.join(this.root, 'jobs')).filter(file => /^[A-Za-z0-9_-]+\.json$/.test(file)).flatMap(file => {
      try { const job = this.job(file.slice(0, -5)); return job.threadId === threadId ? [job] : []; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  cancel(id) { fs.writeFileSync(this.file('control', id, '.cancel'), 'cancel\n', { mode: 0o600 }); }
  cancelled(id) { return fs.existsSync(this.file('control', id, '.cancel')); }
  owner(id) {
    try { return json(this.file('control', id, '.owner'), null); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  }
  reconcile(job) {
    if (terminal.has(job.status)) return job;
    const owner = this.owner(job.id);
    const heartbeatAge = owner ? Date.now() - Date.parse(owner.updatedAt || owner.createdAt || job.createdAt) : Infinity;
    const stale = owner && heartbeatAge > 60000;
    // Windows process probes can briefly fail while the detached worker still
    // writes fresh heartbeats. Require a missed heartbeat before declaring loss.
    if ((!owner && Date.now() - Date.parse(job.updatedAt || job.createdAt) > 15000) || (owner && ((!alive(owner.pid) && heartbeatAge > 10000) || stale))) {
      // A lost worker is never silently rerun: a native agent may have already changed files.
      job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); job.error = '协作后台进程意外结束；已保留输出。请检查工作区后按需发起新任务。'; this.saveJob(job);
    }
    return job;
  }
  events(id, after = 0, limit = 200) {
    const file = this.file('events', id, '.jsonl');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8'), values = []; let bytes = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (value.seq <= after) continue;
      const size = Buffer.byteLength(line);
      if (values.length && (values.length >= limit || bytes + size > 256 * 1024)) break;
      bytes += size; values.push(value);
    }
    return values;
  }
}
module.exports = { CollaborationStore, defaultRoot, identifier, terminal, check, alive, atomic, json };
