# Canonical Implementation Plan: Stabilize SessionProcessor first-progress timeout behavior test

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户要求完整调查 GitHub Actions macOS 上 `session.processor retries a real first-progress timeout` 的新失败，创建全新文档并完成 verified implementation；production 与 test 各不超过 4 个文件，总修改量不超过 600 行（报告不计），优先修改既有文件。
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-19

This file is the sole implementation specification for this task. The verified
watcher plan, the historical Provider timeout plan, chat summaries, and prior
audits are evidence only and do not authorize this implementation.

## 1. Verbatim Requirement

> 看到当前又出现了这个问题,也就是你新提交的那个commit我给push上去之后,CI运行之后出现了新的错误。请检查检查这个新的错误是哪来的。先不要写内容。如果你需要解决的话,请你构建一个新的文档,完全新的文档,然后进行verified implementation,right?你要进行verified implementation,就是需要重新进入工作流,也就是创建新的文档,详细调研。

> 这个是在MacOS上仍然出现的一个CI错误,也就是在GitHub的Action里面出现的MacOS的新的错误。

> 保持甜点级别的修复修正，尽量保持在整体生产代码修改不超过4个文件，测试不超过4个文件，且尽量修改已有而不是创建新的，同时修改量在600行以内，不计算报告在内。

The retained session requirement also applies:

> 完整准确识别mac上的CI测试报错原因以及相关行为逻辑,需要进行测试不降级的高质量,充分反映测试目的的修正。检查正常代码逻辑是否有问题,以及测试内容是否有问题,包括时序、静态问题等逻辑。同时让测试相对稳定,不要依赖于,不要完全依赖于时间超时等等内容,应该依赖于行为的正确性与准确性。

## 2. Explicit Non-Goals

- Do not modify `Provider.progressDeadline`, `LLM.Service`, `MessageV2`,
  `SessionProcessor`, `SessionRetry`, `SessionStatus`, or `Bus`. The failed
  macOS attempt observed the expected timeout message, retry Status, and final
  `continue` result; the production chain completed its contract.
- Do not change the public/default `chunkTimeout=180000` or
  `timeout=600000`, add a new timeout setting, or change retry classification,
  backoff, attempt policy, Provider selection, or Session behavior.
- Do not introduce a retry cap. The current production contract intentionally
  permits another retry whenever any attempt exceeds its configured no-progress
  window.
- Do not make CI green with a skip, platform guard, retry wrapper, flaky-test
  allowlist, larger package timeout, catch-and-success, or weakened Status/error
  assertions.
- Do not preserve an exact Provider-request count as a behavioral contract.
  Request count is an orchestration detail and directly contradicts the
  existing unbounded retry policy for retryable errors.
- Do not create a second fixture implementation or change the queue-miss
  default. Extend the existing TestLLMServer queue with one explicit repeatable
  response producer so retries never depend on implicit default success.
- Do not modify more than four production files or four test files, and do not
  exceed 600 changed implementation lines excluding this plan. The approved
  route targets zero production files and two existing test-scope files.
- Do not modify, stage, revert, or commit unrelated existing worktree changes.
- Do not reuse `docs/plans/provider-timeout-transport-integrity.md` as the
  canonical artifact. It records the historical feature implementation; this
  file owns the newly observed CI-test stability repair.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Requires package-local tests/typecheck, minimal primary-path changes, parallel inspection, and preservation of unrelated worktree changes. |
| `packages/opencode/AGENTS.md` | Defines Effect/module conventions and makes orchestration the owner of retry/timeout policy. No production policy change is justified here. |
| `packages/opencode/test/AGENTS.md` | Requires published readiness signals instead of scheduler sleeps; permits real time only when time/network latency is the behavior under test. |
| `CONTEXT.md` | Defines Provider, Session, Message, Status, Run state, and current v1 `session/` ownership. |
| `docs/adr/README.md` | No load-bearing architectural decision is introduced; this is a one-test behavioral correction, so no ADR is required. |
| `.opencode/policy/first-principles-engineering.md` | Requires the first-divergence owner, zero new fallback paths, forward/reverse traceability, independent audit, and the Chinese-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this plan's required sections and state transitions. |

The only accepted ADR concerns triage labels and is unrelated to Session or
Provider timeout behavior.

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| GitHub Actions run `29681810694`, attempt 1, macOS job `88179163226` | Original symptom: test passed retry message/result assertions, then failed at `llm.calls === 2` with actual `3`; 3822 pass, 16 skip, 1 fail. | observed |
| Same run attempt 1, Linux and Windows jobs | Both `packages/opencode` jobs passed; narrows the observed incident to loaded macOS execution without defining a platform-specific product branch. | observed |
| Same run attempt 2, macOS job `88181942932` | Same test passed in 2512.25ms and full report was 3823 pass, 16 skip, 0 fail; proves non-determinism rather than a permanent product failure. | observed |
| `packages/opencode/test/session/processor-effect.test.ts:752-820` | Owns the failing 25ms configuration, 100ms `Promise.race`, retry Status observation, exact call-count assertion, and delayed HTTP fixture sequence. | observed |
| `packages/opencode/test/lib/llm-server.ts:608-779` | Real local HTTP fixture; `hits` increments per received request, queued items are removed when a request arrives, `wait(n)` is a published request-readiness signal, and an empty queue supplies an automatic success response. | observed |
| `packages/opencode/test/fixture/fixture.ts:225-273` | `provideTmpdirServer` scopes the real server and Project fixture; test finalizers can own gate/subscription cleanup. | observed |
| `packages/opencode/test/lib/effect.ts:27-36,113-123` | `testEffect.run` scopes the Effect but does not bridge Bun's external timeout into interruption; `awaitWithTimeout` supplies an in-scope failure-only boundary that closes the scope. | observed |
| `packages/opencode/src/provider/provider.ts:127-275,1920-2012` | One progress deadline is armed for every Provider attempt before dispatch; the configured value applies independently to the first and all later attempts. | observed |
| `packages/opencode/src/session/llm.ts:357-457` | AI SDK retries are disabled (`maxRetries=0`); the full stream forwards Provider errors to SessionProcessor. | observed |
| `packages/opencode/src/session/message-v2.ts:1604-1725,1806-1847` | Maps `SSE read timed out`/`SSE_READ_TIMEOUT` to retryable APIError while preserving user-abort precedence. | observed |
| `packages/opencode/src/session/processor.ts:1020-1109` | Runs the LLM stream through the existing `SessionRetry.retry` schedule and publishes retry Status before the next attempt. | observed |
| `packages/opencode/src/session/retry.ts:25-69,179-210` | Retryable attempts have backoff but no fixed attempt cap; any later 25ms no-progress attempt may correctly issue another request. | contracted/observed |
| `packages/opencode/src/session/status.ts:51-88` | `set(retry)` publishes the user-visible Status before storing it. | observed |
| `packages/opencode/src/bus/index.ts:98-180` | Callback subscribers consume PubSub messages on a forked stream and Promise microtask; callback delivery is behaviorally ordered but not bounded to 100ms. | observed |
| Commit `c54ad516c19` | Introduced the real first-progress Processor test and production timeout feature. The test uses a 25ms deadline on every attempt and an exact two-call assertion. | observed |
| Commit `209091bd26` diff against its parent | Changed watcher and SessionPrompt tests only; it did not modify this test or any Provider/Processor production owner. | observed |
| `docs/plans/provider-timeout-transport-integrity.md` | Historical R5 contract explicitly preserves no retry cap and says the Processor vertical test should observe behavior without a fixed cap; it is evidence, not implementation authority. | contracted historical evidence |
| Local focused test without load | 1 pass, 0 fail in 4.98s; confirms the defect is load-sensitive. | observed |
| Local 48-worker contention loop without instrumentation | Three consecutive focused runs failed at `observed?.attempt` receiving `undefined`; proves the 100ms observation window can beat the real Status path. | observed |
| Throwaway preload probe outside the repository | Injecting one additional valid second-attempt progress expiry produced the exact CI result: expected calls 2, received 3, while all other assertions passed. | observed |
| Same probe with 500ms test progress window under 48-worker contention | Three consecutive runs passed; validates a separation window while retaining real Provider timeout and retry behavior. | observed |
| Post-change second-attempt-expiry probe | Against the R2 candidate, forced the current 500ms second attempt to expire once; timeout Status and `continue` passed, but final literal `after` was absent and the test failed. | observed |

The throwaway probe is diagnostic only, is not part of the repository or the
approved implementation, and must be removed after verification once deletion
is explicitly authorized.

## 5. Current Behavior

### Production path

```text
SessionProcessor.process
  -> LLM.Service.stream
  -> Provider fetch wrapper
  -> progressDeadline(chunkTimeout) armed for this attempt
  -> real TestLLMServer HTTP request
  -> no raw progress before deadline
  -> SSE_READ_TIMEOUT
  -> MessageV2 retryable APIError
  -> SessionRetry policy
  -> SessionStatus retry event
  -> backoff
  -> next attempt with a fresh progress deadline
  -> eventual response
  -> process returns "continue"
```

Every attempt independently owns the same configured no-progress deadline.
Production does not promise that exactly one retry will be enough.

### Current test path

```text
subscribe to retry Status
  -> fork SessionProcessor.process
  -> immediately race retry.promise against 100ms wall clock
  -> release first HTTP gate regardless of which side won
  -> join eventual process result
  -> assert first retry attempt/message
  -> assert result="continue"
  -> assert total HTTP calls === 2
```

The first queued response is a 503 held behind `gate.promise`; the second is an
SSE response containing `after`. The Provider uses `chunkTimeout: 25`, so both
the intentionally blocked first request and every nominal success attempt have
only 25ms from dispatch to first raw progress.

### Original macOS failure

Attempt 1 reached the expected timeout Status and eventually returned
`continue`. A later attempt also exceeded 25ms under runner load, so production
correctly retried again. The fixture observed three real requests and the test
failed only because it treated `2` as exact behavior. Attempt 2 passed without
source changes.

### Additional reachable flake

The 100ms observation starts after `forkIn`, before the child fiber is
guaranteed to dispatch the first HTTP request or arm/propagate the complete
timeout-to-Bus chain. Under local contention it wins first, returns
`undefined`, and releases the server gate before the intended timeout is
observed. This is a second manifestation of the same wall-clock test contract.

