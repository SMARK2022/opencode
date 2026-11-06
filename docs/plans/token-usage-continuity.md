# Canonical Implementation Plan: Token Usage Continuity

> Status: verified
>
> Revision: R8
>
> Approved revision: none
>
> Audit mode: full-scope
>
> Target state: verified-implementation-and-history-rewrite-push
>
> Requirement source: 本会话用户原文，见第 1 节
>
> Implementation allowed: final correction and verification under the user's one-review instruction
>
> Release basis: one independent review followed by the user-directed minimal correction; no additional review claimed
>
> Last updated: 2026-11-07

当前合同以第28节为准：零用量不清除估算，显示取估算与报告值的最大值；历史章节中“真实零确认关闭估算”和“不得push”已被用户后续明确指令取代。原R8审计记录不变，不新增审计轮次。完整Core套件仍有一项与本任务无关的Node/Bun兼容失败，不能声称全套全绿。

本文件是本任务唯一 canonical plan。保持现有确认判断修复与旧共享计算复用，不重建统计子系统。R1–R5 方案审计及 R5 实现审计保留原记录；R6 首次调用被中止，随后联合审计及复议仍为 BLOCK。用户已选择“允许一次最终复核”，授权复用原审计任务，作为原方案6轮／实现3轮上限的例外。本次最终复核对应 R7；生产文件最多8个、生产 diff 新增加删除最多800行，终态为 verified-implementation-and-commit，仅提交本任务差异。

当前实现为6个生产文件，原 Schema、SDK、LLM 协议与逐视图改写均已恢复 HEAD；processor 仅修正既有 confirmed 交接，字符数量和分类保持原保存方式。此前8文件/presence设计与实验仅是历史，不再构成实施要求。原审计verdict保留为历史；第26节记录用户明确停止新增审计、授权自行最小修复后的实际放行依据，不声称取得新的独立APPROVE。

R7 审计后用户改为逐生产 HUNK 审查，并授权真实数据库抽样、时间/内存 A/B 与 compaction 完整输入显示。当前工作区及这些新增验证见第25节；第23节和R7 verdict保留为原审计快照，不构成当前差异的放行。未因普通编辑增加审计轮次或 revision。

随后用户明确要求“简单审计一下即可，你可以调用之前的审计的那个 session，发起一次审计即可。” 提交暂停，当前冻结差异仅进行此次原session复核，对应R8；第26节停止新增审计的指令及当时验证状态保留为阶段历史，当前等待本次verdict。

## 1. Verbatim Requirement

> 相应的这一套这个过滤，巴拉巴拉这套机制是不被允许的。就换言之，我们的所有情况下，这个 token 必须有结果，而且结果必须是尽量准确的。这个尽量准确指的是，已经有确认的部分使用确认的那一套结果，没有确认的部分使用这个估算的结果。也就是说换言之，当前的这套逻辑，你不应该让它在被中断的时候就直接去进行清除掉。然后同时呢，又因为我们之前进行过一次 commit 的一个修改，那个 commit 解决就是大规模的这个性能收益的一个问题。那个性能的一个降级就出现在我们这个 token 估计，所以按理来说旧的逻辑，旧的分支里面它的这个分支，这个 token 估计的逻辑其实存在一定缺陷的。但是我们新的这个分支它又没有去解决这个退化问题，所以你需要做的操作就是去检查，并且给出能够去解决兼顾这个性能不会发生退化。也就是说它没有去进行全库读取，巴拉巴拉的，又能够去保持这么一套机制，同时又能够保持整套逻辑呢，保持一个鲁棒性、发话性。换言之呢，就是相应的这么一套逻辑能够允许我在双击 ESC 中断的时候它能够显示，在我退出 TUI 重新进 TUI 的时候它也能够显示。就换言之，无论任何情况下，它都不应该去出现跳到零这种状态，所以请你注意这一点。而且你这套逻辑应该去自成一体，就是保持简化，保持简单。那按理来说这一套所有的流程机制，所有 token 的这个估计机制呢，它都应该是一体的。它不应该是什么各种各样的一些什么各种各样的分支啊，巴拉巴拉的，不应该有这种本身就没有用户就没有要求的这种，比如说什么过滤什么这种分支逻辑存在。
>
> 你自己去看一下那个情况，然后结合旧的分支，以及我们当时上一次进行的那个 commit 的一个提交，去分析一下，然后给出完整的最终的一个选择。然后你按照 First Principle Plan 的一个原则，去在当前工作区里面构建 DOCS，就是 DOCS那个 Plan的文件夹里面去构建下面这个一个 play，完整的 play。
>
> 然后请你注意保持高效，按照我们的workflow的流程就构建到这个方案就OK。

> 我问的是以前是怎么样，现在是怎么样，对比的两个就是DEV、SMARK，还有DEV1、SMARK两个分支。

> 注意按照我们DOCS里面的workflow进行。

> 请注意这一点，请注意一点，审计员本身可能会过度地去扩张相应的部分语义内容，或者说实质性的遗漏。实质性的遗漏可能本身并不是遗漏，可能对于用户来说，他本身不会到达这个分支。就譬如说，审计员可能说一部分内容，他去怎么怎么样去解这个冷冻啊，咋咋咋咋，但事实上可能打开TOI本身它就会触发解冻，它就会触发现在逻辑内容。所以这些可能他所提出的东西并不一定重要，而且不一定是有效的逻辑。然后与此同时呢，你也不应该去扩大相应这个性能，不必要的性能开销，请你注意这一点。你也不应该去因为一些本身不必要的东西去就去进行一些解冻啊，巴拉巴拉。

> 不要因为本身用户不关心或者并不考虑的内容去扩大修改语义，请你在此注意这一点。相应的内容你必须证明用户关心这个东西，如果无法证明，那你就必须认为相应的 blocker 无效并让他去重新审计。

> 你有验证你的方案具体可行吗？换言之，按理来说你不是你所构建的以及你所要求的具体结果，你能够使用代码实现吗？如果实现不了的话，那本质上你的方案不是就有问题吗？所以现在到底是什么情况，你自己去看一下。Workflow里面明确规定了你所声明的这个验收标准必须你自己能达得到，你才能去生成这个验收标准。

> 保持高效，注意保持高效，修改的每一行都应该自问一下用户到底关不关心这个，用户真的需要这种护栏吗？大概率不需要吧？这种逻辑来思考每一行的必要性，不要先入为主的把逻辑搞得很复杂，当一个点反复纠结的时候你就应该思考下是不是这个地方的抽象模型设计的不够泛用简洁
>
> 以及做的每一步操作都要这样思考

> 避免把验证做成完整实现

> 听不懂你这是在干嘛，请注意一点，保持你的逻辑的鲁棒，干净，简洁，不要试图增加不必要的 test，以及不必要的统计逻辑，请注意这一点。按理来说很简单，和我们主分支，和我们旧的主分支去做对齐，或者说做一些逻辑的这个关键点的一些处理就 OK 了，不要做得很冗余，很复杂，请注意这一点。

> 保持高效，相应的任务工程你已经进行了大把的时间了，你应该思考什么是必要的，什么是重要的，不要一直在这里试图去找补某一些部分的关键逻辑。本身你在补的时候，你都应该去想一下，是你的主逻辑有问题吗，还是说怎么为什么一直有问题，巴拉巴拉的。你不应该去一直打补丁，请注意这点。而且本身生产，而且本身不对生产逻辑产生影响的东西，那就不需要去重复审计，请你注意这点，本身那是没有必要以及没有意义的，做有意义的事情，做高效的事情，请注意这点，不做无意义的修改，不做无意义的审计。

比较对象是实际存在的 `dev-smark` 和 `dev1-smark`，不是 `dev`。当前工作分支为 `dev1-smark`。

最新来源：本会话 `<session-goal-continuation>` 的用户 GOAL；其阶段合同与 `docs/workflow.md` 对应，选择的目标终态原文为：

> - **目标终态**：<verified-implementation-and-commit>
>
> - 只维护一个 canonical plan；聊天摘要、旧审计和 builder 自述不构成实施授权。
> - exact revision 仅在获得 `No blocking findings` 和 `APPROVE` 后，才原样记录 verdict，设置 `Status: approved`、`Approved revision: <current>`、`Implementation allowed: yes`；不得夹带设计修改。
> - 不得 amend、不得 `--no-verify`、不得跳过 hook、不得 push。

该更新改变阶段终态，不改变已要求的简洁修复范围。前述 plan-only 和取消审计指令保留为历史，当前以此 GOAL 的完整阶段门禁为准。

> 继续，然后请你注意一点，我不知道你一共审计了多少次，按理来说你审计一次你才修改一下版本号，你不要。你只是修改了一下就修改版本号，请你注意这一点。当前我也不知道你审计了多少次，但请你避免这类容易产生误导或者误解的行为。就比如说你可能只审计了一次，那你最多就改成R2，如果审计两次那就是R3，不要你审计了两次然后你直接给它改成R5，这本身是不被允许的。

> 保持高效，保持efficient。你要思考到底是什么是问题，用户要的是什么，不要肆意地扩大现在范围，然后又要去做各种各样的一些东西。

> 保持高效，不要平白无故增加复杂度。我再说一遍，你的东西你不要一直加加加加加加加。按理来说，你这个整个的工程项目，按照我的理解，它可能不超过八个生产文件的修改，不超过几百行就完成了。你不需要，也不要试图去增加过分的扩张的各种各样的一些语义，请你注意这一点。不要试图去大改，有必要吗？你要思考，这个东西真的不能用吗。保持高效，保持 efficient，不要在这地方一直做做做，改改改，做改审计，做改审计，你要一次弄完。

> 你需要注意一点，按理来说，我对你的期望就是你修改的幅度，你所有修改的生产文件数，我建议你是不要超过八个，修改的行数不要超过八百行，就这么简单。你不要把每一个各种各种的这种下游的东西都去修改。按理来说，只修改关键的地方，比如什么 Anthropic 巴拉巴拉的，我希望你的修改能够直接去适配它，就是直接让你的修改本身就能够适配它。你不要什么 Anthropic 的 message，你又加个 test，Anthropic 的 message 你又加个生产代码，然后各种什么生命周期的各个部分，包括什么类型啊，各种地方都去加 test。我不希望这样做。我仍然希望复用先这一套逻辑，你不要去各种各样的大改，请注意这一点。修改文件数保持必要。

用户在本轮执行选择中明确回答“保留原审计门禁”。以下收缩范围仍须取得 exact revision 批准；被中止的调用不提供批准。

随后用户原文：“其他的不必要东西请你都撤回。也就是说你所构建的那些不必要的东西，你自己思考什么是重要的，不必要的东西请你撤回。”、“当然你已经实现的一部分内容，就是在可能在方案里面东西仍然可以保留。”、“为了便捷化，我也授权你一次性进行相应的方案以及实施审计。” 据此仅允许先收缩实现，再一次联合审计 R6 方案及实际 diff；联合批准前不设置 verified、不提交。

本轮对具体新增字段的用户原文：“你直接复用一套 tokens 统计逻辑和显示链路不就 OK 了吗？”、“不要去新增分支，不要去新增数据的这种传输逻辑”。撤回要求原文：“你如果要撤回对应语义，那你需要把它恢复到 HEAD 的那种状态。” 当前按这些要求删除候选字段与关联逻辑，直接复用原业务用量合同。

## 2. Explicit Non-Goals

