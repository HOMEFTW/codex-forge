'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { check, safeFile } = require('./forge-manifest.cjs');
const MAX_BYTES = 20 * 1024 * 1024;
const packageName = value => {
  check(typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value), 'DSH npm 包名无效');
  return value;
};
function clientExport(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['browser', 'import', 'default']) { const found = clientExport(value[key]); if (found) return found; }
  }
  return null;
}
function inspectDshClient(directory) {
  const root = fs.realpathSync(directory), pkg = JSON.parse(fs.readFileSync(safeFile(root, 'package.json'), 'utf8'));
  const name = packageName(pkg.name), exported = clientExport(pkg.exports?.['./client']);
  check(typeof pkg.version === 'string', 'DSH 包缺少版本');
  check(exported?.startsWith('./') && exported.endsWith('.js'), '仅支持 exports["./client"] 指向预构建 JavaScript 的 DSH UI 包');
  const entry = exported.slice(2), file = safeFile(root, entry), stat = fs.statSync(file);
  check(stat.size <= MAX_BYTES, 'DSH 客户端超过20MB');
  const script = fs.readFileSync(file, 'utf8');
  check(/\b__ModuleLoader__\s*\.\s*load\s*\(/.test(script), '此包未使用受支持的 DSH 浏览器模块格式');
  const css = entry.replace(/\.js$/, '.css');
  return { name, version: pkg.version, description: typeof pkg.description === 'string' ? pkg.description.slice(0, 20000) : '', root, entry, css: fs.existsSync(path.join(root, css)) ? css : null };
}
function idForPackage(name) {
  packageName(name);
  const slug = name.replace(/^@/, '').replace(/[^a-z0-9-]+/g, '-').slice(0, 65);
  return 'dsh.' + (/^[a-z]/.test(slug) ? slug : 'pkg-' + slug) + '-' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
}
async function download(url, { fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES, hostname } = {}) {
  const u = new URL(url);
  check(u.protocol === 'https:' && !u.username && !u.password && u.hostname === hostname, 'DSH 下载源不受支持');
  const response = await fetchImpl(u.href, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  check(response.ok, 'DSH 下载失败：HTTP ' + response.status);
  check(Number(response.headers.get('content-length') || 0) <= maxBytes, 'DSH 下载超过大小限制');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) { throw Error('DSH 下载超过大小限制'); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function verifyIntegrity(bytes, integrity) {
  check(typeof integrity === 'string', 'npm 发布包未提供完整性摘要');
  const supported = integrity.split(/\s+/).map(token => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token)).filter(Boolean);
  check(supported.length && supported.some(([, algorithm, expected]) => crypto.createHash(algorithm).update(bytes).digest('base64') === expected), 'npm 发布包完整性校验失败');
}
function unpackNpm(bytes, destination) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_BYTES }); let at = 0, count = 0, pendingPath = null;
  const text = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const relative = name => {
    check(name.startsWith('package/'), 'npm 包缺少 package 根目录');
    const clean = name.slice(8).replace(/\/$/, '');
    check(clean && clean.length < 250 && !/[\\:\x00-\x1f]/.test(clean) && clean.split('/').every(p => p && p !== '.' && p !== '..'), 'npm 包文件路径无效');
    return clean;
  };
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512); if (header.every(b => b === 0)) break;
    const octal = (start, length) => { const raw = text(header, start, length).trim(); check(/^[0-7]*$/.test(raw), 'npm tar 数值格式不受支持'); return parseInt(raw || '0', 8); };
    const checksum = octal(148, 8), actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    check(checksum === actual, 'npm tar 文件头校验失败');
    const size = octal(124, 12), type = text(header, 156, 1), start = at + 512;
    check(start + size <= tar.length && ++count <= 1000, 'npm tar 文件不完整或超过1000项');
    const data = tar.subarray(start, start + size); at = start + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const pax = data.toString('utf8');
      check(!/(?:^|\n)\d+ (?:linkpath|GNU\.)/.test(pax), 'npm tar 扩展类型不受支持');
      const found = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(pax); if (found) pendingPath = found[1];
      continue;
    }
    const name = pendingPath || [text(header, 345, 155), text(header, 0, 100)].filter(Boolean).join('/'); pendingPath = null;
    if (type === '5' && /^package\/?$/.test(name)) continue;
    const file = path.join(destination, relative(name));
    if (type === '5') fs.mkdirSync(file, { recursive: true });
    else { check(type === '' || type === '0', 'npm 包含不受支持的文件类型'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { flag: 'wx' }); }
  }
  check(count > 0, 'npm 发布包为空');
}
module.exports = { inspectDshClient, idForPackage, packageName, download, verifyIntegrity, unpackNpm };
