'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic,json}=require('./collaboration-store.cjs');
const {check,validate,compatibility}=require('./forge-manifest.cjs');
const updates=require('./forge-plugin-updates.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
class ForgeMarketplace {
  constructor({registry,root=registry.root,fetchImpl=globalThis.fetch,bundledCatalog=fs.existsSync(path.join(__dirname,'marketplace/catalog.json'))?path.join(__dirname,'marketplace/catalog.json'):path.join(__dirname,'../marketplace/catalog.json')}={}){this.registry=registry;this.root=root;this.fetchImpl=fetchImpl;this.bundledCatalog=bundledCatalog;this.cache=new Map();}
  sources(){return json(path.join(this.root,'marketplaces.json'),{sources:[]}).sources;}
  setSources(sources){check(Array.isArray(sources)&&sources.length<=20,'市场来源最多 20 个');const seen=new Set();for(const source of sources){check(source&&typeof source.id==='string'&&/^[\w.-]{1,80}$/.test(source.id)&&!seen.has(source.id),'市场来源 ID 无效或重复');seen.add(source.id);const url=new URL(source.url);check(url.protocol==='https:'&&!url.username&&!url.password,'市场来源必须是无凭据 HTTPS 地址');}atomic(path.join(this.root,'marketplaces.json'),{sources});this.cache.clear();return this.sources();}
  async bytes(url,{signal,maxBytes=8*1024*1024,revalidate=()=>{}}={}){
    const original=new URL(url);let current=original,response;
    for(let hop=0;hop<6;hop++){
      signal?.throwIfAborted();revalidate();check(current.protocol==='https:'&&!current.username&&!current.password,'市场请求必须使用无凭据 HTTPS 地址');
      check(current.origin===original.origin||original.hostname==='github.com'&&['release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(current.hostname),'市场重定向越出声明来源');
      response=await this.fetchImpl(current.href,{signal,redirect:'manual'});
      if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();check(response.headers.get('location'),'市场重定向缺少地址');current=new URL(response.headers.get('location'),current);continue;}
      check(response.ok,'市场下载失败：HTTP '+response.status);break;
    }
    check(response?.ok,'市场重定向次数过多');const chunks=[];let bytes=0;for await(const chunk of response.body){signal?.throwIfAborted();revalidate();bytes+=chunk.length;check(bytes<=maxBytes,'市场下载超过大小限制');chunks.push(Buffer.from(chunk));}signal?.throwIfAborted();revalidate();return Buffer.concat(chunks);
  }
  async readJSON(url,options){return JSON.parse((await this.bytes(url,options)).toString('utf8'));}
  validateCatalog(value,source){
    check(value?.schemaVersion===1&&Array.isArray(value.plugins)&&value.plugins.length<=10000,'市场目录格式无效');const seen=new Set();
    return value.plugins.map(item=>{check(item&&typeof item.id==='string'&&/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(item.id)&&!item.id.startsWith('forge.')&&!seen.has(item.id),'市场插件 ID 无效或重复');seen.add(item.id);check(typeof item.name==='string'&&item.name.length<=100&&typeof item.description==='string'&&item.description.length<=20000,'市场插件说明无效');updates.source(item.update);return {...item,source:source.id,key:source.id+':'+item.id,installed:this.registry.entries.has(item.id)};});
  }
  async catalog({source,query='',force=false}={},options={}){
    check(typeof query==='string'&&query.length<=200,'搜索词无效');const items=[],errors=[];
    if(fs.existsSync(this.bundledCatalog)&&(!source||source==='bundled')){try{items.push(...this.validateCatalog(json(this.bundledCatalog),{id:'bundled'}));}catch(error){errors.push({source:'bundled',message:error.message});}}
    for(const entry of this.sources().filter(item=>!source||item.id===source)){
      try{let cached=this.cache.get(entry.id);if(force||!cached||Date.now()-cached.at>300000){cached={value:await this.readJSON(entry.url,options),at:Date.now()};this.cache.set(entry.id,cached);}items.push(...this.validateCatalog(cached.value,entry));}catch(error){if(options.signal?.aborted)throw error;errors.push({source:entry.id,message:error.message});}
    }
    const needle=query.toLocaleLowerCase();return {plugins:items.filter(item=>!needle||[item.name,item.id,item.description,...(item.tags||[])].join(' ').toLocaleLowerCase().includes(needle)).map(item=>({...item,...(item.compatibility?compatibility(item,this.registry.versions):{compatible:null,reasons:['安装前读取发布清单确认兼容性']})})),sources:this.sources(),errors};
  }
  async release(entry,options){
    const update=updates.source(entry.update);let url=update.manifestUrl;
    if(update.provider==='github'){const release=await this.readJSON('https://api.github.com/repos/'+update.repository+'/releases/latest',options);check(!release.draft&&!release.prerelease,'仅支持正式插件发行');const asset=release.assets?.find(item=>item.name==='codex-forge-plugin-release.json');check(asset,'发行附件缺少插件更新清单');url=updates.allowedURL(asset.browser_download_url,update);}
    const value=await this.readJSON(url,options);check(value.schemaVersion===1&&value.id===entry.id,'插件发布身份与目录不一致');updates.allowedURL(value.url,update);check(/^[a-f0-9]{64}$/.test(value.sha256)&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=30*1024*1024,'发布摘要或大小无效');const match=compatibility(value,this.registry.versions);check(match.compatible,match.reasons.join('；'));return {release:value,update};
  }
  async install({id,source}={},options={}){
    const catalog=await this.catalog({source},options),matches=catalog.plugins.filter(item=>item.id===id);check(matches.length===1,'请指定唯一且已配置的市场目录插件');const entry=matches[0];
    check(!this.registry.entries.has(id),'插件已安装，请使用检查更新');const {release,update}=await this.release(entry,options);
    const bytes=await this.bytes(updates.allowedURL(release.url,update),{...options,maxBytes:release.bytes});check(bytes.length===release.bytes&&sha(bytes)===release.sha256,'插件包大小或 SHA-256 不匹配');
    const staging=fs.mkdtempSync(path.join(this.root,'.market-'));
    try{
      const extension=/\.(zip|7z)$/i.exec(new URL(release.url).pathname)?.[0]||'.forge-plugin.json';const archive=path.join(staging,'package'+extension),unpacked=path.join(staging,'unpacked');fs.writeFileSync(archive,bytes);require('./forge-package.cjs').unpack(archive,unpacked);
      const manifest=validate(json(path.join(unpacked,'plugin.json')),unpacked);check(manifest.id===release.id&&manifest.version===release.version&&manifest.apiVersion===release.apiVersion&&JSON.stringify(manifest.compatibility)===JSON.stringify(release.compatibility)&&JSON.stringify(manifest.dependencies||{})===JSON.stringify(release.dependencies||{}),'包内清单与发布清单不一致');check(JSON.stringify(manifest.update)===JSON.stringify(update),'插件包不能更换目录声明的更新来源');options.signal?.throwIfAborted();options.revalidate?.();return this.registry.install(unpacked);
    }finally{fs.rmSync(staging,{recursive:true,force:true});}
  }
}
module.exports={ForgeMarketplace};
