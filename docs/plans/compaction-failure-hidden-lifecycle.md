# Canonical Implementation Plan: Compaction Failure Hidden Lifecycle

> Status: verified
>
> Revision: R10
>
> Approved revision: R10
>
> Audit mode: implementation
>
> Requirement source: Session GOAL supplied by the user on 2026-07-24
>
> Implementation allowed: complete; no further material changes
>
> Last updated: 2026-07-24

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

# R10 Authoritative Specification

R10 supersedes every later historical section in this document. Original requirement:

> 找到所有潜在的不成功压缩后仍然固定不进行hidden的逻辑链路，检查其共性以及相应的根因的修改方式，并给出较为合理且甜点级别的修复方案，整体代码修改量不超过600行，且不破坏现有的功能和性能。

The user's
latest clarification is the controlling scope:

> 当前为什么还在交缠？理论上不应该直接把我们已有的compact消息以及marker一块hidden不就行了吗？为什么涉及到新summary啥一大堆，你是不是在把问题搞复杂？

The requested objects are exactly the already-persisted Compaction marker
Message and this attempt's summary assistant. R10 does not create, replace,
retry or reinterpret a summary, and does not change any ordinary assistant.

## R10.1 Required Behavior

- On successful Compaction, defined by semantic result `continue` and a
  finished/no-error summary, preserve the marker and summary unchanged.
- On semantic `stop`, Provider/API/Auth/Unknown error, summary self-overflow,
  cooperative Effect failure or user abort before successful commit, mark the
  exact marker and any summary belonging to it
  `hidden(reason=compaction-cancelled)`.
- If the summary assistant is still incomplete, complete it with the existing
  aborted error before hiding it.
- A user abort during marker creation must still identify and hide a marker
  already written before `create()` returns.
- Auto and manual calls use the same `SessionCompaction.run` lifecycle; neither
  gets a separate branch, retry or fallback.
- Successful behavior and performance must not regress.

Explicitly excluded by the user clarification:

- ordinary Prompt assistants, RequestUsage, Prompt return-value semantics and
  HTTP response mapping;
- experimental v2 projection, EventV2/SyncEvent identity, projectors, TUI v2
  state and generated SDK;
- anchor/tail/memento ordering, Provider serialization, retry, hard truncation,
  alternate Provider or replacement summary;
- hard process death, where no cooperative finalizer can run.
- token/cost accounting and RequestUsage projection: hidden changes visibility,
  not already-recorded Provider usage; no usage row or assistant token field is
  deleted, reset, recomputed or rolled back.

## R10.2 Evidence, Invariant And First Divergence

Observed feedback loop:

```powershell
# packages/opencode
bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts" -t "failed compaction is absent from visible Session messages"
```

Before repair it deterministically returned semantic `stop` with three visible
Messages instead of only the original user: marker and errored summary were not
hidden.

| ID | Invariant | First divergence | Owner |
| --- | --- | --- | --- |
| R10-INV-01 | marker/summary remain scratch until a finished/no-error summary commits | `run.onExit` treats every `Exit.Success`, including `Success("stop")`, as committed | `SessionCompaction.run` |
| R10-INV-02 | cleanup can identify marker before `create()` returns | marker ID is learned only after yielded Message/Part/Started work | `SessionCompaction.run/create` |
| R10-INV-03 | committed summary is never hidden by later optional failure | cleanup must check finished/no-error summary first | existing `hideIncomplete` owner |
| R10-INV-04 | an already-persisted incomplete summary receives one hidden aborted terminal | summary is written before interruptible `SessionProcessor.create` returns | `SessionCompaction.hideIncomplete` |
| R10-INV-05 | hidden cleanup preserves every already-recorded token/cost field and does not mutate RequestUsage | visibility update spreads the existing Message; accounting has a separate owner | `SessionCompaction.hideIncomplete`, with RequestUsage unchanged |

The Processor already persists the failed summary and returns `stop`; the bug is
not error propagation. It is the lifecycle commit predicate at `run.onExit`.

## R10.3 Single Primary Repair

```text
run preallocates marker MessageID
  -> create persists marker and compaction Part using that ID
  -> process attempts the existing summary
  -> Success("continue") => committed; no cleanup
  -> Success("stop") / cooperative failure / interruption
       => locate summary by parentID and marker by exact preallocated ID
       => if summary is finished and has no error, preserve it
       => otherwise mark existing marker + summary hidden(compaction-cancelled)
```

No other module compensates for this result. No second summary, retry, error
swallowing, catch-and-success, event terminal, projection repair or fallback is
authorized.

## R10.4 Forward And Reverse Traceability

| Requirement | File/path | Behavioral test |
| --- | --- | --- |
| Provider failure hides existing pair for auto/manual | `compaction.ts` continue-only `onExit` cleanup | real non-retry 400, parameterized `auto=false/true`, visible/raw assertions |
| summary self-overflow hides existing pair | same stop cleanup | Processor `compact` result through `run` |
| create interruption hides already-written marker | preallocated marker ID | block Started publication, interrupt, inspect visible/raw history |
| Processor-create interruption hides and terminalizes both existing objects | same cleanup after summary persistence | block `SessionProcessor.create` after summary write, interrupt, assert both hidden plus summary completed/AbortedError |
| hidden preserves already-produced accounting | cleanup spreads original summary and adds only hidden/completion/error | seed nonzero summary tokens/cost and an existing RequestUsage snapshot; after cleanup assert Message fields and usage snapshot are byte/value equivalent |
| success remains visible | finished/no-error guard | existing successful boundary tests |

| Concept | Why required | Why existing logic is insufficient |
| --- | --- | --- |
| continue-only commit predicate | `stop` is semantic failure even when Effect succeeded | `Exit.isSuccess` conflates transport and domain success |
| preallocated marker ID | abort can happen after durable marker write but before create return | post-create ID assignment cannot clean that window |
| exact pair hidden cleanup | user explicitly requires marker + summary hidden together | current cleanup is skipped for semantic stop |
| accounting-preservation assertion only | user explicitly requires already-produced usage remain counted | visibility tests alone would not detect accidental clearing; no accounting production change is authorized |

## R10.5 Exact File And Diff Budget

Only these two code/test files may differ from `HEAD` for this task:

1. `packages/opencode/src/session/compaction.ts`
2. `packages/opencode/test/session/compaction.test.ts`

Canonical plan is excluded by the user's count rule. Every R1-R7 change in
Prompt, core, SyncEvent, bridge, projector, TUI, SDK and their tests must be
removed. Generated/config/migration/dependency changes are zero.

- Planned code/test file count: 2; hard maximum: 6.
- Expected total implementation diff: 140-260 changed lines; hard maximum: 600.
- Estimated effective authored lines `E`: 110-190.
- Required qualifying Chinese comments `C`: final
  `C >= max(1, ceil(E*0.15))`; estimated 17-29.
- Comments explain semantic success versus Effect success, pre-write identity,
  completed-summary preservation and behavior-test intent; filler does not
  count.

## R10.6 TDD And Verification

Red-green slices, all in `compaction.test.ts`:

1. non-retry Provider 400 through `run`, for both auto and manual;
2. summary self-overflow returning semantic stop;
3. interruption while Started publication is blocked after marker persistence;
4. interruption after summary persistence while `SessionProcessor.create` is blocked;
5. failed cleanup with nonzero summary tokens/cost and an existing RequestUsage
   snapshot preserves both exactly;
6. existing successful Compaction and ordinary interruption regressions.

Commands from `packages/opencode`:

- narrow tests for each slice;
- `bun test --timeout 20000 test/session/compaction.test.ts`;
- `bun test test/session/messages-pagination.test.ts`;
- `bun test test/storage/cold.test.ts -t "compaction"`;
- `bun typecheck`;
- original external v1 feedback-loop command above.

Repository root:

- `git diff --check`;
- exact path/file-count and changed-line check proving only the two authorized
  code/test files and at most 600 changed implementation lines.

## R10.7 Audit And Commit Gate

The user explicitly authorized an R10 audit after the earlier over-expanded
plans. Independent plan audit must judge only the latest explicit two-object
scope, both auto/manual callers, abort/error paths, no-regression/performance,
six-file and 600-line limits, no-fallback rule, TDD sensitivity and Chinese
comment gate.

Implementation remains forbidden until exact R10 receives `No blocking
findings` and `APPROVE`. Completion additionally requires a clean independent
implementation audit. Only then may the two code/test paths and this plan be
committed with no unrelated paths, amend, hook bypass or push.

## R10.8 Plan Audit Record

| Round | Revision | Full scope | Result | Reference |
| --- | --- | --- | --- | --- |
| 8 | R8 | yes | `BLOCK — Revision R8`; missing persisted-summary/create-interrupt test | `ses_06c165084ffeB3LoLp0yxQ834U` |
| 9 | R9 | yes | `BLOCK — Revision R9`; missing accounting-preservation proof | `ses_06c05fe0cffeioNtZrNGKFEqIg` |
| 10 | R10 | yes | `No blocking findings.`; `APPROVE — Revision R10` | `ses_06bf4da23ffejRbUuOUy607mum` |

R10 independent verdict record:

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- `R10.1` 第 33 行仍写成“R9 does not create...”，按上下文应为 `R10`。这是历史修订号笔误，不改变当前范围、行为或实施授权。
- `R10.5` 要求最终只保留两个代码/测试文件相对 `HEAD` 的差异；当前暂存区仍包含 R1–R7 的 Prompt、v2、SyncEvent、TUI、SDK 等旧方案改动。计划已经明确要求移除这些改动，实施审计需按最终 diff 验证，当前 plan 阶段不构成缺陷。

## Release verdict

**APPROVE — Revision R10**

