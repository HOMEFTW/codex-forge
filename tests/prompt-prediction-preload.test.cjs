const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
 const dom=new Map(),win=new Map(),ipc=new Map(),calls=[],edits=[],nodes=[];let native=false,accept;
 const root={getBoundingClientRect:()=>({height:50}),querySelector:selector=>selector==='[data-cumberbatch]'?(native?{}:null):input,setAttribute(){},removeAttribute(){}};
 const input={tagName:'TEXTAREA',value:'',disabled:false,closest:()=>root,getAttribute:()=>null,contains:node=>node===input,getBoundingClientRect:()=>({height:50,width:400,top:20,left:10})};
 const element=()=>({style:{},setAttribute(){},remove(){this.removed=true;}});
 const document={querySelectorAll:()=>[root],createElement:element,head:{append(){}},body:{append:node=>nodes.push(node)},addEventListener:(name,fn)=>dom.set(name,fn)};
 const window={addEventListener:(name,fn)=>win.set(name,fn),getComputedStyle:()=>({font:'14px sans-serif',lineHeight:'20px',color:'gray',paddingLeft:'0',paddingRight:'0',paddingTop:'0'})};
 const ipcRenderer={on:(name,fn)=>ipc.set(name,fn),invoke:async(channel,args)=>{assert.equal(channel,'forge:prediction');calls.push(args);if(args.action==='status')return {type:'forge-prediction',generation:0,phase:'idle'};if(args.action==='accept')return new Promise(resolve=>{accept=()=>resolve({...args,text:'预测草稿'})});if(args.action==='ready')return new Promise(()=>{});return true;}};
 const sandbox={require:()=>({ipcRenderer}),document,window,console,MutationObserver:class{observe(){}},__forgeBridge:{editComposer(action,args){assert.equal(action,'composer.set');assert.equal(input.value,args.expectedText);input.value=args.text;edits.push(args);}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/prompt-prediction-preload.cjs'),'utf8'),sandbox);win.get('DOMContentLoaded')();
 const receive=(phase='suggestion',generation=1)=>ipc.get('fast-ext:changed')(null,{type:'forge-prediction',threadId:'A',sourceTurnId:'turn',ticket:'ticket-'+generation,generation,phase,text:phase==='suggestion'?'预测草稿':null});
 const key=(key,extra={})=>{const e={key,target:input,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};return {event:e,done:dom.get('keydown')(e)}};
 return {input,calls,edits,nodes,receive,key,accept:()=>accept(),native:()=>native=true,event:(name,extra={})=>dom.get(name)({target:input,...extra})};
}
test('suggestion stays outside the draft; Tab accepts once and Esc only dismisses',async()=>{
 const h=harness();await tick();h.receive();assert.equal(h.input.value,'');assert(h.nodes.some(n=>n.textContent.includes('预测草稿')));
 const first=h.key('Tab'),second=h.key('Tab');assert(first.event.prevented);assert(second.event.prevented);assert.equal(h.calls.filter(c=>c.action==='accept').length,1);
 h.accept();await first.done;await second.done;assert.equal(h.input.value,'预测草稿');assert.equal(h.edits.length,1);
 h.input.value='';h.receive('suggestion',2);const esc=h.key('Escape');await esc.done;assert(esc.event.prevented);assert.equal(h.input.value,'');assert.equal(h.edits.length,1);
});
test('typed drafts, delayed acceptance and IME never overwrite user input',async()=>{
 const h=harness();await tick();h.input.value='保留';h.receive();assert(!h.nodes.length);assert(!h.calls.some(c=>c.action==='accept'));
 h.input.value='';h.receive('suggestion',2);const tab=h.key('Tab');h.input.value='新草稿';h.event('input');h.accept();await tab.done;assert.equal(h.input.value,'新草稿');assert.equal(h.edits.length,0);
 h.input.value='';h.receive('suggestion',3);h.event('compositionstart');const ime=h.key('Tab',{isComposing:true,keyCode:229});await ime.done;assert(!ime.event.prevented);assert.equal(h.edits.length,0);
 h.event('compositionend');h.receive('suggestion',3);assert.equal(h.edits.length,0);
});
test('native cumberbatch owns Tab and suppresses Forge even before observer delivery',async()=>{
 const h=harness();await tick();h.receive();h.native();const tab=h.key('Tab');await tab.done;assert(!tab.event.prevented);assert(!h.calls.some(c=>c.action==='accept'));assert(h.nodes.every(n=>n.removed));
 h.receive('offer',2);assert(!h.calls.some(c=>c.action==='ready'));
});
