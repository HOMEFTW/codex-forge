'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomic, json } = require('./collaboration-store.cjs');
const { ForgeError } = require('./forge-errors.cjs');
const { jsonValue, localName, fail } = require('./forge-backend-values.cjs');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const pluginId = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value) || value.length > 100) fail('插件 ID 无效');
  return value;
};
function cronField(text, low, high) {
  if (typeof text !== 'string' || text.length > 160) fail('cron 字段无效');
  const result = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) fail('cron 仅支持数字、范围、逗号与步长');
    const range = match[1] === '*' ? [low, high] : match[1].split('-').map(Number);
    const from = range[0], to = range[1] ?? from, step = Number(match[2] || 1);
    if (from < low || to > high || from > to || step < 1 || step > high - low + 1) fail('cron 字段超出范围');
    for (let value = from; value <= to; value += step) result.add(value);
  }
  return result;
}
function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 300) fail('cron 表达式无效');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) fail('cron 必须有五个字段：分 时 日 月 周');
  return { fields, sets: fields.map((value, i) => cronField(value, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i])) };
}
function nextCron(expression, after, timeZone = 'UTC') {
  const { fields, sets } = parseCron(expression), utc = timeZone === 'UTC';
  let format;
  try { if (!utc) format = new Intl.DateTimeFormat('en-US', { timeZone, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short', hourCycle: 'h23' }); }
  catch { fail('cron 时区无效'); }
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Search is bounded; malformed or impossible calendars cannot block the host indefinitely.
  for (let at = Math.floor(after / 60000) * 60000 + 60000, end = at + 366 * 86400000; at < end; at += 60000) {
    const date = new Date(at);
    let values;
    if (utc) values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
    else {
      const parts = Object.fromEntries(format.formatToParts(date).map(item => [item.type, item.value]));
      values = [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), weekdays[parts.weekday]];
    }
    const day = sets[2].has(values[2]), week = sets[4].has(values[4]) || values[4] === 0 && sets[4].has(7);
    const calendar = fields[2] === '*' ? week : fields[4] === '*' ? day : day || week;
    if (sets[0].has(values[0]) && sets[1].has(values[1]) && sets[3].has(values[3]) && calendar) return at;
  }
  fail('cron 在未来 366 天内没有运行时间');
}
function timing(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('计划 timing 无效');
  if (value.kind === 'at') {
    if (Object.keys(value).some(key => !['kind', 'at'].includes(key))) fail('at 计划包含未知字段');
    const at = typeof value.at === 'number' ? value.at : Date.parse(value.at);
    if (!Number.isFinite(at) || at <= now) fail('计划时间必须在将来');
    return { timing: { kind: 'at', at: new Date(at).toISOString() }, nextAt: at };
  }
  if (value.kind === 'every') {
    if (Object.keys(value).some(key => !['kind', 'intervalMs'].includes(key)) || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 366 * 86400000) fail('循环间隔应为 1 秒到 366 天');
    return { timing: { kind: 'every', intervalMs: value.intervalMs }, nextAt: now + value.intervalMs };
  }
  if (value.kind === 'cron') {
    if (Object.keys(value).some(key => !['kind', 'expression', 'timeZone'].includes(key))) fail('cron 计划包含未知字段');
    const timeZone = value.timeZone || 'UTC';
    return { timing: { kind: 'cron', expression: value.expression, timeZone }, nextAt: nextCron(value.expression, now, timeZone) };
  }
  fail('仅支持 at、every 和 cron 计划');
}
class ForgeTaskRuntime {
  constructor({ root, execute, onEvent = () => {}, isEnabled = () => true, now = Date.now, intervalMs = 1000, startTimer = true } = {}) {
    if (typeof execute !== 'function' || typeof root !== 'string') fail('后台任务需要存储目录与执行器');
    this.root = path.resolve(root); this.execute = execute; this.onEvent = onEvent; this.isEnabled = isEnabled; this.now = now; this.controllers = new Map(); this.completions = new Map(); this.closed = false;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.file = path.join(this.root, 'plugin-tasks.json');
    this.state = json(this.file, { schemaVersion: 1, jobs: {}, schedules: {} });
    if (this.state.schemaVersion !== 1 || !this.state.jobs || !this.state.schedules || Array.isArray(this.state.jobs) || Array.isArray(this.state.schedules)) fail('后台任务存储格式无效');
    let repaired = false;
    for (const job of Object.values(this.state.jobs)) {
      pluginId(job.pluginId); localName(job.method);
      if (!terminal.has(job.status)) { job.status = 'interrupted'; job.endedAt = this.now(); job.error = { code: 'INTERRUPTED', message: '宿主在上次任务完成前退出' }; repaired = true; }
    }
    for (const schedule of Object.values(this.state.schedules)) {
      pluginId(schedule.pluginId); localName(schedule.method);
      if (schedule.activeJobId) { schedule.activeJobId = null; repaired = true; }
    }
    if (repaired) this.save();
    if (startTimer) { this.timer = setInterval(() => { try { this.tick(); } catch (error) { this.emit('schedule.error', { error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }); } }, intervalMs); this.timer.unref?.(); }
  }
  emit(type, data) { try { this.onEvent({ type, ...data }); } catch { /* State commits are independent of UI observers. */ } }
  save() {
    const candidate = { ...this.state, jobs: { ...this.state.jobs } }, jobs = Object.values(candidate.jobs).sort((a, b) => a.createdAt - b.createdAt);
    while (jobs.length > 128 || Buffer.byteLength(JSON.stringify(candidate)) > 8 * 1024 * 1024) {
      const index = jobs.findIndex(job => terminal.has(job.status));
      if (index < 0) fail('后台任务存储数量或大小超过限制', 'RESOURCE_LIMIT');
      delete candidate.jobs[jobs[index].id]; jobs.splice(index, 1);
    }
    atomic(this.file, candidate); this.state.jobs = candidate.jobs;
  }
  copy(value) { return jsonValue(value, 256 * 1024); }
  assertOpen() { if (this.closed) fail('后台任务运行器已关闭', 'PLUGIN_DISABLED'); }
  own(plugin, kind, id) {
    pluginId(plugin);
    const record = this.state[kind][id];
    if (!record || record.pluginId !== plugin) fail('任务不存在或不属于此插件', 'NOT_FOUND');
    return record;
  }
  start(plugin, spec, context = {}, scheduleId = null) {
    this.assertOpen(); pluginId(plugin);
    if (!spec || typeof spec !== 'object' || Object.keys(spec).some(key => !['method', 'args', 'timeoutMs'].includes(key))) fail('后台任务参数无效');
    localName(spec.method);
    if (this.controllers.size >= 16) fail('后台任务并发超过 16', 'RESOURCE_LIMIT');
    if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 10 || spec.timeoutMs > 120000)) fail('任务超时应为 10–120000ms');
    const id = crypto.randomUUID(), controller = new AbortController();
    const job = { id, pluginId: plugin, method: spec.method, args: jsonValue(spec.args ?? {}, 64 * 1024), context: jsonValue(context, 16 * 1024), status: 'queued', createdAt: this.now(), timeoutMs: spec.timeoutMs || 30000, ...(scheduleId ? { scheduleId } : {}) };
    const schedule = scheduleId ? this.own(plugin, 'schedules', scheduleId) : null, priorJob = schedule?.activeJobId;
    if (schedule) schedule.activeJobId = id;
    this.state.jobs[id] = job; this.controllers.set(id, controller);
    try { this.save(); } catch (error) { delete this.state.jobs[id]; this.controllers.delete(id); if (schedule) schedule.activeJobId = priorJob; throw error; }
    this.emit('job.changed', { pluginId: plugin, job: this.copy(job) });
    const completion = Promise.resolve().then(() => this.perform(job, controller));
    this.completions.set(id, completion);
    completion.finally(() => this.completions.delete(id)).catch(error => this.emit('job.persistence-error', { pluginId: plugin, id, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }));
    return this.copy(job);
  }
  async perform(job, controller) {
    if (this.closed || controller.signal.aborted) return this.settle(job, controller, new ForgeError('CANCELLED', '任务已取消'));
    let timeout;
    try {
      job.status = 'running'; job.startedAt = this.now(); this.save(); this.emit('job.changed', { pluginId: job.pluginId, job: this.copy(job) });
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new ForgeError('CANCELLED', '任务已取消')), { once: true });
        timeout = setTimeout(() => controller.abort(new ForgeError('TIMEOUT', '后台任务超时')), job.timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => this.execute({ pluginId: job.pluginId, method: job.method, args: this.copy(job.args), context: this.copy(job.context), signal: controller.signal })), aborted]);
      this.settle(job, controller, null, jsonValue(result === undefined ? null : result, 32 * 1024));
    } catch (error) { this.settle(job, controller, error); }
    finally { clearTimeout(timeout); }
  }
  settle(job, controller, error, result) {
    if (!this.controllers.has(job.id)) return;
    this.controllers.delete(job.id); job.endedAt = this.now();
    if (error) {
      job.status = error.code === 'CANCELLED' || controller.signal.aborted && error.code !== 'TIMEOUT' && error.code !== 'PLUGIN_DISABLED' ? 'cancelled' : 'failed';
      job.error = { code: error.code || 'BACKEND_ERROR', message: String(error.message || error).slice(0, 4000) };
    } else { job.status = 'completed'; job.result = result; }
    if (job.scheduleId) {
      const schedule = this.state.schedules[job.scheduleId];
      if (schedule && schedule.activeJobId === job.id) {
        schedule.activeJobId = null; schedule.lastJobId = job.id; schedule.history = [...(schedule.history || []), job.id].slice(-20); schedule.updatedAt = this.now();
      }
    }
    try { this.save(); }
    catch (failure) {
      job.status = 'failed'; delete job.result;
      job.error = { code: 'PERSISTENCE_FAILED', message: '任务结果未能持久化：' + String(failure.message || failure).slice(0, 3000) };
      this.emit('job.persistence-error', { pluginId: job.pluginId, id: job.id, error: job.error });
    }
    this.emit('job.changed', { pluginId: job.pluginId, job: this.copy(job) });
  }
  read(plugin, id) { return this.copy(this.own(plugin, 'jobs', id)); }
  list(plugin) { pluginId(plugin); return Object.values(this.state.jobs).filter(job => job.pluginId === plugin).sort((a, b) => b.createdAt - a.createdAt).map(job => this.copy(job)); }
  cancel(plugin, id) {
    const job = this.own(plugin, 'jobs', id), controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) { job.status = 'cancelling'; try { this.save(); } finally { controller.abort(new ForgeError('CANCELLED', '任务已取消')); } }
    return this.copy(job);
  }
  createSchedule(plugin, spec, context = {}) {
    this.assertOpen(); pluginId(plugin);
    if (!spec || typeof spec !== 'object' || Object.keys(spec).some(key => !['name', 'method', 'args', 'timing', 'enabled', 'timeoutMs'].includes(key))) fail('计划参数无效');
    if (Object.values(this.state.schedules).filter(item => item.pluginId === plugin).length >= 100 || Object.keys(this.state.schedules).length >= 500) fail('计划数量超过限制', 'RESOURCE_LIMIT');
    if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 200 || spec.enabled !== undefined && typeof spec.enabled !== 'boolean') fail('计划名称或启停状态无效');
    localName(spec.method);
    if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 10 || spec.timeoutMs > 120000)) fail('计划执行超时无效');
    const clock = this.now(), next = timing(spec.timing, clock), id = crypto.randomUUID();
    const schedule = { id, pluginId: plugin, name: spec.name, method: spec.method, args: jsonValue(spec.args ?? {}, 64 * 1024), context: jsonValue(context, 16 * 1024), ...next, enabled: spec.enabled !== false, revision: 1, createdAt: clock, updatedAt: clock, activeJobId: null, history: [], timeoutMs: spec.timeoutMs || 30000 };
    this.state.schedules[id] = schedule;
    try { this.save(); } catch (error) { delete this.state.schedules[id]; throw error; }
    this.emit('schedule.changed', { pluginId: plugin, schedule: this.copy(schedule) }); return this.copy(schedule);
  }
  readSchedule(plugin, id) { return this.copy(this.own(plugin, 'schedules', id)); }
  listSchedules(plugin) { pluginId(plugin); return Object.values(this.state.schedules).filter(item => item.pluginId === plugin).map(item => this.copy(item)); }
  updateSchedule(plugin, id, expectedRevision, patch) {
    this.assertOpen(); const record = this.own(plugin, 'schedules', id);
    if (expectedRevision !== record.revision) fail('计划已被其他操作修改，请重新读取', 'REVISION_CONFLICT');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'method', 'args', 'timing', 'enabled', 'timeoutMs'].includes(key))) fail('计划补丁无效');
    const candidate = { ...record };
    if (patch.name !== undefined) { if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 200) fail('计划名称无效'); candidate.name = patch.name; }
    if (patch.method !== undefined) candidate.method = localName(patch.method);
    if (patch.args !== undefined) candidate.args = jsonValue(patch.args, 64 * 1024);
    if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') fail('计划启停状态无效'); candidate.enabled = patch.enabled; }
    if (patch.timeoutMs !== undefined) { if (!Number.isSafeInteger(patch.timeoutMs) || patch.timeoutMs < 10 || patch.timeoutMs > 120000) fail('计划执行超时无效'); candidate.timeoutMs = patch.timeoutMs; }
    if (patch.timing) Object.assign(candidate, timing(patch.timing, this.now()));
    else if (patch.enabled === true && !record.enabled) {
      if (candidate.timing.kind === 'at') { const at = Date.parse(candidate.timing.at); if (at <= this.now()) fail('已过期的单次计划需要新的时间'); candidate.nextAt = at; }
      else if (candidate.timing.kind === 'every') candidate.nextAt = this.now() + candidate.timing.intervalMs;
      else candidate.nextAt = nextCron(candidate.timing.expression, this.now(), candidate.timing.timeZone);
    }
    candidate.revision++; candidate.updatedAt = this.now(); this.state.schedules[id] = candidate;
    try { this.save(); } catch (error) { this.state.schedules[id] = record; throw error; }
    this.emit('schedule.changed', { pluginId: plugin, schedule: this.copy(candidate) }); return this.copy(candidate);
  }
  deleteSchedule(plugin, id, expectedRevision) {
    const schedule = this.own(plugin, 'schedules', id);
    if (expectedRevision !== schedule.revision) fail('计划已被其他操作修改，请重新读取', 'REVISION_CONFLICT');
    if (schedule.activeJobId && this.controllers.has(schedule.activeJobId)) this.cancel(plugin, schedule.activeJobId);
    delete this.state.schedules[id];
    try { this.save(); } catch (error) { this.state.schedules[id] = schedule; throw error; }
    this.emit('schedule.deleted', { pluginId: plugin, id }); return { removed: id };
  }
  runSchedule(plugin, id, advance = false) {
    this.assertOpen(); const schedule = this.own(plugin, 'schedules', id);
    if (schedule.activeJobId && this.controllers.has(schedule.activeJobId)) fail('此计划已有运行中的任务', 'TASK_BUSY');
    const previous = { ...schedule };
    if (advance) {
      const clock = this.now();
      if (schedule.timing.kind === 'at') { schedule.enabled = false; schedule.nextAt = null; }
      else if (schedule.timing.kind === 'every') schedule.nextAt += (Math.floor((clock - schedule.nextAt) / schedule.timing.intervalMs) + 1) * schedule.timing.intervalMs;
      else schedule.nextAt = nextCron(schedule.timing.expression, clock, schedule.timing.timeZone);
    }
    schedule.updatedAt = this.now();
    let job;
    try { job = this.start(plugin, { method: schedule.method, args: schedule.args, timeoutMs: schedule.timeoutMs }, schedule.context, id); }
    catch (error) { this.state.schedules[id] = previous; throw error; }
    this.emit('schedule.changed', { pluginId: plugin, schedule: this.copy(schedule) }); return job;
  }
  tick() {
    if (this.closed) return;
    const clock = this.now();
    for (const schedule of Object.values(this.state.schedules)) {
      if (!schedule.enabled || !this.isEnabled(schedule.pluginId) || schedule.nextAt > clock || schedule.activeJobId || this.controllers.size >= 16) continue;
      try {
        // The queued job, active marker and next occurrence commit together before execution.
        this.runSchedule(schedule.pluginId, schedule.id, true);
      } catch (error) {
        schedule.lastError = { code: error.code || 'INTERNAL_ERROR', message: String(error.message || error).slice(0, 4000) };
        schedule.enabled = false; this.save(); this.emit('schedule.error', { pluginId: schedule.pluginId, id: schedule.id, error: schedule.lastError });
      }
    }
  }
  dispatch(plugin, method, args = {}, context = {}) {
    switch (method) {
      case 'jobs.start': return this.start(plugin, args, context);
      case 'jobs.read': return this.read(plugin, args.id);
      case 'jobs.list': return this.list(plugin);
      case 'jobs.cancel': return this.cancel(plugin, args.id);
      case 'schedules.create': return this.createSchedule(plugin, args, context);
      case 'schedules.read': return this.readSchedule(plugin, args.id);
      case 'schedules.list': return this.listSchedules(plugin);
      case 'schedules.update': return this.updateSchedule(plugin, args.id, args.expectedRevision, args.patch);
      case 'schedules.delete': return this.deleteSchedule(plugin, args.id, args.expectedRevision);
      case 'schedules.run': return this.runSchedule(plugin, args.id);
      default: fail('后台任务方法不存在', 'METHOD_NOT_FOUND');
    }
  }
  disposePlugin(plugin) {
    for (const [id, controller] of this.controllers) if (this.state.jobs[id]?.pluginId === plugin) controller.abort(new ForgeError('PLUGIN_DISABLED', '插件停用，后台任务已停止'));
  }
  dispose() {
    this.closed = true; clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort(new ForgeError('CANCELLED', '宿主关闭，任务已取消'));
    return Promise.allSettled([...this.completions.values()]);
  }
}
module.exports = { ForgeTaskRuntime, nextCron, parseCron };
