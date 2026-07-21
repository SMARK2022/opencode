# Canonical Implementation Plan: Goal Continuation Card Badges

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL original requirement plus the user's confirmed TUI design decisions in the originating Session
>
> Implementation allowed: no; implementation verified
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

Session GOAL original requirement:

> 实现相应的goal显示面板的修改逻辑，也就是在goal触发的continuation卡片里面下方增加用户要求的方格，同时方案保持克制，整体修改代码文件数量不超过6个，同时修改行数不超过800行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。

Confirmed design constraints from the originating Session:

> “Goal continuation” 请注意这个标签之前是渲染的,但是这个渲染是有点怪的。因为这个渲染当时只是在相应的渲染好的用户消息的上面,多渲染一个Continuation的一个标签,它和相应GOAL的标签是分离的,这就会导致存在部分的问题。所以当时我就让他把它取消掉了。我现在想的是让其变成一体的设计,也就是理论上而言,这个内容不应该分开设计,而应该放在同一个具体的卡片里面进行显示。

> 请注意如果你显示的话,请显示重温本到当前的TUI中,不要放在浏览器里。纯文本。

> 完整正文 + 底部标签。

> 模式 + 轮次。

> 只保留 Revert。

> 回退最近 continuation。

> blockcheck不要写1/2，过长且没必要。

> AFTER ERROR 不是正常语义，且需要额外状态机，没必要且用户很容易分辨出来，因为上方就是error；因此理论上不进行区分。

> BLOCK CHECK > REPLAN > CONTINUE。

> 沿用 agent 颜色。

> 注意中间要有空格一类的，可以加上计数，计数按照goal的maxturn的那个计算逻辑的状态机来显示。

> （两个方格中间要有间距）

> 请注意理论上这些内容不可能触发continue，所以不可能，我没说的东西都不显示，请保持方案克制。

The accepted terminal composition is one existing user-style card, not two
stacked cards:

```text
│ 完整的 Goal objective……
│
│ [ GOAL ] [ CONTINUE · 3 / 32 ]
```

The two badges are separate boxes with one TUI-column gap. The mode badge may
instead read `REPLAN` or `BLOCK CHECK` under the priority recorded below.

## 2. Explicit Non-Goals

- Do not restore the historical detached `Goal continuation` card or render a
  label above the existing user-style card.
- Do not change the Message's Agent identity color. The existing left border
  and the new `GOAL` badge use the same Agent color.
- Do not show `ACTIVE`, `PAUSED`, `COMPLETE`, or terminal `BLOCKED` on a
  continuation card. Those conditions do not create a continuation.
- Do not distinguish normal completion from `continueOnError`; the preceding
  error already carries that information and no new error-display state is
  introduced.
- Do not show blocked attempt fractions such as `1/2`.
- Do not add a cumulative Goal-lifetime turn counter. Use the existing
  run-local `goalTurns / goal_max_turns` values and reset behavior.
- Do not change the model-facing continuation prompt, Goal lifecycle, Goal SQL
  schema, Goal HTTP/SDK contract, sidebar, footer, App/web UI, transcript,
  timeline, fork, copy, retry, or prompt-history semantics.
- Do not add a feature flag, fallback renderer, new dependency, migration,
  generated file, or speculative malformed-input envelope.
- Do not change `/undo`: it continues to Revert the latest continuation first
  and does not place synthetic continuation text in the prompt.
- Do not exceed six changed code files or 800 changed code lines. This
  canonical documentation file is not a code file and is tracked separately.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Goal as a Session-owned structured objective, Message as the persisted Part-based record, Agent as the identity/color owner, and Revert as the working-tree restoration operation. It also identifies `packages/opencode` as the current production implementation. |
| Root `AGENTS.md` | Requires parallel tooling, minimal cohesive changes, no `any`, package-local tests/typecheck, and preservation of unrelated worktree changes. |
| `packages/opencode/AGENTS.md` | Requires module-local ownership and records the real OpenTUI development/verification boundary. No DB, Effect service, or module-shape change is needed here. |
| `packages/opencode/test/AGENTS.md` | Requires behavior-level Effect fixtures, real implementation over mocks, and published readiness signals instead of sleeps. |
| `.opencode/policy/first-principles-engineering.md` | Requires one primary path, evidence-bounded compatibility, no fallback, forward/reverse mapping, full independent audits, and `C >= ceil(E * 0.15)`. |
| `.opencode/templates/canonical-plan.md` | Defines the canonical artifact, approval fields, evidence tables, audit record, and implementation evidence contract. |
| `docs/adr/README.md` and ADR-0001 | The only accepted ADR concerns triage and does not constrain Goal/TUI rendering. A task-local presentation decision does not warrant a new ADR. |
| Confirmed TDD seam | The user approved `SessionPrompt.loop` persisted Message/Part output and the real OpenTUI Session frame/action dialog as the two behavior seams. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/prompt.ts:2522-2697` | `runLoop` owns `goalTurns`, `goal_max_turns`, progress-gate mode, blocked Tool history, and synthetic continuation creation. It currently stores only `goal_continuation: true`. | observed |
| `packages/opencode/src/session/prompt.ts:144-173` | Goal turn eligibility already trusts the structured `goal_continuation` marker, establishing it as the internal subtype discriminator. | observed |
| `packages/opencode/src/session/goal.ts:549-648` | Defines `ordinary`/`replan` prompt modes and the exact persisted XML envelope/objective representation. | observed |
| `packages/opencode/src/tool/goal.ts:109-156` | Owns model transition results. The first blocked call returns `blocked-pending` but currently emits empty metadata plus prose/title. | observed |
| `packages/opencode/src/session/processor.ts:280-325` and `:67-70` | Completed Tool result metadata is durably written to `ToolPart.state.metadata`; only `_formattedContent` and `_syncInput` are stripped. A Goal transition marker will survive unchanged. | observed |
| `packages/opencode/src/session/message-v2.ts:143-156`, `:535-548` | Stored and input TextParts already accept metadata records, so continuation render snapshots need no schema migration. | contracted |
| `packages/sdk/js/src/v2/gen/types.gen.ts:647-666`, `:2032-2045` | Generated SDK TextPart and TextPartInput expose metadata as `[key: string]: unknown`; no SDK regeneration is required. | contracted |
| `packages/opencode/src/config/config.ts:289-292` | `goal_max_turns` is a non-negative run-local auto-continue limit with default 32. | contracted |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1347-1373`, `:1452-1572` | All role=`user` Messages enter `UserMessage`; synthetic XML objective is shown in the ordinary user card, without Goal badges, and click always opens generic actions. Existing file badges establish the two-box visual vocabulary. | observed |
| `packages/opencode/src/cli/cmd/tui/context/local.tsx:46-102` and `context/theme.tsx:53-69` | `local.agent.color(message.agent)` owns Message identity color; `selectedForeground` supplies readable foreground on that background. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx:23-145` | Generic role=`user` actions are Revert, Retry, Copy, and Fork. Prompt extraction already excludes synthetic text, so the existing Revert path naturally leaves the prompt empty. | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:738-798` | `/undo` selects the latest user Message, Reverts it, and filters synthetic text from prompt refill. This path already matches the confirmed contract and remains untouched. | observed |
| `dialog-timeline.tsx:25-47`, `dialog-fork-from-timeline.tsx:22-72`, `util/transcript.ts:84-111` | Existing non-card consumers already exclude synthetic text. No change is required or authorized. | observed |
| `packages/opencode/test/session/prompt.test.ts:4195-4659` | Existing integration fixtures cover error continuation, replan mode, max turns, and persisted continuation text; they are the approved producer seam. | observed |
| `packages/opencode/test/tool/goal.test.ts:203-279` | Existing Tool behavior proves first blocked call remains active and returns blocked-pending guidance. | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | Existing `testRender` Session harness exercises actual OpenTUI frames, spans/colors, mouse hitboxes, and dialogs; no test-only production helper is needed. | observed |
| Baseline `bun test test/session/prompt.test.ts -t "goal progress gate switches to replan"` | Passed: 1 test, 6 assertions. Confirms the producer fixture is runnable before implementation. | observed |
| Baseline `bun test test/tool/goal.test.ts -t "blocked streak through tool"` | Passed: 1 test, 18 assertions. Confirms blocked-pending production behavior before metadata enrichment. | observed |
| Baseline `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "narrow viewport keeps the user message"` | Passed: 1 test, 2 assertions. Confirms the real OpenTUI Session harness is runnable before the new red slice. | observed |
| Git history/blame for Goal continuation introduction and current source search | Confirms persisted sessions can contain both pre-marker XML continuations and marker-only continuations, while no detached `Goal continuation` renderer remains in current source. | observed |

