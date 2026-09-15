# Canonical Implementation Plan: Progressive Session Search CI and Failure-Terminal Completion

> Status: blocked
>
> Revision: S6
>
> Approved revision: none
>
> Audit mode: plan
>
> Requirement source: “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。” User-provided GOAL parameter: “目标终态：verified-implementation-and-commit”. User commit condition: “不绿不能提交”. Commit only after verified; no push.
>
> Implementation allowed: no
>
> Last updated: 2026-07-27

This successor plan replaces the blocked historical plan
`docs/plans/tui-session-search-progressive.md` as the sole implementation
authority for the remaining working-tree repair. It preserves the complete R3
progressive Session-search contract, the R4 HttpApi route-coverage repair, and
the R5 workspace-routing repair, while making title/scan failure tests
behaviorally sensitive without changing existing user-visible text or normal
Session-search functionality.

## 1. Verbatim Requirement

> “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。”

The target terminal is `verified-implementation-and-commit`. The GOAL contract
and the later user instruction “不绿不能提交” jointly authorize one local commit
only after verified implementation. The GOAL contract explicitly forbids push.
The six-file and 800-code-line limits govern production/test/config code; the
canonical plan records evidence but adds no runtime behavior.

## 2. Explicit Non-Goals

- Do not change the intended progressive search semantics: title first paint, serial full-condition candidate scanning, 400 result cap, path/start scope, debounce/content delay, or generation cancellation.
- Do not add FTS, a materialized search table, migration, SSE, WebSocket streaming, parallel scan, browse-cache narrowing, or `searchMode=all` fallback.
- Do not change Session search SQL, the HttpApi schema, generated SDK, workspace route policy, database schema, retry policy, or timeout values.
- Do not change existing user-visible strings or the successful empty-search `Not Found <query>` behavior.
- Failed title/scan requests may terminate internal loading and request work, but an empty failure keeps the existing `Not Found <query>` projection.
- Do not assert private state, source text, or request call counts in the new component regression.
- Do not include the unrelated `packages/core/src/models-snapshot.js` worktree modification.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Session, Session search, Project, Workspace vocabulary | Preserves domain terms and distinguishes Project/Workspace/Session ownership |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, no fallback, bounded evidence, and independent audits |
| `docs/plans/tui-session-search-progressive.md` | Blocked historical R3-R8 evidence, prior route repair, and audit ceiling; not implementation authority after this successor is approved |
| `packages/opencode/AGENTS.md` | Package-local tests/typecheck and module rules |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | Existing HttpApi group/handler ownership |
| `packages/opencode/test/server/AGENTS.md` | Public HTTP/test seam and scoped fixture guidance |
| `packages/opencode/test/cli/cmd/tui` existing OpenTUI harnesses | Real renderer, provider stack, SDK test transport, and cleanup conventions |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:40-183,253-282,452-464` | Progressive request lifecycle, title/scan response handling, terminal state, and empty-label projection | observed |
| `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts:1-129` | Search phases, loading state, empty labels, display-hit projection | observed/contracted |
| `packages/opencode/test/cli/cmd/tui/session-list-params.test.ts:50-128` | Existing phase, Spinner, successful empty, and retained-hit assertions | observed |
| Existing OpenTUI harnesses `dialog-prompt.test.tsx`, `session-exit.test.tsx`, `prompt-submit-transport.test.tsx`, `sync-fixture.tsx` | Real provider and `SDKProvider.testTransport` seam for new failure tests | observed |
| `packages/opencode/src/session/search.ts`, `src/session/session.ts:340-364,1029-1106` | Title/all search contract and full-condition keyset scan | contracted/observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:204-247,677-689` | `POST /session/search/scan` public contract | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:88-103,673` | Request-to-Session service handler path | observed |
| `packages/opencode/src/server/shared/workspace-routing.ts:20-32` | R5 exact collection-route classification repair already present in worktree | observed |
| `packages/opencode/test/server/workspace-routing.test.ts:33-58` | R5 routing regression already present in worktree | observed |
| `packages/opencode/test/server/httpapi-exercise/index.ts:1371-1410` | R4 public seeded route scenario already present in worktree | observed |
| Local red routing test and focused Effect traces | R5 first divergence and green route behavior | observed |
| CI run `30208861589` Ubuntu effect log | The pre-repair run exercised 156 existing routes; the current registry has 157 and the only missing pre-repair scenario was `searchScan` | observed |
| R6 implementation audit `ses_0606b900dffeid8FbmZ2ENRdue` | Full-scope B-01: title non-2xx falls through to scan | observed |
| S3 plan audit `ses_056ea98ddffexdYLj3scYJlGoK` | B-01 current requirement forbids the added `Search failed` projection; B-02 plain-text title 503 can reach the same terminal through JSON parse failure | contracted/observed |

## 5. Current Behavior

```text
committed query
  -> title GET /session?searchMode=title
  -> title success: partial + content delay
  -> serial POST /session/search/scan
  -> complete success: scanFullHits only

title non-2xx in the pre-repair owner path
  -> falls through to JSON decode/partial
  -> schema-valid error JSON can enter content delay and scan [wrong]

current unapproved working-tree projection
  -> early error+complete return [owner repair]
  -> Search failed label [violates current user-visible preservation contract]

scan non-2xx
  -> current code sets error + complete and returns
  -> visible title hits remain; empty projection keeps existing Not Found

