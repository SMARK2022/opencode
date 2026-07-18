# Canonical Implementation Plan: CI Gate Platform Race Repair

> Status: verified
>
> Revision: R5
>
> Approved revision: none
>
> Audit mode: implementation after user-directed three-round plan-audit limit
>
> Requirement source: current Session user instructions and submitted GitHub Actions failures
>
> Implementation allowed: yes, by explicit user override after three full plan audits
>
> Last updated: 2026-07-18

This is the sole implementation specification. R5 records the two additional
failures observed during the user-authorized partial package run and the raised
hard budget of 12 files and 1200 implementation lines. No fourth plan audit is
requested because the user explicitly directed implementation after round
three even if that round blocked.

## 1. Verbatim Requirement

> 调研相关Windows测试报错原因以及解决方案，在不退化测试质量的前提下解决部分竞态问题并且适当进行行为化测试，进行必要的主逻辑以及测试逻辑优化

> 完整检查以及分析我们的CI的test以及build错误的原因与根因解决方式

> 整体修改内容不超过600行,涉及文件不超过8个文件。

> 即使会遇到block,你也需要进行相应的内容更新……开始实施。实施完之后,进行相应的实施完的检查。

> 现在你拥有十二个最大文件数修改……同时保持1200行以内的修改内容；以及那个全量测试要40分钟，不推荐全量执行。

> 目的是正常build与test；即便不是本次造成的也需要修改。

## 2. Explicit Non-Goals

- No workflow retry, timeout expansion, skip, fallback input, replacement daemon, lock deletion, public API, dependency, migration, generated output or build-source change.
- No tracked OpenTUI package/release/source change and no OpenAI/PromptAsync change.
- No permanent fault-injection mode or speculative process abstraction.
- Do not encode local stale-cache recovery as another CI/runtime success path; the user-authorized cache deletion only restores the declared lock graph.

## 3. Repository Context

| Source                        | Constraint                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `CONTEXT.md`                  | Daemon owns Server Lock/health/control lifecycle; TUI is its consumer.                    |
| root/package/test `AGENTS.md` | Package-local tests/typecheck; readiness signals instead of sleeps; owner-local flat ESM. |
| first-principles policy       | Repair first divergence, no alternate success path, actual 15% Chinese comment ratio.     |
| Bun issue `#31603`            | Windows Bun child remains in a kill-on-close job and dies with its parent.                |

## 4. Evidence Read

| Evidence                                        | Finding                                                                                                                                         | Class    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| build run `29618648043`, test run `29618648047` | closure, Windows lease and Windows artifact smoke failed; version and all builders passed                                                       | observed |
| remote OpenTUI refs                             | annotated object `bcfb8bb...`, peeled commit/root gitlink `cbe492a...`                                                                          | observed |
| `verify-opentui-closure.ts` + workflows         | shallow submodule has commit but checkout does not promise local tag refs                                                                       | observed |
| `server-lock.ts` + CI stack                     | first Windows sharing violation is converted directly to busy                                                                                   | observed |
| user `release-assets-windows.zip`               | input was sent before renderer readiness; after fixing that, launcher exit killed old daemon before 60s idle deadline                           | observed |
| parent-exit red test                            | launcher exits 0; daemon PID is dead after 500ms                                                                                                | observed |
| local absolute PowerShell probes                | wrapper kill leaves worker alive; worker exit 132 is mirrored; `-NoNewWindow` preserves stderr; quoted worker path with spaces starts correctly | observed |
| partial `bun run test:ci`                       | non-git watcher lost its first update under load; Windows install harness intermittently could not resolve `env`                                | observed |
| local package realpaths                         | generated `.bun` cache mixed upstream OpenTUI 0.3.4 and Solid 1.9.10 into the declared SMARK/1.9.12 graph                                       | observed |

## 5. Current Paths

