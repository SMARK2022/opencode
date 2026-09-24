# Canonical Implementation Plan: Compaction Undo Boundary Invalidation

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: current conversation, user requirement quoted in section 1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-24

This file is the sole implementation specification for this task. Historical plans and their approvals do not authorize retaining an undone Compaction boundary. This revision supersedes the fully-hidden structural-only exception in `hidden-message-production-isolation.md` for this task; it does not rewrite that historical audit record.

## 1. Verbatim Requirement

> 本质上我当时就已经规定了，我当时的需求就是把 Compaction 以及 Compaction 所有导致的这个生产消费链路都进行撤销掉，所以本质上而言，这 Compaction 以及 Compaction 的这个副作用语义等等内容，都应当随着这个隐藏啊等等内容变得失效。那所以请注意这一点，那你看一看当前而言应该去怎么样进行相应的一个精准修改，按照 First Principle 的一个原则。譬如说修改的文件数尽量少，生产文件数譬如说只修改个别文件，极个别文件，而且修改极个别的行等等这种行为。本质上而言，所有的逻辑和流程都应当遵守撤回之后，相应的副作用一并撤回。当然这个文件执行的修改啊这种东西，那本质上来说仍然沿用现在的一个东西。就譬如说使用 Edit 或者等等工具，那本身它这个副作用可能很难撤回，那本质上而言仍然沿用现在这些基础设施。但是这个类似 Compaction 这种东西，本质上而言它可以被有效撤回，那就应当去完全撤回。

Prior clarification establishing the expected boundary:

> 理论上来说，tail应当仍然沿用Compassion之前的那个tail，而不是这个Compassion所附带的tail。换言之，本质上应当实现的撤回语意应当是撤回相应compaction本身以及compaction所带来的边界的这个副作用，也就是将整个compaction及其副作用撤回，或者说将其隐藏。

## 2. Explicit Non-Goals

Additional user requirements (verbatim):

> 与此同时，测试文件整体而言最多只能加一个响应的测试，或者最多加两个测试。你不得加很多这种无意义的这种过度 defensive 的测试。或者以前那个测试你可以把它改掉都行。

> 然后我允许你按照相应的流程进行相应的精准修改。

Further user clarification (verbatim):

> 将过去有问题的这个测试。注意，我说的是你可以新增测试，但是你新增最多只能新增两个测试，然后同时现有的这个测试你可以进行相应的一个清理。也就是说，过往的所有违背我们现在要求的流程的那些测试，本质上而言都是红，都可能成为红测。那请你检查，并且依据此进行相应的修正。

> 换言之，你不需要也不得过度地增加过多的 defensible 的一些测试断言。比如说你不要加很多的那种什么什么不包含，或者说什么不会出现过往的那种流程，因为过往的流程我们已经移去了。那本质上而言，过往的流程就不再会发生了。那所以过往的流程理论上来说也没有去必要去一定要限制它不会发生过往的那种问题。反正就是你看一下吧，你反正你的这个测试保持正交，保持克制就行，不要加很多。

R3 budget: at most two NEW test cases; existing contrary tests may be corrected wherever found, without an arbitrary cap on those corrections. Preferred implementation adds zero cases and edits the two existing cases identified below. No parameterized scenario matrix and no repeated negative assertions about the removed path. Keep positive behavioral expectations orthogonal: restored canonical IDs and restored real Provider content. The production design remains the two-file primary repair.

- Do not modify Snapshot/file rollback, Tool ownership, permissions, or disk mutation behavior.
- Do not physically delete audit records, erase `tail_start_id`, rewrite the user's SQLite database, or refund already incurred usage/cost.
- Do not add rollback snapshots, persisted active-boundary fields, cache invalidation buses, migrations, flags, or new recovery algorithms.
- Independent end-of-run Tool-output pruning is not a transaction of a particular Compaction: `prompt.ts:3388` invokes it after ordinary runs as well. Preserve existing pruned-output semantics; correct which active window the existing prune consumer reads. Do not erase unrelated prior `state.time.compacted` facts.
- Experimental v2 event history/debug projections are raw parallel event records, not the v1 Provider window. No v2 schema/undo implementation is added; the v2 prompt is a stub (`v2/session.ts:294`). Do not claim v2 event records are deleted by v1 undo.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| Root `AGENTS.md`, package and test `AGENTS.md` | Small owning changes; package-local Bun tests/typecheck; fixture-based behavior tests |
| `CONTEXT.md` | v1 MessageV2 production, v2 migration distinction; Compaction vs Snapshot separation |
| `docs/adr/README.md` | Only triage ADR listed; no ADR authorizes hidden Compaction cutoff |
| `.opencode/policy/first-principles-engineering.md` | Repair first divergence, no alternate success path, independent audit, Chinese explanatory-comment gate |
| `docs/plans/hidden-message-production-isolation.md:31,134,144,251` | Historical contract explicitly preserved the defect; superseded by the current explicit user requirement |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `src/session/revert.ts:46-91,171-226` | Public undo and persisted hidden mutation; Part undo supported | reachable |
| `src/session/compaction-boundary.ts` | SQL/hot-info pre-read cutoff owner | observed |
| `src/session/message-v2.ts:789-796,1788-2010` | Ordering, pure filter, replay validity, DB window and proof | observed |
| `src/session/prompt.ts:2616-2661,3043-3077,3388` | Warm-cache proof, environment epoch, independent prune | reachable |
| `src/session/compaction.ts:142-171,795-939,1040-1219` | Previous summary, memento, evidence, replay/continue, prune consumers | reachable |
| `src/storage/cold.ts:917-971` | Cold eligibility uses the same latest boundary | reachable |
| `src/session/context-epoch.ts:46-99` | Reconcile on boundary change, preserve Git snapshot | reachable |
| `src/session/projectors.ts:159-209`, `summary-cache.ts:369-435` | File-diff aggregate is unrelated to LLM summary; hidden mutations already invalidate it | reachable |
| `src/session/session.ts:730-747,885-908` | Existing Message updates and visible paging | reachable |
| `src/cli/cmd/tui/util/context-usage.ts:156-180,655-694` and reference search | Old exported filter has only a test caller; current UI consumes token accounting, not that filter | observed |
| `src/cli/cmd/tui/context/sync.tsx` hidden handlers | Visible TUI state removes tombstones already | reachable |
| `src/session/projectors-next.ts`, `src/v2/session.ts`, `src/cli/cmd/tui/context/sync-v2.tsx`, `src/cli/cmd/tui/plugin/internal.ts` | Experimental raw event/debug path; not ordinary prompt boundary | reachable |
| `test/session/messages-pagination.test.ts:1071-1114` | Existing test incorrectly expects old history to remain cut after undo | observed |
| `test/session/prompt.test.ts:1077-1108,1188-1217` | Public Revert, warm Provider input, real Compaction fixtures | observed |
| `test/storage/cold.test.ts:2629-2722` | Public cold owner and persisted prompt-window fixture | observed |
| Commits `5f3d18e85b`, `3b2925b777`, `63e3a3466a`, `f430485822` | Hidden anchor introduction, explicit fully-hidden exception, failed compaction vs undo distinction | observed |
| Section 8 source-executed reproduction | Exact current filter loses preceding boundary after undo | observed |

