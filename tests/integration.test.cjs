const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
test('native menu opens package notes and IPC rejects other origins and subframes', async t => {
 const output = path.resolve(__dirname, '../output/main-test'); fs.mkdirSync(output, { recursive: true });
 const root = fs.mkdtempSync(path.join(output, 'case-'));
 const app = new EventEmitter(), handlers = new Map(), sent = [];
 const win = new EventEmitter(); win.id = 1; win.isDestroyed = () => false;
 win.webContents = { id: 1, getURL: () => 'app://-/index.html', mainFrame: { processId: 20, routingId: 1 }, send: (...args) => sent.push(args) };
 class MenuItem { constructor(options) { Object.assign(this, options); } }
 const Menu = { setApplicationMenu() {}, getApplicationMenu() {} };
 const fake = { app, BrowserWindow: { fromWebContents: () => win, getAllWindows: () => [win], getFocusedWindow: () => win }, ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) }, Menu, MenuItem, dialog: {}, shell: {} };
 const oldLoad = Module._load, oldRoot = process.env.CODEX_FAST_CANVAS_DIR;
 const oldForgeRoot=process.env.CODEX_FORGE_HOME;process.env.CODEX_FORGE_HOME=path.join(root,'forge');t.after(()=>{if(oldForgeRoot===undefined)delete process.env.CODEX_FORGE_HOME;else process.env.CODEX_FORGE_HOME=oldForgeRoot;});
 process.env.CODEX_FAST_CANVAS_DIR = root;
 Module._load = function(name, ...args) { return name === 'electron' ? fake : oldLoad.call(this, name, ...args); };
 try {
  require('../runtime/main.cjs').install();
  const event = { sender: win.webContents, senderFrame: { processId: 20, routingId: 1 } };
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
  await assert.rejects(handlers.get('fast-ext:canvas')({ ...event, senderFrame: { processId: 20, routingId: 2 } }, { method: 'list' }), /Untrusted/);
  const oldURL = win.webContents.getURL; win.webContents.getURL = () => 'https://example.com/';
  assert.throws(() => handlers.get('fast-ext:host-ready')(event), /Untrusted/); win.webContents.getURL = oldURL;
  await handlers.get('fast-ext:canvas')(event, { method: 'mode', args: { mode: 'expanded' } }); assert.equal(sent.at(-1)[1].mode, 'expanded');
  await handlers.get('fast-ext:canvas')(event, { method: 'close' }); assert.equal(sent.at(-1)[1], null);
 } finally { app.emit('will-quit'); Module._load = oldLoad; if (oldRoot === undefined) delete process.env.CODEX_FAST_CANVAS_DIR; else process.env.CODEX_FAST_CANVAS_DIR = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
});
