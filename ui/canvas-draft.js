// Only dirty fields are sent. Disposing an editor cancels pending timers instead
// of writing its old draft after a delete, canvas switch or history restore.
export class CanvasDraft {
  constructor({ value, revision, save, onChange, onStatus, errorText = error => String(error?.message || error), delay = 650 }) {
    this.value = value; this.revision = revision; this.baseRevision = revision;
    this.save = save; this.onChange = onChange; this.onStatus = onStatus; this.errorText = errorText; this.delay = delay;
    this.patch = {}; this.timer = null; this.pending = null; this.active = true;
  }
  get dirty() { return Object.keys(this.patch).length > 0; }
  context(value, revision) {
    this.value = value; this.revision = revision;
    if (!this.dirty && !this.pending) this.baseRevision = revision;
    else if (!this.pending && revision !== this.baseRevision) {
      clearTimeout(this.timer); this.onStatus('画布已更新；草稿已保留，请核对后保存');
    }
    if (this.active) this.onChange({ ...value, ...this.patch });
  }
  change(key, value) {
    if (!this.active) return;
    if (!this.dirty && !this.pending) this.baseRevision = this.revision;
    this.patch[key] = value; this.onChange({ ...this.value, ...this.patch }); this.onStatus('待保存…');
    clearTimeout(this.timer); this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  async flush(confirm = false) {
    clearTimeout(this.timer);
    if (!this.active) return;
    if (this.pending) { await this.pending; return this.flush(confirm); }
    if (!this.dirty) return;
    if (confirm) this.baseRevision = this.revision;
    const snapshot = { ...this.patch }, revision = this.baseRevision;
    this.onStatus('正在保存…');
    const work = Promise.resolve().then(() => this.save(snapshot, revision)); this.pending = work;
    try {
      const result = await work;
      if (!this.active) return;
      this.baseRevision = result.revision;
      this.revision = Math.max(this.revision, result.revision);
      for (const key of Object.keys(snapshot)) if (Object.is(this.patch[key], snapshot[key])) delete this.patch[key];
      // A newer watcher revision may have arrived while this reply was in flight.
      // Keep that persisted value instead of echoing the older saved snapshot.
      if (result.revision >= this.revision) this.value = { ...this.value, ...snapshot };
      this.onChange({ ...this.value, ...this.patch });
      this.onStatus(this.dirty ? '待保存…' : '已自动保存');
    } catch (error) {
      if (this.active) this.onStatus(`未保存：${this.errorText(error)}`);
      throw error;
    } finally { if (this.pending === work) this.pending = null; }
    if (this.active && this.dirty) return this.flush();
  }
  discard() {
    clearTimeout(this.timer); this.patch = {};
    if (this.active) { this.onChange({ ...this.value }); this.onStatus(''); }
  }
  dispose() { clearTimeout(this.timer); this.active = false; this.patch = {}; }
}
