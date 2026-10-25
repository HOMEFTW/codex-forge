// Local protocol fixture. Never contacts a model/provider.
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2), value = key => args.find(x => x.startsWith(key + '='))?.slice(key.length + 1);
const agent = value('--fixture-agent') || (args.includes('--input-format') ? 'claude' : 'grok'), mode = value('--fixture-mode') || 'ok';
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
if (args.includes('--help')) { console.log("--print --input-format --output-format --include-partial-messages --permission-prompts --permission-prompt-tool --permission-mode --prompt-file --json stdin --model <model> alias 'sonnet' --effort <level> Effort level (low, medium, high, xhigh, max) --resume <id>"); process.exit(0); }
if (args.includes('--version')) { console.log('fixture 1.0.0'); process.exit(0); }
let promptId, task = '';
const update = text => emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
function finish(allowed = true) {
  const text = (value('--fixture-prefix') || '中文 🦆 ') + task;
  if (agent === 'claude') {
    emit({ type: 'stream_event', session_id: 'fixture-session', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    emit({ type: 'result', subtype: 'success', session_id: 'fixture-session', result: text, ...(allowed ? {} : { permission_denials: [{ tool_name: 'Write' }] }) });
  } else { update(text); emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }); }
}
function start() {
  if (mode === 'fail') { process.stderr.write('failed api_key=example-secret-value\n'); process.exit(7); }
  if (mode === 'hold') { if (agent === 'claude') emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'started' } } }); else update('started'); return; }
  if (mode === 'host-denial' && agent === 'claude') {
    emit({ type: 'result', subtype: 'success', session_id: 'fixture-session', result: 'Permission for this tool use was denied. It requires approval, and this session has no approval surface. The action was NOT performed.' });
    return;
  }
  if (mode === 'approval' || mode === 'human') {
    const input = { file_path: 'approval-fixture.txt', content: task };
    if (agent === 'claude') emit({ type: 'control_request', request_id: 'permission-one', request: { subtype: 'can_use_tool', tool_name: 'Write', input, tool_use_id: 'tool-one', ...(mode === 'human' ? { requires_user_interaction: true } : {}) } });
    else emit({ jsonrpc: '2.0', id: 'permission-one', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: 'tool-one', title: 'Write', rawInput: input }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }] } });
    return;
  }
  setTimeout(() => finish(), 250);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') { emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }); return; }
  if (frame.type === 'user') { task = frame.message.content[0].text; start(); return; }
  if (frame.type === 'control_response') { finish(frame.response.response.behavior === 'allow'); return; }
  if (frame.id === 'permission-one') { finish(frame.result.outcome.optionId === 'once'); return; }
  const result = frame.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } } : frame.method === 'session/new' ? { sessionId: 'fixture-session', configOptions: [] } : {};
  if (frame.method === 'session/prompt') { promptId = frame.id; task = frame.params.prompt[0].text; start(); }
  else if (frame.id !== undefined) emit({ jsonrpc: '2.0', id: frame.id, result });
});