- 方案阶段不修改 production、tests、config、migration、generated artifacts 或真实业务数据；实施阶段仅执行 exact revision 的批准范围。
- 不新增用量表、数据库迁移、独立用量服务、活动请求注册表、progress/checkpoint 事件、ordinal/revision 协议或历史导入流程。
- 不回退整个分支，不恢复全历史正文统计，不更改模型请求、重试、副作用工具、revert/fork 或权限语义。
- 不用估算伪造 provider 已确认的费用、缓存命中或密度学习样本。
- 不用非零下限、只增不减或最后一帧缓存掩盖真实确认值；真实确认的零仍是合法结果。
- 修复范围由当前 TUI 实际入口界定：V1 prompt/command、TUI 子会话和 V1 compact；V1 使用 AI SDK 或 native LLM adapter 都经过同一 processor。独立 `/api/...` Core SessionRunner/SessionCompaction 不属于本次 TUI 执行链，不为它新增接线、恢复或测试机制。公共共享类型的现有消费者仍须编译兼容。
- 不为 token 统计新增解冻入口、重复读取已恢复的 Part、后台扫描或定时 checkpoint；不扩展未被用户打开的历史的读取范围。
- 不修改 Anthropic protocol、LLM lifecycle/event 类型或其测试；不把 parser 内部提前知道的 usage 扩展为新的业务交付合同。准确性沿原 processor 已收到的 usage，未收到时保留原估算。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/workflow.md` 与第 1 节最新 GOAL | exact revision 方案批准后实施，验证及实现审计通过后只提交本任务；记录性更正不重复审计，不继承历史批准。 |
| `.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md` | 修复事实源与责任 owner；禁止失败后备用算法；要求双向映射和中文注释预算。 |
| `AGENTS.md`、`packages/opencode/AGENTS.md`、`packages/schema/AGENTS.md`、`packages/llm/AGENTS.md`、`packages/opencode/src/session/llm/AGENTS.md` | Schema/Core/Protocol/Server 单向依赖；V1 与 native orchestration 不互调；package-local tests/typecheck；修改公共合同后重新生成两个客户端。 |
| `CONTEXT.md:48-52,165-176,411` | Provider Turn 已有明确业务边界，不能把 drain 当作消费身份；V1 与 Core native 是不同执行链，不能因为共享数据库便扩大本任务。 |
| `docs/adr/` | 当前 ADR 只有 triage 分类，无改变本任务 token/持久化合同的 ADR；不修改 ADR。 |
| 当前 dirty worktree | `packages/tui/src/routes/session/index.tsx` 等消息外观文件已有用户修改；仅文档变更，本计划不覆盖或回退。实施时需基于当时内容做局部接线。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `dev-smark` = `26061b595b3140d37717248222c7ed2016421db0`；`dev1-smark` = `321a3ffeddc22a6c9ffe14d876fe35a3f5dadc62` | 固定比较对象；分支后续移动不改变本次对照依据。 | observed |
| `dev-smark:packages/opencode/src/session/prompt.ts:3208-3278`、`processor.ts:1044-1119` | 旧版把输入估算写入 `tokens.input` 和 `inputTokens`；中断保存正文、结束时间及账本。 | reachable |
| `dev-smark:packages/opencode/src/token/accounting.ts:101-349`、TUI `routes/session/index.tsx:2252-2259` | 无 finish 时，结束消息仍从保存正文估算输出；旧 footer 使用共享贡献。 | reachable |
| `89db8e0e2362da54111ac3ab5a1294cd6bc2b919` 的 accounting、sync、request-usage diff | 性能收益来自每消息贡献缓存、数值共享与按 discriminator 读取热字段，不来自取消中断估算。 | reachable |
| `packages/opencode/src/session/processor.ts:96-135,176-265,620-697,770-844,879-1042,1090-1194`；`prompt.ts:382-433` | 当前实际请求估算、流式片段、重试撤回、cancel/finalizer 和准备窗口 owner。 | reachable |
| `packages/core/src/session/info.ts:22-214`、`request-usage.ts:114-142,251-425`、`request-usage.sql.ts`、`projector.ts:258-368,462-484,544-576` | 当前输入估算被 completed 排除；账本仅结算确认 steps；现有事务与主键。 | reachable |
| `packages/tui/src/util/token-estimate.ts:44-109`、`token-accounting.ts:81-474`、`context/sync.tsx`、`routes/session/request-usage.ts` | completed 清除尾部估算；三个视图重复遍历 message/parts；历史 footer 另读确认账本。 | reachable |
| TUI `feature-plugins/sidebar/context.tsx:37-79`、`component/prompt/index.tsx:296-347`、`routes/session/subagent-footer.tsx:68-117`、`routes/session/index.tsx:2259-2270`、`util/context-usage.ts` | 当前 step、request、session、footer、退出和 `/context` 的实际消费者与既有范围。 | reachable |
| `packages/llm/src/schema/events.ts:51-73,183-190`、opencode `session/session.ts:307-373` | usage 各轴是 optional；现有 `?? 0` 会丢失“未报告”和真实零的区别。 | contracted |
| `packages/core/src/session/runner/llm.ts:430-554,602-620`、`publish-llm-event.ts:84-244`、`compaction.ts:245-350`、`message-updater.ts:218-265` | 审计复议时核验的邻接执行链；自身可达不等于本次用户 TUI 可达，不据此新增生产概念。 | reachable |
| Schema `session.ts`、`session-message.ts:208-252`、`v1/session.ts:498-532`、`session-event.ts:167-241,534-611`、`event-manifest.ts`、`durable-event-manifest.ts`；Protocol `groups/event.ts`、`groups/session.ts` | 现有公开合同、inputEstimate、事件 inventory 与生成链。 | contracted |
| `packages/opencode/src/event-v2-bridge.ts:42-108`、`session/message-v2.ts:1268-1363`、Core `storage/cold-storage.ts:578-631`、`cold-codec.ts:505-534` | 不可让进度事件重扫 Session 历史；已有有界采样和 cold-aware 数值读取 seam。 | reachable |
| Core `test/session-projector.test.ts:830-1038`、`test/session-info-selection.test.ts`；opencode `test/session/processor-effect.test.ts:1348-1588`；TUI `test/util/token-estimate.test.ts`、`token-accounting.test.ts:289-349`、`test/request-usage.test.ts` | 已有零确认、分页、cancel、冷数据与资源共享测试；缺少估算在 cancel/reopen 后持续的断言。 | reachable |
| 第 18.1 节实际内存执行 | 当前真实函数红测与重复正文访问工作量；直接对应本次回退。 | observed |
| TUI `component/prompt/index.tsx:1331-1347`、`routes/session/index.tsx:1170`；V1 HTTP `handlers/session.ts:369-437`；opencode `session/compaction.ts:583-613` | 当前用户的 promptAsync/compact 进入 SessionPrompt，摘要复用同一 SessionProcessor；不进入 Core native runner。 | reachable |
| TUI `context/sync.tsx:1492-1506`；opencode `session/message-v2.ts:588-637,1093`；Core `cold-codec.ts:685-697,748-781`、`cold-storage.ts:578-631` | 既有消息 page 已对选中 rows 做完整 cold-aware 只读恢复；Stats 的缺字段不应导致另建 token 解冻路径。 | reachable |
| `packages/llm/src/protocols/anthropic-messages.ts:671-714,750-752,880-890`、`protocols/utils/lifecycle.ts:11-15`、`schema/events.ts:78-81`；opencode `session/llm/native-runtime.ts:60-65,136-149`、`session/llm.ts:335` | 当前 TUI 支持的自有 Anthropic parser 提前拿到真实输入却尚不输出事件；既有 step-start 可携带该输入事实。默认 AI SDK 没有暴露该早期帧，不为此打开额外 raw 流。 | reachable |
| `packages/llm/test/provider/anthropic-messages.test.ts:381-423`；第 18.2 节实际内存执行 | 起始帧输入 5+缓存 1=6，parser 已知而 consumer events 为空的第二个 red-capable 信号。 | observed |
| 第 18.3 节历史外部原型 | 未送审实验稿的 12 项/60 断言及旧共享计算模块测量；保留记录，不将废弃架构的通过当成当前集成通过。 | observed |
| 当前 `session/processor.ts` 的 runChild、`session/tools.ts:254`、`session/message-v2.ts:845` | 并行工具任务引入带 `metadata.executeParent` 的宿主子记录，现有模型历史转换明确跳过；它们不是 provider 生成的参数或下一轮独立工具回执。 | reachable |

## 5. Current Behavior

```text
V1 prepared -> Assistant.inputEstimate -> message.updated + confirmed-only ledger
provider deltas -> 内存/实时 Part -> text-end 或 cancel 保存完整 Part
cancel -> completed -> Session SELECT 排除 estimatedInput
TUI completed gate -> 排除输出字符 -> 本轮无确认时 input/output 全零
历史 footer -> confirmed-only request ledger -> 未确认尾部再次丢失
```

旧版保存输入估算、保存正文后仍计算未确认输出；旧版同样没有独立 output-token 数字快照。因此，重新打开后的恢复并不要求新建数字持久化系统。旧版“有过 finish 且整个助手结束就全部确认”的判断也不能照搬，必须看对应 step。新旧 request 计费账本都只接受真实确认事实，这部分保持原义。

当前性能问题的上游原因仍存在：`tokenAccounting` 即使已拿到完整 Session 投影，也遍历所有驻留助手、所有其 parts 来校准与汇总；prompt/sidebar/subagent 各做一遍。恢复 `89db8e0e23` 已有的“只处理变化贡献并共享数值”，不新增 durable 路径。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer / guarantees / path | Owner | Classification |
| --- | --- | --- | --- |
| prepared 后首包前中断 | 已有 `Assistant.inputEstimate`，尚无输出 | 现有 SQL 选择和 TUI 计算 | reachable |
| text/reasoning/tool raw 输出一半中断 | processor 已接受片段，现有 finalizer 会保存 | 现有 Message/Part 与共享计算 | observed |
| 多步/多助手同一 user 请求 | 已有 step-start/step-finish、parent 及 prepared 游标 | 旧共享计算按现有 step 边界归属 | reachable |
| usage 缺失、部分报告、真实零 | `Usage` 属性可缺失；零仍是报告值 | 原协议边界保留已报告事实 | contracted |
| 中断后重进 TUI、打开历史消息 | 已有消息 page/hydrate 与确认账本；复用本页恢复结果 | 现有 sync 重新测量选中消息 | observed |
| retry/discard、revert/remove/fork | 原 orchestration/投影已有语义 | 保持原事实增删和费用，不新建修订体系 | reachable |
| 没有请求、没有 prepared、shell/noReply | 没有任何模型调用或输出事实 | 原接口的真实零 | reachable |

“不跳零”指存在可用确认/估算事实时不因 idle/completed/cancel/分页/重连丢失。全新空会话、尚无事实、真正报告的零不伪造非零。硬杀进程未曾持久化的最后一段输出无法承诺无损恢复；这不授权自动重新调用 provider。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence / existing seam |
| --- | --- | --- |
| INV-01 | 沿原业务 tokens 结果显示，结果到达前保留已有估算；真实零有效，同一用量不重复累计。 | 用户最新约束；原 StepFinish/Message tokens 与 prepared 边界 |
| INV-02 | 当前 step 与请求累计分别显示；前一步确认不能遮掉后一步未确认尾部。 | 现有多步助手 |
| INV-03 | completed/idle/aborted 不代表用量已确认，不据此丢弃估算。 | 已运行的 777/2 -> 0/0 红测 |
| INV-04 | 中断后利用原已保存的输入元数据与 Parts 重建；不依赖已销毁的 TUI 缓存。 | 旧分支和现有 cleanup/page |
| INV-05 | 同一 Session 共享旧优化中的每消息数字贡献，变化消息才重新测量；不在每个消费者、每次 delta 重扫历史正文或查库。 | `89db8e0e23` |
| INV-06 | 估算不写成确认 tokens、费用或确认校准样本；cache/reasoning 不重复计数。 | 原确认账本 |
| INV-07 | 各 token 视图使用同一计算入口，保留各自 step/request/session 范围。 | 已证明的 TUI 消费者 |

## 8. First Divergence and Root Cause

| Invariant | First divergence / causal chain | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/03 | origin：把生命周期结束误当作用量确认；propagation：SQL 隐藏现存输入估算、TUI 将现存输出字符算为零；manifestation：中断后界面归零 | `info.ts:164,171`；TUI `token-estimate.ts:51,63,80–89` | 真实函数 `[777,2] -> [0,0]`；已保存 inputEstimate=777，SQL estimatedInput=null |
| 历史候选，R6 撤回 | 自有 parser 提前知道输入，但原业务事件尚未交付；用户最新明确不扩展协议和生命周期 | 保持原 LLM 交付 owner，本任务只在 processor 既有 usage 边界区分报告与估算 | 第 18.2 节仅保留历史证据，不属于 R6 验收或实施范围 |
| INV-07 | 历史 footer 只读确认账本，没有使用现有共享估算语义 | 既有 request-usage 资源与 footer 接线 | 当前 footer 与实时统计走不同入口 |
| INV-05 | origin：同一历史正文被消费者用作每帧计算输入；propagation：consumer 数放大遍历；manifestation：共享线程开销 | 计算输入的 owner，而非下游节流器 | 3 个消费者、10/100/300 个助手分别执行 30/300/900 次 getParts；0.231/0.897/1.094ms（小样本工作量证据，非线上延迟承诺） |

已实际执行命令：在 `packages/tui` 运行第 18.1 节 PowerShell stdin harness。退出码 1，独立期望 `[777,2]` 与实际 `[0,0]` 不符；同一 harness 同时给出上述生产函数 getParts 工作量。未启动模型、未操作业务库。

结论：持久化系统并未在中断时把原始估算事实全部删除；主要错误是读取与显示时主动排除。未送审实验稿把这一点扩大为新表、版本和 checkpoint 体系，当前方案撤销该路线。既有额外实验仅作历史记录，不反过来要求生产采用原型结构。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise / locality |
| --- | --- | --- |
| 输入估算的可用性 | 现有 Core Session info SQL | 去掉 completed 门槛，保留当前请求、确认和 prepared 游标边界 |
| 每消息测量、校准与显示汇总 | 现有 TUI token-accounting/token-estimate + SyncProvider | 复用旧提交的 measure/summarize/project 分工，每 Session 共享，消费者只选范围 |
| 已报告事实与保存 | 原 LLM adapter、processor、Step Parts | 保留实际报告的轴，沿现有 Part 更新保存；不新增计数服务或事件 |
| 中断与重新打开 | 原 cleanup、page/hydrate、sync | 已有正文落盘与页面恢复照常，不为统计另建恢复流程 |
| 确认费用、历史可见性、冷存储完整性 | 原 ledger/projector/storage | 不修改原计费或副作用语义 |

## 10. Single Approved Primary-Path Design

### 10.1 最终选择

**修正“结束即确认”的判断，恢复旧分支保留未确认估算的行为，并直接复用 `89db8e0e23` 的每消息测量、共享汇总机制。** 不用新数据库模型代替现有 Message/Part。

```text
已有 Message/Part、prepared input、provider 报告
 -> 同一每消息测量入口：有报告用报告，没有报告用估算
 -> SyncProvider 共享数字贡献与汇总
 -> prompt/sidebar/subagent/footer/context/exit 按原范围显示
