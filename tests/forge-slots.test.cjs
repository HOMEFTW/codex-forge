const test = require('node:test');
const assert = require('node:assert/strict');
const { SLOTS, slotNames, slotEntries, slotConfig } = require('../runtime/forge-slots.cjs');
const { pluginResponse } = require('../runtime/forge-content.cjs');

function fakeRegistry(plugins) {
  const entries = new Map(plugins.map(plugin => [plugin.id, {
    manifest: { id: plugin.id, name: plugin.name || plugin.id, entry: plugin.entry, networkOrigins: [], permissions: ['ui'], contributes: plugin.contributes || {} },
    root: '/tmp/' + plugin.id,
  }]));
  return {
    entries,
    status: id => ({ enabled: plugins.find(plugin => plugin.id === id)?.enabled !== false }),
    get: id => entries.get(id),
    permission: () => true,
    source: (_id, file) => 'SOURCE:' + file,
  };
}

test('slot names are a stable, documented set', () => {
  assert.deepEqual(slotNames(), ['conversation.header.action', 'sidebar.right.body', 'tool.card.view']);
  for (const name of slotNames()) assert.equal(SLOTS[name].permission, 'ui');
  assert.equal(SLOTS['tool.card.view'].kind, 'keyed');
  assert.equal(SLOTS['sidebar.right.body'].kind, 'list');
  assert.equal(SLOTS['sidebar.right.body'].verified, true, 'right sidebar body uses a verified ARIA anchor');
  assert.equal(SLOTS['conversation.header.action'].anchor, null, 'unverified slots render nothing until an anchor is measured');
});

test('list slots allow many plugins while keyed slots report the first conflict', () => {
  const registry = fakeRegistry([
    { id: 'a.one', contributes: { slots: [{ slot: 'sidebar.right.body', id: 'cmd', view: 'a.html' }] } },
    { id: 'a.two', contributes: { slots: [{ slot: 'sidebar.right.body', id: 'cmd', view: 'b.html' }] } },
    { id: 'a.three', contributes: { slots: [{ slot: 'tool.card.view', id: 'card', key: 'tool-x', view: 'c.html' }] } },
    { id: 'a.four', contributes: { slots: [{ slot: 'tool.card.view', id: 'card', key: 'tool-x', view: 'd.html' }] } },
  ]);
  const value = slotEntries(registry);
  assert.deepEqual(value.entries.map(item => item.pluginId), ['a.one', 'a.two', 'a.three']);
  assert.deepEqual(value.conflicts, [{ slot: 'tool.card.view', key: 'tool-x', plugins: ['a.three', 'a.four'] }]);
  assert.equal(value.entries.find(item => item.pluginId === 'a.one').anchor, '[role="tabpanel"]');
});

test('slot config exposes anchors and verification state for the inspector', () => {
  const config = slotConfig();
  assert.deepEqual(config.map(item => item.id), ['conversation.header.action', 'sidebar.right.body', 'tool.card.view']);
  assert.equal(config.find(item => item.id === 'sidebar.right.body').anchor, '[role="tabpanel"]');
  assert.equal(config.find(item => item.id === 'sidebar.right.body').verified, true);
  assert.equal(config.find(item => item.id === 'tool.card.view').anchor, null);
  assert.equal(config.find(item => item.id === 'tool.card.view').verified, false);
});

test('disabled plugins contribute no slots', () => {
  const registry = fakeRegistry([{ id: 'a.off', enabled: false, contributes: { slots: [{ slot: 'sidebar.right.body', id: 'body', view: 'x.html' }] } }]);
  assert.deepEqual(slotEntries(registry).entries, []);
});

test('slot views are served through the plugin protocol', async () => {
  const registry = fakeRegistry([{ id: 'test.slots', contributes: { slots: [{ slot: 'conversation.header.action', id: 'header', view: 'header.html' }] } }]);
  const ok = await pluginResponse(registry, 'codex-forge://plugin/test.slots/slot/header');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /SOURCE:header\.html/);
  const missing = await pluginResponse(registry, 'codex-forge://plugin/test.slots/slot/nope');
  assert.equal(missing.status, 404);
  const unknownPanel = await pluginResponse(registry, 'codex-forge://plugin/test.slots/panel-x');
  assert.equal(unknownPanel.status, 404);
});
