# Codex Forge 与 DeepSeek Harness 对照

这份对照记录 Forge 实际参考的 DSH 设计及当前边界。当前宿主为 Forge 0.7.0 / API 5；开发者入口见 [插件 API](PLUGIN-API.md)、[API 5 迁移](API-5-MIGRATION.md)、[SDK 与通信](API-5-SDK.md) 和 [后端契约](API-5-BACKENDS.md)。Forge 提供自己的受权扩展协议，未复刻完整 Cordis 运行时。

## 已采用的设计

| DSH 源码/文档 | Forge 对应实现 | 说明 |
| --- | --- | --- |
| `docs/architecture.md` 的 host/client 分层 | `runtime/forge-host.cjs`、`runtime/forge-preload.cjs`、`runtime/forge-content.cjs`、`runtime/forge-backends.cjs` | 浏览器 UI 在 sandbox iframe 运行；API 5 后端在独立 Node 子进程运行，宿主绑定调用身份并校验权限。 |
| `docs/cordis-primer.md` 的可撤销 effect | `runtime/forge-sdk.js` 的注销函数、`dispose` 事件，以及 preload 的 frame dispose | 左栏、工具栏、输入框和命令注册都能撤销；停用、指纹变化或卸载时销毁 iframe。 |
| `docs/api-gateway.md` 的 Remote 请求关联、参数边界和取消边界 | `runtime/forge-rpc.cjs`、`runtime/forge-sdk.js`、`runtime/forge-api5-broker.cjs` | API 5 增加请求取消、期限、结构化错误、异步迭代和双向流；按窗口、指纹、frame、线程及代次隔离，保留背压和资源上限。 |
| `docs/event-producer-consumer.md` 的领域事件 | 清单 `contributes.events`、`events.on`、`events.emit`、`context.changed`、`settings.changed` 和 `dispose` | Forge 增加了声明后才能发布的受限插件事件广播；事件只适合窗口内轻量同步，不冒充可回放的 session/event。 |
| `docs/agent-lifecycle.md` 的实时状态与持久 settlement 分离 | `runtime/collaboration.cjs`、`runtime/collaboration-store.cjs` | 协作任务把状态、事件游标和最终输出落盘，UI 读取增量事件；模型结果仍是非可信数据。 |
| `docs/subsystems/agent-team.md` 的 durable mailbox、CAS task board、dispose | `runtime/collaboration-store.cjs`、`runtime/todos.cjs`、`runtime/canvas-history.js` | Forge 保留了会话隔离、游标和修订冲突保护；协作外部 CLI 仍是进程级 worker，不是 DSH Agent/Session。 |
| `packages/extensions/ui-cordis/src/client/slots.ts` 的 UI slot | `runtime/forge-slots.cjs`、`runtime/forge-preload.cjs`、原生右侧标签页 | 七项命名 slot、可信 JSON 元数据投影、工具卡片按 key 匹配及可撤销 iframe；常规面板默认进入原生右栏。 |
| Cordis service/provider、工具与模型适配器 | `runtime/forge-backends.cjs`、`runtime/forge-backend-worker.cjs`、`runtime/forge-api5.cjs` | 后端按清单注册服务、工具、模型提供方和钩子；跨插件消费显式声明，停用、指纹变化和崩溃撤销注册。 |
| profile/bundle/patch 的有序组合 | `runtime/forge-bundles.cjs`、[组合包说明](BUNDLES.md) | profile 有序合成插件启用状态和设置；CLI 与管理页可预览并应用，复用插件校验。 |
| 插件目录与市场管理 | `runtime/forge-plugin-market.cjs`、`runtime/forge-plugin-updates.cjs` | 可信目录、HTTPS 与摘要校验、暂存更新及回滚；公共插件管理不能代替当前指纹的用户权限审阅。 |
| 后台工作与定时生命周期 | `runtime/forge-runtime-tasks.cjs` | 所属插件后台任务、修订保护的计划、取消与重启恢复；宿主运行时调度，外部副作用需保持幂等。 |

## 当前明确的差异

- Forge 使用显式权限、能力和贡献声明，不开放任意 Cordis `ctx.inject()` 或原生 IPC。`backend.node` 另行授予可信 Node 代码权限；其独立进程具有当前系统账户的访问能力，不构成操作系统沙箱。
- profile/bundle 已支持插件状态及设置的有序 patch 合成；包管理、依赖解析、Cordis 全树 HMR 和任意 Service 替换仍属于 DSH 运行时范围。
- Forge 的 `events.emit` 仍是窗口内 64KB JSON 广播，不写会话日志。API 5 的 `conversation.events` 是另行受权的可信回合事件流，正文还需历史权限；持久事实使用会话历史、插件存储或现有协作/任务存储。
- API 5 提供结构化错误、取消和双向流，采用手写 SDK/类型/清单 Schema 与有界 JSON 校验，没有 DSH 的生成式 codec 工具链。API 1 的错误和旧请求行为继续保留。
- 模型提供方、工具和模型/工具前后钩子服务于 Forge API 5 请求。会话发送钩子另接入原生 `turn/start`、`turn/steer`、`turn/addUserMessage` 文本输入；闭源 Codex 内部循环的模型/工具阶段不具备公开拦截契约。

