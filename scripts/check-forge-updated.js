async(page)=>{
  const c=await page.context().newCDPSession(page);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Page.setWebLifecycleState',{state:'active'});
  await page.getByRole('menuitem',{name:'插件管理',exact:true}).click();
  const manager=page.locator('[data-fast-native-page="forge-plugins"] iframe').contentFrame();
  const card=manager.locator('article').filter({has:manager.getByRole('heading',{name:'Update Fixture',exact:true})});
  await card.getByText('已更新至 0.1.1',{exact:true}).waitFor();
  await card.getByRole('button',{name:'停用',exact:true}).waitFor();
  await card.getByRole('button',{name:'Update Fixture 设置',exact:true}).click();
  const settings=page.locator('[data-forge-settings-mount] iframe').contentFrame();
  const saved=settings.locator('[id="forge-settings-example.update"] input');
  await saved.waitFor();if(await saved.inputValue()!=='Preserved through restart')throw Error('Settings were lost during update');
  await settings.getByRole('button',{name:'管理插件',exact:true}).click();
  await card.getByRole('button',{name:'卸载',exact:true}).click();
  await card.getByRole('alertdialog',{name:'卸载 Update Fixture',exact:true}).getByRole('button',{name:'确认卸载',exact:true}).click();
  await card.waitFor({state:'detached'});
  return {exeStartup:true,updateApplied:'0.1.1',settingsPreserved:true,settingsReturnNavigation:true,uninstall:true};
}
