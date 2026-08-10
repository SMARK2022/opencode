# Canonical Implementation Plan: Windows Daemon SQLite Buffer Corruption Repair

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: implementation (full-scope)
>
> Requirement source: current Session GOAL supplied by the user
>
> Implementation allowed: no
>
> Last updated: 2026-08-10

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, incident recovery artifacts, and builder
rationale outside this file are not implementation authority.

R2 resolves plan-audit finding B-01. The single ProcessStartInfo path now
explicitly keeps `CreateNoWindow=false`: both modes receive pipe-backed
stdout/stderr before Bun starts, the default worker then performs its existing
`FreeConsole`, and `--print-logs` keeps its existing shared-console/Ctrl-C
contract. A live print-log characterization must assert both console attachment
and distinct stdout/stderr forwarding.

The R2 implementation diff is frozen for independent implementation audit. No
further material change is allowed without approved rework or a new revision.

## 1. Verbatim Requirement

> 准确完整识别当前daemon的SQLiteError: database disk image is malformed
>     at values (unknown)
>     at all
>     at run
>     at MQ0
>     at Gq
>     at <anonymous>
>     at MessageV2.page
>     at Session.messages
>     at SessionRevert.cleanupCurrent
>     at SessionRevert.cleanup
>     at SessionPrompt.prompt以及数据库被缓冲区写坏的问题；同时如果审计员给你了blocker，请你首先分析是否是用户原始要求范围内的bug，如果与现在问题大概无关，请进行rebuttal，禁止直接进行对blocker的方案修改；
> 从根源上问题，避免进行额外的数据库schema添加以及迁移，禁止以“遇到问题报错”为解决目标，解决方式应该是解决实质性错误的生产路径，而非修改错误的消费路径，即后续不再会产生该种错误，且整体修改保持克制，即仅精准修改现有的会产生该种错误schema的代码路径，同时在不破坏现有功能和性能的前提下，修复该问题。整体修改文件数不超过四个生产文件，不超过400行代码
>
> 目标终态：verified-implementation

The GOAL contract additionally requires one canonical plan, full-scope
independent plan and implementation audits, TDD red-green evidence, no
implementation before exact-revision approval, and fact-only reconsideration
of any blocker whose reachability or scope is uncertain.

## 2. Explicit Non-Goals

- Do not add or alter a SQLite table, column, index, migration, journal format,
  database setting, or persisted representation.
- Do not change `MessageV2.page`, `Session.messages`, `SessionRevert`, or
  `SessionPrompt.prompt`; they are consumers that correctly exposed pre-existing
  physical corruption.
- Do not add startup `quick_check`, `cell_size_check`, backup policy, recovery
  fallback, error conversion, or corruption-tolerant read path. Those detect or
  consume damage after the producing path has already failed.
- Do not suppress the incident only by adding `streamText.onError` to the
  permission reviewer. `console.error` is a reachable legitimate runtime
  producer; suppressing one producer leaves every other runtime write exposed
  to the same invalid standard handles.
- Do not change Provider retry, permission-reviewer decision, Session retry,
  daemon election, SQLite ownership, Ctrl-C, idle shutdown, or Server Lock
  semantics.
- Do not upgrade Bun, SQLite, AI SDK, or any dependency, and do not add a flag,
  public API, compatibility layer, alternate launcher, or fallback spawn path.
- Do not modify Unix/macOS process-group behavior.
- Do not alter or replace the already recovered user database as part of the
  implementation. The immutable incident copy is evidence only.
- Do not create a commit or push; the requested terminal state is
  `verified-implementation`, not a commit state.

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md:9-31,71-110,127-175` | A Session and its Messages are persisted in SQLite; the daemon is the shared runtime owner; use the canonical Session/Message/Provider/Permission vocabulary. |
| `AGENTS.md:21-141` | Requires minimal owner-local changes, rare meaningful comments, package-local tests, and `bun typecheck` instead of direct `tsc`. |
| `packages/opencode/AGENTS.md:1-10,76-135` | Defines SQLite ownership conventions and Effect/module rules; no schema or migration is needed for this transport defect. |
| `packages/opencode/test/AGENTS.md:1-17,83-177` | OS-process tests use live behavior, isolated `tmpdir`, automatic cleanup, and published readiness rather than fixed sleeps. |
| `docs/adr/README.md:1-50` | No accepted daemon/SQLite ADR exists; ADR 0001 concerns triage and is unrelated. This owner-local transport correction does not require a new ADR. |
| `.opencode/policy/first-principles-engineering.md` | Requires first-divergence repair, one primary path, no fallback, forward/reverse traceability, behavior-sensitive tests, and the 15% Chinese explanatory-comment gate. |
| `.opencode/templates/canonical-plan.md` | Defines this artifact, audit transitions, implementation evidence, and verification sections. |
| `docs/plans/windows-hidden-spawn-test-and-daemon-wrapper.md` | Preserves the existing absolute SystemRoot PowerShell wrapper, hidden-window behavior, PID handshake, target paths with spaces, and launcher-independent worker lifecycle. |
| `docs/plans/daemon-ctrl-c-shutdown-lifecycle.md` | Preserves the intentional Windows `FreeConsole` Ctrl-C isolation and the single-daemon SQLite-owner invariant. |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts:69-186,330-383` | Windows wrapper uses `Start-Process`; only the wrapper has a Bun stdout pipe. The worker inherits console standard handles, while default caller stdio is ignore and `--print-logs` is inherit. | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts:1-64,93-108,269-321` | Calls `win32DetachConsole()` before serving Projects and before lazy database use; preserves Ctrl-C isolation and closes the database during shutdown. | observed |
| `packages/opencode/src/cli/cmd/tui/win32.ts:70-93` | Documents and executes `FreeConsole`; current contract already states console stdio handles become invalid. | observed |
| `packages/opencode/src/storage/db.ts:92-169,179-189` | Lazily opens one Bun/SQLite client on first `Database.use`; WAL/checkpoint/migrations are downstream and are not the owner of standard handles. | observed |
| `packages/opencode/src/permission/reviewer/service.ts:609-648,698-706,878-884` | The hidden permission reviewer uses `streamText` without overriding `onError`, making AI SDK default console output reachable for Provider stream errors. | reachable |
| `packages/opencode/src/session/llm.ts:353-424` | The only other production `streamText` call explicitly logs `onError`; the repository has exactly two call sites. | observed |
| `node_modules/ai/src/generate-text/stream-text.ts:317-319,857-881` | AI SDK's default `onError` is `console.error(error)` and is invoked for a stream `error` part. | contracted dependency behavior |
| `packages/core/src/util/log.ts:61-69,71-162,187-236` | Default daemon application logs are file-backed, but dependency-owned `console.error` bypasses that logger and writes to process stderr. | reachable |
| `packages/opencode/src/session/message-v2.ts:1398-1493` | `MessageV2.page` performs the SQLite read that surfaced malformed pages; it is a consumer, not the producer. | observed |
| `packages/opencode/src/session/session.ts:878-901` | `Session.messages` delegates to `MessageV2.page`, matching the user stack. | observed |
| `packages/opencode/src/session/revert.ts:171-253` | `cleanupCurrent` reads the complete Session history through `Session.messages`, matching the user stack. | observed |
| `packages/opencode/src/session/prompt.ts:2429-2435` | `SessionPrompt.prompt` invokes Revert cleanup before creating a new Message, matching the final stack frame. | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts:1-65,2063-2262` | Existing live Windows tests cover wrapper hide, path quoting, 1 MB output drain, launcher exit, full daemon HTTP/SSE/control operation, and Ctrl-C detachment; no test checks standard-handle validity after `FreeConsole`. | observed |
| Current print-log characterization command | Real `_spawn` with `OPENCODE_PRINT_LOGS=1` reports `consoleCP=65001`, four attached console processes, and stdout/stderr `FILE_TYPE_PIPE=3`; this is the pre-change compatibility baseline. | observed |
| Current default pre-detach characterization command | Real `_spawn` before worker detach reports `consoleCP=65001`, one attached console process, and stdout/stderr `FILE_TYPE_CHAR=2`; this proves default mode currently starts attached and relies on `FreeConsole`. | observed |
| `packages/opencode/test/permission/reviewer-service.test.ts:23-55,782-847,1322-1355` | Real OpenAI Responses SSE fixture proves the reviewer-to-AI-SDK seam; no production change is planned here. | observed |
| `package.json:7` | Runtime is pinned to Bun 1.3.14. | contracted |
| Bun 1.3.14 `src/sys/fd.zig:81-92,148-166,679-682` | Windows stdout/stderr return cached handles; source explicitly says they are snapshotted at startup and may differ after console changes. | contracted runtime behavior |
| Microsoft `FreeConsole`, `GetStdHandle`, `WriteFile`, and kernel-object documentation | `FreeConsole` detaches the process; standard-handle table values are not validated until I/O; `WriteFile` targets the object named by the HANDLE and updates synchronous file position. | contracted platform behavior |
| SQLite `howtocorrupt.html` and SQLite 3.53 `src/os_win.c` `winWrite` | SQLite documents stale output descriptors overwriting database files; Windows VFS writes full pages through a native file HANDLE at explicit page offsets. | contracted storage behavior |
| `D:/Temp/opencode/db-recovery-20260809-213324/source-latest/opencode.db` | Immutable incident source still raises `database disk image is malformed`. Pages 460825, 461447, and 464158 share one exact 525-byte foreign prefix. | observed |
| `D:/Temp/opencode/db-recovery-20260809-213324/opencode-recovered-latest.manifest.json` | Recovery evidence identifies 12 affected Part rows; all 20 table hashes match, recovered integrity is `ok`, and foreign-key check is empty. It is incident evidence, not a production repair path. | observed |
| Inline incident feedback command recorded in section 8 | Actual `_spawn` + `FreeConsole` yields stdout/stderr type 0; actual AI SDK error output is byte-identical to the three damaged page prefixes. | observed |
| `git blame` / history: `d7bc8462e4f`, `43f17817d5b`, `12663b5e09f`, `6d90ba6c7af` | `FreeConsole` was introduced after reviewer streaming; later PowerShell wrapper retained inherited worker stdio. Normal Session logging already has an explicit `onError`, while reviewer output remains a reachable trigger. | observed history |

