# Session 取消时序与工具终止设计

## 0. 文档状态

- 状态：第四轮候选设计，等待完整独立审计；未获放行，不允许据此实施。
- 文档职责：本文件是本次 Session 取消时序问题唯一的方案文档。
- 实施上限：最多修改 6 个源码文件和 6 个既有测试文件，不新增文件，不改公开 API，不生成 SDK，总改动必须低于 1000 行，目标为 250 至 450 行源码与测试净改动。
- 非本设计文档：`notice`、elapsed notice、取证报告、`docs/Proposal/` 和 `docs/prompts.md` 不属于本方案，不由本任务修改。

## 1. 问题与目标

用户取消正在运行的 Session 后，旧 Runner 会先发布 `Idle`，再等待工具及 finalizer 完成。当前 `SessionPrompt.cancel` 使用一个覆盖完整取消过程的 semaphore。第二次取消在 semaphore 后排队；旧取消完成后，第二次取消重新读取当前 Runner。若用户已提交新消息并启动 replacement loop，第二次取消会错误地选中 replacement Runner。工具等待 Processor 的两秒兜底，会扩大这个错误窗口。

本设计只解决两个已经通过最小反馈环复现的问题：

1. 同一 Session 的重叠取消必须共享同一个取消操作，不能重新选中 replacement Runner。
2. 普通非 Bash Tool 的 Effect 包装必须响应相同的 AbortSignal，不应在可协作路径上固定消耗两秒 Processor 兜底。

本设计不承诺消除所有独立的进程、BackgroundJob 或插件原生副作用延迟。那些问题会被明确保留为残余风险，但不能再导致重叠取消误伤 replacement Runner。

## 2. 调研范围与已确认事实

### 2.1 已检查链路

调研覆盖以下生产链和测试链：

- TUI、Web、ACP、workspace 与 HTTP abort 调用。
- `SessionPrompt` 的 `prompt`、`loop`、`compact`、`command`、`shell`、`cancel` 与递归修复。
- `SessionRunState`、`Runner.ensureRunning`、`Runner.cancel` 与 shell 状态。
- local/plugin Tool、Question、Plan、Bash、MCP、Processor ToolPart 状态与事件。
- direct shell、`CrossSpawnSpawner`、BackgroundJob、background Task 与 child Session。
- HTTP schema、JS SDK 生成入口、数据库记录、相关测试与 Git 历史。

### 2.2 已复现事实

- Runner + semaphore 的内联实验可稳定复现排队 cancel 误伤 replacement，20 次运行复现 20 次。
- `Runner.cancel` 的 early-Idle 是已有显式契约，相关测试要求 Idle 在旧 finalizer 完成前发布，不能通过延后 Idle 修复。
- pending assistant ID 快照只能保护一次取消，不能阻止第二个排队取消重新选取 Runner。
- 当前 pending Tool cleanup 的两秒等待来自 `ABORTED_TOOL_SETTLE_TIMEOUT`；无 Tool 对照没有同等延迟。
- Effect v4 `runPromise(effect, { signal })` 可以在 AbortSignal 后迅速中断 Effect 包装并运行 finalizer，即使底层原生 Promise 之后才结束。
- AI Bash 已有协作式终止、输出 drain、截断与 `user_abort` 结果语义，不能使用普通 Tool 的立即 wrapper interruption。
- MCP 当前未把 Tool 执行的 AbortSignal 传给 `client.callTool`。
- direct shell 的三秒强杀等待和 escaped descendant 持有继承管道，是独立的进程关闭问题。
- BackgroundJob 当前等待全部 finalizer；提前返回会破坏 Session removal 和 `task_status` 的所有权语义。

### 2.3 根因

根因不是 Ctrl-C 或 TERM 本身必然需要一至两秒，而是三个边界组合后形成的时序窗口：

1. Session 取消没有 single-flight 操作身份，排队调用会重新执行目标选择。
2. 新 admission 与 Runner publication 之间没有原子租约，单纯检查“是否正在取消”仍存在 check-then-act 窗口。
3. 普通 Tool 的 Effect/Promise 边界没有使用已有 AbortSignal，使 Processor 更常走两秒兜底，放大旧取消仍在运行的时间。