Source/test paths without prefix in this document are relative to `packages/opencode`.

## 5. Current Behavior

```text
SessionRevert.revert -> cleanup -> Message hidden(reason=undo)
 -> CompactionBoundary.latest still admits fully hidden successful pair B
 -> DB load starts at B.tail_start_id (older history never loaded)
 -> filterCompacted also admits hidden B as cutoff
 -> removes B marker/summary from replay only
 -> Provider receives surviving B-tail + new Messages, loses A and intervening history
```

Cache `promptWindowProof` uses the same boundary; pure filter also serves warm suffix reconstruction and subsequent Compaction. Cold eligibility adopts it before deciding which owners are compacted head. Context epoch reconciles against the proof boundary, not an independent boundary authority.

The original investigated Session was `ses_fb0592160ffekmK38a40bM58vb`. Its B marker `msg_0c3ceec1a001BhsJXMm0ZTzWip` and summary `msg_0c3cef07e001j5JK8LXhjgqE7S` both carried `hidden.reason=undo` while B.tail remained effective. That live database continues to change; this plan uses a deterministic small fixture rather than promises about its current counts.

## 6. Supported Input Domain and Reachability

| Condition | Producer / guarantee | Path | Owner | Class |
| --- | --- | --- | --- | --- |
| Entire completed pair hidden | Public Revert + cleanup; audit rows retained | DB boundary and pure replay | CompactionBoundary/MessageV2 | observed |
| Only marker or summary hidden | Public Message/part-level operations and partial Revert | Same selectors | Same | reachable |
| Compaction Part hidden | Public Part undo | Same selectors | Same | reachable |
| Several prior compactions or none | Repeated successful runs / first Compaction | Latest-valid scan | Same | contracted |
| Valid Compaction tail points at hidden ordinary Message | Repair of dangling assistant; existing shipped fixture | Raw stream then tail stopping | MessageV2 | observed |
| No-tail Compaction | Persisted supported format | Marker cutoff | CompactionBoundary | contracted |
| Warm cached B window | Ordinary post-compaction request before undo | proof -> canonical/chunks rebuild | Prompt | reachable |
| Cold older messages | Existing freeze/maintenance | restored window hydrate | ColdStorage | reachable |
| Subsequent compaction / prune | Existing process/prune callers | shared filter -> history | SessionCompaction | reachable |

## 7. Required Invariants

| ID | Invariant | Evidence / test |
| --- | --- | --- |
| INV-01 | Hidden Compaction marker, hidden summary, or hidden Compaction Part provides neither replay nor cutoff. Applies regardless of hidden reason. | User requirement; red repro |
| INV-02 | Undo B selects the latest still-valid A and A.tail; without A, all remaining non-hidden history is considered. Multiple hidden pairs are skipped. | User clarification; new persisted test |
| INV-03 | Current DB, pure replay, warm cache, subsequent summary/memento/evidence, prune and cold eligibility cannot retain B's semantic boundary. | Caller inventory; Provider/cold regression |
| INV-04 | Hidden ordinary tail anchors remain usable for a still-visible successful Compaction; their content is never replayed. | Historical repair fixture |
| INV-05 | Audit rows, usage, existing file undo and error/permission behavior remain unchanged. | Explicit file-undo exception; existing suites |
| INV-06 | Fix owners with minimal production changes; no downstream compensating rollback system. | Explicit user requirement |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01/02/03 | `latest` admits both-hidden successful pair because Boolean parity suffices | CompactionBoundary.latest | Current lines 61-73 |
| INV-01/02/03 | Pure filter records hidden successful summary, then uses its marker's tail | MessageV2.filterCompacted | Exact executed source below |
| INV-01 | `visibleCompactions` independently accepts hidden parity | MessageV2 replay pairing | Lines 1870-1893 |

