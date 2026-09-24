# Canonical Implementation Plan: Message Read Visibility Defaults

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: verbatim user requests in section 1; docs/workflow.md
>
> Implementation allowed: no further material changes without revision or rework
>
> Target terminal state: verified-implementation
>
> Last updated: 2026-09-24

This is the sole canonical plan for this goal. The previous compaction-undo repair is existing worktree baseline, not authorization or an implementation substitute for this goal.

## 1. Verbatim Requirement

> 因此下面请你按照 first principle plane 的一个原则进行相应的完整的这个方案的一个构建。请注意目标状态是 verified implementation 的一个逻辑。整体的修改保持精准克制，不要大幅度增加相应的测试等内容。然后与此同时原有的之前我们加的下游业务中额外独立的这种 hidden 的判断理论来说就不再需要，可以进行精准的移除，或者将其替换为更精简的逻辑。然后与此同时请注意相应的注释应当保持全面完整且均匀化，让那些比较重点且关键的逻辑处包含相应的完整注释。同时相应的修改适度保持精简、凝练、concise，不要让你的代码过度地复杂或冗余或修改面过大。

Visibility contract previously specified verbatim:

> 就是业务入口就应该根本就看不到 hidden 的这个消息。
>
> 那调整的时候呢，需要有一个相应的一个情况，就是可以加一个这个可选参数。那可选参数默认是，不包含的，也就是那个，就是 include hidden，它默认是 false 的。然后只有强制，有一些业务真的需要 hidden 的时候，它再去显示地调用读取。否则所有的下游业务，它根本使用原生的那个调用的接口，它根本就看不到 hidden 的消息。

Test/scope constraints carried forward verbatim:

> 你可以新增测试，但是你新增最多只能新增两个测试，然后同时现有的这个测试你可以进行相应的一个清理。
>
> 请注意不要去跑全量测试，因为全量测试可能需要几十分钟，很慢。所以你可以只跑几个关键的测试即可。

Follow the user's Session GOAL workflow and `docs/workflow.md`: independently approve the exact plan, implement through TDD, full-scope independent implementation audit, then verified. No commit or push.

## 2. Explicit Non-Goals

- No new DB schema, migrations, live user DB writes, configuration, dependencies, flags, or global SQLite/Drizzle interception.
- Preserve previous uncommitted Compaction pair invalidation and tests; do not rewrite unrelated staged plans, VSCode files or thirdparty content.
- Preserve file Snapshot/revert policy, historical usage/cost, physical cold ownership, raw event tombstones and fork cloning.
- Do not remove hidden checks on independently supplied arrays, plugin outputs or raw events. They have no upstream visible-read guarantee.
- Do not redesign plugin tool-context references, external share/event protocols, or v2 migration. The identified plugin-after-tool-closure issue is a separate producer after DB admission; its existing visible projection remains. This goal repairs persisted read defaults and proven redundant downstream filters.
- Do not add a general recovery engine for Revert. Resume its existing cleanup range idempotently; preserve existing cancellation/file-state mechanisms.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| Root and packages/opencode AGENTS.md | Minimal functions, Effect style, package-local tests/typecheck |
| packages/opencode/test/AGENTS.md | Existing Effect fixtures and observable behavior |
| src/server/routes/instance/httpapi/AGENTS.md | Domain NotFound mapped at HTTP adapter |
| CONTEXT.md | Message has multiple Parts; v1 is current production; Snapshot is file-state, Compaction is context |
| docs/adr/README.md | Only triage ADR present; no hidden-read exception ADR |
| first-principles-engineering policy and canonical template | One owning primary path, no fallback, exact-revision audit, E/C gate |
| docs/workflow.md | Verified implementation terminal state; audit evidence and scope review |

## 4. Files and Evidence Read

All short paths below are relative to packages/opencode.