该结论只批准当前 canonical plan 的精确 `R10`。实施前需由主流程记录本次 full-scope clean verdict，并将元数据更新为 `Status: approved`、`Approved revision: R10`、`Implementation allowed: yes`。
```

R9 independent verdict record:

```text
## Blocking findings

### B-01 已产生的 token/cost/usage 缺少行为敏感的保留验证

## Release verdict

**BLOCK — Revision R9**
```

R8 independent verdict record:

```text
## Blocking findings

### B-01 未验证“summary 已写入但尚未建立 Processor”时的中断终态

## Release verdict

**BLOCK — Revision R8**
```

## R10.9 Implementation Evidence

### Actual Files And Diff

Exactly two implementation files differ from `HEAD`:

| File | Added | Deleted | Responsibility |
| --- | ---: | ---: | --- |
| `packages/opencode/src/session/compaction.ts` | 42 | 27 | continue-only commit, preallocated marker ID, exact marker/summary hidden cleanup |
| `packages/opencode/test/session/compaction.test.ts` | 276 | 9 | all approved failure, interruption, success and accounting behavior |

Total changed implementation lines: `354`, below the hard maximum `600`.
Production/test/generated file count: `2`, below the hard maximum `6`.
No Prompt, RequestUsage production, core, EventV2, SyncEvent, projector, TUI,
SDK, config, migration or dependency file remains in the task diff.

### Red-Green Evidence

- Original v1 harness and permanent Provider-400 test were red with visible
  length `3` instead of `1`; after the continue-only commit repair they pass for
  both `auto=false` and `auto=true`.
- Started-publication interruption was red because the persisted marker stayed
  visible; after preallocating `MessageID` before create it passes.
- Summary self-overflow reaches the same semantic-stop branch and passes.
- Persisted-summary/Processor-create interruption and accounting-preservation
  tests are preservation regressions required by audit: both pass and do not
  add production behavior beyond the approved cleanup.

### Verification Commands And Results

Working directory `packages/opencode` unless noted:

| Command | Result |
| --- | --- |
| `bun test --timeout 20000 test/session/compaction.test.ts -t "hides failed compaction state\|hides the marker\|terminalizes a persisted summary\|preserves recorded accounting"` | `5 pass`, then accounting fixture key correction and focused rerun `1 pass` |
| `bun test --timeout 20000 test/session/compaction.test.ts` | `71 pass`, `0 fail`, `286 expect()` |
| `bun test test/session/messages-pagination.test.ts` | `56 pass`, `0 fail` |
| `bun test test/storage/cold.test.ts -t "compaction"` | no matching tests; not counted as pass |
| `bun test test/storage/cold.test.ts` | `31 pass`, `0 fail`, `169 expect()` |
| `bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts" -t "failed compaction is absent from visible Session messages"` | `1 pass`, `0 fail` |
| `bun typecheck` | pass |
| `git diff --check` (repository root) | pass; unrelated CRLF warnings only |

### Original Feedback Loop

The exact user-visible v1 feedback loop is green. Its experimental-v2 sibling
is intentionally excluded by the user's controlling scope clarification and is
not run as completion evidence.

### Path And Fallback Verdict

- One lifecycle owner: `SessionCompaction.run`.
- Successful result: semantic `continue` only.
- Unsuccessful result: semantic `stop`, cooperative failure or interruption all
  call the same `hideIncomplete` owner.
- New alternate success paths: `0`.
- Retry, second summary, Provider switching, catch-and-success, Prompt
  compensation and projection fallback: `0`.
- Superseded R1-R7 v2/Prompt/SDK changes were removed after exact per-hunk
  ownership verification; unrelated agent/user work was not touched.

### Chinese Comment Calculation

The calculation parses added diff lines in the two implementation files:

| Metric | Actual | Exclusions |
| --- | ---: | --- |
| Effective changed code `E` | 258 | blank, import-only and comment lines excluded; no generated or pure-move task output |
| Qualifying Chinese explanatory comments `C` | 39 | only added nearby Chinese `//` lines explaining invariants/test seams counted |
| Required minimum | 39 | `ceil(258 * 0.15)` |
| Ratio | 15.12% | `39 / 258` |

Representative comments explain semantic stop versus Effect success,
pre-write marker identity, accounting-preserving spread, exact interruption
readiness and independent RequestUsage keys.

### Remaining Unverified Items

None within R10. Hard process death and experimental v2 were explicitly
excluded by the user's controlling clarification. No accounting production
logic changed; behavior tests prove persisted Message and RequestUsage values
remain equal before/after hidden cleanup.

## R10.10 Implementation Audit Record

| Round | Approved revision | Full original/current scope | Findings | Result | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | R10 | yes | `No blocking findings.`; `None.` | `APPROVE — R10 implementation` | `ses_06bd044b9ffe3rnEzX6I4bL668` |

Independent implementation verdict record:

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Release verdict

**APPROVE — R10 implementation**

该 clean verdict 仅适用于已审计的 canonical revision **R10**，以及以下两文件当前相对 `HEAD` 的完整 diff：

- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/test/session/compaction.test.ts`

其他工作树修改不在本次 release verdict 覆盖范围内。
```

# Superseded R7 And Earlier Historical Record

The remainder is non-authoritative audit history. Its Prompt assistant,
RequestUsage, v2, SDK, projection and wider file plans are explicitly excluded
from R10.

# R7 Authoritative Specification

This section is the complete current specification. Everything under
`Superseded R1-R4 Historical Record` is retained only for audit provenance and
does not authorize implementation behavior, files, tests, or generated output.

## R7.1 Requirement And Latest Clarification

Original requirement:

> 找到所有潜在的不成功压缩后仍然固定不进行hidden的逻辑链路，检查其共性以及相应的根因的修改方式，并给出较为合理且甜点级别的修复方案，整体代码修改量不超过600行，且不破坏现有的功能和性能。

Latest user clarification, which supersedes the earlier inferred experimental
v2 scope and adds a stricter file-count gate:

> 你怎么改了这么多文件？都必要吗？理论上我要求完整代码包括测试，修改不超过六个文件
>
> 我只是说的autocompact以及手动compact

Authoritative interpretation confirmed by the user:

- Canonical plan does not count as a code file.
- Production, test and generated files together must total at most six.
- Scope is the auto compact and manual compact marker/summary lifecycle visible
  through the authoritative Session Message history.
- Experimental v2 projection, live v2 store, SyncEvent identity and generated
  SDK event algebra are not part of R7 and must remain byte-unchanged.
- Target end state remains `verified-implementation-and-commit`.

## R7.2 Explicit Non-Goals

- Do not modify core SessionEvent, SessionMessageUpdater, SyncEvent,
  EventV2Bridge, v2 projector/session/TUI, SDK generated files, migrations,
  config or dependencies.
- Do not repair or retry Provider `tool_choice` serialization.
- Do not add summary retry, hard truncation, no-tool resend, a second summary,
  catch-and-success, Provider switching or any alternate success path.
- Do not add startup scans or read-time mutation for hard process termination;
  cooperative finalizers cannot run after process death.
- Do not change successful summary content, tail selection, memento, Evidence
  Handoff, auto-continue, Goal lineage or public HTTP response schema.

## R7.3 Evidence And Reachability

| Evidence | Fact | Class |
| --- | --- | --- |
| `packages/opencode/src/session/compaction.ts` `run/onExit` | every `Exit.Success`, including semantic `stop`, skipped cleanup | observed first divergence |
| `packages/opencode/src/session/processor.ts` halt path | non-retry Provider 400 persists assistant error and returns normal `stop` | observed |
| `packages/opencode/src/session/compaction.ts` create/run ordering | marker Message/Part and Started publication can yield before `run` learns the marker ID | reachable cooperative interruption |
| `packages/opencode/src/session/compaction.ts` process ordering | selected anchors were written after summary completion | reachable incomplete boundary |
| `packages/opencode/src/session/prompt.ts` compact result | manual caller unconditionally looks for a visible assistant after failed pair is hidden | observed by R4 red test |
| `packages/opencode/src/session/prompt.ts` auto-preflight ordering | runLoop persists an ordinary assistant before overflow preflight; failed auto compaction then breaks and returns that unfinished visible assistant | reachable, R5 audit B-01 |
| `packages/opencode/src/session/processor.ts` ContextOverflow path | post-provider overflow sets `needsCompaction`; cleanup completes the ordinary assistant without finish/error, then Prompt auto-compacts and can receive stop | reachable, R6 audit B-01 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` summarize | HTTP ignores Prompt's internal result and returns boolean `true` | contracted |
| `D:\Temp\opencode\compaction-failure-hidden-repro.test.ts` v1 test | real non-retry 400 returned `stop` with user + marker + errored summary all visible | red-capable observed |

Production producers in R7:

```text
auto preflight / provider overflow / manual HTTP summarize
  -> SessionCompaction.run
  -> marker + Compaction Part
  -> SessionProcessor.process
  -> Provider error or self-overflow persists errored summary
  -> processor returns semantic stop as Effect success
  -> run.onExit incorrectly treats stop as committed
  -> marker and errored summary remain visible
