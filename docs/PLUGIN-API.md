# Forge API 3

Forge API 3 随 Codex Forge 0.4.0 发布，在 API 2 操作基础上增加星枢 Nexus、可选能力协商和结构化错误。插件清单、SDK、上下文与能力查询均使用 `apiVersion: 3`；清单和更新协议的 `schemaVersion` 独立管理。

从 API 1/2 迁移：更新 SDK，清单改为 `apiVersion: 3` 与经过测试的 Forge 范围 `>=0.4.0 <0.5.0`，验证权限、能力及原有交互。旧插件仍可读取并显示诊断，数据保留，未经迁移不启用；宿主不改写第三方插件。DSH 导入器按当前宿主生成清单。详见 [迁移说明](API-3-MIGRATION.md)。

插件目录必须包含 `plugin.json`。`id` 使用 `publisher.name`；`forge.*` 保留给内置插件。`compatibility.codex` 和 `compatibility.forge` 是非空数组，数组项之间是“或”；单项空格分隔的比较条件是“且”。支持精确三/四段数字版本、`>= <= > < = ^ ~` 和 `||`，不接受隐式通配或预发布字符串。

```json
{"schemaVersion":1,"apiVersion":3,"id":"example.panel","name":"示例","version":"0.4.0","compatibility":{"codex":["26.1027.6604.0"],"forge":[">=0.4.0 <0.5.0"]},"permissions":["panels"],"contributes":{"panels":[{"id":"main","title":"示例","entry":"panel.html"}]}}
```

宿主向 iframe 注入 `window.CodexForge`。`entry` 是可选的浏览器 JS 命令入口。面板 HTML 应自包含，使用内联脚本和样式；可在发布前用自己的构建器打包。没有 Node、任意 IPC、文件系统、同源权限或自动消息发送权限。允许的网络源必须通过 `network` 和 `networkOrigins` 声明；面板不能导航宿主。API 仍按来源窗口和插件安装记录校验身份。

| API / 清单贡献点 | 权限 | 行为 |
| --- | --- | --- |
| `context.get()` | `conversation.read` | 获取可信当前会话与版本；无权限时隐藏 threadId |
| `capabilities.get()` | 无 | 获取当前 API、宿主版本、已声明权限、UI surface 和内置事件；用于能力协商，不代表插件已获额外权限 |
| `panels.open(id)` / `close(id)` | `panels` | 原生右侧标签页；全宽需清单声明 `placement: expanded` 与功能理由 |
| `sidebar.register(item)` | `sidebar` | 注册左栏按钮，引用本插件命令或面板；返回异步注销函数 |
| `toolbar.register(item)` | `toolbar` | 注册工具栏按钮 |
| `composer.register(item)` | `composer` | 注册输入框按钮 |
| `composer.read/insertText/setText` | `composer`、`conversation.read` | 读写当前草稿；修改必须传入 `expectedText`，草稿已变化则拒绝 |
| `conversations.setTitle(title)` | `conversation.title`、`conversation.read` | 修改当前原生会话标题，切会话后的迟到请求拒绝 |
| `output.append/clear/open` | `output`、`conversation.read` | 写当前会话的可折叠输出及原生输出标签；清除仅影响本插件 |
| `browser.open(url)` | `browser`、`conversation.read` | 使用原生内置浏览器打开 HTTP(S) 地址 |
| `storage.get/set/delete` | `storage` | 独立 JSON 存储，单键64KB、每插件1MB |
| `settings.get()` | `settings` | 获取经过类型、范围和枚举校验的设置 |
| `nexus.request(method,args)` | `nexus.read`，写入另需 `nexus.write` | 访问用户在星枢面板连接的知识库；按方法表校验，只读请求不能写文件，创建/更新需 revision，详见 [Nexus API](NEXUS-API.md) |
| `metadata.get()` | 无 | 获取自己的清单、描述与升级日志 |
| `events.emit(name,value)` | `events` | 向当前 Forge 窗口中已启用插件广播受限 JSON 事件；事件必须先在 `contributes.events` 中声明并属于自己的插件 ID，单次数据最多 64KB |
| `commands.register(id, handler)` | 无 | 注册已声明命令的处理器；返回注销函数 |
| `events.on(name, callback)` | 无 | 监听 `ready`、`context.changed`、`settings.changed`、`dispose`、`output.changed` 或插件事件；返回注销函数，第二个回调参数带来源插件和会话 ID |

