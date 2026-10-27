# 组合包（bundle）与 profile

组合包是 Forge 对 DSH `profile` / `bundle` / `patch` 层叠的最小实现：用一个有序的 profile 描述"这组插件应该是什么状态"，再加上若干层 patch 覆盖，最后按 id 合并成一份期望状态。它不安装文件、不解析依赖、不做 HMR —— 插件仍然是目录，组合只负责启用状态与设置的覆盖。

## profile.json

放在 Forge 数据目录（默认 `%CODEX_HOME%\forge`，可用 `--home` 覆盖）：

```json
{
  "schemaVersion": 1,
  "bundles": ["forge.builtin"],
  "patches": ["patches/my-team.patch.json"]
}
```

- `bundles`：按顺序叠加的组合包 ID，先查用户目录 `bundles/<id>`，再查随 Forge 分发的 `bundles/<id>`。
- `patches`：相对数据目录的 patch 文件，按顺序叠加，路径不能越出数据目录。

## bundle.json

```json
{
  "schemaVersion": 1,
  "id": "forge.builtin",
  "name": "Codex Forge 内置插件组合",
  "version": "0.3.0",
  "patch": "bundle.patch.json"
}
```

`patch` 必须是组合包目录内的相对路径。Forge 0.3.0 的 `forge.builtin` 声明九个内置插件，包括信息统计、记忆管理和开发检查器。组合包格式的 `schemaVersion` 仍为 1，与 Forge API 2 分开版本管理。

## patch 文件

```json
{
  "schemaVersion": 1,
  "entries": [
    { "id": "forge.canvas", "enabled": true },
    { "id": "forge.todos", "enabled": false, "settings": { "greeting": "hi" } }
  ]
}
```

- 条目只允许 `id`、`enabled`、`settings` 三个字段，同一层内不能重复 id。
- 层序固定：profile 列出的组合包（按顺序）→ profile 的 patches（按顺序）→ `--patch` 单次覆盖。
- 合并规则是**字段级覆盖**：后层没写 `enabled` 就保留前层的值；后层写了 `settings` 就整段替换这个对象（不做深合并）。
- 应用到宿主时，组合结果里的 `settings` 会浅合并进插件当前设置，未提及的键保持不变。

## 命令

```powershell
node cli/forge.mjs bundle list                 # 列出用户与内置组合包
node cli/forge.mjs bundle plan                 # 显示层序与合并后的期望状态
node cli/forge.mjs bundle apply                # 应用（启用/停用 + 写入设置）
node cli/forge.mjs bundle plan --patch x.json  # 追加一次 CLI 覆盖
```

`apply` 是可重复执行的：缺失插件只记录在 `missing` 里，不兼容或未知设置记录在 `skipped` / `settingsErrors` 里，不会中断其余条目。

## 客户端内入口

插件管理页有“组合包”卡片：**预览组合**显示 profile 的层序与合并结果，**应用组合**把启用状态和设置写入。两者和 CLI 的 `bundle plan` / `bundle apply` 走同一套实现，因此安装版没有 CLI 也能使用。
