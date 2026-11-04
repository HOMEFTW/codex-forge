const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function load(){
 const frames=[],messages=[],attributes=[],calls=[],listeners=new Map(); let response={ok:true,result:null};
 let plugin={id:'test.panel',enabled:true,builtin:false,fingerprint:'original',permissions:['panels']};
 let snapshot={plugins:[plugin],context:{threadId:null},dynamic:[],output:[],slots:{entries:[]}};
 const body={dataset:{},append(frame){frame.isConnected=true;frames.push(frame);}};
 const document={body,querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;},createElement(){return {dataset:{},style:{},setAttribute(...value){attributes.push(value);},addEventListener(){},contentWindow:{postMessage(value){messages.push(value);}},remove(){this.isConnected=false;}};}};
 const ipc={sendSync(){return {};},on(){},async invoke(channel,args){if(channel==='forge:api'){calls.push(args);return response;}assert.equal(channel,'forge:manage');return snapshot;}};
 const sandbox={document,window:{addEventListener(name,fn){listeners.set(name,fn);}},require(){return {ipcRenderer:ipc,contextBridge:{exposeInMainWorld(){}}};},console,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/forge-preload.cjs'),'utf8'),sandbox);
 return {frames,messages,attributes,calls,setResponse(value){response=value;},request(request){return listeners.get('message')({origin:'null',source:frames.at(-1).contentWindow,data:{forgePluginRequest:request}});},async mount(){await sandbox.__forgeBridge.refresh();await sandbox.__forgeBridge.mount(body,'forge-plugin:test.panel:main');},async change(value){plugin={...plugin,...value};snapshot={...snapshot,plugins:[plugin]};await sandbox.__forgeBridge.refresh();}};
}

test('API 3 preload binds plugin identity and forwards structured failures without confusing stored data',async()=>{
 const h=load();await h.mount();
 h.setResponse({ok:false,error:{code:'PERMISSION_DENIED',message:'拒绝写入'}});
 await h.request({id:7,method:'nexus.request',args:{method:'write'},pluginId:'forge.nexus'});
 assert.equal(h.calls.at(-1).id,'test.panel');
 assert.equal(h.messages.at(-1).forgePluginReply.id,7);
 assert.equal(h.messages.at(-1).forgePluginReply.error.code,'PERMISSION_DENIED');
 const stored={ok:false,error:{code:'user-data'}};h.setResponse({ok:true,result:stored});
 await h.request({id:8,method:'storage.get',args:{key:'x'}});
 assert.deepEqual(h.messages.at(-1).forgePluginReply.result,stored);
});
test('preload mounts a declared plugin panel once in a script-only sandbox',async()=>{
 const h=load();await h.mount();await h.mount();
 assert.equal(h.frames.length,1);assert.equal(h.frames[0].src,'codex-forge://plugin/test.panel/main');
 assert.deepEqual(h.attributes,[['sandbox','allow-scripts']]);
});
test('disabling a plugin disposes its panel and notifies its lifecycle listeners',async()=>{
 const h=load();await h.mount();await h.change({enabled:false});
 assert.equal(h.frames[0].isConnected,false);assert(h.messages.some(value=>value.forgePluginEvent?.name==='dispose'));
});
test('updating plugin content retires the old panel before mounting a new one',async()=>{
 const h=load();await h.mount();await h.change({fingerprint:'updated'});await h.mount();
 assert.equal(h.frames[0].isConnected,false);assert.equal(h.frames.length,2);assert.equal(h.frames[1].isConnected,true);
});
