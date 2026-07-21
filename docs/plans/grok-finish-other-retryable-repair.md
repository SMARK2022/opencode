# Canonical Implementation Plan: Treat Provider `finish="other"` as Retryable Incomplete Completion

> Status: verified
>
> Revision: R8
>
> Approved revision: R8
>
> Audit mode: plan
>
> Requirement source: verbatim user request in the active Session GOAL
>
> Implementation allowed: no
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 因此,目前请你详细完整调研一下,让相应的SDK的相关内容将finish的reason等于other的时候,能够让其正常变成需要retry的内容,也就是将其整体内容变成一个可以被要么被抛出的一个可重试的一个错误,或者说什么样的。总之需要被外面的相应的重试机制所捕获,请你检查这一点,看看应该如何实现。与此同时,需要保证整体的方案实现较为精巧,且不会引入过度的依赖等等内容,也就是实现的时候整体的修改量较少。整体文件越少越好,同时其相应最好进行精准修改,也就是将适当的逻辑处进行精巧的一个修改,使得引入最少的兼容性问题,同时提高最好的整体效果,提高相应的鲁棒性。总体代码修改量尽最好在400行以内。

## 2. Explicit Non-Goals

- Do not modify the Goal continuation policy or make Goal responsible for provider response validity.
- Do not modify SSE idle timeout, absolute timeout, transport buffering, or network proxy behavior.
- Do not modify the installed `@ai-sdk` package, `node_modules`, provider dependencies, or the `grok-oauth` credential/configuration surface.
- Do not add a second retry implementation, provider-specific fallback, or alternate success path.
- Do not change recognized `stop`, `length`, `content-filter`, or `tool-calls` semantics.
- Do not repair historical SQLite records or add a migration.
- Do not modify the existing retry scheduler/classification in this revision. The repair only routes the proven incomplete `other` semantic into the existing retryable error contract; retry-policy optimization is a separate follow-up.
- Do not modify Tool lifecycle, permission reviewer, EventV2/TUI projection, Goal continuation, or other adjacent consumers in this revision. Their reachable boundaries are reported as risks and follow-up prompts only.
- Do not replay Tool-bearing `other` attempts in this revision. The current prompt loop treats assistant Tool Parts as a reason to continue rather than final completion; any later retry/replay policy remains outside this repair.
- Do not create a generic finish-reason classifier abstraction: the normal Session processor owns the requested semantic conversion at the first divergence.

### User Scope Amendment (2026-07-22)