```

### 10.2 修正现有判断

Core `info.ts` 的 `estimatedInput/pendingInput` 去掉以 completed 为确认依据的条件，仍保留当前请求、prepared 游标和实际确认边界。TUI `computeFinalTokens` 同样不再因 completed 丢掉输出字符、输入估算或未确认尾部。以当前 step 的真实确认覆盖其估算，不能因助手的前一步有 finish 就把后一步一起清掉；patch/snapshot 等收尾记录不冒充新一轮输出。

输入沿用 `inputEstimate`、StepStart 的 `inputTokens/inputChars` 和原密度；输出沿用原已保存的 text/reasoning/tool 参数及独立输出校准。工具中断后的原始参数从既有 `metadata.raw` 恢复，raw 与解析 input 不重复相加；tool result 只计入后续输入，不计为模型输出。不将估算填进费用或确认 tokens。

模型计数沿用现有历史转换的归属合同：`metadata.executeParent` 为字符串的 ToolPart 是宿主子执行记录，不能再次当作 provider 参数、下一轮工具结果或新 step。TUI 只在共享测量入口选择模型 Parts，Core 既有 step 尾部探针遵守同一归属；复用现有标记，不修改并行工具实现或增加状态。R4 送审后该 producer 才进入工作区，这是 R5 唯一材料性增补。

### 10.3 复用旧性能优化

把旧 `measureMessage -> summarizeAccounting -> projectAccounting` 的责任放回现有 TUI accounting 模块；SyncProvider 为每个已消费 Session 共享一份每消息数字缓存。只有变化消息重新测量，校准和汇总使用缓存数字，prompt/sidebar/subagent 不各扫一次正文。缓存不另持正文，释放沿现有 Session 消费生命周期。

保留 prompt/sidebar/subagent/context 原有 `tokenAccounting` 调用；通过 Session 对象的 WeakMap 绑定复用 Sync 已有数字 accessor。Sync 在既有 owner 中随 Session 列表注册/清理绑定，数值缓存仍由原 owner 持有，不新增服务、全局 ID 注册表或正文缓存。旧调用无 Sync owner 时仍执行同一 measure/summarize/project 公式；绑定不是错误后的替代路径。plugin session.get 已实际直通 sync.session.get（`plugin/adapters.tsx:123-124`），无需改下游 API。一次性包装保持原 session 确认账本口径，退出与 footer 仅在现有 Session route 消费共享有效值。

当前 1.19 已有的确认累计和按 parent 共享的 request-usage 资源继续使用，不把页内已确认值再加一次。有效请求总量为已有确认累计加上尚未被其结算的有效贡献；共享测量入口统一完成这项组合，footer 不自行另算。只沿用现有加载窗口和数值前缀，不为统计读取窗口外正文，不机械恢复旧版多余的 HTTP/SQL 链。

### 10.4 复用原用量合同

原 `StepFinishPart.tokens` 已完整定义 input/output/reasoning/cache；processor 原有归一化、保存和费用 owner 不变，不重新解释 provider raw usage。删除 `reportedUsage`、逐轴状态、partial contributions 与对应测试，Schema/SDK 的本任务差异为零。processor 只将既有 `inputEstimate.confirmed` 设为 `value.usage !== undefined`，无报告的结束不再成为确认样本；`inputChars/inputBreakdown` 仅随实际 usage 留作校准，准备事实仍在原消息和 step-start 中。

共享测量只选择已有用量载体：可见 finish、原 request 投影，以及原合同允许的无 finish 存量 `message.tokens`。没有新步骤结果时保留既有 inputEstimate 和保存正文。旧消息载体也进入相同差额公式，不在下游另加“忽略重复输出”补丁；原25不能再加正文估算2。真实零沿原载体处理，未完成的新 prepared 仍按原游标优先级显示。

TUI 取得的仍是原 input/output/total/cost 数字；没有新的传输字段、presence 协议、持久化记录、错误恢复或 provider-specific 接线。原分配段和原确认消费范围保持不变。

### 10.5 中断和重新打开

中断仍由现有 cleanup 保存输入元数据、text/reasoning 和工具 raw。重新进入 TUI 时仍由 `MessageV2.page -> hydrate` 恢复所选消息，交给同一测量入口；不导入数字表、不额外解包、不另开统计查询。需要的原始事实不能在既有 viewer 裁剪后被替换成空 skeleton；只在原投影处保留测量所需字段或其字符长度，不新增正文副本。

核心持久性来自原 Message/Part，缓存只是复用计算，不是恢复依据。没有服务端最终报告时继续使用保存的估算事实；真正报告到达时正常替换。无需为此修改中断调度、添加 idle 等待、定时写盘或维护服务端活动数字槽。

### 10.6 范围保持

保留现有 step/request/session 显示范围、费用、可见性、revert/fork 与错误传播。旧消息仅在正常打开/分页时参与原范围的计算，不扩大为全历史估算报表。当前任务不保证恢复硬杀前从未保存的片段，也不增加自动 provider 重跑。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 原用量确认 / 未确认估算 | 修正现有计算 | primary-contract branch | yes | 主路径 | preserve |
| 既有消息页恢复与数字缓存 | current / 复用旧优化 | primary-contract branch | yes | 同一事实与公式 | preserve |
| 无 finish 的既有 message.tokens 载体 | 真实存量及原 request-usage 合同 | existing compatibility | yes | 同一差额公式 | preserve |
| 空请求、真实零、shell/noReply | current | primary-contract branch | yes | 真实输入域 | preserve |
| completed/idle 清空估算 | current | 无用户合同的旧决策 | yes | 不计入新路径 | remove |
| DB/冷数据失败后重扫全文并返回零 | 未存在的建议路线 | forbidden fallback | yes | 0% | reject |
| 最后非零值/只增不减缓存、另建用量子系统 | rejected | 非本次修复所需 | yes | 0% | reject |

新 alternate success path = 0；新增诊断路径 = 0%，沿用原错误传播。保留冷存储完整性验证、权限与原 runtime selection，不删除必要 guard。这里删除的是将生命周期误当确认的过滤。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Replacement / delete location |
| --- | --- | --- |
| completed 抑制输入和输出估算 | 错误把执行终态当确认 | Core info / TUI helper 以当前 step 的真实报告替换 |
| 每个视图重新遍历正文 | 迁移未保留旧共享测量 | 恢复旧提交的每消息缓存和共享汇总 |
| footer 只用确认值 | 没接共享有效用量 | 原资源保留确认累计，显示交给同一入口 |
| 未送审稿的新表、活动槽、版本、checkpoint、旧页导入 | 将读取判定回退扩大成统计系统重构 | 全部撤销；不实施对应表、服务、事件或测试 |

## 13. Forward Traceability

| Requirement / invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/03 | 已保存估算 -> SQL/显示选择 | info、token-estimate | 777/2 中断后仍为 777/2；真实零正常覆盖 |
| INV-01/06 | 原 tokens 载体 -> 原显示范围 | 复用原 confirmed 标记；共享入口统一选择与去重，Schema 不变 | 无 usage 正常结束保留估算；原零确认及旧25用量不重复 |
| INV-02 | 既有 step 边界 -> 同一测量 | token-accounting | 已确认 1000/100 加尾部 777/2 为 1777/102，不重复累计 |
| INV-04 | 原 cleanup -> page/hydrate | 原保存/读取不重构；共享测量重建 | 从原保存消息重读后得到同样估算 |
| INV-05 | 变化消息 -> 缓存贡献 -> 共享汇总 | SyncProvider、旧 accounting 分工 | 复用已有工作量信号，不新增 benchmark 工程 |
| INV-07 | 同一入口 -> 各视图 | 原 consumers、request-usage | 使用相同 fixture 核对原显示范围 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence / why reuse is insufficient |
| --- | --- | --- |
| 去掉 completed 确认门槛 | INV-01/03 | 已有估算仍在，原 gate 正是实际红测的丢失点 |
| 原 confirmed 只在实际 usage 到达时确认 | INV-01/03/06 | 原 HTTP fixture 的正常结束没有 usage；无条件置 true 会将准备估算替换为归一化零，不需新增字段 |
| 每消息数字缓存、共享汇总 | INV-05/07 | 直接复用 `89db8e0e23`，不新造服务或另存正文 |
| 沿 executeParent 选择模型 Parts | INV-01/05 | 当前宿主子记录已被模型历史排除；计入其计算所得参数会虚增 token，并使确认后的子记录冒充新 step。只复用现有角色信号。 |
| 原 footer 改用共享入口 | INV-07 | 只读确认账本正是该视图丢失估算的原因 |
| Session 对象的数字 accessor 绑定 | INV-05/07、用户限制下游修改 | 原视图已经调用相同 accounting 并传入同一 Session 引用；绑定现有 Sync accessor 即可避免三处下游重写，不复制数字或引入恢复路径 |

不增加 feature flag、任务队列、重试策略、通用恢复框架、定时全库维护、provider 调用或新依赖。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility | Expected effective line delta |
| --- | --- | --- | --- |
| `packages/core/src/session/info.ts` | modify | 修正 estimatedInput/pendingInput 的生命周期 gate | 局部条件 |
| TUI `util/token-accounting.ts`、`util/token-estimate.ts` | modify | 复用旧 measure/summarize/project；修正确认边界；删除重复扫描 | 以旧代码适配/替换为主 |
| TUI `context/sync.tsx` | modify | 旧优化的每消息共享计算及对称释放，不另持正文 | 复用旧 owner |
| TUI `routes/session/index.tsx` | modify | 仅 footer/exit 接共享有效值；prompt/sidebar/subagent/context 恢复原调用 | 不改 UI 外观与确认资源 |
| `packages/schema/src/v1/session.ts`、`packages/sdk/js` | withdraw task changes | 原 tokens 合同不变；正式再生成后与 HEAD 无差异 | 本任务 diff 为0 |
| `packages/llm/src/schema/events.ts`、`protocols/utils/lifecycle.ts`、`protocols/anthropic-messages.ts` 及对应测试 | withdraw task changes | 恢复原协议交付与生命周期；不回退并行工作 | 最终本任务 diff 为 0 |
| `packages/opencode/src/session/processor.ts` | modify only | 既有 confirmed 依实际 usage 交接；无报告不作为校准样本，归一化/保存/费用保持原链 | 两处局部 hunk |
| 现有 TUI/Core/opencode 对应测试 | modify only | 第 16 节少量必要回归，复用既有 fixtures | 不建新测试工程；LLM 测试 diff 撤回 |

当前生产路径仅6个：`packages/core/src/session/info.ts`、`packages/opencode/src/session/processor.ts`、`packages/tui/src/util/token-estimate.ts`、`packages/tui/src/util/token-accounting.ts`、`packages/tui/src/context/sync.tsx`、`packages/tui/src/routes/session/index.tsx`。按本任务 hunks 计新增406、删除373，共779行；排除其他任务的 route 工具隐藏和 processor 工具/重试 hunks，无生产文件新增。测试只沿原 SQL、helper、HTTP、保存和 Sync 重建 seams。

不修改 request-usage 表、migration、event manifest、projector、Core native runner 或 orchestration。原 viewer 若裁掉必要测量事实，只在现有裁剪处保留字段/长度，不新增恢复入口；不为此改变 cold storage。没有 current Protocol/HttpApi 变化就不触发其客户端生成。

## 16. TDD Behavior Slices

只在现有测试里补实际回退的断言，不再为计划阶段写测试或原型。正式实施时以现有 Session info、processor 保存/重读及 TUI accounting 为 seam；修一条、验证一条，不搭建新框架。

| Order | Red behavior | Why current code fails | Minimal green / protected regression |
| --- | --- | --- | --- |
| 1 | 777 输入、8 字符输出 /4，中断后及保存重读仍为 777/2 | completed 双过滤 | SQL 与共享 helper 不再排除已有估算 |
| 2 | 前步确认 1000/100、尾步未确认 777/2，结束后仍为 1777/102 | 把整个助手完成当作末步确认 | 原 step 边界、确认和估算不重复 |
| 3 | 无 usage 正常结束仍保留估算，真实零覆盖估算 | 无条件 confirmed 将规范化零当成报告 | 复用原 confirmed 与 HTTP fixture，不新增 Part 字段或部分报告矩阵 |
| 4 | 保持原 provider 交付，不扩展提前报告 | 用户明确限制协议/生命周期范围 | 未交付时保留估算；已有 finish 的输入/cache 分类仍用真实值 |
| 5 | 同一保存消息在实时视图、footer、重建 sync 后数值一致 | 当前显示入口分裂 | 原 fixtures 复用，不为每个组件另建场景 |
| 6 | 确认 1000/10 后的宿主子记录不改变当前 step 或增加参数估算 | 既有尾部探针按所有 ToolPart 判断，没有区分新 producer 的角色 | 在原 helper/SQL fixture 补一个子记录，期望仍为 1000/10 |

原 Sync fixture 同时核对旧 accounting 调用与共享调用一致；旧消息兼容 fixture 仅加入八字符正文，期望确认输出仍为25，捕获此前错误27。新增传输/presence/部分报告的候选切片及 context fixture 改写全部撤回 HEAD，不增加测试文件或协议矩阵。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines E | 实际保守上界425 | 排除空行、imports、注释；未额外扣除复用移动或格式行 |
| Required Chinese explanatory comments C | 最低64，实际64 | 邻近真实数据源、缓存生命周期和测试意图 |

仅解释实际非显然约束：完成不等于确认、缺失与真实零、对应 step、共享缓存不持正文，以及少量回归的独立期望。不存在的新表/版本/事件不需要注释，不用拆行或翻译赋值凑数。

## 18. Verification

### 18.1 已执行的原始红测与成本信号

工作目录 `packages/tui`，执行 PowerShell：

```powershell
@'
import assert from "node:assert/strict"
import { tokenAccounting } from "./src/util/token-accounting.ts"
const zero = {input:0,output:0,reasoning:0,cache:{read:0,write:0}}
const prepared = {input:777,bodyChars:3108,confirmed:false,charsPerToken:4}
const base = {id:"a",sessionID:"s",role:"assistant",parentID:"u",time:{created:2},agent:"build",providerID:"p",modelID:"m",mode:"build",path:{cwd:"/",root:"/"},cost:0,tokens:zero,inputEstimate:prepared}
const user = {id:"u",role:"user",time:{created:1}}
const text = {id:"tail",sessionID:"s",messageID:"a",type:"text",text:"abcdefgh"}
const request = {messageID:"u",assistantID:"a",input:0,output:0,cost:0,stepInput:0,stepOutput:0,estimatedInput:777,inputEstimate:prepared}
const read = last => tokenAccounting([user,last],()=>[text],2000,{session:{tokens:zero,cost:0,request},last,parts:[text]}).request
const before = read(base)
const after = read({...base,time:{created:2,completed:3},error:{name:"MessageAbortedError",data:{message:"Aborted"}}})
console.log(JSON.stringify({case:"interrupt",before,after}))
for (const size of [10,100,300]) {
  const messages = Array.from({length:size},(_,i)=>({...base,id:`a${i}`}))
  let partReads = 0
  const parts = id => {partReads++; return [{...text,messageID:id}]}
  const started = performance.now()
  for (let consumer=0;consumer<3;consumer++) tokenAccounting([user,...messages],parts,2000,{session:{tokens:zero,request},last:messages.at(-1),parts:[text]})
  console.log(JSON.stringify({case:"three-consumers-one-refresh",assistants:size,partReads,ms:Number((performance.now()-started).toFixed(3))}))
}
assert.deepEqual([after.input,after.output],[before.input,before.output],"interruption must preserve unconfirmed input/output")
'@ | bun -
```

这是当前真实函数的 red-capable 信号。正式修复只需在现有 helper/SQL 测试保留相同独立输入和期望，不必为此新增测试文件。

R5 producer 漂移反馈已在 `packages/tui` 用 `bun -` 实调 `computeFinalTokens`：已有确认 1000/10，随后加入完成态 ToolPart（`metadata.executeParent="parent"`，input 为 `{path:"computed"}`、output 为 `"host result"`）。实际 step=1013/5、request=2013/15；独立期望均保持 1000/10，断言退出码 1、2.43s。这证明宿主记录会被误作 provider 尾部；已有模型历史选择已排除该角色，复用其标记即可，无需新恢复机制。

R6 收缩前在 `packages/tui` 用 `bun -` 执行已有计算：起始报告 inclusive=6（pure=5/cache=1）、输出8字符时 footer/session pure 错误为6；input=500 的部分 finish 输出数值为2、分类为0。独立期望 `{5,5,2,2}`，实际 `{6,6,2,0}`，断言 exit1、1.626s。该提前交付及部分 presence 候选均已撤回；此处仅保留历史反馈，不构成当前实施或验收要求。

### 18.2 历史起始报告反馈信号，R6 不实施

工作目录 `packages/llm`，PowerShell：

```powershell
@'
import assert from "node:assert/strict"
import { Effect } from "effect"
import { LLM } from "./src/index.ts"
import { protocol, route } from "./src/protocols/anthropic-messages.ts"
const request = LLM.request({model:route.model({id:"claude-sonnet-4-5"}),prompt:"hi"})
const [state, events] = await Effect.runPromise(protocol.stream.step(protocol.stream.initial(request),{
  type:"message_start",message:{usage:{input_tokens:5,cache_read_input_tokens:1,output_tokens:0}},
}))
console.log(JSON.stringify({parserInput:state.usage?.inputTokens,parserOutputPrefix:state.usage?.outputTokens,events},null,2))
assert.equal(state.usage?.inputTokens,6)
assert.ok(events.some(event=>event.usage?.inputTokens===6),"reported input must reach the consumer before final usage")
'@ | bun -
```

R3 方案阶段实际结果：parserInput=6，parserOutputPrefix=0，events=[]，退出码 1。该信号直接证明自有协议已解析的输入未到达消费者。修复后的正式 fixture 还必须断言起始 output 前缀不会停止后续输出估算；不能仅让“有事件”通过。

### 18.3 历史原型记录，不作为当前实施要求

以下是未送审实验稿已经发生的外部执行，保留结果而不重跑。其新表、数字 owner、checkpoint 和 replay 方案已撤销，不能因为原型通过而要求生产照搬，也不能称当前完整实现已验证。当前直接相关的依据是原始归零红测、现有保存/恢复链和实际旧共享模块测量。所有临时文件均在工作区外，loader 只改内存，未修改 production/test/config/migration/generated。

代码路径及本轮最终 SHA256：

| Artifact | SHA256 |
| --- | --- |
| `D:/Temp/opencode/token-usage-proof.ts` | `9103A60520DBF440E3CA2B8209B87F360CC7E1E4512467E7DA796E259E758995` |
| `D:/Temp/opencode/token-usage-proof-loader.ts` | `C3D7E89EDF98518219FBB4A75872A120DDBB5EC1F4D03D1DB0342B98D01F171D` |
| `D:/Temp/opencode/token-usage-proof-event.ts` | `BB379C62C5660AF7F7ADA262909029702D6051C1DAF107ED343CF44DD451C8C8` |
| `D:/Temp/opencode/token-usage-feasibility.test.tsx` | `2463621D75DDF9FF22536EE30CBF70467E2EEF5DA7EE58260D524AE6FD071C86` |

执行目录 `D:/Temp/opencode`，这是隔离验证项目，不是仓库 root：

```powershell
bun test --preload "D:\Temp\opencode\token-usage-proof-loader.ts" --preload "F:\ML\PythonAIProject\Claude-Code\opencode\node_modules\@opentui\solid\scripts\preload.js" --preload "F:\ML\PythonAIProject\Claude-Code\opencode\packages\opencode\test\preload.ts" "D:\Temp\opencode\token-usage-feasibility.test.tsx" --timeout 30000
```

最终执行：**12 pass、0 fail、60 expect() calls，7.96s**。可复核的范围：

| 已执行切片 | 真实接入点 | 独立期望 / 结果 |
| --- | --- | --- |
| 文本中断与再次打开 | 真实 SessionProcessor / cleanup / MessageV2.page，同连接数字 checkpoint | 中断前、idle 时、重建 owner、再次 page 均为 777/2；确认费用账本仍为零 |
| 半截工具参数 | 真实 pending tool raw 事件与中断 cleanup | 64 字符 raw 保存在原 metadata，output=16，重读仍为 16 |
| 起始输入报告 | 真实 Anthropic parser/lifecycle 的内存修改 | 仅一个 step-start；input=6、output 未确认；中断恢复 6/2；最终报告 6/3 正常覆盖 |
| 多步/单轴/真实零/迟到修订 | 候选数字 owner + 实际 SQLite | 1777/102 -> 1500/102 -> 1000/100；第三步时修订第一步，当前步不变、全局 revision 增加 |
| 事务拒绝与 replay | 真实 EventV2 publish/project/replayAll + 同连接 SQLite | 拒绝时数字及 event 整体回滚；重试成功；在新 DB 两次 replay 结果为 777/4、不重复 |
| TUI 重建与交错 | 真实 SDKProvider/SyncProvider/testRender fixture | 完整 destroy/recreate 后恢复 6/2；旧同请求快照和异请求 progress 不覆盖 |
| 旧冷页恢复 | 实际 freezeOwner + MessageV2.page/viewer + 已有 inspectPartRows | 同批 3 个归档 Part 恢复 reasoning/text/raw 后为 777/48；原 cold_ref/key/data 不变；观察到一次原 inspect、无 token 专用 decode |
| 物理连接重开 | 临时文件 SQLite close/open | 无 live owner 时恢复 777/2 |
| 输出口径替换 | 候选计数器 | ratio=8 时 text/reasoning/raw 合并输出 20；raw 替换后 17；插件收缩后 11；真实 output=0 覆盖 |
| TUI 离开时 daemon 仍执行 | 数字 owner 的同一 active 槽/一次性 live 通知 | 新读取立即得到 777/2，测得 SQL=0；后续通知 777/4，之后 checkpoint 可恢复 |
| 显式移除与数字 fork | 真实 EventV2 MessageRemoved 回调 + 候选投影/fork 数值方法 | request 物理总量 977/22 不退款；可见 Session 为 200/20；选定前缀 clone 为 777/2，无 active 槽复制 |
| 有界增量成本 | 当前真实 tokenAccounting、`89db8e0e23` 的真实 measure/summarize/project 数学模块与候选 owner | 见下表，10k 无关行不进入每 delta SQL |

这些记录不证明真实双 ESC 键盘交互、全部 UI/HTTP 或全套类型检查已经通过。临时 owner、proof 表、loader 和对应测试不搬进生产；当前不再要求它们的正式 Schema、迁移、checkpoint 事件或 replay 测试。原型曾因导入重复出现 1554/4，该问题属于已撤销的导入设计，不将其变成当前的新护栏或新用例。

性能原型最后一轮，同一进程交替测 30 批，每批 8 个活动请求、3 个消费者、300 个驻留助手；数据库另有 10,000 条无关 step：

| 路径 | p50 / 批 | p95 / 批 | 访问量 |
| --- | --- | --- | --- |
| 当前 dev1-smark TUI 统计函数 | 0.3976ms | 1.8787ms | 30 批共 216,000 次历史 getParts |
| `89db8e0e23` 缓存贡献、共享 summary/project 模块 | 0.3379ms | 0.5827ms | 变化消息测量一次，复用数值贡献；非旧 Daemon 完整运行 |
| 候选增量数字 owner | 0.0292ms | 0.1053ms | 测得 delta 阶段 SQL=0；恢复查询命中 request 主键索引 |

旧优化模块的结果已证明现成的共享计算可复用，不需要为追求候选数字 owner 的更低耗时而重构整套统计。上述时间仅是本机固定负载测量，不是当前方案或整个 Daemon 的性能承诺。本轮不新增、扩写或重跑原型。

### 18.4 实施验证命令

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session-info-selection.test.ts` | `packages/core` | 未确认输入不因 completed 消失，确认零仍有效 |
| `bun test test/util/token-estimate.test.ts test/util/token-accounting.test.ts test/request-usage.test.ts` | `packages/tui` | 归零红测、多步尾部、共享显示与现有资源语义 |
| `bun test test/session/processor-effect.test.ts` | `packages/opencode` | 复用现有中断与保存 fixture 核对 Part 事实 |
| `bun test test/provider/anthropic-messages.test.ts` | `packages/llm` | 已知输入沿单一 StepStart 交付，保留最终 merge |
| `bun run ./packages/sdk/js/script/build.ts` | repo root | 仅随实际 V1 合同变化生成，不手改 |
| `bun typecheck` | 各实际修改的 package 目录 | 常规类型检查，不为未改模块扩建测试 |

