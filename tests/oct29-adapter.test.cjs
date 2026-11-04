'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const fixture=require('./fixtures/native-rspack-oct29.json');
const adapter=require('../adapters/26.1029.7803.0.json');
const config=require('../forge.config.json');
const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');
const normalize=value=>JSON.parse(JSON.stringify(value));
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const patch=()=>import('../scripts/native-rspack-patch.mjs');
function requireModules(modules){
  const require=id=>{assert(Object.hasOwn(modules,id),'Unexpected native dependency: '+id);return modules[id];};
  require.d=(target,getters,values={})=>{for(const [key,get] of Object.entries(getters))Object.defineProperty(target,key,{get});Object.assign(target,values);};
  return require;
}

test('oct29 adapter pins official identity and every Rspack Fast copy',()=>{
  assert.equal(config.codexVersion,adapter.codexVersion);assert.equal(config.codexBuildVersion,adapter.codexBuildVersion);
  assert.equal(adapter.codexVersion,'26.1029.7803.0');assert.equal(adapter.patchSet,'oct29');
  assert.equal(adapter.packageIdentity,'OpenAI.Codex');assert.equal(adapter.packageBytes,1052222680);
  assert.equal(adapter.packageSHA256,'19487892b7e27c74e75c6422088e91b35b4291ed485045f82a1984a13b22d128');
  assert.equal(adapter.rspackModules.length,14);
  assert.equal(new Set(adapter.rspackModules.map(m=>m.member)).size,14);
  assert.deepEqual(adapter.rspackModules.filter(m=>m.id==='ipV4').map(m=>m.sha256).sort(),fixture.fast.map(digest).sort());
});

test('oct29 HTML permits only the Forge frame scheme and preserves every other CSP directive',async()=>{
  const {patchRspackIndex}=await patch();
  const original=fixture.csp,patched=patchRspackIndex(original);
  assert.equal(patched.replace(' codex-forge:',''),original);
  assert.match(patched,/frame-src 'self' codex-forge: blob:/);
  assert.throws(()=>patchRspackIndex(patched),/anchor changed/);
  assert.throws(()=>patchRspackIndex(original+original),/anchor changed/);
});

test('all oct29 Fast factories preserve native auth/loading and managed policy while extending API-key Fast',async()=>{
  const {patchRspackFactory}=await patch();
  const access=data=>({fast:data.requirements?.featureRequirements?.fast_mode!==false,ultrafast:true});
  function run(source,enabled,account,data,pending,hostId){
    let queryArgs;const modules={QosV:{c:()=>[]},y5DF:{Ul:()=> 'local',_U:(query,args)=>(queryArgs=args,{data,isPending:pending})},eWgO:{W6:access},tl5a:{Dc:{}},EOo5:{tn:id=>(assert.equal(id,hostId||'local'),account)},B81s:{b9:{}}};
    const exports={},require=requireModules(modules),factory=vm.runInNewContext('({'+source+'}).ipV4',{__codexForgeStartup:{fastEnabled:enabled}});
    factory({},exports,require);return {result:normalize(exports.U(hostId?{hostId}:undefined)),queryArgs:normalize(queryArgs)};
  }
  for(const source of fixture.fast){
    const patched=patchRspackFactory(source,'ipV4');
    for(const enabled of [true,false])for(const account of [null,{authMethod:'apikey'},{authMethod:'apikey',isLoading:true},{authMethod:'chatgpt'},{authMethod:'personalAccessToken'},{authMethod:'amazonBedrock',isLoading:true},{requiresAuth:false},{requiresAuth:false,isLoading:true}])for(const data of [null,{}, {requirements:{featureRequirements:{fast_mode:false}}}])for(const pending of [true,false]){
      const actual=run(patched,enabled,account,data,pending,'remote');
      if(enabled&&(account?.authMethod==='apikey'||account?.requiresAuth===false)){
        assert.deepEqual(actual.result,{serviceTierAccess:account?.isLoading?null:{...access(data??{}),ultrafast:false},isLoading:!!account?.isLoading});
        assert.deepEqual(actual.queryArgs,{authMethod:'apikey',hostId:'remote'});
      }else assert.deepEqual(actual,run(source,enabled,account,data,pending,'remote'));
    }
  }
});

