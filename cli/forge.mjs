#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url), project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {ForgeRegistry}=require('../runtime/forge-registry.cjs'),{validate,compatibility}=require('../runtime/forge-manifest.cjs');
const config=JSON.parse(fs.readFileSync(path.join(project,'forge.config.json'),'utf8'));
const args=process.argv.slice(2);let root=process.env.CODEX_FORGE_HOME||path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'forge');
const at=args.indexOf('--home');if(at>=0){if(!args[at+1])throw Error('--home needs a directory');root=path.resolve(args[at+1]);args.splice(at,2);}
const [command,id,value]=args, versions={codex:config.codexVersion,forge:config.version,apiVersion:config.apiVersion};
const registry=()=>new ForgeRegistry({root,bundledRoot:path.join(project,'plugins'),versions});
try {
  let result;
  switch(command){
    case 'validate': {const directory=path.resolve(id||'.'),manifest=validate(JSON.parse(fs.readFileSync(path.join(directory,'plugin.json'),'utf8')),directory);result={manifest,...compatibility(manifest,versions)};if(!result.compatible)process.exitCode=1;break;}
    case 'list':result=registry().list();break;
    case 'install':if(!id)throw Error('需要插件目录');result=registry().install(path.resolve(id));break;
    case 'uninstall':result=registry().uninstall(id);break;
    case 'enable':case 'disable':result=registry().setEnabled(id,command==='enable');break;
    case 'settings':result=registry().settings(id,value?JSON.parse(fs.readFileSync(value,'utf8')):undefined);break;
    case 'pack': {
      if(!id||!value)throw Error('pack <插件目录> <输出文件>');
      const directory=path.resolve(id),destination=path.resolve(value);
      if(destination.startsWith(directory+path.sep))throw Error('输出文件必须位于插件目录之外');
      const manifest=validate(JSON.parse(fs.readFileSync(path.join(directory,'plugin.json'),'utf8')),directory);
      const files=[];let bytes=0;
      const walk=folder=>{for(const name of fs.readdirSync(folder).sort()){const file=path.join(folder,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||['node_modules','.git'].includes(name))throw Error('不能打包链接、node_modules 或 .git');if(stat.isDirectory())walk(file);else{bytes+=stat.size;if(files.length>=1000||bytes>20*1024*1024)throw Error('插件超过大小限制');files.push({path:path.relative(directory,file).replaceAll('\\','/'),encoding:'base64',content:fs.readFileSync(file).toString('base64')});}}};walk(directory);
      const content=Buffer.from(JSON.stringify({schemaVersion:1,files}));fs.writeFileSync(destination,content,{flag:'wx'});
      result={schemaVersion:1,id:manifest.id,apiVersion:manifest.apiVersion,version:manifest.version,compatibility:manifest.compatibility,dependencies:manifest.dependencies||{},bytes:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex'),url:'请填写发布后的 HTTPS 下载地址'};
      fs.writeFileSync(destination+'.release.json',JSON.stringify(result,null,2),{flag:'wx'});break;
    }
    case 'create': {if(!id)throw Error('需要新目录');const destination=path.resolve(id);if(fs.existsSync(destination))throw Error('目标目录已存在');fs.cpSync(path.join(project,'examples','hello-forge'),destination,{recursive:true});result={created:destination,next:'编辑 plugin.json 中的 id/name，然后运行 validate 和 install。'};break;}
    default:console.log('Codex Forge CLI\n  validate <directory>\n  create <new-directory>\n  pack <directory> <output.forge-plugin.json>\n  list\n  install <directory>\n  uninstall <publisher.name>\n  enable|disable <publisher.name>\n  settings <publisher.name> [values.json]\n  --home <Forge data directory>');process.exit(command?1:0);
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
