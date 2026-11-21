# Canonical Implementation Plan: Execute / Task 取消循环等待

> Status: approved
>
> Revision: R19
>
> Approved revision: R19
>
> Audit mode: full-scope
>
> Requirement source: Sentinel_469780d04e0081919e79846d5798ae10；Sentinel_c22812742bac81919e94b01029ed82c4；§1 后续验收原文与 2026-11-20 语音原文
>
> Implementation allowed: yes
>
> Last updated: 2026-11-21

这是 PR #8 的唯一实施规范。方案从 R1 实施前的固定 HEAD `f04f9307957774ad5a21b4cfe70921a4fce20d5a` 写到完整交付态；发布另与当前 `dev1-smark` 的 `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0` 比较。两套比较共用四个生产文件和一个原 Execute 测试文件的目标字节，另增本 Plan。交付要求真实取消收敛、原 Debug、符合现行门禁的一个可恢复提交。产品范围与验证要求不变。按 §1 最新授权在既有 #8 PR 独立运行远端验证、推送候选，无需等待 #5；合并由用户决定。

## 1. Verbatim Requirement

2026-11-18 11:48:35.625972 UTC，用户消息Sentinel_469780d04e0081919e79846d5798ae10，逐字原文：

>    下面检查一个相应的问题。我目前发现呢，我当前在本地的 Xcode 工具下使用 OpenCore 进行分，就是进行这就是 Xcode 的 Execute 工具，它调用了一个 Task，然后这个 TaskMouse 调用了很多工具，就是 Task 里面又调用了很多这个 Execute 的一个读取啊、列举啊等一些操作，但是工具数量太多了，它好像是正在这种无限循环地调工具，然后好像就直接被 Interrupt 了，但是我不知道这个是怎么 Interrupt 的，有可能它是自己被 Interrupt 了。但是 Interrupt 了之后外层的这个 Execute 工具或者说这个 Task 工具没有正常返回，还是说怎么回事，导致这个 Execute 工具一直在运行。然后 Execute 工具呢，它好像又运行了几个小时又没有去自动中断。你看一下到底怎么回事。

附件[private Library ID redacted]，131064字节，已粘贴的文本(20261118-114836).txt。原记录384次read与384次glob，5项failed，末尾interrupted。附件没有调用时间戳、运行SHA及取消来源。REQ-1解释已观察的中断后外层持续等待，建立可重复信号；REQ-2在生命周期owner消除已实证等待环；REQ-3保持取消、清理、错误及既有后台运行合同。实际现场的首次中断来源继续作为明确缺失材料记录。

2026-11-19主线程转交的最新用户逐字原文：

> 完成方案，只要你审计了就可以去实施，然后实施完审计完就可以去进行铺市

此处保存从原仅方案目标升级到 verified-implementation-and-commit 的依据。提交前须通过实施及独立实现审计门禁；远端范围以本节末尾最新用户原文为准。

### 2026-11-19 R6 原始审查反馈

来源：`Sentinel_c22812742bac81919e94b01029ed82c4`，逐字如下。

````markdown
## 二、需要关注的隐患与改进点

### 1. 可中断外部调用者持有 `flight` 时的清理责任断档（建议修复）

查看 `packages/opencode/src/session/prompt.ts` 的实现与注释：

TypeScript
```typescript
const cancel: TaskPromptOps["cancel"] = Effect.fn("SessionPrompt.cancel")((sessionID: SessionID, fromBackgroundJob?: true) =>
  Effect.uninterruptibleMask((restore) => {
    const inFlight = cancelFlights.get(sessionID)
    // 内部 finalizer 加入自己的取消 flight 会互等；外部 caller 继续共享完整 Exit。
    if (inFlight) return fromBackgroundJob ? Effect.void : restore(Deferred.await(inFlight).pipe(Effect.flatMap((exit) => exit)))
    // 同步分配与登记之间不切让；body和join仍可中断，释放由onExit负责。
    const flight = Deferred.makeUnsafe<Exit.Exit<void>>()
    cancelFlights.set(sessionID, flight)

```

这里存在一个交接漏洞：

1. 假设一个处在**可中断上下文**的外部调用者（例如客户端可断连的 HTTP 取消请求纤维，或信号监听 fork 出的普通纤维）率先进入 `SessionPrompt.cancel` 创建了 `flight`，并在 `restore(body)`（可中断）中执行清理。
2. 它调用 `RunState.cancel` 触发 `BackgroundJob.cancel`，唤醒了处于**不可中断上下文**的 `job.onInterrupt`。
3. `job.onInterrupt` 看到 `inFlight` 已存在且 `fromBackgroundJob` 为真，**立即返回 `Effect.void`，把后续等待 `Runner`、中止 `pendingAssistantIDs`、结算用量和递归取消孙会话的责任全部交给了外部 `flight`**。
4. 如果此时首个外部调用者的纤维被中断（例如 HTTP 请求断开），`restore(body)` 会中途夭折，而 `job.onInterrupt` 早已退出，导致持久层残留 `running/pending` 消息或漏取消后代会话。

**修改建议**：`singleflight` 的清理主体 `body` 是跨调用者共享的状态收敛过程，不应随首个调用者中断而半途中止。应让 `body` 保持不可中断（去掉 `body` 外层的 `restore`，或 `forkDaemon` 运行清理主体），仅对外部等待者的 `restore(Deferred.await(inFlight))` 保持可中断。

### 2. 公开 `SessionPrompt.Service.cancel` 暴露了隐式第二参数与真值判断陷阱（建议修复）

`prompt.ts` 把原类型为 `Interface["cancel"]`（单参数 `(sessionID: SessionID) => Effect.Effect<void>`）的 `const cancel` 直接改为了 `TaskPromptOps["cancel"]`（双参数 `(sessionID: SessionID, fromBackgroundJob?: true) => ...`）。

- 由于 `SessionPrompt.Service` 对外暴露的 `Interface["cancel"]` 类型签名依然是单参数，任何外部调用方编写 `Effect.forEach(sessionIDs, prompt.cancel)` 或 `sessionIDs.map(prompt.cancel)` **都能零报错通过 `tsgo` 类型检查**。
- 但在运行时，`Effect.forEach` 会向回调传入第二个参数 `index: number`（`0, 1, 2...`）。而 `prompt.ts` 使用的是真值判断 `fromBackgroundJob ? ...` 而非 `fromBackgroundJob === true`——从第 2 个元素（`index = 1`）开始，都会在运行时被误判为 `fromBackgroundJob = true`，静默跳过 `inFlight` 等待并误传 `closingJobID`。这也偏离了方案 §10 中“外部公开取消保持原调用形式”的约束。

**修改建议**：将内部函数命名为 `cancelSession(sessionID: SessionID, closingJobID?: string)`，在公开 `Service` 上显式导出单参包装 `(sessionID) => cancelSession(sessionID)`，仅在 `ops` 中暴露内部参数（或至少将判断改为 `fromBackgroundJob === true` 并隔离公开函数引用）。

### 3. `fromBackgroundJob` 到 `closingJobID` 的往返隐式假设（架构收敛建议）

当前调用链做了一次不必要的概念降维再还原：

- `task.ts` 明知当前作业身份，却只传布尔值 `ops.cancel(nextSession.id, true)`；
- `prompt.ts` 隐式假设“`Task` 的 `BackgroundJob.id` 永远等于 `sessionID`”，再用 `fromBackgroundJob ? sessionID : undefined` 还原成 `closingJobID` 传给 `run-state.ts`。

在当前代码库中 `Task` 确实以 `nextSession.id` 注册 `BackgroundJob`，因此**现阶段行为正确**；但如果未来同一 `Session` 允许挂接独立 ID 的后台作业，该隐式映射就会失效。直接沿 `TaskPromptOps.cancel` → `SessionPrompt` → `RunState.cancel` 一路传递 `closingJobID?: string`（当 `inFlight` 存在且 `closingJobID !== undefined` 时返回 `Effect.void`），概念更单一且无隐式耦合。
````

已生效的测试增量约束：

> 不要大幅度地补各种各样的测试，我再说一遍

### 新版流程和验收原文

Sentinel_0822a47404608191ace471ba03c5543c：

> 几个内容rebase一下。而且为什么又不建议了？不建议为什么你不修呢？啥意思啊？为啥叫不建议啊？让你做的东西，你为什么跟我说不建议？Rebase完之后记得跑一下pre commit看一下情况。

Sentinel_bd0dbfc43b00819193d41773f282521e：

> 要求最终验收的版本是能够被合并的版本，但你不需要去合并。意思是说要求的达到的是质量可以能够满足能够合并的版本。

Sentinel_38eb41e8af848191b6d85b86403f2c09：

> 说错了，不是跑pre commit是跑gate。

Sentinel_e5afe75ea9c081919ca902600a95f290：

> 对的，你应该按照Gate逻辑去进行修改。

Sentinel_8e5668e94ba48191a2130e1924ea82a5：

> 同时请注意一点，相应的Workflow也更新了。要按照新的Workflow，还有新的审计等等来走，请注意这点。

Sentinel_4343aa48a550819186086659956966d1：

> 也就是把当前仓库全部都变到最新的，然后全部按照最新的路径以及文件来走。

> 不得修改gate

2026-11-20 本次语音，主线程逐字转交：

> 这个workflow里面已经明确说了，你的那个每一个plan都要写的是从基线到现在的行为，你不要写什么从现在怎么继续去精简

本轮用户逐字追加：

Sentinel_6233af5ad1288191b08bcaa389431e61：

> 相应的Git已经更新了，你可以把最新的内容去rebase一下。

Sentinel_a4a98fbf1e888191b4e31b62ac12010e：

> 相应的GATE已经更新了，你可以使用最新的GATE的内容。最新的GATE规定了和解决了之前GATE的一些bug。

Sentinel_117591bc5dcc8191b25d69a1a90cea15：

> 同时请注意，你的这几个PR都应该是单个Commit。

Sentinel_247c0dc26d088191b4ccbb519001f84f（单独针对 #5 分支试验）：

> 比如对于5的话，对于Sharp 5的话，可以把Sharp 5推到分支上，自己去做检验，看行不行。行的话你再去弄就OK了。

此条临时分支授权只适用于 #5。

2026-11-21 12:24 UTC，来源 `Sentinel_439cb1036450819198ea148d8a56d9b3`：同条消息列出既有的 #5、#6、#8、#11。其操作授权段逐字如下：

> 我只允许你对5、6、81进行相应的内容，PR你自己去处理，你想怎么推怎么推，我不管你，我全部都授权，我知晓你对5、6、81四个PR进行任何操作的风险，我都授权，我再说一遍，然后同时你需要继续去推进任务。按理来讲，5、81三个分支本身就是在三个Agent上去负责的，你不要把它堆在一块说一个要等另一个结束，这不合理。

本轮仅对既有 #8 PR 对应分支做验证与候选推送，保留单提交；无需等待 #5。不另开 PR 或分支，不合并，不改 Gate；后面的历史裁决按当时授权保留。

## 2. Explicit Non-Goals

本修复处理外层 Execute 在真实 Task 中断后持续等待，不改变任务个数、模型或工具选择、默认超时、权限、前台与后台开启条件、消息和用量结算协议。现场记录没有首次中断的时间、运行版本或发起者，本方案不把现场的第一条中断归到某个未经证实的来源。公开 cancel 仍是一元调用；不扩张配置或 API。Writer、文件修改并发、Read、共有 fixture、依赖、Guard、hook、工作流和生成文件均保持目标分支的内容；不另外清理进程 Logger，不把历史旧 Guard 为验收做的两个测试改动带进终态。最终验收要求可合并质量，合并由用户决定；当前只有本地准备和验证授权，#8 暂不发布。

## 3. Repository Context

| 来源 | 本任务遵循的边界 |
| --- | --- |
| 当前 `docs/guides/workflow.md:26–27,29–45,95–111`，first-principles-planning、engineering policy 和 canonical template | 从 R1 前固定 f04 完整描述目标，另对当前 5bc 验证发布差分；新增断言必须服务真实原缺陷或原有兼容合同，移除只有中间实现才会失败的专用断言。方案和实现各经独立审计，最终原 hook 验证同一单提交。 |
| 根、`packages/opencode`、`packages/opencode/test` 的 AGENTS | Effect 资源与 scope 归现有服务；测试从包目录运行，复用 `testEffect`、临时实例、真实 Tool 与 Deferred 同步。生产缺陷不通过测试假实现掩盖。 |
| `CONTEXT.md` 的 Session History、Session Drain、durable tool result；ADR-0001 | Session 运行状态与持久历史是不同观察点，idle 不足以判断作业关闭与消息终态；分诊 ADR 不改这些所有权。 |
| diagnosing-bugs、tdd 及 tests/mocking 指引 | 先记录固定基线与同输入现象，再确认责任方和最小路径；断言可观察结果，使用真实取消源，外部模型和平台服务沿已有 fixture 边界替换。 |

## 4. Files and Evidence Read

| 来源 | 用途 | 类型 |
| --- | --- | --- |
| 原始需求与附件、R6 逐字反馈（§1） | 原始外层持续运行；明确共享清理、公开一参数与登记作业身份。 | observed / contracted |
| 固定 `f04f9307957774ad5a21b4cfe70921a4fce20d5a`，tree `c275a013a4ca9c90d74a51dd162ac2e0f8b28826`；当前发布 `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0`，tree `7856a04183fb9aa562da776477c27243f8c9874f` | 对照裸 Git 对象：8aead 至 5bc 有三个提交、十三个变更路径；与本任务六路径无交集，两个基线的代码前像相同。 | observed |
| `tool/code-mode.ts`、`session/tools.ts`、`session/prompt.ts`、`session/run-state.ts`、`tool/task.ts`、`packages/core/src/background-job.ts`、`effect/runner.ts` | 原期限引发中断，执行层仍等待 leaf cleanup；确认同一 session 的 flight、作业退出 finalizer、Runner 和作业快照，判断等待环来源。 | reachable / observed |
| `cli/cmd/debug/agent.handler.ts`、`test/session/execute.test.ts`、`test/fixture/fixture.ts`、`test/lib/effect.ts`、`test/preload.ts`、包级 `bunfig.toml`、`tool/registry.ts`、`plugin/index.ts`、`provider/provider.ts` | 表明原 Debug 的原生 Read 如何穿过同一工具目录，回放如何保留真实 Task、Runner、作业、SQLite 与进程边界，同时由既有替身隔离外部模型、插件和平台服务。 | observed / reachable |
| §18 的 f04 原红、同输入历史对照、完整候选四入口、原 Debug 和纯 Effect 实验 | 分开证明可重复超时、真实后台兼容路径、候选可落库和共享等待规则。 | observed |
| 原 Writer/并发文件测试、`project/instance-runtime.ts`、`project/instance-store.ts`、`effect/app-runtime.ts`、core Logger 与 `tool/truncate.ts`；历史 scope 取证和本版 A/B | 旧进程 hook 触发另一 Store 的历史观察保留，新 Guard 上以两原文件完整用例核对撤回两个夹具改动。 | observed |
| 5bc 原 `script/guard/leak-preload.ts:59–68`、`script/guard/gate.ts`、`preflight.ts`、`.husky/pre-push`、`.github/workflows/guard.yml:283–319` | 测试末尾统一检查资源；现行本地选测、跨平台预检、PR 规则有各自入口。失败摘要保留测试名称与出错位置，正式预检另外上传完整日志。runtime PR 的基准仍取目标策略脚本。 | contracted |
| 5bc 的 `{affected,select-tests,gate}.ts`、`.github/workflows/guard-nightly.yml` 与 `bench/opencode.ts` | 静态规则排除 sdk-next 独立测试，仍把源码纳入依赖分析；建图与选测先解析真实包路径，子测试诊断带 `\| ` 前缀。部分覆盖继续与静态选择合并。Schema、Protocol 和默认基准模拟正文未变。 | observed |
| 8aead 的 `packages/core/src/plugin/internal.ts` 与 `packages/tui/test/routes/session/session-viewport-follow.test.ts` | 核心 host 建层时才加载 provider 注册表，打破模块初始化时的循环；TUI 变更仅把既有视口测试改用 ManualClock。完整应用验收须覆盖重新构建后的真实启动；不把这两处基线变动放进 #8。 | observed |
| 5bc 的 `effect/app-runtime.ts`、`effect/run-service.ts`、`cli/cmd/run/stream.transport.ts`、`project/instance-store.ts`、`test/preload.ts` | 首次使用登记包服务运行时；宿主终止后关闭共享 scope，传输独立关闭已登记的子运行时，实例退出发布 pending bootstrap/reload 结果，默认 HTTP handler 的测试 teardown 先释放。它们影响 scope 与退出验证，但不接管 SessionPrompt 的取消 flight。 | observed / reachable |
| 原 `packages/client/test/import-boundaries.test.ts`、`packages/sdk-next/test/import-boundaries.test.ts`、SDK 及 schema 原契约、两份快照 | 验收器的 test-local 写边界；原契约用相对临时目录触发真实 Bun bundle。历史本地文件系统问题与产品取消分开。 | observed / reachable |

## 5. Current Behavior

固定 f04 与当前发布 5bc 的取消关键路径相同。Execute 的预算到期（默认 600000ms）或上游中断使 leaf 开始收尾，外层仍等待它退出。真实 Task 用会话来登记 BackgroundJob；该作业的中断 finalizer 沿 `ops.cancel(sessionID)` 回到 SessionPrompt。首次取消创建每会话一份 Deferred flight，后续进入同一会话一律等待它。与此同时 SessionPrompt 正等待 RunState，RunState 的作业快照可能包含尚在退出的同一个作业。最后出现在调用者眼里的是取消已发生、Execute 仍无最终结果。Runner、消息落库、用量和后代会话清理都是现有责任，不能删掉它们来换取返回速度。

5bc 保留 Guard 资源 preload 和两个原夹具；包内 `test/preload.ts` 新增关闭默认 HTTP handler。真实 AppRuntime 终止会在原 app runtime 后释放由 `makeRuntime` 登记的子 scope；运行传输还会释放自身。两条宿主边界须与原取消链一起复验。§18 的同输入红仍发生于 SessionPrompt 共享 flight 与正在关闭的 Task 相互等待。

## 6. Supported Input Domain and Reachability

| 输入／条件 | 生产者与上游保证 | 真实路径和 owner | 分类 |
| --- | --- | --- | --- |
| 已执行真实 Task 的 Execute 到期；会话发生外部取消 | CodeMode／公开调用保留原预算与工具清理；外部只提供 SessionID | Tool leaf → Task → SessionPrompt 的清理 → RunState | observed / contracted |
| 外部发起者在共享清理中收到 interruption；另一外部等待者加入 | 可中断请求可退出；独立等待者仍等待同一任务结果 | SessionPrompt flight 负责共同结果；外部 waiter 可中断 | reachable；纯 Effect 对照和真实 session 臂 |
| 现有已登记 Job 的中断 finalizer | Task 登记处持有实际 ID；只在内部退出入口携带 | BackgroundJob → Task 内部 ops → SessionPrompt → RunState 原快照 | reachable / contracted |
| 直接后台取消、实例 scope 处置 | 原 job 可先报 cancelled，实例处置收其原 scope | 两条专门真实回放，观察到 scope 结束及持久终态 | observed |
| 实际 Debug 的原生工具 | Debug 复用原目录，保留 Read 结果与环境句柄 | Debug handler → 原 SessionTools → Tool | observed |
| 同会话被任意第三方追加假 Job ID；现场首次中断的来源 | 没有对应输入或现场时间记录 | 无新支路；对实际登记的 ID 负责 | speculative／未观察 |

