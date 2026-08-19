# Canonical Implementation Plan: Session Output And Markdown Circuit Breaker

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户在当前 Session GOAL 中提供的原始需求
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-19

This file is the sole implementation specification for this task. Chat
summaries, superseded plans, and builder rationale outside this file are not
implementation authority.

## 1. Verbatim Requirement

> 当前需要优化我们已有session加载渲染的卡顿以及不合理的或者过于冗余的数据读取问题；对于当前任务而言就是将其渲染设置所述的熔断机制、以及对消息流设置超长门控自动触发可被外部网络错误等所捕获的重试,同时避免大规模修改相应加载机制，不得因为无理由或者本身过度苛责的审计而扩大修改范围，不需要优化或者修改既有风险点,保持精准的手术刀级别的点点修改即可，也就是尽涉及不超过6个生产代码文件,不超过400行生产代码。同时不引入新的退化。

The implementation must remain within six production files and 400 effective
production lines. Auditing must not widen the scope without an evidence-backed
requirement or a reachable consequence in this repair.

## 2. Explicit Non-Goals

- 不修改 `sync.session.sync()`、Message 分页、Session `/diff`、SummaryCache、Solid store、Files sidebar 或数据库历史数据。
- 不修改 OpenTUI core、Tree-sitter worker、native buffer、viewport lifecycle 或 renderer scheduling。
- 不修改 Provider SDK、网络代理、SSE timeout、模型配置、模型选择或模型专属阈值。
- 不实现重复文本识别器、滑动窗口、XML/DSML parser、模型专属 workaround 或跨轮污染状态机。
- 不重试已执行 Tool 副作用的超长 Assistant step；Tool-bearing 超长 step 只终止并报告，不回放副作用。
- 不自动删除历史 Session、Part、Message 或 SQLite 数据；新运行的超长失败尝试由现有 Part removal 语义撤回。
- 不改变普通 Markdown、Reasoning、Compaction summary、Tool output、User Message 或文件预览的默认渲染语义，除非它们通过本计划明确的 Assistant Text Part 路径。
- 不为 Session 大小、Provider、Model、Session 数量、终端宽度或内存状态选择不同生产算法。
- 不新增 public SDK 字段、配置键、migration、generated file、dependency、fallback endpoint 或第二套 retry 实现。
- 生成侧熔断位于 Processor 公共 `text-delta`/`text-end` 处理分支，不依赖 `experimentalEventSystem` 开关：v1 Part 写入与 EventV2 dual-write 在同一累计预算下受限。EventV2 的 retry、撤回与失败投影复用既有 dual-write 合同（`session.next.retried`、下一次 `session.next.step.started` 终结残留 Assistant、`session.next.step.failed` 终态），不新增 schema、projector、updater、v2 SDK 类型或 retraction 协议。本次只对 v1/v2 的 Assistant Text Markdown 渲染选择增加同一预算判断。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message 是 MessageV2 + Parts；v1 `packages/opencode/src/session` 是当前生产路径；v2 TUI 是独立迁移路径；Provider、Session、Status、Run state 的职责不同。 |
| `AGENTS.md` | 要求使用 Bun、并行调查、保持局部修改；测试和 typecheck 必须在 package 目录执行。 |
| `packages/opencode/AGENTS.md` | 要求在真实 Effect/Session owner 处修复；避免重复抽象、额外 fallback 和不必要的类型层。 |
| `packages/opencode/test/AGENTS.md` | 测试应通过真实 Session/Provider/TUI seam，使用 readiness signal，避免复制生产逻辑。 |
| `thirdparty/opentui/AGENTS.md` | OpenTUI 修改必须有真实复现；本计划不修改 OpenTUI，因为当前渲染熔断可在 OpenCode TUI owner 绕过 Markdown parser。 |
| `.opencode/policy/first-principles-engineering.md` | 要求修复 first divergence、复用唯一 primary path、禁止 fallback、完成双向追踪和 15% 中文解释性注释门禁。 |
| `.opencode/templates/canonical-plan.md` | 要求完整记录 evidence、reachability、invariant、owner、TDD、verification、diff、risk 和 audit。 |
| `docs/adr/README.md` / `docs/adr/0001-...` | 没有约束本次 Session output 或 Markdown 渲染的相关 ADR；不新增架构决策。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/processor.ts:883-922` | `text-start`创建 Text Part；`text-delta`先在内存追加、再通过 `updatePartDelta` 仅发布 live bus 事件；durable 写入在 `text-end` 的 `updatePart`。两处当前都没有字符上限。 | observed |
| `packages/opencode/src/session/processor.ts:924-953` | `experimental.text.complete` 在最终 `session.updatePart` 前可以改写完整正文；它是 delta guard 之后仍可扩大正文的 reachable public hook。 | reachable |
| `packages/opencode/src/plugin/index.ts:401-413` / `packages/plugin/src/index.ts:325-328` | 证明 `experimental.text.complete` 是可达的 plugin mutation seam，而不是只存在于测试。 | reachable |
| `packages/opencode/src/session/processor.ts:965-1055` | cleanup 会把 active Text Part 完成并写回；失败尝试若不在 throw 前撤回，会重新被 cleanup 持久化。 | observed |
| `packages/opencode/src/session/processor.ts:1094-1177` | `SessionRetry.retry` 包住 Provider stream；`catch(halt)` 设置 Assistant error；现有结果会返回 `stop`。 | observed |
| `packages/opencode/src/session/processor.ts:790-813` | 已有 `finishReason="other"` 的示范：撤回当前 attempt Parts，再抛 `MessageV2.APIError({ isRetryable: true })`，由外层 retry 捕获。 | observed |
| `packages/opencode/src/session/retry.ts:71-155,179-210` | 现有 retry 只由 `APIError.data.isRetryable` 驱动，retry policy 没有固定 attempt cap。 | observed |
| `packages/opencode/src/provider/provider.ts` + AI SDK stream 转发 | Provider 可在一次响应内连续发送多个带独立 ID 的 text blocks；Processor 为每次 `text-start` 创建新 Text Part，当前没有跨 Part 累计上限。 | reachable |
| `packages/opencode/src/session/processor.ts:1146-1157` | flag-on 时 retry 经 `SessionEvent.Retried` dual-write；下一次 attempt 的 `start-step` 再次发布 `Step.Started`。 | observed |
| `packages/core/src/session-message-updater.ts:166-185,199-209` / `sync-v2.tsx:119-153` | `session.next.step.started` 会把上一个未完成 Assistant 置 `time.completed` 并新建 Assistant；`Step.Failed` 是既有终态投影；`session.next.retried` 保持 no-op。 | observed |
| `packages/opencode/test/lib/llm-server.ts:688-694` | 测试 LLM 队列为空时自动返回 `"ok"`；反馈 harness 必须显式排入全部 retry 响应。 | observed |
| `packages/opencode/src/session/message-v2.ts:89-107,1978-2016,2089-2098` | `APIError` 已有 message/isRetryable/metadata；`fromError` 保留 APIError；`OutputLengthError` 已在 Shared schema，但当前 data 为空。 | observed |
| `packages/opencode/src/session/prompt.ts:3232-3244` | 非 APIError/Unknown 的最终错误返回普通 break；这使最终 `OutputLengthError` 不进入 Goal terminal-error continuation。 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:2098-2150` | v1 Assistant Text Part 完成态直接创建 Markdown/Code，streaming 态也直接创建 Markdown Code。 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:394-449` | v2 AssistantText 重复同一无界 Markdown/Code 选择；本计划只改变其 Markdown budget projection，不改变 EventV2 error schema 或 failure lifecycle。 | observed / explicit boundary |
| `packages/opencode/src/cli/cmd/tui/util/session-pending.ts:20-32` | 当前 viewport culling 在非 sticky streaming 时会关闭；本计划不修改该既有风险，避免扩大责任范围。 | observed / explicit non-goal |
| `thirdparty/opentui/packages/core/src/renderables/Code.ts:354-544,804-822` | Markdown Code 路径会进入 Tree-sitter/highlight/styled-text；无界文本可在 OpenTUI 内形成高成本 parser/render 工作。 | observed |
| `packages/opencode/test/session/processor-effect.test.ts:1559-1744` | 真实 `provideTmpdirServer` + `SessionProcessor.process` 已覆盖 retryable `other`、Part cleanup、Provider call count 和恢复文本。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx` | 真实 v1 TUI route、OpenTUI frame 和 text Part fixture seam。 | observed |
| `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx` | 真实 v2 plugin route、SDK transport 和 OpenTUI frame seam。 | observed |
| `packages/opencode/test/util/error.test.ts:54-63` | 当前 `OutputLengthError` 测试锁定空 data schema；本计划保持该 legacy public/SDK 合同，不改变错误 schema。 | observed |
| `D:\Temp\opencode\session-output-limit-red.ts` | 只读 throwaway harness，穿过真实 TestLLMServer、Provider、SessionProcessor 和 SQLite。 | observed |
| Harness result: `{"output":"continue","length":65537}` | 当前代码接受单个 65,537 字符正文并完整写入，没有 error/retry。 | observed |
| Read-only SQLite query on `C:\Users\Lenovo\.local\share\opencode\opencode.db` | `69,887` assistant Text Parts；`26` 超过 Markdown budget；`1` 超过 64 KiB；最大 `196,336` 字符。 | observed |
| Target Message Part `prt_0053cfea2001wEDDF6a0qyeDxT` | 单个 Text Part 为 `196,336` 字符、约 `35,567` 行，是当前数据库唯一超过 64 KiB 的 Assistant Text Part。 | observed |
| OpenTUI inline benchmark: 140,000-character Markdown | 当前 CodeRenderable streaming Markdown 路径耗时约 `106,759 ms`，plainText 长度 `140,000`。 | observed |
| `bun test test/session/processor-effect.test.ts -t "partial output with finish_reason=other retries and recovers"` | 当前已有 retry 反馈测试在默认 5 秒测试预算下超时；不是本次根因反馈，后续验证必须使用 package 默认 30 秒 timeout。 | observed |

