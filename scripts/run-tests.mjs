import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const names=fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.cjs')).map(x=>path.join('tests',x));
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...names],{cwd:root,encoding:'utf8',windowsHide:true});
fs.mkdirSync(path.join(root,'output'),{recursive:true});
fs.writeFileSync(path.join(root,'output/forge-tests.tap'),result.stdout+result.stderr);
if(result.status!==0){console.error(result.stdout,result.stderr);process.exit(result.status||1);}
const cases=Number(result.stdout.match(/# tests (\d+)/)?.[1]),passed=Number(result.stdout.match(/# pass (\d+)/)?.[1]);
if(cases<27||passed!==cases)throw Error('Unexpected test totals');
const hashes={};for(const folder of ['runtime','ui','tests'])for(const name of fs.readdirSync(path.join(root,folder))){const file=path.join(root,folder,name);if(fs.statSync(file).isFile())hashes[folder+'/'+name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
const report={casesPassed:passed,casesTotal:cases,failures:0,exitCode:result.status,sourceSHA256:hashes};
fs.writeFileSync(path.join(root,'output/forge-tests-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed,cases,exitCode:result.status}));
