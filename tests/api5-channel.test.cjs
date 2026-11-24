'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {ForgeAPI5}=require('../runtime/forge-api5.cjs');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-channel-')),id='test.channel',pluginRoot=path.join(root,'plugins',id);fs.mkdirSync(pluginRoot,{recursive:true});
  fs.writeFileSync(path.join(pluginRoot,'plugin.json'),JSON.stringify({schemaVersion:1,id,name:'Channel',version:'1.0.0',apiVersion:5,compatibility:{forge:['>=0.7.0']},permissions:['backend.node','services.provide','services.call'],backend:{entry:'backend.cjs',scope:'session',methods:['exchange']},contributes:{services:[{name:'test.channel.service',methods:['exchange']}]},consumes:{services:['test.channel.service']}}));
  fs.writeFileSync(path.join(pluginRoot,'backend.cjs'),`exports.activate=forge=>{const sessions=new Map();const exchange=(args,{context})=>{const state=sessions.get(context.channelId)||{sequence:0,project:args.project};state.sequence++;sessions.set(context.channelId,state);return {...state,args,channelId:context.channelId,threadId:context.threadId};};forge.handle('exchange',exchange);forge.services.provide('test.channel.service',{exchange});};`);
  const registry=new ForgeRegistry({root,bundledRoot:path.join(root,'empty'),versions:{forge:'0.7.4',apiVersion:5,codex:'26.1117.4957.0'}});registry.setEnabled(id,true);
  const state={win:{webContents:{id:1},isDestroyed:()=>false}},event={sender:{id:1}},context={threadId:'thread-a',cwd:root};
  const api=new ForgeAPI5({root,registry,states:new Map([[1,state]]),contextFor:()=>context});
  t.after(async()=>{await api.dispose();fs.rmSync(root,{recursive:true,force:true});});await api.sync();
  const frameToken='channel-fixture-123456';api.registerFrame(event,{id,frameToken,fingerprint:registry.get(id).fingerprint});let requestId=0;
  const call=(method,args={})=>api.handle(event,state,{id,frameToken,requestId:++requestId,threadId:context.threadId,generation:state.api5Generation||0,method,args});
  return {api,state,call};
}
for(const method of ['backend.channel','services.channel'])test(method+' delivers initial args before send and drains output on end',async t=>{
  const f=await fixture(t),initial={project:'project-a',nested:{keep:true}};
  const {streamId}=await f.call('rpc.stream.open',{method,args:{name:'test.channel.service',method:'exchange',args:initial}});
  await f.call('rpc.stream.send',{streamId,value:{text:'later'}});
  await f.call('rpc.stream.end',{streamId});
  await assert.rejects(f.call('rpc.stream.send',{streamId,value:{text:'closed'}}),{code:'STREAM_CLOSED'});
  const first=await f.call('rpc.stream.next',{streamId}),second=await f.call('rpc.stream.next',{streamId});
  assert.deepEqual(first.value.args,initial);assert.equal(first.value.sequence,1);assert.equal(first.value.project,'project-a');
  assert.deepEqual(second.value.args,{text:'later'});assert.equal(second.value.sequence,2);assert.equal(second.value.project,'project-a');
  assert.equal(first.value.channelId,second.value.channelId);assert.equal(second.value.threadId,'thread-a');
  assert.equal((await f.call('rpc.stream.next',{streamId})).done,true);assert.equal(f.api.rpc.streams.size,0);
  const cancelled=await f.call('rpc.stream.open',{method,args:{name:'test.channel.service',method:'exchange',args:{project:'project-b'}}});
  await f.call('rpc.stream.cancel',cancelled);await assert.rejects(f.call('rpc.stream.send',{...cancelled,value:{text:'late'}}),{code:'STREAM_NOT_FOUND'});
  assert.equal(f.api.rpc.streams.size,0);
});