### R2 candidate divergence

R2 replaced exact request count with final literal `after`, but retained one
finite queued success response. TestLLMServer removes that item as soon as the
second request arrives. If that attempt legitimately expires before delivering
raw progress, the third request receives the fixture's standard unqueued `ok`
SSE response and SessionProcessor correctly returns `continue`; the fixed
`after` assertion still fails. A deterministic post-change probe reproduced
this path in 8.94s.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| First request remains silent beyond configured progress deadline | `httpError(..., gate.promise)` fixture | Gate cannot resolve until test releases it | Provider timeout -> retry Status | Existing Provider/Processor path | observed |
| Any retry attempt produces first raw progress within the configured deadline | Explicit repeatable queued `after` response | Real loopback HTTP/SSE; repeat item remains configured for every later request | Provider -> SessionProcessor -> Message text | TestLLMServer queue + existing production path | reachable from approved design |
| Retry attempt exceeds 25ms under loaded macOS scheduler | GitHub Actions attempt 1; deterministic probe | Same deadline applies to each attempt | Another valid retry and third request | SessionRetry | observed |
| Retry Status callback arrives after the test's 100ms race | Local 48-worker stress | Callback uses a forked Bus stream/microtask | Race returns `undefined` before callback | Test synchronization | observed |
| Default production `chunkTimeout=180000` | Normal Provider config | Not used by this test, which explicitly sets 25ms | Production Sessions | Provider config | reachable but out of change scope |
| Arbitrary platform-specific Provider semantics | None | Linux/Windows passed and production path is shared | No proven separate owner | — | speculative |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test status |
| --- | --- | --- | --- |
| INV-01 | A real first-progress timeout must enter MessageV2 as `SSE read timed out`, publish retry Status attempt 1, and not become a terminal failure. | Actions attempt 1 and current production chain | Assertions already passed in failed CI |
| INV-02 | The test must complete positively only after a real request is observed, a real retry Status is delivered, and an explicitly configured repeatable same-Provider response writes `after` to the final Message. | User requires behavior-based synchronization; TestLLMServer queue is the response producer; MessageV2 exposes parts | Original test uses timing/count proxies; R2 binds success to one finite response; R3 uses implicit default success |
| INV-03 | A timeout test may use real time to cause the timeout, but wall clock must not synthesize or decide success. An in-scope Effect timeout may only fail and close resources. | Test AGENTS, user requirement, and `awaitWithTimeout` contract | Current 100ms race can decide `observed` |
| INV-04 | Retryable transport behavior has no fixed attempt count; one explicit success producer must remain available after any supported extra no-progress expiry. | `SessionRetry.policy`, Actions three-request path, post-change probe, and R3 audit B-01 | Original exact count, R2 finite `after`, and R3 queue-miss default all violate part of this contract |
| INV-05 | The intentionally blocked request, Processor fiber, and callback subscription must be released on success, assertion failure, missing request/Status/recovery, and interruption. | Scoped fixture plus in-scope failure boundary | Bun's external timeout does not interrupt `testEffect.run`; current cleanup is happy-path-only |
| INV-06 | The repair must preserve Provider deadline, error classification, retry Status, backoff, final Message, and user-cancellation semantics without production changes. | Actions failure already proves the production path | Production files remain unchanged |
| INV-07 | The implementation must stay within zero production files, two test-scope files, and far below the 600-line user budget unless new evidence forces a revised/audited plan. | Explicit user constraint | Planned route satisfies it |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02/03 | After forking `process`, the test starts a 100ms `Promise.race` before waiting for `llm.wait(1)` or the retry Status itself. The timeout branch can therefore decide the observation and release the gate. | Test synchronization in `processor-effect.test.ts` | Local 48-worker loop failed 3/3 with `observed?.attempt === undefined`; focused unloaded run passed. |
| INV-04 | The test configures every attempt with a 25ms no-progress contract, then asserts exactly two received HTTP calls even though SessionRetry has no attempt cap. | Test expectation/configuration in `processor-effect.test.ts` | macOS attempt 1 received 3 after all user-visible behavior assertions passed; attempt 2 passed; deterministic probe reproduces exact 3-call failure. |
| INV-05 | Gate release and `off()` are ordinary statements after asynchronous waits rather than scoped finalizers. | Test resource lifecycle | Any interruption before those lines bypasses explicit cleanup. |
| INV-02/04 | R2 queues one `after` response and requires that literal, but TestLLMServer consumes it when the second request arrives even if that attempt later expires. | Test success-fixture contract in `processor-effect.test.ts` | Current-source probe forced the second 500ms expiry: `attempt/message/continue` passed and `after` failed. |
| INV-02/04 | R3 deliberately leaves retries unqueued, making TestLLMServer synthesize `ok` from `next === undefined`. | Test producer ownership | R3 plan audit B-01 proves missing explicit response configuration is indistinguishable from correct recovery. |

The first production transition is not divergent. The Provider correctly
expires each silent attempt, MessageV2 correctly classifies the error,
SessionRetry correctly retries, and Status correctly publishes. The failing
expectation is downstream test logic.

### Red-capable feedback loops

Original macOS command:

```bash
# repository root, GitHub Actions macOS runner
bun turbo test:ci --filter=opencode --continue=dependencies-successful
```

Observed attempt 1:

```text
Expected: 2
Received: 3
at test/session/processor-effect.test.ts:816
(fail) session.processor retries a real first-progress timeout [6587.58ms]
3822 pass, 16 skip, 1 fail
```

Deterministic local exact-symptom command:

```bash
# packages/opencode
bun test --preload /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/first-progress-gate-probe.js \
  test/session/processor-effect.test.ts --timeout 30000 \
  -t "session.processor retries a real first-progress timeout"
```

The diagnostic preload leaves the real first timeout intact, removes the
unrelated 100ms observer race, and causes the second attempt to expire once.
Observed output exactly matches CI: expected 2, received 3, with 4 assertions
executed and 8.15s total.

The R2 post-change replay targets the current 500ms second attempt. It produced
the same three-request route and failed only at the newly added `after`
assertion. This is the red signal carried into R4 after R3 was rejected.

Load-sensitive synchronization command:

```bash
# packages/opencode; 48 local CPU competitors are always killed after the test
pids=(); for i in {1..48}; do (while true; do :; done) & pids+=($!); done
trap 'kill $pids 2>/dev/null' EXIT
bun test test/session/processor-effect.test.ts --timeout 30000 \
  -t "session.processor retries a real first-progress timeout"
```

Observed three consecutive times: expected attempt 1, received `undefined`.
This secondary signal catches the same unsupported short observation contract.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Request readiness | `TestLLMServer.wait(1)` | Resolve only after one real HTTP request reaches the fixture | It is the existing published producer signal | A test wall-clock cannot prove request dispatch |
| Retry observation | SessionStatus public Bus event consumed by the test | Exposes attempt/message/next for the Session | This is the user-visible retry seam already under test | Processor internals/counters would couple to implementation |
| Final recovery | `SessionProcessor.process` result plus Message parts | Returns `continue` and writes Provider output | Directly expresses Session behavior | HTTP call count cannot prove semantic recovery |
| Timeout production/classification | Provider + MessageV2 | Expire no-progress attempt and classify retryable | Existing implementation passed the failed CI assertions | Test code must not reimplement or bypass it |
| Retry multiplicity | SessionRetry | Retry each retryable failure under existing schedule | Existing orchestration owns it and has no cap | Test must not impose an exact request count |
| Gate/subscription cleanup | Scoped test effect | Release owned fixture resources on every exit | Test created both resources | Production modules do not own test gates |
| Repeatable explicit success response | Existing TestLLMServer queue | A configured item can remain available for every matching later request | Queue owner must distinguish one-shot and repeat items | SessionProcessor must not know fixture retry multiplicity |

The agreed TDD seam is the existing `SessionProcessor.process` integration test
with real TestLLMServer HTTP, public SessionStatus, and final Message parts.

## 10. Single Approved Primary-Path Design

```text
subscribe retry Status with scoped cleanup
  -> fork SessionProcessor.process
  -> wait for TestLLMServer request readiness (`llm.wait(1)`)
  -> await the real retry Status directly
  -> release the held first response
  -> join the real Processor result
  -> assert timeout attempt/message
  -> assert result="continue"
  -> assert final Message contains explicitly configured repeatable text "after"
```

Modify only the two approved test-scope owners:

1. Register finalizers immediately after creating the gate and Status
   subscription, so interruption releases the held server and unsubscribes.
2. After forking Processor work, run `llm.wait(1)`, direct `retry.promise`
   observation, gate release, and `Fiber.join` inside one existing
   `awaitWithTimeout(..., "20 seconds")`. Remove the 100ms `Promise.race`.
   The 20-second boundary can only fail the Effect; it cannot create request,
   Status, Message, or `continue` success. Its failure closes the test scope,
   interrupts the forked Processor, and executes both finalizers before Bun's
   outer 30-second guard fires.
3. Extend the existing TestLLMServer queue entry with a `repeat` flag and expose
   `pushRepeat(...)`. `pull()` returns a matching repeat item without removing
   it; ordinary `push` and `pushMatch` remain one-shot. This is one queue
   algorithm with explicit item lifetime, not a second response source.
4. Queue the indefinitely held first HTTP error with ordinary `push`, then
   configure `reply().text("after")` through `pushRepeat`. The second, third, or
   any later real same-Provider request receives the same explicit SSE producer.
   The queue-miss default `ok` branch is not reached and cannot satisfy green.
5. Set this test's explicit `chunkTimeout` to 500ms. The first response is held
   indefinitely, so it still must time out. The larger test-only value separates
   the intentional failure from a normal loopback success attempt; it does not
   create success or alter production defaults. The existing two-second retry
   backoff still dominates normal test duration.
6. Remove the exact `llm.calls === 2` assertion.
7. Assert that the final Message contains the explicitly configured literal
   `after`. Together with `observed` and `result`, this proves real timeout,
   visible retry, and semantic recovery without assigning success to a
   particular attempt number or relying on queue-miss default success.

