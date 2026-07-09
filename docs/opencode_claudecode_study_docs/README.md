# OpenCode vs Claude Code Rebuilt 源码级深度研究文档包

本包围绕两个代码库展开：

- `anomalyco/opencode`
- `weikma/claude-code-rebuilt`

分析目标不是做一份泛泛而谈的产品测评，而是把它们拆成若干“可工程落地的核心模块”，逐项回答四个问题：

1. 该模块在两个项目中分别是如何设计的。
2. 这种设计背后的架构哲学是什么。
3. 两者相比，谁在功能上限、完成复杂任务效率、上下文成本控制、可维护性上更占优。
4. 如果最终选择 OpenCode 作为后续主线项目，应该怎样有节制地吸收 Claude Code Rebuilt 的优点，而不把 OpenCode 改造成臃肿难维护的系统。

## 文档目录

- `00_总览与最终建议.md`
- `01_上下文管理模块深度对比.md`
- `02_主循环与执行调度模块深度对比.md`
- `03_工具注册_MCP_Skill_与子代理体系对比.md`
- `04_系统提示词_Agent模式控制_与路由设计对比.md`
- `05_内置工具_Read_Edit_Bash_Task_设计对比.md`
- `06_OpenCode_改造蓝图与文件级落地方案.md`
- `07_评测基线_Benchmark_Harness_设计.md`
- `08_源码检查清单与引用文件列表.md`
- `MASTER_REPORT.md`

## 使用建议

阅读顺序建议如下：

先看 `00_总览与最终建议.md`，明确结论与路线；  
再看 `01`、`02`、`03`、`04`、`05` 五个模块文档，建立源码级认识；  
最后看 `06` 与 `07`，把分析转为具体改造与评测工程。

## 方法说明

本研究以源码为主，而不是 README 宣传文案。重点检查的文件包括但不限于：

### Claude Code Rebuilt
- `src/query.ts`
- `src/Tool.ts`
- `src/tools.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/SessionMemory/sessionMemory.ts`
- `src/constants/prompts.ts`

### OpenCode
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/overflow.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/tool/edit.ts`
- `packages/opencode/src/tool/bash.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/plan.ts`

## 一句话结论

如果目标是**继续直接使用现有代码并尽可能体验 Claude Code 式高阶 agent 行为**，Claude Code Rebuilt 更接近“强内核”；  
如果目标是**把项目当作长期演进的开源 CLI 平台来开发、维护、评测和扩展**，OpenCode 是更优的底座。

真正理想的路线不是二选一，而是：

**以 OpenCode 为主干，以 Claude Code Rebuilt 为“高阶机制参考库”，逐步移植其多层上下文治理、工具预算与会话记忆能力。**
