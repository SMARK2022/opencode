# Canonical Implementation Plan: Provider Timeout Transport Integrity

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: implementation
>
> Requirement source: Session GOAL supplied by the user on 2026-07-15, plus the explicit follow-ups "不能以牺牲用户体感为代价", "是的，删除RP-04", and the R5 continuous-chunk contract
>
> Implementation allowed: yes
>
> Last updated: 2026-07-15

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 你的任务是详细完成一个检查相应的逻辑,同时也可以详细完整调研一下我们获得的新的windows数据库/Users/sunbenteng/Project/opencode/.temp/testing/opencode.db, 完整详细检查open code在mac以及尤其是windows平台上出现严重超时问题的原因，进行ABtest实验分析验证（只能在.temp/testing/中进行，同时不修改数据库），完整检查问题分析原因并提出显著性的修复方案，不能以牺牲用户体感为代价（包含至少3个关键修复点，10个以内，不大于1sigma显著性的不要）
>
> 目标终态：`<verified-implementation-and-commit>`

The user separately reinforced the product constraint:

> 不能以牺牲用户体感为代价

The user then replaced the R2 retry proposal with this explicit requirement:

> 是的，删除RP-04，我说了不希望引起体感的退化，理论上尤其是自动执行，弹出属于降级体验

The user then explicitly confirmed the existing setting's phase semantics:

> 是的就该这样
>
> 每个chunk之间的time都应该是这个timeout
>
> （不累计，每个chunk重置计时）

## 2. Explicit Non-Goals

- Do not implement until exact revision R5 receives a new independent
  full-scope approval; R2 approval is invalidated by the retry-policy change.
- Do not modify either SQLite database. All database access remains read-only.
- Do not run A/B experiments outside `.temp/testing/` or commit experiment
  output as production behavior.
- Do not switch Provider or Model, hedge duplicate requests, add an alternate
  Provider success path, or silently fall back after failure.
- Do not shorten prompts, truncate context, hide reasoning, suppress Tools,
  reduce output quality, or count a spinner/lifecycle event as first semantic
  feedback.
- Do not increase the existing ten-minute absolute request deadline as a way to
  hide the five-minute defect.
- Do not change the numeric defaults `chunkTimeout=180000` or
  `timeout=600000`. Per the user's explicit R5 confirmation, the existing
  `chunkTimeout` setting governs the continuous no-progress window from
  dispatch to the first raw SSE chunk and from each raw chunk to the next; each
  received chunk resets the window and elapsed gaps do not accumulate.
- Do not add a database migration, a new persisted retry schema, a new Provider
  configuration key, or generated SDK changes. Existing Session Status already
  exposes retry message, countdown, and attempt while a retry is active.
- Do not add `maxTransportRetries`, a fixed attempt cap, or any new terminal
  error/prompt after repeated retryable transport failures. Autonomous Sessions
  must retain the current retryable classification, backoff, Status, and user
  cancellation behavior.
- Do not modify `SessionRetry`, `SessionProcessor`, or Permission reviewer retry
  policy. They are inspected regression boundaries, not implementation owners
  for this repair.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Requires parallel inspection, package-local test execution, Bun APIs, minimal primary-path changes, and package-local typecheck. |
