# Canonical Implementation Plan: SessionRunner 总期限取消归属与 Linux Cold V3 首次冻结验证

> Status: verified
>
> Revision: R3
>
> Approved revision: R3
>
> Audit mode: full-scope
>
> Requirement source: §1 用户原文；原 #5 Linux Guard Core 清理与新 dev1 Linux Cold V3 红测
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-22 HKT

固定实施基线是官方 `dev1-smark` `2dd92595352fad252ac11fc390af2affd1534f51`，tree `e0b56c0ff7ecacebe8d1b52ef3bf547e161f9bd9`。本文覆盖这一基线到 #13 单提交目标的完整差分：原 provider 总期限取消归属，加上新暴露的 Cold V3 Linux 验证问题。原 #13 已有审计和线上结果只作为复验参考。实际发布只更新现有 #13；由用户决定并执行合并。实现终态为 `verified-implementation-and-commit`。

## 1. Verbatim Requirement

> 我已将对应的11合入，你可以进行剩余操作，同时去解决我们既有的各类测试test红测的问题。

> 你可以去检查一下对应的静态问题，然后保持最小修改。

> 如果那个东西已经通过了，那我可以去选择合并PR都可以。你自己看一下，就是反正现在暴露了一些这个test问题，test问题需要进入到你的这个PR的一个新的commit，或者说新的PR都可以。

来源：用户消息 `Sentinel_9a4c3eb4956c8191a0de0f57220c05d2` 末两句，讨论 #11 的合并和基线中已发现的测试问题。

> 同时当前test又暴露了一个Linux的问题，参与到PR 13的修改。

