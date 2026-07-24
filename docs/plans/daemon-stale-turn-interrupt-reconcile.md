# Canonical Implementation Plan: Daemon Stale-Turn Interrupt Reconcile

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: session goal + prior diagnosis (verbatim in §1)
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-25
>
> Implementation audit: APPROVE — No blocking findings. Non-blocking: N-01 D/E mid-loop unbounded; N-02 worker order untested at process seam; N-03 orphan mid-scan stop untested; N-04 session.time_updated ranking.
>
> R1 plan audit: BLOCK (B-01 InstanceRef write, B-02 admission race, B-03 exit vs 5s).
> R2 plan audit: BLOCK (B-01 post-lock L1 + publish:false visibility, B-02 worker 15s > CLI STOP 10s).
> R3 plan audit: APPROVE — No blocking findings. Non-blocking: N-01 D/E not wall-clock bounded like C; N-02 orchestration order weakly tested; N-03 exit-full while HTTP up; N-04 cancel usage parity thinner; N-05 INV-07 overstates external-port bypass; N-06 cost model scan-heavy write-light.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，按照如上我们要求的逻辑进行相应修改,按照L1的逻辑进行初始化（最近16个活跃session），然后退出时进行优雅退出，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体修改文件数量控制在8个代码文件以内，同时代码修改不超过1200行。
>
> 目标终态：verified-implementation-and-commit

Supporting product intent from the same investigation thread (not a narrowing):

- After daemon death, users must see interrupted terminal semantics rather than fake streaming / open tools.
- Startup uses L1 light reconcile: recent **16** active sessions.
- Graceful daemon exit performs fuller stale-turn cleanup.
- Reuse existing interrupt semantics (`MessageAbortedError`, tool abort + `metadata.interrupted`).
- Do not auto-resume agent loops.

## 2. Explicit Non-Goals

- Auto-resume / re-enter agent loop after daemon restart.
- Schema migration or generated columns/indexes for `part.state.status`.
- Full-table open-tool SCAN on the **startup critical path**.
- Reviewer-runtime ensuring fix (separate owner).
- Changing multi-daemon / SQLite single-owner rules.
- TUI-only fake interrupted labels without durable DB writes.
- Changing maintenance-task reconcile (already exists).
- Calling `Session.updateMessage` / `updatePart` (default publish) from worker boot/exit.
- Raising worker shutdown above CLI stop wait (breaks force-stop hierarchy).

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Session / Status vs Run state | Status is in-memory; durable truth is Message/Part SQLite. |
| `CONTEXT.md` SMARK daemon | Server Lock + shared daemon is sole DB write owner. |
| `packages/opencode/AGENTS.md` | Effect / InstanceState / AppRuntime conventions. |
| `packages/opencode/test/AGENTS.md` | Package-local tests + tmp isolation. |
| `.opencode/policy/first-principles-engineering.md` | One primary path; repair first divergence at owner. |
| `SessionPrompt.cancel` | Established interrupt terminal contract. |
| `SyncEvent.run` + `publish` option | Durable projectors; `publish:false` skips InstanceRef and bus. |
| `worker.ts` SHUTDOWN_TIMEOUT_MS=5s vs CLI STOP_TIMEOUT_MS=10s | Worker must finish cleanup before CLI force-kill window. |
| `ServerLock.reconcileMaintenanceTask` | Owner-change → interrupted pattern for control plane. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | listen → recovery → lock; gracefulShutdown 5s; hierarchy comment | observed |
| `packages/opencode/src/cli/cmd/daemon.ts` | STOP_TIMEOUT_MS=10_000 then SIGKILL | observed |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | ensure = lock + health only | observed |
| `packages/opencode/src/sync/index.ts:160-166,370` | publish:false skips InstanceRef and bus | observed |
| `packages/opencode/src/session/session.ts:726-745` | updateMessage/updatePart always publish | observed |
| `packages/opencode/src/session/prompt.ts` | cancel interrupt contract; interruptedToolState | reachable |
| `packages/opencode/src/session/processor.ts` | TOOL_ABORTED_ERROR, interruptedToolMetadata | reachable |
| `packages/opencode/src/session/message-v2.ts` | cancelSnapshot hot incomplete detection | reachable |
| `packages/opencode/src/session/projectors.ts` | Durable Message/Part replace | reachable |
| `packages/opencode/src/session/request-usage.ts` | complete(aborted) SQL shape | reachable |
| Live DB ~1.8GB (`~/.local/share/opencode/opencode.db`, 2026-07-25) | incomplete json scan ~400ms; open-tool SCAN ~5.3s; running usage ~1ms; top-16 incomplete ~52ms | observed |
| R1/R2 adversarial audits | prior blocking set | observed |