This repairs the first divergence at the test owner. It does not add a
production branch, fallback, retry, setting, adapter, or test-only production
hook.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Real Provider timeout -> Status -> one or more retries -> repeat `after` Message | proposed assertion path | primary contract | yes | 100% | configure explicitly and observe directly |
| In-scope 20s `awaitWithTimeout` | proposed | diagnostic failure boundary and cleanup trigger | no | 0% alternate success | add around the complete asynchronous operation |
| Package-level 30s Bun test timeout | current | outer diagnostic guard | no cancellation bridge | 0% alternate success | preserve as last guard, not cleanup owner |
| 100ms `Promise.race` returning `undefined` | current | forbidden timing substitute | no valid behavior success | current test decision only | remove |
| Exact two-call assertion | current | implementation detail / invalid cap proxy | no | current terminal assertion | remove |
| TestLLMServer queue-miss `ok` | current fixture fallback behavior | existing fixture convenience | yes | 0% of proposed green | preserve unchanged; explicit repeat item prevents this test from reaching it |
| Additional retry after another genuine timeout | current production branch | supported-domain branch | eventually | existing SessionRetry path | preserve; do not count attempts |
| One finite queued `after` response | R2 candidate | invalid attempt-bound test fixture | only if that specific attempt succeeds | R2-only | remove from this test |
| Explicit repeat queue item | proposed | supported test-domain branch within the existing queue contract | yes | 100% of retry success responses | add at TestLLMServer owner |

New alternate success paths: zero. New production diagnostic paths: zero.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 100ms `Promise.race` around retry Status | Tried to make a timeout regression fail quickly | Real request readiness + real Status + in-scope failure boundary provide correct synchronization | `processor-effect.test.ts:798-801` |
| Exact `llm.calls === 2` | Indirectly tried to prove one failed and one successful request | Timeout Status plus explicit final Message content prove the vertical behavior without imposing retry multiplicity | `processor-effect.test.ts:816` |
| One finite queued `after` response | R2 tried to replace call count with semantic content but bound the producer to one request | Explicit repeat item remains available for every supported retry while the final Message assertion stays semantic | Same test's `llm.push` configuration |
| Queue-miss default `ok` as intended success | R3 tried to make retries attempt-independent without a new fixture API | Explicit repeat configuration distinguishes a valid producer from missing setup | R3 design only; reject |
| Success-only manual `off()` and gate release | Basic cleanup in the happy path | Scoped finalizers cover success, failure, and interruption | Same test body |
| Bun outer timeout as implicit cleanup | Assumed rejecting the returned test Promise would cancel the Effect | In-scope failure interrupts the child operation and closes `Effect.scoped` before the outer guard | Same test body via `awaitWithTimeout` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 real timeout remains retryable and visible | Provider -> MessageV2 -> SessionRetry -> Status | No production change; preserve attempt/message assertions | Existing focused Processor test |
| INV-02 behavior-based success | TestLLMServer -> Processor -> Status -> Message | `llm-server.ts`: explicit repeat queue item; `processor-effect.test.ts`: held first item + repeat `after`, readiness/Status/Message | Same vertical test and current-source extra-expiry probe |
| INV-03 wall clock cannot create success | In-scope failure boundary plus outer package guard | Remove 100ms race; add failure-only 20s Effect boundary | 48-worker stress, deadline-suppression mutation, and full CI |
| INV-04 no exact attempt cap | SessionRetry existing schedule | Remove exact call count | Deterministic extra-expiry probe turns from red to green without suppressing retry |
| INV-05 cleanup on every exit | Scoped test lifecycle | Add gate/subscription finalizers and in-scope failure boundary | Focused test, deadline-suppression red mutation, stress test, package cleanup |
| INV-06 production semantics preserved | Existing Provider/Session chain | Zero production files | LLM, retry, Processor regression suites |
| INV-07 user diff budget | Two test-scope owners only | Two existing test-scope files, under 55 changed lines | Final diff inventory |

No confirmed requirement is unmapped.

## 14. Reverse Traceability

No production concept is proposed.

| Proposed test concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `llm.wait(1)` before retry observation | INV-02/03 | Existing published readiness API; 100ms race failed locally | Current test has no request-dispatch synchronization |
| Direct retry Status await | INV-01/02/03 | Status is the public user-visible contract | 100ms race can return without Status |
| One 20s in-scope failure boundary | INV-03/05 | `testEffect.run` has no Bun-timeout cancellation bridge; auditor B-01 | Package timeout can report failure but cannot deterministically close the Effect scope |
| 500ms test-only progress deadline | INV-01/02 | First response is indefinitely gated; 25ms caused a valid third attempt in macOS CI; 500ms probe passed 3/3 under 48-worker load | 25ms conflates intended first failure with nominal success scheduling |
| Explicit repeat queue entry and `pushRepeat` service method | INV-02/04 | Current-source extra-expiry probe proves one-shot queue is insufficient; R3 audit B-01 forbids queue-miss default success | Existing one-shot `push` removes the item on request arrival; no explicit repeat lifetime exists |
| Repeat `after` Message assertion | INV-02/04 | Explicit fixture literal is independent and remains configured across attempts | Exact count, finite queue, and implicit default each fail a confirmed boundary |
| Scoped gate/subscription finalizers | INV-05 | Current statements are bypassed by interruption | Existing fixture scope cannot invoke a test-owned unresolved Promise resolver or returned `off` unless registered |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | Import existing timeout helper; queue the held first item plus explicit repeat `after`; replace timer/count proxies with request, Status, in-scope failure/cleanup, and final Message behavior; use a separated test-only timeout | <= +16 / -9 |
| `packages/opencode/test/lib/llm-server.ts` | modify | Add explicit repeat lifetime to the existing response queue and expose `pushRepeat`; preserve one-shot/default behavior | <= +10 / -1 |
| `docs/plans/session-processor-first-progress-timeout-ci-stability.md` | add | Canonical workflow, evidence, audit, and implementation record | report excluded from user's 600-line implementation budget |

Production files: 0. Test-scope files: 2. Existing files are preferred exactly as
requested; the only new file is the required canonical report.

## 16. TDD Behavior Slices

The behavioral seam is the existing `SessionProcessor.process` integration
path. R4 adds only the approved `TestLLMServer.Service.pushRepeat` fixture seam
at the existing queue owner; it adds no new test or production seam.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Current-source preload causes a valid extra timeout; original test fails with calls 3 and R2 fails with missing `after` | Fixed count and one-shot success both bind recovery to an attempt; R3 default success hides missing setup | Add explicit repeat `after` producer; assert real retry Status + final `after` after the third request | macOS Actions attempt-1, R2 implementation B-01, R3 plan B-01 |
| 2 | 48-worker loop lets 100ms observer win; current test receives `undefined` | Observer begins before request/Status readiness and releases gate by time | Wait for `llm.wait(1)` and retry Status directly; 20s in-scope timeout can only fail and the 30s package timeout remains the last guard | load-sensitive observer race |
| 3 | Suppress the Provider deadline so request/Status/recovery never completes; Bun-only timeout cannot close the scope | Cleanup is happy-path-only and outer timeout does not interrupt Effect | Register scoped finalizers and wrap the complete async operation in a failure-only 20s Effect boundary | timeout/failure cleanup without success synthesis |

Expected values are independent literals from the public seams:
`attempt=1`, `message="SSE read timed out"`, `result="continue"`, and final text
`after`. No private helper, source text, or call count is asserted.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | 22-28 | Includes Processor synchronization/finalizers and TestLLMServer repeat queue semantics; excludes import-only, formatting, removed lines, and this report |
| Required Chinese explanatory comments `C` | 5 | `max(1, ceil(E * 0.15))`; plan at least 7 qualifying lines across the two decision owners |

Planned nearby explanations:

1. Request/retry waits are positive behavior signals; package timeout only
   diagnoses a hang.
2. 500ms is the test's real timeout contract for the indefinitely held first
   response and must not become a success condition or production default.
3. Explicit repeat response lifetime and final Message content replace exact
   request count, finite queues, and queue-miss default success because retry
   multiplicity is not part of the Session contract.
4. TestLLMServer repeat entries remain explicit queue items and never change the
   existing queue-miss/default branch.

The in-scope failure boundary shares the first explanation: it exists to
interrupt and clean up on missing behavior, never to return a success value.

Comments will explain boundaries and intent, not restate assignments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| Focused test, normal | `packages/opencode` | Real timeout Status and explicit successful Message pass |
| Same focused test with current-source extra-expiry diagnostic preload | `packages/opencode` | Original code is red with calls 3, R2 is red with missing `after`, and R4 remains green with repeat `after` after the real third request |
| Three focused runs under 48-worker contention | `packages/opencode` | No 100ms readiness race; all runs complete from real Status/Message behavior |
| Deadline-suppression diagnostic preload, expected red | `packages/opencode` | In-scope 20s failure appears before Bun's 30s guard and the command exits without a live Processor/server/subscription |
| `CI=1 bun test test/session/processor-effect.test.ts --timeout 30000 -t "session.processor retries a real first-progress timeout"` | `packages/opencode` | CI environment does not skip or alter the test |
| `bun test test/session/processor-effect.test.ts --timeout 30000` | `packages/opencode` | All Processor effect tests remain green |
| `bun test test/session/llm.test.ts test/session/retry.test.ts test/session/processor-effect.test.ts --timeout 30000` | `packages/opencode` | Provider timeout, classification, retry, cancellation, and Processor boundaries remain green |
| `bun typecheck` | `packages/opencode` | Test change remains type-safe |
| `bun turbo test:ci --filter=opencode --continue=dependencies-successful` | repository root | Full local CI-equivalent suite has zero failures |
| `git diff --check` | repository root | Final implementation/report has no whitespace errors |

Implementation must record exact commands, durations, pass/fail counts, stress
rate, and any unrelated failures. A focused pass cannot replace the full CI
gate. Native GitHub macOS verification remains a post-push environment check;
the local full command and stress loop are required before implementation audit.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Production files modified | 0 | Production behavior is already correct |
| Test-scope files modified | 2 | Existing failing vertical test plus its existing explicit HTTP response queue owner |
| Reports added | 1 | User explicitly requires a completely new canonical document; excluded from implementation line budget |
| Production lines | 0 | No new production concept |
| Test lines changed | < 55 | Synchronization, queue repeat lifetime, in-scope failure boundary, cleanup, semantic assertion, one test-only configuration value |
| Total implementation lines | < 55 | Far below the user maximum of 600 |
| Generated lines | 0 | No schema/API change |
| Migrations/dependencies | 0 | No persistence or package change |

