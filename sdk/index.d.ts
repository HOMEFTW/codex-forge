import type { NexusAPI } from './nexus.js';
import type { API5Extensions, API5ConversationMethods, API5SettingsMethods, ForgeSlotName, JsonObject } from './api5.js';
export * from './nexus.js';
export * from './api5.js';
export interface ForgeError extends Error {code:string}
export interface CapabilityState {name:string;version:number;optional:boolean;supported:boolean;enabled:boolean;granted:boolean}
export type ForgeApiVersion = 1|2|3|4|5;
export interface Context<V extends ForgeApiVersion = 5> {threadId:string|null;generation?:number;codexVersion:string;forgeVersion:string;apiVersion:V;hostApiVersion:5}
export interface ContributionIcon {viewBox:'0 0 24 24';paths:string[]}
export interface Contribution {id:string;title:string;command?:string;panel?:string;icon?:ContributionIcon}
export interface ForgeEventMetadata {sourcePluginId?:string;threadId?:string|null}
export interface ForgeCapabilities<V extends ForgeApiVersion = 5> {apiVersion:V;hostApiVersion:5;supportedApiVersions:ForgeApiVersion[];codexVersion:string;forgeVersion:string;permissions:string[];capabilities:{name:string;version:number;optional:boolean}[];available:Record<string,number>;negotiated:CapabilityState[];denied:Record<string,string>;slots:{id:ForgeSlotName;kind:string;scope:string;label:string}[];events:string[];surfaces:string[]}
export interface ForgeDiagnostics {at:string;href:string;title:string;nodes:number;slots:{id:ForgeSlotName;kind:string;label:string;anchor:string|null;verified:boolean;matches:number;samples:unknown[]}[];probes:{name:string;selector:string;matches:number;samples:unknown[]}[]}
export interface ForgeAPI<V extends ForgeApiVersion = 5> extends API5Extensions {
  readonly apiVersion:V;
  readonly hostApiVersion:5;
  context:{get():Promise<Context<V>>};
  events:{on(name:'slot.changed',listener:(value:JsonObject,metadata?:ForgeEventMetadata)=>void):()=>void;on(name:'ready'|'context.changed'|'settings.changed'|'theme.changed'|'dispose'|'output.changed'|`plugin.${string}`|`conversation.${string}`,listener:(value:any,metadata?:ForgeEventMetadata)=>void):()=>void;emit(name:string,value?:unknown):Promise<{accepted:boolean;name:string}>};
  commands:{register(id:string,handler:(args:any)=>unknown|Promise<unknown>):()=>void};
  panels:{open(id:string,options?:{mode?:'right'|'expanded'}):Promise<unknown>;close(id:string):Promise<unknown>};
  sidebar:{register(item:Contribution):()=>Promise<unknown>};
  toolbar:{register(item:Contribution):()=>Promise<unknown>};
  composer:{register(item:Contribution):()=>Promise<unknown>;read():Promise<{text:string}>;insertText(text:string,expectedText:string):Promise<{text:string}>;setText(text:string,expectedText:string):Promise<{text:string}>};
  conversations:{setTitle(title:string):Promise<{threadId:string;title:string}>} & API5ConversationMethods;
  output:{append(text:string,options?:{title?:string;level?:'info'|'warning'|'error'}):Promise<boolean>;clear():Promise<boolean>;open():Promise<boolean>};
  browser:{open(url:string):Promise<{opened:string}>};
  storage:{get<T=unknown>(key:string):Promise<T|null>;set(key:string,value:unknown):Promise<boolean>;delete(key:string):Promise<boolean>};
  settings:{get<T=Record<string,unknown>>():Promise<T>} & API5SettingsMethods;
  dsh:{request(endpoint:string,options?:{method?:'GET'|'POST';body?:Record<string,unknown>}):Promise<{status:number;body:unknown}>};
  nexus:NexusAPI;
  metadata:{get():Promise<Record<string,unknown>>};
  capabilities:{get():Promise<ForgeCapabilities<V>>};
  diagnostics:{get():Promise<ForgeDiagnostics>};
  devtools:{eval(code:string):Promise<{ms:number;result:{type:string;value?:string;truncated?:boolean}}|{error:string}>};
}
declare global {interface Window {readonly CodexForge:ForgeAPI}}
