# Canonical Implementation Plan: Shell User/Model Output Panel Isolation

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: verbatim user request (Session GOAL; see §1)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-23

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，理论上(no output)是必要的，因为不然用户可能以为没有输出；
> 但是其他的理论上不应该过多进行不应该的修改，因此请你完整检查都有哪些，以及对于准确的语义，理论上应该进行精确的甜品级别修改使得最终能够实现相应的准确逻辑，修改代码数量以及修改行数整体克制，同时移除冗余的逻辑，如果部分逻辑因为移除之后可以适当简化（功能行为不能退化），那可以考虑进行相应的精确修改。最终实现一份整体完整准确的输出逻辑。

Goal terminal state from Session GOAL: `verified-implementation-and-commit`.

Interpreted without narrowing:

1. Fully inspect bash/shell dual-panel output semantics (user-visible vs model-visible).
2. Keep `(no output)` as a necessary empty-output placeholder so users do not think the tool card is missing output.
3. Do not over-change unrelated harness behavior; dessert-sized precise repair only.
4. Remove or simplify redundant logic only when removal does not regress behavior.
5. Deliver one complete, accurate dual-panel output contract for every live producer of bash ToolParts consumed by the dual-panel UI, then implement/verify/commit under the approved plan workflow.

## 2. Explicit Non-Goals

- Do not redesign `<opencode_notice>` format, `output-notice.ts` taxonomy, or bash compression adapters.
- Do not change agent ShellTool model-side assembly order of truncation notice, diagnostic appendix, timeout prose, or execution notice on `state.output` / tool `output` (A–E in §5).
- Do not change TUI spacing, `showContextOutput` toggle, or `contextLabel="returned to model"` (already correct consumers).
- Do not strip notices in UI with regex as a presentation workaround.
- Do not invent a second user-facing empty string dialect (e.g. Chinese “无输出”) that diverges from `(no output)`.
- Do not modify web/app packaging, cold storage, or compaction notice semantics beyond what falls out of the producer fix.
- Do not remove `stableVerificationOutput` notice-stripping in this revision (vestigial post-fix cleanup only).
- Do not commit throwaway repro scripts under `packages/opencode/.tmp-*`.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Tool returns ExecuteResult with model-facing output; Message/Part persist tool state; vocabulary: Tool, Session, Message |
| `docs/tool-output-notice-format-design.md` | Contract: `opencode_notice` is model-visible harness; detailed stats stay in metadata; raw output stays plain text |
| `docs/plans/tui-bash-command-output-spacing.md` | Documents dual read of `metadata.output` (user) vs `props.output` (model / “returned to model”) in TUI Shell |
| `packages/opencode/AGENTS.md` | Tests/typecheck run from package dirs; module shape; Effect rules |
| `packages/opencode/test/AGENTS.md` | Effect/live test patterns; public seam assertions |
| `.opencode/policy/first-principles-engineering.md` | Root-cause repair, one primary path, no fallback cascade, Chinese comment gate |
| `docs/workflow.md` | GOAL phases: plan → plan audit → TDD implement → implementation audit → commit |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` ~1108–1355 | Agent ShellTool dual outputs; first divergence `displayed ? displayOutput : preview(output)` | observed |
| `packages/opencode/src/session/prompt.ts` ~1666–1736, ~1775–1781 | User-run `prompt.shell` creates same `tool: bash` ToolPart; dual-writes harnessed string to both panels | observed |
| `packages/opencode/src/util/output-notice.ts` | Formats model harness notices only | observed |
| `packages/opencode/src/tool/bash-compress.ts` `createTerminalDisplay`, `renderDiagnosticAppendix` | User display stream vs model diagnostic appendix | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` Shell + toolprops | Default UI reads `metadata.output`; right-click reads `state.output`; both producers use Shell | observed |
| `packages/web/src/components/share/part.tsx` `BashTool` | Share UI reads `metadata.output` | observed |
| `packages/opencode/src/session/message-v2.ts` `toModelMessagesEffect` | Model context uses `part.state.output` for completed tools | observed |
| `packages/opencode/src/tool/tool.ts` | Outer truncate skipped when shell sets `metadata.truncated` | observed |
| `packages/opencode/test/tool/shell.test.ts` | Locks model `result.output` notices/`(no output)`; does not lock user-panel isolation | observed |
| `packages/opencode/test/session/prompt.test.ts` shell suite | Locks stdout/stderr capture and abort notice on `state.output`; asserts metadata contains stdout but not isolation | observed |
| `docs/tool-output-notice-format-design.md` | Model-visible notice contract | contracted |
| Live ShellTool repro 2026-07-23 empty success + timeout empty | RED: agent path user panel polluted | observed |
| Source reconstruction of `prompt.shell` finish dual-write | Same UI contract broken on user-run bash | observed |

