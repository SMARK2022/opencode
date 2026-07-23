# Canonical Implementation Plan: DB Maintenance CLI UX

> Status: verified
>
> Revision: R14
>
> Approved revision: R14
>
> Audit mode: implementation
>
> Requirement source: Session GOAL plus the user's fixed CLI design-language decisions recorded below
>
> Implementation allowed: no
>
> Last updated: 2026-07-23

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, mockups, and builder rationale outside this
file are not implementation authority.

## 1. Verbatim Requirement

### 1.1 Session GOAL

> 当前的db compress以及db vacuum,进行适当的流程结合。同时opencode db status/compress应该适当的有一些比较精美的一个渲染或者一个显示的内容,这样可能整体的来说效果会更好。因此请进行相应的优化,以及与此同时能够有任何的进度条等等内容,可以帮助用户得到相应的支持或者相应的有效的反馈。
> 也就是我很好奇里边这些内容,你看看是否能够进行相应的优化,更加智能一点,检测到DAEMON正在运行的时候,自动进行相应的提示,并且提示用户进行关闭,然后给出相应的交互的,也就是一个Y一个n,这样的一个操作。保持整体高性能且不会破坏原有的正常行为、阈值和落库表现；整体保持较小修改，避免大范围改动。保持甜点级别修改，修改代码数在6个以内，行数在1000行以内；保持整体实现核心简洁不臃肿。

### 1.2 Fixed design-language decisions

> 整体而言,我希望选B,但是你的B是完全的复写TTY,这并不好,整体逻辑实现得也过于臃肿。理论上而言,C则更为符合我的感受。所以,理论上说更好的应该是介于C跟B之间的,也就是整体要有命令运行之后,它可以正常地进行相应状态显示,以及提示DAEMON is running,然后巴拉巴拉巴拉巴拉,推荐进行结束之后再进行压缩。然后同时也显示相应的进度条以及时间、耗时,包括相应的速度等等内容,这些对人都比较好。所以理论上而言,我不推荐使用相应的完整的TTY可视化的内容,适当进行即可。你当前B的内容方案过于臃肿。整体实现要在600到800行之间是最好的,包括,请注意我说的600到800行是包括测试文件,所以整体实现要相对来说小巧,但是又完善,可视化精美即可。

> 请你不要这样,请你先给出具体的样式文本,也就是请你输出纯文本内容。在当前的对话框中,我们要固定相应的设计语言,之后就不要再改动这个设计语言。

> 没问题，就你刚刚那样，那些内容都要先写进一个文档里面固定，避免后续发生偏移或者移动。

> 也就是先构建文档固定样式与需求，再继续后续检查调用链。

### 1.3 User-authorized extra audit and corrected daemon-decline behavior

> 授权第 7 轮（推荐）
>
> 授权第 8 轮（推荐）

> 错误，理论上用户第一次输入N第二次都不应该显示? Reclaim 824 MB of physical database space now? [Y/n]

### 1.4 R10 verification correction

The user explicitly authorized not rerunning the full daemon lifecycle file when
it can occupy roughly forty minutes, and stated that it had already passed in a
previous run. R10 therefore requires the focused real-daemon slices in §16 and
records the full-file rerun as an authorized omission rather than claiming a
fresh pass. This changes verification evidence only; it does not weaken any
production behavior, race invariant, or focused public seam.

The corrected behavior is authoritative: after an initial daemon-stop answer of
`N`, this invocation completes compression through the daemon, never displays a
second reclaim prompt, and never runs vacuum. `compress --yes` without
`--vacuum` remains invalid.

### 1.5 R11 readable-footprint authorization carried into R14

> 允许 ≤1100 (Recommended)

This authorization changes only the complete code/test additions-plus-deletions
hard cap from fewer than 1,000 to at most 1,100. The six-file cap, behavior,
ownership, verification, and comment gates remain unchanged. R11 also makes
normal readable formatting an explicit release condition: independent imports,
declarations, control-flow operations, assertions, and fixture steps must not be
packed onto one physical line to manipulate the footprint.

### 1.6 Additional implementation-audit authorization

> 授权第11轮（Recommended）

This authorization permits one further full-scope independent implementation
audit after round 10. It does not relax behavior, scope, readability, footprint,
comment, verification, or commit gates.

### 1.7 R14 readable-footprint revision authorization

> 授权 R14 提高上限至1250 (Recommended)

This revision changes only the complete code/test additions-plus-deletions cap
from at most 1,100 to at most 1,250 so the previously approved behavior can be
formatted normally. The six-file cap, behavior, ownership, verification, and
Chinese-comment gates remain unchanged; packed statements remain forbidden.

### 1.8 R14 implementation-audit authorization

The user's R14 choice also authorizes one full-scope independent implementation
audit after the readable expansion. It does not authorize a commit before an
`APPROVE` verdict and does not relax any hard gate.

## 2. Explicit Non-Goals

- No full-screen TUI, terminal takeover, alternate screen buffer, dashboard,
  chart, card, or panel renderer.
- No copy or reuse of the full `opencode stats` rendering stack.
- No new `opencode db optimize` command or second maintenance orchestrator.
- No storage schema, cold-storage codec, eligibility threshold, refcount,
  persistence, batching, resume, or database write-semantic change.
- No automatic cleanup deletion outside the existing explicit cleanup contract.
- No web app, desktop app, SDK, generated client, migration, or configuration
  change.
- No fabricated `VACUUM` percentage when SQLite cannot expose an accurate total.
- No GPU, worker pool, Rust/WASM codec, external archive, backup feature, or
  generalized CLI UI framework.
- No fallback from a failed daemon maintenance path to an offline writer.
- No change to any existing machine-readable result shape. The new explicit
  combined option may return a new composite object containing the unchanged
  completed compress task and unchanged vacuum report; no existing invocation
  produces that shape.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Requires minimal code, no unnecessary helpers, package-local tests/typecheck, and Chinese explanatory comments only for non-obvious behavior. |
| `CONTEXT.md` | Defines the canonical Session, Message, Part, Status, daemon, and storage vocabulary. |
| `.opencode/policy/first-principles-engineering.md` | Requires one owning primary path, forward/reverse traceability, no invented fallback, approved revision before implementation, and independent audits. |
| `packages/opencode/AGENTS.md` | Requires package-local database conventions, natural module shape, small nearby helpers, and `bun typecheck` rather than direct `tsc`. No schema or migration is needed. |
| `packages/opencode/test/AGENTS.md` | Requires real behavior seams, isolated temp directories, readiness signals rather than sleep races, and Effect fixtures where applicable. |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | Unrelated to DB maintenance; no ADR changes this task's CLI/storage ownership. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts:16-287,342-408` | `liveDaemon` fixes the execution domain once; `executeMaintenance` prints final/queued JSON; commands expose no `--json`, compress/vacuum composition, daemon prompt, or maintenance progress. Migration lines 347-373 provide a compact transient-progress precedent. | observed |
| `packages/opencode/src/cli/cmd/daemon.ts:6-141` | `stopDaemon` already authenticates the private shutdown request, waits for graceful exit, rechecks lock ownership, and only force-stops the same owner after timeout. The function is private and currently reports failure through `process.exitCode`. | observed |
| `packages/opencode/src/cli/cmd/tui/server-lock.ts:10-28,96-145,242-319,322-424` | Lock identity includes PID/token/dbPath/controlPort; task records are atomic and reconcile dead owners; the maintenance lease is the existing cross-process write exclusion owner. | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts:118-220,249-295,355-435` | Daemon task-backed maintenance returns HTTP 202, executes in the background, checkpoints durable counters, and exposes the full task through the authenticated status endpoint. Graceful stop aborts at a batch boundary and waits for lease release/database close. | observed |
| `packages/opencode/src/storage/cold.ts:98-198` | Status, verify, cleanup, request, task, and result types define the only truthful renderable fields. `MaintenanceTask` has no total-owner denominator. | observed |
| `packages/opencode/src/storage/cold.ts:2804-3024,3127-3378` | `prepareMaintenance` owns immediate/task classification; `maintain` is the sole batch/cursor/checkpoint/abort/terminal owner. `processed`, `skipped`, and byte counters advance only after committed batches. | observed |
| `packages/opencode/src/storage/cold.ts:3027-3037,3381-3463` | Vacuum reports pages before/after; status exposes page size/count/freelist, active bytes, cold metrics, mismatch, and orphan counts without hydrating payload bodies. It does not expose WAL bytes, database path, total owners, or verified corruption state. | observed |
| `packages/opencode/src/cli/ui.ts:14-38,106-126` | Existing color constants, stderr output, and line-input helper are sufficient; no UI dependency or full renderer is needed. | observed |
| `packages/opencode/src/index.ts:129-164` | Global middleware emits one-time migration prose/progress before DB handlers, including on `--json` and non-TTY first runs; this is the earliest machine-output owner. | observed |
| `packages/opencode/src/pty/pty.ts:10-25`, `pty.bun.ts:1-26` | The existing cross-platform PTY adapter can exercise the real interactive CLI prompt/output seam in tests. | reachable |
| `packages/opencode/test/cli/tui/daemon.test.ts:43-133,481-695,926-1051` | Existing real-process helpers isolate daemon lock/DB state and prove safe stop plus maintenance start/status behavior. New interactive daemon coverage can reuse this file rather than duplicate lifecycle fixtures. | observed |
| `packages/opencode/test/cli/tui/maintenance-retry-worker.ts:1-41` | Existing subprocess uses a published marker and a one-shot `fs/promises.rename` conflict to deterministically hold the real stale-lease acquisition boundary without a production hook. | observed |
| `packages/opencode/test/storage/cold.test.ts:2467-2491` | Real SQLite test proves explicit vacuum truncates WAL before reporting success; this task must preserve that operation unchanged. | observed |
| `bun run src/index.ts db status` on isolated `.temp/testing/db-maintenance-cli-status-current/opencode.db` | Current command exits 0 and emits the raw 18-field `StatusReport` JSON, with no human rendering. | observed |
| `bun run src/index.ts db status --json` on isolated `.temp/testing/db-maintenance-cli-json-current/opencode.db` | Current command exits 1 because the strict CLI has no `--json` option. | observed |

## 5. Pre-implementation Behavior (R10 baseline)

```text
opencode db status
  -> StatusCommand
  -> liveDaemon()
  -> daemon POST /maintenance and await complete immediate report
     OR ColdStorage.status() offline
  -> printMaintenance()
  -> JSON on existing UI stderr stream

