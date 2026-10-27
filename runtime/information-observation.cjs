'use strict';
// Passive checks adapted from is-gpt-nerfed's rollout scanner (MIT).
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
class SessionObservation {
  constructor() {
    this.model = ''; this.effort = ''; this.window = null; this.used = null;
    this.applied = {}; this.events = []; this.turns = new Set(); this.models = new Map();
  }
  add(kind, severity, detail, at, turnId) {
    this.events.push({ kind, severity, detail, at, turnId: turnId || null });
    if (this.events.length > 80) this.events.shift();
  }
  observe(record, at) {
    const p = record.payload;
    if (record.type === 'turn_context') {
      if (p.turn_id) { this.turns.add(p.turn_id); if (this.turns.size > 10000) this.turns.delete(this.turns.values().next().value); }
      const model = p.model;
      const effort = p.collaboration_mode?.settings?.reasoning_effort || p.reasoning_effort || p.effort;
      if (typeof model === 'string' && model) {
        if (this.model !== model) {
          if (this.model) this.add('model_change', this.applied.model === model ? 'info' : 'warning', `${this.model} → ${model}${this.applied.model === model ? '（已应用设置）' : '（未见设置变更记录）'}`, at, p.turn_id);
          if (/^(gpt-reserve|codex-auto-review)(?:$|-)/i.test(model)) this.add('internal_model', 'warning', `日志记录了内部模型 ${model}`, at, p.turn_id);
          this.window = null; this.used = null;
        }
        this.models.set(model, (this.models.get(model) || 0) + 1);
        this.model = model;
        if (this.applied.model === model) delete this.applied.model;
      }
      if (typeof effort === 'string' && effort) {
        if (this.effort && effort !== this.effort) {
          const oldIndex = EFFORTS.indexOf(this.effort), newIndex = EFFORTS.indexOf(effort);
          const lower = newIndex >= 0 && oldIndex >= 0 && newIndex < oldIndex;
          this.add('effort_change', this.applied.reasoning_effort !== effort && lower ? 'warning' : 'info', `${this.effort} → ${effort}${this.applied.reasoning_effort === effort ? '（已应用设置）' : '（未见设置变更记录）'}`, at, p.turn_id);
        }
        this.effort = effort; if (this.applied.reasoning_effort === effort) delete this.applied.reasoning_effort;
      }
    }
    if (record.type === 'event_msg' && p.type === 'thread_settings_applied') this.applied = { ...(p.thread_settings || {}) };
    if (record.type === 'event_msg' && p.type === 'token_count') {
      const window = p.info?.model_context_window;
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
        if (this.window && window !== this.window) this.add('context_change', window < this.window ? 'warning' : 'info', `可用上下文 ${this.window.toLocaleString('en-US')} → ${window.toLocaleString('en-US')}`, at);
        this.window = window;
      }
      const usage = p.info?.last_token_usage;
      if (usage && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0) this.used = usage.total_tokens;
    }
  }
  snapshot() {
    return { model: this.model, effort: this.effort, turns: this.turns.size, models: [...this.models].map(([model, turns]) => ({ model, turns })), events: this.events.slice().reverse(), warnings: this.events.filter(event => event.severity === 'warning').length, contextWindow: this.window, contextUsed: this.used, contextPercent: this.window && this.used !== null ? this.used / this.window : null };
  }
}
module.exports = { SessionObservation };
