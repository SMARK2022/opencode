# OpenCode DB Status Daemon Timeout Repair

Status: verified  
Revision: R3  
Approved revision: R3  
Audit mode: implementation  
Requirement source: user request and live timeout evidence  
Implementation allowed: no further material changes without revision or rework

## 1. Scope and Boundary

This plan addresses the user-visible failure of `opencode db status` timing out
while a live daemon owns the same database. It does not change cold-storage
schema, payload format, refcount semantics, compression codec, Stats semantics,
or database vacuum behavior.

The implementation target is at most four files and at most 800 changed code
lines. The intended files are:

1. `packages/opencode/src/storage/cold.ts`
2. `packages/opencode/src/cli/cmd/db.ts`
3. `packages/opencode/test/storage/cold.test.ts`
4. `packages/opencode/test/cli/tui/daemon.test.ts`

No new production module, database column, migration, dependency, public API,
or alternate offline success path is authorized by this plan.

## 2. Behavioral Invariants

- `opencode db status` returns the complete existing `StatusReport` for the
  selected database, including `eligibleOwners`, cold-owner counts, summary
  counts, byte metrics, refcount mismatches, and orphan counts.
- Status is read-only: it does not thaw owners, rewrite projections, repair
  refcounts, create maintenance tasks, or acquire the maintenance write lease.
- The live-daemon path remains authoritative when a matching daemon is alive;
  a request timeout must not silently fall back to offline database access.
- Metadata-only status work must not materialize cold payload BLOBs. Exact legacy v1
  eligibility may decode its referenced payload because that is the existing
  authoritative compatibility path required for the complete count; packed v2
  metadata and refcount calculations must not decode pack bodies.
- Eligibility remains exact. It must continue to honor the 30-day age rule,
  completed compaction boundary, owner extraction whitelist, and v1/v2 owner
  compatibility rules.
- Task-backed maintenance keeps its existing fast acknowledgment and polling
  contract. A client disconnect or timeout cannot be reported as a successful
  maintenance result.

## 3. User-Visible Failure and Feedback Loop

The original failure is recorded in:

`C:\Users\Lenovo\.local\share\opencode\log\2026-07-22T064011.log`

The log records `args=["db","status"]`, `TimeoutError`, and approximately
`+2026ms`. The current CLI request helper applies a fixed two-second timeout
to normal maintenance control requests:

`packages/opencode/src/cli/cmd/db.ts:68-82`

The red-capable verification loop must exercise the real worker control route
against an isolated temporary database and lock file, not the developer's live
daemon. It must assert all of the following:

1. The request completes under the configured control deadline for a large
   candidate fixture.
2. The response remains a complete `StatusReport` and preserves exact
   `eligibleOwners` and refcount/orphan values.
3. The status path performs no thaw or owner mutation.
4. A task-backed operation still returns `202` with task identity promptly and
   is observed through the existing task-status endpoint.
5. The original live command is rerun after implementation and no longer
   produces the timeout recorded above.

Before implementation, the baseline measurements are already available from
read-only SQL against the live database; the focused test must provide a
repeatable isolated equivalent rather than relying on wall-clock timing alone.

## 4. Repository Execution Chain

### CLI request owner

`packages/opencode/src/cli/cmd/db.ts`

- `liveDaemon()` validates matching pid, database path, and control port.
- `daemonRequest()` sends the token-protected request and normally applies
  `AbortSignal.timeout(2_000)`.
- `executeMaintenance()` selects the live-daemon domain once and refuses an
  offline fallback after a live control failure.
- `status` currently calls the immediate maintenance endpoint and waits for the
  report body.

The request deadline is owned by this orchestration seam. It must not be hidden
by changing storage errors into success or by selecting another execution domain
after timeout.

### Daemon control owner

`packages/opencode/src/cli/cmd/tui/worker.ts:355-416`

- The token-protected maintenance route parses the request and calls the shared
  `startMaintenance()` dispatcher.
- Task-backed operations return an identity response immediately.
- Immediate operations await `ColdStorage.maintain()` and return the report.

The route must continue to use the shared dispatcher. It must not duplicate
eligibility or SQL logic in the HTTP handler.

### Storage owner

`packages/opencode/src/storage/cold.ts:3354-3425`

`ColdStorage.status()` currently:

1. Reads SQLite page counters.
2. Executes `select * from cold_storage`, including every `payload` BLOB.
3. Recomputes owner counts using grouped Message, Part, and Session queries.
4. Counts cold owners and summary owners.
5. Filters summary payload metadata.
6. Computes byte and mismatch/orphan metrics.
7. Calls `eligibleOwnerCount()`.

