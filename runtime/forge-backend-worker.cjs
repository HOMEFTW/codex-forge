'use strict';
// Explicitly trusted Node code runs in a separate process, not an OS security sandbox.
const { AsyncLocalStorage } = require('node:async_hooks');
const { pathToFileURL } = require('node:url');
const { MAX_MESSAGE, jsonValue, localName } = require('./forge-backend-values.cjs');
const storage = new AsyncLocalStorage(), handlers = new Map(), calls = new Map(), requests = new Map(), registration = new Map(), disposers = [];
let sequence = 0, active = true;
function send(value) {
  if (!active || !process.connected) return;
  const data = jsonValue(value, MAX_MESSAGE);
  process.send(data, error => { if (error) stop(); });
}
function remote(type, value) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    send({ type, id, ...value });
  });
}
function register(kind, definition, methods) {
  if (!active) throw Error('Backend disposed');
  const key = kind + ':' + definition.name;
  if (handlers.has(key)) throw Error('Duplicate backend registration: ' + key);
  handlers.set(key, methods);
  const ready = remote('register', { kind, definition }); registration.set(key, ready);
  // Retain rejection for activation while avoiding an unhandled rejection before apply completes.
  ready.catch(() => {});
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; handlers.delete(key); registration.delete(key); send({ type: 'unregister', kind, name: definition.name }); };
  dispose.ready = ready;
  return dispose;
}
function handler(value) { if (typeof value !== 'function') throw Error('Backend handler must be a function'); return value; }
const forge = Object.freeze({
  handle(name, fn) { localName(name); return register('method', { name }, handler(fn)); },
  services: Object.freeze({ provide(name, methods) {
    if (!methods || typeof methods !== 'object' || Array.isArray(methods)) throw Error('Service methods must be an object');
    const copy = Object.create(null);
    for (const [key, fn] of Object.entries(methods)) copy[localName(key)] = handler(fn);
    return register('service', { name, methods: Object.keys(copy) }, copy);
  } }),
  tools: Object.freeze({ register(definition, fn) { return register('tool', definition, handler(fn)); } }),
  llm: Object.freeze({ registerProvider(definition, fn) { return register('provider', definition, handler(fn)); } }),
  hooks: Object.freeze({ on(name, fn) { return register('hook', { name }, handler(fn)); } }),
  jobs: Object.freeze({ register(name, fn) { localName(name); return register('job', { name }, handler(fn)); } }),
  async request(method, args = {}, options = {}) {
    const invocation = storage.getStore(), signal = options.signal || invocation?.signal;
    if (signal?.aborted) throw Object.assign(Error('Cancelled'), { code: 'CANCELLED' });
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const abort = () => { requests.delete(id); send({ type: 'request-cancel', id }); reject(Object.assign(Error('Cancelled'), { code: 'CANCELLED' })); };
      const settle = fn => value => { signal?.removeEventListener('abort', abort); fn(value); };
      requests.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      send({ type: 'request', id, invocationId: invocation?.id ?? null, method, args });
    });
  },
  log(level, message, data = null) { send({ type: 'log', level, message: String(message).slice(0, 4000), data: jsonValue(data, 16 * 1024) }); },
  onDispose(fn) { disposers.push(handler(fn)); return () => { const i = disposers.indexOf(fn); if (i >= 0) disposers.splice(i, 1); }; },
});
function finish(id, error, value) {
  if (error) send({ type: 'result', id, error: { code: String(error.code || 'BACKEND_ERROR'), message: String(error.message || error).slice(0, 4000) } });
  else send({ type: 'result', id, value: value === undefined ? null : value });
  calls.delete(id);
}
async function invoke(message) {
  const controller = new AbortController(), operation = { controller, context: message.context, iterator: null, pulling: false, ready: false, execution: null };
  calls.set(message.id, operation);
  try {
    const entry = handlers.get(message.kind + ':' + message.name);
    const fn = message.kind === 'service' ? entry?.[message.method] : entry;
    if (typeof fn !== 'function') throw Object.assign(Error('Backend handler not registered'), { code: 'METHOD_NOT_FOUND' });
    operation.execution = Promise.resolve(storage.run({ id: message.id, context: message.context, signal: controller.signal }, () => fn(message.args, { context: message.context, signal: controller.signal })));
    const value = await operation.execution;
    if (controller.signal.aborted || !calls.has(message.id)) return;
    if (message.stream) {
      const iterator = value?.[Symbol.asyncIterator]?.() || value?.[Symbol.iterator]?.();
      operation.iterator = iterator || (async function* () { if (value !== undefined) yield value; })();
      operation.ready = true; send({ type: 'stream-ready', id: message.id });
    } else {
      if (value?.[Symbol.asyncIterator]) throw Object.assign(Error('Use a streaming call for an AsyncIterable result'), { code: 'INVALID_ARGUMENT' });
      finish(message.id, null, value);
    }
  } catch (error) { if (calls.has(message.id)) finish(message.id, error); }
}
async function pull(id) {
  const operation = calls.get(id);
  if (!operation || !operation.ready || operation.pulling) return;
  operation.pulling = true;
  try {
    const item = await storage.run({ id, context: operation.context, signal: operation.controller.signal }, () => operation.iterator.next());
    if (!calls.has(id)) return;
    send({ type: 'chunk', id, done: !!item.done, ...(item.done ? {} : { value: item.value }) });
    if (item.done) calls.delete(id);
  } catch (error) { if (calls.has(id)) finish(id, error); }
  finally { operation.pulling = false; }
}
async function cancel(id) {
  const operation = calls.get(id); if (!operation) return;
  calls.delete(id); operation.controller.abort();
  try { if (operation.iterator) await operation.iterator.return?.(); else await operation.execution; } catch { /* The parent owns cancellation and process teardown. */ }
  send({ type: 'cancelled', id });
}
async function stop() {
  if (!active) return; active = false;
  for (const id of calls.keys()) void cancel(id);
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* Continue releasing the remaining contributions. */ } }
  for (const request of requests.values()) request.reject(Error('Backend disposed'));
  requests.clear();
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('message', message => {
  try { jsonValue(message); } catch { return void stop(); }
  if (message.type === 'init') {
    void (async () => {
      const imported = await import(pathToFileURL(message.entry).href);
      const exported = imported.default || imported;
      const activate = typeof exported === 'function' ? exported : exported.activate;
      if (typeof activate !== 'function') throw Error('Backend must export activate(forge)');
      const cleanup = await activate(forge); if (typeof cleanup === 'function') disposers.push(cleanup);
      await Promise.all(registration.values()); send({ type: 'ready' });
    })().catch(error => { send({ type: 'fatal', error: { code: error.code || 'BACKEND_START_FAILED', message: String(error.message || error).slice(0, 4000) } }); });
  } else if (message.type === 'invoke') void invoke(message);
  else if (message.type === 'pull') void pull(message.id);
  else if (message.type === 'cancel') void cancel(message.id);
  else if (message.type === 'stop') void stop();
  else if (message.type === 'reply') {
    const request = requests.get(message.id); if (!request) return;
    requests.delete(message.id);
    message.error ? request.reject(Object.assign(Error(message.error.message), { code: message.error.code })) : request.resolve(message.value);
  }
});
