"use strict";
// Main-process only. Reads native settings and account metadata; never tokens or model output.
const KEY = 'composer-predictions-enabled';
// Mirrors native iKxu.k in Codex 26.1103.7773.0 (individual Pro plan family).
const PRO_PLANS = new Set(['prolite', 'pro', 'promax']);
class NativePredictionPolicy {
  constructor(onChange = () => {}, onNotification = () => {}) {
    this.onChange = onChange; this.onNotification = onNotification; this.epoch = 0; this.ready = false; this.nativeEnabled = null;
    this.pro = false; this.attached = false; this.disposers = []; this.connectionDisposers = [];
  }
  get allowed() { return this.nativeEnabled === false || this.ready && this.nativeEnabled === true && !this.pro; }
  snapshot() {
    return { ready: this.ready, nativeEnabled: this.nativeEnabled, pro: this.pro, paused: !this.allowed,
      reason: this.allowed ? null : !this.ready || this.nativeEnabled === null ? '正在确认原生账号与预测设置' : '原生 Pro 预测已开启，Forge 预测暂停' };
  }
  changed() { this.onChange(this.snapshot()); }
  attach({ settings, connections, hostId }) {
    this.dispose(); this.attached = true; this.settings = settings; this.connections = connections; this.hostId = hostId;
    const readSetting = () => { try { const value = settings.getEffective(KEY); this.nativeEnabled = typeof value === 'boolean' ? value : null; } catch { this.nativeEnabled = null; } };
    readSetting();
    this.disposers.push(settings.onDidChange(KEY, () => {
      const previous = this.nativeEnabled; readSetting();
      if (this.nativeEnabled !== previous) this.changed();
    }));
    this.disposers.push(connections.subscribe(event => {
      if (event.hostId !== hostId) return;
      if (event.type === 'removed') { if (event.connection === this.connection) this.bind(null); }
      else this.bind(event.connection);
    }));
    this.bind(connections.getMaybeConnection(hostId));
    return { dispose: () => this.dispose() };
  }
  bind(connection) {
    if (connection && connection === this.connection) return;
    for (const dispose of this.connectionDisposers.splice(0)) dispose();
    this.connection = connection; this.epoch++; this.ready = false; this.pro = false; this.changed();
    if (!connection) return;
    this.connectionDisposers.push(connection.registerInternalNotificationHandler(event => {
      this.onNotification(event);
      if (event.method === 'account/updated' || event.method === 'account/login/completed') this.refresh();
    }));
    this.connectionDisposers.push(connection.registerInternalAuthenticatedPrincipalChangeHandler(() => this.refresh()));
    this.connectionDisposers.push(connection.registerInternalConnectionStateHandler(state => {
      if (state === 'connected') this.refresh();
      else { this.epoch++; this.ready = false; this.changed(); }
    }));
    this.refresh();
  }
  async refresh() {
    const connection = this.connection, epoch = ++this.epoch;
    this.ready = false; this.pro = false; this.changed();
    if (!connection) return;
    try {
      const result = await connection.getAccount({ priority: 'background', timeoutMs: 10000 });
      if (!this.attached || epoch !== this.epoch || connection !== this.connection) return;
      // A known Pro account always takes precedence, even if the selected model
      // is ineligible for native prediction. Never infer a plan from provider names.
      this.pro = result.account?.type === 'chatgpt' && PRO_PLANS.has(result.account.planType);
      this.ready = typeof result.requiresOpenaiAuth === 'boolean';
    } catch { if (!this.attached || epoch !== this.epoch) return; this.ready = false; }
    this.changed();
  }
  dispose() {
    this.attached = false; this.epoch++; this.ready = false; this.pro = false; this.nativeEnabled = null;
    for (const dispose of [...this.disposers.splice(0), ...this.connectionDisposers.splice(0)]) dispose();
    this.connection = null; this.changed();
  }
}
module.exports = { NativePredictionPolicy, KEY };
