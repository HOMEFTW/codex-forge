# Codeg 技能包

Codex Forge 的可选独立插件。提供四组 37 项技能、237 个参考资源，可分别为 Codex、Claude Code、Grok Build 和 DSH 启用。

## 安装

此插件需要 Codex Forge 0.7.5 或更新版，Forge API 5。

在「插件管理」导入 `Codeg-Skills-0.1.0.zip` 或 `.forge-plugin.json`，审阅权限并启用。点击左侧的层叠图标，选择智能体，再勾选需要的技能。首次安装默认停用，技能也默认关闭。

Forge 客户端安装包不含此插件、面板或技能资源。插件停用或卸载后，左栏入口和模型技能工具关闭，协作提示也不再注入这些技能。重新安装并启用后可继续使用原有按智能体保存的选择；旧内置版的偏好保留在 `fast-canvas/skills/enabled.json`。

## 使用与更新

支持名称/用途搜索、分组筛选、启用状态、正文预览及完整参考文件。管理面板可以预览未启用的技能；模型工具只读取已启用的技能。资源路径与 SHA-256 校验继续生效。

同 ID 的新版 ZIP 可使用 Forge 已有的覆盖安装机制升级。从 [Forge 0.7.5 发布页](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.7.5) 下载可选插件附件；目前使用手动导入覆盖升级。

技能来自 Codeg `bed8931485d2de6ab65c83e182fbd4a79c72e12b` 和 OfficeCLI `06ab520135a5289d0556d3e47fc2d42523f86547`，原始许可、来源和校验清单均包含在 `bundled-skills`。OfficeCLI、Python 或第三方服务按技能需要自行配置。启用技能不会额外授予执行脚本、安装软件或发送消息的权限。

## 本地构建

在 Forge 仓库执行 `npm run build:codeg-skills`，产物在 `dist/codeg-skills/`；普通 `npm run build` 仅构建宿主，不会附带技能包。
