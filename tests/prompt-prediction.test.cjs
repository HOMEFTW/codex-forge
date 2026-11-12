'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DEFAULT_PROMPT,normalizePrediction,predictionContext,predictPrompt}=require('../runtime/prompt-prediction.cjs');
const context={threadId:'thread_A',sourceTurnId:'turn_1'};
const source=()=>({thread:{id:context.threadId},model:'gpt-6-astra',modelProvider:'fixture',reasoningEffort:'xhigh',serviceTier:'priority',initialTurnsPage:{data:[{id:context.sourceTurnId,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'请检查这个实现。'}]},{type:'commandExecution',output:'tool output must not be forwarded'},{type:'agentMessage',phase:'final_answer',text:'已检查，接下来可以测试。'}]}]}});
const options=patch=>({...context,call:async()=>source(),sample:async()=>'{"suggestion":"开始测试。"}',...patch});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('prediction reads bounded current context and uses its actual model/provider without changing source settings',async()=>{
 const calls=[],samples=[];
 const result=await predictPrompt(options({call:async(...args)=>{calls.push(args);return source();},sample:async args=>{samples.push(args);return '{"suggestion":"开始测试。"}';}}));
 assert.deepEqual(result,{...context,text:'开始测试。'});assert.equal(calls.length,1);
 assert.equal(calls[0][0],'thread/resume');assert.deepEqual(calls[0][1],{threadId:context.threadId,excludeTurns:true,initialTurnsPage:{limit:3,itemsView:'summary',sortDirection:'desc'}});
 assert.equal(calls[0][2].timeoutMs,15000);assert.equal(samples.length,1);
 const s=samples[0];assert.equal(s.model,'gpt-6-astra');assert.equal(s.modelProvider,'fixture');assert.equal(s.serviceTier,'priority');assert.equal(s.sourceThreadId,context.threadId);assert.equal(s.timeoutMs,30000);
 assert(s.prompt.includes(DEFAULT_PROMPT));assert(s.prompt.includes('USER would type'));assert(s.prompt.includes('请检查这个实现。'));assert(s.prompt.includes('已检查，接下来可以测试。'));assert(!s.prompt.includes('tool output must not be forwarded'));
 assert(!calls.some(([method])=>['turn/start','thread/start','thread/sample'].includes(method)));
});

test('prediction preferences retain output constraints and requested character limit',async()=>{
 let sent;const result=await predictPrompt(options({prompt:'Prefer a short English follow-up.',maxChars:80,timeoutMs:1000,sample:async args=>{sent=args;return '{"suggestion":"Show me the final diff."}';}}));
 assert.equal(result.text,'Show me the final diff.');assert.match(sent.prompt,/only one JSON object/);assert.match(sent.prompt,/Prefer a short English follow-up/);assert.match(sent.prompt,/at most 80 characters/);
});

test('empty, malformed, tool-only and oversized predictions never become drafts',()=>{
 for(const text of [null,undefined,'',' ','Here is your answer.','{broken','null','[]','{"suggestion":null}','{"suggestion":42}','{"suggestion":"  "}','```json\n{"suggestion":"continue"}\n```',JSON.stringify({suggestion:'a'.repeat(321)}),JSON.stringify({suggestion:'bad\u0000text'}),' '.repeat(20001)])assert.equal(normalizePrediction(text),null);
 assert.equal(normalizePrediction(JSON.stringify({suggestion:'  继续检查这处问题。  '})),'继续检查这处问题。');assert.equal(normalizePrediction(JSON.stringify({suggestion:'x'.repeat(81)}),80),null);
});

test('an empty sampler response produces no suggestion',async()=>{
 assert.deepEqual(await predictPrompt(options({sample:async()=>null})),{...context,text:null});
});

test('stale, running and unconfirmed source turns fail before inference',async()=>{
 for(const patch of [s=>s.thread.id='other',s=>s.initialTurnsPage.data[0].id='old',s=>s.initialTurnsPage.data[0].status='inProgress',s=>delete s.initialTurnsPage]){
  const s=source();patch(s);await assert.rejects(predictPrompt(options({call:async()=>s,sample:()=>assert.fail('no inference')})),{code:'PREDICTION_STALE'});
 }
});