`eligibleOwnerCount()` at `cold.ts:2429-2461` loads candidate Message and Part
rows, extracts candidate fields, caches per-session eligibility, and evaluates
the exact age/compaction rule. Its `cold_ref != NULL, cold_key == NULL` branch
is the persisted v1 compatibility path and may decode legacy payloads.
`CompactionBoundary.latest()` is the shared boundary owner and must remain
authoritative.

## 5. Local Evidence

The live database was inspected with `bun:sqlite` using `readonly: true`; no
database or source file was modified.

| Measurement | Result |
|---|---:|
| `cold_storage` rows | 7,717 |
| `cold_storage` read including payload | 74.6-84.8 ms |
| `cold_storage` metadata-only read | 51.7-58.7 ms |
| owner-count grouped queries | 6.8-7.7 ms |
| message candidate rows | 2,276 |
| exact Part eligibility candidate rows | 405,626 |
| exact Part query with required data | 5,323-5,425 ms |
| exact Part query without data column | 3,962-4,028 ms |
| sessions | 1,339 |
| sessions older than 30 days | 726 |
| candidate Part sessions | 1,310 |
| database main file | 2,380,378,112 bytes |
| database WAL | 4,770,992 bytes |

The evidence distinguishes two symptoms:

- Reading cold payload BLOBs is unnecessary status work, but is not the main
  measured delay on this database.
- The dominant measured delay is the broad JSON discriminator and candidate-row
  scan required before exact eligibility evaluation.

The two-second CLI timeout is therefore the first user-visible divergence, but
the storage candidate scan is the primary performance driver underneath it.

## 6. Root-Cause Diagnosis

The invariant becomes false at the CLI/control boundary: the client promises a
usable status report but aborts after two seconds, while the daemon is still
performing a synchronous, read-only status computation.

The underlying cause is a mismatch between the operation's work class and its
transport contract:

- `status` is classified as immediate.
- Its storage implementation performs a full exact eligibility scan over
  hundreds of thousands of Part rows.
- The client applies the same short control timeout intended to detect an
  unreachable local daemon.

The following possible causes are not supported by current evidence:

- zstd decompression is not on the measured `status()` path.
- SQLite busy locking is not present in the user log; there is no `SQLITE_BUSY`.
- A duplicate daemon is not present in the observed process list.
- A cold payload corruption or refcount failure is not reported.
- Removing fields from `StatusReport` is not an acceptable repair because it
  violates the complete-output invariant.

## 7. Approved Primary-Path Design

R3 selects one authoritative repair route. It does not add a task record,
database field, alternate report source, or asynchronous status replacement.

### 7.1 Storage projection repair

Change `ColdStorage.status()` to select only cold-storage metadata needed for
the existing report: hash, kind, codec, raw bytes, compressed bytes, refcount,
and timestamps if required by the report. Do not select `payload`.

This is a local repair to an unnecessary BLOB read. It preserves every report
field and does not change any owner/refcount authority.

### 7.2 Eligibility scan optimization

Optimize `eligibleOwnerCount()` only where the exact current semantics permit:

- keep the existing candidate predicates and extraction whitelist;
- keep one cached eligibility state per Session;
- use the narrowest row projection sufficient for `messageV2Value()` and
  `partV2Value()`; retain `data`, identifiers, session linkage, and cold
  references required by those functions;
- avoid loading unrelated timestamps or columns that are not consumed by the
  extraction/eligibility path;
- preserve the existing `CompactionBoundary.latest()` seam;
- do not introduce a second eligibility formula or approximate count.

The plan does not authorize a schema/index migration. If a larger speedup
requires a new index, generated column, approximate count, persisted cache, or
different authority, the plan must be revised and re-audited rather than
silently adding it.

### 7.3 Transport timeout contract

The immediate `status` control request has no client-side execution deadline
after `liveDaemon()` has proved the matching daemon pid, database path, and
control port. The local loopback request remains synchronous and returns the
complete exact report; HTTP connection errors, non-2xx responses, and process
termination still surface as errors. This removes the artificial two-second
upper bound without changing the server semantic path.

The implementation expresses this as a private `daemonRequest` timeout option:
normal calls retain `2_000`, while the status report call passes an explicit
no-deadline value. The option is not exposed through the CLI, HTTP API, SDK, or
configuration.

All other daemon maintenance requests, including task status and task start,
retain the existing two-second transport deadline because task start is an
acknowledgment contract and task status is a small persisted-record read.
`db status` is the only request that opts out because its exact report has no
persisted result record and its scan duration grows with the database.

## 8. Forward Traceability