opencode db compress
  -> CompressCommand normalizes age/batch/session request
  -> executeMaintenance() chooses its execution domain exactly once
  -> live daemon: POST /maintenance -> HTTP 202 queued identity -> print JSON and exit
     OR offline: prepare -> lease -> durable queued task -> maintain batches/checkpoints
        -> terminal MaintenanceTask -> print JSON

opencode db vacuum --yes
  -> VacuumCommand explicit confirmation
  -> same daemon/offline domain selection
  -> pseudo lease owner -> ColdStorage.maintain(vacuum)
  -> VACUUM -> checked wal_checkpoint(TRUNCATE) -> pagesBefore/pagesAfter
  -> print JSON
```

The first divergence is in the DB CLI output/orchestration adapter. ColdStorage
already exposes durable progress and the authoritative operations; the CLI
currently discards that progressive capability online by printing the 202 body
and exiting, and offline by waiting without rendering its checkpoint callback.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Interactive terminal (`stdin.isTTY && stderr.isTTY`) | User invokes a DB command directly | Existing UI and command output use stderr; stdin can answer the one-line prompt | DB CLI entry | DB CLI output adapter | contracted |
| Machine output (`--json`) | User or script explicitly requests JSON on status/compress/vacuum | A scoped option forces the current JSON serialization branch even in a TTY | Relevant DB command entry | DB CLI output adapter | contracted |
| Piped/non-TTY output | Shell redirects the existing UI stream or has no interactive stdin | Must preserve current JSON shape/stream, never prompt, and never emit ANSI/cursor control | DB CLI entry | DB CLI output adapter | contracted |
| Live responsive daemon for current DB | `ServerLock.read`, PID liveness, normalized dbPath, controlPort | Lock token authenticates private requests; control failure never falls back offline | DB CLI -> daemon control | DB CLI orchestration + existing daemon owner | observed |
| No live daemon for current DB | Same lock inspection and stale-owner cleanup | Offline compress first acquires the shared daemon-election lease and rechecks owner absence under it | DB CLI -> election owner -> local ColdStorage maintenance | DB CLI orchestration + existing daemon election | observed/reachable |
| Interactive user answers `Y` to daemon stop | stderr-bound line-input seam after a proven live daemon | Reuse exported existing stop owner; success must be re-observed before offline execution | prompt -> daemon lifecycle -> offline maintenance | DB CLI orchestration + daemon stop owner | contracted |
| Interactive user answers `N` to daemon stop | stderr-bound line-input seam | Keep the already-selected daemon domain; do not create an offline writer | prompt -> daemon maintenance control | DB CLI orchestration | contracted |
| Daemon-backed task in human/waiting mode | HTTP 202 identity | Full task is retrieved only from authenticated `/maintenance/status`; terminal states are durable | POST start -> bounded status polling | DB CLI orchestration | observed |
| Offline task in human/waiting mode | `runOffline` | Every committed batch invokes the existing durable checkpoint callback | maintain -> write task -> render snapshot | DB CLI orchestration | observed |
| Compress with physical reclaim requested | Interactive post-compress approval or new `--vacuum`; non-TTY requires `--yes` | Vacuum begins only after authoritative completed compress and any live daemon is safely stopped for the combined offline physical phase | CLI sequence -> existing compress -> existing vacuum | DB CLI orchestration | contracted |
| SQLite vacuum with no accurate total | Existing synchronous SQLite `VACUUM` | Pages before/after and elapsed duration are observable; internal percentage/ETA is not | vacuum operation -> compact start/final lines | DB CLI output adapter | observed |

Speculative rows cannot justify production logic or blocking findings.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Interactive DB maintenance uses a compact, scrollback-preserving CLI presentation rather than raw JSON or a full-screen TUI. | Contracted by §1; current raw JSON observed at `db.ts:87-89`. | New TDD slice 1. |
| INV-02 | Compress progress exposes truthful processed work, elapsed time, throughput, and no percentage/ETA without a reliable denominator. | Contracted by §1; task counter semantics observed at `cold.ts:155-174,3173-3371`. | New TDD slice 2. |
| INV-03 | A live daemon is detected before maintenance, visibly reported, and the interactive user receives one `Y/n` decision recommending safe shutdown before compression. | Contracted by §1; current absent prompt at `db.ts:126-135`. | New TDD slice 3. |
| INV-04 | DB maintenance reuses the existing authenticated stop owner and same-owner checked force compatibility path through a conditional maintenance-idle mode; ordinary `opencode daemon stop` retains its current ability to interrupt active maintenance safely. | Observed stop behavior plus R2 audit B-01. | Existing daemon stop suite including active maintenance, plus TDD slice 3. |
| INV-05 | Compress and vacuum can form one user-requested sequence while retaining independent commands and persistence semantics. | Contracted by §1; current separation observed at `db.ts:174-192,277-287`. | New TDD slices 4-5. |
| INV-06 | Logical compression success is reported separately from physical SQLite file reclamation so users understand why the file may not shrink before vacuum. | Contracted user-visible problem; status/vacuum metrics observed in ColdStorage. | New TDD slices 1, 4. |
| INV-07 | TTY human output never changes existing JSON/non-TTY behavior, exit codes, task persistence, resume, thresholds, or database mutations. | Contracted by §1 and existing public CLI/storage contracts. | New TDD slices 1, 5 plus existing cold/daemon suites. |
| INV-08 | `VACUUM` displays a fixed activity line and elapsed completion without fabricated percentage. | Fixed language; no denominator observed at `cold.ts:3142-3163`. | New TDD slice 4. |
| INV-09 | Aggregate status uses compact grouped text without hydrating payloads/verify; `status --task` uses its separately fixed compact task contract for all operations/statuses. | Contracted by §1; metadata/task implementations observed in DB CLI and ColdStorage. | New TDD slice 1 and existing status stress test. |
| INV-10 | The complete implementation changes at most six code/test files and at most 1,250 additions-plus-deletions; normal readable formatting is mandatory and the target remains close to 1,000. | Contracted by §1.7. | Diff and formatting verification. |
| INV-11 | Daemon failure, compress failure, interrupted task, and vacuum failure retain authoritative failure/cursor behavior and never synthesize success. | `ColdStorage.maintain` persists interrupted/failed and rethrows at `cold.ts:3127-3378`; daemon control preserves errors. | New failure slices plus existing maintenance tests. |
| INV-12 | Cleanup, verify, expand, task status, and standalone vacuum retain current semantics; this task does not reroute their storage behavior. | Existing public command surface and maintenance union. | Existing cold/daemon suites. |
| INV-13 | Before daemon lock publication, startup recovery has either proved no task or registered `activeMaintenance`; after publication, the DB prompt's conditional shutdown atomically rejects active/start/resume maintenance and closes new transitions before acknowledging. Ordinary daemon stop remains outside this busy policy. | Existing single-task/lease invariant and races proven by plan audits R1 B-01, R2 B-01/B-02, R3 B-01, and R4 B-01. | Deterministic published-marker recovery test, start/resume races, and active-maintenance daemon-stop regression. |
| INV-14 | A daemon-stop approval is bound to the PID/token/controlPort/dbPath owner displayed before the prompt; replacement ownership is rejected. | Existing lock identity and reachable prompt-window replacement proven by plan audit B-02. | Planned replacement-owner stop test. |
| INV-15 | A daemon task-status response exposes terminal status only after that same task has released its maintenance lease and cleared `activeMaintenance`; terminal observation is the authoritative handoff to conditional shutdown/vacuum. | Terminal-checkpoint/finally ordering proven by R5 audit B-01. | Deterministic blocked-lease-release status handoff test. |
| INV-16 | Successful status/compress/vacuum machine mode remains one parseable JSON document even when the one-time database migration marker is absent. | Global migration producer proven by R5 audit B-02. | Real CLI missing-marker `--json` and non-TTY tests. |
| INV-17 | Every offline compress sequence owns the shared daemon-election interval before selecting the offline writer and through any reclaim decision/vacuum; initially absent daemon state is rechecked under that owner. | Reachable concurrent `Daemon.ensure()` producer and R12 audit B-01. | Initial-offline PTY compress with a concurrent election contender that cannot enter before terminal release. |

## 8. First Divergence and Root Cause

The fixed feature seam is the DB CLI output/orchestration boundary. Current
source establishes the exact first divergences below.

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01, INV-06, INV-09 | `printMaintenance` at `db.ts:87-89` unconditionally serializes JSON; `StatusCommand` and `executeMaintenance` have no TTY adapter. | DB CLI output adapter | Isolated current `db status` reproduction emits only raw JSON. |
| INV-02 | Online `executeMaintenance` at `db.ts:126-135` prints HTTP 202 and exits; offline `runOffline` at `db.ts:91-121` checkpoints without an output callback. | DB CLI maintenance orchestration/output adapter | Worker status endpoint returns full durable counters (`worker.ts:387-397`), proving the source exists but the CLI does not consume it. |
| INV-03, INV-04 | `executeMaintenance` selects live daemon at `db.ts:127` and immediately submits; it never asks for shutdown. The safe stop algorithm exists only as private `stopDaemon` in `cli/cmd/daemon.ts:31-141`. | DB CLI orchestration at daemon-selection seam; existing daemon lifecycle owner | Source trace plus existing real-process daemon stop tests. |
| INV-05 | `CompressCommand` has only session/age/batch flags and `VacuumCommand` is separate with required `--yes`; no sequence exists. | DB CLI command composition | `db.ts:174-192,277-287` and strict current command surface. |
| INV-08 | `VACUUM` runs synchronously in `ColdStorage.maintain` and returns only pages before/after; no percentage denominator exists. | DB CLI output adapter | `cold.ts:3142-3163`. |
| INV-11 | The draft presentation promised SIGINT checkpoint feedback although `runOffline` injects no signal and daemon control has no task-cancel route; it also named `compress` rather than `resume`. | DB CLI command-lifetime/result adapter | R1 audit B-03/B-04 plus `db.ts:91-171,246-253`. R2 removes the unsupported promise and renders only observed interrupted tasks with their task ID. |
| INV-13 | Current lock is published before startup recovery registration, shutdown has one unconditional semantic, and maintenance can enter through start/resume. The owner must reorder recovery registration before publication and conditionally gate both producers without replacing ordinary stop. | Worker startup/private control server | R1 B-01, R2 B-01/B-02, R3 B-01 plus `worker.ts:175-247,355-437,579-582`. |
| INV-14 | Current `stopDaemon` rereads the current lock after the prompt, so its first shutdown request is not bound to the displayed owner. | Daemon stop lifecycle interface | R1 audit B-02 and `daemon.ts:31-79`. |
| INV-15 | Durable `completed` is checkpointed before worker `finally` releases the lease and clears active state, while status returns the checkpoint immediately. | Worker maintenance status handoff | R5 audit B-01 and `cold.ts:3368-3371`, `worker.ts:147-160,387-397`. |
| INV-16 | Global migration middleware writes prose/ANSI before the DB handler can choose JSON. | Root CLI machine-output boundary | R5 audit B-02 and isolated missing-marker command path. |
| INV-17 | `liveDaemon() === undefined` is currently observed before any shared election lease is acquired, so `Daemon.ensure()` may publish a new owner while offline compress/reclaim/vacuum is running. | DB CLI execution-domain selection using the existing daemon election owner | R12 audit B-01 plus `db.ts` offline sequence and `tui/daemon.ts` public election path. |

This is a feature task. The TDD red signal is the new public CLI suite:

```text
bun test test/cli/db-maintenance.test.ts test/cli/tui/daemon.test.ts
```

Before implementation its expected compact status, progress, `--json`, daemon
prompt, and combined vacuum assertions fail because those capabilities do not
exist. The current isolated commands above provide the observed baseline.

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Human vs machine rendering | DB CLI output adapter | Converts existing maintenance results into terminal output | This is the first public presentation seam | ColdStorage owns data semantics, not terminal policy. Existing UI stderr remains the stream owner. |
| Progress polling/rendering | DB CLI maintenance orchestration | Keeps the invoking terminal informed while one existing task runs | It owns command lifetime and the daemon status adapter | daemon and ColdStorage own execution/persistence; neither should learn ANSI or prompts. |
| Daemon detection and shutdown choice | DB CLI orchestration using existing daemon lifecycle API | Chooses the one existing execution owner before starting maintenance | It already selects daemon vs offline operation | ColdStorage cannot own process lifecycle. |
| Authenticated daemon shutdown | Existing `stopDaemon` command/lifecycle owner | Stop only the caller-approved expected owner; graceful request followed by the existing same-owner checked force phase | Export expected-owner/result/progress while retaining one algorithm | DB command must not reimplement token/PID safety. |
| Recovery publication and conditional shutdown/start-resume exclusion | Worker startup/private control transition | Recovery registers active state before lock visibility; maintenance-idle shutdown rejects pending/active start or resume and closes both producers before acknowledgement; ordinary stop keeps current interruption semantics | The daemon alone owns lock publication, active state, and control serialization | A CLI file check cannot protect the prompt; a recovery flag without a sensitive public test would remain unproven. |
| Compress-then-vacuum sequence | DB CLI orchestration | Sequences two existing operations after explicit user intent | User-facing command composition belongs at CLI | ColdStorage operations remain independent authorities. |
| Vacuum display page size | DB CLI selected-domain status adapter | Reads the existing page-size metric before invoking vacuum and combines it only for presentation | CLI owns human byte formatting | Vacuum storage operation already correctly owns page counts and need not change its result. |
| Compression/vacuum semantics | Existing ColdStorage operations | Preserve thresholds, batches, cursor, storage, and SQLite behavior | Existing domain owner | Renderer cannot alter persistence. |

## 10. Single Approved Primary-Path Design

### 10.1 Fixed design language

The presentation is an enhanced ordinary CLI. It preserves terminal
scrollback, does not clear the screen, and does not enter an alternate buffer.
Long work uses one transient progress line; completed phases become fixed text.

Fixed symbols and colors:

```text
●  active      cyan
✓  successful  green
!  warning     yellow
×  failed      red
○  skipped     dim
```

Paths, elapsed times, counters, and secondary metadata are dim. Main results
use the terminal default. No boxes, dashboard panels, charts, gradients, or
additional theme system are allowed.

TTY is human-readable. New scoped `--json` options on status, compress, and
vacuum force pure JSON.
Non-TTY preserves the current JSON shape and existing UI stderr stream. JSON
must contain no ANSI, prompts, spinner frames, or prose. Ordinary non-TTY
compress keeps its current queued-online/terminal-offline timing; only the new
explicit `--vacuum --yes` sequence waits for both requested phases.

The root CLI detects status/compress/vacuum machine mode from argv plus TTY
before one-time migration output. Migration still runs unchanged, but its
prose/progress/cursor control is suppressed for that successful machine
invocation so the DB handler remains the only stderr producer. Interactive
first-run migration retains existing feedback. Migration failure retains the
existing nonzero error path and is not converted into a success-shaped JSON
result.

### 10.2 Fixed daemon preflight

Interactive daemon detection uses this compact language:

```text
! OpenCode daemon is running (pid 18420).
  Stopping it first is recommended for faster maintenance and reliable reclaim.
