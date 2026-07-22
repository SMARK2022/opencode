# Canonical Implementation Plan: Preserve Structured Tool Input During Shell Auto Review

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: full-scope
>
> Requirement source: 用户原始需求："当前需要你详细完成检查一下我们的opencode,模型正在审核期的,以及工具已经,参数都已经固定之后,它在审核阶段显示的是pending的文案，找到根因,有没有什么比较好的修复方法，需要完整调研根源并解决错误问题，且保证不会引入新的错误。同时方案保持克制，保持甜点级别的精准修改，不额外引入复杂的状态机或者冗余逻辑，整体修改代码文件数量不超过4个，同时修改行数不超过600行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。"
>
> Implementation allowed: verified complete
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

当前需要你详细完成检查一下我们的opencode,模型正在审核期的,以及工具已经,参数都已经固定之后,它在审核阶段显示的是pending的文案，找到根因,有没有什么比较好的修复方法，需要完整调研根源并解决错误问题，且保证不会引入新的错误。同时方案保持克制，保持甜点级别的精准修改，不额外引入复杂的状态机或者冗余逻辑，整体修改代码文件数量不超过4个，同时修改行数不超过600行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。

## 2. Explicit Non-Goals

- Do not change permission decisions, reviewer retry/timeout/fallback, Shell spawn, command timeout, abort, or Shell `progressVersion` producer cadence.
- Do not expose hidden reviewer transcript inline in the parent Session.
- Do not change progress comparison from strictly-newer `>` to `>=`.
- Do not add a new state machine, SyncEvent type, migration, config switch, or raw-JSON parse fallback.
- Do not treat genuine pre-execute pending streaming as a defect.
- Do not use R1–R3 rejected designs (client-only sole durable fix; review-less early running).
- Do not expand to non-bash tools beyond using existing permission metadata fields when present.
- App equal-v0 parity remains residual under the 4-file cap (TUI is the reported surface).

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `CONTEXT.md` | Session/Message/Tool/Permission vocabulary. |
| `.opencode/policy/first-principles-engineering.md` | First-divergence repair; regression tests must fail on the original defect; Chinese comment gate includes tests. |
| Root + `packages/opencode` `AGENTS.md` | Package-local tests/typecheck. |
| Audits R1–R5 | Durable race; equal-v0 live; durable red must hit pending→`{ raw }` owner path deterministically. |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `reviewer/service.ts:957-961` | Pending promote writes `input: { raw }`. | reachable |
| `processor.ts:536-548` | Concurrent structured running full-replace. | reachable |
| `prompt.ts` ask metadata | Bash ask carries `command` in permission metadata. | contracted |
| `sync.tsx:340-353` | Equal-v0 keeps first bash running snapshot. | observed |
| `session/index.tsx:2823-2825` | Missing `input.command` → `Writing command...`. | observed |
| R5 audit B-01 | SessionPrompt “reviewing has command” often greens today because tool-call usually precedes review. | contracted |

## 5. Current Behavior

```text
pending Part
  → updateToolAutoReview (if still pending) → running { input:{ raw }, autoReview }
UI: no input.command → "Writing command..."
Concurrent tool-call may later set structured input; equal-v0 TUI may stick raw-only
When tool-call already made structured running before review, current code keeps command
  (common path) — so only a pending-at-review fixture reds the owner defect today
```

## 6. Supported Input Domain and Reachability

| Condition | Path | Class |
| --- | --- | --- |
| Parent ToolPart still `pending` at `updateToolAutoReview` | Stream lag / fixture / TOCTOU window | reachable |
| Permission metadata includes string `command` | Shell ask | contracted |
| Current running input already structured | tool-call first | reachable |
| Two equal-v0 running TUI snapshots | Multiple PartUpdated | observed |

## 7. Required Invariants