The user caps are hard maxima, not targets. Any evidence requiring more than
four production files, four test files, or 600 implementation lines requires a
new revision and full-scope audit before implementation.

## 20. Real Risks and Open Decisions

### Real Risks

| Risk | Evidence | Mitigation in approved route |
| --- | --- | --- |
| A timeout behavior test necessarily uses real time | The feature itself is a no-progress deadline and uses a real HTTP server | Gate the first response indefinitely, use 500ms only to cause failure, and derive green from request/Status/Message signals |
| Queue-miss `ok` can hide missing response setup | `llm-server.ts:679-685` and R3 audit B-01 | Configure one explicit repeat item; current test never needs the default branch to pass |
| Bun package timeout does not interrupt the scoped Effect while the HTTP handler waits on a JS Promise | `testEffect.run` returns `Effect.runPromise` without a timeout signal bridge; audit B-01 | Fail inside the Effect at 20s, then let scope finalizers release the gate and interrupt work before the outer 30s guard |
| Callback subscription may survive an early assertion failure | `subscribeCallback` creates an explicit scope closed by `off` | Register `off` as a test-scope finalizer |
| Native macOS Actions scheduling cannot be reproduced exactly locally | Attempt 1 failed and attempt 2 passed | Use deterministic exact-symptom probe, high-load stress, full CI-equivalent run, and report native post-push verification as remaining environment evidence |

### Open Decisions Requiring the User

None. The evidence identifies one owning test and one primary repair path within
the user's file/line budget.

### Rejected Speculation

- **The watcher/SessionPrompt commit caused this production failure:** rejected.
  Its parent diff does not touch this test or Provider/Processor owners.
- **Provider progress deadline is broken:** rejected. The failed CI run observed
  the exact timeout message and retry attempt before eventually continuing.
- **SessionRetry should stop after one retry:** rejected. Existing production
  and the historical explicit requirement preserve no fixed cap.
- **Raise the package test timeout:** rejected. The failed assertion occurred
  in 6.59s, not at the 30s package boundary.
- **Skip macOS or retry the test in CI:** rejected. Attempt 2 passing proves a
  flake, but workflow retries would hide the invalid test contract.
- **Change request count to `>= 2`:** rejected. It remains an implementation
  detail; final Message content is the stronger public behavior.
- **Change production default timeout:** rejected. Only the test's explicit
  25ms value creates the success-path scheduling race.
- **Use TestLLMServer queue-miss `ok` as recovery:** rejected by R3 B-01. It
  converts missing explicit setup into success and cannot be the authoritative
  test producer.
- **Treat Linux/Windows success as proof that macOS needs a product branch:**
  rejected. No platform-specific production divergence is observed.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the verbatim user requirement.
- Reconstruct the current behavior from repository and Actions evidence.
- Treat this plan, prior plans, builder summaries, and diagnostic conclusions as
  untrusted until independently verified.
- Audit the full original scope on every round, including both observed failure
  forms, production ownership, test sensitivity, cleanup, and user diff caps.
- Require evidence for every blocking finding.
- Check under-design and over-design, primary path, fallback, responsibility,
  TDD behavior sensitivity, code quality, and the 15 percent Chinese-comment
  budget.
- Confirm that no production change, retry cap, call-count contract, skip,
  timeout-only success, or fixture fallback is introduced.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01: external Bun timeout cannot trigger planned scoped cleanup | 2 | BLOCK | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |
| 2 | R2 | yes | 0 | 3 | APPROVE — No blocking findings | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |
| 3 | R3 | yes | B-01: queue-miss default success was promoted to the test primary path | 3 | BLOCK | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |
| 4 | R4 | yes | 0 | 4 | APPROVE — No blocking findings | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |

Any substantive revision invalidates earlier approval. A clean independent
verdict may update only the administrative approval fields and this record for
the exact audited revision.

### R1 independent verdict (verbatim)

#### Blocking findings

##### B-01 外部 Bun 超时无法触发计划中的作用域清理

- Violated invariant: `INV-03`、`INV-05`；回归或挂起必须以失败结束，并释放测试持有的 HTTP gate、Processor fiber 和 Bus subscription。
- Evidence class: reachable
- Producer and execution path: `SessionProcessor.process` 被 fork → 计划通过原生 `retry.promise` 直接等待 retry Status → 回归导致 Status 未发布时 Promise 永不 resolve → `testEffect.run()` 一直停留在 `Effect.scoped` 内 → Bun 的外部测试超时只能判定返回的 Promise 超时，没有任何 cancellation/interrupt 桥接回 Effect fiber → scope 不关闭，计划注册的 finalizer 不执行。
- Source evidence: `packages/opencode/test/lib/effect.ts:27-36`；`packages/opencode/test/lib/effect.ts:48-49`；`packages/opencode/test/session/processor-effect.test.ts:104-109`
- Canonical-plan evidence: §7 `INV-03/INV-05`；§10 第 1、2 步；§18 将 package-level 30 秒超时定义为唯一 failure boundary；§20 “Package timeout may interrupt”风险项
- Responsibility owner: `processor-effect.test.ts` 中该测试的同步和失败边界。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 当原始行为真正回归、retry Status 不再发布时，测试虽然最终被 Bun 标记失败，但其 scoped Effect、被 hold 的 HTTP handler 和 callback subscription 没有确定的关闭路径；异步工作可以继续存活并干扰同一进程中的后续测试，且 `INV-05` 声称覆盖 package timeout 的清理合同实际没有实现。
- Why this is not speculative: “retry Status 永不出现”正是该回归测试必须能够处理的失败输入。原生 Promise 没有取消语义，而 `testEffect.run()` 没有接收 Bun timeout 的 signal，也没有调用 fiber interrupt；当前 producer-to-consumer 路径中不存在能够关闭 Effect scope 的桥接。
- Minimal correction direction: 在该测试拥有的 scoped Effect 内设置 failure-only 等待边界，使缺失的 request readiness 或 retry Status 产生 Effect failure并触发既有 finalizer；成功仍只能由 `llm.wait(1)`、真实 Status 和最终 Message 决定，failure boundary 不得生成成功值或替代这些正向行为信号。

#### Non-blocking findings

- R1 对原始 macOS 失败的定位有直接证据支持：Actions attempt 1 在 retry message、`continue` 结果之后仅因 `Expected: 2 / Received: 3` 失败；attempt 2 无源码变化即通过。
- `Audit mode: full-scope` 与调用输入中的 `Audit mode: plan` 用词不一致，但当前状态、revision、approval 和 implementation permission 都明确，未造成行为或授权歧义。

#### Rejected speculation

- **需要修改 Provider progress deadline：**拒绝。现有路径确实生成 `SSE_READ_TIMEOUT`，并由 MessageV2 转换为 retryable APIError。
- **macOS 需要单独的生产分支：**拒绝。没有平台专属生产路径或语义差异证据。
- **SessionRetry 应限制为一次重试：**拒绝。`packages/opencode/src/session/retry.ts:179-210` 的现行 schedule 没有 attempt cap，用户也未要求回退该合同。
- **500ms 在任何机器上都绝对足够：**不作为阻塞项。真实时间测试无法证明绝对调度上限；现有负载探针提供了合理分离证据。实现仍需通过计划列出的 stress 与完整 CI 验证。
- **最终 `after` 断言必然被 fixture 自动 `ok` 满足：**拒绝作为当前阻塞项。自动响应本身不包含 `after`；该断言比 request count 更接近最终 Message 行为。实现审计仍需检查实际断言是否只接受预期文本 part。

#### Requirement and traceability coverage

- **根因与第一分歧：**已正确落在测试同步和固定 request-count 预期，不在 Provider、MessageV2、SessionRetry 或 SessionProcessor 生产路径。
- **生产调用链：**Provider dispatch deadline → `SSE_READ_TIMEOUT` → MessageV2 retryable APIError → SessionRetry → Session Status → 下一 Provider attempt → Processor `continue`，计划重建完整。
- **用户要求覆盖：**
  - 新 canonical document：已满足。
  - macOS Actions 新错误识别：有 attempt 1/attempt 2 日志证据。
  - 检查生产逻辑和测试逻辑：已覆盖 timeout、错误分类、retry、Status、Bus callback、fixture queue 和 Message。
  - 避免 timer 决定成功：计划移除 100ms success-decision race。
  - 测试不降级：用 retry Status、`continue` 和最终 `after` Message 替代固定 call count，方向成立。
  - 修改预算：0 个 production 文件、1 个既有 test 文件、预计少于 30 行，满足限制。
- **未完成映射：**`INV-05` 对 package timeout 场景的 cleanup 映射不可执行，构成 B-01。
- **TDD sensitivity：**固定 call-count 的原始 CI 症状和 100ms observer race 都能让当前测试变红；计划中的新正向断言能够观察公开 seam。缺失 Status 时的失败生命周期仍需按 B-01 补齐。

#### Primary-path and fallback verdict

- 计划保留一条权威路径：真实 HTTP request → Provider timeout → retry Status → SessionRetry → 显式 `after` Message → `continue`。
- 没有新增 production success path、Provider fallback、retry cap、平台分支、配置 fallback 或 test-only production hook。
- 删除 `Promise.race` 和精确 call count 属于移除错误测试代理，不是削弱生产合同。
- TestLLMServer 的自动 `ok` 是既有 fixture 路径；计划通过 `after` 断言排除它单独满足测试。实现审计必须核对实际 Message 断言及队列行为。
- B-01 涉及失败和清理路径，不改变 primary success path，但当前计划尚未完整满足 scoped lifecycle 合同。

#### Code quality and Chinese-comment verdict

- 文件范围、模块责任和测试 seam 符合仓库规则；没有计划新增 helper、公共接口、dependency、production branch 或无关重构。
- 计划预计 `E=10–14`、`C=3`，承诺满足 `C >= ceil(E × 0.15)`，计算可行。
- 三类计划注释分别解释正向行为信号、500ms 测试 deadline 边界和 Message 断言替代 call count 的原因，均可成为合格的邻近中文解释性注释。
- 真实 `E/C` 只能在 implementation audit 中根据实际 diff 重算；当前仅通过计划可行性检查。

