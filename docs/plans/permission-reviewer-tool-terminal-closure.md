# Canonical Implementation Plan: Permission Reviewer Tool Terminal Closure

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: |
>   详细完整检查全面的内容，按照如上我们要求的逻辑进行相应修改，本侧实现集中在
>   permission/reviewer/service.ts 的收口,保持整体逻辑理顺、服从整体项目的开发和
>   实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改
>   过于冗余。整体修改文件数量控制在4个代码文件以内，同时代码修改不超过800行。
>
>   （对话上下文确认的行为目标：对齐 SessionProcessor 的 tool 终态收口保证——
>   ensuring 必跑、message 与 tool 同收、优先 durable 扫描、finalize 失败不可完全
>   无痕迹；不把 reviewer 整段并入 SessionProcessor；不负责 daemon 启动扫历史。）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

详细完整检查全面的内容，按照如上我们要求的逻辑进行相应修改，本侧实现集中在
permission/reviewer/service.ts 的收口,保持整体逻辑理顺、服从整体项目的开发和
实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改
过于冗余。整体修改文件数量控制在4个代码文件以内，同时代码修改不超过800行。

对话中已对齐、且属于本任务行为范围的约束（不改变原文，仅记录已确认边界）：

- 修的是 **reviewer 运行时** 协议 tool 终态，不是 daemon 启动全库扫描。
- 对齐 **SessionProcessor ensuring(cleanup) 级收口语义**，不是整段替换为
  SessionProcessor。
- 保持 Effect 服务形态；问题不是“未 Effect 化”。
- 目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- Daemon / bootstrap 启动时扫描并修复历史 orphan open tool（另工作）。
- 把 reviewer 并入 SessionProcessor 管道或暴露 hidden prompt 给 chat plugin。
- 修改 `permission_review_decision` 工具协议 schema 或 allow/deny 决策语义。
- 修改 parent tool `autoReview` 策略路由（allow/deny/timed_out/fallback_user）。
- 全库 incomplete assistant / `request_usage` 会计 reconcile。
- 新增 schema migration、生成列、旁表索引。
- 修复历史 DB 中已存在的 3 条 zombie 行（运行时修复只防新产生；历史由启动扫描负责）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session / Message / Tool / Permission 词汇；reviewer 写的是 Message Part 与 Tool state |
| `packages/opencode/AGENTS.md` | Effect 模块形态、测试在 package 目录运行、typecheck 用 `bun typecheck` |
| 根 `AGENTS.md` | 默认分支 `dev`、测试勿从 repo root 跑 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence、禁止 fallback 堆叠、一责任一主路径 |
| SessionProcessor 既有设计 | `Effect.ensuring(cleanup())` 是主会话 tool 终态权威模式 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts` | attempt timeout、stream finalize、message onInterrupt 双 handler | observed |
| `packages/opencode/src/session/processor.ts` | `TOOL_ABORTED_ERROR`、`ensuring(cleanup)`、open tool→error | observed / contracted |
| `packages/opencode/src/session/prompt.ts` | cancel → `abortPendingToolParts`（仅 incomplete assistant） | observed |
| `packages/opencode/src/session/message-v2.ts` | `MessageV2.get` / `parts(messageID)` durable hydrate | observed |
| `packages/opencode/src/tool/permission_review_decision.ts` | 协议 tool 无副作用 | contracted |
| `packages/opencode/test/permission/reviewer-service.test.ts` | 已有 interrupt/drain/completed-winner closure 测 | observed |
| `~/.local/share/opencode/opencode.db` | 3 条 orphan：msg Aborted + tool pending；lag≈90005–90008ms | observed |
| 既有 closure 测试运行结果 | 3 pass（Fiber.interrupt 路径绿） | observed |

## 5. Current Behavior

```text
PermissionAuto.review
  -> PermissionReviewer.review
       -> reviewerRetry(attempt)
            -> Effect.timeoutOrElse(timeout_ms default 90_000)
                 -> runReviewerAttempt
                      -> create assistant message (no completed)
                      -> runReviewerStream (acquireUseRelease AbortController)
                           tool-input-start: toolParts.set + updatePart(pending)  // durable early
                           tool-call: updatePart(completed) + assessment
                           stream pipe:
                             onInterrupt -> finalizeOpenToolParts(map only, catch void)
                             tapError    -> finalizeOpenToolParts(map only, catch void)
                           drain后 -> finalizeOpenToolParts again
                           SessionRetry.retry around stream
                      -> outer pipe on runReviewerStream:
                           tapError    -> message.error + completed   // message only
                           onInterrupt -> message Aborted + completed // message only
                      -> success: message.finish + completed
            -> on ReviewerTimedOut: retry up to 3 attempts
       -> handleReviewerFailure: parent autoReview timed_out/failed/...
