const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CollaborationService, intent, tools, callTool } = require('../runtime/collaboration.cjs');
const { createParser, validateAgentConfig, resolveCommand, invocation, clean, probe } = require('../runtime/agent-cli.cjs');
const { alive, atomic } = require('../runtime/collaboration-store.cjs');
const { ApprovalQueue, ApprovalProcessor } = require('../runtime/approval-broker.cjs');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const host = { source: 'host', trusted: true, threadId: 'thread-a' };
function setup(t) {
  const destination = path.resolve(__dirname, '../output/collaboration-tests'); fs.mkdirSync(destination, { recursive: true });
  const root = fs.mkdtempSync(path.join(destination, 'case-'));
  const special = path.join(root, "空 格 [fixture] & 'quoted'"); fs.mkdirSync(special);
  const fixture = path.join(special, 'agent fixture & runner.cjs');
  fs.copyFileSync(path.join(__dirname, 'fixtures/agent.cjs'), fixture);
  const service = new CollaborationService({ root, nodePath: process.execPath });
  const configure = async (mode = 'ok', concurrency = 1) => service.dispatch('configure', { concurrency, agents: Object.fromEntries(['claude', 'grok', 'dsh'].map(agent => [agent, { command: process.execPath, args: [fixture, '--fixture-agent=' + agent, '--fixture-mode=' + mode] }])) }, host);
  const authorize = async (threadId = 'thread-a', text = '启用智能体协作') => {
    const captured = await service.captureUserPrompt(threadId, text, { source: 'user', trusted: true, cwd: special, eventId: 'user-' + Math.random() });
    return captured.authorizationPending ? service.approvePromptAuthorization(threadId, captured.authorizationPending.eventId, true, host) : captured;
  };
  t.after(async () => {
    for (const thread of service.store.threads()) for (const job of service.store.jobs(thread.id)) if (!terminal.has(job.status)) service.store.cancel(job.id);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && service.store.threads().some(thread => service.store.jobs(thread.id).some(job => !terminal.has(service.store.reconcile(job).status)))) await pause(100);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, configure, authorize, root, special, fixture };
}
async function finish(service, id, context = host, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let result;
  do { result = await service.dispatch('read', { jobId: id }, context); if (terminal.has(result.status)) return result; await pause(80); } while (Date.now() < deadline);
  throw new Error('fixture timeout: ' + JSON.stringify(result));
}
async function running(service, id) {
  for (let attempt = 0; attempt < 100; attempt++) { const job = service.store.job(id); if (job.status === 'running' && job.sequence > 0) return job; await pause(50); }
  throw new Error('fixture did not start');
}

test('prompt intent distinguishes delegation from discussion, quotation and negation', () => {
  for (const value of ['请介绍 Claude Code', '请比较 Claude Code 和 Grok Build', '怎么开启智能体协作？', '如何让 Claude Code 检查代码？', '例如“请让 Claude Code 审查”', '```\n启用智能体协作\n```', '加入智能体协作功能，支持连接 Claude Code 和 Grok Build', '添加一个按钮：开启智能体协作', '请为配置面板增加一个开启智能体协作的开关', '请给我实现一个调用 Claude Code 检查代码的功能', 'README 中写着 `开启智能体协作`', 'Explain how to ask Claude Code to review code']) assert.notEqual(intent(value).action, 'enable', value);
  for (const value of ['不要启用智能体协作', '请关闭智能体协作', 'Do not use sub-agents']) assert.equal(intent(value).action, 'disable', value);
  for (const value of ['启用智能体协作', '你可以派出两个子代理', '请让 Claude Code 和 Grok Build 协作检查', '请 Claude Code 帮我检查代码', '协作claude code，让它检查并修复这个问题', '与 Claude Code 协作，让它检查代码', 'Ask Claude Code to review this module', 'Use Grok Build to analyze the test failure']) assert.equal(intent(value).action, 'enable', value);
  assert.deepEqual(intent('请让 Claude Code 审查代码').agents, ['claude']);
  const reported = '此对话验证无限画布，智能体协作，代办清单。1.你帮我绘制一个画布，内容任意。2.协作claude code，让它：创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。3.创建代办清单，内容任意。';
  assert.deepEqual(intent(reported), { action: 'enable', agents: ['claude'] });
  assert.deepEqual(intent('协作 Claude Code，让它实现模型选择功能'), { action: 'enable', agents: ['claude'] });
});

