# Canonical Implementation Plan: Daemon 权限查询阻塞、步骤边界停顿与 SSE 断流

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: §1 全部用户消息：原需求、WPR、减法与单提交、审批默认读取及工作方式
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-25

固定基线：`SMARK2022/opencode`，`dev1-smark`，`6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`。`git ls-remote origin refs/heads/dev1-smark` 与本地 HEAD 相同。本文件是唯一计划；初次规划按 `docs/guides/workflow.md`，用户的 “Verified plan” 对应 `approved-plan-only`。候选在隔离进程中运行；实际实现的 `verified` 是另一终态。

## 1. Verbatim Requirement

```text
下面需要你去检查一下我们Open Code仓库，也就是Smart 2022 Open Code DEV 1 Smark分支。之前其实我们已经进行过两次的Daemon问题性能问题修复，甚至最开始的时候也进行过一次修改修复。那但是现在呢，我仍然在部分情况下观察到它有一部分的这种问题，而且这个问题大概率是第二个，也就是之前我说过是两个Daemon的修复，或者说三个。那它就是在第二个或者说第三个Daemon修复之后所引入的，也就是最近的一次这个Daemon卡顿等等这些问题修正的commit之后所引入的。所以，但这一块我也不确定是不是由它引入，还是说只是它让这个体感上、UI上变得更加明显了。也有可能后端本身就是在卡，只不过第一次的修改让前端不再变得那么明显了，但是事实上可能还是卡的。但反正现在的问题就是，你再看一下，结合当前这个Daemon，你也可以看到我们的奔驰mark情况，看一下相应的这个性能情况到底是怎么回事。按照我的理解，我们当前CPU负载不是很高，20%左右或者30%左右，它可能单核有这个阻塞，但是按理来讲，主线程负责的东西就是去调度啊，去各种东西，它不应该说让这个TUI连接它的时候，它的整体消息队列啊等等都会有问题。所以当前你再去分析一下，我认为问题可能不局限于这个简单的消息队列长度的问题，而且消息队列长度本身，它一旦出现这种长也反映了说消息处理速度有问题的这么一种情况。请你去完整检查一下，看看到底怎么回事。保持高效。

我先拉取仓库，查最近几次 Daemon 修复提交，再对照事件分发、主线程和 SSE 队列的实际代码路径，分析卡顿从哪里来。

我没法连到你那台 Windows 上正在跑的 Daemon，所以下面的结论来自两部分：一是逐个读了 `dev1-smark` 最近几次 Daemon 修复的 diff 和当前代码，二是你附件里上一轮 Agent 留下的实测数据。

## 结论

**后端的卡顿早就有，不是最近才出现的。最近那次修复改变的是卡顿的后果：以前卡一下只是消息晚到，现在会让所有 TUI 同时断流，然后集体重连，又把 Daemon 压一遍。**

按时间排，改变行为的提交是这几个：

| 提交 | 日期 | 对卡顿 / 断线的影响 |
|---|---|---|
| `b3cfcb0` | 10-04 | SSE cancel 竞态，和这次的问题无关 |
| **`9f911f0`** | **11-13** | **断线问题从这里开始**：`/global/event` 和 `/event` 原来是无界队列，改成了 256 条上限，满了就直接结束流 |
| `bacad3c` | 11-18 | 流式响应也开始压缩，数据库准入（Gate）扩展到所有 SQL 语句；会增加开销，但不是断线主因 |
| `ece062d` / `5c3a359` | 11-19 | 审批取证搬到 Worker，请求计量少做内存分配；总体有利，副作用是常驻内存会起伏 |

## 一、为什么整机 CPU 只有 20–30%，系统还会卡

主线程干的不只是调度。`bun:sqlite` 的所有查询都是同步执行的，JSON 序列化和解析、zstd、token 计量、SSE 编码、HTTP 处理也都挤在同一个 JS 线程上。你的机器 16 核，一个核完全跑满，整机也只显示 **6.25%**。所以整机百分比基本说明不了主线程忙不忙。上一轮实测的数字正好说明这一点：五分钟平均只用了约 13% 的单核，但 18:23:11 那次在 1.25 秒里主线程就占了 **1.03 秒 CPU**。这段时间里健康检查、SSE 写出和所有其他请求都只能等着。

## 二、9f911f0 之后，一次卡顿怎么变成所有 TUI 同时断线

代码在 `handlers/global.ts:62-68`：每条连接 256 条缓冲，`offerUnsafe` 失败就 `endUnsafe`。问题在于生产者和消费者在同一个线程上：

1. **触发**：主线程卡住一段时间，这期间 provider 的流已经在网络层积了很多数据块。恢复后，读流的 fiber 拿到的都是已经到达的数据，可以靠微任务一直往下跑，不会让出给 Effect 调度器。SSE 写出的 fiber 排不上队，五条连接的队列一起被填满。
2. **数量会被放大**：`event-v2-bridge.ts:73-110` 里，每个持久化事件都会往 GlobalBus 发两份（原事件加一份 `sync` 副本）。十几种事件类型还要再查一次 SQL，额外发一份 `session.updated`。实际的事件数是"模型输出量"的两到三倍。
3. **正反馈**：断开后，五个 TUI 都会收到 `server.connected`，于是同时全量 `bootstrap`（`tui/src/context/sync.tsx:925-933`）。每个 TUI 发大约 15 个请求，包括 providers 这类大 JSON，五个就是 70 多个请求一起压到主线程上，而且 `bacad3c` 之后这些响应都要压缩。这一轮又会造成新的卡顿。

上一轮的复现结果是：连续同步发 512 条事件，五个客户端都在第 256 条断开；每 10 条让出一次事件循环，就一条都不断。这和 18:29"五条连接 4 毫秒内全部断开，约 1.2 秒后全部连回"的特征一致。

## 三、主线程真正的周期性热点（这部分是原来就有的）

`prompt.ts:1723` 在**每个 step**（每轮工具调用之后）都会调用 `MessageV2.promptWindowProof`（`message-v2.ts:1713`）：

- 一次同步的 `.all()` 把压缩边界之后**所有消息和 Part 的 `data` 原文**都读出来。这一步没法中途让出；`ece062d` 加的 8ms 让出只覆盖后面的循环。
- 然后对每条消息做 `JSON.stringify` 加 zstd（`encodeProofKey`）。
- 之后还有 `filterCompacted` / `warmExecutionWindow`，再加上 `Token.estimateRequest` 用带 replacer 的 `JSON.stringify` 把整个请求体再走一遍，SDK 最后又序列化一次。

这些开销都和窗口里的历史量成正比，而且每个 step 都要付。最慢的那次（1.18 秒）正好和"execute 工具结束加模型流收尾"重合，也就是 step 交界的时刻。我认为它是一秒级 CPU 停顿最可能的来源，但还需要下面的追踪数据来确认。

另一种慢样本是 814ms 里主线程只用了 125ms CPU。这说明主线程在**等待**，不是在算。从代码看有两个候选：

- 同步 SQLite 在等锁：`busy_timeout = 30000`，而且 bun:sqlite 等锁时会把整个 JS 线程挂起。
- WAL 自动 checkpoint 在提交时做 fsync，Windows Defender 有可能把它拖慢。

光读代码分不出是哪一个。

## 四、建议的持久修复（按优先级）

1. **SSE 溢出策略**（修断线）：别在一瞬间的突发上直接断流。可以改成按字节上限（比如 8–16MB），或者"持续积压超过 N 秒才断"，同时合并 delta 事件。断开日志要**记下原因**（溢出、客户端关闭还是停机），现在这个关键信息是缺的。
2. **重连风暴**：如果 `server.connected` 对应的还是同一个 Daemon 实例，TUI 只需要重新同步会话和消息，providers、config、agents、commands 这些不用重拉，重连时再加点随机延迟。
3. **promptWindowProof 降到 O(1) 级别**：比较的键改用 `(id, time_updated, cold_key)` 这种小元组，或者每个会话维护一个修订号，不再读原文、做 stringify 和 zstd。`estimateRequest` 也可以考虑增量计算。
4. **本机请求不压缩**：远端地址是 loopback 时跳过 compression 中间件。

## 五、不打断点的现场取证

需要重启一次生产 Daemon，但不挂调试器：

- **Effect 链路追踪**：代码里已经接好了 OTLP（`core/src/observability/otlp.ts`）。重启时设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 指向本机的 Jaeger all-in-one，就能看到每个 step 里 `MessageV2.promptWindowProof`、`Session.get`、各个 HTTP handler 各自花了多少时间，直接回答"那一秒是谁占的"。导出器是批量发送的，开销不大，但不是零。
- **WPR 采样**：用上一轮给的那条 `wpr -start CPU` 命令。它能区分 CPU 停顿和等待停顿，等待那一类还能看到调用栈落在 SQLite 的忙等还是 fsync 上。
- 两者按时间对齐，再加上第 1 项里的断开原因，三种问题（断流、一秒级 CPU 停顿、低 CPU 的等待）就都能分开定性了。

需要的话，我可以先做第 1 和第 2 项。这两项改动小，能直接拿上一轮那组"5 个客户端对照"做验收；第 3 项范围大一些，建议等追踪数据确认之后再做。 下面请注意一点，你要找到完整合理的方式去解决这套问题。同时按照First principle的原则去构建相应的Plan，同时你要按照Plans里面的Guide里面的Workflow dot Markdown去进行执行。最终验收标准是Verified plan。同时请注意，你所构建的plan，按照我的理解，它的生产代码量应该保持净增量不超过200行。同时请注意一点，你的方案应当是着重解决相应的卡顿等等一些问题，不要尝试试图进行更多的接线、弹出报错等等各种各样的一些逻辑。应该首要解决的是当前卡顿的一个情况，以及负载呀等等一些内容；


请注意这点，同时你的净增的行数保持，不应当依靠压缩行数来解决，应该是简化逻辑，移除、删除掉不必要的一些逻辑。请注意这点。完整按照CLAUDE所提出的方案方式去进行相应的一套设计，不要引入与用户要求无关的任何的额外的接线、断言、接口等等内容。不应当为用户没有提及的任何边界条件，注意我这里说的是任何边界条件，引入任何无关的改动。任何边界条件指的是，比如你说你所提出的方案中，发现了既有基线存在某一种错误的情况下会导致错误的结论。那请你注意，用户没有说这个东西，所以你不得进行这个调整，除非你的修改是以简化你的方案的形式来实现的。就譬如你引入了一个状态逻辑，那这套状态逻辑在某些情况下可能出现问题，但是用户又没有声称你要解决这个问题，那你要做的就是把你这套状态方案基机制移除掉，或者说改掉。也就是说你不应该去增加额外的判断逻辑，来去解决这种下游遇到的问题。但同时你也不应当引入新的独立于基线之外的新的错误或者红色测试等等。
```

### 用户追加的现场证据及范围要求（原文）