## 3. 设计原则与不变量

### 3.1 设计原则

- 用 SessionPrompt 私有状态解决 SessionPrompt 的并发问题，不新增公共 coordinator、generation API 或协议状态。
- 锁只保护短时元数据更新，不在锁内等待 Runner、Deferred、持久化或外部 I/O。
- 取消操作、admission 和 Tool terminal transition 都必须有唯一 winner。
- 保持当前 API、错误字符串、Runner early-Idle、Bash 输出、BackgroundJob 状态和客户端交互语义。
- 对没有直接因果关系的问题诚实记录，不把它们捆入本次最小修复。

### 3.2 必须保持的不变量

1. 同一 Session 同时只有一个 active cancellation operation。
2. 观察到该 operation 的所有 cancel caller 都得到同一个完整 `Exit`。
3. 第一个 HTTP waiter 被中断不能中断 operation 本身。
4. cancellation operation 完成前，新 admission 不能越过 gate。
5. admission 对 Runner 的所有权在任何时刻都由“未发布 lease”或“已安装 Runner”之一表示，不能两者皆无。
6. cancellation failure 必须阻止新 admission，直到后续显式 cancel 成功重试。
7. cancel 不得在旧 operation 完成后自动创建第二次 cancellation 并重新选取 replacement Runner。
8. ToolPart terminal state 只能由一个 transition 赢得；late metadata、late result 和 cleanup 不得重新打开或覆盖它。
9. Tool terminal DB 写入和对应 stream event 之间不能暴露 cancellation interruption 窗口。
10. Processor cleanup 产生的 aborted ToolPart 继续不发布新的 Tool Failed event。

## 4. 总体架构

设计由三个局部机制组成：

1. SessionPrompt cancellation gate：为每个 Session 保存 active cancellation identity 和 admission leases。
2. 可中断 Tool bridge：普通非 Bash Tool 和 MCP 使用执行上下文的同一个 AbortSignal。
3. Processor terminal ownership：串行化 ToolPart 状态转换，并固定 DB、settlement 与 event 的提交边界。

三个机制均为现有模块的私有实现细节，不改变 HTTP、SDK、plugin hook 或数据库 schema。

## 5. Session Cancellation Gate

### 5.1 Gate 生命周期与状态

`SessionPrompt` 保留一个按 Session ID 索引的私有 gate。gate 与当前 `cancelLocks` 一样存活至 SessionPrompt layer 结束，不实施删除和引用计数，避免 gate 删除期间创建两个并发实例。

每个 gate 只包含：

- 一个短时 semaphore。
- 可选 active cancellation entry。
- 当前尚未发布 Runner 的 admission lease 集合。

active entry 持有唯一 identity 和 `Deferred<Exit>`。所有字段只在短时 semaphore 内修改；任何 `Deferred.await`、Runner cancellation、child cancellation 和持久化均在锁外执行。

### 5.2 Cancellation single-flight

显式 cancel 在 gate 锁内执行以下选择：

- 没有 active entry：安装新 entry，在 SessionPrompt 长生命周期 scope 内 fork 唯一 cancellation body，并等待其 Deferred。
- active entry 正在运行：取得同一个 Deferred，锁外等待并重放同一 `Exit`。
- active entry 已失败：本次显式调用以新 identity 替换它并启动重试。普通 admission 不具备该权限。

cancellation body 的最终状态转换不可中断：

- 成功时，在同一次 gate 临界区中校验 identity、清除 active entry并完成 Deferred。
- typed failure、defect 或 scope interruption 时，保留已完成的 failed entry 并完成 Deferred。新 admission 读取该 failure 后直接失败，不自行循环重试。

operation 由 SessionPrompt scope 持有，因此第一个 HTTP 请求或调用 fiber 被中断不会终止操作。scope 关闭会中断 operation，但 finalizer 仍必须用 interruption Exit 完成 Deferred，不能留下永久 pending entry。

### 5.3 Admission lease

