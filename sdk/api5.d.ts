export type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]:JsonValue };
export type JsonObject = { [key:string]:JsonValue };
export type ForgeSlotName = 'conversation.header.action'|'sidebar.right.body'|'tool.card.view'|'composer.leading'|'composer.trailing'|'conversation.message.action'|'settings.section';
export interface RequestOptions {signal?:AbortSignal;timeoutMs?:number}
export interface StreamOptions extends RequestOptions {lifetimeMs?:number}
export interface ForgeStream<Out=JsonValue,In=JsonValue> extends AsyncIterableIterator<Out> {
  send(value:In):Promise<{accepted:boolean}>;
  end():Promise<{ended:boolean}>;
  dispose():Promise<{closed:boolean}>;
}
export interface ServiceAPI {request<R=JsonValue>(method:string,args?:JsonObject,options?:RequestOptions):Promise<R>}
export interface ConversationSelector {threadId?:string}
export interface ConversationPage extends ConversationSelector {cursor?:string;limit?:number}
export interface ConversationCreate {model?:string}
export interface ConversationSend extends ConversationSelector {text:string}
export interface ConversationEvent {method:string;threadId:string;sequence:number;params:JsonValue}
export interface LlmRequest {prompt:string;provider?:string;model?:string;effort?:'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra';timeoutMs?:number;outputSchema?:JsonObject;[key:string]:JsonValue|undefined}
export interface LlmResult {text:string;usage?:JsonObject;[key:string]:unknown}
export interface LlmChunk {type?:string;text?:string;delta?:string;[key:string]:unknown}
export interface ModelProvider {name:string;models?:{id:string;name?:string}[];pluginId?:string}
export interface NetworkFetchRequest {url:string;method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD';headers?:Record<string,string>;body?:string;credential?:string;encoding?:'utf8'|'base64'}
export interface NetworkFetchResult {status:number;headers?:Record<string,string>;body?:string;[key:string]:unknown}
export interface ShellRequest {executable:string;args?:string[];timeoutMs?:number}
export interface ShellResult {stdout:string;stderr:string;code:number|null;signal:string|null}
export interface FileLocation {root?:string;path:string}
export interface FileDocument {content:string;encoding:'utf8'|'base64';bytes:number;revision:string}
export interface FileWriteResult {revision:string;bytes:number}
export interface FileMethods {
  connect:{args:Record<string,never>;result:JsonValue};
  roots:{args:Record<string,never>;result:JsonValue};
  disconnect:{args:{root:string};result:JsonValue};
  list:{args:{root?:string;path?:string};result:JsonValue};
  stat:{args:FileLocation;result:JsonValue};
  read:{args:FileLocation & {encoding?:'utf8'|'base64'};result:FileDocument};
  write:{args:FileLocation & {content:string;expectedRevision:string;encoding?:'utf8'|'base64'};result:FileWriteResult};
  remove:{args:FileLocation & {expectedRevision:string};result:JsonValue};
  rename:{args:FileLocation & {expectedRevision:string;destination:string};result:JsonValue};
  restore:{args:FileLocation & {restoreToken:string};result:FileWriteResult};
}
export interface FilesAPI {
  request<M extends keyof FileMethods>(method:M,...args:keyof FileMethods[M]['args'] extends never ? [args?:FileMethods[M]['args'],options?:RequestOptions] : [args:FileMethods[M]['args'],options?:RequestOptions]):Promise<FileMethods[M]['result']>;
  watch(args:FileLocation,options?:StreamOptions):ForgeStream<JsonValue>;
}
export type ScheduleTiming = {kind:'at';at:string}|{kind:'every';intervalMs:number}|{kind:'cron';expression:string;timeZone?:string};
export interface ScheduleCreate {name:string;method:string;args?:JsonObject;timing:ScheduleTiming;enabled?:boolean;timeoutMs?:number}
export interface ScheduleRecord extends ScheduleCreate {id:string;pluginId:string;revision:number;enabled:boolean;createdAt:number;updatedAt:number;nextAt:number|null;activeJobId:string|null;history:string[]}
export interface ScheduleMethods {
  list:{args:Record<string,never>;result:ScheduleRecord[]};
  read:{args:{id:string};result:ScheduleRecord};
  create:{args:ScheduleCreate;result:ScheduleRecord};
  update:{args:{id:string;expectedRevision:number;patch:Partial<ScheduleCreate>};result:ScheduleRecord};
  delete:{args:{id:string;expectedRevision:number};result:{removed:string}};
  run:{args:{id:string};result:JsonValue};
}
export interface SchedulesAPI {
  request<M extends keyof ScheduleMethods>(method:M,...args:keyof ScheduleMethods[M]['args'] extends never ? [args?:ScheduleMethods[M]['args'],options?:RequestOptions] : [args:ScheduleMethods[M]['args'],options?:RequestOptions]):Promise<ScheduleMethods[M]['result']>;
}
export interface ThemeDefinition {id:string;name?:string;tokens:Record<string,string>}
export interface Shortcut {id:string;key:string;command:string}
export interface LogEntry {level?:'debug'|'info'|'warning'|'error';message:string;data?:JsonValue}
export interface SettingsSnapshot<T=Record<string,unknown>> {value:T;revision:string}
export interface API5ConversationMethods {
  list(args?:{cursor?:string;limit?:number},options?:RequestOptions):Promise<Record<string,unknown>>;
  read(args?:ConversationPage,options?:RequestOptions):Promise<Record<string,unknown>>;
  create(args?:ConversationCreate,options?:RequestOptions):Promise<Record<string,unknown>>;
  fork(args?:ConversationSelector,options?:RequestOptions):Promise<Record<string,unknown>>;
  send(args:ConversationSend,options?:RequestOptions):Promise<Record<string,unknown>>;
  cancel(args:ConversationSelector & {turnId:string},options?:RequestOptions):Promise<Record<string,unknown>>;
  events(args?:ConversationSelector & {after?:number},options?:StreamOptions):ForgeStream<ConversationEvent>;
  on(name:string,listener:(value:unknown,metadata?:{sourcePluginId?:string;threadId?:string|null})=>void):()=>void;
}
export interface API5SettingsMethods {
  snapshot<T=Record<string,unknown>>(options?:RequestOptions):Promise<SettingsSnapshot<T>>;
  set<T=Record<string,unknown>>(value:Record<string,unknown>,expectedRevision:string,options?:RequestOptions):Promise<SettingsSnapshot<T>>;
}
/** Methods added in API 5. The host independently checks every declared permission and capability. */
export interface API5Extensions {
  rpc:{stream<Out=JsonValue,In=JsonValue>(method:string,args?:JsonObject,options?:StreamOptions):ForgeStream<Out,In>};
  llm:{providers(options?:RequestOptions):Promise<{providers:ModelProvider[]}>;sample(args:LlmRequest,options?:RequestOptions):Promise<LlmResult>;stream(args:LlmRequest,options?:StreamOptions):ForgeStream<LlmChunk>};
  services:{request<R=JsonValue>(name:string,method:string,args?:JsonObject,options?:RequestOptions):Promise<R>;channel<Out=JsonValue,In=JsonValue>(name:string,method:string,args?:JsonObject,options?:StreamOptions):ForgeStream<Out,In>};
  backend:{call<R=JsonValue>(method:string,args?:JsonObject,options?:RequestOptions):Promise<R>;channel<Out=JsonValue,In=JsonValue>(method:string,args?:JsonObject,options?:StreamOptions):ForgeStream<Out,In>};
  tools:{list(options?:RequestOptions):Promise<JsonValue>;call<R=JsonValue>(name:string,args?:JsonObject,options?:RequestOptions):Promise<R>};
  plugins:{list(args?:JsonObject,options?:RequestOptions):Promise<JsonValue>;catalog(args?:JsonObject,options?:RequestOptions):Promise<JsonValue>;install(entry:string|{source?:string;id:string},options?:RequestOptions):Promise<JsonValue>;checkUpdate(id:string,options?:RequestOptions):Promise<JsonValue>;update(id:string,options?:RequestOptions):Promise<JsonValue>;enable(id:string,enabled:boolean,options?:RequestOptions):Promise<JsonValue>;uninstall(id:string,options?:RequestOptions):Promise<JsonValue>};
  canvas:ServiceAPI;
  todos:ServiceAPI;
  skills:ServiceAPI;
  memory:ServiceAPI;
  statistics:ServiceAPI;
  collaboration:ServiceAPI;
  files:FilesAPI;
  shell:{execute(args:ShellRequest,options?:RequestOptions):Promise<ShellResult>};
  network:{fetch(args:NetworkFetchRequest,options?:RequestOptions):Promise<NetworkFetchResult>};
  credentials:{set(name:string,value:string,options?:RequestOptions):Promise<JsonValue>;delete(name:string,options?:RequestOptions):Promise<JsonValue>;describe(name:string,options?:RequestOptions):Promise<JsonValue>};
  jobs:ServiceAPI;
  schedules:SchedulesAPI;
  hooks:{list(options?:RequestOptions):Promise<JsonValue>};
  logs:{write(entry:LogEntry,options?:RequestOptions):Promise<JsonValue>;read(args?:{limit?:number;before?:number},options?:RequestOptions):Promise<JsonValue>};
  theme:{get(options?:RequestOptions):Promise<JsonValue>;set(id:string|null,options?:RequestOptions):Promise<JsonValue>;register(definition:ThemeDefinition,options?:RequestOptions):Promise<JsonValue>};
  shortcuts:{register(item:Shortcut):()=>Promise<unknown>;unregister(id:string):Promise<unknown>};
}
