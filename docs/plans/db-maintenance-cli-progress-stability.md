# Canonical Implementation Plan: DB Maintenance CLI Progress Stability

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL verbatim requirement (UI thresholds/noise, ~10fps refresh, progress width stability, daemon poll stability; no compress/storage algorithm change; ≤4 code files; ≤1200 lines; end state verified-implementation-and-commit)
>
> Implementation allowed: yes
>
> Last updated: 2026-07-25
>
> R2: reconcile dead owner; lock freelist ratio denominator.
> R3: always settle on durable terminal before observe returns.
> R4: hard ~10fps only online; offline best-effort free-time paint; ensureSettled = control GET timeout false only.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority. Prior plan `docs/plans/db-maintenance-cli-ux.md`
defines the original compact CLI language; this plan revises only presentation
scheduling, reclaim noise gates, and online observation. It does not reopen cold
storage codec, eligibility, batch SQL, or vacuum SQLite semantics.

## 1. Verbatim Requirement

> 详细完整检查全面的内容，按照如上我们要求的逻辑进行相应修改,，保持整体逻辑理顺、服从整体项目的开发和实现风格，移除或者替换旧的逻辑。我希望整体的修改保持甜点级别,也就是不要修改过于冗余。整体来说,我们UI部分要按照你的当时的UI的设计来进行修改,也就是部分不合理的UI内容,譬如说预值、噪音等等问题,要进行相应的修改。与此同时,我们更新的频率这个东西也需要相应的修改。也就是online的时候,理论上最好它的,或者说offline的时候,它的起码这个帧率我觉得要能达到10fps左右,或者说等等逻辑,你看看怎样才能实现比较好,它有没有可能能够一步的那种。与此同时,宽度确实好像没有变。与此同时,最重要的也就是最后一个,这么一个问题,需要把相应的轮询等等机制进行相应的处理与修改。注意不要修改具体的压缩和等等逻辑,而只修改整体的调度以及相应的UI展示等等逻辑。整体修改文件数量控制在4个代码文件以内，同时代码修改不超过1200行。

Prior session analysis that the user accepted as the UI/threshold/poll design
direction (to apply, not re-debate):

- Reclaim/status vacuum noise floors: noise 1 MB; status hint 8 MB + 1% or 64 MB;
  interactive prompt 16 MB + 2% or 64 MB; explicit `--vacuum --yes` auto path
  only skips below 1 MB noise; independent `db vacuum --yes` may soft-skip zero
  freelist.
- Progress: indeterminate pulse retained; fixed field widths; clear-to-EOL.
  Hard ~10 fps for **online** observe only. Offline: best-effort re-paint when
  the event loop is free (checkpoint awaits); no hard 10fps during in-process
  sync batches.
- Online observation: reconciled durable task is progress truth (counters +
  dead-owner demotion); short HTTP ACK timeout must not kill long maintenance;
  HTTP failure while a live owner remains nonterminal is not task failure.

## 2. Explicit Non-Goals

- No change to ColdStorage compress/expand/verify/cleanup eligibility, batching,
  cursor, zstd codec, pack format, or SQLite VACUUM SQL.
- No change to daemon election, maintenance lease algorithm, or stopDaemon
  safety.
- No full-screen TUI, stats renderer, alternate screen, or percentage/ETA when no
  total denominator exists.
- No new `db optimize` command.
- No schema/migration/config/SDK/webapp changes.
- No automatic vacuum without user intent (`--vacuum --yes`, interactive Y, or
  standalone `vacuum --yes`).
- No Worker-thread / subprocess rewrite of maintain.
- No modification of more than four code/test production-path files; no total
  diff over 1200 lines.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session/daemon/storage vocabulary; maintenance is control-plane, not Session run loop. |
