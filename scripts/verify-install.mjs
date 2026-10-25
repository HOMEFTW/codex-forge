import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),install=path.resolve(process.argv[2]||'D:/Codex-Forge/Codex-Forge-0.2.0-26.1021.2667.0');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(install,'forge-install.json'),'utf8'));
for(const entry of manifest.files){const file=path.resolve(install,entry.path);assert(file.startsWith(install+path.sep));assert.equal(hash(fs.readFileSync(file)),entry.sha256,entry.path);}
const asar=fs.readFileSync(path.join(install,'app/resources/app.asar')),headerBytes=asar.subarray(16,16+asar.readUInt32LE(12)),header=JSON.parse(headerBytes),offset=8+asar.readUInt32LE(4);let members=0,blocks=0;
function walk(directory,prefix=''){for(const [name,item] of Object.entries(directory.files||{})){const member=prefix+name;if(item.files){walk(item,member+'/');continue;}if(item.unpacked||item.link)continue;const bytes=asar.subarray(offset+Number(item.offset),offset+Number(item.offset)+item.size);assert.equal(bytes.length,item.size,member);assert.equal(item.integrity?.algorithm,'SHA256',member);assert.equal(hash(bytes),item.integrity.hash,member);for(let at=0,index=0;at<bytes.length;at+=item.integrity.blockSize,index++){assert.equal(hash(bytes.subarray(at,at+item.integrity.blockSize)),item.integrity.blocks[index],member+' block '+index);blocks++;}members++;}}
walk(header);assert.equal(hash(asar),manifest.asarSHA256);assert.equal(hash(headerBytes),manifest.headerSHA256);
const executable=fs.readFileSync(path.join(install,'app/ChatGPT.exe'));assert.equal(hash(executable),manifest.executableSHA256);assert.equal(executable.subarray(manifest.executableIntegrityOffset,manifest.executableIntegrityOffset+64).toString(),manifest.headerSHA256);
const report={product:manifest.product,forgeVersion:manifest.forgeVersion,codexVersion:manifest.sourceMSIXVersion,verifiedFiles:manifest.files.length,verifiedAsarMembers:members,verifiedAsarBlocks:blocks,headerSHA256:manifest.headerSHA256,asarSHA256:manifest.asarSHA256,executableSHA256:manifest.executableSHA256,launcherSHA256:hash(fs.readFileSync(path.join(install,'CodexForge.exe'))),install,checkedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,'output/forge-integrity.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