## 5. Current Behavior

```text
agent loop writes Message/Part early
  -> cancel (live) applies interrupt terminal
  -> process death leaves incomplete assistants / open tools / usage=running
  -> next worker: recoverInterruptedMaintenance only
  -> TUI force-syncs session.messages after server.connected
  -> shows streaming/working; no · interrupted
```

```text
gracefulShutdown (today)
  -> maintenance abort
  -> disposeAllInstances
  -> stop servers, Database.close, clear lock
  -> SHUTDOWN_TIMEOUT_MS = 5000 then process.exit(1)
  -> CLI stop waits 10000 then SIGKILL
  -> no transcript stale-turn sweep
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Incomplete assistant | Crash / incomplete finalize | Single owner after lock | L1 recent (pre-lock); exit-full D | SessionStaleTurn | observed |
| Open tool on incomplete message | Crash mid-tool | Same | L1 if session in top-16; exit-full via message_id | SessionStaleTurn | observed |
| Orphan open tool on completed message | Runtime half-write | Message already terminal | Exit-full budgeted C; residual if budget exhausted | SessionStaleTurn | observed |
| usage status=running | Crash after begin | Separate table | L1 scoped; exit-full E | SessionStaleTurn | observed |
| TUI reconnect after new owner | ensure after lock | First snapshot must already be terminal | L1 **before** lock write | worker orchestration | reachable (R2 B-01) |
| CLI stop force window | stopDaemon 10s | Worker deadline must be shorter | Keep 5s worker; residual-budget exit-full | worker + daemon CLI | contracted (R2 B-02) |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Before `ServerLock.write` makes the owner discoverable, incomplete assistants among the **16** most recently updated sessions are interrupt-terminal (`time.completed` + `MessageAbortedError` when missing). First post-connect `session.messages` snapshot therefore already shows terminal state. | User symptom; R2 B-01; ensure=lock+ping | none |
| INV-02 | Open tools (`pending`/`running`) on those incomplete assistants are closed with abort error + interrupted metadata matching cancel/processor. | TOOL_ABORTED_ERROR | cancel/processor only |
| INV-03 | On graceful shutdown, after dispose and before `Database.close`, residual-budget exit-full runs under **worker** `SHUTDOWN_TIMEOUT_MS=5000` (strictly less than CLI `STOP_TIMEOUT_MS=10000`): prioritize D (all incomplete + their tools) + E (running usage); orphan open tools C only with leftover budget. | R2 B-02; worker comment hierarchy; live D~0.4s / open-tool~5.3s | none |
| INV-04 | Reconcile never auto-starts agent loops. | Non-goal | N/A |
| INV-05 | Idempotent: already-terminal rows unchanged. | Safe re-entry | need test |
| INV-06 | Startup L1 does not full-scan `part` for open tools; uses recent-16 session scope. | Benchmark top-16 ~52ms | need unit scope |
| INV-07 | Live current-owner rows are not false-closed: L1 runs **before** lock admission, so no client agent loop can write yet. Exit-full runs only after dispose. | listen-before-lock; ensure waits for lock | ordering proof + unit |
| INV-08 | Durable writes use `SyncEvent.run(..., { publish: false })` only (no InstanceRef). Visibility is guaranteed by pre-lock L1 + HTTP snapshot, not bus events. | R1 B-01; R2 B-01 | need no-InstanceRef test |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module | Proof |
| --- | --- | --- | --- |
| INV-01/02 | Next owner never applies cancel-equivalent durable terminalization before clients observe the DB | Missing SessionStaleTurn before lock publish | worker only recovers maintenance; ensure admits on lock |
| INV-03 | gracefulShutdown has no residual-budget transcript sweep under the real 5s worker / 10s CLI stack | worker gracefulShutdown | no sweep |
| INV-08 | Session.update* at boot needs InstanceRef; bus publish is unavailable at process owner transition | sync publish default | observed source |

### Red-capable feedback loop

```sh
cd packages/opencode
bun test test/session/stale-turn.test.ts
```

Red before implementation: seed incomplete assistant + open tool + running usage → call reconcile → expect terminal interrupt fields. Module absent today → red.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Why not elsewhere |
| --- | --- | --- | --- | --- |
| Detect stale durable turns | SessionStaleTurn | Scan by scope + residual budget | Transcript domain | Daemon.ensure must not parse messages |
| Apply durable interrupt | SessionStaleTurn via SyncEvent publish:false | Projector writes without InstanceRef | Process owner transition | Session.update* requires InstanceRef |
| Pre-lock L1 + residual-budget exit | worker.ts | Call recent before lock; exit-full after dispose with remaining ms | Only worker owns lock/shutdown | TUI reconnect multi-write risk |
| Live user cancel | SessionPrompt.cancel | Unchanged | Live runners | Not owner-transition |
| CLI force-stop window | daemon.ts STOP_TIMEOUT_MS | Unchanged at 10s | External stop contract | Do not invert by raising worker alone |

## 10. Single Approved Primary-Path Design

### 10.1 Durable write seam

```text
AppRuntime.runPromise(
  SyncEvent.Service.use((sync) =>
    Effect.gen(function* () {
      yield* sync.run(MessageV2.Event.Updated, { sessionID, info }, { publish: false })
      yield* sync.run(MessageV2.Event.PartUpdated, { sessionID, part, time: now }, { publish: false })
    }),
  ),
)
```

- Projectors still run (same SQLite + cold/summary contract).
- `publish: false` skips InstanceState.context and bus.
- **Forbidden:** `Session.updateMessage` / `updatePart` as currently implemented.
- Usage: direct Database update mirroring `RequestUsage.complete` (`status: "aborted"`, `time_completed`, `time_updated`).
- Visibility: **not** bus; first client snapshot after lock sees pre-reconciled rows (INV-01).

### 10.2 Algorithm

```text
reconcile(scope, opts)
  scope = recent(16) | exit-full
  opts.budgetMs?: number  // exit-full only; wall-clock cap for this call

  recent(16):
    session IDs = ORDER BY session.time_updated DESC, id DESC LIMIT 16
    include children (parent_id in set)
    for each session:
      incomplete assistants (!time.completed):
        open tools on that message -> error + TOOL_ABORTED_ERROR + interrupted metadata + time.end
        assistant.time.completed = now
        assistant.error ??= MessageAbortedError({ message: "Aborted" }).toObject()
        empty parts -> hidden.repair-empty-dangling-assistant
      request_usage status=running for session -> aborted

  exit-full (after dispose):
    deadline = now + opts.budgetMs
    D: all incomplete assistants + open tools via message_id index
       (json_extract incomplete scan; measured ~400ms on 1.8GB DB)
    E: all request_usage status=running (~ms)
    C: if time remains before deadline:
         orphan open tools (open tool AND parent message completed)
         budgeted SCAN using remaining ms (cap ORPHAN_TOOL_SCAN_BUDGET_MS=2000)
         tool-only terminalization; on budget timeout log and stop
    if budgetMs already exhausted before D: skip entire exit-full (log); residual → next L1

  idempotent skip of already-terminal rows
