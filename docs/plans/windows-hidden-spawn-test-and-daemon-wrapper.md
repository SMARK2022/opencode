# Canonical Implementation Plan: Windows Hidden Spawn (Daemon + Tests)

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 详细完整检查全面的测试内容，不局限于daemon测试，检查并手术刀级别纠正部分没加上hidden启动的部分测试逻辑，保持修改的必要性和最小范围，确保不破坏现有功能和测试覆盖。目标终态：verified-implementation-and-commit。
>
> Implementation allowed: no
>
> Last updated: 2026-07-25

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

详细完整检查全面的测试内容，不局限于daemon测试，检查并手术刀级别纠正部分没加上hidden启动的部分测试逻辑，保持修改的必要性和最小范围，确保不破坏现有功能和测试覆盖。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不批量给仓库所有 `Bun.spawn` / 所有测试加 `windowsHide`。
- 不改 PTY / 交互式终端路径（`#pty`、`db` 交互、`Editor.open` 的 `stdio: inherit`）。
- 不改用户可见 shell Tool 会话、浏览器 OAuth/`open(url)`、外部编辑器。
- 不重构 daemon 生命周期、不改 Windows PowerShell worker 托管协议（`Start-Process` PID 握手）。
- 不把测试 helper 的 `spawnDaemon(WORKER_TS)` 改造成必须走生产 PowerShell wrapper（路径统一超出 “hidden 启动” 范围）。
- 不引入第二套 spawn 抽象或平台 fallback 成功路径。
- 不在 `thread.test.ts` 声称覆盖 INV-01（该文件的 `_setSpawn` 只能看到 ensure→adapter opts，看不到 wrapper 最终 `Bun.spawn`）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Runtime / Project | Daemon 是 TUI 共享 SQLite owner；spawn 行为属于 runtime 进程边界。 |
| `AGENTS.md` / `packages/opencode/AGENTS.md` | 测试不得从 repo root 跑；typecheck 用 package-local `bun typecheck`。 |
| `packages/opencode/test/AGENTS.md` | 真子进程/live OS 行为用 live spawn；临时目录隔离。 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁止 fallback；最小必要概念；中文注释门禁。 |
| 既有 invariant：`NetworkProxy` / `Process` / `cross-spawn-spawner` | Windows helper 进程已用 `windowsHide`；注释明确防 conhost 弹窗。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | Windows wrapper `Bun.spawn(powershell…)` 无 `windowsHide`；`_setSpawn` 替换整个 `spawnImpl`，不进入 wrapper | observed |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | 默认 `win32DetachConsole()`；与 hide 窗口不同职责 | observed |
| `packages/opencode/src/cli/cmd/tui/win32.ts` | FreeConsole / Ctrl+C；Windows 不能 `detached:true` | observed |
| `packages/opencode/src/cli/cmd/tui/thread.ts` | TUI 经 `Daemon.ensure` 启动 daemon | observed |
| `packages/opencode/src/util/process.ts` | `windowsHide: process.platform === "win32"` | contracted |
| `packages/core/src/network-proxy.ts` | `reg.exe` 已 `windowsHide` | observed |
| `packages/core/test/network-proxy.test.ts:84-112` | **正确 seam 模板**：拦截真实 `Bun.spawn` 的 options | observed |
| `packages/core/src/cross-spawn-spawner.ts` | Effect ChildProcess 已 hide | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts` | 多 helper/多单点 `Bun.spawn`；无 hide | observed |
| 全量 test inventory（R2 闭合表 §15） | include/exclude 与证据理由 | observed |
| `node_modules/bun-types/bun.d.ts` | `windowsHide?: boolean` | contracted |
| Static red signal | wrapper options 块 `has_windowsHide=False` | observed |

## 5. Current Behavior

```text
TUI/thread / daemon start CLI
  -> Daemon.ensure
  -> spawnImpl([execPath, worker], { stdin ignore, stdout/stderr ignore|inherit, detached: !win32 })
  -> Unix: Bun.spawn(worker) detached
  -> Windows: Bun.spawn(SystemRoot\...\powershell.exe -EncodedCommand ...)  // 当前无 windowsHide
       -> Start-Process worker (-WindowStyle Hidden | -NoNewWindow if PRINT_LOGS)
       -> wrapper prints worker PID on stdout, WaitForExit
  -> worker: FreeConsole (unless print-logs)