## 5. Current Behavior

The current producer-to-consumer path is:

```text
normal/error completion while Goal is active
  -> SessionPrompt reads goal_max_turns and increments run-local goalTurns
  -> progress gate selects ordinary or replan model-facing prompt
  -> prompt() persists a synthetic user TextPart
       metadata = { goal_continuation: true }
       text = exact <session-goal-continuation> XML
  -> Session sync loads the Message and Part
  -> role=user routes to UserMessage
  -> UserMessage extracts <objective> from every synthetic TextPart it recognizes
  -> one ordinary user-style card shows only objective text
  -> clicking the card opens generic DialogMessage actions
```

The producer already has the three presentation facts requested by the user:

- `continuationMode` is `ordinary` or `replan`;
- `goalTurns` is incremented immediately before persistence;
- `maxGoalTurns` is the configured/default run-local limit.

It also has every assistant ToolPart whose `parentID` is the current eligible
user Message; the existing progress collector already proves that one user turn
can span multiple assistant provider steps. A first Goal blocked call
is represented by GoalTool's `blocked-pending` result, but only its title/output
prose is currently durable; metadata is `{}`. Consequently the renderer cannot
distinguish normal continuation, replan, or blocked review without parsing
model-facing/tool prose or consulting mutable current Goal data.

The Message is intentionally synthetic. Timeline, fork, transcript text,
prompt history, Copy payload, Retry payload, and prompt refill already omit its
text. `/undo` still sees role=`user`, Reverts the nearest continuation, and
refills an empty prompt. The requested change preserves those semantics.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| New ordinary continuation | `SessionPrompt.runLoop` after an eligible completion | Goal active, main Session, non-decide Agent, below Agent/max-turn limits | prompt -> stored synthetic TextPart -> Sync -> UserMessage | SessionPrompt + TUI Session renderer | observed |
| New replan continuation | Existing Goal progress gate | `replanRequired` is computed before persistence from run-local evidence | same as ordinary | SessionPrompt | observed |
| Continuation immediately following first blocked-pending Goal Tool result | GoalTool + completed assistant ToolPart | Goal remains active and Tool result is durable before continuation decision | Tool metadata -> SessionPrompt priority -> continuation TextPart -> TUI | GoalTool transition result + SessionPrompt orchestration | reachable |
| New error-triggered continuation | Existing `continueOnError` branch | Same continuation producer; error content is not copied into prompt | same as ordinary | SessionPrompt | observed; display intentionally identical to ordinary/replan/block-check priority |
| Marker-only persisted continuation without mode/turn/max | Existing stored sessions produced since the marker was introduced and before this task | Exact internal marker and XML envelope are stored | session messages API -> Sync -> UserMessage | TUI compatibility adapter | observed existing compatibility |
| Pre-marker persisted XML continuation | Existing sessions from the original Goal implementation | Exact root envelope and objective tags were generated by `continuationPrompt` | session messages API -> Sync -> UserMessage | TUI compatibility adapter | observed existing compatibility |
| Ordinary user Message, generic synthetic Message, file attachment, or Compaction Message | Existing Session producers | Existing typed Part and action semantics | current Session renderer | current owners | contracted pass-through |
| Arbitrary new status, malformed metadata, hostile XML, cumulative lifetime turn count, terminal badge, web UI | No required producer/contract for this task | Not applicable | none established for requested behavior | none | speculative/rejected |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A Goal continuation renders as one integrated card containing the full historical objective and a bottom badge row. | Confirmed user design | No current Goal continuation render coverage |
| INV-02 | The bottom row contains two separate boxes with a one-column gap: Agent-colored `GOAL`, then neutral mode plus run-local turn/max. | Confirmed user design | No current coverage |
| INV-03 | Exactly one mutually exclusive mode is shown with priority `BLOCK CHECK > REPLAN > CONTINUE`; blocked fractions and error-trigger labels are absent. | Confirmed user design | Progress-gate prompt behavior exists; presentation coverage absent |
| INV-04 | Historical continuation cards use the state captured when produced and do not read mutable current Goal status. | Confirmed history requirement and persisted Message path | No current coverage |
| INV-05 | Clicking a continuation card exposes only Revert; Copy, Retry, and Fork remain unavailable. | Confirmed user design | Generic Message action coverage does not distinguish Goal continuation |
| INV-06 | Existing persisted continuation Messages remain renderable without creating a second renderer or fallback success path. | Persisted Message compatibility | No current coverage |
| INV-07 | `/undo`, model prompt content, lifecycle, error continuation, and non-TUI consumers preserve current behavior. | Confirmed non-goals and current interface ownership | Existing package regression tests |
| INV-08 | The implementation changes at most six code files and fewer than 800 code lines while satisfying the repository Chinese-comment gate. | Session GOAL and repository policy | Diff/implementation audit calculation |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02, INV-03, INV-04 | `SessionPrompt.runLoop` persists only `goal_continuation: true` even though it already owns selected mode, `goalTurns`, `maxGoalTurns`, and the current eligible user's assistant subtree. Historical presentation truth is lost at Message creation. | `SessionPrompt` continuation producer, with GoalTool owning blocked-pending result classification | `prompt.ts:278-410` proves one user turn can contain several assistant Tool steps; `:2641-2673` persists none of the requested snapshots. |
| INV-05 | Session routing classifies every role=`user` Message into the same `DialogMessage` action surface. Synthetic Goal identity is not passed to the action owner. | TUI Session `UserMessage` routing and `DialogMessage` option selection | `index.tsx:1347-1364`; `dialog-message.tsx:38-145` always supplies all four actions. |
| INV-06 | Current objective extraction recognizes synthetic text by XML content rather than first using the established Goal marker; a marker-only presentation detail model does not exist. | TUI Session renderer compatibility adapter | `index.tsx:1471-1485` extracts `<objective>` from all synthetic text; persisted historical XML proves a bounded compatibility branch is required. |