| Evidence | Why | Class |
| --- | --- | --- |
| src/session/message-v2.ts:883-1067,1446-2010 | Current raw/visible entrypoints, hydration, proof and structural consumers | observed |
| src/session/session.ts:575-600,765-780,885-946 | messages/find wrappers; direct getPart bypass | observed |
| src/session/prompt.ts:730-835,2474,2634-2640,3393-3408 | Cancel ownership and all-undone recovery return | reachable |
| src/session/processor.ts:285-298,752-754,1074-1104 | getPart tool-state owner and doom-loop visible consumer | reachable |
| src/session/stale-turn.ts:88-118,145-245 | Hidden incomplete/orphan tool recovery | reachable |
| src/permission/reviewer/service.ts:157,819-846,1046,1280-1352 | Transcript vs owned tool terminalization vs protocol retry | reachable |
| src/session/request-usage.ts:280-310 | Actual incurred step usage must include hidden rows | contracted |
| src/session/revert.ts:46-91,152-226 | Pending revert vs persisted hidden; partial cleanup retry | reachable |
| src/session/summary.ts:38-59 | Ordinary target/children read, not audit |
| src/server/routes/instance/httpapi/handlers/session.ts:214-223,459-477 | Read first, reject/filter later wrappers | observed |
| src/session/search.ts; summary-cache.ts:150-154,225-295 | Already visible SQL/independent array guard |
| src/storage/cold.ts; projectors.ts | Raw ownership and accounting require physical rows |
| test/session/messages-pagination.test.ts:236-249,694-767,1071-1118 | Existing visibility/cold/anchor fixtures |
| test/session/revert-compact.test.ts:468-511,543-570,765-804 | Existing cleanup and raw audit assertions |
| test/session/stale-turn.test.ts; test/permission/reviewer-service.test.ts | Existing recovery/reviewer regression seams |
| Commit 3b2925b777 | Historical implementation fixed output consumers but left raw defaults | observed |
| D:/Temp/opencode/hidden-read-defaults-repro.ts | Actual in-memory DB and actual reader calls | observed |

Re-read unchanged files through Read; same-version stubs confirm the already-visible source. Current git status identifies the four-file previous goal baseline; no unrelated modifications are authorized.

## 5. Current Behavior

```text
ordinary get/parts/stream -> raw rows/default hydrate(true) -> hidden content exposed to caller
HTTP get -> raw get -> check hidden after complete message/part thaw
findHot -> visible parent -> hydrate(true) -> drop hidden parts after thaw
targetWithAssistantChildren -> raw target/children -> hydrate(true) -> later diff filtering
Session.getPart -> direct PartTable lookup -> decode without parent visibility
```

Session.messages -> page is already visible by default; Session.findMessage -> findHot already filters parent rows. Revert initially sets session.revert, not Message.hidden; unrevert clears that pending boundary and restores files. Cleanup later hides the suffix. Failure after hiding its boundary but before clearing session.revert currently makes a retry unable to locate the hidden boundary in its visible scan.

## 6. Supported Input Domain and Reachability

| Condition | Producer/path | Owner | Class |
| --- | --- | --- | --- |
| Hidden Message with still-visible Parts | Undo cleanup, compaction cancellation, stale/reviewer repair | MessageV2 admission | observed |
| Visible Message with hidden Part | Public partial revert/Part update | MessageV2 admission | reachable |
| Hidden cold owner | Existing freeze/maintenance | Visibility before thaw | reachable |
| Hidden unfinished Tool | Partial hide or interrupted cleanup while state still open | Cancel/processor/reviewer/stale state writers | reachable |
| Hidden completed step usage | Historical undo | RequestUsage accounting | contracted |
| Hidden ordinary retained tail anchor | Existing supported historical repair fixture | Internal compaction structural scan | observed |
| Interrupted revert cleanup | Per-message writes followed by clearRevert | Revert cleanup | reachable |
| Missing parent/part | Existing NotFound / empty / undefined contracts | Existing readers | contracted |

## 7. Required Invariants

| ID | Invariant | Verification |
| --- | --- | --- |
| V1 | Ordinary read defaults exclude hidden parents and children before thaw/child content hydration | Original repro; extend existing visibility fixture |
| V2 | Explicit includeHidden:true preserves full physical data for actual recovery/usage owners | Same fixture raw opt-in; existing recovery/usage tests |
| V3 | Public Session.getPart obeys the same default and parent precedence | Same fixture exact-part read |
| V4 | Callers with unbypassable visible input remove redundant checks; independent raw/array/event inputs retain theirs | Diff + HTTP/doom-loop regressions |
| V5 | Lifecycle cleanup and actual usage remain complete even for hidden rows | Existing cancel/stale/reviewer/revert/usage tests |
| V6 | Revert cleanup retry handles already-hidden boundary without rewriting old tombstones | Extend existing cleanup-preserves-history case |
| V7 | Previous hidden Compaction invalidation, tail anchoring, cache proof and cold references remain intact | Existing focused Compaction tests |
| V8 | <=2 new test cases, small diff, distributed explanatory comments, no full suite | Actual diff and commands |

