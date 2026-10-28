function visibility(e,p){switch(e){case`plugins-settings`:return{visible:p,pending:!1};default:return{visible:true,pending:false}}}
const lo=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`];
const fo={"plugins-settings":`codexOrWorkLocal`,"file-type-handlers":`codexOrWorkLocal`};
function visible(i){
  const kt=e=>e.section.slug===i,oo=e=>e.visible?[e.section]:[];
  let Dt=[{slug:`agent`},{slug:`plugins-settings`}].map(section=>{return{section,visible:!0,pending:!1,error:!1}}),J=Dt.flatMap(oo),unused=null;
  let X=Dt.find(kt),shouldRedirectToVisibleSettingsSection=X==null;
  return{visibleSettingsSections:J,activeSettingsSection:X?.section.slug,shouldRedirectToVisibleSettingsSection};
}
const pluginIcon={component:{16:`plugin icon`},navigation:`plugin asset`},cloudIcon={component:{16:`cloud icon`}};
const icons={'plugins-settings':pluginIcon};
function Ha(e,t){return e===`cloud-environments`?cloudIcon:icons[e]}
