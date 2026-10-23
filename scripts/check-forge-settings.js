async (page) => {
  const c=await page.context().newCDPSession(page);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Page.setWebLifecycleState',{state:'active'});
  const menu=await page.getByRole('menubar').getByRole('menuitem').allTextContents();
  if(menu.slice(-3).join(',')!=='帮助,升级,插件管理')throw Error('Toolbar order: '+menu);
  await page.getByRole('menuitem',{name:'插件管理',exact:true}).click();
  const f=page.locator('iframe[title="Codex Forge"]:visible').contentFrame();
  await f.getByRole('button',{name:'Hello Forge 设置',exact:true}).click();
  await page.locator('[data-forge-settings-mount]').waitFor();
  const settings=page.locator('[data-forge-settings-mount] iframe').contentFrame();
  await settings.getByRole('heading',{name:'Codex Forge 插件设置',exact:true}).waitFor();
  const card=settings.locator('[id="forge-settings-example.hello"]');
  await card.locator('input').fill('Forge UI verified');await card.getByRole('button',{name:'保存设置',exact:true}).click();
  await card.getByText('已保存',{exact:true}).waitFor();
  if(!(await card.getAttribute('class')).includes('forge-selected'))throw Error('Plugin settings not focused');
  await page.screenshot({path:'output/forge-settings-native.png'});
  return {toolbarOrder:menu.slice(-3),nativeSettings:true,deepLink:true,settingsSaved:true,focusedPlugin:'example.hello'};
}