```text
卡住 Daemon 的核心瓶颈是：工具做权限检查时，主线程同步查询 SQLite，顺带重算了当前请求的 token 和费用。 在这台机器的一个长会话里，一次这样的查询花 1.17 秒。连续几个工具各算一次，Health 和延迟端点就一起错过了 3 秒期限。
你问是不是 read 工具在卡：现场抓到的 ReadFile 是 SQLite 在读数据库页。 第一组超时甚至发生在四次 grep 的权限检查阶段，真正的 ripgrep 搜索排在后面。
现场证据
- 运行中的 Daemon 是 PID 37520，主线程是 TID 44492。WPR 抓到三次 Health 超时，分别为 3.042、3.013、3.012 秒。这三个窗口共取得主线程 CPU 样本 8,689 个，其中 76.4% 命中同一个 Windows ReadFile 调用位置，三次分别为 76.9%、74.9%、77.3%。
- 用与运行中二进制 GUID 和 Age 均匹配的 Bun 1.4.4 调试符号解出调用栈：bun:sqlite → sqlite3_step → sqlite3VdbeExec → vdbeColumnFromOverflow → accessPayload → sqlite3OsRead → winRead → ReadFile。vdbeColumnFromOverflow 表示 SQLite 正在读取跨数据页存放的列值。火绒的 sysdiag.sys 出现在 33.0% 的样本栈里，14.0% 的样本直接执行在该驱动中。它增加了这台机器的读页成本；触发这些读取的是应用自己的查询。
- 独立的端点对照里，TCP 约 1 ms 就连上了；随后公共 Health 返回 200、延迟路由在本地拒绝无效参数返回 400、私有控制口返回 401，三者却都等了 2.03 秒。后两条路径分别跳过了外部 provider 和实际控制业务。它们共同等待的是 Daemon 主线程。机器有 16 个逻辑核，单个线程占满只相当于整机约 6.25%，所以你看到整机 20%–29% 与这次阻塞完全吻合。
具体是哪条查询
grep 先在 packages/opencode/src/tool/grep.ts:80 调 ctx.ask()，到 :130 才启动搜索。Permission.matchRequest 在 packages/opencode/src/permission/index.ts:94–105 只需要当前会话的 agent 和权限规则，却调用了默认的 sessions.get(sessionID)。默认路径在 packages/opencode/src/session/session.ts:523–525 还会计算 request 用量。
最贵的一段在 packages/core/src/session/info.ts:65–70：为了找到当前用户消息对应的事件序号，查询先按会话和 message.updated.1 找事件，再从每条候选的 event.data 里用 json_extract 比对消息 ID 和角色。这个现场会话有 28,185 条候选事件。 我用独立只读连接，对同一会话拆开测了实际 SQL：
查询	实测耗时
只读 agent, permission	首次 11.53 ms，再读 0.44 ms
只用索引统计 28,185 条候选事件	13.42 ms
加上事件 JSON 身份匹配，求事件序号	1,052.65 ms
执行完整请求用量查询	1,166.01 ms
日志也对上了：19:43:56 至 19:44:03，四次 grep 从 tool.start 到打印权限判定，分别等了 1.91、1.52、1.32、1.37 秒。由此能把问题定位到比“数据库慢”更具体的一步：权限热路径为了读取几个会话字段，反复让 SQLite 在主线程上读取、解析历史事件正文。 连续调用把单次一秒左右的成本叠成了控制面超时。上一轮优先怀疑的 SSE 队列和请求序列化，这次可以排到后面。
修复落点
第一处就改权限读取：在 packages/opencode/src/permission/index.ts:97 使用已有的 sessions.get(sessionID, { request: false })，并检查 execute 子工具里同类的权限读取。这样保留每次读取最新权限的语义，同时跳过历史用量计算。真正要展示用量的路径，再单独优化 info.ts:65–70 的事件身份查找。验收用长会话连续触发四个工具，同时验证两件事：权限查询不再访问历史事件正文，Health 不再随这一批调用超时。
从提交历史看，权限路径的默认 sessions.get() 是 11 月 11 日 0f94f4ff829 加入的；11 月 19 日 ece062da81 增加了 { request: false } 轻量路径，并在部分调用点启用，遗漏了权限入口。这条瓶颈早于最近一次 Daemon 修复。
可复查的 CPU 记录在 D:\Temp\opencode\daemon37520-cpu-resolved.etl。本次只做了采样和只读查询，仓库未改动。    同时让你的plan中包含这一段相应的内容，请注意这些内容。换言之，这一部分需要纳入你的修改范围内。
```

### 范围、默认读取与工作方式的补充（用户原文）

```text
为什么这么多？18个每个都是必要的吗？分析一下哪些是不必要的接线。按理来讲，很多逻辑都是需要被移除掉的。用户已经清晰地给你了所需要进行的修改的一个要求内容。你可以看到用户给你的两批内容。一批你所生成需要改6个生产文件，按照我的理解，那最多改4个就OK了。第二个这一批卡住了核心，这个权限检查、同步调用啊这些东西，按照我的理解，它最多只需要修改不到4个文件就OK了。你不要在这地方一直给我去加加加加逻辑，加什么呀？不要做用户未要求的一些改动，请注意这点。你像你做了什么HTTP的一些过分的接线呢？按理来讲是很多是不必要的，或者说不必须的，请你注意这点。像是你做了过分的一些什么数据库生成物什么，这种东西数据库的Schema你动它干什么？按理需要动吗？不需要动就不要去动。我再说一遍，用户没有要求你做的东西，没有要求你动的接线、动的逻辑，都不要去动。与此同时，我已经说的很清晰了，这一些内容都是DAEMON的卡顿修复计划的。所以它本身是一次Commit，你不要告诉我提交成两个Commit来解决这个问题。不要告诉我有一部分留着之后修，要求如上内容，我提到这些内容都必须解决掉。
```

```text
不要做一些用户没有要求你干的这些事情，比如什么冷存储啊等等内容。因为按理来讲，我们的东西很简单，就是工具的审批，它本来就不应该去读什么 token 啊，巴拉巴拉那些东西。按理来讲，工具的审批就是直接去看它的权限，全业检查本身就不应该再去看什么 token 和费用这些东西，这些东西完全是不必要的。权限检查就直接去看，经过一遍 preflight，或者说看一下用户全局的一个 rules 的一个，就是 rules 的一个列表即可。按理来说，它的读取应该是很快的，几十毫秒就完成了。当前的时间它是花了几秒钟的时间去做的这么一件事情，所以请你注意一点。其他逻辑什么冷存储啊等等东西，用户没有提及的一概不要去做，一概不要去管。这本身你就直接让它就不读取就 OK 了。从根源处解决这个问题，不要从下游说冷存储读说读入更快，这些东西是不必要的。它有些事情不需要的，就根本就不要让它做，请注意这点。也就是移除掉对应的那些不该有的一些数据的一些读入啊，等等一些东西。不要做其他的无关的，或者说用户没有要求的这些事情。
```

```text
什么叫基础会话？人会选出会话累积 token 和费用列，这什么意思？什么叫基础查询？按理来说，让基础查询默认值它就读不到不就可以了吗？这样的话，这样的话不就会更好了吗？从根源处就解决掉了。
```

```text
请注意一点，有些事情应该你去做，你不应该反复调用一个 task 去帮你做东西，这本身就是在把任务进行分派，而且分派本身又没有意义。你让 task 跟让你自己去做有什么区别吗？没有任何区别。你又不能解决优化它的并发性等等一些东西，那你这调研有什么用呢？没有任何用处。
```

### 关于 R4 阻塞项的澄清（用户原文）

```text
我想问一点，他其中所说的问题是什么？这是我们的一个问题吗？就是我我说的意思指的是说，正常的工具调用的时候，不该去进行不必要的一些这个Token的一个获取。当然你如果告诉我说他模型发出的时候，那模型发出的时候，他是不是按理来讲他都会进行这个Token的一个计算呢？因为他是不是说需要去按照Token计算来判断自己超不超呢？如果是这样的话，那本身这个地方是不需要被修的吧？你看一下这到底是什么逻辑？
```

```text
所以你就去做精准操作。请注意，按理来说这些内容他不应该修改过多行。按照我的理解，你三条实际路径啊，巴拉巴拉这些东西，那确实应该去做处理。你说他既然多读了，那按理来说你如果去修改的话，按理来讲也可，是不是说只需要修改十几二十行，就可能就已经修改完了。所以请你注意保持相应的这个修改干净，不要去引入过多无关的一些接线、函数逻辑、接口等等内容。请注意这点。
```

### R5 文件范围及交付授权

用户在 R5 全范围审计后明确回答：“当前允许这些内容了。我授权你进行这些内容。然后你不用再去审计了，你已经审计完了，当前方案等于说已经通过了，技术性阻塞，既然都已经解决，那就是你已经被审计员approve了，请注意这点，本身方案也不需要去改了。然后接下来你可以看一下我们当前的工作区。既然当前工作区其中是有这个重叠项的，你可以先把工作区的内容先去stash一下，然后你再去进行你的修改。”随后指定 `verified-implementation-and-commit`，按 `docs/guides/workflow.md` 对实际 diff 独立审计后单次提交。设计及固定基线不变。

实施阶段用户补充（当前会话，适用于本次交付）：「请注意一点，修改是需要你去进行，避免使用Task去完成修改任务。」以及「不要去做用户未要求的行为。用户没有要求你跑GUARD，GUARD本身会在线上自动跑，你在本地跑属于多余行为。不要自己尝试去修改GAR的登录内容来完成接线啊等等操作。」因此修改由主代理执行，独立审计只读，Guard 由线上 CI 自动执行。此执行范围更正不改变 R5 的生产设计。

后续用户补充：「由你所引入的防御性逻辑应该被移除。」以及「你所引入的3个test文件是重型测试，不建议在本地跑。请注意这点，相应的内容转为CI跑。或者只提取部分关键的测试内容跑一下，不要跑整个Prompt动作的这种测试文件。」整文件重型回归归 CI，本地仅选与修复直接对应的具名用例。

## 2. 交付范围与非目标

**一个 Daemon 修复提交，四项同验收：**审批只读规则；详情按需比较请求顺序；step 不重读未变正文；SSE 突发不断开健康连接。完整生产范围为 **8 个已有文件**：规则读取 2 个、审查器准备 1 个、详情 1 个、step/SSE 4 个。相对先前估计，只有自动送审的两处读取需要再动一个已有 owner；不借其他文件转接来凑文件数。当前交付终态为 verified-implementation-and-commit。

删去持久索引、迁移、数据库生成物、prompt 调用方传参、自定义 SSE 邮箱和连接服务接线。不修改持久 schema、冷存储、TUI、SDK、HTTP API、Health 路由、压缩策略或超时。不得用改写另一项功能的默认返回值来节省审批成本。

## 3. 仓库约束

基线为 §1 前所列的 6dd9a5b1f3。docs/guides/workflow.md、first-principles policy/template、根 AGENTS.md 以及 packages/opencode 及其 test、test/server、HTTP API 目录的 AGENTS.md 适用。CONTEXT.md 规定 Provider Turn 的可见历史、live 无回放、durable 的有序身份；ADR 只有 triage 决议。分层保持 Core → Server → legacy 应用可依赖方向。以下 P=packages/opencode，C=packages/core，S=packages/server，T=packages/tui。

## 4. 证据与来源

