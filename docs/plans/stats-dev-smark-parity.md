# Canonical Implementation Plan: Stats 完整回迁

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 用户提供的 ses_e538505abffewhN5IDfU8GWvay 会话、当前会话原文及下列确认
>
> Target terminal state: verified-implementation-and-commit
>
> Implementation allowed: no further material changes without revision
>
> Last updated: 2026-11-06

本文件是唯一实施规格；聊天摘要、旧报告和临时实验不是实施授权。R1 经第 2 轮 full-scope implementation audit 获得 `No blocking findings` / `APPROVE`；全部必需验证与中文注释门禁已通过，状态为 verified。下一步仅按用户授权提交本 GOAL 文件，不 push。共享工作区的其他任务不属于本范围。

## 1. Verbatim Requirement

用户原始要求：

> 出现了较大的特性的一个回退和功能回退等等的问题，所以目前而言主要的集中在，其中一个点集中在如下 STAT 这个完整的逻辑内容，它出现了大量的丢失。那你可以看一下我们的历史的这个 DEV、SMARK 那个分支呢，里面去包含了很多这一些各种样的逻辑，而且前前后后经过了好几个 commit 进行一个修改，但是现在它直接退化成为一个空白，就是这种纯文本的这种，没有任何颜色的，没有任何对齐的等等一些逻辑。按理来说我们整套 STATS，所有的排布、信息、数据等等的各种内容，包括所有的全部的样式，都应该去和 DEV、SMARK 去做对齐，当前它所有信息都丢失了，所以这个东西是完全有问题的。也就是说所有的细节内容都应该去做对齐，包括任何的排布、线条、组成等等东西，都不得出现任何的这个不一致的这个情况，所以你去检查一下 Read Only，然后自己去检查，不要去使用 Task，保持高效，不要做无意义的一些检查审计。
>
> 换言之，我们当时的需求就是让它去完全地重放现在patch，重放的含义就是完全地复刻，一点都不要变那种。

用户后续要求：

> 然后你需要全面完整去检查，看一看到底缺了哪些各种各样的一些东西，对齐需要修改几个文件，大概需要修改多少行，测试要连着怎么改，怎么的，你都需要去准确高效地去给出。
>
> 不要花大量的精力在这里无意义地去数数。我再说一遍，请注意这一点。然后完整汇报
>
> 按照 Workflow 进行完整的 Plan 的构建以及相应的审计。请注意一点，最终的实际体验必须要求和相应的 DEV、SMRK 那条分支的一致。你不要去搞什么不同的间距啊，或者说什么什么的一些东西，除非旧的逻辑中有一些内容不合适。注意不合适指的是可能它有一些这个间距设计得不好，但你可以提出更好的，但是你不得让信息量还有这个渲染的这个什么这个各种逻辑的一个质量去发生任何下降。当然，比如说旧的内容中可能最下方有一个 Insight 那个小表格，那个表格如果它的配色它可能选择不好，你当然也可以去使用更好的一套逻辑。但是你不要试图丢失有用的信息量，还有这种优秀的排布结构。然后同时呢，这些内容需要被有效地去复现出来。请注意这点。按照 workflow 的逻辑，你应该先去进行完整的 plan 的构建以及完整的验证。请注意这点，验证。验证本身可能就需要你适度地去实现一部分逻辑。但你要按照workflow来走。

当前会话补充要求：

> 当前我已经把你换到了对应的工作区,你开始工作。
>
> 注意相关内容你也要自己去适当地去测试以及去实现，实现以及去测试，以避免你只是在纸上去说，并不可实施。
>
> 具体的逻辑内容呢，按照我的理解，可以以如下的形式去进行验收，去构建一个较小体量的一个数据库，然后让完整的这个逻辑去进行展示 STATS，要求旧版的这个结果呢和新版的结果完全一致。当然你说的这个零流量这个东西，你适当去，这个东西我当然不做影响，但是你可以去把这个相应的一个小一点的，就是非常小的，比如说就可能几 KB 的这种数据库，你让相应的旧版本的 STATS，你让它跑一个结果，跑完结果之后呢，但是请注意，跑的结果你不能去直接使用 exe 去调用，巴拉巴拉的。你应该去使用它的这个代码去跑，然后避免它形成这个 daemon，导致和我们现有的 daemon 发生冲突。然后跑一个结果出来，然后你结合着正确的一个结果，你把那个对应的结果去修改一下。然后所有的完整的内容必须精准地复刻对应的排版、对应的数字、对应的颜色等等内容，都应该去复刻。当然这个颜色，如果你新改这个格式的颜色，你使用了更好的配色，那你当然也可以去把 Test 的这个最终验收的内容改成这个新的配色。但是请注意这一点，一定要是完整的复刻级别的这种验收，不能够发生任何的这种偏移。
>
> 注意文档的修订，你不要一次写很多，或者说一口气全部写完，这是不现实的。因为你本身在十分钟的时候会触发中断，所以你如果需要去写很长，你可以一大段一大段地写，比如一次性写一百行，或者说一次性写几百行，等等这样。

Workflow 以 `docs/workflow.md` 和用户粘贴的 GOAL 合同为依据；目标终态按用户合同的 `verified-implementation-and-commit` 执行。先独立审计 exact revision，批准前不实施。只允许 `adversarial-auditor` 用于独立审计，不使用 Task 探索或委派实施。不 push、不 amend、不跳过 hook。

本轮已确认的测试边界，问题原文：

> 计划用三个现有公开边界锁定复刻效果：`render*()` 完整文本和 ANSI 输出、`StatsCommand` 命令及 TTY 交互、`aggregateStats()` 数据报告。这样分别覆盖视觉、实际入口和统计口径，不测试私有函数内部调用；是否确认？

用户回答：`确认三个公开边界（推荐）`。

本轮已确认的数据例外，问题原文：

> 真实函数对照发现：已有 10 Token、$0.125 的旧消息后，再增加零用量 noReply 请求，dev-smark 会漏掉这笔历史，DEV1 会保留。建议视觉、布局、信息字段完全复刻旧版，同时保留 DEV1 的历史去重补计，取消另一个会导致 Header 与逐日总量不一致的 Session 累计覆盖。是否采用这个数据边界？

用户回答：`保留历史并统一汇总（推荐）`。这是数据数值可偏离旧缺陷的唯一已批准例外；不授权其他视觉或业务变更。

实施阶段用户补充的代码组织约束（原文；用户明确不视为实质设计变更，R1 行为规格不变）：

> 请注意一点呢，你的这个颜色呀，还有什么宽度啊等等各种各样的一些信息，我建议你把相应的内容不要直接硬编码。你把它设在前面，变成常量的形式去进行调用，或者说你把它变成，反正你把它变成常量的形式，避免直接在正文中，或者说正式逻辑中直接硬编码部分逻辑，请注意这一点。
>
> 注意保持良好代码的可读性。
> 请注意一点，这本身的内容只是对实施的约束而不是对计划的实质性修改。

颜色字节集中在已有 palette；尺寸、阈值、间距等设计取值使用具名常量；不改变原值或计算，不引入配置/API。正常格式化代码，禁止用压缩排版取代可读性。该记录仅补齐原文和实施约束，不更改批准路线或审批元数据。

实施阶段用户补充的复用和规模约束（当前会话原文）：

> 请注意一点，相应的逻辑流程应当保持较好的扩展性、泛化性。你不要把它做得相应的内容之后很难去复用，巴拉巴拉的。我们之前你直接抄代码，换言之，我们旧的逻辑，旧的分支中已经有完整的代码了，那很多代码你都可以直接抄，抄代码你应该是会的。你不要把每一个函数都做成一个特化的一个东西，那本身应该有公共的绘图的一个逻辑，还有这个具体的，到每一个图的一个具体的逻辑。那本身你不应该，就是很多逻辑它是可以去复用的。你不要让一个一套逻辑写成几千行巴拉巴拉的代码，这本身是不必要的，或者 avoidable 的一些东西。或者换言之，一个代码可能本身你就不必要去增加这么多。再换言之，原来是多少行？你最好不要比他多或者多太多

该约束沿用 R1 的唯一源引擎/页面组合路线，不引入新框架。实际复用 Charts 的画布、panel、坐标、列布局和分析表，删除无消费者的 Gallery 图元；不复制一套每图特化引擎。源 Charts/Render/Insights 为 996/1988/437 行，报告实际规模时区分必要代码、正常格式化和 Workflow 要求的解释注释，不以压缩排版或删信息满足规模偏好。

## 2. Explicit Non-Goals

- 不重设计图表、配色、标题、间距、分桶、默认行数或页面职责；本 revision 不提出任何新的配色。
- 不升级/降级依赖，不迁移数据库，不改变 Schema/Protocol/HttpApi，不生成 Client/SDK。
- 不退回 1.15 存储：保留 1.19 原生消息、同 ID 去重、冷热统计投影、只读和失败传播。
- 不运行安装的 opencode exe，不进入 `src/index.ts` 的产品启动链，不启动、停止或连接用户 daemon，不读写真实业务数据库。
- 不修改当前未提交的 TUI 工作，不处理其他迁移问题，不做全仓扫描或无意义精确行数统计。
- 不把“Canvas 在目标已经不存在”或简化测试通过作为偏差许可，不保留两套生产渲染器作为 fallback。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | Bun、最小内聚修改、禁止 import alias/star、package-local test/typecheck、保留无关修改 |
| `packages/opencode/AGENTS.md` | Effect 服务和模块形态；数据库属于 Core；不增 CLI 私有存储规则 |
| `packages/opencode/test/AGENTS.md` | 真实实现、Effect 测试与临时数据库、scope 释放、通过就绪信号协调异步 |
| `CONTEXT.md` | 持久 Session/Provider Turn/历史等既有词汇；没有 Stats 专属新领域或 ADR 需求 |
| `docs/adr/README.md`、`0001-triage-labels-and-team-assignment-coexist.md` | 唯一 ADR 为 issue triage，与本次统计无直接行为约束；不新建 ADR |
| `.opencode/policy/first-principles-engineering.md`、canonical template | primary-path、双向映射、计划验证、独立审计、中文注释门禁 |
| `docs/workflow.md` | 分阶段审批、TDD、实现审计和提交边界 |
| package `package.json`、`bunfig.toml`、`tsconfig.json` | Bun 1.4.4 可用；测试已有隔离 preload；`bun typecheck`；现有终端测试依赖 |

