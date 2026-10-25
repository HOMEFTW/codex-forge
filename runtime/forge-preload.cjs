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
  function contextFor(id) { const context={...snapshot.context}; if(!snapshot.plugins.find(p=>p.id===id)?.permissions.includes('conversation.read')) context.threadId=null; return context; }
  function dispose(frame) { post(frame,'dispose',null); frame.remove(); frames.delete(frame); }
  async function mount(mount, id, viewId) {
    const key=id+':'+(viewId||'runtime');
    if(!snapshot)return;
    if(!active(id)){if(viewId&&mount.dataset.forgeUnavailable!==id){mount.dataset.forgeUnavailable=id;mount.textContent='插件已停用或不兼容。';}return;}
    if(mount.dataset.forgeUnavailable){delete mount.dataset.forgeUnavailable;mount.textContent='';}
    if([...frames].some(([f,v])=>f.isConnected&&v.key===key&&v.mount===mount)) return;
    const frame=document.createElement('iframe'); frame.className='forge-plugin-frame'; frame.title=id; frame.setAttribute('sandbox','allow-scripts');
    frame.style.cssText=viewId?'border:0;width:100%;height:100%;min-height:0;flex:1':'display:none';
    const info={id,viewId,key,mount,ready:false,fingerprint:snapshot?.plugins.find(p=>p.id===id)?.fingerprint}; frames.set(frame,info); mount.append(frame);
    try {
      frame.src='codex-forge://plugin/'+encodeURIComponent(id)+'/'+encodeURIComponent(viewId||'runtime');
      frame.addEventListener('load',()=>{info.ready=true;post(frame,'context.changed',contextFor(id));},{once:true});
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
      contributions();outputView();
    } catch(error){console.error('[Forge]',error.message);}finally{refreshing=false;if(rerun){rerun=false;setTimeout(refresh,100);}}
  }
  window.addEventListener('message',async event=>{
    const frame=[...frames.keys()].find(f=>f.isConnected&&f.contentWindow===event.source);if(!frame||event.origin!=='null') return;
    const info=frames.get(frame), reply=event.data?.forgePluginCommandReply;
    if(reply) {const p=pending.get(reply.id);if(p?.frame===frame){pending.delete(reply.id);clearTimeout(p.timer);reply.error?p.reject(Error(reply.error)):p.resolve(reply.result);}return;}
    const request=event.data?.forgePluginRequest;if(!request||!Number.isSafeInteger(request.id)||typeof request.method!=='string') return;
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
