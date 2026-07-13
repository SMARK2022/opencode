# [已否决] Agent Loop 可靠完成提示音第一轮设计草案

> 本草案在第一轮独立审计中因新增 `SessionSettlement` module、扩大生命周期改造面和默认策略不够克制而未获放行，不得作为实施依据。
>
> 当前唯一放行候选见 `docs/proposal/tui-agent-loop-sound-surgical-plan.md`。保留本文件只用于记录被拒绝的设计路径和审计演进。

> 状态：方案稿，仅用于后续评审与 TDD 实施。本文不代表生产代码已经修改，也不建议在完成语义修正前直接打开默认开关。
>
> 日期：2026-07-13
>
> 范围：当前 `dev-smark` 上的 Session Run state、Agent loop、Goal、Compaction、Task/BackgroundJob、事件系统、主 TUI、Web App、Electron Desktop、`opencode run`、ACP，以及 `@opentui/core@0.3.4` 音频链路。
>
> 约束：声音由本地交互客户端播放；Server/Core 不打开音频设备；不通过 `afplay`、`paplay`、PowerShell 或终端 BEL 作为默认实现；完成提示失败不得改变 Session 结果；本轮只调研并产出文档，不实施功能。

## 1. 推荐结论

这个需求可以实现，而且当前仓库已经具备大部分播放能力：

1. 主 TUI 已有 `createTuiAttention()`、语义 sound pack、内置 MP3、音量控制和 `@opentui/core` native Audio wrapper。
2. 在没有显式调用 `selectPlaybackDevice()` 时，OpenTUI/miniaudio 会在首次 `start()` 时使用操作系统默认播放设备。
3. Web App 和 Electron Desktop 已经默认在收到 Session idle 后通过浏览器 `Audio` 播放完成声。
4. 当前真正缺失的不是“怎么播声音”，而是“什么时候能够可靠地断言整个 Agent loop 已经结束”。

不建议把下面这行作为最终实现：

```ts
enabled: acc.result.attention?.enabled ?? true
```

它确实会让 TUI 开始响，但只是打开现有基于 `busy/retry -> idle` 推断的通知。当前 `idle` 还可能表示：

- `SessionProcessor` 的一次请求失败，而外层 Goal 随后继续；
- manual Compaction 或 direct shell 结束，而不是 Agent 任务结束；
- parent Session 暂时空闲，但 BackgroundJob 仍在运行并会稍后注入结果、重启 parent loop；
- 用户取消后 Runner 已切到 idle，但 Tool/Message 终态清理还未完成；
- 当前 Runner 结束，但一个晚到的排队 Message 尚未被消费；
- child Session 完成，而 root Session 的用户任务尚未完成。

推荐先建立一个深的 `SessionSettlement` module，在 Run state 之上集中判断一个 generation 是否真正 settled；再发布一次性的语义事件，由 TUI/Web/Desktop 的本地 adapter 决定是否播放。

推荐事件形状：

```ts
type SessionRunSettled = {
  type: "session.next.run.settled"
  data: {
    timestamp: DateTime.Utc
    sessionID: Session.ID
    generationID: string
    requestIDs: readonly string[]
    rootRequestID: string
    parentSessionID?: Session.ID
    finalMessageID?: string
    kind: "agent" | "shell" | "maintenance"
    outcome: "completed" | "failed" | "aborted" | "paused" | "blocked"
  }
}
```

默认声音策略应是：

| 条件 | 默认行为 |
| --- | --- |
| root Session、`kind=agent`、`outcome=completed` | 播放一次柔和完成声 |
| child/subagent Session 完成 | 默认不播放最终完成声 |
| `failed` | 不播放成功声；错误提示保持独立策略 |
| `aborted` | 默认静音，避免把用户取消误报为任务完成 |
| `paused` / `blocked` | 不播放成功声；可由独立 attention 策略提示 |
| direct shell / manual Compaction | 默认不播放 Agent 完成声 |
| 仍有关联 BackgroundJob、result injection 或 Goal continuation | 尚未 settled，不播放 |
| 同一 generation 的重复传输 | 按 `generationID` 去重，只尝试播放一次 |

播放侧继续使用现有 native OpenTUI Audio。不要把声音放进 `SessionProcessor`、`SessionStatus.set()`、HTTP handler 或 Server daemon。

## 2. 需求边界

### 2.1 用户目标

用户启动一个较长的 Agent 任务后，即使暂时切到其他窗口，也能在整个任务真正完成时听到一次短、柔和、不过度打扰的提示音。

### 2.2 必须满足

1. 一个完整 generation 最多播放一次。
2. 多个 LLM step、Tool 调用、retry、自动 Compaction 和 Goal continuation 不得各自播放。
3. 错误或取消不得播放“成功完成”声音。
4. 默认只面向 root Session；subagent 完成不能让用户误以为主任务已完成。
5. 声音走运行 TUI/App 的本机默认输出链路，而不是 Server 所在机器。
6. 音频设备、解码、权限或浏览器 autoplay 失败必须静默降级，不得影响 Session。
7. 用户必须能明确关闭。
8. 不依赖外部播放器命令或某个桌面环境已安装的音频工具。
9. 非交互、CI、管道、ACP 和 server-only 模式默认不产生声音。

### 2.3 不在首版范围

1. 不做完整音频设备选择 UI。
2. 不在 Server 侧枚举客户端音频设备。
3. 不保证 SSH 远端进程能在本地 terminal emulator 发声。
4. 不把提示音作为任务完成的协议确认；它只是本地 presentation。
5. 不为每个 Agent、Provider 或 Project 建立不同默认音效。
6. 不让声音播放成功与否反向影响 `completed`、`failed` 或 `aborted` 结果。

## 3. 术语

本文沿用 `CONTEXT.md` 的领域语言。

| 术语 | 本文定义 |
| --- | --- |
| Session | Project 内由 Agent 驱动、持久化 Message 的执行容器 |
| Status | `idle`、`retry`、`busy` 的总线标签；只表达高层忙闲，不表达任务成功 |
| Run state | `cancel`、`ensureRunning`、`startShell` 等 in-flight Runner 控制面 |
| Runner generation | 从一个 Session 的 Run state 接受一批关联工作，到这批工作不可再自动产生下一轮 loop 为止的唯一执行代次 |
| Settlement | generation 已不可再产生关联的 Agent loop、Goal continuation、前台 child、BackgroundJob result injection 或取消清理 |
| Root request | 打开 generation 的真实外部用户 Message；不包括 Goal、Compaction 或 background result 生成的 synthetic Message |
| Owned work | 能继续或重启同一 generation 的工作，例如 Goal continuation、foreground child、BackgroundJob、result injection |
| Local adapter | TUI、浏览器或 Electron 中把 settlement 映射为声音、OS notification、badge 或静音的实现 |

Status 和 Run state 已经在仓库领域模型中被明确区分。Settlement 是第三个概念，不能继续复用 `idle` 的名字或语义。

## 4. 调研范围与方法

### 4.1 生产代码

| 区域 | 关键文件 | 调研目的 |
| --- | --- | --- |
| Runner | `packages/opencode/src/effect/runner.ts` | Idle/Running/Shell/ShellThenRun、handoff、cancel 与 onIdle 顺序 |
| Run state | `packages/opencode/src/session/run-state.ts` | per-Session Runner、Status 写入、BackgroundJob cancel |
| Agent loop | `packages/opencode/src/session/prompt.ts` | Message admission、Goal、Compaction、Tool、shell、loop exit |
| Processor | `packages/opencode/src/session/processor.ts` | retry、error、abort、cleanup 和提前 idle |
| Status | `packages/opencode/src/session/status.ts` | `session.status` 与 deprecated `session.idle` 发布顺序 |
| Background | `packages/opencode/src/background/job.ts` | BackgroundJob 状态、fiber 与 cancel |
| Task Tool | `packages/opencode/src/tool/task.ts` | foreground/background subagent、result injection、parent resume |
| Request usage | `packages/opencode/src/session/request-usage.ts` | `requestID`、`rootRequestID` 与持久化结果 |
| EventV2 | `packages/core/src/event.ts`、`session-event.ts` | 当前 versioned event interface 与缺失的 run settlement |
| Event bridge | `packages/opencode/src/event-v2-bridge.ts`、`sync/index.ts` | EventV2 到现有 Bus/SDK 的迁移 seam |
| TUI notifications | `packages/opencode/src/cli/cmd/tui/feature-plugins/system/notifications.ts` | 当前 busy-to-idle 推断、error suppression、subagent 策略 |
| TUI attention | `packages/opencode/src/cli/cmd/tui/attention.ts` | focus、sound pack、volume、fallback 和配置总开关 |
| TUI audio | `packages/opencode/src/cli/cmd/tui/util/audio.ts` | native Audio 创建、加载、播放、缓存与销毁 |
| App notifications | `packages/app/src/context/notification.tsx` | Web/Desktop idle、error、parent filtering 和持久通知 |
| Browser audio | `packages/app/src/utils/sound.ts` | AAC lazy import、`Audio.play()` 和失败降级 |
| Desktop | `packages/desktop/src/renderer/index.tsx`、`main/ipc.ts` | renderer audio 与 OS notification 所有权 |
| Run/ACP | `packages/opencode/src/cli/cmd/run.ts`、`src/acp/agent.ts` | 非 TUI surface 是否应发声 |
| Build | `packages/opencode/script/build.ts` | OpenTUI native package 与静态 asset 打包 |

