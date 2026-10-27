'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomInt } = require('node:crypto');
const { normalizeModel } = require('./information-stats.cjs');
function prompt(count, language) {
  return language === 'zh' ?
    '直接选择 ' + count + ' 个 1 到 355（含边界）的整数。允许重复；不要排序、平衡频数、修复重复，也不要刻意构造等差规律。\n直接回答一个 JSON 整数数组，不要解释。不要调用工具、读文件、运行代码或让其他模型代答；不要继续之前的任务。' :
    'Directly choose ' + count + ' integers from 1 through 355, inclusive. Allow repeats. Do not sort, balance frequencies, repair duplicates, or deliberately create an arithmetic pattern.\nReply directly with one JSON integer array and no explanation. Do not call tools, read files, execute code or ask another model. Do not continue the preceding task.';
}
function verifyFork(response, context, checkSettings = true) {
  const fork=response?.thread;
  if (!fork?.ephemeral || !fork.id || fork.id === context.threadId || fork.path || fork.forkedFromId !== context.threadId) throw Error('客户端未创建可验证的临时分支，已停止检测');
  if (!checkSettings) return fork.id;
  const model=response.model || fork.model, provider=response.modelProvider || response.provider || fork.modelProvider || fork.provider;
  const effort=response.reasoningEffort ?? response.effort ?? fork.reasoningEffort ?? fork.effort;
  if (!model || normalizeModel(model)!==normalizeModel(context.model) || !provider || provider!==context.provider || context.effort && effort!=null && effort!==context.effort) throw Error('临时分支的模型设置无法确认或与当前对话不一致，已停止检测');
  return fork.id;
}
async function probeWithRpc({ call, subscribe, signal, onProgress, ...context }) {
  if (signal?.aborted) throw Error('检测已取消');
  const metadata=await call('thread/read',{threadId:context.threadId,includeTurns:false}), thread=metadata?.thread;
  if (thread?.id !== context.threadId || thread.ephemeral || !thread.path) throw Error('请先保存当前对话，再运行检测');
  if (thread.model && normalizeModel(thread.model) !== normalizeModel(context.model) || thread.modelProvider && thread.modelProvider !== context.provider) throw Error('当前模型设置已变化，请刷新后重试');
  const turns=await call('thread/turns/list',{threadId:context.threadId,limit:6,itemsView:'notLoaded',sortDirection:'desc'});
  const turn=turns?.data?.find(t=>t.id && ['completed','interrupted','failed'].includes(t.status));
  if (!turn) throw Error('请等待当前对话至少完成一个回合');
  const config={ 'features.shell_tool':false, 'features.apply_patch_freeform':false, 'features.multi_agent':false, 'features.apps':false,
    'features.code_mode':false, 'features.code_mode_host':false, 'features.plugins':false, web_search:'disabled' };
  const original=await call('config/read',{includeLayers:false});
  for (const name of Object.keys(original.config?.mcp_servers || {})) config['mcp_servers.'+name+'.enabled']=false;
  if (context.effort) config.model_reasoning_effort=context.effort;
  const outputs=[];
  for (let query=0;query<3;query++) {
    if (signal?.aborted) throw Error('检测已取消');
    const response=await call('thread/fork',{threadId:context.threadId,lastTurnId:turn.id,ephemeral:true,excludeTurns:true,
      model:context.model,modelProvider:context.provider,cwd:context.cwd,...(Object.keys(config).length?{config}:{})});
    verifyFork(response,context,false);
    const forkInfo=await call('thread/read',{threadId:response.thread.id,includeTurns:false});
    const forkResponse={...response,...forkInfo,thread:{...response?.thread,...forkInfo?.thread}};
    const id=verifyFork(forkResponse,context), n=randomInt(292,333);
    let turnId, ended=false, text='', other=[], rejectTurn, resolveTurn;
    const done=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;}); done.catch(()=>{});
    const fail=error=>{ if(!ended) {ended=true;rejectTurn(error);} };
    const abort=()=>fail(Error('检测已取消或检测进程已断开'));
    signal?.addEventListener('abort',abort,{once:true});
    const unsubscribe=subscribe(message=>{
      const p=message.params || {};
      if (p.threadId !== id || ended || turnId && p.turnId && p.turnId !== turnId) return;
      if (message.method === 'item/started' && !['userMessage','agentMessage','reasoning','hookPrompt'].includes(p.item?.type)) fail(Error('检测尝试调用工具，未接收此样本'));
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
        if (['final','final_answer'].includes(p.item.phase)) text=p.item.text || '';
        else if (!p.item.phase) other.push(p.item.text || '');
        if (text.length+other.reduce((n,s)=>n+s.length,0)>50000) fail(Error('检测回答过长'));
      }
      if (message.method === 'error' && !p.willRetry) fail(Error(p.error?.message || '检测推理失败'));
      if (message.method === 'turn/completed' && (!turnId || !p.turn?.id || p.turn.id===turnId)) {
        if (p.turn?.status !== 'completed') fail(Error('检测回合未成功结束'));
        else {ended=true;resolveTurn(text || other.join('\n'));}
      }
    });
    try {
      if (signal?.aborted) throw Error('检测已取消');
      const started=await call('turn/start',{threadId:id,input:[{type:'text',text:prompt(n,query%2 ? 'zh':'en')}]});
      turnId=started?.turn?.id;
      if (!turnId) throw Error('客户端未返回检测回合');
      const answer=await done;
      if (!answer) throw Error('检测未返回数字回答');
      outputs.push({text:answer,expected_count:n}); onProgress?.(outputs.length);
    } finally {
      ended=true; unsubscribe(); signal?.removeEventListener('abort',abort);
      if (turnId) await call('turn/interrupt',{threadId:id,turnId}).catch(()=>{});
      await call('thread/unsubscribe',{threadId:id}).catch(()=>{});
    }
  }
  return outputs;
}
async function runInformationProbe({ executable, timeoutMs=240000, signal, ...context }) {
  if (signal?.aborted) throw Error('检测已取消');
  const child=spawn(executable,['app-server','--listen','stdio://','-c','notify=[]','-c','features.hooks=false',...(process.env.CODEX_FORGE_MODEL_CATALOG ? ['-c','model_catalog_json='+JSON.stringify(process.env.CODEX_FORGE_MODEL_CATALOG)] : [])],
    {cwd:context.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env}});
  const pending=new Map(), listeners=new Set(), controller=new AbortController();
  let seq=0, finished=false, failed;
  const fail=error=>{failed ||= error;controller.abort();for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  const kill=()=>{fail(Error('检测已取消'));child.kill();};
  signal?.addEventListener('abort',kill,{once:true});
  child.on('error',fail);child.on('exit',code=>{if(!finished)fail(Error('检测进程已退出：'+code));});child.stdin.on('error',fail);child.stderr.resume();
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
    await call('initialize',{clientInfo:{name:'forge_information_stats',version:'0.2.4'},capabilities:{experimentalApi:true}});
    child.stdin.write('{"method":"initialized"}\n');
    return await probeWithRpc({call,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},signal:controller.signal,...context});
  } finally {
    finished=true;clearTimeout(deadline);signal?.removeEventListener('abort',kill);fail(Error('检测已结束'));lines.close();child.stdin.end();child.kill();
  }
}
module.exports={runInformationProbe,probeWithRpc,verifyFork,prompt};
