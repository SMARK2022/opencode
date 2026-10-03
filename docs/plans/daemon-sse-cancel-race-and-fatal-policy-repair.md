# Canonical Implementation Plan: Daemon SSE Cancel 竞态根治与致命错误策略修复

> Status: verified
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（见第 1 节）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-10-03

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 请注意，本身应当准确完整地解决掉相应的竞争静态所导致的误杀或自杀等问题，也就是正常的情况下，本质不应当去进行相应的一个自杀等内容。但是与此同时也应当去兼顾相应的这个有问题的时候的一个重启流程机制，所以本身也就是相应的生命周期应当更加顺畅、完整且准确精准地去进行相应的一个处理，同时不要过度激进地进行一个重启等操作，但是又需要避免在部分 DAEMON 出现卡死等问题的时候，应当去具有一个较好的流程机制，也就是首先而言需要准确地根治这么一个竞争静态问题，同时又不得造成性能下降。然后再去检查相应的这个自杀等等，或者说这个生命周期维护的一个完整流程机制。与此同时，在你进行相应的最终方案经过完成审计之前不得进行方案的实施。

补充上下文（同一调查链中的用户原话）：

> 因为即便是你只是去掉自杀的本质，还会出现静态问题。（意指：仅摘除自杀开关不构成根治，竞态本身必须修掉。）

> 按理来说不应该发生 interrupt 的问题啊，是启动了一个新的 daemon 吗，还是什么情况？（首个症状报告：所有 session 出现 tool execution aborted / interrupted。）

R6 范围变更（第二轮双独立审计后的复核结果，用户原话）：

> 请你派出两个subagent审计一下，让他们各自找，同时汇总相应的共性问题。

> 下面请你根据相应的问题重新回到相应的完整的工作流中，同时生产代码修改个数不超过六个文件，整体生产修改行数不超过一千两百行。

两名全新审计者均 BLOCK，共同 blocker（按根因去重后唯一）：WS8 的 unreachable→force 汇焦未保留 `maintenanceIdle` 条件式停机的授权边界——db.ts:487/604 的 DB 维护调用以 `maintenanceIdle: true` 请求停机，控制面无应答不等于 worker 确认空闲，越过该门禁强杀会中断在跑的维护任务与同进程 session（worker.ts:472-484 的 409 门、daemon.test.ts:1763-1767 的既有合同测试为证）。primary 亲读三处源码与既有测试核实属实，属本次引入（WS8 前 unreachable 一律抛错），采信，不提复议。

R5 范围变更（用户要求双独立审计后的复核结果，用户原话）：

> 请你派出两个subagent审计一下，让他们各自找，同时汇总相应的共性问题。

> 下面请你根据相应的问题重新回到相应的完整的工作流中，同时生产代码修改个数不超过六个文件，整体生产修改行数不超过一千两百行。

两名全新独立审计者（互不通信）均 BLOCK，去重后五项共性问题（第 22 节记录逐项核实过程）：B-01 `daemon stop` 在控制面无响应时抛错、force 路径不可达（daemon.ts:131-134）；B-02 致命错误策略的 unverifiable 理由被既有 spawnHangingDisposerDaemon 隔离子进程设施反证；B-03 `_progressDeadline` 属 policy:485 禁止的 test-only 生产导出；B-04 竞态测试用固定 sleep 猜测就绪/日志完成（违反 test/AGENTS.md）；B-05 acp cancel 清理不可达（SDK ndJsonStream 只 getReader/read/releaseLock，stream.js:17-60）。全部经 primary 亲读源码核实后采信。

R3 范围变更（verified 后用户两条新原话，逐字）：

> 相应的这个独立缺陷呢，我同时也建议你纳入本次的一个问题清单，也需要去被解决的一个东西。（将调查中发现并列入 Non-Goals 的独立缺陷纳入本次范围并解决。）

> 那与此同时请注意一点，如果新模块它只是在辅助另一个东西的一个 helper，本质上应当内联，这是用户的要求，本质上应当内联。因为它你如果只调用一次，那本身就是一个内联就行了，不要再去额外地增加很多这种 policy，它会导致目录树过于扁平化。（R2 的 fatal-policy.ts 单消费者模块设计被用户明确否决，改回 worker.ts 内联。）

## 2. Explicit Non-Goals

- 不改变 daemon 单 owner / SQLite 单写者不变量（`docs/plans/cross-host-daemon-lock-and-db-single-writer.md` R4 已批准约束：unresponsive owner 不得被顶替，防双写 `SQLITE_NOTADB`）。
- 不新增 daemon 卡死自动检测/自动强杀机制——对 unresponsive owner 的自动终止会把"长模型调用"误判成卡死，构成新的误杀（与用户"不要过度激进"的要求直接冲突）。卡死的既有机制是显式 `opencode daemon stop`（graceful → 超时 → owner 复核后 SIGKILL）。
- 不修复 Bun 运行时本身（listen socket 句柄被 Bun.spawn 子进程继承是 Bun 的 Windows 行为，见 §20 D3 决策）。
- 不引入 FFI 句柄遍历（NtQuerySystemInformation）来标记 socket 不可继承——结构体布局版本敏感、失败即 daemon 启动崩溃，与一个"恢复检测延迟 ~90s"的纯延迟性问题不成比例（探针实证见 §8）。
- 不为 TUI 增加 SSE  stall watchdog（心跳是否到达 SDK 消费层受生成代码约束，属另行立项）。
- 不改动 AI SDK（node_modules）内部管道；只修我们自己拥有 controller 的流源。
- 不扩大 Log 关闭接口到 TUI 进程退出路径（TUI 日志丢失无受害证据；daemon 是唯一实证的受害者）。
- 不改变 cancel 语义本身（abort、reader cancel、deadline 清理路径全部保持原样）。
- 不回退 `worker.ts` 既有的 idle/startup/launcher-watcher 定时器设计（本次调查已核实其触发条件均有界且带 fire-time 复查，见第 20 节）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Daemon = `cli/cmd/tui/worker.ts`（共享 daemon 进程，ServerLock 单 owner 模型，见文件末尾 `[local-devsmark][deprecated-rpc-thread]` 注释）；Provider 经 `@ai-sdk` 统一 |
| 根 `AGENTS.md` | 测试不得从仓库根目录运行；typecheck 用 `bun typecheck` 从 package 目录运行 |
| `packages/opencode/AGENTS.md` | 模块形状：flat exports + 文件底部 self-reexport；Effect 规则；测试 fixture 惯例 |
| `packages/opencode/test/AGENTS.md` | 测试 fixture（tmpdir/testEffect）、禁止用 sleep 猜并发就绪（本计划的竞态测试不依赖就绪猜测，依赖同步确定性排序） |
| `docs/plans/cross-host-daemon-lock-and-db-single-writer.md`（R4 approved） | unresponsive daemon 不得被顶替/强杀（单写者保护）；本计划的 WS3 只能在此约束内做"验证与记录"，不能引入自动终止 |
| `docs/plans/daemon-ctrl-c-shutdown-lifecycle.md`（R7 verified） | `daemon stop` 的 graceful→force 策略边界：force 只允许在同一 lock owner 复核后发生，不得从无关失败路径触发 |
| `packages/opencode/src/cli/cmd/tui/daemon.ts` `existingOwnerUrl` 注释 | "unresponsive" = owner 活着但控制面暂时阻塞（如长模型调用），**禁止**此时 spawn 第二个 daemon |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `~/.local/share/opencode/log/2026-10-02T045932.log` 行 20206-20207 | daemon 41064 死亡实证：`ERROR service=default e=Invalid state: Controller is already closed rejection` 紧跟 `INFO service=daemon reason=unhandledRejection hadClient=true sseClients=5 sessionActivity=9 daemon shutting down` | observed |
| 同日志 05:23:53-54 段 | 触发序列：ses_f8b378e68 cancel → provider fetch AbortError（设计内路径）→ 两个 bash tool.end → rejection（竞态路径）→ 自杀 | observed |
| `~/.local/share/opencode/log/2026-10-01T203822.log`（已被 cleanup 删除，删除前已取证） | daemon 36428 于 12:57:59 死亡时日志戛止于正常流式输出；无 shutdown 记录——与 `gracefulShutdown` 末尾 `process.exit(0)` 丢弃未 flush 缓冲一致（同类死亡，尾部证据丢失） | observed |
| 探针 `D:\Temp\opencode\probe-stream-race2.ts` | 默认 hwm + 多 read 预取：cancel 时在途 pull 恢复 done → `ctrl.close()` 抛出与生产完全一致的 `TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed` | observed |
| 探针 `D:\Temp\opencode\probe-stream-race4.ts` | 默认水位 + `pipeThrough` 消费（AI SDK 管道拓扑）：cancel 时源端 pull #2 在飞，恢复后 close 抛同款 TypeError。两探针同时证明：Bun 在简单拓扑下会吞掉该 rejection（不触发 unhandledRejection），生产逃逸依赖更复杂的管道拓扑——因此**源端不抛错是唯一可靠的根治点** | observed |
| Red 运行记录（2026-10-02 06:07 UTC，packages/opencode） | `bun test test/provider/provider.test.ts -t "cancel during in-flight pull"`：未修复代码下 cancel 组合成 `phase=sse.end requestID=42424201`（断言失败输出已捕获），控制组正常 EOF 产生 sse.end——证明测试可判别 | observed |
| `packages/opencode/src/provider/provider.ts` `progressDeadline().wrap()`（218-273 行） | 竞态现场：async `pull(ctrl)` 在 `await read()` 后无守卫地 `ctrl.enqueue`/`ctrl.close`；`cancel()` 不同步阻断在途 pull | observed |
| `packages/core/src/aisdk.ts` `wrapSSE()`（11-57 行） | 同构隐患：chunkTimeout 配置的 aisdk 端点走这条包裹路径，同样的 cancel-during-pull 窗口 | reachable |
| `packages/opencode/src/cli/cmd/tui/worker.ts` 51-61、266-348 行 | 自杀开关现场：`process.prependListener("unhandledRejection", () => void gracefulShutdown(...))`；`gracefulShutdown` 全量拆解（取消全部 session、dispose 实例、关闭 server、关闭 DB、清 lock、exit） | observed |
| `packages/opencode/src/cli/cmd/tui/daemon.ts`（ensure/existingOwnerUrl/选举/stopDaemon）、`server-lock.ts` | 生命周期现状：死亡→flock 选举→单 owner 重建（本次事故中 41064→14840→45632 均单 owner，无并发双写）；unresponsive→复用不顶替；stop→控制面 graceful→owner 复核→SIGKILL | observed |
| `packages/opencode/test/cli/tui/daemon.test.ts`（2400+ 行） | 既有生命周期测试覆盖：选举、锁、隔离 env；无 unhandledRejection 策略覆盖 | observed |
| `packages/opencode/src/server/event.ts` 45-77 行 | 全局 SSE 端点的 controller 写入已全部 try/catch 守卫——排除为 rejection 来源 | observed |
| `packages/opencode/src/util/queue.ts` | AsyncQueue 纯数组实现，push 不抛——排除 | observed |
| Windows 事件日志 / CrashDumps / SecurityCenter2 | 两次死亡均无 WER/崩溃转储/AV 记录——排除原生崩溃与外部查杀 | observed |