`prompt`、公开 `loop`、`compact`、direct shell 和 `noReply` 在修改 Session 或启动 Runner 前取得 admission lease：

- gate 无 active cancellation 时，注册 lease 后继续。
- cancellation 正在运行时，锁外等待其 Exit；成功后重新尝试 admission，失败则向调用方重放 failure。
- lease 包含 readiness Deferred 和幂等 publish/finalize 操作。
- publish 在 gate 锁内移除 lease并完成 readiness。
- admission 外层 finalizer 无条件 publish，保证 setup error 和 shell BusyError 不会让 cancellation 永久等待。

cancellation 在 gate 锁内快照当时的 lease，锁外等待这些 lease 发布，然后才选择 Runner。新 admission 因 active entry 已安装而不能加入。

### 5.4 Runner publication

`Runner.ensureRunning` 接受一个可选私有 ready Effect。该 Effect 不在 `SynchronizedRef.modifyEffect` 的状态计算阶段执行，而是组成其返回的 Effect value。`SynchronizedRef` 先提交 `Running` 或 `ShellThenRun` 状态，再 flatten 返回值并执行 ready，因此 cancellation 不会观察到“lease 已移除但 Runner 尚未安装”。

`SessionRunState.ensureRunning` 只透传该私有 Effect。现有 Runner 完成、join、failure 和 early-Idle 顺序保持不变。

direct shell 在 Shell state 已建立后发布 gate readiness；现有 shell setup latch 继续服务于 `Runner.stopShell`，两者不合并。若 `startShell` 在 BusyError 路径提前失败，admission finalizer 发布 gate readiness。

### 5.5 单次 admission 的调用结构

为避免嵌套 admission 死锁，`SessionPrompt` 将 Runner 启动主体保留为私有 `loopImpl(input, ready)`：

- 公开 `loop` 获取一个 lease，调用 `loopImpl` 并把同一 readiness 传给 Runner。
- 正常 reply-producing `prompt` 获取一个 lease，完成 user Message 准备后直接调用 `loopImpl`，不再调用会二次 admission 的公开 `loop`。
- `noReply` 只持有一个有限 persistence lease，在 Message、Part 和 request usage 全部持久化后发布，不调用 `loopImpl`。
- `compact` 和 direct shell 各自只有一个 lease。
- `command` 的预处理不伪装成 Runner ownership；若调用 `prompt`，由 `prompt` 获取唯一 lease。

### 5.6 Child Session 取消

parent cancellation 不能在 parent Runner finalizer 已取消 child 后，再无条件发起第二次 child cancel，否则会把同一 retarget 问题移动到 child Session。

完整顺序为：

1. 等待 parent cancellation 捕获的 admission leases 发布。
2. 枚举当前 child Sessions。
3. 对每个 child 调用内部 select-or-join，原子安装或加入其 gated cancellation，并保存这些确定的 operation handles；启动后暂不逐个等待。
4. 调用现有 `SessionRunState.cancel(parent)`，中断 parent Runner 和 BackgroundJobs。
5. foreground Task finalizer 若调用 child cancel，只会加入步骤 3 已选择的同一 operation。
6. 等待步骤 3 保存的 operation handles，不重新查询并发起第二轮 child cancel。
7. 对 parent 当前所有仍 open 的 assistant ToolParts 执行持久化修复。

由 foreground Task 在枚举后才创建的 child，继续由该 Task 已有 release 路径负责取消；parent traversal 不进行可能误伤 replacement 的二次全量扫描。独立外部并发创建的 child 不属于本次 parent cancellation 的线性化成员。

## 6. Tool Abort Bridge

### 6.1 EffectBridge

`EffectBridge.promise` 增加可选 `Effect.RunOptions` 参数，并原样传给 `Effect.runPromise`。现有未传 options 的调用保持兼容，不改变返回类型和错误映射。

### 6.2 Local 与 plugin Tool

SessionPrompt 的 Tool adapter 对所有非 Bash Tool 调用：

```text
EffectBridge.promise(effect, { signal: options.abortSignal })
```

