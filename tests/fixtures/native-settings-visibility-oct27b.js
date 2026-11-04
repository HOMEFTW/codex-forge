function visibility(e,p){switch(e){case`plugins-settings`:return{visible:p,pending:!1};default:return{visible:true,pending:false}}}
const co=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`];
const uo={"plugins-settings":`codexOrWorkLocal`,"file-type-handlers":`codexOrWorkLocal`};
function visible(i){
  const q=e=>e.section.slug===i,ao=e=>e.visible?[e.section]:[];
  let kt=[{slug:`agent`},{slug:`plugins-settings`}].map(section=>{return{section,visible:!0,pending:!1,error:!1}}),G=kt.flatMap(ao),unused=null;
  let J=kt.find(q),shouldRedirectToVisibleSettingsSection=J==null;
  return{visibleSettingsSections:G,activeSettingsSection:J?.section.slug,shouldRedirectToVisibleSettingsSection};
}
const pluginIcon={component:{16:`plugin icon`},navigation:`plugin asset`},cloudIcon={component:{16:`cloud icon`}};
const icons={'plugins-settings':pluginIcon};
function za(e,t){return e===`cloud-environments`?cloudIcon:icons[e]}
