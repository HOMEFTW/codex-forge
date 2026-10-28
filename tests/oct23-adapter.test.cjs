'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8');
const adapter=JSON.parse(fs.readFileSync(path.join(__dirname,'../adapters/26.1023.6123.0.json'),'utf8'));
const normalize=value=>JSON.parse(JSON.stringify(value));

test('oct23 adapter pins the official MSIX identity, build, digest and private symbol profile',async()=>{
  const {oct23NativeSymbols}=await import('../scripts/native-tabs-patch.mjs');
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../forge.config.json'),'utf8'));
  assert.equal(config.codexVersion,adapter.codexVersion);
  assert.equal(adapter.codexVersion,'26.1023.6123.0');
  assert.equal(adapter.codexBuildVersion,'26.1023.6621.0');
  assert.equal(adapter.patchSet,'oct23');
  assert.equal(adapter.packageBytes,979149564);
  assert.equal(adapter.packageSHA256,'9890e869a0d40fc00f396ce48ba05dc45ccb8bb36d151dcd1a2ff23d270f2e4d');
  assert.equal(adapter.downloadUrl,'https://persistent.oaistatic.com/codex-app-prod/releases/26.1023.6123.0/ChatGPT-x64.msix');
  assert.deepEqual(adapter.nativeSymbols,oct23NativeSymbols);
});

test('oct23 Fast patch preserves auth, managed limits, loading and disablement behavior',async()=>{
  const {patchFastAccess}=await import('../scripts/native-fast-patch.mjs');
  const original=read('native-fast-oct23.js').trim(),patched=patchFastAccess(original,{version:'oct23'});
  const access=data=>({fast:data.requirements?.featureRequirements?.fast_mode!==false,ultrafast:true});
  function run(source,enabled,auth,data){
    const globals={__codexForgeStartup:{fastEnabled:enabled},Noo:{c:()=>[]},xr:()=> 'local',Nj:{},zO:()=>auth,An:()=>({data,isPending:false}),lO:{},Pue:access};
    return normalize(vm.runInNewContext('('+source+')',globals)());
  }
  for(const enabled of [true,false])for(const auth of [null,{authMethod:'apikey'},{authMethod:'chatgpt'},{authMethod:'chatgpt',isLoading:true},{requiresAuth:false}])for(const data of [null,{}, {requirements:{featureRequirements:{fast_mode:false}}}]){
    const actual=run(patched,enabled,auth,data);
    if(enabled&&(auth?.authMethod==='apikey'||auth?.requiresAuth===false))assert.deepEqual(actual,{serviceTierAccess:{...access(data??{}),ultrafast:false},isLoading:false});
    else assert.deepEqual(actual,run(original,enabled,auth,data));
  }
  assert.throws(()=>patchFastAccess(original,{version:'current'}),/does not match/);
});

async function settingsHarness(){
  const {patchSettingsPage}=await import('../scripts/native-settings-patch.mjs');
  const prefetched=[],selected=[],errors=[],messages={'plugins-settings':{id:'plugins.title',defaultMessage:'Plugins'}};
  const jsx=(type,props)=>typeof type==='function'?type(props):{type,...props};
  const intl={formatMessage:message=>message.defaultMessage};
  const scope={intl,Q:{jsx},$:{jsx},URLSearchParams,hn:slug=>messages[slug],dn:props=>intl.formatMessage(messages[props.slug]),h:props=>intl.formatMessage(props),jn:()=>({component:{16:'plugin icon'},navigation:'plugin asset'}),select:slug=>selected.push(slug),Yt:async slug=>{prefetched.push(slug);if(!messages[slug])throw Error('Unknown native route');},$r:error=>errors.push(error),i:'tooltip',Nt:'button',pe:'icon',Le:'external'};
  vm.runInNewContext(patchSettingsPage(read('native-settings-oct23.js'),{version:'oct23'}),scope);
  return {scope,prefetched,selected,errors};
}

