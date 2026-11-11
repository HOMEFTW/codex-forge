# Codex Forge 更新协议

## Forge 本体及官方客户端

Forge 查询官方 `windows-store-update.json` 与配置仓库的 GitHub Release。客户端身份版本、官方 Feed 构建版本、Forge API 和已启用第三方插件都匹配时才允许更新；未知官方版本不直接套用旧适配器。0.6.0 的目标适配器为 `26.1103.7773.0`，七个旧版适配器仍保留用于回归。下方为清单格式示例。

2026-11-04 后续核验：OpenAI 固定版本 URL 已提供 `26.1029.7803.0` x64 MSIX，与 Feed 构建一致；发布标识为 `26.1029.61003`。已检查包大小、SHA-256、OpenAI.Codex 身份和发布者签名，适配清单绑定此实际包。此前 0.4.2 验证时该地址尚不可用，历史记录保留。GitHub 更新检查依据 Release 中的正式清单提供版本；第三方插件也须声明新客户端兼容性。

每个 Forge Release 必须提供 `codex-forge-release.json`：

```json
{
  "schemaVersion": 3,
  "platform": "win32-x64",
  "apiVersion": 4,
  "forgeVersion": "0.6.0",
  "codexVersion": "26.1103.7773.0",
  "codexBuildVersion": "26.1103.7773.0",
  "repository": "HOMEFTW/codex-forge",
  "distribution": "msi-portable",
  "containsOfficialClient": false,
  "url": "https://github.com/HOMEFTW/codex-forge/releases/download/v0.6.0/Codex-Forge-0.6.0-Windows.msi",
  "sha256": "由构建器计算的64位小写SHA256",
  "bytes": 123456,
  "portableUrl": "https://github.com/HOMEFTW/codex-forge/releases/download/v0.6.0/Codex-Forge-0.6.0-Windows-Portable.zip",
  "portableSha256": "由构建器计算的64位小写SHA256",
  "portableBytes": 123456
}
```

清单示例的下载地址、摘要与大小是占位值，不表示版本已发布，不可用于实际安装。`node scripts/build-installer.mjs` 生成真实清单与 `SHA256SUMS.txt`。

0.6.0 使用 Forge API 4。当前运行时更新检查可读取 API 1/2/3/4 历史清单，并按目标 API 检查第三方插件；0.6.0 准备程序与独立更新器只接受 API 4 目标。已发布的 0.5.x / 0.4.x 更新器不接受 API 4，首次迁移须手动运行新版 MSI、解压新版便携 ZIP，或下载新版独立更新器。启用的第三方插件 API 不匹配时不提供自动更新方案，不会改写插件。

客户端核验下载的 MSI、在启动安装前重新计算落盘文件的 SHA-256，然后交给 Windows Installer 完成 per-user 升级；0.5.0 的便携 ZIP 可由独立更新器验证后安装。安装包仅安装 Forge；准备程序按 `adapters/<codexVersion>.json` 下载官方 MSIX；`codexVersion` 是 MSIX 身份版本，`codexBuildVersion` 是官方 Feed 构建版本，两者分别核验，检查大小、SHA-256、签名及 MSIX 产品身份，解包和应用固定版本适配器，验证最终清单后才切换 `current.json`。MSI 只在卸载时删除 `current.json`；MajorUpgrade 之后启动器会同时比对目标 payload 与当前客户端的 `forgeVersion`、`sourceMSIXVersion` 和 `forgePayloadSHA256`，任一不一致时自动重跑准备程序（复用已缓存的 MSIX），不会静默启动旧版 Forge。切换成功后保留前一客户端，删除更早的 Forge 管理客户端目录及旧 MSIX 缓存，当前正在运行的旧客户端会延迟到下一次启动清理；没有完整 Forge 清单的目录不会删除。现有进程继续运行，用户完成当前工作后退出并重新启动。MSI 允许安装同版本修订；0.3.3 用户可直接运行 0.4.1 MSI 升级。

不接受旧的全量 ZIP 更新协议，也不接受 r 系列原地升级。官方客户端二进制不得加入 Forge 安装包或 Release。

默认继续使用客户端内检查、下载和安装；常规流程失败时切换独立更新器，保留手动备用入口。0.5.0 增加独立 `CodexForgeUpdater.exe` 与可选 `updater`、`deltas` 清单字段，仍兼容 schemaVersion 3。发布者可用 `node scripts/build-delta.mjs BASELINE TARGET RELEASE_MANIFEST` 生成比完整包更小的增量；没有合适基线时只发布完整包。协议、使用和恢复见 [独立更新器](UPDATER.md)。

## 扩展插件

插件使用 `plugin.json.update` 声明来源，二选一：

```json
{"provider":"github","repository":"owner/plugin-repository"}
```

```json
{"provider":"server","manifestUrl":"https://plugins.example.com/my-plugin/latest.json"}
```

GitHub 最新正式 Release 附件必须叫 `codex-forge-plugin-release.json`；下载 URL 必须位于同一仓库的 `/releases/download/`。私有服务器的包 URL 必须与清单同源且使用 HTTPS。这里的“私有服务器”指自建服务器；当前 API 不支持自定义认证头或将凭据写入 URL。GitHub 私有仓库不能通过匿名更新读取，需手动安装。

打包命令：

```powershell
node cli/forge.mjs pack ./my-plugin ./my-plugin.forge-plugin.json
```

生成 JSON 容器（路径、base64 文件内容）和 `.release.json` 更新清单。将清单的 `url` 替换为真实 HTTPS 包地址，保留构建生成的 `bytes`、`sha256`、身份、版本、兼容范围、API 与依赖声明。GitHub 发布时将清单重命名为 `codex-forge-plugin-release.json`。

安装更新前依次检查：

1. 下载前：插件身份、版本递增、Codex / Forge / API、正反向依赖及循环依赖。
2. 下载后：长度、SHA-256、路径安全、解包大小、包内清单与更新清单一致；不得静默更换更新源。
3. 重启时：重新核对当前宿主兼容性、暂存指纹和文件摘要，再替换插件；失败保留旧插件。

更新先暂存，界面提示重启。设置和插件存储保留；权限或网络访问范围变动后默认停用，需用户审阅并重新启用。`forge.*` 内置插件由 Forge 本体发布管理。

### 本地插件包覆盖升级

从 Forge 0.4.3 起，“导入插件包…”以及安装插件目录/CLI `install` 会根据插件 ID 区分首次安装与覆盖升级。已安装的独立插件无需先卸载：直接选择 ZIP、7z、`.forge-plugin.json` 或新版目录。允许更高版本和同版本修订，拒绝降级；在线更新仍要求版本递增。本地手动导入不要求插件提供在线更新源。

覆盖前检查 Codex / Forge / API、正反向依赖及循环依赖，再记录暂存指纹和文件摘要。重启前旧插件继续运行；重启时重新核验并完整替换文件，删除新版已移除的旧文件。校验或替换失败保留旧插件，并保留可重试的暂存更新；重复导入失败不会破坏先前已暂存的包。

设置、独立存储及用户启停选择保持。首次安装仍默认停用；已改动但未经重新审阅的插件不会借覆盖升级自动启用。升级包改变权限或 `networkOrigins` 时，重启后需要重新审阅并启用。该流程仅升级独立插件，不修改 Forge、API 或官方客户端版本。

Forge 0.4.4 起，待更新且未启用的插件显示“重启后启用”，不能在更新生效前启用旧版。当前版本与待生效版本分别标注；管理 API 返回 `PLUGIN_UPDATE_PENDING` 并提示重启，避免将旧版不兼容误认为新版不兼容。
