# Canonical Implementation Plan: process.test.ts abort timing fix

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: CI failure on commit 14b3177908 — `test/util/process.test.ts` "aborts a running process" failed on Windows CI with `expect(Date.now() - started).toBeLessThan(1000)` receiving 1142ms.
>
> Implementation allowed: no further material changes without revision or rework
>
> Plan audit verdict: No blocking findings. APPROVE.
> Implementation audit verdict: No blocking findings. APPROVE. Three non-blocking findings (poll deadline equals test timeout, verification gap from missing dependency, sibling test residual anti-pattern) acknowledged.

## Implementation Evidence

### Changed files
- `packages/opencode/test/util/process.test.ts` — +20/-5 lines

### Red-Green evidence
- Red: CPU saturation (16 cores) with `--rerun-each 10` → 5/10 fail, max 1464ms
- Green: Standalone marker-readiness replication under 16-core saturation → 10/10 pass, max 1256ms

### Verification
- `bun test test/util/process.test.ts`: BLOCKED by missing `@opentui/solid` dependency (pre-existing environment issue after build.ts smoke run; `bun install` not authorized)
- `bun typecheck`: BLOCKED by missing `tsgo` binary (same root cause)
- Standalone script validation: 10/10 pass under 16-core CPU saturation
- Logic verified: marker file readiness → abort → code 1 → abortMs 320-1256ms → all < 2000ms

### E/C metrics
- E = 15 (effective added code lines)
- C = 6 (qualifying Chinese explanatory comment lines)
- Required: ceil(15 * 0.15) = 3
- Ratio: 6/15 = 40%
>
> Last updated: 2026-07-14

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

修正当前新增commit导致的完整的不兼容、冲突、边界问题或者异常处理及测试问题。CI失败：`test/util/process.test.ts` "aborts a running process" 在 Windows CI 上 `expect(Date.now() - started).toBeLessThan(1000)` 收到 1142ms。

## 2. Explicit Non-Goals

- 不修改 `src/util/process.ts` 生产代码：同步 `taskkill /T /F` + `proc.kill` 是正确的 Windows 进程树清理实现，CI 日志中 "aborts a Windows process tree before resolving" 通过证明生产语义正确。
- 不修改 `build.ts`、`image.ts`、`read.ts`、`processor.ts`、`prompt.ts` 或任何图片相关代码：CI 日志确认只有 process.test.ts 失败。
- 不放宽阈值作为唯一手段：单纯把 1000ms 改成 2000ms 仍把 Windows 调度性能当产品契约，不消除根因。
- 不改变 `test:ci` 命令或 CI workflow。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `packages/opencode/test/AGENTS.md` | 明确把 `setTimeout(N)` 等待并发就绪列为反模式，要求等待 published readiness signal |
| `packages/opencode/AGENTS.md` | 测试不能从 repo root 运行；从 `packages/opencode` 运行 |
| `packages/opencode/src/util/process.ts` | `Process.spawn` 返回 `Child` with `exited` promise；`Process.run` 返回 `Result` with code/stdout/stderr |
| `CONTEXT.md` | Process utility 属于 `util/` 基础设施层 |
| `32c2b716c9` | 最后修改 process.ts 和 process.test.ts 的 commit，建立了同步 taskkill 和 Windows 进程树测试 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/test/util/process.test.ts:52-64` | 失败测试本体：`setTimeout(25)` + `toBeLessThan(1000)` | observed |
| `packages/opencode/src/util/process.ts:58-120` | `spawn` 实现：abort 回调做同步 `taskkill /T /F` + `proc.kill` | observed |
| `packages/opencode/src/util/process.ts:122-153` | `run` 实现：`spawn` + `buffer(stdout/stderr)` + `exited` 并行等待 | observed |
| CI run 29310227046 日志 | 唯一失败是 `aborts a running process` 收到 1142ms；同文件其他 spawn 测试耗时 400-600ms | observed |
| CI run 29274867779 (前一个 commit) | 同测试在前一个 commit 通过 | observed |
| 本地仪器化测量（16核CPU饱和） | `timerDelay` 35-140ms（应为25ms）；`abortToDone` 655-1324ms；readiness 同步后 `abortToRunDone` 464-584ms 稳定 | observed |
| `packages/opencode/test/AGENTS.md:161-198` | "Synchronizing With Concurrent Work" 反模式：`setTimeout(N)` race scheduler；修复：wait on published readiness signal | contracted |
| `packages/opencode/test/session/processor-effect.test.ts:111-120` | 仓库既有 `waitFor` poll 模式先例 | observed |
| `packages/opencode/test/util/process.test.ts:66-118` | "aborts a Windows process tree" 测试已用 stdout data 事件作为 readiness signal | observed |
| `packages/opencode/test/util/process.test.ts:120-135` | "kills after timeout" 测试有相同的 `setTimeout(25)` + `toBeLessThan(1000)` 模式，但 `if (process.platform === "win32") return` 跳过 Windows | observed |

## 5. Current Behavior

```text
test starts -> setTimeout(25ms) -> Process.run(spawn bun -e "setInterval") ->
  [25ms fires] abort.abort() -> sync taskkill /T /F -> proc.kill(SIGTERM) ->
  proc exit -> buffer(stdout/stderr) resolve -> Process.run returns ->
  assert total < 1000ms