```

Adjacent cooperative failure windows are part of the same lifecycle:

- semantic `stop` after Provider/API/Auth/Unknown error;
- self-overflow converted from processor `compact` to errored summary + stop;
- interruption/error after marker persistence but before create returns;
- interruption between successful summary completion and anchor persistence.

A finished, no-error summary remains the sole successful durable boundary.
Failure after that boundary during optional later work must not hide it.

## R7.4 Invariants And First Divergence

| ID | Invariant | First divergence | Owner |
| --- | --- | --- | --- |
| R7-INV-01 | marker/summary are scratch until one finished, no-error summary exists; unsuccessful attempts are retained only as hidden audit data | `run.onExit` equates `Success("stop")` with semantic success | `SessionCompaction.run` |
| R7-INV-02 | cleanup identity exists before the first marker write | marker ID was allocated/returned after yielded create work | `SessionCompaction.run/create` |
| R7-INV-03 | selected anchors are durable before summary can complete | marker anchors were written after Provider completion | `SessionCompaction.process` |
| R7-INV-04 | failed cleanup is bounded near the newest attempt | cleanup hydrated the full Session | `SessionCompaction.hideIncomplete` |
| R7-INV-05 | successful compact behavior and completed boundaries remain unchanged | over-broad cleanup could hide committed summary | finished/no-error guard in Compaction |
| R7-INV-06 | manual compact never needs failed scratch to remain visible; this attempt returns a summary only when it committed | Prompt unconditionally calls visible `lastAssistant` after stop | `SessionPrompt.compact` |
| R7-INV-07 | public summarize remains boolean `true` after handled semantic stop | downstream compensation could change wire behavior | existing HTTP handler, unchanged |
| R7-INV-08 | either auto Compaction producer cannot leave or return its current ordinary assistant as unfinished visible scratch | both preflight and post-provider stop currently fall through to `lastAssistant` | `SessionPrompt.runLoop` producer/terminal transition |

The primary first divergence is `SessionCompaction.run`'s semantic commit
classification. Prompt's result assumption is the only confirmed downstream
consumer divergence created when that root cleanup is corrected.

## R7.5 Ownership And Single Primary Path

```text
run preallocates marker MessageID
  -> create persists marker/Part
  -> process selects history and stages marker anchors
  -> Provider summary attempt
  -> finished/no-error summary and semantic continue
       => preserve marker + summary; Prompt returns new summary
  -> semantic stop or pre-success cooperative failure/interruption
       => locate exact marker/summary with bounded newest lookups
       => set both hidden(reason=compaction-cancelled)
       => Prompt resolves undefined; HTTP still returns true
```

Authorized implementation details:

1. `SessionCompaction.run` allocates the marker MessageID before create's first
   persistence. A private create implementation accepts that ID; the existing
   public create wrapper still allocates its own ID.
2. Only `Exit.Success("continue")` skips cleanup. Semantic stop and Effect
   failure/interruption enter the same existing unsuccessful cleanup owner.
3. Cleanup performs at most two newest-first `Session.findMessage` lookups for
   the exact marker and its summary. A finished/no-error summary returns without
   hiding anything.
4. Selected `tail_start_id/recent_user_messages` are written to the marker Part
   immediately after selection and before Provider dispatch.
5. `SessionPrompt.compact` uses a bounded include-hidden latest row only to
   satisfy the shared Runner's internal `MessageV2.WithParts` protocol. A local
   invocation outcome gate returns that row only when this `run` returned
   `continue`; stop/interruption resolves `undefined`. Ordinary loop/shell
   `lastAssistant` behavior remains unchanged.
6. HTTP summarize remains unchanged because it already discards Prompt's
   internal result and returns `true`.
7. For both actual auto producers (preflight overflow and post-provider
   `ContextOverflowError → compact`), if Compaction returns `stop`, the same
   Prompt owner that created the current assistant marks it
   `hidden(compaction-cancelled)`, assigns a completed timestamp and aborted
   error, persists it, and returns that terminal hidden message through the
   internal loop result. It must not fall through to `lastAssistant`, remain
   unfinished, or hide an unrelated historical assistant. The helper acts only
   when the current assistant has no valid finish and no error; a normal
   completed Provider assistant remains visible. No Provider request is retried
   and no replacement assistant is created.

No new success fallback, replacement path or rollback exists. Hidden audit
retention and the existing hard-process replay guard are not success paths.

## R7.6 Forward And Reverse Traceability

| Requirement/invariant | Production path/file | Behavioral proof |
| --- | --- | --- |
| auto/manual Provider failure hidden | `SessionCompaction.run` → exact cleanup in `compaction.ts` | real 400 parameterized auto/manual; visible only original user, raw pair hidden |
| self-overflow hidden | processor compact → stop → same cleanup | run-level compact-result test |
| create interruption hidden | preallocated MessageID → create yield → cleanup | block Started publication, interrupt, assert marker hidden |
| anchors precede completion | select → marker update → Provider dispatch | pending Provider test observes anchors before completion |
| completed summary preserved | finished/no-error guard | existing success/boundary regressions |
| manual caller has explicit unsuccessful terminal | Prompt outcome gate in `prompt.ts` | one-user 400 resolves `undefined`, no stale assistant or defect |
| public manual endpoint unchanged | existing summarize handler | HTTP 400-compaction path returns `200 true`, visible history excludes pair |
| actual auto-preflight failure has no unfinished visible assistant | assistant create → overflow preflight → Compaction stop → Prompt-owned hidden/completed terminal | `SessionPrompt.loop` with forced preflight overflow + Provider 400 asserts returned assistant is hidden/completed/aborted, visible history only user, and marker/summary are hidden |
| post-provider overflow then failed auto Compaction has the same terminal | Provider ContextOverflow → Processor compact → Compaction stop → same Prompt-owned terminal helper | two sequential server responses (context overflow, then Compaction 400) assert no unfinished visible assistant and no replacement Provider attempt |
| bounded performance | two `findMessage` lookups | source seam plus existing long/cold compaction regressions; no timing assertion |

| Production concept | Requirement | Why existing logic cannot carry it |
| --- | --- | --- |
| continue-only commit guard | R7-INV-01 | Effect success does not distinguish semantic stop |
| preallocated marker ID | R7-INV-02 | ID learned after create cannot target partial persistence |
| pre-dispatch anchor staging | R7-INV-03 | post-summary write allows an unanchored completed boundary |
| targeted cleanup | R7-INV-04 | full transcript hydration is unnecessary and slower |
| Prompt invocation outcome gate | R7-INV-06/07 | latest visible assistant may be absent or belong to an older attempt |
| auto assistant terminalization | R7-INV-08 | the assistant is created by Prompt before either auto Compaction producer and is outside Compaction's marker/summary ownership | only Prompt owns the current handle across preflight and post-provider branches; expanding Compaction cleanup would guess at unrelated messages |

## R7.7 Exact File Plan And Six-File Gate

| File | Responsibility |
| --- | --- |
| `packages/opencode/src/session/compaction.ts` | lifecycle commit classification, preallocated marker ID, anchor ordering, bounded hidden cleanup |
| `packages/opencode/src/session/prompt.ts` | manual invocation terminal mapping plus Prompt-owned auto-preflight assistant terminalization, preserving shared Runner semantics |
| `packages/opencode/test/session/compaction.test.ts` | auto/manual 400, self-overflow, create interruption, anchor ordering and success regressions |
| `packages/opencode/test/session/prompt.test.ts` | manual failure `undefined`, queued handoff and successful summary return |
| `packages/opencode/test/server/httpapi-session.test.ts` | public summarize remains `200 true` with hidden failed attempt |

Planned implementation file count: exactly 5 maximum, leaving one-file
emergency margin. Any sixth file must be justified by a confirmed R7 invariant;
a seventh file is forbidden and requires user approval, not merely another plan
revision. Plan files are excluded by the user's explicit count rule. Generated
files are included by the rule and therefore remain unchanged.

After R7 approval, all existing R4 task changes outside these five paths must
be removed without altering unrelated user work. They are superseded
experimental-v2 implementation, not a fallback retained in the worktree.

## R7.8 TDD Slices

| Order | Red behavior | Minimal green | Regression |
| --- | --- | --- | --- |
| 1 | real non-retry 400 leaves two extra visible Messages for auto/manual | continue-only cleanup + exact hidden pair | reported symptom |
| 2 | processor self-overflow returns stop with visible scratch | same unsuccessful branch | overflow path |
| 3 | interruption while create publishes Started leaves marker visible | preallocate marker ID | early create window |
| 4 | Provider pending before summary but marker lacks selected anchors | stage anchors before dispatch | boundary atomicity |
| 5 | one-user manual failure defects/stales after cleanup | Prompt returns `undefined` unless this invocation committed | real manual consumer |
| 6 | public summarize with failed Provider request | unchanged HTTP `true` plus hidden history | wire behavior |
| 7 | actual `SessionPrompt.loop` preflight overflow followed by Compaction Provider 400 | Prompt finalizes/hides its pre-created assistant and returns that terminal internal result | no unfinished visible auto assistant |
| 8 | ordinary Provider returns ContextOverflow, then auto Compaction Provider returns 400 | same Prompt terminal helper finalizes/hides current handle; no fallthrough to `lastAssistant` | post-provider auto producer |
| 9 | successful summary, queued handoff, tail/memento, Evidence Handoff, cold boundary | no additional behavior | no regressions |

Tests assert public Message IDs, hidden reasons, Prompt result and HTTP response;
they do not inspect private helpers, source text or call counts as proof of the
new behavior.

## R7.9 Verification

All tests/typechecks run package-local from `packages/opencode`:

- `bun test --timeout 20000 test/session/compaction.test.ts`
- `bun test --timeout 20000 test/session/prompt.test.ts -t "manual compact"`
- `bun test --timeout 30000 test/server/httpapi-session.test.ts -t "summarize"`
- `bun test test/session/messages-pagination.test.ts`
- `bun test test/storage/cold.test.ts -t "compaction"`
- `bun typecheck`
- `bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts" -t "failed compaction is absent from visible Session messages"`

Repository root:

- `git diff --check`
- exact task-path diff/file-count check proving no more than five code/test files

The experimental v2 assertion in the old external harness is superseded by the
latest user clarification and is not a verification requirement in R7.

## R7.10 Diff And Chinese Comment Budget

