# Canonical Implementation Plan: TUI scroll layout stability

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: current user request quoted below
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-16

This is the sole implementation specification for this task.

## 1. Verbatim Requirement

> 那本质上而言，我认为这个松手跳，你以后你说话的时候你使用不要过度简称。松手跳本质上就是你自己创立的一个简称，不得使用这类简称来去进行表达。与此同时，请注意，我认为这个在拖动滚动条即使没有移动，然后它之后会自动进行相应一个跳动的一个情况，这本质上正是重排、重新排布的一个必要的，或者说一个不可避免的一个机制，所以本身我认为这是用户可接受的。因为毕竟用户正常情况下不会去手动地选择拖动那个滚动条，那如果他拖动了，那本质上他就应该去接受这个重排的风险。那所以这个本身上是可以理解的。那因此与此同时请你完整去看一下，你说它只需要几十行的量级，那现在我给你相应的最多四个生产代码文件的一个修改机会，同时最多修改行数，生产代码不超过四百行。所以现在请你开始按照完整的 workflow，也就是相应的 first plan，然后等等的一些 verify implementation and commit 的逻辑进行相应的完整的方案构建以及方案实现等等内容。

Prior requirement retained:
> 我希望最终的实现保持精简清爽，同时又能够不会，就是影响用户体验，就是之后不会再这种发射任何的这种弹跳，或者说用户在滚动翻译的时候，它有一个滞后的一个增量，这都是算是一种卡顿。

## 2. Explicit Non-Goals

- User accepts native scrollbar-drag position changes as extents change. Do not modify Slider drag semantics or quantization.
- No new virtual-list framework, animation, timer, retry, setting, alternate renderer, or dependency release.
- No changes to permissions or other dirty worktree files. Commit only task files; no push authorized by this request.
- Width changes necessarily rewrap visible text. Preserve visible Message-root offset, not identical pixels or a semantic character position inside a rewrapping paragraph. Selection content must remain correct.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| AGENTS.md, packages/opencode/AGENTS.md, test/AGENTS.md | Bun tests/typecheck from package; real behavior; preserve unrelated changes |
| CONTEXT.md | Message/Session ownership; current v1 Session is relevant |
| docs/adr/README.md | No scrolling ADR exists |
| .opencode/policy/first-principles-engineering.md | Independent plan/implementation audits; primary owner repair; Chinese comments |
| package.json patchedDependencies | Existing installation delivery mechanism for dependency source repairs |

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| node_modules/@opentui/core/index.js:10113-10673 | ScrollBox, sticky state, input, extent update | observed |
| node_modules/@opentui/core/index-b5dpwnes.js:1120-1199,1388-1457 | Layout traversal before rendering/culling | observed |
| node_modules/@opentui/core/renderables/ScrollBox.d.ts | Actual installed interfaces | contracted |
| thirdparty/opentui/packages/core/src/renderables/ScrollBox.ts | Corresponding source ownership; not runtime dependency | observed |
| packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:459-868,1733-1883 | Current delayed correction, remeasurement and consumer | observed |
| packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:3971-4361 | Real Session harness, residency/resize tests | observed |
| packages/opencode/src/cli/cmd/tui/component/spinner.tsx | Existing custom intrinsic option examined, rejected as unnecessary adapter |
| package.json, bun.lock, patches/@npmcli%2Fagent@4.0.0.patch | Patch registration and lock delivery | observed |
| packages/opencode/bunfig.toml, script/test-ci.ts | JSX preload and same-process TUI test partition | observed |
| D:/Temp/opencode/scroll-reflow-experiment.ts and notes | Real native-renderer minimized reproduction | observed |

## 5. Current Behavior

Part/width/display change -> mounted auto-height or shelled remeasurement -> Yoga layout -> ScrollBox extent/clamp/sticky -> child geometry and render list -> paint -> Session microtask -> eventual restore after all batches.

Current ScrollBox retains absolute scroll position when history geometry changes. Total height may be unchanged while the visible Message moves. Session captures an old anchor only on global invalidation and restores after all batches; it does not cancel that old position on manual input. Other ScrollBoxes use the same native class but do not promise Message residency behavior.

## 6. Supported Input Domain and Reachability

