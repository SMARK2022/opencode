# Canonical Implementation Plan: Token Input Estimation Precision

> Status: verified
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户原文，见 §1
>
> Implementation allowed: completed; further material changes require new approval
>
> Last updated: 2026-11-07
>
> Target state: verified-implementation-and-commit

本文件是唯一 canonical plan。**Core 负责唯一输入算法；daemon 负责样本读取、请求估算与压缩决策；TUI 消费既有字段，在现有缓存内计算显示增量。** 实施逻辑只在 §10 定义，文件与删除范围见 §12/§15，数值证据见 §18，审计原文见 §22。

## 1. Verbatim Requirement

原始调查与规划要求：

> 你看一下我们 OpenCode 的 DB 里面今天所触发的所有的 compaction。你看一下 compaction 之前的所有的消息，真的能够，真的到达了模型百分之九十五的一个阈值吗？就换言之，我当时觉得很奇怪，经常很多模型在没有到达阈值，或者说大概率我人眼看的是感觉不到到达阈值的情况下，就触发了 compaction。我不知道到底有什么逻辑，你去看一下。看一下现在一个情况，注意 read only 去调研。

> 排查 1.15 到 1.19 迁移后 SSE 超时未重试问题
> 旧主线收尾、prompt迁移与V1工具编排升级
>
> 你甚至可以看一下如下我给你的两个会话，看一下这两个会话它的这个compaction触发了一个阈值大概是多少，看一下它们触发的时间大概是什么时候，就如上这两个名字的session。

> 注意一点，我主要担心的或者担忧的是GPT-6和GPT-6.1的那个SOL，也就是GPT-6-ASTRA，还有那个SOL这两个模型。

> 也有目前经常观察到，感觉它甚至都不到这个相应的GPT所配置的那个600K的一个目标，就就就就到了。

> 而且你看那个五八零零零到底准不准，因为我们目前大量的情况下都观察到，它的这个 session 的一个会话的一个实际增长情况很奇怪，就是感觉就没几行它就触发了。

> 我的建议是你不要直接只看那个 estimation，我觉得可能是不是甚至 estimation本身的逻辑就有问题，是不是你如果有没有办法去看得到那个具体的一个消息的 confirmation，就是确定的一个值。就按理来说，每次消息都有确定的值，你把确定值加一加，看一看和 estimation的口径到底差异有多大，到底怎么回事，等等各种各样的一些东西。

> 与此同时请注意一点，因为有的时候可能这个 message 的消息呢，其实包含着 GPT 的一些加密的 reasoning 的一些 content。那些加密的 content 呢，其实本身我们并不知道它的字数到底有多少，所以对于那种情况呢，它本身这个使用除以四的口径就不准。但是可能按照现在的估算逻辑呢，它也会把那种出来的那种 thinking reasoning part 的概要的概述部分认为是正文部分，然后去计算，导致去一个很短的文字，实际上背后对应着很多的 token，导致这个相应的计算的比例出现一个暴涨，或者说这个暴跌，巴拉巴拉的。所以本身就是这么一套逻辑呢，其实就会导致有一点 bug。所以按理来说呢，这个 token 的统计其实当前也不是很完善，但是我现在需要去看的就是到底当前大概实测是多少 token，巴拉巴拉的。因为按理来说你可以去实测得到对应的这个 reasoning content，它输出了几条 content。然后 reasoning content 的每一条 content 按理来说应该对应 ChatGPT 的一个，就是一定体量的 token 的数量。就比如说可能一段 sentence 的这个加密，是对应比如说一千个 token，或者巴拉巴拉的。按理来说这种统计量应该能够通过回归啊等等一些方式去统计得到。

> 要请注意是 read only，然后你可以进行必要的一些计算，你去看一看，大概一个这个 reasoning content对应多长啊，巴拉巴拉的。

> 保持最小的修改模式，按照 First Principle Plan 的一个一套逻辑体系去构建相应的这个完整的修改 plan。然后必要的时候你可以进行一下验证。同时保持相对较小的一个修改，HUNK，同时保持较高的一个泛化性等等一些内容。不要进行任何的修改工作区的一个改动，但是你可以进行一个方案的构建。

> 下面进行完整按照First Principle Plan的原则去进行完整的审计啊等等的一些操作。
>
> 换言之，你需要先去完整阅读一下我们的 DOCS 里面的 Workflow 的文件，然后去按照 Workflow 进行执行。然后最终的验收呢，就是说我们要得到一个 Verified Play，不进行实施。

> 下面检查一下相应的方案，然后如果可以的话，请你避免把这套方案变得非常复杂。你可以看一看有没有相应的比较好的构建方式，design方式，以及给出相应的 DIFF 等等的一些东西，或者说一些较为优秀的一些实现，一些逻辑，保持这个整套逻辑的 HUNK，简洁，同时具备较好的扩展性，以及以较少的修改就能达成和现在现有仓库的整套逻辑的一个链路的一个适配。也就是说避免去反复接线，而只在关键的一个地方作为一处修改，就能使得它能够泛化到整个仓库。

> 不需要完成审计。

后续架构与交付要求：

> 旧的学习逻辑在哪？我们新的学习逻辑为什么不放到旧的学习逻辑旁边呢？按照我的理解，相应的这个 token 估算是不是到底之前是放在哪儿的呢？现在又准备放在哪。

> 有一点问题，你这个 core 是在哪个地方进行的？是在 TUI 进行的，还是在 DAEMN 进行的？换言之，你这个东西是以 TUI 为一套实例进行的计算。然后我记得它还有这一套缓存的等等一些逻辑，所以现在到底是一种什么样的情况。

> 不能让相应的这些消费者都使用一个源头吗？换言之，按理来讲相应的估算逻辑直接使用同一个 core 的一套逻辑不就 OK 了吗？也就是说 V1 的 processor 这一套逻辑不能直接去复用 core 的逻辑吗。

> 对，针对这套逻辑是没有问题的。然后但是呢，相应的流程机制也不应该过度地复杂。所以按照这套抽象架构，请你注意保持这套抽象架构，也就是DAEMON，去进行各种的计算、估算啊权威的一些结果，然后通过相应的字段交给TUI，TUI会进行一些各种样的一些估算，包括什么实时的一些估计啊等等的一些逻辑。然后呢，按理来说应该是这套逻辑，同时呢应该不应该去造成性能下降。然后呢，你应该继续按照那个Workflow里面的First Principle Plan那条原则去构建这一个 Plan。你不需要让它去进行审计，但是你需要去构建完整的 Plan，请注意这一点。也就是说你的 Plan的完整的构建的流程需要按照 Workflow 去走。

> 请注意点相应的文件编辑方案的提出以及等等的一些逻辑都应该由你自己去进行，不应该交给 Task。

> DIFF也可以不用完全写得很准确，就是你写一些，比如说关键逻辑啊，什么都要写清晰，验证过的关键逻辑，等等一些什么各种接线是怎么接的，巴拉巴拉的，然后旧的内容去删掉什么巴拉巴拉的。

> 注意保持相应流程机制高效，请注意这点。你的任务是写一个完整的plan。不要耗费大量精力在一些无意义的事情上。保持相应的流程机制，或者说整体的架构保持简洁，不要增加一些无意义或者说过度分支的一些逻辑。本身用户说得很清晰，现有的这些内容可以被调整、修改，甚至部分移除，让整体的内容保持收敛，保持优秀，保持鲁棒性，以及如上的一些东西。

> 也就是说保持泛用性和扩展性，还有精准性以及这个性能的收益。

> 但请注意一点，性能要求写成明确的验收项，这个东西你必须证明你已经能够实现了，要不然你不能把它写成验收项。就换言之，验收这个词汇必须是你的 plan 能够达到的，也就是验收项必须是 plan 的验收项，而不是实施的验收项，请注意这一点。
>
> 性能验收以及准确精准，巴拉巴拉，各种逻辑，还有接线等等的逻辑，本质上是你能实现的你才要去。就是本质上，相应的验收标准，这个东西的职责划分是归为 Plan 的提出，他去必定满足这个东西的。也就是说，他提出的方案要求是能够满足这套逻辑的。但既然用户要求了这一点，你不能说你要收缩验收标准，这本身是在降低责任。也就是 Plan 需要承担他所提出的 Plan 一定能够达到对应的验收标准，以及满足用户的需求，这两个标准。

> 下面由你来完整完成相应的方案的状态，从 Plan 提出变成 Plan Verified。与此同时，由于之前的内容，它的思考都是以一种加密或者压缩的思考格式，但你需要自己去完整地思考，以 let me 开头去进行完整的思考。不要弱化或者压缩你的思考内容。

> 针对于当前所提出的 plan，请你检查一下，看这个 plan能不能变得更加优化，更加简洁。也就是说当前可能我觉得有一些 plan里面的东西，在反复打补丁，引入了一些本身其实用户并不 care 的一些东西。因为按理来说这一套逻辑应该职责啊，巴拉巴拉，很清晰，很简单，不应该变得很复杂啊，巴拉巴拉的。可以研究一下，看一看，适当地去调整一下，看看有没有必要去调整一下现在的 plan。然后同时当前的 plan呢，我看写了大概是675行。那整体而言呢，我的推荐是最好保持800行以内，不要让每一次的东西都去做只是做追加，而不是去把那些方案做调整；下面请你高效检查分析

> 因此下面发起subagent进行一次审计，看一下情况。你我并没有说800行是硬上限，我只是说建议是这样，blabla的。然后同时你的这个方案要写清楚，写详细。就比如说最终是怎么实施啊，blabla的。然后同时请注意避免让你的方案过于片段化，或者因为本身它是一个 unified 的一套结构。同时呢，应该去考虑到一些 corner case。你在去 plan 的时候就应该考虑到一些 corner case；然后在你适当检查，把方案弄详细之后，你可以去进行审计。

