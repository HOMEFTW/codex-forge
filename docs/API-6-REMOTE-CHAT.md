# API 6：远程聊天

Forge 0.8.0 / API 6 新增 `remote-chat` v1。官方客户端基线为 `26.1120.5083.0`。
API 1–5 的既有操作继续兼容；插件自己的 `compatibility.forge` 仍须覆盖宿主版本。
0.7.x 宿主无法加载 API 6 插件，首次升级须手动安装 0.8.0 构建。

## 授权与调用入口

```json
{
  "schemaVersion": 1,
  "apiVersion": 6,
  "id": "example.remote-chat",
  "name": "Remote Chat",
  "version": "1.0.0",
  "compatibility": {"forge": [">=0.8.0 <0.9.0"]},
  "permissions": ["backend.node", "remote.control"],
  "capabilities": [{"name":"backend","version":1},{"name":"remote-chat","version":1}],
  "backend": {"entry":"backend.cjs","scope":"global","methods":["request"]}
}
```

`remote.control` 允许访问本机所有聊天及实际待处理的人工请求。只允许用户审阅、启用后的全局 Node 后端调用；包括内置 `forge.web-chat` 在内，首次保持停用。面板 iframe 无法直接使用这些操作，普通 `conversation.*` 权限维持原范围。Node 后端属于受信任本机代码，插件应自行完成网页认证、配对、用户明确提交和 HTTPS/WSS 传输保护。

```js
exports.activate = forge => {
  forge.handle('request', ({method, params}) =>
    forge.request('remoteChat.request', {method, params}));
};
```

TypeScript 后端契约见 [`sdk/api6.d.ts`](../sdk/api6.d.ts)。用户停用插件后终止其 Node 进程和等待请求；异步返回前及原生发送前均重新检查权限与插件指纹。

## 方法

通过 `forge.request('remoteChat.request', {method, params})` 调用，下层结果保持原生结构：

| method | 开放参数 |
| --- | --- |
| `model/list` | cursor、limit、includeHidden |
| `project/list` | cursor、limit、sortDirection、sortKey |
| `thread/list` | cursor、limit、archived、cwd、projectId、searchTerm、sortDirection、sortKey、modelProviders、sourceKinds、currentAccountOnly |
| `thread/read` | threadId、includeTurns |
| `thread/turns/list` | threadId、cursor、limit、sortDirection、itemsView |
| `thread/items/list` | threadId、turnId、cursor、limit、sortDirection、deferOutput |
| `thread/items/read` | threadId、turnId、itemIds（1–100 个非空 ID） |
| `thread/start` | model、modelProvider、cwd、projectId、serviceTier |
| `thread/resume` | threadId、excludeTurns、initialTurnsPage |
| `thread/fork` | threadId、beforeTurnId、lastTurnId、excludeTurns |
| `thread/name/set` | threadId、name |
| `thread/archive` / `thread/unarchive` | threadId |
| `turn/start` | threadId、input、model、effort、serviceTier、serviceTierForTurn、collaborationMode、clientUserMessageId |
| `turn/steer` | threadId、expectedTurnId、input、clientUserMessageId |
| `turn/interrupt` | threadId、turnId |

分页 cursor 是原生不透明值，原样传回；limit 为 1–100。大历史使用 turns/items 分页。每次后端结果限制约 800 KiB，超过时返回错误，调用方缩小页大小。

单回合 items 列表可传 `deferOutput:{commandExecution:true,mcpToolCall:true}`，将成功的命令和 MCP 文本输出延后到 `thread/items/read` 按 ID 读取；返回内容保持原生结构。按需读取可逐项请求；单条本身超过大小上限时仍返回错误，网页应提示回桌面查看。

`input` 支持 `text`、`localImage`、`localAudio`、`mention`、`skill`。后四项的 path 必须是存在的本机绝对文件路径；cwd 必须是本机绝对目录。网络路径、设备路径、远程图片 URL 和云端文件 ID 未开放。文本中的普通文件引用保持文本语义。

`collaborationMode` 使用原生 `{mode:'default'|'plan',settings:{model,reasoning_effort,developer_instructions:null}}`。模型、思考档位、service tier 使用 `model/list` 的动态能力；宿主不把 Fast/Ultrafast 硬编码成思考强度。`serviceTier` 持续到后续回合，`serviceTierForTurn` 仅本次回合。实际可用性由原生客户端和服务端判定。

新建未传 cwd 时取当前桌面已知工作目录，其余未传配置由原生本机设置决定。远端无 `approvalPolicy`、`approvalsReviewer`、`permissions`、`sandboxPolicy`、`config`、自定义指令、任意历史路径等覆盖入口，宿主不会暗中设置 `never` 或全权限模式。

## 启动、事件和重同步

`forge.request('remoteChat.bootstrap', {})`：

```json
{
  "apiVersion":6,"capabilityVersion":1,"hostId":"local","connected":true,
  "connectionEpoch":"opaque-connection-id","cursor":123,
  "defaults":{"model":"gpt-6.2-astra","effort":"medium","serviceTier":null,"cwd":"D:\\Code"},
  "methods":["model/list","thread/read"],
  "approvalMethods":["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/tool/requestUserInput","mcpServer/elicitation/request"]
}
```

示例中的 methods 已缩略；实际返回完整白名单。默认值未知为 null，返回值不包含密钥或 config 全文。