## 7. Required Invariants

| ID | 合同 | 可观察证据 |
| --- | --- | --- |
| INV-1 | timeout、外部会话取消、直接后台取消和实例 scope 四个入口都能在真实子清理完成后让外层和持久 Tool 进入终态。 | f04 timeout 红、原四入口、真实终端取消后续答。 |
| INV-2 | 同一会话唯一清理 owner 保持责任至完成；作业退出不等待自身，只从原快照排除自己的实际 ID，其余工作不丢。 | 原 Job/Runner 链、孙会话消息终态、四入口与关联回归。 |
| INV-3 | 公共调用仅接收 SessionID；外部重叠调用接同一个完整 Exit 且可中断等待，首发请求自身中断不截断共同清理。 | §1 反馈、真实公开加入与首发中断、纯 Effect 语义、包类型与 Debug。 |
| INV-4 | 回归只新增原真实链的四入口且保留原 Debug；额外的中间版本索引断言不进入测试。 | 同输入 f04 红与绿控制、四入口和独立 Debug。 |
| INV-5 | 当前目标的一次正式提交通过原规则、强制 Gate、所需同 SHA CI、独立审计、真终端及已验恢复。 | 原 hook／Gate／预检／CI、最终树及回放。 |
| INV-8 | 保持目标分支的打包与协议契约字节；现行 Gate 的 Schema 和 Protocol 都按原命令运行。 | 现行双契约及版本输入；Client/SDK-next 旧原四契约回执单独留档。 |
| INV-9 | Writer 和文件修改并发继续使用 0b 原 fixture、钩子和断言。 | 完整两文件 A/B 同为 38/93，以及保留原夹具的取消四例。 |

## 8. First Divergence and Root Cause

| 不变量 | 首个分歧及后果 | 责任位置、证据 |
| --- | --- | --- |
| INV-1/2 | 起因：外部与正在关闭的 Task finalizer 从同一入口进入 flight，无法区分自己。同一作业一面等 scope、一面等其 owner，出现循环。传播：RunState 和 Runner 无法收完该快照；表现：外层 Execute 没有持久终态。 | 两原基线 `task.ts:449–460`、`prompt.ts:371–410`、`run-state.ts:143–159,236–255`。固定 f04 的同输入在 15,005.59ms 达原测试上限；日志只见两项断言和 timeout，不拿它推断现场首次中断来源。 |
| INV-2/3 | 原 owner 包住共享清理的 `restore` 让首发请求中断时可能丢弃其处理责任；旧中间版本引入内部参数后曾把公开回调的索引误作内部身份。 | SessionPrompt 驱动共同清理；§1 R6 反馈区分这两个约束。f04 的公开一元函数没有历史中间版的回调索引缺陷。 |
| INV-4 | 旧测试没有把真实 Task 被取消、其 scope 收尾和外层持久终态连在一个可重复入口。 | 原 Execute fixture 复用现有工具宿主，保留真实 red-capable timeout。直接后台和 Debug 是原兼容控制。 |
| INV-8 | 隔离器让两个原契约在 `import.meta.dir` 内的 `mkdtemp` 报 EROFS，尚未执行到真实打包断言。 | Client/SDK-next 原测试和历史四契约对照；此路径由验收载体提供正确 scratch，产品与测试保持原样。 |

## 9. Responsibility and Seam

| 关注点 | 唯一 owner／接口 | 保持和改变的边界 |
| --- | --- | --- |
| 会话级 cancel flight、完成及删除 | `SessionPrompt.cancelSession` | 保留原 Deferred、Exit、事件和持久处理；只改变清理主体和外部等待的中断分工。Execute 不接管子资源。 |
| Job 退出身份、取消 Runner 与其它作业 | 登记的 `Task` → 原 `RunState.cancel` | 登记处产生 ID，内部回调传同一个 ID。在原 RunState 快照上只排除自己，仍用旧 Runner 和作业退出机制。 |
| 公开、普通工具与 Debug 适配 | SessionPrompt 一元 wrapper 与原 `ops()` | 只内部传作业 ID。Debug 换成原 TaskOps 工厂，`SessionTools.resolve` 及原 native 工具不变。 |
| 测试隔离 | 原 Execute test／实例 fixture 和经过审查的运行器 | 模型流等外部边界用已有替身；真实 Job、Runner、scope 和持久存储不替换。 |

## 10. Single Approved Primary-Path Design

本版等待独立批准。Task 用原实际 job ID 登记，在作业自身退出时把该 ID 传入 SessionPrompt 的私有 `cancelSession`；公开服务 `cancel(sessionID)` 只转发一个实参。第一位进入者原子地登记 flight，清理主体屏蔽中断，将 job ID 交给 RunState。RunState 只从原快照排除当前退出的 job，沿原顺序处理 Runner 和其它作业；持久消息、用量、子后代的结算继续由现有路径处理，原 Exit 通知外部等待者，最后移除登记。已有 flight 期间，正在退出的内部 Job 立即让自己的 scope 继续结束；外部调用仍可中断地等待同一个 Exit。这个区分直接断开等待环，同时避免第一位外部请求半途交掉清理。Debug 和常规宿主取同一 TaskOps 工厂；不加守护 fiber、第二个结果或 timeout。

在原 Execute 测试用同一真实取消链跑四个入口。以 Deferred 等待真实 child 运行、进入中断、允许 cleanup，不加固定 sleep；按原终结顺序保留释放闸门以免断言失败后测试自身锁死。父模型收到真实工具结果即结束。timeout 断言真实 error 及文本；外部首发中断走原公开路径，独立加入者仍可等；后台用直接公开的一元调用加入，不使用 `forEach` 下标特例；scope 用真实实例处置；独立保留原 Debug Read。两个旧 Guard-only 夹具的改动退出差分，依据是 §18 守同输入的 0b 全文件 A/B，而非历史失败被整仓解决。

## 11. Secondary and Replacement Path Inventory

| 路径 | 分类 | 结果和处置 |
| --- | --- | --- |
| 已有 flight 中的自身 finalizer 快返 | 主合同分支 | 只放开同一退出环，不产出第二个成功结果；保留。 |
| 外部等待、Runner、消息和外层回执 | 原主路径 | 继续消费共享 Exit；保留。 |
| Debug 原工具宿主及 Task factory | 原适配 | 保留原 Tool，删除重复适配。 |
| 历史 timer 探针、A/B 临时 projection、验收私有 scratch | 试验／验收载体 | 没有生产决策；不进入 Git 差分。 |
| 隐式重试、强制成功、改预算、弱化 Guard | 备用行为 | 排除。 |

预计增加备用成功路径 0、生产诊断决策面 0%。实际 diff 复核。

## 12. Workaround Deletion and Replacement

共同清理把 owner 体从可中断的 `restore` 中移出，`restore` 留给外部 join。Task 不再绕公开 cancel 传不完整身份，Debug 不再重复组装服务接线。R1 前发布行为本来就有公开一元入口；保留其语义，避免内部签名暴露。取消 fixture 去掉中间版专门触发回调索引的输入；timeout 的原错误状态守卫和包含 `timed out` 的业务断言仍在，重复状态断言无需再写。两个历史 fixture 只留原始回执，当前交付的 Writer 与文件修改并发文件均保留 5bc 的原字节；正式候选不带探针或附加清理。

## 13. Forward Traceability

| 需求／不变量 | 路径与文件 | 观测 |
| --- | --- | --- |
| REQ-1/2、INV-1 | Execute → Task → `prompt.ts` → `run-state.ts` | 同一 f04 红、候选四入口、真实终端和持久终态。 |
| REQ-2/3、INV-2 | `task.ts` 登记 → 内部 SessionPrompt → RunState 快照 | 自身不等、其它后代落库、后台直接取消和 scope。 |
| REQ-3、INV-3 | `prompt.ts` 公开一参、内部 TaskOps；Debug handler 共用 factory | 独立公开加入、首发中断、原 native Read 与包类型。 |
| REQ-1/3、INV-4 | 原 `execute.test.ts` 共用夹具、原 Debug | 原缺陷 timeout 红转绿，三变体及 Debug 各自合同。 |
| INV-5/8/9 | §15 完整六路径；原 Guard、原契约和两个原测试文件 | §18 账本：A/B、正式门禁、同 SHA CI、体验和空目录恢复。 |

## 14. Reverse Traceability

| 新增或保留的概念 | 对应需求及为何需要改变 |
| --- | --- |
| owner 共享清理与可中断 join 的分离 | INV-1/2/3。旧泛用 join 不能区分作业 finalizer 自身等待，首发 owner 的中断也不应传给共同资源。保留已有 flight，调整控制权。 |
| 真实 `closingJobID` | INV-2。Task 已有唯一登记身份；公开参数或布尔反推不能表达该作业。RunState 的原快照是已持有等待集合的地方。 |
| 公开一参适配和共享 `ops()` | INV-3。内部签名包含额外身份，外面必须继续只传会话。Debug 原来重复拼接工具适配，此处复用，不增加生产取消入口。 |
| 四入口真实夹具及原 Debug 接线 | INV-4。旧测试无法观察新暴露的跨 Task cleanup 与外层终态时序；复用原业务、真实持久层和有限替身。 |
| 保持原契约和原 fixture | INV-8/9。历史 Client/SDK-next 打包试验只在隔离载体提供 test-local scratch；现行 Gate 的两个契约依原入口运行。两版夹具在 0b 使用同字节 preload 均通过；5bc 两个原夹具和 Guard 资源 preload 留原字节；包启动和 test/preload 的上游改动另验，额外修改夹具没有独立需求。 |

## 15. File-Level Change Plan

### A：固定原始 f04 → 完整交付树

| 路径 | 固定 Git 前像 → 唯一目标 | 增／删 |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/debug/agent.handler.ts` | `1426b93ae108e19a70645e9696a403abfd4aee3a` → `236fea6d6087ec46fe0c3d1d858a5a6fddcc8a89` | +3/-3 |
| `packages/opencode/src/session/prompt.ts` | `9d4e4556e741abe374b9ca68b462feafc19bf2ca` → `a92a5ac730fea9ff1b3822267f4dd4562ca71e90` | +36/-33 |
| `packages/opencode/src/session/run-state.ts` | `0cee1582e9c14e74e5c925b8f849271f96d83f85` → `b9fdb0222f6bdf80025d3d31270ae988618001d1` | +4/-3 |
| `packages/opencode/src/tool/task.ts` | `5393197fae8c39d3fdf9e83074c419017d2e31bc` → `02f43b5944f68539907913fee5aa71a1b3dad117` | +6/-3 |
| `packages/opencode/test/session/execute.test.ts` | `ce9ede8d5b06b47170f5c321a680e29d4248c415` → `ec43d6fe7c0bbf705b263c23f8986a7862ebeb1a` | +163/-2 |
| `docs/plans/execute-task-cancellation.md` | 固定 f04 无此文件 → 本份完整 Plan | 新增文档 |

### B：当前发布 5bc → 同一完整交付行为

| 路径 | 当前 Git 前像 → 唯一目标 | 增／删 |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/debug/agent.handler.ts` | `1426b93ae108e19a70645e9696a403abfd4aee3a` → `236fea6d6087ec46fe0c3d1d858a5a6fddcc8a89` | +3/-3 |
| `packages/opencode/src/session/prompt.ts` | `9d4e4556e741abe374b9ca68b462feafc19bf2ca` → `a92a5ac730fea9ff1b3822267f4dd4562ca71e90` | +36/-33 |
| `packages/opencode/src/session/run-state.ts` | `0cee1582e9c14e74e5c925b8f849271f96d83f85` → `b9fdb0222f6bdf80025d3d31270ae988618001d1` | +4/-3 |
| `packages/opencode/src/tool/task.ts` | `5393197fae8c39d3fdf9e83074c419017d2e31bc` → `02f43b5944f68539907913fee5aa71a1b3dad117` | +6/-3 |
| `packages/opencode/test/session/execute.test.ts` | `ce9ede8d5b06b47170f5c321a680e29d4248c415` → `ec43d6fe7c0bbf705b263c23f8986a7862ebeb1a` | +163/-2 |
| `docs/plans/execute-task-cancellation.md` | 当前 5bc 无此文件 → 本份完整 Plan | 新增文档 |

固定设计基线和当前发布基线的五个代码前像逐字相同，故共用以下 hunk 映射。5bc 相对 8aead 是三个上游提交：`0b2d39a` 处理实例关闭与 Auth，`6ac1bb0` 释放原 HTTP 测试 handler，`5bc061b` 释放传输和包服务运行时。十三条路径与 #8 六路径无交集；原 Writer、文件修改并发夹具，以及 OpenTUI `b0cf25352ca75b964eca476af3554e6aa8dd8b20` 和浏览器代理 `51fa88d946bec6c8695ea52b373ce51fb26a9bff` 两 gitlink 均不变。

精确 5bc 的隔离投影对五路径 `git apply --check` 无冲突，先仅重放 Execute 目标测试取得红，再套同一份剩余生产补丁并取得绿。预期五路径二进制差分 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`；批准后仅在对应 5bc 私有工作树重放五路径，另以本 R18 Plan 作第六路径。R17 的实际承载、审批和恢复版本留档，不成为本轮提交父节点。

| 共同基线锚点（f04/5bc） | 目标职责与必要性 | 检查 |
| --- | --- | --- |
| Debug handler 63、70–71 | 删除手工拼接 promptOps，取原 `taskOps()`；否则 Debug 又绕开内部身份。真实工具、模型、原错误和 Read 返回保留。 | §16 第5步、包类型。 |
| prompt 306、364 | 服务公开同一工厂供现有入口取用；内部 Task 取消改到拥有 Job ID 的 `cancelSession`。 | 四入口、原调用图和类型。 |
| prompt 371–410 | 内部签名接收真实 Job ID；区分重入、自身清理和外部 join；把共享 cleanup 移出可中断区，并将 ID 给 RunState。消息落库、用量、后代和 Exit 完成次序保留。 | 原 timeout 红转绿、首发 interruption 和另一 waiter、子和孙持久状态。 |
| prompt 2547 一带 | 公开服务显式一参数包装，同时连接同一个内部工厂；调用方第二实参永远不进入私有身份。 | 接口／类型及真实公开加入；不给过渡版索引新增断言。 |
| RunState 22、143–159 | 方法接收 ID，原列表先过滤恰好该工作；有／无 Runner 的分支继续共享该快照，其他 Job 正常停止。 | 原 Runner、Job 和四入口；完整包回归。 |
| Task 34、447–460 | 在登记处统一用同一 `jobID` 初始化作业和 onInterrupt，status、完成消息、后台通知原样。 | 原 Task；真实外层等待和自身退出。 |
| Execute 测试导入、213 后及原 Debug mock | 启用已有实例与 LSP/BackgroundJob 边界；一套真实 fixture 跑四入口并观察持久 Tool，adapter mock 只为旧 Debug Read 提供原目录的服务接线，若误调用 Task 方法便失败。 | §16 同输入红、四个互异入口、Debug 两项原断言。 |
| Canonical Plan | 记录上述完整改动与验收；两基线均无该文档。 | 双审查及最终干净单提交。 |

## 16. TDD Behavior Slices

| 顺序 | 回放与原始行为 | 最小目标、独立预期 |
| --- | --- | --- |
| 1 | 固定 f04、共同 test blob，真实 timeout 在放开清理后仍超时。 | 放开后原 Execute 进入持久 error，正文含 `timed out`，不再有该作业或持久 Tool 遗留；保留闸门释放前仍运行的断言。 |
| 2 | 外部 Session 取消：同一链会被作业退出反向等待。首个可中断请求与共享资源不同所有者。 | 第二个公开等待者提前不完成；真正 release 后首发得到 interruption，另一等待者得原 Exit，后代助手消息正常终结。 |
| 3 | 直接后台取消：真实 job 可先发布 cancelled、再完成 scope；固定 f04 的直接公开加入本来通过。 | 走真实 `prompt.cancel(child)`；release 前两个纤维都未返回，之后作业 cancelled，外层与持久 Tool 收尾。此为绿—绿兼容对照。 |
| 4 | 实例 scope：原退出是现有清理入口，不能用替身的 scope 模拟。 | 真实处置先到 child cleanup，release 后 scope 及父 Fiber 在限时内完成，持久 Tool 不再 pending/running；现断言父 Fiber 返回 Exit，不宣称比对了 Exit 的每个 cause。 |
| 5 | 原 Debug 用例保留：平台进入原生 Read，不能变成只核查类型或调用次数。 | 返回 `debug host` 正文和原环境句柄，两原断言不变；该例不测试 Task 结束。 |

先跑固定 f04 的真实红，再运行最小对应目标及上表绿色控制。所有取消入口共用原 SQLite 与工具链，模型替身只派发该场景的子会话。历史 R5 在相关生产前像相同的 e93 记录 timeout 和 session 红、后台和 scope 绿；固定 f04 当前可靠的直接实测是第1步红、第3步绿。真实运行器和 Guard 隔离的 A/B 在 §18，是原 fixture 的验证，不添加业务测试，也不把打包验收当成产品 TDD 红。

## 17. Comments

生产注释只解释真实 Job 的身份、owner 与可中断 join 的区别、共享入口的职责。测试注释只解释反向释放顺序、模型只派发一次、后台 done 的范围以及持久状态与 idle 的差别。已有目标字节中的适用中文注释保留，不添加解释任务历史或仅补比例的句子。

## 18. Verification

**原始红和最小绿。** 所有已记录实测按隔离方案保留 Bun 1.4.4、只读源码及冻结依赖、私有 HOME/XDG/tmp、仅环回。测试从 `packages/opencode` 运行。固定 f04 使用自己的锁：SHA-256 `3091758e1628f6ee250b753605b9641fbacd73028923fb7699482fcae4ce4e1d`；与 0b、98a、27f5 、8aead 及当前 5bc 共用的 `56c20270792f5ce4ecced742b5e3667ca53573da26a3af6153e6f9a484635ed5` 只差 OpenCode workspace 版本，第三方解析、完整性及补丁等价。读到的预加载路径和临时 XDG 中没有私有配置；替身限制模型/Provider/Plugin/MCP/LSP，不进入外部认证和网络分支。文件过滤仍会加载声明及预加载；Debug 独立于四取消用例，保留原 Native Read 并隔离真实插件图。无外连与旧纯 Effect 对照至多证明各自的范围。

| 已运行的命令／输入 | 实际观察与原收据 |
| --- | --- |
| 固定 f04，测试输入 Git blob `ec43d6fe7c0bbf705b263c23f8986a7862ebeb1a` / SHA256 `7f0b160e44796c1a89f2e4c77c329d0e0df41a0c61af4b4c932abd7497861e2d`；`bun test test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|background) settles a real Task cancellation after child cleanup$'` | 同输入结果 1 pass / 1 fail、9 断言：固定 f04 timeout 15,005.59ms、后台通过 624.70ms。原 `pr8-r10-original.log` SHA `ba5e8f680c9fd68969836a02900676f6fed18a841e995fd077825cc47b0f6cab`。 |
| 同输入的历史 0dff 前像，与 f04 使用相同两例命令 | timeout 15,017.80ms、后台通过 578.70ms；1/1、9 断言，SHA `aad88c6ff1d103c4df3bd787dddd86af59ed9ba4a9e395dc73884f4c1785d125`。这是历史发布点的对照，启动记录仍归 0dff。 |
| 历史隔离候选精确五个 blob，同输入四入口 | 4 pass、29 断言、6.77s，`pr8-r10-candidate.log` SHA `d183a5bbe462beee159678165f526fb911565d65d4bfe7af55ca0770c51c9731`。原 Debug 单例另外 1 pass、2 断言，SHA `fc73a59b03742aadd556759df2bc4898f2ddadc5a00d8ea251f25faa02047e56`。 |
| 锁 Effect 4.0.0-beta.83 独立 Deferred 语义对照，不导入业务 | 可中断 waiter 先返回；owner 继续清理，另一 waiter 在 release 后收完整 Exit。日志 SHA `ce5b4df28e17ee9f8b64a204078ef60ef7691c5668990a92aabcd2c3ebad5106`。它验证设计，不替代 f04 的真实红。 |
| 历史 0b 五路径候选，冻结目标五个代码 blob 与两原 fixture；`bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|session\|background\|scope) settles a real Task cancellation after child cleanup$'` | 4 pass、0 fail、29 断言，76 未选、6.25s、exit0；`latest-product-four.ATRCA3/SHA256SUMS` `ae3a01db956c0af1b7a49b652a3503c255d27b357952c0478d6bf35f7fda93d9`；stderr `d5e4d98914b604145a0783781c52a390e9f0f669570dda06f5a0dd2ffb9aeeba`。 |
| 历史 0b，`bun test --preload /app/script/guard/leak-preload.ts test/tool/write.test.ts test/tool/file-mutation-concurrency.test.ts`。A 两原钩子，B 只换历史两个清理；五目标 blob、锁、Guard、运行器和入口相同 | Writer 28、文件修改10；A/B 同为 38 pass、0 fail、93 断言、exit0，5.51/2.99s；原输出无 afterAll 失败，未单独报告成功 hook。清单 `guard-afterAll-ab.MPvp7O/SHA256SUMS` `3b0aab28eea00fa981d808c7ab24511533ac3ca8b7e4dd7e57b91fa4b54f01e2`，stderr `5b53ff28308a18a71815c2834d094cd82305cb595d409dedc8fb50c3487e6395`／`3141fc97ca59fb8c31c610688ba2565684cd09fd752b822bab0bc14679debfcd`。 |
| 精确 8aead 产品前像，隔离投影仅换入同一 Execute 目标测试字节；在 `/app/packages/opencode` 用原 Guard preload 和 `bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|background) settles a real Task cancellation after child cleanup$'` | timeout 具名失败，15,007.08ms；后台入口对照通过，577.55ms。原 preload 另报 30s、60s 和 2×3600s 残留计时器；单列 afterAll，不把它当作取消具名红。退出 1。 |
| 同一 8aead 基线重放五路径；同命令的正则改筛四个原入口 timeout、session、background、scope | 4 通过、0 失败、29 断言，6.31s、退出 0。timeout 用例 2,504.02ms；它继续检查真实 child cleanup 释放后的外层收敛与已持久化状态。两臂命令、原双流、时间和退出索引 `pr8-r17-red-green.mioQml/SHA256SUMS`，SHA-256 `976ec1dfb56dfd1ca645b3858172f9b4e0afaef190df7b7f3bf02eeaca9dec12`。 |

