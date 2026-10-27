const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const source=fs.readFileSync(path.join(__dirname,'../runtime/host-workspace.cjs'),'utf8');
  const end=source.lastIndexOf('})();');
  const elements=new Map(), requests=[], opens=[], overviews=[];
  const bounds=(left,width,top=32,height=768)=>({left,width,top,height,right:left+width,bottom:top+height});
  const sidebar={rect:bounds(0,280),getBoundingClientRect(){return this.rect;},querySelector(){return this.dock||null;},querySelectorAll(){return [footer];}};
  const footer={getBoundingClientRect:()=>bounds(8,264,752,40),closest:()=>null};
  const body={appendChild(node){elements.set(node.id,node);node.parentElement=body;}};
  sidebar.parentElement=body;
  const entry={parentElement:sidebar}; elements.set('fast-canvas-entry',entry);
  const document={body,querySelector:()=>null,getElementById:id=>elements.get(id)||null,
    querySelectorAll:selector=>selector.startsWith('nav,')||selector==='[data-sidebar-navigation-root]'&&sidebar.native?[sidebar]:[],
    createElement(){
      const children=new Map();
      return {dataset:{},style:{},attributes:{},textContent:'',listeners:{},
        set innerHTML(value){for(const key of ['speed','fingerprint'])children.set(`[data-fast-info-${key}]`,{textContent:''});},
        querySelector(selector){return children.get(selector);},setAttribute(key,value){this.attributes[key]=value;},
        addEventListener(name,callback){this.listeners[name]=callback;},remove(){elements.delete(this.id);}
      };
    }
  };
  const ipcRenderer={on(){},invoke(channel,args){
    if(channel==='fast-ext:statistics') return new Promise((resolve,reject)=>requests.push({args,resolve,reject}));
    if(channel==='fast-ext:overview') return Promise.resolve(overviews.shift());
    if(channel==='fast-ext:host-open'){opens.push(args);return Promise.resolve();}
    throw Error(`Unexpected IPC: ${channel}`);
  }};
  const sandbox={require:()=>({ipcRenderer}),document,window:{addEventListener(){}},innerWidth:1200,innerHeight:800,requestAnimationFrame(){}};
  const instrumented=source.slice(0,end)+`globalThis.summaryTest={
    paint:informationCard,refresh:refreshInformationSummary,navigate:refresh,
    initialize(value){overview=value;lastThread=value.threadId;},
    pending(){return infoFetching;}
  };`+source.slice(end);
  vm.runInNewContext(instrumented,sandbox);
  const host=sandbox.summaryTest;
  const overview=(threadId,extra={})=>({threadId,threads:[],jobs:[],...extra});
  host.initialize(overview('A'));
  return {host,requests,opens,sidebar,entry,document,elements,overview,
    card(){host.paint();return elements.get('fast-information-summary');},
    async set(snapshot){const waiting=host.refresh(true);requests.at(-1).resolve({threadId:'A',...snapshot});await waiting;return this.card();},
    async navigate(threadId){overviews.push(overview(threadId));elements.delete('fast-canvas-entry');try{await host.navigate();}finally{elements.set('fast-canvas-entry',entry);}}
  };
}
const snapshot=(verdict='MATCH',extra={})=>({model:'gpt-6-sol',speed:{latest:{tps:83.26},phase:'generating'},fingerprint:{prediction:'gpt-6-sol',verdict,...extra}});

test('sidebar card shows the latest response speed, model fingerprint and opens the right panel',async()=>{
  const h=harness(),card=await h.set(snapshot());
  assert.equal(card.querySelector('[data-fast-info-speed]').textContent,'83.3');
  assert.equal(card.querySelector('[data-fast-info-fingerprint]').textContent,'gpt-6-sol');
  assert.equal(card.dataset.warning,'false');assert.equal(card.dataset.active,'true');
  assert.equal(card.style.left,'8px');assert.equal(card.style.width,'264px');assert.equal(card.style.bottom,'56px');
  assert(card.attributes['aria-label'].includes('83.3 tok/s'));
  card.listeners.click();assert.deepEqual(JSON.parse(JSON.stringify(h.opens)),[{page:'information-stats',mode:'right'}]);
  assert.equal(h.requests[0].args.threadId,'A');
});

