'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {ForgeError}=require('./forge-errors.cjs');
const {atomic,json}=require('./collaboration-store.cjs');
const fail=(code,message)=>{throw new ForgeError(code,message);};
const need=(value,message,code='INVALID_ARGUMENT')=>{if(!value)fail(code,message);};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES=8*1024*1024;
function key(value){need(typeof value==='string'&&/^[A-Za-z][\w.-]{0,99}$/.test(value),'名称无效');return value;}
function identity(stat){return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;}
class ForgeIO {
  constructor({root,encrypt,decrypt,fetchImpl=globalThis.fetch}={}){this.root=root;this.encrypt=encrypt;this.decrypt=decrypt;this.fetchImpl=fetchImpl;this.rootsFile=path.join(root,'api5-file-roots.json');this.secretFile=path.join(root,'api5-credentials.json');}
  connect(pluginId,directory){
    const absolute=fs.realpathSync(directory),stat=fs.statSync(absolute);need(stat.isDirectory(),'请选择目录');
    const roots=json(this.rootsFile,{}),id=crypto.randomUUID();(roots[pluginId]||={})[id]={path:absolute,identity:identity(stat)};atomic(this.rootsFile,roots);return {id,path:absolute};
  }
  roots(pluginId){return Object.entries(json(this.rootsFile,{})[pluginId]||{}).map(([id,value])=>({id,path:value.path}));}
  resolve(pluginId,args,context,{missing=false}={}){
    const saved=args.root?json(this.rootsFile,{})[pluginId]?.[args.root]:null;
    need(!args.root||saved,'目录未连接','PERMISSION_DENIED');
    const base=saved?.path||context.cwd;need(typeof base==='string'&&path.isAbsolute(base),'当前对话尚未绑定工作目录','CAPABILITY_UNAVAILABLE');
    const root=fs.realpathSync(base),rootStat=fs.statSync(root);need(!saved||root===saved.path&&identity(rootStat)===saved.identity,'连接目录身份已变化','PERMISSION_DENIED');
    const relative=args.path??'';need(typeof relative==='string'&&relative.length<=2000&&!path.isAbsolute(relative)&&!/[\x00-\x1f:]/.test(relative),'仅支持目录内相对路径');
    const parts=relative.split(/[\\/]/).filter(Boolean);need(parts.every(p=>p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(p)),'文件路径无效');
    let target=root;
    for(let index=0;index<parts.length;index++){
      target=path.join(target,parts[index]);
      try{const stat=fs.lstatSync(target);need(!stat.isSymbolicLink(),'不允许通过目录链接访问文件','PERMISSION_DENIED');if(index<parts.length-1)need(stat.isDirectory(),'父目录不存在');}
      catch(error){if(error.code==='ENOENT'&&missing&&index===parts.length-1)break;throw error;}
    }
    need(target===root||target.startsWith(root+path.sep),'文件越出连接目录','PERMISSION_DENIED');
    return {root,target,rootIdentity:identity(rootStat)};
  }
  readTarget(target){const stat=fs.lstatSync(target);need(stat.isFile()&&!stat.isSymbolicLink(),'仅支持普通文件');need(stat.size<=MAX_BYTES,'文件超过 8 MiB');const bytes=fs.readFileSync(target);need(bytes.length<=MAX_BYTES,'文件超过 8 MiB');return {bytes,revision:digest(bytes),identity:identity(stat)};}
  files(pluginId,method,args,context){
    if(method==='roots')return this.roots(pluginId);
    if(method==='restore'){need(typeof args.restoreToken==='string'&&/^[a-f0-9-]{36}$/.test(args.restoreToken),'恢复标记无效');const file=path.join(this.root,'file-trash',pluginId,args.restoreToken),bytes=fs.readFileSync(file);need(bytes.length<=MAX_BYTES,'恢复文件过大');const result=this.files(pluginId,'write',{...args,content:bytes.toString('base64'),encoding:'base64',expectedRevision:''},context);fs.unlinkSync(file);return result;}
    if(method==='disconnect'){const roots=json(this.rootsFile,{});need(roots[pluginId]?.[args.root],'目录未连接');delete roots[pluginId][args.root];atomic(this.rootsFile,roots);return {removed:true};}
    const location=this.resolve(pluginId,args,context,{missing:method==='write'}),{target}=location;
    if(method==='list'){need(fs.statSync(target).isDirectory(),'此路径不是目录');const items=fs.readdirSync(target,{withFileTypes:true});return {items:items.slice(0,1000).map(item=>({name:item.name,directory:item.isDirectory(),link:item.isSymbolicLink()})),truncated:items.length>1000};}
    if(method==='stat'){const stat=fs.lstatSync(target);return {directory:stat.isDirectory(),bytes:stat.size,modifiedAt:stat.mtime.toISOString()};}
    if(method==='read'){const result=this.readTarget(target),encoding=args.encoding||'utf8';need(['utf8','base64'].includes(encoding),'编码无效');return {content:result.bytes.toString(encoding),encoding,bytes:result.bytes.length,revision:result.revision};}
    need(target!==location.root,'不允许修改连接目录本身');
    if(method==='write'){
      need(typeof args.expectedRevision==='string','写入需要 expectedRevision');need(typeof args.content==='string'&&args.content.length<=MAX_BYTES*2,'文件内容无效');
      const encoding=args.encoding||'utf8';need(['utf8','base64'].includes(encoding),'编码无效');
      if(encoding==='base64')need(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.content),'Base64 内容无效');
      const bytes=Buffer.from(args.content,encoding);need(bytes.length<=MAX_BYTES,'文件超过 8 MiB');
      let before;try{before=this.readTarget(target);}catch(error){if(error.code!=='ENOENT')throw error;}
      need((before?.revision||'')===args.expectedRevision,'文件已变化，请重新读取并合并','REVISION_CONFLICT');
      const temp=path.join(path.dirname(target),'.forge-write-'+crypto.randomUUID());
      try{
        fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});const checked=this.resolve(pluginId,args,context,{missing:!before});need(checked.target===target&&checked.rootIdentity===location.rootIdentity,'目录身份变化','PERMISSION_DENIED');
        if(before){const current=this.readTarget(target);need(current.revision===before.revision&&current.identity===before.identity,'文件已变化','REVISION_CONFLICT');fs.renameSync(temp,target);}
        else{try{fs.linkSync(temp,target);}catch(error){if(error.code==='EEXIST')fail('REVISION_CONFLICT','文件已创建，请重新读取');throw error;}}
      }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
      return {revision:digest(bytes),bytes:bytes.length};
    }
    if(method==='remove'||method==='rename'){
      const before=this.readTarget(target);need(before.revision===args.expectedRevision,'文件已变化','REVISION_CONFLICT');
      if(method==='rename'){
        const destination=this.resolve(pluginId,{...args,path:args.destination},context,{missing:true}).target;need(!fs.existsSync(destination),'目标已存在','REVISION_CONFLICT');
        const current=this.readTarget(target);need(current.revision===before.revision&&current.identity===before.identity,'文件已变化','REVISION_CONFLICT');fs.linkSync(target,destination);fs.unlinkSync(target);return {renamed:true,revision:before.revision};
      }
      const trash=path.join(this.root,'file-trash',pluginId);fs.mkdirSync(trash,{recursive:true});const restoreToken=crypto.randomUUID();fs.writeFileSync(path.join(trash,restoreToken),before.bytes,{flag:'wx',mode:0o600});
      const current=this.readTarget(target);need(current.revision===before.revision&&current.identity===before.identity,'文件已变化','REVISION_CONFLICT');fs.unlinkSync(target);return {removed:true,restoreToken};
    }
    fail('METHOD_NOT_FOUND','不支持的文件操作');
  }
  watch(pluginId,args,context,signal){
    const location=this.resolve(pluginId,args,context),queue=[];let wake,stopped=false,failure;
    const stop=()=>{if(stopped)return;stopped=true;watcher.close();wake?.();};
    const watcher=fs.watch(location.target,(_event,name)=>{try{const current=this.resolve(pluginId,args,context);need(current.rootIdentity===location.rootIdentity,'目录身份变化','PERMISSION_DENIED');if(queue.length>=64)fail('RESOURCE_EXHAUSTED','文件事件队列已满');queue.push({type:_event,name:String(name||'')});wake?.();}catch(error){failure=error;stop();}});
    watcher.on('error',error=>{failure=error;stop();});signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    return {async *[Symbol.asyncIterator](){try{while(!stopped||queue.length){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;});}if(failure)throw failure;}finally{signal?.removeEventListener('abort',stop);stop();}},return:async()=>{stop();return {done:true};}};
  }
  credential(pluginId,method,args){
    key(args.name);const all=json(this.secretFile,{}),namespace=all[pluginId]||{};
    if(method==='describe')return {name:args.name,configured:Object.hasOwn(namespace,args.name)};
    if(method==='delete'){delete namespace[args.name];all[pluginId]=namespace;atomic(this.secretFile,all);return {removed:true};}
    need(typeof args.value==='string'&&args.value.length>0&&args.value.length<=16384,'凭据值无效');need(typeof this.encrypt==='function','系统凭据加密不可用','CAPABILITY_UNAVAILABLE');
    namespace[args.name]=Buffer.from(this.encrypt(args.value)).toString('base64');all[pluginId]=namespace;atomic(this.secretFile,all);return {name:args.name,configured:true};
  }
  secret(pluginId,name){key(name);const encoded=json(this.secretFile,{})[pluginId]?.[name];need(encoded&&typeof this.decrypt==='function','凭据未配置或系统解密不可用','CAPABILITY_UNAVAILABLE');return this.decrypt(Buffer.from(encoded,'base64'));}
  async fetch(pluginId,manifest,args,{signal}={}){
    const url=new URL(args.url);need(url.protocol==='https:'&&!url.username&&!url.password&&manifest.networkOrigins?.includes(url.origin),'请求地址未在插件 networkOrigins 中声明','PERMISSION_DENIED');
    const method=args.method||'GET';need(['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method),'HTTP 方法无效');
    need(args.body===undefined||typeof args.body==='string'&&Buffer.byteLength(args.body)<=MAX_BYTES,'请求体过大');
    const headers=new Headers(args.headers||{});for(const name of ['host','connection','cookie','proxy-authorization'])need(!headers.has(name),'请求包含不支持的头');
    if(args.credential)headers.set('authorization','Bearer '+this.secret(pluginId,args.credential));
    const response=await this.fetchImpl(url,{method,headers,body:args.body,signal,redirect:'error'}),chunks=[];let count=0;
    for await(const chunk of response.body||[]){count+=chunk.length;if(count>MAX_BYTES){await response.body.cancel?.().catch(()=>{});fail('RESOURCE_EXHAUSTED','响应超过 8 MiB');}chunks.push(Buffer.from(chunk));}
    const bytes=Buffer.concat(chunks),encoding=args.encoding||'utf8';need(['utf8','base64'].includes(encoding),'编码无效');
    return {status:response.status,headers:Object.fromEntries(['content-type','etag','last-modified','cache-control'].flatMap(name=>response.headers.has(name)?[[name,response.headers.get(name)]]:[])),body:bytes.toString(encoding),encoding,bytes:bytes.length};
  }
  shell(args,context,{signal}={}){
    need(typeof context.cwd==='string'&&path.isAbsolute(context.cwd),'当前对话没有工作目录','CAPABILITY_UNAVAILABLE');
    need(typeof args.executable==='string'&&args.executable.length>0&&args.executable.length<=2000&&!/[\r\n\0]/.test(args.executable),'可执行程序无效');
    need(args.args===undefined||Array.isArray(args.args)&&args.args.length<=200&&args.args.every(arg=>typeof arg==='string'&&arg.length<=100000&&!arg.includes('\0')),'程序参数无效');
    const timeoutMs=args.timeoutMs??60000;need(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=3600000,'超时时间无效');
    return new Promise((resolve,reject)=>{
      let child,ended=false,size=0,reason;const stdout=[],stderr=[];
      const stop=()=>{reason||=signal?.reason instanceof ForgeError?signal.reason:new ForgeError('CANCELLED','程序已取消');if(!child?.pid)return;if(process.platform==='win32'){execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:1000},()=>{if(child.exitCode===null)child.kill('SIGKILL');});const fallback=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},100);fallback.unref?.();}else child.kill('SIGKILL');};
      const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{reason=new ForgeError('TIMEOUT','程序运行超时');stop();},timeoutMs);
      if(signal?.aborted){finish(signal.reason||new ForgeError('CANCELLED','程序已取消'));return;}
      try{child=spawn(args.executable,args.args||[],{cwd:fs.realpathSync(context.cwd),windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});}catch(error){finish(error);return;}
      signal?.addEventListener('abort',stop,{once:true});
      const collect=(chunks,chunk)=>{size+=chunk.length;if(size>2*1024*1024){reason=new ForgeError('RESOURCE_EXHAUSTED','程序输出超过 2 MiB');stop();}else chunks.push(chunk);};
      child.stdout.on('data',chunk=>collect(stdout,chunk));child.stderr.on('data',chunk=>collect(stderr,chunk));
      child.once('error',error=>finish(error));child.once('close',(code,termination)=>finish(reason,{code,signal:termination,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));
    });
  }
}
module.exports={ForgeIO,MAX_BYTES};
