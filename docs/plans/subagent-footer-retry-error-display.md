# Canonical Implementation Plan: Subagent Footer Retry Error Display

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户要求在 sub-agent / task 页底部 `SubagentFooter` 一行优先显示与主 agent Prompt footer 同构的红字错误摘要，再显示 token usage 等；auto reviewer 页面也要挂载同样重试展示；保持甜点级修改（生产代码最好几十行内）、代码文件 ≤4、总改动 ≤800 行；目标终态 verified-implementation-and-commit。
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

1. 详细完整检查 sub agent（task 页）底部错误展示，对比主 agent 底部红字逻辑，按确认结论修改。
2. 错误展示放在用户截图所示的 subagent footer 这一行：`Permission-Reviewer (n of m) ↑… Parent/Prev/Next`。
3. 同一行内**优先**显示红字错误摘要，然后再显示 token usage 等内容。
4. 保持项目既有风格；移除或替换不足以承载需求的旧逻辑（不是平行加一套）。
5. 甜点级：不要冗余；修改文件数量 ≤4 个代码文件；总代码修改 ≤800 行；生产代码尽量几十行以内。
6. **auto reviewer 页面也要挂载同样的重试展示逻辑**，并尽量保持较小修改。

## 2. Explicit Non-Goals

- 不在子会话重新挂载完整 `Prompt` 输入框。
- 不改 Web/App `SessionTurn` / `SessionRetry`。
- 不改后端 `SessionStatus` / `SessionProcessor` retry 写入。
- 不把终态 `message.error` 卡片迁到底部 chrome。
- 不强制抽取大型共享 UI 库或重写 Prompt footer。
- 不改 permission/question 在父会话聚合的策略。
- 不改全局底部 `Footer`。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Status = `idle` \| `retry` \| `busy` |
| `packages/opencode/AGENTS.md` | 测试从 package 目录跑 |
| 主 agent Prompt footer | 权威 retry 展示契约 |
| `SubagentFooter` | 所有 parentID 子会话（含 permission-reviewer）共用底部栏 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `session/index.tsx` visible/SubagentFooter/Prompt | child 卸 Prompt 挂 SubagentFooter | observed |
| `subagent-footer.tsx` | status 仅服务 usage | observed |
| `prompt/index.tsx` retry footer | 主红字契约 | observed |
| `session/status.ts` + processor retry | 子会话同样写 status | observed |
| 静态/行为 red 信号 | footer 无 Short error | observed |

## 5. Current Behavior

```text
SessionProcessor -> session_status[sessionID]=retry
Main: Prompt shows theme.error summary+(details)+meta
Child: SubagentFooter shows label+usage+nav only (gap)
Auto reviewer child uses same SubagentFooter
```

## 6. Supported Input Domain and Reachability

| Input | Producer | Owner | Classification |
| --- | --- | --- | --- |
| child session_status retry | processor | SubagentFooter | observed |
| permission-reviewer child | auto review navigate | SubagentFooter | observed |

## 7. Required Invariants

| ID | Behavioral invariant |
| --- | --- |
| INV-01 | child（含 auto reviewer）retry 时 SubagentFooter 同行 theme.error 摘要 |
| INV-02 | 红字优先于 token usage |
| INV-03 | 压平摘要；`(details)` → DialogAlert 原文 |
| INV-04 | `retry in … · #n` meta |
| INV-05 | gemini quota 特例与 Prompt 一致 |
| INV-06 | 非 retry 行为不变 |
| INV-07 | 不恢复 child Prompt |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner |
| --- | --- | --- |
| INV-01..05 | SubagentFooter 未消费 session_status.retry | SubagentFooter |

Root cause: UI consumer gap, not backend.

## 9. Responsibility and Seam

Child 底部 chrome 唯一 owner = `SubagentFooter`。

## 10. Single Approved Primary-Path Design

```text
session_status[route.sessionID].type===retry
  -> SubagentFooter same row: label · error+(details)+meta · usage · nav
  details -> DialogAlert("Retry Error", original message)
```

Default: modify only `subagent-footer.tsx` + one test file.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| SubagentFooter retry chrome | primary | implement |
| Prompt retry / toast / message.error | preserve | preserve |
| Re-enable Prompt on child | forbidden | reject |
| Separate AutoReviewerFooter | forbidden | reject |

## 12. Workaround Deletion

Replace status-as-usage-only with status also driving retry chrome.

## 13. Forward Traceability