test('explicit collaboration prompt waits for Codex manual approval before enabling this conversation', async t => {
  const { service, configure, special } = setup(t); await configure();
  const pending = await service.captureUserPrompt('thread-a', '启用智能体协作', { source: 'user', trusted: true, cwd: special, eventId: 'approval-1' });
  assert.equal(pending.enabled, false);
  assert.deepEqual(pending.authorizationPending.agents, ['claude', 'grok', 'dsh']);
  assert.equal(pending.authorizationPending.eventId, 'approval-1');
  await assert.rejects(service.dispatch('run', { agent: 'claude', task: 'should wait' }, host), /未获用户明确协作授权/);
  const denied = await service.approvePromptAuthorization('thread-a', 'approval-1', false, host);
  assert.equal(denied.enabled, false); assert.equal(denied.authorizationPending, null);

  const second = await service.captureUserPrompt('thread-a', '请让 Claude Code 检查代码', { source: 'user', trusted: true, cwd: special, eventId: 'approval-2' });
  const approved = await service.approvePromptAuthorization('thread-a', second.authorizationPending.eventId, true, host);
  assert.equal(approved.enabled, true); assert.deepEqual(approved.agents, ['claude']); assert.equal(approved.source, 'trusted-user-prompt');
});

test('disabled by default, model cannot fabricate user permission or change executable configuration', async t => {
  const { service, configure } = setup(t); await configure();
  assert.equal((await service.dispatch('thread', {}, host)).enabled, false);
  await assert.rejects(service.dispatch('run', { agent: 'claude', task: 'work', userAuthorized: true }, host), /未获用户明确协作授权/);
  await assert.rejects(service.captureUserPrompt('thread-a', '启用智能体协作', { source: 'model', trusted: true }), /真实用户提示词/);
  await assert.rejects(service.dispatch('configure', { concurrency: 3 }, { threadId: 'thread-a' }), /客户端面板/);
  assert.equal(fs.readdirSync(path.join(service.root, 'jobs')).length, 0);
  assert.equal(tools.some(tool => /authorize|capture/.test(tool.name)), false);
  assert.equal((await probe('claude', service.store.config().agents.claude, process.execPath)).available, true);
  for (const method of ['set_thread', 'direct', 'capabilities']) await assert.rejects(service.dispatch(method, { enabled: true, agent: 'claude', task: 'work', requestId: 'spoof' }, { threadId: 'thread-a' }), /真实用户操作/);
  assert.equal(tools.some(tool => /set_thread|direct|capabilities/.test(tool.name)), false);
});

test('missing approval settings migrate to the requested per-agent defaults', async t => {
  const { service, configure } = setup(t); await configure();
  const config = service.store.config();
  assert.equal(config.agents.claude.approvalMode, 'native');
  assert.equal(config.agents.grok.approvalMode, 'native');
  assert.equal(config.agents.dsh.approvalMode, 'codex');
});

test('Codeg delegation aliases preserve task ids, batch status shape and lifecycle events', async t => {
  const { service, configure, authorize } = setup(t); await configure(); await authorize();
  const started = await callTool(service, 'delegate_to_agent', { agent_type: 'claude_code', task: 'codeg alias' }, host);
  assert.match(started.task_id, /^[A-Za-z0-9_-]+$/); assert.equal(started.status, 'running'); assert.equal(started.agent_type, 'claude_code');
  assert.equal(service.store.job(started.task_id).source, 'trusted-user-collaboration');
  const status = await callTool(service, 'get_delegation_status', { task_ids: [started.task_id], wait_ms: 10000 }, host);
  assert.deepEqual(Object.keys(status), ['tasks']); assert.equal(status.tasks.length, 1); assert.equal(status.tasks[0].task_id, started.task_id); assert.equal(status.tasks[0].status, 'completed'); assert.match(status.tasks[0].text, /codeg alias/);
  const read = await service.dispatch('read', { jobId: started.task_id }, host); assert(read.events.some(event => event.type === 'delegation_started')); assert(read.events.some(event => event.type === 'delegation_completed'));
  const saved = service.store.job(started.task_id); saved.status = 'interrupted'; saved.finishedAt = new Date().toISOString(); saved.error = 'fixture interruption'; service.store.saveJob(saved);
  const resumed = await callTool(service, 'resume_delegation', { task_id: started.task_id, reason: '测试恢复' }, host); assert.equal(resumed.task_id, started.task_id); assert.equal(resumed.status, 'running');
  const resumedStatus = await callTool(service, 'get_delegation_status', { task_ids: [started.task_id], wait_ms: 10000 }, host); assert.equal(resumedStatus.tasks[0].status, 'completed'); assert.match(resumedStatus.tasks[0].text, /codeg alias/);
});

