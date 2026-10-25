# Codex Forge

Codex Forge 是 Windows Codex 客户端的第三方插件宿主，为插件提供原生界面入口、统一设置、会话输出和版本兼容检查。当前版本为 **0.2.0 / Forge API 1**，适配官方客户端 **26.1021.2667.0（Windows x64）**；同时保留 26.1016.8622.0 旧版适配器用于回归。

[下载安装包](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.2.0) · [从零开发插件](docs/PLUGIN-DEVELOPMENT-ZERO-TO-ONE.md) · [API 参考](docs/PLUGIN-API.md) · [更新协议](docs/UPDATES.md)

[DSH 源码对照](docs/DEEPSEEK-HARNESS-MAPPING.md) 记录了 Forge API 对 DeepSeek Harness 的实际借鉴、实现位置和有意保留的边界。

## 安装与启动

1. 从 Release 下载 `Codex-Forge-0.2.0-Windows.msi`，可对照 `SHA256SUMS.txt` 校验；也可以下载 `Codex-Forge-0.2.0-Windows-Portable.zip` 直接解压运行。
2. 双击 MSI 或使用 `msiexec /i` 安装。默认安装在 `%LOCALAPPDATA%\Programs\Codex Forge`，Windows Installer 负责升级和卸载；桌面快捷方式可通过 `CREATEDESKTOPSHORTCUT=0` 关闭。
3. 安装完成后，准备程序从 OpenAI 官方 HTTPS 地址下载适配的 Codex MSIX（约 919 MiB），检查大小、SHA-256、签名、产品身份、版本及架构，再在本地应用 Forge 适配器。
4. 准备成功后运行 **CodexForge.exe**。请先退出其他使用相同配置的 Codex 客户端。

**MSI 和便携 ZIP 只包含 Forge，不包含官方客户端、Node、MSIX 或用户凭据。** 首次准备需要网络和约 7 GB 临时可用空间。下载支持续传；准备失败后再次启动 Forge 可重试，日志位于安装目录的 `forge-prepare.log`。安装阶段不下载官方客户端，启动 `CodexForge.exe` 后才开始准备。

发行包不再使用 Inno Setup 或自解压外层 `Setup.exe`。当前工作区生成的 MSI、ZIP 和其中的 Forge EXE 是未签名构建，只能用于结构、摘要和回归验证；正式 Release 还必须使用可信 Authenticode 证书签名 `CodexForge.exe`、`CodexForgeBootstrap.exe` 和 MSI，再发布清单中的 SHA-256。签名和 Defender 声誉验证未在本地完成。

如需移除当前运行的 Forge，可在项目目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-current-forge.ps1 -WhatIf` 先预览，再去掉 `-WhatIf` 执行。脚本只清理 Forge 安装目录、快捷方式和启动项，保留 `%CODEX_HOME%` 用户数据。

升级成功切换 `current.json` 后，准备程序会自动删除旧的 Forge 管理客户端目录和旧版 MSIX 缓存，以释放官方客户端占用的空间。当前正在运行的旧客户端会跳过本次删除，退出后再次启动 Forge 会继续清理；不带 Forge 安装清单的目录不会触碰。

GitHub 仓库与 Release 已公开，无需登录即可查看源码、下载安装包。客户端通过匿名 HTTPS 读取 GitHub 更新清单；网络或服务访问失败时会显示更新不可用，不会显示成“已是最新版”。

旧“Codex客户端功能增强部署包”停留在 r4-p3。**不提供 r 系列原地升级**，从 r 系列迁移请完整安装 Forge；原有配置和数据继续从同一 `CODEX_HOME` 读取。

## 内置功能

| 功能 | 行为 |
| --- | --- |
| Fast 与模型配置 | API Key / 无需登录的自定义提供商可以使用原生 Fast 控件，保留受管限制；发送时由原生后端转换为 `service_tier: priority`。不开放 API Ultrafast。 |
| 上下文目录保持 | 继续读取用户的 `model_catalog_json`，保留已有 GPT-6.1-Sol 500,000 上下文配置（原生 95% 可用窗口为 475,000）；不全局改写其他模型，也不为新用户强制生成模型目录。 |
| 内置浏览器 | 继承 r3 免登录配置，通过启动参数启用 `desktop.conversationDetailMode="STEPS_COMMANDS"`；保留完整 `@oai` 浏览器组件。该选项可在插件设置中关闭。 |
| 无限画布 | 节点、连线、图片、缩放、撤销/重做、删除/恢复，画布描述/颜色/预览，以及可折叠、可配置网格的分组节点；模型可读取与编辑。 |
| 待办清单 | 个人及会话待办，Codeg 四列状态映射、排序、计划/延后、重试/重新排队/取消、删除/撤销删除和可折叠变更记录。 |
| 智能体协作 | Claude Code、Grok Build、DSH 的模型/思考档位选择、消息直发、折叠输出、结果回读、会话协作图标与摘要列表。协作默认关闭；用户在提示词中明确要求启动协作但尚未勾选本对话时，先由 Codex 发起手动审批，批准后才自动开启当前对话。同步兼容 Codeg 的 `delegate_to_agent`、`get_delegation_status`、`cancel_delegation`、`resume_delegation` 委派协议。 |
| 分级审批 | Claude / Grok 可先尝试原生自动审批，再交给 Codex 审批；DSH 默认先交给 Codex；未获通过再转原生人工审批。 |
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