POST /session/search/scan
  -> workspace middleware exact collection exemption [R5 already repaired]
  -> Session handler/service
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Non-empty committed query | DialogSessionList debounce | Query is a string from the filter input | `runProgressiveSearch` | DialogSessionList | contracted |
| Title HTTP 2xx | SDK/server | Response has JSON title list | title branch -> partial | DialogSessionList | reachable |
| Title HTTP non-2xx | SDK/server or test transport | `Response.ok === false` is public fetch behavior | title branch currently falls through | DialogSessionList | observed/reachable |
| Scan HTTP 2xx | SDK/server | Response has scan JSON contract | serial scan loop | DialogSessionList | contracted |
| Scan HTTP non-2xx | SDK/server or test transport | `Response.ok === false` is public fetch behavior | scan branch -> existing error terminal | DialogSessionList | reachable |
| Fetch throw/abort | SDK transport or query change | Outer catch and AbortController are existing seams | catch/abort branch | DialogSessionList | contracted |
| Empty successful result | Session search | `done`/no cursor terminates scan | complete success -> Not Found | DialogSessionList + view projection | contracted |
| Empty failed result | HTTP failure | error terminal has no hits | complete error -> existing Not Found projection | DialogSessionList + view projection | contracted by current user requirement |
| `/session/search/scan` collection route | TUI hand-written fetch | Path contains no SessionID | workspace routing -> HttpApi handler | shared workspace routing | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing/required test |
| --- | --- | --- | --- |
| INV-01 | Non-empty query before complete is never presented as Not Found. | R3 requirement | existing params tests |
| INV-02 | Spinner remains visible during awaiting_first and partial, and is off at complete. | R3 requirement | OpenTUI regression required for terminal failures |
| INV-03 | Empty query returns browse without loading. | R3 requirement | existing params tests |
| INV-04 | Title first paint is title-only and may be a subset. | R3 contract | Session search tests |
| INV-05 | Scan uses the same list universe, serial candidate windows, and full search condition. | R3 contract | Session service tests |
| INV-06 | Query generation and AbortController discard stale responses. | R3 contract | existing component lifecycle |
| INV-07 | Content scan waits the contracted content delay after title phase. | R3 contract | existing implementation |
| INV-08 | Successful complete results are full-condition scan results, not title overlay. | R3 contract | existing params/session tests |
| INV-09 | Early stop counts scanFullHits only and caps at 400. | R3 contract | existing params tests |
| INV-10 | Path/start/directory scope matches list. | R3 contract | Session service tests |
| INV-11 | Progressive title/scan use hand-written SDK fetch because generated SDK lacks searchMode. | R3 contract | current component path |
| INV-12 | Any title or scan HTTP failure ends the current generation as error+complete, stops Spinner, preserves visible hits, emits no fallback request, and keeps the existing empty-label text. | Current user contract plus reachable title/scan response chain | successor OpenTUI title+scan transport tests |
| INV-13 | No FTS/materialized/SSE/parallel/fallback search path is introduced. | R3 non-goals/policy | diff audit |
| INV-14 | Every registered Effect HttpApi route has an exerciser scenario. | R4 CI failure | coverage/auth/effect accounting |
| INV-15 | The searchScan scenario exercises the public route and seeded response contract. | R4 contract | httpapi exerciser |
| INV-16 | Collection-level `/session/search/scan` is not parsed as a SessionID. | R5 500 trace | workspace-routing unit test |
| INV-17 | The searchScan endpoint reaches its declared handler/response after workspace routing. | R5 500 trace | focused and Session-filtered Effect exerciser |
| INV-18 | Production/test/config changes stay within six files and 800 code lines, and no user-visible string or successful Session-search behavior changes. | Current verbatim requirement | file/diff audit plus focused success regressions |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-14/15 | Route registry had no scenario for a registered route. | HttpApi exerciser scenario registry | CI/local `missing=1`; R4 scenario is now present |
| INV-16/17 | `getWorkspaceRouteSessionID` parsed `search` from `/session/search/scan`. | `src/server/shared/workspace-routing.ts` | server log: `Expected a string starting with "ses", got "search"`; R5 repair is present |
| INV-12 title | `titleRes.ok === false` still reaches `setSearchPhase("partial")` and scan delay. | `DialogSessionList.runProgressiveSearch` | independent implementation audit B-01 |
| INV-18 projection | Current unapproved working tree replaces existing `Not Found` with `Search failed`. | DialogSessionList view projection | S3 plan audit B-01 plus current requirement |
| INV-12 scan coverage | Existing scan error branch has no behaviorally sensitive public transport regression proving terminal loading and no later rendered scan page. | DialogSessionList public test seam | S3 full-scope audit |

Red-capable commands already run:

```text
packages/opencode:
  bun test test/server/workspace-routing.test.ts
  -> before R5: Expected a string starting with "ses", got "search"
  -> after R5: 16 pass / 0 fail

  bun run script/httpapi-exercise.ts --mode effect --include session.search.scan --fail-on-missing --fail-on-skip --trace
  -> before R5: HTTP 500, SessionID.make("search")
  -> after R5: 1 pass / 0 fail
```

Required behaviorally sensitive red signal:

```text
temporary HEAD-baseline snapshot + revised public component test
-> schema-valid title 503 falls through to a deliberately pending scan and remains Searching
-> removing the scan non-2xx return renders an otherwise impossible second-page marker
-> approved owner branches make both cases terminal while retaining existing labels
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Query generation, phase, terminal, abort, and request sequencing | DialogSessionList | Progressive search lifecycle | It owns the component state and fetch order | Session service owns search semantics, not UI request lifecycle |
| Existing empty-label projection | DialogSessionList view call + `sessionListEmptyLabel` | Preserve existing user-visible empty text | Current user contract forbids a new failure string | No other module should synthesize replacement text |
| Search SQL and keyset semantics | Session service/search module | Search and scan response contract | Existing domain owner | UI must not duplicate SQL |
| Collection route SessionID classification | shared workspace routing | Workspace/session routing contract | First middleware seam before handler | HttpApi handler cannot repair pre-handler brand failure |
| Route scenario accounting | HttpApi exerciser registry | Every public route has an executable scenario | Existing gate owner | Production route cannot infer expected test payload/assertions |
| Failure regression | OpenTUI `SDKProvider.testTransport` + renderer frame | Public component behavior | Real caller/provider/renderer seam | Private signals and source assertions are insufficient |

## 10. Single Approved Primary-Path Design

```text
query -> title fetch
  -> title 2xx: title overlay, partial, delay, serial full-condition scan
  -> title non-2xx: error terminal, complete, no scan, existing empty label
scan page
  -> scan 2xx: append full hits, continue until done/cap
  -> scan non-2xx: error terminal, complete, no later scan, preserve visible hits
