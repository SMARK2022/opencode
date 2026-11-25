# Canonical Implementation Plan: DB VACUUM Space and Maintenance Task Guidance

> Status: verified
>
> Revision: R20
>
> Approved revision: R20
>
> Audit mode: full-scope
>
> Requirement source: the user requests quoted in §1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-25
>
> Target end state: verified-implementation-and-commit

Fixed pre-R1 HEAD: `f37e94dd26d3e179add3b4adadc5cb4d0d70f4ea` (session-start HEAD and Git reflog). At implementation intake `7190d264a7`, `git diff f37e94dd26 --` for the three §15 source/test files was empty. All product changes are specified below from that fixed baseline. The canonical R17 document was recovered from Git blob `d3004c0685`; previous rounds were plan-only.

## 1. Verbatim Requirement

Original request:

> OK，那当前其实问题也很明显，一个两个，一个是你这个空间的检验，就是在vacuum的时候，应该去检查一下这个盘的一个所在空间。如果这个所在空间空间就是不是特别足的话，那应该去，就比如说小，就是就是反正你看一下这个应该去怎么怎么搞。按照我的理解，就是我们当前这个数据库的大小是有的，然后又有这个能缩减的比例，就是缩减的一个量是有的。然后如果它已经小于这么一一，就是可用空间的量小于这么一个已经收缩的一个量的话，那这个在那个显示Yes or No的时候，或者说什么时的时候应该去，就是在提示vacuum之前应该去就是或者说显示显示选择这个Yes or No的时候应该去弹一个说当前这个什么什么不足，建议什么什么怎么怎么之后，然后如果要继续怎么怎么样选Yes，巴拉巴拉，是这种感觉。然后旧任务缺少上下文这一块的话，你可以看一下。这个任务是interrupt还是running，然后同时呃同时给一句这个建议，就比如说什么如果怎么怎么样，或者说就是让用户自己去把这个task去关掉，还是说或者说让用户去选择是否Yes，巴拉巴拉，也也是可以的。你可以按照那个我们的Document里面有Guide，还有这Guide里面有一个Workflow，按照Workflow的内容去构建一个这个Verified Plan Only。

Scope correction:

> 你都在干什么呀？至于这么高的复杂度吗？用户需求是什么？你再分析一下用户的需求。你分析一下用户的需求到底要什么？然后再结合你所有的这些修改，你到底看一看是否用户要求？用户没有要求的事你不要动，一点都不要改。

Latest implementation-direction correction:

> 放行进入代码实现前，建议直接让对方把这四点收紧：重新对齐空间不足的计算公式（把 freelistPages 纳入有效工作空间估算，别无脑按膨胀体积乘 2）、明确 --yes 是否应当跳过二次弹窗、把 Available on <volume> 简化为 Available space 避免写挂载点解析代码，同时砍掉新建的 db-vacuum-space-worker.ts 和冗余边缘测试，取消硬凑 35–54 行注释的机械指标，只保留关键边界说明即可。

The same review explicitly preserves the two-file boundary:

> 生产代码未再越界（无恶意扩权）：方案在 §2 明确锁死了边界，完全不碰 server-lock.ts、worker.ts、daemon.ts、任务生命周期状态机以及底层 SQLite 执行逻辑，仅修改 packages/opencode/src/cli/cmd/db.ts（+55 至 +85 行）和 packages/opencode/src/cli/maintenance.ts（+12 至 +20 行）。对于这两个需求来说，70–100 行的生产代码体量是合理的。

Session GOAL updates the deliverable: **目标终态**：<verified-implementation-and-commit>. Implement the approved revision, independently audit the actual diff and commit only verified paths.

> 注意保持准确高效，用户没有要求的额外行为都不要做，用户要求的很简单，就两三个小功能，按理来说几十行就能解决的事情，不要搞复杂，譬如什么测错磁盘，按理来讲不应该，直接按照默认路径和对应磁盘来，不要搞其他的分支和判断逻辑，我说的很清楚了，获取路径+对应磁盘空间，然后判定，不要加上其他任何逻辑

The result has two behaviors:

> OK那你的上限就是修改2个测试三个生产文件，生产修改行数上线为160行，测试则是修改上限160行；不要新增任何额外的逻辑接线，同时保持代码简洁而不是以压缩代码来实现，避免防御性逻辑，要通过gate且不应该引入新的防御性逻辑。同时注意注释避免新增注释

1. Interactive VACUUM reports a space estimate based on effective data, with
   `--yes` retaining direct execution after any warning.
2. Existing old-task conflicts show durable status and a useful next action.

## 2. Explicit Non-Goals

- No changes to `server-lock.ts`, `worker.ts`, `daemon.ts`, `daemon.test.ts`,
  task lifecycle, leases, resume, pending state, or control endpoints. The
  separate daemon `Maintenance task already active` admission message is outside
  the reproduced `Maintenance task already exists` repair and the two-file limit.
- No changes to SQLite, cold compression, freelist thresholds, task schema,
  machine JSON, or global error classification.
- No automatic task action, owner lookup, mount-point discovery, new command,
  configuration, or cross-process behavior.
- No new test file and no dedicated symlink, `:memory:`, equality, statfs-error,
  or low-space machine test matrix. Existing suite regressions remain in force.

Production changes are limited to `db.ts` and `maintenance.ts`; tests stay in the
existing `db-maintenance.test.ts`.

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| Root/package/test `AGENTS.md` | Minimal changes and real package-local CLI tests |
| `docs/guides/workflow.md` | Approved plan before implementation |
| `.opencode/policy/first-principles-engineering.md` | Evidence, traceability and Comment Rule (no quota) |
| `docs/plans/db-maintenance-cli-ux.md` | Existing human/machine output contract |

No ADR, protocol, SDK, migration, or generated-code change is needed.

## 4. Files and Evidence Read