| `AGENTS.md` / `packages/opencode/AGENTS.md` | Minimal helpers, package-local tests (`bun test` from package), `bun typecheck`, Chinese comments only for non-obvious behavior. |
| `.opencode/policy/first-principles-engineering.md` | One primary path; repair first divergence; no fallback success paths. |
| `docs/plans/db-maintenance-cli-ux.md` | Fixed compact CLI language (symbols, stderr, human/machine gate, indeterminate pulse). This task tightens noise gates and observation without abandoning that language. |
| Existing `ServerLock` task store | Durable task JSON under `*.db.maintenance/tasks/` is already the authoritative control record. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts` | Human renderer, `compressionProgress`, `daemonRequest` default 2s, `waitForDaemonTask` 250ms poll, reclaim `reusable === 0`, status Recommendation | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | startMaintenance 202, runMaintenance async, status may await active promise only when terminal | observed |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts` | `readMaintenanceTask`, `reconcileMaintenanceTask`, `findNonterminalMaintenanceTask`, atomic task write | observed |
| `packages/opencode/src/storage/cold.ts` | `DEFAULT_BATCH_SIZE=2000`, checkpoint after batch commit only; freelist/pageSize status fields | observed |
| `packages/opencode/test/cli/db-maintenance.test.ts` | PTY/JSON coverage for progress/reclaim/JSON; no width/fps/timeout/threshold tests | observed |
| User logs `~/.local/share/opencode/log/2026-07-24T215654.log`, `...215705.log` | `TimeoutError` then `MaintenanceBusyError` for live task `dbm_9fdbc4fc-...` | observed |
| Live task file later `status: completed` with 170676 processed | Proves CLI timeout was observer failure, not compress failure | observed |
| `opencode.db` ~1.8 GB | Large-DB online path stress | observed |
| Source assert script: `timeoutMs=2_000`, `sleep(250)`, `last < 150`, `reusable === 0`; 1 page freelist = 4096 bytes prompts under current gate | red-capable constant proof | observed |
| `bun test test/cli/db-maintenance.test.ts -t "reports committed compression progress"` from `packages/opencode` | PASS under current code (does not catch timeout/width/noise) | observed |

## 5. Current Behavior