## 5. Current Behavior

生产事故链路（2026-10-02 两次复现，daemon 36428 与 41064）：

```text
session cancel（或 abort 风暴）
  -> AI SDK 管道取消 provider fetch 的 SSE body
  -> wrap() 的 cancel() 执行：ctl.abort + reader.cancel（controller 同步关闭）
  -> 在途 pull() 的 await read() 恢复（迟到 chunk 或 done）
  -> ctrl.enqueue()/ctrl.close() 打到已关闭 controller
  -> TypeError: Invalid state: Controller is already closed
  -> 经 AI SDK 管道逃逸成 process 级 unhandledRejection
  -> worker.ts:347 prependListener -> gracefulShutdown("unhandledRejection")
  -> 全量拆解：取消所有 session（9 个活跃）、断开所有 SSE client（5 个 TUI）、关库退出
  -> 用户侧：全部 TUI 报"连接不到 URL"并退出；恢复后所有在途 tool part 被标记 aborted/interrupted
```

生命周期现状（已核实，不需要改的部分）：

```text
TUI/CLI -> Daemon.ensure() -> existingOwnerUrl()
  -> missing/dead -> flock 选举 -> spawn wrapper -> worker 写 lock -> ping 通过 -> 复用
  -> responsive/unresponsive -> 直接复用（不顶替）
  -> stopping -> 等待退出后清理 -> 选举
daemon 退出路径 -> 控制面 /shutdown（token 校验）/ idle 定时器（4s，fire 时复查）/
  startup idle（首 client 前）/ launcher watcher（首 client 前）/ SIGTERM /
  unhandledRejection+uncaughtException prependListener
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| consumer 在 pull 在途时 cancel SSE body | AI SDK 管道 abort（session cancel / 超时 / abort 风暴） | 无（流协议允许任意时刻 cancel） | `wrap()` pull/cancel 竞态 | provider.ts | observed（两次生产死亡） |
| 同上，aisdk chunkTimeout 包裹路径 | 模型 config 设置 chunkTimeout 的 aisdk 端点 | 无 | `wrapSSE()` 同构竞态 | core/aisdk.ts | reachable |
| 任意 unhandledRejection | 任何产生孤儿 promise 的代码路径 | 无 | worker.ts:347 自杀 | worker.ts | observed（本次直接死因） |
| uncaughtException | 同步代码逃逸 | 无 | worker.ts:348 自杀 | worker.ts | reachable（保留，见第 10 节论证） |
| daemon 卡死（unresponsive） | 长模型调用 / 真卡死 | 单 owner 不变量 | ensure 复用；显式 `daemon stop` 恢复 | daemon.ts | contracted（不改变） |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | SSE 包裹流在 consumer cancel 后，迟到的 chunk/EOF 不得再触碰 controller（不 enqueue、不 close、不合成 EOF 遥测） | 生产 rejection + 探针复现 | 无（本计划新增） |
| INV-02 | cancel 语义不变：abort 传播、reader cancel、deadline 清理、错误分类（AbortError 走既有 error mapping）全部保持 | 生产日志中 AbortError 走设计内路径 | `test/session/retry.test.ts:622-630`（abort 非重试分类） |
| INV-03 | unhandledRejection 只记录日志，不得终止 daemon 进程 | 本次事故直接死因 | R5 新增：隔离子进程 import 真实 worker，stdin 触发 Promise.reject，观测仍服务（沿 spawnHangingDisposerDaemon 先例） |
| INV-04 | uncaughtException 仍触发 gracefulShutdown（同步逃逸后在飞状态不可信，需清 lock 释放 SQLite） | worker.ts:345-346 注释的设计意图 | R5 新增：同设施触发 uncaughtException，观测有界退出 + lock 清理 |
| INV-10 | 显式 `daemon stop` 在控制面无响应（超时/连接失败）时，必须能到达 owner 复核后的 force 路径；控制面应答但拒绝（如 maintenance-idle 409）不得升级为强杀；R6 补充：maintenanceIdle 条件式停机在未获得 worker 接受时（含无应答）一律不得升级强杀——无应答不等于空闲，中断授权只能来自 worker 的明确接受 | 双审计 B-01（R5 轮）+ 二轮双审计共性 B-01：WS8 汇焦把条件式调用一并带入 force（db.ts:487/604 为真实消费者） | R5 hung 控制面测试（显式 stop 方向）+ R6 新增条件式 hung 控制面不得强杀测试 |
| INV-05 | daemon 单 owner 与选举行为不变；unresponsive owner 不被顶替；无自动卡死强杀 | cross-host R4 + daemon-ctrl-c R7 | test/cli/tui/daemon.test.ts 既有套件 |
| INV-06 | 热路径无性能回退：每 pull 仅增加 O(1) 布尔检查；无新增定时器/轮询/IO | 设计静态分析 | typecheck + 套件通过即可 |
| INV-07 | gracefulShutdown 正常路径退出前，日志流缓冲必须完整落盘（死亡尾部证据不丢失）；deadline 硬截止路径保持原有不同步等待语义 | 36428 日志在 12:57:59 后零记录 vs 41064 同类关闭有记录（缓冲丢失实证） | 无（本计划新增） |
| INV-08 | 日志 cleanup 不得删除近期仍在/刚被写入的证据日志：超出 keep 数量且 mtime 超过保留窗才可删除 | 36428 的 17MB 日志（名旧、mtime 新）在 TUI 暴发重启时被 count-only 规则删除 | 无（本计划新增） |
| INV-09 | ~~ACP stdin 流 cancel 后摘除监听~~ R5 撤回：经直接读取实际消费者（@agentclientprotocol/sdk stream.js:17-60、acp.js close 路径）证实没有任何 consumer 调用该流的 cancel()——危害不可达，WS7 代码为无生产者的死分支，按证据门禁回退 acp.ts 至 HEAD | 审计者亲读 SDK 消费者源码（observed） | 无需测试（无变更） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | `wrap()` 的 `pull()` 在 `await read()` 恢复后未检查 cancel 是否已发生，直接写 controller | provider.ts `progressDeadline().wrap()`；core/aisdk.ts `wrapSSE()` | 探针 2/4 复现同款 TypeError；red 测试输出 |
| INV-03 | worker.ts:347 把"孤儿 promise 结果"（进程状态完好）与"崩溃"混为一谈，升级为整机 shutdown | worker.ts 致命错误策略 | 045932.log 20206-20207 行 |
| INV-07 | `gracefulShutdown` 在 `process.exit(0)` 前未等待日志流（`createWriteStream` 缓冲）落盘 | `core/util/log.ts`（无 flush/close 接口）+ worker.ts 退出点 | 36428 尾部日志缺失 vs 41064 部分保存的对比实证 |
| INV-08 | `cleanup()` 仅按文件名排序保留 top-10，把"名字旧但仍在写"的长跑 daemon 日志误判为尸体 | `core/util/log.ts` `cleanup()` | 203822.log 在 13:24:38 暴发重启后被删（删除前已完成取证） |
| INV-09 | R5 修正：原判"可达"有误——唯一消费者 ndJsonStream/AgentSideConnection 从不 cancel 输入流（stream.js:17-60 仅 getReader/read/releaseLock），write-after-close 前提（cancel 发生）在该链上不成立 | 无生产变更（回退 WS7） | 审计者亲读 node_modules 实际消费者 |
| INV-10 | `stopDaemon` 把 requestStop 的任何失败（含 1s 超时/连接拒绝）直接 throw，owner 复核 + force 仅在"请求成功但未退出"后可达 | `cli/cmd/daemon.ts` stopDaemon/requestStop | 双审计 B-01 + 亲读 daemon.ts:130-156 证实分支结构 |

D3（listen socket 继承）探针实证：`probe-socket-inherit.ts`——父进程 Bun.serve 监听后 spawn 子进程（stdio 全 ignore），父 `server.stop(true)` 后子仍存活时同端口重绑失败（REBIND_FAILED），证明 Windows 上 Bun.spawn 子进程继承 listen socket；`probe-server-fd.ts` 证明 Bun Server 对象不暴露 fd/handle（keys/proto 枚举无 fd/handle/listener）。结论：运行时层无法触及句柄，属 Bun 行为；本计划不修 Bun（见 §2/§20）。

下游症状（非根因，不得作为修复对象）：TUI "连接不到 URL"（daemon 主动断连的正常后果）、恢复后 tool part 被标 aborted/interrupted（恢复机制的正常行为）、`sse.error AbortError` 日志（设计内错误路径）。

Red-capable feedback loop（已建立并实际运行）：

- 命令：`bun test test/provider/provider.test.ts -t "cancel during in-flight pull" --timeout 30000`（cwd `packages/opencode`）
- 捕获症状：未修复时代码在 cancel 后合成 `sse.end`（write-after-close 抛错前的可观测副作用）；修复后不产生。
- 观察到的 red 输出（2026-10-02 06:07 UTC）：`expect(ended(sentinel.cancelled)).toEqual([])` 失败，实际收到 `INFO ... phase=sse.end requestID=42424201 ...`；控制组（正常 EOF）断言通过。
- 最小化：单文件单测试，无网络、无进程、无真实 provider，确定性排序（enqueue→同步 cancel→微任务恢复）。

流程说明：本调查链早期已在工作区构建过等效修复与测试并完成 red/green 验证；为满足"审计前不得实施"的合同，已将三处文件（provider.ts、aisdk.ts、provider.test.ts）全部回退至 HEAD 状态（`git diff` 为空已验证），上述 red 证据为回退前在同一代码路径上的真实运行记录。本计划批准后按第 15/16 节原样重建。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 流源 controller 的写入时机 | 各 ReadableStream 源（wrap / wrapSSE） | 源独占其 controller 生命周期；cancel 后不得再写 | cancel 时序只有源自己可见（closure 内 released 标志） | 下游 consumer/pipe 无法知道源的 pull 是否在飞 |
| daemon 致命错误分类（rejection vs exception） | `cli/cmd/tui/worker.ts` 内联（R3 按用户内联指令自 fatal-policy.ts 撤回） | 对"何种进程级错误需要自杀"的唯一裁决 | worker.ts 是进程入口，唯一消费者；用户明确否决单消费者模块抽取 | 各业务模块只见局部错误，无法裁决进程级生死 |
| daemon 选举/锁/单 owner | 既有 `daemon.ts`/`server-lock.ts` | 不变 | — | — |
| cancel 语义与错误分类 | 既有 provider 错误 mapping | 不变（INV-02） | — | — |

## 10. Single Approved Primary-Path Design

**WS1 — 竞态根治（修复第一分歧点）**

provider.ts `wrap()` 与 core/aisdk.ts `wrapSSE()` 各引入 closure 内的 `released` 标志：

```text
cancel() 入口 -> 同步置 released = true（先于任何 await）-> 原有 abort/cancelReader 不变
pull() 的 await read() 恢复后 -> if (released) return（丢弃迟到 chunk/EOF）
done 分支 -> 置 released = true 后 ctrl.close()（幂等语义自描述）
```

单线程 JS 下 pull 与 cancel 的唯一交错点是 `await read()`，因此单一标志封闭全部窗口；不引入 try/catch 掩盖、不改变任何对外语义（cancel 后本就该静默）。每个 pull 增加一次布尔读取，O(1)，无性能影响（INV-06）。

**WS2 — 致命错误策略修复（修复第二分歧点；R3 按用户明确要求改为内联）**

用户原话要求："如果新模块它只是在辅助另一个东西的一个 helper，本质上应当内联……它如果只有调用一次，那本身就是一个内联就行了"。因此 R3 撤销 R2 的 fatal-policy.ts 模块抽取，策略直接内联在 worker.ts（唯一消费者），删除 fatal-policy.ts 与其测试（二者未提交、仅存在于工作区）：

```ts
// 进程级错误裁决：unhandledRejection 只是孤儿 promise 的结果——产生它的操作早已在自己的
// 上下文里终态化，进程状态完好，只记录不得自杀（生产实证：单个流竞态 rejection 曾把
// 5 个 TUI + 9 个活跃 session 全部拖死）。uncaughtException 是同步逃逸，在飞状态不可信，
// 保留优雅拆解以清理 daemon lock 并释放 SQLite。
process.on("unhandledRejection", (e) => {
  log.error("rejection", { e: e instanceof Error ? e.message : e })
})
process.prependListener("uncaughtException", (e) => {
  log.error("exception", { e: e instanceof Error ? e.message : e })
  void gracefulShutdown("uncaughtException")
})
```

注册点位于 gracefulShutdown 定义之后（闭包有效）；此点到下方 let 声明之间为无 await 的同步求值，事件无法交错，TDZ 不可达（实现审计 NB-01 已核实的真实约束）。日志复用 worker.ts 既有 `log`（service=daemon）。

保留 uncaughtException 自杀的论证：本次事故实证的死亡全部来自 rejection；exception 路径无受害证据，且同步逃逸后内存状态不可信，优雅拆解（含 lock 清理与 SQLite 释放）是正确终态。这同时满足"正常情况不应自杀"与"不引入无证据改动"。

**WS4 — 退出前日志落盘（修复 INV-07）**

`core/util/log.ts` 新增 `close()`：`end()` 当前文件流并等待其回调（`finish`），`error` 事件先到则同样放行（日志是诊断通道，关闭不得成为退出阻塞点）；置位后写入降级到既有 `writeStderr`。worker.ts `gracefulShutdown` 在 `clearTimeout(shutdownDeadlineTimer)` 之前、`process.exit(0)` 之前 `await Log.close()`——5s 硬截止保持对关闭等待的兜底，关闭自身不引入新的超时机制。deadline 硬截止路径（`process.exit(1)`）保持既有不同步等待语义不变——它是事件循环已卡死时的兜底，不能引入新的等待。

**WS5 — 日志清理的证据保留窗（修复 INV-08）**

`core/util/log.ts` `cleanup()`：在现有 keep=10 名字序规则上增加 mtime 保留窗——超出 keep 数量的文件，只有 mtime 早于 `now - RETAIN_MS`（24h，带注释的常量）才删除；近期写入过的一律保留。名字旧但 mtime 新的长跑 daemon 日志（本次事故的 17MB 证据）由此免疫于暴发删除。测试黑盒经 `Log.init` 触发 cleanup（沿 test/util/log.test.ts 既有先例），不新增任何 test-only 导出。

行为合同变更登记（R4，方案审计第 3 轮 B-01）：既有测试 `init cleanup keeps the newest timestamped logs`（test/util/log.test.ts:43-61）的 fixture 由 writeFile 构造（mtime=now），在新合同下超额文件将全部保留，其 `not.toContain(list[0])` 断言必然转红。该测试钉住的正是 WS5 要改变的 count-only 语义，必须随合同改写：对预期被删的 list[0..2]（13 个文件中按名字序超出 keep=10 的前 3 个）用 `fs.utimes` 回拨 mtime 至 48h 前，其余保持新鲜——原断言在新合同下继续成立且删除路径仍被真实走过；新增的 slice 3 测试反向钉住"名字旧但 mtime 新鲜者存活"。这不是削弱测试，而是行为合同变更的显式登记。

**WS6 — listen socket 继承（D3）：不修代码，记录探针实证与决策**

机制已由探针证实（§8）。修复需要 Bun 提供 fd/handle 控制或 spawn 继承开关，两者今天都不存在；FFI 句柄遍历被否决（§2 Non-Goals）。残余危害仅为死亡后 TUI 检测延迟 ~90s：选举用 `ServerLock.alive(pid)`（PID 语义）不受端口占用影响，新 daemon 可绑新端口（已实证 41064 用 16692），无正确性/单写者危害。作为开放决策留给用户：接受现状（推荐）或未来投资 TUI 侧 stall watchdog（受 SDK 生成代码约束，另行立项）。

**WS7 — ACP stdin 流监听摘除（R5 撤回）**

R4 实施的前提是"consumer 会 cancel 该流"。双审计者之一亲读实际消费者源码后反证：acp.ts 的 `output` 唯一外传点是 `ndJsonStream(input, output)`（stream.js:17-60），SDK 只 `getReader/read/releaseLock`，`AgentSideConnection` 的 receive/close 路径也不取消输入 reader——`cancel()` 无生产者，新增摘除代码是不可达死分支。R5 处置：acp.ts 回退至 HEAD（精确回滚本次新增），INV-09 记录修正为"危害不可达"。**教训登记**：同类流包装隐患的申报必须先核实真实消费者的取消行为，不得以"ReadableStream 支持 cancel"的抽象可能性代替可达性证据。

**WS8 — 控制面无响应时显式 stop 可达 force 路径（修复 INV-10，双审计 B-01；R6 补权限边界）**

`cli/cmd/daemon.ts`：`requestStop` 的返回值从 error 字符串改为判别结果——`undefined`（已接受）/ `{ type: "rejected" }`（控制面应答但拒绝，如 maintenance-idle 409：业务拒绝不得升级为强杀，维持抛错）/ `{ type: "unreachable" }`（1s 超时或连接失败：控制面卡死，用户显式 stop 不得被挡在恢复路径之外）。`stopDaemon` 中 unreachable 与"graceful 已接受但未退出"汇合进入同一既有 force 分支（重读 lock → sameOwner 复核 → alive 检查 → 有界 SIGKILL → finishStop），不新增第二套强杀逻辑。owner 身份复核与单写者约束原样保留；force 分支的 PID/token/controlPort/dbPath 四元复核不因入口增加而弱化。

R6 权限边界（二轮双审计共性 blocker）：unreachable 汇焦只对**显式 stop**开放。`maintenanceIdle: true` 是条件式停机——中断授权来自 worker 对"无在跑维护"的明确接受（200/202），409 或无应答都意味着授权未发生；无应答不等于空闲（控制面可能正被同步事务阻塞）。因此 `requestError?.type === "unreachable" && input.maintenanceIdle === true` 时维持原有抛错，不进入 force 分支；已被接受（requestError 为 undefined）后超时退出不了的，授权已发生，汇焦 force 不变。顺带修正 daemon.ts:98 的过期注释（“只有该请求成功”才能进入第二阶段的表述与 unreachable 汇焦不符）。

**WS9 — 致命错误策略的隔离子进程行为测试（修复双审计 B-02/B-04，INV-03/04 补验证）**

审计反证了"worker 无 importable seam"：daemon.test.ts:224 `spawnHangingDisposerDaemon` 已在隔离子进程 `await import` 真实 worker 并驱动生命周期。R5 沿用该设施新增两测试（test/cli/tui/daemon.test.ts）：

1. rejection 存活：wrapper import worker 后 `process.stdout.write("ready")` 并就绪于 stdin 触发器；测试 ping 就绪后向 stdin 写入触发行，wrapper 执行 `Promise.reject(new Error("probe-rejection"))`；轮询隔离 dev.log 出现 `probe-rejection`（证明 handler 真实执行）后断言 `ServerLock.ping` 仍成功（daemon 未自杀）。
2. exception 优雅拆解：同设施触发 `throw new Error("probe-exception")`（EventEmitter 回调内抛出即 uncaughtException）；断言进程在有界窗口内退出且 lock 被清理（gracefulShutdown 跑完）。

触发通道用 stdin（可观测、无时序猜测）；就绪与完成均轮询可观测信号（ping / dev.log 行 / proc.exited），不用固定 sleep。

**WS10 — 竞态回归测试改走生产 seam（修复双审计 B-03 + B-04）**

删除 `_progressDeadline` test-only 导出（policy:485 禁止仅为测试新增生产代码；`_spawn` 先例不构成新增例外的授权）。回归测试改沿 provider.test.ts:1893 的既有生产 seam：本地 plugin 定义 custom provider（loader 注入 fetch），`Provider.getLanguage` → `doStream` 走真实 provider fetch 包装——测试 fetch 返回 `content-type: text/event-stream` 的可控 `Response`，body 经真实 `deadline.wrap` 包裹。

同步纪律（替换两处固定 sleep）：
- 就绪信号：可控 inner 流的 `pull()` 回调计数，第 2 次 pull 即 refill 在飞（latch），此时 abort。
- 完成信号：先跑 cancelled 组（abort 传播触发在途 pull 恢复——buggy 代码会在此刻合成 sse.end），再跑正常 EOF 控制组；轮询 dev.log 直到控制组的 sse.end（以唯一 providerID/modelID 区分两组）落盘——日志流 FIFO 保证 buggy 写入若存在必先于控制组落盘，负断言窗口确定关闭。

Red 证明：临时移除 released 守卫时 cancelled 组 sse.end 出现；恢复守卫后消失。

**WS11 — worker.ts 策略注释口径修正（双审计 NB）**

内联处理器注释不得把"操作已终态化、进程状态完好"写成对所有 unhandledRejection 的通用运行时保证；改为策略裁决边界表述：本进程将 rejection 视为不致命事件只记录（事故证据 + 策略选择），而非宣称所有异步错误均已安全终态化。

**WS3 — 生命周期完整性核实（只读，不改代码）**

以代码+既有测试核实并记录：(a) 死亡→flock 选举→单 owner 重建（本次事故已实证 3 次重建均无双 owner）；(b) unresponsive→复用不顶替（单写者保护，cross-host R4 约束）；(c) 卡死恢复=显式 `daemon stop`——R5 修正：双审计发现该链条在控制面无响应时断裂（requestStop 失败即抛错，force 不可达），由 WS8 修复后此结论才成立；(d) idle/startup/launcher 定时器均有界且 fire 时复查活跃性（worker.ts:546-648）——无过度激进重启点。结论与证据记入第 23 节实现证据。

```text
input -> validation at owning seam -> primary operation -> observable result
WS1: cancel -> released 置位 -> 迟到写入被丢弃 -> 无 rejection 产生
WS2: unhandledRejection -> 日志 -> daemon 继续服务（无拆解）
WS3: 既有路径 -> 代码+测试核实 -> 记录结论
```

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| AbortError 走 error mapping / retry 分类 | current | primary-contract branch | yes（错误语义即合同） | 既有 | preserve |
| `daemon stop` force SIGKILL（owner 复核后） | current | existing compatibility（R7 授权路径） | yes | 既有 | preserve |
| unresponsive owner 复用 | current | primary-contract branch | yes | 既有 | preserve |
| 按错误类型过滤后选择性自杀 | rejected | forbidden fallback（分类不可靠，误杀即整机事故） | — | — | reject |
| 新增 daemon 卡死自动检测/强杀 | rejected | 与 cross-host R4 单写者约束冲突；长调用误判=新误杀 | — | — | reject |
| FFI 句柄遍历（NtQuerySystemInformation）标记 listen socket 不可继承 | rejected | 结构体布局版本敏感、解析错误即 daemon 启动崩溃；与"恢复检测延迟 ~90s"的纯延迟性危害不成比例 | — | — | reject |
| 工具子进程改经包装器 spawn 以隔断句柄继承 | rejected | 改动最热的工具 spawn 路径换取罕见死亡场景的恢复延迟，风险不成比例 | — | — | reject |
| TUI 侧 SSE stall watchdog | deferred | R5 记录修正：`cli/cmd/tui/context/sdk.tsx:134-141` 已有心跳看门狗（15s 无事件即 abort 重建）；事故中 ~90s 延迟在该机制存在下仍发生，原因未定位，属另行立项 | — | — | 另行立项 |
| `Log.close()` 退出落盘 + cleanup mtime 保留窗 | current-defect repair | yes（修复已实证的独立缺陷） | 本计划 WS4/WS5 | primary-contract repair |
| acp stdin cancel 摘除（R4 WS7） | rejected（R5） | 无生产者：实际消费者从不 cancel 输入流（stream.js:17-60），属不可达死分支 | — | — | reject（回退 acp.ts） |
| `_progressDeadline` test-only 导出（R2） | rejected（R5） | policy:485 禁止仅为测试新增生产代码；`_spawn` 先例不授权新例外 | — | — | reject（删除导出，测试改走生产 seam，WS10） |
| 固定 sleep 充当并发就绪/完成信号（R2 竞态测试） | rejected（R5） | test/AGENTS.md 明确要求可观测信号；负断言窗口无确定性关闭保证 | — | — | reject（WS10 以 pull latch + 日志轮询替换） |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| worker.ts:347 unhandledRejection→shutdown | 注释称"确保 daemon 崩溃时 lock 被清理" | rejection 不退出进程，无需 lock 清理；真崩溃由 stale-owner 选举 reconciliation 兜底（worker.ts:274-276 注释既有合同） | worker.ts prependListener 注册（R3：并入内联处理器） |
| `fatal-policy.ts` 策略模块 + 其测试（R2 引入，未提交） | R2 为可测试性抽取的单消费者模块 | 用户明确要求：单用途 helper 应当内联，不增加扁平化小模块（第 1 节 R3 原话） | 删除两文件，策略内联回 worker.ts 原注册点（R4 已完成；R5 由 WS9 补隔离子进程行为测试） |
| `_progressDeadline` test-only 导出（R2 引入） | 为竞态复现直接驱动私有 wrap | policy:485 硬门禁；生产 seam（plugin custom provider fetch）可达同一 wrap（WS10） | provider.ts 导出删除，provider.test.ts 重写 |
| acp.ts cancel 摘除分支（R4 WS7） | 假设 consumer 会 cancel | 实际消费者从不 cancel（stream.js:17-60 亲读实证），不可达死分支 | acp.ts 回退至 HEAD |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01（provider 路径） | provider.ts wrap() released 守卫 | provider.ts 修改（R5 删除 `_progressDeadline` 导出，WS10） | test/provider/provider.test.ts 竞态回归重写为生产 seam（WS10：plugin custom provider + pull latch + 日志轮询） |
| INV-01（aisdk 路径） | aisdk.ts wrapSSE() released 守卫 | aisdk.ts 修改 | 无可判别 seam，见第 16 节 unverifiable 说明；由 typecheck + 既有套件 + 同构模式证明 |
| INV-02 | 不改动 | 不改动 | 既有 provider 套件（351 通过） |
| INV-03 / INV-04 | worker.ts 内联进程级错误处理器 | worker.ts（R4 内联，R5 仅注释口径修正 WS11） | daemon.test.ts 新增隔离子进程行为测试 ×2（WS9：rejection 存活 / exception 有界退出） |
| INV-07 | `Log.close()` + gracefulShutdown 退出前 await | core/util/log.ts 修改 + worker.ts 修改 | test/util/log.test.ts 新增 close 落盘测试 |
| INV-08 | cleanup() mtime 保留窗 | core/util/log.ts 修改 | test/util/log.test.ts：新增保留窗测试 + 改写既有 count 规则测试（utimes 回拨预期被删 fixture，R4 B-01 登记） |
| INV-09 | R5 撤回：危害不可达，无生产变更 | acp.ts 回退至 HEAD | 无（无变更） |
| INV-10 | requestStop 判别 rejected/unreachable + 汇焦既有 force 分支；R6：unreachable+maintenanceIdle 维持抛错 | cli/cmd/daemon.ts 修改（WS8） | daemon.test.ts：hung 控制面 force 测试（显式 stop 方向）+ R6 新增条件式 hung 控制面不得强杀测试（直接调 stopDaemon 导出函数 + `_setLockPath` 隔离） |
| INV-05 | 不改动 | 不改动 | 既有 daemon.test.ts 套件（WS3 核实引用） |
| INV-06 | 静态论证 + 全套件通过 | — | 全套件无新增超时/性能断言失败 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `released` 守卫（×2 处） | INV-01 | 生产 rejection + 探针 + red 测试 | cancel 与 pull 分属不同微任务，现代码无共享时序状态 |
| ~~`_progressDeadline` test-only 导出~~ R5 删除 | INV-01 测试可达性 | policy:485 硬门禁（双审计 B-03） | 生产 seam 可达同一 wrap：plugin custom provider 注入 fetch → deadline.wrap（provider.ts:2024） |
| worker.ts 内联策略处理器（R3） | INV-03/INV-04 + 用户内联指令 | 本次事故死因 + 第 1 节 R3 原话 | worker.ts import 即启动服务器，策略无法进测试；用户明确否决抽取模块 |
| 既有 cleanup 测试的 utimes 改写（R4） | INV-08 合同变更 | R4 B-01：fixture mtime=now 在新合同下全保留，原删除断言必红 | 原测试钉住的是 count-only 旧语义，新合同下必须显式回拨才能继续真实走删除路径 |
| `Log.close()` | INV-07 | 36428 尾部日志丢失实证 | 现有 Log 无任何 flush/close 接口，`write` 为 fire-and-forget |
| cleanup mtime 保留窗 | INV-08 | 203822.log（17MB）被暴发删除实证 | 现有规则只认文件名序，不知道"名字旧但仍在写" |
| requestStop 判别结果类型 | INV-10 | 双审计 B-01 + 用户"卡死要有好流程"原话 | 现有字符串返回无法区分"应答拒绝"与"无应答"，而两者的升级权限不同（409 不可强杀、无响应必须可强杀） |
| unreachable 对 maintenanceIdle 的排除分支（R6） | INV-10 权限边界 | 二轮双审计共性 blocker + worker.ts:472-484 条件门 + daemon.test.ts:1763 既有合同 | 条件式停机的中断授权只能由 worker 接受产生；WS8 的汇焦点不知道该授权是否存在，必须在决策点区分 |
| aisdk.ts 无专用行为测试 | — | Bun 在当前运行时会吞掉该路径的 pull rejection，任何 black-box 断言都无法判别（探针 2/3/4 实证） | 明确 unverifiable reason；模式与 provider 修复同构 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
生产文件 5 个（用户上限 6），生产改动行数远低于 1200 行上限：

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/provider/provider.ts` | modify | wrap() released 守卫（R2 保留）；R5 删除 `_progressDeadline` 导出 | +11 / -2 |
| `packages/core/src/aisdk.ts` | modify | wrapSSE() released 守卫（R2 保留，不动） | +8 / -0 |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | R4 内联策略 + `await Log.close()`（保留）；R5 仅 WS11 注释口径修正 | +14 / -16（注释行变动） |
| `packages/core/src/util/log.ts` | modify | close() + cleanup 保留窗（R4 保留，不动） | +28 / -2 |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | WS8：requestStop 判别 rejected/unreachable；unreachable 汇焦既有 force 分支；R6：unreachable+maintenanceIdle 排除分支 + :98 过期注释修正 | +24 / -6 |
| `packages/opencode/src/cli/cmd/acp.ts` | revert | R5 回退 WS7 至 HEAD（不可达死分支） | 0（净） |
| `packages/opencode/src/cli/cmd/tui/fatal-policy.ts` | delete（工作区，R4 已完成） | — | 0（净 vs HEAD） |
| `packages/opencode/test/cli/tui/fatal-policy.test.ts` | delete（工作区，R4 已完成） | — | 0（净 vs HEAD） |
| `packages/opencode/test/provider/provider.test.ts` | modify | R5 重写竞态回归为生产 seam（WS10），替换 R2 的 _progressDeadline 直驱版 | +75 / -63 |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | WS9 隔离子进程策略测试 ×2 + WS8 hung 控制面 force 测试 + R6 条件式 hung 不得强杀测试 | +170 |
| `packages/opencode/test/util/log.test.ts` | modify | R4 内容保留不动 | +65 / -0（已在树） |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | cancel 打在在途 pull 上时不得合成 sse.end（write-after-close 的可观测前哨），正常 EOF 必须合成 | wrap() 无 released 守卫 | released 守卫 | 同一 cancel 竞态不再产生 rejection；生产症状不再现 |
| 2 | `await Log.close()` 后 sentinel 日志行必须已落盘 dev.log | 现无 close() 接口（缺失 API 红） | close() end 流并等待 finish/error | INV-07：退出前证据不丢失 |
| 3 | cleanup 对超出 keep 但 mtime 新鲜的文件保留、对 mtime 过期的删除 | count-only 规则 | mtime 保留窗 | INV-08：暴发不再误删证据 |
| 4（R5） | 竞态回归生产 seam 版：abort 打在在途 pull 上时 cancelled 组无 sse.end，正常 EOF 组有 | R2 测试依赖 test-only 导出与固定 sleep | WS10 重写（red 证明：临时移除守卫时 cancelled 组 sse.end 出现） | INV-01 回归保护移至合法 seam |
| 5（R5） | 隔离 worker 子进程触发 unhandledRejection 后 ping 仍成功 | R4 前该策略无行为测试 | WS9 测试 1 | INV-03 被行为钉住 |
| 6（R5） | 隔离 worker 子进程触发 uncaughtException 后有界退出且 lock 清理 | 同上 | WS9 测试 2 | INV-04 被行为钉住 |
| 7（R5） | 控制面永不应答的 owner，`daemon stop` 仍完成 owner 复核后强杀并清 lock | requestStop 失败即抛错 | WS8 判别 + 汇焦 force 分支 | INV-10：卡死恢复链闭合 |
| 8（R6） | 同一 hung owner 上，`stopDaemon({maintenanceIdle: true})` 必须抛错且进程存活、lock 不动 | WS8 汇焦无条件带入 force | unreachable+maintenanceIdle 维持抛错 | INV-10 权限边界：条件式停机不继承显式 stop 的中断权 |

