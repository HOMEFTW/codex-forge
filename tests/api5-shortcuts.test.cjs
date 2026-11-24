'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {ForgeAPI5}=require('../runtime/forge-api5.cjs');
test('shortcut registration, collisions and real preload events share canonical modifier order',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-shortcuts-'));
  for(const id of ['test.keys','test.other']){
    const directory=path.join(root,'plugins',id);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'entry.js'),'');
    fs.writeFileSync(path.join(directory,'plugin.json'),JSON.stringify({schemaVersion:1,apiVersion:5,id,name:id,version:'1.0.0',compatibility:{forge:['>=0.7.0']},entry:'entry.js',permissions:['shortcuts'],contributes:{commands:[{id:'run',title:'Run'}]}}));
  }
  const registry=new ForgeRegistry({root,bundledRoot:path.join(root,'empty'),versions:{forge:'0.7.4',apiVersion:5,codex:'26.1117.4957.0'}});
  for(const id of ['test.keys','test.other'])registry.setEnabled(id,true);
  const api=new ForgeAPI5({registry,root});t.after(async()=>{await api.dispose();fs.rmSync(root,{recursive:true,force:true});});
  const listeners=new Map(),frames=[],commands=[];let snapshot;
  const document={body:{dataset:{},append(frame){frames.push(frame);frame.isConnected=true;}},querySelectorAll:()=>[],querySelector:()=>null,getElementById:()=>null,createElement(){const frame={dataset:{},style:{},setAttribute(){},addEventListener(name,fn){if(name==='load')frame.loaded=fn;},remove(){frame.isConnected=false;}};frame.contentWindow={postMessage(message){if(message.forgePluginCommand){commands.push(message.forgePluginCommand);listeners.get('message')({origin:'null',source:frame.contentWindow,data:{forgePluginCommandReply:{id:message.forgePluginCommand.id,result:true}}});}}};return frame;}};
  const sandbox={document,window:{addEventListener:(name,fn)=>listeners.set(name,fn)},require:()=>({ipcRenderer:{sendSync:()=>({}),on(){},invoke:async channel=>channel==='forge:manage'?snapshot:true},contextBridge:{exposeInMainWorld(){}}}),console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/forge-preload.cjs'),'utf8'),sandbox);
  let prevented=0;const press=extra=>listeners.get('keydown')({key:'k',ctrlKey:true,shiftKey:true,altKey:false,metaKey:false,preventDefault(){prevented++;},...extra});
  for(const key of ['Shift+Ctrl+k','Ctrl+Shift+K']){
    await api.dispatch('test.keys','shortcuts.register',{id:'shortcut',key,command:'run'});
    assert.equal(api.uiSnapshot().shortcuts[0].key,'Ctrl+Shift+K');assert.equal(api.uiSnapshot().shortcuts.length,1);
    await assert.rejects(api.dispatch('test.other','shortcuts.register',{id:'collision',key:'Shift+Ctrl+K',command:'run'}),/占用/);
    await assert.rejects(api.dispatch('test.keys','shortcuts.register',{id:'alias',key:'Ctrl+Shift+k',command:'run'}),/占用/);
    snapshot={...registry.list(),context:{apiVersion:5,threadId:null},dynamic:[],output:[],slots:{entries:[]},api5:api.uiSnapshot()};
    await sandbox.__forgeBridge.refresh();for(const frame of frames)frame.loaded?.();
    const before=commands.length;press();await Promise.resolve();assert.equal(commands.length,before+1);assert.equal(commands.at(-1).command,'run');
    press({repeat:true});press({isComposing:true});assert.equal(commands.length,before+1);
  }
  assert.equal(prevented,2);
});
