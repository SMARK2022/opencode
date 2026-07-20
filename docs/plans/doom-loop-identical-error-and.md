# Canonical Implementation Plan: Doom Loop AND (identical input + consecutive errors)

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 用户原文（见 §1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 0. Revision History

| Rev | Change |
| --- | --- |
| R1 | 初稿：tool-error AND 窗口；删 OR 双路径；**错误地**假设「当前 message + 单个 previous assistant tool tail」足以覆盖跨 step 1+1+1 |
| R2 | 关闭 B-01：MessageV2 提供**跨多个前序 assistant**的有界 tool tail 查询；processor 仅用 transcript 单源做 AND；测试强制 1-tool-per-step × 3 |

## 1. Verbatim Requirement

> 其实我当前完全想了一下,因为对于目前而言,三个同样的调用其实还是挺常见的,譬如说它要执行完全同样的任务等等内容。与此同时,连续失败,同一工具跨相应的turn累积三次error,这个也很容易实现。譬如说,某一些文件突然被删掉了,那么可能模型尝试了三次去读取不同的文件,那么大概率会出现问题。所以请你看看能不能把这两个结合一下,也就是相同输入并且连续失败的死循环,也就是最近三次脱扣都是同工具,而且同JSON,而且都是错误的,那么它再去进行相应的拦截以及相应的提醒。而其他的,譬如说只是相同输入的,或者说只是相应的连续失败的,这些都不进行相应抓,也就是相应的OR改成AND这么一个逻辑。这样的话,我们可以移除掉部分其他的冗余逻辑,然后把当前的逻辑做得更加精巧,做得更加准确,然后可以对其进行相应的优化。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不修改 Permission 服务语义（`ask` / `reply` / `once|always|reject` / ruleset 求值）。
- 不修改 doom_loop 默认 action（仍为 agent 默认 `ask`，可被 config 覆盖）。
- 不修改 TUI/Web/ACP/run 的 permission UI 框架；仅在文案与当前语义不一致且本任务触及展示面时做最小文案同步。
- 不引入新的 permission 名称、配置键或 SDK 字段。
- 不处理 permission UI「Enter 无反应」类交互缺陷（独立问题）。
- 不改变其它工具 permission（bash/edit/read 等）的 ask 路径。
- 不恢复 OR 双检测器，也不保留「仅同 tool 名计数」的 `consecutiveErrorMap` 语义。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Permission / Session / Tool / Message 词汇；doom_loop 经 `permission.ask` 升级 |
| `packages/opencode/AGENTS.md` | Effect 形态；测试与 typecheck 在 package 目录 |
| `packages/opencode/test/AGENTS.md` | `it.live` / `provideTmpdirServer` |
| `packages/opencode/src/session/prompt.ts` | **每个 step 新建 assistant message** 并 `processor.create`/`process`（跨 turn 1+1+1 的真实 producer） |
| `packages/opencode/src/agent/agent.ts` | 默认 `doom_loop: "ask"` |
| `packages/opencode/src/config/permission.ts` | `doom_loop` 配置键 |
| 无专门 ADR | 行为以 processor + tests 为准 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/processor.ts` | OR 双路径：`tool-call` 相同输入；`tool-error` consecutiveErrorMap；`DOOM_LOOP_THRESHOLD=3` | observed |
| `packages/opencode/src/session/message-v2.ts` (`previousAssistantToolTail`) | 仅 **一个** 前序 assistant（SQL `.limit(1)`）+ 其 tool tail | observed |
| `packages/opencode/src/session/prompt.ts` (~每 step 新 assistant) | 生产死循环 turn 形状 1 tool / step | observed |
| `packages/opencode/src/permission/index.ts` | ask/reply 契约 | contracted |
| `packages/opencode/test/session/processor-effect.test.ts` | 并行不触发；跨 turn 不同 input 现触发 | observed |
| `packages/opencode/test/session/messages-pagination.test.ts` | tail 边界、hidden、cold thaw | observed |
| R1 plan audit (B-01) | 单 previous assistant 使 1+1+1 窗口长度 ≤2 | observed |

## 5. Current Behavior

```text
prompt loop step N:
  new assistant message -> SessionProcessor.create/process