? Stop daemon and continue? [Y/n]
```

Before this prompt, the CLI may use `findNonterminalMaintenanceTask` to give an
early task-ID diagnostic, but that observation never authorizes shutdown. The
daemon shutdown transition is authoritative. DB maintenance stop requests add a
private `maintenance-idle=1` query to the existing authenticated `/shutdown`
route. The default route used by `opencode daemon stop` remains unchanged and
continues to abort active maintenance at a safe batch checkpoint.

Before `ServerLock.write` publishes the daemon, the worker starts and awaits
`recoverInterruptedMaintenance()`. That function returns after proving there is
no interrupted task or after `runMaintenance` has registered
`activeMaintenance`; it does not wait for the background task to finish. The
lock therefore has no visible “recovery not yet represented” interval.

The worker also tracks one `maintenanceTransitionPending` count around both
`startMaintenance` and `resumeMaintenance`. Conditional shutdown rejects with
busy while that count or `activeMaintenance` exists, then calls
`gracefulShutdown` immediately so `shutdownInProgress` becomes visible before
the response. Start and resume each check shutdown and increment the shared
count without an intervening await. Ordering is exhaustive: visible startup
recovery or accepted start/resume blocks conditional shutdown, while accepted
shutdown blocks both producers. This closes all prompt-window races at the
owner without changing explicit daemon stop.

`Y` invokes an exported lifecycle form of the existing authenticated
`stopDaemon` behavior with the exact lock displayed by the prompt and
`maintenanceIdle: true`. The stop
owner rereads the current lock and rejects a PID/token/controlPort/dbPath change
before sending shutdown; it never silently adopts a replacement daemon. The
function returns a typed outcome and accepts a progress reporter;
`DaemonStopCommand` retains its current messages, DB TTY supplies compact
messages, and JSON mode supplies no reporter. Stop failure throws to the caller
instead of being inferred from global exit state. The existing same-owner force
phase after graceful timeout remains an existing compatibility path; this task
does not duplicate or broaden it. A conditional 409 busy result is returned to
the DB command and does not affect ordinary stop. Only a successful stop of the expected owner
permits offline maintenance. `N`
preserves the existing daemon maintenance route and prints:

```text
! Continuing through the running daemon.
  Compression is safe, but may be slower while Sessions are active.
```

The DB view writes the prompt text on the existing stderr stream, then uses a
stderr-bound line-input reader only to read the answer; it must not duplicate
the prompt onto stdout. A redirected-output test locks this stream boundary.

Plain non-TTY and `--json` never prompt and preserve current daemon routing.
For the new explicit `compress --vacuum --yes` sequence, `--yes` authorizes a
silent safe daemon stop before both operations run offline, which avoids racing
a just-completed daemon task lease with vacuum. Failure to stop is a real
failure; it never triggers an offline writer fallback.

### 10.3 Fixed compress progress

The current `MaintenanceTask` deliberately does not pre-scan a total, and
`eligibleOwners` is not a valid denominator for `processed` because the latter
also counts scanned/skipped candidates. This revision therefore fixes the
truthful no-denominator form:

```text
OpenCode database maintenance
  C:\Users\Lenovo\.local\share\opencode\opencode.db

● Compressing cold data
  [██████··············]  286,000 owners  137 MB/s  elapsed 00:31
```

The bar is an indeterminate moving pulse, not completion percentage. Online
mode polls the authenticated durable task status no faster than every 250 ms.
Offline mode renders after the existing durable checkpoint callback. Screen
updates are throttled to at least 150 ms. Throughput uses authoritative
`rawBytes` growth and monotonic elapsed time. This revision never displays ETA
or percentage and does not add a total/task protocol field.

The daemon status endpoint keeps returning committed running snapshots while a
task runs. If the persisted snapshot is terminal but `activeMaintenance` still
names that task, the endpoint awaits that exact task promise, then rereads and
returns the terminal record only after lease release and active-state cleanup.
A release failure remains a control error. Consequently, the CLI's observed
terminal response is the authoritative maintenance-idle handoff; it can request
conditional stop for vacuum without retrying 409 or inventing fallback success.

This scope adds no SIGINT/cancel protocol. Online Ctrl+C detaches the polling
CLI while the daemon task continues; offline process termination is reconciled
by the existing task/lease owner on the next status/resume command. The renderer
prints interruption recovery only when it actually reads an authoritative
`interrupted` task:

```text
! Maintenance interrupted
  Resume with: opencode db resume dbm_87cda8b3-535f-4ae5-b084-250872ede827
