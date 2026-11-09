// Adapts the official Windows computer surface to the unified app API.
// It does not create a second automation backend or alter operation permissions.
export function installWindowsApps(cua, output = globalThis.nodeRepl) {
  const computer = cua?.computer;
  if (computer?.target !== 'windows') return cua;
  const emit = async (value, options) => { if (options?.emit !== false) await output?.write?.(value); return value; };
  cua.listApps = async options => emit(await computer.list_apps(), options);
  cua.getApp = async target => {
    if (typeof target !== 'string' || !target.trim()) throw Error('请提供应用名称或 ID');
    const query = target.trim().toLowerCase();
    const apps = await computer.list_apps();
    const matches = apps.filter(app => [app.id, app.displayName].some(name => String(name).toLowerCase() === query));
    if (matches.length !== 1 || matches[0].windows?.length !== 1) throw Error('应用或窗口不唯一，请先用 cua.listApps() 查看窗口并关闭多余窗口');
    let window = matches[0].windows[0];
    await computer.activate_window({ window });
    async function observe(text, screenshot, options) {
      const state = await computer.get_window_state({ window, include_text: text, include_screenshot: screenshot });
      window = state.window;
      const result = { state: state.accessibility?.tree || state.accessibility?.document_text || '' };
      if (text) await emit(result.state, options);
      if (screenshot) {
        const url = state.screenshots?.[0]?.url;
        const format = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(url || '');
        if (!format) throw Error('没有可用的图像截图');
        result.mimeType = format[1];
        result.screenshot = Uint8Array.from(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        if (options?.emit !== false) await output?.emitImage?.({ bytes: result.screenshot, mimeType: result.mimeType });
      }
      return result;
    }
    const point = target => {
      if (!Array.isArray(target) || target.length !== 2 || !target.every(Number.isFinite)) throw Error('需要 [x, y] 窗口坐标');
      return { x: target[0], y: target[1] };
    };
    const app = {
      getAXState: async options => (await observe(true, false, options)).state,
      getScreenshot: async options => (await observe(false, true, options)).screenshot,
      getAXStateAndScreenshot: options => observe(true, true, options),
      click: (target, options = {}) => computer.click({ window, ...(Array.isArray(target) ? point(target) : { element_index: target }), ...(options.mouseButton ? { mouse_button: options.mouseButton } : {}), ...(options.clickCount ? { click_count: options.clickCount } : {}) }),
      drag: (from, to) => { const a = point(from), b = point(to); return computer.drag({ window, from_x: a.x, from_y: a.y, to_x: b.x, to_y: b.y }); },
      pressKey: key => computer.press_key({ window, key }),
      paste: text => computer.type_text({ window, text }),
      typeText: text => computer.type_text({ window, text }),
      setValue: (element_index, value) => computer.set_value({ window, element_index, value }),
      performSecondaryAction: (element_index, action) => computer.perform_secondary_action({ window, element_index, action }),
      scroll: (target, direction, pages = 1) => {
        const delta = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[direction];
        if (!delta || !Number.isFinite(pages) || pages <= 0) throw Error('滚动方向或距离无效');
        return computer.scroll({ window, ...point(target), scrollX:delta[0]*600*pages, scrollY:delta[1]*600*pages });
      },
    };
    await emit('Windows 应用：'+matches[0].displayName+'。可用方法：getAXState、getScreenshot、getAXStateAndScreenshot、click、drag、pressKey、paste、typeText、setValue、scroll。坐标相对于窗口。');
    await app.getAXStateAndScreenshot();
    return app;
  };
  return cua;
}
