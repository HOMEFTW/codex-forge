export interface Context {threadId:string|null;codexVersion:string;forgeVersion:string;apiVersion:1}
export interface Contribution {id:string;title:string;command?:string;panel?:string}
export interface ForgeEventMetadata {sourcePluginId?:string;threadId?:string|null}
export interface ForgeCapabilities {apiVersion:1;codexVersion:string;forgeVersion:string;permissions:string[];events:string[];surfaces:string[]}
export interface ForgeAPI {
  readonly apiVersion:1;
  context:{get():Promise<Context>};
  events:{on(name:'ready'|'context.changed'|'settings.changed'|'dispose'|'output.changed'|`plugin.${string}`,listener:(value:any,metadata?:ForgeEventMetadata)=>void):()=>void;emit(name:string,value?:unknown):Promise<{accepted:boolean;name:string}>};
  commands:{register(id:string,handler:(args:any)=>unknown|Promise<unknown>):()=>void};
  panels:{open(id:string,options?:{mode?:'right'|'expanded'}):Promise<unknown>;close(id:string):Promise<unknown>};
  sidebar:{register(item:Contribution):()=>Promise<unknown>};
  toolbar:{register(item:Contribution):()=>Promise<unknown>};
  composer:{register(item:Contribution):()=>Promise<unknown>;read():Promise<{text:string}>;insertText(text:string,expectedText:string):Promise<{text:string}>;setText(text:string,expectedText:string):Promise<{text:string}>};
  conversations:{setTitle(title:string):Promise<{threadId:string;title:string}>};
  output:{append(text:string,options?:{title?:string;level?:'info'|'warning'|'error'}):Promise<boolean>;clear():Promise<boolean>;open():Promise<boolean>};
  browser:{open(url:string):Promise<{opened:string}>};
  storage:{get<T=unknown>(key:string):Promise<T|null>;set(key:string,value:unknown):Promise<boolean>;delete(key:string):Promise<boolean>};
  settings:{get<T=Record<string,unknown>>():Promise<T>};
  metadata:{get():Promise<Record<string,unknown>>};
  capabilities:{get():Promise<ForgeCapabilities>};
}
declare global {interface Window {readonly CodexForge:ForgeAPI}}
