# Canonical Implementation Plan: Goal System Contract Repair (De-segmentation, Evidence Classifier, Long-Run Drive)

> Status: verified
>
> Revision: R9
>
> Approved revision: R9
>
> Audit mode: full-scope
>
> Requirement source: user messages quoted in §1
>
> Implementation allowed: completed; subsequent material changes require a new approved revision
>
> Last updated: 2026-09-21
>
> R2 note: R1 (text-only repair) was audited and approved
> (`ses_f452f0675ffeAcPkaNXUQYUVxR`), then the user expanded the scope before
> implementation: mechanism changes are now in scope (evidence classifier +
> long-run escalation state), webfetch is explicitly excluded from evidence,
> and the text repair must use targeted edits with at most ~30% net reduction
> instead of R1's full-section replacement. R1 will not be implemented; its
> audit record is preserved in §22.
>
> R3 note: R2 was audited and approved (`ses_f44f8ac3affeJzc2g6d6Uz0Fn5`),
> then — before implementation — the user authorized incorporating Codex's
> "No-progress check" section after its measured length proved acceptable
> (1,039 chars, 16% of the upstream template). R3 expands Hunk B with the
> verified-wait and equivalent-blocker semantics, adapted into this fork's
> turn-free wording per INV-01; verbatim borrowing is rejected because the
> upstream text is framed around "the previous goal turn". R2 will not be
> implemented; its audit record is preserved in §22.
>
> R4 note: R3 was audited and approved (`ses_f4338d8d9ffeMRE1K72R5wph3K`),
> then the user reported a resume-path defect before implementation. Two
> scripted-provider reproductions (§4) confirmed it: (a) resuming a goal after
> an interrupted turn re-dispatches the old user message with no continuation,
> so the model works blind to the goal until its blind answer completes; (b)
> `revert.cleanup` never runs on the loop/resume path, so reverted
> continuations stay visible and get re-dispatched once before a fresh
> continuation arrives. R4 adds the resume-injection and loop-start-cleanup
> repairs. R3 will not be implemented; its audit record is preserved in §22.
>
> R5 note: R4 was audited and BLOCKED (`ses_f42aa1980ffenEFMhAAorCyYSe`)
> because the resume-injection omitted the `goal_max_turns = 0` disable guard
> (B-01); four non-blocking corrections are folded in: the injection shape is
> pinned to the owning gate's metadata block (N-01), the continueOnError
> decision is stated (N-02), record citations are completed (N-03), and an
> empty-post-cleanup guard is added to `loop()` (N-04). R4 will not be
> implemented; its audit record is preserved in §22.
>
> R6 note: R5 was audited and BLOCKED (`ses_f427fb7d0ffePqbtCjbnh20I5X`): the
> N-04 empty-post-cleanup guard returned through `lastAssistant`, whose
> contract requires a visible message and therefore throws
> `Error("Impossible")` in exactly the fully-reverted state being guarded
> (B-01). The guard now reads the persisted tail with `includeHidden: true`
> (cleanup hides, never deletes; revert.ts:197-211), the injection-shape
> placeholder names the gate's `continuationViewMode` computation (N-01), the
> estimates are updated (N-02), and slice 12 covers the revert-entire-history
> leg. R5 will not be implemented; its audit record is preserved in §22.
>
> R7 note: R6 was audited and BLOCKED (`ses_f4266c00dffeb1Py7M79SVVsc5`): the
> loop-entry cleanup+guard broke cleanup-before-create on the internal
> `prompt()` → `loop()` path (a revert landing in the prompt preamble window
> could hide the just-created user message and return it as a success-shaped
> result). R7 scopes the cleanup+guard behind a new `LoopInput.cleanupRevert`
> flag passed only by the two resume entries (goalSet handler, task
> resumeWhenIdle); `prompt()`'s internal `loop()` call never sets it and is
> byte-identical to today. The R6-verified guard return path (persisted tail
> via `includeHidden: true`) is unchanged. Per user directive, INV-15's
> condition is rewritten structurally — inject when the dispatch target
> already has an assistant answer (the last message is not a user-sent
> message); marker sniffing and the error/no-finish qualifier are dropped, and
> the caller inventory is completed (round-6 N-01). R6 will not be
> implemented; its audit record is preserved in §22.
>
> R8 note: R7 was approved (round 7), then the user requested a fresh
> dual-audit review; two independent auditors both BLOCKED R7 on the same
> finding: the R7 blocked wording dropped the runtime's confirmation boundary
> — a repeated blocked call while answering the same message never increments
> the streak (goal.ts:401-415; goal.test.ts:929-953), so "call again after
> that verification" instructs a sequence that cannot reach blocked. R8
> rewords the blocked guidance around the real mechanics without turn
> vocabulary: the second confirmation counts only after the next
> goal-continuation message arrives, and the recheck guidance gains an
> optional independent audit delegated to a subagent (fresh context), per the
> user's directive. R8 also applies four user-directed corrections: Hunk A
> permits decomposition but forbids stopping after one step; Hunk B's
> not-progress bullet merges both phrasings; the long-run notice advances
> "the next or the largest" unfinished requirement; §10.7's caller-chain
> claim is corrected (the task path injects its result message through
> `prompt()` before resuming). R7 will not be implemented; its audit record
> is preserved in §22.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

R1 requirements (carried, still binding):

> 完整分析整个goal的所有prompt，不要只局限于部分，同时请注意整体依然要保持相应的可指导性以及可判断性，不要使用不通顺不清晰的推销式或者说明书式表达
>
> 请注意，之前内容是没有任何 reasoning part 的，所以从现在开始你需要完整全面进行详细的推理、分析，并且完整地去展示。然后，比如说你可以完整地罗列当前的一些提示词插，并且完整对现在的提示词进行一些分析，看一看到底哪些内容有点问题，然后你准备怎么改。然后改的时候也请注意，就是整体自成一体，不要过度地矫枉纠正。同时也不要告诉模型，就是说什么 current turn 等等内容。就是本身就要去鼓励模型去长期地、完整地运行，那本身就不能告诉它这是我们当前这轮，而是说就是当前的所有最终任务就是完整完成整个任务，不要让它试图进行分段，或者给它任何分段的一个诱导。所以请注意这一点。而且也没有，而且本身这个是 replay，那我问的是本身这个所有这个提示词，然后包括但不限于提示词之外的一些 replay，或者提示词之外的一些其他种类的这种格式的插入等等内容，请你完整完成进行相应的一个检查以及分析。这些问题不仅限于replan。

> 现在请你将相关内容完整全面的写入一个独立的plan，使用first-principle原则进行构建

R2 expansion (binding, supersedes where conflicting):

> 当前本身不只是文本修复本质上相应的这种提示词、机制、逻辑都参与相应的goal体系修复，所以本质上可以将mcp+task加入；但请你注意，理论上webfetch不算，因为是只读，goal本质上是一个长程的实施任务，同时请注意相应的goal的在整体内容修改保持适度克制，偏僻入你现在是直接减少一半，我认为应当使用edit/apply_patch这种来进行修改，修改替换现有的矛盾或者不合适的表述以及进行克制修改，可以进行多行内容的完整修改，但是当避免进行大范围修改，我认为最多优化净减大概30%的提示词就可以了，其中修改行数不限；
>
> 同时我仍然是希望那个逻辑，譬如32次的话，超过8次就会进入一个额外提示的附加状态，也就是督促模型保持长程自主积极完整进行任务，如果任务检查完整请使用complete完成，如果任务多次检查都发现任务无法正常实施，请完整全面检查相应的用户需求还有没有其他任何仍未完成的地方（类似这种激励性质的话，避免模型卡在一点或者只进行单步汇报且长期形成惯性）
>
> 因此请你完整全面检查相应的goal相关设施提示词，按照我的理解，本质上prompt应当具有可执行和可实施的语言，那些过度晦涩或者模糊的语言可以适当优化并使用细粒度的列举等等形式（但避免限制为特定任务场景）：
>
> 整体内容保持内部统一通顺，且符合本身goal所希望进行的实现的方向

R3 expansion (binding):

> 这个消息大概多长？如果还可以的话，理论上而言，你可以将其纳入我们的相应的这个提示词体系。

R3 refinement (binding):

> 于是同时请注意一点，你那个GOAL的，就是Long Term的那个Notice或者说什么东西，就是激励模型去进行动作的，请你注意不要只进行分类，然后去告诉什么什么什么。你应当也包含提示词说告诉模型应当长程地积极地完整地进行相应的任务，避免在任务完成一半时停下。

R4 expansion (binding):

> 当前还有问题，我有时候发现这个 GOAL 的相关 continuation 的内容是有点问题的。譬如说假设这个 GOAL，我们在第一次粘贴之后或者设定之后，它本质上会出现一个 continuation 并且让模型继续。那假设用户停止了这个继续，然后又把这个 continuation 撤掉，那再次把相应的这个 GOAL 设定成，就是从那个 push，P-A-U-S-E，设置成继续的那种，就是说 active 这种格式。那本质上它就不会再有任何 continuation，同时又直接让上一次本来已经完成上一次 turn 的这种相应的 agent loop 直接重新开始，不加任何提示，所以这本质上有点奇怪。本质上而言，如果这个 GOAL 所发起的这个 agent loop，如果上一次没有相应的 continuation 的时候，那本次应当注入一次 continuation 并继续。要不然的话，它本身模型就不知道为什么它自己这个 agent loop 又启动了。
>
> 请检查一下相应的情况以及看看是否要进行修改。

Additional audit authorization (verbatim; metadata correction and full-scope
restraint review, no implementation requested in this review):

> 那你直接先进行相应的这个内容的一个修改吧。那文件头没有问题，现在没有问题的话，你再次去调用一轮审计，让，也就是你是GPT，你再去去检查一遍，看看相应的内容有没有不符合我们整体设计思想的这种克制修改的这种违背

R9 implementation-stage scope correction (verbatim; supersedes the earlier
request to include MCP evidence):

> 请注意不要额外地过多地增加像一种冗余的一些逻辑。譬如说你在这里增加什么 MCP tool ID 这种内容，本质上这种内容不应该被添加。无论什么内容，只要它调用了 MCP 就算，就没有问题。你不要在这里设置什么 MCP tool ID，这本质上会导致内容有问题，或者说导致我们长期存储的 schema 等等内容发生巨大迁移。
>
> 不要预设用户没有在需求里面指定的行为。
>
> 不得增加现有结果或者修改任何结果的输入这种 schema 的内容。
>
> 如果不行就不要加相应的MCP的内容。
>
> 同时如果不进行修改，那本质上而言，具体的关于测试和生产代码，没有需要改动的一行就不要改，你也不要去加什么否定断言，来限制你刚刚删的东西丢失。这本身否定断言没有任何意义。