#### Release verdict

**BLOCK**

R1 需要补全 Effect 作用域内部的 failure-only 等待边界，使真实回归能够失败并确定执行 gate、fiber 和 subscription cleanup。任何实质修订都必须递增 revision、保持 implementation disallowed，并重新接受完整范围的 plan audit。

### R2 independent verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

- `Audit mode: full-scope` 与调用输入中的 `Audit mode: plan` 用词仍不一致，但 revision、状态、approval 和 implementation permission 均明确，不影响授权边界。
- §10 的 `awaitWithTimeout(..., "20 seconds")` 是简写。实际实现必须遵循 `packages/opencode/test/lib/effect.ts:113-123` 的三参数签名，将错误消息作为第二参数、`"20 seconds"` 作为第三参数。
- §17 将删除行纳入 `E` 的估算说明，与 policy 对 `E` 的正式定义略有偏差；计划仍承诺 3 行合格中文注释，对预计的 14–18 行有效改动满足最低比例，因此不影响批准。Implementation audit 必须按实际 diff 重算。

#### Rejected speculation

- **需要修改 Provider、MessageV2 或 SessionRetry：**拒绝。Actions 失败已经观察到正确的 timeout message、retry Status 和最终 `continue`；第一分歧位于测试同步和固定 request-count 断言。
- **需要增加一次重试上限：**拒绝。`packages/opencode/src/session/retry.ts:179-210` 的现行合同允许 retryable failure 持续重试。
- **20 秒 failure boundary 会决定测试成功：**拒绝。`awaitWithTimeout` 只返回原 Effect 的真实成功值，超时时产生 failure，无法合成 request、Status、Message 或 `continue`。
- **500ms 能证明所有执行环境都有绝对调度上限：**拒绝作为阻塞项。它是测试专用的分离窗口，并有 48-worker contention evidence；实现仍需执行 stress、完整 suite 和 CI-equivalent 验证。
- **TestLLMServer 自动 `ok` 可以单独让测试通过：**拒绝。计划要求最终 Message 存在独立排队的字面值 `after`，自动响应只产生 `ok`。
- **macOS 需要独立生产分支：**拒绝。当前 Provider、SessionProcessor 和 SessionRetry 路径不存在平台专属语义。

#### Requirement and traceability coverage

- **原始 macOS 症状：**完整覆盖。Actions attempt 1 在其余断言通过后仅因 `llm.calls` 从预期 2 变为实际 3 而失败；attempt 2 无源码变化即通过。
- **第一分歧：**完整识别：
  - 100ms `Promise.race` 可以在 request/Status readiness 之前决定结果；
  - 25ms deadline 同时约束故意阻塞的首个 attempt 和正常 loopback retry；
  - 精确 request count 将无 retry cap 的生产合同错误收窄为两次调用；
  - happy-path cleanup 无法覆盖 interruption 和 missing behavior。
- **生产调用链：**已从 Provider dispatch deadline、MessageV2 transport classification、SessionRetry schedule、SessionStatus/Bus 到 SessionProcessor final result 完整重建。
- **修复 owner：**测试同步和生命周期由 `processor-effect.test.ts` 所有；计划不向生产模块泄漏测试责任。
- **行为敏感性：**
  - `llm.wait(1)` 证明真实 HTTP request 已到达；
  - retry Status 证明真实 timeout 被公开 seam 消费；
  - `attempt=1` 和 `SSE read timed out` 保留错误分类合同；
  - `continue` 与最终 `after` Message 证明 Session 恢复；
  - 20 秒边界仅让缺失行为变为 Effect failure；
  - deadline-suppression mutation 覆盖 failure cleanup。
- **R1 B-01：**已解决。R2 在外部 Bun 30 秒 guard 之前加入 Effect 内部 20 秒 failure boundary，使 scope 能确定关闭并执行 gate、fiber 和 subscription cleanup。
- **用户预算：**0 个 production 文件、1 个既有 test 文件、预计少于 35 行 implementation change，满足文件数和 600 行限制。
- **Verified implementation 工作流：**R2 仍保持 implementation disallowed，等待本轮 verdict 被记录后才能进入 approved-plan implementation；后续仍要求 red-green evidence、完整验证和 implementation audit。

#### Primary-path and fallback verdict

- 权威路径唯一：真实 HTTP request → Provider first-progress timeout → MessageV2 retryable APIError → retry Status → SessionRetry → 显式 `after` Message → `continue`。
- 20 秒 `awaitWithTimeout` 是 diagnostic failure boundary，不产生 success-equivalent output，decision-surface 中没有 alternate success。
- 计划删除 100ms timing substitute 和精确 call-count workaround。
- 没有新增 Provider fallback、retry cap、平台分支、配置开关、第二 fixture、test-only production hook 或 catch-and-success。
- TestLLMServer 自动 `ok` 是既有 fixture 行为，计划通过 `after` 断言阻止它单独满足该测试。
- Secondary/replacement path inventory 完整，新增 alternate success path 数量为零。

#### Code quality and Chinese-comment verdict

- 计划修改一个既有测试文件，复用现有 `awaitWithTimeout`、`llm.wait(1)`、Bus Status 和 Effect scope，没有新增 helper、公共接口、dependency 或无关重构。
- 计划与 package-local testing rules 一致：正向结果依赖 readiness、Status 和 Message；wall clock 仅产生真实 timeout 或 failure。
- 预计 `E=14–18`、计划 `C=3`，满足 `ceil(18 × 0.15)=3`。
- 三类计划注释分别解释 failure-only boundary、500ms 测试 deadline 和 Message assertion 的合同，位置与决策相邻，具备通过 Chinese explanatory-comment gate 的可行性。
- Implementation audit 必须根据实际 diff 重新计算 `E`、合格 `C`、排除项和比例。

#### Release verdict

**APPROVE**

批准范围仅限 canonical plan `docs/plans/session-processor-first-progress-timeout-ci-stability.md` 的 **R2**。记录本轮完整范围的 clean verdict 后，才可将状态更新为 `approved`、`Approved revision: R2`、`Implementation allowed: yes`。

### R3 independent verdict (verbatim)

#### Blocking findings

##### B-01 R3 把 queue-miss 默认成功提升为测试主路径

- Violated invariant: `INV-02`、单一权威语义路径，以及“不得用 catch-and-default success 代替 primary behavior”的硬门槛。测试的成功响应必须由明确的 producer 配置，不能由缺少配置时的默认成功合成。
- Evidence class: reachable
- Producer and execution path: 测试只 queue 首个 held HTTP error → 首次 request 到达后该 item 被 `pull()` 移除 → retry request 调用 `pull()` 得到 `undefined` → TestLLMServer 进入 `if (!next)` 分支并自动合成 `ok` SSE → SessionProcessor 把该默认响应作为成功结果并返回 `continue`。
- Source evidence: `packages/opencode/test/lib/llm-server.ts:660-665`；`packages/opencode/test/lib/llm-server.ts:679-685`
- Canonical-plan evidence: §10 第 3、6 步；§11 lines 325-332；§12 finite `after` replacement；§16 slice 1
- Responsibility owner: `processor-effect.test.ts` 的成功 fixture 配置，以及 TestLLMServer 明确响应的测试 seam。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: R3 的 green result 将依赖“没有配置匹配 response”时自动生成的成功值。缺失或错误的 success fixture 配置因此与正确 recovery 不可区分，测试可以在没有任何显式成功 response producer 的情况下通过，降低了对真实 Provider recovery 行为的敏感性。
- Why this is not speculative: R3 明确要求只 queue held first item，因此首个 retry 必然进入 `next === undefined` 分支；该分支直接构造并返回 success-shaped `ok` response。它不是偶发 edge case，而是计划指定的唯一 green producer。
- Minimal correction direction: 在测试所有者 seam 上建立一个明确、可重复且不绑定固定 attempt 的成功 response producer；不得把 TestLLMServer 的 queue-miss 默认成功当作权威 recovery 路径。由此产生的 fixture-scope调整必须保留真实 HTTP/SSE、无 request-count cap 和单一 same-Provider 语义。

#### Non-blocking findings

- `Audit mode: full-scope` 与调用输入中的 `Audit mode: plan` 用词不一致；`Revision: R3`、`Approved revision: none`、`Implementation allowed: no` 仍清晰阻止未批准实现。
- §17 的 `E` 估算说明继续提到删除行；policy 的实际 `E` 不计删除行。计划承诺 3 行合格中文注释，对预计有效改动仍具备通过比例的可行性。
- 当前 worktree 保留被阻塞的 R2 candidate diff。R3 明确将其列为历史 candidate，并保持 implementation disallowed，因此没有造成 revision 授权漂移。

#### Rejected speculation

- **需要修改 Provider、MessageV2 或 SessionRetry：**拒绝。原始 Actions 证据和当前调用链均表明生产 timeout、错误分类、Status 和 retry 行为正确。
- **应恢复固定 request count：**拒绝。`SessionRetry` 没有 attempt cap，三请求路径已经被实际观察。
- **应降低或取消 20 秒 failure boundary：**拒绝。该 boundary 只产生 failure，并负责在 Bun 外部 guard 前关闭 Effect scope。
- **500ms 能保证所有 retry 必定成功：**拒绝作为合同。计划必须允许至少一个已观察到的后续 progress expiry，而不是依靠调度窗口证明其永不发生。
- **必须创建平台专属 macOS 行为：**拒绝。没有平台专属生产分歧证据。
- **自动 `ok` 不是实际 HTTP 响应：**拒绝。它确实经过真实 HTTP/SSE 路径；B-01 针对的是它由 queue-miss 隐式合成，并被 R3 用作唯一成功 producer。

#### Requirement and traceability coverage

- **原始 macOS 失败：**完整识别。首个 timeout、retry Status 和 `continue` 均正确，失败来自固定 `llm.calls === 2`。
- **R2 后续问题：**完整识别。有限 `after` response 在第二次 request 到达时即被消费；该 attempt 再次超时后，第三次 request 无法获得 `after`。
- **生产调用链：**Provider deadline → MessageV2 transport classification → SessionRetry → SessionStatus/Bus → 后续 Provider attempt → SessionProcessor result，重建完整。
- **测试时序：**
  - `llm.wait(1)` 提供真实 request readiness；
  - retry Status 是公开行为 seam；
  - 100ms success-decision race 被删除；
  - 20 秒 boundary 仅用于失败和 cleanup；
  - gate、fiber 和 subscription 生命周期有 scoped owner。
