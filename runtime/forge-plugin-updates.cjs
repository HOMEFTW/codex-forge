'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check,validate}=require('./forge-manifest.cjs');
const {compare,compatibility,satisfies}=require('./forge-versions.cjs');
const {json,atomic}=require('./collaboration-store.cjs');
const {fetchJSON}=require('./forge-updates.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function source(value) {
  check(value&&['github','server'].includes(value.provider),'更新源需选择 github 或 server');
  if(value.provider==='github') check(/^[\w.-]+\/[\w.-]+$/.test(value.repository),'GitHub 仓库格式无效');
  else {const u=new URL(value.manifestUrl);check(u.protocol==='https:'&&!u.username&&!u.password,'私有更新清单必须为无凭据的 HTTPS 地址');}
  return value;
}
function allowedURL(value,update) {
  const u=new URL(value);check(u.protocol==='https:'&&!u.username&&!u.password,'更新地址必须为 HTTPS');
  if(update.provider==='github') check(u.hostname==='github.com'&&u.pathname.startsWith('/'+update.repository+'/releases/download/'),'更新文件不属于声明仓库');
  else check(u.origin===new URL(update.manifestUrl).origin,'更新文件必须属于声明服务器');
  return u.href;
}
function assess(registry,id,release) {
  const entry=registry.get(id,false);check(!entry.builtin,'内置插件随 Forge 更新');
  check(release.schemaVersion===1&&release.id===id,'插件更新身份不匹配');
  check(compare(release.version,entry.manifest.version)>0,'没有更高版本');
  const result=compatibility(release,registry.versions),reasons=[...result.reasons];
  for(const [dependency,range] of Object.entries(release.dependencies||{})) {
    const target=registry.entries.get(dependency);
    if(!target||!satisfies(target.manifest.version,range)||!registry.status(dependency).enabled)reasons.push('缺少已启用的兼容依赖：'+dependency);
  }
  // An upgrade must also satisfy plugins which depend on the current plugin.
  for(const p of registry.list().plugins.filter(p=>p.enabled)) if(p.dependencies?.[id]&&!satisfies(release.version,p.dependencies[id]))reasons.push('已启用插件 '+p.name+' 不接受此依赖版本');
  const visited=new Set(),visiting=new Set();
  const visit=key=>{if(visiting.has(key)){reasons.push('更新会形成循环依赖：'+key);return;}if(visited.has(key))return;visiting.add(key);const m=key===id?release:registry.entries.get(key)?.manifest;for(const dependency of Object.keys(m?.dependencies||{}))visit(dependency);visiting.delete(key);visited.add(key);};
  visit(id);
  return {compatible:reasons.length===0,reasons};
}
async function checkPluginUpdate(registry,id,readJSON=fetchJSON) {
  const entry=registry.get(id,false),update=source(entry.manifest.update);check(!entry.builtin,'内置插件随 Forge 更新');
  let manifestUrl=update.manifestUrl;
  if(update.provider==='github') {
    const release=await readJSON(`https://api.github.com/repos/${update.repository}/releases/latest`);
    check(!release.draft&&!release.prerelease,'仅接受正式插件发布');
    const asset=release.assets?.find(a=>a.name==='codex-forge-plugin-release.json');check(asset,'未找到插件更新清单');manifestUrl=allowedURL(asset.browser_download_url,update);
  }
  const release=await readJSON(manifestUrl);
  check(release.id===id&&release.schemaVersion===1,'插件更新身份不匹配');
  if(compare(release.version,entry.manifest.version)<=0)return {id,status:'up_to_date',checkedAt:new Date().toISOString()};
  allowedURL(release.url,update);check(/^[a-f0-9]{64}$/.test(release.sha256)&&Number.isSafeInteger(release.bytes)&&release.bytes>0&&release.bytes<=30*1024*1024,'插件更新摘要或大小无效');
  return {id,status:'available',release,source:JSON.parse(JSON.stringify(update)),...assess(registry,id,release),checkedAt:new Date().toISOString()};
}
async function stagePluginUpdate(registry,plan,fetcher=fetch) {
  check(plan?.release,'请先检查插件更新');
  const entry=registry.get(plan.id,false);check(JSON.stringify(entry.manifest.update)===JSON.stringify(plan.source),'更新源已变化，请重新检查');
  const match=assess(registry,plan.id,plan.release);check(match.compatible,match.reasons.join('；'));
  const response=await fetcher(allowedURL(plan.release.url,plan.source),{signal:AbortSignal.timeout(120000)});check(response.ok,'下载插件更新失败');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;check(size<=plan.release.bytes,'插件更新文件过大');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);check(bytes.length===plan.release.bytes&&hash(bytes)===plan.release.sha256,'插件更新摘要不符');
  const bundle=JSON.parse(bytes.toString('utf8'));check(bundle.schemaVersion===1&&Array.isArray(bundle.files)&&bundle.files.length<=1000,'插件包格式无效');
  const directory=path.join(registry.root,'pending',plan.id),staging=directory+'.'+crypto.randomUUID();fs.mkdirSync(staging,{recursive:true});let total=0;
  try {
    const names=new Set();
    for(const item of bundle.files){check(typeof item.path==='string'&&!/[\\:\x00-\x1f]/.test(item.path)&&!item.path.split('/').some(p=>!p||['.','..','.git','node_modules'].includes(p)),'插件包路径无效');const key=item.path.toLowerCase();check(!names.has(key),'插件包包含重复路径');names.add(key);check(item.encoding==='base64'&&typeof item.content==='string','插件资源必须为 base64');const content=Buffer.from(item.content,'base64');total+=content.length;check(total<=20*1024*1024,'解包内容超过20MB');const file=path.join(staging,item.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
    const manifest=validate(json(path.join(staging,'plugin.json')),staging);
    check(manifest.id===plan.id&&manifest.version===plan.release.version&&JSON.stringify(manifest.compatibility)===JSON.stringify(plan.release.compatibility)&&manifest.apiVersion===plan.release.apiVersion&&JSON.stringify(manifest.dependencies||{})===JSON.stringify(plan.release.dependencies||{}),'插件包与更新清单声明不一致');
    check(JSON.stringify(manifest.update)===JSON.stringify(plan.source),'更新不能静默更换来源');
    const verified=assess(registry,plan.id,{...manifest,schemaVersion:1});check(verified.compatible,verified.reasons.join('；'));
    const permissionsChanged=JSON.stringify([...manifest.permissions].sort())!==JSON.stringify([...entry.manifest.permissions].sort());
    if(fs.existsSync(directory))fs.rmSync(directory,{recursive:true,force:true});fs.renameSync(staging,directory);
    const queueFile=path.join(registry.root,'pending-updates.json'),queue=json(queueFile,{});
    const {fingerprint}=require('./forge-registry.cjs');
    // Record the exact package contents, then verify them again at startup.
    queue[plan.id]={fingerprint:fingerprint(directory),id:plan.id,version:manifest.version,files:bundle.files.map(i=>({path:i.path,sha256:hash(fs.readFileSync(path.join(directory,i.path)))})),permissionsChanged,wasEnabled:registry.status(plan.id).enabled};
    atomic(queueFile,queue);return {id:plan.id,version:manifest.version,restartRequired:true,permissionsChanged,message:'更新已准备好，请重启客户端生效。'+(permissionsChanged?'权限有变化，重启后需重新启用。':'')};
  } finally {if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
}
function pendingUpdates(registry){return json(path.join(registry.root,'pending-updates.json'),{});}
function applyPending(registry) {
  const queue=pendingUpdates(registry),results=[];
  for(const [id,item] of Object.entries(queue)){
    let backup,destination,moved=false;
    try{
      const entry=registry.get(id,false);check(!entry.builtin&&item.id===id,'更新目标无效');
      const requestedEnabled=registry.status(id).requestedEnabled;
      const directory=path.join(registry.root,'pending',id);const manifest=validate(json(path.join(directory,'plugin.json')),directory);check(manifest.id===id&&manifest.version===item.version,'暂存插件身份变化');
      check(require('./forge-registry.cjs').fingerprint(directory)===item.fingerprint,'暂存插件内容发生变化');
      const match=assess(registry,id,manifest);check(match.compatible,match.reasons.join('；'));
      for(const file of item.files){const {safeFile}=require('./forge-manifest.cjs');check(hash(fs.readFileSync(safeFile(directory,file.path)))===file.sha256,'暂存插件文件摘要变化');}
      destination=entry.root;backup=path.join(registry.root,'backups',id+'-'+crypto.randomUUID());fs.mkdirSync(path.dirname(backup),{recursive:true});fs.renameSync(destination,backup);moved=true;fs.renameSync(directory,destination);
      registry.reload();registry.setEnabled(id,requestedEnabled&&!item.permissionsChanged);moved=false;
      results.push({id,status:'installed',version:manifest.version,restartRequired:false,permissionsChanged:item.permissionsChanged});delete queue[id];
    }catch(error){if(moved){if(fs.existsSync(destination))fs.rmSync(destination,{recursive:true,force:true});fs.renameSync(backup,destination);registry.reload();}results.push({id,status:'failed',error:error.message});}
  }
  atomic(path.join(registry.root,'pending-updates.json'),queue);atomic(path.join(registry.root,'last-plugin-update.json'),results);return results;
}
module.exports={source,allowedURL,assess,checkPluginUpdate,stagePluginUpdate,pendingUpdates,applyPending};