External references:

- <https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/sys/fd.zig>
- <https://learn.microsoft.com/en-us/windows/console/freeconsole>
- <https://learn.microsoft.com/en-us/windows/console/getstdhandle>
- <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-writefile>
- <https://learn.microsoft.com/en-us/windows/win32/sysinfo/kernel-objects>
- <https://www.sqlite.org/howtocorrupt.html>
- <https://raw.githubusercontent.com/sqlite/sqlite/version-3.53.0/src/os_win.c>

## 5. Current Behavior

```text
TUI / CLI -> Daemon.ensure()
  -> spawnDaemon() Windows adapter
  -> Bun.spawn(SystemRoot PowerShell, stdout pipe, hidden)
  -> Start-Process worker (-WindowStyle Hidden | -NoNewWindow)
       // worker inherits console-backed stdout/stderr; no worker pipe is created
  -> wrapper publishes worker PID and waits
  -> worker Log.init(file-backed)
  -> worker FreeConsole()
       // console-backed stdout/stderr become invalid; Bun retains startup stdio identity
  -> Server starts; first Project/Message operation lazily opens SQLite
  -> permission reviewer receives Provider SSE error
  -> AI SDK default onError -> console.error(raw Provider event)
  -> stale stderr HANDLE value names SQLite's reopened file object
  -> exact 525-byte error buffer overwrites a 4096-byte page prefix
  -> MessageV2.page SQL read -> SQLiteError: database disk image is malformed
  -> Session.messages -> SessionRevert.cleanupCurrent -> cleanup -> SessionPrompt.prompt
```

The incident source contains this exact foreign value three times:

```text
{
  type: "error",
  sequence_number: 2,
  error: {
    type: "service_unavailable_error",
    code: "server_is_overloaded",
    message: "Our servers are currently overloaded. Please try again later.",
    param: null,
  },
}
```

Under Bun 1.3.14, real `console.error(event)` emits 525 bytes whose SHA-256 is
`673f54d8381df44762653631d3d24570a15a0583bd0bfd0fe8815afb9d115be8`.
The first 525 bytes of all three damaged pages have the same hash and compare
byte-for-byte equal. Random media damage, SQL serialization, and ordinary WAL
content cannot generate this ANSI-colored runtime representation at the same
page-relative offset.

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Default Windows daemon launch | TUI/CLI `Daemon.ensure` | Absolute SystemRoot PowerShell; hidden wrapper; one worker | `spawnDaemon` -> `Start-Process` -> worker | Windows daemon spawn adapter | observed |
| Worker `FreeConsole` | `worker.ts` when `printLogs=false` | Intentionally detaches Ctrl-C delivery | worker startup before Server/SQLite activity | Windows worker transport contract | observed |
| Provider stream error object | OpenAI Responses SSE / AI SDK | Valid structured stream error; default `onError` may print it | permission reviewer `streamText` -> `console.error` | AI SDK producer; daemon owns its output transport | observed |
| Any other dependency/runtime stdout or stderr write | Reachable loaded dependencies and runtime | May legitimately use standard streams without OpenCode logger | worker process stdio | daemon spawn adapter | reachable |
| SQLite HANDLE allocation after detach | First `Database.use` in daemon | One client, WAL, mmap disabled in incident runtime | Project/Session request after worker startup | SQLite VFS allocates file; daemon must not alias it with stdio | observed incident class |
| `--print-logs` Windows daemon | CLI argument / env | Worker keeps console attachment today and logs remain visible | same wrapper with inherited output | daemon spawn adapter | contracted |
| High-volume worker stdout | Existing path-with-spaces test writes 1 MB | Worker must not block before readiness | wrapper output drain | daemon spawn adapter | observed |
| Wrapper/launcher exits before worker | TUI launcher lifecycle | Worker remains owner; adapter exposes worker PID | existing wrapper lifecycle | daemon spawn adapter | contracted/observed |
| Unix/macOS daemon | `Daemon.ensure` | detached process group, no `FreeConsole` | direct `Bun.spawn` | existing Unix branch | contracted, preserved |
| Malformed database reads | Existing physically damaged database | SQLite reports corruption | Message/Revert/Prompt stack | storage consumer | observed, not a repair owner |