## 5. Current Behavior

### 5.1 Agent ShellTool (`shell.ts`)

```text
Agent bash Tool call
  -> ShellTool.execute
     running: metadata.output = terminal display snapshots
     model `output` assembly (A–E):
       A empty? "(no output)" : end.text
       B if empty && timeout: block-buffering diagnostic prose
       C if cut: prepend formatOutputTruncatedNotice
       D if fail+hidden signal: diagnostic appendix
       E formatShellExecutionNotice
     metadata.output = displayed ? preview(display) : preview(output)  // BUG empty path
```

### 5.2 User-run shell (`prompt.shell`)

```text
User command -> SessionPrompt.shell
  -> ToolPart tool=bash (same id as ShellTool)
  -> stream: output += chunk; progress metadata.output = raw cumulative
  -> finish:
       append abort or long-completed notice onto `output`
       metadata.output = output
       state.output = output   // dual-write same harnessed string
```

Empty success: both panels `""` (no `(no output)`).  
Abort / long-completed: user default panel contains `opencode_notice`.  
“returned to model” is a no-op (identical strings).

### 5.3 Shared consumer

TUI `Shell` (and Web `BashTool` for metadata) read the dual fields the same way for any `tool === bash` part.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Agent bash with stdout/stderr | ShellTool | chunks | displayed true → clean metadata | shell.ts | observed |
| Agent bash empty success | ShellTool | no chunks | pollution via `preview(output)` | shell.ts | observed |
| Agent bash timeout empty | ShellTool | no chunks | pollution + timeout prose | shell.ts | observed |
| Agent bash non-zero/abort empty | ShellTool | no chunks | pollution + exit/abort notice | shell.ts | observed |
| User-run shell with stdout/stderr | prompt.shell | chunks | dual-write raw (clean until notices) | prompt.ts | observed |
| User-run shell empty success | prompt.shell | no chunks | both panels `""` | prompt.ts | observed |
| User-run shell abort / long run | prompt.shell | optional raw + notice | dual-write includes notice | prompt.ts | observed |
| Control-only agent stream → empty display | ShellTool | displayed true, empty display | currently `""` | shell.ts | reachable |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Model body (`state.output` / tool `output`) keeps today’s harness for each producer (ShellTool A–E; prompt.shell raw + abort/long-completed notices) | shell.ts; prompt.ts finish; tests | yes (model side) |
| INV-02 | User panel (`metadata.output`) never contains `<opencode_notice…>` or model-only diagnostic prose for any bash ToolPart | design doc; shared TUI Shell | no (gap both producers) |
| INV-03 | Empty effective terminal view shows exactly `(no output)` on the user panel | user requirement; empty agent RED; empty prompt.shell → `""` | no |
| INV-04 | Non-empty terminal/raw body on user panel without harness suffix | has-output green; prompt.shell stdout tests | partial |
| INV-05 | Structured metadata fields on ShellTool (`exit`, `truncated`, `outputPath`, …) unchanged | shell return shape | yes |
| INV-06 | TUI “returned to model” shows full model body when it differs from user body | session/index.tsx | consumer only |
| INV-07 | Both live producers of `tool: bash` ToolParts implement the same dual-panel contract | tool id + shared Shell UI | incomplete today |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02/03/07 agent | `metadata.output = displayed ? displayOutput : preview(output)` copies harness into user panel when empty | ShellTool terminal result (`shell.ts`) | Live RED empty success / timeout empty 2026-07-23 |
| INV-02/03/07 user-run | finish dual-write `metadata.output = output` after appending notices; empty raw stays `""` | SessionPrompt.shell finish (`prompt.ts`) | Source dual-write; cancel tests only assert model `state.output` notice |

These are two first divergences of the **same dual-panel responsibility** for the same ToolPart shape and UI. One approved primary **contract**; two owner-local repairs at each producer’s finish (no UI compensation).

