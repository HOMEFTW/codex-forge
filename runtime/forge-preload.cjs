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
  function contextFor(id) { const context={...(snapshot?.context || {threadId:null})}; const plugin=snapshot?.plugins.find(p=>p.id===id); if(!plugin?.permissions.includes('conversation.read')&&!snapshot?.contextPlugins?.includes(id)) context.threadId=null; if(plugin){context.hostApiVersion=snapshot.context.apiVersion;context.apiVersion=plugin.apiVersion;} return context; }
  function dispose(frame) {
    post(frame,'dispose',null);
    const info=frames.get(frame);if(info?.frameToken)ipcRenderer.invoke('forge:frame',{dispose:true,frameToken:info.frameToken}).catch(()=>{});
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
    const info={id,viewId,slotEntry,key,mount,ready:false,apiVersion:snapshot.plugins.find(p=>p.id===id).apiVersion,fingerprint:snapshot?.plugins.find(p=>p.id===id)?.fingerprint,frameToken:globalThis.crypto?.randomUUID?.()||'forge-frame-'+Date.now()+'-'+(++serial)}; frames.set(frame,info); mount.append(frame);
    try {
      if(info.apiVersion>=5)await ipcRenderer.invoke('forge:frame',{id,frameToken:info.frameToken,fingerprint:info.fingerprint});
      frame.addEventListener('load',()=>{info.ready=true;post(frame,'context.changed',contextFor(id));if(info.slotContext)post(frame,'slot.changed',info.slotContext);postFrameTheme(frame,info);},{once:true});
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
      if(button.parentElement!==target)target.append(button);
      const canvasEntry=document.getElementById('fast-canvas-entry'),compact=surface==='sidebar'&&canvasEntry?.querySelector('span')?.style.display==='none';
      if(surface==='sidebar'&&canvasEntry){
        if(button.className!==canvasEntry.className)button.className=canvasEntry.className;
        if(button.getAttribute('data-sidebar-cycle-item')!=='true')button.setAttribute('data-sidebar-cycle-item','true');
      }
      const icon=item.icon||(surface==='sidebar'?{viewBox:'0 0 24 24',paths:['M5 5h14v14H5z','M9 9h6v6H9z']}:null),contentKey=JSON.stringify([item.title,icon,compact,surface]);
      if(button.dataset.forgeContent!==contentKey){
        button.textContent='';
        if(icon){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [name,value]of Object.entries({viewBox:icon.viewBox,width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(name,value);svg.style.flexShrink='0';for(const d of icon.paths){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);svg.append(p);}button.append(svg);}
        const label=document.createElement('span');label.textContent=item.title;if(compact)label.style.display='none';button.append(label);
        button.style.cssText=surface==='sidebar'?'display:flex;align-items:center;gap:8px;color:inherit;background:transparent;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;-webkit-app-region:no-drag':'display:inline-flex;align-items:center;gap:6px;color:inherit;background:transparent;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;-webkit-app-region:no-drag';
        button.dataset.forgeContent=contentKey;
      }
      const title=snapshot.plugins.find(p=>p.id===pluginId)?.name;if(button.title!==title)button.title=title;
      if(button.getAttribute('aria-label')!==item.title)button.setAttribute('aria-label',item.title);
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
  // The host supplies the selectors and trusted item metadata, never message DOM.
  let slotSerial = 0;
  function visibleSlot(anchor){const box=anchor.getBoundingClientRect(),fallback=anchor.parentElement?.getBoundingClientRect();return anchor.isConnected&&!anchor.closest('[inert],[aria-hidden="true"],.invisible')&&(box.width>0&&box.height>0||box.height>0&&fallback?.width>0)&&getComputedStyle(anchor).visibility!=='hidden'&&getComputedStyle(anchor).display!=='none';}
  function slotViews() {
    if(!snapshot) return;
    for(const[frame]of frames)if(!frame.isConnected)dispose(frame);
    const wanted=new Map();
    for(const item of snapshot.slots?.entries||[]) if(item.anchor){
      if(item.slot.startsWith('conversation.')&&!snapshot.context.threadId)continue;
      let anchors=[...document.querySelectorAll(item.anchor)].filter(visibleSlot);
      if(item.slot==='conversation.header.action')anchors=anchors.slice(-1);
      for(const anchor of anchors){
        const matched=item.slot==='tool.card.view'?(snapshot.api5?.toolViews||[]).filter(tool=>[tool.id,tool.type,tool.toolName].includes(item.key)&&(anchor.getAttribute('data-local-conversation-item-target-ids')||'').split(/\s+/).includes(encodeURIComponent(tool.id))):[null];
        if(!anchor.dataset.forgeSlotOwner)anchor.dataset.forgeSlotOwner='slot-'+(++slotSerial);
        for(const tool of matched){const key=[item.pluginId,item.slot,item.id,anchor.dataset.forgeSlotOwner,tool?.id||''].join('|');wanted.set(key,{item,anchor,tool});}
      }
    }
    for(const host of [...document.querySelectorAll('[data-forge-slot-view]')]) {
      if(wanted.has(host.dataset.forgeSlotView)) continue;
      for(const child of [...host.children]) if(frames.has(child)) dispose(child);
      host.remove();
    }
    for(const [key,{item,anchor,tool}] of wanted) {
      const slotContext={slot:item.slot,id:item.id,key:item.key,...(contextFor(item.pluginId).threadId?{threadId:snapshot.context.threadId}:{}),...(tool?{item:{id:tool.id,type:tool.type,toolName:tool.toolName}}:{})};
      let host=[...document.querySelectorAll('[data-forge-slot-view]')].find(e=>e.dataset.forgeSlotView===key);if(host){const pair=[...frames].find(([,info])=>info.mount===host);if(pair){const[frame,info]=pair;if(JSON.stringify(info.slotContext)!==JSON.stringify(slotContext)){info.slotContext=slotContext;if(info.ready)post(frame,'slot.changed',slotContext);}}continue;}
      host=document.createElement('div');host.dataset.forgeSlotView=key;host.dataset.forgeSlotOwner=anchor.dataset.forgeSlotOwner;host.dataset.forgeSlot=item.slot;
      const compact=item.slot==='conversation.header.action'||item.slot.startsWith('composer.')||item.slot==='conversation.message.action';
      host.style.cssText=compact?'display:inline-flex;width:128px;height:32px;min-width:0;flex:0 0 auto;pointer-events:auto;-webkit-app-region:no-drag':'display:flex;width:100%;height:180px;min-width:0;min-height:96px;flex:0 0 auto;pointer-events:auto;-webkit-app-region:no-drag';
      if(item.slot==='settings.section')anchor.style.flexDirection='column';
      anchor.append(host);
      mount(host,item.pluginId,null,item.id).catch(error=>console.error('[Forge]',error));
      const frame=[...frames].find(([,info])=>info.mount===host)?.[0],info=frames.get(frame);if(info)info.slotContext=slotContext;
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
        if(previous?.context.threadId!==snapshot.context.threadId||previous?.context.generation!==snapshot.context.generation) post(frame,'context.changed',contextFor(info.id));
        post(frame,'settings.changed',null);
      }
      for(const p of snapshot.plugins.filter(p=>p.enabled&&!p.builtin&&p.entry)) await mount(document.body,p.id);
      contributions();outputView();slotViews();applyExtensionTheme();for(const [frame,info]of frames)if(info.ready)postFrameTheme(frame,info);
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
      const response=await ipcRenderer.invoke('forge:api',{...request,id:info.id,frameToken:info.frameToken});
      if (!response?.ok) throw Object.assign(Error(response?.error?.message || 'Forge 响应无效'), { code: response?.error?.code || 'INTERNAL_ERROR' });
      let result=response.result;
      if(result?.nativeAction==='close') result=await nativeRequest('close',{page:result.page});
      else if(result?.nativeAction?.startsWith('composer.')) result=composer(result.nativeAction,result.args);
      frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,result}},'*');
    }catch(error){frame.contentWindow?.postMessage({forgePluginReply:{id:request.id,error:info.apiVersion===1?error.message:{message:error.message,code:error.code||'INTERNAL_ERROR'}}},'*');}
  });
  globalThis.__forgeBridge={editComposer:composer,configure:fn=>{nativeRequest=fn;},mount:(node,page)=>{const [,id,viewId]=page.split(':');return mount(node,id,viewId);},refresh,layout:()=>{contributions();outputView();slotViews();applyExtensionTheme();for(const[frame,info]of frames)if(info.ready)postFrameTheme(frame,info);},snapshot:()=>snapshot};
  const nativeTheme={'--forge-background':'--color-token-bg-primary','--forge-foreground':'--color-token-text-primary','--forge-surface':'--color-token-bg-secondary','--forge-border':'--color-token-border-default','--forge-muted':'--color-token-text-secondary','--forge-accent':'--color-token-interactive-border-focus'};
  const themeSaved=new Map();let appliedTheme='';
  function applyExtensionTheme(){
    if(!document.documentElement)return;
    const tokens=snapshot?.api5?.theme?.tokens||{},next=JSON.stringify(tokens);if(next===appliedTheme)return;appliedTheme=next;
    const style=document.documentElement.style;for(const[key,{value,priority}]of themeSaved){if(value)style.setProperty(key,value,priority);else style.removeProperty(key);}themeSaved.clear();
    for(const[key,value]of Object.entries(tokens))for(const target of [key,...(nativeTheme[key]?[nativeTheme[key]]:[])]){themeSaved.set(target,{value:style.getPropertyValue(target),priority:style.getPropertyPriority(target)});style.setProperty(target,value);}
  }
  function postFrameTheme(frame,info){if(!document.documentElement||!info.mount?.isConnected)return;const style=getComputedStyle(info.mount),tokens={};for(const[key,native]of Object.entries(nativeTheme)){const value=style.getPropertyValue(key).trim()||style.getPropertyValue(native).trim();if(value)tokens[key]=value;}const value={id:snapshot?.api5?.theme?.id||null,tokens:{...tokens,...snapshot?.api5?.theme?.tokens}},key=JSON.stringify(value);if(info.themeKey!==key){info.themeKey=key;post(frame,'theme.changed',value);}}
  window.addEventListener('keydown',event=>{
    if(event.isComposing||event.repeat||event.defaultPrevented)return;
    const key=[event.ctrlKey?'Ctrl':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,event.metaKey?'Meta':null,String(event.key).length===1?String(event.key).toUpperCase():event.key].filter(Boolean).join('+');
    const shortcut=snapshot?.api5?.shortcuts?.find(item=>item.key.toUpperCase()===key.toUpperCase());if(!shortcut||!active(shortcut.pluginId))return;event.preventDefault();run(shortcut.pluginId,{command:shortcut.command}).catch(error=>console.error('[Forge shortcut]',error.message));
  });
  ipcRenderer.on('fast-ext:changed',(_event,payload)=>{
    if(payload?.type==='forge-prediction') return;
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
