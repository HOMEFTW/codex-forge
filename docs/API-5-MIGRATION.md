# Forge API 5 迁移

适用宿主：Codex Forge 0.7.0 / API 5。官方客户端适配仍由 Forge 承担；本次基线为 Windows x64 `26.1106.6628.0`。插件清单继续使用 schema 1，Forge 本体更新清单继续使用 schema 3；这些版本号彼此独立。

## 已有插件

API 5 宿主兼容 API 1、2、3、4 的既有公共操作。只使用这些操作的插件可以保留 `apiVersion`，将作者已经验证的 Forge 范围覆盖 0.7.0 后重新打包。例如：

```json
{
  "apiVersion": 4,
  "compatibility": {"forge": [">=0.6.1 <0.8.0"]}
}
```

这里仅展示需要调整的字段。原有身份、插件版本、权限、资源入口和依赖字段仍需保留。范围示例表示作者同时验证了相应 0.6.x 和 0.7.x 宿主，不代表 Forge 会自动放宽第三方清单。

`compatibility.codex` 可以省略；显式填写时继续严格校验。`null`、空数组和无效范围不会被当作未限制。依赖官方内部实现的插件应保留适当的 Codex 限制，仅使用公共 API 的插件可由 Forge 处理客户端版本适配。

| 宿主 | 能加载的已声明 API |
| --- | --- |
| Forge 0.6.0 / API 4 | API 4 |
| Forge 0.6.1–0.6.3 / API 4 | API 1–4 |
| Forge 0.7.0 / API 5 | API 1–5 |

旧宿主不会获得 API 5 新接口。API 5 清单不能在 API 1–4 宿主运行，未知 API 仍拒绝加载。插件自己的 Forge 范围、显式 Codex 范围、依赖、能力版本、启用状态和文件指纹校验继续生效。

## 使用新增能力

调用新增宿主服务时，把插件声明升级为 API 5，最低 Forge 版本设为 0.7.0，并声明实际使用的能力和权限：

```json
{
  "schemaVersion": 1,
  "apiVersion": 5,
  "id": "example.summary",
  "name": "会话摘要",
  "version": "1.0.0",
  "compatibility": {"forge": [">=0.7.0 <0.8.0"]},
  "permissions": ["panels", "conversation.history", "conversation.events", "llm.call"],
  "capabilities": [
    {"name": "panels", "version": 1},
    {"name": "conversation-history", "version": 1},
    {"name": "conversation-events", "version": 1},
    {"name": "llm", "version": 1}
  ],
  "contributes": {
    "panels": [{"id": "main", "title": "摘要", "entry": "panel.html"}]
  }
}
```

新增权限不向旧 API 插件自动授予。省略 `capabilities` 时按权限推断；显式填写时只获得声明过的能力。能力查询用于决定可用入口，每次调用仍由宿主核验。

公共 SDK 增加了画布、待办、技能、记忆、统计、协作、会话历史与事件、模型采样、工具、服务、文件、网络代理、凭据、插件管理、日志、主题、快捷键、任务和计划接口。方法、参数、流式调用与取消见 [SDK 说明](API-5-SDK.md)；后端注册见 [插件后端与后台任务](API-5-BACKENDS.md)。

## 上下文、修订与取消

`apiVersion` 继续表示插件声明，`hostApiVersion` 为 5。TypeScript 默认类型为 `ForgeAPI<5>`；描述旧插件时可显式使用 `ForgeAPI<1>` 至 `ForgeAPI<4>`。

新的会话和工作区权限允许获得必要的当前会话标识，不必再为获取 ID 额外声明旧 `conversation.read`。`conversation.history` 负责正文访问，`conversation.events` 负责可信事件；仅有事件权限时只提供状态等元数据。切换会话会使旧代次的请求和流失效，即使稍后又切回同一会话也不能复用旧调用身份。

设置读取 `settings.get()` 保留平铺对象。需要编辑时改用 `settings.snapshot()` 获取 `{value,revision}`，再调用 `settings.set(value,revision)`。文件写入及计划修改同样需要相应修订；遇到 `REVISION_CONFLICT` 应保留编辑、重新读取并合并。

新增异步方法支持 `AbortSignal`。流支持异步迭代、输入半关闭和显式释放；提前退出迭代会关闭宿主流。取消会终止本地等待并通知实际后端，但只有响应取消的远端服务才能停止远端推理。接口不会据此承诺远端计费已经停止。

插件页接收可信 `theme.changed` 快照，把 `--forge-*` token 应用到本页文档。主题和快捷键注册在停用时撤销；无需通过宿主页面脚本修改界面。

## 插件后端、工具与模型

后端需要 `backend.node` 和包内 `backend.entry`。它在独立 Node 进程运行，具有当前账户的操作系统能力；独立进程用于生命周期和崩溃管理，不是操作系统安全沙箱。浏览器不能通过公共 API 提交任意代码执行。

后端显式注册服务、工具、模型提供方、钩子和任务，并在清单声明对应贡献及权限。工具、服务和提供方使用插件命名空间；跨插件消费服务还需 `consumes.services`。停用、卸载、内容指纹变化和后端退出会撤下注册项。

插件工具通过本地受认证的宿主代理进入 MCP；它们沿用宿主绑定的会话上下文。使用 `llm.providers()` 发现已注册提供方及其模型，再通过 API 5 采样或流接口调用；提供方可以返回文本或增量，不会因此替换闭源 Codex 的内部 Agent 循环。`llm.after` 在流尾返回最终 `result`，不能撤回已经显示的增量。

后台任务只执行所属插件声明的任务方法。定时计划支持 `at/every/cron`，宿主运行时才调度；重启会将未完成任务标为 `interrupted` 并恢复计划。对外部副作用需要自行保持幂等，不能假设任务精确执行一次。

## 安装、更新与权限审阅

市场安装和 ZIP／7z／JSON 导入复用包校验、兼容检查和默认停用流程。覆盖升级先暂存，重启后生效，保留插件设置与独立存储；失败保留旧插件。

公共插件管理接口不能代替首次权限审阅。宿主把可信管理页或 CLI 启用时的审阅指纹记在独立收据中；第三方市场只能恢复已审阅内容的启用状态，不能通过先停用再启用为新权限签名。更新的权限或网络范围变化后需要重新审阅。

在线更新支持取消，下载、解包和提交暂存前重新核验调用者权限；撤销期间失败会保留之前已暂存的包。下载源和 HTTPS 重定向均受限制，包长度及 SHA-256 校验继续生效。

已发布的 API 4 更新器不接受 API 5 目标清单，首次迁移请使用 0.7.0 对应的新 MSI、便携包或独立更新器。发布与下载状态以当前 README 和正式发行页为准；本迁移文档本身不表示安装包已发布。