## 4. Files and Evidence Read

固定源码基线：`dev-smark@26061b595b3140d37717248222c7ed2016421db0`。目标工作区：`dev1-smark@321a3ffedd`，Stats 工作树无本地修改。源 Stats 最后相关修订包含 `da7d9d8e37`、`5640234ea7` 和存储适配 `9a60ac0f1f`；使用最终树，不只选择其中一次提交。

源路径 `src/cli/cmd/stats/{charts,render,insights,data}.ts` 对应目标 `src/cli/cmd/stats-{charts,render,insights,data}.ts`。下文未特别说明的路径均相对 `packages/opencode`。

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 两支四个 Stats 模块、`src/cli/cmd/stats.ts`、`src/cli/format.ts` | 报告接口、数据来源、命令和所有公开渲染出口 | observed |
| 两支 `test/cli/stats-render-width.test.ts`；当前另五个 `stats-*.test.ts` | 源视觉契约、现有原生/历史/小金额/背景色保障 | observed |
| `src/index.ts` 引用和包内 Stats 全部调用点 | 产品命令入口；无其他应用的 Stats renderer 消费者 | reachable |
| `src/cli/effect-cmd.ts`、`src/cli/cmd/cmd.ts`、`src/effect/app-runtime.ts` | 源码级 command handler 可执行，无需产品/daemon 启动入口 | reachable |
| `test/lib/effect.ts`、`test/preload.ts`、`test/lib/cli-process.ts` | 复用测试环境；本任务不使用其产品入口子进程作为验收 | observed |
| `test/cli/help/help-snapshots.test.ts` 及快照、`test/cli/smokes/read-only.test.ts` | Stats 命令帮助被既有快照消费；只更新 Stats 快照段 | reachable |
| Core `database/database.ts`、`database/path.ts`、Session/Project/Request SQL、`session/request-usage.ts` | 同连接适配、持久身份、微美元、只读查询、零流量真实生产者 | observed |
| `src/session/session.ts`、`test/storage/cold.test.ts` Stats 用例、`cold-v3.test.ts` 测试清单 | 1.19 原生/冷投影、故障不伪造成功，避免误覆盖存储适配 | observed |
| `packages/web/src/content/docs/{cli.mdx,zh-cn/cli.mdx}` 的 Stats 段 | 文档与 canonical 命令职责一致 | observed |
| `D:/Temp/opencode/stats-parity-probe.ts`、`stats-db-probe.ts`、`stats-source-suite.test.ts` 的执行结果 | 已实际运行的 red loop 和候选可实施性证据，详见第 18 节 | observed |

## 5. Current Behavior

```text
StatsCommand 的 yargs 参数 / 交互按键
  -> loadReport -> aggregateStats(StatsFilter)
  -> Database.Service: Session / Project / Message / Part / RequestUsage / AssistantUsage
  -> loadStatsRows: 只读 scalar snapshot + Native SessionMessage + ColdStorage inspect
  -> aggregateSession: request shell / assistant usage / 未入账历史 / ToolPart owner
  -> StatsReport: total / daily / groups / series / sessions / toolCalls / requestsByHour
  -> renderDashboard / renderBreakdown / renderTimeline / renderSessions / renderInsights
  -> 图表、布局和 ANSI -> console.log 或交互 stdout.write
```

渲染完全消费报告，不额外查询数据库。唯一存储适配 owner 为 Data，唯一图元 owner 为 Charts，页面组合在 Render/Insights，参数归一化及交互生命周期在 `stats.ts`。

当前 `stats-charts.ts:195` 把二维折线替换为逐点字符条；`stats-render.ts:493` 缺少主图、共享 header/panel 和 empty 短路；`stats-insights.ts:558` 使用未传 color 的旧 panel，实测 `never` 泄漏 ANSI。七维 Breakdown 和 Sessions 缺少图形/分析字段/主体配色。宽度在 Charts 被限至 120，长标签仍会截断。

`stats.ts:443-507` 仍保留源最终版已归一化或退役的独立 Gallery、Costs、Tokens、Heatmap、Forecast 页面；`:599-611` 的交互页集合为七页，源为五页。Queue、按键分片、范围懒加载、缓存、race 和 acquire/release 已存在，不另造状态机。

`stats-data.ts:1406-1410` 在 all-time 无维度过滤时用 Session 累计覆盖已算出的事件总量，导致 Header/Sessions 与 daily/groups 不同源。当前混合历史去重补入 `:1159-1189` 则保留了旧版遗漏的真实用量，按用户确认保留。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 五个页面、七个 Breakdown、cost/token、显式 heatmap/forecast | CLI builders / 交互 views | yargs 枚举与端点参数校验 | command -> report -> renderer | Command / Render / Insights | contracted |
| 默认 60 日、today、显式天数、all-time、项目及维度过滤 | CLI / interactiveRanges | 非负整数，all-time 优先 | loadReport -> aggregateStats | Command / Data | observed |
| 数据库为空、严格筛选为空、仅工具、无正费用 | 持久 rows / filters | 报告字段完整；Session 数不等于 usage | aggregateStats -> hasUsage / cost branches | Data / 页面 | observed |
| 多模型、secondary assistant、四种 request outcome、未归属 usage | request / assistant / tool rows | 身份通过精确 ID join，不猜测 owner | aggregateSession -> 所有透视 | Data | observed |
| legacy、新原生、同 ID 副本、hot / v1 / packed cold | 两代 writer / 迁移数据 | ColdStorage 验证投影，Native decoder 保证消息形态 | loadStatsRows -> scalar snapshot | 既有 Data/Core adapter | observed |
| 中文、长模型名、完整项目路径、持久标签控制序列 | Session/Project/Provider/Tool 身份 | 数据库字符串不是受信 ANSI | terminalText -> 受信样式 -> panel | Charts / 页面输出 seam | observed |
| TTY/non-TTY、auto/always/never、NO_COLOR、40 至 160 列 | 真实 stdio / flags | explicit color 胜于环境；auto 尊重 TTY 和 truthy NO_COLOR | charts.useColor -> 所有片段 | Charts | observed |
| n/Tab/箭头、p、r/R、q/Esc/Ctrl-C、EOF | stdin data/end/error | 原循环拥有顺序与 finalizer | Queue -> view/range -> renderer -> release | Command | reachable |
| 任意破损 JSON、网络模型失败、未来图表插件 | 没有本次改动的独立上游入口 | 已有 decoder/服务处理 | 无新增路径 | Not applicable | speculative |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 同一报告、宽度、颜色模式和选项的整页输出与固定源基线逐字一致，包含空格、换行、线条和 SGR；本 revision 无视觉例外 | 用户复刻原文；224 次 red 与候选 green | 源 width 的 48 项；新增整页 oracle |
| INV-02 | Dashboard 的主图、activity、四组件、健康趋势、模型/Provider、Sessions、Insights 全部恢复，响应式阈值与留白不改 | 源 render.ts:895-1442 | 源 Dashboard / calendar / hourly / distribution 测试 |
| INV-03 | 七维 Breakdown、Timeline、Sessions、Insights/Forecast 的字段、分母、顺序、布局、身份色与状态色完整 | 源 render.ts:271-894,1445-1988；insights.ts | 源各维度、完整字段、颜色一致性与异常值测试 |
| INV-04 | always 强制彩色；never 零 ANSI；auto 尊重 TTY/NO_COLOR；不发射具体背景色；49m 默认背景复位允许；dim 不泄漏到数据线 | 源 charts.ts:94-140,417-435 | 源 R6/SGR/背景测试；当前 background test 需纠正 49m 假设 |
| INV-05 | 原自然日、日历与小时计量、空态、无费用、工具估算/实测分离、limit 不改变分母、完整标签和小金额不退化 | 源实现及两个真实报告实验 | 原 source width/data 与当前 money/native 测试 |
| INV-06 | canonical 命令/隐藏别名/帮助及交互五页一致；范围懒加载、缓存、退出恢复保留 | 源 stats.ts；当前 acquireUseRelease | 现有 builders；新增源码级命令及 stdio 行为测试 |
| INV-07 | total、daily、groups、sessions 使用同一过滤后事件；只删除 Session 覆盖，保留混合历史去重补计和全部 1.19 存储能力 | 用户数据例外确认；真实 DB 13 项基线测试 | mixed-history/native/data/cold；新增闭合断言 |
| INV-08 | tiny DB 经旧/新实际源码得到完整相等输出；不调用 opencode exe 或产品入口，不触碰 daemon/真实数据库 | 用户最新验收要求；560 次数据库驱动 green | 新增 DB parity；既有只读 native/cold |
| INV-09 | 生产与测试修改遵守 repo style、15% 中文解释注释、无无关改动；exact revision 双审通过后才完成/提交 | Workflow/用户合同 | package checks、独立审计、E/C 记录 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/03 | 原二维画布和 section-first 页面在重放中被替换为不同的文本算法，Series 色与页面结构不再存在 | Charts 的图元契约、Render/Insights 页面契约 | 两支最终源码；相同 fixture 的 224/224 输出不同；候选 0/224 不同 |
| INV-04/05 | 图元/页面拼接不再贯穿 color 和完整布局；错误测试仅检查标题或认定 Canvas 已不存在 | Charts / 页面输出 seam | 当前 width.test:877；有数据 TTY 的 Insights never 仍含 ANSI |
| INV-06 | 别名重新建立独立页面，交互 views 集合被扩成七项 | stats.ts 的命令归一化和 views | 两支 command diff；不是存储接口造成 |
| INV-07 | 已从 totalEvents 聚合 Session 后，再覆盖 tokens/cost，引入第二权威 | Data aggregateStats | 当前 :1406；当前 mixed-history.test:116-119 明示 111 vs daily 60；用户批准删除覆盖 |

因果链：`重放未保留原画布/页面算法 [origin] -> 同名 API 输出文本且丢身份色 [propagation] -> 终端纯文本、空白/字段缺失 [manifestation]`。改变主题、强制 color、补标题或放宽测试都没有修复 origin。

反馈命令：在 `packages/opencode` 执行 `bun run D:/Temp/opencode/stats-parity-probe.ts --require-parity`。已运行，exit 1，`compared=224, divergent=224, candidateFailures=0`；同时 `current-insights-never-contains-ANSI=true`。随后去掉 `--require-parity` 的候选检查 exit 0。测试驱动真实 renderer，不靠查源码文本。

