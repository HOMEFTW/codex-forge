const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Forge plugin and update pages retain the shared page layout styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'forge.css'), 'utf8');
  for (const selector of ['.forge-page{', '.forge-card{', '.forge-actions{', '.forge-settings-index{']) {
    assert.ok(css.includes(selector), `missing Forge UI selector: ${selector}`);
  }
  assert.match(css, /@media\(prefers-color-scheme:dark\)/);
});

test('Forge collaboration and management pages retain the 0.1.0 visual contract', () => {
  const collaboration = fs.readFileSync(path.join(__dirname, '..', 'ui', 'collaboration.css'), 'utf8');
  const forge = fs.readFileSync(path.join(__dirname, '..', 'ui', 'forge.jsx'), 'utf8');
  for (const selector of ['.fast-collab{', '.fast-collab-authorization{', '.fast-collab-tabs{', '.fast-collab-agent{', '.fast-collab-job{']) {
    assert.ok(collaboration.includes(selector), `missing collaboration UI selector: ${selector}`);
  }
  assert.ok(collaboration.length >= 6000, 'collaboration base styles must not be replaced by only state overrides');
  assert.match(forge, /page==='forge-updates'.*<article className="forge-card">/s);
  assert.doesNotMatch(forge, /forge-update-card/);
});

test('embedded Forge settings panels do not invoke missing close or mode callbacks', () => {
  const forge = fs.readFileSync(path.join(__dirname, '..', 'ui', 'forge.jsx'), 'utf8');
  const collaboration = fs.readFileSync(path.join(__dirname, '..', 'ui', 'collaboration.jsx'), 'utf8');
  const skills = fs.readFileSync(path.join(__dirname, '..', 'ui', 'skills.jsx'), 'utf8');
  assert.match(forge, /settingsOnly onClose=\{onClose\}/);
  assert.match(forge, /<SkillsPanel api=\{api\} onClose=\{onClose\}\/>/);
  assert.match(collaboration, /\{onClose && <button onClick=\{onClose\}/);
  assert.match(skills, /\{onClose && <button onClick=\{onClose\}/);
  assert.match(skills, /\{onMode && <button onClick=\{\(\) => onMode/);
});

test('deferred todos remain in their status column and switch to personal scope without a thread', () => {
  const todos = fs.readFileSync(path.join(__dirname, '..', 'ui', 'todos.jsx'), 'utf8');
  assert.match(todos, /const columnForItem = item => columnFor\(item\.status\)/);
  assert.match(todos, /const effectiveScope = threadId && scope === 'conversation' \? 'conversation' : 'personal'/);
  assert.match(todos, /value=\{effectiveScope\}/);
});
