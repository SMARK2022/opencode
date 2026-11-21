# Canonical Implementation Plan: HttpApi auth completion

> Status: verified
>
> Revision: R10
>
> Approved revision: R10
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL and its scope clarification, 2026-11-21
>
> Implementation allowed: no further material changes without revision or rework

Fixed pre-R1 HEAD: `0b5754df48177fccb05259e705a189df2f50ca2d`. Sole specification; target `verified-implementation-and-commit` (local, hooks enabled).

## R10: CLI runtime shutdown

> 所以我希望你将这一个新的问题也一并纳入当前的完整的一个修改的plan中，去参与修正。然后最终呢，以三个这个组合或者说独立这种commit去进行这个提交push。请注意这一点。当然，如果像是这种不影响生产的，比如SDK啊等等那些东西，我不建议你修改。
> 拆分和合并Commit本身不需要去进行审计，因为这本身和代码的实现没有任何关系。

> 修改内容对整体主逻辑性能的降级，还有相应逻辑结构的破坏，能多小就多小。代码的修改量也是。

R9 plan audit: **BLOCK — `docs/plans/httpapi-auth-completion.md` R9。** B-01: `TuiConfig.pluginOrigins` in the existing TUI plugin installation test uses the Core runtime adapter and its timer survives the package-local candidate (1 passing business case, 1 failed teardown). R10 routes this single import in `src/config/tui.ts` to the same package-owned runtime. That file plus the three ownership files below are the entire extension; Core, SDK and Gate remain unchanged. B-02: the earlier five suites did not test failed acquisition. In a one-shot real bootstrap rejection with an abort-aware event feed, the exact original error reached the caller and the 1000 ms timer went 1 → 0 before host teardown, on both baseline and candidate. No permanent assertion or retry for this compatibility check. The candidate closes its own child scope on rejection, removing its parent registration. All six original suites including `test/cli/tui/plugin-install.test.ts` passed (54/54, 129 expectations). Only first acquisition and shutdown register/release resources; no new work in the stream event loop. Historical R9 Follow-up: this proves the explicit AppRuntime shutdown entry, not the CLI's separate final `process.exit` policy.

Keep the Auth and two HTTP cleanup fixes specified below. The release base is now `8aead09f29`; Git history grouping supersedes R8's commit-ID constraint. Normal preflight on `bbccb56a64` (run `44888494330`, Linux) failed after 5447 passing tests with one referenced 1000 ms timer. `run-service.ts`, the transport and the logger/guard were unchanged between base and HEAD. In `packages/opencode`, `bun test --preload ../../script/guard/leak-preload.ts test/cli/run/stream.transport.test.ts -t 'does not replay persisted main-session history'`: one business test passed, teardown failed with the same timer. The boot/variant files alone had 12 passes and the same teardown failure. Previous batch-window fingerprint (1000 → 1234) identified the real Observability file logger; do not change logging or the leak rule.

Runtime invariant: every initialized package-local service runtime must release its real layers at host shutdown; the short-lived transport must release its own runtime at close or failed acquisition without interrupting a caller's admitted turn. `src/effect/run-service.ts` creates a lazy ManagedRuntime with shared memo map/Observability, but registers no finalizer with its host; `src/effect/app-runtime.ts` currently only disposes its own runtime. Reuse the existing `lazy` helper; on first use fork a child from one package-local scope, register the ManagedRuntime disposal on it, expose context and child close. Close the common scope at terminal `AppRuntime.dispose()` after disposing the app, including on failure. `src/cli/cmd/run/stream.transport.ts` acquires this context once and runs caller-owned methods with their per-call instance/workspace attachment; the existing layer finalizer aborts and closes the subscription. Remove the redundant close wrapper. Together with the TuiConfig import above there are four production files for this extension; no change to Core, SDK, guard, timer duration, CI or test files. No alternate successful path. Historical R8 sections below document that release; the current extension supersedes its exclusion of this package-local teardown.