successful empty complete -> Not Found label
empty failure complete -> existing Not Found label
```

The R5 route classification and R4 scenario already implement the route-side
primary path. The remaining successor implementation makes the existing R3
failure contract executable at the component owner without adding a fallback.
The title failure branch is a direct early return. The S4 rework removes the
unapproved terminal-specific label and reuses the existing projection unchanged.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Disposition |
| --- | --- | --- | --- |
| Title -> serial full-condition scan on success | primary contract | yes | preserve |
| Title non-2xx -> error complete/no scan | primary diagnostic branch | no | implement |
| Scan non-2xx -> error complete/no later scan | primary diagnostic branch | no | preserve and verify |
| Empty successful complete -> Not Found | primary contract | no | preserve |
| Empty failed complete -> existing Not Found | user-visible compatibility | no | preserve exactly |
| Existing list endpoint without searchMode | shipped compatibility | yes | preserve |
| Retry, all-search fallback, skip, timeout relaxation, generic invalid-ID catch | forbidden fallback | would hide failure | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Successor disposition |
| --- | --- | --- |
| None in the R4/R5 route repair | R4/R5 are primary-path repairs | Preserve exact route classification and scenario |
| `titleRes.ok` fall-through to partial | Incomplete R3 failure handling | Collapse into error+complete+return |
| Unapproved `Search failed` projection | Added under an earlier requirement that no longer governs | Remove; preserve existing `sessionListEmptyLabel` call |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02/03/08/09 | Existing phase/display path | preserve existing component/util behavior | existing params tests + OpenTUI frame |
| INV-04/05/07/10/11 | Existing title/scan orchestration and Session service | no semantic change | existing Session tests + Session-filtered Effect |
| INV-06 | committed-query generation and abort guards | preserve production guards | public `old -> new` delayed-title race frame test |
| INV-12 title | `runProgressiveSearch` title response branch | `dialog-session-list.tsx` early error return | title 503 OpenTUI transport/frame test |
| INV-12/18 empty projection | component empty-label projection | remove terminal-specific text and preserve existing helper | title failure terminal frame plus existing successful-empty tests |
| INV-12 scan | existing scan non-2xx branch | no fallback; regression only | scan 503 public frame test with second-page mutation marker |
| INV-14/15 | existing route registry/route | preserve R4 scenario | coverage/auth/effect accounting |
| INV-16/17 | existing workspace route classifier | preserve R5 exact exemption | routing unit + Session-filtered Effect |

## 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Title error early return | INV-12 | independent audit B-01 and reachable `titleRes.ok` branch | Existing code falls through to partial/scan |
| Removal of terminal-specific `Search failed` label | INV-18 | Current verbatim requirement and S3 B-01 | Existing helper already carries the required user-visible compatibility |
| Two transport failure cases in one real component test | INV-12 | S3 B-02 plus missing scan coverage | Existing params tests do not exercise the public transport/render lifecycle |
| R5 exact route exemption | INV-16/17 | observed 500 trace | Generic extractor cannot infer collection routes |
| R4 seeded route scenario | INV-14/15 | observed CI missing route | Registry cannot infer expected HTTP body/assertions |

## 15. File-Level Change Plan

| File | Add / modify / preserve | Exact responsibility | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/server/shared/workspace-routing.ts` | preserve current worktree repair | Exact `/session/search/scan` collection exemption | 0 successor lines |
| `packages/opencode/test/server/workspace-routing.test.ts` | preserve current regression | Routing helper assertion | 0 successor lines |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | preserve current scenario | Public route accounting and response contract | 0 successor lines |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | modify | Preserve title failure terminal return; remove unapproved terminal-specific label | +3 to +5 |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | add | Real provider-stack schema-valid title/scan 503 and mutation-sensitive rendered-frame regressions | +120 to +190 |

