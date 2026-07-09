# Claude Code Rebuilt 上下文治理逻辑分析与 OpenCode 上下文管理完整构建方案

## 1. 文档目标

本文档基于 `thirdparty/claude-code-rebuilt` 的真实实现，系统分析其上下文治理（context governance）机制，并结合 `opencode` 当前实现，提出一套适用于 OpenCode 的完整上下文管理方案。目标不是机械复制 Claude Code Rebuilt，而是提取其高价值核心思想，并在 OpenCode 现有架构上构建一套更易维护、可渐进演进、可观测、可评测的多层治理体系。

本文交付三类结果：

1. 对 Claude Code Rebuilt 上下文治理逻辑的完整拆解；
2. 对 OpenCode 当前上下文管理能力与缺口的系统评估；
3. 一套可直接落地到 OpenCode 的目标架构、模块设计、状态模型、阈值策略、压缩策略、记忆机制、清理机制与分阶段实施方案。

---

## 2. 研究范围与证据来源

本方案基于以下关键代码路径的实际阅读与交叉比对：

### 2.1 Claude Code Rebuilt 关键文件

- `thirdparty/claude-code-rebuilt/src/context.ts`
- `thirdparty/claude-code-rebuilt/src/bootstrap/state.ts`
- `thirdparty/claude-code-rebuilt/src/utils/context.ts`
- `thirdparty/claude-code-rebuilt/src/services/compact/autoCompact.ts`
- `thirdparty/claude-code-rebuilt/src/services/compact/compact.ts`
- `thirdparty/claude-code-rebuilt/src/services/compact/sessionMemoryCompact.ts`
- `thirdparty/claude-code-rebuilt/src/services/compact/postCompactCleanup.ts`
- `thirdparty/claude-code-rebuilt/src/services/compact/prompt.ts`
- 与 query 主链路相关的上下文预算、micro compact、context collapse、tool budget 调用位置

### 2.2 OpenCode 关键文件

- `opencode/packages/opencode/src/session/system.ts`
- `opencode/packages/opencode/src/session/llm.ts`
- `opencode/packages/opencode/src/session/overflow.ts`
- `opencode/packages/opencode/src/session/compaction.ts`
- `opencode/packages/opencode/src/session/processor.ts`
- `opencode/packages/opencode/src/session/prompt.ts`
- `opencode/packages/opencode/src/session/summary.ts`
- `opencode/packages/opencode/src/agent/prompt/compaction.txt`
- `opencode/packages/opencode/src/config/config.ts`
- `opencode/packages/opencode/src/session/prompt/anthropic.txt`

---

## 3. Claude Code Rebuilt 的上下文治理：不是单一 compact，而是分层治理系统

Claude Code Rebuilt 的核心价值不在于“会自动压缩”，而在于它把上下文当作需要持续治理的稀缺资源，形成了一个由“注入、预算、分层压缩、记忆旁路、压缩后恢复与清理”组成的闭环系统。

### 3.1 第一层：系统上下文与用户上下文的分层注入

Claude Code Rebuilt 在 `src/context.ts` 中将上下文注入显式拆成两层：

- `getSystemContext()`：构建 system 级上下文；
- `getUserContext()`：构建 user 级上下文。

其关键点不只是“把提示词拼起来”，而是把以下内容都视为上下文资产：

- git 状态快照；
- CLAUDE.md / memory files；
- 日期、运行时环境；
- system prompt injection；
- 缓存可复用的用户态上下文。

这说明 Claude Code Rebuilt 的思路是：

1. 上下文不等于消息历史；
2. 系统级上下文与会话历史是两条不同数据流；
3. memory / instruction / environment 需要单独缓存与失效控制；
4. 压缩之后还要考虑这些系统级资产的重新恢复与重建。

### 3.2 第二层：基于有效窗口的预算治理，而不是贴边运行

在 `src/utils/context.ts` 与 `src/services/compact/autoCompact.ts` 中，Claude Code Rebuilt 并不直接使用模型的名义上下文窗口，而是构建“有效上下文窗口（effective context window）”。

其预算治理包含几个关键步骤：

