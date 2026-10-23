const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const original=fs.readFileSync(path.join(__dirname,'fixtures/native-fast-original.js'),'utf8').trim();
const normalize=value=>JSON.parse(JSON.stringify(value));
const fCe=e=>{const r=e.requirements?.featureRequirements,fast=r?.fast_mode!==false;return {fast,ultrafast:(e.supportsIndependentSpeedModes===true||fast)&&r?.ultrafast_mode!==false};};
function mount(source,enabled){
 const state={auth:null,data:null,pending:false},cache=[];
 const globals={__codexForgeStartup:{fastEnabled:enabled},vLo:{c:()=>cache},Z:()=>'local',vk:{},OT:()=>state.auth,xC:{},Nc:(_key,args)=>{state.query=args;return {data:state.data,isPending:state.pending};},fCe};
 return {state,globals,call:vm.runInNewContext('('+source+')',globals)};
}
test('API Fast respects managed limits, loading, logout and plugin disablement',async()=>{
 const {patchFastAccess}=await import('../scripts/native-fast-patch.mjs'),patched=patchFastAccess(original);
 assert.throws(()=>patchFastAccess('unrecognized client'));
 for(const enabled of [false,true])for(const authMethod of ['apikey','chatgpt','personalAccessToken','amazonBedrock','copilot','unknown',null])for(const isLoading of [false,true])for(const pending of [false,true])for(const data of [null,{}, {requirements:{featureRequirements:{fast_mode:false}}},{supportsIndependentSpeedModes:true,requirements:{featureRequirements:{fast_mode:false}}}]){
  const before=mount(original,enabled),after=mount(patched,enabled);
  for(const probe of [before,after])Object.assign(probe.state,{auth:authMethod?{authMethod,isLoading}:null,pending,data});
  if(enabled&&authMethod==='apikey')assert.deepEqual(normalize(after.call()),{serviceTierAccess:isLoading?null:{...fCe(data??{}),ultrafast:false},isLoading});
  else assert.deepEqual(normalize(after.call()),normalize(before.call()));
 }
 const probe=mount(patched,true);probe.state.auth={requiresAuth:false};assert.equal(probe.call().serviceTierAccess.fast,true);assert.equal(probe.state.query.authMethod,'apikey');
 const cached=probe.call();assert.equal(probe.call(),cached);probe.state.auth=null;assert.equal(probe.call().serviceTierAccess,null);
 probe.state.auth={authMethod:'apikey'};assert.equal(probe.call().serviceTierAccess.fast,true);probe.globals.__codexForgeStartup.fastEnabled=false;assert.equal(probe.call().serviceTierAccess,null);
});
test('sandboxed preload gets startup flags from main even when renderer argv lacks them',()=>{
 let exposed,listener;
 const electron={contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'__codexForgeStartup');exposed=value;}},ipcRenderer:{sendSync:name=>{assert.equal(name,'forge:startup-flags');return {fastEnabled:true};},on(){}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/forge-preload.cjs'),'utf8'),{require:()=>electron,process:{argv:[]},window:{addEventListener:(name,fn)=>{listener=fn;}}});
 assert.deepEqual(exposed,{fastEnabled:true});assert.equal(typeof listener,'function');
});