stream tool-call:
  -> parts window (current + single previousAssistantToolTail)
  -> same tool + same JSON input (any non-pending) -> permission.ask(doom_loop)

stream tool-error:
  -> failToolCall
  -> consecutiveErrorMap[session][tool] cross-message count++
  -> count >= 3 -> permission.ask(doom_loop)

stream tool-result success:
  -> delete map entry for tool
```

False positives (user):

1. 三次相同 **成功** 调用 → tool-call 路径触发。
2. 跨 turn 三次 **不同 input** 的 error → Map 路径触发。

R1 设计缺陷（auditor B-01）：若只拼「当前 tools + **单个** previous assistant tools」再 `slice(-3)`，在 1-tool-per-step × 3 下第 3 次最多得到 2 条，**永远达不到阈值 3**。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 每 step 新 assistant、常 1 tool error | SessionPrompt loop | MessageID.ascending per step | process per step | SessionPrompt + Processor | observed |
| tool error 终态 + 保留 input | failToolCall | part persisted error | tool-error handler | SessionProcessor | observed |
| 1+1+1 同 tool 同 JSON 全 error | 模型死循环 | 3 assistants × 1 tool | **必须**可 ask | Processor + MessageV2 multi-assistant tail | observed（核心） |
| 1+1+1 同 tool **不同** JSON 全 error | 换参探索 | 同上 | **不得** ask | SessionProcessor | observed |
| 同参 ×3 全 success | 合法重复 | tool-call / completed | **不得** ask | SessionProcessor | observed |
| 同 message 并行不同 input error | AI SDK parallel | 多 tool parts | **不得** ask | SessionProcessor | observed |
| 同 message 并行同参 ×3 error | 罕见 | 窗口满 3 error | **可** ask（用户字面 AND） | SessionProcessor | reachable |
| compaction / hidden | compaction / undo | tail 不足或跳过 hidden | 自然不触发 | MessageV2 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 仅当最近 `DOOM_LOOP_THRESHOLD`（3）条**可见、非 pending 的 tool 记录**（跨多个前序 assistant + 当前 message）同时满足：同 `tool`、同 `JSON.stringify(input)`、全部 `status==="error"` 时，才 `permission.ask(doom_loop)` | 用户 AND + B-01 | 强制 1+1+1 同参 red 切片 |
| INV-02 | 仅相同输入但存在非 error（含全 success）→ 不 ask | 用户 | 新增 |
| INV-03 | 跨 turn 连续 error 但 input 不同 → 不 ask | 用户 | 改写 A/B/C |
| INV-04 | 同 message 并行、不同 input 的 error 不触发 | 现测试 | 保留 |
| INV-05 | 触发仍走 Permission 通道（patterns/always=tool 名；metadata 含 tool/input） | 契约 | deny→stop |
| INV-06 | 单一检测路径；删除 consecutiveErrorMap 与 tool-call 检测 | 用户去冗余 | 代码删除 + 测试矩阵 |
| INV-07 | 前序 tool 窗口由 MessageV2 **有界**查询提供：最多 thaw `limit` 条 tool part；**跨多个**前序 visible assistant；排除 hidden message/part；不 hydrate 全 session | B-01 + cold storage | 扩展 pagination 测试 |
| INV-08 | 生产默认 turn 形状 **1 tool / assistant × 3 steps**、同 tool 同 input 全 error → 第 3 次 error 后必须可触发 | prompt loop + 用户场景 | 强制 live 切片 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | tool-call 仅凭相同 input ask | SessionProcessor tool-call | processor.ts |
| INV-01/03 | tool-error Map 只计 tool 名 | SessionProcessor Map | processor.ts + A/B/C 测试 |
| INV-07/08（R1） | 用单 previous assistant 声称承载跨 step 窗口 | MessageV2.previousAssistantToolTail `.limit(1)` | message-v2.ts；B-01 |

根因：产品语义实现为 **OR 双检测器**；跨 step 连续性依赖 **Map**，transcript 窗口深度又 **不足以** 在删 Map 后单独承载 1+1+1。

反馈信号（行为变更，非生产故障）：

```bash
cd packages/opencode && bun test test/session/processor-effect.test.ts -t "consecutive-error"
```

现状：`cross-turn errors trigger doom_loop`（不同 path）期望 stop——AND 后应变 continue。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Why not elsewhere |
| --- | --- | --- | --- | --- |
| 是否 ask doom_loop | SessionProcessor | tool-error 后 AND 判定 | 唯一写 tool 终态并消费 stream 的模块 | Permission 无 transcript |
| 跨多个前序 assistant 的有界 tool tail | MessageV2 | 见 §10 查询合同 | DB/cold thaw 边界已在 MessageV2 | Processor 不应手写 SQL / 全量 messages |
| 用户放行 | Permission.ask/reply | 既有 | 策略层 | — |
| 每 step 新 assistant | SessionPrompt | 既有 loop | 不改 | — |

## 10. Single Approved Primary-Path Design

### 10.1 MessageV2：跨 assistant 有界 preceding tool tail

**替换/扩展**现 `previousAssistantToolTail`（该符号仅 doom_loop 与其测试使用）：

```text
precedingToolTail({ sessionID, before: { id, time }, limit }) -> ToolPart[]  // chronological, length <= limit
```

合同（必须全部成立）：

1. 只包含：`type==="tool"`、`state.status !== "pending"`、part 非 hidden、所属 message 为 visible assistant、message 严格早于 `before` cursor（与现 `older(cursor)` 语义一致）。
2. 结果为全 session 在 cursor 之前的 **最近 `limit` 条** 上述 tool，按时间/ID **正序**（旧→新），等价于「倒序取 limit 再 reverse」。
3. **必须跨多个 assistant**：1-tool-per-assistant × N 时，`limit=3` 在第 4 个 assistant 之前应能返回 3 条（若存在）。
4. 有界：最多 thaw `limit` 行 part；禁止为检测 hydrate 全 transcript。
5. 实现偏好：session 级 SQL join（message+part）`ORDER BY part.id DESC LIMIT :limit`，再 reverse；保持 hidden 过滤在 limit 前生效（与现注释一致）。
6. 命名：可保留函数名并扩展语义，或重命名并更新唯一调用方/测试；计划以 **合同** 为准，不强制保留「单 assistant」旧语义。

### 10.2 SessionProcessor：唯一 AND 检测

```text
tool-error:
  failToolCall  // current part status=error
  currentTools = MessageV2.parts(currentAssistant).filter(tool && !pending)
  need = THRESHOLD - min(currentTools.length, THRESHOLD)  // or always fetch THRESHOLD preceding and merge
  preceding = MessageV2.precedingToolTail({ sessionID, before: currentAssistant, limit: THRESHOLD })
  window = [...preceding, ...currentTools].slice(-THRESHOLD)
  if window.length === THRESHOLD
     && every: same tool as failed
     && every: status === "error"
     && every: JSON.stringify(input) === JSON.stringify(failed.input)
  then permission.ask({
    permission: "doom_loop",
    patterns: [toolName],
    always: [toolName],
    sessionID,
    metadata: { tool, input, consecutiveErrors: THRESHOLD },
    ruleset: agent.permission,
  })