```

对比主会话：

```text
SessionProcessor.process
  -> stream drain
  -> Effect.ensuring(cleanup())  // interrupt/error/success 都跑
       -> 扫内存 toolcalls 中仍 open 的 tool -> error
       -> message.completed
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| per-attempt timeout | `Effect.timeoutOrElse` + `timeout_ms` | 中断 attempt fiber | `reviewerRetry` → interrupt stream + message handlers | PermissionReviewer | observed / contracted |
| Fiber / session cancel interrupt | cancel / outer interrupt | 中断不是 failure | stream + message onInterrupt | PermissionReviewer | observed |
| Stream incomplete after tool-input-start | provider SSE 无合法 tool-call | drain 后协议错误 | finalize + protocol retry | PermissionReviewer | observed / tested |
| Completed decision before interrupt | tool-call 已 durable completed | completed 是 winner | finalize must skip | PermissionReviewer | observed / tested |
| Crash before any handler | process kill | 无 in-process handler | **out of scope**（daemon 扫描） | daemon reconcile | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 任一 attempt 在 interrupt/timeout/stream-failure/drain-incomplete 退出后，该 attempt 所写的 `permission_review_decision` Part 不得停留在 `pending`/`running` | DB 3 zombies 违反；processor 对等保证 | partial: interrupt pending→error；缺 timeout 共终态 |
| INV-02 | message 写入 `time.completed`（含 Aborted）时，同 message 下 open tool 必须已是终态（completed/error） | DB: msg completed + tool pending | **missing** |
| INV-03 | 已 `completed` 的 decision tool 不得被 abort cleanup 覆盖为 error | completed-winner 注释与测试 | `preserves a completed decision Tool…` |
| INV-04 | 收口失败不得把 reviewer 失败伪装成 allow/deny 成功 | fail-closed 注释 | 既有 failure/fallback 测 |
| INV-05 | 修改保持甜点：≤4 代码文件、≤800 行；不并入 SessionProcessor | 用户约束 | N/A |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 / INV-02 | `tool-input-start` 已 durable 写 pending 后，attempt 退出时 **tool 终态不保证执行**：仅 stream 的 `onInterrupt`/`tapError`/drain 后调用 `finalizeOpenToolParts`；**无 `ensuring`**；**只扫内存 `toolParts`**；失败 **catch void**；**外层 message 终态 handler 不闭合 tool** | `PermissionReviewer` / `runReviewerStream` + `runReviewerAgent` 收口 | 代码结构；DB lag≈90s + Aborted message + empty pending tool；既有 Fiber.interrupt 测绿说明旁路有时可用，但与 timeout/半写组合无共终态保证 |

根因（first divergence）：

> Reviewer 平行实现了弱于 SessionProcessor 的 tool lifecycle 收口：  
> **终态不绑定 ensuring、message/tool 双 handler 分裂、扫描范围非 durable 全集、失败静默。**  
> 不是“未 Effect 化”，也不是协议 tool 定义错误。

下游症状：

- 库中 `permission_review_decision` pending 僵尸
- cancel 扫不到（message 已 completed）
- TUI/审计显示中断后仍“pending”

### Red-capable feedback loop（已运行）

**Loop A — 用户症状（生产 DB）**

```bash
sqlite3 "$HOME/.local/share/opencode/opencode.db" "
SELECT COUNT(*) FROM part p
JOIN message m ON m.id=p.message_id
WHERE json_extract(p.data,'\$.type')='tool'
  AND json_extract(p.data,'\$.state.status') IN ('pending','running')
  AND json_extract(m.data,'\$.time.completed') IS NOT NULL;
"
```

Observed (2026-07-25): `3` → **RED**（3 行均为 `permission_review_decision` + `MessageAbortedError` + lag≈90005–90008ms）。

说明：Loop A 证明生产残留；本任务运行时修复**不**清历史 3 行（non-goal）。实现后 Loop A 仍可能为 3，除非另做启动扫描。

**Loop B — 代码路径回归（现有测，对照）**

```bash
cd packages/opencode && bun test test/permission/reviewer-service.test.ts \
  -t "closes a pending decision|closes open decision|preserves a completed"
```

