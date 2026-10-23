async (page) => {
 const c=await page.context().newCDPSession(page);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.send('Page.setWebLifecycleState',{state:'active'});
 const frame=page.frames().find(f=>f.url()==='codex-forge://plugin/example.hello/main');if(!frame)throw Error('Example plugin frame missing');
 await frame.evaluate(()=>window.CodexForge.browser.open('https://example.com'));
 let browser;const limit=Date.now()+20000;
 while(Date.now()<limit){browser=page.context().pages().find(p=>p.url().startsWith('https://example.com'));if(browser)break;await new Promise(r=>setTimeout(r,100));}
 if(!browser)throw Error('Native browser page missing');await browser.waitForLoadState('domcontentloaded');
 const text=await browser.locator('body').innerText();if(await browser.title()!=='Example Domain'||text.length<50)throw Error('Web content did not load');
 await page.screenshot({path:'output/browser-no-login.png'});
 return {nativeBrowser:true,withoutOpenAILogin:true,url:browser.url(),title:await browser.title(),text:text.slice(0,250)};
}
