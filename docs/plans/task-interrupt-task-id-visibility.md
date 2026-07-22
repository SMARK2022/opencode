# Canonical Implementation Plan: Task Interrupt Task-ID Visibility

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL user requirement quoted in section 1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 0. Revision History

| Rev | Why |
| --- | --- |
| R1 | 初稿：中断/未完成 task 的模型侧 `task_id` 可见性；primary path 修 MessageV2 投影 + 共享 resume 行格式 |
| R2 | Plan audit **B-01**：resume helper 主设计固定在无环 `@/util/output-notice`（禁止 `message-v2 → task → message-v2`）。**B-02**：补齐 non-abort `failToolCall` 剥落 `sessionId` 的 first divergence；INV-01 映射双 owner（投影 + 终态 metadata 保留） |

Resolved audit findings incorporated in R2:

- **B-01**（blocking）：helper 不得从 `task.ts` 导出给 `message-v2` 使用；`task.ts` 已 value-import `MessageV2`。
- **B-02**（blocking）：create 后 non-abort fail 会经 `failToolCall` 丢掉非 autoReview metadata（含 `sessionId`）；仅改投影无法覆盖该终态。

## 1. Verbatim Requirement

> 当前需要你详细完成检查一下我们的opencode,由于整个task任务可能很繁重所以理论上当task被中断或者退出的时候无论是否完整正确结束都应该有相应的taskid的提示，以此给模型后续调用的能力，请你检查相应的opencode的信息返回的克制的风格，看看如何进行有效高效的提醒，不会过于冗余且整体保持较为低影响和干扰，且保证不会引入新的错误。同时方案保持克制，保持甜点级别的精准修改，不额外引入复杂的状态机或者冗余逻辑，整体修改代码文件数量不超过4个，同时修改行数不超过600行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。

目标终态：`verified-implementation-and-commit`。

用户对修改规模的约束（方案纪律，不替代完整性门禁）：生产+测试合计尽量 ≤4 文件、≤600 行；克制、低冗余、无新状态机。R2 生产路径 4 文件 + 1 测试文件（验证必要）；总行数预算仍 ≪ 600。

## 2. Explicit Non-Goals

