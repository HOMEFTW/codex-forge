'use strict';
const fs=require('node:fs'),path=require('node:path');
function inlineScript(value){return '<script>'+value.replace(/<\/script/gi,'<\\/script')+'</script>';}
function inHead(html,value){return /<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,match=>match+value):'<!doctype html><head>'+value+'</head>'+html;}
function pluginBundle(registry,id,{viewId,slotEntry,assetsRoot=path.join(__dirname,'ui')}={}) {
  const entry=registry.get(id),m=entry.manifest;
  let html='<!doctype html><html><head></head><body></body></html>',script='';
  if(slotEntry){
    const item=(m.contributes?.slots||[]).find(value=>value.id===slotEntry);
    if(!item)throw Error('Unknown slot view');
    html=registry.source(id,item.view);
  }else if(viewId){
    registry.permission(id,'panels');
    const panel=m.contributes?.panels?.find(value=>value.id===viewId);
    if(!panel||panel.builtinPage)throw Error('Unknown panel');
    html=registry.source(id,panel.entry);
  }else script=m.entry?registry.source(id,m.entry):'';
  if(viewId&&m.dshClient){
    const d=m.dshClient,css=[fs.readFileSync(path.join(assetsRoot,'dsh-client.css'),'utf8')];
    if(d.css)css.push(registry.source(id,d.css));
    html=inHead(html,'<style>'+css.join('\n').replace(/<\/style/gi,'<\\/style')+'</style>');
    script=[fs.readFileSync(path.join(assetsRoot,'dsh-client.js'),'utf8'),registry.source(id,d.entry),'window.ForgeDshClient.start('+JSON.stringify({packageName:d.packageName,version:m.version})+');'].join('\n;\n');
  }
  return {html,sdk:fs.readFileSync(path.join(__dirname,'forge-sdk.js'),'utf8'),script,networkOrigins:m.networkOrigins||[]};
}
function pluginResponse(registry,requestURL,options={}) {
  try {
    const url=new URL(requestURL);if(url.protocol!=='codex-forge:'||url.hostname!=='plugin')throw Error('Invalid plugin URL');
    const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==2&&parts.length!==3)throw Error('Invalid plugin resource');
    const [id,kind,slotEntry]=parts;
    if(parts.length===3&&kind!=='slot')throw Error('Invalid plugin resource');
    const bundle=pluginBundle(registry,id,{...options,...(slotEntry?{slotEntry}:kind!=='runtime'?{viewId:kind}:{})});
    let html=inHead(bundle.html,'<meta charset="utf-8">'+inlineScript(bundle.sdk));
    html+=inlineScript(bundle.script);
    const origins=bundle.networkOrigins.join(' ');
    const csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: "+origins+"; connect-src "+(origins||"'none'")+"; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors app://-";
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
module.exports={pluginBundle,pluginResponse,registerPluginProtocol};