## 5. Current Behavior

```text
Provider SSE
  -> LLM.stream
  -> SessionProcessor.handleEvent("text-start")
  -> session.updatePart(empty TextPart)
  -> handleEvent("text-delta")
       -> ctx.currentText.text += delta
       -> session.updatePartDelta(delta)  // no output bound
  -> text-end / finish-step
  -> cleanup + completed Assistant
  -> SessionPrompt sees result="continue"
```

The current first divergence is before `updatePartDelta`: the Processor accepts
an unbounded provider text delta as valid Assistant Text Part content. Once the
delta is published, the current Part can become a durable large object and the
outer retry policy has no error to consume.

The TUI path is separate:

```text
persisted Assistant TextPart
  -> v1 TextPart or v2 AssistantText
  -> Markdown/Code renderable for all completed/streaming content
  -> Tree-sitter/highlight/styled-text work
```

The second first divergence is the unconditional Markdown branch. It does not
measure the content before constructing the parser-backed renderable.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Assistant Text Part delta below 64 KiB | Provider SSE / AI SDK | Decoded string delta | `LLM.stream` -> Processor -> `updatePartDelta` | SessionProcessor | observed / contracted |
| One Assistant Text Part whose cumulative text crosses 64 KiB | Provider SSE | No current size guarantee; public Provider output is arbitrary decoded text | `text-start` -> repeated `text-delta` | SessionProcessor | observed / reachable |
| One attempt whose multiple Text Parts cumulatively cross 64 KiB | Provider SSE / AI SDK | Independent-ID text blocks are forwarded per block; no upstream cumulative guarantee | repeated `text-start` -> `text-delta` within one attempt | SessionProcessor | reachable |
| `experimentalEventSystem=true` execution | Public env flags (`OPENCODE_EXPERIMENTAL`, `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM`) | Same Processor handlers publish EventV2 dual-writes | same `text-delta`/`text-end` branches plus `events.publish` | SessionProcessor | reachable |
| First over-limit no-Tool attempt | Provider SSE | No Tool side effect in the current attempt | Processor -> existing `SessionRetry.retry` | SessionProcessor + SessionRetry | reachable |
| Repeated over-limit attempt | Provider SSE | Existing retry policy can accept repeated retryable API errors without a fixed cap | Same stream retry scope | SessionProcessor | reachable |
| Over-limit attempt after Tool event | Provider SSE | Tool may already have executed a side effect | Processor -> cleanup/error | SessionProcessor | reachable |
| Completed Assistant Text Part over Markdown char budget | Message persistence / SDK v1 route | Part text is a string | v1 `TextPart` | TUI TextPart owner | observed / reachable |
| Completed Assistant Text Part over Markdown line budget | Same | Newline count is available in the text string | v1 `TextPart` and v2 `AssistantText` | TUI text consumers | observed / reachable |
| Streaming Assistant Text Part over Markdown budget | Provider SSE -> TUI sync | Current text is observable before completion | v1/v2 streaming text render | TUI text consumers | reachable |
| Normal Text Part within both budgets | Same | Existing Markdown behavior is valid | v1/v2 Markdown/Code branch | TUI text consumers | contracted |
| Reasoning, Compaction summary, Tool output, User Message | Separate Part/route owners | No current evidence that this task's incident is caused by them | Adjacent TUI routes | Existing owners | explicit non-goal |