| Metric | Budget |
| --- | --- |
| code/test files | 5 planned; hard maximum 6 |
| total changed implementation lines | 350-520 expected; hard maximum 600 |
| generated/config/migration/dependency files | 0 |
| effective authored lines `E` | 280-360 estimated |
| qualifying Chinese explanatory comments `C` | 42-54 estimated; final `C >= ceil(E*0.15)` |

Qualifying comments must sit beside semantic stop classification, pre-write
identity ownership, anchor ordering, completed-summary preservation, bounded
cleanup, Runner-only hidden transport, and behavior-test intent. Import-only,
blank, formatter-only and pure-move lines are excluded from E; repeated or
obvious comments do not count as C.

## R7.11 Risks, Rejected Speculation And Audit Contract

Real risks:

- Cleanup must not hide a finished/no-error summary after later optional work.
- Prompt's internal Runner message cannot be mistaken for public success.
- A bounded page selects hidden rows only for Runner transport; visible Session
  history remains governed by hidden filtering.
- Existing unrelated worktree files must remain untouched.

Rejected speculation:

- hard process kill repair, empty provider stream guard, Provider retry,
  experimental v2 projection cleanup, SDK event generation and database schema
  changes.

The independent plan auditor must audit R7 against the complete original
auto/manual requirement, latest six-file clarification, primary-path repair,
Prompt/HTTP consumer, 600-line limit, six-file limit, no-regression/performance
requirements, no-fallback rule and Chinese-comment gate. Approval requires `No
blocking findings` for exact R7.

Implementation completion still requires a full-scope independent
implementation audit. Only after `Status: verified` may the exact five task
paths plus this plan be committed with the approved Chinese commit message;
unrelated dirty paths remain uncommitted, and no amend, hook bypass or push is
allowed.

## R7.12 Plan Audit Record

| Round | Revision | Full scope | Result | Reference |
| --- | --- | --- | --- | --- |
| 5 | R5 | yes | `BLOCK — Revision R5`; B-01 auto-preflight unfinished assistant | `ses_06c36521affe8DERE1dK3eMbN5` |
| 6 | R6 | yes | `BLOCK — Revision R6`; B-01 post-provider overflow auto failure | `ses_06c2d2003ffeKqFUFfAb43RHla` |
| 7 | R7 | yes | pending | user-authorized extra round |

R6 independent verdict record:

```text
## Blocking findings

### B-01 Provider-overflow 触发的 auto Compaction 失败仍会留下可见的非终态 assistant

## Release verdict

**BLOCK — Revision R6**
```

The user explicitly authorized one additional R7 full-scope plan audit after
the original six-round limit was reached.

R5 independent verdict record:

```text
## Blocking findings

### B-01 自动预检压缩失败后仍会留下并返回未终态化的普通 assistant

## Non-blocking findings

- `R5.7` 将“Actual implementation file count”写成 exactly 5，但当前仍处于 plan 阶段，更准确的表述是 planned maximum 5。该措辞不改变六文件硬门槛。
- R5 对 superseded v2 文件的最终 byte-unchanged 要求明确；实施时还需同步移除五个保留文件内部残留的 R4 `Compaction.Cancelled` producer/断言。R5 的非目标和完整替代规范已足以禁止保留这些概念，因此当前仅记录为实施审计检查点。

## Release verdict

**BLOCK — Revision R5**
```

# Superseded R1-R4 Historical Record

The remainder of this document is non-authoritative history. Its v2 design,
generated-file plan, wider file list and R4 approval were superseded by the
user's explicit six-file and auto/manual-only clarification.

## 1. Verbatim Requirement

> 找到所有潜在的不成功压缩后仍然固定不进行hidden的逻辑链路，检查其共性以及相应的根因的修改方式，并给出较为合理且甜点级别的修复方案，整体代码修改量不超过600行，且不破坏现有的功能和性能。
>
> 目标终态：`verified-implementation-and-commit`。

The immediately preceding user clarification is part of the stable requirement:

> 理论上来说,我记得我的逻辑里面是有相应在进行auto compact或者手动compact的时候,用户直接abort,或者某些原因错误,它就会直接整个把这个compact以及相应的marker设成hidden,也就是认为这次压缩是无效的。请检查检查,当前为什么它错了还认为是有效的?

## 2. Explicit Non-Goals

- 不修复或重试触发本次现象的 Provider `tool_choice` 400；本任务只修复 Compaction 对“不成功”终态的归档、可见性和 v2 投影语义。
- 不增加 summary retry、硬截断、第二套 summary、catch-and-success、无工具重发或任何失败后备用成功路径。
- 不改变成功 Compaction 的 summary 内容、Evidence Handoff、retained tail 选择、recent user memento、auto-continue、Goal lineage、token estimate 或公开 HTTP 返回类型。
- 不改变 `compaction.auto`、`prune`、`tail_turns`、`preserve_recent_tokens`、`reserved` 配置语义。
- 不新增数据库列、migration、dependency、feature flag 或兼容分支。
- 不把 `SessionCompaction.process/create` 的测试装配接口扩展成第二个生产 lifecycle；仓库生产调用仍只经过 `run`。
- 不为进程被强杀、掉电或 `kill -9` 增加启动扫描或读时写回。此类终止没有可执行 finalizer；现有 `MessageV2.filterCompacted` 和 `CompactionBoundary.latest` 继续保证 provider replay/cold eligibility 不采用未完成边界。该限制不授权任何新的可见成功状态。
- 不修改已有无关 worktree 变更：`bun.lock`、`packages/core/src/models-snapshot.js`、`packages/opencode/package.json`、`docs/plans/daemon-startup-maintenance-recovery-ci-timeout.md`。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Compaction 是 Session context 管理；Message 是当前 part-based 持久记录；v2 是进行中迁移，不能假设与 v1 自动等价。 |
| `AGENTS.md` | 改动保持最小 owner、避免额外 helper/fallback；测试和 typecheck 必须 package-local；SDK schema 改动后必须 regenerate JavaScript SDK。 |
| `packages/opencode/AGENTS.md` | Effect module shape、错误/服务装配和 package-local 验证规则。 |
| `packages/opencode/test/AGENTS.md` | 使用真实 Effect service seam；并发/中断测试必须等待发布信号，不得固定 sleep。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | HTTP 层只做传输映射，不承接 Compaction lifecycle 修复。 |
| `docs/adr/README.md` | 本修复是现有 lifecycle 的局部 first-divergence repair，不创建新的 load-bearing ADR。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修 primary path、禁止 fallback、完成双向映射和 15% 中文解释性注释门禁。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/compaction.ts:671-698,845-1301` | `run/create/process` interface、summary result、anchor 写入、Started/Ended 发布、hideIncomplete 和 onExit guard 的权威实现。 | observed |
| `packages/opencode/src/session/processor.ts:748-832,917-1126` | Provider error 被 `halt` 持久化后转成 `Result="stop"`；ContextOverflow 转成 `Result="compact"`；processor Effect 本身成功返回。 | observed |
| `packages/opencode/src/session/prompt.ts:2478-2494,2981-2999,3101-3128` | manual、preflight auto 和 provider-overflow 三个生产 caller 都经过 `SessionCompaction.run`，并把 `stop` 当终止而非 Effect failure。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:266-288` | manual summarize 经 `SessionPrompt.compact`，HTTP 不拥有 lifecycle cleanup。 | reachable |
| `packages/opencode/src/session/message-v2.ts:71-87,1624-1731` | `compaction-cancelled` hidden contract；failed pair 不进入 provider replay；可见 Message 仍依赖真实 hidden 字段。 | contracted |
| `packages/opencode/src/session/compaction-boundary.ts:12-70` | 只有 finished/no-error summary + marker part 才是 durable boundary；失败候选不遮挡更早合法边界。 | contracted |
| `packages/opencode/src/storage/cold.ts:898-925` | cold eligibility 复用 `CompactionBoundary.latest`，不会采用本次失败 summary。 | reachable |
| `packages/opencode/src/session/session.ts:536-585,851-873` | `Session.messages` 是可见历史 seam；`findMessage` 可定点读取 newest hot candidate，避免失败 cleanup 全量 hydrate。 | observed |
| `packages/opencode/src/session/session.sql.ts:238-255` | v2 `session_message` 持久投影没有 hidden 字段，必须通过 lifecycle event 删除失败 projection。 | observed |
| `packages/core/src/session-event.ts:332-363` | v2 Compaction 只有 Started/Delta/Ended，没有取消语义。 | observed |
| `packages/core/src/session-message-updater.ts:9-74,379-410` | Started append、Ended update；Adapter 没有删除指定 Compaction 的能力。 | observed |
| `packages/opencode/src/session/projectors-next.ts:29-119,197-203` | SQLite projector 会持久化 Started，但没有失败撤销 projector。 | observed |
| `packages/opencode/src/event-v2-bridge.ts:14-79` | unversioned bridge 保留 EventV2 ID；versioned SessionEvent 当前只把 data 交给 SyncEvent，丢失原事件 identity。 | observed |
| `packages/opencode/src/sync/index.ts:59-70,148-190` | `run` 当前只接受 publish option，并在 transaction 内无条件生成新 EventID，导致 v2 projection ID 与 EventV2 ID 分叉。 | observed |
| `packages/opencode/src/v2/session.ts:221-293` | `messages()` 返回残留 row；`context()` 把最新任意 compaction row 当 cutoff，失败 Started 会影响 v2 context。 | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:769-784` | v1 Message hidden update会即时从默认 TUI store 删除，现有 consumer 已支持目标语义。 | contracted |
| `packages/app/src/context/global-sync/event-reducer.ts:186-200` | app consumer 同样在 Message hidden 时删除 Message/Parts，无需新增 UI workaround。 | contracted |
| `packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx:260-283` | experimental live store append Started、update Ended；失败后会保留空 Compaction。 | reachable |
| `packages/opencode/src/session/prompt.ts:2468-2495` | manual `compact` 在 `run` 后无条件查找可见 assistant；失败 pair hidden 后，单-user Session defect，有旧 assistant 时返回旧结果。 | reachable |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:266-287` | public summarize 忽略 Prompt 的内部 message 值并固定返回 boolean `true`，因此 Prompt 可表达 unsuccessful terminal 而不改变 wire schema。 | contracted |
| `packages/opencode/src/session/message-v2.ts:1375-1414` | bounded page 先选最新 row 再过滤 hidden；`limit:1` 不能作为 hidden cleanup 后的可见 fallback。 | observed |
| `packages/opencode/test/session/compaction.test.ts:950-981,1461-1491,1610-1636,1670-1718,2182-2343` | 现有测试只证明 Effect interruption cleanup；`compact` result 和 Tool-call error 仅测 process，不测 run 后 hidden；成功 tail/event 回归已有基础。 | observed |
| `packages/opencode/test/v2/session-message-updater.test.ts:162-217` | 只覆盖 Started→Delta→Ended，没有失败撤销。 | observed |
| commit `ad4e0d983c` | 引入 `run/hideIncomplete` 时把 `Exit.Success` 全部视为完成，并只覆盖 plugin 阶段 interruption。 | observed |
| commit `5f3d18e85b` | 明确 hidden/errored/pending Message 不能成为 retained-tail anchor，证明 stable boundary 是既有 invariant。 | contracted |
| `D:\Temp\opencode\compaction-failure-hidden-repro.test.ts` | 外部临时 harness；通过真实 processor 注入非重试 400，覆盖 v1 visible Message 和 persisted v2 projection。 | observed |

