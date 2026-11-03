'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomInt } = require('node:crypto');
const { normalizeModel } = require('./information-stats.cjs');
function prompt(count, language) {
  return language === 'zh' ?
    '直接选择 ' + count + ' 个 1 到 355（含边界）的整数。允许重复；不要排序、平衡频数、修复重复，也不要刻意构造等差规律。\n直接回答一个 JSON 整数数组，不要解释。不要调用工具、读文件、运行代码或让其他模型代答；不要继续之前的任务。' :
    'Directly choose ' + count + ' integers from 1 through 355, inclusive. Allow repeats. Do not sort, balance frequencies, repair duplicates, or deliberately create an arithmetic pattern.\nReply directly with one JSON integer array and no explanation. Do not call tools, read files, execute code or ask another model. Do not continue the preceding task.';
}
function verifyProbeThread(response, context) {
  const thread=response?.thread;
  if (thread?.ephemeral !== true || !thread.id || thread.id === context.threadId || thread.path || thread.forkedFromId) throw Error('客户端未创建可验证的临时检测会话，已停止检测');
  const model=response.model || thread.model, provider=response.modelProvider || response.provider || thread.modelProvider || thread.provider;
  const effort=response.reasoningEffort ?? response.effort ?? thread.reasoningEffort ?? thread.effort;
  if (!model || normalizeModel(model)!==normalizeModel(context.model) || !provider || provider!==context.provider || context.effort && effort!==context.effort) throw Error('临时检测会话的模型设置无法确认或与当前对话不一致，已停止检测');
  return thread.id;
}
const nonToolItems=new Set(['userMessage','agentMessage','reasoning','hookPrompt','plan','contextCompaction','enteredReviewMode','exitedReviewMode']);
async function probeWithRpc({ call, subscribe, signal, onProgress, ...context }) {
  if (signal?.aborted) throw Error('检测已取消');
  if (!context.probeCwd || !path.isAbsolute(context.probeCwd)) throw Error('缺少隔离检测目录');
  const metadata=await call('thread/read',{threadId:context.threadId,includeTurns:false}), thread=metadata?.thread;
  if (thread?.id !== context.threadId || thread.ephemeral || !thread.path) throw Error('请先保存当前对话，再运行检测');
  if (thread.model && normalizeModel(thread.model) !== normalizeModel(context.model) || thread.modelProvider && thread.modelProvider !== context.provider) throw Error('当前模型设置已变化，请刷新后重试');
  const config={ 'features.shell_tool':false, 'features.apply_patch_freeform':false, 'features.multi_agent':false, 'features.apps':false,
    'features.code_mode':false, 'features.code_mode_host':false, 'features.plugins':false, web_search:'disabled' };
  const original=await call('config/read',{includeLayers:false});
  for (const name of Object.keys(original.config?.mcp_servers || {})) config['mcp_servers.'+name+'.enabled']=false;
  if (context.effort) config.model_reasoning_effort=context.effort;
  const outputs=[];
  for (let query=0;query<3;query++) {
    if (signal?.aborted) throw Error('检测已取消');
    // A new thread leaves the current task history, project instructions and tools outside the probe context.
    const response=await call('thread/start',{ephemeral:true,model:context.model,modelProvider:context.provider,cwd:context.probeCwd,
      sandbox:'read-only',approvalPolicy:'never',developerInstructions:'Perform only the isolated number-sampling request. Do not use tools, MCP, files, shell, delegated agents, web access, or other capabilities. Return the requested integer JSON array directly.',
      ...(Object.keys(config).length?{config}:{})});
    const id=response?.thread?.id;
    const ownProbe=response?.thread?.ephemeral === true && typeof id === 'string' && id && id !== context.threadId;
    let turnId, ended=false, completed=false, text='', other=[], rejectTurn, resolveTurn, unsubscribe;
    const done=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;}); done.catch(()=>{});
    const fail=error=>{ if(!ended) {ended=true;rejectTurn(error);} };
    const abort=()=>fail(Error('检测已取消或检测进程已断开'));
    try {
      verifyProbeThread(response,context);
      if (signal?.aborted) throw Error('检测已取消');
      const n=randomInt(292,333);
      signal?.addEventListener('abort',abort,{once:true});
      unsubscribe=subscribe(message=>{
        const p=message.params || {};
        if (p.threadId !== id || ended || turnId && p.turnId && p.turnId !== turnId) return;
        if (['item/started','item/completed'].includes(message.method) && !nonToolItems.has(p.item?.type)) {
          fail(Error('检测尝试调用工具或返回不支持的项目，未接收此样本'));
          return;
        }
        if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
          if (['final','final_answer'].includes(p.item.phase)) text=p.item.text || '';
          else if (!p.item.phase) other.push(p.item.text || '');
          if (text.length+other.reduce((n,s)=>n+s.length,0)>50000) fail(Error('检测回答过长'));
        }
        if (message.method === 'error' && !p.willRetry) fail(Error(p.error?.message || '检测推理失败'));
        if (message.method === 'turn/completed' && (!turnId || !p.turn?.id || p.turn.id===turnId)) {
          if (p.turn?.status !== 'completed') fail(Error('检测回合未成功结束'));
          else {ended=true;completed=true;resolveTurn(text || other.join('\n'));}
        }
      });
      if (signal?.aborted) throw Error('检测已取消');
      const started=await call('turn/start',{threadId:id,input:[{type:'text',text:prompt(n,query%2 ? 'zh':'en')}]});
      turnId=started?.turn?.id;
      if (!turnId) throw Error('客户端未返回检测回合');
      const answer=await done;
      if (!answer) throw Error('检测未返回数字回答');
      outputs.push({text:answer,expected_count:n}); onProgress?.(outputs.length);
    } finally {
      ended=true; unsubscribe?.(); signal?.removeEventListener('abort',abort);
      if (ownProbe) {
        if (turnId && !completed) await call('turn/interrupt',{threadId:id,turnId}).catch(()=>{});
        await call('thread/unsubscribe',{threadId:id}).catch(()=>{});
      }
    }
  }
  return outputs;
}
async function runInformationProbe({ executable, timeoutMs=240000, signal, ...context }) {
  if (signal?.aborted) throw Error('检测已取消');
  const probeCwd=fs.mkdtempSync(path.join(os.tmpdir(),'codex-forge-fingerprint-'));
  let child;
  try {
    child=spawn(executable,['app-server','--listen','stdio://','-c','notify=[]','-c','features.hooks=false',...(process.env.CODEX_FORGE_MODEL_CATALOG ? ['-c','model_catalog_json='+JSON.stringify(process.env.CODEX_FORGE_MODEL_CATALOG)] : [])],
      {cwd:probeCwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env}});
  } catch (error) {
    await fs.promises.rm(probeCwd,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const pending=new Map(), listeners=new Set(), controller=new AbortController();
  let seq=0, finished=false, failed='';
  const fail=error=>{failed ||= error;controller.abort();for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  const kill=()=>{fail(Error('检测已取消'));child.kill();};
  signal?.addEventListener('abort',kill,{once:true});
  child.on('error',error=>fail(error));child.on('exit',code=>{if(!finished)fail(Error('检测进程已退出：'+code));});child.stdin.on('error',fail);
  // Do not copy subprocess stderr (which may contain local configuration) into UI errors.
  child.stderr.resume();
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{
    if(line.length>4*1024*1024){fail(Error('检测协议消息过长'));child.kill();return;}
    let value;try{value=JSON.parse(line);}catch{return;}
    if(!value || typeof value!=='object')return;
    if(value.id!=null && value.method){
      child.stdin.write(JSON.stringify({id:value.id,error:{code:-32601,message:'Fingerprint probe cannot use tools, permissions or user input'}})+'\n');
      fail(Error('检测请求了工具或权限，已停止检测'));child.kill();return;
    }
    const waiting=pending.get(value.id);
    if(waiting){clearTimeout(waiting.timer);pending.delete(value.id);value.error?waiting.reject(Error(value.error.message || '检测接口失败')):waiting.resolve(value.result);}
    else for(const listener of listeners)listener(value);
  });
  const call=(method,params)=>new Promise((resolve,reject)=>{
    if(failed || finished || child.exitCode!==null || child.stdin.destroyed){reject(failed || Error('检测进程已结束'));return;}
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('检测接口超时：'+method));},45000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const deadline=setTimeout(()=>{fail(Error('检测超时，请稍后重试'));child.kill();},timeoutMs);
  try {
    if(signal?.aborted)throw Error('检测已取消');
    await call('initialize',{clientInfo:{name:'forge_information_stats',version:'0.3.3'},capabilities:{experimentalApi:true}});
    child.stdin.write('{"method":"initialized"}\n');
    return await probeWithRpc({...context,call,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},signal:controller.signal,probeCwd});
  } finally {
    finished=true;clearTimeout(deadline);signal?.removeEventListener('abort',kill);fail(Error('检测已结束'));lines.close();
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill();
    let exitTimer;
    try { await Promise.race([exited,new Promise(resolve=>{exitTimer=setTimeout(resolve,1000);})]); }
    finally { clearTimeout(exitTimer); }
    // Windows can retain the child's cwd briefly after kill. Cleanup must never
    // replace the original probe error or discard an otherwise valid result.
    await fs.promises.rm(probeCwd,{recursive:true,force:true,maxRetries:5,retryDelay:50}).catch(()=>{});
  }
}
module.exports={runInformationProbe,probeWithRpc,verifyFork:verifyProbeThread,verifyProbeThread,prompt};