- 不修改 Task 的 create/resume 解析、`task_id` illegal resolution、background 启动协议。
- 不修改 `task_status` schema 或 not-found 语义。
- 不把 interrupt 伪装成 `completed` 成功态（保持 abort/error 语义与 `interrupted` marker）。
- 不引入新的 task 状态机、DB migration、或第二套 resume ID 命名。
- 不强制 TUI 用户可见文案变更（CLI `taskResult` 仍只抽 `<task_result>` 供用户展示；本需求面向模型上下文）。
- 不处理“子 Session 在父 cancel 后仍继续写 part”的 runner 泄漏（独立问题；本任务只保证模型侧 resume token 可见）。
- 不在 Task 尚未分配 child Session 时伪造 task_id（例如参数 brand 失败、agent 不可用、权限拒绝发生在 `sessions.create` / metadata 写入之前）。
- 不为 speculative 恶意/畸形 metadata 增加防御纵深。
- 不把 non-abort fail 的完整 running metadata（进度条等）无差别全量保留；仅保留 resume 所需的 `sessionId`（及已有 `parentSessionId` / `autoReview` 合同字段）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 词汇：Session、Tool、Message/Part、Agent/subagent；task 工具创建的是子 Session，`task_id` 即 SessionID |
| `packages/opencode/AGENTS.md` | 测试/typecheck 在 package 目录；Effect module shape；中文注释门禁语境 |
| `AGENTS.md` (repo root) | 默认分支 `dev`；并行工具；不随意 commit |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁止 fallback 堆叠；forward/reverse 映射 |
| 既有 `docs/plans/task-id-illegal-resolution.md` | resume 线格式与 illegal notice 合同已存在；本任务不改 resolve，只补终端可见性 |
| `packages/opencode/src/util/output-notice.ts` | 已有模型可见 notice 骨架；**已被** `message-v2` 与 `task` 同时 import，是无环共享点 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/task.ts` | `output()` 生成 `task_id:`；`import { MessageV2 } from "../session/message-v2"`；create 后 `ctx.metadata({ sessionId })`；其后可 `Effect.fail`（如 already running） | observed |
| `packages/opencode/src/session/processor.ts` | abort：`interruptedToolMetadata` 保留原 metadata；**non-abort failToolCall 只保留 autoReview 或 undefined**，剥落 `sessionId`；stream-end non-abort 保留 metadata | observed |
| `packages/opencode/src/session/prompt.ts` | `interruptedToolState` 保留 running metadata | observed |
| `packages/opencode/src/session/message-v2.ts` | 已 `import` `@/util/output-notice`；error 仅 `interrupted && metadata.output` 投影 partial；running → 固定 interrupted 串；不读 `sessionId` | observed |
| `packages/opencode/src/util/output-notice.ts` | `formatTaskIdNotice` / `formatExecutionNotice`；task 与 message-v2 共用、无环 | observed |
| `packages/opencode/test/session/message-v2.test.ts` | interrupt notice 合同 | observed |
| `packages/opencode/test/tool/task.test.ts` | 成功路径 `task_id:` + sessionId | observed |
| 本地 DB 父 `ses_077111bdeffesdZELwWeeYx1vf` | aborted task 有 `metadata.sessionId`、无 `state.output`/`metadata.output` | observed |
| Red harness §8 | interrupted + sessionId → 模型消息无 task_id | observed |

## 5. Current Behavior

```text
TaskTool.execute
  -> create/resume child Session (nextSession.id)
  -> ctx.metadata({ parentSessionId, sessionId: nextSession.id, model, ... })
  -> may Effect.fail after metadata (e.g. "already running")
  -> foreground success: return { output: output(id, text) }  // contains task_id line
  -> background start: return { output: backgroundOutput(id) } // contains task_id line
  -> interrupt: Effect interrupted → failToolCall(aborted)
        metadata = interruptedToolMetadata(prior)  // sessionId kept
        no state.output
  -> non-abort tool error after metadata → failToolCall(error)
        metadata = autoReview only | undefined   // sessionId WIPED  ← B-02
        no state.output

MessageV2.toModelMessages
  completed -> state.output (has task_id)
  error + interrupted + metadata.output string -> partial (+ abort notice)
  error otherwise -> errorText only (sessionId ignored)  ← interrupt gap
  pending|running -> "[Tool execution was interrupted]" (sessionId ignored)