| 来源 | 证据及类别 |
| --- | --- |
| 用户 WPR、工具日志、只读 SQL（§1 原文） | observed（用户现场）：PID 37520 / TID 44492，三个窗口 8,689 个样本，76.4% 同一 SQLite ReadFile 位置；进程外 Health 分别 3.042、3.013、3.012 s。未把合成实验当现场栈。 |
| P/src/{tool/grep.ts:80,130,permission/index.ts:91–111,session/tools.ts:166–179、227–249、285,session/session.ts:523–526} | reachable：grep 先 ask 后搜索；规则读取、Execute 子调用准入与实际 ask 的责任可分开。 |
| C/src/permission/auto.ts:69–107，P/src/permission/reviewer/service.ts:167–178、344–369、397–410、596–630、910–942；P/src/session/session.ts:604–621，P/test/permission/reviewer-service.test.ts | observed：strict 只读工具经 precheck 进入真实 reviewer；读模型和找子会话先于发送。发送时的输入细分和 provider 返回 usage 的结算是另两件事。 |
| C/src/session/{info,sql,store}.ts、C/src/v1/session.ts:55–130、P/src/server/routes/instance/httpapi/handlers/session.ts:140–146、P/test/session/session.test.ts:207–218 | contracted：详情的 request 是计算投影；cost 和 tokens_* 是 session 行已有的累计列。Session.get 的无选项调用也有依赖这些字段的读者。 |
| C/src/{event/sql,event,session/projector}.ts、P/src/event-v2-bridge.ts；session-runner、session-info-selection 测试 | contracted：V1 首个 user 更新、native admission/promotion 和 active compaction 竞争同一请求身份；计费公式与协议不变。 |
| P/src/session/{message-v2,prompt,prompt-window-cache}.ts、C/src/{session/{history-proof,compaction-boundary},database/database}.ts | reachable：先编码整个窗口再比较，唯一生产调用在 runLoop 顶层、已有连接预约、缓存 lease 与单槽。 |
| S/src/{handlers/event,event-clients}.ts，P/src/server/routes/instance/httpapi/handlers/{event,global}.ts，C/src/{event,filesystem/watcher}.ts、P/src/bus/global.ts、T/src/context/{sdk,sync}.tsx | reachable：各 SSE 输入独立准入，真实断线后的重连与完整快照均有消费者。 |
| §8、§18 的固定提交隔离 A/B、真实 TCP、权限途中撤销、合成库和 Guard 留存结果 | observed；不在运行中的 Daemon 或用户数据库上施压。 |

## 5. 当前行为

授权 → 默认 Session.get → selection(id).request → 对会话历史 message.updated.1 的 event.data 匹配身份并求最小序号 → SQLite 读溢出页，其他请求等待同一线程。基础列分支 { request:false } 虽然不算 request，仍会返回整组会话列。授权实际只需选 agent 和当前会话规则，之后走原有全局/agent/caller/session 规则、precheck 和需要的人工或自动审批。

详情/列表/提交后投影确实需要费用。即使只有 V1 可选请求，基线也先求 V1 的绝对最小事件序号。每个模型 step 同样在确定哪些 key 可复用之前，对整个保留窗口重新读正文、逐条 stringify/zstd。事件侧则在读者还未被调度时就因第 257 个 offer 结束流；五端误断才触发重复 bootstrap。流式 delta 本身并不都是 durable 事件。

权限默认读取由 0f94f4ff829（11-11）引入，ece062da81（11-19）提供跳过 request 的选项。86cae19ba9 已有 proof 压缩；9f911f0a48（11-13）引入 legacy 流的 256 满即断；bacad3c03a 把实例过滤移到入队前，5c3a359f8e 合入请求计量改进。由此区分现场权限阻塞与后端突发被放大的时间点。

## 6. 支持域与可达性

真实 producer 包括普通 grep、一个 Execute 内先后准入多个子工具及运行中改权限；纯 V1、mixed、无对应历史事件的 V1 请求；顶层 warm/append/替换缓存及合法同毫秒修改；同步 GlobalBus、已缓冲 provider 输出、native 支持的 watcher 事件和持续慢读客户端。保留已有 unsupported/NotFound、scope 退出和规则优先级。无生产调用方的异常 SQL、猜测性 reader 状态不增加分支或断言。

## 7. 不变量

- I6 授权：读取最新 session 规则时只 SELECT agent, permission，零累计费用列、零 request 投影、零历史正文。四工具负载中，进程外重叠的 HTTP Health 请求 3 s 内读到完整 200 JSON。保留授权/撤权和补充上下文缺省语义。
- I6 也覆盖实际送审：隐式选择父模型只取 model；已有审查子会话只取 id、directory，不取兄弟会话用量。模型优先级、证据、锁、必要的模型输入处理和 finish-step 真实 token/cost 照旧。
- I7 展示：按既有 started/position/time/id 顺序确定真实 winner；只有竞争且顺序有意义时才查 V1 事件。用量、费用、模型、估算、空值语义保持，禁止新增持久索引。
- I1/I2 历史：warm/正常尾部追加不重编码未变前缀，仍返回原有精确无损键、真实持久时序及 provider 输出；lease、撤回和原有生命周期不变。
- I3/I4 传输：五个健康 socket 顺序收齐 512 个原始片段和后续帧。真正慢的订阅有界且独立结束；保留编码、过滤、strict Core 订阅和真断线恢复。
- I5 范围：上述四项在同一实现、一次提交中验证；8 个已有生产文件，正常排版净增 ≤200 行；审查器补正不增接口或 helper。测试和计划分开计数。

## 8. 首个分歧和实测

**审批。** 现场 28,185 条候选事件，仅按索引计数 13.42 ms；加 JSON 身份匹配 1,052.65 ms，完整 request 1,166.01 ms。四次 grep 的审批判定前分别经过 1.91/1.52/1.32/1.37 s，ripgrep 尚未开始。现场 TCP 约 1 ms 建连，HTTP 200/400/401 均等约 2.03 s。总 CPU 20–29% 不排除单线程阻塞。火绒驱动出现在栈中；不改其配置，也不把 76.4% 的栈样本当作可由驱动节省的时间。

同一固定提交、28,185 条同会话候选/溢出页的独立文件库，实际 SQL 已捕获为 `select "agent", "permission" from "session" where "session"."id" = ?`。每个工具验证搜索结果，外部 Node 进程在审批前开始取 Health 至完整响应体。

| 工况 | 权限读中访问事件正文：基线 → 候选 | 权限 SQL 合计 | 完整 Health 最大耗时：基线 → 候选 |
| --- | --- | ---: | ---: |
| 四次直接 grep | 4/4 → 0/4 | 590.1 → 0.149 ms | 416.7 → 113.728 ms（候选 21 样本） |
| 一个 Execute 内四次 grep | 14/14 → 0/14 | 2,049.8 → 0.618 ms | 514.0 → 54.658 ms（候选 18 样本） |

18 次读取都保留了实时候选规则。直接和嵌套 deny 后 allow 均按当前状态执行；同一 Execute 第一条 grep 完成后、Question 暂停时撤权，下一条 grep 未获准入。单行工具夹具的新 SQL 中也无已存 token/费用。独立基线未超 3 秒，用户 WPR 才是超时正例。单独的先回 headers 后不结束 body 负对照在 3,011 ms 超时。统计只归因到授权，不把正常写事件、summary 或环境定位读混进来。

**实际送审。** 同一父会话带一个无关子会话，对只读工具连续执行两次 strict auto，预检、reviewer、SQLite、审查消息持久化均走真实路径，provider 使用仓库原有的 Responses SSE 夹具。旧父模型/子列表读第一次执行两条完整用量投影，第二次（已创建审查子会话）执行三条，另各有一次包含 cost/tokens 的宽行读取。候选两次都只执行 `SELECT model ... WHERE id=?` 及 `SELECT id,directory ... WHERE parent_id=? AND agent=? LIMIT 1`。两次 allow；复用同一子会话，两条 user、两条 assistant 均入库。旧行为在“定位不得取用量”断言上失败，候选通过；这里不把证据读取或返回后的真实 usage 写入算作冗余。

**显示。** 完整 Session SELECT + request 解码，SQLite 3.53.4，轮换 41 次，p50/p95。纯 V1、28,185 个同类事件仅一命中：17.56/20.43 → 0.30/0.58 ms；重复修订压力分布：44.75/69.22 → 0.32/0.64 ms。两者 V1 事件身份 JSON 求值均降为 0。native 提升后 V1 迟到修订的混合样本：35.85/41.07 → 0.20/0.35 ms。旧对手在前、V1 真正获胜且命中距离长时，34.995/40.364 → 15.450/20.694 ms，仍会扫描部分历史；不承诺任意混合数据 O(1)。短 CASE 仅优化纯 V1，但在文件库三种真实竞争状态仍耗约 300–316 ms，最终 SQL 约 0.23–0.60 ms。13 个公开生命周期状态的 Core、V1 和 TUI 用量输出与基线一致（例如累计 17 input / 8 output、0.375 cost，prepared 777 时 TUI 累计输入 794）。

**Step。** 4,096 行，七轮中位，warm wall/最长事件循环间隔 97.08/41.99 → 1.19/1.19 ms，append 120.57/52.89 → 9.85/9.86 ms。真实 2,048-turn provider fixture 三次尾变由 4,098/4,099/4,100 次编码降为 1/1/1，两次 full hit 为 0，换出重建为 4,100。真实 warm dispatch/命中/重建（单次）111/105/607 → 62/30/352 ms。首读用七对**新进程**另测，wall/间隔中位 75.49/43.05 → 65.68/31.93 ms，仍是全量。不同夹具的绝对时间不相加。零 DDL 的三条读端路线均测过：全量精确读追加约 63 ms、data_version+total_changes 约 54 ms、只识别行数增长在真实步骤中仍全量编码。证据支持仅在此职责保留连接私有的写入界线。

**SSE。** 同一 provider 用一次已缓冲响应送 512 个有编号 delta；三 global、两 instance，通过 Server.listen 走 TCP，等同源就绪标记，真实 POST 返回完整 2,450 字符。旧 socket 分别只收到 252/254/252/254/252 后 EOF；最终八文件合并候选五端均收到 512 个原 ID、完整 payload、同源后续帧，租约 5→0。把 global、instance 兼容队列或 native 的旧准入各单独放回，分别使 5 个 global、3 个 instance、2 个 native reader 在 256 截断；第三组用实际 native manifest 支持的 2,048 个 watcher 更新。暂停大帧 TCP reader 的对照中，各健康对端均得 896 帧和标记，慢端分别在已预取 284/288/284 后退出。仅让 Core producer 每 32 条让步不能覆盖直接同步 GlobalBus 和 watcher 多 fiber。故保留三个实际准入位置，不另设连接服务。

固定 HEAD 的 Linux Guard base（run 45056316015，15 对）stream / continue 的 health p95 为 41.4/42.0 ms，最长阻塞中位 87.1/94.2 ms。11-22 Windows 旧 Guard 五对 stream 最长阻塞 739→817 ms，即使零探针失败也不证明无停顿；这些 paced 工况不是同步 512 反例。此前 19:27 本机发行版 health 两次为 191.9/3.2 ms，亦非 19:43 超时窗口。

## 9. 责任边界