性能验收沿用原优化的工作量边界：同一消息变化只测量一次，多消费者共享数值；delta 不因 token 统计增加历史查询、解包或持久化；打开消息不增加正文恢复范围。不新建 benchmark 工程、不以单次毫秒数设硬门槛、不要求已撤销的 checkpoint 机制。方案阶段未执行这些生产检查；当前实际实施结果见第 23 节。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 当前只有本 plan；实施不预设新增生产/测试文件 | 使用现有模块和 fixtures |
| Files modified | 第 15 节实际必要接点 | 以旧共享计算适配、少量确认字段和消费者接线为主 |
| Files deleted | 0 个必须整文件删除 | 仅删除被替代的重复计算与错误判断 |
| Production lines | 不再以废弃稿的 700–1,050 行为目标；纯复用与必要新逻辑分开核算 | 禁止恢复新表/事件/服务来用满预算 |
| Test lines | 现有 fixture 的必要断言，不预留 450–650 行测试工程 | 第 16 节实际回退即可 |
| Generated lines | 仅实际 V1 合同变化对应输出 | 不手改、不扩大 current Protocol |

## 20. Real Risks and Open Decisions

- 旧 finish 缺少原始 presence 时只能保持已发布确认语义，不能凭正文猜报告缺失；新事实通过原 Part 明确保留。
- 旧共享模块需要适配 1.19 的现有确认投影，不能重复叠加页内确认；这是接线要求，不是重建后端账本的理由。
- 原 viewer 裁剪与冷页恢复应复用已有事实，不另增读取、解包或导入。未实施的最终接线不能被历史原型冒充已通过。
- 工作区已有消息外观修改；未来接线不能覆盖它们。

