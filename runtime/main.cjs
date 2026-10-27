'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CanvasStore } = require('./store.cjs');
const { TodoStore } = require('./todos.cjs');
const { ThreadContexts, userSubmission } = require('./context.cjs');
const { CollaborationService } = require('./collaboration.cjs');
const { NativeDirectHistory } = require('./native-direct-history.cjs');
const { SkillsStore } = require('./skills.cjs');
const { ApprovalQueue, ApprovalProcessor, settled } = require('./approval-broker.cjs');
const { runCodexReview } = require('./approval-reviewer.cjs');
const { NativeApprovals } = require('./native-approvals.cjs');
const { InformationStats } = require('./information-stats.cjs');
const { runInformationProbe } = require('./information-probe.cjs');
const { CodexMemory } = require('./codex-memory.cjs');
const { prepareModelCatalog } = require('./model-catalog.cjs');
const defaultTarget = () => ({ agent: 'codex', model: '', reasoningEffort: '' });
function install() {
  if (process.versions.electron) {
    try { process.env.CODEX_FORGE_MODEL_CATALOG = prepareModelCatalog({ root: process.env.CODEX_FORGE_HOME }).path; }
    catch (error) { delete process.env.CODEX_FORGE_MODEL_CATALOG; console.error('[Forge 500K]', error.message); }
  }
  const { app, BrowserWindow, ipcMain, Menu, MenuItem, dialog, shell } = require('electron');
  ipcMain.on('forge:startup-flags', event => {
    const frame = event.senderFrame, main = event.sender.mainFrame;
    const trusted = frame && main && frame.routingId === main.routingId && frame.processId === main.processId && event.sender.getURL().startsWith('app://-/');
    event.returnValue = { fastEnabled: !!trusted && process.env.CODEX_FORGE_FAST === '1' };
  });
  app.setName?.('Codex Forge');
  app.setAppUserModelId?.('HOMEFTW.CodexForge');
  app.on('browser-window-created',(_event,win)=>{try{win.setIcon(path.join(__dirname,'codex-forge.ico'));}catch{}});
  const store = new CanvasStore(process.env.CODEX_FAST_CANVAS_DIR), states = new Map();
  const todos = new TodoStore(store.root), contexts = new ThreadContexts(store.root);
  const skills = new SkillsStore({ root: path.join(store.root, 'skills') });
  const collaboration = new CollaborationService({ root: path.join(store.root, 'collaboration'), nodePath: path.join(process.resourcesPath || '', 'cua_node/bin/node.exe'), promptCatalog: agent => skills.promptCatalog(agent) });
  const directHistory = new NativeDirectHistory(collaboration.store), nativeRequests = new Map(), internalRequests = new Map();
  const statistics = new InformationStats({ root:path.join(store.root,'information-stats'), probeRunner:context => runInformationProbe({ executable:path.join(process.resourcesPath,'codex.exe'), ...context }) });
  const codexMemory = new CodexMemory();
  const informationContexts = new Map();
  const pages = new Set(['canvas', 'updates', 'todos', 'collaboration', 'skills', 'information-stats', 'codex-memory']);
  let forge;
  const active = id => !forge || forge.enabled(id);
  let signalNonce = ''; const contextRequests = new Map();
  const report = error => console.error('[FAST extension]', error.message || error);
  const approvalQueue = new ApprovalQueue(collaboration.store), humanApprovals = new NativeApprovals({ states }), promptAuthorizationRequests = new Map();
  function requestPromptAuthorization(state, captured) {
    const pending = captured?.authorizationPending, key = pending ? pending.eventId + ':' + captured.id : '';
    if (!pending || promptAuthorizationRequests.has(key)) return;
    const request = { kind: 'collaboration-authorization', id: 'collaboration-authorization-' + crypto.randomUUID(), threadId: captured.id, cwd: contexts.binding(captured.id).cwd, agents: pending.agents, prompt: captured.lastUserPrompt || '', reason: '用户明确请求启动协作，但本对话尚未勾选协作开关。', action: { toolName: '开启本对话智能体协作', input: { agents: pending.agents }, nativeDecision: 'ask' } };
    const promise = humanApprovals.request({ request }).then(answer => {
      const result = collaboration.approvePromptAuthorization(captured.id, pending.eventId, answer?.approved === true, { source: 'host', trusted: true });
      notify(state, { type: 'refresh' }); return result;
    }).catch(error => { report(error); }).finally(() => promptAuthorizationRequests.delete(key));
    promptAuthorizationRequests.set(key, promise);
  }
  const approvalProcessor = new ApprovalProcessor({ queue: approvalQueue,
    review: async ({ request, job, signal }) => {
      const state = [...states.values()].find(s => s.bridge && !s.win.isDestroyed());
      if (!state) throw Error('原生 Codex 连接尚未就绪');
      const { thread } = await nativeCall(state, 'thread/read', { threadId: request.threadId, includeTurns: false });
      if (!thread?.model || !thread.modelProvider) throw Error('无法确认当前对话的 Codex 模型');
      return runCodexReview({ executable: path.join(process.resourcesPath, 'codex.exe'), request, job, model: thread.model, modelProvider: thread.modelProvider, reasoningEffort: thread.reasoningEffort, signal });
    }, human: args => humanApprovals.request(args), onChange: () => { for (const state of states.values()) notify(state, { type: 'refresh' }); },
  });
  const approvalTimer = setInterval(() => {
    if (![...states.values()].some(s => s.bridge && !s.win.isDestroyed())) return;
    try { for (const request of approvalQueue.list()) if (!settled.has(request.state)) approvalProcessor.process(request.id).catch(report); } catch (error) { report(error); }
  }, 350);
  approvalTimer.unref?.();
  function nativeCall(state, method, params) {
    if (!state.bridge || state.win.isDestroyed()) return Promise.reject(Error('原生对话连接尚未就绪'));
    const id = 'fast-history-' + require('node:crypto').randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { internalRequests.delete(id); reject(Error('原生对话历史同步超时')); }, 15000);
      internalRequests.set(id, { resolve, reject, timer });
      Promise.resolve(state.bridge.handler(state.bridge.event, { type: 'mcp-request', hostId: 'local', request: { id, method, params }, priority: 'interactive', source: 'thread', timeoutMs: 15000 })).catch(error => { clearTimeout(timer); internalRequests.delete(id); reject(error); });
    });
  }
  function threadContext(event, state) {
    const route = new URL(event.sender.getURL()).pathname.match(/^\/(?:local|hotkey-window\/thread)\/([A-Za-z0-9_-]+)(?:\/|$)/);
    const threadId = state?.threadId ?? route?.[1] ?? null;
    return { threadId, cwd: contexts.binding(threadId).cwd, source: 'host', trusted: true };
  }
  function rememberInformation(thread, result = {}, selected = {}) {
    if (!thread?.id) return;
    const previous = informationContexts.get(thread.id) || {};
    const value = { ...previous, at:Date.now(),
      model:selected.model || result.model || thread.model || previous.model || '',
      provider:result.modelProvider || thread.modelProvider || previous.provider || '',
      effort:selected.effort ?? result.reasoningEffort ?? thread.reasoningEffort ?? previous.effort ?? '',
      cwd:thread.cwd || previous.cwd || contexts.binding(thread.id).cwd || '',
      sessionPath:thread.path || previous.sessionPath,
    };
    informationContexts.set(thread.id,value);
    while (informationContexts.size > 64) informationContexts.delete(informationContexts.keys().next().value);
  }
  async function informationContext(event, state) {
    const context = threadContext(event,state), cached = informationContexts.get(context.threadId);
    if (context.threadId && (!cached || Date.now()-cached.at > 30000)) {
      try { const result = await nativeCall(state,'thread/read',{threadId:context.threadId,includeTurns:false}); rememberInformation(result.thread,result); }
      catch { /* Read-only session metrics remain available before the native bridge is ready. */ }
    }
    if (threadContext(event,state).threadId !== context.threadId) throw Error('当前对话已变化，请刷新信息统计');
    const saved=informationContexts.get(context.threadId);
    return { ...context, ...saved, cwd:saved?.cwd || context.cwd };
  }
  function composerTarget(state, threadId = state.threadId) { return threadId ? state.composerTargets.get(threadId) || defaultTarget() : state.draftTarget; }
  // The app's original request handler is registered after early-bootstrap.
  // Preserve its behavior and only add per-thread MCP environment configuration.
  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => registerHandler(channel, channel !== 'codex_desktop:message-from-view' ? handler : async (event, message, ...rest) => {
    if (event.senderFrame?.routingId === event.sender.mainFrame?.routingId && event.senderFrame?.processId === event.sender.mainFrame?.processId && event.sender.getURL().startsWith('app://-/')) {
      if (humanApprovals.respond(event, message)) return;
      const localRequest = message?.type === 'mcp-request' && (!message.hostId || message.hostId === 'local');
      if (localRequest) {
        const state = host(event), method = message.request?.method, params = message.request?.params || {};
        state.bridge = { handler, event };
        if (method === 'thread/list') await directHistory.verify((name, args) => nativeCall(state, name, args));
        if (method === 'thread/items/list' && params.turnId?.startsWith('fast-') && directHistory.turns(params.threadId).some(turn => turn.id === params.turnId)) {
          const result = await directHistory.response(method, params, { data: [], nextCursor: null, backwardsCursor: null });
          event.sender.send('codex_desktop:message-for-view', { type: 'mcp-response', hostId: 'local', message: { id: message.request.id, result } }); return;
        }
        if (['thread/start', 'thread/resume', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/name/set'].includes(method)) nativeRequests.set(message.request.id, { method, args: params, state });
      }
      // The desktop uses a memory router: webContents.getURL() stays index.html.
      // Its own route notification is sent by the trusted original renderer.
      if (message?.type === 'remote-hosted-pip-active-thread-changed') {
        const state = host(event);
        const nextThreadId = /^[A-Za-z0-9_-]{1,100}$/.test(message.conversationId || '') ? message.conversationId : null;
        if (state.threadId && !nextThreadId) { state.draftTarget = defaultTarget(); for (const id of state.pendingDraftThreads) state.composerTargets.set(id, defaultTarget()); }
        state.threadId = nextThreadId;
        notify(state, { type: 'refresh' });
      }
      if (contexts.prepare(message)) contextRequests.set(message.request.id, { state: host(event), method: message.request.method });
      const submission = userSubmission(message);
      if (submission) {
        const state = host(event); contexts.bind(submission.threadId, submission.cwd);
        const target = active('forge.collaboration') ? composerTarget(state, submission.threadId) : defaultTarget();
        if (state.pendingDraftThreads.delete(submission.threadId)) { state.draftTarget = defaultTarget(); for (const id of state.pendingDraftThreads) state.composerTargets.set(id, defaultTarget()); }
        if (target.agent !== 'codex') {
          const reply = value => event.sender.send('codex_desktop:message-for-view', { type: 'mcp-response', hostId: 'local', requestMethod: message.request.method, message: { id: message.request.id, ...value } });
          try {
            if (message.request.method !== 'turn/start') throw Error('外部智能体消息请等待当前原生回合完成后发送');
            if (message.request.params.input.some(item => item.type !== 'text')) throw Error('外部智能体直发目前接受文本，请先移除附件或切换 Codex');
            const job = await collaboration.dispatch('direct', { ...target, task: submission.text, requestId: submission.eventId }, { threadId: submission.threadId, cwd: contexts.binding(submission.threadId).cwd, source: 'host', trusted: true });
            if (job.status === 'failed') throw Error(job.error || '外部智能体启动失败');
            directHistory.retain(submission.threadId);
            // This durable mirror supplies the native list/history UI; raw
            // injected reference items supply actual future Codex context.
            directHistory.sync(submission.threadId, (name, args) => nativeCall(state, name, args)).catch(report);
            // The original request was accepted by the selected external agent.
            // No Codex turn is sent; its optimistic composer turn can now finish.
            reply({ result: { turn: { id: 'fast-' + job.id, status: 'completed', items: [], error: null, startedAt: Date.now() / 1000, completedAt: Date.now() / 1000 } } });
            notify(state, { type: 'refresh' });
          } catch (error) { reply({ error: { code: -32000, message: error.message } }); }
          return;
        }
        rememberInformation({ id:submission.threadId }, {}, { model:message.request.params.model, effort:message.request.params.effort });
        if (active('forge.collaboration')) {
          const captured = await collaboration.captureUserPrompt(submission.threadId, submission.text, { ...submission, cwd: contexts.binding(submission.threadId).cwd, source: 'user', trusted: true });
          if (captured.authorizationPending) { notify(state, { type: 'refresh' }); requestPromptAuthorization(state, { ...captured, lastUserPrompt: submission.text }); }
        }
        try { await directHistory.sync(submission.threadId, (name, args) => nativeCall(state, name, args)); }
        catch (error) { event.sender.send('codex_desktop:message-for-view', { type: 'mcp-response', hostId: 'local', message: { id: message.request.id, error: { code: -32000, message: error.message } } }); return; }
      }
    }
    return handler(event, message, ...rest);
  });
  const observeContents = (_event, contents) => {
    const original = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel === 'codex_desktop:message-for-view') { try {
        const incoming = args[0], internal = incoming?.type === 'mcp-response' && incoming.hostId === 'local' ? internalRequests.get(incoming.message?.id) : null;
        if (internal) { clearTimeout(internal.timer); internalRequests.delete(incoming.message.id); incoming.message.error ? internal.reject(Error(incoming.message.error.message || '原生历史操作失败')) : internal.resolve(incoming.message.result); return; }
        if (incoming?.type === 'mcp-notification' && incoming.hostId === 'local') {
          const action = { 'thread/archived': 'thread/archive', 'thread/unarchived': 'thread/unarchive', 'thread/deleted': 'thread/delete' }[incoming.method];
          if (action) directHistory.mutation(action, incoming.params);
        }
        const response = args[0], request = response?.type === 'mcp-response' ? contextRequests.get(response.message?.id) : null;
        if (response?.type === 'mcp-response' && response.hostId === 'local' && response.message?.result?.thread) { directHistory.remember(response.message.result.thread); rememberInformation(response.message.result.thread, response.message.result); }
        const binding = contexts.response(response);
        if (request) {
          contextRequests.delete(response.message.id);
          if (binding && request.method === 'thread/start') { request.state.composerTargets.set(binding.threadId, { ...request.state.draftTarget }); request.state.pendingDraftThreads.add(binding.threadId); }
          if (binding) notify(request.state, { type: 'refresh' });
        }
        const native = response?.type === 'mcp-response' && response.hostId === 'local' ? nativeRequests.get(response.message?.id) : null;
        if (native) {
          nativeRequests.delete(response.message.id);
          if (response.message.result) {
            const call = (method, params) => nativeCall(native.state, method, params);
            directHistory.response(native.method, native.args, response.message.result, call, contents.id).then(async result => {
              if (native.method === 'thread/resume') await directHistory.sync(result.thread.id, call).catch(report);
              original(channel, { ...response, message: { ...response.message, result } }, ...args.slice(1));
            }).catch(error => { report(error); original(channel, ...args); });
            return;
          }
        }
      } catch (error) { report(error); } }
      return original(channel, ...args);
    };
  };
  app.on('web-contents-created', observeContents);
  function host(event) {
    const frame = event.senderFrame, main = event.sender.mainFrame;
    if (!frame || !main || frame.routingId !== main.routingId || frame.processId !== main.processId || !event.sender.getURL().startsWith('app://-/')) throw new Error('Untrusted host');
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows().find(value => value.webContents?.id === event.sender.id);
    if (!win) throw new Error('Host window not found');
    if (!states.has(win.id)) {
      states.set(win.id, { win, visible: false, mode: 'right', page: 'canvas', canvasId: null, composerTargets: new Map(), draftTarget: defaultTarget(), pendingDraftThreads: new Set() });
      win.once('closed', () => states.delete(win.id));
    }
    return states.get(win.id);
  }
  function notify(state, payload) { if (!state.win.isDestroyed()) state.win.webContents.send('fast-ext:changed', payload); }
  function panelState(state) { return state?.visible ? { mode: state.mode, page: state.page, canvasId: state.canvasId, threadId: threadContext({ sender: state.win.webContents }, state).threadId } : null; }
  function choose() {
    const focused = BrowserWindow.getFocusedWindow();
    return states.get(focused?.id) || [...states.values()].find(state => !state.win.isDestroyed());
  }
  function open(state, { mode = 'right', page = 'canvas', canvasId, nodeIds = [] } = {}) {
    if (!state) return;
    state.mode = mode === 'expanded' ? 'expanded' : 'right'; state.page = pages.has(page) || forge?.page(page) ? page : 'canvas';
    const owner={canvas:'forge.canvas',todos:'forge.todos',collaboration:'forge.collaboration',skills:'forge.skills','information-stats':'forge.information-stats','codex-memory':'forge.codex-memory'}[state.page];
    if(owner && !active(owner)) throw Error('此插件已停用');
    if (canvasId) state.canvasId = canvasId;
    state.visible = true; state.win.webContents.send('fast-ext:panel', panelState(state));
    notify(state, { type: 'open', ...panelState(state), nodeIds });
  }
  function addMenu(menu) {
    if (!menu || menu.getMenuItemById('forge-updates')) return;
    const index = menu.items.findIndex(item => item.role === 'help' || /help|帮助/i.test(item.label));
    const at = index < 0 ? menu.items.length : index + 1;
    menu.insert(at, new MenuItem({ id:'forge-updates', label:'升级', submenu:[{label:'检查 Codex 与 Forge 更新',click:()=>open(choose(),{page:'forge-updates'})},{label:'功能介绍',click:()=>open(choose(),{page:'forge-features'})},{label:'升级日志',click:()=>open(choose(),{page:'forge-changelog'})}] }));
    menu.insert(at+1, new MenuItem({ id:'forge-plugin-manager', label:'插件管理', submenu:[{label:'安装和管理插件',click:()=>open(choose(),{page:'forge-plugins'})}] }));
  }
  const setMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = menu => { addMenu(menu); return setMenu(menu); };
  ipcMain.handle('fast-ext:host-ready', event => panelState(host(event)));
  ipcMain.handle('fast-ext:host-open', (event, args) => { open(host(event), { mode: args?.mode, page: args?.page }); return true; });
  ipcMain.handle('fast-ext:overview', async event => {
    const state = host(event), context = threadContext(event, state);
    const data = await collaboration.dispatch('bootstrap', {}, context);
    return { forgePlugins: forge?.registry.list().plugins.map(p=>({id:p.id,enabled:p.enabled})), threadId: context.threadId, thread: data.thread, threads: data.threads, jobs: data.jobs, composerTarget: composerTarget(state, context.threadId), todo: context.threadId ? todos.read(context.threadId) : null };
  });
  ipcMain.handle('fast-ext:statistics', async (event, { method = 'snapshot', args = {}, threadId } = {}) => {
    const state = host(event);
    if (!active('forge.information-stats')) throw Error('信息统计插件已停用');
    if (!['snapshot','analyze','import','probe','cancel'].includes(method)) throw Error('不支持的统计操作');
    if (threadId !== undefined && threadId !== threadContext(event,state).threadId) throw Error('当前对话已变化，请刷新信息统计');
    const context = await informationContext(event,state);
    // Paths and model settings come only from the native bridge, never iframe arguments.
    return statistics.dispatch(method, { outputs:args.outputs, threadId:context.threadId }, context);
  });
  ipcMain.handle('fast-ext:memory', (event, { method, args = {} } = {}) => {
    const state = host(event);
    if (state.page !== 'codex-memory') throw Error('记忆管理操作仅在记忆管理页面可用');
    if (!active('forge.codex-memory')) throw Error('记忆管理插件已停用');
    return codexMemory.dispatch(method, args);
  });
  ipcMain.handle('fast-ext:collaboration-native', async (event, { method, args = {}, threadId } = {}) => {
    const state = host(event), context = threadContext(event, state);
    if (threadId !== undefined && threadId !== context.threadId) throw Error('当前对话已变化，请重新选择智能体');
    if (!active('forge.collaboration')) throw Error('智能体协作插件已停用');
    if (!['capabilities', 'set_thread', 'direct', 'composer_target'].includes(method)) throw Error('不支持的原生协作操作');
    if (method === 'composer_target') {
      if (!['codex', 'claude', 'grok', 'dsh'].includes(args.agent)) throw Error('不支持的智能体');
      for (const field of ['model', 'reasoningEffort']) if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > 200 || /[\r\n\0]/.test(args[field]))) throw Error('模型或思考强度无效');
      const target = { agent: args.agent, model: args.agent === 'codex' ? '' : args.model || '', reasoningEffort: args.agent === 'codex' ? '' : args.reasoningEffort || '' };
      if (context.threadId) state.composerTargets.set(context.threadId, target);
      else { state.draftTarget = target; for (const id of state.pendingDraftThreads) state.composerTargets.set(id, { ...target }); }
      notify(state, { type: 'refresh' }); return target;
    }
    const result = await collaboration.dispatch(method, args, context); notify(state, { type: 'refresh' }); return result;
  });
  ipcMain.handle('fast-ext:canvas', async (event, { method, args = {} } = {}) => {
    const state = host(event);
    const owner = method?.startsWith('todo_') ? 'forge.todos' : method === 'collaboration' ? 'forge.collaboration' : method?.startsWith('skills_') ? 'forge.skills' : ['list','read','create','apply','delete','restore','asset','attach','reveal'].includes(method) ? 'forge.canvas' : null;
    if(owner && !active(owner)) throw Error('插件已停用：'+owner);
    switch (method) {
      case 'forge': return forge.management(event,args.method,args.args);
      case 'bootstrap': return { canvases: store.list(), panel: panelState(state), threadId: threadContext(event, state).threadId, notes: JSON.parse(fs.readFileSync(path.join(__dirname, 'release-notes.json'), 'utf8')) };
      case 'todo_read': case 'todo_apply': {
        const context = threadContext(event, state), threadId = args.threadId === 'personal' ? 'personal' : context.threadId;
        if (!threadId || (args.threadId && args.threadId !== threadId)) throw Error('待办不属于当前对话');
        return method === 'todo_read' ? todos.read(threadId) : todos.apply(threadId, args.expectedRevision, args.operations);
      }
      case 'collaboration': {
        const context = threadContext(event, state);
        if (args.threadId && args.threadId !== context.threadId) throw Error('协作面板已切换到其他对话，请刷新');
        if (['set_thread', 'direct', 'capabilities'].includes(args.method)) throw Error('此操作需通过原生客户端协作入口执行');
        return collaboration.dispatch(args.method, args.args || {}, context);
      }
      case 'skills_list': return skills.list(args);
      case 'skills_read': return skills.read(args.id, args);
      case 'skills_files': return skills.files(args.id, args);
      case 'skills_set': return skills.setEnabled(args.id, args.enabled, args.agent || 'codex');
      case 'list': return store.list();
      case 'read': { const doc = store.read(args.canvasId); state.canvasId = doc.id; return doc; }
      case 'create': { const doc = await store.create(args.title); state.canvasId = doc.id; return doc; }
      case 'apply': return store.apply(args.canvasId, args.expectedRevision, args.operations, 'user', args.message);
      case 'delete': {
        const result = await store.delete(args.canvasId, args.expectedRevision);
        for (const value of states.values()) { if (value.canvasId === args.canvasId) value.canvasId = null; notify(value, { type: 'refresh', canvasId: value.canvasId }); }
        return result;
      }
      case 'restore': { const result = await store.restore(args.restoreToken); for (const value of states.values()) notify(value, { type: 'refresh', canvasId: value.canvasId }); return result; }
      case 'asset': return store.imageData(args.asset);
      case 'attach': {
        const image = args.kind === 'image';
        const result = await dialog.showOpenDialog(state.win, { title: image ? '添加图片' : '添加文件卡片', properties: ['openFile'], ...(image ? { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] } : {}) });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0];
        return image ? { asset: store.importImage(file), title: path.basename(file) } : { filePath: file, title: path.basename(file) };
      }
      case 'reveal': {
        const node = store.read(args.canvasId).nodes.find(item => item.id === args.nodeId && item.type === 'file');
        if (!node?.data.filePath || !fs.existsSync(node.data.filePath)) throw new Error('文件不存在或路径无效');
        shell.showItemInFolder(node.data.filePath); return true;
      }
      case 'mode': open(state, { mode: args.mode, page: state.page, canvasId: state.canvasId }); return panelState(state);
      case 'close': state.visible = false; state.win.webContents.send('fast-ext:panel', null); return true;
      case 'data-folder': shell.openPath(store.root); return true;
      default: throw new Error('Unknown canvas method');
    }
  });
  let refreshTimer;
  const watcher = fs.watch(store.root, { recursive: true }, (_event, file) => {
    if (!file || (!file.endsWith('.json') && !file.endsWith('.jsonl'))) return;
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => {
      try {
        const signalFile = path.join(store.root, '.open.json');
        try {
          if (fs.existsSync(signalFile)) {
            const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
            if (signal.nonce !== signalNonce) { signalNonce = signal.nonce; store.read(signal.id); open(choose(), { canvasId: signal.id, nodeIds: signal.nodeIds }); }
          }
        } catch (error) { report(error); }
        for (const state of states.values()) {
          notify(state, { type: 'refresh', canvasId: state.canvasId });
          if (state.bridge && state.threadId && directHistory.syncJobs(state.threadId).length) directHistory.sync(state.threadId, (method, args) => nativeCall(state, method, args)).catch(report);
        }
      } catch (error) { report(error); }
    }, 90);
  });
  app.once('will-quit', () => { clearInterval(approvalTimer); statistics.stop(); approvalProcessor.stop(); humanApprovals.stop(); watcher.close(); clearTimeout(refreshTimer); for (const value of internalRequests.values()) { clearTimeout(value.timer); value.reject(Error('客户端已关闭，历史引用会在下次打开时同步')); } internalRequests.clear(); });
  if (process.env.CODEX_FAST_EXTENSION_TEST === '1') setTimeout(() => {
    fs.writeFileSync(path.join(store.root, '.diagnostics.json'), JSON.stringify({ menu: Menu.getApplicationMenu()?.items.map(item => ({ label: item.label, id: item.id })) }, null, 2));
  }, 10000);
  forge = require('./forge-host.cjs').installForge({ipcMain,dialog,host,threadContext,nativeCall,nativeMessage:(state,message)=>{if(!state.bridge) throw Error('原生连接尚未就绪'); return state.bridge.handler(state.bridge.event,message);},open,notify,states,collaboration});
  return { forge, states, store, todos, collaboration, contexts, skills, directHistory, addMenu };
}
module.exports = { install };
