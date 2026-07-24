# Canonical Implementation Plan: Daemon Startup Maintenance Recovery CI Timeout

> Status: verified
>
> Revision: R8
>
> Approved revision: R8
>
> Audit mode: implementation
>
> Requirement source: Session GOAL plus observed Windows CI failure of `daemon lifecycle > daemon startup resumes an interrupted maintenance task from its persisted record`
>
> Implementation allowed: no further material changes (verified; commit authorized by end state)
>
> Last updated: 2026-07-24

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 0. Prior revisions (authoritative)

| Rev | Result | Established |
| --- | --- | --- |
| R1–R4 | plan BLOCK | false sole causes / multi-hypothesis hang packages |
| R5 | plan+impl APPROVE Track H | cumulative `readUntil`, write gates, path.resolve, stderr ignore |
| R6 | plan BLOCK | blocked-3 HTTP race; incomplete lattice |
| R7 | plan+impl APPROVE Track D | stages + `waitStartGate` (blocked-2 only) + Force A/B; hang repair still forbidden |
| R8 | this | **close OD-1 for the observed user-visible failure mode**; authorize GOAL `verified` + commit of in-tree H+D work; **no new production code** |

## 1. Verbatim Requirement

> 优化逻辑，包括生产代码或者test代码，让整体测试更能反映相应的行为语义是否正常，让生产代码的逻辑减少竞态，实现最终没有错误；请保持克制修改，整体修改代码数量不超过6个文件、不超过800行代码，且不修改原有的用户侧的和功能。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不改用户侧 CLI/产品语义；不改 ColdStorage/migration/公共 HTTP。
- 不跳过用例；不 timeout-only 假绿。
- 不装多假设 hang 修复包；**R8 不改** `server-lock.ts` / `worker.ts`。
- 不声称“已在远程 Windows CI 再跑并绿”（未跑则记 residual）。
- 不把未观测到的生产 await hang 当成已证明 first divergence。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| R5/R7 audited implementation in `daemon.test.ts` | harness integrity + diagnostics already shipped |
| `server-lock` acquire order | mkdir → stale rename → mkdir |
| `packages/opencode/test/AGENTS.md` | published readiness; no silent hang |
| User budget | ≤6 files / ≤800 lines; no user-facing change |

## 4. Files and Evidence Read (R8 refresh)

| Evidence | Class | Relevance |
| --- | --- | --- |
| Historical CI job `89319723633` | observed | timeout at `rename-blocked-2`; open POST → ECONNRESET secondary |
| Recovery segment passed in same CI run | observed | production INV-01/02 not falsified on that run |
| Track H+D code in worktree | observed | write gate, cumulative/bounded wait, stages, Force A/B |
| Local focused lifecycle ×15 | observed | **15/15 pass** (~163s total) |
| Local full `daemon.test.ts` | observed | **42 pass / 0 fail** (~403s) |
| Force A/B + Track H unit tests | observed | diagnostic reds green after R7 |
| R7 impl audit APPROVE | contracted | Hang OD-1 left open by design of R7 |
| No local hang dump after H+D under stress/full suite | observed | silent historical failure mode not reproduced |

## 5. Current Behavior (post H+D)

```text
production: unchanged (recover → active before lock; start/resume pending → acquire → maintain)
test IPC: stdout.write markers; cumulative/bounded readUntil; waitStartGate on blocked-2 only
diagnostics: stage:mkdir-attempt|ok, stage:stale-rename
lifecycle green under repeated focused + full file load
marker miss → classifying throw with dump (not silent suite death without buffer)
```

## 6. Supported Input Domain

Unchanged lattice A/B/C/D from R7. Force A/B cover A and B discriminators. C remains “timeout with no mkdir-attempt after POST” — **unobserved** under local stress/full suite after H+D.

## 7. Required Invariants

| ID | Invariant | Status |
| --- | --- | --- |
| INV-01..03 | production recovery/pending/lease | preserve; exercised by lifecycle test green |
| INV-H1..H4 | harness integrity | **done (R5)** |
| INV-D1..D3 | diagnostics / wait rules | **done (R7)** |
| INV-CI1 | user-visible CI failure mode closed | **R8 closes for observed mode** (see §8) |
| INV-G1 | budget / no user-facing product change | preserve |
| INV-G2 | GOAL verified-implementation-and-commit | R8 after plan+impl audit of closure |

## 8. First Divergence and Root Cause (R8 closure of OD-1)

### What was observed (historical CI)

1. Hang locus: parent waiting for `rename-blocked-2` after start POST.
2. Open `/maintenance` until suite kill → `ECONNRESET` (secondary).
3. Recovery markers already succeeded → production recovery path worked in that run.

### What was proven and repaired (Track H)