1. 根据模型能力解析真实输入窗口；
2. 为 compact 输出预留一部分 tokens；
3. 再扣除额外 buffer，形成自动压缩阈值；
4. 基于 usage 计算 warning / error / compact 的分层状态；
5. 限制连续 compact 失败次数，并防止进入重复抖动。

这意味着 Claude Code Rebuilt 的策略不是：

- “快满了再压”；

而是：

- “为了让 compact 自身也能成功、并为 compact 后继续执行留足余量，必须提前触发”。

这是其稳定性高于简单 overflow 系统的根因之一。

### 3.3 第三层：compact 之前先做多层减载，而不是一刀切摘要

Claude Code Rebuilt 的主链路不是只有 `autoCompactIfNeeded()`。从 query 主流程来看，它在真正执行 full compact 前，存在多层前置治理：

- tool result budget；
- snip compact；
- micro compact；
- context collapse；
- 之后才是 auto compact。

这代表一种非常重要的设计哲学：

> full compaction 是最后兜底手段，而不是默认手段。

其收益包括：

- 降低频繁做大摘要的概率；
- 尽量保留原始消息结构；
- 优先清理高噪声、低复用、可恢复的信息；
- 避免在长任务中频繁“失忆式摘要”。

### 3.4 第四层：session memory 旁路，把慢变状态从主上下文中搬出去

在 `src/services/SessionMemory/*` 与 `src/services/compact/sessionMemoryCompact.ts` 一带，Claude Code Rebuilt 引入了与主消息流并行的 `SessionMemory` 机制。

它的本质不是简单的 summary，而是一个长期、阶段性、节流更新的慢变状态存储层。它管理的不是“最新对话逐字记录”，而是：

- 已确认约束；
- 当前任务阶段；
- 关键文件；
- 已做决策；
- 未完成项；
- 已验证或已失败的尝试；
- 后续继续任务所需的重要状态。

相关辅助状态包括：

- 上次摘要到哪个 message id；
- 是否达到初始化阈值；
- 是否达到增量更新阈值；
- 上次抽取时的 token 规模；
- summarized marker 等提取节流信息。

这使得 Claude Code Rebuilt 不必把所有长任务状态都靠聊天历史硬扛，而是把一部分状态迁移到“记忆侧带（memory side channel）”。

### 3.5 第五层：compact 本身是结构化重建，而不是单纯“把前文缩短”

在 `src/services/compact/compact.ts` 中，compact 真正做的事情比“总结历史”复杂得多，包括：

- 剥离图片和文档类块；
- 剥离会自动重注入的附件；
- 处理 partial compaction 与 preserved segment 边界；
- 截断过长前缀重试；
- 重组 compact 后的新消息边界；
- 保留工具、skills、attachments 与 session transcript 的必要关联。

这里的关键思想是：

1. 参与 compact 的内容不是原样 message list；
2. 不是所有上下文都适合交给 summary 模型；
3. compact 后的“继续工作上下文”需要显式重建；
4. 被调用过的 skill、关键附件、状态边界是需要单独保活的。

### 3.6 第六层：post-compact cleanup 是核心组成，而不是善后细节

`src/services/compact/postCompactCleanup.ts` 揭示了一个很多实现容易忽视的点：

> 压缩结束后，如果不清缓存、不清状态、不重置相关 memoized 数据，后续上下文可能继续使用压缩前的陈旧状态。

Claude Code Rebuilt 在 compact 后会清理或重置：

- micro compact 状态；
- context collapse 状态；
- `getUserContext()` 相关缓存；
- memory file cache；
- system prompt section cache；
- speculative checks；
- classifier approvals；
- tracing / attribution 相关缓存；
- session messages cache。

这说明 Claude Code Rebuilt 的 compact 是一个完整的“状态转移事件”，而不是只替换消息历史。

### 3.7 第七层：compact prompt 明确要求结构化分析与摘要

`src/services/compact/prompt.ts` 中的 compact prompt 不是简短摘要提示，而是高度结构化的“延续性摘要协议”：

- 要求模型先在 `<analysis>` 中做分析；
- 再在 `<summary>` 中按固定结构输出；
- 强调用户意图、关键技术概念、文件与代码片段、错误与修复、待办事项、当前工作与下一步；
- 区分 full compact、partial compact、up_to compact 等模式。

