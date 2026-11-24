'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CanvasStore}=require('../runtime/store.cjs');
const {CanvasSessions}=require('../runtime/canvas-sessions.cjs');
const {ThreadContexts}=require('../runtime/context.cjs');
const {callTool}=require('../runtime/mcp.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-canvas-session-')),store=new CanvasStore(root),opened=[],events=[];
  const state=threadId=>({threadId,canvasId:null,page:'canvas',visible:false,win:{isDestroyed:()=>false,webContents:{send:(...args)=>events.push(args)}}});
  const a=state(null),b=state('thread-b'),states=new Map([[1,a],[2,b]]);
  const make=()=>new CanvasSessions({store,states,context:s=>s.threadId,open:(s,value)=>{opened.push({state:s,...value});},notify:(s,value)=>events.push(value)});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store,a,b,opened,events,make};
}
test('startup ignores previous open signal and new chats have no selected canvas',async t=>{
  const f=fixture(t),doc=await f.store.create('old');f.store.signal(doc.id,[],'thread-a');const sessions=f.make();
  sessions.signal();assert.equal(f.opened.length,0);assert.equal(sessions.current(f.a).canvasId,null);
  f.a.threadId='new-thread';sessions.changed(f.a);assert.equal(f.a.canvasId,null);assert.equal(f.opened.length,0);
  assert.equal(f.store.list().length,1);
});
test('conversation selections persist independently and switching to a draft clears the old canvas',async t=>{
  const f=fixture(t),a=await f.store.create('A'),b=await f.store.create('B'),sessions=f.make();
  f.a.threadId='thread-a';sessions.remember(f.a,'thread-a',a.id);sessions.remember(f.b,'thread-b',b.id);
  const restarted=f.make();assert.equal(restarted.current(f.a).canvasId,a.id);assert.equal(new CanvasStore(f.root).forThread('thread-b'),b.id);
  f.a.threadId='thread-b';restarted.changed(f.a);assert.equal(f.a.canvasId,b.id);assert.equal(f.opened.at(-1).canvasId,b.id);
  f.a.threadId=null;restarted.changed(f.a);assert.equal(f.a.canvasId,null);assert.equal(f.a.visible,false);
  f.a.threadId='thread-a';restarted.changed(f.a);assert.equal(f.opened.at(-1).canvasId,a.id);
  await f.store.delete(a.id,0);assert.equal(restarted.current(f.a).canvasId,null,'deleted selection never falls back to B');
});
test('background model signals are bound to their source thread and do not take over another chat',async t=>{
  const f=fixture(t),a=await f.store.create('A'),b=await f.store.create('B'),sessions=f.make();f.a.threadId='thread-a';
  f.store.signal(b.id,[],'thread-b');sessions.signal();assert.equal(f.opened.length,1);assert.equal(f.opened[0].state,f.b);
  f.store.signal(a.id,[],'closed-thread');sessions.signal();assert.equal(f.opened.length,1);assert.equal(f.store.forThread('closed-thread'),a.id);
  f.store.signal(a.id);sessions.signal();assert.equal(f.opened.length,1,'unscoped signal cannot select a random window');
  f.a.threadId='closed-thread';sessions.changed(f.a);assert.equal(f.opened.at(-1).canvasId,a.id);
});
test('a late create remains associated with its original conversation and stale selection is rejected',async t=>{
  const f=fixture(t),doc=await f.store.create('late'),sessions=f.make();f.a.threadId='thread-b';
  sessions.remember(f.a,'thread-a',doc.id);assert.equal(f.a.canvasId,null);assert.equal(f.store.forThread('thread-a'),doc.id);
  assert.throws(()=>sessions.check(f.a,'thread-a'),/对话已变化/);
});
test('MCP canvas mutations use the host-issued thread context, not caller-supplied IDs',async t=>{
  const f=fixture(t),contexts=new ThreadContexts(f.root),token='a'.repeat(64),before=process.env.CODEX_FAST_CONTEXT_TOKEN;
  contexts.write(token,{threadId:'thread-a',cwd:f.root});process.env.CODEX_FAST_CONTEXT_TOKEN=token;
  t.after(()=>{if(before===undefined)delete process.env.CODEX_FAST_CONTEXT_TOKEN;else process.env.CODEX_FAST_CONTEXT_TOKEN=before;});
  const doc=await callTool(f.store,'canvas_create',{title:'model',threadId:'forged'});
  assert.equal(f.store.forThread('thread-a'),doc.id);assert.equal(f.store.forThread('forged'),null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.open.json'))).threadId,'thread-a');
});