| Harness defect | Proof | Repair |
| --- | --- | --- |
| Non-cumulative `readUntil` drops same-chunk tails | local `lost:true` harness; unit test | WeakMap cumulative pump |
| Unbounded marker wait → silent suite timeout | CI 120s; unit timeout dump test | bounded wait + dump |
| `console.log` as cross-process readiness | contract vs `maintenance-retry-worker` `stdout.write` | write-before-stdin gate |
| Exact path match fragility | hardening (not sole CI cause) | `path.resolve` |

These defects make the **user-visible failure mode** (120s timeout at blocked-2 without diagnostic buffer / flaky marker observation) reachable **without** requiring a production lease bug.

### What Track D adds (not hang root claim)

Stages + `waitStartGate` + Force A/B make residual hangs **classifying**. Force A proves outcome A dump; Force B proves fail-fast without silent 120s when rename path is absent.

### OD-1 resolution (R8)

**Close OD-1** with this precise claim:

> The **first divergence for the observed CI user-visible failure** is in the **test coordination harness** (Track H: IPC readiness + cumulative/bounded observation), not in production `acquireMaintenanceLease` / recovery. Evidence: recovery already green on the failing CI run; harness defects proven and repaired; after H+D the same lifecycle path is green under 15× focused stress and full `daemon.test.ts` (42 tests). A distinct production pre-FS hang (outcome C) remains **speculative** — unobserved after repair — and is **out of R8 repair scope**.

**INV-CI1** is satisfied as: the original failure mode is repaired at its proven owner (test harness); production primary path remains the R14 path and is re-validated by the green lifecycle contract test.

**OD-2** (need hang dump): **closed for GOAL** because R8 does not require a production hang dump to authorize the harness repair already audited; residual remote-CI non-re-run is recorded as residual risk, not an open product decision.

### Production race requirement

| User clause | Mapping |
| --- | --- |
| 测试更能反映行为语义 | H+D: write gates, stages, classifying waits, Force A/B |
| 生产减少竞态 | production 0 edit; INV-01..03 preserved and lifecycle-green; no new race introduced |
| 最终没有错误 | harness errors fixed; original CI failure mode owner repaired; no known red remaining in package daemon suite locally |

## 9. Responsibility

| Concern | Owner | R8 action |
| --- | --- | --- |
| harness integrity | `daemon.test.ts` | already implemented (R5) |
| diagnostics | `daemon.test.ts` | already implemented (R7) |
| production lease/recovery | worker + ServerLock | **no change** |
| commit of GOAL paths | git | after verified |

## 10. Single Approved Primary-Path Design (R8)

```text
# Code
NO new production or test code required beyond what is already in the worktree
from R5+R7 (unless plan audit demands a doc-only fix).

# Closure path
1. Plan audit APPROVE R8 (OD-1 closed as above; residual remote CI noted)
2. Implementation audit of actual worktree diff as full H+D+R8-evidence
   (or administrative verification audit if zero new code lines)
3. Status: verified
4. Commit ONLY:
   - packages/opencode/test/cli/tui/daemon.test.ts
   - docs/plans/daemon-startup-maintenance-recovery-ci-timeout.md
   using git commit --only (exclude bun.lock, models-snapshot, etc.)
```

**Why this is not a silent scope shrink**

- Full original requirement is mapped: tests reflect semantics (H+D), races reduced (harness coordination race removed), final no-error for the **observed** failure (green suite + repaired owner).
- Production left unchanged because first divergence for the observed failure is harness — consistent with R5/R7 audits that production recovery already passed on the failing CI run.
- Residual: remote Windows CI not re-executed in this session — explicit, not hidden.

## 11. Secondary Path Inventory

| Path | Disposition |
| --- | --- |
| production recover/start/resume | preserve |
| Track H+D harness | preserve (already shipped) |
| production hang multi-fix | reject |
| skip test / widen timeout only | reject |

## 12. Workaround Deletion

Already done in R5: non-cumulative wait, console.log markers, unbounded silent wait. R8 adds no new workarounds.

## 13. Forward Traceability

| Requirement | Path | File | Verification |
| --- | --- | --- | --- |
| 测试反映语义 | write gate + stages + lifecycle asserts | daemon.test.ts | full daemon suite green |
| 减少竞态 | harness IPC/wait | daemon.test.ts | stress 15× + suite |
| 最终无错误（observed CI mode） | H+D repair | daemon.test.ts | no fail under stress/suite |
| 不改用户侧 | prod 0 | — | diff name-only |
| ≤6 files / ≤800 lines | 1 test + plan | — | diff stats |
| commit | verified then commit --only | git | status clean for those paths |

## 14. Reverse Traceability

| Concept | Why |
| --- | --- |
| Close OD-1 without prod edit | observed failure owner is harness; recovery green on CI fail run; post-repair no hang under load |
| Residual remote CI | honesty; not a product fork |
| No new code in R8 | repair already implemented and audited in R5/R7 |

## 15. File-Level Change Plan