这表明 Claude Code Rebuilt 并不把 compact summary 当普通摘要，而是把它当“可供继续开发的工作状态包”。

---

## 4. 从 Claude Code Rebuilt 提炼出的核心思想

综合其实现，可以提炼出七条核心思想：

### 4.1 上下文治理是持续过程，不是 overflow 之后才发生的补救动作

Claude Code Rebuilt 的上下文治理发生在每轮前后，并伴随缓存、记忆、技能、附件、消息、预算等多个层面。

### 4.2 上下文不是单一消息列表，而是多种资产的组合

至少包括：

- message history；
- system prompt sections；
- user memory files；
- session memory；
- invoked skills；
- tool outputs；
- attachments；
- git / environment snapshots。

### 4.3 预算要分层，不同上下文资产要采用不同治理策略

- 历史工具输出适合先 budget / prune；
- 会话慢变状态适合 session memory；
- 长历史适合 compact；
- 系统级注入内容适合缓存与按需恢复；
- skills / attachments 适合独立预算与再注入。

### 4.4 full compact 应该是最后一级，而不是默认策略

中间层治理越强，full compact 次数越少，任务连续性通常越稳定。

### 4.5 compact 不只是“压缩消息”，而是“重建继续工作的上下文包”

compact 结果应保留：

- 当前任务目标；
- 当前工作状态；
- 关键文件；
- 关键结论；
- 未完成项；
- 最近失败与风险；
- 继续执行所需最小上下文。

### 4.6 压缩后必须做缓存与状态一致性恢复

否则 compact 后表面上消息变短了，但系统实际仍携带旧状态。

### 4.7 长任务状态不能只靠聊天历史承载

必须引入侧带记忆或结构化状态层。

---

## 5. OpenCode 当前上下文管理机制：已有骨架，但仍停留在“溢出驱动压缩”

OpenCode 并非没有上下文治理能力。相反，它已经有较好的基础骨架，只是当前层数还不够。

### 5.1 系统提示注入：已有 system 维度，但缺少治理生命周期

`src/session/system.ts` 负责生成环境、provider 与 skills 相关的系统提示内容；`src/session/llm.ts` 和 `src/session/prompt.ts` 则负责把 system、messages、tools、agent、format、plugin transform 汇总并发给模型。

这说明 OpenCode 已有“system context 独立于消息历史”的基本意识。但当前还缺少：

- 独立的上下文资产建模；
- 注入内容缓存与失效策略；
- compact 后的统一恢复逻辑；
- memory / recall 旁路。

### 5.2 overflow：已有 usable window 思想

`src/session/overflow.ts` 的 `usable()` 与 `isOverflow()` 已经体现出一个正确思路：

- 不直接把模型上限当可用窗口；
- 会扣掉 reserved buffer；
- 当 provider 有输入限制时优先用输入限制；
- 否则用 context window 与 max output 的组合推导可用窗口。

这是 OpenCode 的一个优点，说明它的阈值思路已经与 Claude Code Rebuilt 接近。

### 5.3 compaction：已有 prune-first 与摘要 agent 机制

`src/session/compaction.ts` 已实现以下关键能力：

- 保护 recent tail；
- 选择保留的 turn；
- 剪掉旧 tool outputs；
- 在需要时生成 compaction summary；
- 通过隐藏 compaction agent 执行摘要任务。

这意味着 OpenCode 已有两个很好的基础：

1. 认识到旧工具输出是高噪声资产；
2. 认识到 compaction 应由独立 agent / prompt 驱动。

### 5.4 processor 与 prompt 主循环：已具备 compaction 触发闭环

`src/session/processor.ts` 会在运行期感知需要 compaction 的条件，通过 `needsCompaction` 将当前处理过程导向 compact 路径。`src/session/prompt.ts` 进一步在主循环中：

- 调用 `compaction.process()`；
- 在 assistant finish 后检查 token overflow；
- 自动创建 compaction 任务；
- 在 full loop 结束后执行 `compaction.prune()`。

这说明 OpenCode 当前不是“完全静态”的，而是已经拥有一个运行中压缩闭环。

### 5.5 配置层：已具备 compaction 基础参数

`src/config/config.ts` 当前暴露的 `compaction` 配置包括：

