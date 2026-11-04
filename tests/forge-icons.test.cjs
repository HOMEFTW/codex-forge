const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {validateIcon}=require('../runtime/forge-manifest.cjs');
test('contribution icon accepts only bounded path data and a fixed viewport',()=>{
  assert.deepEqual(validateIcon({viewBox:'0 0 24 24',paths:['M2 3L4 5z']}),{viewBox:'0 0 24 24',paths:['M2 3L4 5z']});
  for(const icon of [{viewBox:'1 1 8 8',paths:['M0 0']},{viewBox:'0 0 24 24',paths:['<script/>']},{viewBox:'0 0 24 24',paths:['url(https://example.com)']},{viewBox:'0 0 24 24',paths:[]},{viewBox:'0 0 24 24',paths:['M0 0'],onclick:'bad'},{viewBox:'0 0 24 24',paths:Array(17).fill('M0 0')}])assert.throws(()=>validateIcon(icon),/图标/);
});
test('sidebar contributions render SVG safely, track compact mode and remount, and disappear on disable',async()=>{
  const all=[],calls=[];
  function element(tag){const attrs={};const el={tagName:tag,children:[],dataset:{},style:{},className:'',parentElement:null,getAttribute:n=>attrs[n],setAttribute(n,v){attrs[n]=v;},append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}},remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;},querySelector(q){return this.children.find(x=>q==='span'&&x.tagName==='span');}};Object.defineProperty(el,'textContent',{get(){return this.text||this.children.map(x=>x.textContent).join('');},set(v){this.text=v;this.children=[];}});all.push(el);return el;}
  const left=element('nav'),menu=element('menu'),body=element('body'),canvas=element('button'),label=element('span');canvas.className='native-sidebar';canvas.append(label);left.append(canvas);
  const icon={viewBox:'0 0 24 24',paths:['M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10z']};
  const plugin={id:'test.icon',name:'Icon',enabled:true,builtin:false,permissions:['sidebar'],contributes:{sidebar:[{id:'open',title:'星枢',panel:'main',icon}]}};
  const snapshot={plugins:[plugin],dynamic:[],output:[],context:{},slots:{entries:[]}};
  const document={body,createElement:element,createElementNS:(_ns,tag)=>element(tag),getElementById:id=>id==='fast-canvas-entry'?canvas:null,querySelector:q=>q==='[role="menubar"]'?menu:null,querySelectorAll:q=>q==='[data-forge-contribution]'?all.filter(e=>e.parentElement&&e.dataset.forgeContribution):[]};
  const ipc={sendSync:()=>({}),on(){},async invoke(_channel,request){calls.push(request);return request.method==='snapshot'?snapshot:true;}};
  const sandbox={document,window:{addEventListener(){}},require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld(){}}}),console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/forge-preload.cjs'),'utf8'),sandbox);
  await sandbox.__forgeBridge.refresh();const button=left.children.find(x=>x!==canvas);assert(button);assert.equal(menu.children.length,0);assert.equal(button.children[0].tagName,'svg');assert.equal(button.children[0].children[0].getAttribute('d'),icon.paths[0]);assert.equal(button.getAttribute('aria-label'),'星枢');
  await button.onclick();assert(calls.some(x=>x.method==='openPanel'&&x.args.id==='test.icon'));
  label.style.display='none';await sandbox.__forgeBridge.refresh();assert.equal(button.querySelector('span').style.display,'none');
  const replacement=element('nav');replacement.append(canvas);await sandbox.__forgeBridge.refresh();assert.equal(button.parentElement,replacement);
  plugin.enabled=false;await sandbox.__forgeBridge.refresh();assert.equal(button.parentElement,null);
});