The five unique code/test files stay within the user-authorized six-file limit;
the canonical plan file is documentation, and the unrelated dirty core file is
excluded.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Existing R5 route test/Effect scenario | Old classifier parsed `search` as SessionID | Already present in worktree; verify unchanged | Route repair stays connected |
| 2 | Existing R4 coverage scenario | Route had no scenario | Already present in worktree; verify unchanged | Every route remains accounted |
| 3 | Schema-valid title 503 falls through to a pending scan and leaves `Searching needle` visible | Plain-text 503 is insensitive because JSON parse reaches the same outer catch | Return JSON `[]` with status 503; keep scan pending so only owner early-return reaches terminal `Not Found needle` | Title non-2xx is handled at `Response.ok`, not by a later parse error |
| 4 | Removing scan non-2xx return leaves the public Spinner active and then renders a second valid page with `Forbidden later scan` | Existing scan branch lacks a public terminal observation | First scan returns schema-valid 503 page with a next cursor; observe title hit plus braille Spinner, then wait until Spinner disappears before asserting retained hit and marker absence | Scan failure reaches complete and cannot continue to a later page |
| 5 | Successful zero-hit title+scan still shows `Not Found needle` | Failure tests must not change normal empty semantics | Run valid 2xx title/scan responses through the same renderer | Existing user-visible behavior is preserved |
| 6 | Delayed `old` title response rewinds a completed `new` query to stale hits/partial loading when generation guards are removed | Existing tests do not control two overlapping public transport generations | Hold `old` title, complete `new` title+scan with `Fresh new result`, resolve `old` as `Stale old result`, then assert fresh frame remains terminal with no stale marker or Spinner | Query changes cannot accept stale responses or restart loading |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 120-220 | Production branch plus real OpenTUI transport tests; exclude comments, blanks, plan, and preserved R4/R5 files |
| Required qualifying comments `C` | 18-33 | `ceil(E*0.15)`; implementation must recompute actual values and place comments beside provider seam, readiness signal, non-2xx terminal, no-later-page invariant, generation race, retained hits, and compatibility projection |

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `packages/opencode` | Title and scan HTTP failure through real UI/SDK/renderer seam |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `packages/opencode` | Existing phase/display successful empty contract |
| `bun test test/server/workspace-routing.test.ts` | `packages/opencode` | R5 routing regression |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip` | `packages/opencode` | R4/R5 Session route contract |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `packages/opencode` | All 157 route keys accounted |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `packages/opencode` | Auth accounting |
| `bun typecheck` | `packages/opencode` | Type safety |
| WSL2 Bun 1.3.14 full `effect`, `coverage`, and `auth` exercisers | `packages/opencode` | Pre-commit exact-diff Linux route gates; each must report `157 pass / 0 fail / missing=0 / extra=0` |
| Official Ubuntu baseline/package and route-owner evidence listed in S3 | GitHub Actions artifacts | Confirms unchanged daemon/package owner and equivalent route repair on GitHub-hosted Ubuntu without requiring a forbidden push |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 | One component integration test |
| Files modified | 1 successor production file plus 3 preserved R5 files | No new route/schema/helper files |
| Files deleted | 0 | No deletion required |
| Production lines | 3-5 | Early return only; terminal-specific projection removed |
| Test lines | 120-220 | Real provider-stack and renderer harness with title, scan, successful-empty, and generation-race cases |
| Generated lines | 0 | No SDK/OpenAPI generation |
| Total successor implementation lines | <200 | User limit remains below 800 lines |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| OpenTUI test lifecycle can leak native renderer state on Windows | Use `baseTest.serial`, `useThread: false` where supported, explicit renderer/event cleanup, and existing harness patterns |
| Debounce/content delay makes red test slow | Wait on observed title-request call and then bounded render/frame polling; do not replace the production delay |
| Failure rework could alter existing empty text | Assert the same `Not Found needle` frame for terminal title failure and successful zero-hit search |
| Full Effect is platform-sensitive on Windows | Require WSL2 Bun 1.3.14 full route gates and retain Windows timeout as non-pass evidence |

### Open Decisions Requiring the User

None. The current verbatim requirement preserves user-visible behavior; S4
removes the earlier unauthorized label and narrows failure changes to lifecycle
termination at the owning response branch.

### Rejected Speculation

- Generic HTTP error abstraction, retry, fallback scan, or SDK change.
- Any change to Session SQL/search semantics or workspace routing beyond the
  already proven exact collection route.
- A source-text-only test or a private exported helper solely for testing.

## 21. Audit Contract

The independent auditor must:

- Read this successor plan, the blocked predecessor, the original requirement, and current repository source.
- Reconstruct the complete R3 progressive-search scope plus R4/R5 CI repairs and R7/R8 terminal behavior.
- Audit both title and scan non-2xx transport cases through the real public OpenTUI seam.
- Require evidence for every blocking finding and treat the predecessor’s exhausted audit history as untrusted evidence, not approval.
- Check owner, primary path, user-visible compatibility, no fallback, six-file/800-line budget, mutation-sensitive TDD, Chinese-comment gate, and S3 Linux verification evidence.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S1 | yes | None | NB-01 stale route count; NB-02 conditional successful-zero-hit wording; NB-03 preserved-file bookkeeping | APPROVE | ses_0600350bbffe3P6lLC0ZKqfGET |

## 23. Implementation Evidence

The rows below record the superseded S2 attempt. S4 implementation must replace
them after removing the unauthorized projection and strengthening the public
transport tests; none of these historical rows authorize S4 implementation.

### Actual Files and Diff

The approved five code/test-file scope is implemented:

| File | Actual change | Scope disposition |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx` | S2 added title non-2xx early return plus an unauthorized `Search failed` projection. | S4 must preserve the early return and remove the projection |
| `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx` | S2 used plain-text 503 fixtures and request counts. | S4 must use schema-valid/mutation-sensitive public-frame cases |
| `packages/opencode/src/server/shared/workspace-routing.ts` | Preserved exact collection-route exemption for `/session/search/scan`. | R5 preserved, zero S2 lines |
| `packages/opencode/test/server/workspace-routing.test.ts` | Preserved collection-route regression. | R5 preserved, zero S2 lines |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | Preserved seeded public `session.search.scan` scenario. | R4 preserved, zero S2 lines |

The two plan documents record the blocked predecessor and this implementation
evidence. `packages/core/src/models-snapshot.js` is unrelated dirty worktree
state and is excluded from the change. No SDK, schema, SQL, timeout, retry, or
fallback path was added.

### Red-Green Test Evidence

| Behavior | Red evidence | Green evidence |
| --- | --- | --- |
| `/session/search/scan` collection routing | Existing R5 red: `SessionID.make("search")` rejected the route. | `bun test test/server/workspace-routing.test.ts` → `16 pass / 0 fail`. |
| Title HTTP failure terminal | S2 red was insufficient because plain-text 503 could terminate at JSON parse. | Pending S4 red/green with schema-valid 503 and pending scan. |
| Scan HTTP failure terminal | S2 asserted a transport count coupled to implementation. | Pending S4 mutation-sensitive forbidden-page frame and retained title hit. |
| Route accounting | R4 red: `missing=1`, `MISS POST /session/search/scan`. | Coverage/auth each report `157 pass / 0 fail / missing=0 / extra=0`. |

### Verification Commands and Results

All commands below ran from `packages/opencode` unless stated otherwise:

| Command | Result |
| --- | --- |
| `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `2 pass / 0 fail` |
| `bun test test/cli/cmd/tui/session-list-params.test.ts` | `12 pass / 0 fail` |
| `bun test test/server/workspace-routing.test.ts` | `16 pass / 0 fail` |
| `bun run script/httpapi-exercise.ts --mode effect --include session --fail-on-missing --fail-on-skip --progress` | Clean environment: `54 pass / 0 fail / missing=0 / extra=0` |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip --progress` | Clean Windows environment entered all `157` scenarios but timed out after `900000ms` before emitting a summary; not a pass. |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip` | `157 pass / 0 fail / missing=0 / extra=0` |
| `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip` | `157 pass / 0 fail / missing=0 / extra=0` |
| `bun typecheck` | `tsgo --noEmit` passed |
| `bun test test/cli/run test/cli/tui test/cli/cmd/tui --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-tui-followup.xml` | `621 pass / 12 skip / 0 fail`, `633 tests`, `1699 expect()`, 71 files |

The full TUI/CLI shard passed in one process, including tests after the new
file, so the test-local scheduler module seam did not contaminate the shard.

### Original Feedback-Loop Result

The Windows split loop and WSL diagnostic full loops are retained as non-pass
evidence. S3 records the environment classification and official same-baseline
JUnit comparison. S4 completion relies on exact-diff Linux regressions, all 157
Linux route scenarios in each required mode, package typecheck, the previously
green Windows TUI shard, and independent full-scope audit; it does not relabel a
timed-out command as green.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Result |
| --- | --- | --- |
| Title 2xx → partial → serial full-condition scan | Primary supported path | Preserved and covered by existing route/session checks |
| Title non-2xx → error + complete + return | Primary diagnostic branch | Implemented; no scan request |
| Scan non-2xx → error + complete + return | Primary diagnostic branch | Preserved and behaviorally covered; no later scan |
| Successful empty completion → `Not Found` | Primary success contract | Preserved by params tests |
| Failed empty completion → existing `Not Found` | User-visible compatibility | S4 must restore and verify |
| Existing list endpoint, retries, fallback search, timeout relaxation | Compatibility/forbidden alternatives | No new path added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 199 | S2 production component plus new OpenTUI test; excludes imports, blanks, comments, JSX pragma, preserved R4/R5 files, plan docs, and unrelated core file. |
| Qualifying Chinese comment lines `C` | 30 | Comments beside scheduler seam, terminal invariant, public transport, readiness, renderer cleanup, provider topology, retained hits, and diagnostic frame. |
| Ratio `C / E` | 15.08% | `30 / 199` |
| Required minimum `C` | 30 | `ceil(199 * 0.15)` |

### Remaining Unverified Items

- S4 red/green tests and post-rework verification have not run yet.
- The full local Windows Effect gate also remains incomplete because its
  all-route run timed out during the platform-sensitive full-run/cleanup tail;
  the affected Session slice and coverage/auth gates remain green.
- The Windows full package core shard remains unresolved at the existing unrelated
  test/cleanup failures; no claim of full package CI success is made.
- No post-fix remote CI run exists because this GOAL forbids push; S3 defines the pre-commit Linux evidence contract.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S2 | yes | B-01 mandatory post-fix official Ubuntu Effect gate had not been executed | Stale route count; scan empty diagnostic covered through title case; untracked release files; predecessor doc size | BLOCK | ses_05f85a298ffeDt340ijJ6zpDeT |

## S2 Amendment: Preserve the Real Search Seam Under Solid Test Runtime

### S2 reason and evidence

The approved S1 test harness reached the real `DialogSelect` input and logged
the public `onFilter` callback with `needle`, but no title request or search
generation followed. Direct runtime evidence from the package is:

```text
bun -e "import { isServer } from 'solid-js/web'; console.log(isServer)"
-> true
```

The repository's installed `@solid-primitives/scheduled` implementation returns
a no-op debounce when `isServer` is true (`node_modules/@solid-primitives/scheduled/dist/index.js:21-24`). Therefore the test runtime cannot naturally exercise the committed-query generation without a scheduler adaptation. The production component, SDK transport, Session list route, renderer, and provider stack are otherwise real and were already mounted by the S1 harness.

### S2 approved test seam

Before dynamically importing `DialogSessionList`, the successor test uses
the test runner's module seam to provide a small timer-backed implementation of
the existing scheduled callbacks. This is not a production mock, production
interface, or search algorithm: it only restores the already contracted
150-ms debounce timing that the Solid server test runtime replaces with a
no-op. The test will keep `debounce` trailing and cancellable, and will not
change the component's input, fetch, generation, phase, or terminal code.

The implemented test:

1. install the scheduler seam before dynamically importing `DialogSessionList`;
2. mount the same real provider stack and `SDKProvider.testTransport`;
3. drive the input through `DialogSelect` and wait for the real title request;
4. exercise title 503 and scan 503 cases through the real component;
5. leaves no production instrumentation or debug log in the final diff.

This is the narrowest available seam because the current no-op is produced by
an external scheduling compatibility boundary, while the requested behavior is
owned by the component after the scheduled callback fires. No production change
to `createDebouncedSignal` is authorized by S2.

### S2 TDD correction

The S1 provider/input failures were harness setup failures, not behavioral red
evidence. S2 red must be captured after the scheduler seam is active:

```text
title callback -> title 503 -> current component falls through to partial/scan
scan callback  -> scan 503 -> current error branch returns but empty label is Not Found
```

The first is the production red for the early-return fix. The second is the
diagnostic-projection red for `Search failed`, while the existing scan return
behavior is preserved and tested for no later request/retained title hit.

### S2 file and budget disposition

S2 changes no production file beyond the approved S1 component repair and adds
no new implementation file. The existing single OpenTUI test file owns the
module seam locally. The five unique code/test files and the six-file user limit
remain unchanged.

### S2 verification and audit

The S1 verification commands remain authoritative. The OpenTUI test command
passes with the scheduler seam active, and the independent implementation audit
must inspect the module boundary to ensure it is limited to timing compatibility
and does not replace progressive search behavior. The S2 implementation removed
the previously noted fixed wait for the scan no-later-request assertion.

## S2 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S2 | yes | None | NB-01 stale S1 audit rows; NB-02 historical route count; NB-03 fixed wait in current test artifact | APPROVE | ses_05fe47c8effe8073FLdceCK78i |

### S2 independent plan audit verdict (verbatim)

Historical verbatim record only. S4 supersedes its requirement, UI projection,
test-sensitivity, and release-gate conclusions; it is not implementation
authority for the current revision.

```text
No blocking findings.

## Blocking findings

No blocking findings.

## Non-blocking findings

### NB-01 — Audit-record metadata still names S1

- The canonical metadata identifies the current revision as `S2`, but the active audit-record rows at `docs/plans/tui-session-search-progressive-successor.md:321-324` and `:350-354` still contain blank S1 entries.
- This is administrative bookkeeping rather than a behavioral defect. The S2 amendment is present and explicitly defines the current test seam and verification requirements at `:356-421`.
- Before recording the verdict, the orchestrator should record the result against revision S2 without changing substantive plan content.

### NB-02 — Historical route-count wording remains stale

- Section 4 records an earlier CI observation of 156 routes at `docs/plans/tui-session-search-progressive-successor.md:66`, while verification requires all 157 route keys at `:271`.
- The executable `--fail-on-missing --fail-on-skip` commands remain the authoritative coverage check, so this does not invalidate the plan.

### NB-03 — Scan-failure no-later-request assertion should avoid unnecessary wall-clock waiting

- The proposed scan-failure test includes a fixed `Bun.sleep(300)` in the current test artifact at `packages/opencode/test/cli/cmd/tui/dialog-session-list.test.tsx:52-57`.
- Repository test guidance discourages fixed sleeps for readiness synchronization. The plan already requires request/frame readiness signals, so the final implementation should prefer an observable completion condition when asserting that no later scan occurs.
- This is not currently a blocking plan defect because the plan does not authorize weakening production behavior and the relevant request count is already observable.