Slice 2/3 说明：两测试均加入既有 test/util/log.test.ts，复用其 `Global.Path.log` 覆盖 + finalizer 恢复模式。Slice 2 在 tmpdir 上 init(dev:true) → 写 sentinel → close() → 同步读 dev.log 断言（close 返回即落盘，不需轮询）；finalizer 恢复 Global.Path.log 并 re-init（既有先例）。Slice 3 黑盒经 `Log.init` 触发 cleanup（沿本文件既有 cleanup 测试先例）：造 12 个旧名文件，`fs.utimes` 将其中 2 个 backdate 到 48h 前、1 个保持新鲜 mtime；init 后断言新鲜者存活、backdated 者被删。

既有测试改写登记（R4 B-01）：`init cleanup keeps the newest timestamped logs` 的 12 个 writeFile fixture 的 mtime 均为 now，在保留窗下超额文件全保留、原删除断言必红。改写：对预期被删的 list[0..2]（init 新增当日文件后共 13 个，按名字序 slice(0,-10) 命中前 3 个）utimes 回拨至 48h 前，其余不动；原断言（list[0] 被删、list[11] 保留）在新合同下继续成立，删除路径仍被真实执行。该改写与 slice 3 互为两个方向：删除方向由改写后的既有测试钉住，保留方向由 slice 3 钉住。