- **未完成映射：**INV-02/04 需要一个可重复且明确配置的 success producer。R3 当前把这一责任交给 queue-miss 默认成功，构成 B-01。
- **TDD sensitivity：**原始 fixed-count red、100ms race red、R2 missing-`after` red 和 cleanup expected-red 均有反馈路径；R3 proposed green 仍缺少不依赖默认成功的 producer。
- **用户预算：**计划仍限制为 0 个 production 文件、最多 2 个 test-scope文件也处于用户的 4 文件上限内，并远低于 600 行。修正 B-01 后需要重新记录准确文件计划。

#### Primary-path and fallback verdict

- Provider、MessageV2、SessionRetry 和 SessionProcessor 的 production primary path 保持唯一。
- 100ms timing substitute、固定 request count 和有限 `after` attempt binding 均计划删除。
- `awaitWithTimeout` 与 Bun timeout 都是 diagnostic failure path，不产生成功。
- TestLLMServer 的 `if (!next) return auto ok` 是 queue-miss 后的 catch-and-default success。
- R3 不再只是保留该既有 fixture 分支，而是故意让每个 recovery request 依赖它。该分支因此成为未经明确接口配置的替代成功路径，fallback hard gate 不通过。

#### Code quality and Chinese-comment verdict

- 计划保持 production code、公共 Provider 接口、retry policy、dependency 和配置 schema 不变。
- 复用 `awaitWithTimeout`、Bus Status、`llm.wait` 和 Effect finalizer 的方向符合仓库风格。
- 预计 `E=14–18`、计划 `C=3`；上限要求为 `ceil(18 × 0.15)=3`，comment gate 在计划阶段可行。
- 计划注释主题覆盖 failure-only boundary、500ms timeout 含义和无固定 retry multiplicity，均可成为合格中文解释性注释。
- B-01 是行为与 primary-path 问题，无法由注释或验证数量弥补。

#### Release verdict

**BLOCK**

R3 需要把 recovery success 从 TestLLMServer 的 queue-miss 默认 `ok` 分支移回明确配置、可重复的测试 producer。该实质修改必须递增 revision、继续保持 implementation disallowed，并接受下一轮完整范围的 plan audit。

### R4 independent verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

- §13 `INV-07` 的 change mapping 仍写“一 existing test file, under 30 changed lines”，而 §15/§19 的 R4 文件计划是两个 test-scope 文件、少于 55 行。实际文件范围和用户预算仍明确，属于记录漂移。
- §16 声称“不引入 new test or private helper seam”，但 R4 会新增 `TestLLMServer.Service.pushRepeat`。§10、§14 和 §15 已完整定义并论证该 seam，因此不影响可执行性。
- `Audit mode: full-scope` 与调用输入中的 `Audit mode: plan` 用词不一致；`Revision: R4`、`Approved revision: none`、`Implementation allowed: no` 仍能正确约束授权。
- §10 的 `awaitWithTimeout(..., "20 seconds")` 是简写。实现必须继续使用三参数签名，将错误消息作为第二参数、duration 作为第三参数。

#### Rejected speculation

- **`pushRepeat` 会创建第二套 fixture：**拒绝。它扩展现有 `Queue` entry lifetime，并继续通过同一个 `pull()`、HTTP handler 和 SSE producer。
- **repeat item 是 fallback：**拒绝。它由测试显式配置，在 request 到达前已存在；它不会在 primary producer 失败或 queue miss 后激活。
- **queue-miss 默认 `ok` 仍能让目标测试通过：**拒绝。显式 repeat item始终匹配并保留，最终断言只接受 `after`。
- **需要增加 production retry cap：**拒绝。现有 SessionRetry 无固定 attempt cap，三请求路径是已观察到的合法行为。
- **500ms 可以证明后续 retry 永不超时：**拒绝作为合同。R4 正是通过 repeat item 和 current-source extra-expiry probe覆盖合法的后续 timeout。
- **需要修改 Provider、MessageV2 或 SessionProcessor：**拒绝。原始 Actions 证据表明生产 timeout、错误分类、Status、retry 和最终 `continue` 均正确。
- **repeat item 必须迁移到 production configuration：**拒绝。该 lifetime 仅属于 TestLLMServer 的显式 response queue。

#### Requirement and traceability coverage

- **原始 macOS 错误：**完整覆盖。首个 timeout、retry Status 和 Session `continue` 已通过，原始失败来自固定 `llm.calls === 2`。
- **时序问题：**
  - 100ms `Promise.race` 被移除；
  - `llm.wait(1)` 提供 request readiness；
  - retry Status 通过公开 Bus seam 观察；
  - 20 秒 timeout 只产生 failure；
  - 500ms 只触发被测 first-progress timeout，并为正常 loopback 调度留出余量。
- **静态测试合同：**
  - 不再断言固定 request multiplicity；
  - explicit repeat `after` producer 对第二次、第三次及后续合法 retry保持可用；
  - queue-miss `ok` 无法满足目标测试；
  - final Message assertion 观察真实 Provider HTTP/SSE 输出。
- **资源生命周期：**
  - gate 和 subscription 注册 scoped finalizer；
  - Processor fiber 属于同一 Scope；
  - internal 20-second boundary 在 Bun 30-second guard 前失败并触发 cleanup。
- **第一分歧和 owner：**
  - timing substitute、固定 count、finite success queue 均位于测试 owner；
  - repeat lifetime 由 TestLLMServer queue owner实现；
  - production orchestration 不吸收 fixture responsibility。
- **TDD sensitivity：**
  - 原始代码在三请求条件下因 calls=3 变红；
  - R2 在同一路径因 finite `after` 被消费而变红；
  - R4 必须在真实第三次 request 后仍得到 repeat `after`；
  - deadline-suppression mutation 验证 failure cleanup；
  - 48-worker stress 验证 readiness 不依赖短 wall-clock race。
- **用户预算：**0 个 production 文件、2 个既有 test-scope 文件、预计少于 55 行，满足各不超过 4 个文件和 600 行上限。
- **Verified implementation workflow：**R4 保持未批准、禁止实现状态；批准后仍需完整 red-green、stress、typecheck、full CI-equivalent 和 implementation audit。

#### Primary-path and fallback verdict

- 权威测试路径唯一：显式 held HTTP error → Provider timeout → retry Status → SessionRetry → 显式 repeat `after` HTTP/SSE response → final Message → `continue`。
- `pushRepeat` 只改变现有 queue item 的消费 lifetime；one-shot `push`、`pushMatch` 和 queue-miss default 保持原语义。
- repeat response 是显式 producer，不是 primary failure 后启用的替代实现。
- queue-miss `ok` 是既有 fixture fallback，但目标测试不会到达或依赖该分支。
- 100ms timing substitute、固定 call count、finite attempt-bound response 和 R3 implicit-default route均有明确删除决定。
- 新 production alternate success paths：0。
- 新 diagnostic production paths：0。

#### Code quality and Chinese-comment verdict

- 新责任位于 TestLLMServer queue owner，没有向 SessionProcessor、Provider 或 SessionRetry 泄漏 fixture 语义。
- `repeat` flag 与现有 `Queue` entry、`pull()` 和 Service interface构成一条现有算法的显式 lifetime 分支，没有第二个 parser、server 或 response source。
- `pushRepeat` 有 observed/reachable justification：R2 current-source probe证明 one-shot item在第二个 request 到达时被消费，无法覆盖合法的第三次 request。
- 计划没有新增 dependency、configuration schema、generated artifact、migration、skip、platform branch 或 production hook。
- 预计 `E=22–28`，最低中文解释性注释数为 `ceil(28 × 0.15)=5`；计划承诺至少 7 行合格注释，覆盖：
  - repeat queue lifetime；
  - one-shot/default preservation；
  - failure-only timeout；
  - 500ms 边界；
  - Message assertion 与无固定 retry multiplicity。
- Chinese explanatory-comment gate 在计划阶段可行；implementation audit 必须按实际 diff 重算 `E`、`C`、排除项和比例。

#### Release verdict

**APPROVE**

批准仅适用于 canonical plan `docs/plans/session-processor-first-progress-timeout-ci-stability.md` 的 **R4**。记录本轮 full-scope clean verdict 后，才可更新为 `Approved revision: R4` 并进入 approved implementation workflow。

## 23. Implementation Evidence

R2 implementation evidence is retained as a blocked historical candidate. R4
implements the approved explicit repeat lifetime at the existing TestLLMServer
queue owner and uses it through the existing SessionProcessor integration seam.
No production file, Provider/Session interface, retry policy, dependency,
configuration schema, generated artifact, migration, skip, or alternate
production success path changed.

### Actual Files and Diff

| File | Raw added | Raw removed | Responsibility |
| --- | ---: | ---: | --- |
| `packages/opencode/test/lib/llm-server.ts` | 13 | 1 | Add the approved explicit repeat lifetime to the existing queue and expose `pushRepeat`; preserve one-shot and queue-miss behavior. |
| `packages/opencode/test/session/processor-effect.test.ts` | 28 | 17 | Replace timer/count proxies and finite success response with request readiness, retry Status, scoped failure/cleanup, repeat `after`, and final Message behavior. |
| `docs/plans/session-processor-first-progress-timeout-ci-stability.md` | report | 0 | Canonical evidence and audit record; excluded from the user's implementation-line budget. |

Actual implementation scope: zero production files, two existing test-scope
files, 59 raw changed implementation lines, and zero generated/dependency/migration lines. The
other staged/untracked files visible in `git status` are unrelated concurrent
work and remain untouched.

### Red-Green Test Evidence

**Original red:** GitHub Actions macOS run `29681810694`, attempt 1, failed only
at `llm.calls === 2` with actual `3` after timeout message, retry attempt, and
`continue` assertions passed.

**Deterministic exact red:** the throwaway preload caused one additional valid
second-attempt expiry. Current pre-fix test produced expected 2 / received 3,
0 pass / 1 fail, 4 assertions, 8.15s.

**Load red:** before implementation, three consecutive 48-worker focused runs
returned `observed?.attempt === undefined`, proving the 100ms race could release
the HTTP gate before retry Status delivery.