### 4.2 测试与规格

| 文件 | 已覆盖内容 |
| --- | --- |
| `packages/opencode/test/effect/runner.test.ts` | Runner handoff、cancel、idle/finalizer 顺序 |
| `packages/opencode/test/session/prompt.test.ts` | Agent loop、Compaction handoff、subagent cancel |
| `packages/opencode/test/cli/cmd/tui/attention.test.ts` | focus、音量、sound pack、fallback、dispose |
| `packages/opencode/test/cli/cmd/tui/notifications.test.ts` | question、Permission、busy/idle、error、subagent sounds |
| `packages/opencode/test/config/tui.test.ts` | attention 默认值和路径解析 |
| `packages/opencode/specs/tui-plugins.md` | attention plugin interface 与当前默认关闭事实 |
| `packages/opencode/specs/v2/notifications.md` | v2 计划把 `attention.enabled` 默认改为 true |

### 4.3 无声运行时探针

本轮没有实际播放声音，只执行了不会连接输出设备的 native mixer 分析，以及设备枚举：

1. `Audio.create({ autoStart: false })` 成功。
2. `listPlaybackDevices()` 在当前 macOS 环境发现 2 个设备，其中恰好 1 个标记为 default。
3. `startMixer()` 用 headless mixer 解码并混合内置 MP3，没有调用 `start()`，所以不会向设备输出。
4. `/usr/bin/afinfo` 只读取时长和编码元数据。

这些探针证明当前 native library、MP3 decoder 和默认设备枚举可用，但不替代人工听感测试。

## 5. 当前完整数据流

### 5.1 Agent 执行

```text
HTTP/TUI/App prompt
  -> SessionPrompt.prompt()
  -> createUserMessage()
  -> SessionRunState.ensureRunning()
  -> Runner
  -> SessionPrompt.runLoop()
  -> SessionProcessor.process()
  -> LLM steps / Tools / retries / Compaction / Goal continuation
  -> Runner finishes
  -> SessionRunState.onIdle
  -> SessionStatus.set(idle)
  -> session.status(idle)
  -> session.idle (deprecated)
```

### 5.2 TUI 当前通知

```text
session.status(busy|retry)
  -> internal:notifications active.add(sessionID)

session.error
  -> errored.add(sessionID)
  -> attention.notify(error)

session.status(idle)
  -> if active and not errored
  -> attention.notify(done|subagent_done)
  -> TuiAudio.loadSoundFile()
  -> Audio.start()
  -> OS default playback device
```

### 5.3 App/Desktop 当前通知

```text
session.idle
  -> lookup Session
  -> ignore parentID sessions
  -> playSoundById(settings.sounds.agent())
  -> new browser Audio(assetUrl).play()
  -> optional platform.notify()
```

TUI 和 App 已经各自实现了一台浅的“完成推断状态机”，而且语义不同。应删除重复推断，把 settlement 复杂性收敛到一个 module。

## 6. Run state 与 Agent loop 审计

### 6.1 Runner 状态机

`Runner` 定义四个状态，见 `packages/opencode/src/effect/runner.ts:38-42`：

```text
Idle
Running
Shell
ShellThenRun
```

关键行为：

1. `ensureRunning()` 在 `Running` 或 `ShellThenRun` 中只 join 当前 Deferred，不启动调用者传入的新 work，见 `runner.ts:120-143`。
2. `ensureRunning()` 在 `Shell` 中登记一个 pending run，进入 `ShellThenRun`。
3. shell 完成时若存在 pending run，会直接进入 `Running`，不经过中间 idle，见 `runner.ts:98-111`。
4. direct shell 和 manual Compaction 因而能把排队 prompt handoff 给 Agent loop，这部分设计是正确的。
5. `finishRun()` 先把状态提交为 `Idle`，再执行外部 idle effect，见 `runner.ts:75-86`。

最后一点留下窄竞态：replacement `ensureRunning()` 可能在旧 `onIdle` effect 执行前观察到 Idle 并启动新 work；旧 callback 随后仍可能删除 runner map entry、发布 idle。提案不能把当前 onIdle 直接升级为强语义事件，必须让 callback generation-aware，并在同一个同步转换中验证“仍是当前 generation 且仍为空闲”。

### 6.2 Status 的全部写入源

| Status | 写入位置 | 语义 |
| --- | --- | --- |
| `busy` | `session/prompt.ts:2228-2230` | 每个 runLoop iteration 开始 |
| `busy` | `session/processor.ts:340-344` | Provider stream start |
| `busy` | `session/run-state.ts:83` | shell/maintenance Runner 进入 busy |
| `retry` | `session/processor.ts:1066-1094` | retry schedule 等待下一次请求 |
| `idle` | `session/run-state.ts:78-82` | Runner onIdle |
| `idle` | `session/run-state.ts:121-130` | cancel 时没有 busy Runner 也强制 idle |
| `idle` | `session/processor.ts:991-1018` | 非 overflow terminal processor error/abort |

Status 写入没有去重。一次普通请求可以发布多次 `busy`；一次取消可以由 Runner 和 Processor 发布多次 `idle`。

`SessionStatus.set()` 还会先 publish、后更新/删除 map，见 `session/status.ts:77-86`。事件 subscriber 在回调中立即 `get()` 时可能读到旧值。

### 6.3 正常 completion

runLoop 只有在最新 Assistant：

1. 有 finish；
2. 没有 error；
3. 不是 `tool-calls`；
4. 没有待回传 Tool calls；
5. `parentID` 确实对应最新 User Message；

时才进入 normal completion，见 `session/prompt.ts:2253-2277`。

随后还会检查 Goal continuation。只有 continuation 不再发生、Goal limit 处理完成，才在 `prompt.ts:2345-2347` break。runLoop 返回前还会 fork detached Compaction prune，见 `prompt.ts:2728-2729`。

因此 runLoop 自身的 final return 比单次 Assistant finish 更接近 Agent loop 终点，但它仍没有覆盖 late admission、BackgroundJob 和 cancellation cleanup。

### 6.4 排队 Message 与 late admission

prompt 会先持久化 User Message，再调用 `ensureRunning()`，见 `prompt.ts:2070-2106`。当 Runner 已经 Running 时，新调用只 join 旧 work；真正的新 Message 依赖正在运行的 loop 在下一 iteration 重新读取 history 才能被消费。

正常情况下，runLoop 每轮读取最新 history，并会在后续 iteration 看到排队 Message。风险窗口位于最后一次 history snapshot 与 Runner 进入 Idle 之间：

```text
runLoop reads latest Message
  -> decides latest Assistant answered latest User
  -> a new User Message is persisted
  -> ensureRunning sees Running and joins old Deferred
  -> old runLoop breaks
  -> Runner publishes idle
```

此时新 Message 可能仍未回答，但客户端已经收到 idle。可靠 settlement 需要把 Message admission 与 generation closure 放在同一个线性化点，或者让 Running Runner 记录 `rerunRequested`，在 closure 前重新验证 Message watermark。

### 6.5 Goal continuation

Goal continuation 位于 `prompt.ts:2277-2344`：

1. root Session 才能继续；
2. Goal 必须 active；
3. 不能是 decide Agent；
4. 受 `goal_max_turns` 和 Agent steps 限制；
5. terminal error 只有 `continueOnError=true` 才能继续；
6. continuation 通过 synthetic `noReply` Message 注入后直接进入下一 iteration。

Processor terminal error 会先发布 `session.error` 并写 idle，随后 runLoop 仍可能把它分类为 eligible terminal error、进入 Goal continuation：