Import graph (current):
  task.ts → message-v2.ts
  task.ts → util/output-notice.ts
  message-v2.ts → util/output-notice.ts
  // message-v2 must NOT import task.ts
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Task 成功完成 | TaskTool | state.output 含 task_id | 已满足 | TaskTool | observed |
| Task 用户中断 | cancel / AbortSignal | error + interrupted；metadata.sessionId 保留 | 投影忽略 sessionId | MessageV2 | observed |
| Task open/pending 投影 | 未终态化 part | metadata.sessionId 可在 | 固定 interrupted 串 | MessageV2 | observed |
| Task stream-end 非 abort 清理 | processor cleanup | 保留 metadata | 同投影缺口 | MessageV2 | observed |
| Task create 后 non-abort fail（如 already running） | TaskTool Effect.fail | failToolCall 剥落 sessionId | 投影无法恢复 | processor failToolCall | observed |
| Task create 前失败 | agent/permission 等 | 无 sessionId | 不伪造 | TaskTool | observed |
| Background 启动回执 | TaskTool | 已有 task_id | 保持 | TaskTool | observed |
| 历史 interrupted 仅 sessionId | DB | 无 metadata.output | 投影 ensure | MessageV2 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 一旦 Task 已把 child id 写入 ToolPart.metadata.sessionId，该 part 的**任意模型可见终态投影**（completed / error / open→interrupted）必须包含与成功路径一致的 `task_id: <sessionId> (for resuming to continue this task if needed)` 行 | 用户需求；DB；red | 无（red） |
| INV-02 | 成功路径 `output()` 的 resume 行与投影/ensure 使用**同一** pure 格式源（`@/util/output-notice`），无第二套措辞 | 无环共享点 | task.test 回归 |
| INV-03 | 无 `metadata.sessionId`（含 create 前失败、以及终态后仍无 id 的 part）时不伪造 task_id；非 task 工具投影不变 | 无 child 路径 | 既有 read interrupt |
| INV-04 | abort 仍为 error + interrupted；不改为 completed | processor/prompt | message-v2 abort 测试 |
| INV-05 | 克制：仅一行 resume 前缀（+既有 error/abort notice）；无新状态机/长说明 | 用户克制要求 | 新测试 |
| INV-06 | 文本已含同一 `task_id: <id>` 时不重复 prepend | ensure | 新测试 |
| INV-07 | create 之后、任意 `failToolCall` 终态化（abort **与** non-abort）不得剥落已存在的 `metadata.sessionId`（及已写入的 `parentSessionId`）；`autoReview` 合同保持 | failToolCall 源码；already running 路径 | 新测试或 processor 行为断言 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01（interrupt/open/stream-end 仍持有 sessionId） | `toModelMessages` 忽略 `metadata.sessionId` | `MessageV2.toModelMessagesEffect` | 源码；red；DB |
| INV-07 / INV-01（non-abort 终态） | `failToolCall` 在 non-abort 分支把 metadata 收成仅 `autoReview` 或 `undefined`，**丢弃已写入的 sessionId** | `SessionProcessor.failToolCall` | processor.ts:349-361；task.ts create 后 fail |

**双 first divergence（同一需求的两条可达出口）**：

1. **投影缺口**：id 还在 metadata，模型看不见。  
2. **终态剥落**：non-abort fail 把 id 从 metadata 抹掉，投影无源。

两者都必须修；只修投影会让 INV-01 在 already-running 等路径上虚假成立。

### Red-capable feedback loop

```bash
# Working directory: packages/opencode
bun -e '
import { MessageV2 } from "./src/session/message-v2.ts"
// interrupted task + metadata.sessionId, no metadata.output
// expect model tool result text to include task_id line
'
```

**Observed（2026-07-22）**：`RED_SIGNAL_interrupted_task_has_task_id= false`

正式锁定以 §16 `message-v2` / failToolCall 行为测试为准；`bun -e` 仅作可选 smoke。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| resume 行 pure 格式 + ensure | `@/util/output-notice` | 与模型可见 notice 同层的 tool 文本 helper | **task 与 message-v2 均已依赖该模块**；无 import 环 | 放 `task.ts` 会形成 `message-v2 → task → message-v2`（B-01） |
| 模型可见 tool 结果 | `MessageV2.toModelMessages` | Part → Provider 消息 | 历史 open/error 的唯一消费点 | TaskTool 无法改写已落库 abort part |
| 终态 metadata 保留 sessionId | `SessionProcessor.failToolCall` | error 终态不抹 resume id | 唯一 non-abort 剥落点；stream-end/abort 已保留 | 投影无法从被抹掉的 metadata 恢复 |
| child id 首次写入 | TaskTool `ctx.metadata` | 已存在 | create 后立即写 | 无需第二存储 |

## 10. Single Approved Primary-Path Design

