# Forge API 1

插件目录必须包含 `plugin.json`。`id` 使用 `publisher.name`；`forge.*` 保留给内置插件。`compatibility.codex` 和 `compatibility.forge` 是非空数组，数组项之间是“或”；单项空格分隔的比较条件是“且”。支持精确三/四段数字版本、`>= <= > < = ^ ~` 和 `||`，不接受隐式通配或预发布字符串。

```json
{"schemaVersion":1,"apiVersion":1,"id":"example.panel","name":"示例","version":"0.1.0","compatibility":{"codex":["26.1016.8622.0","26.1017.1.0"],"forge":[">=0.1.0 <0.2.0"]},"permissions":["panels"],"contributes":{"panels":[{"id":"main","title":"示例","entry":"panel.html"}]}}
```

宿主向 iframe 注入 `window.CodexForge`。`entry` 是可选的浏览器 JS 命令入口。面板 HTML 应自包含，使用内联脚本和样式；可在发布前用自己的构建器打包。没有 Node、任意 IPC、文件系统、同源权限或自动消息发送权限。允许的网络源必须通过 `network` 和 `networkOrigins` 声明；面板不能导航宿主。API 仍按来源窗口和插件安装记录校验身份。

| API / 清单贡献点 | 权限 | 行为 |
| --- | --- | --- |
| `context.get()` | `conversation.read` | 获取可信当前会话与版本；无权限时隐藏 threadId |
| `panels.open(id)` / `close(id)` | `panels` | 原生右侧标签页；全宽需清单声明 `placement: expanded` 与功能理由 |
| `sidebar.register(item)` | `sidebar` | 注册左栏按钮，引用本插件命令或面板；返回异步注销函数 |
| `toolbar.register(item)` | `toolbar` | 注册工具栏按钮 |
| `composer.register(item)` | `composer` | 注册输入框按钮 |
| `composer.read/insertText/setText` | `composer`、`conversation.read` | 读写当前草稿；修改必须传入 `expectedText`，草稿已变化则拒绝 |
| `conversations.setTitle(title)` | `conversation.title`、`conversation.read` | 修改当前原生会话标题，切会话后的迟到请求拒绝 |
| `output.append/clear/open` | `output`、`conversation.read` | 写当前会话的可折叠输出及原生输出标签；清除仅影响本插件 |
| `browser.open(url)` | `browser`、`conversation.read` | 使用原生内置浏览器打开 HTTP(S) 地址 |
| `storage.get/set/delete` | `storage` | 独立 JSON 存储，单键64KB、每插件1MB |
| `settings.get()` | `settings` | 获取经过类型、范围和枚举校验的设置 |
| `metadata.get()` | 无 | 获取自己的清单、描述与升级日志 |
| `commands.register(id, handler)` | 无 | 注册已声明命令的处理器；返回注销函数 |
| `events.on(name, callback)` | 无 | `ready`、`context.changed`、`settings.changed`、`dispose` |

静态按钮在 `contributes.sidebar/toolbar/composer` 中声明；动态注册使用相同 `{id,title,command}` 或 `{id,title,panel}` 结构。安装后默认停用。停用卸载会销毁运行时与贡献点；卸载保留独立设置。代码或清单被手动修改后，重新加载会要求审阅并重新启用。

`contributes.settings.properties` 使用 `{type,title,default,enum,minimum,maximum,maxLength}`，支持字符串、数字和布尔值。设置界面自动集中到原生“Codex Forge 插件设置”；插件管理的设置按钮携带插件 ID 深链接，用户不必自行查找。

`description` 提供功能介绍，`changelog:[{version,date,items:[]}]` 提供升级日志；宿主自动收录到“扩展插件功能与升级日志”页面。

CLI 支持 `create / validate / pack / list / install / uninstall / enable / disable / settings`，`--home` 可选独立测试数据目录。详见 `node cli/forge.mjs`。示例代码见 `examples/hello-forge`。

固定版本适配器在 `scripts/native-*-patch.mjs`。遇到未知客户端版本或锚点变化必须增加经过验证的适配器，不能放宽版本号并直接套用。Forge API 与原生混淆符号之间仅由宿主适配层连接。