权限服务拥有规则判定和从本 session 读取规则的最小输入。会话详情拥有其完整返回合同，Core info.selection 拥有请求 winner。MessageV2 负责 proof，现有 slot 负责发布；HTTP transport 负责有界交接，EventClients 只计连接数。各职责不向下游转交补救。

## 10. 唯一实施路线

**权限。** 在 P/src/permission/index.ts 的既有 Permission.Service 上提供一项内部 sessionRules(id)，用同图 Database.Service 按 session 主键仅选 agent、permission；数据库依赖在本模块的现有 LayerNode 声明。未找到行沿用原 NotFoundError；matchRequest 维持原 serviceOption(Session.Service) 的有无约定和原 catchTag。P/src/session/tools.ts 的既有父 begin、child invoke 和 child ask 改用此读；child 结算 getPart 的 sessionID 直接用已知 input.session.id。当前 agent、全局/agent/caller/session 规则次序、自动/人工/deny、precheck、取消和每次重读时机不变，不建立规则缓存或维护额外状态。Session.get(id) 仍服务已有的完整会话读者，{request:false} 也不再被当成授权投影。此内部读取不扩展 HTTP/SDK。

**自动审查准备。** 仅改 P/src/permission/reviewer/service.ts 的两处读，直接复用层内已有 `database.db`。`parentSessionModel` 在原 `Effect.exit` 边界按 SessionTable.id 仅读 model；有模型则按原品牌类型返回，无模型/读失败仍走既有最近用户消息、默认模型选择；显式配置的模型仍优先，不执行父模型查询。`getReviewerSession` 在原父会话信号量内按 parent_id 和 agent='permission-reviewer' 取 id、directory，LIMIT 1，SQL 错误沿原 defect 路径；只在未命中时走原 session.create。记录 user 的内部参数只需 id，持久化 assistant 的参数只需 id、directory；用现有类型的 Pick，不加方法、层、缓存、诊断或对外字段。真实发送的 Token.estimateRequest/isOverflow、reviewer 的输入细分、finish-step 的 Session.getUsage 都不改。

**展示。** 仅替换 C/src/session/info.ts 的 current_request 选 winner 段：native_request 和 active_compaction 先按原 (started,position,time_created,id) 求唯一对手 r；没有对手直接选 v1_request，没有 V1 则返回 r。比较 V1 的 started（原有 assistant/parentID 存在性查询，保留 +v.id 亲和性）与 r.started；SQLite 的行值比较从左往右，优先级不同时无需 V1 事件。若相等，p=r.position≥0，updates 为该 session 下匹配 V1 用户 id/role 的 message.updated.1（NOT MATERIALIZED）；利用已有 (aggregate_id,type,seq) 索引，先按 seq≥p 升序 LIMIT 1 找匹配，没有则 V1 首次位置小于 p 或为 −1，均输。有后段命中时再按 seq<p 降序 LIMIT 1 找证据；有前段匹配即输，否则后段首行就是最早序号。沿用 time_created/id 平局规则，位置仅用于这次比较，不输出近似序号。winning_rival 每条语句只物化一次，两个互斥 SELECT 返回同样的 id/time_created/promoted_seq/kind。所有助手、步骤、确认/估算、计费及显示映射原样保留；不新增索引、迁移、开关和备用查询。

**Step。** 只有 P/src/session/message-v2.ts 改动，promptWindowProof(sessionID) 调用方式不变，proof 的 boundary 与有序 {id,key} 仍是原格式。连接自身保存最近完成 proof 的弱引用；原有缓存槽仍是强 owner。首次取证在该连接创建私有 TEMP 单行 (session,version,floor) 和针对 main.message/part INSERT/UPDATE/DELETE 的六个 TEMP AFTER 触发器，连接关闭即销毁；不修改主库 schema 或写入器。用 NEW、OLD 或两者更新原/新 session 的最小被写 owner ID（Part 取父 ID）；随原事务回滚。主调用在已有 Database.withSync 预约内，单个顶层 deferred 快照先取 main.data_version。上次 proof 尚存、同 session/版本、floor 为空则直接返回；否则读原 compaction boundary、cutoff 和按 (time_created,id) 排序的真实 ID。仅在上次 boundary 也相同且 SQLite 比较 id<floor 时复用旧项；对其余 ID 按同一份绑定 JSON ID 集合、原索引、Part ID 次序读原 tuple，保留全部字段，沿用无损 encodeProofKey 和原 8 ms 让步。更新单行、释放预约再编码；让出前轮换该读的弱引用容器，旧轮完成不能覆盖新快照。只有全部位置填完的 proof 能复用；跨连接提交、会话切换、失去强引用均自然重新证明。原 lease 与后置 admission、visible suffix、模型分块不动。无全库 population 计数、无 REPLACE 专用查询、不改存储生命周期。

**SSE。** 同一个服务端 HTTP 模块提供给三个现有 handler 复用的 offer 和普通 Core 订阅操作（不向 EventClients.Interface 加方法）。使用原 Effect dropping queue、fromQueue/Stream.callback；队列硬界 4,096 个事件引用/输入。当前积压从 256 跨到 257，只为这次跨线通过订阅 scope 的 FiberHandle 安排一次 Effect 让步；下一回合待取数仍大于 256，则结束该订阅。fromQueue 一次取走队列；在回调前排空后又跨线时取消上次的待决检查。硬界上失败的 offer 沿用 open 队列的 EOF/typed overflow；普通小批无定时器，发布者不等待客户端。实例保留普通输入、兼容输入、入队前过滤、注册/finalizerSafe/退订；全局仍用 GlobalBus 同步监听、正常 EOF；native/instance 仍用 SubscriberOverflowError。保留已有编码/投影/heartbeat/停止信号和 body-scope 计数。不合并业务帧、不改通用 Core allBounded。

## 11. 其他路径

正常审批直接规则判定、预检/人工/auto、缺失补充上下文均是原合同。显示的 V1/native/compaction 候选、proof 的重用/精确重建、慢读终止与真断线恢复均为各自主合同。新增替代成功路径 0，诊断 0%；没有错误后改走成功的备用实现。

## 12. 删除项

删掉授权调用对 Session.get/用量的依赖、选 winner 前无条件 LEFT JOIN/GROUP BY、proof 的全窗口正文查询、HTTP 每条连接一遇 256 即结流的判断。撤回计划里五条持久 schema/生成路径、prompt.ts 的额外传参、event-clients.ts 的自定义批邮箱；保留现成的 SQL 索引、队列和断后恢复。不要以一处更快的读来保留另一处本不需要的读。

## 13–14. 正向及反向追溯

| 需求/不变量 | 首次分歧 → 生产责任 | 允许的概念及不可省原因 | 可失败的行为检查 |
|---|---|---|---|
| RQ1/RQ5，I6 现场控制面 | 四个权限调用误取详情 → Permission/SessionTools | 两列规则读；已有 request:false 仍读累计列，不改外部详情 | S3 SQL 与外部 Health 双指标、真实回执与撤权 |
| I6 实际送审 | 父模型/审查子会话查找误取详情 → reviewer | 已有数据库连接两处窄读，原模型请求和结算仍由原 owner 负责 | S3 同父首次送审、再次复用；模型/用量回归原样运行 |
| RQ6/I7 显示 | 未决定需比较便求绝对 min → Core selection | statement-local 对手和已有索引的有界比较；纯 V1 零身份查找、混合顺序等价 | S4 长会话 SELECT、混合修订/提升、公开值 |
| RQ2/I1–I2 历史 | 先读正文再 admission → MessageV2 | 只保留连接临时写界线和弱证明，不靠时戳猜测变化；不保留正文 | S1 精确内容、实际 provider 前缀、暖读/追加及首读/写入成本 |
| RQ3/I3–I4 断流 | 读者无调度机会即终止 → 三个 HTTP 入口 | 现有队列、水位、一次延迟判定与硬界；单独恢复任一旧决策均有 TCP 红例 | S2 快端五连、慢端隔离、同路标记 |
| RQ4/I5 规模/完整性 | 所有路径一次合入 | 不增加其他 owner、持久 DDL 或提交 | 实际 diff / numstat、同一候选一次联合验收及独立审计 |

## 15. 文件清单

| 生产文件 | 唯一改动 | 原型 +/− |
|---|---|---:|
| P/src/permission/index.ts | 授权读取两列，沿用原有补充上下文和错误处理 | 18/3 |
| P/src/session/tools.ts | 三个 Execute 授权读；取消从详情对象重新取已知 sessionID | 5/5 |
| P/src/permission/reviewer/service.ts | 两个现有查询改选实际消费列；两处内部参数类型收窄 | 11/14 |
| C/src/session/info.ts | 仅替换 winner 选择 SQL | 23/17 |
| P/src/session/message-v2.ts | proof 生产者内复用已证明的键，不改调用方 | 100/81 |
| S/src/handlers/event.ts | 普通 HTTP 订阅和有界 offer 的共同实现，native 使用它 | 32/4 |
| P/src/server/routes/instance/httpapi/handlers/event.ts | instance 的普通/兼容两个准入点复用相同策略 | 5/4 |
| P/src/server/routes/instance/httpapi/handlers/global.ts | 保留 callback 与 listener，只换 offer 判定 | 3/6 |

测试改动单列：P/test/permission/next.test.ts（让原有六项上下文测试使用真实 Session+Projector 测试行，保留原断言，补审批 SQL 的公开行为回归）；P/test/session/tools.test.ts（既有完整接口测试替身需声明 sessionRules，直接工具快捷路径不调用它）；P/test/session/prompt.test.ts（在既有长会话中加强 S1/S4 的暖读/完整详情对照，复用 seed）；P/test/server/httpapi-event.test.ts（S2 真实 TCP 反例）。P/test/permission/reviewer-service.test.ts 复用原有父模型和真实库夹具覆盖送审两次；原 mock 的 model 改由测试数据库提供，删除已不用的 get/children 桩，保留原断言。**8 个生产文件 + 5 个已有测试文件**，另计本文。execute.test、Core selection/runner 等原测试仅运行。测试侧性能诊断不进入产品；不为每个入队分支再设一套测试文件。

## 16. TDD 与验收

实施顺序 S3 → S4 → S1 → S2，各自红绿，最后合并验收并提交一次。