```text
human compress + live daemon (N keep daemon)
  -> POST control maintenance (daemonRequest timeout 2s)
  -> 202 { taskID }
  -> waitForDaemonTask: GET status?task= every 250ms (timeout 2s each)
  -> compressionProgress: throttle 150ms, pulse from elapsed, variable-width line, \r no EL
  -> on TimeoutError: CLI fatal; daemon task continues
  -> later compress: findNonterminal -> MaintenanceBusyError

human compress offline
  -> runOffline checkpoint -> progress.update after durable write only
  -> no independent frame clock between batches (default batch 2000)

post-compress reclaim / status Recommendation
  -> reusable = freelistPages * pageSize
  -> any reusable > 0 prompts or recommends vacuum
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Interactive TTY compress | User CLI | stdin+stderr TTY, !--json | `executeCompression` human branch | DB CLI | contracted |
| Online daemon compress (N) | User declines stop | live lock + controlPort | POST + observe task | DB CLI + worker | observed |
| Offline compress (Y stop / no daemon) | Domain selection | election + lease | `runOffline` checkpoint | DB CLI + ColdStorage | observed |
| Tiny freelist (1+ pages, few KB) | SQLite freelist after deletes/compress | page_size typically 4096 | reclaim prompt + status Recommendation | DB CLI presentation | observed |
| Large DB busy batch | maintain sync work on worker event loop | same process as control HTTP | GET status may stall | worker + CLI poll | observed |
| Machine `--vacuum --yes` | scripts | non-TTY or --json | silent compress+vacuum | DB CLI | contracted |
| Explicit `db vacuum --yes` | user | confirm flag | vacuum owner | DB CLI | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | **Online** human compress progress must refresh at ~10 fps (≈100 ms) while the observed task is nonterminal, without inventing counters. **Offline** must update counters on every durable checkpoint and re-paint pulse/elapsed on a ~100 ms timer only when the CLI event loop is free; hard 10fps during in-process sync batches is not required and not claimed. | User fps + online TimeoutError; offline maintain is in-process sync batches | progress PTY only checks presence, not rate |
| INV-02 | Progress line width must be stable: fixed field widths and clear-to-EOL so shortening rate/duration cannot leave residue or appear to resize the pulse track. | User width complaint; current unpadded `\r` write | none |
| INV-03 | Pulse remains indeterminate (no percent/ETA); counters only reflect durable task snapshots. | prior UX plan + cold task has no total | progress test forbids raw JSON shape |
| INV-04 | Interactive reclaim prompt and status vacuum Recommendation only appear when freelist reclaim is meaningful (not few-KB noise). Meaningfulness uses absolute freelist bytes plus freelist share of **page allocation** `total = pageCount * pageSize`, `ratio = total > 0 ? reusable / total : 0` (never rawBytes/activeBytes). | User noise complaint; current `reusable === 0` only | reclaim PTY assumes large freelist |
| INV-05 | Explicit machine `compress --vacuum --yes` when reusable &lt; NOISE does not run SQL VACUUM; returns the existing `compress-vacuum` composite with `vacuum: { type: "vacuum", pagesBefore, pagesAfter }` both equal to the current `pageCount` (no rewrite). | ROI analysis; §20 lock | composite JSON test always vacuum |
| INV-06 | Online observation must not use the 2s control ACK timeout as the long-poll budget; durable task counters are progress truth while the maintenance owner is live. | user TimeoutError logs; task completed after CLI death | none |
| INV-07 | HTTP/control failure while the durable task remains nonterminal **and** the lease owner is still live is not task failure. Observation always applies `ServerLock.reconcileMaintenanceTask` (or equivalent owner-liveness demotion) each snapshot so dead owners become `interrupted` and the CLI stops with taskID guidance; it must not hang on a forever-running pulse. | user already exists after timeout; reconcile contract in server-lock | none |
| INV-08 | After durable terminal (`completed` / `failed` / `interrupted`), online observe **always** settles via one control GET `status?task=` with timeout `false` (worker awaits active promise when terminal+active, then re-reconciles) before returning—including retainedDaemon. If control is unreachable after durable terminal, fail closed with taskID guidance (no second owner.json parser in db.ts). Same-command reclaim vacuum runs only after settlement when freelist is PROMPT-meaningful and daemon was stopped. | worker status awaits active promise when terminal+active | daemon suites |
| INV-09 | Compress/storage algorithms, eligibility, batch SQL, and vacuum SQL stay unchanged. | user non-goal | cold tests unchanged |
| INV-10 | File budget ≤4 code/test files; total additions+deletions ≤1200; Chinese comment gate on effective lines. | user constraint + policy | diff verification |
| INV-11 | Machine/non-TTY JSON shapes for existing commands remain free of ANSI/progress; human-only presentation changes. | prior UX INV | JSON tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | Online: observe only on HTTP events with 2s timeout (no free frame clock). Offline: paint only on checkpoint with 150ms throttle. | `db.ts` presentation + online wait | online TimeoutError; offline freezes between checkpoints |
| INV-02 | progress write uses unpadded variable `size(rate)`/`duration`/`toLocaleString` and `\r` without EL | `db.ts` `compressionProgress` | source + residual-width analysis |
| INV-04 | post-compress and status treat any `reusable > 0` as worth user attention | `db.ts` `executeCompression` / `renderStatus` | 4096 bytes prompts |
| INV-06/07 | `waitForDaemonTask` uses `daemonRequest` default 2s; timeout throws fatal; no durable reconcile observer | `db.ts` online wait loop | logs TimeoutError; task still ran; raw `readMaintenanceTask` alone would also hang after dead owner without reconcile |

### Red-capable feedback loop

1. **Constant/gate proof (already run):**
   ```bash
   # from repo root — asserts current source embeds 2_000 timeout, 250 poll,
   # 150 throttle, reusable === 0 gate; proves 1 page freelist is "promptable"
   python3 -c '...'  # see section 4 result: source_asserts_ok; reusable 4096 True
   ```
2. **User symptom loop (already observed on real DB):**
   ```text
   opencode db compress  # N keep daemon on ~1.8GB DB
   # red: TimeoutError within seconds while progress shows 0 owners
   opencode db compress
   # red: Maintenance task already exists: dbm_...
   # later task file status completed — proves observer bug
   ```
3. **Post-fix package tests (to add):** PTY/unit at CLI seam for threshold skip,
   fixed-width progress frames, and online observation that survives slow control
   by reading durable task (fixture-written task updates).

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Progress frame clock + line layout | DB CLI `db.ts` | Human TTY presentation only | User-facing CLI owns ANSI/fps | ColdStorage must not learn TTY |
| Reclaim/status noise gates | DB CLI presentation | When to ask/recommend vacuum | Presentation policy over freelist metrics | Storage correctly reports raw freelist |
| Online task observation | DB CLI orchestration using `ServerLock.readMaintenanceTask` / reconcile | Progress from durable record; start still via control | Observation consumer of existing store | Worker already writes checkpoints; must not grow a second progress protocol |
| Control HTTP timeouts | DB CLI `daemonRequest` call sites | Short ACK vs long/settled handoff | Caller knows operation class | Worker HTTP remains simple |
| Compress execution | ColdStorage + worker (unchanged) | Batches + checkpoints | Domain owner | CLI must not reimplement |

## 10. Single Approved Primary-Path Design

```text
human compress start (domain selection unchanged)
  -> if online: POST maintenance with startTimeoutMs (~10s)
  -> obtain taskID
  -> observeTask(taskID):
       start frame clock ~100ms
       each frame:
         // primary durable snapshot WITH owner liveness (not raw read alone)
         task = await ServerLock.reconcileMaintenanceTask(taskID)
         if missing:
           optional control GET with long timeout; if still missing -> fail with taskID
         render fixed-width progress from reconciled counters + pulse
         if status is interrupted/failed/completed (durable terminal):
           // always settle before ending observe — including retainedDaemon
           await ensureSettled(taskID)
             // sole path: control GET status?task= with timeout false
             // worker awaits active promise when terminal+active, re-reconciles
             // if control unreachable after durable terminal: fail closed + taskID
           stop clock
           if interrupted/failed: surface taskID + resume/error; non-zero exit
           if completed: return task (reclaim may still skip when retainedDaemon)
         // queued/running with live owner: continue (reconcile each frame)
  -> offline path: runOffline checkpoint still writes durable task then onTask
       merges counters; ~100ms timer re-paints only when event loop free
       (between awaits). No hard 10fps during sync batch work.