数据库反馈在查询/聚合产生数值的 seam 测量：4 request 的源报告为 384 Token、$0.386、4 requests；保留覆盖的目标报告 all-time 为 0 Token/0 cost 且 Sessions 空。移除该覆盖的内存候选恢复相同事件值，五组筛选全部闭合。无须更换存储或在 renderer 补 totals。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 坐标、网格、线段覆盖、SGR 状态、宽度和终端文本清洗 | Charts | 图元确定性和终端列宽 | 原图元自身已完整承载 | 页面只组合；Data 不能持有终端样式 |
| Header/Panel/章节及各维度完整信息 | Render / Insights | `render*(report, options)` 返回整页 | 直接消费完整 StatsReport | 不另造平行 renderer、主题开关或表格框架 |
| 过滤事件和总量、两代消息读取 | Data / 既有 Core 冷投影 | 只读报告、精确归因和查询失败传播 | 产生所有页面共同的数值 | renderer 不能重新取数、拼补或改分母 |
| 参数、别名、TTY 页面集合及清理 | Command | 一次 canonical 渲染或同一交互循环 | 已有唯一编排入口 | 不把键盘/缓存注入 renderer |
| 源码 oracle 和 tiny DB | 测试 fixture / parity test | 独立 expected；真实公开 seam | 只读临时数据，不进产品运行时 | 不保留旧代码作为生产备用路径 |

## 10. Single Approved Primary-Path Design

```text
CLI 支持域 -> 既有 yargs 校验/参数归一化
  -> 当前只读 Data adapter -> 同一事件报告（删除 Session 累计覆盖）
  -> 回迁的唯一源 Charts/Render/Insights -> 原完整文本/ANSI
```

直接替换简化实现，按源最终树恢复主路径，不是在现有文本路径后增加“rich mode”。保留目标扁平文件路径，不再搬目录。只做 import 路径、当前品牌类型、Effect/Query 接口必需适配；原版 import alias 改为直接导入同名 `useColor` 并重导出，不改变行为。未发现需要新 runtime API、依赖、配置或数据库迁移的证据。

### 10.1 图表及页面恢复规格

恢复 `ChartCanvas` 的 cell priority、正交线段/交叉、圆整 Y ticks、X 日期/网格、系列颜色与无色标识，以及原 panel 宽度、padding 和逐逻辑行换行。页面最终边界不得截断或插入省略号；低层明确摘要 primitive 的既有 truncate 语义保留。复用源 ANSI palette、TEXT_RESET、BACKGROUND_RESET，不新增背景色。

| 页面/维度 | 必须恢复的完整输出 |
| --- | --- |
| Dashboard | 全宽 Daily token volume；原 activity 三尺度和阈值；cacheRead/input/cacheWrite/output 小多图固定顺序及独立归一化；cost/cache/failure 独立量纲；Model Lollipop、Provider 100%/other；原会话分桶、分位数、长尾、top list、Insights callout |
| Model | 同色趋势和直接图例；Portfolio；精确 100% Token 组成、数值/份额；Routing & tools |
| Provider | 费用可用时 cost 默认，否则 token；Economics；Model portfolio；Capacity & reliability；高侧费用/失败/时延异常色及高 cache 正向语义 |
| Agent | 工作负载列、独立十类输入组成、完整 context 分母、Runtime mix |
| Source | 专属工作负载列含 output；request owner 可用性说明；输入组成与 Routing mix |
| Project | 名称和完整路径的原位置、Portfolio/cache、Runtime mix、Largest sessions；ID 继续承担关联 |
| Tool | context 趋势与可用性；Footprint 的 calls/share/est ctx/ctx share/ctx-call/chars/errors/avg-call；按工具分组的模型/Agent/Project Issuing runtime；估算与实测说明 |
| Status | 固定 outcome 顺序、语义色、分布条、百分比趋势、unattributed 独立、五维 failure leader 和请求分母说明 |
| Timeline | 原全宽主图、四组件独立尺度、完整 health、active day 表含第二主指标/cache/output/avg-req、同色实体趋势；显式相对 peak Heatmap；零费用仍保留健康观测 |
| Sessions | Population usage/p50/p90/p95/p99/max/calls-session；正费用样本分布；token 长尾 top2/top10/mean-median；完整排行榜含更新时间、缓存/失败/时延/模型/Provider；可见行 token/cost 份额 |
| Insights | 共享 header/panel；Token 和十类输入组成；六维归因；日成本短趋势/CV/分位、Session token/cost 长尾；阈值 Actions；显式 Forecast 附录及费用 driver/区间/方法说明 |

旧的较早 stacked/Gallery/card 设计不是最终基线，不因函数同名而误回迁。窄屏按源阈值堆叠或使用完整 key/value，不自行增减 section。没有“先差不多、以后补齐”的验收阶段。

### 10.2 命令与数据

恢复五个交互视图的顺序：Dashboard、Breakdown、Timeline、Sessions、Insights。恢复 `overview/summary -> dashboard`、`models/providers -> breakdown`、`costs/tokens -> timeline`、`heatmap -> timeline --heatmap`、`forecast -> insights --forecast`，以及源 help 可见性/别名和参数职责。Gallery 的 `charts/graphs` 注册及无消费者 renderer 删除；不为目标简化实现额外保留兼容页面。

保留当前 Queue/race、分片 ESC、range/cache、lazy load 和终端 finalizer，只有确需匹配源公开行为的页面集合/选项映射变化。non-TTY interactive 保留一次 Dashboard 输出，不进入 raw mode。表格/排序默认值从源恢复；无值 shortcuts 仍表示全部，显式 limit 只改可见行。

Data 仅删除 `aggregateStats` 的 Session tokens/cost 覆盖，让已过滤 `sessionUsage` 与 total/daily/groups 一致。当前 `aggregateSession` 的历史去重补入、Native 查询、cold inspect、精确 owner tuple、小时投影、项目身份和异常传播保留。不得整文件覆盖旧 Data；不得把旧混合历史缺陷重新引入。`formatNumber` 恢复源整数舍入；小额钱使用原页面 money formatter。其额外消费者 `cmd/session.ts` 仅用来显示 Token 整数，不依赖小数格式。

### 10.3 精确验收 Oracle

第一层：以小数据库的真实 rows 经源 Data/Charts/Render/Insights 运行生成 expected。测试只适配旧 `Database.use` 为该隔离实例的同连接 Drizzle facade，并映射移动的 imports；不改源查询、聚合或渲染算法。候选使用当前 `Database.Service`、Native loader 和移除覆盖后的 Data。完整页面用原字符串逐字比较，不 trim、去 ANSI、改空格、改数字或宽松 regex。

已完成 prototype 的数据库有 2 Project、4 Session、4 Assistant Message、8 Tool/Step Part、4 Request、4 AssistantUsage；覆盖两组 model/provider/agent/source、三天、中文、四种 outcome、缓存和小金额。业务 seed 参数为 819 bytes；完整行含 JSON 约几 KB，运行时 SQLite 使用真实 Core schema 初始化，schema 占用不算业务 seed，不承诺整个 SQLite 文件只有几 KB。使用独立 `:memory:`，没有真实数据库路径。

报告比较保留所有数值/实体/关系；唯一内部差异是由 `day` 派生的日点 `label`：源 Data 是本地化日期，当前 Data 是 MM-DD。仅报告结构比较可忽略该冗余缓存字段；最终页面比较不做任何正规化。源 renderer 已自行产生日期，560 次最终输出已证明不受该内部差异影响，不修改 Data 的公开 MM-DD helper。

第二层：把旧源码生成的完整 expected 输出、来源 SHA、fixture revision 和选项矩阵固定在测试数据 `test/fixture/stats-baseline.json`。CI 只用当前实际代码对固定 expected，不需要本机 dev-smark ref，不携带旧生产算法。生成发生在修复前的独立源执行中；禁止从待验收的新 renderer 更新 oracle 掩盖差异。失败时报告 case key 和首次差异行。

核心矩阵覆盖上述 14 类输出 × `40/80/120/160` × always/never，及有数据/empty/no-positive-cost/tool-only；数据库样例另覆盖五组筛选。源 48 项显式断言覆盖分母、颜色角色、边界与完整字段；补充在内容宽度阈值两侧（终端 65/66、105/106、135/136）比较输出。auto/TTY/NO_COLOR 单独测试发射结果，不能只检查 useColor 的返回值。

第三层：在源码级执行真实 `StatsCommand` 的 yargs builder/handler，复用隔离 AppRuntime/Database，捕获公开 stdout；不经过安装 exe、`src/index.ts`、serve 或 daemon。交互测试在隔离测试进程控制 stdio 边界，按已输出的帮助栏作为就绪信号逐键推进；检查五页、往返、r/R、退出与 raw/paused/listener/光标恢复。允许在测试边界使用可恢复的 stdio descriptors 和输出捕获，不 mock aggregateStats/renderer，不暴露私有 runner 或增生产测试开关。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 窄/宽布局、无色/彩色、空报告、无正费用、tool-only | 当前及恢复后的源主契约 | primary-contract branch | yes | 全部属于同一语义主路 | preserve |
| 非 TTY 的一次 Dashboard、TTY 的单循环 | 当前/源共同契约 | primary-contract branch | yes | 原编排分支 | preserve |
| legacy/native、hot/v1/packed、历史去重补入 | 真实持久数据适配 | existing compatibility | yes | 原 Data adapter，不新增 | preserve |
| request 汇总无 Assistant 明细时使用该 request 自身值 | 两支已有账本域 | existing compatibility | yes | 既有持久记录语义 | preserve，不扩张为猜测 owner |
| Provider 无正费用用 Token、无 context 用 calls | 源已发布支持域 | primary-contract branch | yes | 可用性语义，不是异常后重试 | preserve |
| 当前独立 Gallery/旧 Overview/Costs/Tokens/Forecast renderer | 当前重复主路 | 非最终源契约 | yes | 不再存在于生产决策面 | remove/collapse |
| 旧源码只在临时 oracle 生成器执行 | 测试取证 | diagnostic | no production success | 生产占比 0% | 不打包进产品 |
| rich-mode flag、第二 renderer、catch 后零报告、降级回文本 | 未提出 | forbidden fallback | yes | 新 alternate success 预算为 0 | reject |