No Model, Provider, Session-size, terminal-width, or memory-state branch is
proposed. The only supported-domain branches are text size and Tool side-effect
presence at the already-owned stream boundary.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | A single generated Assistant Text Part cannot publish or persist text beyond 64 KiB, including the final value returned by `experimental.text.complete`. The guard is a per-attempt cumulative budget across all Text Parts of the current attempt, applies regardless of `experimentalEventSystem`, and therefore bounds both single-Part and multi-Part output. | User requirement; observed 196,336-character Part; red harness; reachable plugin mutation seam; provider multi-text-block forwarding. | No current test; red harness is the minimized failure. |
| INV-02 | The first over-limit no-Tool attempt is represented as an existing retryable `APIError` and is consumed by the existing `SessionRetry` path. | Existing `finish="other"` retry contract and `SessionRetry.retryable`. | Existing `other` recovery tests; new output-limit recovery test required. |
| INV-03 | The over-limit attempt's already-written Text/Reasoning/Step Parts are removed before retry or terminal error; cleanup must not re-persist them. | Current `attemptPartIDs` and `Session.removePart` owner; cleanup behavior. | Existing partial `other` cleanup test; new output-limit no-prefix assertion required. |
| INV-04 | A repeated over-limit response does not create an unbounded retry loop; it becomes the existing non-retryable `MessageOutputLengthError` with its unchanged empty data shape, and the EventV2 projection stays the existing `Step.Failed` terminal contract. | Existing retry policy has no cap; repeated provider output is reachable; public error schema is fixed. | New repeated-over-limit processor test. |
| INV-05 | A Tool-bearing over-limit attempt is not replayed automatically; it terminates through the existing non-retryable output-length error path after current Parts are cleaned. | Tool side effects are owned by Processor and no replay-safe contract is proven. | New or focused Tool-side-effect boundary test if the fixture can reach both events. |
| INV-06 | Text within the Markdown budget keeps current v1/v2 Markdown/Code behavior; over-budget text is rendered as plain text without parser-backed Markdown construction. | Existing routes and measured 140,000-character parser cost. | v1 and v2 frame tests with literal Markdown markers. |
| INV-07 | The renderer budget is deterministic: `chars > 32 KiB OR logical lines > 1000` selects plain text; exactly-at-budget input remains Markdown. | SQLite distribution: 26 historical Parts hit the proposed gate. | Boundary tests for chars and lines in shared utility/TUI route tests. |
| INV-08 | No historical database row is modified by this repair; only new failed attempts are withdrawn through the existing Session Part event path. EventV2 schema, projector, session-message updater, and v2 SDK stay byte-identical; their dual-write execution is bounded by the same Processor guard. | User scope and persistence ownership; the guard lives in the flag-independent handler both paths share. | Read-only historical detector plus runtime tests; existing v2 failure compatibility tests remain green. |
| INV-09 | Existing Session load, retry classification for unrelated errors, Tool loop, normal Markdown, v1/v2 route registration, and user-visible content remain unchanged outside the stated branches. | Existing plans/tests and explicit user scope. | Focused regression suites and package typecheck. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/03 | `text-delta` appends and publishes an arbitrary delta before any size decision, `text-start` opens unbounded additional Text Parts, and `text-end` later accepts an arbitrary plugin-mutated final value — all in the flag-independent handler shared by v1 Parts and EventV2 dual-writes. | `SessionProcessor.handleEvent("text-delta"/"text-start")` plus `text-end` finalization | `processor.ts:883-953`; red harness returns `continue` with `length=65537`; plugin hook is reachable before final write; AI SDK forwards independent-ID text blocks. |
| INV-04 | The existing retry wrapper has no output-specific stop after a repeated retryable error. | `SessionProcessor` retry-attempt boundary, not `SessionRetry` policy | `retry.ts:71-155`; user scope forbids general retry-policy changes, while the current handle can track this one semantic retry. |
| INV-05 | A Tool-bearing step cannot safely be replayed merely because later text is too long. | `SessionProcessor` knows `ctx.hasToolCall` and owns current attempt Parts | `processor.ts:534-535,601-707`; existing finish-other repair deliberately excludes Tool-bearing attempts. |
| INV-06/07 | v1 and v2 TextPart consumers choose Markdown/Code without a content budget. | v1 `TextPart` and v2 `AssistantText` | `index.tsx:2108-2148`; `session-v2.tsx:407-445`. |

The root cause is not Session loading and not Solid proxying. The Processor's
flag-independent text handlers have no bounded cumulative Text contract at
delta or plugin-finalization writes, and the two TUI text consumers have no
bounded Markdown contract. The guard therefore covers the v1 Part path and the
EventV2 dual-write execution with one check at the shared seam.

Red-capable feedback loop already run:

```text
cd packages/opencode
bun D:\Temp\opencode\session-output-limit-red.ts
```

Observed current result:

```text
{"output":"continue","length":65537}
RED: repeated over-limit output must terminate with MessageOutputLengthError and no persisted text part
```

The harness queues two explicit over-limit responses so every retry attempt is
scripted; the empty-queue auto-`"ok"` fallback of `TestLLMServer` never runs.
Approved contract: first breach triggers the existing retry (second Provider
call), second breach terminates with `MessageOutputLengthError`, output is
`stop`, and no over-limit Text Part survives (`length === 0`).

