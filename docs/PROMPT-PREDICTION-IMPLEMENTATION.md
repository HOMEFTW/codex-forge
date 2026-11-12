# 自动提示词预测内置插件

`forge.prompt-prediction` 在当前本地聊天的一轮回复完成后，使用该聊天实际模型和提供方的 **low** 档预测下一条用户提示词。只在空输入框显示灰字；Tab 接受为可编辑草稿，Esc 关闭，发送由用户决定。后台聊天完成后，等它显示时生成尚未尝试的预测。仅打开本次客户端没有观察到完成事件的历史聊天，不主动生成。

适配基线：Forge 0.6.2 / API 4、Codex Windows 26.1106.6628.0；保留 26.1103.7773.0 适配器。前次原生连接修复已纳入 0.6.1；0.6.2 安装包进一步合入后台完成、新聊天绑定及诊断分类/原文归档修复。

## 原生订阅优先

主进程通过固定版本的原生接缝读取 `composer-predictions-enabled` 和 `account/read` 元数据。原生 Pro 家族（pro/prolite/promax）开启原生预测时，取消并清空 Forge 预测；关闭后恢复尚未尝试的已完成回合及后续新回合。账号状态未知且原生开关开启时等待，不发起模型请求。插件停用和插件自身的自动预测开关始终优先，不改写用户偏好。

仅原生开关有效值改变才通知预测宿主。同值设置通知不会取消采样或清空建议。账号切换、断开及实际资格变化仍使待处理请求失效。

## 当前调用路径

1. 宿主从原生 app-server 内部通知接收所有本地 `turn/started` / `turn/completed`，有界保存聊天/回合元数据。完成时聊天不在窗口内或窗口尚未注册，也保留完成记录；等它成为当前聊天且输入框为空时才允许生成。旧式渲染器通知仍可用，迟到副本不能重新打开已完成回合或取消新建议；采样按回合去重。
2. `predictPrompt` 优先经宿主原生连接私下读取当前聊天最近三轮摘要和有效模型、提供方、服务档位，不依赖渲染器是否发送过旧式 MCP RPC。最新回合必须仍是指定已完成回合。仅保留用户文字和助手最终回复，忽略系统消息、工具输出、附件和中间 commentary；文本总量最多 24,000 字符。
3. `runLowPrediction` 启动独立后端，在空临时目录创建无持久对话记录的临时聊天。使用源聊天的模型、提供方和服务档位，关闭模型回退，明确设置 `model_reasoning_effort=low`，并核对后端返回的配置。
4. 只在该临时聊天执行一次 `turn/start`，再次固定 `effort=low`，用 JSON Schema 约束建议。原生主连接不执行主聊天的 `turn/start` 或 `thread/start`。不使用原生免费预测标记。
5. 工具、MCP、Hooks、插件、浏览器、环境访问等关闭；拒绝工具、审批及交互请求。原始工具调用事件出现时终止该后端，不执行工具或继续推理。取消、超时、草稿变化、聊天切换和 Pro 接管均终止独立进程。
6. 结果必须为合法 JSON `{"suggestion":"..."}` 或空建议。内容、长度和上下文再次校验后显示灰字，迟到结果丢弃。完整的校验前模型正文按回合单独归档；主动空建议与校验失败记录为不同结果。

用户设置仍为 `enabled:true`、预测偏好、`maxChars:320`、`timeoutSeconds:30`（可选 1–120 秒）。此前考虑过延长默认超时，最终方案保持 30 秒并实际使用 low；主聊天的思考强度和历史不变。

权限为内置专用 `conversation.predict`，不增加公开 SDK 任意模型调用能力。源元数据请求、模型/提供方/服务档位和后台参数均由宿主校验。私有元数据请求取消后的迟到 IPC 回复不会转发给渲染器。

主要文件：`runtime/prompt-prediction.cjs`（文本上下文和结果校验）、`runtime/prompt-prediction-runner.cjs`（独立 low 后端）、`runtime/prompt-prediction-host.cjs`（调度/权限/取消）、`runtime/prompt-prediction-preload.cjs`（灰字/键盘/草稿保护）、`runtime/native-prediction-policy.cjs`（原生订阅联动）。

## 预测内容与输入框高度

