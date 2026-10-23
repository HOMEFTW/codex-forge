import assert from 'node:assert/strict';
function replace(source, from, to) { assert.equal(source.split(from).length,2,'Native settings anchor changed: '+from);return source.replace(from,to); }
export function patchSettingsVisibility(source) {
  source=replace(source,'function Ha(e,t){return','function Ha(e,t){if(e===`codex-forge`)e=`plugins-settings`;return');
  return replace(source,'It=r[54],It}function io', 'It=r[54],(()=>{const section={slug:`codex-forge`};return {...It,visibleSettingsSections:[...It.visibleSettingsSections,section],settingsNavigationSections:[...It.settingsNavigationSections,section],...(i===`codex-forge`?{activeSettingsSection:`codex-forge`,shouldRedirectToVisibleSettingsSection:!1,cloudPreferencesAccessError:null,shouldRenderRouteContent:!0}:{})}})()}function io');
}
export function patchSettingsPage(source) {
  source=replace(source,'l=gn(e.slug,E,t),','l=e.slug===`codex-forge`?{id:`codexForge.settings`,defaultMessage:`Codex Forge 插件设置`}:gn(e.slug,E,t),');
  source=replace(source,'f=()=>{r||e.appRoute!=null||$e(e.slug).catch(Gr)}','f=()=>{r||e.slug===`codex-forge`||e.appRoute!=null||$e(e.slug).catch(Gr)}');
  source=replace(source,'m=N?(0,Q.jsx)(Pe,','m=N&&e.slug!==`codex-forge`?(0,Q.jsx)(Pe,');
  source=replace(source,'hi=`general-settings.','hi=`codex-forge.general-settings.');
  source=replace(source,'slugs:[`plugins-settings`,`file-type-handlers`','slugs:[`plugins-settings`,`codex-forge`,`file-type-handlers`');
  return replace(source,'let Be;e[69]', 'if(S===`codex-forge`)B=(0,$.jsx)(`div`,{\x22data-forge-settings-mount\x22:`true`,\x22data-forge-settings-plugin\x22:new URLSearchParams(f.search).get(`plugin`)||``,style:{width:`100%`,height:`100%`,minHeight:500,display:`flex`}});let Be;e[69]');
}
