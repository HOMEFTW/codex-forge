"use strict";
const crypto = require('node:crypto');
const { predictPrompt } = require('./prompt-prediction.cjs');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

// Only main-process observations enter this controller. No renderer can nominate
// a source turn or initiate a fresh sample without a host-issued offer.
class PromptPredictionHost {
  constructor({ states, settings, call, sample, notify, recordOutput = () => null, nativeStatus = () => null, available = state => !!state.bridge, predict = predictPrompt }) {
    Object.assign(this, { states, settings, call, sample, notify, recordOutput, nativeStatus, available, predict });
    this.views = new Map(); this.latest = new Map(); this.samples = new Map(); this.attempts = new Map(); this.completedTurns = new Map();
  }
  enabled() { return !!this.settings()?.enabled && !this.nativeStatus()?.paused; }
  trim(map) { while (map.size > 256) map.delete(map.keys().next().value); }
  key(threadId, turnId) { return threadId + ':' + turnId; }
  view(state) {
    let view = this.views.get(state.win.id);
    if (!view) { view = { state, threadId: state.threadId || null, generation: 0, phase: 'idle' }; this.views.set(state.win.id, view); }
    return view;
  }
  rememberAttempt(view, attempt) {
    view.lastAttempt = attempt; this.attempts.delete(attempt.threadId); this.attempts.set(attempt.threadId, attempt); this.trim(this.attempts);
  }
  clear(view, emit = true, reason = 'cleared') {
    if (view.phase === 'pending' && view.lastAttempt) {
      this.rememberAttempt(view, { ...view.lastAttempt, phase: 'cancelled', reason, durationMs: Date.now() - view.lastAttempt.startedAt });
    }
    view.abort?.abort(failure('PREDICTION_CANCELLED', '预测已取消'));
    view.abort = null; view.ticket = null; view.text = null; view.turnId = null;
    view.phase = 'idle'; view.error = null; view.generation++;
    if (emit) this.emit(view);
  }
  snapshot(state) {
    const v = this.view(state);
    return { type: 'forge-prediction', threadId: v.threadId, generation: v.generation,
      native: this.nativeStatus(), phase: v.phase, ticket: v.ticket || null, sourceTurnId: v.turnId || null,
      text: v.phase === 'suggestion' ? v.text : null, error: v.error || null,
      diagnostics: { connected: !!this.available(state), rendererBridge: !!state.bridge, lastEvent: this.latest.get(v.threadId) || null,
        lastAttempt: this.attempts.get(v.threadId) || null,
        recentEvents: [...this.latest.values()].slice(-32), recentAttempts: [...this.attempts.values()].slice(-32) } };
  }
  emit(view) { if (!view.state.win.isDestroyed()) this.notify(view.state, this.snapshot(view.state)); }
  context(state, restore = true) {
    const v = this.view(state), threadId = state.threadId || null;
    if (v.threadId === threadId) return;
    this.clear(v, false, 'chat-changed'); v.threadId = threadId;
    if (!restore) return;
    const latest = this.latest.get(threadId), cached = latest && !latest.running && this.samples.get(this.key(threadId, latest.turnId));
    if (this.enabled() && cached?.text) this.offer(v, latest.turnId, cached.text);
    else if (this.enabled() && latest?.completed && !latest.running && !cached) this.offer(v, latest.turnId);
    else this.emit(v);
  }
  offer(v, turnId, text = null) {
    v.turnId = turnId; v.ticket = crypto.randomUUID(); v.generation++;
    v.phase = text ? 'suggestion' : 'offer'; v.text = text; v.error = null;
    this.emit(v);
  }
  observe(state, method, params) {
    if (!this.available(state) || state.win.isDestroyed()) return;
    this.observeNotification(method, params);
  }
  observeNotification(method, params) {
    if (!['turn/started', 'turn/completed'].includes(method) || !validId(params?.threadId) || !validId(params?.turn?.id)) return;
    const { threadId, turn } = params, previous = this.latest.get(threadId);
    if (this.completedTurns.has(this.key(threadId, turn.id))) return;
    if (method === 'turn/completed' && previous?.running && previous.turnId !== turn.id) return;
    // A delayed renderer copy of turn/started must not reopen a turn already
    // completed on the native host connection.
    if (method === 'turn/started' && previous?.turnId === turn.id && !previous.running) return;
    if (previous?.turnId === turn.id && previous.running === (method === 'turn/started')) return;
    if (method === 'turn/completed') { this.completedTurns.set(this.key(threadId, turn.id), true); this.trim(this.completedTurns); }
    this.latest.delete(threadId);
    this.latest.set(threadId, { threadId, method, turnId: turn.id, sourceTurnId: turn.id, status: turn.status, at: Date.now(),
      running: method === 'turn/started', completed: method === 'turn/completed' && turn.status === 'completed' }); this.trim(this.latest);
    // Remember all trusted local completions. Sampling still requires that
    // chat's visible composer; background work only records bounded metadata.
    for (const state of this.states.values()) {
      if (state.threadId !== threadId || !this.available(state) || state.win.isDestroyed()) continue;
      this.context(state, false);
      const view = this.view(state); this.clear(view, true, method === 'turn/started' ? 'new-turn' : 'turn-completed');
      if (method === 'turn/completed' && turn.status === 'completed' && this.enabled() && !this.samples.has(this.key(threadId, turn.id))) this.offer(view, turn.id);
    }
  }
  current(v, request) {
    const latest = this.latest.get(v.threadId);
    return !!this.enabled() && !v.state.win.isDestroyed() && v.state.threadId === v.threadId &&
      request.threadId === v.threadId && request.ticket === v.ticket && request.generation === v.generation &&
      !!v.ticket && latest?.turnId === v.turnId && !latest.running;
  }
  async request(state, request = {}) {
    this.context(state);
    if (request.action === 'status') return this.snapshot(state);
    const v = this.view(state);
    if (!this.current(v, request)) throw failure('PREDICTION_STALE', '预测上下文已变化');
    if (request.action === 'dismiss') {
      const cached = this.samples.get(this.key(v.threadId, v.turnId)); if (cached) cached.text = null;
      this.clear(v, true, 'dismissed-in-editor'); return true;
    }
    if (!['ready', 'accept'].includes(request.action)) throw failure('INVALID_ARGUMENT', '不支持的预测操作');
    if (typeof request.expectedText !== 'string' || request.expectedText.length > 64 || request.expectedText.trim()) throw failure('PREDICTION_DRAFT_CHANGED', '输入框已有草稿');
    if (request.action === 'accept') {
      if (v.phase !== 'suggestion' || !v.text) throw failure('PREDICTION_STALE', '建议已失效');
      const result = { text: v.text, expectedText: request.expectedText, threadId: v.threadId, ticket: v.ticket, generation: v.generation };
      const cached = this.samples.get(this.key(v.threadId, v.turnId)); if (cached) cached.text = null;
      v.phase = 'accepted'; v.text = null;
      return result;
    }
    if (v.phase !== 'offer') return this.snapshot(state);
    const key = this.key(v.threadId, v.turnId);
    if (this.samples.has(key)) { this.clear(v); return this.snapshot(state); }
    const settings = this.settings(), ticket = v.ticket, generation = v.generation, threadId = v.threadId, sourceTurnId = v.turnId;
    const cache = { text: null }; this.samples.set(key, cache); this.trim(this.samples);
    const attempt = { threadId, sourceTurnId, phase: 'pending', startedAt: Date.now() };
    this.rememberAttempt(v, attempt);
    const abort = new AbortController(); v.abort = abort; v.phase = 'pending'; this.emit(v);
    const stillCurrent = () => this.current(v, { threadId, ticket, generation }) && !abort.signal.aborted;
    let source;
    const call = async (method, params, options) => {
      if (!stillCurrent()) throw failure('PREDICTION_STALE', '预测上下文已变化');
      if (method !== 'thread/resume' || params?.threadId !== threadId || params.excludeTurns !== true ||
        Object.keys(params).some(key => !['threadId','excludeTurns','initialTurnsPage'].includes(key)) ||
        JSON.stringify(params.initialTurnsPage) !== JSON.stringify({ limit: 3, itemsView: 'summary', sortDirection: 'desc' })) {
        throw failure('PERMISSION_DENIED', '预测只允许读取当前聊天的近期文本');
      }
      const result = await this.call(state, method, params, { ...options, prediction: true });
      if (!stillCurrent()) throw failure('PREDICTION_STALE', '预测上下文已变化');
      source = result; return result;
    };
    const sample = options => {
      if (!stillCurrent() || options.signal?.aborted) throw failure('PREDICTION_STALE', '预测上下文已变化');
      if (source?.thread?.id !== threadId || source.initialTurnsPage?.data?.[0]?.id !== sourceTurnId || source.initialTurnsPage.data[0].status !== 'completed' ||
        options.sourceThreadId !== threadId || options.model !== source.model || options.modelProvider !== source.modelProvider || options.serviceTier !== (source.serviceTier ?? null) ||
        options.maxChars !== settings.maxChars || typeof options.prompt !== 'string' || options.prompt.length > 64000 ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > settings.timeoutSeconds * 1000) {
        throw failure('PERMISSION_DENIED', '预测只允许当前模型的受限后台请求');
      }
      if (typeof this.sample !== 'function') throw failure('PREDICTION_UNAVAILABLE', '预测后端未就绪');
      return this.sample(options);
    };
    try {
      const result = await this.predict({ call, sample, threadId, sourceTurnId, signal: abort.signal,
        prompt: settings.prompt, maxChars: settings.maxChars, timeoutMs: Math.round(settings.timeoutSeconds * 1000) });
      if (!stillCurrent()) return this.snapshot(state);
      if (result.threadId !== threadId || result.sourceTurnId !== sourceTurnId) throw failure('PREDICTION_STALE', '建议来源已变化');
      cache.text = result.text; v.text = result.text; v.phase = result.text ? 'suggestion' : 'idle';
      const outcome = result.outcome || (result.text ? 'suggestion' : 'empty');
      const completed = { ...attempt, phase: outcome, reason: result.reason || null, durationMs: Date.now() - attempt.startedAt };
      if (Object.hasOwn(result, 'rawOutput')) {
        try {
          completed.outputFile = this.recordOutput({ schemaVersion: 1, threadId, sourceTurnId, recordedAt: Date.now(), outcome,
            reason: result.reason || null, maxChars: settings.maxChars, rawOutput: result.rawOutput, rawOutputType: result.rawOutputType }) || null;
        } catch (error) { completed.outputRecordError = String(error.code || 'WRITE_FAILED').slice(0, 80); }
      }
      this.rememberAttempt(v, completed);
    } catch (error) {
      if (stillCurrent()) {
        v.phase = 'error'; v.error = { code: String(error.code || 'PREDICTION_UNAVAILABLE'), message: String(error.message || '预测不可用').slice(0, 300) };
        this.rememberAttempt(v, { ...attempt, phase: 'error', error: v.error, durationMs: Date.now() - attempt.startedAt });
      }
    } finally {
      if (v.abort === abort) v.abort = null;
      if (v.ticket === ticket && v.generation === generation) this.emit(v);
    }
    return this.snapshot(state);
  }
  nativeChanged() {
    // Account changes and native enablement invalidate all cached text, but keep
    // attempted turn IDs so a cancelled/failed sample is never retried.
    for (const cache of this.samples.values()) cache.text = null;
    for (const v of this.views.values()) {
      this.clear(v, false, 'native-policy-changed');
      const latest = this.latest.get(v.threadId);
      if (this.enabled() && latest?.completed && !latest.running && !this.samples.has(this.key(v.threadId, latest.turnId))) this.offer(v, latest.turnId);
      else this.emit(v);
    }
  }
  refresh() { for (const v of this.views.values()) this.clear(v, true, 'settings-changed'); for (const cache of this.samples.values()) cache.text = null; }
  invalidate(state) { this.clear(this.view(state), true, 'submitted'); }
  close(state) { const v = this.views.get(state.win.id); if (v) this.clear(v, false, 'window-closed'); this.views.delete(state.win.id); }
  stop() { for (const v of this.views.values()) this.clear(v, false, 'stopped'); this.views.clear(); this.samples.clear(); this.latest.clear(); this.attempts.clear(); this.completedTurns.clear(); }
}
module.exports = { PromptPredictionHost };
