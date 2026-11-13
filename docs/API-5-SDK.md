# API 5 浏览器 SDK 与通信

API 5 在原有 `window.CodexForge` 上增加宿主服务、模型采样、插件后端、工具、市场管理、文件、凭据代理、任务和流式接口。插件清单需要 `apiVersion: 5` 及所用能力和权限。API 1–4 插件保持原声明；运行于 API 5 宿主不自动取得新增权限。`apiVersion` 表示插件声明，`hostApiVersion` 表示宿主版本。

SDK 类型从 `sdk/index.d.ts` 导出，新增接口定义在 `sdk/api5.d.ts`；JSON 清单参考 `sdk/plugin.schema.json`。`capabilities.get()` 的 `available`、`negotiated` 和 `denied` 描述当时的能力状态，实际调用仍由宿主重新检查。

## 调用与取消

新增异步方法接受末尾 `{signal, timeoutMs}`。超时为 1–600000 毫秒；普通请求默认 20000 毫秒，既有 `dsh.request` 默认 90000 毫秒，流的每次读取默认等待 600000 毫秒。浏览器每帧最多保留 64 个等待请求。

```js
const controller = new AbortController();
const result = await CodexForge.llm.sample(
  {prompt: '概括这段文字'},
  {signal: controller.signal, timeoutMs: 30000},
);
```

`AbortSignal` 不跨 IPC 序列化。SDK 发送带 `requestId` 的请求，取消时发送 `rpc.cancel`，宿主把取消传给原操作的信号。取消本地等待会忽略迟到响应；实际远端操作能否停止取决于对应提供方是否响应取消，不能据此确认远端计费已停止。

请求编号只在宿主绑定的调用身份内有效。调用身份应包含窗口、iframe、插件安装指纹、当前会话及代次，由主框架生成；插件参数不能选择其他调用者。插件停用、安装指纹变化或上下文失效时，宿主终止该身份的请求和流。

## 流与双向通道

`llm.stream(args, options)`、`conversations.events(args, options)`、`files.watch(args, options)` 返回异步迭代器。`rpc.stream(method, args, options)` 是公共流入口；宿主只派发明确支持流式结果的受权方法。

```js
const stream = CodexForge.llm.stream({prompt: '解释这段代码'});
try {
  for await (const chunk of stream) {
    // 按当前提供方约定读取 chunk。
  }
} finally {
  await stream.dispose();
}
```

`services.channel(name, method, args, options)` 和 `backend.channel(method, args, options)` 支持客户端输入：`send(value)` 等待宿主处理这一帧，`end()` 关闭输入但继续读取输出，`dispose()` 同时关闭两侧。提前结束 `for await` 会自动调用迭代器 `return()` 并关闭宿主流。同一流只允许一个待处理读取和一个待处理输入；这提供背压，不在浏览器积累无界输出。

流的协议为 `rpc.stream.open/next/send/end/cancel`。结果项和输入项必须是有界 JSON 数据。宿主默认每身份 16 个流、64 个请求；全局最多 256 个流、1024 个请求。`ForgeRPC` 类的缺省单项上限为 1 MiB、期限为 120 秒；API 5 宿主配置为 16 MiB 和最长 600 秒，以覆盖 8 MiB 文件的 Base64 返回。流选项 `lifetimeMs` 可缩短整条流的存活时间，`timeoutMs` 控制每次请求的等待时间。

宿主创建流时优先使用 `rpc.open(owner, signal => producer(signal), options)`，把流的取消信号交给真正的生产者。直接传入迭代器适用于无外部工作或已经绑定取消的来源。关闭会中止信号并调用迭代器 `return()`；不合作的生产者不会阻塞宿主清理。

## 公共入口

