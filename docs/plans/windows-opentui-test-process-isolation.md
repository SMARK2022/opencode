# Canonical Implementation Plan: Windows OpenTUI Test Process Isolation

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: implementation
>
> Requirement source: user messages in the current Session
>
> Implementation allowed: no; implementation verified
>
> Last updated: 2026-07-26

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> “当前我有检查到一些新的问题,这个是在我们GitHub上CI测试的新问题,请检查检查这些问题哪来的,然后按照我们的同样工作流进行新一轮的完整修正,请确保最终提交的内容不会有任何错误。”

> “优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。”

Current execution constraint:

> “opentui分支你自行实验，不要再问了，同时主仓库禁止提交”

The final constraint permits autonomous commits and pushes only on the temporary
`diag/opentui-windows-crash` branch. It forbids committing the implementation in
the main worktree unless the user later replaces that instruction.

## 2. Explicit Non-Goals

- Do not change any user-facing TUI, CLI, JSON, daemon, database, Session, Tool,
  or Permission behavior.
- Do not skip, disable, retry, quarantine, or weaken any test.
- Do not change OpenTUI, Bun, package versions, or lockfiles.
- Do not widen the implementation into failures that are not reproducible on
  the current `dev-smark` revision; every observed failure must still be
  classified and verified before it is excluded.
- Do not merge the temporary diagnostic workflow or its commits into
  `dev-smark`.
- Do not add a platform switch: the package test contract is one deterministic
  orchestration path on Linux, Windows, and macOS.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Tests and typechecks run from package directories; use Bun APIs where practical; keep changes minimal. |
| `packages/opencode/AGENTS.md` | Defines package module style and the ownership of process-wide and per-Project runtime resources. |
| `packages/opencode/test/AGENTS.md` | Requires behavioral tests, scoped cleanup, and published synchronization rather than timing guesses. |
| `CONTEXT.md` | Establishes `packages/opencode` as the core package and distinguishes process-wide AppRuntime/native boundaries from per-Project state. |
| `docs/adr/README.md` | No accepted ADR governs unit-test process sharding; this bounded orchestration change does not create an ADR. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, no fallback, full traceability, TDD, independent audits, and the Chinese-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this plan's required structure and approval metadata. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/package.json:8-17` | `test:ci` currently launches all package tests in one Bun process and writes one JUnit file. | observed |
| `turbo.json:16-23` | Turbo currently caches only `.artifacts/unit/junit.xml` for `opencode#test:ci`. | observed |
| `.github/workflows/test.yml:30-164` | Required jobs invoke `test:ci`, check one report path, publish it, and preserve the command's failure. | observed |
| `.github/workflows/test.yml:330-395` | Upstream-warning jobs also consume the package JUnit output. | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts` | The full-suite crash occurs after this group on failing jobs; it does not import an OpenTUI renderer directly. | observed |
| `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | Exercises a real OpenTUI renderer and was the last visible test group in the original user log. | observed |
| `packages/opencode/test/cli/tui/slot-replace.test.tsx` | One real renderer cleanup defect was found, but repairing it did not remove the native crash. | observed |
| `packages/opencode/test/cli/tui/use-event.test.tsx` | Explicit engine detach did not remove the native crash. | observed |
| `node_modules/@opentui/solid/index.js` | `testRender` creates and mounts a native-backed renderer and attaches the process-global timeline engine. | observed |
| `node_modules/@opentui/core/index.js` and bundled implementation | Renderer destruction crosses into `opentui.dll`; the timeline engine and TreeSitter client have process-lifetime state. | observed |
| GitHub run `30131430684` | Unmodified full suite reproduced the same native crash in 2 of 3 Windows jobs. | observed |
| GitHub runs `30133291043`, `30134941727`, `30136588180`, `30137948676` | Unthreaded render, slot cleanup, engine detach, and pre-created KV state did not eliminate the crash. | observed |
| GitHub run `30146552374` | OpenTUI `smark.1` still crashed in 2 of 3 jobs, rejecting `smark.2` as a sufficient cause. | observed |
| GitHub run `30149299984` | Bun `--max-concurrency=1` still crashed in 2 of 3 jobs, rejecting test concurrency as a sufficient cause. | observed |
| GitHub run `30166717141` | Removing only file-mutation tests still produced the same native crash; that file is not necessary for failure. | observed |
| GitHub run `30168396381` | The 70 CLI/TUI files ran in one dedicated process three times: each had 606 pass, 0 fail, 618 tests, and no native crash. | observed |
| GitHub run `30168972664` | All 297 files were partitioned exactly once into 227 core and 70 CLI/TUI files; 0 of 3 jobs had a native crash, every TUI shard passed, two jobs fully passed, and one core shard had one unrelated DB assertion failure. | observed |
| Local `Bun.Glob` probe | Current main worktree finds 298 test files; Windows returns `test\\...` paths, so path normalization is required before cross-platform classification. | observed |
| Main `dev-smark` commit `0581314208` and current `db-maintenance.test.ts:177-207` | The old diagnostic branch's DB assertion used `Promise.race`; current main waits for CLI exit, checks terminal ownership, then awaits contender acquisition. | observed |
| Main package run `bun test test/cli/db-maintenance.test.ts -t "holds the daemon election while initially offline compression runs" --rerun-each 20` | Current main passed `20 pass`, `0 fail`; the diagnostic DB failure is not present at the implementation base. | observed |
| Main package run `bun test test/cli/tui/daemon.test.ts -t "daemon startup resumes an interrupted maintenance task from its persisted record" --rerun-each 10` | Current main passed `10 pass`, `0 fail`; the daemon timeout is covered as regression verification, not an unresolved excluded error. | observed |
| `packages/opencode/test/script/install-target.test.ts` | Establishes the existing seam for importing and testing package scripts through exported pure functions. | observed |

## 5. Current Behavior

```text
GitHub required job
  -> turbo opencode#test:ci
  -> package test:ci
  -> one Bun test process discovers every test file
  -> core/runtime/process tests and native-backed CLI/TUI tests share one process lifetime
  -> Windows intermittently exits inside opentui.dll with code 3 before a complete JUnit result
```

