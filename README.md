# Codex Forge

Codex Forge 是面向 Windows Codex 客户端的第三方插件宿主，将模型配置、信息统计、记忆管理、画布、待办和智能体协作集中到原生界面中。它为内置及独立插件提供统一的安装管理、设置入口、会话输出和版本兼容检查。

当前版本 **0.5.0 / Forge API 3**，适配官方客户端 **26.1103.4239.0（Windows x64，MSIX 身份版本）**。本项目不是 OpenAI 官方插件 API。

[下载安装包](https://github.com/HOMEFTW/codex-forge/releases/latest) · [更新日志与版本索引](docs/CHANGELOG.md) · [从零开发插件](docs/PLUGIN-DEVELOPMENT-ZERO-TO-ONE.md) · [API 参考](docs/PLUGIN-API.md)

| 下载 0.5.0 | 用途 |
| --- | --- |
| [Windows MSI](https://github.com/HOMEFTW/codex-forge/releases/download/v0.5.0/Codex-Forge-0.5.0-Windows.msi) | 推荐用于首次安装及已有安装版升级。 |
| [便携 ZIP](https://github.com/HOMEFTW/codex-forge/releases/download/v0.5.0/Codex-Forge-0.5.0-Windows-Portable.zip) | 解压后运行，无需 MSI 安装。 |
| [独立更新器](https://github.com/HOMEFTW/codex-forge/releases/download/v0.5.0/Codex-Forge-0.5.0-Updater.exe) | 可选备用工具，选择已有 Forge 安装目录后检查、下载或修复。 |

[SHA-256 校验文件](https://github.com/HOMEFTW/codex-forge/releases/download/v0.5.0/SHA256SUMS.txt) · [完整发布说明](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.5.0)

## 主要功能

| 功能 | 说明 |
| --- | --- |
| Fast 与模型配置 | 控制对话中可选的模型和默认速度，支持 GPT-6.1-Terra、Fast 和独立 Ultrafast 档位。保存配置并完整重启后生效，实际加速能力取决于服务商。 |
| GPT-6.1-Sol 独立 500K | 为 `gpt-6.1-sol` 提供独立上下文配置，不覆盖其他模型；本地协议报告可用窗口为 475,000，远端接受能力取决于服务商。 |
| 信息统计 | 左栏显示当前 Agent 速度与模型指纹，确认不符时红字提示；右侧提供 Token、速度、上下文占用和历史记录。主动指纹检测需手动启动，属于概率诊断。 |
| 记忆管理 | 搜索双记忆目录，按来源、分类和时间筛选；支持自定义备注编辑、重命名、删除、草稿保留与冲突保护。 |
| 中文界面 | 启用原生语言设置，沿用官方中文资源并补充新版桌面文本；可切换其他语言。 |
| 插件、浏览器与电脑操作 | 原生插件、内置/外部浏览器和 Windows 电脑操作分别配置，保留账号策略和操作授权；Windows 电脑操作使用官方运行时。 |
| 独立更新器 | 作为可选备用入口，常规升级失败时切换；支持 HTTP 代理、续传、SHA-256 校验、增量回退以及 MSI / 便携升级。 |
| 无限画布 | 管理节点、连线、图片和分组，支持缩放、撤销、重做与恢复；模型可读取和编辑画布。 |
| 待办清单 | 管理个人及会话待办，支持状态、排序、计划、延后、重试和删除恢复。 |
| 智能体协作 | 对接 Claude Code、Grok Build 和 DSH，管理模型、思考档位、消息与结果回读；协作默认关闭，按对话授权启用。 |
| 分级审批 | 沿用 CLI 原生审批，并支持在协作面板配置 Codex 审核及人工处理流程。 |
| Codeg 技能包 | 提供四组 37 项技能及参考资源，按智能体独立启用；第三方工具和服务需自行配置。 |

原生工具栏提供 **帮助 → 升级 → 插件管理**。插件面板使用原生右侧标签页，设置集中在 **客户端设置 → Codex Forge 插件设置**。

## 插件管理与扩展

在“插件管理”中直接导入 **ZIP、7z 或 `.forge-plugin.json`**，也可以从本地插件目录安装。首次安装后审阅权限并启用；已有同 ID 插件可直接导入新版或同版本修订包覆盖升级，重启后生效，保留设置和数据，权限变化需重新启用。插件可在左侧栏等位置注册入口及专用图标。

插件管理支持启停、卸载以及 GitHub / 私有 HTTPS 服务器更新；安装和更新时检查 Codex、Forge、API 与依赖兼容性。新增权限需要重新启用，内置插件随 Forge 更新。“升级”入口会检查官方客户端与 Forge 的发布，并匹配经过验证的版本组合。

**[星枢 Nexus](https://github.com/HOMEFTW/codex-forge-nexus) 是独立插件，需另行安装。** 从[独立插件发布页](https://github.com/HOMEFTW/codex-forge-nexus/releases/latest)下载 ZIP 后，在 Forge 插件管理中直接导入并启用。它提供 Obsidian 笔记阅读与编辑、双链、搜索、关系图谱、数据库等知识库功能；支持范围和 DataviewJS 限制见 [Nexus 使用说明](docs/NEXUS.md)。插件开发参考 [开发教程](docs/PLUGIN-DEVELOPMENT-ZERO-TO-ONE.md)、[API 参考](docs/PLUGIN-API.md)、[API 3 迁移](docs/API-3-MIGRATION.md) 与 [更新协议](docs/UPDATES.md)。

## 安装与启动

1. 从上方下载 MSI 或便携 ZIP，可对照 `SHA256SUMS.txt` 校验。
2. 双击 MSI 或使用 `msiexec /i` 安装。默认安装在 `%LOCALAPPDATA%\Programs\Codex Forge`，Windows Installer 负责升级和卸载；桌面快捷方式可通过 `CREATEDESKTOPSHORTCUT=0` 关闭。
3. 安装完成后，准备程序从 OpenAI 官方 HTTPS 地址下载该 Forge 版本适配的 Codex MSIX（约 1 GiB），检查大小、SHA-256、签名、产品身份、版本及架构，再在本地应用 Forge 适配器。
4. 准备成功后运行 **CodexForge.exe**。请先退出其他使用相同配置的 Codex 客户端。

**MSI 和便携 ZIP 只包含 Forge，不包含官方客户端、Node、MSIX 或用户凭据。** 首次准备需要网络和约 7 GB 临时可用空间。下载支持续传；准备失败后再次启动 Forge 可重试，日志位于安装目录的 `forge-prepare.log`。安装阶段不下载官方客户端，启动 `CodexForge.exe` 后才开始准备。

0.4.x 用户可运行新版 MSI，或退出便携版后将新版 ZIP 解压到原便携目录。0.3.x / 0.2.x 用户请手动下载并运行新版 MSI；已发布旧更新器不接受 API 3 清单。

**默认升级流程保持不变：检查 Codex 与 Forge 更新 → 下载并校验 → 安装已验证版本。** 检查、下载或安装失败时，显示原因并切换独立更新器；也可从“升级 → 备用方式”手动打开。没有匹配版本、安装成功或用户取消安装时不会自动切换。独立更新器安装前需要完整退出客户端。

独立插件须声明兼容 Forge 0.5.0 和目标 Codex 版本，API 3 相同不代表版本范围自动兼容；API 1/2 插件还须由作者迁移。升级保留用户数据，不改写第三方插件兼容声明。

独立更新器为安装目录内的 `CodexForgeUpdater.exe`，开始菜单也有入口；单独下载的更新器可选择现有 Forge 安装目录。[使用与恢复说明](docs/UPDATER.md)。Ultrafast 在模型目录已支持时自动显示；自定义服务可在 Fast 插件中填写支持该档位的模型 ID。

发行包使用 MSI 和便携 ZIP。**发行包的 Forge EXE 与 MSI 未进行 Authenticode 签名**，Windows 可能显示未知发布者。`SHA256SUMS.txt` 用于核对下载文件完整性，不替代发布者签名；签名和 Defender 声誉验证尚未完成。

如需移除当前运行的 Forge，可在项目目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-current-forge.ps1 -WhatIf` 先预览，再去掉 `-WhatIf` 执行。脚本只清理 Forge 安装目录、快捷方式和启动项，保留 `%CODEX_HOME%` 用户数据。

升级成功切换 `current.json` 后，准备程序保留前一客户端供恢复，并清理更早的 Forge 管理客户端目录和旧版 MSIX 缓存，以释放官方客户端占用的空间。当前正在运行的旧客户端会跳过本次删除，退出后再次启动 Forge 会继续清理；不带 Forge 安装清单的目录不会触碰。

GitHub 仓库与 Release 已公开，无需登录即可查看源码、下载安装包。客户端通过匿名 HTTPS 读取 GitHub 更新清单；网络或服务访问失败时会显示更新不可用，不会显示成“已是最新版”。

旧“Codex客户端功能增强部署包”停留在 r4-p3。**不提供 r 系列原地升级**，从 r 系列迁移请完整安装 Forge；原有配置和数据继续从同一 `CODEX_HOME` 读取。

## 开发与构建

需要 Windows x64、Node.js 22+（支持 `import.meta.dirname`）、.NET Framework 4.8 C# 编译器和 WiX Toolset 7。构建器默认查找 `D:\Code\.tools\nuget-packages\wixtoolset.sdk\7.0.0\tools\net472\x64\wix.exe`，也可设置 `WIX_EXE`。

```powershell
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-launcher.ps1
node scripts/run-tests.mjs
node scripts/build-installer.mjs
```

安装器输出到 `release/dist/`，包含 per-user MSI、Portable ZIP、独立更新器 EXE、`SHA256SUMS.txt` 和 `codex-forge-release.json`。常规流程下载 MSI 并交给 Windows Installer；备用独立更新器还支持直接校验安装便携 ZIP。`release/forge-only/payload/forge-payload.json` 记录 Forge 文件摘要；构建器拒绝官方 EXE、ASAR、Node 和 MSIX 混入安装包。

需要本地开发客户端时，先自行下载并核验适配清单指定的官方 MSIX，将 `app/` 安全解包（路径 URI 解码一次），再执行：

```powershell
node release/forge-only/payload/scripts/build-client.mjs D:/path/to/verified-official/app D:/Code/codex-forge/release/package-full
node scripts/verify-install.mjs release/package-full
```

构建器验证原始 ASAR 和 EXE 的固定 SHA-256，精确匹配适配锚点，重算 ASAR 成员、块和 EXE 中的头摘要。保留原生完整性检查、fuses、sandbox、contextIsolation 和 webSecurity。修改后的客户端 EXE 不再具有有效的原始签名。`release/package-full` 仅供本地开发，**不得作为本项目的 Release 附件**。

[插件清单 Schema](sdk/plugin.schema.json) · [TypeScript SDK](sdk/index.d.ts) · [可运行示例](examples/hello-forge) · [验证范围](docs/VALIDATION.md)

## 数据与来源

Forge 数据默认在 `%CODEX_HOME%/forge`（缺省 `%USERPROFILE%/.codex/forge`）；画布、待办、协作与技能数据在 `%CODEX_HOME%/fast-canvas`。Forge 不复制账号、密钥、历史或第三方 CLI 配置到安装包，卸载不会删除 `.codex` 数据。

客户端本地化、速度档位、电脑操作及独立更新器的设计参考 [CodexDesktop-Rebuild](https://github.com/AnLifeX/CodexDesktop-Rebuild)（调研提交 `46b7c54`），按 Forge 的轻量分发结构独立实现。

本项目参考 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的宿主/客户端边界及 UI 贡献点，以及 [Codeg](https://github.com/spacering-net/codeg) 的配置、ACP 能力探测和技能组织。技能来源、固定提交与许可证见 [CODEG-SKILLS-NOTICES.md](CODEG-SKILLS-NOTICES.md)。Forge 原创代码使用 MIT；第三方资源遵循各自许可证。Codex 是 OpenAI 的产品，本项目不是官方插件 API，也不重新分发官方客户端。

[DSH 源码对照](docs/DEEPSEEK-HARNESS-MAPPING.md) 记录 Forge 的参考实现与边界；历史功能变更统一见 [更新日志](docs/CHANGELOG.md)。
