# Codex Forge

Codex Forge 是 Windows Codex 客户端的第三方插件宿主，为插件提供原生界面入口、统一设置、会话输出和版本兼容检查。当前版本为 **0.3.1 / Forge API 2**，适配官方客户端 **26.1023.6123.0（Windows x64，更新源构建 26.1023.6621.0）**；同时保留 26.1021.2667.0 和 26.1016.8622.0 适配器用于回归。

[下载安装包](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.3.1) · [从零开发插件](docs/PLUGIN-DEVELOPMENT-ZERO-TO-ONE.md) · [API 参考](docs/PLUGIN-API.md) · [更新协议](docs/UPDATES.md)

[DSH 源码对照](docs/DEEPSEEK-HARNESS-MAPPING.md) 记录了 Forge API 对 DeepSeek Harness 的实际借鉴、实现位置和有意保留的边界。

## 0.3.1 更新

- **新版客户端适配**：新增固定版本适配器，更新原生右侧标签、设置入口、Fast 控件及后端注入点；保持 Forge API 2，九个内置插件及示例同步兼容新客户端。
- **指纹检测修复**：不再用磁盘回合状态选择 `lastTurnId`，避免把运行中的回合误当作已中断回合；直接校验临时分支创建响应，避免后续读取的空来源 ID 覆盖正确结果。
- **检测清理**：校验失败、取消和异常时释放本次临时分支，检测完成后关闭进程管道；保留模型、提供商、思考强度及临时分支隔离检查。

## 0.3.0 更新

- **左栏信息卡**：账号区上方显示当前对话最近响应的 Agent 速度（tok/s）与模型指纹，点击打开右侧统计。确认不符时指纹变红；过期、未收录和弱证据分别标注，支持深浅主题和窄栏。
- **信息统计重写**：概览、模型检测和历史三视图；参考 agent-speed、ModelTrace、is-gpt-nerfed，提供 Token/速度统计、数字指纹及模型、思考强度、窗口变化记录。[来源与许可证](plugins/forge.information-stats/SOURCES.md)。指纹是概率诊断，不证明服务端身份；主动采样由用户手动启动并可能消耗模型额度，参考库未收录 `gpt-6.1-sol`。
- **记忆管理重写**：双目录检索、来源与分类筛选、排序、备注新建/重命名/删除、草稿保留及保存冲突保护；生成摘要和历史只读。
- **独立 500K 修复**：启动时生成专用模型目录，并传入原生后端及检测进程，仅覆盖 `gpt-6.1-sol`。本地协议验证报告 475,000 可用窗口；远端服务接受真实长输入仍取决于提供商。
- **Forge API 2**：能力声明与查询、具名 UI 插槽、组合包/profile、内置开发检查器、DSH 预构建客户端导入。内置插件与示例统一使用 API 2；API 1 插件保留清单读取及诊断，作者迁移后方可在 API 2 宿主中启用。见 [API 迁移说明](docs/PLUGIN-API.md) 与 [组合包](docs/BUNDLES.md)。

## 安装与启动

1. 从 Release 下载 `Codex-Forge-0.3.1-Windows.msi`，可对照 `SHA256SUMS.txt` 校验；也可以下载 `Codex-Forge-0.3.1-Windows-Portable.zip` 直接解压运行。
2. 双击 MSI 或使用 `msiexec /i` 安装。默认安装在 `%LOCALAPPDATA%\Programs\Codex Forge`，Windows Installer 负责升级和卸载；桌面快捷方式可通过 `CREATEDESKTOPSHORTCUT=0` 关闭。
3. 安装完成后，准备程序从 OpenAI 官方 HTTPS 地址下载适配的 Codex MSIX（约 934 MiB），检查大小、SHA-256、签名、产品身份、版本及架构，再在本地应用 Forge 适配器。
4. 准备成功后运行 **CodexForge.exe**。请先退出其他使用相同配置的 Codex 客户端。

