'use strict';
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { ForgeError } = require('./forge-errors.cjs');
const { safeFile } = require('./forge-manifest.cjs');
const { fingerprint } = require('./forge-registry.cjs');
const { MAX_MESSAGE, fail, jsonValue, schemaDefinition, validateValue, localName, namespaced } = require('./forge-backend-values.cjs');
const HOOKS = new Set(['llm.before', 'llm.after', 'tools.before', 'tools.after', 'conversation.beforeSend', 'conversation.afterSend']);
const PERMISSIONS = { method: 'backend.node', service: 'services.provide', tool: 'tools.register', provider: 'llm.providers', hook: 'hooks.register', job: 'jobs.manage' };
const CONTRIB = { service: 'services', tool: 'tools', provider: 'providers', hook: 'hooks', job: 'jobs' };
const deadline = value => Number.isSafeInteger(value) && value >= 10 && value <= 120000 ? value : 30000;
const abortError = () => new ForgeError('CANCELLED', '插件操作已取消');
const publicError = error => ({ code: error.code || 'BACKEND_ERROR', message: String(error.message || error).slice(0, 4000) });
class ForgeBackendManager {
  constructor({ registry, root = registry?.root, nodePath = process.execPath, request, onEvent = () => {} } = {}) {
    if (!registry || !root) fail('插件后端需要注册表与数据目录');
    this.registry = registry; this.root = root; this.nodePath = nodePath; this.request = request; this.onEvent = onEvent;
    this.workers = new Map(); this.stopping = new Map(); this.contributions = new Map(); this.closed = false; this.sequence = 0;
    this.failures = new Map();
  }
  emit(type, data) { try { this.onEvent({ type, ...data }); } catch { /* Observers cannot change a committed lifecycle transition. */ } }
  settings(id) { return jsonValue(this.registry.settings ? this.registry.settings(id) : {}); }
  assert(id, permission = 'backend.node') {
    const entry = this.registry.permission(id, 'backend.node');
    if (permission !== 'backend.node') this.registry.permission(id, permission);
    const worker = this.workers.get(id);
    if (worker && worker.fingerprint !== entry.fingerprint) {
      this.stop(worker, new ForgeError('PLUGIN_CHANGED', '插件内容变化，后端已停止'));
      fail('插件内容变化，请重新审阅并启用', 'PLUGIN_CHANGED');
    }
    return entry;
  }
  async sync() {
    if (this.closed) return;
    const desired = new Map(this.registry.list().plugins.filter(item => item.enabled && item.backend).map(item => [item.id, item]));
    for (const id of this.failures.keys()) if (!desired.has(id)) this.failures.delete(id);
    const stopping = [];
    for (const [id, worker] of this.workers) {
      if (!desired.has(id) || desired.get(id).fingerprint !== worker.fingerprint) stopping.push(this.stop(worker, new ForgeError('PLUGIN_DISABLED', '插件已停用或变化')));
      else if (!isDeepStrictEqual(worker.settings, this.settings(id))) stopping.push(this.stop(worker, new ForgeError('SETTINGS_CHANGED', '插件设置变化，后端正在重新启动')));
    }
    await Promise.all(stopping);
    await Promise.all([...desired.keys()].map(async id => {
      try { await this.ensure(id); }
      catch (error) { this.emit('backend.failed', { pluginId: id, error: publicError(error) }); }
    }));
  }
  async ensure(id) {
    if (this.closed) fail('后端管理器已关闭', 'PLUGIN_DISABLED');
    if (this.stopping.has(id)) await this.stopping.get(id);
    if (this.closed) fail('后端管理器已关闭', 'PLUGIN_DISABLED');
    const entry = this.assert(id);
    if (!entry.manifest.backend?.entry) fail('插件没有后端入口', 'CAPABILITY_UNAVAILABLE');
    const settings = this.settings(id), previous = this.workers.get(id);
    if (previous && !isDeepStrictEqual(previous.settings, settings)) {
      await this.stop(previous, new ForgeError('SETTINGS_CHANGED', '插件设置变化，后端正在重新启动'));
      return this.ensure(id);
    }
    if (previous) { await previous.ready; return previous; }
    if (fingerprint(entry.root) !== entry.fingerprint) fail('插件磁盘内容变化，请重新加载并审阅后启用', 'PLUGIN_CHANGED');
    if (this.failures.get(id)?.fingerprint === entry.fingerprint && isDeepStrictEqual(this.failures.get(id).settings, settings)) fail('插件后端先前启动失败；更新设置或重新启用后重试', 'BACKEND_START_FAILED');
    const script = safeFile(entry.root, entry.manifest.backend.entry);
    const worker = { id, fingerprint: entry.fingerprint, settings, calls: new Map(), requests: new Map(), registrations: new Set(), stopping: false, output: 0, timer: null };
    worker.ready = new Promise((resolve, reject) => { worker.resolve = resolve; worker.reject = reject; });
    worker.ready.catch(() => {});
    this.workers.set(id, worker);
    try {
      const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      Object.assign(env, { NODE_ENV: 'production', FORGE_PLUGIN_ID: id, ELECTRON_RUN_AS_NODE: '1' });
      worker.child = fork(path.join(__dirname, 'forge-backend-worker.cjs'), [], { execPath: this.nodePath, execArgv: ['--max-old-space-size=128'], cwd: entry.root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
      const output = (stream, level) => stream.on('data', chunk => {
        worker.output += chunk.length;
        if (worker.output > MAX_MESSAGE) return this.stop(worker, new ForgeError('OUTPUT_LIMIT', '插件后端日志超过 1MiB'));
        this.emit('backend.log', { pluginId: id, level, message: chunk.toString('utf8').slice(0, 4000) });
      });
      output(worker.child.stdout, 'info'); output(worker.child.stderr, 'error');
      worker.child.on('message', message => void this.message(worker, message));
      worker.child.once('error', error => this.stop(worker, error));
      worker.child.once('exit', (code, signal) => this.stop(worker, new ForgeError('BACKEND_EXITED', `插件后端退出（${code ?? signal}）`)));
      worker.timer = setTimeout(() => {
        this.failures.set(id, { fingerprint: entry.fingerprint, settings: worker.settings });
        this.stop(worker, new ForgeError('TIMEOUT', '插件后端启动超时'));
      }, 10000);
      this.send(worker, { type: 'init', entry: script });
    } catch (error) { this.stop(worker, error); }
    await worker.ready; return worker;
  }
  send(worker, message) {
    if (worker.stopping || !worker.child?.connected) return false;
    worker.child.send(jsonValue(message), error => { if (error && !worker.stopping) this.stop(worker, error); });
    return true;
  }
  declared(entry, kind, name) {
    const manifest = entry.manifest;
    const list = kind === 'method' ? manifest.backend?.methods || [] : manifest.contributes?.[CONTRIB[kind]] || [];
    const value = list.find(item => (typeof item === 'string' ? item : kind === 'job' ? item.method || item.name : item.name) === name);
    if (!value) fail('插件未声明后端贡献：' + kind + ':' + name, 'PERMISSION_DENIED');
    return typeof value === 'string' ? { name: value } : value;
  }
  register(worker, kind, input) {
    if (!Object.hasOwn(PERMISSIONS, kind)) fail('未知后端贡献类型');
    const entry = this.assert(worker.id, PERMISSIONS[kind]), definition = jsonValue(input, 64 * 1024);
    if (!definition || typeof definition !== 'object') fail('后端贡献声明无效');
    const name = kind === 'hook' ? definition.name : kind === 'method' || kind === 'job' ? localName(definition.name) : namespaced(worker.id, definition.name);
    if (kind === 'hook' && !HOOKS.has(name)) fail('未知插件钩子：' + name);
    const declaration = this.declared(entry, kind, name);
    if (kind === 'tool') {
      if (typeof definition.description !== 'string' || !definition.description.trim() || definition.description.length > 10000) fail('工具需要有效描述');
      schemaDefinition(definition.inputSchema); schemaDefinition(definition.outputSchema);
      if (declaration.inputSchema && !isDeepStrictEqual(declaration.inputSchema, definition.inputSchema) || declaration.outputSchema && !isDeepStrictEqual(declaration.outputSchema, definition.outputSchema)) fail('运行时工具 schema 与清单不一致');
      if (definition.timeoutMs !== undefined && (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 10 || definition.timeoutMs > 120000)) fail('工具 timeoutMs 应为 10–120000');
    }
    if (kind === 'service') {
      if (!Array.isArray(definition.methods) || !definition.methods.length || definition.methods.length > 64) fail('服务需要方法列表');
      definition.methods.forEach(localName);
      if (declaration.methods && definition.methods.some(method => !declaration.methods.includes(method))) fail('服务方法未在清单中声明');
    }
    if (kind === 'provider' && definition.models !== undefined) {
      if (!Array.isArray(definition.models) || definition.models.length > 200 || definition.models.some(model => !model || typeof model.id !== 'string' || !model.id || model.id.length > 200)) fail('模型目录无效');
    }
    const key = kind + ':' + (kind === 'hook' ? worker.id + ':' : '') + name;
    if (worker.registrations.size >= 128) fail('插件后端贡献数量超限', 'RESOURCE_LIMIT');
    if (this.contributions.has(key)) fail('重复后端贡献：' + name, 'CONTRIBUTION_CONFLICT');
    this.contributions.set(key, { pluginId: worker.id, kind, name, definition, scope: declaration.scope || 'session', order: declaration.order || 0 });
    worker.registrations.add(key);
    this.emit('backend.registered', { pluginId: worker.id, kind, name });
  }
  async message(worker, message) {
    if (worker.stopping || this.workers.get(worker.id) !== worker) return;
    try {
      jsonValue(message);
      this.assert(worker.id);
      if (message.type === 'register') {
        try { this.register(worker, message.kind, message.definition); this.send(worker, { type: 'reply', id: message.id, value: true }); }
        catch (error) { this.send(worker, { type: 'reply', id: message.id, error: publicError(error) }); }
      } else if (message.type === 'unregister') {
        const key = message.kind + ':' + (message.kind === 'hook' ? worker.id + ':' : '') + message.name;
        if (worker.registrations.delete(key)) this.contributions.delete(key);
      } else if (message.type === 'ready') {
        clearTimeout(worker.timer); worker.resolve(); this.emit('backend.ready', { pluginId: worker.id });
      } else if (message.type === 'fatal') {
        this.failures.set(worker.id, { fingerprint: worker.fingerprint, settings: worker.settings });
        this.stop(worker, Object.assign(Error(message.error?.message || '后端启动失败'), { code: message.error?.code || 'BACKEND_START_FAILED' }));
      } else if (message.type === 'request') {
        if (worker.requests.size >= 32 || !this.request) fail('后端请求代理不可用或并发超限', 'CAPABILITY_UNAVAILABLE');
        const invocation = message.invocationId === null ? null : worker.calls.get(message.invocationId);
        if (message.invocationId !== null && !invocation) fail('后端调用上下文已过期', 'STALE_CONTEXT');
        const controller = new AbortController(); worker.requests.set(message.id, controller);
        const abort = () => controller.abort(); invocation?.signal.addEventListener('abort', abort, { once: true });
        if (invocation?.signal.aborted) controller.abort();
        try {
          const context = invocation?.context || { threadId: null, cwd: null, source: 'backend', generation: 0 };
          const value = await this.request(worker.id, message.method, message.args, context, { signal: controller.signal });
          this.assert(worker.id);
          this.send(worker, { type: 'reply', id: message.id, value: value === undefined ? null : value });
        } catch (error) { this.send(worker, { type: 'reply', id: message.id, error: publicError(error) }); }
        finally { invocation?.signal.removeEventListener('abort', abort); worker.requests.delete(message.id); }
      } else if (message.type === 'request-cancel') worker.requests.get(message.id)?.abort();
      else if (message.type === 'log') this.emit('backend.log', { pluginId: worker.id, level: message.level, message: String(message.message).slice(0, 4000), data: jsonValue(message.data, 16 * 1024) });
      else if (message.type === 'cancelled') {
        const cancelled = worker.cancellations?.get(message.id);
        if (cancelled) { clearTimeout(cancelled.killTimer); worker.cancellations.delete(message.id); }
      } else {
        const call = worker.calls.get(message.id); if (!call) return;
        if (message.type === 'result') {
          const error = message.error ? Object.assign(Error(message.error.message), { code: message.error.code || 'BACKEND_ERROR' }) : null;
          this.finish(worker, call, error, message.value);
        } else if (message.type === 'stream-ready') { call.streaming = true; call.resolve(call.handle); }
        else if (message.type === 'chunk') {
          if (!call.pending) return this.stop(worker, new ForgeError('BACKEND_PROTOCOL', '插件发送了未请求的流数据'));
          const pending = call.pending; call.pending = null;
          pending.resolve(message.done ? { done: true, value: undefined } : { done: false, value: jsonValue(message.value) });
          if (message.done) this.finish(worker, call);
        }
      }
    } catch (error) { this.stop(worker, error); }
  }
  scope(context, contribution) {
    const result = jsonValue(context || {}, 32 * 1024);
    if (contribution?.scope !== 'global' && !result.threadId) fail('此贡献需要可信会话上下文', 'STALE_CONTEXT');
    if ((result.backendDepth || 0) >= 8) fail('插件调用层数超过限制', 'RESOURCE_LIMIT');
    result.backendDepth = (result.backendDepth || 0) + 1;
    return result;
  }
  async invoke(worker, kind, name, method, args, context, options = {}) {
    this.assert(worker.id, PERMISSIONS[kind]);
    if (worker.calls.size >= 32) fail('插件后端并发超限', 'RESOURCE_LIMIT');
    if (options.signal?.aborted) throw abortError();
    const id = ++this.sequence, controller = new AbortController();
    let call;
    const promise = new Promise((resolve, reject) => {
      call = { id, resolve, reject, context, signal: controller.signal, controller, pending: null, streaming: false, finished: false };
      call.externalAbort = () => this.cancelCall(worker, call, abortError());
      options.signal?.addEventListener('abort', call.externalAbort, { once: true }); call.externalSignal = options.signal;
      call.timer = setTimeout(() => this.cancelCall(worker, call, new ForgeError('TIMEOUT', '插件后端调用超时')), deadline(options.timeoutMs));
      call.handle = {
        [Symbol.asyncIterator]() { return this; },
        next: () => {
          if (call.failure) return Promise.reject(call.failure);
          if (call.finished) return Promise.resolve({ done: true, value: undefined });
          this.assert(worker.id);
          if (call.pending) return Promise.reject(new ForgeError('RESOURCE_LIMIT', '同一流只能有一个待处理 next'));
          return new Promise((resolve, reject) => { call.pending = { resolve, reject }; this.send(worker, { type: 'pull', id }); });
        },
        return: () => { this.cancelCall(worker, call, abortError()); return Promise.resolve({ done: true, value: undefined }); },
        throw: error => { this.cancelCall(worker, call, error); return Promise.reject(error); },
      };
      worker.calls.set(id, call);
      this.send(worker, { type: 'invoke', id, kind, name, method, args: jsonValue(args), context, stream: !!options.stream });
    });
    return promise;
  }
  finish(worker, call, error, value) {
    if (call.finished) return;
    call.finished = true; call.failure = error;
    clearTimeout(call.timer); call.externalSignal?.removeEventListener('abort', call.externalAbort); worker.calls.delete(call.id);
    if (call.pending) { error ? call.pending.reject(error) : call.pending.resolve({ done: true, value: undefined }); call.pending = null; }
    if (error) call.reject(error); else call.resolve(value === undefined ? null : jsonValue(value));
  }
  cancelCall(worker, call, error) {
    if (call.finished) return;
    call.controller.abort(); this.send(worker, { type: 'cancel', id: call.id }); this.finish(worker, call, error);
    // Trusted code may ignore AbortSignal or block JS. Kill it after a short cooperative grace period.
    call.killTimer = setTimeout(() => { if (!worker.stopping) this.stop(worker, new ForgeError('BACKEND_UNRESPONSIVE', '取消后插件未释放操作，后端已终止')); }, 150);
    worker.cancellations ||= new Map(); worker.cancellations.set(call.id, call);
  }
  stop(worker, error = new ForgeError('PLUGIN_DISABLED', '插件后端已停止')) {
    if (worker.stopping) return worker.stopped;
    worker.stopping = true; clearTimeout(worker.timer);
    this.workers.delete(worker.id);
    worker.reject(error);
    for (const key of worker.registrations) this.contributions.delete(key);
    for (const call of worker.calls.values()) { call.controller.abort(); this.finish(worker, call, error); }
    for (const call of worker.cancellations?.values() || []) clearTimeout(call.killTimer);
    for (const controller of worker.requests.values()) controller.abort();
    worker.requests.clear();
    if (worker.child?.pid && worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.stopped = new Promise(resolve => {
        const finish = () => { clearTimeout(force); clearTimeout(limit); resolve(); };
        worker.child.once('exit', finish);
        const force = setTimeout(() => worker.child.kill('SIGKILL'), 500);
        const limit = setTimeout(finish, 2500);
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(worker.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => worker.child.kill());
        } else {
          try { process.kill(-worker.child.pid, 'SIGTERM'); } catch { worker.child.kill(); }
        }
      });
      this.stopping.set(worker.id, worker.stopped);
      worker.stopped.finally(() => { if (this.stopping.get(worker.id) === worker.stopped) this.stopping.delete(worker.id); });
    } else worker.stopped = Promise.resolve();
    worker.child?.stdout?.destroy(); worker.child?.stderr?.destroy();
    this.emit('backend.stopped', { pluginId: worker.id, error: publicError(error) });
    return worker.stopped;
  }
  contribution(kind, name) {
    const value = this.contributions.get(kind + ':' + name);
    if (!value) fail('插件贡献不可用：' + name, 'CAPABILITY_UNAVAILABLE');
    this.assert(value.pluginId, PERMISSIONS[kind]); return value;
  }
  list(kind) {
    return [...this.contributions.values()].filter(item => item.kind === kind && this.registry.status(item.pluginId).enabled).map(item => ({ ...jsonValue(item.definition), pluginId: item.pluginId, scope: item.scope }));
  }
  services() { return this.list('service'); }
  tools() { return this.list('tool'); }
  providers() { return this.list('provider'); }
  hooks() { return this.list('hook'); }
  async call(pluginId, method, args = {}, context = {}, options = {}) {
    const worker = await this.ensure(pluginId), entry = this.assert(pluginId);
    localName(method);
    const kind = worker.registrations.has('job:' + method) ? 'job' : 'method';
    this.declared(entry, kind, method);
    return this.invoke(worker, kind, method, null, args, this.scope(context, { scope: entry.manifest.backend.scope || 'session' }), options);
  }
  async requestService(caller, name, method, args = {}, context = {}, options = {}) {
    const entry = this.registry.permission(caller, 'services.call');
    if (!(entry.manifest.consumes?.services || []).includes(name)) fail('插件未声明消费此服务：' + name, 'PERMISSION_DENIED');
    const item = this.contribution('service', name); localName(method);
    if (!item.definition.methods.includes(method)) fail('服务未提供此方法', 'METHOD_NOT_FOUND');
    const worker = await this.ensure(item.pluginId);
    return this.invoke(worker, 'service', name, method, args, { ...this.scope(context, item), callerPluginId: caller }, options);
  }
  async callTool(name, args = {}, context = {}, options = {}) {
    const item = this.contribution('tool', name), worker = await this.ensure(item.pluginId);
    validateValue(item.definition.inputSchema, jsonValue(args), 'tool arguments');
    const input = await this.applyHooks('tools.before', { name, args }, context, options);
    validateValue(item.definition.inputSchema, input.args, 'tool arguments');
    const result = await this.invoke(worker, 'tool', name, null, input.args, this.scope(context, item), { ...options, timeoutMs: item.definition.timeoutMs || options.timeoutMs });
    validateValue(item.definition.outputSchema, result, 'tool result');
    const after = await this.applyHooks('tools.after', { name, args: input.args, result }, context, options);
    validateValue(item.definition.outputSchema, after.result, 'tool result'); return after.result;
  }
  async *stream(caller, args = {}, context = {}, options = {}) {
    this.registry.get(caller);
    const input = await this.applyHooks('llm.before', jsonValue(args), context, options);
    const item = this.contribution('provider', input.provider), worker = await this.ensure(item.pluginId);
    if (item.definition.models?.length && !item.definition.models.some(model => model.id === input.model)) fail('适配器没有声明此模型', 'INVALID_ARGUMENT');
    const iterator = await this.invoke(worker, 'provider', item.name, null, input, this.scope(context, item), { ...options, stream: true });
    let text = '', usage;
    try {
      for await (const item of iterator) {
        const chunk = jsonValue(item);
        if (typeof chunk === 'string') text += chunk;
        else if (chunk && typeof chunk.text === 'string') text += chunk.text;
        if (chunk?.usage) usage = chunk.usage;
        if (Buffer.byteLength(text) > MAX_MESSAGE) fail('模型输出超过 1MiB', 'OUTPUT_LIMIT');
        yield chunk;
      }
      const after = await this.applyHooks('llm.after', { ...input, result: { text, ...(usage ? { usage } : {}) } }, context, options);
      yield { type: 'result', result: jsonValue(after.result) };
    }
    finally { await iterator.return?.(); }
  }
  async sample(caller, args = {}, context = {}, options = {}) {
    let text = '', usage, final;
    for await (const chunk of this.stream(caller, args, context, options)) {
      if (chunk?.type === 'result') { final = chunk.result; continue; }
      if (typeof chunk === 'string') text += chunk;
      else if (chunk && typeof chunk.text === 'string') text += chunk.text;
      if (chunk?.usage) usage = chunk.usage;
      if (Buffer.byteLength(text) > MAX_MESSAGE) fail('模型输出超过 1MiB', 'OUTPUT_LIMIT');
    }
    return jsonValue(final || { text, ...(usage ? { usage } : {}) });
  }
  async applyHooks(name, payload, context = {}, options = {}) {
    if (!HOOKS.has(name)) fail('未知插件钩子');
    let value = jsonValue(payload);
    const hooks = [...this.contributions.values()].filter(item => item.kind === 'hook' && item.name === name).sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId));
    for (const item of hooks) {
      this.assert(item.pluginId, 'hooks.register');
      const worker = await this.ensure(item.pluginId);
      const next = await this.invoke(worker, 'hook', name, null, value, this.scope(context, item), options);
      if (next?.cancel === true) fail(String(next.reason || '插件钩子拒绝此操作'), 'HOOK_REJECTED');
      if (next !== null) value = jsonValue(next);
    }
    return value;
  }
  disposePlugin(id) { const worker = this.workers.get(id); const stopped = worker ? this.stop(worker) : this.stopping.get(id); this.failures.delete(id); return stopped || Promise.resolve(); }
  dispose() { this.closed = true; const pending = [...this.workers.values()].map(worker => this.stop(worker)); this.contributions.clear(); return Promise.all([...pending, ...this.stopping.values()]); }
}
module.exports = { ForgeBackendManager, HOOKS };