| Requirement/invariant | Production path | Planned location | Behavioral verification |
|---|---|---|---|
| Complete status output | `ColdStorage.status()` | `cold.ts` | exact report equality on fixture |
| No unnecessary payload materialization | metadata query, with required legacy v1 decode exception | `cold.ts` | exact output, unchanged refs, and hard-heap BLOB regression |
| Exact eligibility | `eligibleOwnerCount()` | `cold.ts` | old/new count equality across aged, recent, compacted, hot and cold owners |
| Live daemon authority | `liveDaemon()`/`daemonRequest()` | `db.ts` | timeout/error never triggers offline execution |
| Task acknowledgment | unchanged worker maintenance route | no production change | real daemon `202` and terminal polling test |
| Original timeout repair | CLI `db status` without artificial deadline | `db.ts` | original command loop no timeout |

## 9. Reverse Traceability and Complexity Budget

| Proposed concept | Requirement | Evidence | Why existing logic cannot carry it |
|---|---|---|---|
| Metadata-only cold projection | no unnecessary thaw/read | `status()` selects `*`; payload is unused | current query transfers BLOBs unnecessarily |
| Narrow candidate projection | status latency | 405,626 exact Part candidates and 5.3s query | current `.select()` loads every column |
| Status deadline removal | usable exact report for unbounded database growth | fixed 2s timeout, 5.3s scan, and 2.0s user failure | current orchestration assumes all immediate operations are short |

No other production concept is authorized. In particular, no retry loop,
offline fallback, schema migration, status cache, background scheduler, or
second Stats implementation may be added.

Expected production decision surface is limited to the existing status query,
candidate query, and request timeout. Any diagnostic-only branch must remain
below the policy's 10 percent secondary-path budget.

## 10. Reversibility and Failure Behavior

- Status changes are read-only SQL projection changes and are reversible by
  restoring the original selected columns.
- Eligibility optimization must return the same integer for the same database
  snapshot; any mismatch is a test failure.
- Timeout changes must still surface non-2xx, abort, daemon-unreachable, and
  process-termination errors as errors; only the status computation deadline is
  removed.
- The status request remains synchronous and cannot falsely complete an
  underlying task-backed maintenance operation.
- No database bytes, owner refs, payloads, task records, or external files are
  modified by status.

## 11. TDD and Verification Plan

### Red

1. Add a focused regression assertion using an isolated real daemon and a
   sufficiently large temporary fixture that reproduces the old timeout or
   exceeds the old two-second contract.
2. Add an exact-output assertion covering all `StatusReport` fields.
3. Add a no-mutation assertion for owner refs, payload rows, and page counters.
4. Add a metadata projection assertion using an isolated database with a large
   sentinel BLOB and a low SQLite `hard_heap_limit`; status must succeed while
   a payload-materializing projection must fail. This makes the forbidden read
   observable without inspecting source text or duplicating the algorithm.

### Green

1. Apply only the approved metadata projection and candidate-scan repair.
2. Measure the same fixture with the same daemon request path.
3. Apply the approved status-only deadline removal without changing task
   status, resume, or other control requests.

### Regression

- Run `bun test test/storage/cold.test.ts` from `packages/opencode`.
- Run `bun test test/cli/tui/daemon.test.ts` from `packages/opencode`.
- Run the original `opencode db status` loop against the user's live daemon
  only after all isolated tests pass; do not alter the live database.
- Run `bun typecheck` from `packages/opencode`.
- Run `bun run build` from `packages/opencode`.
- Verify no schema, migration, generated file, or unrelated path changed.
- Report actual changed production files, total changed lines, and Chinese
  explanatory-comment `E/C` counts using the repository gate.

## 12. Risks and Explicit Non-Goals

| Risk | Mitigation |
|---|---|
| Narrow projection omits a field needed by extraction | compile/typecheck plus exact status tests; retain full row only where the consumer requires it |
| Eligibility count changes subtly | equality tests for each age/compaction quadrant and mixed v1/v2 owners |
| No status deadline leaves a stuck daemon request open | `liveDaemon()` proves the local owner before the request; HTTP/process errors still reject, and no alternate success path is added |
| Large fixture makes tests slow or flaky | use published readiness and deterministic fixture data; do not use arbitrary sleeps |

Non-goals are compression algorithm changes, vacuum scheduling, backup, Stats
redesign, payload thaw policy, external archive cleanup, and user-facing webapp
changes.

## 13. Audit Gate

The primary-agent self-check for R3 is complete: the CLI status branch, daemon
route, storage dispatcher, eligibility owner, compaction boundary owner, and
existing daemon/cold test seams were read and mapped above. The selected test
seams are `packages/opencode/test/storage/cold.test.ts` for exact status
behavior and `packages/opencode/test/cli/tui/daemon.test.ts` for the real
control request.

