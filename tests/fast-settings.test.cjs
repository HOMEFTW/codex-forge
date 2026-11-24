'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {transformSync}=require('esbuild');

// Run the real component and its handlers with a minimal hook scheduler.
// Browser keyboard behavior is also checked in the isolated settings fixture.
function mount(call) {
  const slots=[],pending=[];let cursor=0;
  const react={createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
    useEffect(effect,deps){const i=cursor++,prior=slots[i];if(!prior||deps.some((d,n)=>!Object.is(d,prior[n]))){slots[i]=deps;pending.push(effect);}}};
  const code=transformSync(fs.readFileSync(path.join(__dirname,'../ui/fast-settings.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
  const sandbox={module:{exports:{}},require:id=>{assert.equal(id,'react');return react;}};
  vm.runInNewContext(code,sandbox);
  return async()=>{let tree;for(let i=0;i<3;i++){cursor=0;tree=sandbox.module.exports.default({plugin:{id:'forge.fast',enabled:true},call});for(const effect of pending.splice(0))effect();await Promise.resolve();}return tree;};
}
function find(node,type){if(!node)return null;if(Array.isArray(node)){for(const child of node){const result=find(child,type);if(result)return result;}}else if(typeof node==='object'){if(node.type===type)return node;return find(node.children,type);}return null;}
function button(node,label){if(!node)return null;if(Array.isArray(node)){for(const child of node){const found=button(child,label);if(found)return found;}}else if(typeof node==='object'){if(node.type==='button'&&node.children.includes(label))return node;return button(node.children,label);}return null;}
test('Ultrafast IDs retain line breaks while editing and parse only on save and reopen',async()=>{
  let saved={defaultSpeed:'fast',enableTerra:true,sol62Context500k:true,hiddenModels:[],ultrafastModels:[]};
  const call=async(method,args)=>{if(method==='settings')return saved;if(method==='fastModels')return [{id:'gpt-6.2-sol',name:'Sol'}];if(method==='saveSettings'){saved=JSON.parse(JSON.stringify(args.value));return saved;}throw Error(method);};
  let render=mount(call),tree=await render();let typed='';
  for(const char of 'gpt-6.2-sol\n\ngpt-6.2-astra\n'){
    typed+=char;find(tree,'textarea').props.onChange({target:{value:typed}});tree=await render();
    assert.equal(find(tree,'textarea').props.value,typed);
  }
  await button(tree,'保存设置').props.onClick();
  assert.deepEqual(saved.ultrafastModels,['gpt-6.2-sol','gpt-6.2-astra']);
  render=mount(call);tree=await render();assert.equal(find(tree,'textarea').props.value,'gpt-6.2-sol\ngpt-6.2-astra');
});
