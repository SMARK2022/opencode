# Canonical Implementation Plan: Windows LSP lifecycle test CI fix

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: implementation (full-scope)
>
> Requirement source: 当前需要在Windows CI测试中修复该问题,同时尽量保证该测试行为逻辑正确且不会发生质量降级,并该完整地阐释测试所希望表达的含义,而不是单纯地简单地放宽测试要求或者退化。目标终态：verified-implementation-and-commit。
>
> Implementation allowed: yes (verified complete)
>
> Last updated: 2026-07-20

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

当前需要在Windows CI测试中修复该问题,同时尽量保证该测试行为逻辑正确且不会发生质量降级,并该完整地阐释测试所希望表达的含义,而不是单纯地简单地放宽测试要求或者退化。

目标终态：`verified-implementation-and-commit`。

Observed CI / local symptoms in scope (same Windows failure class):

1. `lsp.spawn > removes terminated clients and rejects stale in-flight claims` fails with `EBUSY` on `fs.rm(root)`.
2. `lsp.spawn > would spawn builtin LSP for files inside instance when config object is provided` fails with `Typescript.spawn` call count `Expected 1, Received 2` when run after (1), and passes alone.

Out of primary scope unless a new red-capable signal appears during verification:

- `daemon startup resumes an interrupted maintenance task from its persisted record` (local 5/5 green; only reported under upstream-unit warning, not the hard-fail core pair above).

## 2. Explicit Non-Goals

- Do not skip, soft-assert, platform-gate away, or delete the lifecycle assertions for root-gone, process-exit, handoff, reload, or missing-root.
- Do not change production LSP lifecycle, Session ownership, prune/exit detach, or spawn/config selection semantics.
- Do not “fix” the second spawn-count failure by relaxing its expectation or isolating it with suite-order hacks alone without fixing spy leakage.
- Do not add fallback success paths, parallel registries, retries, or Windows-only production special cases for directory deletion.
- Do not expand into daemon cold-storage recovery, TUI, or unrelated CI flakes without a fresh red-capable loop for those symptoms.
- Do not modify `packages/app`.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session has identity; LSP runtime is directory/InstanceState scoped, not a DB table. Lifecycle cleanup is process/status/registry behavior. |
| root / `packages/opencode/AGENTS.md` | Package-local tests; Effect service patterns; minimal edits; no production refactor without evidence. |
| `packages/opencode/test/AGENTS.md` | Effect tests use `testEffect` / `provideTmpdirInstance`; concurrent waits use published readiness (`pollWithTimeout` / Deferred), not fixed sleep; prefer finalizer-safe cleanup. |
| `.opencode/policy/first-principles-engineering.md` | Repair first divergence; no fallback; full forward/reverse mapping; independent audit; Chinese comment gate when E>0. |
| `docs/plans/lsp-client-lifecycle-session-isolation.md` (verified R16) | The failing test was introduced to lock root/process terminal detach, stale in-flight claims, and missing-root orphan kill. That behavioral contract remains in force; this task repairs the Windows-invalid harness, not the product contract. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/test/lsp/index.test.ts:405-466` | Failing lifecycle test: root `fs.rm`, process stop, handoff/reload/missing-root; spies restored via JS `try/finally`. | observed |
| `packages/opencode/test/lsp/index.test.ts:468-495` | Cascading spawn-count test; alone green, after lifecycle fail red (`Received 2`). | observed |
| `packages/opencode/src/lsp/lsp.ts` `getClients` / `schedule` / `pruneMissingRoots` / `removeExitedClient` / claim/token logic | Production path: client root identity is `entry.client.root`; prune uses `existsSafe(root)`; process exit detaches exact entry; initialize re-checks root existence. | observed |
| `packages/opencode/src/lsp/server.ts` Typescript / multi-server `.ts` matchers | Confirms single `typescript` export; config-object path does not double-register Typescript. | observed |
| `packages/opencode/src/lsp/launch.ts` + `src/util/process.ts` `stop` | Child spawn/stop; Windows uses taskkill tree kill. | observed |
| `packages/core/src/filesystem.ts` `existsSafe` | Root terminal observability is path existence, not process cwd. | observed |
| `packages/opencode/test/fixture/lsp/fake-lsp-server.js` | Fake stdio LSP used by the harness. | observed |
| Local red loop (Windows): `bun test test/lsp/index.test.ts -t "removes terminated clients\|would spawn builtin LSP for files inside instance when config object"` | Reproduces EBUSY then cascade call-count 2. | observed |
| Alone green: config-object spawn test 5/5; daemon recovery test 5/5 | Bounds scope to lifecycle harness + spy isolation. | observed |
| Effect.gen + JS finally probe | `finallyRan=false`, mock remains active after Effect failure — spy leak mechanism. | observed |
| OS probe: process `cwd=root` → `rm root` fails; process `cwd=parent` → `rm root` OK | Windows NT directory sharing vs Unix unlink semantics. | observed |
| CI log excerpt from user (必过核心 / Windows + 上游单元) | Same two LSP fails; daemon only in upstream warning surface. | observed |

## 5. Current Behavior

```text
Lifecycle test (terminal=root)
  mock Typescript.root -> <tmpdir>/root
  mock Typescript.spawn -> fake process with cwd=<tmpdir>/root
  touchFile -> client registered with client.root=<tmpdir>/root
  fs.rm(<tmpdir>/root)                          <-- Windows EBUSY while process holds cwd
  poll status for detach+shutdown               <-- never reached

