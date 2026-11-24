'use strict';
const path = require('node:path');
const { json } = require('./collaboration-store.cjs');

class CanvasSessions {
  constructor({ store, states, context, open, notify, enabled = () => true }) {
    Object.assign(this, { store, states, context, open, notify, enabled });
    this.signalFile = path.join(store.root, '.open.json');
    // An old model update is history, not a new request to open a sidebar.
    this.signalNonce = json(this.signalFile, {}).nonce;
  }
  current(state) {
    const threadId = this.context(state);
    return { threadId, canvasId: threadId ? this.store.forThread(threadId) : state.canvasThreadId === null ? state.canvasId : null };
  }
  check(state, expectedThreadId) {
    const threadId = this.context(state);
    if (expectedThreadId !== undefined && expectedThreadId !== threadId) throw Error('当前对话已变化，请重新选择画布');
    return threadId;
  }
  remember(state, threadId, canvasId) {
    this.store.bindThread(threadId, canvasId);
    if (this.context(state) === threadId) { state.canvasThreadId = threadId; state.canvasId = canvasId; }
  }
  changed(state) {
    const selection = this.current(state);
    state.canvasThreadId = selection.threadId; state.canvasId = selection.canvasId;
    this.notify(state, { type: 'canvas-context', ...selection });
    if (selection.canvasId && this.enabled()) this.open(state, { page: 'canvas', canvasId: selection.canvasId });
    else if (state.page === 'canvas') { state.visible = false; state.win.webContents.send('fast-ext:panel', null); }
  }
  signal() {
    const signal = json(this.signalFile, null);
    if (!signal || signal.nonce === this.signalNonce) return;
    this.signalNonce = signal.nonce;
    if (!signal.threadId || !this.enabled()) return;
    this.store.read(signal.id);
    for (const state of this.states.values()) {
      if (!state.win.isDestroyed() && this.context(state) === signal.threadId) this.open(state, { canvasId: signal.id, nodeIds: signal.nodeIds || [] });
    }
  }
}
module.exports = { CanvasSessions };
