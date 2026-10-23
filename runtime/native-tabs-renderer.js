// Appended to app-initial's lexical scope. The registry hook may execute before
// this file's statements, so state is initialized lazily rather than at top level.
var fastWorkspaceNativeState;

function fastWorkspaceNativeGetState() {
  if (!fastWorkspaceNativeState) fastWorkspaceNativeState = {
    pages: { canvas: '无限画布', todos: '待办清单', collaboration: '智能体协作', skills: '技能包', updates: '版本更新', 'forge-updates':'版本更新', 'forge-plugins':'插件管理', 'forge-settings':'Codex Forge 插件设置', 'forge-features':'功能介绍', 'forge-changelog':'升级日志', 'forge-extension-info':'扩展插件介绍与日志', 'forge-output':'插件输出' },
    scopes: [], scopeIds: new WeakMap(), nextScopeId: 0, listener: null,
  };
  return fastWorkspaceNativeState;
}

function fastWorkspaceNativePage(page) {
  return typeof page === 'string' && (Object.prototype.hasOwnProperty.call(fastWorkspaceNativeGetState().pages, page) || /^forge-plugin:[a-z][a-z0-9.-]*:[a-zA-Z][\w-]{0,79}$/.test(page));
}

function fastWorkspaceNativeScopeKey(scope) {
  // E(tb) creates one facade per hook. Its .node identifies the shared native scope.
  return scope.node || scope;
}

function fastWorkspaceNativeScopeId(scope) {
  const state = fastWorkspaceNativeGetState(), key = fastWorkspaceNativeScopeKey(scope);
  let id = state.scopeIds.get(key);
  if (!id) { id = 'fast-native-scope-' + ++state.nextScopeId; state.scopeIds.set(key, id); }
  return id;
}

function fastWorkspaceRememberScope(scope) {
  if (!scope || typeof scope.get !== 'function') return;
  const state = fastWorkspaceNativeGetState(), key = fastWorkspaceNativeScopeKey(scope);
  state.scopes = [...state.scopes.filter(item => fastWorkspaceNativeScopeKey(item) !== key), scope].slice(-24);
  fastWorkspaceNativeScopeId(scope);
}

function fastWorkspaceNativeThreadMatches(scope, threadId) {
  if (threadId == null) return true;
  const value = scope.value;
  if (value.conversationId === threadId || value.clientThreadId === threadId) return true;
  if (typeof value.clientThreadId === 'string' && Ol(value.clientThreadId) === threadId) return true;
  return typeof By !== 'undefined' && scope.get(By) === threadId;
}

function fastWorkspaceNativePickScope(request) {
  const state = fastWorkspaceNativeGetState();
  if (request.threadId != null && (typeof request.threadId !== 'string' || request.threadId.length > 256)) throw Error('无效的对话标识');
  let scopes = state.scopes.filter(scope => {
    try { return !scope.get(nb) && fastWorkspaceNativeThreadMatches(scope, request.threadId); } catch { return false; }
  });
  if (request.scopeId != null) scopes = scopes.filter(scope => fastWorkspaceNativeScopeId(scope) === request.scopeId);
  const active = scopes.filter(scope => {
    const location = typeof HE === 'undefined' ? null : scope.get(HE), value = scope.value;
    return location != null && location.pathname === value.pathname &&
      (typeof location.search !== 'string' || typeof value.search !== 'string' || location.search === value.search);
  });
  const scope = active.at(-1) || scopes.at(-1);
  if (!scope) throw Error(request.threadId != null || request.scopeId != null ? '找不到对应对话的原生侧栏' : '原生侧栏尚未就绪');
  return scope;
}

