import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
export function createDelta(before, after, blockSize = 65536) {
  const blocks = new Map();
  for (let at=0;at<before.length;at+=blockSize) blocks.set(hash(before.subarray(at,at+blockSize)),{offset:at,bytes:Math.min(blockSize,before.length-at)});
  const operations=[];
  for (let at=0;at<after.length;at+=blockSize) {
    const chunk=after.subarray(at,at+blockSize),copy=blocks.get(hash(chunk));
    const previous=operations.at(-1);
    if (copy && copy.bytes===chunk.length) {
      if(previous?.offset!==undefined && previous.offset+previous.bytes===copy.offset)previous.bytes+=copy.bytes;
      else operations.push({...copy});
    } else operations.push({data:chunk.toString('base64')});
  }
  return {schemaVersion:1,format:'forge-blocks-v1',fromSha256:hash(before),toSha256:hash(after),toBytes:after.length,operations};
}
if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
  const [baseline,target,manifestPath]=process.argv.slice(2);
  assert(baseline&&target&&manifestPath,'Usage: node scripts/build-delta.mjs BASELINE TARGET RELEASE_MANIFEST');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),before=fs.readFileSync(baseline),after=fs.readFileSync(target);
  const kind=target.endsWith('.msi')?'msi':'portable',expected=kind==='msi'?manifest.sha256:manifest.portableSha256;
  assert.equal(hash(after),expected,'Target is not the release artifact');
  const delta=createDelta(before,after),bytes=Buffer.from(JSON.stringify(delta));
  if(bytes.length>=after.length || bytes.length>24*1024*1024) console.log('Delta is not smaller than the full artifact; full download retained.');
  else {
    const name=`Codex-Forge-${manifest.forgeVersion}-${kind}-${delta.fromSha256.slice(0,12)}.delta.json`;
    fs.writeFileSync(path.join(path.dirname(manifestPath),name),bytes);
    manifest.deltas=[...(manifest.deltas||[]).filter(e=>!(e.kind===kind&&e.fromSha256===delta.fromSha256)),{kind,fromSha256:delta.fromSha256,toSha256:delta.toSha256,toBytes:after.length,bytes:bytes.length,sha256:hash(bytes),url:`https://github.com/${manifest.repository}/releases/download/v${manifest.forgeVersion}/${name}`}];
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
    fs.appendFileSync(path.join(path.dirname(manifestPath),'SHA256SUMS.txt'),`${hash(bytes)}  ${name}\n`);
    console.log(JSON.stringify({name,bytes:bytes.length,fullBytes:after.length}));
  }
}
