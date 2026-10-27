# Codex Forge 与 DeepSeek Harness 对照

这份对照记录 Forge 实际参考的 DSH 设计，以及刻意保留的边界。它不是声称 Forge 复刻了 DSH 的 Cordis 运行时。

## 已采用的设计

| DSH 源码/文档 | Forge 对应实现 | 说明 |
| --- | --- | --- |
| `docs/architecture.md` 的 host/client 分层 | `runtime/forge-host.cjs`、`runtime/forge-preload.cjs`、`runtime/forge-content.cjs` | 插件代码只在 sandbox iframe 运行，所有宿主能力经过 Forge API 和来源窗口校验。 |
| `docs/cordis-primer.md` 的可撤销 effect | `runtime/forge-sdk.js` 的注销函数、`dispose` 事件，以及 preload 的 frame dispose | 左栏、工具栏、输入框和命令注册都能撤销；停用、指纹变化或卸载时销毁 iframe。 |
| `docs/api-gateway.md` 的 Remote 请求关联、参数边界和取消边界 | `forgePluginRequest.id`、`forgePluginReply`、宿主逐请求权限检查 | Forge 用轻量 postMessage/IPC 协议，不把 Electron 对象暴露给插件。当前仍是 unary API，没有 DSH 的生成式 codec 或 Remote stream。 |
| `docs/event-producer-consumer.md` 的领域事件 | 清单 `contributes.events`、`events.on`、`events.emit`、`context.changed`、`settings.changed` 和 `dispose` | Forge 增加了声明后才能发布的受限插件事件广播；事件只适合窗口内轻量同步，不冒充可回放的 session/event。 |
| `docs/agent-lifecycle.md` 的实时状态与持久 settlement 分离 | `runtime/collaboration.cjs`、`runtime/collaboration-store.cjs` | 协作任务把状态、事件游标和最终输出落盘，UI 读取增量事件；模型结果仍是非可信数据。 |
| `docs/subsystems/agent-team.md` 的 durable mailbox、CAS task board、dispose | `runtime/collaboration-store.cjs`、`runtime/todos.cjs`、`runtime/canvas-history.js` | Forge 保留了会话隔离、游标和修订冲突保护；协作外部 CLI 仍是进程级 worker，不是 DSH Agent/Session。 |
| `packages/extensions/ui-cordis/src/client/slots.ts` 的 UI slot | 原生右侧标签页、清单 `contributes.*`、`runtime/native-tabs-renderer.js` | Forge 贡献点使用稳定 surface 和 disposer；插件面板默认进入原生右栏，不叠加自建侧边栏。 |

## 当前明确的差异

- Forge 插件是浏览器扩展面，不是 Cordis Service。DSH UI 适配器只对已提供的浏览器服务实现少量 `ctx.inject()`，不提供任意工具、模型适配器或文件系统 provider；插件不能借 API 获得 Node/IPC 权限。
- Forge 清单是静态兼容和权限声明，插件管理器负责安装、启停、指纹审阅和重启更新；它没有 DSH profile/bundle 的多层 patch 组合，也不提供 HMR 重新组合整个宿主树。
- Forge 的 `events.emit` 只广播 JSON、带 64KB 上限且不写会话日志。需要可靠事实必须用 `storage` 或现有协作/待办存储，不能依赖事件恢复。
- Forge 请求目前是受限的单次请求/响应，返回错误文本；DSH API Gateway 还有生成的类型 codec、结构化错误、可取消调用和双向流。后续若需要模型流或长生命周期服务，应增加新 API 版本，不应把流偷偷塞进 API 1。

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

后续两块按顺序：

1. **命名 UI 贡献点**：宿主声明位置与外壳（标题、动作、菜单项），插件只填 body，用 JSON props 投影宿主数据。DSH 的右侧标签页本身也是 slot（`rightbar` 声明 `sidebar.right.pane.tab`/`.title`/`sidebar.right.tab.menu.item`），不是把整块面板交给插件。
2. **bundle 组合包**：`profile.json`（有序 bundles 与 patches）+ 每个 bundle 一个 patch + 纯函数 `compose`（按 id 后者覆盖前者）。不需要 pnpm、依赖解析或 HMR。

刻意不移植：跨 iframe 的 `waterfall` 中间件（闭包无法安全转发，Forge 只做 `emit` 与 `bail`），以及让插件提供宿主 service 的 Provider 角色。

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

参考依据均来自本机 `D:\Code\.tools\deepseek-harness` checkout，主要文件为 `docs/architecture.md`、`docs/cordis-primer.md`、`docs/api-gateway.md`、`docs/event-producer-consumer.md`、`docs/agent-lifecycle.md`、`docs/subsystems/agent-team.md` 和 `packages/extensions/ui-cordis/src/client/slots.ts`。