tool-call / tool-result:
  no doom_loop logic
  no consecutiveErrorMap
```

合并细节：`preceding` 已是 cursor **之前**的最近 tools；`currentTools` 含刚写入的 error。`slice(-THRESHOLD)` 得到全局最近 THRESHOLD 条 tool 终态（在「当前 message tools + 前序」已覆盖时等价）。为简化实现，允许：

```text
preceding = precedingToolTail(limit=THRESHOLD)
window = [...preceding, ...currentTools.filter(tool&&!pending)].slice(-THRESHOLD)
```

在 1+1+1 第 3 次：preceding=[e1,e2]（或仅能拿到 e2 若 limit 实现错误——合同禁止），current=[e3]，window 长度 3。

### 10.3 删除

- 整个 `consecutiveErrorMap` 及 tool-result 清零。
- tool-call 上全部 doom_loop 检测。

### 10.4 为何修复 first divergence / B-01

- AND 合取在 **error 终态 + transcript 单源** 完成，符合用户 OR→AND。
- 窗口深度与 prompt 每 step 新 assistant 对齐，**1+1+1 同参全 error 可达**，不再依赖 Map 的跨 step 计数。
- 不同 input 的 1+1+1 因 JSON 不等而不触发。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Disposition |
| --- | --- | --- | --- | --- |
| tool-call identical-input ask | current | superseded competing detector (OR) | no (asks) | **remove** |
| consecutiveErrorMap count ask | current | superseded competing detector (OR) | no (asks) | **remove** |
| tool-error AND + multi-assistant preceding tail | proposed | primary-contract | no (ask via Permission) | **implement** |
| Permission allow/deny/ask/auto | current | primary-contract branch | when allow | **preserve** |
| Compaction/hidden 致窗口不足 | current | natural pass-through | no | **preserve** |

无 rollback；无新 fallback。禁止用「Map + input 指纹」作为第二成功路径。

## 12. Workaround Deletion and Replacement

| Item | Why existed | Superseded by | Delete at |
| --- | --- | --- | --- |
| consecutiveErrorMap + lastMessageID | 跨 step 计数 / 防并行误报 | multi-assistant transcript window + input 相等 | processor layer |
| tool-call identical 预检 | 执行前打断重复 | 用户不要仅相同输入；失败 AND | tool-call 分支 |
| tool-result 清零 map | 配合 Map | Map 删除 | tool-result |
| 单 previous assistant tail 承载跨 step | R1 误设 | precedingToolTail 跨 assistant | message-v2 查询合同 |

## 13. Forward Traceability

| Requirement / invariant | Production path | File/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/08 1+1+1 同参全 error → ask | preceding multi + AND | message-v2 + processor | live: 3 steps same path fail → stop under deny |
| INV-02 同参 success ×3 → 不 ask | 无 tool-call 检测 | processor | live: 3 identical success → continue |
| INV-03 1+1+1 不同 path error → 不 ask | AND 失败 | processor | 改写 A/B/C → continue |
| INV-04 并行不同 input | AND 失败 | processor | 保留 parallel → continue |
| INV-05 Permission | ask 字段 | processor | deny→stop / error defined |
| INV-06 单路径 | 删 Map/tool-call | processor | 全矩阵 |
| INV-07 有界跨 assistant | precedingToolTail | message-v2 | pagination：两 assistant 各 1 tool，limit=2 返回 2；hidden 不占配额；最多 thaw limit |
| 文案一致（最小） | i18n description | app i18n / tips | 静态语义 |

## 14. Reverse Traceability

| Concept | Req ID | Evidence | Why existing insufficient |
| --- | --- | --- | --- |
| 单一 tool-error AND | INV-01–04 | 用户 OR→AND | OR 双分支无法合取 |
| 删 Map | INV-06,08 | 用户去冗余 + B-01 | Map 缺 input；保留会双源 |
| 删 tool-call 检测 | INV-02 | 用户 | 无 error 语义 |
| multi-assistant precedingToolTail | INV-07,08 | prompt 每 step 新 assistant；B-01 | 现 `.limit(1)` 单 assistant 深度不足 |
| tool-only 当前 message 过滤 | INV-01 | 最近三次**脱扣** | 混入 text/step 扭曲窗口 |
| 不新增 Permission 键 | §2 | — | 既有 doom_loop 足够 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Responsibility | Expected delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/message-v2.ts` | modify | 跨 assistant 有界 preceding tool tail 合同 | +30~60 / 改写现 helper |
| `packages/opencode/src/session/processor.ts` | modify | 唯一 AND 检测；删 Map 与 tool-call 分支 | net − |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | AND 矩阵；强制 1+1+1 同参/不同参 | +100~180 |
| `packages/opencode/test/session/messages-pagination.test.ts` | modify | multi-assistant tail；保留 hidden/cold | +40~80 |
| `packages/app/src/i18n/*.ts` 等 doom_loop 描述 | modify 最小 | 「相同输入的连续失败」 | 小 |