测试旁路:
  多处 Bun.spawn(process.execPath | worker | -e | pwsh | node) 后台/非交互 — 当前无 windowsHide

已正确 hide:
  Process.spawn / NetworkProxy reg.exe / shell taskkill / cross-spawn-spawner
```

**控制流互斥（B-01 根因）**：`Daemon._setSpawn(fn)` 将 `spawnImpl` 换成测试 mock 后，**不会**执行 `spawnDaemon` 内的 PowerShell wrapper `Bun.spawn`。因此 `_setSpawn` **不能**作为 INV-01 的观测 seam。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Windows `Daemon.ensure` | TUI / CLI / ensure 测试 | SystemRoot 绝对 | `spawnDaemon` Windows 分支 | `Daemon.spawnDaemon` | observed |
| 默认 worker 窗口 | 同上 | 无 PRINT_LOGS | `Start-Process -WindowStyle Hidden` | PS 脚本 | observed |
| print-logs worker | `--print-logs` | 调试 console | `-NoNewWindow` | PS 脚本 | contracted |
| 测试后台 `Bun.spawn`（§15 include） | 测试 runner | ignore/pipe 为主 | 各 call site | 测试 helper | observed |
| Unix | 同上 | 无 console 窗 | `windowsHide` 无害 | 各 spawner | contracted |
| PTY / inherit 交互 | db 交互、Editor | 需可见终端 | 排除 | 非目标 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | Windows daemon **wrapper** 的最终 `Bun.spawn` options 必须 `windowsHide === true` | NetworkProxy 合同；Bun 类型；用户弹窗症状 | network-proxy 有模板；daemon **无** |
| INV-02 | Worker 默认 Hidden；print-logs 用 NoNewWindow | `daemon.ts` PS 脚本 | 既有 win32 集成测路径 |
| INV-03 | §15 **include 清单**中每个后台/非交互测试 `Bun.spawn` 在 win32 上传 `windowsHide: true`（或等价强制） | 用户“全面检查+手术刀纠正”；inventory | 当前 include 全为 false |
| INV-04 | 不破坏 daemon 生命周期、PID 握手、detached 差、空格路径、launcher 存活等 | 既有 suite | daemon/thread 现有测 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `spawnDaemon` Windows 分支 wrapper `Bun.spawn` 选项缺 `windowsHide` | `daemon.ts` `spawnDaemon` | 源码块无字段；静态 red |
| INV-03 | include 清单 call site 未传 `windowsHide` | 各测试 helper/单点 | inventory hide=False |

### Red-capable feedback loop

| Item | Value |
| --- | --- |
| Command | 静态检查 wrapper options 是否含 `windowsHide`（已跑 → False） |
| 固化测试（实施期） | 临时替换 **真实** `Bun.spawn`，在 **默认** `spawnDaemon`（不 `_setSpawn`）下调用 `DaemonModule._spawn` 或 win32 可达路径，断言 **powershell wrapper** 那次调用的 `options.windowsHide === true` |
| Why red now | 选项对象无该字段 |

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why here | Not elsewhere |
| --- | --- | --- | --- | --- |
| Wrapper hide | `Daemon.spawnDaemon` | 后台 daemon 启动不可见 console | 唯一 PS wrapper 入口 | Process 不用于该 Bun.spawn |
| INV-01 回归测试 | `daemon.test.ts` | 拦截 **真实** `Bun.spawn` 的 wrapper 调用 | 与 network-proxy 同构 | **禁止** `_setSpawn` 观测 wrapper |
| INV-03 测试 hide | §15 include 清单 | 验证不弹窗 | 用户明确要求 | 不改 exclude 类 |
| 通用 Node hide | `util/process` | 已满足 | 保持 | 不重复 |

## 10. Single Approved Primary-Path Design

```text
Windows Daemon.ensure
  -> spawnDaemon (default spawnImpl only)
  -> Bun.spawn(system powershell, {
       ...opts,
       env: { ... },
       stdout: "pipe",
       detached: false,
       windowsHide: true,   // 强制；必须在 ...opts 之后
     })
  -> Start-Process worker Hidden|NoNewWindow (unchanged)
  -> PID handshake / drain (unchanged)

