const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('bootstrap rejects unsafe paths, mismatched identities and corrupted files; decodes official archive paths once',{skip:process.platform!=='win32'},t=>{
 const powershell=path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const environment={...process.env};for(const key of Object.keys(environment))if(key.startsWith('NODE_'))delete environment[key];
 const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'fixtures/bootstrap-runner.ps1')],{encoding:'utf8',windowsHide:true,timeout:60000,env:environment});
 if([0x8007045A,0xC0000142].includes(result.status))return t.skip('当前受限测试宿主阻止嵌套 WinForms 进程；已由独立 bootstrap-runner.ps1 执行同一回归');
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/BOOTSTRAP_CORE_PASS/);
});
