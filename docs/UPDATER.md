# 独立更新器

本文描述 0.6.1 / API 4；首次从 0.5.x 迁移不能使用旧更新器，须使用新版安装包或新版独立更新器。

默认升级仍在客户端内完成检查、下载校验与 Windows Installer 安装。检查源不可用、下载失败、安装器启动失败或安装异常退出时，会显示失败原因并打开独立更新器；没有匹配版本、升级成功和用户取消安装不会触发切换。

也可从 Forge 的“升级 → 备用方式：独立更新器 → 打开独立更新器”，或安装目录中的 `CodexForgeUpdater.exe` 启动。MSI 安装还会创建开始菜单入口。单独下载的更新器会让用户选择已有 Forge 安装目录；它不需要客户端正常启动。

## 操作

1. 检查 GitHub 发布仓库，默认 `HOMEFTW/codex-forge`。仅接受该仓库正式 Release 的 schema 3 清单、API 4 和 Windows x64 安装包；不允许降级 Forge 或 Codex。
2. 必要时填写 HTTP(S) 代理，例如 `http://127.0.0.1:7890`；留空使用系统代理，不接受带用户名密码的 URL。此栏用于 Forge 更新包下载；官方客户端准备流程使用系统网络配置。
3. 下载 / 续传。中断或取消后保留 `.partial`；服务器忽略 Range 时重新下载，不把完整响应错误追加到旧文件。完成后核对长度和 SHA-256。
4. 完整退出此安装目录的客户端，再安装。MSI 交给 Windows Installer；便携版验证整个 ZIP 和 Forge payload，先准备版本目录，再切换 `bootstrap.json`。更新器运行自身的缓存副本，避免覆盖正在运行的 EXE；便携安装与客户端准备程序使用同一把目录锁，防止并发改写。
5. 启动 Forge；准备程序按新版本适配器从官方 HTTPS 源取得 Codex MSIX，验证签名、身份和摘要后构建客户端。独立插件、用户设置、密钥和聊天数据不包含在更新包中。

已启用的独立插件必须匹配目标 Forge 范围和受支持 API。0.6.1 / API 4 支持 API 1–4 插件；Codex 版本限制可选，声明时严格检查。更新器不会替作者修改兼容范围；先安装插件兼容版，或在插件管理中停用后升级。

## 增量规则

0.5.0 首次使用时通常没有旧包缓存，因此下载完整包。之后可复用 `.cache/forge-updates/<SHA256>.artifact`。仅在已校验缓存能够连接到目标、整条链下载量小于完整包时使用增量。缺失、损坏、超限或校验失败回退完整包；取消操作保持取消，不自动继续下载。

`codex-forge-release.json` 的可选 `deltas` 数组每项包含 `kind`（`msi` 或 `portable`）、`fromSha256`、`toSha256`、`toBytes`、`bytes`、`sha256`、`url`。URL 必须属于同一 GitHub 仓库。每条增量文件的格式是：

```json
{
  "schemaVersion": 1,
  "format": "forge-blocks-v1",
  "fromSha256": "基线摘要",
  "toSha256": "目标摘要",
  "toBytes": 123,
  "operations": [{"offset": 0, "bytes": 64}, {"data": "base64 数据"}]
}
```

生成命令：`node scripts/build-delta.mjs BASELINE TARGET RELEASE_MANIFEST`。构建器仅在增量更小时写出附件并更新发布清单与摘要列表。发布者须同时上传完整包、增量附件和更新后的清单；不包含完整链的旧增量不必保留在新清单中。官方 MSIX 不参与 Forge 的增量分发。

## 修复和恢复

“修复当前安装”会验证已安装 Forge payload，并重新运行官方客户端准备流程。若 Forge payload 本身损坏，可重新下载并安装相同版本；便携安装会保留损坏目录副本，再换入校验通过的内容。

便携更新前一份配置位于 `bootstrap.json.previous`；客户端准备前一份指针位于 `current.json.previous`。恢复时先退出客户端，将需要恢复的 `.previous` 复制回对应 `.json`，并确认其所指目录仍存在。只恢复 `current.json` 而不恢复 `bootstrap.json` 时，启动器会按新目标再次准备。准备程序保留前一客户端，清理更早的受管目录。

更新器、MSI 和 Forge EXE 尚无 Authenticode 发布者签名；SHA-256 验证下载完整性，不等于发布者身份签名。官方 MSIX 保持官方签名验证。