```text
shallow checkout -> local tag rev-parse -> Git 128
dead lease -> atomic tombstone rename -> transient EPERM -> busy
SSE attach -> early /exit -> lost ConPTY input -> timeout -> unawaited cleanup EBUSY
Windows TUI -> direct Bun worker -> parent job closes -> daemon dies -> second TUI creates new owner
FileWatcher init -> fork native subscribe -> first write -> event lost
Windows test shell -> resolve external env through target PATH -> env missing
```

## 6. Supported Domain and Reachability

| Condition                                          | Producer/path                              | Owner                         |
| -------------------------------------------------- | ------------------------------------------ | ----------------------------- |
| remote annotated tag absent locally                | recursive shallow checkout -> closure gate | provenance verifier           |
| transient `EPERM/EACCES/EBUSY` on dead-lock rename | Windows reader/scanner -> lease reclaim    | Server Lock                   |
| SSE before input-ready frame                       | daemon attach -> renderer initialization   | artifact harness              |
| launcher exits after first SSE                     | normal TUI exit -> Bun Windows job         | daemon spawn orchestration    |
| worker target contains spaces                      | repository/install path -> `target()`      | Windows wrapper serialization |

## 7. Invariants

| ID  | Invariant                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OT  | Remote annotated peeled commit must equal root gitlink; missing/lightweight/mismatch fail closed.                                            |
| ML  | Live owner wins; one contender moves dead lock to immutable `stale-<old-token>`; transient retry repeats only that rename.                   |
| TU  | One exit action occurs only after visible input readiness and after exit subscription.                                                       |
| DA  | Before lock, one wrapper owns exact worker PID/exit/termination; after lock, the same worker PID/token remains healthy beyond launcher exit. |
| CL  | Cleanup awaits isolated PTY/daemon death and cannot replace an existing scenario error.                                                      |
| FW  | `FileWatcher.init()` returns only after its one-time native subscriptions are ready; production callers decide whether init is detached.     |
| IT  | Windows installer tests apply the target environment without first resolving a helper through that target PATH.                              |

## 8. First Divergence and Red Signals

| Invariant | First divergence                                                 | Red-capable feedback                                              |
| --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| OT        | local object lookup is used for a remote release identity        | shallow no-tags Git fixture                                       |
| ML        | first transient result aborts the correct atomic rename          | real PowerShell `FileShare.Read` holder                           |
| TU        | SSE is treated as input readiness and `/exit` needs autocomplete | exact user artifact smoke                                         |
| DA        | direct Windows Bun child remains in parent's kill-on-close job   | real `Daemon.ensure` parent-exit test                             |
| CL        | kills are not awaited before recursive rm                        | exact artifact failure ended as `EBUSY` over earlier attach error |
| FW        | `InstanceState.make` forks its own one-time backend subscribe    | partial package run and published-readiness behavior test         |
| IT        | the shell needs external `env` before the target PATH is applied | partial package run and repeated real Git Bash suite              |

## 9. Responsibility

| Concern                                  | Owner                         | Why                                           |
| ---------------------------------------- | ----------------------------- | --------------------------------------------- |
| remote tag wire refs and expected commit | provenance module             | first Git trust seam                          |
| same-rename bounded retry                | `acquireMaintenanceLease`     | lease orchestration owner                     |
| Windows worker wrapper                   | `Daemon.ensure` spawn adapter | owns election, startup and timeout cleanup    |
| readiness/exit/cleanup order             | artifact harness              | owns test interactions and isolated resources |
| native watcher readiness                 | `FileWatcher` InstanceState   | owns subscription acquisition and finalizer   |
| Windows test environment                 | installer behavior harness    | owns Git Bash process construction            |

## 10. Single Primary Design

