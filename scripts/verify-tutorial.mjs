import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),text=fs.readFileSync(path.join(root,'docs/PLUGIN-DEVELOPMENT-ZERO-TO-ONE.md'),'utf8');
const fixture=fs.mkdtempSync(path.join(root,'output/tutorial-')),plugin=path.join(fixture,'plugin'),home=path.join(fixture,'data');
const cli=(...args)=>{const r=spawnSync(process.execPath,[path.join(root,'cli/forge.mjs'),...args,'--home',home],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
cli('create',plugin);
for(const [language,file] of [['json','plugin.json'],['javascript','main.js'],['html','panel.html']]){const block=text.match(new RegExp('```'+language+'\\r?\\n([\\s\\S]*?)```'))?.[1];assert(block);fs.writeFileSync(path.join(plugin,file),block);}
const validated=cli('validate',plugin);assert(validated.compatible);const id=validated.manifest.id;cli('install',plugin);cli('enable',id);
const settingsFile=path.join(fixture,'settings.json');fs.writeFileSync(settingsFile,JSON.stringify({greeting:'Tutorial verified'}));cli('settings',id,settingsFile);assert.equal(cli('settings',id).greeting,'Tutorial verified');
const packed=cli('pack',plugin,path.join(fixture,'plugin.forge-plugin.json'));assert.equal(packed.id,id);
let handler,inserted,output,stored=0;
vm.runInNewContext(fs.readFileSync(path.join(plugin,'main.js'),'utf8'),{window:{CodexForge:{commands:{register:(_id,fn)=>{handler=fn;return ()=>{};}},events:{on(){}},settings:{get:async()=>({greeting:'Tutorial verified'})},composer:{read:async()=>({text:'draft'}),insertText:async(text,expected)=>{assert.equal(expected,'draft');inserted=text;}},output:{append:async text=>{output=text;}},storage:{get:async()=>stored,set:async(_k,value)=>{stored=value;}}}}});
await handler();assert.equal(inserted,'Tutorial verified');assert.equal(output,inserted);assert.equal(stored,1);cli('disable',id);cli('uninstall',id);
console.log(JSON.stringify({create:true,validate:true,install:true,settings:true,command:true,pack:true,uninstall:true}));
