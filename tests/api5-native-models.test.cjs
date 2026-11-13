'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { ForgeNativeModels } = require('../runtime/forge-model-runtime.cjs');
const fixtureSource = String.raw`
  const readline=require('node:readline'), mode=process.argv[2], thread='isolated-fixture', turn='turn-fixture';
  const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
  const notification=(method,params)=>({method,params:{threadId:thread,turnId:turn,...params}});
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function emit(){
    if(mode==='hang')return;
    if(mode==='tool-started'){out(notification('item/started',{item:{type:'commandExecution',id:'dangerous'}}));return;}
    if(mode==='approval'){out({id:999,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn}});return;}
    if(mode==='exit'){out(notification('item/agentMessage/delta',{delta:'partial'}));setTimeout(()=>process.exit(9),10);return;}
    if(mode==='large'){
      for(let i=0;i<6;i++){out(notification('item/agentMessage/delta',{delta:'x'.repeat(400000)}));await delay(10);}
    } else {
      out(notification('item/agentMessage/delta',{delta:'A'}));await delay(25);
      out(notification('item/agentMessage/delta',{delta:'B'}));
      out(notification('item/completed',{item:{type:'agentMessage',text:'AB'}}));
      out(notification('thread/tokenUsage/updated',{tokenUsage:{total:{outputTokens:2}}}));
    }
    out(notification('turn/completed',{turn:{id:turn,status:'completed'}}));
  }
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line), p=message.params||{};
    if(message.method==='initialize')out({id:message.id,result:{}});
    else if(message.method==='config/read')out({id:message.id,result:{config:{mcp_servers:{fixture:{command:'unused'}}}}});
    else if(message.method==='thread/start')out({id:message.id,result:{thread:{id:thread,ephemeral:true},modelProvider:'fixture',model:mode==='wrong-model'?'unexpected':p.model}});
    else if(message.method==='turn/start'){
      if(mode==='noise'){
        process.stdout.write(JSON.stringify({id:message.id,result:{turn:{id:turn}}})+'\n'+JSON.stringify(notification('item/agentMessage/delta',{turnId:'other-turn',delta:'FOREIGN'}))+'\n');
      }else out({id:message.id,result:{turn:{id:turn}}});
      setTimeout(()=>void emit(),10);
    }
  });
`;
function setup(t, mode = 'normal') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-native-fixture-')), source = path.join(root, 'app-server.cjs'), calls = [], processes = [], directories = [];
  fs.writeFileSync(source, fixtureSource);
  const models = new ForgeNativeModels({ executable: 'fixture-only', env: process.env, spawnImpl: (executable, args, options) => {
    const child = spawn(process.execPath, [source, mode], options); processes.push(child); directories.push(options.cwd);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...rest) => { for (const line of String(data).trim().split('\n')) if (line) calls.push(JSON.parse(line)); return write(data, ...rest); };
    return child;
  } });
  t.after(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    for (const directory of directories) if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('forge-api5-sample-')) await fs.promises.rm(directory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = { threadId: 'original-thread', model: 'fixture-model', provider: 'fixture', effort: 'low' };
  return { models, calls, processes, directories, context };
}
function clean(f) { for (const directory of f.directories) assert.equal(fs.existsSync(directory), false, 'temporary sampling directory must be removed'); for (const child of f.processes) assert.notEqual(child.exitCode ?? child.signalCode, null, 'app-server process must have exited'); }
test('API5 native model sampling uses a separate ephemeral read-only thread and streams deltas', async t => {
  const f = setup(t), stream = f.models.stream({ prompt: 'fixture', timeoutMs: 2000 }, f.context);
  assert.deepEqual(await stream.next(), { value: { type: 'text', text: 'A' }, done: false });
  assert.deepEqual(await stream.next(), { value: { type: 'text', text: 'B' }, done: false });
  assert.equal((await stream.next()).value.type, 'usage'); assert.equal((await stream.next()).done, true);
  const create = f.calls.find(item => item.method === 'thread/start').params;
  assert.equal(create.ephemeral, true); assert.equal(create.sandbox, 'read-only'); assert.equal(create.approvalPolicy, 'never'); assert.equal(create.allowProviderModelFallback, false);
  assert.deepEqual(create.dynamicTools, []); assert.deepEqual(create.environments, []);
  assert.equal(create.config['mcp_servers.fixture.enabled'], false); assert.equal(create.config['features.shell_tool'], false);
  assert.equal(f.calls.find(item => item.method === 'turn/start').params.threadId, 'isolated-fixture'); clean(f);
});
test('API5 native model sampling aggregates text once and preserves usage', async t => {
  const f = setup(t);
  assert.deepEqual(await f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context), { text: 'AB', usage: { total: { outputTokens: 2 } } }); clean(f);
});
test('API5 native sampling refuses server-side tool or approval requests', async t => {
  const f = setup(t, 'approval');
  await assert.rejects(f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context), { code: 'PERMISSION_DENIED' }); clean(f);
});
test('API5 native sampling refuses a tool as soon as it starts', async t => {
  const f = setup(t, 'tool-started');
  await assert.rejects(f.models.sample({ prompt: 'fixture', timeoutMs: 150 }, f.context), { code: 'PERMISSION_DENIED' }); clean(f);
});
test('API5 native sampling isolates notifications from another turn in the same protocol packet', async t => {
  const f = setup(t, 'noise');
  const result = await f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context);
  assert.equal(result.text, 'AB'); clean(f);
});
test('API5 native sampling validates the actual model returned by the backend', async t => {
  const f = setup(t, 'wrong-model');
  await assert.rejects(f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context), /模型|采样上下文/); clean(f);
});
test('API5 native sampling cancellation returns a stable error and removes its process and files', async t => {
  const f = setup(t, 'hang'), controller = new AbortController();
  const pending = f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { code: 'CANCELLED' }); clean(f);
});
test('API5 native sampling timeout and early process exit clean the isolated context', async t => {
  const timed = setup(t, 'hang');
  await assert.rejects(timed.models.sample({ prompt: 'fixture', timeoutMs: 80 }, timed.context), { code: 'TIMEOUT' }); clean(timed);
  const exited = setup(t, 'exit');
  await assert.rejects(exited.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, exited.context), { code: 'BACKEND_EXITED' }); clean(exited);
});
test('API5 invalid sampling options do not leave a temporary directory', async t => {
  const f = setup(t), mkdtemp = fs.mkdtempSync, created = [];
  fs.mkdtempSync = (...args) => { const directory = mkdtemp(...args); if (path.basename(directory).startsWith('forge-api5-sample-')) created.push(directory); return directory; };
  try {
    await assert.rejects(f.models.sample({ prompt: 'fixture', timeoutMs: 0 }, f.context), { code: 'INVALID_ARGUMENT' });
    assert.equal(created.filter(directory => fs.existsSync(directory)).length, 0, 'invalid arguments must not leak a directory');
  } finally { fs.mkdtempSync = mkdtemp; for (const directory of created) fs.rmSync(directory, { recursive: true, force: true }); }
});
test('API5 native unary sampling bounds accumulated output even when the stream is drained', async t => {
  const f = setup(t, 'large');
  await assert.rejects(f.models.sample({ prompt: 'fixture', timeoutMs: 2000 }, f.context), { code: 'RESOURCE_EXHAUSTED' }); clean(f);
});