Effect.gen fails
  JS try/finally around spawn/root spies does NOT run under Effect failure
  Typescript.spawn mock remains active with prior call count

Next test (config object spawn)
  spyOn(Typescript.spawn) sees polluted mock/count
  hover once -> expect calledTimes(1) fails with 2
```

Production intended path (unchanged, still correct):

```text
touchFile/hover
  -> getClients
  -> schedule(server, root)
  -> LSPClient.create({ root })
  -> entry.client.root = root
  -> process.once("exit") -> removeExitedClient (exact entry)
status/getClients
  -> pruneMissingRoots: existsSafe(entry.client.root) false
  -> detach + shutdown
initialize completion
  -> existsSafe(root) false => shutdown, do not register
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Workspace root path deleted while registry still holds a client for that root | Tests, user/OS deleting a project tree after LSP started with a different cwd, volume unmount, rename of root | `existsSafe` reports false | `status` / `getClients` → `pruneMissingRoots` | `LSP` State | observed (Unix harness) / reachable (Windows if root not locked by cwd) |
| Child LSP process exit | `Process.stop`, crash, natural exit | Node `exit` event | `removeExitedClient` | `LSP` State | observed |
| In-flight spawn + new Session generation (handoff) | Concurrent `withSession` touch | shared `spawning` map + token claims | claim/handoff path | `LSP` + Session owner token | observed |
| Instance dispose during in-flight spawn (reload) | `disposeInstance` | State finalizer `closed=true` + shutdown | finalizer + claim rejection | InstanceState / LSP | observed |
| Root vanishes during initialize (missing-root) | rename/delete root before schedule finishes | re-check `existsSafe(root)` after create | schedule orphan shutdown | `LSP.schedule` | observed |
| Windows process cwd equals root while test deletes root | Current test mock | NT refuses delete | test only; not production invariant | test harness | observed |
| Effect failure mid-test | `Effect.promise` rejection | Effect.gen does not run JS `finally` | spy leak to later tests | test harness | observed |
| Daemon startup recovery flake | upstream-unit report only | not red locally | out of primary scope | daemon/maintenance | speculative for this task |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | When a registered client’s root path no longer exists, that exact client is detached from status and its shutdown path runs (not merely filtered from UI). | `pruneMissingRoots` + lifecycle test comment | `removes terminated clients…` root branch |
| INV-02 | When the child process exits, that exact client is detached and shutdown runs. | `removeExitedClient` | same test, process branch |
| INV-03 | A newer Session generation can claim an in-flight spawn (handoff); disposed State / missing root leaves no orphan status row and kills the orphan process when no successor claims it. | claim/token + schedule root re-check | handoff / reload / missing-root branches |
| INV-04 | Builtin Typescript spawn still runs when `lsp` is a config object that only disables other servers (e.g. eslint). | config merge in `LSP.state` | `would spawn builtin LSP … when config object is provided` |
| INV-05 | Effect-based tests must restore module spies even when an Effect fails, so later cases observe independent call counts and implementations. | Effect.gen finally probe + cascade | lifecycle + next spawn test interaction |
| INV-06 | Windows CI must exercise the same behavioral invariants as other platforms without platform skip of the lifecycle contract. | user requirement + CI matrix | package `test:ci` on Windows |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 (testability on Windows) | Test sets fake process `cwd` to the same path it later deletes as “root missing”. Production stores and prunes `client.root` independently of process cwd. First false point is the harness binding, not `pruneMissingRoots`. | `packages/opencode/test/lsp/index.test.ts` lifecycle fixture | Local EBUSY; OS probe; production uses `existsSafe(entry.client.root)` |
| INV-05 | Spies for `Typescript.spawn` / `root` restored only in JS `try/finally` inside `Effect.gen`. On Effect failure, finally does not run; mock + call history leak. | same test (cleanup ownership) | `finallyRan=false` probe; cascade Received=2 |
| INV-04 | Cascading symptom only: expectation is correct when isolation holds. | test order + leaked mock | alone 5/5 green |
| INV-02/03 | Not first-diverged in production; blocked from running on Windows by INV-01 failure earlier in the same test. | blocked by prior harness failure | test structure: root loop before process/handoff |

