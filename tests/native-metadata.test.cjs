const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');

const normalize=value=>JSON.parse(JSON.stringify(value));

async function requestConfig(source,{servers={},allowlist=[],failure=false,signal}={}) {
 let request;
 const symbols=source.includes('await s4(')?{parse:'u4',generate:'s4',log:'ea',abort:'C'}:{parse:'dc',generate:'ol',log:'e_',abort:source.includes('(0,j._qC)')?'j':'B'};
 const generate=vm.runInNewContext('('+source+')',{
  [symbols.parse]:{safeParse:value=>value&&typeof value==='object'?{success:true,data:value}:{success:false}},
  [symbols.generate]:async value=>{request=value;return {title:'fixture'};},[symbols.log]:()=>{},
  [symbols.abort]:{_qC:async(p,s)=>{s.throwIfAborted();return p;}}
 });
 await generate({appServerClient:{getUserSavedConfiguration:async()=>{if(failure)throw Error('unavailable');return {mcp_servers:servers};}},
  model:'fixture-model',cwd:'D:/fixture',readOnlyAppToolAllowlist:allowlist,feature:'thread_title',prompt:'fixture',signal});
 return normalize(request.config);
}

for(const [version,fixture] of [['26.1103.4239.0',require('./fixtures/native-metadata-nov09.json')],['26.1103.7773.0',require('./fixtures/native-metadata-nov10.json')],['26.1106.6628.0',require('./fixtures/native-metadata-nov12.json')]]) {

test(version+': native title config disables MCP servers without replacing their transport definitions',async()=>{
 assert.equal(require('../adapters/'+version+'.json').members.metadataGeneration,fixture.member);
 const {patchNov09Metadata}=await import('../scripts/native-nov09-main.mjs');
 const servers={fast_canvas:{command:'node',args:['mcp.cjs'],env:{PRIVATE_VALUE:'must-not-copy'}},remote:{url:'https://fixture.invalid/mcp'},'custom-name':{command:'other'}};
 const original=await requestConfig(fixture.source,{servers});
 assert.deepEqual(original.mcp_servers,{fast_canvas:{enabled:false},remote:{enabled:false},'custom-name':{enabled:false}});
 const actual=await requestConfig(patchNov09Metadata(fixture.source),{servers});
 const {mcp_servers,...rest}=original;
 assert.deepEqual(actual,{...rest,'mcp_servers.fast_canvas.enabled':false,'mcp_servers.remote.enabled':false,'mcp_servers.custom-name.enabled':false});
 assert(!JSON.stringify(actual).includes('must-not-copy'));
});

test(version+': metadata patch preserves allowed apps, disabled tools and unavailable config handling',async()=>{
 const {patchNov09Metadata}=await import('../scripts/native-nov09-main.mjs');
 const source=patchNov09Metadata(fixture.source);
 const actual=await requestConfig(source,{servers:{codex_apps:{command:'apps'},fast_canvas:{command:'node'}},allowlist:[{appId:'read-only-app',toolNames:['read']} ]});
 assert.equal(actual['mcp_servers.fast_canvas.enabled'],false);
 assert(!Object.hasOwn(actual,'mcp_servers.codex_apps.enabled'));
 assert.equal(actual.apps['read-only-app'].destructive_enabled,false);
 assert.equal(actual['features.multi_agent'],false);
 assert.equal(actual['features.plugins'],false);
 assert.equal(actual.web_search,'disabled');
 for(const options of [{servers:{}},{servers:undefined},{failure:true}]) {
  const config=await requestConfig(source,options);
  assert(!Object.keys(config).some(key=>key.startsWith('mcp_servers')));
  assert.equal(config['features.hooks'],false);
 }
 const controller=new AbortController();controller.abort();
 await assert.rejects(requestConfig(source,{signal:controller.signal}),{name:'AbortError'});
});

test(version+': metadata patch rejects missing, changed and duplicate upstream anchors',async()=>{
 const {patchNov09Metadata}=await import('../scripts/native-nov09-main.mjs');
 assert.throws(()=>patchNov09Metadata('unrelated code'),/metadata anchor changed/);
 assert.throws(()=>patchNov09Metadata(fixture.source+fixture.source),/metadata anchor changed/);
 assert.throws(()=>patchNov09Metadata(fixture.source.replace('e,{enabled:!1}','e,{enabled:false}')),/metadata anchor changed/);
});

}