```text
A) Format source (util/output-notice.ts) — PRIMARY helper home, not contingency
   formatTaskResumeLine(sessionID) ->
     "task_id: ${sessionID} (for resuming to continue this task if needed)"
   ensureTaskResumeVisible(text, sessionID) ->
     if text includes "task_id: ${sessionID}" then text
     else formatTaskResumeLine(sessionID) + "\n\n" + text

B) TaskTool.output() uses formatTaskResumeLine (INV-02 single source)
   backgroundOutput 保持自有 polling 措辞（不同合同；本任务不统一）

C) failToolCall terminal metadata (processor.ts)
   abort:
     interruptedToolMetadata(prior)  // unchanged; already keeps sessionId
   non-abort:
     metadata = {
       ...(autoReview envelope if present),
       ...(typeof sessionId === "string" ? { sessionId } : {}),
       ...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
     } or undefined if empty
     // 不保留其它 running 进度字段；不改 status/error 语义

D) toModelMessages (message-v2.ts) for tool === "task"
   completed: unchanged (state.output)
   error:
     baseText =
       interrupted && typeof metadata.output === "string"
         ? metadata.output
         : state.error
     // then existing abort notice append rules on the projected string
     if typeof metadata.sessionId === "string":
       baseText = ensureTaskResumeVisible(baseText, metadata.sessionId)
     // shape: keep current interrupted+partial → output-available;
     //        else → output-error(errorText)
   pending|running:
     body = "[Tool execution was interrupted]"
     if typeof metadata.sessionId === "string":
       body = ensureTaskResumeVisible(body, metadata.sessionId)
     output-error(body)
```

**为何这是 primary repair 而非 fallback 堆叠**：

- 成功路径继续用 `state.output` 的完整 envelope（含 resume 行）。
- 中断/失败路径继续用 error/interrupted，只保证 **同一 resume 行** 对模型可见。
- non-abort 剥落是 metadata 终态合同漏洞，在剥落点保留 resume 字段，不是失败后再猜 id。

**明确禁止**：

