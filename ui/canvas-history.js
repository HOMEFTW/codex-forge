const clone = value => JSON.parse(JSON.stringify(value));
export const canvasContent = doc => clone({ title: doc.title, description: doc.description || '', color: doc.color || 'neutral', nodes: doc.nodes, edges: doc.edges });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// History belongs to one open canvas and one uninterrupted revision sequence.
// A pending transaction may be observed by the file watcher before its IPC reply.
export class CanvasHistory {
  constructor({ maxEntries = 50, maxBytes = 24 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.id = null; this.revision = -1; this.content = null;
    this.undo = []; this.redo = []; this.pending = null;
  }
  reset(doc) {
    this.id = doc.id; this.revision = doc.revision; this.content = canvasContent(doc);
    this.undo = []; this.redo = []; this.pending = null;
  }
  clear() { const hadHistory = this.undo.length > 0 || this.redo.length > 0; this.undo = []; this.redo = []; return hadHistory; }
  observe(doc) {
    if (doc.id !== this.id) { this.reset(doc); return false; }
    if (doc.revision < this.revision) return false;
    const content = canvasContent(doc);
    if (doc.revision === this.revision && same(content, this.content)) return false;
    const ownCandidate = this.pending && !this.pending.invalidated && doc.revision === this.pending.revision + 1;
    let invalidated = false;
    if (ownCandidate) this.pending.observed = content;
    else { invalidated = this.clear(); if (this.pending) this.pending.invalidated = true; }
    this.revision = doc.revision; this.content = content;
    return invalidated;
  }
  state() { return { canUndo: !this.pending && this.undo.length > 0, canRedo: !this.pending && this.redo.length > 0 }; }
  begin(doc, action = 'edit') {
    if (this.pending) throw new Error('Canvas history is busy');
    this.observe(doc);
    const entry = action === 'undo' ? this.undo.at(-1) : action === 'redo' ? this.redo.at(-1) : null;
    if (action !== 'edit' && !entry) return null;
    const token = { id: doc.id, revision: doc.revision, before: canvasContent(doc), action, entry };
    if (entry) token.target = clone(action === 'undo' ? entry.before : entry.after);
    this.pending = token; return token;
  }
  complete(token, doc) {
    if (this.pending !== token || this.id !== token.id) return false;
    this.pending = null;
    const after = canvasContent(doc);
    if (token.invalidated || doc.id !== token.id || doc.revision !== token.revision + 1 || this.revision > doc.revision || (token.observed && !same(token.observed, after))) {
      this.clear(); if (doc.id === this.id && doc.revision >= this.revision) { this.revision = doc.revision; this.content = after; } return false;
    }
    if (token.action === 'undo') { this.undo.pop(); this.redo.push(token.entry); }
    else if (token.action === 'redo') { this.redo.pop(); this.undo.push(token.entry); }
    else if (!same(token.before, after)) {
      this.undo.push({ before: token.before, after, bytes: (JSON.stringify(token.before).length + JSON.stringify(after).length) * 2 });
      this.redo = [];
    }
    this.revision = doc.revision; this.content = after; this.trim(); return true;
  }
  fail(token, latest) {
    if (this.pending !== token || this.id !== token.id) return false;
    this.pending = null;
    let invalidated = false;
    if (latest && (latest.id !== token.id || latest.revision !== token.revision)) invalidated = this.clear();
    if (latest) invalidated = this.observe(latest) || invalidated;
    return invalidated;
  }
  trim() {
    let bytes = [...this.undo, ...this.redo].reduce((total, entry) => total + entry.bytes, 0);
    while (this.undo.length + this.redo.length > this.maxEntries || bytes > this.maxBytes) {
      const entry = this.undo.length ? this.undo.shift() : this.redo.shift();
      if (!entry) break; bytes -= entry.bytes;
    }
  }
}

export function isEditingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
}
export function canvasHistoryShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || isEditingTarget(event.target)) return null;
  const key = event.key?.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}
