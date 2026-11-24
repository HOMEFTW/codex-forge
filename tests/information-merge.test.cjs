'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {InformationStats}=require('../runtime/information-stats.cjs');
const start=Date.parse('2026-11-01T00:00:00Z');
const line=(sec,type,payload)=>JSON.stringify({timestamp:new Date(start+sec*1000).toISOString(),type,payload})+'\n';
const meta=()=>line(0,'session_meta',{id:'merge_thread',model_provider:'fixture'});
function turn(id,sec,model='gpt-6-astra'){
  return line(sec,'turn_context',{turn_id:'turn_'+id,model,effort:'high'})+
    line(sec+1,'event_msg',{type:'task_started',turn_id:'turn_'+id})+
    line(sec+3,'token_usage_record',{response_id:'response_'+id,usage:{input_tokens:20,cached_input_tokens:5,output_tokens:10,reasoning_output_tokens:2}})+
    line(sec+4,'event_msg',{type:'task_complete',turn_id:'turn_'+id});
}
test('merges all session files, deduplicates responses and turns, and selects state by event time',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-info-merge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sessions=path.join(root,'sessions');fs.mkdirSync(sessions);
  const a=path.join(sessions,'a-merge_thread.jsonl'),b=path.join(sessions,'b-merge_thread.jsonl');
  const history=Array.from({length:150},(_,i)=>turn(i,i*10+1)).join('');
  fs.writeFileSync(a,meta()+history);
  fs.writeFileSync(b,meta()+turn(149,1491)+turn(150,1501)+turn('sol',1511,'gpt-6.2-sol')+
    line(1521,'turn_context',{turn_id:'active',model:'gpt-6.2-sol',effort:'ultra'})+
    line(1522,'event_msg',{type:'task_started',turn_id:'active'})+
    line(1523,'event_msg',{type:'token_count',info:{model_context_window:500000,last_token_usage:{total_tokens:1000}}}));
  // Touch the old file later: mtime must not override the newest chat state.
  fs.utimesSync(a,new Date(),new Date(Date.now()+10000));
  const service=new InformationStats({codexHome:root});
  const read=model=>service.readMetrics({threadId:'merge_thread',model});
  const stats=await read('gpt-6-astra');
  assert.equal(stats.responses,151);assert.equal(stats.inputTokens,3020);assert.equal(stats.cachedInputTokens,755);
  assert.equal(stats.outputTokens,1510);assert.equal(stats.reasoningTokens,302);assert.equal(stats.average,5);
  assert.equal(stats.latest.id,'response_150');assert.equal(stats.samples.length,30);
  assert.equal(stats.observation.turns,153);assert.deepEqual(stats.observation.models,[{model:'gpt-6-astra',turns:151},{model:'gpt-6.2-sol',turns:2}]);
  const current=await read('gpt-6.2-sol');assert.equal(current.responses,1);assert.equal(current.phase,'generating');assert.equal(current.effort,'ultra');
  assert.equal(current.observation.contextWindow,500000);assert.equal(current.observation.contextUsed,1000);
  assert.equal((await read('gpt-6-astra')).responses,151,'refresh does not double count');
  fs.appendFileSync(b,line(1524,'event_msg',{type:'task_complete',turn_id:'active'})+turn(151,1531));
  assert.equal((await read('gpt-6-astra')).responses,152);
  fs.writeFileSync(a,meta()+turn(0,1)); // Truncation rebuilds this file's contribution.
  const replaced=await read('gpt-6-astra');assert.equal(replaced.responses,4);assert.equal(replaced.observation.turns,6);
});