> 这个内容你放的逻辑还放的位置是有问题的。本质上它应该跟那个三十二放在一块。

The long-run threshold constant is local to the continuation gate, next to
`const maxGoalTurns = cfg.goal_max_turns ?? 32`; behavior and threshold stay
unchanged. This is a placement correction, not a new configuration field.

Disposition: omit MCP evidence expansion. The existing MCP adapter identifies
its source in transient timing data, not a persisted tool-result field
(`prompt.ts` MCP execute adapter). No tool-ID set, result metadata, schema,
callback or runtime tracking is added for MCP. The just-added MCP-specific
implementation/test was removed; existing MCP code/tests remain unchanged.
No negative assertion is added to enforce this omission. All other approved
R8 behavior is carried unchanged. R8 implementation is partially present;
further implementation waits for full-scope approval of this exact R9.

## 2. Explicit Non-Goals

- No changes to the two-consecutive-confirmation blocked enforcement
  (`SessionGoal.modelTransition`), the read-gate, generation CAS,
  `goal_max_turns`, the progress-gate state machine (`updateGoalProgressGate`),
  or TUI rendering.
- No count-based escalation other than the single user-specified threshold
  (over 8 continuations → long-run notice). No per-turn sterner text series.
- No injection of the objective into the first model request and no
  continuation `variant` inheritance fix: both remain open decisions in §20.
  (The R4 resume-injection is a different, user-reported repair and IS in
  scope.)
- No broad rework of the revert/cleanup lifecycle beyond invoking the existing
  `SessionRevert.cleanup` at the loop entry; the boundary computation and
  hidden-marking semantics are unchanged.
- `webfetch`/`websearch` stay excluded from goal evidence (user rule: GOAL is
  a long-horizon implementation task; read-only external lookups do not count).
  A Chinese comment in the classifier records this so it is not "fixed" later.
- No text rewrite exceeding ~30% net reduction per surface; R1's full-section
  replacement texts are abandoned in favor of targeted hunks.
- No changes to other provider prompts, `max-steps.txt`, the compaction
  summary template, or TUI code. The `<session-goal-continuation>` envelope,
  `<objective>` tag, and `<strategy-switch mode="breadth-first-replan">` tag
  stay byte-identical (TUI parser depends on them).

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Goal is a structured objective owned by a Session; this plan edits its contract and its evidence classifier. |
| Root `AGENTS.md` | Minimal changes; tests/typecheck from `packages/opencode`. |
| `packages/opencode/test/AGENTS.md` | Behavior tests through real seams; interleaved Chinese intent comments; no scheduler sleeps. |
| `.opencode/policy/first-principles-engineering.md` | Owning-seam repair; traceability; E/C budget counts test lines. |
| `docs/plans/goal-continuation-progress-gate.md` (verified R7) | Shipped contract whose text this plan partially rewords; mechanics preserved. |
| `docs/plans/session-goal-transition-integrity.md` | Transition ownership and two-turn blocked semantics preserved. |
| R1 of this plan (§22) | Text-only scope approved, then superseded by the user's scope expansion before implementation. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/session/goal.ts` 549-657 (texts), 336-502 (transition errors) | Primary texts under repair | observed |
| `src/tool/goal.txt` (14 lines / 2,201 chars); `src/tool/goal.ts` 30-39 (annotations), 64-163 (result texts) | Tool-facing contract | observed |
| `src/session/prompt.ts` 147-179 (turn derivation), 181-439 (ledger/gate), 2573-2842 (injection), 682 (`mcp` service in layer scope), 1294 (MCP tools merged into step tools), 2989 (`registeredTools`) | Mechanics and wiring points for both mechanism changes | observed |
| `src/session/compaction.ts` 82-119, 1094-1224 | Other goal-adjacent insertions; no defect | observed |
| `src/cli/cmd/tui/util/goal-http.ts` (full) | `/goal` set path is HTTP-only; objective not injected into first request (open decision) | observed |
| `src/tool/task.ts` 327-337, 470-517 | Completed task parts carry `metadata.sessionId` (child session id) — the dedup key | observed |
| `src/mcp/index.ts` 154-187 (`convertMcpTool`), 662-695 (tool id = `sanitize(client)_sanitize(name)`) | MCP tool ids are knowable via `mcp.tools()` keys | observed |
| `test/mcp/lifecycle.test.ts` 95-146 | Existing `mock.module` pattern for the MCP SDK client — its `MockClient` implements `tools/list` only; the slice-7 local mock must additionally implement `callTool` (pattern reference, not a ready-made fixture) | observed |
| `test/session/prompt.test.ts` 2503-2548, 5404-5549 | Task tool executes in the test harness; progress-gate tests show replan timing is observable through continuation modes | observed |
| `test/session/goal.test.ts` 381-469; `test/tool/goal.test.ts` 203-250, 341 | Exact assertion pins that must change vs survive (auditor-verified in R1) | observed |
| Measured current sizes (in-memory execution of the real `continuationPrompt`) | ordinary fixed 5,153 chars / 48 lines; replan 8,312 / 76; strategy block 3,157 | observed |
| Codex comparison (pinned `openai/codex@78245b47`) `ext/goal/templates/goals/continuation.md` | No-progress classification concept reference; the section measures 1,039 chars / 4 lines (16% of the 6,451-char template), added 2026-08-25 in `0cdb1f1c83` "Harden goal continuation"; upstream iteration history shows eval-driven small-step polish with revert pairs | observed |
| Local checkout `.temp/thirdparty/codex` @ `78245b47` (`git log`/`show` on the goals template) | Upstream evolution evidence: 05-01 removed the no-tool suppression heuristic, 05-11 removed elapsed-time display after evidence it made the model shortcut work, 08-25 added the No-progress check | observed |
| R1 adversarial audit (`ses_f452f0675ffeAcPkaNXUQYUVxR`) | Verified: no consumer of the removed phrases outside the mapped tests; envelope/tag parser dependencies | observed |
| Repro A (scripted, this session): complete continuation → cancel → `revert(C1)` → resume | After revert, C1/C2 stayed visible (cleanup never ran on the resume path); the resumed loop re-dispatched the stale reverted C2 once before a fresh continuation arrived and cleanup hid the old ones | observed |
| Repro B (scripted, this session): stop mid-first-answer (no continuation ever created) → resume goal | The resumed loop dispatched on the old user message and the model answered with no goal context; the continuation arrived only after that blind answer completed | observed |
| `prompt.ts` 3341-3344 (`loop` = `ensureRunning` only), 2430/1627/2515 (cleanup callers) | `loop()` never runs `revert.cleanup`; cleanup only runs on prompt/shell/compact | observed |
| `revert.ts` 46-150 (revert records boundary only) + 171-227 (cleanupCurrent hides) | revert is two-phase; hiding is deferred to cleanup | observed |

## 5. Current Behavior

R1 established the full text inventory (continuation ordinary/replan, goal.txt,
annotations, tool results, transition errors, replay, compaction template, TUI)
and the three text-level defect classes: turn-framed segmentation affordances
("Ending this turn…", "at least one concrete action", "End-of-turn rule",
"state which node should be visited next"), four-surface blocked-protocol
duplication, and no progress judgability. That analysis stands and is not
re-derived here.

Mechanism state relevant to R2:

- `absorbGoalTurnEvidence` (prompt.ts:284-416) classifies completed tool parts
  into exploration/advancement. It recognizes todowrite, edit/write/apply_patch,
  read, grep/glob, bash/shell. Completed `task` and MCP tool parts fall through
  all branches and count as nothing; `webfetch`/`websearch` likewise (already
  excluded, which R2 makes deliberate by comment).
- `updateGoalProgressGate` (prompt.ts:420-439): two consecutive turns with no
  exploration and no advancement latch replan; exploration resets the raw
  count; only advancement exits replan.
- The continuation gate (prompt.ts:2750-2817) increments `goalTurns`, snapshots
  it into user-visible metadata (`goal_continuation_turn`), and injects
  `continuationPrompt(goal, mode)`. The model-facing text carries no counter.
- `continuationPrompt(goal, mode)` has no third input; nothing can vary the
  text by continuation count today.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Reachable path | Classification |