function fastWorkspaceNativeTab(props) {
  const scope = E(tb), full = Z(cb);
  if (!fastWorkspaceNativePage(props.page)) return null;
  return kCi.createElement('div', {
    'data-fast-native-page': props.page,
    'data-fast-native-tab-id': props.tabId || 'fast-workspace:' + props.page,
    'data-fast-native-mode': full ? 'expanded' : 'right',
    'data-fast-native-scope': fastWorkspaceNativeScopeId(scope),
    'data-fast-native-active': String(props.isActive !== false),
    'data-fast-native-visible': String(props.isVisible !== false),
    style: { display: 'flex', flexDirection: 'column', flex: 1, width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' },
  });
}

function fastWorkspaceNativeOpen(scope, page, options) {
  if (!fastWorkspaceNativePage(page)) throw Error('无效的扩展页面');
  const id = 'fast-workspace:' + page, descriptor = fastWorkspaceRegisterTabs();
  const existing = scope.get(aR.tabById$, id);
  if (existing && existing.tabType.kind !== 'fast-workspace') throw Error('原生标签标识冲突');
  aR.openTab(scope, descriptor, {
    id, props: { page }, target: 'right', revealAndFocus: options.revealAndFocus !== false,
    insertPosition: options.insertPosition, canUndoClose: () => false, isPreview: false,
    requiresWorkspaceReady: false, allowDuringThreadCreation: true,
  });
  const tab = scope.get(aR.tabById$, id);
  if (!tab) throw Error('原生标签页暂时无法打开');
  if (options.revealAndFocus !== false) fB(scope, 'right');
  return tab;
}

function fastWorkspaceNativeApplyMode(scope, tab, mode) {
  if (mode !== 'right' && mode !== 'expanded') throw Error('无效的原生侧栏显示模式');
  if (!vY(scope, { kind: 'content', tab }, { mode: mode === 'expanded' ? 'full' : 'split', contentSide: 'right' })) throw Error('原生侧栏暂时无法切换显示模式');
}

function fastWorkspaceNativeDispatch(request) {
  if (!['open', 'close', 'mode'].includes(request.action)) throw Error('无效的原生侧栏操作');
  if (!fastWorkspaceNativePage(request.page)) throw Error('无效的扩展页面');
  if (request.mode != null && request.mode !== 'right' && request.mode !== 'expanded') throw Error('无效的原生侧栏显示模式');
  if (typeof aR === 'undefined' || !aR) throw Error('原生侧栏尚未就绪');
  const scope = fastWorkspaceNativePickScope(request), tabId = 'fast-workspace:' + request.page;
  let tab = scope.get(aR.tabById$, tabId);
  if (tab && tab.tabType.kind !== 'fast-workspace') throw Error('原生标签标识冲突');
  if (request.action === 'open') {
    tab = fastWorkspaceNativeOpen(scope, request.page, { revealAndFocus: true });
    fastWorkspaceNativeApplyMode(scope, tab, request.mode || 'right');
  } else if (request.action === 'close') {
    if (tab) aR.closeTab(scope, tabId);
  } else {
    if (!tab) throw Error('扩展标签页尚未打开');
    fastWorkspaceNativeApplyMode(scope, tab, request.mode);
  }
  return { page: request.page, mode: scope.get(cb) ? 'expanded' : 'right', tabId, scopeId: fastWorkspaceNativeScopeId(scope) };
}

function fastWorkspaceRegisterTabs() {
  const state = fastWorkspaceNativeGetState();
  if (!state.listener && typeof window !== 'undefined') {
    state.listener = event => {
      if (event.source !== window) return;
      const request = event.data && event.data.fastWorkspaceNativeRequest;
      if (!request || typeof request !== 'object' ||
        !(typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 160 || typeof request.id === 'number' && Number.isFinite(request.id))) return;
      let reply;
      try { reply = { id: request.id, result: fastWorkspaceNativeDispatch(request) }; }
      catch (error) { reply = { id: request.id, error: String(error.message || error) }; }
      window.postMessage({ fastWorkspaceNativeReply: reply }, '*');
    };
    window.addEventListener('message', state.listener);
  }
  const existing = QL.get('fast-workspace');
  if (existing && existing.Component === fastWorkspaceNativeTab) return existing;
  return ZL('fast-workspace', fastWorkspaceNativeTab, {
    dropDestinations: ['right'], allowFullWidth: true, showInNewTabLauncher: false,
    canUndoClose: () => false, retainWhileInactive: () => true,
    getId: (scope, props) => 'fast-workspace:' + props.page,
    getTitle: (scope, props) => state.pages[props.page] || 'Forge · '+props.page.split(':').slice(1).join(' / '),
    isAvailable: scope => !scope.get(nb),
    durableRoute: {
      version: 1,
      serialize: (scope, props) => fastWorkspaceNativePage(props.page) ? { kind: 'fast-workspace', payloadVersion: 1, params: { page: props.page } } : undefined,
      restore: ({ scope, descriptor, target, revealAndFocus, insertPosition, isDisconnected }) => {
        const page = descriptor.params && descriptor.params.page;
        if (descriptor.kind !== 'fast-workspace' || descriptor.payloadVersion !== 1 || !fastWorkspaceNativePage(page) ||
          descriptor.tabId !== 'fast-workspace:' + page || target != null && target !== 'right' || isDisconnected?.()) return false;
        try { fastWorkspaceNativeOpen(scope, page, { revealAndFocus: revealAndFocus === true, insertPosition }); return true; }
        catch { return false; }
      },
    },
  });
}