Ranked explanations and checks: (1) hidden cutoff admission predicts loss even without cache, confirmed by source-executed reproduction; (2) stale cache alone predicts cold reconstruction is correct, falsified by the pure filter; (3) UI-only token display predicts Provider window IDs are correct, falsified by the same output. Repairing token display or explicit cache clearing cannot restore history discarded at these owners.

Reproduction executed on 2026-09-24. Direct module import first failed at missing `@babel/preset-typescript` from package preload; running without that preload failed at missing `ai`. Dependencies were not modified. The following diagnostic executes the actual source functions verbatim, stripping only TypeScript/exports, with no cloned algorithm or production edits. It proves pure filtering, not DB/integration behavior. Run in PowerShell from `D:\Temp\opencode`:

```powershell
bun -e 'const source=await Bun.file("F:/ML/PythonAIProject/Claude-Code/opencode/packages/opencode/src/session/message-v2.ts").text(); const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a); if(a<0||b<0) throw Error("Source seam moved"); return source.slice(a,b)}; const code=section("export function compareChronology(","const decodeCursor")+section("export function filterCompacted(","export const filterCompactedEffect"); const js=new Bun.Transpiler({loader:"ts"}).transformSync(code).replaceAll("export ",""); const filter=new Function(js+"; return filterCompacted;")(); const m=(n,role,parts=[],extra={})=>({info:{id:`msg_${n}`,sessionID:"ses_repro",role,time:{created:n},...extra},parts}); const a=m(1,"user",[{type:"compaction",tail_start_id:"msg_1"}]); const sa=m(2,"assistant",[{type:"text",text:"summary A"}],{parentID:"msg_1",summary:true,finish:"stop"}); const old=m(3,"user",[{type:"text",text:"history that must return"}]); const tail=m(4,"user",[{type:"text",text:"tail B"}]); const h={hidden:{time:9,reason:"undo"}}; const b=m(5,"user",[{type:"compaction",tail_start_id:"msg_4"}],h); const sb=m(6,"assistant",[{type:"text",text:"summary B"}],{parentID:"msg_5",summary:true,finish:"stop",...h}); const next=m(7,"user",[{type:"text",text:"next"}]); const actual=filter([a,sa,old,tail,b,sb,next]).map(x=>x.info.id); const expected=["msg_1","msg_2","msg_3","msg_4","msg_7"]; console.log(JSON.stringify({actual,expected})); if(JSON.stringify(actual)!==JSON.stringify(expected)) process.exit(1);'
```

Observed exit 1, elapsed 851 ms:

```json
{"actual":["msg_4","msg_7"],"expected":["msg_1","msg_2","msg_3","msg_4","msg_7"]}
```

Minimal load-bearing structure: valid A, intervening history, B's later tail, hidden completed B, new Message. No Provider, Snapshot, cache, real DB, or Tool needed to trigger the first pure divergence.

## 9. Responsibility and Seam

| Concern | Owner / promise | Why here, not elsewhere |
| --- | --- | --- |
| Cutoff before reading history | CompactionBoundary.latest | Downstream cannot recover rows never loaded |
| Canonical replay and tail ordering | MessageV2.filterCompacted / visibleCompactions | Also public array entry for compaction and warm cache; cannot trust DB-only repair |
| Persist hidden mutations | Existing SessionRevert | Already marks entire suffix; no need to edit Part children or delete metadata |
| Cache / epoch / cold eligibility | Existing consumers of boundary/proof | Existing identity-change and hydrate mechanisms suffice; verify them rather than add handlers |

## 10. Single Approved Primary-Path Design

```text
stored hidden state -> select latest visible successful pair -> existing cutoff/window loader
 -> same visible-successful pairing in raw chronological filter -> active summary + tail + later visible history
```

Exactly two production files are planned:

1. `compaction-boundary.ts`: replace hidden-parity acceptance with direct rejection if summary or marker is hidden. Keep the existing hidden-Part, completion/error, same-session pairing and chronological selection. Do not change raw data or use a visibility-filtered read to hydrate whole history first.
2. `message-v2.ts`: admit only visible successful summaries and visible markers with a visible Compaction Part in the boundary walk, replay pairing, and retained-tail reorder. Collapse the `completed` Boolean map to an ID set because hidden parity is no longer meaningful. When a marker is hidden/invalid, remove its candidate from the set so post-pass reorder cannot re-admit it. Update all related comments to distinguish hidden ordinary anchors from hidden Compaction operations. Preserve the raw walk and its `retain` equality check: filtering all hidden rows before the walk would break valid hidden ordinary tail anchors.

Existing `latest` scan naturally finds A; no prior Compaction is the supported no-boundary case. This is the normal primary contract, not failure-triggered fallback. A compaction that remains visible can still have an old hidden ordinary anchor, but an undone operation cannot supply any cutoff.