```

### 10.4 Fixed compress completion and physical reclaim explanation

```text
✓ Compression completed in 37.2s

  Processed     411,335 owners
  Compressed    180,476 owners
  Skipped       230,859 owners
  Failed              0
  Payload       619.1 MB → 165.8 MB
  Logical saved 453.3 MB (73.2%)

! Logical compression is complete.
  SQLite still contains 824 MB of reusable pages.
```

Labels may use the exact authoritative task vocabulary discovered in the call
trace; they must not mislabel `processed` as `compressed` if the current task
does not prove that relation.

### 10.5 Fixed compress/vacuum combination

Independent `compress` and `vacuum` commands remain. `compress` adds boolean
`--vacuum` and `--yes` options; no `db optimize` command is added.

In an interactive TTY, when existing status evidence reports meaningful
reclaimable pages after compression, the sequence asks once:

```text
? Reclaim 824 MB of physical database space now? [Y/n]
```

Approval invokes the existing vacuum operation after compress has completed.
Decline preserves compression and prints:

```text
  Physical reclaim skipped. Run: opencode db vacuum --yes
```

The prompt is offered only when `freelistPages * pageSize > 0`; there is no
hidden auto-vacuum threshold and no mutation without approval. `--vacuum`
preselects the second phase but still prompts in an interactive TTY unless
`--yes` is present. Non-TTY requires both `--vacuum` and `--yes`. The new JSON
sequence returns one object containing the completed compress task and vacuum
report; ordinary command result shapes remain unchanged.

`compress --yes` without `--vacuum` is rejected at the yargs/handler seam; it
cannot silently authorize daemon shutdown or a future reclaim prompt.

If the interactive user answered `N` to the daemon-stop prompt, the command
completes compression through that daemon and suppresses all reclaim prompting
and vacuum execution for this invocation. It prints only a compact follow-up:

```text
○ Physical reclaim skipped while daemon remains running.
  Stop the daemon and run: opencode db vacuum --yes
```

This N behavior is identical for ordinary `compress` and interactive
`compress --vacuum`: both continue compression through the retained daemon,
skip vacuum, show no second prompt, and keep the daemon alive. Only initial `Y`,
an already-offline invocation, or explicit non-interactive
`compress --vacuum --yes` can enter vacuum handling.

### 10.6 Fixed vacuum rendering

```text
● Reclaiming SQLite pages...

✓ Physical reclaim completed in 1m 08s
  Page allocation  2.00 GB → 1.18 GB
  Reclaimed pages  820 MB
```

SQLite `VACUUM` is synchronous in the owning process, so this scope prints a
fixed start line and final elapsed duration rather than inventing animation or
moving the operation to a worker. Physical bytes are calculated from the
authoritative pages-before/pages-after and the page size obtained from one
existing StatusReport immediately before vacuum. Combined compress already
holds that post-compress status report; standalone vacuum performs the same
status read through its selected daemon/offline domain. Repository search finds
no page-size setter, so the pre-vacuum page size applies to both returned page
counts. No temporary-disk estimate is added because the current interface
cannot provide an accurate requirement.

### 10.7 Fixed status rendering

```text
OpenCode database
  Path          C:\Users\Lenovo\.local\share\opencode\opencode.db
  Page allocation  2.00 GB
  Active pages     1.14 GB
  Reusable pages   824 MB

Cold storage
  Eligible now  180,476
  Cold owners   230,859
  Raw           619.1 MB
  Compressed    165.8 MB
  Saved         453.3 MB (73.2%)
  Shared        28.4 MB

Health
  Orphans       0
  Ref mismatch  0

Recommendation
  Run `opencode db vacuum --yes` to reclaim approximately 824 MB.
```

Path comes from `Database.getPath`; page allocation is
`pageCount * pageSize`, active pages are the existing `activeBytes`, and
reusable pages are
`freelistPages * pageSize`. Every other value maps directly to StatusReport.
These labels deliberately describe SQLite page accounting rather than physical
`opencode.db` stat or main+WAL disk occupancy. WAL bytes, total-owner
denominator, and corruption state are omitted because the report does not prove
them. Status must not run verify, hydrate cold payloads, or mutate the database.

### 10.7.1 Fixed task-status rendering

Interactive `db status --task <id>` uses the same compact language for daemon
and offline task records:

```text
OpenCode database maintenance task
  Task        dbm_87cda8b3-535f-4ae5-b084-250872ede827
  Operation   compress
  Status      running
  Processed   286,000 owners
  Skipped     104,221 owners
  Payload     619.1 MB → 165.8 MB
  Updated     3s ago
```

Queued/running show available counters without claiming completion. Completed
uses `✓`, failed uses `×` and the persisted `error`, and interrupted uses `!`
plus the exact recovery command:

```text
! Maintenance interrupted
  Resume with: opencode db resume dbm_87cda8b3-535f-4ae5-b084-250872ede827
```

The operation field displays the stored `compress | expand | verify | cleanup`
value. Optional detail such as repair or delete is derived separately from
`task.args.repair` or `task.args.delete`; it is never claimed to be part of the
stored operation. Zero byte counters are omitted rather than relabeled.
Non-TTY and `--json` preserve the existing raw MaintenanceTask shape.

### 10.8 Verify and cleanup preservation

`verify`, `verify --repair`, `cleanup`, and `cleanup --yes` are outside this
presentation change. They retain their current execution domain, result shape,
output contract, task timing, and storage behavior. This plan adds no compact
renderer, task polling, waiting rule, or new prompt for those commands. Existing
ColdStorage and daemon suites remain the regression authority for them.

`db status --task <id>` may render a persisted task record because that is the
explicit status command being improved; reading a task record does not alter the
producer's verify/cleanup execution contract.

### 10.9 Authoritative path

```text
DB CLI input
  -> root CLI suppresses one-time migration prose only for relevant successful machine mode
  -> parse existing command/flags at yargs seam
  -> choose pure JSON/non-TTY pass-through OR compact interactive renderer
  -> capture exact daemon owner identity and show one Y/n decision
  -> optional expected-owner stop request
  -> daemon atomically rejects active/recovering maintenance OR closes maintenance start and begins shutdown
  -> before every offline compress sequence, acquire existing daemon-election lease and recheck no replacement owner exists
  -> execute exactly one existing daemon or offline maintenance path
  -> for compress, poll the same authenticated durable MaintenanceTask online; terminal response waits for same-task lease/active cleanup
     OR render its existing checkpoint offline
  -> render truthful progress from authoritative counters
  -> render terminal result or pure JSON
  -> after completed compress and explicit user intent only, obtain StatusReport page size/freelist
  -> retained-daemon N branch ends after compress with no reclaim prompt; stopped/offline branch may invoke existing offline vacuum