## 8. First Divergence and Root Cause

The storage-backed reader admits raw records by default; downstream filtering cannot undo thaw or prevent another caller from consuming the data. Session.getPart has the same first divergence in its separate single-row query. These are the owners, not each Tool/HTTP caller.

Executed 2026-09-24 from D:/Temp/opencode:

```powershell
bun D:\Temp\opencode\hidden-read-defaults-repro.ts
```

Actual imports are current MessageV2 and storage/db. OPENCODE_DB=:memory: and isolated XDG paths are set before dynamic imports. Two user rows: visible/hidden; visible parent has one visible and one hidden Part; hidden parent has an unmarked Part. No user DB is opened. Exit 1 in 1.7 seconds:

```json
{"actual":{"getHidden":"Success","visibleParts":["prt_hidden","prt_visible"],"hiddenParentParts":["prt_child"],"stream":["msg_visible","msg_hidden"]},"expected":{"getHidden":"Failure","visibleParts":["prt_visible"],"hiddenParentParts":[],"stream":["msg_visible"]}}
```

This is the deterministic red feedback loop, not a mock of the filter. Upstream missing defaults predicts these results; UI-only filtering or cached rendering cannot cause them because the reproduction uses neither.

## 9. Responsibility and Seam

| Concern | Owner | Why |
| --- | --- | --- |
| Visible Message/Part admission | MessageV2 get/parts/page/hydrate | Last shared read seam before content restore |
| Exact Part admission | Session.getPart | Existing direct query must honor the same contract before decoder |
| Raw opt-in | Lifecycle/accounting callsite | Only owner knows why physical hidden data is needed |
| Pending undo recovery | SessionRevert.cleanupCurrent | Owns boundary, per-row hiding, usage reconciliation and clear |
| HTTP error mapping | Existing HTTP wrapper | Domain NotFound already mapped, no new error shape |

## 10. Single Approved Primary-Path Design

1. get input gains includeHidden?:boolean. SQL excludes hidden parent by default before info/parts. Pass mode to child reader.
2. parts(messageID, options?) gains includeHidden?:boolean. Default query admits only a visible parent and visible Part before thaw; raw mode retains existing array semantics. Missing/hidden parent yields [].
3. stream default changes true -> false. page already defaults false and keeps its bounded refill/cursor behavior. Do not refactor it into a new pagination algorithm.
4. hydrate default false: filter parent rows first, derive IDs/infos from admitted rows; retain existing pre-thaw Part filtering. findHot inherits this, dropping its post-hydrate part filter. Remove page's duplicate final visibility loop, now guaranteed by slice admission + hydrate.
5. targetWithAssistantChildren selects visible rows before checking target presence; hidden target returns [] (not children-only), then visible hydrate.
6. Session.getPart input/interface gains includeHidden?:boolean; its current exact-row SQL checks parent/session ownership and child visibility before decoder. No new helper/module or N-parts scan for a single Part.
7. cancelSnapshot and stepFinishParts gain the same optional mode; default checks visibility. Current cancellation and accounting callers explicitly opt into raw. stepFinishParts stays a narrow hot accounting projection and does not hydrate tool history.
8. Internal filterCompactedEffect must explicitly request raw stream after default flip; promptWindowSuffix keeps explicit true. They own structural hidden anchor recognition and return only the established visible projection. Keep current hidden-pair invalidation; no resurrection of a hidden Compaction. proof, rawForkRows, decoder, projectors and cold physical ownership stay purpose-specific raw paths.
9. Session.messages input gains includeHidden?:boolean, forwarded in both bounded and paginated branches for the ONE recovery consumer below. Ordinary callers omit it; Session.findMessage interface remains unchanged.
10. cleanupCurrent reads only its persisted boundary-and-newer range via Session.messages({fromMessageID:boundary.messageID,includeHidden:true}). Already-hidden messages keep their hidden metadata; write Message state only when new hidden/terminalization is required. Reconcile assistant usage idempotently before clearing boundary, including a previous pass that stopped after hide but before accounting. Already-hidden Parts after a partial boundary are not rewritten. Existing single-flight and Snapshot/file semantics remain unchanged. This directly resumes the same cleanup algorithm, not a second recovery path.

