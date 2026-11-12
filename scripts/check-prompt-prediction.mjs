import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { predictPrompt } from '../runtime/prompt-prediction.cjs';
import { runLowPrediction } from '../runtime/prompt-prediction-runner.cjs';

const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'output');
const executable = path.resolve(process.argv[2] || '');
assert(process.argv[2] && fs.statSync(executable).isFile(), 'Provide the current verified codex.exe');
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(out, 'prediction-fixture-'));
const requests = [], notifications = [], rpcRequests = [], pending = new Map();
let child, lines, sequence = 0, mode = 'text', observedHeldRequest, heldClosed, stderr = '';
const heldRequest = new Promise(resolve => { observedHeldRequest = resolve; });
const closedRequest = new Promise(resolve => { heldClosed = resolve; });
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
    if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
    assert(!req.headers.authorization, 'Fixture must not receive credentials');
    const data = JSON.parse(bytes); requests.push(data);
    const sample = JSON.stringify(data).includes('Predict the next message the USER would type');
    if (sample && mode === 'hold') { res.on('close', heldClosed); observedHeldRequest(); return; }
    const answer = sample ? JSON.stringify({ suggestion: '请把验证结果整理成表格。' }) : 'The fixture task is complete.';
    const item = sample && mode === 'tool'
      ? { id: 'fc_' + requests.length, type: 'function_call', call_id: 'fixture_call', name: 'exec_command', arguments: '{"cmd":"echo FORGE_PREDICTION_TEST_TOOL"}', status: 'completed' }
      : { id: 'msg_' + requests.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const response = { id: 'resp_' + requests.length, object: 'response', created_at: 0, status: 'completed', model: data.model, output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } }];
    if (item.type === 'message') events.push({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: answer });
    events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [sequence_number, event] of events.entries()) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n');
    res.end();
  } catch (error) { res.writeHead(500); res.end(error.message); }
});

function call(method, params, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = 'prediction-fixture-' + ++sequence;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); };
    const abort = () => {
      cleanup();
      reject(signal?.reason || Error('Cancelled'));
    };
    const timer = setTimeout(() => { cleanup(); reject(Error('RPC timeout: ' + method + ' ' + stderr.slice(-800))); }, timeoutMs);
    if (signal?.aborted) { clearTimeout(timer); reject(signal.reason || Error('Cancelled')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    rpcRequests.push({ id, method, params });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

async function completedTurn(threadId) {
  const started = await call('turn/start', { threadId, input: [{ type: 'text', text: 'Finish the synthetic fixture task in one sentence.' }], effort: 'xhigh' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const done = notifications.find(value => value.method === 'turn/completed' && value.params?.threadId === threadId && value.params.turn.id === started.turn.id);
    if (done) { assert.equal(done.params.turn.status, 'completed'); return done.params.turn.id; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Fixture source turn did not complete: ' + stderr.slice(-800));
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="fixture"\nweb_search="disabled"\n[features]\nplugins=false\napps=false\nhooks=false\nshell_tool=false\napply_patch_freeform=false\nmulti_agent=false\n[model_providers.fixture]\nname="Local prediction fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const env = { ...process.env, CODEX_HOME: home, OTEL_SDK_DISABLED: 'true', NO_PROXY: '127.0.0.1,localhost' };
  for (const key of Object.keys(env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(key) || /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key) || key.startsWith('CODEX_FORGE_')) delete env[key];
  child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env, cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-6000); });
  child.on('error', error => { for (const value of [...pending.values()]) value.reject(error); });
  lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (waiting) message.error ? waiting.reject(Error(message.error.message)) : waiting.resolve(message.result);
    else if (message.id != null && message.method) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Fixture refuses tool, approval and user input requests' } }) + '\n');
      notifications.push(message);
    } else notifications.push(message);
  });
  await call('initialize', { clientInfo: { name: 'forge_prediction_regression', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const { thread } = await call('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'fixture', cwd: home, ephemeral: false, sandbox: 'read-only', approvalPolicy: 'never' });
  const sourceTurnId = await completedTurn(thread.id);
  const before = (await call('thread/read', { threadId: thread.id, includeTurns: true })).thread;
  const sourceTurnNotifications = notifications.filter(value => value.method === 'turn/started').length;
  const context = { call, sample: options => runLowPrediction({ ...options, executable, env }), threadId: thread.id, sourceTurnId };
  const prediction = await predictPrompt(context);
  assert.equal(prediction.text, '请把验证结果整理成表格。');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning.effort, 'xhigh');
  assert.equal(requests[1].reasoning.effort, 'low', 'Prediction must actually use low on the same model');
  assert.equal(requests[1].model, requests[0].model);
  assert.equal((requests[1].tools || []).length, 0, 'Prediction must not advertise tools');
  assert.equal(rpcRequests.filter(value => ['thread/sample','thread/start','turn/start'].includes(value.method)).length, 2, 'Only the source setup may start a main-connection turn');
  const resumed = await call('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed.reasoningEffort, 'xhigh', 'Sampling must preserve the source reasoning configuration');
  const previousRequests = requests.length;
  await assert.rejects(predictPrompt({ ...context, sourceTurnId: 'stale_turn' }));
  assert.equal(requests.length, previousRequests, 'Stale samples must fail before inference');
  mode = 'tool';
  await assert.rejects(predictPrompt(context), { code: 'PREDICTION_TOOL_REQUESTED' });
  assert.equal(requests.length, previousRequests + 1, 'A prediction must stop on a tool attempt without continuing inference');
  assert(!notifications.some(value => value.id != null && value.method), 'No tools or approvals may reach the fixture');
  mode = 'hold';
  const controller = new AbortController();
  const predicting = predictPrompt({ ...context, signal: controller.signal });
  await Promise.race([heldRequest, new Promise((_, reject) => { const timeout = setTimeout(() => reject(Error('No cancellable request reached fixture')), 10000); heldRequest.finally(() => clearTimeout(timeout)); })]);
  controller.abort();
  await assert.rejects(predicting, { code: 'PREDICTION_CANCELLED' });
  await Promise.race([closedRequest, new Promise((_, reject) => { const timeout = setTimeout(() => reject(Error('Prediction worker left its HTTP request alive')), 3000); closedRequest.finally(() => clearTimeout(timeout)); })]);
  const after = (await call('thread/read', { threadId: thread.id, includeTurns: true })).thread;
  assert.deepEqual(after.turns, before.turns, 'Sampling and cancellation must not mutate source turns');
  assert.equal(notifications.filter(value => value.method === 'turn/started').length, sourceTurnNotifications);
  await call('thread/unsubscribe', { threadId: thread.id });
  const report = { passed: true, provider: 'localhost fixture', credentialsSent: false, actualCli: executable, inheritedSource: true, sourceEffort: resumed.reasoningEffort, predictionEffort: requests[1].reasoning.effort, sameModel: true, prediction: prediction.text, toolSuppressed: true, staleRejectedBeforeInference: true, workerCancellation: true, sourceHistoryUnchanged: true, extraSourceTurns: 0, modelRequests: requests.length };
  fs.writeFileSync(path.join(out, 'prompt-prediction-native-regression.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  lines?.close();
  for (const value of [...pending.values()]) value.reject(Error('Fixture stopped'));
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(); child.kill();
    let exitTimer;
    await Promise.race([exited, new Promise(resolve => { exitTimer = setTimeout(resolve, 1000); })]);
    clearTimeout(exitTimer);
  }
  child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const real = fs.realpathSync(home);
  assert(real.startsWith(fs.realpathSync(out) + path.sep) && path.basename(real).startsWith('prediction-fixture-'));
  fs.rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
