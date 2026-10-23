async(page)=>{
  const c=await page.context().newCDPSession(page);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Page.setWebLifecycleState',{state:'active'});
  await page.getByRole('menuitem',{name:'插件管理',exact:true}).click();
  const manager=page.locator('[data-fast-native-page="forge-plugins"] iframe').contentFrame();
  const card=manager.locator('article').filter({has:manager.getByRole('heading',{name:'Hello Forge',exact:true})});
  await card.getByRole('button',{name:'停用',exact:true}).click();
  await page.getByRole('button',{name:'Forge 示例',exact:true}).waitFor({state:'detached'});
  await page.locator('iframe.forge-plugin-frame').waitFor({state:'detached'});
  await card.getByRole('button',{name:'启用',exact:true}).click();
  await page.getByRole('button',{name:'Forge 示例',exact:true}).waitFor();
  return {disabledContributionsRemoved:true,disabledFramesRemoved:true,reenabled:true};
}
