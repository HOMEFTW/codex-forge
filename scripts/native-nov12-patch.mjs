import assert from 'node:assert/strict';
import { patchNov09Factory } from './native-nov09-patch.mjs';

const title = '{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}';
function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, 'Nov 12 native anchor changed: ' + from);
  return source.replace(from, () => to);
}

export function patchNov12Factory(source, id, extension) {
  switch (id) {
    case 'HHvo': return replace(source, 'D?.get("enable_i18n",!1)', '!0');
    case 'KM95': return replace(source, 'I?.get("enable_i18n",!0)', '!0');
    case 'bJfu':
      source = replace(source, 'bJfu(e,t,n){', 'bJfu(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'workspaceWidth:ee}=e,et=(0,o.gh)(c.GD),el=(0,f.A)();',
        'workspaceWidth:ee}=e,et=(0,o.gh)(c.GD),el=(__forgeNativeRequire("EpL9").__forgeRememberScope(et),(0,f.A)());');
    case 'HEBX':
      source = replace(source, 'np=nh.flatMap(ev),', 'np=[...nh.flatMap(ev),{slug:"codex-forge"}],');
      return replace(source, 'let nm=nh.find(eH);', 'let nm=nh.find(eH)||(eO==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0);');
    case 'F4PH':
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      source = replace(source, 'n=(0,eC.y)(e.slug,tF),', 'n=(0,eC.y)(e.slug==="codex-forge"?"plugins-settings":e.slug,tF),');
      source = replace(source, 'c=(0,ex.G)(e.slug,tW,t),', 'c=e.slug==="codex-forge"?' + title + ':(0,ex.G)(e.slug,tW,t),');
      source = replace(source, 'd=()=>{i||null!=e.appRoute||(0,ek.OU)(e.slug).catch(tc)}', 'd=()=>{i||e.slug==="codex-forge"||null!=e.appRoute||(0,ek.OU)(e.slug).catch(tc)}');
      source = replace(source, 'g=tJ?(0,a.jsx)(eN.gl,{', 'g=tJ?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eN.gl,{');
      return replace(source, 'label:(0,a.jsx)(eN.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eN.gl,{');
    case 'oWtO':
      return replace(source, 'shouldRenderRouteContent:p}=s;if(h){', 'shouldRenderRouteContent:p}=s;if(l==="codex-forge")return(0,i.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(o.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    case 'UTF2':
      source = replace(source, 'let e=(0,j.G)(S.slug);', 'let e=S.slug==="codex-forge"?' + title + ':(0,j.G)(S.slug);');
      return replace(source, 't=(0,w.y)(S.slug,k),', 't=(0,w.y)(S.slug==="codex-forge"?"plugins-settings":S.slug,k),');
    default: return patchNov09Factory(source, id, extension);
  }
}