Slice 1 说明（seam 合同，R2 历史）：测试通过 `_progressDeadline` 直接驱动真实 wrap 后的 body，经 `pipeThrough` 消费复现 AI SDK 管道拓扑（探针实证：默认水位下裸 reader 无法让第二个 pull 在飞，必须管道消费）。判别不用 unhandledRejection spy（Bun 当前会吞掉，探针实证不可靠），而用"cancel 后是否合成 sse.end 遥测"这一 done 分支的可观测前哨；正常 EOF 控制组证明可观测性成立。R5 起被 slice 4 取代（同一判别点，seam 换成生产路径，同步纪律换成 latch + 轮询）。

worker.ts 内联策略验证（R5）：R3 的 unverifiable 理由被双审计反证（spawnHangingDisposerDaemon 先例），WS9 以隔离子进程行为测试钉住 INV-03/04。

acp.ts（R5）：WS7 撤回，文件回退至 HEAD，无变更、无需测试。

aisdk.ts unverifiable 说明：Bun 在当前版本会把该 seam 的 write-after-close rejection 吞进流机制（探针 2/3/4 均无法经 unhandledRejection 或外部状态观测到差异），done 分支又无遥测前哨，因此不存在 black-box 判别点。修复与 provider 路径同构同证据；以 typecheck + 既有 core 套件防回归。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ≈405（production ≈75：provider 4 + aisdk 4 + worker 20 + log 20 + daemon 27；acp 0 已回退；测试 ≈330：provider.test ≈109 + log.test 42 + daemon.test ≈179） | 按政策口径含 production **与 tests**；exclude formatting/generated/pure moves；fatal-policy 与 acp 净零不计；实现审计以实际 diff 复算为准 |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(405×0.15)) = 61；计划 ≈72 | 见下 |

