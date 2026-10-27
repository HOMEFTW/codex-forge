const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function load(){
 const frames=[],messages=[],attributes=[];
 let plugin={id:'test.panel',enabled:true,builtin:false,fingerprint:'original',permissions:['panels']};
 let snapshot={plugins:[plugin],context:{threadId:null},dynamic:[],output:[],slots:{entries:[]}};
 const body={dataset:{},append(frame){frame.isConnected=true;frames.push(frame);}};
 const document={body,querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;},createElement(){return {dataset:{},style:{},setAttribute(...value){attributes.push(value);},addEventListener(){},contentWindow:{postMessage(value){messages.push(value);}},remove(){this.isConnected=false;}};}};
 const ipc={sendSync(){return {};},on(){},async invoke(channel){assert.equal(channel,'forge:manage');return snapshot;}};
 const sandbox={document,window:{addEventListener(){}},require(){return {ipcRenderer:ipc,contextBridge:{exposeInMainWorld(){}}};},console,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/forge-preload.cjs'),'utf8'),sandbox);
 return {frames,messages,attributes,async mount(){await sandbox.__forgeBridge.refresh();await sandbox.__forgeBridge.mount(body,'forge-plugin:test.panel:main');},async change(value){plugin={...plugin,...value};snapshot={...snapshot,plugins:[plugin]};await sandbox.__forgeBridge.refresh();}};
}
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