AbortSignal 中断 Effect wrapper并执行 Effect finalizer。底层插件原生 Promise 仍可能晚到或产生插件自有外部副作用，但已中断的 Effect continuation 不再提交 metadata、result 或 Processor event。

Bash 明确豁免。Bash 继续使用自身 signal 处理 TERM/KILL、output drain、sink close、truncation 和 `user_abort`，并返回当前 completed partial-output 结果。

Question 与 `plan_exit` 走普通非 Bash 路径。它们的 `Question.ask` finalizer 必须在 wrapper 中断时删除 pending request，不能遗留无法回答的交互项。

### 6.3 MCP

MCP Tool 同时执行两个动作：

- 外层 Effect bridge 使用 Tool context 的 AbortSignal。
- `client.callTool` 接收完全相同的 AbortSignal。

现有 timeout 和 `resetTimeoutOnProgress: true` 保持不变。不得导出私有 `convertMcpTool` 作为测试接口。

## 7. Processor Terminal Ownership

### 7.1 Mutation permit

每个 Processor 实例增加一个 Effect semaphore，保护 tool-call map 与 persisted ToolPart 的 read-check-write transition。以下规则是强制的：

- payload normalization、错误格式化和输出处理在 permit 外完成。
- permit 内重新读取最新 ToolPart；terminal 状态直接判定为 loser。
- permit 内执行 terminal DB write、同步 ownership/blocked 更新和 settle/remove。
- 不在 permit 内等待 Tool Deferred。
- 可能重新进入 Tool 状态逻辑或等待用户的 accounting 不在 permit 内执行。

metadata 和 running update 也通过同一 permit 重读状态；terminal winner 产生后，late metadata 成为 no-op。

### 7.2 Stream terminal commit

真实 `tool-result` 与 `tool-error` 使用下列精确边界：

1. 在可中断区域完成 normalization。
2. 进入 `Effect.uninterruptibleMask`。
3. 获取 mutation permit。
4. 重读状态并决定唯一 winner。
5. winner 持久化 terminal ToolPart，settle/remove map entry，更新纯同步 ownership 状态。
6. 释放 permit。
7. 在恢复可中断性前发布现有对应 Tool Success 或 Tool Failed event。
8. 恢复可中断性。
9. 执行 consecutive-error accounting、reviewer 或 `permission.ask` 等后续行为。

event 不在 permit 内发布，避免 event handler 重入死锁；但 DB write 到 event publish 的连续段整体不可中断。若 event publication defect，DB 保持 terminal，Processor 失败，cleanup 重读后不得覆盖该状态。

任何可能等待用户的 `permission.ask` 必须同时位于 permit 和 uninterruptible region 之外，取消不能因 doom-loop accounting 无限等待。

### 7.3 Cleanup policy

cleanup 先在 permit 外等待 pending Tool Deferred。两秒后仍未完成的 Tool 使用同一 terminal state transition primitive，但事件策略不同：

- 写入当前既有 interrupted/error ToolPart。
- settle/remove ownership。
- 不发布 Tool Success 或 Tool Failed event，保持当前可观察行为。

`ABORTED_TOOL_SETTLE_TIMEOUT = "2 seconds"` 保留为真正非协作 provider 的兜底，不通过缩短常量掩盖所有权问题。所有现有错误字符串保持不变。

## 8. 文件范围与改动预算

### 8.1 源码文件

只允许修改以下 6 个既有文件：

1. `packages/opencode/src/session/prompt.ts`
2. `packages/opencode/src/session/run-state.ts`
3. `packages/opencode/src/effect/runner.ts`
4. `packages/opencode/src/effect/bridge.ts`
5. `packages/opencode/src/session/processor.ts`
6. `packages/opencode/src/mcp/index.ts`

不得修改 process、shell Tool、BackgroundJob、Task、HTTP、客户端、SDK、schema、配置或数据库文件。

### 8.2 测试文件

只扩展以下 4 个既有文件：

1. `packages/opencode/test/session/prompt.test.ts`
2. `packages/opencode/test/effect/runner.test.ts`
3. `packages/opencode/test/session/processor-effect.test.ts`
4. `packages/opencode/test/server/httpapi-mcp.test.ts`

