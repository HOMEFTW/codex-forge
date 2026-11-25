import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchNov09Factory } from './native-nov09-patch.mjs';

const title = '{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}';
function replace(source, from, to, count = 1) {
  assert.equal(source.split(from).length, count + 1, 'Nov 25 native anchor changed: ' + from);
  return source.replaceAll(from, () => to);
}

export function patchNov25Factory(source, id, extension) {
  switch (id) {
    case 'EpL9': {
      // This build wraps selected factories in function expressions. Normalize
      // only this verified factory before reusing the lazy tab registration.
      assert(source.startsWith('EpL9:(function(e,t,n){') && source.endsWith('})'));
      source = 'EpL9(e,t,n){' + source.slice('EpL9:(function(e,t,n){'.length, -1);
      return patchNov09Factory(source, id, extension).replaceAll('n("zTeN")', 'n("Q840")').replaceAll('n("Oj9r")', 'n("tSEg")');
    }
    case 'DWOZ':
      source = replace(source, 'DWOZ:(function(e,t,n){', 'DWOZ:(function(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'et=(0,o.gh)(c.GD),en=(0,f.A)();',
        'et=(0,o.gh)(c.GD),en=(__forgeNativeRequire("EpL9").__forgeRememberScope(et),(0,f.A)());');
    case 'HHvo': {
      source = replace(source, 'D?.get("enable_i18n",!1)', '!0');
      const extra = JSON.parse(fs.readFileSync(new URL('../runtime/zh-cn-extra.json', import.meta.url), 'utf8'));
      // Upstream now loads compressed, positional locale arrays. Merge only
      // after its own loader has reconstructed the message map.
      return replace(source, 'let t=await (0,g.d5)(B);', 'let t=await (0,g.d5)(B);if(B.locale==="zh-CN")t={...t,...' + JSON.stringify(extra) + '};');
    }
    case 'XADK': return replace(source, source.includes('e(y.$Q,') ? 'e(y.$Q,"72216192")?.get("enable_i18n",!0)??!0' : 'e(x.$Q,"72216192")?.get("enable_i18n",!0)??!0', '!0');
    case 'ipV4': {
      const loader = source.match(/^ipV4\(\w+,\w+,(\w+)\)\{/)?.[1];
      assert(loader && source.includes(loader+'("Q840")') && source.includes(loader+'("h6fL")'), 'Nov 25 account dependencies changed');
      return patchNov09Factory(source, id, extension).replace('signals=n("zTeN")', 'signals=n("Q840")').replace('auth=n("EOo5")', 'auth=n("h6fL")');
    }
    case 'jWaO': return replace(source, 'E=(0,u.Zj)("410065390")', 'E=(0,u.Zj)("410065390")||globalThis.__codexForgeStartup?.externalBrowserEnabled===true');
    case 'yrds': return replace(source, 'A=(0,d.Zj)("410262010")', 'A=(0,d.Zj)("410262010")||globalThis.__codexForgeStartup?.browserEnabled===true');
    case 'FRRX':
      source = replace(source, 'ny=nx.flatMap(ef),', 'ny=[...nx.flatMap(ef),{slug:"codex-forge"}],');
      return replace(source, 'let nL=nx.find(ej);', 'let nL=nx.find(ej)||(eS==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0);');
    case 'yrkS':
      return replace(source, 'shouldRenderRouteContent:p}=i;if(h){',
        'shouldRenderRouteContent:p}=i;if(o==="codex-forge")return(0,s.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(l.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    case 'a4Ud':
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      source = replace(source, '(0,eI.G)(', '__forgeSettingsTitle(', 7);
      source = replace(source, '(0,ej.y)(', '__forgeSettingsIcon(', 2);
      source = replace(source, '(0,eM.OU)(', '__forgePreloadSettings(', 3);
      source = replace(source, 'sections:tI.filter(e=>"billing"!==e||null==ed)', 'sections:__forgeNativeSearchSections(tI,ed)');
      source = replace(source, 'u=tp?(0,s.jsx)(eB.gl,{', 'u=tp?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,s.jsx)(eB.gl,{');
      source = replace(source, 'label:(0,s.jsx)(eB.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,s.jsx)(eB.gl,{');
      // The current search already derives section names from visible slugs.
      return replace(source, 'a4Ud(e,t,a){', `a4Ud(e,t,a){
        function __forgeSettingsTitle(slug,...args){return slug==="codex-forge"?${title}:(0,eI.G)(slug,...args);}
        function __forgeSettingsIcon(slug,...args){return (0,ej.y)(slug==="codex-forge"?"plugins-settings":slug,...args);}
        function __forgePreloadSettings(slug,...args){return slug==="codex-forge"?Promise.resolve():(0,eM.OU)(slug,...args);}
        function __forgeNativeSearchSections(slugs,billingUrl){return slugs.filter(slug=>slug!=="codex-forge"&&(slug!=="billing"||billingUrl==null));}
      `);
    case 'UTF2':
      source = replace(source, 'let t=(0,_.G)(e.slug),', 'let t=e.slug==="codex-forge"?' + title + ':(0,_.G)(e.slug),');
      return replace(source, 'i=(0,x.y)(e.slug,b),', 'i=(0,x.y)(e.slug==="codex-forge"?"plugins-settings":e.slug,b),');
    default: return patchNov09Factory(source, id, extension);
  }
}