No new cache state: `promptWindowProof.boundary` changes from B to A/null, `prompt.ts:2623` misses old cache and uses canonical reload. `SessionContextEpoch.prepare` reconciles the changed identity before use, preserving Git snapshot under its existing contract. Cold payloads are decoded through existing hydrate when older visible history returns; no eager thaw of entire Session. Subsequent compaction derives prior summary/evidence from the corrected window. B's memento belongs to its hidden marker, B's evidence to its hidden summary; neither is replayable. Existing Revert hides generated continuation/replay and later descendants in its chronological suffix.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Share / disposition |
| --- | --- | --- | --- |
| Latest visible successful pair; earlier A or no boundary | Primary-contract branches | yes | Primary, repair |
| Fully-hidden successful pair as structural-only cutoff | Superseded behavior contrary to explicit requirement | yes | Remove |
| Visible Compaction with hidden ordinary tail anchor | Existing persisted compatibility within primary contract | yes | Preserve |
| Visible no-tail Compaction uses marker cutoff | Existing persisted compatibility | yes | Preserve |
| Raw audit/fork/events/accounting | Contracted raw pass-through | not replay | Preserve |
| Ad hoc DB rewrite / forced cache flush / separate restore algorithm | Forbidden compensating paths | would | Reject |

New alternate success paths: zero. New production diagnostic paths: zero (0% changed decision surface). No implementation rollback route; this repairs the primary invariant directly.

## 12. Workaround Deletion and Replacement

| Existing behavior | Why superseded | Location |
| --- | --- | --- |
| Hidden parity map and structural-only exception | Makes an undone operation affect current context | Two production owners above |
| Test expects only `[next]` after hiding both compaction messages | Encodes opposite of requested undo contract | `messages-pagination.test.ts:1071-1114` |
| Historical plan's exception | Contradicts current explicit requirement | Supersession notice in this canonical plan; historical record retained |

## 13. Forward Traceability

| Requirement | Path / change | Behavioral verification |
| --- | --- | --- |
| INV-01/02 | Both boundary owners | Edited pagination test restores full visible history without A; edited Provider test restores A after B undo. Existing partial-pair, failed and no-tail cases run unchanged |
| INV-03 cache and Provider | Corrected proof + unchanged Prompt | Warm B request then public undo, next request positively contains A/intervening sentinel; no separate B-artifact absence matrix |
| INV-03 next Compaction | Corrected pure filter | Existing compaction suite plus direct pure-filter assertion in edited pagination test; next-summary consumption shares that function, no new dedicated case |
| INV-03 cold | Corrected latest + existing eligibility/hydrate | Existing cold suite unchanged; verify common boundary owner by source and corrected persisted-window test, no new freeze/undo matrix |
| INV-03 epoch | Corrected proof identity + existing prepare | Edited warm Provider test observes restored A/history; existing epoch regressions unchanged, boundary identity source inspection |
| INV-04 | Preserve raw retained-anchor stopping | Visible pair with repaired hidden ordinary anchor still returns pair + next; no anchor content |
| INV-05 | Unchanged Revert/Snapshot/accounting | Existing revert-compact/accounting suites unchanged; edited Provider test uses real public Revert cleanup |
| INV-06 | Two production files | Changed-file/diff audit |

## 14. Reverse Traceability

| Proposed production concept | Requirement | Evidence / why current code insufficient |
| --- | --- | --- |
| Visible-only completed pair admission | INV-01/02 | Hidden parity explicitly accepts wrong operation |
| Set replaces visibility-state map | INV-01/06 | No valid hidden pair state remains; avoid retaining obsolete model |
| Reorder/replay use same visible pairing | INV-03 | Independent post-pass must not revive invalid candidates |

No new interface, module, dependency, feature flag, persisted state, or background task.

## 15. File-Level Change Plan

| File | Action | Responsibility | Estimated changed lines |
| --- | --- | --- | --- |
| `src/session/compaction-boundary.ts` | modify | Reject hidden operation before cutoff | 3-8 code/comment lines |
| `src/session/message-v2.ts` | modify | Reject hidden pair across walk/reorder/replay; retain ordinary hidden anchors | 15-35 code/comment lines |
| `test/session/messages-pagination.test.ts` | modify one existing case | Add before-hide assertion for valid pair with hidden ordinary anchor; after-hide require old history through pure and DB filter | 10-25 |
| `test/session/prompt.test.ts` | modify one existing case | Extend existing successful Compaction cache scenario to A -> B -> public undo B -> Provider restored A/intermediate history | 30-65 |
| This plan | add/update | Requirement and audit evidence | documentation only |

Reuse existing fixture builders. No new test functions are currently necessary; absolute user cap is two new cases. Correct other existing contrary expectations only if found by focused search or test failure; report their concrete conflict with the new invariant. No parameterized matrices, new mock frameworks or separate test files. The size budget is a bound to minimize, not a target.

## 16. TDD Behavior Slices

Approved user workflow uses existing public seams: `SessionRevert.revert/cleanup -> MessageV2.filterCompactedEffect`, direct `MessageV2.filterCompacted`, and `SessionPrompt` captured Provider request after actual `SessionCompaction.run`. The two planned edits below are sufficient unless existing contrary assertions are discovered elsewhere. Do not expand coverage with duplicate defensive assertions.

| Order | Red behavior / why it fails now | Minimal green / protection |
| --- | --- | --- |
| 1 | Edit `uses hidden retained-tail anchors as boundaries without returning hidden messages`: before hiding the pair assert valid compact/summary survives despite ordinary hidden anchor; after hiding both require `[old, oldReply, next]` rather than `[next]`, through pure and persisted filtering | Change both owners; single fixture's before/after assertions distinguish ordinary anchor from undone operation |
| 2 | Extend `invalidates a retained window after successful Compaction`: keep original relevant assertions, create distinct A and B summaries with an intermediate visible text sentinel; warm B by a real Provider request, undo from B's marker using public Revert/cleanup, issue next prompt | Captured wire must positively contain A and intervening history; configure retained-tail using existing supported settings as needed so B cannot simply replay A. This catches stale cache and prior-boundary restoration with one lifecycle and no artifact-by-artifact negative assertions |