| Input | Producer | Guarantees/path | Owner | Class |
| --- | --- | --- | --- | --- |
| Growth/shrink above viewport | Session remeasure/Parts | Ordered direct Message roots with Yoga geometry | ScrollBox layout | observed |
| Width/display change | Terminal/sidebar/toggles | Yoga layout precedes render traversal | ScrollBox layout | observed |
| Wheel/key/navigation | Existing public scrollBy/scrollTo | Input changes translation before next layout | ScrollBox | observed |
| Bottom following | stickyScroll + stickyStart | Session retains one-row tolerance | ScrollBox/Session existing policy | contracted |
| Selection | Native mouse selection and Session pins | Selected text remains mounted | Existing selection/pins | reachable |
| Removed root/revert | Session message window/revert | Current child list authoritative; deleted content cannot be preserved | ScrollBox clamp | reachable |
| Scrollbar drag | Native Slider | Existing mapping and rounding remain | Slider | contracted |

## 7. Required Invariants

| ID | Invariant | Evidence/test |
| --- | --- | --- |
| INV-01 | Each painted frame preserves the first intersecting surviving Message root's viewport offset when preceding geometry changes | native and Session frame tests |
| INV-02 | User wheel/key/navigation displacement is retained immediately; idle frames do not add delayed displacement | interleaved input and idle frames |
| INV-03 | Exact native bottom following and existing Session one-row tolerance remain | existing streaming tests + native bottom test |
| INV-04 | Residency, final geometry, selection/copy, navigation and cleanup remain correct | full Session/TUI suite |
| INV-05 | No new background work/timer or unbounded state; no measured material frame-time regression in native 300-root workload | benchmark comparison |
| INV-06 | <=4 production-related files, <=400 gross added/deleted production lines including patch/config/lock; independent audits before commit | diff audit |

## 8. First Divergence and Root Cause

INV-01 first diverges when new Yoga child positions are adopted with old absolute scroll position; correcting after paint is too late. Owning interface is ScrollBox.updateLayout before child traversal and culling. INV-02 additionally diverges when Session replays an old anchor after intervening input.

Reproduction (cwd D:/Temp/opencode): `$env:SCROLL_ROWS='300'; bun run D:\Temp\opencode\scroll-reflow-experiment.ts` rerun 2026-09-16. Baseline max errors: reflow/wheel/manual 14 rows, unchanged-total redistribution 2, resize 300; layout compensation 0 for these scenarios. This harness prints baseline comparisons and asserts the experimental candidate; committed tests must independently fail against installed unpatched ScrollBox. Scrollbar drag remains explicitly exempt.

## 9. Responsibility and Seam

| Concern | Owner | Reason |
| --- | --- | --- |
| Geometry compensation | Native ScrollBox | Owns translation, child layout, range and culling |
| Installation | Bun patch registration | Delivers owner fix without app monkeypatch/subclass |
| Residency/measurement | Session | Owns payload state and lifetimes; keep existing mechanism |
| Drag | Native Slider unchanged | User accepts range-related displacement |
| Test seams | Real native renderer/public scroll APIs and real Session render harness | Observe frames/geometry/input, never implementation text |

## 10. Single Approved Primary-Path Design

Add `preserveVisibleContent?: boolean` (default false) and `stickyScrollTolerance?: number` (default zero) to ScrollBox options and instance properties. Session enables preservation and sets tolerance to one row. This selects a contracted consumer behavior, not a failure-triggered alternative. Existing non-Session scroll boxes preserve their shipped semantics. The tolerance moves the existing Session policy to the owner with access to pre-layout coordinates; it adds no user setting.

At ScrollBox.updateLayout, when preservation is enabled:
1. Read old first visible direct child and its offset relative to viewport before updating cached layout. Read old maximum and exact old bottom state before range updates. Use current scroll position, so already-applied user input belongs to the new baseline.
2. Update viewport/content cached geometry from the already-calculated Yoga layout. Their existing size-change callbacks refresh extents only on actual size changes; NEVER call recalculateBarProps unconditionally per layout. Do not recalculate Yoga or walk/measure message subtrees.
3. If previously exactly at the sticky bottom, retain bottom following. If within configured bottom tolerance AND maximum grew, follow the new bottom. A manual one-row movement without growth remains untouched. Otherwise adjust position from the selected child's new Yoga top minus its old offset. With no surviving visible child, retain native clamped position (empty/deleted content is a supported state, not alternate recovery).
4. Run existing super.updateLayout once; selection autoscroll, child layout, culling, hit geometry and rendering continue normally. No frame timer, old anchor queue, or extra render traversal.

