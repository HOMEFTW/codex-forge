/** Nexus v1: request since Forge 0.4.0; connect/disconnect since 0.4.1. API 4 retains the API 3 contract. Paths are relative to connected vaults. */
export interface NexusVault { id:string; name:string; root:string; available:boolean }
export interface NexusFile { path:string; ext:string; size:number; mtime:number; ctime:number }
export interface NexusCompatibility { name:string; id:string; supported:string; unsupported:string; installed?:boolean }
export interface NexusTask { line:number; text:string; completed:boolean }
export interface NexusLink { target:string; path?:string|null; line:number; fragment?:string; ambiguous?:boolean; candidates?:string[] }
export interface NexusNote {
  path:string; name:string; properties:Record<string,unknown>; aliases:string[]; tags:string[];
  headings:{text:string;level:number;line:number}[]; links:NexusLink[]; tasks:NexusTask[];
  stats:{words:number;characters:number;lines:number;tasks:number;completed:number}; warnings:string[];
  mtime?:number; ctime?:number; size?:number; backlinks?:{path:string;line:number}[];
}
export type NexusDocument = {path:string;content:string;revision:string} & Partial<Omit<NexusNote,'path'>>;
export interface NexusSettingsValues { homepage:string; templatesFolder:string; dateFormat:string; timeFormat:string; dailyFolder:string; dailyFormat:string; dailyTemplate:string }
export type NexusSettings = NexusSettingsValues & {revision:string};
export interface NexusBookmark { type:string; title?:string; path?:string; items?:NexusBookmark[]; [key:string]:unknown }
export interface NexusWriteResult {path:string;revision:string;historyToken:string|null}
export interface NexusQueryResult {
  type:string;headers:string[];total:number;truncated:boolean;
  rows:{path:string;title:string;values:unknown[];task?:NexusTask;group?:unknown}[];
  view?:string;views?:{name:string;type:string}[];columns?:string[];summaries?:Record<string,unknown>;
}
export interface NexusChoice { id:string;name:string;label:string;type:string;supported:boolean;[key:string]:unknown }
export interface NexusVaultArgs {vaultId:string}
export interface NexusPathArgs extends NexusVaultArgs {path:string}
/** Existing writes require the SHA-256 from read; creation requires an explicit empty string. */
export interface NexusWriteArgs extends NexusPathArgs {expectedRevision:string}
export interface NexusCall<A,R> {args:A;result:R}
export interface NexusMethods {
  vaults:NexusCall<Record<string,never>,{vaults:NexusVault[];compatibility:NexusCompatibility[]}>;
  snapshot:NexusCall<NexusVaultArgs & {offset?:number;limit?:number},{vault:Omit<NexusVault,'available'>;files:NexusFile[];notes:NexusNote[];offset:number;nextOffset:number|null;truncated:boolean;warnings:string[];settings:NexusSettings;compatibility:NexusCompatibility[];totals:{files:number;notes:number;words:number}}>;
  read:NexusCall<NexusPathArgs,NexusDocument>;
  resolve:NexusCall<NexusVaultArgs & {target:string;source?:string},{path:string|null;fragment:string;ambiguous?:boolean;candidates?:string[]}>;
  search:NexusCall<NexusVaultArgs & {query?:string;limit?:number},{total:number;truncated:boolean;results:(NexusNote & {excerpt:string})[]}>;
  inspect:NexusCall<NexusPathArgs,NexusNote>;
  tags:NexusCall<NexusVaultArgs,{tag:string;count:number}[]>;
  graph:NexusCall<NexusVaultArgs & {path?:string},{total:number;truncated:boolean;nodes:{id:string;title:string;tags:string[]}[];edges:{source:string;target:string}[]}>;
  asset:NexusCall<NexusPathArgs,{mime:string;data:string}>;
  templates:NexusCall<NexusVaultArgs,NexusFile[]>;
  bookmarks:NexusCall<NexusVaultArgs,{items:NexusBookmark[];revision:string}>;
  settings:NexusCall<NexusVaultArgs,NexusSettings>;
  history:NexusCall<NexusVaultArgs & {path?:string},{token:string;path:string;kind:string;at:string;retainedPath?:string}[]>;
  query:NexusCall<NexusVaultArgs & (
    {language?:'dataview';query:string;source?:string} |
    {language:'base';view?:string;source?:string} & ({path:string;query?:never}|{query:string;path?:never}) |
    {language:'expression';query:string;source:string}
  ),NexusQueryResult | {value:unknown}>;
  quickadd_choices:NexusCall<NexusVaultArgs,NexusChoice[]>;
  quickadd_plan:NexusCall<NexusVaultArgs & {choiceId:string;path?:string;variables?:Record<string,unknown>},{path:string;content:string;expectedRevision:string;exists:boolean}>;
  write:NexusCall<NexusWriteArgs & {content:string;mode?:'replace'|'append'|'prepend'},NexusWriteResult>;
  properties:NexusCall<NexusWriteArgs & {values:Record<string,unknown>;remove?:string[]},NexusWriteResult>;
  task:NexusCall<NexusWriteArgs & {line:number;completed:boolean},NexusWriteResult>;
  table:NexusCall<NexusWriteArgs & {line:number;action:'format'|'add_row'|'remove_row'|'add_column'|'remove_column';row?:number;column?:number;values?:string[]},NexusWriteResult>;
  outline:NexusCall<NexusWriteArgs & {line:number;action:'indent'|'outdent'|'up'|'down'},NexusWriteResult>;
  rename:NexusCall<NexusWriteArgs & {destination:string},NexusWriteResult & {referencesToUpdate:string[];notice:string}>;
  trash:NexusCall<NexusWriteArgs,{path:string;restoreToken:string}>;
  restore:NexusCall<NexusVaultArgs & {token:string;expectedRevision:string},NexusWriteResult>;
  template:NexusCall<NexusWriteArgs & {template:string;variables?:Record<string,unknown>;append?:boolean},NexusWriteResult>;
  daily:NexusCall<NexusVaultArgs & {expectedRevision:string;date?:string;variables?:Record<string,unknown>},NexusDocument | (NexusWriteResult & {content:string})>;
  bookmarks_write:NexusCall<NexusVaultArgs & {items:NexusBookmark[];expectedRevision:string},NexusWriteResult>;
  settings_write:NexusCall<NexusVaultArgs & {values:Partial<NexusSettingsValues>;expectedRevision:string},NexusSettings>;
  quickadd:NexusCall<NexusVaultArgs & {choiceId:string;expectedRevision:string;path?:string;variables?:Record<string,unknown>},NexusWriteResult>;
}
export interface NexusAPI {
  /** Native directory picker only; requires nexus.read and nexus.write. Not available to MCP. */
  connect():Promise<{vault:NexusVault}|null>;
  disconnect(vaultId:string):Promise<NexusVault[]>;
  request<M extends keyof NexusMethods>(method:M,...args: {} extends NexusMethods[M]['args'] ? [args?:NexusMethods[M]['args']] : [args:NexusMethods[M]['args']]):Promise<NexusMethods[M]['result']>;
}
