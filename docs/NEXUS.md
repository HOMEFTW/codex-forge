# Nexus 宿主服务与独立插件

Codex Forge **0.4.3 / API 3** 提供本地知识库服务 `nexus`。星枢 Nexus 的界面、渲染依赖和插件清单属于独立工程 `forge-nexus`，插件 ID 为 `homeftw.nexus`，不属于 Forge 内置插件，也不随 Forge MSI、便携 ZIP 或 Release 附件发行。

## 安装与使用

1. 单独取得星枢的 ZIP、7z 或 `.forge-plugin.json` 包，打开 Forge「插件管理」→「导入插件包…」。也可选择解包后的插件目录。
2. 导入后默认停用。审阅权限和兼容性，再启用插件并打开其面板。星枢 0.1.0 要求 Forge `>=0.4.1 <0.5.0`；0.2.0 的图标和隔离 DataviewJS 要求 `>=0.4.2 <0.5.0`，API 均为 3。
3. 在面板中点击「连接目录」，由宿主原生选择器选择知识库。插件不能直接提交根路径；普通 Markdown 文件夹也可连接，不要求运行 Obsidian。
4. 插件停用或卸载后，`nexus_*` 模型工具隐藏且拒绝调用；修改插件文件后需重新审阅启用。卸载保留设置及知识库连接数据，不删除用户笔记。

Forge 0.4.3 支持直接导入同 ID 的星枢新版或同版本修订包覆盖升级，无需先卸载。重启后生效，设置、插件数据及知识库连接保留；权限变化后需重新启用。只更新独立插件，宿主和官方客户端版本保持不变。

Forge 0.4.3 使用 Codex `26.1029.7803.0`。[星枢 0.2.1](https://github.com/HOMEFTW/codex-forge-nexus/releases/tag/v0.2.1) 已追加该客户端兼容声明，并保留旧基线 `26.1027.6604.0`，最低 Forge 为 `0.4.2` / API 3。星枢 0.2.0 仍只支持旧客户端；不要绕过宿主检查。0.4.3 的完整视图修订已用星枢 0.2.1 原生窗口验证，完整面板不再被 Forge 悬浮按钮或聊天输入条覆盖，退出后恢复正常侧栏。

只有已安装、兼容、指纹匹配且已启用的 `homeftw.nexus` 能开放星枢 MCP 工具。读工具要求 `nexus.read`，写工具另需 `nexus.write`。其他获权插件可使用公共 SDK 数据服务，不依赖星枢插件的安装状态。

## 宿主提供的接口

- `forge.nexus.connect()`：通过原生选择器连接目录，取消返回 `null`。
- `forge.nexus.disconnect(vaultId)`：断开连接并返回剩余目录。
- `forge.nexus.request(method, args)`：索引、搜索、读取与编辑笔记，以及属性、任务、表格、列表、模板、日记、数据库和兼容查询。

连接与断开同时要求读写权限，不开放给 MCP。数据方法、参数、返回值、兼容语法与限额见 [接口清单](NEXUS-API.md) 和 `sdk/nexus.d.ts`。API 中的内容均是数据，不是对模型的指令。

现有文件写入需要读取获得的 `expectedRevision`；外部编辑后拒绝覆盖，由插件保留草稿并合并。删除、覆盖和重命名保留历史与库内 `.trash/forge-*` 副本。重命名返回待修正引用，不自动改写整库。写入依赖本地文件系统独占创建/硬链接能力，Windows NTFS 为测试目标。

外部面板仍运行于脚本沙箱和 CSP 内；具有 `nexus.read` 权限时可加载 data URL 音视频。PDF 内嵌、嵌套网页和对象嵌入不开放。界面功能与第三方插件兼容子集由独立插件文档维护，星枢 0.2.0 可在用户点击后用隔离 Worker 运行常用只读 DataviewJS 子集。脚本没有宿主 SDK/Node/网络权限；服务和 MCP 仍不执行 JS，Templater 系统命令和 QuickAdd 宏脚本也不执行。

## 开发与验证

```powershell
node --test tests/nexus.test.cjs tests/nexus-mcp.test.cjs tests/forge-package.test.cjs tests/integration.test.cjs
```

宿主验证见 [VALIDATION.md](VALIDATION.md)。[NEXUS-VALIDATION.md](NEXUS-VALIDATION.md) 保留 0.4.0 初次集成的历史证据；当前界面构建和浏览器预览属于独立插件工程，宿主不再包含 `scripts/nexus-preview.mjs`。
