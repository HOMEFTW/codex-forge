'use strict';
const fs = require('node:fs'), path = require('node:path');
const { parts, ranges, compatibility } = require('./forge-versions.cjs');
const permissions = new Set(['panels', 'sidebar', 'toolbar', 'composer', 'conversation.read', 'conversation.title', 'output', 'browser', 'storage', 'settings', 'network', 'events']);
const surfaces = ['sidebar', 'toolbar', 'composer'];
const idPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const localId = /^[a-zA-Z][\w-]{0,79}$/;
function check(value, message) { if (!value) throw Error(message); }
function safeFile(root, relative) {
  check(typeof relative === 'string' && relative.length < 250 && relative && !/[\x00-\x1f]/.test(relative) && !relative.includes('\\') && !relative.includes(':') && !relative.split('/').some(s => !s || s === '..' || s === '.'), '资源路径必须为包内相对路径');
  const base = fs.realpathSync(root), resolved = fs.realpathSync(path.join(base, relative));
  check(resolved.startsWith(base + path.sep) && fs.statSync(resolved).isFile(), '资源不可越出插件目录');
  return resolved;
}
function validate(input, root, { builtin = false } = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), '插件清单必须为对象');
  const m = JSON.parse(JSON.stringify(input));
  check(m.schemaVersion === 1 && m.apiVersion === 1, '不支持的清单或 API 版本');
  check(idPattern.test(m.id) && m.id.length <= 100, '插件 ID 使用 publisher.name 格式');
  check(builtin || !m.id.startsWith('forge.'), 'forge.* 是内置插件保留命名空间');
  check(typeof m.name === 'string' && m.name.trim() && m.name.length <= 100, '插件名称无效');
  parts(m.version); ranges(m.compatibility?.codex); ranges(m.compatibility?.forge);
  check(Array.isArray(m.permissions) && m.permissions.every(p => permissions.has(p)) && new Set(m.permissions).size === m.permissions.length, '插件声明了未知或重复权限');
  if (m.entry) { check(m.entry.endsWith('.js'), '入口必须为浏览器 JavaScript'); safeFile(root, m.entry); }
  for (const [id, version] of Object.entries(m.dependencies || {})) { check(idPattern.test(id) && id !== m.id, '依赖 ID 无效'); ranges([version]); }
  const c = m.contributes ||= {}, commands = new Set(), views = new Set(), events = new Set();
  for (const command of c.commands || []) { check(localId.test(command.id) && !commands.has(command.id), '命令 ID 无效或重复'); commands.add(command.id); check(typeof command.title === 'string' && command.title.length <= 100, '命令标题无效'); }
  for (const event of c.events || []) {
    check(event && typeof event.name === 'string' && /^plugin\.[a-z][a-z0-9.-]*\.[a-z][a-z0-9_.:-]{0,79}$/.test(event.name), '事件名称无效');
    check(event.name.startsWith('plugin.' + m.id + '.') && !events.has(event.name), '事件必须属于本插件且不能重复');
    if (event.title !== undefined) check(typeof event.title === 'string' && event.title.length <= 100, '事件标题无效');
    events.add(event.name);
  }
  if (events.size) check(m.permissions.includes('events'), '声明事件需要 events 权限');
  for (const view of c.panels || []) {
    check(localId.test(view.id) && !views.has(view.id), '面板 ID 无效或重复'); views.add(view.id);
    check(typeof view.title === 'string' && view.title.length <= 100, '面板标题无效');
    check(m.permissions.includes('panels'), '缺少 panels 权限');
    check(!view.placement || view.placement === 'right' || (view.placement === 'expanded' && typeof view.placementReason === 'string' && view.placementReason.length >= 6), '面板默认右侧；全宽例外必须说明功能原因');
    view.placement ||= 'right';
    if (view.builtinPage) check(builtin, '第三方插件不能占用内置页面'); else safeFile(root, view.entry);
  }
  for (const surface of surfaces) for (const item of c[surface] || []) {
    check(m.permissions.includes(surface), '缺少 '+surface+' 权限');
    check(localId.test(item.id) && typeof item.title === 'string' && item.title.length <= 100, '贡献按钮无效');
    check(commands.has(item.command) || views.has(item.panel), '按钮必须引用本插件命令或面板');
  }
  for (const [key, field] of Object.entries(c.settings?.properties || {})) {
    check(localId.test(key) && ['string', 'boolean', 'number'].includes(field.type), '设置仅支持 string/boolean/number');
    check(typeof field.title === 'string', '设置字段需要标题');
    if (field.enum) check(Array.isArray(field.enum) && field.enum.length <= 50 && field.enum.every(v => typeof v === field.type), '设置枚举类型不匹配');
  }
  if (m.networkOrigins) { check(m.permissions.includes('network') && Array.isArray(m.networkOrigins), '网络地址需要声明 network 权限'); for (const origin of m.networkOrigins) { const u = new URL(origin); check(u.protocol === 'https:' && u.origin === origin && !u.username && !u.password, '仅支持明确的 HTTPS 网络源'); } }
  check(!m.description || typeof m.description === 'string' && m.description.length <= 20000, '插件描述过长');
  check(!m.changelog || Array.isArray(m.changelog) && m.changelog.length <= 100 && m.changelog.every(c=>c&&typeof c.version==='string'&&(!c.date||typeof c.date==='string')&&Array.isArray(c.items)&&c.items.every(i=>typeof i==='string'&&i.length<10000)), '升级日志无效');
  if(m.update){check(!builtin,'内置插件随 Forge 更新');const u=m.update;check(['github','server'].includes(u.provider),'更新源无效');if(u.provider==='github')check(/^[\w.-]+\/[\w.-]+$/.test(u.repository),'更新仓库无效');else{const url=new URL(u.manifestUrl);check(url.protocol==='https:'&&!url.username&&!url.password,'更新源需为无凭据的 HTTPS URL');}}
  if(commands.size&&!builtin)check(m.entry,'命令需要运行时入口');
  if(c.settings)check(m.permissions.includes('settings'),'缺少 settings 权限');
  validateSettings(m,{});
  return m;
}
function validateSettings(manifest, value) {
  check(value && typeof value === 'object' && !Array.isArray(value), '设置必须为对象');
  const fields = manifest.contributes?.settings?.properties || {}, result = {};
  for (const key of Object.keys(value)) check(Object.hasOwn(fields, key), '未知设置：'+key);
  for (const [key, field] of Object.entries(fields)) {
    const v = Object.hasOwn(value, key) ? value[key] : field.default;
    if (v === undefined) continue;
    check(typeof v === field.type && (field.type !== 'number' || Number.isFinite(v)), '设置类型不符：'+key);
    check(!field.enum || field.enum.includes(v), '设置值不在选项内：'+key);
    if (typeof v === 'string') check(v.length <= (field.maxLength || 10000), '设置值过长');
    if (typeof v === 'number') check((field.minimum === undefined || v >= field.minimum) && (field.maximum === undefined || v <= field.maximum), '设置数值超出范围');
    result[key] = v;
  }
  return result;
}
module.exports = { validate, validateSettings, safeFile, compatibility, check, surfaces, idPattern };