Feedback and verification: external in-memory candidate in the three files, same five real transport/boot/variant/run-service/app-logger suites with original leak preload: 53 pass, 0 fail, 125 assertions. Single transport timer observed **1 → 0 before host teardown**. Baseline was 1 → 1. Re-run untouched existing suites, including graceful active turn, and the separate failed-acquisition probe, package typecheck, full Auth with isolated temp cwd, root Gate with all outgoing paths, then preflight for actual SHA/base. Remaining risk is another holder in full-suite composition; require actual green before fast-forward push. Verification after remote confirmation: restore original `cdd8c6d480` with index, verify original file layers and retain the backups. No extra audit for commit regrouping.

R10 implementation audit (`ses_e032fd1f1ffeHV7p62OmGvVkPX`, full scope): **BLOCK — `docs/plans/httpapi-auth-completion.md` R10，相对 `8aead09f29` 的当前实现差异。** B-01 was reclassified on reconsideration: the unchanged Core-backed Installation updater is a baseline Follow-up, outside the package-owned factory; its daemon test disables automatic updates. No blocking findings. Non-blocking: 无新增项。 **APPROVE — `docs/plans/httpapi-auth-completion.md` R10，相对 `8aead09f29` 的 13 路径实现差异通过独立审计。**

R10 implementation validation (package cwd `packages/opencode`): actual six unchanged suites with `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts`: 54 pass / 0 fail, 129 expectations. One-shot sampling on actual production sources: timer 1 → 0 at successful transport close; on rejected bootstrap, same error object, timer 1 → 0 before host teardown. Package `bun typecheck` exit 0. Full uninstrumented Auth in isolated temp Git cwd: `summary pass=225 fail=0 skip=0 missing=0 extra=0`, exit 0. Root `gate.ts stop --files <13 paths from git diff --name-only 8aead09f29>`: rules and selection passed, opencode full suite delegated to preflight; four informational guards on unchanged lines. `git diff --check 8aead09f29` clean. No new test files or production fallback.

R10 plan audit (`ses_e033f050fffejMH3vkVwitjXUr`): No blocking findings. **APPROVE — `docs/plans/httpapi-auth-completion.md` R10，全范围计划复审通过。** Failed startup is covered by the separate probe, not by the six unmodified suites. Follow-up: exact SHA/base preflight.

## R8 release scope (historical)

> 之前的Inspect Only的内容撤销，也就是你可以进行编辑。要求的是最终相关的修复被准确的Push上去。
> 不得为基线中不存在、仅由中间方案引入的问题保留断言。

R8 delta: the previous SDK configuration R7 is parked. Release plan reconsideration: **BLOCK — `docs/plans/httpapi-auth-completion.md` 当前 R7。** The narrower scope has its own revision. Release agreement:「保留已有 3 个提交」；用户选择「执行本地整理（推荐）」。 Verify `git log --reverse --oneline 27f5f6259b..<outgoing>` starts with `46af897f70`, `65ccec163f`, `5a47f9d067` in order and each is an ancestor of the confirmed remote SHA. Do not squash or rewrite these commits.

Keep the original Auth route, shutdown design and fixed baseline below. Publish on `origin/dev1-smark` from base `27f5f6259b` with normal hooks. Keep both test-owned resource releases: `packages/opencode/test/preload.ts` disposes the shared default HTTP handler before the application runtime; `packages/opencode/test/server/httpapi-question-session.test.ts` finalizes each locally created handler. Linux preflight before/after each release reported 11, 3, then 1 residual timer. These are distinct owners; neither changes authentication or guard policy.

Replace the reload timing assertion and its cleanup barrier with a shared pending-bootstrap fixture in the existing `test/project/instance.test.ts`. The same two tests failed with the original store and passed with the repaired store; only the interrupted waiter and web shutdown outcome are asserted. Predecessor retirement ordering stays as implemented; the one-off baseline/candidate check below covers it. No new test file. R4 plan blocked, R5 plan approved / implementation blocked for empty-host directory creation, R6 plan approved / implementation blocked for the SDK fixture's ordinary Gate failure. Those wider Core, SDK and transport changes were parked at the user's direction (`bcc96ef52a`); none are part of R8. The obsolete 50 ms check was specific to an intermediate design. Only Auth and the two demonstrated HTTP owners are in the initial outgoing patch. Verify package-local instance/HTTP tests with the unchanged leak preload, opencode typecheck, full Auth natural exit, local stop gate, and exact SHA/base preflight. A residual timer in historical full runs is a release risk, not permission to skip checks or to publish the parked patch. If reproduced for this SHA, identify the actual owner before any further material change. After remote confirmation apply original stash `cdd8c6d480` with `--index`, keep both backups and verify the original staged, unstaged and untracked content.

