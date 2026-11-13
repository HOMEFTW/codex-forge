const {test}=require('node:test'),assert=require('node:assert/strict');
const {systemCredentials}=require('../runtime/forge-secrets.cjs');
test('credentials tolerate a missing Electron binding and use Windows user encryption',{skip:process.platform!=='win32'},()=>{
 const vault=systemCredentials(()=>{throw Error('No such binding was linked');});assert.equal(vault.isEncryptionAvailable(),true);
 const text='API5 local fixture 中文',encrypted=vault.encryptString(text);assert(!encrypted.includes(Buffer.from(text)));assert.equal(vault.decryptString(encrypted),text);
});
test('credentials keep the original Electron service when available',()=>{
 const vault=systemCredentials(()=>({isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('encrypted:'+value),decryptString:value=>value.toString().slice(10)}));assert.equal(vault.decryptString(vault.encryptString('fixture')),'fixture');
});
test('credentials fail explicitly when no system encryption is available',()=>{
 const vault=systemCredentials(()=>{throw Error('missing');},{platform:'unsupported'});assert.equal(vault.isEncryptionAvailable(),false);assert.throws(()=>vault.encryptString('fixture'),{code:'CAPABILITY_UNAVAILABLE'});
});
