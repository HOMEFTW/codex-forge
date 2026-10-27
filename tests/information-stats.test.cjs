'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexMetrics, InformationStats, assess, normalizeModel, analyze } = require('../runtime/information-stats.cjs');
const { probeWithRpc, verifyFork } = require('../runtime/information-probe.cjs');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');

test('fingerprint warnings require strong evidence and never flag an unlisted model', () => {
  const evidence = { used_outputs:3, results:[
    { model:'gpt-6-sol', score:1, probability:.9 },
    { model:'gpt-5.6-sol', score:0, probability:.1 },
  ] };
  assert.equal(assess('gpt-6-sol', evidence).verdict, 'MATCH');
  assert.equal(assess('gpt-5.6-sol', evidence).verdict, 'MISMATCH');
  assert.equal(assess('gpt-5.6-sol', { ...evidence, used_outputs:1 }).verdict, 'SUSPICIOUS');
  assert.deepEqual(assess('gpt-6.1-sol', evidence), { verdict:'UNLISTED', warning:false });
  assert.equal(assess('gpt-6-sol', { results:[] }).verdict, 'NO_SAMPLE');
});

test('Codex session usage yields a model-scoped rate including reasoning output', () => {
  const metrics = new CodexMetrics();
  const line = (timestamp,type,payload) => metrics.line(JSON.stringify({ timestamp,type,payload }));
  line('2026-10-26T12:00:00Z','session_meta',{ id:'thread_1',model_provider:'openai' });
  line('2026-10-26T12:00:01Z','turn_context',{ model:'gpt-6-sol',effort:'high' });
  line('2026-10-26T12:00:02Z','event_msg',{ type:'user_message' });
  line('2026-10-26T12:00:04Z','response_item',{ type:'reasoning' });
  line('2026-10-26T12:00:05Z','response_item',{ type:7 });
  line('2026-10-26T12:00:10Z','token_usage_record',{ response_id:'r1',usage:{ input_tokens:100,output_tokens:20,reasoning_output_tokens:5 } });
  const snapshot=metrics.snapshot('gpt-6-sol');
  assert.equal(metrics.provider,'openai');
  assert.equal(metrics.effort,'high');
  assert.equal(snapshot.latest.output,20);
  assert.equal(snapshot.latest.reasoning,5);
  assert.equal(snapshot.latest.tps,2.5);
  assert.equal(snapshot.phase,'tools');
  assert.equal(metrics.snapshot('gpt-6.1-sol').latest,null);
});

test('normalization keeps GPT-6.1 separate and numerical samples are validated', () => {
  assert.equal(normalizeModel('GPT_6.1-SOL'),'gpt-6.1-sol');
  assert.notEqual(normalizeModel('gpt-6.1-sol'),normalizeModel('gpt-6-sol'));
  const sequence=Array.from({length:320},(_,index)=>(index*73+17)%355+1);
  const result=analyze([{ text:JSON.stringify(sequence),expected_count:320 }]);
  assert.equal(result.used_outputs,1);
  assert.equal(result.diagnostics[0].accepted,true);
  assert(Math.abs(result.results.reduce((sum,item)=>sum+item.probability,0)-1)<1e-9);
  assert.throws(()=>analyze([{text:'no numbers',expected_count:320}]),/没有可用回答/);
});

