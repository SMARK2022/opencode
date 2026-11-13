# Daemon Control-Plane and Runtime Stability

- Revision: R6
- Status: implementation-verified
- Approved revision: R6
- Implementation allowed: yes
- Final full-scope audit result: No blocking findings; round-three blocker review approved the current simplified implementation
- Verified at: 2026-11-13
- Verified revision: R6
- Planning-only round: no
- Canonical plan: `docs/plans/daemon-control-plane-stability.md`
- Required terminal state: independent full-scope plan approval, followed by a
  separately authorized implementation and independent implementation audit
- Production diff budget: target 1,090 added+deleted lines; hard maximum 1,200
- Test diff budget: target 720 added+deleted lines; hard maximum 800, counted
  independently from production
- Chinese explanatory-comment gate: `E = 0 => C = 0`; otherwise
  `C >= max(1, ceil(E * 0.15))`
- Daemon, lock, and real-database access during planning and verification: forbidden

This revision supersedes R5. It removes the rejected auxiliary GlobalRuntime and
maintenance child-process design, replacing them with one shared global-config
reader, heavy-work Worker threads, and a queued database gate. Earlier approvals
remain historical and do not authorize R6.

## 1. Verbatim Requirement

The original constraints remain part of the requirement:

> 就是你看现在这个情况，我经常发现我们本地的这个 DAEMON 出现一个断连等各种各样的一些情况，所以我觉得可能是本地负载比较高啊，还是说怎么样？但是这个 session 不是在本地发生的，这个是在一个远程服务器上，但是你拿不到那个服务器，所以你就直接对着这个看就 OK。你看现在这个情况。因为当前这么一套问题确实比较严重，也就是说这个 DAEMON 它一直在遇到这种高强度的卡顿，巴拉巴拉的。然后请你保持 read only。我希望就是不同的这种业务模块啊，巴拉巴拉，互相结偶，就是避免一个高负载的东西，然后把其他本来不应该去在乎它的东西给它打爆了。就譬如说后台在导出一个这种大的这种文件，但是导出文件本身应该由 DAEMON 的业务模块所负责，不应该由它的这种逻辑模块所参与。所以按理来说这种 DAEMON 啊等等各种东西，它应该是有一个这种分——就是你可以理解成分开的这种架构，或者说是这种多线程的这种感觉。就按理来说它的消息循环不应该是完全堆砌在一块，导致发生这种业务阻塞的，请你注意这么一点。也就是说不同业务本身按照逻辑来讲，它最大不了就加一个什么锁啊，然后让不同业务之间去有一个消息队列处理机制。但是主逻辑就像是这种基础的 health 的这种回应啊，或者说这种 TUI 的一些基础的这种低负载的回应，应该是保持流畅的，请你看一下到底什么情况。你可以在内存中进行一些测试啊，验证啊，等等一些情况。
>
> 与此同时，你不要直接去运行启动 OpenCODE，因为你如果启动的话，就会遇到两个 daemon 互相冲突的问题，所以那种情况下是不被允许的。也就是说你不要自己去手动启动这个二进制文件。你可以自己在运行时里面去运行一些部分模块去进行测试，巴拉巴拉的。也就是避免影响现在的运行时的一些这种行为。
>
> "D:\Temp\opencode\session-ses_e326.md"

> 我希望在800行的增删之间修改完成，readonly或者在你的缓存区D:temp opencode里面实验，保持准确高效，不要过大改变接线等逻辑，你可以适当在一定程度上改变架构和那些不必要的负载流程，隔离负载等内容，保持主daemon的稳定性：
>
> 按照docs/guide/workflow.md的内容进行，最终为verified plan，不进行工作区的除了文档之外的修改

> 注意是新增，不是修改既有的

The later handoff explicitly required checking the complete Gemini analysis,
including startup configuration, health classification, Token counting,
synchronous SQLite, cold-history decode, full-history responses, maintenance,
SSE, compression, cooperative yielding, and worker/process isolation. The direct
budget clarification is preserved verbatim:

> 那于子同事请你注意一点，呃我的预算要求，我指的并不是说你所有的内容修改全部是800行。我指的是你的生产代码的增删是800行以内就OK了，测试代码你当然也可以800行，就是测试代码是另算的啊，就是你不要过就OK。然后请你注意这一点，然后你去完整按照如上Gemini的内容去进行一下检查，因为你当前其实众多核心内容你都没有涉及到，所以按理来说你应该去检查一下，分析一下，看一看。而且当前你也为了一些边界的 blocker 内容去过度地去调整了一些其实本身不是很严重的一些问题，请你注意这点。

The latest budget update is:

> 如果你觉得当前的800行修改的生产代码预算不够，我也可以给你提高到1200行。但请注意，你修改的东西要保持核心，避免去把一些收益性较低的东西你反复去接线，导致实际上你1200行的收益远低于800行。

The latest architectural course corrections are:

> 不要在这个地方一直防御性防御性防御性，它很多东西都本身在一条核心路径上，修改就OK了。你不要再去加什么各种各样的一种什么 runtime。你什么意思啊，我搞不懂啊。按理来说什么首次构建会打开 database，什么叫首次构。哎呀，按照我的理解，所有的入口都在一块儿的，你直接一修改掉，所有都能受益。你不要再去改A，改B，改C，改D。你直接改一个核心点，改O不就，A、B、C、D就泛化了吗？你非得改那么多干什么呀，操。

> 你报一个错误是干什么的？我就很好奇一点了，你报错误，那我用户端我会感受到这个错误吗？还是说什么意思。

> 我就很奇怪了，你为什么要把控制面健康监听独立渲成化，而不是把那些重负载去监听化去独立渲成化呢？你这样做本身它如果用户做东西卡顿还是卡呀。你这是在干什么呢呀？用户要的是什么？你再说一遍，重复一遍。Gemini已经给你清晰的回答了。不要把问题复杂化我再说一遍。

These course corrections require the main Daemon to keep the control plane while
heavy work moves to Workers/queues; they reject an auxiliary GlobalRuntime, a
separate health-listener architecture, and a user-visible maintenance-busy
fallback. Waiting caused by load isolation must preserve normal request success
rather than surface a maintenance-specific error.

The user also supplied `D:\Temp\opencode\session-ses_e326.md` as the remote
incident record. It is contextual evidence, not a locally reproducible trace.

## 2. Explicit Non-Goals

- Starting OpenCode, starting a real Daemon, publishing a second owner, or
  touching the real lock/database is excluded from planning and verification.
- R6 does not rewrite every `Database.withSync` callback into a remote SQLite
  actor protocol. Twelve files contain domain-specific synchronous callbacks;
  that migration requires its own plan and compatibility design.
- A permanent health/control Worker is deliberately absent: the control plane
  stays on the main Daemon, and the measured heavy work moves out instead. A
  universal read-only SQLite pool is follow-up architecture, not a prerequisite.
  R6 moves maintenance SQL into a dedicated maintenance Worker and cold decoding
  into codec Workers, while ordinary short database calls remain in the Daemon.
- Provider-body caching by message ID, speculative fast paths for Token string
  counting, and provider transport serialization changes are excluded.
- Public SSE event schemas, delta ordering, viewer redaction, and reconnect
  contracts must remain compatible. R6 does not drop deltas to recover queues.