The script uses a real `TestLLMServer`, Provider, Session, SQLite-backed
SessionProcessor and `handle.process`; it does not call a private helper.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Attempt cumulative Text output limit | `SessionProcessor` | Converts decoded `LLM.Event` into Message Parts and owns current attempt IDs; `text-delta`/`text-end` handlers are flag-independent, so one guard bounds v1 Parts and EventV2 dual-writes together. | It is the first decoded trust seam before live delta publication and the durable `text-end` write; it can reject before the over-limit delta or final Part crosses either path. | Provider adapters do not own Message Part persistence; TUI is too late and cannot stop generation. |
| First retry classification | Existing `SessionRetry` consumed through `SessionProcessor` | `APIError(isRetryable=true)` is the established retry contract. | Reuses the current retry path without a second scheduler. | A new retry implementation would duplicate backoff/status semantics. |
| One semantic retry cap | `SessionProcessor` current process attempt | This is a semantic output guard, not general retry policy. | Only Processor knows whether the current retry was caused by this output guard and whether Tools already ran. | `SessionRetry` cannot distinguish output-limit retries from transport retries without a new public policy. |
| Terminal output error | `MessageError.OutputLengthError` | Existing Shared Assistant error schema and TUI error formatter. | Existing named error is the terminal discriminator; preserving its empty data shape avoids a public contract change. | Adding a new error type or message field would duplicate or widen the output-length contract. |
| Markdown budget decision | New `tui/util/text-budget.ts` | Pure deterministic predicate over text content. | Shared by the two actual Assistant Text consumers, avoiding drift. | Processor must not import TUI policy; each route would otherwise duplicate thresholds. |
| v1/v2 text rendering branch | Existing `TextPart` and `AssistantText` | Render Assistant Text Part content. | They are the last owner before Markdown/Code renderable construction. | OpenTUI core cannot know which product text is intentionally Markdown. |
| EventV2 retry/failure lifecycle | Existing EventV2 dual-write contracts | `SessionEvent.Retried` (projection no-op), next `Step.Started` completing the stale Assistant, and `Step.Failed` as the terminal projection. | These are the shipped semantics the existing `finish="other"` retry already uses; the output guard reuses them unchanged. | A new retraction or typed-error protocol would be a v2/SDK migration outside this repair. |

## 10. Single Approved Primary-Path Design

The approved primary path has one generation boundary and one rendering
projection. It does not add a fallback after a parser failure.

### 10.1 Generation path

```text
text-delta or text-end plugin result (flag-independent handler)
  -> maintain ctx.attemptTextChars: cumulative chars of ALL Text Parts in the current attempt
  -> before publishing a delta (updatePartDelta) or the final write (updatePart):
     next = ctx.attemptTextChars + delta.length   // or plugin-adjusted final length
     -> if next <= 64*1024: publish, ctx.attemptTextChars = next
     -> otherwise: remove all current attempt Parts via attemptPartIDs,
        clear attemptPartIDs / ctx.currentText / ctx.reasoningMap
        -> first over-limit no-Tool attempt: throw APIError(isRetryable=true)
           -> existing SessionRetry retries once; retry entry resets attempt state
        -> repeated over-limit or Tool-bearing attempt:
           throw MessageOutputLengthError()
  -> existing cleanup/finalizer/halt completes the Assistant with the typed error
```

`ctx.attemptTextChars` is reset to 0 at every attempt start (the same block
that resets `currentText`/`reasoningMap`/`attemptPartIDs` on retry entry) and
at `process()` start. The check occurs before `session.updatePartDelta`, so
the crossing delta is not appended in memory, not published on the bus, and
never reaches the durable `text-end` `updatePart`. Because the budget is
cumulative across Text Parts, a provider splitting output into multiple
independent-ID text blocks (for example two 40 KiB parts) still breaches at
the crossing delta of the second part. A single Part can never exceed the
budget because its own characters count toward the same cumulative total.

The same cumulative invariant is rechecked after `experimental.text.complete`
returns and before the final `session.updatePart` and any `SessionEvent.Text.Ended`
publish at `text-end`: `next = ctx.attemptTextChars + (finalText.length -
prePluginLength)`; a hook that expands the value beyond the bound follows the
same cleanup/error path. There is no second plugin-specific policy and no
post-write scrubber.

On breach, removal happens before the throw: every part ID in `attemptPartIDs`
(including the current Text Part and step-start/reasoning parts) goes through
the existing `session.removePart` path, and `ctx.currentText`/`ctx.reasoningMap`
are cleared so `cleanup()` cannot re-persist an already rejected Part.

The first over-limit no-Tool error uses the existing `MessageV2.APIError` with:

```text
message: "Provider output exceeded the 64 KiB text limit"
isRetryable: true
metadata: { reason: "output-length" }
```

The Processor owns a single semantic counter for the current `process()` call. It is
reset when a new Provider process starts, retained across the retry execution,
and never becomes a general retry counter. A second over-limit result in the
same process, or any over-limit result after `ctx.hasToolCall`, throws the
existing `MessageError.OutputLengthError` with its unchanged empty data shape.
This prevents a deterministic provider failure from looping forever while still
meeting the requirement that the first over-limit stream is caught by the
existing external retry path.

The existing empty `OutputLengthError` schema and its legacy public/SDK contract
are unchanged. `MessageV2.fromError` already preserves the named error and
`prompt.ts` already treats it as an ordinary break because it is not `APIError`
or `UnknownError`.

EventV2 lifecycle under `experimentalEventSystem=true` reuses the existing
dual-write contracts exactly as the shipped `finish="other"` retry does, with
no schema, projector, updater, or SDK change: the breach throws before
`SessionEvent.Text.Ended`, so the stale Assistant projection keeps at most the
already-published sub-limit content of earlier completed Parts; the retry
publishes the existing `SessionEvent.Retried` (projection no-op by design); the
next attempt's `start-step` publishes `Step.Started`, which completes the stale
Assistant (`time.completed`) and opens a fresh one; a terminal breach flows
through `halt()`'s existing `SessionEvent.Step.Failed` projection. No blank or
unbounded assistant survives, and no new retraction protocol is introduced.

### 10.2 Rendering path

```text
Assistant Text Part content
  -> shared withinMarkdownBudget(content)
  -> within budget: current v1/v2 Markdown/Code branch
  -> over budget: plain text renderable, no Markdown/Tree-sitter construction
```

`withinMarkdownBudget` returns true only when both conditions hold:

```text
content.length <= 32 * 1024
logicalLines <= 1000
```

Logical lines are `1 + count("\n")`; the predicate must short-circuit on the
first exceeded boundary and must not allocate a split array. The same content
memo currently used by each route is passed to the predicate. The existing
`<Show when={content()}>` and spacing/container behavior remain unchanged.

The v1 `TextPart` and v2 `AssistantText` components add a first branch that
renders the unchanged trimmed content through the existing plain text node when
the predicate is false. All existing Markdown flags, streaming behavior,
syntax styles, conceal settings, and completed keys remain unchanged for inputs
within budget.