5bc 同输入红绿用同一真实包投影、现行 Guard 资源 preload 和 8aead 已使用的白名单运行器。只换目标测试的 5bc 前像臂中，原 timeout 具名失败 15,028.04ms，直接后台入口通过 994.27ms；另有独立 afterAll 失败，不算作原业务的具名红。应用原四个生产路径后，timeout、session、background、scope 四入口全部通过，29 断言、6.37s，timeout 用例用时 2,115.20ms；绿臂退出 0。精确命令、原双流和退出索引 `pr8-r18-feedback.PgRqjY/SHA256SUMS` SHA-256 `3859d1f2ae684326c7ccb2335c1bb47e4c6ba866384c1b937e6389353b447045`。

Guard 资源 preload 仍 SHA-256 `5f6ebae9cf2b475b69706655618ece42eabeddf1e1b2f8072c4beb989359c7cf`；包内测试 preload 与宿主及传输最终关闭变动都来自 5bc。R17 的原两图、编译物、五文件、契约、Stop 与 B-11 裁决保留历史，重新验证本基线，不挪用旧回执。

**批准后在实际候选中执行的验收。** 每项保存真实命令、CWD、输入标识、原始日志和退出；不要把过去的类似结果重新标成当次结果。

| 正式命令／步骤 | 工作目录及通过口径 |
| --- | --- |
| 重跑上表两个原命令：四个锚定的 Execute 入口，以及 Writer 和文件修改并发两个完整文件 | `packages/opencode`。在 5bc 候选使用原测试名和原 preload；保持四入口 29 断言、两个完整文件的原业务断言。 |
| `bun test test/session/execute.test.ts --test-name-pattern '^debug execute uses the same native tool host$'` | `packages/opencode` 单独运行，真实 Native Read，1 例、原 2 断言。 |
| `bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts`；`GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded` | 隔离投影的 `/app/packages/opencode`，保留真实分流输出及退出。过去 317 pass 加一项原 skip 只作基数；不得删掉失败或额外跳过。 |
| 新发布基线的原生命周期回归 | 在 `packages/opencode` 用原 Guard preload 运行既有 `test/effect/run-service.test.ts`、`test/cli/run/stream.transport.test.ts`、`test/project/instance.test.ts` 和 `test/server/httpapi-question-session.test.ts`。核对已接纳调用仍收尾、实例退出等待者仍收结果，归档 teardown 退出；原用例与门禁维持。 |
| `bun script/guard/gate.ts contracts` | 仓库根运行 5bc 的 Schema、Protocol 两个现行契约并记录实际退出；历史 Client/SDK-next 临时目录和 EROFS 对照留 §23，不拿来顶替现行验收，也不改业务测试。 |
| `bun script/guard/gate.ts stop --files <§15 六个实际路径，逗号分隔>` | 仓库根用 5bc 原 Gate 和原选择器。保存该次覆盖输入、静态/覆盖合并、规则输出与实际选测／递延；核对 sdk-next 排除、真实包路径和失败覆盖诊断。当前选择结果不复用旧报告。 |
| `bun run build --single --skip-install` 和真实终端 | `packages/opencode`，固定原依赖、OpenTUI、Web UI 及 CLI/Voice smoke；验证延迟加载 provider 注册表的真实启动，并核对新包运行时和传输释放后的真实退出。两 Esc 真取消，观察 Task、Execute 持久 error；同会话继续真实回复，然后清理应用、daemon 和 provider。存两张真实画面、编译物/锁/源码 SHA 和原退出。 |
| 独立实现审计后原 hook 单提交；`bun script/guard/gate.ts push --since 5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0 --sha <最终真实SHA>` | 仓库根，干净候选 checkout。原 `.husky/pre-push` 从真实 Git 输入读取非空 ref 及候选 SHA；当前本地跟踪目标与显式 `--since` 必须一致。核对实际冻锁安装、全仓类型、每 ref Gate 与两 gitlink 在远端跟踪分支的可达性；失败保留新摘要和完整原始日志，旧基线及旧候选通行戳均不复用。 |
| 新基线的原基准入口 | 在现行原 PR 路径按目标策略 `git archive "$POLICY" script/guard`；官方运行 `bun "$policy_dir/bench/opencode.ts" --head HEAD --base "$BASE" --json bench.json --markdown "$GITHUB_STEP_SUMMARY"`。记录请求比较 SHA、策略 SHA、实际 checkout SHA、seed、候选与 A/B JSON 退出；单独在基线验证默认 mock 能进入基准，仅用于定位 §20 的历史阻断。 |
| 原 preflight 与 GitHub required checks | 原选择因平台敏感路径或本地递延触发时，用同候选、同 base 的原预检流程收各默认／实际选中平台和 `guard-required`；远端 PR 模式另取同一候选对应的规则与 runtime benchmark。按 §1 最新授权在既有 #8 上独立执行，与 #5 并行。原 Guard 入口保持。未运行的远端检查均按未验记录。 |
| 归档及复原 | 只存源码对象、Plan 和必要证据；从空目录独立验证完整对象、单 parent、tree、六路径和两 gitlink。精确最终 SHA 绑定验收后才算可合并；按 §1 当前范围推送并验收。 |

原只读 AST、第三方载入核对和 R10 单例／四臂历史日志的逐条 SHA 保存在 R13 原送审快照与 R12 历史档，不放进候选代码。查不清新路径是否触达真实插件、认证、HTTP 或外连时，先重新核对路径和运行边界，不改变运行器放宽保护。

## 19. Diff Budget

四生产文件 +49/-42，唯一旧 Execute 测试文件 +163/-2；五个非文档文件总计 +212/-44，另增一份 Plan。只新增原触发链四个互异用例，没有 Writer 或文件修改并发变更。按目标五 blob 预核 E=176（生产38、测试138），C=27（8＋19），满足本 GOAL 的 15% 最低27；排除空行、仅 import、纯格式/移动、生成文件以及重复说明。实施时按真正 diff 再核实，注释不为了凑配额。一个正式提交，生成文件、诊断、缓存、hook、Guard、依赖、图档和构建物都不进入 diff。

## 20. Real Risks and Open Decisions