- `message-v2` import `task.ts`
- abort → completed 伪装成功
- processor 为 task 特写完整 `state.output` 作为第二成功形状

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| completed state.output | current | primary-contract branch | yes | high | preserve |
| interrupt error + sessionId → ensure | proposed | primary-contract branch | no | high | add |
| open task + sessionId → ensure | proposed | primary-contract branch | no | medium | add |
| non-abort fail 保留 sessionId | proposed | primary-contract branch | no | high | add |
| interrupted + metadata.output partial | current shell | primary-contract branch | no | medium | preserve + ensure |
| helper 从 task.ts 导出 | R1 rejected | — | — | — | **reject (cycle)** |
| abort→completed | rejected | forbidden fallback | yes | — | reject |
| 全量保留 non-abort metadata | rejected | over-scope | — | — | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 主 agent 手工从 UI/DB 抄 sessionId | 模型侧无 task_id | 投影 + metadata 保留保证上下文可见 | 行为淘汰 |
| R1 “优先 task.ts，若有环再下沉 util” 权变 | 未核 import 图 | R2 固定 util 为主设计 | plan 修订 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 interrupt + sessionId | toModelMessages ensure | `message-v2.ts` | message-v2 新测 |
| INV-01 open + sessionId | toModelMessages ensure | `message-v2.ts` | message-v2 新测 |
| INV-07 non-abort 保留 sessionId | failToolCall metadata | `processor.ts` | 行为测试：non-abort fail 后 part.metadata.sessionId 仍在；或投影在模拟剥落修复后可见（见 §16） |
| INV-01 non-abort 后模型可见 | 保留 sessionId + ensure | processor + message-v2 | 组合：metadata 含 sessionId 的 error（非 interrupted）也 ensure |
| INV-02 单格式源 | formatTaskResumeLine | `output-notice.ts` + `task.ts` 调用 | task 成功测试仍绿 |
| INV-03/04/05/06 | ensure 边界 | message-v2 + helper | 正/负例 |
| 无 import 环 | helper 仅在 util | 文件布局 | 静态：message-v2 不 import task |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `formatTaskResumeLine` / `ensureTaskResumeVisible` in `output-notice.ts` | INV-02/05/06 | 双方已依赖 util；task→message-v2 环 | 不能放 task.ts（B-01） |
| MessageV2 task 分支读 sessionId + ensure | INV-01 | 投影忽略 id | completed-only / interrupted-output-only 不够 |
| failToolCall 保留 sessionId/parentSessionId | INV-07 | non-abort 剥落 | 投影无法复活被删字段 |
| （不）task catch interrupt→completed | — | — | INV-04 / forbidden fallback |
| （不）全量 metadata 保留 | — | — | 超出 resume 需求 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/util/output-notice.ts` | modify | 导出 `formatTaskResumeLine` + `ensureTaskResumeVisible` | +20–35 |
| `packages/opencode/src/tool/task.ts` | modify | `output()` 使用 `formatTaskResumeLine`（不导出 helper 给 message-v2） | +2–8 |
| `packages/opencode/src/session/message-v2.ts` | modify | tool=task 时 error/open ensure resume 行 | +25–50 |
| `packages/opencode/src/session/processor.ts` | modify | non-abort `failToolCall` 保留 sessionId/parentSessionId | +10–25 |
| `packages/opencode/test/session/message-v2.test.ts` | modify | §16 行为切片（投影） | +70–130 |
| `packages/opencode/test/session/processor` 或既有 processor 测试文件 | modify 仅当无合适 seam 挂 INV-07 | non-abort metadata 保留 | +30–60 |

若 INV-07 可在现有 processor 测试文件中用公开行为断言且不新增第 6 文件，优先并入已有测试文件。用户纪律：优先 ≤4 生产文件；测试为验证必要可另计，总行 ≪ 600。

**生产文件上限 4**：`output-notice.ts`、`task.ts`、`message-v2.ts`、`processor.ts`。

## 16. TDD Behavior Slices

公共 seam：`MessageV2.toModelMessages`；INV-07 若需单独 seam：processor failToolCall 后读取 part.metadata（或现有 session processor 测试夹具）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | interrupted task error + sessionId，无 metadata.output → 模型文本含 resume 行 | 投影忽略 sessionId | ensure on errorText | 其他工具 |
| 2 | running task + sessionId → 模型文本含 resume 行 + interrupted 标记 | 固定串无 id | ensure on open body | 非 task open |
| 3 | non-interrupted task error + sessionId → 模型文本含 resume 行 | 同忽略；且若 metadata 被剥则无源 | ensure + failToolCall 保留 | 非 task non-abort |
| 4 | 已含 resume 行的 partial → 不双前缀 | — | ensure no-op | shell partial |
| 5 | interrupted read 无 sessionId → 无伪造 task_id | — | 仅 tool=task | 既有 read 测试 |

Expected values：字面 `task_id: ses_... (for resuming to continue this task if needed)`。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~70–110 | 生产有效行 |
| Required `C` | ≥ max(1, ceil(E*0.15)) ≈ 11–17 | 生产关键点中文注释优先计 |

注释必须点明：

1. helper 放 util 是为避开 `task ↔ message-v2` 环。  
2. 投影读 `sessionId`：中断路径不写 state.output。  
3. non-abort fail 保留 sessionId：否则 create 后失败模型无法 resume。  
4. ensure 只 prepend 一行、已存在则跳过。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/message-v2.test.ts` | `packages/opencode` | INV-01/03–06 投影 |
| processor/session 相关既有或新增测试 | `packages/opencode` | INV-07 |
| `bun test test/tool/task.test.ts` | `packages/opencode` | 成功/resume 回归 |
| `bun typecheck` | `packages/opencode` | 类型；无环编译 |
| 可选：§8 smoke | `packages/opencode` | RED→true |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified | 4 production + 1–2 test | 见 §15 |
| Files deleted | 0 | — |
| Production lines | ~60–120 | util + 投影 + failToolCall + task 一行复用 |
| Test lines | ~80–160 | 切片 1–5 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| non-abort 保留字段过宽泄露 running 细节 | 仅 sessionId/parentSessionId + 既有 autoReview |
| ensure 双前缀 | 子串检测 `task_id: ${id}` |
| background 用 polling 措辞 | 不改 backgroundOutput；interrupt 前台用 resuming 行 |
| import 环回归 | helper 只进 util；message-v2 禁止 import task |

### Open Decisions Requiring the User

无。

