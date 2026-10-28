# 从零开发一个 Codex Forge 插件

本教程用 JavaScript 和 HTML 创建一个能在原生右侧标签中显示、读取统一设置、向当前会话输出、编辑输入草稿及打开内置浏览器的插件。目标环境：Windows x64，Codex Forge 0.3.1 / API 2，客户端 26.1023.6123.0（同时保留 26.1021.2667.0 和 26.1016.8622.0 的兼容声明）。

## 1. 获取源码与创建项目

安装 Node.js 22+ 和 Codex Forge，克隆拥有访问权限的仓库：

```powershell
git clone https://github.com/HOMEFTW/codex-forge.git
cd codex-forge
npm ci
node cli/forge.mjs create ./my-first-plugin
```

`create` 复制可运行的 `examples/hello-forge`，生成三个文件：

- `plugin.json`：身份、版本、兼容范围、权限、入口、按钮、设置和日志。
- `main.js`：命令运行时；每个启用插件有一个独立隐藏 iframe。
- `panel.html`：用户点击按钮后打开的可见面板，默认成为原生右侧标签页。

将 `plugin.json` 中的 `id` 改为 `yourname.first-plugin`，将 `name` 改为“我的第一个插件”。发布后的 ID 应保持稳定；`forge.*` 是内置插件保留命名空间。复制模板后可以删除不适用的 `$schema` 相对路径，或改为指向本地 SDK 的路径。

## 2. 理解插件清单

这是一个完整的最小清单，可直接替换模板清单。它保留接下来示例用到的能力：

```json
{
  "schemaVersion": 1,
  "apiVersion": 2,
  "id": "yourname.first-plugin",
  "name": "我的第一个插件",
  "version": "0.3.1",
  "description": "在当前会话插入问候，显示可折叠输出，并打开内置浏览器。",
  "compatibility": {
    "codex": ["26.1023.6123.0", "26.1021.2667.0", "26.1016.8622.0"],
    "forge": [">=0.3.0 <0.4.0"]
  },
  "permissions": ["panels", "sidebar", "toolbar", "composer", "conversation.read", "output", "browser", "storage", "settings", "events"],
  "capabilities": [
    {"name": "browser", "version": 1},
    {"name": "composer", "version": 1},
    {"name": "events", "version": 1},
    {"name": "output", "version": 1},
    {"name": "panels", "version": 1},
    {"name": "settings", "version": 1},
    {"name": "storage", "version": 1},
    {"name": "ui", "version": 1}
  ],
  "entry": "main.js",
  "contributes": {
    "commands": [{"id": "hello", "title": "问候当前会话"}],
    "events": [{"name": "plugin.yourname.first-plugin.status", "title": "状态变化"}],
    "panels": [{"id": "main", "title": "我的插件", "entry": "panel.html"}],
    "sidebar": [{"id": "open", "title": "我的插件", "panel": "main"}],
    "toolbar": [{"id": "open", "title": "我的插件", "panel": "main"}],
    "composer": [{"id": "hello", "title": "插入问候", "command": "hello"}],
    "settings": {
      "properties": {
        "greeting": {"type": "string", "title": "问候内容", "default": "你好，Forge！", "maxLength": 1000}
      }
    }
  },
  "changelog": [{"version": "0.3.1", "date": "2026-10-28", "items": ["适配 Codex Forge 0.3.1 / API 2。"]}]
}
```

每个插件必须同时声明客户端和 Forge 兼容范围。数组里的多个版本是“或”，单个字符串中的条件是“且”，例如 `codex: ["26.1023.6123.0", "26.1021.2667.0", "26.1016.8622.0"]` 表示开发者验证过三个版本；当前 Forge 为这三个版本分别维护固定适配器。后续客户端版本仍必须先完成适配和验证，再加入兼容数组。当前宿主 API 版本为整数 `2`。

`panels` 没有指定 `placement` 时就是原生右侧标签页。只有功能确需全宽时才声明 `placement: "expanded"` 和至少 6 个字符的 `placementReason`，不要自己叠加侧栏。`description` 和 `changelog` 会自动显示在“扩展插件功能与升级日志”中。

