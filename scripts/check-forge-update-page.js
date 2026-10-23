async(page)=>{
 const c=await page.context().newCDPSession(page);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Page.setWebLifecycleState',{state:'active'});
 await page.getByRole('menuitem',{name:'升级',exact:true}).click();
 const panel=page.locator('[data-fast-native-page="forge-updates"] iframe').contentFrame();
 await panel.getByRole('button',{name:'扩展插件功能与升级日志',exact:true}).waitFor();
 const info=await panel.locator('.forge-info-buttons button').allTextContents();
 if(info.join('|')!=='扩展插件功能与升级日志|Forge 功能介绍|Forge 升级日志')throw Error('Information buttons out of order');
 await panel.getByRole('button',{name:'检查 Codex 与 Forge 更新',exact:true}).click();
 await panel.getByText('检查时间：',{exact:false}).waitFor({timeout:45000});
 const status=await panel.locator('.forge-card').innerText();
 if(!status.includes('Codex：')||!status.includes('Forge：'))throw Error('Missing separate update results');
 await page.screenshot({path:'output/forge-updates-native.png'});
 return {buttons:info,separateSources:true,result:status};
}
