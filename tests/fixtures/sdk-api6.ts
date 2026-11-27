import type {ForgeAPI, ForgeRemoteChatBackend, RemoteChatBootstrap, RemoteChatEvents} from '../../sdk/index.js';
declare const forge:ForgeAPI;
const api:6=forge.apiVersion;
declare const backend:ForgeRemoteChatBackend;
backend.request('remoteChat.bootstrap',{}).then((value:RemoteChatBootstrap)=>value.defaults.model);
backend.request('remoteChat.events',{after:1,waitMs:20000,connectionEpoch:'epoch'}).then((value:RemoteChatEvents)=>value.reset);
backend.request('remoteChat.request',{method:'turn/steer',params:{threadId:'A',expectedTurnId:'T',input:[{type:'text',text:'hello'}]}});
// @ts-expect-error internal configuration is not remotely exposed
backend.request('remoteChat.request',{method:'config/read'});
// @ts-expect-error renderer SDK does not expose remoteChat
forge.remoteChat;
// @ts-expect-error response requires an opaque pending request identity
backend.request('remoteChat.respond',{threadId:'A',result:{decision:'accept'}});