不得新增 fixture 文件或导出 production test hook。若实现前估算超过 6 个源码文件、6 个测试文件或 1000 行，必须停止并重新审议，不得静默扩张。

## 9. 验证设计

### 9.1 Session 与 admission

`prompt.test.ts` 增加确定性同步点，不使用时间碰运气：

- 两次 cancel + replacement：旧 operation 在 early Idle 后暂停；replacement admission 等待；第二次 cancel 必须加入旧 Exit，旧 operation 完成后 replacement 才启动且不被第二次取消。
- prompt 已取得 lease、尚未进入 Runner 时开始 cancel，验证没有死锁且不会出现 publication gap。
- 中断第一个 cancel waiter，第二个 waiter 仍获得 detached operation 的真实 Exit，持久化修复完成。
- cancellation body failure 后 admission 重放 failure；后续显式 cancel 重试成功后才允许 admission。
- SessionPrompt scope 在 cancellation active 时关闭，已持有 waiter 收到 interruption Exit，不永久 pending。
- prompt 在 `ensureRunning` 前 setup failure，cancel 仍完成且后续 admission 可用。
- direct shell BusyError 在 `shellImpl` 前失败，captured lease 被 finalizer 发布，cancel 不挂起。
- foreground Task child cancellation 已被 parent 预选择；Task finalizer join 同一 child operation，replacement child 不被第二次 cancel 误伤。
- 普通非 Bash Tool 进入原生 Promise 后取消，取消耗时显著低于两秒；原生 Promise 晚到后不能写 metadata、result、event 或 ToolPart。
- Question 与 `plan_exit` pending request 在取消后被移除，ToolPart 使用现有 interrupted error，late answer 不能重开。

### 9.2 Runner

`runner.test.ts` 验证：

- Running/ShellThenRun state 已安装后才执行 readiness。
- readiness effect/finalizer 的 failure path 不改变 Runner 原有 Exit。
- 现有 early-Idle 测试保持原样并继续通过。

SessionPrompt setup failure 和 shell BusyError 的 lease 释放不放在 Runner 单元测试中代替，必须由 9.1 的集成测试覆盖。

### 9.3 Processor

`processor-effect.test.ts` 验证：

- interrupt 精确发生在 terminal DB write 后、event publish 前，最终仍有匹配 event，ToolPart 保持 terminal。
- late metadata、late result 与 cleanup 不能覆盖 terminal winner。
- cleanup aborted ToolPart 不新增 Tool Failed event。
- 真正非协作 provider 仍走两秒 fallback。
- Tool failure 进入 consecutive-error accounting 并停在 `permission.ask` 时，Processor cancel 不等待该请求。

非 Bash bridge 的端到端低延迟验证属于 `prompt.test.ts`，不能用 Processor 单元测试替代。

### 9.4 MCP

扩展现有 `httpapi-mcp.test.ts`，通过公开 MCP Service 的发现/执行边界和 in-process transport 捕获 `client.callTool` options，验证：

- `signal === options.abortSignal`。
- timeout 值保持不变。
- `resetTimeoutOnProgress === true`。
- abort 后晚到响应不能重新提交 Tool 状态。

不得直接测试或导出私有 `convertMcpTool`。

### 9.5 验证命令

所有命令从 package 目录运行，禁止从仓库根运行测试：

```bash
cd packages/opencode
bun test test/session/prompt.test.ts
bun test test/effect/runner.test.ts
bun test test/session/processor-effect.test.ts
bun test test/server/httpapi-mcp.test.ts
bun typecheck
```

本设计不修改 `packages/core`，因此不要求 core typecheck 或测试。实施完成后检查 git diff，确认文件数和行数门禁。

## 10. 兼容性与失败语义

以下行为必须保持：