新增生产 diagnostic 决策面为 0%；新增 alternate success 为 0。恢复是把简化迁移造成的 origin 修好，不是运行失败后回到旧算法。没有临时生产兼容层、重试、缓存、guard 或设置需要额外 owner。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 字符条代替 line/area、固定上限/截断填充、只有标题颜色 | 简化重放遗漏了图元系统 | 源画布/布局直接满足复刻 | stats-charts.ts、stats-render.ts |
| 通用 rank + 旧 detail + 新分析表重复；独立 Gallery/派生页 | 原职责归一化未带过来 | canonical 页面涵盖源全部支持信息 | stats-render.ts、stats.ts、stats-insights.ts |
| Session all-time tokens/cost 覆盖 | 两种汇总权威并存 | 同一事件集给出可闭合报告 | stats-data.ts:1406-1410 |
| “Canvas 不存在只测 palette”、禁止 49m、只测空报告色彩 | 测试适应简化代码 | 恢复源正向图形/颜色断言和整页 oracle | width/background/money 等测试 |
| 已无生产消费者的旧 InsightCard/severity/Gallery 私有代码 | 未随源最终版淘汰 | 唯一 quantitative Insights 路径 | stats-insights.ts 和无消费者图元 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/08 精准复刻和源码 tiny DB 验收 | DB -> aggregateStats -> 全部 render* | Charts/Render/Insights；Data 仅闭合修复 | stats-parity：源生成固定整页输出与当前真实 DB 报告比较 |
| INV-02 Dashboard 全部细节 | renderDashboard -> 源 section helpers | stats-render/charts | 源 width Dashboard 系列 + 四宽度/阈值整页 oracle |
| INV-03 七维 Breakdown | renderBreakdown 的七种支持域 | stats-render/charts | 源逐维 complete 字段/分母/身份色；七维整页 |
| INV-03 Timeline/Sessions/Insights/Forecast | 对应公开 renderer | stats-render/insights | 源对应测试 + token/cost/heatmap/forecast 整页 |
| INV-04 颜色、背景、dim | charts.useColor/paint/Canvas -> panel | stats-charts/render/insights | 真实有数据 TTY/no-TTY × auto/always/never × NO_COLOR；正向系列色与 SGR 状态 |
| INV-05 空态/零费用/工具/长标签/limit/小金额 | Data report -> 源支持域 | render/charts/insights/format | 原 width 正向测试；money/background；empty/no-cost/tool-only oracle |
| INV-06 命令、help、别名、交互 | StatsCommand -> 唯一 renderer/原 Queue | stats.ts；Stats help snapshot 段；双语 Stats docs | stats-command 源码级公开命令/stdout + 现有 builder tests |
| INV-07 同源聚合、历史和 Native/cold | aggregateStats + 原 loadStatsRows | stats-data 只删累计覆盖 | mixed-history、native、data 的独立数值和闭合；cold 原回归 |
| INV-09 quality/审计/提交 | package-local 工具链 -> 独立审计 | 所有改动 hunk 和本计划证据 | typecheck/format/diff；E/C；两次 full-scope verdict；提交仅本任务路径 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 恢复源画布/轴/系列/SGR 状态的单一引擎 | INV-01/03/04 | 同名函数当前是文本条，源测试需要二维线图 | 补颜色不可能恢复坐标/交叉/布局；复用源既有实现，不另设计 |
| 源完整页面与 analytical table/helpers | INV-01/02/03/05 | 48 个源行为测试和数据库整页结果 | 当前少字段、重复结构与分母不同；小补丁不能承载源页面结构 |
| canonical 别名归一化和五页 views | INV-06 | 源 stats.ts 最终公开行为 | 当前 wrapper 输出并不等价，必须消除重复路径 |
| 删除 Session 累计覆盖 | INV-07 | 已执行 all-time DB 及 mixed-history 夹具 | report 当前有两份 totals 权威；在 UI 再改分母仍留 origin |
| 恢复 formatNumber 的整数舍入 | INV-01/05 | 相同分数值 2.5 的源/目标输出 3/2.5；实际页面含派生比率 | 当前为钱改了通用 Token formatter；原独立 money 格式已经承载小金额 |
| 任何新生产 API/flag/adapter/cache/guard | 无 | 无必要证据 | 不引入；旧同步 DB facade 适配只存在于隔离 oracle 生成器 |

新增概念限于测试 oracle/seed 和测试边界：它们映射 INV-08，不进入生产决策面；复用 Core Database 层、现有 Schema 和测试 scope，不新增测试专属生产出口。

## 15. File-Level Change Plan

行数是粗预算，不作为裁剪功能的理由；不重复精确计数。前三个文件和 command 以源最终代码为材料，而非重新设计。

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `src/cli/cmd/stats-charts.ts` | modify | 完整源图元/布局/调色板/SGR，适配导入，删除无消费者旧图元 | 约 +900 / -450 |
| `src/cli/cmd/stats-render.ts` | modify | 全部源页面、七维分析、空态、完整标签和默认数量 | 约 +1900 / -800 |
| `src/cli/cmd/stats-insights.ts` | modify | 完整定量 Insights 和显式 Forecast 附录，清除旧 card 私有路径 | 约 +400 / -600 |
| `src/cli/cmd/stats.ts` | modify | 原选项/命令归一化、help、五页；保留原交互生命周期 | 约数百行调整，净减少 |
| `src/cli/cmd/stats-data.ts` | modify | 仅移除 Session total 覆盖并邻近解释事件权威；为 source test 所需组件类型正常导出（若 typecheck 确需） | 约十行；类型导出不增运行时接口 |
| `src/cli/format.ts` | modify | 恢复整数舍入，解释钱不使用此 formatter | 数行 |
| `test/cli/stats-render-width.test.ts` | modify | 恢复源 48 项完整测试；通过正确 brands/直接 imports 适配；报告夹具移到 fixture 供 oracle 复用 | 约 +1400 / -1000，含纯移动 |
| `test/cli/stats-background-ansi.test.ts` | modify | 使用完整 fixture 覆盖所有页面；保留禁止具体背景色，允许默认背景复位，正向验证颜色 | 数十行 |
| `test/cli/stats-money.test.ts` | modify | canonical 页面的小金额与排序；舍弃对已退役 Gallery 文本列表形状的依赖 | 数十行 |
| `test/cli/stats-data.test.ts` | modify | 保留真实服务 fixtures/归因/过滤；按源分析列更新输出断言，现有 CLI 校验继续有效 | 数十行 |
| `test/cli/stats-native.test.ts` | modify | 数据/冷热/去重断言不削弱；旧 Overview 断言改到完整 Sessions 的 msg/tools 字段 | 数行 |
| `test/cli/stats-mixed-history.test.ts` | modify | 60 Token/$0.75 等独立事件值与 total/daily/groups/sessions 闭合；保留 noReply/Native/Cold 保护 | 数十行 |
| `test/cli/help/__snapshots__/help-snapshots.test.ts.snap` | modify | 只更新 Stats help 段，按源码级 builder 的源期望生成，不碰其他命令 | 数十行 |
| `test/fixture/stats.ts` | add | 源有数据/empty 报告夹具的纯移动，复用在显式视觉测试和 oracle | 约 230 行移动 |
| `test/fixture/stats-database.ts` | add | 很小的真实数据库 seed，独立预期值、固定日期、现有 brands，无聚合算法复制 | 约 100-160 行 |
| `test/fixture/stats-baseline.json` | add | 源实际运行生成的完整 expected 字符串、metadata、case keys；测试数据，不是另一算法 | 自动生成，体积随矩阵，不人工手写 |
| `test/cli/stats-parity.test.ts` | add | 真实 DB -> 当前 aggregateStats -> 全部页面与固定 oracle 的精确比较；报告闭合及只读验证 | 约 100-180 行 |
| `test/cli/stats-command.test.ts` | add | 不经产品入口的真实 builder/handler、别名/错误参数、TTY/non-TTY/cleanup 行为 | 约 150-250 行 |
| `packages/web/src/content/docs/cli.mdx`、`zh-cn/cli.mdx` | modify | 仅 Stats 段恢复命令职责及源文案，说明数据兼容范围（如有必要），不覆盖其他新版文档 | 每份数十行以内 |
| `docs/plans/stats-dev-smark-parity.md` | add/update | 唯一设计、证据、revision 和原样 verdict；分段维护 | 本文 |

存储、Schema、Protocol、Server、生成代码、package/config 无计划修改。若文件/接口或 owner 出现实质漂移，暂停实施、递增本计划 revision 并 full-scope 重审。

## 16. TDD Behavior Slices

用户已确认三个公开 seam。按一个纵向切片 red -> minimal green -> regression 推进，不先写一堆脱离实现的测试。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 真实小 DB 的 all-time total/daily/session 数值闭合，并保留 noReply 前历史 | Session 覆盖；source rollback 则会丢历史 | 只删累计覆盖，保留原 loader/去重 | mixed-history/data/native；独立常量而非从目标汇总反算 |
| 2 | Dashboard 源整页与图元结构/色彩 | 无画布/主图/panel，224 red 已证实 | 恢复唯一源 Charts + Dashboard 组合 | width Dashboard/SGR/空态/背景；不凭测试次数替代结构 |
| 3 | 七种 Breakdown 源整页与分析字段/分母 | 文本排名和不完整表，主体零色 | 恢复源 breakdown/trend/analytical helpers | 逐维 source positive tests、status 语义色、tool 估算/实测 |
| 4 | Timeline、Sessions、Insights/Forecast 源整页 | 字段/日期/配色/布局不同，never 泄漏 | 恢复对应唯一 renderer 与 money | 全部矩阵、无费用/tool-only、长标签、排序/limit |
| 5 | 公开别名输出等同 canonical；五页键盘往返、范围与退出 | 独立页面、七页、旧参数默认映射 | 恢复源 command 归一化，仅保留现有循环 | 源码级 yargs/handler+stdio，NO_COLOR 发射；错误参数不得读库成功 |
| 6 | 完整 DB→页面 oracle、源 48 项和 Native/cold 全回归 | 防遗漏迁移点与窄屏错位 | 补齐必要适配，不添加 fallback/放宽 oracle | 整页逐字、内存/冷热报告、package typecheck、diff/E-C |

