import path from 'node:path';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
await build({ entryPoints: [path.join(root, 'vendor/lm-detector/index.ts')], bundle: true,
  outfile: path.join(root, 'runtime/information-detector.cjs'), platform: 'node', format: 'cjs',
  target: ['node22'], legalComments: 'inline',
  banner: { js: '// Generated from Ikaleio/lm-detector a7e9d305 (MIT). See vendor/lm-detector/SOURCES.json.' } });
