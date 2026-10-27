// A deliberately small client context. It never creates a Node/Cordis runtime.
export function createDshContext({language='zh',navigate=()=>{},onError=console.error}={}) {
  const disposers=new Set(),listeners=new Map(),dictionaries=new Map(),pending=new Set(),services=new Map();
  const slots=new Map(),slotListeners=new Set();let entries=[],disposed=false;
  const localeSnapshot=Object.freeze({active:language});
  const supportedSlots=new Set(['settings.section','main','shell.overlay']);
  function report(error){try{onError(error);}catch{}}
  function own(value){
    if(typeof value!=='function')return value;
    let active=true;const stop=()=>{if(!active)return;active=false;disposers.delete(stop);try{value();}catch(error){report(error);}};
    if(disposed)stop();else disposers.add(stop);return stop;
  }
  function effect(callback){if(disposed)return;const result=callback();return result?.then?result.then(own,report):own(result);}
  function on(name,callback){const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);return own(()=>set.delete(callback));}
  function emit(name,value){for(const callback of listeners.get(name)||[]){try{callback(value);}catch(error){report(error);}}}
  function refreshSlots(){entries=[...slots.values()];for(const callback of slotListeners){try{callback();}catch(error){report(error);}}}
  function inject(names,callback){
    if(!Array.isArray(names)||!names.every(name=>typeof name==='string'))throw Error('DSH inject 仅支持服务名称数组');
    const job={names,callback,started:false};pending.add(job);flush();
    return own(()=>pending.delete(job));
  }
  function flush(){for(const job of pending)if(!job.started&&job.names.every(name=>services.has(name))){job.started=true;effect(()=>job.callback(ctx));}}
  function provide(name,value){if(disposed)throw Error('DSH 插件已停止');if(services.has(name))throw Error('DSH 服务已存在：'+name);services.set(name,value);ctx[name]=value;flush();return own(()=>{services.delete(name);delete ctx[name];});}
  const ctx={
    effect,on,inject,provide,
    locale:{
      register(namespace,dicts){dictionaries.set(namespace,dicts);return own(()=>dictionaries.delete(namespace));},
      bind(namespace){return (key,params={})=>{const dict=dictionaries.get(namespace),locale=language.startsWith('zh')?'zh':'en';const value=dict?.[locale]?.[key]??dict?.en?.[key]??key;return String(value).replace(/\{(\w+)\}/g,(whole,name)=>Object.hasOwn(params,name)?String(params[name]):whole);};},
      subscribe(callback){return on('locale/change',callback);},getSnapshot:()=>localeSnapshot,
    },
    theme:{getTheme:()=>null,setTheme(){throw Error('Forge 尚不支持 DSH 服务端主题；请使用客户端外观设置。');}},
    slots:{
      inject(name,callback){if(supportedSlots.has(name))return effect(callback);return ()=>{};},
      register(meta,component){
        if(!supportedSlots.has(meta?.name))throw Error('Forge 未提供 DSH UI slot：'+meta?.name);
        if(typeof component!=='function')throw Error('DSH slot 需要 React 组件');
        const key=Symbol(meta.name);slots.set(key,{meta,component});refreshSlots();
        return own(()=>{slots.delete(key);refreshSlots();});
      },
      subscribe(callback){slotListeners.add(callback);return ()=>slotListeners.delete(callback);},getSnapshot:()=>entries,
    },
    pluginNavigation:{openBundle:navigate},
    dispose(){if(disposed)return;disposed=true;emit('dispose');for(const stop of [...disposers].reverse())stop();disposers.clear();pending.clear();listeners.clear();slots.clear();refreshSlots();slotListeners.clear();},
    get disposed(){return disposed;},
    hasService:name=>services.has(name),
  };
  for(const name of ['locale','theme','slots','pluginNavigation'])services.set(name,ctx[name]);
  return ctx;
}
