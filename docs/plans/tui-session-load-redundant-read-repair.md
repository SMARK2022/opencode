# Canonical Implementation Plan: TUI Session Load Redundant-Read Repair

> Status: verified
>
> Revision: R11
>
> Approved revision: R11
>
> Audit mode: implementation
>
> Requirement source: 用户本轮 Session GOAL 原始需求与后续澄清
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-08-14

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> “当前需要诊断我们已有session加载读取卡顿以及不合理的或者过于冗余的数据读取问题,同时避免大规模修改相应加载机制,保持精准的手术刀级别的点点修改即可,也就是尽涉及不超过四个文件,不超过两百行生产代码。同时不引入新的退化。”
>
> “请自行完整、准确地分析相应的根因,避免只是找到了一个潜在的原因。用理论来说,我们并不是全部session都加载完的,理论来说我们只会加载session的最后三百条,来进行相应的QA的,相应的显示等等内容,因此您需要自己进行检查,完整检查。”
>
> “不能额外增加不属于需求范围内的不合理的设计，譬如对大小session在生产代码路径作出区分；这类分支逻辑会埋下更多的问题；请避免这类操作；同时报告当前过于冗余，请你克制修改同时移除过时设计。”
>
> “showing first 100 不增加这样的表述……在最终加上...即可……也就是列表末尾。”

### Process Authorization

> “继续，同时我额外授权你进行6轮新的完整设计以及相应审计；注意保持珍惜且focus on the problem，不要形式化的只是为了满足审计；审计扩大需求的时候你需要检查并据理力争。”

This is process authorization for six additional complete design/audit rounds
after the six historical rounds recorded below. It does not widen the product
requirement, authorize size-based paths, or authorize implementation before an
approved revision.

## 2. Explicit Non-Goals

- 不改变最新 300 条 Message 的分页数量、顺序、cursor 或历史翻页行为。
- 不修改 Snapshot/Revert 的 git-patch 合同、7 天清理或 2MB Snapshot 上限。
- 不删除持久化的 per-user `summary.diffs`，不迁移或清理现有 SQLite 数据。
- 不改变 Tool Part、Text/Reasoning、Patch Part 的 wire 数据或 OpenTUI 渲染实现。
- 不按 Session 大小、文件数、字节数、耗时或内存状态选择不同生产路径。
- 不新增分页、配置、持久化 projection、migration、retry、fallback 或第二套数据源。
- 不修 footer token 聚合或 stale-turn 全量修复；目标 Session 证据未证明它们导致本次加载冻结。
- 不承诺现有 SummaryCache 单一 compressed aggregate 无需解压；消除该成本需要存储格式变化，超出 surgical scope。
- 不修订 session aggregate 的 patch 归并算法；其长期存储体积是独立问题，本任务只消除普通加载路径的冗余读取。
- 不增加 feature flag、备用端点、重试、fallback 或第二套分页实现。
- 不改 Web App；其 bounded messages 页面依赖 per-user `summary.diffs` 展示逐轮变更，本任务必须保持该完整 wire 合同。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message 是 MessageV2 + Parts；Snapshot 是 Revert 所用 git-patch 工作树状态，不是 Session 状态快照。v1 `session/` 是当前生产路径。 |
| `AGENTS.md` | 默认分支为 `dev`；必须并行工具；测试和 typecheck 必须从 package 目录执行。 |
| `packages/opencode/AGENTS.md` | Effect 与 Session 模块约定；测试不得从仓库根运行。 |
| `packages/opencode/test/AGENTS.md` | 使用真实 instance/DB fixture，避免 mocks；并发测试使用 readiness signal。 |
| `packages/opencode/test/server/AGENTS.md` | Server 路由行为应通过真实 HttpApi seam 验证。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复 first divergence，禁止下游补偿和备用成功路径；实现需满足 15% 中文解释性注释门禁。 |
| `docs/adr/README.md` | 本任务是现有接口的局部读取修复，不新增 load-bearing 架构决策，因此不新增 ADR。 |