**MSI 和便携 ZIP 只包含 Forge，不包含官方客户端、Node、MSIX 或用户凭据。** 首次准备需要网络和约 7 GB 临时可用空间。下载支持续传；准备失败后再次启动 Forge 可重试，日志位于安装目录的 `forge-prepare.log`。安装阶段不下载官方客户端，启动 `CodexForge.exe` 后才开始准备。

0.3.0 用户可运行新版 MSI 升级；从 0.2.x 升级请手动下载 0.3.1 MSI 并运行；旧客户端的 API 1 更新器不能直接接受 API 2 发布清单。已有 API 1 第三方插件会显示版本不兼容，须由作者迁移；用户数据继续保留。

发行包使用 MSI 和便携 ZIP。**0.3.1 的 Forge EXE 与 MSI 未进行 Authenticode 签名**，Windows 可能显示未知发布者。`SHA256SUMS.txt` 用于核对下载文件完整性，不替代发布者签名；签名和 Defender 声誉验证尚未完成。

如需移除当前运行的 Forge，可在项目目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-current-forge.ps1 -WhatIf` 先预览，再去掉 `-WhatIf` 执行。脚本只清理 Forge 安装目录、快捷方式和启动项，保留 `%CODEX_HOME%` 用户数据。

升级成功切换 `current.json` 后，准备程序会自动删除旧的 Forge 管理客户端目录和旧版 MSIX 缓存，以释放官方客户端占用的空间。当前正在运行的旧客户端会跳过本次删除，退出后再次启动 Forge 会继续清理；不带 Forge 安装清单的目录不会触碰。

GitHub 仓库与 Release 已公开，无需登录即可查看源码、下载安装包。客户端通过匿名 HTTPS 读取 GitHub 更新清单；网络或服务访问失败时会显示更新不可用，不会显示成“已是最新版”。

旧“Codex客户端功能增强部署包”停留在 r4-p3。**不提供 r 系列原地升级**，从 r 系列迁移请完整安装 Forge；原有配置和数据继续从同一 `CODEX_HOME` 读取。

## 内置功能

| 功能 | 行为 |
| --- | --- |
| Fast 与模型配置 | API Key / 无需登录的自定义提供商可以使用原生 Fast 控件，保留受管限制；发送时由原生后端转换为 `service_tier: priority`。不开放 API Ultrafast。 |
| GPT-6.1-Sol 独立 500K | 启动时基于用户模型目录（或 `models_cache.json`）生成 Forge 专用覆盖目录，仅将 `gpt-6.1-sol` 设置为 500,000（95% 可用窗口为 475,000），传给原生后端与检测进程。缺少该条目时沿用 GPT-6-Sol 能力描述；其他模型和原配置文件不改写。无可用目录时输出启动诊断。 |
| 信息统计 | 左栏底部速度/指纹卡片，确认不符时红字提示；右侧概览、检测、历史三视图，显示端到端速度、加权均速、缓存/推理 Token、日志上下文占用及模型/思考强度/窗口变更。三组临时分支数字检测由用户手动启动。 |
| 记忆管理 | 搜索双记忆目录，按来源、分类及时间/名称筛选；自定义备注新建、重命名、删除、冲突保护与面板内草稿保留；生成摘要和历史保持只读。 |
| 内置浏览器 | 继承 r3 免登录配置，通过启动参数启用 `desktop.conversationDetailMode="STEPS_COMMANDS"`；保留完整 `@oai` 浏览器组件。该选项可在插件设置中关闭。 |
| 无限画布 | 节点、连线、图片、缩放、撤销/重做、删除/恢复，画布描述/颜色/预览，以及可折叠、可配置网格的分组节点；模型可读取与编辑。 |
| 待办清单 | 个人及会话待办，Codeg 四列状态映射、排序、计划/延后、重试/重新排队/取消、删除/撤销删除和可折叠变更记录。 |
| 智能体协作 | Claude Code、Grok Build、DSH 的模型/思考档位选择、消息直发、折叠输出、结果回读、会话协作图标与摘要列表。协作默认关闭；用户在提示词中明确要求启动协作但尚未勾选本对话时，先由 Codex 发起手动审批，批准后才自动开启当前对话。协作要求和外部结果会作为标记数据回写当前对话，避免只出现在面板里。同步兼容 Codeg 的 `delegate_to_agent`、`get_delegation_status`、`cancel_delegation`、`resume_delegation` 委派协议。 |
| 分级审批 | 默认沿用各 CLI 的原生审批（执行前会询问）；可在协作面板改为“原生自动审批 → Codex → 人工”。DSH 默认先交给 Codex；未获通过再转原生人工审批。 |
| Codeg 技能包 | 四组 37 项技能及参考资源，按智能体独立启用；默认停用。第三方工具和服务仍需自行配置。 |

Fast 插件默认以进程参数启用 Fast；设置为 `native` 时尊重原生速度选择。停用插件则不注入 Fast 配置。已有会话的显式速度选择仍有效，Fast 请求是否获得加速取决于模型服务的支持。

原生工具栏依次为 **帮助 → 升级 → 插件管理**。插件面板默认使用原生右侧标签页，所有设置集中在客户端设置的 **Codex Forge 插件设置**。插件卡片的“设置”按钮直接定位对应插件。

插件管理支持本地目录安装、启停、卸载，以及 GitHub / 私有 HTTPS 服务器更新。更新前、解包后及重启应用时均检查 Codex、Forge、API 与依赖兼容性。更新后提示重启；新增权限需要重新启用。内置插件随 Forge 更新。

“升级”同时检查官方客户端与 Forge 的发布，匹配经过验证的版本组合后才提供更新。扩展插件功能与日志、Forge 功能介绍、Forge 升级日志分别放在独立入口中。

## 开发与构建

需要 Windows x64、Node.js 22+（支持 `import.meta.dirname`）、.NET Framework 4.8 C# 编译器和 WiX Toolset 7。构建器默认查找 `D:\Code\.tools\nuget-packages\wixtoolset.sdk\7.0.0\tools\net472\x64\wix.exe`，也可设置 `WIX_EXE`。

```powershell
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-launcher.ps1
node scripts/run-tests.mjs
node scripts/build-installer.mjs
```

安装器输出到 `release/dist/`，包含 per-user MSI、Portable ZIP、`SHA256SUMS.txt` 和 `codex-forge-release.json`。更新下载 MSI 并交给 Windows Installer；便携版本需要手动下载。`release/forge-only/payload/forge-payload.json` 记录 Forge 文件摘要；构建器拒绝官方 EXE、ASAR、Node 和 MSIX 混入安装包。

需要本地开发客户端时，先自行下载并核验适配清单指定的官方 MSIX，将 `app/` 安全解包（路径 URI 解码一次），再执行：

```powershell
npm run build:client -- D:/path/to/verified-official/app
node scripts/verify-install.mjs release/package-full
```

构建器验证原始 ASAR 和 EXE 的固定 SHA-256，精确匹配适配锚点，重算 ASAR 成员、块和 EXE 中的头摘要。保留原生完整性检查、fuses、sandbox、contextIsolation 和 webSecurity。修改后的客户端 EXE 不再具有有效的原始签名。`release/package-full` 仅供本地开发，**不得作为本项目的 Release 附件**。

[插件清单 Schema](sdk/plugin.schema.json) · [TypeScript SDK](sdk/index.d.ts) · [可运行示例](examples/hello-forge) · [验证范围](docs/VALIDATION.md)

## 数据与来源

Forge 数据默认在 `%CODEX_HOME%/forge`（缺省 `%USERPROFILE%/.codex/forge`）；画布、待办、协作与技能数据在 `%CODEX_HOME%/fast-canvas`。Forge 不复制账号、密钥、历史或第三方 CLI 配置到安装包，卸载不会删除 `.codex` 数据。

本项目参考 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的宿主/客户端边界及 UI 贡献点，以及 [Codeg](https://github.com/spacering-net/codeg) 的配置、ACP 能力探测和技能组织。技能来源、固定提交与许可证见 [CODEG-SKILLS-NOTICES.md](CODEG-SKILLS-NOTICES.md)。Forge 原创代码使用 MIT；第三方资源遵循各自许可证。Codex 是 OpenAI 的产品，本项目不是官方插件 API，也不重新分发官方客户端。
