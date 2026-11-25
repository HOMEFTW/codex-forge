const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript');
const fixture=require('./fixtures/native-rspack-nov25.json'),adapter=require('../adapters/26.1120.5083.0.json');
const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');

test('Nov25 settings outlet opens Forge after native hooks with deep-link parameters intact',async()=>{
  const {patchNov25Factory}=await import('../scripts/native-nov25-patch.mjs');
  const tree=ts.createSourceFile('outlet.js','({'+patchNov25Factory(fixture.yrkS,'yrkS')+'})',ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let outlet;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='nO')outlet=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);assert(outlet);
  const calls=[],visibility={activeSettingsSection:'codex-forge',shouldRenderRouteContent:true};
  const node=vm.runInNewContext('('+outlet+')()',{
    d:{c:()=>[]},j:{KC:()=>{calls.push('context');return{visibility};},zy:()=>{calls.push('location');return{search:'?plugin=forge.fast'};},RQ:()=>{calls.push('route');return{params:{section:'codex-forge'}};}},
    s:{jsx:(type,props)=>({type,props})},URLSearchParams,
  });
  assert.deepEqual(calls,['context','location','route']);assert.equal(node.props['data-forge-settings-mount'],'true');assert.equal(node.props['data-forge-settings-plugin'],'forge.fast');
});

test('Windows CUA injection follows the verified native instance identifier',async()=>{
  const {patchCuaGlobals}=await import('../scripts/native-windows-cua.mjs');
  for(const name of ['n','l']){
    const calls=[],cua={getState(){}};
    const source=`Object.assign(${name},{initialize:${name}.getState}),Reflect.set(globalThis,"cua",${name});`;
    const patched=patchCuaGlobals(source),scope={[name]:cua,installWindowsApps:value=>calls.push(value)};
    vm.runInNewContext(patched.replace(/^import[^;]+;/,''),scope);
    assert.equal(scope.cua,cua);assert.equal(cua.initialize,cua.getState);assert.deepEqual(calls,[cua]);
    assert.throws(()=>patchCuaGlobals(source+source),/globals changed/);assert.throws(()=>patchCuaGlobals(patched),/globals changed/);
  }
  assert.throws(()=>patchCuaGlobals('Object.assign(l,{initialize:n.getState}),Reflect.set(globalThis,"cua",l);'),/globals changed/);
});

test('Nov25 pinned UI factories reject changed bytes and produce valid JavaScript',async()=>{
  const {patchRspackMember}=await import('../scripts/native-rspack-patch.mjs');
  for(const id of ['DWOZ','HHvo','XADK','FRRX','yrkS','a4Ud','UTF2']){
    const source=fixture[id],sha=crypto.createHash('sha256').update(source).digest('hex');
    const spec=adapter.rspackModules.find(m=>m.id===id&&m.sha256===sha);assert(spec,id);
    const entries=[{...spec,start:2,end:source.length+2}],wrapped='({'+source+'})';
    const patched=patchRspackMember(wrapped,spec.member,entries,extension,'nov25');
    assert.deepEqual(ts.createSourceFile(id+'.js',patched,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS).parseDiagnostics,[],id);
    assert.throws(()=>patchRspackMember(wrapped.replace(id,'XXXX'),spec.member,entries,extension,'nov25'),/digest changed/);
  }
});

test('Nov25 settings navigation and search keep Forge slugs out of native-only registries',async()=>{
  const {patchNov25Factory}=await import('../scripts/native-nov25-patch.mjs');
  const tree=ts.createSourceFile('s.js','({'+patchNov25Factory(fixture.a4Ud,'a4Ud')+'})',ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),functions=[];
  function visit(n){if(ts.isFunctionDeclaration(n)&&n.name.text.startsWith('__forge'))functions.push(n.getText(tree));ts.forEachChild(n,visit);}visit(tree);
  const calls=[],marker={},pending=Promise.resolve(),native=kind=>(slug,...args)=>{assert.notEqual(slug,'codex-forge');calls.push({kind,slug,args});return kind==='preload'?pending:marker;};
  const h=vm.runInNewContext(functions.join('\n')+';({title:__forgeSettingsTitle,icon:__forgeSettingsIcon,preload:__forgePreloadSettings,search:__forgeNativeSearchSections})',{eI:{G:native('title')},ej:{y:native('icon')},eM:{OU:native('preload')}});
  assert.equal(h.title('codex-forge').defaultMessage,'Codex Forge 插件设置');assert.equal(h.icon('codex-forge',true),marker);await h.preload('codex-forge');
  assert.deepEqual(calls.splice(0),[{kind:'icon',slug:'plugins-settings',args:[true]}]);
  for(const slug of ['general-settings','plugins-settings']){assert.equal(h.title(slug,false,true),marker);assert.equal(h.icon(slug,false),marker);assert.equal(h.preload(slug),pending);}
  assert.equal(calls.length,6);
  const slugs=Object.freeze(['general-settings','codex-forge','billing']);
  assert.deepEqual(Array.from(h.search(slugs,null)),['general-settings','billing']);
  assert.deepEqual(Array.from(h.search(slugs,'https://fixture.invalid')),['general-settings']);
  assert(slugs.includes('codex-forge'),'Forge remains available for section-title search');
});

test('Nov25 both backend launch paths retain native arguments and add the same Forge configuration',async()=>{
  const {patchNov25Network}=await import('../scripts/native-nov25-main.mjs'),sources=require('./fixtures/native-network-nov25.json');
  for(const [role,source]of Object.entries(sources))for(const enabled of [false,true]){
    const env=enabled?{NATIVE_TEST:'keep',CODEX_FORGE_FAST:'1',CODEX_FORGE_SPEED:'ultrafast',CODEX_FAST_CANVAS:'1',CODEX_FORGE_HOME:'D:/test/forge',CODEX_FORGE_MODEL_CATALOG:'D:/test/catalog.json',CODEX_FAST_IAB:'1',CODEX_FORGE_NATIVE_PLUGINS:'1',CODEX_FORGE_COMPUTER_USE:'1'}:{NATIVE_TEST:'keep'};
    const scope={process:{env,resourcesPath:'D:/test/resources'},j:[{configKey:'native.option',envVar:'NATIVE_TEST'}],B:[{configKey:'native.option',envVar:'NATIVE_TEST'}],D:['-c','native_default=true'],U:['-c','native_default=true']};
    const run=s=>Array.from(vm.runInNewContext('('+s+')()',scope));
    const original=run(source),actual=run(patchNov25Network(source,role==='networkHost'));
    if(!enabled)assert.deepEqual(actual,original);else{
      for(const arg of original)assert(actual.includes(arg),arg);
      for(const arg of ['features.fast_mode=true','service_tier="ultrafast"','features.plugins=true','features.computer_use=true','mcp_servers.fast_canvas.enabled=true','model_catalog_json="D:/test/catalog.json"'])assert(actual.includes(arg),role+': '+arg);
    }
    assert.throws(()=>patchNov25Network(source+' '+source,role==='networkHost'),/arguments changed/);
  }
});
