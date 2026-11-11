# 自动提示词预测内置插件

## 目标与范围

新增 `forge.prompt-prediction`。当前本地聊天回复完成后，预测用户下一条可能输入的消息；空输入框显示灰字，Tab 接受为可编辑草稿，Esc 关闭，用户自行发送。打开历史聊天不额外采样，切换回来最多复用有效缓存。保护中文组词、非空草稿、聊天切换、新回合、插件停用与迟到结果。

用户已在宿主聊天明确同意本次升级至 Forge 0.6.0 / API 4；预测插件清单和注册验证以该目标为准。

模型与提供方继承当前聊天。使用普通自建预测标记，不改原生账号资格、远端预测配置或官方免费计费标记。失败不重试、不切换模型、不降级成主聊天 `turn/start`。

用户补充要求：读取可信原生订阅和 `composer-predictions-enabled` 设置。Pro 账号打开原生预测时，本插件取消请求、清除建议且停止采样；关闭时恢复当前已观察到、尚未尝试过的已完成回合及之后新回合的预测机会。仍须通过插件启用、自动预测开关及空草稿检查，不改写用户偏好，不等待原生灰字出现才暂停。

## 分工与接口

本聊天负责新增 `plugins/forge.prompt-prediction/*`、`runtime/prompt-prediction.cjs`、`tests/prompt-prediction.test.cjs`、`tests/prompt-prediction-manifest.test.cjs`、`scripts/check-prompt-prediction.mjs` 和本文档。

「Codex Forge客户端」聊天负责宿主现有共享文件、预测调度与灰字渲染、内置插件启停及设置注册、权限接缝和相应测试。分工和函数契约已确认；任一方接手前先确认原负责方停止修改。

权限使用 `conversation.predict`，能力使用 `prompt-prediction@1`，仅内置 `forge.prompt-prediction` 可声明。宿主内部调用，不增加公共 SDK 模型调用方法。设置为 `enabled:true`、`prompt:DEFAULT_PROMPT`、`maxChars:320`、`timeoutSeconds:30`。

预测模块导出：

```js
predictPrompt({ call, threadId, sourceTurnId, signal, prompt, maxChars = 320, timeoutMs = 30000 })
// -> Promise<{ threadId, sourceTurnId, text: string | null }>
```

`call(method, params, { signal, timeoutMs })` 由宿主在可信的同一原生连接上执行。模块只调用 `thread/sample`，固定 `expectedTurnId`、`disableMcp: true`、`interruptOnCancel: true`、`threadSource/turnTrigger: 'forge_prompt_prediction'`。`prompt` 是预测偏好，外层始终保留只预测用户下一条消息及 JSON 输出约束。结果来源不匹配时拒绝；空、无效、过长或工具调用结果不显示。

宿主必须以原 JSON-RPC 请求 ID 发送 `thread/sample/cancel { requestId }`，并清理超时、取消监听器和迟到响应。取消不得中断原聊天回合。

## 已核对的版本依据

- 初始检查基线为 Forge 0.5.2 / API 3；本次目标为 Forge 0.6.0 / API 4，Codex Windows 仍为 `26.1103.7773.0`。
- 当前安装 CLI 为 `0.167.0-alpha.3.2`；已通过 `app-server generate-json-schema --experimental` 离线核对真实参数和取消协议。
- `ThreadSampleResponse.text` 在试图调用工具或无文本时为 `null`。
- 本功能初次兼容声明只覆盖实际验证的客户端版本；不扩大到未经验证的旧适配器。

## 验收

1. 模块测试验证同源采样、普通调用标记、结果校验、取消、超时与无降级。
2. 宿主测试验证真实消息触发、每回合去重、设置与启停、可信当前线程，以及原请求 ID 取消。
3. 隔离界面验证空草稿灰字、Tab/Esc、非空草稿保护、中文组词、切换聊天和新回合丢弃过期结果。
4. 运行受影响回归和构建；报告本机模拟与真实远端推理的各自证据范围。

本功能随 Forge 0.6.0 / API 4 分发，安装包与版本说明见 [0.6.0 发布页](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.6.0)。

## 验证记录

