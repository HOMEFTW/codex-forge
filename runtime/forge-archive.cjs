'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { check } = require('./forge-manifest.cjs');
const MAX_BYTES = 20 * 1024 * 1024;
function executable() {
  const bundled = path.join(__dirname, 'vendor/7zip/7za.exe');
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, '../vendor/7zip/7za.exe');
}
function run(file, type, command, limit) {
  const result = spawnSync(executable(), [...command, '-t' + type, '-p-', '-sccUTF-8', '-bd', '-mmt=1', '--', path.resolve(file)], { windowsHide: true, timeout: 30000, maxBuffer: limit, input: Buffer.alloc(0) });
  check(!result.error && result.status === 0, '无法读取压缩包：文件损坏、已加密或超过解压限制');
  return result.stdout;
}
function unpackArchive(file, destination, validatePath) {
  const type = path.extname(file).slice(1).toLowerCase();
  check(['zip', '7z'].includes(type), '仅支持 ZIP、7z 和 .forge-plugin.json 插件包');
  const listing = run(file, type, ['l', '-slt', '-ba'], 4 * 1024 * 1024).toString('utf8');
  const entries = [], names = new Map(); let total = 0;
  for (const block of listing.trim().split(/\r?\n\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(' = '); check(at > 0, '压缩包文件清单无效');
      const key = line.slice(0, at); check(!Object.hasOwn(fields, key), '压缩包文件清单重复'); fields[key] = line.slice(at + 3);
    }
    check(typeof fields.Path === 'string' && fields.Encrypted === '-', '不支持加密压缩包');
    check(!Object.hasOwn(fields, 'Symbolic Link') && !Object.hasOwn(fields, 'Hard Link') && !/(?:^|\s)l[rwx-]{9}/.test(fields.Attributes || ''), '压缩包不能包含链接');
    const directory = fields.Folder === '+' || /^D(?:\s|$)/.test(fields.Attributes || '') || /(?:^|\s)d[rwx-]{9}/.test(fields.Attributes || '');
    const name = fields.Path.replaceAll('\\', '/').replace(directory ? /\/$/ : /$^/, ''); validatePath(name);
    const key = name.toLowerCase(); check(!names.has(key), '压缩包包含重复路径'); names.set(key, directory);
    check(/^\d+$/.test(fields.Size) && Number.isSafeInteger(Number(fields.Size)), '压缩包文件大小无效');
    const size = Number(fields.Size); total += size;
    check(total <= MAX_BYTES, '插件解包内容超过 20MB');
    check(names.size <= 2000 && (directory || entries.length < 1000), '插件超过1000文件或2000目录项');
    if (!directory) entries.push({ name, size });
  }
  for (const [name] of names) { const parts = name.split('/'); while (parts.pop() && parts.length) check(names.get(parts.join('/')) !== false, '压缩包文件与目录冲突'); }
  const manifests = entries.filter(item => item.name.toLowerCase().split('/').at(-1) === 'plugin.json');
  check(manifests.length === 1, manifests.length ? '压缩包包含多个插件，请选择唯一插件包' : '压缩包缺少 plugin.json');
  const prefix = manifests[0].name.slice(0, -'plugin.json'.length);
  check(entries.every(item => item.name.startsWith(prefix)), '插件目录外存在其他文件，请使用仅包含一个插件的压缩包');
  // Extract only to bounded stdout. The archiver never gets a destination path
  // and cannot create archive-controlled links/files in the filesystem.
  const bytes = run(file, type, ['x', '-so', '-y'], MAX_BYTES + 1);
  check(bytes.length === total, '压缩包实际展开大小与清单不符');
  let offset = 0;
  for (const item of entries) {
    const name = item.name.slice(prefix.length), target = path.resolve(destination, ...name.split('/'));
    check(target.startsWith(path.resolve(destination) + path.sep), '插件包路径越界');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes.subarray(offset, offset + item.size), { flag: 'wx' }); offset += item.size;
  }
}
module.exports = { unpackArchive };