Observed: **3 pass**。证明 Fiber.interrupt + barrier 路径当前可绿；**不能**单独作为“timeout + message 共终态”的红测。

**Loop C — 实施期必建 red slice（本 plan 批准后 TDD）**

在 `reviewer-service.test.ts` 增加行为测：

- 配置 `timeout_ms` 极短（或等价 timeout 包 attempt）
- provider stream 停在 `tool-input-start` pending（复用 `openAIReviewPendingStream`）
- 使用真实 Session/SQLite（`it.instance`）或等价 durable mock：pending 写完后允许返回（非 `Effect.never` 卡死），再等 timeout
- 断言：**decision tool `status=error` 且 error 为 aborted 文案；assistant `time.completed` 存在；无 pending/running tool**

当前代码下该测应 **RED**（或 flake 暴露共终态缺失）；修复后 GREEN。  
实施前必须实际跑红一次并记录输出（approved-plan-implementation 阶段）。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Reviewer attempt stream tool lifecycle | `PermissionReviewer` | hidden audit transcript 上协议 tool 的 pending→terminal | 它创建 part 并拥有 stream | SessionProcessor 被安全边界排除 |
| Reviewer assistant message terminal | `PermissionReviewer.runReviewerAgent` | message 必有 completed 或 error | 它创建 message | cancel 只处理 incomplete + 不扫已 completed orphan |
| Parent autoReview display | `updateToolAutoReview` | reviewing→timed_out/aborted/… | 父会话 tool metadata | 不写子会话协议 tool part |
| Crash orphan 全库修复 | daemon reconcile（out of scope） | 无 runner 时 interrupt 收口 | 进程边界 | reviewer 无启动 hook |

## 10. Single Approved Primary-Path Design

```text
attempt exit (timeout | interrupt | stream error | drain incomplete)
  -> finalizeAttemptTools(persist, { interrupted, error })
       1. partIDs = toolParts.values ∪ durable open tools on messageID
          (MessageV2.get / parts(messageID) via Session 可读路径)
       2. for each: getPart; if open -> updatePart(error, interrupted metadata)
       3. on write failure: log; never invent allow/deny success
  -> then message terminal write (Aborted / error / success path unchanged)
```

绑定方式（替换旧的“仅旁路 finalize”）：

1. **`runReviewerStream` use 段**：`Stream.runForEach(...).pipe(..., Effect.ensuring(finalize…))`  
   对齐 processor 的 ensuring 语义；onInterrupt/tapError 可保留作早路径但必须幂等。
2. **`runReviewerAgent` 外层** `onInterrupt` / `tapError`：**先** `finalizeAttemptTools`，**再** `updateMessage`。  
   消除 message 已 completed、tool 仍 pending 的分裂。
3. **`finalizeOpenToolParts` 升级为 message 作用域**：内存 map ∪ durable open tools；已 completed/error 跳过（INV-03）。
4. **错误文案**：interrupt/timeout 使用与 `SessionProcessor.TOOL_ABORTED_ERROR` 相同字符串（import 常量或本地对齐字面量，避免复制算法）。
5. **删除/折叠**：不再把“仅 map + catch void + message 单独 onInterrupt”当作完整收口；以 ensuring + 共终态为主路径。

为何修 first divergence：

- 在 **同一 owner** 把 tool 终态从“尽力旁路”改成“attempt 退出必跑 + durable 全集 + 与 message 同序”。
- 不引入第二套成功路径；失败仍 fail-closed。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| ensuring + durable finalize on attempt exit | proposed primary | primary | no (cleanup only) | main | **add as primary terminal** |
| stream onInterrupt/tapError finalize | current | primary-contract branch（早收口） | no | secondary early | **preserve if idempotent** under ensuring |
| outer message-only onInterrupt | current | **forbidden incomplete terminal** | no | bug | **replace** with finalize-then-message |
| map-only finalize | current | incomplete primary | no | bug | **expand** to map ∪ durable |
| catch void on finalize | current | diagnostic-ish but silent | no | hides failure | **replace** with log + still no success invent |
| Merge into SessionProcessor | rejected | forbidden alternate architecture | n/a | n/a | **reject** |
| Daemon boot scan | other task | existing/planned elsewhere | n/a | n/a | **out of scope** |
| JSON fallback assessment | current | primary-contract domain branch | yes (valid assessment) | protocol | **preserve**（不改） |
| Protocol retry hide | current | primary-contract | no | protocol | **preserve** |

