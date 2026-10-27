import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const executable=process.argv[2],catalog=process.argv[3];
const model=process.argv[4] || 'gpt-6.1-sol', expectedWindow=Number(process.argv[5] || 475000);
assert(executable&&catalog,'Pass codex.exe and an existing model catalog');
const root=path.resolve(import.meta.dirname,'..'),fixture=fs.mkdtempSync(path.join(root,'output','fast-context-'));
const requests=[],notifications=[],pending=new Map();let serial=0,stderr='';
const server=http.createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const part of req)chunks.push(part);let bytes=Buffer.concat(chunks);
  if(req.headers['content-encoding']==='gzip')bytes=zlib.gunzipSync(bytes);
  if(req.headers['content-encoding']==='zstd')bytes=zlib.zstdDecompressSync(bytes);
  const body=JSON.parse(bytes.toString());requests.push({model:body.model,service_tier:body.service_tier,authorizationPresent:!!req.headers.authorization});
  const message={id:'msg_probe',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]};
  const response={id:'resp_probe',object:'response',created_at:0,status:'completed',model:body.model,output:[message],usage:{input_tokens:100,output_tokens:1,total_tokens:101,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,item_id:message.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,item_id:message.id,content_index:0,delta:'OK'},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});events.forEach((e,i)=>res.write(`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`));res.end();
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(fixture,'config.toml'),`model="gpt-6.1-sol"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.resolve(catalog).replaceAll('\\','/'))}\nweb_search="disabled"\n[features]\nplugins=false\napps=false\n[model_providers.fixture]\nname="Local feature probe"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const environment={...process.env,CODEX_HOME:fixture,OTEL_SDK_DISABLED:'true',NO_PROXY:'127.0.0.1,localhost'};
for(const key of Object.keys(environment))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(key)||/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key))delete environment[key];
const child=spawn(path.resolve(executable),['app-server','--listen','stdio://','-c','features.fast_mode=true','-c','service_tier="fast"','-c','desktop.conversationDetailMode="STEPS_COMMANDS"'],{env:environment,cwd:fixture,windowsHide:true,stdio:['pipe','pipe','pipe']});
child.on('error',error=>{for(const p of pending.values())p.reject(error);pending.clear();});
child.on('exit',code=>{for(const p of pending.values())p.reject(Error('Codex exited at '+stage+' (code '+code+')'));pending.clear();});
child.stderr.on('data',chunk=>{stderr+=chunk;});
readline.createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}if(pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(Error(JSON.stringify(value.error))):p.resolve(value.result);}else notifications.push(value);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
let stage='initialize';
const timeout=setTimeout(()=>{child.kill();for(const p of pending.values())p.reject(Error('Probe timed out at '+stage));},45000);
try{
 await rpc('initialize',{clientInfo:{name:'forge_feature_probe',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 stage='config/read';const config=await rpc('config/read',{includeLayers:false});
 stage='thread/start';const result=await rpc('thread/start',{model,modelProvider:'fixture',cwd:fixture,approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
 stage='turn/start';await rpc('turn/start',{threadId:result.thread.id,input:[{type:'text',text:'Return OK. Do not use tools.'}]});
 const deadline=Date.now()+30000;while(!notifications.some(n=>n.method==='turn/completed')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 const usage=notifications.find(n=>n.method==='thread/tokenUsage/updated')?.params;
 const report={requests,usage,configuredFast:config.config?.features?.fast_mode,configuredTier:config.config?.service_tier,browserMode:config.config?.desktop?.conversationDetailMode,completed:notifications.some(n=>n.method==='turn/completed')};
 fs.writeFileSync(path.join(root,'output/fast-context-'+model.replace(/[^a-zA-Z0-9_.-]/g,'_')+'.json'),JSON.stringify(report,null,2));
 assert(report.completed,'Turn did not complete');assert.equal(requests.length,1);assert.equal(requests[0].service_tier,'priority');assert.equal(requests[0].model,model);assert.equal(requests[0].authorizationPresent,false);
 assert.equal(usage?.tokenUsage?.modelContextWindow,expectedWindow);assert.equal(report.browserMode,'STEPS_COMMANDS');
 console.log(JSON.stringify(report,null,2));
}finally{clearTimeout(timeout);child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(fixture,'stderr.log'),stderr);}