test('oct23 settings renders Forge titles in both navigation widths and mounts plugin deep links',async()=>{
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

test('oct23 Forge navigation avoids native lazy prefetch while native navigation still prefetches',async()=>{
  const {scope,prefetched,selected,errors}=await settingsHarness();
  const [forge,native]=scope.renderNavigation([{slug:'codex-forge'},{slug:'plugins-settings'}],'plugins-settings',false).map(item=>item.children);
  forge.onClick();forge.onFocus();forge.onPointerEnter();
  assert.deepEqual(selected,['codex-forge']);assert.deepEqual(prefetched,[]);
  native.onFocus();await Promise.resolve();
  assert.deepEqual(prefetched,['plugins-settings']);assert.deepEqual(errors,[]);
});

test('oct23 visibility retains Forge routes, reuses native icons and fails closed on anchor changes',async()=>{
  const {patchSettingsPage,patchSettingsVisibility}=await import('../scripts/native-settings-patch.mjs');
  const original=read('native-settings-visibility-oct23.js'),scope={};
  vm.runInNewContext(patchSettingsVisibility(original,{version:'oct23'}),scope);
  assert.equal(scope.visibility('codex-forge',false).visible,true);
  assert.equal(scope.visible('codex-forge').activeSettingsSection,'codex-forge');
  assert.equal(scope.visible('codex-forge').shouldRedirectToVisibleSettingsSection,false);
  assert.equal(scope.Ha('codex-forge'),scope.Ha('plugins-settings'));
  assert.equal(scope.visible('unknown').shouldRedirectToVisibleSettingsSection,true);
  for(const [patch,file,anchor] of [[patchSettingsPage,'native-settings-oct23.js','u=hn(e.slug,M,t),'],[patchSettingsVisibility,'native-settings-visibility-oct23.js','function Ha(e,t){return e===`cloud-environments`?']]){
    const source=read(file);
    assert.throws(()=>patch(source.replace(anchor,'changed'),{version:'oct23'}),/anchor changed/);
    assert.throws(()=>patch(source+anchor,{version:'oct23'}),/anchor changed/);
    assert.throws(()=>patch(patch(source,{version:'oct23'}),{version:'oct23'}),/anchor changed/);
  }
});

test('oct23 workspace registration, model-statistics tab and full-width mode use the new native symbols',async()=>{
  const {patchNativeTabs}=await import('../scripts/native-tabs-patch.mjs');
  const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');
  const source=adapter.nativeSymbols.registryAnchor+adapter.nativeSymbols.scopeAnchor;
  const patched=patchNativeTabs(source,extension,{version:'oct23'});
  assert(patched.includes('JH=new Map,fastWorkspaceRegisterTabs(),rri='));
  assert(patched.includes('fastWorkspaceRememberScope(a)'));
  const full=Symbol('full'),unavailable=Symbol('unavailable'),tabById=Symbol('tabById');
  const route={value:{conversationId:'thread_1'},tabs:new Map(),full:false,get(signal,id){return signal===full?this.full:signal===unavailable?false:signal===tabById?this.tabs.get(id):undefined;}};
  const scope={JH:new Map(),CS:unavailable,DS:full,SS:{},Or:()=>route,Yri:{createElement:(type,props)=>({type,props})},yK:()=>true,c2:(r,content,mode)=>{r.full=mode.mode==='full';return true;}};
  scope.KH=(kind,Component,options)=>{const value={kind,Component,...options};scope.JH.set(kind,value);return value;};
  scope.iU={tabById$:tabById,openTab:(r,tabType,options)=>r.tabs.set(options.id,{tabId:options.id,tabType,props:options.props})};
  vm.runInNewContext(patched.split('/* FAST_NATIVE_WORKSPACE_TABS */')[1],scope);
  scope.fastWorkspaceRememberScope(route);
  const result=scope.fastWorkspaceNativeDispatch({action:'open',page:'information-stats',threadId:'thread_1',mode:'expanded'});
  assert.equal(result.mode,'expanded');assert.equal(route.tabs.size,1);
  const node=scope.JH.get('fast-workspace').Component({page:'information-stats'});
  assert.equal(node.props['data-fast-native-mode'],'expanded');
  assert.throws(()=>scope.fastWorkspaceNativeDispatch({action:'open',page:'canvas',threadId:'other'}),/对应对话/);
});
