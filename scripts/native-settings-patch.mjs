import assert from 'node:assert/strict';

function replace(source, from, to, label = from) {
  assert.equal(source.split(from).length, 2, 'Native settings anchor changed: ' + label);
  return source.replace(from, to);
}

export function patchSettingsVisibility(source, { version = 'legacy' } = {}) {
  if (version === 'current') {
    source = replace(source,
      'case`plugins-settings`:return{visible:h,pending:!1};',
      'case`plugins-settings`:return{visible:h,pending:!1};case`codex-forge`:return{visible:!0,pending:!1};');
    source = replace(source,
      'co=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`',
      'co=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`codex-forge`,`file-type-handlers`');
    source = replace(source,
      '"plugins-settings":`codexOrWorkLocal`,"file-type-handlers"',
      '"plugins-settings":`codexOrWorkLocal`,"codex-forge":`codexOrWorkLocal`,"file-type-handlers"');
    // co 只是白名单，导航实际由 Xr.map(...) 生成的 Dt 遍历而来；codex-forge 不是原生
    // section，必须直接进 J（visibleSettingsSections）。注意不要把 codex-forge 写成
    // 新的 let 声明符，否则会变成 "Identifier 'Dt' has already been declared" 并让设置页崩溃。
    source = replace(source,
      '}),J=Dt.flatMap(ao),',
      '}),J=[...Dt.flatMap(ao),{slug:`codex-forge`}],');
    // activeSettingsSection 通过 Dt.find 计算；codex-forge 不在 Dt 里，补一个占位条目，
    // 否则 URL 指向 codex-forge 时会被重定向回默认 section。
    source = replace(source,
      'let X=Dt.find(kt),',
      'let X=Dt.find(kt)||(i===`codex-forge`?{section:{slug:`codex-forge`},visible:!0,pending:!1,error:!1}:void 0),');
    // 与 0.1.0 的做法对齐：把 codex-forge 重映射成 plugins-settings，复用它的
    // component/commandAsset/navigation，而不是凭空返回一个图标项。26.1021 里
    // 导航会读 Va(slug).component 并当组件渲染，返回 undefined 会运行时抛错。
    return replace(source,
      'function Va(e,t){return e===`cloud-environments`?',
      'function Va(e,t){if(e===`codex-forge`)e=`plugins-settings`;return e===`cloud-environments`?');
  }
  source = replace(source, 'function Ha(e,t){return', 'function Ha(e,t){if(e===`codex-forge`)e=`plugins-settings`;return');
  return replace(source, 'It=r[54],It}function io', 'It=r[54],(()=>{const section={slug:`codex-forge`};return {...It,visibleSettingsSections:[...It.visibleSettingsSections,section],settingsNavigationSections:[...It.settingsNavigationSections,section],...(i===`codex-forge`?{activeSettingsSection:`codex-forge`,shouldRedirectToVisibleSettingsSection:!1,cloudPreferencesAccessError:null,shouldRenderRouteContent:!0}:{})}})()}function io');
}

export function patchSettingsPage(source, { version = 'legacy' } = {}) {
  if (version === 'current') {
    // The native title table and lazy-route registry contain only native slugs.
    // Navigation resolves the aria-label before rendering label/tooltip JSX.
    source = replace(source, 'l=hn(e.slug,O,t),',
      'l=e.slug===`codex-forge`?{id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`}:hn(e.slug,O,t),');
    source = replace(source, 'f=()=>{r||e.appRoute!=null||Yt(e.slug).catch(Qr)}',
      'f=()=>{r||e.slug===`codex-forge`||e.appRoute!=null||Yt(e.slug).catch(Qr)}');
    source = replace(source, 'p=I?(0,Q.jsx)(dn,{',
      'p=I?e.slug===`codex-forge`?(0,Q.jsx)(F,{id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`}):(0,Q.jsx)(dn,{');
    source = replace(source,
      'slugs:[`plugins-settings`,`file-type-handlers`',
      'slugs:[`plugins-settings`,`codex-forge`,`file-type-handlers`');
    const label = 'label:(0,Q.jsx)(dn,{codexMicroDeviceModel:D,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:O,slug:e.slug})';
    source = replace(source, label,
      'label:e.slug===`codex-forge`?(0,Q.jsx)(F,{id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`}):(0,Q.jsx)(dn,{codexMicroDeviceModel:D,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:O,slug:e.slug})');
    return replace(source, 'Fe=a}let Ie;',
      'Fe=a}if(ne===`codex-forge`)Fe=(0,$.jsx)(`div`,{\x22data-forge-settings-mount\x22:`true`,\x22data-forge-settings-plugin\x22:new URLSearchParams(d.search).get(`plugin`)||``,style:{width:`100%`,height:`100%`,minHeight:500,display:`flex`}});let Ie;');
  }
  source = replace(source, 'l=gn(e.slug,E,t),', 'l=e.slug===`codex-forge`?{id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`}:gn(e.slug,E,t),');
  source = replace(source, 'f=()=>{r||e.appRoute!=null||$e(e.slug).catch(Gr)}', 'f=()=>{r||e.slug===`codex-forge`||e.appRoute!=null||$e(e.slug).catch(Gr)}');
  source = replace(source, 'm=N?(0,Q.jsx)(Pe,', 'm=N&&e.slug!==`codex-forge`?(0,Q.jsx)(Pe,');
  source = replace(source, 'hi=`general-settings.', 'hi=`codex-forge.general-settings.');
  source = replace(source, 'slugs:[`plugins-settings`,`file-type-handlers`', 'slugs:[`plugins-settings`,`codex-forge`,`file-type-handlers`');
  return replace(source, 'let Be;e[69]', 'if(S===`codex-forge`)B=(0,$.jsx)(`div`,{\x22data-forge-settings-mount\x22:`true`,\x22data-forge-settings-plugin\x22:new URLSearchParams(f.search).get(`plugin`)||``,style:{width:`100%`,height:`100%`,minHeight:500,display:`flex`}});let Be;e[69]');
}
