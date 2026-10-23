// Runs in the original sandboxed preload. All untrusted output uses textContent.
;(() => {
  const { ipcRenderer } = require('electron');
  const collabIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m7.5 7.5 4.5-3 4.5 3M6 10v6l6 4 6-4v-6M8.5 8.8l3.5 2.7 3.5-2.7M12 12v5"/><circle cx="6" cy="8" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="20" r="2.2"/></svg>';
  const skillsIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></svg>';
  const todoIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 6 2 2 4-4M12 6h9M12 12h9M12 18h9"/><rect x="3" y="11" width="5" height="5" rx="1"/></svg>';
  const names = { claude: 'Claude Code', grok: 'Grok Build', dsh: 'DSH' };
  const statuses = { queued: '排队中', running: '运行中', awaiting_approval: '等待审批', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
  let overview = { threads: [], jobs: [] }, fetching = false, queued = false, lastThread, transcript, contentKey = '', refreshTimer;
  const outputCache = new Map();
  const sidebarAliases = new Map();
  const effortNames = { off: '关闭', none: '无', minimal: '极低', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra' };
  let composerPopup, composerAnchor, composerCapabilities = {}, composerSaving = false, composerError = '', composerCapabilityError = '', composerLoading = false, popupKey = '', capabilityPromise, composerEpoch = 0;
  let composerTarget = { agent: 'codex', model: '', reasoningEffort: '' };
  const open = page => ipcRenderer.invoke('fast-ext:host-open', { page, mode: 'right' }).catch(() => {});
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function positionComposerPopup() {
    if (!composerPopup?.matches(':popover-open') || !composerAnchor?.isConnected) return;
    const rect = composerAnchor.getBoundingClientRect(), zoom = rect.width / composerAnchor.offsetWidth || 1;
    composerPopup.style.zoom = String(zoom);
    composerPopup.style.maxWidth = `${Math.max(160, innerWidth / zoom - 16)}px`;
    composerPopup.style.maxHeight = `${Math.max(120, innerHeight / zoom - 16)}px`;
    composerPopup.style.left = `${Math.max(8, Math.min(rect.left / zoom, innerWidth / zoom - composerPopup.offsetWidth - 8))}px`;
    composerPopup.style.top = `${Math.max(8, rect.top / zoom - composerPopup.offsetHeight - 8)}px`;
  }
  async function changeComposerTarget(next) {
    const threadId = overview.threadId ?? null, epoch = ++composerEpoch;
    composerSaving = true; composerError = ''; popupKey = ''; paintComposerPopup();
    try {
      const target = await ipcRenderer.invoke('fast-ext:collaboration-native', { method: 'composer_target', args: next, threadId });
      if (epoch !== composerEpoch || (overview.threadId ?? null) !== threadId) return;
      composerTarget = target; overview.composerTarget = target;
    } catch (error) { if (epoch === composerEpoch) composerError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
    finally { if (epoch === composerEpoch) { composerSaving = false; popupKey = ''; render(); } }
  }
  function paintComposerPopup() {
    if (!composerPopup) return;
    const key = JSON.stringify([overview.threadId, composerTarget, composerCapabilities, composerSaving, composerLoading, composerError, composerCapabilityError]);
    if (popupKey === key) return; popupKey = key;
    const target = composerTarget, capability = composerCapabilities[target.agent] || {}, external = target.agent !== 'codex';
    const agent = composerPopup.querySelector('[data-fast-agent]'); agent.value = target.agent; agent.disabled = composerSaving;
    const model = composerPopup.querySelector('[data-fast-model]'); model.replaceChildren(new Option('默认（沿用协作配置）', ''));
    for (const option of capability.models || []) model.add(new Option(option.label || option.id, option.id));
    if (target.model && !(capability.models || []).some(option => option.id === target.model)) model.add(new Option(target.model, target.model));
    model.value = target.model || ''; model.disabled = composerSaving || composerLoading;
    const effort = composerPopup.querySelector('[data-fast-effort]'); effort.replaceChildren(new Option('默认（沿用协作配置）', ''));
    const allowed = capability.models?.find(option => option.id === (target.model || capability.defaultModel))?.reasoningEfforts || capability.reasoningEfforts || [];
    for (const value of allowed) effort.add(new Option(effortNames[value] || value, value));
    effort.value = target.reasoningEffort || ''; effort.disabled = composerSaving || composerLoading || !allowed.length;
    for (const label of composerPopup.querySelectorAll('[data-fast-external]')) label.hidden = !external;
    const codex = composerPopup.querySelector('[data-fast-codex-model]'); codex.hidden = external;
    const nativePicker = composerAnchor?.closest('[data-codex-composer-root]')?.querySelector('[data-codex-intelligence-trigger]');
    const codexModel = nativePicker?.querySelector('[class*="ModelPickerTriggerModelText"]')?.textContent || '当前模型';
    const codexEffort = nativePicker?.getAttribute('data-selected-reasoning-effort');
    text(codex, nativePicker ? `Codex：${codexModel}${codexEffort ? ' · ' + (effortNames[codexEffort] || codexEffort) : ''}` : '选择 Codex 模型与思考强度');
    text(composerPopup.querySelector('[data-fast-hint]'), external ? `发送后直接交给 ${names[target.agent]}，沿用其本地权限设置。` : '消息由 Codex 处理。');
    const error = composerPopup.querySelector('[role="alert"]'); text(error, composerError || composerCapabilityError); error.hidden = !error.textContent;
    const loading = composerPopup.querySelector('[data-fast-loading]'); loading.hidden = !composerLoading;
    positionComposerPopup();
  }
  function ensureComposerPopup() {
    if (composerPopup) return;
    composerPopup = document.createElement('div'); composerPopup.id = 'fast-composer-options'; composerPopup.setAttribute('popover', 'auto'); composerPopup.role = 'dialog'; composerPopup.setAttribute('aria-label', '选择智能体与模型');
    composerPopup.innerHTML = '<header><strong>发送给</strong><button type="button" data-fast-dismiss aria-label="关闭智能体选择">×</button></header><label>智能体<select aria-label="消息目标智能体" data-fast-agent><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="grok">Grok Build</option><option value="dsh">DSH</option></select></label><label data-fast-external>模型<select aria-label="消息目标模型" data-fast-model></select></label><label data-fast-external>思考强度<select aria-label="消息思考强度" data-fast-effort></select></label><button type="button" data-fast-codex-model></button><p data-fast-loading>正在读取可用模型…</p><p data-fast-hint></p><p role="alert" hidden></p><button type="button" data-fast-settings>协作与连接配置</button>';
    document.body.appendChild(composerPopup);
    composerPopup.querySelector('[data-fast-dismiss]').addEventListener('click', () => composerPopup.hidePopover());
    composerPopup.querySelector('[data-fast-agent]').addEventListener('change', event => changeComposerTarget({ agent: event.target.value, model: '', reasoningEffort: '' }));
    composerPopup.querySelector('[data-fast-model]').addEventListener('change', event => changeComposerTarget({ ...composerTarget, model: event.target.value, reasoningEffort: '' }));
    composerPopup.querySelector('[data-fast-effort]').addEventListener('change', event => changeComposerTarget({ ...composerTarget, reasoningEffort: event.target.value }));
    composerPopup.querySelector('[data-fast-settings]').addEventListener('click', () => { composerPopup.hidePopover(); open('collaboration'); });
    composerPopup.querySelector('[data-fast-codex-model]').addEventListener('click', () => { composerPopup.hidePopover(); composerAnchor?.closest('[data-codex-composer-root]')?.querySelector('[data-codex-intelligence-trigger]')?.click(); });
    composerPopup.addEventListener('toggle', event => { composerAnchor?.setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState === 'closed') composerAnchor?.focus({ preventScroll: true }); });
  }
  function composerControls() {
    if(overview.forgePlugins?.some(p=>p.id==='forge.collaboration'&&!p.enabled)){ document.querySelectorAll('[data-fast-composer-target]').forEach(e=>e.remove());document.querySelectorAll('[data-fast-target]').forEach(e=>delete e.dataset.fastTarget);return;}
    if (!composerSaving) composerTarget = overview.composerTarget || { agent: 'codex', model: '', reasoningEffort: '' };
    for (const root of document.querySelectorAll('[data-codex-composer-root]')) {
      const permissions = root.querySelector('[data-composer-navigation-target="permissions"]');
      if (!permissions) continue;
      let button = root.querySelector('[data-fast-composer-target]');
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.setAttribute('data-fast-composer-target', ''); button.setAttribute('aria-label', '选择发送智能体与思考强度'); button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', async () => {
          composerAnchor = button; ensureComposerPopup(); popupKey = ''; paintComposerPopup(); composerPopup.showPopover(); positionComposerPopup();
          if (!capabilityPromise) {
            composerLoading = true; composerCapabilityError = ''; paintComposerPopup();
            capabilityPromise = ipcRenderer.invoke('fast-ext:collaboration-native', { method: 'capabilities', args: {} }).then(value => { composerCapabilities = value.agents || {}; }).catch(error => { composerCapabilityError = String(error.message || error); }).finally(() => { composerLoading = false; capabilityPromise = null; popupKey = ''; paintComposerPopup(); });
          }
        });
      }
      button.className = permissions.className + ' fast-composer-target';
      text(button, `${composerTarget.agent === 'codex' ? 'Codex' : names[composerTarget.agent] || composerTarget.agent}${composerTarget.reasoningEffort ? ' · ' + (effortNames[composerTarget.reasoningEffort] || composerTarget.reasoningEffort) : ''} ⌄`);
      button.title = composerTarget.agent === 'codex' ? '发送给 Codex' : `直接发送给 ${names[composerTarget.agent]} · ${composerTarget.model || '默认模型'}`;
      button.setAttribute('aria-busy', String(composerSaving));
      if (permissions.nextElementSibling !== button) permissions.after(button);
      const state = composerTarget.agent === 'codex' ? 'codex' : 'external'; if (root.dataset.fastTarget !== state) root.dataset.fastTarget = state;
    }
    paintComposerPopup();
  }
  function controls() {
    let previous = document.getElementById('fast-canvas-entry'); if (!previous?.parentElement) return;
    const compact = previous.querySelector('span')?.style.display === 'none';
    for (const [page, label, icon] of [['collaboration', '智能体协作', collabIcon], ['skills', '技能包', skillsIcon], ['todos', '待办清单', todoIcon]]) {
      let button = document.getElementById(`fast-${page}-entry`);
      if(overview.forgePlugins?.some(p=>p.id==='forge.'+page&&!p.enabled)){button?.remove();continue;}
      if (!button) {
        button = document.createElement('button'); button.id = `fast-${page}-entry`; button.type = 'button'; button.setAttribute('data-sidebar-cycle-item', 'true');
        button.setAttribute('aria-label', label); button.title = label; button.innerHTML = icon + `<span>${label}</span>`; button.addEventListener('click', () => open(page));
      }
      button.className = previous.className + ' fast-workspace-entry'; button.style.cssText = previous.style.cssText;
      if (button.style.position === 'fixed') button.style.top = `${54 + 43 * (page === 'collaboration' ? 1 : page === 'skills' ? 2 : 3)}px`;
      button.querySelector('span').style.display = compact ? 'none' : '';
      if (previous.nextElementSibling !== button) previous.after(button);
      previous = button;
    }
  }
  function badges() {
    const active = new Set(overview.threads.filter(item => item.enabled).map(item => item.id));
    for (const row of document.querySelectorAll('[data-app-action-sidebar-thread-id]')) {
      const key = row.getAttribute('data-app-action-sidebar-thread-id');
      if (key?.startsWith('local:client-new-thread:') && row.getAttribute('data-app-action-sidebar-thread-active') === 'true' && overview.threadId) sidebarAliases.set(key, overview.threadId);
      const id = sidebarAliases.get(key) || key?.replace(/^local:/, '');
      const existing = row.querySelector('.fast-collaboration-badge');
      if (!active.has(id)) { existing?.remove(); continue; }
      if (existing) continue;
      const badge = document.createElement('span'); badge.className = 'fast-collaboration-badge'; badge.title = '已启用智能体协作'; badge.setAttribute('aria-label', '已启用智能体协作'); badge.innerHTML = collabIcon;
      const title = row.querySelector('[data-thread-title]'); if (title?.parentElement) title.before(badge); else row.firstElementChild?.prepend(badge);
    }
  }
  function summaries() {
    for (const panel of document.querySelectorAll('[data-summary-panel-variant]')) {
      let section = panel.querySelector('.fast-agent-summary');
      if (!overview.threadId || (!overview.thread?.enabled && !overview.jobs.length)) { section?.remove(); continue; }
      if (!section) { section = document.createElement('section'); section.className = 'fast-agent-summary'; section.innerHTML = '<h3>协作智能体</h3><div class="fast-agent-list"></div>'; panel.appendChild(section); }
      const agents = [...new Set([...(overview.thread?.agents || []), ...overview.jobs.map(job => job.agent)])];
      const key = JSON.stringify([overview.threadId, overview.thread?.enabled, agents.map(agent => { const jobs = overview.jobs.filter(job => job.agent === agent); return [agent, jobs[0]?.status, jobs.length]; })]);
      if (section.dataset.key === key) continue; section.dataset.key = key;
      const list = section.querySelector('.fast-agent-list'); list.replaceChildren();
      for (const agent of agents) { const job = overview.jobs.find(job => job.agent === agent), button = document.createElement('button'); button.type = 'button'; button.innerHTML = collabIcon; const label = document.createElement('span'); label.textContent = `${names[agent] || agent} · ${job ? statuses[job.status] || job.status : '尚未派发'}`; button.append(label); button.addEventListener('click', () => open('collaboration')); list.append(button); }
    }
  }
  function transcriptView() {
    const timeline = document.querySelector('[data-app-action-timeline-scroll]');
    if (!timeline || !overview.threadId || !overview.jobs.length) { transcript?.remove(); transcript = null; contentKey = ''; return; }
    if (!transcript) { transcript = document.createElement('section'); transcript.id = 'fast-collaboration-transcript'; transcript.className = 'fast-collaboration-transcript'; transcript.setAttribute('aria-label', '当前对话的智能体协作输出'); const title = document.createElement('h3'); title.textContent = '智能体协作'; transcript.appendChild(title); }
    const content = timeline.querySelector('[data-thread-user-message-navigation-content]') || timeline;
    transcript.style.order = '999';
    if (transcript.parentElement !== content || content.lastElementChild !== transcript) content.appendChild(transcript);
    if (transcript.dataset.thread !== overview.threadId) { for (const item of transcript.querySelectorAll('details')) item.remove(); transcript.dataset.thread = overview.threadId; contentKey = ''; }
    const jobs = [...overview.jobs].reverse();
    for (const job of jobs) {
      let card = [...transcript.querySelectorAll('details')].find(item => item.dataset.job === job.id);
      if (!card) {
        card = document.createElement('details'); card.dataset.job = job.id;
        card.innerHTML = '<summary><span class="fast-job-title"></span><span class="fast-job-status"></span></summary><div class="fast-job-body"><p class="fast-job-task"></p><p class="fast-job-approval"></p><pre class="fast-job-output"></pre><button type="button">查看任务与配置</button></div>';
        card.querySelector('button').addEventListener('click', () => open('collaboration')); transcript.appendChild(card);
      }
      text(card.querySelector('.fast-job-title'), job.name || names[job.agent] || job.agent);
      text(card.querySelector('.fast-job-status'), statuses[job.status] || job.status);
      text(card.querySelector('.fast-job-approval'), job.approval ? `${job.approval.toolName} · ${job.approval.reason}` : '');
      text(card.querySelector('.fast-job-task'), job.task);
      const cached = outputCache.get(job.id);
      text(card.querySelector('.fast-job-output'), (cached?.truncated || job.truncated ? '（此处显示最近的输出；完整保留范围可在协作任务中查看。）\n' : '') + (cached?.text || job.finalText || job.error || '等待智能体输出…'));
    }
    const ids = new Set(jobs.map(job => job.id)); for (const card of transcript.querySelectorAll('details')) if (!ids.has(card.dataset.job)) card.remove();
  }
  async function outputs() {
    const threadId = overview.threadId;
    for (const job of overview.jobs) {
      let cache = outputCache.get(job.id);
      if (cache?.sequence === job.sequence && cache.status === job.status) continue;
      cache ||= { text: '', nextSeq: 0, sequence: -1 };
      try {
        for (let page = 0; page < 5; page++) {
          const value = await ipcRenderer.invoke('fast-ext:canvas', { method: 'collaboration', args: { method: 'read', threadId, args: { jobId: job.id, afterSeq: cache.nextSeq } } });
          if (overview.threadId !== threadId) return;
          for (const event of value.events || []) { if (event.type !== 'text' && event.type !== 'error') continue; const chunk = event.text ?? event.message; if (typeof chunk === 'string') cache.text += chunk; }
          if (value.error && !cache.text.includes(value.error)) cache.text += '\n' + value.error;
          cache.truncated ||= cache.text.length > 200000; cache.text = cache.text.slice(-200000); cache.nextSeq = value.nextSeq; cache.sequence = value.hasMore ? -1 : value.sequence; cache.status = value.status;
          if (!value.hasMore) break;
        }
        outputCache.set(job.id, cache);
      } catch { /* A navigation invalidates the old conversation request. */ }
    }
    transcriptView();
  }
  const approvalMessages = new Map();
  ipcRenderer.on('codex_desktop:message-for-view', (_event, message) => {
    const request = message?.request;
    if (message?.type === 'mcp-request' && typeof request?.id === 'string' && request.id.startsWith('fast-approval-') && request.method === 'mcpServer/elicitation/request') approvalMessages.set(request.id, request.params.message);
    if (message?.type === 'mcp-notification' && message.method === 'serverRequest/resolved') approvalMessages.delete(message.params.requestId);
    queue();
  });
  function approvalLayout() {
    for (const element of document.querySelectorAll('span.whitespace-pre-wrap')) {
      if (![...approvalMessages.values()].includes(element.textContent) || element.classList.contains('fast-native-approval-text')) continue;
      element.classList.add('fast-native-approval-text'); element.tabIndex = 0; element.setAttribute('aria-label', '完整审批动作，可滚动查看');
      element.style.maxHeight = 'min(28vh, 220px)'; element.style.overflow = 'auto'; element.style.fontSize = '12px'; element.style.display = 'block';
    }
  }
  function render() { controls(); badges(); summaries(); transcriptView(); composerControls(); approvalLayout(); }
  function queue() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; render(); }); }
  async function refresh() {
    if (fetching) return; fetching = true;
    try {
      overview = await ipcRenderer.invoke('fast-ext:overview');
      if (lastThread !== overview.threadId) { lastThread = overview.threadId; composerEpoch++; composerSaving = false; composerError = ''; if (composerPopup?.matches(':popover-open')) composerPopup.hidePopover(); for (const frame of document.querySelectorAll('.fast-workspace-frame')) frame.contentWindow?.postMessage({ fastCanvasEvent: { type: 'context', threadId: lastThread } }, '*'); }
      render(); await outputs();
    } catch { /* A destroyed window or navigation is retried on the next refresh. */ }
    finally { fetching = false; }
  }
  ipcRenderer.on('fast-ext:changed', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 140); });
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style'); style.id = 'fast-workspace-style';
    style.textContent = '.fast-workspace-entry:hover{background:rgba(127,127,127,.15)!important}.fast-collaboration-badge{display:inline-flex;align-items:center;flex:none;margin-right:5px;color:#65a88c}.fast-collaboration-badge svg{width:15px;height:15px}.fast-agent-summary{padding:12px 16px;border-top:1px solid #8883;font:12px/1.5 system-ui;color:inherit}.fast-agent-summary h3{font-weight:600;margin:0 0 8px}.fast-agent-list button{display:flex;align-items:center;gap:7px;background:transparent;color:inherit;border:0;width:100%;text-align:left;padding:5px 0;cursor:pointer}.fast-collaboration-transcript{box-sizing:border-box;width:min(100% - 32px,760px);margin:24px auto;padding:16px;border:1px solid #8884;border-radius:14px;color:inherit;font:13px/1.5 system-ui;flex-shrink:0}.fast-collaboration-transcript>h3{font-weight:600;margin:0 0 12px}.fast-collaboration-transcript details{border-top:1px solid #8883;padding:9px 0}.fast-collaboration-transcript summary{cursor:pointer;display:flex;align-items:center;gap:10px}.fast-collaboration-transcript summary:before{content:"▸";font-size:12px;opacity:.6}.fast-collaboration-transcript details[open]>summary:before{content:"▾"}.fast-job-title{flex:1}.fast-job-status{font-size:11px;opacity:.7}.fast-job-task{opacity:.65;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.fast-job-output{font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;background:#8881;border-radius:6px;padding:12px}.fast-job-body>button{font:12px system-ui;color:inherit;border:1px solid #8884;background:transparent;padding:5px 9px;border-radius:6px;cursor:pointer}';
    document.head.appendChild(style);
    const composerStyle = document.createElement('style'); composerStyle.id = 'fast-composer-style';
    composerStyle.textContent = '.fast-composer-target{max-width:180px!important;overflow:hidden;text-overflow:ellipsis;flex-shrink:1!important;padding-inline:7px!important;min-width:56px!important}[data-fast-target=external] [data-codex-intelligence-trigger]{display:none!important}#fast-composer-options{position:fixed;inset:auto;margin:0;width:min(302px,calc(100vw - 16px));box-sizing:border-box;border:1px solid var(--color-border,#666);border-radius:14px;padding:16px;background:var(--color-surface,#242428);color:var(--color-text-primary,#e8e8ed);box-shadow:0 12px 40px #0006;font:13px/1.5 system-ui;max-height:calc(100vh - 20px);overflow:auto;-webkit-app-region:no-drag}#fast-composer-options[hidden]{display:none}#fast-composer-options header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}#fast-composer-options label{display:flex;flex-direction:column;gap:5px;margin:10px 0}#fast-composer-options [hidden]{display:none!important}#fast-composer-options select{width:100%;min-width:0;border:1px solid #8885;border-radius:7px;padding:7px;background:var(--color-surface,#242428);color:inherit;font:inherit}#fast-composer-options button{font:inherit;color:inherit;background:transparent;border:1px solid #8884;border-radius:7px;padding:5px 8px;cursor:pointer}#fast-composer-options p{font-size:12px;opacity:.75;margin:12px 0}#fast-composer-options [role=alert]{color:#ff9999;opacity:1}#fast-composer-options button:hover{background:#8882}#fast-composer-options :focus-visible{outline:2px solid #a5a3ff;outline-offset:2px}#fast-composer-options::backdrop{background:transparent}';
    document.head.appendChild(composerStyle);
    new MutationObserver(records => { if (records.some(record => record.type === 'childList' && !record.target.closest?.('#fast-collaboration-transcript,.fast-agent-summary'))) queue(); }).observe(document.body, { childList: true, subtree: true });
    setInterval(refresh, 1800); refresh();
  }, { once: true });
  window.addEventListener('resize', positionComposerPopup);
  // Do not let an Enter/click outrun the acknowledged target selection.
  const guardPendingTarget = event => {
    if (!composerSaving || !event.target.closest?.('[data-codex-composer-root]')) return;
    if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey || event.isComposing)) return;
    if (event.type === 'click' && !/^(发送|Send|Send message)$/i.test(event.target.closest('button')?.getAttribute('aria-label') || '')) return;
    event.preventDefault(); event.stopImmediatePropagation(); composerError = '正在切换智能体，请稍候再发送。'; popupKey = ''; paintComposerPopup();
  };
  window.addEventListener('keydown', guardPendingTarget, true);
  window.addEventListener('click', guardPendingTarget, true);
})();