```text
session.error
session.status(idle)      <- 不是最终结束
session.status(busy)
... Goal continuation ...
session.status(idle)      <- 可能才是最终结束
```

这是一条直接证明“第一个 idle 不能触发完成声”的路径。

### 6.6 Compaction

自动 Compaction 在同一个 runLoop 中执行并继续，不是完成边界：

- preflight overflow：`prompt.ts:2575-2593`；
- Provider overflow：`prompt.ts:2698-2710`；
- continuation Message：`compaction.ts:1078-1158`。

manual Compaction 使用 `startExclusive()` 和 Runner Shell ownership，见 `prompt.ts:2145-2163`。没有排队 prompt 时，它会产生 busy -> idle；当前 TUI 会把这个 idle 当成 “Session done”，即使根本没有新的 Agent 任务完成。

Compaction 的 summary Processor 发生 terminal error 时也可能提前写 idle，而外层 maintenance Runner 尚未 settle。

### 6.7 Retry、error 与 abort

retry 只表示 Provider 请求将在之后重试，不是失败或完成。TUI 把 retry 加入 active 集合是合理的，但不能用 retry 后第一个 idle 直接判断结果。

`session.error` 也不是 terminal settlement：

| Error 来源 | 是否一定 terminal |
| --- | --- |
| context overflow | 否，通常进入 Compaction |
| 文件/目录读取失败并转成 synthetic context | 否，Agent 继续 |
| Provider terminal error | 可能被 Goal `continueOnError` 继续 |
| async route 包装后的 generic error | 可能与更具体 error 重复 |
| user abort | 是终止意图，但 idle 可能早于 cleanup |
| Agent/model 配置错误 | 通常 terminal，但可能在 Runner busy 之前发生 |

Runner cancel 会先切 Idle、执行 idle callback，再 interrupt worker；测试明确覆盖 idle 可能早于 interrupted-run finalizer。`SessionPrompt.cancel()` 随后才 terminalize Assistant、Tool Part、RequestUsage 和 dangling child Assistant，见 `prompt.ts:400-511`。

因此取消的 settlement 必须以 cancel orchestration 完成作为边界，而不是第一个 idle。

### 6.8 direct shell 与 maintenance

direct shell 通过 Run state 的 Shell 路径运行，拥有 busy/idle 和完整 Message/Tool terminal state，见 `prompt.ts:1304-1493`。它可以 handoff 给排队 Agent loop，但单独 shell 完成不等于用户请求的 Agent loop 完成。

slash command 的 shell substitution 在进入 `prompt()` 前执行，见 `prompt.ts:2783-2794`，期间甚至可能保持 Status idle。

Revert/unrevert 使用独立 ownership，不写 Status。说明 Status 从来不是所有 Session 工作的统一生命周期。

### 6.9 foreground subagent

foreground Task 创建或恢复 parentID child Session，并等待 child prompt 结果。parent Tool 仍处于 running，所以 parent Runner 通常在 child 返回后才继续并最终 idle。

child 和 parent 会分别发布 Status。当前 TUI 对 child 禁止 OS notification，但仍播放 `subagent_done` 声音，见 `notifications.ts:9-17`、`76-78`。这容易让用户把 child 完成误认为整个任务完成。

推荐语义事件仍可为 child generation 发布，但默认 completion adapter 只处理 `parentSessionID` 为空的 root Session。

### 6.10 BackgroundJob

background Task 在 `tool/task.ts:427-451` 启动 `BackgroundJob` 后立即向 parent Agent 返回。child 在独立 fiber 中继续执行。

完成后流程为：

```text
child runTask finishes
  -> inject synthetic noReply Message into parent
  -> poll parent Status until idle
  -> show toast
  -> fork parent loop again
```

对应代码位于 `tool/task.ts:363-418`。

因此 parent 可以出现：

```text
parent busy
parent idle                  <- BackgroundJob 仍在运行，不应播放最终完成声
background child finishes
parent synthetic Message injected
parent busy
parent idle                  <- result 已消费，才可能 settle
```

BackgroundJob terminal state本身也不够，因为 job 完成后仍有 result injection 和 resumed parent loop。Settlement ownership 必须覆盖完整 handoff，而不是只覆盖 child fiber。

### 6.11 detached work

title generation、Session summary/diff 和 Compaction prune 会 detached fork，可能在 Runner idle 后继续更新元数据：

- title：`prompt.ts:2349-2356`；
- summary：`prompt.ts:2440-2441`；
- prune：`prompt.ts:2728`。

这些工作通常不应阻止完成声，因为它们不会再生成用户可见的 Agent response。Settlement 需要追踪“能继续 Agent loop 的 owned work”，而不是等待所有 detached fiber 归零。

## 7. 为什么当前 idle 不是可靠完成事件

| 场景 | 当前可见事件 | 直接用 idle 的结果 |
| --- | --- | --- |
| 普通多 step Agent | 多次 busy，最后 idle | 通常正确，但缺少 generation ID |
| retry 后成功 | busy -> retry -> busy -> idle | 通常正确 |
| terminal error + Goal continuation | error -> idle -> busy -> idle | 第一个 idle 误报 |
| automatic Compaction | busy/error/compaction/busy/idle | 中间信号可能误报 |
| manual Compaction，无 prompt | busy -> idle | 把 maintenance 误报为 Agent 完成 |
| direct shell，无 Agent | busy -> idle | 把 shell 误报为 Agent 完成 |
| late queued Message | busy -> idle，但 Message 未消费 | 提前完成 |
| foreground child | child idle，parent 仍 busy | child sound 误导 |
| background child | parent idle，稍后 parent 再 busy | 多次“完成” |
| user abort | error/idle/idle，cleanup 尚在进行 | 提前或重复 |
| reconnect/late attach | 可能只看到 idle snapshot | 无法知道是否刚完成 |

结论：

```text
Status idle = 当前观察到没有 active status entry
Status idle != Agent loop generation settled
```

## 8. 各客户端当前行为

### 8.1 主 TUI

当前 `internal:notifications`：

1. 看到 busy/retry 后把 Session 放入 `active`。
2. 看到 error 后播放 error attention，并放入 `errored`。
3. 看到 idle 时只有 active Session 才通知。
4. error 后紧邻的 idle 会被 suppression。
5. parent Session 用 `done`，child Session 用 `subagent_done`。
6. sound 固定 `when: "always"`；OS notification 固定 blurred-only。

优点：

- 能抑制初始/no-op idle；
- 能抑制同一 active 周期的重复 idle；
- error 后不会再播 done；
- question 和 Permission 有 request ID 级去重。

缺口：

- active 集合不是 generation identity；
- reconnect snapshot 不会 seed active；
- late attach 到 busy Session 后可能错过最终提醒；
- repeated `session.error` 没有 error-event 去重；
- child completion 默认仍发声；
- manual Compaction 和 direct shell 也进入同一 done 逻辑；
- attention 总开关默认 false，所以默认完全不响。

### 8.2 Web App

`packages/app/src/context/notification.tsx:229-299` 直接监听 deprecated `session.idle` 与 `session.error`。

特点：

1. 不要求先看到 busy；每个 delivered idle 都可能播放。
2. 完全忽略 parentID child Session。
3. completion sound 默认开启，默认 asset 为 `staplebops-01`。
4. error sound 默认开启。
5. OS completion notification 默认开启，focused/visible tab 会由 platform adapter 抑制。
6. completion/error notification 会持久化到本地列表。

缺口：

- error 后 core 通常还会发 idle，因此可能先播 error、再播 completion；
- 没有 event/generation 去重；
- async Session lookup 可能改变 error 和 idle 的最终处理顺序；
- reconnect 不 replay，missed idle 不会恢复；
- live notification listener 可能在 persisted settings ready 前使用默认值；
- 每次播放创建新的 browser `Audio`，多个声音可以重叠。

### 8.3 Electron Desktop

Desktop 复用 App notification context 和 browser `Audio`，所以 completion 语义与 Web 相同。声音运行在 Electron renderer，不在 main process，也不在 sidecar/server。

Desktop 的 `Platform.notify` 会先查询 BrowserWindow focus，未聚焦时由 renderer 创建 Chromium Notification。preload/main 中另有 Electron main-process Notification IPC，但当前 completion 路径没有使用它。

### 8.4 `opencode run`

`opencode run` 没有音频或 OS notification。非交互模式订阅事件、输出结果，并在目标 Session idle 时退出。

保持默认静音是正确的，因为它常用于：

- shell pipeline；
- CI；
- cron；
- automation；
- 非 TTY 输出。

