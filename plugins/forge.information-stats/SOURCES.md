# 信息统计源码依据

核对日期：2026-10-27。第三方许可见同目录 THIRD-PARTY-NOTICES.txt。

| 上游 | 读取的提交 | 使用范围 |
| --- | --- | --- |
| https://github.com/zoefix/agent-speed | a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c | spec/METRICS.md、windows/src/AgentSpeed.Core/Parsing/CodexParser.cs：现代/旧版 usage、去重、复制历史、响应计时和归一化 |
| https://github.com/xqy2006/ModelTrace | 6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2 | static/fingerprint-core.js、static/data/unified_bank.json：全局稳健数字指纹、家族概率与校准 |
| https://github.com/kiyoakii/is-gpt-nerfed | ff0d7c0c8fdc8713273b6570b1ada1838eaad84c | plugin/skills/is-gpt-nerfed/scripts/nerfed：被动模型/思考强度/窗口检查、已应用设置区分、三份临时分支检测及本地结果导入 |

ModelTrace 指纹库 SHA-256：`eeab6ff54d6ffb2b294ebfd6cce25bce387f7a268b66759144f64c16f6c66b9f`，与上述上游提交逐字节一致。

Forge 侧栏只统计当前 Codex 对话，不宣称覆盖 Agent Speed 的全部 CLI/压缩日志格式。被动检查不消耗模型额度，不按名称推断升级/降级；未见设置记录的变更只提示复核。主动数字检测由用户点击启动，顺序生成三份临时分支回答，拒绝工具调用，不自动暂停用户主任务。

本库未收录 `gpt-6.1-sol`。对它显示“参考库未收录”，最近候选不构成模型替换证据。来源算法的一、二、三组样本分析已与上游 JavaScript 输出完整比对。