New alternate success paths: **0**.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 外层 message onInterrupt 假定内层必关 tool | 注释依赖 stream finalize | 外层直接 finalize 后写 message | `runReviewerAgent` onInterrupt/tapError |
| 仅内存 `toolParts` 扫描 | 快路径 ownership | durable 是 SQLite 真相；map 作加速 | `finalizeOpenToolParts` |
| finalize `catch void` 无痕迹 | 避免 cleanup 污染 provider error shape | 可继续不 fail 业务，但必须 log | finalize helpers |
| drain 后再 finalize 作为唯一“正常”闭合 | 防 retry 累积 pending | ensuring 覆盖更多退出；drain 次保留幂等 | stream use 段 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 tool 不留 pending | ensuring finalize + durable scan | `service.ts` finalize + ensuring | 新：timeout/pending stream 后无 open tool；旧：interrupt pending→error |
| INV-02 message completed ⇒ tools terminal | finalize before updateMessage | `service.ts` outer handlers | 新：assert message.completed **and** tool error |
| INV-03 completed winner | skip non-open in finalize | 保留 finalize status guard | 既有 completed-winner 测 |
| INV-04 fail-closed | finalize 不 return assessment | 无成功合成 | 既有 failure 路径；finalize 失败不 mark allow |
| INV-05 甜点范围 | ≤2–3 files, ≪800 lines | service + test（可选 import 常量） | review diff 规模 |
| 用户：集中 service 收口 | 只改 reviewer terminal | 不改 auto/processor 主循环 | 文件清单 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `finalizeAttemptTools` (map ∪ durable) | INV-01, INV-02 | DB orphan；map-only 可漏 | 现 finalize 不扫 message parts |
| `Effect.ensuring(finalize)` on stream | INV-01 | processor 对等；现无 ensuring | onInterrupt 可被中断/吞掉 |
| finalize-before-message on outer handlers | INV-02 | msg Aborted + tool pending | 外层只写 message |
| log on finalize failure | INV-01 observability | catch void 无痕迹 | 现完全静默 |
| import `TOOL_ABORTED_ERROR` | INV-01 文案一致 | processor 常量 | 可选；字面量对齐亦可 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts` | modify | ensuring finalize；durable 扫描；外层先 tool 后 message；log；替换弱收口 | +40～90 / ~20 替换 |
| `packages/opencode/test/permission/reviewer-service.test.ts` | modify | 新 timeout/共终态 red-green；保留既有 closure 测 | +80～150 |
| `packages/opencode/src/session/processor.ts` | modify（可选，≤5 行） | 仅若 export 复用 `TOOL_ABORTED_ERROR`；**不改 cleanup 逻辑** | 0～5 |

**上限：≤3 代码文件，≪800 行。禁止第 4 个生产模块。**

## 16. TDD Behavior Slices

Public seam: `PermissionReviewer.Service.review` + 持久化后的 child-session tool/message 状态。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | timeout/interrupt 后：`permission_review_decision` 不得 pending；message 已 completed | 无 ensuring / 外层不关 tool / 可能仅 map | ensuring + finalize-before-message + durable | 用户僵尸形态 |
| 2 | 已 completed decision 不被 cleanup 改成 error | 若误扫覆盖 | skip non-open | completed-winner |
| 3 | drain incomplete 仍无 open tool | 已有测 | 保持 finalize 幂等 | drain closure |

测试规则：独立期望字面量（`"Tool execution aborted"`、`status: "error"`）；不断言私有 map 内容；不复制 finalize 算法。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 50–80 | 排除 import-only/纯格式 |
| Required Chinese explanatory comments `C` | ≥ `max(1, ceil(E*0.15))` ≈ 8–12 | 邻近修改点 |

需中文说明的点：

- 为何 ensuring（对齐 processor，防 interrupt 旁路漏跑）
- 为何 finalize 先于 message completed（INV-02）
- 为何 durable ∪ map（SQLite 真相 vs 内存 ownership）
- 为何 completed skip（INV-03）
- 测试意图：timeout 共终态 vs 仅 Fiber.interrupt

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/reviewer-service.test.ts -t "closes a pending\|closes open\|preserves a completed\|timeout\|共终态\|terminal"`（最终以实际 test 名为准） | `packages/opencode` | 新+旧 closure 行为 |
| `bun test test/permission/reviewer-service.test.ts` | `packages/opencode` | reviewer 全文件回归 |
| `bun typecheck` | `packages/opencode` | 类型 |
| （可选）Loop A sqlite count | host | 历史僵尸仍可能=3；记录 non-goal |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 不新开模块 |
| Files modified | 2（最多 3） | service + test（+可选 processor 常量） |
| Files deleted | 0 | |
| Production lines | 40–100 | 甜点收口 |
| Test lines | 80–150 | timeout 共终态 |
| Generated lines | 0 | |
| **Total** | **≪800** | 用户硬上限 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| ensuring 与 onInterrupt 双跑 | finalize 幂等（非 open 则 skip） |
| MessageV2.get 在 mock Session 层不可用 | 测试用真实 Session 或 mock getPart + 列出 parts 的等价路径；生产用 MessageV2.get/parts |
| finalize log 噪声 | 仅 warn；不改变 fail-closed |
| 历史 3 行仍在 | non-goal；daemon 扫描 |