不过 settlement 事件可以替代当前 idle/polling 退出判定，提高协议正确性；这不意味着 `run` 应播放声音。

### 8.5 ACP

ACP relay Message、Tool 和 Permission 等协议事件，不处理 completion sound。声音应由 ACP client/editor 自己决定。Server 端 ACP adapter 不应打开音频设备。

### 8.6 Server/headless

`opencode serve`、daemon、container 和无 TUI 场景不加载 attention host，也不应播放。一个 Server 可能同时服务多个客户端；Server 播放会发生在错误的机器，并且无法知道哪个用户、窗口、设备或设置应该生效。

### 8.7 行为对比

| Surface | 当前完成信号 | 默认声音 | child Session | error 后 done | 设备所有者 |
| --- | --- | ---: | --- | --- | --- |
| TUI | observed busy/retry -> idle | 否，attention 总开关 false | 播 `subagent_done` | suppression | TUI 本机进程 |
| Web | deprecated `session.idle` | 是 | 完全忽略 | 可能播放 | 浏览器 tab |
| Desktop | deprecated `session.idle` | 是 | 完全忽略 | 可能播放 | Electron renderer |
| `run` | `session.status(idle)` | 否 | 不适用 | 退出逻辑受影响 | 无 |
| ACP | 无 completion presentation | 否 | 协议 relay | 不适用 | ACP client 决定 |
| Server | 无 | 否 | 不适用 | 不适用 | 不应拥有设备 |

## 9. TUI 音频链路审计

### 9.1 当前链路

```text
attention.notify({ sound: { name: "done" } })
  -> resolve configured/active/builtin sound candidate
  -> Bun.file(path).bytes()
  -> @opentui/core Audio.loadSound(bytes)
  -> Audio.start()
  -> miniaudio platform backend
  -> operating-system default playback device
```

### 9.2 内置 sound pack

`packages/opencode/src/cli/cmd/tui/attention.ts:16-21` 当前映射：

| 语义 | MP3 |
| --- | --- |
| `default` | `bip-bop-01.mp3` |
| `question` | `bip-bop-03.mp3` |
| `permission` | `staplebops-06.mp3` |
| `error` | `nope-03.mp3` |
| `done` | `bip-bop-01.mp3` |
| `subagent_done` | `yup-01.mp3` |

候选顺序为：

1. `attention.sounds[name]` 配置覆盖；
2. active sound pack；
3. built-in pack。

某个文件读取/解码失败后会尝试下一候选。这个 content fallback 是合理的。

### 9.3 默认设备事实

OpenCode 没有调用：

- `Audio.listPlaybackDevices()`；
- `Audio.selectPlaybackDevice()`；
- `Audio.clearPlaybackDeviceSelection()`。

OpenTUI native start 因而向 miniaudio 传入 null device ID。miniaudio 会使用操作系统定义的默认播放设备。官方 simple playback 文档也明确说明未指定设备时输出到 OS default playback device：

- <https://miniaud.io/docs/examples/simple_playback.html>
- <https://miniaud.io/docs/manual/index.html>

OpenTUI 0.3.4 相关源码：

- <https://github.com/anomalyco/opentui/blob/v0.3.4/packages/core/src/audio.ts>
- <https://github.com/anomalyco/opentui/blob/v0.3.4/packages/core/src/zig/audio.zig>
- <https://github.com/anomalyco/opentui/blob/v0.3.4/packages/core/src/zig/miniaudio_shim.c>

准确语义是：

> 在 Audio engine 第一次成功 `start()` 的时刻选择系统默认输出设备。

如果用户之后切换蓝牙耳机或系统默认设备，当前 OpenCode wrapper 不会主动 stop/restart/reselect。是否自动迁移取决于平台 backend；不能把动态跟随默认设备写进首版保证。

### 9.4 平台 backend

当前 lockfile 固定 `@opentui/core@0.3.4`，包含 8 个 platform packages。native miniaudio backend 覆盖：

| 平台 | backend |
| --- | --- |
| macOS | CoreAudio |
| Linux | ALSA、PulseAudio |
| Windows | WASAPI、DirectSound、WinMM |

OpenCode build matrix覆盖 macOS/Linux/Windows、arm64/x64，以及 Linux glibc/musl。音频没有扩展主 TUI 之外的新平台要求，因为 OpenTUI renderer 本身已经依赖相同 native package。

本地 `node_modules` 调研还发现非当前平台的若干 package metadata 仍显示 0.2.11，而 lockfile 要求 0.3.4；当前 Darwin ARM64 package 是正确的 0.3.4。release build 会按 target 重新安装 package，但跨平台 artifact 应增加 ABI/audio symbol smoke check，不能只依赖当前机器的 inactive package 目录。

### 9.5 lazy start、缓存与销毁

当前 wrapper 的优点：

1. TUI 启动不会立即打开音频设备。
2. 第一次 eligible sound 才创建 engine、读取并解码文件。
3. 文件路径映射到共享 Promise，避免并发重复 decode。
4. `default` 与 `done` 共用同一路径，因此共用 decoded sound。
5. TUI 正常退出会在 plugin disposal 后执行 `TuiAudio.dispose()`。

当前风险：

1. engine 创建第一次失败后缓存 `audio=null`，本次 TUI 生命周期不再重试。
2. 文件读取或 decode 失败会永久缓存 `Promise<null>`。
3. 替换同一路径的自定义音频不会热更新。
4. plugin 动态注册大量唯一 sound 后不会单独 unload，直到退出才释放 PCM。
5. fire-and-forget `attention.notify()` 可能和退出 disposal 竞态。
6. native voice pool 固定 32 个；高并发声音可能耗尽。
7. 多个声音默认允许重叠，没有 cooldown、队列或优先级。

这些风险不阻止首版，但应把“失败缓存可重试”和“完成声不重叠”列入 hardening phase。

### 9.6 音量语义

`attention.volume` 被 clamp 到 `0..1`，再作为 native per-voice 线性 gain。它不是感知响度百分比，也不是 dB。

使用 OpenTUI headless mixer 对候选 clip 做了无声测量：

| 文件 | `afinfo` 时长 | native peak | active RMS | 当前用途 |
| --- | ---: | ---: | ---: | --- |
| `bip-bop-01.mp3` | 0.679s | 0.3142 | 0.1138 | TUI default/done |
| `staplebops-01.mp3` | 0.418s | 0.2042 | 0.0194 | App completion default |
| `yup-01.mp3` | 0.653s | 0.2554 | 0.0339 | TUI subagent done |

测量方法使用 48kHz、双声道、2 秒 buffer，active RMS 只统计绝对值大于 `1e-5` 的 sample。它能比较技术电平，不能判断音色是否“耐听”。

当前 TUI 默认 `bip-bop-01` 在 volume 0.4 下理论 peak 约 0.126、active RMS 约 0.0455，远低于 full scale；时长也小于 0.7 秒。它可以作为首个候选，不需要新增 asset。

最终默认声音必须经过人工 A/B，而不能只凭文件名或 RMS 决定。建议至少比较：

1. `bip-bop-01` @ 0.25、0.3、0.4；
2. `staplebops-01` @ 0.7、1.0；
3. 笔记本扬声器、耳机、外接显示器扬声器；
4. 系统音量 20%、50%、80%；
5. 连续触发 10 次后的疲劳感；
6. 与 error、Permission sound 的可辨识度。

在人工听感通过前，提案暂时保留现有 `done -> bip-bop-01` 和 volume 0.4，不把主观偏好伪装成已验证结论。

### 9.7 设备变化与恢复

如果第一次 `start()` 因无设备失败，后续每次 play 会再次尝试 start；这是有益的。engine 创建本身失败则不会重试。

建议 hardening：

1. start/play 出现设备类错误后，把 playback 标记为 stale；
2. 下一次 notification 允许一次有界 stop/restart；
3. 不持久化设备 array index；index 只在一次枚举中有效；
4. 未来如增加设备偏好，应等待 OpenTUI 暴露稳定 device ID；
5. restart 失败继续静默，不弹出阻塞性 toast。

### 9.8 remote、SSH 与 headless

| 运行方式 | 声音发生位置 |
| --- | --- |
| 本地 TUI + 本地 Server | 本机默认输出设备 |
| 本地 `attach` + 远程 Server | attach TUI 所在本机 |
| 通过 SSH 在远端启动 TUI | 远端机器的默认设备；通常无设备并静默失败 |
| container/headless TUI | start 失败，sound=false，其他通知仍可工作 |
| server-only | 不创建 audio engine |