The missing badge is the downstream symptom. Adding a detached UI label or
reading current Goal state in the TUI would compensate after presentation truth
was discarded. The primary repair persists the already-owned truth at the
producer and consumes it once in the existing card.

This is a feature capability, not a reported bug/regression. No bug diagnosis
loop applies. The red-capable feature feedback seams are the persisted
Message/Part integration test and actual OpenTUI frame/action test confirmed by
the user.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Identify blocked-pending as a structured Goal Tool result | `GoalTool` | Converts `SessionGoal.modelTransition` results into durable Tool results | It receives the typed `blocked-pending` result before prose formatting | TUI and SessionPrompt must not parse the Tool title/output |
| Select `BLOCK CHECK > REPLAN > CONTINUE` and snapshot turn/max | `SessionPrompt.runLoop` | Orchestrates continuation creation and already owns all four inputs | This is the last authoritative seam before the synthetic Message is persisted | Goal SQL/status must not absorb presentation mode; TUI lacks historical producer context |
| Carry snapshots | Existing TextPart metadata contract | Persists internal structured metadata with a Message | The schema and SDK already support record metadata | No new Message Part, public Goal field, migration, or generated type is justified |
| Recognize/render the continuation card | TUI Session `UserMessage` | Maps stored Message/Parts to the visible Session transcript | It already owns objective extraction, outer user card, Agent color, timestamp, and attachment badge vocabulary | Sidebar/footer/current Goal state are different views and cannot provide historical snapshots |
| Select Revert-only actions | `DialogMessage` | Owns Message action options and the existing Revert implementation | It can reuse Revert while selecting the subtype's supported actions | SessionPrompt does not own UI interaction; duplicating Revert in the renderer would create another path |
| Verify producer behavior | `test/session/prompt.test.ts` | Exercises `SessionPrompt.loop` through persisted Message/Part output | Existing fixture already covers continuation modes/max turns | Tool unit tests alone cannot prove orchestration metadata |
| Verify visible behavior | `session-message-render.test.tsx` | Exercises actual OpenTUI Session frame, colors, hitbox, and dialog | Existing harness observes the user-facing seam without private helpers | Source-text tests and test-only render helpers are prohibited |

## 10. Single Approved Primary-Path Design

The proposed primary path is intentionally single and small:

```text
Goal Tool blocked-pending result
  -> durable internal transition metadata
SessionPrompt continuation decision
  -> choose BLOCK CHECK / REPLAN / CONTINUE
  -> persist mode + goalTurns + goal_max_turns beside goal_continuation=true
TUI Session UserMessage
  -> recognize the continuation once
  -> render objective and two spaced badges inside the existing card
  -> route click to DialogMessage's Goal-continuation action subset
DialogMessage
  -> expose Revert only
```

Implementation details fixed by the user decisions:

1. `GoalTool` marks only the existing `blocked-pending` successful Tool result
   with `metadata.goal_transition = "blocked-pending"`. The Session loop scans
   completed Goal ToolParts across the current eligible user's full assistant
   subtree, matching the existing progress-evidence turn boundary; it consumes that metadata;
   it does not parse the Tool title or output prose.
2. `SessionPrompt` uses `BLOCK CHECK > REPLAN > CONTINUE`. It persists the
   selected presentation mode, current `goalTurns`, and configured
   `goal_max_turns` on the synthetic continuation TextPart as
   `goal_continuation_mode`, `goal_continuation_turn`, and
   `goal_continuation_max_turns`. Mode values are `block-check`, `replan`, and
   `continue`. These values are
   presentation snapshots; they do not create or alter a Goal state machine.
3. The TUI recognizes new continuations by `goal_continuation: true`. Marker-only
   persisted Messages with no detail metadata derive only `replan` from the
   exact shipped `<strategy-switch mode="breadth-first-replan">` tag; otherwise
   they show `continue`. Pre-marker persisted Messages are recognized only when
   they use the exact `<session-goal-continuation>` root and objective envelope.
   Historical records without count snapshots omit `turn / max`; the renderer
   never fabricates them.
4. The current user-style outer card remains authoritative. It renders the
   complete decoded objective, then a badge row with `gap={1}`. The left border
   and `GOAL` badge share `local.agent.color(message.agent)`; the mode badge is
   neutral. No detached card is created.
5. The continuation click opens the existing Message action dialog in a
   `Goal Continuation` variant containing only Revert. The Revert implementation
   and `/undo` command remain unchanged, including empty prompt refill for
   synthetic content.