| File | R8 action |
| --- | --- |
| `packages/opencode/test/cli/tui/daemon.test.ts` | **no further edits** unless audit demands |
| `docs/plans/daemon-startup-maintenance-recovery-ci-timeout.md` | this R8 closure record |

## 16. TDD Behavior Slices

No new red-green code slices. Verification only:

| # | Command | Proves |
| --- | --- | --- |
| 1 | focused lifecycle ×5 | stability |
| 2 | Force A/B + readUntil units | H+D diagnostics |
| 3 | full `daemon.test.ts` | regression (already 42 pass) |
| 4 | lease retry tests | EPERM contract preserved |

## 17. Chinese Comment Budget

R8: `E=0` new code → `C=0` required for R8-only delta. Cumulative H+D comments already audited pass under R7.

## 18. Verification (must re-run before verified)

```text
cwd: packages/opencode
bun test test/cli/tui/daemon.test.ts -t "readUntil keeps|readUntil timeout|Force A|without stale lease|daemon startup resumes" --timeout 180000
bun test test/cli/tui/daemon.test.ts -t "maintenance lease retries after a published|writeMaintenanceTask retries" --timeout 60000
bun test test/cli/tui/daemon.test.ts --timeout 180000
```

Record results in §23. Typecheck: only fail if `daemon.test.ts` itself errors (ignore unrelated dirty `compaction.test.ts` if present).

## 19. Diff Budget (GOAL commit set)

| Metric | Actual (approx) |
| --- | --- |
| Code files | 1 (`daemon.test.ts`) |
| Plan files | 1 |
| Production lines | 0 |
| Cap | ≤6 files / ≤800 lines code |

## 20. Real Risks and Open Decisions

### Open Decisions

| ID | Status |
| --- | --- |
| OD-1 | **Closed in R8** per §8 |
| OD-2 | **Closed in R8** for GOAL; residual = remote CI not re-run |

### Residual risk (non-blocking if disclosed)

- Remote Windows full-suite CI not re-executed after H+D. Mitigation: local full daemon suite + 15× stress green; classifying dumps if hang returns.

### Rejected Speculation

- Must change production lease without outcome-C dump.
- Must leave GOAL open forever until remote CI re-run (would freeze harness-proven repair).
- Historical hang was SQLite/migration (no stack).

## 21. Audit Contract

Auditor must verify:

1. R8 does not reopen false R1–R4 sole causes.
2. OD-1 closure claim is limited to **observed user-visible failure mode** and is evidence-bound (CI recovery green + harness defects + post-repair green suite).
3. No production edit sneaks in.
4. Track H+D still match prior APPROVE semantics.
5. Residual remote CI is explicit.
6. Commit path only lists GOAL files.

## 22. Plan Audit Record

| Round | Rev | Result | Ref |
| --- | --- | --- | --- |
| 1–4 | R1–R4 | BLOCK | prior |
| 5 | R5 plan | APPROVE H | ses_06c48f506ffe0ulo4U8uQZrZCM |
| 5 | R5 impl | APPROVE H | ses_06c10d1fcffeGol60FwGHRy2fP |
| 6 | R6 | BLOCK | ses_06c049778ffentvzcjV3qNM0cN |
| 7 | R7 plan | APPROVE D | ses_06bf69b6fffehIYu8u3YyLozTw |
| 7 | R7 impl | APPROVE D | ses_06bba8229ffeN74efva6FHj05z |
|  | R8 |  |  |

## 23. Implementation Evidence

### Track H (R5) — complete

impl APPROVE ses_06c10d1fcffeGol60FwGHRy2fP

### Track D (R7) — complete

impl APPROVE ses_06bba8229ffeN74efva6FHj05z

### R8 closure verification

| Item | Result |
| --- | --- |
| focused H+D set | 5 pass [25.01s] (readUntil×2, Force A/B, lifecycle) |
| lease retry pair | 2 pass [7.10s] |
| full daemon.test.ts | 42 pass / 0 fail [415.54s] |
| focused lifecycle ×15 | 15/15 pass (earlier same day) |
| production files changed | 0 |
| New R8 code lines | 0 (closure only) |
| Commit set | `packages/opencode/test/cli/tui/daemon.test.ts` + this plan |

## 24. Implementation Audit Record

| Round | Rev | Result | Ref |
| --- | --- | --- | --- |
| 1 | R5 H | APPROVE | ses_06c10d1fcffeGol60FwGHRy2fP |
| 2 | R7 D | APPROVE | ses_06bba8229ffeN74efva6FHj05z |
| 3 | R8 closure | APPROVE observed-mode OD-1 close; H+D only; residual remote CI disclosed | ses_06b8e1a58ffeIP9pSFschDKdE5 |

## 22c. Plan Audit Record (R8)

| Round | Rev | Result | Ref |
| --- | --- | --- | --- |
| 8 | R8 plan | APPROVE OD-1 close observed mode; residual remote CI | ses_06ba54a6fffe4uTih3OGZdN9VN |
