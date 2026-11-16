import assert from 'node:assert/strict';
import { patchNov09Factory } from './native-nov09-patch.mjs';

const title = '{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}';
function replace(source, from, to, count = 1) {
  assert.equal(source.split(from).length, count + 1, 'Nov 16 native anchor changed: ' + from);
  return source.replaceAll(from, () => to);
}

export function patchNov16Factory(source, id, extension) {
  switch (id) {
    case 'HHvo': return replace(source, 'x?.get("enable_i18n",!1)', '!0');
    case 'KM95': return replace(source, 'I?.get("enable_i18n",!0)', '!0');
    case 'yrds': return replace(source, 'T=(0,d.Zj)("410262010")', 'T=(0,d.Zj)("410262010")||globalThis.__codexForgeStartup?.browserEnabled===true');
    case 'ipV4':
      assert(source.includes('("UOa8")'), 'Nov 16 account module changed');
      return replace(patchNov09Factory(source, id, extension), 'auth=n("EOo5")', 'auth=n("UOa8")');
    case 'B6RU':
      source = replace(source, 'B6RU(e,t,n){', 'B6RU(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'workspaceWidth:ee}=e,et=(0,o.gh)(c.GD),el=(0,f.A)();',
        'workspaceWidth:ee}=e,et=(0,o.gh)(c.GD),el=(__forgeNativeRequire("EpL9").__forgeRememberScope(et),(0,f.A)());');
    case 'RNoz':
      source = replace(source, 'np=nh.flatMap(eg),', 'np=[...nh.flatMap(eg),{slug:"codex-forge"}],');
      return replace(source, 'let nm=nh.find(eH);', 'let nm=nh.find(eH)||(eO==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0);');
    case 'F4PH':
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      // Navigation and search both consume the augmented section list. Keep
      // native slugs unchanged, and never preload an upstream module for Forge.
      source = replace(source, '(0,ex.G)(', '__forgeSettingsTitle(', 5);
      source = replace(source, '(0,eC.y)(', '__forgeSettingsIcon(', 2);
      source = replace(source, '(0,ek.OU)(', '__forgePreloadSettings(', 3);
      source = replace(source, 'targets:tN??st,visibleSectionSlugs:', 'targets:__forgeSettingsSearchTargets(tN??st),visibleSectionSlugs:');
      source = replace(source, 'g=t0?(0,a.jsx)(eN.gl,{', 'g=t0?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eN.gl,{');
      source = replace(source, 'label:(0,a.jsx)(eN.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eN.gl,{');
      return replace(source, 'F4PH(e,t,s){', `F4PH(e,t,s){
        function __forgeSettingsTitle(slug,...args){return slug==="codex-forge"?${title}:(0,ex.G)(slug,...args);}
        function __forgeSettingsIcon(slug,...args){return (0,eC.y)(slug==="codex-forge"?"plugins-settings":slug,...args);}
        function __forgePreloadSettings(slug,...args){return slug==="codex-forge"?Promise.resolve():(0,ek.OU)(slug,...args);}
        function __forgeSettingsSearchTargets(targets){return [...targets,{sectionSlug:"codex-forge",messages:[],terms:["Forge","插件"]}];}
      `);
    case 'LxTx':
      return replace(source, 'shouldRenderRouteContent:p}=s;if(h){', 'shouldRenderRouteContent:p}=s;if(l==="codex-forge")return(0,i.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(o.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    case 'UTF2':
      source = replace(source, 'let e=(0,j.G)(S.slug);', 'let e=S.slug==="codex-forge"?' + title + ':(0,j.G)(S.slug);');
      return replace(source, 't=(0,w.y)(S.slug,b),', 't=(0,w.y)(S.slug==="codex-forge"?"plugins-settings":S.slug,b),');
    default: return patchNov09Factory(source, id, extension);
  }
}
