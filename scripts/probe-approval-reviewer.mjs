import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output'); fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, 'approval-reviewer-'));
const reviewerHome = path.join(fixture, 'codex-home'), workspace = path.join(fixture, 'workspace');
fs.mkdirSync(reviewerHome); fs.mkdirSync(workspace);
const executable = path.join(root, 'release/package-full/app/resources/codex.exe');
const reviewerPath = path.join(root, 'runtime/approval-reviewer.cjs');
const selectedModel = process.argv[2] || 'gpt-6.1-sol', selectedEffort = process.argv[3] || 'high';
const provider = 'local_approval_probe', marker = path.join(fixture, 'mcp-was-started.txt');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const providerRequests = [], processTraces = [], processExits = [], cases = [];
let activeCase;

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
    if (req.headers['content-encoding'] === 'deflate') bytes = zlib.inflateSync(bytes);
    if (req.headers['content-encoding'] === 'zstd' && zlib.zstdDecompressSync) bytes = zlib.zstdDecompressSync(bytes);
    const body = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
    providerRequests.push({ case: activeCase?.decision, method: req.method, url: req.url, body });
    if (req.method === 'GET' && /\/models(?:\?|$)/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: selectedModel, object: 'model' }] })); return;
    }
    if (req.method !== 'POST' || !/\/responses(?:\?|$)/.test(req.url) || !activeCase) {
      res.writeHead(404); res.end('Local fixture accepts only Responses requests'); return;
    }
    const text = JSON.stringify({ decision: activeCase.decision, reason: activeCase.reason });
    const message = { type: 'message', id: 'msg_approval_probe', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: 'resp_' + activeCase.decision, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: selectedModel, output: [message], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    if (!body?.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let sequence = 0;
    const event = value => res.write('event: ' + value.type + '\ndata: ' + JSON.stringify({ ...value, sequence_number: sequence++ }) + '\n\n');
    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    event({ type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event({ type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: text });
    event({ type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text });
    event({ type: 'response.content_part.done', output_index: 0, item_id: message.id, content_index: 0, part: message.content[0] });
    event({ type: 'response.output_item.done', output_index: 0, item: message });
    event({ type: 'response.completed', response }); res.end();
  } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const tripwire = path.join(fixture, 'mcp-tripwire.cjs');
fs.writeFileSync(tripwire, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'MCP unexpectedly started');process.exit(1);`);
const configPath = path.join(reviewerHome, 'config.toml'), authPath = path.join(reviewerHome, 'auth.json');
const config = `model=${JSON.stringify(selectedModel)}\nmodel_provider=${JSON.stringify(provider)}\nmodel_reasoning_effort="low"\nweb_search="disabled"\n[features]\nplugins=false\napps=false\n[model_providers.${provider}]\nname="Local approval reviewer fixture"\nbase_url=${JSON.stringify(baseUrl)}\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.approval_probe_tripwire]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(tripwire)}]\nenabled=true\nstartup_timeout_sec=2\n`;
fs.writeFileSync(configPath, config); fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'fixture-only-not-a-real-key' }));
const configBefore = digest(fs.readFileSync(configPath)), authBefore = digest(fs.readFileSync(authPath));

// Only this probe process inherits these synthetic settings. Neither the desktop
// process nor the user's real CODEX_HOME/config/provider is modified or copied.
for (const name of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BASE_URL|ENDPOINT)$/i.test(name) || /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name)) delete process.env[name];
Object.assign(process.env, { CODEX_HOME: reviewerHome, OPENAI_API_KEY: 'fixture-only-not-a-real-key', NO_PROXY: '127.0.0.1,localhost', OTEL_SDK_DISABLED: 'true' });
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  assert.equal(path.resolve(command), path.resolve(executable));
  assert.equal(options.env.CODEX_HOME, reviewerHome);
  const child = originalSpawn.call(this, command, args, options);
  const trace = { command, args, case: activeCase?.decision, outbound: [], inbound: [], stderr: '', exited: false, exitCode: null, exitSignal: null };
  processTraces.push(trace);
  const actualWrite = child.stdin.write; let outgoing = '', incoming = '';
  child.stdin.write = function (chunk, ...rest) {
    outgoing += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); let at;
    while ((at = outgoing.indexOf('\n')) >= 0) { const line = outgoing.slice(0, at); outgoing = outgoing.slice(at + 1); try { trace.outbound.push(JSON.parse(line)); } catch {} }
    return actualWrite.call(this, chunk, ...rest);
  };
  child.stdout.on('data', chunk => {
    incoming += chunk.toString('utf8'); let at;
    while ((at = incoming.indexOf('\n')) >= 0) { const line = incoming.slice(0, at); incoming = incoming.slice(at + 1); try { trace.inbound.push(JSON.parse(line)); } catch {} }
  });
  child.stderr.on('data', chunk => { trace.stderr = (trace.stderr + chunk.toString('utf8')).slice(-16000); });
  processExits.push(new Promise(resolve => child.once('exit', (code, signal) => { trace.exited = true; trace.exitCode = code; trace.exitSignal = signal; resolve(); })));
  return child;
};
const require = createRequire(import.meta.url);
const { runCodexReview } = require(reviewerPath);
const testedRuntimeSHA256 = digest(fs.readFileSync(reviewerPath));
function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesBelow(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const report = { fixture, executable, selectedModel, selectedEffort, provider, baseUrl, testedRuntimeSHA256, realProviderInferenceSent: false, cases, checks: {}, error: null };
try {
  for (const scenario of [{ decision: 'allow', reason: 'Fixture: exact authorized workspace edit' }, { decision: 'manual', reason: 'Fixture: authorization evidence is incomplete' }]) {
    activeCase = scenario;
    const request = { action: { agent: 'claude', requestId: 'fixture-' + scenario.decision, toolName: 'Write', input: { file_path: path.join(workspace, 'proposed.txt'), content: 'never executed' }, nativeDecision: 'ask' } };
    const job = { cwd: workspace, agent: 'claude', userRequest: 'Create proposed.txt with the supplied content in this workspace.', task: 'Create the requested fixture file.' };
    const result = await runCodexReview({ executable, request, job, model: selectedModel, modelProvider: provider, reasoningEffort: selectedEffort, timeoutMs: 45000 });
    assert.equal(result.decision, scenario.decision); assert.equal(result.reason, scenario.reason); assert.equal(result.model, selectedModel);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('The reviewer process did not exit after its decision')), 3000);
      processExits.at(-1).then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
    });
    cases.push({ expected: scenario.decision, result });
  }
  const reviews = providerRequests.filter(request => request.method === 'POST' && /\/responses(?:\?|$)/.test(request.url));
  assert.equal(reviews.length, 2);
  for (const review of reviews) {
    assert.equal(review.body.model, selectedModel); assert.equal(review.body.reasoning?.effort, selectedEffort);
    assert.deepEqual(review.body.tools || [], [], 'The read-only reviewer must expose no executable tools');
    assert.equal(review.body.text?.format?.type, 'json_schema');
    assert.deepEqual(review.body.text.format.schema.properties.decision.enum, ['allow', 'manual', 'deny']);
  }
  for (const trace of processTraces) {
    const start = trace.outbound.find(message => message.method === 'thread/start');
    const turn = trace.outbound.find(message => message.method === 'turn/start');
    const started = trace.inbound.find(message => message.id === start.id)?.result;
    assert.equal(start.params.ephemeral, true); assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.config['mcp_servers.approval_probe_tripwire.enabled'], false);
    assert.equal(turn.params.effort, selectedEffort);
    assert.deepEqual(started.sandbox, { type: 'readOnly', networkAccess: false });
    assert.equal(started.thread.path, null); assert.equal(started.approvalPolicy, 'never'); assert.equal(trace.exited, true);
    assert(!trace.inbound.some(message => message.method && message.id != null), 'No tool/approval/input RPC may be requested by the reviewer');
  }
  assert(!fs.existsSync(marker)); assert(!fs.existsSync(path.join(workspace, 'proposed.txt')));
  const transcripts = filesBelow(path.join(reviewerHome, 'sessions')).filter(file => file.endsWith('.jsonl'));
  assert.equal(transcripts.length, 0, 'Ephemeral reviews must not leave session transcripts');
  assert.equal(digest(fs.readFileSync(configPath)), configBefore); assert.equal(digest(fs.readFileSync(authPath)), authBefore);
  assert.equal(digest(fs.readFileSync(reviewerPath)), testedRuntimeSHA256, 'Reviewer source changed while the native probe was running');
  Object.assign(report.checks, { nativeResponses: ['allow', 'manual'], modelAndEffortReachedLocalHttp: true, readOnlyEphemeralRpc: true, nativeBackendConfirmsReadOnlyAndNetworkDisabled: true, allModelToolsDisabled: true, mcpDisabledAndTripwireNeverStarted: true, noProposedOperationExecuted: true, noSessionTranscriptsWritten: true, isolatedConfigAndAuthUnchanged: true, allReviewerProcessesExited: true });
  report.passed = true;
} catch (error) { report.passed = false; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  childProcess.spawn = originalSpawn;
  report.processTraces = processTraces; report.providerRequests = providerRequests;
  report.finalRuntimeSHA256 = digest(fs.readFileSync(reviewerPath));
  report.configSHA256 = digest(fs.readFileSync(configPath));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const target = path.join(output, 'approval-reviewer-native-result.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ resultPath: target, passed: report.passed, cases, checks: report.checks, error: report.error?.message, processExits: processTraces.map(trace => ({ exited: trace.exited, code: trace.exitCode, signal: trace.exitSignal })), localHttpRequests: providerRequests.length }, null, 2));
}
