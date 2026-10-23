# Codeg 技能包来源与适配说明

本发行版随包保存 Codeg 四组技能的完整文档与参考资源，默认全部停用。
专家 14 项、科学研究 13 项、Office 9 项、会话可视化 1 项，共 37 项。
用户的 Custom 技能属于用户数据，不是 Codeg 内置内容，未被读取或重新分发。

Codeg 来源：https://github.com/spacering-net/codeg ，固定提交
`bed8931485d2de6ab65c83e182fbd4a79c72e12b`。Codeg 自身使用 Apache-2.0，
完整许可证在 `bundled-skills/licenses/Codeg-Apache-2.0.txt`。

- 专家技能来自 Codeg `src-tauri/experts/skills`，上游为
  https://github.com/obra/superpowers ，MIT，Copyright (c) 2025 Jesse Vincent。
  Codeg 本次提交没有记录其原始 Superpowers 提交，不能将当前上游 HEAD 冒充其版本。
  许可证由上游公开 `LICENSE` 于 2026-10-23 核对，完整文字保留于
  `bundled-skills/licenses/Superpowers-MIT.txt`。
- 科研技能来自 Codeg `src-tauri/science`；Codeg 的来源通知固定
  K-Dense-AI/scientific-agent-skills 提交
  `4d97e293dc6f604fb6b63dcd49b9028df413d65b`，仅使用 MIT 子集。
  Copyright (c) 2025 K-Dense Inc.；原始通知及完整 MIT 文本保留于
  `bundled-skills/licenses/Science-NOTICE.md`。
- Office 页在 Codeg 中通过 `officecli load_skill` 动态读取，不随 Codeg 源码提供正文。
  本版把 Codeg 定义的九个对应 OfficeCLI 技能完整目录固定并随包提供，来源为
  https://github.com/iOfficeAI/OfficeCLI 提交
  `06ab520135a5289d0556d3e47fc2d42523f86547`，Apache-2.0，
  Copyright 2026 OfficeCLI (https://OfficeCLI.AI)，created and maintained by goworm。
  保留 `OfficeCLI-LICENSE.txt`、`OfficeCLI-NOTICE.txt` 与
  `OfficeCLI-THIRD-PARTY-NOTICES.txt.txt`；来源代码的 `SkillInstaller.cs` 和
  `officecli.csproj` 说明这些目录正是 `load_skill` 的嵌入资源。
  此操作没有安装 OfficeCLI、运行技能脚本或读取用户办公文档。
  新版 OfficeCLI 另有 `officecli-word-form`，不属于固定 Codeg 的九项，未计入本包。
- 会话可视化来自 Codeg `src-tauri/genui/ui-render`，Apache-2.0。

完整机器可读清单位于 `bundled-skills/catalog.json`：每项保留来源仓库、提交、
原目录、许可证、全部文件路径、字节数、SHA256。通过 Git 的固定提交 blob 复制，
不包含源工作区的未追踪、忽略文件或本地配置；原技能与资源未作文字替换。
`runtime/skills.cjs` 的 `SkillsStore.verify()` 会按固定清单核对随包资源摘要；相关检查包含在 `node scripts/run-tests.mjs` 中。

适配发生在 `runtime/skills.cjs` 返回模型的说明中，原文保持不变：

- 用户、系统和开发者指令优先。技能的提交、审批、外部通信或子代理流程不会增加授权。
- 启停按 Codex、Claude Code、Grok Build、DSH 分开保存。仅在用户要求时启用协作。
- Codex 模型通过 `skill_list`、`skill_read`、`skill_files` 按需读取已启用技能。
  外部智能体的提示词获得经哈希验证的绝对路径，以其原生文件工具读取，不要求不存在的 MCP。
  面板可以预览停用项，Codex 模型工具不可绕过启用状态。
- 不在全局 `CODEX_HOME/skills`、`.agents/skills` 或其他智能体技能目录创建链接；
  不覆盖既有同名用户技能。配置只保存在 `CODEX_HOME/fast-canvas/skills/enabled.json`。
- Codeg 的 `spec` / json-render 聊天渲染器未移植。UI 技能保留作格式参考，
  模型被明确要求使用普通 Markdown、表格或当前已有的画布工具，不宣称已渲染交互卡片。
- OfficeCLI、Python、uv、API 密钥和第三方服务仍依赖实际环境；启用不会自动安装、
  计费调用、执行脚本或配置凭据。办公与科研生成质量需在对应环境另外验证。
