# Canonical Implementation Plan: TUI Ctrl-C Daemon Shutdown Lifecycle

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: implementation (full-scope)
>
> Requirement source: original user request and session continuation scope
>
> Implementation allowed: no
>
> Last updated: 2026-07-22

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 当前需要你详细完成检查一下我们的opencode,假设在启动节点的时候,用户按下Ctrl C,然后我就会发现,它会报这样的错误"Is your computer able to connect to Network类似这样的",并且貌似整个daemon是在后台挂起的。同时,用户输daemon stop,它也stop不掉,只能进行强行kill掉。先检查检查这是什么情况,以及它是什么原因,根因是什么,有没有什么比较好的修复方法。，同时方案保持克制，整体修改代码文件数量不超过6个，同时修改行数不超过800行，尽量保持甜点级别修改，不为不可能的边界设置过多边界处理。

After plan audit round 1, the user explicitly authorized the exact stop-policy
replacement:

> 授权，自动强制终止（推荐）

The authorized transition is limited to `opencode daemon stop`: after the
current authenticated graceful request and bounded wait fail, the command may
revalidate the same lock token/PID owner, force-terminate that owner, verify
process exit, and report stop success. This authorization does not permit force
termination from unrelated TUI/API failures or against an owner whose identity
changed.

R6 and R7 are verification-contract revisions only. They do not change the approved
production route, implementation file set, behavior, owner, fallback policy, or
test seams. R6 supplies an explicit 10-second Bun test timeout because the
existing fixture contract test intentionally waits for the 5-second disposal
boundary plus a 200ms timer-cleanup window. R7 adds a concrete isolated post-fix
trace generator instead of reusing the immutable pre-fix paths. The fixture and
trace harness files remain outside the six-file repository implementation change
set; the trace harness is an inline verification command and writes only beneath
the system temporary directory.

At `Status: verified`, `Implementation allowed: no` means the audited diff is
frozen and no further material code changes are authorized by this plan.

The original investigation was read-only. Implementation is permitted only
after this exact revision receives a full-scope independent approval. The
session target requires a verified implementation and commit after the
approved-plan route completes; this plan does not authorize implementation
before approval.

## 2. Explicit Non-Goals

- Do not change provider/network retry semantics or external Provider behavior.
- Do not change the SQLite ownership invariant or allow two shared daemons.
- Do not change the TUI startup error aggregation contract except as a direct
  consequence of no longer reusing an owner that is already stopping.
- Do not add a user-configurable timeout, new CLI mode, migration, dependency,
  or public API.
- Do not make `Daemon.ensure()` start a second daemon while a confirmed ready
  owner is merely temporarily unresponsive.
