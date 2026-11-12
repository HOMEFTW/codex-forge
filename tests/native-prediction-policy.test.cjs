const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {NativePredictionPolicy,KEY}=require('../runtime/native-prediction-policy.cjs');
const {PromptPredictionHost}=require('../runtime/prompt-prediction-host.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t,{account={type:'chatgpt',planType:'pro'},nativeEnabled=true,requiresOpenaiAuth=true}={}){
 const settingsListeners=new Set(),notifications=new Set(),principals=new Set(),states=new Set();let reads=0,read=async()=>({account,requiresOpenaiAuth});
 const add=set=>callback=>{set.add(callback);return()=>set.delete(callback);};
 const connection={getAccount:options=>{assert.equal(options.priority,'background');reads++;return read();},registerInternalNotificationHandler:add(notifications),registerInternalAuthenticatedPrincipalChangeHandler:add(principals),registerInternalConnectionStateHandler:add(states)};
 const settings={getEffective:key=>{assert.equal(key,KEY);return nativeEnabled;},onDidChange:(key,listener)=>{assert.equal(key,KEY);return add(settingsListeners)(listener);}};
 const registry={getMaybeConnection:id=>{assert.equal(id,'local');return connection;},subscribe:()=>()=>{}};
 let pluginEnabled=true,host;const policy=new NativePredictionPolicy(()=>host?.nativeChanged());
 const state={threadId:'A',bridge:{},win:{id:1,isDestroyed:()=>false}},calls=[],events=[];
 host=new PromptPredictionHost({states:new Map([[1,state]]),settings:()=>({enabled:pluginEnabled,prompt:'下一步',maxChars:320,timeoutSeconds:30}),nativeStatus:()=>policy.snapshot(),notify:(_state,value)=>events.push(value),
  call:async()=>({thread:{id:'A'},model:'gpt-6-astra',modelProvider:'fixture',initialTurnsPage:{data:[{id:host.latest.get('A').turnId,status:'completed',items:[{type:'agentMessage',text:'已完成检查。'}]}]}}),
  sample:options=>new Promise((resolve,reject)=>{calls.push({options,resolve});options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});})});
 policy.attach({settings,connections:registry,hostId:'local'});
 t.after(()=>{policy.dispose();host.stop();});
 return {policy,host,state,calls,events,settings,registry,connection,get reads(){return reads;},complete:id=>host.observe(state,'turn/completed',{threadId:'A',turn:{id,status:'completed'}}),snapshot:()=>host.snapshot(state),request:action=>host.request(state,{...host.snapshot(state),action,expectedText:''}),setNative:value=>{nativeEnabled=value;for(const fn of settingsListeners)fn();},setAccount:(value,requires=true)=>{account=value;requiresOpenaiAuth=requires;for(const fn of principals)fn({});},setEnabled:value=>{pluginEnabled=value;host.refresh();},setRead:fn=>{read=fn;},notify:(method,params)=>{for(const fn of notifications)fn({method,params});}};
}
for(const planType of ['pro','prolite','promax'])test(`native ${planType} on blocks all samples without DOM decoration, and off restores one observed opportunity`,async t=>{
 const f=setup(t,{account:{type:'chatgpt',planType}});await tick();assert.equal(f.policy.allowed,false);
 f.complete('one');assert.equal(f.snapshot().phase,'idle');assert.equal(f.calls.length,0);
 f.setNative(false);assert.equal(f.snapshot().phase,'offer');const pending=f.request('ready');await tick();assert.equal(f.calls.length,1);
 f.setNative(true);await pending;assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.snapshot().text,null);
 f.calls[0].resolve('{"suggestion":"late"}');await tick();assert.equal(f.snapshot().text,null);
 f.setNative(false);assert.equal(f.snapshot().phase,'idle');assert.equal(f.calls.length,1);
 f.complete('two');assert.equal(f.snapshot().phase,'offer');assert.equal(f.reads,1);
});
for(const entry of [{account:{type:'chatgpt',planType:'plus'}},{account:{type:'apiKey'}},{account:{type:'chatgpt',planType:'custom-pro'}},{account:null,requiresOpenaiAuth:false}])test(`non-native account/provider continues with native preference on: ${JSON.stringify(entry)}`,async t=>{
 const f=setup(t,entry);await tick();assert.equal(f.policy.allowed,true);f.complete('one');assert.equal(f.snapshot().phase,'offer');assert.equal(f.calls.length,0);
});
test('account changes cancel immediately; stale account reads cannot reopen sampling, and plugin off wins',async t=>{
 const f=setup(t,{account:{type:'apiKey'}});await tick();f.complete('one');const pending=f.request('ready');await tick();
 let finish;f.setRead(()=>new Promise(resolve=>{finish=resolve;}));f.setAccount({type:'chatgpt',planType:'pro'});assert.equal(f.calls[0].options.signal.aborted,true);await pending;assert.equal(f.policy.allowed,false);
 const old=finish;f.setRead(async()=>({requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'pro'}}));f.notify('account/updated',{planType:'pro',authMode:'chatgpt'});await tick();old({requiresOpenaiAuth:true,account:{type:'apiKey'}});await tick();assert.equal(f.policy.allowed,false);
 f.complete('two');f.setEnabled(false);f.setNative(false);assert.equal(f.snapshot().phase,'idle');assert.equal(f.calls.length,1);
 f.setEnabled(true);assert.equal(f.snapshot().phase,'idle');f.complete('three');assert.equal(f.snapshot().phase,'offer');
});
test('unknown or failed account reads do not spend samples, and failed turns are not restored',async t=>{
 const f=setup(t);let reject;f.setRead(()=>new Promise((_resolve,no)=>{reject=no;}));f.notify('account/updated',{});f.complete('one');assert.equal(f.calls.length,0);reject(Error('offline'));await tick();assert.equal(f.policy.allowed,false);f.setNative(false);assert.equal(f.policy.allowed,true);assert.equal(f.snapshot().phase,'offer');assert.equal(f.calls.length,0);f.setNative(true);assert.equal(f.policy.allowed,false);
 f.host.observe(f.state,'turn/completed',{threadId:'A',turn:{id:'failed',status:'failed'}});
 f.setRead(async()=>({requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'pro'}}));f.notify('account/updated',{});await tick();f.setNative(false);assert.equal(f.snapshot().phase,'idle');
});
test('native adapter binds only the trusted main-process services and rejects anchor or digest drift',async()=>{
 const fixture=require('./fixtures/native-prediction-policy-nov10.json'),adapter=require('../adapters/26.1103.7773.0.json');
 assert.equal(adapter.nativePredictionPolicy.sha256,fixture.moduleSHA256);assert.equal(adapter.nativePredictionPolicy.member,fixture.member);
 const isPro=vm.runInNewContext('({'+fixture.proPlanSource+'}).k');assert.deepEqual(['pro','prolite','promax','plus','custom-pro'].map(isPro),[true,true,true,false,false]);
 const source='// '+fixture.settingSource+' '+fixture.controllerGuard+'\nthis.disposables.add(this.cumberbatchController);';
 const {patchNativePredictionPolicy}=await import('../scripts/native-nov09-main.mjs');const spec={sha256:crypto.createHash('sha256').update(source).digest('hex')};const patched=patchNativePredictionPolicy(source,source,spec);
 let received;const settings={},connections={},context={disposables:{add(){}},cumberbatchController:{},appServerConnectionRegistry:connections};
 vm.runInNewContext(patched,{e:{settingsStore:settings},sy:{n:'local'},process:{resourcesPath:'test'},require:name=>name==='node:path'?require('node:path'):{attachNativePredictionPolicy:value=>{received=value;return{dispose(){}};}},...context});
 assert.equal(received.settings,settings);assert.equal(received.connections,connections);assert.equal(received.hostId,'local');
 assert.throws(()=>patchNativePredictionPolicy(source+'changed',source,spec),/module changed/);
 assert.throws(()=>patchNativePredictionPolicy(source,source+source,spec),/duplicated/);
});

