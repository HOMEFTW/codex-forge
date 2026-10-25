'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { claudeMetadata, grokMetadata, dshMetadata } = require('./agent-capabilities.cjs');

const AGENTS = Object.freeze({ claude: 'Claude Code', grok: 'Grok Build', dsh: 'DeepSeek Harness' });
const check = (value, message) => { if (!value) throw new Error(message); };
function clean(value, max = 100000) {
  return String(value ?? '').slice(0, max)
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@');
}
function commandValue(value) {
  check(typeof value === 'string' && value.length <= 32767 && !/[\r\n\0]/.test(value), '可执行文件必须是单独的命令名或完整路径');
  if (!value) return value;
  check(path.isAbsolute(value) || /^[\w.-]+$/.test(value), '参数请使用独立参数列表，不能拼接到命令中');
  return value;
}
function validateAgentConfig(value = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value), '智能体配置无效');
  check(Object.keys(value).every(key => ['command', 'args', 'model', 'reasoningEffort', 'provider', 'profile', 'approvalMode'].includes(key)), '未知智能体配置字段');
  const result = { command: commandValue(value.command || ''), args: value.args || [], model: value.model || '', reasoningEffort: value.reasoningEffort || '', provider: value.provider || '', profile: value.profile || 'headless', approvalMode: value.approvalMode ?? 'native' };
  check(Array.isArray(result.args) && result.args.length <= 40 && result.args.every(item => typeof item === 'string' && item.length <= 32767 && !/[\0\r\n]/.test(item)), '启动参数必须是独立字符串数组');
  for (const key of ['model', 'reasoningEffort', 'provider', 'profile']) check(typeof result[key] === 'string' && result[key].length <= 200 && !/[\0\r\n]/.test(result[key]), '模型、思考强度、提供商或配置名称无效');
  check(/^[A-Za-z0-9_-]+$/.test(result.profile), 'DSH profile 名称无效');
  check(['native', 'auto', 'codex'].includes(result.approvalMode), '智能体审批模式无效');
  return result;
}
function nodeExecutable(preferred) {
  for (const candidate of [preferred, process.env.CODEX_FAST_NODE, ...String(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))]) {
    if (candidate && fs.existsSync(candidate) && /(?:^|[\\/])node(?:\.exe)?$/i.test(candidate)) return path.resolve(candidate);
  }
  if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  throw new Error('找不到 Node.js；请使用客户端附带的 Node 运行协作服务');
}
function npmTarget(agent, directory) {
  const packageName = { claude: '@anthropic-ai/claude-code', dsh: '@deepseek-ai/dsh', grok: '@xai-official/grok' }[agent];
  const base = path.join(directory, 'node_modules', packageName);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[agent];
    if (relative) {
      const target = path.resolve(base, relative);
      if (target.startsWith(base + path.sep) && fs.statSync(target).isFile()) return target;
    }
  } catch { /* Not a known npm installation. */ }
  return null;
}
function resolveCommand(agent, config = {}, nodePath) {
  check(AGENTS[agent], '不支持的智能体');
  const command = commandValue(config.command || agent), candidates = [];
  if (path.isAbsolute(command)) candidates.push(command);
  else {
    const home = os.homedir();
    if (command === agent && agent === 'grok') candidates.push(path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'));
    if (command === agent && agent === 'claude') candidates.push(path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
    for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const suffix of process.platform === 'win32' ? ['.exe', '', '.cmd', '.ps1'] : ['']) candidates.push(path.join(directory, command + suffix));
    }
    if (process.env.APPDATA && command === agent) for (const suffix of ['.cmd', '.ps1']) candidates.push(path.join(process.env.APPDATA, 'npm', agent + suffix));
  }
  for (let candidate of candidates) {
    try { if (!fs.statSync(candidate).isFile()) continue; } catch { continue; }
    if (/\.(?:cmd|bat|ps1)$/i.test(candidate)) {
      candidate = npmTarget(agent, path.dirname(candidate));
      if (!candidate) continue;
    }
    if (/\.[cm]?js$/i.test(candidate)) return { command: nodeExecutable(nodePath), prefix: [path.resolve(candidate)], source: path.resolve(candidate) };
    if (process.platform === 'win32' && !/\.exe$/i.test(candidate)) continue;
    return { command: path.resolve(candidate), prefix: [], source: path.resolve(candidate) };
  }
  throw new Error(`${AGENTS[agent]} 未找到。请选择真实 EXE 或 npm 的 JS 入口；不执行 shell 脚本或拼接命令`);
}
function invocation(agent, config, { nodePath, taskFile, patchFile, sessionId } = {}) {
  const resolved = resolveCommand(agent, config, nodePath), args = [...resolved.prefix, ...config.args];
  // In Claude Code print/stream mode, `host` routes permission prompts to the
  // SDK host. `--permission-prompt-tool` names an MCP tool; passing `stdio`
  // here makes current Claude Code look for a nonexistent MCP permission tool
  // and auto-deny writes before our control-request handler can respond.
  if (agent === 'claude') args.push('--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'host');
  if (agent === 'grok') args.push('--no-auto-update');
  if (agent !== 'dsh' && config.approvalMode === 'auto') args.push('--permission-mode', 'auto');
  if (agent !== 'dsh' && config.approvalMode === 'codex') args.push('--permission-mode', agent === 'claude' ? 'manual' : 'default');
  if (agent === 'dsh') {
    args.push('--profile', config.profile);
    if (config.model || config.reasoningEffort) { check(config.provider && config.model, '覆盖 DSH 模型或思考强度时需有效的模型及提供商 ID'); args.push('--patch', patchFile); }
    if (sessionId) args.push('--session-id', sessionId);
    args.push('--json', '-');
  } else {
    if (config.model) args.push('--model', config.model);
    if (config.reasoningEffort) args.push(agent === 'claude' ? '--effort' : '--reasoning-effort', config.reasoningEffort);
    if (sessionId && agent === 'claude') args.push('--resume', sessionId);
  }
  if (agent === 'grok') args.push('agent', '--no-leader', 'stdio');
  return { ...resolved, args, stdin: true, protocol: agent === 'claude' ? 'claude-control' : agent === 'grok' ? 'acp' : 'legacy' };
}
function createParser(agent, emit) {
  let finalText = '', sessionId = '', failure = '', buffer = '', hadDelta = false, hadThinkingDelta = false, draftText = '', truncated = false, permissionDenied = false;
  const decoder = new StringDecoder('utf8');
  function content(blocks) { return Array.isArray(blocks) ? blocks.filter(block => block.type === 'text').map(block => block.text || '').join('') : ''; }
  function event(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.session_id === 'string') sessionId = value.session_id;
    if (value.type === 'session' && typeof value.sessionId === 'string') sessionId = value.sessionId;
    const message = value.type === 'stream_event' ? value.event : value;
    if (message?.type === 'message_start') { draftText = ''; hadDelta = false; hadThinkingDelta = false; }
    if (message?.type === 'content_block_delta') {
      const delta = message.delta;
      if (delta?.type === 'text_delta') {
        emit('text', delta.text || '');
        if (draftText.length + (delta.text || '').length > 1024 * 1024) truncated = true;
        draftText = (draftText + (delta.text || '')).slice(0, 1024 * 1024); hadDelta = true;
      }
      if (delta?.type === 'thinking_delta') { emit('thinking', delta.thinking || ''); hadThinkingDelta = true; }
      return;
    }
    if (message?.type === 'message_stop' && draftText) { finalText = draftText; draftText = ''; }
    if (message?.type === 'content_block_start' && message.content_block?.type === 'tool_use') emit('tool', `${message.content_block.name || '工具'} ${JSON.stringify(message.content_block.input || {})}`);
    if (value.type === 'assistant' || value.type === 'message') {
      const blocks = value.message?.content || value.content, text = content(blocks);
      if (text) { if (!hadDelta) emit('text', text); hadDelta = false; finalText = text; }
      if (Array.isArray(blocks)) for (const block of blocks) {
        if (block.type === 'tool_use') emit('tool', `${block.name || '工具'} ${JSON.stringify(block.input || {})}`);
        if (block.type === 'thinking' && !hadThinkingDelta) emit('thinking', block.thinking || '');
      }
      draftText = ''; hadThinkingDelta = false;
      return;
    }
    if (value.type === 'user' && Array.isArray(value.message?.content)) for (const block of value.message.content) {
      if (block.type === 'tool_result') emit('tool', typeof block.content === 'string' ? block.content : content(block.content));
    }
    if (value.type === 'result') {
      if (typeof value.result === 'string') { finalText = value.result; emit('final', finalText); }
      if (value.is_error || value.subtype && !['success', 'completed'].includes(value.subtype)) failure = clean(value.errors?.join('\n') || value.result || `智能体结果：${value.subtype}`);
      if (value.permission_denials?.length) { permissionDenied = true; failure ||= '部分工具请求被原生 CLI 权限规则拒绝，任务未完整执行'; emit('notice', failure); }
      return;
    }
    if (agent === 'grok' && value.params?.update) {
      const update = value.params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') { emit('text', update.content.text); if (finalText.length + update.content.text.length > 1024 * 1024) truncated = true; finalText = (finalText + update.content.text).slice(0, 1024 * 1024); }
      if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') emit('thinking', update.content.text);
      return;
    }
    if (agent === 'dsh') {
      if (value.type === 'text') { emit('text', value.text || ''); finalText = value.text || finalText; }
      if (value.type === 'thinking') emit('thinking', value.text || '');
      if (value.type === 'tool_call') emit('tool', `${value.tool || '工具'} ${JSON.stringify(value.input || {})}`);
      if (value.type === 'tool_result') emit('tool', `${value.status || ''}: ${value.result || ''}`);
      if (value.type === 'final') { finalText = value.text || ''; emit('final', finalText); }
      if (value.type === 'error') { failure = clean(value.message); emit('error', failure); }
      if (value.type === 'status' && value.reason?.kind === 'error') failure = clean(value.reason.error?.message || 'DSH 运行失败');
    }
    if (value.type === 'error') { failure = clean(value.error?.message || value.message || '智能体运行失败'); emit('error', failure); }
  }
  function line(value) {
    if (!value.trim()) return;
    try { event(JSON.parse(value)); } catch { emit('notice', value); }
  }
  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      if (buffer.length > 2 * 1024 * 1024) { emit('notice', buffer.slice(0, 16000)); buffer = ''; failure = '智能体单条输出超过 2 MB，已停止解析该条输出'; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    },
    finish() { buffer += decoder.end(); if (buffer) line(buffer); return { finalText: clean(finalText || draftText, 1024 * 1024), sessionId, failure, permissionDenied, finalTruncated: truncated || finalText.length > 1024 * 1024 }; },
  };
}
async function probe(agent, config = {}, nodePath, options = {}) {
  config = validateAgentConfig(config);
  let resolved;
  try { resolved = resolveCommand(agent, config, nodePath); }
  catch (error) { return { agent, name: AGENTS[agent], available: false, error: clean(error.message) }; }
  const run = args => new Promise(resolve => {
    let output = '', complete = false;
    const child = spawn(resolved.command, [...resolved.prefix, ...config.args, ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = result => { if (!complete) { complete = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ error: 'CLI 检测超时' }); }, 12000);
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(0, 50000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => finish({ error: clean(error.message) }));
    child.once('close', code => finish({ code, output: clean(output) }));
  });
  const version = await run(['--version']);
  // DSH profile --help mounts its plugin tree and rewrites cordis.yml. Its
  // launcher help and installed source describe the protocol without that write.
  const help = await run(['--help']);
  const metadata = agent === 'claude' ? claudeMetadata(config, help.output || '', options) : agent === 'grok' ? grokMetadata(config, help.output || '', options) : dshMetadata(config, resolved, options);
  const flags = agent === 'dsh' ? ['--json', 'stdin'] : agent === 'claude' ? ['--print', '--output-format', '--include-partial-messages'] : ['--prompt-file', '--output-format', '--include-partial-messages'];
  const compatible = help.code === 0 && (agent === 'dsh' && metadata.protocolVerified || flags.every(flag => help.output.includes(flag)));
  const diagnostic = version.error || help.error || (!compatible ? /EPERM|EACCES|access.*denied|拒绝访问/i.test(help.output || version.output || '') ? '当前进程无权读取或刷新智能体本地配置；请在正常桌面客户端中检测' : '当前 CLI 未提供所需的无界面输出协议' : '');
  return { agent, name: AGENTS[agent], available: version.code === 0 && compatible, version: version.output?.trim().slice(0, 200), executable: resolved.source, protocol: agent === 'dsh' ? 'headless-json' : agent === 'claude' ? 'stream-json' : 'streaming-messages-json', nativeConfig: true, protocolVerified: compatible, generationVerified: false, capabilities: metadata, ...(diagnostic ? { error: diagnostic } : {}) };
}
module.exports = { AGENTS, clean, commandValue, validateAgentConfig, nodeExecutable, resolveCommand, invocation, createParser, probe };
