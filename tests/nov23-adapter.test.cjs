const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),ts=require('typescript');
const fixture=require('./fixtures/native-rspack-nov23.json'),adapter=require('../adapters/26.1117.4957.0.json');
const extension=fs.readFileSync(path.join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');

test('Nov23 pinned UI factories reject changed bytes and produce valid JavaScript',async()=>{
  const {patchRspackMember}=await import('../scripts/native-rspack-patch.mjs');
  for(const id of ['jNL7','HHvo','XADK','FRRX','mjpt','a4Ud','UTF2']){
    const source=fixture[id],sha=crypto.createHash('sha256').update(source).digest('hex');
    const spec=adapter.rspackModules.find(m=>m.id===id&&m.sha256===sha);assert(spec,id);
    const entries=[{...spec,start:2,end:source.length+2}],wrapped='({'+source+'})';
    const patched=patchRspackMember(wrapped,spec.member,entries,extension,'nov23');
    assert.deepEqual(ts.createSourceFile(id+'.js',patched,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS).parseDiagnostics,[],id);
    assert.throws(()=>patchRspackMember(wrapped.replace(id,'XXXX'),spec.member,entries,extension,'nov23'),/digest changed/);
  }
});

test('Nov23 settings navigation and search keep Forge slugs out of native-only registries',async()=>{
  const {patchNov23Factory}=await import('../scripts/native-nov23-patch.mjs');
  const tree=ts.createSourceFile('s.js','({'+patchNov23Factory(fixture.a4Ud,'a4Ud')+'})',ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),functions=[];
  function visit(n){if(ts.isFunctionDeclaration(n)&&n.name.text.startsWith('__forge'))functions.push(n.getText(tree));ts.forEachChild(n,visit);}visit(tree);
  const calls=[],marker={},pending=Promise.resolve(),native=kind=>(slug,...args)=>{assert.notEqual(slug,'codex-forge');calls.push({kind,slug,args});return kind==='preload'?pending:marker;};
  const h=vm.runInNewContext(functions.join('\n')+';({title:__forgeSettingsTitle,icon:__forgeSettingsIcon,preload:__forgePreloadSettings,search:__forgeNativeSearchSections})',{eM:{G:native('title')},ek:{y:native('icon')},eC:{OU:native('preload')}});
  assert.equal(h.title('codex-forge').defaultMessage,'Codex Forge 插件设置');assert.equal(h.icon('codex-forge',true),marker);await h.preload('codex-forge');
  assert.deepEqual(calls.splice(0),[{kind:'icon',slug:'plugins-settings',args:[true]}]);
  for(const slug of ['general-settings','plugins-settings']){assert.equal(h.title(slug,false,true),marker);assert.equal(h.icon(slug,false),marker);assert.equal(h.preload(slug),pending);}
  assert.equal(calls.length,6);
  const slugs=Object.freeze(['general-settings','codex-forge','billing']);
  assert.deepEqual(Array.from(h.search(slugs,null)),['general-settings','billing']);
  assert.deepEqual(Array.from(h.search(slugs,'https://fixture.invalid')),['general-settings']);
  assert(slugs.includes('codex-forge'),'Forge remains available for section-title search');
});

test('Nov23 both backend launch paths retain native arguments and add the same Forge configuration',async()=>{
  const {patchNov23Network}=await import('../scripts/native-nov23-main.mjs'),sources=require('./fixtures/native-network-nov23.json');
  for(const [role,source]of Object.entries(sources))for(const enabled of [false,true]){
    const env=enabled?{NATIVE_TEST:'keep',CODEX_FORGE_FAST:'1',CODEX_FORGE_SPEED:'ultrafast',CODEX_FAST_CANVAS:'1',CODEX_FORGE_HOME:'D:/test/forge',CODEX_FORGE_MODEL_CATALOG:'D:/test/catalog.json',CODEX_FAST_IAB:'1',CODEX_FORGE_NATIVE_PLUGINS:'1',CODEX_FORGE_COMPUTER_USE:'1'}:{NATIVE_TEST:'keep'};
    const scope={process:{env,resourcesPath:'D:/test/resources'},j:[{configKey:'native.option',envVar:'NATIVE_TEST'}],U:[{configKey:'native.option',envVar:'NATIVE_TEST'}],D:['-c','native_default=true'],B:['-c','native_default=true']};
    const run=s=>Array.from(vm.runInNewContext('('+s+')()',scope));
    const original=run(source),actual=run(patchNov23Network(source,role==='networkHost'));
    if(!enabled)assert.deepEqual(actual,original);else{
      for(const arg of original)assert(actual.includes(arg),arg);
      for(const arg of ['features.fast_mode=true','service_tier="ultrafast"','features.plugins=true','features.computer_use=true','mcp_servers.fast_canvas.enabled=true','model_catalog_json="D:/test/catalog.json"'])assert(actual.includes(arg),role+': '+arg);
    }
    assert.throws(()=>patchNov23Network(source+' '+source,role==='networkHost'),/arguments changed/);
  }
});