静态按钮在 `contributes.sidebar/toolbar/composer` 中声明；动态注册使用相同 `{id,title,command}` 或 `{id,title,panel}` 结构。安装后默认停用。停用卸载会销毁运行时与贡献点；卸载保留独立设置。代码或清单被手动修改后，重新加载会要求审阅并重新启用。

`contributes.settings.properties` 使用 `{type,title,default,enum,minimum,maximum,maxLength}`，支持字符串、数字、布尔值；0.3.3 起还支持字符串数组（`type: "array", items: {type: "string", maxLength: 200}, maxItems: 200, default: []`）。数组拒绝重复项、空字符串和非字符串，默认最多 200 项，每项默认最长 200 字符；`maxItems` 可设为 1–1000。使用数组的第三方插件应声明 Forge `>=0.4.0 <0.5.0`，API 版本为 3。设置界面自动集中到原生“Codex Forge 插件设置”；插件管理的设置按钮携带插件 ID 深链接，用户不必自行查找。

`capabilities.get()` 对应 DSH 的 capability seam 思路：插件先读取宿主实际提供的能力与自己的 `denied` 列表，再决定是否显示入口。声明与授权仍由宿主逐请求校验，能力查询不会绕过权限。

宿主在每次派发前校验两件事：`permissions`（用户安装时审阅的授权）与 `capabilities`（插件声明使用的宿主服务）。`capabilities` 省略时按 `permissions` 推断；显式声明后**只授予声明过的能力**，调用未声明的服务会直接失败，错误文本会指出要补哪一项：

```json
"capabilities": [
  {"name": "storage", "version": 1},
  {"name": "output", "version": 1, "optional": true}
]
```

可用能力：`conversation`（修改标题）、`composer`、`output`、`browser`、`storage`、`settings`、`events`、`panels`、`ui`（注册按钮）、`dsh`（导入的 DSH 浏览器插件兼容请求）、`nexus`（星枢知识库）。`context.get`、`metadata.get`、`capabilities.get` 不需要声明。`capabilities.get()` 返回 `capabilities`（本插件声明）、`available`（宿主提供的能力版本）、`denied`（未授予的方法与修复提示）；API 3 增加 `negotiated`（逐项 `supported/enabled/granted`）。`available` 仅表示实现版本，不代表服务启用或插件获权；`enabled` 表示对应宿主服务存在，`granted` 还要求本插件获权。Nexus 服务与独立插件安装状态分开；停用独立插件会拒绝该插件调用，并关闭其 MCP 工具，但不影响其他获权插件的数据接口。必需能力必须存在并匹配版本；`optional:true` 的未知能力或版本不匹配不会停用插件，调用仍拒绝。未知可选能力必须明确填写正整数版本；不会推断或授予未知权限。

## 错误处理

异步 SDK 失败返回带 `code` 的 `Error`，可读说明在 `message`。`CAPABILITY_UNAVAILABLE`、`PERMISSION_DENIED`、`PLUGIN_DISABLED`、`METHOD_NOT_FOUND`、`INVALID_ARGUMENT`、`REVISION_CONFLICT`、`VAULT_NOT_CONNECTED`、`UNSUPPORTED_SYNTAX`、`NOT_FOUND` 与 `TIMEOUT` 可用于分支处理；底层文件异常可能返回原生错误码。未知错误使用 `INTERNAL_ERROR`，不要根据中文 message 解析业务状态。

能力查询是当时快照；服务状态可变化，每次实际调用仍由宿主验证。遇到 `REVISION_CONFLICT` 应保留草稿、重新读取并合并，不应自动重复覆盖。SDK 类型见 `sdk/index.d.ts` 和 `sdk/nexus.d.ts`。

## UI 贡献点（slot）

宿主声明位置与基数，插件只能往已声明位置注册；渲染层按 `data-forge-slot="<id>"` 锚点挂 iframe，锚点不存在时静默跳过。

| slot | 基数 | 位置 |
| --- | --- | --- |
| `conversation.header.action` | list | 会话头动作区 |
| `sidebar.right.body` | list | 右侧标签 body |
| `tool.card.view` | keyed | 工具调用卡片，必须带 `key` |

