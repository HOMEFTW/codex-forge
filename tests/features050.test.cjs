const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('Ultrafast overlays only explicitly selected models and preserves native tiers',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ultrafast-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const source={models:[{slug:'one',service_tiers:[{id:'priority',name:'Fast'}]},{slug:'two',service_tiers:[{id:'ultrafast',name:'Native Ultra'}]},{slug:'three'}]};fs.writeFileSync(path.join(home,'models_cache.json'),JSON.stringify(source));
  const {prepareModelCatalog}=require('../runtime/model-catalog.cjs');
  const result=prepareModelCatalog({codexHome:home,settings:{enableTerra:false,ultrafastModels:['one']}});const actual=JSON.parse(fs.readFileSync(result.path));
  assert.deepEqual(actual.models[0].service_tiers.map(t=>t.id),['priority','ultrafast']);assert.deepEqual(actual.models.slice(1),source.models.slice(1));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'models_cache.json'))),source);
});
test('native feature toggles clear stale environment flags and respect disabled plugin',()=>{
  const {applyNativeFeatures}=require('../runtime/native-features.cjs');const env={CODEX_FAST_IAB:'1',CODEX_FORGE_COMPUTER_USE:'1'};
  applyNativeFeatures({status:()=>({enabled:false})},env);assert(Object.values(env).every(x=>x==='0'));
  applyNativeFeatures({status:()=>({enabled:true}),settings:()=>({nativeBrowserMode:true,nativePlugins:true,externalBrowser:false,computerUse:false})},env);assert.equal(env.CODEX_FAST_IAB,'1');assert.equal(env.CODEX_FORGE_NATIVE_PLUGINS,'1');assert.equal(env.CODEX_FORGE_COMPUTER_USE,'0');assert.equal(env.CODEX_FORGE_EXTERNAL_BROWSER,'0');
});
test('Windows CUA adapts window state and actions, rejects ambiguous apps, and preserves non-Windows',async()=>{
  const {installWindowsApps}=await import('../runtime/windows-cua.mjs');const calls=[];const computer={target:'windows',activate_window:async args=>calls.push(args),list_apps:async()=>[{id:'editor',displayName:'Editor',windows:[{id:1}]}],get_window_state:async args=>(calls.push(args),{window:{id:2},accessibility:{tree:'Window'},screenshots:[{url:'data:image/png;base64,YQ=='}]}),click:async args=>calls.push(args),scroll:async args=>calls.push(args)};
  const emitted=[];const cua=installWindowsApps({computer},{write(){},emitImage(image){emitted.push(image);}}),app=await cua.getApp('Editor');assert.equal(calls[0].window.id,1);assert.equal(emitted[0].mimeType,'image/png');await app.click(7);assert.deepEqual(calls.at(-1),{window:{id:2},element_index:7});await app.scroll([12,20],'down',2);assert.equal(calls.at(-1).scrollY,1200);assert.equal(await app.getAXState({emit:false}),'Window');await assert.rejects(cua.getApp('missing'),/不唯一/);assert.throws(()=>app.scroll([0,0],'sideways'),/方向/);const native={computer:{target:'macOS'}};assert.equal(installWindowsApps(native),native);assert.equal(native.getApp,undefined);computer.get_window_state=async()=>({window:{id:3},screenshots:[{url:'data:image/jpeg;base64,Yg=='}]});await app.getScreenshot();assert.equal(emitted.at(-1).mimeType,'image/jpeg');assert.equal(Buffer.from(emitted.at(-1).bytes).toString(),'b');
});
test('release delta block recipe reconstructs exact output',async()=>{
  const {createDelta}=await import('../scripts/build-delta.mjs');const before=Buffer.concat([Buffer.alloc(65536,1),Buffer.alloc(65536,2)]),after=Buffer.concat([before.subarray(65536),Buffer.from('changed'),before.subarray(0,100)]);const delta=createDelta(before,after);const rebuilt=Buffer.concat(delta.operations.map(op=>op.data?Buffer.from(op.data,'base64'):before.subarray(op.offset,op.offset+op.bytes)));assert.deepEqual(rebuilt,after);assert(delta.operations.some(op=>op.offset!==undefined));
});