测试意图必须敏感于原缺陷：保留正向“必须有坐标/线图/前景色/字段”的断言；不能仅测不超宽、不抛错、stripAnsi 等价或标题存在。源码 text-search、私有调用次数、复制计算公式均不作为验收。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 3200-4300 | 含恢复的生产/测试代码；排除空行、import-only、formatter-only、生成 oracle、纯移动 fixture；从别的分支回迁不是本工作树纯移动 |
| Required Chinese explanatory comments `C` | 对实际 E 动态计算；估计至少 480-645 行 | E=0 时 C=0，否则 C >= max(1, ceil(E*0.15))；不以估算代替最终实际门禁 |

已有源解释注释随真实逻辑恢复；只计算邻近修改且说明原因/不变量的中文行。分布在坐标 priority/正交交叉、tick、系列身份映射、百分比精确闭合、独立归一化、SGR intensity/background 边界、响应式完整文本、request/Assistant/tool 分母、正费用样本、历史兼容、oracle 来源和异步测试就绪/恢复处。删除覆盖旁说明“事件是唯一事实源”，而非复述赋值。

不计编号翻译、显然控制流、重复测试名、堆在文件顶部或拆行凑数；不通过注释改变可见输出。实施证据记录实际 E/C、排除项及代表性位置，独立审计复核。

## 18. Verification

### 18.1 已执行的计划阶段实验

以下命令均从 `packages/opencode` 执行，使用本地 git 对象的固定源 SHA；临时脚本位于已许可的 `D:/Temp/opencode`，未修改仓库生产代码、测试或真实业务数据。

| Command | Observed result | 验证范围与限制 |
| --- | --- | --- |
| `bun run D:/Temp/opencode/stats-parity-probe.ts --require-parity` | exit 1；224 比较全部不同；path-adapted candidate 0 不同；有数据 TTY 的当前 Insights never 含 ANSI | 真实两套 renderer、固定源报告；能捕获原始纯文本/无色症状；不是数据库端到端 |
| `bun run D:/Temp/opencode/stats-parity-probe.ts` | exit 0；候选页面与源逐字一致；旧 mixed-history 为 0/$0，目标保留 10/$0.125 | 候选渲染接入同形报告可行；纯函数历史实验不代替正式 aggregateStats 测试 |
| `bun run D:/Temp/opencode/stats-db-probe.ts` | 修正临时 harness 的 CRLF 匹配后 exit 0；5 个真实报告相等；560 份整页逐字相等；seed 819 bytes；Part rows 前后相等 | 使用当前真实 Core 内存 SQLite。旧 `Database.use` 仅绑定同连接；查询/聚合/渲染仍为源代码。候选 Data 只移除累计覆盖。无安装 exe、无 src/index、无 daemon |
| `bun run test D:/Temp/opencode/stats-source-suite.test.ts` | 48 pass，0 fail，663 assertions | 固定源完整视觉测试与实际源图元/页面，映射导入到当前 SessionID。证明原功能及布局可在当前 Bun 跑通；不是已落地生产实现 |
| `bun run test test/cli/stats-native.test.ts test/cli/stats-mixed-history.test.ts test/cli/stats-data.test.ts` | 13 pass，0 fail，114 assertions | 当前真实 Native/历史/SQL/Cold 基线；其中 total 覆盖断言将按用户确认改为闭合，不削弱其余保护 |

数据库五组独立结果：无筛选 384 Token/$0.386/4 requests；provider-a 为 324/$0.126/2；review 为 111/$0.251/2；error 为 44/$0.25/1；bash 为 111/$0.251/2。源/候选每组的报表数值、entity 和所有 14 类页面一致。报告比较只处理前述内部日标签，最终字符串严格原样。

初次临时 harness 的模块相对路径解析、Effect.fnUntraced placeholder 与 CRLF 文本匹配失败均已在隔离脚本内修正；失败未通过放宽最终输出断言处理。数据库 prototype 的只读检查目前只直接比对 Part rows；正式测试扩展至该 fixture 的全部输入表，不宣称已完成最终实现或全部只读验收。

### 18.2 实施阶段精确命令

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run test test/cli/stats-mixed-history.test.ts` | `packages/opencode` | 首个纵向 slice 的 red/green，历史保留及同源 total |
| `bun run test test/cli/stats-render-width.test.ts test/cli/stats-parity.test.ts` | 同上 | 源正向断言、真实小 DB 到完整页面、原缺陷 red 和最终 green；源完整输出从独立 source generator 固定 |
| `bun run test test/cli/stats-background-ansi.test.ts test/cli/stats-money.test.ts` | 同上 | 主题安全、never、前景色、小额费用/Token 格式 |
| `bun run test test/cli/stats-data.test.ts test/cli/stats-native.test.ts test/cli/stats-mixed-history.test.ts test/cli/stats-command.test.ts` | 同上 | 原生/混合/归因/过滤、源码级 aliases/help、五页交互和清理；不调用产品入口 |
| `bun run test test/storage/cold.test.ts test/storage/cold-v3.test.ts` | 同上 | 相关存储只读、冷投影、损坏传播及既有 cold 回归 |
| `bun typecheck` | 同上 | package-local 类型闭合；不直接用 tsc |
| `bunx prettier --check "src/cli/cmd/stats*.ts" src/cli/format.ts "test/cli/stats*.ts" "test/fixture/stats*.ts"` | 同上 | 仅本范围源码/测试格式；必要 formatter-only 单列排除 |
| `git diff --check`、`git status --short`、本 GOAL paths 的 `git diff` | repository root | 无空白错误/无无关变更；按实际 diff 计算 E/C；不改 index/refs |

Stats help 用 `stats-command.test.ts` 直接构建真实 yargs 并比较源 help/既有 Stats 快照段，避免为此运行产品启动器。其他命令帮助快照不更新、不测试整个产品 CLI。双语文档只检查 Stats 段对应的公开命令/参数与测试覆盖，无 web 运行时改动，不需要外部站点构建。

最终对照重跑原 224-case feedback loop（current 变为落地代码）及 DB oracle；prototype 内候选不替代工作树验证。未验证环境必须显式报告，不把源码阅读当作类型检查或真实终端视觉验收。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 本计划 + 5 个测试/fixture 文件 | 唯一计划、共享报告、真实 DB seed、固定输出、两个公开 seam 测试 |
| Files modified | 6 个实现、6 个现有 Stats 测试、1 个 help snapshot、2 个 Stats 文档 | 功能恢复和其直接消费者；不是“只改 Renderer” |
| Files deleted | 0；删除 obsolete exports/私有逻辑，不删现有文件 | 扁平结构保持；无需额外目录迁移 |
| Production lines | 约 5000-6500 行增删合计 | 源图元/页面恢复为主，Data 很小；不精确重复数行 |
| Test lines | 约 2500-4000 行增删合计，另加生成 oracle 数据 | 恢复源完整正向验收和 DB/command 回归，包含 fixture 移动 |
| Generated lines | 无 API/generated 源代码；仅测试 oracle | 输出数据由固定旧源码生成，不人工改色/改间距 |

预算不是删减行为的许可。JSON 的字符串体积不视为新增生产复杂度；也不把其文本行数计为手写 E。

## 20. Real Risks and Open Decisions

- 当前真实 Session 累计可能不等于可观察事件；用户已明确选择事件同源及历史补计。保留历史测试并用独立值锁定这一选择，不能把旧数值差异扩散为其他例外。
- 原生消息和旧冷投影的存储 owner 不同，整文件覆盖旧 Data 会丢 Native 能力。实施限定为删除覆盖，原 loader/ColdStorage 继续承担兼容和错误。
- 原图表类型与目标简化图元不同，修改 Charts 后尚未恢复的页面可能暂时不编译；按纵向源依赖切片推进，最终不得留下 adapter 来容忍旧 shape。
- 交互测试修改进程 stdio 边界会影响并行用例：测试独立且非 concurrent，保存 descriptor/listener/raw/paused/环境并 finally 恢复；不在用户终端调用 raw-mode 实验。没有源源码支持的类型/fixture 必需适配之外的实现漂移须重新审计。
- 固定 oracle 的日期、TZ、终端列宽和 color 环境必须显式记录；测试 fixture 使用固定本地日期，源/新运行于同一约定环境。不得正则删除真实身份/数字来制造相等。

### Open Decisions Requiring the User

无剩余不可约产品决定。数据例外和三个测试 seam 已确认；配色/间距本 revision 不改。未来若提出视觉改进，应有单独明确要求/新 revision 和完整新旧基线，不混入这次复刻。

### Rejected Speculation

- “需要重写 Data 模型才能恢复图表”：`StatsReport` 已有完整字段，真实 tiny DB 与源渲染试验已通过。
- “只要 always/TTY 就能修复”：强制 always 时七维和 Sessions 主体仍无色，原问题在 renderer origin。
- “需要产品 exe 或 daemon 才能验收”：真实源码加隔离数据库已执行；无需连接用户服务。
- “为未来更宽/破损/远程记录增加另一套 renderer、guard、cache”：无本次支持域证据，不实施。

## 21. Audit Contract

只向 `adversarial-auditor` 发送原始用户要求、本计划路径、repository root 和 `Audit mode: plan`；primary 不加载审计 skill、不自审、不提供防御性说明或建议审计范围。审计员自行加载 skill/policy，独立重建完整 affected interface。每次 material revision 保留原范围、递增 revision、清空 approval，再 full-scope 审计，最多六轮。

审计员原样返回 finding IDs、分类和 release verdict，primary 原样记录；仅 exact revision 获得 `No blocking findings` 与 `APPROVE` 才设置 approved/allow。实现后按实际全部 diff 另做独立审计，最多三轮；E/C、原 loop、完整验收和 package checks 通过后才能 verified。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | 无非阻断设计 finding | APPROVE | `ses_e533ce3d1ffepofB6LY54PzYYf` |

### Round 1 原样 Verdict

## Blocking findings

No blocking findings.

## Non-blocking findings

无非阻断设计 finding。

验证记录边界：本轮直接检查了三个临时实验脚本及其源码加载、数据库隔离和精确比较方式；本轮未获非 git 命令授权，未独立重跑 Bun。因此，计划中的 224、560 和 48 项结果不作为本轮独立实测结果引用。

## Rejected speculation

- **无需重写统计存储模型。** 当前 `StatsReport` 已提供恢复页面需要的统计量、时间序列、工具归因和项目身份，见 `packages/opencode/src/cli/cmd/stats-data.ts:153`。
- **允许 `49m` 不构成背景色保护弱化。** 固定源实现用它恢复默认背景；具体背景色仍被禁止。计划 §10.1、§15 保留了这一边界。
- **无需通过产品 exe 或 daemon 验收。** 已检查的数据库探针直接加载源码、提供内存数据库并比较完整输出，见 `D:/Temp/opencode/stats-db-probe.ts:10`、`:77`、`:103`、`:115`。
- 未发现需要增加第二渲染器、rich-mode 配置、失败后零报告或额外兼容层的证据。

## Requirement and traceability coverage

已独立核对固定源 `dev-smark@26061b595b3140d37717248222c7ed2016421db0`，并审查当前入口、受影响生产模块、直接消费者和相关测试。

| 需求 / invariant | 覆盖结论 |
|---|---|
| INV-01～03：完整排版、图形、信息和 ANSI 复刻 | §10.1 对应源画布、Dashboard、七维 Breakdown、Timeline、Sessions、Insights 和 Forecast；§10.3 使用独立旧源码生成完整字符串 oracle，最终输出不做正规化。 |
| INV-04～05：颜色、背景、窄屏、空态、长标签、分母、小金额 | 恢复源正向视觉测试，并补充整页矩阵及实际颜色发射验证；没有仅靠标题存在或“不超宽”替代完整验收。 |
| INV-06：真实命令及交互体验 | §10.2 恢复 canonical 别名和五页集合，同时保留现有 Queue、范围缓存及终端清理。当前分歧可直接定位于 `packages/opencode/src/cli/cmd/stats.ts:443`、`:599`。 |
| INV-07：保留历史并统一汇总 | 删除第二份 Session 累计权威，定位准确：`packages/opencode/src/cli/cmd/stats-data.ts:1399`～`:1411`。现有测试明确呈现 total 111、daily 60 的差异，见 `packages/opencode/test/cli/stats-mixed-history.test.ts:116`～`:119`。历史去重补计保留于 `stats-data.ts:1159`。 |
| INV-08：小数据库、真实源码、精确验收、daemon 隔离 | 数据库探针覆盖实际聚合到整页输出；正式测试还承诺扩大只读快照范围，计划没有把目前仅检查 Part rows 描述为完整只读验收。 |
| INV-09：范围、质量、验证和双审 | §15～18 明确文件边界、TDD 切片、package-local 检查和中文注释目标；§21～24 保留独立实现审计及提交门禁。 |

反向映射也成立：恢复画布和完整页面、命令归一化、删除累计覆盖、恢复整数 formatter，均有具体需求及现有调用链依据。`formatNumber` 的额外消费者使用它展示 Token，费用仍独立格式化，见 `packages/opencode/src/cli/cmd/session.ts:230`、`:234`、`:281`。

## Primary-path and fallback verdict

**通过。**

第一处分歧位于图元和页面实现：当前折线已成为逐点文本条，见 `packages/opencode/src/cli/cmd/stats-charts.ts:195`；Dashboard 缺少源主图及共享页面边界，见 `packages/opencode/src/cli/cmd/stats-render.ts:493`。

R1 直接恢复这些 owner 的唯一实现，生产路径保持为：

```text
StatsCommand
  → 当前只读 Data adapter
  → 同一事件集生成 StatsReport
  → 唯一 Charts / Render / Insights
  → stdout
