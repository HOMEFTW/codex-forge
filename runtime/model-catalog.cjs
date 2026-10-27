'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MODEL = 'gpt-6.1-sol';
const CONTEXT_WINDOW = 500_000;

// Build a Forge-owned overlay, never change the user's config or model cache.
function prepareModelCatalog({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), root = path.join(codexHome, 'forge'), catalogPath } = {}) {
  if (!catalogPath) {
    const config = path.join(codexHome, 'config.toml');
    if (fs.existsSync(config)) {
      const top = fs.readFileSync(config, 'utf8').split(/^\s*\[/m)[0];
      const match = top.match(/^\s*model_catalog_json\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m);
      if (match) catalogPath = match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1);
    }
  }
  const source = catalogPath ? path.resolve(codexHome, catalogPath) : path.join(codexHome, 'models_cache.json');
  if (!fs.existsSync(source)) throw Error('未找到模型目录；请先让 Codex 获取模型列表');
  const catalog = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!Array.isArray(catalog.models)) throw Error('模型目录缺少 models 数组');
  const models = catalog.models.map(model => ({ ...model }));
  let target = models.find(model => model.slug === MODEL);
  const derived = !target;
  if (!target) {
    const template = models.find(model => model.slug === 'gpt-6-sol');
    if (!template) throw Error('目录缺少 GPT-6.1-Sol 或 GPT-6-Sol 描述，无法安全生成 500K 目录');
    target = { ...template, slug: MODEL, display_name: 'GPT-6.1-Sol', visibility: 'list' };
    models.push(target);
  }
  target.context_window = CONTEXT_WINDOW;
  target.max_context_window = Math.max(CONTEXT_WINDOW, Number(target.max_context_window) || 0);
  target.effective_context_window_percent = 95;
  const content = JSON.stringify({ ...catalog, models }, null, 2);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'model-catalog-500k.json');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  return { path: file, source, model: MODEL, contextWindow: CONTEXT_WINDOW, effectiveWindow: 475_000, derived };
}
module.exports = { prepareModelCatalog, MODEL, CONTEXT_WINDOW };