对应 [dev1 Linux job 137122490076](https://github.com/SMARK2022/opencode/actions/runs/44994495844/job/137122490076)。只修复该 Linux 用例暴露的问题，保留既有冻结与业务验证；#12 的已合入内容只作为真实基线。#13 对 dev1-smark 保持单提交，不改 Gate、Guard、get，不增加测试实例或以新 timer／固定等待支持测试。

## 2. Explicit Non-Goals

不改变 provider 或 Session 的公开接口、配置默认值、时限、Clock、调用次数、取消原因、输出投影、缓存、存储、权限、重试策略或 Gate。保留 transport、LLMClient、legacy/native-runtime、Core timeout 工具和锁定的 Effect 依赖。Provider 的现有用例、项目测试入口和原 preload 不改。600 秒是症状的时长，本方案不改生产计时器，不新增测试计时器。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md`“V2 Session Core”与“Testing / Type Checking” | SessionRunner 归 Location；同一 turn 仅一次 `llm.stream`；保留共享取消和恢复；从包目录验证 |
| `packages/opencode/AGENTS.md`、`packages/opencode/test/AGENTS.md` | 用现有真实数据库/线程夹具；并发验证等真实信号，禁止以固定等待换取稳定 |
| `CONTEXT.md` 的 Session Drain、Safe Provider-Turn Boundary | 进程内 drain 的完成与单次 provider 生命周期要一致，不改变持久化边界 |
| `.opencode/policy/first-principles-engineering.md`、`docs/guides/workflow.md` 和 canonical template | 单一执行路径、原因就地修复、原反馈、单独方案与实施审计 |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 与本变更无重叠决策，无需新增 ADR |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 原 provider 红转绿的历史 `4555` commit/tree 及其父 `db536`、`2808abcc` | 该历史基线只合入 #11 五个 OpenCode 路径及其 Plan，未改本链的 Core 代码、测试、原 preload 和锁 | observed |
| `packages/core/src/session/runner/llm.ts:550–605` | 单次 provider 流、总期限、失败时 publisher flush 及原可中断执行位置 | observed / contracted |
| `packages/core/test/session-runner.test.ts:1287–1352,1766–2046` | 原 TestClock 默认／显式／禁用合同，以及由真实 runner、registry、子 Session 和可中断 Deferred 组成的原用例 | observed |
| 锁定 Effect 的 `dist/internal/effect.js:948–971,1465,2075–2087,2105–2120,2502–2508` | `timeoutOrElse` 的竞速、立即启动的 daemon 子 fiber、时钟 sleep 与 scoped fiber 的注销行为 | observed |
| [#5 原 Linux Guard job](https://github.com/SMARK2022/opencode/actions/runs/44928048203/job/136918673031)，官方制品 14717192065 | Core 包一个 afterAll 报 600000、60000、30000、1000 四个句柄，无子进程；OpenCode 分片另有两个业务失败 | observed |
| 私有 `pr5-core-llm-ab.k9cuuB`，清单 SHA-256 `d9c470d10d374b6698e595865ff0b7e8633bf1ab243a00d4543b7a8b8f6eda11` | db536 与当时 #5 d1ef 原用例并行：各只留一个 600000；候选源 owner 与新 #5 2a4a 对应文件逐 blob 相同 | observed |
| 私有 `pr5-core-600-fiber-proof.NK8Vcg`，清单 SHA-256 `5fd56817f853054ae674db7167e1a25c22c2e2f8b8b67e4159704e2ed4a8d3a4` | 原用例中父中断、父终态、迟到子 fiber 启动、原计时器分配的因果顺序；没有测试源变化 | observed |
| 私有 `pr5-core-600-contract-pair.qHEJWc`，清单 SHA-256 `bbb5efba8f6543bf626abe7ec97cd22720ade2a640b92d2b2731e28f6d742878` | 相同两条原用例在只读基线和仅作用域归属改变的内存投影之间的红绿 | observed |
| 官方 `2dd9259`、原 #13 `6594748` 与合成提交 `c8956689` | 现行基线含 #12 原夹具变更；旧 #13 仅两路径、候选树 `bfe688ede2c14af3504c7ac19f19c09cf0571926`。旧合成 CI 只是 provider 路线的历史对照：[Linux Core](https://github.com/SMARK2022/opencode/actions/runs/44995009048/job/137124047319) 1281 pass、9 skip、0 fail（71s 自然结束）；[原 9 场景 A/B](https://github.com/SMARK2022/opencode/actions/runs/44995009054) 通过 | observed |
| [基线 Linux job 137122490076](https://github.com/SMARK2022/opencode/actions/runs/44994495844/job/137122490076) | Cold V3 `first freeze keeps progress responsive (update)` 在 2312.94ms 失败，`cold-v3.test.ts:384:21` 实得 ticks=0；同组 preserve/delete/activity/cancel 通过 | observed |
| `packages/opencode/test/AGENTS.md` 与 `test/storage/cold-v3.test.ts:260–398` | 测试同步必须按可观测事件；已存在的 UPDATE 注入位于 Part 第二次 lease 检查，后续冷引用和公开读取断言独立于前面的 tick 检查 | observed / contracted |
| `packages/core/src/storage/cold-maintain.ts:628–654`、`cold-codec.ts:1392–1453` | 读取批次 → 真实 Worker 的 pack 请求/回复 → 二次 lease、取消核对 → 短写事务，明确真实 worker 路线和诊断边界 | observed |
| 同文件冷读用例 `cold-v3.test.ts:53–93`；私有 `pr13-channel.gM4zVe/PASSIVE-SHA256SUMS` | 先登记 real Worker 回复观察的既有模式；后者显示物理线程与 ID、正控及两种缺信号负控 | observed |

Provider 历史基线 `4555` 及当前 `2dd9259` 均为相同关键 blob：runner `6a3023d71065daec40223e0257ec8ac02ee25461`，测试 `dd3897b1855b8deb8f33b5fa1c4be098dfff431d`，原 preload `b000b0bfec035161a3df2d32f951daf33bd0da70`，锁 `b8df0beac78938ebd6f2a7d971d457ccd5e50694`。计划实验在已核验字节等价的 db536 投影中运行，**不是**声称已在 4555 完整交付树或最新 #5 上运行。当前 Cold 测试/维护器/编码器 blob 依次为 `297b5b9d992d56be673053f0fa1373f214c7a683`、`dde1b3959edbd3cb5f6f8c8fc7a80a33c94a0d20`、`ef7f368976ff36e9b37755df43eade10d4cfd7e2`。本修订按实际 2dd9259 与完整候选进行验证。

## 5. Current Behavior

```text
SessionRunner 单次 turn -> 既有 LLMClient.stream 和消费队列
  -> 对整个消费过程设置同一次总期限 -> 返回原结果或原 LLMError
  -> 既有 publisher.flush、取消投影及原重试
```

`model.timeout === false` 直通；其他情况用给定数值或 600000 ms。期限覆盖整个消费，不因收到 chunk 重置。当前 `Effect.timeoutOrElse` 竞争的两个子分支由 Effect 立即以 daemon 方式启动。取消可在首分支注册期限之前重入，使期限在已终止父操作之后才分配。

首次冻结已有真实压缩、写前复核及公开回读。测试先为一个可冻结的 Part 写入初始值；待原编码完成、写事务未开始时，同一 lease 测试回调改写同一健康热行。独立的 1ms interval 只计宿主回调次数，任务结算时立即清理。原 Linux 失败发生在计数断言，发生在验证热行、更新值和公开回读的断言之前。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantee | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 未配置、显式数值、`false` | 原模型设置 resolver | 合法期限与禁用语义已解析 | Provider 消费的现有期限边界 | SessionRunner 当前 turn | contracted |
| 正常 EOF、流失败或期限到达 | 真实 LLMClient 流 / 原 Effect Clock | 原 transport 取消、错误及分片合同 | 原 consume → flush → 退出结果／重试 | 原消费和错误处理 | contracted / observed |
| 用户取消、中断 foreground 子任务 | Session 取消与 Task 对原 fiber 的中断 | Effect 流与原 Deferred 可中断；没有不可取消的模拟 Promise | `Fiber.interrupt` → 正在启动的期限竞速 | 当前 provider 操作作用域 | observed |
| 首次冻结期间原 Part 保持可用，并在写前发生一次既有 UPDATE | 基础真实 DB 夹具、运行时 checkpoint/lease、原 worker `pack` | Part 归当前 Session；快照不持有跨 Worker 写事务 | `runMaintenance` → Part prepare → worker → lease/commit → 公开回读 | ColdMaintain 与测试夹具各自边界 | observed / contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 完成、失败或取消后，单次 provider 操作不留下自己的活动期限 | 原失败句柄与当前因果追踪 | 原 canonical Task 用例 + stock leak preload |
| INV-02 | 一次全流期限；默认 600000 ms、显式数值、`false` 与原结果相同 | 原模型解析和虚拟时钟对照 | 原 total timeout 用例 |
| INV-03 | 到期继续生成同一 LLMError；原输出 flush 位置和成功／失败分类、取消原因、重试与恢复维持 | `llm.ts` 现有退出路径与配对结果 | 两条原用例 |
| INV-04 | 仅原一个已有生产文件；新增要求限既有测试夹具，无新测试实例、计时器、配置、依赖、Gate/get 或发布范围 | 用户原文及实际路径审计 | 精确全差分与必要原 Gate |
| INV-05 | 真实首次冻结工作尚未结束时，宿主能在真实 Part 维护尚未结算时处理其异步编码回复；本例不要求一个无关的 1ms interval 抢先 | 原冷存储线程路径与 Linux 断言差异 | 原 `first freeze keeps progress responsive (update)` |
| INV-06 | 保留写前 UPDATE 的真实 lease 触发、未写冷引用、更新后的完整公开 Part；preserve/delete/activity/cancel 语义不变 | 原夹具及下游断言 | 原同组五例与全文件 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | 父操作已中断并进入终态，`raceAllFirst` 仍启动期限 daemon，未注册进一个可在原操作结束时回收的 scope | 通用分叉实现位于锁定 Effect；当前代码可修的第一边界是 SessionRunner 把新期限直接交给该竞速的方式 | 父 1115 在 seq1197 被 1107 中断；期限子 1135 在 seq1203 首次运行，此时父已经 Failure/Interrupt；seq1204 分配，afterAll 未中断子 fiber。实际 timer 栈由 `Clock.sleep` 到 `raceAllFirst` |
| INV-01 后果 | 一个活跃的 600000 句柄进入原 afterAll 无泄漏断言 | 原 preload 只报告，不分配该计时器 | 独立原用例，与 MCP 两句柄及未知 1 秒分开 |
| INV-05 | 当前夹具将不相关的 1ms interval 执行机会作为实际 Part 冻结可调度性，完成即清空 interval；零 tick 无法显示 Part 是否让出过宿主回合 | 冻结测试中的进展观测窗 | 主线原症状和同源定向红诊断；继续用真实 Worker 回复在宿主回调的因果链验证绿色替代 |

原入口（从 `packages/core`；固定 Bun 1.4.4、原锁、原 preload、私有仅环回环境）：
```sh
bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts -t 'executes and resumes canonical task sessions with durable results and scoped permissions|bounds active provider streams by total timeout and respects explicit timeout or false'
```
同一两条业务用例均 pass，原实现再因单个 600000 句柄退出 1；私有作用域投影下两例 pass、清理不报错、退出 0。业务断言无弱化，测试独立于原 afterAll 是否报错。

Linux 验证信号：在实际主线 job 发现的首个不同行为是宿主 interval 回调计数在清理时仍为 0。相同 `2dd9259` 源的私有原用例自然跑为 1 pass、exit 0；只匹配本例原 `ticks++` 的 1ms 回调并延后到观察窗外（其余 interval 调度、真实 DB、Worker、清理不改）的诊断对照准确重现 `384:21` got 0、1 fail、exit 1。自然失败与受控对照分别记载；此探针不用于绿色验收或正式代码。证据在私有诊断目录 `pr13-2dd-cold-tick.qK9dkT`；原入口日志 SHA-256 `ca59c28146c910f445106bd2c5a70b7f5dbd626485579a5e1a94001e2eb072bc`，受控日志 SHA-256 `c5a54b31caeec102bef49ccee27aa0a7b9820397b007bd363fb1ef67a513ae52`。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 每次 provider 操作总期限的纤程 | `core/src/session/runner/llm.ts` 现有期限操作 | 原消费过程结束后不再有活跃期限分支 | 本模块知道当前 provider 操作何时开始、结束和被取消 | Caller/transport 不同时持有消费与期限；通用 timeout 工具与 MCP 不在本批准路径 |
| 错误、flush 和重试 | 原消费与 SessionRunner 的后置代码 | 保留同一 Cause、原输出/取消投影与重试 | 修改只替换期限的所有权 | 不另建错误转换、状态、队列或统一调度 |
| 冻结进展见证 | 既有 `cold-v3.test.ts` Part 首次冻结夹具 | 证明实际工作仍在进程期间，宿主可接收当前 worker 的真实匹配回复 | 只有测试需要观测该关系；生产主路径已有真实 Worker 边界 | 维护器不应为测试新增 hook、时限或保证每 1ms 调度；原 DB/Worker owner 不变 |
| UPDATE 后旧快照的写前复核 | ColdMaintain/ColdStorage 原事务 | 保留热 Part，新值通过公开入口回读 | 原二次 lease 触发既有测试写入，有真实业务断言 | 测试观察不足不能变更生产事务或搬动注入点 |

## 10. Single Approved Primary-Path Design

在原期限表达式内捕获当前 `model.timeout` 到局部常量，保留 `false` 的直接分支。对启用的原总期限，在 **当前 provider 消费** 的窄 `Effect.scoped` 中，以 `Effect.forkScoped` 先把原 `Effect.sleep(timeout ?? 600_000)` 后的同一个失败分支登记为作用域资源，再用原 `Effect.raceFirst` 比较 provider 消费和 `Fiber.join` 结果。不增加第二个 sleep、备用超时或额外调用；`Effect.suspend` 只保证原 LLMError 在期限到达才构造。使用现有 `forkScoped` 的调度，不另设起点、倍数或重试。

```text
原模型设置 → 当前操作拥有一期限 fiber → 原消费 / join 竞争
  → 作用域统一结算期限 → 原 flush、Cause 传播、取消与重试
```

范围从原 deadline 表达式开始并在其结果边界结束；原 publisher flush 保留在外侧同一位置，外层 `uninterruptibleMask/restore` 不动。提前登记意味着后续即使在竞争子分支登记前结束，已挂到 scope 的计时结果不再依赖那一步清理，原计时器随其 fiber 取消；不在计时器文件、终态或 Gate 增加兜底。

Cold V3 的 update 原例使用实际 Part worker 的原回复作为进展证据。只在该例维护调用期间观察现有 pack RPC：只接受当前维护第一次 Part lease 后的 `pack`（`op === "pack" && input.owner === "part"`），用同一 Worker 的请求 ID 关联回复。在该 worker 的 EventEmitter 现有处理器前登记被动监听，匹配同一 ID、正的 threadId 和成功回执时同步记录，并解绑一次性监听（已有 producer 尚未由原 listener 结算）。实际 postMessage、原 transfer 清单、原回复和原监听完全照常。测试不等待观察事件、不发自己造的 worker 消息、不延迟回复。结束时无条件还原拦截并解绑观察，比对既有 UPDATE、热行、公开读回。其余四例的原输入、调度与断言不动；不新增定时器、超时、生产 hook 或测试实例。这项断言证明宿主完成真实 worker 的异步回执分发；它不为无关请求、任意回合截止点或吞吐另定合同。独立 MessageChannel 也可能和合法快回复竞速，已排除；同一 Worker 的原 `message` 事件与监听器顺序提供因果先后。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- |
| `timeout === false` | 原合同直通 | 是，消费本身 | 新增 0% | 保留 |
| 有期限下原消费成功、原流错或期限失败 | 同一主路径的三个正常终态 | 仅原消费成功 | 无新增判断 | 保留，替换期限的资源所有权 |
| UPDATE 首次冻结观察原 Worker 的真实匹配回复 | 既有测试的原生产事件 | 否 | 生产 0% | 仅原测试内观测；无新运行时路径 |
| 私有监测、Bun 加载时投影 | 诊断 | 否 | 生产 0% | 永不提交 |
| 未受控执行或期限失败后重新启动 | 禁止备用 | 否 | 0% | 无此路径 |

## 12. Workaround Deletion and Replacement

替换原来直接把有副作用的期限交给 `timeoutOrElse` 的这一处调用，不保留双实现。从 update 的验证窗移除每 1ms 的计数和断言；其余四例的既有调度按原合同保留。不保留 update 的旧 interval 作为备用成功路径。私有负控和诊断不进入差分。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned change | Behavioral test |
| --- | --- | --- | --- |
| 持续解决红测 / INV-01 | provider → scope → 原终态 | 只改 `llm.ts` 当前期限的归属 | canonical Task + 原 preload 红转绿 |
| INV-02 | resolver → 默认、显式或 false → 同一 Clock | 保留原毫秒和禁用逻辑 | total timeout 原用例默认 10 min／2 min／false |
| INV-03 | consume → 原 Cause、flush、退出和重试 | 保留原顺序和分型 | 两条原用例的既有业务断言；完整现有文件回归 |
| 最小修改 / INV-04 | 原规则与实际 diff | 只保留 provider 源、既有冷冻验证夹具和本 Plan | 精确路径比对、原 Gate 入口、独立实施审计 |
| #13 Linux 新红 / INV-05 | 首个 Part 读取→真实 Worker 工作→宿主处理匹配回复→维护结算 | 重设既有进展见证，只改原测试 | 原具名 update 的红绿与缺提交/缺回复的反证 |
| INV-06 | 原主路径写前 lease→ColdStorage 写入重验→MessageV2 | 保留原 UPDATE 注入与原断言 | update 原热行与公开 Part 断言；原五例／整文件 |

## 14. Reverse Traceability

| Proposed concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 将原期限 fiber 注册到一次操作的现有 Effect Scope，竞争时等待该 fiber | INV-01/02/03 | seq1197→1203→1204，及隔离双用例红绿 | 原 `timeoutOrElse` 只通过竞速的回调清理，注册前重入时没有已登记的期限 owner |
| 真实 Worker reply 的作用域内被动观察 | INV-05/06 | 既有 pack 协议与同文件冷读 observer；原 Linux 独立 interval 可误报 | 复用原 Worker、公开宿主事件与测试协议；原 interval 观察不了工作是否实际 yield |
| 使用原 Clock sleep、同一失败构造和原 race 结果 | INV-02/03 | 真模型设置与 TestClock 对照 | 已有实现足以继续承载；只复用，不新建错误或配置概念 |

## 15. File-Level Change Plan

| File | Action | Exact responsibility | Expected line delta |
| --- | --- | --- | --- |
| `packages/core/src/session/runner/llm.ts` | modify | 当前 provider 总期限归 scope；必要的 `Fiber` 导入；原 Cause、flush 与调用顺序保留 | 仅原期限块和导入，约 +7～11 / −2～5 |
| `packages/opencode/test/storage/cold-v3.test.ts` | modify | 只修既有首次冻结夹具的进展见证，保留真实写前 UPDATE、完整读回、同组测试数量 | 约 18 条有效变更；仅 update 的 observer、退出清理和原断言替换 |
| `docs/plans/session-provider-deadline-lifetime.md` | add | 唯一计划和审计记录 | 本文件 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why pre-R1 fails | Minimal green | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 原 canonical Task pass，但 stock 清理退出 1 | 父在故障分支登记前进入终态，后加入的期限纤程未受控 | 同一原测试在修复后无 600 秒句柄 | 前台取消、结果持久化和权限域 |
| 2 | 原 total timeout 可在未修复时验证已有合同 | 它保护正常期限与错误，不单独复现资源泄漏 | 默认、显式、禁用以及原错误和重试语义继续通过 | 每个 chunk不重置期限；原重试后恢复 |
| 3 | 原 Linux update 自然出现 0 tick，精确原树的定向私有对照同样 red | 夹具在结束前要求固定间隔恰好触发，与实际 Pack 回执没有因果关系 | 原 update 观察真实 Part Worker 的成功回执；阻断探针配对而不阻断真实业务时应 red | 原写前变更、热引用、完整公开回读和原同组其余四例 |

不新增用例、检查开关或临时源码留痕。Cold V3 原五例的测试数量、输入、更新注入、原删除及取消信号照旧。维护诊断的探针和两类控制不进入正式 diff。私有探针仅定位首次分歧；验证接口为现有生产调用及原清理检查。

## 17. Comments

一到两条邻近中文注释解释 **为何在竞速前登记期限资源**，以及有需要时说明消费结果与期限子 fiber 的作用域边界。不要翻译函数名。实施记录实际 E/C，排除空白、import-only、formatter-only、生成和 pure-move；满足用户 15% 门槛。Cold 夹具只解释：为何必须绑定此次 Part 请求、为何要在原 handler 前观察回执、为何在同一 finally 恢复 prototype 并解绑；按实际 E 和有意义 C 计算。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| §8 原二例命令，在确切 2dd9259 基准、实际精确候选各一次 | `packages/core` | 同锁原红转绿，无间接计时器修改 |
| `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts` | `packages/core` | 原 SessionRunner 场景照跑，自然终止；任何独立既有失败单列，不能忽略 |
| `bun run typecheck` | `packages/core` | 原包类型检查 |
| `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/storage/cold-v3.test.ts -t 'first freeze keeps progress responsive'` | `packages/opencode` | 原五例同组回归，原 probe 只在私有反证另跑 |
| `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/storage/cold-v3.test.ts`；`bun run typecheck` | `packages/opencode` | 完整原文件、正常退出和类型；验证零净增用例与资源回收 |
| `bun script/guard/check.ts . --changed-since 2dd92595352fad252ac11fc390af2affd1534f51 --files packages/core/src/session/runner/llm.ts,packages/opencode/test/storage/cold-v3.test.ts,docs/plans/session-provider-deadline-lifetime.md` | 同一实际候选仓库根 | 原架构、变更路径与实际出口 |
| 当前原 Gate 的所需契约、选测及适用 A/B；批准后按真实目标 SHA 取得原回执 | 已授权的当前仓库／原 GitHub 检查 | 用最新实际基线和同一实际候选验收；不能用历史窄绿替代 |

Phase 1 结果已实测：原两例 2 pass、单个 600 秒 afterAll 红、exit 1；窄范围的同环境加载期投影 2 pass、0 fail、exit 0，正常默认/显式/禁用期限、原超时报错、flush/retry 和中断的原断言均通过。两边使用相同 Bun、测试、锁和 preload。作用域投影只在临时目录，未产生可交付差分。

Cold V3 Phase 1：固定 `2dd9259` 的真实 DB/Worker 私有装配，观察版诊断文件 SHA-256 `322bfc420144d3e6be7744c8d26ac79171ef9226449ee7b5dc91180c14b7b1ae`。原 update 观察到同一个原 Worker 的 `PART DISPATCH 7 1` 和 `PART REPLY 7 1`（RPC 7、线程 1），1 pass、5 次原断言、exit 0、633.78ms。只停止测试观察的匹配 producer（生产发送仍正常）或只拒绝观察已分派的匹配回复，各保留真实 Worker/DB、各在同一观测断言变红，exit 1（858.16ms / 754.70ms）。两种控制只存在于私有诊断；正式源码无模式、日志、开关或探针依赖。精确命令、结果日志和摘要在 `pr13-channel.gM4zVe`。隔离正控不是合成 PR 线上或完整文件通过；阶段 3 须按本节用最终无探针候选验证。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| 文件 | 一份 Plan 新增，一个已有生产文件与一个已有测试文件修改，零删除 | 只有当前消费的期限 owner 需要修复 |
| 测试实例净增／依赖／Gate／配置／生成 | 0 | 原测试及同组回归保留；范围未扩张 |
| 源码 | 一个已有表达式及必要导入 | 不引出新工具、框架修补或计时器 |

## 20. Real Risks and Open Decisions

真正风险是作用域关闭改变已观察的期限合同；原 default/explicit/false、恢复与取消已有私有对照，正式阶段对实际候选再次验证。不得用强制退出或跳过原门禁取得绿灯。Cold V3 只存在一个验证职责；被动观察和原 worker 回复共用同一个事件的分发，不在跨端口的回调之间建立先后假设。用真实 Worker 与缺匹配事件反证确认，且恢复观察点。

### Open Decisions Requiring the User

更新现有 #13 的单提交并按 §18 取得新候选的原 Test、Typecheck、Guard/preflight 和适用 A/B。批准范围不含合并，合并由用户决定并执行。

### Follow-up

| Concern | Evidence | Baseline behavior | Raised in round |
| --- | --- | --- | --- |
| MCP 30／60 秒 | 已有独立精确配对及其方案 | 原测试模拟 connect Promise 不结算，与本次迟到注册不同 | R1 |
| Core 1 秒 | 整包原日志仅有 `unknown` | 窄测原用例未产生该句柄；无 owner 证据 | R1 |

### Rejected Speculation

不将 600 秒归因于 PAT、cold-v3、MCP、Git、通用 timeout 或测试线程的吞吐。没有用户证据要求改变重试数、时限或取消后的持久会话行为。

## 21. Audit Contract

独立审计严格核对 §1、完整方案、原基线到目标行为、真实 owner、原用例和私有红绿证据。完整审计须核对唯一范围、无备用路径、无诊断源码。批准绑定当前确切文件；实施差分另行独立审计。

## 22. Revision Delta and Plan Audit Record

R3 从官方 2dd9259 起完整复审 provider 和 Cold V3 update。新增用户原文、主线自然红、诊断复现、真实 worker 正控与两种缺观测负控，移除 update 对无关 1ms 定时器的依赖。前版批准、实施和审计结果不授权新差分。

R1 独立方案审计：`BLOCK`。B-01 指出 §18 的 `--files` 只接受一个逗号分隔的值；空格分隔导致 Plan 路径未纳入检查，未满足 INV-04。

R2 仅修正 §18 参数，使用一个逗号分隔的值同时传入源码与 Plan 路径。依据当前基线 `script/guard/check.ts:88–105` 核对；实现、范围和验收标准沿用 R1。

### R1 独立裁决全文（全范围）

````markdown
## Blocking findings

### B-01 静态验收命令漏掉 canonical Plan

- **Violated invariant:** INV-04。正式静态验收须覆盖实际两条变更路径。
- **Evidence class:** contracted。
- **Producer and execution path:** §18 命令 → `script/guard/check.ts` → `--files` 显式文件集。
- **Source evidence:** `script/guard/check.ts:88–105` 用逗号拆分 `--files` 的单个参数；显式文件集优先于 `--changed-since` 推导。
- **Canonical-plan evidence:** §15 列出源文件和 Plan；§18 用空格分隔它们。
- **Responsibility owner:** §18 正式验收命令。
- **Concrete behavioral consequence:** 命令只把 `llm.ts` 纳入显式检查；退出 0 不能证明同一命令检查了两条批准路径。
- **Pre-R1 baseline behavior on the same path:** 原检查器接受逗号分隔的文件集，本方案未改检查器。
- **Minimal correction direction:** 把两条路径合成一个逗号分隔的 `--files` 参数。

## Non-blocking findings

无。

## Follow-up

在精确 `4555c21e` 和实际候选上重跑原两例及 stock preload，随后执行 §18 的全文件回归、类型检查和原 Gate。

## Rejected speculation

不把另外的 MCP 和 1 秒句柄归到当前 provider 期限，也不因通用竞速实现的行为扩大修改到锁定依赖。

## Requirement and traceability coverage

独立核对了四个基线 blob、父中断与迟到期限子的追踪清单，以及原两例的配对回执。原实现两条业务用例通过，但 stock preload 留下一个 600 秒句柄；同一环境中，作用域投影两条通过并正常退出。现有 default、explicit、false 和 canonical Task 行为均有对应入口。当前实验证明的是字节等价投影的行为，正式发布树仍须复验。

## Primary-path and fallback verdict

方案把现有 deadline 预先登记到当前 provider 作用域，再用原结果竞速；`false` 直通、原到期错误和外侧 flush 位置保留。未提出第二个计时器、后备成功路径或测试弱化。

## Release verdict

**BLOCK**

适用于精确 **R1 方案**，SHA-256 `53f2fdfc0fb116f7499475889c57c14122ec43b28242ee8bfe33ee8756af2963`。修正 §18 的参数后送复审。
````

### R2 独立裁决全文（全范围，judge_pair_check）

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§22 保留了 R1 的 BLOCK 摘要。补录原裁决全文，保留审计记录；本项不改变 R2 的批准范围。

## Follow-up

在精确 `4555c21e` 和实际候选上复验原两例及 stock preload，再执行全文件回归、Core 类型检查和原 Gate。

## Rejected speculation

本次 600 秒期限与其他已观测句柄分别归因。无需修改通用调度器、锁定依赖或现有计时预算。

## Requirement and traceability coverage

B-01 已关闭。§18 现在将源文件和 canonical Plan 作为同一个逗号分隔的 `--files` 值传入，符合检查器实际解析方式。复核了四个基线 blob 和隔离对照的清单：基线两条业务用例通过，但 stock preload 报一个 600 秒句柄；相同范围的作用域投影两条通过并退出 0。R2 保留 R1 的范围、原行为和复验要求。

## Primary-path and fallback verdict

期限由当前 provider 操作的作用域持有；原消费、到期错误、`false` 直通和外侧 flush 不变。无第二个计时器或替代成功路径。

## Release verdict

**APPROVE**

批准精确 **R2 方案**，SHA-256 `4b9d096eb2bc4dd69b78a0934d50f10e7903d5d9ea3a741b9a9d28fb8cfc5aac`。登记裁决后可实施；实际差分须另经独立实现审计。
````

### R3 独立裁决全文（全范围）

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§3–4 可注明精确 2dd9259 baseline 从同级 Git 对象库 `--git-dir=../git` 读出；提供的 `src` 是已有 provider R2 投影，`llm.ts` 为 `3e4b6689` 而不是 baseline `6a3023d7`。我已分别核对 baseline Git blob、投影及 Cold 测试/维护器/编码器实际字节。Cold 回授不走 provider，投影差异不使它失效；阶段 3 仍须在干净 2dd9259 单独重跑原 provider 红臂。§19 可补上既有测试观察的预估行数，属于记录修正。

## Follow-up

按 §18 用实际完整差分跑 provider 原两例及全文件、Cold 原五例及全文件、原两包类型和 Gate；在继承原测试命令前提下确认 Worker 原型与监听在失败和成功均恢复。

## Rejected speculation

无须引入时钟阈值、延长固定等待或改生产 Worker。独立端口回合可能输给合法回复；原 Worker 同事件的监听顺序直接观察被测因果边界。

## Requirement and traceability coverage

从精确 2dd9259 Git 对象与官方基线验证原期限式，核验 provider 配对日志、原 600000ms 仅清理失败和同锁作用域绿。Cold 现有二次 lease 后提交契约和独立公开回读保持；基线 0 tick 与原断言一致，实测真实 Part RPC 7/线程 1 的正控 1/0、5 断言，两种缺观测负控各 0/1。私有文件清单与关键日志哈希通过。两条需求各有明确 owner、路径与正式回归。

## Primary-path and fallback verdict

保留同一 provider 消费及一个既有期限，先使期限归当前作用域，再执行原竞速与 flush。Cold 仅在既有 update 测试被动观察同一 Worker 的原投递与成功回复，不发新消息、不改 transfer/事务或其它四例，并恢复监听；无备用或新计时器。

## Release verdict

**APPROVE**

批准精确 R3 方案 SHA-256 `28d7cd2d72b3b96ee51fae24f7acfe8858ba44c5da4f8df563e785e4a31539aa`。本裁决只放行方案阶段。
````

## 23. Implementation Evidence

### R3 当轮实际差分和实现证据

固定实际父提交 `2dd92595352fad252ac11fc390af2affd1534f51`、父树 `e0b56c0ff7ecacebe8d1b52ef3bf547e161f9bd9`。只有本 Plan 新增，Core provider +19/−12，OpenCode 原测试 +28/−4，测试实例净增 0。生产 blob 保持 `3e4b6689638ea1a08e0ef73fc0bd0c2e829f5fde`，唯一测试后像 `a9fec21082c4931a9f1d72ea8b615d13ce9cdd30`。无其他文件或生产信号变化。原始不含 Plan 的实现差分 SHA-256 `7b62a25a021f66c206a3ab9687415751205bfcfd59a9f815370a5f803f70d7b7`。

- Core：E=13、C=2，历史精确字节不变。排除 1 行 import-only、2 行说明、3 行原封移入的错误字段。
- Cold 夹具：E=24、C=4。28 新增或实质修改行排除 4 条单行注释；没有纯移动、import-only 或排版行。4 条分别约束原 sibling 行为、Part 专属选择、同事件内观察先行和共享 prototype 清理。
- 合计：E=37、C=6（16.22%，最低 6）。Markdown 和不改变含义的原保留上下文不纳入。

真实反馈：

| 入口（均为原路径） | 固定范围与结果 |
| --- | --- |
| Core 原两条回归+原 `leak-preload`，在独立干净的 2dd 源视图 | 核验旧 provider blob `6a3023d`；2 个原业务用例通过，176 条断言，原 afterAll 捕获仅一个 600000ms timer，children[]，exit 1，2.52s |
| Core 实际候选三原文件 `session-runner.test.ts`、`session-runner-tool-registry.test.ts`、`npm.test.ts`，原 preload | 130 通过、0 失败、1,308 断言、exit 0（23.61s），含原两条目标用例；清理自然退出 |
| OpenCode 实际最终测试后像，原完整 `test/storage/cold-v3.test.ts` 与原 preload | 原文件 20 通过、0 失败、259 断言、exit 0（30.76s），五个 first-freeze 变体全部通过；update 保留原 UPDATE/热引用/完整回读 |
| 原 Core 全包 `tsgo --noEmit` | 资源约束仅使用单线程与 Go 并行/垃圾回收参数，未删输入；exit 0 |
| 原 OpenCode 全包 `tsgo --noEmit` | 三次本地单线程全包执行均遭 SIGKILL，退出 1，无 TS 诊断。原日志 `type-opencode.log`、`type-opencode-bounded.log`；第三次原日志 SHA-256 `9a8e7f5692d137b0ba58c9281bc02c11eb06417a980e2bf0956240915ea60601`。同一源码的正式型检成功，见下行 |
| 正式全包类型及生成检查 | [Typecheck 44998371081](https://github.com/SMARK2022/opencode/actions/runs/44998371081)：`generated`（137134260731）与 `typecheck`（137134260914）均成功，实际 checkout `82afe90ce895508420be0cd5dec2c48581e46a60`（`540e420557aa9d939f7197f7eb0c712e35b3ccb1` 合成进 `2dd9259`）；30/30 任务、缓存 0，OpenCode 原 `tsgo --noEmit` 实际执行 |
| 候选原静态三路径、原提交信息既有 hook、原契约 | check exit 0、0 错误、0 提示（两个 TS 路径计入，Markdown 明确列入候选）；原 `commit-msg` exit 0；原 schema/protocol 契约 exit 0 |
| 正式原 Stop | 私有运行 exit 0；静态规则和依赖选测通过，两个原 TUI 文件 35 通过、2m07s。Core/OpenCode 全量按原 Gate 转正式预检 |
| 正式原 Test | [Test 44998371061](https://github.com/SMARK2022/opencode/actions/runs/44998371061) 28/28 jobs 成功。[Linux OpenCode](https://github.com/SMARK2022/opencode/actions/runs/44998371061/job/137134261179) 5443 通过、45 跳过、0 失败，原 update 560.24ms；[Windows 会话与服务集成](https://github.com/SMARK2022/opencode/actions/runs/44998371061/job/137134261301) 3731 通过、12 跳过、0 失败，原 update 546.84ms |
| 正式原 Guard | [Guard 44998371106](https://github.com/SMARK2022/opencode/actions/runs/44998371106) 成功。[原 Linux preflight](https://github.com/SMARK2022/opencode/actions/runs/44998371106/job/137134351005) 实测 Core 1290 通过、TUI 73 通过、OpenCode 5451 通过；[原 A/B](https://github.com/SMARK2022/opencode/actions/runs/44998371106/job/137136702388) 九场景通过 |

工作目录、命令和日志在私有证据目录 `pr13-r3-stage3.5BLDQ8/evidence`（`R3-stage3-commands.txt` / `stage3-phase.sha256`），独立的 `base` 与 `candidate` 目录各自匹配上列 pre/postimage。旧 fixture 自然红及本次缺信号控制见 §8、§18；新观察无诊断 console、env 分支或额外等待。仅在 update 移除旧 interval，其他变体现成 timer/取消/删除照旧；provider 没有第二个总期限路径。独立实现审计已批准，裁决见 §24。三套正式工作流已为同一实现验收通过：已验收 PR #13 head `540e420557aa9d939f7197f7eb0c712e35b3ccb1`，合入实际基线 `2dd92595352fad252ac11fc390af2affd1534f51` 的 [合成候选 `82afe90c`](https://github.com/SMARK2022/opencode/commit/82afe90ce895508420be0cd5dec2c48581e46a60)，GitHub 校验为 clean。无需改 Gate、依赖、配置或现行主要产品行为。

### R2 历史证据

以下仅交叉核对已有 provider 修改，不作为当前完整候选回执。

### Actual Files and Diff

相对精确 `4555c21e`，仅新增本 Plan，修改 `packages/core/src/session/runner/llm.ts`。生产原始 diff +19/−12，净增 7。源文件多行排版展开作用域和原错误字面量；没有新函数、接口或额外的期限机制。测试、配置、依赖、生成文件、Gate/get 各 0 改动，测试实例净增 0。实际生产 blob `3e4b668`；完整实际 diff、路径清单及 tree 由独立暂存区导出。

E=13，C=2，15.38%，最低 2。按当前差分的新增或实质修改侧核算，排除 Markdown、1 行 import-only、2 行纯注释和原封移入的 3 行错误字段；没有空行、生成或额外 formatter-only 排除。C 解释期限必须在竞速前成为作用域资源，以及十分钟默认值与 AISDK 的兼容边界和分片不重置。具体行位置及逐行清单在实施回执。

### Red-Green Test Evidence

用 §8 既有命令、同一个 Bun 1.4.4（38afee6c8）、原锁、原 preload 和私有仅环回网络，分别在精确 `4555` 和实际候选执行。原树两个业务用例通过，176 断言，原 preload 只报 `setTimeout(600000) @ unknown`，子进程 0，exit 1，3.00 秒。候选同两例通过，175 断言，0 fail，exit 0，2.88 秒。两边 workspace 依赖名均解析到各自树的源码；第三方包复用同锁定的现有依赖。

### Verification Commands and Results

| 检查 | 工作目录／命令 | 精确实际结果 |
| --- | --- | --- |
| 完整 SessionRunner 文件 | `packages/core`，`bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/session-runner.test.ts` | 105 pass、0 fail、1182 断言，exit 0，34.58 秒 |
| 原 Core 类型 | `packages/core`，`bun run typecheck` | 原 `tsgo --noEmit` exit 0 |
| 两路径静态 | 候选根，§18 的逗号分隔 `--files` 命令 | exit 0，0 错误、0 提示。原检查器的 TS／JS 报表计 1 源文件，Markdown 仍在传入的两路径范围；精确全差分独立核对文档及源码 |
| 原契约 | 候选根，`bun script/guard/gate.ts contracts` | schema、protocol 均通过，exit 0 |
| 原 Stop | 候选根，`bun script/guard/gate.ts stop --files packages/core/src/session/runner/llm.ts,docs/plans/session-provider-deadline-lifetime.md` | 规则检查、依赖选测、TUI 两文件 35 pass，exit 0；原 Stop 决定预检转交事项见下。语音原实时时限用例自然结束 |
| 原提醒对照 | 两个树各自根，`bun script/guard/unneeded-guards.ts packages/core/tsconfig.json packages/core/src/session/runner/llm.ts` | 两边同两条既有提示（基线 370/735，候选 370/742，源码均未修改）；默认 Stop 将这一结果记录为提示 |

精确执行回执目录：`core-provider-deadline-stage3.kSmLl3/exact-replay/`。每套保留命令、cwd、Bun 和关键文件散列、原 stdout/stderr、退出码、隔离状态；两树另保留实际包解析结果和 workspace 别名映射。Gate 选测输出为该目录的 `static/affected.json`。

### Original Feedback-Loop Result

在精确基线复现了原 600 秒残留，落盘的实际候选按相同入口消除残留。全 SessionRunner 文件回归没有出现独立句柄；该结论范围为这 105 个用例。

### Actual Secondary and Replacement Path Inventory

`false` 仍走原合同直通；开启期限时消费结果和原到期错误继续竞速，外侧 flush 与恢复逻辑未改。移除原不受当前操作作用域持有的 `timeoutOrElse` 调用；无备用成功路径、诊断模块、新 timer 或测试绕过。

### Remaining Unverified Items

原 Stop 将 Core 全量（静态选择 161 文件）和 OpenCode 全量（323 文件）移交正式线上 preflight。运行时路径符合原 Gate A/B 规则，线上选测及 A/B 尚待同一目标 SHA 的真实回执。独立 MCP 30/60 秒和整包曾见的 1 秒不在此方案；全 SessionRunner 文件验证未覆盖原整包其它红点。

## 24. Implementation Audit Record

### R3 全范围独立实现裁决（原文）

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

登记本轮时同步 §23–24：原两次本地 SIGKILL 保留，正式全包型检已结束成功，R3 已获方案批准。

## Follow-up

正式 Test 44998371061 与 Guard 44998371106 尚有运行中的任务，包括 macOS/OpenCode、Windows 会话、Linux preflight 及 A/B；继续绑定当前候选验收。

## Rejected speculation

本地 SIGKILL 不作为类型错误；正式 runner 给出了同一源码的实际全包结果。

## Requirement and traceability coverage

复核原三路径差分与本轮两份官方 Typecheck 日志。`generated` 137134260731 和 `typecheck` 137134260914 都 checkout `82afe90ce895508420be0cd5dec2c48581e46a60`（head `540e420557aa9d939f7197f7eb0c712e35b3ccb1` 合成进 2dd9259）；三路径在 head 与该合成提交的 Git blob 一致。OpenCode `tsgo --noEmit` 为 cache miss、实际执行；同一 job 30/30、缓存 0，generated 也成功。原 Core 红→绿、Cold 全文件 20/0 与原 Stop 证据保持。B-01 解除。

## Primary-path and fallback verdict

同一 scoped provider 期限和原沉淀路径；Cold 继续只观察实际 Part Worker 回执，保留写前 UPDATE、公开回读与监听复原。无备用成功路径。

## Code quality verdict

无源码变化。四处变更边界依旧只覆盖批准的 provider 期限与 existing update 夹具，源文件 blob 与审计冻结一致。

## Release verdict

**APPROVE**

批准精确 R3 实现差分 SHA-256 `af389fa13247e95b153cd69b99371e645d05a56abc0c2f86c9a7acf290d2f719`；解除上轮验证 blocker。合并就绪仍待当前正式 Test、Guard 和 A/B。
````

### R2 历史实现裁决

历史精确 R2 全范围独立实现审计曾通过；R3 的方案批准在 §22，独立实现批准如下。下方原裁决绑定登记本节之前的实际差分；本次仅补写审计记录，生产 blob `3e4b6689638ea1a08e0ef73fc0bd0c2e829f5fde` 不变。

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

核对同一正式候选 SHA 的线上 preflight 和原 A/B 回执。当前 Stop 已把 Core 和 OpenCode 全量移交线上验证。

## Rejected speculation

本次差分修复已归因的 600 秒 provider 期限。独立 MCP 句柄和整包曾见的 1 秒句柄不在此差分的验收范围。

## Requirement and traceability coverage

复核了批准的 R2 原稿、精确父树、实际两路径差分和回执清单。基线原两例通过，但原泄漏检查报告一个 600 秒句柄并退出 1；实际候选同两例通过并退出 0。SessionRunner 全文件 105 例通过；Core 类型检查、两路径静态检查、Schema／Protocol 契约和 Stop 均退出 0。测试、依赖和 Gate 保持原样。

## Primary-path and fallback verdict

当前 provider 作用域持有原期限，成功、失败和中断均由该作用域收尾。原默认和显式期限、`false` 直通及到期错误仍走同一消费路径，外侧 flush 位置不变。没有第二个期限或备用成功路径。

## Code quality verdict

只改一个现有生产文件并新增一份 Plan。`git diff --check` 通过；两条中文注释解释竞速前登记资源和全流期限的边界。

## Release verdict

**APPROVE**

批准精确 **R2 实现差分**，SHA-256 `1cd068c81f7cc20b12e8ce6c0b62ac110ca230f7acfc50618f30fe51e33a5798`，候选树 `c971d78884029b6cca586fdd96a5cc00a866d8c9`。本裁决通过独立实现审计；最终交付仍按 §18 的线上门禁判定。
````

上段是历史 R2 裁决与当时的结案边界。原 #13 的部分线上证据出自旧两路径候选；新三路径完整候选要独立实施审计并按 §18 验收。