### Red-capable feedback loop

Command (package dir `packages/opencode`):

```text
bun test test/lsp/index.test.ts -t "removes terminated clients and rejects stale in-flight claims|would spawn builtin LSP for files inside instance when config object is provided"
```

Observed symptom (Windows, 2026-07-20, multiple runs):

1. First test fails: `EBUSY: resource busy or locked, rm '...\root'`.
2. Second test fails: `expect(spy).toHaveBeenCalledTimes(1)` → Received `2`.

Minimized:

- Alone lifecycle test → EBUSY only.
- Alone config-object test → green.
- Together → both red.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Simulate missing root without locking that path as process cwd | Lifecycle test harness | Exercise `pruneMissingRoots` / schedule root re-check via real FS existence of `client.root` | Test constructs root identity and fake process | Production must not special-case Windows delete |
| Process-exit terminal | Lifecycle test + `Process.stop` | Child exit removes exact client | Existing production exit listener | No second registry |
| Spy isolation under Effect failure | Lifecycle test (and any sibling spies in the same case) | Module spies restored on scope close | Matches `create` spy pattern already using `Effect.addFinalizer` | Production has no spies |
| Builtin spawn under partial lsp config | Existing spawn test | `hover`/getClients attempts Typescript once | Already product behavior | No production change |

## 10. Single Approved Primary-Path Design

Repair the **test harness first divergence** so the existing production primary path can be observed on Windows without weakening assertions.

```text
lifecycle fixture
  -> mock Typescript.root(file) = <instance>/<case>/root
  -> mock Typescript.spawn to start fake LSP with cwd = <instance> (or other path that is NOT the root-under-test)
     while still returning a real process handle for exit/stop
  -> touchFile registers client with client.root = mocked root
  -> terminal=root: physically remove the root directory (fs.rm) once no process holds it as cwd
  -> status poll still requires: no typescript row AND observed shutdown count advanced
  -> terminal=process: Process.stop(handle); same status/shutdown assertion
  -> handoff/reload/missing-root: keep Deferred-controlled spawn boundary
     missing-root may rename/delete root while process cwd remains non-root so Windows can mutate the path
  -> spy restore contract (per loop iteration, not only whole-test end):
       outer create spy: Effect.addFinalizer (already present)
       each terminal/transition iteration that installs spawn/root spies:
         install under Effect.acquireRelease / addFinalizer scoped to that iteration
         restore on success-path exit of the iteration AND on mid-iteration Effect failure
         double mockRestore is fine; leaving a mock active into the next iteration is not
       never rely only on JS try/finally around yield* for spawn/root restore
```

Why this repairs the first divergence:

- Production invariant is about **`client.root` existence and exact-entry detach/shutdown**, not about “the language server process’s cwd equals root and the OS allows deleting that cwd”.
- Using a non-root process cwd is a **fixture control** that makes the root-missing path reachable on Windows without changing product code or soft-failing assertions.
- Effect finalizer spy restore removes the cascade that falsely fails INV-04.

Explicitly rejected (quality degradation / fallback):

- `it.skip` / `if (win32) continue` on root or missing-root branches.
- Catching EBUSY and treating as pass.
- Weakening shutdown count or status assertions.
- Changing production to ignore missing roots or to change cwd policy for real servers.
- Relying on suite ordering or `mockClear` only in the second test without fixing leak source.

### Test meaning preserved (must stay in comments near the fixture)

