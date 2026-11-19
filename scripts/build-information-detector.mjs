import path from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const { commit } = JSON.parse(readFileSync(path.join(root, 'vendor/lm-detector/SOURCES.json'), 'utf8'));
await build({ entryPoints: [path.join(root, 'vendor/lm-detector/index.ts')], bundle: true,
  outfile: path.join(root, 'runtime/information-detector.cjs'), platform: 'node', format: 'cjs',
  target: ['node22'], legalComments: 'inline',
  banner: { js: `// Generated from Ikaleio/lm-detector ${commit} (MIT). See vendor/lm-detector/SOURCES.json.` } });