1. Resolve exact base+peeled remote tag refs once; require the peeled commit to equal the verifier's gitlink. Do not fetch or try another source.
2. Preserve the existing one-time stale-owner validation. Retry the same token-named rename every 25ms for at most one second only for `EPERM/EACCES/EBUSY`; all other outcomes remain busy/failure. The bound covers the observed 641-876ms Windows sharing lifecycle without adding a second acquisition path.
3. Wait for the public `Ask anything` frame, subscribe to PTY exit, then send Unix SIGINT or one Windows `exit\r`.
4. Wrap only the default Windows spawn implementation in absolute `<SystemRoot>/System32/WindowsPowerShell/v1.0/powershell.exe`. Its fixed encoded script uses one `Start-Process -PassThru`, writes worker PID, waits, and mirrors exit code. It serializes the sole target as `[char]34 + target + [char]34`, rejects embedded quotes, uses hidden mode normally and `-NoNewWindow` for existing print logs. The adapter exposes worker PID, wrapper exit, unref, and kill-worker-then-wrapper so existing `Daemon.ensure` logic and `_setSpawn` tests remain unchanged.
5. Cleanup subscribes before killing PTYs, reads the current isolated lock owner, waits for all deaths, continues remaining cleanup after one step fails, removes the root, then throws scenario error before cleanup error.
6. Await each one-time native watcher `subscribe()` inside `InstanceState.make`; project bootstrap already controls production detachment.
7. On Windows, place quoted `KEY=value` assignment words before `exec /bin/bash`; do not resolve an external `env` binary through the environment being installed.
8. Resolve Solid from actual root/application/plugin/OpenTUI consumers and compare realpaths; do not scan physical `node_modules` layout.

Windows wrapper and Unix direct spawn are supported platform branches, not
fallbacks. `FreeConsole` remains because console Ctrl+C and job membership are
different mechanisms.

## 11. Secondary Path Inventory

| Path                                                           | Classification                          | Disposition        |
| -------------------------------------------------------------- | --------------------------------------- | ------------------ |
| workflow tag fetch/local fallback                              | forbidden fallback                      | reject             |
| delete stale lock/second acquisition algorithm                 | forbidden fallback                      | reject             |
| direct Bun/cmd/second PowerShell attempt after wrapper failure | forbidden fallback                      | reject             |
| repeated TUI input/replacement daemon acceptance               | forbidden fallback                      | reject             |
| force termination of already-failed isolated process           | diagnostic cleanup, no scenario success | preserve boundedly |

## 12. Workaround Removal

- Replace local tag `rev-parse`, immediate transient-rename failure, `/exit` plus separate exit wait, direct Windows Bun spawn, and kill-without-await cleanup.
- Delete the non-canonical exploratory design note before final diff.

## 13. Forward Traceability

| Invariant | File path                    | Behavior test                                                   |
| --------- | ---------------------------- | --------------------------------------------------------------- |
| OT        | provenance module + verifier | matching/mismatch/lightweight/missing shallow fixture           |
| ML        | Server Lock                  | live/dead test and real exclusive-handle test                   |
| TU/CL     | artifact smoke script        | exact user artifact full run; original stage/error evidence     |
| DA        | daemon spawn adapter         | actual space-target launch and parent-exit same-PID health test |

## 14. Reverse Traceability

| Concept                    | Evidence / insufficiency                                              |
| -------------------------- | --------------------------------------------------------------------- |
| remote identity operation  | local shallow ref cannot observe remote tag                           |
| bounded same-rename loop   | immediate conversion aborts observed NT transient error               |
| waiting PowerShell adapter | direct Bun dies with parent; short trampoline loses pre-lock PID/exit |
| native quoted target       | `Start-Process` joins native arguments; observed space-path producer  |
| awaited cleanup            | live ConPTY handles produced observed EBUSY override                  |
| awaited watcher subscribe  | an incomplete InstanceState allowed the first event before readiness  |
| native shell assignments   | external `env` lookup depended on the PATH it was meant to establish  |
| consumer Solid resolution  | physical glob omitted hidden store entries used by Bun resolution     |

## 15. File Plan and Hard Budget