## 5. Current Behavior

```text
manual compact / auto preflight / provider overflow
  -> SessionCompaction.run
  -> create persists visible marker + Compaction Part
  -> optional Compaction.Started persists v2 Compaction row
  -> processCompaction -> SessionProcessor.process
  -> provider 400 is caught by halt and persisted as assistant.error
  -> processor returns "stop" as Effect success
  -> processCompaction returns "stop"
  -> run.onExit observes Exit.Success("stop")
  -> current guard skips hideIncomplete
  -> v1 marker + errored summary remain visible
  -> v2 Started row remains and may become SessionV2.context cutoff
```

Adjacent reachable windows share the same lifecycle/commit mistake:

1. `Result="compact"` is converted to an errored summary and normal `"stop"`, so it takes the same unhidden path.
2. `parentID` is assigned only after `create()` returns. Interruption/error after marker persistence but during Started publication leaves `parentID` undefined, so cleanup cannot identify the marker.
3. `tail_start_id/recent_user_messages` are persisted after the provider has already completed the summary. An interruption in that window lets `hideIncomplete` see a finished/no-error summary and preserve a boundary whose selected tail metadata was never committed.
4. Effect failures/interruption after `create()` returns and before any successful summary already call `hideIncomplete`; this branch is correct and remains the regression baseline.
5. A completed summary followed by an optional post-summary failure remains a valid boundary by the existing finished/no-error contract. This task must not hide an already successful summary merely because auto-continue or another later optional action fails.
6. The manual Prompt consumer currently assumes every completed `run` leaves a visible assistant. Once failure cleanup is corrected, its fallback can defect on a single-user Session or return an older assistant. That is a downstream contract divergence caused by the same unsuccessful terminal and must not be repaired by re-exposing the failed summary.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| auto Compaction returns semantic `stop` with API/Auth/Unknown/other assistant error | preflight or provider-overflow Prompt loop; provider stream | Processor persists typed error and returns `stop` | Prompt → run → process → halt → stop | SessionCompaction lifecycle | observed (400), reachable (same typed stop family) |
| manual Compaction returns semantic `stop` | HTTP summarize / SessionPrompt.compact | same `run` path as auto; HTTP ignores internal message and returns `true` | HTTP → Prompt.compact → run → hidden cleanup → Prompt terminal mapping | SessionCompaction lifecycle + SessionPrompt maintenance result | reachable |
| summary itself overflows and processor returns `compact` | SessionProcessor usage/context classification | processCompaction converts to ContextOverflowError + `stop` | run → process → compact → stop | SessionCompaction lifecycle | observed in process test, reachable through run |
| user abort after `create` returns, before summary success | SessionPrompt.cancel / fiber interruption | onExit receives failure and knows parent ID | run finalizer | SessionCompaction lifecycle | observed; currently correct |
| abort/error after marker persistence but before `create` returns | interruption during Compaction.Started publication or adjacent yielded persistence | current parent ID not yet owned by run | run → create → event publish | SessionCompaction lifecycle | reachable |
| abort after summary finish but before retained anchors persist | user cancel at Effect yield boundary | selected anchors known but written later | process → finished summary → handoff/anchor write | SessionCompaction boundary commit | reachable |
| failed attempt with experimental event system | `OPENCODE_EXPERIMENTAL[_EVENT_SYSTEM]` | Started is persisted before result; no cancellation event exists | Event bridge → projector/updater/TUI v2 | Compaction event lifecycle | observed |
| prior successful boundary followed by failed attempt | ordinary repeated Compaction | boundary query skips failed summary | latest valid boundary + failed visible debris | boundary consumer + lifecycle cleanup | reachable |
| hard process termination | OS/process termination | no finalizer can execute | persisted scratch + replay guard | existing recovery/filter contract | reachable limitation; no new production branch |
| empty provider stream with no terminal event | hypothetical provider behavior | repository has no production trace proving this shape escapes AI SDK | unknown | Provider/Processor if proven | speculative; rejected |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Compaction marker/summary are scratch until one finished, no-error summary boundary exists; unsuccessful attempts remain persisted only as hidden audit data. | Hidden schema comments; hideIncomplete comments; user requirement | interruption test only, incomplete |
| INV-02 | `run` semantic `stop` is an unsuccessful Compaction result even when the Effect exits successfully. | `run` return type and Prompt callers | missing |
| INV-03 | cleanup identity must exist before the first marker persistence so every cooperative error/interruption can target the exact attempt. | create ordering and user abort contract | missing |
| INV-04 | selected `tail_start_id/recent_user_messages` must be durable before a summary can become a completed boundary. | retained-tail contract; commits `ca28dd02ec`, `5f3d18e85b` | final-value tests only, ordering missing |
| INV-05 | v1 visible Message history, persisted v2 messages and live v2 store must agree that a failed attempt is absent. | v2 transition contract; confirmed two seams | missing |
| INV-06 | versioned EventV2 经 bridge 投影时保留同一 EventID；cancellation 只删除该 ID 的 v2 Compaction，不能删除更早成功边界。 | repeated Compaction reachability; EventV2 bridge identity contract | missing |
| INV-07 | successful Compaction, existing abort cleanup, previous valid boundary selection, auto/manual behavior and cold eligibility remain unchanged. | current success/boundary tests and user no-regression requirement | partial existing coverage |
| INV-08 | failure cleanup must stay bounded near the newest attempt and must not hydrate the full Session solely to hide two Messages. | user performance requirement; `findMessage` hot scan seam | current implementation violates only when cleanup runs |
| INV-09 | manual `SessionPrompt.compact` returns the new summary only when this attempt committed; unsuccessful maintenance resolves as `undefined`, never defects, returns an older assistant, or requires the failed summary to remain visible. Public summarize continues returning boolean `true`. | reachable Prompt/HTTP path and no-regression requirement | missing |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `run.onExit` equates every `Exit.Success`, including `Success("stop")`, with successful Compaction. | `SessionCompaction.run` | External harness receives `stop` and 3 visible Messages instead of 1. |
| INV-03 | `parentID` is assigned after `create()` returns, later than marker/part persistence and Started publication. | `SessionCompaction.run/create` | Source ordering at `create` and `run`; interruption can occur at each yielded Effect. |
| INV-04 | marker anchors are updated after provider summary completion and Evidence Handoff. | `SessionCompaction.process` boundary commit | source ordering `processor.process` before anchor `updatePart`. |
| INV-05, INV-06 | Compaction event algebra没有 unsuccessful terminal event；同时 versioned bridge 丢弃 EventV2 ID，SyncEvent 为 projection 生成另一 ID。 | `EventV2Bridge` → `SyncEvent` → `SessionMessageUpdater` | External v2 harness observes `type="compaction"` after `run` returns stop；`SyncEvent.run` source proves deterministic ID replacement. |
| INV-08 | `hideIncomplete` loads `session.messages()` for the full transcript instead of locating the newest marker/summary directly. | `SessionCompaction.hideIncomplete` | source implementation and available `Session.findMessage` seam. |
| INV-09 | `SessionPrompt.compact` unconditionally calls `lastAssistant` after `run`; corrected hidden cleanup invalidates that visible-message assumption. | `SessionPrompt.compact` maintenance result mapping | `findMessage` excludes hidden; bounded `messages(limit:1)` can select then filter the hidden summary, while an older visible assistant is not this attempt's terminal. |

### Red-Capable Feedback Loop

Working directory: `packages/opencode`

```powershell
bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts" -t "failed compaction is absent from visible Session messages"
```

Observed twice after harness wiring was complete:

```text
Expected length: 1
Received length: 3
0 pass, 1 fail
```

Second confirmed seam:

```powershell
bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts" -t "failed compaction is absent from experimental v2 messages"
```

Observed twice:

```text
Expected: false
Received: true
0 pass, 1 fail
```