Explicit raw call inventory:

| File/function | Change |
| --- | --- |
| prompt.cancel + abortPendingAssistants | Both cancelSnapshot calls true; get pending assistant true |
| prompt.loop all-undone recovery return | Existing page(true) retained; not Provider input |
| stale-turn.incompleteAssistants / terminalizeOrphanTools | parts(...,{includeHidden:true}) |
| processor.readToolCall | getPart includeHidden:true for owned durable Tool lifecycle |
| reviewer tool-input-end / tool-call | getPart true preserves raw identity/hidden during state replacement |
| reviewer.closeOpenReviewerTools | Both parts and getPart true |
| reviewer.hideReviewerProtocolAttempt | Remove needless stream(true); current request/assistant are visible before this helper hides them. get stays default |
| reviewer.updateToolAutoReview / evidence transcript | Default visible: display and authorization do not need old hidden rows |
| request-usage.recordAssistant | stepFinishParts(...,{includeHidden:true}) |
| revert.cleanupCurrent | Bounded Session.messages(true) for restartable write lifecycle |

Do not add false at every ordinary callsite. Task/read/skill/model selection, export/share snapshot, search and normal Revert retain their existing calls and inherit the owning default.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| Default visible reads | Primary contract | Repair |
| Explicit raw recovery/usage/structural reads | Supported-domain branch with named owners above | Preserve explicitly |
| Parent hidden -> not-found/[]/undefined | Existing return-contract branch | Preserve |
| Raw physical fork/cold/projector/Stats | Contracted pass-through | Preserve, no global SQL filter |
| Downstream compensating filters after guaranteed visible read | Superseded workaround | Remove specified checks |
| Array converters, plugin projections, event tombstones | Independent trust seams | Preserve |

New alternate success paths zero; new diagnostic decision surface zero percent. No retry/catch-and-success additions.

## 12. Workaround Deletion and Replacement

- Remove HTTP get's post-read parent hidden check and Part filter; parent-update check relies on default get NotFound. Keep error mapping and all ID equality validation.
- Remove MessageV2 page final hidden loop and findHot post-thaw hidden-Part filter.
- Remove processor currentTools !part.hidden predicate after default parts establishes it; keep tool type/state eligibility.
- Replace outdated stream/raw-get/late-part-filter comments with the default admission contract.
- Keep visible()/filterCompacted/collectToolDiffs/reviewer transcript/plugin guards: their arguments are independently supplied or explicitly raw; no unbypassable visible-read guarantee applies.

## 13. Forward Traceability

| Invariant | Production path/change | Behavior seam |
| --- | --- | --- |
| V1/V3 | MessageV2 + Session.getPart admission | Existing pagination visibility fixture extended across default and explicit raw reads |
| V2/V5 | Named raw options at cancel/processor/reviewer/stale/usage | Existing targeted suites and raw audit assertions |
| V4 | HTTP get/updatePart; page/findHot; doom-loop current parts | Existing SDK hidden and processor hidden tests |
| V6 | Bounded raw cleanup + unchanged hidden metadata + replay usage | Existing cleanup-preserves-history test extended with pre-hidden boundary and repeat cleanup |
| V7 | Explicit internal structural raw reads | Existing compaction/hidden-anchor cases and prior goal Provider test |
| V8 | Test reuse / comment gates | Diff count, focused test list, E/C |

## 14. Reverse Traceability

| Concept | Requirement | Existing insufficiency |
| --- | --- | --- |
| includeHidden default false | V1/V2/V3 | get/parts/stream/hydrate lack consistent default |
| Parent admission before child restore | V1 | Filtering child alone bypasses parent via known ID |
| Explicit lifecycle/usage opt-in | V2/V5 | Default flip otherwise skips unfinished hidden tools/actual charges |
| Session.messages flag forwarding | V6 | Recovery range must include already-hidden boundary; visible-only wrapper cannot express it |
| Idempotent cleanup row handling | V6 | Raw recovery must not rewrite unrelated old tombstone times or skip interrupted accounting |

## 15. File-Level Change Plan

