const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const listeners = new Map(), replies = [], calls = [];
  const cb = Symbol('nativeFullWidth'), nb = Symbol('nativeRouteUnavailable'), By = Symbol('nativeThreadId'), HE = Symbol('nativeMemoryLocation'), tb = Symbol('RouteScope');
  const native = { location: { pathname: '/thread/a', search: '' }, hookScope: null };
  const window = {
    location: { pathname: '/index.html', protocol: 'app:' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(value) { replies.push(value); },
  };
  const aR = {
    tabById$: Symbol('tabById'), activeTab$: Symbol('activeTab'), tabs$: Symbol('tabs'),
    openTab(scope, tabType, options) {
      calls.push({ method: 'openTab', scope, tabType, options });
      const existing = scope.tabs.get(options.id);
      const tab = { ...existing, tabId: options.id, tabType, props: options.props };
      scope.tabs.set(options.id, tab);
      if (options.revealAndFocus) scope.activeTabId = tab.tabId;
      return tab.tabId;
    },
    closeTab(scope, id) { calls.push({ method: 'closeTab', scope, id }); scope.tabs.delete(id); },
    activateTab(scope, id) { calls.push({ method: 'activateTab', scope, id }); scope.activeTabId = id; },
  };
  const sandbox = {
    window, QL: new Map(), cb, nb, By, HE, tb, aR,
    ZL(kind, Component, options) { const descriptor = { ...options, kind, Component }; sandbox.QL.set(kind, descriptor); return descriptor; },
    fB(scope, target) { calls.push({ method: 'showPanel', scope, target }); scope.panelOpen = true; return true; },
    vY(scope, content, options) { calls.push({ method: 'layout', scope, content, options }); scope.full = options.mode === 'full'; return true; },
    Ol(id) { return id.replace(/^client:/, ''); },
    E() { return native.hookScope; },
    Z(signal) { return native.hookScope.get(signal); },
    kCi: { createElement(type, props) { return { type, props }; } },
  };
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../runtime/native-tabs-renderer.js'), 'utf8');
  // Registration can run in $L before the appended source reaches its declarations.
  vm.runInContext('fastWorkspaceRegisterTabs();\n' + source, context);
  function scope(id, pathname = '/thread/' + id, extra = {}) {
    const value = { conversationId: id, clientThreadId: 'client:' + id, routeKind: 'local-thread', pathname, search: '', ...extra };
    return {
      value, node: {}, tabs: new Map(), full: false, activeTabId: null, disconnected: false,
      get(signal, arg) {
        if (this.disconnected) throw Error('disposed scope');
        if (signal === HE) return native.location;
        if (signal === By) return this.realThreadId;
        if (signal === cb) return this.full;
        if (signal === nb) return false;
        if (signal === aR.tabById$) return this.tabs.get(arg);
        if (signal === aR.activeTab$) return this.tabs.get(this.activeTabId);
        if (signal === aR.tabs$) return [...this.tabs.values()];
      },
    };
  }
  function remember(value) { context.fastWorkspaceRememberScope(value); return value; }
  function request(body, source = window) {
    const id = body.id || 'request-' + replies.length;
    listeners.get('message')({ source, data: { fastWorkspaceNativeRequest: { id, ...body } } });
    const reply = replies.at(-1)?.fastWorkspaceNativeReply;
    return reply?.id === id ? reply : null;
  }
  return { context, sandbox, native, window, calls, replies, scope, remember, request, descriptor: sandbox.QL.get('fast-workspace') };
}