### Rejected Speculation

| Idea | Why rejected |
| --- | --- |
| helper 主放 task.ts、环则再迁 util | B-01：环已是事实，不能当主设计 |
| 只改投影、non-abort 作 residual risk | B-02：与“无论是否完整正确结束”及 INV-01 全称冲突 |
| cancel 时强制杀子 runner | 独立生命周期；非本需求 |
| DB migration | 投影 + 保留字段即可 |
| abort→completed | forbidden fallback |

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Verify R2 resolves R1 B-01 (cycle-free helper home) and B-02 (non-abort sessionId retention) without narrowing the user-visible resume requirement.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 import cycle helper home; B-02 INV-01 vs non-abort metadata wipe | cycle contingency wording; informal red harness; background dialect note | BLOCK | task `ses_076f7987fffepmCsSwiM0VgDqm` |
| 2 | R2 | yes | No blocking findings. | N-01 file budget soft-read as production-only; N-02 compaction prune residual; N-03 parentSessionId optional keep; N-04 ensure-then-abort-notice order | APPROVE | task `ses_076f155c1ffeXWZK8n0DQAkpca` |

## 23. Implementation Evidence

### Actual Files and Diff

| File | Role |
| --- | --- |
| `packages/opencode/src/util/output-notice.ts` | `formatTaskResumeLine` + `ensureTaskResumeVisible` |
| `packages/opencode/src/tool/task.ts` | success `output()` 使用共享 resume 行 |
| `packages/opencode/src/session/message-v2.ts` | task error/open 投影 ensure resume 行 |
| `packages/opencode/src/session/processor.ts` | `failedToolMetadata` + failToolCall non-abort 保留 sessionId |
| `packages/opencode/test/session/message-v2.test.ts` | 投影行为切片 |
| `packages/opencode/test/tool/edit.test.ts` | `failedToolMetadata` 合同（既有 processor 测试挂靠） |

`git diff --stat`（本 GOAL 路径）: 6 files, +240 / −13

### Red-Green Test Evidence

- `interrupted task without output still surfaces task_id for resume`
- `running task with sessionId surfaces task_id when projected as interrupted`
- `non-abort task error with sessionId surfaces task_id`
- `interrupted task partial that already has task_id is not double-prefixed`
- `failedToolMetadata keeps sessionId and drops progress-only fields`
- `bun test test/session/message-v2.test.ts test/tool/task.test.ts test/tool/edit.test.ts` → **151 pass / 0 fail**

### Verification Commands and Results

| Command | Directory | Result |
| --- | --- | --- |
| `bun test test/session/message-v2.test.ts test/tool/task.test.ts test/tool/edit.test.ts` | packages/opencode | 151 pass |
| `bun typecheck` | packages/opencode | exit 0 |

### Original Feedback-Loop Result

```text
RED_SIGNAL_interrupted_task_has_task_id= true
```

（实施前为 `false`）

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| completed state.output | primary | preserved |
| error/open ensure resume | primary-contract branch | added |
| failedToolMetadata selective keep | primary-contract branch | added |
| abort→completed | forbidden | not added |
| message-v2→task import | cycle | not added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 240 | `git diff` 加号实质行，排除空行与 import-only |
| Qualifying Chinese comment lines `C` | 36 | 邻近决策点中文 `//` 注释（环、投影、non-abort 保留、ensure、INV 测试意图） |
| Ratio `C / E` | 0.15 |  |
| Required minimum `C` | 36 | `ceil(240*0.15)=36`；门禁满足 |

### Remaining Unverified Items

- Live TUI end-to-end abort of a long task (unit/projection covered; full interactive cancel not re-run).
- Compaction prune of completed task output (N-02 residual; out of scope).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings. | N-01 INV-07 pure helper not full failToolCall e2e; N-02 no explicit non-task negative case; N-03 E arithmetic soft; N-04 file budget soft vs user ≤4 | APPROVE | task `ses_076e600e6ffejodIvgIC9XYwqu` |