test('oct29 native factory registration stays lazy and cold chat captures scope before settings',async()=>{
  const {patchRspackFactory}=await patch();
  const unavailable=Symbol(),full=Symbol(),tabById=Symbol(),exports={},listeners=[],replies=[],opened=[];
  let active;
  const window={addEventListener:(type,fn)=>listeners.push(fn),postMessage:value=>replies.push(value)};
  // Loading the registry must not require the cyclic tab/layout controllers.
  const modules={y5DF:{A4:()=>({}),gh:()=>active,Ul:()=>active.full},OWtl:{u:{}},nnol:{},Oj9r:{Rj:unavailable,GD:{}}};
  const require=requireModules(modules);
  vm.runInNewContext('({'+patchRspackFactory(fixture.registry,'EpL9',extension)+'}).EpL9',{window})({},exports,require);
  assert.equal(listeners.length,1);assert.equal(typeof exports.__forgeRememberScope,'function');
  modules.EpL9=exports;
  modules.QcW8={kF:full};modules.zd8w={createElement:(type,props)=>({type,props})};
  modules.ZU27={It:{tabById$:tabById,openTab:(scope,tabType,options)=>scope.tabs.set(options.id,{tabId:options.id,tabType,props:options.props}),closeTab:(scope,id)=>scope.tabs.delete(id)}};
  modules.XXJV={yI:(scope,side)=>opened.push([scope.value.conversationId,side])};
  modules.WwnD={xO:(scope,content,layout)=>(scope.full=layout.mode==='full',true)};
  const workspaceExports={};
  vm.runInNewContext('({'+patchRspackFactory(fixture.workspace,'yXyz')+'}).yXyz',{o:modules.y5DF,c:modules.Oj9r,f:{A:()=> 'hook-value'},i:{c:()=>[]}})({},workspaceExports,require);
  const workspace=workspaceExports.workspace;
  const request=data=>{listeners[0]({source:window,data:{fastWorkspaceNativeRequest:{id:'test',...data}}});return replies.at(-1).fastWorkspaceNativeReply;};
  assert.match(request({action:'open',page:'canvas'}).error,/尚未就绪/);
  for(const id of ['cold-thread','next-thread']){
    active={node:{},value:{conversationId:id},tabs:new Map(),full:false,get(signal,key){return signal===full?this.full:signal===unavailable?false:signal===tabById?this.tabs.get(key):undefined;}};
    assert.equal(workspace({workspaceWidth:1200}).value,'hook-value');
    for(const page of ['canvas','todos','collaboration','skills','information-stats','codex-memory','forge-plugins','forge-updates','forge-plugin:homeftw.nexus:main']){
      assert.equal(request({action:'open',page,threadId:id}).error,undefined);
      assert.equal(request({action:'mode',page,threadId:id,mode:'expanded'}).result.mode,'expanded');
      const node=exports.Br('fast-workspace').Component({page});
      assert.equal(node.props['data-fast-native-mode'],'expanded');
      assert.equal(request({action:'mode',page,threadId:id,mode:'right'}).result.mode,'right');
      assert.equal(request({action:'close',page,threadId:id}).error,undefined);
      assert.equal(active.tabs.size,0);
    }
  }
  assert.equal(opened.length,18);assert(opened.every(item=>item[1]==='right'));
  assert.match(request({action:'open',page:'canvas',threadId:'missing'}).error,/对应对话/);
  assert.match(request({action:'open',page:'invalid'}).error,/无效/);
});

test('oct29 settings navigation renders titles and icons in both widths and does not prefetch Forge',async()=>{
  const {patchRspackFactory}=await patch();
  for(const collapsed of [false,true]){
    const prefetched=[],selected=[];
    const jsx=(type,props)=>typeof type==='function'?type(props):{type,...props};
    const title=slug=>{assert.equal(slug,'plugins-settings');return {defaultMessage:'Plugins'};};
    const scope={a:{jsx},ey:{y:slug=>(title(slug),{component:{16:'icon'},navigation:'asset'})},ev:{G:title},tS:{formatMessage:m=>m.defaultMessage},eS:{gl:props=>title(props.slug).defaultMessage},eb:{OU:async slug=>prefetched.push(slug)},e9:assert.fail,e0:slug=>selected.push(slug),S:{m:'tooltip'},et:{jl:'button'},H:{b5:'icon'},Z:{A:'external'},e_:'codex-forge',tW:false,tT:false,tI:null,tN:collapsed,tJ:null,tz:null,tC:true,tx:true,tf:null};
    vm.runInNewContext(patchRspackFactory(fixture.navigation,'Nh8F')+'\nthis.render=renderNavigation;',scope);
    for(const slug of ['codex-forge','plugins-settings']){
      const node=scope.render({slug});const title=slug==='codex-forge'?'Codex Forge 插件设置':'Plugins';
      assert.equal(node.children.label,title);assert.equal(node.children['aria-label'],title);
      if(collapsed)assert.equal(node.content,title);
      node.children.onClick();node.children.onFocus();node.children.onPointerEnter();
    }
    await Promise.resolve();assert.deepEqual(selected,['codex-forge','plugins-settings']);assert.deepEqual(prefetched,['plugins-settings','plugins-settings']);
    assert(scope.groups()[0].slugs.includes('codex-forge'));
  }
});

