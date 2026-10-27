// Appended to the original sandboxed preload; the canvas iframe has no Node access.
;(() => {
  const { ipcRenderer } = require('electron');
  let panel = null, queued = false, requestId = 0;
  const nativePending = new Map(), frames = new Map();
  const pages = new Set(['canvas', 'todos', 'collaboration', 'skills', 'information-stats', 'codex-memory', 'updates','forge-settings','forge-updates','forge-plugins','forge-features','forge-changelog','forge-extension-info','forge-output']);
  function nativeRequest(action, value = {}) {
    return new Promise((resolve, reject) => {
      const id = ++requestId, timer = setTimeout(() => { nativePending.delete(id); reject(new Error('原生标签页未响应，请重新打开面板')); }, 12000);
      nativePending.set(id, { resolve, reject, timer });
      window.postMessage({ fastWorkspaceNativeRequest: { id, action, page: value.page, mode: value.mode, threadId: value.threadId, scopeId: value.scopeId } }, '*');
    });
  }
  globalThis.__forgeBridge?.configure(nativeRequest);
  const svg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v8a1 1 0 0 0 1 1H14M10 6h7a1 1 0 0 1 1 1v8"/></svg>';
  function locate() {
    const rail = [...document.querySelectorAll('nav,[role="navigation"]')].find(element => { const r = element.getBoundingClientRect(); return r.left < 100 && r.width >= 36 && r.width < 100 && r.height > innerHeight * .5; });
    const entry = [...document.querySelectorAll('.sidebar-item')].find(element => element.id !== 'fast-canvas-entry' && element.getBoundingClientRect().width > 30 && element.getBoundingClientRect().left < 400);
    let candidate = null, sidebar = [...document.querySelectorAll('aside,[role="complementary"]')].find(element => { const r = element.getBoundingClientRect(); return r.left < 100 && r.width < 450 && r.height > innerHeight * .5; }) || rail || entry;
    for (let current = sidebar?.parentElement; current && current !== document.body; current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      if (!rail && rect.width > 100 && rect.width < 440 && rect.height > innerHeight * .5) sidebar = current;
      if (rect.width > innerWidth * .8 && rect.height > innerHeight * .6 && rect.top >= 28) { candidate = current; break; }
    }
    return { entry, rail, region: candidate || document.querySelector('#root') || document.body, sidebar };
  }
  function sendFrame(frame, value) { frame.contentWindow?.postMessage({ fastCanvasEvent: value }, '*'); }
  function forward(payload) {
    for (const [frame, info] of frames) {
      if (!frame.isConnected || payload.type === 'open' && payload.page !== info.page) continue;
      sendFrame(frame, payload.type === 'open' ? { ...payload, page: info.page, mode: info.mount.dataset.fastNativeMode || 'right' } : payload);
    }
  }
  function layout() {
    for (const [frame] of frames) if (!frame.isConnected) frames.delete(frame);
    for (const mount of document.querySelectorAll('[data-fast-native-page],[data-forge-settings-mount]')) {
      const page = mount.hasAttribute('data-forge-settings-mount') ? 'forge-settings' : mount.dataset.fastNativePage;
      if(page?.startsWith('forge-plugin:')) { globalThis.__forgeBridge?.mount(mount,page); continue; }
      if (!pages.has(page)) continue;
      let frame = [...mount.children].find(element => element.classList.contains('fast-workspace-frame'));
      if (!frame) {
        frame = document.createElement('iframe'); frame.className = 'fast-workspace-frame'; frame.title = 'Codex Forge';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app://-/fast-canvas/app.css?v=__FAST_UI_VERSION__"><title>FAST 工作区</title></head><body><div id="root"></div><script src="app://-/fast-canvas/app.js?v=__FAST_UI_VERSION__"></script></body></html>';
        frames.set(frame, { page, mount, mode: mount.dataset.fastNativeMode || 'right' });
        mount.appendChild(frame);
      }
      const info = frames.get(frame);
      if(info&&info.selectedPlugin!==mount.dataset.forgeSettingsPlugin){info.selectedPlugin=mount.dataset.forgeSettingsPlugin;sendFrame(frame,{type:'forge-settings-focus',id:info.selectedPlugin});}
      const mode = mount.dataset.fastNativeMode || 'right';
      if (info && info.mode !== mode) { info.mode = mode; sendFrame(frame, { type: 'mode', mode }); }
    }
  }
  async function show(value) {
    if(value&&document.querySelector('[data-forge-settings-mount]')){await ipcRenderer.invoke('forge:manage',{method:'returnToChat'});await new Promise(resolve=>{const until=Date.now()+4000;const check=()=>{if(!document.querySelector('[data-forge-settings-mount]')||Date.now()>until)resolve();else setTimeout(check,50);};check();});}
    const previous = panel; panel = value;
    if (value) nativeRequest('open', value).then(refresh).catch(error => console.error('[FAST native tabs]', error.message));
    else if (previous) nativeRequest('close', previous).catch(error => console.error('[FAST native tabs]', error.message));
  }
  function entry() {
    const found = locate(); let button = document.getElementById('fast-canvas-entry');
    if (!button) {
      button = document.createElement('button'); button.id = 'fast-canvas-entry'; button.type = 'button';
      button.setAttribute('data-sidebar-cycle-item', 'true'); button.setAttribute('aria-label', '无限画布'); button.title = '无限画布 · 在右侧栏打开';
      button.innerHTML = svg + '<span>无限画布</span>';
      button.addEventListener('click', () => ipcRenderer.invoke('fast-ext:host-open', { mode: 'right' }).catch(() => {}));
    }
    if (found.rail) {
      button.className = 'fast-canvas-entry'; button.querySelector('span').style.display = 'none';
      button.style.cssText = 'display:flex;align-items:center;justify-content:center;flex:0 0 36px;width:36px;height:36px;min-height:36px;padding:8px;margin:2px auto;border:0;border-radius:8px;background:transparent;color:inherit;-webkit-app-region:no-drag;cursor:pointer';
      const first = [...found.rail.querySelectorAll('button')].find(item => item.id !== button.id && item.getBoundingClientRect().height > 10);
      let target = found.rail;
      for (let current = first?.parentElement; current && current !== found.rail; current = current.parentElement) {
        if (current.querySelectorAll('button').length >= 2 && current.getBoundingClientRect().width < 100) { target = current; break; }
      }
      if (button.parentElement !== target) target.appendChild(button);
    } else if (found.entry) {
      button.querySelector('span').style.display = '';
      button.className = 'sidebar-item fast-canvas-entry';
      button.style.cssText = 'display:flex;align-items:center;gap:8px;flex:0 0 32px;min-height:32px;height:32px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:inherit;-webkit-app-region:no-drag;cursor:pointer';
      let target = found.entry.parentElement;
      for (let candidate = target; candidate && candidate !== document.body; candidate = candidate.parentElement) {
        if (candidate.getBoundingClientRect().width < 440 && candidate.querySelectorAll('.sidebar-item').length >= 2) { target = candidate; break; }
      }
      if (button.parentElement !== target) target.appendChild(button);
    } else {
      button.querySelector('span').style.display = 'none';
      button.style.cssText = 'position:fixed;left:10px;top:54px;z-index:41;display:flex;align-items:center;gap:6px;padding:8px;border:1px solid #67776d66;border-radius:7px;color:inherit;background:var(--color-token-bg-primary,#262c28);cursor:pointer;-webkit-app-region:no-drag;font-size:12px';
      if (button.parentElement !== document.body) document.body.appendChild(button);
    }
  }
  function ensureMenu() {
    if (document.getElementById('fast-updates-entry')) return;
    const bar = document.querySelector('[role="menubar"]'); if (!bar) return;
    const items = [...bar.querySelectorAll('[role="menuitem"]')].filter(item => item.textContent.trim() && item.getBoundingClientRect().width > 0);
    const help = items.find(item => /^(帮助|help)$/i.test(item.textContent.trim())) || items.at(-1); if (!help) return;
    const button = document.createElement('button'); button.id = 'fast-updates-entry'; button.type = 'button'; button.role = 'menuitem'; button.tabIndex = 0; button.className = help.className;
    button.textContent = '升级'; button.style.webkitAppRegion = 'no-drag';
    button.addEventListener('click', () => ipcRenderer.invoke('fast-ext:host-open', { page: 'forge-updates' }).catch(() => {}));
    const existing=[...bar.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='升级');
    if(!existing) help.after(button);
    let manager=[...bar.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='插件管理');
    if(!manager){manager=document.createElement('button');manager.id='forge-plugins-entry';manager.type='button';manager.role='menuitem';manager.className=help.className;manager.textContent='插件管理';manager.style.webkitAppRegion='no-drag';manager.onclick=()=>ipcRenderer.invoke('fast-ext:host-open',{page:'forge-plugins'});(existing||button).after(manager);}
  }
  function refresh() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; ensureMenu(); entry(); layout(); globalThis.__forgeBridge?.layout(); }); }
  ipcRenderer.on('fast-ext:panel', (_event, value) => show(value));
  ipcRenderer.on('fast-ext:changed', (_event, value) => forward(value));
  window.addEventListener('message', async event => {
    if (event.source === window && event.data?.fastWorkspaceNativeReply) {
      const reply = event.data.fastWorkspaceNativeReply, waiting = nativePending.get(reply.id);
      if (waiting) { nativePending.delete(reply.id); clearTimeout(waiting.timer); reply.error ? waiting.reject(new Error(reply.error)) : waiting.resolve(reply.result); }
      return;
    }
    const frame = [...frames.keys()].find(element => element.isConnected && element.contentWindow === event.source);
    if (!frame || event.origin !== 'null') return;
    const info = frames.get(frame), request = event.data?.fastCanvasRequest;
    if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') return;
    try {
      const args = request.args || {};
      if(request.method==='forge'&&!info.page.startsWith('forge-')&&args.method!=='openSettings') throw Error('管理操作仅在 Forge 页面可用');
      let result;
      if (request.method === 'mode' || request.method === 'close') {
        result = await nativeRequest(request.method, { page: info.page, mode: args.mode, threadId: info.threadId, scopeId: info.mount.dataset.fastNativeScope });
      } else {
        if (request.method === 'statistics' && info.page !== 'information-stats') throw Error('统计操作仅在信息统计页面可用');
        if (request.method === 'memory' && info.page !== 'codex-memory') throw Error('记忆管理操作仅在记忆管理页面可用');
        const nativeCollaboration = request.method === 'collaboration' && ['capabilities', 'set_thread', 'direct'].includes(args.method);
        result = request.method === 'statistics' ? await ipcRenderer.invoke('fast-ext:statistics', { ...args, threadId:info.threadId }) : request.method === 'memory' ? await ipcRenderer.invoke('fast-ext:memory', args) : await ipcRenderer.invoke(nativeCollaboration ? 'fast-ext:collaboration-native' : 'fast-ext:canvas', nativeCollaboration ? args : { method: request.method, args });
        if(request.method==='forge'&&args.method==='snapshot'&&info.page==='forge-settings') result.settingsPlugin=info.mount.dataset.forgeSettingsPlugin||result.settingsPlugin;
        if (request.method === 'bootstrap') {
          info.threadId = result.threadId;
          result = { ...result, panel: { ...result.panel, page: info.page, mode: info.mount.dataset.fastNativeMode || 'right' } };
        }
      }
      frame.contentWindow?.postMessage({ fastCanvasReply: request.id, result }, '*');
    }
    catch (error) { frame.contentWindow?.postMessage({ fastCanvasReply: request.id, error: error.message }, '*'); }
  });
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style'); style.id = 'fast-canvas-layout';
    style.textContent = '#fast-canvas-entry:hover{background:rgba(127,127,127,.15)!important}[data-fast-native-page],[data-forge-settings-mount]{width:100%;height:100%;min-height:0;min-width:0;display:flex;overflow:hidden}.fast-workspace-frame{display:block;width:100%;height:100%;min-height:0;min-width:0;flex:1;border:0;color-scheme:normal;-webkit-app-region:no-drag}';
    document.head.appendChild(style);
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-fast-native-mode', 'data-fast-native-page','data-forge-settings-plugin'] });
    refresh(); ipcRenderer.invoke('fast-ext:host-ready').then(show).catch(() => {});
  }, { once: true });
  window.addEventListener('resize', refresh);
})();