```

旧页面及重复成功路径有明确删除或归并决定。legacy/native、冷热投影和 request 自身汇总属于已有持久数据契约；无正费用、tool-only、TTY/non-TTY 属于支持域分支。新增备用成功路径和生产诊断决策面均为零。

## Code quality and Chinese-comment verdict

**计划级通过。**

- 改动归属内聚；无新增运行时依赖、数据库迁移或生产测试开关。
- 源 import alias 已列入必要适配；无消费者旧 helpers 和页面有删除决定。
- 测试覆盖三个已确认公开边界，预期输出来自固定旧源码，能够对原始退化行为失败。
- §17 承诺按实际 `E` 执行 `C ≥ ceil(E × 0.15)`，估算 `E≈3200–4300`、`C≈480–645`，并排除生成数据、纯移动等类别，满足计划阶段要求。
- 本轮 Stats 实现及测试路径无工作树 diff；实际实现 `E/C` 留待实现审计独立计算。

## Release verdict

**APPROVE — `docs/plans/stats-dev-smark-parity.md`，Revision R1。**

本轮放行仅适用于该精确计划修订。实施完成仍须取得实际 red-green、完整数据库与页面 oracle、适用回归及类型检查证据，并通过独立 full-scope implementation audit。

## 23. Implementation Evidence

R1 的实际改动及返工回归记录如下。第 2 轮独立实现审计已完整通过；其后 primary 在当前共享工作树再次执行 `bun typecheck`，exit 0、无诊断。Stats/cold、原始 loop、格式、实际路径及 E/C 全部满足放行门禁。下列失败表保留各阶段原始证据，不代表当前仍失败；最终结果见“最终放行验证”。

### Actual Files and Diff

- 修改范围保持 §15：六个生产文件、六个既有 Stats 测试、两个新测试、三个 fixture、Stats 帮助快照段、两份 Stats 文档及本计划。未修改 schema、存储 owner、配置、生成 API 或依赖。
- Charts 恢复真实 Canvas 和源图元；Render/Insights 恢复全部 canonical 页面。页面最终包装复用同一个 Charts `renderPanel`，不另保留一套 padding/background/wrap 算法。
- 删除旧 Gallery/独立派生页及无消费者的 Histogram/RankBars/MetricRibbon/Narrative/Slope/DayLabels/EmptyState 图元。现有低层图元继续按支持域工作，无 rich flag、备用 renderer 或失败后零报告。
- Data 的实质变化仍只有删除 Session tokens/cost 覆盖和正常导出既有 `InputComponentTotals` 类型；其余行差由现有 formatter 展开。native/legacy/cold loader 与去重不改。
- `test/fixture/stats-baseline.json` 是固定旧源码生成的测试数据，当前 8 个报告、1064 个整页 case，另含独立源帮助和一个 60 日交互帧，约 11 MB。体积来自保留完整 ANSI/空格，而非另一套算法。
- 第 1 轮返工将日期标签数量/间距、热图比例、Provider 健康阈值、默认行数及同一路径的字段宽度/缩进接入现有私有常量表；源值和计算不变。修正三处说明范围、删除纯字段枚举及相邻重复说明，没有为撤回的 B-03 补写凑数注释。

### Red-Green Test Evidence

- 原始 renderer loop 已实际 red：224/224 与源不同，Insights never 发射 ANSI。恢复后工作树 loop 为 224/224 原字符串一致，never 不再泄漏 ANSI。
- mixed-history 的独立 expected 改为 60 Token/$0.75 后先 red（实际 111/$0.875）；只移除 Data 的累计覆盖后 green，历史 noReply 前的 10 Token/$0.125 仍保留。
- 原帮助测试先 red 于 Gallery/旧派生页的公开入口；归一化后真实 builder 与固定源帮助逐字一致。
- 直接消费者曾因退役 exports/旧文本契约、不完整 report、禁止 49m 而失败；已改到 canonical 页和完整 fixture，不恢复平行 renderer，不削弱 native/cold/归因/小金额保障。

### Verification Commands and Results

所有 Bun 命令工作目录均为 `packages/opencode`。

| Command / boundary | Actual result | Scope |
| --- | --- | --- |
| `bun run D:/Temp/opencode/stats-generate-baseline.ts` | exit 0；8 reports / 1064 cases | 固定 SHA 的 Data/Charts/Render/Insights/format 与 command builder；旧 `Database.use` 仅接同一真实内存连接；不读取当前 renderer 生成 expected |
| `bun run test test/cli/stats-parity.test.ts` | 1 pass / 1113 assertions | 当前真实 SQL→aggregateStats→14 类完整页面；五筛选、empty/no-cost/tool-only、四宽度和断点两侧；八张输入表逐行只读快照 |
| `bun run test test/cli/stats-render-width.test.ts test/cli/stats-background-ansi.test.ts test/cli/stats-money.test.ts test/cli/stats-data.test.ts test/cli/stats-native.test.ts test/cli/stats-mixed-history.test.ts test/cli/stats-command.test.ts test/cli/stats-parity.test.ts` | 72 pass / 0 fail / 2322 assertions；最终重跑 | 48 项源视觉行为、小金额/背景、data/native/mixed、真实 command、TTY、固定整页 oracle；包含最终注释和边界断言 |
| `bun run test test/storage/cold.test.ts test/storage/cold-v3.test.ts` | 62 pass / 0 fail / 482 assertions | 两代冷投影、完整报表等价、只读、损坏传播的既有回归 |
| `bun run D:/Temp/opencode/stats-parity-probe.ts --require-parity` | exit 0；224 compared / 0 divergent / 0 candidateFailures | 落地工作树相对固定源，不是 prototype 候选的替代证明 |
| `bunx prettier --check "src/cli/cmd/stats*.ts" src/cli/format.ts "test/cli/stats*.ts" "test/fixture/stats*.ts"` | pass；最终重跑 | 仅 Stats 及直接消费者 |
| 本任务路径的 `git diff --check` | pass | 无空白错误，Git 提示 LF/CRLF 不作为修改配置的理由 |
| `bun typecheck` | 当时 exit 2；未通过 | 当时诊断为 `src/session/prompt.ts:1568` 的 Effect 服务要求、`test/session/compaction.test.ts:1200/1222` 的 Handle.runChild、`test/token/accounting.test.ts:88/94` 的 TokenPart、`test/tool/code-mode-integration.test.ts:158/173` 及 `test/tool/code-mode.test.ts` 的接口类型；没有 Stats 路径诊断 |

第 1 轮返工后重跑记录：

| Command / boundary | Actual result | Scope |
| --- | --- | --- |
| `bun run test test/cli/stats-render-width.test.ts test/cli/stats-parity.test.ts` | 49 pass / 0 fail / 2070 assertions | 先验证全部 48 项可见行为和 1064 个精确整页组合 |
| 上述八个 Stats 路径，加 `test/storage/cold.test.ts test/storage/cold-v3.test.ts` 的同进程完整运行 | 134 pass / 0 fail / 2804 assertions | 用户等待对应任务修复后，针对当前共享工作树重新验证源码级 command、数据库、Native/cold 和所有页面 |
| `bun run D:/Temp/opencode/stats-parity-probe.ts --require-parity` | exit 0；224/224 原字符串一致 | 常量提取后无数字、布局或 ANSI 漂移，Insights never 无 ANSI |
| 本范围 Prettier / `git diff --check` | pass | 常量变更已正常格式化；不修改其他任务文件 |
| `bun typecheck` | exit 2；仅剩 `test/token/accounting.test.ts:88/94` | 常量提取曾把默认比例推断为字面量 `0.5`，已用参数 `number` 保持原 API 接受任意比例，Stats 诊断消失；并行任务修复了 Session/CodeMode，其余两处 TokenPart 类型仍待所属任务处理 |

### 最终放行验证

| Check | Final result | Evidence |
| --- | --- | --- |
| 包级 `bun typecheck`，工作目录 `packages/opencode` | exit 0，无诊断 | 第 2 轮审计员独立执行通过；随后 primary 再次执行通过。历史 Token/CodeMode/Session 错误由对应任务处理，本 GOAL 未修改那些文件 |
| Stats + cold 联合回归 | 134 pass / 0 fail / 2804 assertions | primary 与第 2 轮审计员分别执行 |
| 原始 renderer loop | 224/224 精确相等 | 无数字、空格、线条、颜色或 ANSI 正规化；Insights never 零 ANSI |
| 格式、空白、文件完整性 | pass；21/21 SHA256 匹配 | 独立审计后只原样记录 verdict 和修正 N-01 行政记录，没有修改生产、测试或 oracle |
| E/C | 5517 / 836，15.153163%，最低 828 | 第 2 轮独立核算通过 |

N-01 已通过本节和状态元数据更正；保留历史失败证据，不清空 R1 approval，不改行为或审计路线。

真实命令测试只以 Bun 执行源模块，运行实际 AppRuntime、yargs handler、隔离 DB。非 TTY stdout 连末行换行直接匹配旧页；TTY 用公开 stdio 边界和帮助栏就绪信号推进 n/Tab/分片右键/p/分片左键/r/R，五页每帧原样比较；q/Esc/Ctrl-C/EOF/error 均检查 raw、光标与 listener 归还。EOF/error 的输入流已销毁时不再要求 open-stream paused 值；打开的输入仍要求恢复进入循环时的 paused 状态。没有修改生产生命周期或添加测试开关。

### Actual Paths and Verification Limits

主路径为 `StatsCommand -> 当前只读 aggregateStats -> 唯一 Charts/Render/Insights -> stdout`。窄屏、颜色、无费用、工具记录与 TTY/non-TTY 为既定支持域；native/legacy/cold 是既有持久兼容。新增备用成功路径为零，生产新增诊断决策面为零。

当前共享工作树含其他任务的 Core/Permission/Session/CodeMode/LLM/SDK/TUI 改动，均未覆盖或纳入 Stats 范围。此前包级 typecheck 失败输出保存在 `C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1ad2e9f390019uHhTGF3PkncQq`，各阶段诊断保留于上表。对应任务修正后，审计员与 primary 的完整包级检查均已通过；没有缩小编译范围、恢复别人文件或隐藏失败。

包级阻塞的处理已再次向用户确认。问题原文：`包级 typecheck 仍被 Stats 范围外的 Token/CodeMode 测试类型错误挡住。对应文件属于并行任务，如何处理这个放行前提？` 用户选择：`由对应任务修复（推荐）`。因此保持 R1 Stats 范围，不代改这些文件；这不取消类型检查或最终提交门禁。

verified 状态已按第 2 轮原样 verdict 和全部验证放行；提交仍须限定本 GOAL 路径并检查 index。物理终端主题的人眼复核未运行，已完成用户确认的实际源码/数据库/完整文本及 ANSI/模拟 TTY 协议验收。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 5517 | 采用审计员第 1 轮的相同 Prettier、`diffLines` 与 AST import 区间口径；排除空行、import-only、formatter-only、生成 oracle、文档及帮助快照 |
| Qualifying Chinese comment lines `C` | 836，第 2 轮独立确认 | 831 条沿用前轮已核定内容，5 条新增或修正说明具备实际解释资格；不按邻近或同主题自动扣除 |
| Ratio `C / E` | 15.153163% | source 回迁计为有效修改，不把跨分支复制排除为纯移动 |
| Required minimum `C` | 828 | max(1, ceil(5517*0.15)) |

核算命令：`bun run D:/Temp/opencode/stats-comment-metrics.ts`，工作目录 `packages/opencode`。返工后的逐文件 E/C 与候选原文位于 `D:/Temp/opencode/stats-comment-metrics-round2.json`；该临时工具不进入产品或提交。当前没有整文件纯移动，报告 fixture 来自固定源分支而非 HEAD 内原样搬移，因此其 267 行代码仍计入 E。原轮独立结论为 E=5426、C=835，原样保留于 §24，不将旧快照结果充当返工后的独立测量。

代表性解释：Charts `:136` 约束数据线/坐标轴/网格覆盖优先级，`:409-412` 解释 SGR dim 与 background 的独立复位；Render `:60` 区分内容断点与终端总列宽，`:192` 区分正费用样本和未知费用；Insights `:124-131` 解释稀疏活跃率与预测方差；parity test `:97-99` 解释全字段 oracle 与八表只读验证的不同职责。均在相应决定附近，而非集中堆放说明。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01、B-02 | B-03 经复议撤回；见原样记录 | BLOCK | `ses_e529ce7b1ffezv8D9FBvt9BXZJ` |
| 2 | R1 | yes | No blocking findings | N-01：补记本轮类型检查通过；行政记录修正 | APPROVE | `ses_e529ce7b1ffezv8D9FBvt9BXZJ` |

仅当实际 diff 收到独立 full-scope `No blocking findings` 和 `APPROVE`，且所有门禁满足才设置 verified；随后按用户 GOAL 检查 status/diff/cached/log，只提交本任务路径。若同路径混有无关修改则停止并报告。不得 push、amend、跳过 hook 或空提交。

### Round 1 最终复议原样 Verdict

审计员首次记录 B-01/B-02/B-03 为 blocking；收到原核算明细后，primary 按 policy 提供事实引用请求复议。以下是同一 task、同一送审快照的最终结论，取代初次 B-03 数值推断，不计为新一轮。原始完整审计 diff 为 `D:/Temp/opencode/stats-implementation.diff`，文件 manifest 为 `D:/Temp/opencode/stats-implementation-files.json`；本次返工开始前保留该快照不覆盖。

## Blocking findings

**B-03 撤回。B-01、B-02 保留，原送审快照的总体 verdict 仍为 BLOCK。**这是原实现审计轮次的复议结论，不是修改后实现的新一轮审计。

### B-01 包级类型检查门禁未通过

- **Violated invariant:** INV-09；规定的 package-local 类型检查必须通过。
- **Evidence class:** observed
- **Producer and execution path:** `packages/opencode/package.json:19` → `tsgo --noEmit`；原轮独立执行 `bun typecheck`，退出码为 2。
- **Source evidence:** `packages/opencode/test/token/accounting.test.ts:88`、`:94`；`packages/opencode/test/tool/code-mode-integration.test.ts:158`、`:173`，以及 CodeMode 测试中的其他类型诊断。
- **Canonical-plan evidence:** 原 R1 §18.2、§23 Verification Commands and Results。
- **Responsibility owner:** 包级验证门禁及 Token／CodeMode 对应接口、测试的所属任务。
- **Concrete behavioral consequence:** 原快照缺少规定的类型检查成功证据，不能进入 `verified` 和提交放行；此项不归因为 Stats 引入的回归。
- **Minimal correction direction:** 由对应 owner 恢复接口与测试的一致性，再通过完整 `bun typecheck`，不缩小检查范围或增加类型抑制。

### B-02 具名常量约束尚未完整落实

- **Violated invariant:** 原 R1 §1 要求尺寸、阈值、间距等设计取值使用具名常量。
- **Evidence class:** contracted
- **Producer and execution path:** Timeline 热图、Provider 健康标记、Dashboard 排名和公共日期标签布局仍直接消费正文中的设计字面量。
- **Source evidence:** 原快照 `packages/opencode/src/cli/cmd/stats-render.ts:2469` 的 `0.7`、`:927` 的 `0.95`、`:1790` 的默认行数 `5`；`packages/opencode/src/cli/cmd/stats-charts.ts:529` 的标签数量和间距取值。
- **Canonical-plan evidence:** 原 R1 §1 第 63～68 行、INV-09。
- **Responsibility owner:** Charts／Render 的现有布局及显示规则常量。
- **Concrete behavioral consequence:** 已确认的代码组织约束仍未完整覆盖真实渲染路径；当前输出相等不消除这一契约缺口。
- **Minimal correction direction:** 将这些设计取值纳入现有常量表并复用，保持源值、计算和 API 不变。

## Non-blocking findings

### B-03 最终分类：Withdrawn，原阻断不成立

复核后确认：原先用“邻近、同主题”进行去重，超出了 policy 对解释资格的判定条件。**解释真实边界、常量含义、不变量和行为测试意图的注释，不能仅因附近已有相关说明而自动扣除。**

具体包括：

- `packages/opencode/src/cli/cmd/stats-render.ts:352` 解释 `n/n-1` 对固定 `2σ/3σ` 风险边界及颜色的影响，属于实际边界说明，应计入。
- `packages/opencode/src/cli/cmd/stats-render.ts:2024` 解释缺少 context 估算时 calls 的主契约分类，属于支持域与主路径说明，应计入。
- 原名单中的测试说明，只要解释了 fixture 如何暴露错误、断言如何避免假阳性或公开边界为何需要实际输出验证，就符合行为测试意图资格；不能按“复述附近主题”统一排除。

**原“777 < 814，已证实不达标”的判断撤回，不再要求据此补齐所谓缺少的 37 行注释。**

## Rejected speculation

- 没有证据表明原排除名单中的全部相关说明属于刻意拆行、凑数或远离修改点的注释堆积。
- 不能把“解释主题相关”直接等同于“复述代码、重复测试名或没有解释价值”。
- 一个保守认可下界低于门槛，不能证明实际有效注释总数低于门槛。

## Requirement and traceability coverage

审计对象仍是**原 R1、原始完整需求及 `D:/Temp/opencode/stats-implementation.diff`**，没有改用当前工作树或缩小实际修改范围。

本次从固定基线 `7e8ad09c3b7b71f7dc2310a6da79585e0c54c284` 在内存中重建了原 diff 的 **16 个生产／测试代码文件**：

- 16 个文件的 SHA256 全部匹配原 manifest。
- 重算得到的 **E=5426、839 个中文候选**与原记录一致。
- 所有候选的位置、原文与原候选记录逐项一致。
- 未写入文件，未改 oracle，未运行产品入口或 daemon。

其余全范围结论继续使用原轮同一快照的独立证据：

| 范围 | 原轮已取得的证据及本次结论 |
|---|---|
| 完整页面、字段、布局、ANSI | 1064 个 oracle 组合及 224 项源码对照通过；没有因本次复议改变这些结论。 |
| 数据历史、统一汇总、Native／cold | Stats 72 项、cold 62 项测试通过；历史保留和事件同源路径维持原结论。 |
| 命令、别名、五页交互、退出恢复 | 真实公开入口及隔离 TTY 协议验收维持原结论。 |
| 发布验证和代码组织 | B-01、B-02 的原快照后果仍适用。 |
| 中文解释注释 | 已完成资格复核，B-03 撤回。 |

本次没有把原轮执行结果描述为新一次测试执行。

## Primary-path and fallback verdict

**原主路径结论维持通过。**

```text
StatsCommand
  → 当前只读 Data adapter
  → 同一过滤事件集生成 StatsReport
  → 唯一 Charts／Render／Insights
  → stdout