One vertical red-green slice at a time. Old tests asserting the superseded behavior are corrected with explicit rationale, not deleted to hide failures. Use literal known expected IDs/text; do not recompute expected cutoff with production logic. Existing broad suite covers Snapshot file behavior; no new file-rollback semantics.

## 17. Chinese Comment Budget

| Metric | Estimate / method |
| --- | --- |
| Effective changed code E | 55-100, including tests, excluding imports/formatting/docs |
| Required C | At least max(1, ceil(E * 0.15)); estimate 9-15 qualifying adjacent Chinese lines |

Explain why undo must precede cutoff, why hidden ordinary tail anchors survive scanning, why both pure/DB entrypoints need coverage, why warm cache must contain B first, and why restored old sentinel is independent evidence. Count actual diff before implementation audit; avoid padding or obvious control-flow translations.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| Section 8 source-executed command | `D:\Temp\opencode` | Original deterministic bug turns green |
| `bun test test/session/messages-pagination.test.ts test/session/revert-compact.test.ts` | `packages/opencode` | Persisted window, undo, ordinary hidden anchor, existing file semantics |
| `bun test test/session/prompt.test.ts` | `packages/opencode` | Edited undo/cache lifecycle plus existing Provider/epoch regressions |
| `bun test test/session/compaction.test.ts test/session/message-v2.test.ts test/storage/cold.test.ts` | `packages/opencode` | Existing compaction lifecycle, pure conversion, cold restore/eligibility |
| `bun typecheck` | `packages/opencode` | Types |
| `git diff --check` | repository root | Diff hygiene |

Planning-time prerequisite: package dependencies were incomplete (`@babel/preset-typescript`, `ai` missing on import). This was resolved during implementation using the user-authorized frozen-lockfile install; see section 23 for the completed integration/typecheck results. No dependency declarations or lockfile were changed.

## 19. Diff Budget

| Metric | Estimate | Reason |
| --- | --- | --- |
| Files added | 1 plan; zero production/test files | Existing seams suffice |
| Files modified | 2 production + 2 planned existing test files | Two owning modules and two orthogonal edited cases; any additional old-test correction requires an evidenced contrary expectation |
| Files deleted | 0 | No cleanup of others' work |
| Production lines | ~18-43 including explanatory comments | Conditions, set simplification, obsolete comments |
| Test lines | ~40-90 including explanation | Reuse current fixtures; no new cases or blanket matrix |
| Generated lines / dependencies / schema | 0 | No API or persistence shape change |

## 20. Real Risks and Open Decisions

- Restored context can be much larger; this is intended undo behavior, not a reason to preserve B cutoff. Normal overflow may initiate a new valid Compaction afterward.
- Cold restored content adds legitimate hydrate cost. Use existing corruption propagation; do not silently skip missing/corrupt payloads.
- Live database changed during the original investigation. Never bulk-unhide messages or alter rows to force expected token counts.
- Immediate pre-next-request TUI token display can reflect its latest recorded request; verify next Provider input rather than claim historical token counters rewind.
- Raw debug/event history and accounting are historical facts, not active v1 context authority. This repair does not erase those facts.

### Open Decisions Requiring the User

None on the specified undo semantics or test budget. User authorized implementation following the workflow. R3 requires a fresh full-scope audit before implementation; integration verification requires resolving local missing dependencies.

### Rejected Speculation

- New cache flush/epoch rollback machinery: existing proof identity and reconcile already own these changes.
- Rewriting `summary_ref`: it is a file-diff aggregate, not the LLM Compaction summary.
- Clearing every Tool prune marker: no producer ties those to B's transaction; would change independent pruning and exceed the undo scope.
- Editing dead TUI filter or implementing v2 undo: no normal Provider path through those functions; avoid unrelated migration work.

## 21. Audit Contract

Independent auditor must reconstruct the complete original requirement from current repository evidence. Check both authorities, all actual consumers and the hidden ordinary-anchor distinction; do not accept file-count minimalism as justification to omit behavior. Check root-cause repair, no fallbacks, ownership, behavioral test sensitivity, quality and >=15% Chinese explanatory-comment plan. Audit every revision in full scope.

## 22. Plan Audit Record

| Round | Revision | Full scope? | Blocking | Non-blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | Two verification/test-separation notes below | APPROVE | ses_f2d5cfc76ffempXRtW2tYsoYsr |
| Not audited | R2 | N/A | N/A | N/A | superseded by user clarification | N/A |
| 2 | R3 | yes | No blocking findings. | Verification and discriminating Provider sentinel notes below | APPROVE | ses_f2d5501ddffehtNg3nG9MyJkFk |

### R3 Independent Verdict (Verbatim)

No blocking findings.

Non-blocking findings:

- 本轮完成静态全范围计划审计，未执行复现命令、集成测试或 typecheck。R3 已明确依赖与运行验证尚未完成；实现验收仍须取得实际 red-green 和第 18 节验证结果。
- Provider 测试的中间历史 sentinel 必须确实处于 B 的保留范围之外，且不能仅由 recent-user memento 带入请求。R3 第 16 节已要求构造有区分度的 A/B 窗口；实施时须确保正向内容断言能够识别旧行为，不能因测试历史过短而误通过。

Release verdict:

**APPROVE — 仅适用于 `docs/plans/compaction-undo-boundary-invalidation.md` 的 R3，全范围计划审计。**

