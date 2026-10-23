// Isolated UI fixture: no network and no access to the user's Forge profile.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const {stagePluginUpdate}=require('../runtime/forge-plugin-updates.cjs');
const profile=path.resolve(__dirname,'../output/native-forge'),source=path.join(profile,'update-source');
const manifest={schemaVersion:1,apiVersion:1,id:'example.update',name:'Update Fixture',version:'0.1.0',compatibility:{codex:['26.1016.8622.0'],forge:['^0.1.0']},permissions:['settings'],contributes:{settings:{properties:{greeting:{type:'string',title:'Greeting',default:'fixture'}}}},update:{provider:'server',manifestUrl:'https://fixture.invalid/release.json'}};
fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(manifest));
const registry=new ForgeRegistry({root:path.join(profile,'codex-home/forge'),bundledRoot:path.resolve(__dirname,'../plugins'),versions:{codex:'26.1016.8622.0',forge:'0.1.0',apiVersion:1}});
registry.install(source);registry.setEnabled(manifest.id,true);registry.settings(manifest.id,{greeting:'Preserved through restart'});
const next={...manifest,version:'0.1.1'},bytes=Buffer.from(JSON.stringify({schemaVersion:1,files:[{path:'plugin.json',encoding:'base64',content:Buffer.from(JSON.stringify(next)).toString('base64')}]}));
const plan={id:manifest.id,source:manifest.update,release:{...next,url:'https://fixture.invalid/plugin.json',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
stagePluginUpdate(registry,plan,async()=>new Response(bytes)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
