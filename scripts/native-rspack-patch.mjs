import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rewriteExtension } from './native-tabs-patch.mjs';
import { patchNov12Factory } from './native-nov12-patch.mjs';
import { patchNov09Factory } from './native-nov09-patch.mjs';

// These module IDs and source ranges belong to the pinned Oct 29 MSIX only.
// Resolve native dependencies on use: the registry and controller import each
// other, and eagerly reading the controller here would break cold startup.
const nativeSymbols = {
  registryMap: 'o', register: 'u', controller: 'n("ZU27").It',
  routeUnavailable: 'n("Oj9r").Rj', fullWidth: 'n("QcW8").kF',
  react: 'n("zd8w")', openPanel: 'n("XXJV").yI', layout: 'n("WwnD").xO',
  routeScope: '(0,n("y5DF").gh)(n("Oj9r").GD)',
  fullWidthRead: '(0,n("y5DF").Ul)(n("QcW8").kF)',
};

function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, 'Oct 29 native anchor changed: ' + from);
  return source.replace(from, () => to);
}

export function patchRspackIndex(source) {
  // Rspack emits literal quotes; the older HTML builder used &#39; entities.
  return replace(source, "frame-src 'self' blob:", "frame-src 'self' codex-forge: blob:");
}

export function patchRspackFactory(source, id, extension) {
  switch (id) {
    case 'EpL9': {
      assert(source.startsWith('EpL9(e,t,n){') && source.endsWith('}'), 'Registry factory changed');
      assert(extension.includes('function fastWorkspaceRememberScope('));
      return source.slice(0, -1) + '\n/* FAST_NATIVE_WORKSPACE_TABS */\n'
        + rewriteExtension(extension, nativeSymbols)
        + '\nn.d(t,{__forgeRememberScope:()=>fastWorkspaceRememberScope});fastWorkspaceRegisterTabs();\n}';
    }
    case 'yXyz':
      // The workspace component itself declares a local `n` memo slot. Capture
      // the factory loader outside that function so it cannot shadow require.
      source = replace(source, 'yXyz(e,t,n){', 'yXyz(e,t,n){const __forgeNativeRequire=n;');
      return replace(source, 'workspaceWidth:Q}=e,J=(0,o.gh)(c.GD),ee=(0,f.A)();',
        'workspaceWidth:Q}=e,J=(0,o.gh)(c.GD),ee=(__forgeNativeRequire("EpL9").__forgeRememberScope(J),(0,f.A)());');
    case 'ipV4':
      // All nine chunk copies export the same hook. Keep native query/auth
      // semantics, managed restrictions and memoization; extend API-key Fast
      // only while the Forge model plugin is enabled.
      return `ipV4(e,t,n){
        var cache=n("QosV"),signals=n("y5DF"),access=n("eWgO"),host=n("tl5a"),auth=n("EOo5"),query=n("B81s");
        function useAccess(options){
          let memo=(0,cache.c)(8),defaultHost=(0,signals.Ul)(host.Dc),hostId=options?.hostId??defaultHost,account=(0,auth.tn)(hostId);
          let enabled=globalThis.__codexForgeStartup?.fastEnabled===true,method=account?.authMethod??(enabled&&account?.requiresAuth===false?"apikey":null);
          let native=method==="chatgpt"||method==="personalAccessToken"||method==="amazonBedrock";
          let args=memo[0]===hostId&&memo[1]===method?memo[2]:(memo[0]=hostId,memo[1]=method,memo[2]={authMethod:method,hostId});
          let {data,isPending}=(0,signals._U)(query.b9,args),loading=!!account?.isLoading||native&&isPending;
          return memo[3]===data&&memo[4]===loading&&memo[5]===method&&memo[6]===enabled?memo[7]:(memo[3]=data,memo[4]=loading,memo[5]=method,memo[6]=enabled,memo[7]={serviceTierAccess:loading?null:native&&data!=null?(0,access.W6)(data):enabled&&method==="apikey"?{...(0,access.W6)(data??{}),ultrafast:false}:null,isLoading:loading});
        }
        n.d(t,{U:()=>useAccess});
      }`;
    case 'Nh8F': {
      source = replace(source, 'slugs:["plugins-settings","file-type-handlers"', 'slugs:["plugins-settings","codex-forge","file-type-handlers"');
      source = replace(source, 'n=(0,ey.y)(e.slug,tz),', 'n=(0,ey.y)(e.slug==="codex-forge"?"plugins-settings":e.slug,tz),');
      source = replace(source, 'c=(0,ev.G)(e.slug,tT,t),', 'c=e.slug==="codex-forge"?{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}:(0,ev.G)(e.slug,tT,t),');
      source = replace(source, 'd=()=>{i||null!=e.appRoute||(0,eb.OU)(e.slug).catch(e9)}', 'd=()=>{i||e.slug==="codex-forge"||null!=e.appRoute||(0,eb.OU)(e.slug).catch(e9)}');
      source = replace(source, 'g=tN?(0,a.jsx)(eS.gl,{', 'g=tN?e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eS.gl,{');
      return replace(source, 'label:(0,a.jsx)(eS.gl,{', 'label:e.slug==="codex-forge"?"Codex Forge 插件设置":(0,a.jsx)(eS.gl,{');
    }
    case 'Noba':
      source = replace(source, 'nn=nt.flatMap(em),', 'nn=[...nt.flatMap(em),{slug:"codex-forge"}],');
      return replace(source, 'let nr=nt.find(eb),', 'let nr=nt.find(eb)||(eM==="codex-forge"?{section:{slug:"codex-forge"},visible:true,pending:false,error:false}:void 0),');
    case 'xWQh':
      // The command menu consumes the same augmented settings list, but its
      // title/icon lookups are separate from the settings navigation component.
      source = replace(source, 'let e=(0,b.G)(R.slug);',
        'let e=R.slug==="codex-forge"?{id:"codexForge.settings",defaultMessage:"Codex Forge 插件设置"}:(0,b.G)(R.slug);');
      return replace(source, 't=(0,A.y)(R.slug,M),', 't=(0,A.y)(R.slug==="codex-forge"?"plugins-settings":R.slug,M),');
    case 'MeKU':
      // nC has already called all hooks before its redirect/loading branches.
      return replace(source, 'shouldRenderRouteContent:p}=r;if(h){',
        'shouldRenderRouteContent:p}=r;if(l==="codex-forge")return(0,i.jsx)("div",{"data-forge-settings-mount":"true","data-forge-settings-plugin":new URLSearchParams(o.search).get("plugin")||"",style:{width:"100%",height:"100%",minHeight:500,display:"flex"}});if(h){');
    default: throw Error('Unsupported Rspack module: ' + id);
  }
}

export function patchRspackMember(source, member, modules, extension, version = 'oct29') {
  const entries = modules.filter(item => item.member === member).sort((a, b) => b.start - a.start);
  assert(entries.length, 'No Rspack patches for ' + member);
  let limit = source.length, result = source;
  for (const entry of entries) {
    const { start, end, id, sha256 } = entry;
    assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= limit, 'Invalid Rspack module range');
    const original = source.slice(start, end);
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), sha256, 'Rspack module digest changed: ' + member + ':' + id);
    assert(original.startsWith(id + '('), 'Rspack module ID changed');
    result = result.slice(0, start) + (version === 'nov12' ? patchNov12Factory(original, id, extension) : version === 'nov09' ? patchNov09Factory(original, id, extension) : patchRspackFactory(original, id, extension)) + result.slice(end);
    limit = start;
  }
  return result;
}