```

This path changes presentation and user-facing sequencing at the owner. It does
not alter ColdStorage operation semantics or introduce a replacement writer.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Interactive TTY rendering | proposed | primary-contract branch | yes | approximately 28% | add at DB CLI seam |
| `--json` output | proposed option over current serializer | contracted pass-through | yes | approximately 5% | preserve pure result serialization and stream |
| Non-TTY output | current/preserved | contracted pass-through | yes | approximately 3% | preserve non-interactive semantics |
| Live daemon maintenance | current/preserved | supported-domain branch | yes | Existing | preserve |
| Initially offline or safely stopped -> election-held offline maintenance | proposed composition of existing paths after domain selection | supported-domain branch | yes | approximately 12% | reuse existing daemon-election owner through reclaim/vacuum |
| Failed daemon request -> offline write | forbidden | forbidden fallback | yes | zero allowed | reject |
| Completed compress -> explicitly approved vacuum | proposed | supported-domain branch | yes | approximately 12% | add at CLI orchestration seam |
| Online durable task polling | proposed | diagnostic/observability path | no independent success | approximately 8% | bounded read of the same task; terminal task remains authority |
| Full-screen stats-style renderer | rejected | forbidden duplicate presentation path | yes | zero | reject |

Estimated diagnostic decision surface is 8%, below the 10% maximum. It only
observes the authoritative task and cannot convert failure/interruption into
success. There is no new alternate-success or fallback path.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Direct raw-JSON printing for interactive status/compress/vacuum | Original command exposed domain results without a human adapter | Compact DB CLI renderer owns TTY presentation while `printMaintenance` remains the machine branch | Collapse call sites in `packages/opencode/src/cli/cmd/db.ts`; retain one raw serializer |
| No duplicate maintenance executor confirmed | daemon/offline layers already share `ColdStorage.maintain` | New orchestration must continue using them, so nothing is replaced in storage | Not applicable; preserve ColdStorage and worker |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01, INV-06, INV-09 | aggregate StatusReport or MaintenanceTask -> fixed mode-aware compact contract | Keep small formatting helpers beside the owning commands in `db.ts`; route both status forms there | Public PTY daemon/offline aggregate/task terminal/nonterminal literals |
| INV-02 | daemon 202 -> authenticated task polling; offline checkpoint -> render snapshot | Modify only `executeMaintenance`/`runOffline` in `db.ts`; no task schema change | Adapter task progression test and real PTY compress observation |
| INV-03, INV-04, INV-14 | `liveDaemon` captures owner -> one Y/n -> expected-owner `stopDaemon` -> offline or retained daemon route | Export expected-owner result in `daemon.ts`; compose in `db.ts` | Real-daemon PTY Y/N and replacement-owner tests; existing stop suite remains green |
| INV-05 | initial N -> daemon compress -> no reclaim prompt; otherwise completed offline compress -> status freelist -> approval/flag -> existing offline vacuum | Add `--vacuum`/`--yes`; reject bare `--yes`; cancel interactive explicit sequence on N | PTY N suppression, isolated offline reclaim, and machine `--vacuum --yes --json` result |
| INV-07 | mode selection before any prompt/control output | Add scoped status/compress/vacuum `--json`; machine branch keeps `printMaintenance` | Non-TTY and explicit JSON parse with no ANSI/prompt; ordinary daemon start response remains queued |
| INV-08 | selected domain StatusReport supplies page size -> existing synchronous vacuum supplies page counts -> fixed duration/byte result | `db.ts` pre-vacuum status read plus compact view | Standalone and combined output contain no percent/ETA and report worked byte delta |
| INV-10 | Goal-owned diff | Plan and implementation diff | File/line/comment audit |
| INV-11 | persisted terminal status/error remains authoritative | Polling rejects failed/interrupted; sequence checks completed before vacuum | Failed/interrupted task test and compress-failure-no-vacuum test |
| INV-12 | Verify, cleanup, expand, and standalone vacuum retain current execution/output contracts | No production path or handler is added for verify/cleanup; existing ColdStorage/daemon authorities remain unchanged | Existing cold/daemon suites and unchanged command paths |
| INV-13 | recovery registration -> lock publication; then maintenance-idle shutdown -> start/resume/active gate -> synchronous shutdown publication | Reorder startup and modify owning conditional transition in `worker.ts`; ordinary shutdown remains unchanged | Long startup recovery is active before lock visibility; conditional shutdown after visibility is busy; start/resume races and ordinary stop retain their contracts |
| INV-15 | persisted terminal task + same active task -> await exact task promise -> reread terminal record | Modify authenticated task-status handoff in `worker.ts` | Block real maintenance lease release after terminal checkpoint; status remains pending while another control request stays responsive, then returns after release |
| INV-16 | root argv/TTY machine-mode detection -> silent one-time migration -> unchanged DB JSON renderer | Modify only migration presentation in `index.ts` | Missing-marker real CLI status/compress/vacuum machine output parses as one JSON document with no ANSI/prose |
| INV-17 | initial daemon observation -> shared election lease -> owner recheck -> offline compress/reclaim/vacuum -> release | Reuse `opencode.server` election owner in `db.ts`; an owner found after acquisition aborts offline selection rather than falling back | Initially-offline PTY sequence with concurrent contender remains blocked until terminal command completion |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Compact TTY formatting helpers in `db.ts` | INV-01, INV-06, INV-09 | Explicit user contract and six-file cap | Direct JSON serialization lacks human presentation; a separate renderer module is unnecessary for this bounded command surface. |
| Throttled progress line | INV-02, INV-08 | Explicit user contract | A final task JSON does not provide ongoing feedback. |
| Interactive daemon preflight | INV-03, INV-04 | Explicit user contract | Current daemon routing does not expose the requested Y/n decision. |
| Compress/vacuum sequence | INV-05 | Explicit user contract | Independent commands require the user to manually reconstruct the intended sequence. |
| Machine-mode selection | INV-07 | Explicit compatibility contract | Human ANSI/prompt output cannot be emitted into scripts. |
| Existing task polling | INV-02, INV-11 | Worker already publishes durable batch counters and status route | Online CLI currently exits on 202 and cannot otherwise render progress or terminal failure. |
| Exported daemon stop result | INV-03, INV-04 | Existing safe stop is private and reports failure only through process-global exit state | DB orchestration needs to know whether offline execution is authorized without duplicating stop logic. |
| Indeterminate pulse bar | INV-02 | Task has no total; eligible owners are not the processed denominator | A percentage bar would be false, while spinner-only output omits the requested progress-bar affordance. |
| Pre-publication recovery registration plus conditional daemon shutdown gate | INV-04, INV-13 | Worker currently publishes lock before recovery and has one stop semantic plus async start/resume windows | Publication ordering removes the recovery gap; conditional mode protects later races without regressing explicit stop. |
| Expected-owner stop argument | INV-14 | Prompt displays one lock while current stop rereads any replacement | Existing same-owner check starts too late; the user decision must bind the first shutdown request. |
| Pre-vacuum StatusReport read | INV-08 | Vacuum result has page counts but no page size; existing status has authoritative page size | A constant would be false and changing the storage result is unnecessary. |
| Terminal-to-idle status handoff | INV-05, INV-11, INV-15 | Durable terminal checkpoint precedes worker lease cleanup | Only worker knows whether the same task is still active; CLI retries would be ambiguous and are forbidden. |
| Root migration presentation suppression | INV-07, INV-16 | Global middleware writes before DB mode adapter | `db.ts` cannot retract earlier prose; the earliest output owner must honor relevant machine mode. |
| Offline election interval | INV-05, INV-07, INV-13, INV-17 | Public `Daemon.ensure()` can publish while an initially offline DB CLI is running | The maintenance file lease does not exclude normal daemon startup/database writes; the existing daemon-election owner must serialize the domain handoff. |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `docs/plans/db-maintenance-cli-ux.md` | add | Sole canonical plan and audit/implementation evidence | Documentation; outside code budget |
| `packages/opencode/src/index.ts` | modify | Suppress one-time migration presentation only for relevant DB `--json`/non-TTY machine mode while retaining migration execution/failure | +8 to +12 |
| `packages/opencode/src/cli/cmd/db.ts` | modify | Compact status/compress/vacuum formatting, mode selection, scoped `--json`, compress task polling, offline checkpoint rendering, daemon Y/n composition, election-held offline domain selection, and completed-compress/vacuum sequencing | +330 to +420 additions-plus-deletions |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | Export the existing stop owner with optional expected lock/maintenance-idle mode, typed result/progress, and owner-change rejection; preserve standalone messages and force safety | +25 to +35 net |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | Register recovery before lock, gate conditional shutdown/start/resume, and delay same-task terminal status until lease/active cleanup | +35 to +45 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | add | Fixed literals plus isolated real-CLI PTY/non-TTY status, compress, progress, JSON, failure, and vacuum-sequence behavior | +110 to +155 additions |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | Reuse real daemon fixtures and inline published-marker system-boundary wrappers for Y/N, initially-offline election contention, recovery/start/resume races, terminal-to-idle handoff, and stop compatibility | +210 to +280 additions-plus-deletions |

No change is planned for ColdStorage, ServerLock, migration execution, schema,
stats, UI, SDK, generated files, or the existing retry-worker file. There is no
standalone renderer module. Code/test file count remains six.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Adapter and real PTY aggregate status plus daemon/offline `status --task` terminal/nonterminal records emit their fixed contracts; non-TTY/`--json` remain parseable JSON | Current command emits only raw JSON and rejects `--json` | Add mode-aware view and scoped option; route both status forms without changing verify/cleanup producers | Fixed language, full status input domain, and machine compatibility |
| 2 | Offline PTY compress shows pulse bar, increasing committed owners, elapsed time, and byte rate without percent/ETA | `runOffline` writes checkpoints silently | Observe the same post-write checkpoint in a throttled callback | Truthful progress without pre-scan/task schema change |
| 3 | Daemon PTY compress shows Y/n; owner replacement rejects stop; startup recovery/start/resume during prompt makes conditional shutdown busy; explicit daemon stop still interrupts active maintenance safely | Current lock precedes recovery, stop rereads replacement owner, and shared shutdown has no conditional gate | Register recovery before lock, bind expected lock, and gate start/resume only for maintenance-idle shutdown | Prompt cannot stop another owner/interfere with any accepted work, and standalone stop does not regress |
| 3a | An isolated interrupted task and stale lease launch a real-worker wrapper inline in `daemon.test.ts`. Following the existing retry helper precedent, its one-shot rename boundary publishes `rename-blocked` and waits on stdin. While held, daemon-lock readiness must be false; after release/retry, lock appears with recovery active, conditional shutdown is busy, and default stop still interrupts/exits | Current worker publishes lock before entering recovery, so lock absence deterministically fails while rename is blocked | Use `mock.module("fs/promises")` before dynamic real-worker import inside the test subprocess; marker/stdin controls the real task store/lease/lock/control seam without a production hook or new file | Fails on old publication order, missing conditional active gate, or regressed default stop without scheduler timing |
| 4 | Completed interactive compress offers reclaim for nonzero freelist; standalone and combined vacuum use pre-status page size and report reduction | Commands are independent and vacuum result omits page size | Add `--vacuum`/`--yes`, reject bare `--yes`, and sequence existing vacuum in the explicitly retained/stopped domain | No guessed bytes, implicit daemon stop, or vacuum after failed/interrupted compress/decline |
| 4a | Real daemon PTY runs ordinary compress and interactive `compress --vacuum`; each answers `N`, completes/polls compression, proves no reclaim prompt appears, no vacuum runs, and the same daemon PID remains alive | R8 incorrectly cancelled the explicit variant | Route both N inputs through the same retained-daemon compression branch and end after compression | The first N has one authoritative meaning across all interactive compress variants |
| 5 | Explicit non-TTY `--vacuum --yes --json` returns one parseable composite result; ordinary non-TTY compress keeps current result/timing | No combined option exists | Safe silent stop if live, then existing offline task and vacuum | New sequence does not contaminate current JSON paths |
| 5a | A daemon helper blocks real maintenance-lock removal after the completed checkpoint and publishes `lease-release-blocked`. A task-status request issued then must remain pending while a second control status request succeeds; after release, terminal task returns and conditional shutdown succeeds | Current endpoint exposes terminal before worker `finally` | Inline the existing mock-module marker/stdin pattern in daemon test; change only worker handoff | Deterministically catches the completed-to-active race without retry/fallback |
| 5b | With migration marker absent, real `db status --json` and relevant non-TTY invocation produce one parseable JSON document and no prose/ANSI while migration tables still exist | Current root middleware writes migration text before DB handler | Silence only relevant machine presentation at root owner | First-run machine contract and unchanged migration execution |
| 5c | Start a public shared-election contender after an initially offline PTY compress begins; it must remain blocked through compression and any reclaim decision, then acquire only after the CLI releases the sequence | Initial no-daemon observation is not serialized against `Daemon.ensure()` | Acquire the existing election lease before the offline writer, recheck owner absence, and release after the full sequence | Prevents a replacement daemon from publishing between offline compression and vacuum without adding a new lock or fallback |
| 6 | Existing daemon stop, daemon maintenance, cold maintenance, verify/cleanup, one-time interactive migration, and vacuum WAL tests remain green | Refactor/adapter could alter ownership or persistence | Retain exact existing operations | Threshold, cursor, lease, WAL, repair, cleanup, migration, and error semantics |

The agreed seams are the public root `opencode db ...` CLI through isolated real
process/PTY and the authenticated daemon control transition through inline
published-marker subprocess fixtures. Expected text is fixed literals from
§10, not recomputed implementation output.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 450–510 production/test code lines | Exclude imports, blank lines, formatting, generated files, pure moves, and plan text |
| Required Chinese explanatory comments `C` | 68–77 minimum for the estimated range; actual minimum is always `ceil(E * 0.15)` | Count only nearby comments explaining invariants, real boundaries, compatibility, safety, and independent test intent |

Qualifying comments must be distributed next to the relevant daemon ownership,
machine-output, truthful-progress, vacuum sequencing, and failure-path logic.
Comments that merely translate identifiers or restate obvious control flow do
not count.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode` | Compact TTY adapter, real PTY status/compress/vacuum, JSON compatibility, truthful progress, and sequence failures |
| Focused `bun test test/cli/tui/daemon.test.ts -t ...` slices listed in implementation evidence | `packages/opencode` | Existing stop/control behavior, expected-owner binding, atomic shutdown/start gate, recovery/terminal handoff, and real daemon Y/N DB preflight; the full file is omitted under the explicit R10 user authorization above |
| `bun test test/storage/cold.test.ts` | `packages/opencode` | Threshold, persistence, cursor, task counters, vacuum WAL, verify, cleanup, and storage semantics unchanged |
| `bun test test/cli/db-maintenance.test.ts` plus the focused daemon slices recorded in implementation evidence and `bun test test/storage/cold.test.ts` | `packages/opencode` | Combined goal regression under the explicit R10 long-suite omission; no repository-wide suite from root |
| `bun typecheck` | `packages/opencode` | Package type correctness |
| `git diff --check` | repository root | Whitespace and patch consistency |
| Goal-owned `git diff --stat`, `git diff --numstat`, changed-path inspection, formatting inspection, and E/C calculation | repository root | Six-code/test-file hard cap, at-most-1,250 complete footprint, readable-formatting gate, and 15% distributed Chinese comment gate |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2 total: plan and focused test | One authority document and one public behavior suite |
| Files modified | 5: root CLI, DB CLI, daemon stop owner, worker control owner, daemon test | Existing owning seams and inline deterministic system-boundary fixtures only |
| Files deleted | 0 | No duplicate implementation confirmed yet |
| Code/test files | 6 | Equals the user hard cap; the canonical plan is documentation outside the code-file count |
| Production additions-plus-deletions | 620–710 | Root machine-output owner, compact formatting/orchestration, expected-owner stop, shared-election ownership, and worker handoffs in normal readable layout |
| Test additions-plus-deletions | 350–400 | Public PTY/JSON/daemon races and inline deterministic system-boundary fixtures in normal readable layout |
| Production + test complete footprint | 970–1,250 | Explicit R14 user authorization; no packed statements, unrelated formatting, or behavior-test deletion may be used to meet it |
| Generated lines | 0 | No schema or SDK change |