## Rejected speculation

- **Additional workspace-route rules:** The current TUI producer sends `directory`, `scope`, and `path`; no reachable `workspace` producer is shown for this search path. The exact collection-route exemption at `packages/opencode/src/server/shared/workspace-routing.ts:25-27` addresses the observed `search`-as-SessionID failure. An additional workspace-selection rule would be speculative.
- **Malformed JSON compatibility or parser fallback:** The endpoint has declared HttpApi response schemas, and the TUI already consumes it through the existing fetch seam. Adding a second parser or fallback is neither required nor justified.
- **Retries, timeout changes, all-search fallback, FTS, parallel scanning, or SDK regeneration:** These are explicitly excluded by the plan and are not needed to repair the observed failures.
- **Production scheduler changes:** The installed scheduler’s server behavior is directly observed at `node_modules/@solid-primitives/scheduled/dist/index.js:21-34`. The S2 test-only module seam is constrained to restoring trailing cancellable timing before dynamically importing the component; requiring a production scheduler change would exceed the owned failure boundary.

## Requirement and traceability coverage

- **Original CI-failure requirement:** The plan preserves the complete R3 progressive Session-search contract and addresses the observed R4/R5 route failures plus R7/R8 terminal behavior at `docs/plans/tui-session-search-progressive-successor.md:17-22`.
- **R3 loading and progressive behavior:** INV-01 through INV-11 are explicitly mapped at `:107-121`, with the existing phase, display, Session-service, and transport implementations preserved. The current owner path is `DialogSessionList` at `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:85-205`.
- **Title failure:** The current first divergence is correctly identified at `docs/plans/tui-session-search-progressive-successor.md:135`; the title `Response.ok` branch currently falls through to `partial` at `dialog-session-list.tsx:104-112`. The plan repairs that transition with an early terminal return.
- **Scan failure:** The current scan non-2xx branch already terminates at `dialog-session-list.tsx:151-157`; the plan correctly preserves it and adds public regression coverage for no later scan and retained visible hits.
- **Failure-vs-empty distinction:** The current projection always returns `Not Found` for a completed empty result at `packages/opencode/src/cli/cmd/tui/util/session-list-params.ts:56-62`. The plan explicitly adds terminal-specific diagnostic projection while preserving successful empty-search behavior.
- **R4 route accounting:** The registered `searchScan` endpoint is declared at `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:677-689` and has a seeded exerciser scenario at `packages/opencode/test/server/httpapi-exercise/index.ts:1386-1409`.
- **R5 routing:** The collection route exemption is implemented at `packages/opencode/src/server/shared/workspace-routing.ts:25-27` and behaviorally tested at `packages/opencode/test/server/workspace-routing.test.ts:49-52`.
- **No fallback and one primary path:** INV-12 and INV-13 at `:122-123`, the primary-path design at `:171-188`, and the path inventory at `:190-200` consistently prohibit alternate success paths.
- **Test sensitivity:** The S2 amendment correctly identifies the installed server-runtime scheduler behavior and requires dynamic import plus a timer-backed test seam before mounting the real provider stack at `:356-393`. The proposed title and scan cases exercise `SDKProvider.testTransport`, `DialogSelect` input, the real component, and rendered frames at `:382-388`.
- **Verification:** The plan specifies package-local tests, route coverage/auth/effect exercisers, typecheck, and the mandatory Ubuntu Effect CI gate at `:263-274`.

## Primary-path and fallback verdict

**Primary path:** one authoritative progressive Session-search lifecycle:

1. A committed non-empty query starts one generation.
2. Title fetch succeeds with 2xx → title overlay and partial phase.
3. After the contracted content delay, serial full-condition scan pages run.
4. Scan hits alone define successful completion and the 400-result cap.
5. Title non-2xx → error terminal, complete phase, no scan.
6. Scan non-2xx → error terminal, complete phase, no later scan, previously visible hits retained.
7. Empty successful completion → `Not Found`.
8. Empty failed completion → distinct `Search failed` diagnostic.
9. Query change, clear, or unmount aborts and invalidates the prior generation.

The owner is correct: lifecycle and terminal projection belong to `DialogSessionList`; SQL/search semantics remain in Session modules; collection-route classification remains in workspace routing; route accounting remains in the HttpApi exerciser.

No alternate success path, retry, catch-and-default, parser sequence, compatibility expansion, or fallback configuration is proposed. The diagnostic behavior is localized and remains within the policy budget.

## Release verdict