历史 B-08：[官方固定 0b 的 benchmark job](https://github.com/SMARK2022/opencode/actions/runs/44782018814/job/136447136892) 在基线 seed 阶段报 `MessageOutputLengthError` 并退出 2，未到候选场景。旧默认模拟流 137,800 字节是从脚本分块计算，实际处理上限为 65,536 字节。当前 5bc 的原基准脚本继承 98a 的修正：`script/guard/bench/opencode.ts:47,105–114` 把每个模拟标记正文改为一个 ASCII `x`，默认模拟正文为 20,000 字节。源差分消除了这一路的旧默认正文超限条件；仍以正式新候选真实 seed 和原 A/B 结果验收，旧红与当前结果分开。

现行 runtime PR 仍要求原规则与性能基准成功，预检模式要求对应平台矩阵成功。`f0eb1b2` 增加早期失败摘要和完整失败日志上传；`27f5f62` 更新覆盖建图、静态与部分覆盖合并，以及现行双契约。8aead 另调整 sdk-next 测试排除、包路径归一化和覆盖失败诊断。上述变化均为基线输入；8aead 未改原基准脚本和 seed 尺寸。既有 98a 夜间建图在真实 HTTP Session 的前台 Task 取消用例失败，本地同一文件在 98a 和旧 #8 候选都通过；该夜间失败不能用于把 #8 修复范围扩大到另一个 HTTP 路由。本版方案阶段的 5bc 同输入对照覆盖 §18 的窄入口。阶段检验先在私有工作树执行；正式 Push、远端预检、A/B 和同 SHA 必过检查按 §1 最新授权及原入口独立执行，无需等待 #5。

### Open Decisions Requiring the User

产品设计无待选分支；远端继续按当前授权，#8 的最终合并由用户决定，单候选及其测试质量不因这一边界降低。

### Follow-up

| 事项 | 保留证据与边界 |
| --- | --- |
| 用户现场第一次中断 | 附件无时间、源或版本；真实 f04 回放足以证明本方案负责的等待环，现场首个信号单列。 |
| Read 与旧整仓记录 | 旧 Gate 下隔离 Read 全 84 项为 A 77/7 → B 84/0，各 464 断言，清单 `4029c306435d6d3a41472aa1e89c7d8215688a259c05f7578bfebeaaecfdbe02`。旧 0dff 全量有 627 fail，804aa1d6 有 642 fail；记录绑定旧二者及其运行器。原快照和 test-local EROFS 的同提交隔离证据保留；先跑新原 Gate 再凭实测决定。 |

### Rejected Speculation

不为中间版的回调数字索引追加测试，不接受任意未经登记的 Job 身份，不改变 timeout 或禁用 Logger，也不把两个窄实验外推成整个上游 Gate 或 benchmark 已修。

## 21. Audit Contract

按当前 Workflow 用 §1 完整原文、唯一 Plan 和仓库根送独立方案审计。范围是固定 f04 到完整终态的四生产路径、一个既有 Execute 测试路径与 Plan，再核对当前正式 5bc 到同一目标的全部差分。独立实现审计基于真实 diff，并验原始红、四入口、独立 Debug、原夹具、原正式门禁和恢复回执。历史批准只对应各自快照，本版接到原样的全范围独立批准之前不能实施或取得实施授权。

## 22. Revision Delta and Plan Audit Record

| Revision | Sections changed | Prior findings and resolution | Invariants, states, concepts, or files added or removed |
| --- | --- | --- | --- |
| R2–R6（历史） | 原 Plan 完整段落已固化在 b671 R6 blob `c646dbbee078e5d649f8e46b907162deecb2f152`；SHA256 `f97fec03f8bf5c2ce1487e399745c17c5197c0a18307011b2eb9da349d85e2ff` | 历史方案和实现裁决原样保存在该不可变 Git/Library 证据；本稿不改写或继承 | 历史不替代当前将审核的修订 |
| R7（历史、未恢复） | 曾改既有测试 +1/-6，生产不变；实际 hunk 不可用 | 行政放行前缀及最后 Plan digest 在 §4，仅作证据定位 | 未从旧 R6 归档、当前远端或本地对象恢复其精确字节 |
| R8（历史） | 模板迁移并形成两次历史红、同输入及候选绿的记录 | 无本修订批准。用户语音指出应按基线写完整终态行为。 | 原稿过度聚焦实验中的单行差分，已由 R9 修正。 |
| R9（历史） | §1–2、§4–5、§7–8、§10、§12–23 | 将当前目标 0dff 设为唯一方案基线，从它说明全部生产和测试 hunk、正反映射与预算；f04/b671 仅用作证据。 | 四个生产 owner 文件、一个测试文件四取消入口及原 Debug、一个新增 Plan；批准清空。 |
| R10（历史，已审本地 63b） | §1、§4、§5、§8、§10、§15–23 | R9 B-01：分别验收固定 f04 与当前目标 0dff 到同一完整候选；R9 B-02：撤掉中间版本索引探针，保留公开一元入口和直接后台/外部等待合同。 | 完整候选四生产路径、原测试文件的新覆盖和 Plan；新输入两基线超时红、直接后台绿，候选四入口及 Debug 绿。本地正式 push Gate 未过。 |
| R11（历史，已审本地 804aa1d6） | §2、§4–23 | 按真 Gate 反馈纠正文件修改组的错误进程清理 owner；实测文件十例、组合五例、原五文件、包级类型和真实构建/终端。 | INV-6；无额外生产行为、用例或断言。正式 Push Gate 失败：OpenCode 642 项和两 test-local EROFS；尚未进入正式预检。 |
| R12（历史，方案已独审） | §2、§4–22 | 保留固定基线至终态的全部产品修复、测试和实际证据；Writer 无探针对照隔离另一个错误全局 hook；按原路径验证两 bundle 契约和快照。 | INV-7/8、一个既有测试文件、零新增测试用例或断言；运行器隔离边界无仓库差分；旧批准清空；共享失败仍受 §20 原发布前提。 |
| R13（历史，BLOCK） | §1–21、§23/24 | 0b 新 Guard 原 38/93 A/B 与真实四入口证据有效；该送审稿使用脚本批量生成，被独立审计驳回。 | 仅保留原始证据；历史固定范围不提供本版实施授权。 |
| R14（历史，已审本地 c232780d） | §2–21、§22–24；§1 既有引文保留并补记 #5 边界 | R13 B-01：逐节直接撰写，重新核对固定 f04、当时的发布目标 0b 与同一完整目标，TDD 连续编号；裁决原文保存。 | 最终六路径，保留四产品及一个 Execute 测试；两个原 fixture 不进入差分。本地原 hook 单提交及独立恢复见 §23。 |
| R15（历史，已审本地 da03eae） | §1、§3–5、§14–15、§18、§20–24 | 保留固定 f04 至完整目标的范围与历史独立通过结果，发布路由更新到 98a。核对八个上游变更与本任务六路径零交集，并将旧 benchmark 缺口与新原流程分开。 | 无生产概念、测试、owner、状态或文件范围增减；五个目标 blob 和对应历史 Plan 经独立审计。 |
| R16 | §3–5、§7、§12、§14–15、§18、§20–24 | 当前发布点改为 27f5，复核九条 Guard 路径与任务差分零交集；独立索引重放及真实窄红绿为现行验证依据，正式 Gate 记录顺序与两个契约以 27f5 为准。 | 同一四生产文件、一个原测试文件及唯一 Plan；零产品设计或用例变更，清空旧批准，进入完整范围方案复审。 |
| R17 | §3–5、§12、§14–15、§18、§20–24 | 新发布点 8aead，隔离索引零冲突复放，同输入真实红绿；以新 core 启动与新 Guard 选择核验实际本轮候选。 | 同一五路径与 Plan，重新作全范围独立方案审计。原 27f5 实施回执、照片和 B-10 裁决保留历史。 |
| R18 | §3–5、§12–15、§18、§20–24 | 发布基线换至 5bc，按现行真实 scope、传输与实例关闭重查触达并复验红绿。 | 同一五路径和本 Plan，重新完整审计。R17 已验证快照、截图和私有恢复继续独立保留。 |
| R19（当前） | §0、§1、§18、§20、§22–24 | 统一 #8 当前私有范围和未来远端验证条件；#5 临时授权仍只适用 #5。 | 5bc 基线、原红绿和五路径设计不变，清空批准后送完整方案复审。 |

| 轮次 | 待审修订 | 全范围 | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 历史 | R13 | 完整固定 f04 与当前 0b | B-01：脚本批量生成 | 无 | BLOCK | 原裁决 SHA-256 `fcb25240cd5d774c0536c2cf79e5b53445693419962d3042bd166c3633c69d5f` |
| 历史 | R14 | 完整固定 f04 与当时的发布目标 0b | 无 | 原文见下方 | APPROVE | 原独立裁决绑定送审 Plan SHA-256 `1fb9188f6625464674a8e113610ff730a03a5985be6dee0dc9ce8e473a83a862` |
| 历史 | R15 | 完整固定 f04 与当时发布目标 98a | 无 | 原文见下方 | APPROVE | 精确方案 SHA-256 `4f2dc7eeb3703426e7031583e8d137c4055c0ccad8ff2e76aba57dcc75e707d5` |
| 历史 | R16 | 完整固定 f04 与当时发布目标 27f5 | 无 | 原文见下方 | APPROVE | 精确方案 SHA-256 `193c3bf85b38a6479e026730c6580ee032d23edc3c3638156a1df7b6cb5e4d5c` |
| 历史 | R17 | 完整固定 f04 与当时发布目标 8aead | 无 | 原文见下方 | APPROVE | 方案 SHA-256 `f5d80e55667072b826a903d605bac2d9a2e3c1b8adfbd0be32443d96f3ce8996` |
| 1 | R18 | 完整固定 f04 与当时发布目标 5bc | B-12 | 见原裁决 | BLOCK | 精确方案 SHA-256 `ef563ec91d1d2ff856580fa2354a665a9070f009b28424ac4287b28cb5a2d713`。 |
| 2 | R19 | 完整固定 f04 与当前发布目标 5bc | 无 | 无 | APPROVE | 精确方案 SHA-256 `0ec311d296ba9791b4f2e58ece568e702ce4bae065e928a88fbbb992435e809d`。 |

<details>
<summary>R18 独立方案审计 B-12 与发布裁决（原文）</summary>

### B-12 #8 的线上验证授权与 §1 的范围记录冲突

- **Violated invariant:** INV-8，最终单提交须走新版原 Gate，远端操作须符合用户原文。
- **Evidence class:** contracted。
- **Producer and execution path:** 用户授权 → canonical Plan §1 → §18 线上预检及向 #8 写入候选。
- **Source evidence:** §1:31 将远端范围交由本节末尾确定；§1:135–139 只记录 #5 临时分支授权，并写明 #8 当前停在私有阶段。
- **Canonical-plan evidence:** §0:17 与 §18:346 把 #8 线上验证写为已获授权；§1 未收录该条授权的原话和来源。
- **Responsibility owner:** Canonical Plan 的需求与发布范围记录。
- **Concrete behavioral consequence:** 实施者可以按 §18 写入 #8，也可以按 §1 继续保持私有；同一方案给出两套操作范围。
- **Pre-R1 baseline behavior on the same path:** 固定基线用于核对产品行为。R17 保留 #5 的单独授权及 #8 的发布边界。
- **Round basis:** introduced by delta。
- **Minimal correction direction:** 在 §1 补入 #8 授权的逐字原文、来源及生效条件，并统一 §0、§18、§20 的行动范围；若尚未取得该条授权，将远端操作写成待授权步骤。

## Release verdict

**BLOCK**

适用于精确 **PR #8 R18 方案**，SHA-256 `ef563ec91d1d2ff856580fa2354a665a9070f009b28424ac4287b28cb5a2d713`。B-12 只涉及权威发布范围记录。修订后送完整范围复审。

</details>

<details>
<summary>R15 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

隔离仓库当前未直接物化目标测试 blob；已核对历史五路径补丁，其 SHA 与方案一致，且在实际 `98a9f13f` 前像上运行 `git apply --check` 退出 0。实施时从该补丁重放，并校验五个目标 blob。

## Follow-up

从 `98a9f13f` 形成一个本地候选提交后，重新跑现行 Gate、官方基准、真实终端和恢复校验。将实际结果绑定候选 SHA；保留 #8 当前的远端权限边界。

## Rejected speculation

新版基准把默认模拟正文降到旧上限以内。此源差分支持重跑基准，尚不构成新基准或预检已通过的证据。

## Requirement and traceability coverage

原始触发链、用户审查反馈、最新版 Gate、不得修改 Gate、单提交及不实际合并均保留。独立核对上一发布点至 `98a9f13f` 的八个变更与本任务六路径零交集；五个已审目标字节不变。四个取消入口、公开一元调用、真实清理责任、持久终态及原 Debug 工具均有对应验证。

## Primary-path and fallback verdict

共享取消主体保持清理责任，Task 传递真实作业身份，RunState 只排除正在退出的自身作业。保留原超时、持久回执、测试夹具和 Gate，无替代成功路径。

## Release verdict

**APPROVE**，仅限方案 R15，SHA-256 `4f2dc7eeb3703426e7031583e8d137c4055c0ccad8ff2e76aba57dcc75e707d5`。实际差分仍须独立实现审计，合并质量以最终提交的现行门禁为准。

</details>

<details>
<summary>R13 独立方案审计原文（BLOCK）</summary>

## Blocking findings

### B-01 R13 使用脚本从旧方案批量生成

- Violated invariant: 用户明确要求「Plan 不得由机械化、自动化进行生成」，出现此类问题的文档须打回。
- Evidence class: observed / contracted
- Producer and execution path: R12 历史快照 → Python 正则替换和按关键词批量删行 → 写入 R13 canonical Plan。
- Source evidence: `evidence/r13-planning.zgHF8E/edit-plan.py:5–7,29–38,83–85,118`。脚本直接组装并写入方案。送审稿的开头、基线漂移说明和 §18 验证表与脚本写入的内容吻合。
- Canonical-plan evidence: R13 §12、§15、§16。批量迁移后，共用 hunk 映射仍标 `f04 / 0dff`，TDD 切片从 3 跳到 6。
- Responsibility owner: Canonical Plan 编写者。
- Concrete behavioral consequence: 该稿不能作为 R13 的实施授权；执行者会同时看到旧发布基线与当前发布基线的现行验证标签。
- Pre-R1 baseline behavior on the same path: `f04f9307` 不含该 Plan；问题出在此次方案文档的生成过程。
- Round basis: introduced by delta。
- Minimal correction direction: 直接逐节撰写并核对同一 canonical Plan，保留可复用的原文和实测，统一固定 `f04f9307` 与当前 `0b5754df` 的验证口径，再送独立审计。

## Non-blocking findings

无独立记录问题；相关旧标签纳入 B-01 的修订。

## Follow-up

最终候选仍须通过最新原 Gate、按原条件触发的正式 preflight、远端必过检查、完整构建与实机终端及回放。新版 Gate 的两项隔离结果可原样复用。

## Rejected speculation

两项隔离验证支持撤回旧夹具改动。它们只覆盖本轮实测入口，完整发布检查保持原规则执行。

## Requirement and traceability coverage

已核对固定 `f04f9307`、当前发布基线 `0b5754df` 与五个目标代码及测试 blob。五个前像在两基线逐字一致，两个旧夹具的目标是恢复最新基线原文件。原始回执确认 Writer 与文件修改组 A/B 各 38 通过、93 条断言；最新目标代码配两个原夹具，四个 Execute 入口 4 通过、29 条断言。原四条产品行为、Debug 兼容、单提交和用户决定合并均保留。

## Primary-path and fallback verdict

产品仍沿共享取消 flight 和真实作业身份收尾。保持两个原测试夹具、超时与最新 Gate，未发现新增备用成功路径。

## Release verdict

**BLOCK**

本裁决针对精确 **R13 方案**，SHA-256 `431ee04f95f7c8d2c54fbdbd361a1aff4de9e0ed982792b9836f0ceca441ad76`。B-01 修正后，按同一完整范围重审。

</details>

<details>
<summary>R9 独立方案审计原文</summary>

## Blocking findings

### B-01 R9 用发布目标替换了固定的原始基线

- 违反约束：用户要求按最新 Workflow 写出从原始基线到最终行为的完整方案；`docs/guides/workflow.md:26` 将基线固定为 R1 实施前的 HEAD。
- 证据类别：contracted。
- 来源与路径：不可变的历史 R6 Plan 第 348、412、514 行确认 `f04f9307…` 是原始 HEAD。已从恢复的 Git 对象独立核对该提交。
- 方案证据：R9 第 17 行、§15、§21 将 `0dfffcda…` 定为唯一方案基线，把 `f04f9307…` 降为红测对照。
- 责任归属：canonical Plan 的范围和验收定义。
- 后果：正式审查只验收相对于当前发布目标的差分，固定原始基线至最终行为的比较缺少权威地位。四个生产前像相同，足以复用它们的映射，无法代替固定基线合同。
- 轮次依据：R9 的基线改动。
- 最小修正：用 `f04f9307…` 作方案与红测的固定基线，把 `0dfffcda…` 独立列为当前重放、差分审核和 Gate 目标，共用可证实相同的 hunk 映射。

### B-02 后台臂以中间方案才出现的回调索引缺陷作为新增回归判据

- 违反约束：`docs/guides/workflow.md:27` 要求新增回归断言能检出固定基线真实存在的问题，撤回或改写只对中间方案缺陷敏感的断言。
- 证据类别：contracted / reachable。
- 生产者与执行路径：`Effect.forEach` 把数字索引传给 `prompt.cancel`；候选 `execute.test.ts:336–340,355–356` 用第二项的外部加入者验证索引不会触发内部快返。
- 源码证据：`f04f9307:packages/opencode/src/session/prompt.ts:371–374` 的实现只接收会话 ID，已有 flight 时总会等待该 Exit。历史 R6 Plan 第 789、823、894 行把该红灯归于中间实现；R9 §16 第 271 行也明确如此。
- 方案证据：§10、§15 和 §16 保留该判据；§18 的固定基线红证据只覆盖 timeout。
- 责任归属：测试保持原始故障的行为反馈；公开一元入口仍由 SessionPrompt 保持。
- 后果：测试把只在中间版本存在的问题列为最终新增回归判据。固定基线收到附带索引的调用时仍等待同一 Exit。
- 轮次依据：R9 当前固定基线验收硬门。
- 最小修正：保留用户要求的一元生产包装；移除测试中专门触发中间方案缺陷的索引判据，或用同一新增断言证明它能在固定基线检出真实行为缺口。

## Non-blocking findings

§5 将基线上 Job finalizer 的重入写成“触发循环”等时序容易与直接后台取消混读；§16 已分别交代两个入口的等待合同。建议沿用 §16 的表述。

## Follow-up

用户现场的第一次中断来源仍缺实际运行 SHA、时间戳和触发记录；固定基线对照已提供外层持续等待的真实信号。原 Gate 的计时失败仍是正式发布验收项。

## Rejected speculation

当前生产注册点只支持实际 Task Job 身份，现有证据不要求为假设中的多 Job 身份扩展协议。

## Requirement and traceability coverage

核对了四个生产文件从 `0dfffcda…` 到候选的实际 diff、候选测试 blob、Job 与 Runner 生命周期、Debug 共享工具入口，并独立核对 §18 六份原始日志的 SHA-256。原缺陷已有真实红绿证据；B-01 和 B-02 仍违反方案硬门。

## Primary-path and fallback verdict

候选沿用 `SessionPrompt → RunState → BackgroundJob/Runner`，由原 owner 修正两条等待边，Debug 共用同一适配器。未发现另一个成功路径。

## Release verdict

**BLOCK**，适用于 R9，SHA-256 `7316fc444517808dbdb63458247cc18fe450857c9d9676852ffc9c387fc2a6f6`。

</details>

<details>
<summary>R10 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

§16 可更新 Debug 回执描述，指向 §18 已实测的 R10 精确候选单例。正式发布树仍按计划复验。

## Follow-up

现场首次中断的来源仍缺触发记录；当前已在固定基线复现外层等待。原 Gate 计时失败留在正式发布验收，不修改 Gate。

## Rejected speculation

当前 Task 注册与关闭使用同一个实际 Job ID。没有生产者支持为同一 Session 设计任意额外作业身份，本修复不扩大协议。

## Requirement and traceability coverage

- **R9 B-01 已关闭。** R10 分别从固定的 R1 前 HEAD `f04f9307…` 和当前发布基线 `0dfffcda…` 映射到完整候选。独立核对两基线五个生产、测试前像逐字相同，仓库其他漂移单列。
- **R9 B-02 已关闭。** 精确候选测试移除中间方案专有的数字索引探针，保留直接公开取消对已有共享清理的等待，并保留用户要求的一元生产包装。
- 独立核对三棵隔离树使用同一测试 blob `ec43d6fe…`、四份 R10 原始日志哈希及实际测试改动。固定基线和发布基线均复现 timeout 红，两侧直接后台取消均通过；精确候选四取消入口及原 Debug 通过。正式 Gate、型检、五文件回归、实机、独立实现审计及远端状态仍按发布门验收。

## Primary-path and fallback verdict

修复落在原 `SessionPrompt → RunState → BackgroundJob/Runner` 路径。共享清理完成后发布同一 Exit，外部等待仍可中断；Debug 使用共同的 Task 适配器。没有新增备用成功路径。

## Release verdict

**APPROVE**，针对方案 R10，SHA-256 `ef8e5d8f05b4ad082a9cb9e68d2bf8005846514dd6229cb7d3a001e6af727f10`。

</details>

### R11 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 可补上四份 A/B 原始日志及实例见证的可读路径，便于实现审计直接复核。

## Follow-up

正式实施后，重跑原文件修改组十例、原五文件回归、包类型检查、构建和真实终端验收。完整 push Gate、preflight 及恢复回放仍须绑定最终单提交。

## Rejected speculation

本轮证据仅支持删除文件修改组的错误清理调用。其余 Gate 失败继续按具名日志和基线对照归属，不扩大到其他测试、生产 Logger 或 Guard。

## Requirement and traceability coverage

已核对固定 `f04f9307` 与当前发布基线 `0dfffcda` 的完整方案范围。R11 保留 R10 四个生产 blob 和 Execute 测试 blob。新增范围仅是一个既有测试文件 `+2/-7`，不新增用例或更改断言；按方案移除 hook 与闲置导入后，计算所得目标 blob 与 §15 一致。

已核对实例见证及四份原始 A/B 日志。该组已有逐例 Store 加载并释放对应实例；额外全局清理触及另一 Store。只移除此入口后，在未改的 stock preload 下，两原例从 2 fail 转为 2 pass；与原四个 Execute 取消入口同进程运行，从 2 pass、3 fail 转为 5 pass，36 个断言保持。

## Primary-path and fallback verdict

文件修改用例的现有逐例 Store 继续承担清理。原取消 owner、作业身份、回执与等待语义保持不变；无新增清理器、备用成功路径或 Gate 例外。

## Release verdict

**APPROVE**

批准精确 **R11 方案**，SHA-256 `2402af0a8933befa6e37ff2412a43368db0ac256778483695eaf4c7c4e86c400`。可原样记录后实施；完整实际差分仍须独立实现审计，正式发布门禁仍待验收。

<details>
<summary>R10/R11 历史实施原始回执（仅历史版本）</summary>

### R11 实际文件、差分与行数

本轮按 §22 独立批准的 R11 实施；行政批准的完整原始快照 SHA-256 为 `0568ca16d1d8735fa9937b71cb68480f1c55f2dbcfd65bec437a2227095341c7`，保留未改。实施树的发布基线为 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`，原始方案基线仍为 §15 固定的 f04。七条路径为 §15 中的四个生产文件、两个测试文件及本 Plan，源码与测试完整补丁 SHA-256 为 `905723c7e5b7ecacc4dc239a2f9817cbd7c6ed27ee24539821adce0b467a4b36`。两侧基线与实现树逐 hunk 的前后映射见 §15。四个生产 blob 和 Execute 测试均与已经单独审计的 R10 完全相同。新增到本轮范围的文件修改测试只改 `5bd25d63463c7100c332d3e28d39c55fe3c5a143`（+2/-7）：删除文件级全局清理 hook，其余保留每个真实 Effect 实例的原清理和原断言。未改 Guard、依赖、配置和 Gitlink。

基于实际 diff，生产 +49/-42、E=38、C=8；测试 +165/-9，E=141，C=19。相对原计算多的是三个清理 hook 行；两条 import-only 替换、随 hook 删除的注释及空行不计。合计 E=179、C=27、门槛 27。相邻注释说明 finalizer 自等、首个请求断连仍需共享结算、公开 API 的作业身份边界，以及 scope 逆序保护用例的真实清理闸门；R11 删除的注释不计。保留 R10 原样有效注释，不新增重复注释。Git diff --check 退出 0。

### R11 原始反馈、红绿和替换路径

固定 f04 真实业务红反馈及精确目标工作树的对照见 §18 和下方历史原始回执。R11 按同样的原 Guard 实际复验修正前后的第一个文件修改场景与 Execute 四入口，冻结测试入口、依赖和私有环回运行配置。原 R10 工作树为 2 通过、3 失败、36 断言、退出 1，原始 stderr SHA-256 `042b301d05450168c0dcd520b7936ea0bddc7b9d5a8be623d0e96a2ebee6d9b2`。实际 R11 完整文件修改文件 10 通过、41 断言、退出 0，stderr SHA-256 `ee17d3cbde7e22e83a3e8f7817b4b245c314c22c6aa8372880dd3d1266934a1c`。原首例加 Execute 的 timeout/session/background/scope 四入口共 5 通过、36 断言、退出 0，stderr SHA-256 `1a430c72556f3ec5c2e04356e1f93f9e34ccfbdd8385523e3fa6d7d42329198c`。原始命令、退出及测试输入在 SHA256SUMS（`44c2fadd24205f597414023816852a5c7c03678f0fc9045d49d24b05d76b2a39`）。

服务清理走已有 per-test Store owner，并非丢弃责任；R11 删除绕入全局 AppRuntime 的额外入口。原外部 join、作业保留/退出与内部 finalizer 快返仍在同一个共享 flight 合同之内。生产无临时诊断、替代成功路径或新增配置。全量基线中的其余资源类失败保留原回执，不归因于本轮这一处夹具，也未修改其 Guard 判定。

### R11 包级原类型检查

已在同一实施树运行 `packages/opencode` 的原完整包级 `bun run typecheck --singleThreaded`，脚本实际执行 `tsgo --noEmit --singleThreaded`，保留原 tsconfig、冻结依赖和审查过的无外连进程入口。香港时间 22:26:06.753 启动、22:27:33.268 退出，86.509 秒，退出码 0，未输出诊断。原命令、分离的 stdout/stderr、进程退出与时间保存在 `TYPECHECK-AND-FIVE-PREP-SHA256SUMS` 所列回执，清单 SHA-256 `0684022268a054bdba7aec2b70d2ba2218042723188d6a8629bbab641557e07b`。
### R11 原五文件回归与实机构建

同一 R11 源差分 905723c7… 按批准顺序运行原 Execute、Prompt、Task、Runner 与 BackgroundJob 五文件套件。Bun 279.94 秒，317 通过、1 项原有跳过（v2 projector disabled）、0 失败，共 1,854 条断言，退出 0。运行前后重新核对六个代码文件的完整差分以及五文件实际输入 SHA-256；未加新的筛选或跳过。原始分离 stdout/stderr 与退出回执见 FIVE-REGRESSION-SHA256SUMS（2397a7de48c50bdc623f6b747601d53b188232f873c6497a93866293494c23cc）。

所测 R11 Linux x64 原发布构建包含 Vite Web UI，CLI 版本烟测及 Voice worker 烟测都通过。构建使用同一冻结依赖、两条原 Gitlink、无任何远端且只读的精确输入。退出 0，输出的完整 tar 流 SHA-256 为 e2429bc5fdaba50d8ad8d39217cf0ac413336d9c34987e0962e7f19fd3fee7b0。真机运行该次编译的 229,755,056 字节二进制，实际 SHA-256 66de754e7b2fc15457674bc08ab132553559796192b923e5f04dee301363aa43。原本地 fixture 的 R10 文本标记原样复用，构建版本和二进制哈希绑定本次 R11。

保留第一条 Xfce shell 内启动记录：用户命名空间的 /usr 挂载在应用启动前退出 32。实际验收改用已经验证的 R10 启动链，同一受审查、无外连和私有 PTY 的 launcher 从正常执行端启动；实时 PTY 输出原样接入新开的 Xfce 终端。原场景按两次 Esc，中断子模型流；Task 在连接断开后 10 毫秒持久化错误终态，外层 Execute 在 19 毫秒持久化错误终态。真实终端显示 interrupted；同一会话随后的提示词得到并渲染 EXECUTE_R10_READY。真实桌面两张截图分别记录中断状态和续答。Ctrl+D 后应用、daemon 进程、daemon stop 命令、闭环 fixture 均退出 0。原始阶段、捕获时间、截图及启动退出回执见 NATIVE-ACCEPTANCE-SHA256SUMS。

### R11 原本地 Stop 与仍待完成的发布验证

在仓库根 `/app` 运行原 `bun script/guard/gate.ts stop --files <本轮七个实际路径，以逗号分隔>`，未改变 Gate 选测参数。七路径规则检查及静态选测通过，四个生产文件的类型感知检查给出原有 12 条提示；未作为错误。原选择器仅得到 opencode 全量（受影响 248/323，超过 50%；always 0），Stop 按默认合同将全量推迟到发布预检。本地 Stop 退出 0，stdout SHA-256 `8be82cc02b446bdce65b32b1e3f1a26098b5394a24ad35f0a8b6255058107859`。原命令、读选测与真实 stdout/stderr、起止和退出回执清单 R11-STOP-SHA256SUMS SHA-256 `f60f995a6c7d2b80596068a9f4a413dfa90be3c66623269b926b14f196f001c5`。

当前为实施审计输入；正式单提交、对应 SHA 的原 push Gate、预检、GitHub CI 及最终持久化回放在独立实现审计后进行。历史原全量的共享资源问题不作通过处理。

### R10 原始历史实施回执

以下回执只适用于原 R10 实施；当时本地提交和 Gate 另见 §18。

### Actual Files and Diff

从精确发布基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`、树 `d61877bc7d3e7ae1f4765f0e23effb70c2183745` 建立独立、未提交实现树。四个生产 blob 与一个测试 blob 已按 §15 的批准前像、目标逐一校验并落地；生产 +49/-42，测试 +163/-2，另外只有本 Plan。应用时保存的只读批准快照 SHA-256 为 `08f24b84f50f0285f52ee4a328a114fcc6c7fb33c1a69152e7dd9a4c32e543f4`，本节只补实际实施证据。原 Gate、依赖、配置和 Git link 均不在差分。

代码/测试精确补丁 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`；`git diff --check` 退出 0，真实 index 无暂存内容。含批准 Plan 快照的六路径补丁另外在干净目标 index 上回放校验，产出同一树 `5569aad2d6ecea745f3a20bf4bb8b380e96330b5`；该树只证明本地快照可复算，最终文档回执入树后需重验。

按实际 diff 核算：生产 E=38（空白无新增；忽略缩进后 47 行，排除新增 8 行及删除 1 行注释），相邻语义中文注释 C=8；测试 E=138（165 行中排除 21 注释、4 导入、2 空行），按语义保守计 C=19；不计 scope 中本用例没有直接断言的 Exit 类型注释及紧邻重复的作业状态提示。合计 E=176、C=27，门槛为 27。实际代表性注释说明内部 finalizer 自等、首发请求断连仍需共享结算、公开 API 与作业身份边界及守住测试清理闸门的 scope 逆序。计量由实际 diff 复算，交独立实现审计复核。

### Red-Green Test Evidence

本阶段重新执行真实 red → green。先在 0dff 的独立实现源只放入批准测试 blob `ec43d6fe7c0bbf705b263c23f8986a7862ebeb1a`，在 `/app/packages/opencode` 用 Bun 1.4.4 执行：

```sh
bun test test/session/execute.test.ts --test-name-pattern '^Execute timeout settles a real Task cancellation after child cleanup$'
```

红：真实用例在 15028.43ms 达到原 15 秒上限，2 个断言、exit 1，日志 SHA-256 `5feddb96a7488986d184280545bb4f4088c8b086c5a5464a4568babf0ac58d96`。之后只加入 §15 批准的四个生产 blob，用逐字相同测试输入重跑：1 pass、7 断言、用例 2509.25ms、exit 0，SHA-256 `77737cd4d7234ee857ef2ec216b98111a0ce9be7581050ac248d04e43852f6a3`。两次使用只读候选源、仅环回网络和私有 HOME/XDG/tmp。固定 f04 的原缺陷信号和 §18 计划实验均单独保存。

### Verification Commands and Results

| 实际命令与目录 | 结果 |
| --- | --- |
| `bun test test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|session\|background\|scope) settles a real Task cancellation after child cleanup$'`（`/app/packages/opencode`，竖线为正则交替） | 候选四入口 4 pass、29 断言、5.42 秒、exit 0。SHA-256 `8b3acdd84aaee5d6ebc178e03dc739b8d1df84387279499ade1ad69bbc4c6630`。 |
| `bun test test/session/execute.test.ts --test-name-pattern '^debug execute uses the same native tool host$'`（`/app/packages/opencode`） | 1 pass、2 断言、2.89 秒、exit 0。SHA-256 `108bc6d5c1373d1a86a19bec7ebd7b0f134c0ad7bcc5fecae1c19fee86f60a5a`。 |
| 下列原五文件命令（`/app/packages/opencode`） | 修正隔离工具路径后，317 pass、1 个既有 V2 skip、0 fail，1854 断言，原范围 318 例，294.40 秒，exit 0。SHA-256 `1486651e645b6f2a0883b32c7c0ee57a5ec3dc54822b9cf3e68f51741588f7b4`；重跑时 59 次可用内存采样最低 4,283,992 kB。 |
| `bun script/guard/gate.ts stop --files <六个实际路径，以逗号分隔>`（仓库根 `/app`，保留原选择器与私有 Git/Guard 数据目录） | exit 0；六路径规则通过，静态选测通过，12 条原有行提示均在改动段外。按 Guard 原规则将 opencode 全量选集交给 push/preflight；此回执只完成 stop 层。SHA-256 `116b3eab06e112eba208a217aac469ebe9f0f8e373405ad436c488cc1bcb81c6`。 |
| 首轮 `bun run typecheck`（`/app/packages/opencode`） | 原范围 `tsgo --noEmit` 收到 SIGKILL，包装器 exit 1，无类型诊断，原日志 SHA-256 `9235ab9c51521ccbf308dc22d6cd0dcaa378588424f6ac3253acb546c5758067`。 |
| 重跑 `GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded`（`/app/packages/opencode`） | 原 `tsgo --noEmit --singleThreaded`，同一文件及类型检查范围，exit 0，89.249 秒，最大 RSS 3,011,232 kB。日志 SHA-256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`。两个认证插件的类型依赖均解析到同一个候选 `/app/packages/plugin/src/index.ts`。 |
| `bun run build --single --skip-install`（候选私有可写实现副本 `/data/native/packages/opencode`） | 完整构建 exit 0，54.980 秒，最大 RSS 2,457,968 kB；保留 WebUI，Vite 转换 2578 模块、40.31 秒完成；编译 CLI 版本与语音 Worker smoke 均通过。构建日志 SHA-256 `5273a4a27ded8c118739543a1a0ddc20e606f8b1717337f0c71c7095693e5413`。产物二进制 SHA-256 `76a797bdc730ad40367395e40b50042e2c5afba709410bffcfe6408075f65381`、229,755,056 字节；OpenTUI .so SHA-256 `ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d`，gitlink `b0cf25352ca75b964eca476af3554e6aa8dd8b20`。 |
| 编译后 CLI 在真实 Xfce Terminal，候选 argv 含仅环回模型与私有项目，实际 PTY 键入 `CANCEL_R10`、两次 Esc、`READY_R10`、空输入 Ctrl+D，再执行同一二进制 `daemon stop` | 子模型连接实际断流，Task/Execute 两个持久 Tool 错误均有 end；同会话完成 `EXECUTE_R10_READY`。应用、daemon 进程、daemon stop、模型服务均 exit 0，整体 exit 0。原始回执 SHA-256 `45e41af4873cfe03ab306e6b26eb1005ee9c4396333cda3ec15aa44969e825e1`。 |

```sh
bun test test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts
```

原五文件首轮 306 pass、1 skip、11 fail（SHA-256 `24f380e8d259ab59f45a057e7e738e34331b71990cbf0fe1a3eb81140bd57eda`）。原隔离入口未带主机既有 Ripgrep，落到系统 Git 2.47.3；只读挂载原有 Ripgrep 15.2.0、Git 2.56.1 后，候选按原名字重跑 11 例全绿；随后才重跑完整范围。源码、测试、依赖与网络限制保持原样，首轮证据不覆盖。

构建使用原有 `MODELS_DEV_API_JSON` 参数和仓库固定 Models API 快照，SHA-256 `876afae217cdff37c7267ba757d4d375a64eb52cdb2caa24c7f027b5142e3265`。首轮 Vite 因只读依赖挂载无法创建 `.vite-temp` 退出，日志 SHA-256 `bc5b12248589860d17a721935778e9ecb938d2f49b92051c6189f83ee8ea6529`；重跑只让隔离内 app 的依赖目录入口可写，依赖自身仍为同一只读版本。完整产物 TAR SHA-256 `7e35285662f7ad8b5c2f968bc72e15f05aa44535ef6126162595d1e9044f71f7`。

实机截图从真实 Xfce Terminal 直接取原始屏幕字节：`final-01-cancelled.jpg` SHA-256 `c2e9b592b14394a7f942197100ca1d072ffe8c572be4b50a096d47484def8203`，`final-02-ready.jpg` SHA-256 `f84a98526c08e4e281f3498ee45e848c7e13f1accafd69c9c7fcc08f26a58483`。桌面 shell 的独立挂载域不能直接启动该隔离器；所以在已验证命名空间中运行真实程序，私有 PTY 的实时字节送到桌面，不重放文本或重绘图片。首次 `/exit` 键入只开命令菜单；改用原空输入 Ctrl+D。首次正常应用退出后，验收脚本作为 PID 1 未及时回收已退出 daemon，让原 stop 的存活检查等到超时；给脚本加正常 `waitpid` 回收，用原 CLI 停机并获得进程 exit 0。截图保留隔离终端的 socket 提示原画面，无后期遮盖。

### Original Feedback-Loop Result

精确 0dff 实施树用同一批准输入重现 Execute→真实 Task 的超时等待；加入批准修复后，实际外层错误、持久无 running/pending、原清理收尾均由通过的回归断言覆盖。session、background、scope 和旧 Debug 原生 host 全部通过上述实施实测。真实终端上，子模型断流后 Task +22ms、Execute +33ms 即写回持久终态，原会话正常完成后续回复；实际终端、daemon 与模型完整退出。该耗时从断流监测记起。

### Actual Secondary and Replacement Path Inventory

内部 finalizer 快返是同一个共享 flight 的必要分支，公开等待、Runner 和持久回执沿原合同。已移除包住 owner 的可中断 `restore`、内部绕公开 cancel 的重复接线与 Debug 私有拼装，保留可中断的公开 join。无新增备选成功路径或生产诊断分支。

### Remaining Unverified Items

待正式单提交及对应 SHA 的原 push Gate、实际预检与持久化回放。实施证据恢复包已独立校验并在空目录重放（SHA-256 `abb3ee6e166e5ed3d8506d13b38dd2a65fe6917e867f8085e41ce5587da47a33`，审计输入树 `60563d12e9d0f4f4b6815373020f04b7c7a349d8`）；此为审计输入，尚非最终提交。R10 独立方案审计裁决记录于 §22，实现审计裁决见 §24。

</details>

R16 · Independent plan audit · 2026-11-21 · audited SHA-256 `193c3bf85b38a6479e026730c6580ee032d23edc3c3638156a1df7b6cb5e4d5c`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§8 的 INV-8 行仍用现在时描述 Client/SDK-next 在旧隔离器中的 `EROFS`。建议标明这是历史四契约的观察。§18 已为当前 `27f5f625` 明确指定 Schema、Protocol 两个固定契约，正式执行入口清楚。

## Follow-up

按 §18 在最终同一 SHA 上核验原 Gate、实际选测及所需平台预检、完整原 benchmark、真实终端和空目录恢复。固定基线同一用例的约 15 秒 timeout 证明了可复现的取消等待问题；用户现场最初由谁触发 Interrupt，另待原始现场日志。

## Rejected speculation

无需调整默认 `600000ms`、增加备用取消成功路径、修改已有 Writer 或文件修改并发夹具，或把其他 Guard 红点并入 #8 的产品改动。

## Requirement and traceability coverage

用户原始场景、三条审查反馈和发布要求均有映射。固定设计基线 `f04f9307` 与当前发布基线 `27f5f625` 分开，两个比较均指向同一四个生产文件、一个既有测试文件及一份 Plan。复核了当前发布目标和五个候选 blob，验证记录清单逐项通过：当前基线的 timeout 用例失败，直接后台取消通过；隔离候选四个取消入口 4 pass、29 条断言，独立 Debug Read 1 pass、2 条断言。原 Guard 收尾额外失败有单独记录。

## Primary-path and fallback verdict

Task 登记处传递实际作业身份；SessionPrompt 继续负责唯一取消 flight 和持久收尾，RunState 只从原快照排除正在退出的作业，外部等待者继续等待同一个 Exit。Debug 共用原 Task 工厂。未发现新增备用成功路径。

## Release verdict

**APPROVE**

批准精确 **PR #8 R16 方案**，SHA-256 `193c3bf85b38a6479e026730c6580ee032d23edc3c3638156a1df7b6cb5e4d5c`。记录原裁决后可按方案实施；实际差分仍须独立审核，正式可合并质量由同一最终 SHA 的原门禁确认。
```

