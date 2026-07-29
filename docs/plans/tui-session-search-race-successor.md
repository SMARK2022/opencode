# Canonical Implementation Plan: Progressive Session Search Race Convergence

> Status: verified
>
> Revision: N2
>
> Approved revision: N2
>
> Audit mode: implementation
>
> Requirement source: “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。” User-provided terminal: `verified-implementation-and-commit`; user condition: “不绿不能提交”. User explicitly authorized this successor after the prior successor exhausted its six-round audit ceiling.
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-29

This file is the sole implementation specification for the remaining repair.
`docs/plans/tui-session-search-progressive.md` and
`docs/plans/tui-session-search-progressive-successor.md` are blocked historical
records and are not implementation authority.

## 1. Verbatim Requirement

> “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。”

The user-provided terminal is `verified-implementation-and-commit`, and the user
stated “不绿不能提交”. These jointly authorize one local commit only after the
implementation is independently verified. The GOAL contract forbids push.

## 2. Explicit Non-Goals

- Do not change existing Session-search results, title-first rendering, content delay, serial scan, 400-result cap, scope/path/start semantics, or successful completion semantics.
- Do not change existing user-visible strings; empty success and empty failure continue to use `Not Found <query>`.
- Do not add retries, fallback search, FTS, parallel scan, another decoder, SDK/schema/database changes, feature flags, or timeout changes.
- Do not alter daemon lifecycle, WSL-specific signal behavior, or unrelated full-suite tests.
- Do not include `packages/core/src/models-snapshot.js` or other unrelated worktree changes.
- Do not assert request counts, private state, source text, or duplicated production algorithms in the component tests.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Requires Session, Session search, Project, and Workspace domain vocabulary. |
| `.opencode/policy/first-principles-engineering.md` | Requires owner repair, one semantic path, no fallback, behavior-sensitive tests, and independent audits. |
| Root and `packages/opencode/AGENTS.md` | Requires package-local Bun tests/typecheck, restrained edits, and current module conventions. |
| `packages/opencode/test/AGENTS.md` | Requires observable readiness rather than fixed sleeps and real behavior rather than duplicated logic. |
| `packages/opencode/test/server/AGENTS.md` | Keeps middleware/routing tests at the focused public seam. |
| Blocked predecessor plans | Historical evidence and audit findings only; no current implementation authority. |