- Provider-body streaming and general export-file rewriting are excluded. The
  existing no-limit `session.messages` HTTP response becomes a streamed JSON
  array assembled from bounded pages; limited pages keep the buffered contract.
- Bun-specific `server.timeout(req, 0)` wiring is inapplicable to the current
  Node HTTP backend and is not introduced.
- New exports, plugins, provider features, and unrelated UI changes are excluded.

These boundaries do not remove any measured runtime source from R6: SQLite
maintenance and VACUUM move out of the Daemon; cold read transactions are
shortened and decoded off-thread; full-history page loops yield; large response
compression becomes asynchronous; SSE receives shared serialization and bounded
slow-client handling. A residual generic SQLite-lock stall is explicitly left
for the full SQLite actor plan rather than claimed as fixed by R6.

## 3. Repository Context

Runtime dependencies remain Schema -> Core/Protocol -> Server. `packages/core`
owns SQLite, cold codecs, cold-store integrity and maintenance algorithms.
`packages/opencode` owns Config, discovery, HTTP/SSE composition and Daemon
lifecycle. `packages/tui` owns client batching and reconnect behavior.

Relevant local instructions require targeted tests from package directories,
`bun typecheck` from package directories, no tests from repository root, minimal
single-purpose abstractions, Effect service ownership at stable layer boundaries,
and Chinese explanatory comments adjacent to non-obvious constraints.

The current Node HTTP server is assembled through `createNodeHttpServer`; the
private control listener uses `Bun.serve`. These are different transport seams.
The plan does not move a route between ports as a substitute for moving work.

## 4. Files and Evidence Read

| Area | Evidence |
| --- | --- |
| Client initialization | `packages/opencode/src/cli/cmd/tui.ts:422-434,595-668,680-725`; `packages/opencode/src/cli/upgrade.ts:21-36` |
| Global Config | `packages/opencode/src/config/config.ts:141-328,677-712`; `packages/opencode/src/effect/app-runtime.ts:62-126` |
| Health/discovery | `packages/opencode/src/cli/tui/server-lock.ts:155-192`; `packages/opencode/src/cli/cmd/tui.ts:561-668` |
| SQLite | `packages/core/src/database/sqlite.bun.ts:56-69,154-168`; `packages/core/src/database/database.ts` |
| Cold reads | `packages/opencode/src/session/message-v2.ts:590-640,1229-1253`; `packages/core/src/storage/cold-store.ts:1528-1590` |
| Cold codec/Workers | `packages/core/src/storage/cold-codec.ts:295-325,1334-1507` |
| Full-history HTTP | `packages/opencode/src/session/session.ts:855-872`; `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:205-206` |
| Maintenance | `packages/core/src/storage/cold-store.ts:1788-1858,2820-2833`; `packages/core/src/storage/cold-maintain.ts:487-569`; `packages/opencode/src/cli/tui/worker.ts:105-218` |
| Existing offline executor | `packages/opencode/src/cli/cmd/db.ts:480-532,538-735` |
| Compression | `packages/opencode/src/server/routes/instance/httpapi/middleware/compression.ts:31-64` |
| SSE | `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:19-85`; `handlers/event.ts:13-94`; `packages/core/src/event.ts:110,154-168` |
| Client recovery | `packages/tui/src/context/sdk.tsx:70-189`; `packages/tui/src/context/data-deltas.ts:1-59`; `packages/tui/src/context/sync.tsx:923`; `packages/tui/src/routes/session/index.tsx:522` |
| Queue semantics | Effect `Queue.offerUnsafe`, `failCauseUnsafe`, `endUnsafe`; `Stream.callback` buffer options; existing `EventV2.allBounded` |
| Token | `packages/core/src/util/token.ts:250-253`; `packages/opencode/src/session/llm.ts:366-389`; `packages/opencode/src/session/processor.ts:1233-1254` |
| Remote context | `D:\Temp\opencode\session-ses_e326.md` |

No production or test file has been modified in this planning round.

## 5. Current Behavior

1. A new client resolves global network settings through full Config, which is
   in the same layer dependency graph as Account and Database. After a successful
   discovery, the delayed updater again calls full `Config.Service.getGlobal()`.
2. `ServerLock.ping` converts timeout, HTTP 401, wrong version, malformed health
   JSON and network failure into `false`. Discovery therefore cannot distinguish
   a transient busy event loop from a deterministic incompatibility.
3. `bun:sqlite` executes statements synchronously. `busy_timeout = 30000` permits
   a native lock wait to prevent JavaScript timers, HTTP and SSE from running.
4. Message hydration selects rows and decodes cold payloads inside synchronous
   database reservations. Decode includes zstd, integrity checks and JSON parse.
5. No-limit `MessageV2.stream` repeatedly reads 50-message pages, accumulates all
   messages and returns one array. HTTP then serializes the complete array and
   the compression middleware may synchronously gzip/deflate it.
6. Maintenance `run(() => ...)` reserves the current database connection but does
   not move `verify` or `VACUUM` off the JavaScript thread. The existing pack
   Worker pool performs encoding, not ordinary cold-read decoding.
7. `/global/event` and `/event` serialize an event separately for every client.
   `/event` has two explicit unbounded queues; the global `Stream.callback` has
   no explicit capacity or overflow policy.
8. The client already batches rendering every 16 ms and concatenates adjacent
   deltas without changing their order. A new SSE connection emits
   `server.connected`; SyncProvider and the session route use it to refresh state.
9. Token string sizing walks escaped strings with a regular expression. The
   provider later performs its own request serialization.

## 6. Supported Input Domain and Reachability

R6 covers:

- first-time and repeat discovery, same-process owner replacement, authenticated
  loopback health, wrong version and unauthorized responses;
- a remote/already-running Daemon client with autoupdate both enabled and
  disabled, including the delayed updater after discovery;
- hot and cold Message/Part rows, legacy envelopes and packed envelopes, viewer
  and complete projections, hidden rows and corrupt content;
- empty, one-page and multi-page histories, explicit limits and no-limit reads;
- gzip, deflate, identity, HEAD, streaming exclusions and high-entropy bodies;
- multiple SSE clients, viewer/full variants, slow consumers, overflow,
  reconnect, heartbeat and ordered text/reasoning/tool-input deltas;
- immediate status/verify/cleanup/vacuum, task-backed compress/expand/verify,
  resume, abort, parent exit, Worker failure and stale interrupted tasks;
- ordinary and escaped Token strings.

Reachability is established by the actual TUI updater, HTTP route handlers,
GlobalBus/EventV2 listeners and Daemon control routes. Offline `opencode db` is
a real consumer of the shared maintenance executor. CLI-only export is not used
as evidence that server-side no-limit reads are unreachable.

## 7. Required Invariants

- A live compatible owner is never replaced merely because a probe timed out.
  Only discovery reuse retries; `connectionInfo` remains one observation.
- Authentication, version and identity failures return precise errors without
  retry delay. Every reuse attempt rechecks the owner token before reuse.
- A pure remote client never initializes a local Database through discovery or
  the delayed updater.
- One maintenance task has one lease owner and one durable task identity. Only
  the maintenance Worker executes maintenance SQL; the parent queues its own DB
  work while the Worker owns a SQL reservation and never falls back to local SQL.
- Parent database admission is asynchronous and resumes after release. Daemon
  maintenance never produces a user-visible maintenance-busy error on ordinary
  business requests.