test('missing model/provider or usable context never falls back to another model',async()=>{
 for(const patch of [s=>delete s.model,s=>delete s.modelProvider,s=>s.initialTurnsPage.data[0].items=[]]){
  const s=source();patch(s);await assert.rejects(predictPrompt(options({call:async()=>s,sample:()=>assert.fail('no inference')})),{code:'PREDICTION_UNAVAILABLE'});
 }
});

test('already cancelled requests do not read or invoke the model',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(predictPrompt(options({signal:controller.signal,call:()=>assert.fail('no read'),sample:()=>assert.fail('no sample')})),{code:'PREDICTION_CANCELLED'});
});

test('cancelling in-flight inference aborts its worker and discards late output',async()=>{
 const controller=new AbortController();let finish,transportSignal;
 const pending=predictPrompt(options({signal:controller.signal,sample:args=>{transportSignal=args.signal;return new Promise(resolve=>finish=resolve);}}));
 await tick();controller.abort();await assert.rejects(pending,{code:'PREDICTION_CANCELLED'});assert.equal(transportSignal.aborted,true);finish('{"suggestion":"迟到结果"}');await tick();
});

test('a source read that finishes after cancellation cannot start inference',async()=>{
 const controller=new AbortController();let finish;
 const pending=predictPrompt(options({signal:controller.signal,call:()=>new Promise(resolve=>finish=resolve),sample:()=>assert.fail('no late inference')}));
 await tick();controller.abort();await assert.rejects(pending,{code:'PREDICTION_CANCELLED'});finish(source());await tick();
});

test('timeouts abort the worker even if its transport ignores cancellation',async()=>{
 let signal;await assert.rejects(predictPrompt(options({timeoutMs:10,sample:args=>{signal=args.signal;return new Promise(()=>{});}})),{code:'TIMEOUT'});assert.equal(signal.aborted,true);
});

test('a worker rejecting on abort preserves timeout and cancellation codes',async()=>{
 const sample=({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 await assert.rejects(predictPrompt(options({timeoutMs:10,sample})),{code:'TIMEOUT'});
 const controller=new AbortController(),pending=predictPrompt(options({signal:controller.signal,sample}));await tick();controller.abort();await assert.rejects(pending,{code:'PREDICTION_CANCELLED'});
});

test('inference failures propagate without retrying or altering the main chat',async()=>{
 let count=0;await assert.rejects(predictPrompt(options({sample:async()=>{count++;throw Object.assign(Error('Unavailable'),{code:'UNAVAILABLE'});}})),{code:'UNAVAILABLE'});assert.equal(count,1);
});

test('context retains recent text, omits commentary and tool data, and stays bounded',()=>{
 const turns=[{items:[{type:'userMessage',content:[{type:'text',text:'recent user'},{type:'image',url:'private image'}]},{type:'agentMessage',phase:'commentary',text:'private commentary'},{type:'agentMessage',phase:'final_answer',text:'recent answer'}]},{items:[{type:'userMessage',content:[{type:'text',text:'old'.repeat(20000)}]},{type:'agentMessage',text:'answer'.repeat(20000)}]}];
 const result=predictionContext(turns);assert(result.reduce((n,v)=>n+v.text.length,0)<=24000);assert.equal(result.at(-1).text,'recent answer');assert.equal(result.at(-2).text,'recent user');assert(!JSON.stringify(result).includes('private'));
});

test('invalid or unbounded settings fail before source reads or inference',async()=>{
 for(const patch of [{threadId:'../thread'},{sourceTurnId:''},{prompt:''},{prompt:'a'.repeat(8001)},{maxChars:19},{maxChars:2001},{maxChars:20.5},{timeoutMs:0},{timeoutMs:120001}])await assert.rejects(predictPrompt(options({...patch,call:()=>assert.fail('no read'),sample:()=>assert.fail('no sample')})),{code:'INVALID_ARGUMENT'});
});