This is a supported-domain projection branch, not a parser-error fallback: the
input is classified before a Markdown renderable is created, and no second
parser or retry is attempted.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | ---: | --- |
| Attempt cumulative text within 64 KiB | Current, preserved | primary-contract branch | yes | existing | preserve |
| First no-Tool over-limit -> existing retryable APIError | Proposed | primary-contract error branch | no; delegates to existing retry | about 12% | implement |
| Second over-limit -> OutputLengthError | Proposed | diagnostic terminal branch | no | about 6% | implement |
| Tool-bearing over-limit -> existing OutputLengthError | Proposed | diagnostic terminal branch within the existing contract | no | about 3% | implement |
| Existing `SessionRetry` backoff/status | Current | existing compatibility/orchestration | yes after later valid response | 0% new | preserve |
| Markdown within 32 KiB/1000 lines | Current, preserved | primary-contract branch | yes | existing | preserve |
| Plain text over Markdown budget | Proposed | primary-contract projection branch | yes, same text content | about 8% | implement |
| Retry scheduler rewrite, model fallback, parser fallback | Rejected | forbidden alternate path | yes | prohibited | reject |

The proposed branches do not compete to produce success. The only success after
an error is the existing SessionRetry result from a later Provider response.
Plain text is the explicit render contract for the supported over-budget input,
not recovery after Markdown failure.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| None in Processor for Text Part size | No output limit currently exists. | Add the guard at the first durable delta boundary; no downstream scrubber is needed. | `processor.ts` delta branch |
| Any future attempt to use `takeUntil` for over-limit text | `takeUntil` can end normally and return `continue`, leaving replayable content. | Throw a typed error so the existing retry/error path observes failure. | Reject; no code path added |
| Unconditional v1 Markdown/Code selection | Historical renderer assumed all Assistant text was affordable. | Budget classification occurs before parser-backed construction. | v1 `TextPart` |
| Unconditional v2 Markdown/Code selection | v2 route duplicated v1 behavior during migration. | Shared pure predicate keeps both routes aligned. | v2 `AssistantText` |

No existing retry scheduler, OpenTUI lifecycle workaround, database repair, or
Session load path is deleted because none owns the first divergence in scope.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Pre-publication cumulative delta bound | `session/processor.ts` | Single 65,537-char delta and a two-40 KiB-part fixture both yield no over-limit Part and the approved retry/terminal behavior. |
| INV-02 | Existing APIError -> SessionRetry | `session/processor.ts` only; `retry.ts` unchanged | First over-limit response followed by `recovered` response: two Provider calls, recovered text only. |
| INV-03 | Existing attempt Part removal | `session/processor.ts` | Final Parts exclude failed prefix, step-start, and crossing Text Part. |
| INV-04 | Processor-local single retry count | `session/processor.ts` | Two consecutive over-limit responses: two calls, terminal `MessageOutputLengthError`, no third request. |
| INV-05 | Tool side-effect boundary | `session/processor.ts` | Tool-bearing over-limit fixture terminates without replaying the Tool request; EventV2 generation remains untouched. |
| INV-06/07 | Shared Markdown predicate before renderable | `tui/util/text-budget.ts`, v1/v2 routes | Exact boundaries preserve Markdown; over-char/over-line content visibly retains literal Markdown markers. |
| INV-08 | No historical mutation and EventV2 compatibility | `session/processor.ts` only; no EventV2 files | Read-only SQLite query remains unchanged; EventV2 schema/updater/SDK stay byte-identical while their dual-write execution shares the same guard. |
| EventV2 retry/failure lifecycle reuse | Existing dual-write contracts, no code change | `test/v2/session-message-updater.test.ts` | `session.next.retried` stays a projection no-op; the next `session.next.step.started` completes the stale Assistant; `session.next.step.failed` remains the terminal projection. |
| INV-09 | Existing behavior | All four production consumers and existing retry path | Focused Processor, v1/v2 TUI tests, package typecheck, and regression suites. |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `64 * 1024` Text Part bound | INV-01 | User explicitly requests a body Part upper bound; observed 196,336-character Part; red harness. | No current Processor size check exists; TUI is too late to stop the stream. |
| Pre-delta rejection | INV-01/03 | `updatePartDelta` is the first live publication seam; the durable write is the `text-end` `updatePart`, guarded after the plugin hook. | A post-write scrubber allows the oversized delta through memory/bus and risks cleanup re-persistence. |
| Cumulative attempt budget | INV-01 | AI SDK forwards independent-ID text blocks; two 40 KiB parts pass any per-Part check while totaling 80 KiB. | A per-Part limit leaves a reachable unbounded aggregate path; the attempt-scope counter closes it without Provider-specific logic. |
| First retryable APIError | INV-02 | Existing `finish="other"` repair and `SessionRetry` contract. | `OutputLengthError` is not retryable; a new retry implementation would duplicate policy. |
| Processor-local one-retry counter | INV-04 | Existing retry policy has no fixed attempt cap; deterministic repeated output is reachable. | `SessionRetry` cannot identify this semantic cause without widening its public policy. |
| Existing `OutputLengthError` terminal contract | INV-04/05 | Existing named error and empty data schema are already the legacy public/SDK contract. | Adding a message would require a public contract change outside this surgical repair; the existing named error remains the terminal discriminator. |
| Shared TUI budget predicate | INV-06/07 | v1 and v2 have duplicate Markdown decisions; measured 140,000-character parser path is 106s. | Keeping thresholds in two routes would allow drift; Processor must not own presentation policy. |
| Plain text render branch | INV-06 | User requests Markdown circuit breaker; parser-backed Code is the measured hot path. | Markdown must be bypassed before construction; parser failure fallback would be too late and non-deterministic. |
| Tool-bearing terminal branch | INV-05 | Processor already distinguishes `ctx.hasToolCall`; existing `finish="other"` plan excludes Tool replay. | Retrying after Tool execution could duplicate real side effects. |
| Post-plugin final write check | INV-01/03 | Reachable `experimental.text.complete` mutates text between `text-delta` and `session.updatePart`. | A delta-only check cannot enforce a durable Text Part invariant. |
| Preserve EventV2 dual-write lifecycle | INV-04/05/08 | `Retried` + next `Step.Started` + `Step.Failed` are the shipped projections the `finish="other"` retry already uses. | A new retraction or typed-error protocol would be a v2/SDK migration outside the user scope. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | ---: |
| `packages/opencode/src/session/processor.ts` | modify | Add a flag-independent cumulative attempt Text budget checked before delta publication and before the post-plugin final write; remove current attempt Parts and clear live state before erroring; first no-Tool breach throws the retryable APIError, repeated/Tool-bearing breach throws the existing OutputLengthError; EventV2 dual-writes reuse existing lifecycle unchanged. | +55 to +95 |
| `packages/opencode/src/session/message-error.ts` | unchanged | Existing `OutputLengthError` name and empty public data schema remain the terminal contract; no SDK/generated contract drift. | 0 |
| `packages/opencode/src/cli/cmd/tui/util/text-budget.ts` | add | Export one pure Markdown budget predicate and constants for both v1/v2 TUI consumers. | +15 to +25 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | Select plain text before v1 Markdown/Code construction when the shared predicate rejects content. | +8 to +18 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | modify | Apply the same shared predicate before v2 AssistantText Markdown/Code construction. | +8 to +18 |