- SQLite commit precedes durable checkpoint publication. Abort is observed at
  batch boundaries and records `interrupted`; resume keeps taskID/cursor scope.
- Cold reads preserve row selection, visibility, order, integrity and corruption
  failures. No synchronous decode fallback is added after a Worker failure.
- Every published delta is either delivered in order or the affected SSE stream
  terminates and reconnects for refresh. Queue overflow never silently continues.
- Viewer and full SSE payloads never share a serialization variant incorrectly.
- Existing response schemas and Token estimates remain semantically equivalent.
  No-limit `session.messages` keeps the same JSON array value and chronological
  order while changing only transport materialization; limited responses retain
  existing compression behavior.

## 8. First Divergence and Root Cause

### Startup divergence

The first startup-only branch is global Config resolution before owner reuse.
The later divergence is the updater's full Config request after reuse. The fix
therefore has one lightweight global owner shared by both call sites.

### Runtime divergence A: native synchronous work

`sqlite.bun.ts` is the first native lock-wait boundary. A local two-connection
probe with a 600 ms test busy timeout produced:

```json
{"elapsedMs":694,"heartbeatCount":0,"error":"database is locked"}
```

The zero heartbeat count, rather than a zero-duration claim, demonstrates that
the timer did not run during the native wait. R6 removes the identified long
maintenance SQL from the Daemon's JavaScript thread, queues parent database
access while a maintenance SQL reservation is active, and shortens cold-read
reservations. The generic actor migration for every ordinary short call remains
separately scoped in section 2.

### Client global-config divergence

R4/R5 showed that wrapping the old Config service in another runtime still builds
the complete AppLayer, including Database. R6 removes that auxiliary runtime. The
shared core is one plain `readGlobalConfig` implementation: discovery and the
updater call it directly, and full Config uses the same implementation for its
cached global state. No service registration, AppRuntime invocation, Database
layer or Account layer is reached by these read-only paths.

### Runtime divergence B: cold decode inside a database reservation

`message-v2.ts` calls `ColdStorage.inspectMessageRows` and `inspectPartRows` in
synchronous boundaries. `cold-codec.ts` then decompresses synchronously. An
8.8 MB cold envelope took approximately 43 ms to decompress and parse, with no
heartbeat callback during that segment.

### Runtime divergence C: response serialization and compression

The no-limit route materializes the full array before response serialization.
For a 13.2 MB high-entropy payload, the local probe measured approximately:

| Operation | Maximum event-loop gap | Total operation time |
| --- | ---: | ---: |
| `gzipSync` | 331 ms | 360 ms |
| asynchronous gzip | 14 ms | 352 ms |

This replaces R3's low-entropy sample, which did not expose the same cost.

### Runtime divergence D: cooperative scheduling

Five synthetic synchronous batches produced these health-response timings:

| Yield strategy | Health response |
| --- | ---: |
| microtask-only | about 105 ms |
| `Effect.yieldNow` | about 62 ms |
| `Bun.sleep(0)` | about 20 ms |

R6 uses a macrotask yield between pages. `Effect.sleep(0)` was also probed and
completed before the queued timer, so it is not the selected yield mechanism.

### Runtime divergence E: fan-out and queue growth

Both SSE handlers stringify per connection. The explicit unbounded queues and
unconfigured global callback permit producer speed to determine memory growth.
The primary fix is shared immutable-event serialization plus explicit overflow
termination, not silent delta loss.

### Token feedback

| Payload | Current | Native JSON length | Tested fast path |
| --- | ---: | ---: | ---: |
| Escape-heavy | 122.59 ms | 27.5 ms | 29.43 ms |
| Ordinary text | 8.61 ms | 8.33 ms | 8.57 ms |

R6 retains native JSON string length only. The extra regular-expression scan in
the proposed fast path did not improve the result.

## 9. Responsibility and Seam

| Work | Owning seam |
| --- | --- |
| Global config read | New plain `readGlobalConfig` implementation shared by full Config, discovery and updater |
| Discovery and updater | `tui.ts` and `upgrade.ts` call the plain reader directly; no auxiliary runtime exists |
| Health classification | `ServerLock.ping`; retry orchestration stays in `tui.ts` reuse |
| Cold read snapshot | ColdStore prepares immutable rows/payload jobs in one deferred transaction |
| Cold CPU work | Existing `cold-codec.ts` Worker entry, extended with read-decode RPC |
| Page scheduling | `MessageV2.stream` uses `Bun.sleep(0)` between pages |
| HTTP compression | Existing middleware using async zlib through `Effect.promise` |
| SSE serialization/overflow | Shared handler-local serialization helper; EventV2 bounded stream and bounded GlobalBus callback |
| Maintenance SQL | Shared offline executor running in a dedicated Worker thread with its own Database connection |
| Database admission | Core database gate queues parent DB execution while the maintenance Worker owns a SQL reservation |
| Maintenance control | Parent Daemon supervises the Worker, accepts/resumes/stops and reports durable state |
| Token sizing | Private `stringChars` implementation |

Database connections, leases and instance state do not cross Worker threads.
The maintenance Worker deliberately owns its database connection and lease. The
parent owns only supervision, admission gates and control responses.

## 10. Single Approved Primary-Path Design

### A. One shared global-config reader through the complete client path

Add one exported async `readGlobalConfig` function in the existing
`config/config.ts`. It owns the current global-file selection, default schema
seeding, JSONC/TOML compatibility loading, variable substitution, plugin spec
resolution and V2 compatibility decode, returning the existing `ConfigV1.Info`
shape. It uses file/config primitives directly; it has no Effect service,
AppRuntime, Account, Database or cache dependency and does not create a second
module boundary.

Full Config's existing `loadGlobal` delegates to this same-file function and
keeps the current ScopedCache, invalidation, update and logging behavior in the
Daemon. `cli/network.ts` exposes a Promise-returning global-network resolver
built on the same reader, while retaining the existing Effect wrapper for
web/serve/acp.
Discovery's default dependency calls the Promise resolver directly; `upgrade()`
calls the same reader directly. Thus the two remote-client paths share the same
implementation without constructing AppRuntime. The acceptance path includes the
post-discovery updater with `autoupdate:false`, proving that a disabled network
update still does not initialize local DB.

### B. Classified health with bounded timeout-only retry

Return a structured result from `ServerLock.ping`:

```text
"ok" | "timeout" | "unauthorized" | "mismatch" | "unreachable"
```

- `ok`: healthy JSON and exact current version.
- `timeout`: request/body deadline or abort timeout.
- `unauthorized`: HTTP 401/403.
- `mismatch`: wrong version, unhealthy/malformed successful response.
- `unreachable`: connection failure and other deterministic non-OK responses.

`inspectDaemonOwner` exposes the classification while retaining the stopping
check and token reread. `connectionInfo` maps only `ok` to `responsive:true` and
performs one probe. Discovery reuse performs an initial probe plus at most three
retries only for `timeout`, sleeping 500 ms, 1,000 ms and 2,000 ms between them.
Each attempt repeats owner inspection and token validation. Other results fail
immediately with category-specific messages. Exhausted timeout retries fail as a
timeout while preserving the live owner; they never clear its lock or spawn a
replacement. The spawn-readiness direct call checks for `result === "ok"`; it
does not inherit the reuse backoff.

### C. Cold-read snapshot and Worker decode