BEL 与 native Audio 的差异是：BEL 通过 terminal stream 到达 terminal emulator，可能在 SSH 本地提示；native Audio 属于运行进程所在 OS。若未来需要 SSH-friendly 模式，应提供显式 `bell` adapter，而不是 native 失败后自动 fallback。自动 fallback 可能造成重复提示，并受 terminal bell 设置影响。

## 10. 备选播放方案

| 方案 | 跨平台 | 默认设备 | 音量 | 外部依赖 | SSH 本地 | 推荐 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| OpenTUI native Audio | 是，覆盖现有 release matrix | 是 | 是 | 无新增 | 否 | 默认方案 |
| macOS `afplay` | 仅 macOS | 是 | 是 | 外部进程 | 否 | 拒绝默认使用 |
| Linux `paplay`/`aplay` | 分发行依赖 | 通常 | 不一致 | 常缺失 | 否 | 拒绝默认使用 |
| PowerShell/Media.SoundPlayer | Windows 限制多 | 不稳定 | 不一致 | 子进程/runtime | 否 | 拒绝默认使用 |
| terminal BEL | terminal-dependent | 不适用 | 不可控 | 无 | 是 | 仅未来显式 adapter |
| Server 播放 | 错误主机 | Server 默认设备 | 可控但无意义 | 无 | 否 | 明确拒绝 |

OpenTUI native Audio 的 interface 已经存在、已有两个以上平台 adapter、打包路径也已建立。继续使用它比建立一组 shell command adapter 更深、更安全、更有 locality。

## 11. 当前可用的 opt-in 能力

用户现在已经可以在 `tui.json` 中手动启用：

```json
{
  "attention": {
    "enabled": true,
    "notifications": false,
    "sound": true,
    "volume": 0.4
  }
}
```

这会让现有 question、Permission、error、done 和 subagent_done sound 生效。它适合作为开发验证，不是本文推荐的最终完成语义。

已知限制：

1. 仍以 busy/retry -> idle 判断 done；
2. child Session 会发 `subagent_done`；
3. direct shell 和 manual Compaction 也可能发 done；
4. BackgroundJob 会造成 parent 多次 done；
5. late attach/reconnect 可能漏报；
6. `notifications:false` 只关闭 OS notification，不修复声音语义。

## 12. 设计约束与不变量

### 12.1 Settlement 不变量

| 编号 | 不变量 |
| --- | --- |
| S1 | 一个 Session 同时最多有一个 open Agent generation |
| S2 | generation 从 open 到 settled 只能转换一次，settled 后不能 reopen |
| S3 | 后续外部输入在 closure 之后创建新 generation |
| S4 | 每个 accepted root/queued Message 必须在 settlement 前被 answered、coalesced、aborted 或标为 noReply |
| S5 | Goal continuation、自动 Compaction、foreground child 和关联 BackgroundJob handoff 都属于当前 generation |
| S6 | manual Compaction/direct shell 必须有 `kind`，不能伪装成 Agent completion |
| S7 | cancellation 只有在 terminal writes 和 owned cleanup 完成后才能 settled |
| S8 | Status 不参与 settlement interface；重复 busy/idle 不改变 generation identity |
| S9 | `session.error` 是诊断事实，不直接决定 failed settlement |
| S10 | generation settlement 必须有稳定 ID，供 at-least-once transport 去重 |
| S11 | settlement event 必须在最终 Message/RequestUsage terminal state 持久化之后发布 |
| S12 | title、summary、prune 等不会再启动 Agent loop 的 detached work 不阻止 settlement |

### 12.2 Presentation 不变量

| 编号 | 不变量 |
| --- | --- |
| P1 | Core/Server event 不包含 sound name、volume、focus、OS notification 文案 |
| P2 | root Agent completed generation 最多尝试播放一次 |
| P3 | transport 重复不能重复播放；按 `(sessionID, generationID)` 去重 |
| P4 | failed/aborted/paused/blocked 不播放成功声 |
| P5 | child Session 默认不播放 root 完成声 |
| P6 | 音频失败只影响 presentation result，不影响 settlement |
| P7 | 非交互 surface 没有 audio adapter 就保持静音，不需要伪造 no-op module |
| P8 | reconnect snapshot 默认只 seed 去重，不追溯播放历史完成声 |

## 13. 方案比较

### 13.1 方案 A：只把 `attention.enabled` 改成 true

优点：

- 修改最小；
- 现有 tests、sound pack 和 native audio 基本可直接复用；
- 符合 `specs/v2/notifications.md` 的既有目标。

缺点：

- 直接放大当前 idle 误报；
- 同时启用 question、Permission、error、subagent 和 OS notification，而不只是完成声；
- Web/TUI 的 completion 语义继续不一致；
- 没有 generation ID 和 reconnect dedupe。

结论：只适合开发 opt-in，不适合作为默认发布方案。

### 13.2 方案 B：客户端继续组合 idle、Message、Goal 和 BackgroundJob

每个客户端订阅更多事件，并在本地判断是否真正完成。

优点：

- Core 变更少；
- 可快速原型。

缺点：

- TUI、Web、Desktop、run、ACP 各自复制生命周期知识；
- client 看不到所有原子 admission/closure；
- reconnect 后无法恢复 transient ownership；
- 每增加一种 continuation，都要修改所有客户端；
- 删除任一推断 module 后，复杂性会重新散落到调用点。

结论：shallow module，拒绝。

### 13.3 方案 C：Server/Core 直接播放

优点：

- Server 最接近 Agent loop；
- 单一调用点看似简单。

缺点：

- 播放发生在错误主机；
- 一个 Server 可服务多个用户和客户端；
- 无法知道 focus、设备、音量和用户设置；
- headless/CI/remote 环境产生错误和噪音；
- 音频依赖污染 Core 生命周期。

结论：明确拒绝。

### 13.4 方案 D：语义 settlement + 本地 audio adapter

Core-side module 只判断 generation settled，client adapter 决定播放。

优点：

- interface 小，隐藏复杂 ownership；
- 所有客户端共享一次 completion 语义；
- presentation 仍有本地配置和设备所有权；
- 可替换 `run` 的 idle 退出逻辑；
- generation ID 提供可靠去重；
- 后续 durable replay 有自然 seam。

缺点：

- 必须先修复 Runner closure 与 late admission；
- BackgroundJob ownership 需要贯穿 child、inject 和 resumed loop；
- 需要新增事件并重新生成 SDK；
- v1/current production 与 EventV2 migration 需要谨慎衔接。

结论：推荐。

### 13.5 方案 E：terminal BEL 或 shell player fallback

BEL 对 SSH 有优势，shell player 对单一平台容易验证，但它们的行为和音量不可统一。默认自动 fallback 还可能在 native error 后产生第二声。

结论：不作为默认；未来若有明确 SSH 用户需求，可设计显式 `output: "bell"` adapter。

## 14. 推荐 module 与 seam

### 14.1 `SessionSettlement` module

seam 位于 `SessionPrompt`/`SessionRunState` 之上，`SessionProcessor` 之下不允许决定 Session settlement。

外部 interface 应保持很小：

```ts
export interface Interface {
  readonly run: <A, E, R>(
    input: {
      sessionID: SessionID
      requestID: MessageID
      source: "prompt" | "command" | "background_result"
    },
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>

  readonly get: (
    sessionID: SessionID,
  ) => Effect.Effect<Snapshot | undefined>
}
```

`run()` 的 caller 不传 generation、outcome、background count、Goal status 或音频策略。module 自己从工作终态与 owned adapters 推导。

内部可以有 private ownership interface，但不要暴露容易漏配对的 public `begin()/end()`：

```ts
type OwnedKind =
  | "goal_continuation"
  | "auto_compaction"
  | "foreground_child"
  | "background_job"
  | "background_injection"
  | "queued_loop"

type InternalOwnership = {
  acquireBeforeFork(kind: OwnedKind): Effect.Effect<Lease>
  handoff(lease: Lease, next: OwnedKind): Effect.Effect<Lease>
  release(lease: Lease, outcome: Outcome): Effect.Effect<void>
}
```

这些方法只给已经拥有 spawn seam 的 adapters 使用：Task Tool、BackgroundJob、Goal continuation、Compaction 和 Runner。acquire 必须发生在 fork 前，不能等 child fiber 启动后再登记。

### 14.2 module depth

interface 隐藏：

