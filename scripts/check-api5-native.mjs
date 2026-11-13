// Exercises the real installed CLI against a local, credential-free Responses fixture.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {ForgeNativeModels} from '../runtime/forge-model-runtime.cjs';

const executable=path.resolve(process.argv[2]||'');
assert(process.argv[2]&&fs.statSync(executable).isFile(),'Provide the verified codex.exe');
const out=path.resolve(import.meta.dirname,'../output');fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(out,'api5-native-fixture-'));
const requests=[];let mode='text',heldResolve,closedResolve;
const held=new Promise(resolve=>{heldResolve=resolve;}),closed=new Promise(resolve=>{closedResolve=resolve;});
const server=http.createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);let bytes=Buffer.concat(chunks);
  if(req.headers['content-encoding']==='gzip')bytes=zlib.gunzipSync(bytes);
  if(req.headers['content-encoding']==='zstd')bytes=zlib.zstdDecompressSync(bytes);
  assert(!req.headers.authorization,'The fixture must not receive credentials');
  const data=JSON.parse(bytes);requests.push(data);
  assert.equal((data.tools||[]).length,0,'Independent sampling must advertise no tools');
  if(mode==='hold'){res.on('close',closedResolve);heldResolve();return;}
  const text='API 5 local stream verified.';
  const item=mode==='tool'?{id:'fc_fixture',type:'function_call',call_id:'fixture-call',name:'exec_command',arguments:'{"cmd":"echo FORGE_API5_FIXTURE"}',status:'completed'}:{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const response={id:'resp_'+requests.length,object:'response',created_at:0,status:'completed',model:data.model,output:[item],usage:{input_tokens:20,output_tokens:8,total_tokens:28,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(item.type==='message'?{content:[]}:{})}}];
  if(item.type==='message')events.push({type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:'API 5 '},{type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:'local stream verified.'});
  events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response});
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const[sequence_number,event]of events.entries())res.write('event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number})+'\n\n');res.end();
 }catch(error){res.writeHead(500);res.end(error.message);}
});
const bounded=(promise,label,ms=10000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));};
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-6.1-sol"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nplugins=false\nhooks=false\napps=false\n[model_providers.fixture]\nname="API5 local fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
 const env={...process.env,CODEX_HOME:home,OTEL_SDK_DISABLED:'true',NO_PROXY:'127.0.0.1,localhost'};
 for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(key)||/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key)||key.startsWith('CODEX_FORGE_'))delete env[key];
 const models=new ForgeNativeModels({executable,env}),context={threadId:'source-must-remain-untouched',model:'gpt-6.1-sol',provider:'fixture',effort:'low'};
 const chunks=[];for await(const chunk of models.stream({prompt:'Return the local fixture text.',timeoutMs:30000},context))chunks.push(chunk);
 assert.equal(chunks.filter(item=>item.type==='text').map(item=>item.text).join(''),'API 5 local stream verified.');
 assert(chunks.some(item=>item.type==='usage'));
 mode='tool';await assert.rejects(models.sample({prompt:'Refuse the synthetic tool call.',timeoutMs:15000},context),error=>['PERMISSION_DENIED','MODEL_ERROR'].includes(error.code));
 mode='hold';const controller=new AbortController(),pending=models.sample({prompt:'Wait for cancellation.',timeoutMs:30000},context,{signal:controller.signal});
 await bounded(held,'Cancellation fixture did not receive a request');controller.abort();await assert.rejects(pending,{code:'CANCELLED'});await bounded(closed,'Cancelled HTTP request stayed open',5000);
 const sessions=path.join(home,'sessions');assert(!fs.existsSync(sessions)||fs.readdirSync(sessions).length===0,'Ephemeral sampling must not persist conversations');
 const report={passed:true,actualCli:executable,provider:'localhost fixture',credentialsSent:false,modelRequests:requests.length,streamedText:true,usage:true,noAdvertisedTools:true,toolAttemptStopped:true,cancelledRequestClosed:true,noPersistentConversations:true,remoteModelTested:false};
 fs.writeFileSync(path.join(out,'api5-native-cli.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.promises.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