test('only a current confirmed mismatch marks the fingerprint red',async()=>{
  const h=harness();
  for(const [verdict,stale,warning] of [['MISMATCH',false,true],['MISMATCH',true,false],['SUSPICIOUS',false,false],['MATCH',false,false],['UNLISTED',false,false],['NO_SAMPLE',false,false]]){
    const card=await h.set(snapshot(verdict,{prediction:'gpt-5.4',warning:true,stale}));
    assert.equal(card.dataset.warning,String(warning),`${verdict}, stale=${stale}`);
    assert.match(card.querySelector('[data-fast-info-fingerprint]').textContent,/gpt-5.4/);
    if(stale)assert.match(card.title,/已过期/);
    if(verdict==='SUSPICIOUS')assert.match(card.title,/证据不足/);
    if(verdict==='UNLISTED')assert.match(card.title,/未收录/);
  }
});

test('missing or invalid metrics show an honest waiting state',async()=>{
  const h=harness();
  for(const tps of [null,undefined,NaN,Infinity,-1]){
    const card=await h.set({speed:{latest:{tps}},fingerprint:{verdict:'NO_SAMPLE'}});
    assert.equal(card.querySelector('[data-fast-info-speed]').textContent,'—');
    assert.equal(card.querySelector('[data-fast-info-fingerprint]').textContent,'等待检测');
  }
  assert.equal((await h.set({speed:{latest:{tps:0}}})).querySelector('[data-fast-info-speed]').textContent,'0.0');
});

test('compact sidebar stays within its bounds; hidden sidebar leaves no floating card',async()=>{
  const h=harness();await h.set(snapshot());
  h.sidebar.rect={left:0,width:56,top:32,height:768,right:56,bottom:800};
  let card=h.card();assert.equal(card.dataset.compact,'true');assert.equal(card.style.left,'4px');assert.equal(card.style.width,'48px');
  h.sidebar.rect={left:-280,width:280,top:32,height:768,right:0,bottom:800};
  assert.equal(h.card(),undefined);
});

test('a nested navigation cannot shrink an expanded sidebar summary',()=>{
  const h=harness();
  const nested={parentElement:h.sidebar,getBoundingClientRect:()=>({left:0,width:56,top:32,height:768,right:56,bottom:800})};
  h.entry.parentElement=nested;
  const card=h.card();assert.equal(card.style.width,'264px');assert.equal(card.dataset.compact,'false');
});

test('disabled plugin and missing conversation remove the card',()=>{
  const h=harness();assert(h.card());
  h.host.initialize(h.overview('A',{forgePlugins:[{id:'forge.information-stats',enabled:false}]}));assert.equal(h.card(),undefined);
  h.host.initialize(h.overview('A'));assert(h.card());
  h.host.initialize(h.overview(null));assert.equal(h.card(),undefined);
});

test('native footer owns the card so its measured height reserves room above the account menu',()=>{
  const h=harness(),card=h.card();
  h.sidebar.native=true;
  const dock={prepend(node){h.elements.set(node.id,node);node.parentElement=this;this.firstChild=node;}};
  h.sidebar.dock=dock;
  assert.equal(h.card(),card);assert.equal(card.parentElement,dock);assert.equal(dock.firstChild,card);
  assert.equal(card.dataset.docked,'true');assert.equal(card.style.left,'');assert.equal(card.style.width,'');assert.equal(card.style.bottom,'');
  h.sidebar.dock=null;
  assert.equal(h.card().dataset.docked,'false');assert.equal(card.parentElement,h.document.body);
});

test('navigation invalidates old requests immediately, even when returning to the same conversation',async()=>{
  const h=harness(),old=h.host.refresh(true);
  await h.navigate('B');assert.equal(h.requests.length,2);
  await h.navigate('A');assert.equal(h.requests.length,3);
  h.requests[0].resolve({threadId:'A',...snapshot('MISMATCH',{prediction:'old model'})});await old;
  assert.equal(h.host.pending(),true);
  assert.equal(h.card().querySelector('[data-fast-info-fingerprint]').textContent,'等待检测');
  h.requests[1].resolve({threadId:'B',...snapshot()});
  h.requests[2].resolve({threadId:'A',...snapshot()});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.host.pending(),false);
  assert.equal(h.card().querySelector('[data-fast-info-fingerprint]').textContent,'gpt-6-sol');
});

test('foreign-thread replies and failed refreshes cannot inject another conversation metrics',async()=>{
  const h=harness();
  await h.set({threadId:'B',...snapshot('MISMATCH',{prediction:'foreign'})});
  assert.equal(h.card().querySelector('[data-fast-info-fingerprint]').textContent,'等待检测');
  const waiting=h.host.refresh(true);h.requests.at(-1).reject(Error('opening'));await waiting;
  assert.equal(h.host.pending(),false);
  assert.equal(h.card().dataset.warning,'false');
});