- Runner generation token；
- queued Message watermark；
- Goal continuation eligibility；
- foreground/child relation；
- BackgroundJob handoff；
- cancellation precedence；
- outcome 聚合；
- event exactly-once decision；
- live snapshot/reconnect revision。

调用者只获得“运行这项 root work”和“读取当前 settlement snapshot”两个能力。这比让每个 caller 学习 `hasGoal()`、`hasBackground()`、`isIdle()` 更深。

### 14.3 state machine

```text
Settled
  -> Open(generation)
  -> Closing(generation)
  -> Settled(generation, outcome)
```

建议内部 generation：

```ts
type Generation = {
  id: string
  sessionID: SessionID
  parentSessionID?: SessionID
  kind: "agent" | "shell" | "maintenance"
  requestIDs: MessageID[]
  rootRequestID: MessageID
  messageWatermark: MessageID
  runnerDone: boolean
  cancelling: boolean
  cancellationCleanupDone: boolean
  owned: Map<LeaseID, OwnedKind>
  outcome?: Outcome
}
```

closure 条件：

```ts
generation.runnerDone === true
&& generation.owned.size === 0
&& noAcceptedMessageAfter(generation.messageWatermark)
&& noEligibleGoalContinuation()
&& cancellationIsCompleteIfRequested()
&& terminalMessageStateIsPersisted()
```

admission 与 closure 必须使用同一 per-Session synchronized transition。不能依赖 sleep/debounce 来猜“已经安静足够久”。

### 14.4 outcome precedence

```text
aborted > blocked > failed > paused > completed
```

实际 `paused` 与 `blocked` 是否高于 failed 需要结合 Goal 产品语义评审；关键是不允许 client 从 raw error 自己分类。

## 15. 推荐事件契约

### 15.1 EventV2 定义

建议在 `packages/core/src/session-event.ts` 增加：

```ts
export namespace Run {
  export const Settled = EventV2.define({
    type: "session.next.run.settled",
    aggregate: "sessionID",
    version: 1,
    schema: {
      timestamp: V2Schema.DateTimeUtcFromMillis,
      sessionID: Session.ID,
      generationID: Schema.String,
      requestIDs: Schema.Array(Schema.String),
      rootRequestID: Schema.String,
      parentSessionID: Schema.optional(Session.ID),
      finalMessageID: Schema.optional(Schema.String),
      kind: Schema.Literals(["agent", "shell", "maintenance"] as const),
      outcome: Schema.Literals(["completed", "failed", "aborted", "paused", "blocked"] as const),
    },
  })
}
```

事件不包含：

- `sound`；
- `volume`；
- `shouldNotify`；
- focus；
- OS notification title；
- raw Provider body；
- Goal 文本；
- BackgroundJob 输出。

### 15.2 为什么用 generation event 而不是每 request event

一个 Running Runner 可以消费多个排队 Message，也可以由 Goal 产生多个 synthetic Message。如果为每个 request 播放，会在同一个 Agent loop 结束时连续响多次。

事件保留 `requestIDs` 用于归因，但每个 generation 只产生一个 `Run.Settled`。这与用户提出的“整个 agentloop 结束时播放一声”一致。

### 15.3 当前 EventV2 migration 接法

当前 production 仍是 v1 Session，EventV2 migration 尚未完成。新事件不应再创建第三套 schema。

建议：

1. schema 只定义在 `@opencode-ai/core/session-event`；
2. 新 settlement 没有 legacy dual-write 对象，可无条件通过 `EventV2Bridge.Service.publish()`；
3. `projectors-next.ts` 注册 no-op 或 snapshot projector，保证 bridge 不会因缺少 projector 提前 return；
4. bridge 继续把 versioned event 投影为现有 Project Bus/GlobalBus payload；
5. SDK 从同一 registry 生成新 Event union；
6. 不用 `session.idle` 伪装 settlement；deprecated idle 保留为 compatibility/status 事件直到消费者迁移完毕。

### 15.4 live delivery 与 durability

当前 EventV2 PubSub 是内存流；SyncEvent 只有在 experimental Workspaces 下持久化完整 event rows。首版声音可以接受：

- connected client 对观察到的 generation 至少收到一次 live event；
- client 按 generation 去重；
- reconnect 不追溯播放旧声音。

如果未来要求断线期间完成后重连仍通知，需要新增 durable latest-settlement snapshot/outbox，而不能只靠 SSE replay 假设。建议 snapshot：

```ts
type Snapshot =
  | {
      state: "working"
      sessionID: SessionID
      generationID: string
      revision: number
    }
  | {
      state: "settled"
      sessionID: SessionID
      generationID: string
      revision: number
      outcome: Outcome
    }
```

presentation client 在 reconnect 时只把 snapshot 用作去重/恢复 UI，不自动播放历史 chime；headless waiter 可以用 snapshot 判断命令已经结束。

## 16. 必须先修复的生命周期问题

### 16.1 移除 Processor 的 Session-wide idle ownership

`SessionProcessor.halt()` 应返回结构化 step outcome，并可继续发布诊断 error，但不应决定整个 Session idle。只有外层 Run state/Settlement module 知道是否还有：

- Goal continuation；
- Compaction；
- queued Message；
- child handoff；
- BackgroundJob resume。

目标是移除 `session/processor.ts:1017` 的 session-wide idle 写入。

### 16.2 generation-aware Runner idle

Runner/Run state 必须防止旧 onIdle callback：

- 删除 replacement Runner；
- 对新 generation 发布旧 idle；
- 在取消 finalizer 前宣布 settlement。

onIdle payload 至少需要 generation token，map 删除必须验证 token 仍匹配。

### 16.3 Message admission watermark

在 runLoop final break 前：

1. 冻结当前 final Assistant parentID/message watermark；
2. 与最新 accepted User Message 比较；
3. 若存在更新 Message，则继续同一 generation；
4. admission 与 closure 使用同一同步 seam，消除最后 snapshot 后的新 Message 竞态。

### 16.4 BackgroundJob handoff

关联 lease 必须覆盖：

```text
BackgroundJob start
-> child Session execution
-> child terminal result
-> parent synthetic Message persistence
-> parent loop admission
-> resumed parent loop settlement
```

不能在 `BackgroundJob.Info.status` 变 completed 时提前 release。

### 16.5 cancellation finalization

aborted settlement 要晚于：

- Runner interrupt；
- Tool abort handlers；
- Assistant terminalization；
- pending ToolPart terminalization；
- RequestUsage aborted update；
- foreground child cancel；
- related BackgroundJob cancel。

## 17. 客户端 presentation 方案

### 17.1 TUI adapter

迁移后 `internal:notifications`：

```ts
api.event.on("session.next.run.settled", (event) => {
  if (event.properties.kind !== "agent") return
  if (event.properties.parentSessionID) return
  if (event.properties.outcome !== "completed") return
  if (handled.has(event.properties.generationID)) return

  handled.add(event.properties.generationID)
  void api.attention.notify({
    title: api.state.session.get(event.properties.sessionID)?.title,
    message: "Session done",
    notification: { when: "blurred" },
    sound: { name: "done", when: "always" },
  })
})
```

关键点：

1. 在 playback 前登记 handled，失败后不自动晚到重播。
2. `handled` 应是 bounded LRU，不是无限 Set。
3. 同一 generation transport 重复不再次尝试。
4. `session.error` 继续服务错误 attention，但不再参与 done suppression。
5. busy/retry/idle 继续服务 spinner/status，不再触发 done。

### 17.2 App/Desktop adapter

App 把 completion sound 从 deprecated idle 迁到同一 `Run.Settled`：

1. root-only 信息直接来自 event，不再异步 lookup 后判断 parentID；
2. completed 才播放 agent sound；
3. failed/aborted 不再紧跟一个 completion sound；
4. notification history 是否继续记录 “turn-complete” 应单独迁移，不与音频强耦合；
5. browser `Audio` 应接受 volume，当前 `playSound()` 没有设置 `audio.volume`；
6. browser autoplay rejection 只记失败，不自动重试，避免用户稍后突然听到旧声音。

### 17.3 `run` 与 ACP

`run` 可以用匹配 generation 的 settlement 结束 waiter，但默认没有 audio adapter。

ACP 可以 relay settlement 给 editor/client；是否发声由 editor 决定。不要给 ACP Server 添加 no-op audio dependency。

## 18. 默认启用与配置策略

### 18.1 推荐首版

优先复用现有 attention interface，不新增第二套音频配置：

```json
{
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4,
    "sound_pack": "opencode.default"
  }
}
```

理由：