test('Codeg status with zero wait returns immediately for a running task', async t => {
  const { service, configure, authorize } = setup(t); await configure('hold'); await authorize();
  const started = await callTool(service, 'delegate_to_agent', { agent_type: 'claude_code', task: 'zero wait' }, host);
  await running(service, started.task_id);
  const began = Date.now();
  const status = await callTool(service, 'get_delegation_status', { task_ids: [started.task_id], wait_ms: 0 }, host);
  assert.equal(status.tasks[0].task_id, started.task_id);
  assert.equal(status.tasks[0].status, 'running');
  assert.ok(Date.now() - began < 1000, 'wait_ms=0 must not block');
  await service.dispatch('cancel', { jobId: started.task_id }, host); await finish(service, started.task_id);
});

test('reported real user prompt enables Claude and panel control has revision guards and revocation', async t => {
  const { service, configure, authorize } = setup(t); await configure();
  const original = '此对话验证无限画布，智能体协作，代办清单。1.你帮我绘制一个画布，内容任意。2.协作claude code，让它：创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画。3.创建代办清单，内容任意。';
  const captured = await authorize('thread-a', original); assert.equal(captured.enabled, true); assert.deepEqual(captured.agents, ['claude']);
  const off = await service.dispatch('set_thread', { enabled: false, expectedRevision: captured.revision }, host); assert.equal(off.enabled, false);
  await assert.rejects(service.dispatch('set_thread', { enabled: true, expectedRevision: captured.revision }, host), /已更新/);
  const on = await service.dispatch('set_thread', { enabled: true, agents: ['grok'], expectedRevision: off.revision }, host); assert.equal(on.source, 'trusted-user-panel'); assert.deepEqual(on.agents, ['grok']);
  await assert.rejects(service.dispatch('run', { agent: 'claude', task: 'not allowed' }, host), /授权范围/);
  const job = await service.dispatch('run', { agent: 'grok', task: 'allowed' }, host); assert.equal((await finish(service, job.id)).status, 'completed');
});

test('DSH configuration fills the declared provider for a selected model without changing other agents', async t => {
  const { service, configure } = setup(t); await configure(); const before = service.store.config();
  service.capabilities = async () => ({ models: [{ id: 'declared-model', provider: 'declared-provider' }], defaultModel: 'native-model', defaultProvider: 'native-provider' });
  const chosen = await service.dispatch('configure', { agents: { dsh: { ...before.agents.dsh, model: 'declared-model', provider: '', reasoningEffort: 'high' } } }, host);
  assert.equal(chosen.agents.dsh.provider, 'declared-provider'); assert.equal(chosen.agents.dsh.reasoningEffort, 'high'); assert.deepEqual(chosen.agents.claude, before.agents.claude);
  await assert.rejects(service.dispatch('configure', { agents: { dsh: { ...before.agents.dsh, model: 'unknown-model', provider: '' } } }, host), /填写提供商/);
});