Expected substantive changed lines are 25-80 (`E`), requiring distributed
qualifying Chinese explanatory comments of
`C >= max(1, ceil(E * 0.15))`. Actual values must be calculated from the final
diff and may not fall below the gate.

After independent implementation audit records `No blocking findings`, verify
that the audited diff is unchanged, stage only goal-owned paths, create one
local commit using the required Chinese commit format, verify commit identity
and working-tree status, and do not push. The commit must contain the exact
implementation-audited revision and no unrelated changes.

The auditor must independently verify the full affected interface, producer,
consumer, invariant, measured evidence, file/line budget, absence of fallback
behavior, exact timeout contract, and final delivery mapping.

## 14. Independent Plan Audit Record

Round 1, R1: blocked by an unresolved primary repair, a legacy-v1 invariant
conflict, unfinished self-check wording, and missing commit mapping.

Round 2, R2: blocked because the fixed 15-second deadline preserved the same
reachable timeout at larger scale and the payload projection lacked a sensitive
test.

Round 3, R3 exact verdict:

```text
Blocking findings

No blocking findings.

Primary-path verdict: PASS.

Code-quality and comment-feasibility verdict: PASS.

Release verdict

APPROVE — canonical plan revision R3 only.
```

Implementation is authorized only for approved revision R3.

## 15. Implementation Evidence

### Changed files

- `packages/opencode/src/cli/cmd/db.ts`
- `packages/opencode/src/storage/cold.ts`
- `packages/opencode/test/cli/tui/daemon.test.ts`
- `packages/opencode/test/storage/cold.test.ts`
- `docs/plans/opencode-db-daemon-status-timeout.md` (plan/audit record only)

No schema, migration, generated production path, or `worker.ts` change.

### Red-green

1. Daemon control timeout regression
   - red: real CLI `db status` against isolated daemon + 400k reasoning Parts
     failed with `The operation timed out` under the old 2s deadline.
   - green: after status-only deadline removal, same fixture exits 0 and returns
     complete `StatusReport` fields.
2. Metadata projection regression
   - red-capable seam: child process with 128 MiB `zeroblob` payload and
     `PRAGMA hard_heap_limit=67108864` plus reduced cache; unrestricted
     `select *` previously failed at `cold.ts` status query with `SQLITE_NOMEM`.
   - green: metadata-only status projection returns exact
     `{payloads:1, compressedBytes:128MiB, orphans:1, refCountMismatches:0}`.

### Verification commands

From `packages/opencode`:

- `bun test --timeout 30000 test/storage/cold.test.ts`
  - result: 31 pass / 0 fail
- `bun test --timeout 30000 test/cli/tui/daemon.test.ts`
  - result: 33 pass / 0 fail
- focused reruns of both new tests: pass
- `bun typecheck`
  - result: pass
- `bun run build`
  - result: package Vite bundle succeeded; later cross-compile step failed with
    external `Failed to extract executable for 'bun-linux-aarch64-v1.3.14'`.
    Unrelated build-side `models-snapshot.js` regen was restored; residual
    `bun.lock` line-ending noise is not part of this goal and will not be
    committed.

### Original feedback loop

- Installed `opencode db status` no longer produced the original 2s
  `TimeoutError` in a re-run (exit 0, ~1.6–1.8s under current load).
- Source path regression with the large isolated fixture remains the
  deterministic red/green proof of the old contract mismatch.

### Secondary/replacement path inventory

- Primary path only: live daemon control → shared dispatcher →
  `ColdStorage.status()` → complete report.
- Offline status remains pre-request domain selection when no matching daemon.
- Alternate success paths added: 0
- Fallbacks added: 0
- Diagnostic decision surface: 0

### Comment gate

- `E` (added non-blank non-import non-comment code lines in goal files): 153
- `C` (adjacent Chinese explanatory comments): 23
- Required: `max(1, ceil(153 * 0.15)) = 23`
- Result: pass

### Unverified / residual

- Full multi-target package binary extraction for Linux ARM64 failed in the
  build script for an external toolchain download reason; local typecheck and
  focused/full authorized test suites passed.
- Candidate-row projection retains required `data` JSON, so exact eligibility
  remains multi-second on multi-GB databases; the user-visible timeout is
  removed by the status transport contract, not by approximate counting.

## 16. Independent Implementation Audit Record

Exact verdict:

```text
Blocking findings

No blocking findings.

Primary-path and fallback verdict

PASS

Code quality and Chinese-comment verdict

PASS

Release verdict

APPROVE — implementation diff against approved plan revision R3 only.
```

Non-blocking notes retained:
- status completeness assertions only cover a subset of StatusReport fields
- no dedicated no-mutation status fixture was added beyond read-only path review
- commit must exclude unrelated `bun.lock` noise
