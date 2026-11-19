# GPT-6.2 Sol / Astra 支持

Forge 0.7.2 开始支持选择 `gpt-6.2-sol` 和 `gpt-6.2-astra`。[0.7.3 安装包](https://github.com/HOMEFTW/codex-forge/releases/tag/v0.7.3) 增加 Sol 的可选 500K 上下文，以及两个模型各自的指纹参考类别。Forge API 保持 5。

## 使用方式

- 启用“Fast 与模型配置”并完整重启客户端后，可在模型菜单选择 GPT-6.2-Sol / Astra，并选择 Fast 或 Ultrafast。
- 在该插件设置页的模型列表中控制显示或隐藏；至少保留一个可选择模型。设置页同时标出 Fast、Ultrafast 能力。
- 已有原生或服务商的 6.2 模型描述优先保留，包括隐藏状态、推理级别、上下文和速度限制。只有缺少对应模型时，Forge 才从已有兼容的 Sol / Astra 描述补齐条目；不改写个人配置或原始模型缓存。
- 停用插件后不再注入缺失的 6.2 条目；原生目录本来提供的模型保留。已有聊天、旧模型和 GPT-6.1-Sol 独立 500K 设置不迁移。

## 能力与限制

依据 [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol)、[GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) 和[迁移指南](https://developers.openai.com/api/docs/guides/latest-model)，新增条目保留兼容原生描述的工具能力和支持的推理级别，排除 `none` / `minimal`，优先默认 `medium`。

两者官方总窗口为 1,050,000 tokens，其中最大输入 922,000、最大输出 128,000。Forge 补齐条目时保留 Codex 原有默认输入窗口，设置最大输入上限为 922,000；不会把 GPT-6.1-Sol 的 500K 覆盖应用到它们。当前测试目录的默认窗口为 272,000，原生 95% 可用窗口为 258,400；这些数字不代表已经实测长上下文请求。

Fast 请求使用 `service_tier: priority`，Ultrafast 使用 `service_tier: ultrafast`。真实可用性、账号权限、速度和计费仍由模型服务决定。

从 0.7.3 起，“Fast 与模型配置”提供“启用 GPT-6.2-Sol 的 500K 上下文”选项，默认关闭。勾选、保存并完整重启后，Forge 对此模型设置 500,000 tokens 的输入窗口；如果模型目录声明了更低的最大窗口，则以该上限为准。客户端还会扣除预留比例（95% 时可用 475,000）。取消并重启后恢复原目录窗口，不影响 6.2-Astra 或 6.1-Sol。

0.7.3 指纹库为两个模型分别收录了 36 条 `low` 档参考回答，其他思考强度下仅供参考。见[指纹说明](INFORMATION-STATS.md)。

## 客户端适配状态

截至 2026-11-19，微软商店美区与港区的 Windows x64 客户端均为 `26.1111.2228.0`。官方更新清单虽已列出 `26.1111.9664.0`，其固定包下载地址仍返回 404。Forge 0.7.3 保持已验证的商店客户端基线；详见[验证记录](VALIDATION.md)。