The renderer validates only the metadata fields it actually displays: the three
known mode strings and finite positive integer turn/max values. This is required
because SDK metadata is typed `unknown`; it is not a general malformed-input
recovery layer. Objective decoding reverses only the three entities emitted by
the current `escapeXml` producer.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Structured continuation metadata to integrated TUI card | proposed | primary-contract branch | yes | Primary path | implement after approval |
| Exact persisted XML continuation without new detail metadata | current persisted compatibility | existing compatibility | yes | Bounded branch inside the same renderer | preserve; do not expand |
| Ordinary user Message rendering and actions | current | contracted pass-through | yes | Existing path | preserve |
| Detached `Goal continuation` card | historical/superseded | forbidden duplicate presentation | yes | 0% planned | reject; do not restore |
| Parse Goal Tool prose or current Goal status when metadata is absent | proposed alternative considered | forbidden fallback | yes | 0% planned | reject |

New alternate success paths: 0. Diagnostic decision surface: 0%.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Generic synthetic `<objective>` extraction inside `UserMessage` without a continuation view model | It hides the raw model-facing XML while reusing the user card | Structured continuation identity and snapshots let the same card render explicit Goal semantics without guessing from all synthetic text | Collapse in `routes/session/index.tsx` |
| Generic `DialogMessage` actions for every role=`user` Message | Goal continuations are stored as synthetic user Messages | The confirmed interaction contract exposes Revert only for this reachable subtype | Filter in `routes/session/dialog-message.tsx` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 full objective + one integrated card | Stored continuation -> TUI UserMessage card | `routes/session/index.tsx` | OpenTUI frame contains full multiline objective and badge row within the same bordered Message block |
| INV-02 two spaced badges + Agent color + count | UserMessage color + badge row `gap={1}` | `routes/session/index.tsx` | Char frame proves visible gap/count; `captureSpans()` proves GOAL badge background equals the card border Agent color and mode badge is neutral |
| INV-03 mutually exclusive mode priority | GoalTool result -> SessionPrompt snapshot -> TUI label | `tool/goal.ts`, `session/prompt.ts`, `routes/session/index.tsx` | Prompt integration asserts ordinary, replan, blocked-check, and error-triggered ordinary metadata; TUI frame asserts all three labels and no `1/2`/error label |
| INV-04 immutable historical snapshots | Persist mode/turn/max on TextPart | `session/prompt.ts` | Prompt integration compares literal persisted metadata values (`1/2`, `2/2`) independent of current Goal state |
| INV-05 Revert only | Card subtype -> DialogMessage option selection | `index.tsx`, `dialog-message.tsx` | Mouse click on actual continuation card shows `Goal Continuation` + Revert and omits Retry/Copy/Fork; ordinary user action regression remains visible |
| INV-06 persisted history compatibility | Marker-only/exact-envelope branches inside one continuation parser | `index.tsx` | OpenTUI fixtures for marker-only replan and pre-marker envelope render mode without fabricated count |
| INV-07 preserve model/lifecycle/error/non-TUI/undo behavior | Existing paths remain untouched; metadata supplements current Part | six-file bounded diff | Existing error continuation, progress gate, blocked Goal Tool, Session renderer, transcript, and typecheck regression commands |
| INV-08 file/line/comment ceilings | Approved six-file change plan + actual diff audit | all six files | `git diff --stat`, actual E/C calculation, implementation audit |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Durable `goal_transition` Tool metadata | INV-03, INV-04 | GoalTool owns typed blocked-pending; Processor durably stores non-truth metadata | Title/output prose is presentation text, while current Goal schema hides pending audit and must remain unchanged |
| TextPart mode/turn/max snapshots | INV-02, INV-03, INV-04 | SessionPrompt already owns exact values; TextPart metadata is existing contract | Current marker carries identity only; TUI cannot reconstruct run-local history from mutable Goal/config |
| Integrated continuation view branch inside UserMessage | INV-01, INV-02, INV-03, INV-06 | Current UserMessage already renders objective and owns Agent card style | Ordinary text path has no Goal badge data and broad synthetic XML extraction cannot express the subtype |
| Exact persisted-envelope compatibility branch | INV-06 | Existing database history from shipped Goal implementation | Requiring new metadata would make persisted sessions lose their currently visible objective |
| DialogMessage Goal option subset | INV-05 | Current click routes every user Message to four generic options; synthetic extraction is already empty | Ordinary options cannot truthfully provide Copy/Retry/Fork for Goal continuation; duplicating Revert in another component is worse |
| Prompt and actual OpenTUI behavior slices | INV-01 through INV-08 | User-confirmed seams and runnable baselines | Unit/private/source assertions cannot prove persisted snapshots or terminal layout/actions |

## 15. File-Level Change Plan

The implementation code-file ceiling is exactly six; no seventh code file may
be added without revising and re-auditing this plan.

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/goal.ts` | modify | Emit the structured blocked-pending result marker already owned by GoalTool | 5-12 |
| `packages/opencode/src/session/prompt.ts` | modify | Select the three presentation modes and persist mode/turn/max snapshots on the continuation TextPart | 15-30 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Render the integrated objective + spaced badges in the existing card and route click semantics | 55-100 |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` | modify | Restrict Goal continuation actions to Revert while preserving ordinary Message actions | 15-35 |
| `packages/opencode/test/session/prompt.test.ts` | modify | Verify producer snapshots, priority, run-local count/max, and no error-specific mode | 35-75 |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | modify | Verify actual OpenTUI frames, badge spacing, full objective, Agent-owned card shape, legacy Message display, and Revert-only menu | 70-140 |

Estimated implementation total: 195-392 changed code lines across six code
files, below both user ceilings.

## 16. TDD Behavior Slices