> 请注意理论上这个问题在很多情况下都有，这本质是retry的逻辑问题而不在finish的重试逻辑；也就是现在的目的是把other的语义引流到重试中，而不是修改重试逻辑，那个问题我们之后在重试逻辑修改中优化；与此同时如果已经有了tool，理论上应该不会是最后一轮次？（我记得理论上只要有tool调用都不会是最后一轮次）
>
> 与此同时请注意整体审计轮数改成12轮，请完整认真检查方案后再进行审计，同时不需要让方案变得考虑其他模块组件的边界问题，你只需要报告与提示即可，那些不是本次修改的涉及面

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Defines Message, Provider, Session, Run state, and the distinction between Status and Run state. |
| `.opencode/policy/first-principles-engineering.md` | Requires repair at the first divergence, one authoritative path, no fallback, forward/reverse traceability, and full-scope verification. |
| `.opencode/templates/canonical-plan.md` | Defines the required plan sections and audit metadata. |
| `packages/opencode/AGENTS.md` | Requires package-local conventions and Effect/error handling rules. |
| `packages/opencode/test/AGENTS.md` | Requires `testEffect`, live fixture guidance, and synchronization through observable signals. |
| `packages/llm/AGENTS.md` | Confirms provider protocol ownership and common finish-event semantics; no change is planned there because the active v1 path is `packages/opencode/src/session`. |
| `docs/adr/README.md` and ADR-0001 | No accepted ADR governs provider retry semantics; no new ADR is needed for this bounded shared-completion repair. |
| `packages/opencode/package.json` | Tests run with Bun; typecheck command is `bun typecheck`/the package `typecheck` script from the package directory. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `/Users/sunbenteng/.local/share/opencode/opencode.db`, read with `sqlite3 -readonly` and `PRAGMA query_only=ON` | Directly observed 3469 Grok assistant Messages: 42 `finish="other"`, including 27 reasoning-only and 11 text-without-tool records. | observed |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T113317.log` lines 6010-6019 | Directly observed HTTP 200 SSE, `sse.end`, `maxGapMs=53327`, and `processor.end` without timeout/error for `msg_f8489aa...`. | observed |
| Same log lines 8794-8812 | Directly observed a no-Goal Grok `finish="other"` sample ending in `sse.end` and `session.prompt exiting loop`. | observed |
| SQLite `request_usage_assistant` rows for all Grok `finish="other"` records | All 42 rows have `status=completed`, `time_completed` set, and no usage error. | observed |
| `packages/opencode/src/session/processor.ts` lines 721-755 | Owns `finish-step` semantic completion and currently rejects only empty `other`, then persists partial `other` as completed. | observed |
| `packages/opencode/src/session/processor.ts` lines 377-399 and 792-815 | Shows reasoning/text flags that allow partial `other` to bypass the current guard. | observed |
| `packages/opencode/src/session/processor.ts` lines 1031-1075 | Shows the existing `SessionRetry.retry` consumer around the stream and its retry/error path. | observed |
| `packages/opencode/src/session/retry.ts` lines 71-210 | Shows `MessageV2.APIError` with `isRetryable=true` is already the orchestration contract; no new retry policy is needed. | observed |
| `packages/opencode/src/session/message-v2.ts` lines 91-99 and 1848-1852 | Shows the typed retryable APIError and preservation of already classified APIError instances. | observed |
| `packages/opencode/test/session/processor-effect.test.ts` lines 1286-1476 | Existing empty-`other` retry test and the current test that explicitly protects the wrong partial-`other` behavior. | observed |
| `packages/opencode/test/session/retry.test.ts` lines 71-210 | Existing retry classification and schedule contract. | observed |
| `packages/opencode/test/lib/llm-server.ts` lines 456-591 | Provides deterministic SSE fixtures, reasoning/text output, connection reset, and ordered retry responses. | observed |
| `packages/opencode/src/provider/provider.ts` lines 127-265 and 1924-2011 | Confirms raw SSE timeout/error handling is separate from semantic `finish-step`; no transport change is needed. | observed |
| `packages/opencode/src/session/prompt.ts` lines 2569-2595 | Confirms non-`tool-calls` finish values can be treated as normal completion after processor acceptance; this is downstream symptom, not the owner of provider validity. | observed |
| `packages/opencode/src/permission/reviewer/service.ts` lines 570-616 and 755-900 | Confirms the reviewer independently consumes finish-step, its only decision Tool is explicitly no-side-effect, attempt Tool identities are already tracked, and an existing SessionRetry wrapper can safely retry `other`. | reachable |
| `packages/opencode/src/permission/auto.ts` lines 30-44 and 100-110 | Confirms reviewer `sessionID` is optional and the public auto-review contract reaches the reviewer without a persisted child session. | reachable |
| `packages/opencode/src/permission/reviewer/service.ts` lines 398-408 and 655-665 | Confirms the non-persisted reviewer stream is reachable and currently returns early for every event before finish-step validation. | reachable |
| `packages/opencode/src/session/processor.ts` lines 701-739 | Confirms `SessionEvent.Step.Ended` is currently published before the existing `other` guard. | reachable |
| `packages/opencode/src/session/projectors-next.ts` lines 155-163 | Confirms the event bridge persists `Step.Ended` as `session.next.step.ended`, making pre-guard publication success-equivalent. | reachable |
| `packages/core/src/event.ts` lines 72-151 and `packages/core/src/session-event.ts` lines 130-145 | Provides the public event subscription seam and distinct Step Ended/Failed contracts used for behavioral verification. | contracted |
| `packages/core/src/session-message-updater.ts` lines 166-184 and 378-379 | Shows EventV2 creates a completed assistant on the next Step Started and currently ignores Retried, leaving failed content in memory/projection. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx` lines 119-145 and 258-259 | Shows the live TUI mirror also ignores Retried and keeps the active assistant content until the next step. | reachable |
| `packages/opencode/test/v2/session-message-updater.test.ts` | Existing public in-memory EventV2 updater seam for a focused Retried cleanup regression test. | observed |
| `packages/opencode/test/session/prompt.test.ts` lines 873-1278 | Existing reviewer integration tests exercise persisted reviewer output, protocol retries, Provider retries, and the public Permission seam. | observed |
| `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx` lines 87-139 | Existing production-route TUI harness provides a live EventSource, `SyncProviderV2`, and public rendered-frame seam for retry projection behavior. | observed |
| Installed `node_modules/@ai-sdk/openai/src/responses/openai-responses-language-model.ts` lines 1063-1066, 1997-2021, 2095-2109 | Confirms `other` is the adapter default when no recognized terminal reason replaces it, and flush emits finish on clean EOF. This installed artifact is evidence only, not a modification target. | observed |
| Installed `node_modules/@ai-sdk/provider-utils/src/parse-json-event-stream.ts` lines 8-32 | Confirms clean SSE EOF is accepted without a terminal-event assertion. | observed |
| Baseline command `bun test test/session/processor-effect.test.ts -t "session.processor partial output with finish_reason=other does not throw"` from `packages/opencode` | Current implementation passes the test that encodes the defect: partial `other` is accepted rather than retried. | observed |
| Feedback command `sqlite3 -readonly ...` detecting reasoning-only `finish="other"` | Red-capable production symptom signal; current database output is `RED: finish=other reasoning-only/no-text/no-tool count=27`. | observed |

## 5. Current Behavior