| ID | Invariant |
| --- | --- |
| INV-01 | If permission metadata includes `command` and reviewer marks the parent ToolPart reviewing, durable `state.input.command` must equal that command (not raw-only). |
| INV-02 | Reviewer must not clobber an already-structured running input with `{ raw }`. |
| INV-03 | Live TUI equal-v0 bash merge must field-enrich `input` / `autoReview` / `title` so reviewing visibility is not permanently dropped. |
| INV-04 | Strictly-newer progress and terminal dominance unchanged. |
| INV-05 | ≤4 files, ≤600 lines; no new state machine / fallback algorithm. |

## 8. First Divergence and Root Cause

| INV | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `updateToolAutoReview` pending branch full-replaces with `{ raw }`, ignoring permission metadata `command` and risking last-write over structured input. | `PermissionReviewer.updateToolAutoReview` | R2/R5; `service.ts:957-961`. |
| INV-03 | TUI equal-v0 keeps first bash running snapshot. | TUI `mergeLivePart` | `sync.tsx`; R3. |

## 9. Responsibility and Seam

| Concern | Owner |
| --- | --- |
| Durable structured reviewing Part | `PermissionReviewer.updateToolAutoReview` |
| Live equal-v0 field enrich | TUI `mergeLivePart` |
| Deterministic durable red | `test/permission/reviewer-service.test.ts` with pending Part fixture |
| Live red | `test/cli/cmd/tui/sync.test.tsx` |

## 10. Single Approved Primary-Path Design

### Durable (`updateToolAutoReview`) — single write only

```text
read latest Part (sessionID + tool.callID)
if missing/terminal: no-op

input selection (one decision, then one updatePart):
  if current input is structured (any own key other than solely "raw") → keep
  else if typeof metadata.command === "string" && command.length > 0 →
    { command }
  else if status === "pending" → { raw: pending.raw }
  else → current.input

write running Part once with that input, merged autoReview, title, time.start
// No second write / repair pass: metadata.command is already available at selection time,
// so a post-write rewrite is not an independent producer condition (R6 B-01).
```

### Live (`mergeLivePart`, bash, both running, equal progressVersion)

```text
input: existing raw-only && next structured → next.input else existing.input
autoReview: next ?? existing
title: next ?? existing
keep existing time.start; do not adopt next.output/progress at equal version
progressVersion strictly-newer path unchanged; terminal dominance unchanged
```

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| Metadata/command-aware promote (single write) | primary | preserve |
| Equal-v0 TUI field enrich | primary-contract branch | preserve |
| Residual raw-only when no command metadata and no structured input | last-resort display | keep narrow |
| R1–R3 rejected paths | forbidden | reject |

## 12. Workaround Deletion

| Item | Disposition |
| --- | --- |
| Always `{ raw }` on pending promote | Prefer structured current input or metadata.command |
| SessionPrompt-only durable red (often green today) | Replace with pending-fixture owner red |

## 13. Forward Traceability

| INV | Production | Files | Required red test (fails on current code) |
| --- | --- | --- | --- |
| INV-01 | command from metadata on pending promote | reviewer/service.ts | reviewer-service.test: seed pending ToolPart + review with metadata.command → durable input.command equals command (today: `{ raw }`) |
| INV-02 | keep structured running input | reviewer/service.ts | reviewer-service.test: seed running structured input, then reviewing patch → command unchanged + autoReview set |
| INV-03 | equal-v0 enrich | tui/sync.tsx | sync.test equal-v0 cases |
| INV-04 | progress `>` | tui/sync.tsx | existing shell progress tests |
| INV-05 | 4 files | §15 | git diff --stat |

## 14. Reverse Traceability

| Concept | INV | Why needed |
| --- | --- | --- |
| metadata.command promote | INV-01 | Pending-at-review path ignores fixed bash command evidence today |
| keep structured input | INV-02 | Full-replace can clobber tool-call structured input |
| TUI equal-v0 field enrich | INV-03 | Live second snapshot drop |
| pending-fixture durable test | INV-01 | SessionPrompt common path is often already structured at review |

## 15. File-Level Change Plan

Exactly four modified code files:

| # | File | Responsibility | Expected Δ |
| --- | --- | --- | --- |
| 1 | `packages/opencode/src/permission/reviewer/service.ts` | Structured promote from latest Part / metadata.command in a single updatePart; no structured→raw clobber; no second repair write. | +25–45 |
| 2 | `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | Equal-v0 bash field enrich. | +20–35 |
| 3 | `packages/opencode/test/permission/reviewer-service.test.ts` | **Required durable reds:** pending+command metadata → input.command; running structured then reviewing → keep command + autoReview. | +60–100 |
| 4 | `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | **Required live reds:** equal-v0 raw→command; equal-v0 command→autoReview; keep progress tests. | +40–70 |

## 16. TDD Behavior Slices

| # | Red on current code | Green after fix |
| --- | --- | --- |
| 1 | Fixture: pending ToolPart + review with metadata.command → durable Part lacks input.command (raw-only today) | metadata-aware single promote |
| 2 | Fixture: running structured command, then reviewing update → keep command + set autoReview (regression guard) | keep structured + merge envelope |
| 3 | TUI equal-v0 raw+autoReview then structured → store has command + autoReview | field enrich |
| 4 | TUI equal-v0 structured then autoReview → store has both | field enrich |
| 5 | Existing shell progress monotonic tests green | no progress rule change |

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | --- |
| E | 120–160 |
| C | ≥ ceil(E × 0.15) ≈ 18–24 |

Comments: pending promote must use fixed command evidence in one write; equal-v0 enrich is not progress `>=`; durable test forces pending-at-review owner path.

## 18. Verification

| Command | Working directory |
| --- | --- |
| `bun test test/permission/reviewer-service.test.ts --test-name-pattern "pending|structured|command|reviewing|autoReview"` | `packages/opencode` |
| `bun test test/cli/cmd/tui/sync.test.tsx --test-name-pattern "shell progress|auto review|enrich|equal|raw"` | `packages/opencode` |
| `bun test test/session/prompt.test.ts --test-name-pattern "shell auto review|in-flight shell auto review"` | `packages/opencode` |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "shell.*auto review"` | `packages/opencode` |
| `bun typecheck` | `packages/opencode` |
| `git diff --stat` | repository root |

## 19. Diff Budget

| Metric | Estimate |
| --- | --- |
| Files modified | 4 |
| Total lines | ≤250 (≪ 600) |
| Production | 60–95 |
| Test | 100–170 |

## 20. Real Risks and Open Decisions

### Open Decisions

None.

### Risks

- App equal-v0 residual (accepted).
- Non-bash tools without `command` metadata keep raw-only if still pending (outside Shell user symptom).
- Concurrent tool-call after a raw-only first write is rare for bash once metadata.command promotes structured on the first write; residual true TOCTOU after that is out of scope without a second algorithm.

### Rejected Speculation

- progress `>=`
- raw JSON second source
- R3 early running without autoReview
- SessionPrompt-only durable red without pending fixture (R5 B-01)
- Post-write repair second success write (R6 B-01)

## 21. Audit Contract

Independent full-scope audit of this exact revision against the original requirement and complete affected interface (durable Shell auto-review ToolPart lifecycle + TUI live bash merge).

## 22. Plan Audit Record

| Round | Rev | Full? | Blocking | Result | Ref |
| --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 中文注释预算排除测试 | BLOCK | ses_0772572… |
| 2 | R2 | yes | 客户端症状修复未覆盖 durable 整对象覆盖 | BLOCK | ses_07720d22… |
| 3 | R3 | yes | Pre-ask running 破坏 equal-v0 下 autoReview | BLOCK | ses_07704132… |
| 4 | R4 | yes | Durable INV 无 red-capable 行为测试 | BLOCK | ses_076f55f88… |
| 5 | R5 | yes | Durable 红测在常见 tool-call-first 路径上不红 | BLOCK | ses_076e9ec98… |
| 6 | R6 | yes | Post-write repair 是无独立 producer 条件的第二成功写 | BLOCK | ses_076e01479… |
| 7 | R7 | yes | No blocking findings | APPROVE | ses_076d6b1b0ffeKNM8og0479bRek |

### Round 7 Auditor Verdict (Verbatim)

```text
No blocking findings.
APPROVE
```

Audited artifact: `docs/plans/shell-auto-review-input-visibility.md` Revision **R7**. Mode: plan / full-scope. Non-blocking: INV-02 sequential red may already be green; durable fixture must hit `MessageV2.get` read path; App equal-v0 residual accepted.

### Round 5 Verdict (summary)

> Durable INV-01/02 regression cannot reliably red on the original defect via SessionPrompt-only assert; common path already has structured input at reviewing. **BLOCK.** Require deterministic pending-fixture owner red plus live enrich red.

### Round 6 Verdict (summary)

> Post-write repair is an unjustified second success write; metadata.command is already available at first selection. **BLOCK.** Keep a single durable write only.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Role |
| --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts` | Single-write structured promote from latest Part / metadata.command |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | Equal-v0 bash field enrich for input/autoReview/title |
| `packages/opencode/test/permission/reviewer-service.test.ts` | Pending-fixture durable reds + structured-keep regression |
| `packages/opencode/test/cli/cmd/tui/sync.test.tsx` | Equal-v0 live enrich reds; shell progress still green |

