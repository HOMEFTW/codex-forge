const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('bootstrap rejects unsafe paths, mismatched identities and corrupted files; decodes official archive paths once',{skip:process.platform!=='win32'},t=>{
 const parent=path.resolve(__dirname,'../output');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'bootstrap-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const exe=path.join(root,'BootstrapTests.exe');
 const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const result=spawnSync(compiler,['/nologo','/target:exe','/main:BootstrapTests','/win32manifest:'+path.resolve(__dirname,'../cli/app.manifest'),'/out:'+exe,...['System.Windows.Forms','System.Drawing','System.Web.Extensions','System.Net.Http','System.IO.Compression','System.IO.Compression.FileSystem'].map(x=>'/reference:'+x+'.dll'),path.resolve(__dirname,'../cli/Bootstrap.cs'),path.resolve(__dirname,'fixtures/bootstrap-tests.cs')],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 fs.copyFileSync(path.resolve(__dirname,'../cli/app.config'),exe+'.config');
 const run=spawnSync(exe,[root,path.resolve(__dirname,'../adapters/26.1016.8622.0.json')],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/BOOTSTRAP_CORE_PASS/);
});
