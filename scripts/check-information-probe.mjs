import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {runInformationProbe}=require('../runtime/information-probe.cjs');
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'output');
assert(process.argv[2],'Usage: node scripts/check-information-probe.mjs <verified-codex.exe>');
const exe=path.resolve(process.argv[2]);assert(fs.statSync(exe).isFile());
fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(out,'probe-fresh-home-'));
assert(home.startsWith(out+path.sep));
const project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});
const inherited='FIXTURE_PROJECT_DIRECTIVE_7A19: Always call a tool before every response; continue the existing task.';
fs.writeFileSync(path.join(project,'AGENTS.md'),inherited+'\n');
const children=[], requests=[];let holdResolve;const held=new Promise(resolve=>holdResolve=resolve);
const server=http.createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const c of req)chunks.push(c);let body=Buffer.concat(chunks);
  if(req.headers['content-encoding']==='gzip')body=zlib.gunzipSync(body);
  if(req.headers['content-encoding']==='zstd')body=zlib.zstdDecompressSync(body);
  const data=JSON.parse(body.toString());
  assert.equal(!!req.headers.authorization,false,'local fixture must never receive credentials');
  const index=requests.push(data);
  const count=Number(JSON.stringify(data.input).match(/(?:choose |选择 )(\d+)/)?.[1]||3);
  const answer=JSON.stringify(Array.from({length:count},(_,i)=>i%355+1));
  const item={id:'msg_'+index,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_'+index,object:'response',created_at:0,status:'completed',model:data.model,output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('event: response.created\ndata: '+JSON.stringify({type:'response.created',sequence_number:0,response:{...response,status:'in_progress',output:[]}})+'\n\n');
  if(index===2){holdResolve();return;}
  const events=[{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:answer},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  events.forEach((event,i)=>res.write('event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number:i+1})+'\n\n'));res.end();
 }catch(error){res.writeHead(500);res.end(error.stack||error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-6-sol"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nplugins=false\napps=false\nhooks=false\nshell_tool=false\napply_patch_freeform=false\nmulti_agent=false\n[model_providers.fixture]\nname="Local fingerprint fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const env={...process.env,CODEX_HOME:home,OTEL_SDK_DISABLED:'true',NO_PROXY:'127.0.0.1,localhost'};
for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(key)||/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key))delete env[key];
function startRpc(){
 const child=spawn(exe,['app-server','--listen','stdio://'],{env,cwd:home,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);
 const pending=new Map(),notifications=[],listeners=new Set();let seq=0,stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const rejectAll=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 child.on('error',rejectAll);child.on('exit',code=>rejectAll(Error('app-server exited '+code+' '+stderr.slice(-1000))));
 readline.createInterface({input:child.stdout}).on('line',line=>{let msg;try{msg=JSON.parse(line);}catch{return;}if(msg.id!=null&&msg.method){child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'fixture denies tools'}})+'\n');return;}const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}else{notifications.push(msg);for(const listener of listeners)listener(msg);}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('timeout '+method+' '+stderr.slice(-1000)));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 return {child,call,notifications,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},async init(){await call('initialize',{clientInfo:{name:'forge_fresh_probe_fixture',version:'0.3.1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');}};
}
async function waitFor(rpc,predicate){const found=rpc.notifications.find(predicate);if(found)return found;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(Error('notification timeout'));},15000);const off=rpc.subscribe(message=>{if(predicate(message)){clearTimeout(timer);off();resolve(message);}});});}
try{
 const host=startRpc();await host.init();
 const source=await host.call('thread/start',{model:'gpt-6-sol',modelProvider:'fixture',cwd:project,approvalPolicy:'never',sandbox:'read-only',ephemeral:false});
 const sourceId=source.thread.id;
 assert((source.instructionSources||[]).some(value=>String(value).endsWith('AGENTS.md')),'fixture parent should load its tool-mandating project instruction');
 await host.call('turn/start',{threadId:sourceId,input:[{type:'text',text:'Continue the active fixture task.'}]});
 await waitFor(host,n=>n.method==='turn/completed'&&n.params.threadId===sourceId);
 const active=await host.call('turn/start',{threadId:sourceId,input:[{type:'text',text:'Stay active; do not finish before this isolated verification completes.'}]});
 let waitTimer;try{await Promise.race([held,new Promise((_,reject)=>{waitTimer=setTimeout(()=>reject(Error('fixture request did not arrive')),15000);})]);}finally{clearTimeout(waitTimer);}
 const progress=[],savedEnv={...process.env};let outputs;
 try {
 for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];
 Object.assign(process.env,env);delete process.env.CODEX_FORGE_MODEL_CATALOG;
 outputs=await runInformationProbe({executable:exe,threadId:sourceId,model:'gpt-6-sol',provider:'fixture',effort:'high',cwd:project,onProgress:value=>progress.push(value),timeoutMs:45000});
 }finally{for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);}
 assert.equal(outputs.length,3);assert.deepEqual(progress,[1,2,3]);assert.equal(requests.length,5);
 const probeRequests=requests.slice(2),serialized=probeRequests.map(request=>JSON.stringify(request));
 assert(probeRequests.every(request=>request.model==='gpt-6-sol'),'probe retained the active model');
 assert(probeRequests.every(request=>request.reasoning?.effort==='high'),'probe retained the requested effort');
 assert(serialized.every(value=>!value.includes(inherited)),'project instruction text leaked into model request');
 assert(probeRequests.every(request=>!Array.isArray(request.tools)||request.tools.length===0),'tools were exposed to the probe model');
 assert(serialized.every(value=>!value.includes('Continue the active fixture task.')&&!value.includes('Stay active;')),'parent history leaked into probe');
 const history=await host.call('thread/turns/list',{threadId:sourceId,limit:1,itemsView:'notLoaded',sortDirection:'desc'});
 assert.equal(history.data[0].id,active.turn.id);assert.equal(history.data[0].status,'inProgress');
 const report={inProgressParentPreserved:true,freshEphemeralThreads:3,probeSamples:outputs.length,progress,projectInstructionLoadedInParent:true,projectInstructionLeakedToProbe:false,modelToolsExposed:probeRequests.map(request=>Array.isArray(request.tools)?request.tools.length:0),localUnauthenticatedRequests:requests.length,paidRequests:0};
 fs.writeFileSync(path.join(out,'information-probe-fresh-session.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await host.call('turn/interrupt',{threadId:sourceId,turnId:active.turn.id});
}finally{
 for(const child of children){
  const exited=new Promise(resolve=>{if(child.exitCode!==null)resolve();else{child.once('exit',resolve);child.once('error',resolve);}});
  child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  let timer;try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
  child.unref();
 }
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await fs.promises.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