| File | Responsibility | Expected changed lines |
| --- | --- | --- |
| src/session/message-v2.ts | Default admission and deletion of duplicate filters | 65-100 |
| src/session/session.ts | getPart admission, messages option forwarding | 15-30 |
| src/session/prompt.ts | Cancellation opt-ins | 5-12 |
| src/session/stale-turn.ts | Repair opt-ins | 4-8 |
| src/session/processor.ts | Owned read opt-in; duplicate filter removal | 3-8 |
| src/permission/reviewer/service.ts | Lifecycle opt-ins; narrow protocol search | 8-16 |
| src/session/request-usage.ts | Explicit raw accounting | 2-5 |
| src/session/revert.ts | Bounded raw cleanup and idempotent replay | 15-30 |
| src/server/routes/instance/httpapi/handlers/session.ts | Remove old get-result filters/comments | -8 to -4 |
| Existing tests affected by raw get/stream assumptions | Add true where the assertion intentionally inspects audit/repair state | one argument per affected call |

No new production/test files. Existing previously modified files are preserved, and this goal's diff is measured against its starting worktree.

## 16. TDD Behavior Slices

1. Extend existing `visible limit skips hidden Messages and thaws no hidden Parts` with the same small fixture covering default get/parts/stream/getPart, parent dominance and raw opt-in. Default APIs must return the same visible records; hidden cold owners remain cold until explicit raw read. Watch red; repair read owners and necessary raw callers; green.
2. Extend existing `cleanup preserves hidden messages in database`: seed the normal revert boundary, make the first boundary already hidden (representing interrupted cleanup), run actual cleanup, assert visible remainder empty, original hidden timestamp preserved and boundary cleared. Keep hidden audit reads explicit. Watch old cleanup red before repair; implement V6 and green.
3. Strengthen existing raw-owner fixtures with minimal state changes, not new cases: in `cancel finalizes stale running tool parts without an active runner`, mark its seeded Assistant hidden before cancel and inspect afterward with explicit raw get; missing cancelSnapshot/get opt-in then leaves it unfinished. In `recent reconcile aborts open tools with interrupted metadata`, hide the seeded Tool before reconcile and inspect with raw get; missing stale parts opt-in leaves it open. In `cleanup terminalizes unfinished assistant messages hidden by undo`, add one nonzero step-finish Part and assert the actual RequestUsage assistant totals after cleanup; missing raw stepFinishParts opt-in loses those totals. These assertions target changed callers, not only reader primitives.
4. Extend the same visibility fixture to `targetWithAssistantChildren`: hidden target returns empty and hidden children are excluded. Existing tests inspecting hidden audit rows change to explicit true; existing stream-based structural tests request raw explicitly only where testing hidden anchors. Do not change expected behavior of unrelated tests. Reuse existing reviewer/SDK/processor cases for the remaining unchanged lifecycle predicates, no new defensive matrix.

At most two new cases are authorized, but planned new case count is zero. Focus on positive result contracts, not repeated absence assertions.

## 17. Chinese Comment Budget

Estimate E=130-220 (production plus changed tests; excluding imports, formatting, docs and pure moves). Require C>=max(1,ceil(E*0.15)), estimated 20-33 qualifying lines. Explain parent dominance before cold thaw, raw tool terminalization, accounting preservation, structural anchor exception, partial-cleanup restart boundary and cold fixture observation. Distribute comments at those decisions, not a header block. Actual diff count governs; no padding.

## 18. Verification

Run in packages/opencode unless noted. Only focused cases/small relevant files; never full repository suite or full prompt suite.

| Command | Purpose |
| --- | --- |
| `bun D:\Temp\opencode\hidden-read-defaults-repro.ts` (D:/Temp/opencode) | Original actual-interface failure becomes green |
| `bun test test/session/messages-pagination.test.ts -t 'visible limit\|hidden\|findMessage\|MessageV2.get\|MessageV2.parts\|MessageV2.stream' --timeout 30000` | Direct visible/raw/cold contracts and related anchors |
| `bun test test/session/revert-compact.test.ts --timeout 30000` | Small existing undo suite; recovery/files |
| `bun test test/session/stale-turn.test.ts --timeout 30000` | Existing state recovery |
| `bun test test/session/revert-compact.test.ts -t 'terminalizes unfinished assistant' --timeout 30000` | Nonzero actual accounting after hidden mutation |
| `bun test test/session/compaction.test.ts -t 'hidden\|failed\|cancel\|memento' --timeout 30000` | Existing scratch/anchor/history regressions |
| `bun test test/session/prompt.test.ts -t 'cancel\|cleanup\|rebuilds a retained window after Compaction' --timeout 30000` | Raw cancel opt-ins and previous repair |
| `bun test test/permission/reviewer-service.test.ts -t 'protocol\|cancel\|interrupt\|terminal\|cleanup' --timeout 30000` | Owned reviewer raw state |
| `bun test test/server/httpapi-sdk.test.ts -t 'hidden' --timeout 30000` | SDK visible interface |
| `bun test test/session/processor-effect.test.ts -t 'hidden\|cleanup\|terminal' --timeout 30000` | Tool lifecycle vs visible history |
| `bun typecheck` | Package type contract |
| `git diff --check` (root) | Hygiene |