## 4. Evidence And Current Path

| Evidence | Finding | Class |
| --- | --- | --- |
| live target `ses_041cd...` | newest 300 = 2.94MB/147ms/1230 Parts; `/diff` = 697 files/3.69MB/3.16M patch chars/772ms. | observed |
| live extreme `ses_138a...` | newest 300 = 125.1-131MB/5.2-9.9s, including 114.2MB user `summary.diffs`; `/diff` = 53.2MB/9.2s. | observed |
| exact DB/page ID comparison | response is exactly newest 300, not the complete Session. | observed |
| `message-v2.ts` / `handlers/session.ts` | bounded Message page thaws cold summaries; Message and diff default responses serialize complete data. | observed |
| `sync.tsx` | get/messages/todo/diff/status share one barrier; complete HTTP/SSE diff enters TUI store. | observed |
| `plugin/api.tsx` / `sidebar/files.tsx` | Files consumes only file/additions/deletions, but patch reaches store and every row is rendered. | observed |
| production Files frame with summary 101 and empty diff | renders no file rows but still renders final `...`; this is a false truncation marker. | observed |
| `Snapshot.FileDiff` + plugin adapter | persisted/imported entries may omit `file`; plugin state filters them after current viewer totals count them. | contracted/reachable |
| real Files component benchmark | 100/697/2055 rows add about 15.3/51.2/151.5MB RSS. | observed |
| DB compatibility probe | 34 of 628 compressed aggregate owners lack hot Session totals; truncation cannot assume summary exists. | observed |
| Web App/share inventory | default Message pages need per-user diffs; default diff/share need complete patches. | contracted/reachable |

```text
TUI open -> Promise.all(required resources + complete diff)
         -> Message cold summary thaw + complete diff patch decode/JSON
         -> only then publish history
         -> complete patch in store + unbounded Files rows
```

The 300 limit bounds Message count, not bytes, Parts, diff bytes or render nodes.
Solid lazy proxying is not the primary allocation source; response text/objects,
Message/Part trees and OpenTUI renderables amplify the payload.

## 5. Supported Domain And Invariants

All TUI Sessions follow one uniform viewer path. Shared/default HTTP, complete
transcripts and share/event producers remain complete.

| ID | Invariant | First divergence / owner |
| --- | --- | --- |
| INV-01 | TUI reads newest 300 Message infos and complete visible Parts without per-user summary payload; defaults remain complete. | `MessageV2.page` cannot select viewer info before cold thaw. |
| INV-02 | Session/Message/Part/Todo/Status publish before diff work starts. | `sync.session.sync` starts diff inside the visible-history barrier. |
| INV-03 | Every TUI diff normalizes to entries with a displayable `file`, carries/stores/renders at most 100 patch-free stats, and derives file/addition/deletion totals from that same displayable source; default complete contracts remain raw and complete. | HTTP adapter and SSE reducer currently count legacy entries that Files later filters, while a later full `session.updated` can overwrite the local normalized projection. |
| INV-04 | Existing Files default-open semantics remain; title uses normalized authoritative totals, and the list ends with `...` only when more than 100 displayable entries were actually capped. | Files currently infers truncation from persisted/raw totals versus visible rows, so error, legacy, and Revert event ordering can produce a false marker. |
| INV-05 | Resolved SDK HTTP error remains `data ?? []`; genuine rejection propagates after visible publication without full-sync marking. | Barrier movement must preserve caller-visible errors. |
| INV-06 | No size branch, fallback, public schema, generated code, migration, alternate source or fixed explanatory title text. | user/policy constraint. |

Red-capable baseline already run: target `2.94MB + 3.69MB/697 rows`; extreme
`125.1MB + 53.2MB`. Deterministic tests assert publication order, absence of
known large literals, `<=100` stored/rendered rows and conditional trailing
`...`.

