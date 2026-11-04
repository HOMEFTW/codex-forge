const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const currentCodexVersion = require('../forge.config.json').codexVersion;
test('native menu opens package notes and IPC rejects other origins and subframes', async t => {
 const output = path.resolve(__dirname, '../output/main-test'); fs.mkdirSync(output, { recursive: true });
 const root = fs.mkdtempSync(path.join(output, 'case-'));
 const app = new EventEmitter(), handlers = new Map(), sent = [];
  const win = new EventEmitter(); win.id = 1; win.isDestroyed = () => false;
 win.webContents = { id: 1, getURL: () => 'app://-/index.html', mainFrame: { processId: 20, routingId: 1 }, send: (...args) => sent.push(args) };
  const sentSecond = [], secondWin = new EventEmitter(); secondWin.id = 2; secondWin.isDestroyed = () => false;
  secondWin.webContents = { id: 2, getURL: () => 'app://-/index.html', mainFrame: { processId: 21, routingId: 1 }, send: (...args) => sentSecond.push(args) };
  const windows = [win, secondWin];
 class MenuItem { constructor(options) { Object.assign(this, options); } }
 const Menu = { setApplicationMenu() {}, getApplicationMenu() {} };
  const fake = { app, BrowserWindow: { fromWebContents: contents => windows.find(value => value.webContents === contents) || null, getAllWindows: () => windows, getFocusedWindow: () => win }, ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) }, Menu, MenuItem, dialog: {}, shell: {} };
 const oldLoad = Module._load, oldRoot = process.env.CODEX_FAST_CANVAS_DIR;
 const oldForgeRoot=process.env.CODEX_FORGE_HOME;process.env.CODEX_FORGE_HOME=path.join(root,'forge');t.after(()=>{if(oldForgeRoot===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=oldForgeRoot;});
 process.env.CODEX_FAST_CANVAS_DIR = root;
 const oldCodexHome = process.env.CODEX_HOME;
 process.env.CODEX_HOME = path.join(root, 'codex'); fs.mkdirSync(process.env.CODEX_HOME);
 fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [
   { slug: 'gpt-6-sol', display_name: 'Sol', visibility: 'list', base_instructions: 'private prompt' },
   { slug: 'internal', visibility: 'hide' }
 ] }));
 t.after(() => { if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome; });
 Module._load = function(name, ...args) { return name === 'electron' ? fake : oldLoad.call(this, name, ...args); };
 try {
  const services = require('../runtime/main.cjs').install();
  const event = { sender: win.webContents, senderFrame: { processId: 20, routingId: 1 } };
  const api = async (...args) => { const reply = await handlers.get('forge:api')(...args); if (!reply.ok) throw Object.assign(Error(reply.error.message), { code: reply.error.code }); return reply.result; };
  const manage = (method, args = {}) => handlers.get('forge:manage')(event, { method, args });
  const models = await manage('fastModels', { enableTerra: true });
  assert.deepEqual(models.map(model => model.id), ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  assert(models.every(model => Object.keys(model).sort().join(',') === 'fast,id,name'));
  assert(!(await manage('fastModels', { enableTerra: false })).some(model => model.id === 'gpt-6.1-terra'));
  await assert.rejects(manage('fastModels', { enableTerra: 'false' }), /Terra 开关无效/);
  const selected = await manage('saveSettings', { id: 'forge.fast', value: { hiddenModels: ['gpt-6-sol'] } });
  assert.deepEqual(selected.hiddenModels, ['gpt-6-sol']);
  await assert.rejects(manage('saveSettings', { id: 'forge.fast', value: { hiddenModels: models.map(model => model.id) } }), /至少/);
  assert.deepEqual((await manage('settings', { id: 'forge.fast' })).hiddenModels, ['gpt-6-sol']);
  const savedFast = process.env.CODEX_FORGE_FAST; process.env.CODEX_FORGE_FAST = '1';
  handlers.get('forge:startup-flags')(event); assert.equal(event.returnValue.fastEnabled, true);
  const untrusted = { ...event, senderFrame: { processId: 20, routingId: 2 } }; handlers.get('forge:startup-flags')(untrusted); assert.equal(untrusted.returnValue.fastEnabled, false);
  if (savedFast === undefined) delete process.env.CODEX_FORGE_FAST; else process.env.CODEX_FORGE_FAST = savedFast;
  fake.ipcMain.handle('codex_desktop:message-from-view', async () => 'original-handler');
  const originalMessage = handlers.get('codex_desktop:message-from-view');
  assert.equal(await originalMessage(event, { type: 'remote-hosted-pip-active-thread-changed', conversationId: 'thread-visible' }), 'original-handler');
  assert.equal((await handlers.get('fast-ext:overview')(event)).threadId, 'thread-visible');
  await originalMessage({ ...event, senderFrame: { processId: 20, routingId: 2 } }, { type: 'remote-hosted-pip-active-thread-changed', conversationId: 'spoofed' });
  assert.equal((await handlers.get('fast-ext:overview')(event)).threadId, 'thread-visible');
  await originalMessage(event, { type: 'remote-hosted-pip-active-thread-changed', conversationId: null });
  assert.equal((await handlers.get('fast-ext:overview')(event)).threadId, null);
  assert.equal(await handlers.get('fast-ext:host-ready')(event), null);
  await handlers.get('fast-ext:host-open')(event, { page: 'updates' }); assert.equal(sent.at(-1)[1].page, 'updates');
  await handlers.get('fast-ext:host-open')(event, { page: 'other' }); assert.equal(sent.at(-1)[1].page, 'canvas');
  const menu = { items: [{ label: '文件' }, { label: '帮助', role: 'help' }], getMenuItemById(id) { return this.items.find(item => item.id === id); }, insert(index, item) { this.items.splice(index, 0, item); } };
  Menu.setApplicationMenu(menu); Menu.setApplicationMenu(menu);
  assert.deepEqual(menu.items.map(item => item.label), ['文件','帮助','升级','插件管理']);
  menu.items[2].submenu[0].click(); assert.equal(sent.at(-1)[1].page, 'forge-updates');
  const bootstrap = await handlers.get('fast-ext:canvas')(event, { method: 'bootstrap' }); assert.equal(bootstrap.notes.revision, 'r4');
  const pluginRoot = path.join(root, 'composer-plugin'); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, apiVersion: 3, id: 'test.composer', name: 'Composer fixture', version: '0.1.0',
    compatibility: { codex: [currentCodexVersion], forge: ['>=0.4.0 <0.5.0'] }, permissions: ['composer'], contributes: {}
  }));
  services.forge.registry.install(pluginRoot); services.forge.registry.setEnabled('test.composer', true);
  await assert.rejects(api(event, { id: 'test.composer', method: 'composer.read', args: {}, threadId: 'thread-visible' }), /conversation\.read/);
  const narrowRoot = path.join(root, 'narrow-plugin'); fs.mkdirSync(narrowRoot, { recursive: true });
  fs.writeFileSync(path.join(narrowRoot, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, apiVersion: 3, id: 'test.narrow', name: 'Narrow fixture', version: '0.1.0',
    compatibility: { codex: [currentCodexVersion], forge: ['>=0.4.0 <0.5.0'] },
    permissions: ['panels', 'storage'], capabilities: [{ name: 'panels', version: 1 }], contributes: {}
  }));
  services.forge.registry.install(narrowRoot); services.forge.registry.setEnabled('test.narrow', true);
  await assert.rejects(api(event, { id: 'test.narrow', method: 'storage.get', args: { key: 'x' } }), /未声明能力 "storage"/);
  const narrowCapabilities = await api(event, { id: 'test.narrow', method: 'capabilities.get', args: {} });
  assert.deepEqual(narrowCapabilities.capabilities.map(item => item.name), ['panels']);
  assert.match(narrowCapabilities.denied['storage.get'], /storage/);
  assert.equal(narrowCapabilities.denied['panels.open'], undefined);
  const nexusRoot = path.join(root, 'nexus-reader'); fs.mkdirSync(nexusRoot);
  fs.writeFileSync(path.join(nexusRoot, 'plugin.json'), JSON.stringify({ schemaVersion: 1, apiVersion: 3, id: 'test.nexus', name: 'Reader', version: '1.0.0', compatibility: { codex: [currentCodexVersion], forge: ['>=0.4.0 <0.5.0'] }, permissions: ['nexus.read'], capabilities: [{ name: 'nexus', version: 1, optional: true }] }));
  services.forge.registry.install(nexusRoot); services.forge.registry.setEnabled('test.nexus', true);
  const nexusCall = (method, args = {}) => api(event, { id: 'test.nexus', method: 'nexus.request', args: { method, args } });
  assert(Array.isArray((await nexusCall('vaults')).vaults));
  await assert.rejects(nexusCall('write', { vaultId: 'missing', path: 'x.md', content: '', expectedRevision: '' }), e => e.code === 'PERMISSION_DENIED');
  await assert.rejects(nexusCall('read', { vaultId: 'missing', path: 'x.md' }), e => e.code === 'VAULT_NOT_CONNECTED');
  await assert.rejects(nexusCall('connect', { path: root }), e => e.code === 'INVALID_ARGUMENT');
  const nexusCapabilities = await api(event, { id: 'test.nexus', method: 'capabilities.get' });
  assert.deepEqual(nexusCapabilities.negotiated.map(x => [x.supported, x.enabled, x.granted]), [[true, true, true]]);
  services.forge.registry.setEnabled('test.nexus', false);
  await assert.rejects(nexusCall('vaults'), e => e.code === 'PLUGIN_DISABLED');
  services.forge.registry.setEnabled('test.nexus', true);
  await assert.rejects(api(event, {id:'test.nexus',method:'nexus.connect'}), e=>e.code==='PERMISSION_DENIED');
  const writerRoot=path.join(root,'nexus-writer'); fs.mkdirSync(writerRoot);
  const writerManifest={...JSON.parse(fs.readFileSync(path.join(nexusRoot,'plugin.json'))),id:'test.nexus-writer',permissions:['nexus.read','nexus.write']};
  fs.writeFileSync(path.join(writerRoot,'plugin.json'),JSON.stringify(writerManifest));
  services.forge.registry.install(writerRoot); services.forge.registry.setEnabled(writerManifest.id,true);
  const writer=(method,args={})=>api(event,{id:writerManifest.id,method,args});
  let selectedCalls=0;
  fake.dialog.showOpenDialog=async()=>{selectedCalls++;return {canceled:true,filePaths:[]};};
  await assert.rejects(writer('nexus.connect',{root}),e=>e.code==='INVALID_ARGUMENT');assert.equal(selectedCalls,0);
  assert.equal(await writer('nexus.connect'),null);
  const vault=path.join(root,'chosen-vault');fs.mkdirSync(vault);
  fake.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[vault]});
  const connected=await writer('nexus.connect');assert.equal(connected.vault.root,vault);
  assert.equal((await nexusCall('vaults')).vaults.length,1);
  await writer('nexus.disconnect',{vaultId:connected.vault.id});assert.equal((await nexusCall('vaults')).vaults.length,0);
  fake.dialog.showOpenDialog=async()=>{services.forge.registry.setEnabled(writerManifest.id,false);return {canceled:false,filePaths:[vault]};};
  await assert.rejects(writer('nexus.connect'),e=>e.code==='PLUGIN_DISABLED');assert.equal((await nexusCall('vaults')).vaults.length,0);
  assert.equal(handlers.has('fast-ext:nexus'),false,'Nexus UI has no builtin IPC channel');
  fs.writeFileSync(path.join(process.env.CODEX_FORGE_HOME, 'profile.json'), JSON.stringify({ schemaVersion: 1, bundles: ['forge.builtin'], patches: [] }));
  const planned = await handlers.get('forge:manage')(event, { method: 'bundlePlan', args: {} });
  assert.deepEqual(planned.sources.map(item => item.name), ['bundle:forge.builtin']);
  assert(planned.entries.some(item => item.id === 'forge.canvas'), 'plan lists every bundled plugin');
  const appliedBundle = await handlers.get('forge:manage')(event, { method: 'bundleApply', args: {} });
  assert(appliedBundle.applied.length > 0);
  assert.deepEqual(appliedBundle.missing, []);
   const eventPluginRoot = path.join(root, 'event-plugin'); fs.mkdirSync(eventPluginRoot, { recursive: true });
   fs.writeFileSync(path.join(eventPluginRoot, 'main.js'), 'void 0');
   fs.writeFileSync(path.join(eventPluginRoot, 'plugin.json'), JSON.stringify({
     schemaVersion: 1, apiVersion: 3, id: 'test.events', name: 'Events fixture', version: '0.1.0',
     compatibility: { codex: [currentCodexVersion], forge: ['>=0.4.0 <0.5.0'] }, permissions: ['events'], entry: 'main.js', contributes: { events: [{ name: 'plugin.test.events.status' }] }
   }));
   services.forge.registry.install(eventPluginRoot); services.forge.registry.setEnabled('test.events', true);
   const secondEvent = { sender: secondWin.webContents, senderFrame: { processId: 21, routingId: 1 } };
   await handlers.get('fast-ext:overview')(secondEvent);
   const firstBefore = sent.length, secondBefore = sentSecond.length;
   await api(event, { id: 'test.events', method: 'events.emit', args: { name: 'plugin.test.events.status', value: { ready: true } }, threadId: null });
   assert.ok(sent.slice(firstBefore).some(item => item[1]?.type === 'forge-plugin-event'));
   assert.equal(sentSecond.slice(secondBefore).some(item => item[1]?.type === 'forge-plugin-event'), false);
  await assert.rejects(handlers.get('fast-ext:canvas')({ ...event, senderFrame: { processId: 20, routingId: 2 } }, { method: 'list' }), /Untrusted/);
  const oldURL = win.webContents.getURL; win.webContents.getURL = () => 'https://example.com/';
  assert.throws(() => handlers.get('fast-ext:host-ready')(event), /Untrusted/); win.webContents.getURL = oldURL;
  await handlers.get('fast-ext:canvas')(event, { method: 'mode', args: { mode: 'expanded' } }); assert.equal(sent.at(-1)[1].mode, 'expanded');
  await handlers.get('fast-ext:canvas')(event, { method: 'close' }); assert.equal(sent.at(-1)[1], null);
 } finally { app.emit('will-quit'); Module._load = oldLoad; if (oldRoot === undefined) delete process.env.CODEX_FAST_CANVAS_DIR; else process.env.CODEX_FAST_CANVAS_DIR = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
});
