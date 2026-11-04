'use strict';
const fs = require('node:fs'), path = require('node:path');
const { check } = require('./forge-manifest.cjs');
function unpack(file, destination) {
  check(fs.statSync(file).isFile() && fs.statSync(file).size <= 30 * 1024 * 1024, '插件包超过 30MB 或不是普通文件');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(bundle?.schemaVersion === 1 && Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= 1000, '插件包格式无效');
  const names = new Set(); let bytes = 0;
  for (const item of bundle.files) {
    check(item && typeof item.path === 'string' && item.path.length <= 250 && !/[\\:\x00-\x1f<>"|?*]/.test(item.path), '插件包路径无效');
    const parts = item.path.split('/');
    check(parts.every(part => part && !['.', '..', '.git', 'node_modules'].includes(part.toLowerCase()) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), '插件包路径无效');
    const key = item.path.toLowerCase(); check(!names.has(key), '插件包包含重复路径'); names.add(key);
    check(item.encoding === 'base64' && typeof item.content === 'string', '插件资源必须为 base64');
    const content = Buffer.from(item.content, 'base64'); check(content.toString('base64') === item.content, '插件资源 base64 无效');
    bytes += content.length; check(bytes <= 20 * 1024 * 1024, '插件解包内容超过 20MB');
    const target = path.resolve(destination, ...parts); check(target.startsWith(path.resolve(destination) + path.sep), '插件包路径越界');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, { flag: 'wx' });
  }
  check(names.has('plugin.json'), '插件包缺少 plugin.json');
}
module.exports = { unpack };
