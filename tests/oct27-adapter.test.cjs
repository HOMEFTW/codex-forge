'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8');
const adapter=JSON.parse(fs.readFileSync(path.join(__dirname,'../adapters/26.1027.3384.0.json'),'utf8'));
const normalize=value=>JSON.parse(JSON.stringify(value));

test('oct27 adapter pins the official MSIX identity, build, digest and private symbol profile',async()=>{
  const {oct27NativeSymbols}=await import('../scripts/native-tabs-patch.mjs');
  assert.equal(adapter.codexVersion,'26.1027.3384.0');
  assert.equal(adapter.codexBuildVersion,'26.1027.6604.0');
  assert.equal(adapter.patchSet,'oct27');
  assert.equal(adapter.packageBytes,1004631986);
  assert.equal(adapter.packageSHA256,'d442a3d7d5c229f45e5e11995711ac2619c8dbc89e3fa2bc185287dc8db8e76e');
  assert.equal(adapter.downloadUrl,'https://persistent.oaistatic.com/codex-app-prod/releases/26.1027.3384.0/ChatGPT-x64.msix');
  assert.deepEqual(adapter.nativeSymbols,oct27NativeSymbols);
});

test('oct27 Fast patch preserves auth, managed limits, loading and disablement behavior',async()=>{
  const {patchFastAccess}=await import('../scripts/native-fast-patch.mjs');
  const original=read('native-fast-oct27.js').trim(),patched=patchFastAccess(original,{version:'oct27'});
  const access=data=>({fast:data.requirements?.featureRequirements?.fast_mode!==false,ultrafast:true});
  function run(source,enabled,auth,data){
    const globals={__codexForgeStartup:{fastEnabled:enabled},HAo:{c:()=>[]},uo:()=> 'local',bD:{},Ik:()=>auth,_s:()=>({data,isPending:false}),TO:{},Wt:access};
    return normalize(vm.runInNewContext('('+source+')',globals)());
  }
  for(const enabled of [true,false])for(const auth of [null,{authMethod:'apikey'},{authMethod:'chatgpt'},{authMethod:'chatgpt',isLoading:true},{requiresAuth:false}])for(const data of [null,{}, {requirements:{featureRequirements:{fast_mode:false}}}]){
    const actual=run(patched,enabled,auth,data);
    if(enabled&&(auth?.authMethod==='apikey'||auth?.requiresAuth===false))assert.deepEqual(actual,{serviceTierAccess:{...access(data??{}),ultrafast:false},isLoading:false});
    else assert.deepEqual(actual,run(original,enabled,auth,data));
  }
  assert.throws(()=>patchFastAccess(original,{version:'current'}),/does not match/);
});

test('oct27 webpack backend preserves native overrides and injects Forge Fast, browser, MCP and per-model catalog flags',async()=>{
  const {patchOct27Network}=await import('../scripts/native-fast-patch.mjs');
  const original=read('native-network-oct27.js').trim(),patched=patchOct27Network(original);
  const run=(source,env)=>normalize(vm.runInNewContext('('+source+')()',{
    process:{env,resourcesPath:'C:/fixture resources'},R:[{configKey:'native.value',envVar:'NATIVE_VALUE'}],A:['--native-arg'],
  }));
  for(const env of [{},{NATIVE_VALUE:'custom value'},{CODEX_FORGE_FAST:'0',CODEX_FAST_CANVAS:'0'}])assert.deepEqual(run(patched,env),run(original,env));
  const env={NATIVE_VALUE:'custom value',CODEX_FORGE_FAST:'1',CODEX_FORGE_SPEED:'fast',CODEX_FAST_IAB:'1',CODEX_FAST_CANVAS:'1',CODEX_FORGE_HOME:'C:/fixture/forge',CODEX_FAST_CANVAS_DIR:'C:/fixture/canvas',CODEX_FORGE_MODEL_CATALOG:'C:/fixture/catalog.json'};
  const args=run(patched,env);
  for(const expected of ['native.value="custom value"','features.fast_mode=true','service_tier="fast"','desktop.conversationDetailMode="STEPS_COMMANDS"','mcp_servers.fast_canvas.command="C:/fixture resources/cua_node/bin/node.exe"','mcp_servers.fast_canvas.env.CODEX_FORGE_HOME="C:/fixture/forge"','model_catalog_json="C:/fixture/catalog.json"'])assert(args.includes(expected),expected);
  assert(!args.some(value=>value.startsWith('model_context_window=')));
  assert.throws(()=>patchOct27Network(patched),/arguments changed/);
  assert.throws(()=>patchOct27Network(original+original),/arguments changed/);
});