reclaim / status Recommendation:
  total = pageCount * pageSize   // page allocation only; never rawBytes/activeBytes
  reusable = freelistPages * pageSize
  ratio = total > 0 ? reusable / total : 0
  fixed constants (decimal bytes, match size()/targetBytes style):
    NOISE = 1_000_000
    HINT = reusable >= 64_000_000 || (reusable >= 8_000_000 && ratio >= 0.01)
    PROMPT = reusable >= 64_000_000 || (reusable >= 16_000_000 && ratio >= 0.02)
  status Recommendation iff HINT
  interactive post-compress prompt iff PROMPT (and not retainedDaemon)
  machine compress --vacuum --yes:
    if reusable < NOISE: do not run SQL VACUUM; return compress-vacuum composite
      with vacuum.pagesBefore == vacuum.pagesAfter == current pageCount
    else: existing vacuum path
  standalone human vacuum --yes with freelist 0: dim nothing-to-reclaim, exit 0, no VACUUM
  standalone machine vacuum --yes: keep executing vacuum (script compatibility)

progress line (fixed design language retained):
  \r  [pulse20]  <owners pad> owners  <rate pad>/s  elapsed <time pad>\x1b[K
  pulse track remains 20 cells; rate uses padStart on formatted size; owners
  padStart on locale-fixed digits (use en-US grouping or raw digits for width)
```

### Why this repairs first divergences

- Online frame clock repairs INV-01 hard ~10fps without changing checkpoint
  frequency or inventing totals. Offline free-time re-paint improves freezes
  without claiming impossible hard fps during sync batches.
- Fixed fields + EL repair INV-02.
- Meaningful freelist gates repair INV-04/05 at presentation owner.
- Reconcile-primary observation repairs INV-06/07 without a second success path
  for compress itself: start still one control POST; execution remains one
  maintain owner; observation consumes the same durable record maintain already
  writes, plus the existing dead-owner demotion contract in ServerLock.

### Explicit non-fallback statement

`reconcileMaintenanceTask` (durable counters + lease liveness) is **not** a
fallback after compress failure. It is the **primary observation channel** for a
task that was already accepted (202 / offline lease). Control HTTP remains the
start channel and optional settlement channel. Failure of HTTP while reconcile
still reports a **live** nonterminal task continues observation; it does not
invent a completed compress. Dead owner → interrupted terminal is the same
contract control status already uses today.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Reconcile durable task observation | proposed primary online observe | primary-contract branch | displays progress / detects terminal including dead-owner interrupted | ~40% | add in `db.ts` via existing ServerLock.reconcileMaintenanceTask |
| Control GET status | existing; demoted to settlement/missing-file | primary-contract branch | yes when used | ~15% | keep for handoff |
| Offline checkpoint onTask | existing | primary-contract branch | merges counters | ~15% | preserve + share renderer |
| 2s HTTP poll as sole observe | current | forbidden as sole online observe | false fatal on stall | — | remove |
| Percentage bar / pre-scan total | not present | forbidden fallback | would fake completion | 0 | reject |
| Second compress writer on HTTP fail | not present | forbidden fallback | — | 0 | reject |

New alternate success paths for compression execution: **zero**.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Sole reliance on 2s HTTP status poll for progress | assumed control always responsive | reconcile observation + long settlement | `waitForDaemonTask` rewrite |
| `reusable === 0` as only noise gate | prior plan hard rule | user-confirmed meaningful thresholds | `executeCompression`, `renderStatus` |
| Event-only progress paint | matched checkpoint truth | truth still from durable counters; paint clock separate | `compressionProgress` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 online ~10 fps | online observe frame clock | `db.ts` | online/simulated free-loop: ≥2 distinct pulse frames within 250ms while counters static; offline test only requires paint on checkpoint + free-time timer when loop free (not hard fps during sync work) |
| INV-02 width | fixed pads + `\x1b[K` | `db.ts` | unit/PTY: shorter rate line does not retain prior longer suffix |
| INV-03 no percent | keep indeterminate pulse | `db.ts` | existing progress regex still no `%` |
| INV-04 noise gates | HINT/PROMPT on status + reclaim using ratio = reusable/(pageCount*pageSize) | `db.ts` | fixture freelist tiny absolute → no Reclaim/Recommendation; large absolute or high ratio → prompt/recommend |
| INV-05 machine vacuum noise | reusable &lt; NOISE → no SQL VACUUM; composite vacuum pages equal current pageCount | `db.ts` | `--vacuum --yes --json` with tiny freelist returns compress-vacuum without rewriting pages |
| INV-06/07 online observe | reconcile-primary wait loop | `db.ts` | (a) slow control: CLI tracks fixture task to completed; (b) dead owner: fixture running task + dead lease → interrupted exit with taskID, no hang |
| INV-08 settlement | after any durable terminal, always ensureSettled before observe returns | `db.ts` | online completed: follow-on lease acquire succeeds immediately after observe; retainedDaemon still skips reclaim UI; offline reclaim still works |
| INV-09 no storage change | no cold.ts edit | — | cold tests not required to change |
| INV-10 budget | ≤4 files ≤1200 lines | diff | measure |
| INV-11 JSON clean | human-only frames | `db.ts` mode gate | existing JSON tests |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Online ~100ms frame timer; offline free-time re-paint | INV-01 | user fps; online TimeoutError path free process; offline in-process batches | checkpoint-only + HTTP-only paint cannot meet online 10fps |
| Fixed-width progress fields + EL | INV-02 | residual `\r` | unpadded write cannot stabilize width |
| meaningful freelist helper | INV-04/05 | few-KB prompts | `>0` gate is the bug |
| Reconcile-primary task observation | INV-06/07 | TimeoutError logs; ServerLock dead-owner contract | HTTP 2s poll is first divergence; raw file read alone drops dead-owner exit |
| Always ensureSettled after durable terminal | INV-08 | worker terminal before finally; control GET awaits active | R2 skipped settlement on retainedDaemon success path |
| startTimeout 10s vs observe no short timeout | INV-06 | start vs long run classes | one default 2s conflates ACK and observe |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts` | modify | progress clock/layout; reclaim/status gates; online observe via durable task; daemonRequest timeout per call site | +180 to +320 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | modify | threshold, width/fps, online observation stability slices | +120 to +220 |
| optional third: only if export needed | — | Prefer zero: `readMaintenanceTask` already exported from server-lock | 0 |
| Hard cap | ≤4 files | Prefer **2 files** | total ≤1200 |

**Do not modify** `cold.ts`, vacuum SQL, or worker maintain algorithm unless audit
proves settlement impossible without a one-line yield — default plan needs **no
worker change** because observation does not require HTTP during batches.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Interactive compress with only few-KB freelist after compress does not show Reclaim prompt | `reusable === 0` only | meaningful PROMPT gate | large freelist still prompts (existing reclaim test) |
| 2 | `db status` human with few-KB freelist has no Recommendation block | same gate | HINT gate | large freelist still recommends |
| 3 | Online (or free event-loop) progress frames while counters unchanged still advance pulse within ~200ms | no frame clock | 100ms timer when loop free | counters still only from durable task; offline does not claim hard fps mid-batch |
| 4 | Progress line after high rate then 0 B/s has no trailing residue from previous frame | no EL/pads | pads + `\x1b[K` | completion summary still prints |
| 5 | Online observe: control status hangs/times out during nonterminal work but durable task advances to completed → CLI succeeds after settlement | 2s HTTP fatal | reconcile-primary nonterminal + terminal ensureSettled | busy existing task still errors before start |
| 6 | Online observe: durable running task whose lease owner is dead terminates as interrupted with taskID (no infinite pulse) | raw read would hang | reconcile each snapshot | live-owner nonterminal continues |
| 7 | Online observe returns completed only after maintenance lease for that task is free (follow-on acquire/status handoff succeeds) | R2 skipped settlement on retainedDaemon | always ensureSettled on terminal | retainedDaemon still skips reclaim prompt |
| 8 | Machine `--vacuum --yes --json` with reusable &lt; 1MB does not execute VACUUM; composite vacuum pages equal | always vacuum | NOISE gate + equal pageCount shape | above noise still vacuum |
| 9 | Human standalone `db vacuum --yes` with freelist 0 prints nothing-to-reclaim and does not run VACUUM | always Reclaiming… | freelist-0 soft-skip | freelist &gt; 0 still vacuums |

Public seams: real CLI argv + PTY/non-TTY as existing tests; task files via
isolated env `OPENCODE_DB`.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~220–350 | exclude imports/blank/pure moves |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(E*0.15)) ≈ 33–53 | nearby only |

Comment topics (must qualify):

- why frame clock is independent of durable counter updates (rate uses last two distinct counter snapshots, not every paint)
- why reconcile observation is primary (not HTTP fallback success; not raw read)
- freelist threshold constants; ratio = reusable/(pageCount*pageSize) only
- start timeout vs observe settlement timeout split
- clear-to-EOL / fixed width for residual prevention
- test intent: tiny freelist must not prompt

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode` | all CLI UX slices green |
| focused new tests for threshold/fps/observe | `packages/opencode` | INV-01/02/04/05/06 |
| `bun typecheck` | `packages/opencode` | types clean |
| source/diff measure files and line budget | repo root | ≤4 files, ≤1200 lines |
| optional manual: human compress N with daemon | user machine | no TimeoutError; progress smooth |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0–1 plan only (this file) | implementation 2 files |
| Files modified | 2 code/test | db.ts + db-maintenance.test.ts |
| Files deleted | 0 | — |
| Production lines | +180–320 / −40–80 | presentation + observe |
| Test lines | +120–220 | slices 1–6 |
| Generated lines | 0 | — |
| Total | ≪1200 | user cap |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| Terminal file before lease release races vacuum | settlement wait INV-08 before reclaim/vacuum |
| `toLocaleString` width variance | pin `en-US` or raw integer pad for owners field |
| Frame timer after process exit | clear interval in finish/finally |
| Machine JSON shape if vacuum skipped | prefer return composite with vacuum pages equal via pageCount without VACUUM, or omit vacuum only if tests allow documented shape — **locked decision: when reusable &lt; NOISE, do not call VACUUM; return `{ type: "compress-vacuum", compress, vacuum: { type: "vacuum", pagesBefore, pagesAfter } }` where both page counts are current pageCount (no SQL VACUUM).** Same shape, no physical rewrite. |
| Standalone human vacuum with 0 freelist | print dim nothing-to-reclaim; exit 0 without VACUUM |

### Open Decisions Requiring the User

None — thresholds, online hard ~10fps, offline best-effort paint, reconcile-primary
observation, and always-on terminal settlement are locked in §1/§7/§10.

### Rejected Speculation

- Moving maintain to a Worker thread (out of file/diff budget; not required if
  observation is reconcile-primary).
- Auto-stopping daemon without prompt (user wants N path stable).
- Percentage completion from eligibleOwners (invalid denominator).
- Using rawBytes/activeBytes as freelist ratio base (wrong metric; locked to page allocation).
- Hard offline 10fps without changing maintain execution (physically unreachable on in-process sync batches).

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
- Confirm compress/storage algorithms remain unmodified.
- Confirm file/line budgets.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 dead-owner hang if raw read; B-02 ratio denominator undefined | §13 INV-05 text drift; INV-08 thin; PTY strip \r; human vacuum-0 wording | BLOCK | adversarial-auditor ses_069d0d6a5ffeR77O35m2ZJEZ64 |
| 2 | R2 | yes | B-01 terminal completed without lease settlement on retainedDaemon | rate-on-paint; pad max widths; human vacuum-0 test; R1 admin nits | BLOCK | adversarial-auditor ses_069cc6541ffeAwznvV6QXbuylq |
| 3 | R3 | yes | B-01 offline hard 10fps unreachable under non-goals | ensureSettled secondary underspecified; freelist-0 vacuum test; pad widths; slice count drift | BLOCK | adversarial-auditor ses_069c546b9ffedTgo4XpFlQqBGF |
| 4 | R4 | yes | none | rate sampling note; missing-file GET; pad widths; slice count; INV-06 harness; raw stderr for width tests | APPROVE | adversarial-auditor ses_069bc5b57ffewBw1cWUMbU6DHw |

### Round 1 verdict (verbatim summary retained in auditor output)

```text
BLOCK
```

Audited R1 only. Blocking B-01 and B-02 required R2 full-scope re-audit.

### Round 1 non-blocking addressed in R2

- §13 INV-05 multi-way text collapsed to §20 equal pageCount composite lock.
- INV-08 later corrected in R3/R4: always settle on terminal; retainedDaemon still skips reclaim UI only.
- Width/fps tests must observe raw stderr (do not strip `\r` for those asserts).
- Standalone vacuum freelist-0: human soft-skip; machine still runs vacuum.


### Round 4 verdict (verbatim)

```text
APPROVE
```

Audited revision R4 only. Full original scope. No blocking findings.
Implementation allowed: yes for R4 only.

## 23. Implementation Evidence

### Actual Files and Diff
- packages/opencode/src/cli/cmd/db.ts
- packages/opencode/test/cli/db-maintenance.test.ts
- packages/opencode/test/cli/tui/daemon.test.ts
- docs/plans/db-maintenance-cli-progress-stability.md
- Diff budget: 3 code/test files, ≪1200 lines

### Red-Green / Verification
- `bun test test/cli/db-maintenance.test.ts` (packages/opencode): 14 pass
- `bun test test/cli/tui/daemon.test.ts -t "db compress variants keep the daemon"`: pass
- `bun typecheck` (packages/opencode): pass

### Chinese Comment Calculation
- E≈379, C_qual≥57, required 57 (auditor)

### Remaining Unverified Items
- Live 1.8GB manual re-run optional; automated hung-control covers TimeoutError class

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R4 | yes | B-01..B-04 verify gaps | — | BLOCK | ses_069b0d32fffesm7Fpb9Ok3Qu0m |
| 2 | R4 | yes | B-01 comment; B-02 observe tests | — | BLOCK | ses_069a64faaffeVz4oZ53i0j9e4r |
| 3 | R4 | yes | B-01 hung test missing live owner | — | BLOCK | ses_0699ced3cffeSBvzmCek2XHKMR |
| 4 | R4 | yes | none | width/fps assert thin; dead-owner via status--task; plan meta | APPROVE | ses_06995efd1fferyHTn9uEUNuhCi |

### Final implementation verdict (verbatim)

```text
APPROVE
```