The same native-backed CLI/TUI tests are stable when their 70 files own a fresh
Bun process. Running all files exactly once in two sequential processes also
removes the native crash. Ordinary test assertions remain visible and non-zero;
the two-process diagnostic did not turn failures into success. The diagnostic
branch's one DB assertion failure came from a pre-`0581314208` test body; current
main's targeted stress run is green.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `test/**/*.test.ts` and `test/**/*.test.tsx` paths | Package test tree through `Bun.Glob` | Files are tracked package test modules; path separators vary by OS. | `test:ci` -> test-file discovery -> shard classification | Package test orchestrator | observed |
| `test/cli/run/**`, `test/cli/tui/**`, `test/cli/cmd/tui/**` | Existing CLI/TUI test layout | These are the exact 70-file slice proven stable in a fresh process. | discovered path -> normalized path -> TUI shard | Package test orchestrator | observed |
| Every other discovered test file | Existing package test layout | Every non-TUI file must remain covered exactly once. | discovered path -> core shard | Package test orchestrator | observed |
| A shard exits non-zero | Bun child test process | Bun exposes the child exit code and writes any available shard JUnit. | child exit -> aggregate command exit | Package test orchestrator | contracted |
| Multiple JUnit files | Two mandatory shard processes | CI report and Turbo cache consumers currently expect one path. | shard output -> workflow publication/cache | CI adapter and Turbo task config | reachable |
| DB election or daemon recovery regression | Existing current-main tests and their real PTY/lock producers | Current main already owns the DB ordering repair and daemon reconciliation repair. | targeted package tests -> required full-suite verification | DB/daemon owners; no new change in this plan | observed |

Speculative rows are omitted; no unsupported input or compatibility behavior is
planned.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Required CI runs every discovered opencode test file exactly once; process isolation may not reduce coverage. | User requirement; diagnostic coverage `297 = 227 + 70`, all unique. | No current partition-contract test. |
| INV-02 | Native-backed CLI/TUI tests execute in a fresh Bun process that does not inherit the core shard's process-lifetime state. | Runs `30168396381` and `30168972664`. | GitHub diagnostic feedback loop only. |
| INV-03 | Both shards run even if one reports a test failure, and any non-zero shard makes `test:ci` non-zero. | Existing Bun full-suite behavior continues after assertion failures; user requires no hidden errors. | No current orchestrator test. |
| INV-04 | Every shard emits a separately publishable JUnit report, and CI/Turbo retain all reports. | Existing report publication/cache contract. | Existing workflow behavior only supports one report. |
| INV-05 | User-facing application behavior and dependency versions remain unchanged. | Explicit user requirement. | Existing application suite and zero production-file diff. |
| INV-06 | Current-main DB election and daemon recovery behaviors remain green; stale diagnostic-branch assertions are not reported as unresolved main errors. | Commit `0581314208`; current-main 20x DB and 10x daemon runs. | Existing targeted tests. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `packages/opencode`'s `test:ci` command chooses one Bun process for heterogeneous core tests and native-backed CLI/TUI tests, so the TUI phase does not begin with a fresh process lifetime. | Package test orchestration in `packages/opencode/package.json` and the planned `script/test-ci.ts`. | Full suite repeatedly crashes; focused TUI is 3/3 clean; exact full coverage in two processes is 0/3 native crashes. |
| INV-04 | The package and its CI/cache consumers encode one fixed `junit.xml` output. | Package script, `.github/workflows/test.yml`, `turbo.json`. | Two mandatory processes necessarily produce independent reports; diagnostic run successfully uploaded both. |
| INV-06 | The diagnostic run's DB failure is not a current-main first divergence: the branch predates `0581314208`, whose test contract is green on current main. | DB test owner and commit history. | Current main stress run: `20 pass, 0 fail`; no DB production/test edit is planned. |

The downstream `opentui.dll` segmentation fault is not treated as an application
logic defect. Repository evidence does not identify a safe source-level repair
inside the external native library. The repository-owned first divergence is
the test orchestrator's process-lifetime boundary: it combines a native-backed
test domain with unrelated process-wide test state even though the exact same
domain is stable in a fresh Bun process.

The daemon timeout is part of the same process-lifetime symptom family: failing
full-suite jobs either timed out in daemon recovery or completed the daemon group
and then crashed in native code, while the dedicated CLI/TUI process passed the
daemon group in all three two-process jobs. Current main also passes the exact
daemon recovery test 10 times.

The DB assertion observed in diagnostic run `30168972664` is not a current-main
failure. Its log expected `"finished"` from a `Promise.race`; current main waits
for the CLI exit before awaiting the contender and passes the same scenario 20
times. It is therefore verified pre-plan branch drift, not an additional
implementation concept for this plan.

Red-capable original feedback loop:

```text
gh workflow run opentui-windows-diagnostic.yml \
  --repo SMARK2022/opencode \
  --ref diag/opentui-windows-crash
```

The temporary workflow runs three GitHub-hosted Windows jobs and classifies
`panic(main thread)`, `Segmentation fault`, `opentui.dll`, and exit code 3.
Baseline run `30131430684` was red in 2/3 jobs. Candidate run `30168972664`
executed all files exactly once and observed 0/3 native crashes. This loop is
slow because the defect requires full process accumulation; local focused loops
are not substitutes for the original signal.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Discover and partition package tests | `packages/opencode/script/test-ci.ts` | `test:ci` covers every package test exactly once. | This is orchestration policy, not application behavior. | Individual tests must not know or compensate for global suite topology. |
| Normalize test path representation | Same script | Classification is OS-independent. | `Bun.Glob` is the first seam that exposes OS-specific separators. | CI YAML should not duplicate package test taxonomy. |
| Execute both mandatory shards and aggregate failure | Same script | Both domains run; any failure remains failure. | Retry/ordering/failure policy belongs to orchestration. | Turbo and GitHub should invoke one package contract, not reimplement it. |
| Publish/cache multiple reports | `.github/workflows/test.yml`, `turbo.json` | All JUnit outputs remain available to existing consumers. | These files own report consumption and cache declarations. | The test runner must not merge or falsify independent test results. |

Confirmed TDD seams:

- `partitionTestFiles(files)` is the pure package-script seam for cross-platform,
  exact-once classification.