- Do not add speculative handling for synchronous native event-loop stalls
  without a reachable producer or observed trace.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md:71-110,127-175` | Defines Project, InstanceState, AppRuntime, Server Lock, and the SMARK daemon ownership model. |
| `packages/opencode/AGENTS.md:103-135` | Requires InstanceState-scoped cleanup, scoped fibers, Effect conventions, and no ambient context shims. |
| `docs/adr/README.md:1-50` | Confirms ADR conventions; no daemon-specific accepted ADR exists. |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | Unrelated accepted ADR; read to confirm it does not constrain daemon lifecycle. |
| `.opencode/policy/first-principles-engineering.md:218-231,253-322,476-546` | Requires first-divergence repair, one primary path, full traceability, and the 15% Chinese explanatory-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this plan structure and approval/implementation evidence fields. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/thread.ts:84-161` | Shows launcher order, detached daemon acquisition, and that `ExitProvider` is not installed until `tui()` is entered. | reachable |
| `packages/opencode/src/cli/cmd/tui/daemon.ts:23-25,244-369` | Shows owner fast path, alive-but-unresponsive reuse, detached spawn, and election behavior. | reachable |
| `packages/opencode/src/cli/cmd/tui/worker.ts:92-117,247-303,330-413,454-560` | Shows server/lock startup, unbounded shutdown, signal handling, control status, idle shutdown, and late launcher watcher. | reachable |
| `packages/opencode/src/cli/cmd/daemon.ts:6-10,29-97` | Shows graceful-only stop, 10-second wait, token-authenticated control request, and no escalation. | contracted/current behavior |
| `packages/opencode/src/cli/cmd/tui/context/exit.tsx:38-75` | Shows signal listeners only after TUI context mounting and unbounded `onBeforeExit`. | reachable |
| `packages/opencode/src/cli/cmd/tui/app.tsx:234-242,280-344,397-407` | Shows plugin cleanup before renderer/SSE teardown and asynchronous plugin initialization. | reachable |
| `packages/opencode/src/cli/cmd/tui/plugin/runtime.ts:674-724,1000-1016,1040-1055,1111-1120` | Shows dependency wait, pending `loaded` promise, and plugin disposal ordering. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx:868-899,958-969` | Shows the five startup requests and fatal handling. | reachable |
| `packages/opencode/src/cli/cmd/tui/context/aggregate-failures.ts:14-36` | Shows the exact generic network error aggregation. | reachable |
| `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:23-34` | Shows instance API requests entering `InstanceStore.load()`. | reachable |
| `packages/opencode/src/project/instance-store.ts:27-71,88-116,141-179` | Shows pending `Deferred`, bootstrap fiber, and `disposeAll()` waiting before disposers. | reachable |
| `packages/opencode/src/project/bootstrap.ts:38-52` | Shows Project bootstrap dependency and service initialization chain. | reachable |
| `packages/opencode/src/project/instance-runtime.ts:1-16` | Shows the Promise boundary used by worker shutdown. | reachable |
| `packages/opencode/src/effect/instance-state.ts:27-53` | Shows ScopedCache per-Project lifecycle. | reachable |
| `packages/opencode/src/effect/instance-registry.ts:1-12` | Shows all disposers are awaited but not bounded. | reachable |
| `packages/opencode/src/session/run-state.ts:55-78` | Shows a real finalizer that waits for runner cancellation. | reachable |
| `packages/opencode/src/file/watcher.ts:74-123` | Shows native watcher finalizer and timeout-limited acquisition but unbounded unsubscribe. | reachable |
| `packages/opencode/src/lsp/client.ts:693-699` | Shows LSP shutdown waiting for process stop. | reachable |
| `packages/opencode/src/mcp/index.ts:556-577` | Shows MCP close with no outer timeout. | reachable |
| `packages/opencode/src/config/config.ts:601-638,771-793` | Shows detached dependency installation and later dependency joining. | reachable |
| `packages/core/src/npm.ts:79-113` | Shows npm retry/timeout configuration and its boundary. | reachable |
| `packages/opencode/test/project/instance.test.ts:86-118,198-243` | Existing concurrent-load and dispose tests; missing pending-dispose cancellation assertion. | reachable |
| `packages/opencode/test/cli/tui/daemon.test.ts:1-120,611-681,729-888,1089-1130` | Existing real daemon, stop, startup-idle, launcher, and detached-signal tests. | reachable |
| `packages/opencode/test/fixture/fixture.ts:48-87` | Test-only 5-second disposal timeout explicitly documents hanging finalizers. | observed |
| `packages/opencode/test/cli/tui/plugin-lifecycle.test.ts:182-224` | Confirms plugin cleanup timeout coverage does not cover pending plugin load. | reachable |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213117.log:70-86` | Captured real daemon disconnect, idle shutdown, and incomplete teardown trace. | observed |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213124.log:4-12` | Captured exact startup network error and fatal TUI exit. | observed |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213126.log:4-12` | Confirms repeatability across another TUI launch. | observed |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213137.log:1` | Captures the `daemon stop` invocation. | observed |
| `/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213148.log:1-13` | Shows replacement daemon startup after the failed owner window. | observed |
| `09c086ffa8d` | Records that production-like instance disposal can hang and required a test timeout. | observed/history |
| `3282685c3a` | Records the lock-clear-after-disposal safety decision. | observed/history |
| `60189bbe79` | Records the deliberate graceful-only `daemon stop` decision. | observed/history |
| `b01eb22b2c` | Provides an upstream authenticated SIGTERM/SIGKILL lifecycle precedent. | observed/history |

## 5. Current Behavior

```text
TUI thread -> Daemon.ensure() -> detached worker -> ServerLock/control port
  -> TUI app/SSE -> SyncProvider.bootstrap()
  -> instance HTTP middleware -> InstanceStore.load()
  -> Project bootstrap / InstanceState services
  -> Ctrl-C or TUI exit -> SSE disconnect -> worker idle shutdown
  -> InstanceRuntime.disposeAllInstances()
  -> unbounded pending bootstrap or finalizer wait
  -> live PID + retained lock + unavailable public server
  -> Daemon.ensure() reuses alive-but-unresponsive URL
  -> local startup requests fail with generic network text