### Open Decisions Requiring the User

无需要用户再选的产品方案。当前 GOAL 要求实施、验证和提交；R5 方案门禁已通过，实际实现仍须独立审计，不因终态更新恢复已废弃的额外架构。

### Rejected Speculation

- 不设计无限期保存每个 raw token、分布式恢复或跨进程 provider 重跑。
- 不把独立 Core native compaction/retry 纳入 TUI 回退修复。
- cold Stats 缺字段不证明必须新建统计解冻或数字导入；用户打开的消息已有恢复流程。
- 不因历史原型有事务、replay 或重复导入问题，给已经撤销该架构的生产方案继续添加护栏和测试。
- 不新增底数、只增不减、错误吞掉后显示旧值或多 tokenizer 竞速。
- 不修改原 provider selection、安全过滤、权限或冷数据损坏门禁；它们不属于导致归零的 lifecycle 过滤。

## 21. Audit Contract

R6 第一次调用 `ses_e50d9a4acffeZVaqVXstgIolZ2` 被用户中止，没有 verdict。用户随后明确 8 个生产文件/800 行及不扩展协议、生命周期、下游的边界，并授权一次联合方案与实现审计。当前实际 diff 已按该边界收缩；本次联合审计同时记录第 6 轮方案结论与第 2 轮实现结论，不继承旧批准，不追加分开的审批循环。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01、B-02、B-03，原文见下 | N-01，原文见下 | BLOCK | `ses_e5367c71cffe1yTu9Ez4DTKO4Z` |
| 2 | R2 | yes | B-04，原文见下 | 无其他独立非阻断发现 | BLOCK | `ses_e535794d8ffeY3YYVyhWrue8la` |
| 3 | R3 | yes | No blocking findings. | N-02，原文见下 | APPROVE | `ses_e535794d8ffeY3YYVyhWrue8la` |
| 4 | R4 | yes | B-05，经同轮复核撤回 | 无 | APPROVE | `ses_e5302162dffevmNwAzm7I3iWez` |
| 5 | R5 | yes | No blocking findings. | N-03，实施证据需按实际 diff 更新 | APPROVE | `ses_e5302162dffevmNwAzm7I3iWez` |
| 6 | R6 | yes | B-01，原联合结论保留待复核 | index/运行验证记录，见第24节 | BLOCK | `ses_e50b86ea3ffeMQru9jXam7Lx4V` |

R2 材料性修订：用户新增“必须证明用户关心/可达、不得额外解冻或扩张性能开销”的原文已进入第 1 节。依据当前 TUI handler/hydrate 事实撤销 R1 自行扩大的 Core native 接线；修正旧页复用路径、每次 prepared 身份及测试命令。R1 verdict 保留，不将其改写为通过；R2 由新独立完整审计重新判断 blocker 是否在更新后的完整需求中成立。

R3 材料性修订：核验 B-04 的真实 TUI native-adapter -> Anthropic 起始帧链路，运行第 18.2 节红测，补齐已报告输入通过既有 StepStart 交给同一 handle 的最小方案。保留 R2 对额外解冻、独立 Core native orchestration、定时 checkpoint 的排除；不扩展 raw 流或引入新 LLM 事件类型。

未送审实验稿：在工作区外执行第 18.3 节原型，曾拟增加 request-global revision、数字 checkpoint、旧页导入及事务基数处理。未进行独立审计，也没有实施生产代码，不占用审计编号。

R4 当前修订：接受用户“对齐旧分支、只处理关键点，不建冗余统计和测试”的纠正，撤销上述子系统设计。改为现有确认 gate 修正、旧共享测量复用和必要报告字段保留。最新 GOAL 更新终态后，对现有真实 helper 复跑第 18.1 节最小反馈，仍为 777/2 -> 0/0，1.384s、退出码 1；没有扩建原型。此前将编辑稿误写为 R5，现按已完成的 3 轮审计纠正为 R4；一次未启动的空调用不计轮次。以下 R1–R3 原文仅作历史，不属于当前设计，也不提供实施许可。

### Round 1 Original Findings And Verdict

### B-01 现有 cold-v2 数值投影无法恢复计划承诺的中断输出

- Violated invariant: INV-01、INV-03、INV-04、INV-09；已保存的未确认输出应在重新进入 TUI 后继续参与估算。
- Evidence class: reachable
- Producer and execution path: reasoning delta 被 processor 接纳，中断 cleanup 保存完整 reasoning；历史达到归档条件后，cold writer 将正文移入 pack、热行正文清空。首次打开旧请求时，计划禁止解包 cold-v2，但现有 Stats 没有保存 reasoning 字符数。
- Source evidence: `packages/opencode/src/session/processor.ts:636`、`:992`；`packages/core/src/storage/cold-store.ts:274`、`:295`、`:1425`；`packages/core/src/storage/cold-codec.ts:695`、`:754`；`packages/core/src/storage/cold-storage.ts:614`；`packages/core/src/storage/cold-codec.ts:1012`。
- Canonical-plan evidence: §10.6，`docs/plans/token-usage-continuity.md:184-186` 同时承诺恢复旧未确认尾部和“cold-v2 不解包”；§16 第 8 条没有覆盖已归档 reasoning/子会话 text。
- Responsibility owner: SessionRequestUsage 的历史导入与 cold-aware 存储读取边界。
- Concrete behavioral consequence: 一个没有 step-finish、保存了 64 字符 reasoning 的中断步骤，按默认密度应恢复 16 个输出 token；现有 cold-v2 热行和 Stats 无法提供这 64 字符，按计划路线恢复会得到零或无法完成。中断工具参数也存在同类缺口：原文保存在 `metadata.raw`（`processor.ts:1023`），而 Stats 对 error tool 计算的是解析后的 `state.input` 长度（`cold-codec.ts:509`）。
- Minimal correction direction: 历史导入应按已发布存量格式定点读取真正保存的未确认输出，在缺少相应数值投影的 cold-v2 边界允许必要的有限恢复，并补齐归档后中断重开的行为测试。

### B-02 独立的 native compaction stream 未接入统一用量路径

- Violated invariant: INV-01、INV-03、INV-04、INV-07；每个实际 provider 请求的未确认输出都应由同一数值 owner 保存和恢复。
- Evidence class: reachable
- Producer and execution path: native runner 可在普通 provider turn 之前进入 `SessionCompaction.compactAfterOverflow`。压缩拥有自己的 `llm.stream`、prepared 回调、局部 `chunks` 和 finalizer，不经过 `createLLMEventPublisher`。压缩已经输出文本、尚未报告 usage 时中断，Failed 事件只携带初始零确认用量，局部文本随后释放。
- Source evidence: `packages/core/src/session/runner/llm.ts:410`；`packages/core/src/session/compaction.ts:265`、`:274`、`:294-324`；`packages/core/src/session/projector.ts:167`、`:295`；`packages/core/test/session-runner.test.ts:2797`、`:2844`。
- Canonical-plan evidence: §9、§10.4 和 §15 将接入位置限定在 processor、runner/publisher、projector；文件计划没有 `packages/core/src/session/compaction.ts`，TDD 切片也没有“压缩输出一半后中断并重开”。
- Responsibility owner: SessionCompaction 的实际 stream 生命周期，数值规则仍由 SessionRequestUsage 负责。
- Concrete behavioral consequence: 即使普通 V1/native 请求全部完成计划接线，压缩文本的未确认输出仍没有进入数字 handle 的生产路径；中断后的 GET、Session 累计和退出显示无法恢复这部分消费。仅修改 RequestEstimated 或 projector 无法取得压缩私有缓冲中已经接收的输出长度。
- Minimal correction direction: 将现有 compaction stream 的 prepared、已接收文本和终态直接接入同一个用量 handle，并增加压缩中断后重连的公共接口测试。

### B-03 native 助手身份不能唯一标识每次实际 provider 请求

- Violated invariant: INV-02，以及 §10.1“每个实际 provider 请求的数值贡献”合同；后续请求不能覆盖前一个请求的未确认贡献。
- Evidence class: reachable
- Producer and execution path: native 不完整响应会通过现有 retry 再次执行 `llm.stream` 和 prepared 回调，但 publisher 保留同一个 `assistantMessageID`。计划却使用该助手身份作为 `step_id`，而子表唯一键是 `(session_id, step_id)`。
- Source evidence: `packages/core/src/session/runner/llm.ts:500-507`、`:605-620`；`packages/core/src/session/runner/publish-llm-event.ts:234-244`；`packages/core/test/session-runner.test.ts:1054-1079`。
- Canonical-plan evidence: §10.2，`docs/plans/token-usage-continuity.md:154-158`；§10.3 要求逐 step 替换后求和；§16 第 9 条要求保护 retry/discard。
- Responsibility owner: SessionRequestUsage 的贡献身份及 native prepared 接入边界。
- Concrete behavioral consequence: 第二次 prepared 即使分配了新 ordinal，也仍命中同一个主键；按 `new - old` 更新时会替换第一次请求的估算。该表示无法分别保存两次实际请求的冻结估算、报告 presence 和有效贡献，后续中断及重开会永久丢失前一次贡献。
- Minimal correction direction: 数值贡献身份应在每次实际 prepared 请求时独立分配，助手 ID 仅保留关联关系，同时维持现有单助手重试和正文撤回语义。

### N-01 验证命令仍包含不存在的测试文件名

`docs/plans/token-usage-continuity.md:326` 使用 `test/session/prompt-effect.test.ts`；当前实际文件是 `packages/opencode/test/session/prompt.test.ts:1`。计划已经要求运行前修订，因此属于命令记录修正，不单独阻断放行。

### Release verdict

**BLOCK — `docs/plans/token-usage-continuity.md`，Revision R1，full-scope。**

保留 **B-01、B-02、B-03**。修订同一 canonical plan、递增 revision、保持实施禁止后，重新进行完整范围审计。

### Round 2 Original Findings And Verdict

## Blocking findings

### B-04 中断前已报告的输入用量仍无法到达统一数值 owner

- **Violated invariant:** 用户要求“已经有确认的部分使用确认的那一套结果”；INV-01 要求报告值存在时优先采用，INV-04 要求该事实可以持久恢复。
- **Evidence class:** reachable
- **Producer and execution path:** TUI `promptAsync` → V1 `SessionPrompt` → `SessionProcessor` → 已支持的 native LLM adapter → Anthropic Messages。Anthropic 在 `message_start` 中报告输入用量，parser 将它保存在内部状态；用户在输出过程中双击 ESC、尚未收到最终 `message_delta` 时，该用量没有成为 processor 可消费的事件。
- **Source evidence:**
  - 当前 TUI 入口：`packages/tui/src/component/prompt/index.tsx:1333`；V1 handler 调用 `promptSvc.prompt`：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:437`。
  - V1 的 native adapter 选择及流接入：`packages/opencode/src/session/llm.ts:261`、`packages/opencode/src/session/llm/native-runtime.ts:136`；Anthropic 是该 adapter 已支持的 provider：`packages/opencode/src/session/llm/native-runtime.ts:60`。
  - 输入报告被解析为 inclusive `inputTokens`：`packages/llm/src/protocols/anthropic-messages.ts:671`；`onMessageStart` 保存 usage 后返回 `NO_EVENTS`：同文件 `:750-752`。
  - usage 到最终 `message_delta` 才随结束事件输出：同文件 `:880-890`；processor 在 `step-finish` 消费它：`packages/opencode/src/session/processor.ts:790`、`:809`。
  - 现有 fixture 已覆盖“起始帧报告 5 个普通输入、1 个缓存输入，最终帧仅报告输出”的正常数据：`packages/llm/test/provider/anthropic-messages.test.ts:384`、`:394-409`。
- **Canonical-plan evidence:** §9 将已报告轴归属 LLM Usage 适配边界；§10.3 承诺报告优先；但 §15 的变更路径停留在 processor、`Session.getUsage` 和下游 Schema，没有把 parser 中提前获得的用量送出。§16 第 3 条验证的是已到达数值 owner 的部分 usage，无法发现这个上游事实缺口。见 `docs/plans/token-usage-continuity.md:139`、`:170`、`:256-269`、`:282`。
- **Responsibility owner:** 当前 TUI 使用的 LLM 协议／适配边界负责交付已报告事实；`SessionRequestUsage` 负责对同一步采用、保存和恢复该事实。
- **Concrete behavioral consequence:** 即使 R2 完整实施，若 prepared 输入估算为 777，而起始帧已经报告 inclusive 输入 6，最终帧到达前中断后仍只能保存并恢复 777。输出估算可以保住，但已经存在的真实输入报告仍被丢失，未满足“确认部分用确认值”。这条路径属于 R2 明确包含的 **V1 native LLM adapter**，无需扩展到独立 Core SessionRunner。
- **Minimal correction direction:** 在现有 LLM 适配边界将提前报告的输入用量交付给同一个 step handle，并补充“收到输入报告、最终 usage 前中断、重新读取”的行为测试，沿既定 checkpoint 保存，不新增扫描或备用估算路径。

## Non-blocking findings

无其他独立非阻断发现。

## Rejected speculation

- **不要求新增冷数据解冻入口。** 当前 `hydrate` 已恢复本页选中的 Part，再进行 viewer 裁剪，R2 可以直接复用这些值：`packages/opencode/src/session/message-v2.ts:615-625`。
- **不保留 R1 对独立 Core native compaction 的范围要求。** 当前 TUI 的 summarize handler 进入 V1 compact，摘要复用 `SessionProcessor`，调用链成立：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:387`、`packages/opencode/src/session/compaction.ts:585-590`。
- **不保留旧版“助手 ID 作为 step 身份”的问题。** R2 §10.2 已明确每次 prepared 独立分配 step ID，助手只作关联。
- 不要求恢复未持久化的硬杀尾部、追溯扫描未打开历史，或为真实确认零设置非零下限。

