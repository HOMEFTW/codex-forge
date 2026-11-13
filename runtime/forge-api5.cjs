'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ForgeError}=require('./forge-errors.cjs');
const {atomic,json}=require('./collaboration-store.cjs');
const {ForgeRPC}=require('./forge-rpc.cjs');
const {ForgeIO}=require('./forge-api5-io.cjs');
const {ForgeMarketplace}=require('./forge-plugin-market.cjs');
const {ForgeNativeModels}=require('./forge-model-runtime.cjs');
const contract=require('./forge-api5-contract.cjs');
const {granted}=require('./forge-capabilities.cjs');
const need=(value,message,code='INVALID_ARGUMENT')=>{if(!value)throw new ForgeError(code,message);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value){need(value&&typeof value==='object'&&!Array.isArray(value),'参数必须为对象');return value;}
const copy=value=>JSON.parse(JSON.stringify(value));
const currentMethods=new Set(['conversation.read','conversation.fork','conversation.send','conversation.cancel','conversation.events','conversation.create','llm.sample','llm.stream','todos.request','statistics.request','collaboration.request','tools.call','shell.execute','jobs.request','schedules.request','backend.call','backend.channel','services.request','services.channel','files.watch']);
class ForgeAPI5 {
  constructor({registry,services={},root=registry.root,nativeCall,contextFor,notify=()=>{},changed=()=>{},states=new Map(),dialog,open,executable,nodePath,safeStorage,fetchImpl,backendManager,taskRuntime}={}){
    Object.assign(this,{registry,services,root,nativeCall,contextFor,notify,changed,states,dialog,open});
    this.rpc=new ForgeRPC({maxBytes:16*1024*1024,timeoutMs:600000});this.frames=new Map();this.owners=new Map();this.events=new Set();this.nativeHooks=new Map();this.eventSequence=0;this.toolViews=new Map();this.ui={themes:new Map(),shortcuts:new Map()};
    this.io=new ForgeIO({root,fetchImpl,encrypt:safeStorage?.isEncryptionAvailable?.()?value=>safeStorage.encryptString(value):undefined,decrypt:safeStorage?.isEncryptionAvailable?.()?value=>safeStorage.decryptString(value):undefined});
    this.market=new ForgeMarketplace({registry,root,fetchImpl});this.models=new ForgeNativeModels({executable});
    const {ForgeBackendManager}=require('./forge-backends.cjs'),{ForgeTaskRuntime}=require('./forge-runtime-tasks.cjs');
    this.backends=backendManager||new ForgeBackendManager({registry,root,nodePath,request:(id,method,args,context,options)=>this.backendRequest(id,method,args,context,options),onEvent:event=>this.backendEvent(event)});
    this.tasks=taskRuntime||new ForgeTaskRuntime({root:path.join(root,'tasks'),isEnabled:id=>this.registry.status(id).enabled,execute:async({pluginId,method,args,context,signal})=>{this.permission(pluginId,'jobs.manage');const entry=this.registry.get(pluginId);need(entry.manifest.contributes?.jobs?.some(job=>(job.method||job.name)===method),'任务方法未声明','PERMISSION_DENIED');return this.backends.call(pluginId,method,args,{...context,backgroundTask:true},{signal});},onEvent:event=>this.backendEvent(event)});
    if(services.toolContext){this.broker=new(require('./forge-api5-broker.cjs').ForgePluginBroker)({root,tools:()=>this.backends.tools(),callTool:(name,args,context,options)=>this.callTool(name,args,context,options),contextFor:services.toolContext});this.brokerReady=this.broker.start().catch(error=>this.logHostError(error));}
    this.sync().catch(error=>this.logHostError(error));
  }
  logHostError(error){console.error('[Forge API5]',error.code||'INTERNAL_ERROR',String(error.message).slice(0,500));}
  permission(id,...permissions){let entry;for(const permission of permissions)entry=this.registry.permission(id,permission);return entry||this.registry.get(id);}
  backendContext(context){return Object.fromEntries(['threadId','cwd','windowId','generation','pluginId','channelId','backendDepth','backgroundTask'].filter(key=>context[key]!==undefined).map(key=>[key,context[key]]));}
  backendRequest(id,method,args,context,options){const candidate=[...this.states.values()].find(item=>item.win.webContents.id===context.windowId),current=candidate&&this.contextFor({sender:candidate.win.webContents},candidate),state=current?.threadId===context.threadId&&(candidate?.api5Generation||0)===context.generation?candidate:undefined;if(context.windowId!==undefined&&!context.backgroundTask)need(state,'后端请求上下文已变化或窗口已关闭','STALE_CONTEXT');return this.dispatch(id,method,args,{...context,state},options);}
  available(service){need(this.services[service],'宿主服务不可用：'+service,'CAPABILITY_UNAVAILABLE');return this.services[service];}
  registerFrame(event,{id,frameToken,fingerprint}){
    const entry=this.registry.get(id);need(typeof frameToken==='string'&&/^[\w-]{16,100}$/.test(frameToken)&&entry.fingerprint===fingerprint,'插件 frame 身份无效','PERMISSION_DENIED');
    need(this.frames.size<2000||this.frames.has(frameToken),'插件 frame 数量超限','RESOURCE_EXHAUSTED');this.frames.set(frameToken,{id,fingerprint,windowId:event.sender.id});return true;
  }
  disposeFrame(event,frameToken){const frame=this.frames.get(frameToken);if(!frame||frame.windowId!==event.sender.id)return false;this.frames.delete(frameToken);for(const [owner,value]of this.owners)if(value.frameToken===frameToken){this.rpc.disposeOwner(owner);this.owners.delete(owner);}return true;}
  context(event,state,request){
    const context=this.contextFor(event,state),frame=this.frames.get(request.frameToken),entry=this.registry.get(request.id);
    need(frame&&frame.id===request.id&&frame.windowId===event.sender.id&&frame.fingerprint===entry.fingerprint,'插件 frame 已失效','PERMISSION_DENIED');
    state.api5Thread??=context.threadId;if(state.api5Thread!==context.threadId){this.invalidateWindow(state);state.api5Thread=context.threadId;}
    const generation=state.api5Generation||0,owner=JSON.stringify([event.sender.id,request.id,entry.fingerprint,request.frameToken,context.threadId,generation]);
    this.owners.set(owner,{id:request.id,frameToken:request.frameToken,windowId:event.sender.id,threadId:context.threadId,generation});
    return {...context,windowId:event.sender.id,generation,owner,source:'plugin',trusted:false,pluginId:request.id,state};
  }
  invalidateWindow(state){state.api5Generation=(state.api5Generation||0)+1;for(const [key,value]of this.nativeHooks)if(value.context.windowId===state.win.webContents.id){clearTimeout(value.timer);value.controller.abort();this.nativeHooks.delete(key);}for(const [owner,value]of this.owners)if(value.windowId===state.win.webContents.id){this.rpc.disposeOwner(owner);this.owners.delete(owner);}for(const subscription of this.events)if(subscription.windowId===state.win.webContents.id)subscription.close();}
  async prepareNativeSend(state,request,context){
    if(!['turn/start','turn/steer','turn/addUserMessage'].includes(request?.method)||!Array.isArray(request.params?.input)||!this.backends.hooks().some(item=>item.name==='conversation.beforeSend'||item.name==='conversation.afterSend'))return;
    const input=request.params.input,text=input.filter(item=>item?.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');if(!text)return;
    const trusted=this.backendContext({...context,threadId:request.params.threadId,windowId:state.win.webContents.id,generation:state.api5Generation||0}),controller=new AbortController(),key=trusted.windowId+':'+request.id;
    need(this.nativeHooks.size<512,'待处理发送钩子过多','RESOURCE_EXHAUSTED');const record={context:trusted,controller,text};record.timer=setTimeout(()=>{controller.abort();if(this.nativeHooks.get(key)===record)this.nativeHooks.delete(key);},120000);record.timer.unref?.();this.nativeHooks.set(key,record);
    try{
      const changed=await this.backends.applyHooks('conversation.beforeSend',{text},trusted,{signal:controller.signal});controller.signal.throwIfAborted();need((state.api5Generation||0)===trusted.generation,'发送前对话已切换','STALE_CONTEXT');
      need(changed&&typeof changed.text==='string'&&changed.text.trim()&&changed.text.length<=200000,'发送钩子返回了无效文本');record.text=changed.text;
      if(changed.text!==text){let inserted=false;request.params={...request.params,input:input.flatMap(item=>item?.type!=='text'?[item]:inserted?[]:(inserted=true,[{type:'text',text:changed.text}]))};}
    }catch(error){clearTimeout(record.timer);this.nativeHooks.delete(key);throw error;}
  }
  completeNativeSend(state,message){const key=state.win.webContents.id+':'+message?.id,record=this.nativeHooks.get(key);if(!record||record.completing)return;const finish=()=>{clearTimeout(record.timer);if(this.nativeHooks.get(key)===record)this.nativeHooks.delete(key);};if(message.error||record.controller.signal.aborted){finish();return;}record.completing=true;this.backends.applyHooks('conversation.afterSend',{text:record.text,result:message.result||null},record.context,{signal:record.controller.signal}).catch(error=>{if(!record.controller.signal.aborted)this.logHostError(error);}).finally(finish);}
  async sync(){
    for(const [token,frame]of this.frames){const entry=this.registry.entries.get(frame.id);if(!entry||!this.registry.status(frame.id).enabled||entry.fingerprint!==frame.fingerprint){this.frames.delete(token);for(const [owner,item]of this.owners)if(item.frameToken===token){this.rpc.disposeOwner(owner);this.owners.delete(owner);}}}
    for(const map of [this.ui.themes,this.ui.shortcuts])for(const [key,item]of map)if(!this.registry.status(item.pluginId).enabled)map.delete(key);
    await this.backends.sync();
  }
  backendEvent(event){if(event.type==='backend.log'){try{this.appendLog(event.pluginId,event);}catch(error){this.logHostError(error);}}else this.broker?.publish();for(const state of this.states.values())this.notify(state,{type:'forge-api5-change',event});}
  requiresThread(id,method,args){
    if(method==='files.watch')return !args.root;
    if(['backend.call','backend.channel'].includes(method))return this.registry.get(id).manifest.backend?.scope!=='global';
    if(['services.request','services.channel'].includes(method))return this.backends.services().find(item=>item.name===args.name)?.scope!=='global';
    return currentMethods.has(method)||method==='files.request'&&!args.args?.root&&!['roots','connect','disconnect'].includes(args.method);
  }
  async handle(event,state,request){
    const entry=this.registry.get(request.id);need(entry.manifest.apiVersion===5,'此操作需要 API 5 插件','CAPABILITY_UNAVAILABLE');const context=this.context(event,state,request),args=object(request.args||{}),method=request.method;
    const bound=this.requiresThread(request.id,method,args);
    if(bound||request.threadId)need(context.threadId&&request.threadId===context.threadId&&(request.generation??0)===context.generation,'当前对话已变化或未就绪','STALE_CONTEXT');
    if(method==='rpc.cancel')return {cancelled:this.rpc.cancel(context.owner,args.requestId)};
    if(method==='rpc.stream.next')return this.rpc.next(context.owner,args.streamId);
    if(method==='rpc.stream.send')return this.rpc.send(context.owner,args.streamId,args.value);
    if(method==='rpc.stream.end')return this.rpc.end(context.owner,args.streamId);
    if(method==='rpc.stream.cancel')return this.rpc.close(context.owner,args.streamId);
    if(method==='rpc.stream.open'){
      this.authorize(request.id,args.method);
      if(this.requiresThread(request.id,args.method,args.args||{}))need(context.threadId&&request.threadId===context.threadId&&(request.generation??0)===context.generation,'当前对话已变化','STALE_CONTEXT');
      if(args.method==='services.channel'||args.method==='backend.channel')return this.channel(context,args.method,args.args||{},{timeoutMs:args.lifetimeMs??600000});
      need(['llm.stream','conversation.events','files.watch'].includes(args.method),'此方法不是流式接口','METHOD_NOT_FOUND');
      return this.rpc.open(context.owner,signal=>this.stream(request.id,args.method,args.args||{},context,{signal}),{timeoutMs:args.lifetimeMs??600000});
    }
    this.authorize(request.id,method);
    return this.rpc.run(context.owner,request.requestId,signal=>this.dispatch(request.id,method,args,context,{signal}),request.options||{});
  }
  authorize(id,method){
    const entry=this.registry.get(id),legacy={'storage.get':'storage','storage.set':'storage','storage.delete':'storage','settings.get':'settings','nexus.request':'nexus'},capability=contract.methods[method]||legacy[method];
    if(['metadata.get','context.get','capabilities.get'].includes(method))return entry;need(capability,'未知 API 5 方法','METHOD_NOT_FOUND');
    const reason=granted(entry.manifest,method);need(!reason,reason,'CAPABILITY_UNAVAILABLE');
    if(capability==='settings')this.permission(id,'settings');else{const permission=contract.capabilities[capability]?.permission;if(permission)this.permission(id,permission);}
    return entry;
  }
  stream(id,method,args,context,{signal}){
    object(args);this.authorize(id,method);
    if(method==='conversation.events'){this.permission(id,'conversation.events');return this.subscribe(id,context,signal);}
    if(method==='files.watch'){this.permission(id,'files.read');return this.io.watch(id,args,context,signal);}
    if(method==='llm.stream')return this.modelStream(id,args,context,{signal});
    throw new ForgeError('METHOD_NOT_FOUND','未知流式接口');
  }
  channel(context,method,args,options={}){
    const queue=[];let wake,ended=false;const channelId=crypto.randomUUID();let lifetime;
    const invoke=async value=>{need(!ended,'通道输入已关闭','STREAM_CLOSED');need(queue.length<64,'通道队列已满','RESOURCE_EXHAUSTED');const trusted=this.backendContext({...context,channelId});const result=method==='services.channel'?await this.backends.requestService(context.pluginId,args.name,args.method,value,trusted,{signal:lifetime}):await this.backends.call(context.pluginId,args.method,value,trusted,{signal:lifetime});queue.push(result);wake?.();};
    return this.rpc.open(context.owner,signal=>{lifetime=signal;signal.addEventListener('abort',()=>{ended=true;wake?.();},{once:true});return {async *[Symbol.asyncIterator](){try{while(!ended||queue.length){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;});}}finally{ended=true;wake?.();}}};},{...options,onInput:invoke,onEnd:()=>{ended=true;wake?.();}});
  }
  subscribe(id,context,signal){
    const queue=[];let wake,ended=false,failure;const subscription={windowId:context.windowId,threadId:context.threadId,id,queue,push:value=>{if(queue.length>=64){failure=new ForgeError('RESOURCE_EXHAUSTED','会话事件积压，请重新订阅');subscription.close();}else{queue.push(value);wake?.();}},close:()=>{ended=true;this.events.delete(subscription);wake?.();}};this.events.add(subscription);signal.addEventListener('abort',subscription.close,{once:true});const events=this.events;
    return {async *[Symbol.asyncIterator](){try{while(!ended||queue.length){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;});}if(failure)throw failure;}finally{events.delete(subscription);signal.removeEventListener('abort',subscription.close);subscription.close();}}};
  }
  observe(state,method,params={}){
    if(!/^(?:turn\/(?:started|completed)|item\/(?:started|completed|agentMessage\/delta)|thread\/tokenUsage\/updated)$/.test(method))return;
    const threadId=params.threadId||params.thread?.id;if(!threadId)return;
    if(['item/started','item/completed'].includes(method)&&params.item?.id&&!['agentMessage','userMessage','reasoning'].includes(params.item.type)){
      const item=params.item,nativeName=item.tool||item.name||item.type,definition=this.backends.tools().find(tool=>require('./forge-api5-broker.cjs').alias(tool.name)===nativeName);
      this.toolViews.set(state.win.webContents.id+':'+threadId+':'+item.id,{windowId:state.win.webContents.id,threadId,id:item.id,type:item.type,toolName:definition?.name||nativeName});while(this.toolViews.size>500)this.toolViews.delete(this.toolViews.keys().next().value);
      this.notify(state,{type:'forge-api5-change'});
    }
    for(const subscription of this.events){if(subscription.windowId!==state.win.webContents.id||subscription.threadId!==threadId)continue;const entry=this.registry.entries.get(subscription.id);if(!entry||!this.registry.status(subscription.id).enabled||!entry.manifest.permissions.includes('conversation.events')){subscription.close();continue;}
      const content=entry.manifest.permissions.includes('conversation.history');if(method.startsWith('item/')&&!content)continue;
      const metadata={threadId,...(params.turnId?{turnId:params.turnId}:{}),...(params.turn?{turn:{id:params.turn.id,status:params.turn.status,...(params.turn.error?.code?{error:{code:params.turn.error.code}}:{})}}:{}),...(params.tokenUsage?{tokenUsage:params.tokenUsage}:{})};
      const value=content&&Buffer.byteLength(JSON.stringify(params))<=1024*1024?copy(params):{...metadata,...(content?{truncated:true}:{})};subscription.push({sequence:++this.eventSequence,threadId,method,params:value});
    }
  }
  async modelContext(context){if(this.services.modelContext)return this.services.modelContext(context);const result=await this.nativeCall(context.state,'thread/read',{threadId:context.threadId,includeTurns:false});return {...context,model:result.model||result.thread?.model,provider:result.modelProvider||result.thread?.modelProvider,effort:result.reasoningEffort||result.thread?.reasoningEffort};}
  async *modelStream(id,args,context,options){
    this.permission(id,'llm.call');const trusted=this.backendContext(context);
    if(args.provider){need(this.backends.providers().some(provider=>provider.name===args.provider),'模型提供方未注册','CAPABILITY_UNAVAILABLE');yield* this.backends.stream(id,args,trusted,options);return;}
    const input=await this.backends.applyHooks('llm.before',copy(args),trusted,options)||args;
    const source=this.models.stream(input,await this.modelContext(context),options);let text='',usage;
    for await(const delta of source){options.signal?.throwIfAborted();if(delta.type==='text')text+=delta.text||'';if(delta.type==='usage')usage=delta.usage;need(text.length<=2*1024*1024,'模型结果超过限制','RESOURCE_EXHAUSTED');yield delta;}
    const settled=await this.backends.applyHooks('llm.after',{...args,result:{text,usage:usage||null}},trusted,options);yield {type:'result',result:settled?.result||{text,usage:usage||null}};
  }
  async dispatch(id,method,args={},context={},options={}){
    object(args);const entry=this.authorize(id,method);options.signal?.throwIfAborted();
    if(method.startsWith('storage.'))return this.registry.storage(id,method.split('.')[1],args.key,args.value);
    if(method==='settings.get')return this.registry.settings(id);
    if(method==='metadata.get')return entry.manifest;
    if(method==='context.get')return this.backendContext(context);
    if(method==='capabilities.get')return {permissions:entry.manifest.permissions,capabilities:entry.manifest.capabilities,available:Object.fromEntries(Object.entries(require('./forge-capabilities.cjs').CAPABILITIES).map(([name,value])=>[name,value.version]))};
    if(method==='nexus.request'){this.permission(id,'nexus.read');if(require('./nexus.cjs').methodKind(args.method)==='write')this.permission(id,'nexus.write');return this.available('nexus').dispatch(args.method,args.args||{});}
    if(method.endsWith('.request')&&['canvas','todos','skills','memory','statistics','collaboration'].includes(method.split('.')[0]))return this.business(id,method.split('.')[0],args.method,args.args||{},context,options);
    if(method.startsWith('conversation.'))return this.conversation(id,method.slice(13),args,context,options);
    if(method==='llm.providers')return {providers:this.backends.providers()};
    if(method==='llm.sample'){let text='',usage;for await(const item of this.modelStream(id,args,context,options)){if(item.type==='text')text+=item.text||'';if(item.type==='usage')usage=item.usage;if(item.type==='result'){text=item.result.text;usage=item.result.usage;}}return {text,...(usage?{usage}:{})};}
    if(method==='backend.call')return this.backends.call(id,args.method,args.args||{},this.backendContext(context),options);
    if(method==='services.request')return this.backends.requestService(id,args.name,args.method,args.args||{},this.backendContext(context),options);
    if(method==='tools.list')return this.backends.tools();
    if(method==='tools.call')return this.callTool(args.name,args.args||{},context,options);
    if(method==='hooks.list')return this.backends.hooks();
    if(method==='jobs.request'||method==='schedules.request'){
      this.permission(id,method==='jobs.request'?'jobs.manage':'schedules.manage');need(typeof args.method==='string','任务方法无效');const saved={threadId:context.threadId,cwd:context.cwd,windowId:context.windowId,generation:context.generation,pluginId:id};return this.tasks.dispatch(id,method.split('.')[0]+'.'+args.method,args.args||{},saved);
    }
    if(method==='files.request'){
      const nested=args.args||{};this.permission(id,['read','list','stat','roots','connect','disconnect'].includes(args.method)?'files.read':'files.write');
      if(args.method==='connect'){need(this.dialog&&context.state,'目录选择器不可用','CAPABILITY_UNAVAILABLE');const result=await this.dialog.showOpenDialog(context.state.win,{title:'连接插件工作目录',properties:['openDirectory']});this.permission(id,'files.read');options.signal?.throwIfAborted();return result.canceled?null:this.io.connect(id,result.filePaths[0]);}
      return this.io.files(id,args.method,nested,context);
    }
    if(method==='shell.execute'){this.permission(id,'shell.execute');return this.io.shell(args,context,options);}
    if(method==='network.fetch'){this.permission(id,'network','network.request');return this.io.fetch(id,entry.manifest,args,options);}
    if(method.startsWith('credentials.')){this.permission(id,'credentials.manage');return this.io.credential(id,method.split('.')[1],args);}
    if(method.startsWith('plugins.'))return this.plugins(id,method.split('.')[1],args,options);
    if(method==='settings.snapshot')return {value:this.registry.settings(id),revision:hash(this.registry.settings(id))};
    if(method==='settings.set'){this.permission(id,'settings.write');const value=this.registry.settings(id);need(args.expectedRevision===hash(value),'设置已变化，请重新读取','REVISION_CONFLICT');this.registry.settings(id,args.value);await this.sync();this.changed();return {value:this.registry.settings(id),revision:hash(this.registry.settings(id))};}
    if(method.startsWith('logs.'))return this.logs(id,method.split('.')[1],args);
    if(method.startsWith('theme.')||method.startsWith('shortcuts.'))return this.userInterface(id,method,args);
    throw new ForgeError('METHOD_NOT_FOUND','未实现的 API 5 方法');
  }
  async business(id,service,method,args,context,options){
    object(args);const api=this.available(service);
    const reads={canvas:['list','read','asset'],todos:['read'],skills:['list','read','files'],memory:['list','catalog','read'],statistics:['snapshot'],collaboration:['thread','list','read','wait']};
    const writes={canvas:['create','apply','delete','restore'],todos:['apply'],skills:['setEnabled'],memory:['write','create','rename','delete','remove'],statistics:['analyze','import','probe','cancel'],collaboration:['run','cancel','resume_delegation']};
    need(reads[service].includes(method)||writes[service].includes(method),'不支持的公共服务方法','METHOD_NOT_FOUND');
    const writePermission={canvas:'canvas.write',todos:'todos.write',skills:'skills.manage',memory:'memory.write',statistics:'statistics.detect',collaboration:'collaboration.run'}[service];this.permission(id,service+'.read',...(writes[service].includes(method)?[writePermission]:[]));
    if(service==='canvas'){
      if(method==='list')return api.list();if(method==='read')return api.read(args.canvasId);if(method==='asset')return api.imageData(args.asset);if(method==='create')return api.create(args.title,undefined,'user',args.metadata||{});if(method==='apply')return api.apply(args.canvasId,args.expectedRevision,args.operations,'user',args.message);if(method==='delete')return api.delete(args.canvasId,args.expectedRevision);if(method==='restore')return api.restore(args.restoreToken);
    }
    if(service==='todos'){need(context.threadId,'当前对话未就绪');need(!args.threadId||args.threadId===context.threadId,'待办不属于当前对话','PERMISSION_DENIED');return method==='read'?api.read(context.threadId):api.apply(context.threadId,args.expectedRevision,args.operations,'user');}
    if(service==='skills'){if(method==='list')return api.list(args);if(method==='read')return api.read(args.id,{...args,requireEnabled:true});if(method==='files')return api.files(args.id,{...args,requireEnabled:true});return api.setEnabled(args.id,args.enabled,args.agent||'codex');}
    if(service==='memory')return api.dispatch(method,args);
    if(service==='statistics'){const trusted=this.services.statisticsContext?await this.services.statisticsContext(context):context;return api.dispatch(method,{outputs:args.outputs,threadId:trusted.threadId},trusted);}
    if(service==='collaboration'){need(!args.threadId||args.threadId===context.threadId,'不能访问其他对话','PERMISSION_DENIED');return api.dispatch(method,args,{...context,source:'plugin',trusted:false});}
  }
  async conversation(id,method,args,context,options){
    if(method==='list'){this.permission(id,'conversation.history');return this.nativeCall(context.state,'thread/list',{limit:Math.min(Math.max(args.limit||20,1),100),cursor:args.cursor||null,...(context.cwd?{cwd:context.cwd}:{})},options);}
    if(method==='read'){this.permission(id,'conversation.history');need(!args.threadId||args.threadId===context.threadId,'仅允许读取当前对话','PERMISSION_DENIED');const result=await this.nativeCall(context.state,'thread/turns/list',{threadId:context.threadId,limit:Math.min(Math.max(args.limit||20,1),100),itemsView:'summary',sortDirection:'desc',...(args.cursor?{cursor:args.cursor}:{})},options);return {threadId:context.threadId,turns:result.data||[],cursor:result.nextCursor||null};}
    if(method==='create'){this.permission(id,'conversation.manage');return this.nativeCall(context.state,'thread/start',{cwd:context.cwd,ephemeral:false,...(args.model?{model:args.model}:{})},options);}
    if(method==='fork'){this.permission(id,'conversation.manage','conversation.history');return this.nativeCall(context.state,'thread/fork',{threadId:context.threadId},options);}
    if(method==='send'){
      this.permission(id,'conversation.send');need(typeof args.text==='string'&&args.text.trim()&&args.text.length<=200000,'消息文本无效');const trusted=this.backendContext(context),changed=await this.backends.applyHooks('conversation.beforeSend',{text:args.text},trusted,options)||args;
      const result=await this.nativeCall(context.state,'turn/start',{threadId:context.threadId,input:[{type:'text',text:changed.text}],turnTrigger:'forge_plugin'},options);await this.backends.applyHooks('conversation.afterSend',{text:changed.text,result},trusted,options);return result;
    }
    if(method==='cancel'){this.permission(id,'conversation.send');need(typeof args.turnId==='string'&&/^[\w-]{1,100}$/.test(args.turnId),'回合 ID 无效');return this.nativeCall(context.state,'turn/interrupt',{threadId:context.threadId,turnId:args.turnId},options);}
    throw new ForgeError('METHOD_NOT_FOUND','不支持的会话操作');
  }
  async callTool(name,args,context,options){return this.backends.callTool(name,args,this.backendContext(context),options);}
  async plugins(id,method,args,options){
    this.permission(id,'plugins.read');if(!['list','catalog','checkUpdate'].includes(method))this.permission(id,'plugins.manage');const updates=require('./forge-plugin-updates.cjs');
    const checked={...options,revalidate:()=>{options.signal?.throwIfAborted();this.permission(id,'plugins.read',...(!['list','catalog','checkUpdate'].includes(method)?['plugins.manage']:[]));}};
    if(method==='list')return this.registry.list();if(method==='catalog')return this.market.catalog(args,checked);if(method==='install'){const result=await this.market.install(args,checked);this.changed();return result;}
    if(method==='checkUpdate')return updates.checkPluginUpdate(this.registry,args.id,undefined,checked);
    if(method==='update'){const plan=await updates.checkPluginUpdate(this.registry,args.id,undefined,checked);checked.revalidate();if(plan.status!=='available')return plan;const result=await updates.stagePluginUpdate(this.registry,plan,undefined,checked);this.changed();return result;}
    if(method==='enable'){if(args.enabled)need(this.registry.reviewed(args.id),'请先在 Forge 插件管理中审阅当前插件权限并启用','PERMISSION_DENIED');const result=this.registry.setEnabled(args.id,args.enabled);await this.sync();this.changed();return result;}
    if(method==='uninstall'){need(args.id!==id,'插件不能在自己的请求中卸载自身');await this.backends.disposePlugin(args.id);const result=this.registry.uninstall(args.id);await this.sync();this.changed();return result;}
    throw new ForgeError('METHOD_NOT_FOUND','未知插件管理方法');
  }
  logs(id,method,args){
    this.permission(id,'logs.'+method);const file=path.join(this.root,'logs',id+'.json'),items=json(file,[]);
    if(method==='read')return {items:items.slice(-Math.min(args.limit||100,500))};
    need(['debug','info','warning','error'].includes(args.level||'info')&&typeof args.message==='string'&&args.message.length<=4000,'日志无效');return this.appendLog(id,args);
  }
  appendLog(id,args){const file=path.join(this.root,'logs',id+'.json'),items=json(file,[]);items.push({at:new Date().toISOString(),level:args.level||'info',message:String(args.message).slice(0,4000)});while(items.length>500||Buffer.byteLength(JSON.stringify(items))>1024*1024)items.shift();fs.mkdirSync(path.dirname(file),{recursive:true});atomic(file,items);return true;}
  userInterface(id,method,args){
    if(method==='theme.get'){this.permission(id,'theme.read');return {selected:json(path.join(this.root,'api5-ui.json'),{}).theme||null,themes:[...this.ui.themes.values()]};}
    if(method==='theme.register'){
      this.permission(id,'theme.register');need(typeof args.id==='string'&&/^[\w.-]{1,80}$/.test(args.id),'主题 ID 无效');object(args.tokens);need(Object.keys(args.tokens).length<=100&&Object.entries(args.tokens).every(([name,value])=>/^--forge-[a-z0-9-]{1,80}$/.test(name)&&typeof value==='string'&&value.length<=200&&/^(?:#[a-f0-9]{3,8}|[a-z]{1,30}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([a-z0-9.,%+\- /]+\))$/i.test(value)),'主题 token 必须为颜色值');this.ui.themes.set(id+':'+args.id,{pluginId:id,id:id+':'+args.id,tokens:copy(args.tokens)});
    }else if(method==='theme.set'){
      this.permission(id,'theme.write');const theme=args.id===null?null:this.ui.themes.has(args.id)?args.id:id+':'+args.id;need(theme===null||this.ui.themes.has(theme),'主题未注册');const saved=json(path.join(this.root,'api5-ui.json'),{});saved.theme=theme;atomic(path.join(this.root,'api5-ui.json'),saved);
    }else if(method==='shortcuts.register'){
      this.permission(id,'shortcuts');need(typeof args.id==='string'&&/^[\w.-]{1,80}$/.test(args.id)&&typeof args.key==='string'&&/^(?:(?:Ctrl|Alt|Shift|Meta)\+){1,3}[A-Za-z0-9]$/.test(args.key),'快捷键无效');need(this.registry.get(id).manifest.contributes?.commands?.some(command=>command.id===args.command),'快捷键命令未声明');need(![...this.ui.shortcuts.values()].some(shortcut=>shortcut.key===args.key&&shortcut.pluginId!==id),'快捷键已被其他插件占用');this.ui.shortcuts.set(id+':'+args.id,{pluginId:id,id:args.id,key:args.key,command:args.command});
    }else if(method==='shortcuts.unregister'){this.permission(id,'shortcuts');this.ui.shortcuts.delete(id+':'+args.id);}else throw new ForgeError('METHOD_NOT_FOUND','未知界面方法');
    this.changed();return this.uiSnapshot();
  }
  uiSnapshot(context){const selected=json(path.join(this.root,'api5-ui.json'),{}).theme;return {theme:this.ui.themes.get(selected)||null,shortcuts:[...this.ui.shortcuts.values()],toolViews:context?[...this.toolViews.values()].filter(item=>item.threadId===context.threadId&&item.windowId===context.windowId):[]};}
  dispose(){return this.disposing??=this.close();}
  async close(){this.broker?.stopPublishing();for(const value of this.nativeHooks.values()){clearTimeout(value.timer);value.controller.abort();}this.nativeHooks.clear();for(const subscription of this.events)subscription.close();await this.rpc.dispose();await this.tasks.dispose();await this.backends.dispose();await this.brokerReady;await this.broker?.dispose();this.frames.clear();this.owners.clear();}
}
module.exports={ForgeAPI5};