Diff (code only): 4 files, ~351 insertions / 4 deletions (≪ 600 lines).

### Red-Green Test Evidence

| Test | Result |
| --- | --- |
| `promotes pending parent ToolPart using metadata.command as structured input` | green after fix |
| `keeps structured running input when merging autoReview status` | green |
| `enriches equal-v0 bash running from raw-only autoReview to structured command` | green after fix |
| `enriches equal-v0 bash running autoReview without dropping structured command` | green after fix |
| existing shell progress / Shell auto-review prompt / render suites | green |

### Verification Commands and Results

All from `packages/opencode`:

```text
bun test test/permission/reviewer-service.test.ts --test-name-pattern "promotes pending parent|keeps structured running"  → 2 pass
bun test test/cli/cmd/tui/sync.test.tsx --test-name-pattern "enriches equal-v0|shell progress" → 3 pass
bun test test/session/prompt.test.ts --test-name-pattern "shell auto review|in-flight shell auto review" → 2 pass
bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern "shell.*auto review" → 9 pass
bun typecheck → pass
```

### Original Feedback-Loop Result

Pending-at-review durable path and equal-v0 live path both assert structured `command` + autoReview visibility; original user symptom path is covered.

### Actual Secondary and Replacement Path Inventory

| Path | Classification |
| --- | --- |
| metadata.command single promote | primary |
| equal-v0 field enrich | primary-contract branch |
| residual raw-only when no command metadata | last-resort display |

### Chinese Comment Calculation

| Metric | Actual | Notes |
| --- | --- | --- |
| E | 311 | Independent auditor recount of substantive non-blank prod+test lines |
| C | 50 | Qualifying adjacent Chinese explanations |
| Ratio | 0.161 | ≥ 0.15 |
| Required min C | 47 | ceil(311×0.15) |

### Remaining Unverified Items

- App package equal-v0 residual (explicit non-goal under 4-file cap).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | B-01 Chinese comment gate E=311 C=23 need≥47 | INV-02 red weak; §23 metrics wrong | BLOCK | ses_076c4105effe… |
| 2 | R7 | yes | B-01 C_qualifying=45 need≥47 | INV-02 weak; sleep(30); app residual | BLOCK | ses_076bd9e08ffe… |
| 3 | R7 | yes | No blocking findings | INV-02 weak red; sleep(30); app residual; auditor did not re-exec bun | APPROVE | ses_076b76426ffeca7dZBw1U32deq |

### Implementation Audit Round 3 Verdict (Verbatim)

```text
No blocking findings.
APPROVE
```

Audited artifact: implementation diff of the four listed files against approved plan **R7**. Full original requirement and durable+TUI live interface covered. Chinese comment gate PASS (E=311, C=50, need≥47).