Hard maximum: four production files and approximately 160 effective production
lines, below the user limit of six files and 400 production lines. No OpenTUI,
Session load, database, config, migration, SDK, generated file, EventV2 schema,
or v2 updater changes are planned.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Throwaway red harness queues two explicit 65,537-char responses and expects `stop` + `MessageOutputLengthError` + zero persisted text chars; current result is `continue` with 65,537 chars. | `text-delta` appends and publishes without a bound, and the empty-queue auto-`"ok"` never runs because both retry responses are scripted. | Add pre-delta cumulative bound and the retry/terminal error path. | Original user-visible overlong stream symptom under the full approved contract. |
| 2 | Real Processor test queues oversized response then `reply().text("recovered").stop()`; expect two calls, recovered text, no oversized/failed Part. | Current code makes one successful call; naïve throw after persistence leaves stale prefix. | Remove attempt Parts before first retryable APIError and reuse SessionRetry. | No contaminated Model history or mixed retry output. |
| 3 | Real Processor test queues oversized response twice; expect two calls and terminal `MessageOutputLengthError`, not a third request. | Existing retry policy accepts repeated retryable errors without a fixed cap. | Keep one semantic counter in current Processor call; second breach uses terminal named error. | Prevents infinite retry on deterministic overlong Provider output. |
| 4 | Tool-bearing over-limit fixture expects terminal error and no second Provider call. | Retrying could replay a Tool side effect. | Use the non-retryable OutputLengthError for the Tool-bearing branch after Part cleanup; leave EventV2 generation unchanged. | Side-effect safety without changing Tool lifecycle or v2 schema. |
| 5 | Plugin `experimental.text.complete` expands a sub-limit attempt beyond 64 KiB cumulative; current final write accepts it. | The hook mutates text after delta handling and before `session.updatePart`. | Recheck the same cumulative budget with the plugin-adjusted length before the durable write and `Text.Ended` publish. | Closes the reachable post-plugin bypass without a second policy. |
| 6 | Shared budget boundary tests: `32*1024` chars and `1000` lines remain Markdown; `32*1024+1` chars or `1001` lines reject. | No current shared predicate exists. | Pure predicate with short-circuit newline count. | Threshold drift and off-by-one regressions. |
| 7 | v1 rendered frame with oversized Markdown markers must show literal markers, proving plain text; normal short Markdown must keep existing projection. | Current v1 always creates Markdown/Code. | Branch before renderable construction. | User-visible v1 circuit breaker without normal Markdown regression. |
| 8 | v2 rendered frame repeats the same oversized/normal pair while keeping its existing failure compatibility. | Current v2 duplicates unconditional Markdown selection; EventV2 schema is already fixed. | Reuse the same utility and branch; do not change v2 generation or error schema. | Migration route parity without an unauthorized v2 migration. |
| 9 | Existing `other` recovery, normal empty stop, retry classification, v1/v2 route, and OpenTUI runtime tests remain green. | The repair touches common Processor and TUI text choices. | No changes to unrelated retry/Markdown branches. | No new regression outside the supported budget branches. |
| 10 | Memory-updater regression: `session.next.retried` stays no-op, a following `session.next.step.started` completes the stale Assistant, and `session.next.step.failed` stays terminal. | These are the reused EventV2 lifecycle contracts; a silent projector/updater drift would break the flag-on path. | No production change; lock the reused semantics with a focused updater test. | Flag-on retry lifecycle stays observable without new schema. |

Tests must observe `SessionProcessor.process`, persisted Parts, Provider call
count, and rendered character frames. They must not assert private helper call
counts or recreate the production predicate in the expected value.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | ---: | --- |
| Effective changed code lines `E` | approximately 250 including focused test code | Excludes imports, formatting, blank lines, generated files, and pure moves; adds cumulative-budget tests and the updater lifecycle regression. |
| Required qualifying Chinese comments `C` | at least 38 | `ceil(250 * 0.15)=38`; actual implementation must recalculate. |

Qualifying nearby comments must explain only non-obvious decisions:

- 64 KiB is a cumulative per-attempt character budget at the Processor text seam, not a Provider token limit.
- The crossing delta is rejected before `updatePartDelta` and current attempt Parts are removed so cleanup cannot write them back.
- Only the first no-Tool over-limit attempt enters existing retry; the second or Tool-bearing attempt is terminal to prevent replay loops/side effects.
- The renderer predicate is a deterministic supported-domain projection before Markdown construction, not parser-error fallback.
- Boundary tests use literal Markdown markers to prove plain-text rendering through the public frame.

Comments must be distributed beside these decisions and not used to restate
assignments or control flow.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "output length"` | `packages/opencode` | Red/green output-limit retry, cleanup, repeated-limit, and Tool-boundary behavior. |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "finish_reason=other|empty stop"` | `packages/opencode` | Existing semantic retry and recognized finish behavior remain green. |
| `bun test --timeout 30000 test/v2/session-message-updater.test.ts` | `packages/opencode` | Reused EventV2 lifecycle contracts stay locked: `retried` no-op, next `step.started` completes the stale Assistant, `step.failed` stays terminal. |
| `bun test --timeout 30000 test/session/message-v2.test.ts test/util/error.test.ts` | `packages/opencode` | Assistant error schema and Model replay exclusion; existing empty OutputLengthError contract remains green. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | v1 public frames, normal Markdown, and over-budget plain text. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | v2 public route parity and over-budget plain text. |
| `bun test --timeout 30000 test/cli/cmd/tui/session-pending.test.ts` | `packages/opencode` | Existing culling/status helper behavior remains unchanged because this plan does not modify it. |
| `bun typecheck` | `packages/opencode` | Package-local TypeScript correctness. |
| `bun test src/renderables/Code.test.ts src/tests/renderer.lifecycle.test.ts` | `thirdparty/opentui/packages/core` | Existing OpenTUI behavior remains green; no core changes are expected. |
| `bun D:\Temp\opencode\session-output-limit-red.ts` | `packages/opencode` | Original red harness passes after implementation; no database mutation. |
| Read-only SQLite size query | `packages/opencode` | Historical counts remain evidence only; command uses `readonly` database handle. |
| `git diff --check` | repository root | No whitespace errors. |