| --- | --- | --- | --- |
| Continuation after normal completion with active Goal | runLoop completion block | `continuationPrompt` injection | observed |
| Replan after two no-evidence turns | progress gate | strategy block insertion | observed |
| Completed `task` part in a goal turn | Task tool (task.ts:327-337, 505-517) | classifier input | observed |
| MCP tool activity | existing MCP adapter | unchanged; no evidence expansion in R9 | R9 user scope correction |
| Completed `webfetch`/`websearch` part | local web tools | classifier input — must stay uncounted | contracted (user rule) |
| 9th+ continuation in one runLoop | `goalTurns` counter | long-run notice | contracted (user rule) |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | No Goal model-facing text contains segmentation framing: forbidden phrases "this turn", "each turn", "next turn", "across turns", "eligible Goal turn", "End-of-turn", "The session loop will end" | user directive | new assertions |
| INV-02 | The continuation defines progress, non-progress, and the verified wait: waiting counts only while a specific process/job/session/tool handle is confirmed alive right now; a failed or timed-out observation means observe again, not restart; a blocker rephrased in different words is still the same condition | user symptom; Codex comparison; user authorized incorporation after the measured 1,039-char length proved acceptable | new assertions |
| INV-03 | The continuation instructs executing authorized actions immediately, not reporting next steps | user directive | new assertions |
| INV-04 | Completion audit stays requirement-by-requirement with the fine-grained 8-bullet list; `operate "complete"` call phrase and budget reporting preserved | shipped contract; user likes fine-grained enumeration | updated assertions |
| INV-05 | Blocked protocol preserved as an action sequence without turn vocabulary; entry criteria remain in goal.txt + continuation; two-call same-reason mechanics unchanged | shipped contract | updated assertions |
| INV-06 | Envelope, `<objective>`, `<strategy-switch mode="breadth-first-replan">` byte-preserved; objective XML escaping preserved | TUI parser | existing TUI tests green |
| INV-07 | Restraint: targeted hunks only; net reduction per surface ≤ 30% (auditor-recomputed estimates: strategy 3,157 → ~3,047; goal.txt 2,201 → ~2,229; ordinary grows ~680 chars because the R3-expanded progress block exceeds the trimmed completion paragraph — growth is permitted, the cap limits reduction; actuals measured in §23) | user directive | measured in §23 |
| INV-08 | Anti-gaming rules retained (no cosmetic edits to escape replan; stagnation is not a blocker; hard/slow/uncertain is not a blocker; budget-nearly-exhausted is not a completion reason) | shipped contract | retained assertions |
| INV-09 | User-control boundaries retained (no model pause/resume-paused/clear) | shipped contract | retained |
| INV-10 | No assertion weakened to force green; every changed pin has a mapped replacement preserving coverage | policy | audit check |
| INV-11 | Completed `task` parts count as exploration evidence keyed by child session id in the existing `commands` bucket (activity, not advancement); MCP expansion is omitted per the R9 directive | user directive with R9 scope correction | task integration test |
| INV-12 | `webfetch`/`websearch` completions count as nothing; no branch can match them | user directive (只读不算) | structural + comment; audit-verified |
| INV-13 | From the 9th continuation of a runLoop (`goalTurns > 8`), the continuation carries the `<long-run-notice>` block with the three-branch content in §10.4; earlier continuations never carry it; replan and long-run can co-occur | user directive ("譬如32次的话，超过8次") | new tests (unit + integration) |
| INV-14 | The long-run notice opens with an explicit drive to keep working autonomously to full completion without stopping halfway (user: "不要只进行分类……应当长程地积极地完整地进行相应的任务"), and contains no turn vocabulary and no mechanism explanation beyond acknowledging prolonged unfinished work | user directive | new assertions |
| INV-15 | When a goal-driven loop (re)starts with an active goal, `goal_max_turns > 0` (the disable contract holds), inject a continuation before dispatching IFF the dispatch target already has an assistant answer (`lastAssistant.parentID === lastUser.id` — the last message is not a user-sent message). An unanswered user message (fresh prompt or pending continuation) is dispatched directly, never preempted | repro B; user directive (structural condition); audit B-01 | new integration test |
| INV-16 | Reverted content never reaches the model on a resume: `SessionRevert.cleanup` runs inside `loop()` only when the caller passes `cleanupRevert: true` (the two resume entries: goalSet handler, task resumeWhenIdle); `prompt()`'s internal call never sets it (cleanup-before-create preserved). If no visible user message remains after cleanup, the loop does not start (idle no-op, goal stays active) and returns the persisted tail read with `includeHidden: true` | repro A; audit N-04; round-5 B-01; round-6 B-01 | new integration tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module | Proof |
| --- | --- | --- | --- |
| INV-01..05 | turn-framed/duplicated sentences inventoried in R1 (§5 stands) | `goal.ts`, `tool/goal.ts`, `tool/goal.txt` | grep inventory |
| INV-11 | `absorbGoalTurnEvidence` has no branch for task parts | `prompt.ts:284-416` | branch read-through |
| INV-13 | `continuationPrompt` has no count-varying input; the gate passes only `(goal, mode)` | `goal.ts:592`, `prompt.ts:2814` | signature + call site |
| INV-15 | The completion gate only fires on `normalCompletion`/`errorCompletion`; an interrupted-then-resumed turn satisfies neither, so no continuation is injected and the old message is re-dispatched blind | `prompt.ts:2694-2703` (gate condition), 2708-2715 (error allowlist) | repro B chronology |
| INV-16 | `loop()` calls `ensureRunning` directly (prompt.ts:3341-3344) and never runs `revert.cleanup`; the reverted range stays visible into the first post-resume dispatch | `prompt.ts:3341-3344`; `revert.ts:46-150` | repro A chronology |

Red-capable signals: text-contract assertions in `test/session/goal.test.ts` /
`test/tool/goal.test.ts` fail on current text (new contract sentences absent,
forbidden phrases present). The classifier slice fails today because a
task-completing turn does not reset the no-progress count (replan arrives one
continuation earlier). The long-run slice fails today because no continuation
ever contains `<long-run-notice>`.

## 9. Responsibility and Seam

| Concern | Owner | Why here |
| --- | --- | --- |
| Continuation/strategy/notice text | `SessionGoal.continuationPrompt` (+ `GOAL_LONG_RUN_NOTICE` const beside `STRATEGY_SWITCH_BLOCK`) | already the producer |
| Turn-count threshold | `prompt.ts` continuation gate (const + call-site argument) | the gate owns `goalTurns` |
| Evidence classification | `absorbGoalTurnEvidence` (prompt.ts) | sole classifier; task metadata already carries the child-session identity |
| Tool contract texts | `tool/goal.txt`, `tool/goal.ts` | existing owners |
| Transition error texts | `SessionGoal.modelTransition` | existing owner, minimal rewording |

## 10. Single Approved Primary-Path Design

### 10.1 `continuationPrompt` targeted hunks (ordinary)

Hunk A — section header + bullets:

```diff
-Continuation behavior:
-- This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now.
-- Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task.
-- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.
+Execution:
+- Keep the full objective intact: work on it until it is verifiably complete. You may break the work into steps; finishing one step is a reason to start the next, not to stop. When you identify an authorized action that advances the objective, take it now instead of reporting findings, a plan, or a next-step recommendation. Do not redefine success around a smaller or easier task.
+- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.
```