**APPROVE** for the exact audited canonical revision **S2**, subject to recording this verdict against S2 and completing the specified implementation and independent implementation-audit gates before release.
```

## S1 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S1 | yes | None | NB-01 stale route count; NB-02 conditional successful-zero-hit wording; NB-03 preserved-file bookkeeping | APPROVE | ses_0600350bbffe3P6lLC0ZKqfGET |

### S1 independent plan audit verdict (verbatim)

Historical verbatim record only. S4 supersedes its requirement and
failure-projection conclusions; it is not implementation authority for the
current revision.

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

### NB-01 — Verification count is internally stale

- The plan cites an earlier CI observation of “156 routes” in section 4, while section 18 requires verification of “all 157 route keys.”
- This is a documentation/evidence freshness issue only. The current route-exerciser scenario and `--fail-on-missing` commands provide executable coverage checks, so it does not invalidate the implementation path or release gate.

### NB-02 — Successful zero-hit component coverage is conditionally worded

- Section 16 says the successful zero-hit regression should be asserted “if the harness supports it.”
- The existing `session-list-params.test.ts` already protects the `complete + empty -> Not Found` helper contract, and the proposed component tests cover the new failure diagnostic. Therefore this does not leave the confirmed behavior wholly unverifiable.
- The wording should nevertheless be made unconditional before implementation if the harness can render the successful empty state, because terminal-specific error projection could otherwise regress the normal zero-hit label without a component-level assertion.

### NB-03 — Preserved R4/R5 files are included in the file-budget explanation

- Sections 15 and 19 describe the preserved route files alongside successor implementation files.
- The plan correctly states that those files receive zero successor lines and excludes the unrelated dirty `models-snapshot.js` change. This is a bookkeeping clarity issue, not a scope violation.

## Rejected speculation

- **Workspace-selected search-scan forwarding:** The current TUI producer sends `directory`, `scope`, and `path`, but does not produce a `workspace` query for this search path. The observed R5 failure is the invalid `SessionID.make("search")` conversion, which is repaired by the exact collection-route exemption in `workspace-routing.ts:20-32`. Requiring an additional local-route rule for an unproduced workspace selection would be speculative.
- **Malformed scan JSON handling:** The public HttpApi endpoint has a declared response schema, and the TUI transport consumes the endpoint through the existing SDK fetch seam. The plan does not need to add a second parser or fallback for malformed payloads.
- **Additional retries, timeout changes, or all-search fallback:** These are explicitly rejected by the plan and are not required by the stated CI failures.

## Primary-path and fallback verdict

**Primary path:** one progressive Session search lifecycle:

1. committed non-empty query;
2. title fetch;
3. title 2xx → partial title display → content delay → serial full-condition scan;
4. scan 2xx → append scan hits until completion/cap;
5. successful completion → scan hits only;
6. title or scan non-2xx/transport failure → error + complete, no subsequent success-producing request;
7. empty failure → diagnostic `Search failed` label;
8. empty successful completion → `Not Found`.

This is a coherent primary contract. The title error correction is an early terminal return at the first incorrect transition. The scan error branch is preserved as a terminal diagnostic branch. No alternate success path, retry, parser sequence, catch-and-default, compatibility layer, or fallback configuration is proposed.

**Verdict:** Pass.

## Code quality and Chinese-comment verdict

Plan-mode implementation quality is feasible and consistent with repository instructions:

- Changes remain localized to `dialog-session-list.tsx` and one new real OpenTUI regression test.
- No public SDK/schema/database changes are proposed.
- Existing R4/R5 repairs are explicitly preserved rather than duplicated.
- The proposed test seam uses `SDKProvider.testTransport`, real provider composition, and rendered frames rather than private helper assertions.
- The plan explicitly requires serial lifecycle handling and renderer cleanup for the Windows OpenTUI environment.
- No `any`, unchecked cast, retry, fallback, or unrelated refactoring is authorized by the plan.

The Chinese-comment estimate is feasible for plan mode:

- Estimated effective changed lines: `E = 120–170`.
- Required qualifying comments: `C = ceil(E × 0.15) = 18–26`.
- The plan identifies local comment locations beside the transport seam, readiness synchronization, terminal failure branch, no-scan invariant, retained-hit behavior, and diagnostic projection.
- The implementation must recompute the actual values; the estimate does not authorize a lower ratio.

**Verdict:** Pass, subject to the implementation audit recomputing the actual `E`/`C` values.

## Release verdict

**APPROVE** — canonical successor plan revision **S1** is eligible for implementation under the current repository evidence.

Implementation remains disallowed until the plan’s independent verdict is recorded administratively as:

```text
Status: approved
Revision: S1
Approved revision: S1
Implementation allowed: yes
```
```

## S3 Amendment: Pre-Commit Linux Verification Without a Push-Only Circular Gate

### S3 new evidence

The S2 implementation audit blocked only because it required a post-fix
GitHub-hosted Ubuntu Effect run. The GOAL terminal is a local verified commit
and explicitly forbids push, while the user requires all applicable tests to be
green before that commit. Requiring a pushed revision before allowing the
commit creates a circular gate that cannot be satisfied by the declared
terminal.

The repository is available through WSL2 Ubuntu 22.04. The exact CI baseline
Bun `1.3.14` Linux x64 baseline binary was downloaded from the same release URL
used by `.github/actions/setup-bun/action.yml`, and the following exact-diff
commands were run from `packages/opencode`:

| Environment and command | Observed result |
| --- | --- |
| WSL2, Bun 1.3.14, `bun test test/cli/cmd/tui/dialog-session-list.test.tsx` | `2 pass / 0 fail` |
| WSL2 ext4 source, Bun 1.3.14, same OpenTUI test | `2 pass / 0 fail` |
| WSL2 ext4 source, Bun 1.3.14, `bun test test/cli/cmd/tui/session-list-params.test.ts` | `12 pass / 0 fail` |
| WSL2 ext4 source, Bun 1.3.14, `bun test test/server/workspace-routing.test.ts` | `16 pass / 0 fail` |
| WSL2 ext4 source, Bun 1.3.14, `bun typecheck` | `tsgo --noEmit` passed |
| WSL2, Bun 1.3.14, full `--mode effect --fail-on-missing --fail-on-skip` | `157 pass / 0 fail / missing=0 / extra=0` |
| WSL2, Bun 1.3.14, full `--mode coverage --fail-on-missing --fail-on-skip` | `157 pass / 0 fail / missing=0 / extra=0` |
| WSL2, Bun 1.3.14, full `--mode auth --fail-on-missing --fail-on-skip` | `157 pass / 0 fail / missing=0 / extra=0` |

GitHub-hosted Ubuntu provides independent platform evidence around the same
owners:

| Official run | Commit and relevance | Result |
| --- | --- | --- |
| `30208861589`, job `89811589786` | Local HEAD `3b2925b77`; package core/TUI baseline before this working-tree diff | `packages/opencode / Linux` passed |
| `30208861589`, artifact `required-unit-opencode-linux-1` | Same baseline; daemon signal comparison | `worker deadline terminates a hanging instance disposer` passed in `7.614299s` with four assertions |
| `30227956076`, commit `2a325224` | Includes the same `/session/search/*` collection-route owner repair and a `session.search.scan` exerciser scenario | All required opencode Linux/Windows/macOS, Effect, coverage, auth, core, and typecheck jobs passed |
| `30305961080`, commit `e0e6efe6` | Latest remote route state | Effect, coverage, and auth jobs passed; its single opencode Linux failure was a separate DB-maintenance test |

### S3 WSL full-loop classification

