'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { compare, compatibility } = require('./forge-versions.cjs');
const { check } = require('./forge-manifest.cjs');
const { atomic, json } = require('./collaboration-store.cjs');
const nativeFeed = 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json';
const blockedVersions = new Set(['26.1013.4894.0']);
async function fetchJSON(url, { limit = 2*1024*1024 } = {}) {
  const response = await fetch(url, { headers: { Accept:'application/json','User-Agent':'Codex-Forge/0.3.1' }, signal:AbortSignal.timeout(20000) });
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    throw Error(`更新源 HTTP ${response.status}${response.status === 403 ? '（GitHub API 限流或拒绝匿名请求）' : response.status === 404 ? '（私有仓库或尚未发布版本）' : ''}${retry ? `；Retry-After ${retry}` : ''}`);
  }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; check(size <= limit,'更新清单过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function rateLimited(error) { return /HTTP (?:403|429)|限流|rate.?limit|forbidden|拒绝匿名/i.test(String(error?.message || error)); }
async function githubReleaseManifests(repository, config, readJSON) {
  const apiURL = `https://api.github.com/repos/${repository}/releases?per_page=20`;
  try {
    const releases = await readJSON(apiURL);
    check(Array.isArray(releases), 'GitHub 发布列表无效');
    const manifests = [];
    for (const release of releases.filter(r=>!r.draft&&(config.channel==='preview'||!r.prerelease)).slice(0,10)) {
      const asset = release.assets?.find(a=>a.name==='codex-forge-release.json'); if (!asset) continue;
      const assetURL = new URL(asset.browser_download_url);
      check(assetURL.protocol==='https:'&&assetURL.hostname==='github.com'&&assetURL.pathname.startsWith('/'+repository+'/releases/download/'),'发布清单地址不属于仓库');
      manifests.push(validateRelease(await readJSON(assetURL.href),repository));
    }
    return { releases: manifests, source: 'github-api' };
  } catch (error) {
    if (!rateLimited(error)) throw error;
    // GitHub's unauthenticated Releases API is rate limited independently of
    // public release assets. The latest-download endpoint is CDN backed and
    // keeps update checks useful without putting credentials in the client.
    const latestURL = `https://github.com/${repository}/releases/latest/download/codex-forge-release.json`;
    const manifest = validateRelease(await readJSON(latestURL), repository);
    return { releases: [manifest], source: 'github-latest-manifest', warning: 'GitHub Releases API 返回 403，已改用公开的最新发布清单；若要选择预览版，请稍后重试。' };
  }
}
function releaseBuildVersion(value) { return value.codexBuildVersion || value.codexVersion; }
function validateRelease(value, repository) {
  check(value.schemaVersion === 3 && value.platform === 'win32-x64' && [1, 2].includes(value.apiVersion), '发布清单格式不兼容');
  compare(value.forgeVersion,'0.0.0'); compare(value.codexVersion,'0.0.0'); compare(releaseBuildVersion(value),'0.0.0'); check(!blockedVersions.has(value.codexVersion) && !blockedVersions.has(releaseBuildVersion(value)),'被禁止的客户端版本');
  check(value.repository === repository && value.distribution === 'msi-portable' && value.containsOfficialClient === false && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 256*1024*1024 && /^[a-f0-9]{64}$/.test(value.portableSha256) && Number.isSafeInteger(value.portableBytes) && value.portableBytes > 0 && value.portableBytes <= 256*1024*1024,'发布清单身份或摘要无效');
  const url = new URL(value.url); check(url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/'+repository+'/releases/download/') && !url.username && !url.password,'下载地址不属于配置仓库');
  const portableURL = new URL(value.portableUrl); check(portableURL.protocol === 'https:' && portableURL.hostname === 'github.com' && portableURL.pathname.startsWith('/'+repository+'/releases/download/') && !portableURL.username && !portableURL.password,'便携包地址不属于配置仓库');
  check(url.pathname.endsWith('.msi') && portableURL.pathname.endsWith('.zip'),'更新必须使用 MSI 安装器和便携 ZIP'); return value;
}
function matchUpdate({ config, plugins, releases, native }) {
  const assessed = releases.map(release => {
    const reasons = [];
    if (compare(release.codexVersion,config.codexVersion)<0 || compare(releaseBuildVersion(release),config.codexBuildVersion || config.codexVersion)<0 || compare(release.forgeVersion,config.version)<0) reasons.push('不自动降级客户端或 Forge');
    if (native?.buildVersion && compare(releaseBuildVersion(release),native.buildVersion)>0) reasons.push('客户端版本高于官方更新源');
    for (const plugin of plugins.filter(p=>!p.builtin)) { const result = compatibility(plugin,{codex:release.codexVersion,forge:release.forgeVersion,apiVersion:release.apiVersion}); if (!result.compatible) reasons.push(plugin.name+'：'+result.reasons.join('；')); }
    return {...release,compatible:!reasons.length,reasons};
  }).sort((a,b)=>compare(b.codexVersion,a.codexVersion)||compare(b.forgeVersion,a.forgeVersion));
  const currentBuild = config.codexBuildVersion || config.codexVersion;
  const plan = assessed.find(r=>r.compatible&&(compare(r.forgeVersion,config.version)>0||compare(r.codexVersion,config.codexVersion)>0||compare(releaseBuildVersion(r),currentBuild)>0)) || null;
  return {plan,candidates:assessed,requiresFullReinstallFromR:true};
}
async function checkUpdates({config,plugins,readJSON=fetchJSON}) {
  const repository = config.repository || config.githubRepository;
  const results = await Promise.allSettled([
    readJSON(nativeFeed).then(value=>{check(value.schemaVersion===1&&value.packageIdentity==='OpenAI.Codex'&&value.storeProductId==='9PLM9XGG6VKS','官方更新源产品身份不符');compare(value.buildVersion,config.codexBuildVersion||config.codexVersion);return value;}),
    (async()=>{
      if (!repository) return [];
      check(/^[\w.-]+\/[\w.-]+$/.test(repository),'更新仓库无效');
      return githubReleaseManifests(repository, config, readJSON);
    })()
  ]);
  const native = results[0].status==='fulfilled'?results[0].value:null;
  const forgeResult = results[1].status==='fulfilled' ? (Array.isArray(results[1].value) ? { releases: results[1].value, source: 'github-api' } : results[1].value) : null;
  const releases = forgeResult?.releases || [];
  const match=matchUpdate({config,plugins,releases,native});
  // A failed native lookup cannot establish that a new bundled Codex is official.
  if (!native && match.plan && (match.plan.codexVersion !== config.codexVersion || releaseBuildVersion(match.plan) !== (config.codexBuildVersion || config.codexVersion))) { match.plan=null; }
  return {...match,checkedAt:new Date().toISOString(),repository,native:native?{status:blockedVersions.has(native.buildVersion)?'blocked':compare(native.buildVersion,config.codexBuildVersion||config.codexVersion)>0?'available':'up_to_date',version:native.buildVersion,feed:nativeFeed}:{status:'unavailable',error:results[0].reason.message},forge:results[1].status==='fulfilled'?{status:releases.length?'checked':'no_release',releases:releases.length,source:forgeResult?.source,warning:forgeResult?.warning}:{status:'unavailable',error:results[1].reason.message}};
}
async function stageUpdate(plan, directory, fetcher=fetch) {
  validateRelease(plan,plan.repository); check(plan.compatible,'版本或插件不匹配'); fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`codex-forge-${plan.forgeVersion}-${plan.codexVersion}.msi`), temporary=file+'.partial';
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
function launchUpdate(staged, installRoot, executable, spawnProcess=spawn) {
  check(installRoot&&fs.existsSync(path.join(installRoot,'forge-payload.json')),'请从已安装的 Codex Forge 启动');
  const receipt=json(staged.file+'.json');check(receipt.sha256===staged.sha256&&receipt.file===staged.file,'下载记录不匹配');
  // Windows Installer is handed the file directly, so re-hash the staged bytes
  // immediately before launching. The download receipt alone cannot prove the
  // file on disk was not replaced after staging.
  let verified;
  try { verified=crypto.createHash('sha256').update(fs.readFileSync(staged.file)).digest('hex'); }
  catch(error) { throw Error('升级包不可读：'+error.message); }
  check(verified===staged.sha256,'升级包 SHA-256 已变化，请重新下载');
  const child=spawnProcess('msiexec.exe',['/i',staged.file,'/passive','/norestart'],{windowsHide:true,detached:true,stdio:'ignore',shell:false});child.unref();
  return {scheduled:true,restartRequired:true,message:'正在打开 Windows Installer 更新；完成后请退出当前客户端并重新启动。'};
}
module.exports={nativeFeed,fetchJSON,validateRelease,matchUpdate,checkUpdates,stageUpdate,recheckPlan,launchUpdate,githubReleaseManifests,rateLimited,releaseBuildVersion};