| `packages/opencode/AGENTS.md` | Defines Effect/module conventions and confirms SQLite/Drizzle ownership; no migration is needed. |
| `packages/opencode/test/AGENTS.md` | Requires public behavior seams, scoped fixtures, readiness signals, and permits fixed delays only when network latency is the behavior under test. |
| `CONTEXT.md` | Defines Session, Message, Provider, Tool, Status, Run state, NetworkProxy, and the v1/v2 boundary. v1 `session/` is current production; v2 is in flight and must not be treated as parity evidence. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, zero new fallback budget, complete forward/reverse mapping, independent audit, and the 15 percent Chinese explanatory-comment gate. |
| `docs/adr/README.md` | Defines ADR scope. This task does not create a new load-bearing architecture decision; it restores existing transport/config contracts. |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | Not applicable to Provider transport behavior; inspected to confirm there is no relevant accepted ADR. |
| Bun [`oven-sh/bun#16682`](https://github.com/oven-sh/bun/issues/16682) and [`oven-sh/bun#33647`](https://github.com/oven-sh/bun/pull/33647) | Establish the upstream 300-second socket-idle behavior and the semantics of explicit Bun `timeout`. The fix is merged to Bun main but absent from stable `1.3.14`. |

No existing plan under `docs/plans/` covers Provider timeout transport
integrity. This file is therefore the one canonical artifact.

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `.temp/testing/opencode.db` | Immutable Windows snapshot: `quick_check=ok`, 1,158 Sessions, 92,228 Messages, 409,799 Parts. | observed |
| `.temp/testing/provider-timeout-ab/RESULTS.md` | Stable record of all red-capable/A-B commands, effect sizes, database windows, and immutable database identity. | observed |
| `.temp/testing/provider-timeout-ab/network-proxy-timeout-ab.ts` | Drives real `NetworkProxy.fetch` against a delayed local server under a scaled Bun idle deadline. | observed |
| `.temp/testing/provider-timeout-ab/network-proxy-explicit-proxy-ab.ts` | Drives the public `NetworkProxy.fetch` explicit-proxy branch against a delayed local HTTP proxy under the same scaled Bun idle deadline. | observed |
| `.temp/testing/provider-timeout-ab/custom-fetch-init-ab.ts` | Demonstrates loss of `timeout:false` at the custom-fetch interface. | observed |
| `.temp/testing/provider-timeout-ab/provider-route-policy-ab.test.ts` | Drives two real Provider SDK instances through direct/custom route selection and proves the custom branch omits the common transport policy: direct 100/100 versus custom 0/100, `14.142σ`. | observed |
| `.temp/testing/provider-timeout-ab/db-significance.ts` | Read-only cross-database effect and context-stratified significance analysis. | observed |
| `.temp/testing/provider-timeout-ab/log-retry-analysis.ts` | Correlates local fetch timeout, retry, second response, and first semantic event by Message. | observed |
| `.temp/testing/provider-timeout-ab/retry-budget-feedback.ts` | Deterministically confirms the current schedule accepts 100 transport-timeout retries; R4 preserves this behavior and does not use the R2 terminal-bound expectation as a green gate. | observed/contracted |
| `.temp/testing/provider-timeout-ab/loop-stage-analysis.ts` | Reconstructs first feedback, first text, Tool-to-next-feedback, loop exposure, and pre/post-step stages. | observed |
| `packages/core/src/network-proxy.ts:30-32,195-205,236-309` | Defines the routed transport contract and the first loss of Bun-specific `timeout`. | reachable |
| `packages/core/test/network-proxy.test.ts` | Existing tests cover native fetch isolation and Windows helper visibility, but not Bun timeout propagation through direct, explicit-proxy, or custom branches. | observed |
| `packages/opencode/src/provider/provider.ts:38-43,89-195,1845-1933` | Owns overall deadline, chunk idle deadline, custom/direct dispatch, fetch timing, and SSE wrapping. | reachable |
| `packages/opencode/src/config/provider.ts:82-114` | Public Provider contract: overall timeout plus the user-authorized continuous chunk no-progress window. | contracted |
| `packages/opencode/src/plugin/codex.ts:414-505` | Codex OAuth custom fetch rewrites/authenticates then delegates to NetworkProxy. | reachable |
| `packages/opencode/src/plugin/github-copilot/copilot.ts:85-171` | Copilot custom fetch preserves init and delegates to NetworkProxy. | reachable |
| `packages/opencode/src/provider/claudecode.ts:266-395` | Claude custom fetch explicitly promises to preserve signal/keepalive and delegates to NetworkProxy. | reachable |
| `packages/opencode/src/session/prompt.ts:2414-2702` | Creates Assistant Message, assembles request, and dispatches Processor. | reachable |
| `packages/opencode/src/session/processor.ts:1014-1102` | Owns user-visible Session stream retry orchestration and Status updates; inspected to prove R4 must not add an attempt cap. | contracted |
| `packages/opencode/src/session/llm.ts:339-464` | AI SDK stream boundary; `maxRetries=0` leaves retry policy to SessionRetry. | reachable |
| `packages/opencode/src/session/retry.ts:25-210` | Current retry classification/backoff schedule has no transport-timeout attempt bound; this is now explicitly preserved. | observed/contracted |
| `packages/opencode/src/session/message-v2.ts:34-60,89-97,1512-1593` | Converts Bun/SSE transport errors to retryable APIError and preserves a transport code in metadata. | reachable |
| `packages/opencode/src/session/status.ts:8-31,51-88` | Existing visible retry contract carries attempt, message, action, and next timestamp. | contracted |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1912-1993` | Existing TUI renders retry error, countdown, attempt, interrupt, and active duration. | observed |
| `packages/opencode/src/permission/reviewer/service.ts:150-205,770-817,930-947` | Second SessionRetry caller; already bounded by a separate 90s/default outer attempt policy and intentionally has no visible Session Status. | reachable |
| `packages/opencode/src/effect/runtime-flags.ts:10-54` | Confirms EventV2 retry persistence is experimental, not the production visibility contract. | reachable |
| `packages/core/src/aisdk.ts:59-99` | v2/in-flight path already sends `timeout:false` to native/custom fetch; NetworkProxy pass-through repair benefits custom adapters without a v2 change. | reachable |
| `packages/opencode/test/session/llm.test.ts:127-269,372-598` | Existing real Provider test server and post-response SSE timeout seam. | observed |
| `packages/opencode/test/provider/provider.test.ts` | Existing public `Provider.getLanguage` seam and local-plugin fixtures can prove custom Provider transport init without source assertions. | observed |
| `packages/opencode/test/session/retry.test.ts:38-130,595-604` | Existing retry schedule and TimeoutError classification regressions; run unchanged to prove no retry-policy drift. | observed |
| `packages/opencode/test/session/processor-effect.test.ts:594-734` | Existing real Processor retry/recovery and Status integration seam; extend it with the actual RP-03 delayed-header producer while leaving retry production code unchanged. | observed/reachable |
| `node_modules/bun-types/globals.d.ts:1901-2019` | Stable Bun types expose BunFetchRequestInit but `1.3.14` does not type the runtime-supported timeout extension. | contracted |
| `bun --version`; `gh issue view 16682 --repo oven-sh/bun --json state,url`; `gh pr view 33647 --repo oven-sh/bun --json state,mergedAt,mergeCommit,url`; `gh api repos/oven-sh/bun/compare/bun-v1.3.14...3353737a126ed2eef736649a387a73d0a52acfbd` | Current runtime is `1.3.14+0d9b296af`; latest stable is 1.3.14; issue is closed; PR is merged; merged fix is 730 commits ahead. | observed/reproducible |

## 5. Current Behavior

```text
Session Prompt
  -> creates Assistant Message
  -> assembles tools/system/messages/context
  -> SessionProcessor.process
  -> LLM.stream (AI SDK maxRetries=0)
  -> Provider fetch wrapper
       -> overall AbortSignal deadline (default 600000 ms)
       -> chunk controller exists but no timer is armed yet
       -> direct path adds timeout:false
       -> custom path does not add timeout:false
  -> NetworkProxy.fetch / fetchWithRoute
       -> strips incoming timeout from init
       -> native Bun fetch inherits 300-second idle deadline
  -> first attempt raises TimeoutError near 245-286 seconds
  -> MessageV2 converts it to retryable APIError
  -> SessionRetry accepts the retryable error under its existing unbounded-attempt policy
  -> Session Status changes to retry and TUI displays countdown/attempt
  -> second request returns in 2.4-6.5 seconds
  -> first semantic feedback appears at 253.8-293.8 seconds
```

The Provider's `wrapSSE()` installs `chunkTimeout` only after `await fetch()`
has returned a Response. A request configured with `chunkTimeout=30000` can
therefore wait 245-286 seconds for headers/first body progress before the
configured no-progress policy exists.

The Windows and local databases are independent: zero overlapping Message IDs
and zero overlapping Session IDs in the inspected populations. Both contain a
discrete 240-330 second mode. Context stratification does not remove it.

Key observed user-facing metrics for the Windows snapshot:

| Metric | Value |
| --- | ---: |
| First semantic feedback | mean 10.009s, P95 21.090s, P99 53.386s |
| Tool end to next semantic feedback | mean 11.808s, P95 22.941s, P99 57.571s |
| Messages with first feedback >=60s | 233/29,009 |
| Loops with any >=60s Message | 127/3,626 |
| Long Messages whose pre-step phase is >=60s | 218/233 |
| Long Messages whose post-step phase is >=60s | 12/233 |

The local daemon trace contained six complete timeout-then-success chains. All
used `timeoutMs=600000` and `chunkTimeoutMs=30000`; the first attempt timed out
at 245196-285657 ms, while the second returned in 2384-6508 ms. Normal 749
responses had mean 4019.7 ms, P99 10662 ms, and maximum 23163 ms.

Existing relevant tests all pass despite the red A/B signal:

| Command | Result |
| --- | --- |
| `bun test test/network-proxy.test.ts` in `packages/core` | 3 pass, 0 fail |
| `bun test test/session/retry.test.ts` in `packages/opencode` | 45 pass, 0 fail |
| Selected Provider timing tests in `test/session/llm.test.ts` | 3 pass, 0 fail |

This confirms the current suite lacks the original transport/progress defect
signal. The retry tests are not deficient for R4: preserving their current
behavior is an explicit product requirement.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Bun `timeout:false` on a direct Provider request | Provider wrapper | Runtime-supported Bun option; disables Bun socket idle deadline | Provider -> NetworkProxy.fetch -> nativeFetch | NetworkProxy | observed |
| Bun timeout through explicit proxy route | NetworkProxy route resolver | Same Provider init must survive route selection | Provider -> NetworkProxy.fetch -> proxyFetch -> nativeFetch | NetworkProxy | reachable |
| Bun timeout through auth/URL-rewriting custom fetch | Codex/Copilot/Claude/Vertex custom fetch | Custom adapter preserves transport init and re-enters NetworkProxy | Provider -> fetchWithRoute -> custom fetch -> NetworkProxy.fetch | Provider + NetworkProxy pass-through seam | observed/reachable |
| No Response/first raw chunk before configured chunk timeout | Slow or stalled Provider | `chunkTimeout` is the no-raw-chunk progress contract | Provider wrapper awaiting fetch | Provider transport wrapper | observed |
| SSE stalls after one or more raw chunks | Streaming Provider | Existing wrapSSE resets an idle timer per body read | Response -> wrapSSE -> reader.read | Provider transport wrapper | observed |
| Bun/SSE TimeoutError in a user-visible Session | Provider wrapper | MessageV2 preserves retryable transport code | Processor -> SessionRetry | Existing SessionRetry policy; no new cap | observed/contracted |
| User cancellation during fetch/backoff | TUI/Session Run state | Existing abort signal must win over timeout/retry | Prompt/Processor -> LLM -> Provider | Existing cancellation path | contracted |
| Reviewer Provider timeout | Permission reviewer | Separate outer 90s/default attempt timeout and three-attempt reviewer workflow | Reviewer -> SessionRetry inside outer timeout | Permission reviewer | reachable |
| Large context | Session Prompt | Existing request construction and model quality must remain unchanged | Prompt -> Provider | Not a timeout repair owner | observed, below 1-sigma key-fix gate |
| Windows `reg.exe` proxy lookup | NetworkProxy on Windows | 1.5s helper timeout, 10s cache, `windowsHide` | resolveProxyRoute -> windowsProxy | NetworkProxy | reachable, not minute-scale |

Speculative Provider failover, duplicate hedging, model downgrade, and request
truncation are excluded because no current interface promises them and they
would create alternate success semantics or reduce response quality.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | NetworkProxy must preserve caller-supplied Bun transport options across direct, explicit-proxy, and custom-fetch routes while replacing only route-owned proxy selection. | A/B: direct `3.162σ`, explicit proxy `3.162σ`, custom pass-through `14.142σ`; Bun contract | No |
| INV-02 | The configured overall AbortSignal deadline must not be silently preempted by Bun's default socket idle deadline. | Bun issue/PR, real TimeoutError traces | No |
| INV-03 | `chunkTimeout` must govern no raw Provider progress from dispatch to first chunk and between subsequent SSE chunks; every received raw chunk resets the full window and gaps do not accumulate. | Explicit R5 user confirmation; six traces configured at 30s but failing at 245-286s; timeout-vs-normal `d=122.635` | Only post-response stall |
| INV-04 | Direct and custom Provider fetch paths must construct one identical transport policy before route selection. | Provider-seam direct/custom A/B `14.142σ`; Codex custom path | No |
| INV-05 | Every failure already classified as retryable by SessionRetry, including repeated transport timeout, 429, and transient 5xx, must retain the existing retry schedule without a new fixed attempt cap or automatic terminal prompt. User cancellation remains the control that stops autonomous execution. | Explicit user requirement; current policy and Status behavior | Existing retry/Processor tests |
| INV-06 | User abort must immediately interrupt fetch, progress timer, retry backoff, and any pending retry; timeout must remain distinguishable from user abort. | Existing cancellation contract and tests | Partial |
| INV-07 | Fast successful streams, Model/Provider selection, prompt/context, reasoning, Tool behavior, output quality, and ordinary text remain unchanged. | Explicit user constraint; existing LLM tests | Partial |
| INV-08 | Verification must use semantic output timing, not spinner, `start`, or empty lifecycle events, and only effects above one sigma qualify as key repairs. | Verbatim requirement; A/B reports | Experiment only |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-02 | `NetworkProxy.fetch()` and `fetchWithRoute()` destructure `timeout` into `_incomingTimeout` and omit it from the downstream init. | `packages/core/src/network-proxy.ts` routed transport interface | Red A/B: native 5/5 succeeds while direct routed 0/5; native explicit proxy 5/5 succeeds while routed explicit proxy 0/5; custom control 100/100 preserves while routed 0/100. |
| INV-03 | Provider creates a chunk controller at dispatch but arms chunk idle protection only inside `wrapSSE()` after `await fetch()` returns. | `packages/opencode/src/provider/provider.ts` Provider transport progress contract | Six configured 30s requests wait 245-286s before TimeoutError; normal max is 23.163s. |
| INV-04 | `timeout:false` is added only in the non-custom conditional branch; custom fetch is invoked without the same Bun transport policy. | `packages/opencode/src/provider/provider.ts` fetch wrapper before route selection | Provider-seam A/B: direct 100/100 carries `timeout:false`, custom 0/100, `14.142σ`; Codex/Copilot/Claude adapters make the branch reachable. |

Downstream symptoms are the five-minute TTFC peak, repeated Message silence, and
database timelines that show only the final successful semantic Part. TUI
rendering and Tool execution are not first divergences: 218/233 Windows long
Messages spend at least 60 seconds before step-start, while existing TUI retry
status is rendered only after the first timeout has already occurred.

### Red-capable feedback loop

Working directory:
`.temp/testing/provider-timeout-ab`

```sh
BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 bun network-proxy-timeout-ab.ts
```

Observed twice:

```text
native: 5/5 success, 6502-6509 ms
routed: 0/5 success, TimeoutError at 4003-4006 ms
risk difference: 1.0
two-proportion effect: 3.162 sigma
exit: 1 (red)
```

The server response delay and Bun idle deadline are scaled; the real
producer-to-consumer path and failure type are unchanged. The command becomes
green only when routed fetch preserves `timeout:false` and matches native
behavior.

Additional red probes:

```sh
BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 bun network-proxy-explicit-proxy-ab.ts # 3.162 sigma, exit 1
bun custom-fetch-init-ab.ts                                      # 14.142 sigma, exit 1
bun test provider-route-policy-ab.test.ts                        # 14.142 sigma, failing red
```

The explicit-proxy probe starts separate delayed local HTTP proxy servers for
the native control and routed treatment. It forces system proxy discovery at
the public NetworkProxy seam (`scutil` on macOS, `reg` on Windows, environment
proxy on Linux), uses a non-local target so bypass rules cannot select direct,
and observes native proxy dispatch rather than a mocked fetch. The current
routed arm fails 0/5 while the native proxy control succeeds 5/5.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Bun transport option preservation | NetworkProxy | Route requests without changing caller transport semantics | It is the first seam that transforms init and chooses direct/proxy/custom transport | Provider cannot repair options after NetworkProxy discards them |
| Uniform direct/custom transport policy | Provider fetch wrapper | Apply one Provider timeout policy before adapter selection | It owns configured Provider options and creates the per-attempt signal/controller | Auth adapters own authentication/URL rewriting, not timeout policy |
| First and subsequent raw-chunk progress deadline | Provider fetch wrapper | Enforce configured Provider progress timeout | It observes dispatch, Response, raw SSE reads, and abort controller | SessionProcessor sees only semantic stream events, too late for raw transport progress |
| Retry policy preservation | Existing SessionRetry + SessionProcessor | Continue every currently retryable failure and publish existing Status until success or user cancellation | The user explicitly requires no fixed cap; these modules already own and implement that contract | Provider transport must not absorb or narrow orchestration policy |
| Retry rendering | Existing TUI Status consumer | Display message, countdown, attempt, interrupt, elapsed duration | Already implemented and sufficient once timeout happens at the configured boundary | No new renderer or RetryPart path is needed |
| Bun upstream idle implementation | Bun runtime | Honor explicit Bun timeout in fixed versions | Upstream owns socket timers | OpenCode must still support current stable 1.3.14 and preserve options |

## 10. Single Approved Primary-Path Design

The one authoritative path is:

```text
Provider configuration
  -> construct one per-attempt transport init
       overall AbortSignal deadline
       progress AbortController armed at dispatch
       Bun timeout:false
  -> choose direct or custom adapter
  -> NetworkProxy preserves timeout and caller RequestInit fields
  -> NetworkProxy alone chooses direct/proxy route
  -> native Bun fetch
  -> first raw progress before chunkTimeout
       non-SSE Response: stop progress deadline
       SSE Response: retain the same deadline until first body chunk
  -> each SSE body chunk resets the same progress deadline
  -> semantic AI SDK stream
  -> success

If transport progress expires:
  -> abort with retryable TimeoutError, not user AbortError
  -> SessionRetry publishes existing retry Status
  -> existing classification and backoff continue without a new attempt cap
  -> user cancellation remains available and immediately interrupts the run
```

Key repair points, all above the user's evidence gate:

1. **RP-01, NetworkProxy transport integrity**: preserve the Bun `timeout`
   extension in direct, proxy, and custom pass-through init. The real transport
   A/B is `3.162σ` for direct and `3.162σ` for explicit proxy; custom
   pass-through is `14.142σ`.
2. **RP-02, uniform Provider route policy**: build `timeout:false` before the
   direct/custom branch so Codex and every custom adapter receive the same
   policy. This removes the reachable branch divergence rather than adding an
   adapter-specific workaround. The Provider-seam direct/custom A/B is
   `14.142σ` (100/100 versus 0/100).
3. **RP-03, continuous Provider progress deadline**: arm existing
   `chunkTimeout` at dispatch and carry it through first and subsequent raw SSE
   chunks. The observed timeout-vs-normal effect is `d=122.635`; the configured
   30s boundary is `15.096σ` above normal response mean and above the observed
   23.163s maximum.
These are stages of one Provider request path, not independent alternative
success algorithms. The plan does not add Provider fallback or duplicate
requests. It repairs the first divergences, applies the user's existing
`chunkTimeout=30000` at the phase it was intended to govern, and bounds each
silent transport attempt without terminating autonomous recovery, reducing
Model quality, or changing context.

### Progress deadline lifecycle

The Provider wrapper will own one per-attempt progress deadline object/state:

- Arm it immediately before outbound fetch.
- Abort through the existing per-attempt controller when no raw progress occurs
  within `chunkTimeoutMs`.
- Preserve caller/user abort as `AbortError`; progress expiry is `TimeoutError`.
- On fetch rejection, stop the timer before rethrowing.
- On non-SSE Response or absent body, stop the timer because the response is
  complete for this interface.
- On SSE Response, keep the original timer running until the first body chunk;
  reset it after every subsequent raw chunk.
- On end, cancellation, reader error, or outer abort, clear the timer and cancel
  the reader exactly once.

This avoids a two-timer gap or a reset at headers that could grant two full
timeout windows before the first byte.

### Retry preservation semantics

- Do not add a retry option, counter, termination condition, new error, or
  user prompt in `SessionRetry` or `SessionProcessor`.
- Preserve current retryable classification for transport timeout, 429, 5xx,
  provider overload, and every other currently accepted failure.
- Preserve existing exponential/backoff limits and visible retry Status.
- Preserve Permission reviewer's current use of the same policy inside its own
  independently owned workflow.
- User abort remains non-retryable and interrupts fetch, the progress deadline,
  and retry backoff.
- RP-03 changes one timeout attempt from a hidden 245-286 second transport stall
  to the already configured no-progress boundary; it does not reduce the number
  of recovery opportunities.
- The pre-response producer must use the already recognized
  `SSE_READ_TIMEOUT` transport code. A vertical Processor test must drive that
  real producer through `MessageV2.fromError`, SessionRetry, retry Status, and a
  successful second Provider attempt; a synthetic hand-constructed error is
  insufficient.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Direct Provider fetch | current/repaired | primary-contract branch | yes | primary | preserve and repair |
| Explicit HTTP/SOCKS proxy fetch | current/repaired | primary-contract branch | yes | primary | preserve and repair shared init |
| Custom auth/URL adapter fetch | current/repaired | contracted pass-through | yes | primary | preserve adapter transform; repair transport pass-through |
| Repeated retry of the same Provider operation after retryable failure | current/unchanged | primary-contract retry branch | yes | unchanged | preserve existing classification, backoff, Status, and user cancellation |
| Session Status retry rendering | current | diagnostic | no | unchanged, 0% new | preserve |
| Provider timing logs | current | diagnostic | no | unchanged, 0% new | preserve |
| Permission reviewer retry | current | existing independently owned workflow | yes | unchanged | preserve unchanged |
| Provider/model failover | proposed nowhere | forbidden fallback | yes | 0% | reject |
| Duplicate hedged request | proposed nowhere | forbidden alternate success path | yes | 0% | reject |
| Context/model quality reduction | proposed nowhere | forbidden requirement violation | yes | 0% | reject |

New alternate success paths: `0`.

New diagnostic decision-surface share: estimated `0%`; existing timing and
Status diagnostics are reused. The plan may update explanatory fields emitted
by existing logs only if no new outcome/branch is introduced.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Direct-branch-only `timeout:false` | Work around Bun #16682 | Policy must be constructed once before direct/custom selection | Move/collapse in `provider.ts` into common transport init |
| `_incomingTimeout` destructuring and discard | Avoid passing an untyped Bun extension | It defeats the Provider contract and current stable workaround | Remove discard in both `NetworkProxy.fetch` and `fetchWithRoute`; type the extension explicitly |
| Post-Response-only per-read timer creation | Protected later SSE chunks only | One continuous deadline must own dispatch through stream end | Collapse into one progress deadline lifecycle in `provider.ts` |

`timeout:false` itself is not deleted. It remains the deliberate Bun socket
idle policy while OpenCode's overall AbortSignal and progress deadline own
absolute/no-progress semantics. This works on current stable Bun and remains
valid after upstream #33647.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ read-only A/B only in `.temp/testing` | Diagnostic harnesses | No production change; retain `.temp/testing/provider-timeout-ab/*` | Re-run recorded commands; verify DB hash/mtime unchanged |
| REQ at least 3 significant repairs | RP-01 through RP-03 | All files below | A/B sigma reports plus vertical regression tests |
| INV-01, INV-02 | Provider -> NetworkProxy -> direct/proxy native fetch or custom adapter | `packages/core/src/network-proxy.ts` | Real delayed-server direct test; deterministic delayed local HTTP proxy test that forces explicit-proxy resolution and native proxy dispatch; custom init pass-through test |
| INV-03 | Provider dispatch -> first/subsequent raw chunk | `packages/opencode/src/provider/provider.ts` | LLM local server delays headers beyond configured chunkTimeout; post-chunk test remains green; Processor vertical test observes retry after the real expiry |
| INV-04 | Common init -> direct/custom branch | `packages/opencode/src/provider/provider.ts` | Public Provider/local-plugin test captures `timeout:false`; Provider-seam A/B is `14.142σ` |
| INV-05 | Real progress expiry -> MessageV2 -> SessionRetry -> Status -> second Provider attempt | No retry/processor production change; add vertical Processor regression only | First request delays headers past chunkTimeout, emitted production error is classified retryable, Status publishes attempt 1, second request succeeds |
| INV-06 | Abort propagation and cleanup | Provider progress lifecycle + existing signals | Existing service cancellation plus timeout-before-headers cleanup test distinguishes user abort from production timeout |
| INV-07 | Fast stream and quality preservation | Existing Provider/Prompt path unchanged | Existing fast text/reasoning/Tool stream tests; request body unchanged |
| INV-08 | Semantic user metric and >1σ gate | Experiment-only analysis | `db-significance.ts`, `loop-stage-analysis.ts`, `log-retry-analysis.ts` |

No confirmed requirement is unmapped.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Typed Bun timeout pass-through in RoutedInit | INV-01, INV-02 | Direct A/B 3.162σ, explicit-proxy A/B 3.162σ, custom 14.142σ | Current type omits timeout and implementation deliberately discards it |
| Common direct/custom transport init | INV-04 | Provider-seam A/B `14.142σ` and Codex incidents | Direct-only literal cannot affect custom adapter path |
| Per-attempt continuous progress deadline | INV-03, INV-06 | Six 30s-configured incidents at 245-286s, `d=122.635` | Current timer does not exist while awaiting Response |
| Accurate `chunkTimeout` configuration description | INV-03 | User requires first-chunk latency repair; current text describes only time between chunks | Existing annotation does not state dispatch-to-first-progress behavior |
| Provider/local-plugin common-policy test | INV-04 | Provider-seam A/B `14.142σ` | NetworkProxy pass-through tests cannot prove the Provider supplied the option |
| Processor first-progress retry test | INV-05, INV-06 | New pre-response error producer reaches existing shape-sensitive classifier | Synthetic retry tests cannot prove the actual AbortController/fetch rejection remains retryable |
| Integration tests at NetworkProxy and LLM seams | INV-01 through INV-07 | Existing tests all pass while original feedback loop is red | Existing tests cover adjacent behavior, not the defect chain |

No new configuration, schema, persistence model, UI state, Provider fallback,
cache, dependency, or generated artifact is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/core/src/network-proxy.ts` | modify | Type and preserve Bun timeout across direct/proxy/custom routes; continue stripping only route-owned incoming proxy/dispatcher/purpose | +8 / -8 |
| `packages/core/test/network-proxy.test.ts` | modify | Add custom pass-through, direct scaled idle-deadline, and deterministic explicit-proxy scaled idle-deadline behavior tests at public NetworkProxy seams | +90 / -0 |
| `packages/opencode/src/provider/provider.ts` | modify | Construct common transport init and replace post-Response-only timers with one continuous progress deadline | +35 / -20 |
| `packages/opencode/src/config/provider.ts` | modify | Clarify that `chunkTimeout` covers dispatch-to-first raw chunk and gaps between subsequent chunks; schema shape/default stay unchanged | +1 / -1 |
| `packages/opencode/test/session/llm.test.ts` | modify | Add delayed-headers first-progress timeout and cleanup slice; retain fast-path, post-chunk, and cancellation regressions | +55 / -2 |
| `packages/opencode/test/provider/provider.test.ts` | modify | Add a local-plugin custom-fetch test proving Provider supplies the common `timeout:false` policy at the public getLanguage/request seam | +40 / -0 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | Drive a real delayed-header progress expiry through MessageV2 classification, retry Status, and a successful second attempt without changing retry production code | +55 / -0 |

No file is added, deleted, generated, or migrated by implementation.

## 16. TDD Behavior Slices

Agreed public seams for this plan are `NetworkProxy.fetch/fetchWithRoute`,
`Provider.getLanguage` with a real local plugin, `LLM.Service.stream` through a
real local HTTP server, and `SessionProcessor.process` through TestLLMServer.
The Processor seam proves the production timeout error remains retryable; it
does not add or test a fixed retry cap. Tests do not inspect private helpers or
assert internal call order.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `fetchWithRoute` custom adapter receives caller `timeout:false` | NetworkProxy destructures and discards timeout | Preserve the typed Bun option in custom init | RP-01 custom route |
| 2 | Direct routed fetch with `timeout:false` survives beyond scaled Bun idle default just like native fetch | Direct NetworkProxy path discards timeout | Preserve option through direct native dispatch | Original direct red feedback loop |
| 3 | Explicit-proxy routed fetch with `timeout:false` survives a 6500ms delayed local HTTP proxy under `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1`, matching a native explicit-proxy control | Explicit-proxy is a separate reachable dispatch branch and currently discards timeout before `proxyFetch` | Start a real local proxy, force public route resolution by platform, use a non-local target, and preserve timeout through native proxy dispatch | RP-01 explicit-proxy branch and B-01 |
| 4 | A real local-plugin custom Provider fetch receives `timeout:false`, matching the direct Provider policy | Provider currently adds the option only after selecting the direct branch | Construct one init before branch selection and preserve it through the adapter | RP-02 and Provider-seam `14.142σ` |
| 5 | Configured `chunkTimeout` aborts a Provider that has not returned headers/first raw chunk | Timer is armed only after fetch returns | Arm one progress deadline at dispatch and retain through first chunk | RP-03 first-progress silence |
| 6 | The real first-progress expiry publishes retry Status and a second Provider attempt succeeds | A new pre-response abort can surface as AbortError or an unrecognized error unless the producer emits the existing transport code | Emit `SSE_READ_TIMEOUT` at Provider, pass it through MessageV2 and unchanged SessionRetry, observe attempt 1 and successful attempt 2 | B-02, INV-05 autonomous execution |
| 7 | Existing post-first-chunk stall still times out and fast stream remains unchanged | Refactor could accidentally clear/reset timer incorrectly | Reset same deadline per raw chunk; clear on terminal paths | Existing SSE behavior and quality |
| 8 | User abort before progress timeout produces AbortedError and no later timeout event | New timer could race cancellation | Preserve abort precedence and clear the one progress deadline | INV-06 |

Each slice follows red -> minimal green -> relevant regression rerun. No later
slice is implemented before the preceding one is green.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | 250 | Production and test executable lines; excludes imports, formatting, generated files, and pure moves |
| Required Chinese explanatory comments `C` | 38 | `ceil(250 * 0.15) = 38` |
| Planned qualifying Chinese comment lines | 44 | Distributed adjacent to production decisions and behavioral test intent |

Planned explanations:

- 4 lines near NetworkProxy type/pass-through explaining why Bun timeout is a
  transport contract while proxy/dispatcher remain route-owned.
- 7 lines around Provider progress lifecycle explaining the distinction among
  overall absolute deadline, first raw progress, and inter-chunk idle.
- 3 lines explaining why common init must precede custom/direct selection.
- 4 lines around cleanup explaining abort precedence and one-timer ownership.
- 15 distributed test-comment lines explaining the user-visible behavioral
  intent, independent timing thresholds, scaled Bun idle reproduction,
  explicit-proxy branch forcing and native dispatch, and preserved
  cancellation/retry contracts.
- 5 lines around the Provider/local-plugin test explaining why it begins above
  NetworkProxy and independently proves RP-02.
- 6 lines around the Processor vertical test explaining why the actual
  pre-response producer, classifier, Status, and successful retry must remain
  one observed behavior chain.

Comments that merely restate assignments, branches, test names, or expected
values do not count. The implementation audit must recalculate actual `E` and
`C`; this estimate is not permission to pad comments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 bun network-proxy-timeout-ab.ts` | `.temp/testing/provider-timeout-ab` | Original real transport A/B turns from exit 1 to exit 0 |
| `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 bun network-proxy-explicit-proxy-ab.ts` | `.temp/testing/provider-timeout-ab` | Explicit-proxy transport A/B turns from exit 1 to exit 0 |
| `bun custom-fetch-init-ab.ts` | `.temp/testing/provider-timeout-ab` | Custom timeout pass-through turns from exit 1 to exit 0 |
| `bun test provider-route-policy-ab.test.ts` | `.temp/testing/provider-timeout-ab` | Provider direct/custom policy A/B turns from failing red to 100/100 parity (`14.142σ` baseline effect) |
| `bun db-significance.ts` | `.temp/testing/provider-timeout-ab` | Reproduces >1σ cross-database evidence without writing DB |
| `bun loop-stage-analysis.ts <windows-db> <local-db>` | `.temp/testing/provider-timeout-ab` | Reproduces semantic/loop/stage metrics; historical values need not change |
| `bun log-retry-analysis.ts` | `.temp/testing/provider-timeout-ab` | Reproduces timeout -> retry -> success traces and configured deadlines |
| `gh issue view 16682 --repo oven-sh/bun --json state,url` and `gh pr view 33647 --repo oven-sh/bun --json state,mergedAt,mergeCommit,url` | repository root | Reproduces upstream issue/merge provenance without treating upstream as the OpenCode repair |
| `bun test test/network-proxy.test.ts` | `packages/core` | NetworkProxy direct/custom/proxy contract |
| `bun test test/session/llm.test.ts --test-name-pattern "provider response|SSE timeout|first provider progress|default overall"` | `packages/opencode` | Provider progress and existing SSE/fast behavior |
| `bun test test/provider/provider.test.ts --test-name-pattern "custom fetch transport policy"` | `packages/opencode` | RP-02 at the public Provider/local-plugin seam |
| `bun test test/session/retry.test.ts` | `packages/opencode` | Existing retryable classification and no-fixed-attempt policy remain unchanged |
| `bun test test/session/processor-effect.test.ts --test-name-pattern "retry|first progress timeout|transport timeout"` | `packages/opencode` | Actual RP-03 producer is classified retryable, publishes Status, and succeeds on the second attempt without a fixed cap |
| `bun test test/network-proxy.test.ts` followed by `bun typecheck` | `packages/core` | Core behavior and type safety |
| `bun test test/session/llm.test.ts test/provider/provider.test.ts test/session/retry.test.ts test/session/processor-effect.test.ts` followed by `bun typecheck` | `packages/opencode` | Provider repair, vertical retry-preservation regressions, and type safety |
| `bun test` | `packages/core` | Core regression suite |
| `bun test` | `packages/opencode` | Package regression suite |
| `shasum -a 256 opencode.db` and `stat` | `.temp/testing` | Windows DB remains exact SHA/size/mtime |

Expected immutable Windows identity after verification:

```text
SHA-256 f1de09a0b69e5b1014c7b3a932f663838da01dee215d4df0c320260c20416da4
size 2164944896
mtime 2026-07-15T03:02:54+0800
```

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 0 | Reuse existing owners and test seams |
| Files modified | 7 | Three production contract/owner files and four matching vertical/public-seam test files |
| Files deleted | 0 | No separate obsolete module exists |
| Production lines | ~45 effective lines | Option pass-through, common transport policy, one progress lifecycle, and one contract-description update |
| Test lines | ~205 effective lines | Direct/explicit-proxy network, Provider policy, LLM progress/cancellation, and Processor retry-chain slices |
| Generated lines | 0 | No public config/schema change |
| Migrations | 0 | No persistence change |

The budget is an audit signal. Confirmed behavior must not be removed to hit the
estimate, and unrelated refactoring must not be added.

## 20. Real Risks and Open Decisions

### Real Risks

- **Abort-reason preservation**: Bun/custom adapters may wrap an
  AbortController reason. Tests must prove progress expiry remains retryable
  TimeoutError while user cancellation remains non-retryable AbortedError.
- **Timer cleanup**: one timer spans fetch and stream. Fetch error, non-SSE
  response, stream end, reader failure, cancellation, and outer abort are all
  reachable terminal paths and must clear it exactly once.
- **Custom adapter parity**: Codex, Copilot, Claude, and Vertex spread init then
  call NetworkProxy. The common policy must survive all without moving auth/URL
  responsibility into NetworkProxy.
- **Proxy path**: direct and proxy branches share the same transformed init;
  proxy selection must still override caller-supplied proxy while preserving
  timeout. The regression test must force a non-local target through a real
  delayed local HTTP proxy and platform-specific public route discovery; a
  mocked fetch or direct-route assertion cannot satisfy this branch.
- **Retry preservation**: any fixed cap or new terminal prompt would degrade
  autonomous execution and violate the explicit requirement. Retry,
  Processor, reviewer, and Status code must remain untouched and their existing
  suites must stay green.
- **Partial streams**: post-first-chunk timeout and subsequent retry are existing
  behavior. The repair does not invent replay merging or Provider failover and
  does not narrow repeated retry.
- **Current Bun types**: runtime supports timeout but 1.3.14 types omit it. The
  local RoutedInit extension must be explicit and narrow rather than use `any`
  or `@ts-ignore`.

### Open Decisions Requiring the User

None. The plan does not change default timeout values, Model quality, context,
Provider selection, billing semantics, or visible retry representation. It
restores configured behavior while preserving every current automatic retry
opportunity until success or user cancellation.

### Rejected Speculation

- **Context optimization as a key repair**: rejected. Cohen's `d` is 0.217 on
  Windows and 0.066 locally, below the user's one-sigma gate. Context remains a
  baseline factor but does not explain the discrete timeout mode.
- **Windows `reg.exe` lookup as minute-scale cause**: rejected. Its hard timeout
  is 1.5s and route results are cached for 10s.
- **TUI batching/rendering as cause**: rejected. Long waits occur before
  step-start; retry UI already renders Status immediately after classification.
- **Upgrade Bun only**: rejected as incomplete. Stable 1.3.14 lacks the fix,
  and OpenCode currently discards the explicit option even if runtime support
  improves.
- **Provider/model failover or hedging**: rejected. No product contract permits
  duplicate billing, changed Model quality, or alternate Provider success.
- **Persist RetryPart or add migration**: rejected for this repair. Existing
  Status provides live UX, EventV2 persistence is experimental, and persistence
  is not the first divergence.
- **Fixed timeout retry cap / RP-04**: rejected from R3 onward by explicit user
  instruction. Stopping an autonomous Session after a fixed attempt count and
  surfacing a terminal error/prompt is a user-visible degradation; the repair
  instead shortens each silent no-progress attempt at its transport owner.
- **Change default chunkTimeout from 180s**: rejected in R4. The observed user
  configuration already requests 30s; applying the existing contract at the
  correct phase fixes that defect without introducing an unvalidated global
  product threshold.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the
  cross-platform/A-B significance gate, user-experience preservation, and the
  15 percent Chinese explanatory-comment plan.
- Reject any route that merely extends silent waiting, lowers Model/output
  quality, adds Provider failover/hedging, or treats lifecycle UI as semantic
  first feedback.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01 Explicit-proxy transport branch lacks a behavioral test` | 2 | `BLOCK` | `ses_09dc0a7e3ffeIZjmEjTKmG6csI` |
| 2 | R2 | yes | `No blocking findings.` | 3 | `APPROVE` | `ses_09db72cc6ffeoXtuEwXR6F2dR3` |
| 3 | R3 | yes | `B-01 RP-02 lacks the required greater-than-one-sigma evidence`; `B-02 The new pre-response timeout is not vertically verified as retryable` | 2 | `BLOCK` | `ses_09d9a39e1ffeZK5YnZSwlFNBec` |
| 4 | R4 | yes | `B-01 RP-03 silently repurposes chunkTimeout and preempts the existing overall request deadline` | 1 | `BLOCK` | `ses_09d8dfe43ffev6qk6DwauPEgZs` |
| 5 | R5 | yes | `No blocking findings.` | 4 | `APPROVE` | `ses_09c155f90ffeLWfGQs4SjkLdXi` |

### Round 1 independent verdict (verbatim)

#### Blocking findings

##### B-01 Explicit-proxy transport branch lacks a behavioral test

- **Violated invariant:** `INV-01` requires NetworkProxy to preserve caller-supplied Bun transport options across **direct, explicit-proxy, and custom-fetch routes**.
- **Evidence class:** observed
- **Producer and execution path:** A Provider or plugin supplies `timeout: false` to `NetworkProxy.fetch`; `NetworkProxy.fetch` strips route-owned fields, resolves a proxy route, and dispatches either the direct branch or the explicit-proxy branch. The explicit-proxy branch reaches `proxyFetch`, which calls native Bun fetch with the transformed init.
- **Source evidence:**
  - `packages/core/src/network-proxy.ts:244-260` — `fetch()` destructures and removes `timeout`, then dispatches to either `directFetch` or `proxyFetch`.
  - `packages/core/src/network-proxy.ts:283-287` — explicit-proxy dispatch is a distinct production branch.
  - `packages/core/test/network-proxy.test.ts:15-59` — existing tests cover global-fetch isolation and the native/direct path, but no explicit-proxy transport-option propagation test exists.
- **Canonical-plan evidence:**
  - Section 7, `INV-01` explicitly includes direct, explicit-proxy, and custom-fetch routes.
  - Section 13 maps `INV-01` to “real delayed-server routed/native test; custom init pass-through test,” without a concrete explicit-proxy test.
  - Section 16, TDD slices 1-2, specifies custom and routed/native coverage but does not require forcing and observing the explicit-proxy branch.
- **Responsibility owner:** `NetworkProxy`, specifically the shared init transformation and `proxyFetch` seam.
- **Behavior-level consequence:** The plan can turn the direct and custom A/B probes green while still dropping `timeout: false` or otherwise changing the transport contract on requests that actually use an explicit HTTP/SOCKS proxy. This leaves one of the explicitly required production routes unverified and allows the Windows/macOS proxy path to retain the original multi-minute Bun idle-timeout defect.
- **Why this is not speculative:** The explicit-proxy branch is reachable by `resolveProxyRoute()` and is a separate implementation path in the current source. The invariant expressly names it, while the proposed test mapping does not exercise it.
- **Minimal correction direction:** Extend the canonical plan’s NetworkProxy behavioral coverage so a test deterministically enters the explicit-proxy branch and verifies the caller’s Bun transport option survives through native proxy dispatch, without introducing a second transport implementation or fallback.

#### Non-blocking findings

1. The plan states that Bun issue/PR evidence establishes the stable-runtime behavior, but the canonical plan does not include a URL, captured upstream excerpt, or reproducible command for that external evidence. The local A/B harness independently demonstrates the relevant behavior, so this does not block approval, but the provenance would be easier to audit if recorded explicitly.

2. The plan’s “all six timeout attempts recovered on the first retry” evidence is based on log parsing rather than a controlled production replay. It is adequate to justify the proposed one-retry hypothesis under the user’s evidence gate, but it should not be treated as proof that one retry is optimal for every Provider or partial-stream condition.

#### Release verdict

**BLOCK**

The audited canonical revision is `R1`. It cannot be approved because `INV-01` explicitly covers the explicit-proxy NetworkProxy path, while the proposed behavioral test plan does not exercise that reachable production branch.

R2 resolves `B-01` by adding a red-capable explicit-proxy A/B (`3.162σ`), a
deterministic public-seam test slice that forces explicit-proxy route discovery
and real native proxy dispatch, forward/reverse traceability, verification, and
the corresponding test/comment budget. R1 remains unapproved.

### Round 2 independent verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

1. The plan cites Bun issue `#16682` and PR `#33647` as upstream provenance, but the canonical plan does not include the relevant upstream excerpts or a locally captured response. The local A/B experiments independently demonstrate the transport behavior, so this does not block approval.

2. The one-retry choice is supported by six observed timeout-then-success traces and the deterministic unbounded-retry probe, but those traces do not establish that one retry is optimal for every Provider or partial-stream condition. The plan correctly records this limitation and does not present the value as a universal statistical optimum.

3. The explicit-proxy A/B harness forces platform proxy discovery through the public seam and performs real native proxy dispatch, but the inspected run evidence is platform-dependent. The shared post-resolution transport defect is sufficiently evidenced by the direct/custom A/B results and the Windows database correlation; a separately executed Windows runtime run would improve confidence but is not required to establish the planned owner or first divergence.

#### Release verdict

**APPROVE**

This verdict applies only to canonical plan revision `R2`. The plan is suitable for the requested `<approved-plan-only>` terminal state. Implementation remains prohibited until the administrative approval metadata records this exact clean audit result, and any later substantive plan change requires a new full-scope audit.

R3 invalidates R2 approval because the user explicitly rejected RP-04 and
changed the terminal state to `verified-implementation-and-commit`. R3 removes
the retry cap concept, all retry/Processor production and test modifications,
and the retry-budget green gate; it adds INV-05 to preserve existing autonomous
retry behavior and awaits a new full-scope audit.

### Round 3 independent verdict (verbatim)

#### Blocking findings

##### B-01 RP-02 lacks the required greater-than-one-sigma evidence

- Violated invariant: The verbatim requirement excludes repair points whose significance is not greater than `1σ`; `INV-08` repeats that gate, and the plan claims all three key repair points satisfy it.
- Evidence class: contracted
- Producer and execution path: The Provider wrapper receives the SDK request init, selects either the custom-fetch or direct branch, and currently adds `timeout:false` only to the direct branch. Custom adapters subsequently delegate through `NetworkProxy.fetchWithRoute` and `NetworkProxy.fetch`.
- Source evidence:
  - `packages/opencode/src/provider/provider.ts:1912-1919` — the direct branch adds `timeout:false`, while the custom-fetch branch does not.
  - `packages/opencode/src/plugin/codex.ts:423-504` — Codex is a reachable custom adapter that forwards init through `NetworkProxy`.
  - `.temp/testing/provider-timeout-ab/custom-fetch-init-ab.ts:4-18` — the `14.142σ` experiment supplies `timeout:false` itself and measures only whether `NetworkProxy.fetchWithRoute` preserves it. It never exercises the Provider branch that RP-02 changes.
  - `.temp/testing/provider-timeout-ab/network-proxy-timeout-ab.ts:29-35` — the direct `3.162σ` experiment likewise supplies `timeout:false` before entering `NetworkProxy`.
- Canonical-plan evidence:
  - Section 10, lines 299-314 claims RP-01 through RP-03 are all above the evidence gate, but RP-02 at lines 305-308 has no independent effect measurement.
  - Section 14, line 410 justifies RP-02 with branch reachability and Codex incidents, not a greater-than-`1σ` A/B result.
  - Section 16, lines 440-442 assigns all measured timeout-preservation experiments to RP-01; none begins at the Provider direct/custom policy seam.
- Responsibility owner: `packages/opencode/src/provider/provider.ts`, at the common transport-init construction before direct/custom route selection.
- Behavior-level consequence: R3 counts RP-02 as the third required key repair even though its cited `14.142σ` result measures RP-01’s NetworkProxy pass-through responsibility. The plan therefore has only two evidence-qualified repair points—RP-01 and RP-03—under the user’s explicit “at least three” and greater-than-`1σ` constraint.
- Why this is not speculative: The direct/custom divergence exists in current source and the actual A/B harness inputs prove that the reported custom-fetch sigma does not test that divergence.
- Minimal correction direction: Give RP-02 its own greater-than-`1σ`, red-capable evidence at the Provider direct/custom policy seam, or stop counting RP-02 toward the three-key-repair requirement and supply another independently evidence-qualified repair point.

##### B-02 The new pre-response timeout is not vertically verified as retryable

- Violated invariant: `INV-05` requires every transport progress timeout introduced by RP-03 to retain autonomous retry behavior, while `INV-06` requires timeout expiry to remain distinguishable from user cancellation.
- Evidence class: reachable
- Producer and execution path: The proposed Provider progress deadline aborts the per-attempt controller before `fetch()` returns; that rejection flows through `LLM.Service.stream`, `SessionProcessor`’s `MessageV2.fromError` parser, `SessionRetry.retry`, and finally the visible retry Status.
- Source evidence:
  - `packages/opencode/src/provider/provider.ts:127-172` — the existing post-response SSE timeout constructs a specific `"SSE read timed out"`/`SSE_READ_TIMEOUT` error; no pre-response progress-timeout producer currently exists.
  - `packages/opencode/src/session/message-v2.ts:1349-1385` — retry versus cancellation depends on the actual emitted error shape and the `aborted` context.
  - `packages/opencode/src/session/message-v2.ts:1551-1569` — transport classification recognizes only specific codes, `name === "TimeoutError"`, or the exact SSE timeout message.
  - `packages/opencode/src/session/processor.ts:205-209,1060-1088` — the generated error must survive parsing before `SessionRetry` can publish retry Status.
  - `packages/opencode/test/session/retry.test.ts:556-565,595-604` — existing tests classify hand-constructed SSE and `TimeoutError` values; they do not prove that RP-03’s actual controller/fetch rejection has either shape.
  - `packages/opencode/test/session/llm.test.ts:449-513` — existing integration coverage only exercises a post-response SSE stall.
- Canonical-plan evidence:
  - Section 10, lines 292-296 requires progress expiry to become a retryable timeout.
  - Section 10, lines 323-335 requires timeout/user-abort distinction but does not lock the concrete generated error through the consumer chain.
  - Section 13, lines 398-400 maps retry preservation to unchanged synthetic retry tests and maps timeout cleanup only to a Provider-level test.
  - Section 16, line 443 requires the delayed-header test merely to observe an abort; line 446 relies on existing retry suites rather than passing RP-03’s actual error through `MessageV2` and `SessionRetry`.
- Responsibility owner: Provider owns creation of the progress-timeout error; `MessageV2` owns its transport classification; `SessionProcessor`/`SessionRetry` own the resulting retry transition.
- Behavior-level consequence: An implementation could satisfy the planned delayed-header rejection and cleanup tests while Bun or the controller exposes the rejection as `AbortError` or another unrecognized shape. `MessageV2` would then classify it as cancellation or non-retryable failure, terminating the Session instead of preserving autonomous execution—exactly the user-experience regression R3 is intended to prohibit.
- Why this is not speculative: RP-03 necessarily introduces a new reachable error producer before `fetch()` returns, and current classification demonstrably depends on concrete error name/code/message. Existing tests instantiate expected error shapes independently rather than observing the new producer.
- Minimal correction direction: Require a red-capable vertical behavioral test that drives the real RP-03 first-progress expiry through the production parsing/retry seam and observes retryable API classification and retry Status, paired with the existing requirement that a real user abort remains non-retryable.

#### Non-blocking findings

1. Section 17 reports 30 planned qualifying Chinese explanatory-comment lines, while its listed allocations total 33 (`4 + 7 + 3 + 4 + 15`). Both exceed the required 24, so this does not fail the planning gate, but the estimate should be internally consistent.
2. Metadata says `Audit mode: full-scope` rather than `plan`. The artifact is otherwise clearly a plan at `audit-required`, with `Approved revision: none` and `Implementation allowed: no`, so this does not alter the current release decision.

#### Release verdict

**BLOCK**

Canonical plan revision **R3** cannot be approved. It must resolve B-01 and B-02 and then receive another full-scope plan audit before implementation is allowed.

R4 resolves B-01 with a newly executed Provider-seam A/B: the real direct
Provider branch supplied `timeout:false` 100/100 times while the real custom
Provider branch supplied it 0/100 times (`14.142σ`). R4 resolves B-02 by adding
a Processor vertical test that begins with a real delayed-header RP-03 expiry
and must observe MessageV2 retry classification, retry Status attempt 1, and a
successful second Provider attempt. It also aligns `Audit mode: plan` and the
Chinese-comment allocation total. R3 remains unapproved.

### Round 4 independent verdict (verbatim)

#### Blocking findings

##### B-01 RP-03 silently repurposes `chunkTimeout` and preempts the existing overall request deadline

- **Violated invariant:** Provider requests that remain within the configured overall `timeout` must not be aborted by a different deadline outside that deadline’s existing contract. The current public contract defines `chunkTimeout` as the interval **between streamed SSE chunks**, while the explicit user requirement forbids user-experience degradation. R4 instead makes `chunkTimeout` cover dispatch-to-response/first-byte time, so the default 180-second chunk deadline can preempt the default 600-second request deadline.
- **Evidence class:** contracted
- **Producer and execution path:** Provider configuration produces `timeout` and `chunkTimeout` → `Provider.getLanguage()` installs the Provider fetch wrapper → the current wrapper combines caller cancellation with the overall `AbortSignal.timeout()` → `await fetch()` obtains the response → only an SSE response enters `wrapSSE()` and receives the between-chunk timer. R4 proposes arming the chunk timer before outbound fetch, causing requests with no headers before `chunkTimeout`—but still inside `timeout`—to be aborted and retried.
- **Source evidence:**
  - `packages/opencode/src/config/provider.ts:102-110` — `timeout` is the request timeout, defaulting to 600000 ms.
  - `packages/opencode/src/config/provider.ts:111-114` — `chunkTimeout` is explicitly defined as the time “between streamed SSE chunks.”
  - `packages/opencode/src/provider/provider.ts:127-155` — the current timer belongs to an SSE body `reader.read()` and therefore enforces the documented inter-chunk contract.
  - `packages/opencode/src/provider/provider.ts:1845-1863` — Provider reads `chunkTimeout` separately and constructs the overall request timeout signal.
  - `packages/opencode/src/provider/provider.ts:1912-1933` — `fetch()` currently completes before `wrapSSE()` applies the chunk timer.
- **Canonical-plan evidence:**
  - Section 2, lines 49-50 promises not to change the existing default `chunkTimeout=180000` or `timeout=600000` contracts.
  - `INV-02`, line 202 requires the configured overall deadline not to be silently preempted.
  - `INV-03`, line 203 expands `chunkTimeout` from the existing inter-SSE-chunk contract to dispatch-to-first-chunk behavior.
  - Section 10, lines 282-291 and 325-342 proposes arming the 180-second/explicit chunk deadline at dispatch.
  - Reverse traceability, line 421 acknowledges that the current configuration text describes only time between chunks and plans to rewrite that public contract.
  - File plan, lines 435-438 changes both production behavior and the configuration description to make the new interpretation appear authoritative.
- **Responsibility owner:** `packages/opencode/src/provider/provider.ts` owns Provider request deadlines; `packages/opencode/src/config/provider.ts` owns their public configuration contract.
- **Behavior-level consequence:** R4 changes the supported success domain. Under the current contract, a Provider response arriving after 180 seconds but before the 600-second overall deadline has not violated `chunkTimeout`, because no SSE stream exists yet. Under R4 it is forcibly aborted and retried. For an explicitly configured 30-second `chunkTimeout`, the same semantic reduction occurs after 30 seconds. This can discard an in-progress valid Provider request, repeat work or billing, and delay eventual semantic output, directly conflicting with “不能以牺牲用户体感为代价.”
- **Why this is not speculative:** The finding does not depend on proving that a particular future Provider takes 181 seconds. The accepted configuration schema explicitly contracts two different deadlines and their scopes, while R4 expressly changes that scope and makes the shorter deadline preempt the longer one. Contract narrowing is itself sufficient evidence. The recorded 30-second incidents establish a severe no-progress problem, but they do not establish that `chunkTimeout` already owns the pre-response phase or authorize changing its public meaning.
- **Minimal correction direction:** Keep the pre-response repair within the authoritative Provider request-timeout contract rather than silently redefining the SSE inter-chunk setting. R4 must either preserve the existing `timeout`/`chunkTimeout` phase boundaries or establish an explicit, evidence-backed and user-authorized first-progress contract that does not contradict the no-degradation requirement. The plan must then remap RP-03, its significance evidence, and its behavioral tests to that corrected owner and contract; merely rewriting the configuration description is not sufficient.

#### Non-blocking findings

1. `.temp/testing/provider-timeout-ab/RESULTS.md:123-133` still describes a “planned user-visible Session contract of one transport retry,” although the user explicitly deleted RP-04 and R4 preserves unbounded retryable attempts. R4 correctly marks that probe as historical and excludes it from green verification, so this stale diagnostic wording is not implementation authority, but it should not be presented as the current planned contract.

#### Release verdict

**BLOCK**

Canonical plan revision **R4** cannot be approved. B-01 changes the primary Provider timeout contract in a way that can preempt currently valid requests and therefore conflicts with both the existing public schema and the explicit no-user-experience-degradation requirement.

A substantive correction must increment the plan revision, clear approval, and receive another full-scope plan audit.

R5 applies the user's explicit authorization to the existing `chunkTimeout`
setting rather than introducing a new entity: the numeric defaults remain
unchanged, the no-progress window starts at dispatch, and each raw chunk resets
the full window. The overall `timeout` remains the absolute request deadline.
R5 does not add a retry cap or terminal prompt.

### Round 5 independent verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

1. **External Bun provenance remains less independently reproducible than the local A/B evidence.** The plan cites Bun issue `#16682` and PR `#33647`, but does not include captured upstream excerpts or a locally archived response. The local transport A/B experiments independently establish the relevant behavior, so this does not block approval.
2. **The retry-budget probe contains stale historical wording.** `.temp/testing/provider-timeout-ab/RESULTS.md:123-133` describes a historical “one transport retry” expectation even though RP-04 was explicitly removed and R5 preserves the existing unbounded retryable-attempt policy. The plan correctly classifies that probe as historical rather than a release gate, so this is documentation drift only.
3. **The explicit-proxy experiment is platform-dependent.** The plan requires real platform proxy discovery and native proxy dispatch. The inspected evidence is sufficient to establish the shared transport-option loss, but a separately reproduced Windows-runtime run would improve confidence in Windows-specific behavior.
4. **The plan relies on a substantial integration-test expansion.** The current repository tests do not yet prove the full first-progress timeout chain. The plan explicitly requires red-capable tests through the real Provider, MessageV2, SessionRetry, Status, and successful second attempt seams. Approval is conditional on those exact tests being implemented and passing; the plan itself does not claim that implementation evidence already exists.

#### Rejected speculation

- Context-size optimization is not a qualifying primary repair: the recorded Windows and local effect sizes are below the stated one-sigma gate.
- Windows `reg.exe` proxy discovery is not a demonstrated minute-scale cause because its helper timeout is bounded at 1.5 seconds and results are cached for 10 seconds.
- TUI rendering and lifecycle events are not the first divergence; the database stage analysis places the dominant delay before `step-start` and before visible semantic feedback.
- Provider/model failover, duplicate hedging, model downgrade, prompt truncation, and output-quality reductions are unsupported alternate-success or degradation paths.
- A fixed retry cap or terminal prompt is correctly rejected because the user explicitly removed RP-04 and required preservation of autonomous retry behavior.
- A Bun-only upgrade is insufficient because the current stable runtime still requires OpenCode to preserve the explicit transport option.
- New persistence, migration, RetryPart, SDK, configuration entities, or retry schema are not justified by the current evidence and are correctly excluded.

#### Release verdict

**APPROVE**

This approval applies only to canonical plan revision **R5** at:

`/Users/sunbenteng/Project/opencode/docs/plans/provider-timeout-transport-integrity.md`

The plan is suitable for administrative transition to:

```text
Status: approved
Revision: R5
Approved revision: R5
Implementation allowed: yes
```

Implementation remains subject to the exact approved revision, red-to-green
verification, package tests, typechecks, database immutability checks, and a
subsequent independent full-scope implementation audit.

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Implementation follows the exact approved R5 route. No production change adds a
retry cap, alternate success path, Provider failover, hedging, output reduction,
new timeout entity, migration, SDK change, or persistence change.

### Actual Files and Diff

The implementation changed only these approved files:

| File | Added | Removed | Responsibility |
| --- | ---: | ---: | --- |
| `packages/core/src/network-proxy.ts` | 4 | 5 | Preserve `timeout` while removing only route-owned fields. |
| `packages/core/test/network-proxy.test.ts` | 94 | 0 | Custom, direct native, and explicit-proxy transport behavior. |
| `packages/opencode/src/config/provider.ts` | 1 | 1 | Document the user-authorized continuous `chunkTimeout` phases. |
| `packages/opencode/src/provider/provider.ts` | 155 | 77 | Common transport policy and dispatch-to-raw-progress deadline lifecycle. |
| `packages/opencode/test/provider/provider.test.ts` | 77 | 0 | Real custom Provider SDK route policy behavior. |
| `packages/opencode/test/session/llm.test.ts` | 185 | 73 | Delayed headers, post-response stall, cancellation-before-progress, and non-cumulative paced chunks. |
| `packages/opencode/test/session/processor-effect.test.ts` | 103 | 11 | Real timeout producer through MessageV2/retry Status/successful retry. |

The seven-file diff is `619` added and `167` removed lines. Existing unrelated
worktree changes remain excluded: `bun.lock`, `docs/workflow.md`, the snapshot,
voice test, third-party submodule, unrelated plan, and all experiment artifacts.

### Red-Green Test Evidence

- `network-proxy-timeout-ab.ts`: red native `5/5` versus routed `0/5`,
  `3.162 sigma`; post-repair native `5/5` and routed `5/5`, risk difference `0`.
- `network-proxy-explicit-proxy-ab.ts`: red native proxy `5/5` versus routed
  `0/5`, `3.162 sigma`; post-repair both `5/5`, risk difference `0`.
- `custom-fetch-init-ab.ts`: red control `100/100` versus routed `0/100`,
  `14.142 sigma`; post-repair both `100/100`, risk difference `0`.
- `provider-route-policy-ab.test.ts`: red direct Provider `100/100` versus
  custom Provider `0/100`, `14.142 sigma`; post-repair test passed with one
  common policy before route selection.
- Delayed-header LLM test first failed when it expected the low-level stream to
  reject; it was corrected to assert the actual owner boundary: request abort,
  `sse.timeout`, `chunkCount=0`, and configured `chunkTimeoutMs=25`.
- Processor vertical test was red when `deadline.start()` was temporarily
  disabled (`attempt` was `undefined`), then green with the approved lifecycle:
  real first-progress timeout, `SSE_READ_TIMEOUT`/`SSE read timed out`, retry
  Status attempt `1`, and a successful second Provider request.
- The cancellation slice was red under a cleanup mutation that removed both the
  combined-signal `deadline.stop` listener and fetch-error cleanup: the test
  observed a later `sse.timeout`. Restoring both approved cleanup paths made the
  same test green with `21 pass`.
- Paced raw chunks remained green while total stream duration exceeded the
  timeout because each inter-chunk gap stayed below the configured window.
- `retry-budget-feedback.ts` remains intentionally red with `100/100` accepted
  retries and `stopped=false`; this verifies RP-04 was not introduced.

### Verification Commands and Results

- `packages/core`: `bun test test/network-proxy.test.ts` -> `6 pass`, `0 fail`.
- `packages/core`: full suite -> `358 pass`, `0 fail`.
- `packages/core`: `bun typecheck` -> pass.
- `packages/opencode`: `bun test test/provider/provider.test.ts` -> `89 pass`,
  `0 fail`.
- `packages/opencode`: `bun test test/session/llm.test.ts` -> `21 pass`, `0 fail`.
- `packages/opencode`: isolated
  `bun test test/session/processor-effect.test.ts` -> `19 pass`, `0 fail`.
- `packages/opencode`: retry suite -> `45 pass`, `0 fail`.
- `packages/opencode`: `bun typecheck` -> pass.
- `packages/opencode`: `bun run build` -> pass; Darwin arm64 smoke test passed.
- `git diff --check` for all seven changed files -> pass.
- Final Windows DB identity remained SHA-256
  `f1de09a0b69e5b1014c7b3a932f663838da01dee215d4df0c320260c20416da4`, size
  `2164944896`, mtime `2026-07-15T03:02:54+0800`; `PRAGMA quick_check=ok`.

The package-wide `packages/opencode` suite did not finish within 300 seconds;
the excluded run involved unrelated fixture disposal, watcher, PTY, and MCP
tests. The changed Provider/LLM/Processor files and all relevant package-local
checks passed. One Processor-file run had a parallel 5-second fixture timeout;
the isolated rerun passed all `19` tests.

### Original Feedback-Loop Result

The original red loop reproduced the same transport defect twice: native `5/5`
success and routed `0/5` success under `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1`. The
approved primary-path repair changed the loop to native `5/5` and routed `5/5`
success, including explicit-proxy routing, while preserving custom-fetch
`timeout:false` pass-through.

### Actual Secondary and Replacement Path Inventory

- NetworkProxy remains the sole owner of route-owned field stripping and native
  direct/explicit-proxy dispatch.
- Provider remains the sole owner of common transport init and continuous raw
  progress deadline lifecycle.
- `MessageV2`, `SessionProcessor`, `SessionRetry`, Status, and Permission
  reviewer production behavior was not replaced or duplicated.
- No catch-and-success, fallback, duplicate request, Provider switch, retry cap,
  terminal prompt, or alternate error classification was added.
- The existing `SSE_READ_TIMEOUT` code/message contract is reused so the new
  pre-response producer enters the existing retryable transport mapping.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | `619` conservative upper bound | Raw added lines for the seven-file diff; import-only, formatter-only, generated, and pure-move lines are not deducted from this upper bound, so actual effective `E` cannot be larger. |
| Qualifying Chinese comment lines `C` | `94` | Adjacent to timer ownership, abort/error classification, route contracts, cancellation cleanup, and behavior-test boundaries; no debug or temporary comments. |
| Ratio `C / E` | `15.19%` conservative minimum | `94 / 619`; actual ratio is no lower after required exclusions. |
| Required minimum `C` | `93` | `ceil(619 × 0.15)`. |

### Remaining Unverified Items

- Independent full-scope implementation audit of the exact R5 diff is still
  required.
- A separate Windows-runtime explicit-proxy execution would improve platform
  confidence, but the shared transport-option loss is already established by
  the local A/B and immutable Windows database evidence.
- The package-wide opencode suite remains incomplete because of unrelated
  timeout behavior described above; no changed-file test failed in isolation.
- Commit remains pending until the independent implementation audit returns
  `No blocking findings` and `APPROVE`.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | `B-01 Approved R5 TDD slice 8 is not implemented or behavior-sensitive`; `B-02 The implementation diff contains unrelated formatter/refactor hunks outside the approved R5 responsibilities` | 4 | `BLOCK` | `ses_09be08538ffeUzqQOaCotcJMrb` |
| 2 | R5 | yes | `No blocking findings.` | 4 | `APPROVE` | `ses_09bd22c77ffe4QrpcwBw0SbUPt` |

### Round 1 independent verdict (verbatim)

#### Blocking findings

##### B-01 Approved R5 TDD slice 8 is not implemented or behavior-sensitive

- Violated invariant: `INV-06` and approved R5 TDD slice 8 require user cancellation before progress expiry to remain an `AbortedError`, immediately interrupt the request/progress deadline, and produce no later transport-timeout event. The regression must be able to fail against the original implementation.
- Evidence class: observed.
- Responsibility owner: The Provider progress-deadline lifecycle owns timer cleanup and distinction between user abort and progress expiry; the LLM/session test seam owns verification of the externally observable cancellation behavior.
- Minimal correction direction: Add a red-capable public-seam test that aborts before headers or the first raw chunk, observes the cancellation classification, and asserts that the progress-timeout diagnostic does not occur afterward. Do not add retry, fallback, or terminal-error behavior.

##### B-02 The implementation diff contains unrelated formatter/refactor hunks outside the approved R5 responsibilities

- Violated invariant: The implementation must match the exact approved R5 revision, remain minimal, and contain no unrelated refactoring or formatting.
- Evidence class: observed.
- Responsibility owner: The implementation diff itself; these changes have no timeout-repair owner or requirement mapping.
- Minimal correction direction: Remove all formatter-only and unrelated hunks, retaining only changes required by the approved R5 NetworkProxy, Provider, configuration-description, and approved behavioral-test slices.

#### Non-blocking findings

1. Independent database immutability reproduction was not performed during this audit; the recorded hash, size, mtime, and `PRAGMA quick_check=ok` remain the available evidence.
2. The package-wide `packages/opencode` suite remains incomplete because unrelated fixture-disposal, watcher, PTY, and MCP tests timed out; changed-file tests and typechecks passed.
3. The Chinese comment count must be reconciled after unrelated hunks are removed; comments that only restate local control flow remain excluded.
4. Explicit-proxy verification remains platform-dependent; a separate Windows-runtime execution would improve confidence.

#### Release verdict

**BLOCK**

The audited R5 implementation cannot be released until the approved
cancellation-before-first-progress regression is behavior-sensitive and all
unrelated formatter/refactor hunks are removed, followed by another independent
full-scope implementation audit.

### Round 2 independent verdict (verbatim)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

1. **The complete `packages/opencode` suite did not finish within the 300-second verification window.**
   The focused changed-file tests passed, both package typechecks passed, and the reported failures were in unrelated fixture-disposal, watcher, PTY, MCP, and Git setup paths. This remains a verification limitation, not an evidence-backed defect in the audited R5 changes.
2. **The explicit-proxy regression test is platform-conditional.**
   The test deterministically forces proxy discovery on the current platform and passed locally, but it does not constitute a native Windows runtime execution. The production route transformation is shared across platforms, and the Windows-specific A/B evidence remains present under `.temp/testing/provider-timeout-ab/`; therefore this does not block release.
3. **The canonical plan records upstream Bun issue/PR provenance without embedding the external excerpts.**
   The local red-capable A/B experiments independently reproduce the relevant Bun idle-timeout behavior, so the missing excerpt is only an auditability improvement.
4. **The full package-suite failure output includes pre-existing repository fixture assumptions involving Git configuration and process cleanup.**
   Those failures should be tracked separately from this transport repair rather than attributed to R5.

#### Rejected speculation

- No evidence supports requiring `maxTransportRetries`, a fixed retry cap, a terminal prompt, automatic execution degradation, Provider failover, request hedging, prompt truncation, context reduction, or output-quality reduction.
- No evidence supports changing the numeric defaults `timeout=600000` or `chunkTimeout=180000`.
- No evidence supports treating spinner/lifecycle events as semantic first feedback.
- No evidence supports a database migration or persistence change.
- No evidence supports moving retry policy into `NetworkProxy` or `Provider`; existing `SessionRetry`, `SessionProcessor`, and Permission reviewer retry ownership is preserved.
- No evidence supports blaming context size as a qualifying primary repair: the recorded effects are below the user’s one-sigma gate (`d=0.217` Windows, `d=0.066` local).
- No evidence supports Windows registry proxy lookup as the multi-minute cause; its helper timeout is 1.5 seconds and results are cached.
- No evidence supports TUI rendering as the first divergence; the long delay occurs before semantic feedback and before step-start.
- No evidence supports classifying the package-wide unrelated fixture timeouts as R5 regressions.

#### Requirement and traceability coverage

##### Original scope

The original requirement is fully covered:

- Windows database investigation was performed from `/Users/sunbenteng/Project/opencode/.temp/testing/opencode.db`.
- macOS/local and Windows populations were compared.
- Database reads were constrained to `.temp/testing/`, with no database modification.
- A/B experiments remained under `.temp/testing/provider-timeout-ab/`.
- The discrete 240–330 second timeout mode was independently observed in both environments.
- The transport effect sizes exceeded the required one-sigma gate:
  - Direct NetworkProxy transport: `3.162σ`.
  - Explicit-proxy transport: `3.162σ`.
  - Custom-fetch pass-through: `14.142σ`.
  - Provider direct/custom policy divergence: `14.142σ`.
  - Timeout-versus-normal latency: Cohen’s `d=122.635`.
  - Cross-database Codex incidence difference: `3.212σ`.
- Three evidence-qualified repair points remain:
  1. NetworkProxy timeout preservation across direct, explicit-proxy, and custom-fetch paths.
  2. Provider construction of one common `timeout:false` transport policy before route selection.
  3. Continuous `chunkTimeout` progress enforcement from dispatch through first raw SSE chunk and between subsequent raw chunks.
- The R5 user-experience constraint is preserved:
  - No fixed retry cap.
  - No `maxTransportRetries`.
  - No new terminal prompt.
  - No automatic execution downgrade.
  - Existing retry classification, backoff, Status, and cancellation remain authoritative.
  - Existing `chunkTimeout` is reused without changing numeric defaults.

##### Producer-to-consumer reconstruction

The affected production path is:

```text
Session prompt
  -> SessionProcessor.process
  -> LLM.Service.stream
  -> AI SDK Provider fetch
  -> Provider fetch wrapper
  -> NetworkProxy.fetch / fetchWithRoute
  -> Bun native fetch
  -> HTTP/SSE response
  -> MessageV2 error conversion
  -> SessionRetry
  -> Session Status / TUI
```

The independently observed first divergences were:

1. `NetworkProxy` removed caller-supplied Bun `timeout:false` before direct/proxy/custom dispatch.
2. `Provider` supplied the common transport policy only on the direct branch.
3. `Provider` armed the SSE no-progress timer only after `await fetch()` returned a `Response`.

R5 repairs those transitions at their owning modules rather than adding downstream workarounds.

##### Forward coverage

| Requirement / invariant | Production owner | Implementation | Behavioral evidence |
| --- | --- | --- | --- |
| Preserve Bun transport option on direct route | `NetworkProxy` | `packages/core/src/network-proxy.ts:245-259` | Real scaled Bun idle A/B; core test passes |
| Preserve option on explicit-proxy route | `NetworkProxy` | `packages/core/src/network-proxy.ts:256-286` | Real delayed local proxy A/B; core test passes |
| Preserve option through custom adapter | `NetworkProxy.fetchWithRoute` | `packages/core/src/network-proxy.ts:270-279` | Custom pass-through test passes |
| Common direct/custom Provider policy | `Provider` | `packages/opencode/src/provider/provider.ts:1920-1996` | Real local-plugin Provider test passes; `14.142σ` baseline |
| Dispatch-to-first-raw-chunk deadline | `Provider` | `packages/opencode/src/provider/provider.ts:127-275`, `1973-2011` | Delayed-header LLM test passes |
| Per-raw-chunk reset, non-cumulative | `Provider` | `packages/opencode/src/provider/provider.ts:247-257` | Delayed multi-chunk stream test passes |
| Preserve post-first-chunk timeout | `Provider` | `packages/opencode/src/provider/provider.ts:218-275` | Existing SSE stall test passes |
| Preserve user cancellation | `Provider` / existing cancellation path | `packages/opencode/src/provider/provider.ts:152-181`, `259-265` | Focused cancellation tests pass |
| Preserve retry classification and Status | Existing `MessageV2` / `SessionRetry` / `SessionProcessor` | No retry-production modification | Vertical first-progress retry test passes |
| Preserve database immutability | `.temp/testing` investigation boundary | No database code or migration changed | SHA, size, and mtime unchanged |

##### Reverse coverage

Every new production concept has a confirmed mapping:

- `RoutedInit.timeout`: required by the observed Bun transport contract and the reachable NetworkProxy seam.
- `progressDeadline`: required by the observed gap between dispatch and the existing post-Response timer.
- `expired`, `rejectRead`, reader cancellation, and timer cleanup: required to preserve one continuous deadline and distinguish deadline expiry from ordinary cancellation.
- `fetch` timing diagnostics: required by the investigation and contain no payload, prompt, authorization, or model-output data.
- Provider common transport init: required by the observed direct/custom divergence.
- Test child-process isolation and delayed local servers: required to reproduce the real Bun transport boundary without relying on external services.
- No new configuration key, retry state, persistence schema, fallback, Provider, adapter, or migration was introduced.

#### Primary-path and fallback verdict

**Primary-path verdict: PASS**

One authoritative path exists for each responsibility:

- `Provider` owns timeout composition and continuous transport progress.
- `NetworkProxy` owns route resolution and preserves caller transport options while stripping only route-owned fields.
- `MessageV2` owns transport error conversion/classification.
- `SessionRetry` and `SessionProcessor` retain retry orchestration and Status publication.

The implementation does not add an alternate success path:

- No Provider failover.
- No duplicate request hedging.
- No catch-and-default success.
- No parser/decoder cascade.
- No fixed retry limit.
- No terminal prompt after repeated transport failures.
- No hidden feature disablement.
- No automatic execution degradation.

The existing retry path remains the sole semantic recovery path. The new progress timeout produces the existing `"SSE read timed out"` / `SSE_READ_TIMEOUT` transport shape, which the vertical Processor test observes through the existing classification, retry Status, and successful second attempt.

The R5 continuous-chunk contract is correctly represented:

- Initial timer starts at dispatch.
- The same `chunkTimeout` value governs the no-progress window until the first raw SSE chunk.
- Each raw chunk resets the timer.
- Gaps are not accumulated.
- Raw transport chunks, not AI SDK semantic events, are the reset unit.
- EOF, reader failure, response failure, cancellation, and outer abort stop the timer.

#### Code quality and Chinese-comment verdict

**Code-quality verdict: PASS**

Observed compliance:

- Both package typechecks passed.
- `packages/core` focused NetworkProxy tests passed: `6 pass, 0 fail`.
- Focused Provider progress tests passed.
- Focused custom Provider transport-policy test passed.
- Focused Processor first-progress retry test passed.
- Existing retry suite passed: `45 pass, 0 fail`.
- `git diff --check` produced no whitespace errors.
- No generated SDK, migration, database, or unrelated production artifact was changed.
- The implementation preserves the existing module ownership and self-export structure.
- The transport option is typed narrowly as `timeout?: false | number`; no new `@ts-ignore` or broad type escape was added.
- The changed tests observe public seams rather than private helper internals.
- The tests use local delayed servers and child-process isolation to reproduce actual transport behavior.
- Test comments explicitly distinguish readiness delays from product timeout semantics.

##### Chinese explanatory-comment calculation

The implementation audit was recomputed from the actual diff rather than accepting the plan estimate.

- **Effective changed production/test/configuration lines `E`: approximately 280**
  - Excludes imports, formatting-only changes, generated content, and pure moves.
  - Includes the `NetworkProxy` pass-through change, Provider deadline lifecycle, configuration contract text, and new public-seam tests.
- **Required Chinese explanatory-comment lines:**
  - `ceil(280 × 0.15) = 42`
- **Qualifying nearby Chinese explanatory-comment lines `C`: approximately 50**
  - NetworkProxy transport ownership and child-process isolation.
  - Provider deadline phase distinction, raw-chunk reset semantics, abort/error ownership, and cleanup.
  - LLM delayed-header, cancellation, and non-cumulative timing intent.
  - Provider local-plugin seam independence.
  - Processor vertical retry/status chain and explicit absence of a retry cap.
- **Calculated ratio:** approximately `17.9%`.
- **Gate result:** `C >= 42`; the 15-percent Chinese explanatory-comment gate passes.

The counted comments explain real invariants, transport boundaries, cleanup behavior, test intent, and the preserved retry contract. Comments that merely restate assignments, test names, or obvious control flow were excluded.

#### Release verdict

**APPROVE**

This approval applies only to:

- Canonical plan revision **R5**.
- The exact implementation diff in:
  - `packages/core/src/network-proxy.ts`
  - `packages/core/test/network-proxy.test.ts`
  - `packages/opencode/src/config/provider.ts`
  - `packages/opencode/src/provider/provider.ts`
  - `packages/opencode/test/provider/provider.test.ts`
  - `packages/opencode/test/session/llm.test.ts`
  - `packages/opencode/test/session/processor-effect.test.ts`
- The corresponding current canonical plan:
  - `docs/plans/provider-timeout-transport-integrity.md`

Database immutability was independently verified:

```text
SHA-256: f1de09a0b69e5b1014c7b3a932f663838da01dee215d4df0c320260c20416da4
Size:    2164944896 bytes
Mtime:   2026-07-15T03:02:54+0800
```

No blocking finding remains under the complete original scope, the R5 transport contract, the fallback/retry prohibition, the statistical significance gate, the database immutability requirement, or the Chinese explanatory-comment gate.

The task is verified for exact R5. The commit may now be created if it excludes
all unrelated worktree and index changes.
