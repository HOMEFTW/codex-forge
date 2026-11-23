import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchNov09Factory } from './native-nov09-patch.mjs';

const title = '{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}';
function replace(source, from, to, count = 1) {
  assert.equal(source.split(from).length, count + 1, 'Nov 23 native anchor changed: ' + from);
  return source.replaceAll(from, () => to);
}

export function patchNov23Factory(source, id, extension) {
  switch (id) {
    case 'EpL9': {
      // This build wraps selected factories in function expressions. Normalize
      // only this verified factory before reusing the lazy tab registration.
      assert(source.startsWith('EpL9:(function(e,t,n){') && source.endsWith('})'));
      source = 'EpL9(e,t,n){' + source.slice('EpL9:(function(e,t,n){'.length, -1);
      return patchNov09Factory(source, id, extension).replaceAll('n("zTeN")', 'n("qmMi")').replaceAll('n("Oj9r")', 'n("tSEg")');
    }
    case 'jNL7':
      source = replace(source, 'jNL7:(function(e,t,n){', 'jNL7:(function(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'et=(0,o.gh)(c.GD),en=(0,m.A)();',
        'et=(0,o.gh)(c.GD),en=(__forgeNativeRequire("EpL9").__forgeRememberScope(et),(0,m.A)());');
    case 'HHvo': {
      source = replace(source, 'D?.get("enable_i18n",!1)', '!0');
      const extra = JSON.parse(fs.readFileSync(new URL('../runtime/zh-cn-extra.json', import.meta.url), 'utf8'));
      // Upstream now loads compressed, positional locale arrays. Merge only
      // after its own loader has reconstructed the message map.
      return replace(source, 'let t=await (0,g.d5)(j);', 'let t=await (0,g.d5)(j);if(j.locale==="zh-CN")t={...t,...' + JSON.stringify(extra) + '};');
    }
    case 'XADK': return replace(source, source.includes('e(y.$Q,') ? 'e(y.$Q,"72216192")?.get("enable_i18n",!0)??!0' : 'e(M.$Q,"72216192")?.get("enable_i18n",!0)??!0', '!0');
    case 'ipV4': {
      const loader = source.match(/^ipV4\(\w+,\w+,(\w+)\)\{/)?.[1];
      assert(loader && source.includes(loader+'("qmMi")') && source.includes(loader+'("UOa8")'), 'Nov 23 account dependencies changed');
      return patchNov09Factory(source, id, extension).replace('signals=n("zTeN")', 'signals=n("qmMi")').replace('auth=n("EOo5")', 'auth=n("UOa8")');
    }
    case 'jWaO': return replace(source, 'E=(0,u.Zj)("410065390")', 'E=(0,u.Zj)("410065390")||globalThis.__codexForgeStartup?.externalBrowserEnabled===true');
    case 'yrds': return replace(source, 'T=(0,d.Zj)("410262010")', 'T=(0,d.Zj)("410262010")||globalThis.__codexForgeStartup?.browserEnabled===true');
    case 'FRRX':
      source = replace(source, 'nv=nf.flatMap(em),', 'nv=[...nf.flatMap(em),{slug:"codex-forge"}],');
      return replace(source, 'let nx=nf.find(ej);', 'let nx=nf.find(ej)||(eT==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0);');
    case 'mjpt':
      return replace(source, 'shouldRenderRouteContent:p}=s;if(h){',
        'shouldRenderRouteContent:p}=s;if(o==="codex-forge")return(0,r.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(l.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    case 'a4Ud':
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      source = replace(source, '(0,eM.G)(', '__forgeSettingsTitle(', 7);
      source = replace(source, '(0,ek.y)(', '__forgeSettingsIcon(', 2);
      source = replace(source, '(0,eC.OU)(', '__forgePreloadSettings(', 3);
      source = replace(source, 'sections:tk.filter(e=>"billing"!==e||null==er)', 'sections:__forgeNativeSearchSections(tk,er)');
      source = replace(source, 'u=tg?(0,s.jsx)(eU.gl,{', 'u=tg?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,s.jsx)(eU.gl,{');
      source = replace(source, 'label:(0,s.jsx)(eU.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,s.jsx)(eU.gl,{');
      // The current search already derives section names from visible slugs.
      return replace(source, 'a4Ud(e,t,a){', `a4Ud(e,t,a){
        function __forgeSettingsTitle(slug,...args){return slug==="codex-forge"?${title}:(0,eM.G)(slug,...args);}
        function __forgeSettingsIcon(slug,...args){return (0,ek.y)(slug==="codex-forge"?"plugins-settings":slug,...args);}
        function __forgePreloadSettings(slug,...args){return slug==="codex-forge"?Promise.resolve():(0,eC.OU)(slug,...args);}
        function __forgeNativeSearchSections(slugs,billingUrl){return slugs.filter(slug=>slug!=="codex-forge"&&(slug!=="billing"||billingUrl==null));}
      `);
    case 'UTF2':
      source = replace(source, 'let t=(0,_.G)(e.slug),', 'let t=e.slug==="codex-forge"?' + title + ':(0,_.G)(e.slug),');
      return replace(source, 'i=(0,x.y)(e.slug,b),', 'i=(0,x.y)(e.slug==="codex-forge"?"plugins-settings":e.slug,b),');
    default: return patchNov09Factory(source, id, extension);
  }
}