Patch the shipped index.js and its ScrollBox.d.ts in one tracked patch artifact. Do not edit hashed renderer bundles or Slider. Enable on Session and remove its delayed anchor capture/restore and reset fields. Also delete lastMaxScrollTop and the Session post-layout automatic scrollTo branch: its tolerance behavior now belongs solely to native pre-layout policy. Keep the Session renderAfter callback only for residency scheduling and publishing current viewportStuckToBottom status. Preserve remeasurement batching, selection pins, height freeze gate and payload lifecycle.

Prototype uses private calls because it was a subclass; production code inside the owning class requires no unsafe cast or access bypass. If real Session tests expose a wrong geometry ordering, repair this same pre-traversal path within budget; substantive design changes require revision/audit.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| Session preservation enabled | primary contract | one native layout path |
| Other scrollboxes default false | shipped contracted pass-through | preserve |
| Exact bottom vs history | supported contract branches | preserve |
| Empty/deleted child | supported native clamp | preserve |
| Slider drag mapping | shipped behavior explicitly accepted | preserve |
| Session final anchor restoration | obsolete second owner | delete |

New alternate success paths: zero. Diagnostics: zero percent.

## 12. Workaround Deletion and Replacement

Delete `remeasureAnchor`, `anchorRestorePending`, `captureRemeasureAnchor`, restoration block, finalization assignment, invalidation capture and session-reset assignments in index.tsx. Delete lastMaxScrollTop and the post-layout bottom-following branch, retaining only status publication. Native per-layout preservation and pre-layout tolerance policy supersede these corrections. Keep batch queues and remeasuring flag because they control actual resource work/culling.

## 13. Forward Traceability

| Invariant | Production change | Behavioral tests |
| --- | --- | --- |
| INV-01 | native patch + Session prop | grow/shrink, redistribution, resize each frame; shelled real Session resize |
| INV-02 | same patch + delete delayed restore | scrollBy, actual wheel, navigation and idle-frame checks |
| INV-03 | old bottom snapshot + existing tolerance | exact bottom, existing one-row streaming tests |
| INV-04 | no residency/selection changes | full Session file and all TUI tests; selection with preceding reflow |
| INV-05 | no stored anchors/timers/subtree walk | 300-root timed baseline/candidate experiment |
| INV-06 | patch/package/lock/index only | git diff numstat; independent audit |

## 14. Reverse Traceability

| Concept | Invariant | Why current logic cannot carry it |
| --- | --- | --- |
| native preservation option | INV-01/04 | Session needs content identity; other consumers retain default behavior |
| old visible geometry local variables | INV-01/02 | total-height deltas insufficient; persistent old anchors stale after input |
| owner patch delivery | INV-06 | dependency is released tarball, thirdparty edits alone do not execute |
| delete delayed restore | INV-02 | two position owners would override input |

## 15. File-Level Change Plan

| File | Change | Expected gross lines |
| --- | --- | ---: |
| patches/@opentui%2Fcore@0.4.3-smark.13.patch | New owner implementation + option/property declaration | 100-160 |
| package.json | patchedDependencies registration | 1-2 |
| bun.lock | install-generated patch registration | 1-10 |
| packages/opencode/src/cli/cmd/tui/routes/session/index.tsx | enable native behavior; remove final restore | 45-65 |
| packages/opencode/test/cli/tui/scroll-layout.test.ts | New real native behavioral tests | 180-260 test lines |
| packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx | Real Session frame stability and selection/reflow | 80-150 test lines |
| this plan | audit/evidence record | documentation |

## 16. TDD Behavior Slices

1. Native grow/shrink preceding content: red on old native absolute scroll; implement minimal enabled preservation; assert exact frame/offset, unchanged-total redistribution.
2. Input/idle and bottom: red regression guard for pre-layout changes; use scrollBy and mock wheel with independent intended motion, assert idle does not move. Include explicit navigation and empty content; verify opt-out unchanged.
3. Real Session resize with shelled roots and without: assert every sampled frame, not eventual waitFor success; remove old restore. Keep existing final geometry tests.
4. Selection with preceding reflow and existing full render suite: copied text remains exact; tool/Markdown/streaming flows use real existing harness.

R2 additions resolving B-01/B-02: real Session history reading with preceding growth larger than the old distance to bottom must remain stable on every frame; native one-row tolerance must not snap without growth and must follow on growth; real renderer `idle()`/idle notification must settle after input ends without manually pumping renderOnce. Use public scheduler idle state/notification, not private requestRender counts.