R17 · Independent plan audit · 2026-11-21 · audited SHA-256 `f5d80e55667072b826a903d605bac2d9a2e3c1b8adfbd0be32443d96f3ce8996`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

在实际 R17 候选重跑 Debug Read、原五文件回归、完整构建和真实终端两步验收。新基线改变了 Core provider 注册时机，原 R16 实机回执保留为历史。正式单提交仍须通过原 Gate、所需预检、完整 A/B、远端必过检查及空目录恢复。

## Rejected speculation

无需修改取消预算、扩大 #8 的产品范围，或把目标分支的 provider、TUI 测试和选测器改动纳入 #8 差分。

## Requirement and traceability coverage

核对了原始需求、三条审查反馈、固定设计基线 `f04f9307` 和当前发布基线 `8aead09f`。上游五个改动路径与本任务六路径零交集；四个生产文件和一个原测试文件的目标保持 R16 字节。新基线红绿回执清单逐项通过：原具名 timeout 在约 15 秒失败，后台对照通过，基线额外的 Guard 收尾失败单独记录；候选四个取消入口全部通过，共 29 条断言，自然退出 0。

## Primary-path and fallback verdict

Task 保留真实作业身份；SessionPrompt 持有唯一共享取消，RunState 只排除正在退出的作业，Debug 复用原 Task 工厂。未新增备用成功路径。

## Release verdict

**APPROVE**

批准精确 **PR #8 R17 方案**，SHA-256 `f5d80e55667072b826a903d605bac2d9a2e3c1b8adfbd0be32443d96f3ce8996`。记录原裁决后可实施；实际差分和当前基线回执须独立实现审计。
```

<details>
<summary>R19 独立方案复审裁决（原文）</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

按 §18 在 5bc 实际候选上完成原生命周期回归、完整构建、真实终端和当前原 Gate，再送独立实现审计。#8 的线上验证须等 #5 先验收，且确认 #8 的具体操作与范围。

## Rejected speculation

5bc 的宿主、实例和传输关闭继续由上游管理。原始取消未收敛仍由 SessionPrompt 与 Task 作业的互等解释，无需另开关闭路径、改 Gate 或加计时器。

## Requirement and traceability coverage

B-12 已关闭。§0、§1、§18 和 §20 一致限定 #8 当前只做私有方案、实施和本地验证；#5 的临时分支授权仅适用于 #5。最终交付仍要求一个达到可合并质量的提交，合并由用户决定。

复核覆盖固定 `f04f9307` 及当前 `5bc061b` 到同一完整终态。上游 13 个变更路径与候选六路径零交集，冻结五路径补丁在 5bc 上 `git apply --check` 通过。重新校验原红绿回执：基线 timeout 具名失败，直接后台入口通过，资源清理失败单独记录；候选四入口 4 通过、29 条断言、退出 0。历史版 Gate 和原生实机回执仍归各自候选。

## Primary-path and fallback verdict

SessionPrompt 持有同一取消任务的清理责任。Task 传真实退出作业 ID，RunState 只排除该作业；公开取消保持一元入口，外部等待者共享完整退出结果；Debug 沿用原工具工厂。新增备用成功路径为零。

## Release verdict

**APPROVE**

批准精确 **PR #8 R19 方案**，SHA-256 `0ec311d296ba9791b4f2e58ece568e702ce4bae065e928a88fbbb992435e809d`。原样登记裁决后可按方案实施；实际差分须通过独立实现审计。

</details>

## 23. Implementation Evidence

R19 尚未实施；以下 R17 及较早回执属于各自列明的历史候选。

### R17 实际差分与本轮窄验证

按 §22 的精确 R17 批准，将 §15 五路径应用到 `8aead09f29652c5acf5004675845873ab1d22a58` 私有工作树。实际 diff SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`，与批准的五路径产品及测试差分逐字相同；`git apply --check` 和 `git diff --check` 通过。四生产文件 +49/-42，既有 Execute 测试 +163/-2，沿 §19 排除口径 E=176、C=27。第六路径仅本 Plan；无业务路径、原夹具、Gate、依赖及 gitlink 增改。

在核对五个实际工作树目标字节与同基线私有只读投影一致后，从 `/app/packages/opencode` 实跑 §18 的四取消入口 4 通过、29 断言，5.88s；独立 Debug 1 通过、2 断言，2.69s；原 Writer 与文件修改并发 38 通过、93 断言，4.09s，三项退出均为 0。运行时保留原 Bun 与私有环回边界。精确命令、开始结束、原双流与退出索引 `pr8-r17-stage3.fYmEsm/narrow.SHA256SUMS`，SHA-256 `c17d231770f2499956b6aa62f01f68a9ba0d442711f4121c8bacdb36be58a379`。同基线单输入红保留 §18，具名 timeout 与 preload 的额外失败分开记。以下补录本轮五文件、类型、原生构建及实机。

同一 8aead 候选在隔离只读投影中执行 §18 的原五文件回归：317 通过、1 项原 v2 projector 跳过、0 失败、1854 条断言，272.52 秒。Bun 与资源监控退出 0，五路径差分保持原 SHA。命令、原双流和资源索引 `pr8-r17-five-file.fcgDaS/SHA256SUMS`，SHA-256 `11c8559982112fb730f725c5a57efa1f7f847fd25755b3c1879d7073c680d675`。

同一冻结源码的包级 `GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded` 执行 `tsgo --noEmit --singleThreaded`，74.76 秒退出 0，无诊断。索引 `pr8-r17-native-type.y15SNU/type.SHA256SUMS`，SHA-256 `465588301051ca69ac483fcb0829402107b9df7d410d161ca8b6dfd495a0b8d2`。

完整 Linux 原生构建使用隔离只读源码树 `4fd012753cf023a788add118cef41b109ebed6ef`，逐 blob 验证源码及已批准五路径。原命令 `bun run build --single --skip-install` 用时 38.26 秒，退出 0；嵌入 Web UI 后通过 CLI 和 Voice worker smoke。OpenTUI 0.4.3-smark.13 对应原 gitlink，原生二进制 SHA-256 `c9eebda7c5b88a85deb97a6b33ec336b3729f5b72c59b9b570bc44d08dcd8bb8`。构建索引 `pr8-r17-native-type.y15SNU/build.SHA256SUMS`，SHA-256 `7162bbde438c6ba573287701c57fe6ff1f53b383c8323487adfe99667c727d22`。

