import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'dist', 'fast-extension');
if (!destination.startsWith(root + path.sep)) throw new Error('Invalid build path');
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.join(destination, 'ui'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'runtime'))) fs.copyFileSync(path.join(root, 'runtime', name), path.join(destination, name));
fs.cpSync(path.join(root, 'plugins'), path.join(destination,'plugins'), {recursive:true});
fs.copyFileSync(path.join(root,'assets','codex-forge.ico'),path.join(destination,'codex-forge.ico'));
fs.copyFileSync(path.join(root,'forge.config.json'),path.join(destination,'forge.config.json'));
fs.cpSync(path.join(root, 'bundled-skills'), path.join(destination, 'bundled-skills'), { recursive: true });
const result = await build({ entryPoints: [path.join(root, 'ui', 'app.jsx')], bundle: true, minify: true, metafile: true, outfile: path.join(destination, 'ui', 'app.js'), format: 'iife', target: ['chrome140'], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
fs.copyFileSync(path.join(root, 'ui', 'index.html'), path.join(destination, 'ui', 'index.html'));
const dependencies = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const absolute = path.resolve(input), marker = path.sep + 'node_modules' + path.sep, at = absolute.lastIndexOf(marker);
  if (at < 0) continue;
  const parts = absolute.slice(at + marker.length).split(path.sep), count = parts[0].startsWith('@') ? 2 : 1;
  dependencies.add(path.join(absolute.slice(0, at + marker.length), ...parts.slice(0, count)));
}
let licenses = 'FAST canvas extension third-party dependencies\n\n';
for (const moduleRoot of dependencies) {
  const pkg = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8'));
  licenses += `${pkg.name} ${pkg.version} (${pkg.license})\n`;
  const license = fs.readdirSync(moduleRoot).find(file => /^licen[cs]e/i.test(file));
  if (license) licenses += fs.readFileSync(path.join(moduleRoot, license), 'utf8') + '\n\n';
}
fs.writeFileSync(path.join(destination, 'THIRD-PARTY-NOTICES.txt'), licenses);
console.log('Built ' + destination);
