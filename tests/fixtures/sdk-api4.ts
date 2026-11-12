import type {ForgeAPI, NexusWriteResult, NexusDocument} from '../../sdk/index.js';
declare const forge:ForgeAPI;
const api:4 = forge.apiVersion;
forge.nexus.request('vaults').then(value => value.vaults[0]?.id);
forge.nexus.connect().then(value => value?.vault.id);
forge.nexus.disconnect('v');
// @ts-expect-error directories are chosen by the native dialog, never by plugin input
forge.nexus.connect({root:'D:/private'});
const read:Promise<NexusDocument> = forge.nexus.request('read',{vaultId:'v',path:'note.md'});
const write:Promise<NexusWriteResult> = forge.nexus.request('write',{vaultId:'v',path:'note.md',expectedRevision:'',content:'new'});
forge.nexus.request('snapshot',{vaultId:'v',offset:500,limit:500}).then(page=>page.nextOffset);
forge.nexus.request('query',{vaultId:'v',language:'expression',query:'file.name',source:'note.md'});
forge.capabilities.get().then(value=>value.negotiated.some(item=>item.supported && item.enabled && item.granted));
// @ts-expect-error directory connection belongs to the native UI
forge.nexus.request('connect',{path:'D:/private'});
// @ts-expect-error file access requires a connected vault identity
forge.nexus.request('read',{path:'note.md'});
// @ts-expect-error required args cannot be omitted
forge.nexus.request('write');
// @ts-expect-error writes require explicit revision
forge.nexus.request('write',{vaultId:'v',path:'note.md',content:'new'});
// @ts-expect-error only documented mutation actions are permitted
forge.nexus.request('table',{vaultId:'v',path:'note.md',expectedRevision:'abc',line:0,action:'execute'});
// @ts-expect-error inline expressions require a source note
forge.nexus.request('query',{vaultId:'v',language:'expression',query:'file.name'});

forge.sidebar.register({id:'notes',title:'Notes',panel:'main',icon:{viewBox:'0 0 24 24',paths:['M0 0L2 2']}});
// @ts-expect-error arbitrary viewBox is not part of the icon contract
forge.sidebar.register({id:'notes',title:'Notes',icon:{viewBox:'0 0 1 1',paths:[]}});

declare const legacy:ForgeAPI<1>;
const legacyVersion:1 = legacy.apiVersion;
const hostVersion:4 = legacy.hostApiVersion;
legacy.context.get().then(context => { const api:1=context.apiVersion; });