此结论允许按流程记录 R3 批准，不代表实现或运行验证通过。实施完成仍须满足规定验证，并取得独立全范围实现审计批准。

R1 approval is superseded by the user's explicit new-test limit. R2 temporarily interpreted it as a cap on all changed tests; R3 corrects that to at most two new cases, permitting evidence-based cleanup of any contrary existing tests. Expanded scenario matrices are removed. All production requirements remain unchanged. Historical R1 verdict follows and is not approval of R3.

Independent audit returned the following verdict and findings verbatim. This administrative recording does not change the design. Plan approval does not claim implementation or runtime verification.

### Blocking findings

No blocking findings.

### Non-blocking findings

- 本轮为静态计划审计，独立核对了源码、现有测试和调用链；未执行计划中的独立复现命令、集成测试或 typecheck。计划已明确这些验证尚未完成，没有将诊断性复现当作实现验收。
- 隐藏普通 tail anchor 的保护测试必须与“整个 Compaction 已隐藏”的测试分开。现有 `packages/opencode/test/session/messages-pagination.test.ts:1071` 同时隐藏了 marker 和 summary，不能单独证明仍可见 Compaction 的隐藏普通 anchor 合同。R1 第 13、16 节已要求覆盖这一区分，实施时应落实。

### Rejected speculation

- **新增缓存清空机制：不成立。** `packages/opencode/src/session/prompt.ts:2623` 已按 boundary identity 拒绝旧缓存，并重新读取 canonical window。
- **新增 epoch 回滚存储：不成立。** `packages/opencode/src/session/context-epoch.ts:69` 已在 boundary 改变时重建日期代际，同时保留 Git 快照。
- **清除全部 Tool prune 标记：不成立。** prune 是独立的运行后流程；`packages/opencode/src/session/compaction.ts:803` 通过共享窗口读取输入，本次需要撤销 B 的边界效力，没有证据要求清除所有历史 pruning。
- **修改旧 TUI filter 或实现 v2 undo：不成立。** 前者当前只有测试调用；后者的 prompt 仍是 stub。它们不构成当前 v1 Provider 窗口的替代权威。

### Release verdict

**APPROVE — 仅适用于 `docs/plans/compaction-undo-boundary-invalidation.md` 的 R1，全范围计划审计。**

此结论不代表实现或运行验证通过。实施完成仍须取得要求的 red-green、集成测试、typecheck 和独立全范围实现审计证据。

## 23. Implementation Evidence

Implemented the approved R3 primary repair. No user database mutations, dependency manifest/lockfile changes, commits, or changes to file rollback.

### Actual Files and Diff

Exactly four implementation files: two production owners and two existing test cases. `git diff --numstat`:

| File | Added | Removed |
| --- | --- | --- |
| `src/session/compaction-boundary.ts` | 3 | 5 |
| `src/session/message-v2.ts` | 12 | 14 |
| `test/session/messages-pagination.test.ts` | 6 | 2 |
| `test/session/prompt.test.ts` | 20 | 2 |

Total 41 added / 23 removed. No new test cases, no new test files. Removed hidden-parity admission and Boolean-map state. Focused existing-test search found one contrary both-hidden assertion; it is corrected rather than suppressed. The existing Provider cache test is extended with public B undo and two positive restored-content assertions.

### Red-Green Test Evidence

1. `bun test test/session/messages-pagination.test.ts -t 'restores history after hiding a compaction' --timeout 30000`: before production change, 0 pass / 1 fail because actual omitted old user/reply; after change, 1 pass / 0 fail, 3 assertions.
2. `bun test test/session/prompt.test.ts -t 'rebuilds a retained window after Compaction and its undo' --timeout 30000`: temporarily reinstated ONLY the old admission expressions in the two owned production files to establish sensitivity of the second slice; it failed at the positive `canonical compacted summary` assertion (0 pass / 1 fail). Restored the approved fix: 1 pass / 0 fail, 6 assertions. The assistant sentinel `final response` is not eligible for the recent-user memento, and `tail_turns: 0` ensures B does not retain it. No source changes from these baseline probes remain.

### Verification Commands and Results

All Bun test/typecheck commands below ran from `packages/opencode`.

| Command | Result |
| --- | --- |
| `bun test test/session/messages-pagination.test.ts test/session/revert-compact.test.ts --timeout 30000` | 74 pass / 0 fail, 230 assertions |
| `bun test test/session/compaction.test.ts --timeout 30000` | 72 pass / 0 fail, 297 assertions |
| `bun test test/session/message-v2.test.ts --timeout 30000` | 60 pass / 0 fail, 111 assertions |
| `bun test test/storage/cold.test.ts --timeout 30000` | 42 pass / 0 fail, 203 assertions |
| `bun test test/session/prompt.test.ts -t 'Compaction\|compaction\|retained\|cached\|Revert\|epoch' --timeout 30000` | 7 pass / 0 fail, 26 assertions |
| `bun typecheck` | Pass twice, including final restored implementation |
| `git diff --check` (root) | Pass |
| Section 8 original source-executed command | Pass, actual equals expected A/history/tail/next IDs |

Final independently inspectable JUnit artifacts generated with `--reporter=junit --reporter-outfile=<path>` on the unchanged final implementation:

| Artifact | Full suite result |
| --- | --- |
| `D:\Temp\opencode\compaction-undo-prompt-final.xml` | Entire prompt suite: 115 pass, 14 existing skip, 0 fail; 129 cases, 516 assertions, 759.10 seconds |
| `D:\Temp\opencode\compaction-undo-pagination-revert-final.xml` | Entire pagination + revert suites: 74 pass, 0 fail, 230 assertions |
| `D:\Temp\opencode\compaction-undo-compaction-final.xml` | Entire compaction suite: 72 pass, 0 fail, 297 assertions |
| `D:\Temp\opencode\compaction-undo-message-final.xml` | Entire MessageV2 suite: 60 pass, 0 fail, 111 assertions |
| `D:\Temp\opencode\compaction-undo-cold-final.xml` | Entire isolated cold suite: 42 pass, 0 fail, 203 assertions |
| `D:\Temp\opencode\compaction-undo-typecheck-final.log` | Native PowerShell transcript: package cwd, `bun typecheck`, native exit code 0 |
| `D:\Temp\opencode\compaction-undo-original-repro-final.log` | Native PowerShell transcript: section 8 executed source fixture, actual/expected ID arrays equal, native exit code 0 |

Final total: 363 pass, 14 existing skip, 0 fail across the six requested test files. No registered test timeout, skip, or unrelated assertion was changed. The successful full prompt command was identical except for adding the JUnit reporter and allowing the external shell process up to 1800 seconds; it completed in 759 seconds. This closes B-01's missing full-prompt result.

The five passing test commands cover 255 cases; they are not a claim of a full package-suite pass. Broader attempts and controls:

- Combined `bun test test/session/compaction.test.ts test/session/message-v2.test.ts test/storage/cold.test.ts --timeout 30000`: 173 pass / 1 fail at cold.test.ts:1867 (`owners=2`, `keys=1`). Reinstating old production admission expressions reproduced the same failure, 173 pass / 1 fail. Running each complete file in its own process succeeds (72 + 60 + 42); the global cold fixture scans all payloads and is sensitive to preceding suites. No cold tests were edited.
- Initial full `bun test test/session/prompt.test.ts --timeout 30000` reached the shell's 600-second limit with three reported short per-case timeouts, and no complete suite verdict. The registered 5s/10s case budgets are independent of the CLI timeout. Isolating those three cases yielded 2 pass / 1 fail; the same old-production-expression baseline yielded 2 pass / 1 fail with `running subtask preserves metadata after tool-call transition` timing out at 5s. The other two timeout cases passed in isolation. No unrelated test timeouts/assertions were changed. The final complete rerun above passed with all original per-case budgets unchanged.
- Dependencies: user explicitly allowed `bun install --frozen-lockfile --ignore-scripts` after permission prompt. It installed missing local node_modules packages. Root `git diff HEAD -- package.json bun.lock packages/opencode/package.json` and status for those paths are empty; no declared dependencies or versions changed. Initial missing-dependency root cause is unknown, not attributed to this patch.

### Original Feedback-Loop Result

Pass, exit 0. Exact output:

```json
{"actual":["msg_1","msg_2","msg_3","msg_4","msg_7"],"expected":["msg_1","msg_2","msg_3","msg_4","msg_7"]}
```

### Actual Secondary and Replacement Path Inventory

No new alternate success path, diagnostic path, state, helper, schema, interface, cache, or dependency. Existing visible ordinary tail-anchor and no-tail branches retained. Hidden Compaction structural-only behavior removed in both owners. New diagnostic decision surface 0%.

### Chinese Comment Calculation

Computed from added/substantively modified nonblank code in `git diff --unified=0`, excluding comments, blank lines, imports (none), docs and unchanged context. No generated or formatter-only changes.

| File | E | C |
| --- | --- | --- |
| Compaction boundary | 1 | 2 |
| MessageV2 | 7 | 5 |
| Pagination test | 4 | 2 |
| Prompt test | 16 | 3 |
| Total | 28 | 12 |

C/E = 42.86%; required minimum ceil(28 * 0.15) = 5. Explanations are adjacent to cutoff admission, hidden ordinary-anchor preservation, replay pairing, pure/DB parity, and the warm Provider test's independent sentinel. No padding, new test names or obvious assignments counted as comments.

### Remaining Unverified Items

All six requested test files now have complete passing reports (14 pre-existing skips retained). Combined-process cold suite still has the baseline-reproducible fixture interaction described above; the entire isolated cold suite passes. This task does not patch those unrelated tests. No build/deployment or mutation of the live user's database was performed; live running daemon behavior will not change until the repaired source is used by that runtime.

## 24. Implementation Audit Record

| Round | Revision | Full scope | Blocking | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | B-01 必需的运行验证尚未闭环 | BLOCK | ses_f2d2daecfffe9dD3xOvsxDRKUZ |
| 2 | R3 | yes | B-01 必需的运行验证证据仍有缺口 | BLOCK | ses_f2d2daecfffe9dD3xOvsxDRKUZ |
| 3 | R3 | yes | No blocking findings. B-01 已关闭。 | APPROVE | ses_f2d2daecfffe9dD3xOvsxDRKUZ |

Round 1 finding and verdict (verbatim):

### B-01 必需的运行验证尚未闭环