- `bun run test:ci` is the end-to-end orchestration seam for real child processes,
  JUnit files, complete coverage, and aggregate exit behavior.

## 10. Single Approved Primary-Path Design

```text
Bun.Glob discovers all package test files
  -> normalize separators to repository-relative `/` paths
  -> partition every path exactly once into core or CLI/TUI
  -> clear stale unit XML reports
  -> run core shard in one Bun child process -> .artifacts/unit/junit-core.xml
  -> run CLI/TUI shard in a second fresh Bun child process -> .artifacts/unit/junit-tui.xml
  -> preserve both JUnit reports
  -> exit zero only when both mandatory shard exits are zero
```

The CLI/TUI classification is exactly the tested path set:
`test/cli/run/**`, `test/cli/tui/**`, and `test/cli/cmd/tui/**`. New tests under
those roots inherit the native-process boundary; all other discovered tests
remain in core. Both shards are mandatory, sequential, and independently
reported. A failure in the first shard does not suppress the second shard, but
the final command cannot succeed if either failed.

The three opencode matrix rows in `.github/workflows/test.yml` will consume
`packages/opencode/.artifacts/unit/*.xml`. The shared report-existence step will
use `compgen -G "${{ matrix.junit }}" > /dev/null`, which accepts both the
opencode glob and every other package's existing literal path. The upstream
warning report check, publication, and upload paths will use
`packages/**/.artifacts/unit/*.xml`. Turbo's `opencode#test:ci` output will be
`.artifacts/unit/*.xml`; unrelated package output contracts remain unchanged.

This repairs the repository-owned first divergence. It does not disable the
native path, retry after failure, change test expectations, or add an alternate
success route.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Core test shard | proposed | primary-contract branch | Only when its tests pass | 50% of two mandatory executions | add |
| CLI/TUI test shard | proposed | primary-contract branch | Only when its tests pass | 50% of two mandatory executions | add |
| Continue to TUI after core failure | proposed | primary-contract branch | No; aggregate remains non-zero | 0% alternate-success surface | add |
| Retry or skip after native failure | neither | forbidden fallback | Would attempt success | 0% | reject |
| Platform-specific one-process route | neither | forbidden duplicate | Could compete with primary route | 0% | reject |

New alternate success paths: zero. Diagnostic decision surface: zero in the
final implementation.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Temporary `.github/workflows/opentui-windows-diagnostic.yml` on `diag/opentui-windows-crash` | Reproduces and tests one variable at a time on GitHub-hosted Windows. | It is not part of the main branch and is not a production fallback. | Do not merge it; remote deletion requires separate authorization. |
| Temporary OpenTUI `smark.1`, test removal, unthreaded render, cleanup, and serial-run commits | Falsified individual hypotheses. | All were rejected as insufficient and are absent from the main worktree. | No main-branch deletion required. |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 exact-once coverage | Test discovery and partition | `script/test-ci.ts`; `test/script/test-ci.test.ts` | Pure mixed-path partition test plus shard count in real `test:ci` output. |
| INV-02 fresh TUI process | Sequential child-process orchestration | `script/test-ci.ts`; `package.json` | GitHub Windows full-coverage loop, three jobs. |
| INV-03 preserve failure | Run both and aggregate non-zero exits | `script/test-ci.ts` | End-to-end `test:ci`; existing ordinary DB failure remained non-zero while TUI still ran in run `30168972664`. |
| INV-04 retain reports | Two report names consumed as a glob | `script/test-ci.ts`; `.github/workflows/test.yml`; `turbo.json` | Verify two XML files and published reports/artifacts. |
| INV-05 no user behavior change | No application source path | No production files | Package suite, typecheck, and zero production diff. |
| INV-06 current-main DB/daemon correctness | Existing DB and daemon owners | No new source change; targeted verification only | 20x DB election and 10x daemon recovery tests on current main, then full package loop. |
| <=6 files, <=800 lines | Bounded implementation | Five implementation files plus this plan | Diff/stat inspection. |

No confirmed requirement remains unmapped.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| OS-neutral path normalization | INV-01, INV-02 | Windows `Bun.Glob` returns backslashes; Unix returns slashes. | Current inline command has no partition or normalization seam. |
| Two mandatory sequential child processes | INV-02, INV-03 | Runs `30168396381` and `30168972664`. | One Bun invocation cannot provide a fresh process lifetime between domains. |
| Separate core/TUI JUnit files | INV-04 | Each Bun process owns one reporter output. | Reusing one path would overwrite one shard's evidence. |
| Workflow glob consumption | INV-04 | Current checks/publish/upload use one literal path. | Existing literal cannot consume both reports. |
| Turbo output glob | INV-04 | Current cache declares one literal output. | Existing declaration would omit one report from cache artifacts. |

No dependency, setting, retry, compatibility path, or user-facing interface is
added.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `docs/plans/windows-opentui-test-process-isolation.md` | add | Canonical evidence, design, verification, and audit record. | documentation only |
| `packages/opencode/test/script/test-ci.test.ts` | add | TDD contract for Windows/Unix path normalization and exact-once core/TUI partition. | +20 to +30 |
| `packages/opencode/script/test-ci.ts` | add | Discover, normalize, partition, execute both shards, emit two reports, and aggregate exits. | +45 to +60 |
| `packages/opencode/package.json` | modify | Route `test:ci` through the package orchestration script. | 1 modified line |
| `.github/workflows/test.yml` | modify | Consume both opencode JUnit files in required and upstream-report paths. | 6 to 10 modified lines |
| `turbo.json` | modify | Cache every opencode unit XML report. | 1 modified line |

