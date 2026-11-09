# Abort 延迟与新命令竞态修复方案

## 0. 问题

用户按 ESC × 2 取消 agent loop 时，取消延迟 1-2 秒。期间用户输入新命令并回车，
延迟到达的 cancel 会把新命令的 assistant 消息也终态化为 "Aborted"。

## 1. 已阅读文件

- `src/session/processor.ts:34,860-866`：`ABORTED_TOOL_SETTLE_TIMEOUT = "4 seconds"` — cancel 时等待 tool 清理的超时
- `src/session/prompt.ts:417-457`：`cancel` 和 `abortPendingAssistants` — cancel 流程中的 TOCTOU 竞态
- `src/session/run-state.ts:110-118`：`cancelBackgroundJobs` 在 `Fiber.interrupt` 之前串行执行
- `src/effect/runner.ts:171-200`：`Runner.cancel` — 原子设 Idle 后阻塞 `Fiber.interrupt`
- `src/tool/shell.ts:976-1004`：bash 工具 abort 路径 — `handle.kill({ forceKillAfter: "3 seconds" })` + `Fiber.join(output)`
- `src/shell/shell.ts:9,28-57`：代码库自有的 `killTree` 函数 — `SIGKILL_TIMEOUT_MS = 200`，仅 200ms grace period
- `src/util/process.ts:73-92`：底层 process spawn 的 abort 路径 — Windows 用 `taskkill /T /F`（同步即杀）
- `test/session/prompt.test.ts:1669-1720`：现有 cancel 测试模式（fork loop → llm.wait → cancel）

## 2. 根因

### 根因 1：bash 工具 kill 路径无 SIGKILL 升级上限
`shell.ts:993,997` — abort/timeout 时 `handle.kill({ forceKillAfter: "3 seconds" })`。
Effect `ChildProcess.kill` 的 `forceKillAfter` 在 Unix 上是 no-op：它只限制信号发送
（`killProcessGroup` 同步即完成），不限制 `Deferred.await(exitSignal)` 的进程退出等待（无上限）。
进程收到 SIGTERM 后可能需要数秒才退出（清理句柄、停止子进程），kill 阻塞在 exit 等待上。

### 根因 2：4 秒 tool settle 超时被根因 1 的无上限 kill 等待撑大
`processor.ts:34` — `ABORTED_TOOL_SETTLE_TIMEOUT = "4 seconds"` 被设计为覆盖无上限的 kill 等待 + output drain。
根因 1 修复后（500ms bounded kill），settle 超时可安全降至 2s（500ms kill + 500ms drain + 1s 安全边际）。

### 根因 3：TOCTOU 竞态——新命令被吞
`prompt.ts:421-422` — `state.cancel`（设 Idle + 阻塞 Fiber.interrupt）在 `abortPendingAssistants`（终态化所有
pending assistant）之前。两步之间新 prompt 可启动，新 assistant 被 `abortPendingAssistants` 误杀。

### 根因 4：串行 cancelBackgroundJobs
`run-state.ts:111` — `cancelBackgroundJobs` 在 `Fiber.interrupt` 之前串行执行，增加总延迟。

## 3. 方案

### Change 1: bash 工具 kill 路径实现真正的 SIGTERM→bounded wait→SIGKILL
`shell.ts:991-998`：替换 `handle.kill({ forceKillAfter: "3 seconds" })`

Effect `ChildProcess.kill` 的 `forceKillAfter` 在 Unix 上是 **no-op**：它只限制
`killProcessGroup(SIGTERM)` 的信号发送时间（同步即完成），不限制后续
`Deferred.await(exitSignal)` 的进程退出等待（无上限）。实际阻塞来自进程退出等待。

替换为 `Effect.timeoutOrElse` 包裹 `handle.kill()`，实现真正的 bounded kill：
```ts
if (exit.kind === "abort") {
  aborted = true
  // SIGTERM 后等待最多 500ms 进程退出；超时则 SIGKILL 强杀。
  // Effect ChildProcess.kill 的 forceKillAfter 只限制信号发送（Unix 同步即完成），
  // 不限制进程退出等待（Deferred.await(exitSignal) 无上限）。
  // 这里用 timeoutOrElse 包裹 kill，实现 SIGTERM→500ms→SIGKILL 序列，
  // 复用代码库 shell/shell.ts:killTree 的 SIGKILL_TIMEOUT_MS=200 同款语义。
  yield* handle.kill().pipe(
    Effect.timeoutOrElse({
      duration: "500 millis",
      orElse: () => handle.kill({ killSignal: "SIGKILL" }),
    }),
    Effect.orDie,
  )
}
if (exit.kind === "timeout") {
  expired = true
  // timeout 路径同样使用 bounded kill
  yield* handle.kill().pipe(
    Effect.timeoutOrElse({
      duration: "500 millis",
      orElse: () => handle.kill({ killSignal: "SIGKILL" }),
    }),
    Effect.orDie,
  )
}
```

- `handle.kill()` 发送 SIGTERM（默认信号）并等待 `Deferred.await(exitSignal)`
- `timeoutOrElse` 在 500ms 后中断等待，`orElse` 发送 SIGKILL（不可捕获，进程立即退出）
- `handle.kill({ killSignal: "SIGKILL" })` 发送 SIGKILL 并等待退出（~即时）
- 总 kill 时间：≤500ms（SIGTERM 生效则更短）
- 代码库 `shell/shell.ts:killTree` 用 200ms；500ms 是 2.5x 安全边际

### Change 2: ABORTED_TOOL_SETTLE_TIMEOUT 4s → 2s
`processor.ts:34`：`"4 seconds"` → `"2 seconds"`
- 根因 1 修复后，tool 最多 500ms kill + ~500ms drain = 1s
- 2s 给 100% 安全边际
- settle 超时是 per-tool max，并行运行（`concurrency: "unbounded"`），不串行累加

### Change 3: 快照 pending IDs 防竞态
`prompt.ts:417-457`：cancel 中 `state.cancel` 之前快照 pending assistant IDs，传给 `abortPendingAssistants`
作为过滤。递归子会话时不传（子会话无用户输入竞态）。`MessageV2.stream` 是同步生成器，快照原子。

### Change 4: 并行化 cancelBackgroundJobs
`run-state.ts:110-118`：用 `Effect.all` 并行执行 `cancelBackgroundJobs` 和 `existing.cancel`。
两者操作独立的 fiber/resource，都幂等。

## 4. 文件

| 文件 | 改动 |
|------|------|
| `tool/shell.ts` | 2 行（forceKillAfter 值） |
| `session/processor.ts` | 1 行（常量值） |
| `session/prompt.ts` | ~15 行（快照 + 参数） |
| `session/run-state.ts` | ~10 行（并行化） |
| `test/session/prompt.test.ts` | ~40 行（新测试） |

## 5. 预期效果

| 指标 | 修改前 | 修改后 |
|------|--------|--------|
| 取消延迟（有 tool 运行时） | 3-4s+（无上限 kill 等待 + settle 4s） | <1.5s（500ms bounded kill + settle 2s max） |
| 取消延迟（无 tool 运行时） | ~1s（Fiber.interrupt） | ~1s（不变，但 background jobs 并行） |
| 新命令被吞 | 会发生（TOCTOU） | 不会（快照过滤） |