| Evidence | Relevance | Class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts` | Combined reclaim, standalone VACUUM, `confirm`, live-daemon precheck | observed |
| `packages/opencode/src/cli/maintenance.ts` | Two offline nonterminal-task conflict throws | observed |
| `packages/core/src/storage/cold-store.ts` | `StatusReport` supplies page metrics and `activeBytes` | observed |
| `packages/core/src/database/database.ts` | `Database.path()` supports file paths and `:memory:` | observed |
| `packages/opencode/test/cli/db-maintenance.test.ts` | Existing CLI/PTY/pipe and live-lock fixtures | observed |
| Real incident and read-only diagnosis | 8.84 GB database, about 3.3 GB free, completed compression, failed VACUUM | observed |
| SQLite VACUUM documentation | VACUUM builds a temporary copy; free-space measurement is advisory | contracted |
| Bun `statfs` probe | Numeric `bavail` and `bsize` are available | observed |
| R14 user review | Defines effective-data estimate and direct `--yes` behavior | contracted |

## 5. Current Behavior

```text
combined: compression -> reclaim prompt -> runVacuum
standalone: db vacuum --yes -> reusable-page gate -> runVacuum
```

Interactive paths provide no free-space context. `db vacuum --yes` already
requests direct execution.

The reproduced `Maintenance task already exists` family has three producers
that already hold the durable task: two in `maintenance.ts` and the interactive
live-daemon precheck at `db.ts:526`. Other daemon admission messages retain their
current behavior.

## 6. Supported Input Domain and Reachability

| Input | Path | Classification |
| --- | --- | --- |
| Interactive standalone `--yes` with low space | Warn, then execute existing VACUUM | observed |
| Combined interactive without `--yes`, low space | Warn, then default-no confirmation | observed |
| Combined interactive with `--yes`, low space | Warn, then execute existing VACUUM | contracted by latest correction |
| Available space equal to or above estimate | No insufficiency warning; existing prompt behavior | contracted |
| Machine VACUUM | Existing direct behavior; helper is not called | contracted |
| `:memory:` | Skip filesystem probe and retain existing VACUUM | contracted |
| Durable interrupted/queued/running task | Existing three conflict producers | observed |
| Terminal task | Existing nonterminal filter excludes it | observed |

## 7. Required Invariants

| ID | Behavioral invariant |
| --- | --- |
| INV-01 | `activeBytes = allocatedBytes - potentialReclaimBytes`; `estimatedWorkingBytes = 2 * activeBytes`. |
| INV-02 | Interactive file-backed VACUUM uses `statfs(Database.path())` directly and compares `bavail * bsize` with that estimate before SQL. |
| INV-03 | Below the estimate, print allocation, potential reclaim, estimate, and `Available space`; never print a volume/mount name. |
| INV-04 | Explicit interactive `--yes` prints the warning and proceeds without another prompt. Without `--yes`, combined compression asks default-no before VACUUM. |
| INV-05 | Declining preserves completed compression and skips only VACUUM; accepting calls unchanged `runVacuum`. Equality is sufficient. |
| INV-06 | Machine behavior, `:memory:`, JSON, and native measurement-error propagation retain existing contracts. |
| INV-07 | Three existing ID-only producers include task ID, durable status, Inspect, and resume-for-interrupted/wait-for-queued-or-running advice. |
| INV-08 | Only two production files and the existing CLI test file change. Comments explain non-obvious reasons under the current Comment Rule. |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owner | Proof |
| --- | --- | --- | --- |
| INV-01–05 | Interactive authorization calls `runVacuum` without effective-data space context | `db.ts` | Incident and red probe |
| INV-07 | Three throws discard task status/action while holding the task | `db.ts`, `maintenance.ts` | Source and red probe |

The repair adds information at those existing presentation seams. Execution,
lease, task, and daemon logic remain unchanged.

### 8.1 Red-capable standalone space probe

Run from `packages/opencode`. The real standalone `--yes` command currently
reclaims pages without a warning, so `green:false` and harness exit 1. Post-fix,
the same command must warn and complete VACUUM without a continuation prompt.

```powershell
bun -e '
import { mkdtemp, mkdir, rm } from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import { pathToFileURL } from "url"
import { Database as SQLite } from "bun:sqlite"
import { spawn } from "@opencode-ai/core/pty/pty.bun"
const root = await mkdtemp(path.join(tmpdir(), "db-space-r15-"))
try {
  const dbPath = path.join(root, "opencode.db")
  await mkdir(path.join(root, "share", "opencode"), { recursive: true })
  await Bun.write(path.join(root, "share", "opencode", "opencode.db"), "")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Effect } = await import("effect")
  await Effect.runPromise(Effect.asVoid(Database.Service).pipe(Effect.provide(Database.layerFromPath(dbPath))))
  const db = new SQLite(dbPath)
  db.exec("CREATE TABLE pad (id INTEGER PRIMARY KEY, blob BLOB)")
  const insert = db.query("INSERT INTO pad (blob) VALUES (?)")
  const payload = Buffer.alloc(256_000, 97)
  db.transaction(() => { for (let i = 0; i < 80; i++) insert.run(payload) })()
  db.exec("DELETE FROM pad; DROP TABLE pad")
  const pageSize = db.query("PRAGMA page_size").values()[0][0]
  const pageCount = db.query("PRAGMA page_count").values()[0][0]
  const freelistCount = db.query("PRAGMA freelist_count").values()[0][0]
  db.close()
  const allocated = pageCount * pageSize, reclaim = freelistCount * pageSize
  const estimate = 2 * (allocated - reclaim)
  const size = (value) => {
    if (value === 0) return "0 B"
    const units = ["B", "KB", "MB", "GB", "TB"]
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1)
    return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
  }
  const entry = pathToFileURL(path.join(process.cwd(), "src", "index.ts")).href
  const source = `import { spyOn } from "bun:test"; import fs from "fs/promises";
    spyOn(fs, "statfs").mockImplementation(async p => ({ bsize: 4096, bavail: p === process.env.OPENCODE_DB ? 2 : 1e9 }));
    process.argv = [process.execPath, "opencode", "db", "vacuum", "--yes"]; await import(${JSON.stringify(entry)})`
  const proc = spawn(process.execPath, ["-e", source], {
    name: "xterm-256color", cols: 120, cwd: process.cwd(),
    env: { ...process.env, OPENCODE_PROCESS_ROLE: "main", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_LOCK_PATH: path.join(root, "lock.json"), OPENCODE_DB: dbPath,
      OPENCODE_TEST_HOME: path.join(root, "home"), XDG_DATA_HOME: path.join(root, "share"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state") },
  })
  let output = ""
  proc.onData((data) => { output += data })
  const exited = new Promise((resolve) => proc.onExit((event) => resolve(event.exitCode)))
  const code = await Promise.race([exited, Bun.sleep(30_000).then(() => "timeout")])
  if (code === "timeout") { proc.kill(); throw new Error("VACUUM probe timed out") }
  const text = Bun.stripANSI(output).replace(/[^\S\r\n]+/g, " ")
  const green = code === 0 && text.includes(`Database allocation ${size(allocated)}`) &&
    text.includes(`Potential reclaim ${size(reclaim)}`) &&
    text.includes(`Estimated VACUUM working space ${size(estimate)}`) &&
    text.includes("Available space 8.2 KB") &&
    output.includes("Physical reclaim completed") && !output.includes("Continue VACUUM anyway")
  console.log(JSON.stringify({ code, green }))
  if (!green) process.exitCode = 1
} finally { await rm(root, { recursive: true, force: true }) }
'
```

### 8.2 Red-capable interrupted-task probe

Run from `packages/opencode`. Current output lacks status and resume guidance;
post-fix requires `green:true` while retaining a nonzero CLI exit.

```powershell
bun -e '
import { mkdtemp, mkdir, rm } from "fs/promises"
import path from "path"
import { tmpdir } from "os"
const root = await mkdtemp(path.join(tmpdir(), "db-task-r15-"))
try {
  const dbPath = path.join(root, "opencode.db"), taskID = "dbm_interrupted_context_probe"
  await mkdir(path.join(root, "share", "opencode"), { recursive: true })
  await Bun.write(path.join(root, "share", "opencode", "opencode.db"), "")
  await mkdir(`${dbPath}.maintenance/tasks`, { recursive: true })
  const now = Date.now()
  await Bun.write(`${dbPath}.maintenance/tasks/${taskID}.json`, JSON.stringify({
    version: 1, taskID, dbPath, operation: "compress", args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
    status: "interrupted", cursor: { owner: "message", lastID: "" }, processed: 0, skipped: 0, failed: 0,
    rawBytes: 0, compressedBytes: 0, createdAt: now, updatedAt: now,
  }))
  const proc = Bun.spawn([process.execPath, "src/index.ts", "db", "compress", "--older-than", "0ms", "--json"], {
    cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OPENCODE_PROCESS_ROLE: "main", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_LOCK_PATH: path.join(root, "lock.json"), OPENCODE_DB: dbPath,
      OPENCODE_TEST_HOME: path.join(root, "home"), XDG_DATA_HOME: path.join(root, "share"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state") },
  })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const green = code !== 0 && stderr.includes("Status: interrupted") && stderr.includes(`opencode db resume ${taskID}`)
  console.log(JSON.stringify({ code, stdout, green }))
  if (!green) process.exitCode = 1
} finally { await rm(root, { recursive: true, force: true }) }
'
```

## 9. Responsibility and Seam

Fresh Windows/Bun 1.4.4 probe results: §8.1 reached real SQL and reported physical reclaim, CLI exit 0, `green:false` (allocation 20,996,096 B, reclaim 20,647,936 B, estimate 696,320 B, simulated available 0 B). §8.2 returned CLI exit 1 with only `Maintenance task already exists: dbm_interrupted_context_probe`, `green:false`. Baseline failure is missing information at authorization/admission; archived SQL error is generic, its native SQLite cause was not captured.

| Concern | Owner | Promise |
| --- | --- | --- |
| Effective-data space warning | Private helper in `db.ts` | Measure and print only; return whether space is insufficient |
| Combined confirmation | Existing `confirm` | Existing callers retain default-yes; low-space/no-`--yes` uses default-no |
| Task conflict text | `MaintenanceExecutor.busyError(task)` | One formatter for the three existing producers |
| Verification | Existing `db-maintenance.test.ts` | Real CLI behavior; only the subprocess filesystem method `fs.statfs` is stubbed |

## 10. Single Approved Primary-Path Design

### 10.1 Space warning and `--yes`

Use the existing report fields:

```text
allocatedBytes = pageCount * pageSize
potentialReclaimBytes = freelistPages * pageSize
activeBytes = allocatedBytes - potentialReclaimBytes  // report.activeBytes
estimatedWorkingBytes = 2 * activeBytes
fs = statfs(Database.path())
availableBytes = fs.bavail * fs.bsize
insufficient = availableBytes < estimatedWorkingBytes
```

`:memory:` skips the filesystem probe. Native measurement errors propagate.
The estimate is advisory and deliberately uses effective data rather than the
inflated allocation.

When insufficient, print:

```text
! Estimated VACUUM working space exceeds available space.
  Database allocation           <allocated>
  Potential reclaim             <reusable>
  Estimated VACUUM working space <estimate>
  Available space               <available>
  Free up disk space before reclaiming SQLite pages.
```

Call the measurement helper only from the two interactive paths:

1. **Standalone `db vacuum --yes`**: after the reusable-page gate, print the
   warning when insufficient and then call unchanged `runVacuum`. There is no
   second prompt because `--yes` is required by this command.
2. **Combined interactive compression**: after `reclaimPrompt(report)`, measure
   and print any warning. With `--yes`, call unchanged `runVacuum` directly.
   Without `--yes`, ask `Continue VACUUM anyway? [y/N]` only when insufficient;
   sufficient space retains the existing ordinary reclaim question. Declining
   prints the skip hint and preserves completed compression.

Extend `confirm` with a default policy only for the combined insufficient-space
question. Existing callers retain their behavior. Machine paths do not call the
measurement helper.

### 10.2 Task conflict text

Use one small `MaintenanceExecutor.busyError(task)` at the two existing throws in
`runOffline` and the existing precheck at `db.ts:526`:

```text
Maintenance task already exists: <taskID>
Status: <queued|running|interrupted>
Inspect with: opencode db status --task <taskID>
```

Append `Resume with: opencode db resume <taskID>` for `interrupted`; append
`Wait for the existing task to finish before starting another maintenance task.`
for `queued`/`running`.

The formatter only reads the durable task already returned by the existing
lookup. All three commands retain their existing failure behavior.

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| Sufficient space | Existing primary path | preserve |
| Insufficient with `--yes` | User-directed warning + direct execution | add |
| Insufficient without `--yes` | User-directed confirmation branch | add |
| Machine and `:memory:` | Existing pass-through | preserve |
| Native measurement failure | Existing diagnostic propagation | preserve |
| Retry, alternate SQL, automatic task action | Forbidden fallback | reject |

New alternate success paths: 0.

## 12. Workaround Deletion and Replacement

| Current issue | Replacement |
| --- | --- |
| Space discovered after VACUUM starts | Effective-data estimate at existing authorization |
| Three ID-only task errors | One formatter at those same three producers |
| R14 worker fixture and edge-test matrix | Inline subprocess mock in the existing CLI test file |

## 13. Forward Traceability

| Requirement | Production path | Behavioral coverage |
| --- | --- | --- |
| INV-01–03 estimate/warning | Report active bytes -> statfs -> `Available space` warning | Standalone test asserts exact allocation/reclaim/estimate/available values from independent PRAGMAs |
| INV-04/05 `--yes`/decline | Combined branch -> direct run, default-no, or explicit-y continuation | Combined empty/no, explicit `y`, and flag `--yes`; standalone direct `--yes` |
| INV-06 compatibility | Machine/memory bypass and unchanged runVacuum | Existing machine/reclaim suite |
| INV-07 task guidance | Three producers -> shared formatter | Offline compress/VACUUM, live-lock precheck, queued/running |
| INV-08 restrained scope | Two production files + one existing test file | Diff and §18 checks |

## 14. Reverse Traceability

| Concept | Requirement | Why current logic is insufficient |
| --- | --- | --- |
| Effective-data space helper | INV-01–06 | Interactive callers lack space context; R14 overestimated from total allocation |
| Default policy on existing `confirm` | INV-04/05 | Current empty input means yes |
| `busyError(task)` for three existing throws | INV-07 | All three hold and discard status |
| Inline subprocess statfs mock | INV-01–05 | Deterministic low-space behavior without a new fixture file |

## 15. File-Level Change Plan

| File | Change | Expected delta |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/db.ts` | Effective-data warning, `--yes` behavior, combined default-no, shared precheck message | +35 to +55 / -4 to -8 |
| `packages/opencode/src/cli/maintenance.ts` | Shared status/action formatter at its two throws | +10 to +18 / -2 to -4 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | Focused public CLI behavior using existing helpers and inline mocks | +60 to +90 |
| New files | None | 0 |
| Daemon, Worker, ServerLock, Core, protocol, SDK | No change | 0 |

## 16. TDD Behavior Slices

Public seam: real `opencode db` CLI through existing PTY/pipe fixtures. The
space test reuses `prepareDatabase` for real migrations before `inflateFreelist`
and the independent PRAGMA baseline, matching the probe's migrated fixture.

| Order | Behavior | Current red reason |
| --- | --- | --- |
| 1 | Offline interrupted compress and VACUUM plus live-lock precheck show status/Inspect/resume | Three current messages contain only ID |
| 2 | Queued/running conflict shows wait | Current message omits status/action |
| 3 | Standalone low-space `--yes` shows migrated PRAGMA allocation, reclaim, `2 * activeBytes` and 8.2 KB available, then completes | Baseline omits warning; fixture gives the database path 2 available 4096-byte blocks |
| 4 | Low-space advice appears before `[y/N]`; empty Enter preserves compression, explicit `y` completes reclaim | Baseline only asks `[Y/n]` |
| 5 | Combined low-space with `--yes` warns and completes without another prompt | Current path lacks warning; R14 semantics are superseded |
| 6 | Existing sufficient-space, ordinary reclaim, and machine tests stay green | Compatibility regression gate |

No dedicated edge-test matrix or new worker file is planned.

## 17. Comments

Use descriptive names and CLI assertions; no new comments planned.

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode` | Focused new behavior plus existing CLI regressions |
| `bun test test/cli/tui/maintenance-worker.test.ts` | `packages/opencode` | Existing behavior after shared message formatting |
| `bun typecheck` | `packages/opencode` | Type safety |
| Exact §8.1 probe | `packages/opencode` | Standalone `--yes` warns and executes without a prompt |
| Exact §8.2 probe | `packages/opencode` | Interrupted conflict includes status and resume |

Do not run VACUUM against the user's real database.

## 19. Diff Budget

Hard limits: production ≤3 files and ≤160 added + removed lines; tests ≤2 files and ≤160 added + removed lines. The planned set remains two production files and one existing test file, without additional wiring.

| Metric | Estimate |
| --- | --- |
| Files added | 0 |
| Files modified | 3 |
| Files deleted | 0 |
| Production lines | 45–73 additions plus 6–12 deletions |
| Test lines | 60–90 additions |
| Generated lines | 0 |

## 20. Real Risks and Open Decisions

The estimate is advisory; free space can change before SQLite finishes. The
formula and `--yes` semantics are now explicitly selected by the user.

### Open Decisions Requiring the User

None.

### Rejected Speculation

Total-allocation `2x`, second prompts after `--yes`, mount-name parsing, a new
worker fixture, the removed edge-test matrix, and changes to the separate daemon
`already active` path are rejected by the latest requirements and two-file limit.

### Follow-up

| Concern | Evidence | Baseline behavior | Round |
| --- | --- | --- | --- |
| Machine daemon admission's separate `already active` error | Worker `activeMaintenance` conflict | ID-only HTTP 409; this task preserves admission and its message | R16/R17 |

## 21. Audit Contract

The independent auditor must read §1 and this exact file, verify the two requested
behaviors and four latest corrections, and check both under-design and over-design.
Lifecycle expansions are outside scope. The audit also checks execution paths,
tests, and the repository Comment Rule. The R15 findings are covered by exact
PRAGMA-derived numeric assertions and an affirmative combined-prompt test.

## 22. Plan Audit Record

Revision delta R17 → R18: §1/18/23/24 advance the target to verified implementation and commit. §8 uses Bun's supported PRAGMA query, isolated fixed statfs result and spacing-independent displayed values. §10 includes the requested free-space advice. §3/7/17 follow current Comment Rule. §20 records unchanged Worker admission as follow-up. Same two product behaviors, owners, states, file set and public CLI test seams.

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 (R15 cycle) | R15 | yes | B-01, B-02 | none | BLOCK | `ses_e21c65cabffeK3iPMOtV3WCxgK` |
| 2 (R15 cycle) | R16 | yes | B-01, B-02 | none | BLOCK | `ses_e21ba8ecfffeHZYjAD5cMkrNOw` |
| 3 (R15 cycle) | R17 | yes | none | two record corrections | APPROVE | `ses_e21afaeafffeCe2ktY6dbZRqLR` |

### R15 independent verdict (verbatim)

```text
## Blocking findings

### B-01 空间公式缺少能识别错误实现的数值断言

- Violated invariant: INV-01；最新要求指定的有效数据公式必须有行为敏感验证。
- Evidence class: contracted
- Producer and execution path: SQLite `page_size/page_count/freelist_count` → `StatusReport.activeBytes` → 计划中的空间估算与警告 → §8.1 standalone CLI probe。
- Source evidence: `packages/core/src/storage/cold-store.ts:2934-2938`、 `packages/core/src/storage/cold-store.ts:3003-3007`
- Canonical-plan evidence: §8.1 第 173–175 行只检查警告标签、完成文本和无二次提示；§13 第 315 行却声称该 probe 会根据独立 PRAGMA 检查数值；§16 slice 3。
- Responsibility owner: `packages/opencode/src/cli/cmd/db.ts` 与现有 `packages/opencode/test/cli/db-maintenance.test.ts`
- Concrete behavioral consequence: 当前 probe 使用 `bavail: 0`，因此正确的 `2 * (allocated - reclaim)` 和用户明确禁止的 `2 * allocated` 都会显示警告并通过；可用空间、分配量和回收量显示错误也同样无法被发现。核心公式 correction 没有有效回归保护。
- Minimal correction direction: 在现有 standalone probe/test 中预先读取三个 PRAGMA，并断言警告展示的 allocation、reclaim、available 及 `2 * (allocation - reclaim)` 数值，无需新增文件或边缘测试矩阵。

### B-02 低空间确认框的“回答 Yes 后继续”路径没有验证

- Violated invariant: INV-04/INV-05；原始需求明确要求用户选择 Yes 后仍能继续 VACUUM。
- Evidence class: contracted
- Producer and execution path: combined interactive compression → `reclaimPrompt(report)` → 低空间警告 → `Continue VACUUM anyway? [y/N]` → 用户输入 `y` → 既有 `runVacuum`。
- Source evidence: 现有普通确认及执行入口位于 `packages/opencode/src/cli/cmd/db.ts:649-660`，共用确认函数位于 `packages/opencode/src/cli/cmd/db.ts:375-380`。
- Canonical-plan evidence: §10.1 第 262–270 行新增低空间 default-no 分支；§16 slices 3–5 只覆盖 standalone `--yes`、低空间默认拒绝、combined `--yes`，没有覆盖低空间确认框中显式回答 `y`。
- Responsibility owner: combined confirmation 所属的 `db.ts` 及其现有 CLI 测试。
- Concrete behavioral consequence: 新分支即使错误地拒绝包括 `y` 在内的所有回答，计划的低空间拒绝测试、`--yes` 直执行测试和既有 sufficient-space Yes 测试仍可能全部通过，用户要求的继续操作无法得到验证。
- Minimal correction direction: 在同一个 combined low-space CLI slice 中增加一次显式 `y` 回答并断言 `Physical reclaim completed`，复用现有 fixture，不扩展测试矩阵。

## Non-blocking findings

无。

## Rejected speculation

- 不增加挂载点解析、卷名展示或 `Available on <volume>`；最新要求已明确排除。
- 不增加自动关闭、自动恢复任务或 lease/lifecycle 修改；现有持久状态配合 Inspect、resume/wait 建议已覆盖原始请求。
- 不要求新建 worker、`statfs` 错误、`:memory:`、相等边界或低空间 machine 测试矩阵；这些正是最新范围收紧所删除的内容。
- 不引入测量失败后跳过检查、低空间自动继续或替代 SQL 等 fallback。

## Requirement and traceability coverage

- 生产设计已采用 `activeBytes = allocatedBytes - potentialReclaimBytes` 和 `estimatedWorkingBytes = 2 * activeBytes`，方向符合最新公式要求，但验证存在 B-01。
- standalone 与 combined 的 `--yes` 均定义为警告后直接执行；非 `--yes` 的低空间 combined 路径使用 default-no。拒绝仅跳过 VACUUM并保留已完成的 compression。
- 警告使用 `Available space`，没有卷名或挂载点解析。
- 三个既有的 `Maintenance task already exists` producer 已定位：`maintenance.ts:42`、`maintenance.ts:54`、`db.ts:526`。共享 `busyError(task)` 能覆盖 interrupted 的 Inspect/resume 建议及 queued/running 的 Inspect/wait 建议，无需改变任务状态机。
- 文件范围限制为 `db.ts`、`maintenance.ts` 和现有 `db-maintenance.test.ts`，没有新增生产文件或依赖。
- §17 已撤销固定 35–54 行注释指标，改为实际 `E` 的 15% 目标；估算 `E=95–145`、`C=15–22` 算术可行。计划阶段没有实际 diff，不能计算实际 E/C；实现审计仍须独立重算，并执行不得低于 10% 的审计底线。

## Primary-path and fallback verdict

空间检查和任务提示均落在现有展示、授权及冲突 producer 上，没有发现替代执行路径、catch-and-success 或自动任务操作。低空间下的 Yes/No 属于同一用户授权契约，不是 fallback；测量错误继续传播。

主要路径设计本身成立，但 B-01、B-02 使关键行为缺少敏感验证，不能放行。

## Release verdict

**BLOCK — R15**。需要修订同一 canonical plan、递增 revision，并进行新的 full-scope plan audit；当前不得进入实现。
```

R16 adds exact PRAGMA-derived numeric assertions to the standalone test and an
explicit `y` continuation to the existing combined low-space slice.

### R16 independent verdict (verbatim)

```text
## Blocking findings

### B-01 daemon 的 running 任务冲突仍然只有 ID，没有状态和建议

- Violated invariant: 原始需求要求旧任务冲突说明 `interrupted`/`running` 状态及下一步建议；INV-07 不能只覆盖计划选定的三处 `already exists`。
- Evidence class: reachable
- Producer and execution path: 首个 machine `db compress` 经 live daemon 启动任务并返回后，任务仍可保持 running → 第二个 machine `db compress` 因 `human=false` 跳过 `db.ts` 的冲突预检 → daemon `runMaintenance` 命中 `activeMaintenance` → 抛出 `Maintenance task already active: <taskID>` → 409 错误原文经 `daemonRequest` 返回 CLI。
- Source evidence: `packages/opencode/src/cli/cmd/db.ts:523-526` 的预检仅限 human；`packages/opencode/src/cli/cmd/db.ts:548-568` 是 machine daemon 请求路径；`packages/opencode/src/cli/tui/worker.ts:181-183` 产生另一条 ID-only 冲突；`packages/opencode/src/cli/tui/worker.ts:211-214` 和 `packages/opencode/src/cli/tui/worker.ts:254-268` 证明 accepted 后 active 任务仍可继续运行；`packages/opencode/src/cli/tui/worker.ts:51-55` 与 `packages/opencode/src/cli/cmd/db.ts:86-91` 原样传播该消息。
- Canonical-plan evidence: §2 排除 `worker.ts`；§5 声称只有三处 ID-only producer；§10.2、§13 和 §16 均未覆盖上述 daemon machine 冲突。
- Responsibility owner: daemon maintenance admission 所在的 `packages/opencode/src/cli/tui/worker.ts`，与既有任务冲突文案 formatter 协作。
- Concrete behavioral consequence: 用户在一个 running 维护任务期间再次执行 machine compress，仍会只得到任务 ID，看不到 `Status: running`、Inspect 或等待建议；原始需求要求的“缺少上下文”在真实 CLI 路径上继续存在。
- Minimal correction direction: 将 daemon admission 的 `already active` 分支纳入同一状态、Inspect 和 wait 文案合同，并复用现有 real-daemon CLI fixture 增加 running 冲突验证；不修改调度、lease 或任务生命周期。

### B-02 精确空间断言读取的是迁移前 PRAGMA，正确实现也无法稳定通过探针

- Violated invariant: INV-01–03 的精确数值验证必须与实际 VACUUM 前 `StatusReport` 对应；§18 要求的原始反馈 loop 必须在正确实现下能够转绿。
- Evidence class: reachable
- Producer and execution path: §8.1 创建临时数据库、删除唯一的 `pad` 表并读取 PRAGMA → 随后才启动 CLI → `VacuumCommand` 获取 `Database.Service` → 数据库层执行 migration → 因数据库已没有用户表而执行完整 `schema.up` 和 migration 登记 → 新建表及索引消耗或增加页面并改变 freelist → VACUUM 前报告读取到另一组 page metrics。
- Source evidence: `packages/core/src/database/database.ts:28-69` 在提供数据库服务前应用 migration；`packages/core/src/database/migration.ts:23-39` 对空数据库执行 `schema.up`；`packages/opencode/src/cli/cmd/db.ts:856-876` 先取得数据库服务再读取 VACUUM 前报告。现有 `packages/opencode/test/cli/db-maintenance.test.ts:46-51` 已提供可先完成真实迁移的 `prepareDatabase` fixture。
- Canonical-plan evidence: §8.1 第 151–162 行在 CLI 启动前计算 `allocated`、`reclaim` 和 `estimate`，第 185–189 行却用这些旧值断言 CLI 输出；§18 将该探针列为必须通过的验证。
- Responsibility owner: §8.1 探针及现有 `packages/opencode/test/cli/db-maintenance.test.ts` 的数据库 fixture。
- Concrete behavioral consequence: 正确的空间计算会显示迁移后的 allocation/reclaim/estimate，而探针仍期待迁移前的数值，导致必需验证误报失败；若通过删除精确断言来规避，又会重新失去 R15 要求的公式回归保护。
- Minimal correction direction: 在读取独立 PRAGMA 基准前复用现有真实迁移 fixture，再制造 freelist 并启动 CLI，保留同一组精确数值断言，无需新增测试文件或边缘测试矩阵。

## Non-blocking findings

无。

## Rejected speculation

- 不增加挂载点解析、卷名展示或 `Available on <volume>`；`Available space` 已符合最新要求。
- 不增加自动关闭、自动恢复任务或 lease/lifecycle 修改；B-01 只要求补齐同一冲突行为的消息和验证。
- 不要求新建 worker fixture、`statfs` 错误、`:memory:`、相等边界或低空间 machine 测试矩阵。
- 不引入测量失败后跳过检查、低空间自动继续或替代 SQL 等 fallback。
- 可用空间在测量后变化属于计划已声明的 advisory 固有限制，不因此要求锁盘或二次测量。

## Requirement and traceability coverage

- 空间公式采用 `activeBytes = allocatedBytes - potentialReclaimBytes`、`estimatedWorkingBytes = 2 * activeBytes`，已将 `freelistPages` 纳入有效数据估算，没有按膨胀后的总分配量直接乘二。
- standalone 与 combined 的交互 `--yes` 均定义为警告后直接执行；低空间且无 `--yes` 的 combined 路径使用 default-no，并计划验证空回车拒绝、显式 `y` 继续和 flag 直执行。
- 拒绝只跳过 VACUUM，保留已完成 compression；接受仍调用既有 `runVacuum`。
- 警告展示 allocation、potential reclaim、estimate 和 `Available space`，没有卷名或挂载点解析。
- 三处 `Maintenance task already exists` 的 formatter 设计能够复用 durable task 状态，为 interrupted 提供 Inspect/resume、为 queued/running 提供 Inspect/wait；但 B-01 表明 producer 清单不完整。
- 文件计划没有新增生产文件、依赖或专用边缘测试，方向符合范围收紧要求；B-01 的修正需要把真实 daemon producer 纳入范围，而不是继续排除它。
- R16 增加的显式 `y` 覆盖能够防止低空间确认框错误拒绝所有回答；精确公式覆盖仍受 B-02 的基准时点问题影响。

## Primary-path and fallback verdict

空间检查位于既有交互授权入口，实际 VACUUM 仍由 `runVacuum` 执行；低空间 Yes/No 属于同一用户授权合同，不是替代成功路径。原生测量错误继续传播，没有 catch-and-success、替代 SQL 或自动任务操作。

共享任务错误 formatter 属于展示责任收敛，方向正确；但 daemon admission 的同类冲突仍在 formatter 之外，因此完整 primary-path 覆盖尚未成立。

## Code quality and Chinese-comment verdict

计划中的空间私有 helper、既有 `confirm` 默认值扩展及三处共用的 `busyError(task)` 都有直接需求依据，没有新建 pass-through 模块、挂载点解析代码或生产测试专用文件。

当前是 plan audit，没有实际 implementation diff，不能计算实际 `E`/`C`。§17 的估算 `E=105–160`、`C=16–24` 算术可行，但应在 B-01 范围修正后更新；实施时仍须按实际 diff 达到 15% 目标，独立实现审计的阻断底线为 10%。注释只解释有效数据公式、`--yes` 授权、default-no 和 durable 状态等关键边界，不拆行凑数。

本轮未实施代码或运行测试；阻断结论来自直接读取的源码调用链和确定性迁移路径。

## Release verdict

**BLOCK — R16**。需要修订同一 canonical plan、递增 revision，并进行新的 full-scope plan audit；当前不得进入实现。
```

R17 applies real migrations before the PRAGMA baseline. The separate daemon
`already active` message remains outside the user's explicitly approved two-file
boundary; the requested `already exists` family stays covered at three existing
producers in `db.ts` and `maintenance.ts`.

### R17 independent verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- `docs/plans/db-vacuum-space-and-maintenance-task-guidance.md:443-444` 仍写着 “R16 is the only implementation candidate”，与当前 R17 不一致。记录审计结论时应改为 R17；这是记录修正，不影响设计、范围或本次放行。
- §15 的测试增量估算为 `+50 至 +80`，§19 为 `+60 至 +90`。两者都不是行为合同或硬上限，但实施证据中应统一口径。

## Rejected speculation

- 不增加挂载点或卷名解析；`Available space` 已满足最新要求。
- 可用空间在测量后变化属于已声明的 advisory 固有限制，不因此引入锁盘、重试或替代 SQL。
- 不增加自动取消、自动恢复、lease/lifecycle 修改，也不新建 worker  fixture 或专用边缘测试矩阵。
- daemon 的 `Maintenance task already active` 是另一条真实路径，但本轮用户明确锁定两个生产文件并排除 `worker.ts`；不据此重新扩大范围。本结论只覆盖计划明确处理的三个 `Maintenance task already exists` producer。

## Requirement and traceability coverage

- **空间公式**：`cold-store.ts:3003-3007` 已提供 `activeBytes = (pageCount - freelistPages) * pageSize`。R17 §7、§10 使用 `2 * activeBytes`，没有按膨胀后的总分配量直接乘二。
- **交互行为**：standalone 在 `db.ts:856-876` 的 reusable-page gate 后检查并警告，`--yes` 直接调用既有 `runVacuum`；combined 在 `db.ts:649-660` 的既有授权点检查，低空间且无 `--yes` 时 default-no，显式 `y` 继续，拒绝只跳过 VACUUM。
- **验证敏感性**：§8.1 和 §16 先执行真实迁移，再制造 freelist、读取独立 PRAGMA 并断言精确数值，能够识别错误的 `2 * allocation` 实现；combined slice 同时覆盖空回车拒绝、显式 `y` 继续和 flag `--yes`，不再只验证拒绝路径。
- **输出边界**：警告包含 allocation、potential reclaim、estimate 和 `Available space`，不包含卷名。machine、`:memory:` 和既有 JSON 路径保持不变。
- **旧任务上下文**：`maintenance.ts:41-54` 的两个 offline producer 和 `db.ts:523-526` 的 live-daemon interactive precheck 共用 `busyError(task)`；`server-lock.ts:376-384` 已保证交付的是 reconciled durable task。interrupted 显示 Inspect/resume，queued/running 显示 Inspect/wait。
- **范围**：生产修改仅涉及 `db.ts`、`maintenance.ts`，测试仅涉及现有 `db-maintenance.test.ts`；没有新文件、依赖、任务状态机或 SQLite 执行语义变化。

## Primary-path and fallback verdict

空间检查位于既有交互授权路径，实际执行仍唯一归属 `runVacuum`；低空间 Yes/No 是同一用户授权合同，不是备用成功路径。测量错误继续传播，没有 catch-and-success、替代 SQL 或自动任务操作。

任务提示收敛为一个 formatter，并接回三个既有错误产生点，没有形成第二套任务查询或状态判断逻辑。计划没有新增 alternate success path。

## Code quality and Chinese-comment verdict

私有空间 helper、既有 `confirm` 的默认值扩展和三处共用的 `busyError(task)` 都有直接需求及调用链依据，没有新建 pass-through 模块或测试专用生产文件。验证命令均使用 `packages/opencode` 工作目录。

当前是 plan audit，没有实际 implementation diff，不能计算实际 `E/C`。§17 估算 `E=105–160`、`C=16–24`，满足 `ceil(E × 0.15)` 的上下界；注释限定在有效数据公式、`--yes` 授权、default-no 和 durable 状态等关键边界，没有恢复机械凑行指标。实现审计仍须独立重算实际值，并执行不低于 10% 的阻断底线。

本轮仅进行只读源码、计划和 git 检查，未运行测试。

## Release verdict

**APPROVE — R17，仅限 approved-plan-only。** 放行的是当前完整 R17 计划，不代表实现已经验证；记录本次 clean verdict 后，仍须严格按该 revision 实施并完成独立实现审计。
```

The two record corrections are applied: R17 is the candidate and both test-line
estimates use 60–90. Any substantive design revision invalidates this approval.

R19 delta: §1/7/8/10/16 use the configured database file directly. The existing fixture checks the displayed nonzero available byte count and that advice precedes confirmation (R18 B-01/B-02). Product file set, execution domains and task states are unchanged. Native Windows statfs accepted a file path in the package-local probe.

### R18 plan verdict (ses_dee38e304fferr8Im61QPQMd48)

```text
## Blocking findings

### B-01 空间探针无法验证测量的是数据库所在磁盘

- **Violated invariant:** INV-02、INV-03 要求用数据库所在文件系统的 `bavail × bsize` 判断空间，并向用户显示可用字节数。
- **Evidence class:** contracted
- **Producer and execution path:** `OPENCODE_DB` → `Database.path()` → 交互式 VACUUM 空间检查 → CLI 警告。数据库路径可以独立于 CLI 工作目录。
- **Source evidence:** `packages/core/src/database/database.ts:102-105` 接受绝对数据库路径；`packages/opencode/test/cli/db-maintenance.test.ts:24-32,54-59` 已将临时数据库与子进程工作目录分开。
- **Canonical-plan evidence:** R18 §8.1 第 181 行的 `statfs` mock 忽略路径，对任何输入都返回 `bavail: 0`；第 199 行只断言 `Available space 0 B`。§10.1 第 266 行则明确要求测量数据库路径。
- **Responsibility owner:** `db.ts` 的交互式空间检查，以及 §8.1 和现有 CLI 测试中的验证用例。
- **Concrete behavioral consequence:** 把测量路径误写成 `process.cwd()`，该探针仍能通过。当程序盘空间充足、数据库盘空间不足时，用户会漏收警告。另外，`0 × 4096` 仍是 `0`，这个断言也识别不了把可用块数直接当字节数显示的错误。
- **Pre-R1 baseline behavior on the same path:** `packages/opencode/src/cli/cmd/db.ts:865-876` 在发现可回收页后直接执行 VACUUM，不测量磁盘空间。
- **Round basis:** introduced by delta。R18 重写了 §8.1 的 mock，移除了对传入路径的使用。
- **Minimal correction direction:** 复用同一个 CLI 用例，让临时数据库路径返回已知的、非零但不足的空间，其他路径返回充足空间，再断言警告中的实际字节显示；无需第二块磁盘或新测试文件。

### B-02 低空间时给用户的操作建议没有进入验收

- **Violated invariant:** §1 原始需求要求在用户决定是否继续 VACUUM 前，说明空间不足并给出建议。R18 §10.1 已将建议具体化为先释放磁盘空间。
- **Evidence class:** contracted
- **Producer and execution path:** 压缩完成 → 达到回收门槛 → 显示低空间警告及建议 → 用户回答 `[y/N]`。
- **Source evidence:** `packages/opencode/src/cli/cmd/db.ts:649-660` 是现有确认点；`packages/opencode/test/cli/db-maintenance.test.ts:54-66,158-170` 已能捕获终端输出并在提示出现时应答。
- **Canonical-plan evidence:** §10.1 第 282 行新增 `Free up disk space before reclaiming SQLite pages.`；§8.1 第 195–200 行只检查容量字段、完成文本和有无二次询问，§16 第 378–380 行也只验数值及选择结果。
- **Responsibility owner:** `db.ts` 的低空间警告，以及现有 combined CLI 用例。
- **Concrete behavioral consequence:** 删除释放空间的建议，或把它放到用户回答之后，计划列出的断言仍可通过。用户会在缺少下一步建议时作决定。
- **Pre-R1 baseline behavior on the same path:** 原确认框只显示可回收量并询问是否回收，没有低空间建议。
- **Round basis:** introduced by delta。R18 补入了用户要求的建议，但没有同步更新行为验收。
- **Minimal correction direction:** 在已有 combined 低空间用例中断言“先释放磁盘空间”的建议出现在 `[y/N]` 之前，沿用原有拒绝和继续用例。

## Non-blocking findings

`packages/opencode/test/cli/db-maintenance.test.ts:172-174` 明确在 Windows 跳过需要向 PTY 回写输入的用例。实施时应在支持回写的 POSIX 环境运行 §18 的同一条 CLI 测试命令，并记录空回车拒绝、显式 `y` 继续两个用例的实际结果。Windows 上的 standalone `--yes` 探针可单独验证无二次询问。

## Follow-up

`packages/opencode/src/cli/tui/worker.ts:181-183` 的 `Maintenance task already active` 是另一条 daemon 准入错误。R18 保留其基线行为，符合用户限定的两个生产文件范围。

## Rejected speculation

两项阻断都能在现有 CLI 用例内解决。无需增加卷名解析、专用 worker、真实低空间磁盘、自动恢复任务或新的边缘测试矩阵。

## Requirement and traceability coverage

- **空间估算与授权：** `packages/core/src/storage/cold-store.ts:3022-3023` 已提供扣除 freelist 后的 `activeBytes`。R18 使用 `2 × activeBytes`；独立 PRAGMA 断言能识别误用 `2 × allocatedBytes`。`--yes` 直接执行、低空间无 `--yes` 默认拒绝、拒绝后保留已完成压缩，均有明确路径。
- **旧任务提示：** `packages/opencode/src/cli/maintenance.ts:41-54` 和 `packages/opencode/src/cli/cmd/db.ts:523-526` 的三处冲突都已持有任务。`packages/opencode/src/cli/tui/server-lock.ts:376-384` 先核对状态再返回非终态任务，因此共用一个 formatter 即可给出 Inspect、interrupted 时 resume、queued/running 时等待的建议。
- **范围与证据：** 已比对 R17 blob `d3004c0685` 与 R18，并核对三个拟修改的源码及测试文件相对 pre-R1 `f37e94dd26` 的 diff 为空。本轮结论来自计划、源码、测试和只读 Git 检查；§8 的运行结果为计划记录。

## Primary-path and fallback verdict

生产设计可以保留：空间检查位于现有确认点，接受后仍调用 `runVacuum`；旧任务冲突只补充错误文本，保留原失败行为。两项阻断都属于验收缺口，不要求改变 SQL、租约或任务生命周期。

## Release verdict

**BLOCK — R18。** 保留两文件生产设计，修订现有验证用例以覆盖 B-01、B-02，再对新 revision 做全范围计划审计。
```

### R19 plan verdict (ses_dee318debffePgxSz41YF0tA0C)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **实验记录有一处旧值。** 计划 §9 第 250 行的 `0 B` 来自 R18；R19 §8.1 第 185、203 行给数据库路径设置了两个 4096 字节的可用块，预期显示 `8.2 KB`。将 §9 标为历史结果即可，R19 的验收值已经一致。
- **交互验收要在 POSIX 上实际运行。** `packages/opencode/test/cli/db-maintenance.test.ts:158-174` 在 Windows 跳过需要回写终端输入的用例。实现验证时，应记录空回车拒绝和显式 `y` 继续两项的实际结果。

## Follow-up

`packages/opencode/src/cli/tui/worker.ts:181-182` 的 `Maintenance task already active` 是另一条 daemon 准入错误。R19 保留其基线行为，符合用户限定的生产文件范围。

## Rejected speculation

现有用例已能验证数据库路径、可用字节数和提示顺序，无需解析挂载点、制造真实磁盘不足或新增测试 worker。任务提示也无需引入自动恢复或取消操作。

## Requirement and traceability coverage

- **空间估算，R18 B-01 已解决。** `packages/core/src/storage/cold-store.ts:3020-3023` 已提供扣除 freelist 后的 `activeBytes`。R19 使用 `2 × activeBytes`，直接查询 `Database.path()`。§8.1 先迁移数据库，再独立读取 PRAGMA；只有数据库路径返回 `8192 B`，其他路径返回充足空间。误测工作目录、把块数当字节数或按总分配量乘二，都会使现有断言失败。
- **用户选择，R18 B-02 已解决。** 计划 §16 第 384 行要求释放空间的建议先于 `[y/N]` 出现，并覆盖空回车保留已完成的压缩、显式 `y` 执行回收。交互式 `--yes` 则在警告后直接继续。两个授权点对应 `packages/opencode/src/cli/cmd/db.ts:649-660` 和 `:865-876`。
- **旧任务提示。** `packages/opencode/src/cli/maintenance.ts:41-54` 的两处离线冲突，以及 `packages/opencode/src/cli/cmd/db.ts:523-526` 的交互预检，都已持有核对过状态的任务。共用一个错误格式化函数即可给出任务 ID、状态和查看命令；`interrupted` 给恢复命令，`queued`、`running` 给等待建议。
- **修改范围。** 已用只读 Git 比对固定基线 `f37e94dd26`，两份拟修改源码和一份现有 CLI 测试文件的差异为空。R19 两项修正都落在已有验证用例内，未扩大生产范围。

## Primary-path and fallback verdict

磁盘检查只补充现有授权点的信息；用户同意后仍由 `runVacuum` 执行，拒绝只跳过物理回收。任务冲突仍从原位置报错。两条改动都保留原执行路径，没有新增备用成功路径。

## Release verdict

**APPROVE — R19，全范围计划审计通过。** 将本次结论记录到 canonical plan 后，可按 R19 实施。提交仍以 §18 验证通过、实际 diff 获得独立实现审计批准为前提。
```

R20 delta: the repository test-mock-module gate excludes whole-module replacement. The same PTY fixture now substitutes just the public fs.statfs method. A native Windows Bun/readline PTY received `y`; run both new interactive answers directly here. §9 records the earlier R18 red (0 B); R19/R20 use 8192 B. The task-guidance slice already retained from the fixed baseline is specified in §§10.2/15/16 and passed the CLI red/green check; the space behavior is still pending. No production contract, files, conditions or output change.

### R20 plan verdict (ses_dee318debffePgxSz41YF0tA0C)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **R20 的测试调整仍待落地。** 计划 §8.1 第 184–185 行已改为仅替换子进程的 `fs.statfs`；当前工作树的 `packages/opencode/test/cli/db-maintenance.test.ts:69-74` 仍使用 `mock.module`，会命中 `script/guard/rules.ts:326-330`。§22 第 738 行宜将这项调整标为待实施。实现审计须核对实际 diff 和 gate 结果。
- **两种交互回答都要留下真实 CLI 结果。** 现有 `ptyInteractive` 在 Windows 跳过用例（`packages/opencode/test/cli/db-maintenance.test.ts:181-183`）。R20 要求直接运行新增用例；验收记录应分别显示空回车跳过 VACUUM、显式 `y` 完成回收。§22 记录的 readline 探针只验证了输入通道。

## Follow-up

daemon 的 `Maintenance task already active` 仍由 `packages/opencode/src/cli/tui/worker.ts:181-182` 单独产生。保留其基线行为，符合本次两份生产文件的范围。

## Rejected speculation

现有 CLI 测试夹具足以验证空间、提示顺序和用户选择，无需增加挂载点解析、生产测试开关、专用 worker 或自动处置旧任务的逻辑。

## Requirement and traceability coverage

- **空间与授权。** `packages/core/src/storage/cold-store.ts:3020-3023` 提供扣除 freelist 后的 `activeBytes`。R20 在现有两个交互入口比较 `2 × activeBytes` 与数据库路径上的 `bavail × bsize`。§8.1 用独立 PRAGMA 校验估算值，并要求显示 `8.2 KB`；§16 要求释放空间的建议先于 `[y/N]`，显式 `--yes` 不再询问。
- **旧任务提示。** 相对固定基线 `f37e94dd26`，当前工作树已将离线压缩、离线 VACUUM 和交互 daemon 预检接入同一个格式化函数（`packages/opencode/src/cli/maintenance.ts:33-42,53-54,64-66`；`packages/opencode/src/cli/cmd/db.ts:523-526`）。三处沿用已核对的任务状态，给出查看命令，并按状态建议恢复或等待。
- **修订范围。** R19 → R20 调整了测试中模拟磁盘空间的方式和交互用例的运行要求。生产行为、文件范围和行数上限保持不变。本轮核对了源码、测试和 Git 差异；测试运行结果留待实现审计核验。

## Primary-path and fallback verdict

空间检查位于现有 VACUUM 授权点；用户同意后仍调用 `runVacuum`，拒绝只跳过物理回收。任务冲突继续返回原有错误类型。两项修改都保留单一执行路径。

## Release verdict

**APPROVE — R20，全范围计划审计通过。** 记录本次结论后可继续实施。提交前须完成 §18 验证、通过仓库 gate，并由独立实现审计放行完整任务 diff。
```

## 23. Implementation Evidence

Actual diff versus pre-R1: `db.ts` +32/-5, `maintenance.ts` +14/-2 (53 production lines); `db-maintenance.test.ts` +82/-5 (87 test lines); zero new code comments. Both totals fit the 160-line limits. No new dependencies, test workers or configuration.

Red/green via real public CLI in `packages/opencode` on Windows, Bun 1.4.4:

- `bun test test/cli/db-maintenance.test.ts -t 'explains a blocking'`: red received ID only. Green: offline compress and VACUUM report interrupted/inspect/resume; live-lock precheck reports queued and running/inspect/wait. Exit code 1 retained.
- `bun test test/cli/db-maintenance.test.ts -t 'before standalone VACUUM'`: red went straight to physical reclaim. Green compared all four displayed values against migrated PRAGMA measurements and the 8192 B filesystem fixture; `--yes` finished. Print single-space label/value pairs to keep values directly readable from Windows ConPTY as well as text terminals.
- `bun test test/cli/db-maintenance.test.ts -t 'lets the user skip'`: red showed ordinary `[Y/n]`; Enter ran VACUUM. Green through native PTY: advice then `[y/N]`, Enter printed `Physical reclaim skipped` after compression, `y` printed `Physical reclaim completed`, explicit `--yes` also warned and completed without input.
- §18 final commands (cwd `packages/opencode`): `bun test test/cli/db-maintenance.test.ts`: 12 pass, 6 pre-existing platform skips, 0 fail; all three new tests ran. `bun test test/cli/tui/maintenance-worker.test.ts`: 4 pass, 0 fail. `bun typecheck`: exit 0 (SQLite fixture now uses typed .all() rows). Exact §8.1 and §8.2 probes: both harness exits 0, respective CLI exits 0 and 1, both `green:true`.
- Repository root: `bun script/guard/check.ts . --files 'packages/opencode/src/cli/cmd/db.ts,packages/opencode/src/cli/maintenance.ts,packages/opencode/test/cli/db-maintenance.test.ts'`: 3 files, 0 errors/warnings. Prompt wording/default stay together in `confirmReclaim`; this keeps the existing compression coordinator inside its complexity limit. `git diff --check` for the three changed code paths passed.

Route: two existing interactive authorization points measure the real database file; ordinary consent, default-no and explicit `--yes` all lead to the existing `runVacuum` when authorized. Machine and retained-daemon paths are preserved. Three ID-only error constructions collapsed into `busyError` using the already reconciled record. No retry, second writer, automatic task action, or alternate success path. The separate machine daemon conflict remains the §20 follow-up. Verification used disposable databases and deterministic available-space values; actual free space may change during VACUUM.

## 24. Implementation Audit Record

### R20 implementation verdict, full scope, round 1 (ses_dee2699cdffeMZFhN8pQ78poK7)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

`packages/opencode/test/cli/db-maintenance.test.ts:181-183` 的注释仍笼统地说交互回写用例只在 POSIX 运行。本轮在 Windows 上实际跑通了新增用例的空回车和显式 `y` 两条路径；跳过的是沿用 `ptyInteractive` 的 6 个既有用例。这处注释不影响测试或放行。

## Follow-up

`packages/opencode/src/cli/tui/worker.ts:182` 的 `Maintenance task already active` 是另一条 daemon 准入错误。R20 明确保留其基线行为，本次不改。

## Rejected speculation

直接对 `Database.path()` 调用 `statfs` 已能检查数据库所在文件系统。无需解析挂载点、增加测试 worker，或自动恢复、取消旧任务。

## Requirement and traceability coverage

| 验证项 | 本轮独立运行结果 |
|---|---|
| 三个新增 CLI 用例 | **3 通过，0 失败**。覆盖旧任务指引、独立 VACUUM 空间估算，以及低空间时空回车、`y`、`--yes` 三种选择。 |
| 完整 `db-maintenance.test.ts` | **12 通过，6 个既有 Windows 平台跳过，0 失败**。三个新增用例全部执行。 |
| `maintenance-worker.test.ts` | **4 通过，0 失败**。 |
| §8.1 独立 VACUUM 原始探针 | `{"code":0,"green":true}`。四项空间数值符合预期；`--yes` 警告后直接完成回收。 |
| §8.2 中断任务原始探针 | `{"code":1,"stdout":"","green":true}`。CLI 保留冲突退出码，并给出中断状态和恢复命令。 |
| 包级 `bun typecheck`、三文件 guard、`git diff --check` | 全部通过。guard 检查 3 个文件，0 错误、0 提示。 |

## Primary-path and fallback verdict

空间判断比较数据库所在文件系统的 `bavail × bsize` 与扣除 freelist 后的 `2 × activeBytes`。压缩后的交互回收在低空间时默认拒绝；空回车保留已完成的压缩，`y` 或显式 `--yes` 仍调用原有 `runVacuum`。独立 `db vacuum --yes` 警告后直接执行。机器输出路径保持原样。见 `packages/opencode/src/cli/cmd/db.ts:482-498,674-688,885-903`。

三处旧任务冲突都使用已核对状态的任务记录：`interrupted` 给查看和恢复命令，`queued`、`running` 给查看命令和等待建议。错误类型、租约和任务生命周期保持原样。见 `packages/opencode/src/cli/maintenance.ts:33-42,53-54,64-66` 和 `packages/opencode/src/cli/cmd/db.ts:548-551`。

## Code quality verdict

通过。相对固定基线 `f37e94dd26`，两份生产文件增删合计 **53 行**，一份既有测试文件增删合计 **87 行**，均在上限内。三处仅含任务 ID 的错误构造已归并；低空间测试仅替换子进程的 `fs.statfs`，没有保留整模块替换、专用 worker 或备用 SQL 路径。

## Release verdict

**APPROVE — R20 的实际实现 diff 通过独立全范围审计，可进入限定路径提交。** 放行范围是本次核验的两份生产文件、一份 CLI 测试文件及对应的 canonical plan 审计记录；工作树中的其他改动不在此次放行范围内。
```