Add a read-decode RPC to the existing cold-codec Worker entry. Reuse the current
zstd, digest, envelope and corruption-validation functions; do not create a
second decoder. A small lazy reader pool, separate from the maintenance-owned
pack encoder lifecycle, has bounded pending work and transferable exact copies
of Buffer views. Worker errors reconstruct the typed corruption/codec failure;
the current request fails and a later request may lazily create a fresh pool.

ColdStore gains an async inspection path with three explicit stages:

1. In one deferred database reservation, select the requested Message and Part
   rows, validate reference metadata, and copy content-addressed payload bytes,
   locators and integrity metadata into immutable decode jobs.
2. Release the database reservation. Workers decompress, verify and parse the
   jobs concurrently within the bounded pool.
3. On the main thread, restore rows with the existing pure restore/projection
   helpers, preserving original row/Part order and viewer/hidden behavior.

Because payload bytes and owner rows are copied before release, later thaw or
cleanup cannot invalidate this request's locator. Corruption remains hard-fail.
Existing synchronous inspection remains for maintenance/thaw inside the
maintenance Worker or existing write domain; ordinary server hydration uses the
async path.

`MessageV2.stream` awaits `Bun.sleep(0)` after a page only when another page is
required. Page size stays 50 and response shape stays unchanged.

### D. Async response compression

Replace `gzipSync`/`deflateSync` with `Effect.promise` around promisified zlib
`gzip`/`deflate`. Preserve threshold, content type, `no-transform`, HEAD,
content-encoding, transfer-encoding and streaming exclusions. Decompressed
bytes must equal the original response body. No synchronous fallback is added.

### E. Shared SSE serialization and bounded slow-client termination

Introduce one small serialization helper using `WeakMap` keyed by the original
published event object. Cache separate full and viewer variants. GlobalBus IDs
are assigned before listeners run and published events are treated as immutable
after emission. EventV2 caches the original payload-to-wire serialization;
GlobalBus caches the original event and viewer projection. Per-client heartbeat
and `server.connected` objects are not shared.

Use a named capacity of 256 for each client-facing buffered event stream:

- `/event` consumes the existing `EventV2.allBounded(events, 256)` behavior;
  compatibility projection uses the same dropping/fail policy.
- `/global/event` sets `Stream.callback` to capacity 256 with `dropping`. A
  rejected offer immediately calls `Queue.endUnsafe`; queued events drain and
  the response ends instead of accepting further silent loss.

On overflow the stream closes. The existing reconnect path creates a fresh
connection, receives `server.connected`, and triggers the existing SyncProvider
and session refresh. Text, reasoning and tool-input deltas are never coalesced
or dropped by the server. Existing client-side ordered concatenation remains.

### F. Maintenance Worker and queued database admission

Extract the existing `maintain`, `runOffline`, and resume-offline logic from
`cli/cmd/db.ts` into one shared maintenance executor. The DB CLI and maintenance
Worker call this implementation, including conflict checks, lease acquisition,
queued record, cursor checkpoints and final lease release.

The Daemon parent replaces its local `maintain()` SQL path with a dedicated
`node:worker_threads.Worker` using the already compiled `cli/tui/worker.ts`
entry and `workerData.role = "maintenance"`; no new binary entry or process is
introduced. The maintenance branch is evaluated before the existing
`OPENCODE_PROCESS_ROLE === "worker"` Daemon startup branch, so the thread cannot
open HTTP listeners or write the discovery lock. The Worker owns a Database
connection created from the same database path.

1. Parse/prepare the request and register `activeMaintenance` before any await
   that could expose an idle-shutdown window.
2. Start the Worker and pass a validated start/resume request. For a new task,
   the Worker reports the acquired lease token immediately after acquisition,
   writes queued state and reports `ready` only after the first durable running
   checkpoint. The parent then returns the
   existing 202/task response. Immediate operations return their existing final
   JSON result. Resume preserves the reconciled task identity and cursor.
3. Before each Worker-side SQL reservation, the shared executor requests a
   parent database hold and waits for acknowledgement. The parent records the
   hold in a FIFO, interruptible core `DatabaseGate`; parent `withSync`,
   transaction acquisition and async statement execution all wait on that gate
   before touching SQLite. When the Worker reservation finishes it releases the
   hold and queued parent work resumes. This is a queue, not a user-visible
   maintenance error.
4. Parent shutdown posts `{type:"abort"}`. The Worker aborts at the next batch
   boundary, persists `interrupted`, closes its encoder/database and releases
   the lease. A parent crash kills the Worker thread with the process, so the
   existing dead-PID reconciliation remains valid and no orphaned maintenance
   process can survive a replacement Daemon.
5. Worker `error`/`exit` before a terminal result clears all of that Worker's
   gate holds, clears the reported lease token only after the thread is dead, and marks the
   task interrupted from the persisted cursor. A later normal exit with a
   terminal result does not perform this cleanup.

`DatabaseGate` is a small core module keyed by resolved database path. Holds are
owned by a supervisor token, and waiters are FIFO and interruption-safe. Parent
`sqlite.bun.ts` waits before async statements and transaction acquisition;
`Database.withSync` waits before reserving the synchronous facade. The few
direct `database.sync.transaction` callers are moved behind `withSync`, leaving
no parent bypass. A hold request is acknowledged before Worker SQL starts, while
an already-running parent statement is allowed to finish; the Worker then waits
for the real SQLite lock in its own thread. Health, SSE, task-file status and
control routes do not take this gate. Gate release is in `finally`, and parent
shutdown interruption never converts queued work into success or a
maintenance-specific user error.

The parent status/stop routes remain lightweight supervisors. They never call
`ColdMaintain.maintain` or open a second maintenance executor as a fallback.
Restart recovery creates a Worker through the same resume path. The existing
maintenance lease remains the single maintenance-writer authority across CLI and
Daemon.

### G. Full-history streaming response

Only the no-limit HTTP `session.messages` branch becomes raw/streaming. Validate
session, cursor and errors before opening the response, then emit the existing
`WithParts[]` JSON contract as bounded pages. A lightweight cursor walk fixes the
page boundaries first; pages are replayed oldest-first and each page's items are
serialized with commas into the same array shape. `Bun.sleep(0)` runs between
pages. Limited requests keep the existing buffered handler and viewer behavior.
The internal `Session.messages` API remains for Revert/Provider and other code
that explicitly needs the array.

### H. Token native counting

Replace the private escaped-string regexp walk with
`JSON.stringify(value).length`. No fast path, cache or public API change.

## 11. Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| Full Config global load/cache | Full Config keeps its cache and delegates file reading to `readGlobalConfig` |
| Discovery network resolution and updater | Both call the same plain reader directly, without AppRuntime |
| `connectionInfo` | Single classified observation; no retry |
| Discovery fast path/election recheck | Same bounded classified reuse function |
| Spawn readiness polling | Single `ok` check inside existing poll, no new backoff |
| Legacy and packed cold rows | Same Worker RPC validation, separate existing restore helpers |
| Viewer and hidden reads | Existing filters/projections after restore |
| Maintenance/thaw synchronous inspection | Retained in the maintenance Worker or existing write domain |
| CLI offline maintenance | Calls the same extracted executor as the maintenance Worker |
| Daemon maintenance recovery | Reconciles durable state and resumes through Worker supervision |
| `/global/event` and `/event` | Separate filters/protocols, shared serialization concept |
| EventV2 compatibility projection | Bounded and terminated on overflow |
| SSE reconnect | Existing `server.connected` refresh; no new client event schema |
| Identity/HEAD/streaming HTTP | Existing compression bypasses |
| Existing Token public estimator | Unchanged outside private string sizing |

