'use strict';
// Discovery reads only model metadata. It never mounts a DSH profile, evaluates
// YAML expressions, fetches a provider catalog, or starts an inference request.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function read(file) { try { return fs.statSync(file).size <= 4 * 1024 * 1024 ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : ''; } catch { return ''; } }
function json(file) { try { return JSON.parse(read(file)); } catch { return {}; } }
function safe(value) { return typeof value === 'string' && value.length <= 200 && !/[\r\n\0]/.test(value) && !/^(?:sk[-_]|Bearer\s)/i.test(value) ? value : ''; }
function unique(values) { return [...new Set(values.map(safe).filter(Boolean))]; }
function packageRoot(source, name) {
  for (let current = path.dirname(source || ''); current && current !== path.dirname(current); current = path.dirname(current)) if (json(path.join(current, 'package.json')).name === name) return current;
  return '';
}
// A small metadata reader, not a config writer. Only whitelisted TOML keys are
// read. Strings, arrays and inline tables follow TOML quoting, including quoted
// table keys; unsupported expressions are omitted rather than executed.
function metadataToml(text) {
  const tables = new Map(), allowed = new Set(['id', 'value', 'label', 'default', 'default_reasoning_effort', 'model', 'name', 'reasoning_efforts', 'reasoning_effort', 'supports_reasoning_effort']);
  let section = '', pending = '', entry = null;
  function split(value, separator) {
    let quote = '', escaped = false, depth = 0, start = 0; const out = [];
    for (let i = 0; i < value.length; i++) { const c = value[i]; if (quote) { if (escaped) escaped = false; else if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if ('[{'.includes(c)) depth++; else if (']}'.includes(c)) depth--; else if (c === separator && depth === 0) { out.push(value.slice(start, i)); start = i + 1; } }
    out.push(value.slice(start)); return out;
  }
  function scalar(value) {
    value = value.trim();
    if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return undefined; } }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value === 'true' || value === 'false') return value === 'true';
    if (value.startsWith('[') && value.endsWith(']')) return split(value.slice(1, -1), ',').filter(x => x.trim()).map(scalar);
    if (value.startsWith('{') && value.endsWith('}')) return Object.fromEntries(split(value.slice(1, -1), ',').flatMap(pair => { const parts = split(pair, '='); return parts.length === 2 ? [[parts[0].trim().replace(/^['"]|['"]$/g, ''), scalar(parts[1])]] : []; }));
    return undefined;
  }
  function stripComment(line) {
    let quote = '', escaped = false;
    for (let i = 0; i < line.length; i++) { const c = line[i]; if (quote) { if (escaped) escaped = false; else if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '#') return line.slice(0, i); }
    return line;
  }
  function complete(value) { let quote = '', escaped = false, depth = 0; for (const c of value) { if (quote) { if (escaped) escaped = false; else if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if ('[{'.includes(c)) depth++; else if (']}'.includes(c)) depth--; } return !quote && depth <= 0; }
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim(); if (!line) continue;
    if (!pending && line.startsWith('[') && line.endsWith(']')) {
      const arrayTable = line.startsWith('[[') && line.endsWith(']]');
      const bits = split(line.slice(arrayTable ? 2 : 1, arrayTable ? -2 : -1), '.').map(x => { x = x.trim(); return /^['"]/.test(x) ? scalar(x) : x; });
      if (arrayTable && bits.length === 3 && bits[0] === 'model' && safe(bits[1]) && bits[2] === 'reasoning_efforts') {
        section = 'model.' + bits[1]; if (!tables.has(section)) tables.set(section, {});
        const owner = tables.get(section); if (!Array.isArray(owner.reasoning_efforts)) owner.reasoning_efforts = [];
        entry = {}; owner.reasoning_efforts.push(entry); continue;
      }
      section = bits.length === 1 && bits[0] === 'models' ? 'models' : bits.length === 2 && bits[0] === 'model' && safe(bits[1]) ? 'model.' + bits[1] : '';
      if (section && !tables.has(section)) tables.set(section, {}); entry = section ? tables.get(section) : null; continue;
    }
    pending += (pending ? '\n' : '') + line; if (!complete(pending)) continue;
    const at = pending.indexOf('='); if (entry && at > 0) { const key = pending.slice(0, at).trim().replace(/^['"]|['"]$/g, ''); if (allowed.has(key)) entry[key] = scalar(pending.slice(at + 1)); } pending = '';
  }
  return tables;
}
function claudeMetadata(config, help, { home = os.homedir(), env = process.env } = {}) {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const settings = [json(path.join(directory, 'settings.json')), json(path.join(directory, 'settings.local.json'))].reduce((a, b) => ({ ...a, ...b, env: { ...a.env, ...b.env } }), {});
  const localEnv = { ...settings.env, ...env }, effortMatch = help.match(/--effort\s+[^\n]+[\s\S]{0,140}?\(([^)]*)\)/);
  const efforts = unique((effortMatch?.[1] || '').split(/[,\s]+/));
  const aliases = ['fable', 'opus', 'sonnet', 'haiku'].filter(id => new RegExp(`['"]${id}['"]`).test(help));
  const declared = Array.isArray(settings.availableModels) ? settings.availableModels.filter(x => typeof x === 'string') : [];
  const ids = unique([config.model, settings.model, localEnv.ANTHROPIC_MODEL, ...Object.entries(localEnv).filter(([key]) => /^ANTHROPIC_DEFAULT_[A-Z]+_MODEL$/.test(key)).map(([, value]) => value), ...declared, ...aliases]);
  return { models: ids.map(id => ({ id, label: id, reasoningEfforts: efforts })), reasoningEfforts: efforts, defaultModel: safe(config.model || localEnv.ANTHROPIC_MODEL || settings.model), defaultReasoningEffort: safe(config.reasoningEffort || localEnv.CLAUDE_CODE_EFFORT_LEVEL || settings.effortLevel), source: 'Claude Code --help / 本地 settings 模型字段', supportsModel: help.includes('--model'), supportsReasoning: efforts.length > 0, supportsResume: help.includes('--resume') };
}
function grokMetadata(config, help, { home = os.homedir(), env = process.env } = {}) {
  const directory = env.GROK_HOME || path.join(home, '.grok'), tables = metadataToml(read(path.join(directory, 'config.toml'))), defaults = tables.get('models') || {};
  const models = [...tables].filter(([section]) => section.startsWith('model.')).map(([section, value]) => {
    const declared = Array.isArray(value.reasoning_efforts) ? value.reasoning_efforts : [];
    const reasoningEfforts = value.supports_reasoning_effort === false ? [] : unique(declared.map(x => typeof x === 'string' ? x : x?.id || x?.value));
    return { id: section.slice(6), label: safe(value.name) || section.slice(6), reasoningEfforts, defaultReasoningEffort: safe(value.reasoning_effort || declared.find(x => x?.default)?.id) };
  });
  const defaultModel = safe(config.model || env.GROK_DEFAULT_MODEL || defaults.default);
  if (defaultModel && !models.some(x => x.id === defaultModel)) models.push({ id: defaultModel, label: defaultModel, reasoningEfforts: [] });
  return { models, reasoningEfforts: unique(models.flatMap(x => x.reasoningEfforts)), defaultModel, defaultReasoningEffort: safe(config.reasoningEffort || defaults.default_reasoning_effort), source: 'Grok Build --help / 本地 config.toml 模型目录', supportsModel: help.includes('--model'), supportsReasoning: help.includes('--reasoning-effort'), supportsResume: help.includes('--resume'), note: '仅列出本地声明的模型及各自档位；未向服务商请求模型目录。' };
}
function dshMetadata(config, resolved, { home = os.homedir(), env = process.env } = {}) {
  const base = packageRoot(resolved.source, '@deepseek-ai/dsh'), root = (env.DSH_HOME || path.join(home, '.dsh')).replace(/^~(?=[/\\]|$)/, home);
  const result = { models: [], reasoningEfforts: [], defaultModel: safe(config.model), defaultProvider: safe(config.provider), defaultReasoningEffort: safe(config.reasoningEffort), source: 'DSH 本地已安装包及 profile 模型声明', supportsModel: false, supportsReasoning: false, supportsResume: false, protocolVerified: false };
  if (!base) { result.note = '无法定位 DSH 安装包；请保留本地默认模型。'; return result; }
  const startup = read(path.join(base, 'node_modules/@deepseek-ai/dsh-headless/lib/startup.js'));
  result.protocolVerified = startup.includes('--json') && startup.includes('reads stdin'); result.supportsResume = startup.includes('--session-id');
  const llmSource = read(path.join(base, 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'));
  const catalogSource = llmSource.match(/const DEFAULT_MODELS\s*=\s*\[([\s\S]*?)\];/)?.[1] || '';
  const officialModels = [...catalogSource.matchAll(/\bid:\s*["']([^"']+)["'][\s\S]*?\bname:\s*["']([^"']+)["']/g)].map(x => ({ id: x[1], name: x[2] }));
  const nativeEfforts = unique([...llmSource.matchAll(/const [A-Z_]+_REASONING_EFFORT\s*=\s*ReasoningEffortId\(["']([^"']+)["']\)/g)].map(x => x[1]));
  let modelDefault = {}, provider = {};
  try {
    const yaml = require(require.resolve('yaml', { paths: [base] }));
    const inertJs = { tag: 'tag:yaml.org,2002:js', resolve: () => undefined };
    for (const file of [path.join(base, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), path.join(base, 'node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml'), path.join(root, 'profiles', config.profile || 'headless', 'cordis.patch.yml'), path.join(root, 'cordis.patch.yml')]) {
      const source = read(file); if (!source) continue;
      const rows = yaml.parse(source, { customTags: [inertJs], maxAliasCount: 50, logLevel: 'silent' });
      const visit = values => { if (!Array.isArray(values)) return; for (const row of values) { if (!row || typeof row !== 'object') continue; if (row.id === 'agent-default-model' && row.config) modelDefault = row.config; if (row.id === 'llm-deepseek' && row.config) provider = row.config; visit(row.insert); } }; visit(rows);
    }
  } catch { result.note = '无法完整读取本地 YAML 模型声明，未执行其中的表达式。'; }
  const models = Array.isArray(provider.models) ? provider.models : officialModels, efforts = provider.thinking === 'disabled' ? nativeEfforts.filter(x => x === 'off') : nativeEfforts;
  result.models = models.filter(x => safe(x?.id)).map(x => ({ id: x.id, label: safe(x.name) || x.id, provider: 'deepseek-official', reasoningEfforts: efforts }));
  result.defaultModel ||= safe(modelDefault.model); result.defaultProvider ||= safe(modelDefault.provider);
  result.defaultReasoningEffort ||= safe(modelDefault.reasoningEffort || provider.reasoningEffort) || (provider.thinking === 'disabled' ? 'off' : efforts.includes('high') ? 'high' : '');
  if (result.defaultModel && !result.models.some(x => x.id === result.defaultModel)) result.models.push({ id: result.defaultModel, label: result.defaultModel, provider: result.defaultProvider, reasoningEfforts: result.defaultProvider === 'deepseek-official' ? efforts : [] });
  result.reasoningEfforts = unique(result.models.flatMap(x => x.reasoningEfforts));
  result.supportsModel = !!read(path.join(base, 'node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js')).includes('reasoningEffort'); result.supportsReasoning = result.supportsModel;
  return result;
}
module.exports = { read, safe, unique, packageRoot, metadataToml, claudeMetadata, grokMetadata, dshMetadata };
