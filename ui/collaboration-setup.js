// PowerShell single-quoted arguments also preserve spaces, apostrophes and $.
const quote = value => "'" + value.replaceAll("'", "''") + "'";
export function connectorSetup(config, targetFile = '') {
  const server = config.mcpServers.codex_forge;
  const command = '& ' + [server.command, ...server.args].map(quote).join(' ');
  const target = targetFile.trim();
  const installCommand = command + ' --install ' + quote(target || '<目标 MCP JSON 配置文件的绝对路径>');
  const configCommand = command + ' --config';
  const prompt = [
    '请将本机 Codex Forge 内置的 MCP 连接器接入你当前使用的智能体客户端。连接器和 Node.js 已随 Forge 提供，直接使用下列本机路径。',
    target ? `目标配置文件：${target}` : '先确认当前客户端的 MCP 配置文件位置和格式；不确定时请询问我。',
    '如果客户端使用 mcpServers JSON，运行下面的 PowerShell 命令（先将占位路径替换为实际配置文件的绝对路径）。命令会保留其他配置，更新 codex_forge，并为已有文件生成 .bak 备份。',
    installCommand,
    '如果客户端使用 TOML、JSONC 或其他格式，使用下面的命令读取连接配置，再按该客户端的格式合并 command 和 args，保留其他服务器和设置：',
    configCommand,
    '重新连接 MCP；如需要重启，请提示我操作。调用 forge_conversations_list 检查接入，并报告配置位置和检查结果。Forge 需要正在运行；若访问未开启或会话未共享，提示我在“智能体协作 → 外部智能体 MCP 接入”中开启并授权。',
    '本次仅安装并检查连接。读取会话内容或发送消息、任务、追加指令时，按我后续明确授权的目标和范围操作。',
  ].join('\n\n');
  return { installCommand, configCommand, prompt };
}
