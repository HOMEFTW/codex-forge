const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
test('API 3 SDK infers Nexus results and rejects unsafe or incomplete requests', () => {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'tests/fixtures/sdk-api3.ts'], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'pipe' });
});