```json
"contributes": {
  "slots": [
    {"slot": "command.menu.item", "id": "menu", "view": "menu.html"},
    {"slot": "tool.card.view", "id": "card", "key": "tool-x", "view": "card.html"}
  ]
}
```

slot 条目需要 `ui` 权限，`view` 必须是包内 HTML。list 允许多个插件共存；keyed 按 `key` 去重，冲突时后来者被跳过并记录在 `forge:slots` 的 `conflicts` 里，不会覆盖先启用者。

`sidebar.right.body` 已用 ARIA 锚点（`[role="tabpanel"]`）实测可用；`conversation.header.action` 与 `tool.card.view` 的锚点暂为 `null`，插件可以声明但不会渲染，等实测后填入选择器即可生效。锚点不存在时插件不会加载失败。`capabilities.get()` 会返回当前宿主提供的 slot 清单。

## 诊断与脚本（开发者工具）

内置的“开发者工具”插件（`forge.devtools`）提供三类能力，都需要 `devtools` 权限：

- `diagnostics.get()`：读取宿主渲染进程的只读诊断——每个 slot 的 anchor、命中数量、常见原生选择器（`[role="menubar"]`、`[role="tabpanel"]`、`[data-codex-composer-root]` 等）与页面节点数。
- `devtools.eval(code)`：在宿主渲染进程的全局作用域执行脚本（等同于 DevTools Console），支持 `await`，30 秒超时、单次 20000 字符上限，返回值序列化成 JSON（Element 会转成 tag/cls/text/html 摘要）。
- 面板同时显示宿主版本、当前插件的 capabilities 与 denied 表，以及 `ready`、`context.changed` 等内置事件日志。

给某个 slot 选锚点时，先打开这个内置插件看目标 slot 的命中数；要确认某个选择器能不能命中，直接在“脚本”里跑 `return document.querySelectorAll('...').length`。

`devtools.eval` 等于完全控制宿主页面，只应授权给自己信任的插件；`forge.devtools` 是内置插件，安装后默认启用。

`runtime/dsh-compat.cjs` 为 Forge 提供 DSH 浏览器 UI 兼容层。通过插件管理中的“导入 DSH 插件”选择含 `package.json`、`exports["./client"]` 和预构建 `__ModuleLoader__` 客户端的目录；“导入 DSH 市场”仅接受 `dshmarket`，并单独声明 `dsh.manage` 管理权限。导入会复制浏览器 JS、可选 CSS 和许可证到 Forge，默认停用；审阅权限并启用后，可直接打开右侧插件页面，无需重启。

适配器提供 React、UI primitives、locale、theme 读取、少量 slots 和可撤销 effect；`dsh.request()` 使用 `dsh` 能力，市场管理另需宿主导入记录及 `dsh.manage`。市场支持目录浏览、从 npm 导入浏览器包、启停、卸载、备注、收藏、屏蔽和分组。下载先验证 npm 完整性摘要，再解包导入；不会执行 npm lifecycle、DSH 服务端入口或 Cordis patch，也不读取外部 DSH profile。依赖额外客户端服务、服务端 API、主题切换、原位更新、备份/恢复等功能暂不支持，并返回明确错误。此兼容层与协作提供方的 DSH 审批会话相互独立。范围见 [DSH 对照](DEEPSEEK-HARNESS-MAPPING.md)。

协作 MCP 同时提供 Codeg 兼容的委派工具：`delegate_to_agent` 使用
`{agent_type, task, working_dir?}`，`get_delegation_status` 使用
`{task_ids, wait_ms?}` 并固定返回 `{tasks: [...]}`，另有 `cancel_delegation` 和
`resume_delegation`。只支持 Claude Code、Grok Build、DSH 三个本地目标；每个任务仍受当前
对话的用户授权和 Forge 工作目录隔离约束。

协作默认按对话关闭。只有当前对话中捕获到真实用户的明确协作请求后，才允许启动任务；如果请求来自提示词而用户尚未勾选当前对话，宿主会先提交 `collaboration-authorization` 手动审批，批准后自动启用该对话，拒绝或过期则保持关闭。模型输出、其他会话和工具参数不能代替这次用户授权。

协作任务的要求和完成结果会通过受标记的对话数据回写当前原生线程；这些内容仅供显示和上下文参考，不会被当作新的 Codex 用户指令重复执行。回写带有持久收据，应用重启或文件监听刷新不会重复插入。