Speculative inputs do not drive this plan. In particular, no hidden second
daemon, WAL reset race, mmap write, disk bit-flip, or malicious input is needed
or supported by the incident evidence.

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| REQ-01 | The implementation repairs the producer-side path that allowed a runtime buffer to overwrite SQLite; it does not make downstream reads tolerate or merely report corruption. | Verbatim requirement | None |
| REQ-02 | No schema, migration, database format, setting, public API, dependency, or fallback is added. | Verbatim requirement | Schema/migration diff audit |
| REQ-03 | At most four production files and fewer than 400 changed lines; unrelated behavior and performance remain intact. | Verbatim requirement | Diff audit + regressions |
| INV-01 | A default Windows daemon worker retains valid stdout and stderr handles after `FreeConsole`; both are non-console pipes for its lifetime. | Platform contract + red feedback loop | Missing; planned live `_spawn` test |
| INV-02 | A worker's standard-stream write can reach only its configured pipe, never an unrelated file HANDLE opened later by SQLite or another subsystem. | Incident bytes + Bun cached stdio + Windows HANDLE semantics | Planned OS handle-type test |
| INV-03 | PID handshake, worker PID identity, absolute wrapper path, target paths with spaces, hidden launch, launcher independence, and worker exit propagation remain unchanged. | Existing wrapper contract/tests | Existing daemon tests |
| INV-04 | Default output is continuously drained without becoming user-visible; `--print-logs` output is continuously forwarded; neither mode can deadlock on pipe backpressure or lose tail bytes at exit. | Existing options and 1 MB test; print-logs contract | Default drain existing; print-logs planned characterization |
| INV-05 | `FreeConsole` continues to isolate the default Windows worker from shared-console Ctrl-C while HTTP, SSE, control port, idle, stop, and SQLite single-owner behavior remain intact. | Existing lifecycle plans/tests | Existing full worker tests |
| INV-06 | Unix/macOS continues using direct detached `Bun.spawn` with unchanged stdio semantics. | Existing code contract | Existing Unix tests |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/INV-02 | The Windows wrapper creates the Bun worker with inherited console stdout/stderr via `Start-Process`; no non-console worker stdio is bound before Bun snapshots its handles. `FreeConsole` then invalidates those inherited handles. | `daemon.ts` `spawnDaemon` Windows process/stdio adapter | Actual `_spawn` harness reports `{ detached: 1, stdout: 0, stderr: 0 }`; `win32.ts` already documents invalidation; Bun source documents cached startup handles. |
| REQ-01 | After the first divergence, a reachable AI SDK `console.error` emits the exact incident bytes. Suppressing this one producer would leave INV-02 false for all other writes. | Not owned by reviewer/Message/SQLite; transport owner remains `spawnDaemon` | Real AI SDK replay emits 525 bytes exactly equal to each damaged prefix. |
| Stack symptom | `MessageV2.page` reads an already malformed page and SQLite rejects it. | Storage consumer, deliberately unchanged | Immutable source reproduces the user stack's `database disk image is malformed`. |

### Red-capable feedback loop

The following command was run from `packages/opencode`. It uses the real
`DaemonModule._spawn` Windows wrapper, a system-temp worker that executes
`FreeConsole`, a real AI SDK OpenAI Responses error stream, and the immutable
incident page prefix. It removes its temporary worker in `finally`.

```powershell
$code = @'
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

const event = {
  type: "error",
  sequence_number: 2,
  error: {
    type: "service_unavailable_error",
    code: "server_is_overloaded",
    message: "Our servers are currently overloaded. Please try again later.",
    param: null,
  },
}
const root = path.join(tmpdir(), "opencode-sqlite-incident-loop-" + crypto.randomUUID())
await mkdir(root, { recursive: true })
const marker = path.join(root, "stdio.json")
const worker = path.join(root, "worker.ts")
await Bun.write(
  worker,
  `import { dlopen } from "bun:ffi"
const k = dlopen("kernel32.dll", {
  AllocConsole: { args: [], returns: "i32" },
  FreeConsole: { args: [], returns: "i32" },
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  GetFileType: { args: ["ptr"], returns: "u32" },
})
k.symbols.AllocConsole()
const detached = k.symbols.FreeConsole()
const stdout = k.symbols.GetStdHandle(-11)
const stderr = k.symbols.GetStdHandle(-12)
await Bun.write(process.env.INCIDENT_MARKER, JSON.stringify({
  detached,
  stdout: k.symbols.GetFileType(stdout),
  stderr: k.symbols.GetFileType(stderr),
}))
setInterval(() => {}, 1000)
`,
)

let proc
try {
  const daemon = await import("./src/cli/cmd/tui/daemon.ts")
  proc = await daemon._spawn([process.execPath, worker], {
    env: { ...process.env, INCIDENT_MARKER: marker },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: false,
  })
  const deadline = Date.now() + 10_000
  let handles
  while (Date.now() < deadline) {
    handles = await Bun.file(marker).json().catch(() => undefined)
    if (handles) break
    await Bun.sleep(25)
  }

  const providerSource = `import { createOpenAI } from "@ai-sdk/openai"
