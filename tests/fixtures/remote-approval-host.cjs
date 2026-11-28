'use strict';
// Opt-in integration fixture: evaluates selected methods and the bundled schema
// library from a SHA-pinned official module. It never runs its process entrypoint.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const ts = require('typescript');
const {createNativeConnection} = require('./remote-chat-host.cjs');
const {open} = require('../../runtime/remote-approvals-native.cjs');
async function createNativeApprovalHost({sourcePath = process.env.FORGE_NATIVE_HOST_MODULE} = {}) {
  if (!sourcePath) throw Error('Set FORGE_NATIVE_HOST_MODULE to verified 26.1120 app-server-host.js');
  const source = fs.readFileSync(sourcePath,'utf8');
  if (crypto.createHash('sha256').update(source).digest('hex') !== '1a27128021253ea901a0edab2fc5013920104ca1ad73d7ff7fc4df6e0098cf46') throw Error('Native module hash mismatch');
  const {patchRemoteApprovalHost} = await import('../../scripts/native-remote-approvals.mjs');
  const patched = patchRemoteApprovalHost(source);
  const loaderContext = {module:{exports:{}},require,console,URL,TextEncoder,TextDecoder,Buffer,process,AbortController,ReadableStream,WritableStream,setTimeout,clearTimeout,queueMicrotask};
  const entry = 'var a=s(s.s=61627);module.exports=a';
  if (source.split(entry).length !== 2) throw Error('Native entry changed');
  // Keep library Function/RpcTarget identity in the test realm, as in each
  // actual process. The disabled entry point cannot initialize a native host.
  Function(...Object.keys(loaderContext), source.replace(entry,'module.exports=s'))(...Object.values(loaderContext));
  const bundled = loaderContext.module.exports;
  const ast = ts.createSourceFile(sourcePath,patched,ts.ScriptTarget.Latest,true), classes = {}, functions = {}, methods = {};
  const declarations = {};
  let registerHostEventHandler, onRequest;
  function visit(node) {
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text;
      if (['cI','AF','cG','iK'].includes(name)) classes[name] = node.getText(ast);
      for (const method of node.members) {
        const key = method.name?.getText(ast);
        if (name === 'AA' && ['getApprovalActionContext','replyWithCommandExecutionApprovalDecision','replyWithFileChangeApprovalDecision','replyWithPermissionsRequestApprovalResponse','replyWithUserInputResponse','replyWithMcpServerElicitationResponse'].includes(key)) methods[key] = method.getText(ast);
        if (name === 'AA' && key === 'onRequest') onRequest = method.getText(ast);
        if (key === 'registerHostEventHandler') registerHostEventHandler = method.getText(ast);
      }
    }
    if (ts.isFunctionDeclaration(node) && ['c6','c8','c7','d3','d4','d5','d6','d8','hr','iQ','iG','iV'].includes(node.name?.text)) functions[node.name.text] = node.getText(ast);
    if (ts.isVariableStatement(node)) {
      const first = node.declarationList.declarations[0]?.name.getText(ast);
      if (['dt','dq'].includes(first)) declarations[first] = node.getText(ast);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  const context = {console,URL,queueMicrotask,Promise,Map,Set,Symbol,Error,DOMException,TextEncoder,TextDecoder,
    t2:bundled(67221),rm:bundled(40893),dU:bundled(51934),dB:bundled(7049),dj:bundled(75184),
    c9:'item/plan/requestImplementation',u3:{JXB:value=>value,DDP:value=>String(value)},
    Aj:class {dispose(){} cancel(){}},
    // Transcript projection is not under test; request lookup, binding schemas,
    // canonical summary validation, routing and final send guards are native.
    d7(){},dL(){},dN(){},he(){},ht(){},s4:structuredClone,sX:requests=>requests,oc:(conversation,id)=>conversation?.turns?.find(turn=>turn.id===id),
  };
  const native = Function(...Object.keys(context), [...Object.values(declarations),...Object.values(functions),...Object.values(classes),'class Manager {#tP = async()=>({status:"ready"});'+onRequest+'}','return {Manager,cI,AF,cG,iK,methods:{'+Object.values(methods).join(',')+'},connectionMethods:{'+registerHostEventHandler+'}};'].join('\n'))(...Object.values(context));
  const transport = createNativeConnection();
  const {connection} = transport; connection.hostEventHandler = null;
  connection.registerHostEventHandler = native.connectionMethods.registerHostEventHandler;
  let identityCurrent = true;
  const assertCurrent = () => { if (!identityCurrent) throw Error('Native account/manager retired'); };
  const replies = new native.cI(connection,assertCurrent,assertCurrent), router = new native.AF(replies,assertCurrent), events = new native.cG();
  const manager = Object.assign(new native.Manager(),native.methods,{
    hostId:'local',conversations:new Map(),events,logger:{error(){},info(){},warning(){},debug(){}},runtime:{parseUrl:value=>new URL(value)},assertActive:assertCurrent,
    updateConversationState(id,fn){ fn(this.conversations.get(id)); },
    addThreadDeletedListener:fn=>events.addThreadDeletedListener(fn), replyWithDynamicToolResponse:()=>false,
    sendAppServerResponse:(method,message)=>{router.sendResponse(method,message).catch(()=>{});},sendApprovalResponse:(method,message)=>router.sendApprovalResponse(method,message),
    onNotification(){},getConversation(id){return this.conversations.get(id);},
    threadExecution:{},runtimeSettings:{},history:{turnMergePolicy:{}},streamState:{shouldHandleDynamicToolCall:()=>false},
    resumeNotificationBuffer:{bufferRequest:()=>false},threadStartedNotificationDeferral:{bufferRequest:()=>false},
    threadDiscovery:{bufferRequest(request){if(!manager.conversations.has(request.params.threadId))manager.conversations.set(request.params.threadId,{requests:[],turns:[]});return false;}},
  });
  router.bind(manager);
  replies.bind({deliverRequest:(...args)=>router.deliverRequest(...args),deliverNotification:(...args)=>router.deliverNotification(...args),connectionDisconnected:()=>router.connectionDisconnected(),connectionInitialized:()=>router.connectionInitialized()});
  const bridge = open({manager,router,assertCurrent,lease:native.iK});
  return {...transport,manager,router,bridge,events,native,rpc:bundled(67221),retire:()=>{identityCurrent=false;},dispose(){router.dispose();replies.dispose();}};
}
module.exports = {createNativeApprovalHost};
