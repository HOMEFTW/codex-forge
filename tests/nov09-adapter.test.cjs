const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const fixture=require('./fixtures/native-rspack-nov09.json'),adapter=require('../adapters/26.1103.4239.0.json');
const normalize=v=>JSON.parse(JSON.stringify(v));
function execute(source,id,modules={},flags={}) {
  const req=id=>{assert(Object.hasOwn(modules,id),'Unexpected dependency '+id);return modules[id];};
  req.d=(out,getters,values={})=>{for(const [key,get] of Object.entries(getters))Object.defineProperty(out,key,{get});Object.assign(out,values);};
  const out={};vm.runInNewContext('({'+source+'})['+JSON.stringify(id)+']',{__codexForgeStartup:flags})({},out,req);return out;
}
const access=execute(fixture.eWgO,'eWgO');
test('Nov09 adapter pins current signed package and all duplicated speed modules',()=>{
  assert.equal(require('../forge.config.json').codexVersion,adapter.codexVersion);
  assert.equal(adapter.packageSHA256,'9a5fdf536327ce471f9594b0ac6e369244ec3ebfd5e09ec5a66524575dbaa60c');
  assert.equal(adapter.rspackModules.filter(m=>m.id==='ipV4').length,7);
  assert.equal(adapter.rspackModules.filter(m=>m.id==='PAzX').length,7);
});
test('all Nov09 selectors retain native and managed restrictions and expose independent Ultrafast',async()=>{
  const {patchNov09Factory}=await import('../scripts/native-nov09-patch.mjs');
  for(const original of fixture.fast)for(const enabled of [true,false])for(const method of ['apikey','chatgpt','personalAccessToken','amazonBedrock'])for(const pending of [true,false])for(const requirements of [{},{fast_mode:false},{ultrafast_mode:false}]) {
    const data={requirements:{featureRequirements:requirements},supportsIndependentSpeedModes:true};
    const modules={QosV:{c:()=>[]},zTeN:{Ul:()=> 'local',_U:()=>({data,isPending:pending})},eWgO:access,tl5a:{Dc:{}},EOo5:{tn:()=>({authMethod:method})},B81s:{b9:{}}};
    const flags={fastEnabled:enabled},actual=normalize(execute(patchNov09Factory(original,'ipV4'),'ipV4',modules,flags).U());
    if(method!=='apikey'||!enabled)assert.deepEqual(actual,normalize(execute(original,'ipV4',modules,flags).U()));
    else assert.deepEqual(actual,{serviceTierAccess:pending?null:normalize(access.W6(data)),isLoading:pending});
  }
});
test('all request factories send the real ultrafast value and honor policy and plugin disablement',async()=>{
  const {patchNov09Factory}=await import('../scripts/native-nov09-patch.mjs');
  for(const original of fixture.request)for(const enabled of [true,false])for(const method of ['apikey','chatgpt'])for(const restricted of [true,false]) {
    let reads=0;const data={requirements:{featureRequirements:{ultrafast_mode:!restricted}}};
    const modules={eWgO:access,Dgwo:{},tl5a:{},wCOm:{},mGK9:{s:async()=>method},B81s:{b9:{},Wr:async()=>{reads++;return data;}},WFY2:{v:{error:assert.fail}},l2g8:access};
    const exported=execute(patchNov09Factory(original,'PAzX'),'PAzX',modules,{fastEnabled:enabled});
    const result=await exported.e({query:{setData(){}}},'local','gpt-6.1-sol','ultrafast');
    assert.equal(result,!restricted&&(method==='chatgpt'||enabled)?'ultrafast':null);
    assert.equal(reads,method==='chatgpt'||enabled?1:0);
  }
});
test('browser availability only changes rollout gate and retains WSL, requirements, loading and config',async()=>{
  const {patchNov09Factory}=await import('../scripts/native-nov09-patch.mjs');
  for(const enabled of [false,true])for(const wsl of [false,true])for(const allowed of [false,true])for(const loading of [false,true])for(const configured of [false,true]){
    const token={},modules={QosV:{c:()=>[]},zTeN:{_U:query=>query===token?{isCapable:true}:{allowed,isPending:loading}},DBCl:{Szl:{},PAg:'wsl'},ChYf:{G:token},EOo5:{tn:()=>({authMethod:'apikey'})},RxZZ:{iK:()=>wsl},kfGJ:{Qz:()=>({kind:'local'})},hZax:{Zj:()=>false},GGpr:{$:{}},mMIg:{V:()=>({enabled:configured,isLoading:false})}};
    const result=execute(patchNov09Factory(fixture.yrds,'yrds'),'yrds',modules,{browserEnabled:enabled}).I({hostId:'local'});
    assert.equal(result.available,enabled&&!wsl&&allowed&&!loading&&configured);
    if(!enabled)assert.deepEqual(normalize(result),normalize(execute(fixture.yrds,'yrds',modules).I({hostId:'local'})));
  }
});
test('Nov09 layout receives the tab directly and startup registry remains lazy',async()=>{
  const {patchNov09Factory}=await import('../scripts/native-nov09-patch.mjs');
  const extension=fs.readFileSync(require('node:path').join(__dirname,'../runtime/native-tabs-renderer.js'),'utf8');
  const patched=patchNov09Factory(fixture.registry,'EpL9',extension);
  const unavailable=Symbol(),full=Symbol(),tabById=Symbol(),listeners=[],replies=[];const win={addEventListener:(_t,fn)=>listeners.push(fn),postMessage:r=>replies.push(r)};
  const modules={zTeN:{A4:()=>({})},OWtl:{u:{}},nnol:{},Oj9r:{Rj:unavailable,GD:{}}};
  const req=id=>{assert(Object.hasOwn(modules,id),'Eager dependency '+id);return modules[id];};req.d=(out,gets,values={})=>{for(const [k,get] of Object.entries(gets))Object.defineProperty(out,k,{get});Object.assign(out,values);};
  const out={};vm.runInNewContext('({'+patched+'}).EpL9',{window:win})({},out,req);
  let active={node:{},value:{},tabs:new Map(),get(signal,key){return signal===tabById?this.tabs.get(key):false;}};
  modules.QcW8={kF:full};modules.ZU27={It:{tabById$:tabById,openTab:(scope,type,opts)=>scope.tabs.set(opts.id,{tabId:opts.id,tabType:type,props:opts.props})}};
  modules.XXJV={yI(){}};modules.WwnD={xO:(_scope,tab)=>{assert.equal(tab.tabId,'fast-workspace:canvas');return true;}};
  out.__forgeRememberScope(active);listeners[0]({source:win,data:{fastWorkspaceNativeRequest:{id:'one',action:'open',page:'canvas'}}});assert.equal(replies[0].fastWorkspaceNativeReply.error,undefined);
});