1. S3：经真实 Permission.ask/Execute 请求，观测实际 SQL 投影列集合为 agent、permission、表为 session；要求已执行查询并读到最新规则，不能以零次调用冒充优化。基线默认读带 request 和累计列；仅传 request:false 仍有累计列，这两个负对照都要红。可在测试夹具/独立 SQL trace 做归因，不在生产加观察器。四个直接 grep 以及一个 Execute 连跑四个子工具，工具回执正确、在途外部 Health 在 3 s 内收到完整 200，记录 p95/max/失败；中途改 deny/allow 照旧。再走真实 PermissionAuto.evaluate(strict)→reviewer→模拟 provider 两次，观察选模型到定位子会话这段实际 SQL；必须没有完整用量投影、cost 或 tokens 列，两个定位 SELECT 均实际发生，且两次请求复用一个子会话。测试侧归因，不在产品插桩；显式模型覆盖、隐式模型回退和真实 usage 落盘沿用既有回归。
2. S4：独立验证纯 V1 单次命中及多修订两种样本，完整详情 p50/p95 < 同机基线的 20%；实际输出的 token、费用与 13 个生命周期语义（包含 native 提升后迟到修订）相同。混合且命中距离长的样本要求输出正确、不慢于基线，不对无索引的 JSON 身份声称双键点查。EXPLAIN 是诊断，不硬编码 SQL 文本作业务断言。
3. S1：4,096 个消息、每条一 Part，先持有前证再作暖读/追加。wall 与最长间隔的中位数都应 < 同机固定基线 50%，参考机 10 ms 夹具门；只用绝对时间作现场报告，不给所有 CI 机器同一 SLA。保持 2,048-turn 真实 provider 输入、原 prefix、4 MiB 可解压 key、撤回、取消与单槽回收。另验首读、换槽重建、1,000 次写的额外成本 ≤10 ms，不增加全库工作量。
4. S2：实际 TCP 同源 readiness → provider 512 个编号片段 → 同源后续帧，三 global、两 instance 逐 ID/payload 比对，必须在原连接收齐。另用支持的事件验证 native/instance/投影各自入口及慢读者，沿用原有恢复用例。测试标记不能跨 merge 输入假定顺序；不以“POST 200”代替收流。

## 17. 注释

只解释实际不直观处：SQL 的前序证据是相对对手的比较；快照在编码让步之前轮换；短时越过水位需要一次调度机会。正式注释用中文。无日志、断言或错误弹窗预算。

## 18. 验证命令与证据

研究脚本在 D:/Temp/opencode，固定 6dd9a5b1f3，通过进程内覆盖或独立临时库对照；不修改工作树生产文件。以下 $t 指该目录。

| cwd | 已执行的主要反馈/对照 |
|---|---|
| P | `& "$t/r4-rule-health.ps1" direct` 和 `& "$t/r4-rule-health.ps1" execute`；原基线 `& "$t/perm28-run.ps1" base direct` / `base execute`。独立新 SQL 验证以两列为准；§8 记录两臂真实结果。`r4-rule-fresh.toml` 的 WPR synthetic permission SQL 测试通过中途撤权。 |
| C | `bun --no-install --preload D:/Temp/opencode/request-duel-6dd-preload.ts D:/Temp/opencode/request-duel-6dd.bench.ts --analyze --record`（DUEL_N=41，诊断无持久索引）。 |
| P | `& "$t/v1-final-run.ps1" red` 基线超预算；`green` 通过。`base-life` 和 `life`，九项各通过。首读按七对新进程另外比较。 |
| P | `& "$t/sse-narrow-run.ps1" base exact` 红，`three exact` 绿。暂停 TCP、逐入口恢复旧行为、原 Core event 45/45、HTTP event 8/8、location 3/3 分别核验。 |
| P | `& "$t/v1-final-run.ps1" mixed -Patches 'sse-narrow-6dd.patch;daemon-r4-three.patch'`：三个临时 diff 覆盖全部七个生产文件，五端 TCP 通过。`$env:V1_PATCHES='sse-narrow-6dd.patch;daemon-r4-three.patch'; bun test --no-install --config=D:/Temp/opencode/r4-rules-fixtures.toml test/permission/next.test.ts test/session/tools.test.ts --timeout 30000`：116 pass / 0 fail；同候选局部 TS 七文件 0 diagnostics。 |
| P | `R5_ARM=base` / `green`（PowerShell 用 `$env:R5_ARM`）并设置 `$env:V1_PATCHES='sse-narrow-6dd.patch;daemon-r4-three.patch'`。`bun test --no-install --config=D:/Temp/opencode/r5-reviewer.toml test/permission/reviewer-service.test.ts -t 'reviewer setup uses only' --timeout 60000`：旧审查器退出 1；候选运行同文件去掉 `-t` 后 **30 pass / 0 fail**，含显式/隐式模型及 finish-step 费用回归。 |
| P | `& "$t/v1-final-run.ps1" mixed -Patches 'sse-narrow-6dd.patch;daemon-r4-three.patch;r5-reviewer.patch'`：八文件组合五端 TCP 绿、租约归零；同组合 `bun --no-install D:/Temp/opencode/r5-rule-types.ts` 八文件局部 TS 0 diagnostics。正式实施从 P 额外运行 `bun test test/permission/reviewer-service.test.ts --timeout 60000` 和包级 typecheck。 |
| 根 | `git apply --check --numstat D:/Temp/opencode/v1-final-6dd.patch D:/Temp/opencode/sse-narrow-6dd.patch D:/Temp/opencode/daemon-r4-three.patch D:/Temp/opencode/r5-reviewer.patch`，实测 +197/−134；仅 dry-run。 |

正式实施用工作树**真实代码**复跑 S1–S4，不将候选 preload 代替验收。以下整文件组合为 CI 的回归范围，本地以 `-t` 选取关键用例（见 §23）。P 中 `bun test test/permission/next.test.ts test/session/tools.test.ts test/session/execute.test.ts --timeout 120000`、`bun test test/session/prompt.test.ts test/server/httpapi-event.test.ts test/session/session.test.ts --timeout 120000`；C 中 `bun test test/event.test.ts test/session-info-selection.test.ts test/session-runner.test.ts --timeout 120000`；T 中 `bun test test/context/sdk-reconnect.test.tsx test/cli/cmd/tui/sync.test.tsx`。P、C、S 各执行 `bun typecheck`。Guard 按用户最新要求由既有线上 CI 自动执行，本地不跑、不适配，也不将其结果计入本地验收。实际部署后方可声称现场三秒超时消失；所有修复及验收同一交付，不因夹具不能重现三秒而拆提交。

## 19. Diff 预算

第一组（proof+SSE）4 个生产文件净 +45；规则+展示 3 个净 +21；实际送审两处窄读额外 1 个净 −3。总计 8 个，隔离候选 **净 +63 行**。正式实施按正常格式计全部 import/注释/空行，硬上限 +200；不以合行或删除无关内容抵账。无新增生产文件、schema、migration 或生成物；连接私有 TEMP 对象不属于持久 schema，初始化工作已纳入首读/写入对照。测试 5 个文件单算。在任务专用的单一变更集中逐项核查 git status、git diff --check、git diff --numstat；不带入当前其他压缩改动。

## 20. 实际代价与待决项

1,000 次 Part 更新七对进程中，安装临时观察后中位 4.23 ms，基线 2.56 ms；这里只换取实际暖读/追加收益，不给审批安排任何跟踪。单 SSE 输入硬界是引用数而非字节，Guard 验 RSS。混合 V1 历史无索引时保留距离成本，首读/重建仍需取得精确内容。无待用户选择的设计项。

Follow-up 仅指**未归因的旧数据**：更早的 1.18 s CPU/814 ms 低 CPU 样本没有和 19:43 同时刻的栈。没有证据据此动 WAL、防病毒软件、压缩中间件。自动 reviewer 两处无用计量已纳入本次修复；与 19:43 实际抓到的规则读取分别验证。文中未承诺其他独立性能治理。

## 21. 审计与单提交约束

以 §1 全部用户消息及固定 HEAD 做独立 full-scope 审计；本轮调查和修订由主代理直接负责。仅 workflow 明确要求的独立验收使用 auditor，不将普通调查反复转派。仅 clean APPROVE 可登记本 revision。实施须八文件同组合通过测试、实际 diff 行数门、完整实现审计；一次 commit 装入四项及必要回归，不先提交子项或以另一个 commit 代修。计划阶段不提交。

## 22. Revision Delta and Plan Audit Record

| Revision | 影响章节与处置 | 范围变化 |
| --- | --- | --- |
| R2 | §4、8、10、15–19：B-01 补真实 TCP 对照并作为 S2 正式 seam；B-02 删除 Part 主键回查及其专属实验断言；更正同毫秒变更的证据归属。 | I1–I5、不变的六个生产文件；删除一项 SQL 查询，零新增生产机制。 |
| R3 | 用户明确扩大范围，§1–§21 纳入 WPR、权限与展示两个落点，执行顺序改为 S3/S4 优先。按 workflow 为完整新需求开新审计，保留 R1/R2 历史。 | 新增 I6/I7、两个权限消费文件、Core 投影与索引生成链；旧 step/SSE 设计保持；预算重算含所有生成物。 |

| R4 | 用户更新约束后全范围重审；§1–21 重写为四项一次交付。撤回 R3 持久索引/生成链、调用方 proof 参数、自定义队列服务和审批的宽行读取。 | 7 个生产文件，I1–I7 全覆盖；I6 明确禁读累计列，I7 使用现有索引按需比较。测试清单 4 个，临时实验不入库。 |

| R5 | 处理 R4 的 B-01；S3 增加经过真实 reviewer 的首建/复用证据和原计量保留检查。 | 只增 reviewer 一个现有生产文件到清单，11 增/14 删，使用已有数据库，无新增接口；其余四项同验收同提交。 |

### Round 1 · R1 · full-scope · ses_df2718509ffeaHs2dG7BCeT3ug