Hunk B — insert after the (possibly present) strategy block, before "Fidelity:"
(R3: expanded to carry the upstream No-progress semantics in turn-free wording;
the upstream sentences "Classify the previous goal turn…" / "Revalidate a
no-progress turn…" are not copied because they name the turn mechanism):

```text
What counts as progress:
- Progress changes real state or produces evidence that changes what to do next: completed edits, executed checks, a new source inspected, a result that differs from before.
- Re-reading the same content, restating status, rewriting the plan, or describing future steps is not progress when it adds no new evidence or concrete improvement — circling on one small point without a new operation is not progress either.
- An inconclusive check or an empty search result is a fact about that check, not a conclusion about the objective. Change the approach: a different source, different search terms, or a different verification path.
- Waiting counts as progress only while a specific process, job, session, or tool handle is confirmed alive right now. A missing handle or a terminal state means the work has stopped — act on that. A failed or timed-out observation means observe again, not restart.
- If the recent work produced no progress, take the next available safe action directly instead of restating status. If nothing is actionable because the same genuine blocker remains, follow the blocked rules below; a blocker rephrased in different words is still the same condition.
```

Hunk C — Fidelity bullet 1:

```diff
-- Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset or easiest passing change.
+- Optimize every action for movement toward the requested end state, not for the smallest stable-looking subset or easiest passing change.
```

Hunk D — completion trailing paragraph (keeps the test-pinned call phrase):

```diff
-Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof of completion. Marking the goal complete is a claim that the full objective has been finished and can withstand requirement-by-requirement scrutiny. Only mark the goal achieved when current evidence proves every requirement has been satisfied and no required work remains. If the evidence is incomplete, weak, indirect, merely consistent with completion, or leaves any requirement missing, incomplete, or unverified, keep working instead of marking the goal complete. If the objective is achieved, call the goal tool with operate "complete" so usage accounting is preserved. If the achieved goal has a token budget, report the final consumed token budget to the user after the goal tool succeeds.
+Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof of completion; the audit above must prove completion, not merely fail to find remaining work. If the evidence is incomplete, weak, indirect, or leaves any requirement unverified, keep working instead of marking the goal complete. If the objective is achieved, call the goal tool with operate "complete" so usage accounting is preserved. If the achieved goal has a token budget, report the final consumed token budget to the user after the goal tool succeeds.
```

Hunk E — blocked audit bullets 3-4 (bullets 1, 2, 5, 6, 7 and the closing line
stay byte-identical):

```diff
-- If the same blocker still prevents meaningful progress after that exploration, call the goal tool with operate "blocked" in the next eligible Goal turn using the same trimmed reason. The blocked audit requires two consecutive eligible Goal turns; the second valid call marks the goal as blocked.
-- If the user resumes a goal that was previously marked "blocked", treat the resumed run as a fresh audit with the same two-turn and exact-reason requirements.
+- If the same blocker still prevents meaningful progress after that exploration, call the goal tool with operate "blocked" again with the same trimmed reason after the next goal-continuation message arrives; a repeated call while answering the same message does not count as the second confirmation. For an independent judgment, delegate the blocker audit to a subagent with the task tool before confirming.
+- If the user resumes a goal that was previously marked "blocked", treat the resumed work as a fresh audit with the same exact-reason requirements.
```

### 10.2 `STRATEGY_SWITCH_BLOCK` targeted hunks

```diff
-The progress gate entered breadth-first re-plan mode after two consecutive eligible Goal turns produced no new qualifying evidence.
+The recent work produced no new qualifying evidence. This goal needs a breadth-first re-plan.
```

Keep "Keep the Goal active…", the "Evidence strength" section (its gate
mechanics are the judgability contract and are test-pinned), and the
"Required breadth-first re-plan" 7 steps byte-identical.

```diff
-End-of-turn rule:
-- State which frontier node was explored, what authoritative evidence was produced, and which node should be visited next.
-- A prose-only re-plan does not satisfy the progress gate; carry out at least one concrete evidence-producing action when a reachable action exists.
-- If current authoritative evidence already proves every requirement, perform the existing completion audit and mark the Goal complete. Do not create artificial work merely to satisfy the gate.
-- If a real blocker remains, follow the existing two-turn blocked audit exactly. Stagnation by itself is not a blocker.
+Execution rules:
+- A prose-only re-plan does not satisfy the progress gate; execute evidence-producing actions as you select nodes, and keep going to the next node yourself instead of stopping to report what should happen next.
+- If current authoritative evidence already proves every requirement, perform the existing completion audit and mark the Goal complete. Do not create artificial work merely to satisfy the gate.
+- If a real blocker remains, follow the existing blocked audit exactly. Stagnation by itself is not a blocker.
```

### 10.3 `tool/goal.txt` + `tool/goal.ts` targeted hunks

`goal.txt`:

```diff
-Call with `operate: "read"` to get the current goal for this session, including status, objective, token and elapsed-time usage, remaining token budget, and objective generation. You MUST read before changing any status — the tool rejects transitions without a prior read in the same Goal turn.
+Call with `operate: "read"` to get the current goal for this session, including status, objective, token and elapsed-time usage, remaining token budget, and objective generation. You MUST read before changing any status — the tool rejects transitions without a prior read of the current goal state.
```

```diff
-If the same blocker still prevents meaningful progress, call `operate: "blocked"` again in the next eligible Goal turn with the same trimmed reason.
+If the same blocker still prevents meaningful progress after that verification, optionally delegate an independent audit to a subagent with the task tool, then call `operate: "blocked"` again with the same trimmed reason after the next goal-continuation message arrives; a repeated call while answering the same message does not count.
```

```diff
-- Use `operate: "active"` (no reason needed) to resume a goal that you previously marked complete or blocked, but only in a later user-initiated turn. You cannot resume a goal that was paused or terminated by the user.
+- Use `operate: "active"` (no reason needed) to resume a goal that you previously marked complete or blocked, but only after the user has sent a new message. You cannot resume a goal that was paused or terminated by the user.
```

```diff
-- If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least two consecutive resumed goal turns, mark as `blocked` again.
+- If the user resumes a goal that was previously marked `blocked`, treat the resumed work as a fresh blocked audit: the same blocking condition must be verified again before marking `blocked`.
```

`tool/goal.ts`:

```diff
-operate annotation: "...and only confirm the same blocker in the next eligible turn. ... Use `active` to resume a model-produced terminal goal in a later user turn."
+operate annotation: "...and only confirm the same blocker after the next goal-continuation message arrives. ... Use `active` to resume a model-produced terminal goal after the user sends a new message."
```

```diff
-output: `Goal marked as complete: ${goal.reason}. The session loop will end after this turn.`
+output: `Goal marked as complete: ${goal.reason}.`
```

```diff
-output: `Goal marked as blocked: ${goal.reason}. The session loop will end after this turn. The user can resume the goal later.`
+output: `Goal marked as blocked: ${goal.reason}. The user can resume the goal later.`
```

```diff
-"4. If any branch yields a viable path, continue working and do not call blocked again.",
-'If the same blocker still prevents meaningful progress after this exploration, call operate "blocked" in the next eligible Goal turn with the same trimmed reason. Do not mark the Goal blocked merely because the work is hard, uncertain, or incomplete.',
+"4. Delegate an independent audit to a subagent with the task tool: fresh context should judge whether the blocker is real, whether the current route is wrong, and which requirements remain unfinished.",
+"5. If any branch yields a viable path, continue working and do not call blocked again.",
+'If no branch is viable, call operate "blocked" again with the same trimmed reason after the next goal-continuation message arrives; a repeated call while answering the same message does not count. Do not mark the Goal blocked merely because the work is hard, uncertain, or incomplete.',
```

### 10.4 The long-run notice (new mechanism)

New const in `goal.ts` beside `STRATEGY_SWITCH_BLOCK`:

```text
<long-run-notice>
This objective is still unfinished after repeated work. Stay on it autonomously and drive it to full completion: do not stop halfway through, do not narrow it to what is already done, and do not settle into reporting status. Re-read the full objective and every requirement it references, then act:
- If everything is verifiably complete, call the goal tool with operate "complete" and finish.
- If work remains, choose the next or the largest unfinished requirement you are authorized to advance and complete it now. If you have been circling on one difficult part, check the remaining requirements and advance any other authorized, unfinished part instead of repeating the same status.
- If verification keeps hitting the same genuine blocker, follow the blocked verification rules and mark the goal blocked instead of circling further.
</long-run-notice>
```

Wiring:

- `continuationPrompt(goal, mode = "ordinary", longRun = false)`; when
  `longRun`, the notice is inserted after the Budget block and before
  "Work from evidence:". The block can co-occur with the strategy block.
- `prompt.ts` adds one named constant next to `goal_max_turns ?? 32` in the
  continuation gate, with a Chinese comment:

```ts
// 长程督促阈值（用户规则）：同一 runLoop 内续跑超过 8 次后，continuation
// 附加 <long-run-notice>；与 replan 正交，二者可同时出现。
const GOAL_LONG_RUN_TURN_THRESHOLD = 8
```

- Call site: `SessionGoal.continuationPrompt(goal, continuationMode, goalTurns > GOAL_LONG_RUN_TURN_THRESHOLD)`.
  `goalTurns` increments before injection, so the 9th continuation of a runLoop
  is the first to carry the notice. Sessions with `goal_max_turns <= 8` never
  reach it; that is accepted (the user's example assumes the default 32).

### 10.5 Evidence classifier expansion (`prompt.ts`)

Keep the existing four-argument `absorbGoalTurnEvidence` signature and gate
call unchanged. R9 adds only the task branch; the MCP proposal is withdrawn.

New branches at the end of the part loop, after the bash/shell branch:

```ts
// task 的完成代表真实外部工作分支：计为 exploration 并按调用身份去重。
// webfetch/websearch 是只读检索，明确不计（用户规则：Goal 是长程实施任务）。
if (part.tool === "task") {
  const child = typeof metadata.sessionId === "string" ? metadata.sessionId : ""
  if (child && recordIfNew(ledger.commands, `task:${child}`)) exploration = true
  continue
}
```

Task lands in the existing `commands` bucket: exploration (activity) only, never
advancement, so replan can only be exited by the existing advancement classes.
The `GoalProgressLedger` type is unchanged.

### 10.6 `modelTransition` error texts (three minimal rewordings)

```diff
-... wait for the user to resume it, or if you previously ended it, use operate active only in a later real user turn after reading it again.
+... wait for the user to resume it, or if you previously ended it, use operate active only after the user sends a new message; read the goal again first.
```

```diff
-You cannot resume a goal in the same turn that you marked it as complete or blocked. Wait for a new user message before attempting to resume.
+You cannot resume a goal immediately after marking it complete or blocked. Wait for a new user message before attempting to resume.
```

```diff
-You cannot resume a terminal goal from a continuation turn. Resuming a terminal goal requires a new user-initiated turn.
+You cannot resume a terminal goal while responding to a goal-continuation message. Resuming requires a new message from the user.
```

### 10.7 Resume injection and flag-scoped resume cleanup (new mechanisms, R4; rescoped in R7)

Resume injection (INV-15), in `runLoop` between the completion-gate block and
`step++` (prompt.ts:2842-2844). The condition is structural (user directive):
inject when the dispatch target already has an answer — the last message is an
assistant message, not a user-sent message. An unanswered user message (a fresh
prompt or a pending continuation) is dispatched directly, never preempted.

```text
when:  step === 0 AND NOT normalCompletion AND NOT errorCompletion
       AND maxGoalTurns > 0            // continuation 未被配置禁用（round-4 B-01）
       AND active goal AND !session.parentID AND !isDecideAgent(goalAgent)
       AND lastAssistant?.parentID === lastUser.id
       （结构性判定：最后一条消息是 assistant，派发目标已被回答过。正常完成与
         终端错误已被上方 gate 拦截（2717-2842），走到这里的回答必为中断——
         abort error、无 finish、或未完成的 tool-calls。）
action: goalTurns++（与主 gate 同一计数语义），然后以主 gate 的同一形状注入：
        prompt({ noReply: true, source: "system_continue", agent, model, parts: [{
          type: "text", synthetic: true,
          metadata: { goal_continuation: true, goal_continuation_mode: continuationViewMode,
                      goal_continuation_turn: goalTurns, goal_continuation_max_turns: maxGoalTurns },
          text: continuationPrompt(goal, "ordinary") }}])
        continue
```

Why `step === 0` is load-bearing: mid-loop, an assistant that finished with
`finish === "tool-calls"` also satisfies `lastAssistant.parentID === lastUser.id`
while failing both completion predicates, so without the bound every
tool-calling turn would inject a continuation. At loop start the bound fires at
most once, and the condition is self-stabilizing: the injected continuation is
itself an unanswered user message, so on the next iteration
`lastAssistant.parentID !== lastUser.id` and the pending continuation is
dispatched, never re-injected. `goalAgent` is resolved exactly as the gate does
(`agents.get(lastUser.agent)`, prompt.ts:2737).

Injection shape (round-5 N-01): the injected message carries the full
`goal_continuation*` metadata block identical to the owning gate
(prompt.ts:2804-2813), because `deriveGoalTurn`, the blocked-streak adjacency,
and the TUI renderer all key on that marker. `continuationViewMode` uses the
gate's blockedCheck scan (prompt.ts:2764-2775): "block-check" when the
interrupted answer's subtree contains a completed blocked-pending goal call,
else "continue". The text mode is always "ordinary": replan is driven by
no-progress evidence absorbed at completion (prompt.ts:2753-2758), and a resume
has no new completion to classify — the run-local gate state starts fresh
(prompt.ts:2584-2585).

`continueOnError` decision (round-4 N-02): the resume injection fires for any
interrupted previous answer — user abort or provider terminal error alike —
because resuming the goal is a deliberate user action that re-authorizes the
work. `continueOnError` governs the *automatic* error-continuation path
(prompt.ts:2746-2748) and is unchanged; if the provider errors again after the
injection, the normal error/retry path handles it. No new error-path behavior
is introduced.

Resume cleanup (INV-16), scoped by a new optional `LoopInput.cleanupRevert`
flag: the two resume entry points — the goalSet handler
(handlers/session.ts:571) and the background-task resume (task.ts:428) — pass
`cleanupRevert: true`; `prompt()`'s internal call (prompt.ts:2462) does not.
Inside `loop()` (prompt.ts:3341-3344), only when the flag is set:

```ts
if (input.cleanupRevert) {
  const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
  // resume 入口（goal resume / task resume）与 prompt/shell/compact 一样先落
  // revert cleanup，否则被撤消息会进入恢复后第一次 dispatch 的上下文。
  if (session.revert) yield* revert.cleanup(session)
  // 全部历史被撤后无可运行内容：不启动 runLoop。cleanup 只隐藏不删除
  // （revert.ts:197-211），含 hidden 的持久尾部必然存在；两个 flag 调用方都不消费
  // 返回值（task.ts:428 Effect.ignore、handlers/session.ts:571 forkIn+catchCause），
  // 返回尾部仅满足类型合同。Goal 保持 active，等待下一条真实用户输入。
  const hasUser = yield* sessions.findMessage(input.sessionID, (info) => info.role === "user").pipe(Effect.orDie)
  if (Option.isNone(hasUser)) {
    const tail = yield* MessageV2.page({ sessionID: input.sessionID, limit: 1, includeHidden: true }).pipe(Effect.orDie)
    return tail.items[0]
  }
}
```

Why flag-scoped (round-6 B-01): cleanup must never observe a revert boundary
that post-dates a caller's own cleanup-and-create sequence. `prompt()` runs
cleanup at prompt.ts:2430 *before* `createUserMessage` at 2431; if its internal
`loop()` call ran cleanup again, a revert landing in the preamble window would
hide the just-created user message and the loop would silently drop it while
the API returns success. The flag makes the two resume call sites the only ones
that ever run this cleanup. The goalSet path creates no message before calling
`loop()` (handlers/session.ts:541-584: set → gate → fork). The task path
creates one — `inject` writes the background-result message through `prompt()`
(task.ts:444-460), whose own cleanup at prompt.ts:2430 runs before that
create — so cleanup-before-create holds there too; a boundary recorded
afterwards covers that message only because the user reverted it, and hiding it
honors the revert (dual-audit N-01 correction). The `prompt()` path keeps its
existing ordering byte-for-byte; a revert landing in its preamble window
produces the pre-existing stale-context dispatch (the separately reported
class), never message loss.

`cleanup` no-ops when no boundary is pending (guarded by `session.revert`), so
ordinary resumes are unaffected. The empty guard's return path reads the
persisted tail with `includeHidden: true` rather than `lastAssistant`, whose
contract requires a visible message and throws `Error("Impossible")` in the
fully-reverted state (round-5 B-01). The tail provably exists: cleanup hides,
never deletes (revert.ts:197-211), and both resume paths reach `loop()` only
after observing a user message (goalSet gate at handlers/session.ts:563-566;
task resume gate at task.ts:409-413), so at least the hidden rows persist.

Caller inventory (round-6 N-01): `loop()` has exactly three call sites.
prompt.ts:2462 (internal, from `prompt()`) consumes the result at 2464-2496 and
never passes the flag. task.ts:428 (`Effect.ignore`) and handlers/session.ts:571
(`forkIn` + `catchCause`) ignore the return value and pass
`cleanupRevert: true`.

Residual race (accepted, pre-existing class): a revert landing between a resume
entry's `loop()` call and `ensureRunning` marking the session busy leaves its
boundary pending; the resumed dispatch sees not-yet-hidden messages (stale
context, the repro-A class), and the next cleanup-owning entry
(`prompt()`/`shell`/`compact`) consumes the boundary. No message is lost: the
goalSet path creates no message, the task path's only message goes through
`prompt()`'s own cleanup-before-create, and the `prompt()` path never runs
cleanup after create.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Disposition |
| --- | --- | --- | --- |
| Continuation/strategy/notice texts | current → targeted hunks | primary contract | edit |
| Tool/transition texts | current → targeted hunks | primary contract | edit |
| Classifier `commands` bucket for task | new branch in the sole classifier | supported-domain branch within the existing evidence contract (exploration-only) | add |
| Long-run notice | new optional block in the same continuation producer | primary-contract branch gated by the user-specified threshold | add |
| Resume injection (INV-15) | new branch in runLoop | supported-domain branch of the continuation contract (goal-active resume of an interrupted turn) | add |
| Flag-scoped resume cleanup + empty guard (INV-16) | `loop()` runs existing `SessionRevert.cleanup` only when a resume entry passes `cleanupRevert: true` | contracted pass-through to the existing revert lifecycle | add |
| R1 full-section replacement texts | superseded | n/a | rejected (over the 30% reduction cap) |

No alternate success path; both mechanism changes are inside their owning seams.

## 12. Workaround Deletion and Replacement

| Deleted/replaced text | Why | Cover |
| --- | --- | --- |
| "This goal persists across turns. Ending this turn…" | mechanism framing / segmentation affordance (INV-01) | Hunk A keep-working bullet |
| "If it cannot be finished now, make concrete progress…" | "progress now, finish later" affordance | Hunk A act-now bullet |
| 798-char completion trailing paragraph | duplicated the audit list | Hunk D compressed paragraph (pinned call phrase kept) |
| "End-of-turn rule" + "state which node should be visited next" + "at least one concrete…action" | reporting/minimum-effort anchors | §10.2 "Execution rules" |
| turn phrases in blocked/tool/error texts (§10.3/10.6) | INV-01 | action-sequence rewordings |
| "The session loop will end after this turn." (×2) | mechanism leak | dropped; result states the transition only |

## 13. Forward Traceability

| Invariant | Production path | Planned change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | §10.1-10.6 | goal.ts, goal.txt, tool/goal.ts | slice 3 (forbidden-phrase absence across all surfaces) |
| INV-02/03 | Hunk A + Hunk B | goal.ts | slice 1 |
| INV-04 | Hunk D + untouched audit list | goal.ts | slice 1 (updated pins) |
| INV-05 | §10.1 Hunk E + §10.3 | goal.ts, goal.txt, tool/goal.ts | slices 1, 5 |
| INV-06 | envelope/tags untouched | — | existing TUI + prompt tests green |
| INV-07 | targeted hunks | all text files | §23 measurement + review |
| INV-08 | retained sentences | §10.1-10.3 | slices 1, 5 |
| INV-09 | goal.txt user-control bullets | goal.txt | slice 5 |
| INV-10 | §16 mapping | test files | audit review |
| INV-11 | §10.5 | prompt.ts | slice 6 (integration); slice 7 withdrawn |
| INV-12 | no matching branch + comment | prompt.ts | structural; audit-verified |
| INV-13/14 | §10.4 | goal.ts + prompt.ts | slices 2, 8 |
| INV-15 | §10.7 resume injection | prompt.ts | slice 11 (incl. 11b-11e) |
| INV-16 | §10.7 flag-scoped cleanup | prompt.ts (`loop()`) + handlers/session.ts + task.ts | slices 12, 12d |

## 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Progress-judgability block (Hunk B) | INV-02 | user symptom; Codex concept reference | no current surface defines progress |
| Act-now bullets (Hunk A) | INV-03 | user directive | current text permits "progress now, finish later" |
| Advisory blocker audit through the existing task tool | INV-05 | user's R8 directive; §10.1 Hunk E, §10.3, §20 | existing guidance covers self-review but does not suggest a fresh-context review of the blocker, chosen route, and remaining requirements; no new runtime mechanism |
| Classifier task branch | INV-11 | user directive; fall-through read-through | completed task parts currently count as nothing |
| Long-run notice + threshold const | INV-13 | user directive ("超过8次…附加状态") | `continuationPrompt` has no count-varying input |
| Resume-injection branch | INV-15 | repro B; user directive (structural condition) | completion gate only fires on normal/error completion; interrupted-resume falls through to a blind dispatch |
| `cleanupRevert` flag with flag-scoped cleanup + guard | INV-16 | repro A; audit N-04; round-6 B-01 | resume entries call `loop()` without the revert lifecycle pass-through that prompt/shell/compact run at entry (prompt.ts:2430/1627/2515); the flag keeps `prompt()`'s internal call on its existing cleanup-before-create ordering |
| Error rewordings | INV-01 | grep inventory | last turn phrases on error paths |
| Length-restraint bounds | INV-07 | user directive | R1 approach overshot the cap |

## 15. File-Level Change Plan

| File | Change | Expected delta |
| --- | --- | --- |
| `src/session/goal.ts` | hunks A-E + strategy hunks + notice const + signature + 3 error rewordings | ~60 lines |
| `src/session/prompt.ts` | threshold const + call-site arg + task classifier branch + resume-injection branch + flag-scoped `loop()` cleanup + guard | ~45 lines |
| `src/tool/goal.txt` | 4 targeted sentence edits | ~4 lines |
| `src/tool/goal.ts` | annotation + 3 result texts | ~8 lines |
| `src/server/routes/instance/httpapi/handlers/session.ts` | goalSet resume passes `cleanupRevert: true` | ~1 line |
| `src/tool/task.ts` | task resume passes `cleanupRevert: true` | ~1 line |
| `test/session/goal.test.ts` | pin updates + new text-contract slices | ~70 lines |
| `test/tool/goal.test.ts` | 2 assertion swaps + output-absence assertion | ~12 lines |
| `test/session/prompt.test.ts` | long-run threshold + task classifier + resume-injection + resume-cleanup integration tests | ~280 lines |
| `test/server/httpapi-goal.test.ts` | goalSet resume cleanup wiring (revert → resume → hidden; full-revert → no busy) | ~80 lines |
| `test/tool/task.test.ts` | task resume passes the flag (stubOps capture) | ~30 lines |

## 16. TDD Behavior Slices

Seams: `SessionGoal.continuationPrompt` content assertions (goal.test.ts),
`GoalTool` public result/description objects (tool/goal.test.ts), and the
runLoop scripted-provider integration (prompt.test.ts, patterns at 5404-5549).

| Order | Slice | Red today? | Content |
| --- | --- | --- | --- |
| 1 | ordinary continuation contains "work on it until it is verifiably complete", "take it now", "What counts as progress", "Waiting counts as progress only while", "observe again, not restart", "evidence must prove completion"-class bullet; keeps `call the goal tool with operate "complete"`, budget interpolation, "re-check the blocker breadth-first", "adjacent producers, consumers, tests, or configuration", "different focused check", "viable path", "the same trimmed reason"; drops "two consecutive eligible Goal turns" (goal.test.ts:403/438 swap); "Ordinary continuation resumes only after advancement evidence appears" is kept (strategy section untouched there); adds "finishing one step is a reason to start the next, not to stop", the subagent-audit blocked guidance, and "after the next goal-continuation message arrives" | yes | update goal.test.ts pins per §10 |
| 2 | `continuationPrompt(goal, "ordinary", true)` contains `<long-run-notice>`, the drive sentence ("drive it to full completion", "do not stop halfway through"), and the three branches (complete / other-requirements / blocked); default and replan-without-longRun do not; replan+longRun contains both blocks; ordering: notice after Budget, before "Work from evidence:" | yes | new test |
| 3 | forbidden phrases absent ("this turn", "each turn", "next turn", "across turns", "eligible Goal turn", "End-of-turn", "The session loop will end") across both continuation modes + goal.txt + annotations + result texts | yes | new test |
| 4 | strategy block: keeps `mode="breadth-first-replan"`, "Explore breadth-first", "Ordinary continuation resumes only after advancement evidence appears", "stagnation by itself is not a blocker"; drops "End-of-turn" and "at least one concrete evidence-producing action"; adds "execute evidence-producing actions as you select nodes" | partially red | goal.test.ts:436 stays; 438 swapped; new presence/absence pins |
| 5 | goal.txt retains "a second consecutive call", "same trimmed reason", "keeps the Goal active", "viable path", "adjacent producers/consumers/tests/configuration", user-control boundaries; blocked-pending result keeps its pinned phrases plus the new subagent-audit step and the same-message warning, and stays < 2000 chars; complete/blocked results no longer contain "The session loop will end" | partially red | tool/goal.test.ts:223 swap ("next eligible Goal turn" → "after the next goal-continuation message arrives"); new absence pins |
| 6 | classifier task branch: goal + scripted turns — turn1 idle (no evidence) → cont1 ordinary; turn2 completed `task` call (child session answers via the same scripted provider, pattern from prompt.test.ts:2503-2548) → cont2 ordinary (count reset); turn3 idle → cont3 ordinary; turn4 idle → cont4 replan. Without the branch, replan would already arrive at cont2 | yes | new integration test in prompt.test.ts |
| 7 | Withdrawn by the R9 user directive; no MCP-specific test or negative assertion | not applicable | existing MCP code/tests untouched |
| 8 | long-run threshold integration: `goal_max_turns` ≥ 10, nine scripted idle completions then hang; continuation parts 1-8 lack `<long-run-notice>`, part 9 carries it (metadata turn numbers prove position) | yes | new integration test in prompt.test.ts |
| 9 | transition error texts: three reworded messages; tool/goal.test.ts:341 pin swaps "same turn" → "immediately after marking it"; XML-escape and all transition mechanics tests unchanged | yes | mapped update |
| 10 | regression: existing goal/prompt/TUI suites green | no | §18 commands |
| 11 | resume-injection (INV-15): stop mid-first-answer (no continuation ever), resume → the first post-resume answer's parentID is a new continuation, not the old user message; a fresh user prompt with an active goal is NOT preempted | yes (repro B) | new integration test in prompt.test.ts |
| 11b | disable guard: `goal_max_turns: 0` + interrupted turn + resume → NO continuation is injected (round-4 B-01) | no (green today — the branch does not exist; red only via parent slice 11) | extend slice 11 in prompt.test.ts |
| 11c | shape: the injected message carries `goal_continuation: true` + mode/turn/max metadata and is visible to `deriveGoalTurn` chronology (round-5 N-01) | yes | extend slice 11 in prompt.test.ts |
| 11d | provider terminal error with `continueOnError: false`: resume injects goal context; a subsequent provider error follows the normal error path (round-4 N-02 decision) | yes | extend slice 11 in prompt.test.ts |
| 11e | structural stability: a pending unanswered continuation + resume → NO second continuation is injected; the pending continuation is dispatched (structural condition, no marker sniffing) | no (green today — red only via parent slice 11) | extend slice 11 in prompt.test.ts |
| 12 | resume cleanup (INV-16): (a) complete continuation → cancel → revert it → `loop({ cleanupRevert: true })` → the first post-resume provider request does not contain the reverted continuation's text; (b) revert the entire history → `loop({ cleanupRevert: true })` → no provider request is made, no `Session.Event.Error` is published, `loop()` returns the persisted hidden tail without throwing, and the goal stays active; (c) prompt() path regression: a pending revert boundary → `prompt()` → the fresh message is answered and the boundary is consumed by prompt()'s own cleanup (cleanup-before-create intact); `loop()` called without the flag leaves a pending boundary untouched | (a/b) yes (repro A); (c) no (regression pin) | new integration tests in prompt.test.ts |
| 12d | wiring: the goalSet handler and the background-task resume pass `cleanupRevert: true` — goalSet asserted through the HTTP stack (revert → resume → reverted message hidden; full-revert → no busy, no error event, httpapi-goal.test.ts); task resume asserted by extending the stubOps harness with a loop-capture hook (task.test.ts:87-98 records via `onPrompt` today; add an `onLoop`-style capture) | yes | new tests in httpapi-goal.test.ts + task.test.ts |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~580 | goal.ts ~62 (string literals count per the R5 convention), prompt.ts ~45 (threshold + classifier + resume-injection + flag-scoped cleanup), handlers/session.ts ~1, task.ts ~1, goal.txt excluded (prose), tool/goal.ts ~10, tests ~460 |
| Required Chinese explanatory comments `C` | ≥ 87 | `max(1, ceil(580 * 0.15))` |

Planned locations:

1. `GOAL_LONG_RUN_TURN_THRESHOLD`: the user rule and its orthogonality to replan.
2. `GOAL_LONG_RUN_NOTICE`: why the text never names the continuation mechanism.
3. `continuationPrompt` Hunk A/B: de-segmentation rationale + judgability source.
4. Hunk E: why the two-call rule is now an action sequence.
5. Strategy-block hunk: why the report-next-step line was removed.
6. Task classifier: why child-session evidence is exploration rather than advancement.
7. Reserved historical MCP item, withdrawn in R9; no replacement comment or assertion.
8. Three error-rewording comments.
9. Resume-injection branch: why the condition is structural (dispatch target already answered ⇔ last message is assistant), why `step === 0` is load-bearing (tool-calls turns would false-positive), why the text mode is always "ordinary", and why a deliberate resume re-authorizes interrupted work regardless of `continueOnError`.
10. Flag-scoped cleanup: why `cleanupRevert` is only ever passed by the two resume entries (cleanup-before-create on the `prompt()` path; round-6 B-01), why the empty guard returns the persisted tail (`includeHidden: true`) rather than `lastAssistant` (round-5 B-01), and the accepted residual race.
11. `maxGoalTurns > 0` guard inherited from the owning gate (round-4 B-01); injection reuses the gate's metadata block (round-5 N-01).
12. Blocked guidance: why the second confirmation is tied to the next goal-continuation message (the runtime counts canonical turns, not calls; goal.ts:401-415), and why the subagent audit is advisory, not a new mechanism.
13-87. Per-slice behavioral-intent comments in tests (repo precedent is dense interleaved comments).

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/session/goal.test.ts` | `packages/opencode` | slices 1-4, 9 + transition mechanics |
| `bun test test/tool/goal.test.ts` | `packages/opencode` | slice 5 + tool-path two-turn audit |
| `bun test test/session/prompt.test.ts` | `packages/opencode` | slices 6-8, 11-12 + existing gate/continuation integration |
| `bun test test/server/httpapi-goal.test.ts` | `packages/opencode` | slice 12d goalSet wiring |
| `bun test test/tool/task.test.ts` | `packages/opencode` | slice 12d task wiring |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | envelope/card regression |
| `bun typecheck` | `packages/opencode` | type safety |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 |  |
| Files modified | 11 | 6 production (including goal.txt) + 5 test, as enumerated in §15 |
| Files deleted | 0 |  |
| Production lines | ~115 changed | text + two mechanism branches |
| Test lines | ~450 | eight integration tests + contract slices |
| Generated lines | 0 | none |

## 20. Real Risks and Open Decisions

- The long-run notice names prolonged work ("repeated work") but never the
  continuation mechanism or turn counts; the visible counter stays user-side
  metadata. This matches the user's escalation intent without reintroducing
  segmentation framing into the base contract.
- Classifier exploration credit for task resets the raw no-progress count;
  it cannot exit replan (advancement-only). A goal consisting purely of
  read-only research still cannot produce advancement by design — unchanged
  from today; the user accepted this by ruling webfetch out.
- R9 removes the proposed MCP classification entirely; the earlier MCP
  argument-order/disconnection notes in the audit history are superseded.
- The blocked guidance's subagent audit is advisory: it uses the existing task
  tool, adds no mechanism, and the two-confirmation mechanics in
  `modelTransition` are unchanged.
- Pre-existing and out of scope: the compaction auto-continue text tells the
  model to "stop and ask for clarification if you are unsure how to proceed"
  (compaction.ts:1150). It is a separate handback outlet that this plan does
  not change; record it as retained behavior, not as a repaired surface.

### Open Decisions Requiring the User

1. First-injection gap: after `/goal` set, the objective reaches the model only
   via `goal(read)` or the first continuation. Runtime change, separate plan.
2. Continuation drops the user-selected model `variant` (prompt.ts:2791 →
   1895-1903). Runtime fix, separate plan.

### Rejected Speculation

- Per-count escalating prompt series (beyond the single threshold): the user
  specified exactly one threshold; more tiers would re-create turn framing.
- Counting webfetch/websearch as exploration: explicitly ruled out by the user
  (read-only external lookups do not evidence a long-horizon implementation
  task); the classifier comment blocks future drift.
- Verbatim borrowing of Codex's "No-progress check" (measured 1,039 chars):
  its "previous goal turn" framing conflicts with INV-01. The user authorized
  incorporation; R3 adapts the three-way classification, verified-wait, and
  equivalent-blocker semantics in fork wording (Hunk B) instead of copying.
- Moving the blocked checklist out of the continuation (R1's just-in-time
  relocation): abandoned under the 30% restraint cap; the checklist stays and
  only its turn phrases are reworded.

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
| 1 | R1 (text-only) | yes | none | N-01..N-03 (record corrections, folded in R1) | APPROVE, then scope-expanded by the user before implementation; R1 closed | adversarial-auditor task `ses_f452f0675ffeAcPkaNXUQYUVxR` |
| 2 | R2 | yes | none | N-01 (§4 fixture citation corrected: MockClient has no `callTool`; slice 7's local mock adds it), N-02 (slice 6 narration corrected: without the branch, replan arrives at cont2), N-03 (INV-04 label: the audit list has 8 bullets), N-04 (INV-07 ordinary-size estimate corrected to slight growth; the cap limits reduction, not growth) | APPROVE (verbatim verdict below) | adversarial-auditor task `ses_f44f8ac3affeJzc2g6d6Uz0Fn5` |
| 3 | R3 | yes | none | N-01 (slice 1 garbled clause fixed), N-02 (INV-07 estimates corrected to auditor-recomputed values), N-03 (MCP key lacks arg-order normalization; bounded to exploration over-credit), N-04 (gate-time MCP id resolution misses mid-turn disconnects; bounded, self-correcting) | APPROVE (verbatim verdict below) | adversarial-auditor task `ses_f4338d8d9ffeMRE1K72R5wph3K` |
| 4 | R4 | yes | B-01 (resume-injection omitted the `goal_max_turns = 0` disable guard) | N-01 injection shape under-specified; N-02 continueOnError decision unstated; N-03 record citations incomplete; N-04 empty-post-cleanup corner | BLOCK | adversarial-auditor task `ses_f42aa1980ffenEFMhAAorCyYSe` |
| 5 | R5 | yes | B-01 (N-04 empty-guard return path routes through `lastAssistant`, which throws "Impossible" in exactly the fully-reverted state being guarded) | N-01 `<当前 continuationMode>` placeholder should name the gate's `continuationViewMode`; N-02 E estimate drift | BLOCK | adversarial-auditor task `ses_f427fb7d0ffePqbtCjbnh20I5X` |
| 6 | R6 | yes | B-01 (loop-entry cleanup+guard breaks the cleanup-before-create ordering on the internal `prompt()` → `loop()` path; a revert landing in the prompt preamble window silently hides the just-accepted user message and returns it as a success-shaped result, or dispatches an older message in its place) | N-01 (the §10.7 caller inventory is incomplete: `loop()` has three call sites and the internal `prompt()` call consumes the result) | BLOCK | adversarial-auditor task `ses_f4266c00dffeb1Py7M79SVVsc5` |
| 7 | R7 | yes | none | N-01 (slice-table red labels over-covered guard sub-slices 11b/11e/12c), N-02 (stubOps needs an `onLoop`-style capture hook), N-03 (§17/§19 estimate drift) | APPROVE (verbatim verdict below), then superseded by the user's dual-audit review before implementation | adversarial-auditor task `ses_f421feaf7ffeMIEmhMl0m6rvM6` |
| 8a | R7 | yes | B-01 (blocked wording dropped the runtime's confirmation boundary: a repeated call while answering the same message never increments the streak, so the instructed sequence cannot reach blocked) | N-01 (task caller-chain claim inaccurate: `inject` creates the background message via `prompt()` before resume); N-02 (MCP disconnect bound already recorded) | BLOCK | adversarial-auditor task `ses_f41fefec1ffey4uUdnq3JecbVn` |
| 8b | R7 | yes | B-01 (same finding, independently derived) | N-01 (same task caller-chain correction); N-02 (MCP id resolution bound already recorded) | BLOCK | adversarial-auditor task `ses_f41fefe79ffeCWZn9vysVKOSkI` |
| 9 | R8 | yes | B-01 (metadata integrity: the canonical header still declared `Revision: R7 / Approved revision: R7 / Status: approved / Implementation allowed: yes` while the body carried the unaudited R8 content and §22 recorded R7 as BLOCKED; the R8 design content itself was verified — dual-audit B-01 and N-01 closed, all four wording corrections faithful, no forbidden phrases, no carried-scope regression) | N-01 (§14 has no dedicated row for the blocked-guidance subagent delegation; mapping is split across §13/§20) | BLOCK (metadata-only; design verified) | adversarial-auditor task `ses_f41e27687ffegoJClERT5iLde7` |

Round 10 (additional full-scope audit explicitly authorized in §1):

- Audited revision: R8; full scope: yes.
- Auditor: `adversarial-auditor`, task `ses_f41d84a88ffeoXmeZhlGAhEYcu`.
- Blocking findings: "No blocking findings."
- Non-blocking N-01: §1 can include the full later user requirements already
  supplied verbatim to the auditor; no behavioral omission was found.
- Non-blocking N-02: direct "Delegate" wording and optional/advisory wording
  differ in tone; delegation is not a runtime prerequisite. Retained as an
  optional wording note, without changing the audited design.
- Result: APPROVE. This recording changes release metadata only; no design
  text is changed with the verdict.

Round 10 verdict (verbatim):

> **APPROVE — 仅适用于本次读取的 `docs/plans/goal-prompt-contract-repair.md` 当前 R8。**
>
> 文件头已明确为 `audit-required / R8 / Approved revision: none / Implementation allowed: no`，不存在继续沿用 R7 批准的状态问题。整体设计保持克制，未发现需要扩展机制或推翻方案的实质缺陷。记录本轮结论后可按政策批准该精确版本；后续实质修改须重新审计。

Round 7 verdict (verbatim):

> **APPROVE** — applies only to canonical plan revision **R7** of `docs/plans/goal-prompt-contract-repair.md` (Status `audit-required`, `Implementation allowed: no` at audit time). Round-6 B-01 and N-01 are verifiably closed; the new user directive is faithfully absorbed into INV-15's structural condition; the carried R1-R4 scope shows no regression against current source. Non-blocking findings N-01..N-03 are record corrections and implementer notes; they do not prevent approval. Implementation must target exactly this revision; any substantive change invalidates this verdict.

> Blocking findings: "No blocking findings."

N-01..N-03 are folded into §16/§17 of this file without design change,
consistent with the policy's non-blocking record-correction rule.

Round 9 verdict (verbatim):

> **BLOCK** — applies only to canonical plan revision **R8** of `docs/plans/goal-prompt-contract-repair.md` as read (header still declares `Revision: R7 / Approved revision: R7 / Status: approved / Implementation allowed: yes`). The R8 design content itself is verified: dual-audit B-01 and N-01 are verifiably closed against the runtime, all four user-directed wording corrections are faithfully implemented with the two-line restraint honored, no INV-01 forbidden phrase appears in any new text, and the complete carried scope shows no regression versus the round-7-approved state. The single blocker B-01 is metadata/state integrity: the canonical header asserts approval and implementation-permission for a revision that this same file records as BLOCKED, while the body carries substantive unaudited R8 changes. The correction is administrative and design-neutral (align header to `Revision: R8`, approval cleared, `Status: audit-required`, `Implementation allowed: no`, add the R8 note); per the policy, any edit then requires this verdict to be recorded against the corrected revision. This is plan-audit round 9 — the third and final of the three extra rounds the user authorized after round 6 — so B-01 is preserved as a blocking open decision for the user, implementation remains disallowed, and no further audit round is available under the current authorization.

Round 8 verdicts (dual audit, verbatim):

> **BLOCK** — 仅针对本次读取的 canonical R7。必须保留并解决 B-01。其余文本调整总体克制，长程执行导向和大部分有价值的约束得到保留；无需因这一处契约矛盾推翻整个方案或扩大实现范围。 (audit A)

> **BLOCK** — 仅针对本次审计的 canonical R7。保留 B-01。整体方案多数改动面自洽，未发现需要另建机制的大范围缺陷；但 blocked 文案当前把必要执行条件删成了无法兑现的“检查后再调用”，应先做局部契约修正，再接受完整范围复审。 (audit B)

R8 dispositions: dual-audit B-01 → the blocked guidance now states the real
validity window without turn vocabulary (the second confirmation counts only
after the next goal-continuation message arrives; a repeated call while
answering the same message does not count), and the recheck gains an optional
subagent audit per the user's directive (goal.ts Hunk E, goal.txt, tool
annotation, pending output). Wording corrections per the user: Hunk A permits
decomposition but forbids stopping after one step; Hunk B's not-progress
bullet merges both phrasings; the long-run notice advances "the next or the
largest" unfinished requirement; §10.6's third error text names the
goal-continuation message concretely. Dual-audit N-01 → §10.7's caller-chain
claim corrected (the task path injects its result through `prompt()`, whose
cleanup-before-create is preserved). Round 9 audits R8.

Round 6 verdict (verbatim):

> **BLOCK** — applies to canonical plan revision **R6**. Round-5 B-01, N-01, and N-02 are verifiably closed, and the carried R1-R4 scope shows no regression. However, the INV-16 loop-entry cleanup+guard (carried from R4/R5 with the R6-corrected return path) is specified at a seam where it newly breaks the repository's cleanup-before-create ordering on the internal `prompt()` → `loop()` path: a revert completing in the prompt preamble window silently hides the just-accepted user message and returns it as a success-shaped result, or dispatches an older message in its place (B-01 above). This is plan-audit round 6 of 6; per policy, B-01 is preserved as a blocking open decision for the user, implementation remains disallowed (`Implementation allowed: no` stands), and any R7 repairing the ordering at the `SessionPrompt.prompt`/`loop` seam — with the §10.7 caller inventory completed (N-01) — requires a new full-scope audit under the user's explicit direction.

Round 6 open decision (preserved for the user): R7's minimal correction
direction is to scope the loop-entry cleanup+guard to the resume entry paths
it was designed for (goalSet and task resume), so `prompt()`'s internal
`loop()` call keeps its existing cleanup-before-create guarantee
(prompt.ts:2430 cleanup precedes 2431 create; the new cleanup must not observe
a boundary that post-dates that sequence), and to complete the §10.7 caller
inventory (three call sites: prompt.ts:2462 consumes the result;
task.ts:428-429 and handlers/session.ts:571 ignore it).

R7 dispositions: round-6 B-01 → cleanup+guard scoped behind the new
`LoopInput.cleanupRevert` flag, passed only by the two resume entries (goalSet
handler, task resumeWhenIdle); `prompt()`'s internal `loop()` call never sets
it, so cleanup-before-create is structurally preserved and the preamble race
can no longer hide a fresh message. Round-6 N-01 → the §10.7 caller inventory
now records all three `loop()` call sites with their result-consumption
semantics. User directive → INV-15's condition is rewritten structurally
(inject when the dispatch target already has an assistant answer), dropping
marker sniffing and the error/no-finish qualifier; slice 11e pins the
self-stabilization. The R6-verified guard return path (persisted tail via
`includeHidden: true`) is unchanged.

Round 5 verdict (verbatim):

> **BLOCK** — applies to canonical plan revision **R5**. Round-4 B-01, N-01, N-02, and N-03 are verifiably closed, and the carried R1-R4 scope shows no regression. However, the R5-added empty-post-cleanup guard (the N-04 disposition) specifies a return path (`lastAssistant`) that deterministically throws `Error("Impossible")` in exactly the fully-reverted state it guards, leaving the round-4 N-04 defect un-repaired under a different message and untested by slice 12 (B-01 above). Repair requires revising §10.7's guard return path at the `SessionPrompt.loop` seam plus a slice-12 extension covering revert-entire-history → resume, followed by a new full-scope audit (round 6 of 6).

R6 dispositions: B-01 → the guard's return path reads the persisted tail via
`MessageV2.page({ includeHidden: true })` (cleanup hides, never deletes;
revert.ts:197-211) instead of `lastAssistant`, with the reachability proof
recorded in §10.7; slice 12 gains the revert-entire-history leg (no request,
no error event, no throw, goal stays active); N-01 → the pseudocode
placeholder is replaced by `continuationViewMode` and the computation is
pinned to prompt.ts:2764-2780; N-02 → §17/§19 estimates updated.

Round 4 verdict (verbatim):

> **BLOCK** — applies to canonical plan revision R4. B-01 must be repaired (guard added to INV-15/§10.7 plus a config-0 assertion in slice 11), with N-01..N-04 folded in; the revision then requires a new full-scope audit.

R5 dispositions: B-01 → `maxGoalTurns > 0` added to INV-15/§10.7 + slice 11b;
N-01 → injection shape pinned to the gate's metadata block in §10.7 + slice
11c; N-02 → continueOnError decision stated in §10.7 + slice 11d; N-03 →
citations added to §11/§13/§14/§15; N-04 → empty-post-cleanup guard added to
the `loop()` entry in §10.7.

Round 3 verdict (verbatim):

> **APPROVE** — applies only to canonical plan revision **R3** of `docs/plans/goal-prompt-contract-repair.md` (Status `audit-required`, `Implementation allowed: no` at audit time). Non-blocking findings N-01..N-04 are record corrections and design-margin notes for the implementer and the implementation audit; they do not prevent approval. Implementation must target exactly this revision; any substantive change invalidates this verdict.

> Blocking findings: "No blocking findings."

N-01..N-04 were record-level corrections and are folded into §7, §16, and §20 of
this file without design change, consistent with the policy's non-blocking
record-correction rule.

Round 2 verdict (verbatim):

> **APPROVE** — applies only to canonical plan revision **R2** of `docs/plans/goal-prompt-contract-repair.md` (Status `audit-required`, `Implementation allowed: no` at audit time). Non-blocking findings N-01..N-04 are record corrections for the implementer and the implementation audit; they do not prevent approval. Implementation must target exactly this revision; any substantive change invalidates this verdict.

> Blocking findings: "No blocking findings."

N-01..N-04 were record-level corrections and are folded into §4, §7, and §16 of
this file without design change, consistent with the policy's non-blocking
record-correction rule.

Round 1 verdict (verbatim, historical):

> **APPROVE** — applies only to canonical plan revision **R1** of `docs/plans/goal-prompt-contract-repair.md`. Non-blocking findings N-01 to N-03 are record corrections for the implementer and the implementation audit; they do not prevent approval.

R2 delta: scope expanded to mechanism changes (classifier + long-run notice),
webfetch explicitly excluded from evidence, and the text repair converted from
full-section replacement to targeted hunks with a ≤30% net-reduction cap. R2
requires a fresh full-scope audit.

Any substantive revision invalidates earlier approval.

R9 full-scope plan audit (implementation-stage scope correction):

- Auditor/task: `adversarial-auditor`, `ses_f404697a6ffemrq44vgZIt9uzg`.
- Initial verdict: BLOCK on B-01 (interpreted the MCP schema prohibition as
  forbidding the internal LoopInput flag) and B-02 (interpreted the prohibition
  on delegated implementation as revoking product blocker-audit guidance).
- Same-task reconsideration, no design change: both withdrawn. Repository
  consumers show LoopInput is internal, not a tool/HTTP/SDK/persistence schema;
  the user's implementation-delegation instruction does not revoke their
  explicit product guidance requirement. Historical MCP evidence, advisory
  wording variation and actual E/C calculation remain non-blocking notes.
- Final blocking findings: "No blocking findings."

Final release verdict (verbatim):

> **APPROVE — 仅适用于本次读取的 `docs/plans/goal-prompt-contract-repair.md` 精确 R9。**
>
> 这是同一轮的更正后最终裁决，替代本轮先前的 BLOCK；记录时应保留 B-01、B-02 及其撤回理由。无需为这次纯审计纠错修改设计或递增 revision。
>
> 批准仅允许按 R9 进入实施，不释放当前部分实现。完成仍需实际红绿测试、规定验证、至少 15% 合格中文解释性注释，以及独立完整范围的实现审计。

## 23. Implementation Evidence

Implementation targets approved R9. The user narrowed R8 during execution:
all newly added MCP-specific code/tests were removed, and R9 was independently
approved before continuing. Existing unrelated staged files were preserved.
No commit or index operation was performed. Initial text slices were delegated
before the user prohibited delegated implementation; their exact diff was
subsequently inspected by the primary agent. All runtime work and subsequent
edits were performed by the primary agent.

### Actual Files and Diff

Production files (all under `packages/opencode`):

- `src/session/goal.ts`: approved text hunks, long-run block/parameter and
  transition-error wording; persisted transition behavior unchanged.
- `src/tool/goal.ts`, `src/tool/goal.txt`: approved tool instructions/results.
- `src/session/prompt.ts`: task exploration only; threshold 8 next to default
  maximum 32; interrupted-resume injection; internal resume cleanup option.
- `src/server/routes/instance/httpapi/handlers/session.ts`, `src/tool/task.ts`:
  one-line internal resume-option wiring at each existing caller.

Tests: `test/session/goal.test.ts`, `test/tool/goal.test.ts`,
`test/session/prompt.test.ts`, `test/server/httpapi-goal.test.ts`,
`test/tool/task.test.ts`. No existing MCP code/test, tool result schema,
persistent schema, migration or dependency change. Canonical plan updated only
for the user-directed scope correction and evidence/approval records.

### Red-Green Test Evidence

All commands below ran from `packages/opencode` using Bun 1.3.14.

| Slice | Command / feedback | Red | Green |
| --- | --- | --- | --- |
| 1 | `bun test test/session/goal.test.ts -t "continuationPrompt contains objective and usage"` | expected new action/confirmation wording absent | 1 pass (delegated text slice) |
| 2 | `bun test test/session/goal.test.ts -t "continuationPrompt long-run notice"` | notice absent | with ordinary slice, 2 pass |
| 4 | `bun test test/session/goal.test.ts -t "continuationPrompt replan mode"` | execution wording absent | all continuationPrompt tests, 4 pass |
| 5 | `bun test test/tool/goal.test.ts -t "blocked streak through tool"` | confirmation boundary/subagent wording absent | 1 pass |
| 5/9 | tool test filters `complete after read succeeds`, `active recovery same turn through tool`, `user-produced terminal cannot` | old result/error wording | each passes after its text edit |
| 8 | `bun test test/session/prompt.test.ts -t "goal long-run notice"` | ninth persisted continuation missing notice | 1 pass, 5 assertions |
| 6 | `bun test test/session/prompt.test.ts -t "credits a completed task"` | modes continue/replan/replan/replan instead of continue/continue/continue/replan | 1 pass, real task execution |
| 11 | `bun test test/session/prompt.test.ts -t "goal resume injects context"` | first resumed assistant parents original user instead of newly injected continuation | 1 pass |
| 12(b) | `bun test test/session/prompt.test.ts -t "goal resume leaves fully reverted"` | provider requests made after full revert | 1 pass after flag-scoped cleanup |
| 12d task | `bun test test/tool/task.test.ts -t "background task completion does not wait"` | captured internal loop input missing cleanup option | 1 pass |
| 12d HTTP | `bun test test/server/httpapi-goal.test.ts -t "goal resume after reverting"` | SSE reports busy after full revert | 1 pass, 8 assertions |

Guard/regression cases preserve fresh input, pending continuation, disabled
continuations, explicit resume after provider error and ordinary prompt
cleanup-before-create. The partial-revert case passed after the earlier
resume-injection repair because injection itself calls the existing prompt
cleanup; it is retained as the original feedback-loop regression, not reported
as an independent red. The full-revert slice supplied the red for the cleanup
branch. One new error-resume test initially used max=1 and expected active;
existing cap handling correctly paused it. The fixture was changed to max=2
to isolate error policy from cap handling; production pause logic was untouched.

### Verification Commands and Results

| Command | Result |
| --- | --- |
| `bun test test/session/goal.test.ts --timeout 30000` | 49 pass, 0 fail, 163 assertions |
| `bun test test/tool/goal.test.ts` | 11 pass, 0 fail, 81 assertions |
| `bun test test/session/prompt.test.ts --timeout 60000` | 115 pass, 14 existing conditional skips, 0 fail, 513 assertions; 817.44 seconds |
| `bun test test/tool/task.test.ts --timeout 30000` | 30 pass, 0 fail, 96 assertions |
| `bun test test/server/httpapi-goal.test.ts --timeout 30000` | 13 pass, 0 fail, 35 assertions |
| `bun test test/cli/cmd/tui/session-message-render.test.tsx --timeout 60000` | 104 pass, 0 fail, 863 assertions |
| `bun typecheck` | pass, including final runtime/tests |
| `git diff --check` (repository root) | pass; existing LF/CRLF notice on plan only |

Initial aggregate commands timed out (prompt suite at 600 seconds; combined
goal/tool/task/HTTP at 360 seconds; standalone goal at 180 seconds). They were
not counted as passes. Standalone complete runs above used adequate command
time budgets. The first TUI run had two stress-test timeouts at Bun's default
5 seconds; rerunning with `--timeout 60000` passed all 104 without editing any
test or assertion. Its successful run emitted an ENOENT temporary KV teardown
warning. The prompt suite emitted the existing scripted reviewer 503 error;
the complete suite still exited successfully. No test timeout/skip was changed
in source. The package's own test script already uses `--timeout 30000`.

### Original Feedback-Loop Result

- Actual hang/cancel/resume: first resumed answer has the newly injected
  continuation as parent and its provider request contains the Goal objective.
- Actual continuation/revert/resume: first resumed provider request excludes
  the distinct withdrawn-text marker, old message carries hidden reason undo,
  and the pending revert boundary is consumed.
- Full-history revert at service and HTTP seams: no provider dispatch/busy
  session or error; Goal remains active and waits for new user input.

### Actual Secondary and Replacement Path Inventory

One existing continuation producer; new long-run block is a parameterized
branch. Task evidence extends the existing exploration classifier, never
advancement. Interrupted resume substitutes one continuation before first
dispatch. Cleanup forwards to existing SessionRevert semantics only at the
two opted-in internal resume callers. Hidden-tail return is the approved
empty-history no-op; callers ignore its value. No fallback, external verifier,
new persistence, diagnostic algorithm, or replacement tool implementation.
Superseded work: withdrawn MCP identification/test additions were removed.
No pre-existing workaround or unrelated code was removed.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 422 | added/replacement nonblank code in 10 TS files; imports, comment-only lines and goal.txt prose excluded; no formatter/generated/pure-move changes |
| Qualifying Chinese comment lines `C` | 72 | adjacent rationale for Goal confirmation, first-dispatch identity, cleanup ordering, cap boundary, real cancel/revert fixtures, provider/error policy isolation and task/HTTP wiring |
| Ratio `C / E` | 17.06% | primary count; independently recompute from diff |
| Required minimum `C` | 64 | `ceil(422 * 0.15)` |

### Remaining Unverified Items

No live-provider autonomous-model endurance experiment was run; scripted
providers verify runtime contracts, not guaranteed model compliance. The 14
existing platform/availability conditional skips in the prompt suite remain
unchanged. No build/SDK regeneration/migration is required by this change.
Historical open decisions in §20 remain outside the approved scope. Independent
full-scope implementation audit completed with APPROVE after same-round factual
reconsideration; no implementation changes were made during reconsideration.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | Initial B-01 claimed completion-gate fallthrough bypassed Agent.steps; withdrawn on same-task control-flow reconsideration | Initial command timeouts rerun successfully; existing 14 conditional skips and scripted reviewer 503 retained | APPROVE; No blocking findings | `ses_f400b2400ffecxN38PwxCEmz0c` |

Initial finding retained for traceability: the auditor claimed the normal
completion gate could decline injection and fall through into the new resume
branch. Reconsideration supplied the exact enclosing `continue`/unconditional
`break` paths (prompt.ts:2837/2851). The auditor re-read the full scope and
withdrew B-01: both completion predicates must be false to reach the resume
branch. No added guard, test, or design change was made to satisfy that
incorrect reachability claim.

Final blocking statement (verbatim):

> No blocking findings.

Final release verdict (verbatim):

> **APPROVE**
>
> This verdict applies only to the unchanged actual implementation diff against approved canonical plan revision R9.

The auditor independently reran all six suites, typecheck and diff check,
confirming the results in §23, and independently recomputed E=422, C=72,
72/422=17.06%. This verified-state edit only records audit results; it changes
no production behavior, test or approved design.

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