预测灰字作为编辑器的兄弟节点，与空编辑器共享同一 CSS Grid 单元，参与原生输入容器的高度计算。中文、长单词和显式换行沿用编辑器排版；宽度变化时自动重排，超过原生最大高度后在原有容器内滚动。预测内容不进入 editable DOM。取消、开始输入、组词、接受或原生预测接管时，移除灰字和临时布局标记，恢复原生布局；编辑器被替换时重新绑定并清理旧标记。

2026-11-12 源码回归 457 项通过；真实 0.6.2 编辑器的合成预测验证了长中文、连续英文、换行、窄输入区、原生高度上限与滚动、短建议收缩。后续在独立客户端启动时载入相同预加载源码，仅替换预测 IPC 为本机夹具，完成实际 Windows 按键验收：Esc 清除预测并恢复 40px，Tab 仅填入可编辑长草稿，开始输入清除预测且保留新草稿。可信键盘事件到达原生编辑器，未调用模型或发送消息；测试草稿、临时监听器和布局标记已清理，隔离窗口已退出。正式客户端的早期调试夹具亦已卸除，没有替换或重启正式安装。证据：`output/prompt-prediction-layout-native.json`、`output/prompt-prediction-layout-keyboard-ui.json`；打包整合交接：`output/prompt-prediction-layout-release-handoff.md`。

## 原生聊天连接修复

用户在当前聊天反馈仍无预测后，发现此前的隔离测试通过手动渲染器 RPC 建立了 `state.bridge`，没有覆盖原生宿主管理聊天且该字段为空的路径。旧实现会在处理完成事件前直接返回，无法开始预测。现改用宿主已有连接和内部完成通知；元数据回复不经过界面 IPC，取消或导航后的迟到读取不会启动推理。

状态快照增加 `diagnostics`，按聊天保留最近完成事件、最近尝试阶段/耗时/错误码，避免切换聊天后把别处的尝试误认为当前聊天结果。默认将当前状态及最近至多 32 条事件/尝试元数据写入 Forge 根目录的 `diagnostics/prompt-prediction.json`，标明实际 PID。状态文件包含原文归档的 `outputFile` 路径，不嵌入模型原文；模型正文按下节单独保存。`CODEX_FORGE_PREDICTION_DIAGNOSTICS=0` 可关闭诊断落盘（含原文归档）。

对应回归先复现 `idle` 而非 `offer`，修复后在没有旧桥的情况下接收宿主完成事件、私下读取源聊天并生成建议；覆盖重复通知去重和导航取消。完整回归 411 项通过，记录为 `output/prompt-prediction-managed-tests.log`。用户随后确认修复成功；真实宿主管理连接（rendererBridge=false）产生 suggestion，耗时 3,734 ms。代理未单独复测该生产窗口的 Tab、物理 IME 或真实 Pro 接管。

## 后台完成及新聊天绑定修复

用户随后反馈“翻译燃油合规声明”及跨对话消息的回复没有预测。该翻译在香港时间 2026-11-12 13:42:46 完成，原生日志没有随后的预测上下文读取；现有旧诊断文件属于已退出的 PID 16572，无法唯一还原该回合当时被哪条条件拦截，不能将它解释为空建议。

已在当前 0.6.1 代码复现：后台回合完成被直接丢弃；新聊天完成事件先于路由绑定也被丢弃，之后切回不会补做。现从宿主连接统一记录事件，在对应聊天显示时恢复未尝试的机会。没有窗口时仍只保存元数据；后台不发起预测。迟到重复开始/完成事件不会改变新回合状态，已尝试、失败或取消的采样不自动重试。

436 项完整回归通过，记录为 `output/prompt-prediction-lifecycle-tests.log`。新增覆盖后台切回、新聊天先完成、窗口尚未注册、多个窗口、迟到副本和后台恢复时的原生 Pro 优先。没有额外调用真实模型服务；本机加载后的实际界面验收与这些测试分开记录。

## 空建议分类与原始输出

后续结果不再把两种情况统一记为 `empty`：

- `empty`：合法 JSON 明确返回 `suggestion:null`（`NULL_SUGGESTION`），或字符串仅为空白（`BLANK_SUGGESTION`）。
- `validation_failed`：无法取得可显示的合法建议。`reason` 区分空响应 `EMPTY_OUTPUT`、非文本响应 `NON_TEXT_OUTPUT`、JSON 解析失败 `INVALID_JSON`、错误结构 `INVALID_SHAPE`、缺少字段 `MISSING_SUGGESTION`、错误字段类型 `INVALID_SUGGESTION_TYPE`、建议超长 `SUGGESTION_TOO_LONG`、控制字符 `CONTROL_CHARACTERS` 和整体输出超长 `OUTPUT_TOO_LONG`。
- `suggestion`：有效建议；原始文本同样保留，界面使用校验及去除首尾空白后的文本。