## 1. Verbatim requirement

R8 full-scope implementation audit, `ses_e032fd1f1ffeHV7p62OmGvVkPX`: initial **BLOCK — `docs/plans/httpapi-auth-completion.md` R8，相对 `27f5f6259b` 的当前出站差异。** B-01 required local GATE over all nine outgoing paths. `bun script/guard/gate.ts stop --files <all git diff --name-only 27f5f6259b paths, comma-separated>` checked all nine, selected full opencode for preflight, exit 0. Final verdict: No blocking findings. Non-blocking: 无。 **APPROVE — `docs/plans/httpapi-auth-completion.md` R8，相对 `27f5f6259b` 的九路径实现差异通过独立审计。** Hosted release and workspace restoration are separate from this implementation approval.

R8 plan audit: No blocking findings. **APPROVE — `docs/plans/httpapi-auth-completion.md` R8，全范围计划复审通过。** R7 blocking findings resolved: B-01 duplicate revision; B-02 missing history acceptance. Follow-up: verify the exact outgoing SHA/base, including any residual timer.

R8 implementation evidence: exact retained tests against the pre-R1 store: 0 pass / 2 fail; repaired store: 2 pass / 0 fail. Against the narrowed release tree in `packages/opencode`, `bun test --preload ../../script/guard/leak-preload.ts ./test/project/instance.test.ts ./test/server/httpapi-question-session.test.ts`: 17 pass, 0 fail, 47 assertions. `bun typecheck`: exit 0. Root `bun script/guard/gate.ts stop --files packages/opencode/test/project/instance.test.ts`: 13 pass, exit 0. Uninstrumented `bun --no-install <absolute script/httpapi-exercise.ts> --mode auth --fail-on-missing --fail-on-skip` from a fresh temporary Git project: `summary pass=225 fail=0 skip=0 missing=0 extra=0`, natural exit 0. `git diff --check origin/dev1-smark` passed. Outgoing code is confined to the instance store, its existing test, the four Auth exercise files and the two HTTP test owners. Exact-commit hosted preflight and remote/stash checks follow the commit.

> 现在我想了一下，下面需要你进行一个操作。你把我们就是本地这个暂存区域非暂存区的所有内容去Stash一下。在你stash完之后，你需要做一件事情，就是解决我们之前所说的这个CI对于Auth的那个问题。

> 所以到底是什么情况呢？就是按照我的理解，从我的视角来看，当前线上它就是只是卡在那个Auth卡在那个对应的地方不退出。在我的视角里面，它是没有任何问题，只是没有退出。我不知道实际是如何的，如果实际是有问题的，那这个问题你看，我认为也需要被调整修复。因为我最终期望的是我们的线上CI能够正常的准确的去完成任务，就是不会再去报错呀，巴拉巴拉这种情况。但是我主要指的报错，就是说我们上一次发现这个Auth相关问题，其他东西不参与相应的修改。保持修改代码最小、精简。同时如果生产有问题就精准改生产，且改根源处，避免去在下游一直改改改打补丁，或者只是调整一些超时时间设置。也就是说我希望我们东西在本地验证是通过的，然后预期是在线上验证也是通过的，当然只是预期，你做到最大的可能性线上能够绿测就OK了，不需要直接找一个Mac验收。

## 2–4. Non-goals, repository context and evidence

> 注意，我已经说的很清晰了，你不要去做过多的冗余的重复性的，或者说防御性的各种修改。保持最小修改，按照我的理解，你可能修改个修改个几十行就完了，你不要去创建新的测试文件，创建新文件有什么用啊？不要创建新测试文件。你的修改要满足GATE。你可以先跑一下GATE.ts