```text
## Blocking findings

**R1：BLOCK。** 两处需要修订：五客户端突发实验还没经过 Daemon 实际使用的网络写出路径；Part 写入路径则为一种未找到生产调用方的 SQL 操作增加了查询。前一项只需补实验，后一项应当做减法。

### B-01 五个 reader 收齐 512 帧的结果来自进程内响应，尚未验证 Daemon 的网络连接

- **Violated invariant:** I3；五个持续读取的客户端应在原连接收齐 512 条 delta，并继续收到下一条。
- **Evidence class:** observed（实验入口与生产入口不同）。
- **Producer and execution path:** 夹具确实经过 mock provider、真实 prompt POST、processor 和 SSE handler。差异在最后一段：五个 reader 从 `Server.Default().app.request()` 直接读取 Web `Response.body`；Daemon 的 TUI 连接经过 `Server.listen()` 和 Node HTTP socket。网络写出遇到背压后会等待 `drain`，这个等待会影响下一次 `pull` 与候选 `setImmediate` 回调的先后顺序。
- **Source evidence:** `D:/Temp/opencode/sse-6dd-provider-drain.test.ts:26,41–43,65–76`；`packages/opencode/src/server/server.ts:62–69,207–222`；`packages/opencode/src/cli/tui/worker.ts:611–615`；Effect `packages/platform-node/src/NodeHttpServer.ts:599–617`。
- **Canonical-plan evidence:** §8-B 将五端收齐列为主要证据；§10.2 以一次 `setImmediate` 后同一批是否已被取走决定断流；§18 的 Guard `stream` 使用有节奏的输出。
- **Responsibility owner:** SSE 传输层，以及 S2 对实际传输路径的验收。
- **Concrete behavioral consequence:** 即使网络写出路径仍会把健康连接判为溢出，当前五端实验也可以全绿。已有网络慢读回归每十条主动让步，回答不了本次“512 块已经同时可读”的问题（`packages/opencode/test/server/httpapi-event.test.ts:363–366`）。
- **Pre-R1 baseline behavior on the same path:** 计划记录的进程内基线分别在 252 或 254 条后结束。相同突发经过真实 listener 时，基线和候选各有多少条原连接存活，R1 未给出。
- **Minimal correction direction:** 复用现有 `NodeHttpServer.layerTest` 或隔离的 loopback `Server.listen`，把同一个 S2 夹具的五条订阅改走网络，对照记录基线与候选的 ID、顺序和同源后续帧；无需启动生产 Daemon、增加日志或改 TUI。

### B-02 Part 写入热路径为同连接的 `INSERT OR REPLACE` 增加了无生产依据的旧归属查询

- **Violated invariant:** I5；每项新增生产逻辑都应服务于可达行为，尤其不能为夹具构造的边界给正常写入加负担。
- **Evidence class:** observed（实际写入语句和原型触发器均可直接检查）。
- **Producer and execution path:** `PartUpdated → SessionProjector → ColdStorage.replacePart` 在主键冲突时执行 `ON CONFLICT DO UPDATE`，只更新正文及冷存字段；冷存批量 upsert 同样保留 `message_id`。真实 UPDATE 的旧父消息已由触发器的 `OLD.message_id` 覆盖。原型还为 Part 插入增加一次按 `NEW.id` 回查旧行的 SQL，专门覆盖 SQLite `REPLACE` 静默删除原行的语义。
- **Source evidence:** `packages/core/src/session/projector.ts:544–568`；`packages/core/src/storage/cold-storage.ts:224–232`；`packages/core/src/storage/cold-store.ts:858–869`。附加查询见 `D:/Temp/opencode/v1-frontier-block.ts:24–32`；直接制造跨父替换的语句见 `D:/Temp/opencode/v1-frontier-bench.ts:27`。独立 CLI 的原始 SQL 使用自己的数据库连接（`packages/opencode/src/cli/cmd/db.ts:899–911`），已属方案的 `data_version` 路径。
- **Canonical-plan evidence:** §10.1 第 2 项明确要求处理“按已有 Part 主键替换时的旧归属”；§14 未给出需要这次额外回查的同连接生产者。
- **Responsibility owner:** `MessageV2.promptWindowProof` 的写入失效设计；现有 projector 和冷存写入器无需改动。
- **Concrete behavioral consequence:** 正常 Part 插入也要执行附加的旧行查询，而已核对的生产写入路径不依赖它判定失效。§8 的千次写入实验测的是 `UPDATE`，不能据此给这项插入开销定价。
- **Pre-R1 baseline behavior on the same path:** 正常 Part upsert 后，下一轮通过重读正文得到正确 key；写入时没有 proof 专用的旧归属回查。
- **Minimal correction direction:** 移除同连接 `REPLACE` 专用回查及对应的原型验收条件，保留真实 INSERT、UPDATE、DELETE 和跨连接提交所需的失效处理；若保留该查询，须指出实际执行这种 SQL 的同连接生产入口。

## Non-blocking findings

§16 将“同毫秒变更”归入既有检查，引用应更准确。固定基线的 4 MiB 测试调用 `promptWindowProof(session.id)` 时没有传旧 proof，也没有固定相同时间戳（`packages/opencode/test/session/prompt.test.ts:7247–7251`，按固定 HEAD）。真正覆盖“持旧 proof、时间戳不变、正文已改”的是隔离差分夹具 `v1-frontier-bench.ts:21–24`。更正证据归属即可。

## Follow-up

现场的 1.18 秒 CPU 停顿和 814 毫秒低 CPU 等待，仍缺同一时刻的调用栈。保留为现场取证项，不作为调整 SQLite 超时、WAL 或压缩策略的理由。

## Rejected speculation

本轮不要求加入 daemon 身份协议、重连抖动、断流弹窗或生产探针。B-01 指出的是**尚未验证的传输路径**；目前不能断言候选在真实 socket 上一定会断。

## Requirement and traceability coverage

I1、I2 的主线有依据：基线在比较公共前缀前已经读取并压缩正文；计划把复用提前，保留原精确 key、窗口顺序和 inclusive suffix。I3、I4 的修复位置也正确：在 SSE 入口区分短时突发和持续积压，保留普通 Core 订阅及真正断线后的恢复。剩余门禁分别是 B-01 的网络验收和 B-02 的额外写入成本。§19 记录的原型生产净增为 **59 行**，正式实现仍以 **净增不超过 200 行**为硬上限。

## Primary-path and fallback verdict

精确 proof 和 SSE 各保留一条主路径；未发现错误后改走另一套成功逻辑。两项修订都不需要增加 fallback、对外接口或下游补偿。

## Release verdict

**BLOCK — `docs/plans/daemon-step-and-event-burst.md`，R1，全范围计划审计。** R1 尚未达到 `approved-plan-only`，不得据此实施。
```

### Round 2 · R2 · full-scope

Invocation reference: ses_df2718509ffeaHs2dG7BCeT3ug

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无新增项。R1 关于“同毫秒更新”的证据归属已更正：4 MiB 测试验证 proof key 可无损解压；持有旧 proof 时修改正文、保持时间戳不变，由独立差分夹具验证（计划 §16）。

## Follow-up

现场的 1.18 秒 CPU 停顿和 814 毫秒低 CPU 等待仍缺同时刻调用栈。下次复现时可用 WPR 与现有追踪对齐；这不影响本次对两个已复现问题的判定。

## Rejected speculation

现场样本不足以把停顿归因于 WAL、Defender 或 loopback 压缩。R2 保留这些路径，也保留真正断线后的完整同步。

## Requirement and traceability coverage

- **B-01 已解决：五条真实 TCP 连接通过突发对照。** S2 使用与 Daemon 相同的 `Server.listen` 入口（`packages/opencode/src/cli/tui/worker.ts:611–615`）。核对逐连接实验记录：基线两轮均在 `[252,254,252,254,252]` 条后 EOF；候选三轮共 **15/15 条原连接**按序收齐 512 个原始事件 ID 和文本，各自又收到一次同源后续帧。验收覆盖了用户看到的断流位置，慢读者隔离仍由单独对照验证。
- **B-02 已解决：移除了 Part 写入时的额外主键回查。** 生产 upsert 冲突时更新正文和冷存字段，保留父消息 ID（`packages/core/src/storage/cold-storage.ts:224–232`）。R2 直接使用写入行的 `OLD`/`NEW` 更新失效范围，已删除仅服务于假设性 `REPLACE` 路径的查询和对应断言。
- **主线程成本有量化验收。** 4,096 条消息的隔离实验中，暖态 proof 耗时中位数从 **49.75 ms 降至 4.85 ms**，尾部追加从 **51.92 ms 降至 4.02 ms**；代价是同事务内 1,000 次 Part 更新从 2.42 ms 增至 4.12 ms。方案仍枚举窗口 ID，省掉的是未变正文的读取和重复压缩（计划 §8-A）。
- **改动预算符合要求。** 隔离原型涉及 6 个已有生产文件，`+153/−99`，净增 **54 行**。正式实现仍须按实际 diff 核验 **≤200 行**，并执行 §18 的包级检查和完整 Guard 对照。

## Primary-path and fallback verdict

两项修复都落在首次出现问题的位置：`promptWindowProof` 在读取正文前判定哪些 key 可以复用；SSE 在结束连接前给已就绪的读者一次取走积压事件的机会。精确 key、事件 ID 与顺序、慢读者隔离和断后恢复均沿用原合同。R2 未增加备用成功路径、TUI 接线或生产诊断接口。

## Release verdict

**APPROVE — `docs/plans/daemon-step-and-event-burst.md`，R2，全范围计划审计通过。** 本结论可登记为 `approved-plan-only`；生产实现及其性能验收属于后续阶段。
```

### Round 3 · R3 · full-scope

Invocation reference: ses_df1f9b3c7ffeK1k66pMGAxhQdz

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。R3 已把权限查询阻塞列为首要修复，并把现场 WPR、隔离实验和实施后的验收分开记录。这样既能解释这次三秒超时，也能独立判断 step 和 SSE 的改动是否有效。

## Follow-up

实施后最重要的一项复测，是在长会话中连续运行四个工具，同时确认**权限读取零次访问历史事件正文，进程外 Health 探针均在 3 秒内读完整个 200 响应**。隔离基线复现了昂贵的 SQL，但基线探针也全部在 3 秒内返回；三次超时来自用户提供的现场记录。计划 §18 保留了这项实机验收。

自动审批 reviewer 在未配置模型时还会读取父会话的模型（`packages/opencode/src/permission/reviewer/service.ts:167–174,344–356`）。这是模型选择，和本次四处权限规则读取用途不同；基线已有，R3 未加重，不扩大本次修改范围。

## Rejected speculation

本次三秒超时已有 SQLite 读溢出页、权限日志和拆分 SQL 相互印证。更早的 1.18 秒和 814 毫秒样本没有同一时刻的调用栈。本轮不据此调整 WAL、杀毒软件、loopback 压缩或 TUI 重连策略。

## Requirement and traceability coverage

| 验收项 | 独立核对结果 |
|---|---|
| **工具权限与 Health（I6）** | `grep` 先在 `packages/opencode/src/tool/grep.ts:80` 请求权限，到 `:130` 才启动搜索。`permission/index.ts:97` 和 `session/tools.ts:168,228,239` 都能沿用 `session/session.ts:523–526` 的 `{ request: false }`，保留逐次读取最新规则的时机。核对隔离记录：四次直接 grep 的权限 SQL 合计从 **590.1 ms 降至 0.2 ms**；一次 Execute 内四次 grep 从 **2,049.8 ms 降至 0.9 ms**。仅改权限读取，18 次授权查询即全部避开事件正文。 |
| **真正需要展示用量的读者（I7）** | `packages/core/src/session/info.ts:62–79` 原先按身份匹配后求 `min(seq)`。R3 用部分索引定位同一会话、同一用户消息，再取最早序号；无匹配仍为 `-1`。28,185 条候选、单命中时，完整展示查询中位数从 **16.483 ms 降至 0.159 ms**。混合会话中，旧 V1 消息的修订仍不能覆盖已提升的 native 请求；现有回归见 `packages/core/test/session-runner.test.ts:4382–4389`。 |
| **step 停顿（I1–I2）** | 基线在比较前缀前已经读出并压缩正文（`packages/opencode/src/session/message-v2.ts:1729–1802`）。R3 把复用判断提前，保留原来的精确 key 和窗口顺序。4,096 条消息的隔离对照中，暖读从 **49.75 ms 降至 4.85 ms**。计划也准确记录了代价：仍需枚举窗口 ID，首次建立仍要读完整窗口。 |
| **SSE 突发与慢读隔离（I3–I4）** | 核对了真实 `Server.listen` 的逐连接记录：基线两轮均在 **252 或 254 条**后 EOF；候选三轮共 **15/15 条原 TCP 连接**按序收齐 512 条，再收到同源后续帧。暂停读取的客户端另行验证，仍会单独结束；真正断线后的 TUI 刷新保持原样（`packages/tui/src/context/sync.tsx:925–933`）。 |
| **改动预算（I5）** | 按 §15、§19 的文件清单核算，隔离原型含索引迁移、生成物及快照，生产净增 **99 行**。正式实施仍须按实际 diff 核验 **≤200 行**，包括未跟踪的新迁移文件。 |

## Primary-path and fallback verdict

四项改动都落在决定成本的位置：授权调用方少取数据，展示查询直接定位首条事件，proof 只重算无法证明未变的正文，SSE 在结束连接前给读者一次取走突发批次的机会。权限判定、计费公式、精确 key 和事件内容各自保留一条权威路径。没有新增备用成功路径、TUI 接线或生产诊断接口。

## Release verdict

**APPROVE — `docs/plans/daemon-step-and-event-burst.md`，R3，全范围计划审计通过。** 固定基线为 `dev1-smark@6dd9a5b1f3`。本结论可登记为 `approved-plan-only`；生产修复及现场性能验收属于实施阶段。
```

