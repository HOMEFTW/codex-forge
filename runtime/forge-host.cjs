'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ForgeRegistry } = require('./forge-registry.cjs');
const { check } = require('./forge-manifest.cjs');
const { atomic, json } = require('./collaboration-store.cjs');
const { DshCompatibilityLayer } = require('./dsh-compat.cjs');
function installForge({ ipcMain, dialog, host, threadContext, nativeCall, nativeMessage, open, notify, states, collaboration }) {
  const config = json(fs.existsSync(path.join(__dirname,'forge.config.json'))?path.join(__dirname,'forge.config.json'):path.join(__dirname,'../forge.config.json'));
  const root = process.env.CODEX_FORGE_HOME || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'forge');
  const registry = new ForgeRegistry({ root, bundledRoot:fs.existsSync(path.join(__dirname,'plugins'))?path.join(__dirname,'plugins'):path.join(__dirname,'../plugins'), versions: { codex: config.codexVersion, forge: config.version, apiVersion: config.apiVersion } });
  const dsh = new DshCompatibilityLayer({ runtimeVersion: process.env.DSH_VERSION || '' });
  require('./forge-content.cjs').registerPluginProtocol(registry,require('electron'));
  const pluginUpdates = require('./forge-plugin-updates.cjs'), pluginPlans = new Map();
  const updateResults = pluginUpdates.applyPending(registry);
  config.githubRepository = json(path.join(root,'updates.json'),{}).repository || config.githubRepository;
  const dynamic = new Map(), outputFile = path.join(root, 'output.json');
  let output = json(outputFile, {}), currentUpdate = null;
  const publicContext = (event, state) => ({ threadId: threadContext(event, state).threadId, codexVersion: config.codexVersion, forgeVersion: config.version, apiVersion: config.apiVersion });
  function broadcast() { for (const state of states.values()) notify(state, { type: 'forge-refresh' }); }
  function broadcastPluginEvent(name, value, metadata = {}, threadId = null) {
    for (const target of states.values()) {
      if (target.win.isDestroyed()) continue;
      if (threadId && target.threadId !== threadId) continue;
      notify(target, { type: 'forge-plugin-event', name, value, metadata: { ...metadata, threadId } });
    }
  }
  function snapshot(event, state) {
    const result = registry.list();
    return { ...result, pluginUpdates:Object.fromEntries(pluginPlans), pendingUpdates:pluginUpdates.pendingUpdates(registry), pluginUpdateResults:updateResults, context: publicContext(event, state), dynamic: [...dynamic.values()].filter(x => registry.status(x.pluginId).enabled), settingsPlugin: state.settingsPlugin || null, output: output[state.threadId] || [], config: { githubRepository: config.githubRepository, channel: config.channel }, dsh: dsh.snapshot(), update: currentUpdate };
  }
  function panel(id, viewId) {
    const entry = registry.permission(id, 'panels'), view = entry.manifest.contributes?.panels?.find(v => v.id === viewId);
    check(view, '面板未声明'); return view;
  }
  const pageId = (id, view) => `forge-plugin:${id}:${view}`;
  function text(value, max, label) { check(typeof value === 'string' && value.length <= max, label+'无效'); return value; }
  function eventName(value) {
    check(typeof value === 'string' && /^(?:plugin\.[a-z][a-z0-9.-]*\.[a-z][a-z0-9_.:-]{0,79}|plugin\.event)$/.test(value), '事件名称必须使用 plugin.<插件域名>.<事件名> 格式');
    return value;
  }
  function eventValue(value) {
    check(value === null || (typeof value === 'object' && value !== undefined) || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean', '事件数据必须为 JSON 值');
    let encoded; try { encoded = JSON.stringify(value); } catch { throw Error('事件数据必须可序列化'); }
    check(Buffer.byteLength(encoded || 'null') <= 64 * 1024, '事件数据超过 64KB');
    return value;
  }
  function expectedThread(event, state, request) {
    const context = publicContext(event, state); check(context.threadId && request.threadId === context.threadId, '当前对话已变化或尚未创建'); return context.threadId;
  }
  async function management(event, method, args = {}) {
    const state = host(event);
    switch (method) {
      case 'returnToChat': state.win.webContents.send('codex_desktop:message-for-view',{type:'navigate-back'});return true;
      case 'snapshot': return snapshot(event, state);
      case 'openSettings': { registry.get(args.id, false); state.settingsPlugin = args.id; state.win.webContents.send('codex_desktop:message-for-view', {type:'navigate-to-route',path:'/settings/codex-forge?plugin='+encodeURIComponent(args.id)}); notify(state,{type:'forge-settings-focus',id:args.id}); return true; }
      case 'openPage': { check(['forge-updates','forge-features','forge-changelog','forge-plugins','forge-extension-info','forge-output'].includes(args.page),'未知页面'); open(state,{page:args.page}); return true; }
      case 'enable': {
        const result = registry.setEnabled(args.id, args.enabled);
        if (args.id === 'forge.collaboration' && !args.enabled) for (const thread of collaboration.store.threads()) for (const job of collaboration.store.jobs(thread.id)) if (['running','queued','awaiting_approval'].includes(job.status)) collaboration.store.cancel(job.id);
        for (const [key, value] of dynamic) if (!registry.status(value.pluginId).enabled) dynamic.delete(key);
        broadcast(); return result;
      }
      case 'checkPluginUpdate': { const result=await pluginUpdates.checkPluginUpdate(registry,args.id);pluginPlans.set(args.id,result);broadcast();return result; }
      case 'stagePluginUpdate': { const result=await pluginUpdates.stagePluginUpdate(registry,pluginPlans.get(args.id));broadcast();return result; }
      case 'settings': return registry.settings(args.id);
      case 'saveSettings': { const result = registry.settings(args.id, args.value); broadcast(); return result; }
      case 'install': {
        const selected = await dialog.showOpenDialog(state.win, { title: '安装 Codex Forge 插件', properties: ['openDirectory'] });
        if (selected.canceled || !selected.filePaths[0]) return null;
        const result = registry.install(selected.filePaths[0]); broadcast(); return result;
      }
      case 'uninstall': { const result = registry.uninstall(args.id); broadcast(); return result; }
      case 'reload': { const result = registry.reload(); broadcast(); return result; }
      case 'openPanel': { const view = panel(args.id, args.view); open(state, { page: view.builtinPage || pageId(args.id, view.id), mode: view.placement }); return true; }
      case 'updateRepository': {
        check(typeof args.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository), '使用 owner/repository 格式');
        const settings = json(path.join(root, 'updates.json'), {}); settings.repository = args.repository; atomic(path.join(root, 'updates.json'), settings); config.githubRepository = args.repository; currentUpdate=null; broadcast(); return true;
      }
      case 'checkUpdates': {
        const { checkUpdates } = require('./forge-updates.cjs');
        currentUpdate = await checkUpdates({ config: { ...config, ...json(path.join(root,'updates.json'),{}) }, plugins: registry.list().plugins.filter(p => p.enabled) }); broadcast(); return currentUpdate;
      }
      case 'stageUpdate': {
        check(currentUpdate?.plan?.compatible, '请先检测到匹配版本');
        const { stageUpdate, recheckPlan } = require('./forge-updates.cjs');
        const plan=recheckPlan(currentUpdate.plan,{config,plugins:registry.list().plugins.filter(p=>p.enabled),native:currentUpdate.native});
        const result = await stageUpdate(plan, path.join(root, 'updates'));
        currentUpdate.staged = result; broadcast(); return result;
      }
      case 'applyUpdate': {
        check(currentUpdate?.staged, '请先下载并校验匹配更新');
        const { launchUpdate, recheckPlan } = require('./forge-updates.cjs');
        recheckPlan(currentUpdate.staged,{config,plugins:registry.list().plugins.filter(p=>p.enabled),native:currentUpdate.native});
        return launchUpdate(currentUpdate.staged, process.env.CODEX_FORGE_INSTALL_ROOT, process.execPath);
      }
      default: throw Error('未知 Forge 管理操作');
    }
  }
  ipcMain.handle('forge:manage', (event, { method, args } = {}) => management(event, method, args));
  ipcMain.handle('forge:bundle', (event, { id, viewId } = {}) => {
    host(event); const entry = registry.get(id), m = entry.manifest;
    const html = viewId ? registry.source(id, panel(id, viewId).entry) : '<!doctype html><html><head></head><body></body></html>';
    check(Buffer.byteLength(html) < 2*1024*1024, '插件页面超过2MB');
    return { html, sdk: fs.readFileSync(path.join(__dirname,'forge-sdk.js'),'utf8'), script: !viewId && m.entry ? registry.source(id,m.entry) : '', networkOrigins: m.networkOrigins || [], context: publicContext(event, host(event)) };
  });
  ipcMain.handle('forge:api', async (event, request = {}) => {
    const state = host(event), { id, method, args = {} } = request, entry = registry.get(id);
    const permission = name => registry.permission(id, name);
    switch (method) {
      case 'context.get': { const value=publicContext(event,state); if(!entry.manifest.permissions.includes('conversation.read')) value.threadId=null; return value; }
      case 'metadata.get': return entry.manifest;
      case 'capabilities.get': return { apiVersion: config.apiVersion, codexVersion: config.codexVersion, forgeVersion: config.version, permissions: [...entry.manifest.permissions], events: ['ready','context.changed','settings.changed','dispose','output.changed',...(entry.manifest.contributes?.events || []).map(item => item.name)], surfaces: ['panels','sidebar','toolbar','composer'] };
      case 'settings.get': permission('settings'); return registry.settings(id);
      case 'storage.get': case 'storage.set': case 'storage.delete': return registry.storage(id, method.split('.')[1], args.key, args.value);
      case 'panels.open': { const view = panel(id,args.id); if (args.mode === 'expanded') check(view.placement === 'expanded', '此面板未声明全宽功能需求'); open(state,{page:pageId(id,view.id),mode:view.placement}); return {page:pageId(id,view.id)}; }
      case 'panels.close': panel(id,args.id); return { nativeAction: 'close', page: pageId(id,args.id) };
      case 'ui.register': {
        check(['sidebar','toolbar','composer'].includes(args.surface), '未知界面位置'); permission(args.surface);
        const item = args.item; check(item && /^[a-zA-Z][\w-]{0,79}$/.test(item.id), '按钮 ID 无效'); text(item.title,100,'按钮标题');
        check(entry.manifest.contributes?.commands?.some(c => c.id === item.command) || entry.manifest.contributes?.panels?.some(p => p.id === item.panel), '按钮操作未声明');
        check(dynamic.size < 200 || dynamic.has(id+':'+args.surface+':'+item.id), '动态按钮数量超限');
        dynamic.set(id+':'+args.surface+':'+item.id,{pluginId:id,surface:args.surface,item:{id:item.id,title:item.title,command:item.command,panel:item.panel}}); broadcast(); return true;
      }
      case 'ui.unregister': permission(args.surface); dynamic.delete(id+':'+args.surface+':'+args.id); broadcast(); return true;
      case 'conversation.title': {
        permission('conversation.title'); const threadId = expectedThread(event,state,request), name = text(args.title,300,'会话标题').trim(); check(name,'标题不能为空');
        await nativeCall(state,'thread/name/set',{threadId,name}); state.win.webContents.send('codex_desktop:message-for-view',{type:'thread-title-updated',hostId:'local',conversationId:threadId,title:name}); broadcast(); return {threadId,title:name};
      }
      case 'composer.read': case 'composer.insert': case 'composer.set':
        permission('composer'); expectedThread(event,state,request); if (method !== 'composer.read') { text(args.text,200000,'输入内容'); text(args.expectedText,200000,'输入框快照'); }
        return { nativeAction:method,args };
      case 'browser.open': {
        permission('browser'); const threadId = expectedThread(event,state,request), url = new URL(text(args.url,10000,'浏览器地址')); check(['https:','http:'].includes(url.protocol) && !url.username && !url.password,'仅支持无凭据的HTTP(S)地址');
        await nativeMessage(state,{type:'open-in-browser',url:url.href,conversationId:threadId,hostId:'local',initiator:'app',source:'codex-forge',useExternalBrowser:false}); return {opened:url.href};
      }
      case 'events.emit': {
        permission('events');
        const name = eventName(args.name), value = eventValue(args.value);
        check((entry.manifest.contributes?.events || []).some(item => item.name === name), '事件必须先在 plugin.json.contributes.events 中声明');
        const threadId = request.threadId || null;
        if (threadId) expectedThread(event, state, request);
        const metadata = { sourcePluginId: id, threadId };
        broadcastPluginEvent(name, value, metadata, threadId);
        return { accepted: true, name };
      }
      case 'output.append': case 'output.clear': case 'output.open': {
        permission('output'); const threadId = expectedThread(event,state,request);
        if (method === 'output.open') { open(state,{page:'forge-output'}); return true; }
        const items = output[threadId] ||= [];
        if (method === 'output.clear') output[threadId] = items.filter(x => x.pluginId !== id);
        else { items.push({pluginId:id,pluginName:entry.manifest.name,text:text(args.text,200000,'输出'),title:text(args.title||entry.manifest.name,200,'输出标题'),at:new Date().toISOString(),level:['info','warning','error'].includes(args.level)?args.level:'info'}); while (items.length > 100 || Buffer.byteLength(JSON.stringify(items)) > 2*1024*1024) items.shift(); }
        atomic(outputFile,output); broadcastPluginEvent('output.changed', { threadId, pluginId: id }); broadcast(); return true;
      }
      default: throw Error('Forge API 不支持此操作');
    }
  });
  return { registry, management, snapshot, page: page => ['forge-settings','forge-updates','forge-features','forge-changelog','forge-plugins','forge-extension-info','forge-output'].includes(page) || [...registry.entries.values()].some(e => registry.status(e.manifest.id).enabled && e.manifest.contributes?.panels?.some(v => pageId(e.manifest.id,v.id) === page)), enabled: id => registry.status(id).enabled };
}
module.exports = { installForge };