```

### 10.3 Startup L1 (repairs R2 B-01)

```text
Server.listen + control + recoverInterruptedMaintenance
  // exclusive: lock not published; ensure cannot admit clients yet
  SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })
  ServerLock.write(...)   // only now discoverable / healthy
  idle timers
```

Safety (INV-07): no external client can obtain lock+health before L1 finishes. No `ownerStartMs` watermark is required on the startup path.

Latency (INV-06): top-16 session-scoped incomplete path measured ~52ms on live DB.

### 10.4 Graceful exit (repairs R2 B-02)

```text
// KEEP hierarchy: worker 5s < CLI stop 10s (worker.ts comment; daemon.ts STOP_TIMEOUT_MS)
SHUTDOWN_TIMEOUT_MS = 5_000   // unchanged
SAFETY_MARGIN_MS = 500        // reserve for stop servers + Database.close + clear lock

gracefulShutdown:
  t0 = Date.now()
  maintenance abort/wait
  disposeAllInstances()
  remaining = SHUTDOWN_TIMEOUT_MS - (Date.now() - t0) - SAFETY_MARGIN_MS
  if remaining > 0:
    SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: remaining })
  stop servers, Database.close, clear lock
```

Cost model (observed on ~1.8GB DB):

| Step | Work | Observed |
| --- | --- | --- |
| D | incomplete assistants (json) + tools by message_id | ~0.4s count+scan |
| E | usage status=running | ~1ms |
| C | full open-tool SCAN | ~5.3s unbounded; **cap ≤ min(2000, remaining)** |

Under a healthy dispose, D+E fit; C is best-effort. If dispose consumes the budget, exit-full is skipped and next startup L1 covers top-16 (accepted residual for sessions outside top-16 / orphans).

**Terminal values (match cancel/processor):**

- Tool: same shape as `interruptedToolState` in `prompt.ts` (status error, TOOL_ABORTED_ERROR, interruptedToolMetadata, time.start/end). Inline this shape in stale-turn; do not export private prompt helpers.
- Assistant: `time.completed=now`, `error ??= MessageAbortedError({ message: "Aborted" }).toObject()`, empty → hidden repair.
- Usage: `status:"aborted"` fields aligned with `RequestUsage.complete`.

**Constants:** `RECENT_ACTIVE_SESSION_LIMIT=16`, `ORPHAN_TOOL_SCAN_BUDGET_MS=2000`, `SHUTDOWN_TIMEOUT_MS=5000` (unchanged), `SAFETY_MARGIN_MS=500`.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Decision |
| --- | --- | --- |
| SessionStaleTurn recent pre-lock / residual-budget exit-full | primary owner-transition path | add |
| SyncEvent.run publish:false | primary write seam | required |
| Live cancel / processor ensuring / maintenance reconcile | separate existing contracts | preserve |
| Session.update* at boot | non-executable | reject |
| Post-lock L1 relying on bus/snapshot refresh | non-executable visibility | reject (R2 B-01) |
| Worker deadline ≥ CLI STOP | breaks force hierarchy | reject (R2 B-02) |
| Unbounded exit open-tool SCAN | non-executable under 5s | reject |
| TUI-only interrupted label | forbidden fallback | reject |
| Auto-resume agent loop | forbidden | reject |

## 12. Workaround Deletion and Replacement

| Item | Disposition |
| --- | --- |
| Relying only on LLM projection for open-tool interrupt text | Keep as concurrent-read defense; durable reconcile is the repair |
| Missing owner-transition cleanup | Add SessionStaleTurn |
| Post-lock watermark as admission safety | Superseded by pre-lock L1; do not implement ownerStartMs on startup |

## 13. Forward Traceability

| Req / INV | Path | Files | Test |
| --- | --- | --- | --- |
| L1 recent 16 pre-lock | recovery → recent reconcile → lock | worker, stale-turn | incomplete in top-16 terminalized |
| INV-01 visibility | pre-lock order | worker | unit documents order; optional comment assertion in worker |
| INV-02 tools | PartUpdated publish:false | stale-turn | pending → aborted error |
| INV-03 exit residual budget | dispose → exit-full(budgetMs) | worker, stale-turn | D+E with budget; C stops at budget |
| INV-08 write seam | publish:false only | stale-turn | succeeds without InstanceRef |
| Usage | SQL aborted | stale-turn | running → aborted |
| Idempotent | second call | stale-turn | stable |
| No auto-resume | no prompt | stale-turn | terminal fields only |
| Deadline hierarchy | SHUTDOWN=5s unchanged | worker | no raise; no daemon.ts change required |

## 14. Reverse Traceability

| Concept | Req | Why not reuse existing |
| --- | --- | --- |
| SessionStaleTurn | INV-01..05 | cancel is live user path only |
| publish:false writes | INV-08 | update* requires InstanceRef |
| Pre-lock L1 | INV-01/07 | post-lock + publish:false loses first-snapshot visibility |
| Residual-budget exit-full under 5s | INV-03 | unbounded SCAN and 15s worker invert CLI hierarchy |
| limit 16 | L1 + INV-06 | full SCAN violates UX budget |
| abort string reuse | UI contract | new strings fork `· interrupted` |

## 15. File-Level Change Plan

| File | Change | Responsibility | Δ lines |
| --- | --- | --- | --- |
| `packages/opencode/src/session/stale-turn.ts` | add | recent / exit-full, publish:false, usage SQL, residual budget | +280–420 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | pre-lock recent L1; post-dispose residual-budget exit-full; keep SHUTDOWN=5s | +25–55 |
| `packages/opencode/test/session/stale-turn.test.ts` | add | recent, exit-full budget, no InstanceRef, idempotent | +220–380 |

**No `prompt.ts` or `daemon.ts` change.** Import abort constants from `session/processor.ts`; inline tool error state shape matching prompt.

Hard caps: ≤8 files, ≤1200 lines. Target **3 files**.

## 16. TDD Behavior Slices

| # | Red | Green | Protects |
| --- | --- | --- | --- |
| 1 | incomplete in top-16 not terminal | recent reconcile terminalizes | INV-01 |
| 2 | open tool remains pending | tool aborted + interrupted metadata | INV-02 |
| 3 | usage running | usage aborted | accounting |
| 4 | no InstanceRef | reconcile succeeds | INV-08 |
| 5 | orphan tool on completed message with budget | tool closed when budget allows | exit-full C |
| 6 | exit-full with budgetMs=0 | no mutations | residual skip |
| 7 | second reconcile | no-op | INV-05 |

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | --- |
| E | ~350–550 |
| C | ≥ ceil(E×0.15) |

Comment topics (Chinese, adjacent):

- publish:false required (no InstanceRef; bus not used for owner-transition visibility)
- L1 **before** lock so first snapshot is terminal
- recent-16 not full part SCAN (latency)
- exit after dispose; residual budget under 5s worker / 10s CLI hierarchy
- D+E first, budgeted orphan C second
- tool-only orphan path (cancelSnapshot gap)
- interrupt strings match cancel/UI
- idempotent already-terminal skip; constant 16 is product L1

## 18. Verification

| Command | Cwd | Proves |
| --- | --- | --- |
| `bun test test/session/stale-turn.test.ts` | packages/opencode | behavior slices |
| `bun test test/cli/tui/daemon.test.ts` (relevant cases) | packages/opencode | start/stop still works |
| `bun typecheck` | packages/opencode | types |

## 19. Diff Budget

| Metric | Estimate |
| --- | --- |
| Files added | 2 |
| Files modified | 1 |
| Production lines | ≤475 |
| Test lines | ≤400 |
| Total | ≤1200 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Dispose consumes full 5s | exit-full skipped; next L1 covers top-16 |
| Orphan SCAN incomplete under 2s budget | D+E still done when budget allows; residual logged |
| Sessions outside top-16 after hard kill | L1 tradeoff; exit-full when graceful residual allows |
| publish:false skips bus | Pre-lock L1 + TUI HTTP snapshot (not bus) |
| Empty-assistant hide / recordAssistant parity | Match cancel empty hide; usage request row aborted is enough for INV |

### Open Decisions

None for R3.

### Rejected Speculation

- Persist SessionStatus across death
- Post-lock L1 + bus refresh for visibility
- Raising worker timeout above CLI STOP without raising CLI
- Age-only reconcile
- Reconcile on every SSE reconnect
- Session.update* at boot
- Unbounded exit open-tool SCAN

## 21. Audit Contract

Independent auditor must read this exact file and the original requirement, reconstruct from repository evidence, treat builder summaries as untrusted, audit full original scope, require evidence for blocking findings, and check under/over-design, root-cause repair, fallback, ownership, tests, quality, and 15% Chinese comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 InstanceRef write; B-02 admission race; B-03 exit vs 5s | N-01 worker hook tests; N-02 prompt extract | BLOCK | ses_06a112fc8ffedU4CSiJirFwstK |
| 2 | R2 | yes | B-01 post-lock L1 + publish:false visibility; B-02 worker 15s > CLI STOP 10s | N-01 time_updated first-write; N-02 cancel parity gaps; N-03 admission test; N-04 exit while HTTP up | BLOCK | ses_069eb77bfffeuuax34cQFzmENm |
| 3 | R3 | yes | No blocking findings. | N-01 D/E not wall-clock bounded like C; N-02 orchestration order weakly tested; N-03 exit-full while HTTP up; N-04 cancel usage parity thinner; N-05 INV-07 overstates external-port bypass; N-06 cost model scan-heavy write-light | APPROVE | ses_069e347fefferM01DFPiKCS8Bz |

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/session/stale-turn.ts` | add — SessionStaleTurn.reconcile (recent / exit-full) |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify — pre-lock L1 + residual-budget exit-full; SHUTDOWN remains 5s |
| `packages/opencode/test/session/stale-turn.test.ts` | add — 7 behavioral slices |

