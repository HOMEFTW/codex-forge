# 官方客户端 26.1120.5083.0 适配

Forge 0.7.6 适配 Windows x64 客户端 `26.1120.5083.0`，内部发行版为 `26.1120.41243`，Forge API 保持 5。

## 官方包与适配

- 2026-11-25，微软商店香港、美国区均列出此版本。[官方 MSIX](https://persistent.oaistatic.com/codex-app-prod/releases/26.1120.5083.0/ChatGPT-x64.msix)为 770,059,628 字节，SHA-256 为 `98d403d0f8d9d39af4af5e0ee084919cee763309ed6cd255a5a8a390c5c0327c`，已验证 OpenAI 签名、包身份与 x64 架构。
- [官方更新清单](https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json)另列出 `26.1120.6357.0`，检查时该版本固定包地址返回 404，本次适配使用已取得并验证的商店包。
- 独立 `nov25` 适配器绑定原始 ASAR、EXE、31 个前端工厂、提示词预测模块及电脑操作入口摘要，保留旧版适配器。
- 重新接入工作区、设置导航与搜索、简体中文、账号状态、12 份速度选择工厂及 7 份速度请求工厂；主进程与独立 app-server-host 均保留原生配置并注入 Forge 参数。
- 合入新聊天入口修复：通过布局挂载与清理跟踪可见页面，后台隐藏的旧对话重新渲染时不会接收全局打开请求；面板关闭与完整视图仍定位原面板。
- 保留模型显示、Fast / Ultrafast、GPT-6.2、Sol 可选 500K、标题生成、MCP 协作及 API 1–4 公共操作兼容。

## 验证

发布构建与实际验收范围见[验证记录](VALIDATION.md)。本次发布不替换或重启本机正式客户端。
