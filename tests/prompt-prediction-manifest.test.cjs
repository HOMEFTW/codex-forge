'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { DEFAULT_PROMPT } = require('../runtime/prompt-prediction.cjs');

test('the bundled prediction plugin loads with its scoped capability and shared prompt defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prediction-manifest-'));
  try {
    const registry = new ForgeRegistry({ root, bundledRoot: path.join(__dirname, '../plugins'), versions: { apiVersion: 4, forge: '0.6.0', codex: '26.1103.7773.0' } });
    const plugin = registry.list().plugins.find(item => item.id === 'forge.prompt-prediction');
    assert.ok(plugin, JSON.stringify(registry.errors));
    assert.equal(plugin.builtin, true);
    assert.equal(plugin.enabled, true, plugin.reasons?.join(';'));
    assert.equal(plugin.capabilities.some(item => item.name === 'prompt-prediction' && item.version === 1), true);
    assert.deepEqual(registry.settings(plugin.id), { enabled: true, prompt: DEFAULT_PROMPT, maxChars: 320, timeoutSeconds: 30 });
    registry.settings(plugin.id, { enabled: false, prompt: '优先建议核对结果。', maxChars: 160, timeoutSeconds: 15 });
    registry.setEnabled(plugin.id, false);
    assert.equal(registry.status(plugin.id).enabled, false);
    registry.setEnabled(plugin.id, true);
    assert.equal(registry.settings(plugin.id).enabled, false, 're-enabling the plugin preserves the automatic-prediction preference');
    assert.equal(registry.settings(plugin.id).timeoutSeconds, 15, 'saved timeout preferences take precedence over the new default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