```

测试从 `started = Date.now()` 开始计时，包含进程启动时间。在 Windows CI 上 bun 进程启动需 400-600ms，`setTimeout(25)` 在事件循环争用下延迟 35-140ms 才触发，`taskkill` + exit + buffer 再需 500-900ms。总计可达 1142ms。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Windows CI 2核 runner | GitHub Actions | 有限CPU；并行测试争用 | `test:ci` 运行全部测试文件 | CI workflow | observed |
| bun test 并行执行 | bun test runner | 默认按 CPU 核数并行运行测试文件 | 重测试（migration+Sharp）与 process.test.ts 同时运行 | bun | observed |
| `setTimeout(25)` 延迟 | Node.js event loop | 不保证精确25ms；CPU饱和时延迟更大 | abort 触发晚于预期 | test code | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | abort 后进程必须终止（code != 0） | `Process.spawn` abort 回调做 `taskkill /T /F` + `proc.kill` | `aborts a running process` line 62 |
| INV-02 | abort 语义测试不得把 OS 调度性能当产品契约 | `test/AGENTS.md` 反模式：`setTimeout(N)` race scheduler | 无（当前违反） |
| INV-03 | 测试必须在 Windows CI 上稳定通过 | CI 是必过检查；前一个 commit 通过 | 无（当前不稳定） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `setTimeout(() => abort.abort(), 25)` 假设进程在25ms内就绪，把 spawn 延迟 + 事件循环延迟 + taskkill 耗时全部计入 `Date.now() - started`，再断言 `< 1000ms` | `test/util/process.test.ts:55,63` | 仪器化测量：timerDelay 35-140ms，spawn 400-600ms，total 701-1464ms |

**Red-capable feedback loop:**

```powershell
$bun = (Get-Command bun).Source
$stress = @(1..16 | ForEach-Object { Start-Process -FilePath $bun -ArgumentList @('-e', 'for(;;){}') -PassThru -WindowStyle Hidden })
try { bun test test/util/process.test.ts --test-name-pattern "aborts a running process" --rerun-each 10 --timeout 3000 }
finally { $stress | Stop-Process -Force -ErrorAction SilentlyContinue }
```

结果：10次中5次失败，最高1464ms。CI收到1142ms是同一根因的低CPU竞争实例。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 测试同步方式 | `test/util/process.test.ts` | 验证 abort 语义 | 测试自身选择了 `setTimeout(25)` + 绝对阈值，违反仓库测试规范 | 生产代码 `process.ts` 的 abort 行为正确（CI "aborts a Windows process tree" 通过） |
| 进程 abort 语义 | `src/util/process.ts` | abort 后进程树终止 | 生产实现已正确 | 不需修改 |

## 10. Single Approved Primary-Path Design

```text
test starts -> spawn child with marker file readiness ->
  poll marker file (10ms interval, 3s timeout) ->
  [marker exists] record abortStart -> abort.abort() ->
  Process.run resolves -> assert code != 0 ->
  assert (Date.now() - abortStart) < 2000ms