```

未发现新增备用成功路径。无正费用、Tool-only、TTY／non-TTY 等仍属于已确认的支持域；历史补计和累计覆盖删除仍对应用户批准的数据例外。

## Code quality and Chinese-comment verdict

### 资格复核结果

对全部 839 个候选核对后：

- 原排除的 62 行中，**59 行恢复计入，3 行仍不计入**。
- 另有原先计入的 **1 行**范围说明过宽，本次不计入。
- 最终确认计入 **C=835**。

保留不计入的四行如下；本次门禁通过不依赖它们：

| 原快照位置 | 不计入理由 |
|---|---|
| `packages/opencode/src/cli/cmd/stats-render.ts:1273` | 对公开／测试边界的描述未准确限定随后共享 helper 的实际使用范围。 |
| `packages/opencode/src/cli/cmd/stats-render.ts:2609` | 主要枚举随后显示的字段，未提供独立解释理由。 |
| `packages/opencode/test/fixture/stats.ts:106` | “同一输入”的 oracle 范围表述不够准确；正式数据库 parity 使用另一份数据库 seed。 |
| `packages/opencode/test/fixture/stats-database.ts:14` | “所有验收使用显式 all-time”过宽；同一 fixture 的交互验收还覆盖了 60 日范围，见 `packages/opencode/test/cli/stats-command.test.ts:263`～`:288`。 |

### 最终计算

```text
E = 5426
C = 839 - 4 = 835
C / E = 15.388868%
ceil(E × 0.15) = 814
835 ≥ 814
```

排除口径保持不变：空行、import-only、formatter-only、生成 oracle、文档及帮助快照不计入 E；未把跨分支回迁当作纯移动排除。

**中文解释注释门禁通过。即使采用 15% 要求，也不存在 B-03 所述阻断。**代码质量方面仍保留 B-02；包级验证仍保留 B-01。

未进行物理终端主题的人眼复核；本轮已完成实际源码、数据库、ANSI 和模拟 TTY 协议验收。

## Release verdict

**BLOCK — 原送审 R1 及原实现 diff。**

| Finding | 本轮复议后的最终分类 |
|---|---|
| B-01 | **Blocking — 保留** |
| B-02 | **Blocking — 保留** |
| B-03 | **Withdrawn — 原阻断撤回** |

这是原审计轮次的最终复议记录。总体尚未放行，不得据此设置 `verified` 或进入提交阶段。

### Round 2 原样 Verdict

## Blocking findings

No blocking findings.

## Non-blocking findings

### N-01 实施验证记录需追加本轮通过结果

`docs/plans/stats-dev-smark-parity.md:19`、`:499`、`:540` 仍描述包级类型检查未通过。本轮独立执行的 `bun typecheck` 已成功退出，无类型诊断。

保留历史失败记录，追加本轮成功证据，并按 Workflow 记录本次 verdict 即可；这是行政性记录更新，不构成行为或批准路线变更。

## Rejected speculation

- 没有把数学运算中的基础数值一律要求抽成常量；实际布局、显示阈值和复用参数已接入具名常量。
- 没有因注释邻近或主题相关而自动扣除解释资格。
- 无正费用、Tool-only、空态及 TTY／non-TTY 仍属于既定支持域，不构成失败后的备用成功路径。
- 未将共享工作树中的其他任务改动纳入 Stats 提交范围，也未修改它们来取得验证成功。

## Requirement and traceability coverage

本轮覆盖 **R1 原始完整需求、全部实际 diff、受影响入口及 producer／consumer**，没有缩小为仅复查上一轮 finding。

送审的 **21/21 个文件 SHA256 在验证结束后仍匹配 round 2 manifest**。16 个生产／测试代码文件也从固定 HEAD 和送审 diff 在内存中重建并校验成功。

| 需求范围 | 独立复核结论 |
|---|---|
| INV-01～03：完整页面、字段、排版、数字和 ANSI | 14 类页面、8 个报告、1064 个唯一 oracle 组合完整；固定源的 6 个源码 SHA 已核验。 |
| INV-04～05：颜色、背景、宽度、完整标签、空态、小金额和分母 | 正向图形、SGR 状态、颜色模式、窄屏、无费用及 Tool-only 验收通过。 |
| INV-06：命令、别名、五页交互和清理 | 真实公开 builder／handler、键盘导航、r/R、退出及终端恢复测试通过。 |
| INV-07：保留历史并统一汇总 | `stats-data.ts:1493`～`:1502` 继续由同一过滤事件维护 Session、total 和 daily；Native、去重及 cold 兼容回归通过。 |
| INV-08：小数据库、源码执行及 daemon 隔离 | 实际内存数据库到完整页面验收通过；未运行产品入口、安装版 exe 或 daemon。 |
| INV-09：质量、常量、验证和注释 | 本轮适用检查全部通过，见下文。 |

本轮实际执行结果：

| 检查 | 结果 |
|---|---|
| 窄范围视觉／数据库测试 | **49 pass，0 fail，2070 assertions** |
| 全部 Stats＋cold，同进程联合回归 | **134 pass，0 fail，2804 assertions** |
| 固定源 parity probe | **224/224 原字符串一致**；Insights `never` 无 ANSI 泄漏 |
| 包级 `bun typecheck` | **通过，无类型诊断** |
| 本范围 Prettier 只读检查 | **通过** |
| 本范围 `git diff --check` | **通过** |
| 最终送审文件一致性 | **21/21 SHA256 匹配** |

物理终端主题的人眼对照未运行；本轮完成的是用户确认的源码、完整文本／ANSI 和 TTY 协议边界验收。

## Primary-path and fallback verdict

**通过。**

```text
StatsCommand
  → 当前只读 Data adapter
  → 同一过滤事件集生成 StatsReport
  → 唯一 Charts／Render／Insights
  → stdout