The public behavior seams are persisted Message/Part output from
`SessionPrompt.loop` and the actual OpenTUI frame/action dialog rendered by the
existing Session test harness.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Prompt integration expects continuation TextPart metadata for `CONTINUE`, `REPLAN`, turn, and max. | Producer stores only `goal_continuation: true`. | Persist the selected render snapshot without changing prompt text. | Mutable/current state is not used to reconstruct history. |
| 2 | Prompt integration expects the continuation after first blocked-pending Tool result to store `BLOCK CHECK`, with priority over replan. | GoalTool returns only prose/title and SessionPrompt has no structured blocked-check signal. | Persist and consume one internal Tool-result marker. | No Tool-prose parsing and no blocked fraction/error label state. |
| 3 | OpenTUI frame expects full objective plus two badges with a real gap and run-local count. | Current renderer outputs only objective text. | Add the badge row inside the existing UserMessage card. | No detached second card; message identity color path remains shared. |
| 4 | OpenTUI click expects a Goal continuation menu containing only Revert. | Current role=`user` routing exposes Revert, Retry, Copy, and Fork. | Select the Goal-continuation DialogMessage option set. | Ordinary user Message actions remain unchanged. |
| 5 | OpenTUI frame expects a persisted pre-detail XML continuation to render a conservative badge without fabricated turn data. | Current extraction shows objective but has no explicit badge compatibility behavior. | Recognize only the exact shipped envelope and omit unavailable count. | Existing Session history remains readable without broad synthetic guessing. |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 160-320 | Exclude imports, formatting, this plan, generated files, and pure moves |
| Required Chinese explanatory comments `C` | 24-48 minimum across the estimated range | `ceil(E * 0.15)`; actual implementation must recalculate and meet the exact value |

Planned qualifying explanations will sit beside:

- the Tool-result marker explaining why presentation consumes structured truth
  instead of prose;
- the mode priority explaining why blocked review suppresses replan/ordinary
  labels without creating Goal status;
- the Message snapshot explaining why historical cards cannot read current Goal
  status;
- the exact persisted-envelope compatibility boundary;
- the shared Agent color and one-column badge gap as user-visible invariants;
- the Revert-only action distinction between synthetic continuation and ordinary
  user Message;
- each behavior test's user-visible intent and independence from JSX/private
  helper details.

Comments that merely restate assignments, branches, labels, or test names do
not count. Actual `E`, `C`, exclusions, and representative comments are required
in implementation evidence.

## 18. Verification

All commands run from `packages/opencode`, never repository root.

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/prompt.test.ts -t "goal continuation stores render snapshots"` | `packages/opencode` | Narrow producer red/green for ordinary/replan/count/error omission |
| `bun test test/session/prompt.test.ts -t "goal blocked pending continuation stores block check"` | `packages/opencode` | Narrow producer red/green for structured blocked-check priority |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx -t "Goal continuation"` | `packages/opencode` | Actual OpenTUI red/green for integrated card, spacing, color, modes, compatibility, and Revert-only dialog |
| `bun test test/tool/goal.test.ts` | `packages/opencode` | Goal read/transition/blocked contract regression, including unchanged model guidance |
| `bun test test/session/prompt.test.ts -t "goal"` | `packages/opencode` | Related continuation, max-turn, progress-gate, error, and Goal lineage regression |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | Full Session Message rendering and click regression |
| `bun test test/cli/tui/transcript.test.ts` | `packages/opencode` | Synthetic transcript exclusion remains unchanged |
| `bun typecheck` | `packages/opencode` | Package TypeScript contract, including unknown metadata narrowing and JSX props |
| `bun run build` | `packages/opencode` | Package production build and module integration |
| `git diff --check` | repository root | No whitespace errors |
| `git diff --stat` plus audited E/C calculation | repository root | Six-code-file, <800-line, and Chinese-comment gates |

No lint script exists in `packages/opencode/package.json`. No generation or
migration command is planned because no schema/generated contract changes.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 code; 1 canonical plan | No new production/test module is needed because an actual Session render harness exists |
| Files modified | 6 code files | Hard user ceiling; each has one mapped owner/test role |
| Files deleted | 0 | No current detached renderer remains to delete |
| Production lines | 90-177 | Metadata producer, integrated card, and action subset only |
| Test lines | 105-215 | Prompt integration plus actual OpenTUI behavior |
| Generated lines | 0 | TextPart metadata already accepts records; no SDK/schema generation planned |

Hard ceiling: fewer than 800 changed code lines. The budget is an audit signal,
not permission to omit a mapped behavior.

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

None. The originating Session resolved composition, labels, priority, color,
spacing, count semantics, error omission, terminal omission, and Revert behavior.

### Confirmed Risks

- OpenTUI text spacing can differ from JSX source spacing. The real frame test
  must assert the visible gap rather than source props.
- Agent colors vary by configured Agent and theme. The actual span test compares
  the badge background with the rendered card border color rather than asserting
  one hard-coded palette value.
- Existing stored continuations lack turn/max snapshots. Compatibility must omit
  unavailable counts; reconstructing them from Message order would invent a
  second counter with different reset semantics.
- A blocked-pending Tool result and replan gate can coincide. The producer must
  resolve the user-approved priority once before persistence; the TUI must not
  recompute it.
- `session-message-render.test.tsx` is a serialized integration harness because
  it mutates `Global.Path.state` and OpenTUI renderer state. New cases must reuse
  its readiness/polling helpers and avoid fixed sleeps.

### Rejected Speculation

- Arbitrary new continuation modes, terminal status badges, error-recovery
  badges, blocked fractions, and cumulative lifetime counters are rejected by
  explicit user restraint.
- New malformed metadata recovery, feature flags, schema migrations, and a web
  implementation have no requirement or reachable ownership need in this task.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the six-file
  and 800-line user ceilings, and the 15 percent Chinese explanatory-comment
  plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | NB-01, NB-02 | APPROVE | `ses_079f01d25ffejZTxL0STQmPiDh` |

### Round 1 Verbatim Verdict

## Blocking findings

No blocking findings.

## Non-blocking findings

- **NB-01 — 审计记录仍为空属于待记录的行政事项**  
  当前计划为 `R1`、`audit-required`，`Approved revision: none`，这是审计前的正确状态。独立结论需要由编排方按原文写入第 22 节，且不得与实质性设计修改合并。

- **NB-02 — 计划中的基线命令属于构建方提供的证据，未在本轮独立复跑**  
  这不构成计划阻塞项，因为本轮是 plan audit；实现阶段仍必须重新执行计划第 18 节的完整验证命令，并进行实际 diff 与中文注释计算。

## Rejected speculation