### Round 4 · R4 · full-scope

Invocation reference: ses_df16eb826ffea5F9k2hrOMINHB

```text
## Blocking findings

### B-01 自动审批在选择模型、查找审查子会话时，仍会计算用量和费用

**R4 暂不能放行。** 四个规则读取点已经改对了。遗漏的是工具进入自动审查后、模型请求发出前的两次数据库读取。即使四个规则读取点全部通过验收，这两处仍会在 Daemon 主线程上执行用量查询。

- **Violated invariant:** 用户要求“工具的审批，它本来就不应该去读什么 token……和费用”。选择审查模型需要父会话的 `model`；复用审查子会话需要找到对应的会话。两处都不消费请求用量。
- **Evidence class:** `reachable`。这是已有配置和测试覆盖的正常路径：自动规则命中、未命中审批缓存，且预检将请求送审。`strict: true` 时，普通只读工具也能走到这里。
- **Producer and execution path:** `Permission.ask → reviewAuto → PermissionAuto.evaluate → reviewer.review`。① 未显式配置审查模型时，`parentSessionModel` 调用完整的 `session.get(sessionID)`，随后只取 `model`。② 只要请求带会话 ID，`getReviewerSession` 就会调用 `session.children(parentID)`；它先为每个子会话补算 `request`，返回后才用 `.find()` 挑出审查子会话。这第二次读取在显式配置了审查模型时也会发生。
- **Source evidence:** 送审入口见 `packages/core/src/permission/auto.ts:69–76,100–109`；两处读取见 `packages/opencode/src/permission/reviewer/service.ts:167–174,344–356,397–402`；实际查询见 `packages/opencode/src/session/session.ts:523–526,604–621` 和 `packages/core/src/session/info.ts:237–242`。父模型选择已有行为测试：`packages/opencode/test/permission/reviewer-service.test.ts:311–324`。
- **Canonical-plan evidence:** §10 只替换四个规则读取点；§20 明确排除了审查模型选择，未列出子会话查询。§16 的长会话夹具给 `grep` 配置的是 `allow`（`D:/Temp/opencode/perm28-body.ts:22`），因此它能验证现场捕获的规则查询，却不会经过上述两处。
- **Responsibility owner:** 自动审查器负责选择模型、定位自己的审查子会话；会话详情接口继续负责向真正的展示读者提供完整用量。
- **Concrete behavioral consequence:** 已有多个子会话时，一次自动审批仍可在模型请求发出前触发一次父会话用量查询，以及每个子会话各一次用量查询。R4 的详情 SQL 能降低其中部分成本，但这些结果在审批中仍被丢弃。
- **Pre-R1 baseline behavior on the same path:** 基线也执行这两类查询。它们不是 R4 引入的回归；阻断理由是用户在本轮明确要求移除审批不消费的计量读取。这也不是对现场三次超时的重新归因。
- **Round basis:** `strict class`：用户明确要求的审批场景仍会读取并计算用量。
- **Minimal correction direction:** 让审查器按实际需要读取父模型和已有审查子会话，并用一次真正进入 reviewer 的工具审批核对这两处 SQL；保持模型选择、审查证据和计费写入原样。

## Non-blocking findings

公开会话详情需要保留完整返回值。已有测试直接断言无参数选项的 `session.get(id)` 返回 `request`、累计 `tokens` 和 `cost`（`packages/opencode/test/session/session.test.ts:207–218`）。用户要的“默认不读”应落实到**审批使用的读取路径**，不能让详情读者拿到空值。

## Follow-up

现场三个 3 秒超时仍应在部署后用同一长会话复测。隔离记录中，四次直接 `grep` 的 Health 最大耗时为 **113.7 ms**，一个 Execute 内四次 `grep` 为 **54.7 ms**；隔离基线本身也未超过 3 秒。这组数据验证了规则查询的成本下降，生产端结果仍待实测。

## Rejected speculation

此项修订不需要改冷存储、持久 schema、HTTP 路由、TUI 重连或压缩策略，也不需要给 Daemon 加探针或弹窗。现有隔离 SQL 追踪足以检验 B-01。

## Requirement and traceability coverage

| 项目 | 审计结果 |
|---|---|
| 现场权限热点 | 普通 `grep` 的 4 次、Execute 的 14 次规则读取均已缩到 `agent, permission`。两组权限 SQL 合计分别从 **590.1 ms 降至 0.149 ms**、从 **2,049.8 ms 降至 0.618 ms**。自动审查分支仍缺 B-01。 |
| 用量展示 | 纯 V1、28,185 条候选事件的单命中样本中，完整详情查询 p50 从 **17.56 ms 降至 0.30 ms**；混合会话继续按原顺序选取请求。 |
| Step 停顿 | 方案在读取正文前判断哪些精确键可以复用；验收分别覆盖暖读、尾部追加和必须全量重建的情形。 |
| SSE 断流 | 真实 TCP 对照覆盖三条 global、两条 instance 连接。候选五端均按序收到 **512 个原始事件及后续帧**；慢读者另做隔离验证。 |
| 改动预算 | 独立核对三个候选补丁：**7 个生产文件，+186/−120，净增 66 行**。计划保留一次提交，未引入持久迁移或数据库生成物。 |

## Primary-path and fallback verdict

规则判定、请求用量、历史证明和 SSE 各自保留了一条主路径。B-01 的修正也是减法：去掉审查器定位数据时顺带执行的计量，不改变允许、拒绝或转人工的条件。

## Release verdict

**BLOCK — `docs/plans/daemon-step-and-event-burst.md`，R4，基线 `6dd9a5b1f3`。** 放行还差一项：让真实自动审批在选父模型、找审查子会话时都跳过用量查询，并将这条路径纳入同一计划、同一次验收。
```

### Round 5 · R5 · full-scope

Invocation reference: ses_df16eb826ffea5F9k2hrOMINHB

```text
## Blocking findings

**模型发送前的 token 估算应该保留。R4 指出的问题是：工具还在做权限检查，只想读规则、选审查模型或找审查子会话，SQLite 却顺带算了历史请求的 token 和费用。** 现场测到的 1.17 秒发生在第一种情况：`grep` 已调用 `ctx.ask()`，还没启动搜索。自动审查器里的另外两处是同类多读，不能把现场的 1.17 秒也归到它们头上。

R5 已解决 R4 的技术阻塞。还剩一项范围冲突。

### B-02 第二批实际修改 4 个生产文件，超过“不到 4 个”的要求

- **Violated invariant:** 用户给第二批“权限检查、同步调用”定的上限是“不到 4 个文件”；同批还明确包含真正展示用量时的查询优化。
- **Evidence class:** `contracted`。
- **Producer and execution path:** 普通工具查规则、Execute 子工具重新准入、自动审查器准备请求，分别落在三个生产文件；展示用量的查询另在 `packages/core/src/session/info.ts:62–79`。
- **Source evidence:** `packages/opencode/src/permission/index.ts:91–106`、`packages/opencode/src/session/tools.ts:166–175,227–249`、`packages/opencode/src/permission/reviewer/service.ts:344–356,397–405`。候选补丁的 `git apply --numstat` 确认四个文件都有实际改动。
- **Canonical-plan evidence:** `docs/plans/daemon-step-and-event-burst.md:120` 保留了原上限；`:251–254` 列出第二批四个文件；`:294` 将它们记为“规则+展示 3 个”另加“实际送审 1 个”。
- **Responsibility owner:** 计划的变更范围。审查器的两处查询确实归它自己负责。
- **Concrete behavioral consequence:** 直接批准 R5，就会授权第一批 4 个、第二批 4 个，共 8 个生产文件。生产代码净增 **63 行**，满足 200 行预算，但文件上限是另一项要求。
- **Pre-R1 baseline behavior on the same path:** 基线的四处都存在多余读取或计算；R4 保持第二批 3 个文件时，漏了自动审查准备。直接撤回第 4 个文件会重开 B-01。
- **Round basis:** `introduced by delta`。R5 加入审查器文件，技术问题随之解决，文件数从 3 变为 4。
- **Minimal correction direction:** 建议明确确认第二批可改这 **4 个已有文件**；审查器补正本身只需 **新增 11 行、删除 14 行**，不值得为少算一个文件再加转接层。

## Non-blocking findings

R5 保留的计量各有实际用途。固定基线 `packages/opencode/src/session/processor.ts:1239–1255` 用**本次准备发送的请求体**估算输入，再判断是否需要压缩上下文。自动审查器走单独的发送路径：它为 `/context` 记录输入组成，模型返回后再按 provider 的实际 usage 结算（`packages/opencode/src/permission/reviewer/service.ts:596–616,914–942`）。这两段都应保留。

## Follow-up

长会话四工具的隔离对照已经验证权限查询跳过历史事件正文。原机器上三次超过 3 秒的 Health 超时是否消失，仍以部署后的同场景复测为准。

## Rejected speculation

本轮无需修改模型窗口判断、计费公式、冷存储、数据库迁移或 TUI 重连接线。

## Requirement and traceability coverage

- **普通工具和 Execute：** 每次只查当前 `agent, permission`，保留中途撤权。四次直接 `grep` 的权限 SQL 合计从 **590.1 ms 降至 0.149 ms**；Execute 内四次从 **2,049.8 ms 降至 0.618 ms**。
- **实际送审：** 隐式选模型只查 `model`；找审查子会话只查 `id, directory`。同一父会话连续送审两次，验证了首次创建和再次复用，也保留了模型返回后的用量记录。**R4 的 B-01 已解决。**
- **其余修复：** 详情查询保留用量语义；step 复用未变历史的精确校验键；五条真实 TCP 连接能在原连接按序收齐 512 帧及后续帧。四项仍按一次提交规划。

## Primary-path and fallback verdict

R5 直接缩窄了读取字段。规则判定、模型选择、审查子会话复用、上下文窗口判断和实际计费继续走原有路径；本轮没有新增备用逻辑。

## Release verdict

**BLOCK — `docs/plans/daemon-step-and-event-burst.md`，R5。** 技术修复已覆盖；唯一待决项是第二批能否从最多 3 个生产文件放宽到 4 个。建议接受这一个文件的差额，保持两处查询直接、改动净减 3 行。
```

### Round 5 · R5 · 用户授权后的复议（原 verdict 保留）

Invocation reference: ses_df16eb826ffea5F9k2hrOMINHB

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

**B-02 已撤销。** 我核对了 `docs/plans/daemon-step-and-event-burst.md:145–151`：用户已明确授权第二批使用第 4 个生产文件。R5 的技术设计不变，无需升版。登记本次结论时，将 `:17` 和 `:562` 残留的 `approved-plan-only` 表述同步为当前目标 `verified-implementation-and-commit` 即可。

