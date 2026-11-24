import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'extensions/codeg-skills');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'));
const out = path.join(root, 'dist/codeg-skills'), stage = path.join(out, manifest.id);
if (path.dirname(stage) !== out) throw Error('Invalid plugin build path');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: ['extensions/codeg-skills/main.jsx'], bundle: true,
  write: false, outfile: 'panel.js', minify: true, format: 'iife', platform: 'browser', target: ['chrome140'],
  legalComments: 'external', define: { 'process.env.NODE_ENV': '"production"' } });
const output = suffix => result.outputFiles.filter(file => file.path.endsWith(suffix)).map(file => file.text).join('\n');
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codeg 技能包</title><style>html,body,#root{height:100%;margin:0}body{overflow:hidden}'
  + output('.css').replace(/<\/style/gi, '<\\/style') + '</style></head><body><div id="root"></div><script>'
  + output('.js').replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
fs.writeFileSync(path.join(stage, 'panel.html'), html);
for (const name of ['plugin.json', 'README.md']) fs.copyFileSync(path.join(source, name), path.join(stage, name));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.cpSync(path.join(source, 'bundled-skills'), path.join(stage, 'bundled-skills'), { recursive: true });
const licenses = ['react', 'react-dom', 'scheduler'].map(name => name + '\n' + fs.readFileSync(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8'));
fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), licenses.join('\n\n') + '\n' + output('.LEGAL.txt'));
const inventory = new (require('../runtime/skills.cjs').SkillsStore)({ root: stage, bundleRoot: path.join(stage, 'bundled-skills') }).verify();
require('../runtime/forge-manifest.cjs').validate(manifest, stage);
const files = [];
function collect(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('Plugin cannot contain links');
    if (stat.isDirectory()) collect(file);
    else files.push({ path: path.relative(stage, file).split(path.sep).join('/'), encoding: 'base64', content: fs.readFileSync(file).toString('base64') });
  }
}
collect(stage);
if (files.length > 1000 || files.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0) > 20 * 1024 * 1024) throw Error('Plugin exceeds Forge package limits');
const packageName = 'Codeg-Skills-' + manifest.version + '.forge-plugin.json';
fs.writeFileSync(path.join(out, packageName), JSON.stringify({ schemaVersion: 1, files }));
const zipName = 'Codeg-Skills-' + manifest.version + '.zip', zipPath = path.join(out, zipName);
fs.rmSync(zipPath, { force: true });
execFileSync(path.join(root, 'vendor/7zip/7za.exe'), ['a', '-tzip', zipPath, '.'], { cwd: stage, windowsHide: true, stdio: 'pipe' });
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), [zipName, packageName].map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex') + '  ' + name).join('\n') + '\n');
console.log(JSON.stringify({ directory: stage, zip: zipPath, package: path.join(out, packageName), inventory }, null, 2));
