'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {transformSync}=require('esbuild');
const doc=id=>({id,title:id,revision:0,nodes:[],edges:[],lastChange:{source:'user'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(initialThread=null,bindings={}){
  const slots=[],effects=[],listeners=new Set(),calls=[],docs=new Map(['canvas-a','canvas-b'].map(id=>[id,doc(id)]));
  let index=0,root,thread=initialThread,override;
  const flow={fitView(){},screenToFlowPosition:value=>value};
  const react={createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
    useRef(initial){const i=index++;return slots[i]||=( {current:initial});},
    useCallback(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((value,n)=>value!==old.deps[n]))slots[i]={deps,fn};return slots[i].fn;},
    useEffect(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((value,n)=>value!==old[n])){slots[i]=deps;effects.push(fn);}}};
  const api={subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},async request(method,args={}){
    calls.push({method,args});const changed=override?.(method,args);if(changed!==undefined)return changed;
    if(method==='bootstrap')return {canvases:[...docs.values()],canvasId:bindings[thread]||null,threadId:thread,notes:{}};
    if(method==='selection')return {threadId:thread,canvasId:bindings[thread]||null};
    if(method==='list')return [...docs.values()];
    if(method==='read'){if(args.select){assert.equal(args.threadId,thread);if(thread)bindings[thread]=args.canvasId;}return docs.get(args.canvasId);}
    throw Error('Unexpected UI request '+method);
  }};
  const code=transformSync(fs.readFileSync(path.join(__dirname,'../ui/app.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
  const sandbox={module:{exports:{}},window:{fastCanvas:api,addEventListener(){},removeEventListener(){}},document:{getElementById:()=>({})},crypto:require('node:crypto'),setTimeout:()=>0,clearTimeout(){},require(name){
    if(name==='react')return react;
    if(name==='react-dom/client')return {createRoot:()=>({render:value=>{root=value;}})};
    if(name==='@xyflow/react')return {useReactFlow:()=>flow,ReactFlow:'Flow',ReactFlowProvider:'Provider',Background:'Background',Controls:'Controls',Handle:'Handle',Position:{}};
    if(name.startsWith('./canvas-'))return require(path.join(__dirname,'../ui',name));
    return {};
  }};
  vm.runInNewContext(code,sandbox);const App=root.children[0].type;
  const render=()=>{index=0;const tree=App();for(const effect of effects.splice(0))effect();return tree;};
  return {calls,docs,bindings,render,setOverride:value=>{override=value;},
    async tick(){let tree;for(let n=0;n<3;n++){await new Promise(setImmediate);tree=render();}return tree;},
    emit(value){for(const listener of listeners)listener(value);},
    context(next,value={}){thread=next;for(const listener of listeners)listener({type:'context',threadId:next,...value});}};
}
function find(node,predicate){if(!node)return null;if(Array.isArray(node)){for(const child of node){const value=find(child,predicate);if(value)return value;}}else if(typeof node==='object'){if(predicate(node))return node;return find(node.children,predicate);}return null;}
const picker=tree=>find(tree,node=>node.props?.['aria-label']==='选择画布');

test('canvas UI starts empty with existing files and remains empty after refresh',async()=>{
  const f=fixture();f.render();let tree=await f.tick();assert.equal(picker(tree).props.value,'');assert.equal(f.calls.some(call=>call.method==='read'),false);
  f.emit({type:'refresh'});tree=await f.tick();assert.equal(picker(tree).props.value,'');assert.equal(f.calls.some(call=>call.method==='read'),false);
});
test('manual selection binds the current conversation and switching restores only its selected canvas',async()=>{
  const f=fixture('thread-a',{'thread-b':'canvas-b'});f.render();let tree=await f.tick();
  await picker(tree).props.onChange({target:{value:'canvas-a'}});tree=await f.tick();assert.equal(f.bindings['thread-a'],'canvas-a');
  f.context('thread-b');tree=await f.tick();assert.equal(picker(tree).props.value,'canvas-b');
  f.context(null);tree=await f.tick();assert.equal(picker(tree).props.value,'');
  f.context('new-thread');tree=await f.tick();assert.equal(picker(tree).props.value,'');
  f.context('thread-a');tree=await f.tick();assert.equal(picker(tree).props.value,'canvas-a');
  assert.equal(f.calls.filter(call=>call.method==='read'&&call.args.select).length,1,'automatic reads do not rewrite bindings');
});
test('a delayed old canvas read cannot reopen it after entering a new conversation',async()=>{
  const f=fixture('thread-a',{'thread-a':'canvas-a'}),delayed=deferred();
  f.setOverride((method,args)=>method==='read'&&args.canvasId==='canvas-a'?delayed.promise:undefined);
  f.render();await f.tick();f.context('new-thread');let tree=await f.tick();assert.equal(picker(tree).props.value,'');
  delayed.resolve(doc('canvas-a'));tree=await f.tick();assert.equal(picker(tree).props.value,'');
});
test('late selection lookup cannot overwrite a newer conversation and deletion does not select another canvas',async()=>{
  const f=fixture('thread-a',{'thread-a':'canvas-a','thread-b':'canvas-b'}),delayed=deferred();f.render();await f.tick();
  f.setOverride((method,args)=>method==='selection'&&args.threadId==='thread-b'?delayed.promise:undefined);
  f.context('thread-b');await f.tick();f.context('thread-a');let tree=await f.tick();assert.equal(picker(tree).props.value,'canvas-a');
  delayed.resolve({threadId:'thread-b',canvasId:'canvas-b'});tree=await f.tick();assert.equal(picker(tree).props.value,'canvas-a');
  f.docs.delete('canvas-a');f.emit({type:'refresh'});tree=await f.tick();assert.equal(picker(tree).props.value,'');assert(f.docs.has('canvas-b'));
});