The budget is an audit signal, not permission to omit confirmed behavior.

## 20. Real Risks and Open Decisions

### Confirmed or reachable risks

- Human rendering can contaminate scripts unless mode selection occurs at the
  public CLI seam before any prompt or ANSI output.
- A new stop implementation can bypass existing owner/token protections unless
  the current graceful-stop owner is reused.
- Polling can add database or control-route load unless it reads the existing
  persisted task at a bounded interval.
- Progress can mislead users if `processed`, `skipped`, or byte counters are
  relabeled without checking current task semantics.
- Compress/vacuum sequencing can start vacuum after partial or failed compress
  unless it branches only on the authoritative completed result.
- Human prompt delay allows daemon owner replacement or a concurrent task start;
  expected-owner binding and the worker's atomic shutdown gate own these races.
- Initial daemon absence is only an observation; every offline compress sequence
  must hold the shared election owner and recheck absence before writing, or a
  reconnecting TUI can publish a daemon between compress and vacuum.
- The same `/shutdown` route serves explicit daemon stop and DB maintenance;
  only the query-selected maintenance-idle mode may reject active work, and the
  gate must include both new-task and resume producers.
- Standalone vacuum has page counts but no page size; one pre-vacuum status read
  supplies the existing authoritative value without changing the result schema.
- `VACUUM` can block or require substantial temporary disk; current code and
  SQLite behavior must determine which warnings can be truthful within scope.

### Open Decisions Requiring the User

None. The user explicitly authorized an eighth full-scope plan audit and fixed
the unified interactive N behavior in §1.3, §10.5, and TDD slice 4a.

### Rejected Speculation

- A full `stats` renderer is not required to make five DB commands readable.
- A new `db optimize` command is not required; the user chose a compact
  compress/vacuum composition.
- A new task event protocol is not required; bounded polling of the existing
  authenticated durable task is the selected path.
- Codec, schema, compression concurrency, backups, and external archives are
  outside this presentation/orchestration requirement.
- A fake vacuum percentage is rejected because no authoritative denominator is
  established.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the user
  file/line budget, and the 15 percent Chinese explanatory-comment plan.
- Treat the user's explicit seventh-round authorization as a one-round exception
  to the normal six-round plan-audit limit; no further plan audit is authorized
  without another user decision.
- Treat the user's overall twelve-final-audit allowance as authorizing the
  R11/R12 full-scope scope-correction audits. The same materiality standard
  applies to every audit; the allowance does not relax any requirement.
- Treat the user's explicit R11 `≤1100` readable-footprint authorization as
  part of R12; it changes only the diff cap and formatting gate, not behavior
  scope or the six-file limit.
- Treat the user's explicit `授权 R13 审计 (Recommended)` decision as a
  one-round exception authorizing one further full-scope audit of exact R13;
  it does not change behavior, scope, materiality, or verification gates.
- Treat the user's explicit `授权 R14 提高上限至1250 (Recommended)` decision as
  a revision authorization only; R14 requires its own plan approval before the
  remaining readable-formatting work and implementation audit.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01, B-02, B-03, B-04, B-05 | Audit-mode metadata mismatch; `UI.input` prompt stream split | BLOCK — canonical plan revision R1 is not approved for implementation. | `ses_0754912f4ffeLYFirsMtp0cYSV` |
| 2 | R2 | yes | B-01, B-02, B-03, B-04 | NB-01 budget arithmetic drift | BLOCK — canonical plan revision R2 is not approved for implementation. | `ses_0753fe3e5ffeDvg2DWWFGdXdx1` |
| 3 | R3 | yes | B-01 |  | BLOCK — canonical plan revision R3 is not approved for implementation. | `ses_075374f6bffelBSHPLnO89tw0q` |
| 4 | R4 | yes | B-01 | NB-01 budget arithmetic drift | BLOCK — canonical plan revision R4 is not approved for implementation. | `ses_0753202d3ffeso3vVlXG3LChcM` |
| 5 | R5 | yes | B-01, B-02 |  | BLOCK — canonical plan revision R5 is not approved for implementation. | `ses_0752b40a1ffedN84eOSyXwgcpG` |
| 6 | R6 | yes | B-01 | `compress --yes` without `--vacuum` is not fixed | BLOCK — canonical plan revision R6 is not approved for implementation. | `ses_075229ce5ffeRb1Mtn99Eul9sx` |
| Superseded | R7 | no |  | User corrected N behavior before audit | Not audited |  |
| 7 | R8 | yes | B-01 | Special prompt text and stored-operation wording | BLOCK — canonical plan revision R8 is not approved for implementation. | `ses_074d48393ffe70PwDITITyoh15` |
| 8 | R9 | yes | No blocking findings | NB-01 root CLI argv/TTY detail; NB-02 six-file coupling; NB-03 indeterminate pulse clarity | APPROVE — canonical plan revision R9. | `ses_074c68edcffevcbwfedvQb24FD` |
| 9 | R10 | yes | B-01 conflicting implementation authorization metadata | NB-01 focused command precision; NB-02/03/04 administrative wording | BLOCK — canonical plan revision R10 is not releasable. | `ses_07477efa1ffeev3nP02LNIgWDQ` |
| 10 | R10 | yes | No blocking findings | NB-01 exact focused commands; NB-02/03/04 administrative wording | APPROVE — canonical plan revision R10 only. | `ses_074736425ffeT3JwQHSLEbj1GS` |
| 11 | R11 | yes | B-01 verify/cleanup interactive execution contract expanded beyond the original request and conflicts with INV-12 | NB-01 implementation evidence footprint stale but below the authorized cap | BLOCK — canonical plan revision R11 is not approved for implementation. | `ses_0723ead61ffe1WK52rp4UZFGA0` |
| 12 | R12 | yes | B-01 current source/tests still contain superseded verify/cleanup behavior and contradict the exact R12 scope | No blocking design finding in the reconciled plan | BLOCK — current worktree had to be reconciled before R12 approval. | `ses_07231770fffeKsc7pnX9vyi3dh` |
| 13 | R12 | yes | B-01 initially offline compress/vacuum does not exclude concurrent daemon startup | No other blocking findings | BLOCK — canonical plan revision R12 is not approved for implementation. | `ses_072228d61ffe5Cl5H0li5Iky0z` |
| 14 | R13 | yes | B-01 additional plan-audit round lacked an explicit one-round authorization | Technical primary path and traceability passed | BLOCK — exact R13 requires explicit extra-round authorization. | `ses_0721ca577ffeFpdmK7jHn8QMCB` |
| 15 | R13 | yes | No blocking findings | NB-01 uneven budget estimates; NB-02 six-file coupling; NB-03 indeterminate pulse | APPROVE — canonical plan revision R13 only. | `ses_071221b93ffediAl0wmpz6ghna` |
| 16 | R14 | yes | No blocking findings | NB-01 historical R12 wording; NB-02 estimate drift; NB-03 comment estimate stale but recalculation required | APPROVE — canonical plan revision R14 only. | `ses_06fad9a07ffej7InEq6nf4UoIb` |

Round 1 finding titles and classifications copied from the independent verdict:

