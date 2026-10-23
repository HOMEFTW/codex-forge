let next = 0;
const waiting = new Map(), listeners = new Set();
window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (data?.fastCanvasReply) {
    const pending = waiting.get(data.fastCanvasReply); if (!pending) return;
    waiting.delete(data.fastCanvasReply); clearTimeout(pending.timer);
    if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result);
  }
  if (data?.fastCanvasEvent) for (const listener of listeners) listener(data.fastCanvasEvent);
});
window.fastCanvas = {
  request(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { waiting.delete(id); reject(new Error('客户端未响应，请重试')); }, 120000);
      waiting.set(id, { resolve, reject, timer }); window.parent.postMessage({ fastCanvasRequest: { id, method, args } }, '*');
    });
  },
  subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
};
