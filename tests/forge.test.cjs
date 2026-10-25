const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {satisfies,compatibility}=require('../runtime/forge-versions.cjs');
const {validate}=require('../runtime/forge-manifest.cjs');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs');
const updates=require('../runtime/forge-plugin-updates.cjs');
const {matchUpdate,checkUpdates,stageUpdate,launchUpdate}=require('../runtime/forge-updates.cjs');
const versions={codex:'26.1016.8622.0',forge:'0.1.0',apiVersion:1};
const base=()=>({schemaVersion:1,apiVersion:1,id:'test.example',name:'Example',version:'0.1.0',compatibility:{codex:['26.1016.8622.0'],forge:['>=0.1.0 <0.2.0']},permissions:['storage','settings'],contributes:{settings:{properties:{greeting:{title:'Greeting',type:'string',default:'hello'}}}},update:{provider:'server',manifestUrl:'https://plugins.example/release.json'}});
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(base()));const registry=new ForgeRegistry({root:path.join(root,'data'),bundledRoot:path.join(root,'empty'),versions});return {root,source,registry};}
function packagePlan(manifest){const contents=Buffer.from(JSON.stringify({schemaVersion:1,files:[{path:'plugin.json',encoding:'base64',content:Buffer.from(JSON.stringify(manifest)).toString('base64')}]}));const release={...manifest,url:'https://plugins.example/plugin.json',bytes:contents.length,sha256:crypto.createHash('sha256').update(contents).digest('hex')};return {contents,plan:{id:manifest.id,release,source:manifest.update,compatible:true},fetcher:async()=>new Response(contents)};}
test('compatibility validates all tokens and supports multiple Codex/Forge versions',()=>{
 assert(satisfies('26.1016.8622.0','>=26.1016.0.0 <26.1017.0.0'));assert(satisfies('0.1.9','^0.1.0'));assert(!satisfies('0.2.0','^0.1.0'));
 assert.throws(()=>satisfies('0.0.0','>1.0.0 invalid'));assert.throws(()=>satisfies('0.0.0','0.0.0 || invalid'));
 const m=base();m.compatibility.codex.unshift('26.999.0.0');assert(compatibility(m,versions).compatible);assert(!compatibility(m,{...versions,forge:'1.0.0'}).compatible);
});
test('plugin installation is disabled by default; settings persist and changed code requires review',t=>{
 const {source,registry}=setup(t);registry.install(source);assert.equal(registry.status('test.example').enabled,false);registry.setEnabled('test.example',true);assert(registry.status('test.example').enabled);registry.settings('test.example',{greeting:'kept'});registry.storage('test.example','set','a',{ok:true});assert.deepEqual(registry.storage('test.example','get','a'),{ok:true});
 fs.writeFileSync(path.join(registry.get('test.example').root,'changed.js'),'void 0');registry.reload();assert(!registry.status('test.example').enabled);registry.setEnabled('test.example',true);registry.uninstall('test.example');registry.install(source);assert.equal(registry.settings('test.example').greeting,'kept');
});
test('manifest rejects undeclared settings, reserved namespace, path escape and unreasoned expanded panels',t=>{
 const {source}=setup(t);const m=base();m.id='forge.impersonate';assert.throws(()=>validate(m,source),/保留/);m.id='test.example';m.entry='../main.js';assert.throws(()=>validate(m,source),/路径/);delete m.entry;m.permissions=[];assert.throws(()=>validate(m,source),/settings/);m.permissions=['panels','settings'];m.contributes.panels=[{id:'main',title:'Main',entry:'panel.html',placement:'expanded'}];assert.throws(()=>validate(m,source),/全宽/);
});
test('manifest accepts the DSH-inspired scoped events capability',t=>{
 const {source}=setup(t);const m=base();m.permissions.push('events');m.entry='main.js';m.contributes.events=[{name:'plugin.test.example.status'}];fs.writeFileSync(path.join(source,'main.js'),'void 0');fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(m));assert.equal(validate(JSON.parse(fs.readFileSync(path.join(source,'plugin.json'),'utf8')),source).permissions.includes('events'),true);m.contributes.events=[{name:'plugin.other.status'}];assert.throws(()=>validate(m,source),/事件必须属于本插件/);
});
test('permissions and dependency disablement propagate without deleting data',t=>{
 const {source,registry}=setup(t);registry.install(source);registry.setEnabled('test.example',true);assert.throws(()=>registry.permission('test.example','browser'),/未声明/);
 const m=base();m.id='test.dependent';m.dependencies={'test.example':'^0.1.0'};fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(m));registry.install(source);registry.setEnabled(m.id,true);assert(registry.status(m.id).enabled);registry.setEnabled('test.example',false);assert(!registry.status(m.id).enabled);
});
test('plugin update compatibility blocks before downloading for client, Forge, API and reverse dependencies',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);
 for(const change of [{compatibility:{codex:['99.0.0.0'],forge:['^0.1.0']}},{compatibility:{codex:['26.1016.8622.0'],forge:['^3.0.0']}},{apiVersion:2}]){const m={...base(),version:'0.1.1',...change},pack=packagePlan(m);let fetched=false;await assert.rejects(updates.stagePluginUpdate(registry,pack.plan,async()=>{fetched=true;return new Response(pack.contents);}));assert(!fetched);}
 const dependent={...base(),id:'test.dependent',dependencies:{'test.example':'0.1.0'}};fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(dependent));registry.install(source);registry.setEnabled(dependent.id,true);assert(!updates.assess(registry,'test.example',{...base(),version:'0.1.1'}).compatible);
});
test('validated plugin update remains pending until restart and preserves settings',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);registry.settings('test.example',{greeting:'persistent'});const pack=packagePlan({...base(),version:'0.1.1'});
 const result=await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);assert(result.restartRequired);assert.equal(registry.get('test.example').manifest.version,'0.1.0');assert.equal(updates.applyPending(registry)[0].status,'installed');assert.equal(registry.get('test.example').manifest.version,'0.1.1');assert.equal(registry.settings('test.example').greeting,'persistent');
});