No private-method tests, source-string assertions or weakened existing expectations. Baseline constructor can serve only in performance comparison, not a duplicated expected-value algorithm.

## 17. Chinese Comment Budget

E estimate 260-380 substantive production/test lines; C >= max(1, ceil(E*0.15)), estimated 40-57 meaningful nearby Chinese comment lines. Explain layout-before-culling order, preserving user movement, sticky distinction, same-total-height case, selection and idle-frame oracles. Compute actual totals including test additions; do not pad comments. Patch code comments count as implementation comments, patch envelope does not.

## 18. Verification

| Command | cwd | Evidence |
| --- | --- | --- |
| bun test test/cli/tui/scroll-layout.test.ts --timeout 30000 | packages/opencode | native behavioral red/green |
| bun test test/cli/cmd/tui/session-message-render.test.tsx --timeout 60000 | packages/opencode | complete Session regression |
| bun typecheck | packages/opencode | public declarations/consumer |
| bun install --ignore-scripts | root | generate lock and apply tracked dependency patch |
| bun install --frozen-lockfile --ignore-scripts | root | reproducible patch registration |
| bun -e 'const files=(await Array.fromAsync(new Bun.Glob("test/cli/**/*.test.{ts,tsx}").scan())).filter(x=>/^test[\\/]cli[\\/](run|tui|cmd[\\/]tui)[\\/]/.test(x)).sort();const p=Bun.spawn([process.execPath,"test",...files,"--timeout","30000"],{stdout:"inherit",stderr:"inherit"});process.exit(await p.exited)' | packages/opencode | all TUI same-process tests |
| SCROLL_BENCH=1 bun test test/cli/tui/scroll-layout.test.ts --test-name-pattern benchmark --timeout 30000 (PowerShell uses $env:SCROLL_BENCH='1') | packages/opencode | 300 roots, 30 warmup + 200 alternating reflow/input frames per mode; median and p95 of renderOnce wall time; repeat 3 times; investigate if median-of-three p95 increases by both >25% and >1ms |
| git diff --check; git diff --numstat | root | clean diff and hard budget |

Each foreground verification command <=600 seconds. A command timeout/failure is not passing evidence. Unrelated core/permission changes are excluded from commit, but any verification failure must be reported and attributed with evidence. Remote CI is not required as push is not authorized; local full affected TUI partition is required.

## 19. Diff Budget

Four production-related files maximum, gross additions plus deletions <=400 including patch envelope, package.json and generated lock. Expected 147-237 lines; test/documentation excluded from user production budget, included in quality review. No allowance to hide another production change inside a test. Stop and revise if dependency installation causes extra tracked churn.

## 20. Real Risks and Open Decisions

- Content/viewport update callbacks can clamp before correction: native frame tests must cover contraction and direct-child padding/margin.
- Native layout traversal and selection autoscroll order must retain input displacement; test actual input, not only programmatic scrolling.
- Existing end-of-frame bottom tolerance may conflict with shrinking extents: full Session streaming coverage required.
- Async Markdown rebuilds may consume time even when coordinates stay stable. Measure existing real Session tests plus native overhead; no claim of universal zero CPU latency.
- Text inside visible paragraphs necessarily rewraps; semantic character anchoring is outside this root-geometry repair and explicitly reported, not silently claimed.

### Open Decisions Requiring the User

None for current scope. User explicitly accepts native scrollbar-drag range changes and authorizes commit. No publishing or push is included.

### Rejected Speculation

No new slider state machine, whole-list virtualization rewrite, network/server changes, new cache, or fallback renderer. Those lack necessity for this repair.

## 21. Audit Contract

Independent auditor reads verbatim requirements and entire canonical revision, reconstructs owner/call path, reviews full original scope each round, both under/over-design, no fallback, file/line budget, behavioral test sensitivity and 15% Chinese explanations. Max 6 plan rounds / 3 implementation rounds. No implementation before exact revision has No blocking findings.

## 22. Plan Audit Record

Round 1, R1, full scope, invocation `ses_f5a181bc9ffeZ86lnoNiXyqDbM`.

Verbatim finding IDs/classifications and release verdict:

> ## Blocking findings
> ### B-01 新的布局补偿会被 Session 保留的贴底判定覆盖
> ### B-02 每次布局刷新滚动范围会持续预约下一帧
> ## Non-blocking findings
> - §18 的 300-root 性能比较尚未提供具体计时命令、采样方法和“material regression”的判定标准。实施前应固定这些内容，避免结果出来后再选择标准。
> - 计划引用的临时实验可以用于定位算法，但不能代替提交后的回归测试。它还包含明确不在本次范围内的拖动实验分支；实现证据应只归属于实际交付路径。
> ## Release verdict
> **BLOCK — `docs/plans/tui-scroll-layout-stability.md`，R1。**
> B-01、B-02 需要写入修订后的 canonical plan，再进行完整范围复审。当前修订不允许进入生产实现。

R2 resolves B-01 by moving the existing tolerance policy into pre-layout native state and deleting the obsolete Session comparison. B-02 is resolved by using size-change-triggered extent refresh and requiring scheduler idle convergence. Full-scope R2 audit pending; approval remains none.

## 23. Implementation Evidence

Plan audit round 2, R2, full scope, invocation `ses_f5a181bc9ffeZ86lnoNiXyqDbM`. Verbatim verdict:

> ## Blocking findings
> No blocking findings.
> ## Non-blocking findings
> - §15 的 Session 修改说明、§19 的行数估算尚未体现新增的贴底逻辑迁移；§20 仍保留“现有帧末贴底容差”的旧描述。这些属于记录更新，不影响 §10、§12 已明确的实施路径。实际交付仍须计算四个生产相关文件及 400 行增删总量。
> - 临时实验结果仍只作为研究依据。R2 已要求提交后的原生测试与真实 Session 测试独立验证，不得把临时实验报告直接当作实现通过证据。
> ## Release verdict
> **APPROVE — 仅适用于 `docs/plans/tui-scroll-layout-stability.md` 的 R2。**
> 记录本轮完整范围批准后，可将 `Approved revision` 设为 `R2` 并允许实施。任何实质设计变更仍需递增修订并重新审计；本结论不代表实现已验证或允许跳过独立实现审计。

### Actual Files and Diff

Production-related tracked files: package.json +1; bun.lock +2/-1; Session index.tsx +3/-46; new dependency patch 74 lines (including diff envelope). Four files; gross 127 lines, below 400. Patch modifies installed index.js and ScrollBox.d.ts at owner; no Slider, renderer bundle, thirdparty source or unrelated changes.

Tests: new scroll-layout.test.ts; session-message-render.test.tsx +74/-1. The changed existing resize wait predicate now also waits for actual public content-release completion; all original final geometry/release assertions remain. Early per-frame preservation makes the old offset predicate true before measurement completion.

### Red-Green Test Evidence

- `bun test test/cli/tui/scroll-layout.test.ts --timeout 30000`: original native first painted frame expected MESSAGE 20, received empty; 0 pass/1 fail. Applied owner patch: 1 pass/0 fail.
- `bun test test/cli/cmd/tui/session-message-render.test.tsx --test-name-pattern 'session keeps every resize frame' --timeout 60000`: before Session enable/removal, both cases failed, offsets 120 and 18 rather than zero. After integration: 2 pass/0 fail, 205 assertions.
- Native additional reachable slices: wheel, line input, real wrapping resize, same-total redistribution, margins/padding, bottom tolerance, explicit navigation, empty content, default-off behavior and real scheduler idle: 9 pass/0 fail before benchmark addition.
- Actual Part event with preceding growth preserves selected copied text through all sampled frames. Both resident and shelled real Session resize paths keep per-frame offset while accepting a line-down command.

### Verification Commands and Results

All commands from packages/opencode unless noted; Windows Bun 1.3.14.

| Command | Result |
| --- | --- |
| bun test test/cli/tui/scroll-layout.test.ts test/cli/cmd/tui/session-message-render.test.tsx --timeout 60000 | 114 pass, 0 fail; 948 assertions; 46.68s |
| Full TUI partition command from section 18 | 77 files, 731 pass, 13 skip, 0 fail; 2725 assertions; 462.79s |
| bun typecheck | pass after final tests |
| bun install --ignore-scripts (root, explicitly authorized by user) | pass; URL-based override requires resolved tarball identity as patch key |
| bun install --frozen-lockfile --ignore-scripts (root) | pass; no further lock diff |
| git diff --check (root) | pass |

First attempted semver patch key was ignored because actual dependency identity is a tarball URL; no test success was claimed. Corrected key to existing resolved URL, fixed patch hunk count, regenerated lock using Bun. These are delivery corrections within approved patch path, not a dependency or architecture change.