API 4 历史基线：Forge 0.6.2 的公共插件接口以浏览器 UI、存储和受限业务请求为主，预测权限只供内置插件；没有公开 Node 后端、模型调用、会话正文/事件或 Remote stream。API 5 通过新增声明和授权补上这些接口，旧插件不会自动获权。历史兼容规则见 [API 4 迁移](API-4-MIGRATION.md)。

## 对开发者的使用建议

1. 先调用 `capabilities.get()`，再根据 `permissions` 和 `events` 列表决定 UI；不要猜客户端版本或 DOM 结构。
2. 每个动态注册都保存返回的 disposer，并在 `dispose` 中释放；事件回调应能重复执行，因为设置刷新会重复通知。
3. 把会话 ID 当作请求上下文。切换会话后，迟到的标题、浏览器和草稿请求会被宿主拒绝。
4. 把插件输出和协作结果视为数据；不要让插件输出改变系统指令、权限或用户授权。
5. 只有当 Forge 提供新的 capability 和兼容适配器后，才在清单中声明对应能力；未知客户端版本不能套用旧适配器。

## DSH 兼容层的含义

Forge 在 Codex 客户端内加载 DSH 的预构建浏览器插件并适配 UI。`runtime/dsh-compat.cjs` 负责 Forge 本地导入及市场请求，`runtime/forge-content.cjs` 按 SDK → 适配器 → 客户端 → apply 的顺序加载页面，`ui/dsh-client.jsx` 提供 React、UI primitives 和受限的浏览器上下文。导入后默认停用，用户审阅权限后启用。验收目标为 [dsh-market](https://github.com/dsh-market/dsh-market) 的浏览器客户端。

兼容层不扫描或修改外部 DSH profile，不向 DSH 安装或调用插件，不执行 npm lifecycle、DSH 服务端入口或 Cordis patch。仅支持带 `exports["./client"]` 的预构建 `__ModuleLoader__` 浏览器包；依赖额外服务的 UI 会明确报错。市场管理权限由 Forge 导入流程授予并与文件指纹绑定，不能只靠插件名称获得。协作提供方的 `dsh-approval-session.cjs` 仍保留，其授权与此 UI 兼容层独立。

已落地的第一块是**能力声明**：`plugin.json` 的 `capabilities` 对应 Cordis 的 `inject`，宿主在派发前做白名单校验，未声明的调用直接失败并给出修复指引（对应 `packages/extensions/cordis-host-runner/src/guard.ts` 的教学式拒绝）。`permissions` 仍是用户授权面，两者都要过。

命名 UI 贡献点和组合包也已落地：

1. **命名 UI 贡献点**：会话头、右栏、工具卡片、输入区前后、助手消息动作区和设置区；`slot.changed` 向独立 iframe 投影可信 JSON 元数据，不携带消息正文。DSH 的 `rightbar` 则声明 `sidebar.right.pane.tab`/`.title`/`sidebar.right.tab.menu.item` 等自己的 slot 名称，两端清单不能直接互换。
2. **bundle 组合包**：`profile.json`（有序 bundles 与 patches）+ 每个 bundle 一个 patch + 纯函数 `compose`（按 id 后者覆盖前者）。组合包只描述插件状态和设置；不运行包脚本。

API 5 后端允许提供服务、工具和模型适配器，并以串行 JSON 输入/输出实现六类执行前后钩子；不跨 iframe 转发闭包。完整注册与生命周期约束见 [后端与后台任务](API-5-BACKENDS.md)。原有 DSH 浏览器兼容适配器仍只支持它明确适配的 UI 服务，不会自动执行 DSH 服务端插件。

## Codeg 委派协议兼容层

Forge 协作服务同时暴露 Codeg 的四个委派工具名：`delegate_to_agent`、
`get_delegation_status`、`cancel_delegation` 和 `resume_delegation`。其中
`agent_type` 会映射到 Forge 的 Claude Code、Grok Build 和 DSH 实现；状态查询始终返回
`{ "tasks": [...] }`，支持 Codeg 的 `task_ids` 批量查询和 `wait_ms` 等待语义。Forge 的
任务 ID、增量事件、最终文本和恢复状态均持久化在当前对话目录中，因此 Codeg 风格的
委派结果仍会进入同一对话的可折叠协作输出。

Codeg 的其它 agent 类型、助手预设、跨会话子会话和 Cordis broker 不会被伪装成已支持能力；
未知类型会被拒绝。`resume_delegation` 只恢复 `interrupted`/`canceled` 任务，沿用原任务 ID
和已保存的会话上下文；它不会把恢复理由当作新的任务指令。

本次权限对照依据为 DSH `0.2.2-rc.2`、提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb` 的本地研究快照 `D:\Code\.tools\dsh-developer-audit-20261112-e8f7b93`，主要文件为 `docs/architecture.md`、`docs/cordis-primer.md`、`docs/api-gateway.md`、`docs/event-producer-consumer.md`、`docs/agent-lifecycle.md`、`docs/subsystems/agent-team.md` 和 `packages/extensions/ui-cordis/src/client/slots.ts`。