Diff size: worker +20 lines; stale-turn ~280 LOC; test ~290 LOC. Within ≤3 files / ≤1200 lines.

### Red-Green Test Evidence

| Slice | Result |
| --- | --- |
| recent terminalizes incomplete assistant | pass |
| open tool aborted + interrupted metadata | pass |
| usage running → aborted | pass |
| reconcile without InstanceRef | pass |
| exit-full orphan tool on completed message | pass |
| exit-full budgetMs=0 no-op | pass |
| second reconcile idempotent | pass |

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/session/stale-turn.test.ts` | packages/opencode | 7 pass |
| `bun typecheck` | packages/opencode | pass |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "start\|stop\|ensure\|health"` | packages/opencode | 16 pass, 1 skip |

### Original Feedback-Loop Result

Module absent → tests fail before implementation; after implementation all 7 slices green. Durable terminal fields match cancel contract (MessageAbortedError, TOOL_ABORTED_ERROR, interrupted metadata).

### Actual Secondary and Replacement Path Inventory

| Path | Classification |
| --- | --- |
| SessionStaleTurn recent/exit-full + publish:false | primary |
| Live cancel / processor / maintenance reconcile | preserved separate |
| L1 catch-log on failure then still write lock | residual diagnostic (does not alternate success semantics of reconcile itself) |
| exit-full skip when remaining≤0 | residual accepted → next L1 |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 453 | exclude imports/blanks; worker counted from `git diff` added non-import code only |
| Qualifying Chinese comment lines `C` | 69 | adjacent invariant/boundary/test-intent comments |
| Ratio `C / E` | 0.152 |  |
| Required minimum `C` | 68 | ceil(453×0.15) |

Representative comments: pre-lock L1 visibility; publish:false / no InstanceRef; residual budget under 5s/10s hierarchy; orphan tool-only path; cancel-equivalent error strings.

### Remaining Unverified Items

- No integration test that forces worker boot order (L1 before lock) via process spawn (N-02).
- Full open-tool orphan SCAN under live 1.8GB DB not re-run in CI (budgeted path unit-tested).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R3 | yes | B-01 residual clock from dispose only; B-02 orphan unbounded .all() before budget | N-01 D/E unbounded; N-02 worker order untested; N-03 HTTP during exit-full; N-04 verification not re-run by auditor | BLOCK | ses_069d2ea83ffe3P6cRh2KuLRL7q |
| 2 | R3 | yes | No blocking findings. | N-01 D/E mid-loop unbounded; N-02 worker order untested at process seam; N-03 orphan mid-scan stop untested; N-04 session.time_updated ranking | APPROVE | ses_069cc9c66ffeqWY9NXxe7ixsMk |