## 12. Workaround Deletion and Replacement

Remove the Daemon's in-main-thread maintenance execution function rather than
adding a Worker beside it. Remove per-client serialization of identical published
variants rather than adding a second cache while retaining the old stringify.
Remove synchronous compression calls rather than catching and rerunning them.

Remove cold decompression from ordinary synchronous read inspection on the
server path; do not catch Worker errors and repeat decode on the main thread.
Retain synchronous ColdStore inspection only where its existing maintenance and
transaction callers genuinely require it.

Delete the boolean health truthiness checks at all call sites. Do not preserve a
second boolean wrapper that could accidentally turn every structured error into
a successful truthy result.

No compatibility behavior is implemented as a parallel fallback path.

## 13. Forward Traceability

| Requirement | Design | Verification |
| --- | --- | --- |
| Remote client does not open local DB | A | T1/T2 |
| Busy owner gets bounded transient tolerance | B | T3/T4 |
| Auth/version errors fail precisely | B | T3 |
| SQLite maintenance does not block Daemon | F | T6/T11-T15 |
| Cold decode leaves main thread/DB reservation | C | T7/T8 |
| Full-history batching streams and yields to health | C/G | T9/T20 |
| High-entropy compression leaves event loop responsive | D | T10 |
| SSE serialization is shared | E | T16 |
| Slow SSE consumer has bounded memory and safe recovery | E | T17/T18 |
| Token estimate keeps semantics with lower cost | H | T19 |
| No real Daemon/owner is used | All test harnesses | Command and fixture audit |

## 14. Reverse Traceability

- the same-file `readGlobalConfig` and Config delegation exist only to share the
  global file loading implementation without pulling project/provider/Database
  runtime construction.
  There is no auxiliary runtime, second service cache or second update owner.
- `upgrade.ts` is included because the direct probe reached Database after
  discovery; no broader updater redesign is included.
- Health result categories map directly to distinct retry/error behavior.
- Cold decode jobs contain only data already needed for current integrity and
  restore behavior; no persistent cache or read replica is introduced.
- The macrotask yield is placed only between existing pages.
- WeakMap serialization exists only for current fan-out duplication.
- Queue capacity and termination exist only for current unbounded slow-client
  growth; reconnect uses existing client behavior.
- Worker supervision and `DatabaseGate` reuse current maintenance algorithms and
  durable records; they add queuing and placement without a second state machine.
- Token change is confined to the measured private helper.
- No file is changed solely for stylistic refactoring.

## 15. File-Level Change Plan

| File(s) | Planned change | Production add+del cap |
| --- | --- | ---: |
| `config/config.ts`, network resolver, `cli/cmd/tui.ts`, `cli/upgrade.ts` | Same-file plain global reader and two direct consumers | 190 |
| `cli/tui/server-lock.ts`, `cli/cmd/tui.ts` | Health classification and reuse-only backoff | 90 |
| `packages/core/src/util/token.ts` | Native string length | 10 |
| `server/.../middleware/compression.ts` | Async zlib | 25 |
| `session/message-v2.ts` page loop | Macrotask yield | 15 |
| Session messages group/handler and page stream helper | Raw streamed no-limit JSON response | 120 |
| SSE handlers plus one local serialization helper | Variant cache and bounded termination | 90 |
| `cold-codec.ts`, `cold-store.ts`, `session/message-v2.ts` | Read snapshot, Worker decode and restore | 210 |
| `cli/cmd/db.ts`, shared maintenance executor, `cli/tui/worker.ts`, `database/gate.ts`, `database/database.ts`, `sqlite.bun.ts`, direct-sync call sites | Worker execution, supervision and queued admission | 340 |
| **Total target** | Includes planned Chinese comments | **1,090 / 1,200** |

New production modules are limited to the maintenance executor/gate protocol and
SSE serialization helper; the global reader stays in `config/config.ts`. Their names follow existing
module conventions; no barrel, star import or auxiliary runtime is introduced.

Test additions+deletions are counted separately:

| Test area | Cap |
| --- | ---: |
| Config/discovery/updater and health | 170 |
| Token | 30 |
| Compression | 50 |
| SSE serialization/backpressure/recovery | 80 |
| Cold snapshot/Worker behavior | 130 |
| Maintenance Worker/admission/recovery | 180 |
| Full-history streaming and pagination scheduling | 80 |
| **Total target** | **720 / 800** |

## 16. TDD Behavior Slices

- **T1**: isolated client discovery with an already reachable owner and explicit
  temporary `OPENCODE_DB` completes without creating that file.
- **T2**: after the same discovery, run the real `upgrade()` with
  `autoupdate:false`; the DB remains absent and no update network request occurs.
  Both T1/T2 execute the production plain-reader path and assert that no
  AppRuntime/Database initialization side effect occurs.
- **T3**: health probes classify 200, 401, wrong version, malformed JSON,
  connection refusal and timeout. Unauthorized/mismatch perform one call and no
  sleep; timeout performs four calls with sleeps 500/1000/2000 ms.
- **T4**: first timeout followed by `ok` reuses the same URL/token;
  `connectionInfo` still performs one call; owner replacement during retry fails.
- **T5**: maintenance and ordinary HTTP may use temporary SQLite files, but no
  test imports the CLI main or publishes a Daemon discovery lock.
- **T6**: a two-connection SQLite lock probe records the pre-change synchronous
  stall; R6 maintenance supervision completes a heartbeat callback while the
  Worker owns a long maintenance batch and parent DB work remains queued.
- **T7**: hot/legacy/packed cold rows round-trip with identical visible output;
  digest corruption and malformed envelopes preserve typed errors.
- **T8**: a heartbeat timer runs before a large Worker decode resolves; mutating
  persistent rows after snapshot copy does not change the copied result; Worker
  transport failure does not invoke synchronous decode.
- **T9**: a multi-page `MessageV2.stream` permits a queued macrotask/health fetch
  between pages and returns identical ordered messages.
- **T10**: gzip and deflate round-trip exactly; SSE and streaming POST remain
  excluded. Record before/after high-entropy event-loop gaps as a benchmark,
  without a fragile wall-clock CI threshold.
- **T11**: a new Worker task emits ready only after queued/running durable state;
  parent acknowledgement contains the same taskID.
- **T12**: Worker abort produces an interrupted checkpoint at a batch boundary
  and releases the lease; terminating a supervisor test process kills the Worker,
  after which restart reconciliation resumes the original taskID/cursor.
- **T13**: immediate verify/cleanup/status and confirmed vacuum preserve their
  existing JSON shapes; vacuum still requires its lease. T6/T13 record queue-wait
  and VACUUM duration as observations, not health-stall thresholds.
- **T14**: concurrent CLI/Daemon maintenance conflict returns busy and never
  creates two writers; unexpected Worker exit clears its holds/lease, marks the
  task interrupted and clears active supervision.
- **T15**: restart recovery resumes through a Worker and parent control status
  remains an observation of durable task state.
- **T16**: an event with counting `toJSON` is serialized once across multiple
  full clients; viewer output is separately cached and redacted correctly.