test('restart rechecks host compatibility and keeps the installed plugin on mismatch',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);
 const pack=packagePlan({...base(),version:'0.1.1'});await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);
 registry.versions={...versions,codex:'26.9999.0.0'};
 assert.equal(updates.applyPending(registry)[0].status,'failed');
 assert.equal(registry.get('test.example',false).manifest.version,'0.1.0');
 assert.equal(updates.pendingUpdates(registry)['test.example'].version,'0.1.1');
});

test('update rejects a new dependency cycle before download and respects later user disablement',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);
 const dependent={...base(),id:'test.dependent',dependencies:{'test.example':'^0.1.0'}};fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(dependent));registry.install(source);registry.setEnabled(dependent.id,true);
 const cycle=packagePlan({...base(),version:'0.1.1',dependencies:{'test.dependent':'^0.1.0'}});let fetched=false;
 await assert.rejects(updates.stagePluginUpdate(registry,cycle.plan,async()=>{fetched=true;return new Response(cycle.contents);}),/循环依赖/);assert(!fetched);
 registry.setEnabled(dependent.id,false);
 const pack=packagePlan({...base(),version:'0.1.1'});await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);registry.setEnabled('test.example',false);
 assert.equal(updates.applyPending(registry)[0].status,'installed');assert(!registry.status('test.example').requestedEnabled);
});