```text
OpenAI-compatible/Grok SSE in a normal Agent Session
  -> AI SDK semantic finish event with finishReason="other"
  -> SessionProcessor finish-step
  -> publish Step.Ended before validation when event system is enabled
  -> reject only if no text/reasoning/tool flags are set
  -> accept no-tool partial output and persist assistant.finish="other"
  -> cleanup marks message completed
  -> SessionRetry never sees an error
  -> prompt loop may exit as normal completion

Adjacent paths are deliberately not generalized in this revision:

Tool-bearing normal Session -> existing tool lifecycle/loop contract; report only
Permission reviewer         -> separate direct stream; report only
EventV2/TUI retry projection -> existing retry projection; report only
```

The current guard at `processor.ts:729-739` was introduced for completely empty
provider completions. It treats any reasoning or text start as proof of a valid
completion. The observed Grok traces prove that this is insufficient: a clean
SSE EOF can occur after only a prefix of reasoning/text, while the SDK still
emits `finishReason="other"`.

`SessionRetry.retry` already wraps the normal Session stream at
`processor.ts:1031-1075`. `MessageV2.APIError` already carries `isRetryable`,
and `fromError` preserves that classification. The missing behavior is only the
normal Session conversion at the first proven divergence. Retry scheduling,
Tool lifecycle, reviewer behavior, and projection cleanup are outside this
revision and remain unchanged.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `finishReason="other"` with reasoning-only output | AI SDK/OpenAI-compatible stream after Grok SSE clean EOF or unknown terminal reason | Stream events are already decoded into `StreamEvent`; no terminal semantic guarantee exists for `other` | `LLM.stream` -> `SessionProcessor.handleEvent("finish-step")` | `SessionProcessor` semantic completion boundary | observed |
| `finishReason="other"` with partial text and no Tool | AI SDK/OpenAI-compatible stream | Text deltas are valid, but `other` is not a recognized successful finish | Same as above | `SessionProcessor` | observed |
| `finishReason="other"` with Tool parts | AI SDK/OpenAI-compatible stream | Tool events may already have executed side effects; no safe retry classification is proven by the incident evidence | Same finish boundary, then existing tool loop | Existing `SessionProcessor` tool lifecycle | reachable, explicit non-goal |
| Tool-bearing `finish="other"` after the provider emits Tool Parts | Session prompt loop | `prompt.ts:2572-2577` excludes unexecuted Tool Parts from normal completion and continues the loop; later retry policy is not changed here | `SessionProcessor` -> `SessionPrompt` loop | Existing Tool lifecycle/loop | reachable, reported-only |
| `finishReason="other"` in permission reviewer | Permission reviewer's direct `streamText().fullStream` consumer | Separate consumer with its own protocol/retry boundary | `runReviewerStream` -> reviewer finish-step | Permission reviewer | reachable, reported-only |
| `finishReason="other"` while `experimentalEventSystem=true` | Normal Session processor | Event bridge can observe Step Ended ordering | `SessionProcessor` -> `EventV2Bridge.publish` -> `SyncEvent` -> `projectors-next` | SessionProcessor ordering at semantic completion boundary | reachable, reported-only |
| `finishReason="stop"`, `length`, `content-filter`, or `tool-calls` | AI SDK semantic finish mapping | Existing recognized finish contract | Same finish boundary | Existing processor/prompt semantics | contracted |
| Clean SSE EOF with a valid recognized terminal event | Provider adapter and transport | Clean EOF is transport-normal after semantic completion | Provider adapter -> processor | Adapter/transport; not this repair | reachable |

The plan does not infer a specific Grok upstream raw frame beyond the observed
semantic `other` event. The database and structured logs prove the reachable
processor input and the incorrect persisted outcome; raw provider-frame
classification is outside the repository's current evidence.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | In a normal Agent Session, no-Tool `finishReason="other"` is never persisted as a successful completed Provider step. | User incident; 27 reasoning-only and 11 text/no-tool observed rows. | No test; current partial-output test protects the defect. |
| INV-02 | A normal Session no-Tool `other` finish reaches the existing retry orchestration as a typed `MessageV2.APIError` with `isRetryable=true`. | `MessageV2.APIError` schema and `SessionRetry.retryable` contract. | Empty `other` test proves only the no-output subset. |
| INV-03 | A retryable no-Tool `other` completion recovers through the next Provider response without leaving failed-attempt Parts in the final assistant Message. | Existing retry boundary plus durable Part writes make stale-prefix cleanup reachable. | Existing tests do not assert failed-prefix absence. |
| INV-04 | Partial reasoning and partial text are both treated as incomplete no-Tool Provider output; either one must not suppress retry classification. | Database has 27 reasoning-only and 11 text/no-tool observed records. | Existing partial text test has the opposite expectation; no reasoning-only test. |
| INV-06 | Recognized finish reasons and the existing retry delay/classification remain unchanged. | Existing processor and retry tests. | `processor-effect.test.ts` and `retry.test.ts`. |
| INV-05 | The no-Tool `other` rejection occurs before the normal Session publishes or persists a successful Provider step. | `Step.Ended` and legacy finish persistence currently precede/attach to the existing guard. | Add a processor behavior assertion for the failed attempt and recovered recognized finish. |
| INV-07 | Goal continuation, transport timeout, retry scheduling, Tool lifecycle, reviewer behavior, and projection consumers remain outside this repair. | Explicit user scope amendment and current module ownership. | Existing adjacent tests remain unchanged; report-only evidence is recorded below. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02, INV-04 | At `finish-step`, the guard requires `other` plus no semantic output flags. A reasoning/text prefix makes the condition false, so control proceeds to `assistantMessage.finish = value.finishReason`. | `SessionProcessor`'s `finish-step` semantic completion handler. | `processor.ts:721-755`; existing partial test passes; database has exact partial `other` records. |
| INV-03 | Once a no-Tool attempt is retried, its already durable text/reasoning/step Parts remain unless the retry boundary removes them. | `SessionProcessor` attempt state and `Session.removePart` seam. | `processor.ts:792-905`; `session.ts:887-898`; no existing cleanup on semantic retry. |
| INV-05 | `Step.Ended` is currently published before the guard, so source ordering must be corrected with the same processor guard. | SessionProcessor event ordering. | `processor.ts:701-739`; downstream EventV2 publication is report-only in this revision. |