## 16. TDD Behavior Slices

Seam：`SessionProcessor.process` + `doom_loop: "deny"` → `result` / `message.error`。

| Order | Red behavior | Why current fails | Minimal green | Protects |
| --- | --- | --- | --- | --- |
| 1 | **1+1+1 不同 path** read error → `continue` | Map 第 3 次 stop | AND 窗口 input 不等 | INV-03 |
| 2 | **1+1+1 相同 path** read error → `stop` | 仅删 Map 则永不 stop；单 previous 也永不 stop | multi-assistant tail + AND | INV-01/08 |
| 3 | 同参 success ×3 → `continue` | tool-call 路径可能 stop | 删 tool-call 检测 | INV-02 |
| 4 | 同 batch 并行 3 不同 path fail → `continue` | — | AND | INV-04 |
| 5 | MessageV2：两个前序 assistant 各 1 tool，`limit=2` 返回 2 条正序 | 现 helper 只返回 1 个 assistant 内 tools | multi-assistant 查询 | INV-07 |
| 6 | MessageV2：hidden assistant/part 不占 tail | 既有 | 保持 | INV-07 |

Slice 2 是 **强制** 生产形状（每 turn 新建 assistant，各 1 failing tool），不得用「单 assistant 内堆 3 条 tool」冒充。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| `E` | ~80–120 | message-v2 查询 + processor 检测 |
| `C` | `>= max(1, ceil(E*0.15))` ≈ 12–18 | 邻近 AND、仅 tool-error、跨 assistant 有界、为何删 Map |

