// Browser SDK: works only inside a Forge-owned sandbox. No Node or arbitrary IPC.
(() => {
  const waiting = new Map(), handlers = new Map(), listeners = new Map(), streams = new Set(); let sequence = 0, context = { threadId: null }, disposed = false, denied = {};
  const apiError = (value, code = 'INTERNAL_ERROR') => Object.assign(new Error(typeof value === 'string' ? value : value?.message || 'Forge 请求失败'), { name: 'ForgeError', code: value?.code || code });
  function request(method, args = {}, options = {}, threadId = context.threadId, generation = context.generation ?? 0) {
    if (disposed) return Promise.reject(apiError('插件已停止', 'PLUGIN_DISABLED'));
    // 宿主会按清单 capabilities 授权；这里提前拒绝并给出同样的修复指引，
    // 让开发者在插件侧就能看到原因，而不是等宿主报错。
    if (denied[method]) return Promise.reject(apiError(denied[method], 'CAPABILITY_UNAVAILABLE'));
    if (waiting.size >= 64) return Promise.reject(apiError('并发请求过多', 'RESOURCE_LIMIT'));
    const timeoutMs = options.timeoutMs ?? (method === 'dsh.request' ? 90000 : 20000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) return Promise.reject(apiError('超时时间必须为 1–600000 毫秒的整数', 'INVALID_ARGUMENT'));
    if (options.signal?.aborted) return Promise.reject(apiError('请求已取消', 'CANCELLED'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const cancelHost = () => { if (api.hostApiVersion >= 5) { const cancelId = ++sequence; parent.postMessage({ forgePluginRequest: { id: cancelId, requestId: cancelId, method: 'rpc.cancel', args: { requestId: id }, threadId, generation } }, '*'); } };
      const finish = () => { waiting.delete(id); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      const abort = () => { finish(); cancelHost(); reject(apiError('请求已取消', 'CANCELLED')); };
      const timer = setTimeout(() => { finish(); cancelHost(); reject(apiError('Forge 请求超时', 'TIMEOUT')); }, timeoutMs);
      waiting.set(id, { resolve, reject, finish });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { parent.postMessage({ forgePluginRequest: { id, requestId: id, method, args, threadId, generation, timeoutMs, options: { timeoutMs } } }, '*'); }
      catch (error) { finish(); reject(apiError(error)); }
    });
  }
  function stream(method, args = {}, options = {}) {
    const threadId = context.threadId, generation = context.generation ?? 0;
    const opened = request('rpc.stream.open', { method, args, ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }) }, options, threadId, generation);
    opened.catch(() => {});
    let done = false, reading = false, streamId;
    const id = async () => { if (!streamId) streamId = (await opened).streamId; return streamId; };
    const close = async () => {
      if (done) return { closed: true };
      done = true; streams.delete(handle); options.signal?.removeEventListener('abort', aborted);
      try { return await request('rpc.stream.cancel', { streamId: await id() }, {}, threadId, generation); }
      catch (error) { if (['CANCELLED', 'STREAM_NOT_FOUND', 'PLUGIN_DISABLED'].includes(error.code)) return { closed: true }; throw error; }
    };
    const aborted = () => { void close().catch(error => console.error(error)); };
    const handle = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (done) return { value: undefined, done: true };
        if (reading) throw apiError('同一流只能有一个待处理读取', 'INVALID_ARGUMENT');
        reading = true;
        try {
          const result = await request('rpc.stream.next', { streamId: await id() }, { ...options, timeoutMs: options.timeoutMs ?? 600000 }, threadId, generation);
          if (result.done) { done = true; streams.delete(handle); options.signal?.removeEventListener('abort', aborted); }
          return result;
        } catch (error) { await close().catch(() => {}); throw error; }
        finally { reading = false; }
      },
      async send(value) { if (done) throw apiError('RPC 流已结束', 'STREAM_CLOSED'); return request('rpc.stream.send', { streamId: await id(), value }, options, threadId, generation); },
      async end() { if (done) return { ended: true }; return request('rpc.stream.end', { streamId: await id() }, options, threadId, generation); },
      dispose: close,
      async return() { await close(); return { value: undefined, done: true }; },
    };
    streams.add(handle); options.signal?.addEventListener('abort', aborted, { once: true });
    opened.catch(() => { streams.delete(handle); options.signal?.removeEventListener('abort', aborted); });
    if (options.signal?.aborted) aborted();
    return handle;
  }
  function on(name, callback) { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); }
  function emit(name, value, metadata) { for (const callback of listeners.get(name) || []) { try { callback(value, metadata); } catch (error) { console.error(error); } } }
  let themeProperties = [];
  function applyTheme(value) {
    if (typeof document === 'undefined' || !document.documentElement?.style) return;
    const style = document.documentElement.style;
    for (const name of themeProperties) style.removeProperty(name);
    const tokens = value?.tokens || value?.theme?.tokens || {};
    themeProperties = Object.keys(tokens).filter(name => /^--forge-[a-z0-9-]{1,80}$/.test(name) && typeof tokens[name] === 'string');
    for (const name of themeProperties) style.setProperty(name, tokens[name]);
  }
  window.addEventListener('message', async event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data?.forgePluginReply) {
      const { id, result, error } = data.forgePluginReply, pending = waiting.get(id); if (!pending) return;
      pending.finish(); error ? pending.reject(apiError(error)) : pending.resolve(result);
    }
    if (data?.forgePluginEvent) {
      const { name, value, metadata } = data.forgePluginEvent;
      if (name === 'context.changed') context = value;
      if (name === 'theme.changed') applyTheme(value);
      if (name === 'dispose') { applyTheme(null); for (const handle of streams) void handle.dispose().catch(() => {}); disposed = true; for (const pending of waiting.values()) { pending.finish(); pending.reject(apiError('插件已停止', 'PLUGIN_DISABLED')); } waiting.clear(); }
      emit(name, value, metadata);
    }
    if (data?.forgePluginCommand) {
      const { id, command, args, context: supplied } = data.forgePluginCommand;
      if (supplied) context = supplied;
      try { const handler = handlers.get(command); if (!handler) throw Error('插件尚未注册命令：'+command); const result = await handler(args); parent.postMessage({ forgePluginCommandReply: { id, result: result ?? null } }, '*'); }
      catch (error) { parent.postMessage({ forgePluginCommandReply: { id, error: error.message } }, '*'); }
    }
  });
  const api = {
    apiVersion: 5,
    hostApiVersion: 5,
    rpc: { stream },
    context: { async get() { return context = await request('context.get'); } },
    events: { on, emit: (name, value) => request('events.emit', { name, value }) },
    commands: { register(id, handler) { if (handlers.has(id)) throw Error('重复命令'); handlers.set(id, handler); return () => handlers.delete(id); } },
    panels: { open: (id, options = {}) => request('panels.open', { id, ...options }), close: id => request('panels.close', { id }) },
    sidebar: { register: item => register('sidebar', item) },
    toolbar: { register: item => register('toolbar', item) },
    composer: { register: item => register('composer', item), read: () => request('composer.read'), insertText: (text, expectedText) => request('composer.insert', { text, expectedText }), setText: (text, expectedText) => request('composer.set', { text, expectedText }) },
    conversations: {
      setTitle: title => request('conversation.title', { title }),
      list: (args = {}, options = {}) => request('conversation.list', args, options),
      read: (args = {}, options = {}) => request('conversation.read', args, options),
      create: (args = {}, options = {}) => request('conversation.create', args, options),
      fork: (args = {}, options = {}) => request('conversation.fork', args, options),
      send: (args, options = {}) => request('conversation.send', args, options),
      cancel: (args = {}, options = {}) => request('conversation.cancel', args, options),
      events: (args = {}, options = {}) => stream('conversation.events', args, options),
      on: (name, listener) => on(name.startsWith('conversation.') ? name : 'conversation.' + name, listener),
    },
    output: { append: (text, options = {}) => request('output.append', { text, ...options }), clear: () => request('output.clear'), open: () => request('output.open') },
    browser: { open: url => request('browser.open', { url }) },
    storage: { get: key => request('storage.get', { key }), set: (key, value) => request('storage.set', { key, value }), delete: key => request('storage.delete', { key }) },
    dsh: { request: (endpoint, options = {}) => request('dsh.request', { endpoint, ...options }) },
    settings: { get: () => request('settings.get'), snapshot: (options = {}) => request('settings.snapshot', {}, options), set: (value, expectedRevision, options = {}) => request('settings.set', { value, expectedRevision }, options) },
    nexus: { request: (method, args = {}) => request('nexus.request', { method, args }), connect: () => request('nexus.connect'), disconnect: vaultId => request('nexus.disconnect', { vaultId }) },
    metadata: { get: () => request('metadata.get') },
    capabilities: { get: () => request('capabilities.get') },
    diagnostics: { get: () => request('diagnostics.collect') },
    devtools: { eval: code => request('devtools.eval', { code }) },
    llm: { providers: (options = {}) => request('llm.providers', {}, options), sample: (args, options = {}) => request('llm.sample', args, options), stream: (args, options = {}) => stream('llm.stream', args, options) },
    services: { request: (name, method, args = {}, options = {}) => request('services.request', { name, method, args }, options), channel: (name, method, args = {}, options = {}) => stream('services.channel', { name, method, args }, options) },
    backend: { call: (method, args = {}, options = {}) => request('backend.call', { method, args }, options), channel: (method, args = {}, options = {}) => stream('backend.channel', { method, args }, options) },
    tools: { list: (options = {}) => request('tools.list', {}, options), call: (name, args = {}, options = {}) => request('tools.call', { name, args }, options) },
    plugins: {
      list: (args = {}, options = {}) => request('plugins.list', args, options),
      catalog: (args = {}, options = {}) => request('plugins.catalog', args, options),
      install: (entry, options = {}) => request('plugins.install', typeof entry === 'string' ? { id: entry } : entry, options),
      checkUpdate: (id, options = {}) => request('plugins.checkUpdate', { id }, options),
      update: (id, options = {}) => request('plugins.update', { id }, options),
      enable: (id, enabled, options = {}) => request('plugins.enable', { id, enabled }, options),
      uninstall: (id, options = {}) => request('plugins.uninstall', { id }, options),
    },
    shell: { execute: (args, options = {}) => request('shell.execute', args, options) },
    network: { fetch: (args, options = {}) => request('network.fetch', args, options) },
    credentials: { set: (name, value, options = {}) => request('credentials.set', { name, value }, options), delete: (name, options = {}) => request('credentials.delete', { name }, options), describe: (name, options = {}) => request('credentials.describe', { name }, options) },
    hooks: { list: (options = {}) => request('hooks.list', {}, options) },
    logs: { write: (entry, options = {}) => request('logs.write', entry, options), read: (args = {}, options = {}) => request('logs.read', args, options) },
    theme: { get: (options = {}) => request('theme.get', {}, options), set: (id, options = {}) => request('theme.set', { id }, options), register: (definition, options = {}) => request('theme.register', definition, options) },
    shortcuts: { register: item => { const ready = request('shortcuts.register', item); return async () => { await ready; return request('shortcuts.unregister', { id: item.id }); }; }, unregister: id => request('shortcuts.unregister', { id }) },
  };
  for (const name of ['canvas', 'todos', 'skills', 'memory', 'statistics', 'collaboration', 'files', 'jobs', 'schedules']) api[name] = { request: (method, args = {}, options = {}) => request(name + '.request', { method, args }, options) };
  api.files.watch = (args, options = {}) => stream('files.watch', args, options);
  function register(surface, item) { const promise = request('ui.register', { surface, item }); return async () => { await promise; return request('ui.unregister', { surface, id: item.id }); }; }
  Object.defineProperty(window, 'CodexForge', { value: Object.freeze(api), writable: false });
  request('capabilities.get').then(value => { denied = value?.denied || {}; }).catch(error => console.error(error));
  request('context.get').then(value => { context = value; emit('ready', value); }).catch(error => console.error(error));
})();