同一编译物经过真实 Xfce 终端中的原两次 Esc。子连接在 09:24:54.764 UTC 关闭，同会话的 Task 和外层 Execute 分别在 12ms、21ms 写入错误终态。原始 `cancelled.jpg`（09:24:55.959 UTC）显示 Execute 失败、运行中断和可用输入框；原始 `ready.jpg`（09:25:08.207 UTC）显示 `READY_R10` 得到 `EXECUTE_R10_READY`，界面显示 81ms。第二张底部有隔离终端的 socket 权限提示，回复和输入框均可读。应用、daemon 进程、清理和本地 provider 都退出 0。日志索引 `pr8-r17-live-native.96iMhz/run.SHA256SUMS` SHA-256 `72c39f8615531fd654969334f8332a546e93b3763356d92b63b5302c9b775df5`；原始 JPEG 和时间索引 `pr8-r17-live-native.96iMhz/screenshots.SHA256SUMS` SHA-256 `86bd57b127ede791d683e9675e72a26233e8f29fec0f767977975018d5e062a4`。截图不入 Git。

以六路径冻结树 `a3018752edd58db006e211c719f81a2b60f21c6e` 的隔离投影执行现行原 Gate。09:29:57.559–09:29:59.067 UTC，`bun script/guard/gate.ts contracts` 退出 0，Schema 和 Protocol 均通过。命令及双流索引 `pr8-r17-original-contracts.FxeasF/SHA256SUMS`，SHA-256 `3dd999bbe391ad491dd06cd009d529576e37548c0ceabbf747717566cd892804`。

同树用 §15 精确六路径执行原 `stop --files`，09:32:44.616–09:32:56.485 UTC，退出 0。规则和原静态选择通过；多余防御检查在 `prompt.ts` 报出 12 个提示，不影响退出。静态计划为 OpenCode 全量 323 文件（影响路径覆盖 248/323），Stop 原样递延这 323 文件至线上 preflight，本地实际未运行这组全量。命令、原始输出及选测索引 `pr8-r17-original-contracts.FxeasF/STOP-SHA256SUMS`，SHA-256 `5bef82b70a809ec80be429434248f3f3c9ba46c2eb4fe4684b2b125c2747b2ae`。

正式 Push Gate、实际预检、原 A/B、同 SHA 的远端必过检查和最终提交自包含空目录恢复仍按 §18 验收。现有恢复只验证首审时工作树，不是最终提交回执。保留 #5 先验收的发布顺序，合并由用户决定。

下列 R16 和更早证据归属各自标示的发布基线和实施候选。

### R16 实际差分与保留边界

本轮以已经 §22 原样记录独立通过的 R16 为依据。送审方案 SHA-256 `193c3bf85b38a6479e026730c6580ee032d23edc3c3638156a1df7b6cb5e4d5c`，录入批准与原裁决后的实施输入 SHA-256 `ad022793bc78ab3a897547d4b1665b51fe792bce132c803d386ef38eb2846457`。在私有工作树 HEAD `27f5f6259b43678482bd0f98eb42361e6a768849` 先执行 `git apply --check`，再重放 §15 明确的五路径；`git diff --check` 通过。首轮没有借用旧候选作为父提交。实际五路径完整二进制差分 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`，与批准输入逐字相同；每个实施后的文件对象均与 §15 对应目标相同。第六路径为本 Plan。

| 实际变动 | 已实施职责 |
| --- | --- |
| `packages/opencode/src/cli/cmd/debug/agent.handler.ts` +3/-3 | Debug 不再自己组装 Task Ops，复用原宿主工厂。 |
| `packages/opencode/src/session/prompt.ts` +36/-33 | 公共入口保留单参数；内部入口传真实作业身份，共享取消主体保留清理责任，可中断等待者共享单一 Exit。 |
| `packages/opencode/src/session/run-state.ts` +4/-3 | 原快照只免除关闭中的当前作业，原 Runner 和其余作业仍照原顺序清理。 |
| `packages/opencode/src/tool/task.ts` +6/-3 | 登记和发起取消使用同一真实作业 ID。 |
| `packages/opencode/test/session/execute.test.ts` +163/-2 | 原真实链的四个取消入口、持久终态和独立等待者；保留原 Debug Read。 |
| `docs/plans/execute-task-cancellation.md` 新增 | 唯一方案，以及批准、验证和审计原始记录。 |

实际生产 +49/-42、测试 +163/-2；代码及测试 diff 共 +212/-44。逐字节与 §15 的五文件比对保住 §19 的实际 E=176（生产38、测试138）、C=27（8+19）。该口径排除空行，仅 import、格式、移动、生成行及仅复述代码的注释；典型注释贴近作业退出不加入自己的 flight、外部等待仍可中断和有持久结果才算终态。原 Writer、文件修改并发、两 gitlink、依赖和全部 Guard 字节仍来自 27f5。实际新诊断路径、备用成功路径、回退和开关均为 0；其余入口按 §11 分类沿原职责，不留中间版索引探针或 Debug 手工接线。

### R16 验证及保留项

§18 已存新基线的同一测试前像真实红、实际补丁字节的隔离绿和 Debug，原红在父子清理放开后仍因外层等到约 15s 而失败。正式候选验收独立于这些方案阶段取证。

以下从本轮实际工作树装载源码，仍使用 Bun `1.4.4 (38afee6c8)`、只读冻结依赖和私有 HOME/XDG/tmp 的仅环回载体。四入口和原夹具使用目标基线的 stock preload；Debug 维持原独立命令。

| 实际命令及工作目录 | 结果 |
| --- | --- |
| `/app/packages/opencode`：`bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|session\|background\|scope) settles a real Task cancellation after child cleanup$'` | timeout、session、background、scope 原四入口 4 pass / 0 fail，29 断言，Bun 8.10s，退出 0；原 preload 未报失败，timeout 用例实际 3274.20ms。 |
| `/app/packages/opencode`：`bun test test/session/execute.test.ts --test-name-pattern '^debug execute uses the same native tool host$'` | 原真实宿主的 Read 保持，1 pass / 0 fail，2 断言，Bun 3.68s，退出 0。 |
| `/app/packages/opencode`：`bun test --preload /app/script/guard/leak-preload.ts test/tool/write.test.ts test/tool/file-mutation-concurrency.test.ts` | 38 pass / 0 fail，93 断言，Bun 4.91s，退出 0。两个原 fixture 不改字节。 |
| `/app`：`bun script/guard/gate.ts contracts` | 现行 Schema、Protocol 双契约都通过，原命令退出 0；没有用历史四契约替代。 |
| `/app/packages/opencode`：`GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded` | 实际调用 `tsgo --noEmit --singleThreaded`，08:35:28–08:38:15 UTC，退出 0，无类型诊断。分流与命令索引 `type.SHA256SUMS` SHA-256 `10f1aec22ece7573c7b73eaa0c0cec397fc66d01bf0c465bb8621f0858ef53b9`。 |

四组测试分流日志、命令、退出及时间索引 `pr8-r16-stage3-receipts.BSNqNU/SHA256SUMS` SHA-256 `c86521b7eae841e8d74872254533e56a605dd8c1538fe3db2ce0c29db404cccd`。四入口与类型检查的外层收集脚本在落下原退出 0 后收到 `tail` 展示参数错误；日志文件完整，各命令参数未因显示错误更改。

### R16 首轮 B-10 补验

原五文件回归和完整应用实机补验使用首轮冻结源码树 `c3d02c44bea0a649527bedef1b4c5be6902ac5a7`。补录仅更新本节，五个源码及测试路径逐字保留。首轮 B-10 所缺两项执行回执均已补齐，裁决由独立实现复审给出。

- **原五文件回归**：在 `/app/packages/opencode` 执行 `bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts`。原命令 260.15 秒退出 0，317 通过、1 项原有跳过、0 失败、1854 条断言；资源监控退出 0。只读依赖与私有环回启动器先验网络和工作树；原始双流、命令、退出、资源采样及运行后摘要索引 `pr8-r16-five-file-evidence.O83WQR/SHA256SUMS`，SHA-256 `17f3e30bd0fdca8ef689b675fe392fb3545098ed00fb9e11c045d37733848f16`。
- **完整构建与真实终端**：在精确源码树执行原构建 `bun run build --single --skip-install`，退出 0，产出 Linux CLI、内嵌 Web UI 与 Voice worker；实跑二进制 SHA-256 `d943883419d9aed68f10b8f24643625975e647ee69216a254a44b32079e79170`。原两次 Esc 后子模型连接 EOF，Task、外层 Execute 分别在 16ms、28ms 持久化错误终态；同一会话续答 `EXECUTE_R10_READY`，界面显示 88ms。应用、daemon、清理和本地 provider 都退出 0。Xfce 实机截图在工具记录内：08:44:32.275 UTC 显示取消收敛，08:44:44.510 UTC 显示同会话续答；截图未进 Git 差分。构建和运行索引 `pr8-r16-native-evidence.s0lDfc/SHA256SUMS` SHA-256 `c998adddd30f20b9e3668989ec7056e7e8f58fb554381742286a33d95725da66`；桌面观察附记 SHA-256 `5f7aa9610fb7fbbfc92ab8a6f857ba093c59fdc5d75eb8b545ff3cc8ac5ed8fa`。

同一编译物的带截图复跑保存在 `pr8-r16-final-native.ytI3jm/`。子连接于 09:00:41.812 UTC 关闭，Task 与外层 Execute 在同一会话分别于 20ms、33ms 写入错误终态。09:00:47.705 UTC 的原始 `cancelled.jpg` 显示外层 Execute 失败、运行中断且输入框可用；09:00:58.290 UTC 的原始 `ready.jpg` 显示同一终端中的 `READY_R10` 收到 `EXECUTE_R10_READY`，界面显示 64ms。第二张底部可见 socket 权限提示，续答和输入框均可读。两张图来自同轮运行，保留桌面工具的原始 JPEG 字节。应用、daemon 进程、daemon 清理和本地 provider 均退出 0。运行索引 `run.SHA256SUMS` SHA-256 `c5a9ec191441a80809fc2026778bd27b40309d6e62858521ab6e36a335514d98`；截图索引 `screenshots.SHA256SUMS` SHA-256 `6369a46d7640f62482e45ebd15de2f69057189c7c49b127de43be5738fd50835`。JPEG、索引和时间记录仅作验收材料，不入 Git 差分。

发布仍须完成独立实现复审、原完整 Push Gate、实际预检、正式 A/B benchmark、同一最终 SHA 的远端必过检查和完整对象的空目录恢复。当前工作树尚无 R16 单提交；#8 仅在 #5 先验收且其余发布条件满足后进入发布步骤，合并由用户决定。

以下保留 R15 实际证据及旧待验条目，它们只对应记录当时的基线、工作树和验收入口。

### R15 实际重放与当时输入

对应已批准方案 SHA-256 `4f2dc7eeb3703426e7031583e8d137c4055c0ccad8ff2e76aba57dcc75e707d5`，仅录入行政字段与原裁决后批准快照为 `7663743983d3a93c9b0eada24943bc1138c436f400e762b4db7b691158d46860`。从真实 98a 私有工作树校验并应用原五路径补丁，`git apply --check` 和 `git diff --check` 退出 0。四生产、一个原 Execute 测试的五个 blob 逐个等于 §15；实际代码与测试差分 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd` 与批准输入逐字相同，另有本 Plan。实际 +212/-44、E176/C27，与 §19 的去除空白、纯导入、纯格式／移动及无效注释的同一口径一致。原两个夹具、原 Guard、锁、流程和 gitlink 不入差分。§11 的次要路径分类保持，生产备用成功路径、临时诊断、额外等待或回退策略均为 0。

实际反馈先在精确 98a 产品前像投影只换 §15 的目标 Execute 测试 blob，再在同一隔离环境应用完整生产修复。Bun 1.4.4、只读冻结依赖、私有 HOME/XDG/tmp、仅环回；业务测试从 `/app/packages/opencode`，正式 Stop 从 `/app`。所有开始／结束、退出、原双流、输入哈希及五个目标 blob 由 `RUN-SHA256SUMS` 索引，SHA-256 `e0c9db2ddd1c0fc4a38d043816d19e47259f90aeefc17071aa61d4df1f3274ef`。

| 真正执行的原入口 | 结果（香港时间 2026-11-21） |
| --- | --- |
| 98a 产品前像＋同一目标测试 blob：`bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|background) settles a real Task cancellation after child cleanup$'` | 03:56:35.720–03:56:54.320，exit 1；原 timeout 15,005.87ms 超时、真实 background 外部加入 869.16ms 通过。另有整轮 afterAll 报 30s、60s 及两条 3600s 存活计时器，原样记录；业务红以具名超时判定，未将计时器归到特定 owner。 |
| 98a 完整目标，原四入口：`bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|session\|background\|scope) settles a real Task cancellation after child cleanup$'` | 03:57:20.233–03:57:25.969，四项通过、76 未选、0 失败、29 断言，Bun 5.52 秒，exit 0。原 timeout 在释放真实 child 清理后完成并保存收尾；整轮 preload 无失败。 |
| 98a 完整目标，原 Debug：`bun test test/session/execute.test.ts --test-name-pattern '^debug execute uses the same native tool host$'` | 03:57:25.978–03:57:29.877，1 通过、79 未选、0 失败、2 断言，Bun 3.72 秒，exit 0。 |
| 98a 完整目标，原 `bun script/guard/gate.ts stop --files <§15 六条实际路径，逗号分隔>` | 03:57:58.240–03:58:10.537，六路径规则和静态选测通过，12 条既有非阻断提示，exit 0。原 Stop 将 OpenCode 全量递延给正式 preflight；此处没有运行或获得其结果。 |

### R15 对首轮实施审计的补验

首轮裁决 B-09 原样保存在 §24。仍使用同一 98a 私有投影、同一五路径补丁和锁，保留各次原命令、目录、分流日志、退出与源码前后校验。在整个补验期间，四生产、唯一 Execute 测试、原测试夹具与冻结输入均未变。

| 原入口与目录 | 当前实际结果（香港时间 2026-11-21） |
| --- | --- |
| `bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts`，`/app/packages/opencode` | 04:01:00.046–04:05:39.531，自然 exit 0。317 通过、1 原 v2 projector skip、0 失败、1,854 断言，Bun 279.30 秒。两个发布基线结果按文件、名称、状态逐项核对，318 个用例状态无差、断言总数一致，运行次序按当次原记录。 |
| `bun test --preload /app/script/guard/leak-preload.ts test/tool/write.test.ts test/tool/file-mutation-concurrency.test.ts`，`/app/packages/opencode` | 04:06:03.868–04:06:08.339，自然 exit 0。Writer 28、文件修改 10，共 38 通过、0 失败、93 断言，Bun 4.30 秒。 |
| `bun script/guard/gate.ts contracts`，`/app` | 04:06:08.344–04:06:10.206，自然 exit 0。Schema、Protocol、Client、SDK-next 都通过。仅两个既有测试目录的生成目标使用隔离私有临时写入；六原测试仍只读逐字，运行前后宿主状态一致。 |
| `GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded`，`/app/packages/opencode` | 04:06:36.176–04:08:14.110，自然 exit 0，实际 `tsgo --noEmit --singleThreaded` 无诊断。采样峰值 2,992,852 KiB RSS，最低 MemAvailable 3,643,328 KiB；代码、锁、Guard 与 tsconfig 输入前后逐字相等。 |

扩展测试、夹具与契约原收据索引 SHA-256 `450fcd07f301ce2eb9313640f2c7ed75df80ca0b9dcbabb141085bb20c16d2ba`，包类型索引 `0a41e926882552ecda9d821b700b30c9fccf9a2969bf0dfd36443d7602c46fce`；五文件逐用例对照 SHA-256 `03326568b36424391b6d5162a67bcc6e7b67e0b93a64c42d4adec9aae3f10d04`。

### R15 完整构建与真实终端

使用同一 98a 前像、五路径 5f33 与当时 canonical Plan SHA-256 `97d3f4fec787d190dcbef8a20a26f32ee29a2a683d1f9c15342bfe2aa1d37b7a`，实际构建输入 tree `8f3a3f96ea62e8a8c3b24a12b5871b939f2708a9`。用原私有无外连 runner、冻结只读依赖、原 OpenTUI Gitlink 和原完整入口，从隔离的 `/data/native/packages/opencode` 运行 `bun run build --single --skip-install`；外层 10 分钟硬帽。香港 04:19:24.737–04:20:07.347 自然退出 0，Vite 32.34 秒，WebUI 内嵌，Linux CLI 版本 `0.0.0-dev1-smark-202611202019` 与 Voice worker 原 smoke 均通过。实际二进制 229,755,056 字节，SHA-256 `b2d125cf8f4560e30f0e1ed9370935fe2649aed30d6d323b3d1efd90a2da6c1d`；唯一原构建 tar SHA-256 `042986239d53d2fd84569b33fe4b4d8cb0dbd896f666ac4ebe54c03a786d31bf`，从 tar 解出的真实可执行物与实测物逐字相同。

香港 04:22:36.158–04:23:07.031，以这份新编译物从原私有 PTY 连接真实 Xfce 终端，外层 4 分钟硬帽。原 fixture 从父 Execute 发出真实 Task，客户端双 Esc 后观察到子模型连接中止。Task 和 Execute 分别在断线后 16 毫秒和 29 毫秒在 SQLite 进入持久 `error`；同一会话随后在终端显示下一条真实回复 `EXECUTE_R10_READY`。Ctrl+D 后应用、daemon 进程、daemon 清理命令和本地模型替身均真实退出 0。两张实拍为 `01-cancelled.jpg`（04:22:51.763，SHA-256 `43b775bb7c845b71b0dd484e1c3d761c166c3fca2b468b188ff76aa1f21f45a5`）和 `02-ready.jpg`（04:22:54.358，`7de380a025489ab02e370a5ab687178d7a86d73b06af885b84440f2acb66e52c`）。原日志、持久状态和输入／输出由原清单 SHA-256 `59bca212295352aa9eb5403e3ccd698d6c26f9a037e071f4b75c6bb9b38c5575` 索引。

原构建及终端资源监控均退出 0，实际 TUI 实测最低宿主余量 6,126,899,200 字节；原操作入口、源码／锁／Plan、两 gitlink 和无外连边界前后相同。香港 04:24:09 核验已回收本轮临时可执行物、启动目录与命名管道，唯一 tar、双图和日志保留。

按 B-09 补齐当前实现范围验收后送独立复审。当前 R15 未建新提交，原 Push、适用预检、原基准、正式必过及这个最终候选的完整空目录恢复仍分开验收。#8 远端权限未变。

以下是独立保存的前次实施及真实运行回执，继续绑定当时的对象、输入和工作目录。

### R14 单提交、原 Hook 与独立恢复

历史 R14 已获独立实现批准（原文见 §24），实际本地单提交为 `c232780d7d314ba097613c8c1788c70f0bf8f8d4`，唯一父 `0b5754df48177fccb05259e705a189df2f50ca2d`，tree `c102d90110da1098913395e5d8110a4b79a74c0d`，提交内经审核 Plan SHA-256 `81ada168c41a3d88c4cad75a8d5db940e87535fca2e329602055f817be1d99f9`。香港时间 02:11:07.545–02:11:15.104 实际运行 `git commit -F .git/r14-commit-message`，原 pre-commit 冻锁流程与 commit-msg Guard 均通过，提交退出 0，工作树干净。12 项一时借用的可重建依赖前后指纹相同并归还。原 Hook 清单 SHA-256 `0743b5c20ac8608e9244037dc13e2903bb1de03f07243dbe83d2dd47e68cdc30`。