正常完成的模型文本在校验后不截断、不改写，原样存入 Forge 根目录的 `diagnostics/prompt-prediction-outputs/<threadId>/<sourceTurnId>.json` 的 `rawOutput` 字段。这里的原始输出指校验前的完整模型正文，不包含源聊天提示词、HTTP 凭据、工具日志或私有配置。记录同时保存来源ID、时间、`outcome`、`reason`、字符限制和输出类型；按回合保留，不随32条最近状态记录轮换删除。超时或取消而没有取得完整正文时仍只记录相应状态。此前未保存的旧输出不能补回。

原文通过现有原子 JSON 写入保存，只在宿主本地文件中保留，不通过预测 IPC 返回渲染器。最近尝试的 `outputFile` 指向对应记录；写入失败时记录 `outputRecordError`，并保留有效建议的正常显示。

439 项完整回归通过，记录为 `output/prompt-prediction-output-tests.log`。覆盖主动 null/空白建议、空响应、非法 JSON/结构/字段类型、超长输出和控制字符的分类，逐字保留原文、按回合保留文件、原文不进入渲染器，以及归档写入失败的诊断。没有为验证新增真实模型请求。

## 2026-11-12 验证

- 首次真实旧路径采样确认 `gpt-6-astra / xhigh` 在 30,010 ms 超时；源回合不变。记录：`output/prompt-prediction-real-sample.json`。
- 本机 CLI 实验确认该提供方下 `thread/sample` 未应用单独的 low 覆盖，因此改为独立临时 low 聊天；不把延长超时当作提速方案。
- 用户随后明确要求调用当前模型 low 档。真实 low 验证成功：同一 `gpt-6-astra / custom`，后端确认 low，总耗时 8,246 ms，返回 43 字符可用建议。主聊天仍为 xhigh，近期历史完全一致，主聊天新回合数为 0。记录：`output/prompt-prediction-low-real.json`。报告不保存建议正文或凭据。
- 410 项全套回归通过，构建通过。记录：`output/prompt-prediction-low-tests.log`。
- 真实 CLI + localhost 提供方验证通过：主聊天 xhigh、后台实际 low、同模型、无广告工具、工具尝试立即中止且不追加推理、真实连接取消、源历史不变、未新增源聊天回合。记录：`output/prompt-prediction-native-regression.json`。
- 本次此前的九项隔离原生编辑器检查已经通过；low 路径同步本机后的复验单独记录，不把旧路径界面通过当作新路径证明。
- Pro 接管使用受控原生账号夹具验证，真实 Pro 预测服务未测试。中文组词使用 CDP composition 验证，未测试物理输入法。仅支持当前模型后端能够确认 low 的情况，不静默换模型。

## 0.6.1 新官方基线复验

- 使用 Codex Windows `26.1106.6628.0` 的真实 CLI、本机模拟提供方和隔离 CODEX_HOME，再次确认后台 low、同模型、工具尝试终止、取消与源历史不变。证据：`output/release-061-prediction-cli.json`。
- 在打包载荷生成的隔离 Electron 客户端中，九项编辑器交互全部通过，无渲染错误：灰字、Tab 仅写草稿、Esc、编辑中迟到结果保护、CDP 组词保护、原生装饰模拟优先、切换聊天、插件启停和实际原生账号/设置接缝。证据：`output/playwright/forge061/prediction-061-native-ui.json`。
- 本次 UI 测试通过渲染器 RPC 创建 localhost 源回合，因此不单独证明无旧桥路径；无旧桥行为由宿主回归和上文用户已确认的真实修复证据支持。真实 Pro 服务、物理中文输入法和新版本远端计费模型未测试。

## 发布与安装边界

初版随 Forge 0.6.0 发布，0.6.1 合入原生连接修复及新官方基线适配；0.6.2 安装包合入后台完成、新聊天绑定与输出分类/原文归档修复。本机修复更新 bootstrap 载荷和客户端外部运行模块，并更新完整性清单；重启后加载。恢复副本和摘要见各轮 `output/prompt-prediction-*-local-fix.json`。0.6.2 经本地构建和安装包验证后，按用户授权发布到 GitHub；发布流程没有替换或重启正式客户端。
