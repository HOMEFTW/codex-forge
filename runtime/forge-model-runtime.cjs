'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline');
const {spawn}=require('node:child_process');
const {ForgeError}=require('./forge-errors.cjs');
function need(value,message){if(!value)throw new ForgeError('INVALID_ARGUMENT',message);}
class ForgeNativeModels {
  constructor({executable,env=process.env,spawnImpl=spawn}={}){this.executable=executable;this.env=env;this.spawnImpl=spawnImpl;}
  async *stream(args,context,{signal}={}){
    need(Object.keys(args).every(key=>['prompt','provider','model','effort','timeoutMs','outputSchema'].includes(key)),'原生模型接口包含未支持的参数；提供方自定义参数请使用已注册适配器');
    need(typeof args.prompt==='string'&&args.prompt.trim()&&args.prompt.length<=200000,'模型提示词无效');
    need(typeof context.model==='string'&&typeof context.provider==='string','当前模型服务不可用');
    const effort=args.effort||context.effort||'low';need(['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort),'思考强度无效');
    const timeoutMs=args.timeoutMs??120000;need(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=600000,'模型超时无效');
    const model=args.model||context.model;need(typeof model==='string'&&model.length>0&&model.length<=200,'模型 ID 无效');
    if(signal?.aborted)throw new ForgeError('CANCELLED','模型调用已取消');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-sample-')),queue=[],pending=new Map(),early=[];let child,lines,wake,sequence=0,threadId,turnId,ended=false,error,seenDelta=false,textBytes=0,totalBytes=0;
    const controller=new AbortController();
    const abort=()=>fail(signal?.reason instanceof ForgeError?signal.reason:new ForgeError('CANCELLED','模型调用已取消'));
    const fail=value=>{error||=value;ended=true;controller.abort(error);for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();child?.kill();wake?.();};
    const push=value=>{const bytes=Buffer.byteLength(JSON.stringify(value));textBytes+=bytes;totalBytes+=bytes;if(queue.length>=128||totalBytes>2*1024*1024)return fail(new ForgeError('RESOURCE_EXHAUSTED','模型输出超过限制'));queue.push(value);wake?.();};
    const notification=message=>{
      const p=message.params||{};if(p.threadId!==threadId||turnId&&p.turnId&&p.turnId!==turnId)return;
      if(!turnId){if(early.length>=128)return fail(new ForgeError('RESOURCE_EXHAUSTED','模型启动事件过多'));early.push(message);return;}
      if(['item/started','item/completed'].includes(message.method)&&p.item&&!['userMessage','agentMessage','reasoning','contextCompaction'].includes(p.item.type))return fail(new ForgeError('PERMISSION_DENIED','采样尝试执行工具，已停止'));
      if(message.method==='rawResponseItem/completed'&&/_call(?:_output)?$/.test(p.item?.type||''))return fail(new ForgeError('PERMISSION_DENIED','采样尝试执行工具，已停止'));
      if(message.method==='item/agentMessage/delta'){seenDelta=true;push({type:'text',text:String(p.delta||'')});}
      else if(message.method==='item/completed'&&p.item?.type==='agentMessage'&&!seenDelta)push({type:'text',text:p.item.text||''});
      else if(message.method==='thread/tokenUsage/updated')push({type:'usage',usage:p.tokenUsage});
      else if(message.method==='error'&&!p.willRetry)fail(new ForgeError('MODEL_ERROR','模型推理失败'));
      else if(message.method==='turn/completed'){if(p.turn?.id&&p.turn.id!==turnId)return;if(p.turn?.status!=='completed')fail(new ForgeError('MODEL_ERROR','模型回合未成功完成'));else{ended=true;wake?.();}}
    };
    const timer=setTimeout(()=>fail(new ForgeError('TIMEOUT','模型调用超时')),timeoutMs);timer.unref?.();
    try{
      signal?.throwIfAborted();
      child=this.spawnImpl(this.executable,['app-server','--listen','stdio://','-c','notify=[]','-c','features.hooks=false',...(this.env.CODEX_FORGE_MODEL_CATALOG?['-c','model_catalog_json='+JSON.stringify(this.env.CODEX_FORGE_MODEL_CATALOG)]:[])],{cwd:directory,env:{...this.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      child.on('error',()=>fail(new ForgeError('CAPABILITY_UNAVAILABLE','模型后端启动失败')));child.on('exit',()=>{if(!ended)fail(new ForgeError('BACKEND_EXITED','模型后端提前退出'));});child.stdin.on('error',()=>fail(new ForgeError('BACKEND_EXITED','模型连接已关闭')));child.stderr.resume();
      signal?.addEventListener('abort',abort,{once:true});
      lines=readline.createInterface({input:child.stdout});
      lines.on('line',line=>{
        if(line.length>4*1024*1024)return fail(new ForgeError('RESOURCE_EXHAUSTED','模型协议消息过长'));
        let message;try{message=JSON.parse(line);}catch{return;}
        if(message.id!=null&&message.method)return fail(new ForgeError('PERMISSION_DENIED','采样不允许工具或权限请求'));
        const waiting=pending.get(message.id);if(waiting){clearTimeout(waiting.timer);pending.delete(message.id);message.error?waiting.reject(new ForgeError('MODEL_ERROR',String(message.error.message||'模型请求失败').slice(0,500))):waiting.resolve(message.result);return;}
        notification(message);
      });
      const call=(method,params)=>new Promise((resolve,reject)=>{if(error||controller.signal.aborted)return reject(error||controller.signal.reason);const id=++sequence,deadline=setTimeout(()=>fail(new ForgeError('TIMEOUT','模型协议调用超时')),15000);pending.set(id,{resolve,reject,timer:deadline});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
      await call('initialize',{clientInfo:{name:'codex_forge_api5',version:'0.7.0'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
      const original=await call('config/read',{includeLayers:false}),config={model_reasoning_effort:effort,web_search:'disabled'};
      for(const name of ['shell_tool','unified_exec','multi_agent','apps','code_mode','code_mode_host','plugins','hooks','computer_use','browser_use','browser_use_external','skill_search','sleep_tool','goals','workspace_dependencies','view_image'])config['features.'+name]=false;
      config['features.skip_host_skill_discovery']=true;
      for(const name of Object.keys(original.config?.mcp_servers||{})){need(/^[A-Za-z0-9_-]{1,100}$/.test(name),'无法关闭未识别的 MCP 服务');config['mcp_servers.'+name+'.enabled']=false;}
      const instructions='Return the requested answer as text. Do not use tools, shell, files, network tools, or delegated agents.';
      const created=await call('thread/start',{model,modelProvider:context.provider,allowProviderModelFallback:false,ephemeral:true,experimentalRawEvents:true,cwd:directory,sandbox:'read-only',approvalPolicy:'never',approvalsReviewer:'user',environments:[],dynamicTools:[],config,baseInstructions:instructions,developerInstructions:instructions,threadSource:'forge_api5_sample'});
      threadId=created?.thread?.id;need(threadId&&created.thread.ephemeral===true&&!created.thread.path&&threadId!==context.threadId&&created.modelProvider===context.provider&&created.model===model,'无法确认独立模型采样上下文');
      const started=await call('turn/start',{threadId,effort,environments:[],input:[{type:'text',text:args.prompt}],turnTrigger:'forge_api5_sample',...(args.outputSchema?{outputSchema:args.outputSchema}:{})});turnId=started?.turn?.id;need(turnId,'模型回合尚未就绪');for(const event of early.splice(0))notification(event);
      while(!ended||queue.length){if(queue.length){const item=queue.shift();textBytes-=Buffer.byteLength(JSON.stringify(item));yield item;}else await new Promise(resolve=>{wake=resolve;});}
      if(error)throw error;
    }finally{
      ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();for(const item of pending.values()){clearTimeout(item.timer);item.reject(new ForgeError('CANCELLED','模型调用已结束'));}pending.clear();lines?.close();child?.stdin?.destroy();child?.stdout?.destroy();child?.stderr?.destroy();child?.kill();
      if(child&&child.exitCode===null)await new Promise(resolve=>{const deadline=setTimeout(resolve,1000);child.once('exit',()=>{clearTimeout(deadline);resolve();});});
      const absolute=path.resolve(directory),base=path.resolve(os.tmpdir());if(absolute.startsWith(base+path.sep)&&path.basename(absolute).startsWith('forge-api5-sample-'))await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50}).catch(()=>{});
    }
  }
  async sample(args,context,options){let text='',usage;for await(const item of this.stream(args,context,options)){if(item.type==='text')text+=item.text;if(item.type==='usage')usage=item.usage;}return {text,...(usage?{usage}:{})};}
}
module.exports={ForgeNativeModels};