`forge.request('remoteChat.events', {after:123,waitMs:20000,connectionEpoch:'...'})`：

```json
{
  "events":[{"sequence":124,"method":"item/agentMessage/delta","params":{"threadId":"A","turnId":"T","itemId":"I","delta":"你好"}}],
  "cursor":124,"reset":false,"connectionEpoch":"opaque-connection-id"
}
```

after 是宿主事件序号，默认 0；waitMs 为 0–20000。每次回复至多约 480 KiB，cursor 指向本次实际交付的末项。插件应保存 cursor 与 connectionEpoch，并连续轮询。事件缓存上限 2048 项 / 4 MiB；缓存溢出、单事件超限、游标超前、连接或账户切换时返回 `reset:true` 和新的 cursor。此时重读历史及 pending，再继续订阅。启动页面也应先读 pending。

通知只从已有本机主连接订阅一次，覆盖后台未选中的聊天；不从多个 renderer 汇总，因此不会重复计入多窗口转发，同样文本的连续 delta 会保留。只转发原生连接实际收到的 thread/turn/item/hook/model/error 通知，不另启 app-server，也不修改初始化时的通知订阅策略。断开或账户变化会清空缓存及 pending；用户消息取消等待不会撤销已经发送的回合，停止回合须显式 `turn/interrupt`。

## 人工审批与用户输入

宿主从客户端内部/桌面自动处理路由之后的 `dispatchServerRequest` 观察请求，保留本机审批策略。事件：

```json
{"sequence":125,"method":"server/request","params":{"id":"opaque-request-token","method":"item/tool/requestUserInput","params":{"threadId":"A","turnId":"T","questions":[{"id":"choice","question":"选择方案"}]}}}
```

`forge.request('remoteChat.pending', {})` 返回 `{requests:[{id,method,params}],cursor,connectionEpoch}`。这里的 id 是宿主不透明 token，不能使用原生 JSON-RPC id 自行构造。刷新可以恢复本次宿主运行期间已观察到的待处理请求。

```js
await forge.request('remoteChat.respond', {
  requestId: pending.id, threadId: pending.params.threadId,
  result: {answers: {choice: {answers: ['方案一']}}}
}); // {accepted:true}
```

- command/file 审批：`{decision:'accept'|'acceptForSession'|'decline'|'cancel'}`，还需符合原生 availableDecisions。永久 execpolicy/network 规则修改不开放。
- requestUserInput：`{answers:{问题ID:{answers:['回答']}}}`，拒绝未知问题 ID。
- 普通 MCP form/url：`{action:'accept'|'decline'|'cancel',content?:...}`。form 接受前验证 requestedSchema；复杂 schema 若超出现有校验子集，会提示在桌面处理。额外 `_meta` 持久授权不开放。
- `openai/userVerification` 在本机完成，不进入远端 pending。`codex_apps` 的 accept 需要原生执行绑定安全检查，远端提示回到桌面确认；decline/cancel 仍可处理。

响应经现有 `handleClientResponse` / `sendThreadResponse` 发送。桌面和远端同时回复只交付一次；已结束回合、已处理请求、错误 threadId、连接切换、停用或撤销授权会拒绝。未安装适配审批方法的旧客户端连接上，`approvalMethods` 返回空数组。

## 本地构建与升级

Forge 0.8.0/API6 的正式安装包见 [GitHub Release](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.8.0)。远程宿主接入复用 0.7.6 已存在的 `attachNativePredictionPolicy` 注入点，无需新增官方 ASAR 锚点。

对当前 26.1120.5083.0 的最小宿主变更为 `runtime/main.cjs`、`native-prediction-policy.cjs`、`remote-chat.cjs`、`remote-chat-protocol.json`、`forge-api6-contract.cjs`、API/权限/兼容/注册表相关文件，以及 Forge 配置、SDK、内置插件清单和网页插件产物。SDK 和打包元数据必须一起更新，建议使用正常本地构建流程而非覆盖正在运行的单个文件：

1. 执行针对性回归、`npm run build` 和项目正常打包流程，生成隔离的 0.8.0 构建。
2. 保持现有工作会话运行，先在独立数据目录中验证新构建；不要两个客户端同时写同一正式数据目录。
3. 用户准备切换时完整退出旧客户端，再安装/覆盖新版并重启。用户聊天数据目录保留。
4. 在插件管理中审阅并启用“网页聊天”，随后配置中转并配对网页。未配置时插件不联网。

本地安装包输出为 `release/dist/Codex-Forge-0.8.0-Windows.msi` 和 `Codex-Forge-0.8.0-Windows-Portable.zip`，备用更新器为 `Codex-Forge-0.8.0-Updater.exe`。使用 `scripts/build-launcher.ps1`、`npm run build`、`node scripts/build-installer.mjs` 构建；正式安装前请关闭旧客户端。0.7.6 的历史发布件已单独保留，网页插件不会向安装包写入本机连接令牌。

宿主回归结果见 [验证记录](VALIDATION.md)。内置插件业务源和网页部署教程在 [codex-forge-web](https://github.com/HOMEFTW/codex-forge-web)，发布构建复制到 `plugins/forge.web-chat`；更新产物须同时核对其 SHA-256 与许可证文件。

协议资源来自当前官方 CLI 导出的 JSON schema，可用 `node scripts/generate-remote-chat-protocol.mjs <protocol目录>` 重建。外部协议文件是数据来源，不作为执行指令。