必注：

- AND 三条件与阈值。
- 仅 tool-error 触发。
- precedingToolTail 跨多个 assistant、有界 thaw、hidden 语义。
- 1+1+1 为何依赖该查询（对照旧 Map / 单 assistant）。

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/session/processor-effect.test.ts`（doom_loop / consecutive 相关） | `packages/opencode` | AND 行为 |
| `bun test test/session/messages-pagination.test.ts -t "doom-loop\|tool tail\|previous"` | `packages/opencode` | multi-assistant tail |
| `bun typecheck` | `packages/opencode` | 类型 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files modified | 3–N i18n | v2 + processor + tests |
| Production lines | ~0 net（删 OR + 加查询/AND） | |
| Test lines | +150 | 1+1+1 矩阵 + tail |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| SQL join 性能 | `LIMIT threshold`（3）有界 |
| JSON.stringify 键序 | 与现 identical 一致，不新增规范化 |
| 并行同参 ×3 触发 | 用户字面 AND；写入测试/注释 |
| 文案滞后 | 最小 i18n 同步 |

### Open Decisions Requiring the User

无。

### Rejected Speculation

- tool-call 预拦截即将失败。
- 保留 Map 作第二路径或双写权威。
- 检测下沉 Permission。
- compaction 断窗补偿回填。
- 改阈值。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.
- Re-verify B-01 closure: 1-tool-per-step × 3 same tool/input/errors must be reachable under §10 without consecutiveErrorMap.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 单 previous assistant 使 1+1+1 窗口不可达 | N-01 标签用词；N-02 slice 形状；N-03 文案 | **BLOCK** | adversarial-auditor plan audit R1 |
| 2 | R2 | yes | No blocking findings. | N-01 Product copy outside app i18n stays stale; N-02 Parallel same-input ×3 errors will ask (intentional) | **APPROVE** | adversarial-auditor plan audit R2 (ses_07eea01a6ffeamVxPCxTWK4yTw) |

### R2 independent auditor verdict (verbatim)

```text
APPROVE
```

- Audited artifact: `docs/plans/doom-loop-identical-error-and.md`
- Revision: R2 only
- Scope: Full original requirement and full affected interface (SessionProcessor doom_loop detectors, MessageV2 preceding tool tail, Permission ask contract, processor-effect + messages-pagination tests, minimal settings copy)
- Blocking findings: No blocking findings.
- Implementation allowed only after orchestrator records this clean full-scope plan verdict for R2 without substantive design edits in the same administrative write.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/session/message-v2.ts` | `previousAssistantToolTail` → session join 跨多个 assistant 有界 tool tail |
| `packages/opencode/src/session/processor.ts` | 删 consecutiveErrorMap + tool-call 检测；tool-error 唯一 AND 窗口 |
| `packages/opencode/test/session/processor-effect.test.ts` | AND 矩阵：并行不同 input / 跨 turn 不同 input / 1+1+1 同参 / 成功同参 |
| `packages/opencode/test/session/messages-pagination.test.ts` | multi-assistant tail + hidden 不占配额 |
| `packages/app/src/i18n/en.ts` | doom_loop description 同步 AND |
| `packages/app/src/i18n/zh.ts` | 同上 |

