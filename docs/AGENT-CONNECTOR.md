# 外部智能体 MCP 连接器

连接器让同一台电脑上支持 MCP 的智能体访问用户共享的 Codex Forge 会话：读取历史、发送协作消息或任务、向正在工作的回合追加指令。需要 Codex Forge 0.7.5 或更新版正在运行。

## 在 Forge 中开启

1. 打开目标会话 → 智能体协作 → **外部智能体 MCP 接入**。
2. 开启“允许本机 MCP 访问”。为当前会话选择“只读内容”或“读取内容并发送消息 / 指令”。首次使用默认关闭且没有共享会话。
3. 展开“连接其他智能体”，把生成的 JSON 合并到目标智能体的 MCP 配置，重新连接 MCP。配置包含本机实际 Node、脚本及数据目录路径；随 Forge 提供的 Node 可直接运行，无需额外安装。
4. 告诉外部智能体先调用 `forge_conversations_list`，再选择返回的会话 ID 操作。撤销某会话或关闭总开关后，新请求立即被拒绝，尚未完成的请求取消。已被客户端接受的消息会保留。

“外部 MCP 访问”与原来的向 Claude Code / Grok / DSH 派发任务分别授权。外部消息带来源名称，并沿用目标会话的模型、权限和审批规则。名称由发送方填写，供辨认来源使用。会话内容和其他智能体的输出本身不授予额外操作权限。

## 安装独立连接器

[下载发布包](https://github.com/HOMEFTW/codex-forge/releases/download/v0.7.5/codex-forge-agent-connector-1.0.0.tgz)，包名为 `codex-forge-agent-connector-1.0.0.tgz`，只包含脚本、说明及许可证，无运行时 npm 依赖，需要 Node.js 22 或更新版：

```powershell
npm install -g C:\Downloads\codex-forge-agent-connector-1.0.0.tgz
codex-forge-agent --config
```

将第二条命令输出的 JSON 合并到目标智能体的 MCP 设置。Windows 上生成的配置使用绝对 Node 路径，避免 MCP 客户端无法直接执行 `.cmd`。也可直接运行 `node <解压目录>/index.cjs --config`。常见支持 `mcpServers` 的客户端可直接使用输出；其他客户端取其中的 `command` 和 `args` 填入对应的 stdio MCP 配置。

默认发现 `%CODEX_FORGE_HOME%`，否则 `%CODEX_HOME%/forge`，否则 `%USERPROFILE%/.codex/forge`。便携版或自定义数据目录使用 `--home <实际 Forge 数据目录>`；以 Forge 页面生成的配置为准。安装连接器不会开启访问，也不会改动其他智能体已有配置。

本地构建安装包：

```powershell
npm run build:agent-connector
npm pack ./dist/agent-connector --pack-destination ./dist
```

开发回归使用 `node --test tests/collaboration-bridge.test.cjs`。设置 `FORGE_NATIVE_CODEX` 为本机 `codex.exe` 路径后运行 `node --test tests/collaboration-native.test.cjs`，会在临时数据目录启动真实 app-server，并用本地模拟模型验证发送、追加指令和历史读回。

## 工具契约

| 工具 | 参数与结果 |
| --- | --- |
| `forge_conversations_list` | 仅列出共享会话；返回 ID、标题、状态和访问级别。支持 `limit`、`cursor`。 |
| `forge_conversation_read` | `threadId`；返回元信息和从新到旧的回合摘要，可用 `nextCursor` 继续读。 |
| `forge_conversation_items` | `threadId`，可选 `turnId`；按时间顺序读取消息和工具项，直到 `nextCursor` 为 null。运行中输出可能继续变化。 |
| `forge_conversation_send` | `threadId`、`sender`、`text`、`requestId`；闲置时启动工作，运行中按客户端原生行为追加输入。 |
| `forge_conversation_steer` | 同上，加 `expectedTurnId`；只向这个运行中回合追加指令。回合已变化或完成时返回错误。 |

读取分页 `limit` 默认 20，最大 100。响应上限为 2 MiB；内容过大时减小页大小。`read` 提供摘要，完整消息内容通过 `items` 分页获取。

发送示例（先取得用户对目标会话通信的授权）：

```json
{
  "threadId": "实际会话ID",
  "sender": "Claude Code",
  "requestId": "review-result-001",
  "text": "审查已完成：发现两处问题，请按下面的建议修复……"
}
```

返回 `accepted: true` 表示客户端已接收。使用 `read` / `items` 检查执行状态和结果。`requestId` 在本次 Forge 运行期间去重：相同 ID 和参数复用先前结果，不同内容复用 ID 会拒绝。宿主重启后去重记录消失；发送超时、断线或取消后应先读会话核对，避免换 ID 自动重发。发送可能触发模型服务费用，连接器不自动回复收到的内容。

## 连接与范围

MCP 使用 stdio；连接器只连接本机 `127.0.0.1` 的随机端口，并使用宿主生成的随机令牌。连接文件随宿主启动更新，停用或退出时删除；连接器每次操作重新发现，无需固定端口。令牌不包含在 MCP 配置中。相同系统用户下的连接器共用已授予的会话权限，适用于可信的本机智能体。

本实现不提供远程连接或任意 shell 执行工具，也不修改普通 Forge 插件已有的会话隔离规则。正式发布/安装新的 Forge 构建后，正在使用的客户端才会获得此入口。
