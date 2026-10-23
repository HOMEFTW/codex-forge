'use strict';
const fs=require('node:fs'),path=require('node:path');
function pluginResponse(registry,requestURL) {
  try {
    const url=new URL(requestURL);if(url.protocol!=='codex-forge:'||url.hostname!=='plugin')throw Error('Invalid plugin URL');
    const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==2)throw Error('Invalid plugin resource');
    const [id,view]=parts,entry=registry.get(id),m=entry.manifest;
    let html='<!doctype html><html><head></head><body></body></html>',script='';
    if(view==='runtime')script=m.entry?registry.source(id,m.entry):'';
    else {registry.permission(id,'panels');const panel=m.contributes?.panels?.find(p=>p.id===view);if(!panel||panel.builtinPage)throw Error('Unknown panel');html=registry.source(id,panel.entry);}
    const sdk=fs.readFileSync(path.join(__dirname,'forge-sdk.js'),'utf8');
    const inline=value=>'<script>'+value.replace(/<\/script/gi,'<\\/script')+'</script>';
    const setup='<meta charset="utf-8">'+inline(sdk);
    html=/<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,match=>match+setup):'<!doctype html><head>'+setup+'</head>'+html;
    html+=inline(script);
    const origins=(m.networkOrigins||[]).join(' ');
    const csp=`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${origins}; connect-src ${origins||"'none'"}; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors app://-`;
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Permissions-Policy':'camera=(), microphone=(), geolocation=()'}});
  }catch(error){return new Response('Forge plugin unavailable',{status:404,headers:{'Content-Type':'text/plain','Content-Security-Policy':"default-src 'none'"}});}
}
function registerPluginProtocol(registry,electron) {
  if(!electron.protocol)return;
  electron.protocol.registerSchemesAsPrivileged([{scheme:'codex-forge',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  const registered=new WeakSet();
  const install=session=>{if(!session||registered.has(session))return;registered.add(session);session.protocol.handle('codex-forge',request=>pluginResponse(registry,request.url));};
  electron.app.on('session-created',install);
  electron.app.whenReady().then(()=>install(electron.session.defaultSession));
  electron.app.on('web-contents-created',(_event,contents)=>install(contents.session));
}
module.exports={pluginResponse,registerPluginProtocol};