计划注释位置（均为非显然约束，实施时逐条落位）：

1. provider.ts wrap()：released 守卫的竞态窗口与"cancel 先同步置位、再 await"的顺序约束（2-3 行）。
2. provider.ts done 分支：为何 close 前置位（幂等语义自描述）（1 行）。
3. provider.ts cancel()：为何 released 必须先于任何 await（1 行）。
4. provider.ts `_progressDeadline`：test-only 导出用途（沿 daemon.ts `_spawn` 先例）（1-2 行）。
5. aisdk.ts wrapSSE()：同款守卫与生产事故的交叉引用（2 行）。
6. aisdk.ts cancel()：置位顺序约束（1 行）。
7. worker.ts 内联处理器：rejection 不自杀与 exception 保留自杀的裁决依据（孤儿 promise/状态完好 vs 同步逃逸/状态不可信 + 生产事故证据）（4-5 行，R3 自 fatal-policy.ts 迁入）。
8. worker.ts gracefulShutdown：`await Log.close()` 为何必须在 process.exit(0) 之前、deadline 路径为何不等待（1-2 行）。
9. provider.test.ts：为何必须用 pipeThrough 消费才能复现竞态（探针实证：裸 reader 默认水位下无在飞 pull）（2 行）。
10. provider.test.ts：判别点选择理由——Bun 吞掉 rejection、spy 不可靠，sse.end 是 done 分支的可观测前哨（2 行）。
11. provider.test.ts：正常 EOF 控制组的存在理由（证明遥测可观测、断言不为空不是恒真）（1 行）。
12. log.ts close()：error 先到同样放行（诊断通道不得成为退出阻塞点）（1-2 行）；close 后写入降级 stderr 的理由（退出末段不得写已销毁流）（1 行）。
13. log.ts cleanup()：RETAIN_MS 保留窗的事故依据（暴发删除 17MB 证据日志）（2 行）；mtime 语义（最后写入时刻，名字旧≠尸体）（1 行）。
14. acp.ts：监听命名与 cancel 摘除的理由（事件回调内 enqueue 已关闭流会成为 uncaughtException）（2 行）。
15. log.test.ts close 测试：finalizer 恢复 Global.Path.log 并 re-init 的理由（不污染同进程其他测试文件的共享日志流）（1-2 行）。
16. log.test.ts 保留窗测试：utimes backdate 的理由（writeFile 会把 mtime 写成 now，必须显式回拨才能制造判别窗口）（1-2 行）。
17. log.test.ts 既有 cleanup 测试改写处：为何对 list[0..2] 回拨 mtime（行为合同从 count-only 变更为 count+mtime 保留窗，原断言在新合同下的成立条件）（2 行）。
18. daemon.ts requestStop：rejected 与 unreachable 的升级权限差异（应答拒绝=业务语义不得强杀；无应答=卡死恢复必须可达）（2-3 行）。
19. provider.test.ts 生产 seam 竞态测试：pull latch 为何等价于"refill 在飞"、控制组后置 + 日志 FIFO 为何确定关闭负断言窗口（3-4 行）。
20. daemon.test.ts WS9 两测试：stdin 触发通道与 dev.log 轮询信号的选择理由（替代 sleep 猜测）（2-3 行）；exception 测试的有界退出断言含义（1-2 行）。
21. daemon.test.ts WS8 hung 控制面夹具：永不答复的 /shutdown 模拟卡死、断言 force 文案 + pid 消失 + lock 清理（2 行）。
22. worker.ts WS11 修正后的策略边界注释（改写，保持 4-5 行）。
23. daemon.ts R6 排除分支：为何无应答对条件式停机不构成授权（无应答≠空闲，中断授权只能来自 worker 接受）（2-3 行）。
24. daemon.test.ts R6 条件式 hung 测试：与 :1763 既有 409 合同测试的方向关系（409=应答拒绝、无应答=授权未发生，两者都不得强杀）（2 行）。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/provider/provider.test.ts -t "cancel during in-flight pull" --timeout 30000` | `packages/opencode` | slice 1 red（实施前）→ green（实施后） |
| `bun test test/util/log.test.ts --timeout 30000` | `packages/opencode` | slice 2/3 green + 既有 log 测试回归 |
| `bun test test/provider/provider.test.ts -t "SSE wrap" --timeout 30000` | `packages/opencode` | slice 4 生产 seam 版 green（red 由临时去守卫证明） |
| `bun test test/cli/tui/daemon.test.ts --timeout 120000` | `packages/opencode` | slice 5/6/7/8 green + 生命周期既有套件回归（INV-05；该套件实测 ≈320-400s，需足宽超时） |
| `bun test test/provider/ --timeout 60000` | `packages/opencode` | provider 全套件回归（基线 351 pass） |
| `bun typecheck` | `packages/opencode` | 类型干净 |
| `bun typecheck` | `packages/core` | aisdk.ts 修改类型干净 |
| `bun test`（core 套件，允许只跑到既有基线） | `packages/core` | aisdk 修改无回归 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0（净） | fatal-policy 两文件未提交即删除；acp.ts 回退净零 |
| Files modified | 5 production + 3 test | production：provider.ts / aisdk.ts / worker.ts / log.ts / daemon.ts（用户上限 6）；test：provider.test.ts / daemon.test.ts / log.test.ts |
| Files deleted | 0（相对 HEAD） | — |
| Production lines | ≈ +85 / -26 | 远低于用户 1200 行上限 |
| Test lines | ≈ +315 / -65 | 竞态重写 + daemon 四测试 + log 两测试 |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

- **逃逸路由未完全隔离**：探针证明 Bun 在简单管道拓扑下吞掉该 rejection，生产的逃逸依赖 AI SDK 更复杂的管道拓扑。本计划消除源端抛错，无论路由如何该类 rejection 不再产生；若未来出现新的逃逸证据，需按同法审计新流源。非阻塞。
- **uncaughtException 保留自杀**：若未来出现"可存活的 exception 被误杀"的证据，需另行收紧。当前无证据，保持保守。
- **同类隐患存量**：`core/src/github-copilot/*` 适配器的大量 enqueue 位于 SDK await 的 doStream 内（rejection 有归属），风险等级不同，不在本次范围。记录备查。
- **Log.close() 的 flush 语义边界**：`end()` 等待的是 Node 流缓冲写入完成，不等待 OS 层 fsync；死亡窗口从"整个进程退出丢失全部缓冲"收敛到"内核崩溃才丢失页缓存"，与日志的诊断通道定位相称。
- **RETAIN_MS=24h 的取值**：覆盖"事故后数小时内取证"的实际窗口（本次事故取证在死亡后 ~30 分钟内完成）；保留期内日志量上限由进程数自然约束，无磁盘风险。

### Open Decisions Requiring the User

1. **D3（listen socket 继承）处置**：根因修复需要 Bun 提供 fd/handle 控制或 spawn 继承开关，今天均不存在（探针实证）；FFI 句柄遍历与工具 spawn 包装器均被否决（§11）。本计划的处置是记录机制与实证、不改代码——残余危害仅为 daemon 死亡后 TUI 检测延迟 ~90s，无正确性/单写者危害（选举按 PID、新 daemon 可绑新端口，均已实证）。R5 记录修正（双审计 NB）：TUI 侧心跳看门狗已存在于 `cli/cmd/tui/context/sdk.tsx:134-141`（15s 无事件即 abort 重建 SSE），"无自有 seam"的旧表述不准确；事故中 ~90s 延迟在该看门狗存在下仍发生，原因未定位。若用户仍要求消掉该延迟，先行项是定位看门狗为何未在 90s 内触发恢复（sdk.tsx 为自有代码，可测），而非新建机制。

### Rejected Speculation

- "Bun 运行时 bug 修复"：不可控，且源端不抛错后不再相关。
- "为所有 ReadableStream 加全局包装器"：无所有权的横切补丁，违反单一职责。
- "daemon 崩溃后自动重放 session"：恢复机制（interrupted 标记 + 显式 resume）已存在，事故恢复行为正常。

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

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01（§17 的 E 口径未含测试代码行，C 承诺低于政策硬下限） | NB-01..NB-05 | BLOCK | task ses_f046febc5ffe3XBzQfozzct9mi |
| 2 | R2 | yes | No blocking findings | NB-02（保留）、NB-04（保留）、NB-05（保留） | APPROVE | task ses_f046febc5ffe3XBzQfozzct9mi |
| 3 | R3 | yes | B-01（WS5 mtime 保留窗使既有 cleanup 测试 `init cleanup keeps the newest timestamped logs` 必然转红：fixture 由 writeFile 构造 mtime=now，新合同下超额文件全保留，`not.toContain(list[0])` 必失败；计划未登记该既有测试的处置） | NB-01（§10 残留的 `_cleanup` 导出句与黑盒口径矛盾，需删）、NB-02（`await Log.close()` 应位于 clearTimeout(shutdownDeadlineTimer) 之前）、NB-03（内联后 INV-03/04 失去行为级测试，unverifiable 理由成立，实现审计逐字比对 §10 片段）、NB-04（沿留）、NB-05（worker.ts 行差估计漂移，实现审计以实际 diff 复算为准） | BLOCK | task ses_f046febc5ffe3XBzQfozzct9mi |

第 3 轮原话记录："**BLOCK**（plan audit，第 3 轮，audited revision: R3，full-scope）。B-01 须修订：在 §13/§15/§16 登记既有 `init cleanup keeps the newest timestamped logs` 测试随 WS5 新合同的改写（utimes 回拨制造判别窗口），revision 升至 R4 后请求新一轮全量审计。修订前 `Implementation allowed` 必须保持 `no`。"R4 修订处置：B-01 已在 §10/§13/§14/§15/§16 登记（既有测试改写 + 双向钉住说明）；NB-01 已删 §10 残句；NB-02 已在 §10/§15 明确 `await Log.close()` 位于 clearTimeout 之前；NB-05 已修正行差估计为 -15；NB-03 为实现审计指令，无需计划改动。

| 4 | R4 | yes | No blocking findings | NB-03（沿留：实现审计逐字比对内联处理器与 §10 片段）、NB-04（沿留）、NB-06（§19 删除数估计漂移 -26 vs 分量之和 -22，实现审计以实际 diff 复算为准） | APPROVE | task ses_f046febc5ffe3XBzQfozzct9mi |

第 4 轮原话记录："**APPROVE**（plan audit，第 4 轮，audited revision: R4，full-scope）。仅允许对 R4 做行政审批状态迁移：`Status: approved`、`Approved revision: R4`、`Implementation allowed: yes`，不得与设计改动合并提交；任何实质性修改使本批准失效并触发新一轮全量审计。实施时须同时执行 R3 范围动作（删除工作区未提交的 fatal-policy.ts 与其测试）与 R4 各节；提交边界警告仍然有效——工作区存在另一线程的 cold-maintenance 中间态，任何提交只许包含本计划 §15 的 7 个文件。"

第 2 轮原话记录："**APPROVE**（plan audit，第 2 轮，audited revision: R2，full-scope）。仅允许对 R2 做行政审批状态迁移：`Status: approved`、`Approved revision: R2`、`Implementation allowed: yes`，不得与设计改动合并提交。任何实质性修改将使本批准失效并触发新一轮全量审计。"

R3 触发记录：R2 实施并经实现审计 APPROVE、状态置 verified 后，用户发出两条新指令（第 1 节 R3 原话）：(a) 将调查中发现并列入 Non-Goals 的三个独立缺陷纳入本次范围解决；(b) 否决 R2 的 fatal-policy.ts 单消费者模块抽取，要求内联。两者均构成实质性范围/设计修改，按政策使 R2 批准失效，本修订为 R3，重新进入全量方案审计。R2 已实施的 WS1/WS3 成果（released 守卫、竞态测试、生命周期核实记录）在 R3 中原样保留并继续受审计覆盖。

| 5 | R5 | yes | No blocking findings | NB-01（slice 4 需显式“abort 已处理”完成闩）、NB-02（§17 落点 4/9/10/11 已被 WS10 替换，实施时按新测试落位）、NB-03（Last updated 日期，已修）、NB-04（E/行数估计漂移，实现审计以实际 diff 复算）、NB-05（沿留） | APPROVE | task ses_f046febc5ffe3XBzQfozzct9mi |

| 6 | R6 | yes | No blocking findings | NB-01（§19 测试行数估计漂移 ≈5 行，实现审计复算）、NB-02（沿留） | APPROVE | task ses_f046febc5ffe3XBzQfozzct9mi |

第 6 轮原话记录："**APPROVE**（plan audit，第 6 轮即末轮，audited revision: R6，full-scope：原始 7 条用户需求 + 全部保留/新增/撤回工作流 + 两轮双审计的全部 blocker 处置）。仅允许对 R6 做行政审批状态迁移：`Status: approved`、`Approved revision: R6`、`Implementation allowed: yes`，不得与设计改动合并提交。实施边界：R6 delta 仅限 daemon.ts（权限边界 + :98 注释）与 daemon.test.ts（slice 8）；提交只许包含 §15 所列文件、以工作区内容为准（§23 NB-04：index 含外来中间态，须 `git commit --only -- <paths>`），不得卷入 cold-maintenance 线程产物。任何实质性修改使本批准失效。"

R6 触发记录：R5 verified 后用户再次要求双独立审计（第 1 节 R6 原话）。两名全新审计者（task ses_efeede249ffeJ9iDVv0RaS2bDz / ses_efeede0e6ffeAVGt0DC6aFP1PY，互不通信）均 BLOCK，共性 blocker 唯一：WS8 的 unreachable 汇焦未保留 maintenanceIdle 条件式停机授权边界。primary 亲读核实：db.ts:487/604 两处条件式消费者真实存在；worker.ts:472-484 的 409 门与 daemon.test.ts:1763-1767 既有合同测试直接规定权限差异；该回归系 WS8 本次引入——采信，不提复议。按政策 R5 批准失效，修订 R6 重新全量审计。

第 5 轮原话记录："**APPROVE**（plan audit，第 5 轮，audited revision: R5，full-scope：原始 7 条用户需求 + 全部保留/新增/撤回的工作流）。仅允许对 R5 做行政审批状态迁移：`Status: approved`、`Approved revision: R5`、`Implementation allowed: yes`，不得与设计改动合并提交。实施边界：acp.ts 回退至 HEAD（净零）、fatal-policy 两文件维持删除、提交只许包含 §15 所列文件（provider.ts、aisdk.ts、worker.ts、log.ts、daemon.ts + 三个测试文件），不得卷入 cold-maintenance 线程的工作区产物。任何实质性修改使本批准失效并触发新一轮全量审计。"

R5 触发记录：R4 verified 后用户要求双独立审计（第 1 节 R5 原话）。两名全新审计者（task ses_effd250cdffezM0Z2CBmc6XcFj / ses_effd92885ffegwHUskPdT8xSmi，互不通信）均返回 BLOCK。primary 按 blocker 复议规则逐项亲读源码核实：B-01（控制面无响应时 force 不可达）读 daemon.ts:100-213 确认分支结构属实，属需求原话 1"卡死要有好流程"覆盖范围且 WS3 的覆盖结论有误——采信；B-02（unverifiable 被 spawnHangingDisposerDaemon 反证）读 daemon.test.ts:224-263 确认属实，INV-03/04 验证缺口系本次删除测试造成——采信；B-03（_progressDeadline 属 policy:485 禁止项）读 policy 原文确认措辞无例外——采信；B-04（固定 sleep 违反 test/AGENTS.md）读测试现码确认两处 sleep 猜测——采信；B-05（acp cancel 不可达）亲读 node_modules stream.js 全文确认消费者从不 cancel——采信，WS7 撤回。无一项提出复议（均属实且属范围/本次引入）。按政策 R4 批准失效，修订 R5 重新全量审计。

## 23. Implementation Evidence（R6）

> R2/R4/R5 实施与审计的历史记录见 §24 第 1-3 轮；本节为 R6 批准 revision 的实施证据。R6 delta 仅限 daemon.ts（权限边界 + :98 注释）与 daemon.test.ts（slice 8），与第 6 轮批准边界一致。

### R6 Delta Evidence

| File | Change | Lines (numstat vs HEAD，R6 完成后全量口径) |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | +22 / -10（WS8 判别 + R6 排除分支 6 行（含 3 行注释）+ :98 注释改写 1 行） |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | +216 / -0（R5 的 +155 + slice 8 的 +61：hung 条件式夹具、`_setLockPath` 隔离、三断言） |

- Slice 8 red（2026-10-03，`packages/opencode`，`-t "conditional maintenance stop"`）：1 fail——`rejects.toThrow("Failed to request opencode daemon shutdown")` 失败，当前 R5 代码对 hung owner 的条件式 stop 进入 force 分支杀进程（未抛错）。
- Slice 8 green：R6 排除分支后同命令 3 expects pass（抛错 + 进程存活 + lock 不动）。
- 共存回归：slice 7（显式 stop hung owner force）同轮复跑 4 expects pass——两方向互不侵蚀。
- 全套件：`bun test test/cli/tui/daemon.test.ts --timeout 120000` → 49 pass / 0 fail（508.9s）；`bun typecheck`（packages/opencode）干净。其余套件（provider/log/core）R6 delta 未触及，R5 复现结果沿用（实现审计独立复跑为准）。

R6 E/C delta（实现审计复算口径）：E +62（daemon 排除分支 3 代码 + slice 8 测试 59）；C +6（排除分支 3 + :98 改写 1 + 测试 2）。累计 E ≈428 / C ≈72（≈16.8%，以审计者复算为准）。

## 23a. Implementation Evidence（R5 归档）

> R2/R4 实施与审计的历史记录见 §24 第 1-2 轮；本节为 R5 批准 revision 的实施证据。

### Actual Files and Diff

`git diff --numstat HEAD`（2026-10-03，R5 实施完成后，工作区口径）：

| File | Change | Lines (numstat) |
| --- | --- | --- |
| `packages/opencode/src/provider/provider.ts` | modify | +9 / -0（released 守卫保留；`_progressDeadline` 导出已删除，相对 HEAD 无足迹） |
| `packages/core/src/aisdk.ts` | modify | +7 / -0（R2 保留，不动） |
| `packages/opencode/src/cli/cmd/tui/worker.ts` | modify | +14 / -16（内联策略 + `await Log.close()` 保留；WS11 注释口径修正为策略边界表述） |
| `packages/core/src/util/log.ts` | modify | +27 / -1（R4 保留，不动） |
| `packages/opencode/src/cli/cmd/daemon.ts` | modify | +17 / -10（WS8：requestStop 判别 rejected/unreachable；unreachable 汇焦既有 force 分支） |
| `packages/opencode/src/cli/cmd/acp.ts` | 净零 | `git diff HEAD` 为空（WS7 已按 R5 回退） |
| `packages/opencode/test/provider/provider.test.ts` | modify | 竞态回归重写为生产 seam（plugin custom provider ×2 + globalThis controller 注册 + text-delta 就绪 + cancel 完成闩 + 控制组日志轮询） |
| `packages/opencode/test/cli/tui/daemon.test.ts` | modify | +155 / -0（spawnProbeDaemon + pollFileContains 辅助；WS9 两策略测试；WS8 hung 控制面 force 测试） |
| `packages/opencode/test/util/log.test.ts` | modify | +65 / -0（R4 内容保留） |

生产文件 5 个（provider/aisdk/worker/log/daemon，用户上限 6）；生产行数 ≈+74/-27（用户上限 1200）。与 §15 一致，无计划外文件。

### Red-Green Test Evidence

- Slice 7（WS8 hung 控制面）：red=`-t "control plane never responds"` 1 fail（stop 抛错退出，exitCode≠0）；WS8 后 green（Force-stopped + pid 消失 + lock 清理）。
- Slice 5（WS9 rejection 存活）：当前策略下 1 pass；敏感性 red=临时在 rejection handler 恢复 `gracefulShutdown` 调用 → 1 fail（ping 失败，daemon 自杀）→ 恢复后 green。
- Slice 6（WS9 exception 优雅拆解）：当前策略下 1 pass；敏感性 red=临时摘除 `gracefulShutdown("uncaughtException")` → 1 fail（22.5s，进程未有界退出）→ 恢复后 green。
- Slice 4（WS10 生产 seam 竞态）：当前守卫下 1 pass；red 证明=临时删除 `if (released) return` → 1 fail（cancelled 组 sse.end 出现在日志 delta 中）→ 恢复后 1 pass。实施中发现并修正一个 seam 事实：SDK 实例按 provider 共享、fetch 闭包捕获首个加载的 model，同 provider 双 model 时 telemetry 的 modelID 不可靠（实测 requestID=2 的 body 为 race-normal 但 modelID 记为 race-cancelled）；改为双 provider（race-a/race-b）以 providerID 判别——该修正只影响测试夹具，不改变被测生产路径。
- Slice 1-3（R2/R4 保留项）复跑：provider 全套件 351 pass、log.test 6 pass 中均包含。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/provider/provider.test.ts -t "cancel during in-flight pull" --timeout 60000` | `packages/opencode` | 1 pass（生产 seam 版） |
| `bun test test/util/log.test.ts --timeout 30000` | `packages/opencode` | 6 pass / 0 fail |
| `bun test test/provider/ --timeout 60000` | `packages/opencode` | 351 pass / 0 fail |
| `bun test test/cli/tui/daemon.test.ts --timeout 120000` | `packages/opencode` | 48 pass / 0 fail（314s；含 WS8/WS9 三新测试） |
| `bun typecheck` | `packages/opencode` | 干净 |
| `bun typecheck` | `packages/core` | 干净 |
| `bun test --timeout 60000` | `packages/core` | 368 pass / 0 fail |

### Original Feedback-Loop Result

生产症状反馈环以 slice 4 承载（生产 seam，red/green 均已实测）。原始事故链（cancel 竞态 → rejection → 整机自杀 → TUI 全灭）的三处分歧点分别由 slice 4（源端不写）、slice 5（rejection 不自杀）、slice 6（exception 优雅拆解）行为钉住；卡死恢复链由 slice 7 闭合。

### Actual Secondary and Replacement Path Inventory

与 §11 一致：AbortError 错误分类（保留）、`daemon stop` graceful→force（保留并由 WS8 补上 unreachable 入口）、unresponsive 复用（保留）；FFI 句柄遍历/工具 spawn 包装器（rejected，未实施）；acp cancel 摘除与 `_progressDeadline` 导出（rejected，已回退/删除）；无新增 alternate success path；诊断面仅为日志。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ≈366 | production ≈71（provider 4 + aisdk 4 + worker 20 + log 20 + daemon 23）；tests ≈295（provider.test 109 + daemon.test 144 + log.test 42）；excluded：import-only、空行、纯注释行；acp 净零不计（实现审计第 3 轮独立复算口径，按政策以审计者复算为准） |
| Qualifying Chinese comment lines `C` | ≈66 | 实现审计第 3 轮独立复算口径 |
| Ratio `C / E` | ≈18.0% | — |
| Required minimum `C` | max(1, ceil(366×0.15)) = 55 | 达标 |

代表性注释：worker.ts「进程级错误裁决（策略边界，非运行时保证）……」（WS11 修正后口径）；daemon.ts「rejected 是控制面应答后的业务拒绝……unreachable 是请求根本未获应答……显式 stop 不能被挡在恢复路径之外」；provider.test.ts「SDK 实例按 provider 共享……providerID 随 SDK 实例区分，两组判别必须用 providerID（实测踩坑后定型）」「cancel() 的返回值是结构性完成闩…… buggy 遥测写入若存在必已在日志 FIFO 中排队」；daemon.test.ts「/shutdown 永不答复，模拟控制面卡死……否则卡死 daemon 没有任何可执行的恢复流程」。

### Remaining Unverified Items

- aisdk.ts wrapSSE 无专用行为测试（R2 批准的 unverifiable 说明不变）；由同构模式 + typecheck + core 368 套件覆盖。
- 生产逃逸路由（AI SDK 管道内部）未逐跳定位；源端不再抛错后该路由无输入，见 §20 风险节。
- 并发工作区事实：index 中被另一线程 `git add` 了本任务文件的 R2/R4 中间态（acp.ts 含摘除版、provider.ts 含 `_progressDeadline`）；工作区为 R5 终态。任何提交只许包含 §15 所列文件，且须以工作区内容为准（`git commit --only -- <paths>`），不得提交 index 中间态，也不得卷入 cold-maintenance 线程产物。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings | NB-01（已解决：注册点注释改写为真实约束）、NB-02（已解决：§23 按 auditor 复算修正）、NB-03（记录级：并发 cold-maintenance 线程导致 typecheck 暂时性错误，与本 diff 无关） | APPROVE | task ses_f0443de28ffeKo6UnFDFDpkBGy |
| 2 | R4 | yes | No blocking findings | NB-01（记录级，已解决：§16 acp 说明删除“既有 CLI 套件”表述）、NB-02（记录级，已解决：§23 E/C 按 auditor 复算修正为 E≈154/C=46）、NB-03（沿留：提交边界警告） | APPROVE | task ses_f0443de28ffeKo6UnFDFDpkBGy |
| 3 | R5 | yes | No blocking findings | NB-01（环境级：effect-flock 压力测试在审计并行负载下抖动一次，隔离复跑全绿，与本 diff 无因果）、NB-02（外观级：unreachable 入口下 force 分支进度文案仍写 Graceful stop timed out，纯文案精度）、NB-03（记录级，已解决：§23 E/C 按 auditor 复算修正为 E≈366/C≈66）、NB-04（沿留：提交边界——index 含外来中间态，提交须按 §15 显式列路径、以工作区为准） | APPROVE | task ses_f0443de28ffeKo6UnFDFDpkBGy |
| 4 | R6 | yes | No blocking findings | NB-01（外来线程工作区破坏：cold.ts 重构中间态致整包 typecheck 红，错误 100% 为 cold 成员查找，被审 8 文件零错误；提交边界升级——cold 线程完成调用方迁移前不得同批提交）、NB-02（记录级，已解决：slice 8 注释方向词“上面”改“下方”）、NB-03（记录级，已解决：E/C 按 auditor 复算修正为 E≈428/C≈72） | APPROVE | task ses_f0443de28ffeKo6UnFDFDpkBGy |

第 4 轮原话记录："**APPROVE**（implementation audit，R6 第 1 轮，full-scope：全部 7 条用户原话 + R6 批准计划 + 8 个实际变更文件 + fatal-policy 删除 + acp 回退及其生产-消费链）。裁决仅覆盖：计划 R6（approved revision: R6）+ 工作区 diff（provider.ts、aisdk.ts、worker.ts、log.ts、daemon.ts、provider.test.ts、daemon.test.ts、log.test.ts；acp.ts 净零回退）。沿留事项（均不阻塞，已入册）：(a) D3 socket 继承 Open Decision 留给用户；(b) aisdk wrapSSE 无专用行为测试（批准的 unverifiable 理由）；(c) 提交边界警告（NB-01 升级版）：index 含外来中间态且 cold.ts 当前类型破损——提交只许含 §15 的 8 个文件、以工作区内容为准（`git commit --only -- <paths>`），不得提交 index 中间态或卷入 cold-maintenance 线程产物；外来线程完成 cold.ts 调用方迁移前，整包 typecheck 不会转绿，这不构成本 diff 的阻塞，但构成本 diff 与外来改动同批提交的阻塞。"验证命令独立复现：daemon 全套件 49/49（568s，含 slice 8）；slice 8 与 WS8 隔离复跑各 1 pass；竞态回归 1 pass；log.test 6 pass；provider 全套件 351/351；opencode typecheck 红外来归因（被审 diff 零错误）；core 未触及（R6 无 core 变更，R5 轮 368/368 + typecheck 干净对同内容有效，numstat 已核）。

第 3 轮原话记录："**APPROVE**（implementation audit，第 3 轮即末轮，full-scope：全部 7 条用户原话 + R5 批准计划 + 8 个实际变更文件 + fatal-policy 删除 + acp 回退及其生产-消费链）。裁决仅覆盖：计划 R5（approved revision: R5）+ 工作区 diff（provider.ts、aisdk.ts、worker.ts、log.ts、daemon.ts、provider.test.ts、daemon.test.ts、log.test.ts；acp.ts 净零回退）。沿留事项（均不阻塞，已入册）：(a) D3 socket 继承为 Bun 运行时行为，残余 ~90s 检测延迟，§20 R5 已修正记录（TUI 心跳看门狗存在于 sdk.tsx:134-141，未触发原因定位属另行立项），Open Decision 留给用户；(b) aisdk.ts wrapSSE 无专用行为测试（批准的 unverifiable 理由）；(c) 提交边界警告 NB-04——index 含外来中间态，提交须按 §15 显式列路径、以工作区为准。"验证命令独立复现：生产 seam 竞态回归 1 pass；log.test 6 pass；provider 全套件 351/351；daemon 套件 48/48（322s，含 WS8/WS9 三新测试）；packages/opencode typecheck 干净；packages/core typecheck 干净 + 套件 368/368（隔离复跑）。

第 1 轮原话记录："**APPROVE**（implementation audit，第 1 轮，full-scope：原始需求 + R2 批准计划 + 全部 6 个实际变更文件及其生产-消费链）。裁决仅覆盖：计划 R2（approved revision: R2）+ 被审 diff（provider.ts、aisdk.ts、worker.ts、provider.test.ts 四个修改文件及 fatal-policy.ts、fatal-policy.test.ts 两个新增文件，含 NB-01 的注释文本修正）。提交边界警告：工作区现存另一线程的未完成 cold-maintenance 编辑（test/storage/cold*.test.ts，typecheck 红），任何提交必须只包含上述 6 个文件，不得卷入外来中间态。"验证命令独立复现：race 回归 1 pass；fatal-policy 2 pass；provider 全套件 351 pass；daemon 生命周期 45 pass；core 套件 368 pass；packages/core typecheck 干净；被审 diff 类型干净。

第 2 轮原话记录："**APPROVE**（implementation audit，第 2 轮，full-scope：全部 5 条用户原话 + R4 批准计划 + 7 个实际变更文件及其生产-消费链）。裁决仅覆盖：计划 R4（approved revision: R4）+ 被审 diff（provider.ts、aisdk.ts、worker.ts、core/util/log.ts、cli/cmd/acp.ts、provider.test.ts、test/util/log.test.ts）以及 fatal-policy 两文件的工作区删除动作。两个沿留事项（均不阻塞，已在计划 §20/§23 入册）：(a) WS6/D3 listen socket 继承为 Bun 运行时行为（探针实证无自有修复 seam），残余仅 ~90s 检测延迟、无正确性危害，作为 Open Decision 留给用户；(b) 提交边界警告——任何提交只许包含上述 7 个文件，不得卷入 cold-maintenance 线程的工作区产物。"验证命令独立复现：race 回归 1 pass；log.test 6 pass；provider 全套件 351/351；daemon 生命周期 45/45（319s）；packages/core typecheck 干净 + 368/368；packages/opencode typecheck 全绿（cold 线程中间态已完成，第 1 轮 NB-03 记录项随之关闭）。