The minimized fixture contains one real user Message, actual `SessionProcessor`, one non-retryable `APICallError` with the reported `tool_choice` 400, and `SessionCompaction.run(auto=true)`. Initial alias-resolution and missing-Plugin harness assembly errors did not reach assertions and are explicitly excluded from behavioral evidence.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| attempt identity and commit/abort decision | `SessionCompaction.run` | one lifecycle result `continue|stop` around marker + summary | run is the only production coordinator shared by auto/manual callers | Prompt/HTTP only select and transport the operation; Processor owns model steps, not Compaction persistence |
| boundary anchor staging | `SessionCompaction.process` | successful summary activates exactly the selected replay boundary | select and marker Part are both local here | Message filter consumes anchors but must not repair missing producer state |
| hidden persistence | `SessionCompaction.hideIncomplete` | unsuccessful cooperative exit hides only its marker/summary | existing owner and hidden reason already exist | TUI/App already consume hidden updates and need no repair branch |
| versioned event identity preservation | `EventV2Bridge` + `SyncEvent.run` | one EventV2 event keeps one ID through projection and bus publication | bridge owns conversion between the two event systems | Compaction/projector must not invent a second correlation field to compensate downstream |
| failed v2 projection removal | `SessionEvent.Compaction.Cancelled` + updater/projector | Started has one matching unsuccessful terminal transition | event producer knows the Started EventV2 ID and result; bridge now preserves it | v2 `context()` must consume committed projections, not infer failure from unrelated v1 tables |
| bounded cleanup reads | `Session.findMessage` used by Compaction | locate newest exact marker/summary without full transcript hydrate | existing hot predicate seam is designed for this | cold storage/UI must not be pulled into failure cleanup |
| manual maintenance result | `SessionPrompt.compact` | return this attempt's committed summary, or `undefined` for unsuccessful maintenance, while satisfying the shared Runner's internal message protocol | Prompt owns the internal return consumed by the HTTP handler; it observes `run`'s semantic result inside exclusive work | HTTP must not inspect persistence or compensate; Compaction must not know Prompt/Runner transport semantics |

## 10. Single Approved Primary-Path Design

```text
run allocates marker MessageID + Started EventID
  -> create persists marker/Part and publishes Started with the known EventID
  -> process selects head/tail and stages marker anchors
  -> provider summary attempt
  -> finished/no-error summary => return continue; preserve marker/summary/v2 projection
  -> semantic stop or pre-success Effect failure/interruption
       => locate exact marker/summary
       => mark existing pair hidden(compaction-cancelled)
       => publish Compaction.Cancelled(started EventID)
       => v2 updater/projector/live store remove only that projection
```

Implementation details authorized by this revision:

1. Introduce one private create implementation that accepts preallocated Message/Event IDs. Keep the existing `create` interface behavior by allocating IDs in its wrapper; `run` allocates both IDs before the first persistence call. No public Compaction API field is added.
2. Change `run.onExit` so only `Exit.Success("continue")` skips unsuccessful cleanup. `Exit.Success("stop")` and Effect failure/interruption execute the existing cleanup owner.
3. Change cleanup marker matching from “exact ID plus already-written Compaction Part” to exact preallocated marker ID. This covers interruption between Message and Part persistence without broad matching.
4. Replace full `session.messages()` cleanup scan with at most two newest-first `Session.findMessage` lookups: matching summary by parent ID and exact marker by ID. A finished/no-error summary preserves the boundary; otherwise existing candidates are marked hidden.
5. Persist `tail_start_id/recent_user_messages` immediately after `select()` and before provider dispatch. A failed attempt may retain those fields only inside hidden audit data; a successful summary cannot outrun its anchors.
6. Repair the versioned bridge identity seam once: extend `SyncEvent.run` with an optional existing EventID, use it instead of generating a new ID, and make `EventV2Bridge` pass the source EventV2 ID. Calls without an ID preserve current generated-ID behavior. This is the same event projected through two systems, not a fallback or Compaction-specific adapter.
7. Add `SessionEvent.Compaction.Cancelled` carrying the original Started EventID. It is the primary contract's unsuccessful terminal transition and never produces summary success.
8. Extend the core updater Adapter with exact-ID Compaction removal; implement it for memory and SQLite. Add the matching experimental live TUI reducer case. Earlier successful Compactions are untouched.
9. Publish Cancelled only when experimental events are enabled and the v1 cleanup found an incomplete persisted attempt. Successful summaries do not emit Cancelled even if a later optional auto-continue action fails.
10. In `SessionPrompt.compact`, replace the visible-only `lastAssistant` assumption with a bounded latest-persisted lookup that includes hidden rows solely for the shared Runner's internal `MessageV2.WithParts` protocol. Record whether this invocation's `SessionCompaction.run` returned `continue`; expose the returned summary only for that committed outcome and otherwise resolve `undefined`. The HTTP summarize handler remains unchanged because it already discards the internal value and returns `true`. This is terminal mapping, not an alternate success result.

This repairs the first divergence. It does not retry Compaction, synthesize a summary, switch Provider behavior, or route failure through another success algorithm.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| completed summary + committed anchors | current, reordered | primary-contract branch | yes | ~70% | preserve/repair |
| semantic `stop` cleanup | current, expanded to correct outcome | primary-contract unsuccessful branch | no | ~20% | repair |
| Effect interruption/failure cleanup | current | primary-contract unsuccessful branch | no | ~5% | preserve and extend early identity coverage |
| direct `create/process` calls in compaction tests | current | non-production test seam | no production result | 0% production | preserve for focused selection/format tests; do not add production callers |
| EventV2 ID preservation through versioned bridge | proposed | contracted pass-through | no | ~3% | repair bridge identity seam |
| Compaction.Cancelled event | proposed | primary-contract unsuccessful branch | no | ~5% | add |
| `MessageV2.filterCompacted` hard-exit guard | current | existing correctness compatibility/guard | no | 0 changed | preserve |
| summary retry/hard truncate/no-tool resend | rejected | forbidden fallback | would | 0% | reject |
| v2 context infers success by inspecting v1 tables | rejected | responsibility leak/fallback | no | 0% | reject |

New alternate success paths: 0. Replacement/rollback paths: 0. Diagnostic decision-surface estimate: 0%; Cancelled is the primary lifecycle's unsuccessful terminal transition.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `Exit.isSuccess(exit)` blanket skip | distinguished abort defects from successful operation before semantic stop was considered | only `continue` proves Compaction success | replace guard in `compaction.ts` |
| full `session.messages()` cleanup scan | convenient pair discovery | preallocated identity + `findMessage` locates exact newest pair without full hydration | collapse in `hideIncomplete` |
| no-op absence of v2 failed terminal state | v2 initially modeled only success | confirmed failed Started row corrupts visible/context projection | replace absence with Cancelled transition |
| versioned bridge-generated replacement ID | SyncEvent originally owned standalone event creation | EventV2Bridge projects an already-identified event, so replacement identity breaks exact correlation | allow `SyncEvent.run` to preserve caller-supplied EventID; retain generation for all ordinary callers |

`filterCompacted` is not deleted: it remains the unavoidable hard-process-exit correctness guard and is not a replacement success path.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| failed auto/manual attempts hidden | run stop/failure → hide exact pair | `packages/opencode/src/session/compaction.ts` | actual 400 through run, parameterized auto/manual visible/raw assertions |
| summary self-overflow hidden | processor compact → process stop → run cleanup | `compaction.ts` | run with existing compact-result processor fixture |
| abort during create cannot lose identity | preallocate IDs → create → cleanup | `compaction.ts` | block Started publication, interrupt, assert bare/complete marker absent visibly and hidden raw |
| anchors precede successful boundary | select → marker update → provider request | `compaction.ts` | block provider stream after dispatch; inspect staged `tail_start_id`, then interrupt |
| failed v2 projection absent | bridge preserves Started ID; Cancelled → updater/projector/store remove exact ID | SyncEvent/bridge, core event/updater, projector, sync-v2 | SyncEvent supplied-ID test; real 400 captures Started projection ID then `SessionV2.messages` proves exact removal; updater exact-ID unit test |
| prior successful boundary preserved | cancellation exact ID and v1 pair identity | same | success then failed attempt; prior boundary/context remains |
| no performance regression | targeted newest hot lookup | `compaction.ts` | behavior test with cold/large prefix remains bounded by seam; source decision backed by existing `findMessage` contract; no timing threshold |
| successful behavior unchanged | continue path | same | existing full compaction suite, tail/memento/autocontinue/event tests |
| manual failure reaches Prompt/HTTP without stale return or defect | `run(stop)` → hidden cleanup → Prompt maps unsuccessful terminal to `undefined` → HTTP discards it and returns `true` | `packages/opencode/src/session/prompt.ts`; handler unchanged | Prompt test with one user + provider 400 asserts `undefined` and hidden persistence; HTTP test asserts summarize returns `200 true` and visible history excludes failed pair |
| verified implementation and commit | clean implementation audit → exact-path commit | Section 25; only this task's paths | commit hash + final `git status`; no push/amend/unrelated staging |

The experimental live TUI reducer has no isolated public harness today. Its case must delegate the same exact EventID removal contract tested through `SessionMessageUpdater` and persisted `SessionV2.messages`; package typecheck and generated event union cover schema drift. Creating a TUI-only testing interface would violate the no-test-only-production-code gate.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| preallocated marker/Event IDs | INV-03, INV-05 | create-stage interruption reachability | IDs allocated after create cannot clean partial persistence or identify v2 Started |
| continue-only commit guard | INV-01, INV-02 | observed `Success("stop")` leak | Effect success is transport/control success, not Compaction semantic success |
| pre-dispatch anchor staging | INV-04 | source ordering window and retained-tail contract | post-summary write allows a completed summary with absent selected anchors |
| exact targeted cleanup lookup | INV-01, INV-08 | full-history current scan; `findMessage` contract | current scan is unnecessary work on large Sessions and cannot see a pre-Part marker by its current predicate |
| supplied-ID SyncEvent pass-through | INV-05, INV-06 | bridge deterministically loses EventV2 ID today | downstream Compaction correlation cannot recover an identity discarded by the bridge owner |
| Compaction.Cancelled event | INV-05, INV-06 | observed v2 residual row; no existing terminal event | Ended means success and cannot represent failed removal; v1 hidden event is outside v2 event ownership |
| exact-ID updater/projector removal | INV-05, INV-06 | repeated Compaction is reachable | “remove current/latest” could delete an older valid boundary after ordering changes |
| Prompt committed-result gate | INV-09 | public manual summarize reaches `run(stop)` after cleanup; current visible lookup defects or returns stale assistant | neither a hidden failed summary nor an older assistant represents this invocation; only the locally observed `continue` result authorizes returning the new summary |

