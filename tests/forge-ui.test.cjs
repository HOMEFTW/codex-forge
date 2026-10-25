const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Forge plugin and update pages retain the shared page layout styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'forge.css'), 'utf8');
  for (const selector of ['.forge-page{', '.forge-card{', '.forge-actions{', '.forge-settings-index{', '.forge-update-card header{']) {
    assert.ok(css.includes(selector), `missing Forge UI selector: ${selector}`);
  }
  assert.match(css, /@media\(prefers-color-scheme:dark\)/);
});