Red-capable feedback loop:

```text
sqlite3 -readonly -batch "/Users/sunbenteng/.local/share/opencode/opencode.db" \
  "PRAGMA query_only=ON; ... finish='other' ... reasoning ... no text/tool ..."
```

Observed output:

```text
RED: finish=other reasoning-only/no-text/no-tool count=27
```

The deterministic package baseline also passes the current wrong behavior:

```text
bun test test/session/processor-effect.test.ts -t "session.processor partial output with finish_reason=other does not throw"
1 pass, 0 fail
```

The implementation test slice will invert this behavior and make the current
code fail because it expects a second Provider request and recovered output.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Classify proven normal Session no-Tool completion | `SessionProcessor` | Converts `LLM.StreamEvent` into persisted assistant Message state or an error. | It is the first module after SDK normalization that knows finish reason, output flags, and whether a Tool was emitted. | The installed SDK is external; transport only knows raw progress; Goal and reviewer are separate contracts; `SessionRetry` should consume typed errors. |
| Remove failed no-Tool attempt Parts before retry | `SessionProcessor` plus existing `Session.removePart` | Owns the durable Parts emitted by the attempt and can retract them before throwing. | This is the existing persistence/event seam immediately adjacent to the retry boundary. | `SessionRetry` schedules attempts but does not know Message Part ownership; adding cleanup there would leak Session persistence policy. |
| Retry scheduling and user-visible retry status | `SessionRetry` | Retries `MessageV2.APIError` when `isRetryable=true`. | Already implemented and exercised. | A new processor-local retry would duplicate orchestration and violate one-path policy. |
| Error classification preservation | `MessageV2.fromError` | Preserves an existing `APIError` and its retryability. | Existing contract already supports this error. | No schema or persistence change is needed. |
| Partial-output test seam | `SessionProcessor.process` through `provideTmpdirServer` | Observes retry count, recovered output, and final error state through public service behavior. | This seam reaches real SDK parsing, processor handling, cleanup, and retry. | A private helper or database-only assertion would not prove external retry capture. |

## 10. Single Approved Primary-Path Design

```text
Normal Session AI SDK finish-step
  -> if finishReason="other" and no Tool was emitted:
     remove this attempt's text/reasoning/step Parts
     throw existing APIError({ isRetryable: true, metadata: { finishReason: "other" } })
  -> existing SessionRetry captures the typed retryable error and retries
  -> a later recognized response publishes/persists normally
  -> if a Tool was emitted or reason is recognized: preserve existing path
```

The production change stays in the existing `SessionProcessor` and repairs the
normal Agent primary path at its first semantic divergence. In the proven
no-Tool domain, `finishReason="other"` is an incomplete/unknown Provider
completion regardless of whether a reasoning or text prefix was emitted.

The guard must be the first semantic action in the `finish-step` case, before
usage mutation, `SessionEvent.Step.Ended`, `assistantMessage.finish`, or the
legacy `step-finish` Part is published/persisted. Before throwing, it removes
only the current attempt's text/reasoning/step Parts through the existing
`Session.removePart` event path. Tool-bearing attempts remain on the existing Tool lifecycle because `prompt.ts`
already keeps assistants with unexecuted Tool Parts out of normal completion;
Tool replay/retry policy is a separately reported follow-up. Goal behavior and
all adjacent consumers remain unchanged.

The existing `MessageV2.APIError` constructor and `SessionRetry.retry` are
reused unchanged. No catch-and-success path, second parser, provider-specific
branch, configuration switch, or Goal workaround is introduced.