**R2 candidate green:**

- Focused test: 1 pass, 0 fail, 4 assertions, 4.48s.
- The same exact-symptom preload no longer matched removed 25ms/100ms decisions:
  1 pass, 0 fail, 4 assertions, 4.76s.
- Three consecutive 48-worker runs: 1/1 pass each in 10.93s, 9.75s, and
  10.69s.

**R2 post-change red:** forcing the current 500ms second attempt to expire
produced the real third-request route. Retry attempt/message and `continue`
passed, but the finite queued `after` had already been consumed and the final
Message assertion failed (`Expected: true`, `Received: false`) in 8.94s.

**R4 current-source red-green:** immediately before the R4 code change, the
current-source preload again forced the second 500ms attempt to expire and the
test failed only at the final `after` assertion: 0 pass, 1 fail, 4 assertions,
8.63s. After adding the explicit repeat queue lifetime and changing the test to
`pushRepeat(reply().text("after"))`, the same preload logged the second attempt
expiry and passed after the real third request: 1 pass, 0 fail, 4 assertions,
8.92s.

**Failure cleanup red:** suppressing the 500ms Provider deadline made the
in-scope 20s boundary fail with
`first-progress timeout did not publish retry status and recover` at 20.79s.
The adjacent Processor test passed in the same Bun process (1 expected fail,
1 pass), and the R4 command exited at 22.91s before Bun's outer 30s guard. This
proves missing behavior closes the Effect scope instead of leaving cleanup to
the external timeout.

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/session/processor-effect.test.ts --timeout 30000 -t "session.processor retries a real first-progress timeout"` | `packages/opencode` | 1 pass, 0 fail, 4 assertions, 5.10s |
| Current-source second-attempt-expiry preload, before R4 | `packages/opencode` | Expected red: real third request completed, final `after` absent, 0 pass / 1 fail, 4 assertions, 8.63s |
| Same current-source preload, after R4 | `packages/opencode` | 1 pass, 0 fail, 4 assertions, 8.92s; diagnostic log confirmed the second Provider attempt expired |
| Deadline-suppression preload with focused + adjacent test | `packages/opencode` | Expected red at in-scope 20s boundary; adjacent test passed; process ended in 22.91s |
| Three focused runs with 48 CPU competitors per run | `packages/opencode` | 3/3 pass, 0 fail; 11.33s / 10.10s / 12.26s |
| `CI=1 bun test test/session/processor-effect.test.ts --timeout 30000 -t "session.processor retries a real first-progress timeout"` | `packages/opencode` | 1 pass, 0 fail, 4 assertions, 4.85s |
| `bun test test/session/processor-effect.test.ts --timeout 30000` | `packages/opencode` | 19 pass, 0 fail, 80 assertions, 31.96s |
| `bun test test/session/llm.test.ts test/session/retry.test.ts test/session/processor-effect.test.ts --timeout 30000` | `packages/opencode` | 86 pass, 0 fail, 241 assertions, 38.01s |
| `bun typecheck` | `packages/opencode` | Pass (`tsgo --noEmit`) |
| `bun turbo test:ci --filter=opencode --continue=dependencies-successful` | repository root | 3824 pass, 16 skip, 0 fail, 3840 tests, 11193 assertions; 3/3 tasks successful; 9m39.528s |
| `git diff --check` | repository root | Pass, no output |

### Original Feedback-Loop Result

The deterministic current-source three-request reproduction changed from the
R2 missing-`after` red to R4 green while still logging the forced second-attempt
expiry. The full CI-equivalent command then passed with 3824 tests green and
zero failures. The original behavior loop is therefore satisfied locally
without suppressing the additional retry.

The native macOS Actions runner has not executed the post-change worktree
because no commit or push was requested. This remains environment verification,
not a missing local behavior signal: original attempt 1, unchanged attempt 2,
the deterministic exact probe, 48-worker stress, and full CI-equivalent suite
are all recorded.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Actual disposition |
| --- | --- | --- | --- |
| Real request -> first-progress timeout -> retry Status -> explicit repeat `after` Message -> `continue` | R4 primary test path | yes through the configured HTTP/SSE producer after any supported retry | implemented and green under the real third-request probe |
| In-scope 20s `awaitWithTimeout` | diagnostic failure/cleanup boundary | no | Preserved; expected-red mutation proved it fails and closes scope |
| Outer Bun 30s test timeout | outer diagnostic guard | no | Preserved; no longer owns Effect cleanup |
| TestLLMServer queue-miss `ok` | existing fixture behavior | yes through real HTTP/SSE | Preserved unchanged; the target test's retained repeat item prevents this branch from being reached |
| Additional retry after a real no-progress expiry | supported production branch | eventually | Preserved without count assertion or cap |
| Explicit repeat queue item | supported test-domain branch in the existing queue | yes | Implemented at the queue owner; ordinary `push`/`pushMatch` remain one-shot |

Removed workarounds: 100ms `Promise.race`, exact `llm.calls === 2`, the finite
one-request `after` producer, success-only manual cleanup, and R3's proposed
queue-miss success dependency. New alternate success paths: zero. Production
decision-surface change: zero.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 26 | Processor: 17 from 28 additions after excluding one import-only line, seven comments, and three formatter-only config-object lines. TestLLMServer: 9 from 13 additions after excluding three comments and one blank line. Removed lines are not added to E. |
| Qualifying Chinese comment lines `C` | 10 | Processor: gate ownership, exact 500ms boundary, repeat response invariant, behavior-only positive result/failure boundary, no fixed retry multiplicity, final Message contract, and loopback separation. TestLLMServer: repeat lifetime, explicit producer vs default success, and one-shot preservation. |
| Ratio `C / E` | 0.385 | `10 / 26 = 38.5%` |
| Required minimum `C` | 4 | `max(1, ceil(26 * 0.15)) = 4` |

### Remaining Unverified Items

- Native post-change GitHub Actions macOS execution requires a later authorized
  commit/push. No platform-specific production behavior is claimed.
- Both current-source diagnostic probes were deleted from the OS temporary
  directory after explicit user authorization; no `DEBUG-first-progress`
  instrumentation remains in the repository.
- Unrelated staged/untracked plans and generated SDK changes remain outside this
  implementation and audit diff.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01: original three-request path was not rerun against current source; actual replay fails at finite `after` assertion | 3 | BLOCK | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |
| — | R3 | not invoked | Plan blocked before implementation | — | superseded by R4 | — |
| 2 | R4 | yes | 0 | 4 | APPROVE — No blocking findings | adversarial-auditor task `ses_08607602dffeQK02zf2dDk1rs9` |

### R2 implementation verdict (verbatim)

#### Blocking findings

##### B-01 原始三请求路径没有在修改后被重新执行

- Violated invariant: `INV-04`；额外的真实 no-progress expiry 不得让一个最终正确恢复的 Session 测试失败。Implementation hard gate 还要求原始 bug feedback loop 在修改后真实通过。
- Evidence class: reachable
- Producer and execution path: 首个 held request 超时 → 第二个 request 到达 TestLLMServer，并立即从 queue 移除显式 `after` response → 第二个 attempt 在读取首个 progress 前再次超时 → 第三个 request 在 queue 为空时获得 fixture 自动 `ok` → SessionProcessor 可以返回 `continue`。如果第二个 attempt 在 `after` delta 到达 Message 前过期，当前 `part.text === "after"` 断言仍会失败。
- Source evidence: `packages/opencode/test/lib/llm-server.ts:660-665`；`packages/opencode/test/lib/llm-server.ts:679-685`；`packages/opencode/src/provider/provider.ts:184-190`；`packages/opencode/test/session/processor-effect.test.ts:817-822`
- Canonical-plan evidence: §16 slice 1；§18 exact-symptom verification；§23 `Red-Green Test Evidence` lines 653-665
- Responsibility owner: `processor-effect.test.ts` 的 retry recovery 测试合同及其 post-change feedback loop。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: Implementation evidence 明确记录 post-change preload “no longer matched removed 25ms/100ms decisions”。因此该运行只是未注入额外 expiry 的普通 green run，没有证明 observed macOS 三请求路径已经转绿。原始条件再次出现时，固定 call-count failure 虽已删除，测试仍可能改在 `after` 断言处失败。
- Why this is not speculative: macOS attempt 1 已观察到第三个 request；TestLLMServer 在 request 到达时先消费 queue item，且 Provider 对每个 attempt 独立应用 progress deadline。R2 明确要求 deterministic extra-expiry probe 覆盖该路径，但保存的 post-change evidence 承认 probe 已失配，且 probe 随后被删除，无法重新核验。
- Minimal correction direction: 使用仍能对 post-change source 实际强制一次后续 no-progress expiry 的 deterministic feedback loop，验证原始三请求条件下的公开 Session 行为。若当前断言失败，应在该测试 owner 内修正行为合同；不得恢复 request-count 约束、增加 retry cap 或引入 fixture fallback。

#### Non-blocking findings

- Native post-change GitHub Actions macOS job 尚未执行，因为用户没有授权 commit/push。计划已将其明确列为 remaining environment verification，本身不构成本轮额外阻塞项。
- `Audit mode: full-scope` 与调用输入的 `Audit mode: implementation` 用词不一致；当前 `Revision: R2`、`Approved revision: R2` 和 `implementation-audit-required` 状态仍能明确限定审计对象。
- `git status` 中另有 `packages/opencode/test/server/httpapi-session.test.ts` 等并发修改；实际目标 diff 未包含这些文件，本轮未将其归入实现范围。

#### Rejected speculation

- **需要修改生产 timeout 或 retry policy：**拒绝。实际 diff 没有修改生产代码，Actions 证据也表明 timeout、分类、Status 和 retry 主链正常。
- **20 秒 boundary 能生成成功结果：**拒绝。`awaitWithTimeout` 只传播被包装 Effect 的成功；超时路径产生 failure。
- **`llm.wait(1)` 仍是 scheduler sleep：**拒绝。它由 TestLLMServer 收到的真实 HTTP hit 驱动。
- **必须恢复 `llm.calls === 2`：**拒绝。固定调用次数与无 retry cap 的生产合同冲突。
- **500ms 必须保证所有机器绝不发生额外 retry：**拒绝。这不是可成立的合同；额外 retry 正是 INV-04 和 deterministic probe 应覆盖的受支持路径。
- **自动 `ok` 单独满足当前测试：**拒绝。当前断言要求字面值 `after`。B-01 关注的是 `after` response 被消费后再次超时的组合路径。

#### Requirement and traceability coverage

- **macOS 原始失败定位：**完整。第一分歧是测试使用 25ms success-attempt budget、100ms observer race 和精确两次 request 断言。
- **生产逻辑检查：**完整。Provider deadline、MessageV2 transport classification、SessionRetry、SessionStatus、Bus 和 SessionProcessor 均未发现需要生产修改的第一分歧。
- **测试时序修复：**
  - 已移除 100ms `Promise.race`；
  - 已加入 `llm.wait(1)` readiness；
  - retry Status 通过公开 Bus seam 观察；
  - 20 秒只作为 failure boundary；
  - gate 和 subscription 已注册 scope finalizer。
- **测试合同修复：**
  - 已删除固定 request count；
  - 保留 attempt、timeout message 和 `continue`；
  - 新增最终 Message 的 `after` 行为断言。
- **资源清理：**deadline-suppression expected-red evidence 表明内部 20 秒 failure 在 Bun 30 秒 guard 之前结束，并允许同进程相邻测试通过。R1 B-01 的 cleanup 路径已实现。
- **用户预算：**0 个 production 文件、1 个既有 test 文件、38 raw changed test lines，符合文件和 600 行限制。
- **缺失覆盖：**post-change deterministic probe 没有实际注入原始额外 expiry，导致 INV-04 和原始三请求 feedback loop 未完成验证。

#### Primary-path and fallback verdict

- 实现没有新增 production success path、Provider fallback、retry cap、配置开关、平台分支或第二 fixture。
- 正常 green path由真实 request、真实 timeout Status、SessionProcessor result 和 Message content共同决定。
- 20 秒 boundary 与 Bun 30 秒 guard 都只产生 diagnostic failure。
- 100ms timing substitute、固定 request count 和 success-only manual cleanup 已删除。
- TestLLMServer 自动 `ok` 是既有 fixture success path。当前测试通过 `after` 排除其单独满足 green，但 B-01 所述的“显式 response 被消费后再次 expiry”组合路径仍需真实验证。

#### Code quality and Chinese-comment verdict

- 实现复用了现有 `awaitWithTimeout`、`llm.wait`、Effect scope 和 Bus subscription API，没有新增 helper、公共接口、dependency、类型抑制或无关 production code。
- 三参数 `awaitWithTimeout` 调用正确：error message 为第二参数，`"20 seconds"` 为第三参数。
- Finalizer、readiness、failure boundary 和 Message assertion 均位于测试 owner，责任位置正确。
- 独立重算：
  - `E = 15`
  - `C = 5`
  - 排除项：1 行 import-only、3 行 formatter-only config object、5 行解释性注释；删除行不计入 `E`
  - 合格注释位于 `processor-effect.test.ts:759`、`:762`、`:801`、`:821`、`:826`
  - 最低要求：`ceil(15 × 0.15) = 3`
  - 实际比例：`5 / 15 = 33.3%`
- Chinese explanatory-comment gate 通过。
- `git diff --check` 通过；保存的 full CI-equivalent output显示 3820 pass、16 skip、0 fail、3/3 tasks successful。

#### Release verdict

**BLOCK**

R2 实现需要重新执行一个能对当前 post-change source 实际强制后续 progress expiry 的 deterministic feedback loop。该路径 clean 后仍需再次进行完整 implementation audit。

### R4 implementation verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

- `packages/opencode/test/lib/llm-server.ts` 实际 raw delta 为 `+13/-1`，超过 R4 计划中的 `<= +10/-1` 估算；总实现仍只有 59 raw changed lines，远低于用户 600 行上限，且没有新增未批准行为。
- `Audit mode: full-scope` 与调用输入中的 `Audit mode: implementation` 用词不一致；`Revision: R4`、`Approved revision: R4`、`implementation-audit-required` 明确限定了本轮对象。
- Native post-change GitHub Actions macOS job 尚未执行，因为用户未授权 commit/push。计划已准确列为 remaining environment verification。
- `git status` 中存在 `packages/core/src/models-snapshot.js`、SDK generated types 和其他 plan 等并发修改；实际目标 diff未包含这些文件，本轮未将其归入实现。

#### Rejected speculation

- **`pushRepeat(...items)` 的多个无条件 repeat items 可能互相遮挡：**当前唯一 producer只传入一个 item，且没有第二个现有 caller。多 item 行为没有当前 requirement 或 reachable caller，不构成发布阻塞项。
- **repeat response 是 fallback：**拒绝。它在 Processor 启动前被显式配置，并通过现有 queue、HTTP handler 和 SSE producer执行；queue miss不会激活它。
- **queue-miss 默认 `ok` 仍能满足目标测试：**拒绝。repeat `after` item始终保留并优先匹配，最终断言只接受字面值 `after`。
- **需要恢复精确 request count：**拒绝。SessionRetry 没有 attempt cap，实际三请求路径已被观察和重放。
- **500ms 必须保证所有后续 attempt 都不超时：**拒绝。current-source probe 已强制第二个 500ms attempt过期，第三个 request仍通过 repeat producer完成。
- **需要修改 Provider、MessageV2、SessionRetry 或 SessionProcessor：**拒绝。生产链已在原始失败中正确生成 timeout、retry Status 和最终 `continue`。
- **20 秒 timeout 决定测试成功：**拒绝。`awaitWithTimeout` 只传播内部 Effect 的真实成功，超时只能产生 failure并关闭 scope。

#### Requirement and traceability coverage

- **原始 macOS 错误：**完整覆盖。原失败只发生在 `llm.calls === 2`，实际为 3；timeout message、retry attempt 和 `continue` 均已通过。
- **第一分歧：**
  - 100ms `Promise.race` 可以先于 request/Status readiness结束；
  - 25ms 同时约束故意阻塞的首个 attempt 和正常 loopback recovery；
  - 固定两次 request断言与无 retry cap 合同冲突；
  - one-shot `after` 在第二个 request到达时即被消费；
  - happy-path-only cleanup 无法覆盖 missing behavior和 interruption。
- **实现映射：**
  - `llm.wait(1)` 等待真实 HTTP request；
  - Bus callback观察公开 retry Status；
  - `attempt=1` 和 `SSE read timed out` 保留错误分类合同；
  - `pushRepeat(reply().text("after"))` 提供明确、可重复的 same-Provider producer；
  - final Message `after` 与 `continue` 证明真实 recovery；
  - 20 秒 Effect boundary只负责 failure和 cleanup；
  - gate及 subscription由 scope finalizer释放。
- **原始 feedback loop：**
  - R2 在强制第二次 expiry 后因缺少 `after` 变红；
  - 同一个 current-source probe 在 R4 下记录第二个 Provider attempt expiry，并在真实第三个 request后通过；
  - 原始额外 retry没有被禁用或隐藏。
- **测试稳定性：**
  - 移除 100ms success-decision race；
  - 三次 48-worker run全部通过；
  - CI mode focused run通过；
  - deadline-suppression expected-red在内部 20 秒边界失败，相邻测试继续通过，进程在 Bun 30 秒 guard前结束。
- **验证覆盖：**
  - focused test：1 pass；
  - Processor file：19 pass；
  - LLM/retry/Processor组合：86 pass；
  - `bun typecheck`：通过；
  - full CI-equivalent：3824 pass、16 skip、0 fail、3/3 tasks successful；
  - `git diff --check`：通过。
- **用户预算：**0 个 production 文件、2 个既有 test-scope 文件、59 raw changed implementation lines，满足文件数和 600 行限制。

#### Primary-path and fallback verdict

- 权威路径唯一：held HTTP error → Provider first-progress timeout → MessageV2 retryable APIError → retry Status → SessionRetry → 显式 repeat `after` HTTP/SSE response → final Message → `continue`。
- `pushRepeat` 复用现有 `Queue`、`pull()`、HTTP handler 和 response serializer，仅增加显式 item lifetime。
- 普通 `push` 和 `pushMatch` 仍保持 one-shot；queue-miss default分支未修改。
- repeat item不会在 queue miss、primary failure或不确定状态后临时激活。
- 100ms timing substitute、精确 call count、finite attempt-bound success response和 implicit-default recovery均已移除。
- 新 production alternate success paths：0。
- 新 diagnostic production paths：0。
- Diagnostic decision-surface不涉及 production code。

#### Code quality and Chinese-comment verdict

- 实现严格对应 approved R4：
  - `llm-server.ts` 增加 `repeat` lifetime、`queueRepeat`、`pushRepeat` 和 owner-side consume判断；
  - `processor-effect.test.ts` 使用该显式 producer，并实现 approved readiness、cleanup和行为断言。
- 没有新增 `any`、cast、non-null assertion、type suppression、dependency、configuration surface、migration或 generated artifact。
- 新 fixture responsibility位于 TestLLMServer queue owner，没有泄漏到 Provider或Session模块。
- `awaitWithTimeout` 使用正确的三参数签名。
- One-shot/default preservation由局部 `if (!first.repeat)` 实现，现有 full suite通过。
- 独立 Chinese comment 重算：
  - `E = 26`
  - `C = 10`
  - Processor：17 个有效代码行；排除 1 行 import-only、7 行解释性注释、3 行 formatter-only config结构行
  - TestLLMServer：9 个有效代码行；排除 3 行解释性注释和 1 个空行
  - 删除行不计入 `E`
  - 最低要求：`ceil(26 × 0.15) = 4`
  - 实际比例：`10 / 26 = 38.5%`
- 10 行注释均邻近对应决策，解释 fixture ownership、repeat lifetime、one-shot preservation、failure-only boundary、500ms含义和 Message assertion合同。Chinese explanatory-comment gate通过。

#### Release verdict

**APPROVE**

该 clean verdict 仅适用于 canonical plan **R4** 和本轮审计的实际三文件 diff。Native macOS Actions post-push run仍是明确记录的后续环境验证，不影响当前本地 verified implementation release verdict。

The task may be marked `verified` only after the exact approved implementation
passes all required verification, records the actual path/diff/E/C evidence,
and receives an independent full-scope result of `No blocking findings`.