No change to credential validation, route declarations/business status, process exit policy, CI settings, dependencies, live data, or unrelated macOS `AppProcess` test. Preserve effect/coverage modes. No push. `git stash push --include-untracked` saved index/worktree/untracked files at `cdd8c6d4800e1af23159d80c5ea00be800e0ca2c`; index tree `dcc55b3910`, 3 staged files, 9 untracked, clean working directory afterwards. Leave stash intact.

|Source|Constraint / finding|Class|
|---|---|---|
|Root/package/test/server AGENTS, CONTEXT.md (Embedded OpenCode, HttpApi), docs/adr (only triage), engineering policy + plan template|Package-local tests/typecheck; real in-process HTTP stack, scoped Effect resources; no API regeneration|contracted|
|`.github/workflows/test.yml`, `script/httpapi-exercise.ts`, exercise `index.ts`, `report.ts`, `backend.ts`, `environment.ts` (package-relative)|Job awaits CLI; summary precedes scoped web disposal, temporary path cleanup, then exit. Production path does not need a watchdog.|reachable|
|Run `44762385332` job `136377993629`|Summary in 13 s; 30 min limit; runner killed its original Bun PID|observed|
|`src/project/{instance-store,bootstrap}.ts`, `src/worktree/index.ts`, `src/server/routes/instance/httpapi/{server,lifecycle}.ts`, exercise `runtime.ts`|HTTP app provides real store; worktree creation can return before instance startup ends. Load and reload schedule producers in owning scope; shutdown is a normal store operation.|reachable|
|Pinned Effect `internal/effect.ts` (`forkIn`, `onExit`), `Deferred.ts`; `test/project/instance.test.ts`|LIFO in sequential scope can interrupt producer first; exit finalization is protected. Existing explicit disposeAll test exercises different order.|reachable|
|Exercise `runner.ts`, `backend.ts`, `types.ts`, `dsl.ts`, `routing.ts`, `src/server/shared/tui-control.ts`, HttpApi TUI and authorization handlers|Auth needs status, not body; real consumer waits for a queue item; effect mode already queues one in its scenario seed. Scenario watchdog and request signal already exist.|reachable|
|Isolated real CLI and causal contrasts below|Both premature PASS and post-summary stall, not just source inference|observed|

## 5–9. Behavior, domain, invariants, first divergence and ownership

|Invariant|Producer → consumer / supported condition|First divergence and owner|Verification|
|---|---|---|---|
|I1 Every registered startup publishes its actual exit to waiters; owner close terminates even during startup.|App request/background work → store load or reload (including previous-generation cleanup) → scoped fiber → entry → load/reload/disposeAll waiters|`completeLoad` captures bootstrap exit and *then* publishes it in interruptible continuation; reload also has work before that call. Owner interruption can terminate the only publisher. LIFO `disposeAll` awaits the uncompleted entry; `web.dispose()` and CLI exit cannot finish.|Real store/web close loop; package regression for both entry producers, waiting public client outside the closing scope. Existing cache/reload/explicit-dispose regressions.|
|I2 Auth verdict requires a real HTTP response: protected without credentials = 401; accepted/public = non-401. No response cannot pass.|Runner → `callAuthProbe` → production route; authorized long poll/slow startup → race expiration → pseudo-result `status:0` → runScenario PASS|Probe manufactures a result without a Response; positive branch only excludes 401. `capture()` needlessly waits on body, including streams. This is test orchestration, not production authorization.|Real auth runner, deliberately unseeded long poll; complete CLI; neighboring route-auth tests.|
|I3 Normal selected routes complete with the existing deadline and shutdown; missing credentials must still be rejected.|`tui.control.next` has no data in auth mode because it does not invoke effect-mode seeds. Startup may legitimately take >1 s.|Prepare the existing queue as an auth-suite fixture before the selected consumer. Business handler must continue waiting when no input exists.|Selected positive long poll and full gate, real status only.|

## 10–12. Primary design, path inventory and deletion