test('composer direct sends once, keeps configured choices for blank selections, and resumes only same-thread native session', async t => {
  const { service, configure, special } = setup(t); await configure(); const context = { ...host, cwd: special };
  const config = service.store.config().agents.claude;
  await service.dispatch('configure', { agents: { claude: { ...config, model: 'sonnet', reasoningEffort: 'high' } } }, host);
  const args = { agent: 'claude', task: 'first message', requestId: 'direct-1', model: '', reasoningEffort: '' };
  const [a, b] = await Promise.all([service.dispatch('direct', args, context), service.dispatch('direct', args, context)]);
  assert.equal(a.id, b.id); assert.equal(service.store.jobs(host.threadId).length, 1); assert.equal(a.model, 'sonnet'); assert.equal(a.reasoningEffort, 'high');
  assert.equal(service.store.thread(host.threadId).source, 'trusted-user-direct');
  const result = await finish(service, a.id); assert.equal(result.status, 'completed');
  assert.equal((await service.dispatch('direct', args, context)).id, a.id);
  await assert.rejects(service.dispatch('direct', { ...args, task: 'different content' }, context), /不同内容/);
  const next = await service.dispatch('direct', { ...args, requestId: 'direct-2', task: 'follow-up' }, context);
  assert.equal(service.store.job(next.id).resumeSessionId, result.sessionId); assert.equal(next.resumedFrom, a.id); await finish(service, next.id);
  const other = await service.dispatch('direct', { ...args, requestId: 'direct-3' }, { ...context, threadId: 'thread-b' }); assert.equal(service.store.job(other.id).resumeSessionId, undefined); await finish(service, other.id, { ...context, threadId: 'thread-b' });
  await assert.rejects(service.dispatch('direct', { ...args, requestId: 'direct-4', cwd: path.dirname(special) }, context), /工作目录/);
  await assert.rejects(service.dispatch('direct', { ...args, requestId: 'direct-5', reasoningEffort: 'ultra' }, context), /未声明/);
  const native = invocation('claude', service.store.job(a.id).agentConfig, { sessionId: result.sessionId });
  assert.deepEqual(native.args.slice(-6), ['--model', 'sonnet', '--effort', 'high', '--resume', result.sessionId]);
});

test('direct rejects a second active turn and worker receives agent-specific model, reasoning and resume flags', async t => {
  const { service, configure, special } = setup(t); await configure('hold'); const context = { ...host, cwd: special };
  const first = await service.dispatch('direct', { agent: 'claude', task: 'hold', requestId: 'busy-1' }, context); await running(service, first.id);
  await assert.rejects(service.dispatch('direct', { agent: 'claude', task: 'second', requestId: 'busy-2' }, context), /仍在处理/);
  await service.dispatch('cancel', { jobId: first.id }, context); await finish(service, first.id);
  const config = { ...service.store.config().agents.grok, model: 'selected-model', reasoningEffort: 'high' };
  const native = invocation('grok', config, { sessionId: 'native-session' });
  assert(native.args.includes('--reasoning-effort')); assert.equal(native.protocol, 'acp');
  assert.deepEqual(native.args.slice(-3), ['agent', '--no-leader', 'stdio']);

});

test('captured user request restricts agent scope and isolates every read, wait and cancel by conversation', async t => {
  const { service, configure, authorize } = setup(t); await configure(); await authorize('thread-a', '请让 Claude Code 审查代码');
  await assert.rejects(service.dispatch('run', { agent: 'grok', task: 'work' }, host), /授权范围/);
  const job = await callTool(service, 'collaboration_run', { agent: 'claude', task: 'review' }, host);
  await authorize('thread-b');
  for (const method of ['read', 'wait', 'cancel']) await assert.rejects(service.dispatch(method, { jobId: job.id }, { threadId: 'thread-b' }), /其他对话/);
  await assert.rejects(service.dispatch('list', { threadId: 'thread-b' }, host), /其他对话/);
  assert.deepEqual(await service.dispatch('list', {}, { threadId: 'thread-b' }), []);
  const result = await finish(service, job.id); assert.equal(result.status, 'completed'); assert.equal(result.finalText, '中文 🦆 review');
});

test('native protocols preserve chunked Unicode text, output cursor and metacharacter paths without a shell', async t => {
  const { service, configure, authorize, special } = setup(t); await configure(); await authorize();
  const task = 'literal $() & | "quoted" C:\\file\\x 中文';
  for (const agent of ['claude', 'grok', 'dsh']) {
    const job = await service.dispatch('run', { agent, task, cwd: special }, host);
    const result = await finish(service, job.id); assert.equal(result.status, 'completed', result.error); assert.equal(result.finalText, '中文 🦆 ' + task);
    assert.equal(result.events.filter(event => event.type === 'text').map(event => event.text).join(''), result.finalText);
    assert.deepEqual((await service.dispatch('read', { jobId: job.id, afterSeq: result.nextSeq }, host)).events, []);
  }
  assert.throws(() => validateAgentConfig({ command: 'node --eval evil()' }), /独立参数列表/);
  const resolved = resolveCommand('claude', { command: process.execPath }); assert.equal(resolved.prefix.length, 0);
});