async function settingsHarness(){
  const {patchSettingsPage}=await import('../scripts/native-settings-patch.mjs');
  const prefetched=[],selected=[],errors=[],messages={'plugins-settings':{id:'plugins.title',defaultMessage:'Plugins'}};
  const jsx=(type,props)=>typeof type==='function'?type(props):{type,...props};
  const intl={formatMessage:message=>message.defaultMessage};
  const scope={intl,Q:{jsx},$:{jsx},URLSearchParams,vn:slug=>messages[slug],mn:props=>intl.formatMessage(messages[props.slug]),V:props=>intl.formatMessage(props),jn:()=>({component:{16:'plugin icon'},navigation:'plugin asset'}),select:slug=>selected.push(slug),Qt:async slug=>{prefetched.push(slug);if(!messages[slug])throw Error('Unknown native route');},ti:error=>errors.push(error),i:'tooltip',Nt:'button',pe:'icon',Le:'external'};
  vm.runInNewContext(patchSettingsPage(read('native-settings-oct27.js'),{version:'oct27'}),scope);
  return {scope,prefetched,selected,errors};
}

test('oct27 settings renders Forge titles in both navigation widths and mounts plugin deep links',async()=>{
  const {scope}=await settingsHarness();
  for(const collapsed of [true,false]){
    const [native,forge]=scope.renderNavigation([{slug:'plugins-settings'},{slug:'codex-forge'}],'codex-forge',collapsed);
    assert.equal(native.children.label,'Plugins');
    assert.equal(forge.children.label,'Codex Forge 插件设置');
    assert.equal(forge.children['aria-label'],'Codex Forge 插件设置');
    if(collapsed)assert.equal(forge.content,'Codex Forge 插件设置');
  }
  const mount=scope.renderContent('codex-forge',{search:'?plugin=example.hello%2Fsettings'});
  assert.equal(mount['data-forge-settings-mount'],'true');
  assert.equal(mount['data-forge-settings-plugin'],'example.hello/settings');
  assert.equal(scope.renderContent('plugins-settings',{search:''}),'native content');
});

test('oct27 Forge navigation avoids native lazy prefetch while native navigation still prefetches',async()=>{
  const {scope,prefetched,selected,errors}=await settingsHarness();
  const [forge,native]=scope.renderNavigation([{slug:'codex-forge'},{slug:'plugins-settings'}],'plugins-settings',false).map(item=>item.children);
  forge.onClick();forge.onFocus();forge.onPointerEnter();
  assert.deepEqual(selected,['codex-forge']);assert.deepEqual(prefetched,[]);
  native.onFocus();await Promise.resolve();
  assert.deepEqual(prefetched,['plugins-settings']);assert.deepEqual(errors,[]);
});

test('oct27 visibility retains Forge routes, reuses native icons and fails closed on anchor changes',async()=>{
  const {patchSettingsPage,patchSettingsVisibility}=await import('../scripts/native-settings-patch.mjs');
  const original=read('native-settings-visibility-oct27.js'),scope={};
  vm.runInNewContext(patchSettingsVisibility(original,{version:'oct27'}),scope);
  assert.equal(scope.visibility('codex-forge',false).visible,true);
  assert.equal(scope.visible('codex-forge').activeSettingsSection,'codex-forge');
  assert.equal(scope.visible('codex-forge').shouldRedirectToVisibleSettingsSection,false);
  assert.equal(scope.za('codex-forge'),scope.za('plugins-settings'));
  assert.equal(scope.visible('unknown').shouldRedirectToVisibleSettingsSection,true);
  for(const [patch,file,anchor] of [[patchSettingsPage,'native-settings-oct27.js','l=vn(e.slug,D,t),'],[patchSettingsVisibility,'native-settings-visibility-oct27.js','function za(e,t){return e===`cloud-environments`?']]){
    const source=read(file);
    assert.throws(()=>patch(source.replace(anchor,'changed'),{version:'oct27'}),/anchor changed/);
    assert.throws(()=>patch(source+anchor,{version:'oct27'}),/anchor changed/);
    assert.throws(()=>patch(patch(source,{version:'oct27'}),{version:'oct27'}),/anchor changed/);
  }
});