| SDK | 请求形式 |
| --- | --- |
| `conversations.list/read/create/fork/send/cancel` | `conversation.<方法>`，结构化参数；`send` 必须包含 `text` |
| `conversations.events` | `conversation.events` 流 |
| `llm.providers/sample/stream` | 发现已注册提供方，再执行采样或流请求；需 `llm.call` |
| `services.request/channel` | `{name, method, args}`，跨插件服务还需消费声明 |
| `backend.call/channel` | `{method, args}`，只能调用自身后端声明的方法 |
| `tools.list/call` | 列举或调用已注册工具 |
| `canvas/todos/skills/memory/statistics/collaboration.request` | `request(method, args, options)`，统一封装为 `{method,args}` |
| `files.request/watch` | 目录选择器或当前授权工作区内的相对路径；写入需要修订值 |
| `shell.execute` | `{executable,args?,timeoutMs?}`，不接受任意工作目录 |
| `network.fetch` | 宿主网络代理，需声明源；凭据由宿主注入 |
| `credentials.set/delete/describe` | 凭据名称与管理动作；不提供向浏览器读取明文密钥的方法 |
| `jobs/schedules.request` | 所属插件的任务和定时运行 |
| `plugins.list/catalog/install/checkUpdate/update/enable/uninstall` | 安装以目录条目 ID 定位来源，不接受任意下载地址 |
| `settings.snapshot/set` | 读取 `{value,revision}`；写入需 `set(value,expectedRevision,options)` |
| `logs.write/read` | 当前插件日志 |
| `theme.get/set/register` | 声明式主题 token |
| `shortcuts.register/unregister` | 引用已声明命令；注册返回异步注销函数 |

旧 `settings.get()` 继续返回平铺设置对象。需要并发编辑保护时使用 `snapshot()` 获取修订值，保存后使用返回的新修订；遇到 `REVISION_CONFLICT` 应保留编辑、重读并合并。

计划的 `revision` 是从 1 递增的数字；更新或删除计划时原样传给 `expectedRevision`。文件和设置的修订则是摘要字符串，不要在不同服务之间转换或复用修订值。

## 错误与清理

失败返回带 `code` 的 `Error`。通信层使用 `CANCELLED`、`TIMEOUT`、`RESOURCE_LIMIT`、`STREAM_NOT_FOUND`、`STREAM_CLOSED`、`INVALID_ARGUMENT` 和 `PLUGIN_DISABLED`；服务权限和业务错误继续使用其明确错误码。应按 `code` 分支，不解析中文错误说明。

插件 `dispose` 事件使所有等待 Promise 失败、关闭浏览器流并禁止后续调用。宿主另行清理后端、任务、工具和服务注册；浏览器生命周期不能代替宿主的权限核验及撤销。

可信 `theme.changed` 事件把实际挂载容器的颜色和宿主选择的 `--forge-*` 主题 token 投影到插件自己的文档根元素。主题注册只接受直接颜色值（十六进制、颜色名称及支持的颜色函数），不接受 URL、CSS 转义、变量或任意样式。主题切换会删除上一主题不再提供的 token，插件停用时清除。插件样式可以使用这些变量；其他 iframe 发出的消息不能改变它们。

## Slot 元数据

API 5 的七项命名贡献点为 `conversation.header.action`、`sidebar.right.body`、`tool.card.view`、`composer.leading`、`composer.trailing`、`conversation.message.action`、`settings.section`。清单条目需要 `ui` 权限及包内 HTML；只有工具卡片需要 `key`，它按可信 `toolName/type/callId` 匹配具体卡片。其他位置不接受 `key`。

使用 `events.on('slot.changed', callback)` 接收 JSON 投影 `{slot,id,key,threadId?,item?:{id,type,toolName},messageId?}`。宿主只发给自己创建的相应 iframe，投影不包含消息正文，不授予历史读取或会话发送权限。TypeScript 将该事件值约束为 `JsonObject`；`context.get()` 仍返回受权会话上下文。

凭据优先使用可用的 Electron 系统加密服务；未链接该模块的 Windows Codex 构建使用当前用户 DPAPI。加密和解密通过进程标准输入传递字节，不把明文写入命令参数或临时文件；复制到其他 Windows 用户后不能解密。