The existing empty-output condition is therefore generalized, not replaced by
a competing implementation. The error message should describe an incomplete
Provider completion rather than claim that no content existed. The existing
Chinese explanation should be updated to state that a no-Tool `other` finish
lacks a recognized successful terminal reason and must enter the existing retry
classification.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| SessionProcessor rejects no-Tool `finishReason="other"` before success publication | Proposed | primary-contract branch | no | approximately 45% | implement |
| SessionProcessor removes failed attempt text/reasoning/step Parts before retry | Proposed | primary-contract cleanup branch | no | approximately 30% | implement |
| Existing `SessionRetry.retry` | Current | existing compatibility/orchestration | yes after a later recognized response | 0% new surface | preserve and reuse |
| Existing `MessageV2.fromError` APIError pass-through | Current | existing compatibility | no; preserves error classification | 0% new surface | preserve |
| Goal continuation logic | Current | downstream existing path | no new success semantics | 0% | preserve unchanged |
| New provider fallback, alternate parser, or catch-and-success | Rejected | forbidden fallback | yes | prohibited | reject |

No new alternate success path is proposed. The existing retry path is not a
fallback implementation; it is the contracted consumer of retryable errors.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `!ctx.hasText && !ctx.hasReasoning && !ctx.hasToolCall` restriction | Attempted to catch only empty `other` completions. | The observed defect includes partial no-Tool `other`; text/reasoning presence cannot prove semantic completion, while Tool presence remains the evidence boundary. | Collapse text/reasoning checks but preserve `!ctx.hasToolCall` in `packages/opencode/src/session/processor.ts:729-739`. |
| “empty completion” wording in the guard comment/error | Describes only the earlier subset and becomes false for partial output. | The same primary guard will cover incomplete partial responses. | Update the nearby comment and error message in `processor.ts`; no separate helper. |
| Pre-guard `SessionEvent.Step.Ended` publication | Existing order assumed finish-step was already valid. | Normal Session validation must precede all success-equivalent publications. | Move no event code; place classification at the top of the `finish-step` case before lines 708-720. |
| Failed attempt Parts surviving retry | Existing retry path resets in-memory flags but does not retract durable Parts. | The proven no-Tool repair must make the failed attempt non-success-equivalent before retry. | Track current attempt Part IDs and remove them at the same guard; do not touch Tool Parts. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01: no no-Tool `other` success persistence | Guard before `assistantMessage.finish` and step-finish | `processor.ts` | Partial text/reasoning tests observe retry instead of completed first attempt. |
| INV-02: external retry capture | Existing normal Session `SessionRetry.retry` | No `retry.ts` change; existing APIError path | Recovery tests assert two Provider calls and no final error. |
| INV-03: failed Parts excluded | Existing `Session.removePart` event/persistence seam | `processor.ts` attempt Part tracking and cleanup | Final Message contains recovered output but not failed prefix/step Parts. |
| INV-04: reasoning/text both covered | Same `finish-step` predicate | `processor.ts` and focused test fixtures | One reasoning-only `other` recovery test and one partial-text recovery test. |
| INV-05: failed `other` is not successful before publication | Guard precedes `Step.Ended`, `assistantMessage.finish`, and step-finish persistence | `processor.ts` | Processor recovery test observes only the recognized recovery result. |
| INV-06: recognized finishes unchanged | Predicate only matches no-Tool `other` | No changes to recognized branches | Existing `empty stop` and prompt tool-loop tests remain green. |
| INV-07: adjacent boundaries remain unchanged | Existing retry, Tool loop, reviewer, Goal, transport, and projection owners | No adjacent production files modified; report-only notes | Existing package regression suites remain green. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Generalize the existing Session guard only to no-Tool `other` | INV-01, INV-02, INV-04 | 38 observed no-Tool `other` completions; current output flags suppress retry. | Current guard is the first divergence and already owns this normal Session event. |
| Track/remove current attempt Parts | INV-03 | Durable Part writes occur before finish-step; existing `Session.removePart` owns deletion events. | SessionRetry has no Session Part context; leaving Parts creates a success-equivalent mixed attempt. |
| Keep adjacent Tool/reviewer/projection paths unchanged | INV-07 | User scope amendment explicitly assigns these boundaries to report-only follow-up. | Expanding them would move retry-policy or consumer ownership into this first-divergence repair. |
| Move no-Tool guard before Step Ended publication | INV-05 | Processor currently publishes Step Ended before its semantic guard. | A failed semantic completion must not be published as a successful step. |
| Reuse `MessageV2.APIError({ isRetryable: true })` | INV-02, INV-03 | Existing empty-completion recovery and APIError pass-through tests | A plain Error would be converted to `UnknownError` and would not satisfy retry policy. |
| Preserve `SessionRetry.retry` unchanged | INV-02, INV-07 | Existing retry policy and schedule tests | Adding another retry layer would duplicate ownership and create competing timing semantics. |
| Add reasoning-only and partial-text recovery fixtures | INV-03, INV-04 | Both shapes observed in the SQLite database | Existing empty-only test cannot fail on the partial-output defect. |
| Update the explanatory comment/error wording | INV-01, INV-04 | Existing wording says “no content/reasoning/tool” while new predicate covers content | Without the update, the diagnostic would misdescribe the actual failure. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/opencode/src/session/processor.ts` | modify | Reject no-Tool `finishReason="other"` before Step Ended and legacy success persistence; remove current-attempt text/reasoning/step Parts through existing Session removal events; update explanation. | 22-42 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | Replace accepted partial `other` with text/reasoning recovery tests, assert failed-prefix/Part removal and processor event ordering, while preserving existing Tool-loop tests. | 75-105 |
| Other production, test, config, migration, generated, or dependency files | no change | Not owners of the first divergence or required behavior. | 0 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Feed partial text no-Tool `other` followed by valid `stop`; expect two Provider calls, recovered text only, no failed prefix/step Parts, and no final error. | Current `hasText=true` bypasses the guard; a simple retry without cleanup would mix failed and recovered Parts. | Preserve the existing retryable APIError, broaden only to no-Tool partial output, and remove current-attempt Parts before throwing. | User-visible “model spoke but never called the next operation” case without mixed output. |
| 2 | Feed reasoning-only no-Tool `other` followed by valid `stop`; expect retry, recovered output only, and no failed reasoning Part. | Current `hasReasoning=true` bypasses the guard; this is the 27-row database shape. | The same no-Tool predicate and current-attempt Part cleanup apply. | User-visible partial thinking case. |
| 3 | Keep the existing empty `other` recovery test and recognized empty `stop` test green. | These establish that the existing APIError path and recognized finish behavior remain valid. | No additional production branch. | Prevents accidental weakening of retry classification or changing `stop`. |
| 4 | Observe the processor event sequence while slice 1 retries; expect the failed `other` attempt to publish no successful Ended step and the recovery to publish recognized `stop`. | Current code publishes `other` Ended before its guard. | Place the no-Tool guard before Step Ended publication in the same processor case. | Prevents the first divergence from being exposed as success without modifying EventV2 consumers. |
| 5 | Keep existing Tool-loop, reviewer, retry-policy, and projection tests green without adding new behavior to those owners. | This repair must not silently change adjacent contracts. | Modify only the normal Session processor predicate and its existing test seam. | Makes the user-requested scope boundary executable through regression coverage. |
| 6 | Run the original SQLite detector after implementation against the existing database. | Historical records remain unchanged, so the detector is a feedback signal rather than a live post-fix pass condition. | Use the detector to document the original symptom count; use focused behavioral tests as the implementation pass/fail signal. | Prevents confusing historical evidence with a runtime regression result. |

Behavioral tests use `provideTmpdirServer`, the public `SessionProcessor`
`process` handle, and the existing EventV2 sync subscription only to observe
processor ordering. Existing Tool-loop, reviewer, retry-policy, and projection
tests remain regression coverage; they are not expanded by this repair. Expected
recovery text is independent of the production predicate and no generic
classifier is added.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | approximately 105 | One finish consumer and one existing behavior test with focused recovery fixtures; exclude imports, formatting, and unchanged fixture code. |
| Required Chinese explanatory comments `C` | at least 16 | `ceil(105 * 0.15)=16`; comments explain the no-Tool evidence boundary, retry contract reuse, current-attempt cleanup, ordering, and test intent. |

Qualifying comments must explain the semantic invariant and test intent. They
must not restate assignments, identifiers, or obvious control flow.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/processor-effect.test.ts -t "partial output with finish_reason=other"` | `packages/opencode` | Red before implementation, green after implementation for the partial-text retry path. |
| `bun test test/session/processor-effect.test.ts -t "reasoning-only"` | `packages/opencode` | Green after implementation for the reasoning-only retry path. |
| `bun test test/session/processor-effect.test.ts -t "finish_reason=other.*Step Ended|partial output with finish_reason=other"` | `packages/opencode` | Failed `other` attempt emits no Step Ended; recovery emits exactly one recognized Ended. |
| `bun test test/session/processor-effect.test.ts -t "empty completion with finish_reason=other throws retryable error then recovers"` | `packages/opencode` | Existing empty-`other` behavior remains green. |
| `bun test test/session/processor-effect.test.ts test/session/retry.test.ts` | `packages/opencode` | Processor and retry integration/classification coverage. |
| `bun test test/session/prompt.test.ts -t "loop continues when finish is tool-calls|loop continues when finish is stop but assistant has tool parts"` | `packages/opencode` | Existing downstream tool-loop behavior remains unchanged. |
| `bun typecheck` | `packages/opencode` | Package-local type correctness. |
| `sqlite3 -readonly ...` real Grok detector | repository root or any shell directory | Reconfirms the original live-database symptom and its historical count; it is not expected to mutate old rows. |
| `git diff --check` | repository root | No whitespace errors in the implementation diff. |