test('a known Pro account is paused even when current provider needs no OpenAI auth; plugin toggles do not retry an attempted turn',async t=>{
 const f=setup(t,{requiresOpenaiAuth:false});await tick();assert.equal(f.policy.allowed,false);f.complete('one');f.setNative(false);const pending=f.request('ready');await tick();f.setNative(true);await pending;
 f.setEnabled(false);f.setEnabled(true);f.setNative(false);assert.equal(f.snapshot().phase,'idle');assert.equal(f.calls.length,1);
});

for(const nativeEnabled of [true,false])test(`unchanged native preference notifications preserve pending predictions and suggestions (${nativeEnabled})`,async t=>{
 const f=setup(t,{account:{type:'apiKey'},nativeEnabled});await tick();
 f.complete('one');const pending=f.request('ready');await tick();
 const generation=f.snapshot().generation;
 f.setNative(nativeEnabled);
 assert.equal(f.calls[0].options.signal.aborted,false,'a notification with the same effective preference must not cancel inference');
 assert.equal(f.snapshot().generation,generation);
 f.calls[0].resolve('{"suggestion":"继续检查"}');await pending;
 f.setNative(nativeEnabled);
 assert.equal(f.snapshot().phase,'suggestion');assert.equal(f.snapshot().text,'继续检查');
 assert.equal(f.calls.length,1);
});

test('Nov12 policy injects the new trusted settings and connection symbols',async()=>{
 const f=require('./fixtures/native-prediction-policy-nov12.json'),a=require('../adapters/26.1106.6628.0.json');assert.equal(a.nativePredictionPolicy.sha256,f.moduleSHA256);assert.equal(a.nativePredictionPolicy.member,f.member);
 const source='// '+f.settingSource+' '+f.controllerGuard+'\nthis.disposables.add(this.cumberbatchController);';const spec={...a.nativePredictionPolicy,sha256:crypto.createHash('sha256').update(source).digest('hex')};const {patchNativePredictionPolicy}=await import('../scripts/native-nov09-main.mjs');const patched=patchNativePredictionPolicy(source,source,spec);let received;const settings={},connections={};vm.runInNewContext(patched,{e:{settingsStore:settings},sD:{n:'local'},process:{resourcesPath:'fixture'},require:name=>name==='node:path'?require('node:path'):{attachNativePredictionPolicy:value=>{received=value;}},disposables:{add(){}},cumberbatchController:{},appServerConnectionRegistry:connections});assert.equal(received.settings,settings);assert.equal(received.connections,connections);assert.equal(received.hostId,'local');assert.throws(()=>patchNativePredictionPolicy(source+'drift',source,spec),/module changed/);
});
