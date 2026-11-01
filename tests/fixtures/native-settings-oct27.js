// Reduced executable anchors from 26.1027.3384.0.
const groups=[{slugs:[`plugins-settings`,`file-type-handlers`]}];
function renderNavigation(sections,active,L){
  const D=false,E=null,j=intl;
  return sections.map(e=>{
    let t=false,r=!!e.disabled,l=vn(e.slug,D,t),label=j.formatMessage(l,l.values),
      d=()=>{r||select(e.slug)},f=()=>{r||e.appRoute!=null||Qt(e.slug).catch(ti)},
      p=L?(0,Q.jsx)(mn,{codexMicroDeviceModel:E,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:D,slug:e.slug}):null;
    return {content:p,children:{'aria-label':label,onClick:d,onFocus:f,onPointerEnter:f,label:(0,Q.jsx)(mn,{codexMicroDeviceModel:E,showChatGptDataControlsLabel:t,showEnterpriseUsageLabel:D,slug:e.slug})}};
  });
}
function renderContent(C,f){let Oe,o='native content';if(C!=null){Oe=o}let ke;return Oe;}