### Open Decisions Requiring the User

None for runtime design. Daemon 历史修复归属已在对话中划给另工作。

### Rejected Speculation

- “必须并入 SessionProcessor 才能正确” — 安全边界禁止；ensuring 语义可本地对齐。
- “必须启动全表扫才能修此 bug” — 启动扫是另一类（崩溃残留）；本 bug first divergence 在 attempt 收口。
- “现有 interrupt 测已绿故无 bug” — DB 与 90s lag 证明生产半写；测未覆盖 timeout 共终态。

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

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | none | N-01 Loop C 实施期须真跑红；N-02 durable 失败降级 map；N-03 不必改 processor.ts | APPROVE | adversarial-auditor ses_06a28afd2ffefjUE84jv4ESlIp |

Independent auditor release verdict (verbatim summary fields):

```text
No blocking findings.
APPROVE
Audited revision: R1
Full scope: yes
Implementation allowed after recorder transition: only for exact R1
```

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts` | ensuring finalize；`closeOpenReviewerTools` map∪durable；外层 finalize-before-message；log |
| `packages/opencode/test/permission/reviewer-service.test.ts` | timeout 共终态测；首次 error 写失败后仍闭合测 |
| `docs/plans/permission-reviewer-tool-terminal-closure.md` | plan + evidence（非生产代码） |

`git diff --stat`（代码）：`service.ts` +198/-约44 净改；`reviewer-service.test.ts` +170；合计 ≪800 行、2 代码文件。

### Red-Green Test Evidence

1. **RED**（修复前）  
   `bun test test/permission/reviewer-service.test.ts -t "timeout still closes decision Tools when first error write fails"`  
   失败：tool 仍 `pending`（message 可 completed）——复现生产半写。

2. **GREEN**（修复后）  
   同上 + `timeout after tool-input-start closes decision Tools before message completes` + 既有 interrupt/drain/completed-winner 共 18 pass。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/permission/reviewer-service.test.ts` | `packages/opencode` | 18 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | pass |

### Original Feedback-Loop Result

- Loop A（生产 DB orphan open tool + completed message）：仍为 **3**（历史行；non-goal，daemon 扫描另责）。
- Loop B 既有 interrupt 闭包：绿（回归保留）。
- Loop C timeout / 写失败共终态：红→绿。

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| ensuring + map∪durable finalize | primary terminal | implemented |
| stream onInterrupt/tapError early finalize | primary-contract early | preserved, idempotent |
| outer finalize-before-message | primary terminal | implemented |
| silent catch void | forbidden incomplete | replaced with log |
| SessionProcessor merge | rejected | not done |
| Daemon history scan | out of scope | not done |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 266 | 独立审计：非空实质代码行，排除 import-only/空行/纯注释行 |
| Qualifying Chinese comment lines `C` | 46 | 独立审计：INV/ensuring/durable/timeout 意图；排除 1 条复述过滤注释 |
| Ratio `C / E` | ≈0.17 | |
| Required minimum `C` | 40 | `ceil(266 * 0.15) = 40` |

### Remaining Unverified Items

- 历史 DB 3 条 zombie 未清（明确 non-goal）。
- 真实多 provider 长 timeout 生产环境未再手工复现（行为由短 timeout 夹具覆盖）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | none | N-01 outer durable-only 测覆盖不足；N-02 builder E 曾把注释计入；N-03 审计 shell 未复跑命令 | APPROVE | adversarial-auditor ses_06a17a2c1ffetJx8rdK7BPyV0M |

Independent auditor release verdict (verbatim summary fields):

```text
No blocking findings.
APPROVE
Audited plan revision: R1
Full original scope: yes
```