No new setting, retry, parser, schema column, migration, dependency, cache, fallback, alternate summary or compatibility adapter is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/compaction.ts` | modify | preallocate lifecycle identity, stage anchors, classify continue vs stop, targeted hidden cleanup, publish Cancelled | +25 to +45 net |
| `packages/core/src/session-event.ts` | modify | define Compaction.Cancelled and include it in `All` | +8 to +14 |
| `packages/core/src/session-message-updater.ts` | modify | Adapter exact-ID removal and Cancelled reducer | +12 to +22 |
| `packages/opencode/src/sync/index.ts` | modify | accept optional existing EventID while preserving generated IDs for ordinary callers | +5 to +10 |
| `packages/opencode/src/event-v2-bridge.ts` | modify | pass source EventV2 ID into versioned SyncEvent projection | +3 to +7 |
| `packages/opencode/src/session/projectors-next.ts` | modify | SQLite exact-ID removal and Cancelled projector | +10 to +18 |
| `packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx` | modify | remove matching live Compaction on Cancelled | +6 to +12 |
| `packages/opencode/test/session/compaction.test.ts` | modify | vertical lifecycle failure/abort/anchor/v2 integration slices | +90 to +145 |
| `packages/opencode/test/v2/session-message-updater.test.ts` | modify | exact cancellation reducer behavior and prior-boundary preservation | +25 to +45 |
| `packages/opencode/test/sync/index.test.ts` | modify | supplied EventID is preserved in persisted row and published bus event | +20 to +35 |
| `packages/opencode/src/session/prompt.ts` | modify | map manual maintenance `continue` to the committed summary and unsuccessful outcomes to `undefined`; retain bounded Runner transport lookup | +12 to +22 |
| `packages/opencode/test/session/prompt.test.ts` | modify | real manual one-user Provider failure resolves `undefined` with hidden attempt; successful summary return remains intact | +20 to +35 |
| `packages/opencode/test/server/httpapi-session.test.ts` | modify | public summarize failure path still returns `200 true` and does not expose failed Compaction messages | +20 to +35 |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | generated modify | preserve the committed generated baseline while transplanting only generator-emitted Cancelled declarations and union memberships | +18 to +25 generated |

R3 records the now-observed generator boundary instead of treating it as a
hypothetical risk. Full generation from the current source changes 914 lines in
`types.gen.ts`, including pre-existing `session.forked`, `summaryOnly` and type
ordering drift from 31 source commits after the last SDK touch. Those changes
are not caused by Compaction.Cancelled and are not authorized.

The generated-file procedure is therefore deterministic and schema-bounded:

1. Preserve the committed `types.gen.ts` as the compatibility baseline.
2. Run the repository's `Server.openapi()` and the exact `createClient`
   configuration from `packages/sdk/js/script/build.ts` into a repository-external
   oracle directory, then run the same Prettier formatting.
3. A repository-external one-shot Bun transformer reads the baseline and oracle,
   extracts only the named `EventSessionNextCompactionCancelled` and
   `SyncEventSessionNextCompactionCancelled` declarations, and inserts their
   generated union memberships immediately after the corresponding Ended
   memberships. It writes no production source and is not committed.
4. Verify that every transplanted declaration is byte-identical to the oracle,
   that exactly the expected five memberships/declarations exist, and that the
   final repository diff contains no `session.forked`, `summaryOnly`, ordering
   move or other pre-existing generator drift.

This is not an authored SDK contract or a fallback generator. The full official
generator remains the sole schema oracle; the transformer only excludes proven
unrelated drift from the task diff. Any ambiguity, duplicate insertion point or
additional Cancelled-derived generated file stops implementation and requires a
new revision rather than guessing.

## 16. TDD Behavior Slices

Agreed seams: `SessionCompaction.run → Session.messages`, and `SessionMessageUpdater`/actual event projection → `SessionV2.messages`.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | non-retry 400 returns stop; auto/manual visible history excludes marker + errored summary while includeHidden retains both | Success(stop) skips cleanup | continue-only commit guard + exact hidden pair | reported symptom |
| 2 | processor compact result through `run` is hidden | process maps compact to normal stop | same lifecycle cleanup, no special fallback | summary re-overflow |
| 3 | interruption during Started publication leaves no visible partial marker and no v2 projection | IDs are learned after create returns; v2 has no Cancelled | preallocated IDs + Cancelled exact removal | early create window |
| 4 | selected retained anchor is already on marker while provider summary is pending | anchor currently written after provider completion | stage marker metadata before dispatch | summary/anchor atomicity |
| 5 | supplied EventV2 ID survives SyncEvent persistence and bus publication | bridge currently asks SyncEvent to generate another ID | optional ID pass-through at bridge owner | exact cancellation identity |
| 6 | successful boundary followed by failed attempt captures actual Started projection ID, then keeps prior boundary and removes only that failed row | no failed terminal event and current bridge ID replacement | preserved Started EventID + exact cancellation | repeated Compaction |
| 7 | one-user manual Prompt/HTTP compact receives Provider 400 after cleanup | Prompt assumes a visible assistant still exists; it defects or returns stale history | Prompt returns `undefined` for this unsuccessful invocation; HTTP remains `200 true` and failed pair stays hidden | real manual producer and public consumer |
| 8 | existing successful Compaction, successful Prompt summary return, ordinary before-summary abort, Evidence Handoff, tail, memento, auto-continue and cold-boundary tests remain green | guards against over-broad hiding/reordering or weakening successful compact | no additional behavior | complete regression |

Each slice uses literal visible/hidden/message IDs or known event IDs. Tests do not assert private helper calls, source text, call counts or duplicate production algorithms.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 340-420 | production + tests; exclude imports, blank/format-only, generated SDK and pure moves |
| Required Chinese explanatory comments `C` | 51-63 | `ceil(E*0.15)` across the full estimate range; implementation must calculate actual E and use actual ceiling |

Planned qualifying explanations are distributed beside:

- Compaction semantic success (`continue`) versus Effect success (`stop` is still unsuccessful).
- preallocated identity before first persistence and why exact ID covers partial create.
- anchor-before-summary commit ordering and why failed hidden audit data may contain anchors.
- completed summary preservation after later optional failure.
- exact-ID v2 cancellation so older successful boundaries survive.
- bridge 只对已有 EventV2 identity 做 pass-through，普通 SyncEvent caller 继续生成 ID。
- targeted newest lookup preserving large/cold Session performance.
- behavior-test intent for 400, self-overflow, create interruption, pending anchor and prior-boundary preservation.
- Prompt's Runner-only hidden transport value versus its public committed-result contract.

Comments will not restate assignments, translate identifiers, duplicate test names or split one explanation into artificial fragments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/compaction.test.ts -t "failed compaction"` | `packages/opencode` | new stop/400/self-overflow/early-interrupt slices red then green |
| `bun test test/v2/session-message-updater.test.ts` | `packages/opencode` | Cancelled removes exact projection and preserves prior Compaction |
| `bun test test/sync/index.test.ts -t "provided event id"` | `packages/opencode` | SyncEvent persistence + bus publication preserve supplied EventV2 identity |
| `bun test test/session/compaction.test.ts` | `packages/opencode` | full Compaction success/failure/tail/memento/autocontinue regression |
| `bun test test/session/prompt.test.ts -t "manual compact"` | `packages/opencode` | successful summary return remains; provider failure resolves `undefined` without visible scratch |
| `bun test test/server/httpapi-session.test.ts -t "summarize"` | `packages/opencode` | public manual endpoint remains `200 true` while failed attempt stays hidden |
| `bun test test/session/messages-pagination.test.ts` | `packages/opencode` | hidden Message pagination remains intact |
| `bun test test/storage/cold.test.ts -t "compaction"` | `packages/opencode` | completed boundary/cold eligibility remains unchanged where matching tests exist |
| `bun typecheck` | `packages/core` | core event/updater types |
| `bun typecheck` | `packages/opencode` | Compaction/projector/TUI integration types |
| exact `Server.openapi()` + `createClient` + Prettier stages from `script/build.ts`, with output in `D:\Temp\opencode` | `packages/opencode`, then `packages/sdk/js` | produce the full schema oracle without committing unrelated generator drift; the wrapper itself was attempted twice and produced a zero-byte redirected spec on this Windows host |
| repository-external generated-delta transformer + oracle comparison | repository root | final `types.gen.ts` contains only byte-identical Cancelled generated nodes and no pre-existing drift |
| `bun typecheck` | `packages/sdk/js` | generated SDK types |
| `bun test "D:\Temp\opencode\compaction-failure-hidden-repro.test.ts"` | `packages/opencode` | original external v1 + v2 feedback loop turns green |
| `git diff --check` | repository root | whitespace integrity |

