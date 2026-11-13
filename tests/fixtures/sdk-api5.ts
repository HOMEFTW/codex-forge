import type { ForgeAPI, ForgeStream, SettingsSnapshot, FileDocument, JsonObject, ForgeSlotName } from '../../sdk/index.js';
declare const forge:ForgeAPI;
const version:5 = forge.apiVersion;
declare const legacy:ForgeAPI<4>;
const older:4 = legacy.apiVersion;
const host:5 = legacy.hostApiVersion;
const controller = new AbortController();
const sampled = forge.llm.sample({ prompt:'Summarize', model:'model' }, { signal:controller.signal, timeoutMs:1000 });
sampled.then(value => value.text);
forge.llm.providers().then(value=>value.providers[0]?.models?.[0]?.id);
forge.events.on('slot.changed',value=>{const projection:JsonObject=value;return projection;});
const slot:ForgeSlotName='conversation.message.action';
// @ts-expect-error only host-declared slots can be selected
const unknownSlot:ForgeSlotName='command.menu.item';
const channel:ForgeStream<{ok:boolean},{query:string}> = forge.services.channel('example.provider','echo');
channel.send({ query:'hello' }); channel.end(); channel.dispose();
// @ts-expect-error a typed stream validates uplink values
channel.send({ other:true });
forge.conversations.events().next().then(value => value.value?.method);
forge.conversations.send({ text:'hello' });
// @ts-expect-error send requires explicit message text
forge.conversations.send({ threadId:'id' });
const snapshot:Promise<SettingsSnapshot> = forge.settings.snapshot();
forge.settings.set({ enabled:true },'revision');
// @ts-expect-error settings updates require a read revision
forge.settings.set({ enabled:true });
const document:Promise<FileDocument> = forge.files.request('read',{ root:'connected',path:'note.md' });
forge.files.request('write',{ root:'connected',path:'note.md',content:'new',expectedRevision:'' });
// @ts-expect-error file writes require optimistic concurrency
forge.files.request('write',{ root:'connected',path:'note.md',content:'new' });
// @ts-expect-error a connection uses the native directory picker
forge.files.request('connect',{ root:'D:/private' });
forge.schedules.request('create',{ name:'poll',method:'refresh',timing:{kind:'every',intervalMs:1000} });
forge.schedules.request('update',{ id:'id',expectedRevision:1,patch:{enabled:false} });
forge.schedules.request('read',{id:'id'}).then(record=>forge.schedules.request('update',{id:record.id,expectedRevision:record.revision,patch:{enabled:false}}));
// @ts-expect-error schedule revisions are numeric counters
forge.schedules.request('delete',{id:'id',expectedRevision:'revision'});
// @ts-expect-error schedule updates require optimistic concurrency
forge.schedules.request('update',{ id:'id',patch:{enabled:false} });
// @ts-expect-error the task runtime uses enabled, not an ignored active field
forge.schedules.request('update',{ id:'id',expectedRevision:1,patch:{active:false} });
// @ts-expect-error unsupported timing kinds are not silently accepted
forge.schedules.request('create',{ name:'poll',method:'refresh',timing:{kind:'hourly'} });
forge.dsh.request('installed');
forge.shell.execute({ executable:'node',args:['--version'] });
// @ts-expect-error plugins cannot choose a shell working directory through this API
forge.shell.execute({ executable:'node',cwd:'D:/private' });