## Follow-up

重叠改动已保存在 `stash@{0}`（`fd3ea3b1e5`）。当前 `dev1-smark` 工作区只显示未跟踪的计划文件，**无需再次 stash**。

## Rejected speculation

本次授权只解决文件数量限制，不需要扩大修复范围或重做已完成的计划实验。

## Requirement and traceability coverage

R5 保持一次提交、8 个已有生产文件；候选净增 **63 行**，低于 200 行上限。第 8 个文件只收窄自动审查器的两处查询，新增 11 行、删除 14 行。权限检查跳过历史用量读取，模型发送前的窗口估算和返回后的实际计费均保留。

## Primary-path and fallback verdict

审批规则、审查模型选择、会话详情、step 历史校验和 SSE 继续沿用各自的主路径；本次复议未引入备用逻辑。

## Release verdict

**APPROVE — `docs/plans/daemon-step-and-event-burst.md`，R5 计划放行。** 可登记 `Approved revision: R5` 并进入实施。最终的 `verified-implementation-and-commit` 以实际 diff、验证结果、实现审计和一次修复提交为准。
```

## 23. Implementation Evidence

当前工作树相对固定基线：§15 的八个生产文件 +180/−136，净增 44 行；测试写入限于五个既有文件。§8 是隔离候选实测；以下是工作树结果。门禁反馈后移除了跨连接模块表、裸定时器、重复的空值转换和已证明非空时的判断；保留真实缺失会话、旧模型回退和持续背压的既有行为。数据库句柄与订阅 scope 分别拥有自己的临时状态。

- S3：普通规则新增用例在旧路径捕获包含累计列的查询，窄读后通过。strict reviewer 两轮送审的旧路径包含用量投影，改后通过且复用同一子会话。审批、Execute 和 tools 共 197 项通过，reviewer 30 项通过。
- S4：向同一会话追加 28,185 条修订，旧实现公开详情中位 15.37 ms（该次上界 11.06 ms）；新实现相同用例通过。
- S1：2,048-turn 夹具的旧暖读中位 71.96 ms，超过同组冷读一半（41.28 ms）；工作树同一用例通过，保留原 provider 前缀检查。
- S2：真实 TCP 三 global、两 instance 与同源就绪标记均到达；旧路径在 512 帧突发中停止交付。修复后相同用例 2,577 次断言通过，包括每条原连接的有序 ID、payload 和后续标记。
- Core event/selection/runner 154 项通过；TUI reconnect/sync 57 项通过。opencode、core、server 包各自 `bun typecheck` 通过。`git diff --check` 通过。
- 用户更正前的一次本地 Guard 在采样时因缺少 `ps` 退出，未产生对照结论。按用户要求停止，未改 Guard。线上结果不在本地报告中推定。

### 最终工作树专项验收

以下命令均从对应包运行；`$t` 为 `D:/Temp/opencode`。临时脚本只构造测试输入或加载基线用于对照，所有被测生产模块均来自工作树，未使用生产补丁 preload。

| 路径 | 命令及结果 |
|---|---|
| S3 权限与 Health（P） | `& "$t/r5-live-health.ps1" direct` / `execute`。两个独立文件库各含 28,185 条会话历史候选和 28,185 个溢出页。四个直接 grep/一个 Execute 内四个 grep 各有四个完成回执；实际规则查询 4/14 次，SQL 均为 `select "agent", "permission" from "session" where "session"."id" = ?`。外部重叠 Health 样本 22/19，完整 200，p95 137.293/66.344 ms，max 145.132/66.344 ms，超时 0/0。|
| S3 授权语义（P） | `bun test test/permission/next.test.ts test/session/execute.test.ts test/permission/reviewer-service.test.ts -t 'rule matching reads session rules without usage\|native scalar shortcuts keep canonical object inputs and current permissions\|strict review selects its model\|missing session preserves caller rules' --timeout 30000`，四个定向用例通过，包括真实撤权和父会话两次送审。 |
| S4 详情（C） | `bun --no-install D:/Temp/opencode/r5-live-measures.ts detail`。同一数据、交替 41 次，完整 SELECT 与 request 解码 p50/p95（ms）：纯 V1 单命中 19.47/29.65 → 0.50/1.98，多修订 41.63/63.12 → 0.46/1.02；有更早的竞争者且需沿历史求证时为 27.85/51.06 → 27.64/50.92，winner 一致。13 个公开生命周期断言和 Core/V1/TUI 映射一致。首次使用同步 Drizzle `.get()` 的计时包含每次 `.prepare()`，多修订 48.13 → 35.62 ms，未达到 SQL 执行门槛；改用两臂各自真实已准备 SQL，符合 §8/§16 及 Daemon 驱动 `native.query` 的复用方式。没有为实验改生产 SQL。 |
| S1 历史（P） | `bun --no-install D:/Temp/opencode/r5-live-measures.ts proof`：4,096 行，七轮中位 warm wall/gap 0.78/0.78 ms，append 7.27/7.27 ms。冷读 76.62 ms，重建中位 72.63 ms；1,000 次受观察写 5.29 ms，同轮未观察写 6.73 ms。与原实现逐项比较全部 key、同毫秒替换及外部提交，旧 proof 不被改写。`bun test test/session/prompt.test.ts -t 'pure V1 detail ignores revisions\|reuses a 2048-turn prefix before Provider dispatch\|prompt window proof keys do not retain a second copy' --timeout 120000`：3 pass，160 filtered。 |
| S2 传输（P） | `bun test test/server/httpapi-event.test.ts -t 'five TCP readers\|terminates an overflowing slow client' --timeout 60000`：2 pass，2,580 次断言。另以 `SSE_CASE=watcher/slow-native/compat` 分别运行 `bun test D:/Temp/opencode/sse-narrow-tcp.test.ts -t 'exact SSE frames on original TCP sockets' --timeout 60000`：三个具名负载通过。2,048 watcher 帧五端原流完整；native 快端获 896 帧及尾标，暂停端在 284 帧 EOF；512 个兼容投影逐帧有序。各组结束租约回到 0。 |

类型检查：改为订阅 scope 调度时首次 `Effect.andThen` 的同步回调类型错误，换为 `Effect.map` 后 P/S 各自 `bun typecheck` exit 0，两个 SSE 回归重新通过；C typecheck exit 0。用户发来的四项机械错误已处理（修改工具的单文件规则检查 0 错误）。全量 Prompt/组合套件曾超出 shell 时限、重试被中止，不计通过；按最新要求重型套件和 Guard 由现有 CI 自动执行，未修改 CI 或触发远端作业。未部署到生产 PID，当前结论仅覆盖隔离长会话和真实 TCP 工作负载。

实际路径归类：最新规则读取、两处送审定位、公开用量投影、step proof、三个 SSE 入口均在原主路径；旧会话无模型的既有回退、缺失会话的原授权处理及真慢客户端的断流保持原合同。新增替代成功路径 0，产品诊断 0。Follow-up 仍仅为 §20 未归因的两次旧现场样本。

## 24. Implementation Audit Record

### Round 1 · R5 · full-scope · ses_df11ab426ffe4zPDRjRbLA0QPV

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

会话详情的性能数字应保留测量口径：纯 V1 单命中场景的 p50 从 **19.47 ms 降到 0.50 ms**，测的是已准备语句的执行与 `request` 解码。Daemon 的 Bun 驱动使用 `native.query` 复用语句；首次编译和语句被逐出缓存后的开销应单列。§23 已分别记录，无需修改生产代码。见 `packages/core/src/database/sqlite.bun.ts:59`、`docs/plans/daemon-step-and-event-burst.md:617`。

## Follow-up

保留 §20 的两项未归因现场样本：1.18 秒的 CPU 停顿和 814 ms 的低 CPU 等待。部署后在原机器用同一长会话连续触发四个工具，复核进程外 Health 能否在 3 秒内读完响应。当前结果覆盖隔离工作负载；生产 PID 尚未复测。

## Rejected speculation

本次证据不支持修改 WAL、防病毒配置、冷存储、HTTP 压缩或 TUI 重连。模型发送前的窗口估算和模型返回后的真实计费各有消费者，保留原行为。见 `packages/opencode/src/session/processor.ts:1239`、`packages/opencode/src/permission/reviewer/service.ts:913`。

## Requirement and traceability coverage

| 路径 | 实际 diff 与验收 |
|---|---|
| 普通工具、Execute 和自动审批 | `permission/index.ts:77` 只选 `agent, permission`；`session/tools.ts:168,228,239` 保留原有重读时机和中途撤权。审查器在 `permission/reviewer/service.ts:349,396` 分别只读父模型和审查子会话的 `id, directory`，复用仍在同一把锁内。含 28,185 条历史候选的工作树验收中，四次直接 grep 和 Execute 内四次 grep 均完成；两组 Health 最大耗时分别为 **145.132 ms、66.344 ms**，超时均为零。 |
| 会话详情和费用展示 | `packages/core/src/session/info.ts:62–86` 先判断有无竞争者，仅在请求顺序影响结果时查 V1 事件。13 个生命周期状态覆盖迟到修订、native 提升、活跃压缩及无历史事件的旧会话；公开请求身份、token 和费用与基线一致。 |
| 模型 step 历史 | `packages/opencode/src/session/message-v2.ts:1715–1801` 用连接私有的写入记录判断哪些精确键可复用，调用方仍按持久顺序比较前缀。4,096 行夹具暖读中位 **0.78 ms**，正常尾部追加 **7.27 ms**；同毫秒改写、外部提交和原有 provider 输入均有对照。 |
| SSE 突发和慢读者 | `packages/server/src/handlers/event.ts:14–38` 的有界入队策略由 native、instance 和 global 入口共用。`packages/opencode/test/server/httpapi-event.test.ts:405–463` 逐条比较源事件：三条 global、两条 instance 原连接收齐 **512 个 delta 及后续标记**。慢读对照中，健康端收齐 896 帧和尾标，暂停端独立退出。 |

## Primary-path and fallback verdict

四项修复都落在首次产生多余工作或误断流的位置：授权不再取完整会话详情，展示不再无条件求历史最小序号，step 不再重编码已证明未变的前缀，SSE 不再在读者尚未获得调度机会时因第 257 帧立即断流。既有缺失会话处理、旧会话模型选择和真实断线恢复保持原合同；未新增备用成功路径。

## Code quality verdict

实际变更为 **8 个已有生产文件，+180/−136，净增 44 行**；另有 5 个已有测试文件和唯一计划文件。没有持久 schema、迁移、生成物或对外 API 改动。`git diff --check` 通过。§23 记录了三个包的 `bun typecheck` 和具名回归结果；重型整文件回归与 Guard 按用户授权留给 CI，本轮不将其列为本地通过项。

## Release verdict

**APPROVE** — `docs/plans/daemon-step-and-event-burst.md` **R5**，实现审计第 1 轮，全范围。放行仅适用于相对固定基线 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42` 的本次实际 diff。主代理可原样登记 verdict、将计划状态更新为 `verified`，再按授权单次提交。
```