The WSL full split loop is retained as diagnostic evidence, not reported as a
green run. Running as root produced permission and cold-start false failures;
the affected non-daemon cases passed when rerun as the non-root `nobody` user.
Copying source, Bun, and dependencies onto ext4 made two of three daemon
process/signal cases pass. The remaining hanging-disposer case is specific to
WSL2 process-exit behavior: it times out after the second assertion, while the
same baseline case passes on GitHub-hosted Ubuntu in `7.614299s` with all four
assertions. The full ext4 daemon file otherwise reports `38 pass / 4 platform
skip / 1 WSL-only fail`, including a pass for the newer remote DB-maintenance
failure case.

This classification does not skip, weaken, quarantine, or change a repository
test. It records why a WSL2 kernel/process result cannot override the official
Ubuntu result for the unchanged daemon owner, while exact-diff TUI and HttpApi
behavior is still executed locally under Linux and CI-matched Bun.

### S3 release gate

For the local `verified-implementation-and-commit` terminal, release evidence
is complete when all of the following hold:

1. exact-diff focused OpenTUI, list-parameter, routing, and typecheck checks pass
   under WSL Linux with Bun 1.3.14;
2. exact-diff full Effect, coverage, and auth exercisers pass under WSL Linux
   with Bun 1.3.14;
3. the unchanged package/core daemon baseline has a green GitHub-hosted Ubuntu
   job, and any WSL-only failure is matched to a passing official JUnit case;
4. a full-scope independent implementation audit accepts the combined evidence
   without an unverified behavioral blocker.

A post-commit push and post-fix GitHub Actions run remain the natural remote
release follow-up, but they are not a prerequisite for the local commit because
this GOAL forbids push and the user requires green evidence before commit.

### S3 scope and implementation disposition

S3 changes no production or test behavior and adds no code/test file. It only
replaces the impossible push-before-commit verification condition with
executable exact-diff Linux evidence plus independent official Ubuntu baseline
evidence. S4 supersedes S3's assumption that the S2 UI/test diff could remain
unchanged; the route evidence and WSL classification remain applicable.

## S3 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S3 | yes | B-01 current requirement omitted; B-02 title fixture could pass through JSON parse catch | NB-01 stale mandatory Ubuntu wording; NB-02 completed implementation claims in plan mode | BLOCK | ses_056ea98ddffexdYLj3scYJlGoK |

## S4 Amendment: Preserve User-Visible Behavior and Make Failure Tests Sensitive

S4 makes the current GOAL requirement authoritative. It removes the unapproved
`Search failed` projection, preserves the title `Response.ok` early return at
the lifecycle owner, and replaces request-count/plain-text fixtures with the
three public renderer slices in section 16. No SQL, SDK, schema, timeout,
retry, fallback, normal search result, or existing user-visible string changes.

The title red uses a schema-valid JSON body with status 503 and a deliberately
pending scan response. Without the owner early return, the component reaches
`partial`, shows `Searching needle`, and waits on scan; with the repair it
reaches complete and renders the existing `Not Found needle`. A later JSON parse
exception can no longer satisfy the test.

The scan red uses a schema-valid 503 page carrying a next cursor and configures
the next valid page with the user-visible marker `Forbidden later scan`.
The test first observes the visible title hit together with a braille Spinner,
then waits through the public frame until the Spinner disappears. Deleting the
scan error return either leaves loading active or makes the marker render; the
repaired component reaches complete, retains the visible title hit, and never
renders the marker. This verifies public behavior without asserting request
counts or private state.

The successful-empty slice sends valid 2xx title and completed scan responses
and asserts the same `Not Found needle` text. It protects the explicit
no-user-visible-change requirement against both failure and normal paths.

## S4 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S4 | yes | B-01 commit authorization not cited; B-02 scan failure lacked reliable public terminal observation | Audit-mode metadata; comment estimate stale | BLOCK | ses_056d5a38bffe2jWYbutYFrffQv |

## S5 Amendment: Explicit Commit Authorization and Public Scan Terminal Signal

S5 records the user-provided terminal `verified-implementation-and-commit`
together with the user's explicit condition “不绿不能提交”. These authorize one
local commit after verified implementation; the GOAL contract still forbids
push. No Git history change is allowed before all verification and independent
implementation-audit gates pass.

The scan failure slice now has a public terminal signal: a braille Spinner is
observed while the title hit is partial, then the test waits for that Spinner to
disappear before checking the retained title and forbidden later-page marker.
A component stuck in partial/loading cannot pass this test.

## S5 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S5 | yes | B-01 INV-06 generation/abort race lacked a behavior-sensitive public regression | Historical implementation wording | BLOCK | ses_056cfb2cdffeEE8uvU4T1cwRw2 |

## S6 Amendment: Delayed Old Generation Cannot Rewind a New Query

S6 adds one public renderer/transport race to the existing test file. The test
enters `old`, keeps its title response pending, edits the real DialogSelect
input to `new`, and completes `new` through valid title and scan responses with
the visible marker `Fresh new result`. After the new query is terminal and its
Spinner has disappeared, the test resolves the old title response with `Stale
old result` and advances the real renderer.

The final frame must retain `Fresh new result`, exclude `Stale old result`, and
keep the Spinner absent. Removing either the abort/generation protection or the
post-response generation check lets the stale response overwrite title hits and
return the component to partial/loading, making this test red. The test uses no
private state, source assertions, request-count assertions, production hooks,
or alternate search implementation.

The input transition uses the public OpenTUI input seam: backspace removes the
three `old` characters, then bracketed paste enters `new`. The test waits on the
observable transport arrival for each query before resolving controlled
responses, so debounce timing is not guessed with a fixed wall-clock delay.

## S6 Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | S6 | yes | B-01 one combined race cannot independently detect removal of abort or generation protection | Stale historical S4 wording; historical E/C estimates; superseded S2 artifact pending removal | BLOCK | ses_056c9d0e4ffekh1k06K3f2GmaY |

### S6 blocking decision

The sixth successor plan-audit round is exhausted. Implementation remains
disallowed. Resolving B-01 requires explicit user authorization for a new
successor canonical plan that separates the two public transport behaviors:

1. a cancellation case observes the old title request's public `AbortSignal`
   after editing the real input, and fails if query change no longer aborts it;
2. a stale-generation case deliberately ignores transport cancellation,
   resolves the old response after the new query completes, and fails if the
   generation guard no longer protects the current renderer state.

Both cases stay in the existing OpenTUI test file and add no production seam,
fallback, timeout change, user-visible behavior, or extra code file.