test('oct29 visibility retains Forge and preserves native hidden, unknown and pending route behavior',async()=>{
  const {patchRspackFactory}=await patch();
  function run(source,slug){
    const scope={nt:[{section:{slug:'agent'},visible:true},{section:{slug:'hidden'},visible:false},{section:{slug:'pending'},visible:false,pending:true}],em:item=>item.visible?[item.section]:[],tB:false,ek:[],ey:undefined,eb:undefined,eL:undefined,e_:undefined,eZ:true,g:{yF:'agent'},eI:{},eS:false,tG:true,E:{U9:()=>false},tz:null,eX:null,eg:()=>false,ep:()=>false};
    vm.runInNewContext(source,scope);return normalize(scope.visibility(slug));
  }
  const patched=patchRspackFactory(fixture.visibility,'Noba');
  const forge=run(patched,'codex-forge');assert.equal(forge.activeSettingsSection,'codex-forge');assert.equal(forge.shouldRedirectToVisibleSettingsSection,false);assert.equal(forge.shouldRenderRouteContent,true);
  assert(forge.settingsNavigationSections.some(s=>s.slug==='codex-forge'));
  for(const slug of ['agent','hidden','unknown','pending']){
    const actual=run(patched,slug),original=run(fixture.visibility,slug);
    for(const key of ['activeSettingsSection','shouldRedirectToVisibleSettingsSection','cloudPreferencesAccessError','shouldRenderRouteContent'])assert.deepEqual(actual[key],original[key]);
  }
});

test('oct29 settings content mounts plugin deep links after hooks and leaves other outlets intact',async()=>{
  const {patchRspackFactory}=await patch();
  let section,visibility,hooks;
  const jsx=(type,props)=>({type,...props}),scope={URLSearchParams,c:{c:()=>{hooks.push('cache');return [];}},i:{jsx},A:{KC:()=>{hooks.push('context');return {outletContext:'native-context',selectedHostId:'local',visibility};},zy:()=>{hooks.push('location');return {search:'?plugin=example.hello%2Fsettings'};},RQ:()=>{hooks.push('route');return {params:{section}};},sv:'outlet',C5:'redirect'},nx:{Qm:slug=>'/settings/'+slug}};
  vm.runInNewContext(patchRspackFactory(fixture.content,'MeKU'),scope);
  for(section of ['codex-forge','agent','unknown']){
    hooks=[];visibility={activeSettingsSection:section,cloudPreferencesAccessError:null,shouldRedirectToVisibleSettingsSection:false,shouldRenderRouteContent:true};
    const node=scope.nC();assert.deepEqual(hooks,['cache','context','location','route']);
    if(section==='codex-forge'){assert.equal(node['data-forge-settings-mount'],'true');assert.equal(node['data-forge-settings-plugin'],'example.hello/settings');}
    else assert.equal(node.type,'outlet');
  }
});

test('oct29 patch guards reject corrupt, shifted, duplicate or unknown module ranges',async()=>{
  const {patchRspackMember,patchRspackFactory}=await patch();
  const source=fixture.fast[0],member='chunk.js',module={member,id:'ipV4',start:0,end:source.length,sha256:digest(source)};
  assert.match(patchRspackMember(source,member,[module]),/fastEnabled/);
  assert.throws(()=>patchRspackMember(source+' ',member,[{...module,end:source.length+1}]),/digest changed/);
  assert.throws(()=>patchRspackMember(source,member,[{...module,start:1}]),/digest changed/);
  assert.throws(()=>patchRspackMember(source,member,[module,module]),/range/);
  assert.throws(()=>patchRspackFactory('', 'unknown'),/Unsupported/);
  for(const [id,key] of [['yXyz','workspace'],['Nh8F','navigation'],['Noba','visibility'],['MeKU','content']]){
    const patched=patchRspackFactory(fixture[key],id);
    assert.throws(()=>patchRspackFactory(fixture[key]+fixture[key],id),/anchor changed/);
    assert.throws(()=>patchRspackFactory(patched,id),/anchor changed/);
  }
});

test('oct29 backend preserves native overrides and injects only configured per-model/Fast flags',async()=>{
  const {patchOct27Network}=await import('../scripts/native-fast-patch.mjs');
  const patched=patchOct27Network(fixture.network);
  const run=(source,env)=>normalize(vm.runInNewContext('('+source+')()',{process:{env,resourcesPath:'C:/fixture resources'},R:[{configKey:'native.value',envVar:'NATIVE_VALUE'}],A:['--native-arg']}));
  for(const env of [{},{NATIVE_VALUE:'native'}])assert.deepEqual(run(patched,env),run(fixture.network,env));
  const args=run(patched,{CODEX_FORGE_FAST:'1',CODEX_FORGE_SPEED:'fast',CODEX_FORGE_MODEL_CATALOG:'C:/catalog.json'});
  for(const expected of ['features.fast_mode=true','service_tier="fast"','model_catalog_json="C:/catalog.json"'])assert(args.includes(expected));
  assert(!args.some(arg=>arg.startsWith('model_context_window=')));
});
