// Reduced executable 26.1021 navigation. Keep the native title lookup, tooltip,
// lazy prefetch and JSX expressions together: a label-only patch still crashes.
const groups=[{slugs:[`plugins-settings`,`file-type-handlers`]}];
function renderNavigation(sections,o,I){
  const z=false,M=false,O=false,D=null,A=intl,s=select,C=true,w=true,ze=null;
  return sections.map(e=>{let t=e.slug===`data-controls`&&z,n=e.slug===o,r=!!e.disabled,i=jn(e.slug,M),a=n&&e.slug===`pets`,c=a?sr:i.component,l=hn(e.slug,O,t),u=e.slug===`codex-micro`&&D===`creator-micro-v2`?A.formatMessage(ln.creatorMicro):A.formatMessage(l,l.values),d=()=>{r||s(e.slug)},f=()=>{r||e.appRoute!=null||Yt(e.slug).catch(Qr)},p=I?(0,Q.jsx)(dn,{codexMicroDeviceModel:D,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:O,slug:e.slug}):ze;return(0,Q.jsx)(me,{content:p,side:`right`,sideOffset:12,disabled:!I&&!r,children:(0,Q.jsx)(Wt,{"aria-label":u,icon:16 in c?(0,Q.jsx)(de,{className:n?`text-codex-icon-active`:void 0,icon:c}):c,iconAssetSource:a?void 0:i.navigation,isActive:n,disabled:r,"data-settings-panel-slug":w&&!r?e.slug:void 0,hideLabel:C?I:void 0,onClick:d,onFocus:f,onPointerEnter:f,weightClassName:`font-normal`,label:(0,Q.jsx)(dn,{codexMicroDeviceModel:D,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:O,slug:e.slug}),trailing:!I&&e.appRoute!=null?(0,Q.jsx)(pt,{className:`icon-xs text-secondary opacity-50`}):void 0})},e.slug)});
}
function renderContent(ne,d){let Fe,a=`native content`;if(ne!=null){Fe=a}let Ie;return Fe;}