import { streamText } from "ai"
const event = ${JSON.stringify(event)}
const fetch = Object.assign(
  async () => new Response("data: " + JSON.stringify(event) + "\\n\\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }),
  { preconnect() {} },
)
const result = streamText({
  model: createOpenAI({ apiKey: "test", fetch }).responses("gpt-5"),
  messages: [{ role: "user", content: "x" }],
  maxRetries: 0,
})
for await (const _ of result.fullStream) {}
`
  const provider = Bun.spawn([process.execPath, "-e", providerSource], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  })
  const emitted = Buffer.from(await new Response(provider.stderr).arrayBuffer())
  await provider.exited
  const database = Buffer.from(
    await Bun.file("D:/Temp/opencode/db-recovery-20260809-213324/source-latest/opencode.db").arrayBuffer(),
  )
  const prefix = database.subarray((460825 - 1) * 4096, (460825 - 1) * 4096 + 525)
  const report = {
    handles,
    providerBytes: emitted.length,
    byteEqual: emitted.equals(prefix),
    sha256: new Bun.CryptoHasher("sha256").update(emitted).digest("hex"),
  }
  console.log(JSON.stringify(report))
  if (!report.byteEqual) throw new Error("incident Provider buffer no longer matches the immutable source")
  if (handles?.stdout !== 3 || handles?.stderr !== 3) {
    throw new Error("RED: exact incident buffer remains reachable through invalid daemon standard handles")
  }
} finally {
  proc?.kill()
  await proc?.exited.catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
'@
bun -e $code
```

Its independent observable report and verdict were:

```text
{"handles":{"detached":1,"stdout":0,"stderr":0},"providerBytes":525,"byteEqual":true,"sha256":"673f54d8381df44762653631d3d24570a15a0583bd0bfd0fe8815afb9d115be8"}
error: RED: exact incident buffer remains reachable through invalid daemon standard handles
exit code 1
```

The minimized implementation-time regression removes the external incident
file dependency and asserts the owning seam directly: after a worker launched
through `_spawn` calls `FreeConsole`, `GetFileType(stdout)` and
`GetFileType(stderr)` must both equal the independent Windows constant
`FILE_TYPE_PIPE` (`3`). Current output is deterministically `0/0`; the approved
repair must make it `3/3`.

### Ranked hypotheses and outcomes

| Rank | Hypothesis and falsifiable prediction | Result |
| --- | --- | --- |
| 1 | Inherited console stdio becomes stale after `FreeConsole`; if true, actual `_spawn` reports invalid handles and real AI SDK output equals the foreign bytes. | Confirmed: `0/0`, 525 bytes, exact hash/equality. |
| 2 | SQLite WAL-reset concurrency corrupted pages; if true, damage should be SQLite page content and require concurrent connections/checkpoint/reset. | Rejected: incident used SQLite 3.53, one daemon owner, and pages contain ANSI Bun object output. |
| 3 | SQLite mmap/page-cache memory corruption wrote the buffer; if true, incident runtime needs a nonzero `mmap_size` or matching WAL page image. | Rejected for planned behavior: incident `mmap_size=0`; retained WAL is zero bytes; direct standard-stream producer and invalid handle are observed. |
| 4 | Random disk/media damage; if true, damage should not repeat one exact high-level object serialization at three page starts. | Rejected: three identical 525-byte prefixes and exact `console.error` reproduction. |
| 5 | A second daemon or TUI wrote the database concurrently; if true, a second SQLite owner must be present and still cannot explain foreign ANSI output. | Rejected: process topology had one worker; TUI clients do not own SQLite; concurrency cannot synthesize the observed bytes. |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Windows worker stdio before `FreeConsole` | `daemon.ts` `spawnDaemon` | Create and supervise the worker with caller-requested output semantics | It is the only process-creation seam and can bind HANDLEs before Bun starts | Worker code cannot retroactively change Bun/CRT startup snapshots safely; DB and reviewer do not own process handles |
| Ctrl-C detachment precondition | `win32.ts` contract + worker call site | Detach only while non-console stdio remains valid | These comments document the caller invariant at the native boundary | No new native behavior is needed; process creation enforces it |
| Provider error output | AI SDK / permission reviewer | A stream error may invoke configured/default error observation | It is a legitimate producer that exposes the transport defect | Suppressing it is a one-producer workaround and would not protect other runtime output |
| SQLite file integrity | Existing SQLite client and single daemon | Ordinary SQLite I/O must not receive unrelated writes | Preserved once HANDLE aliasing is removed at process creation | Schema, migrations, checks, and Message reads act after the first divergence |
| Behavioral verification | Existing public test seam `DaemonModule._spawn` | Launch the real Windows adapter and return real worker PID/lifecycle | It observes the actual OS handle type after the worker operation | Source-text checks or `_setSpawn` bypass the adapter and cannot prove HANDLE behavior |

## 10. Single Approved Primary-Path Design

```text
Windows Daemon.ensure
  -> spawnDaemon (same absolute PowerShell wrapper)
  -> PowerShell ProcessStartInfo for Bun worker
       FileName = OPENCODE_DAEMON_EXECUTABLE
       Arguments = quoted worker target
       UseShellExecute = false
       CreateNoWindow = false
       RedirectStandardOutput = true
       RedirectStandardError = true
  -> Process.Start() creates worker with pipe-backed stdio before Bun startup
  -> wrapper publishes the real worker PID using its existing PID protocol
  -> start concurrent CopyToAsync drains for both worker pipes
       default: Stream.Null
       OPENCODE_PRINT_LOGS=1: wrapper stdout/stderr
  -> worker FreeConsole detaches only console association; pipe HANDLEs remain valid
  -> WaitForExit, then await both drains, then propagate worker exit code
```

`Start-Process` is replaced rather than retained. There is one Windows worker
creation path and one output transport, with only the already-supported
default/print-logs destination choice inside that contract. Drains start before
waiting for worker exit so output cannot fill a pipe and prevent exit. Drains
are awaited after exit so final bytes are not lost.

The Unix branch remains the current direct detached `Bun.spawn`. The adapter
continues to expose the worker PID, not the PowerShell wrapper PID. Existing
kill ordering (worker before wrapper), wrapper output drain, absolute path,
quoted target, hidden wrapper, election, and lifecycle semantics remain intact.

`CreateNoWindow=false` is intentional and common to both Windows modes. The
PowerShell wrapper remains attached to the launcher's existing console while
its window is hidden by the existing wrapper `windowsHide=true`; the worker
therefore shares that console without creating a second window. Default mode
then runs the existing `FreeConsole`, while print-log mode deliberately skips
detach and retains current Ctrl-C propagation. Redirecting stdout/stderr does
not remove the process's console association; it only replaces the two standard
stream HANDLEs with pipes.

The change repairs the first divergence because every standard-stream write is
directed to a live pipe created before Bun snapshots its handles. No database
code needs to recognize the Provider object or detect damage, and no producer
must be enumerated or suppressed.

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Windows ProcessStartInfo worker with pipe stdio | proposed | primary-contract branch | yes | primary | replace current Start-Process path |
| Default worker output -> `Stream.Null` | proposed destination within primary transport | primary-contract branch | yes | ~20% of changed destination branch | preserve caller's ignore semantics |
| `--print-logs` worker output -> wrapper streams | proposed destination within primary transport | primary-contract branch | yes | ~20% of changed destination branch | preserve visible diagnostic semantics |
| Unix direct detached worker | current | primary-contract platform branch | yes | unchanged | preserve |
| AI SDK default `console.error` | current reachable producer | contracted pass-through to stdio | no alternate application success | unchanged | preserve; transport is repaired |
| Add reviewer-only `onError` | rejected | forbidden workaround if used as repair | no | n/a | reject |
| Add DB integrity gate/tolerant read/recovery | rejected | downstream diagnostic/fallback outside request | no/alternate | n/a | reject |
| Retry with old Start-Process if ProcessStartInfo fails | rejected | forbidden fallback | yes | n/a | reject |

New alternate success paths: 0. Diagnostic decision surface added in production:
0%. The existing print-logs destination is preserved, not expanded.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| PowerShell `Start-Process` worker creation with inherited stdio | Supplied hidden/no-new-window worker launch and PID ownership | It cannot bind independently drainable pipe HANDLEs before Bun startup | Replace the `Start-Process` block in `daemon.ts`; do not retain as fallback |
| Comment assumption that file-backed OpenCode logs make invalid stdio harmless | OpenCode logger normally writes a file | Dependency/runtime `console.error` is observed and bypasses the logger | Correct comments in `worker.ts` and `win32.ts` to state the pipe precondition |
| Incident recovery scripts/database copy | Restored already damaged user data | Recovery does not prevent recurrence and is not a production path | Remain outside repository implementation; never call from production |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01, INV-01, INV-02 | Windows worker process creation before Bun startup | `daemon.ts`: one ProcessStartInfo pipe-backed path | New live `_spawn` + `FreeConsole` test expects `3/3`; original incident loop turns green |
| REQ-02 | No storage or public surface change | No DB/schema/migration/config/dependency files | Changed-file/diff inventory; package typecheck |
| REQ-03 | Owner-local implementation | Three production files, one test file, <400 lines | Diff line/file count and implementation audit |
| INV-03 | Existing wrapper/PID/lifecycle | `daemon.ts`: preserve protocol and adapter return shape | Existing hide, spaces, PID, launcher-exit tests |
| INV-04 | Concurrent worker stdout/stderr drains | `daemon.ts`: two CopyToAsync tasks; Null/forward destinations | Existing 1 MB output-before-marker test; planned print-logs stdout/stderr forwarding test |
| INV-05 | Existing `FreeConsole` after valid pipes | `worker.ts`/`win32.ts`: contract comments only | Existing real daemon HTTP/SSE/control test; new OS handle test |
| INV-06 | Non-Windows early return | No Unix code change | Existing non-Windows no-op and detached SIGINT tests |
| Full user stack identification | Consumer chain remains unchanged | No consumer change | Immutable source stack/quick-check forensic evidence; targeted Session regressions need not change |

No confirmed requirement is unmapped.

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| ProcessStartInfo with `UseShellExecute=false` and dual redirects | REQ-01, INV-01, INV-02 | Actual `Start-Process` worker reports invalid stdio after detach | Existing inherited console HANDLEs are precisely the violated invariant |
| Explicit `CreateNoWindow=false` on the single ProcessStartInfo path | INV-03, INV-05 | Current default and print-log workers both start console-attached; print-log intentionally skips `FreeConsole` | Redirected stdio must not silently remove the shared-console/Ctrl-C contract; existing wrapper `windowsHide=true` preserves invisibility |
| Concurrent CopyToAsync drains | INV-04 | Existing worker can write 1 MB before readiness; bounded pipes can block | `WaitForExit` alone deadlocks if either redirected pipe fills |
| Null vs forwarded destination | INV-04 | Existing default ignore and print-logs inherit options | Redirected pipes need one owner that preserves both existing destinations |
| Await drain completion after worker exit | INV-04 | Existing adapter waits for wrapper output EOF | Process exit does not itself prove all redirected tail bytes reached the wrapper destination |
| Native-boundary comment corrections | INV-01, INV-05 | Current comments incorrectly claim file logger makes invalid stdio harmless | Reachable AI SDK output disproves the assumption; future changes need the process-creation precondition |

No new module, API, setting, state, retry, guard, schema, migration, dependency,
or fallback is proposed.

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | modify | Replace the single Windows `Start-Process` worker block with ProcessStartInfo dual pipes, destination selection, concurrent drain, and exit/tail completion while preserving PID protocol | +25 to +40 / -4 to -8 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify comments only | Replace the stale “file logger makes invalid stdio harmless” assumption with the launcher-established pipe invariant; no executable behavior change | 4 to 8 comment lines |
| `packages/opencode/src/cli/cmd/tui/win32.ts` | modify comments only | State that `FreeConsole` invalidates console handles but preserves launcher-provided non-console pipes; no executable behavior change | 4 to 8 comment lines |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | Add live post-FreeConsole handle test and print-logs forwarding characterization; reuse `tmpdir`, `_spawn`, and real child processes | +65 to +100 |

Production files modified: 3 (limit 4). No files added/deleted by the
implementation, no storage file, and no generated artifact.

## 16. TDD Behavior Slices

Agreed public seam: existing test export `DaemonModule._spawn`, observed through
the real Windows PowerShell adapter and OS `GetFileType` values. This is the
same seam used by existing wrapper tests and does not add production test APIs.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | Windows worker launched by `_spawn` calls `FreeConsole`; marker must report `{ detached: 1, stdout: 3, stderr: 3 }` | Start-Process inherits console handles; actual current result is `0/0` | Replace worker creation with pre-start redirected stdout/stderr pipes and continuously drain both | Exact first divergence behind SQLite overwrite |
| 2 | Existing path-with-spaces worker writes 1 MB stdout before marker and still publishes readiness/PID | New redirection would deadlock if either pipe is not drained before WaitForExit | Start both CopyToAsync operations immediately after PID publication, before waiting | Default output backpressure and target quoting |
| 3 | Print-log launcher reports nonzero console attachment, `FILE_TYPE_PIPE=3` for both streams, captures distinct stdout/stderr markers, and exits with worker code | New implementation could remove the shared console, drain both streams to Null, or mix output into PID handshake | Keep `CreateNoWindow=false`; route each pipe to its corresponding wrapper stream when `OPENCODE_PRINT_LOGS=1` | Existing visible debug mode and intentional Ctrl-C propagation |
| 4 | Existing hidden-window, launcher-exit, real HTTP/SSE/control, stop/idle, and Unix SIGINT tests remain green | Process ownership or lifecycle drift would break them | No additional behavior; preserve current wrapper protocol | INV-03/05/06 |
| 5 | Original incident loop reports pipe handles `3/3` while the same 525-byte Provider buffer remains reproducible as ordinary output | Current loop fails on invalid handles | Rerun unchanged after green | Original production trigger can no longer reach a stale handle |

Test expectations are independent platform constants and visible child output,
not source text, private helper calls, or implementation call counts. The
incident artifact is used only by the original feedback loop, never by the
committed regression test.

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 110-135 | Count substantively added/modified production and test lines; exclude imports, formatting-only, generated, and pure moves |
| Required Chinese explanatory comments `C` | 17-21 | `ceil(E * 0.15)`; implementation must recompute actual values and meet the higher actual threshold |
| Planned qualifying Chinese comments | at least 22 | Distributed beside production transport decisions and behavioral test boundaries |

Qualifying nearby explanations will cover:

- Pipes must be bound at process creation before Bun snapshots Windows stdio;
  post-detach `SetStdHandle` is not equivalent.
- `CreateNoWindow=false` preserves the existing shared-console association;
  pipe redirection changes stream HANDLEs without changing Ctrl-C membership.
- PID publication remains the wrapper protocol boundary and must precede any
  forwarded worker stdout.
- Both redirected streams must begin draining before `WaitForExit` to prevent
  pipe-capacity deadlock.
- `Stream.Null` preserves default ignore semantics while keeping valid HANDLEs.
- Drain tasks are joined after exit to preserve tail output and wrapper lifetime.
- `FreeConsole` protects Ctrl-C delivery only; it must not own stdio repair.
- The live test uses `AllocConsole` solely to make the console-backed
  precondition deterministic, then observes OS file types after detach.
- Literal `FILE_TYPE_PIPE=3` is an independent Windows contract, while `0`
  proves invalid/unrecognized handles.
- The high-volume existing test protects output drain, not just path quoting.
- The print-logs test keeps worker stdout and stderr on distinct observable
  streams and excludes the PID handshake from its expected markers.
- Cleanup always terminates the real worker and wrapper so a failed assertion
  cannot leak a daemon into later tests.

Comments that merely restate assignments, branches, test names, or identifiers
will not count. The implementation audit must report actual `E`, `C`, excluded
lines, ratio, and representative comments.

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon keeps stdout and stderr as pipes after FreeConsole"` | `packages/opencode` | Red before implementation (`0/0`), green after (`3/3`) through real `_spawn` |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon preserves shared console and forwards pipes in print-log mode"` | `packages/opencode` | Preserves console attachment/Ctrl-C membership, visible per-stream routing, and exit |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon PowerShell wrapper hides its console window"` | `packages/opencode` | Hidden wrapper behavior preserved |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon wrapper preserves a worker target path containing spaces"` | `packages/opencode` | Quoting, PID identity, and 1 MB drain remain correct |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon remains healthy after its launcher exits"` | `packages/opencode` | Wrapper/worker ownership survives launcher exit |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon detaches from the shared console yet keeps serving HTTP, SSE and control port"` | `packages/opencode` | Real worker still detaches and serves all channels |
| `bun test test/cli/tui/daemon.test.ts` | `packages/opencode` | Full daemon lifecycle, stop, maintenance, wrapper, and Unix regressions |
| `bun test test/permission/reviewer-service.test.ts` | `packages/opencode` | Reachable Provider error/permission path semantics remain unchanged |
| `bun typecheck` | `packages/opencode` | Package TypeScript correctness |
| `bun run build` | `packages/opencode` | Bundled/compiled worker and embedded PowerShell source build successfully |
| Re-run section 8 inline incident feedback command | `packages/opencode` | Same 525-byte Provider output remains ordinary output, while handles change from `0/0` to `3/3`; command exits 0 |
| `git diff --check` and scoped `git diff --stat` / `git diff --numstat` | repository root | No whitespace errors; file/line budgets and unrelated-diff exclusion are auditable |

Tests must not run from repository root. No test may be skipped, timeout
weakened, or changed to accept invalid handles. If a full-file test exposes a
reachable resource leak in the modified wrapper, that failure is in scope; an
unrelated pre-existing failure must be evidenced and must not trigger an
unapproved production change.

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 implementation files | Canonical plan already exists before implementation |
| Files modified | 4 total; 3 production + 1 test | One owner, two contract-comment sites, one existing live test suite |
| Files deleted | 0 | No alternate implementation is introduced |
| Production lines | 35-55 changed | Embedded PowerShell worker transport plus accurate boundary comments |
| Test lines | 65-100 changed | One red OS-handle test plus one print-logs characterization |
| Total changed code lines | 100-155, hard cap <400 | Leaves margin without authorizing additional concepts |
| Generated lines | 0 | No SDK/schema generation |
| Schema/migration/config lines | 0 | Explicitly prohibited and unnecessary |

The budget cannot be used to omit a confirmed invariant. Any need for a fourth
production file or a materially different path requires an R2 revision and a
new full-scope plan audit; exceeding four production files or 400 lines is
forbidden by the user requirement.

## 20. Real Risks and Open Decisions

### Real risks

| Risk | Evidence | Planned control |
| --- | --- | --- |
| Redirected stdout or stderr fills and deadlocks worker exit | Existing worker test writes 1 MB before readiness | Start both CopyToAsync drains before WaitForExit; retain high-volume test |
| Worker output races PID handshake | Wrapper stdout is both PID protocol and optional forwarded worker output | Publish and flush PID before starting forwarding; test real worker PID/markers |
| Print-log output is silently discarded or merged | Existing default/print-logs destinations differ | Explicit per-stream destination and child-launcher capture test |
| Fast worker exit drops tail bytes or wrapper exit code | Redirected stream tasks may complete after process exit | Wait for worker exit, await both drains, propagate the saved worker exit code |
| ProcessStartInfo changes hidden, shared-console, or launcher-independent behavior | Replaces Start-Process behavior | Explicit `CreateNoWindow=false`; print-log console characterization; existing hide/launcher/HTTP/SSE/control tests |
| Test failure leaks worker/wrapper processes | Live OS tests create real children | `try/finally`, worker-first `proc.kill()`, await `proc.exited`, tmpdir disposal |

### Open Decisions Requiring the User

None. The user has already selected root-cause repair, prohibited downstream
error handling/schema migration as the solution, bounded the diff, and selected
`verified-implementation`.

### Rejected Speculation

- Bun issue #36572 and other query-cache/close leaks are real runtime issues but
  do not produce the observed foreign page bytes; upgrading Bun is not this
  repair.
- SQLite WAL-reset corruption requires a different concurrency path and cannot
  explain ANSI `console.error` bytes; no WAL behavior change is planned.
- `mmap_size=0` in the incident excludes mapped-file writes from the supported
  root path; no mmap guard is added.
- Hardware/media failure cannot repeat an exact Provider object serialization
  at three page starts; no disk-health feature is added.
- A second daemon/TUI writer is not required and is contradicted by the
  single-owner topology; election is unchanged.
- Adding reviewer `onError` may improve logging ownership separately, but as a
  repair here it only removes one trigger while retaining invalid handles; it is
  rejected as a workaround.
- `SetStdHandle` after `FreeConsole` is insufficient because Bun/CRT use startup
  stdio identity; process-creation redirection is the owner-correct boundary.
- `PRAGMA synchronous=FULL`, `quick_check`, `cell_size_check`, backups, and
  recovery scripts cannot prevent an unrelated `WriteFile` through an aliased
  HANDLE; they are not added.

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the complete original requirement.
- Reconstruct behavior from repository evidence and the immutable incident
  artifacts; treat builder summaries and transcripts as untrusted.
- Audit the complete original scope on every round, including producer,
  transport owner, storage consumer, tests, file/line caps, and non-goals.
- Require observed, contracted, or reachable evidence for every blocker.
- Check that the plan repairs `spawnDaemon`'s first divergence and does not
  substitute reviewer suppression, database detection, tolerant reads, schema,
  migration, or a fallback launcher.
- Check forward and reverse traceability, public behavioral seams, existing
  print-logs/default/Unix contracts, and the 15% Chinese comment plan.
- Return finding IDs, exact classification, full-scope status, and release
  verdict without relying on builder self-assessment.

Primary-agent blocker handling is constrained by the user requirement:

1. Before changing this plan for a blocking finding, classify whether the
   finding is an original-scope bug or a defect introduced by the planned/current
   diff, using repository evidence.
2. A clearly unrelated concern is not implemented. If classification or
   reachability is uncertain, the primary agent must reuse the same auditor
   `task_id` and provide only factual plan/repository references for
   reconsideration; it must not ask for a preferred verdict or narrower audit.
3. A blocker retained after fact-only reconsideration requires a substantive
   revision, incremented revision number, cleared approval, and another complete
   full-scope audit. A non-blocking record correction does not clear approval.
4. At most six plan-audit rounds and three consecutive invocation retries are
   allowed. The primary agent may not self-audit when independence is
   unavailable.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01 CreateNoWindow=true 改变 --print-logs 的既有控制台与 Ctrl-C 语义` | 无 | `BLOCK — canonical plan revision R1。` | `ses_0186edf7effeYukhGJet2pVFfn` |
| 2 | R2 | yes | `No blocking findings.` | `无。` | `APPROVE — 仅适用于 canonical plan revision R2。` | `ses_0186edf7effeYukhGJet2pVFfn` |

### Round 2 Verbatim Verdict

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- WAL reset、mmap、磁盘介质故障和第二 daemon 均无法解释重复出现的 525-byte Provider ANSI 输出。
- `quick_check`、恢复逻辑、容错读取、schema 变更和 reviewer-only `onError` 都不属于生产侧根因修复。
- 无证据支持升级 Bun、SQLite 或 AI SDK。

## Requirement and traceability coverage

- R2 完整覆盖原始需求、消费栈、生产路径、文件数与 400 行硬上限。
- first divergence 位于 Windows worker 创建时继承 console stdio，owner 正确归属 `daemon.ts` 的 Windows process/stdio adapter。
- `MessageV2.page`、`Session.messages`、`SessionRevert` 和 `SessionPrompt.prompt` 保持不变。
- 默认模式、`--print-logs`、PID 握手、输出背压、tail bytes、launcher independence、Ctrl-C、Unix 路径均有对应实现位置和行为验证。
- 每个新增生产概念均具备反向证据与现有逻辑不足说明。
- R1 的 B-01 已闭合：`CreateNoWindow=false` 保留共享 console，print-log 测试同时覆盖 console attachment 和双流转发。

## Primary-path and fallback verdict

单一 Windows ProcessStartInfo 路径在 Bun 启动前绑定 stdout/stderr pipes；默认模式随后执行 `FreeConsole`，print-log 模式保持 console attachment。旧 `Start-Process` 路径被替换且不作为 fallback 保留。

新增 alternate success path 为 0，diagnostic decision surface 为 0%。未引入恢复路径、兼容层、重试或下游错误消费修改。

## Code quality and Chinese-comment verdict

计划限定为 3 个生产文件和 1 个测试文件，生产改动集中于唯一 transport owner；另外两个生产文件仅修正 native-boundary 注释。

计划承诺按实际 diff 重算 `E/C`，并满足 `C >= ceil(E × 15%)`。预计 `E=110–135`、`C≥22`，覆盖位置和注释语义可行。

## Release verdict

**APPROVE — 仅适用于 canonical plan revision R2。**
```

Any substantive revision invalidates earlier approval. The orchestrating
primary agent must copy the independent verdict without paraphrasing. A clean
verdict may update only the administrative approval fields for the exact
audited revision; it must not be combined with a design change.

## 23. Implementation Evidence

Complete only after exact-revision approval and implementation.

### Actual Files and Diff

- `packages/opencode/src/cli/cmd/tui/daemon.ts`: replaces the Windows worker's
  `Start-Process` branch with one `ProcessStartInfo` path that pre-binds both
  standard streams to pipes, preserves the shared console, drains both streams
  concurrently, and propagates the worker exit code. No fallback path remains.
- `packages/opencode/src/cli/cmd/tui/win32.ts`: updates the native-boundary
  contract comment; execution is unchanged.
- `packages/opencode/src/cli/cmd/tui/worker.ts`: updates the launcher/worker
  contract comment; execution is unchanged.
- `packages/opencode/test/cli/tui/daemon.test.ts`: adds two live Windows adapter
  behavior tests for post-`FreeConsole` handles and print-log compatibility.

Frozen implementation diff: 4 files, 177 insertions, 16 deletions. Production
scope is 3 files and 49 changed lines (`33` additions, `16` deletions); only
`daemon.ts` changes production execution. This stays below the user limits of 4
production files and 400 lines. No schema, migration, persisted format,
database setting, public API, provider retry, or consumer-path change exists.

### Red-Green Test Evidence

- Red: the new real `_spawn` + `FreeConsole` test observed
  `{ detached: 1, stdout: 0, stderr: 0 }` and failed against the required
  `{ detached: 1, stdout: 3, stderr: 3 }` contract.
- Green: after the approved `ProcessStartInfo` change, the same test reports
  both standard handles as Win32 `FILE_TYPE_PIPE=3`.
- Compatibility green: the new print-log test observes nonzero console code
  page and console membership, two pipe-backed streams, distinct stdout/stderr
  markers, and exact propagation of worker exit code `23`.
- Regression green: hidden-wrapper behavior, a worker target path containing
  spaces with 1 MB output, launcher-exit survival, and detached HTTP/SSE/control
  service all pass through the same real adapter.

### Verification Commands and Results

All commands ran from `packages/opencode` unless stated otherwise.

| Command | Result |
| --- | --- |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon keeps stdout and stderr as pipes after FreeConsole"` | Red before implementation (`0/0`), green after implementation (`3/3`) |
| `bun test test/cli/tui/daemon.test.ts --test-name-pattern "Windows daemon preserves shared console and forwards pipes in print-log mode"` | Pass; console retained, streams separated, exit `23` propagated |
| The four section 15 targeted wrapper/service regression commands | Pass |
| `bun test test/cli/tui/daemon.test.ts` | Initial package-default 5-second run timed out in 4 pre-existing CLI startup cases; no assertion was weakened |
| `bun test --timeout 30000 test/cli/tui/daemon.test.ts` | `45 pass`, `0 fail`, `174 expect()` |
| `bun test --timeout 30000 test/permission/reviewer-service.test.ts` | `18 pass`, `0 fail`, `102 expect()` |
| `bun typecheck` | Pass (`tsgo --noEmit`) |
| `bun run build` | First attempt stopped before compilation because `https://models.dev/api.json` was unreachable |
| `MODELS_DEV_API_JSON=<authorized byte-identical temporary input> bun run build --single --skip-embed-web-ui --skip-install` | Pass; version smoke and compiled voice-worker smoke pass; `opencode-windows-x64/bin/opencode.exe` is 152296448 bytes, SHA-256 `3f0477ab1253f25aed2103f97e35815909447e51c11a644b0be90c4a46624165` |
| `git diff --check -- <goal files>` from repository root | Pass |

The authorized temporary model input was deleted. The user's pre-existing
`packages/core/src/models-snapshot.js` remains byte-identical with SHA-256
`3e91379def6382f8389552e9f651a99aa903d258b7f4a1ef412510ebd278ee45`.

### Original Feedback-Loop Result

The unchanged section 8 incident command exits `0` after the repair:

```json
{"handles":{"detached":1,"stdout":3,"stderr":3},"providerBytes":525,"byteEqual":true,"sha256":"673f54d8381df44762653631d3d24570a15a0583bd0bfd0fe8815afb9d115be8"}
```

The actual AI SDK Provider error buffer remains exactly reproducible and
byte-equal to the immutable damaged page prefix, but the worker now exposes
only valid pipe handles after detach. This closes the observed first-divergence
route rather than suppressing the producer or tolerating malformed SQLite.

### Actual Secondary and Replacement Path Inventory

- Windows default and `--print-logs` modes both use the same
  `ProcessStartInfo` path. There is no retained `Start-Process` fallback or
  parallel success path.
- Default mode drains both pipe streams concurrently to
  `[System.IO.Stream]::Null`; print-log mode forwards each pipe to its matching
  wrapper stream. Both await pipe EOF and preserve the worker exit code.
- The Unix detached `Bun.spawn` path is unchanged.
- `permission/reviewer/service.ts`, AI SDK Provider behavior, Session/Message/
  Revert consumers, SQLite setup, schema, migrations, and recovery tooling are
  unchanged. No downstream workaround was added.
- The only removed workaround is the old split Windows launch behavior
  (`Start-Process -WindowStyle Hidden` versus `-NoNewWindow`), whose default
  branch inherited console handles that became invalid after `FreeConsole`.
- Alternate success paths added: `0`. Diagnostic decision surface added: `0%`.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | `170` | 177 added lines minus 7 blank lines; no import-only, formatter-only, generated, or pure-move lines counted |
| Qualifying Chinese comment lines `C` | `27` | Each is adjacent to its modified boundary/test and explains an invariant, compatibility requirement, failure oracle, or cleanup safety condition |
| Ratio `C / E` | `15.88%` | `27 / 170` |
| Required minimum `C` | `26` | `ceil(170 * 0.15)`; gate passes |

Representative qualifying comments explain why pipes must exist before Bun
starts, why both streams must drain concurrently, why `CreateNoWindow=false`
preserves the print-log Ctrl-C contract, why the PID line must precede worker
output, and why `FILE_TYPE_PIPE=3` is the behavioral oracle rather than merely
checking that no exception was thrown.

### Remaining Unverified Items

No required implementation check remains before independent audit. The built
artifact exists under `packages/opencode/dist/opencode-windows-x64/bin`, but
this task did not replace the separately installed/running
`F:/include/CLI/opencode.exe`; deployment was not requested and existing daemon
processes must be restarted with a deployed repaired binary before receiving
the runtime protection.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | None | None | `No blocking findings`; `APPROVE` | `ses_0181cd672ffe1H0PW5GGzeUyk7` |

### Round 1 Independent Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- WAL reset、mmap、介质故障及第二 daemon 无法解释重复的 525-byte Provider ANSI buffer。
- `quick_check`、恢复逻辑、容错读取、schema 变更及 reviewer-only `onError` 均属于下游处理或局部规避。
- 无证据支持升级 Bun、SQLite 或 AI SDK。

## Requirement and traceability coverage

- 实际 diff 与 approved revision R2 一致：3 个生产文件、1 个测试文件，未涉及 schema、migration、数据库设置、依赖或消费路径。
- first divergence 位于 `daemon.ts:85-110`：Windows worker 创建阶段现已通过唯一 `ProcessStartInfo` 路径预绑定 stdout/stderr pipes。
- 默认 worker 在 `worker.ts:47` 继续执行 `FreeConsole`；`win32.ts:84-92` 的 native-boundary contract 与该前置条件一致。
- Provider producer 路径可达：`permission/reviewer/service.ts:609-648` 未提供 `onError`，AI SDK 默认路径在 `node_modules/ai/src/generate-text/stream-text.ts:317-319,879-881` 调用 `console.error`。
- 消费栈经独立读取确认：`MessageV2.page` → `Session.messages` → `SessionRevert.cleanupCurrent` → `SessionRevert.cleanup` → `SessionPrompt.prompt`，对应 `message-v2.ts:1401-1493`、`session.ts:878-901`、`revert.ts:171-253`、`prompt.ts:2429-2434`。
- Windows daemon suite：`45 pass, 0 fail`。
- permission reviewer suite：`18 pass, 0 fail`。
- `bun typecheck`：通过。
- 原始反馈循环：`stdout=3`、`stderr=3`、Provider buffer 仍为 525 bytes，且与损坏页前缀 byte-equal，SHA-256 为 `673f54d...15be8`。
- 已有 Windows build artifact 独立确认存在，SHA-256 为 `3F0477AB...24165`，执行 smoke 退出码为 `0`。
- 实际变更为 3 个生产文件、49 行生产 diff，总 diff 193 行，满足最多 4 个生产文件和少于 400 行的限制。

## Primary-path and fallback verdict

Windows 仅保留一个 authoritative `ProcessStartInfo` worker 创建路径。默认模式与 print-log 模式共享 pipe-backed stdio，仅输出目的地不同；旧 `Start-Process` 路径未保留。

新增 alternate success path：`0`。新增 diagnostic decision surface：`0%`。未引入重试、恢复 fallback、兼容层或下游错误消费修改。

## Code quality and Chinese-comment verdict

- 实现集中于 transport owner；`worker.ts` 和 `win32.ts` 仅修正边界注释。
- 未增加生产 API、配置、依赖、schema、migration、dead helper 或 test-only production path。
- `git diff --check`、测试及 typecheck 均通过。
- 实际 `E = 170`：177 个 added lines，排除 7 个空行；无 import-only、formatter-only、generated 或 pure-move 行。
- 实际 qualifying `C = 27`，分布于 pipe 建立、双流 drain、PID protocol、`CreateNoWindow=false`、行为 oracle 和进程清理边界附近。
- `C / E = 27 / 170 = 15.88%`，满足 policy 的 `ceil(170 × 15%) = 26` 硬门槛。

## Release verdict

**APPROVE — 仅适用于 canonical plan revision R2 与本次审计的实际 implementation diff。**
```

The task may be marked `verified` only after an independent full-scope result
of `No blocking findings` for the actual implementation of the exact approved
revision, all required tests and original feedback loop pass, the Chinese
comment gate passes, and no required work remains.
