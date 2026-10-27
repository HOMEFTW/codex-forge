// Browser SDK: works only inside a Forge-owned sandbox. No Node or arbitrary IPC.
(() => {
  const waiting = new Map(), handlers = new Map(), listeners = new Map(); let sequence = 0, context = { threadId: null }, disposed = false, denied = {};
  function request(method, args = {}) {
    if (disposed) return Promise.reject(Error('插件已停止'));
    // 宿主会按清单 capabilities 授权；这里提前拒绝并给出同样的修复指引，
    // 让开发者在插件侧就能看到原因，而不是等宿主报错。
    if (denied[method]) return Promise.reject(Error(denied[method]));
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { waiting.delete(id); reject(Error('Forge 请求超时')); }, method === 'dsh.request' ? 90000 : 20000);
      waiting.set(id, { resolve, reject, timer });
      parent.postMessage({ forgePluginRequest: { id, method, args, threadId: context.threadId } }, '*');
    });
  }
  function on(name, callback) { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); }
  function emit(name, value, metadata) { for (const callback of listeners.get(name) || []) { try { callback(value, metadata); } catch (error) { console.error(error); } } }
  window.addEventListener('message', async event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data?.forgePluginReply) {
      const { id, result, error } = data.forgePluginReply, pending = waiting.get(id); if (!pending) return;
      waiting.delete(id); clearTimeout(pending.timer); error ? pending.reject(Error(error)) : pending.resolve(result);
    }
    if (data?.forgePluginEvent) {
      const { name, value, metadata } = data.forgePluginEvent;
      if (name === 'context.changed') context = value;
      if (name === 'dispose') { disposed = true; for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(Error('插件已停止')); } waiting.clear(); }
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
    apiVersion: 2,
    context: { async get() { return context = await request('context.get'); } },
    events: { on, emit: (name, value) => request('events.emit', { name, value }) },
    commands: { register(id, handler) { if (handlers.has(id)) throw Error('重复命令'); handlers.set(id, handler); return () => handlers.delete(id); } },
    panels: { open: (id, options = {}) => request('panels.open', { id, ...options }), close: id => request('panels.close', { id }) },
    sidebar: { register: item => register('sidebar', item) },
    toolbar: { register: item => register('toolbar', item) },
    composer: { register: item => register('composer', item), read: () => request('composer.read'), insertText: (text, expectedText) => request('composer.insert', { text, expectedText }), setText: (text, expectedText) => request('composer.set', { text, expectedText }) },
    conversations: { setTitle: title => request('conversation.title', { title }) },
    output: { append: (text, options = {}) => request('output.append', { text, ...options }), clear: () => request('output.clear'), open: () => request('output.open') },
    browser: { open: url => request('browser.open', { url }) },
    storage: { get: key => request('storage.get', { key }), set: (key, value) => request('storage.set', { key, value }), delete: key => request('storage.delete', { key }) },
    dsh: { request: (endpoint, options = {}) => request('dsh.request', { endpoint, ...options }) },
    settings: { get: () => request('settings.get') },
    metadata: { get: () => request('metadata.get') },
    capabilities: { get: () => request('capabilities.get') },
    diagnostics: { get: () => request('diagnostics.collect') },
    devtools: { eval: code => request('devtools.eval', { code }) },
  };
  function register(surface, item) { const promise = request('ui.register', { surface, item }); return async () => { await promise; return request('ui.unregister', { surface, id: item.id }); }; }
  Object.defineProperty(window, 'CodexForge', { value: Object.freeze(api), writable: false });
  request('capabilities.get').then(value => { denied = value?.denied || {}; }).catch(error => console.error(error));
  request('context.get').then(value => { context = value; emit('ready', value); }).catch(error => console.error(error));
})();
