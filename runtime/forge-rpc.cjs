'use strict';
const crypto = require('node:crypto');
const { ForgeError } = require('./forge-errors.cjs');

const fault = (code, message) => new ForgeError(code, message);
const aborted = () => fault('CANCELLED', '请求已取消');
const abortReason = signal => typeof signal.reason?.code === 'string' ? signal.reason : aborted();

function boundedJSON(value, maxBytes) {
  if (value === undefined) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item) || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw Error('非 JSON 数据');
      return item;
    });
  } catch { throw fault('INVALID_ARGUMENT', 'RPC 只接受可序列化的 JSON 数据'); }
  if (typeof encoded !== 'string') throw fault('INVALID_ARGUMENT', 'RPC 只接受 JSON 数据');
  if (Buffer.byteLength(encoded) > maxBytes) throw fault('RESOURCE_LIMIT', 'RPC 数据超过大小限制');
  return JSON.parse(encoded);
}

function raceSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(abortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw abortReason(signal); return operation(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Window, frame, installation fingerprint and conversation identity are supplied by the host in owner. */
class ForgeRPC {
  constructor({ maxPending = 64, maxStreams = 16, maxBytes = 1024 * 1024, timeoutMs = 120000 } = {}) {
    for (const value of [maxPending, maxStreams, maxBytes, timeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw fault('INVALID_ARGUMENT', 'RPC 限制必须为正整数');
    this.limits = { maxPending, maxStreams, maxBytes, timeoutMs };
    this.pending = new Map(); this.streams = new Map(); this.disposed = false;
  }
  owner(value) {
    if (this.disposed) throw fault('PLUGIN_DISABLED', 'RPC 已停止');
    if (typeof value !== 'string' || !value || value.length > 4096) throw fault('INVALID_ARGUMENT', 'RPC 调用身份无效');
    return value;
  }
  key(owner, requestId) {
    this.owner(owner);
    if (!(Number.isSafeInteger(requestId) && requestId > 0)) throw fault('INVALID_ARGUMENT', 'RPC 请求编号无效');
    return JSON.stringify([owner, requestId]);
  }
  deadline(controller, timeoutMs = this.limits.timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.limits.timeoutMs) throw fault('INVALID_ARGUMENT', 'RPC 超时时间无效');
    const timer = setTimeout(() => controller.abort(fault('TIMEOUT', 'Forge 请求超时')), timeoutMs);
    timer.unref?.(); return timer;
  }
  async run(owner, requestId, operation, { timeoutMs } = {}) {
    const key = this.key(owner, requestId);
    if (typeof operation !== 'function') throw fault('INVALID_ARGUMENT', 'RPC 操作无效');
    if (this.pending.has(key)) throw fault('INVALID_ARGUMENT', 'RPC 请求编号重复');
    if (this.pending.size >= 1024 || [...this.pending.values()].filter(item => item.owner === owner).length >= this.limits.maxPending) throw fault('RESOURCE_LIMIT', 'RPC 并发请求过多');
    const controller = new AbortController(), timer = this.deadline(controller, timeoutMs);
    this.pending.set(key, { owner, controller });
    try { return boundedJSON(await raceSignal(() => operation(controller.signal), controller.signal), this.limits.maxBytes); }
    finally { clearTimeout(timer); this.pending.delete(key); }
  }
  cancel(owner, requestId) {
    const item = this.pending.get(this.key(owner, requestId));
    if (!item) return false;
    item.controller.abort(aborted()); return true;
  }
  open(owner, source, { onInput, onEnd, signal, timeoutMs } = {}) {
    this.owner(owner);
    if (this.streams.size >= 256 || [...this.streams.values()].filter(item => item.owner === owner).length >= this.limits.maxStreams) throw fault('RESOURCE_LIMIT', '打开的 RPC 流过多');
    const controller = new AbortController();
    if (signal?.aborted) throw abortReason(signal);
    const timer = this.deadline(controller, timeoutMs); let iterator;
    try {
      if (onInput !== undefined && typeof onInput !== 'function' || onEnd !== undefined && typeof onEnd !== 'function') throw fault('INVALID_ARGUMENT', 'RPC 流回调无效');
      const iterable = typeof source === 'function' ? source(controller.signal) : source;
      iterator = iterable?.[Symbol.asyncIterator]?.() || iterable?.[Symbol.iterator]?.() || iterable;
      if (!iterator || typeof iterator.next !== 'function') throw fault('INVALID_ARGUMENT', 'RPC 流必须提供迭代器');
      if (signal?.aborted) throw abortReason(signal);
    } catch (error) {
      clearTimeout(timer); controller.abort(error);
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Activation failed and is being unwound. */ }
      throw error;
    }
    const streamId = crypto.randomUUID(), item = { owner, controller, iterator, onInput, onEnd, busy: false, inputBusy: false, inputEnded: false, closed: false, timer };
    const cancel = () => { void this.close(owner, streamId, abortReason(signal)); };
    item.externalSignal = signal; item.externalCancel = cancel;
    this.streams.set(streamId, item);
    controller.signal.addEventListener('abort', () => { void this.close(owner, streamId, controller.signal.reason); }, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    return { streamId };
  }
  stream(owner, streamId) {
    this.owner(owner);
    if (typeof streamId !== 'string' || streamId.length > 100) throw fault('INVALID_ARGUMENT', 'RPC 流编号无效');
    const item = this.streams.get(streamId);
    if (!item || item.owner !== owner) throw fault('STREAM_NOT_FOUND', 'RPC 流不存在或不属于此调用者');
    return item;
  }
  async next(owner, streamId) {
    const item = this.stream(owner, streamId);
    if (item.busy) throw fault('INVALID_ARGUMENT', '同一 RPC 流只能有一个待处理读取');
    item.busy = true;
    try {
      const result = await raceSignal(() => item.iterator.next(), item.controller.signal);
      if (!result || typeof result !== 'object') throw fault('INVALID_ARGUMENT', 'RPC 迭代器返回值无效');
      const value = boundedJSON(result.value, this.limits.maxBytes);
      if (result.done) await this.close(owner, streamId);
      return { value, done: !!result.done };
    } catch (error) { await this.close(owner, streamId, error); throw error; }
    finally { item.busy = false; }
  }
  async send(owner, streamId, value) {
    const item = this.stream(owner, streamId);
    if (item.inputEnded) throw fault('STREAM_CLOSED', 'RPC 流输入已结束');
    if (!item.onInput) throw fault('METHOD_NOT_FOUND', '此 RPC 流不支持客户端输入');
    if (item.inputBusy) throw fault('RESOURCE_LIMIT', 'RPC 流输入尚未处理');
    const input = boundedJSON(value, this.limits.maxBytes); item.inputBusy = true;
    try { await raceSignal(() => item.onInput(input, item.controller.signal), item.controller.signal); return { accepted: true }; }
    finally { item.inputBusy = false; }
  }
  async end(owner, streamId) {
    const item = this.stream(owner, streamId);
    if (item.inputEnded) return { ended: true };
    if (item.inputBusy) throw fault('RESOURCE_LIMIT', 'RPC 流输入尚未处理');
    item.inputEnded = true;
    if (item.onEnd) await raceSignal(() => item.onEnd(item.controller.signal), item.controller.signal);
    return { ended: true };
  }
  async close(owner, streamId, reason) {
    this.owner(owner);
    const item = this.streams.get(streamId);
    if (!item) return { closed: true };
    if (item.owner !== owner) throw fault('STREAM_NOT_FOUND', 'RPC 流不存在或不属于此调用者');
    if (item.closed) return { closed: true };
    item.closed = true; this.streams.delete(streamId); clearTimeout(item.timer);
    item.externalSignal?.removeEventListener('abort', item.externalCancel);
    item.controller.abort(reason || aborted());
    // A producer which ignores its signal cannot hold host disposal open forever.
    try { Promise.resolve(item.iterator.return?.()).catch(() => {}); } catch { /* Source already failed; the stream is closed. */ }
    return { closed: true };
  }
  disposeOwner(owner) {
    this.owner(owner);
    for (const item of this.pending.values()) if (item.owner === owner) item.controller.abort(fault('PLUGIN_DISABLED', '插件已停止或调用身份已变化'));
    for (const [id, item] of this.streams) if (item.owner === owner) void this.close(owner, id, fault('PLUGIN_DISABLED', '插件已停止或调用身份已变化'));
  }
  dispose() {
    if (this.disposed) return;
    const owners = new Set([...this.pending.values(), ...this.streams.values()].map(item => item.owner));
    for (const owner of owners) this.disposeOwner(owner);
    this.disposed = true;
  }
}
module.exports = { ForgeRPC };