test('plugin protocol isolates scripts, restricts network and denies inactive or unknown resources',async t=>{
 const {registry,source}=setup(t),m=base();m.entry='main.js';m.permissions.push('network');m.networkOrigins=['https://plugins.example'];
 fs.writeFileSync(path.join(source,'main.js'),'window.exampleLoaded = true;');fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(m));registry.install(source);
 const {pluginResponse}=require('../runtime/forge-content.cjs'),url='codex-forge://plugin/test.example/runtime';
 assert.equal(pluginResponse(registry,url).status,404);registry.setEnabled(m.id,true);
 const response=pluginResponse(registry,url),body=await response.text(),policy=response.headers.get('content-security-policy');
 assert.equal(response.status,200);assert(body.includes('window.exampleLoaded = true'));assert(body.includes('CodexForge'));
 assert(policy.includes("default-src 'none'"));assert(policy.includes('connect-src https://plugins.example'));assert(policy.includes("frame-src 'none'"));assert(policy.includes('frame-ancestors app://-'));
 for(const invalid of ['codex-forge://other/test.example/runtime','codex-forge://plugin/test.missing/runtime','codex-forge://plugin/test.example/unknown','codex-forge://plugin/test.example/runtime/extra'])assert.equal(pluginResponse(registry,invalid).status,404);
 registry.setEnabled(m.id,false);assert.equal(pluginResponse(registry,url).status,404);
});
test('downloaded metadata mismatch, corrupted archive and post-stage tampering do not replace installed plugin',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);const pack=packagePlan({...base(),version:'0.1.1'});
 await assert.rejects(updates.stagePluginUpdate(registry,pack.plan,async()=>new Response('corrupt')),/摘要/);
 const mismatch=packagePlan({...base(),version:'0.1.1',compatibility:{codex:['99.0.0.0'],forge:['^0.1.0']}});mismatch.plan.release.compatibility=base().compatibility;await assert.rejects(updates.stagePluginUpdate(registry,mismatch.plan,mismatch.fetcher),/不一致/);
 await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);fs.writeFileSync(path.join(registry.root,'pending/test.example/injected.js'),'bad');assert.equal(updates.applyPending(registry)[0].status,'failed');assert.equal(registry.get('test.example').manifest.version,'0.1.0');
});
test('new permissions require re-enabling and uninstall cancels queued updates',async t=>{
 const {registry,source}=setup(t);registry.install(source);registry.setEnabled('test.example',true);const pack=packagePlan({...base(),version:'0.1.1',permissions:['storage','settings','browser']});await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);updates.applyPending(registry);assert(!registry.status('test.example').enabled);
 registry.uninstall('test.example');registry.install(source);await updates.stagePluginUpdate(registry,pack.plan,pack.fetcher);registry.uninstall('test.example');assert.deepEqual(updates.pendingUpdates(registry),{});assert.deepEqual(updates.applyPending(registry),[]);
});
test('GitHub and private server sources validate origin and perform release discovery',async t=>{
 const {source,registry}=setup(t);const m=base();m.update={provider:'github',repository:'test/plugins'};fs.writeFileSync(path.join(source,'plugin.json'),JSON.stringify(m));registry.install(source);const release={...m,version:'0.1.1',url:'https://github.com/test/plugins/releases/download/v1/plugin.json',sha256:'a'.repeat(64),bytes:100};
 const seen=[];const plan=await updates.checkPluginUpdate(registry,m.id,async url=>{seen.push(url);return url.includes('api.github')?{assets:[{name:'codex-forge-plugin-release.json',browser_download_url:'https://github.com/test/plugins/releases/download/v1/release.json'}]}:release;});assert(plan.compatible);assert.equal(seen.length,2);assert.throws(()=>updates.allowedURL('https://other.example/a',m.update));assert.throws(()=>updates.source({provider:'server',manifestUrl:'http://private.example/a'}));
});
test('Forge update matching uses the official build version separately from MSIX identity',()=>{
 const config={version:'0.1.0',codexVersion:'26.1021.2667.0',codexBuildVersion:'26.1021.3705.0'};
 const baseRelease={schemaVersion:3,platform:'win32-x64',apiVersion:1,forgeVersion:'0.1.1',codexVersion:'26.1021.2667.0',codexBuildVersion:'26.1021.4000.0',repository:'test/forge',url:'https://github.com/test/forge/releases/download/v0.1.1/Setup.msi',sha256:'c'.repeat(64),bytes:10,portableUrl:'https://github.com/test/forge/releases/download/v0.1.1/Setup-Portable.zip',portableSha256:'e'.repeat(64),portableBytes:10,distribution:'msi-portable',containsOfficialClient:false};
 assert(matchUpdate({config,plugins:[],releases:[baseRelease],native:{buildVersion:'26.1021.4000.0'}}).plan);
 const ahead={...baseRelease,codexBuildVersion:'26.1021.4100.0'};
 const assessed=matchUpdate({config,plugins:[],releases:[ahead],native:{buildVersion:'26.1021.4000.0'}});
 assert.equal(assessed.plan,null); assert.match(assessed.candidates[0].reasons.join('；'),/官方更新源/);
});
test('Forge updater stages a verified MSI and records its receipt',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-msi-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const body=Buffer.from('verified-msi-fixture');
 const plan={schemaVersion:3,platform:'win32-x64',apiVersion:1,forgeVersion:'0.1.1',codexVersion:'26.1021.2667.0',codexBuildVersion:'26.1021.4000.0',repository:'test/forge',url:'https://github.com/test/forge/releases/download/v0.1.1/Setup.msi',sha256:crypto.createHash('sha256').update(body).digest('hex'),bytes:body.length,portableUrl:'https://github.com/test/forge/releases/download/v0.1.1/Setup-Portable.zip',portableSha256:'e'.repeat(64),portableBytes:10,distribution:'msi-portable',containsOfficialClient:false,compatible:true};
 const receipt=await stageUpdate(plan,root,async()=>new Response(body));
 assert.match(receipt.file,/\.msi$/);assert.equal(fs.statSync(receipt.file).size,body.length);assert.equal(JSON.parse(fs.readFileSync(receipt.file+'.json','utf8')).sha256,plan.sha256);
 await assert.rejects(stageUpdate({...plan,sha256:'0'.repeat(64)},path.join(root,'bad'),async()=>new Response(body)),/摘要/);
});
test('Forge updater launches from the versioned payload root',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-launch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const installer=path.join(root,'update.msi'),sha256=crypto.createHash('sha256').update('fixture').digest('hex');
 fs.writeFileSync(installer,'fixture');fs.writeFileSync(path.join(root,'forge-payload.json'),'{}');fs.writeFileSync(installer+'.json',JSON.stringify({file:installer,sha256}));
 let invocation;
 const result=launchUpdate({file:installer,sha256},root,undefined,(file,args,options)=>{invocation={file,args,options};return {unref(){}}});
 assert.equal(result.scheduled,true);assert.deepEqual(invocation.args,['/i',installer,'/passive','/norestart']);assert.equal(invocation.file,'msiexec.exe');
 assert.throws(()=>launchUpdate({file:installer,sha256},path.join(root,'missing'),undefined,()=>({unref(){}})),/已安装/);
});
test('Forge update check cannot approve a newer build when the official feed is unavailable',async()=>{
 const config={version:'0.1.0',codexVersion:'26.1021.2667.0',codexBuildVersion:'26.1021.3705.0',githubRepository:'test/forge'};
 const release={schemaVersion:3,platform:'win32-x64',apiVersion:1,forgeVersion:'0.1.1',codexVersion:'26.1021.2667.0',codexBuildVersion:'26.1021.4000.0',repository:'test/forge',url:'https://github.com/test/forge/releases/download/v0.1.1/Setup.msi',sha256:'d'.repeat(64),bytes:10,portableUrl:'https://github.com/test/forge/releases/download/v0.1.1/Setup-Portable.zip',portableSha256:'e'.repeat(64),portableBytes:10,distribution:'msi-portable',containsOfficialClient:false};
 const result=await checkUpdates({config,plugins:[],readJSON:async url=>{if(url.includes('oaistatic'))throw Error('offline');if(url.includes('api.github'))return [{assets:[{name:'codex-forge-release.json',browser_download_url:'https://github.com/test/forge/releases/download/v0.1.1/manifest.json'}]}];return release;}});
 assert.equal(result.plan,null); assert.equal(result.native.status,'unavailable');
});
test('Forge matching checks third party ranges and failed official feed cannot approve a new client',async()=>{
 const config={version:'0.1.0',codexVersion:versions.codex,githubRepository:'test/forge'};
 const release={schemaVersion:3,platform:'win32-x64',apiVersion:1,forgeVersion:'0.1.1',codexVersion:'26.1017.1.0',repository:'test/forge',url:'https://github.com/test/forge/releases/download/v0.1.1/Setup.msi',sha256:'a'.repeat(64),bytes:10,portableUrl:'https://github.com/test/forge/releases/download/v0.1.1/Setup-Portable.zip',portableSha256:'e'.repeat(64),portableBytes:10,distribution:'msi-portable',containsOfficialClient:false};
 assert(!matchUpdate({config,plugins:[{...base(),enabled:true}],releases:[release],native:{buildVersion:release.codexVersion}}).plan);
 assert(matchUpdate({config,plugins:[{...base(),builtin:true}],releases:[release],native:{buildVersion:release.codexVersion}}).plan);
 const {recheckPlan}=require('../runtime/forge-updates.cjs');
 assert.throws(()=>recheckPlan({...release,compatible:true},{config,plugins:[base()],native:{version:release.codexVersion}}),/Example/);
 assert(recheckPlan({...release,compatible:true},{config,plugins:[],native:{version:release.codexVersion}}));
 const result=await checkUpdates({config,plugins:[],readJSON:async url=>{if(url.includes('oaistatic'))throw Error('offline');if(url.includes('api.github'))return [{assets:[{name:'codex-forge-release.json',browser_download_url:'https://github.com/test/forge/releases/download/v0.1.1/manifest.json'}]}];return release;}});assert.equal(result.plan,null);assert.equal(result.native.status,'unavailable');
});
test('Forge update check falls back from GitHub API 403 to the public latest manifest', async () => {
 const config={version:'0.1.0',codexVersion:versions.codex,githubRepository:'test/forge',channel:'stable'};
 const release={schemaVersion:3,platform:'win32-x64',apiVersion:1,forgeVersion:'0.1.1',codexVersion:versions.codex,repository:'test/forge',url:'https://github.com/test/forge/releases/download/v0.1.1/Setup.msi',sha256:'b'.repeat(64),bytes:10,portableUrl:'https://github.com/test/forge/releases/download/v0.1.1/Setup-Portable.zip',portableSha256:'e'.repeat(64),portableBytes:10,distribution:'msi-portable',containsOfficialClient:false};
 const seen=[];
 const result=await checkUpdates({config,plugins:[],readJSON:async url=>{
   seen.push(url);
   if(url.includes('oaistatic')) return {schemaVersion:1,packageIdentity:'OpenAI.Codex',storeProductId:'9PLM9XGG6VKS',buildVersion:versions.codex};
   if(url.includes('api.github.com')) throw Error('更新源 HTTP 403（GitHub API 限流或拒绝匿名请求）');
   assert.match(url,/github\.com\/test\/forge\/releases\/latest\/download\/codex-forge-release\.json$/);
   return release;
 }});
 assert.equal(result.forge.source,'github-latest-manifest'); assert.equal(result.forge.warning.includes('403'),true);
 assert.equal(result.plan.forgeVersion,'0.1.1'); assert.equal(seen.length,3);
});