test('failure, timeout, running cancellation and revoked authorization preserve output and finish state', async t => {
  const { service, configure, authorize } = setup(t); await configure('fail'); await authorize();
  let job = await service.dispatch('run', { agent: 'claude', task: 'fail' }, host), result = await finish(service, job.id);
  assert.equal(result.status, 'failed'); assert.match(result.error, /7/); assert.equal(result.events.some(event => event.text.includes('example-secret-value')), false);
  await configure('hold'); job = await service.dispatch('run', { agent: 'claude', task: 'hold' }, host); await running(service, job.id);
  await service.dispatch('cancel', { jobId: job.id }, host); result = await finish(service, job.id); assert.equal(result.status, 'cancelled'); assert.equal(result.events[0].text, 'started');
  job = await service.dispatch('run', { agent: 'claude', task: 'timeout', timeoutMs: 1000 }, host); result = await finish(service, job.id); assert.equal(result.status, 'failed'); assert.match(result.error, /超时/);
  job = await service.dispatch('run', { agent: 'claude', task: 'revoke' }, host); await running(service, job.id); await authorize('thread-a', '不要使用智能体协作'); result = await finish(service, job.id); assert.equal(result.status, 'cancelled');
});

test('global concurrency is shared across service instances and queued cancellation never starts the child', async t => {
  const { service, configure, authorize, root } = setup(t); await configure('hold'); await authorize();
  const first = await service.dispatch('run', { agent: 'claude', task: 'first' }, host); await running(service, first.id);
  const secondService = new CollaborationService({ root, nodePath: process.execPath });
  const second = await secondService.dispatch('run', { agent: 'grok', task: 'second' }, host); await pause(400);
  assert.equal(service.store.job(second.id).status, 'queued'); assert.equal(service.store.job(second.id).childPid, undefined);
  await secondService.dispatch('cancel', { jobId: second.id }, host); const cancelled = await finish(service, second.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.events.length, 0);
  await service.dispatch('cancel', { jobId: first.id }, host); await finish(service, first.id);
});

