'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { compare, compatibility } = require('./forge-versions.cjs');
const { check } = require('./forge-manifest.cjs');
const { atomic, json } = require('./collaboration-store.cjs');
const nativeFeed = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json';
const blockedVersions = new Set(['26.1013.4894.0']);
async function fetchJSON(url, { limit = 2*1024*1024 } = {}) {
  const response = await fetch(url, { headers: { Accept:'application/json','User-Agent':'Codex-Forge/0.1.0' }, signal:AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`更新源 HTTP ${response.status}${response.status === 404 ? '（私有仓库或尚未发布版本）' : ''}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; check(size <= limit,'更新清单过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validateRelease(value, repository) {
  check(value.schemaVersion === 2 && value.platform === 'win32-x64' && value.apiVersion === 1, '发布清单格式不兼容');
  compare(value.forgeVersion,'0.0.0'); compare(value.codexVersion,'0.0.0'); check(!blockedVersions.has(value.codexVersion),'被禁止的客户端版本');
  check(value.repository === repository && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 256*1024*1024,'发布清单身份或摘要无效');
  const url = new URL(value.url); check(url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/'+repository+'/releases/download/') && !url.username && !url.password,'下载地址不属于配置仓库');
  check(value.distribution === 'forge-bootstrap' && value.containsOfficialClient === false && url.pathname.endsWith('.exe'), '更新必须使用不包含官方客户端的 Forge 安装器'); return value;
}
function matchUpdate({ config, plugins, releases, native }) {
  const assessed = releases.map(release => {
    const reasons = [];
    if (compare(release.codexVersion,config.codexVersion)<0 || compare(release.forgeVersion,config.version)<0) reasons.push('不自动降级客户端或 Forge');
    if (native?.buildVersion && compare(release.codexVersion,native.buildVersion)>0) reasons.push('客户端版本高于官方更新源');
    for (const plugin of plugins.filter(p=>!p.builtin)) { const result = compatibility(plugin,{codex:release.codexVersion,forge:release.forgeVersion,apiVersion:release.apiVersion}); if (!result.compatible) reasons.push(plugin.name+'：'+result.reasons.join('；')); }
    return {...release,compatible:!reasons.length,reasons};
  }).sort((a,b)=>compare(b.codexVersion,a.codexVersion)||compare(b.forgeVersion,a.forgeVersion));
  const plan = assessed.find(r=>r.compatible&&(compare(r.forgeVersion,config.version)>0||compare(r.codexVersion,config.codexVersion)>0)) || null;
  return {plan,candidates:assessed,requiresFullReinstallFromR:true};
}
async function checkUpdates({config,plugins,readJSON=fetchJSON}) {
  const repository = config.repository || config.githubRepository;
  const results = await Promise.allSettled([
    readJSON(nativeFeed).then(value=>{check(value.schemaVersion===1&&value.packageIdentity==='OpenAI.Codex'&&value.storeProductId==='9PLM9XGG6VKS','官方更新源产品身份不符');compare(value.buildVersion,config.codexVersion);return value;}),
    (async()=>{
      if (!repository) return [];
      check(/^[\w.-]+\/[\w.-]+$/.test(repository),'更新仓库无效');
      const releases = await readJSON(`https://api.github.com/repos/${repository}/releases?per_page=20`);
      check(Array.isArray(releases),'GitHub 发布列表无效'); const manifests = [];
      for (const release of releases.filter(r=>!r.draft&&(config.channel==='preview'||!r.prerelease)).slice(0,10)) {
        const asset = release.assets?.find(a=>a.name==='codex-forge-release.json'); if (!asset) continue;
        const assetURL = new URL(asset.browser_download_url);
        check(assetURL.protocol==='https:'&&assetURL.hostname==='github.com'&&assetURL.pathname.startsWith('/'+repository+'/releases/download/'),'发布清单地址不属于仓库');
        manifests.push(validateRelease(await readJSON(assetURL.href),repository));
      }
      return manifests;
    })()
  ]);
  const native = results[0].status==='fulfilled'?results[0].value:null, releases=results[1].status==='fulfilled'?results[1].value:[];
  const match=matchUpdate({config,plugins,releases,native});
  // A failed native lookup cannot establish that a new bundled Codex is official.
  if (!native && match.plan && match.plan.codexVersion !== config.codexVersion) { match.plan=null; }
  return {...match,checkedAt:new Date().toISOString(),repository,native:native?{status:blockedVersions.has(native.buildVersion)?'blocked':compare(native.buildVersion,config.codexVersion)>0?'available':'up_to_date',version:native.buildVersion,feed:nativeFeed}:{status:'unavailable',error:results[0].reason.message},forge:results[1].status==='fulfilled'?{status:releases.length?'checked':'no_release',releases:releases.length}:{status:'unavailable',error:results[1].reason.message}};
}
async function stageUpdate(plan, directory, fetcher=fetch) {
  validateRelease(plan,plan.repository); check(plan.compatible,'版本或插件不匹配'); fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`codex-forge-${plan.forgeVersion}-${plan.codexVersion}.exe`), temporary=file+'.partial';
  const response=await fetcher(plan.url,{signal:AbortSignal.timeout(30*60*1000)});check(response.ok,'下载失败');
  const fd=fs.openSync(temporary,'wx'), hash=crypto.createHash('sha256');let bytes=0;
  try { for await (const chunk of response.body) { bytes+=chunk.length;check(bytes<=plan.bytes,'下载大小超出清单');fs.writeSync(fd,chunk);hash.update(chunk); } fs.fsyncSync(fd); }
  catch(error){fs.closeSync(fd);fs.rmSync(temporary,{force:true});throw error;}
  fs.closeSync(fd);if(bytes!==plan.bytes||hash.digest('hex')!==plan.sha256){fs.rmSync(temporary,{force:true});throw Error('下载摘要不一致');}fs.renameSync(temporary,file);
  const receipt={...plan,file,verifiedAt:new Date().toISOString()};atomic(file+'.json',receipt);return receipt;
}
function recheckPlan(plan,{config,plugins,native}) {
  check(plan,'请先检查匹配更新');validateRelease(plan,config.repository||config.githubRepository);
  check(native?.version||plan.codexVersion===config.codexVersion,'官方版本未确认，请重新检查更新');
  const result=matchUpdate({config,plugins,releases:[plan],native:{buildVersion:native?.version}});
  check(result.plan,result.candidates[0]?.reasons.join('；')||'更新计划已过期，请重新检查');return result.plan;
}
function launchUpdate(staged, installRoot, executable) {
  check(installRoot&&fs.existsSync(path.join(installRoot,'forge-install.json')),'请从已安装的 Codex Forge 启动');
  const receipt=json(staged.file+'.json');check(receipt.sha256===staged.sha256&&receipt.file===staged.file,'下载记录不匹配');
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'apply-update.ps1'),'-Installer',staged.file,'-ExpectedHash',staged.sha256,'-InstallRoot',installRoot],{windowsHide:true,detached:true,stdio:'ignore',shell:false});child.unref();
  return {scheduled:true,restartRequired:true,message:'正在打开 Forge 安装向导；安装后下载适配的官方客户端。完成后请退出当前客户端并重新启动。'};
}
module.exports={nativeFeed,fetchJSON,validateRelease,matchUpdate,checkUpdates,stageUpdate,recheckPlan,launchUpdate};