test('registers once and opens each fixed page as a native tab without replacing ordinary tabs', () => {
  const f = fixture(), scope = f.remember(f.scope('a'));
  scope.tabs.set('ordinary', { tabId: 'ordinary', tabType: { kind: 'browser' } });
  f.context.fastWorkspaceRegisterTabs();
  assert.equal(f.sandbox.QL.size, 1);
  for (const page of ['canvas', 'todos', 'collaboration', 'skills', 'updates']) {
    const reply = f.request({ action: 'open', page, mode: 'right', threadId: 'a' });
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.tabId, 'fast-workspace:' + page);
    assert.equal(reply.result.mode, 'right');
  }
  assert.equal(scope.tabs.size, 6);
  f.request({ action: 'open', page: 'canvas', mode: 'right', threadId: 'a' });
  assert.equal(scope.tabs.size, 6, 'reopening a page uses its existing stable native tab');
  const opens = f.calls.filter(item => item.method === 'openTab');
  assert(opens.every(item => item.options.replaceTabId === undefined && item.options.isPreview === false));
  assert(opens.every(item => item.options.requiresWorkspaceReady === false && item.options.allowDuringThreadCreation === true));
  assert.equal(f.descriptor.retainWhileInactive(), true);
});

test('chooses the active native memory route and real thread instead of app URL or a retained render', () => {
  const f = fixture(), current = f.remember(f.scope('a')), retained = f.remember(f.scope('b'));
  f.request({ action: 'open', page: 'canvas', mode: 'right' });
  assert(current.tabs.has('fast-workspace:canvas'));
  assert.equal(retained.tabs.size, 0);
  const draft = f.scope(null, '/new', { conversationId: null, clientThreadId: 'client:new-draft', routeKind: 'client-local-thread' });
  draft.realThreadId = 'real-created-thread'; f.remember(draft); f.native.location = { pathname: '/new', search: '' };
  const reply = f.request({ action: 'open', page: 'collaboration', mode: 'right', threadId: 'real-created-thread' });
  assert.equal(reply.error, undefined);
  assert(draft.tabs.has('fast-workspace:collaboration'));
  assert.match(f.request({ action: 'open', page: 'skills', threadId: 'missing-thread' }).error, /对话/);
});

test('mode and close target one native mount scope while preserving other tabs and scopes', () => {
  const f = fixture(), a = f.remember(f.scope('a'));
  const first = f.request({ action: 'open', page: 'canvas', mode: 'right', threadId: 'a' });
  a.tabs.set('ordinary', { tabId: 'ordinary', tabType: { kind: 'review' } });
  const b = f.remember(f.scope('b')); f.native.location = { pathname: '/thread/b', search: '' };
  f.request({ action: 'open', page: 'canvas', mode: 'right', threadId: 'b' });
  const changed = f.request({ action: 'mode', page: 'canvas', mode: 'expanded', scopeId: first.result.scopeId, threadId: 'a' });
  assert.equal(changed.result.mode, 'expanded'); assert.equal(a.full, true); assert.equal(b.full, false);
  const layout = f.calls.filter(item => item.method === 'layout').at(-1);
  assert.equal(layout.options.mode, 'full'); assert.equal(layout.content.kind, 'content');
  f.request({ action: 'close', page: 'canvas', scopeId: first.result.scopeId, threadId: 'a' });
  assert(!a.tabs.has('fast-workspace:canvas')); assert(a.tabs.has('ordinary')); assert(b.tabs.has('fast-workspace:canvas'));
  assert.match(f.request({ action: 'close', page: 'canvas', scopeId: first.result.scopeId, threadId: 'b' }).error, /对话/);
});

test('native component follows native layout mode and exposes only a page mount', () => {
  const f = fixture(), scope = f.remember(f.scope('a')); f.native.hookScope = scope;
  const result = f.descriptor.Component({ page: 'todos', tabId: 'fast-workspace:todos', isActive: true, isVisible: true });
  assert.equal(result.type, 'div'); assert.equal(result.props['data-fast-native-page'], 'todos');
  assert.equal(result.props['data-fast-native-mode'], 'right');
  assert.equal(result.props.style.minHeight, 0); assert.equal(result.props.style.height, '100%');
  assert.equal(result.props.children, undefined, 'preload owns each sandbox iframe');
  scope.full = true;
  assert.equal(f.descriptor.Component({ page: 'todos' }).props['data-fast-native-mode'], 'expanded');
});