### Red-capable feedback (agent path — already run)

Empty success via ShellTool: user `metadata.output` equaled full model string including `opencode_notice` → RED exit 1.  
Timeout empty: user also contained block-buffering prose → RED.  
Echo hello: user clean → GREEN for non-empty agent path.

### Red-capable feedback (user-run path — source-proven; lock in TDD)

| Case | Current metadata.output | Required |
| --- | --- | --- |
| command produces no bytes, normal exit | `""` | `(no output)` |
| abort with notice on model body | includes `opencode_notice` | raw or `(no output)` only |
| long completed with notice | includes `opencode_notice` | raw body only |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Agent dual-panel split | ShellTool execute result | `output` model; `metadata.output` user display | Only owner of display vs harness assembly | TUI must not re-parse |
| User-run dual-panel split | SessionPrompt.shell finish | same field contract on bash ToolPart | Only owner of stream accumulation + notice append | ShellTool is not on this path |
| Shared dual views | TUI Shell | default metadata; optional state.output | Consumer | Must not invent isolation |

## 10. Single Approved Primary-Path Design

**Contract (one semantic path for all bash ToolParts):**

```text
user metadata.output =
  non-empty terminal/raw body ? that body (preview-capped where producer already caps)
  : "(no output)"
model state.output =
  producer’s existing model harness assembly (unchanged)
```

### 10.1 ShellTool repair

Keep model assembly A–E unchanged.

```ts
const displayText = display.value()
const userOutput = displayText.length > 0 ? preview(displayText) : "(no output)"
// metadata.output = userOutput
// remove displayed ? displayOutput : preview(output)
// remove unused `displayed` flag if nothing else references it
```

Equivalence: non-empty `displayText` implies chunks were processed; empty display (including control-only) → `(no output)`.

### 10.2 prompt.shell repair

Do not dual-write after notice append. Capture raw before notices:

```ts
// stream still accumulates into raw buffer `output` (rename optional)
const raw = output
let modelOutput = raw
if (aborted) {
  modelOutput += "\n\n" + formatExecutionNotice(...)
} else {
  const notice = formatLongExecutionNotice("shell", shellElapsedMs)
  if (notice) modelOutput += "\n\n" + notice
}
const userOutput = raw.length > 0 ? raw : "(no output)"
// metadata: { output: userOutput, description: "" }
// state.output: modelOutput
// SessionEvent.Shell.Ended may keep modelOutput (event consumers of full result)
```

Live progress continues to publish raw cumulative text (no notices mid-flight) — already correct.

### 10.3 Why this is one primary path

Both owners implement the same dual-panel contract at their finish seams. No UI stripper, no second empty dialect, no competing success encodings. Forbidden fallbacks removed: `preview(output)` user backfill (agent) and dual-write of harnessed string (user-run).

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| ShellTool model A–E | current | primary-contract branch | yes (model) | high | preserve |
| ShellTool non-empty display | current | primary-contract branch | yes | high | preserve |
| ShellTool empty `preview(output)` | current | forbidden user←model coupling | yes wrong panel | low impact high severity | **remove** |
| ShellTool empty user `(no output)` | proposed | primary-contract branch | yes | low | **add** |
| prompt.shell dual-write harness | current | forbidden same-string dual panel | yes wrong panel | medium | **remove** |
| prompt.shell raw user + harness model | proposed | primary-contract branch | yes | medium | **add** |
| TUI strip notice | not proposed | forbidden workaround | n/a | 0 | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `metadata.output = preview(output)` when `!displayed` | show something when display empty | fixed placeholder `(no output)` | shell.ts final assignment |
| `displayed` flag if only for that branch | chunk tracking | non-empty displayText sufficient | shell.ts |
| prompt.shell dual-write one string | simplicity | violates dual-panel contract | prompt.ts finish |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 ShellTool model | A–E assembly | no change to assembly | existing shell.test model cases |
| INV-01 prompt.shell model | notice append | only split fields; keep notice on model | existing cancel/abort `state.output` notice tests |
| INV-02/03 ShellTool user empty | userOutput assignment | shell.ts | new: empty success + timeout empty `metadata.output === "(no output)"` and no `opencode_notice` / no block-buffering |
| INV-02/03/04 prompt.shell | finish split | prompt.ts | new: empty success metadata exact `(no output)`; abort: metadata has no `opencode_notice`, model still has; non-empty metadata has stdout only |
| INV-04 agent non-empty | display path | shell.ts | existing/lock echo metadata clean |
| INV-05 | metadata fields | no change | existing |
| INV-06 | TUI | no change | model body differs after fix |
| INV-07 | both producers | shell.ts + prompt.ts | tests on both seams |
| Restraint simplify | remove forbidden couplings | both files | covered above |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Empty user body `(no output)` (ShellTool) | INV-03 | red repro; user quote | empty path uses full model string |
| Empty user body `(no output)` (prompt.shell) | INV-03, INV-07 | empty dual-write `""` | no placeholder today |
| User panel = non-empty raw/display only | INV-02, INV-04 | design + shared UI | harness dual-write / preview(output) |
| Drop unused `displayed` | restraint | flag only gates bad fallback | optional equivalent simplification |