插件间事件是 Forge 对 DSH 类型化事件的受限浏览器实现。事件先在清单中声明，再由宿主逐请求校验；它只传递 JSON 数据，不提供宿主 Service、文件系统或模型调用。需要持久事实时应使用插件自己的 `storage` 或宿主已有的会话 API，不能把事件当作可靠日志。

`description` 提供功能介绍，`changelog:[{version,date,items:[]}]` 提供升级日志；宿主自动收录到“扩展插件功能与升级日志”页面。

CLI 支持 `create / validate / pack / list / install / uninstall / enable / disable / settings`，`--home` 可选独立测试数据目录。详见 `node cli/forge.mjs`。示例代码见 `examples/hello-forge`。

固定版本适配器在 `scripts/native-*-patch.mjs`。遇到未知客户端版本或锚点变化必须增加经过验证的适配器，不能放宽版本号并直接套用。Forge API 与原生混淆符号之间仅由宿主适配层连接。

## 独立插件包与 Nexus 连接（0.4.1）

插件管理的「导入插件包…」接收 CLI `pack` 生成的 `.forge-plugin.json`，也支持原有目录安装。包为 `schemaVersion:1`，`files` 中每项含 `path`、`encoding:"base64"` 和 `content`。JSON 最大 30 MiB，解码后合计最大 20 MiB、最多 1000 文件，必须含 `plugin.json`；不允许路径穿越、Windows 设备名、大小写重复文件及 `.git/node_modules`。导入复用清单、权限、兼容和指纹检查，默认停用；卸载保留用户设置。HTML 面板最大 20 MiB。

`forge.nexus.connect()` 使用原生选择器，不能携带参数；成功返回 `{vault}`，取消返回 `null`。`forge.nexus.disconnect(vaultId)` 返回剩余 `Vault[]`。两者需要 `nexus` v1 和读写权限，使用者应声明 Forge `>=0.4.1 <0.5.0`。目录连接不开放给 MCP，选择完成后重新检查插件权限与启用状态。

星枢 `homeftw.nexus` 是独立外部插件，Forge 只提供服务；其 MCP 工具按真实安装、文件指纹、启用和权限状态开放。具有 `nexus.read` 的外部面板允许 `media-src data:`，仍禁止 frame/object；PDF 内嵌不支持。详见 [Nexus 接口](NEXUS-API.md)。

## ZIP/7z、SVG 图标与隔离脚本（0.4.2）

“导入插件包…”和 CLI `install` 支持 `.zip`、`.7z`、`.forge-plugin.json`，无需预解压或额外安装工具。压缩包必须只有一个 `plugin.json`，可以位于根目录或共同的外层目录；不接收插件目录之外的其他文件。最多 30 MiB 压缩数据、20 MiB 展开内容、1000 文件及 2000 目录项。不支持加密、多卷、多个插件、链接、设备路径、路径穿越和重复大小写名称。7-Zip 的解压结果经有界内存流交给宿主，只有校验后的普通文件由宿主创建；失败清理临时目录，安装默认停用。JSON 更新协议保持原样。

静态 `contributes.sidebar/toolbar/composer` 及动态 `Contribution` 可增加：

```json
"icon": {"viewBox":"0 0 24 24","paths":["M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10z"]}
```

`viewBox` 当前固定为 `0 0 24 24`，路径最多 16 条、每条 2048 字符，仅接受路径命令/数字/逗号/空白。宿主通过 SVG DOM 创建固定 `fill=none`、`stroke=currentColor` 的图标，不接受原始 SVG、HTML、事件或资源 URL。左栏入口跟随原生折叠布局并保留可访问名称。

`nexus.script` 要求同时声明 `nexus.read`，不得与 `network` 权限并用。它仅使插件 CSP 增加 `worker-src blob:`，`connect-src`、frame/object 继续禁止，未开启 `unsafe-eval`。插件应在用户明确点击后运行知识库脚本，传入只读快照、限时终止，并清理声明式渲染输出；不得把宿主 SDK 代理给笔记脚本。该权限本身不赋予文件/Node/SDK/模型执行能力。使用这些新增功能的插件应声明 Forge `>=0.4.2 <0.5.0`，API 保持 3。