test('a task survives its submitting process exit and can be read from a new service', async t => {
  const { service, configure, authorize, root } = setup(t); await configure(); await authorize();
  const submit = path.join(root, 'submitter.cjs');
  fs.writeFileSync(submit, `const {CollaborationService}=require(${JSON.stringify(path.resolve(__dirname, '../runtime/collaboration.cjs'))});new CollaborationService({root:process.argv[2],nodePath:process.execPath}).dispatch('run',{agent:'claude',task:'survive'},{threadId:'thread-a'}).then(job=>console.log(job.id));`);
  let output = '';
  const child = spawn(process.execPath, [submit, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', value => { output += value; });
  const exit = await new Promise(resolve => child.on('close', resolve)); assert.equal(exit, 0);
  const result = await finish(new CollaborationService({ root }), output.trim()); assert.equal(result.status, 'completed'); assert.equal(result.finalText, '中文 🦆 survive');
});

test('unexpected worker loss is reported interrupted without retrying already-started work', async t => {
  const { service, configure, authorize } = setup(t); await configure(); await authorize();
  const job = await service.dispatch('run', { agent: 'claude', task: 'complete' }, host); await finish(service, job.id);
  const saved = service.store.job(job.id); saved.status = 'running'; saved.finishedAt = undefined; service.store.saveJob(saved);
  atomic(service.store.file('control', job.id, '.owner'), { pid: 2147483646, updatedAt: new Date().toISOString() }); assert.equal(alive(2147483646), false);
  assert.equal(service.store.reconcile(service.store.job(job.id)).status, 'running', 'a fresh heartbeat wins over an isolated failed process probe');
  atomic(service.store.file('control', job.id, '.owner'), { pid: 2147483646, updatedAt: new Date(Date.now() - 11000).toISOString() });
  const restored = new CollaborationService({ root: service.root }); const read = await restored.dispatch('read', { jobId: job.id }, host);
  assert.equal(read.status, 'interrupted'); assert.match(read.error, /意外结束/); assert.equal(read.finalText, '中文 🦆 complete');
  assert.equal(service.store.jobs('thread-a').length, 1);
  saved.status = 'queued'; service.store.saveJob(saved);
  atomic(service.store.file('control', job.id, '.owner'), { pid: process.pid, updatedAt: new Date(Date.now() - 120000).toISOString() });
  assert.equal((await restored.dispatch('read', { jobId: job.id }, host)).status, 'interrupted', 'a stale PID reused after restart cannot leave a task pending forever');
});

test('atomic retries a transient Windows rename collision', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-retry-'));
  const file = path.join(directory, 'record.json');
  const originalRename = fs.renameSync;
  let transientFailures = 2;
  fs.renameSync = (source, target) => {
    if (target === file && transientFailures > 0) {
      transientFailures--;
      const error = Error('sharing violation'); error.code = 'EPERM'; throw error;
    }
    return originalRename(source, target);
  };
  let saved;
  try { atomic(file, { status: 'running' }); saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  finally { fs.renameSync = originalRename; fs.rmSync(directory, { recursive: true, force: true }); }
  assert.equal(transientFailures, 0);
  assert.deepEqual(saved, { status: 'running' });
});

test('all three worker protocols suspend for approval, resume once, and never report a denied action completed', async t => {
  const { service, configure, authorize } = setup(t); await configure('approval'); await authorize();
  const queue = new ApprovalQueue(service.store);
  for (const agent of ['claude', 'grok', 'dsh']) for (const allow of [true, false]) {
    const job = await service.dispatch('run', { agent, task: 'exact requested content' }, host);
    let pending;
    for (let i = 0; i < 100; i++) { pending = queue.list().find(r => r.jobId === job.id); if (pending && service.store.job(job.id).status === 'awaiting_approval') break; await pause(50); }
    assert(pending, agent + ' permission did not arrive'); assert.equal(service.store.job(job.id).status, 'awaiting_approval');
    assert.equal(pending.action.input.content, 'exact requested content');
    const processor = new ApprovalProcessor({ queue, review: async () => ({ decision: allow ? 'allow' : 'manual', reason: 'fixture' }), human: async () => ({ approved: false }) });
    await processor.process(pending.id);
    const result = await finish(service, job.id); assert.equal(result.status, allow ? 'completed' : 'failed', agent + ': ' + result.error);
    assert.equal(result.approval.state, allow ? 'allowed' : 'denied');
    assert(service.store.job(job.id).userRequest.includes('启用智能体协作'));
  }
});

test('worker rejects Claude host-less textual permission denial without permission_denials metadata', async t => {
  const { service, configure, authorize } = setup(t); await configure('host-denial'); await authorize();
  const job = await service.dispatch('run', { agent: 'claude', task: 'write the requested file' }, host);
  const result = await finish(service, job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /未获批准|权限/); assert.match(result.finalText, /action was NOT performed/);
});

test('parser accepts byte boundaries and redacts credentials in persisted event text', () => {
  const values = [], parser = createParser('dsh', (type, text) => values.push({ type, text: clean(text) }));
  const data = Buffer.from(JSON.stringify({ type: 'text', text: '中文🦆' }) + '\n' + JSON.stringify({ type: 'final', text: '完成' }) + '\n');
  for (const byte of data) parser.write(Buffer.from([byte]));
  assert.equal(parser.finish().finalText, '完成'); assert.equal(values[0].text, '中文🦆');
  assert.equal(clean('Authorization: Bearer secret-value api_key=secret-other').includes('secret-value'), false);
  const native = [], grok = createParser('grok', (type, text) => native.push({ type, text }));
  for (const event of [{ type: 'message_start', message: { role: 'assistant' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Grok ' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'wire result' } }, { type: 'message_stop' }]) grok.write(Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(grok.finish().finalText, 'Grok wire result');
  const claude = createParser('claude', (type, text) => native.push({ type, text }));
  claude.write(Buffer.from(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool response is preserved' }] } }) + '\n'));
  claude.finish(); assert.equal(native.at(-1).text, 'tool response is preserved');
});