1. `attention.enabled=true` 已经是 `specs/v2/notifications.md` 的明确目标；
2. `notifications` 与 `sound` 已独立；
3. `sounds.done` 已支持用户覆盖；
4. sound pack 和 fallback 已有完整 tests；
5. 再增加 `completion_sound` 会形成第二个浅配置 surface，并绕过现有 sound pack。

默认翻转只能在 settlement consumer 完成迁移后进行。否则会把当前误报直接变成默认行为。

### 18.2 明确 opt-out

```json
{
  "attention": {
    "enabled": false
  }
}
```

保留现有 master opt-out。

只关闭声音但保留 OS notification：

```json
{
  "attention": {
    "enabled": true,
    "sound": false,
    "notifications": true
  }
}
```

### 18.3 category 级开关

首版不新增 category matrix。默认 root completion policy 固定为 root-only、success-only；question、Permission 和 error 保留当前 attention 行为。

如果真实用户提出“保留 Permission 声音但关闭 done”的需求，再设计 category filter。不要预先把六个 sound name 都变成配置 boolean。

### 18.4 focus 策略

现有完成声 `when: "always"`，OS notification blurred-only。推荐首版保持：

- 长任务完成时，即使 terminal focused，用户也可能在看另一块屏幕；
- root-only 和 generation dedupe 已大幅降低频率；
- 低音量短声比依赖 terminal focus 更可预测。

如用户反馈 focused 时打扰，再增加 `attention.done_when: "always" | "blurred"`，而不是用 renderer focus 猜测所有声音。

## 19. 声音重叠与节流

即使每 generation 一次，多个 Session 也可能同时完成。建议 completion adapter 增加 presentation-only coalescing：

1. 同一 generation 永久去重；
2. 不同 generation 在 500-750ms 内完成时只播放一次 chime；
3. 每个 Session 的 OS notification/badge 仍独立；
4. error/Permission 等高优先级声音不被 completion coalescer 吞掉；
5. completion voice 不与前一个 completion voice 重叠，可选择 stop previous 或 queue one。

这个 coalescing 只影响 presentation，不改变 settlement event 数量。

## 20. 分阶段实施建议

### Phase 0：行为锁定测试

不改生产行为，先增加失败测试：

1. Processor error 后 Goal continuation 不得产生中间 settled。
2. manual Compaction 不得产生 Agent settled。
3. direct shell 不得产生 Agent settled。
4. late queued Message 必须进入当前或下一 generation，不能丢失。
5. BackgroundJob 完成前 parent 不得最终 settled。
6. cancel settlement 晚于 Message/Tool terminalization。

### Phase 1：Settlement module

1. 新增 `SessionSettlement` InstanceState module。
2. 为 Runner 增加 generation token 和 generation-aware idle。
3. 让 Processor 返回 outcome，不再写 Session-wide idle。
4. 把 prompt admission 与 generation closure 线性化。
5. 接入 Goal、Compaction、foreground child、BackgroundJob handoff。
6. 暂不改变客户端声音默认值。

### Phase 2：语义事件与 SDK

1. 增加 `SessionEvent.Run.Settled`。
2. 增加 projector/bridge registration。
3. 无条件通过 EventV2Bridge 发布新事件。
4. 重新生成 JavaScript SDK：`./packages/sdk/js/script/build.ts`。
5. 为 HTTP/global stream 和 event union 增加 contract tests。

### Phase 3：客户端迁移

1. TUI done/subagent_done 从 Status 迁到 settlement。
2. TUI root completed 才播放 done。
3. App/Desktop completion sound 迁到 settlement。
4. error/abort 不再随后播放 success。
5. `run` waiter 改用 settlement 或 authoritative snapshot。
6. Status 继续驱动 spinner、retry footer 和 busy UI。

### Phase 4：默认启用

1. 把 TUI `attention.enabled` 默认从 false 改为 true。
2. 保留 `enabled:false` opt-out。
3. 更新 `specs/tui-plugins.md` 和 `specs/v2/notifications.md`。
4. 更新 config test 默认值。
5. 发布说明明确：会启用 question、Permission、error 和 completion attention；声音与 OS notification 可独立关闭。

### Phase 5：音频 hardening

1. negative cache 失败后允许有界 retry。
2. engine create failure 使用 backoff，而不是整个 TUI 生命周期永久 null。
3. disposition generation，防止 in-flight load 在旧 engine 上完成。
4. completion overlap coalescing。
5. device loss 后一次有界 restart。
6. compiled artifact 增加 MP3 decode/native symbol smoke test。

### Phase 6：可选 durable snapshot

仅在产品要求断线恢复、跨客户端 automation 或 durable wait 时实施：

1. 保存 latest settlement revision；
2. 提供 Session settlement read route；
3. reconnect 双读 snapshot + subscribe；
4. presentation 默认不追溯播放旧 chime；
5. headless waiter 可以接受已 settled snapshot。

## 21. 预计文件影响