## 6. Responsibility And One Primary Path

| Concern | Owner | Reason |
| --- | --- | --- |
| summary-free bounded Message | `MessageV2.page` + HTTP adapter | projection must happen before cold thaw/serialization; shared default cannot infer TUI intent |
| visible publication order | TUI SyncProvider | it owns request composition and store publication |
| patch-free capped HTTP diff | HTTP adapter | last owner before response text/JSON; shared SummaryCache remains complete |
| patch-free capped live diff | TUI reducer | first TUI-owned seam after shared SSE; shared event remains complete |
| displayable totals and trailing `...` | HTTP viewer + TUI reducer + Files sidebar | producers own normalization before totals/cap; Sync owns ordering against full Session updates; presentation only marks a proven 100-row cap |

```text
all TUI Sessions
  -> messages(viewer) -> MessageV2 viewer info before cold thaw
  -> await get/messages/todo/status -> publish visible state
  -> diff(viewer) -> authoritative load -> filter displayable entries
  -> normalized total headers + first 100 patch-free rows
  -> sync atomically writes the same-source totals and rows, including zero on resolved HTTP error
  -> once a viewer diff key exists, session.updated preserves that local viewer summary until the next session.diff
  -> Files stays default-open and adds final `...` only for 100 rows with total > 100
  -> live diff event applies the same normalization before totals and first 100
```

Header absence preserves complete Message and diff responses. The private
literal is repeated only at its two transport owners and locked by real HTTP/SDK
tests, avoiding a fifth four-line production module. Diff starts after visible
publication, so genuine rejection has a direct await; resolved HTTP errors keep
`data ?? []`. No catch/default or size-dependent behavior is introduced.

Viewer response headers always supply totals from the normalized authoritative
array and Sync updates only its existing local Session projection. For a
resolved HTTP error, the existing `data ?? []` contract is itself the current
source, so Sync atomically replaces stale Session totals with zero together with
the empty rows. No totals are guessed or persisted, and no response wrapper,
sentinel item or new public type is introduced.

Shared/default Message/diff, complete transcripts, Revert, Web App and share are
existing compatibility paths and remain unchanged. New alternate-success and
diagnostic shares are 0%. The current store-then-spread patch workaround is
collapsed by projecting to the existing `TuiSidebarFileItem` contract before
the TUI store.

## 7. Traceability And File Plan

| Invariant | Files | Behavioral test |
| --- | --- | --- |
| INV-01 | `message-v2.ts`, `handlers/session.ts`, `sync.tsx` | frozen Message viewer omits summary but preserves cold_ref/Parts; default returns/thaws full summary |
| INV-02 | `sync.tsx` | held required response proves diff has not started; release publishes history before diff request |
| INV-03 | `handlers/session.ts`, `sync.tsx` | default diff retains known patch; viewer HTTP/SSE normalize displayable entries, cap at 100 patch-free rows, and reconcile totals from the same source |
| INV-04 | `sync.tsx`, `sidebar/files.tsx` | default-open frame renders first 100 names and final `...` only when normalized source exceeds 100; total=100, legacy hidden entries, and empty error state have no marker |
| INV-05 | `sync.tsx` | resolved HTTP error yields `[]`/full-sync; malformed JSON rejects after history with no diff/full-sync write |
| INV-06 | all | no size predicate, public API, generated/config/migration file or fallback |

Reverse mapping: Message projection is required before cold thaw; HTTP projection
is required before response text/JSON; ordered sync is required because endpoints
cannot publish UI state; source normalization belongs at both viewer producers
because HTTP and SSE are distinct producers of the same TUI diff contract; Files
owns the final `...` because it alone owns visible list semantics. Error summary
reconciliation and `session.updated` ordering stay in Sync because it owns the
atomic rows/Session projection and receives both producer event types.