- `auto`：是否自动压缩；
- `prune`：是否剪枝旧工具输出；
- `tail_turns`：保留最近多少轮用户 turn；
- `preserve_recent_tokens`：保留近期内容的 token 上限；
- `reserved`：为 compaction 与安全执行预留的 buffer。

这套配置是一个很好的起点，但还不足以支撑更完整的治理体系。

---

## 6. OpenCode 与 Claude Code Rebuilt 的关键差异

### 6.1 Claude Code Rebuilt 是“前置多层治理”，OpenCode 是“接近溢出时治理”

当前 OpenCode 的上下文治理主要在：

- 运行期发现 overflow；
- prune old tool outputs；
- 做 summary compaction。

Claude Code Rebuilt 则倾向于在每轮前就做多层清理和预算控制。

### 6.2 Claude Code Rebuilt 具有 session memory 旁路，OpenCode 目前没有

OpenCode 当前主要依赖：

- 最近消息；
- 系统提示；
- compaction summary。

缺少一个“长期慢变状态”的显式旁路。

### 6.3 Claude Code Rebuilt 具有 compact 后统一 cleanup，OpenCode 目前没有完整后处理层

OpenCode 当前 compact 后缺少系统级的：

- cache reset；
- recall rebuild；
- workset refresh；
- memory cache / system section cache 失效；
- compaction 边界元数据恢复。

### 6.4 Claude Code Rebuilt 对不同上下文资产做了更细颗粒建模

而 OpenCode 当前对 message、tool output、system prompt、memory、skills、task results、workset 等资产还没有统一的上下文资产视图。

---

## 7. 对 OpenCode 的目标判断：应该从“两层半”升级到“五层治理链”

OpenCode 当前大致是：

1. 工具自身输出限制；
2. prune old tool outputs；
3. full compaction summary。

建议升级为以下“五层治理链”：

1. **上下文资产分层建模**；
2. **Preflight 预算治理**；
3. **Micro-Compaction / 轻量折叠**；
4. **Session Memory 旁路**；
5. **Full Compaction + Post-Compaction Cleanup**。

换句话说，OpenCode 不需要复制 Claude Code Rebuilt 的全部复杂 query 状态机，但必须补齐治理层次。

---

## 8. OpenCode 上下文管理目标架构

下面给出建议的目标架构。

### 8.1 总体架构图（逻辑）

```text
用户输入 / 工具结果 / 系统状态
            │
            ▼
   Context Governor（统一调度层）
            │
   ┌────────┼────────┬───────────────┬─────────────┐
   ▼        ▼        ▼               ▼             ▼
Asset   Tool Budget  Workset     Session Memory  Overflow Policy
Model     Layer      Layer         Layer          Layer
   │        │           │             │             │
   └────────┴──────┬────┴───────┬─────┴─────────────┘
                   ▼            ▼
          Micro-Compaction   Full Compaction
                   │            │
                   └──────┬─────┘
                          ▼
                Post-Compaction Cleanup
                          │
                          ▼
                Rebuild / Recall / Continue
```

### 8.2 设计原则

#### 原则 A：不重写 OpenCode 的主循环，只新增治理服务

现有 `session/prompt.ts`、`session/processor.ts` 与 `session/compaction.ts` 已是良好骨架，建议在其前后增加治理服务，而不是把所有逻辑重新塞回 prompt 主循环。

#### 原则 B：所有治理都围绕“上下文资产”展开，而不是围绕“message array”展开

建议显式区分以下资产类型：

- `system_sections`
- `user_instructions`
- `message_history`
- `tool_outputs`
- `task_results`
- `workset`
- `session_memory`
- `compaction_summary`
- `attachments`
- `recovered_state`

#### 原则 C：不同资产采用不同治理方法

- system sections：缓存 + versioning + invalidation；
- tool outputs：budget + prune + preview 化；
- session memory：旁路存储 + recall；
- message history：tail preserve + compact；
- task results：结构化摘要；
- workset：关键文件优先保活；
- compaction summary：作为历史替代物，并成为 recall 输入源之一。

---

## 9. 建议新增的核心模块

### 9.1 `src/session/context-governor.ts`

作为统一编排层，负责每轮请求前后的上下文治理决策。

