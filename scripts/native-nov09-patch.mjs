import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rewriteExtension } from './native-tabs-patch.mjs';

const title = '{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}';
function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, 'Nov 09 native anchor changed: ' + from);
  return source.replace(from, () => to);
}
export function patchNov09Factory(source, id, extension) {
  switch (id) {
    case 'cuQI': {
      assert(source.startsWith('cuQI(e){e.exports=JSON.parse('));
      const messages = JSON.parse(fs.readFileSync(new URL('../runtime/zh-cn-extra.json', import.meta.url), 'utf8'));
      return source.slice(0, -1) + ';Object.assign(e.exports,' + JSON.stringify(messages) + ')}';
    }
    case 'HHvo': return replace(source, 'x?.get("enable_i18n",!1)', '!0');
    case 'pqJp': return replace(source, 'E?.get("enable_i18n",!0)', '!0');
    case 'yrds': return replace(source, 'C=(0,d.Zj)("410262010")', 'C=(0,d.Zj)("410262010")||globalThis.__codexForgeStartup?.browserEnabled===true');
    case 'jWaO': return replace(source, 'I=(0,u.Zj)("410065390")', 'I=(0,u.Zj)("410065390")||globalThis.__codexForgeStartup?.externalBrowserEnabled===true');
    case 'IIEq': return replace(source, 'b=(0,h.Zj)("1506311413")', 'b=(0,h.Zj)("1506311413")||globalThis.__codexForgeStartup?.computerUseEnabled===true');
    case 'EpL9': {
      const symbols = {
        registryMap: 'o', register: 't.v', controller: 'n("ZU27").It',
        routeUnavailable: 'n("Oj9r").Rj', fullWidth: 'n("QcW8").kF',
        react: 'n("zd8w")', openPanel: 'n("XXJV").yI', layout: '((scope,target,options)=>n("WwnD").xO(scope,target.tab,options))',
        routeScope: '(0,n("zTeN").gh)(n("Oj9r").GD)',
        fullWidthRead: '(0,n("zTeN").Ul)(n("QcW8").kF)',
      };
      assert(source.startsWith('EpL9(e,t,n){') && source.endsWith('}'));
      return source.slice(0, -1) + '\n/* FAST_NATIVE_WORKSPACE_TABS */\n' + rewriteExtension(extension, symbols)
        + '\nn.d(t,{__forgeRememberScope:()=>fastWorkspaceRememberScope});fastWorkspaceRegisterTabs();\n}';
    }
    case 'bJfu':
      source = replace(source, 'bJfu(e,t,n){', 'bJfu(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'workspaceWidth:J}=e,ee=(0,o.gh)(c.GD),et=(0,f.A)();',
        'workspaceWidth:J}=e,ee=(0,o.gh)(c.GD),et=(__forgeNativeRequire("EpL9").__forgeRememberScope(ee),(0,f.A)());');
    case 'ipV4':
      return `ipV4(e,t,n){
        var cache=n("QosV"),signals=n("zTeN"),access=n("eWgO"),host=n("tl5a"),auth=n("EOo5"),query=n("B81s");
        function useAccess(options){
          let memo=(0,cache.c)(8),defaultHost=(0,signals.Ul)(host.Dc),hostId=options?.hostId??defaultHost,account=(0,auth.tn)(hostId);
          let enabled=globalThis.__codexForgeStartup?.fastEnabled===true,method=account?.authMethod??(enabled&&account?.requiresAuth===false?"apikey":null);
          let native=method==="chatgpt"||method==="personalAccessToken"||method==="amazonBedrock";
          let args=memo[0]===hostId&&memo[1]===method?memo[2]:(memo[0]=hostId,memo[1]=method,memo[2]={authMethod:method,hostId});
          let {data,isPending}=(0,signals._U)(query.b9,args),loading=!!account?.isLoading||(native||enabled&&method==="apikey")&&isPending;
          return memo[3]===data&&memo[4]===loading&&memo[5]===method&&memo[6]===enabled?memo[7]:(memo[3]=data,memo[4]=loading,memo[5]=method,memo[6]=enabled,memo[7]={serviceTierAccess:loading?null:native&&data!=null?(0,access.W6)(data):enabled&&method==="apikey"?(0,access.W6)(data??{}):null,isLoading:loading});
        }
        n.d(t,{U:()=>useAccess});
      }`;
    case 'PAzX': {
      // Request-side eligibility must agree with the selector. Native account
      // requirements and the selected model's actual service tiers remain intact.
      const gates = [...source.matchAll(/if\("chatgpt"!==([\w$]+)&&"personalAccessToken"!==\1&&"amazonBedrock"!==\1\)return null;/g)];
      assert.equal(gates.length, 1, 'Nov 09 request eligibility changed');
      const [gate, method] = gates[0];
      // The requirements query still runs for API providers so explicit managed
      // restrictions apply to requests as well as to the model selector.
      return replace(source, gate, `if(!(globalThis.__codexForgeStartup?.fastEnabled===true&&(${method}==="apikey"||${method}==null)))` + gate);
    }
    case 'F4PH':
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      source = replace(source, 'n=(0,ex.y)(e.slug,tK),', 'n=(0,ex.y)(e.slug==="codex-forge"?"plugins-settings":e.slug,tK),');
      source = replace(source, 'c=(0,eM.G)(e.slug,tW,t),', 'c=e.slug==="codex-forge"?' + title + ':(0,eM.G)(e.slug,tW,t),');
      source = replace(source, 'd=()=>{i||null!=e.appRoute||(0,eC.OU)(e.slug).catch(tl)}', 'd=()=>{i||e.slug==="codex-forge"||null!=e.appRoute||(0,eC.OU)(e.slug).catch(tl)}');
      source = replace(source, 'g=tJ?(0,a.jsx)(eG.gl,{', 'g=tJ?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eG.gl,{');
      return replace(source, 'label:(0,a.jsx)(eG.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eG.gl,{');
    case 'HEBX':
      source = replace(source, 'ni=nr.flatMap(ev),', 'ni=[...nr.flatMap(ev),{slug:"codex-forge"}],');
      return replace(source, 'let nl=nr.find(e_),', 'let nl=nr.find(e_)||(eH==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0),');
    case 'bREQ':
      return replace(source, 'shouldRenderRouteContent:p}=s;if(h){', 'shouldRenderRouteContent:p}=s;if(l==="codex-forge")return(0,i.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(o.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    case 'xWQh':
      source = replace(source, 'let e=(0,j.G)(R.slug);', 'let e=R.slug==="codex-forge"?' + title + ':(0,j.G)(R.slug);');
      return replace(source, 't=(0,A.y)(R.slug,N),', 't=(0,A.y)(R.slug==="codex-forge"?"plugins-settings":R.slug,N),');
    default: throw Error('Unsupported Nov 09 module: ' + id);
  }
}