- **T17**: a slow client exceeding 256 buffered events terminates the stream;
  memory remains bounded and other clients continue receiving ordered events.
- **T18**: the replacement connection emits `server.connected`; existing sync
  and session refresh handlers run before subsequent deltas are applied.
- **T19**: Token output is byte-for-byte/numerically equivalent for escaped,
  Unicode, empty and ordinary strings, with native-cost benchmark recorded.
- **T20**: a no-limit streamed messages response parses to the same ordered
  `WithParts[]` as the existing service path, a health fetch runs between pages,
  and limited requests retain their current buffered behavior.

Each behavior is written red against the old implementation before its
production edit. Pure refactor slices must also preserve the relevant existing
package tests.

## 17. Chinese Comment Budget

The production target includes explanatory comments. Pure moves are excluded
from effective changed code `E`; import-only, formatting and generated lines are
also excluded. The actual implementation must calculate `E` and `C` from the
final diff, not from this estimate.

The gate applies to the combined effective changed production, substantive test
and configuration code. For budget planning only, an envelope of 900 effective
production lines plus 550 effective test/config lines would give `E = 1,450`
and require at least `ceil(1,450 * 0.15) = 218` qualifying Chinese comment lines.
Reserve roughly 225 focused comments across production and tests within their
respective diff budgets. Actual acceptance always uses the final combined diff,
not this estimate.

Comments must explain adjacent constraints, including:

- shared global reader ownership and why remote clients must not enter full
  Config/AppRuntime;
- timeout-only retry and owner-token reread;
- immutable cold snapshot/transfer and no sync fallback;
- macrotask yielding versus Effect cooperative scheduling;
- SSE immutability, variant separation and overflow reconnect semantics;
- Worker lease/checkpoint ordering, abort/termination cleanup, FIFO gate fairness
  and single maintenance-writer ownership;
- async compression's event-loop purpose.

Short or duplicated comments do not satisfy the quota. The implementation
evidence must show the combined `E/C` calculation and may additionally split it
by package for review; no test or configuration namespace is exempt.

## 18. Verification

Run only from package directories. No command starts OpenCode or a real Daemon.

1. Focused red/green tests selected by test name in:
   - `packages/opencode/test/cli/tui`
   - `packages/opencode/test/cli/upgrade*`
   - `packages/opencode/test/server`
   - `packages/opencode/test/session`
   - `packages/opencode/test/cli/tui/maintenance*`
   - `packages/opencode/test/storage/cold.test.ts`
   - `packages/opencode/test/storage/cold-v3.test.ts`
2. Run isolated module tests with temporary XDG directories, explicit temporary
   `OPENCODE_DB`, temporary lock placement and ephemeral loopback servers created
   inside the test. Preload `:memory:` defaults are overridden before any source
   import.
3. Run the maintenance branch of `cli/tui/worker.ts` as a real Worker under the
   test runner's Bun executable, not through the OpenCode CLI. Parent supervision
   tests use the real Worker message protocol, temporary task/lease files and the
   production gate wiring.
4. Run cold Worker tests with actual Worker threads and bounded payloads. Verify
   pool cleanup and pending-request rejection on termination.
5. Run in-process HTTP/SSE tests through the existing HttpApi harness. Do not
   publish a discovery lock or attach to the user's ports.
6. Re-run the original local probes after implementation:
   - first discovery timeout, second healthy reuse;
   - discovery plus delayed updater leaves explicit DB path absent;
   - cold decode heartbeat and integrity equivalence;
   - high-entropy gzip/deflate heartbeat;
   - multi-page health interleaving;
   - multiple SSE client serialization count and overflow reconnect;
   - maintenance Worker heartbeat, abort/termination, gate queue, lease and resume;
   - no-limit streamed messages equivalence and health interleaving;
   - Token equivalence and native timing.
7. Run `bun typecheck` in `packages/core` and `packages/opencode`; run the TUI
   typecheck if its client recovery tests or types are touched.
8. Run related existing Config, discovery, compression, event, message, cold
   maintenance and SDK tests. Do not use an unfiltered command known to launch
   the real CLI.
9. Inspect `git diff --check`, production and test added+deleted counts, the
   actual `E/C` calculation, and `git status --short`. Confirm only intended
   implementation files plus this already-existing plan changed.
10. Request an independent full-scope implementation audit. A new evidence-handoff
    bundle must make every claim and command reproducible.

Plan-stage commands already completed successfully included isolated SQLite,
cold decode, high-entropy compression, scheduling, Token and updater probes.
No real Daemon was started.

## 19. Diff Budget

Production accounting is actual `git diff --numstat` additions plus deletions,
including comments and pure moves, capped at 1,200. The target is 1,090 and the
110-line reserve is for audit-confirmed correctness fixes only.

Test accounting is independent and capped at 800, with an 80-line reserve. Plan
and documentation lines are not charged to either code budget.

The increase beyond 800 is allocated to the core runtime request: cold Worker
read decode (210), maintenance Worker plus queued admission (340), streamed
full-history responses (120), and bounded/shared SSE (90). Startup and Token work are retained but do not consume the entire budget.
If implementation exceeds a row, simplify wiring inside that same primary path;
do not drop its required behavior or move tests into production accounting.

Any unresolved need to migrate all twelve generic SQLite transaction files stops
that broader architecture from entering this diff. It is documented follow-up,
not silently implemented as a partial second database path.

## 20. Real Risks and Open Decisions

| Risk | Required handling |
| --- | --- |
| Cold snapshot changes transaction semantics | Select rows and immutable payloads in one deferred reservation; test concurrent thaw/cleanup and order |
| Worker structured clone increases memory | Bound pending jobs, copy exact Buffer views, transfer payloads, parse in Worker, measure RSS on large pages |
| Worker error loses domain type | Serialize name/message/hash and reconstruct typed corruption errors; no sync retry |
| Permanent reader pool keeps process alive | Lazy creation, `unref` idle Workers, explicit close in Daemon/test disposal |
| Shared SSE cache returns stale/mutated data | Cache only after GlobalBus ID assignment and require immutable published events; test viewer variants |
| Queue termination drops an event | Treat closure as the recovery signal; never continue the same stream after overflow; test refresh on reconnect |
| Worker startup is slow or fails before ready | Keep active transition registered, reject promptly, clear supervision, preserve durable recovery |
| Worker stops while holding a gate | Parent exit/error handler clears only that Worker's holds after thread termination, then marks the task interrupted |
| Parent dies while Worker writes | The Worker dies with the process; dead-PID lease reconciliation preserves cursor and resumes on restart |
| Compiled Worker entrypoint differs from checkout | Reuse the already compiled `cli/tui/worker.ts` entry and test both source URL and compiled-path selection |
| Maintenance Worker contends with ordinary Daemon writes | Parent `DatabaseGate` queues new DB execution while the Worker owns a reservation; queued callers wait without a maintenance error |
| Gate waiter starvation or shutdown | FIFO, interruptible waiters; shutdown releases supervision holds and unblocks callers with interruption rather than a fake success |
| Generic non-maintenance SQLite lock still stalls | Record as residual full-SQLite-actor scope; do not claim R6 eliminates every possible native lock wait |
| Timing tests are flaky | Use heartbeat ordering, call counts and state assertions; report timings as benchmarks rather than tight CI limits |
| Remote incident causality is incomplete | Keep local synthetic measurements and remote narrative separate |

