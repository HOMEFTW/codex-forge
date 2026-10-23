# Codex Forge 更新协议

## Forge 本体及官方客户端

Forge 查询官方 `windows-store-update.json` 与配置仓库的 GitHub Release。客户端版本、Forge API 和已启用第三方插件都匹配时才允许更新；未知官方版本不直接套用旧适配器。

每个 Forge Release 必须提供 `codex-forge-release.json`：

```json
{
  "schemaVersion": 2,
  "platform": "win32-x64",
  "apiVersion": 1,
  "forgeVersion": "0.1.0",
  "codexVersion": "26.1016.8622.0",
  "repository": "HOMEFTW/codex-forge",
  "distribution": "forge-bootstrap",
  "containsOfficialClient": false,
  "url": "https://github.com/HOMEFTW/codex-forge/releases/download/v0.1.0/Codex-Forge-0.1.0-Setup-x64.exe",
  "sha256": "由构建器计算的64位小写SHA256",
  "bytes": 123456
}
```

清单示例的摘要与大小是占位值，不可用于实际发布。`node scripts/build-installer.mjs` 生成真实清单与 `SHA256SUMS.txt`。

客户端核验下载的 EXE 后打开安装向导。安装器仅安装 Forge；准备程序按 `adapters/<codexVersion>.json` 下载官方 MSIX，检查大小、SHA-256、签名及 MSIX 产品身份，解包和应用固定版本适配器，验证最终清单后才切换 `current.json`。现有进程继续运行，用户完成当前工作后退出并重新启动。

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