No stripper helper module; no second empty dialect.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/shell.ts` | modify | User-panel assignment; remove `preview(output)` coupling; optional remove `displayed` | ~−3 to +6 |
| `packages/opencode/src/session/prompt.ts` | modify | Finish: split raw user vs harness model; empty → `(no output)` | ~+6 to +15 |
| `packages/opencode/test/tool/shell.test.ts` | modify | Isolation assertions for empty success + timeout empty | ~+30–60 |
| `packages/opencode/test/session/prompt.test.ts` | modify | Isolation assertions for empty + abort metadata | ~+25–50 |
| `docs/plans/shell-user-model-output-panel-isolation.md` | this plan | Authority artifact | plan only |

## 16. TDD Behavior Slices

Public seams: `ShellTool.execute` return; `prompt.shell` completed ToolPart.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | ShellTool empty success: `metadata.output === "(no output)"`; no `opencode_notice`; model still has notice | `preview(output)` | user empty branch | model exit notice |
| 2 | ShellTool timeout empty: user exact placeholder; no block-buffering; model keeps prose + notice | same | same | timeout diagnostic |
| 3 | ShellTool non-empty: metadata has text, no notice | already green | lock | display path |
| 4 | prompt.shell empty success (`true`/`:`/exit 0 style): metadata exact `(no output)`; model without user pollution requirement on empty (may equal placeholder if no notice) | dual-write `""` | user empty branch | busy/cancel suite |
| 5 | prompt.shell abort: `state.output` still has `user_abort` notice; `metadata.output` has no `opencode_notice` and is raw or `(no output)` | dual-write after notice | split fields | cancel tests |

Independent expected values: literal `"(no output)"`, substring `opencode_notice`, `block-buffering`, `reason="user_abort"`. No private helper or source-text assertions.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 10–25 | both finish assignments; exclude tests |
| Required Chinese explanatory comments `C` | ≥2 (`max(1, ceil(E*0.15))` → at least 2 for E≥10) | one at ShellTool user assignment; one at prompt.shell split |

Comment content:

- ShellTool: 用户面板只反映终端画面；空画面固定 `(no output)`，不得回灌模型 harness。
- prompt.shell: 终态先保留 raw 再拼 notice；metadata.output 仅 raw/`(no output)`，model output 保留 harness。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts` | `packages/opencode` | isolation + existing model cases |
| `bun test test/session/prompt.test.ts` (or filtered shell-related cases if suite runtime requires; must include new isolation cases) | `packages/opencode` | prompt.shell isolation + abort notice on model |
| Re-run original ShellTool empty/timeout harness assertions | `packages/opencode` | GREEN under new definition |
| `bun typecheck` | `packages/opencode` | types clean |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 production | dessert |
| Files modified | 4 production/test + plan | two producers + tests |
| Files deleted | 0 | — |
| Production lines | ≤40 | two finish-site repairs |
| Test lines | ≤120 | five slices |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| Consumers relied on notices inside `metadata.output` | `stableVerificationOutput` strips notices | producer fix; leave stripper |
| Empty control-only agent streams | reachable | `(no output)` user |
| Event `Shell.Ended.output` content | currently post-notice | keep modelOutput on event |

### Open Decisions Requiring the User

None. R1 residual deferral of `prompt.shell` is **rejected** by plan audit B-01; R2 includes both producers.