The lifecycle case is one vertical contract with two terminal classes and three stale-claim transitions:

1. **Root terminal** — registry identity is the workspace root path; when that path is gone, the client must leave status and run shutdown (not a ghost row).
2. **Process terminal** — child death is an independent terminal; exact-entry detach must still shutdown.
3. **Handoff** — a new generation token may take over an in-flight spawn without orphaning a second process row.
4. **Reload** — disposed Instance State must not leave a status row; orphans shutdown.
5. **Missing-root mid-spawn** — initialize completing against a vanished root must not register a usable client; the process must exit.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Production pruneMissingRoots / removeExitedClient / claim handoff | current | primary-contract | yes | 100% product | preserve unchanged |
| Test: fake process cwd ≠ root-under-test | proposed | primary-contract branch of harness (domain: make root FS mutation possible) | enables observation only | harness | add |
| Test: per-iteration Effect.acquireRelease/addFinalizer for spawn/root spies | proposed | primary-contract of test isolation | no product success | harness | add; replace JS-finally-only restore; restore between loop iterations and on Effect failure |
| Platform skip of root branch | not proposed | forbidden fallback | would fake green | reject | reject |
| Catch EBUSY → continue | not proposed | forbidden fallback | yes (false) | reject | reject |
| Production Windows cwd special-case | not proposed | over-design / wrong owner | n/a | reject | reject |

