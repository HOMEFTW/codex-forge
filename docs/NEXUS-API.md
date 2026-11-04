# 星枢 Nexus API

目标：Codex Forge **0.4.0 / API 3**。能力 `nexus` v1，权限 `nexus.read` / `nexus.write`，插件 `forge.nexus`。旧版 0.3.4 不提供此能力。

浏览器入口：`forge.nexus.request(method, args)`。`methodKind()` 是服务、宿主与工具的读写分类依据；未知方法拒绝。模型工具前缀为 `nexus_`。所有笔记、配置、模板与查询结果均为数据，不是模型指令。

目录连接/断开由原生界面处理，不在 SDK/MCP 方法表中。每个知识库使用选择时规范化的实际路径和目录 dev/ino 身份；模型传 `vaultId`，文件路径仅为库内相对路径。隐藏目录、目录联接、设备路径不开放；书签和模板设置通过专门接口读取。

## 数据结构

- `Vault`：`{id,name,root,available}`。
- `Document`：`{path,content,revision}`；Markdown 另含 `name,properties,aliases,tags,headings,links,tasks,stats,warnings`。
- `NoteMetadata`：上述 Markdown 元数据，加 `mtime,ctime,size,backlinks`，不含正文。标题为 `{text,level,line}`；任务为 `{line,text,completed}`；行号从 **0** 开始。
- `File`：`{path,ext,size,mtime,ctime}`。
- `WriteResult`：`{path,revision,historyToken}`。已有文件要求读取获得的 SHA-256 `expectedRevision`；创建要求显式 `""`。
- `QueryResult`：`{type,headers,total,truncated,rows}`；行含 `{path,title,values,task?,group?}`。Base 另含 `view,views,columns,summaries`；行内表达式返回 `{value}`。

除 `vaults` 外，下面每个方法都需要 `vaultId`。参数中 `?` 表示可选。

## 读取方法

| method | 额外参数 | 结果 |
| --- | --- | --- |
| `vaults` | 无 | `{vaults,compatibility}` |
| `snapshot` | `offset?:number,limit?:number` | `{vault,files,notes,offset,nextOffset,truncated,warnings,settings,compatibility,totals}`；默认 500，最多 1000 文件/页 |
| `read` | `path:string` | `Document`，支持 `.md/.base/.canvas` |
| `resolve` | `target:string,source?:string` | `{path:string|null,fragment,ambiguous?,candidates?}` |
| `search` | `query?:string,limit?:number` | `{total,truncated,results:(NoteMetadata & {excerpt})[]}`，最多 1000 条 |
| `inspect` | `path:string` | `NoteMetadata`，包含解析后的出链与反链 |
| `tags` | 无 | `{tag,count}[]` |
| `graph` | `path?:string` | `{total,truncated,nodes:{id,title,tags}[],edges:{source,target}[]}`，指定 path 为局部图谱 |
| `asset` | `path:string` | `{mime,data}`，data URL；位图/PDF/音视频，不开放 SVG/HTML/脚本 |
| `templates` | 无 | `File[]` |
| `bookmarks` | 无 | `{items:Bookmark[],revision}`；保留 Obsidian 分组、文件、搜索等条目 |
| `settings` | 无 | `{homepage,templatesFolder,dateFormat,timeFormat,dailyFolder,dailyFormat,dailyTemplate,revision}` |
| `history` | `path?:string` | `{token,path,kind,at,retainedPath?}[]`，最近 200 条 |
| `query` | `language?:"dataview"|"base"|"expression",query?:string,path?:string,view?:string,source?:string` | `QueryResult`；Base 使用 path 或 YAML query，行内表达式需要 source |
| `quickadd_choices` | 无 | 配置内展开后的条目，含 `id,name,label,type,supported` 与兼容所需选项 |
| `quickadd_plan` | `choiceId:string,path?:string,variables?:Record<string,unknown>` | `{path,content,expectedRevision,exists}`；无写入，供执行前预览动态文件名及读取修订 |