Adjust name filters to exact existing test titles if needed; do not widen to full slow suite or report zero selected tests as verification. Capture raw results under D:/Temp/opencode for independent audit. No dependency changes are planned; if environment fails report prerequisite rather than hide failure.

## 19. Diff Budget

9 production files, no new production concepts beyond visibility option and owning admission. ~120-200 production changed lines including comments, ~40-80 substantive test lines plus raw-opt-in corrections. Zero new test cases planned (hard cap two). One new canonical plan; zero generated/schema/dependency changes.

## 20. Real Risks and Open Decisions

- Default flips expose tests/callers that intentionally use raw audit data. Migrate verified owned reads explicitly, never globally restore raw defaults.
- Raw getPart state writers must preserve existing hidden fields while terminalizing tools.
- Parent visibility must be checked before child cold hydration; output-only filtering fails the requirement even if response is clean.
- Internal structural reads remain raw and filter before returning; changing their tail ordering/anchor rules is outside this goal.
- Cleanup raw range can include prior tombstones: preserve their metadata and use idempotent usage record upserts.
- Existing Windows short-case timeouts and cold combined-suite fixture interactions were observed in the previous goal. Use focused/isolated runs, record failures; no unrelated timeout or assertion changes.

### Open Decisions Requiring the User

None. No public HTTP raw-history option is exposed. This is an internal read contract change.

### Rejected Speculation

- Do not refactor all Tool consumers or raw storage queries simply because they mention Message/Part.
- Do not remove checks on raw events or arbitrary input arrays based on a DB-reader guarantee that does not apply there.
- No new security envelope, feature flag, rollback database, cache flush service or alternative decoder.

## 21. Audit Contract

Auditor alone loads adversarial audit materials. Handoff contains only verbatim requirement, this path, root and mode. Audit entire goal and current affected interface; report concrete owner/path consequences, under/over-design, obsolete filter removal, raw exceptions and Chinese-comment gate. Scope-review any blocker per user workflow before revision. Original user test budget and no-full-suite constraint remain binding.

## 22. Plan Audit Record

| Round | Revision | Full scope | Result | Invocation |
| --- | --- | --- | --- | --- |
| 1 | R1 | yes | BLOCK, B-01 | ses_f2c82bd38ffexHNGWiQgXifntp |
| 2 | R2 | yes | No blocking findings. APPROVE | ses_f2c82bd38ffexHNGWiQgXifntp |

R2 independent verdict (verbatim):

No blocking findings.

Non-blocking findings:

- R1 的 B-01 已在方案层面解决。R2 §16 明确通过实际 owner 验证隐藏 Assistant 的取消、隐藏 Tool 的 stale repair，以及隐藏后非零 step-finish 的 accounting；遗漏相应 raw opt-in 时，这些断言能够失败。不存在的 accounting 测试命令已替换。
- R1 关于 `targetWithAssistantChildren` 的验证建议已纳入同一 visibility fixture。
- V6 仍属于既有 cleanup 重入问题的局部修复。其范围限定于原 cleanup owner、持久边界和幂等写入，不授权扩展恢复机制。

**APPROVE — `docs/plans/message-read-visibility-defaults.md`，R2，full-scope plan audit。**

本次批准仅适用于 R2。可记录该 revision 的批准并进入实施；`verified-implementation` 仍需完成 TDD、聚焦验证及独立全范围实现审计。未授权 commit 或 push。

R1 verdict (verbatim):

**BLOCK — `docs/plans/message-read-visibility-defaults.md`，R1。**

阻塞项为 **B-01：raw 消费路径的行为验证不足**。修订 canonical plan 后需按完整范围重新审计。

B-01 (Blocking): 显式 raw 消费路径缺少对默认值翻转敏感的行为验证。