The full package test command and build/lint expansion will be selected during
approved implementation according to the actual changed files and package
scripts; no failing verification may be hidden or weakened.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 in implementation | This plan file is the canonical artifact; implementation adds no production helper or dependency. |
| Files modified | 2 | The normal Session processor and its existing behavior test only; no implementation file is added. |
| Files deleted | 0 | No obsolete module exists; only the guard condition is collapsed. |
| Production lines | 20-35 | One existing `finish-step` predicate/order correction and current-attempt cleanup; no retry or helper module. |
| Test lines | 65-90 | Partial text, reasoning-only, empty completion, and processor ordering slices in the existing test file. |
| Generated lines | 0 | No generated artifact or migration. |

The total implementation change is budgeted at or below 125 lines, with
production below 50 lines, and adds no implementation file.

## 20. Real Risks and Open Decisions

### Real Risks

- Tool-bearing `other` attempts stay on the existing Tool lifecycle. `prompt.ts:2572-2577` shows assistants with unexecuted Tool Parts are excluded from normal completion and the loop proceeds; later Tool/retry policy is a follow-up, not this change.
- Permission reviewer, EventV2, and TUI have independently reachable `other` boundaries. They are report-only in this revision and must not expand the two-file repair.
- Event validation must precede `Step.Ended` inside the normal Session processor. Downstream EventV2/TUI cleanup remains outside this revision.
- Historical database rows cannot be repaired by this change. The SQLite detector remains evidence of the original failure, while new runtime behavior is proven through the processor seam.

