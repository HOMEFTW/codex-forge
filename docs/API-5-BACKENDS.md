# API 5 插件后端与后台任务

API 5 插件可以声明 Node 后端，注册服务、模型工具、模型适配器和请求钩子，并运行持久后台任务及计划。后端由 Forge 启动于独立 Node 进程；它不会进入 Electron 主进程，也不能让浏览器提交代码。

`backend.node` 是可信代码权限：后端拥有当前 Windows 账户能够访问的文件、网络和进程资源。独立进程用于崩溃和生命周期管理，不是操作系统安全沙箱。Forge 不把主进程环境中的服务密钥自动传给子进程。启用、更新和指纹审阅沿用插件管理流程。

## 声明与入口

`backend: {"entry":"backend.cjs","methods":["echo"],"scope":"session"}` 指定包内入口和公开方法。默认 `scope: "session"` 要求可信会话上下文；确有全局用途的插件可声明 `scope: "global"`。文件仍受安装包路径、摘要和启用状态检查；每次启动后端都会重算磁盘包指纹，注册表缓存不能使未重新审阅的改动获得执行权。

模块导出 `activate(forge)`，或直接导出函数。入口可异步初始化；注册失败会让激活失败，不会把部分注册当作成功。`forge.onDispose(fn)` 和激活函数返回的清理函数用于释放资源。停用、指纹变化、卸载、崩溃和超时都会撤下贡献。取消先触发 `AbortSignal`；150ms 内未释放的操作会使该插件整个后端终止，其他同插件调用也会结束。Windows 使用进程树终止；其他系统使用后端进程组。

每次调用的处理器形如 `(args, {context, signal})`。`context` 来自宿主，不采信浏览器或后端自行提交的会话身份。通过 `forge.request(method,args,{signal})` 调宿主公共 API 时，宿主沿用该次调用的上下文并重新校验权限；启动阶段无调用上下文的请求没有会话或工作目录权限。

## 注册接口

| 接口 | 清单声明 | 额外权限 |
| --- | --- | --- |
| `forge.handle(name, handler)` | `backend.methods` | `backend.node` |
| `forge.services.provide(name, methods)` | `contributes.services`，可限定 `methods` | `services.provide` |
| `forge.tools.register(definition, handler)` | `contributes.tools` | `tools.register` |
| `forge.llm.registerProvider(definition, handler)` | `contributes.providers` | `llm.providers` |
| `forge.hooks.on(name, handler)` | `contributes.hooks` | `hooks.register` |
| `forge.jobs.register(name, handler)` | `contributes.jobs` | `jobs.manage` |

工具、提供方和服务名称必须以完整插件 ID 加 `.` 开头。注册返回注销函数，其 `.ready` Promise 表示宿主已接受；激活结束时 Forge 也会统一等待这些确认。一个后端最多注册 128 项贡献，最多并发 32 个调用；JSON 消息最大 1MiB、单项声明最大 64KiB、默认调用超时 30 秒，允许 10–120000ms。后台日志累计超过 1MiB 时结束后端，避免无限输出。

跨插件服务调用还需要调用方的 `services.call` 和 `consumes.services` 中的完整名称。提供方只公开注册的方法，返回值不能传递 Node 对象或 Context；消费方调用时重新检查双方启用及权限状态。

工具定义包含 `name`、`description`、`inputSchema`、`outputSchema` 和可选的 `timeoutMs`。参数和结果均校验；清单提供 schema 时，运行时必须一致。当前 schema 子集支持 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、数字及长度边界、`anyOf/oneOf/allOf` 和文档注解；不支持的关键字在注册时明确拒绝。工具加入 MCP 的传输和原生会话授权由宿主桥接。

模型提供方定义包含 `name` 和可选 `models: [{id,name?}]`。处理器可返回 `{text,usage?}`，也可返回 AsyncIterable。推荐流事件为 `{type:"text",text:"..."}` 和 `{type:"usage",usage:{...}}`。每次 `next()` 才拉取下一项；取消会传给生成器。Forge 在流尾提供 `{type:"result",result:{text,usage?}}`，它是 after 钩子处理后的最终结果，客户端据此校正已显示的增量。`llm.sample` 聚合这条流，不重复执行钩子。这些适配器服务于 API 5 模型请求，并不替换闭源 Codex 的内部 Agent 循环。

支持的钩子为 `llm.before/after`、`tools.before/after`、`conversation.beforeSend/afterSend`。按声明 `order`、插件 ID 排序，返回 `null` 保持原值，返回 JSON 值替换下一处理器输入，返回 `{cancel:true,reason}` 明确拒绝。llm.after 在流结束后运行，不能撤回已发出的增量。插件工具和模型请求进入各自钩子；原生请求的可观察接入点由主机适配层负责。

## 后台任务与计划

`jobs.start` 输入 `{method,args?,timeoutMs?}`，只执行所属插件已在 `contributes.jobs` 声明的后端方法。宿主在真正执行前重新检查启用状态和权限。任务有 `queued/running/cancelling/completed/failed/cancelled/interrupted` 状态，保存结果、错误、来源会话及时间；列表和读取消只能访问本插件任务。

计划支持 `at`（未来 ISO 时间）、`every`（`intervalMs`，1 秒至 366 天）以及标准五段 `cron`（分、时、日、月、周；支持数字、范围、列表和步长）。cron 可指定 IANA 时区，默认 UTC；同时限定日期与星期时采用通常的 OR 语义，下一次运行搜索上限为 366 天。主机必须运行才会调度；恢复时合并错过的多次循环为一次，再移到下个将来时间。宿主通过 `isEnabled(pluginId)` 控制停用期间的调度，保留用户计划选择；重新启用后才恢复执行。

`schedules.create` 使用 `{name,method,args?,timing,enabled?,timeoutMs?}`。更新需要 `{id,expectedRevision,patch}`，删除需要 `{id,expectedRevision}`，陈旧修订返回 `REVISION_CONFLICT`。手动 `run` 不改变下次计划时间，同一计划已有运行任务时返回 `TASK_BUSY`。计划执行记录最多保留最近 20 项，任务存储最多保留 128 项，活动任务全局最多 16 项。

任务和计划存于独立数据目录的 `plugin-tasks.json`，不写原生会话日志。重启将未完成任务标为 `interrupted`，并恢复计划；执行、记录与外部副作用之间没有跨进程事务，不能保证 exactly-once。插件应让可能重试的任务幂等。退出时调用并等待运行器的 `dispose()`，完成取消及持久化后再删除测试目录。

可运行的源码示例位于 `examples/api5-backend-demo`，其中模型为无网络、无计费的本地回显适配器。
