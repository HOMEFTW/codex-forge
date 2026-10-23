async(page)=>{
  const c=await page.context().newCDPSession(page);
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await c.send('Page.setWebLifecycleState',{state:'active'});
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  await page.getByRole('menuitem',{name:'插件管理',exact:true}).click();
  const manager=page.locator('[data-fast-native-page="forge-plugins"] iframe').contentFrame();
  const card=manager.locator('article').filter({has:manager.getByRole('heading',{name:'Hello Forge',exact:true})});
  if(await card.getByRole('button',{name:'启用',exact:true}).count())await card.getByRole('button',{name:'启用',exact:true}).click();
  await card.getByRole('button',{name:'打开Hello Forge',exact:true}).waitFor();
  const thread=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const id='forge-smoke-'+crypto.randomUUID(),timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(Error('thread/start timed out'));},15000);
    const listener=event=>{const d=event.data;if(d?.type==='mcp-response'&&d.message?.id===id){clearTimeout(timer);window.removeEventListener('message',listener);d.message.error?reject(Error(d.message.error.message)):resolve(d.message.result.thread);}};window.addEventListener('message',listener);
    window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request:{id,method:'thread/start',params:{cwd:'D:\\Code\\codex-forge',model:'gpt-6.1-sol',modelProvider:'fixture'}},priority:'interactive',source:'thread',timeoutMs:15000}).catch(reject);
  }));
  await page.evaluate(id=>window.dispatchEvent(new MessageEvent('message',{data:{type:'navigate-to-route',path:'/local/'+id}})),thread.id);
  await page.locator('[data-codex-composer-root] [contenteditable=true]').waitFor();
  await page.getByRole('button',{name:'插入问候',exact:true}).click();
  await page.locator('[data-codex-composer-root] [contenteditable=true]').filter({hasText:'Forge UI verified'}).waitFor();
  await page.locator('#forge-chat-output details').waitFor();
  await page.getByRole('button',{name:'Forge 示例',exact:true}).click();
  const plugin=page.locator('iframe.forge-plugin-frame:visible').contentFrame();
  await plugin.getByRole('button',{name:'读取上下文',exact:true}).click();
  await plugin.locator('#result').filter({hasText:thread.id}).waitFor();
  await plugin.locator('#title').fill('Forge 插件原生接口验证');await plugin.getByRole('button',{name:'修改当前会话标题',exact:true}).click();
  await plugin.locator('#result').filter({hasText:'Forge 插件原生接口验证'}).waitFor();
  await plugin.getByRole('button',{name:'输出问候',exact:true}).click();
  await plugin.locator('#result').filter({hasText:'已输出到当前对话'}).waitFor();
  check(await page.locator('#forge-chat-output details').count()===2,'Expected two foldable outputs');
  const panel=page.locator('[data-fast-native-page^="forge-plugin:"]');check(await panel.evaluate(e=>!!e.closest('[role="tabpanel"]')),'Plugin panel is not native');
  await page.screenshot({path:'output/forge-plugin-native.png'});
  await plugin.getByRole('button',{name:'打开项目网页',exact:true}).click();
  const pluginFrame=page.frames().find(f=>f.url()==='codex-forge://plugin/example.hello/main');
  await pluginFrame.locator('#result').filter({hasText:'opened'}).waitFor({state:'attached'});
  const browserDeadline=Date.now()+15000;while(!page.context().pages().some(p=>p.url()==='https://github.com/HOMEFTW/codex-forge')&&Date.now()<browserDeadline)await new Promise(resolve=>setTimeout(resolve,100));
  check(page.context().pages().some(p=>p.url()==='https://github.com/HOMEFTW/codex-forge'),'Browser page did not open');
  return {threadId:thread.id,enabled:true,composer:true,context:true,title:true,foldableOutput:true,nativeTab:true,browserDispatched:true};
}
