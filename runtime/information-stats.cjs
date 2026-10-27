'use strict';

// Local session metrics and model fingerprint history. Session logs are read only;
// this service writes only its own bounded result records.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { analyzeGlobalOutputs } = require('./information-modeltrace.cjs');
const { SessionObservation } = require('./information-observation.cjs');
const bank = require('./information-bank.json');

const MAX_LINE = 32 * 1024 * 1024;
const MAX_READ_PER_REFRESH = 64 * 1024 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_PROBE_BYTES = 1024 * 1024;
const MAX_HISTORY = 20;
const MAX_OPEN_READERS = 8;
const MAX_THREAD_CACHES = 32;
const FINGERPRINT_TTL = 24 * 60 * 60 * 1000;
const SOURCES = new Set(['probe', 'manual', 'is-gpt-nerfed']);

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const count = value => typeof value === 'number' && !Number.isNaN(value)
  ? Math.max(0, Math.min(1e12, Math.trunc(value)))
  : 0;

function normalizeModel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[_ ]/g, '-')
    .replace(/^gpt(\d)/, 'gpt-$1');
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})$/);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = zoneText.replace(':', '');
  const zoneHour = zone.length > 1 ? Number(zone.slice(1, 3)) : 0;
  const zoneMinute = zone.length > 1 ? Number(zone.slice(3)) : 0;

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  const offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  return date.getTime() - offsetMinutes * 60_000;
}

function usage(value) {
  return Object.fromEntries([
    'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens',
  ].map(key => [key, count(value?.[key])]));
}

class CodexMetrics {
  constructor(seen = new Set()) {
    this.seen = seen;
    this.threadId = '';
    this.model = '';
    this.provider = '';
    this.effort = '';
    this.agentPath = '/root';
    this.createdAt = null;
    this.pendingAt = null;
    this.streaming = false;
    this.modernUsage = false;
    this.previousUsage = null;
    this.phase = 'idle';
    this.records = [];
    this.totals = new Map();
    this.malformed = 0;
    this.observation = new SessionObservation();
  }

  line(line) {
    if (typeof line !== 'string' || !line || line.length > MAX_LINE) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      this.malformed += 1;
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      this.malformed += 1;
      return;
    }

