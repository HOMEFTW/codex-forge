'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MODEL = 'gpt-6.1-sol';
const CONTEXT_WINDOW = 500_000;
const TERRA_MODEL = 'gpt-6.1-terra';
const FAST_TIER = { id: 'priority', name: 'Fast', description: '使用优先处理档位；可用性与计费以模型服务为准。' };

function terraDescriptor(models) {
  const existing = models.find(model => model.slug === TERRA_MODEL);
  if (existing) return existing;
  const template = ['gpt-6-terra', 'gpt-5.6-terra', MODEL, 'gpt-6-sol']
    .map(slug => models.find(model => model.slug === slug)).find(Boolean);
  if (!template) return null;
  // Keep the compatible Codex descriptor's tool/prompt and context defaults.
  // https://developers.openai.com/api/docs/models/gpt-6.1-terra
  // Terra does not advertise Sol's ultra reasoning level or its Forge 500K override.
  return { ...template, slug: TERRA_MODEL, display_name: 'GPT-6.1-Terra',
    description: '视觉推理、电脑操作与文本写作模型。', default_reasoning_level: 'medium',
    supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: effort })),
    service_tiers: [{ ...FAST_TIER }], upgrade: null, availability_nux: null };
}

function readModelCatalog({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), catalogPath } = {}) {
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
  return { source, catalog };
}

function configuredModels(catalog, { enableTerra = true } = {}) {
  const models = catalog.models.map(model => ({ ...model }));
  // Derive Terra before applying Sol's per-model context override.
  const terra = enableTerra ? terraDescriptor(models) : null;
  let target = models.find(model => model.slug === MODEL);
  let derived = false;
  if (!target) {
    const template = models.find(model => model.slug === 'gpt-6-sol');
    if (template) {
      target = { ...template, slug: MODEL, display_name: 'GPT-6.1-Sol', visibility: 'list' };
      models.push(target);
      derived = true;
    }
  }
  if (target) {
    target.context_window = CONTEXT_WINDOW;
    target.max_context_window = Math.max(CONTEXT_WINDOW, Number(target.max_context_window) || 0);
    target.effective_context_window_percent = 95;
  }
  if (terra) {
    if (!models.includes(terra)) models.push(terra);
    terra.visibility = 'list';
    terra.supported_in_api = true;
    if (!terra.service_tiers?.some(tier => tier.id === 'priority')) terra.service_tiers = [...(terra.service_tiers || []), { ...FAST_TIER }];
  }
  return { models, target, derived };
}

function modelOptions({ settings = {}, ...options } = {}) {
  const { catalog } = readModelCatalog(options);
  const { models } = configuredModels(catalog, settings);
  return models.filter(model => model.visibility !== 'hide').map(model => ({
    id: model.slug, name: model.display_name || model.slug,
    fast: !!model.service_tiers?.some(tier => tier.id === 'priority'),
  }));
}

function validateModelSelection(settings, options = {}) {
  if (!settings.hiddenModels?.length) return;
  const models = modelOptions({ ...options, settings });
  if (models.length && models.every(model => settings.hiddenModels.includes(model.id))) throw Error('请至少保留一个可选择的模型');
}

// Build a Forge-owned overlay, never change the user's config or model cache.
function prepareModelCatalog({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), root = path.join(codexHome, 'forge'), catalogPath, settings = {} } = {}) {
  const { source, catalog } = readModelCatalog({ codexHome, catalogPath });
  const { models, target, derived } = configuredModels(catalog, settings);
  const hidden = new Set(settings.hiddenModels || []), selectable = models.filter(model => model.visibility !== 'hide');
  // A refreshed catalog can remove the user's last visible model. Keep the picker
  // usable in that case; settings stay intact so the user can revise the selection.
  const visibilityFallback = selectable.length > 0 && selectable.every(model => hidden.has(model.slug));
  if (!visibilityFallback) for (const model of models) if (hidden.has(model.slug)) model.visibility = 'hide';
  const content = JSON.stringify({ ...catalog, models }, null, 2);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'model-catalog-500k.json');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  return { path: file, source, model: target ? MODEL : null, contextWindow: target ? CONTEXT_WINDOW : null, effectiveWindow: target ? 475_000 : null, derived, visibilityFallback };
}

function applyFastModelSettings({ registry, codexHome, env = process.env }) {
  // Never inherit a stale overlay or Fast flag when settings cannot be read.
  delete env.CODEX_FORGE_MODEL_CATALOG;
  env.CODEX_FORGE_FAST = '0';
  env.CODEX_FORGE_SPEED = 'native';
  try {
    const enabled = registry.status('forge.fast').enabled;
    const settings = enabled ? registry.settings('forge.fast') : { defaultSpeed: 'native', enableTerra: false, hiddenModels: [] };
    env.CODEX_FORGE_FAST = enabled ? '1' : '0';
    env.CODEX_FORGE_SPEED = settings.defaultSpeed;
    const result = prepareModelCatalog({ codexHome, root: registry.root, settings });
    env.CODEX_FORGE_MODEL_CATALOG = result.path;
    return result;
  } catch (error) { delete env.CODEX_FORGE_MODEL_CATALOG; throw error; }
}
module.exports = { prepareModelCatalog, modelOptions, validateModelSelection, applyFastModelSettings, MODEL, CONTEXT_WINDOW, TERRA_MODEL };