1. Move completion of **the whole registered producer** to a shared Effect exit finalizer installed before forking for load and reload. Both yield the real instance from the existing bootstrap vs explicit-cancel race. On failure evict only the matching generation, then publish the original Exit on both success and failure. Preserve existing previous-generation disposal, ordering, shared initialization and explicit cancellation. Do not wait uninterruptibly for bootstrap. Remove old post-bootstrap publication. No pre-drain in HTTP, retries or alternate success.
   When reload has *started* destruction of its predecessor, mask interruption only across the existing disposer barrier, cache invalidation and disposed event. Preserve the old event payload and sequencing; waiting for the predecessor and booting the successor remain interruptible. The retained close tests cover a pending bootstrap for each public producer. The separate predecessor-cleanup ordering experiment is recorded below; keep its timing barrier out of the permanent tests.
2. Auth probe awaits the actual handler Response with Effect's signal on the Request, releases its body (also for streams), returns only the HTTP status. Delete local one-second race, fake zero status and now-unused `timedOut` field. `runScenario` retains its existing scenario deadline/error-to-failed-result contract. Body/stream assertions in effect mode remain owned by `capture`. Preserve 4xx business responses except 401 as evidence only of passing the auth gate; no claim the business operation succeeded.
3. Provide one queued TUI request in auth-suite setup when that consumer is selected, using the existing runtime TUI fixture interface. No synthetic HTTP reply, second implementation of authorization, blanket seeding of business scenarios, or credential-specific production changes. No new alternate or diagnostic success branches (0%).

## 13–17. Mappings, files, TDD, comments and budget

|Order / requirement|File relative to `packages/opencode`|Change and baseline-sensitive behavior|
|---|---|---|
|I1|`test/project/instance.test.ts`, `src/project/instance-store.ts`|Red first: with mock project/bootstrap services and real store, gate pending startup using Deferred; close owner before releasing it, require load/reload waiter to receive interrupt and close to finish. Bound observation without trapping test teardown inside the broken scope. Green: one exit publication for both complete producers. Existing cancel signal isn't sufficient when the scope itself interrupts.|
|I2|exercise `backend.ts`, `runner.ts`, `types.ts`|One-shot behavioral check, no new test file: in a fresh temporary project call `runScenario` on `/path` to warm the real auth app, then on `/tui/control/next` without a queued request with `--scenario-timeout '2 seconds'`. Require `fail` with scenario timeout (baseline returned `pass`). Run the full CLI separately for the positive case.|
|I3|`test/server/httpapi-exercise/index.ts`|Auth-specific, selected long-poll queue input; do not modify shared handler or effect-mode seed. Only fixture the request that otherwise waits by contract.|
|Stash / release|Git, this document|Verify old stash identity, local commit with unskipped hooks after full audits.|

Reverse: exit finalizer → I1 (ordinary continuation can be cancelled); status-only probe with caller cancellation → I2 (body capture/zero sentinel cannot establish auth); queue item → I3 (auth suite does not run effect seeds). One production file, 4 existing harness files, one existing regression file, 1 required plan. No new test files or generated changes. Comment only non-obvious shutdown notification or long-poll fixture intent, in Chinese.

## 18–20. Experiments, verification, risks and follow-up

Run all Bun commands from `packages/opencode`. Windows, Bun 1.4.4. External scripts are session-only diagnostics in `D:/Temp/opencode`, not product dependencies. `auth-ci-r1-probe.ts` invokes the original package entry in a fresh throwaway cwd/HOME/XDG/DB. `PROBE_REPO=1` creates a tiny Git fixture containing the repository's config, guard plugin and its rules, not a clone. It observes the original summary and gives a nonzero exit if Bun still hasn't exited 4.5 s later. `--fail-on-missing --fail-on-skip` remains enabled.