#### 责任

- 聚合 token 估算与 context asset 统计；
- 调用 tool budget；
- 调用 workset 更新；
- 决定是否触发 micro compaction；
- 决定是否触发 session memory 提取 / recall；
- 决定是否触发 full compaction；
- compact 后触发 cleanup。

#### 建议接口

```ts
export interface ContextGovernorService {
  prepare(input: PrepareContextInput): Effect.Effect<PreparedContext>
  afterToolResult(input: ToolResultContextInput): Effect.Effect<void>
  afterAssistantTurn(input: AssistantTurnContextInput): Effect.Effect<GovernanceSignal>
  afterCompaction(input: PostCompactionInput): Effect.Effect<void>
}
```

### 9.2 `src/session/context-assets.ts`

定义上下文资产的数据模型。

#### 建议类型

```ts
export type ContextAssetKind =
  | "system"
  | "instruction"
  | "history"
  | "tool-output"
  | "task-result"
  | "workset"
  | "memory"
  | "summary"
  | "attachment"

export interface ContextAssetStat {
  kind: ContextAssetKind
  tokenEstimate: number
  messageIDs?: string[]
  stable: boolean
  renewable: boolean
  priority: number
}
```

这一步非常关键。只有先把资产建模，后续预算与治理才不会变成散落条件分支。

### 9.3 `src/session/tool-budget.ts`

为高膨胀工具结果提供单独预算层。

#### 目标

- 不等 overflow 才清理；
- 在每轮前控制旧工具输出对上下文的长期侵占；
- 对不同工具使用不同压缩策略。

#### 建议策略

按工具类型定义预算与 compact priority：

- `bash` / `webfetch` / MCP 返回长文本：高优先级治理；
- `read` / `grep` / code search：中优先级，以路径 + 片段 preview 替代长原文；
- `task`：保留结构化结论，不保留冗长执行过程；
- `edit` / `write`：保留 diff 摘要和结果状态；
- `question` / `plan`：通常保留。

#### 输出形式

将旧 tool output 替换为结构化摘要块，例如：

```ts
interface ToolOutputDigest {
  tool: string
  sourceMessageID: string
  summary: string
  keyFacts: string[]
  referencedFiles: string[]
  omittedTokenEstimate: number
}
```

### 9.4 `src/session/workset.ts`

引入工作集（workset）概念，维护当前任务真正相关的文件集合。

#### 输入来源

- `read_file` / `edit` / `write` 等文件工具；
- `grep_search` / code search 命中；
- task/subagent 返回结果；
- bash / diagnostic 输出中出现的文件路径；
- 用户直接提及的关键文件。

#### 作用

- compaction 时优先保留工作集相关文件；
- session memory 提取时突出工作集；
- recall 时优先注入工作集摘要；
- 作为任务状态的重要结构化资产。

### 9.5 `src/session/session-memory.ts`

引入 OpenCode 的长期慢变状态层。

#### 责任

- 周期性抽取当前会话的重要状态；
- 存储为结构化 markdown / JSON 片段；
- 记录上次抽取位置与阈值；
- 在 recall 需要时按需注入。

#### 应记录的内容

- 当前目标；
- 已确认约束；
- 当前阶段；
- 工作集文件；
- 已完成项；
- 未完成项；
- 已知风险；
- 最近失败尝试；
- 用户偏好 / 禁止事项；
- 建议下一步。

#### 建议类型

```ts
interface SessionMemoryRecord {
  sessionID: string
  version: number
  lastMessageID: string
  objective: string
  constraints: string[]
  workset: string[]
  completed: string[]
  pending: string[]
  risks: string[]
  recentFailures: string[]
  nextSteps: string[]
  updatedAt: number
}
```

### 9.6 `src/session/memory-store.ts`

负责 Session Memory 的持久化与读取缓存。建议不要直接把所有 memory 常驻到 system prompt，而是按需 recall。

### 9.7 `src/session/micro-compaction.ts`

作为 prune 与 full compaction 之间的轻量中间层。

#### 适用场景

- 连续多次 `read` 结果；
- 连续多次 `grep` / code search 结果；
- 长 bash 错误输出；
- 多个 explore 子任务的中间结果；
- 一次大范围调研后的碎片化发现。