`capabilities` 声明插件实际使用的宿主服务，宿主在派发前校验；省略时按 `permissions` 推断，显式声明后只授予声明过的能力。调用未声明的服务会失败并提示要补哪一项，这比运行到一半才发现缺权限更容易排查。

## 3. 编写命令运行时

将 `main.js` 写成：

```javascript
const forge = window.CodexForge;
const removeHello = forge.commands.register('hello', async () => {
  const { greeting } = await forge.settings.get();
  const draft = await forge.composer.read();
  await forge.composer.insertText(greeting, draft.text);
  await forge.output.append(greeting, { title: '我的插件输出' });
  const count = (await forge.storage.get('count') || 0) + 1;
  await forge.storage.set('count', count);
});
forge.events.on('dispose', () => { removeHello(); });
```

`window.CodexForge` 由宿主在脚本执行前注入，不需要 npm 运行时包。编辑草稿必须传刚读到的 `expectedText`；用户已继续输入时操作会被拒绝，避免覆盖新草稿。这个 API 不会自动发送消息。会话输出是文本，在对话中可折叠；插件只能清除自己的输出。

## 4. 编写原生标签页面板

将 `panel.html` 写成下列完整内容：

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui; padding: 20px; }
  button { font: inherit; margin: 4px; padding: 8px 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
<h1>我的第一个插件</h1>
<button id="context">读取当前会话</button>
<button id="greet">输出问候</button>
<button id="browser">打开示例网页</button>
<pre id="status" role="status"></pre>
<script>
  const forge = window.CodexForge;
  const status = document.getElementById('status');
  function bind(id, action) {
    document.getElementById(id).onclick = async () => {
      try { status.textContent = JSON.stringify(await action(), null, 2); }
      catch (error) { status.textContent = error.message; }
    };
  }
  bind('context', () => forge.context.get());
  bind('greet', async () => {
    const { greeting } = await forge.settings.get();
    await forge.output.append(greeting, { title: '问候' });
    return '已输出到当前会话';
  });
  bind('browser', () => forge.browser.open('https://example.com'));
</script>
</html>
```

面板运行在隔离 iframe，没有 Node、任意文件访问、Electron IPC 或宿主同源权限。HTML 应自包含；复杂前端可在发布前打包为内联资源。插件直接请求网络时必须额外声明 `network` 权限及精确 `networkOrigins`，不要把密钥嵌入源码。`browser.open` 使用原生内置浏览器打开 HTTP(S) 网页，返回派发结果，并不保证目标网站已成功加载。

## 5. 校验、安装与调试

```powershell
node cli/forge.mjs validate ./my-first-plugin
node cli/forge.mjs install ./my-first-plugin
node cli/forge.mjs enable yourname.first-plugin
```

也可以在客户端顶部“插件管理”中选择插件目录安装，再审阅权限并启用。初次 CLI 安装默认停用。客户端已运行时，重启以重新读取 CLI 安装记录；直接在插件管理中操作会刷新界面。

创建或打开一个 Codex 会话后，验证：

1. 左栏或工具栏的“我的插件”打开原生右侧标签。
2. “读取当前会话”显示当前 threadId 与宿主版本；切会话再读时 ID 改变。
3. 输入框旁“插入问候”只修改草稿，输出可折叠。
4. 插件卡片的“设置”跳到原生设置 → Codex Forge 插件设置 → 本插件，修改问候后再次输出即可看到新内容。
5. 打开示例网页、停用插件、重新启用。停用后贡献按钮及 iframe 消失，设置和存储保留。

隔离数据测试可加 `--home`：

```powershell
node cli/forge.mjs install ./my-first-plugin --home ./output/tutorial-home/forge
node cli/forge.mjs enable yourname.first-plugin --home ./output/tutorial-home/forge
```

注意 `--home` 是 **Forge 数据目录**，不是 Codex 配置目录。隔离客户端的 `CodexForge.exe --profile <目录>` 会使用 `<目录>/codex-home/forge`；两者需要指向同一个 Forge 目录。调试端口仅允许与隔离 profile 一起使用，例如 `--debug-port 9322`。不要把真实用户配置复制到测试项目。

插件是复制安装的：修改源目录不会自动更新已安装副本。开发时先停用/卸载再安装；直接改已安装文件会触发指纹变化并要求重新启用。卸载保留设置和独立存储。

## 6. 增加其他原生入口

API 及权限以 [PLUGIN-API.md](PLUGIN-API.md) 和 [SDK 类型](../sdk/index.d.ts) 为准：

```javascript
// 需要 toolbar 权限；注册的命令必须在清单中声明并已有处理器。
const removeButton = forge.toolbar.register({ id: 'hello-dynamic', title: '动态问候', command: 'hello' });
forge.events.on('dispose', () => { removeButton(); });

// 需要 conversation.read + conversation.title 权限。
await forge.conversations.setTitle('新的会话标题');

// 设置变化时重新读取，不维护另一套设置页面。
const stopWatching = forge.events.on('settings.changed', async () => {
  const settings = await forge.settings.get();
  // 根据 settings 更新本插件界面。
});
const capabilities = await forge.capabilities.get();
if (capabilities.permissions.includes('events')) {
  await forge.events.emit('plugin.yourname.first-plugin.status', { ready: true });
}
```

`sidebar.register`、`toolbar.register`、`composer.register` 返回注销函数。注册项引用本插件声明的 `command` 或 `panel`。全局事件监听器应在 dispose 时清理；设置变化事件可以重复到达，处理器应能重复执行。

能力查询和事件接口只用于协作插件之间的轻量 UI 状态同步。事件不写入 Codex 会话日志，也不具备 DSH `session/event` 的崩溃恢复语义；重要状态请写入 `storage`，并在 `ready` 或 `context.changed` 后重新读取。

## 7. 打包与发布更新

在第一次发布前选定 `plugin.json.update`，例如 GitHub：

```json
{"provider":"github","repository":"yourname/first-plugin"}
```

或自建 HTTPS 服务器：

```json
{"provider":"server","manifestUrl":"https://plugins.example.com/first-plugin/latest.json"}
```

把该对象作为 `plugin.json` 的 `update` 字段，然后校验、打包：

```powershell
node cli/forge.mjs validate ./my-first-plugin
node cli/forge.mjs pack ./my-first-plugin ./first-plugin-0.3.1.forge-plugin.json
```

输出包必须在源目录之外，目标文件不能已存在。打包器拒绝链接、`.git`、`node_modules`；插件最多 1,000 文件、20 MiB 解包内容。打包产生两个文件：包本身及其 `.release.json` 清单。

将清单 `url` 填为真实下载地址；GitHub 中把清单以 **codex-forge-plugin-release.json** 名称作为正式 Release 附件发布，包 URL 必须属于同一仓库。服务器方式将清单上传到声明地址，包与清单同源。不要改动生成的 SHA-256、字节数与兼容声明。当前更新不支持认证头，私有 GitHub 仓库需手动安装。

后续版本把 `version` 递增到 `0.1.1`、填写 `changelog`，重复打包发布。在客户端插件管理页检查更新；兼容检查通过后暂存，提示重启。重启时再次核验兼容与文件摘要，成功替换后保留设置。新增权限时更新插件不会自动恢复启用。不要在更新中静默更换来源。

首次安装目前使用插件目录；JSON 包用于内置更新协议，不是 ZIP，也不是可直接双击安装的文件。开发者可另行分发源码目录作为首次安装内容。

## 8. 发布前清单

核对清单版本和权限；实际运行原生标签、设置、会话切换、草稿冲突、停用/卸载；从旧版本验证更新和重启。检查打包内容没有密钥、日志、用户历史和构建缓存。用真实已测试的客户端/Forge 版本声明兼容性，保留依赖许可证。扩展插件只依赖 Forge API，客户端混淆符号由 Forge 适配器维护。