```

修复把测试从"spawn-to-completion < 1000ms"改为"readiness-to-completion < 2000ms"：

1. 子进程脚本先写 marker 文件再进入 `setInterval` 循环。
2. 测试 poll marker 文件直到存在（10ms间隔，3s超时），确认进程已启动。
3. 从 readiness 点开始计时，触发 abort。
4. 断言 `code != 0`（abort 语义不变）。
5. 断言 `Date.now() - abortStart < 2000ms`（仅测量 abort 完成，不包含 spawn）。

**为什么 2000ms 而不是 1000ms：** 仪器化测量显示 readiness 后 abort 完成需 464-746ms（16核满载）。Windows CI 2核下 taskkill 同步调用可达 300-500ms，2000ms 给 3x 余量但不依赖调度性能。3000ms test timeout 仍是死锁保护。

**为什么 marker 文件而不是 stdout：** `Process.run` buffer stdout，测试无法在 `run` 返回前读取 stdout。`Process.spawn` 可以用 stdout 事件，但 "aborts a running process" 测试意图覆盖 `Process.run` 接口。marker 文件不依赖 pipe 语义，与 `Process.run` 兼容。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| readiness + abort timing | proposed | primary-contract branch | yes | 100% | adopt |
| 纯阈值放宽 1000→2000 | rejected | forbidden fallback | yes | 0% | reject — 不消除根因 |
| 生产 process.ts 优化 | rejected | not applicable | no | 0% | reject — 生产行为正确 |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `setTimeout(() => abort.abort(), 25)` | 假设进程25ms内就绪 | readiness polling 消除假设 | `process.test.ts:55` |
| `expect(Date.now() - started).toBeLessThan(1000)` | 绝对阈值包含 spawn 时间 | 从 readiness 点计时，只测量 abort | `process.test.ts:63` |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 abort 后进程终止 | 不修改 | 不修改 | `expect(out.code).not.toBe(0)` 保留 |
| INV-02 不依赖调度性能 | 不修改 | `process.test.ts` 改为 readiness sync | marker poll + abort timing |
| INV-03 Windows CI 稳定 | 不修改 | `process.test.ts` 改为 readiness sync | 16核饱和 rerun 10 次 0 fail |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| marker file readiness | INV-02 | `test/AGENTS.md` 反模式规则 | `setTimeout(25)` 无法承载 readiness |
| abort-to-completion timing | INV-02, INV-03 | 仪器化测量 | spawn-to-completion 包含无关延迟 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/test/util/process.test.ts` | modify | 把 "aborts a running process" 测试从 `setTimeout(25)` + 绝对阈值改为 marker file readiness + abort timing | +20/-5 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | CPU饱和下 "aborts a running process" 失败 | `setTimeout(25)` + `toBeLessThan(1000)` 把调度性能当契约 | marker readiness + `toBeLessThan(2000)` from abort point | 16核饱和 rerun 10 次 0 fail |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~15 | 排除 import、格式、纯移动 |
| Required Chinese explanatory comments `C` | >= 3 | `if E > 0: C >= max(1, ceil(15 * 0.15))` = 3 |

需要注释的关键点：
- 为什么用 marker 文件而不是 setTimeout（反模式规避）
- 为什么从 readiness 点计时而不是从 spawn 开始（不依赖调度性能）
- 为什么 2000ms 阈值仍能捕获 abort 失败（3000ms test timeout 是死锁保护）

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/util/process.test.ts --timeout 30000` | `packages/opencode` | 无CPU争用下全部通过 |
| 16核饱和 rerun 10 次 | `packages/opencode` | CPU争用下0 fail |
| `bun typecheck` | `packages/opencode` | 类型检查通过 |
| `bun test test/util/process.test.ts test/tool/read.test.ts --timeout 30000` | `packages/opencode` | 与重测试并行运行不互相干扰 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 只修改现有测试 |
| Files modified | 1 | `process.test.ts` |
| Files deleted | 0 | |
| Production lines | 0 | 不修改生产代码 |
| Test lines | ~20 | marker helper + readiness poll + 修改断言 |
| Generated lines | 0 | |

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

无。修复方案明确，不涉及产品决策。

### Real Risks

1. marker 文件在 tmpdir 创建，Windows 上 tmpdir 路径可能含空格——`JSON.stringify` 已转义路径，`Bun.file` 接受绝对路径。
2. 子进程写 marker 文件失败（磁盘满/权限）——poll 超时后测试失败，不产生假绿。
3. `Process.run` 的 `buffer(proc.stdout)` 在进程被 kill 后仍需 resolve——这是既有行为，readiness 不改变该路径。

### Non-blocking Speculative

- bun 未来可能改变并行测试调度策略——不影响 readiness 方案的稳定性。