- `Runner.cancel` 继续先发布 Idle，再等待旧 finalizer 完成。
- repeated ESC 继续保持 armed。
- HTTP abort 继续返回 boolean，missing Session 继续 no-op。
- 客户端 fire-and-forget draft UX、ACP awaited abort 与 workspace 行为不改。
- direct shell 保持当前三秒 `forceKillAfter`、输出和错误行为。
- Bash 保持 partial output、truncation 和 completed `user_abort`。
- Processor 保持两秒 fallback 与全部现有 Tool error 字符串。
- cleanup abort 不新增 Tool Failed event。
- BackgroundJob status、Task completion timing和 Session removal 行为不改。
- plugin hook/public Tool context 不改，不生成 OpenAPI 或 JS SDK。

失败语义：

- cancellation typed failure、defect 或 scope interruption完整传播给所有 joiners。
- failed gate 阻止 admission，直到后续显式 retry。
- child cancellation failure 使 parent cancellation failure，并保留 parent/child failure fence。
- event publication defect 不回滚已提交 terminal ToolPart，也不允许 cleanup 重写。
- 原生 plugin Promise 的业务副作用不可事务回滚；本设计只保证它不能晚到后重新进入 Session/Processor commit。

## 11. 明确非目标与残余风险

### 11.1 Process close

escaped descendant 可以持有继承 stdout/stderr，导致 `CrossSpawnSpawner` 在 KILL 后仍等待 close。安全修复需要定义 standard/additional fd、input producer、EOF、error 和 scope release 语义，并修改 core 文件。本次不修改它。gate 会保持 active，因此延迟仍可能存在，但重叠 cancel 不会误伤 replacement。

### 11.2 Direct shell

direct shell 的三秒强杀窗口保持不变。它是延迟问题，不是重叠 cancel 重新选取 Runner 的根因。若未来优化，必须单独设计并验证进程树和输出保留。

### 11.3 BackgroundJob 与 Task continuation

held finalizer 仍会让 BackgroundJob cancellation 等待；提前返回会破坏现有资源所有权。background Task 的 detached parent resume 也保留当前语义，不能声称本设计禁止所有 cancellation 后的后台自动恢复。安全调整需要 BackgroundJob/Task 的原子 completion ownership，并可能改变 `task_status`，不纳入本次 6 文件修复。

### 11.4 Session hierarchy

parent cancellation 枚举之后，由独立外部请求创建的新 child 不属于该 operation 的树成员。本设计没有引入全局 hierarchy transaction 或 generation model。

## 12. 实施顺序与门禁

1. 先在 4 个既有测试文件中建立可重复红灯，确认每个同步点确实命中目标窗口。
2. 实现 gate、single-flight、单次 admission 和 child preselection。
3. 实现 Runner readiness publication，不改变 early-Idle。
4. 实现 EffectBridge signal 和 MCP exact signal，保持 Bash 豁免。
5. 实现 Processor permit、uninterruptible DB/event commit 和 cleanup event policy。
6. 运行窄测试，再运行 `packages/opencode` typecheck。
7. 检查只修改 6 个源码、4 个测试文件，无新增文件，总改动低于 1000 行。
8. 对完整问题范围进行独立 sub-agent 审计。任何阻塞意见都使当前设计失效，必须整体更新本文件后重新全范围审计，最多 6 轮。

## 13. 放行标准

只有同时满足以下条件，状态才能从“候选设计”改为“允许实施”：

- 至少一轮完整独立审计明确 `PASS`，没有 correctness、compatibility、cleanup、failure、test 或 scope blocker。
- 所有审计要求已融入本文整体设计，而不是附加补丁清单。
- 实施范围仍为 6 个源码文件、4 个既有测试文件且低于 1000 行。
- process、BackgroundJob、Task、客户端和 API 等非目标没有被暗中修改。
- 用户明确批准进入实施阶段。

## 14. 推荐摘要

推荐采用“SessionPrompt 私有 single-flight gate + admission lease + 普通 Tool AbortSignal bridge + Processor terminal ownership”的组合。它直接覆盖已复现的 replacement retarget race 和普通 Tool 两秒等待放大器，同时保留 Runner、Bash、BackgroundJob、HTTP 与 SDK 的既有契约。相比 coordinator、generation registry、客户端 barrier 或 process 全面重构，本设计使用现有模块边界，文件范围固定，失败语义明确，是当前约束下最小且可验证的安全方案。