    const at = timestamp(record.timestamp);
    const payload = record.payload;
    if (at === null || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    if (record.type === 'session_meta') {
      if (this.createdAt !== null) return;
      this.createdAt = at;
      this.threadId = typeof payload.id === 'string' ? payload.id : '';
      this.provider = typeof payload.model_provider === 'string' ? payload.model_provider : '';
      this.agentPath = typeof payload.agent_path === 'string' ? payload.agent_path : '/root';
      return;
    }
    if (this.createdAt !== null && at < this.createdAt - 2_000) return;
    this.observation.observe(record, at);

    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) this.model = payload.model;
      if (typeof payload.collaboration_mode?.settings?.reasoning_effort === 'string') this.effort = payload.collaboration_mode.settings.reasoning_effort;
      else if (typeof payload.effort === 'string' && payload.effort) this.effort = payload.effort;
      else if (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort) this.effort = payload.reasoning_effort;
      return;
    }

    if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type)) {
      this.phase = 'idle';
      this.pendingAt = null;
      this.streaming = false;
      return;
    }

    const isResponseItem = record.type === 'response_item';
    const isEvent = record.type === 'event_msg';
    const isInput = (isEvent && ['task_started', 'user_message'].includes(payload.type))
      || (isResponseItem && (
        typeof payload.type === 'string' && payload.type.endsWith('_output')
        || payload.type === 'message' && ['user', 'developer', 'system'].includes(payload.role)
      ));
    const isMailboxMessage = isResponseItem && payload.type === 'agent_message' && payload.recipient === this.agentPath;

    if (isInput || isMailboxMessage) {
      if (!this.streaming) this.pendingAt = at;
      if (isInput) this.phase = 'generating';
      return;
    }

    const isAssistantWork = isResponseItem && (
      payload.type === 'reasoning'
      || typeof payload.type === 'string' && payload.type.endsWith('_call')
      || payload.type === 'message' && payload.role === 'assistant'
    );
    if (isAssistantWork) {
      this.streaming = true;
      this.phase = 'generating';
      return;
    }

    let key;
    let tokens;
    if (record.type === 'token_usage_record') {
      this.modernUsage = true;
      key = payload.response_id || `codex:${payload.thread_id || this.threadId}:${at}`;
      tokens = usage(payload.usage);
    } else if (isEvent && payload.type === 'token_count') {
      if (this.modernUsage) {
        if (this.streaming) {
          this.streaming = false;
          this.pendingAt = at;
          this.phase = 'tools';
        }
        return;
      }
      if (!payload.info) return;

      const total = usage(payload.info.total_token_usage);
      const last = usage(payload.info.last_token_usage || payload.info.total_token_usage);
      const delta = this.previousUsage && Object.fromEntries(
        Object.keys(total).map(name => [name, total[name] - this.previousUsage[name]]),
      );
      if (delta?.total_tokens === 0) return;
      tokens = !delta || Object.values(delta).some(value => value < 0) ? last : delta;
      this.previousUsage = total;
      key = `codex-legacy:${this.threadId}:${total.total_tokens}`;
    } else {
      return;
    }

    key = String(key);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 65_536) this.seen.delete(this.seen.values().next().value);

    const duration = this.pendingAt !== null && at >= this.pendingAt && at - this.pendingAt <= 900_000
      ? Math.max(500, at - this.pendingAt)
      : null;
    const response = {
      id: key,
      model: this.model,
      endMs: at,
      durationMs: duration,
      output: tokens.output_tokens,
      input: tokens.input_tokens,
      cachedInput: tokens.cached_input_tokens,
      reasoning: tokens.reasoning_output_tokens,
      tps: duration ? tokens.output_tokens * 1_000 / duration : null,
    };
    this.records.push(response);
    if (this.records.length > 120) this.records.shift();

    const model = normalizeModel(this.model);
    const total = this.totals.get(model) || {
      input: 0, cachedInput: 0, output: 0, reasoning: 0, responses: 0, measuredOutput: 0, measuredMs: 0,
    };
    total.input += response.input;
    total.cachedInput += response.cachedInput;
    total.output += response.output;
    total.reasoning += response.reasoning;
    total.responses += 1;
    if (duration) {
      total.measuredOutput += response.output;
      total.measuredMs += duration;
    }
    this.totals.set(model, total);
    this.pendingAt = at;
    this.streaming = false;
    this.phase = 'tools';
  }

  snapshot(modelName) {
    const model = modelName || this.model;
    const normalized = normalizeModel(model);
    const matching = this.records.filter(record => normalizeModel(record.model) === normalized);
    const measured = matching.filter(record => record.tps !== null);
    const total = this.totals.get(normalized);
    const average = total?.measuredMs ? total.measuredOutput * 1_000 / total.measuredMs : null;
    return {
      model,
      phase: normalized === normalizeModel(this.model) ? this.phase : 'idle',
      latest: measured.at(-1) || null,
      average,
      inputTokens: total?.input || 0,
      cachedInputTokens: total?.cachedInput || 0,
      outputTokens: total?.output || 0,
      reasoningTokens: total?.reasoning || 0,
      responses: total?.responses || 0,
      samples: measured.slice(-30),
      malformed: this.malformed,
      observation: this.observation.snapshot(),
      timing: 'end-to-end',
    };
  }
}

function assess(expected, analysis) {
  const results = Array.isArray(analysis?.results) ? analysis.results : [];
  const model = normalizeModel(expected);
  const best = results[0];
  if (!best) {
    const listed = bank.models.some(item => item.id === model);
    return { verdict: !model || listed ? 'NO_SAMPLE' : 'UNLISTED', warning: false };
  }
  if (!model) return { verdict: 'UNKNOWN', warning: false };

  const declared = results.find(item => normalizeModel(item.model) === model);
  if (!declared) return { verdict: 'UNLISTED', warning: false };
  const margin = best.score - declared.score;
  const expectedProbability = declared.probability;
  if (normalizeModel(best.model) === model) {
    return {
      verdict: 'MATCH', warning: false,
      confidence: best.probability >= 0.8 ? 'high' : 'low',
      pExpected: expectedProbability, margin,
    };
  }

  const strongEvidence = best.probability + 1e-9 >= 0.8
    && expectedProbability <= 0.2 + 1e-9
    && margin + 1e-9 >= 0.5
    && analysis.used_outputs >= 2;
  return {
    verdict: strongEvidence ? 'MISMATCH' : 'SUSPICIOUS',
    warning: true,
    confidence: strongEvidence ? 'high' : 'low',
    pExpected: expectedProbability,
    margin,
  };
}

function analyze(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 3) {
    throw new Error('请提供 1 至 3 组数字回答');
  }
  for (const output of outputs) {
    if (typeof output?.text !== 'string' || output.text.length > 50_000
      || !Number.isInteger(output.expected_count) || output.expected_count < 80 || output.expected_count > 500) {
      throw new Error('数字样本格式无效');
    }
  }
  return analyzeGlobalOutputs(outputs, bank);
}