## Primary-path and fallback verdict

R2 的主方向成立：**一个 step 数值 owner、一个有效用量公式，live 与 durable 交付同一事实。** 已打开旧数据的适配具有真实存量依据，未发现新增失败后备用成功算法。

B-04 要求补齐同一主路径的事实输入，现有的持久化、聚合和显示设计可以继续承载。

## Release verdict

**BLOCK — `docs/plans/token-usage-continuity.md`，Revision R2，full-scope。**

保留 **B-04**。当前修订尚不能放行；修订 canonical plan、递增 revision、保持实施禁止后，进行下一轮完整范围审计。

### Round 3 Original Verdict

## Blocking findings

No blocking findings.

本结论覆盖完整 R3、全部计划变更区域及其直接影响的生产路径。

## Non-blocking findings

### N-02 实验摘要尚未同步 R3 的第二个反馈信号

`docs/plans/token-usage-continuity.md:531` 仍写“当前仅有第 18.1 节红测”，而 §18.2 已新增起始输入报告的反馈脚本和结果记录，见同文件 `:346-366`。

这是记录修正，不影响设计、测试可执行性或本轮放行。

## Rejected speculation

- **不要求新增冷数据解冻路径。** 当前消息页已在 viewer 裁剪前恢复选中 Part，R3 复用该批事实即可：`packages/opencode/src/session/message-v2.ts:615-625`。
- **不要求接入独立 Core native orchestration。** 当前 TUI compact 进入 V1，并复用 `SessionProcessor`：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:387`、`packages/opencode/src/session/compaction.ts:585-590`。
- **提前发送 StepStart 不构成已证明的 Core 空助手回归。** 当前 Core publisher 对 `step-start` 直接返回；独立 compaction 仅在 `step-finish` 结算，均不会因新增可选 usage 重复计费：`packages/core/src/session/runner/publish-llm-event.ts:292-293`、`packages/core/src/session/compaction.ts:320-323`。
- 不要求扫描未打开历史、恢复硬杀前未持久化的尾部，或给真实确认零设置非零下限。

## Requirement and traceability coverage

| 审计范围 | 结论 |
|---|---|
| 新旧分支及性能提交 | 已核对 `dev-smark`、`dev1-smark` 的固定 revision，以及 `89db8e0e23` 的共享贡献、数值缓存和读取优化；计划保留这些收益。 |
| 确认优先、部分报告、真实零；INV-01/06 | 每轴报告优先，缺失轴继续估算；cache/reasoning 保持 inclusive 口径，估算不伪造费用。 |
| 多步累计与重试；INV-02 | 每次 prepared 独立 step 身份，同一步确认替换自身估算，原子差分维护累计。 |
| 中断、退出重进、分页；INV-03/04 | active 数字槽、边界 checkpoint、终态提交顺序和 GET 恢复形成完整路径。 |
| 性能与消费者统一；INV-05/07 | 删除 TUI 正文统计；prompt、sidebar、subagent、footer、context、exit 消费同一数字投影。 |
| 交错、存量和历史修订；INV-08/09/10 | 覆盖旧 GET/SSE、重复提交、事务失败、已有零账本、冷页恢复及 revert/remove/fork。 |

**B-04 在方案层已闭合。** R3 §10.3 明确由现有 StepStart 携带已报告输入，排除起始 output 前缀，保留终态 merge；§15、§16 已补齐修改位置和“777 估算 → 报告输入 6 → 输出 8 字符 → 中断重读 6/2”的敏感测试，见 `docs/plans/token-usage-continuity.md:175-177`、`:272`、`:294`。这修复了 parser 已知事实未交付的首个错误转换。

正反映射完整；新增 step 子表、active 槽、汇总列、版本和存量适配均有当前行为依据。测试切片能捕获原缺陷，验证命令采用包内工作目录。

**代码质量与中文注释：** 计划遵守依赖方向、共享 Schema、生成客户端和局部修改边界，明确删除被替代的统计分支。§17 承诺实施时达到 `C >= max(1, ceil(E × 0.15))`，预算可行。当前任务仅改 Markdown，实际 `E=0、C=0`，比例不适用；无关 TUI 工作区修改不计入。

本轮未运行测试或重放实验，未修改文件。实现、客户端生成、真实 TUI 交互和并发性能仍须按 §18.3 验证。

## Primary-path and fallback verdict

通过。

权威路径保持为：**实际请求与输出事实 → 同一个 step handle → 每轴有效用量 → 数字差分投影 → 统一消费者。**

live 与 durable 是同一事实的交付形式；旧页补数字复用已有 hydration；新增 StepStart 字段补齐同一主路径的输入。未发现失败后备用算法、吞错归零、额外扫描或无依据的恢复机制。

## Release verdict

**APPROVE — `docs/plans/token-usage-continuity.md`，Revision R3，full-scope。**

本次批准仅适用于该计划修订。当前任务保持 `approved-plan-only`，由 primary 原样记录 verdict 后停止，不实施代码或提交 Git。

独立 verdict 已原样记录。N-02 已作记录性勘误：第 23 节现在同时列出第 18.1 和 18.2 节的两个红测，未改变 R3 设计、测试要求或批准范围。

### Round 4 Original Release Verdict

**BLOCK — `docs/plans/token-usage-continuity.md`，Revision R4，full-scope。**

保留 **B-05**。当前修订尚不能覆盖用户要求的正常退出重进场景，保持实施禁止。

### Round 4 Reconsideration Verdict

## Blocking findings

No blocking findings.

本轮复核撤回 **B-05**。结论覆盖完整 R4，计划及相关生产代码均未修改。

## Rejected speculation

### B-05 撤回：将中断后的恢复要求扩大到了活动流的未持久化片段恢复

独立核对确认：

- 旧分支同样在内存累积 text delta，仅广播更新：`dev-smark:packages/opencode/src/session/processor.ts:947-966`。
- 旧分支的 delta 发布没有持久化：`dev-smark:packages/opencode/src/session/session.ts:942-950`。
- 旧分支正常退出 TUI 后也允许 daemon 继续运行：`dev-smark:packages/opencode/src/cli/cmd/tui/thread.ts:157-173`。
- 当前 processor 在中断 cleanup 保存文本、reasoning 和工具 raw：`packages/opencode/src/session/processor.ts:985-1026`；R4 §10.5、§16 覆盖保存后重新打开的计算与验证。

此前 B-05 的执行路径成立，但它证明的是：**请求尚未中断、尚未保存时，重建客户端不能恢复此前的全部活动输出估算。** 原始需求的具体故障是中断后清除已有估算，并要求重新打开时保留该结果；结合对齐旧分支、限制修改语义的要求，没有充分依据把本次修复扩展为新的活动流恢复合同。

因此，B-05 属于本轮审计对修复范围的过度扩张。新旧代码中都存在这条路径，R4 没有引入、加重或使其新增可达，不能据此要求增加 daemon 状态、checkpoint 或新的读取接线。

## Primary-path and fallback verdict

通过。

权威路径保持为：

**既有请求及 Part 事实 → 每消息测量 → 共享数字汇总 → 各视图按原范围显示。**

确认与估算属于同一合同；旧 finish 的兼容有真实存量依据。未发现新增失败后备用算法、吞错成功、额外解冻或无依据的统计子系统。

## Release verdict

**APPROVE — `docs/plans/token-usage-continuity.md`，Revision R4，full-scope。**

该结论替代本轮先前的 BLOCK，**B-05 撤回**。批准仅适用于当前未修改的 R4；实现验证、实际 diff 审计和提交门禁仍须后续完成。

### Round 5 Original Verdict

No blocking findings.

本轮覆盖完整 R5、全部计划变更区域，以及当前新增 producer 对统计路径的影响。

### N-03 实施证据仍是 R4 实施前的快照

`docs/plans/token-usage-continuity.md:671-700` 仍记录“尚未实施”和 `E=0`，当前工作区已经存在相关代码与测试修改，例如：

- `packages/opencode/src/session/processor.ts:818-819,860-882`
- `packages/tui/src/util/token-accounting.ts:55-145`
- `packages/tui/test/cli/cmd/tui/sync.test.tsx:1332-1363`

这部分记录应明确其历史阶段；后续实现审计须以实际 token diff、验证结果和重新计算的 E/C 为准。该记录问题不影响 R5 方案的可执行性。

### Release verdict

**APPROVE — `docs/plans/token-usage-continuity.md`，Revision R5，full-scope。**

批准仅适用于当前 R5 方案，不覆盖当前工作区实现 diff。完成实际验证、独立实现审计并确认仅包含本任务差异后，才能进入提交阶段。

## 23. Implementation Evidence

### Actual Files and Diff

当前准确差异为6个生产文件、7个既有测试文件及本 plan，生产新增加删除779行。共享 index 曾被其他任务改动/清空，不以暂存区作为审计依据。以下不可变快照只含本任务 hunks；route 的工具隐藏、processor 的工具/重试及其测试中的并行用例与导入均排除，未回退其他工作。

| Area | Actual files | Necessity |
| --- | --- | --- |
| Core | `packages/core/src/session/info.ts`、`packages/core/test/session-info-selection.test.ts` | 去掉 completed 清零，保持确认、索引和模型步骤边界 |
| Withdrawn | 原 Schema/SDK、LLM protocol/lifecycle/event/test、TUI prompt/sidebar/subagent/context | 本任务 hunk 全部恢复 HEAD；保留原合同及调用 |
| Existing confirmation and persistence | `packages/opencode/src/session/processor.ts`、`packages/opencode/test/session/processor-effect.test.ts` | 原 confirmed 依 usage 交接；复用 HTTP/保存 fixture，不重构保存链 |
| Shared computation | `packages/tui/src/util/token-estimate.ts`、`packages/tui/src/util/token-accounting.ts`、`packages/tui/src/context/sync.tsx` | 每消息测量、确认替换估算、数字共享及对称释放 |
| Remaining consumer | `packages/tui/src/routes/session/index.tsx` | 仅 footer/exit 接有效显示值；其余消费者保留旧 API 和确认消费口径 |
| Existing regression seams | `packages/tui/test/util/token-estimate.test.ts`、`packages/tui/test/util/token-accounting.test.ts`、`packages/tui/test/util/presentation.test.ts`、`packages/tui/test/cli/cmd/tui/sync.test.tsx`、`packages/opencode/test/token/accounting.test.ts` | 原 fixture 增补中断、子记录和重建断言，适配真实零、及时确认及字面量类型；context fixture 已恢复 HEAD |

当前完整隔离快照：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b09da50b001uPOg9eTBZMXgqJ`；基线 `72c2142d47f0e5fe560f74ab3b61fe853924ebd6`，快照内 patch SHA256 `f0046b96804f173b34366f556d2ec6ce66dda53d1b8e85e7941140198d0ca1f3`。以该快照和当前源码逐 hunk 核对；plan 通过本路径读取，不能把共享 index 或整个 worktree 当作本任务差异。

### Red-Green Test Evidence

- 原 helper 中断后输出 0 -> 保留 2；真实 SQL completed 后估算 null -> 保留 777。R6 撤回起始 usage 扩展，不以历史实验充当当前验收。
- 原 processor pending-tool interrupt fixture 通过 `MessageV2.get` 核对保存的 prepared 元数据和半截 raw；真实 SyncProvider 两次从同一保存消息页恢复 step/request/session/footer 的 777/2，第二次没有旧 owner。
- R5 宿主子记录红测原为 step=1013/5、request=2013/15；原 helper 和真实 SQL fixture 增补同一角色后保持确认 1000/10，未改变 provider 工具实现。
- 最终 `/context` 原回归暴露下一轮 prepared 分类误用旧 finish：期望 system=150、实际 77。共享 `measureTail` 改为同时识别 prepared 游标和实际新 Parts，下一轮尚无新 Part 时也不借旧报告；原分类断言恢复 150，旧输出不重复占新分类。没有新增测试文件或第二套分类公式。
- 部分 presence 模型及其分类测试已按用户要求撤回，不作为当前验收。旧载体 fixture 加八字符正文后先得到27、独立期望25，定向测试 exit1；统一原 tokens 载体后该断言通过。
- 原无 usage 的 `reply().reason("think").text("done").stop()` HTTP fixture 新增断言先得到 confirmed=true、期望false；修正既有交接后 confirmed=false、input>0、output=2。SQL 原 fixture 也验证全零 finish 未报告时保留777，既有 confirmed=true 后才结束估算。