历史 c232 的小恢复包 `pr8-r14-c232780d-local-overlay.tar.gz`，SHA-256 `b6321f7985376410107986db9b36b891661f60989381adee9f392854a142ffc0`，从空目录用核实的历史 base 及 0b 原对象增量恢复。香港时间 02:15:27 完成，退出 0；严格 Git 完整性、唯一父、tree、六路径、五路径补丁、Plan 和两 gitlink 均一致。实机原日志及双图的小包 SHA-256 `a38305e53a042a986d73e01a65ba9696937a0ef03b7c060365dfd245cfae3403`，已在空目录逐项校验；Library `[private Library ID redacted]`。原 Push Gate、正式预检与远端必过检查在历史 c232 无通过回执。

### R14 实际范围与窄验证

本次从已批准快照（SHA-256 `aa6ba9c244a692ddd233b315e701a208059680d85783df0517ef1be9b9003bbc`）开始。私有候选 HEAD 为 `0b5754df48177fccb05259e705a189df2f50ca2d`。恢复两项旧门禁专用试验：Writer 回到 `b6fbc0902214c9f99b88d656158db614ed568a41`，文件修改并发回到 `11c02b10d27ac10e9360b5cab6322115d9049298`；两文件均与 HEAD 字节相同。保留 §15 四个生产文件及 Execute 的五个精确目标 blob，未改断言、生产逻辑、门禁、配置、依赖或 gitlink。实际五路径补丁 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`，与独立审计前的预期参考逐字相同。`git diff --check` 退出 0，真实暂存区为空，另有此唯一 Plan。

实际代码／测试差分 +212/-44。逐路径核对保留的 hunk 与既有计数记录：Debug E5/C1、Prompt E20/C4、RunState E6/C1、Task E7/C2、Execute E138/C19；合计 **E176/C27**，满足最低 27。排除空行、仅 import、注释行、纯缩进／移动及重复说明。恢复原样的两个测试文件不进入 E/C。生产新增备用成功路径、临时诊断及新增调度策略均为 0。

固定 f04 的共同 Execute 输入曾在真实 Task 路线上达到 15 秒上限，原结果见 §18；直接后台原本成功，保持这条兼容对照。两项旧清理的方案阶段 A/B 仍保留。历史 R14 恢复到其实际文件后，从实际 0b 树投影只读运行，逐项校验五目标文件、两原 fixture、冻结锁和当时的 Guard preload；`/app/packages/opencode` 使用原命令，Bun 1.4.4、冻结只读依赖、私有 HOME/XDG/tmp、仅环回。当次实际结果：

| 命令及范围 | 实际结果（香港时间 2026-11-21） |
| --- | --- |
| `bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts --test-name-pattern '^Execute (timeout\|session\|background\|scope) settles a real Task cancellation after child cleanup$'` | 01:44:23.954–01:44:30.414，四例通过、76 未选、0 失败、29 断言，Bun 6.20 秒，进程退出 0。 |
| `bun test --preload /app/script/guard/leak-preload.ts test/tool/write.test.ts test/tool/file-mutation-concurrency.test.ts` | 01:44:30.419–01:44:35.489，Writer 28、文件修改 10，共 38 通过、0 失败、93 断言，Bun 4.89 秒，进程退出 0。 |

两轮均无资源 afterAll 失败，Bun 输出不单列成功 hook。原命令、双流、时间、退出与实际测试投影的文件校验见 `r14-stage3-scoped.iP5yTJ/RUNTIME-SHA256SUMS`，清单 SHA-256 `ca388303ca4c279e1e8b99702ea1026ce369f2f1c9114956f7108e02b4bd2f6d`。

同一实际工作树从 `/app/packages/opencode` 执行原 `GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded`，实际命令 `tsgo --noEmit --singleThreaded`，无诊断，进程退出 0。香港 01:46:09.716–01:47:33.267，83.551 秒；主 tsgo RSS 峰值 2,967,472 KiB，最低 MemAvailable 4,050,624 KiB，最低磁盘余量 5,410,000 KiB，未触发资源终止。使用原审查运行器和只读冻结依赖；五路径补丁、执行时 Plan、锁、原 Guard 和 tsconfig 前后逐字相同。原日志与逐秒资源见 `r14-stage3-type.vgvnBY/SHA256SUMS`，清单 SHA-256 `c3b4dba36709ea593674dd134844b031cbbdeccca186847aad0072488a6e2126`。

同一实际树、同只读冻结依赖和隔离包目录，按原五文件列表加载新版原 Guard：`bun test --preload /app/script/guard/leak-preload.ts test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts`。香港 01:48:33.468–01:53:14.181，自然退出 0；Bun 279.81 秒，317 通过、1 个原 skip、0 失败、1,854 条断言。实际顺序 Task 38、BackgroundJob 11、Runner 27、Execute 80、Prompt 161 加 1 个 v2 projector 原 skip。与旧 R12 不另加 Guard 的原五文件结果逐条核对，318 个名称、顺序、状态及总断言完全相同。现行 afterAll 无资源失败，也无独立成功断言计数；1,854 是 Bun 对本次整轮报告的数字，未把 afterAll 额外计入测试总数。最低磁盘余量 5,409,880 KiB，未触发资源停止，补丁、Plan、锁、Guard 和原五测试前后逐字相同。原命令、分流日志、资源和逐条比较见 `r14-stage3-five-guard.YG4E42/SHA256SUMS`，清单 SHA-256 `527cde530c1fe82571c1f9378b5a796441c8d61e9e3d63b92ede948cab9aec08`。

### R14 完整构建、真实终端和原本地门禁

在精确 0b 及实际六路径快照树 `4240fc5ca019f975fb7ddaefcd35c558bc2e2373` 上，用冻结依赖从 `packages/opencode` 跑原 `bun run build --single --skip-install`。香港 01:54:33.441–01:55:18.442，真实构建退出 0；Vite 32.46 秒，WebUI 嵌入二进制，原 CLI `--version` 及 Voice worker smoke 通过。Linux x64 二进制 229,755,056 字节，SHA-256 `7ecde5abbf4a6326bbb92a77adfc90e74ab2c7c3eee10fabdf9e698fbc854bfc`。唯一构建 tar SHA-256 `a3bf93446f3ea1b573707e0a18af5f19394409eccf583eaa3eb053e395a790ba`，独立读取可恢复同一二进制。构建当时 Plan 为 `531e57beacc0274a2e1dd743ac559848b3860a3c8528c6c63cc507195fb54ee6`，后续只追加本节验证证据；五路径实际补丁仍为 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`。

同一实际二进制以原验证入口在真实终端运行，香港 01:56:58.761–01:57:30.087，退出 0。两次 Esc 后真实子模型断线，SQLite 中观察到同会话 Task 和 Execute 分别在断线后 22 毫秒、36 毫秒进入 `error`；同一会话随后收到下一条正常回复。之后 Ctrl+D，应用、daemon 进程、daemon 清理命令及本地模型替身的实际退出均为 0。两份实机图分别为 `01-cancelled.jpg`（香港 01:57:12.168，SHA-256 `ab3be39a32011c759054e76e26c10ea5498ec730337bdaed3caaaacb49d78560`）及 `02-ready-verification.jpg`（01:57:25.232，`d4dc4af348f09d1d7690250c417407c6e21a9de32d45c3470403fe4072aaa090`）。实际构建指令、源码哈希、PTY/SQLite 双回执和真实图索引由 `r14-native-verified.h2d2Fo/SHA256SUMS` 索引，清单 SHA-256 `099a4dec46d9102181e17571d254e6f523c2c45c0e15c6e1c0bf5f540e483774`，本次逐项重验通过。

同一候选按以下顺序实际执行，三进程不重叠，实际脚本、命令和原双流见 `r14-debug-contracts-stop.vZgdZH/SHA256SUMS`（SHA-256 `e7ebd1e32d6a3c1ce5d05928ead269a6f6a81da82b2fd064c6adcefa7a759747`）：

| 原入口和工作目录 | 实际结果（香港时间） |
| --- | --- |
| `bun test test/session/execute.test.ts --test-name-pattern '^debug execute uses the same native tool host$'`，`/app/packages/opencode` | 02:00:05.285–02:00:10.294，原 Debug Read 1 通过，2 断言，79 未选，0 失败，Bun 4.16 秒，退出 0。 |
| `bun script/guard/gate.ts contracts`，`/app` | 02:00:10.294–02:00:12.299，Schema、Protocol、Client、SDK-next 四项全过，退出 0。仅两私有 test-local 目录可写；六份源各自只读绑定并打印哈希，宿主无残留。 |
| `bun script/guard/gate.ts stop --files <§15 六条实际路径，逗号分隔>`，`/app` | 02:00:12.299–02:00:25.323，规则与静态选择通过，12 条非阻断既有提示，退出 0；原 Gate 选择 OpenCode 全量并递延到正式 preflight，未把 Stop 计作 Push 或远端通过。 |

三进程最低磁盘余量 5,965,996 KiB，未触发资源停止。候选 diff、锁、Guard 与运行时 Plan 前后逐字相同。这是单提交之前的 R14 原本地运行；之后的原 Hook 与独立恢复见本节开头。0b 的正式发布缺口和 98a 上游基准变化见 §20。

原 R12 收据如下，另有完整独立存档 R12-historical-plan.md，SHA-256 `ade427df4667e0cf08d1f36dd38e91bb949d31f4f844161f8a0d29b5e1f95973`。

<details>
<summary>R12 历史实施原记录（旧发布基线／旧 Guard）</summary>

R12 已按 §22 批准进入实施。批准快照 SHA-256 为 45f5d1a63c13be6d568fd3c91c3a650e750f82601360fbf1aa72538e86e0f369，原样另存。当前证据来自独立 r12-phase3-integration.02by1Y/repo，自精确 R11 提交 804aa1d6 检出，未改原 R11 仓库。以下只记录本轮实际执行结果；未执行门禁逐项留在末节。

### Actual Files and Diff

保留 §15 的四个生产目标及 Execute、文件修改测试的六个精确 blob，本轮只加入 Writer 目标 a53c9046c9cce689ada0425a5ba3ccc9ad8184c8 与本 Plan 更新。两基线各七个代码／测试前像逐一重读 Git 对象，字节相同，各目标与 §15 一致。完整代码及测试补丁 SHA-256：81bde7f0b08929536a40cd4ba8a4146e68ba28d7cffba413d162a2a6925f1338。

Writer +3/-6，去掉文件级全局钩子及两条未用导入项，局部清理继续归原作用域，保留五组原用例正文与断言。四生产 +49/-42，E=38/C=8；三测试 +168/-15，E=144/C=20；总 E=182/C=28，最低 28。排除空行、仅 import 与注释行，以及 git diff -w 排除的 prompt 纯缩进；Execute 两行重叠说明不计 C。Git diff --check 通过。未改 Read、共有夹具、Gate、配置、依赖或 gitlink。

### Red-Green Test Evidence

下列均使用 §18 原始命令、package CWD、Bun 1.4.4、冻结只读依赖、私有 HOME 和原 Guard。原红测先自然退出，然后才修改独立候选上的 Writer。

| 原范围 | R11 红 | R12 绿 | 原 stderr SHA-256：红 → 绿 |
| --- | --- | --- | --- |
| 原完整 Writer 文件 | 25 pass、3 fail、90 expect、exit 1 | 28 pass、0 fail、90 expect、exit 0 | bec9a9829a0f63fb1499ba2436bd03569745d367f1e768b429438a401e29956e → 47bcd8271f1662ccfddd9dac5d43223d49109940b4c335feabfbb0c069973f75 |
| Writer formatter 首例→四个真实 Execute 取消入口，同进程 | 2 pass、3 fail、36 expect、exit 1 | 5 pass、0 fail、36 expect、exit 0 | 80e3d84d8f7ca03b4e43b3ede086127395ee2ced03547011cb1919bb6fd23866 → 71f92c8e60c94131477936b82790287d3a1521288984d3b8770c8c3a87aa700f |

首例原 Guard 记录了 1 秒和 60 秒等待，组合中余下两条 Guard 失败留在原始日志。红绿执行前后的命令、分流日志、时间与退出码均在同一 evidence 目录。

### Verification Commands and Results

| 同树原窄命令 | 2026 年 11 月 21 日实测 | stderr SHA-256 |
| --- | --- | --- |
| §18 原 stock Guard 文件修改组 | 10 pass、41 expect、exit 0 | 12dc368696b3c434e10240deb8da49ee824a5ea7c27beb13e72eecea835f8f91 |
| §18 独立四条原真实取消入口 | 4 pass、29 expect、exit 0 | e0e68b708a9efb10c9496da6eaed6ac1cfb31e8caf366fc3d52aaf8985db0e64 |
| §18 独立 Debug 真实宿主 Read | 1 pass、2 expect、exit 0 | ef23fdf65945927ce05811cca9b77effa090e18355165809af5a31fb1c583bd7 |


包级完整类型已在同树执行：从私有隔离的 /app/packages/opencode 运行 GOMAXPROCS=1 GOMEMLIMIT=900MiB GOGC=10 bun run typecheck --singleThreaded，实际脚本为 tsgo --noEmit --singleThreaded，退出 0，无类型诊断。香港时间 00:57:20.302–00:58:43.943，83.653 秒，主 tsgo 峰值 RSS 2,968,844 KiB。最低 MemAvailable 4,258,784 KiB，最低磁盘可用 5,475,664 KiB。七代码／测试路径差分和锁前后逐字节一致，原命令、分流日志、资源、退出和输入核对收进 typecheck.eK8wN6/SHA256SUMS，SHA-256 7edf56ee0754beac00b97a97f5fe6e3049fe78d82f6b670f7701fac6874742c5。

原五文件回归在同树、同只读冻结依赖和无外连运行器内按 §18 原命令执行：由 /app/packages/opencode 运行 bun test test/session/execute.test.ts test/session/prompt.test.ts test/tool/task.test.ts test/effect/runner.test.ts test/background/job.test.ts。2026 年 11 月 21 日香港时间 01:00:43.810–01:05:21.399，原进程退出 0，Bun 276.47 秒，317 pass、1 个既有 skip、0 fail，1,854 expect。原始报告的实际文件顺序为 Task 38、BackgroundJob 11、Runner 27、Execute 80、Prompt 161 加 1 个 v2 projector skip。逐例核对，318 个名称、状态、顺序及总断言与 R11 相同；两次五文件入口均未额外注入 leak-preload，这项结果不替代受 Guard 检查的原用例与原完整 Gate。前后七个代码／测试路径差分及五个测试文件输入一致。完整回执 five-files.PP1BMH/SHA256SUMS 的 SHA-256 为 b383f13680eb4382928673e9701c7f66c8b0dd90311e974aa6c69cc2ab3e2f50。

### Original Feedback-Loop Result

原真实 Execute→Task 的固定 f04 与当前汇入前 0dff 红回执见 §18；本候选上表沿同一真实工具、作业、取消作用域和持久回执运行四条入口。Writer 串扰也在同编排双臂实测。Read 相似钩子的独立调查未进入本计划或候选。

### Actual Secondary and Replacement Path Inventory

无新增生产诊断、fallback、兼容支路或替代成功路径。保留四个生产目标的完整取消合同；移除文件修改和 Writer 两个文件误用进程 Store 的清理钩子。隔离契约的私有临时目录不在仓库差分中。

### Remaining Unverified Items

同树四契约、本地 Stop、完整构建及真实终端本轮还待执行或复验。独立实现审计、单提交、精确 SHA 原 Push Gate／正式预检／CI 与独立恢复均未完成。保留历史原全量 exit 1；已有窄绿不替代原完整门禁。

</details>

## 24. Implementation Audit Record

R19 尚未进入实现审计。R17 的裁决原文保持；R19 实际实现须独立全范围审计。

R17 首轮实现审计的 B-11 裁决如下。两项原始执行回执已补入 §23，完整范围独立实现复审已通过。R16 的首轮 B-10 及其补验复审属于 27f5 候选。

<details>
<summary>R17 首轮独立实现审计 B-11 与发布裁决（原文）</summary>

### B-11 缺少 R17 的原双契约与 Stop 回执

- **Violated invariant:** INV-5、INV-8。批准方案 §18 要求用当前基线的原命令执行 Schema、Protocol 固定契约和六路径选测。
- **Evidence class:** contracted / observed。
- **Producer and execution path:** 当前 `8aead09f` 候选 → 原 `gate.ts contracts` → 两项固定契约；当前六路径 → 原 `gate.ts stop --files …` → 规则、实际选测或递延。
- **Source evidence:** `script/guard/gate.ts` 的 `contracts`、`stop` 入口；`docs/guides/workflow.md` 阶段 3–4。
- **Canonical-plan evidence:** §18 指定两个入口；§23 明确本轮尚未记录通过。
- **Responsibility owner:** 当前候选的实施验收。
- **Concrete behavioral consequence:** 本轮没有证明当前候选通过两项固定契约，也没有证明新版选择逻辑实际选中或递延了哪些测试。窄测、五文件回归和旧 R16 Gate 回执各自有效，未覆盖此次执行。
- **Pre-R1 baseline behavior on the same path:** 这两条是当前发布基线的验收入口；原业务故障的红绿已经取得。
- **Round basis:** 当前实现的必需验收。
- **Minimal correction direction:** 在冻结的五路径字节上补跑原双契约和六路径 Stop，保存实际结果、选集与递延，再送全范围复审。

## Release verdict

**BLOCK**

适用于精确 **PR #8 R17 实际差分** `193cc41ff8925f4abd0bcfee8c56a55ac2d6ac09e3f67bda20f048c224e46722`。

</details>

<details>
<summary>R17 完整范围独立实现复审（裁决原文）</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

最终单提交仍须按 §18 通过原 Push Gate、实际预检、完整 A/B、同 SHA 远端必过检查及自包含空目录恢复。保留 #5 先验收的发布顺序，合并由用户决定。

## Rejected speculation

原 Stop 退出 0，将 OpenCode 全量 323 个测试文件交给线上 preflight，本地未执行该全量。12 条类型感知提示均来自未修改的代码。两项结果按原门禁各自的范围记录。

## Requirement and traceability coverage

B-11 已关闭。重新核验了两份原始回执清单、命令及退出文件：Schema、Protocol 两项原契约均通过，退出 0；原六路径 Stop 退出 0，静态选择报告涉及 248/323 个测试文件，按原规则递延全量。从实测树 `a3018752edd58db006e211c719f81a2b60f21c6e` 到送审树，仅 canonical Plan 补录了证据和首轮裁决。

复核覆盖完整六路径、原需求及批准的 R17。四种取消入口 4 通过、29 条断言；Debug 1 通过、2 条断言；原 Writer 和文件修改夹具 38 通过、93 条断言；五文件回归 317 通过、1 项原有跳过、0 失败、1,854 条断言。原类型检查及完整 Linux 构建退出 0。真实 Xfce 两次 Esc 后，子连接关闭，Task 和外层 Execute 分别在 12 毫秒、21 毫秒写入错误终态；两张原始截图显示取消收敛和同一会话续答。

## Primary-path and fallback verdict

SessionPrompt 的同一取消任务持有清理。内部 Task 传递真实退出作业 ID，RunState 只排除该作业；公开取消保持一元入口，外部等待者共享完整 `Exit`。Debug 仍用原工具工厂。新增备用成功路径为零，Gate、测试断言及权限边界保持原样。

## Code quality verdict

