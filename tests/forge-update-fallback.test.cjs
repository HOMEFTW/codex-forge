const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {runUpdateAction,launchUpdate,launchIndependentUpdater}=require('../runtime/forge-updates.cjs');
test('normal update flow stays primary and no compatible release does not open fallback',async()=>{
  let fallback=0;const open=()=>{fallback++;return {message:'opened'};};
  for(const method of ['checkUpdates','stageUpdate','applyUpdate']) {
    const result={plan:null,native:{status:'up_to_date'},forge:{status:'checked'},scheduled:true};
    assert.equal(await runUpdateAction(method,async()=>result,open),result);
  }
  assert.equal(fallback,0);
});
test('unavailable check, download and install failures each open independent updater once',async()=>{
  for(const method of ['checkUpdates','stageUpdate','applyUpdate']) {
    let fallback=0;const result=await runUpdateAction(method,async()=>{if(method==='checkUpdates')return {plan:null,native:{status:'unavailable',error:'offline'},forge:{status:'checked'}};throw Error('offline');},async()=>{fallback++;return {message:'opened'};});
    assert.equal(fallback,1);assert.equal(result.fallback,true);assert.match(result.message,/offline.*opened/);
  }
});
test('fallback keeps both failure reasons and never recurses for manual entry or cancellation',async()=>{
  await assert.rejects(runUpdateAction('stageUpdate',async()=>{throw Error('download');},async()=>{throw Error('missing exe');}),/download.*missing exe/);
  let calls=0;await assert.rejects(runUpdateAction('openUpdater',async()=>{throw Error('manual');},async()=>calls++),/manual/);
  await assert.rejects(runUpdateAction('stageUpdate',async()=>{const e=Error('cancelled');e.name='AbortError';throw e;},async()=>calls++),/cancelled/);assert.equal(calls,0);
});
function installation(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'setup.msi'),sha256=crypto.createHash('sha256').update('fixture').digest('hex');fs.writeFileSync(file,'fixture');fs.writeFileSync(file+'.json',JSON.stringify({file,sha256}));fs.writeFileSync(path.join(root,'forge-install.json'),'{}');return {root,staged:{file,sha256}};}
test('MSI startup error is awaitable and a later installer failure triggers recovery',async t=>{
  const {root,staged}=installation(t);const child=new EventEmitter();child.unref=()=>{};
  const failed=launchUpdate(staged,root,null,()=>child);child.emit('error',Error('spawn denied'));await assert.rejects(failed,/spawn denied/);
  const installer=new EventEmitter();installer.unref=()=>{};const errors=[];
  const started=launchUpdate(staged,root,null,()=>installer,error=>errors.push(error.message));installer.emit('spawn');assert.equal((await started).scheduled,true);installer.emit('exit',1603,null);assert.match(errors[0],/1603/);
});
test('MSI success, restart and user cancellation do not trigger fallback',async t=>{
  const {root,staged}=installation(t);for(const code of [0,1641,3010,1602]){const child=new EventEmitter();child.unref=()=>{};let failures=0;const result=launchUpdate(staged,root,null,()=>child,()=>failures++);child.emit('spawn');await result;child.emit('exit',code,null);assert.equal(failures,0);}
});
test('independent updater searches installation parents and reports launch errors',async t=>{
  const {root}=installation(t);fs.writeFileSync(path.join(root,'bootstrap.json'),'{}');fs.writeFileSync(path.join(root,'CodexForgeUpdater.exe'),'fixture');const nested=path.join(root,'clients','v050');fs.mkdirSync(nested,{recursive:true});const child=new EventEmitter();child.unref=()=>{};let invoked;
  const started=launchIndependentUpdater(nested,'test/forge',(file,args)=>{invoked={file,args};return child;});child.emit('spawn');assert.equal((await started).opened,true);assert.deepEqual(invoked.args,['--root',root,'--repository','test/forge']);
  const bad=new EventEmitter();bad.unref=()=>{};const failed=launchIndependentUpdater(nested,'test/forge',()=>bad);bad.emit('error',Error('exe denied'));await assert.rejects(failed,/exe denied/);
});