test('oct27 workspace registration, model-statistics tab and full-width mode use the new native symbols',async()=>{
  const {patchNativeTabs}=await import('../scripts/native-tabs-patch.mjs');
  const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');
  const source=adapter.nativeSymbols.registryAnchor+adapter.nativeSymbols.scopeAnchor;
  const patched=patchNativeTabs(source,extension,{version:'oct27'});
  assert(patched.includes('BB=new Map,fastWorkspaceRegisterTabs(),X6r='));
  assert(patched.includes('fastWorkspaceRememberScope(a)'));
  const full=Symbol('full'),unavailable=Symbol('unavailable'),tabById=Symbol('tabById');
  const route={value:{conversationId:'thread_1'},tabs:new Map(),full:false,get(signal,id){return signal===full?this.full:signal===unavailable?false:signal===tabById?this.tabs.get(id):undefined;}};
  const scope={BB:new Map(),Jx:unavailable,Qx:full,qx:{},Is:()=>route,Bs:()=>({createElement:(type,props)=>({type,props})}),YU:()=>true,c2:(r,content,mode)=>{r.full=mode.mode==='full';return true;}};
  scope.zB=(kind,Component,options)=>{const value={kind,Component,...options};scope.BB.set(kind,value);return value;};
  scope.YB={tabById$:tabById,openTab:(r,tabType,options)=>r.tabs.set(options.id,{tabId:options.id,tabType,props:options.props})};
  vm.runInNewContext(patched.split('/* FAST_NATIVE_WORKSPACE_TABS */')[1],scope);
  scope.fastWorkspaceRememberScope(route);
  const result=scope.fastWorkspaceNativeDispatch({action:'open',page:'information-stats',threadId:'thread_1',mode:'expanded'});
  assert.equal(result.mode,'expanded');assert.equal(route.tabs.size,1);
  const node=scope.BB.get('fast-workspace').Component({page:'information-stats'});
  assert.equal(node.props['data-fast-native-mode'],'expanded');
  assert.throws(()=>scope.fastWorkspaceNativeDispatch({action:'open',page:'canvas',threadId:'other'}),/对应对话/);
});

test('cold chat layout opens sidebar and toolbar pages before visiting settings and after changing threads',async()=>{
  const {patchNativeTabs,patchNativeWorkspace}=await import('../scripts/native-tabs-patch.mjs');
  const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');
  const patched=patchNativeTabs(adapter.nativeSymbols.registryAnchor+adapter.nativeSymbols.scopeAnchor,extension,{version:'oct27',exportScope:true});
  assert.match(patched,/export \{ fastWorkspaceRememberScope \}/);
  // Preserve the real app-primary hook prefix; the remaining JSX is irrelevant
  // to route capture. Deliberately never render Xzt or a Settings component.
  const chat='function RLt(e){let {workspaceWidth:d}=e,f=rf(fT),p=Zt(),m,h;return {scope:f,width:d,value:p}}';
  const workspace=patchNativeWorkspace(chat,{version:'oct27',renderer:adapter.members.renderer});
  assert.match(workspace,/import \{ fastWorkspaceRememberScope \} from "\.\/app-initial-4267e52fe5b0.js"/);
  const full=Symbol('full'),unavailable=Symbol('unavailable'),tabById=Symbol('tabById'),listeners=new Map(),replies=[];
  let active;
  const window={addEventListener:(name,fn)=>listeners.set(name,fn),postMessage:reply=>replies.push(reply)};
  const scope={window,BB:new Map(),Jx:unavailable,Qx:full,fT:{},rf:()=>active,Zt:()=> 'native hook value',YU:()=>true,c2:(r,content,mode)=>{r.full=mode.mode==='full';return true;}};
  scope.zB=(kind,Component,options)=>{const value={kind,Component,...options};scope.BB.set(kind,value);return value;};
  scope.YB={tabById$:tabById,openTab:(r,tabType,options)=>r.tabs.set(options.id,{tabId:options.id,tabType,props:options.props})};
  vm.runInNewContext(patched.split('/* FAST_NATIVE_WORKSPACE_TABS */')[1].replace('export { fastWorkspaceRememberScope };','')+'\n'+chat,scope);
  scope.fastWorkspaceRegisterTabs();
  active={value:{conversationId:'cold-thread'},get:()=>false};
  scope.RLt({workspaceWidth:1200});
  assert.throws(()=>scope.fastWorkspaceNativeDispatch({action:'open',page:'canvas',threadId:'cold-thread'}),/对应对话/,'old hook does not capture the cold chat route');
  vm.runInNewContext(workspace.replace(/^import[^\n]+\n/,''),scope);
  for(const id of ['thread_1','thread_2']){
    active={value:{conversationId:id},tabs:new Map(),full:false,get(signal,key){return signal===full?this.full:signal===unavailable?false:signal===tabById?this.tabs.get(key):undefined;}};
    assert.equal(scope.RLt({workspaceWidth:1200}).value,'native hook value');
    for(const page of ['canvas','todos','collaboration','skills','information-stats','codex-memory','forge-plugins','forge-updates']){
      listeners.get('message')({source:window,data:{fastWorkspaceNativeRequest:{id:id+page,action:'open',page,threadId:id}}});
      assert.equal(replies.at(-1).fastWorkspaceNativeReply.error,undefined);
      assert(active.tabs.has('fast-workspace:'+page));
    }
  }
  assert.throws(()=>patchNativeWorkspace(chat+chat,{version:'oct27',renderer:adapter.members.renderer}),/anchor changed/);
  assert.throws(()=>patchNativeWorkspace(workspace,{version:'oct27',renderer:adapter.members.renderer}),/anchor changed/);
});
