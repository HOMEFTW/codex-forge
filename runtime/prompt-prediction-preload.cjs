// Isolated preload only; suggestions never enter the editable DOM until Tab.
;(() => {
  const { ipcRenderer } = require('electron');
  let current = null, generation = -1, epoch = 0, composing = false, accepting = false, blockedTicket = null;
  let hint = null, decoratedRoot = null, decoratedInput = null, layoutParent = null, observer;
  const request = args => ipcRenderer.invoke('forge:prediction', args);
  function editor() {
    const root = [...document.querySelectorAll('[data-codex-composer-root]')].find(node => node.getBoundingClientRect().height > 0);
    const input = root?.querySelector('[contenteditable="true"],textarea');
    return input ? { root, input } : null;
  }
  function readDraft(input) {
    const text = input.tagName === 'TEXTAREA' ? input.value : input.innerText;
    if (input.tagName === 'TEXTAREA') return { text, empty: text === '' };
    const copy = input.cloneNode(true);
    copy.querySelectorAll('[data-cumberbatch]').forEach(node => node.remove());
    return { text, empty: copy.textContent === '' && !copy.querySelector('img,[data-node-view-wrapper],[contenteditable="false"]') && copy.querySelectorAll('p').length <= 1 };
  }
  function eligible(value = editor()) {
    return value && !composing && !value.input.disabled && value.input.getAttribute('aria-disabled') !== 'true' &&
      !value.root.querySelector('[data-cumberbatch]') && readDraft(value.input).empty ? value : null;
  }
  function removeHint() {
    hint?.remove(); hint = null;
    decoratedRoot?.removeAttribute('data-forge-prediction-active'); decoratedRoot = null;
    decoratedInput?.removeAttribute('data-forge-prediction-editor'); decoratedInput = null;
    layoutParent?.removeAttribute('data-forge-prediction-layout'); layoutParent = null;
  }
  function dismiss() {
    const prior = current; current = null; epoch++; accepting = false; removeHint();
    if (!prior?.ticket) return;
    blockedTicket = prior.ticket;
    request({ action: 'dismiss', threadId: prior.threadId, ticket: prior.ticket, generation: prior.generation }).catch(() => {});
  }
  function position(value) {
    if (!hint || !value) return;
    const style = window.getComputedStyle(value.input);
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
      'whiteSpace', 'overflowWrap', 'wordBreak', 'textAlign', 'textIndent', 'direction', 'tabSize',
      'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) hint.style[name] = style[name];
    Object.assign(hint.style, { color: style.color, opacity: '0.5', pointerEvents: 'none', userSelect: 'none', zIndex: '1' });
  }
  function render(value) {
    if (decoratedInput !== value.input || layoutParent !== value.input.parentElement || hint?.parentElement !== layoutParent) removeHint();
    if (!hint) {
      hint = document.createElement('div'); hint.setAttribute('data-forge-prediction', ''); hint.setAttribute('aria-hidden', 'true');
      hint.textContent = current.text + '  [Tab 接受 · Esc 关闭]';
      // Share a grid cell with the empty editor, outside ProseMirror. The hint
      // contributes its wrapped height; the native parent keeps its scroll cap.
      decoratedInput = value.input; decoratedInput.setAttribute('data-forge-prediction-editor', '');
      layoutParent = value.input.parentElement; layoutParent.setAttribute('data-forge-prediction-layout', ''); layoutParent.append(hint);
      decoratedRoot = value.root; decoratedRoot.setAttribute('data-forge-prediction-active', '');
    }
    position(value);
  }
  function receive(value) {
    if (!value || value.type !== 'forge-prediction' || value.generation < generation) return;
    generation = value.generation;
    if (value.ticket && value.ticket === blockedTicket) return;
    if (current?.ticket !== value.ticket || current?.text !== value.text) { epoch++; accepting = false; removeHint(); }
    current = value; check();
  }
  function check() {
    if (!current || !['offer', 'pending', 'suggestion'].includes(current.phase)) { removeHint(); return; }
    const value = editor();
    if (!value && current.phase === 'offer') return;
    if (!eligible(value)) { dismiss(); return; }
    if (current.phase === 'suggestion') { render(value); return; }
    if (current.phase !== 'offer') return;
    const ticket = current.ticket;
    current = { ...current, phase: 'pending' };
    request({ action: 'ready', threadId: current.threadId, ticket, generation: current.generation, expectedText: readDraft(value.input).text })
      .then(receive).catch(error => { if (current?.ticket === ticket) { console.warn('[Forge prediction]', error.message); dismiss(); } });
  }
  const inComposer = event => event.target?.closest?.('[data-codex-composer-root]');
  async function keydown(event) {
    if (!inComposer(event)) return;
    if (event.isComposing || event.keyCode === 229 || composing) { dismiss(); return; }
    if (!current || current.phase !== 'suggestion') return;
    const value = eligible();
    // Native cumberbatch decorations take precedence, including immediately
    // before key dispatch (MutationObserver alone would leave a race).
    if (!value || !(event.target === value.input || value.input.contains(event.target))) { dismiss(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); return; }
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (accepting) return;
    accepting = true;
    const accepted = current, expectedText = readDraft(value.input).text, capturedEpoch = epoch;
    try {
      const result = await request({ action: 'accept', threadId: accepted.threadId, ticket: accepted.ticket, generation: accepted.generation, expectedText });
      if (capturedEpoch !== epoch || current?.ticket !== accepted.ticket || result.threadId !== accepted.threadId || result.ticket !== accepted.ticket || result.generation !== accepted.generation) return;
      const latest = eligible();
      if (!latest || latest.input !== value.input || readDraft(latest.input).text !== expectedText || composing) return;
      // Uses the existing guarded editor write, never an Enter/send action.
      globalThis.__forgeBridge.editComposer('composer.set', { text: result.text, expectedText });
    } catch (error) { console.warn('[Forge prediction]', error.message); }
    finally { if (current?.ticket === accepted.ticket) dismiss(); accepting = false; }
  }
  ipcRenderer.on('fast-ext:changed', (_event, value) => { if (value?.type === 'forge-prediction') receive(value); });
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '[data-forge-prediction-active] [data-placeholder]::before,[data-forge-prediction-active] [data-placeholder]::after{content:none!important}' +
      '[data-forge-prediction-layout]{display:grid!important}' +
      '[data-forge-prediction-layout]>[data-forge-prediction-editor],[data-forge-prediction-layout]>[data-forge-prediction]{grid-area:1/1;min-width:0}' +
      '[data-forge-prediction]{margin:0;box-sizing:border-box}';
    document.head.append(style);
    document.addEventListener('keydown', keydown, true);
    for (const name of ['beforeinput', 'input']) document.addEventListener(name, event => { if (inComposer(event)) dismiss(); }, true);
    document.addEventListener('compositionstart', event => { if (inComposer(event)) { composing = true; dismiss(); } }, true);
    document.addEventListener('compositionend', event => { if (inComposer(event)) composing = false; }, true);
    observer = new MutationObserver(check); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable', 'data-cumberbatch'] });
    window.addEventListener('resize', () => position(editor()));
    document.addEventListener('scroll', () => position(editor()), true);
    request({ action: 'status' }).then(receive).catch(() => {});
  }, { once: true });
})();