No open design choice permits a second maintenance executor, a user-visible
maintenance-busy fallback, silent delta loss, a boolean health fallback, or
synchronous cold-decode fallback. If Worker protocol or cold snapshot evidence
fails, the corresponding primary design must be repaired and re-audited before
implementation approval.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and all original requirements in section 1, including the
  expanded handoff scope and separate production/test budgets.
- Reconstruct behavior from repository evidence; builder summaries and prior
  transcripts are untrusted.
- Audit the complete scope on every round, including the runtime sources that
  R3 excluded and the residual full-SQLite-actor boundary.
- Require evidence for every blocking finding and check both under-design and
  over-design, especially unnecessary wiring and low-value abstraction.
- Check root-cause repair, fallback removal, ownership, transaction/snapshot
  semantics, Worker lifecycle/gate fairness, SSE ordering/recovery, tests and code quality.
- Verify production additions+deletions target 1,090/maximum 1,200 and test
  additions+deletions target 720/maximum 800 independently.
- Check the 15 percent Chinese explanatory-comment plan using the combined
  effective changed production, substantive test and configuration lines and
  qualifying adjacent comments.
- Confirm this planning round changes only this canonical plan document and does
  not modify production, tests, configuration or unrelated documents.
- Re-run or inspect isolated module probes as needed without starting OpenCode,
  a Daemon, a real owner or a real database.

A clean verdict must state `No blocking findings` and `APPROVE` for the exact R6
(or later audited revision). Any substantive revision invalidates earlier
approval. Administrative approval may be recorded only after that verdict and
cannot be combined with a design edit.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes, original R1 scope | B-01、B-02、B-03、B-04 | NB-01 | **BLOCK — `docs/plans/daemon-control-plane-stability.md` R1 不予批准，Implementation allowed 必须保持 `no`。** | `ses_e304bca96ffefIe73HGqkg5teM` |
| 2 | R2 | yes, original R2 scope | B-01 | 无 | **BLOCK — `docs/plans/daemon-control-plane-stability.md` R2 不予批准，`Implementation allowed` 必须保持 `no`。** | `ses_e30291ed2ffe0Fd5Ip3BKiD2hd` |
| 3 | R3 | yes, original R3 scope | No blocking findings. | 无。 | **APPROVE — `docs/plans/daemon-control-plane-stability.md` R3 通过完整范围计划审计。** | `ses_e30291ed2ffe0Fd5Ip3BKiD2hd` |
| 4 | R4 | yes, expanded scope | B-01 | NB-01 | **BLOCK — docs/plans/daemon-control-plane-stability.md R4 不予批准，Implementation allowed 必须保持 no。** | `ses_e2f007fc5ffepEgCijdB4oASoy` |
| 5 | R5 | yes, expanded scope | B-01、B-02 | NB-01 | **BLOCK — docs/plans/daemon-control-plane-stability.md R5 不予批准，Implementation allowed 必须保持 no。** | `ses_e2ee44798ffe7hVQbDL2PIsNiR` |
| 6 | R6 | yes, full updated scope | No blocking findings. | NB-01、NB-02、NB-03、NB-04 | **APPROVE — docs/plans/daemon-control-plane-stability.md R6 通过完整范围计划审计。** | `ses_e2ebb7602ffeQYvCu23AQPgCPL` |

R1 original findings:

- Blocking B-01：`GlobalService` 不会经 `Config.node` 自动暴露给 `AppRuntime`。
- Blocking B-02：重试进入 `connectionInfo`，破坏既有纯观察合同。
- Blocking B-03：原始瞬态恢复反馈环在正确修复后仍必然失败。
- Blocking B-04：必需的全文件测试命令会启动被禁止的真实 OpenCode CLI。
- Non-blocking NB-01：远程事故的因果结论仍需保持克制。

R2 original finding:

- Blocking B-01：“不建库”回归测试会被预加载的 `:memory:` 配置假绿。

R3 release verdict:

- Blocking findings：No blocking findings.
- Non-blocking findings：无。
- **APPROVE — `docs/plans/daemon-control-plane-stability.md` R3 通过完整范围计划审计。**

R4 original findings:

- Blocking B-01：GlobalService 仍经过完整 AppRuntime，远程客户端建库问题没有修复。
- Non-blocking NB-01：中文注释估算漏算了测试代码，但最终门禁尚未被降低。

R5 original findings:

- Blocking B-01：Residual native SQLite waits can still freeze health and discovery。
- Blocking B-02：Restart recovery misses a live orphaned maintenance child。
- Non-blocking NB-01：Existing cold regression suites are listed under the wrong package。

R6 removes the auxiliary runtime, uses one shared plain global reader, replaces
the child with a Worker that dies with the parent, and adds the queued
`DatabaseGate` plus streamed full-history responses. R4/R5 remain unapproved.

R6 independent full-scope verdict:

- Blocking findings：No blocking findings.
- Non-blocking findings：NB-01（T1-T19 应为 T1-T20）、NB-02（fallback 句子排版）、
  NB-03（补写 timeout 重试耗尽行为）、NB-04（verify/VACUUM 单预约等待应如实记录）。
- **APPROVE — docs/plans/daemon-control-plane-stability.md R6 通过完整范围计划审计。**

The four non-blocking record corrections are completed without a design change:
section 23 references T1-T20; section 10.D retains the corrected sentence `No
synchronous fallback is added.`; section 10.B explicitly preserves the owner and
rejects a replacement after exhausted retries; T6/T13 record queue-wait and
VACUUM duration as observations rather than health-stall thresholds.

## 23. Implementation Evidence

### Actual Files and Diff

Implemented R6 across 20 production files and 12 test files. New modules are
`core/database/gate.ts` and `opencode/cli/maintenance.ts`; existing files cover
classified discovery, shared global config, cold Worker reads, maintenance Worker
supervision, streamed history, SSE, compression and Token counting. The final
line count includes new untracked-at-the-time files and is:

| Scope | Added | Deleted | Total | Cap |
| --- | ---: | ---: | ---: | ---: |
| Production | 919 | 278 | 1,197 | 1,200 |
| Tests | 760 | 30 | 790 | 800 |

Decision-specific Chinese comments are included in these final line counts.

### Red-Green Test Evidence

- Global config: red `dbCreated:true`; green discovery plus `upgrade()` leaves
  `dbCreated:false`. Initial config/updater run: 123 pass, 2 skip. Isolated final
  config rerun: 116 pass, 2 skip.
- Health/discovery/thread: green 37 pass; deterministic errors fail immediately,
  timeout retry is bounded, and `connectionInfo` remains one observation.
- Compression: red `heartbeat Expected true / Received false`; green 11 pass.
- SSE serialization: red `Expected 2 / Received 3`; green full/viewer sharing.
  Real 256-overflow, healthy-client ordering and reconnect-first-frame tests pass.
- Cold reader: red `decodeColdPayloads is not a function`; green Worker decode,
  corruption typing, transport-failure recovery and immutable snapshots.
- Maintenance: Worker ready reads durable `running`; abort persists
  `interrupted`; live conflict preserves `busy`; inherited `worker` role creates
  no discovery lock. Maintenance plus both cold suites: 68 pass.
