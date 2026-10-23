const forge=window.CodexForge;
forge.commands.register('hello',async()=>{
  const settings=await forge.settings.get();
  const draft=await forge.composer.read();
  await forge.composer.insertText(settings.greeting,draft.text);
  await forge.output.append(settings.greeting,{title:'示例问候'});
  const count=(await forge.storage.get('greetings')||0)+1;
  await forge.storage.set('greetings',count);
});
