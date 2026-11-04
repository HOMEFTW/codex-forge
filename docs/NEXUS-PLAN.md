# 星枢 Nexus 知识库插件实施计划

需求确认：完全独立于 Obsidian 运行；接受部分重实现第三方插件。直接打开已有 vault，不运行其第三方 JavaScript。

后续确认：产品名「星枢 Nexus」，插件/API/权限统一使用 `nexus`。版本为 Forge 0.4.0 / API 3；共享宿主升级与发行由 Forge 客户端对话负责。

1. 增加内置 `forge.nexus` 面板及宿主服务，用户在面板连接本地 vault；模型只能访问已连接的库。
2. 文件索引与 Markdown 渲染：文件树、搜索、标签、属性、出链、反链、大纲、图谱、统计、wikilink、嵌入、callout、任务、公式与图表。
3. 写入使用内容摘要防冲突，保留历史/回收站；模板、日记、书签、Bases 数据库和属性编辑共用模型/UI 操作接口。
4. 兼容 Advanced Tables、Charts、Homepage、Outliner、Templater 安全变量子集、Dataview 查询子集、QuickAdd 模板/捕获；不支持的脚本、宏、查询明确报错。
5. 接入 MCP 工具，测试路径边界、并发修改、查询、配置兼容与 UI 交互，构建验证并提供使用说明和准确的兼容清单。

验证用独立 fixture vault；现有知识库只读检查。此次不安装到当前客户端、不提交、不推送。
