'use strict';

// Anchors belong to the versioned host adapter. Missing or hidden native targets
// are skipped; plugins never select arbitrary host DOM or read its message text.
const SLOTS = Object.freeze({
  'conversation.header.action': {
    kind: 'list', scope: 'session', permission: 'ui', label: '会话头动作区',
    anchor: '[data-app-shell-header-slot="end"] [data-app-shell-header-slot-content]', verified: true,
  },
  'sidebar.right.body': {
    kind: 'list', scope: 'session', permission: 'ui', label: '右侧标签 body',
    anchor: '[role="tabpanel"]', verified: true,
  },
  'tool.card.view': {
    kind: 'keyed', scope: 'session', permission: 'ui', label: '工具调用卡片',
    anchor: '[data-local-conversation-item-target-ids]', verified: true,
  },
  'composer.leading': {
    kind: 'list', scope: 'session', permission: 'ui', label: '输入框前置控件',
    anchor: '[data-codex-composer-root] [data-composer-leading-controls]', verified: true,
  },
  'composer.trailing': {
    kind: 'list', scope: 'session', permission: 'ui', label: '输入框后置控件',
    anchor: '[data-codex-composer-root] [data-composer-trailing-controls]', verified: true,
  },
  'conversation.message.action': {
    kind: 'list', scope: 'session', permission: 'ui', label: '消息动作区',
    anchor: '[data-local-conversation-final-assistant] .turn-action-controls', verified: true,
  },
  'settings.section': {
    kind: 'list', scope: 'global', permission: 'ui', label: 'Forge 设置扩展区',
    anchor: '[data-forge-settings-mount]', verified: true,
  },
});

function slotNames() { return Object.keys(SLOTS); }

// Verified against the current 26.1106.6628.0 native UI; absent older anchors are skipped.
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