async function safePath(root, file) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;

  let current = resolvedRoot;
  try {
    const rootStat = await fsp.lstat(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  } catch {
    return false;
  }

  for (const [index, part] of relative.split(path.sep).entries()) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) return false;
      if (index < relative.split(path.sep).length - 1 && !stat.isDirectory()) return false;
      if (index === relative.split(path.sep).length - 1 && !stat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function discover(root, threadId) {
  const files = [];
  const visited = { count: 0 };
  const maximumEntries = 20_000;

  async function walk(directory, depth) {
    if (depth > 6 || visited.count >= maximumEntries) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      visited.count += 1;
      if (visited.count > maximumEntries) break;
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) files.push(filename);
    }
  }

  try {
    const stat = await fsp.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
  } catch {
    return [];
  }
  await walk(root, 0);
  return files.sort();
}

function appendSessionText(reader, text) {
  const chunks = (reader.text + text).split('\n');
  reader.text = chunks.pop() || '';
  for (const line of chunks) {
    if (reader.dropping) {
      reader.dropping = false;
      continue;
    }
    reader.metrics.line(line);
  }
  if (reader.text.length > MAX_LINE) {
    reader.text = '';
    reader.dropping = true;
  }
}

async function readTail(file, limit) {
  const safe = await safePath(path.dirname(file), file);
  if (!safe) return null;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, limit);
    const start = Math.max(0, stat.size - size);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function isStoredRecord(record, threadId) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && validId(record.id) && record.threadId === threadId
    && typeof record.model === 'string' && SOURCES.has(record.source)
    && Number.isFinite(record.createdAt) && record.analysis && typeof record.analysis === 'object'
    && Array.isArray(record.analysis.results);
}