The 140,000-character Markdown benchmark remains a diagnostic baseline. After
the repair, the v1/v2 public frame tests prove that this input is classified as
plain text before CodeRenderable construction; no absolute wall-clock test is
used as the sole correctness gate.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | ---: | --- |
| Files added | 1 production | Shared TUI budget predicate only. |
| Files modified | 3 production | Processor, v1 route, v2 route; plus one added shared utility. |
| Files deleted | 0 | No obsolete module is introduced. |
| Production lines | 160 maximum estimate | Four small owner-local changes; below 400-line user limit. |
| Test lines | 160 to 240 | Existing Processor/TUI test files only; no test-only production seam. |
| Generated lines | 0 | No generated artifact, migration, SDK rebuild, or dependency. |

## 20. Real Risks and Open Decisions

### Real Risks

- The existing `SessionRetry` policy is intentionally unchanged; the Processor-local one-retry counter is necessary so repeated output-limit failures do not loop indefinitely under the existing no-cap policy.
- A Provider may emit a large delta in one chunk. The check must happen before appending or publishing that delta; otherwise the guard still allows one oversized event through.
- Part removal must clear `currentText` and `reasoningMap` after removal. Otherwise `cleanup()` can re-persist an already rejected Part.
- Plain text still renders the content itself. The safety improvement is removal of Markdown parser/highlight work, not truncation or content deletion; the generation bound prevents new content from growing without limit.
- Historical oversized SQLite rows remain unchanged and can still be expensive when an old Session is opened. This plan protects new streams and TUI Markdown construction; database repair is explicitly outside scope.
- Under `experimentalEventSystem=true`, the retried Assistant projection keeps the already-published sub-limit text of earlier completed Parts. This is byte-identical to the shipped `finish="other"` retry dual-write behavior — a documented boundary this repair reuses, not a new regression.
- Reasoning/Compaction/Tool/User rendering remains unchanged. Expanding the same budget to those routes would add new contracts not proven by the current red signal.

### Open Decisions Requiring the User

None. The plan uses the user's stated character-bound and existing retry/error
contracts. The independent auditor may identify evidence-backed blockers, but
must not widen scope merely because adjacent risks are conceivable.

### Rejected Speculation

- Model-specific limits are rejected: current database evidence supports one uniform Text Part limit, and Provider/Model IDs are not stable ownership boundaries.
- Repetition detectors and DSML/XML parsers are rejected: no repository producer/consumer requires them for this boundary, and they would add an unverified classifier/state machine.
- OpenTUI core lifecycle changes are rejected for this revision: the direct Markdown hot path can be bypassed at the TUI consumer, and no core edit is needed to satisfy the current requirement.
- Session-size branches, lazy-loading changes, database migrations, and historical scrubbing are rejected because the user explicitly forbids load-mechanism expansion and the red signal is at output production/render selection.
- A generic retry-policy attempt cap is rejected because it would alter unrelated network retry behavior; only this output semantic gets one local retry allowance.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct the complete current Producer -> LLM -> Processor -> Part -> retry -> Prompt path and both v1/v2 Text rendering paths.
- Treat this plan, builder transcript, temporary harness summary, and database summary as untrusted until verified from repository evidence.
- Audit all four behavioral requirements together: generation bound, first retry capture, terminal repeated/tool boundary, and Markdown plain-text projection.
- Require evidence for every blocking finding and reject findings that only describe speculative adjacent risks.
- Check that the plan repairs first divergence, does not add a fallback, keeps retry ownership in existing orchestration, and does not replay Tool side effects.
- Check both forward and reverse traceability, test sensitivity to the original red signal, exact file/line budget, and Chinese comment budget.
- Check that the plan does not modify Session load, database history, OpenTUI core, Provider SDK, config, migration, generated files, or unrelated retry behavior without a proven in-scope requirement.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 durable output limit bypassed by `experimental.text.complete`; B-02 legacy Part cleanup does not retract EventV2 text state; B-03 `MessageOutputLengthError` contract incomplete across legacy/v2/SDK paths. | Plan-only E/C estimate; verification should include post-plugin and EventV2 paths. | BLOCK | independent auditor task `ses_fe93f5eebffeiyKgTlhVJg36xE` |
| 2 | R2 | yes | B-01 first retry under EventV2 leaves a blank Assistant projection because `session.next.retried` is a live no-op; B-02 changing `OutputLengthError` data would drift the existing legacy public/SDK contract. | Post-plugin check must precede `SessionEvent.Text.Ended`; implementation must recalculate E/C. | BLOCK | independent auditor task `ses_fe93f5eebffeiyKgTlhVJg36xE` |
| 3 | R3 | yes | B-01 guard scoped to `experimentalEventSystem=false` leaves the flag-on Processor path unbounded and lacks an EventV2 retry/retraction/failure lifecycle spec; B-02 per-Part 64 KiB check misses cumulative multi-text-block output; B-03 red harness queues one response, so the approved retry contract never turns it green. | `updatePartDelta` is bus-only, not durable; E/C must be recalculated after implementation. | BLOCK | independent auditor task `ses_fe7b434c7ffeJDD7FqpMG80cnt` (after three empty invocations on `ses_fe8bcc5afffeJEIwHAgEZPv8L6`) |
| 4 | R4 | yes | No blocking findings. | §10.1 插件终检公式未显式写明 hook 收缩文本时计数器同步下调；公式正确，偏严不放开上限，留给实现审计核对。 | APPROVE | independent auditor task `ses_fe7b434c7ffeJDD7FqpMG80cnt` |

Any substantive revision invalidates earlier approval and requires a new
full-scope audit of the complete original requirement.

## 23. Implementation Evidence

Approved revision implemented: R4.

### Actual Files and Diff

Production (4 files, within the 6-file / 400-line budget):