| Production file | Responsibility | Expected effective delta |
| --- | --- | ---: |
| `packages/opencode/src/session/message-v2.ts` | bounded viewer info before Message thaw | 25-40 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | exact viewer Message selection; normalized displayable totals and first-100 patch-free diff response | 20-34 |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | viewer headers, ordered publication, normalized HTTP/SSE source, error total reconciliation, Session update ordering and first-100 store | 55-86 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/files.tsx` | existing default-open rows, normalized totals in header, only-successful-cap trailing `...` | 10-22 |

Hard maximum: four production files, 200 effective production lines, no generated
or config changes. Existing tests change only in `session-messages.test.ts` and
`sync.test.tsx`. The obsolete untracked R4 constants file must be absent.

## 8. TDD And Verification

Vertical slices: (1) Message cold viewer/default; (2) diff viewer/default,
private total headers and 100-row cap; (3) required publication before diff start;
(4) HTTP/SSE store normalization, cap and full Session update ordering; (5) default-open Files
title/list/final `...`; (6) negative Files states for exactly 100 displayable
entries, raw legacy entries with no displayable file, and resolved error after
an old nonzero summary; (7) resolved versus genuine diff errors; (8) existing
complete-consumer regressions. Tests use public HTTP, real SDK transport,
readiness signals and OpenTUI frames, not helper call counts.

| Command | cwd | Evidence |
| --- | --- | --- |
| `bun test test/server/session-messages.test.ts` | `packages/opencode` | Message/diff projections and complete defaults |
| `bun test test/cli/cmd/tui/sync.test.tsx` | `packages/opencode` | order, caps, SSE, Files rendering and errors |
| `bun test test/session/message-v2.test.ts test/session/messages-pagination.test.ts test/session/summary-tool-diff.test.ts test/session/revert-compact.test.ts test/cli/tui/plugin-loader.test.ts` | `packages/opencode` | cold/page/summary/Revert/plugin compatibility |
| `bun typecheck` | `packages/opencode` | types |
| isolated daemon/TUI replay of both measured Sessions | `packages/opencode` | history first; bounded projected payload/store/render; default APIs complete |
| `git diff --check` | repository root | whitespace |

Estimated total effective production+test `E <= 300`; qualifying Chinese comment
lines `C >= ceil(E*0.15)` (45 at estimate; recalculate actual). Comments explain
cold/wire ownership, total-header/cap proof, publication order, shared-default
compatibility, final-ellipsis semantics and error-test topology.

## 9. Risks And Audit Contract

- Default HTTP/SDK/Web App/share responses must remain complete without the
  private header; viewer response must not use partial-summary casts.
- SummaryCache still decodes its one compressed aggregate before the HTTP viewer
  can strip patch and cap items. This is a disclosed storage residual, not a
  reason for size branches or a second projection store.
- Shared SSE serializes complete diff before TUI reduction. R11 normalizes only
  inside the TUI reducer; changing shared SSE would affect share consumers.
- Revert publishes `session.diff` before `session.updated`, while summary
  persistence publishes `session.updated` before `session.diff`; Sync must retain
  one local viewer projection across both existing producer orderings without
  changing the shared event or persisted Session summary.
- The target is idle with no incomplete Assistant. Footer whole-page accounting
  and stale Compaction are not evidenced first divergences for this repair.

Open decisions: none. Rejected expansion: full Session load, Snapshot redesign,
new aggregate persistence, size branches, default folding, pagination and
footer/stale-turn repair.

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, public wire
  compatibility and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02; B-02 withdrawn on reconsideration | file/comment budgets; live timing variability; residual diff transfer | BLOCK | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 2 | R2 | yes | B-01 schema shape, B-02 feedback path, B-03 header producer test, B-04 diff rejection test | file/comment budgets; residual diff transfer | BLOCK | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 3 | R3 | yes | B-01 cold-thaw behavior test sensitivity | file/comment budgets; residual diff transfer; corrected 4-file record | BLOCK | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 4 | R4 | yes | No blocking findings. | E estimate reconciliation; TUI header assertion wording; goal request outside measured hot path; residual Session diff transfer. | APPROVE | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 5 | R4 | yes | B-01 existing diff HTTP failure semantics were misclassified as rejection/retry contract. |  | BLOCK | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 6 | R5 | yes | B-01 delayed await could expose a fast genuine diff rejection as unhandled. |  | BLOCK | `ses_00879fbe6ffehH67nAb8iEzkPp` |
| 7 | R7 | no, withdrawn before invocation | user rejected size branch |  | WITHDRAWN | not invoked |
| 8 (additional 1/6) | R8 | yes | B-01 audit-limit evidence | R8 behavior/traceability otherwise clean | BLOCK | `ses_004cdf6c5ffeZhq0V8AHRrTnq7` |
| 9 (additional 2/6) | R9 | yes | No blocking findings. | R9 count corrected from additional 1/6; residual aggregate decode/shared SSE transfer; remove obsolete untracked constants module during implementation. | APPROVE | `ses_004cdf6c5ffeZhq0V8AHRrTnq7` |
| 10 (additional 3/6) | R10 | yes | B-01 normalized totals can be overwritten by reachable Revert `session.updated` after `session.diff` | Add Revert event-order coverage; no independent command rerun | BLOCK | `ses_003cb3c9dffeL0zLdwnRLEY1HT` |
| 11 (additional 4/6) | R11 | yes | No blocking findings. | Residual aggregate decode/shared SSE transfer; implementation verification pending | APPROVE | `ses_003c270e4ffeOXhbmGJyaOGLgP` |

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

The following evidence records the complete R11 implementation. R9 measurements
remain as historical baseline where noted; R11 replaces the false-truncation
behavior under the exact approved revision.

### Actual Files and Diff

- Production: exactly the four approved files: `message-v2.ts`,
  `handlers/session.ts`, `sync.tsx`, and `sidebar/files.tsx`.
- Tests: exactly `session-messages.test.ts` and `sync.test.tsx`.
- Production numstat is 190 added / 24 deleted; the effective production delta
  is 142 lines after the policy exclusions, below the 200-line hard maximum.
- The obsolete untracked `server/shared/session-message-projection.ts` artifact
  was deleted with explicit user authorization; repository search reports no
  remaining reference. No generated, config, migration, public API, persistence,
  pagination, size branch, fallback, or additional production file was added.

### Red-Green Test Evidence

- HTTP viewer diff RED returned no private total headers; GREEN returns exactly
  100 patch-free rows plus authoritative file/addition/deletion headers while
  the default response retains all 101 patches.
- Ordered sync RED started the diff request while the required Message response
  was still held; GREEN publishes Session/Message/Part/Todo/Status before the
  diff request starts and still awaits/rejects through the same sync call.
- Files RED lacked the authoritative `(101)`, `+5151 -5050`, and final `...`;
  GREEN renders 100 default-open rows, exact totals, and an independent final
  ellipsis without `showing first 100`.
- Cold Message behavior uses a real archived owner: GREEN proves viewer
  projection occurs before thaw, keeps all Parts, and leaves the default cold
  summary response complete. Resolved HTTP diff errors and malformed JSON
  rejection are separately locked through the generated SDK transport.
- R11 HTTP normalization RED returned raw `102` totals for 101 displayable files
  plus one missing-file legacy entry; GREEN preserves all 102 on the default
  response but returns 100 viewer rows and displayable totals 101/+5151/-5050.
- R11 client normalization RED let a leading legacy entry consume one of the
  100 store slots; GREEN filters before totals/cap for both HTTP transport and
  shared-SSE reducer input.
- R11 resolved-error RED kept old totals 101 beside empty rows; GREEN atomically
  commits the existing `data ?? []` projection as zero rows and zero totals.
- R11 Revert-order RED let full `session.updated` overwrite normalized totals;
  GREEN updates title/time while preserving viewer summary when an own diff key
  exists. The production Files frame RED rendered `...` with zero rows; GREEN
  only renders it after 100 rows and total >100, while exactly 100 has no marker.

### Verification Commands and Results

All commands ran from `packages/opencode` except the scoped Git checks.

- `bun test test/server/session-messages.test.ts --timeout 15000`: 7 pass, 0 fail.
- `bun test test/cli/cmd/tui/sync.test.tsx --timeout 15000`: 24 pass, 0 fail.
  It emitted the pre-existing missing temporary `kv.json` diagnostic; assertions
  and process exit succeeded.
- `bun test test/cli/tui/plugin-loader.test.ts --timeout 15000`: 11 pass, 0 fail.
- `bun test test/session/message-v2.test.ts test/session/messages-pagination.test.ts test/session/summary-tool-diff.test.ts --timeout 15000`:
  120 pass, 0 fail.
- `bun test test/session/revert-compact.test.ts --timeout 30000`: 16 pass, 0 fail.
  The two sequential restore cases also passed in earlier isolated reruns after
  a combined multi-suite run exhausted its 15-second per-test budget.
- `bun typecheck`: passed.
- Scoped `git diff --check`: passed.
- Temporary port 4197 has no listener after replay; no test server remains.

### Original Feedback-Loop Result

Post-change replay used the production `Server.Default().app.request` HttpApi
path against the daemon database via the repository-supported `OPENCODE_DB`
override. It did not write production or test files.

| Session / endpoint | Viewer result | Default result |
| --- | --- | --- |
| `ses_041cd...` Message, latest 300 | 2,869,230 B; 300 items; 0 user summaries | 2,943,671 B; 300 items; 4 user summaries |
| `ses_041cd...` diff | 9,506 B; 100 items; 0 patches; totals 697 / +54,245 / -2,268 | 3,685,946 B; 697 items; 697 patches |
| `ses_138a...` Message, latest 300 | 6,562,046 B; 300 items; 0 user summaries | 131,181,764 B; 300 items; 18 user summaries |
| `ses_138a...` diff | 11,674 B; 100 items; 0 patches; totals 3,282 / +701,056 / -859,837 | 53,211,795 B; 3,282 items; 3,282 patches |

This closes the measured redundant wire/object path without changing the latest
300 range or default complete contracts. The readiness test proves the visible
history publication order; the real OpenTUI frame test proves the bounded,
default-open 100-row renderer and conditional final ellipsis.

### Actual Secondary and Replacement Path Inventory

- Default HTTP/SDK/Web App Message and diff requests omit the private header and
  remain complete, as proved by behavior tests and both live default replays.
- TUI HTTP Message selects the hot viewer info before cold thaw; Parts remain on
  the existing single cold-aware decoder.
- TUI HTTP diff is capped and stripped before JSON serialization. Shared
  SummaryCache remains the sole authoritative aggregate owner.
- Shared SSE remains complete for share consumers; the TUI reducer applies the
  same displayable-source, 100-row patch-free projection and atomically
  reconciles local totals.
- Full `session.updated` remains authoritative for normal Session metadata. Once
  a TUI viewer diff projection exists, Sync preserves only its normalized local
  summary across either Summary or Revert event order; the next `session.diff`
  remains the sole writer of new viewer totals.
- Export/Revert/Provider unbounded Message consumers never select the viewer;
  `revert-compact` and Message/page/summary regression suites pass.
- Files remains open by default. It consumes authoritative totals, renders the
  capped rows, and adds `...` only when the total exceeds visible rows.
- Footer accounting, stale Compaction, Snapshot storage, generated SDK, Web App,
  public schema, pagination, and persistent aggregate format are unchanged.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 503 | Excludes blank, import-only, formatter-only, generated and pure-move lines across production and tests. Production-only `E=142`. |
| Qualifying Chinese comment lines `C` | 76 | Adjacent comments explain cold/wire ownership, compatibility, normalized source/cap invariants, event ordering, error topology and renderer semantics. |
| Ratio `C / E` | 15.11% | `76 / 503` |
| Required minimum `C` | 76 | `ceil(503 * 0.15) = 76`; actual exactly meets the gate. |

### Remaining Unverified Items

- SummaryCache still decodes the complete compressed aggregate before the HTTP
  handler can remove patches. Live replay confirms the remaining server cost
  (369 ms target; 1,853 ms extreme), but eliminating it requires the explicitly
  out-of-scope persistent projection/storage redesign.
- Shared SSE still transports the complete diff before the TUI reducer bounds
  store/render state; changing the shared event would alter share consumers.
- No automated full-screen interactive TUI RSS profile was captured after the
  repair. Real HttpApi payload replay, generated-SDK state tests, and production
  OpenTUI component frames cover the affected producer/consumer path; allocator
  RSS reclamation remains platform-dependent.

### R11 Correction Result

- The production Files frame was RED with summary totals 101 and empty rows;
  after R11 it renders no file row and no final `...`.
- The viewer HTTP handler and TUI reducer both normalize their source to
  entries with `file !== undefined` before totals and the 100-row cap. Default
  HTTP and shared SSE remain raw and complete for compatibility consumers.
- The HTTP sync transaction always submits the current projected summary.
  A resolved HTTP error therefore preserves its existing empty-diff semantics
  while replacing stale nonzero totals with zero in the same transaction.
- Negative behavior slices prove no ellipsis for exactly 100 displayable
  entries, for more than 100 raw legacy entries with at most 100 displayable
  entries, and after an HTTP error replaces an old nonzero summary with empty
  rows. The positive 101-displayable case must continue to render final `...`.
- A Revert-style event-order slice emits normalized `session.diff` followed
  by a full raw `session.updated` and prove the normalized totals remain in the
  TUI local Session projection. The opposite summary-style order continues to
  converge when its following `session.diff` writes the normalized totals.
- The ordering rule is bounded by existing state: only a Session with an own
  `session_diff[sessionID]` viewer projection retains its local summary. A
  Session without that key accepts the full update; the next `session.diff`
  remains the sole writer of new normalized diff totals.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | B-01 false `...` on resolved diff error and legacy missing-file entries | Missing negative Files cases; no independent command rerun | BLOCK | `ses_003e08e61ffev3L4OoH5LD8THm` |
| 2 | R10 | yes | B-01 normalized totals can be overwritten by reachable Revert `session.updated` after `session.diff` | Revert event-order test required; no independent command rerun | BLOCK | `ses_003cb3c9dffeL0zLdwnRLEY1HT` |
| 3 | R11 | yes | No blocking findings. | SummaryCache still decodes the complete aggregate; shared SSE remains complete until the TUI reducer; sync suite prints the existing temporary `kv.json` diagnostic while all tests pass. | APPROVE | `ses_003a4885cffeRsePevd0CpBlzJ` |

Independent auditor verdict for R11 (verbatim):

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> - `SummaryCache` 仍需先解压完整 aggregate，HTTP handler 才能移除 patch 并截断；这是已披露的存储格式残余，不影响本次 release。
> - shared SSE 仍传输完整 diff，TUI reducer 收到后才执行 projection；这是维护 share/shared SSE 完整合同的必要边界。
> - `sync.test.tsx` 打印了临时 `kv.json` 缺失诊断，但全部 24 个测试通过且进程正常退出，不构成验证失败。
>
> ## Release verdict
>
> **APPROVE**
>
> 该结论仅适用于当前实际 implementation diff 与 canonical plan **R11**。本轮 full-scope implementation audit 未发现 blocking defect。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