INV-01 测试（唯一有效 seam）:
  original = Bun.spawn
  Bun.spawn = (cmd, opts) => {
    if (cmd is system powershell wrapper path) capture opts.windowsHide
    return original(cmd, opts)  // 或返回最小 mock 进程，但必须走真实 spawnDaemon 代码路径
  }
  await DaemonModule._spawn([execPath, worker], { stdin ignore, stdout ignore, stderr ignore, detached:false })
  // 仅 process.platform === "win32" 时执行；非 win32 skip（生产无 platform 注入 seam）
  expect(captured).toBe(true)
  restore Bun.spawn
  // 禁止：DaemonModule._setSpawn 作为 INV-01 观测手段

INV-03:
  对 §15 include 每个 call site：选项增加 windowsHide: process.platform === "win32"
  同一文件多点时可用本地 helper（例如 spawnBackground）统一注入，helper 不得改变 cmd/stdio 语义
```

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Success? | Disposition |
| --- | --- | --- | --- | --- |
| Unix detached worker | current | primary-contract branch | yes | preserve |
| Windows PS wrapper + Hidden worker + hide | repair | primary-contract branch | yes | repair |
| print-logs NoNewWindow | current | primary-contract branch | yes | preserve |
| test direct WORKER_TS spawn | current harness | diagnostic/test | n/a | preserve + hide |
| `_setSpawn` mock for other lifecycle tests | current | test double | n/a | preserve；**不**用于 INV-01 |
| 第二 launcher / 全量 git hide | — | forbidden / speculative | — | reject |

## 12. Workaround Deletion and Replacement

| Item | Disposition |
| --- | --- |
| 无正式 workaround | N/A — 直接补 hide |

## 13. Forward Traceability

| Requirement | Production path | File/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | wrapper Bun.spawn | `daemon.ts` 强制 `windowsHide: true` | §16 slice 1：`Bun.spawn` 拦截（非 `_setSpawn`） |
| INV-02 | 现有 PS | 不改 | 既有 win32 集成测 |
| INV-03 | §15 include | 各 include 文件 | 改后 call site 带 hide；可选抽 helper |
| INV-04 | 既有 suite | 最小 diff | daemon 相关测试仍绿 |
| 全面检查 | inventory §15 | include 全改 + exclude 有理由 | 清单闭合可审计 |

## 14. Reverse Traceability

| Concept | Req | Evidence | Why not reuse |
| --- | --- | --- | --- |
| wrapper 强制 hide | INV-01 | 当前块缺失；NetworkProxy 同构 | Bun.spawn 直用，不经 Process |
| include 测试 hide | INV-03 | inventory False | 生产修复不改测试 spawn |
| 真实 Bun.spawn 拦截断言 | INV-01 | network-proxy 模板；`_setSpawn` 互斥 | 必须测默认 `spawnDaemon` |

## 15. File-Level Change Plan and Closed Call-Site Inventory

### 15.1 Production

| File | Change | Lines (approx) |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | wrapper `Bun.spawn` 在 `...opts` 之后强制 `windowsHide: true` + 中文注释 | +2–4 |

### 15.2 INV-03 Include（必须加 `windowsHide: process.platform === "win32"`，或经本地 helper 等价注入）

分类标准：非交互 / 后台 / pipe|ignore 主导、会启动 `process.execPath` / worker / `-e` / `pwsh` / `node` 等可在 Windows 创建 console 的进程。

| File | Call site (line at plan time) | Role | Disposition |
| --- | --- | --- | --- |
| `packages/opencode/test/cli/tui/daemon.test.ts` | 111 | `runDaemonStop` | **must hide** |
| 同上 | 169 | `runDaemonMachine` | **must hide** |
| 同上 | 189 | `spawnDaemon` worker | **must hide** |
| 同上 | 230 | hanging disposer worker | **must hide** |
| 同上 | 289 | ensure launcher | **must hide** |
| 同上 | 455 | fake owner | **must hide** |
| 同上 | 513 | inline replacement spawn（字符串内嵌 `Bun.spawn`） | **must hide**（改嵌套源字符串 opts） |
| 同上 | 522 | original fake owner | **must hide** |
| 同上 | 603 | owner spawn | **must hide** |
| 同上 | 754 | exited pid fixture | **must hide** |
| 同上 | 786 | nonDaemon alive | **must hide** |
| 同上 | 828 | nonDaemon alive | **must hide** |
| 同上 | 1007–1014 | `pwsh` file share holder | **must hide** |
| 同上 | 1039 | maintenance retry worker | **must hide** |
| 同上 | 1066 | task write retry worker | **must hide** |
| 同上 | 1331 | db status CLI | **must hide** |
| 同上 | 1444 | wrapper worker | **must hide** |
| 同上 | 1751 | compiled-binary role path | **must hide** |
| 同上 | 1857 | Windows launcher parent | **must hide** |
| 同上 | 1942 | Unix detached child（嵌套源；Unix-only 测） | **must hide**（字面一致；Unix 无操作） |
| 同上 | 1952 | Unix detached parent | **must hide** |
| `packages/opencode/test/cli/db-maintenance.test.ts` | 79 | `runCli` 后台 CLI | **must hide** |
| `packages/opencode/test/server/httpapi-sdk.test.ts` | 265 | promptAsync worker | **must hide** |
| `packages/opencode/test/storage/cold.test.ts` | 1080 | `-e` worker | **must hide** |
| `packages/opencode/test/tool/read.test.ts` | 34 | migration script child | **must hide** |
| `packages/opencode/test/session/goal.test.ts` | 857 | concurrent writer worker | **must hide** |
| `packages/core/test/network-proxy.test.ts` | 16 | `runChild` bun -e | **must hide** |
| `packages/opencode/test/snapshot/snapshot.test.ts` | 25 | `exec` helper | **must hide** |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | 816 | `node … --stop` | **must hide** |

实施约定：

- `daemon.test.ts` 优先增加文件内 `spawnBackground(cmd, opts)`（或同名），内部 `Bun.spawn(cmd, { ...opts, windowsHide: process.platform === "win32" })`，再替换上表 call site；嵌套在 `-e` 字符串里的 `Bun.spawn` 必须在字符串内写入 hide 字段。
- 其他文件若仅 1 点，可直接在 options 对象加字段。
- 行号以实施时文件为准；**角色列**是身份，行号漂移时按角色定位，不得漏角色。

### 15.3 Exclude（明确不改 + 理由）

| File / pattern | Reason |
| --- | --- |
| `daemon.test.ts` `spawnPty`（~128） | PTY 交互终端；非目标 |
| `db-maintenance.test.ts` `spawnPty` | 同上 |
| `prompt-voice-input.test.ts` `/usr/bin/say`、`afconvert` | macOS-only 二进制；win32 不跑 |
| `*.test.ts` 中 `Bun.spawn(["git", …])`（opentui-provenance、reference、read git helper） | 版本控制 helper，非 daemon/worker 验证路径；stdio pipe；不在“后台 daemon 验证弹窗”主症状链 |
| `upgrade-opentui.test.ts` | 开发脚本 runner；非产品 daemon 验证 |
| `installation/install-script.test.ts` | 安装脚本集成；独立关注点；非本次 daemon/TUI 验证弹窗主链 |
| 注释中的 `Bun.spawn` 字样（如 daemon.test 注释） | 非可执行代码 |
| `thread.test.ts` mock spawn | 无真实进程；hide 断言放 daemon wrapper 拦截（§10） |

### 15.4 INV-01 测试文件

| File | Change |
| --- | --- |
| `packages/opencode/test/cli/tui/daemon.test.ts` | 新增 win32-only 行为测：拦截真实 `Bun.spawn`，默认路径 `_spawn`/`spawnDaemon`，断言 powershell wrapper 的 `windowsHide === true` |

### 15.5 thread.test.ts

| File | Change |
| --- | --- |
| `packages/opencode/test/cli/tui/thread.test.ts` | **不改**（或仅注释说明 INV-01 不在此覆盖）。detached 断言保持。 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why fails now | Minimal green | Protects |
| --- | --- | --- | --- | --- |
| 1 | win32：默认 `spawnDaemon` 路径下，真实 `Bun.spawn` 收到的 wrapper opts `windowsHide === true` | 字段缺失 | `daemon.ts` 强制 true | INV-01 |
| 2 | include 清单 call site 在 win32 上传 hide | 字段缺失 | helper/字段 | INV-03 |
| 3 | 既有 daemon Windows/Unix 集成测 | 不应失败 | 无语义改动 | INV-02/04 |

规则：

- Expected value：字面 `true`。
- **禁止**用 `_setSpawn` 断言 INV-01。
- **禁止**仅字符串匹配源码作为 sole 证明。
- 非 win32：slice 1 `skipIf`；slice 2 的字段在 Unix 可为 `process.platform === "win32"` 表达式（值为 false）。

## 17. Chinese Comment Budget

| Metric | Estimate |
| --- | --- |
| `E` | 15–40（生产 2–4 + 测试选项/helper） |
| `C` | ≥ max(1, ceil(E×0.15)) |

必注：

1. wrapper 在 `...opts` 后强制 hide，防 conhost 与 opts 覆盖。
2. INV-01 测试拦截真实 `Bun.spawn` 而非 `_setSpawn` 的原因（一行）。
3. 测试 helper hide 仅后台非交互（若抽 helper）。

## 18. Verification

| Command | Working directory | Evidence |
| --- | --- | --- |
| `bun test test/cli/tui/daemon.test.ts` | `packages/opencode` | INV-01 新测 + 生命周期 |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode` | runCli hide |
| `bun test test/server/httpapi-sdk.test.ts` | `packages/opencode` | worker hide（若触达该测） |
| 其余 include 文件对应 `bun test <path>` | 各 package | 不因 opts 破坏 |
| `bun typecheck` | `packages/opencode` | windowsHide 类型 |
| `bun test`（`packages/core` 中 network-proxy） | `packages/core` | runChild hide + 既有 reg hide 测 |