### Verification Commands and Results

| Command | Working directory | Actual result |
| --- | --- | --- |
| `bun test test/util/token-estimate.test.ts test/util/token-accounting.test.ts test/util/presentation.test.ts test/context-usage.test.ts test/request-usage.test.ts test/cli/cmd/tui/sync.test.tsx` | `packages/tui` | 90 pass、0 fail、699 expect，17.99s；context fixture 已恢复 HEAD |
| `bun test test/util/token-estimate.test.ts test/util/token-accounting.test.ts test/context-usage.test.ts` | `packages/tui` | 最后调整为共用消息 prepared 快照后43 pass、0 fail、516 expect，4.00s |
| `bun test test/session-info-selection.test.ts` | `packages/core` | 4 pass、0 fail、17 expect，938ms；只复用既有 confirmed |
| `bun test test/provider/anthropic-messages.test.ts` | `packages/llm` | 恢复原文件后 30 pass、0 fail、231 expect，618ms，未增加协议测试 |
| `bun test test/session/processor-effect.test.ts test/token/accounting.test.ts` | `packages/opencode` | 45 pass、0 fail、218 expect，138.58s；包含并行任务增加的既有文件用例，不将其计为本任务新增 |
| `bun test test/token/accounting.test.ts` | `packages/opencode` | 最终旧入口5 pass、0 fail、9 expect，5.70s |
| `bun typecheck` | 分别为 `packages/tui`、`packages/core`、`packages/schema`、`packages/opencode` | 当前四个修改包均 exit 0；fixture 曾把 union Part 的 time 改窄而触发 TS2322，改用实际 Sync Parts 后通过 |
| `bun run ./packages/sdk/js/script/build.ts` | repo root | 撤回 Schema 后再次正式生成成功；生成类型与 HEAD 无差异 |
| `git diff --check -- <本任务路径>` | repo root | exit 0 |
| `bun run lint -- <12 个代码/测试路径>` | repo root | 无 usage 修复前exit0、0 errors、120 warnings；未对既有/并行警告作范围外清理 |

TUI fixture 的缺失 KV 日志不导致失败；没有为该日志修改全局状态或旁支逻辑。并行任务此前的 opencode 类型错误在当前检查中已消失。

实际共享工作量在 R6 收缩后重新通过 `packages/tui` 的 PowerShell stdin `bun -` 执行现有 `sync-fixture.mount`、真实 SyncProvider 和原 delta reducer。三个消费者全部走未改写的 `tokenAccounting` 旧入口：300 个助手首次工具参数序列化共300次；单条 delta 后299条未变化历史为0次、变化消息1次；三个消费者从 output=8 更新到9，额外消息页请求0。观测只在测试数据 input 增加保持同值的 `toJSON` 计数，不改生产或创建新测试工程。旧 text getter 观测方式已弃用，未据此增加生产补丁。

### Original Feedback-Loop Result

2026-11-06 在 `packages/tui` 对实际 `tokenAccounting` 原 fixture 再次执行 stdin 反馈：独立期望中断前后均为 `[777,2]`，实际 before/after 均为 `[777,2]`，exit0；同次命令另验证上述实际旧入口缓存工作量。没有 owner 的一次性调用仍按同一公式测量；真正 TUI 不靠三次一次性扫描。第18.2节早期交付属于已撤回的候选，不再作为 R6 验收。

### Actual Secondary and Replacement Path Inventory

实际沿第 11 节同一主路径：用原 tokens/confirmed 选择报告与估算，无 finish 消息 tokens 为真实存量兼容，空会话和真实零保持原义。删除 completed 过滤和各视图重复全文统计；没有增加备用成功算法、捕错归零、估算账本、表、事件、迁移、provider 重跑或专用恢复入口。request-usage 确认资源、原 page/hydrate 和费用 owner 保留。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| E | 425 | 对隔离快照13个代码/测试路径计新增非空代码；保守上界，未额外扣除复用移动、括号或格式行 |
| C | 64 | 邻近真实载体、缓存 owner/正文释放和测试独立期望；相同搬移注释不计（本次0） |
| C / E | 15.06% | 64 / 425 |
| Required minimum C | 64 | `ceil(425 * 0.15)` |

排除新增空行10、import-only行5、注释行64；生成输出已无改动。本 plan 和并行任务不计代码 E；代表性说明位于原载体/游标选择、差额去重、Sync 绑定/释放及旧消息/重建 fixtures 独立期望旁。

### Remaining Unverified Items

用户额外授权的最终联合复核仍为 BLOCK，开放 B-03、B-04，见第24节；不能设置 verified 或提交。真实双 ESC 键盘注入尚未执行；后端实际中断、保存重读及新建 TUI owner 已覆盖。未承诺硬杀前未保存片段或后台活动流丢失 delta 的恢复；不为其增加新合同。

## 24. Implementation Audit Record

### Round 1: R5

Invocation reference: `ses_e50eaddaaffeKZp2lGRvcaJBgV`。以下保留独立原始 finding 分类与 release verdict；R6 尚未获得实施批准。

## Blocking findings

### B-01 Anthropic 的早期缓存输入被计入永久记录的纯 input

- **Violated invariant:** INV-01、INV-06、INV-07；已经报告的分类应使用确认值，同时保持 footer、退出记录原有的纯 input 口径。
- **Evidence class:** reachable
- **Producer and execution path:** TUI native adapter → Anthropic `message_start` → 带 usage 的 StepStart → processor 保存 Part → 中断 cleanup → 共享 accounting → footer／退出记录。
- **Concrete behavioral consequence:** 对上述真实 fixture，在最终 usage 前中断，footer 和退出记录会将已知的缓存输入一起显示为纯 input=6；已确认的纯 input 实际为5。缓存占比越高，偏差越大；保存后重开仍然无法恢复已经丢掉的分类。
- **Minimal correction direction:** 在既有 Part 保存边界保留早期报告已有的输入分类，并由共享 accounting 按原口径计算 pure input。

### B-02 部分 finish 的未知输出在 `/context` 分类中仍被当作确认零

- **Violated invariant:** INV-01、INV-07；缺失输出报告时，各视图应继续使用同一步的输出估算。
- **Evidence class:** reachable
- **Producer and execution path:** 支持部分 usage 的 provider → StepFinish → processor 保存 `reportedUsage: { input }` 和规范化 output=0 → `measureMessage` → `projectAccounting.breakdown` → `/context`。
- **Concrete behavioral consequence:** 同一步已报告 input=500、保存8字符输出、尚未报告 output 时，主统计按默认密度显示 output=2，`/context` 的本步输出明细却显示0。当前 helper 测试覆盖了前一种结果（`packages/tui/test/util/token-estimate.test.ts:110-111`），没有覆盖同一事实的分类结果。
- **Minimal correction direction:** 输出分类使用同一报告 presence 判定；缺失输出报告的 finish 继续消费已测输出字符。

## Non-blocking findings

- 本轮仅执行了只读 Git 检查；`git diff --check` 通过。
- 定向测试、类型检查和内存复现已请求执行授权，当前尚未获得授权。Plan §23 中的通过记录属于 builder 声明，本轮未将其当作独立执行证据。
- 直接读取的回归断言能够区分 completed 清零、真实零确认、prepared 游标和宿主子工具归属；上述两个跨视图问题尚缺少对应断言。

## Rejected speculation

- 不要求恢复硬杀前从未保存的 delta，也不要求新增 checkpoint、后台扫描或活动请求存储。
- 不将独立 Core native runner／compaction 扩入当前 TUI 修复。
- `executeParent` 排除有现成模型历史归属依据：`packages/opencode/src/session/message-v2.ts:843-845`；它不是无依据的过滤。
- 未发现支持新增 tokenizer、重试、解冻入口或备用统计算法的证据。

## Code quality and Chinese-comment verdict

未发现新增 `any`、类型压制、权限弱化或无依据依赖。共享缓存和拆分函数有性能要求及旧实现依据。

独立按实际 diff 逐项核算：

- 新增行：586。
- 排除生成行8、空行8、import-only 行4、中文解释注释78，以及类型定义的纯格式变化2行。
- **E = 486，C = 78，C/E = 16.05%。**
- 注释分布在确认边界、步骤归属、媒体密度、缓存生命周期及回归断言附近；中文注释比例通过。

类型检查和运行验证尚待授权，不能据此声明验证门禁全部通过。

## Release verdict

**BLOCK — R5 当前实现 diff，基准 HEAD `11d619643fcde110d67d3db3b916a70cf5cb8090`。**

B-01、B-02 尚未解决；本轮运行验证也未完成。当前不能设置为 `verified` 或进入提交阶段。本轮未修改任何文件、索引或 Git 历史。

### Round 2: R6 Joint Original Verdict

Invocation reference: `ses_e50b86ea3ffeMQru9jXam7Lx4V`。

## Blocking findings

### B-01 已确认的旧消息输出会在 footer 中再次叠加正文估算

- **Violated invariant:** INV-01、INV-06、INV-07：已有确认值应替换估算，同一份输出只能计入一次。
- **Evidence class:** reachable
- **Concrete behavioral consequence:** 沿已有兼容 fixture，给消息保留正常的八字符正文、无 `inputEstimate` 和 step-finish，账本确认输出仍为 25；当前公式在默认密度下再加入 `8 / 4 = 2`，footer 显示 **27**。修改前该 footer 直接显示账本的 **25**。这是本次接线引入的重复统计，涉及用户重新打开历史消息后的准确性。
- **Minimal correction direction:** 在共享测量入口按既有合同识别无 finish 的旧确认载体，再统一计算未结算差额；用现有兼容 fixture 加入正文验证即可，无需增加存储、恢复分支或下游特判。

## Non-blocking findings

- **审计快照与暂存区记录不一致。** Plan §23 声称 `git diff --cached` 仅含本任务；审计开始时暂存区包含其他任务，期间索引又被清空，HEAD 保持 `566aebc540`。本轮以指定隔离快照 `tool_1af4368a40011rrbwxIMbmat8z` 核对本任务 hunks，并直接读取当前源码；不能把本结论扩展到整个工作区或后续提交。
- 本轮只执行了只读 Git 检查，`git diff --check` 通过。已请求定向测试与 package-local typecheck 授权，尚未获得授权，未执行这些命令。Plan 中的通过表未被当作独立运行证据；真实双 ESC 键盘操作也仍未验证。

## Rejected speculation

- 不要求恢复硬杀前从未持久化的片段，不要求新增 checkpoint、后台扫描或统计解冻入口。
- 不把独立 Core native runner／compaction 扩入当前 TUI 修复。
- `executeParent` 排除有模型历史归属依据，见 `packages/opencode/src/session/message-v2.ts:847`，属于消除宿主子记录的重复计数。
- 撤回提前 usage 交付后，不再保留依赖该候选设计的早期缓存输入 finding；当前原有 StepFinish 输入分类没有同一问题。

## Release verdict

**BLOCK — R6 联合方案／实现审计，适用于指定隔离快照及本轮核对的源码。**

B-01 保持阻断，当前不能标记 `verified` 或进入提交。本轮未修改文件、索引或 Git 历史。

后续用户明确要求撤回新增 Schema/传输并恢复 HEAD；当前已删除候选字段及其逐轴分支，原兼容 fixture 加正文的 red 为27、green为25。原 BLOCK 不自行改写，当前将完整原需求、最新约束和全部实际 hunks 交回同一联合审计任务复核。

### R6 Joint Reconsideration

同一 invocation `ses_e50b86ea3ffeMQru9jXam7Lx4V` 完整复核关闭上述 B-01，结论仍为 BLOCK；保留的原 finding 标题为“B-02 服务端未报告 usage 的正常结束仍会把已有估算清成零”。后续修复及 red-green 见第23节，不将测试通过记为审计放行。用户已明确允许一次最终复核，当前 R7 及最新隔离快照提交同一审计任务，尚无最终 verdict。

### R7 Authorized Final Joint Verdict

Invocation reference: `ses_e50b86ea3ffeMQru9jXam7Lx4V`。最终复核覆盖 R7、隔离快照中的6个生产路径和7个测试路径，原 B-01 及 usage 完全缺失的 B-02 已关闭；新增开放 finding 原标题如下：

- **B-03 `usage` 对象存在仍会把未报告的输入确认成零**。审计引用 `packages/llm/test/provider/anthropic-messages.test.ts:763-769` 的仅 output usage fixture；该 fixture 无 message_start，正常 parser 则在 `anthropic-messages.ts:750-752,880-890` 合并 start/delta。此项的生产范围与最小修正尚未决定，不据此新增逐轴传输。
- **B-04 正常 finish 先于消息确认到达时，累计输出会产生负数**。实际发布顺序为 processor 先 Part 后 Message，SDK 可以单独 flush Part 前缀。primary 在 `packages/tui` 用现有 `tokenAccounting` 执行 stdin 复现：prepared=777、正文估算=2、确认前缀=0；无报告 finish 保持777/2，但带真实500/10的 finish 先到时得到 step=777/2、total=277/-8，独立期望500/10，exit1。未新增测试文件或生产逻辑，保留该失败为未解决证据。