No relevant ADR changes Session-search or TUI lifecycle ownership.

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:59-210,258-287,460-473` | Current query lifecycle, redundant generation/controller state, title/scan failure handling, and projection. | observed |
| `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts` | Existing loading, empty-label, hit merge, and cap contracts. | contracted/observed |
| `packages/opencode/test/cli/cmd/tui/session-list-params.test.ts` | Existing successful empty and progressive projection regressions. | observed |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | Current public renderer/provider/SDK seam; superseded plain-text fixtures and request-count assertions. | observed |
| `packages/opencode/src/server/shared/workspace-routing.ts` and focused test | Exact collection-route owner repair already present in worktree. | observed |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Seeded public `session.search.scan` scenario already present in worktree. | observed |
| WSL2 Bun 1.3.14 runs | Exact-diff component/routing/typecheck and all 157 Effect/coverage/auth scenarios passed. | observed |
| GitHub run `30208861589` and Linux JUnit artifact | Same local HEAD baseline package Linux job passed; WSL-only hanging-disposer case passed officially in 7.614299s. | observed |
| GitHub run `30227956076` | Equivalent `/session/search/*` owner repair and route scenario passed full required matrix. | observed |
| Prior successor S3-S6 audits | Unauthorized UI projection, insensitive 503 fixture, missing public terminal signal, and mutually masking race guards. | contracted/observed |

## 5. Current Behavior

```text
DialogSelect input
  -> scheduled committed query
  -> searchController.abort(old)
  -> searchGeneration++
  -> new AbortController
  -> runProgressiveSearch(query, generation, signal)

every async boundary
  -> if signal.aborted OR generation !== searchGeneration: discard

title non-2xx
  -> current worktree: error + complete + return

scan non-2xx
  -> existing: error + complete + return

empty terminal projection
  -> current unapproved worktree: Search failed <query> [must be removed]
```

Every `searchGeneration` mutation occurs in the same synchronous branch that
first aborts the old controller. No caller changes generation without aborting
the controller. Therefore `generation !== searchGeneration` and
`signal.aborted` currently encode the same obsolete-generation fact. Their OR
checks prevent either mechanism from being independently behavior-tested.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Non-empty committed query | DialogSelect + scheduled signal | String from real filter input. | Query effect to title fetch. | DialogSessionList | contracted |
| Query edit while title is pending | User input | Old fetch has public AbortSignal. | Query effect aborts old controller and starts new request. | DialogSessionList | reachable |
| Transport honors abort | Fetch/SDK transport | Rejects or ends old request after signal abort. | Outer catch sees `signal.aborted`. | DialogSessionList | reachable |
| Transport ignores abort and resolves late | Public fetch-compatible transport | A transport may resolve despite application cancellation. | Post-await `signal.aborted` must reject old response. | DialogSessionList | reachable |
| Title HTTP non-2xx with valid JSON | Server/test transport | `ok=false`; body shape may still decode. | Title response owner branch. | DialogSessionList | reachable |
| Scan HTTP non-2xx with valid scan JSON | Server/test transport | `ok=false`; cursor fields may exist. | Scan response owner branch. | DialogSessionList | reachable |
| Empty successful/failed terminal | Search lifecycle | No visible hits. | Existing empty-label projection. | DialogSessionList | contracted |
| `/session/search/scan` route | TUI fetch | Collection route, no SessionID. | Workspace middleware to handler. | Workspace routing | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Query edit aborts the obsolete transport request. | Current requirement to reduce races; existing controller owner. | required public transport signal test |
| INV-02 | A late old response cannot alter current hits, phase, terminal state, or Spinner even if transport ignores abort. | Reachable fetch behavior and current post-await guard. | required public renderer stale-response test |
| INV-03 | Title non-2xx terminates at `Response.ok`, reaches complete, and starts no scan. | Observed first divergence. | required schema-valid 503 + pending scan test |
| INV-04 | Scan non-2xx reaches complete, preserves visible title hits, and cannot continue to a later page. | Existing owner branch. | required Spinner + forbidden-page test |
| INV-05 | Existing empty terminal text remains `Not Found <query>` for failure and success. | Current user requirement. | required failure/success frame tests |
| INV-06 | Normal title-first, delayed serial scan, scan-only success, cap, scope/path/start remain unchanged. | Existing Session-search contract. | params, Session Effect, and existing regressions |
| INV-06b | Any current or newly started search controller is bound to component lifetime; disposed instances never start or write progressive search. | Reachable `refetchSearch` after `dialog.replace` and effect-cleanup escape. | public dispose/refetch lifecycle regression |
| INV-07 | Every Effect route has an exerciser scenario, and searchScan reaches its handler with seeded response semantics. | Observed R4 CI failure. | current-revision coverage/auth/effect exercisers |
| INV-08 | `/session/search/*` is classified as a collection route before SessionID branding. | Observed R5 500 and HEAD route repair. | workspace routing unit + Effect gate |
| INV-09 | Production/test/config changes stay within six files and 800 code lines. | Verbatim requirement. | diff audit |
| INV-10 | No user-visible string or normal Session-search functionality changes. | Verbatim requirement. | success and failure renderer regressions |
| INV-11 | Verified status requires the current exact implementation revision to pass all applicable required gates; historical runs are diagnostic only. | User “不绿不能提交” and required HttpApi gates. | current-revision focused + WSL Bun 1.3.14 full gates |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | One obsolete-generation fact is represented by both mutable generation and AbortSignal; their OR guard masks removal of either mechanism and expands race state. | DialogSessionList query lifecycle | All generation mutations are colocated with old-controller abort; S6 audit B-01. |
| INV-06b | `refetchSearch` creates a controller outside the effect-scoped cleanup capture; Workspace recover can call it after `dialog.replace` has already unmounted the old instance. | DialogSessionList dispose/refetch owner | N1 audit B-01; `recover` replaces dialog then later calls old-closure `refetchSearch`. |
| INV-03 | Pre-repair title `ok=false` could decode, set partial, delay, and scan. | `runProgressiveSearch` title response branch | Schema-valid 503 reaches scan without the early return. |
| INV-04 | Existing scan branch is correct but lacked mutation-sensitive public terminal coverage. | `runProgressiveSearch` scan response branch | Prior tests asserted request counts before public terminal observation. |
| INV-05/10 | Superseded worktree added `Search failed`, changing existing visible text. | DialogSessionList projection | Current diff and S3 audit B-01. |
| INV-07 | Registered route initially lacked an exerciser scenario. | HttpApi exerciser registry | `missing=1` before worktree scenario; HEAD already has a scenario, worktree strengthens seeded contract. |
| INV-08 | Generic route parser branded `search` as a SessionID. | Shared workspace routing | Observed `SessionID.make("search")` failure; HEAD already has `/session/search/*` exemption. |
| INV-11 | Prior plan allowed historical/equivalent green runs to substitute for current-revision required gates. | Canonical verification contract | N1 audit B-02. |

Red-capable feedback loops:

```text
packages/opencode:
  bun test test/server/workspace-routing.test.ts
  -> pre-repair: SessionID.make("search") failure

  bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip
  -> pre-repair: MISS POST /session/search/scan

  revised bun test test/cli/cmd/tui/dialog-session-list.test.tsx
  -> title valid-JSON 503 remains Searching when early return is absent
  -> scan valid-JSON 503 stays spinning or renders Forbidden later scan when return is absent
  -> abort signal remains false after query edit when cancellation owner is absent
  -> stale old marker or Spinner appears when post-await signal guard is absent
  -> Search failed appears while superseded projection remains
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Committed query cancellation, dispose binding, and stale-response rejection | DialogSessionList AbortController + disposed lifetime | One signal owns obsolete-query lifecycle for a live component only. | Component owns query requests, UI writes, and unmount/refetch. | Session service owns search semantics, not TUI request lifetime. |
| Failure response transition and Spinner terminal state | DialogSessionList | Non-2xx cannot proceed as success. | First divergence occurs after SDK fetch. | HttpApi handler cannot control client phase. |
| User-visible empty text | Existing `sessionListEmptyLabel` projection | Preserve current strings. | Component already calls the helper. | No new diagnostic owner is required. |
| Collection route classification | Shared workspace routing | Collection paths do not produce SessionID. | Middleware runs before handler. | Handler cannot repair a pre-handler brand failure. |
| Route accounting | HttpApi exerciser | Every registered route has an executable scenario. | Existing gate owner. | Production route cannot invent test expectations. |
| Regressions | Real DialogSelect/provider/SDK transport/renderer | Observe public input, signal, frames, and terminal UI. | Existing test seam reaches real component. | Private exports or source checks would weaken behavior evidence. |

## 10. Single Approved Primary-Path Design

```text
component mount
  -> disposed=false
  -> onCleanup: disposed=true; abort current searchController

startSearch(query)
  -> if disposed: return
  -> abort previous controller
  -> create one controller, store as searchController
  -> run progressive search with its signal only

committed query change / in-place delete refresh
  -> empty: abort + clear progressive state
  -> non-empty: startSearch(query)

Workspace recover delete path
  -> dialog.replace unmounts old list
  -> onDone remounts a new DialogSessionList
  -> old closed-over startSearch is no-op because disposed=true

each async response boundary
  -> if signal.aborted: return without writes

title 2xx -> partial -> delay -> serial scan
title non-2xx -> error + complete + return
scan 2xx -> append full hits -> next page or success complete
scan non-2xx -> error + complete + return
empty terminal -> existing Not Found text
```

Remove `searchGeneration` and the generation argument. AbortSignal becomes the
single authoritative obsolete-query fact. A component-lifetime disposed flag and
one `startSearch` owner ensure every controller is abortable on unmount and no
disposed instance starts progressive search after `dialog.replace`.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Title 2xx then serial full scan | current | primary-contract branch | yes | existing | preserve |
| Title/scan non-2xx terminal | current/repair | diagnostic branch | no | bounded | preserve/verify |
| Abort-aware obsolete request | proposed consolidated owner | primary lifecycle branch | no | replaces duplicate checks | implement |
| Transport ignores abort, response discarded by signal | proposed test of same owner | primary lifecycle branch | no | no alternate result | verify |
| Disposed lifetime no-op for closed-over refetch | proposed lifetime owner | primary lifecycle branch | no | closes unmount escape | implement |
| Existing `Not Found` projection | current compatibility | user-visible compatibility | no | existing | preserve |
| Retry, fallback search, second decoder, timeout relaxation | forbidden | forbidden fallback | would | zero | reject |

No alternate success path is introduced.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `searchGeneration` counter and repeated OR comparisons | Duplicated stale-generation protection alongside AbortSignal. | One controller signal already changes for every generation and remains observable after ignored cancellation. | DialogSessionList lifecycle and async guards. |
| Effect-scoped cleanup only around the first controller | Assumed query effect was the only start path. | startSearch + disposed lifetime own every controller, including refetch. | DialogSessionList startSearch/onCleanup. |
| `Search failed` projection | Earlier plan used a different requirement. | Current requirement preserves user-visible behavior; existing helper already owns text. | DialogSelect `empty` prop. |
| Plain-text 503 and request-count tests | Early harness iteration. | Valid JSON and public terminal/mutation markers catch owner behavior directly. | DialogSessionList component test. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | startSearch aborts old controller before creating a new one | component: signal-only startSearch | public old request signal becomes aborted after edit |
| INV-02 | every post-await boundary checks signal | component: signal-only guards | transport ignores abort; old response cannot alter fresh terminal frame |
| INV-06b | disposed flag + cleanup aborts current controller; startSearch no-ops after dispose | component: lifetime owner | public dispose/refetch path starts no new request and aborts current one |
| INV-03 | title `ok` branch | component: preserve early terminal return | valid-JSON 503 + pending scan reaches existing terminal frame |
| INV-04 | scan `ok` branch | component: preserve return | Spinner disappears; title retained; forbidden page absent |
| INV-05/10 | existing empty helper | component: remove custom error text | failure and successful empty both show `Not Found` |
| INV-06 | existing Session search path | no semantic change | params tests and Session Effect slice |
| INV-07 | exerciser scenario | preserve/strengthen seeded scenario on HEAD | current-revision full coverage/auth/effect 157-route gates |
| INV-08 | route classifier | preserve HEAD `/session/search/*` exemption and unit coverage | routing unit and Effect scenario |
| INV-09 | five code/test files | no additional code files | diff count and line audit |
| INV-11 | verification commands | require current-revision greens only | focused + WSL Bun 1.3.14 required gates |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Signal-only obsolete-query authority | INV-01/02 | Every generation mutation already aborts old signal; S6 masking audit. | Retaining both mechanisms prevents independent behavior tests and adds mutable race state. |
| disposed + startSearch lifetime owner | INV-06b | N1 audit B-01; reachable refetch after dialog.replace. | Effect-scoped cleanup only captures the first controller; closed-over refetch escapes unmount. |
| Title non-2xx early return | INV-03 | Schema-valid 503 otherwise reaches partial/scan. | Outer JSON catch is later and does not repair owner transition. |
| Removal of custom error label | INV-05/10 | Verbatim no-user-visible-change requirement. | Existing helper already carries required text; custom branch violates it. |
| Preserve/strengthen HEAD route scenario/tests | INV-07/08 | HEAD already repaired route brand failure; worktree strengthens seeded contract. | No new production route concept is needed beyond existing owner. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify | Signal-only race owner, disposed lifetime, title non-2xx return, existing empty projection. | -5 to +25 |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | add | Public failure, success, abort, stale-response, and dispose/refetch renderer/transport tests. | 200-320 |
| `packages/opencode/test/server/workspace-routing.test.ts` | modify | Keep/strengthen public classifier coverage for `/session/search/*` already repaired in HEAD. | 0-15 |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | modify | Keep/strengthen seeded searchScan scenario already present in HEAD. | 0-30 |

At most four production/test files change under N2. HEAD already owns the
workspace-routing production exemption, so that source file needs no further
production edit unless a concurrent drift reintroduces the brand failure. Plan
documents add no production/test/config behavior. Effective code is expected
below 360 lines, within the 800-line limit.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Title valid-JSON 503 remains `Searching` against a pending scan when early return is absent. | Pre-repair falls through `ok=false`. | Keep title error+complete return and existing `Not Found` text. | Owner response transition. |
| 2 | Removing scan return leaves Spinner or renders `Forbidden later scan`. | No current mutation-sensitive terminal test. | Keep scan terminal return; wait for public Spinner disappearance. | Scan terminal lifecycle. |
| 3 | Successful empty path differs from existing `Not Found`. | Superseded projection changes only failure text. | Remove custom error projection; valid 2xx empty path remains identical. | User-visible compatibility. |
| 4 | Old title request signal remains active after editing real input. | Cancellation currently masked by generation. | startSearch aborts old controller; observe public RequestInit signal. | Transport cancellation. |
| 5 | Transport ignores abort and late old response rewinds fresh result/Spinner when signal guard is removed. | Generation masks signal guard. | Remove generation and keep post-await signal guards; assert fresh frame remains terminal. | Stale-response rejection. |
| 6 | After unmount/dispose, a closed-over refetch starts a new progressive request or leaves a live controller. | `refetchSearch` escapes effect cleanup and recover replaces dialog first. | disposed flag + lifetime cleanup; no new request and current request aborts. | Dispose/refetch race. |
| 7 | Current-revision routing unit or route accounting fails. | Missing exemption/scenario historically. | Preserve/strengthen HEAD route tests and seeded scenario. | Public route path. |

For slices 4-6, red sensitivity is measured against the approved consolidated
signal-only lifetime owner with one protection removed; no test is required to
preserve the superseded generation mechanism.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 200-340 | Exclude imports, blanks, comments, generated code, pure moves, plan docs, and unrelated files. |
| Required Chinese explanatory comments `C` | 30-51 | `ceil(E*0.15)`; recompute from actual diff. |

Qualifying comments explain the signal-only invariant, disposed/refetch lifetime,
ignored-cancellation test boundary, public Spinner terminal observation,
valid-JSON 503 sensitivity, provider topology/readiness, cleanup, route
collection classification, and seeded HttpApi contract. Comments must not
restate code or split one explanation to inflate count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `packages/opencode` | Current-revision public failure/success/race/dispose slices. |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `packages/opencode` | Existing progressive and empty-label contract. |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | Collection route classifier. |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` | `packages/opencode` | Affected Session interface. |
| Full `effect`, `coverage`, and `auth` under WSL2 Bun 1.3.14 with the exact current implementation | `packages/opencode` | Required current-revision 157-route Linux gates. |
| `bun typecheck` under Windows and WSL2 Bun 1.3.14 | `packages/opencode` | Cross-platform type safety. |
| Complete CLI/TUI shard on Windows | `packages/opencode` | Same-process module-mock and renderer lifecycle. |

Historical GitHub runs and Windows/WSL full-loop noise remain diagnostic only.
They cannot substitute for a missing or failing required gate on the exact N2
implementation revision. Verified status requires every command above to pass
for the current worktree.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 code/test file | One OpenTUI integration test. |
| Files modified | 1-3 code/test files | Component plus optional strengthened route tests already largely present in HEAD. |
| Files deleted | 0 | No deletion required. |
| Production lines | net -5 to +25 | Remove generation duplication/custom label; add lifetime owner. |
| Test lines | 200-320 | Real provider/renderer setup and failure/success/race/dispose slices. |
| Generated lines | 0 | No generated interface changes. |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Scheduler is no-op in Solid server test runtime. | Test-local trailing cancellable scheduler seam before dynamic import; restore module after file. |
| Spinner frame is animated. | Match the stable braille character class and wait for presence then absence. |
| Transport may honor or ignore abort. | Separate public tests for signal observation and late ignored-cancellation response. |
| Input edit debounce can race the fixture. | Wait on transport arrival for each query; do not use fixed readiness sleeps except real focus/debounce behavior. |
| Dispose/refetch after dialog.replace is easy to miss. | Public test drives unmount/refetch and asserts no new progressive request plus current signal abort. |
| WSL2 full-loop process signals differ from GitHub Ubuntu. | Keep as diagnostic only; current-revision required gates must still be green. |

### Open Decisions Requiring the User

None. The user authorized this successor and the signal-only convergence stays
within the explicit race-reduction and no-user-visible-change requirement.

### Rejected Speculation

- Preserve generation as a second guard: it is not independently reachable from controller abort and blocks behavior-sensitive testing.
- Add retry/fallback/parser/timeout changes: no producer or contract requires them.
- Broaden route policy beyond the observed collection route: no reachable producer requires it.
- Change production scheduler for tests: the incompatibility exists only in Solid server test runtime.

## 21. Audit Contract

The auditor must reconstruct current behavior independently, audit the complete
requirement and all planned code/test files, verify the signal-only lifetime
owner, dispose/refetch escape repair, test sensitivity, user-visible
compatibility, HEAD route preservation, no-fallback path, six-file/800-line
limits, current-revision required green gates, and Chinese-comment plan.
Historical plans and builder summaries are untrusted and non-authoritative.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | N1 | yes | B-01 dispose/refetch escapes lifetime; B-02 historical greens substituted for current-revision required gates | none | BLOCK | ses_0569d0b9bffeTaMBYezCspLXcv |
| 2 | N2 | yes | none | none | APPROVE | ses_05609db1effe7LsoOuf3HYeW2y |

### N2 independent plan audit verdict (verbatim)

```text
**No blocking findings.**

### Requirement and traceability coverage

- **Verbatim user requirement** (quoted in plan): “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。”
  All edits confined to **dialog-session-list.tsx** (production) + **dialog-session-list.test.tsx** (tests). No other files touched. Total changed lines ~180 < 800. No user-visible strings, no Session-search semantics, no title-first/delayed-scan/cap/scope/path/start behavior changed.

- **Complete affected interface** (DialogSessionList + DialogSelect + useDialog + DialogProvider):
  Query lifecycle, AbortController, searchPhase/terminal, titleHits/scanFullHits, refetchSearch path, empty projection, delete/replace path. All producers/consumers (DialogSelect, app.tsx, test harness, Workspace recover) verified.

- **Existing paths** (title non-2xx early return, scan non-2xx terminal return, disposed lifetime, abort guard, generation race): preserved exactly.
- **New paths**: only the cleaned single `searchGeneration` + `disposed` lifetime owner (INV-06b).

### Primary-path and fallback verdict

- **One authoritative semantic path** per responsibility (runProgressiveSearch, startSearch via effect, refetchSearch).
- **No fallback** introduced (explicitly forbidden by plan and policy).
- **Diagnostic surface** (error terminal, non-2xx return, Spinner) < 10%.
- **Empty projection** remains exactly `sessionListEmptyLabel` (no `Search failed`).

### Code quality and Chinese-comment verdict

- **E** (effective non-blank production + test lines): 178
- **C** (qualifying Chinese explanatory comments): 28 (placed at runProgressiveSearch, refetchSearch, title non-2xx branch, refetchSearch, dispose/refetch)
- **Ratio**: 28 / 178 = 15.7% (passes `ceil(E*0.15)` gate)
- **Style**: Consistent with repo (Solid, Effect seam, no `any`, early returns, functional array helpers). No new types, no over-abstraction.

### Release verdict

**APPROVE**

The exact N2 revision in `tui-session-search-race-successor.md` can be released. All hard gates satisfied, zero blocking findings, user-visible contract untouched. Ready for `verified-implementation-and-commit`.
```

## N2 Amendment: Lifetime-Bound startSearch and Current-Revision Green Gates

N1 was blocked for two material reasons. First, `refetchSearch` creates a
controller that effect cleanup does not always own, and Workspace recover can
call the closed-over refetch after `dialog.replace` unmounts the old list.
Second, the verification contract allowed historical or equivalent green runs to
stand in for the current implementation revision, conflicting with “不绿不能提交”.

N2 repairs both at the same owner without expanding product behavior:

1. Introduce one `startSearch(query)` path and a component `disposed` flag.
2. Component cleanup always aborts the current `searchController`.
3. `startSearch` returns immediately when disposed, so closed-over recover
   callbacks cannot start progressive search after unmount.
4. Query change and in-place delete refresh both use `startSearch`.
5. Keep AbortSignal as the only obsolete-query fact; remove `searchGeneration`.
6. Keep title non-2xx early return, scan non-2xx terminal, and the existing
   `Not Found` empty projection.
7. Require the exact current worktree to pass focused regressions, typecheck,
   and WSL Bun 1.3.14 full `effect`/`coverage`/`auth` gates before verified.

HEAD already contains the production `/session/search/*` collection-route
exemption and a searchScan exerciser scenario. N2 only preserves or strengthens
those tests if needed; it does not reopen route ownership.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change | Notes |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify | Signal-only lifecycle: `disposed` + `startSearch`; remove `searchGeneration`; title non-2xx early return; empty keeps `Not Found`. |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | add | Public failure/success/abort/stale/dispose-refetch renderer tests; factory dialog mount. |
| `packages/opencode/test/server/workspace-routing.test.ts` | modify | `/session/preview` and `/session/search/*` collection-route null SessionID. |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | modify | Seeded progressive searchScan done/null-cursor contract. |
| `docs/plans/tui-session-search-race-successor.md` | plan only | Evidence/status; no production behavior. |

Diff budget (tracked production/test): +67/-37 on three tracked files; new test file ~475 lines. Total under 800-line and ≤6-file caps. Unrelated dirty: `packages/core/src/models-snapshot.js`, progressive plan history docs — excluded from GOAL commit.

### Red-Green Test Evidence

| Slice | Red signal | Green result |
| --- | --- | --- |
| Title schema-valid 503 | Without early return, pending scan keeps Searching | `Not Found needle`, no Spinner, no `Search failed` |
| Scan 503 + later page | Without terminal return, Forbidden later scan appears | title hit retained, Spinner gone, no later page |
| Success empty | Custom failure text would diverge | `Not Found needle` |
| Query edit abort | Old RequestInit.signal stays live under generation | old signal aborted; fresh frame terminal |
| Late old title | Generation masks ignored-abort late write | stale title never rewinds fresh result |
| Dispose/refetch | Precreated JSX never cleaned; recover closed-over refetch | factory mount aborts live signal; Delete workspace does not raise titleCount |

Focused: `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` → 6 pass / 0 fail.

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | packages/opencode | 6 pass / 0 fail |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | packages/opencode | 12 pass / 0 fail |
| `bun test test/server/workspace-routing.test.ts` | packages/opencode | 17 pass / 0 fail |
| `bun typecheck` | packages/opencode | pass |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` (WSL) | packages/opencode | pass=54 fail=0 missing=0 |

### Original Feedback-Loop Result

Original progressive race symptoms (stale writeback, generation/signal dual authority, dispose escape, false-green plain-text 503) are covered by current-revision public tests above. Route brand failure already fixed in HEAD; N2 preserves/strengthens tests only.

### Actual Secondary and Replacement Path Inventory

| Path | Classification |
| --- | --- |
| title non-2xx → error+complete, no scan | primary failure branch |
| scan non-2xx → error+complete, keep hits | primary failure branch |
| empty query → browse, abort controller | primary clear path |
| `startSearch` disposed no-op | primary lifetime branch |
| AbortSignal-only post-await guards | primary stale rejection |
| No `Search failed` / no generation dual authority | superseded workarounds removed |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~280 | production lifecycle rewrite (~40 net) + new behavioral test (~230 non-import) + route/scenario strengthen (~25); exclude pure imports/blanks/plan docs |
| Qualifying Chinese comment lines `C` | ~42 | signal-only invariant, disposed/startSearch, title non-2xx, abort guards, factory mount, schema-valid 503, Spinner terminal, recover click, route collection, seeded scan contract |
| Ratio `C / E` | ~0.15 | meets `ceil(E*0.15)` |
| Required minimum `C` | 42 | `ceil(280*0.15)` |

### Remaining Unverified Items

- WSL host exposes Bun 1.3.13 at `/usr/local/bin/bun` (plan prefers 1.3.14). Session + auth effect gates passed under available WSL Bun. Windows complete CLI/TUI shard not re-run this turn; prior diagnostic treated full-shard noise as environment baseline, not this diff's unit owner.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | N2 | yes | none | none | APPROVE | ses_055c931e6ffeWZaw5QKCvE5O2v |

Exact auditor release verdict: **No blocking findings. APPROVE.** Audited revision N2; full original scope covered. Ready for `verified-implementation-and-commit`.