`git diff --stat`（本 GOAL 路径）：6 files, +187 / −129.

### Red-Green Test Evidence

- Seam: `SessionProcessor.process` + `doom_loop: "deny"`；`MessageV2.previousAssistantToolTail`.
- Slice 1: cross-turn different-input → `continue`（替换旧 stop 期望）.
- Slice 2: 1+1+1 same-input → turn2 `stop` + error defined.
- Slice 3: identical success ×3 → `continue`.
- Slice 4: parallel different-input → `continue`.
- Slice 5–6: multi-assistant tail ids + hidden 过滤.

### Verification Commands and Results

| Command | CWD | Result |
| --- | --- | --- |
| `bun test test/session/messages-pagination.test.ts -t "doom-loop"` | packages/opencode | 1 pass |
| `bun test test/session/processor-effect.test.ts -t "doom_loop"` | packages/opencode | 4 pass |
| `bun test test/session/processor-effect.test.ts` | packages/opencode | 21 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

行为收紧（非生产故障）。旧 `cross-turn A/B/C stop` 信号已由 AND 矩阵替代并转绿。

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| tool-call identical ask | removed |
| consecutiveErrorMap | removed |
| tool-error AND + multi-assistant tail | implemented primary |
| Permission allow/deny/ask | preserved |
| Compaction/hidden short window | preserved natural pass-through |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 158 | 实现审计独立重算：processor-effect 93 + pagination 26 + processor 22 + message-v2 15 + i18n 2 |
| Qualifying Chinese comment lines `C` | 32 | processor 11 + message-v2 9 + processor-effect 8 + pagination 4 |
| Ratio `C / E` | 0.203 | |
| Required minimum `C` | 24 | `max(1, ceil(158*0.15))=24` |

Representative: processor tool-error AND 三条件与 transcript 单源；message-v2 跨 assistant 有界 LIMIT；tests 标注 1+1+1 生产形状与 A/B/C 不得拦截。

### Remaining Unverified Items

- 其它语言 i18n（除 en/zh）未同步（N-01 可接受）。
- 真机 TUI 弹窗交互未在本 GOAL 验证。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 Chinese comment 15% gate (`E=127`, `C≤17`, need 20) | N-01 coldOwners bound; N-02 i18n lag; N-03 no post-ask reset | **BLOCK** | ses_07edebab0ffe4dPZSTg4XRWuyW |
| 2 | R2 | yes | No blocking findings. | N-01 non-en/zh copy; N-02 symbol name singular | **APPROVE** | ses_07ed87a13ffetaB5Utuy21unP3 |

### Round 2 independent auditor verdict (verbatim)

```text
APPROVE
```

- Mode: implementation audit, full original scope
- Plan: `docs/plans/doom-loop-identical-error-and.md` revision R2 (approved R2)
- Blocking findings: none
- Chinese comment gate: E=158, C=32, required 24, ratio ≈0.203 PASS
- Release claim: this exact working-tree implementation of R2 only
