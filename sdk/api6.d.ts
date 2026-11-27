import type {JsonObject, JsonValue, RequestOptions} from './api5.js';
export type RemoteChatMethod = 'model/list'|'project/list'|'thread/list'|'thread/read'|'thread/turns/list'|'thread/items/list'|'thread/items/read'|'thread/start'|'thread/resume'|'thread/fork'|'thread/name/set'|'thread/archive'|'thread/unarchive'|'turn/start'|'turn/steer'|'turn/interrupt';
export interface RemoteChatEvent {sequence:number;method:string;params:JsonObject}
/** id is an opaque host token, not the native JSON-RPC id. */
export interface RemoteChatRequest {id:string;method:string;params:JsonObject & {threadId:string}}
export interface RemoteChatBootstrap {
  apiVersion:6;capabilityVersion:1;hostId:'local';connected:boolean;connectionEpoch:string;cursor:number;
  defaults:{model:string|null;effort:string|null;serviceTier:string|null;cwd:string|null};
  methods:RemoteChatMethod[];approvalMethods:string[];
}
export interface RemoteChatEvents {events:RemoteChatEvent[];cursor:number;reset:boolean;connectionEpoch:string}
export interface RemoteChatPending {requests:RemoteChatRequest[];cursor:number;connectionEpoch:string}
export interface RemoteChatCalls {
  'remoteChat.request':{args:{method:RemoteChatMethod;params?:JsonObject};result:JsonValue};
  'remoteChat.bootstrap':{args:Record<string,never>;result:RemoteChatBootstrap};
  'remoteChat.events':{args:{after?:number;waitMs?:number;connectionEpoch?:string};result:RemoteChatEvents};
  'remoteChat.pending':{args:Record<string,never>;result:RemoteChatPending};
  'remoteChat.respond':{args:{requestId:string;threadId:string;result:JsonObject};result:{accepted:true}};
}
/** Node activate(forge) only. Renderer SDK deliberately has no remoteChat API.
 * Requires API 6, remote.control, backend.node, remote-chat v1 and global scope.
 */
export interface ForgeRemoteChatBackend {
  request<M extends keyof RemoteChatCalls>(method:M,args:RemoteChatCalls[M]['args'],options?:RequestOptions):Promise<RemoteChatCalls[M]['result']>;
}