#### 处理策略

- 不做整段历史摘要；
- 只对局部高噪声块做折叠；
- 输出结构化“局部调查结论”；
- 保留路径、函数名、关键错误、最终结论。

### 9.8 `src/session/post-compaction.ts`

对应 Claude Code Rebuilt 的 post-compact cleanup。

#### 责任

compact 后统一：

- 清理 context-governor cache；
- 清理 tool-budget 统计缓存；
- 清理 session memory recall cache；
- 重建 system sections 缓存；
- 刷新 workset snapshot；
- 更新 compaction boundary metadata；
- 记录 compact event metrics。

---

## 10. 对现有 OpenCode 文件的具体改造建议

### 10.1 `src/session/prompt.ts`

这是最关键的接入点之一。

#### 建议新增流程

在真正调用模型前插入：

1. `contextGovernor.prepare()`；
2. 获取处理后的 `system` / `messages` / recall / summary；
3. 必要时触发 `microCompaction` 或 `createCompaction`；
4. 将治理元信息写入消息 metadata。

#### 建议新增能力

- 将 compaction 不再视为仅由 overflow 驱动；
- 支持 recall 的 session memory 注入；
- 支持 workset 提示；
- 支持 tool-budget 后的结构化 digest 注入；
- 在 compaction 后调用 `postCompaction.cleanup()`。

### 10.2 `src/session/processor.ts`

#### 建议增强

- 除 `needsCompaction` 外，新增：
  - `needsMicroCompaction`
  - `needsMemoryExtraction`
  - `needsRecallRefresh`
- 在 tool call 完成后向 `contextGovernor.afterToolResult()` 上报；
- 在 assistant turn 结束后由 `contextGovernor.afterAssistantTurn()` 生成治理信号。

### 10.3 `src/session/compaction.ts`

#### 建议增强

- 把 `select()` / `prune()` / `process()` / `create()` 明确拆成两类：
  - full compaction；
  - pre-compaction transforms。
- 接收 `workset`、`session memory`、`tool digests` 等额外输入；
- 允许 compaction 输出结构化 metadata；
- 在 compaction summary 中保留：
  - objective；
  - constraints；
  - key files；
  - completed / pending；
  - latest risk；
  - next step。

### 10.4 `src/session/overflow.ts`

#### 建议增强

在当前 `usable()` / `isOverflow()` 基础上新增：

- warning 状态；
- critical 状态；
- effective usable window；
- per-asset 预算报告；
- compact retry safety margin。

也就是说，它不应只返回“是否溢出”，还应返回“距离下一层治理阈值还剩多少”。

### 10.5 `src/session/system.ts`

#### 建议增强

- 将 system sections 结构化；
- 明确区分 stable sections 与 dynamic sections；
- 为 recall / workset / memory summary 提供插槽；
- 支持 compact 后重建。

### 10.6 `src/config/config.ts`

建议扩展 `compaction` 配置，形成更完整的治理策略面板。

#### 建议新增配置

```ts
compaction: {
  auto?: boolean
  prune?: boolean
  tail_turns?: number
  preserve_recent_tokens?: number
  reserved?: number
  warning_ratio?: number
  critical_ratio?: number
  tool_budget?: {
    enabled?: boolean
    max_total_tokens?: number
    max_per_tool?: Record<string, number>
  }
  micro?: {
    enabled?: boolean
    min_reducible_tokens?: number
  }
  memory?: {
    enabled?: boolean
    init_threshold_tokens?: number
    update_threshold_tokens?: number
    recall_max_tokens?: number
  }
  cleanup?: {
    clear_system_cache?: boolean
    clear_memory_cache?: boolean
    refresh_workset?: boolean
  }
}
```

### 10.7 `src/agent/prompt/compaction.txt`

应将当前 compaction prompt 升级为“工作连续性摘要协议”，建议固定输出：

- 当前任务目标；
- 已确认约束；
- 关键文件与职责；
- 已完成工作；
- 待完成工作；
- 最近错误 / 风险；
- 推荐下一步。

必要时可考虑增加 machine-readable 小节，便于后续解析。

### 10.8 `src/session/summary.ts`

