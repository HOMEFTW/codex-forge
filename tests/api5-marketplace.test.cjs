'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { ForgeRegistry } = require('../runtime/forge-registry.cjs');
const { ForgeMarketplace } = require('../runtime/forge-plugin-market.cjs');
function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api5-market-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ForgeRegistry({ root: path.join(root, 'data'), bundledRoot: path.join(root, 'empty'), versions: { forge: '0.7.0', apiVersion: 5, codex: '26.1106.6628.0' } });
  const source = { id: 'fixture', url: 'https://market.fixture/catalog.json' }, update = { provider: 'server', manifestUrl: 'https://packages.fixture/release.json' };
  const manifest = { schemaVersion: 1, apiVersion: 5, id: 'test.market', name: 'Market fixture', version: '1.0.0', compatibility: { forge: ['>=0.7.0 <0.8.0'] }, permissions: ['storage'], update, ...changes.manifest };
  const bundle = { schemaVersion: 1, files: [{ path: 'plugin.json', encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') }, { path: 'asset.txt', encoding: 'base64', content: Buffer.from('installed payload').toString('base64') }] };
  const bytes = Buffer.from(JSON.stringify(bundle));
  const release = { schemaVersion: 1, id: 'test.market', version: '1.0.0', apiVersion: 5, compatibility: { forge: ['>=0.7.0 <0.8.0'] }, dependencies: {}, url: 'https://packages.fixture/plugin.forge-plugin.json', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...changes.release };
  const catalog = { schemaVersion: 1, plugins: [{ id: 'test.market', name: 'Market fixture', description: 'A searchable fixture', tags: ['math'], update, ...changes.entry }] };
  const routes = new Map([[source.url, catalog], [update.manifestUrl, release], [release.url, bytes]]), requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options }); options.signal?.throwIfAborted();
    const value = routes.get(url); if (typeof value === 'function') return value(options);
    if (value === undefined) return new Response('not found', { status: 404 });
    if (value instanceof Response) return value;
    return new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const market = new ForgeMarketplace({ registry, root: registry.root, bundledCatalog: path.join(root, 'absent-catalog.json'), fetchImpl });
  market.setSources([source]);
  return { root, registry, source, update, manifest, release, catalog, bytes, routes, requests, market };
}
function noInstall(f) {
  assert.equal(f.registry.entries.has('test.market'), false);
  assert.equal(fs.existsSync(path.join(f.registry.root, 'plugins', 'test.market')), false);
  assert.equal(fs.readdirSync(f.registry.root).some(name => name.startsWith('.market-')), false, 'failed imports must remove staging');
}
test('API5 marketplace installs a verified JSON package into the real registry and waits for permission review', async t => {
  const f = fixture(t);
  const catalog = await f.market.catalog({ query: 'MATH' }); assert.equal(catalog.plugins.length, 1);
  const result = await f.market.install({ id: 'test.market', source: 'fixture' });
  assert.equal(result.id, 'test.market'); assert.equal(f.registry.status(result.id).enabled, false);
  assert.equal(f.registry.get(result.id, false).manifest.apiVersion, 5);
  assert.equal(f.registry.source.bind(f.registry) instanceof Function, true);
  assert.equal(fs.readFileSync(path.join(f.registry.get(result.id, false).root, 'asset.txt'), 'utf8'), 'installed payload');
  assert.equal(fs.readdirSync(f.registry.root).some(name => name.startsWith('.market-')), false);
  f.registry.setEnabled(result.id, true); assert.equal(f.registry.status(result.id).enabled, true);
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /已安装/);
});
test('API5 marketplace rejects a corrupt SHA before any plugin file is installed', async t => {
  const f = fixture(t, { release: { sha256: '0'.repeat(64) } });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /SHA-256/); noInstall(f);
});
test('API5 marketplace rejects release identities that disagree with the curated catalog', async t => {
  const f = fixture(t, { release: { id: 'other.plugin' } });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /身份/); noInstall(f);
});
test('API5 marketplace rejects package manifest identities even when its digest is valid', async t => {
  const f = fixture(t, { manifest: { id: 'other.plugin' } });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /包内清单/); noInstall(f);
  assert.equal(f.registry.entries.has('other.plugin'), false);
});
test('API5 marketplace rejects incompatible Forge or API versions before downloading payloads', async t => {
  for (const change of [{ apiVersion: 99 }, { compatibility: { forge: ['>=9.0.0 <10.0.0'] } }]) {
    const f = fixture(t, { release: change });
    await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /Forge|forge|API/); noInstall(f);
    assert.equal(f.requests.some(request => request.url === f.release.url), false);
  }
});
test('API5 marketplace cannot install an entry from an unconfigured or ambiguous source', async t => {
  const f = fixture(t);
  await assert.rejects(f.market.install({ id: 'missing.plugin', source: 'fixture' }), /唯一|目录/); noInstall(f);
  await assert.rejects(f.market.install({ id: 'test.market', source: 'not-configured' }), /唯一|目录/); noInstall(f);
  f.market.setSources([f.source, { id: 'second', url: 'https://second.fixture/catalog.json' }]);
  f.routes.set('https://second.fixture/catalog.json', f.catalog);
  await assert.rejects(f.market.install({ id: 'test.market' }), /唯一/); noInstall(f);
});
test('API5 marketplace prevents a release URL escaping its declared private origin', async t => {
  const f = fixture(t, { release: { url: 'https://other.fixture/injected.forge-plugin.json' } });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /声明服务器/); noInstall(f);
  assert.equal(f.requests.some(request => request.url.startsWith('https://other.fixture')), false);
});
test('API5 marketplace refuses redirects across private origins before contacting the destination', async t => {
  const f = fixture(t);
  f.routes.set(f.update.manifestUrl, new Response(null, { status: 302, headers: { location: 'https://other.fixture/release.json' } }));
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /越出声明来源/); noInstall(f);
  assert.equal(f.requests.some(request => request.url.startsWith('https://other.fixture')), false);
  assert.equal(f.requests.every(request => request.options.redirect === 'manual'), true);
});
test('API5 marketplace permits a same-origin redirect and limits redirect loops', async t => {
  const f = fixture(t);
  f.routes.set(f.update.manifestUrl, () => new Response(null, { status: 302, headers: { location: '/releases/current.json' } }));
  f.routes.set('https://packages.fixture/releases/current.json', f.release);
  assert.equal((await f.market.install({ id: 'test.market', source: 'fixture' })).id, 'test.market');
  const loop = fixture(t); loop.routes.set(loop.update.manifestUrl, () => new Response(null, { status: 302, headers: { location: '/release.json' } }));
  await assert.rejects(loop.market.install({ id: 'test.market', source: 'fixture' }), /重定向次数/); noInstall(loop);
  assert.equal(loop.requests.filter(request => request.url === loop.update.manifestUrl).length, 6);
});
test('API5 marketplace cancellation during the package stream leaves no installed or staged plugin', async t => {
  const f = fixture(t), controller = new AbortController();
  f.routes.set(f.release.url, () => { let sent = false; return new Response(new ReadableStream({ pull(stream) { if (!sent) { sent = true; stream.enqueue(f.bytes.subarray(0, 20)); } else { controller.abort(); stream.enqueue(f.bytes.subarray(20)); stream.close(); } } })); });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }, { signal: controller.signal }), { name: 'AbortError' }); noInstall(f);
});
test('API5 marketplace revalidates authority immediately before committing unpacked content', async t => {
  const f = fixture(t);
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }, { revalidate() { if (fs.readdirSync(f.registry.root).some(name => name.startsWith('.market-'))) throw Object.assign(Error('revoked fixture'), { code: 'PERMISSION_DENIED' }); } }), { code: 'PERMISSION_DENIED' }); noInstall(f);
});
test('API5 marketplace rejects packages that silently replace their declared update source', async t => {
  const f = fixture(t, { manifest: { update: { provider: 'server', manifestUrl: 'https://other.fixture/release.json' } } });
  await assert.rejects(f.market.install({ id: 'test.market', source: 'fixture' }), /更换.*来源/); noInstall(f);
});
test('API5 marketplace accepts only credential-free HTTPS source configuration', t => {
  const f = fixture(t);
  for (const url of ['http://market.fixture/catalog.json', 'https://user:password@market.fixture/catalog.json']) assert.throws(() => f.market.setSources([{ id: 'bad', url }]), /HTTPS/);
  assert.throws(() => f.market.setSources([f.source, f.source]), /重复/);
  assert.deepEqual(f.market.sources(), [f.source]);
});