- 不要求为未知或恶意 metadata 增加新的通用恢复层。计划已经将 metadata 限定为 SDK 现有 `unknown` 边界，并只验证实际显示的三个 mode 与计数值；没有证据表明需要更宽的 malformed-input 兼容逻辑。
- 不要求增加 Goal SQL 字段、SDK 生成字段、迁移或 HTTP/SDK 改动。当前 TextPart metadata 已能持久化内部记录，且该展示需求明确排除 Goal 生命周期和公共契约变化。
- 不要求恢复历史 detached `Goal continuation` 渲染器。当前代码中已有的真实路径是普通 user-style card；计划修复的是 producer 丢失展示快照后的缺失能力，而不是引入第二张卡片。
- 不要求区分 `continueOnError` 的展示状态。错误内容已经由上方 error 结果表达，用户明确要求不新增该状态机。
- 不要求重建累计 Goal 生命周期计数。计划使用 `runLoop` 已有的 `goalTurns / goal_max_turns`，与当前计数器和 reset 语义一致。

## Requirement and traceability coverage

- 原始用户要求已逐字记录，并保留了已确认的 TUI 设计约束、标签优先级、颜色、间距、计数、Revert-only 交互及六文件/800 行限制。
- `INV-01` 至 `INV-04` 映射到：
  - `GoalTool` 的结构化 `blocked-pending` metadata；
  - `SessionPrompt.runLoop` 的 mode、turn、max 快照；
  - 现有 TextPart metadata 持久化；
  - TUI `UserMessage` 内的一体化 card 与 badge row。
- `INV-05` 映射到 `DialogMessage` 的 Goal continuation action subset，并保留既有 Revert 实现。
- `INV-06` 映射到同一 TUI continuation 识别/渲染路径中的：
  - 新 metadata continuation；
  - marker-only 历史记录；
  - exact pre-marker XML envelope 兼容分支。
- `INV-07` 对 `/undo`、prompt 内容、Goal lifecycle、非 TUI consumer、transcript、timeline、fork、copy、retry 和 schema 的保持不变均有明确非目标或验证映射。
- `INV-08` 映射到六个代码文件的精确变更计划、`<800` 行约束、`git diff --stat` 和实现阶段实际 E/C 计算。
- 正向和反向 traceability 均已填写；新增的 Tool metadata、TextPart snapshots、TUI branch、action subset 和 compatibility branch 都有证据、需求 ID 及现有逻辑不足的理由。
- TDD 切片均通过当前行为可失败：
  - 当前 producer 只保存 `goal_continuation: true`；
  - 当前 GoalTool 没有 blocked-pending metadata；
  - 当前 TUI 只渲染 objective；
  - 当前所有 user Message 都暴露 Revert/Retry/Copy/Fork；
  - 当前没有 legacy detail-metadata presentation branch。

## Primary-path and fallback verdict

- **唯一主路径明确：**

  ```text
  GoalTool blocked-pending
    -> durable ToolPart transition metadata
    -> SessionPrompt 在 continuation 创建前选择 BLOCK CHECK / REPLAN / CONTINUE
    -> 持久化 mode + turn + max 快照
    -> TUI UserMessage 在现有 user card 内渲染 objective 与两个 badge
    -> DialogMessage 对 continuation 仅提供 Revert
  ```

- 该路径修复的是第一处实际分歧：`SessionPrompt` 已经拥有 mode、run-local count、max 和当前 assistant subtree，但在 synthetic TextPart 创建时只持久化了 `goal_continuation: true`，导致历史展示事实丢失。
- GoalTool 负责产生 typed `blocked-pending` 事实；SessionPrompt 负责 presentation priority 和快照；TUI 不读取 mutable Goal 状态，也不解析 Tool prose。
- 计划没有新增 alternate success path：
  - marker-only 和 pre-marker XML 是已有持久化历史的 bounded compatibility，仍在同一 continuation renderer 内；
  - ordinary user Message 是既有 pass-through；
  - detached card、Tool prose parsing、current Goal status parsing 均被明确拒绝。
- 未发现 `try A; failure -> B`、catch-and-default、配置开关绕过主路径、第二数据源或重复 Revert 实现。
- 诊断决策面估计为 0%，没有超过 10% 上限。

## Code quality and Chinese-comment verdict

**Plan-mode feasibility verdict: pass.**

- 计划限定在现有职责模块内，没有新增公共配置、schema、SDK、依赖、迁移或 fallback renderer。
- 变更文件为六个，均有单一职责：
  - `tool/goal.ts`
  - `session/prompt.ts`
  - `routes/session/index.tsx`
  - `dialog-message.tsx`
  - 两个行为测试文件
- 预计实现范围为 195–392 行，低于用户要求的 800 行上限；是否实际满足必须在 implementation audit 中以 diff 重算。
- 计划明确要求实现阶段遵守 `C >= max(1, ceil(E * 0.15))`，并列出了结构化 metadata、mode priority、历史快照、兼容边界、Agent color、badge gap、Revert-only 和测试意图等可放置解释的位置。
- 本轮无法也不应替代实现阶段的实际 E/C 计算；计划已承诺实际计算并报告排除项，因此当前不存在中文注释硬门槛失败证据。

## Release verdict

**APPROVE**

本结论仅适用于当前 canonical plan 的 **R1**，且表示该计划通过本轮完整 plan audit、没有 blocking finding。编排方可将本结论按原文记录到计划第 22 节；在记录 `Approved revision: R1` 前不得开始实现。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

### Actual Files and Diff

The approved R1 route is implemented in exactly the six planned code files:

| File | Actual responsibility | Numstat |
| --- | --- | --- |
| `packages/opencode/src/tool/goal.ts` | Emits the typed `blocked-pending` transition marker only on the existing pending result. | `+9 / -2` |
| `packages/opencode/src/session/prompt.ts` | Resolves `BLOCK CHECK > REPLAN > CONTINUE` across the eligible user's full assistant subtree and persists mode/turn/max snapshots. | `+45 / -10` |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Recognizes structured and bounded historical continuations, renders the objective and two spaced badges in the existing card, and forwards the subtype to its action owner. | `+91 / -13` |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` | Reuses the existing Revert implementation while restricting continuation actions to Revert. | `+11 / -6` |
| `packages/opencode/test/session/prompt.test.ts` | Verifies persisted presentation snapshots, blocked-check priority, error omission, and run-local count/max. | `+77 / -6` |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | Verifies the real OpenTUI frame, integrated composition, spacing, Agent color, mode labels, historical compatibility, and action menus. | `+198 / -0` |

Actual code diff: six files, 431 additions, 37 deletions, 468 changed
lines. The canonical plan is a separately tracked documentation file. No
schema, SDK, generated, migration, dependency, configuration, web, or seventh
code file changed for this task.

