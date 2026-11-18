# GPT-6.2 Sol / Astra 支持

2026-11-18，Forge 0.7.2 在“Fast 与模型配置”中补齐 `gpt-6.2-sol` 和 `gpt-6.2-astra`。API 保持 5；请升级到 [v0.7.2 安装包](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.7.2)，既有 v0.7.1 安装包不包含这些修改。

## 使用方式

- 启用“Fast 与模型配置”并完整重启客户端后，可在模型菜单选择 GPT-6.2-Sol / Astra，并选择 Fast 或 Ultrafast。
- 在该插件设置页的模型列表中控制显示或隐藏；至少保留一个可选择模型。设置页同时标出 Fast、Ultrafast 能力。
- 已有原生或服务商的 6.2 模型描述优先保留，包括隐藏状态、推理级别、上下文和速度限制。只有缺少对应模型时，Forge 才从已有兼容的 Sol / Astra 描述补齐条目；不改写个人配置或原始模型缓存。
- 停用插件后不再注入缺失的 6.2 条目；原生目录本来提供的模型保留。已有聊天、旧模型和 GPT-6.1-Sol 独立 500K 设置不迁移。

## 能力与限制

依据 [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol)、[GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) 和[迁移指南](https://developers.openai.com/api/docs/guides/latest-model)，新增条目保留兼容原生描述的工具能力和支持的推理级别，排除 `none` / `minimal`，优先默认 `medium`。

两者官方总窗口为 1,050,000 tokens，其中最大输入 922,000、最大输出 128,000。Forge 补齐条目时保留 Codex 原有默认输入窗口，设置最大输入上限为 922,000；不会把 GPT-6.1-Sol 的 500K 覆盖应用到它们。当前测试目录的默认窗口为 272,000，原生 95% 可用窗口为 258,400；这些数字不代表已经实测长上下文请求。

Fast 请求使用 `service_tier: priority`，Ultrafast 使用 `service_tier: ultrafast`。真实可用性、账号权限、速度和计费仍由模型服务决定。

当前指纹库没有这两个模型的参考样本，因此显示未收录；不会套用旧 Astra / Sol 指纹，也不会因此误报红字。

## 客户端适配状态

官方更新清单已公布构建 `26.1111.9265.0`、内部发行版 `26.1111.71025`，但固定 MSIX 下载地址返回 404。对通用下载包执行带 ETag 的范围读取，核实其 `AppxManifest.xml` 仍为 `26.1111.2228.0`；Microsoft Store 下载接口也未能返回新版包。按用户确认，本次先完成模型支持，客户端基线保持已验证的 `26.1111.2228.0`，不把 Feed 构建号冒充已适配版本。

下载可用性证据位于 `output/nov18-official-availability.json`。模型功能、客户端构建和界面验收范围见[验证记录](VALIDATION.md)。