```

源画布和完整页面在所属模块恢复；Session 累计覆盖已删除，历史补计及现有持久兼容保留。Gallery、独立派生页和无消费者旧图元已删除或归并。

常量修订没有引入新生产接口、额外成功路径或替代算法。对 Charts／Render 的所有运行时声明，在常量及类型规范化后与第 1 轮实现比较，**新增、删除及改变的声明均为零**。新增生产诊断决策面为 **0%**。

## Code quality and Chinese-comment verdict

**通过。**

上一轮 B-02 涉及的实际消费路径已修正：

- 日期标签数量和间距使用具名常量：`packages/opencode/src/cli/cmd/stats-charts.ts:553`。
- 热图比例使用 `layout.chart.heatmapFraction`：`packages/opencode/src/cli/cmd/stats-render.ts:2527`。
- Provider 健康阈值使用 `healthThresholds.cache`：`packages/opencode/src/cli/cmd/stats-render.ts:967`。
- 默认排名行数复用 `layout.rows.default`：`packages/opencode/src/cli/cmd/stats-render.ts:1846`。
- `renderTwoColumn` 的比例参数仍接受普通 `number`，未收窄为字面量 `0.5`：`packages/opencode/src/cli/cmd/stats-charts.ts:763`。

独立 E/C 核算：

| 项目 | 结果 |
|---|---:|
| 有效代码行 E | **5517** |
| 有效中文解释注释 C | **836** |
| C/E | **15.153163%** |
| 15% 所需最低 C | **828** |

本轮 831 条注释与前轮已核定的解释内容对应；另外 5 条新增或修正说明，分别解释绘制优先级、健康阈值、共享章节 owner、手工 fixture 与数据库 oracle 的边界，以及日期窗口 fixture 的复用，均具备实际解释资格。

计算排除了空行、import-only、formatter-only、生成 oracle、文档及帮助快照；没有把跨分支回迁当作纯移动排除。未发现新增类型抑制、测试弱化、生产测试开关或平行渲染实现。

## Release verdict

**APPROVE — 第 2 轮 full-scope implementation audit，Revision R1。**

放行对象仅为：

- `D:/Temp/opencode/stats-implementation-round2.diff`
- `D:/Temp/opencode/stats-implementation-files-round2.json` 对应的精确快照

| 原 finding | 本轮状态 |
|---|---|
| B-01 | **Resolved**：包级类型检查已独立通过 |
| B-02 | **Resolved**：具名常量已接入实际消费路径 |
| B-03 | **Withdrawn**：维持前轮复议结论，本轮注释门槛也已通过 |

本结论完成第 2 轮实现审计。后续由 primary 记录 verdict、更新验证状态，再按已授权的 Workflow 执行提交检查。本轮未修改文件、index 或 refs，未创建提交。