test('probe collects three sequential replies only from verified ephemeral forks', async () => {
  let listener, fork=0;
  const calls=[], forkParams=[];
  const call=async(method,params={})=>{
    calls.push(method);
    if(method==='thread/read') return {thread:{id:params.threadId,path:params.threadId==='thread_1'?'C:/sessions/thread_1.jsonl':null,
      ephemeral:params.threadId!=='thread_1',forkedFromId:params.threadId==='thread_1'?undefined:'thread_1',model:'gpt-6-sol',modelProvider:'openai',reasoningEffort:'high'}};
    if(method==='thread/turns/list') return {data:[{id:'turn_original',status:'completed'}]};
    if(method==='config/read') return {config:{mcp_servers:{sample:{enabled:true}}}};
    if(method==='thread/fork') { forkParams.push(params); const id='fork_'+(++fork); return {thread:{id,ephemeral:true,path:null,forkedFromId:'thread_1',model:'gpt-6-sol',modelProvider:'openai',reasoningEffort:'high'}}; }
    if(method==='turn/start') {
      const id='turn_'+fork, count=Number(params.input[0].text.match(/(?:choose |选择 )(\d+)/)?.[1]);
      setImmediate(()=>{
        listener({method:'item/started',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage'}}});
        listener({method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage',phase:'final',text:JSON.stringify(Array.from({length:count},(_,i)=>i%355+1))}}});
        listener({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}});
      });
      return {turn:{id}};
    }
    return {};
  };
  const outputs=await probeWithRpc({call,subscribe:fn=>{listener=fn;return()=>{listener=null;}},threadId:'thread_1',model:'gpt-6-sol',provider:'openai',effort:'high',cwd:'C:/project'});
  assert.equal(outputs.length,3);
  assert(outputs.every(output=>JSON.parse(output.text).length===output.expected_count));
  assert.equal(forkParams.length,3);
  assert(forkParams.every(params=>params.ephemeral&&params.config['features.multi_agent']===false&&params.config['mcp_servers.sample.enabled']===false&&!('sandbox' in params)&&!('approvalPolicy' in params)));
  assert.equal(calls.filter(method=>method==='turn/start').length,3);
});

test('probe refuses a fork whose effective model differs from the active conversation', async () => {
  let starts=0;
  const call=async(method,params={})=>{
    if(method==='thread/read') return {thread:{id:params.threadId,path:params.threadId==='thread_1'?'C:/sessions/thread_1.jsonl':null,ephemeral:params.threadId!=='thread_1',forkedFromId:params.threadId==='thread_1'?undefined:'thread_1',model:params.threadId==='thread_1'?'gpt-6-sol':'gpt-5.6-sol',modelProvider:'openai',reasoningEffort:'high'}};
    if(method==='thread/turns/list') return {data:[{id:'turn_original',status:'completed'}]};
    if(method==='config/read') return {config:{}};
    if(method==='thread/fork') return {thread:{id:'fork_1',ephemeral:true,path:null,forkedFromId:'thread_1'}};
    if(method==='turn/start') starts++;
    return {};
  };
  await assert.rejects(probeWithRpc({call,subscribe:()=>()=>{},threadId:'thread_1',model:'gpt-6-sol',provider:'openai',effort:'high',cwd:'C:/project'}),/模型设置/);
  assert.equal(starts,0);
  assert.throws(()=>verifyFork({thread:{id:'fork_1',ephemeral:true,path:null,forkedFromId:'thread_1',model:'gpt-6.1-sol',modelProvider:'openai',reasoningEffort:'high'}},{threadId:'thread_1',model:'gpt-6-sol',provider:'openai',effort:'high'}),/模型设置/);
});

test('imports the upstream is-gpt-nerfed ledger fields and rejects another provider', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-info-stats-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codexHome=path.join(root,'codex'), ledger=path.join(codexHome,'is-gpt-nerfed'), probes=path.join(ledger,'probes');
  fs.mkdirSync(probes,{recursive:true});
  const id='probe-12345', now=Date.parse('2026-10-27T02:00:00Z'), finished='2026-10-27T01:59:00Z';
  const answer=JSON.stringify(Array.from({length:320},(_,index)=>(index*73+17)%355+1));
  fs.writeFileSync(path.join(ledger,'probes.jsonl'),JSON.stringify({id,thread_id:'thread_1',expected:'gpt-6-sol',finished})+'\n');
  fs.writeFileSync(path.join(probes,id+'.json'),JSON.stringify({thread_id:'thread_1',expected:'gpt-6-sol',thread:{provider:'openai',effort:'high'},answers:[{text:answer,expected_count:320}]}));
  const service=new InformationStats({root:path.join(root,'results'),codexHome,nerfedHome:ledger,now:()=>now});
  const context={threadId:'thread_1',model:'gpt-6-sol',provider:'openai',effort:'high'};
  const imported=await service.dispatch('import',{},context);
  assert.equal(imported.fingerprint.source,'is-gpt-nerfed');
  assert.equal(imported.fingerprint.createdAt,Date.parse(finished));
  await assert.rejects(service.dispatch('import',{}, {...context,provider:'other'}),/没有可用于当前模型/);
  assert.equal((await service.records('thread_1')).length,1);
});

test('probe cancellation is scoped to the active thread and does not save a partial result', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-info-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let runnerStarted;
  const started = new Promise(resolve => { runnerStarted = resolve; });
  let finish;
  const service = new InformationStats({
    root: path.join(root, 'results'),
    codexHome: path.join(root, 'codex'),
    probeRunner: ({ signal }) => new Promise((resolve, reject) => {
      finish = { resolve, reject };
      runnerStarted();
      if (signal.aborted) reject(new Error('检测已取消'));
      else signal.addEventListener('abort', () => reject(new Error('检测已取消')), { once: true });
    }),
  });
  const context = { threadId: 'thread_1', model: 'gpt-6-sol', provider: 'openai', effort: 'high' };

  await service.dispatch('probe', {}, context);
  await started;
  const cancelled = await service.dispatch('cancel', {}, context);
  assert.equal(cancelled.threadId, 'thread_1');

  for (let attempt = 0; attempt < 20 && service.publicJob('thread_1').status === 'running'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(service.publicJob('thread_1').status, 'cancelled');
  assert.equal((await service.records('thread_1')).length, 0);
  assert.equal(typeof finish.reject, 'function');
});

test('built-in manifest validates and registers the statistics panel enabled by default', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-info-registry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const registry=new ForgeRegistry({root,bundledRoot:path.join(__dirname,'../plugins'),versions:{forge:'0.3.0',codex:'26.1021.2667.0',apiVersion:2}});
  const plugin=registry.list().plugins.find(item=>item.id==='forge.information-stats');
  assert.equal(registry.errors.some(item=>item.directory==='forge.information-stats'),false);
  assert.equal(plugin.builtin,true);
  assert.equal(plugin.enabled,true);
  assert.equal(plugin.contributes.panels[0].builtinPage,'information-stats');
});
