export interface Context {threadId:string|null;codexVersion:string;forgeVersion:string;apiVersion:2}
export interface Contribution {id:string;title:string;command?:string;panel?:string}
export interface ForgeEventMetadata {sourcePluginId?:string;threadId?:string|null}
export interface ForgeCapabilities {apiVersion:2;codexVersion:string;forgeVersion:string;permissions:string[];capabilities:{name:string;version:number;optional:boolean}[];available:Record<string,number>;denied:Record<string,string>;slots:{id:string;kind:string;scope:string;label:string}[];events:string[];surfaces:string[]}
export interface ForgeDiagnostics {at:string;href:string;title:string;nodes:number;slots:{id:string;kind:string;label:string;anchor:string|null;verified:boolean;matches:number;samples:unknown[]}[];probes:{name:string;selector:string;matches:number;samples:unknown[]}[]}
export interface ForgeAPI {
  readonly apiVersion:2;
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
  diagnostics:{get():Promise<ForgeDiagnostics>};
  devtools:{eval(code:string):Promise<{ms:number;result:{type:string;value?:string;truncated?:boolean}}|{error:string}>};
}
declare global {interface Window {readonly CodexForge:ForgeAPI}}
