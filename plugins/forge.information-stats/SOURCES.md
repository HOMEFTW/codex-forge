# 信息统计源码依据

## lm-detector 更新（2026-11-12，本地源码）

- 数字评分与参考数据使用 https://github.com/Ikaleio/lm-detector ，固定提交 `a7e9d3056e019827904dd50722c20b4a0c896738`，MIT。
- `data/unified_bank.json`：69 个指纹类别，15 个家族，2,560 条参考回答；数据日期 2026-11-11。
- 配套 `data/shared_detector.bin` 和 `shared` 目录的评分、位置/顺序特征、二进制解码源码提供本机离线评分，未使用网页代理或在线评分服务。
- 上游源码及逐文件摘要在 `vendor/lm-detector`；`scripts/build-information-detector.mjs` 生成运行时 CommonJS 文件，UI 构建同时执行。
- 数据、评分器、标准挑战和推理档位元数据的摘要见 `runtime/information-provenance.json`；运行时核验配对关系。
- 采样沿用独立临时会话和当前模型、提供商、思考强度，使用上游 environment-01 的三条固定挑战（218、233、247 个数字）。参考档位来自参考批次显式记录，未记录/default 不推断为相同。
- Astra / 6.1-Sol 共用指纹类别；共享类别不认证独立型号，旧 Claude 拼写作为别名。条件不同与外部粘贴/导入样本只显示排名，不显示校准概率或触发不一致红字。
- 自动检测默认关闭；开启后在空闲时采样，同渠道身份、模型、思考强度与数据版本复用 24 小时缓存。失败和取消同样冷却，手动可立即重试。渠道、凭据、账号只参与本机摘要，不写入记录或返回界面。
- 详细行为与验证范围见 `docs/INFORMATION-STATS.md`。以下是旧版实现历史，不代表当前使用 18 类库或原评分算法。

## 旧版依据（2026-10-27）

核对日期：2026-10-27。第三方许可见同目录 THIRD-PARTY-NOTICES.txt。

| 上游 | 读取的提交 | 使用范围 |
| --- | --- | --- |
| https://github.com/zoefix/agent-speed | a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c | spec/METRICS.md、windows/src/AgentSpeed.Core/Parsing/CodexParser.cs：现代/旧版 usage、去重、复制历史、响应计时和归一化 |
| https://github.com/xqy2006/ModelTrace | 6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2 | static/fingerprint-core.js、static/data/unified_bank.json：全局稳健数字指纹、家族概率与校准 |
| https://github.com/kiyoakii/is-gpt-nerfed | ff0d7c0c8fdc8713273b6570b1ada1838eaad84c | plugin/skills/is-gpt-nerfed/scripts/nerfed：被动模型/思考强度/窗口检查、已应用设置区分、三份数字样本检测及本地结果导入 |

ModelTrace 指纹库 SHA-256：`eeab6ff54d6ffb2b294ebfd6cce25bce387f7a268b66759144f64c16f6c66b9f`，与上述上游提交逐字节一致。

Forge 侧栏只统计当前 Codex 对话，不宣称覆盖 Agent Speed 的全部 CLI/压缩日志格式。被动检查不消耗模型额度，不按名称推断升级/降级；未见设置记录的变更只提示复核。主动数字检测由用户点击启动，在空工作目录下顺序创建三个独立临时会话，沿用当前模型、提供商与思考强度，不复制主任务历史和项目指令；拒绝实际工具调用，不自动暂停用户主任务。

本库未收录 `gpt-6.1-sol`。对它显示“参考库未收录”，最近候选不构成模型替换证据。来源算法的一、二、三组样本分析已与上游 JavaScript 输出完整比对。