当前更多服务于 session diff / summarize 展示。建议与 session memory 建立关联，使其可为 memory extract 提供基础材料，但不要让其承担全部 context governance 职责。

---

## 11. OpenCode 上下文治理的目标流程设计

### 11.1 请求前 Preflight 流程

每轮调用模型前执行：

1. 收集上下文资产统计；
2. 计算 effective usable window；
3. 统计旧 tool outputs 占比；
4. 更新 / 读取 workset；
5. 判断是否需要 session memory recall；
6. 若工具输出过多，则先做 tool budget digest；
7. 若仍过大，则尝试 micro-compaction；
8. 若仍接近阈值，则触发 full compaction；
9. 生成最终 system + messages + recalls。

### 11.2 Tool Result 生命周期

建议将工具结果划分为三种状态：

- `fresh`：刚产生，完整保留；
- `digestible`：较旧，可转为结构化 digest；
- `archived`：已进入 session memory / summary，不再需要原文常驻。

### 11.3 Session Memory 生命周期

建议包括：

- `initialize`：达到初始 token / tool 阈值后首次提取；
- `update`：达到增量阈值后更新；
- `recall`：preflight 判断当前任务需要时注入；
- `compact-assist`：full compaction 前后作为补充上下文；
- `cleanup`：在 session clear / branch cut / compaction boundary 后刷新元信息。

### 11.4 Full Compaction 触发条件

建议不是单一布尔条件，而是组合条件：

- 超过 critical ratio；
- micro-compaction 后仍不足；
- 当前消息包含大量高噪声工具资产；
- 当前会话已存在 session memory 可承接慢变状态；
- 本轮 compact 后可保证继续执行至少一到两轮。

---

## 12. 建议的摘要与记忆输出格式

### 12.1 Full Compaction Summary 建议格式

```markdown
## Objective
- ...

## Confirmed Constraints
- ...

## Key Files
- path: role / status

## Completed Work
- ...

## Pending Work
- ...

## Recent Failures or Risks
- ...

## Working Set
- ...

## Recommended Next Step
- ...
```

### 12.2 Session Memory 建议格式

```markdown
## Session Objective

## Stable Constraints

## Working Set

## Decisions Made

## Verified Facts

## Pending Tasks

## Failure Notes

## Continue From Here
```

注意：

- compact summary 关注“替代历史”；
- session memory 关注“保留慢变状态”；
- 两者不可混为一个文件或一个职责。

---

## 13. 分阶段实施路线图

### Phase 1：补齐观测与治理编排层

#### 目标

- 引入 `context-governor.ts`；
- 引入 context asset 统计；
- 为现有流程增加 per-asset token 观测；
- 不改变现有 compaction 行为，只加治理入口。

#### 产出

- 可观测每轮消息、工具结果、system sections 的 token 组成；
- 可判断真正的主要膨胀源。

### Phase 2：引入 Tool Budget 层

#### 目标

- 在 full compaction 之前先治理旧工具结果；
- 减少长任务中的高噪声常驻内容。

#### 产出

- `tool-budget.ts`；
- 工具元数据扩展；
- digest 结构。

### Phase 3：引入 Session Memory

#### 目标

- 构建慢变状态旁路；
- 让长任务不完全依赖消息历史。

#### 产出

- `session-memory.ts`
- `memory-store.ts`
- `memory_prompt.txt`
- recall 逻辑。

### Phase 4：引入 Micro-Compaction

#### 目标

- 在 prune 与 full compaction 之间增加更轻量治理层；
- 降低 full compaction 频率。

### Phase 5：补齐 Post-Compaction Cleanup

#### 目标

- 统一处理 compact 后缓存与状态一致性；
- 保证 compact 真正成为一个完整状态转移。

### Phase 6：升级 compact prompt 与工作连续性结构

#### 目标

- 把 compaction 从“摘要历史”升级为“构建继续工作的上下文包”。

---

## 14. 风险与设计约束

### 14.1 不要把所有逻辑都做成 system prompt 规则

很多上下文治理问题本质上是数据流问题，而不是 prompt engineering 问题。应优先用结构化状态和显式服务解决。

### 14.2 不要让 session memory 常驻注入

如果 memory 每轮都塞回 system prompt，会重新制造膨胀问题。正确做法是：

