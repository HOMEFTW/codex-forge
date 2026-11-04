# 星枢 Nexus 验证记录

日期：2026-11-04。目标：Forge 0.4.0 / API 3。此记录是 Nexus 专项实现与本机验收，全仓验证见 [Forge 验证记录](VALIDATION.md)。

## 自动化检查

执行 `node --test tests/nexus.test.cjs tests/nexus-mcp.test.cjs`，结果 **21 项通过、0 失败、0 跳过**。

- `tests/nexus.test.cjs`：20 项，覆盖索引/链接/搜索、路径与目录身份边界、目录联接、跨进程锁、写入修订/历史/恢复、外部写入竞态、属性/任务/表格/列表、模板/日记/QuickAdd、DQL/Base、设置修订、分页与结构化错误码。
- 只读工具回归会模拟服务把 `inspect` 改为写操作；即使工具枚举仍含此方法，也必须由 `methodKind()` 拒绝，并断言未调用 dispatch。
- `tests/nexus-mcp.test.cjs`：1 项，启动真实 `runtime/mcp.cjs` 子进程并通过 stdio JSON-RPC 调用；验证服务版本 0.4.0、`nexus_*` 工具命名、连接库列表、读取与落盘写入、旧修订冲突、禁止模型连接目录、插件停用后隐藏并拒绝工具。使用临时样例库，完成后清理。

该轮测试后仅修改渲染 UI 的行内查询显示及兼容性描述，未再改服务业务逻辑；对应 UI 已重新构建并复验。

## 浏览器与真实服务联调

使用 `scripts/nexus-preview.mjs` 构建独立预览包，通过 Playwright CLI 操作 Chromium。界面位于 `sandbox="allow-scripts"` iframe，桥接请求落到真实 `NexusService`。每次预览仅创建 `output/playwright/` 下的新样例库。

实际操作通过：

| 范围 | 观察结果 |
| --- | --- |
| 首页渲染 | Markdown、callout、Dataview 表格、Chart.js canvas、2 个 KaTeX 公式、含 3 个中文标签的 Mermaid SVG |
| 搜索/标签 | `tag:设备 AND NOT file:辅机` 返回主机；标签入口返回设备笔记 |
| 书签/图谱 | 收藏实际保存；图谱节点显示、缩放、拖动与打开笔记可用 |
| 常用写入 | 任务勾选和笔记保存后读取磁盘确认内容；属性修改、表格加行、列表整分支下移成功 |
| 工作流 | 核心模板创建笔记、今日日记、QuickAdd Template 创建发电机笔记、Capture 连续两次追加成功 |
| 数据库/嵌入 | Base 表格与卡片视图；标题嵌入、Base 嵌入、行内 `this.file.name` 得到实际结果 |
| 冲突 | 编辑期间从外部更改样例文件，保存拒绝覆盖并保留草稿；合并弹窗显示外部内容；合并后磁盘同时含两方修改 |
| HTML 样例 | script/iframe/onerror/javascript 链接被清理，未执行 `window.pwned`，未向远程图片地址发送请求 |
| 窄屏/深色 | 420×900 下上下排列，无整个面板横向溢出；深色背景生效；1440×1000 桌面布局正常 |
| 最终页面控制台 | Playwright `console error` 返回 0 errors、0 warnings |

验收中修复：脚本沙箱禁止原生表单提交，改为按钮/Enter 显式处理；Mermaid 新版顶层 `htmlLabels:false` 保留文字；行内查询移除原始表达式后显示结果。重新预览确认。

截图（本地生成物，不纳入插件发行包）：

- `output/playwright/nexus-desktop.png`
- `output/playwright/nexus-narrow-dark.png`
- `output/playwright/nexus-rendering.png`

编辑与冲突验证样例位于 `output/playwright/obsidian-dtxSzJ/演示知识库/`；最终渲染样例位于 `output/playwright/obsidian-CbDfL0/演示知识库/`。路径中的旧测试前缀仅为临时目录名，与产品/API 命名无关。

## 现有知识库只读兼容检查

只读扫描本机已有知识库，索引 **126 篇笔记、141 个文件**。提取并执行其中 **8 段 Dataview 查询，0 失败**。结果为本地验证记录 `output/obsidian-readonly-check.json`。读取了实际 Homepage、Templater、QuickAdd、Dataview 配置用于兼容实现，未对真实知识库执行写入验收。

这只证明所检查文件与查询，不代表所有社区插件语法均兼容。完整支持/不支持清单见 [NEXUS.md](NEXUS.md)，模型接口见 [NEXUS-API.md](NEXUS-API.md)。

## 未验证范围

- 本轮没有安装或重启当前客户端；连接目录原生选择器、真实宿主外链打开和安装后桌面点击流程未实机验收。
- PDF 原生内嵌效果、音视频设备播放、网络盘/非 NTFS 文件系统未做实机验证。
- 不执行 DataviewJS、Templater 执行块/系统命令、QuickAdd Macro/脚本；第三方功能为明确列出的独立兼容子集。
- 浏览器和 MCP 证据不代替原生安装验收。