- Blocking B-01: The daemon-task preflight is racy and can interrupt maintenance started during the prompt.
- Blocking B-02: The prompted PID is not bound to the daemon owner that `stopDaemon` later stops.
- Blocking B-03: The promised Ctrl+C interaction has no producer-to-consumer path.
- Blocking B-04: The fixed resume instruction invokes a new compress command instead of the resume interface.
- Blocking B-05: Standalone vacuum rendering lacks an authoritative page-size acquisition path.
- Non-blocking: The canonical metadata says `Audit mode: full-scope` while the submitted audit mode is `plan`.
- Non-blocking: `UI.input()` writes its prompt to stdout even though DB maintenance output uses stderr.
- Release verdict: **BLOCK — canonical plan revision R1 is not approved for implementation.**

R2 resolves B-01 at the daemon shutdown/start owner, B-02 by binding stop to
the displayed lock, B-03 by explicitly retaining current per-domain SIGINT
behavior, B-04 by using `db resume <taskID>`, and B-05 by mapping the existing
pre-vacuum StatusReport page size into every human vacuum rendering path.

Round 2 finding titles and classifications copied from the independent verdict:

- Blocking B-01: 共享 shutdown 端点改变了独立 `daemon stop` 的既有行为。
- Blocking B-02: 原子 shutdown gate 没有覆盖可达的 control-resume 启动窗口。
- Blocking B-03: `db status --task` 进入新的 TTY 模式，却没有固定渲染合同或敏感测试。
- Blocking B-04: 固定 status 文本把逻辑页容量标成了物理 “File size”。
- Non-blocking NB-01: 预算上界与宣称的目标范围有轻微算术漂移。
- Release verdict: **BLOCK — canonical plan revision R2 is not approved for implementation.**

R3 resolves round 2 B-01 with a query-selected maintenance-idle shutdown while
ordinary stop retains its active-task interruption contract; B-02 by gating
start and resume through one pending transition; B-03 with the fixed §10.7.1
task contract and public daemon/offline state tests; B-04 by labeling PRAGMA
values as page allocation. File-level ranges now total 620–785 lines against a
630–800 working budget and the unchanged under-1,000 hard limit.

Round 3 finding title and classification copied from the independent verdict:

- Blocking B-01: 启动恢复窗口缺少可失败的 conditional-shutdown 行为测试。
- Release verdict: **BLOCK — canonical plan revision R3 is not approved for implementation.**

R4 resolves round 3 B-01 by moving recovery registration before lock
publication and adding TDD slice 3a: a real interrupted task with enough
batch-size-one work keeps recovery active, the test reacts to lock-file
readiness, conditional shutdown must return busy, and default daemon stop must
retain its existing interruption behavior.

Round 4 finding title and classification copied from the independent verdict:

- Blocking B-01: 启动恢复竞态测试无法稳定区分旧顺序与 R4 顺序。
- Non-blocking NB-01: 预算表存在轻微算术漂移。
- Release verdict: **BLOCK — canonical plan revision R4 is not approved for implementation.**

R5 resolves round 4 B-01 with the existing deterministic
`maintenance-retry-worker.ts` boundary: the real recovery stale-lease rename
publishes a marker and blocks on stdin, the test directly proves the daemon lock
is absent while blocked, then releases recovery and tests conditional/default
shutdown behavior. The compact formatter is kept in `db.ts`, so this stronger
test remains within six code/test files and a 630–780-line budget.

Round 5 finding titles and classifications copied from the independent verdict:

- Blocking B-01: 在线压缩完成与 daemon 空闲之间存在可达竞态，组合 vacuum 可能被错误拒绝。
- Blocking B-02: 新增 `--json` 的纯 JSON 合同未覆盖首次数据库迁移输出。
- Release verdict: **BLOCK — canonical plan revision R5 is not approved for implementation.**

R6 resolves round 5 B-01 by making authenticated task status withhold a
terminal response until the same active task promise has released its lease and
cleared active state, with a deterministic blocked-release control test. It
resolves B-02 at the earlier root middleware owner by suppressing only relevant
successful machine-mode migration presentation and testing a real missing-marker
invocation. Inline wrappers remove the retry-worker file change, preserving six
code/test files and a consistent 638–777-line budget.

Round 6 finding title and classification copied from the independent verdict:

- Blocking B-01: 用户选择 `N` 后，后续回收确认仍会隐式停止 daemon。
- Non-blocking: `compress --yes` 在没有 `--vacuum` 时的含义没有单独固定。
- Release verdict: **BLOCK — canonical plan revision R6 is not approved for implementation.**

The user then explicitly authorized one seventh full-scope audit. Before that
audit, the user corrected R7: after interactive `N`, no reclaim prompt may be
shown. R8 supersedes unaudited R7, ends ordinary N after daemon compression,
cancels an explicit interactive combined sequence on N, rejects bare
`compress --yes`, and adds the complete suppression regression test.

Round 7 finding title and classification copied from the independent verdict:

- Blocking B-01: `compress --vacuum` 的首次 `N` 分支违背用户修正。
- Non-blocking: `compress --vacuum` special prompt text was not fixed; task
  operation wording should derive repair/delete display from task args; budget
  tables have minor non-hard drift.
- Release verdict: **BLOCK — canonical plan revision R8 is not approved for implementation.**

The user explicitly authorized an eighth full-scope audit. R9 removes the
competing explicit-variant cancellation branch: ordinary and `--vacuum`
interactive N both finish daemon compression, suppress reclaim/vacuum, and keep
the daemon alive. It also records task operation and repair/delete detail from
their actual separate persisted fields.

Round 8 verdict copied from the independent audit:

- Blocking findings: **No blocking findings.**
- Non-blocking NB-01: The plan remains highly implementation-sensitive at the root CLI boundary.
- Non-blocking NB-02: The plan contains several tightly coupled changes within the six-file code/test cap.
- Non-blocking NB-03: The fixed progress bar is intentionally indeterminate.
- Primary-path verdict: **PASS.**
- Release verdict: **APPROVE — canonical plan revision R9.**

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

R10/R11 implementation evidence below is superseded by the R12 scope
correction. It is retained only as historical audit context and is not current
implementation authorization or completion evidence. After R12 approval, the
implementation must remove every verify/cleanup production and test change,
then regenerate this section from the actual goal-owned diff and fresh
verification results.

### Actual Files and Diff

The prior R10/R11 implementation inventory is superseded. R12 requires a fresh
inventory after the verify/cleanup scope correction; no historical line count
below is current release evidence.

The implementation used exactly the six approved code/test files:

- `packages/opencode/src/index.ts`
- `packages/opencode/src/cli/cmd/db.ts`
- `packages/opencode/src/cli/cmd/daemon.ts`
- `packages/opencode/src/cli/cmd/tui/worker.ts`
- `packages/opencode/test/cli/db-maintenance.test.ts`
- `packages/opencode/test/cli/tui/daemon.test.ts`

No `ColdStorage`, `ServerLock`, schema, migration, stats, UI, SDK, generated
file, or retry-worker file was changed in that historical inventory. The current
R12 inventory is intentionally pending reconciliation and fresh verification.

The primary production paths are `db.ts` mode selection/rendering and
compress/vacuum orchestration, `daemon.ts` expected-owner stop, `worker.ts`
conditional maintenance-idle shutdown/start/resume/recovery/terminal handoff,
and `index.ts` machine-mode migration presentation suppression.

### Red-Green Test Evidence

- Real PTY aggregate status was red on raw JSON and green after the compact
  status renderer was routed at the public CLI seam.
- Missing-marker `db status --json` was red because migration prose polluted
  the result; root migration presentation was silenced for machine mode and
  the test is green with migration execution retained.
- Persisted task status was red on raw JSON and green for compact terminal,
  interrupted, and failed views.
- Offline compression progress was red on silent execution and green after
  durable checkpoint observation was added.
- A real SQLite trigger now fails a later offline batch after committed progress
  is visible; the PTY test proves cleanup ends the active row, emits the error on
  a new line, and never enters reclaim or vacuum.
- A reconnect election contender starts when the approved daemon PID exits and
  proves it cannot enter before the offline compression terminal renderer.
- Online terminal output is asserted after the progress newline, and the
  reclaim path asserts the fixed logical-versus-physical explanation.
- Live daemon compression was red without a prompt and green for the fixed N
  behavior; the same regression now covers ordinary and `--vacuum` variants,
  prompt-time owner replacement, and the successful Y stop/offline path.
- Conditional maintenance-idle shutdown was red with HTTP 200 during active
  work and green with HTTP 409 while ordinary daemon stop remains functional.
- Interactive reclaim, standalone vacuum rendering, machine combined
  `compress --vacuum --yes --json`, and bare `compress --yes` rejection are
  green.
- The deterministic real-worker recovery/terminal-handoff test first exposed
  the native filesystem mock delegate recursion and an over-specific path
  matcher; both were corrected before the final green run.

### Verification Commands and Results

- `bun test test/cli/db-maintenance.test.ts` from `packages/opencode`: **8
  passed, 0 failed, 31 assertions**.
- `bun test test/cli/tui/daemon.test.ts -t "db compress variants keep the daemon"`
  from `packages/opencode`: passed.
- `bun test test/cli/tui/daemon.test.ts -t "maintenance-idle shutdown refuses active work"`
  from `packages/opencode`: passed.
- `bun test test/cli/tui/daemon.test.ts -t "daemon startup resumes an interrupted"`:
  passed with 15 assertions.
- `bun test test/cli/tui/daemon.test.ts -t "daemon maintenance control persists and completes"`:
  passed with 5 assertions.
- `bun test test/cli/tui/daemon.test.ts -t "refuses force stop when the lock owner changes after graceful timeout"`
  from `packages/opencode`: passed.
- `bun test test/storage/cold.test.ts` from `packages/opencode`: **31 passed,
  0 failed**.
- `bun typecheck` from `packages/opencode`: **passed** (`tsgo --noEmit`).
- `git diff --check` from repository root: **passed**; only Git's existing
  LF/CRLF normalization warnings were emitted.
- `bun test test/cli/tui/daemon.test.ts -t "SIGTERM triggers graceful shutdown and clears the lock file"`:
  passed with 1 assertion.
