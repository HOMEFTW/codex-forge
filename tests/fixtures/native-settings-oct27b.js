// Reduced executable anchors from 26.1027.6604.0.
const groups=[{slugs:[`plugins-settings`,`file-type-handlers`]}];
function renderNavigation(sections,active,F){
  const E=false,T=null,j=intl;
  return sections.map(e=>{
    let t=false,r=!!e.disabled,l=vn(e.slug,E,t),label=j.formatMessage(l,l.values),
      d=()=>{r||select(e.slug)},f=()=>{r||e.appRoute!=null||Qt(e.slug).catch(ti)},
      p=F?(0,Q.jsx)(mn,{codexMicroDeviceModel:T,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:E,slug:e.slug}):null;
    return {content:p,children:{'aria-label':label,onClick:d,onFocus:f,onPointerEnter:f,label:(0,Q.jsx)(mn,{codexMicroDeviceModel:T,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:E,slug:e.slug})}};
  });
}
function renderContent(C,f){let Me,o='native content';if(C!=null){Me=o}let Ne;return Me;}