Total files including this plan: six. Planned executable/config/test delta is
well below 800 lines.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Mixed Windows (`\\`) and Unix (`/`) test paths do not produce the independently specified `{ core, tui }` partition. | `script/test-ci.ts` and `partitionTestFiles` do not exist. | Add normalization and one exact classification function. | Windows cannot silently place native-backed tests in core; no input is dropped or duplicated. |
| 2 | `bun run test:ci` cannot emit two complete reports while running both mandatory domains. | Current package command launches one Bun process and one report. | Add sequential child orchestration and two report names; retain non-zero aggregate exit. | Full coverage and failure visibility survive process isolation. |
| 3 | CI/cache consumers cannot find both report files. | Existing workflow and Turbo declarations name only `junit.xml`. | Change only the opencode report contract to `*.xml` and make report existence checks glob-aware. | Both shard results are published and cached on every OS. |
| 4 | Current-main DB election and daemon recovery regression checks must stay green while the test orchestrator changes. | These are confirmed behaviors and current-main tests already provide the seam. | Run the targeted 20x DB and 10x daemon checks before and after orchestration changes. | Prevents stale diagnostic-branch failures from being mistaken for an OpenTUI fix. |
| 5 | Original Windows loop can still reach the same native crash under the current one-process command. | Current process-lifetime boundary is the observed first divergence. | Run the exact two-process implementation in three GitHub-hosted Windows jobs. | Original `opentui.dll` exit-3 symptom remains the release gate. |

Expected values in slice 1 are literal path groups written independently of the
partition algorithm. No test asserts source text, helper calls, or internal
spawn counts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 70-100 | New executable/test lines plus substantive JSON/YAML lines; excludes imports, blanks, this plan, and formatting. |
| Required Chinese explanatory comments `C` | 11-15 minimum | Apply `ceil(E * 0.15)` to the actual implementation; use the upper bound until actual `E` is counted. |

Qualifying comments will be distributed next to:

- The native process-lifetime boundary and why CLI/TUI owns a fresh process.
- Windows separator normalization before path-domain classification.
- Exact-once default routing for all non-TUI test additions.
- The reason both shards run even after one fails.
- The invariant that aggregate success requires both zero exits.
- Why reports must use distinct paths rather than overwrite.
- Why stale XML files are removed before execution.
- The test's independent mixed-separator expected partition.
- Workflow wildcard existence checks and report publication.
- Turbo's multi-report cache boundary.