```

`InstanceStore.load()` inserts an entry containing a `Deferred`, forks
`completeLoad()` in the store scope, and waits for that Deferred. `disposeAll()`
waits for the same Deferred before it can call the registered instance
disposers. For a pending bootstrap, this postpones the scope invalidation that
could have interrupted the producer.

For an already completed Project, a service finalizer can still keep
`InstanceRuntime.disposeAllInstances()` pending. The repository has direct
observed evidence of this class of hang in the test fixture and the captured
daemon log stops after disposal begins, before server/database/lock completion.

`Daemon.ensure()` currently treats both responsive and unresponsive live PIDs
as owners that must be reused. This preserves the single-owner invariant for a
long model call but also reuses an owner that is already stopping.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Unix/macOS `Ctrl-C` before TUI app mount | Terminal signal to `thread.ts` launcher | Worker is detached from the foreground process group | `thread.ts` before `ExitProvider` registration | TUI launcher/worker lifecycle | observed/reachable |
| TUI exit after SSE connection | OpenTUI keybinding or `ExitProvider` | `ExitProvider` serializes one exit task | `app.tsx` cleanup -> SSE disconnect -> idle timer | worker shutdown orchestration | observed/reachable |
| Startup API request for a Project | `SyncProvider.bootstrap()` | Instance routes provide directory/workspace context | HTTP middleware -> `InstanceStore.load()` | `InstanceStore` | observed/reachable |
| Pending Project bootstrap | `InstanceStore.load()` forks `completeLoad()` | Entry is cached and callers await its Deferred | `disposeAll()` sees entry before bootstrap completes | `InstanceStore` | reachable |
| Hanging instance finalizer | `InstanceState`/registry services | Disposers are awaited with `allSettled`, not timeout | `InstanceRuntime.disposeAllInstances()` | worker shutdown orchestration | observed/reachable |
| Daemon owner marked stopping | `gracefulShutdown()` sets shutdown guard | Control status is local and token protected | new `Daemon.ensure()` during teardown | daemon owner acquisition | reachable |
| `daemon stop` timeout | CLI control request + PID polling | Lock token and control port authenticate owner | `cmd/daemon.ts` after 10 seconds | daemon CLI orchestration | reachable/contracted |
| Existing ready owner temporarily unresponsive | long model call or event-loop delay | Single-owner SQLite invariant must remain | `ServerLock.alive()` true, health ping false | `Daemon.ensure()` | reachable, preserved |

The plan does not add behavior for an unproven synchronous native event-loop
freeze. The observed trace and source path establish asynchronous cleanup and
pending lifecycle waits as the supported repair domain.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Once daemon shutdown starts, it reaches either completed cleanup and owner release or a bounded process termination. It does not remain indefinitely live with a stopping owner. | User symptom, worker shutdown path, fixture timeout evidence | Planned real-worker hanging-disposer test |
| INV-02 | A Project bootstrap that is still pending can be interrupted during disposal; disposal does not wait forever for the producer before it can cancel the producer. | `instance-store.ts:102-116,151-179` | Concurrent load only |
| INV-03 | A TUI never reuses a daemon owner that has entered stopping state. | Captured error timing and `Daemon.ensure()` reuse path | No stopping-owner test |
| INV-04 | `opencode daemon stop` terminates the same authenticated owner within a bounded command operation, including a stuck graceful teardown. | User symptom and `cmd/daemon.ts:54-70` | Healthy stop only |
| INV-05 | A ready owner that is merely temporarily unresponsive remains the single reusable owner; no duplicate daemon is spawned. | `daemon.ts:287-304` and existing thread tests | Existing unresponsive-owner tests |
| INV-06 | SQLite ownership is not transferred while the old daemon is still alive; forced termination is performed only after owner identity is revalidated. | `3282685c3a`, ServerLock token design | Existing lock-token tests |
| INV-07 | A local owner teardown failure is not surfaced to TUI bootstrap as a generic external-network failure caused by stale URL reuse. | Captured startup error and aggregation path | Captured replay only |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `disposeAllOnce()` awaits `Entry.deferred` before it can run `runDisposers()` and invalidate the pending instance scope. | `InstanceStore.disposeAll()` and `Entry` lifecycle | `instance-store.ts:102-116,151-179`; producer fiber is forked in the same store scope. |
| INV-01 | `gracefulShutdown()` awaits all maintenance/instance/server cleanup without a hard deadline or final termination path. | `worker.ts:247-278` | Captured log stops after disposal begins; fixture documents disposal can never return. |
| INV-03/INV-07 | `Daemon.ensure()` returns the URL for any live PID, including an owner already in shutdown. | `Daemon.existingOwnerUrl()` | `daemon.ts:244-289`; four local startup requests fail immediately after shutdown starts. |
| INV-04 | Stop timeout only reports failure and deliberately does not escalate. | `DaemonStopCommand` | `cmd/daemon.ts:6-10,54-70`; commit `60189bbe79`. |

### Red-capable feedback loop

The live reproduction was not run during planning because the planning phase is
read-only and implementation evidence is not allowed before approval. The
captured trace is replayed by this read-only command:

```sh
cd packages/opencode
bun -e 'const [daemonPath, tuiPath] = process.argv.slice(1); const daemon = await Bun.file(daemonPath).text(); const tui = await Bun.file(tuiPath).text(); const networkFailure = tui.includes("4 of 5 requests failed: Unable to connect") && tui.includes("Affected startup requests: config.providers, provider.list, app.agents, config.get"); const shutdownStarted = daemon.includes("daemon shutting down"); const shutdownCompleted = /Stopped opencode daemon|daemon exited|lock cleared|Database.close/.test(daemon); console.log(JSON.stringify({ networkFailure, shutdownStarted, shutdownCompleted })); if (networkFailure && shutdownStarted && !shutdownCompleted) process.exit(1)' "/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213117.log" "/Users/sunbenteng/.local/share/opencode/log/2026-07-21T213124.log"
```

Observed result:

```text
{"networkFailure":true,"shutdownStarted":true,"shutdownCompleted":false}
exit code: 1
```

This is a captured-trace replay rather than a newly created live process
harness. The plan records that restriction explicitly; the behavioral tests
below provide the executable regression seam once implementation is allowed.

### Post-fix feedback-loop trace

Run the following from `packages/opencode`. It launches the real public
`Daemon.ensure()` path without opening SSE, signals the launcher, waits for the
original worker and lock to disappear, performs a second owner acquisition,
checks the second public health endpoint, and evaluates the isolated daemon log.
It does not overwrite the immutable pre-fix logs.

```sh
bun run - <<'BUN'
import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.join(process.env.TMPDIR ?? "/tmp", "opencode-daemon-ctrl-c-postfix")
const lockPath = path.join(root, "tui-server.json")
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
const daemonURL = pathToFileURL(path.resolve("src/cli/cmd/tui/daemon.ts")).href
const launcherCode = `
  const { Daemon } = await import(${JSON.stringify(daemonURL)})
  const url = await Daemon.ensure({})
  const lock = await Bun.file(process.env.OPENCODE_LOCK_PATH).json()
  process.stdout.write(JSON.stringify({ url, lock }) + "\\n")
  setInterval(() => {}, 1_000)
`
const env = {
  ...process.env,
  OPENCODE_PROCESS_ROLE: "main",
  OPENCODE_LOCK_PATH: lockPath,
  OPENCODE_DB: path.join(root, "opencode.db"),
  OPENCODE_TEST_HOME: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "share"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_STATE_HOME: path.join(root, "state"),
  OPENCODE_DAEMON_IDLE_TIMEOUT_MS: "60000",
  OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "60000",
}
async function spawnLauncher() {
  const launcher = Bun.spawn([process.execPath, "-e", launcherCode, "--print-logs"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  const reader = launcher.stdout.getReader()
  let output = ""
  while (!output.includes("\n")) {
    const next = await reader.read()
    if (next.done) throw new Error("launcher exited before publishing lock")
    output += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  return {
    launcher,
    published: JSON.parse(output.split(/\r?\n/)[0]),
  }
}
async function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const first = await spawnLauncher()
first.launcher.kill("SIGINT")
await first.launcher.exited
const deadline = Date.now() + 8_000
while (Date.now() < deadline && (await alive(first.published.lock.pid))) await Bun.sleep(100)
const workerAlive = await alive(first.published.lock.pid)
const lockPresent = await Bun.file(lockPath).exists()
const logDir = path.join(root, "share", "opencode", "log")
const firstLogFiles = await readdir(logDir).catch(() => [])
const firstDaemonLog = (
  await Promise.all(firstLogFiles.map((file) => Bun.file(path.join(logDir, file)).text().catch(() => "")))
).join("\n")

const second = await spawnLauncher()
const networkFailure = await fetch(`${second.published.url}/global/health`)
  .then((response) => !response.ok)
  .catch(() => true)
second.launcher.kill("SIGINT")
await second.launcher.exited
const logFiles = await readdir(logDir).catch(() => [])
const daemonLog =
  (await Promise.all(logFiles.map((file) => Bun.file(path.join(logDir, file)).text().catch(() => "")))).join("\n") +
  firstDaemonLog
const tracePath = path.join(root, "postfix-trace.log")
await Bun.write(
  tracePath,
  `${daemonLog}\npostfix workerAlive=${workerAlive} lockPresent=${lockPresent} oldUrl=${first.published.url} newUrl=${second.published.url}\n`,
)
const shutdownStarted = daemonLog.includes("daemon shutting down")
const shutdownCompleted = !workerAlive && !lockPresent
console.log(JSON.stringify({ tracePath, networkFailure, shutdownStarted, shutdownCompleted }))
if (networkFailure || !shutdownStarted || !shutdownCompleted) process.exit(1)
BUN
```

Observed post-fix result:

```text
{"tracePath":".../opencode-daemon-ctrl-c-postfix/postfix-trace.log","networkFailure":false,"shutdownStarted":true,"shutdownCompleted":true}
exit code: 0
```

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Pending Project bootstrap cancellation | `InstanceStore` | `load`, `dispose`, and `disposeAll` own per-Project lifecycle | The pending `Entry` and producer scope are created here | TUI and worker do not own instance cache entries or their scopes |
| Shutdown deadline and stopping visibility | `worker.ts` | Worker owns graceful shutdown and private control status | It is the first owner that knows shutdown has begun | CLI cannot observe internal cleanup phase before control request; TUI is only a consumer |
| Stopping-owner acquisition behavior | `tui/daemon.ts` | `Daemon.ensure()` owns shared-owner selection | It decides whether an existing lock is reusable | `sync.tsx` should not infer process lifecycle from API errors |
| Stop escalation | `cli/cmd/daemon.ts` | `daemon stop` owns user-visible stop policy | It already authenticates the owner and waits for termination | Worker cannot guarantee a CLI command returns when its own cleanup is stuck |
| Generic startup error text | `aggregate-failures.ts`/`sync.tsx` | Existing startup aggregation reports request failures | No contract requires changing it if stale-owner reuse is repaired | Changing UI text would compensate downstream and not repair lifecycle ownership |

## 10. Single Approved Primary-Path Design

```text
shutdown request -> mark worker stopping -> cancel pending Project bootstrap
  -> bounded graceful disposal -> clear owner on normal completion
  -> if deadline expires, owner-authenticated termination -> stale-owner reclaim
```

The primary path has four coordinated parts:

1. `InstanceStore` records enough producer control to interrupt a pending
   bootstrap before waiting for its completion. Completed entries retain the
   existing disposer path. The existing concurrent-load deduplication remains
   authoritative.
2. `worker.ts` exposes `stopping` through the existing token-protected control
   status and starts a bounded `5_000ms` shutdown deadline at the first
   shutdown entry. The existing CLI stop budget remains `10_000ms`, so the
   worker-level test and CLI force-stop test have distinct termination owners.
   Normal completion keeps the existing order: instance disposal, server stop,
   database close, then lock clear. Deadline termination leaves lock cleanup to
   dead-owner reconciliation rather than allowing a live stale owner.
3. `tui/daemon.ts` reads the private stopping status before reusing an owner. It
   waits for the same owner to exit within the existing daemon startup deadline,
   then follows the existing election and dead-lock reclaim path. It does not
   spawn a second daemon while the owner is ready or merely unresponsive.
4. `cmd/daemon.ts` retains token/PID ownership checks, but after its graceful
   wait expires it re-reads the lock, confirms the same token and PID, performs
   the platform-supported force termination, and verifies that the PID exits.
   A changed owner is never killed.

The fourth part is the user's exact authorized replacement for the current
graceful-only stop contract:

- Target behavior: `daemon stop` terminates the authenticated current owner.
- Transition condition: the existing graceful request succeeded, but the same
  owner remains alive after the existing bounded wait.
- Semantic difference: timeout changes from an error that leaves the owner
  alive to a verified force termination of that same owner.
- Observability: the CLI prints that graceful stop timed out and force stop was
  used; failure to verify owner or process exit remains an error.
- Owner: `DaemonStopCommand`, which already owns stop timeout and owner polling.
- Test: real CLI invocation against an isolated authenticated non-exiting owner,
  plus a changed-token owner test proving no unrelated PID is terminated.
- Reconsideration condition: remove this escalation only if the product later
  changes `daemon stop` back to a documented graceful-only command through a
  new explicit requirement and canonical revision.

This repairs the first lifecycle divergence instead of catching the resulting
network error in `sync.tsx`. It adds one termination escalation to the existing
stop operation, not an alternate startup success algorithm.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Reuse responsive ready owner | current | primary-contract branch | yes | existing | preserve |
| Reuse alive but unresponsive ready owner | current | existing compatibility/single-owner branch | yes | existing | preserve |
| Reuse owner marked stopping | current | forbidden lifecycle branch | yes | existing | remove by waiting/reclaiming |
| Wait for stopping owner to exit, then existing election | proposed | primary-contract lifecycle branch | yes | primary | add |
| Graceful-only stop replaced by verified force termination after timeout | proposed | explicit user-authorized replacement | yes | primary | add under the quoted authorization in Section 1 |
| Catch local startup failure and synthesize a healthy TUI state | rejected | forbidden fallback | yes | 0 | reject |
| Spawn a second daemon when ping fails without stopping state | rejected | forbidden fallback | yes | 0 | reject |
| Change generic network error into success | rejected | forbidden fallback | yes | 0 | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| Alive-but-unresponsive URL is always returned | Prevents duplicate daemons during long model calls | Stopping is now observable through the control plane; ready/unresponsive preservation remains explicit | Collapse `tui/daemon.ts` owner decision |
| Graceful-only stop with timeout and no escalation | Avoided PID reuse and database takeover risk | Revalidation by token/PID preserves that safety while allowing the same owner to be terminated | Replace `cli/cmd/daemon.ts` timeout tail |
| Test-only disposal timeout as the only bounded disposal evidence | Prevents test afterEach from hanging | Production owner now gets a lifecycle cancellation/deadline; the test timeout remains a test fixture safeguard, not a production workaround | Preserve test fixture; do not copy it blindly |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | Worker shutdown completes or terminates by deadline | `worker.ts` stopping status and shutdown deadline | Real worker with a registered non-returning disposer in `daemon.test.ts` |
| INV-02 | Pending entry is cancelled before disposal wait | `instance-store.ts` entry producer control | `instance.test.ts` pending bootstrap disposal |
| INV-03 | Stopping owner is not reused | Control status read before owner reuse | `daemon.test.ts` stopping-owner acquisition |
| INV-04 | Stop escalates safely after graceful timeout | Authenticated same-owner force termination | `daemon.test.ts` real CLI stop against a non-exiting authenticated owner |
| INV-05 | Ready unresponsive owner remains single owner | Existing ready/unresponsive branch preserved | Existing `thread.test.ts` and daemon owner tests |
| INV-06 | SQLite ownership is protected | Token/PID revalidation before escalation; lock clear remains last on normal path | Existing lock/stop tests plus force-owner identity test |
| INV-07 | No stale local URL causes startup network error | New TUI waits/reclaims stopping owner | Real pre-first-SSE launcher test, pending-bootstrap test, and post-fix trace replay |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Pending bootstrap cancellation handle | INV-02 | `InstanceStore` currently waits its own Deferred before scope disposal | Existing `Deferred` alone cannot interrupt its producer |
| Worker stopping status in existing control endpoint | INV-03 | Control endpoint already authenticates and returns lifecycle counters | Public health cannot distinguish ready/unresponsive from stopping |
| Bounded worker shutdown deadline | INV-01 | Captured teardown stops before completion; test fixture records never-returning disposal | Existing graceful sequence has no deadline or final termination |
| Same-owner force escalation in stop command | INV-04/INV-06 | User can only manually kill; upstream precedent uses identity + SIGTERM/SIGKILL | Existing command deliberately stops after timeout |
| Stopping-owner wait/reclaim in `Daemon.ensure()` | INV-03/INV-05 | Existing fast path conflates stopping and long-call unresponsive owner | `sync.tsx` is downstream and cannot own daemon selection |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/project/instance-store.ts` | modify | Track/cancel pending bootstrap producer before waiting in `disposeAll()`; preserve completed-entry disposal and failure removal. | +45 / -15 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | Expose `stopping` in existing control status and add bounded shutdown termination around the existing cleanup order. | +45 / -10 |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | modify | Do not return a stopping owner URL; wait for owner exit and reuse the existing election/reclaim path. | +55 / -15 |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | Add same-owner force escalation after graceful timeout and verify exit/owner identity. | +45 / -5 |
| `packages/opencode/test/project/instance.test.ts` | modify | Add a public `InstanceStore.disposeAll()` pending-bootstrap regression slice. | +45 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | Add pre-first-SSE launcher Ctrl-C, real worker hanging-disposer deadline, stopping-owner, and CLI force-stop cases using isolated helpers. | +150 |

Expected total: 6 modified files, approximately 300-400 effective changed
lines, below the 800-line user limit. No files are added, deleted, generated,
or migrated.

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Spawn a real isolated launcher process that calls the public `Daemon.ensure()` path, wait for it to publish the worker lock before opening SSE, send `SIGINT` directly to the launcher PID, then assert launcher exit, bounded worker cleanup, lock release/dead-owner reclaim, and a subsequent owner acquisition that does not return the stale URL. The existing detached-child test separately verifies Unix process-group isolation. | The actual pre-first-SSE path has no Project bootstrap yet; current detached worker cleanup depends on startup idle/launcher watcher and can leave a live owner. | The launcher/worker lifecycle handles Ctrl-C before first SSE without leaving a live stale owner. | The real reachable pre-TUI/app lifecycle, without inventing Project bootstrap before app mount. |
| 2 | Start `InstanceStore.load()` with a bootstrap blocked on a Deferred, call `store.disposeAll()`, and require completion within a bounded test window. | `disposeAll()` waits the pending Deferred before it can close the producer scope. | Dispose interrupts/removes the pending entry and returns without waiting for the blocked producer. | Pending Project bootstrap cancellation after the TUI app has reached its API path. |
| 3 | Start the real worker in an isolated child wrapper, import the existing `registerDisposer`, register a non-returning disposer in that same worker process, load one Project through the real HTTP API, then send `SIGTERM` directly to the worker without invoking `daemon stop`. Require worker exit within the `5_000ms` worker deadline and PID death. | Current `InstanceRuntime.disposeAllInstances()` awaits the non-returning disposer and worker has no deadline; no CLI process can mask this direct signal path. | Worker logs bounded termination and exits by its own deadline; lock is then classified stale by the existing owner logic. | Direct red-green proof of the observed daemon hang and the worker-level deadline. |
| 4 | Use an isolated worker/control status and require that shutdown status reports `stopping` before cleanup completes. | Current `/status` has no lifecycle state. | Existing private status response reports stopping from the worker's shutdown guard. | New TUI can distinguish stopping from a long-call unresponsive owner. |
| 5 | Present a stopping owner to `Daemon.ensure()` and require it not to return the old URL; after owner exit it must use normal election/reclaim. | Current fast path returns any live PID URL. | Ensure waits boundedly and only returns a newly ready/reclaimed owner. | No repeated local startup network errors from a stopping owner. |
| 6 | Run real `opencode daemon stop` against an authenticated isolated owner that accepts graceful stop but does not exit; require the existing `10_000ms` graceful wait to transition to same-token/PID force termination and verify the changed-owner rejection separately. This test does not claim to test the worker deadline. | Current command only reports timeout and leaves PID alive. | The same token/PID owner is force-terminated; changed owner is not killed. | User no longer needs manual kill. |
| 7 | Run the existing healthy daemon startup/stop, unresponsive-ready-owner, launcher-exit, and detached-SIGINT cases. | Regression coverage protects the existing single-owner and platform behavior. | Existing behavior remains green with the new stopping branch. | No duplicate ready daemons or platform lifecycle regressions. |

The worker-deadline wrapper is an inline child process in
`daemon.test.ts`, not a production test hook or a separate file. It imports the
real `worker.ts`, then imports the existing `registerDisposer` module within
that same child process and registers the non-returning disposer before the
test sends an HTTP request that creates the Project entry. The test then sends
`SIGTERM` directly to that worker PID. The CLI force test uses a separate
authenticated non-exiting control owner so the worker's 5-second deadline
cannot mask the CLI's 10-second force path.

Tests must assert process/lock/status outcomes through public or control-plane
behavior. They must not assert private helper calls, source text, or call
counts.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 300-400 | Exclude imports, formatting, generated files, and pure moves. |
| Required Chinese explanatory comments `C` | 45-60 | `ceil(E * 0.15)`, distributed near lifecycle, cancellation, owner identity, and test-safety decisions. |

Qualifying comments must explain:

- Why pending bootstrap is interrupted before Deferred waiting.
- Why the worker lock is retained on normal teardown but not trusted after the process dies.
- Why stopping status must not be conflated with long-call unresponsive status.
- Why force termination requires same-token/PID revalidation.
- Why the test owner is isolated and why the test assertion is user-visible.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/project/instance.test.ts` | `packages/opencode` | Pending-bootstrap disposal regression and existing InstanceStore behavior. |
| `bun test test/cli/tui/daemon.test.ts -t "launcher Ctrl-C before first SSE releases startup owner"` | `packages/opencode` | Real `Daemon.ensure()` launcher/worker/SIGINT/lock/reclaim feedback loop before Project bootstrap begins. |
| `bun test test/cli/tui/daemon.test.ts -t "worker deadline terminates a hanging instance disposer"` | `packages/opencode` | Direct worker `SIGTERM` path proves the worker's own 5-second deadline, without CLI force escalation. |
| `bun test test/cli/tui/daemon.test.ts -t "force stops an authenticated non-exiting owner"` | `packages/opencode` | Real CLI graceful timeout, same-owner force termination, changed-owner rejection, and lock cleanup. |
| `bun test test/cli/tui/daemon.test.ts` | `packages/opencode` | Real daemon startup, stopping-owner, authorized stop escalation, launcher, and platform lifecycle behavior. |
| `bun typecheck` | `packages/opencode` | Type correctness for production changes. |
| `bun test --timeout 10000 test/fixture/fixture.test.ts` | `packages/opencode` | Existing disposal-timeout contract remains intact; explicit timeout covers its intentional 5200ms wait. |
| Post-fix feedback-loop trace command from section 8 | `packages/opencode` | Generates isolated post-fix daemon logs, verifies old-owner termination and lock release, reacquires a new owner, checks public health, and proves the network-failure plus incomplete-shutdown combination is absent. |
| `git diff --check` | repository root | No whitespace errors in the final diff. |

The process-spawning tests and implementation evidence are retained as historical
R5 evidence. R6 changes only the timeout argument for the independent fixture
verification command; it does not authorize any new implementation change.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | Reuse existing lifecycle and test files. |
| Files modified | 6 | Four production owners and two existing behavioral test files. |
| Files deleted | 0 | No superseded file requires deletion. |
| Production lines | 150-220 | Cancellation, stopping state, bounded shutdown, and stop escalation only. |
| Test lines | 140-180 | Two vertical behavior slices plus regression assertions. |
| Generated lines | 0 | No generated surface is involved. |

The total effective implementation change must remain below 800 lines and the
file count must remain at or below 6. A substantive scope increase requires a
new plan revision and full re-audit.

## 20. Real Risks and Open Decisions

### Real Risks

- Force termination can leave a stale lock and an interrupted SQLite state. The
  existing dead-owner reconciliation and maintenance recovery are the intended
  recovery path; the plan never clears a live or changed owner lock blindly.
- A stopping owner can delay a new TUI until the bounded teardown window ends.
  This is preferable to returning a dead local URL or spawning a second SQLite
  owner.
- Pending bootstrap cancellation must resolve the entry and remove it from the
  cache so later requests can load a fresh Project rather than reusing a failed
  Deferred.
- The existing `daemon stop` timeout is 10 seconds. The implementation must
  keep force escalation within the command's bounded operation and avoid a
  second unbounded wait.

### Open Decisions Requiring the User

None. The user has already constrained the solution to a small change surface;
the canonical route preserves that constraint without changing the product
contract.

### Rejected Speculation

- External Provider/network failure as the direct root cause: the observed
  failed requests are local daemon API calls, and the error occurs after local
  shutdown begins.
- Always spawning a second daemon after any failed health ping: this violates
  the existing single-owner SQLite invariant and is explicitly covered by
  current tests.
- Rewriting the generic error message as the primary fix: it would only change
  the symptom adapter while leaving the stale owner alive.
- Adding broad native process/event-loop watchdogs for unobserved synchronous
  freezes: no current trace proves that path.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries and prior diagnosis as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check root-cause repair, pending cancellation, shutdown ownership, force-stop
  safety, no fallback, tests, code quality, and the 15 percent Chinese
  explanatory-comment plan.
- Check the six-file and 800-line scope constraint.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01` Blocking: 未获用户明确授权的强制终止构成新增备用成功路径; `B-02` Blocking: 原始 Ctrl-C 用户反馈回路没有被行为级测试完整覆盖 | Canonical metadata audit mode; unspecified deadline value; old fixed replay paths | `BLOCK` | `ses_0793c3de1ffePLm6u42nU2RZCt` |
| 2 | R2 | yes | `B-01` Blocking: TDD slice 1 构造了当前调用链中不存在的“app import 前 Project bootstrap”路径 | Section 18 still described process side effects as user-prohibited; deadline value and post-fix replay input were unspecified | `BLOCK` | `ses_0793c3de1ffePLm6u42nU2RZCt` |
| 3 | R3 | yes | `B-01` Blocking: INV-01 的 worker 有界终止没有行为级 red 测试，无法证明原始 daemon 挂起根因已被修复 | R3 audit record was missing; worker deadline value and wrapper protocol were unspecified | `BLOCK` | `ses_0793c3de1ffePLm6u42nU2RZCt` |
| 4 | R4 | yes | `B-01` Blocking: Worker shutdown deadline 的回归测试被 `daemon stop` 的强制终止路径遮蔽，无法证明 INV-01 的 worker-level 修复 | R4 audit record was missing; deadline value and wrapper protocol were unspecified | `BLOCK` | `ses_0793c3de1ffePLm6u42nU2RZCt` |
| 5 | R5 | yes | none | Section 8 historical wording; R4 audit record before this row; post-fix trace input path; HTTP API route specificity | `No blocking findings. APPROVE` | `ses_0793c3de1ffePLm6u42nU2RZCt` |
| 6 | R6 | yes | `B-01` Blocking: post-fix feedback-loop verification reused immutable pre-fix log paths and could not execute as specified. | Ctrl-C test wording differed from direct PID signal; historical implementation evidence remained adjacent to current metadata; historical and post-fix evidence roles were easy to conflate. | `BLOCK` | `ses_078f02f83ffewwnbgvvkr1ziN9` |
| 7 | R7 | yes | none | Canonical document mixes current plan metadata with historical implementation evidence; post-fix trace records old/new URLs without directly asserting inequality; immutable pre-fix and executable post-fix evidence remain adjacent but distinguished. | `No blocking findings. APPROVE` | `ses_0782efb95ffeCIIRNi6nxK6L0w` |

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

Implementation completed and independently verified for approved revision R7.

### Actual Files and Diff

- `packages/opencode/src/project/instance-store.ts`: added per-entry bootstrap
  cancellation and cancel-first disposal so pending Project bootstrap cannot
  block instance teardown.
- `packages/opencode/src/cli/cmd/tui/worker.ts`: added a 5-second worker
  shutdown deadline, `stopping` control status, and bounded exit behavior.
- `packages/opencode/src/cli/cmd/tui/daemon.ts`: distinguishes stopping owners
  from ordinary unresponsive owners, waits for the stopping PID, and preserves
  the single SQLite owner invariant.
- `packages/opencode/src/cli/cmd/daemon.ts`: retains the 10-second graceful
  stop, then revalidates the same PID/token/controlPort before SIGKILL and
  bounded post-kill verification.
- `packages/opencode/test/project/instance.test.ts`: real pending bootstrap
  cancellation regression.
- `packages/opencode/test/cli/tui/daemon.test.ts`: real worker deadline,
  authenticated force-stop, stopping-owner acquisition, and existing daemon
  lifecycle regressions.

The implementation diff is 6 files, 528 added lines, and 16 removed lines.
No production fallback, second-owner spawn, schema change, dependency, or
generic network-error suppression was added.

### Red-Green Test Evidence

- Pending bootstrap slice red: `bun test test/project/instance.test.ts -t
  "cancels pending bootstrap during disposeAll"` timed out after 5000ms on the
  pre-fix implementation.
- Pending bootstrap slice green: same command passed with `1 pass` after the
  cancel-first implementation.
- Worker deadline slice green: the real worker child with a never-resolving
  registered disposer received direct `SIGTERM` and exited within the bounded
  window; `1 pass`.
- Force-stop slice green: an authenticated fake owner accepted graceful stop,
  stayed alive, then was force-stopped only after same-owner revalidation;
  `1 pass`.
- Changed-owner force slice green: a replacement owner changed the lock after
  graceful stop began; the CLI refused escalation, returned nonzero, and the
  replacement PID remained alive; `1 pass`.
- Real pre-first-SSE launcher slice green: a child process called public
  `Daemon.ensure()`, published a worker lock without opening SSE, received
  `SIGINT`, and the worker died before a second public `Daemon.ensure()` call
  acquired a different owner; `1 pass`.
- Stopping-owner slice green: a token-protected `/status` response reporting
  `stopping` was not reused; the next acquisition waited for owner exit and
  did not return the stale public URL; `1 pass`.

### Verification Commands and Results

- `bun test test/project/instance.test.ts`: `10 pass, 0 fail`.
- `bun test test/cli/tui/daemon.test.ts`: `29 pass, 3 skip, 0 fail`.
- `bun test --timeout 10000 test/fixture/fixture.test.ts`: `7 pass, 0 fail`.
- `bun typecheck` from `packages/opencode`: passed.
- `git diff --check` on all six implementation files: passed.
- Section 8 post-fix feedback-loop command: exit code 0 with
  `networkFailure=false`, `shutdownStarted=true`, and
  `shutdownCompleted=true`.
- Effective scope: 6 implementation files and 528 added lines, below the
  six-file/800-line constraint.

### Original Feedback-Loop Result

The immutable pre-fix captured replay remains the red baseline:
`{"networkFailure":true,"shutdownStarted":true,"shutdownCompleted":false}`
with exit code 1. The post-fix behavior is covered by the real worker and CLI
child-process tests above: a hanging disposer reaches the worker deadline,
stopping owners are not reused, and authenticated same-owner force escalation
completes with lock cleanup. The R7 inline trace command additionally generated
an isolated post-fix trace and returned
`{"networkFailure":false,"shutdownStarted":true,"shutdownCompleted":true}`
with exit code 0 after old-owner death, lock release, second owner acquisition,
and successful public health. The original captured output was not rewritten.

### Actual Secondary and Replacement Path Inventory

- `daemon stop` graceful timeout now has one explicit replacement path:
  re-read lock, require unchanged `pid + token + controlPort`, send SIGKILL,
  verify PID exit, then clear only the same token lock.
- Worker shutdown deadline is a bounded terminal path, not a second cleanup
  implementation; stale-owner reconciliation remains the recovery path after
  process termination.
- Stopping-owner acquisition waits and returns to the existing election path;
  it does not spawn a competing daemon and does not reuse the old public URL.
- Pending bootstrap cancellation is the primary teardown repair; no downstream
  UI catch, network-message rewrite, or generic error suppression was added.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 429 | Independent R5 implementation audit: exclude 27 blank, 69 comment, and 3 import-only lines; generated/pure moves 0. |
| Qualifying Chinese comment lines `C` | 66 | Independent R5 implementation audit; nearby explanations only. |
| Ratio `C / E` | 15.38% | `66 / 429`. |
| Required minimum `C` | 65 | `ceil(429 * 0.15) = 65`. |

### Remaining Unverified Items

None.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | `B-01` Blocking: original pre-first-SSE launcher Ctrl-C feedback loop was not behaviorally verified; `B-02` Blocking: changed-owner force-stop rejection was unverified. | Diff additions were undercounted by one; stale graceful-only CLI comment; plan status still read approved. | `BLOCK` | `ses_0790405caffeDqu45Fb8tTL2EJ` |
| 2 | R5 | yes | `B-01` Blocking: required `bun test test/fixture/fixture.test.ts` reproducibly failed at the default 5-second Bun test timeout before its intentional 5200ms timer-cleanup assertion completed. | Stale verification-stage wording; historical evidence-table drift; implementation evidence comment calculation pending independent recomputation. | `BLOCK` | `ses_0790405caffeDqu45Fb8tTL2EJ` |
| 3 | R7 | yes | none | Canonical metadata still said plan audit; `Implementation allowed: no` needed final-state clarification; post-fix trace did not directly assert URL inequality but the launcher regression asserted distinct owner PIDs; historical diagnosis remained in present tense. | `No blocking findings. RELEASE VERDICT: APPROVE` | `ses_0790405caffeDqu45Fb8tTL2EJ` |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