### Open Decisions Requiring the User

The Tool-bearing path is intentionally not changed in this revision. Its existing prompt-loop continuation is evidenced and reported; any future retry/replay policy is a separate decision.

### Rejected Speculation

- Changing Goal continuation is rejected because no-Goal Sessions show the same `other` completion and the first divergence is earlier in `SessionProcessor`.
- Increasing SSE timeout is rejected because the representative request had `maxGapMs=53327` against an effective `chunkTimeoutMs=300000` and ended with `sse.end`, not timeout.
- Modifying `@ai-sdk/openai` or adding a Grok-specific provider adapter is rejected because the repository already receives the normalized finish event and owns the retryable Session error boundary.
- Adding a database migration or rewriting old completed rows is rejected because the defect is runtime classification and persisted history is diagnostic evidence.
- Retrying Tool-bearing `other` is rejected because executable Tool side effects can precede finish-step and no replay-safe contract is proven.
- Modifying `SessionRetry`, reviewer, EventV2, or TUI is rejected for this revision because the user explicitly assigned those boundaries to a later or report-only follow-up.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct the complete producer-to-consumer path for `finish="other"`, including reasoning/text/tool variants, APIError conversion, SessionRetry, cleanup, and downstream loop behavior.
- Treat builder summaries, database summaries, and transcript as untrusted; verify repository and trace evidence independently.
- Audit the complete original scope on every round.
- This task-specific user amendment raises the plan-audit limit from six to twelve rounds; continue full-scope rounds through twelve before returning unresolved blockers.
- Require evidence for every blocking finding.
- Check the evidence-bounded normal Session no-Tool predicate, current-attempt Part cleanup, pre-publication ordering, existing retry capture without retry-policy changes, explicit report-only Tool/reviewer/EventV2/TUI boundaries, no-fallback design, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Confirm that the plan does not modify Goal, timeout, dependency, migration, or unrelated provider paths without evidence.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 The plan leaves the permission-reviewer success path unclassified; B-02 The proposed guard runs after a success-equivalent `Step.Ended` event is published | Audit-mode terminology; implementation-time verification expansion; comment-quality reminder | BLOCK | `ses_07a96c4feffeay5Aj56oae8bmX` |
| 2 | R2 | yes | B-01 Normal Session retries preserve failed output and can repeat Tool side effects; B-02 Reviewer classification occurs after a completed decision has been persisted | N-01 Audit-mode metadata uses phase-ambiguous terminology | BLOCK | `ses_07a90182cffeZJE2nTOqgRG7Rz` |
| 3 | R3 | yes | B-01 Permission reviewer still treats `finishReason="other"` as a success result | None | BLOCK | `ses_07a7641c5ffeCdYmgBPJ8pArPR` |
| 4 | R4 | yes | B-01 EventV2/core and TUI retry consumers retain failed-attempt assistant content because `session.next.retried` is a no-op | None | BLOCK | `invocation reference not retained in current handoff` |
| 5 | R5 | yes | B-01 Non-persisted permission-reviewer path lacks behaviorally sensitive verification; B-02 independent TUI retry projection lacks behaviorally sensitive verification | N-01 historical SQLite detector command uses abbreviated SQL | BLOCK | `ses_07a253935ffe1uvGF7WuabPm6F` |
| 6 | R6 | yes | B-01 Shared Retried cleanup is unscoped; B-02 Tool-bearing `other` is excluded from the verbatim requirement; B-03 `packages/core` typecheck is missing | N-01 historical SQLite detector command uses abbreviated SQL; N-02 reviewer JSON-text path not inventoried | BLOCK | `ses_07a1b8fb2ffexCk142NfjxZiSG` |
| 7 | R8 | yes | None; the prior R7 result was caused by missing continuation scope context in the audit handoff | None | APPROVE (user-confirmed audit-context correction) | current user instruction |

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

Implemented against approved revision R8.

### Actual Files and Diff