- Violated invariant: V2/V5：默认读取隐藏记录后，生命周期清理和实际用量统计仍须完整；policy 要求确认行为具有敏感的验证路径。
- Evidence class: reachable。
- Concrete production, test, or contract consequence: 按当前验证计划，即使遗漏 `recordAssistant` 的 raw 参数，hidden Assistant 的 step-finish 汇总仍可能变成零而未被验证发现；遗漏取消或 stale repair 的 raw 参数，也可能留下未终态化的 hidden Tool。已有 cancellation/stale fixture 使用可见记录，reviewer closure fixture 的 `getPart` mock 不执行真实可见性规则。
- Minimal correction direction: 在现有少量 fixture 中加入 hidden 持久状态，并通过实际生命周期及 accounting owner 验证终态和非零用量；明确这些断言在遗漏 raw opt-in 时会失败。替换不存在的 accounting 验证命令。继续遵守最多新增两个测试、不跑全量测试的约束，无需增加防御矩阵。

Non-blocking findings (verbatim):

- `targetWithAssistantChildren` 的隐藏 target/children 行为也应纳入同一现有 visibility fixture。当前唯一直接测试验证的是 chronology 封界，见 `packages/opencode/test/storage/cold.test.ts:1993`，未验证隐藏 target 不返回 children。
- V6 修复的是已存在的 cleanup 重入问题：`Session.messages` 当前已经默认可见，见 `packages/opencode/src/session/session.ts:891`。它不应被描述为默认值翻转引入的回归。方案给出了真实中断路径和同一 cleanup owner，审计不要求扩展为通用恢复机制。

Scope review: B-01 directly tests the new visibility-default boundary and explicit opt-ins introduced by this goal, so it is accepted in scope. R2 changes only verification slices/commands, not production design or new test count. R2 still plans zero new cases.

## 23. Implementation Evidence

Implemented approved R2. This goal did not access or modify the user's live database. All runtime fixtures use isolated/in-memory test databases. No dependency/config/schema changes, commits, or full test suites.

### Actual Files and Diff

Nine production files listed in section 15 changed, plus five existing test files: messages-pagination, revert-compact, prompt, stale-turn, httpapi-sdk. Existing previous-goal Compaction changes remain untouched. Starting worktree diff is saved as `D:\Temp\opencode\hidden-read-goal-baseline.patch`; it contains the four-file 41-added/23-removed previous implementation. Current total diff is 176-added/92-removed; this goal contributes 135 added and 69 removed lines. No new production or test files; zero added test cases. Canonical plan is the sole new repository document for this goal.

### Red-Green Test Evidence

Observed red then green:

- Extended `visible limit skips hidden Messages and thaws no hidden Parts`: failed with get Success, hidden parent children present, hidden cold child expanded, raw stream and hidden target returned. Fixed readers: passes, cold hidden Part remains cold until raw opt-in.
- `cleanup resumes from a hidden boundary and preserves audit messages`: failed with `Revert cleanup boundary missing from Session history`; bounded raw cleanup passes and preserves the original hidden timestamp.
- Existing cleanup/accounting case with nonzero step: failed `Expected 37, Received 0` before recordAssistant raw opt-in; passes with 37 input tokens afterward.
- Existing stale open-tool case with hidden Part: failed `Expected error, Received pending` before raw parts opt-in; passes after opt-in.
- Existing cancel stale-tool case with hidden Assistant: failed because time.completed remained undefined before cancelSnapshot/get opt-ins; passes afterward.
- Existing raw audit assertions in goal resume and SDK lookup now explicitly request includeHidden:true; their expected stored-history behavior is unchanged.

### Verification Commands and Results

All commands ran from packages/opencode except the original diagnostic and git commands. JUnit artifacts are generated directly by Bun under D:/Temp/opencode:

| Command/filter | Result | Raw artifact |
| --- | --- | --- |
| messages-pagination: `visible limit\|hidden\|findMessage\|MessageV2.get\|MessageV2.parts\|MessageV2.stream` | 25 pass, 0 fail | hidden-read-direct.xml |
| revert-compact small suite | 16 pass, 0 fail | hidden-read-revert.xml |
| stale-turn small suite | 7 pass, 0 fail | hidden-read-stale.xml |
| prompt: `cancel finalizes\|rebuilds a retained window after Compaction\|goal resume.*revert\|auto permission reviewer.*protocol` | 7 pass, 1 existing skip, 0 fail | hidden-read-prompt.xml |
| reviewer-service: `closes\|protocol\|interrupt\|terminal\|cleanup` | 4 pass, 0 fail | hidden-read-reviewer.xml |
| compaction: `hidden\|failed\|cancel\|memento` | 4 pass, 0 fail | hidden-read-compaction.xml |
| processor-effect: `hidden\|cleanup\|terminal` | 2 pass, 0 fail | hidden-read-processor.xml |
| httpapi-sdk: `matches generated SDK session message and part routes` | 1 pass, 0 fail | hidden-read-sdk.xml |

