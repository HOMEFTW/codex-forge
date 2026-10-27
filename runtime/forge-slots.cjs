'use strict';

// Forge 的命名 UI 贡献点（slot）——DSH ui-slots 的裁剪版。
// 宿主声明位置与基数，插件只能往已声明位置注册；single/keyed 的冲突在派发前
// 就判定为冲突并跳过，不影响其他插件。渲染层按 anchor 选择器挂载，anchor 为
// null 表示落点尚未实测，插件声明会被接受但不会渲染。
const SLOTS = Object.freeze({
  'conversation.header.action': {
    kind: 'list', scope: 'session', permission: 'ui', label: '会话头动作区',
    anchor: null, verified: false,
  },
  'sidebar.right.body': {
    kind: 'list', scope: 'session', permission: 'ui', label: '右侧标签 body',
    anchor: '[role="tabpanel"]', verified: true,
  },
  'tool.card.view': {
    kind: 'keyed', scope: 'session', permission: 'ui', label: '工具调用卡片',
    anchor: null, verified: false,
  },
});

function slotNames() { return Object.keys(SLOTS); }

// 配置视图供调试插件与宿主 UI 使用：anchor 为 null 表示落点还没实测。
function slotConfig() {
  return Object.entries(SLOTS).map(([id, spec]) => ({ id, kind: spec.kind, scope: spec.scope, label: spec.label, anchor: spec.anchor, verified: spec.verified !== false }));
}

// 收集所有已启用插件的 slot 条目。single/keyed 按 slot+key 去重，先启用者优先，
// 后来者进 conflicts 而不是覆盖别人。
function slotEntries(registry) {
  const entries = [], conflicts = [], seen = new Map();
  for (const entry of registry.entries.values()) {
    const manifest = entry.manifest;
    if (!registry.status(manifest.id).enabled) continue;
    for (const item of manifest.contributes?.slots || []) {
      const spec = SLOTS[item.slot];
      if (!spec) continue;
      if (spec.kind !== 'list') {
        const key = item.slot + '\0' + (item.key || '');
        if (seen.has(key)) { conflicts.push({ slot: item.slot, key: item.key || null, plugins: [seen.get(key), manifest.id] }); continue; }
        seen.set(key, manifest.id);
      }
      entries.push({ pluginId: manifest.id, pluginName: manifest.name, slot: item.slot, id: item.id, key: item.key || null, view: item.view, kind: spec.kind, anchor: spec.anchor });
    }
  }
  return { entries, conflicts };
}

module.exports = { SLOTS, slotNames, slotEntries, slotConfig };