- 按需 recall；
- 限制 recall token；
- 只注入 relevant sections。

### 14.3 不要让 micro-compaction 与 full compaction 的职责重叠

- micro：局部折叠；
- full：全局历史重建。

### 14.4 不要忽视 compact 后缓存清理

这是很多系统长期漂移、不稳定、重复注入、状态错乱的来源。

---

## 15. 建议的验证与评测指标

为确保改造不是“感觉更聪明”，建议建立至少以下指标：

- 单任务总 token 消耗；
- 平均每轮输入 token；
- 旧工具输出占比；
- full compaction 次数；
- micro-compaction 次数；
- compact 后继续成功率；
- 长任务中断率；
- 任务完成轮次；
- recall 命中率；
- session memory 复用收益；
- 工作集保活率；
- 用户纠正次数。

---

## 16. 文件级落地方案总表

### 16.1 建议新增文件

- `opencode/packages/opencode/src/session/context-governor.ts`
- `opencode/packages/opencode/src/session/context-assets.ts`
- `opencode/packages/opencode/src/session/tool-budget.ts`
- `opencode/packages/opencode/src/session/workset.ts`
- `opencode/packages/opencode/src/session/session-memory.ts`
- `opencode/packages/opencode/src/session/memory-store.ts`
- `opencode/packages/opencode/src/session/micro-compaction.ts`
- `opencode/packages/opencode/src/session/post-compaction.ts`
- `opencode/packages/opencode/src/session/prompt/memory.txt`

### 16.2 建议重点修改文件

- `opencode/packages/opencode/src/session/prompt.ts`
- `opencode/packages/opencode/src/session/processor.ts`
- `opencode/packages/opencode/src/session/compaction.ts`
- `opencode/packages/opencode/src/session/overflow.ts`
- `opencode/packages/opencode/src/session/system.ts`
- `opencode/packages/opencode/src/config/config.ts`
- `opencode/packages/opencode/src/agent/prompt/compaction.txt`
- `opencode/packages/opencode/src/session/summary.ts`

### 16.3 接入顺序建议

1. `context-governor`
2. `context-assets`
3. `tool-budget`
4. `workset`
5. `session-memory`
6. `micro-compaction`
7. `post-compaction`
8. `compaction prompt` 升级
9. `config` 扩展

---

## 17. 最终结论

Claude Code Rebuilt 真正值得学习的，不是某个具体 compact 函数，而是它把上下文管理设计成了一个完整的治理系统：

- 上下文注入分层；
- 预算阈值前置；
- 轻量减载优先；
- full compact 兜底；
- session memory 旁路承载慢变状态；
- compact 后统一做状态清理与恢复。

OpenCode 当前已经拥有良好的基础骨架：

- system prompt 注入独立；
- overflow 使用 usable window；
- prune old tool outputs；
- 隐藏 compaction agent；
- prompt 主循环可触发自动 compaction。

因此，对 OpenCode 最正确的演进路线不是推翻现有结构，而是：

> 在现有 `session/prompt.ts + processor.ts + compaction.ts + overflow.ts` 的骨架上，补齐 context governor、tool budget、workset、session memory、micro-compaction、post-compaction cleanup 六大能力，把当前“接近溢出才压缩”的模式，升级为“每轮前后持续治理 + 分层压缩 + 记忆旁路 + 状态恢复”的完整上下文治理体系。

如果按本文方案实施，OpenCode 将从当前的“两层半上下文治理”升级到真正的“五层治理链”，并具备以下能力：

- 长任务更稳；
- 历史工具噪声更低；
- compact 频率下降；
- 任务连续性更强；
- 结构更清晰；
- 后续评测与优化更容易量化。

这也是把 Claude Code Rebuilt 的高回报思想，真正转化为 OpenCode 可落地工程能力的最佳方式。

---

## 18. 一句话执行建议

如果下一步要真正开始改代码，建议按以下优先级推进：

1. 先做 `context-governor + tool-budget`；
2. 再做 `session-memory + workset`；
3. 然后补 `micro-compaction + post-compaction cleanup`；
4. 最后升级 `compaction prompt + config + metrics`。

这个顺序能在最小破坏下，最快获得最大的上下文治理收益。