| Inv | Path | File | Test |
| --- | --- | --- | --- |
| INV-01..04 | SubagentFooter retry | subagent-footer.tsx | session-message-render child retry |
| INV-06 | else branch | same | existing usage/label |
| auto reviewer | same component | zero extra mount | permission-reviewer title fixture |

## 14. Reverse Traceability

| Concept | Req | Why needed |
| --- | --- | --- |
| retry 红字簇 | INV-01..05 | Prompt unmounted on child |
| createRefreshClock | INV-04 | countdown |
| DialogAlert | INV-03 | details |

## 15. File-Level Change Plan

| File | Change | Delta |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | modify | +40–70 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | +60–120 |

## 16. TDD Behavior Slices

1. child + emit retry → `Short error (details)` + `#n` + same color details
2. details click → DialogAlert
3. non-retry usage regression

## 17. Chinese Comment Budget

E≈50–70, C>=ceil(0.15E)

## 18. Verification

| Command | Cwd |
| --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "child subagent footer\|compact step\|non-shell auto review"` | packages/opencode |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx -t "retry\|details"` | packages/opencode |
| `bun typecheck` | packages/opencode |

## 19. Diff Budget

2 files, prod ~50 lines, tests ~100, hard cap ≤4 files / ≤800 lines.

## 20. Real Risks

Narrow width crowding — truncate error first; nav flexShrink=0.

### Open Decisions

None.

### Rejected Speculation

Separate auto reviewer footer; parent shows child retry; backend UI event.

## 21. Audit Contract

Full-scope independent audit required for plan and implementation.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | TDD slices for INV-03/04/05 should be strengthened in implementation; parallel Prompt copy drift risk. | APPROVE | adversarial-auditor task_id ses_069c6d2b0ffeoA6Sr3uZjTJcVT |

### Independent plan audit verdict (verbatim)

```text
No blocking findings.

APPROVE

Audited revision: R1
Scope: full original requirement（task 子会话 + auto reviewer 共用 SubagentFooter + 甜点预算）
```

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | modify: retry 红字簇 + details DialogAlert + countdown + layout priority |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify: child permission-reviewer fixture + retry/details assertions |
| `docs/plans/subagent-footer-retry-error-display.md` | plan artifact |

`git diff --stat` (code): 2 files, +201 / -11.

### Red-Green Test Evidence

1. Red: `bun test … -t "child subagent footer shows red retry"` timed out waiting for `Short error` while footer showed only usage (observed).
2. Green: same test passes (11 expects) after SubagentFooter change.
3. Regression: compact step usage + auto review open + Prompt retry details tests pass.

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "child subagent footer shows red\|subagent footer shows compact\|non-shell auto review status opens" --timeout 60000` | packages/opencode | 3 pass |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx -t "opens the original retry\|keeps short retry" --timeout 60000` | packages/opencode | 2 pass |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

Static red (status read, no theme.error/(details)/retry branch) resolved by production change; behavioral TUI frame now shows `Short error (details)` and DialogAlert.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| SubagentFooter retry chrome | primary | implemented |
| Prompt retry / toast / message.error | existing diagnostic | preserved |
| Child Prompt re-enable | forbidden | not introduced |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 180 | independent auditor recount round 2 |
| Qualifying Chinese comment lines `C` | 29 | independent auditor recount round 2 |
| Ratio `C / E` | 0.161 | PASS |
| Required minimum `C` | 27 | max(1, ceil(0.15*180)) |

### Remaining Unverified Items

- INV-05 gemini 特例未单独行为测试（与 Prompt 同条件内联；non-blocking plan note）。
- 极窄终端下 error+usage+nav 视觉挤占未做独立宽度矩阵测试。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 Chinese comment gate: E=180 C=22 need 27 | INV-05 no dedicated test; same-color not theme.error pin; narrow width untested; auditor did not re-run commands | BLOCK | ses_069bb0a82ffeUrHlrgGTSwDtqx |
| 2 | R1 | yes | No blocking findings. | INV-05 no dedicated test; same-color not theme.error pin; narrow width untested | APPROVE | ses_069b65a98ffeEIDXrajUB1xvKn |

### Independent implementation audit verdict (round 2, verbatim)

```text
No blocking findings.

APPROVE

Audited mode: implementation
Approved plan revision: R1
Actual plan revision: R1
Scope: full original requirement
Chinese comments: E=180 C=29 need=27 PASS
Blocking findings: none
```