Approved-route evidence:

```text
GoalTool blocked-pending result
  -> metadata.goal_transition = "blocked-pending"
  -> SessionPrompt scans completed Goal ToolParts under lastUser.id
  -> SessionPrompt snapshots mode + incremented goalTurns + maxGoalTurns
  -> persisted TextPart metadata
  -> UserMessage builds one continuation view model
  -> existing Agent-colored card renders objective + [GOAL] gap [MODE · turn / max]
  -> existing DialogMessage keeps only its existing Revert option
```

The broad generic-synthetic `<objective>` extraction was collapsed: ordinary
synthetic text no longer becomes a Goal card merely because it contains that
tag. The generic four-action menu remains unchanged for ordinary user Messages;
the continuation subtype filters the same option definitions instead of
duplicating Revert.

### Red-Green Test Evidence

| Slice | Intended red | Minimal green | Final behavior evidence |
| --- | --- | --- | --- |
| Persisted snapshots | Prompt integration expected mode/turn/max but the producer stored only `goal_continuation: true`. | Persist the three presentation snapshots beside the existing marker. | Ordinary and replan Parts contain literal `continue, 1/2` and `replan, 2/2`; error continuation contains `continue, 1/1`. |
| Blocked review | The first blocked-pending continuation persisted `continue` instead of expected `block-check`. | Add one typed Tool-result marker and consume completed Goal ToolParts across the current eligible user's complete assistant subtree. | The persisted Part contains `block-check, 1/2` while the Goal remains `active`. |
| Integrated card | The real OpenTUI frame showed the objective only and had no badge row. | Render the badge row inside the existing `UserMessage` card from persisted facts. | One frame contains all three full objectives, `GOAL`, each exclusive mode, run-local counts, visible gaps, and matching Agent border/badge color. |
| Revert-only | Clicking a continuation opened the generic `Message Actions` menu with four actions. | Pass the parsed subtype to `DialogMessage` and filter its existing options. | Actual mouse hitbox opens `Goal Continuation` with Revert and without Retry/Copy/Fork; an ordinary Message still exposes all four. |
| Persisted history | Marker-only and pre-marker envelopes had no explicit Goal badge semantics. | Route the marker or exact shipped envelope through the same view model and omit unavailable counts. | Marker-only replan and exact-envelope continue both render badges with no fabricated ` / ` count. |

Each red was observed before its green implementation. Expected values are
literal user-visible frames or persisted Message/Part records; tests do not
assert private helper calls, source text, or call counts. The blocked fixture
uses `llm.wait(4)`, a published server signal, rather than a fixed sleep.

### Verification Commands and Results

All Bun commands ran from `packages/opencode`; Git checks ran from the repository
root.

| Command | Result |
| --- | --- |
| `bun test test/tool/goal.test.ts` | PASS: 11 tests, 60 assertions, 0 failures. |
| `bun test test/session/prompt.test.ts -t goal` | PASS: 10 tests, 46 assertions, 0 failures, 82 filtered. |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | PASS: 76 tests, 158 assertions, 0 failures. The existing TreeSitter-destroyed warning fell back to plain text and did not fail the suite. |
| `bun test test/cli/tui/transcript.test.ts` | PASS: 18 tests, 37 assertions, 0 failures. |
| `bun typecheck` | PASS: `tsgo --noEmit`, exit 0. An earlier run observed four concurrent errors in unrelated `src/patch/match.ts`; the final rerun passed without this task editing that file. |
| `bun run build` | PASS: all production targets built; the Darwin ARM64 smoke test passed. Existing bundle-size warnings were non-failing. |
| `git diff --check -- <six code paths>` | PASS: no whitespace errors. |
| `git diff --numstat -- <six code paths>` | PASS: exactly six code files and 468 changed lines, below the user ceiling of 800. |

During cleanup, a full-file `bunx prettier --write` expanded the same six-file
diff to 1,006 changed lines. Every formatter-only hunk outside the approved
change was removed with targeted edits; no Git restore/reset/checkout was used.
The final 468-line diff above and the final regression reruns are against the
cleaned implementation.

### Original Feedback-Loop Result

Not applicable as a bug loop: this is a capability enhancement, not a reported
bug or performance regression. The final real OpenTUI frame/action suite is the
original user-visible feature loop and passes 76/76.

### Actual Secondary and Replacement Path Inventory

| Actual path | Classification | Result |
| --- | --- | --- |
| Structured continuation metadata to the integrated card | Primary contract | Implemented as the sole new semantic path. |
| Marker-only and exact pre-marker envelope history | Existing shipped compatibility | Preserved inside the same parser/renderer; no fabricated count and no expanded malformed-input recovery. |
| Ordinary user Message rendering/actions | Contracted pass-through | Preserved; full four-action regression passes. |
| Detached `Goal continuation` card | Forbidden duplicate | Absent; the real frame asserts that detached label is not rendered. |
| Tool prose/current Goal status parsing | Forbidden fallback | Absent; blocked mode comes only from completed structured Tool metadata. |

New alternate success paths: 0. Diagnostic decision surface: 0%. No primary
path was disabled, no catch-and-success branch was added, and no responsibility
moved into Goal SQL, SDK, lifecycle, transcript, or web UI.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 345 | Independent implementation audit started with 431 raw additions and excluded import-only, blank, comment-only, formatter-only, generated, and pure-move lines. |
| Qualifying Chinese comment lines `C` | 65 | Independent audit excluded comments that only restated labels, assignments, or obvious control flow and counted adjacent explanations of ownership, snapshots, priority, compatibility, UI invariants, Revert behavior, and test sensitivity. |
| Ratio `C / E` | 18.84% | `65 / 345`, above 15%. |
| Required minimum `C` | 52 | `ceil(345 * 0.15) = 52`; actual exceeds the gate by 13 lines. |

Representative qualifying comments protect:

- producer-side priority and the `parentID` assistant-subtree boundary;
- immutable mode/turn/max Message snapshots rather than mutable Goal state;
- the exact shipped-envelope compatibility boundary and unknown-mode rejection;
- one-column badge spacing and Agent-owned color in real renderer cells;
- Revert ownership and the ordinary Message action pass-through;
- published readiness signals and independent literal expectations in behavior tests.

### Remaining Unverified Items