|Command / condition|Observed / acceptance|
|---|---|
|`bun --no-install D:/Temp/opencode/auth-ci-r1-close.ts load` and `reload`|Separate real web disposal and store waiter remain pending at 655/654 ms; red exit 1. With `CAND=1` in-memory exit publication both finish in 3 ms with failed waiter.|
|`PROBE_TRACE=1 PROBE_REPO=1 bun --no-install D:/Temp/opencode/auth-ci-r1-probe.ts --mode auth --fail-on-missing --fail-on-skip` (process env)|225 PASS including **23** timed-out valid requests, then post-summary watchdog exit 99. Without repository plugin fixture, 8 false passes, exit 0.|
|Same plugin fixture, `PROBE_REAL=1` instead of trace|Only real statuses, TUI queue supplied. First instance request 200 after 15.9 s; all 225 verdicts printed, still exit 99.|
|`CAND=1 PROBE_REPO=1 PROBE_REAL=1 PROBE_FULL=1 bun --no-install D:/Temp/opencode/auth-ci-r1-close.ts --mode auth --fail-on-missing --fail-on-skip`|Combined in-memory changes yielded 225/0, missing/extra/skip=0, natural successful CLI exit. Test fixture used before valid TUI request; committed fixture will be placed at selection/setup seam.|
|After edit: `bun test test/project/instance.test.ts test/server/httpapi-instance-route-auth.test.ts test/server/httpapi-authorization.test.ts`, `bun typecheck`, root `bun script/guard/gate.ts stop --files <changed paths joined with commas>`|Narrow red → green, then neighboring contracts/typecheck and repository gate.|
|After edit: `PROBE_REPO=1 bun --no-install D:/Temp/opencode/auth-ci-r1-probe.ts --mode auth --fail-on-missing --fail-on-skip`, no instrumentation/candidate transforms; repeat. Also coverage/effect via isolated launcher with normal script args and adequate outer job budget.|Unmodified committed sources, real gate, process exit 0; no workspace mutations by test business routes.|

No verifier depends on old cloud logs being immediately available. Local fixture/Windows cannot certify the subsequent GitHub Linux Job; no Mac requirement. Follow-up: macOS ready-file race is a separate test expressly out of scope. No open product decisions. Reject host timing or GitHub UI changes as solutions to a stranded entry.

## 21–22. Audit contract and revisions

Full original scope and fixed baseline each round per engineering policy. No design changes while recording approval.

R1, round 1, full scope, `ses_e05fca06bffeGfJGd7UuulIhmv`. Blocking: **B-01 `reload` 可能在旧实例清理完成前报告关闭成功**. Non-blocking: 无。 Follow-up: 无。 Release verdict: **BLOCK — `docs/plans/httpapi-auth-completion.md` R1。** 修订 B-01 的关闭时序和验收用例后，再做全范围计划复审。

Revision delta R2: design, I1 verification and reload slice now preserve already-started predecessor cleanup as part of I1; no additional files, public interfaces, or independent invariants. `auth-ci-r1-close.ts cleanup` registers a real async disposer in an already-loaded store. Baseline withheld early exit but never finished after release (687 ms, exit 1); R1 candidate closed early (3 ms); R2 candidate waited for the barrier and finished after release (35 ms, exit 0). The narrow mask only protects this actual ownership transition.

## 23–24. Implementation evidence and audit

Plan R2, round 2, full scope, `ses_e05fca06bffeGfJGd7UuulIhmv`: **No blocking findings.** Non-blocking: **N-01：临时探针的退出码不能单独证明关闭顺序。** Follow-up: 无。 **APPROVE — `docs/plans/httpapi-auth-completion.md` R2，全范围计划复审通过。** 记录本次批准后可按 R2 实施；`verified-implementation-and-commit` 仍须以实际回归测试、完整 Auth CLI 正常退出、实现审计和本地提交为准。

Revision delta R3: user explicitly excludes new test files and requires GATE. Keep the R2 root repairs and existing-file shutdown regression. Unseeded real runner check executed red (`pass` instead of timeout) and green (1 passed); retain the evidence, not a new test file. No other test code moved or added. Original production baseline, invariants and all other acceptance criteria unchanged.

R3, round 3, full scope, `ses_e05ec6e3fffe4dTPsbGt4Svyjc`: No blocking findings. **N-01（R2 已记录）：临时探针的退出码不能单独证明 `reload` 的关闭顺序。** Follow-up: 无新增项。 **APPROVE — `docs/plans/httpapi-auth-completion.md` R3，全范围计划复审通过。** 本轮批准的是计划。`verified-implementation-and-commit` 仍须以最终工作树的测试与 GATE 结果、完整 Auth CLI 打印摘要后以 0 退出、实现审计通过，以及启用 hooks 的本地提交为准。

