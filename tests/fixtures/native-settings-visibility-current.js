function visibility(e,h){switch(e){case`plugins-settings`:return{visible:h,pending:!1};default:return{visible:true,pending:false}}}
const co=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`];
const uo={"plugins-settings":`codexOrWorkLocal`,"file-type-handlers":`codexOrWorkLocal`};
function visible(i){
  const kt=e=>e.section.slug===i,ao=e=>e.visible?[e.section]:[];
  let Dt=[{slug:`general-settings`},{slug:`plugins-settings`}].map(section=>{return{section,visible:!0,pending:!1,error:!1}}),J=Dt.flatMap(ao),unused=null;
  let X=Dt.find(kt),shouldRedirectToVisibleSettingsSection=X==null;
  return{visibleSettingsSections:J,activeSettingsSection:X?.section.slug,shouldRedirectToVisibleSettingsSection};
}
const pluginIcon={component:{16:`plugin icon`},navigation:`plugin asset`},cloudIcon={component:{16:`cloud icon`}};
const icons={"plugins-settings":pluginIcon};
function Va(e,t){return e===`cloud-environments`?cloudIcon:icons[e]}