> 底增 revision必须发生在审计之后，换言之你不要因为一次修改就地增 revision，revision本身它的含义是被审计的第几轮版本。
>
> 之前如果存在那种没有审计就递增版本的这种东西是不被允许的。当然我不知道之前，应该之前是有审计过的。就换言之，如果第一次审计之后确实要变成V2，呃R2，第二次审计要变成R3，第三次审计要变成R4，不要直接第一次审计是R2，或者说第一次被审计的版本是R1，然后第二次被审计的版本直接就变成R3了，这是不允许的。
>
> 不要去以著名的形式，你是怎么样就直接修改成怎么样。你不需要去额外去叙述说，旧的是多少多少是怎么怎么样。你不需要叙述一些无意义的一些事情。不要此地无银三百两。是怎么样，就叙述成怎么样。不是的东西就不要叙述，或者说直接移除掉。保持这样的逻辑，你不要去把它试图去进行复杂化。不需要叙述说，巴拉巴拉巴拉是什么什么什么，它不是什么什么什么，不是什么你就不用说，而且不是什么也没有人问你它是不是什么。你不要把你的篇幅变成为了澄清而澄清。在你没说混淆的情况下，没有人会误解，请注意这点。
>
> 换言之，如果一些旧的版本，旧的审计中它使用了R1、R2、R4、R5等等这样的逻辑，或者说中间可能有R2、R3，但是没有经过审计，那你就直接把R2、R3写成上一个版本。就譬如说，R1审计了一次，变成R2，R2审计了一次，变成R3，然后又写了R4、R5，这是没有审计的，但是又新的版本，那你就把R4、R5又写成R3就OK了，你不需要额外去叙述，直接进行精准替换就OK。然后后面呢，比如R6、R7，那你就改成R5，巴拉巴拉的。

> 但按理来讲，如果只是在 compaction 之后的一些消息，那本身它完全保留也没有问题啊，那大不了第二次压嘛，就没有什么大问题。因为这种本身就是为了去保持一定的这个用户消息的连贯性。如果你这个只是最新消息，到后续助手，就是 marker，也就是触发 compaction 之前的最后一条用户消息以及之后的这个助手等等一些东西，那本质上应该也可以去保留，这个没有什么大问题。因为这个东西是保持连贯性所必要的，大不了它就触发第二次这个 compaction 吗。或者说你如果觉得有问题，你也可以去看上游，也就是我们的那个官方的分支是如何的。如果官方的 2.2.5 里面还是采用这套逻辑的话，那我们就没有必要去修改它。也就是整套逻辑甚至都没有必要去修改。
>
> 你这地方叙述得完全有问题。你这地方叙述什么用户指令备忘，但指令备忘本身又不是历史，不是 history。它又不算在这个 tail bla bla里面，它只是一个 handoff。所以用户指令备忘你就不要说了。你 Overflow 重放这块又有问题，Overflow 重放你本身也没说清楚，到底是怎么 Overflow 的。你应该叙述判断逻辑，比如说先怎么样，判断怎么样，怎么样。而且如果上游根本就没有改过，我们就不要去改。

> 按照相应的逻辑进行完整的审计以及后续流程内容，也就是换言之，你需要进行的内容呢，包括审计啊，巴拉巴拉的，最终直到 verify, plan and implement plus commit 的这套流程机制。然后又因为之前审计员所给出的审计结论呢，它本身已经是偏无效的结论了。然后而且它审的唯一的一个 blocker 是在用户不care的东西上，所以你可以把当前的 plan设成 approved即可，因为当前的范围审计员没有提出任何问题。然后所以你可以进入相应的实施阶段。

本方案修正包含 thinking/reasoning 的输入估算、统一 Core 学习来源及 daemon/TUI 字段消费。保留现有压缩窗口、整轮连续性与重放行为；连续两次压缩只作为调查现象，以确认用量和实际请求判断估算误差。

## 2. Explicit Non-Goals

- 保留 context/input/output/reserved、580000 触发线、head/tail 选择、tail_start、overflow replay、手动压缩意图、undo/hidden 投影及 provider reasoning 回放内容。
- 保留确认 tokens、费用与请求账本、零确认、重试/中断归属；输出仍按已确认生成内容独立校准。
- 不新增 Schema、HTTP/SSE 字段、事件、数据库列、迁移、生成客户端或每-token 写入。
- 不新增服务、跨 TUI 学习实例、daemon 全局比率缓存、后台任务或缓存失效状态机。
- 不改 TUI 布局、Sync 的 mapArray/createMemo/WeakMap 生命周期、正文租约、300 条窗口或 Context 面板既有 500ms 节流。
- 不统一所有名为 token 的粗估：tail/prune 的固定 /4 仍是保留预算代理，不冒充 prepared 请求的精确估算。
- 生产 DB 只读；隔离实验使用 `D:\Temp\opencode`，实现仅修改§15文件，并仅提交本任务改动。

## 3. Repository Context

| Source | Constraint |
| --- | --- |
| `docs/guides/workflow.md` | 用户批准R6后实施，完成包内验证、独立实现审计及本任务commit |
| `.opencode/policy/first-principles-engineering.md` | 修根因、单一语义来源、证据约束、双向追踪、中文注释门禁 |
| `.opencode/templates/canonical-plan.md` | 保留全部适用章节，不以聊天代替规范 |
| 根 AGENTS、`packages/opencode/AGENTS.md`、其 test/AGENTS | 包内测试/typecheck、复用 Effect/测试设施、最小修改、保留共享工作树 |
| `CONTEXT.md:11-16,67-69,107,130-135` | Session History/Context Epoch、Native Continuation Metadata 不得丢失 |
| `docs/adr/README.md` | 当前 ADR 索引没有另一个 token 估算所有权决策；不新建重复 ADR |
| `docs/plans/token-usage-continuity.md` | 已有 request/step 接力与 TUI 缓存作为基线 |
| `docs/plans/compaction-undo-boundary-invalidation.md` | 保留已建立的 compaction 配对、隐藏与回放边界合同 |

## 4. Files and Evidence Read

表中 `core/`、`opencode/`、`tui/` 均相对 `packages/`。

