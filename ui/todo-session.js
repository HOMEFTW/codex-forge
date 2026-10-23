export class TodoSession {
  constructor({ api, onDocument, onError, onBusy }) {
    this.api = api; this.onDocument = onDocument; this.onError = onError; this.onBusy = onBusy;
    this.target = null; this.doc = null; this.epoch = 0; this.pending = 0; this.queue = Promise.resolve(); this.active = true;
  }
  setTarget(target) {
    this.target = target; this.doc = null; this.epoch++;
    if (this.active) { this.onDocument(null); this.onError(''); }
    return this.load();
  }
  accept(doc, target, epoch) {
    if (!this.active || this.target !== target || this.epoch !== epoch || (this.doc && doc.revision < this.doc.revision)) return;
    this.doc = doc; this.onDocument(doc);
  }
  async load() {
    const target = this.target, epoch = this.epoch;
    if (!target || !this.active) return;
    try { const doc = await this.api.request('todo_read', { threadId: target }); this.accept(doc, target, epoch); }
    catch (error) { if (this.active && this.target === target && this.epoch === epoch) this.onError(String(error.message || error)); }
  }
  mutate(operations, succeeded) {
    const target = this.target, epoch = this.epoch;
    this.pending++; if (this.active) this.onBusy(true);
    const work = this.queue.catch(() => {}).then(async () => {
      if (!this.active || this.target !== target || this.epoch !== epoch || !this.doc) return false;
      const before = this.doc;
      try {
        const next = await this.api.request('todo_apply', { threadId: target, expectedRevision: before.revision, operations: typeof operations === 'function' ? operations(before) : operations });
        if (!this.active || this.target !== target || this.epoch !== epoch) return false;
        this.accept(next, target, epoch); this.onError(''); succeeded?.(next, before); return true;
      } catch (error) {
        if (this.active && this.target === target && this.epoch === epoch) {
          const message = String(error.message || error);
          this.onError(message.includes('Revision conflict') ? '清单已有新修改，已刷新。请核对后重试。' : message);
          await this.load();
        }
        return false;
      }
    }).finally(() => { this.pending--; if (this.active) this.onBusy(this.pending > 0); });
    this.queue = work; return work;
  }
  dispose() { this.active = false; this.epoch++; }
}