Performance command run alone: `$env:SCROLL_BENCH='1'; bun test test/cli/tui/scroll-layout.test.ts --test-name-pattern benchmark --timeout 30000`. Three pairs of baseline/enabled p95 ms: 1.2598/1.0340, 1.3221/1.1465, 1.0603/0.8709. Median-of-three p95: 1.2598/1.0340; threshold not exceeded. This is native 300-root workload evidence, not a universal UI latency guarantee.

### Original Feedback-Loop Result

The committed native tests replace the temporary subclass with the actual patched dependency. Growth/shrink and real wrapping resize have zero per-frame error; input displacement and idle-frame stability pass. Real Session tests additionally cover the original shelled/resident reflow path and the pre-layout tolerance conflict. Temporary Slider experiment is not part of delivery or verification claims.

### Actual Secondary and Replacement Path Inventory

One primary layout path; preservation opt-out is existing-consumer pass-through; bottom/history and empty lists are normal input branches. No diagnostics, retries or alternate success paths. Session delayed restore and post-layout automatic following removed. Native Slider unchanged per explicit user acceptance.

### Chinese Comment Calculation

E=236 added nonblank non-comment code lines across production patch, package registration and both tests; exclude imports, generated bun.lock, deleted code, patch context/envelope. C=41 nearby Chinese explanatory comment lines; minimum ceil(236*0.15)=36; ratio 17.37%. Counts obtained from git added lines plus new test and patch-added code. Comments cover geometry/culling order, input preservation, tolerance, same-total redistribution, scheduler idle, resource readiness, independent frame/copy oracles and benchmark sampling.

### Remaining Unverified Items

No remote CI run or push requested for this task. Current Windows full affected TUI partition passes; Linux/macOS not executed locally. No claim of semantic character-position stability inside rewrapping paragraphs or zero latency for arbitrary Markdown parsing workloads. Slider drag range changes remain explicitly accepted. No production files outside the four listed files were changed by this task.

## 24. Implementation Audit Record

Round 1, approved R2, full original scope, invocation `ses_f5a181bc9ffeZ86lnoNiXyqDbM`. Initial invocation requested verification authorization without a verdict; continuation completed independent verification. Verbatim classifications and verdict:

> ## Blocking findings
> No blocking findings.
> ## Non-blocking findings
> - 完整 TUI 分区首次执行达到 **600 秒上限**，未产生最终汇总；该次不计为通过。独立重跑在 **558.36 秒**完成，结果为 **731 pass、13 skip、0 fail**。验证耗时接近上限，应保留两次记录，目前没有证据将首次超时归因于本次修改。
> - 本轮未重新执行依赖安装，遵守“不安装”的限制。已直接核对 patch 注册、lock 条目和实际安装的 ScrollBox 实现，并通过真实测试确认执行了补偿路径；干净环境安装的可复现性仍依赖已有安装记录，本轮未独立复现。
> **本轮独立验证：**
> - 两个相关测试文件：**114 pass、0 fail，948 个断言，47.66 秒**。
> - `bun typecheck`：通过。
> - 完整 TUI 分区重跑：**731 pass、13 skip、0 fail，2725 个断言，77 个文件**。
> - 300-root 性能比较：三次 p95 的中位数为基线 **1.4376 ms**、启用补偿 **1.4341 ms**，未触发计划的调查阈值。
> - `git diff --check`：通过。
> ## Primary-path and fallback verdict
> 通过。
> `ScrollBox.updateLayout` 是几何保持与布局前贴底判断的唯一新增语义路径。Session 仅启用该行为、调度驻留并发布当前位置状态。
> 原有延迟位置恢复和帧末自动贴底已删除。默认关闭、底部与历史位置分支、空内容 clamp 均属于明确契约；未发现失败后替代成功路径、新增重试或诊断路径。
> ## Release verdict
> **APPROVE — 仅适用于批准计划 R2 及本轮审查的实际实现 diff。**
> 首次验证超时和未独立重跑安装的限制应如实保留。此次批准不涵盖后续实质修改。本轮未编辑文件、安装依赖或创建提交。

Independent comment recount: patch E28/C5, Session production E2/C1, package E1/C0, native tests E144/C24, Session tests E61/C11, total E236/C41=17.37%, satisfying this repository's 15% requirement. Production-related diff independently confirmed as four files, 127 gross lines.