独立注释核算 E=420、C=69、16.43%，将 SQL 内5行中文说明计入 C；与第23节保守计数方法不同，均满足比例。审计只运行只读 Git 检查，未独立执行测试/typecheck/lint；不冒充运行放行。

原样 Release verdict：

**BLOCK — R7，基线 `72c2142d47f0e5fe560f74ab3b61fe853924ebd6`，指定快照 `tool_1b09da50b001uPOg9eTBZMXgqJ`。**

原 B-01 和 usage 完全缺失路径已关闭；B-03、B-04 保留为阻断开放决定。当前不能标记 `verified` 或提交。本轮未修改文件、索引或 Git 历史。

## 25. User-Reviewed Changes and Current Evidence

用户已逐项审查18个生产业务HUNK，要求每一处修改说明用途，新增修改须按其授权范围执行。H04恢复HEAD，缺少usage也保留原inputChars/inputBreakdown；H12删除新增confirmedSession返回项，随后用户明确选择“保持当前统一显示”，没有恢复两份返回结构。H05–H11及H13–H18沿原业务入口复用共享数字，时间与内存收益必须实测，不增加传输字段。用户还要求SQL按条件说明行为与误判后果，允许充分注释；当前H01使用顺序判断，H02使用AND NOT排除原本不允许返回估算的情况，查询仍限定当前请求。

### Real-Database Equivalence and Profile

- 数据库以readonly打开并设置query_only，沿原inspectMessageRows/inspectPartRows恢复，不持久解冻、不更新数据。抽样499条随机助手加1条真实中断回归，再展开其完整请求：483个请求、31,557条消息、155,765条内容记录，其中31,166条消息及141,416条内容记录为冷存储。
- HEAD与当前统计的全部返回字段在483个请求上完全一致；未解释差异为0。样本ID及完整输出保存在 `C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b18fff47001JC1t4n2ooyL0XO`，样本SHA256为 `ccfc77768ddcb7dc8f5769a1a314b902a81f8f97b97d76259995bf009b892662`。这证明所测已保存请求的等价性，不替代运行中事件交接的验证或独立批准。
- 对同一批真实数据执行三轮交错顺序、独立进程A/B，覆盖三个消费者、15轮重复读取及末条消息变动后的读取。统计工作量总耗时中位数：HEAD 6339.996ms，当前443.746ms；六次运行校验值均为456933142764。计时不含数据恢复、IPC及完整TUI渲染，不将其宣称为整套产品提速。
- 进程峰值RSS中位数：HEAD 3,674,092KiB，当前2,300,028KiB。缓存持有期间堆增加约32.2MB，释放后相对基线约剩0.66MB；记录的是进程OS用量与GC后的实际占用，不是按代码行推测内存收益。
- 实测发现并经用户批准修复：旧中断消息默认全零tokens覆盖正文估算；公共计算未使用原历史输入比例；工具报错文字漏计。最后一项已确认原模型消息转换会把普通工具报错作为errorText发送，不为无关内容新增计数。

### Compaction Footer

用户明确区分两种底部显示：普通agent loop可只显示新增输入；compaction应显示实际处理的完整输入。用户批准的生产改动仅在原formatUsageStats调用处按既有summary标记选totalInput或totalInputPure，无新接口、查询、存储或计数公式。

真实压缩 `msg_1b1a1b7e8001ojXBTPlDcCDprU` 的完整输入126879、新增输入159，实际显示表达式红测159!=126879；修改后显示126879。真实普通回复 `msg_1b1aa11a7001Xs0KZnBRk2Lyfx` 完整输入110959、底部继续显示新增623；输出和费用均保持。这个compaction请求只有一条助手消息，未混入其他调用。

### Current Checks and Boundary

- `packages/tui`：六个既有统计/上下文/Sync回归文件90 pass、699 expect，9.92s；typecheck通过。compaction显示改动后，原presentation回归4 pass、23 expect，typecheck及diff --check通过。
- `packages/core`：session-info-selection回归4 pass、17 expect，1.387s，包含查询索引范围；typecheck通过。
- `packages/opencode`：原HTTP无usage结束及pending工具中断保存两个定向回归2 pass、24 expect，11.48s。
- 当前任务不可变差异为 `C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b1b106cd001kiUfyLNE9igyIW`，基线 `d8865c42935e5fd44cdc3f629e0fdfbd437987be`，patch SHA256 `7e53ab672a3ab0854c818704d52ccf2f858ece0a539f0da0a96c1ab0cdbb83dc`。包含6个既有生产路径、8个既有测试路径；排除其他任务同文件的工具/重试及显示hunks，无新生产文件。生产新增429、删除381，共810行，含按用户要求补齐的SQL与业务解释，超过原800行建议10行；未为凑数删除必要说明。
- 当前新增侧保守E上界432，邻近中文说明可见新增83行，最低要求65；SQL注释计入说明，空行10及import-only行5排除。尚无针对此准确差异的独立最终计数与放行。
- Schema、SDK、LLM协议以及prompt/sidebar/subagent/context业务模块与HEAD差异为零。共用processor及session页面分别存在其他任务33行、2行暂存修改；按最新GOAL不整文件暂存或提交，不修改其他任务的索引。
- 原B-03、B-04仍未独立关闭，当前producer仍以usage对象存在设置confirmed，共享累计仍有减去finish确认量的计算；不能把真实历史抽样通过当作这些交接路径已通过。原审计及一次额外最终复核额度已用完，当前不调用新审计、不设置verified、不提交，等待用户对后续门禁和隔离提交的明确授权。

## 26. Final User-Directed Verification

### Authority and Audit Record

第25节末尾是当时状态。随后用户明确回答“允许按HUNK隔离提交”，并要求“我觉得你不得再多审计了。那相关的问题怎么解决你自己去处理，这你不能把这个问题甩给我。” 本次遵循该最新指令，不再调用审计员；由已审查HUNK、最小修正与实际验证收尾，未将旧R7的BLOCK改写成APPROVE，Approved revision仍为none。R7保留为最后独立审计编号，没有因普通修改再增加revision。

原审计任务 `ses_e50b86ea3ffeMQru9jXam7Lx4V` 的事实复议不增加轮次，原样结论：

> 撤回 B-03 的 blocking 分类；B-04 保留，原 R7 的 release verdict 仍为 BLOCK。
>
> 原 B-03 从 blocking／reachable 修正为 `speculative`，撤回其阻断及修正要求。
>
> **BLOCK — 原 R7，基线 `72c2142d47f0e5fe560f74ab3b61fe853924ebd6`，快照 `tool_1b09da50b001uPOg9eTBZMXgqJ`。**
>
> **当前保留的阻断为 B-04。** 本次是原 finding 的事实复议，不新增审计轮次，也不构成当前实现的 APPROVE。

B-03的image fixture省略message_start；正常fixture、真实录制及原parser合并规则保留了起始输入用量，没有据此新增逐轴传输或协议处理。B-04随后由以下实际修正及验证解决；没有再次独立复核，其停止来自用户明确指令。

### Final Correction and Verification

- 删除跨来源抵扣：累计和已计入步骤均取同一个request，不能从旧累计扣掉另一路新到的finish数。内部计算也使用真实步骤基数，不再伪造零累计后扣除确认量。当前调用的确认选择集中在原测量入口，去掉多处重复判断；未加负数钳零、最后非零缓存、新协议或新存储。
- 现有交接fixture补齐真实存在的inputEstimate及正文后，先红测为120/2、confirmed=false，独立期望100/10；修复后确认数先到、累计更新前后均为100/10。另用原777/2输入验证：流式和无usage结束均保持777/2；finish确认500/10先到、累计更新后，step/request/session均为500/10。
- 最后一次改动后，复用同一500个样本ID，仍覆盖483个完整请求、31,557条消息、155,765条内容；全部返回字段与HEAD一致、差异0，样本SHA256仍为第25节的ccfc7776前缀值，没有随机更换样本。
- 同批数据最终A/B：HEAD统计总耗时6246.721ms、当前462.564ms，校验值均456933142764。独立子进程持有缓存时堆增加约32.17MB，释放后增量约0.63MB；父进程直接读取Windows PeakWorkingSet64为HEAD 3775791104字节、当前2358304768字节。此范围仍仅为统计计算，不包含整套TUI渲染或数据库恢复时间。
- `packages/tui`：六个原回归文件90 pass、701 expect，9.18s；typecheck通过。`packages/opencode`：无usage结束与中断保存两个原回归2 pass、24 expect，7.80s；typecheck通过。Core SQL、compaction及原始重建验证沿第25节，相关生产逻辑未再次改动。14个代码/测试路径lint为0 errors、134 warnings，未扩展清理既有及并行警告；diff --check通过。
- 最终准确差异：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b20f50eb0012NzFDr9WEIrg7F`；基线d8865c42935e5fd44cdc3f629e0fdfbd437987be，patch SHA256 `2b90a54efa3c138da247ee9344be7870b073d9b27fd251bda09766da1e6fa889`。6个既有生产文件、8个既有测试文件，生产新增433、删除381，共814行；含用户要求补齐的解释，超过原建议14行，无新生产文件、字段或依赖。
- 最终保守E上界456，实际新增中文解释C=85，最低69；排除空行10、import-only行5及相同移动注释0。当前比例至少18.64%，未靠删除代码或拆行凑数。
- 键盘层双ESC注入未单独执行；真实后端中断、保存重读、新SyncProvider重建、未确认估算和确认交接均已执行。提交只隔离本任务已批准HUNK与本plan，其他任务的工作区及暂存内容保留，不amend、不跳hook、不push。

## 27. R8 Single Review and Final Legacy Fix

用户追加的一次简洁复核已由原session `ses_e50b86ea3ffeMQru9jXam7Lx4V` 完成，覆盖6个生产路径和8个测试路径。原B-04在当前源码中闭合，B-03保持撤回；唯一保留项为本轮R8-B-05“旧分支保存的中断消息在真实 Session 投影入口仍会归零”，不同于第22节曾撤回的活动流恢复B-05。

原样Release verdict：

> **BLOCK — R8，基线 `d8865c42935e5fd44cdc3f629e0fdfbd437987be`，快照 `tool_1b20f50eb0012NzFDr9WEIrg7F`。**
>
> B-05 尚未闭合，当前不能标记 `verified` 或提交。本轮未修改文件、索引或 Git 历史。

此后依用户“自己处理、最小修改、不再多审计”及“发起一次审计即可”的指令，直接修复该遗漏，不再调用审计员，不将以上历史BLOCK改写为APPROVE。唯一新增生产改动位于原token-accounting HUNK：把已有旧记录输入估算选择移到两个入口共用的位置；原账本已含的同一旧输入值仅计一次，不新增存储、恢复流程或调用者接口。

原Sync重建用例改用真实旧保存形态：没有inputEstimate，消息tokens.input及StepStart.inputTokens为777，正文8字符，消息已中断完成，Session请求投影为零。修正前真实挂载返回0/0，断言exit1；修正后两次重新挂载、原入口与共享入口均为777/2，footer全输入及新增输入均为777、输出2，同一输入没有重复叠加。原账本兼容读取沿request-usage.ts:123-128，旧无finish记录会读取消息tokens，未为测试虚构零账本。

最终六个既有回归文件90 pass、701 expect，8.49s；TUI typecheck及本次diff --check通过。其他第26节已执行验证和真实样本证据保留，不声称最后这个入口补丁再次独立审计或重新运行完整大样本profile。

最终差异快照：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b228eece001JfY3X8FuXp4Q72`，SHA256 `e3a4fc3f07955cf16a88860e262afbc777d3b53ab359e62ff48410e942ed813b`。仍为6个生产文件、8个既有测试文件；生产新增440、删除381，共821行。保守E上界462、C=88，最低70，注释比例至少19.05%。当前verified依据为用户指定单次审查后的修正与实际验证，独立Approved revision仍为none，不伪造新的独立放行记录。

## 28. Zero Usage Correction and CI Verification

- 用户纠正零值合同：StepFinish零usage不视为有效确认，保留已有估算并取max；正数确认仍替换估算。沿已有字段、SQL和共享计算入口修正，没有新增传输或持久化状态。
- 更新Core旧零结算断言及TUI零报告断言；退出测试改为检查现有共享统计入口与lazy producer，不再要求已删除的源码字符串。
- Core投影两文件24 pass、348 expect；完整Core运行1254 pass、9 skip、16 fail，其中15项超时用例单独以30000ms重跑后15 pass、1071 expect。
- 剩余Core失败为`Npm.add > resolves an importable file URL under Node`：原`observability/logging.ts:101`在Node中调用`Bun.file`。相关生产和测试文件均与HEAD相同，不属于本次修复，不改动。
- 完整TUI运行703 pass、2 skip、1 fail；唯一失败为旧零值断言。修正后用户指定四文件命令运行15 pass、124 expect。此前已通过文件不重复全跑。
- Core与TUI的`bun typecheck`通过；`git diff --check`通过。保留全套原始失败结果，不把重跑或定向通过表述为完整套件全绿。
- 原问题提交`6d92ad2363`已撤回工作区；按用户授权只重建本任务HUNK并带明确远端lease重写`origin/dev1-smark`，保留并行任务暂存区，不merge、不跳hook，push后由正常CI执行。