- Pagination, SSE, compression and Token combined run: 158 pass. Session HTTP:
  33 pass. Core gate and Token: 14 pass. Both package typechecks pass.
- Round-two maintenance rework: first-hold denial leaves the DB absent; open,
  eight maintenance reservations and close produce ten hold requests; concurrent
  start returns 409 while durable running keeps conditional shutdown at 409.
- Round-two network/health rework: direct-reader mutation fails expected port
  9,876 with received 4,321; the restored full Config wrapper passes. All four
  remaining Daemon health fixture guards require `=== "ok"`.
- Pagination mutation checks: removing internal page yielding turns the queued
  heartbeat false; removing HTTP page yielding lets page two arrive before the
  queued health request starts. Restoring both yields turns both tests green.
- Round-three HEAD compatibility checks: invalid legacy TOML is red before the
  shared-reader fix and green afterward; `limit=0` changes a 101-message response
  to `[]` before normalization and restores the full array afterward. The core
  real-SQL gate fixture now uses the package's portable `tmpdir()`.
- Immediate maintenance probe: a real VACUUM lease reports its `vacuum_*` taskID,
  completes its single atomic batch after abort, and leaves no lease owner. The
  parent supervisor now tracks immediate Workers for shutdown and releases the
  reported lease identity after unexpected Worker exit.

### Verification Commands and Results

Commands ran from `packages/core` or `packages/opencode`, never from repo root:

- `bun typecheck` in both packages: pass.
- `bun test test/cli/tui/global-config.test.ts test/cli/upgrade.test.ts test/config/config.test.ts test/cli/tui/health-discovery.test.ts test/cli/tui/server-lock.test.ts test/cli/tui/thread.test.ts`: implementation behavior passed; three wall-clock config cases timed out only under six-way parallel load, then the isolated config suite passed 116/2-skip.
- `bun test test/cli/tui/maintenance-worker.test.ts test/storage/cold-v3.test.ts test/storage/cold.test.ts`: 68 pass.
- `bun test test/session/message-v2.test.ts test/session/messages-pagination.test.ts test/server/httpapi-compression.test.ts test/server/httpapi-event.test.ts test/token/estimate.test.ts test/util/attachment-token.test.ts`: 158 pass.
- `bun test test/server/httpapi-session.test.ts`: 33 pass.
- `bun test test/database-gate.test.ts test/util-token.test.ts`: 14 pass.
- A later consolidated 16-file run reached the 600-second command timeout after
  two wall-clock config cases timed out under load. The same affected files then
  passed in isolated groups: config/discovery 161 pass plus 2 skip,
  maintenance/cold 68 pass, streaming/SSE 158 pass, Session HTTP 33 pass.
  Total final opencode result: 420 pass, 2 skip, 0 fail.
- Final core rerun: 14 pass, 0 fail. Final filtered isolated-Daemon supervision
  test: 1 pass, 48 filtered out, 0 fail. Final two isolated task/immediate
  lifecycle cases: 2 pass, 47 filtered out, 0 fail. Final `bun typecheck` in both
  packages: pass. Final `git diff --check` over all implementation paths: pass.

No command attached to the user's running Daemon, real owner lock or real
  database. Filtered Daemon lifecycle tests use only temporary owners, ephemeral
  ports and disposable databases.

### Original Feedback-Loop Result

Baseline isolated probes recorded SQLite lock stall 694ms with zero heartbeats,
8.8MB synchronous cold decode 43ms, high-entropy sync/async gzip gaps 331/14ms,
and microtask/`Effect.yieldNow`/`Bun.sleep(0)` health latencies 105/62/20ms.
The implementation tests exercise the original seams: Worker cold decode now
runs its heartbeat first, async compression passes the adjacent-timer assertion,
real SQL waits and resumes through `DatabaseGate`, and no-limit history returns
its first chunk with health still responsive. A fresh 8.2MB Token request took
23.73ms; the earlier escaped-sample baseline was 122.59ms.

### Actual Secondary and Replacement Path Inventory

Full Config retains its cache and FSUtil behavior while discovery/updater use the
same file reader. Limited message pages and `limit=0` stay buffered. Legacy and
packed cold rows share Worker validation and existing restore/projection rules.
Maintenance/thaw retain synchronous inspection in their owning domain; CLI and
Worker share lease/checkpoint execution. Full and viewer SSE variants use separate
cache slots, and overflow reconnects through the existing `server.connected`
refresh. Streaming POST/SSE/HEAD/no-transform compression exclusions remain.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 1,251 | Final independent recount: `1679 - 78 blank - 50 import/self-reexport - 36 comment-only - 222 punctuation-only - 42 pure-move/format` |
| Qualifying Chinese comment lines `C` | 189 | Final independent recount: 201 candidates minus 12 duplicate/restatement lines |
| Ratio `C / E` | 15.11% | `189 / 1251 = 0.151079`, above the 15 percent requirement |
| Required minimum `C` | 188 | `ceil(1251 * 0.15) = 188`; independent recount passes by 1 comment; the 10 percent blocking floor is 126 |

### Remaining Unverified Items

None. The round-three blocker review found B-01 through B-04 resolved and returned
`No blocking findings` for the current simplified implementation and approved R6.
It explicitly rejected demands for tests of problems absent from HEAD or additional
runtime designs.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | B-01 through B-07 | NB-01 budget reserve, NB-02 stale records | Blocked; fixes implemented | `ses_e2e1eb35affezK4pNEeICng2DD` |
| 2 | R6 | yes | B-01 Worker lifecycle SQL bypasses admission; B-02 concurrent starts orphan the live supervisor; B-03 boolean health fixture guards; B-04 web/serve/acp config failure drift; B-05 pagination tests miss active health interleaving | NB-01 production reserve 18 lines; NB-02 stale E/C records corrected from the independent recount | **BLOCK — the actual implementation diff against approved R6 is not releasable.** | `ses_e2dc5c93bffegRX0iRyBNrFFId` |
| 3 | R6 | yes | B-01 immediate Worker shutdown/lease cleanup; B-02 shared-reader nonfatal write/migration behavior; B-03 `limit=0` full-history regression; B-04 nonportable core test path; all resolved on blocker review | NB-01 stale E/C records resolved by independent `E=1251`, `C=189` | Initial **BLOCK — 当前实际 implementation diff against approved R6 不予发布。**; final **APPROVE — 当前简化 implementation diff against approved R6 可以发布。** | `ses_e2d1c34a8ffeFhcbUfYLGXLXz3` |

Round-two fixes gate Worker open/checkpoint/close, reject overlapping starts
before Worker creation, restore the full Config network wrapper, require explicit
healthy fixture results and add red-capable internal/HTTP pagination checks.
The round-three auditor reached the implementation-audit round limit and left
B-01 through B-04 as blocking open decisions. The user then required avoiding
complexity unrelated to user concerns, simplifying at upstream owners, and avoiding
tests for problems absent from HEAD. Rework preserves the existing task supervisor,
adds immediate Worker lifetime handling to the same owner, restores nonfatal
shared-reader IO at its two adapters, normalizes `limit=0` in the HTTP handler, and
uses the existing core temporary-directory fixture. No new runtime, decoder,
maintenance algorithm or speculative test fixture was introduced. The same auditor
re-reviewed those open decisions against the simplified diff, found no blocking
findings, independently confirmed both budgets and the comment gate, and approved
release without requesting tests for problems absent from HEAD.