| ID | Evidence | Relevance | Class |
| --- | --- | --- | --- |
| E01 | `core/src/util/token.ts:19-48,157-164` | native 样本、旧 scalar 学习、唯一 visitor 和请求折算 | observed |
| E02 | `opencode/src/token/estimate.ts:20-106` | 第二套学习、100K 窗口、跨模型回退、upload 估算 | observed |
| E03 | `opencode/src/session/processor.ts:868-889,1185-1226` | 确认字段同源；prepared 采集后再次覆盖 Core 结果 | observed |
| E04 | `opencode/src/session/message-v2.ts:1275-1346` | 只读采集、cold stats、水位；当前逐消息解码 | observed |
| E05 | `opencode/src/session/prompt.ts:1518-1565` | V1 decide 仍调用旧 upload 学习路径 | observed |
| E06 | `core/src/session/runner/llm.ts:502-517`、`core/src/session/compaction.ts:260-263,313-318,380-382`、`core/src/permission/reviewer.ts:150-155`、`core/src/session/runner/to-llm-message.ts:304` | native/摘要/reviewer 已共用 Core，无须重新接线 | observed |
| E07 | `core/src/session/info.ts:179-225`、`opencode/src/session/processor.ts:97-105` | 已有 inputEstimate 发布、持久投影与请求身份 | observed |
| E08 | `tui/src/util/token-accounting.ts:112-261,271-327` | 本地重复输入校准、已有输出与账本计算、字段优先级 | observed |
| E09 | `tui/src/util/token-estimate.ts:97-159`、`tui/src/util/context-usage.ts:310-331,1101-1119` | 尾部增量、afterPartID、prepared/confirmed、旧数据分支 | observed |
| E10 | `tui/src/context/sync.tsx:228-260,1269-1284`、`tui/src/routes/session/context-usage.tsx:451-465` | 每消息/会话缓存与释放；面板快照是既有独立节流路径 | observed |
| E11 | `core/src/storage/cold-codec.ts:377-390,709`、`cold-store.ts:1555-1589` | inputEstimate 保热，step breakdown 可归档；有现成只读恢复 | observed |
| E12 | `opencode/src/session/compaction.ts:234-281,343-398,478-540,650-693`、`message-v2.ts:1523-1529` | 现有 tail 边界、整轮保留和自动继续行为 | observed |
| E13 | `opencode/src/cli/cmd/tui.ts:986,1033`、`cli/tui/worker.ts:54-86` | Core 是代码包；权威执行属于 daemon，TUI 使用 HTTP/SSE | observed |
| E14 | §18 的原型、DB 回放、基线测试 | 方案可达性、精度与性能证据 | observed |
| E15 | [官方 v2.2.5 compaction.ts](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/src/session/compaction.ts#L983-L1028)、[测试](https://github.com/anomalyco/opencode/blob/9bbb8ce18c80f099e0e448775f59d965ead40a21/packages/core/test/session-compaction.test.ts#L757-L839) | 官方 Core 按 user 边界保留完整近期 exchange；该版本实现与当前 V1 不同 | observed |

原始只读调查的两会话：`ses_e540604afffeIIdPOVtlsVuELw`（旧主线，原记录 7 次 compaction）和 `ses_e53e36d01ffetLCaQ1I56qgeiZ`（SSE，原记录 3 次）。

历史调查支持：模型 context 为 600000，实际 usable 线为 580000；加密 reasoning 字符密度与普通文本显著不同。约 15.5 字符/token 是样本回归结果，不是解密结果，也不证明每个 reasoning blob 固定对应某个 token 数。

两个 Session 的确认回放按 session/provider/model 隔离；有效结果和结论边界统一见 §18。

官方 tag `v2.2.5` 指向 `9bbb8ce18c80f099e0e448775f59d965ead40a21`。`recentStart` 先按 keep 预算找位置，再向前取 user 边界以保留完整轮次；因此保留量可以超过 keep。最新轮的完整保留符合连续性需求。当前 V1 的触发与重放流程作为既有行为保留。

## 5. Current Behavior

```text
daemon/V1: prepared body -> 逐消息恢复step -> 拍平样本 -> Core估算 -> V1再次学习覆盖 -> overflow/发布
daemon/native、摘要、reviewer: 既有调用 -> Core估算 -> 事件/Session.request
TUI: HTTP/SSE -> Sync每消息/会话memo -> 本地输入学习 -> daemon ratio覆盖 -> 基数+未确认尾部
```

Core 纯函数没有跨请求训练实例；TUI 的缓存只共享同一 TUI 内的统计，不跨进程。provider 已报告的 input 包括该次请求的整个上下文：不能把历次请求 input 相加当成当前上下文占用。校准的分母为本次 `input + cache.read + cache.write`，媒体 token 独立扣除，费用累计继续由账本负责。

## 6. Supported Input Domain and Reachability

| Domain | Producer / guarantee | Handling owner | Class |
| --- | --- | --- | --- |
| 已确认热 inputEstimate | processor 同 step 保存 bodyChars/breakdown 与 tokens；归档保留该字段 | daemon 采集器优先读取 | observed |
| 当前助手尚未确认新 body，但有此前 finish | prepared 将当前估算设为未确认；已有 finish 保留当次证明 | V1 adapter 只取最近合格 finish，禁止混用新 body 与旧 tokens | reachable |
| 缺 carrier 的存量数据、cold finish | 既有持久格式和只读 decoder | 沿已有统计恢复域读取，保留原读取预算 | contracted |
| 完整、无 reasoning、加密/明文 reasoning | 现有 visitor 已分类；不改 provider 回放 | Core 同一学习器 | observed |
| 无 breakdown、部分旧 breakdown | 现有旧数据与测试 fixture | 只学习可观测总密度，不能伪造 reasoning=0 参与二元拟合 | contracted |
| 媒体 raw/占位/token | AttachmentToken 已拥有计量 | Core 共用样本资格和媒体扣除 | contracted |
| TUI 有 daemon 密度 / 旧数据缺密度 | 既有 Session.request、assistant carrier、旧历史 | 现代路径直接消费；旧域在现有 memo 内委托 Core | observed |
| retry、断流、零确认、model 切换 | 既有 prepared、finish 与 Session 串行执行合同 | 原身份/水位不变，daemon 样本不跨 API 模型 | contracted |
| 恶意新协议、未来密度编码 | 无本任务新增入口或生产证据 | 不驱动新 guard、provider 分支或配置 | speculative |

## 7. Required Invariants

| ID | Invariant | Evidence |
| --- | --- | --- |
| INV-01 | 输入估算响应载荷组成变化，并用确认 usage 约束绝对量；估算不能冒充确认 | 原始需求；E01/E03/E14 |
| INV-02 | token 精度修复保持 head/tail、tail_start、overflow replay 与用户轮次连续性；是否再次压缩仍由既有条件决定 | 最新用户要求；E12/E15 |
| INV-03 | 明文、加密、媒体、旧数据共用同一学习实现，不按 provider 硬编码密度 | 用户泛用性要求；E01/E02 |
| INV-04 | 近期样本供给有界，采样不能因扩大窗口重复解压已有热快照对应的冷数据 | E04/E11/E14 |
| INV-05 | charsPerToken 是文本增量密度，不能由 raw bodyChars / 含媒体总 input 反推 | E08/E09；图片反例约 205.46 vs 4 |
| INV-06 | 请求输入的学习规则只有 Core 一份；旧入口只能转换数据或薄包装 | 用户单源要求；E01/E02/E05/E08 |
| INV-07 | daemon 决定请求估算与 compaction；TUI 消费既有字段，保留独立输出校准和本地缓存 | 用户确认架构；E07/E09/E10/E13 |
| INV-08 | 本方案阶段证明精度和性能收益、关键接线与删除可行，不把这些责任留给实施后 | 最新用户要求；§18 已执行证据 |

## 8. First Divergence and Root Cause

| Invariant | Origin | Propagation / manifestation | Owning repair |
| --- | --- | --- | --- |
| INV-01/03 | 已有分桶却统一除以单比率；未将近期真实确认值约束到拟合输出 | 组成变化时失真，提前触发 | Core 的同一请求估算路径内修正 |
| INV-06 | opencode 另维护学习窗口、钳位和 source 回退；TUI 再维护输入学习公式 | processor 覆盖 Core；各消费方规则漂移 | 删除重复算法，复用 Core |
| INV-04/08 | 已有热确认仍恢复 step；单纯扩大窗口会放大冷解码 | 逐消息20样本解码 P50=179.05ms/P95=259.35ms | 读取已存在且相同的 confirmed 热快照，非新增缓存 |
| INV-07 | TUI measure/summarize 在已有 daemon ratio 时仍做输入校准 | 多余输入字段读取后才覆盖结果 | 现代消息跳过输入训练，保留输出和尾部工作 |

红/绿信号已实际执行：已知 /4 文本与 /16 推理请求，现行源码估算 680016，候选 500010，独立期望约 500000。原始双连发与这个估算缺陷的因果关系仍需该事件的确认用量及实际请求对照。

## 9. Responsibility and Seam

| Owner | 唯一职责与既有接口 | 不承担的职责 |
| --- | --- | --- |
| Core `util/token.ts` | 样本资格、媒体归一、窗口和学习；`estimateRequest(body, history, sections?)` 测量并折算，scalar 入口薄包装 | DB、V1 消息形状、TUI 状态 |
| daemon 的现有 Session 路径 | `MessageV2.inputEstimateHistory` 读取样本/水位，V1 `inputHistory` 只适配形状；processor/native 发布与触发，SessionCompaction 管 tail 预算 | 第二套学习公式、新服务或新 projector |
| TUI 的现有 accounting/Sync | 消费请求密度，计算显示与输入/输出增量，维护既有 memo；缺字段旧数据委托 Core | 请求体重建、compaction 决策、确认账本改写 |

## 10. Single Primary-Path Design

整个改动沿一次 provider 请求展开：daemon 取同 API 的确认样本，Core 以这些样本估算实际 prepared body，daemon 把结果冻结到现有 `inputEstimate` 并执行 overflow 判断，TUI 通过现有请求投影消费这份结果。provider 返回 usage 后，同一个 step 的字符证明与确认量组成下一次采样输入。

```text
V1只读统计 / native已投影历史 -> 形状适配 -> 最多20个同API确认样本
prepared body + samples -> Core.estimateRequest -> inputEstimate
inputEstimate -> daemon overflow/发布 -> Session.request、assistant -> TUI memo/显示增量
step-finish usage + 本step字符证明 -> confirmed样本 -> 下一次请求
```

### 10.1 Core 只有一个输入学习实现

在现有 `core/src/util/token.ts` 内，以 `inputRatioSample` 统一资格/媒体扣除，`learnInputRatios` 统一学习；`estimateRequest` 与 `charsPerTokenFromHistory` 共用结果，不新增 Module/service。

- 样本只有 `bodyChars`、确认 `input` 和可选 breakdown。保留正有限输入、至少 100 原始字符、扣媒体后输入为正、旧附件缺媒体 token 不参与校准等资格；累计字符超过 500 才学习。
- 每 assistant 最近一个合格确认点，最多 20 个；carrier 与对应 step 不重复。native/V1 均交付可重复消费的有界数组，重试不持有耗尽的 generator。
- 样本归一为 `C=max(0, bodyChars-media.rawChars+media.textChars)`、`I=input-media.tokens`，无 media 时各媒体项为0。完整分桶取 `R=messages.reasoning`、`T=C-R`；缺 reasoning 字段的旧点参与总样本门槛与最近点选择，二元拟合只接受完整分桶。
- 完整分桶子集累计字符也须超过500、输入为正。拟合 `I ≈ aT+bR`：`D=ΣT²ΣR²-(ΣTR)²`，`a=(ΣTIΣR²-ΣRIΣTR)/D`，`b=(ΣRIΣT²-ΣTIΣTR)/D`。要求 `D>0`、`D/(ΣT²ΣR²)>=0.01` 且 `a,b>0`；先将 `1/a` 钳位到 text `[2,8]`、`1/b` 到 reasoning `[2,32]`。
- 可分离拟合在同一函数内用最近确认点 `(T0,R0,I0)` 校准绝对量；这是算法的一步，不是另一套估算。未校准方案的误差退步证据见 P02。

```text
scale = (T0 / rText + R0 / rReason) / I0
rText   = clamp(rText   * scale, 2, 8)
rReason = clamp(rReason * scale, 2, 32)
input   = max(0, round(T / rText + R / rReason)) + media.tokens
```

最近合格点缺分桶、完整分桶子集不足门槛、单桶/共线或无有效正密度解时，取 `pooled=max(2, latest.chars/latest.input)`，分别钳位 text `[2,8]`、reasoning `[2,32]`；总字符不足门槛或无合格数据使用 /4。当前 body 的 T/R 由既有 visitor 给出，媒体 token 只追加一次。

scalar 入口保留 `number` 合同，删除自己的 reduce/100K 公式，只返回学习器的 text 密度或默认 4。`estimateRequest` 保留唯一 JSON visitor、媒体计量与 sections 可选返回，只替换学习入口/最终折算；发布 `charsPerToken=rText`，不以 `bodyChars/input` 反推，不持久化第二密度。

### 10.2 daemon 样本读取优先使用已有热确认

`MessageV2.inputEstimateHistory` 保留只读事务、隐藏/Session/model 过滤与 chronology 分页，一批最多 20 条元数据。E03/E11 及 P03 已证明热 `inputEstimate` 与对应确认 step 等价，无需新增缓存。

1. 合格 confirmed carrier 直接读取数字；没有合格热确认的候选沿既有 stats-only 路径取最近合格 finish。字符与 usage 始终来自同一个确认点；恢复范围限定 step-finish 统计。
2. 每 assistant 一个样本，最多 20 个。旧恢复保留 100K I/O 预算，累计**全部已恢复合格 step**而非只计选中点，达到即停止找旧样本；该预算不限制热 carrier 窗口。
3. `afterPartID` 独立读取当前消息最后一个可见 Part，与样本同快照；不能拿最后样本 ID 代替。旧恢复错误直接传播，不预热历史、不增加 decoder/cache/迁移。

V1 `TokenEstimate.inputHistory` 只做形状转换、同 provider/model 筛选与 newest-first 排序，按上述优先级选点，资格委托 Core。删除 `collect(false)` 跨模型补样本；preflight 原本已有同模型过滤。

采集器继续返回 `{ history, afterPartID }`：热消息保留现有 `info` 元数据与空 `parts`，旧消息保留选中的 finish；100K 读取预算在丢弃其他已恢复 step 前累计。适配器返回原始 `{ bodyChars, input, inputBreakdown }` 数组，媒体归一交给 Core，避免把已扣过媒体的值再次扣除。Core/native 的 `inputHistory` 采用相同资格与窗口，模型切换按实际 API provider/model 重新筛选。

### 10.3 V1 与 native 的接线

- V1 processor：适配样本交给 `Token.estimateRequest`，发布 `{ ...estimate, contextLimit, afterPartID }`，删除旧 learn/重算；confirmed 交接、preflight overflow 及发布顺序不变。
- V1 decide：直接将现有 `modelMessages`、systemText/contextReminders 各一次交给 Core 请求估算，使用同一个 V1 样本适配器。删除 sanitize→纯文本→estimateUploadInput 的旧学习链；维持 decide 选窗阈值和无预算行为。该候选预算仍是选窗估算，实际 prepared 回调仍拥有最终请求估算。
- native 普通请求、压缩、摘要、decide、reviewer：已有 Core 调用不改；`Token.inputHistory` 在本文件内按统一样本资格/窗口交付有界数组。
- `Session.info`、事件、SDK：现有 inputEstimate 字段已经贯通，不新增接线、字段或生成代码。估算仍不写入确认费用账本。

prepared 到 finish 的交接遵循现有写入顺序：prepared 产生 `confirmed:false`，preflight 先判断，成功后发布；finish 使用本次 provider usage 更新 tokens，并把同一步的 bodyChars/breakdown 写到 step-finish，再发布 assistant。下一次 prepared 覆盖为新估算时，上一 finish 仍独立保存；采样可使用该确认点，不能把旧 tokens 配给新 body。usage 缺失或零输入不参与学习，UI 与费用保持各自既有合同。

### 10.4 TUI 保留缓存，取消重复输入训练

保留 `SyncProvider/mapArray/createMemo/shareAccounting`、会话 memo 和正文释放 owner；仅收敛输入校准：

- `measureMessage` 有有效 daemon 密度时跳过输入校准；缺字段旧消息用一个最近合格样本的数字元数据替代两个聚合数。保留输出校准、确认 atoms、cost 和尾部测量，不新增样本数组或正文缓存。
- `summarizeAccounting` 优先使用 assistant 密度；仅旧数据缺字段时，在现有会话 memo 内将数字样本交给 Core scalar wrapper，最多 20 条，沿既有本地 Session 历史域，不充当 daemon 权威结果。
- `projectAccounting` 优先使用选中 request 的密度，含历史 request 的 carrier。`computeFinalTokens` 的 confirmed/零值优先级、afterPartID 去重与输入/输出增量公式不改。
- `context-usage.latestInputEstimate` 先查 carrier，缺字段才构建样本并调用 Core；有当前 Session.request 时不得借旧请求估算。Context 面板既有 500ms 深拷贝扫描保持，不宣称它已共享全部 accounting 缓存。

字段按请求身份选择：active 请求先取 `Session.request.inputEstimate`，显式历史请求取该请求末 assistant 的 carrier；对应字段缺失才使用已有本地数字样本。计算 `summary.pending/tails` 时仍将每条消息自己的 `tail.inputEstimate` 传入 `computeFinalTokens`，由它优先使用该条消息的密度；会话密度只补缺字段。prepared 已包含的 Part 由 afterPartID 排除，尚未确认的工具结果沿原公式追加，输出密度独立计算。

## 11. Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| 分桶拟合 + 最近确认校准 | primary | 单一 Core 实现 |
| 共线/无完整 breakdown 的单密度 | primary-contract domain | 同一学习函数，仅利用可辨识信息 |
| 无合格样本的 /4 | existing cold-start contract | 保留，不新建恢复路径 |
| 热 carrier 与旧/未确认 carrier 的 finish 读取 | persisted-domain branches | 同一个确认采样合同，错误不互相吞掉 |
| TUI 旧数据缺字段校准 | shipped compatibility | 在已有 memo 内调用 Core；正常字段路径优先 |
| processor 二次覆盖、V1 独立 learner、UI 独立输入公式 | duplicate implementations | 删除 |
| 新日志、metrics、后台任务、cache service | unnecessary | 不新增 |

新增替代成功路径 0，新增诊断面 0。Core 不做网络或 DB 操作；既有失败、取消、权限链保持原样。

## 12. Workaround Deletion and Replacement

| Delete / collapse | Replacement |
| --- | --- |
| Core scalar 函数自身的 reduce/100K 学习公式 | 同一 `learnInputRatios` 的 number 包装 |
| V1 `learnInputCharsPerToken`、`collectInputRatio`、`clampCharsPerToken`、独立 MIN/MAX/学习窗口、source 回退类型 | Core 学习 + 小型 V1 输入形状适配 |
| V1 `estimateUploadInput` 及仅为其服务的已无消费者类型/helper | decide 使用 Core 请求估算；原准确性用例迁至真实 Core/适配缝 |
| V1 `inputRatioSample(part)` 的独立资格与媒体公式 | 只转换字段后调用 Core 归一；不得保留另一份数值规则 |
| processor 的 ratio 推导、input 覆盖 | `...estimate` |
| 采集器跨模型 `collect(false)` 与已有热 carrier 的冷恢复 | 同模型热元数据优先；旧格式只读域有界 |
| TUI 输入聚合、独立 2..8 钳位 | daemon 字段优先；旧域委托 Core |
| Context helper 先建全量 samples 再查已有 ratio | 先消费字段，旧域才准备 samples |

`estimateText`、附件 utilities 和现有必要 re-export 保留；不为压低行数删除不同职责。repo 搜索中旧 upload learner 的生产调用仅在上述 V1 路径，包为 private；不为没有证据的外部消费者增加兼容 wrapper。测试不能成为保留第二算法的理由。

## 13. Forward Traceability

| Requirement / invariant | Production path / file | Behavior / plan proof |
| --- | --- | --- |
| INV-01/03 精准与通用 | Core learner + estimateRequest | A1/A2；P01/P02 的独立 oracle 和真实确认回放 |
| INV-04/08 性能 | MessageV2 热采集 + Core 窗口 | A3；P03/P04，1180 carrier 等价与读/算计时 |
| INV-06 单源 | Core scalar、V1 adapter、processor、prompt、TUI accounting | A1/A4/A5；P01/P05，同源返回与真实消费者 |
| INV-05 字段语义 | Core 返回 text density | A2；P01 的媒体/旧样本检查 |
| INV-07 daemon/TUI | processor/native 发布、已有 info 字段、TUI 投影 | A4/A6；P05，JSON 字段交付真实 TUI 函数 |
| INV-07 缓存/实时输出 | 既有 Sync owner、accounting | A6/A7；P06/P07，多消费者、读取量和基线生命周期 |
| INV-02 连贯性 | compaction/select、message-v2历史投影保持现状 | 现有compaction/message-v2回归；本方案diff不改变保留集合 |
| 实施、verify、commit | 本plan、用户批准、独立实现审计与工作区边界 | §22用户批准；§23实现证据；§24独立实现审计 |
| 统一结构、实施细节与corner cases | §10请求链路、§15实施顺序、§16边界合同 | owner/字段/删除项/行为片可相互追踪；800行为篇幅建议 |

## 14. Reverse Traceability

| Proposed concept | Necessity / why reuse alone is insufficient |
| --- | --- |
| Core `inputRatioSample` | INV-06：各处重复样本资格；将同一数值规则收为真实共享缝 |
| Core `learnInputRatios` | INV-01/03：已有 scalar 无法表达不同载荷密度；不引入泛型拟合框架 |
| 最近确认校准 | INV-01：未校准候选实测 2.09% 比现行差；同一算法加入一个比例约束后约 0.89% |
| 每 assistant 一个确认点、最多20 | INV-04：复用 native/热 carrier 已有形状，避免从同消息重复训练与扩大冷解码 |
| 保留旧统计恢复预算 | INV-04/08：存量载荷仍可读，冷读取量不能随新窗口扩张；沿已有预算，不新建配置 |
| V1 `inputHistory` 适配 | INV-06：V1 结构不同，processor/collector/decide 三处复用，适配不拟合 |
| TUI 一个可选 legacy 数字样本 | INV-07：保留已存在旧数据校准，替代聚合，支持同一 Core 规则；无每消息数组 |

没有其他新服务、状态机、持久层、通用适配框架或 provider 特例。

## 15. File-Level Change Plan

下表集中表达关键 hunk，不另维护一份重复 diff；行为以 §10 为准，均为预计修改。

| File | Delete / replace with |
| --- | --- |
| `packages/core/src/util/token.ts` | 共用样本类型/归一/学习；scalar 薄包装；有界 inputHistory；visitor 不动，修改最终折算 |
| `packages/opencode/src/token/estimate.ts` | 删除独立学习与 upload 算法；保留附件/粗估；增加实际复用的 V1 数据适配 |
| `packages/opencode/src/session/message-v2.ts` | 热确认采样、旧统计预算、单模型采集；保留只读事务及 afterPartID |
| `packages/opencode/src/session/processor.ts` | 使用共享适配结果；删除二次学习和覆盖 |
| `packages/opencode/src/session/prompt.ts` | decide 改用已有 Core 请求估算；保留选窗流程 |
| `packages/tui/src/util/token-accounting.ts` | 正常密度直用、去独立输入学习、旧域数字样本、选中 request 的密度优先 |
| `packages/tui/src/util/context-usage.ts` | 已有 carrier 优先；仅缺字段才调用 Core 旧域学习 |

测试修改集中于现存文件：`core/test/util-token.test.ts`，`opencode/test/token/estimate.test.ts`，`opencode/test/session/{messages-pagination,processor-effect,prompt}.test.ts`，`tui/test/util/token-accounting.test.ts`，`tui/test/context-usage.test.ts`，`tui/test/cli/cmd/tui/sync.test.tsx`。原来的旧窗口/跨模型 source 断言按新合同替换为明确行为测试，不能整组删掉覆盖。

不修改 `core/src/session/info.ts`、`opencode/src/session/compaction.ts`、Schema、Server、SDK、Sync 实现和输出估算模块；`message-v2.ts` 仅改样本采集。共享 worktree 的其他改动必须保留。

实施按依赖顺序完成，每步以对应行为片的 red/green 驱动：

1. **Core 算法（A1/A2）**：在 token.ts 引入共享样本归一与学习，scalar wrapper 和请求折算同时转向它；visitor 保持原实现。先锁定独立已知密度、媒体和共线反例，再改变生产逻辑。
2. **daemon 数据与调用（A3/A4/A5）**：用 V1 adapter 接好热/旧确认采集，processor 消费 Core 结果，decide 消费完整 modelMessages。三个消费者迁完后删除旧学习/upload helpers 及其 source 类型、跨模型补样本；旧测试改为验证共享入口的行为。
3. **TUI 消费（A6/A7）**：在现有 measure/summarize/project 三阶段移除重复输入训练，保留旧数据的一个数字样本；context-usage 先查字段。输出、账本、Sync 生命周期沿当前实现，使用同一份冻结密度检验 message/footer/context 消费链。
4. **整体一致性**：执行 §18.5 的包内测试/typecheck 和同一组隔离反馈信号，检索 §12 删除项的全部调用者，核对实际 diff、原历史投影与注释预算，再进行实现审计。

## 16. TDD Behavior Slices

这些是把已在方案阶段证明的行为固化到仓库的实现顺序，不承担首次证明方案可行的责任。

| Slice | Public seam / red behavior | Minimal green / regressions |
| --- | --- | --- |
| A1 | Core scalar 与 request 输入使用同一确认集；混合已知密度场景现行误触发；混合共线样本后接纯文本时 pooled text 不得越界 | 唯一学习器、确认校准；text/reasoning 独立钳位；无历史、无 breakdown、共线、旧媒体域保留有限结果 |
| A2 | 请求各1.6M文本/推理，独立 /4 与 /16 oracle；媒体不能改变文本密度为205 | input≈500K、密度4、一次 visitor、media 只加一次、可选返回字段不变 |
| A3 | MessageV2：20 个确认热 carrier 可取，冻结对应 parts 不应触发这些 parts 的恢复 | 最近一确认点、冷热等价、legacy 恢复预算、hidden/model/Session 隔离、水位一致 |
| A4 | processor prepared 结果必须原样进入请求投影，不再被旧 ratio 覆盖 | 确认前后、零确认、retry 中断、水位与费用基线不变 |
| A5 | V1 decide 用真实 modelMessages 保留 reasoning/媒体分类；换模型不借其他模型样本 | Core 估算、reminder一次、既有选窗阈值；消除 upload 第二算法 |
| A6 | TUI 有 daemon ratio 时输入校准字段读取应消失；旧域 scalar 仍可学习 | 输出校准不变；prepared/confirmed、历史 request、无消息投影、尾部去重 |
| A7 | 真实 Sync 多消费者共享数字，更新一消息不读取其他正文；释放/重连保持 owner | 复用既有缓存，不新增状态机；同一 Session 对象旧入口仍可读共享结果 |

每片按 red → 最小实现 → green → 原回归推进。期望来自独立已知密度、provider 确认或集合语义；不复制拟合公式充当 oracle，不测试私有 helper。性能断言观察公开 fixture 的载荷访问/数据读取量，不 mock 私有函数调用次数。

下列边界细化同一组行为片，测试仍通过表中已有 public seam：

| Reachable case / source | Expected result | Slice / evidence |
| --- | --- | --- |
| 首轮、累计字符500/501、零或非有限输入；Core现有资格合同 | 无合格历史或不足门槛用4；501字符/167输入为3；无效点不污染后续合格点 | A1；P01与现有util-token测试 |
| 缺breakdown、单桶、共线；旧持久格式与真实reasoning载荷 | 只用可辨识信息；text始终≤8、reasoning≤32，5M纯文本反例≥625K | A1/A2；P01/P02 |
| 大图、全媒体、旧附件缺media.tokens；AttachmentToken/旧记录 | 媒体独立追加一次；缺分离信息的旧样本不训练；JSON getter/toJSON仍只观察一次 | A2；P01、现有visitor/media测试 |
| 同assistant多step、新prepared、retry中断、正样本后的零输入finish；processor同step写入 | 每assistant仅取最近合格确认点；没有合格热确认时选既有finish；新body不与旧usage组合，carrier/finish不重复 | A3/A4；E03/E04的生产链，P03核验热/冷等价；多step由fixture固化 |
| 换API模型、hidden/undo、不同Session；现有采集过滤 | 只取所属Session与同provider/model的可见确认；无同模型样本用默认值，afterPartID仍取当前消息可见水位 | A3/A5；E04、messages-pagination及compaction回归 |
| 热确认已归档、旧finish在cold层、旧恢复预算耗尽 | 热carrier不恢复parts；旧路径累计全部恢复step到100K后停止找旧点；恢复错误保持原失败通道 | A3；P03/P04、现有cold fixture |
| current request先到、正文未到、显式历史request、缺密度旧消息 | 消费所选request的字段；历史不借active的密度，current缺估算不借旧request；旧样本只在原memo中进入Core | A6/A7；P05/P06、request-usage与Sync回归 |
| usage缺失/全轴零报告、合法零输入且输出为正、prepared后工具返回 | 原有零用量/中断显示保持；有效确认的零输入仍为零；afterPartID前工具不重复计入，后续工具按原增量规则加入 | A4/A6；token-estimate:74-108,124-156及既有测试 |

## 17. Chinese Comment Budget

预计有效新增/实质修改代码 `E≈200`（生产）+`320`（测试）=`520`，`C>=ceil(520×0.15)=78`。实施时按真实 E 重算；删除、纯移动、import-only、格式化不增加 E。

需要解释的决策：不同载荷密度、确认锚点、可辨识性、旧样本缺字段、媒体独立计量、热快照等价、每 assistant 单样本、旧恢复 I/O 预算、样本顺序/重试可重复消费、请求字段归属、TUI 输出独立、缓存释放。测试注释解释相应行为与独立期望来源。不得用复述赋值、重复测试名或拆行凑数满足比例。

## 18. Plan-Stage Acceptance and Evidence

**本节是提出 plan 的责任，以下项目已经执行；不是把精度/性能承诺转交给实施者。** 计时是同机隔离对照，工作量约束和当前调用链同时支持设计结论。统计精度针对明确记录的真实确认样本，不把回归预测当成未发出请求的实际 token。

### 18.1 复现方法

- `bun D:\Temp\opencode\compaction-r4-evidence.ts`，cwd=`packages/core`。2026-11-07执行通过。读取源码，在内存替换候选学习/折算与 TUI 输入校准；保留真实 visitor、AttachmentToken、TUI 输出/账本函数。以下结果对应 HEAD `219f2a416d`，包含共线反例和每 assistant 直接阈值计数。
- SQLite 通过 `{ readonly: true }` 和 `PRAGMA query_only=ON` 打开用户指定 `opencode.db`；使用当前 `cold-codec` 的纯解码/恢复函数恢复统计，核验 hash/字段，不 thaw、不回填、不上传 DB。
- 恢复两个指定 Session 的1180个有效确认点，含1027个cold点；回放按 session/provider/model 分组，每个预测只使用此前数据。1176个点可评估，4个序列首点无历史，不计入在线 MAPE。

### 18.2 已完成的方案验收

| ID | Plan acceptance | Observed result |
| --- | --- | --- |
| P01 | 已知密度请求不被单比率抬过580K；scalar/request同源；pooled各桶独立限幅；媒体/冷启动合同可承载 | 现行680016 → 候选500010，独立期望约500000；scalar=4；10000条迭代输入只消费20条。共线反例得到text=8、reasoning=31.7778，5000000字符纯文本input=625002；旧小样本/非法确认/媒体检查通过 |
| P02 | 在完整冷热确认回放上，整体误差改善且580K误判不增加 | 修正后每assistant直接回放：MAPE现行1.8498067% → 候选0.8932217%；现行FP=0/FN=1，候选FP=0/FN=1。未校准候选2.0899183%、FP=18仍被拒绝 |
| P03 | 热 carrier 是同一确认事实，不以省读取改变样本 | 1180个carrier与最近finish的bodyChars、确认输入、breakdown结构一致，0不一致；这些样本均为独立assistant |
| P04 | 采样加估算关键路径性能不下降，并有收益 | 3,200,073字符请求、120次交错对照：旧取样解码+估算 P50=8.2037ms/P95=11.2499ms；候选热读取+估算 P50=6.5539ms/P95=10.0896ms。热20点读取+学习 P50=0.0840ms/P95=0.1564ms |
| P05 | 沿已有字段交付真实 TUI 消费逻辑，无需新协议 | Core结果经JSON字段交付给现有TUI函数，显示input=500010、density=4；新增字段0；三个共享消费者结果与基线一致且不回读正文 |
| P06 | TUI 正常输入校准工作消除，保留统计行为并改善开销 | 300消息：输入校准字段读取900→0；summary P50=0.1900→0.1156ms、P95=0.3741→0.2478ms；账本/输出等值，旧数据ratio=8保留 |
| P07 | 既有缓存身份/释放合同有当前基线支撑，修改不触及owner | 下列基线共31个测试通过；shareAccounting真实函数多消费者探针不读取消息正文；不添加缓存数组、额外订阅或UI网络调用 |

P04 的计时范围是实际样本字节解码/热元数据读取加真实请求估算函数，不包含模型网络、全部 Effect 服务装配或完整交互帧。它直接覆盖本次改变的成本来源；方案没有新增这些范围之外的网络、持久写入或后台工作。单独 visitor 的小幅计时波动不被冒称为优化，主要收益来自删除冷读取和重复计算。

旧数据性能由 §10.2 的既有恢复预算约束，不扩大恢复集合；正常热确认不进入冷恢复。

### 18.3 当前基线命令

| Command | cwd | Result |
| --- | --- | --- |
| `bun test test/util-token.test.ts` | `packages/core` | 6 pass / 0 fail，67 expectations |
| `bun test --timeout 30000 ./test/util/token-accounting.test.ts ./test/util/token-estimate.test.ts ./test/request-usage.test.ts ./test/cli/cmd/tui/sync-snapshot-reuse.test.ts` | `packages/tui` | 15 pass / 0 fail，124 expectations |
| `bun test --timeout 30000 ./test/cli/cmd/tui/sync-parts-lifetime.test.tsx` | `packages/tui` | 10 pass / 0 fail，27 expectations；Windows fixture打印缺失 `\tmp\opencode\state\kv.json` 警告，非零失败数为0，未改生产配置消音 |

上述为当前生产源码的基线测试；候选算法与字段消费的方案验证见 §18.1/§18.2。实际生产修改仍需完成 §18.5 的集成检查。

### 18.4 历史触发的解释与边界

已校准预测（UTC）：11-05 21:33→568285，21:36→798506；11-06 04:40→587550，07:41→579833，13:26→562418，13:34→584126。这些值由保存的bodyChars/breakdown重估；原584722也来自 `inputEstimate.input`。未发送请求缺少provider确认输入，双连发的具体因果关系保持待核实。

0.89%不是对所有未来模型的保证，也没有声称零误差：当前确认样本还有1个阈值漏判，未比现行增加。泛用性来自按同API确认数据自学习、既有协议分桶与媒体owner，而非把15.5固定成GPT专用常量。

### 18.5 实施一致性检查清单

方案可达性已由18.2证明；将来实施仍须证明真实diff与本设计一致，不能把这些后续命令作为本轮达标证据：

- `packages/core`：`bun test test/util-token.test.ts test/session-compaction.test.ts test/session-runner-model.test.ts`；`bun typecheck`。
- `packages/opencode`：`bun test test/token/estimate.test.ts test/session/messages-pagination.test.ts test/session/processor-effect.test.ts test/session/prompt.test.ts test/session/compaction.test.ts test/session/message-v2.test.ts`；`bun typecheck`。
- `packages/tui`：`bun test --timeout 30000 test/util/token-accounting.test.ts test/util/token-estimate.test.ts test/context-usage.test.ts test/request-usage.test.ts test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-snapshot-reuse.test.ts test/cli/cmd/tui/sync-parts-lifetime.test.tsx`；`bun typecheck`。
- 复跑P01–P07相同反馈信号，核对正常热样本零冷恢复、旧恢复集合不扩大、同一visitor、字段归属、三个UI消费者不重读正文。
- 搜索确认独立学习与二次覆盖已删除；检查无新增配置/字段/服务；真实E/C达到15%。

## 19. Diff Budget

| Metric | Budget / rationale |
| --- | --- |
| Production files | 7个现存文件，见§15；覆盖现有重复学习的全部消费者 |
| Production delta | 约+180至240 / −130至190，净增约50至110；主要是归口与删除，不是新子系统 |
| Test files / lines | 8个现有测试文件，约+320有效代码；按行为片逐个落实 |
| New modules/services、Schema/Protocol/migration/generated、runtime caches/settings/background jobs | 均为0 |

数字是范围估计，用户不要求逐行可应用diff。完整性以责任、接线、删除和已验证逻辑为准，不为凑文件/行数保留重复实现。

## 20. Real Risks and Open Decisions

- 真实统计估算存在残差；P02已经报告剩余FN，不能把估算精度当成provider确认或费用真值。
- 本次生产样本每个assistant只有一个确认点；多step采用最近合格点及旧恢复预算由 §10.1/§10.2 定义，A3 固化，不能重复采样或扩大冷解码。
- 归档输入的JSON字段顺序可能改变；确认等价核验使用结构比较，不用JSON字符串相等误报不一致。
- 当前worktree存在其他任务对processor/prompt/compaction的修改；实施必须基于当时内容，仅修改本职责，不能覆盖或回退其他工作。

### Open Decisions Requiring the User

无产品或架构选择需要用户再决定。用户已批准R6的当前范围，并授权实施、独立实现审计和commit。

### Rejected Speculation / Rejected Routes

- 固定 GPT 密度15.5或统一放宽到32：不能表达载荷组成；未校准双比率：P02证明误差退步。
- 新增全局缓存、token service、模型注册表、专用SSE或后台训练：直接使用已有热确认/发布字段已覆盖需求。
- TUI各视图重复学习或统一重写tail/prune/输出估算：前者是应删除的重复工作，后者属于不同职责。

## 21. Audit Contract

R6按§1最新用户指令批准。实施完成后，由独立auditor按当前完整范围审计所有实际diff、token估算与字段消费、边界合同、精度/性能证据、删除项及中文注释，并核对既有压缩保留行为保持。revision按审计轮次连续编号；800行为篇幅建议。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01（采集侧100K字符预算使学习断供） | §2/§20交集、E/C口径、滑窗实验、scalar合同记录 | BLOCK | task ses_e4eb8a93fffeTaTOJAGbkZXkC2 |
| 2 | R2 | yes | No blocking findings | N-01数值记录、N-02字段交接、N-03观察缝 | APPROVE | task ses_e4e970b42ffeujR5mv20om1JA3 |
| 3 | R3 | yes | B-01 pooled text密度越界；B-02 replay reserve计入被移除媒体 | N-01直接记录每assistant回放阈值计数 | BLOCK | task ses_e4d45edd6ffej5jINq4L8FOG4v |
| 4 | R4 | yes | No blocking findings | No non-blocking findings；R3 N-01已解决 | APPROVE | task ses_e4d45edd6ffej5jINq4L8FOG4v（full-scope resume） |
| 5 | R5 | yes | B-01 replay预算遗漏实际保留的原始整轮 | 无另列的非阻塞问题 | BLOCK | task ses_e4bd5a663ffeGNyS8uLkiPaSGq |

### Round 3 — R3 independent verdict

## Blocking findings

### B-01 The validated pooled-density branch violates the text-density ceiling and can suppress required compaction

- Violated invariant: INV-01 and INV-05 require composition-sensitive estimation and a text incremental density; §10.1 also specifies `text ∈ [2,8]` and `reasoning ∈ [2,32]`. The plan-stage prototype must implement the same algorithm whose accuracy is being accepted.
- Evidence class: reachable
- Producer and execution path: A confirmed request containing both ordinary text and encrypted reasoning produces a valid `inputEstimate` sample → a single or collinear sample set enters the pooled branch of `learnInputRatios` → the pooled value is returned as both text and reasoning density → a later plain-text request is estimated with that text density → V1 preflight uses the result for the 580K compaction decision.
- Source evidence: `D:\Temp\opencode\compaction-r4-evidence.ts:51-58` caps the pooled value at 32 whenever reasoning is present and returns it for both buckets; `:71-76` preserves that behavior in the anchored candidate. The existing Core scalar path caps text at 8 in `packages/core/src/util/token.ts:29-44`. The resulting input reaches the overflow decision at `packages/opencode/src/session/processor.ts:1219-1224`.
- Canonical-plan evidence: §7 INV-01/INV-05; §10.1, especially the stated per-bucket ranges and `charsPerToken = rText`; §18.2 P01/P02 uses this prototype as the accuracy evidence.
- Responsibility owner: `packages/core/src/util/token.ts`, specifically the single `learnInputRatios` implementation.
- Concrete behavioral consequence: For one identifiable-looking but collinear sample with `T=1,000`, `R=1,000,000`, and confirmed non-media input `I=31,500`, the validated prototype produces a pooled density of approximately `31.78` for **text**, contradicting the required maximum of 8. A subsequent 5,000,000-character plain-text body is estimated at approximately 157K tokens instead of at least 625K under the existing text ceiling, moving it from compaction-required to below the 580K trigger. The published `charsPerToken` can likewise exceed the text contract consumed by TUI. Thus the accuracy numbers do not validate a single, internally consistent R3 algorithm.
- Minimal correction direction: Keep the single learner, but clamp pooled text and reasoning independently—text always within `[2,8]`, reasoning within `[2,32]`—add a mixed/collinear-history-to-plain-text regression, and rerun P01/P02 with the exact corrected algorithm.

### B-02 Replay reserve measures media that the actual replay removes, causing unnecessary tail loss

- Violated invariant: INV-02 requires the budget to account for the history actually retained after compaction without changing normal replay behavior. The reserve must therefore measure the replay projection that is really persisted.
- Evidence class: reachable
- Producer and execution path: A prior user message contains a large inline image → overflow compaction selects that original message as `replay` → R3 computes `replayReserve` using the existing `estimate()` → `select` subtracts it from the tail budget → after a successful compaction, the replay writer converts that image to a short `[Attached …]` text placeholder before persisting the new replay message.
- Source evidence: The existing estimator calls `toModelMessagesEffect` without `stripMedia` at `packages/opencode/src/session/compaction.ts:343-350`; ordinary conversion retains file parts at `packages/opencode/src/session/message-v2.ts:744-756`, whereas the media-stripping branch is conditional on `stripMedia` at `:745-749`. The actual overflow replay performs that media-to-placeholder rewrite at `packages/opencode/src/session/compaction.ts:682-693`.
- Canonical-plan evidence: §10.5 directs reuse of the existing `estimate()` on the original replay segment and subtracts the result from `preserveRecentBudget`; §16 B1 and §18.2 P08 cover text-only large/small replays but not the different media projection.
- Responsibility owner: V1 `SessionCompaction.process`, at the replay-reserve producer feeding its private `select` budget.
- Concrete behavioral consequence: A multi-megabyte data-URL image can drive `replayReserve` above the entire preservation budget and force `tail_start_id` to `undefined`, even though the actual replay contains only a short attachment label and the eligible tail would fit. This introduces a new loss of recent context rather than repairing the repeated-compaction defect.
- Minimal correction direction: Compute `replayReserve` from the same media-stripped replay-user projection that will be persisted, leave ordinary tail estimation unchanged, and add an inline-media replay with an otherwise eligible retained tail to B1/P08.

## Non-blocking findings

### N-01 Record the metrics from the actual one-sample-per-assistant replay

§10.1/§10.2 specify one confirmation point per assistant, but the MAPE and threshold counts quoted in P02 come from the per-step loop at `D:\Temp\opencode\compaction-r4-evidence.ts:254-279`. The separate per-assistant replay at `:281-310` records MAPE but not FP/FN.

This is a record-quality note because §18 states that all 1,180 accepted samples are independent assistants, which would make the populations equivalent. No contrary dataset result was inspected. When rerunning the corrected experiment for B-01, record the per-assistant MAPE and threshold counts directly so the acceptance table unambiguously matches the shipping sampling contract.

## Rejected speculation

No additional concerns were elevated from hypothetical malformed persisted data, future provider encodings, unsupported media shapes, or imagined cache lifecycle failures.

In particular, the existing bounded legacy restoration path remains a valid compatibility branch; the audit does not demand a new cold-storage format or decoder merely because `ColdStorage.inspectPartStats` has a narrower statistical purpose.

## Requirement and traceability coverage

The audit covered the complete §1 timeline, including:

- Read-only investigation of the named Sessions and GPT-6/GPT-6.1 ASTRA/SOL concerns.
- The existing 600K context and 580000 usable trigger, which R3 correctly leaves unchanged.
- Confirmed provider usage versus estimation, including cache read/write and media separation.
- Encrypted and visible reasoning density differences.
- Minimal, generalized, performant repair with one Core learning implementation.
- Daemon-owned request estimation and compaction, existing fields delivered to TUI, and TUI-owned caching/live increments.
- The latest requirement to reach plan approval through an independent full-scope audit without implementation.

The inspected producer-to-consumer paths included:

- Core native request, compaction, decide, and reviewer callers.
- V1 metadata collection, processor preflight/publication, and decide-window selection.
- Existing `Session.request` projection into TUI accounting and context usage.
- TUI per-message/session memos, historical request selection, output calibration, and tail accounting.
- Cold-message carriers and bounded legacy step restoration.
- Overflow replay selection, persisted tail projection, and media-stripped replay creation.

Forward and reverse traceability are present and generally restrained: eight existing production files, no new service/configuration/protocol surface, and behavior slices for each changed region. B-01 and B-02 nevertheless leave two confirmed behavior paths inconsistent with their stated invariants and acceptance evidence.

## Primary-path and fallback verdict

The architectural direction satisfies the single-primary-path requirement:

- Core owns the only learning and request-estimation algorithm.
- V1 and native callers adapt data rather than maintain competing learners.
- TUI consumes daemon densities and retains only the shipped legacy-data compatibility branch.
- Existing `/4` cold-start behavior is not a new alternate success path.
- No new cache service, background training, provider-specific density table, or diagnostic success path is proposed.

The replay-reserve repair is also located in the correct owning module, but its input must be the exact replay projection. The plan therefore has a sound primary architecture with two blocking behavioral mismatches, not a fallback-family problem.

## Code quality and Chinese-comment verdict

This is plan mode; there is no implementation diff from which to compute actual `E` and `C`.

The plan commits to approximately `E = 520` and `C ≥ ceil(520 × 0.15) = 78`, with the correct exclusions for imports, formatting, generated code, deletion, and pure movement. The proposed comment topics concern real invariants and behavioral boundaries rather than code narration. The estimate is feasible and satisfies the implementation target; actual implementation will still require independent recomputation.

No implementation tests, typechecks, or code-style approval is implied by this plan audit.

## Release verdict

**BLOCK** for exact revision **R3**.

Plan Verified is not achieved, and `Implementation allowed` must remain `no`. B-01 and B-02 require a revised revision followed by another full-scope audit.

Unverified required items in this audit:

- The numerical outputs of `compaction-r4-evidence.ts` and `compaction-r4-boundary-proof.ts` were inspected as experiment code but not independently re-executed.
- The three baseline test commands in §18.3 were not independently rerun.
- Consequently, the recorded MAPE, timing percentiles, carrier counts, and baseline pass counts remain builder-recorded results rather than independently reproduced outputs; they were not used to waive either blocker.

### Round 4 — R4 independent verdict

## Blocking findings

No blocking findings.

## Non-blocking findings

No non-blocking findings.

R3 N-01 is resolved: P02 now reports the direct per-assistant MAPE and FP/FN counts, and the experiment computes those values through the one-latest-confirmation-per-assistant path at `D:\Temp\opencode\compaction-r4-evidence.ts:287-328`.

## Rejected speculation

No additional concerns were promoted from hypothetical future provider formats, malformed persisted data, unsupported cache lifecycles, or demands for zero statistical error.

The following remain documented boundaries rather than defects:

- P02 retains one threshold false negative and explicitly disclaims universal future-model accuracy.
- P04 measures the changed sampling and estimation work, not model networking or complete UI frame time.
- The legacy TUI calibration branch is an explicitly preserved shipped-data compatibility path, not a newly invented alternate success path.
- No additional cold-storage schema, decoder, global cache, provider guard, or background task is justified by the inspected evidence.

## Requirement and traceability coverage

The audit covered the complete §1 requirement timeline and all R4 changed regions, not merely the two repaired hunks.

The following behavior and ownership paths remain correctly mapped:

- **Precision and generalized learning:** Core owns sample qualification, media normalization, bounded learning, dual-density fitting, recent-confirmation calibration, and final request estimation.
- **Confirmed versus estimated usage:** Provider-confirmed input remains `input + cache.read + cache.write`; estimates do not overwrite confirmed billing or token ledgers.
- **Reasoning and media:** Text, encrypted/plain reasoning, and media use the existing visitor and `AttachmentToken` ownership rather than provider-specific constants.
- **Single-source architecture:** V1’s duplicate learner and processor override are removed; native callers continue through Core; TUI consumes existing daemon fields.
- **Bounded sampling:** Hot confirmed carriers avoid redundant cold restoration, while legacy recovery retains its existing 100K I/O budget and model/session/hidden filtering.
- **Daemon/TUI responsibilities:** Daemon retains request and compaction authority; TUI retains output calibration, memoized accounting, live tails, `afterPartID` deduplication, and existing cache ownership.
- **Compaction behavior:** The 600K/580000 limits are unchanged, and replay budgeting remains inside V1 `SessionCompaction`.
- **Delivery scope:** No implementation, schema, protocol, SDK, migration, new service, configuration, or commit is included.

The two R3 blockers are directly resolved:

1. **Pooled densities:** §10.1 now independently clamps text to `[2,8]` and reasoning to `[2,32]`. The prototype implements that rule at `D:\Temp\opencode\compaction-r4-evidence.ts:51-58,71-76`, with the R3 counterexample asserted at `:107-113`. P01 records `text=8`, `reasoning≈31.7778`, and plain-text input above 625K.
2. **Replay media:** §10.5 now computes reserve through `toModelMessagesEffect(..., { stripMedia: true })`, matching the actual replay writer at `packages/opencode/src/session/compaction.ts:682-693`. Ordinary tail estimation remains unchanged. P08 and `D:\Temp\opencode\compaction-r4-boundary-proof.ts:33-50` cover both the original giant-text defect and the inline-media tail-preservation case.

Forward and reverse traceability remain complete, with behavioral slices A1–A7 and B1 covering each proposed production concept and its consumers.

## Primary-path and fallback verdict

R4 preserves one authoritative semantic path per responsibility:

- One Core learning implementation and one request JSON visitor.
- Shape adapters rather than competing V1/native/TUI learning algorithms.
- One V1 compaction selector receiving the actual replay-adjusted budget.
- Existing `/4` cold-start behavior and persisted-data compatibility branches, with no new failure-triggered alternative success path.
- No new diagnostic surface, cache service, provider-specific fitting branch, or background recovery mechanism.

The repairs improve the existing primary paths rather than bypassing their first divergences.

## Code quality and Chinese-comment verdict

This is plan mode, so no implementation diff exists for an actual `E/C` calculation.

The plan maintains `E≈520` and `C≥78`, which meets the 15 percent implementation target with the correct exclusions. Its proposed comments concern density bounds, confirmation anchoring, media ownership, sampling budgets, replay projection, and behavioral test intent rather than code narration.

The added use of the existing `stripMedia` projection is justified by INV-02 and does not introduce a new dependency, media conversion rule, public interface, or duplicate projector.

## Release verdict

**APPROVE** for exact revision **R4**, at full original scope.

R4 may record this clean verdict and transition to `approved`/`Approved revision: R4` under the repository workflow. This verdict does not audit or authorize an implementation diff.

Unverified required items and verification boundaries:

- This auditor did not independently re-execute `compaction-r4-evidence.ts`, `compaction-r4-boundary-proof.ts`, or the three §18.3 baseline test commands.
- The recorded MAPE, timings, carrier counts, and test totals therefore remain builder-recorded numerical results. The corresponding source, assertions, call paths, and R4 corrections were inspected directly and no contradictory evidence was found.
- Production integration tests, typechecks, actual diff review, and actual implementation `E/C` remain future implementation-phase gates, not missing evidence for this plan-only approval.

### Round 5 — R5 independent verdict

## Blocking findings

### B-01 Replay 预留预算计算了新复制的 user，漏掉实际被 tail 边界保留的原始整轮

- **Violated invariant:** INV-02 要求预算覆盖最终 `[tail_start, marker)` 保留集合，避免巨轮被隐式带回；INV-08 要求方案阶段证明这一修复有效。
- **Evidence class:** reachable
- **Producer and execution path:**
  1. V1 prepared 预检返回 `compact`，prompt 调用 `compaction.run`。
  2. `processCompaction` 找到最后一个普通 user，将它保存为 `replay`，同时从待选择历史中切走**该 user 及其后的全部 assistant**。
  3. R5 只扣除 `stripMedia([replay])` 的大小，然后在剩余历史中选择 `tail_start_id`。
  4. 摘要成功后，`filterCompacted` 按持久化边界重新保留完整 `[tail_start, marker)`。此前切走的原 user 和后续 assistant 都位于这个区间。
  5. writer 的媒体替换只作用于摘要后**新复制的 user**，没有改写区间中的原 user 或 assistant。
- **Source evidence:**
  - `packages/opencode/src/session/prompt.ts:2258-2267`：真实自动压缩入口。
  - `packages/opencode/src/session/compaction.ts:478-485`：`replay` 只保存 user，`slice(0, i)` 却切走整个后续区间。
  - `packages/opencode/src/session/compaction.ts:536-540`、`:650-662`：选择并持久化 tail 边界。
  - `packages/opencode/src/session/compaction.ts:665-693`：媒体替换只写入新建 replay message。
  - `packages/opencode/src/session/message-v2.ts:1523-1528`：恢复整个原始 `[tail_start, marker)` 区间。
  - `packages/opencode/src/session/message-v2.ts:744-756`：普通投影保留原 file；媒体替换受 `stripMedia` 参数控制。
  - `packages/opencode/test/session/message-v2.test.ts:2952-2984`：现有测试明确锁定 marker、summary、完整 retained tail、后续消息的投影顺序。
- **Canonical-plan evidence:** §10.5，`docs/plans/compaction-trigger-precision-repair.md:264-274`；§16 B1；§18.2 P08。
- **Responsibility owner:** V1 `SessionCompaction.processCompaction` 中，构造实际保留集合并向 `select` 提供预算的调用点。
- **Concrete behavioral consequence:** 对以下合法历史：
  ```text
  较早 head → 小 tail → 短 user U → 多个较大 assistant/tool 结果 A → marker
  ```
  R5 扣除的只是短 user U 的预算，因此仍可选中小 tail。最终上传历史却成为：
  ```text
  marker → summary → 小 tail → 原 U → 完整 A → 新复制 U
  ```
  较大的 A 完全漏算，巨轮仍会被带回，继续违反保留预算，并在足够大时再次触发压缩。若 U 含媒体，原 U 的媒体也仍然存在；新副本的占位文本不能代表原区间的大小。

  P08 没有检验这条消费链：`D:\Temp\opencode\compaction-r4-boundary-proof.ts:18-29,33-50` 只将独立计算的 reserve 传给 selector，未构造压缩后的完整历史，也未执行 `filterCompacted` 检查最终保留内容。因此，“媒体场景仍保留 tail”的断言不能证明原媒体或巨大 assistant 已被移除。
- **Minimal correction direction:** 在现有预算入口按 marker 前实际会保留的完整后缀计量，复用既有历史投影，并通过压缩后 `filterCompacted → toModelMessages` 验证最终集合，避免用新复制 user 的投影替代原始整轮。

## Non-blocking findings

无另列的非阻塞问题。R5 的 revision 元数据与所记录的四轮历史审计连续，800 行按篇幅建议处理。

## Rejected speculation

以下事项没有升级为阻塞：

- 不要求统计估算对所有未来模型零误差；P02 已明确保留一个阈值漏判。
- 不因缺少未来 provider 格式的证据要求增加解析器、保护分支或固定模型密度。
- 现有 `/4` 冷启动、旧数据缺字段时委托 Core、旧统计只读恢复，均有现存输入域支持。
- 不要求新增全局缓存、协议字段或重写 Sync 生命周期。
- 不将共享工作树中的其他任务改动、现存无关缺陷纳入本次修复。

## Requirement and traceability coverage

本轮覆盖 §1 完整需求及八个计划生产文件，独立检查了以下路径：

| 范围 | 审计结论 |
|---|---|
| 确认 usage、缓存输入与估算的区别 | 使用 `input + cache.read + cache.write` 校准、保持费用账本独立，路径明确 |
| 文本、reasoning、媒体估算 | Core 单一学习器、独立密度钳位、最近确认校准、既有 visitor 的设计与隔离原型一致 |
| V1 样本读取和 prepared 发布 | 热 carrier、旧 finish、同模型过滤、水位及删除二次覆盖都有明确实施位置 |
| native 普通请求、摘要、decide、reviewer | 已有 Core 调用可复用；样本改为可重复消费的有界数组符合重试调用方式 |
| TUI 输入密度与实时增量 | 字段优先、历史请求归属、输出独立校准及现有 memo 生命周期有对应路径 |
| 冷数据和性能 | 检查了热字段保留、既有恢复接口、实验计时范围及工作量探针 |
| 压缩保留与连续触发 | **B-01 未通过：预算对象与持久化后的消费集合不一致** |
| 交付范围 | 当前为 plan-only，生产、测试、配置和数据库均未修改 |

A1–A7 的主要行为断言能够区分当前重复学习、旧窗口和二次覆盖行为。B1/P08 需要把观察点推进到最终历史投影，才能验证原始连续压缩问题。

本轮直接读取了两个隔离实验脚本及相关源码、测试；没有重新执行脚本或测试。MAPE、计时百分位、1180 个 carrier 等价结果及基线通过数量仍是计划记录的运行结果，本轮未独立复现。

## Primary-path and fallback verdict

单源架构方向成立：

- Core 拥有唯一输入学习与请求估算规则。
- V1 适配消息形状，processor 消费 Core 结果。
- daemon 拥有请求估算和 compaction 决策。
- TUI 消费既有字段，并保留显示增量及输出校准。
- 未发现计划新增失败后替代成功路径；新增诊断面为零。

压缩修复也位于正确模块，但 **B-01 表明该入口仍未计量真实保留集合**。修正应继续收敛在现有选择和投影路径，不需要增加另一套 replay 机制。

## Code quality and Chinese-comment verdict

本轮为方案审计，没有本任务 implementation diff 可计算实际 `E/C`。

§17 承诺：

- 预计 `E ≈ 520`；
- `C ≥ 78`；
- `C/E = 15%`；
- 实施时按实际差异重算，排除 import-only、格式化、生成、纯移动等行；
- 注释解释密度、确认归属、媒体、读取预算、缓存和保留集合等真实约束。

该承诺满足方案阶段要求。实际代码质量、测试结果及中文注释比例仍须在实现审计中核验。

## Release verdict

**BLOCK — exact revision R5。**

B-01 阻止 Plan Verified。保持 `Approved revision: none`、`Implementation allowed: no`；修正实际保留集合与对应验证后，按完整原始范围进入下一轮审计。

### R6 用户批准

批准来源：§1最新用户原文。当前范围 `approved`，`Approved revision: R6`，`Implementation allowed: yes`；实施后进行独立全范围实现审计。

## 23. Implementation Evidence

### 23.1 实际改动与红绿证据

- 生产7文件：`core/src/util/token.ts`；`opencode/src/token/estimate.ts`、`session/message-v2.ts`、`session/processor.ts`、`session/prompt.ts`；`tui/src/util/token-accounting.ts`、`util/context-usage.ts`。
- 行为测试6文件：`core/test/util-token.test.ts`；`opencode/test/token/estimate.test.ts`、`session/messages-pagination.test.ts`、`session/processor-effect.test.ts`；`tui/test/util/token-accounting.test.ts`、`context-usage.test.ts`。既有prompt与Sync测试直接复用，未为同一行为增加重复fixture。
- 实际任务diff为13文件、约`+495/-223`；生产约`+265/-207`，测试约`+230/-16`。共享worktree中预先staged的无关改动不属于此统计。
- Core混合文本/reasoning用例先以`680016`失败，独立期望约500K；实现后`500010`，scalar为4，10000个输入只消费20个。共线样本保持text=8、reasoning≈31.7778，5M纯文本估算625002。
- MessageV2热carrier测试先因读取归档finish而失败，实现后热路径`parts=[]`且保留20点；processor测试先观察到旧覆盖密度`4.705882...`，实现后为Core的4。TUI正常消息校准读取由3降为0，历史request密度由错误的4修正为所属请求的2。

### 23.2 包内验证

| cwd / command | Result |
| --- | --- |
| `packages/core`: `bun test test/util-token.test.ts test/session-compaction.test.ts test/session-runner-model.test.ts` | 27 pass / 0 fail / 205 expectations |
| `packages/core`: `bun typecheck` | pass |
| `packages/opencode`: `bun test --timeout 30000 test/token/estimate.test.ts test/session/messages-pagination.test.ts test/session/processor-effect.test.ts test/session/compaction.test.ts test/session/message-v2.test.ts` | 255 pass / 1 skip / 0 fail / 914 expectations |
| `packages/opencode`: `bun test --timeout 30000 test/session/prompt.test.ts --test-name-pattern "^(decide|auto compaction resumes|preflight estimates)"` | 4 pass / 0 fail / 29 expectations |
| `packages/opencode`: `bun typecheck` | pass |
| `packages/tui`: §18.5所列7个测试文件 | 100 pass / 0 fail / 715 expectations；Windows fixture打印既有KV路径警告 |
| `packages/tui`: `bun typecheck` | pass |
| 仓库根： `git diff --check` | pass |

独立实现审计第2轮在同一13文件diff上另跑完整`bun test --timeout 30000 test/session/prompt.test.ts`，结果为126 pass / 15 skip / 0 fail / 681 expectations；与上述非prompt测试合并后覆盖§18.5的完整六文件集合。

### 23.3 原反馈、路径与注释

- `packages/core`: `bun D:\Temp\opencode\compaction-r4-evidence.ts`通过。实际Core对应anchored路径：1176个在线点MAPE由1.8498067%降为0.8932217%，阈值FP/FN均为0/1；未锚定对照为2.0899183%、FP=18。1180个assistant确认点全部接受，含1027个cold点，carrier/finish不一致为0。
- 300条正常消息的输入校准字段读取900→0；summary P50/P95为0.4033/0.6904→0.1931/0.5127ms。交错的真实样本读取加请求估算P50/P95为7.0338/10.2483→5.6478/7.5165ms；热20点读取加学习P50/P95为0.1685/0.3254ms。
- 唯一主路径是Core样本归一、学习与请求折算。V1热carrier/finish和TUI旧域样本是既有持久形状的兼容适配；输出学习、账本、Tail/replay、Sync owner不变。未新增服务、协议字段、设置、迁移、后台任务、失败后替代成功路径或诊断面。
- 已删除V1独立总比率学习、upload第二算法及processor二次覆盖；全仓搜索旧helper无调用。独立审计按实际diff重算`E=384`、有效中文解释注释`C=79`，排除空行、import-only、纯格式化、纯移动与删除，`ceil(E×0.15)=58`，`C/E=20.57%`。
- 历史值仍是保存的`inputEstimate.input`而非provider确认；双连发具体因果关系未证实。本实施没有据此修改compaction保留集合。

## 24. Implementation Audit Record

### Round 1

- Invocation：`task ses_e4b5a2fe4ffee29JYQtzaN5rd5`，implementation / full-scope，audited revision R6。
- Blocking findings：B-01，审计员尚未获得执行授权，无法独立复现R6要求的测试、typecheck和原反馈脚本；静态行为、所有权和注释审计没有其他阻塞。
- Non-blocking findings：N-01，独立重算为`E=384`、`C=79`、`20.57%`；§23已按该口径修正。
- Release verdict：**BLOCK**。修正方向仅为独立执行验证并复用同一审计会话进行全范围复审。

### Round 2

- Invocation：复用`task ses_e4b5a2fe4ffee29JYQtzaN5rd5`，implementation / full-scope，覆盖完整§1原始需求、R6、13文件全部hunks及生产者/消费者。
- Audited diff：`6c7bc7acf96b95002c44484b6f9890744031ebc2`，验证前后一致。
- Blocking findings：**No blocking findings.**
- Non-blocking findings：**No non-blocking findings.**
- 独立复现：Core 27 pass；OpenCode非prompt 255 pass / 1 skip，完整prompt 126 pass / 15 skip / 0 fail；TUI 100 pass；三个包typecheck通过；原反馈脚本PASS；scoped `git diff --check`通过。
- 独立反馈：MAPE 1.8498067%→0.8932217%，FP/FN保持0/1；1180个确认点含1027个cold点全部接受且carrier/finish一致；采样加估算P50/P95由7.0622/8.8740ms改善为5.6384/7.7508ms。
- Primary/fallback verdict：唯一Core学习与请求估算路径；热carrier、恢复finish和TUI旧域是已批准持久数据适配，无新增失败后替代成功路径。
- Comment verdict：`E=384`、有效`C=79`、`C/E=20.57%`，超过15%目标；无新增`any`、不安全断言、权限削弱、重复算法或无关重构。
- Release verdict：**APPROVE** for the exact unchanged 13-file source/test diff against approved revision **R6**, identified by diff hash `6c7bc7acf96b95002c44484b6f9890744031ebc2`。Round-1发现全部解决，所有适用的行为、验证、所有权、主路径、代码质量与中文注释门禁通过。
