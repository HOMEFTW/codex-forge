# 星枢 Nexus

星枢在 Forge 内独立浏览、渲染和编辑本地知识库，兼容 Obsidian 文件格式与常用插件语法。目标为 **Forge 0.4.0 / API 3**；无需启动 Obsidian，也无需在 Obsidian 安装桥接插件。

## 使用

1. 在 Forge 左侧打开「星枢 Nexus」，选择「连接目录」，选择含 `.obsidian` 的知识库根目录。普通 Markdown 文件夹也可以连接。
2. 文件、搜索、标签、书签、图谱、数据库、模板、QuickAdd 八个页签共用同一份本地文件。
3. 选择笔记后可阅读或编辑；按 Ctrl/Cmd+S 保存。未保存草稿在面板内切换文件时保留。关闭前提示，关闭或重载页面会丢弃未保存草稿。
4. 「今日日记」读取已有日记配置；「主页」读取 Homepage 配置。可以在「设置」中覆盖星枢行为，原 Obsidian 配置不被覆盖。
5. 模型可以通过 `nexus_*` 工具检索、读写笔记、编辑属性与任务、操作表格/列表、查询数据库、创建日记、应用模板及运行兼容的 QuickAdd。让模型先读取、再根据修订编辑即可。

现有文件写入需要内容修订匹配。外部编辑器改变文件后，星枢保留草稿并提供「查看并合并」。删除、覆盖和重命名保留历史与库内 `.trash/forge-*` 副本；从「历史」恢复。没有自动清理备份，容量由用户按需管理。写入依赖本地文件系统独占创建/硬链接能力，Windows NTFS 已作为测试目标；不把网络盘或其他文件系统视作已验证环境。

重命名不会自动改写整库引用，会显示需更新的引用列表；模型可据此逐篇核对修改。

## 功能覆盖

| 功能 | 独立实现 |
| --- | --- |
| 文件列表、搜索 | 文件夹树，文件/正文/路径/标签搜索，短语、AND/OR/NOT 与括号 |
| 标签、出链、反链、大纲 | YAML/行内标签，wikilink、别名、相对链接解析，标题跳转，局部/全库图谱 |
| Markdown | GFM 表格、任务、callout、折叠 callout、wikilink、笔记/标题/块嵌入、脚注、高亮、KaTeX 公式、Mermaid 图 |
| 统计 | 中文字符与其他语言词组计数、字符数、行数、任务完成数；属于本实现的计数口径 |
| 模板、日记、书签 | 复用核心配置，日期/时间/标题变量，按日期建日记，原格式书签与分组 |
| 数据库 Bases | `.base` YAML，table/cards/list 视图、and/or/not 筛选、属性、公式、排序、分组和 Sum/Average/Min/Max 等常用汇总 |
| Advanced Tables | 表格渲染、格式对齐、增加/删除行列 |
| Charts | `chart` YAML 的 bar/line/pie/doughnut/radar/polarArea/scatter，labels 与 series 数值 |
| Homepage | v4 File 主页配置，以及旧版字符串主页；笔记/Base 可作为主页 |
| Outliner | 列表分支缩进、反缩进、上下移动 |
| Templater | `tp.file.title`、`tp.file.path()`、`tp.file.folder()`、`tp.date.now(format,offset?)`、`tp.frontmatter` 属性 |
| Dataview | 多行 TABLE/LIST/TASK，中文列别名，FROM/WHERE/SORT/LIMIT、TASK GROUP BY、安全常用表达式、行内查询与 this.file |
| QuickAdd | Multi 嵌套菜单、Template/Capture、DATE/NAME/VALUE 变量、配置目标目录与文件名、已有捕获文件追加 |

第三方插件是兼容实现，不加载其 JavaScript。DataviewJS、Templater 执行块/系统命令、QuickAdd Macro/AI/脚本、Advanced Tables 公式、复杂 Capture 插入定位、Base 地图/完整公式库暂不支持，会明确报错。图表不支持外部数据文件和自定义 JS 配置。

附件支持位图、PDF、音视频；PDF 内嵌效果依赖客户端 PDF 查看器，未将其视为已完成原生桌面验收。远程图片不自动加载；内联 HTML 经清理，不允许脚本和嵌套网页。

## 验证与开发

```powershell
node --test tests/nexus.test.cjs
node scripts/nexus-preview.mjs
```

预览脚本只创建 `output/playwright/` 下的独立样例库，通过脚本沙箱 iframe 模拟 Forge 页面与真实本地服务，输出本机随机端口。不会写入实际知识库。模型/SDK 方法、参数、修订及限额见 [NEXUS-API.md](NEXUS-API.md)。验证证据见 [NEXUS-VALIDATION.md](NEXUS-VALIDATION.md)。