| 文件/区域 | 预计变化 |
| --- | --- |
| `packages/core/src/session-event.ts` | 增加 `Run.Settled` schema |
| `packages/opencode/src/session/settlement.ts` | 新增深 module，拥有 generation/ownership/closure |
| `packages/opencode/src/effect/runner.ts` | generation-aware finish/idle |
| `packages/opencode/src/session/run-state.ts` | 接入 settlement，收敛 Status ownership |
| `packages/opencode/src/session/prompt.ts` | root admission、Goal/Compaction ownership、message watermark |
| `packages/opencode/src/session/processor.ts` | 返回结构化 outcome，移除 Session-wide idle |
| `packages/opencode/src/tool/task.ts` | foreground/background ownership 与 handoff |
| `packages/opencode/src/background/job.ts` | fork 前 ownership adapter 或 metadata propagation |
| `packages/opencode/src/session/projectors-next.ts` | settlement projector/no-op registration |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/notifications.ts` | 从 Status 推断迁到 settlement event |
| `packages/opencode/src/cli/cmd/tui/config/tui.ts` | 最后阶段翻转默认值 |
| `packages/app/src/context/notification.tsx` | completion 从 idle 迁到 settlement |
| `packages/app/src/utils/sound.ts` | 可选 volume 支持与 overlap policy |
| `packages/sdk/js/**` | 重新生成事件类型 |
| 对应 tests/specs | 生命周期、adapter、配置、SDK 与文档更新 |

具体实现时应优先替换旧推断，不要在其旁边叠加第二条 done listener，否则一个 generation 会同时由 idle 和 settlement 播放两次。

## 22. 完整测试矩阵

### 22.1 Settlement module

| Case | 期望 |
| --- | --- |
| 单步文本完成 | 1 个 completed settled |
| 多 step + 多 Tool | 全部完成后 1 个 settled |
| Provider retry 后成功 | retry 不 settled，最终 1 个 completed |
| automatic Compaction 后成功 | Compaction 中不 settled |
| Goal 连续 N 轮后 complete | 最终 1 个 completed |
| Goal 达 max turns 后 pause | 1 个 paused，不播 success |
| terminal error + continueOnError | 中间 error/idle 不 settled |
| terminal error 无 continuation | 1 个 failed |
| context overflow recover | 最终 completed，不是 failed |
| queued Message 被同一 loop 消费 | 同 generation 1 个 settled，requestIDs 完整 |
| closure 同时到达新 Message | 线性化为当前或下一 generation，不丢 Message |
| manual Compaction alone | maintenance settled 或无 Agent settled |
| direct shell alone | shell kind，不触发 Agent completion |
| shell -> queued Agent handoff | 一个 Agent generation，无中间 settled |
| foreground child | child 可 settled，parent 最终才 root settled |
| background child | parent 初次 idle 不 settled，inject/resume 后才 settled |
| user abort | cleanup 后 1 个 aborted |
| duplicate cancel | 仍只有 1 个 aborted |
| replacement run during old finish | 旧 callback 不删除/settle新 generation |

### 22.2 TUI adapter

| Case | 期望 |
| --- | --- |
| root Agent completed | done sound 1 次 |
| duplicate event ID/generation | 仍为 1 次 |
| child completed | 默认 0 次 |
| failed | success sound 0 次 |
| aborted | success/error 新行为均为 0，除非 error policy另定 |
| shell/maintenance | Agent done 0 次 |
| attention disabled | 0 次 |
| sound disabled、notification enabled | sound 0，notification 可成功 |
| focus focused | 依当前 always policy播放，OS notification不发 |
| focus blurred | sound + OS notification |
| decode/device failure | 返回 sound=false，不抛出 |
| 多 Session 500ms 内完成 | 按 coalescing policy 只响一次 |

### 22.3 App/Desktop adapter

| Case | 期望 |
| --- | --- |
| completed settlement | 一次 completion sound/record |
| error followed by legacy idle | 不再播 completion |
| child event | 默认忽略 completion sound |
| browser autoplay reject | 无 unhandled rejection、无 retry surprise |
| persisted settings 未 ready | 不越过明确 user opt-out |
| duplicate transport | generation 去重 |

### 22.4 Audio wrapper

1. built-in MP3 可以从 Bun file import 读取。
2. native `loadSound()` 在 headless mixer 成功。
3. 相同 path 并发 load 只 decode 一次。
4. failed load 不永久 poison cache。
5. dispose 后旧 promise 不写入新 generation engine。
6. start 失败静默并允许后续有界 retry。
7. volume 0 不打开设备、不分配 voice。
8. compiled binary 包含 MP3 与 audio native symbols。

CI 不应播放实际声音。真实设备输出属于人工 QA。

### 22.5 跨平台人工 QA

| 平台 | 检查 |
| --- | --- |
| macOS arm64/x64 | CoreAudio 默认输出、耳机切换、静音、退出释放 |
| Linux PulseAudio/PipeWire | default sink、无 daemon、container 降级 |
| Linux ALSA-only | default PCM 与无设备降级 |
| Windows x64/arm64 | WASAPI default、设备切换、Terminal/PowerShell 启动 |
| local attach remote Server | 声音只在 local client |
| SSH remote TUI | 不误称本地发声，失败静默 |

## 23. 观测与诊断

不要收集设备名称或音频内容 telemetry。建议只使用本地 debug log 和匿名计数：

| 指标/日志 | 用途 |
| --- | --- |
| settlement generation opened/settled | 检查重复或永不结束 |
| settlement outcome/kind | 验证策略覆盖 |
| completion adapter handled/skipped | 解释为何没响 |
| audio create/load/start/play failure category | 区分 ABI、decode、device、voice pool |
| duplicate generation dropped | 检查 transport at-least-once |
| coalesced completion count | 评估多 Session burst |

音频错误当前都被压成 boolean。hardening 时可以在内部使用 typed failure，但 public plugin result 仍可保持稳定的 `{ ok, notification, sound, skipped? }`。

## 24. 兼容与迁移

### 24.1 `session.status` 与 `session.idle`

1. `session.status` 继续存在，用于 UI busy/retry/idle。
2. deprecated `session.idle` 在 App、SDK 和外部 plugin 迁移前不能立即删除。
3. 文档必须明确 idle 不再是 completion contract。
4. 内部 done consumer 迁完后，不再从 idle 播放声音。

### 24.2 TUI 配置

`attention.enabled:false` 是已发布配置，必须继续是 explicit opt-out。翻转默认只影响没有显式值的用户。

`attention.sounds.done`、sound pack 和 KV active pack 保持有效，不需要迁移。

### 24.3 App settings

App 当前 `sounds.agentEnabled` 和 `sounds.agent` 已持久化。首版可以保留字段名，只改变事件来源；不要为了命名美观强制 migration。未来若改为 `completion`，需要从 `settings.v3` 显式迁移。

### 24.4 Plugin interface

external TUI plugin 仍可调用 `api.attention.notify()`。新 settlement event只是增加更可靠的事实，不移除 soundboard interface。

## 25. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Settlement module 变成另一套 Run state | 生命周期重复 | 只拥有语义 closure，不复制 Runner 执行控制 |
| ownership lease 漏释放 | generation 永不 settled | scoped acquire/release、fork 前登记、泄漏诊断 |
| ownership 提前释放 | 提前声音 | BackgroundJob lease 覆盖 inject + resumed loop |
| EventV2/legacy 双写重复 | 两次声音 | schema 单一、event generation 去重、替换旧 listener |
| late Message 仍有竞态 | 漏回答/提前声 | admission 与 closure 同一 synchronized seam |
| 默认启用引发用户反感 | 体验回归 | 先修语义、短声、root-only、explicit opt-out、release note |
| 多 Session 同时完成 | 声音重叠 | 500-750ms completion coalescer |
| 音频设备变更 | 后续无声 | bounded restart，不持久化 index |
| 浏览器 autoplay | Web 无声 | one attempt、设置/UI说明，不晚到重播 |
| SSH 用户无本地声 | 需求未覆盖 | 文档说明；未来显式 BEL adapter |
| native ABI mismatch | engine 创建失败 | target artifact decode/symbol smoke test |

## 26. 明确拒绝的实现

1. 在 `SessionStatus.set(idle)` 中直接播放。
2. 在 `SessionProcessor.halt()` 中直接播放。
3. 在 Server/daemon 进程调用系统音频设备。
4. 每次 Assistant finish、Tool finish 或 step finish 播放。
5. 只用固定 `setTimeout()` 等待“可能稳定”。
6. 看到 `session.error` 后假设下一个 idle 一定 terminal。
7. 为了 SSH 自动发送 BEL，导致本地 native 与 BEL 双响。
8. macOS 用 `afplay`、Linux 用 `paplay`、Windows 用 PowerShell 组成默认跨平台层。
9. 在声音播放失败时改变 Session outcome 或阻塞 TUI 退出。
10. 保留旧 idle done listener 的同时增加 settlement listener。

## 27. 发布验收标准

只有全部满足时才能默认启用：

1. normal、retry、Tool、Compaction、Goal、queued Message、foreground/background subagent 和 cancel tests 全绿。
2. 任何测试路径中，一个 root generation 最多出现一个 `Run.Settled`。
3. BackgroundJob path 不在第一次 parent idle 时 settled。
4. manual Compaction/direct shell 不触发 Agent completion sound。
5. failed/aborted 不播放 success sound。
6. TUI、App/Desktop 对 root/child 和 error 行为一致。
7. `attention.enabled:false` 能完全关闭 TUI attention。
8. native device unavailable 时 Agent 结果不受影响。
9. macOS、Linux、Windows target artifact 至少通过 MP3 decode/native symbol smoke test。
10. 人工听感确认默认 clip 在连续 10 次播放后不过度打扰。
11. 文档明确 remote attach 与 SSH 的声音位置差异。
12. 最终 diff 不包含 Server-side audio command 或外部播放器依赖。

## 28. 实施前决策清单

以下问题需要在编码前确认，但不阻碍本提案主方向：

1. generation ID 使用新的 `run_` Identifier，还是使用 first root Message ID。
2. active Goal 达 max turns 后应标为 `paused` 还是 `completed`。
3. BackgroundJob 是否始终阻止 root settlement，还是只阻止标记为“会自动 resume parent”的 job。
4. completion coalescing 窗口采用 500ms 还是 750ms。
5. 默认 done clip 保留 `bip-bop-01@0.4`，还是通过听感评审选择更低 gain。
6. 新 settlement event 首版只 live delivery，还是同时落 latest snapshot。
7. `opencode run` 是否与第一阶段一起迁移，还是等 TUI/App 验证后再迁移。

推荐默认答案：

| 决策 | 推荐 |
| --- | --- |
| generation ID | 独立 `run_` ID，Message IDs 保留在 `requestIDs` |
| Goal max turns | `paused`，不播放 success |
| BackgroundJob | 只有关联且会 inject/resume 的 job 阻止 settlement |
| coalescing | 750ms，presentation-only |
| sound | 先保留现有 `bip-bop-01@0.4`，人工 A/B 后再改 |
| durability | 首版 live + bounded client dedupe；snapshot 后续 |
| `run` migration | settlement 稳定后同一 release 迁移，但仍默认静音 |

## 29. 最终判断

当前代码已经能通过系统默认音频输出链路播放一个短提示音，且 native OpenTUI Audio 是正确的跨平台 adapter。直接新增平台命令没有必要。

但是，当前 `busy/retry -> idle` 只适合 Status UI，不足以代表整个 Agent loop 或用户任务完成。若现在只翻转默认开关，声音会在 maintenance、child Session、BackgroundJob 暂停点、错误续跑和取消清理等路径产生误报或重复。

因此正确顺序是：

```text
先建立可靠 Session settlement
  -> 再让客户端消费一次性 generation event
  -> 再复用本地默认设备播放
  -> 最后才默认启用 attention
```

这个方案把复杂生命周期隐藏在一个深 module 后，把音频设备和用户偏好留在本地 adapter，既保证完成语义的 locality，也保证跨 TUI、Web、Desktop 和 headless surface 的行为可解释、可测试、可逐步迁移。
