import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import vm from 'node:vm';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {patchNov09Metadata} from './native-nov09-main.mjs';

const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'output');
const exe=path.resolve(process.argv[2]||'');
assert(process.argv[2]&&fs.statSync(exe).isFile(),'Provide the verified current codex.exe');
const fixture=JSON.parse(fs.readFileSync(path.resolve(root,process.argv[3]||'tests/fixtures/native-metadata-nov09.json')));
fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(out,'metadata-fixture-'));
const requests=[],notifications=[],children=[];
const title='修复自动标题生成';
const server=http.createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  let body=Buffer.concat(chunks);
  if(req.headers['content-encoding']==='gzip')body=zlib.gunzipSync(body);
  if(req.headers['content-encoding']==='zstd')body=zlib.zstdDecompressSync(body);
  assert(!req.headers.authorization,'Fixture must not receive credentials');
  const data=JSON.parse(body);requests.push(data);
  const answer=JSON.stringify({title,description:'验证后台标题生成及会话更新'});
  const item={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_'+requests.length,object:'response',created_at:0,status:'completed',model:data.model,output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:answer},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const [sequence_number,event] of events.entries())res.write('event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number})+'\n\n');
  res.end();
 }catch(error){res.writeHead(500);res.end(error.message);}
});
let child,lines;
const pending=new Map();let seq=0,stderr='';
const call=(method,params)=>new Promise((resolve,reject)=>{
 const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout: '+method+' '+stderr.slice(-500)))},15000);
 pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
});
async function turn(threadId,outputSchema) {
 const initial=notifications.length;
 await call('turn/start',{threadId,input:[{type:'text',text:'Return a concise title and description for fixing automatic titles.'}],...(outputSchema?{outputSchema}:{}),effort:'low'});
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  const events=notifications.slice(initial).filter(n=>n.params?.threadId===threadId);
  const done=events.find(n=>n.method==='turn/completed');
  if(done){assert.equal(done.params.turn.status,'completed');return events.filter(n=>n.method==='item/completed'&&n.params.item.type==='agentMessage').map(n=>n.params.item.text).join('');}
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error('Turn timed out');
}
function generation(source) {
 return vm.runInNewContext('('+source+')',{
  dc:{safeParse:data=>({success:true,data})},e_:()=>{},
  ol:async options=>{
   const started=await call('thread/start',{model:'gpt-6-astra',modelProvider:'fixture',cwd:home,ephemeral:true,sandbox:'read-only',approvalPolicy:'never',threadSource:options.threadSource,
    config:{...options.config,'mcp_servers.codex_app':{enabled:false,command:''},model_reasoning_effort:options.effort}});
   assert.equal(started.thread.ephemeral,true);
   try{
    const answer=JSON.parse(await turn(started.thread.id,options.schema));
    const status=await call('mcpServerStatus/list',{threadId:started.thread.id});
    assert(!JSON.stringify(status).includes('fixture_echo'),'Metadata thread must keep MCP tools disabled');
    return answer;
   }
   finally{await call('thread/unsubscribe',{threadId:started.thread.id});}
  }
 });
}
try {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-6-astra"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nplugins=false\napps=false\nhooks=false\nshell_tool=false\napply_patch_freeform=false\nmulti_agent=false\n[model_providers.fixture]\nname="Local metadata fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
 const mcp=path.join(home,'mcp.cjs');
 fs.writeFileSync(mcp,`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id==null)return;const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'metadata-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'fixture_echo',description:'A fixture tool',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
 const env={...process.env,CODEX_HOME:home,OTEL_SDK_DISABLED:'true',NO_PROXY:'127.0.0.1,localhost'};
 for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(key)||/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key)||key.startsWith('CODEX_FORGE_'))delete env[key];
 child=spawn(exe,['app-server','--listen','stdio://','-c','mcp_servers.fast_canvas.command='+JSON.stringify(process.execPath),'-c','mcp_servers.fast_canvas.args='+JSON.stringify([mcp]),'-c','mcp_servers.fast_canvas.enabled=true'],{env,cwd:home,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);
 child.stderr.on('data',data=>{stderr=(stderr+data).slice(-6000)});
 child.on('error',error=>{for(const p of pending.values())p.reject(error)});
 lines=readline.createInterface({input:child.stdout});
 lines.on('line',line=>{let message;try{message=JSON.parse(line)}catch{return}const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}else notifications.push(message);});
 await call('initialize',{clientInfo:{name:'forge_metadata_regression',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
 const client={getUserSavedConfiguration:async()=> (await call('config/read',{includeLayers:false})).config};
 const options={appServerClient:client,model:'gpt-6-astra',cwd:home,feature:'thread_title',prompt:'Title fixture',outputSchema:{type:'object',properties:{title:{type:'string'},description:{type:'string'}},required:['title','description'],additionalProperties:false}};
 await assert.rejects(generation(fixture.source)(options),/invalid transport[\s\S]*mcp_servers.fast_canvas/);
 assert.equal(requests.length,0,'Broken path must fail before model inference');
 const generated=await generation(patchNov09Metadata(fixture.source))(options);
 assert.equal(generated.title,title);
 assert.equal(requests.length,1);
 assert(!JSON.stringify(requests[0]).includes('fixture_echo'),'Title task must not expose MCP tools');
 const regular=await call('thread/start',{model:'gpt-6-astra',modelProvider:'fixture',cwd:home,ephemeral:false,sandbox:'read-only',approvalPolicy:'never'});
 await turn(regular.thread.id);
 const mcpStatus=await call('mcpServerStatus/list',{threadId:regular.thread.id});
 assert(JSON.stringify(mcpStatus).includes('fixture_echo'),'Ordinary conversation must retain MCP tools');
 await call('thread/name/set',{threadId:regular.thread.id,name:generated.title});
 const saved=await call('thread/read',{threadId:regular.thread.id,includeTurns:false});assert.equal(saved.thread.name,title);
 assert(notifications.some(n=>n.method==='thread/name/updated'&&n.params.threadId===regular.thread.id&&n.params.threadName===title));
 await call('thread/unsubscribe',{threadId:regular.thread.id});
 const report={forgeVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,originalFailureReproduced:true,metadataGeneration:true,metadataMcpDisabled:true,ordinaryMcpRetained:true,titlePersisted:true,titleNotification:true,modelRequests:requests.length,provider:'localhost fixture',credentialsSent:false};
 fs.writeFileSync(path.join(out,'native-metadata-regression.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
 for(const process of children){const ended=new Promise(resolve=>process.once('exit',resolve));process.stdin.end();process.kill();await ended;}
 lines?.close();for(const p of pending.values())clearTimeout(p.timer);
 await new Promise(resolve=>server.close(resolve));server.closeAllConnections();
 const real=fs.realpathSync(home);assert(real.startsWith(fs.realpathSync(out)+path.sep)&&path.basename(real).startsWith('metadata-fixture-'));
 fs.rmSync(real,{recursive:true,force:true});
}
