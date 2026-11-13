const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { ForgeRPC } = require('../runtime/forge-rpc.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function loadSdk({ apiVersion = 5, dispatch, document } = {}) {
  const listeners = new Map(), requests = [];
  const window = { addEventListener: (name, fn) => listeners.set(name, fn) };
  const parent = { postMessage: message => {
    const request = message.forgePluginRequest;
    if (!request) return;
    requests.push(request);
    if (dispatch) Promise.resolve().then(() => dispatch(request)).then(result => reply(request.id, result), error => reply(request.id, undefined, { code: error.code, message: error.message }));
  } };
  const deliver = (data, source = parent) => listeners.get('message')({ source, data });
  const reply = (id, result, error) => deliver({ forgePluginReply: { id, result, error } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../runtime/forge-sdk.js'), 'utf8').replace('apiVersion: 5,', 'apiVersion: ' + apiVersion + ','), { window, parent, document, setTimeout, clearTimeout, console: { error() {} } });
  return { api: window.CodexForge, requests, reply, deliver, async ready() { reply(requests[0].id, { denied: {} }); reply(requests[1].id, { apiVersion, hostApiVersion: 5, threadId: 'thread-a' }); await tick(); } };
}

test('API 5 SDK sends request identity and cooperative cancellation without serializing signals', async () => {
  const h = loadSdk(); await h.ready();
  const controller = new AbortController();
  const pending = h.api.llm.sample({ prompt: 'hello' }, { signal: controller.signal, timeoutMs: 1000 });
  const request = h.requests.at(-1);
  assert.equal(request.method, 'llm.sample'); assert.equal(request.requestId, request.id);
  assert.equal(request.threadId, 'thread-a'); assert.equal(request.options.timeoutMs, 1000);
  assert.equal(request.generation, 0);
  assert.equal(JSON.stringify(request).includes('signal'), false);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(h.requests.at(-1).method, 'rpc.cancel');
  assert.equal(h.requests.at(-1).args.requestId, request.id);
  h.reply(request.id, { text: 'late result' });
  const before = h.requests.length;
  await assert.rejects(h.api.llm.sample({ prompt: 'again' }, { signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.equal(h.requests.length, before);
});

test('SDK stream requests retain their opening generation after the visible context changes', async () => {
  const h=loadSdk();await h.ready();
  h.deliver({forgePluginEvent:{name:'context.changed',value:{threadId:'thread-a',generation:3}}});
  const stream=h.api.llm.stream({prompt:'test'}),open=h.requests.at(-1);h.reply(open.id,{streamId:'s'});
  h.deliver({forgePluginEvent:{name:'context.changed',value:{threadId:'thread-a',generation:5}}});
  const next=stream.next();await tick();const request=h.requests.at(-1);
  assert.equal(request.generation,3);h.reply(request.id,undefined,{code:'STALE_CONTEXT',message:'changed'});
  await tick();const close=h.requests.at(-1);assert.equal(close.method,'rpc.stream.cancel');assert.equal(close.generation,3);h.reply(close.id,{closed:true});
  await assert.rejects(next,error=>error.code==='STALE_CONTEXT');
});

test('API 5 browser stream drives the actual RPC pull, duplex input and half-close', async () => {
  const rpc = new ForgeRPC(); const received = []; let ended = false;
  const h = loadSdk({ dispatch: async request => {
    if (request.method === 'capabilities.get') return { denied: {} };
    if (request.method === 'context.get') return { threadId: 'thread-a' };
    const args = request.args;
    if (request.method === 'rpc.stream.open') {
      assert.equal(args.method, 'services.channel');
      return rpc.open('owner', (async function* () { yield 'connected'; yield received[0]; })(), { onInput: value => received.push(value), onEnd: () => { ended = true; } });
    }
    if (request.method === 'rpc.stream.next') return rpc.next('owner', args.streamId);
    if (request.method === 'rpc.stream.send') return rpc.send('owner', args.streamId, args.value);
    if (request.method === 'rpc.stream.end') return rpc.end('owner', args.streamId);
    if (request.method === 'rpc.stream.cancel') return rpc.close('owner', args.streamId);
    throw Error('Unexpected method ' + request.method);
  } });
  await tick();
  const stream = h.api.services.channel('example.service', 'query', { count: 1 });
  assert.equal((await stream.next()).value, 'connected');
  await stream.send({ name: 'input' }); await stream.end();
  assert.equal(ended, true); assert.deepEqual((await stream.next()).value, { name: 'input' });
  assert.equal((await stream.next()).done, true);
  assert.equal(rpc.streams.size, 0); rpc.dispose();
});

test('breaking browser stream iteration closes the host producer', async () => {
  const rpc = new ForgeRPC(); let signal, returned = false;
  const h = loadSdk({ dispatch: async request => {
    if (request.method === 'capabilities.get') return { denied: {} };
    if (request.method === 'context.get') return { threadId: 'thread-a' };
    if (request.method === 'rpc.stream.open') return rpc.open('owner', received => { signal = received; return { next: async () => ({ value: 1, done: false }), return: async () => { returned = true; return { done: true }; } }; });
    if (request.method === 'rpc.stream.next') return rpc.next('owner', request.args.streamId);
    if (request.method === 'rpc.stream.cancel') return rpc.close('owner', request.args.streamId);
  } });
  await tick();
  for await (const value of h.api.llm.stream({ prompt: 'test' })) { assert.equal(value, 1); break; }
  assert.equal(signal.aborted, true); assert.equal(returned, true); assert.equal(rpc.streams.size, 0); rpc.dispose();
});

test('API 5 SDK uses singular conversation routes, versioned settings and service envelopes', async () => {
  const h = loadSdk(); await h.ready();
  let pending = h.api.conversations.read({ limit: 10 });
  assert.equal(h.requests.at(-1).method, 'conversation.read'); h.reply(h.requests.at(-1).id, { turns: [] }); await pending;
  pending = h.api.settings.snapshot(); assert.equal(h.requests.at(-1).method, 'settings.snapshot'); h.reply(h.requests.at(-1).id, { value: {}, revision: 'a' }); await pending;
  pending = h.api.settings.set({ ready: true }, 'a');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests.at(-1).args)), { value: { ready: true }, expectedRevision: 'a' });
  h.reply(h.requests.at(-1).id, { value: { ready: true }, revision: 'b' }); await pending;
  for (const name of ['canvas', 'todos', 'skills', 'memory', 'statistics', 'collaboration', 'files', 'jobs', 'schedules']) {
    pending = h.api[name].request('list', { limit: 1 });
    const request = h.requests.at(-1); assert.equal(request.method, name + '.request');
    assert.deepEqual(JSON.parse(JSON.stringify(request.args)), { method: 'list', args: { limit: 1 } }); h.reply(request.id, []); await pending;
  }
});

test('every public API5 host method has a browser SDK route with the same wire name',async()=>{
  const contract=require('../runtime/forge-api5-contract.cjs'),h=loadSdk();await h.ready();const seen=new Set();
  const calls=[
    ['conversation.list',()=>h.api.conversations.list()],['conversation.read',()=>h.api.conversations.read()],['conversation.create',()=>h.api.conversations.create()],
    ['conversation.fork',()=>h.api.conversations.fork()],['conversation.send',()=>h.api.conversations.send({text:'test'})],['conversation.cancel',()=>h.api.conversations.cancel({turnId:'turn'})],
    ['llm.providers',()=>h.api.llm.providers()],['llm.sample',()=>h.api.llm.sample({prompt:'test'})],
    ['tools.list',()=>h.api.tools.list()],['tools.call',()=>h.api.tools.call('example.tool',{})],
    ['services.request',()=>h.api.services.request('example.service','echo',{})],['backend.call',()=>h.api.backend.call('echo',{})],
    ['hooks.list',()=>h.api.hooks.list()],['shell.execute',()=>h.api.shell.execute({executable:'node'})],
    ['credentials.set',()=>h.api.credentials.set('key','fixture')],['credentials.delete',()=>h.api.credentials.delete('key')],['credentials.describe',()=>h.api.credentials.describe('key')],
    ['network.fetch',()=>h.api.network.fetch({url:'https://example.invalid'})],
    ['plugins.list',()=>h.api.plugins.list()],['plugins.catalog',()=>h.api.plugins.catalog()],['plugins.install',()=>h.api.plugins.install('example.plugin')],
    ['plugins.checkUpdate',()=>h.api.plugins.checkUpdate('example.plugin')],['plugins.update',()=>h.api.plugins.update('example.plugin')],['plugins.enable',()=>h.api.plugins.enable('example.plugin',false)],['plugins.uninstall',()=>h.api.plugins.uninstall('example.plugin')],
    ['logs.write',()=>h.api.logs.write({message:'fixture'})],['logs.read',()=>h.api.logs.read()],
    ['theme.get',()=>h.api.theme.get()],['theme.set',()=>h.api.theme.set(null)],['theme.register',()=>h.api.theme.register({id:'theme',tokens:{'--forge-bg':'black'}})],
    ['shortcuts.register',()=>h.api.shortcuts.register({id:'key',key:'Ctrl+K',command:'echo'})],['shortcuts.unregister',()=>h.api.shortcuts.unregister('key')],
    ['settings.snapshot',()=>h.api.settings.snapshot()],['settings.set',()=>h.api.settings.set({},'revision')],
  ];
  for(const name of ['canvas','todos','skills','memory','statistics','collaboration','files','jobs','schedules'])calls.push([name+'.request',()=>h.api[name].request('list',{})]);
  for(const [method,call]of calls){assert(Object.hasOwn(contract.methods,method),'host contract is missing '+method);const pending=call(),request=h.requests.at(-1);assert.equal(request.method,method);seen.add(method);h.reply(request.id,true);if(pending?.then)await pending;}
  for(const [method,call]of [
    ['conversation.events',()=>h.api.conversations.events()],['llm.stream',()=>h.api.llm.stream({prompt:'test'})],['files.watch',()=>h.api.files.watch({path:'note.md'})],
    ['services.channel',()=>h.api.services.channel('example.service','echo')],['backend.channel',()=>h.api.backend.channel('echo')],
  ]){
    assert(Object.hasOwn(contract.methods,method),'host stream contract is missing '+method);const stream=call(),request=h.requests.at(-1);assert.equal(request.method,'rpc.stream.open');assert.equal(request.args.method,method);seen.add(method);h.reply(request.id,{streamId:method});
    const closed=stream.dispose();await tick();const cancel=h.requests.at(-1);assert.equal(cancel.method,'rpc.stream.cancel');h.reply(cancel.id,{closed:true});await closed;
  }
  assert.deepEqual([...seen].sort(),Object.keys(contract.methods).sort());
});

test('trusted theme snapshots apply to the plugin frame and discard removed tokens', async () => {
  const values=new Map(),style={setProperty:(key,value)=>values.set(key,value),removeProperty:key=>values.delete(key)};
  const h=loadSdk({document:{documentElement:{style}}});await h.ready();
  h.deliver({forgePluginEvent:{name:'theme.changed',value:{tokens:{'--forge-bg':'red','--forge-text':'white'}}}});
  assert.equal(values.get('--forge-bg'),'red');assert.equal(values.get('--forge-text'),'white');
  h.deliver({forgePluginEvent:{name:'theme.changed',value:{tokens:{'--forge-bg':'blue'}}}},{});
  assert.equal(values.get('--forge-bg'),'red');
  h.deliver({forgePluginEvent:{name:'theme.changed',value:{tokens:{'--forge-bg':'blue'}}}});
  assert.equal(values.get('--forge-bg'),'blue');assert.equal(values.has('--forge-text'),false);
  h.deliver({forgePluginEvent:{name:'dispose',value:null}});assert.equal(values.size,0);
});

test('API 5 SDK receives context for new workspace permissions and calls the actual host dispatcher', async t => {
  const os=require('node:os'),Module=require('node:module');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-api5-sdk-host-')),id='test.sdk-integration',directory=path.join(root,'plugins',id),cwd=path.join(root,'workspace');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(directory,'plugin.json'),JSON.stringify({schemaVersion:1,apiVersion:5,id,name:'SDK fixture',version:'1.0.0',compatibility:{forge:['>=0.7.0']},permissions:['todos.read']}));
  const handlers=new Map(),event={sender:{id:42}},state={win:{isDestroyed:()=>false,webContents:{id:42}}},originalLoad=Module._load,oldHome=process.env.CODEX_FORGE_HOME;
  let host;
  try{
    process.env.CODEX_FORGE_HOME=root;
    Module._load=function(specifier,...args){if(specifier==='electron')return {};return originalLoad.call(this,specifier,...args);};
    host=require('../runtime/forge-host.cjs').installForge({ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},host:()=>state,threadContext:()=>({threadId:'thread-workspace',cwd}),states:new Map([[42,state]]),notify:()=>{},open:()=>{},services:{todos:{read:threadId=>({threadId,items:[]})}}});
  }finally{Module._load=originalLoad;if(oldHome===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=oldHome;}
  t.after(async()=>{await host?.dispose();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('forge-api5-sdk-host-'));fs.rmSync(root,{recursive:true,force:true});});
  host.registry.setEnabled(id,true);const frameToken='sdk-host-frame-token-123';host.api5.registerFrame(event,{id,frameToken,fingerprint:host.registry.get(id).fingerprint});
  const h=loadSdk({dispatch:async request=>{const response=await handlers.get('forge:api')(event,{...request,id,frameToken});if(!response.ok)throw Object.assign(Error(response.error.message),{code:response.error.code});return response.result;}});
  await tick();
  const context=await h.api.context.get();assert.equal(context.threadId,'thread-workspace');
  assert.equal(host.registry.get(id).manifest.permissions.includes('conversation.read'),false);
  assert(host.snapshot(event,state).contextPlugins.includes(id));
  const result=await h.api.todos.request('read');assert.equal(result.threadId,'thread-workspace');
});

test('API 1–4 SDK adapters retain their declared version and legacy method payloads', async () => {
  for (const version of [1, 2, 3, 4]) {
    const h = loadSdk({ apiVersion: version }); await h.ready(); assert.equal(h.api.apiVersion, version); assert.equal(h.api.hostApiVersion, 5);
    const pending = h.api.composer.setText('new', 'old'); const request = h.requests.at(-1);
    assert.equal(request.method, 'composer.set'); assert.deepEqual(JSON.parse(JSON.stringify(request.args)), { text: 'new', expectedText: 'old' }); h.reply(request.id, { text: 'new' }); assert.equal((await pending).text, 'new');
  }
});

test('API 5 types infer streams, require revisions and retain explicit old API declarations', () => {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'tests/fixtures/sdk-api5.ts'], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'pipe' });
});

test('developer manifest schema advertises the actual API5 capabilities, hooks and slot names',()=>{
  const schema=require('../sdk/plugin.schema.json'),contract=require('../runtime/forge-api5-contract.cjs');
  const known=schema.properties.capabilities.items.allOf[0].if.properties.name.not.enum;
  assert.deepEqual([...known].sort(),Object.keys(require('../runtime/forge-capabilities.cjs').CAPABILITIES).sort());
  for(const permission of contract.permissions)assert(schema.properties.permissions.items.enum.includes(permission),'schema is missing '+permission);
  assert.deepEqual(schema.properties.contributes.properties.hooks.items.properties.name.enum,contract.hookNames);
  const slots=schema.properties.contributes.properties.slots.items;
  assert.deepEqual([...slots.properties.slot.enum].sort(),Object.keys(require('../runtime/forge-slots.cjs').SLOTS).sort());
  assert.equal(slots.properties.key.minLength,1);
  assert.deepEqual(slots.allOf[0].then.required,['key']);
});
