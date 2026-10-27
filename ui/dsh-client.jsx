import React,{useSyncExternalStore,useState} from 'react';
import * as JSX from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import {createRoot} from 'react-dom/client';
import * as primitives from './dsh-primitives.js';
import {createDshContext} from './dsh-context.js';
import './dsh-client.css';

const modules=new Map(),externals={'react':React,'react/jsx-runtime':JSX,'react-dom':ReactDOM,'@deepseek-ai/dsh-client-ui-primitives':primitives};
window.__ModuleLoader__={load({id,factory}){if(typeof id!=='string'||typeof factory!=='function'||modules.has(id))throw Error('DSH 客户端模块无效或重复');modules.set(id,factory);}};

function webStorage(initial={},save=()=>{}) {
  const data=new Map(Object.entries(initial));
  return {get length(){return data.size;},key:index=>[...data.keys()][index]??null,getItem:key=>data.get(String(key))??null,
    setItem(key,value){const previous=new Map(data);data.set(String(key),String(value));if(JSON.stringify(Object.fromEntries(data)).length>60000){data.clear();for(const item of previous)data.set(...item);throw Error('DSH 浏览器存储已满');}save(Object.fromEntries(data));},
    removeItem(key){data.delete(String(key));save(Object.fromEntries(data));},clear(){data.clear();save({});}};
}
function bridgeFetch(api){
  const original=window.fetch.bind(window);
  const bridged=async(input,options={})=>{
    const url=new URL(input?.url||String(input),location.href),marker='/dsh-market/',at=url.pathname.indexOf(marker);
    if(url.protocol!==location.protocol||url.host!==location.host||at<0)return original(input,options);
    const method=(options.method||input.method||'GET').toUpperCase();
    const raw=options.body??(typeof input==='object'&&method!=='GET'?await input.clone().text():null);
    const body=typeof raw==='string'&&raw?JSON.parse(raw):{};
    const result=await api.dsh.request(url.pathname.slice(at+marker.length)+url.search,{method,body});
    return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}});
  };
  window.fetch=bridged;return ()=>{if(window.fetch===bridged)window.fetch=original;};
}
class ClientBoundary extends React.Component {
  state={error:null};static getDerivedStateFromError(error){return {error};}
  render(){return this.state.error?<div role="alert" className="dsh-adapter-error">DSH 插件页面无法显示：{this.state.error.message}</div>:this.props.children;}
}
function SlotPanel({ctx}){
  const slots=useSyncExternalStore(ctx.slots.subscribe,ctx.slots.getSnapshot),[selected,setSelected]=useState(null);
  const pages=slots.filter(item=>['settings.section','main'].includes(item.meta.name)),active=pages.find(item=>(item.meta.id||item.meta.key)===selected)||pages[0];
  if(!active)throw Error('此 DSH 插件未注册 Forge 支持的 UI 页面。');
  const Component=active.component,props=typeof active.meta.inject==='function'?active.meta.inject():{};
  return <>{pages.length>1&&<nav className="dsh-adapter-tabs">{pages.map((item,index)=><button key={index} onClick={()=>setSelected(item.meta.id||item.meta.key)}>{typeof item.meta.label==='function'?item.meta.label():item.meta.label||item.meta.id||item.meta.key}</button>)}</nav>}<Component {...props}/></>;
}
function Overlay({ctx}){const slots=useSyncExternalStore(ctx.slots.subscribe,ctx.slots.getSnapshot);return slots.filter(item=>item.meta.name==='shell.overlay').map((item,index)=>React.createElement(item.component,{key:index}));}

export async function start(metadata){
  const mount=document.getElementById('forge-dsh-root'),api=window.CodexForge;let ctx,root,disposed=false,off=()=>{},restoreFetch=()=>{};
  const dispose=()=>{
    if(disposed)return;disposed=true;off();window.removeEventListener('pagehide',dispose);
    try{root?.unmount();}catch(error){console.error('[Forge DSH]',error);}finally{ctx?.dispose();restoreFetch();}
    document.documentElement.dataset.forgeDsh='disposed';
  };
  try {
    if(!api||!mount)throw Error('DSH UI 必须通过 Forge 插件面板打开。');
    off=api.events.on('dispose',dispose);window.addEventListener('pagehide',dispose,{once:true});
    let writes=Promise.resolve();
    const stored=await api.storage.get('dsh.browserStorage')||{};
    if(disposed)return;
    Object.defineProperty(window,'localStorage',{value:webStorage(stored,value=>{if(!disposed)writes=writes.then(()=>api.storage.set('dsh.browserStorage',value)).catch(error=>console.error('[Forge DSH storage]',error));}),configurable:true});
    Object.defineProperty(window,'sessionStorage',{value:webStorage(),configurable:true});
    restoreFetch=bridgeFetch(api);
    ctx=createDshContext({language:navigator.language?.startsWith('zh')?'zh':'en',navigate:name=>{void api.dsh.request('open-plugin',{method:'POST',body:{name}}).catch(console.error);}});
    let client;
    for(const factory of modules.values()){
      const value=factory(name=>{if(!Object.hasOwn(externals,name))throw Error('Forge 未提供 DSH 客户端模块：'+name);return externals[name];});
      if(typeof value?.apply==='function'){if(client)throw Error('DSH 包包含多个客户端插件；请拆分后导入。');client=value;}
    }
    if(!client)throw Error('未找到 DSH 客户端 apply() 入口。');
    const required=client.inject||[];
    if(!Array.isArray(required)||required.some(name=>!ctx.hasService(name)))throw Error('Forge 未提供所需 DSH 客户端服务：'+(Array.isArray(required)?required.filter(name=>!ctx.hasService(name)).join('、'):'非数组 inject 声明'));
    const stop=await client.apply(ctx);if(typeof stop==='function')ctx.effect(()=>stop);
    if(disposed){if(typeof stop==='function')stop();return;}
    const market=ctx.market;
    if(metadata.packageName==='dshmarket'&&typeof market?.render!=='function')throw Error('dsh-market 未完成 UI 服务注册，请查看插件日志。');
    market?.setSettingsVisible(false);
    root=createRoot(mount);
    root.render(<ClientBoundary>{market?.render?market.render():<SlotPanel ctx={ctx}/>}<Overlay ctx={ctx}/></ClientBoundary>);
    document.documentElement.dataset.forgeDsh='ready';
    window.dispatchEvent(new CustomEvent('forge-dsh-ready',{detail:{packageName:metadata.packageName}}));
  }catch(error){
    if(disposed)return;
    dispose();
    if(mount){mount.textContent='DSH 插件加载失败：'+error.message;mount.setAttribute('role','alert');}
    document.documentElement.dataset.forgeDsh='error';console.error('[Forge DSH]',error);
  }
}
window.ForgeDshClient=Object.freeze({start});