- `packages/opencode/src/session/processor.ts` — flag-independent cumulative attempt budget (`ctx.attemptTextChars`, `OUTPUT_TEXT_LIMIT`), pre-publication delta guard, post-plugin final recheck with counter sync-down, pre-throw attempt Part removal plus live-state clearing, one semantic retry (`outputLimitRetried`, reset per `process()`), terminal `MessageError.OutputLengthError`; EventV2 dual-writes unchanged.
- `packages/opencode/src/cli/cmd/tui/util/text-budget.ts` (new) — pure `withinMarkdownBudget` + constants.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — v1 TextPart plain-text Match before Markdown/Code.
- `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` — v2 AssistantText same branch.

`message-error.ts` and all EventV2 schema/projector/updater/SDK files are untouched.

Tests (5 files): `processor-effect.test.ts` (+6 tests and scripted-LLM/plugin envs), `text-budget.test.ts` (new), `session-message-render.test.tsx` (+1), `session-v2-error.test.tsx` (+1), `session-message-updater.test.ts` (+1).

### Red-Green Test Evidence

- Harness `D:\Temp\opencode\session-output-limit-red.ts` (queues two 65,537-char responses): RED before (`continue`/65537) → GREEN after: `{"output":"stop","error":"MessageOutputLengthError","length":0}` with two HTTP calls observed in logs (requestID 1 and 2).
- `over-limit output retries once and recovers`: RED (calls=1, oversized persisted) → GREEN (calls=2, recovered only).
- `repeated over-limit output terminates`: RED (auto-"ok" third call → continue) → GREEN (stop, 2 calls, 0 text parts).
- `plugin-expanded text.complete final value re-checked`: RED (calls=1, oversized persisted) → GREEN.
- `cumulative multi-part text budget` / `tool-bearing over-limit`: pre-guard red state carried by harness + slice 2/3 red; post-impl GREEN (2 calls terminal / 1 call no-replay).
- v1/v2 frame tests: RED (marker concealed by Markdown branch, timeout) → GREEN (literal marker visible, in-budget control concealed).
- Updater lifecycle characterization test locks reused contracts; passed against unchanged production code.

### Verification Commands and Results

All from `packages/opencode` unless noted:

- `bun test --timeout 30000 test/session/processor-effect.test.ts` — 31 pass / 0 fail.
- `bun test --timeout 60000 test/cli/cmd/tui/session-message-render.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx test/cli/cmd/tui/session-pending.test.ts` — 104 pass / 0 fail.
- `bun test --timeout 30000 test/session/message-v2.test.ts test/util/error.test.ts` — 62 pass / 0 fail.
- `bun test --timeout 30000 test/v2/session-message-updater.test.ts` — 5 pass / 0 fail.
- `bun test --timeout 30000 test/cli/cmd/tui/text-budget.test.ts` — 3 pass / 0 fail.
- `bun test src/renderables/Code.test.ts src/tests/renderer.lifecycle.test.ts` (thirdparty/opentui/packages/core) — 73 pass / 1 skip / 0 fail.
- `bun typecheck` — pass.
- `bun D:\Temp\opencode\session-output-limit-red.ts` — GREEN contract result (process lingers on harness disposal; assertion did not throw).
- `git diff --check` — clean (pre-existing unrelated CRLF warnings on untouched files only).
- `bunx oxlint <changed files>` — blocked by pre-existing root `.oxlintrc.json`/oxlint version incompatibility unrelated to this diff; typecheck covers static correctness. Remaining unverifiable item.

### Original Feedback-Loop Result

Recorded above: RED pre-implementation, GREEN post-implementation under the full approved contract (two scripted over-limit responses → retry → terminal `MessageOutputLengthError`, zero persisted text chars).

### Actual Secondary and Replacement Path Inventory

- First no-Tool over-limit → existing retryable `APIError` → existing `SessionRetry`: implemented, delegates to existing orchestration.
- Repeated over-limit / Tool-bearing over-limit → existing `OutputLengthError` terminal: implemented diagnostic branches within existing contracts.
- Over-budget render → plain text projection: implemented supported-domain branch before parser-backed construction.
- No fallback, no second scheduler, no parser retry, no EventV2 protocol change.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | ---: | --- |
| Effective changed code lines `E` | 476 (58 production + 418 test) | Excludes blank, import-only, and comment-only lines; counted per file from `git diff -U0` plus new-file contents. |
| Qualifying Chinese comment lines `C` | 73 (29 production + 44 test) | All explain invariants, boundary semantics, retry/side-effect contracts, discriminator rationale, or fixture traps beside the decisions they protect. |
| Ratio `C / E` | 15.3% | Required `ceil(476 * 0.15) = 72`; 73 ≥ 72. |

### Remaining Unverifiable Items

- Full root `oxlint` remains blocked by the repository's pre-existing root-config/version incompatibility; targeted changed-file lint produced `0 errors / 49 existing warnings`, with no new error from this diff.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | No blocking findings. | (1) `cumulativeScript` 注释算术笔误（写 65,561，实际 fixture 66,561 字符），fixture 与断言行为正确且实测通过；(2) E 计数重算 479 vs 计划记录 476，为 brace/修改行统计口径差异，两种口径下 C=73 均满足 ceil(E*0.15)=72；(3) harness 进程断言通过后因 tmpdir disposal 挂起，合同结果与两次 HTTP 调用由审计亲自观察；(4) `oxlint` 因仓库预存 root 配置/版本不兼容无法运行，与本 diff 无关，已记录为 remaining unverifiable item。 | APPROVE | independent auditor task `ses_fe7b434c7ffeJDD7FqpMG80cnt` |
| 2 | R4 | yes | No blocking findings. | (1) flag-on EventV2 的 Processor 端到端超限测试仍不完整，但共享 flag-independent Processor 分支、EventV2 投影合同和现有 updater 特征测试均独立核对通过；(2) targeted oxlint 为 `0 errors / 49 existing warnings`，警告来自既有修改文件代码，未发现本 diff 新增 error；(3) output-limit harness 合同成功并观察到两次 Provider 请求，但 tmpdir disposal 后仍超时；(4) E/C 统计口径存在轻微差异，独立重算约 `E=479`、`C=73`，仍满足门禁。 | APPROVE | independent auditor task `ses_fe5dc0e37ffevXYm3sjLjBHRF1` |

The task may be marked `verified` only after the approved implementation is
complete and an independent full-scope implementation audit returns
`No blocking findings` for the actual diff.