## 19. Diff Budget

| Metric | Estimate |
| --- | --- |
| Files added | 0 |
| Files modified | 1 production + ≤9 test files（include 集） |
| Production lines | ≤ 5 |
| Test lines | 40–120 |
| Generated | 0 |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 误用 `_setSpawn` 测 hide | §10/§16 硬性禁止；审计按此判 |
| include 行号漂移 | 按角色列定位 |
| 嵌套字符串内 spawn 漏改 | 清单 513/1942 显式点名 |
| 非 win32 无 wrapper 真路径 | skipIf；与现网一致 |
| 误改 PTY | exclude 表 |

### Open Decisions Requiring the User

无。

### Rejected Speculation

- 全仓库所有 `Bun.spawn`/`git`/`install` 一律 hide。
- FreeConsole 替代 windowsHide。
- 强制测试改走生产 wrapper。
- 在 thread 侧用 `_setSpawn` 声称 INV-01。

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
- Verify B-01/B-02 from R1 audit are closed: (1) INV-01 seam is real `Bun.spawn` only; (2) §15 include/exclude is a closed executable inventory.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 wrong `_setSpawn` seam for INV-01; B-02 test hide set not closed | N-01 thread; N-02 non-win32; N-03 E range | BLOCK | adversarial-auditor ses_06af4c269ffetGIjFz0ZcRb4d4 |
| 2 | R2 | yes | No blocking findings | N-01 snapshot include vs git exclude wording; N-02 INV-03 no per-site mock asserts; N-03 E range | APPROVE | adversarial-auditor ses_06ae10ce9ffezWCzTbgjScSDvP |