四个生产文件 `+49/-42`，既有 Execute 测试 `+163/-2`，另有唯一 canonical Plan。按批准口径 `E=176`、`C=27`，达到门槛 27。中文注释对应作业自等、共享清理及作用域释放顺序。`git diff --check` 通过。

## Release verdict

**APPROVE**

批准精确 **PR #8 R17 实现差分**，SHA-256 `9b387a5169082ab86da784dde3f6be415b405f5a16d633c80bef932761a029ca`，送审树 `7b9ce89527f5b8e9cd75d7cadea181cf7ae69783`。本裁决放行独立实现审计；最终单提交的发布与合并就绪状态由 §18 原门禁确认。

</details>

### R16 · Independent implementation re-audit · 2026-11-21

审计差分 SHA-256 `5b069a7f8e3f8ee64bf1d06e0430cf8f98f4530ba2f8f1c1eca2cadfaabbd5e4`。以下为原裁决。正式同 SHA 的 Gate、预检、A/B、CI 与恢复仍保持待验。

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

第二张原始截图底部有隔离环境的 socket 权限提示。终端中的同会话续答和可用输入框清楚可见，相关进程均自然退出 0。

## Follow-up

将原 Push Gate、所需预检、完整 A/B、远端必过检查和空目录恢复绑定同一正式单提交。合并由用户决定。

## Rejected speculation

无需为本次证据补录修改代码、测试、原 Gate 或重新构建二进制。

## Requirement and traceability coverage

**B-10 已关闭。** 独立打开并核验两张原始 Xfce JPEG，文件哈希、窗口和时间记录吻合。第一张显示 Execute/Task 中断后的失败终态及可用输入框；第二张显示同一会话收到 `EXECUTE_R10_READY`。原日志核实，在子连接关闭后 Task 和 Execute 分别在 20 ms 和 33 ms 写入持久错误终态，应用、daemon、清理命令与 provider 均退出 0。

五个代码及测试路径和上一轮逐字相同。当前原五文件回归为 317 通过、1 项原有跳过、0 失败、1854 条断言；四个取消入口、Debug、原夹具、两契约、包级类型检查和原构建回执均已复核。

## Primary-path and fallback verdict

Task 传递真实作业身份，SessionPrompt 持有唯一取消 flight，RunState 只排除正在退出的作业，Debug 共用原 Task 工厂。未新增备用成功路径。

## Code quality verdict

实际六路径差分符合批准的 R16。原夹具、锁、gitlink 和 Gate 保持不变。

## Release verdict

**APPROVE**

批准精确 **PR #8 R16 实际差分** `5b069a7f8e3f8ee64bf1d06e0430cf8f98f4530ba2f8f1c1eca2cadfaabbd5e4` 的独立实现审计。正式单提交仍须完成上述原发布门禁。
```

R16 当前实现状态以本 Plan 的头部字段和 §23 为准，本节尚无 R16 独立实现裁决。历史 R15 首轮实现审计阻断在该候选的验收回执，五路径保持冻结；补验后复审通过。R14 独立实现裁决在本节末尾原样保存；历史 R12/R13 未发出实施审计。

| 轮次 | 方案修订 | 完整原始范围 | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 历史 | R14 | 完整 f04、0b 到同一目标 | 无 | 原文见下方 | APPROVE | 原独立裁决绑定六路径 SHA-256 `bb3de76cef186e1a952d2a847c275afde9dc04c54ef40ce99f4272b9ee19642e` |
| 1 | R15 | 是 | B-09 | 原文见下方 | BLOCK | 六路径 SHA-256 `6066c8321571837b2225f756bb09fcef1e974eaa5d6f2182248a92da2a3989a5` |
| 2 | R15 | 是 | 无 | 原文见下方 | APPROVE | 六路径 SHA-256 `3fa66e6ad2d0fc4ad9b634462c9f06df5c17f2913a6028fb8bbe63194996948e` |

<details>
<summary>R15 第二轮独立实现审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

本轮 Stop 将 OpenCode 全量递延给预检。该记录只证明 Stop 通过，不计作最终全量结果。

## Follow-up

按原 hook 形成单提交，以最终 SHA 运行现行 Push Gate、适用预检和官方基准，并完成空目录恢复校验。保持 #8 的远端权限边界及不合并要求。

## Rejected speculation

旧基准失败与当前候选分开记账。实机的 16 毫秒和 29 毫秒从子模型断线起算，不用于推断用户现场首次中断的来源。

## Requirement and traceability coverage

B-09 已关闭。独立核对当前 `98a9f13f` 候选的原始回执：扩展五文件 317 通过、1 项原有跳过、1,854 条断言；原 Writer 与文件修改组 38 通过、93 条断言；四契约和包级类型检查全部退出 0。原构建及真实终端均退出 0，双图哈希匹配。Task 和 Execute 写入持久 `error` 后，同一会话正常续答。当前工作树实际六路径哈希与送审一致，五个代码及测试文件仍与批准输入逐字相同。

## Primary-path and fallback verdict

SessionPrompt 持有共享清理，公开取消仍接收单个会话 ID，Task 传递真实作业身份。原 Guard、依赖、测试夹具和 gitlink 均未改变，无备用成功路径。

## Code quality verdict

代码与测试实际 `+212/-44`，`E=176`、`C=27`，达到门槛；`git diff --check` 通过。

## Release verdict

**APPROVE**，仅限 R15 实现差分，六路径 SHA-256 `3fa66e6ad2d0fc4ad9b634462c9f06df5c17f2913a6028fb8bbe63194996948e`。可以形成单个本地提交；可合并结论仍取决于最终提交的原门禁。

</details>

<details>
<summary>R15 首轮独立实现审计原文</summary>

## Blocking findings

### B-09 R15 缺少当前候选的必需实施验收证据

- Violated invariant: 批准方案 §18 及现行 Workflow 要求当前差分完成实施验证后才标记 `verified`。
- Evidence class: contracted、observed。
- Source evidence: `docs/guides/workflow.md` 阶段 3–4；`docs/plans/execute-task-cancellation.md:327–340,689–702`。
- Responsibility owner: 实施验收。
- Concrete behavioral consequence: 当前候选只完成真实红绿、原 Debug 和 Stop；Stop 将全量检查递延。扩展五文件、原夹具、四契约、包级类型、构建与真实终端仍缺本候选回执。旧基线的回执无法证明当前候选已完成这些步骤。
- Round basis: 当前实施首审的必需验收。
- Minimal correction direction: 对同一五路径源码补齐这些实施证明，再送独审；无需据此改源码。提交后的精确 SHA Push、预检与官方基准仍各自作为交付门禁。

## Non-blocking findings

当前重放的四个取消入口通过 29 条断言，原 Debug 通过 2 条。原前像仍在同输入下复现具名 timeout，符合红绿口径。

## Follow-up

保持最新 Gate 原样。实现验收补齐后，用单提交最终 SHA 单独记录推送门禁、正式预检、基准和恢复回执；保持不合并的要求。

## Rejected speculation

新版基准已改变过去超限的默认正文，仍以真实运行判定结果。Stop 的退出 0 不计为已递延全量通过。

## Requirement and traceability coverage

独立核对实际六路径 SHA 与送审一致，五路径代码和测试 SHA `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd` 与 R15 批准输入逐字一致。Gate、原夹具、依赖和 gitlink 不在差分内。

## Primary-path and fallback verdict

共享取消清理由 SessionPrompt 持有；公开取消仍只接收会话 ID，Task 只传实际作业身份。未新增备用成功路径。

## Code quality verdict

实际差分与已审路径一致，`git diff --check` 通过。R15 记录 `E=176、C=27`，达到用户门槛。当前阻断为验收证据，未发现需要改代码的阻断。

## Release verdict

**BLOCK**，仅限已送审的 R15 实施快照，六路径 SHA-256 `6066c8321571837b2225f756bb09fcef1e974eaa5d6f2182248a92da2a3989a5`。

</details>

<details>
<summary>R10 独立实现审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

实施证据中的 stop Gate 只证明工作树规则与静态选测通过。保留这一范围说明；正式 push Gate 和 preflight 按提交后的流程记账。

## Follow-up

原样记录裁决后创建单提交。随后执行该提交的正式 push Gate、preflight 和空目录恢复校验。以上是发布门禁，本轮不将其记为已通过。

## Rejected speculation

真实终端截图中的环境 socket 提示未中断验收。原始回执确认子模型断流、Task 和 Execute 写入持久终态、同会话正常续答，以及应用、daemon、模型服务正常退出。

## Requirement and traceability coverage

从固定缺陷基线 `f04f9307` 与当前发布基线 `0dfffcda` 复核完整范围。实际代码与测试差分和送审补丁逐字一致，SHA-256 为 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`。五个目标 blob 均匹配 R10；生产四文件 `+49/-42`，测试一文件 `+163/-2`，另有 canonical Plan，Gate 与依赖保持原样。

已核对原始日志、退出码、编译物身份和两张真实终端截图。同输入 timeout 红→绿；四取消入口 4 pass、29 断言，Debug 1 pass、2 断言；原五文件回归 317 pass、1 个既有 skip、0 fail。包类型检查、stop Gate 与保留 WebUI 的完整原生构建均退出 0。

## Primary-path and fallback verdict

共享取消由同一 owner 收尾并发布完整结果。内部 finalizer 不等待自己的 flight，外部等待仍可中断；正在关闭的作业以实际登记 ID 排除。Debug 复用同一 TaskOps，公开 cancel 保持一元接口。未新增备用成功路径。

## Code quality verdict

实际 E=176、有效 C=27，达到门槛 27。复算排除了缩进迁移、注释、导入和空行；测试中两条缺少独立语义的说明不计入 C。`git diff --check` 通过。

## Release verdict

**APPROVE**

批准 **R10 的精确实施差分**。可原样记录裁决、标记 `verified`，再按当前 Workflow 进入单提交和发布验收。

</details>

### R11 独立实现审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

审计副本的 Git index 引用了缺失的旧 Plan blob，普通 `git diff --cached` 无法读取。工作树相对 HEAD 的完整差分能重算，且与送审 SHA-256 逐字匹配。正式单提交请从干净的 `0dfffcda` checkout 重放已审核差分，再核对暂存区及提交树。

## Follow-up

原 Stop Gate 退出 0，按原规则把 OpenCode 全量测试交给发布预检。正式候选单提交对应的原 push Gate、preflight、远端 CI 和最终恢复包回放仍是发布门禁。保留这些检查的实际退出码和候选 SHA。

## Rejected speculation

没有把历史全量失败归给单个 Logger，也没有据此扩大测试钩子清理范围。用户现场首次触发中断的来源仍未确认；固定基线的真实 Execute→Task 回放已独立复现并验证了中断后的等待环。

## Requirement and traceability coverage

已核对批准快照 `0568ca16d1d8735fa9937b71cb68480f1c55f2dbcfd65bec437a2227095341c7`。当前 Plan 的变化仅为阶段状态与实施证据。固定 `f04f9307` 和发布基线 `0dfffcda` 的六个源码及测试前像逐一相同，实际七路径完整差分与送审补丁一致。

原超时回放从红转绿。R11 原 stock 组合由 2 通过、3 失败转为 5 通过、0 失败，两侧均有 36 条断言。原文件修改组 10 例、41 条断言全部通过；原五文件回归 317 通过、1 项既有跳过、0 失败，包级类型检查退出 0。检查了本轮编译物的两张真实终端截图和运行回执：子模型连接断开后，Task 与外层 Execute 分别在 10 毫秒和 19 毫秒写入错误终态，同一会话继续收到回复，应用和 daemon 均退出 0。

## Primary-path and fallback verdict

内部取消沿同一真实作业 ID，外部公开入口仍为一元并共享完整 `Exit`；首发请求中断后，清理仍归同一个 flight。文件修改测试只移除调用另一套全局 Store 的钩子，十例各自的局部 Store 清理和原断言保持。新增备用成功路径为零；Gate、超时和产品配置均保持不变。

## Code quality verdict

生产四文件 `+49/-42`，测试两文件 `+165/-9`，另有一份 canonical Plan。实际 `E=179`、`C=27`，门槛为 27。代表性注释紧贴取消自等、首发断连后的共享结算、公开参数边界与作用域释放顺序。`git diff --check` 通过。

## Release verdict

**APPROVE**

批准精确 **R11 实现差分**，SHA-256 `6f4ab93ce7f1bc4965db831bc506836b7eaae62e7f95a4c21591b431f0f2eec5`，其中六路径代码与测试差分 SHA-256 `905723c7e5b7ecacc4dc239a2f9817cbd7c6ed27ee24539821adce0b467a4b36`。可按已批准流程形成单提交并执行正式发布门禁；本裁决放行实施审计阶段。

### R12 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的最终 blob 核对清单沿用 R11 的「四生产和两测试」。R12 应核对 §15 列出的四个生产文件、三个测试文件及唯一 Plan，包含 Writer 精确目标 blob `a53c9046c9cce689ada0425a5ba3ccc9ad8184c8`。

## Follow-up

正式 Push Gate 仍未通过。历史候选 `804aa1d6` 原全量 4,799 通过、45 跳过、642 失败，退出 1，未进入预检。最终候选须按 §20 通过原完整 Gate、正式预检与远端必过检查。Read 的独立结果留作调查证据；本次只按已批准路径实施，不另开计时器 PR。

## Rejected speculation

真实 Writer 取证只确认局部 60 秒等待已清理，以及旧钩子随后启动的独立 Logger 和 Truncate。其余计时器及全量失败保留各自的归因状态。两个契约的 `EROFS` 已证实发生在 bundler 启动前；私有写目录只恢复原测试所需的 `mkdtemp`，不改变原断言。

## Requirement and traceability coverage

R12 保留固定 `f04f9307` 和当前发布基线 `0dfffcda` 到同一个完整目标的对照。原 Execute 取消修复、公开一元入口、内部真实作业 ID、四路取消验证和 Debug 回归均保留。新增范围只涉及 Writer 原清理入口，保留五组共 28 例与全部业务断言。

原始回执确认 Writer 全文件由 25 通过、3 失败转为 28 通过、0 失败，两侧均为 90 条断言；Writer 首例与四个 Execute 入口同进程由 2 通过、3 失败转为 5 通过、0 失败，两侧均为 36 条断言。独立重算的 Writer 目标 blob 与方案一致。两个私有测试目录上的原四项契约均实际通过，原静态选测仍要求全量 OpenCode。实际 E/C 须按最终差分复算。

## Primary-path and fallback verdict

Writer 继续由各用例的现有作用域释放实际 Store 和服务，只移除误调用另一进程 Store 的文件级钩子。原产品取消路径、Gate、预算和断言保持。没有新增备用成功路径或生产诊断分支。

## Release verdict

**APPROVE**

批准精确 **R12 方案**，SHA-256 `af4d8ff895381af7d8287f482dae5a2a1c7ba02adc01c6905d29b4309a12d1c9`。原样记录裁决后可实施；实际完整差分须通过独立实现审计，最终发布仍受 §20 的全部原门禁约束。

### R14 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§20 的 `137800` 是按 benchmark 默认输入推导的模拟响应字符数；`65536` 才是处理器上限。官方日志直接记录的是基线 seed 阶段报 `MessageOutputLengthError`、退出 2。建议把源码推导和原日志分别标注。此处不影响发布门禁。

## Follow-up

正式候选仍须完成独立实现审计、完整构建与实机终端、最新原 Gate、适用的同 SHA 预检与远端必过检查、空目录恢复。当前 runtime PR 的 `guard-required` 确实要求 benchmark 成功；基线 seed 已实测失败，发布继续受这条门禁约束。#5 的试验分支授权不覆盖 #8。

## Rejected speculation

新版 Guard 的原始窄验证支持保留两个原夹具及断言。它只覆盖本轮实测入口，不给整仓或 benchmark 判绿。

## Requirement and traceability coverage

R13 B-01 已解除。核对了 R14 逐节直写的稿件与送审字节，现行映射统一使用固定 `f04f9307`、发布基线 `0b5754df` 和同一完整终态。五路径代码及测试补丁 SHA-256 为 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`，另有唯一 Plan。原始回执确认两个夹具 A/B 各 38 例、93 条断言通过；终态五路径配原夹具，四个 Execute 入口 4 例、29 条断言通过。保留原始同输入红、公开一元取消、独立 Debug、单提交和用户决定合并。

## Primary-path and fallback verdict

共同清理由原 SessionPrompt flight 持有；作业退出只传自己的实际 ID，外部等待者仍消费完整 `Exit`。两个旧夹具恢复最新基线原字节；Gate、预算和断言保持，新增备用成功路径为零。

## Release verdict

**APPROVE**

批准精确 **R14 方案**，SHA-256 `1fb9188f6625464674a8e113610ff730a03a5985be6dee0dc9ce8e473a83a862`。原样记录裁决后可按六路径实施；实际差分及正式验收仍须独立审计。

### R14 独立实现审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的五文件回归命令未指定额外 preload；本轮实际用了最新版原 Guard preload。同五个测试文件执行了 318 例，保留唯一既有跳过，317 通过、0 失败、1,854 条断言，并通过新增的整轮资源检查。按实际命令记录，不把旧 R12 的裸命令回执计入本轮。

## Follow-up

可形成本地单提交。原 Stop Gate 退出 0，并将 OpenCode 全量递延给正式预检。最终提交的原 Push Gate、适用预检、远端必过检查及完整恢复回放仍待执行。当前基线 benchmark 在 seed 阶段失败，`guard-required` 的发布条件仍未满足；本裁决不授权推送 #8。

## Rejected speculation

保留两个原夹具的结论来自新版 Guard 的同输入 A/B 和本轮 38 例复验。原 benchmark 失败与本轮 Execute 取消逻辑分别记账，不修改 Gate 或降级检查。

## Requirement and traceability coverage

已核对批准快照、实际工作树与固定 `f04f9307`、发布基线 `0b5754df` 的完整六路径。两个原夹具与当前 HEAD 逐字相同，Gate、hook、工作流及 gitlink 保持不变。

固定 f04 的同输入 timeout 真实红；本轮四个取消入口 4 通过、29 条断言，原夹具 38 通过、93 条断言，Debug 原生 Read 两条断言、包级类型检查及四个原契约均通过。已检查同一编译物的实际终端截图和运行回执：断线后 Task 与 Execute 分别在 22 毫秒、36 毫秒写入错误终态，同一会话随后正常续答；应用、daemon 与本地模型替身退出 0。

## Primary-path and fallback verdict

SessionPrompt 的共享 flight 持有清理。内部作业只传自身实际 ID，公开取消仍是一元入口，外部等待者接收同一个完整 `Exit`。未增加替代成功路径或放宽超时、测试及权限。

## Code quality verdict

生产四文件 `+49/-42`，Execute 测试 `+163/-2`，另有唯一 canonical Plan。实际 `E=176`、`C=27`，达到门槛 27；有效中文注释说明作业自等、共享清理责任和作用域释放次序。`git diff --check` 通过。

## Release verdict

**APPROVE**

批准精确 **R14 实现差分**，完整六路径 SHA-256 `bb3de76cef186e1a952d2a847c275afde9dc04c54ef40ce99f4272b9ee19642e`，五路径代码和测试 SHA-256 `5f33a60c190a78a57e4701a61505f41a4056e8e610b61dc3a69c52bb293fd2bd`。可按原流程形成本地单提交；可合并质量由最终提交的全部原门禁结果决定。
