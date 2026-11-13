'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {ForgeError}=require('./forge-errors.cjs');
const DPAPI=Buffer.from('FORGE-DPAPI-1:');
// Some Codex Windows builds omit Electron's safeStorage binding. DPAPI uses
// CurrentUser and sends bytes through stdin, never command arguments or files.
function systemCredentials(getNative=()=>null,{platform=process.platform,execute=spawnSync}={}){
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const native=()=>{try{const api=getNative();return api?.isEncryptionAvailable?.()?api:null;}catch{return null;}};
  const dpapi=(bytes,decrypt=false)=>{
    const operation=decrypt?'Unprotect':'Protect';
    const source="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd());$result=[Security.Cryptography.ProtectedData]::"+operation+"($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result));";
    const result=execute(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{input:Buffer.from(bytes).toString('base64'),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:128*1024});
    if(result.status!==0||result.error||!/^[A-Za-z0-9+/=]+$/.test(result.stdout||''))throw new ForgeError('CAPABILITY_UNAVAILABLE','Windows 系统凭据加密不可用');
    return Buffer.from(result.stdout,'base64');
  };
  return {
    isEncryptionAvailable:()=>!!native()||platform==='win32'&&fs.existsSync(executable),
    encryptString(value){const api=native();if(api)return api.encryptString(value);if(platform!=='win32')throw new ForgeError('CAPABILITY_UNAVAILABLE','系统凭据加密不可用');return Buffer.concat([DPAPI,dpapi(Buffer.from(value,'utf8'))]);},
    decryptString(value){const bytes=Buffer.from(value);if(bytes.subarray(0,DPAPI.length).equals(DPAPI)){if(platform!=='win32')throw new ForgeError('CAPABILITY_UNAVAILABLE','Windows 凭据仅可由原 Windows 用户解密');return dpapi(bytes.subarray(DPAPI.length),true).toString('utf8');}const api=native();if(!api)throw new ForgeError('CAPABILITY_UNAVAILABLE','原系统凭据加密服务不可用');return api.decryptString(bytes);},
  };
}
module.exports={systemCredentials};