- Violated invariant: 实现放行前，必须完成 R3 规定的行为验证和必要回归检查。
- Evidence class: contracted
- Producer and execution path: Revert cleanup → boundary 选择 → canonical/warm window 重建 → Provider 请求；完整 `prompt.test.ts` 是 R3 指定的回归验证入口。
- Source evidence: `.opencode/policy/first-principles-engineering.md:567` 要求 red-green、原始反馈循环和必要验证通过；`packages/opencode/test/session/prompt.test.ts:1188` 是修改后的真实 Provider 场景。
- Canonical-plan evidence: 第 18 节要求运行完整 prompt suite；第 23 节 `docs/plans/compaction-undo-boundary-invalidation.md:384` 明确记录该运行未完成。
- Responsibility owner: 实现验证流程。
- Concrete production, test, or contract consequence: 当前没有完整 prompt 回归结果；选定测试通过的记录不能证明尚未完成的测试已通过，发布硬门槛仍未满足。
- Why this is not speculative: 缺失的是明确要求的执行结果。此 finding 不把超时归因于本次修改，也不要求修复无关既有缺陷。
- Minimal correction direction: 完成必要运行验证，并提供可直接检查的结果。已请求执行 R3 测试和 typecheck 的授权；本轮未执行这些非 Git 命令。若存在基线故障，应独立核实其范围，不能仅凭 builder 的文字说明放行。

Non-blocking findings:

- 四个文件的实际 diff 与 R3 两个生产 owner、两个既有测试的范围一致；静态检查未发现新增行为缺陷。
- 已独立执行限定四个文件的 `git diff --check`，通过。
- 计划记录的 red-green、255 个测试通过和 typecheck 结果属于 builder 提供的记录，本轮未将其视为独立复现证据。

**BLOCK — 仅针对 R3 与本轮四文件 unstaged diff 的发布验收。**

当前阻塞项是验证闭环，不是已发现的生产逻辑缺陷。需要执行授权及可核实的必要验证结果后，再作完整放行判断。

Rework evidence: no production/test changes following round 1; completed the original full prompt command with an adequate external process time budget and persisted all six required test files' complete JUnit results in section 23. Round 2 must re-audit the full original scope rather than just B-01.

Round 2 remaining finding and verdict (verbatim):

### B-01 必需的运行验证证据仍有缺口

- Violated invariant: R3 要求的运行验证必须取得可核实结果，不能仅依赖 builder 的完成摘要。
- Evidence class: contracted
- Producer and execution path: 四文件实现 → R3 第 18 节验证 → 实现发布验收。
- Source evidence: `.opencode/policy/first-principles-engineering.md:567` 要求必要验证及原始反馈循环通过。
- Canonical-plan evidence: `docs/plans/compaction-undo-boundary-invalidation.md:252`、`docs/plans/compaction-undo-boundary-invalidation.md:256`；目前 typecheck 和原始复现结果仍只有第 23 节摘要。
- Responsibility owner: 实现验证流程。
- Concrete production, test, or contract consequence: 完整 prompt 测试结果已经补齐，但本轮仍无法独立确认 typecheck 和原始复现的执行结果，尚不能签发完整实现批准。
- Why this is not speculative: 这是明确规定的验证门槛；不表示已发现类型错误或行为回归。
- Minimal correction direction: 提供这两项命令可直接检查的原始执行结果，或授权审计执行。无需修改生产代码或增加测试。

**B-01 的完整 prompt-suite 缺口已解决；其余验证证据补齐后可关闭。**

Non-blocking findings:

- 修改后的两个回归用例均出现在报告中并通过；实际 diff 没有新增 skip、放宽 timeout 或删除断言。
- 独立执行的四文件 `git diff --check` 通过。
- 依赖清单、锁文件，以及此前追踪的 Revert、Prompt、Compaction、cold、epoch 消费者均无新增差异。
- combined-process cold 的历史失败仍应保留记录。`packages/opencode/test/storage/cold.test.ts:1824` 的查询扫描全库，`packages/opencode/test/storage/cold.test.ts:1867` 对全部结果要求纯打包，确实存在跨套件数据干扰的条件；完整 isolated cold 报告已通过。

**BLOCK — R3 与当前四文件 unstaged diff 暂不放行。**

完整测试结果已核实，静态全范围复核未发现生产行为缺陷。剩余事项仅为核实 `bun typecheck` 与原始复现的执行结果；本轮已请求执行授权，未擅自运行。

Round 3 evidence: no production/test edits; reran typecheck and original reproduction with native PowerShell transcripts listed in section 23. Both native exit codes are 0; the reproduction transcript contains actual and independently specified expected IDs. Third audit remains full-scope.

Round 3 independent findings and release verdict (verbatim):

### Blocking findings

No blocking findings.

### Non-blocking findings

- **B-01 已关闭。** 已直接检查 `D:\Temp\opencode\compaction-undo-typecheck-final.log:21`，确认 package 工作目录、`bun typecheck` 和退出码 0；检查 `D:\Temp\opencode\compaction-undo-original-repro-final.log:21`，确认原始复现的 actual/expected IDs 一致、退出码 0。
- 五份完整 JUnit 报告覆盖六个指定测试文件，合计 **363 pass、14 既有 skip、0 fail**。本次结论依据直接检查的运行产物，不声称审计方重新执行了这些测试。
- combined-process cold 的历史失败仍需保留说明。其全库查询和纯打包断言存在跨套件数据干扰条件；完整 isolated cold 已通过。没有证据表明本次修改引入该问题。
- 本轮独立执行四文件 `git diff --check`，通过。依赖清单、锁文件及已追踪的下游消费者没有新增差异。

### Release verdict

**APPROVE — 仅适用于 `docs/plans/compaction-undo-boundary-invalidation.md` 的 R3，以及本轮审计的四文件当前 unstaged diff。**

这是第三轮完整范围实现审计的批准。该结论不代表修改已部署到运行中的 daemon，也不授权提交、推送或修改用户数据库。