| File                                         | Change                                            |
| -------------------------------------------- | ------------------------------------------------- |
| `docs/plans/ci-gate-platform-race-repair.md` | this compact canonical record                     |
| `script/opentui-provenance.ts`               | one remote identity operation                     |
| `script/verify-opentui-closure.ts`           | consume that operation                            |
| `test/script/opentui-provenance.test.ts`     | shallow identity behavior                         |
| `src/cli/cmd/tui/server-lock.ts`             | same-rename bounded retry                         |
| `src/cli/cmd/tui/daemon.ts`                  | Windows waiting process adapter                   |
| `test/cli/tui/daemon.test.ts`                | lease, space target and parent lifetime behavior  |
| `script/smoke-opentui-artifact.ts`           | input ordering and awaited cleanup                |
| `src/file/watcher.ts`                        | await native subscription readiness               |
| `test/file/watcher.test.ts`                  | CI-executed acquisition failure behavior          |
| `test/installation/install-script.test.ts`   | self-contained Windows shell environment          |
| `test/cli/tui/maintenance-retry-worker.ts`   | deterministic transient-conflict process boundary |

Hard limit: 12 task files; implementation additions under 1200 lines with
documentation excluded as explicitly authorized. No workflow or thread-test change.

## 16. TDD Slices

1. Shallow fixture red -> matching annotated identity green -> mismatch/lightweight/missing remain red.
2. Real Windows handle proves the transient error class; a published worker marker then drives public lease conflict -> release -> same-tombstone retry green without a timing guess.
3. Space-target wrapper red on direct adapter -> quoted target green.
4. Parent-exit daemon red -> waiting wrapper preserves same worker/lock health green.
5. Exact artifact bootstrap red -> input-ready exit -> full Session/Goal/CJK/resize/model/stop green.
6. Partial package watcher red -> await subscription -> full suite and ten independent-process repeats green.
7. Partial package installer red -> native assignment words -> full suite and ten repeated profile cases green.

## 17. Chinese Comment Budget

The first implementation audit measured `E=594`, `C=40`, and required 90. Round
two measured `E=618`, `C=102`, required 93. The final independent recount includes
the deterministic worker: `E=673`, `C=104`, required 101, ratio 15.45%.

## 18. Verification

- From `packages/opencode`: focused provenance, maintenance, space-target and parent-exit tests; full daemon/thread/watcher/installer suites; related OpenTUI consumers; exact artifact smoke; `bun typecheck`; task-file Prettier/oxlint.
- Run full closure only in an initialized submodule graph. This checkout reaches and passes package/Solid/remote-tag checks, then accurately fails because `thirdparty/opentui` is not initialized.
- Do not repeat the approximately 40-minute full package run; use its two captured failures as targeted regressions per the latest user direction.
- Inspect task-only diff for the 12-file/1200-line budget and exclude update/generated paths.

## 19. Diff Budget

12 task files including one document; 959 implementation/test additions and
230 deletions at final round-three pre-audit count. Generated model/SDK output is excluded.

## 20. Risks and Rejected Speculation

- Real risk: native target quoting. The actual space-path process test is mandatory.
- Real risk: wrapper authority changes at lock publication. Parent-exit test must assert the original lock PID, not merely any daemon.
- Rejected: extra workflow probe, launch ID/schema, fourth parser/launcher, longer timeout, tracked package-source changes and build-source changes.
- Open user decisions: none.

## 21. Audit Contract Override

Three full plan audits were completed. The latest user instruction explicitly
withdraws the approval requirement and directs implementation after careful
primary-agent review. No fourth plan audit will be requested.

## 22. Plan Audit Record

| Round | Revision | Blocking findings                                                                                          | Result |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| 1     | R1       | untrusted Project trampoline; unsupported lease revalidation; missing cleanup probe; missing mismatch test | BLOCK  |
| 2     | R2       | lost pre-lock worker observation; missing workflow structure check                                         | BLOCK  |
| 3     | R3       | unspecified safe native serialization for worker paths containing spaces                                   | BLOCK  |