test('per-hook facades of one native scope route mount actions to the owning layout facade', () => {
  const f = fixture(), owner = f.remember(f.scope('a'));
  const opened = f.request({ action: 'open', page: 'canvas', mode: 'right', threadId: 'a' });
  // E(tb) returns a separate hook-local facade whose .node is the shared native scope.
  const renderingFacade = { node: owner.node, value: owner.value, get: owner.get.bind(owner) };
  f.native.hookScope = renderingFacade;
  const mount = f.descriptor.Component({ page: 'canvas', tabId: 'fast-workspace:canvas' });
  const scopeId = mount.props['data-fast-native-scope'];
  assert.equal(scopeId, opened.result.scopeId);
  const changed = f.request({ action: 'mode', page: 'canvas', mode: 'expanded', scopeId });
  assert.equal(changed.error, undefined); assert.equal(changed.result.mode, 'expanded');
  assert.equal(f.calls.filter(item => item.method === 'layout').at(-1).scope, owner);
  assert.equal(owner.full, true); assert.equal(renderingFacade.full, undefined);
  assert.equal(f.descriptor.Component({ page: 'canvas' }).props['data-fast-native-mode'], 'expanded');
  f.request({ action: 'close', page: 'canvas', scopeId });
  assert.equal(f.calls.filter(item => item.method === 'closeTab').at(-1).scope, owner);
  assert.equal(owner.tabs.size, 0);
});

test('durable routes restore only fixed page IDs and leave native topology and ordinary tabs intact', () => {
  const f = fixture(), scope = f.remember(f.scope('a')), durable = f.descriptor.durableRoute;
  const saved = durable.serialize(scope, { page: 'skills' });
  assert.equal(saved.kind, 'fast-workspace'); assert.equal(saved.payloadVersion, 1); assert.equal(saved.params.page, 'skills');
  const descriptor = { ...saved, tabId: 'fast-workspace:skills' };
  assert.equal(durable.restore({ scope, descriptor, target: 'right', revealAndFocus: false, insertPosition: { type: 'start' }, isDisconnected: () => false }), true);
  assert(scope.tabs.has('fast-workspace:skills')); assert.equal(f.calls.filter(item => item.method === 'layout').length, 0);
  assert.equal(durable.restore({ scope, descriptor: { ...descriptor, tabId: 'ordinary' }, target: 'right' }), false);
  assert.equal(durable.restore({ scope, descriptor: { ...descriptor, payloadVersion: 2 }, target: 'right' }), false);
  assert.equal(durable.restore({ scope, descriptor: { ...descriptor, params: { page: '../../file' } }, target: 'right' }), false);
  assert.equal(durable.restore({ scope, descriptor, target: 'bottom' }), false);
  assert.equal(durable.restore({ scope, descriptor, target: 'right', isDisconnected: () => true }), false);
});

test('rejects foreign windows, arbitrary pages and actions, invalid modes and native ID collisions', () => {
  const f = fixture(), scope = f.remember(f.scope('a'));
  assert.equal(f.request({ action: 'open', page: 'canvas' }, {}), null);
  assert.equal(f.replies.length, 0);
  for (const request of [
    { action: 'open', page: '__proto__' }, { action: 'open', page: '../../path' },
    { action: 'evaluate', page: 'canvas' }, { action: 'mode', page: 'canvas', mode: 'floating' },
  ]) assert.equal(typeof f.request(request).error, 'string');
  assert.equal(scope.tabs.size, 0);
  scope.tabs.set('fast-workspace:canvas', { tabId: 'fast-workspace:canvas', tabType: { kind: 'browser' } });
  assert.equal(typeof f.request({ action: 'open', page: 'canvas', mode: 'right' }).error, 'string');
  assert.equal(scope.tabs.get('fast-workspace:canvas').tabType.kind, 'browser');
});
