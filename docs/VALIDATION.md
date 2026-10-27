# 0.3.0 验证范围（2026-10-27）

- `npm run build` 与 Windows 启动器/准备程序编译成功。Forge、npm/lockfile、两个适配器、九个内置插件、SDK、示例及组合包统一为 0.3.0 / API 2；清单格式的 schemaVersion 单独管理。
- `node scripts/run-tests.mjs`：231 项通过，0 失败、0 跳过。新增版本一致性、API 1 插件迁移诊断及 API 1/2 混合发布列表回归。原生 IPC、DSH 导入、信息统计、记忆管理及 Windows 准备程序均包含在该套件内。
- 左栏信息卡使用真实 preload 组件与隔离模拟数据进行 Edge/Playwright 验证：深浅主题、展开/窄栏、账号区避让、不符红字、过期/未收录状态、点击/键盘、隐藏与小窗口；没有使用截图模拟数据冒充真实模型检测结果。
- 信息统计算法与三个指定上游对照，记忆管理的草稿/冲突与只读生成文件已验证；详细范围和来源见 [重写记录](REWRITE-2026-10-27.md)。独立 500K 在本地 Responses 模拟服务上验证 6.1-sol 为 475,000、6-sol 为 258,400；真实远端长输入和付费指纹检测未执行。
- 发布产物为 Forge-only MSI 与 Portable ZIP，附真实大小、SHA-256 和更新清单。安装包不包含官方客户端、Node、MSIX 或用户凭据。Forge EXE 与 MSI 未签名，不声称具有 Authenticode 或 Defender 声誉验证。
- 本次未在用户机器执行 MSI 安装/卸载，也未替换或重启当前正在运行的客户端。API 1 第三方插件需作者迁移至 API 2；0.2.x 首次升级须手动下载 MSI。

## 0.2.0 历史验证记录

- 自动回归：163 项全部通过；隔离副本与原仓库（提升权限以绕过 D:\Code\codex-forge\output 的测试 ACL）均为 163/163；独立运行 `tests/fixtures/bootstrap-runner.ps1` 的准备程序回归通过。协作专项覆盖“明确请求但未勾选时等待 Codex 手动审批、批准后开启、拒绝后保持关闭”、原生审批表单，以及协作要求和结果回写当前原生线程；还覆盖 wait_ms=0 立即轮询以及无 conversation.read 事件的窗口隔离，以及从 0.1.0 恢复的 Forge/协作页面基础视觉样式。其余测试涵盖画布/待办、协作/审批/会话路由、技能摘要、插件生命周期/权限/兼容/更新及准备程序路径与身份校验。本轮修复新增 4 条回归（MSI 落盘后再校验、适配器 patchSet、原生符号整词替换、DSH 运行时版本自探测）；`run-tests.mjs` 现在默认要求 skipped=0，受限宿主必须显式设置 `FORGE_ALLOW_SKIP=1`，跳过用例不再计入通过。
- Fast：修复启动开关未进入隔离渲染进程的问题；验证 API Key、无需登录提供商、受管限制、加载/注销与停用场景。
- 后端本地模拟请求：GPT-6.1-Sol 实际发送 `service_tier: priority`，读取 500,000 模型目录并报告 475,000 可用上下文；不调用付费模型服务。
- 浏览器配置：原生后端读到 `desktop.conversationDetailMode = STEPS_COMMANDS`。未登录 OpenAI 的隔离客户端已通过插件 API 打开内置浏览器并读取 Example Domain 页面。
- 官方客户端下载：准备程序按当前适配清单校验 962,865,293 字节包，SHA-256 与适配清单一致；准备程序的签名检查为 Valid；安装收据绑定稳定 payloadDigest，同版本内容变化会进入摘要目录而不会复用旧客户端。已完成安全解包、Forge 适配、全部文件校验并生成 ready 结果。临时工作区权限和超过 260 字符的路径已纳入修复。
- 原生界面：Fast 闪电图标恢复；统一设置深链接、原生右侧标签、输入草稿、会话标题、可折叠输出和浏览器派发实测通过。
- 生成的客户端：3,923 个文件、21,786 个 ASAR 成员和 21,818 个完整性块校验通过。
- 教程：从文档提取示例代码，实际完成 create / validate / install / enable / settings / pack / uninstall，并执行示例命令。
- 安装包内容由白名单和摘要清单审计，生成 per-user MSI 与 Portable ZIP，禁止捆绑官方 EXE、ASAR、Node、MSIX 和用户配置。
- 本地发行包使用 MSI/Portable 结构，不再生成自解压外层 `Setup.exe`；本地 `CodexForge.exe`、`CodexForgeBootstrap.exe` 和 MSI 未签名，正式发布前仍需可信 Authenticode 签名和 Defender 声誉验证。

外部 Claude Code、Grok Build、DSH 的模型可用性及付费请求取决于用户的 CLI 与提供商配置；本次发布使用模拟会话验证协议和审批分支，没有对全部真实外部服务发起计费请求。500K 配置读取正确不等于已实测服务端接受 500K 输入，Fast 请求参数正确也不等于承诺服务端延迟。

MSI/Windows Installer 的实际安装和卸载需要在不受限用户会话中执行；本地自动化不启动生成的 MSI。Portable ZIP 只做文件清单、字节数和 SHA-256 核验，不写注册表、不创建快捷方式。独立准备程序、摘要校验及原生客户端测试使用隔离目录，不影响正在运行的用户会话。