No tests run from repository root. No timeout increase, skip, mock-only private assertion or error swallowing is allowed.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 implementation files; 1 canonical plan | no new module or migration |
| Files modified | 13 authored + 1 generated | lifecycle owner, Prompt result consumer, bridge identity seam, one event chain, five test files |
| Files deleted | 0 | no standalone obsolete module |
| Production lines | 105-165 authored | lifecycle classification, Prompt terminal mapping, bridge identity pass-through, event terminal state and exact projection removal |
| Test lines | 185-280 | behavior-sensitive vertical slices, real Prompt/HTTP consumer, bridge identity and updater coverage |
| Generated lines | 18-25 | two generated declarations plus three union memberships, extracted byte-for-byte from the full oracle |
| Total implementation diff | 500-580 expected; hard maximum 600 | based on observed authored diff plus minimal Prompt/HTTP consumer coverage and schema-bounded generated output |

The 600-line limit includes authored and schema-bounded generated implementation
diff for this task, excluding this plan. The 914-line full-oracle drift is not
part of the implementation because it is neither retained nor committed. If the
final task diff exceeds 600 changed lines after unrelated drift is excluded by
the deterministic procedure above, stop and revise/audit rather than omit
behavior or author generated declarations.

## 20. Real Risks and Open Decisions

### Real Risks

- Event-v2 is experimental but reachable whenever `OPENCODE_EXPERIMENTAL` or `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` is enabled; leaving it unfixed would preserve a confirmed context cutoff bug.
- SyncEvent supplied-ID support changes a shared seam, so tests must prove omitted IDs still generate normally and supplied IDs reach both persistence and bus unchanged.
- Cleanup finalization must not hide a finished/no-error summary after a later optional auto-continue/plugin failure. The completed-summary check remains authoritative.
- Compaction Started cancellation must use the original EventID. Deleting “latest” can remove a previous successful Compaction after repeated attempts.
- Moving anchor persistence earlier changes only failed hidden audit rows; successful provider input and selected values remain identical. Tests must prove no tail selection drift.
- Full SDK generation demonstrably exposes unrelated historical drift. R3 permits only byte-identical Cancelled nodes extracted from the full generator oracle; any other generated change remains unauthorized.

### Open Decisions Requiring the User

None. The user confirmed both the authoritative Message seam and experimental event-v2 seam for feedback/TDD.

### Rejected Speculation

- A truly empty AI SDK stream without terminal finish has no observed production trace in this task. It does not justify a new Processor guard here.
- Startup-wide scanning or read-time mutation for hard process death would add a second maintenance path and measurable Session-load work. Existing hard-exit replay/boundary guards remain; no cooperative finalizer can guarantee a post-kill hidden write.
- Repairing Provider `tool_choice` serialization is a separate first divergence and is not required to make every confirmed unsuccessful Compaction cleanup correct.
- Adding hidden/status columns to v2 `session_message` would require migration and duplicate the event lifecycle; exact cancellation already owns the confirmed projection problem.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the 600-line hard cap, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01 预分配的 EventV2 ID 无法命中实际的 v2 Compaction 投影`; `B-02 最终 commit 目标没有可执行映射` | `Metadata 中 Audit mode 不一致`; `Compaction.Cancelled 分类偏差`; `create/process 测试 seam 未列入 §11` | `BLOCK — Revision R1` | `ses_06cb7ea58ffefX9sAHWC1Zg9zG` |
| 2 | R2 | yes | `No blocking findings.` | `None.` | `APPROVE — Revision R2` | `ses_06caceab1ffext5l0oXESmnxLt` |
| 3 | R3 | yes | `B-01 隐藏失败 Message 后，manual Compaction 的调用方仍要求返回可见 assistant` | `None.` | `BLOCK — Revision R3` | `ses_06c6254faffeHQhjCPpOFV1Hnz` |
| 4 | R4 | yes | `No blocking findings.` | `当前 worktree 已存在与本计划相关的部分生产代码、测试和生成文件修改，但计划仍记录为 Implementation allowed: no、Pending approved implementation。` | `APPROVE — Revision R4` | `ses_06c53bfd5ffeUFTLarmTZRCKFv` |

### Round 1 Verdict Record

The following finding identifiers, classifications, titles, and release verdict
are copied verbatim from the independent auditor result:

```text
# Blocking findings

### B-01 预分配的 EventV2 ID 无法命中实际的 v2 Compaction 投影

### B-02 最终 commit 目标没有可执行映射

# Non-blocking findings

- Metadata 中 `Audit mode: full-scope` 与本次输入的 `Audit mode: plan` 不一致。审计范围实际上按 full-scope plan audit 执行，没有造成范围缩减；建议下个 revision 改为 `plan`，并继续单独记录 `Full scope: yes`。
- `Compaction.Cancelled` 被归类为 diagnostic path，但它实际承担失败 lifecycle 的投影撤销。它不产生成功结果，因此当前分类偏差本身不构成 fallback；修订时可将其明确归入 primary contract 的 unsuccessful terminal transition。
- `create/process` 测试装配接口没有列入 §11 成功路径表，但 §2 已明确其没有生产 caller，仓库搜索也只发现测试调用。可以补记为非生产测试 seam，无需为它新增 lifecycle。

# Release verdict

**BLOCK — Revision R1**
```

R2 resolves B-01 by repairing identity pass-through at `EventV2Bridge →
SyncEvent.run` and requiring the actual Started projection ID in tests. R2
resolves B-02 in Section 25. R2 also applies all three non-blocking record
corrections. Approval remains cleared and implementation remains disallowed
until a new full-scope audit approves R2.

### Round 2 Verdict Record

The following verdict is copied verbatim from the independent auditor result:

```text
# Blocking findings

No blocking findings.

# Non-blocking findings

None.

# Release verdict

**APPROVE — Revision R2**

该 verdict 仅适用于 `docs/plans/compaction-failure-hidden-lifecycle.md` 当前 **R2** 的完整计划。任何行为、接口、测试、ownership、fallback classification 或文件计划的实质修改都必须递增 revision、清除 approval，并重新执行 full-scope plan audit。
```

### Round 3 Verdict Record

The following finding identifier, classification, title, non-blocking result,
and release verdict are copied verbatim from the independent auditor result:

```text
# Blocking findings

### B-01 隐藏失败 Message 后，manual Compaction 的调用方仍要求返回可见 assistant

# Non-blocking findings

None.

# Release verdict

**BLOCK — Revision R3**
```

R4 resolves B-01 by assigning the internal maintenance result to
`SessionPrompt.compact`: only this invocation's observed `continue` returns the
new summary, while unsuccessful maintenance resolves `undefined`. The shared
Runner may transport a hidden persisted message internally, but that value is
not exposed as success. The unchanged HTTP handler continues to return boolean
`true`; new Prompt and HTTP behavior tests cover the real manual producer and
consumer.

### Round 4 Verdict Record

The following verdict is copied verbatim from the independent auditor result:

```text
# Blocking findings

No blocking findings.

# Non-blocking findings

- 当前 worktree 已存在与本计划相关的部分生产代码、测试和生成文件修改，但计划仍记录为 `Implementation allowed: no`、`Pending approved implementation`。这属于流程状态偏差，不改变 R4 方案本身的可执行性，也未形成行为级计划缺陷。本次结论只批准 R4 计划，不审计或批准这些现有实现修改。

# Release verdict

**APPROVE — Revision R4**

该 clean verdict 仅适用于 `docs/plans/compaction-failure-hidden-lifecycle.md` 的当前 **R4** 完整计划。现有 worktree implementation diff 尚未经过本次审计；任何行为、接口、测试、ownership、fallback classification 或文件计划的实质修改都必须递增 revision、清除 approval，并重新执行 full-scope plan audit。
```

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

Pending approved implementation.

### Red-Green Test Evidence

Pending approved implementation.

### Verification Commands and Results

Pending approved implementation.

### Original Feedback-Loop Result

Current red evidence is recorded in Section 8. Green evidence is pending approved implementation.

### Actual Secondary and Replacement Path Inventory

Pending approved implementation.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | pending |  |
| Qualifying Chinese comment lines `C` | pending |  |
| Ratio `C / E` | pending | `N/A` when `E = 0` |
| Required minimum `C` | pending | `if E = 0: C = 0`; `if E > 0: C >= max(1, ceil(E * 0.15))` |

### Remaining Unverified Items

Pending approved implementation.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | yes |  |  | pending |  |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

## 25. Post-Verification Commit

This stage executes only after the current implementation receives a full-scope
`No blocking findings` verdict, that verdict is recorded in Section 24, and the
plan status is `verified`.

1. Run in parallel from the repository root: `git status --short`, `git diff -- <all task paths>`, `git diff --cached`, and `git log --oneline -10`.
2. Derive the final task path list from Section 23 actual evidence. Confirm none of those paths contains unrelated edits; if one does, stop rather than mixing ownership.
3. Preserve all unrelated current changes, including `bun.lock`, `packages/core/src/models-snapshot.js`, `packages/opencode/package.json`, and `docs/plans/daemon-startup-maintenance-recovery-ci-timeout.md`.
4. Add only this task's untracked paths, including this canonical plan, with `git add -- <untracked task paths>`.
5. Commit only the complete task path list with `git commit --only -- <task paths>`. Use the Chinese multi-line message:

   ```text
   fix(compaction): 隐藏未完成压缩并统一投影终态

   以成功 summary 边界作为唯一提交条件，确保 stop、中断和错误尝试不会残留可见 marker。
   保持 EventV2 identity 穿过 SyncEvent 投影，并精确撤销失败 Compaction，避免影响既有成功边界。
   ```

6. Do not amend, skip hooks, use `--no-verify`, push, clean, reset or alter unrelated staging.
7. If a hook rejects the commit, repair the cause within the approved task paths, rerun required verification and create a new commit attempt; never amend a rejected attempt.
8. Verify the resulting commit with `git status --short` and `git log -1 --format="%H%n%s"`. Record the commit hash and prove unrelated worktree changes remain present and uncommitted.
9. Only after this evidence exists may the GOAL reach `verified-implementation-and-commit` and be marked complete.