All test commands use `--timeout 30000`; reporter runs additionally use `--reporter=junit --reporter-outfile=D:\Temp\opencode\<artifact>`. Total 66 passed and 1 pre-existing skipped case, no full repository/prompt suite run. Filters were matched against actual existing test titles (the SDK title does not contain the word hidden).

`bun typecheck` passed; native transcript `D:\Temp\opencode\hidden-read-typecheck.log` records the command, package cwd and native exit code 0. `git diff --check` passed. No failed check was bypassed or weakened.

### Original Feedback-Loop Result

Original actual-interface diagnostic now exits 0. Raw native transcript: `D:\Temp\opencode\hidden-read-original-repro.log`.

```json
{"actual":{"getHidden":"Failure","visibleParts":["prt_visible"],"hiddenParentParts":[],"stream":["msg_visible"]},"expected":{"getHidden":"Failure","visibleParts":["prt_visible"],"hiddenParentParts":[],"stream":["msg_visible"]}}
```

### Actual Secondary and Replacement Path Inventory

Visible/default and explicit raw remain two supported modes of the same primary readers. No new fallback, catch-and-success, retry, cache, data source, or helper. Existing independent event/array/plugin filtering and raw physical maintenance preserved. Duplicate page/findHot/HTTP/doom-loop filters removed only after their read owner guarantees visibility. Cleanup resumes the original bounded persisted operation, keeps old tombstones and replays usage through its existing idempotent owner.

### Chinese Comment Calculation

Current combined code diff: E=133, C=40. Previous goal baseline E=28, C=12 is unchanged. This goal E=105, C=28, C/E=26.67%; required minimum ceil(105*0.15)=16. Count added or substantively replaced nonblank code, exclude comments themselves/import-only changes/docs and unchanged context; no generated/format-only/pure-move changes. Comments explain parent admission before cold restoration, explicit raw lifecycle/usage, structural anchor exception, hidden cleanup resume, and positive fixture expectations. They are distributed adjacent to each owning decision.

### Remaining Unverified Items

Focused verification, package typecheck and independent full-scope implementation audit completed. No live-daemon deployment, build, full repository CI or external event/share integration run; none is claimed. Existing skipped prompt case remains skipped. Earlier unrelated worktree state and database repair artifacts are preserved.

## 24. Implementation Audit Record

| Round | Approved revision | Full scope | Blocking findings | Result | Invocation |
| --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings. | APPROVE | ses_f2c6688deffeJAzf3Ca02XEw5t |

Independent findings and release verdict (verbatim):

No blocking findings.

## Blocking findings

None.

## Non-blocking findings

- The focused JUnit artifacts include skipped tests from unselected cases, but the selected cases themselves report zero failures. This is consistent with the constrained verification scope.
- The implementation diff contains preserved prior Compaction changes in addition to the fourteen goal paths; the baseline patch and R2 plan correctly distinguish those changes.

## Rejected speculation

- No evidence supports requiring hidden-read guards in independent raw event, plugin, array, fork, cold-storage, or projector paths; those seams intentionally retain their existing contracts.
- `MessageV2.parts` lacking a session parameter is not a newly introduced cross-session defect; `Session.getPart` remains the session-owned public exact-part seam.
- No alternate success path, catch-and-success behavior, retry family, compatibility adapter, or duplicated visibility policy was introduced.

## Release verdict

**APPROVE** — the actual implementation diff satisfies approved plan R2 and the original requirement. The goal may advance to `verified-implementation`; no commit or push is authorized.

The auditor independently inspected runtime artifacts and recomputed goal E=105, C=28 (26.67%). Plan audit: 2 full rounds, R1 B-01 addressed in R2 through existing hidden-state fixtures. Implementation audit: 1 full round, no blockers. This administrative verification record changes no implementation behavior.
