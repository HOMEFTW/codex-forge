'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { INSTRUCTIONS } = require('./prompt-prediction.cjs');
const failure = (code, message) => Object.assign(new Error(message), { code });
const allowedItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);

async function lowPredictionWithRpc({ call, subscribe, signal, stop = () => {}, cwd, sourceThreadId, model, modelProvider, serviceTier = null, prompt, maxChars }) {
  if (signal?.aborted) throw signal.reason || failure('PREDICTION_CANCELLED', '预测已取消');
  const original = await call('config/read', { includeLayers: false });
  const config = { model_reasoning_effort: 'low', web_search: 'disabled', 'features.shell_tool': false, 'features.unified_exec': false,
    'features.multi_agent': false, 'features.apps': false, 'features.code_mode': false, 'features.code_mode_host': false,
    'features.plugins': false, 'features.hooks': false, 'features.computer_use': false, 'features.browser_use': false,
    'features.browser_use_external': false, 'features.skill_search': false, 'features.sleep_tool': false, 'features.goals': false,
    'features.workspace_dependencies': false, 'features.view_image': false, 'features.skip_host_skill_discovery': true };
  for (const name of Object.keys(original.config?.mcp_servers || {})) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw failure('PREDICTION_UNAVAILABLE', '无法关闭当前配置中的预测工具');
    config['mcp_servers.' + name + '.enabled'] = false;
  }
  const created = await call('thread/start', { model, modelProvider, serviceTier, allowProviderModelFallback: false, ephemeral: true, experimentalRawEvents: true,
    cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', environments: [], dynamicTools: [], config,
    baseInstructions: INSTRUCTIONS, developerInstructions: INSTRUCTIONS, threadSource: 'forge_prompt_prediction' });
  const id = created?.thread?.id;
  const own = typeof id === 'string' && id !== sourceThreadId && created.thread.ephemeral === true && !created.thread.path && !created.thread.forkedFromId;
  if (!own || created.model !== model || created.modelProvider !== modelProvider || created.reasoningEffort !== 'low' || serviceTier !== null && created.serviceTier !== serviceTier) throw failure('PREDICTION_UNAVAILABLE', '无法确认临时预测使用当前模型的 low 档');
  let ended = false, turnId, text = '', finalText = '', resolveTurn, rejectTurn;
  const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; }); done.catch(() => {});
  const fail = error => { if (!ended) { ended = true; rejectTurn(error); stop(error); } };
  const abort = () => fail(signal.reason || failure('PREDICTION_CANCELLED', '预测已取消'));
  const unsubscribe = subscribe(message => {
    const p = message.params || {};
    if (ended || p.threadId !== id || turnId && p.turnId && p.turnId !== turnId) return;
    if (message.method === 'rawResponseItem/completed' && /_call(?:_output)?$/.test(p.item?.type || '') ||
      ['item/started', 'item/completed'].includes(message.method) && !allowedItems.has(p.item?.type)) {
      fail(failure('PREDICTION_TOOL_REQUESTED', '预测模型尝试调用工具，已停止')); return;
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (['final', 'final_answer'].includes(p.item.phase)) finalText = p.item.text || '';
      else if (!p.item.phase) text += p.item.text || '';
      if (text.length + finalText.length > 20000) fail(failure('PREDICTION_UNAVAILABLE', '预测回答过长'));
    }
    if (message.method === 'error' && !p.willRetry) fail(failure('PREDICTION_UNAVAILABLE', '预测推理失败'));
    if (message.method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) {
      if (p.turn?.status !== 'completed') fail(failure('PREDICTION_UNAVAILABLE', '预测回合未成功结束'));
      else { ended = true; resolveTurn(finalText || text); }
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason || failure('PREDICTION_CANCELLED', '预测已取消');
    const started = await call('turn/start', { threadId: id, effort: 'low', serviceTierForTurn: serviceTier ?? 'default', environments: [],
      input: [{ type: 'text', text: prompt }], turnTrigger: 'forge_prompt_prediction',
      outputSchema: { type: 'object', properties: { suggestion: { type: ['string', 'null'], maxLength: maxChars } }, required: ['suggestion'], additionalProperties: false } });
    turnId = started?.turn?.id;
    if (!turnId) throw failure('PREDICTION_UNAVAILABLE', '预测回合未就绪');
    return await done;
  } finally { ended = true; unsubscribe(); signal?.removeEventListener('abort', abort); }
}

async function runLowPrediction({ executable, signal, timeoutMs = 30000, env = process.env, ...context }) {
  if (signal?.aborted) throw signal.reason || failure('PREDICTION_CANCELLED', '预测已取消');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-forge-prediction-'));
  let child, lines, deadline, ended = false, failed, sequence = 0;
  const pending = new Map(), listeners = new Set(), controller = new AbortController();
  const fail = error => { failed ||= error; controller.abort(error); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const stop = error => { fail(error); child?.kill(); };
  const abort = () => stop(signal.reason || failure('PREDICTION_CANCELLED', '预测已取消'));
  try {
    const args = ['app-server', '--listen', 'stdio://', '-c', 'notify=[]', '-c', 'features.hooks=false',
      ...(env.CODEX_FORGE_MODEL_CATALOG ? ['-c', 'model_catalog_json=' + JSON.stringify(env.CODEX_FORGE_MODEL_CATALOG)] : [])];
    child = spawn(executable, args, { cwd, env: { ...env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    child.on('error', () => fail(failure('PREDICTION_UNAVAILABLE', '预测后端启动失败')));
    child.on('exit', () => { if (!ended) fail(failure('PREDICTION_UNAVAILABLE', '预测后端已退出')); });
    child.stdin.on('error', () => fail(failure('PREDICTION_UNAVAILABLE', '预测连接已关闭')));
    child.stderr.resume();
    signal?.addEventListener('abort', abort, { once: true });
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 4 * 1024 * 1024) { stop(failure('PREDICTION_UNAVAILABLE', '预测协议消息过长')); return; }
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && message.method) { stop(failure('PREDICTION_TOOL_REQUESTED', '预测请求了工具或权限，已停止')); return; }
      const waiting = pending.get(message.id);
      if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); message.error ? waiting.reject(failure(message.error.code || 'PREDICTION_UNAVAILABLE', String(message.error.message || '预测不可用').slice(0, 300))) : waiting.resolve(message.result); }
      else for (const listener of listeners) listener(message);
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      if (failed || ended || child.exitCode !== null || child.stdin.destroyed) { reject(failed || failure('PREDICTION_UNAVAILABLE', '预测进程已结束')); return; }
      const id = ++sequence, timer = setTimeout(() => stop(failure('TIMEOUT', '预测接口超时')), Math.min(timeoutMs, 15000));
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    deadline = setTimeout(() => stop(failure('TIMEOUT', '预测超时')), timeoutMs);
    try {
      if (signal?.aborted) throw signal.reason || failure('PREDICTION_CANCELLED', '预测已取消');
      await call('initialize', { clientInfo: { name: 'forge_prompt_prediction', version: '0.7.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
      return await lowPredictionWithRpc({ ...context, cwd, call, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, signal: controller.signal, stop });
    } finally {
      ended = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort); fail(failure('PREDICTION_CANCELLED', '预测已结束'));
      lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
    }
  } finally {
    try { const real = fs.realpathSync(cwd), base = fs.realpathSync(os.tmpdir()); if (real.startsWith(base + path.sep) && path.basename(real).startsWith('codex-forge-prediction-') && !fs.lstatSync(cwd).isSymbolicLink()) await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
}
module.exports = { runLowPrediction, lowPredictionWithRpc };