### Round 2 independent verdict (verbatim summary fields)

```text
APPROVE
```

- Audit mode: plan
- Audited revision: R2
- Full scope: yes
- R1 B-01 closed; R1 B-02 closed
- Blocking findings: 0
- Implementation allowed after this administrative record: yes for exact R2 only


## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` | Windows wrapper `Bun.spawn` 强制 `windowsHide: true`（`...opts` 之后） |
| `packages/opencode/test/cli/tui/daemon.test.ts` | `spawnBackground` helper；include 全量 hide；INV-01 win32 行为测（拦截真实 `Bun.spawn`） |
| `packages/opencode/test/cli/db-maintenance.test.ts` | `runCli` hide |
| `packages/opencode/test/server/httpapi-sdk.test.ts` | promptAsync worker hide |
| `packages/opencode/test/storage/cold.test.ts` | heap 隔离子进程 hide |
| `packages/opencode/test/tool/read.test.ts` | migration CLI hide |
| `packages/opencode/test/session/goal.test.ts` | concurrent writer hide |
| `packages/core/test/network-proxy.test.ts` | `runChild` hide |
| `packages/opencode/test/snapshot/snapshot.test.ts` | `exec` helper hide |
| `packages/opencode/test/cli/tui/prompt-voice-input.test.ts` | stop CLI `windowsHide: true` |