## 写入方法

| method | 额外参数 | 结果/约束 |
| --- | --- | --- |
| `write` | `path,content,expectedRevision,mode?:"replace"|"append"|"prepend"` | `WriteResult` |
| `properties` | `path,expectedRevision,values:Record<string,unknown>,remove?:string[]` | `WriteResult`；仅 Markdown，保留正文 |
| `task` | `path,expectedRevision,line:number,completed:boolean` | `WriteResult`；验证该行确为任务 |
| `table` | `path,expectedRevision,line,action:"format"|"add_row"|"remove_row"|"add_column"|"remove_column",row?:number,column?:number,values?:string[]` | `WriteResult`；表格内部 row/column 从 0 开始，row 0/1 是表头/分隔行 |
| `outline` | `path,expectedRevision,line,action:"indent"|"outdent"|"up"|"down"` | `WriteResult`；操作整个列表分支 |
| `rename` | `path,destination,expectedRevision` | `WriteResult & {referencesToUpdate:string[],notice}`；不覆盖目标，不自动改写引用 |
| `trash` | `path,expectedRevision` | `{path,restoreToken}`；原文件移入库内 `.trash/forge-*` 保留 |
| `restore` | `token,expectedRevision` | `WriteResult`；目标已存在也必须提交当前修订 |
| `template` | `path,template,expectedRevision,variables?:Record<string,unknown>,append?:boolean` | `WriteResult`；模板全部解析成功后才写入 |
| `daily` | `date?:"YYYY-MM-DD",expectedRevision,variables?:Record<string,unknown>` | 新建：`WriteResult & {content}`；已有：`Document`；空修订打开已有日记不写入，非空修订仍需匹配 |
| `bookmarks_write` | `items:Bookmark[],expectedRevision` | `WriteResult`；写 `.obsidian/bookmarks.json`，保留其他配置字段 |
| `settings_write` | `values:Partial<Settings>,expectedRevision` | `Settings`（包含新 revision）；仅更新 Forge 覆盖设置 |
| `quickadd` | `choiceId,expectedRevision,path?:string,variables?:Record<string,unknown>` | `WriteResult`；先用 `quickadd_plan` 读取目标修订，脚本与宏拒绝 |

写操作共用每库跨进程锁；连接、断开和设置更新另使用配置全局锁。覆盖与删除先保留原 inode 到 `.trash/forge-*`，备份存入 Forge 的 `nexus/history/<vaultId>/`。目标有新文件时独占创建失败，保留外部文件和恢复副本，不覆盖。外部编辑器仍可在任何时候修改笔记，修订不是分布式事务。

## 错误与限额

服务错误的 `code` 包括 `REVISION_CONFLICT`、`VAULT_NOT_CONNECTED`、`PERMISSION_DENIED`、`UNSUPPORTED_SYNTAX`、`INVALID_ARGUMENT`、`NOT_FOUND`；`message` 为可读说明。宿主 IPC/SDK 负责保留错误码。底层文件系统异常可能保留原生错误码。

单文本文件 8 MiB、单附件 20 MiB、最多 30000 个文件、128 MiB Markdown 索引预算；超大笔记在 warnings 中标记。图谱最多 1500 节点，查询最多返回 1000 行并报告 total/truncated。表达式最多 5000 字符、60 层嵌套；DQL 最多 20000 字符。不执行 JS、Shell、外部插件代码或查询中的任意函数。图片不自动访问外网。

## MCP

`nexus_vaults`、`nexus_browse`、`nexus_read`、`nexus_query`、`nexus_write`、`nexus_edit`、`nexus_workflow` 分别映射上表。读工具有 `readOnlyHint:true`；停用插件时宿主隐藏并拒绝工具。MCP 能访问的是用户在星枢面板连接的目录，实际修改仍需遵循当前对话的用户请求；连接知识库不等于笔记中的文字获得指令权限。