R4 resolved round-three behavior with a fixed encoded script, explicit native
quote data contract and actual space-target test. It removes the workflow probe
expansion under the user's 8-file/core-only constraint; the observed cleanup
path remains repaired and is verified by the exact artifact loop.

R5 records only later observed evidence and authorized scope: actual consumer
resolution, watcher readiness, Git Bash environment construction, and the
12-file/1200-line budget. It does not add a fallback or a workflow branch.

## 23. Implementation Evidence

| Verification                                                     | Result                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provenance shallow matching/mismatch/lightweight/missing fixture | 1 pass, 5 expectations                                                                                                                                                                   |
| `daemon.test.ts`                                                 | 26 pass, 72 expectations, including real sharing code, deterministic retry marker, space target, 1 MB stdout drain and launcher exit                                                     |
| `thread.test.ts`                                                 | 19 pass, 52 expectations                                                                                                                                                                 |
| `watcher.test.ts`                                                | 6 pass, 1 platform skip; covers normal non-git readiness and native acquisition failure propagation                                                                                      |
| `install-script.test.ts`                                         | 4 pass, 1 Windows-inapplicable skip; profile case passed 10 repeated runs                                                                                                                |
| OpenTUI consumer regression command from workflow                | 8 pass, 28 expectations                                                                                                                                                                  |
| ten Solid ecosystem package typechecks                           | all pass                                                                                                                                                                                 |
| package `bun typecheck` and task Prettier                        | pass                                                                                                                                                                                     |
| task oxlint                                                      | 0 errors; 28 pre-existing/style warnings retained without broad cleanup                                                                                                                  |
| final Windows build                                              | pass; `opencode-windows-x64`, 148072960 bytes, SHA256 `800724cb9673eae2a414e0445ea765c9765cb3a69bfeac6201609269128996a6`                                                                 |
| built native evidence                                            | SMARK `0.4.3-smark.1`, `opentui.dll`, SHA256 `6b9ad9050a7969c589e6d34e4646111787276a2508e38676e67fbbc7b017273d`                                                                          |
| final compiled artifact smoke                                    | pass; same daemon, Session/Goal persistence, CJK resize/restore, 2 model requests, two graceful TUI exits, public daemon stop and outer root cleanup                                     |
| full package run                                                 | deliberately not repeated; user stopped the 14-minute partial run and directed targeted verification because full duration is about 40 minutes                                           |
| local full closure                                               | package graph, one Solid realpath and remote annotated-tag identity pass; final nested-head check unavailable because the submodule is uninitialized locally; CI initializes recursively |

Workarounds removed: local tag-object lookup, immediate transient-rename abort,
SSE-as-input-readiness, separate subscribe-after-exit wait, direct Windows Bun
daemon spawn, undrained wrapper output, uncancelled PID timer, cleanup abort after
first error, forked one-time watcher subscribe, and external `env` bootstrap.

## 24. Implementation Audit Record

| Round | Revision | Blocking findings                                                                                                                 | Result  |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | R5       | 225ms maintenance window failed under real sharing load; watcher acquisition cause was cached as success; Chinese comments 40/594 | BLOCK   |
| 2     | R5       | watcher acquisition behavior was skipped when `CI=1`; maintenance release used a fixed 50ms scheduling guess                      | BLOCK   |
| 3     | R5       | No blocking findings; affected interface 64 pass, CI watcher executed, deterministic retry x10, E=673/C=104                       | APPROVE |

Round-two corrections remove CI as a watcher skip condition and split
maintenance evidence into a real Windows error-class probe plus a deterministic
public-API worker marker. No production test hook, elapsed-time assertion or
retry-count assertion was added. Round three independently inspected the full
12-file R5 worktree, including the untracked worker, and returned `APPROVE` with
no blocking findings.
