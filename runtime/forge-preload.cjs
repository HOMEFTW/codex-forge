// Runs in Electron's isolated preload world. Only host-owned frame identities
// can use the plugin API; plugin-supplied IDs are never trusted.
;(() => {
  const { ipcRenderer, contextBridge } = require('electron');
  const frames = new Map(), pending = new Map();
  let snapshot = null, serial = 0, refreshing = false, rerun = false, nativeRequest;
  // Main-process argv is not inherited by sandboxed renderer processes. Expose
  // an immutable startup value before native React code evaluates its gate.
  contextBridge.exposeInMainWorld('__codexForgeStartup', ipcRenderer.sendSync('forge:startup-flags'));
  const invoke = (method, args = {}) => ipcRenderer.invoke('forge:manage', {method,args});
  const post = (frame, name, value, metadata) => frame.contentWindow?.postMessage({forgePluginEvent:{name,value,metadata}}, '*');
  const escapeScript = s => s.replace(/<\/script/gi, '<\\/script');
  const active = id => snapshot?.plugins.find(p=>p.id===id)?.enabled;
  function contextFor(id) { const context={...(snapshot?.context || {threadId:null})}; const plugin=snapshot?.plugins.find(p=>p.id===id); if(!plugin?.permissions.includes('conversation.read')) context.threadId=null; return context; }
  function dispose(frame) {
    post(frame,'dispose',null);
    for (const [id, request] of pending) if (request.frame === frame) { clearTimeout(request.timer); pending.delete(id); request.reject(Error('插件已停止')); }
    frame.remove(); frames.delete(frame);
  }
  async function mount(mount, id, viewId, slotEntry) {
    const key=id+':'+(slotEntry?'slot/'+slotEntry:viewId||'runtime');
    if(!snapshot)return;
    if(!active(id)){if(viewId&&mount.dataset.forgeUnavailable!==id){mount.dataset.forgeUnavailable=id;mount.textContent='插件已停用或不兼容。';}return;}
    if(mount.dataset.forgeUnavailable){delete mount.dataset.forgeUnavailable;mount.textContent='';}
    if([...frames].some(([f,v])=>f.isConnected&&v.key===key&&v.mount===mount)) return;
    const frame=document.createElement('iframe'); frame.className='forge-plugin-frame'; frame.title=id; frame.setAttribute('sandbox','allow-scripts');
    frame.style.cssText=(viewId||slotEntry)?'border:0;width:100%;height:100%;min-height:0;flex:1':'display:none';
    const info={id,viewId,slotEntry,key,mount,ready:false,fingerprint:snapshot?.plugins.find(p=>p.id===id)?.fingerprint}; frames.set(frame,info); mount.append(frame);
    try {
      frame.addEventListener('load',()=>{info.ready=true;post(frame,'context.changed',contextFor(id));},{once:true});
      frame.src='codex-forge://plugin/'+encodeURIComponent(id)+'/'+(slotEntry?'slot/'+encodeURIComponent(slotEntry):encodeURIComponent(viewId||'runtime'));
    } catch(error) { dispose(frame); const p=document.createElement('p'); p.textContent=error.message; if(viewId) mount.append(p); }
  }
  function composer(action,args) {
    const root=[...document.querySelectorAll('[data-codex-composer-root]')].find(e=>e.getBoundingClientRect().height>0);
    const input=root?.querySelector('[contenteditable="true"],textarea');
    if(!input) throw Error('当前输入框不可用');
    const text=input.tagName==='TEXTAREA'?input.value:input.innerText;
    if(action==='composer.read') return {text};
    if(text!==args.expectedText) throw Error('草稿已变化，请重新读取再编辑');
    const next=action==='composer.insert'?text+args.text:args.text;
    input.focus();
    if(input.tagName==='TEXTAREA') { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,next);input.dispatchEvent(new Event('input',{bubbles:true})); }
    else { const range=document.createRange();range.selectNodeContents(input);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);if(!document.execCommand('insertText',false,next)) throw Error('原生输入框拒绝编辑'); }
    return {text:next};
  }
  async function run(id,item) {
    if(item.panel) return invoke('openPanel',{id,view:item.panel});
    const frame=[...frames].find(([f,v])=>v.id===id&&!v.viewId&&f.isConnected)?.[0];
    if(!frame||!frames.get(frame).ready) throw Error('插件正在加载，请稍后再试');
    const requestId=++serial;
    return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('插件命令超时'));},20000);pending.set(requestId,{frame,resolve,reject,timer});frame.contentWindow.postMessage({forgePluginCommand:{id:requestId,command:item.command,args:{},context:contextFor(id)}},'*'); });
  }
  function contributions() {
    if(!snapshot) return;
    const wanted=new Map();
    for(const p of snapshot.plugins.filter(p=>p.enabled&&!p.builtin)) for(const surface of ['sidebar','toolbar','composer']) for(const item of p.contributes?.[surface]||[]) wanted.set(p.id+':'+surface+':'+item.id,{pluginId:p.id,surface,item});
    for(const value of snapshot.dynamic) wanted.set(value.pluginId+':'+value.surface+':'+value.item.id,value);
    document.querySelectorAll('[data-forge-contribution]').forEach(e=>{if(!wanted.has(e.dataset.forgeContribution)) e.remove();});
    for(const [key,{pluginId,surface,item}] of wanted) {
      const target=surface==='toolbar'?document.querySelector('[role="menubar"]'):surface==='sidebar'?document.getElementById('fast-canvas-entry')?.parentElement:document.querySelector('[data-codex-composer-root] [data-composer-navigation-target="permissions"]')?.parentElement;
      if(!target) continue;
      let button=[...document.querySelectorAll('[data-forge-contribution]')].find(e=>e.dataset.forgeContribution===key);
      if(!button) { button=document.createElement('button');button.type='button';button.dataset.forgeContribution=key;button.style.cssText='color:inherit;background:transparent;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;-webkit-app-region:no-drag';target.append(button); }
      if(button.textContent!==item.title) button.textContent=item.title;const title=snapshot.plugins.find(p=>p.id===pluginId)?.name;if(button.title!==title)button.title=title;
      button.onclick=()=>run(pluginId,item).catch(error=>{button.title=error.message;console.error('[Forge]',error);});
    }
    const canvas=document.getElementById('fast-canvas-entry');if(canvas){const visibility=active('forge.canvas')?'':'hidden';if(canvas.style.visibility!==visibility)canvas.style.visibility=visibility;}
  }
  function outputView() {
    const timeline=document.querySelector('[data-app-action-timeline-scroll]');
    let section=document.getElementById('forge-chat-output');
    if(!timeline||!snapshot?.output.length) {section?.remove();return;}
    const key=JSON.stringify([snapshot.context.threadId,snapshot.output]);
    if(section?.dataset.key===key) return;
    section?.remove();section=document.createElement('section');section.id='forge-chat-output';section.dataset.key=key;section.style.cssText='margin:16px auto;padding:16px;width:min(760px,95%);box-sizing:border-box';
    for(const item of snapshot.output) {const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');summary.textContent=item.pluginName+' · '+item.title;body.textContent=item.text;body.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto';details.append(summary,body);section.append(details);}
    (timeline.querySelector('[data-thread-user-message-navigation-content]')||timeline).append(section);
  }
  // 命名 UI 贡献点：宿主下发 anchor 选择器，这里只负责挂 iframe。anchor 为 null
  // 表示落点尚未实测，插件声明会被接受但不渲染；锚点不存在时静默跳过。
  // single/keyed 的冲突已由宿主在生成 snapshot 前判定。
  let slotSerial = 0;
  function slotViews() {
    if(!snapshot) return;
    const wanted=new Map();
    for(const item of snapshot.slots?.entries||[]) if(item.anchor) wanted.set(item.pluginId+'|'+item.slot+'|'+(item.key||item.id),item);
    for(const host of [...document.querySelectorAll('[data-forge-slot-view]')]) {
      if(wanted.has(host.dataset.forgeSlotView)) continue;
      for(const child of [...host.children]) if(frames.has(child)) dispose(child);
      host.remove();
    }
    for(const [key,item] of wanted) for(const anchor of document.querySelectorAll(item.anchor)) {
      if(!anchor.isConnected) continue;
      if(!anchor.dataset.forgeSlotOwner) anchor.dataset.forgeSlotOwner='slot-'+(++slotSerial);
      const owner=anchor.dataset.forgeSlotOwner;
      if([...document.querySelectorAll('[data-forge-slot-view]')].some(e=>e.dataset.forgeSlotView===key&&e.dataset.forgeSlotOwner===owner)) continue;
      const host=document.createElement('div');host.dataset.forgeSlotView=key;host.dataset.forgeSlotOwner=owner;host.style.cssText='display:contents';anchor.append(host);
      mount(host,item.pluginId,null,item.id).catch(error=>console.error('[Forge]',error));
    }
  }
  // 调试插件用：只读采集宿主 DOM 的锚点命中情况，不读取消息内容、凭据或会话正文。
  function collectDiagnostics() {
    const describe = (el) => {
      if (!el) return null;
      const path = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) path.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ''));
      return { tag: el.tagName, role: el.getAttribute('role'), testid: el.getAttribute('data-testid'), cls: String(el.className || '').slice(0, 100), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), path: path.slice(-6).join('>') };
    };
    const slots = (snapshot?.slots?.config || []).map(slot => {
      let matches = [];
      if (slot.anchor) { try { matches = [...document.querySelectorAll(slot.anchor)]; } catch { matches = []; } }
      return { id: slot.id, kind: slot.kind, label: slot.label, anchor: slot.anchor, verified: slot.verified, matches: matches.length, samples: matches.slice(0, 3).map(describe) };
    });
    const probes = { menubar: '[role="menubar"]', menuitem: '[role="menuitem"]', tabpanel: '[role="tabpanel"]', main: '[role="main"]', asides: 'aside', composer: '[data-codex-composer-root]', toolCards: '[role="article"], [data-testid*="tool"], [class*="tool-call"]' };
    return {
      at: new Date().toISOString(), href: location.href, title: document.title,
      nodes: document.querySelectorAll('*').length, slots,
      probes: Object.entries(probes).map(([name, selector]) => {
        let found = [];
        try { found = [...document.querySelectorAll(selector)]; } catch { found = []; }
        return { name, selector, matches: found.length, samples: found.slice(0, 3).map(describe) };
      })
    };
  }
  // 调试插件的脚本执行：作用域是宿主渲染进程的全局，不是插件 iframe。
  // 仅内置工具可用；限制长度与异步等待时间，同步脚本仍具有宿主调试权限。
  function describeValue(value) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    if (typeof value === 'function') return { type: 'function', name: value.name || '(anonymous)', source: String(value).slice(0, 1000) };
    if (typeof value !== 'object') return { type: typeof value, value: String(value).slice(0, 2000) };
    if (value instanceof Element) return { type: 'element', tag: value.tagName, id: value.id, cls: String(value.className || '').slice(0, 200), text: (value.textContent || '').trim().slice(0, 200), html: value.outerHTML.slice(0, 800) };
    if (value instanceof Node) return { type: 'node', name: value.nodeName };
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return { type: 'object', value: String(value).slice(0, 2000) };
      return { type: Array.isArray(value) ? 'array' : 'object', value: json.slice(0, 20000), truncated: json.length > 20000 };
    } catch { return { type: 'object', value: String(value).slice(0, 2000), note: '不可序列化' }; }
  }
  async function evaluateScript(code) {
    if (typeof code !== 'string' || !code.trim()) throw Error('脚本为空');
    if (code.length > 20000) throw Error('脚本超过 20000 字符');
    const started = performance.now();
    const runner = new Function('return (async () => { ' + code + ' })()');
    let timer;
    try {
      const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('脚本异步等待超时（30 秒）')), 30000); });
      const value = await Promise.race([runner(), timed]);
      return { ms: Math.round(performance.now() - started), result: describeValue(value) };
    } finally { clearTimeout(timer); }
  }
  async function refresh() {
    if(refreshing){rerun=true;return;}refreshing=true;
    try {
      const previous=snapshot;snapshot=await invoke('snapshot');
      for(const [frame,info] of frames) {
        if(!frame.isConnected||!active(info.id)||snapshot.plugins.find(p=>p.id===info.id)?.fingerprint!==info.fingerprint) {dispose(frame);continue;}
        if(previous?.context.threadId!==snapshot.context.threadId) post(frame,'context.changed',contextFor(info.id));
        post(frame,'settings.changed',null);
      }
      for(const p of snapshot.plugins.filter(p=>p.enabled&&!p.builtin&&p.entry)) await mount(document.body,p.id);
      contributions();outputView();slotViews();
    } catch(error){console.error('[Forge]',error.message);}finally{refreshing=false;if(rerun){rerun=false;setTimeout(refresh,100);}}
  }
  window.addEventListener('message',async event=>{
    const frame=[...frames.keys()].find(f=>f.isConnected&&f.contentWindow===event.source);if(!frame||event.origin!=='null') return;
    const info=frames.get(frame), reply=event.data?.forgePluginCommandReply;
    if(reply) {const p=pending.get(reply.id);if(p?.frame===frame){pending.delete(reply.id);clearTimeout(p.timer);reply.error?p.reject(Error(reply.error)):p.resolve(reply.result);}return;}
    const request=event.data?.forgePluginRequest;if(!request||!Number.isSafeInteger(request.id)||typeof request.method!=='string') return;
    if(request.method==='devtools.eval'||request.method==='diagnostics.collect') {
      try {
        const plugin=snapshot?.plugins.find(p=>p.id===info.id);
        if(!plugin?.builtin||plugin.id!=='forge.devtools'||!plugin.enabled||!plugin.permissions.includes('devtools')||plugin.fingerprint!==info.fingerprint) throw Error('宿主调试仅限已启用的内置 forge.devtools 插件');
        await ipcRenderer.invoke('forge:authorizeDevtools',{id:info.id,fingerprint:info.fingerprint});
        if(!frame.isConnected||frames.get(frame)!==info||!active(info.id)||snapshot.plugins.find(p=>p.id===info.id)?.fingerprint!==info.fingerprint) throw Error('插件已停止或发生变化');
        const result=request.method==='devtools.eval'?await evaluateScript(request.args?.code):collectDiagnostics();
        frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,result}},'*');
      } catch(error) { frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,error:error.message}},'*'); }
      return;
    }
    try {
      let result=await ipcRenderer.invoke('forge:api',{...request,id:info.id});
      if(result?.nativeAction==='close') result=await nativeRequest('close',{page:result.page});
      else if(result?.nativeAction?.startsWith('composer.')) result=composer(result.nativeAction,result.args);
      frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,result}},'*');
    }catch(error){frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,error:error.message}},'*');}
  });
  globalThis.__forgeBridge={configure:fn=>{nativeRequest=fn;},mount:(node,page)=>{const [,id,viewId]=page.split(':');return mount(node,id,viewId);},refresh,layout:()=>{contributions();outputView();},snapshot:()=>snapshot};
  ipcRenderer.on('fast-ext:changed',(_event,payload)=>{
    if(payload?.type==='forge-plugin-event') {
      for(const [frame,info] of frames) {
        if(!frame.isConnected||!active(info.id)) continue;
        if(payload.metadata?.threadId && contextFor(info.id).threadId!==payload.metadata.threadId) continue;
        post(frame,payload.name,payload.value,payload.metadata);
      }
    }
    refresh();
  });
  window.addEventListener('DOMContentLoaded',()=>refresh(),{once:true});
})();