No behavior or repository check remains unverified. The independent full-scope
implementation audit below approved the actual six-file diff.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | None. | APPROVE | `ses_079cadf56ffe8j376v04VQMpTO` |

### Round 1 Verbatim Verdict

## Blocking findings

No blocking findings.

## Non-blocking findings

None.

## Rejected speculation

- 不要求为任意 malformed 或 hostile `metadata` 增加通用恢复层。当前 producer-to-consumer 路径是内部持久化 `TextPart` metadata，代码仅消费已确认的三个 mode 和正整数计数。
- 不要求恢复 detached `Goal continuation` 卡片。当前实现将目标内容与 badge 放在同一个既有 user-style card 中，符合 R1 的一体化约束。
- 不要求增加 Goal SQL 字段、SDK 生成字段、迁移、HTTP/SDK 公共契约或 Web UI 路径。现有 TextPart metadata 已能持久化所需快照。
- 不要求区分 `continueOnError` 展示状态。错误信息仍由既有 assistant error 路径承载，continuation 使用普通 `CONTINUE`，符合原始确认约束。
- 不要求重建累计 Goal 生命周期计数。producer 使用当前 `runLoop` 的 run-local `goalTurns / goal_max_turns`，历史记录缺失计数时 renderer 保守省略计数。
- 不要求为普通 synthetic 文本继续解析 `<objective>`。当前仓库生产路径中可产生该 continuation envelope 的 producer 是 `SessionGoal.continuationPrompt`；目标 renderer 已使用 marker/exact-envelope 边界区分 Goal continuation。

## Requirement and traceability coverage

**Full-scope audit marker: yes.**

Original requirement and all R1 constraints were audited:

- **Integrated card:** `UserMessage` now renders the decoded objective and badge row inside the existing bordered user card.
- **Two separate boxes and spacing:** the `GOAL` and mode/count badges are separate elements with `gap={1}`; the OpenTUI test checks visible spacing.
- **Labels and priority:** `SessionPrompt` persists one resolved mode using `BLOCK CHECK > REPLAN > CONTINUE`.
- **Blocked-pending semantics:** `GoalTool` emits structured `goal_transition: "blocked-pending"` metadata only for the existing pending result. `SessionPrompt` scans the complete eligible user assistant subtree rather than parsing tool prose.
- **Historical snapshots:** mode, run-local turn, and max-turn values are persisted on the continuation TextPart.
- **No error-specific mode:** error continuations persist `continue`, with no `AFTER ERROR` label or error content copied into the continuation.
- **No blocked fractions:** the renderer does not display blocked-attempt fractions.
- **Agent color:** the `GOAL` badge background uses the same Agent-derived color as the card border; the mode badge remains neutral. The test verifies rendered spans rather than hard-coded theme values.
- **Legacy history:** marker-only and exact pre-marker envelope records are handled through the same continuation renderer, with no fabricated count.
- **Revert-only interaction:** continuation clicks pass the subtype to the existing `DialogMessage`, which filters the existing action definitions to Revert only. Ordinary user messages retain all four actions.
- **Existing semantics:** model-facing continuation prompt text, Goal lifecycle, `/undo`, synthetic prompt filtering, and non-TUI consumers remain unchanged in the audited diff.
- **Scope ceiling:** exactly six listed code files changed; `git diff --stat` reports 468 changed lines total, below 800.

Verification independently reproduced:

- Blocked-pending producer test: passed.
- Replan producer test: passed.
- Goal continuation OpenTUI tests: 3 passed.
- Goal tool regression suite: 11 passed.
- Related Goal prompt tests: 10 passed.
- Transcript regression suite: 18 passed.
- `bun typecheck`: passed.
- `bun run build`: passed.
- `git diff --check`: passed.

## Primary-path and fallback verdict

The implementation preserves one authoritative semantic path:

```text
GoalTool blocked-pending result
  -> durable ToolPart transition metadata
  -> SessionPrompt resolves BLOCK CHECK / REPLAN / CONTINUE
  -> continuation TextPart stores mode + run-local turn/max snapshots
  -> UserMessage recognizes one Goal continuation view model
  -> existing user card renders objective + spaced badges
  -> DialogMessage exposes the existing Revert action only
```

No unauthorized alternate success path was found:

- No `try A -> failure -> B` behavior.
- No parsing of Tool title/output prose as a fallback.
- No lookup of mutable current Goal state for historical rendering.
- No detached renderer.
- No duplicate Revert implementation.
- Legacy marker-only and exact-envelope handling are bounded compatibility branches inside the same renderer, not competing success implementations.
- Diagnostic or fallback decision surface remains within the approved zero-new-fallback design.

## Code quality and Chinese-comment verdict

The changed implementation conforms to the relevant repository constraints:

- No new dependency, schema, SDK, migration, configuration surface, or generated file.
- No new `any`, type suppression, unchecked cast, or non-null assertion was introduced by the audited diff.
- Existing Revert ownership is reused rather than duplicated.
- The renderer keeps parsing/view-model construction separate from JSX layout.
- Tests observe persisted Part metadata and actual OpenTUI frames/actions rather than private helpers.
- Existing ordinary Message actions remain behaviorally covered.
- No whitespace errors were reported.
- Typecheck and build passed.

Chinese explanatory-comment calculation, recomputed from the actual six-file diff:

- **Raw additions:** 431.
- **Effective changed code lines `E`: 345**
  - Excluded import-only lines, blank lines, comment-only lines, and formatting-only additions.
  - No generated or pure-move lines were counted.
- **Qualifying Chinese explanatory-comment lines `C`: 65**
  - Excluded comment lines that only restated labels, assignments, or obvious control flow.
  - Counted comments explaining producer ownership, snapshot immutability, mode priority, compatibility boundaries, Agent color/spacing invariants, Revert-only behavior, and behavior-test sensitivity.
- **Required:** `ceil(345 × 0.15) = 52`.
- **Actual ratio:** `65 / 345 = 18.84%`.
- **Gate:** passed.

## Release verdict

**APPROVE**

This verdict applies only to the actual audited six-file implementation diff against approved canonical revision **R1**. The audit covered the complete original requirement, affected producer-to-consumer path, historical compatibility path, UI action path, tests, scope limits, verification commands, primary-path rules, code-quality rules, and Chinese-comment gate.

**Invocation reference:** no separate runtime invocation/message identifier was exposed for this audit.
