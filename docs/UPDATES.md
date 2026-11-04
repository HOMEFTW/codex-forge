# Codex Forge 更新协议

## Forge 本体及官方客户端

Forge 查询官方 `windows-store-update.json` 与配置仓库的 GitHub Release。客户端身份版本、官方 Feed 构建版本、Forge API 和已启用第三方插件都匹配时才允许更新；未知官方版本不直接套用旧适配器。0.4.0 的当前目标适配器为 `26.1027.6604.0`，四个旧版适配器仍保留用于回归。下方为当前源码的格式示例。

2026-11-04 核验：OpenAI 固定 URL 与 Microsoft Store 公开的 x64 MSIX 均为 `26.1027.6604.0`；Feed 已报 `26.1029.7803.0`，但对应固定下载尚不可用。适配清单绑定实际已验证包，不能将尚未获得的 Feed 构建标为兼容；自动更新可能继续提示该构建尚待适配。

每个 Forge Release 必须提供 `codex-forge-release.json`：

```json
{
  "schemaVersion": 3,
  "platform": "win32-x64",
  "apiVersion": 3,
  "forgeVersion": "0.4.0",
  "codexVersion": "26.1027.6604.0",
  "codexBuildVersion": "26.1027.6604.0",
  "repository": "HOMEFTW/codex-forge",
  "distribution": "msi-portable",
  "containsOfficialClient": false,
  "url": "https://github.com/HOMEFTW/codex-forge/releases/download/v0.4.0/Codex-Forge-0.4.0-Windows.msi",
  "sha256": "由构建器计算的64位小写SHA256",
  "bytes": 123456,
  "portableUrl": "https://github.com/HOMEFTW/codex-forge/releases/download/v0.4.0/Codex-Forge-0.4.0-Windows-Portable.zip",
  "portableSha256": "由构建器计算的64位小写SHA256",
  "portableBytes": 123456
}
```

清单示例的摘要与大小是占位值，不可用于实际发布。`node scripts/build-installer.mjs` 生成真实清单与 `SHA256SUMS.txt`。

0.4.0 使用 Forge API 3，新版更新器读取 API 1/2/3 历史清单，并按目标 API 检查第三方插件。已发布 0.3.x（API 2）和 0.2.x（API 1）更新器不接受 API 3，因此首次迁移须手动下载 0.4.0 MSI；不承诺旧更新器能自动发现本次升级。启用的第三方插件 API 不匹配时不提供自动更新方案，不会改写插件。

客户端核验下载的 MSI、在启动安装前重新计算落盘文件的 SHA-256，然后交给 Windows Installer 完成 per-user 升级；便携 ZIP 由用户手动替换。安装包仅安装 Forge；准备程序按 `adapters/<codexVersion>.json` 下载官方 MSIX；`codexVersion` 是 MSIX 身份版本，`codexBuildVersion` 是官方 Feed 构建版本，两者分别核验，检查大小、SHA-256、签名及 MSIX 产品身份，解包和应用固定版本适配器，验证最终清单后才切换 `current.json`。MSI 只在卸载时删除 `current.json`；MajorUpgrade 之后启动器会同时比对目标 payload 与当前客户端的 `forgeVersion`、`sourceMSIXVersion` 和 `forgePayloadSHA256`，任一不一致时自动重跑准备程序（复用已缓存的 MSIX），不会静默启动旧版 Forge。切换成功后会删除旧的 Forge 管理客户端目录及旧 MSIX 缓存，当前正在运行的旧客户端会延迟到下一次启动清理；没有完整 Forge 清单的目录不会删除。现有进程继续运行，用户完成当前工作后退出并重新启动。MSI 允许安装同版本修订；0.3.3 用户可直接运行 0.4.0 MSI 升级。

不接受旧的全量 ZIP 更新协议，也不接受 r 系列原地升级。官方客户端二进制不得加入 Forge 安装包或 Release。

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

更新先暂存，界面提示重启。设置保留；权限变动后默认停用，需用户重新启用。`forge.*` 内置插件由 Forge 本体发布管理。
