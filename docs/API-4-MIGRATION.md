# Forge API 4 与旧版兼容

适用：Codex Forge 0.6.2 / API 4。宿主从 0.6.1 开始兼容 API 1、2、3；已发布的 0.6.0 仍要求 API 严格相等。

## 独立插件

普通插件只需声明 API 和 Forge 范围，例如：

```json
{"apiVersion":3,"compatibility":{"forge":[">=0.6.1 <0.7.0"]}}
```

这是现有 plugin.json 的相关字段示例，其他身份、版本、权限和入口字段仍须保留。API 1–3 插件不必仅为宿主升级改写 API。`compatibility.codex` 可以省略；如果插件依赖官方内部实现，可继续声明非空版本数组，宿主严格执行该限制。`null`、空数组和无效范围不会被当作未限制。

插件自己的 Forge 范围必须包含目标版本。此前 `>=0.4.0 <0.6.0` 等范围不会自动放宽；作者修改清单、递增插件版本、验证后重新打包。ZIP / 7z / JSON 覆盖升级仍先暂存、重启生效，保留设置和存储；新增权限需要重新审阅。

## 兼容契约

- API 1 的核心存储、设置、事件、面板、命令、输入框与会话输出协议保留；旧 SDK 的字符串错误通过兼容层返回。
- API 2 的能力声明、诊断与插槽继续校验；未声明 capabilities 时按权限推断，显式声明时不自动补齐。
- API 3 的可选能力协商与 Nexus v1 继续保留，未知可选能力保持不可用。
- SDK 的 `apiVersion`、`context.get()`、ready/context.changed、命令上下文和能力查询返回插件声明的 API；`hostApiVersion` 为 4。新 TypeScript SDK 默认 `ForgeAPI<4>`，也可用 `ForgeAPI<1|2|3>` 中对应的具体版本类型。
- 未知 API 仍拒绝加载。向下兼容不向旧宿主反向提供新接口，也不绕过来源窗口、插件启用状态、权限、能力版本或数据 revision 检查。
- 旧 API 1 会话操作若缺少 `conversation.read`，须补充该权限并重新审阅；不恢复早期较宽松的会话访问。

API 4 新增的 `conversation.predict` 和 `prompt-prediction@1` 仍仅限内置自动提示词预测，不向独立插件开放任意模型调用。清单 schema 1、更新协议 schema 3、Nexus 能力版本 1 保持。

## 安装宿主

0.6.1 常规更新器和独立更新器均识别目标宿主的 API 1–4 兼容能力；不会把 0.6.0 误判为支持旧 API。已发布的 0.5.x 更新器不接受 API 4 发行清单，首次迁移仍需手动安装新版 MSI、解压便携 ZIP，或使用新版独立更新器。

详见 [API 参考](PLUGIN-API.md)、[更新协议](UPDATES.md) 和 [验证记录](VALIDATION.md)。
