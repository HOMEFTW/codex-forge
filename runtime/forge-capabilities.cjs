'use strict';

// Forge 的 capability seam 裁剪版。DSH 用 Cordis 的 inject 让插件在服务就绪前
// 挂起、由 guard 做白名单；Forge 的插件跑在 sandbox iframe 里、没有 Node 权限，
// 所以这里只保留"声明 + 宿主校验 + 教学式拒绝"三件事：
//   1. plugin.json 的 capabilities 声明插件用到哪些宿主服务；
//   2. 宿主在每次派发前校验声明，未声明直接失败，不静默降级；
//   3. 失败文本必须告诉插件怎么改清单，而不是只报"没有权限"。
// permission 仍是用户授权面（安装时审阅）；capability 是技术声明，两者都要过。
const CAPABILITIES = Object.freeze({
  conversation: { version: 1, permission: 'conversation.title', description: '修改当前会话标题' },
  composer: { version: 1, permission: 'composer', description: '读写输入框草稿' },
  output: { version: 1, permission: 'output', description: '写当前会话的可折叠输出' },
  browser: { version: 1, permission: 'browser', description: '打开内置浏览器' },
  dsh: { version: 1, permission: 'dsh', description: '在 Forge 中适配 DSH 浏览器插件' },
  storage: { version: 1, permission: 'storage', description: '插件独立 JSON 存储' },
  settings: { version: 1, permission: 'settings', description: '读取统一设置' },
  events: { version: 1, permission: 'events', description: '发布受限插件事件' },
  panels: { version: 1, permission: 'panels', description: '打开/关闭原生右侧面板' },
  ui: { version: 1, permission: null, description: '注册左栏、工具栏或输入框按钮' },
});

// 不受能力声明限制的调用：只读自身的清单与宿主能力表，没有副作用。
const ALWAYS_ALLOWED = new Set(['context.get', 'metadata.get', 'capabilities.get']);

const METHOD_CAPABILITY = Object.freeze({
  'conversation.title': 'conversation',
  'composer.read': 'composer', 'composer.insert': 'composer', 'composer.set': 'composer',
  'output.append': 'output', 'output.clear': 'output', 'output.open': 'output',
  'browser.open': 'browser',
  'storage.get': 'storage', 'storage.set': 'storage', 'storage.delete': 'storage',
  'settings.get': 'settings',
  'dsh.request': 'dsh',
  'events.emit': 'events',
  'panels.open': 'panels', 'panels.close': 'panels',
  'ui.register': 'ui', 'ui.unregister': 'ui',
});

// 旧插件没有 capabilities 字段时按 permissions 推断，保持 0.2.0 行为不变。
function inferCapabilities(permissions = []) {
  const set = new Set();
  for (const permission of permissions) {
    if (permission === 'conversation.title') set.add('conversation');
    else if (permission === 'composer') { set.add('composer'); set.add('ui'); }
    else if (['output', 'browser', 'storage', 'settings', 'events', 'panels', 'ui', 'dsh'].includes(permission)) set.add(permission);
    else if (permission === 'sidebar' || permission === 'toolbar') set.add('ui');
  }
  return [...set].sort().map(name => ({ name, version: CAPABILITIES[name].version, optional: false }));
}

function normalize(manifest) {
  if (Array.isArray(manifest.capabilities)) {
    return manifest.capabilities.map(item => ({
      name: item.name,
      version: item.version ?? CAPABILITIES[item.name].version,
      optional: item.optional === true,
    }));
  }
  return inferCapabilities(manifest.permissions);
}

function requiredCapability(method) {
  return ALWAYS_ALLOWED.has(method) ? null : METHOD_CAPABILITY[method] || null;
}

// 缺失能力的拒绝文本要能直接指导修改清单。
function denial(method, capability) {
  const spec = CAPABILITIES[capability];
  const permission = spec?.permission ? `，并确认 permissions 包含 "${spec.permission}"` : '';
  return `插件未声明能力 "${capability}"，无法调用 ${method}。请在 plugin.json 中加入 "capabilities": [{"name":"${capability}","version":${spec?.version || 1}}]${permission}。`;
}

function granted(manifest, method) {
  const capability = requiredCapability(method);
  if (!capability) return null;
  const declared = normalize(manifest).find(item => item.name === capability);
  if (!declared) return denial(method, capability);
  if (declared.version !== CAPABILITIES[capability].version) {
    return `能力 "${capability}" 声明版本 ${declared.version}，当前 Forge 提供版本 ${CAPABILITIES[capability].version}；请更新 plugin.json。`;
  }
  return null;
}

module.exports = { CAPABILITIES, METHOD_CAPABILITY, ALWAYS_ALLOWED, inferCapabilities, normalize, requiredCapability, denial, granted };