class InformationStats {
  constructor({ root, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), nerfedHome, now = Date.now, probeRunner } = {}) {
    const home = path.resolve(codexHome);
    this.root = path.resolve(root || path.join(home, 'forge', 'information-stats'));
    this.sessions = path.join(home, 'sessions');
    this.nerfedHome = path.resolve(nerfedHome || process.env.NERFED_HOME || path.join(home, 'is-gpt-nerfed'));
    this.now = now;
    this.probeRunner = probeRunner;
    this.readers = new Map();
    this.fileCache = new Map();
    this.locks = new Map();
    this.jobs = new Map();
  }

  async readMetrics(context) {
    const threadId = context?.threadId;
    if (!validId(threadId)) {
      return { model: context?.model || '', phase: 'idle', latest: null, samples: [], responses: 0, found: false };
    }

    let cached = this.fileCache.get(threadId);
    if (!cached || this.now() - cached.checkedAt > 30_000) {
      cached = { checkedAt: this.now(), paths: await discover(this.sessions, threadId) };
      this.fileCache.set(threadId, cached);
    }
    if (context.sessionPath && !cached.paths.includes(context.sessionPath)
      && await safePath(this.sessions, context.sessionPath)) {
      cached.paths.unshift(context.sessionPath);
    }

    const candidates = [];
    for (const file of cached.paths) {
      if (!await safePath(this.sessions, file)) continue;
      let stat;
      try { stat = await fsp.lstat(file); }
      catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;

      let reader = this.readers.get(file);
      const replaced = reader && (stat.size < reader.offset
        || stat.ino && reader.ino && stat.ino !== reader.ino
        || stat.mtimeMs !== reader.mtimeMs && stat.size === reader.offset);
      if (!reader || replaced) {
        reader = {
          offset: 0,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          text: '',
          dropping: false,
          decoder: new StringDecoder('utf8'),
          metrics: new CodexMetrics(),
        };
        this.readers.set(file, reader);
      }

      const end = Math.min(stat.size, reader.offset + MAX_READ_PER_REFRESH);
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      let handle;
      try {
        handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
        const opened = await handle.stat();
        if (!opened.isFile() || stat.ino && opened.ino && stat.ino !== opened.ino) continue;
        const buffer = Buffer.alloc(256 * 1024);
        while (reader.offset < end) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - reader.offset), reader.offset);
          if (!bytesRead) break;
          reader.offset += bytesRead;
          appendSessionText(reader, reader.decoder.write(buffer.subarray(0, bytesRead)));
        }
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
        reader.mtimeMs = stat.mtimeMs;
      }

      if (reader.metrics.threadId === threadId) candidates.push({ reader, stat });
    }

    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    const selected = candidates[0];
    while (this.readers.size > MAX_OPEN_READERS) this.readers.delete(this.readers.keys().next().value);
    while (this.fileCache.size > MAX_THREAD_CACHES) this.fileCache.delete(this.fileCache.keys().next().value);
    if (!selected) {
      return { model: context.model || '', phase: 'idle', latest: null, samples: [], responses: 0, found: false };
    }
    return {
      ...selected.reader.metrics.snapshot(context.model),
      provider: selected.reader.metrics.provider,
      effort: selected.reader.metrics.effort,
      reading: selected.reader.offset < selected.stat.size,
      found: true,
    };
  }

  exclusive(key, work) {
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(key, current);
    current.finally(() => {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }).catch(() => {});
    return current;
  }

  async records(threadId) {
    if (!validId(threadId)) return [];
    const file = path.join(this.root, `${threadId}.json`);
    if (!await safePath(this.root, file)) return [];
    try {
      const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let value;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) return [];
        value = JSON.parse(await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
      return Array.isArray(value) ? value.filter(record => isStoredRecord(record, threadId)).slice(0, MAX_HISTORY) : [];
    } catch {
      return [];
    }
  }

  async save(context, analysis, source, createdAt = this.now()) {
    if (!validId(context.threadId) || !SOURCES.has(source)) throw new Error('统计记录参数无效');
    const record = {
      id: crypto.randomUUID(),
      threadId: context.threadId,
      model: context.model,
      provider: context.provider || '',
      effort: context.effort || '',
      createdAt,
      source,
      analysis,
    };

    await this.exclusive(context.threadId, async () => {
      await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
      const rootStat = await fsp.lstat(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('统计记录目录无效');
      const file = path.join(this.root, `${context.threadId}.json`);
      try {
        const existing = await fsp.lstat(file);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('统计记录文件无效');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const data = [record, ...await this.records(context.threadId)].slice(0, MAX_HISTORY);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      const handle = await fsp.open(temporary, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(data), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fsp.rename(temporary, file);
      } finally {
        await fsp.rm(temporary, { force: true }).catch(() => {});
      }
    });
    return record;
  }

  async snapshot(context = {}) {
    const threadId = validId(context.threadId) ? context.threadId : '';
    const speed = await this.exclusive(`log:${threadId}`, () => this.readMetrics({ ...context, threadId }));
    const model = context.model || speed.model || '';
    const provider = context.provider || speed.provider || '';
    const effort = context.effort || speed.effort || '';
    const records = await this.records(threadId);
    const current = records.find(record => normalizeModel(record.model) === normalizeModel(model)
      && (record.provider || '') === provider
      && (record.effort || '') === effort);
    const createdAt = current?.createdAt || null;
    const stale = Boolean(current && (this.now() - createdAt > FINGERPRINT_TTL || createdAt > this.now() + 60_000));
    const judgment = assess(model, current?.analysis);
    const fingerprint = {
      ...judgment,
      stale,
      warning: !stale && judgment.warning,
      expected: model,
      prediction: current?.analysis?.prediction || null,
      probability: current?.analysis?.probability ?? null,
      usedOutputs: current?.analysis?.used_outputs || 0,
      results: current?.analysis?.results || [],
      diagnostics: current?.analysis?.diagnostics || [],
      families: current?.analysis?.family_probabilities || [],
      calibration: current?.analysis?.calibration || null,
      createdAt,
      source: current?.source || '',
      pExpected: judgment.pExpected ?? null,
      margin: judgment.margin ?? null,
    };
    const history = records.map(record => ({
      id: record.id,
      model: record.model,
      createdAt: record.createdAt,
      source: record.source,
      prediction: record.analysis?.prediction,
      verdict: assess(record.model, record.analysis).verdict,
    }));

    return {
      threadId: threadId || null,
      model,
      provider,
      effort,
      speed,
      fingerprint,
      history,
      job: this.publicJob(threadId),
      bank: { builtAt: bank.built_at, models: bank.models.map(item => item.id), ttlHours: 24 },
    };
  }

  publicJob(threadId) {
    const job = this.jobs.get(threadId);
    if (!job) return null;
    return {
      status: job.status,
      completed: job.completed,
      total: 3,
      error: job.error || '',
    };
  }

  async importLatest(context) {
    const index = path.join(this.nerfedHome, 'probes.jsonl');
    const text = await readTail(index, MAX_LEDGER_BYTES);
    if (text === null) throw new Error('未找到 is-gpt-nerfed 本地检测记录');
    const rows = text.split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line);
        return row && typeof row === 'object' && !Array.isArray(row) ? [row] : [];
      } catch {
        return [];
      }
    }).reverse();

    for (const row of rows) {
      if ((row.thread_id || row.threadId) !== context.threadId
        || normalizeModel(row.expected) !== normalizeModel(context.model)
        || !validId(row.id)) continue;
      const finished = timestamp(row.finished);
      if (finished === null || this.now() - finished > FINGERPRINT_TTL || finished > this.now() + 60_000) continue;

      const filename = path.join(this.nerfedHome, 'probes', `${row.id}.json`);
      if (!await safePath(this.nerfedHome, filename)) continue;
      try {
        const stat = await fsp.stat(filename);
        if (stat.size > MAX_PROBE_BYTES) continue;
        const full = JSON.parse(await fsp.readFile(filename, 'utf8'));
        if (!full || typeof full !== 'object' || Array.isArray(full)
          || (full.thread_id || full.threadId) !== context.threadId
          || normalizeModel(full.expected) !== normalizeModel(context.model)) continue;

        const thread = full.thread || {};
        const provider = thread.modelProvider || thread.model_provider || thread.provider;
        const effort = thread.reasoningEffort || thread.reasoning_effort || thread.effort || '';
        const outputs = full.outputs || full.answers;
        if (!provider || provider !== context.provider || (effort || '') !== (context.effort || '')
          || !Array.isArray(outputs)) continue;

        const result = analyze(outputs.slice(0, 3).map(item => ({
          text: item?.text,
          expected_count: item?.expected_count,
        })));
        await this.save(context, result, 'is-gpt-nerfed', finished);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  pruneJobs() {
    while (this.jobs.size > MAX_THREAD_CACHES) {
      const finished = [...this.jobs].find(([, job]) => job.status !== 'running');
      if (!finished) return;
      this.jobs.delete(finished[0]);
    }
  }

  async dispatch(method, args = {}, context = {}) {
    if (!validId(context.threadId)) {
      if (method === 'snapshot') return this.snapshot(context);
      throw new Error('请先打开一个已保存的对话');
    }
    if (args.threadId !== undefined && args.threadId !== context.threadId) {
      throw new Error('当前对话已变化，请刷新统计面板');
    }
    if (method === 'snapshot') return this.snapshot(context);
    if (!['analyze', 'import', 'probe', 'cancel'].includes(method)) throw new Error('不支持的统计操作');

    const current = await this.snapshot(context);
    const pinnedContext = {
      ...context,
      model: current.model,
      provider: current.provider,
      effort: current.effort,
    };
    if (method === 'analyze') {
      if (!pinnedContext.model) throw new Error('尚未确认当前模型，请先发送一条消息');
      await this.save(pinnedContext, analyze(args.outputs), 'manual');
      return this.snapshot(pinnedContext);
    }
    if (method === 'import') {
      if (!pinnedContext.model || !pinnedContext.provider) throw new Error('尚未确认当前模型及提供商');
      if (!await this.importLatest(pinnedContext)) {
        throw new Error('没有可用于当前模型、提供商和思考强度的近期数字样本');
      }
      return this.snapshot(pinnedContext);
    }
    if (method === 'cancel') {
      this.jobs.get(pinnedContext.threadId)?.controller.abort();
      return this.snapshot(pinnedContext);
    }

    if (!pinnedContext.model || !pinnedContext.provider) throw new Error('尚未确认当前模型及提供商');
    if (!this.probeRunner) throw new Error('当前客户端没有可用的检测运行时，可粘贴数字样本分析');
    if (this.jobs.get(pinnedContext.threadId)?.status === 'running') throw new Error('此对话正在检测');
    if ([...this.jobs.values()].some(job => job.status === 'running')) throw new Error('已有模型检测在运行，请稍候');

    const controller = new AbortController();
    const job = { status: 'running', completed: 0, controller, error: '' };
    this.jobs.set(pinnedContext.threadId, job);
    this.pruneJobs();

    Promise.resolve()
      .then(() => this.probeRunner({
        ...pinnedContext,
        signal: controller.signal,
        onProgress: completed => { job.completed = Math.max(0, Math.min(3, Math.trunc(completed || 0))); },
      }))
      .then(outputs => {
        if (controller.signal.aborted) throw new Error('检测已取消');
        return this.save(pinnedContext, analyze(outputs), 'probe');
      })
      .then(() => { job.status = 'completed'; })
      .catch(error => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = String(error?.message || error).slice(0, 500);
      });
    return this.snapshot(pinnedContext);
  }

  stop() {
    for (const job of this.jobs.values()) job.controller.abort();
  }
}

module.exports = { InformationStats, CodexMetrics, normalizeModel, timestamp, assess, analyze, safePath };