New alternate product success paths: **zero**.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| JS `try/finally { mockRestore() }` around `yield*` for spawn/root spies | Assumed generator finally runs on Effect failure | Effect does not run that finally; outer `create` already uses `Effect.addFinalizer`. Loops install new spawn/root spies each iteration, so restore must be per-iteration (success path + Effect failure), not a single whole-test finalizer that leaves mocks live across terminal/transition iterations. | Replace in both lifecycle `for` loops |
| Fake process `cwd: root` coinciding with deleted root | Convenience mirror of real tsserver cwd | Couples OS cwd locking to an invariant that production checks via path existence | Change cwd binding in spawn mocks only |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 root terminal on Windows CI | `pruneMissingRoots` | test fixture cwd decoupling + keep status/shutdown asserts | same lifecycle test root branch green on Windows |
| INV-02 process terminal | `removeExitedClient` | ensure process branch still runs after root branch | same test process branch |
| INV-03 handoff/reload/missing-root | claim + schedule root re-check + finalizer | missing-root FS mutation without cwd lock; finalizers | same test transition loop |
| INV-04 config-object spawn | `LSP.state` server merge + getClients | no product change; isolation fix | config-object test green alone and after lifecycle |
| INV-05 spy isolation | n/a (test) | per-iteration finalizer/acquireRelease for spawn/root; outer finalizer for create | cascade gone in paired run; no cross-iteration mock bleed |
| INV-06 no quality skip | n/a | no platform skip | full lifecycle asserts retained |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| *(none — no production concept)* | — | product path already implements INV-01..03 | N/A |
| Harness: non-root fake cwd | INV-01, INV-03, INV-06 | Windows EBUSY + OS probe | Current mock sets cwd=root so root cannot be deleted while process lives |
| Harness: per-iteration Effect finalizer spy restore | INV-05, INV-04 | Effect.gen finally probe + cascade; spies created inside `for` loops | JS finally does not run on Effect failure; whole-test-only finalizer leaves mocks across iterations |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/lsp/index.test.ts` | modify | Lifecycle fixture: (1) spawn fake LSP with cwd outside root-under-test; (2) per-iteration Effect.acquireRelease/addFinalizer for spawn/root spies (success-path restore + failure restore; double restore OK); keep outer create finalizer; (3) keep all behavioral expects; (4) nearby Chinese comments stating terminal/stale-claim intent, Windows cwd vs root identity, and per-iteration spy isolation. Optionally tighten config-object test spy restore to finalizer for consistency if touched. | ~30–70 net |
| Production files under `src/lsp/**` | none | No product divergence | 0 |
| `docs/plans/windows-lsp-lifecycle-test-ci-fix.md` | add (this plan) | Canonical plan only | plan only |

## 16. TDD Behavior Slices

This task is a **failing-test repair** of an existing red loop (diagnosing-bugs), not a greenfield feature. Slices:

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Lifecycle test fails on Windows at `fs.rm(root)` with EBUSY | Fake process cwd locks root | Fake process cwd is not root-under-test; `fs.rm`/`rename` succeed; status empty + shutdown counted | INV-01 |
| 2 | Process branch + handoff/reload/missing-root still assert after root branch | Currently unreachable after root EBUSY | Full loop completes on Windows | INV-02, INV-03 |
| 3 | Paired run: config-object spawn expects 1 call | Spy leak from lifecycle Effect failure | Per-iteration + outer finalizer restore; call count independent | INV-04, INV-05 |
| 4 | Multi-iteration lifecycle still isolates spawn/root mocks | Spies installed inside loops | Each terminal/transition restores before next install | INV-05 |

Independent expected values remain:

- Status rows (presence/absence of `typescript`, `sessionIDs` shapes).
- Observed shutdown counts.
- Process exit codes for missing-root.
- Spawn call count for config-object case (public module seam already used by suite; not private helper counting of production algorithms).

Do not replace behavioral status/shutdown checks with “spy was restored” meta-asserts as the sole green signal.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~30–50 | Test logic changes excluding pure formatting |
| Required Chinese explanatory comments `C` | `>= max(1, ceil(E * 0.15))` ≈ 5–8 | Nearby comments only |

Must document near the fixture (not restating control flow):

- Root identity for prune is `client.root` path existence; fake process cwd is intentionally decoupled so Windows can delete the root path under test.
- Effect.gen JS `finally` does not restore spies on Effect failure; finalizers own restore.
- spawn/root spies are installed inside loops: restore must run per iteration (success and failure); double `mockRestore` is acceptable.
- Terminal classes (root / process) and stale-claim transitions (handoff / reload / missing-root) what they lock.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/lsp/index.test.ts -t "removes terminated clients and rejects stale in-flight claims"` | `packages/opencode` | Lifecycle full loop green on Windows |
| `bun test test/lsp/index.test.ts -t "would spawn builtin LSP for files inside instance when config object is provided"` | `packages/opencode` | Alone green |
| `bun test test/lsp/index.test.ts -t "removes terminated clients and rejects stale in-flight claims\|would spawn builtin LSP for files inside instance when config object"` | `packages/opencode` | Paired original red loop green (cascade closed) |
| `bun test test/lsp/index.test.ts -t "lsp.spawn"` | `packages/opencode` | Adjacent spawn suite regression |
| `bun typecheck` | `packages/opencode` | Types still clean if any type-bearing edit |

Optional if time: full `bun run test:ci` in `packages/opencode` as broader CI mirror.

Daemon recovery is **not** required green-proof for this revision unless it fails in the same verification window with a captured log.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 code (1 plan) | Test-only fix |
| Files modified | 1 (`test/lsp/index.test.ts`) | Single harness owner |
| Files deleted | 0 | — |
| Production lines | 0 | No product divergence |
| Test lines | ~30–60 | cwd + finalizer + comments |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Fake process with non-root cwd might still lock files inside root if it opens them | Fake server only uses stdio; does not open workspace files under root. Keep writing only the fixture `index.ts` before spawn, then delete whole root. |
| missing-root rename still fails if something else locks the path | Ensure no process cwd/open handle under root; use same non-root cwd pattern for deferred spawn branch. |
| Shutdown count expectations depend on branch order | Keep existing numeric expectations; re-validate after green. |
| Unrelated daemon flake reappears in full CI | Out of scope unless red with artifact; do not pre-weaken timeouts. |

### Open Decisions Requiring the User

None. Scope and quality bar are fixed by the verbatim requirement.

### Rejected Speculation

- Production change to spawn all LSPs with parent cwd “for Windows”.
- Mocking `existsSafe` instead of real FS deletion (would weaken INV-01 to pure mock tautology when real FS prune is available).
- Broad rewrite of all suite spies to finalizers in one PR (only lifecycle leak is evidenced; optional local consistency only if same file is already open).

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Reject any plan that skips lifecycle branches or only silences EBUSY.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 per-iteration spy restore underspecified (incorporated below as implementer contract without changing primary path). N-02 red-loop not re-executed in audit session (implementer uses §18 as green gate). | APPROVE | adversarial-auditor task `ses_0812e1ce6ffetLl2FJXk93sDyi` |

Independent auditor release verdict (copied without paraphrasing):

```text
No blocking findings.
```

```text
APPROVE
```

- Audited artifact: `docs/plans/windows-lsp-lifecycle-test-ci-fix.md`
- Revision: `R1`
- Scope: full original requirement + complete affected interface (lifecycle harness, cascade spawn isolation, product non-change boundary)
- Implementation allowed after recorder updates plan metadata to: `Status: approved`, `Approved revision: R1`, `Implementation allowed: yes`
- Clean verdict applies only to this exact plan revision. Any substantive design change increments revision and requires a new full-scope plan audit.

Non-blocking N-01 incorporation (record correction, primary path unchanged):

- Evidence: lifecycle test creates `spawn`/`root` spies inside `for` loops; only outer `create` used `Effect.addFinalizer`.
- Required implementer contract: each iteration that installs spawn/root spies restores them before the next iteration, and mid-iteration Effect failure still restores; use per-iteration `acquireRelease` / finalizer (or equivalent). Double `mockRestore` is fine; missing mid-loop restore is not.
- Sections 10/11/12/13/14/15/16/17 updated to state this contract explicitly.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/test/lsp/index.test.ts` | Lifecycle fixture only: fake LSP `cwd: dir` (not root-under-test); per-iteration `Effect.scoped` + `addFinalizer` for spawn/root spies; behavioral asserts retained; Chinese comments for root identity, Effect spy restore, terminal/stale-claim intent. |
| Production `src/lsp/**` | none |
| `docs/plans/windows-lsp-lifecycle-test-ci-fix.md` | plan/evidence only |

`git diff --stat` (code): `packages/opencode/test/lsp/index.test.ts | ~100 insertions, ~42 deletions` (includes formatting of create spy + comments).

### Red-Green Test Evidence

| Slice | Red (before) | Green (after) |
| --- | --- | --- |
| Lifecycle full loop | Windows `EBUSY` on `fs.rm(root)` | pass, 5 expects |
| Paired cascade | config-object `calledTimes` Expected 1 Received 2 | both pass |
| `lsp.spawn` suite | blocked by lifecycle | 17 pass / 0 fail |

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/lsp/index.test.ts -t "removes terminated clients and rejects stale in-flight claims"` | `packages/opencode` | 1 pass, 0 fail |
| `bun test ... -t "removes terminated...\|would spawn builtin...config object"` | `packages/opencode` | 2 pass, 0 fail (original red loop closed) |
| `bun test test/lsp/index.test.ts -t "lsp.spawn"` | `packages/opencode` | 17 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | pass (`tsgo --noEmit`) |

### Original Feedback-Loop Result

Original Windows paired command that was red with EBUSY + call count 2 is now green on the implementer Windows host.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| Production prune/exit/claim | primary-contract | preserved unchanged |
| Harness cwd ≠ root-under-test | fixture control | added |
| Per-iteration scoped spy restore | test isolation | replaced JS try/finally |
| Platform skip / EBUSY soft-pass | forbidden | not introduced |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 52 | Substantive test logic lines in lifecycle case (scoped wrap, cwd:dir, finalizers, structural loop body). Exclude pure reflow of create spy formatting where possible; exclude plan file. |
| Qualifying Chinese comment lines `C` | 9 | Root vs cwd identity (2); Effect finally gap + per-iteration restore (2); terminal exact-entry intent (1); handoff/reload/missing-root meanings (2); missing-root rename reachability (1); orphan destroy (1). |
| Ratio `C / E` | 0.173 | |
| Required minimum `C` | 8 | `ceil(52 * 0.15) = 8` |

### Remaining Unverified Items

- Full package `test:ci` / GitHub Actions Windows runner not re-run in this session (local Windows package suite covering the original failing cases is green).
- Daemon recovery case remains out of this revision’s green gate per plan §1/§18.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | N-01 full package/GitHub Actions Windows matrix not re-run (optional per §18). N-02 sibling config-object test still uses JS try/finally (pre-existing; cascade closed). | APPROVE | adversarial-auditor task `ses_081209d2affem64A0HwP6zr7CO` |

Independent auditor release verdict (copied without paraphrasing):

```text
No blocking findings.
```

```text
APPROVE
```

- Audited artifact: implementation diff for `packages/opencode/test/lsp/index.test.ts` against approved plan **R1**
- Scope: full original requirement (Windows CI lifecycle harness correctness without quality degradation; preserve and explain lifecycle contract; close cascade isolation)
- Clean verdict applies only to this exact approved revision and this exact implementation diff