Actual `E` and `C` will be counted after implementation. Meaningless restatement
comments will not be counted.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/script/test-ci.test.ts` | `packages/opencode` | Red then green partition contract. |
| `bun test test/cli/db-maintenance.test.ts -t "holds the daemon election while initially offline compression runs" --rerun-each 20` | `packages/opencode` | Current-main DB election remains green. |
| `bun test test/cli/tui/daemon.test.ts -t "daemon startup resumes an interrupted maintenance task from its persisted record" --rerun-each 10` | `packages/opencode` | Current-main daemon recovery remains green. |
| `bun typecheck` | `packages/opencode` | Script and test type safety. |
| `bun run test:ci` | `packages/opencode` | Both real shards execute, all package tests remain covered, two JUnit files exist, and aggregate exit is correct. |
| `git diff --check` | repository root | Patch formatting. |
| `git diff --stat` and changed-path inspection | repository root | Six-file and 800-line budgets; no production source or lockfile changes. |
| Three-job `opentui-windows-diagnostic.yml` run rebased on current `dev-smark` with the exact implementation copied to `diag/opentui-windows-crash` | GitHub-hosted Windows | All three full-coverage jobs must succeed; native, DB, daemon, and any other non-zero failure blocks completion. |
| Required `packages/opencode` Linux/macOS jobs or equivalent package-local runs | GitHub-hosted runners | Cross-platform path normalization and report contract. |

No test command will be run from the repository root locally. The root-level
Turbo command remains a CI entrypoint only, matching repository instructions.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 3 | Canonical plan, orchestrator, partition test. |
| Files modified | 3 | Package command, CI report consumer, Turbo output declaration. |
| Files deleted | 0 | No main-branch workaround exists. |
| Production lines | 0 | No application source or user-facing behavior changes. |
| Test/orchestration/config lines | 70-100 effective; under 140 raw | One bounded package runner, one focused test, and small contract updates. |
| Generated lines | 0 | JUnit files are runtime artifacts and not committed. |

## 20. Real Risks and Open Decisions

### Real Risks

- Any ordinary test failure must remain non-zero while the other shard still
  runs; run `30168972664` proves preservation. A final run with any such failure
  is not acceptable completion evidence and must be investigated on the exact
  current implementation SHA.
- Two Bun startups add bounded runtime overhead. The diagnostic full run stayed
  within the existing 60-minute job timeout.
- OS-specific path separators can invalidate classification unless normalized
  at discovery; the local Windows probe proves this is reachable.
- Changing report cardinality without updating both CI and Turbo would lose
  evidence even if tests ran; both consumers are in scope.
- Diagnostic branch `30168972664` contains one DB failure because it predates
  `0581314208`; treating that stale branch result as a current-main failure
  would cause an unjustified owner expansion.

### Open Decisions Requiring the User

- None for implementation design.
- The latest instruction forbids a main-worktree commit. Verification and audit
  may proceed, but final commit/rebase/push remains prohibited unless the user
  later grants new authorization.
- Deleting the remote diagnostic branch is a destructive shared-state action
  and is outside this implementation plan.

### Rejected Speculation

- `dialog-prompt` thread mode, KV ENOENT, one slot renderer leak, timeline-engine
  detach, Bun test concurrency, OpenTUI `smark.2`, and the file-mutation test were
  each tested and rejected as sufficient or necessary causes.
- The exact invalid memory operation inside Bun/OpenTUI remains unknown. No
  source-level native patch is proposed without a native stack/core dump and an
  independently reproducible external-library seam.
- The DB election assertion from run `30168972664` is rejected as a current
  defect because the producer/test changed in `0581314208` and current main
  passes the same scenario 20 times.
- Test retry, crash retry, file quarantine, and platform-only skip were rejected
  because they create fallback success or reduce coverage.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 3 findings recorded below | BLOCK | `ses_065626d1effe19pq2C5R5kQark` |
| 2 | R2 | yes | none | 2 findings recorded below | APPROVE | `ses_06552ab38ffeHoQ1ZQbEQtN71O` |

Any substantive revision invalidates earlier approval.

### Round 1 Independent Verdict (verbatim)

> **Blocking findings**
>
> ### B-01 Known CI failures are explicitly excluded, so the plan cannot satisfy the no-error requirement
>
> - **Violated invariant:** The final corrected CI/test workflow must complete without unresolved errors while preserving real failures rather than hiding them.
> - **Evidence class:** contracted
> - **Producer and execution path:** Required CI job → `turbo test:ci` → `packages/opencode` `test:ci` → planned core and CLI/TUI child shards → aggregate exit code.
> - **Source evidence:** `packages/opencode/package.json:11` currently propagates the Bun test exit status; `.github/workflows/test.yml:114-146` treats that status as the required package-test result. The current plan itself records known database-maintenance and daemon-timeout failures at `docs/plans/windows-opentui-test-process-isolation.md:318-319`, and explicitly preserves ordinary failures as non-zero at `:145-150` and `:257-259`.
> - **Canonical-plan evidence:** Sections 2, 8, 16, and 20 explicitly declare the database-maintenance assertion and daemon timeout out of scope, while Section 18 treats a successful native-crash feedback loop with ordinary remaining failures as an acceptable result.
> - **Responsibility owner:** The plan's package test orchestration owns aggregate CI success, but the underlying database and daemon failures remain owned by their respective test/production paths and are not mapped to any corrective work.
> - **Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy:** The proposed implementation can produce a red required CI job after the OpenTUI crash is isolated because the known DB or daemon failures remain unresolved. Therefore the plan cannot establish the user's requested final error-free result; it only removes one native crash class while knowingly retaining other observed CI failures.
> - **Why this is not speculative:** The failures are directly acknowledged as observed CI problems in the canonical plan, and the planned aggregate behavior intentionally preserves any non-zero shard exit.
> - **Minimal correction direction:** Expand the canonical scope to include each confirmed failure that is part of the requested final CI result, assigning each to its owning path with behavior-sensitive tests; alternatively, the requirement must be explicitly narrowed by the user to the OpenTUI native-crash issue only before this plan can be approved. Do not hide, skip, retry, or convert those failures into success.
>
> **Non-blocking findings**
>
> 1. The plan does not state the exact report filenames or the precise workflow glob/check implementation. It identifies the correct consumers and responsibility owners, but the implementation contract would be clearer if it named the two report paths and the exact existence-check form.
> 2. The partition test is behaviorally appropriate, but the plan does not specify a direct failure-injection test proving that the second shard still runs after the first shard exits non-zero. The existing diagnostic run is evidence for that behavior, so this is a verification-strength issue rather than an independently proven defect.
> 3. The plan's effective-line estimate is internally loose: the stated per-file ranges can exceed the `70-85` effective-line estimate. This does not by itself exceed the user's 800-line limit, but the implementation must perform the required actual `E`/`C` calculation.
>
> **Rejected speculation**
>
> - The exact invalid-memory operation inside `opentui.dll` cannot be used as a blocking finding because the repository evidence establishes the process-lifetime boundary as the first repository-owned divergence, while the native defect itself lacks a reproducible repository-owned source seam.
> - A concern about malformed discovered paths is speculative beyond the documented `Bun.Glob` separator variation; the plan already identifies normalization at the discovery seam.
> - A concern that every shard must always emit a JUnit file even after a native process crash is not independently blocking here; a process that terminates inside native code may not be able to write a report, and the plan's release scenario is specifically the repaired, non-crashing path.
> - Additional platform-specific fallback behavior, retries, test quarantine, or concurrency controls are not justified and would conflict with the stated single-path design.
>
> **Requirement and traceability coverage**
>
> - **Process isolation:** Mapped to the package orchestrator and two sequential Bun child processes through `INV-02`.
> - **Exact-once test coverage:** Mapped to discovery, separator normalization, and partitioning through `INV-01`.
> - **Failure preservation:** Mapped to sequential execution and aggregate non-zero exit through `INV-03`.
> - **JUnit retention and CI/Turbo consumers:** Mapped to the package script, workflow, and Turbo configuration through `INV-04`.
> - **No user-facing behavior/dependency change:** Mapped to the absence of application-source and dependency changes through `INV-05`.
> - **File and line limits:** Mapped to five implementation/config/test files plus the plan, with the planned change remaining well below 800 lines.
> - **Unmapped confirmed requirement:** The user's final no-error requirement is not fully covered because the plan explicitly excludes observed DB-maintenance and daemon-timeout failures while retaining their non-zero outcomes.
>
> **Primary-path and fallback verdict**
>
> The proposed OpenTUI process-isolation route has one coherent primary path:
>
> 1. Discover package test files.
> 2. Normalize separators.
> 3. Partition each file exactly once.
> 4. Run the core shard.
> 5. Run the CLI/TUI shard in a fresh process.
> 6. Preserve both reports.
> 7. Aggregate both exit codes.
>
> No unauthorized alternate success path, retry, skip, platform-specific route, or error-to-success conversion is proposed. The process-isolation design therefore passes the primary-path and fallback review for the OpenTUI issue itself.
>
> It does not, however, resolve the broader error-free release contract identified in B-01.
>
> **Code quality and Chinese-comment verdict**
>
> This is a **plan audit**, so there is no implementation diff from which to calculate actual `E` and `C`.
>
> - The planned module ownership is appropriate: test discovery, partitioning, process orchestration, and aggregate failure belong in the package test orchestrator; report consumption belongs in CI/Turbo configuration.
> - The planned change avoids application production code, dependencies, lockfiles, retries, and compatibility branches.
> - The plan commits to calculating actual `E` and `C` after implementation and reserves explanatory Chinese comments near the process boundary, normalization, exact-once routing, failure aggregation, report handling, and cache/workflow decisions.
> - Feasibility is plausible, but the final implementation must recompute the hard gate.
>
> **Release verdict**
>
> **BLOCK**
>
> The OpenTUI process-isolation route is well-supported and has no primary-path or fallback defect, but the canonical plan explicitly excludes observed CI failures while claiming a final error-free correction. Revise the plan's scope and traceability, increment the revision, and request another full-scope audit.

### Round 2 Independent Verdict (verbatim)

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> 1. **缺少针对失败聚合语义的自动化故障注入测试。**  
> `INV-03` 要求 core shard 失败后仍运行 TUI shard，并最终返回非零状态。计划通过诊断运行 `30168972664` 和最终实现源码审查覆盖该语义，但 `packages/opencode/test/script/test-ci.test.ts` 只明确测试路径规范化和精确分区。建议实现审计时重点核实该执行路径；现有诊断 workflow 已观察到 core 失败后 TUI 继续执行，因此当前不构成阻断。
>
> 2. **`Audit mode` 元数据可以更精确。**  
> 计划第 9 行填写 `full-scope`，本次输入模式为 `plan`。完整审计范围已经在计划和审计记录中明确，该差异不影响设计执行性或修复行为。
>
> ## Rejected speculation
>
> - 没有证据支持要求修复 `opentui.dll` 内部的具体无效内存操作。仓库可控制的首个偏离点是 `packages/opencode/package.json:11` 的单进程测试编排；外部原生库内部缺少仓库可拥有的源码修复 seam。
> - 没有证据支持增加重试、跳过、隔离名单、平台开关或第二套测试路径。这些方案会降低覆盖率或形成 alternate success path。
> - 没有证据表明当前分区遗漏现有测试命名类型。直接检查未发现 `.spec.*`、`*_test.*`、`.test.js`、`.test.jsx`、`.test.mjs` 或 `.test.cjs`；当前测试域由 `.test.ts` 和 `.test.tsx` 构成。
> - 没有证据表明 OpenTUI 直接运行时仍需要额外分片。直接导入 `@opentui/core` 或 `@opentui/solid` 的测试均位于计划列出的 `test/cli/run/**`、`test/cli/tui/**`、`test/cli/cmd/tui/**` 范围，类型型 fixture 不构成独立测试入口。
> - GitHub API 独立确认：
>   - `30131430684` 的单进程基线为 2/3 失败；
>   - `30168396381` 的三个 focused TUI job 全部成功；
>   - `30168972664` 的两进程完整测试为两个成功、一个保留普通测试失败。  
> 因而不能把原生崩溃归因于普通 Bun 测试并发，也不能把普通断言失败转换成成功。
>
> ## Requirement and traceability coverage
>
> - **完整 CI 修正：** `INV-01` 至 `INV-06` 覆盖精确测试覆盖、进程隔离、失败传播、JUnit 保留、用户行为不变，以及当前主分支 DB/daemon 回归验证。
> - **首个偏离点：** 当前 `test:ci` 在一个 Bun 进程中运行全部测试，见 `packages/opencode/package.json:11`；计划在测试编排 owner 中建立两个强制、顺序、独立进程。
> - **真实 producer-to-consumer 路径：** GitHub required job → Turbo `opencode#test:ci` → package `test:ci` → 测试发现与分区 → core child → fresh CLI/TUI child → 两份 JUnit → 聚合退出状态。
> - **报告消费者：** `.github/workflows/test.yml:39-89,118-146,359-377` 和 `turbo.json:20-23` 均已纳入精确修改计划。
> - **普通失败保留：** 任一 shard 非零都会令最终命令非零；前一 shard 失败不会抑制后一 shard。
> - **原始反馈闭环：** 最终实现必须复制到已授权的 OpenTUI 诊断分支，在三个 GitHub-hosted Windows job 上执行完整测试；任何 native、DB、daemon 或其他失败都会阻断完成。
> - **用户侧行为：** 不修改应用生产源码、依赖、版本或 lockfile。
> - **修改预算：** 计划共六个文件，包含 canonical plan；实现/config/test 有效改动预计 70–100 行，明显低于 800 行代码。
> - **提交约束：** 主工作树实现不得提交；仅临时 `diag/opentui-windows-crash` 分支允许为远程实验提交和推送。
>
> 前向与反向追踪完整，未发现遗漏的已确认需求或缺乏证据的生产概念。
>
> ## Primary-path and fallback verdict
>
> 计划定义了一条权威路径：
>
> 1. 发现全部 package test 文件；
> 2. 统一 Windows/Unix 路径分隔符；
> 3. 每个测试精确归入 core 或 CLI/TUI；
> 4. 清理陈旧 XML；
> 5. 运行 core shard；
> 6. 在新 Bun 进程中运行 CLI/TUI shard；
> 7. 保留 `junit-core.xml` 和 `junit-tui.xml`；
> 8. 仅在两个 shard 都成功时返回零。
>
> 两个 shard 是同一测试编排合同下的强制分支。计划没有重试、跳过、平台专用成功路径、catch-and-default、失败后替代实现或隐藏 feature disabling。诊断决策面为零。
>
> ## Code quality and Chinese-comment verdict
>
> 这是 plan audit，尚无实现 diff，不能计算实际 `E` 和 `C`。
>
> - 新增逻辑位于 package 测试编排 owner；JUnit 消费变化位于 CI 和 Turbo owner。
> - `partitionTestFiles` 是可复用、可独立测试的真实分类 seam，没有扩展用户侧接口或配置。
> - 计划未引入依赖、兼容层、缓存状态、重试或应用生产代码。
> - 计划承诺按实际实现重新计算：
>   - `E > 0`
>   - `C >= max(1, ceil(E × 0.15))`
> - 预计 `E = 70–100`、`C = 11–15`，并把中文解释性注释放在进程生命周期边界、路径规范化、精确一次路由、失败聚合、陈旧报告清理以及 CI/Turbo wildcard 合同附近。该预算可行，实际实现仍须重新审计。
>
> ## Release verdict
>
> **APPROVE**
>
> 该结论仅适用于 `docs/plans/windows-opentui-test-process-isolation.md` 的 **R2** 完整修订。记录本次 clean verdict 后，R2 才可转为 `approved`；任何实质性设计、范围、文件、测试或路径变更都必须递增 revision 并重新执行完整 plan audit。

## 23. Implementation Evidence

Approved revision R2 has been implemented in the main worktree without a main
commit. The exact five-file implementation was also committed only to the
authorized diagnostic branch for remote verification.

### Actual Files and Diff

- `packages/opencode/script/test-ci.ts` added: 70 raw lines. It discovers,
  normalizes, partitions, executes, reports, and aggregates both mandatory
  shards.
- `packages/opencode/test/script/test-ci.test.ts` added: 26 raw lines. It locks
  mixed Windows/Unix path normalization and exact-once classification.
- `packages/opencode/package.json` modified: one script line routes `test:ci`
  through the package owner.
- `.github/workflows/test.yml` modified: 8 additions and 7 deletions make the
  three opencode required jobs and upstream report consumers glob-aware.
- `turbo.json` modified: one line retains every opencode unit XML report.
- No application production source, dependency, version, lockfile, migration,
  generated artifact, or user-facing interface changed.
- The canonical plan is the sixth task file. User/other-agent worktree changes
  outside these paths are unrelated and excluded.
- Exact diagnostic implementation commits: `9f9d03e490` (current-main R2
  implementation and three Windows jobs) and `d83e9506e6` (temporary Linux/macOS
  verification jobs). Neither commit is on `dev-smark`.

### Red-Green Test Evidence

- Red: `bun test test/script/test-ci.test.ts` from `packages/opencode` failed with
  `Cannot find module '../../script/test-ci'`, `0 pass`, `1 fail`, before the
  runner existed.
- Green: the same command after the minimal partition implementation produced
  `1 pass`, `0 fail`, and remained green after comment/config completion.
- Independent expected values list one core path and four normalized CLI/TUI
  paths; the test does not inspect source text, helper calls, or spawn counts.
- Failure aggregation was observed through the real integration seam in run
  `30168972664`: core exited 1, the TUI shard still ran to `606 pass / 0 fail`,
  and the wrapper remained non-zero. This is the approved non-blocking substitute
  for a synthetic failure-injection interface.

### Verification Commands and Results

- `bun test test/script/test-ci.test.ts` (`packages/opencode`): `1 pass`,
  `0 fail`.
- `bun test test/cli/db-maintenance.test.ts -t "holds the daemon election while initially offline compression runs" --rerun-each 20`
  (`packages/opencode`): `20 pass`, `0 fail` in 337.65s.
- `bun test test/cli/tui/daemon.test.ts -t "daemon startup resumes an interrupted maintenance task from its persisted record" --rerun-each 10`
  (`packages/opencode`): `10 pass`, `0 fail` in 98.92s.
- `bun test test/cli/run test/cli/tui test/cli/cmd/tui --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-tui.xml`
  (`packages/opencode`): `617 pass`, `12 skip`, `0 fail`, 629 tests across 70
  files; `junit-tui.xml` exists.
- Local `bun typecheck` could not start because the pre-existing local install
  lacks `@typescript/native-preview/bin/tsgo.js`; no install or lockfile change
  was attempted. The same package command passed on both Linux and macOS in run
  `30175387710` (`$ tsgo --noEmit`, successful step).
- Local `bun run test:ci` entered the 229-file core shard but reached the
  60-minute tool limit under the already-observed local fixture/resource
  degradation before TUI. It produced no completion report and is not used as a
  green claim. GitHub-hosted exact-command evidence below supplies the required
  full-suite verdict.
- GitHub run `30173952650`, exact implementation on current `dev-smark` base:
  three Windows jobs all succeeded. Each ran core `3523 pass / 0 fail`, 3569
  tests across 229 files, then TUI `617 pass / 0 fail`, 629 tests across 70
  files. No native, DB, daemon, timeout, or ordinary failure occurred.
- GitHub run `30175387710`: Linux, macOS, and three repeated Windows jobs all
  succeeded. Linux passed typecheck, core `3434 pass / 0 fail`, and TUI
  `624 pass / 0 fail`; macOS passed typecheck, core `3441 pass / 0 fail`, and
  TUI `624 pass / 0 fail`; each platform ran 229 core plus 70 TUI files.
- Run `30175387710` uploaded five platform artifacts; run `30173952650` uploaded
  three Windows artifacts. Downloaded artifact `opentui-windows-implemented-1`
  contains both `junit-core.xml` and `junit-tui.xml`.
- `git diff --check` passed for the approved paths. `actionlint` is not installed
  locally; GitHub parsed and executed both modified report globs successfully.

### Original Feedback-Loop Result

Baseline run `30131430684` reproduced `opentui.dll` exit 3 in 2 of 3 Windows
jobs. Exact implementation run `30173952650` passed 3 of 3 Windows jobs, and
cross-platform run `30175387710` passed another 3 of 3 Windows jobs. Across six
post-implementation Windows full-suite executions there were zero native
crashes, zero test failures, and zero timeouts. Every run covered 229 core plus
70 TUI files and retained both JUnit reports.

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Success behavior | Verdict |
| --- | --- | --- | --- |
| Core child process | Mandatory primary-contract branch | Must exit zero | approved |
| Fresh CLI/TUI child process | Mandatory primary-contract branch | Must exit zero | approved |
| Continue to TUI after core non-zero | Primary-contract failure-preservation branch | Aggregate remains non-zero | approved; observed in `30168972664` |
| Retry, skip, quarantine, platform switch, alternate runner | Absent | None | no fallback |

Actual alternate success paths: zero. Actual diagnostic decision surface in the
main implementation: zero.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 78 | Runner 49 + test 20 + workflow 7 + package 1 + Turbo 1. Excludes 4 import-only lines, blank lines, 13 comments, plan text, and unrelated worktree changes. |
| Qualifying Chinese comment lines `C` | 13 | Runner 10 + test 2 + workflow 1, adjacent to process, path, report, fail-closed, expected-value, and glob boundaries. |
| Ratio `C / E` | 16.67% | `13 / 78` |
| Required minimum `C` | 12 | `ceil(78 * 0.15) = 12` |

### Remaining Unverified Items

- The implementation is intentionally uncommitted on `dev-smark` because the
  latest user instruction forbids a main-worktree commit/push.
- The formal `test.yml` required job cannot run on the uncommitted main worktree;
  the authorized diagnostic branch ran the exact package command, exact five
  implementation files, current main base, and modified report paths on all
  three supported OS families.
- Local typecheck and local core completion are unavailable for environment/time
  reasons recorded above; successful GitHub-hosted checks cover both commands.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | none | 2 findings recorded below | APPROVE | `ses_064b5a219ffe1LFKBZd2jYVotM` |

### Round 1 Independent Verdict (verbatim)

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> - `docs/plans/windows-opentui-test-process-isolation.md:9` 的 `Audit mode` 仍为 `plan`，与当前 `implementation-audit-required` 状态不一致。实现范围、批准版本和审计输入均明确，因此这是记录层面的非阻断问题；归档本轮结论时应更新该字段。
> - 本地 `packages/opencode` 完整测试因当前环境和时限未完成，但 GitHub-hosted 的等价验证覆盖了 Linux、macOS 和 Windows。GitHub API 独立确认：
>   - run `30173952650` 的三个 Windows `Run implemented package suite` 均成功；
>   - run `30175387710` 的 Linux、macOS 和三个 Windows package suite 均成功；
>   - Linux、macOS 的 `Typecheck opencode package` 均成功；
>   - 五个平台产物均已生成。  
>   现有远程证据足以满足发布门槛。
>
> ## Rejected speculation
>
> - 不将 `Bun.spawn` 启动时抛错导致 TUI shard 未执行列为缺陷：命令使用当前有效的 `process.execPath` 和固定存在的 package root，没有可达失败 producer。
> - 不要求支持多个并发 `test:ci` 调用共享同一个报告目录：当前 CI producer 为隔离 runner，仓库没有这种并发调用合同。
> - 不要求继续修补 OpenTUI native 内存行为：仓库证据把首个可控偏离定位在 package test orchestration 的进程生命周期边界，native 库内部没有仓库所有权或可执行修复证据。
> - 不要求平台专用分支、重试、skip 或 quarantine；这些路径会削弱覆盖或形成替代成功路径。
>
> ## Requirement and traceability coverage
>
> - **批准一致性：** 当前 canonical revision 与 approved revision 均为 `R2`，计划审计记录显示 R2 已获得完整范围批准。
> - **真实执行路径：** GitHub required job → Turbo `opencode#test:ci` → `packages/opencode/package.json:11` → `script/test-ci.ts` → test discovery → core child → fresh TUI child → 两份 JUnit → 聚合退出状态。
> - **首个偏离与 owner：** 原命令在一个 Bun 进程中混合 core 与 native-backed CLI/TUI 测试。修复位于 package test orchestrator，符合 `docs/plans/windows-opentui-test-process-isolation.md:131-180` 的 owner 分析。
> - **INV-01：** `script/test-ci.ts:43-55` 发现所有 `.test.ts/.test.tsx` 文件、统一路径并 fail closed；`test-ci.test.ts:5-24` 使用独立 literal expected 值验证 Windows/Unix 路径及完整分区。
> - **INV-02：** `script/test-ci.ts:63-65` 顺序等待 core child 退出后创建新的 TUI child，后者不继承 core child 的 native process state。
> - **INV-03：** `script/test-ci.ts:64-67` 无论 core 状态如何都会运行 TUI；`coreStatus || tuiStatus` 保留任一非零退出。没有 catch-and-success。
> - **INV-04：** 两个 child 分别写入 `junit-core.xml` 和 `junit-tui.xml`；`.github/workflows/test.yml:39-147,360-378` 与 `turbo.json:20-23` 消费并保留所有 XML。
> - **INV-05：** 五个实现文件均为测试编排、CI 或 cache 配置；没有应用生产源码、依赖、版本、lockfile 或用户侧接口变化。
> - **INV-06：** exact implementation 的跨平台远程 package suite 全部成功；Linux/macOS typecheck 成功。GitHub API 还确认 baseline run `30131430684` 为三个 Windows job 中两个失败，实施后六个 Windows package-suite job 全部成功。
> - **测试敏感性：** partition test 在原始版本无法导入尚不存在的 `script/test-ci.ts`，因此能在原行为上变红；远程 package command 通过实际 child process、退出码和产物 seam 验证完整编排行为。
> - **范围约束：** 五个 implementation files，加 canonical plan 共六个任务文件；实现 raw diff 明显低于 800 行。主工作树仍未提交，符合“主仓库禁止提交”；诊断提交只存在于获准的 `diag/opentui-windows-crash` 分支。
> - **验证：** 针对审计路径执行的 `git diff --check` 通过。诊断 commit `9f9d03e490` 相对当前 base `71afbee8f4` 仅包含五个正式实现文件和获准的临时 diagnostic workflow；正式五个文件与被审计内容一致。
>
> ## Primary-path and fallback verdict
>
> 唯一权威路径为：
>
> 1. 发现全部 package test files；
> 2. 规范化路径分隔符；
> 3. 精确分入 core 或 CLI/TUI；
> 4. 清理旧 XML；
> 5. 运行 core child；
> 6. 在新 Bun 进程中运行 TUI child；
> 7. 保留两份独立 JUnit；
> 8. 仅当两个 child 均为零退出时成功。
>
> 两个 shard 是同一测试编排合同下的强制分支。实现没有 retry、skip、quarantine、平台开关、catch-and-default、失败后替代 runner 或其他成功路径。实际 alternate-success surface 为零，diagnostic decision surface 为零。
>
> ## Code quality and Chinese-comment verdict
>
> - 模块边界正确：partition、child lifecycle、报告清理和退出聚合由 package orchestrator 所有；报告消费由 CI/Turbo 所有。
> - 没有 `any`、类型抑制、unchecked cast、non-null assertion、新依赖、公共接口扩展、用户侧配置或无关重构。
> - `partitionTestFiles` 是真实分类 seam；测试 expected 值未复制 regex 或 normalization 算法。
> - `git diff --check` 通过；远程 Linux/macOS typecheck 与三平台 package suites 通过。
>
> 实际中文解释性注释计算：
>
> | 项目 | 实际值 |
> |---|---:|
> | Runner 有效代码 | 49 |
> | Test 有效代码 | 20 |
> | Workflow 有效代码 | 7 |
> | Package script | 1 |
> | Turbo config | 1 |
> | `E` | **78** |
> | 要求的 `C` | `ceil(78 × 0.15) = 12` |
> | 实际合格 `C` | **13** |
> | 比率 | **16.67%** |
>
> 排除了 4 行 import-only、空行、plan 文本、未修改上下文、纯删除的旧值和无关 worktree 变化。13 行注释分别解释路径表示、native process boundary、exact-once 默认路由、JUnit 覆盖风险、空 shard fail-closed、陈旧报告清理、失败传播、测试 expected 独立性及 workflow glob 合同，均与相关决策相邻。
>
> 中文解释性注释硬门槛通过。
>
> ## Release verdict
>
> **APPROVE**
>
> 该结论仅适用于 canonical plan **R2** 与本次列出的五文件 implementation diff。主工作树保持未提交；任何实质性实现、范围、测试、owner 或路径变化都需要重新执行完整 implementation audit。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