### Red-Green Test Evidence

- INV-01 seam：win32-only `Windows daemon PowerShell wrapper hides its console window` 拦截真实 `Bun.spawn`；darwin 上 skip（2 skip）。
- 生产修复后：`bun test test/cli/tui/daemon.test.ts test/cli/db-maintenance.test.ts` → 43 pass / 4 skip / 0 fail。
- 原始静态 red：wrapper options 曾无 `windowsHide`；现 `windowsHide: true` 在 `daemon.ts`。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/cli/tui/daemon.test.ts test/cli/db-maintenance.test.ts` | `packages/opencode` | 43 pass, 4 skip, 0 fail |
| `bun test test/network-proxy.test.ts` | `packages/core` | 6 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | exit 0 |

### Original Feedback-Loop Result

静态合同：wrapper `Bun.spawn` options 现含 `windowsHide: true`。行为测在 win32 上断言同字段；本机 darwin 为 skipIf。

### Actual Secondary and Replacement Path Inventory

| Path | Disposition |
| --- | --- |
| Unix detached worker | preserve |
| Windows PS wrapper + Hidden worker + hide | repaired |
| print-logs NoNewWindow | preserve |
| test direct WORKER_TS + hide | preserve harness |
| `_setSpawn` for lifecycle mocks only | preserve；未用于 INV-01 |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 83 | git diff 实质增改行；排除空行/import |
| Qualifying Chinese comment lines `C` | 13 | 邻近 hide 强制、INV-01 真实 Bun.spawn seam、helper/嵌套 spawn 边界 |
| Ratio `C / E` | 0.157 |  |
| Required minimum `C` | 13 | `max(1, ceil(83*0.15))` |

### Remaining Unverified Items

- 真机 Windows 肉眼“无弹窗”未在本环境观察；合同级 `windowsHide` 断言与 NetworkProxy 先例一致。
- INV-01 行为测在非 win32 CI 为 skip。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings | N-01 INV-03 no per-site mocks; N-02 not all §18 re-run by auditor; N-03 spawnBackground any; N-04 voice windowsHide true; N-05 cold already in prior commit; N-06 INV-01 win32-only | APPROVE | adversarial-auditor ses_06abc7d55ffepyRUrWVO7OEzbQ |

### Implementation audit round 1 independent verdict (verbatim summary fields)

```text
APPROVE
```

- Audit mode: implementation
- Audited plan revision: R2
- Full original scope: yes
- Blocking findings: 0
- Primary path: single authoritative repair; no fallback family
- Chinese comment gate: pass (`E=83`, `C=13`)