### Implementation evidence (R3)

- Actual diff, excluding this plan: 6 existing files, +75/−44. Only production change is `instance-store.ts` (+17/−16): interrupt-safe final publication and ordered predecessor retirement. One existing `instance.test.ts` exercises both interrupted producers, checks close independently before releasing the reload barrier, then checks interrupted waiter and completed close. Four exercise files: `backend.ts` obtains the actual status and releases response bodies, `runner.ts` checks the status, `types.ts` drops the obsolete timeout flag, `index.ts` queues the selected long poll. No new test file; no CI, deadline, or auth-policy changes. No fallback or diagnostic production branch.
- Store regression `bun test test/project/instance.test.ts -t 'web disposal settles'`: both failed on the baseline (`host or waiter did not finish`); entire instance file passed after repair (13/13). Unseeded long poll red/green in R3 delta above. Selected positive CLI before fixture setup failed at scenario deadline (exit 1); after setup full Auth passes including the selected route.
- Complete Auth with repo/plugin fixture: 225 pass/0 fail/0 skip/0 missing/0 extra. Uninstrumented exit 0 at 5.337 s after summary; independent phase trace exit 0 at 5.772 s (web dispose and temporary directory cleanup completed). An earlier external 4.5 s observation interrupted the measurement: its cutoff alone is not a deadlock oracle. The synchronized store regression independently detects missing completion. No repo timeout changed. Coverage 225/0, exit 0; effect 225/0, exit 0, 874 s locally (an initial external 500 s budget was insufficient).
- Package `bun run test test/project/instance.test.ts test/server/httpapi-instance-route-auth.test.ts test/server/httpapi-authorization.test.ts`: 24 pass / 0 fail. Direct Bun's 5 s default twice expired in the neighboring PTY test; package.json already sets 30 s, no test timeout changed. Package `bun typecheck`, root `git diff --check`, and `bun script/guard/gate.ts stop --files <six source/test paths + this plan>` passed. Guard selected full package tests and deferred that step to push preflight by design. No push, hosted post-change result or Mac run. No newly introduced follow-ups.

Implementation audit round 1, full scope, R3, `ses_e05d0c9adffeX0ehSJZq9kLR4V`. Blocking: B-01 `reload` 回归用例可能在调用 `web.dispose()` 之前就超时; B-02 新增服务测试绕开了包内规定的 live runner; B-03 完整 Auth CLI 的第二次无插桩退出仍待核验. Non-blocking: 无。 Follow-up: 无。 **BLOCK — R3 当前实现差异暂不放行提交。** 修正现有测试的两个问题，补齐无插桩退出记录，再对最终差异做全范围复审。

Rework: existing test uses `testEffect(Layer.empty).live`, matches the canonical directory returned by the public store, bounds reaching the barrier with `awaitWithTimeout`, observes closing independently, and awaits the external waiter. Production diff unchanged. Last package run 24 pass/0 fail; typecheck and `gate.ts stop` passed again. Two uninstrumented authentic runs (`PROBE_REPO=1 PROBE_CLOSE_MS=80000 PROBE_BUDGET=180000`, no other `PROBE` flags, `bun --no-install D:/Temp/opencode/auth-ci-r1-probe.ts --mode auth --fail-on-missing --fail-on-skip`): both `summary pass=225 fail=0 skip=0 missing=0 extra=0`, then `summary-to-exit-ms 5337 0` and `11295 0`. Diagnostic instrumentation not counted as a repeat.

Implementation audit round 2, full scope, R3, `ses_e05d0c9adffeX0ehSJZq9kLR4V`: No blocking findings. Non-blocking: 无。 Follow-up: 无新增项。 **APPROVE — `docs/plans/httpapi-auth-completion.md` R3，当前实现差异通过全范围复审。** 可按计划保留 hooks 创建本地提交。当前 HEAD 仍为 `0b5754df48`；提交成功后才达到 `verified-implementation-and-commit`。