- The full `test/cli/tui/daemon.test.ts` file was not rerun because the user
  explicitly reported that this long lifecycle suite can occupy roughly
  forty minutes. The goal-owned real daemon slices were run separately; the
  remaining full-suite verification is an explicit residual item for the
  implementation auditor, not represented as passed here.

### Original Feedback-Loop Result

The original observable failure was reproduced through isolated real CLI/PTY
processes: `db status`/`db status --task`/`db compress`/`db vacuum` exposed raw
JSON or no progress, and a live daemon offered no user decision before the
maintenance request. The red tests above capture those public symptoms rather
than asserting helper internals. The green paths retain the existing task,
cursor, lease, threshold, and storage operation owners.

### Actual Secondary and Replacement Path Inventory

- Normal machine mode still calls the existing daemon control or offline
  executor and prints one JSON value.
- Human daemon compress polls the same authenticated durable task; it does not
  create a second executor or a second task protocol.
- Interactive N retains the daemon and ends after compression; it never enters
  reclaim prompting or vacuum.
- Interactive Y or offline compression reads the authoritative status report,
  asks once about reusable pages, and invokes the existing vacuum operation.
- Explicit machine `compress --vacuum --yes` safely stops only the expected
  daemon owner, then runs the existing offline compress and vacuum sequence.
- Failed/interrupted task results stop before vacuum; no failure-to-success
  fallback exists.
- Standalone vacuum preserves its existing selected daemon/offline execution
  domain and changes only the human renderer.

### Superseded R13 Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 944 | Independent R14 additions-only calculation excludes imports, blank lines, comments, generated content, and pure formatting/move lines. |
| Qualifying Chinese comment lines `C` | 142 | Independent classification excludes identifier translations, obvious-flow restatements, repeated test names, and padding. |
| Ratio `C / E` | 15.04% | `142 / 944`; the strict minimum is met exactly. |
| Required minimum `C` | 142 | `ceil(944 * 0.15)`. |

### Superseded R13 Implementation Evidence

- Approved plan route: R13 is the exact approved revision from plan audit
  invocation `ses_071221b93ffediAl0wmpz6ghna`, with verdict `APPROVE — canonical
  plan revision R13 only.`
- Goal-owned code/test paths are exactly six:
  `packages/opencode/src/index.ts`,
  `packages/opencode/src/cli/cmd/db.ts`,
  `packages/opencode/src/cli/cmd/daemon.ts`,
  `packages/opencode/src/cli/cmd/tui/worker.ts`,
  `packages/opencode/test/cli/db-maintenance.test.ts`, and
  `packages/opencode/test/cli/tui/daemon.test.ts`.
- Gross readable diff footprint is **1,100 lines** across those paths. The
  `≤1,100` cap is satisfied after excluding the separately tracked plan file.
- This entire implementation evidence block is superseded by R14. The R14
  implementation evidence must be regenerated only after R14 plan approval and
  the normal readable expansion under the new 1,250-line cap.
- R13 red-green evidence: the initial-offline election test first failed with
  `Expected: false / Received: true` when a contender acquired
  `opencode.server` before offline compression completed; after acquiring the
  existing election before the offline writer and rechecking the owner, it
  passed with 1 test and 4 assertions.
- The initial-offline path uses the existing `opencode.server` election only;
  it adds no second lock protocol, fallback executor, task producer, or storage
  owner. The machine `compress --vacuum --yes` path holds the same election
  through compression and vacuum.
- The superseded verify/cleanup interactive task/report path was removed. Their
  existing `executeMaintenance` behavior remains unchanged; `db status --task`
  only renders already persisted task records.
- Focused verification is complete for CLI behavior, live daemon N/Y behavior,
  maintenance-idle gating, durable task completion, startup recovery,
  replacement-owner refusal, graceful SIGTERM lifecycle, ColdStorage, package
  typecheck, and patch consistency.

### R14 Implementation Evidence

- Approved plan route: R14 is the exact approved revision from plan-audit
  invocation `ses_06fad9a07ffej7InEq6nf4UoIb`, with verdict `APPROVE — canonical
  plan revision R14 only.`
- Goal-owned code/test paths remain exactly six: the existing `index.ts`, DB CLI,
  daemon stop, worker, CLI maintenance test, and daemon lifecycle test paths.
- Gross readable diff footprint is **1,222 lines** across those six paths,
  below the R14 hard cap of **1,250**. No behavior test was deleted to meet it.
- R14 readable expansion covers task/status declarations, maintenance option
  shapes, vacuum validation, command request construction, machine stream reads,
  variant/Y/N fixtures, recovery rename/rm boundaries, and terminal wait loops.
  Independent statements are now separated without adding a second executor or
  changing the public seam.
- Strict additions-only comment calculation: `E = 944`, `C = 142`, required
  `ceil(944 * 0.15) = 142`, ratio `15.04%`. Imports, blank lines, generated
  content, and formatter-only/pure-move lines are excluded; comments are
  distributed at actual ownership, transport, progress, cleanup, recovery, and
  behavioral-test boundaries.
- Focused verification from `packages/opencode`:
  - `bun test test/cli/db-maintenance.test.ts`: **8 passed, 0 failed, 31 assertions**.
  - daemon N/Y slice: **1 passed, 0 failed, 18 assertions**.
  - maintenance-idle gate: **1 passed, 0 failed, 7 assertions**.
  - startup recovery: **1 passed, 0 failed, 15 assertions**.
  - durable maintenance: **1 passed, 0 failed, 5 assertions**.
  - replacement-owner refusal, serial rerun: **1 passed, 0 failed, 5 assertions**.
  - graceful SIGTERM lifecycle: **1 passed, 0 failed, 1 assertion**.
  - `bun test test/storage/cold.test.ts`: **31 passed, 0 failed, 169 assertions**.
  - `bun typecheck`: passed (`tsgo --noEmit`).
  - `git diff --check`: passed; only existing LF/CRLF normalization warnings.

### Remaining Unverified Items

- Full `bun test test/cli/tui/daemon.test.ts` was intentionally not rerun due
  to the user's long-test constraint; focused real daemon slices passed.
- No repository-wide test, build, generated SDK, migration generation, or
  package outside `packages/opencode` was run because the approved scope does
  not touch those paths.
- The independent implementation auditor must verify the complete R14 diff,
  including the initial-offline election path, all affected daemon consumers,
  the six-file boundary, the E/C calculation, and the focused commands above.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R9 | yes | B-01 Chinese comments; B-02 line footprint; B-03 root argv scope; B-04 fixed text drift; B-05 verification; B-06 unrelated diff | NB-01 audit metadata | BLOCK — exact R9 implementation diff is not releasable. | `ses_0748e3c78ffeX6INTFIhJsQupP` |
| Plan re-audit | R10 | yes | No blocking findings | NB-01 exact focused commands; NB-02/03/04 administrative wording only | APPROVE — canonical plan revision R10 only. | `ses_074736425ffeT3JwQHSLEbj1GS` |
| 2 | R10 | yes | B-01 recovery failure publication; B-02 prompt owner test; B-03 start/resume pending tests; B-04 response assertions | NB-01 stale command pattern; NB-02 preferred range | BLOCK — current R10 implementation requires correction. | `ses_0744f09e2ffew7JG8J1ZfHVwsq` |
| 3 | R10 | yes | B-01 mismatched throughput intervals; B-02 missing final owner reread; B-03 progress cleanup and failure test; B-04 interrupted heading drift; B-05 missing successful Y path | No non-blocking findings | BLOCK — current R10 implementation requires correction. | `ses_07437b643ffe4uGrEDHScn8MLl` |
| 4 | R10 | yes | B-01 interactive verify/cleanup raw JSON; B-02 replacement daemon handoff window; B-03 terminal renderer before progress finalization; B-04 missing logical/physical explanation | No non-blocking findings | BLOCK — the exact current R10 implementation diff is not releasable. | `ses_0741d2da4ffeuT27XhAwoDT7qh` |
| 5 | R10 | yes | B-01 interactive repair/delete task-backed results rejected by immediate-report adapter; B-02 unrelated/packed formatting changes | NB-01 one cleanup TOCTOU race on first focused retry | BLOCK — the exact current R10 implementation diff is not releasable. | `ses_073f7cd3affe0OI25Hu44LXphD` |
| 6 | R10 | yes | Pending |  | Not submitted |  |
| 7 | R13 | yes | B-01 readable-formatting gate; independent fixture/control/assertion steps remained packed | No blocking behavioral findings; E/C gate passed | BLOCK — exact R13 implementation diff was not releasable. | `ses_070ff7a15ffeL2I4OpkPQkupYA` |
| 8 | R13 | yes | B-01 remaining packed production/test operations; B-02 only 108 Chinese comment candidates for required 110 | NB-01 stale footprint evidence; NB-02 unrelated initial worktree changes | BLOCK — exact R13 implementation diff was not releasable. | `ses_070e1def6ffefD7EFkrXbhqeHN` |
| 9 | R13 | yes | B-01 remaining packed option/fixture/loop declarations | No other blocking findings; E/C passed at 111/727 | BLOCK — exact R13 implementation diff was not releasable. | `ses_070c2d9e3ffejFC1x34H356Ppl` |
| 10 | R13 | yes | B-01 one packed recovery rename gate; B-02 strict additions-only comment ratio | Stale evidence wording only | BLOCK — exact R13 implementation diff was not releasable. | `ses_070b3353dffeVtdtAMN8lK00Ub` |
| 11 | R13 | yes | B-01 packed recovery fixture operations; B-02 strict additions-only comment ratio | No other blocking behavioral findings | BLOCK — exact R13 implementation diff was not releasable. | `ses_06fc12bf0ffevfS4aUfGRZJvVI` |
| 12 | R14 | yes | No blocking findings | NB-01 full daemon file omitted under explicit authorization; NB-02 first parallel replacement-owner selector was rerun serially and passed; NB-03 unrelated initial worktree changes excluded | APPROVE — exact current implementation diff is releasable against approved plan revision R14. | `ses_06f800663ffe1CTS0WgRe9hVII` |

R13 implementation audits are historical and exhausted. R14 has a separate
plan-audit gate and, after approval, one authorized implementation-audit round.

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