### Rejected Speculation

- UI regex strip of notices.
- Removing model exit/timeout notices or model `(no output)`.
- Empty string user panel instead of `(no output)`.
- Redesigning notice format / compression / TUI spacing.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 dual-panel incomplete for `prompt.shell` | N-01 residual non-decision; N-02 soft vs hard empty assert wording; N-03 vestigial stableVerificationOutput | BLOCK | plan-audit R1 / adversarial-auditor session `ses_07129346dffeIVq3T4AJnQhZrN` |

R1 verbatim blocking finding summary (not paraphrased design change): second live producer `SessionPrompt.shell` dual-writes harnessed string into both panels / omits `(no output)` on empty; must be included in primary path or user-quoted residual acceptance. R2 includes the owner.

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | R2 | yes | No blocking findings | N-01 vestigial stableVerificationOutput; N-02 long-completed no separate slice; N-03 empty model asymmetry preserved; N-04 E estimate scopes production only | APPROVE | plan-audit R2 / adversarial-auditor session `ses_0711ba617ffe1si600At7lmbLs` |

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/tool/shell.ts` | User panel = non-empty display or `(no output)`; removed `displayed` / `preview(output)` coupling |
| `packages/opencode/src/session/prompt.ts` | Finish splits raw user vs harness model; empty user `(no output)` |
| `packages/opencode/test/tool/shell.test.ts` | Isolation asserts empty success/fail/timeout user panel |
| `packages/opencode/test/session/prompt.test.ts` | Empty success + abort user panel isolation; non-empty no notice |
| `docs/plans/shell-user-model-output-panel-isolation.md` | Plan + evidence |

Approx production/test: 4 files, ~50 insertions / 10 deletions on code paths (plan separate).

### Red-Green Test Evidence

1. ShellTool empty success: RED then GREEN after shell.ts fix (`metadata.output === "(no output)"`).
2. ShellTool timeout empty + empty fail isolation asserts GREEN with model harness preserved.
3. prompt.shell empty success + cancel abort: RED on dual-write; GREEN after prompt.ts split.
4. Non-empty stdout path still clean on both producers.

### Verification Commands and Results

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts` | packages/opencode | 55 pass, 0 fail |
| `bun test test/session/prompt.test.ts -t "shell\|cancel interrupts\|cancel persists aborted"` | packages/opencode | 20 pass, 0 fail |
| `bun typecheck` | packages/opencode | pass (no output) |

### Original Feedback-Loop Result

Pre-fix empty success ShellTool: user `metadata.output` included `opencode_notice` (RED). Post-fix: exact `(no output)` (GREEN). Same for timeout empty prose leakage.

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| ShellTool model A–E | preserved |
| ShellTool `preview(output)` user fallback | removed |
| prompt.shell dual-write harness | removed |
| UI notice stripper | not added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~50 | Non-blank production+test added/modified; exclude plan-only, import-only, pure quote-style on one timeout expect |
| Qualifying Chinese comment lines `C` | 8 | Dual-panel boundary + test intent at both finish sites and isolation asserts |
| Ratio `C / E` | ~0.16 |  |
| Required minimum `C` | 8 | `ceil(50 * 0.15) = 8` |

Representative comments:
- shell.ts: 用户面板只反映终端画面；空画面固定 "(no output)"，不得回灌模型 harness。
- prompt.ts: 终态先保留 raw 再拼 notice；metadata.output 仅 raw/"(no output)"，model output 保留 harness。

### Remaining Unverified Items

- Full unfiltered `prompt.test.ts` suite not run end-to-end (shell-related subset + shell.test full + typecheck run).
- Web share UI not re-tested interactively (reads metadata.output; producer fix covers it).
- N-01 `stableVerificationOutput` left in place intentionally.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings | N-01 long-completed no dedicated slice; N-02 vestigial stableVerificationOutput; N-03 full prompt.test not end-to-end; N-04 agent non-empty no explicit no-notice assert | APPROVE | implementation-audit R2 / adversarial-auditor session `ses_070ffb2dfffeOvLSWKAL7STF1e` |

Independent recount: E≈43, C=8, required 7, ratio ≈0.186 PASS.

The task may be marked `verified` only after an independent full-scope result of `No blocking findings` for the current implementation and approved plan revision.
