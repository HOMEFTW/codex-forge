'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const entry = path.resolve(process.env.FORGE_CONNECTOR_TEST_ENTRY || path.join(__dirname, '../runtime/collaboration-mcp.cjs'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-connector-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "便携 数据 ' $home"), file = path.join(root, "agent's $config", 'mcp.json');
  const run = args => spawnSync(process.execPath, [entry, '--home', home, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { root, home, file, run };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('connector installs using its bundled runtime and custom Forge home without opening access', t => {
  const f = fixture(t), result = f.run(['--install', f.file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).backupFile, null);
  assert.deepEqual(read(f.file), { mcpServers: { codex_forge: { command: process.execPath, args: [entry, '--home', f.home] } } });
  assert.equal(fs.existsSync(f.home), false, 'installation does not create host settings or grant access');
  assert.deepEqual(JSON.parse(f.run(['--config']).stdout), read(f.file));
});

test('connector preserves unrelated settings, backs up exact bytes and repeated installation is a no-op', t => {
  const f = fixture(t), original = Buffer.from('\uFEFF' + JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'keep', env: { SECRET: 'local-fixture' } }, codex_forge: { command: 'old' } } }, null, 4) + '\r\n');
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, original);
  const result = f.run(['--install', f.file]); assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(result.stdout), value = read(f.file);
  assert.ok(fs.readFileSync(installed.backupFile).equals(original));
  assert.equal(value.theme, 'dark'); assert.deepEqual(value.mcpServers.existing, { command: 'keep', env: { SECRET: 'local-fixture' } });
  assert.equal(value.mcpServers.codex_forge.command, process.execPath);
  const after = fs.readFileSync(f.file), again = JSON.parse(f.run(['--install', f.file]).stdout);
  assert.equal(again.changed, false); assert.equal(again.backupFile, null); assert.ok(fs.readFileSync(f.file).equals(after));
  assert.equal(fs.readdirSync(path.dirname(f.file)).length, 2);
});

test('invalid or unsupported MCP configurations fail without altering the original file', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.file), { recursive: true });
  for (const value of ['{ invalid', '[]', 'null', '{"mcpServers":[]}', '{"mcpServers":false}', '{"mcp":{"servers":{}}}', '{"mcp_servers":{}}', '// JSONC\n{}']) {
    fs.writeFileSync(f.file, value);
    const result = f.run(['--install', f.file]); assert.equal(result.status, 1, value); assert.ok(result.stderr);
    assert.equal(fs.readFileSync(f.file, 'utf8'), value); assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['mcp.json']);
  }
});

test('invalid CLI modes never start an MCP server or write configuration', t => {
  const f = fixture(t);
  for (const args of [['--install'], ['--install', '--config'], ['--home'], ['--home', '--config'], ['--install', f.file, '--config'], ['--unknown']]) {
    const result = f.run(args); assert.equal(result.status, 1, JSON.stringify(args)); assert.ok(result.stderr); assert.equal(result.stdout, '');
  }
  assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(f.home), false);
});

test('page-generated PowerShell commands install correctly with Chinese, spaces, apostrophes and dollar signs', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), { connectorSetup } = await import('../ui/collaboration-setup.js');
  const config = JSON.parse(f.run(['--config']).stdout), setup = connectorSetup(config, f.file);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup.installCommand], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(read(f.file), config);
  const queried = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup.configCommand], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(queried.status, 0, queried.stderr); assert.deepEqual(JSON.parse(queried.stdout), config);
  assert.ok(setup.prompt.includes(setup.installCommand)); assert.ok(setup.prompt.includes(setup.configCommand));
});