| File | Actual change | Diff stat |
| --- | --- | ---: |
| `packages/opencode/src/session/processor.ts` | Tracks current-attempt non-Tool Parts, removes them on no-Tool `other`, and throws the existing retryable APIError before Step Ended. | `+30/-21` |
| `packages/opencode/test/session/processor-effect.test.ts` | Converts the partial-output expectation to recovery, adds reasoning-only recovery, and verifies only recovered Step Ended is published through a typed event guard. | `+81/-9` |

No retry scheduler, Tool lifecycle, reviewer, EventV2/TUI consumer, dependency,
configuration, migration, generated file, or new implementation file changed.

### Red-Green Test Evidence

| Slice | Red evidence | Green evidence |
| --- | --- | --- |
| Partial text `other` | New recovery test failed with `Expected: 2`, `Received: 1` Provider calls. | Focused test passed with recovered text and no failed prefix. |
| Reasoning-only `other` | Under the previous text/reasoning guard, test failed with `Expected: 2`, `Received: 1`. | Focused test passed with recovered text and no failed reasoning Part. |
| Empty `other` and recognized empty `stop` | Existing tests were retained as independent regression contracts. | Both focused regressions passed. |
| Step Ended ordering | The old source published Ended before the guard. | Partial recovery test observed exactly `[`stop`]`, with no `other` Ended event. |

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "session.processor partial output with finish_reason=other retries and recovers\|session.processor reasoning-only finish_reason=other retries and recovers\|session.processor empty completion with finish_reason=other throws retryable error then recovers"` | `packages/opencode` | PASS: `3 pass`, `15 expect()` calls. |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "session.processor empty stop"` | `packages/opencode` | PASS: `1 pass`, `3 expect()` calls. |
| `bun test --timeout 30000 test/session/retry.test.ts` | `packages/opencode` | PASS: `45 pass`, `96 expect()` calls. |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "loop continues when finish is tool-calls\|loop continues when finish is stop but assistant has tool parts"` | `packages/opencode` | PASS: `2 pass`, `8 expect()` calls. |
| `bun test --timeout 30000 test/session/processor-effect.test.ts test/session/retry.test.ts` | `packages/opencode` | PARTIAL: `66 pass`, `1 fail`; unrelated existing `session.processor retries a real first-progress timeout` waited for retry status and timed out. The failing path does not reach `finish-step`. |
| `bun typecheck` | `packages/opencode` | PARTIAL after audit rework: the changed test type error is fixed; diagnostics remain only in concurrent unrelated `src/patch/match.ts` lines 215-272 and `src/tool/goal.ts:52`. |
| `git diff --check -- packages/opencode/src/session/processor.ts packages/opencode/test/session/processor-effect.test.ts docs/plans/grok-finish-other-retryable-repair.md` | repository root | PASS. |

### Original Feedback-Loop Result

- The original read-only database evidence remains historical: `42` Grok
  assistant Messages have `finish="other"`; the established reasoning-only
  detector reported `RED: finish=other reasoning-only/no-text/no-tool count=27`.
- Historical rows are intentionally unchanged. The deterministic processor
  recovery tests are the post-fix runtime signal.

### Actual Secondary and Replacement Path Inventory

| Path | Actual verdict |
| --- | --- |
| Normal Session no-Tool `other` | Converted to existing retryable APIError before success publication. |
| Existing `SessionRetry.retry` | Preserved unchanged and captures the new semantic error. |
| Tool-bearing normal Session | Preserved unchanged; focused Tool-loop regressions pass. |
| Reviewer, Goal, transport, EventV2/TUI consumers | Preserved unchanged as user-authorized report-only boundaries. |
| Fallbacks / alternate success paths | None added. |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 85 | Independent implementation audit count: 21 processor code lines plus 64 test code lines, excluding imports, comments, blanks, and documentation. |
| Qualifying Chinese comment lines `C` | 17 | Nearby explanations cover Part ownership, Tool replay boundary, retry ownership, cleanup order, event ordering, and independent test intent. |
| Ratio `C / E` | 20.00% | `17 / 85`. |
| Required minimum `C` | 13 | `ceil(85 * 0.15)=13`; actual `17`. |

### Remaining Unverified Items

- The full processor suite retains one unrelated first-progress timeout failure;
  focused changed-path tests and all retry tests pass.
- Package typecheck is blocked by concurrent unrelated changes in
  `packages/opencode/src/patch/match.ts` and `packages/opencode/src/tool/goal.ts`;
  no changed GOAL file appears in the reported diagnostics.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R8 | yes | B-01 changed test accessed unknown EventV2 data without Schema narrowing | Approved design metadata field was omitted; unrelated `src/patch/match.ts` type errors remain | BLOCK | `ses_079eb729effeeVtIyFQ5KuvQNr` |
| 2 | R8 | yes | No blocking findings | N-01 full processor suite has one isolated first-progress-timeout failure; N-02 package typecheck is blocked by unrelated dirty-worktree errors; N-03 EventV2/TUI retry projection remains a reachable adjacent boundary; N-04 Tool-bearing `finish="other"` remains unchanged | APPROVE | `ses_079e5b2fbffeih2q48BWjAbMe3` |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