- 预测模块 11 项针对性测试通过，包含不支持时不重试或降级。
- `scripts/check-prompt-prediction.mjs` 使用当前真实 CLI、独立 `CODEX_HOME` 和 localhost 模拟提供方通过：生成建议、拒绝过期来源、工具调用返回空建议、按 request ID 取消、源聊天历史未变化，未新增源聊天回合。
- 上述 CLI 检查仅使用虚构内容和本地模拟模型，未发送凭据或调用真实远端；报告为 `output/prompt-prediction-native-regression.json`。
- 插件清单注册、设置保存与启停偏好保留验证通过，已纳入宿主回归。
- 最终宿主全量回归 398 项通过，无失败或跳过；日志为 `output/release-060-tests.log` 与 `output/forge-tests.tap`。启动器、准备程序和独立更新器编译及 UI 构建通过；更新器的 32 项校验见 `output/api4-updater-verification.json`。
- 隔离完整原生客户端的 9 项交互检查通过：自动预测与灰字独立、Tab 填草稿而不发送、Esc、待返回时用户草稿保护、组词保护、原生装饰优先、切换聊天丢弃迟到结果、真实按钮停用及重新启用不重采样，以及原生账号/设置接缝已就绪且非 Pro 提供方仍可使用。报告为 `output/playwright/prediction-060-native-ui.json`，对应脚本为 `output/playwright/check-prediction-ui.mjs`。
- 上述界面检查使用当前真实编辑器、真实键盘和 localhost 模拟提供方。组词使用 CDP composition 输入，未验证物理输入法；原生建议冲突使用实际 `data-cumberbatch` 标记模拟，未验证真实 Pro 账号预测服务。隔离配置中的 Windows 配置及模型菜单提示不属于本插件验收，未将普通 UI 发送计入通过。
- 测试先完成虚构种子回合再导航已有聊天，避免原生客户端对未持久化空聊天的 `no rollout` / `list_turns` 限制；未因此修改产品代码。
- 已核对验收客户端中 9 个相关 runtime 文件与当前源码摘要一致。完整性校验通过：4,088 个文件、19,792 个 ASAR 成员、19,827 个完整性块；记录为 `output/playwright/prediction-060-client-integrity.json`。

## 使用与交付边界

升级到本次构建后，在“插件管理”中管理“自动提示词预测”，并通过“设置 → Codex Forge 插件设置 → 自动提示词预测”调整开关、预测偏好、最大长度与超时。本地聊天的新回合完成后自动生成；Tab 接受后仍需用户自行发送。

源码、本地构建与 MSI/ZIP 安装包均包含本功能。验证期间未实际安装或替换用户正在使用的客户端。API 3 独立插件保留数据，但需作者适配 API 4；宿主不自动改写第三方插件。

## 原生订阅联动补充验收

联动由固定版本的原生主进程接缝提供：读取实际设置仓库及 `account/read` 元数据，订阅原生设置、账号与连接变化；不读取凭据，不向插件 iframe 开放状态写入或任意 RPC。版本适配验证原始模块摘要及构造锚点，漂移时构建失败。

| 原生状态 | 插件启用且自动预测开启时的行为 |
| --- | --- |
| `pro` / `prolite` / `promax`，原生预测开启 | 立即取消、清除建议并停止采样，不依赖原生灰字是否出现或模型是否支持原生预测 |
| 原生预测明确关闭 | 恢复当前已观察到且未尝试过的已完成回合；之后的新回合正常预测 |
| 已确认的非 Pro / API Key / 无原生认证提供方 | 保持本插件预测 |
| 原生开关开启，但账号状态未知或读取失败 | 等待可信状态，不发起预测 |
| 本插件停用或其自动预测关闭 | 始终不生成；原生开关变化不改写或重新启用用户偏好 |

- 20 项定向回归通过，覆盖 Pro 家族、原生开关动态切换、取消与迟到结果、账号变化、未知状态、停用优先、重复切换不重试已尝试回合、原生版本适配及摘要/锚点变化拒绝。证据为 `output/native-prediction-policy-tests.log` 与 `output/native-prediction-policy-handoff.json`。
- 最终 9 项原生界面复验使用已加入该接缝的新构建。实际原生状态快照为 `ready:true, nativeEnabled:true, pro:false, paused:false`，确认非 Pro 场景及真实桥接正常；Pro 分支使用受控订阅夹具验证，真实 Pro 账号服务未实测。
- 界面脚本清空草稿使用真实 Ctrl+A/Backspace 并校验结果，避免直接 `fill('')` 未同步到原生草稿状态造成误判。
- 验收完成后已停止本次测试进程，清理 6,084,671,232 字节临时副本（约 5.67 GiB）；报告、截图、客户端清单及原始 MSIX 缓存保留。清理记录为 `output/playwright/prediction-060-temp-cleanup.json`。
