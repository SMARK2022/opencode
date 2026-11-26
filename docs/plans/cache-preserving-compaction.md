# Canonical Implementation Plan：缓存友好的会话压缩与按需历史检索

> Status: verified
>
> Revision: R152
>
> Approved revision: R152
>
> Audit mode: full-scope
>
> Requirement source: §1 原始需求、固定设计、用户对两个工具和格式化的最新答复
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-26

本文件是唯一实施规格。本版保留固定R1前基线至目标的两个工具及前缀友好压缩完整设计，并适配现有HTTP路由练习夹具。此前批准及反馈保留为历史记录。当前HEAD为77b2b2f71fa2b88d067afa0e703d84766d687987，该SHA的Preflight通过，但后续test工作流的HttpApi effect场景失败；当前修正须通过完整方案/实施审计、新SHA Preflight及HttpApi effect验收。累计交付diff继续从55d404f3a1e07f8f1c2015c1df4be949c6975c94计量。

**比较基线。** 原始需求 R1 前的 HEAD 固定为 `e93b66fd8473e94fb414151af0fecbb31a299266`；交付分支经过 rebase 后的发布基线是 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`。完整行为回溯到前者，文件归属、格式化后的实现预算、性能 A/B 用后者，不把期间其他人的修复计入本功能。本文中的“基线”未特指时指后者，“中间态”指用户恢复的 index。原计划完整历史（含引文与历次 verdict）为 Git blob `ac389f8ac06adfa2f85587b5555e9f862d360f6a`；这是历史证据，不要求实施者从旧版拼设计。

## 1. 用户原文与本版效力

以下保留原任务和后续更正的来源。旧引文中的数字与机制不能覆盖本节末尾的现行决定。

> 同一份逻辑功能不得出现两次。

> 只更新因摘要请求形态变化而必须改的夹具（文本摘要 → 工具调用）。

> 出现问题的时候，优先考虑是不是自己的方案实施过重了，或者说改动面过大了。请你注意这点。不要把每一个block都想象成是你的方案有问题，它可能暴露的是你方案根本上，你动了不该动的地方。

关于 GitLab Duo Workflow 的范围（用户在 R122 审计后答复）：

> 用户本身并不使用这套Workflow，因此这套逻辑请你不要碰，最多保持接口兼容性即可。

> 关于这套GitLab Workflow的相关逻辑，你可以适当收敛相关内容，将相应的改动保持最小，避免进行大幅度的调整对应的Workflow逻辑。按理来说，它不是我们的生产分支。

> 你的plan中丢失了相对于Head构建设计的完整具体细节内容。譬如原有内容暂存区中已经包含的一些主路径设计等等各种的各样的一些信息，你都直接完全丢失了，你当前只剩下大幅度的一些改动内容。改动内容和方案审计是完全独立的两部分，方案审计审计的是Plan的内容。你当前Plan你都没有有效的去进行相应的调整啊等等内容。你当前你只是在进行大幅度的改变当前的实施审计的部分，但是你设计部分你都已经完全丢失了。
>
> 我再说一遍，方案审计，你的方案的完整的Plan里面必须包含所有的改动以及改动的设计啊等等各种各样的一些接口约定啊等等内容。任何内容叙述不清晰的都不应当实施。也就是说，任何不在Plan中完整表述的各种各样的一些内容，都必须撤销。
>
> 换言之，如果实施阶段你实施了一个接口，但方案中没有提及或者声明各种各样的一些接口内容，那方案要么是你说你改方案并提交审计，要么是你实施过程中不得写入这种内容。

> Plan中所有不在Plan中的内容都应当得到撤回。
>
> Plan本身也应当是基于Head到现在来写的。

> 请注意一点，我觉得你这个地方没有在说人话。正常的逻辑，我其实有点听不懂你这个地方到底指的是什么。你说什么时间取舍怎么怎么样，我就很好奇一点，难道我们以 A 去发起的这个请求，发起请求之后，它落库的时候落那个 marker 啊什么各种东西，它不是会直接带一个 tail ID 吗？tail ID 本身它不就能直接写成 A 吗，或者说写成 B，或者写成什么吗？那这样的话，它不就能直接去完成这么一件操作吗？就是按照我的理解，这不应该成为问题呀。你 marker 落的位置本身也不影响我们回放的情况啊，因为 marker 它本身只是决定有这么一个东西，但具体是在哪个地方开始回放，是要遵从 tail ID 的，或者那个 start ID 的。

> 不是，这又是干什么呀？什么叫用户要求返回JSON压缩后却能用普通文本结束？这啥意思啊？听不懂啊,那没有用工具就直接重试不就完了吗？什么调用方拿到上一次结果和成功的摘要？这干什么呀？什么两者都复现了？按理来讲就是调用工具，不就完了吗？你干什么呀？这跟成功和失败的误报有什么关系啊？本身就不需要去报告啊，报告什么呀？你非得设计一些用户没有对你说的或者要求的这种语义干什么？连续主动压缩漏掉仍在预算内的原话又怎么了？漏掉又怎么了？又怎么了？我允许漏掉。而且什么叫做插件给工作请求设的温度是0.25，重放变成0.75？是模型复述错了吗？那复述错了现在也有这个问题，这不是你新引入的问题，不需要去修，我再说一遍。所有修改的这些东西，如果你不能清晰地去解释到底是什么意思，你应该直接给我撤回掉这些修改，包括其涉及到的测试项。同时，什么叫排队消息可能漏答？你听不懂。而且什么叫配置为保留0轮？而且这都已经很清晰了，你为什么搞这么复杂呢？什么叫B在宿主取完A的消息，写一下标记之前入库？那你写标记的时候就直接写到A的后面不就完了吗？你干什么呀？非得去搞什么各种时序判断，有什么用吗？哪个消息调起的，你就写在哪个地方不就可以了吗？

> 注意我再说一遍，存储层你不要让不要做任何的这种Schema，或者说这种结构的调整。按理来讲，当前的这种Marker tail ID啊以及Compaction啊等等这种这些已有的这种存储逻辑字段，已经能够满足当前的一些需求。注意我指的是关于这个压缩，还有这个压缩的起始头这一块。按理来讲已经能满足需求，不要大幅度调整相应的Schema，或者说相应的结构等等内容，否则会大幅度影响兼容性。按理来讲，两者的这种compaction逻辑其实本身能够互通的，互相重放的。当然这个不是要求的，我只是说他大概是这种这种思想的，这个不是验收标准。
>
> 但是按理来讲，现在的各种的compact的一些内容，按理来讲都能够被有效的转换成你那套逻辑，你那套逻辑也应该能够被转换成当前Head ead所具有的逻辑。

> 是的，做这些操作可以本身先完整修订Plan，然后把Plan审计一遍。按理来讲，我们当前是在收敛方案，而不要在方案上再过度扩张。然后审计完就去实施等等的各种各样的一些操作，完整进行当前Workflow。你应当有自主的判断性，不得按照或者说完全按照审计员的一些修改方向来走。审计员他不具有方向性，你应该是具有方向性的，你应该结合具体的一些点来分析，到底应该如何去符合用户的这一种偏好。请注意，没有什么是完全安全的、绝对的、正确的。你所做的东西就是满足符合用户的要求的框架内，朝着用户的偏好走，避免把东西越做越复杂，或者越做越偏移用户的需求。与此同时，我再次重复一遍，我们的Plan应该是基于Head到现在的一个完整状态。你不应该说你修订一版，然后修订的内容是从A到B，然后又从，然后改完又改一版，Plan的内容就只剩下B到C了。按理来讲，每一次Plan中都应该包含完整的从Head到现在的一些这个需要的一些变化等等一些内容。而且同时你相应的Test啊等等内容，不应该去结合一些我们中间改错的一些修改去进行断言。就譬如说，你从Head到A引入了一个A的逻辑，但A是错的，然后你改到B的时候又断言不是A，这种逻辑也是错误的，应该被撤销掉，或者被收敛掉。这种本身就是无意义的一些东西，请注意这点。

> 按理来讲，超窗本身就去做tail，就是在那个就直接，这种超窗不是本身直接按照那个主动压缩的语义去进行吗？那主动压缩的语义本身不就是说，如果我们模型达到overflow了，那overflow的话，我们就直接按照status当前的一个candidate去pick一个中间的一个，或者说最保守的一个。就就是那个最靠前，就是那个tail的开始的地方最靠前的那一个tail，然后把这些内容去做一个compaction。

> 我从来没有要求你进行过任何的替换占位，我再说一遍，不得进行这种消息的替换，没有人让你做这种替换，而且你本身你即使替换你也没有办法保证它不超过上限，所以更好的操作应该是直接选择candidate，然后加一句system reminder强制要求模型去对如上的所有内容进行compaction，也就是调用一个compaction的工具，对如上所有内容进行compaction，然后再把对应的那个compaction逻辑去替换到我们之前替换掉我们之前被compact那些消息段就OK了以及按照我的理解，我们的消息段的存储逻辑本身仍然，你可以复用现有这套Schema，就是现有的这套Compaction的这套逻辑体系，本身存储层不需要去做修改，因为它本身就能很好地去兼容现在的这套逻辑。

> 第三条不应该去做任何处理啊。所有针对于第三条的处理，如果没有清晰的理由，应该被直接撤回啊。
>
> 而且针对于第四条所做出的任何限定，都应该被完全撤回掉。

工具与验证要求：

> 首先，我要求的是中文plan，其次我要求的是引入工具去进行相应的逻辑流程。你不要只是让模型去输出相应的结构化输出，这本身是不现实，它也不可能完全遵循的。
>
> 不要依赖code mode tools。
>
> 本身应该是独立工具。且用户已经说过了需要去支持相应的search等等的一套逻辑。
>
> 同时工具数必须保持核心不要过度冗余。
>
> 四个工具不能进行适当的合并吗？就比如说四个工具合并成几个工具。
>
> 可以经过execute、code mode等等。我已经说过了，是不要依赖，不要完全依赖。
>
> 可以有这条路径，我并没有限制它。
>
> Plan中应该包含完整准确的提示词内容。我说过了你要精准地去复刻并适当地做适配。
>
> 同时包含完整的compaction等等的一些选择逻辑等等的一些内容，具体实现细节逻辑内容，包括你所生成的验收标准，验收标准本身你应该去，在你写方案的时候你就应该验证你的plan是可行的。你不应该把验收这个标准的职责去扔到实施过程。
>
> 换言之，你自己写的plan，你自己就要去验证，或者说你在写plan之前，你自己就要去验证你的方案是否work。

R27 模型边界要求：

> V1V2这种让模型选择是不合逻辑的，是没有必要的，同时应该默认session，不要默认Global。
>
> 模型只需要掌握什么时候查、如何定位、何时停止。
>
> proposalInstructions：压缩规则应按当前任务筛选。你的设计使用单一滚动摘要和保留尾部，可以更加集中。
>
> 我建议在命中项中增加简短的 sessionTitle 和 time。这两项只对最终返回的少量命中读取，能帮助模型直接选中正确证据，减少随后的无效 read。
>
> Compaction没有必要限制完全是四零九六字符……你需要适量地复用我们既有的Compaction的提示词以及其逻辑，你不要把它弄得过于激进。
>
> 与此同时，如果能在公共层上或者说能在上游修改，避免把它变得很复杂很臃肿。

R78 统一压缩路径（逐字要求）：

> 我们所有的 compaction 逻辑都会变成以及切换到你所构建的那么一套这种使用工具进行 compaction 的逻辑，而不会再去使用我们相应的这种没有前缀命中的这种逻辑。
>
> 那种因为 overflow 或者等等一些逻辑去超过我们这个目标进行 compaction 的逻辑呢，将会改成这样……把尾部的一部分……变成 candidate 的某一个 candidate，然后直接去让这个附加提示词，让这个模型开始进行压缩。
>
> 当然你如果觉得当前的2400行不够的话，我也可以把这个相应的一个内容量提升到3200行的一个修改的上限。但请你注意，相应的这个修改量尽可能少。当然你的旧逻辑呢，按理来说，你如果需要去移除，你可以尽可能地去清理掉，避免那些什么残余的一些东西去保留。同时呢，那这样的话测试的这个上限呢我也可以给你调整到1200行那个改动。

### 1.1 原始任务与实验约束

以下为暂存版 §1 中未在上文重录的用户引文（Git blob `b2e371631a76936837b7d664ba799164e7eb715d`）；引文中的省略号保留原样。后续替代关系见 §1.5。

> 按照如上逻辑进行完整检查以及分析，检查对照compaction相关逻辑在本地能支持进行search和分段summarize等功能的可行性和实现方案，完整检查以及分析：
>
> 最终需要进行readonly的调研以及按照docs/guides/workflow.md的说明进行内存或者opencode给你的工作区外的的Temp/opencode缓存区的实验，并构建完整的包含关键实施逻辑以及其他完整细节的verified-plan的内容：
>
> 注意整体逻辑不需要特别重譬如接入过多的不必要的工具逻辑内容等等，结合其完整的内容逻辑进行即可
>
> 譬如compact时候能够被缓存命中、相应的context compact/search/xxx的必要的核心几个工具逻辑及其数据库保存模式；
>
> 所有的plan编辑应该由你自己进行，不应该让其他agent来进行，必要的实验编辑也是由你自己进行，如果要调用agent必须显式强调不得在工作区进行任何文件的创建以及编辑，不得在生产代码旁边写入任何临时性文件，plan需要由你自己编辑

### 1.2 历史检索与响应时间

> 我听不懂什么叫翻页搜索，因为模型怎么知道有多少页呢？这本身你对于一个 agent，它应该有清晰的调用模式，或者说有清晰的使用方式。
>
> 按照我的理解，5秒以内的一个反应应该都是比较好的一套，应该都能接受。
>
> 搜索太慢，这种逻辑模型要想搜索很多根本过于低效……按理来说模型应该能具有高效搜搜整个库的能力。
>
> 保持只读扫描
>
> 本身直接读就完了。那读不掉的它就直接 catch 掉就 OK 了，就是直接 try catch 掉就 OK 了。

### 1.3 设计和范围的历次修订

> 1. 折叠压缩控制消息投影：在 MessageV2 转换模型消息时，将已提交压缩之前的 context_compact(status/propose) 投影为单行简短回执，消除保留尾部的“双份摘要”污染。
>
> 2. **统一上游摘要留痕规则**：将 1 行 `RETRIEVAL_NOTE` 直接合入 Core 的 `SUMMARY_TEMPLATE`，让宿主自动压缩也能生成可供 `context_history` 搜索的字面量线索。
>
> 3. **恢复字节预过滤优先顺序**：在 `cold-store.ts` 中先对解压后的 Buffer 做 `Buffer.indexOf` 预过滤，仅对命中的极少数冷包执行 `JSON.parse` 与现有恢复逻辑，砍掉全包前置 `JSON.parse` 与复杂的 `SearchView` 多版本直读状态机。
>
> 4. 移除 handle.prepare / streamPrepared 与 revert.ts 侵入：静态判定同模型重放兼容性，模型自写摘要直接走独立落库或记零成本压缩账行，不改动 SessionProcessor.publishAssistant 和 SessionRevert。
>
> 5. 补齐 maxSummaryTokens 并精简 context_compact 描述：在 status 候选中返回 maxSummaryTokens: remainingInput，候选数从 8 个收束到 3 个；清理 context_compact 描述中的 drain / Provider Turn 术语。
>
> 6. **消除 `context_history` 的调用摩擦**：从搜索输出文本中移除裸 `sessionID/messageID/throughMessageID`（只留 `ref`）；`read` 的 `offset/chars` 自动对齐 UTF-16 码点边界；将单 drain 预算放宽至 `search <= 6, read <= 6`。

同一原始用户消息 `msg_1cab37908001QwryN4bfGw3hOE` / Part `prt_1cab3795d002A2Cq4QqBc6BmSm` 中还明确要求：

> 每条命中只输出 `ref`、`role`、`partType`、`snippet`（以及 `global` 模式下的 `sessionTitle` 和 `time`），**彻底从模型可见输出中移除裸 `sessionID` 和 `messageID`**。

> 当 `offset` 落在 surrogate pair 中间时自动向前退 1 个码元对齐，当 `chars` 不足首个完整码点时自动向后扩充到完整码点（1~2 个码元），直接返回合法切片和对齐后的 `nextOffset`

这些字段和码点行为保留；后续用户取消次数配额及额外拒绝限制的原文见§1.5。

> 若当前阶段仍为仅批准计划，头部应保持 Implementation allowed: no（或拆分为 Plan approved: yes 与 Implementation authorized: no），直到你正式下达编码指令再切换为 yes。
>
> 我没有说不让你去把它支持 code mode。我只是说你不要把 code mode 当成唯一的一个重要的主线，因为我们的最最重要的点就是说这一套逻辑流程。
>
> 我一个 compaction 阶段的一个处理，还有一个工具，这两个东西不就完了吗？
>
> 按理来说，我们 compaction 和用量根本没有任何关系。能有什么关系啊？它两个明明是两个独立的逻辑，一个是显示层的，一个是功能层的，根本两个逻辑就互不相干。
>
> 任何修改都需要思考 block 的原因，是不是逻辑过度冗余、状态机接线过度复杂；有没有更加凝练、更加往上的核心修改方式，能不能在上游提前避免，不要一而再再而三地打补丁。
>
> 请停止你之前那种各种各样去加接线……Token 估计，没有人告诉你一定要完全保持准确……我们在本地就已经有了工作流了……ratio 什么都给你了，你不要再去自己造轮子。
>
> 新增 3700 行允许吗？这是不允许的……最多净增的代码行数……不得超过 2400 行。

> 换言之整体内容已经很好了，现在需要看下调整调整这些给模型的显示：
>
> 譬如压缩工具的调用那块，因为我们本身有85%提醒，所以可能对于这部分按理来说能够作为那个提醒内容，也就是简易模型在遇到Harness的压缩提醒的时候或者当前70%以上的内容可能都和未来几轮用户要处理的任务无关的时候再进行调用
>
> 包括相应的status的展示那块也是，避免给模型展示这种口径，可以最多附加上说aim xxxxx
>
> 同时search那块对着Gemini的想法看看可以适当进行调整
>
> 同时现在还是在approved-plan-only状态
>
> 按理来说那些本身HEAD不存在的问题的test本身是无意义的

> Context，compact以及history两个工具都必须保留。我只是说工具保留，工具的几个调用方式也应当保留。你不应该说因为这个东西就把它移除掉。我再说一遍。这个东西用户都已经说了要保留了，你这帮就你他妈就不要再瞎放屁说这个东西有问题。然后又说什么和我们的重叠，用户要的就是这个。你他妈有病不要有病。你想清楚用户到底要的是什么东西。

### 1.5 本轮逐字更正与优先顺序

> 你当前完整的、全面的为我检查工作区的所有改动，将每一个HUNK对应到用户需求原文，对应不上的全部移除。注意我说的工作区改动指的是你进行的改动，其他 agent 进行的改动不算。

> 包括把每一个断言，你新增的断言，或者改动的断言，都对应到用户需求的原文。注意你要对应原文，也就是直接给我写出原话的捡选片段。按照一个hunk，一个修改的意图，一个对应用户的原文，这样来写。

逐项清单已交付于 `cache-preserving-compaction-hunk-review.md`，包含冻结时18个本任务文件、143个hunk及断言原文。该清单是变更前证据，不是第二份实施方案。后续按用户最初要求撤回无对应项；其他agent的TUI、smoke及文档不动。

> 用户没有说任何的这个限制，你都一行都不要加。我再说一遍，用户没有说的任何限制，或者判定，或者这种切片，你一行都不要加。包括你的审计，你也要给审计员这样说，用户没有做的任何一行这种限定的要求，你一行都不能添加，添加任何一行都是多余的，都是被严格禁止的。甚至这种 if else 逻辑都应该是不能添加。

最终实施审计使用这段原文。用户已直接要求取消候选的位置限制，首条真实用户消息也可入选。

> 听不懂什么意思，按理来讲很容易解决。这个非常简单，一共就两个东西，一个是工具，一个是工具后面会请求。工具层面没有什么叫做显示禁用 compact的。如果禁用了，那就禁用不就完了吗？那这个工具它就不再接收模型调用的这个东西，不就完了吗？你非得去区分什么东西啊？不用区分，不得区分，除非你告诉我清晰的理由。

来源：用户在“V1 摘要回包”的 question 中答复。普通工作请求不暴露未选中的工具。用户随后明确了手动命令的语义：

> 没有这个工具的模型，它自己按理来说是不会给它暴露这个工具的，它也不会去使用。但用户去触发手动Completion的时候，用户肯定会在请求的时候，那你肯定会把现在的工具暴露给这个模型啊。即便是前缀不命中也没有问题啊，这本身是强制性的东西啊，你要做什么各种各样的一些花哨活呢？

> 不要在这个地方一直给我跑测试，看diff差别，跑测试看diff差别。我已经说过很清楚了，修改方案，然后审计，然后实施，然后审计，按照Workflow流程走，不要在地方一直去做无用功。手动压缩，没有人告诉你应该返回文本，都是应该返回工具调用，你他妈不要在这地方给我瞎改。

> 我再说一遍，不要给我产生这种不一样的分支逻辑，没有人规定过。而且手动压缩和Overflow的压缩，它的调用模式都一样，只不过可能Tail的选取有区别。手动压缩，按理来讲是直接在当前附加一条消息进行请求。同时请注意一点，无论是Overflow还是手动压缩，它附加的消息都是一句话，再加上完整的Candidate，也就是模型请求Status返回的那个东西。也就是说相当于是T模型请求一次Status的返回的结果也附加上。

这两条最新指示取代以前关于手动返回文本、只传一个候选和分开构造摘要提示的约定。手动与 Overflow 共用一次请求组装、同一个 `propose` 回包和原有写入入口。历史检索的范围、文件和行数上限沿用已确认要求。

> 文档本身不参与总体长度的计算。
> 我再说一遍，我本身没有给你200行的上限，请注意这点。我说了实现的长度不超过1200行，也就是实现的修改的生产代码总 diff量不超过1200行。
> 同时我所说的要求是，生产文件修改数不超过10个，测试文件修改数不超过6个。

> 同时请注意一点，按理来说除了部分长字符串或者字符串之外的内容，其他的每行代码的长度和代码本你的增量的，或者你修改的改动部分的代码，都应当得到格式化。你不应该尝试以压缩多行为一行的逻辑去存放代码。

> 恢复和移除都不用问我，新增需要问我。

> 如果用户原文明没有明确说你需要去考虑某些特殊情况，或者说你需要去加任何限定，那你本身你不应该去增加这种相应的限定。

> 谁让你去管权限的问题了？我再问一遍，谁让你去操作权限系统了？我已经说过很多遍了，你要记在原文里，权限系统禁止修改，不得对工具的权限进行任何的调整。除了我们新引入的两个工具，但不得修改既有接线方式逻辑流程，不得修改除了两个工具以外的其他任何部分的工具权限的系统逻辑。同时我听不懂你非赞同区新增的什么什么什么生成不了这份摘录。很清晰了，我已经说的很清晰了。模型给一个Tailstar ID，给一个完整的Compaction的内容。那我们把对应的Tailstar ID去检查一下存不存在不就OK了吗？存在的话就直接写入不就OK了吗？不要搞这么麻烦，我再说一遍。工作区把发起查询的会话绑定到REF，谁让你写这种东西了？有人让你去管这种东西了吗？为什么要绑？绑什么东西？没有人让你绑吧？普通文本回复以stop结束的时候，你有毛病吗？为什么需要这个目标？为什么需要去普通文本以stop结束的时候，还需要再去寻找压缩，还或者说取出本部的所有parts。所有这些用户没有要求的东西都不要去加，我已经说过很多遍了。按照我的理解，未暂存区的你新增的这所有行为基本上我都没有说过。我也都没有需要加过；全部给我把这些东西，把你提到这几点全部给我撤回。从来没有人让你去做这些修改。然后你再去进行方案的检查、修改，完整按照Workflow进行，最多给你6次审计，我再说一遍，你不要在这地方给我改改改改改改，用户没有要求的事情，你一点都不能动。即使它是Block，Block的事情你应该先分析分析用户有没有要求，没有要求，这个Block就是有问题的。相应的，每一个设计都必须对应到用户的原文。如果对应不到，就比如说你上面说的，没有compaction的时候再维护一个压缩服务。用户没有提到说让你维护一个压缩服务，用户也没有提到关于工作轮没有content compact的时候。所以这些东西都不要去做，任何这种无关性的操作都不要去做，而且既有的这种没让你去做的东西也不要去做，我再说一遍，就是那些东西都撤回掉。

> 你当前工作区所有的逐项改动，按理来讲，如果你对应不到用户的需求，都应该被撤回，我再说一遍。

> 注意一点用户没有要求的不要做过多要求
>
> 用户没有说的都当做用户不care用户不需要
>
> 请注意这点
>
> 不要自己实现一些你所设想的必须的
>
> 把用户要求的当成必要的
>
> 其他的都当做不必要的来进行实现
>
> 不要对用户没要求的两个组件之间做交互

> 同时请注意一点，你所新增的逻辑的行数的平均值不得超出原行数的平均值的1.2倍。
>
> 不要只是试图去改写法。而不改逻辑接线复杂度，我再说一遍。

用户对 V1 切点参数和摘要提示的最新答复：

> 你可以看一下，如果能复用就复用，不能复用你可以去保留。然后同时我不知道你前面那个什么，不要去编造那一块，我认为你不需要去增加那一种逻辑，那种逻辑会增加模型的心智负担，请你注意这点。

> 而且，而且你更是逆天，提案与选定切点不符。这不完全是有病吗？什么叫提案与选定切点不符？你怎么去判定呢？它给了一个 summary，给了一个 tail ID，你怎么判定这个 tail ID 和 summary 一不一致呢？你是完全有病吗？这本来是模型去决定的东西，你非要去加个门禁，你是有病吗？

第六轮后，用户对“原审计 Task 再做两次只读审计：一次审 R146 方案，一次审最终实现”的答复：

> 仅追加这两次

> 你授权通，你按workflow走啊，审计通过不就能落盘了吗？

模型提交 `(C, S)` 时，C 是第一条保留消息，S 是模型写的摘要。只核对 C 在当前活动窗口中存在、S 非空。上传范围和候选只是模型输入，不裁决模型的选择，也不按文字内容推断边界。此前允许传宿主切点的答复不再作为比较两个 ID 的依据。

> 在本地修改时，极力避免使用Junction等等逻辑，请注意这点。避免大幅度复制工作区和构建Junction。

> 请注意一点，不要在本地进行Benchmark等等各种各样的测试。这些内容你应当留到线上CI去测试。最终Commit之后，你可以进行一次Push。Push它本身会触发预Push，也就是预发布。预发布本身会发布Preflight，并可以去，你可以对应的CI里面去检查到多端的一个情况。你避免在本地进行大规模的这种重型测试、重型Benchmark、重型Gate。请注意这些内容。当然必要的Gate是可以去跑的。然后同时请注意一点，你最终的验收标准是线上的preflight通过，然后你可以不再你可以不直接进行这个最终的push，但是你中间你是肯定要push一次去看preflight的。

本轮执行约束：直接在现有工作区修改，不创建 Junction，不为测试复制仓库或创建额外 worktree。本地只做必要的定点检查；重型 Gate、跨平台测试和正式 Benchmark 由线上 CI 执行。此约束更新验证地点和发布顺序，R143 的产品设计与预算不变。

需求以本节原文及后续明确更正为准。例如，§1.2 中的“五秒以内”指首次有用响应，不要求五秒内搜完整库；§1.3 要求搜索返回 ref、read 能定位原文，§1.5 保留续搜、取消次数配额。默认只查本会话、显式 global 才跨会话是范围要求。R137 选择按工具实例签发引用，是实现选择，不是用户要求引用只能在同一实例内使用。实现选择、审计建议和测试夹具都不能自行增加用户的验收条件。

来源：用户在恢复中间态后的两条消息，以及本会话的 question 答复。“两个工具都交付”；“保留续搜，去掉配额 (Recommended)”；候选“保持现在的这个消息ID和开头摘录”；status “按调用运行原选界”；无真实用户尾首时“沿用 HEAD 压缩”。“当前用户不在这里了，下面由你自己决定。保持增加克制。”此授权足以作方案取舍，不用等待用户选择算法；不能据此更改生产 Schema 或扩表。

| 编号 | 现行要求；有冲突时采用右列 |
| --- | --- |
| R1 工具与文案 | 两个独立工具、四个操作。V1 工具注册和 Code Mode 共用定义；原生 Core 工作轮提供压缩，历史工具可读取两代历史。保留恢复版对模型有用的操作指引、六节摘要模板，修正已取消的字段。 |
| R2 主动提交 | status 返回至多三个候选切点及摘录。对模型给出的完整摘要，只检查 tailStartID 在当前窗口存在，再用本步最后一个已完成的提案写既有 checkpoint。 |
| R3 宿主单轮 | 手动用当前活动窗；Overflow 按原选界缩短输入。首次即追加一句立即 propose 指令、换行和完整 status，可再附用户已批准的插件文字。按模型有效 C 写入；窗口外 ID 用原默认切点；未提交最多重发 8 次。完整替代关系见 §1.6。 |
| R4 工具可见性 | 普通工作轮沿用原工具表。用户手动压缩时，请求提供 `context_compact` 定义。两个工具按原操作名走已有权限接线，沿用原筛选，不覆盖任何权限规则。 |
| R5 历史 | 默认 session、显式 global；search 给可定位线索，read 给原文切片。保留模型不传 cursor 的续搜和冷包只读优化；取消 6 搜/6 读、32K 及退款。 |
| R6 范围与成本 | 普通请求、加载和生成参数沿原路径；不增审批、专属 Max Token、持久字段、传输层拼接。§19 的三个上限替代旧数值；先格式化再计数。 |

R3 的顺序依据是后续固定设计第 4 条：“边界：默认用 HEAD 选界结果（即 status 的\"推荐\"项）。仅当它按 HEAD 已有粗估发不出时，才在同一组候选中从早到晚取第一个 head 能发出、tail 放得下的；都不满足则走 HEAD 原超窗报错。压缩后下一请求仍超窗，由 HEAD 原路径再压一次。”

### 1.6 R148 变更单及后续答复

本节是用户在完整 patch 核对后给出的更新，优先于历史引文和旧审计中的一次重试、宿主无效 ID 直接报错、插件改写 description、无缓存预筛等实现选择。基线、两个工具、四个操作、10 个生产文件、6 个测试文件、生产增删 1,200 行与逐文件均长 1.2 倍约束继续生效。

用户变更单原句：

> R148 只做以下变更，其余一律不动：
> 1. 删除宿主维护请求上的 tool_choice：core compaction.ts 的 "context_compact"，opencode compaction.ts 的 "required"。
> 2. 维护流中，以下情况统一视为“未提交”，走已有的一次重试，不再各自报错：调了非 context_compact 的工具、
> operation 不是 propose、summary 为空、ID 不在当前窗口。Core 改 stream 处理，V1 改 checkpointEvents。
> 3. V1：experimental.session.compacting 的 prompt/context 追加到最后一条消息末尾，不改工具 description（待用户确认）。
> 4. V1：发第二次维护请求前，清空摘要助手的 finish 并 publish。
> 5. V1：parent 携带工作请求的 user，宿主 StreamInput 使用它。
> 6. Core history：一次 searchArchive 内按 cold_ref 缓存 matchColdBytes 的结果。
> 7. Core runner：主动提交前复用 stepSettlement / hasProviderError 判断工作步成功。
> 8. 撤回反馈第三节列出的纯格式化和等价改写；撤回 V1 的 current 和第二次 select。
> 9. （可选）Core 切点统一按 request.messages 的 id 定位，删除 Input.blocks。
> 10. 测试：
>     - 撤回纯格式化；
>     - 插件用例改为断言文字在最后一条消息里；
>     - 重试用例补一条“重试中取消，旧窗口仍在”；
>     - 宿主请求断言 toolChoice 与父请求一致。

> 前缀友好不变量（自动 / overflow，且父请求已开放 context_compact）：
> - model、system 文本、工具定义（名称/描述/Schema/顺序）、tool_choice 与父请求完全一致；
> - messages = 父请求 messages 的前缀 + 1 条 user 消息；
> - 不改缓存断点，不改传输层。手动、decide、末步不承诺命中。

> 不得再动：反馈第五节所列部分；文件清单（10 个生产文件 + 6 个测试文件）；
> 存储、事件、HTTP、插件 hook 的 Schema；权限接线。

用户在“两项设计确认”的 question 中答复：

> 两项都采用（推荐）

对应问题是将插件 compacting 文字追加到末条消息 status 之后，并将原有滚动合并规则拼入 CONTEXT_COMPACT_DESCRIPTION。合并复用 SUMMARY_UPDATE_INSTRUCTIONS 中的 When combining 规则，保留 buildPrompt 及其原测试，不新增第七个测试文件。

用户在“空摘要边界修正”的 question 中明确替换第 4 项：

> 选 **1（采用源头修正）**。
> 判断“有没有收到正文”用的是处理器里本来就有的 `hasText` 标志，不加新状态，也不限定结束原因。
> 普通工作轮不受影响。
> 改的位置是 `processor.ts:926` 那一行，只动这一个条件，`compaction.ts` 里不需要再加清理代码。

该答复同时更新维护指令和重试：

> 同时按理来说compaction的话或者说强制compaction的时候都要附加这个，这个不是第二次才开始附加，而是直接附加；同时第二次第三次等等都进行这样的重试，除了网络或者供应商这种本来就会被捕获的provider或者sse问题之外，其他逻辑统一允许8次重试

> - 不设置任何 tool_choice；宿主维护请求的 tools 和 tool_choice 与父请求完全一致。
> - 末尾指令改为：立即且只调用 context_compact(propose)，不回文字、不调 status、不调其他工具
>   （一句话，下一行附完整 status 结果）。CONTEXT_COMPACT_DESCRIPTION 里 host checkpoint 那句改成同样的意思。
> - tailStartID 不在窗口里：改用宿主默认切点，不报错。
> - 重试后仍无摘要：自动压缩返回“未压缩”，不报错；手动压缩和超窗走 HEAD 原失败出口。
> - 不把普通文字当摘要。

同一答复附带的旧补充仍写“一次”，本版按用户本次直接强调的“8次重试”执行：首次请求加最多8次相同请求重发，共最多9次逻辑尝试；网络、Provider、SSE已有重试归原owner。按既有工具Schema及非空摘要接收宿主propose，tailStartID仍为可选；未给ID或给出的ID不在窗口，都使用原默认切点。operation/摘要缺失或非法、未形成完整提案的截断输出属于未提交。主动工具的当前窗口ID校验保持原样，不为宿主增加必填ID门槛，也不改写原省略ID的成功夹具。

用户另在“追加审计额度”的 question 中答复：

> 追加两次审计 (Recommended)

本次新增额度中的方案审计已调用，R148收到BLOCK，Task `ses_dea04ff22ffeZAQ2pXP4l6DhZ8`；原文见§22。本批实施审计已在§24调用，R149收到B-23/B-24。用户在返工后允许再追加6次完整审计，原文见下；仅按需要使用。其余agent的文档和guard.ts不进入提交；冻结hunk-review仅供用户核对，也不提交。

用户随后在“方案修订复审”问题中答复：

> 允许一次方案复审（推荐）

对应授权为修正B-21/B-22后复用当前任务作一次完整方案复审，保留尚未使用的最终实施审计。该授权发生在R149清空批准、尚未实施时，随后完整方案批准记录见§22。

方案批准后，用户对原文件内私有函数收口的答复：

> 允许原文件内收口（推荐）

仅整理本次压缩参数交付、提交与完成判定，保持条件和普通工作轮行为；不放宽机械规则、不增加文件。用户随后更新生产预算：

> 上线给你调整到1400行，必要的内容可以进行，但不要为了放宽而放宽。大部分与用户需要无关的部分仍然保持最小实现请注意着点

现行生产增删上限为1,400；均长比值和行为边界继续按批准方案，文件范围以§1.7最新答复为准。实际累计数见§23，不因修正提交重新起算预算。

R149实施返工后，用户对“追加一次完整实施复审，允许必要的定点验证，重型测试仍留线上”的答复原文：

> 说过了追加6次都可以

该答复追加6次完整审计授权，已使用6次；用户随后追加本批1次完整实施审计，原文见§1.9。既有提交、正常push和同SHA线上Preflight授权继续有效。

### 1.7 线上反馈后的明确边界

用户对“同步一份既有HTTP录制JSON中的工具声明和工具说明，使测试相关改动从6个文件变为7个”的答复：

> 允许增加1份夹具 (Recommended)

用户随后补充：

> 只允许在现有基础上改动，不允许新增测试和测试文件，可以改基线

本轮沿用既有失败用例与断言，只补已有parent夹具的必要输入，并更新已存在的`packages/core/test/fixtures/recordings/session-runner/openai-chat-streams-text.json`请求基线。累计为6份原测试/基准代码文件，加1份已有录制JSON；不增加测试用例、测试文件、重试或超时额度。录制响应、严格匹配器、成功断言和门禁规则保持原样。

修正提交被权限预检认定为需单独授权后，用户对“授权这次及本任务后续必要的修正提交、正常push，直到对应SHA的线上Preflight通过”的答复原文：

> 授权本任务提交与推送 (Recommended)

授权持续覆盖本任务后续必要修正提交及正常推送，限本任务路径，运行原hooks，并保持1,400行上限和禁止新增测试的要求。

### 1.8 HTTP 路由练习反馈

用户提供的失败原文摘录：

```text
FAIL POST   /session/{sessionID}/summarize                   session.summarize
  Error: summarize should create a summary assistant message
      at check (/home/runner/work/opencode/opencode/packages/opencode/test/server/httpapi-exercise/assertions.ts:47:25)
      at <anonymous> (/home/runner/work/opencode/opencode/packages/opencode/test/server/httpapi-exercise/index.ts:1662:11)
```

本轮只调整已有`test/server/httpapi-exercise/index.ts`中该场景的模型回包及同文件构建位置，保持原摘要内容、后续文本回包和成功断言；不新增测试或测试文件，不改生产逻辑、HTTP合同或CI配置。该文件已经存在，累计测试相关范围为原7份代码及1份录制JSON。

### 1.9 既有测试修正与时限

用户明确要求：

> packages/core/package.json 的测试脚本改成 bun test --timeout 30000 --only-failures，和 opencode、tui、常规 CI 保持一致。改 1 行，affected.ts:70 的格式检查也允许这种写法。

> effect-flock 的 3 秒等待改长一些，比如 15 秒。这是测试代码。

用户进一步明确文件限制的适用范围：

> 这本身是测试修正，不包含在文件要求内

既有测试修正不受原文件数量限制；仍禁止新增测试和测试文件。本轮把HTTP夹具修正、core既有test脚本及effect-flock现有等待纳入同一批修正，生产范围和1,400行上限保持。源码核对发现crashed-owner用例显式传5_000覆盖3_000默认值，故改实际生效的调用为waitForFile(ready, 15_000)，不调整无效默认值或生产锁时限。该用例已有30秒整体上限。

本批修正及定点验证完成后，用户对最后实施复审的答复原文：

> 追加1次实施审计 (Recommended)

该授权已用于本批完整实际diff的实施审计，结果APPROVE；随后沿既有授权正常提交和线上验收。

## 2. 明确不做的事

不改存储表、索引、迁移、V1 Info/Part、Core SessionMessage/Event、插件 hook、HTTP/SDK、通用工具上下文和 LLM 协议。GitLab Duo Workflow 保持既有接口；不承诺每个供应商逐字节命中或费用下降。

不预取历史、不在普通发模型前创建压缩控制器；不重新组装手动请求的技能、MCP、工具权限或工作环境。不为撤回、队列、同毫秒和压力提醒引入新调度规则。普通Session读取及公共工具的权限保持原样。历史工具按session/global读取原始记录。保留原来的85%提醒，不改触发水位。

## 3. 仓库约束与术语

| 来源 | 本方案遵守的约束 |
| --- | --- |
| `CONTEXT.md`：Session History、Context Epoch、Safe Provider-Turn Boundary | 当前可发窗口与原始历史不同。输入已入队不代表已提升；稳定 system、活动窗和 epoch 均由已有 owner 管理。完成 checkpoint 才影响下一窗。 |
| 根 `AGENTS.md`、V1 包及 test 的 AGENTS | 包内跑测试和 typecheck；基于真实 Session/LLM 仓储夹具，不为测试扩大接口。普通请求工具结算和取消归原 runner。 |
| Core 工具、schema 包、V1 session/llm 的 AGENTS | 工具定义与执行各有既有入口；Schema 是协议/存储合同。压缩由 Session 编排，lowering、网络与适配器不解释尾首。 |
| `docs/adr/README.md` | 已接受 ADR 0001 关于分诊标签，本任务不更改 ADR。 |
| workflow.md、first-principles-engineering.md、canonical-plan.md | 固定基线，覆盖整个需求；主助手写计划，独立审计员只读；实质修改后旧版放行失效。 |
| 根 package.json、.editorconfig、.prettierignore | 已安装 Prettier 3.6.2。TypeScript 有效设置为 printWidth 120、无分号、两空格、LF；120 是排版目标，不是截断字符串的指令。 |

术语：选中消息 B 指**从 B 起保留**；head 是 B 之前的完整来源消息，tail 包含 B。模型给出的 S 是 head 的滚动摘要。B 的 ID、数据库 seq、转换后协议数组下标不能互换。Core 的 recent 是序列化交接文本，V1 的 tail_start_id 才是持久引用。

## 4. 文件与证据

| 证据 | 类别 | 用于决定什么 |
| --- | --- | --- |
| 固定基线与发布基线的 git grep/diff；当前 index 的 numstat、原计划 blob | observed | 两个基线对照路径内，runner/llm 和 V1 prompt 各有 rebase 的独立差异，必须保留。恢复的树不是全绿候选。 |
| V1 的 session/compaction.ts（基线 select、splitTurn、process、run）、prompt.ts（requestMsgs、blocks、handle.process）、processor.ts（tool 与 step 收尾）、message-v2.ts（parts、投影、filterCompacted） | reachable | 从工作步、已完成工具回执或超窗到 marker/summary/tail、再到下一窗。 |
| V1 tool/context.ts、tool/tool.ts:39、148、213、tool/registry.ts、session/tools.ts:136、270、646 | reachable | ctx 已有会话、助手和消息，child 调用也有自己的完成 Part；由注册表提供同一 leaf，配置决定直接广告。 |
| session/llm/request.ts:58、native-runtime.ts:140、213、session/llm.ts | reachable | adapter 将 system、OAuth、tools 转为供应商载荷；native 即使缺少 execute 也可能产生错误 tool-result。读取模型调用和执行 leaf 是两回事。 |
| Core session/compaction.ts、runner/llm.ts、runner/to-llm-message.ts:208、runner/publish-llm-event.ts、store.ts、history.ts:105 | reachable | 原 select 返回 head/recent；普通投影已按 entry 缓存；步结束能定位助手，已有活动窗缓存只读变化后缀。 |
| schema/src/session-event.ts:447、core/session/message-updater.ts:457、projector.ts、compaction-boundary.ts:18 | contracted | V1 以有效 marker/summary 对恢复；Core Started/Delta 不写完成记录，Ended 追加 text/recent，Failed 不裁历史。 |
| Core session/history.ts、session/sql.ts、storage/cold-store.ts:1181、1613，cold-storage.ts:643；旧候选 de76e36408 的 searchArchive/readArchive、matchColdBytes | reachable | 有只读 inspect 和稳定行标识；旧实现的局部扫描可参考，不搬其整套账本、权限、传输接口。 |
| §16 的包内夹具、script/guard/README.md、旧正式 Preflight 45056316015 | observed | 失败和性能对照范围见 §18；历史数据不冒充本版通过。 |

## 5. 基线行为与恢复的中间态

**V1。** 工作请求把经转换的逐消息块和 epoch 提醒组合为模型消息，handle.process 仍返回 compact/continue/stop。run 为维护生成 marker，process 在原活动窗选界；独立文本摘要请求使用 buildPrompt。成功路径写摘要、尾首、原话、文件/Todo，按原策略续跑；取消由 hideIncomplete 管理未完成对。

**Core。** runTurnAttempt 建立原 LLMRequest；compactIfNeeded 是布尔，供应商 overflow 通过 compactAfterOverflow 恢复。原生成路径发送文本请求、消费 stream，写 Started/Ended 或 Failed。Ended 的 text/recent 在读取时成为 conversation-checkpoint。这里没有“把任意工具结果当成摘要”的已发布接口。

**历史。** 活动窗查询按 compaction/epoch 截断，适合普通请求；检索要找被摘要覆盖的原始记录，不能把 loadForRunner 当作全历史。inspect 读取冷记录且不 thaw。发布基线没有面向模型的 search/read。

**中间态实测。** 发布基线与 index 之间：6 个生产文件，594 新增、429 删除，合计 1,023；2 个测试文件，200 新增、64 删除；计划 2,782 行单列。context.ts 恢复成 153 行，包含两个 Tool.define。注册表只注册了 compact。Core 的 controls 只有 get、没有正常 turn 的 set；V1 的旧 snapshot/finalize 与现行 prompt 未配套。单独恢复声明不构成功能。

## 6. 支持域和可达性

| 输入 / 生产者 | 上游已保证 | 执行路径与 owner | 分类 |
| --- | --- | --- | --- |
| 普通工作上下文调用 status / propose | 框架已解码工具参数；用户轮由活动窗口判断 | V1 ctx.messages；Core 按工具调用身份取本会话当前窗 | contracted |
| 直调或 Code Mode 子调用结束 | SessionTools.runChild 保留实际 child 和 parent；不是解析父脚本文本 | 本步助手的已完成工具 Part → Session 压缩收尾 | reachable |
| 父工作请求已开放 compact | 原flags/agent/工具选择确定父请求；父实际model由调用点传递 | 自动/Overflow → 复用父model与前缀 → 工具摘要 | contracted |
| 用户手动压缩 | 显式命令向宿主发起新的压缩请求 | 在当前消息后追加一条，提供 compact 声明并经原工具筛选；原权限允许时可接收 propose | contracted |
| 查询超时、条数已满、EOF | 真实历史记录与工具调用期限 | history 工具交付已扫进度并续扫，ref 只定位读回 | contracted |
| 供应商没调工具、取消或拒绝 | 一次工具定义广告不保证模型调用 | 协商错误归 Session；存储错误不作空搜索 | reachable |

## 7. 行为不变量

| ID | 可以观察到的结果 | 依据 / 现有参照 |
| --- | --- | --- |
| I1 | status 的每项只有 tailStartID/excerpt；propose 成功不要求先 status，不写库。 | R2；原 select 及工具 decoder |
| I2 | 成功工作步最后一条已完成 propose 提供 S/B；不再计算摘要或再发模型。 | R2；V1 child Part、Core Step.Ended |
| I3 | 手动保留当前消息顺序，Overflow用原选界；末条均为同一句指令和完整status，有插件文字时追加其后。候选正文取维护请求已经处理的可见消息，同时保持原压缩窗口范围；同一输入共用候选生产者。 | R3、§1.6；原插件可见投影、真实请求及既有pending estimate用例 |
| I4 | 压缩请求提供 compact 声明并沿原规则筛选；首次及重发均附相同的立即 propose 指令；未提交最多原样重试 8 次。摘要无有效正文时不发布完成边界；网络、Provider、SSE 仍归原错误链。 | R3/R4、§1.6；检查实际请求、成功边界与取消后的旧窗口 |
| I5 | 接受 `(C,S)` 后，下一窗含 S 和从 C 开始的尾部，即使上传在 B 前截止。原始消息仍可读取/撤回，本轮费用不重复累计。 | 用户对最终切点的更正；两代持久投影、Undo 和现有账本 |
| I6 | 两个工具可独立使用；只有实际历史调用才扫描。search/read 对相同可见正文一致，session 与 global 范围准确。 | R1/R5；V1/V2 存储 |
| I7 | 延续查询前进，冷/热区别不改变匹配和 read 内容；未扫完或读错不能报完整阴性。 | R5；恢复版 historyDescription |
| I8 | 请求生成、工具框架、权限和传输层保持基线责任；格式化后符合 §19。 | R6、仓库规则、用户明确上限 |
| I9 | 自动/Overflow 且父请求已开放 compact 时，model、system、工具定义及顺序、tool_choice 保持父请求；仅截取 messages 前缀并追加一条消息。 | §1.6 前缀友好不变量；实际 StreamInput/LLMRequest |

## 8. 首个偏离及根因

| 不变量 | 起点 → 传播 → 可见后果 | 修复责任 |
| --- | --- | --- |
| I1/I2 | 基线没有模型提交通道；旧候选为每轮建 Control slot，最后要找 delivered。现行 Tool.Context 不含该字段。 | 工具验证输入；用已经完成的 Part，而非另存一份协商状态。 |
| I3/I4 | Core 手动 runner 当前传空 messages；两代旧生成器重建 transcript 或在最后只写一个宿主边界。V1 旧压缩 agent 还指示只返回文本。 | 由原请求 owner 使用活动窗，同一位置追加指令和完整 status，同一消费者接收 propose。 |
| I3 | V1先用原history生成status，再对克隆消息做插件transform；隐藏正文通过excerpt重新进入末条消息。原准备断言先失败，prepared信号无法发出，表现为超时。父请求前缀已处理，重新读取的数据库history也不是其展示正文。 | 维护builder在可见消息准备后生成status；有父请求时交已有requestMsgs引用，并保留原压缩窗口身份。 |
| I4/I5 | 文本不再是合法摘要，但 V1 在丢掉普通文本后仍把 step-finish 写为成功摘要；CompactionBoundary.latest 据此裁历史。 | 在摘要正文的发布 owner 用已有 hasText 决定是否写成功 finish；普通工作轮不变。禁止先发布空边界再清除。 |
| I2/I5 | Core 保存已完成工具参数后，在未获得 step-finish 或 provider-error 路径仍提交新 checkpoint。 | runner 在现有结算、失败和退出状态上判定提交，不增加工具或调度状态。 |
| I9 | 两代维护请求覆盖父 toolChoice；V1 修改父工具 description，并以 marker user 丢掉 user.system。 | 维护请求 builder 保留父选项与 user，插件文字只加入末条消息。 |
| I6/I7 | 普通活动窗已裁掉待查正文；只把 context.ts 加入树不能获得搜索和读回。当前 typecheck 直接报 searchArchive/readArchive 不存在。 | 只读历史 owner 提供定位和取证；不向正常 Session.load 附加扫描。 |
| I8 | 压短源码隐藏 diff 成本，或用删除工具说明和改测试期望虚减规模。 | 按格式化后 diff、全文件路径和业务断言计量。 |
| I8 | Core注册context_compact后，录制请求仍用无工具说明且无tools字段严格匹配；TransportError进入原重试，测试先超时，泄漏检查继而看到30秒计时器。 | 同步已有HTTP录制请求的工具说明与tools字段，不改matcher、响应、重试或清理逻辑。 |
| I3/I8 | HttpApi summarize场景仍用两次llmText提供普通文本；当前维护入口只交付propose，未提交后隐藏未完成摘要，原summary助手断言失败。 | 现有场景首个回包使用既有TestLLMServer.tool提交同一摘要；生产入口和成功断言不变。 |
| I8 | core包test脚本未指定timeout，gate按脚本原样运行而使用Bun默认5秒；Windows/macOS常规CI额外指定30秒。锁测试ready调用另有显式5秒上限。 | 按§1.9在原测试配置统一30秒，将既有ready等待改15秒。native transport受前例污染仅为未确认解释，不据此改生产逻辑或断言。 |

## 9. 职责、入口与接口

| 职责 | 所在层及输入 | 输出；其他层不承担的责任 |
| --- | --- | --- |
| 告诉模型何时用哪个工具 | V1 注册表取得两个普通 Tool.Def；Core runner 使用已有 Tool.make/register | 只暴露工具说明与参数。SessionTools、Tool.Context、apps、CLI 均不新增特例。 |
| 选切点 | 两代各复用本代原 select 和活动窗。只把原 selector 已算出的尾首保留下来 | 共享取样从真实用户轮取至多三项，不编译每个候选；不设第二个推荐算法。 |
| 提交主动结果 | 使用已有的成功工具结算信息或原工作循环已加载的本步工具 Part；直调和 child 都交给同代压缩入口 | 只在真实 propose 完成时处理。普通文本和无关工具不为此回读助手。 |
| 从真实请求得到维护输入 | V1 prompt 的消息块、system 和工具声明；Core runner 的原 request 与 entry 输出块 | 只在压缩时截取完整块。上层持久 ID 用于定位，不落入 providerOptions；缓存政策不变。 |
| 写入和重放 | V1 原 marker、摘要助手和 Part；Core 原事件与 updater；各自原取消/失败收尾 | 一份 checkpoint；下次从原窗口消费者读取。不由工具直接改数据库或新增事件。 |
| 检索 | 工具解释 scope/超时与呈现；Core 历史读取层按两代已有表定位、render、复核；冷包由原 storage codec 读取 | 用户查历史不影响当前窗；写操作、索引构建、恢复到热库不在此路径。 |

### 9.1 受控边界清单

以下是拟实施的**完整接口方向**，不是已写代码的描述。用户批准了工具自己的字段、沿用现有压缩事件、按需续搜和删除配额。若保留或新增相对 HEAD 的类型/函数签名、模块 import、数据库查询或调用接线，按 §20 的授权门禁处理。未列出的变更不由本版放行。

- V1的run/process和Core私有输入承接一次维护现场。V1 parent保留已有user、实际model、system、工具声明、toolChoice、前缀函数及同源history: SessionV1.WithParts[]。history直接引用prompt已做插件transform和visible处理的requestMsgs，仅在维护时交付，不复制普通轮历史或重新处理父消息。父工具表已有compact时使用parent.model，其余保留原选模。run/process仍返回continue/stop，Core压缩仍返回boolean；不增加权限、执行器或公共协议字段。
- 设计把“摘要从哪里来”和“怎样完成这份记录”分开：在同一代的压缩 owner 内，把已有收尾用于模型提交的 S/B 和宿主得到的 S/B。现有代码没有公开接受 S/B 的接口，不宣称调用现成 run 就能跳过模型；不新增对外 commit 方法。工作步将已完成 propose 的原始入参作为本次原入口可选实参；手动调用不传，不能从整库搜索上一轮提案充当本次入参。
- V1 复用工作请求的 system、已选工具和按 requestMsgs 切好的消息块，只在压缩时取 head。Core 直接用 LLMRequest、保留的投影块/归一化后 request.messages，不在正常路径遍历和复制每个 entry 的输出。主动和宿主来源互斥，不向传输层增加 replay、preparation 或 max token 字段。
- V1维护通过process(request,onTail)收回顶层propose的可选tailStartID；按共同工具Schema和非空摘要交付。压缩owner从本次历史找到C时用C，否则沿用本次原默认尾部；由原marker收尾。回调只属于本次请求，不比较推荐值、不执行leaf。公开Result、普通工作轮process(request)和Part结构不变。
- V1 status 用工具已有 ctx.messages 和 ctx.extra.model；在工具被执行时用当前配置和已解析模型运行**同一原 selector**，不把整个压缩服务和工具注册表互相注入。可将原 selector 和它的估算移到同文件的函数作用域，原维护入口与工具共同使用；所需配置沿已有 Config 服务获取。Core 将同一 keep/select 用于压缩与工具选界；用 sessionID 获取当前投影和所选模型，只在 status 时求推荐。propose 只需当前窗存在的消息 ID 和非空正文，不做选界。
- 检索入口沿用恢复文件的参数名（附录 B）。核心提供 searchArchive（接一批 position/上界）、readArchive（一个 ref），只用既有表的只读连接；扫描进度不是模型参数。冷层只提供一种包阴性快筛，阳性仍走既有 inspect。使用现有模块入口，不增加依赖包或公共 SDK 导出。归属与候选文件列于 §15。

HTTP练习夹具在同一index文件用createScenarios(llm)构建原场景数组，main从原有TestLLMServer.layer取得服务并传入。原Scenario.seed要求无额外服务环境，故用已存在服务值闭包调用tool，不扩展ScenarioContext、DSL或runner，也不另建模型服务。首次回包为context_compact({ operation: "propose", summary })，沿已支持的宿主默认切点；第二份llmText及原断言保留。

场景工厂只改变原数组的声明头和main的两条绑定，数组其余内容保持原排版；按项目Prettier检查新增签名、tool调用和main绑定，不把未修改的旧场景整表重新排版。

## 10. 单一主路径设计

### 10.1 工具选择与候选

普通模型只能主动调用本轮暴露的工具；Code Mode 沿用同一 leaf。用户手动压缩是宿主发起的请求，其工具表中明确包含 compact。宿主从流中读 propose，不分发工作工具。检索作用域见 §10.5。

把 B 看作“从这一条保留”。status 从当前活动窗的首条消息开始收集可见的真实用户输入，包含附件的消息用文本或可见附件名作摘录。沿用本代 selector，按消息顺序列最早、中间和推荐项，最多三个。候选用于展示；propose 的 ID 直接在当前窗口中查找。

返回示例：

~~~json
{"candidates":[{"tailStartID":"msg_B","excerpt":"接下来处理 Windows 路径"}]}
~~~

propose 的两个实参是 tailStartID 和 summary，不由模型选择协议代际。模型提供完整摘要时，只检查本次窗口存在该 ID；与摘录、消息角色、候选集合以及是否调用过 status 无关。参数齐全、摘要非空，返回 accepted。工具本身无 pending、delivered、snapshot 或数据库写入。模型负责写 head 的滚动摘要，不把 B 或其后正文当作已处理事项。

### 10.2 模型已经给出摘要

例如 [用户 A，助手 A，用户 B，助手 B]。模型在助手 B 调用 propose(B,S)，S 已是 A 段的摘要。V1 复用原工作循环已经取得的助手工具 Part；Core 复用 publisher 返回的成功工具回执及其原始参数。只有本次工作的已完成 propose 进入原提交入口。两代都不为寻找提案再查询本步所有 Part。

校验成功的工作调用走正常工具结算；没有 completed propose、工作轮失败/取消或既有结构化终态已交付，就沿原调度出口。读取提案时以本步持久 Part 顺序为准，过滤工具名、operation 与成功终态；execute 子调用读其 child Part，保留父脚本、sibling 和原返回值。既有 call 归属即可，无跨轮记忆、无预算复核、无补发模型请求。

V1 使用原 marker 创建与独占/取消边界，复用 process 中原摘要助手的构造、原正文写入及成功收尾；给定 S 时跳过生成，在基线成功完成的位置将 S 写为摘要正文，tail_start_id=B，同代文件/Todo、recent_user_messages、Compacted 与 autocontinue 只执行一次。保留正常工作助手，不把它改造成摘要。

Core **仅在本步 `Step.Ended` 已发布、工具已结算且确有成功提案之后**，用 `entriesForRunner(db, sessionID, system.baselineSeq, retained.history)` 取得提交时活动窗。提交点复用现有 `stepSettlement`、`finalizer` 与 `publisher.hasProviderError()`：未结算、失败/中断退出或 provider-error 不提交；不新增 finish 字符串白名单或状态。沿用已读前缀，只恢复变化后缀；从 B 起包含本步已结算助手及其 sibling 结果，再交原 serializer。不能把发请求前的 `entries` 直接写入 `recent`。以同一 messageID 的 Started/Ended 写 text=S、recent、原证据和 memento；原工作步已记用量，不重复计费。Undo 走原读取边界。

### 10.3 手动与 Overflow 共用一条请求路径

1. 默认切点由原selector一次取得。V1候选在已有可见消息准备后一次生成：有parent时取parent.history，无parent时取原插件transform之后的MessageV2.visible结果。用本次原history的ID集合取这些可见消息中的对应项，再调用同一statusResult；该集合保留原replay和活动窗范围，不改变propose校验或选界。原replay已取出的用户轮仍走原replay。父前缀直接复用，不重跑插件；手动仍执行原transform。公开status与维护对同一输入共用候选生产者，不再建current、再次select或先发模型status请求。
2. 手动请求沿用当前结构化消息，在最后追加一条消息；不清空 messages，不重新包装成 transcript。Overflow 才因输入限制使用原选界缩短消息前缀，保持完整工具调用和结果块。尾首优先原推荐，原粗估发不出时按既定顺序选可行项。取得候选在截短之前，完整列表不能再按切点裁一遍。
3. **共同组装点**：`messages = [...选定的结构化消息, user(立即 propose 的一句指令 + "\n" + 完整 status + 可选插件文字)]`。首次就使用完整强制措辞，所有逻辑重发使用同一请求。保留父model/system/tools/toolChoice；V1 parent传原user、实际model和toolChoice，复用user.system，父已开放compact时选模直接取parent.model。已有compact声明原样保留；缺失时仍在宿主请求提供定义，手动/decide/末步不承诺缓存命中且保留原配置选模。删除Core命名toolChoice和V1 required覆盖，重试也不强制tool_choice。插件prompt/context附在status后，不改description。原hook Schema、权限和适配层不变。
4. 主动工具仍只接受当前窗中的C与非空S。宿主正常提交C时V1 marker写C、Core从C起写Ended.recent；不比较宿主建议或摘要内容。宿主ID省略或不在窗口时，用原selector本次已算出的默认切点，不重新选界、不报新错；默认无尾部时仍能整窗压缩。operation、摘要或字段类型违反既有Schema才视为未提交，不新增ID必填条件。
5. 从维护流读取顶层 propose，不执行 leaf。没调、调错工具、operation 错、参数缺失/非法、空摘要或截断而未形成完整提案，均记为本次未提交；最多再发 8 次同一请求。网络、Provider、SSE 已有错误/退避保持原处理，不用文本兜底，也不改成统一吞错。自动压缩耗尽返回未压缩；手动/Overflow 走原失败出口，不新造错误分类。
6. 两代沿原格式保存 S。V1 `checkpointEvents` 仅把合法 propose 变成原 text 事件，无效调用丢弃；`onTail` 交付已有默认/模型 ID。原 `step-finish` 的 finish 赋值仅增加 `summary && !hasText` 时保持未完成的条件；用已有 hasText，不添状态，不设置 stop/tool-calls 白名单，不回读 StepFinish Part，也不在下一次请求前清理已发布空边界。Core 保留既有 Provider 错误/取消处理。
7. 宿主与主动最终用同一代的收尾。下一次普通请求按原循环从新窗口组装；仍超窗由原触发处理。不改 latest、filterCompacted、epoch 或队列。仅在 V1 toModelMessages 和 Core serialize 的工具入参投影中，将 context_compact 的 summary 改为短文字占位；不覆盖数据行，不改其他 Part 或改写父 execute 的代码/输出。

耗尽时的现有返回形状保持：Core 自动预检返回false，原runner继续工作请求；Overflow恢复返回false后由原overflow错误链处理，手动仍走原不可用摘要出口。V1自动且非overflow时不设置新APIError，返回stop表示本次未压缩，run既有onExit隐藏未完成marker/summary，原lastAssistant通过findHot排除hidden行；手动/overflow保留既有stop/失败处理。无新增状态值、后台重试、成功checkpoint或普通文本摘要。

### 10.4 从搜索词到命中原文

context_history回答具体事实缺口，例如还原某次错误对应的命令。保留完整使用说明与八个输入字段；默认scope=session，显式global才跨会话。模型不选择存储代际、SQL或游标，read直接使用search返回的ref，不另收sessionID/messageID参数。

- 只在search时扫描现有两代表。按现有时间/ID和来源排序、分批续读；游标越过已扫描行，到时限或结果数时交付。取消把发起调用消息绑定为额外上界的查询。
- search/read 共用正文读取。取消新加的历史工具回声排除、execute父结果字符串替换、内联媒体清洗及专属撤回边界查询；普通Session读取及权限系统保持原样。
- 先查热字段。适合字节预筛的字面量按 ASCII 折叠大小写，在解压字节中匹配；仅对命中的冷包走既有 inspect，按可见正文确认。可能跨转义或字段分隔符的字面量直接按可见正文匹配。损坏、缺包或解码失败计入 readErrors，继续返回其他可读记录的命中。搜索不写回、不解冻，也不改分包或 codec。
- 单次 searchArchive 所建 archivePage 闭包持有一个 Map<cold_ref, boolean>；同一个包在该次调用的预筛结果复用，false 也缓存。Map 不进入 ArchiveScan、不跨查询/续搜调用、不记录读取次数，read 和冷存储 codec 不改。throw 的读取仍走原 readErrors，不缓存为阴性。
- 只有精确正文命中才产出 snippet 与不透明 ref。read 凭 search 返回的 ref 从当前可见正文读回命中位置。session 模式不查全局标题；global 只为返回的命中项取标题与时间。
- 两代记录用同一个只读文本展开器：按固定键顺序保留字段名和原字符串，数组沿原顺序展开。V1读取message数据和Part数据，Core读取session_message数据。保留role和命中所属partType；search与read共用这份正文，不增加消息类型白名单、跨工具回声改写或撤回拒读规则。
- search先交付命中或进度，保留默认4秒及用户传入timeout；取消timeout、query长度和maxResults的额外拒绝上限。read保留UTF-16对齐、offset/chars和默认展示值，取消16000硬上限及跨操作参数互斥拒绝。通用工具输出边界保持原样。

### 10.5 查询进度和引用

同一查询在工具实例中保留已读位置和命中，重复调用接着扫描。取消每次续搜重查和重排旧命中。查询结束移除进度。read只读取引用定位的消息，不修改search状态。

ref只编码消息ID、来源及命中偏移。取消本任务新增的HMAC、随机密钥、正文哈希及变化拒读；旧签名只是中间实现，不属于HEAD协议。read沿现有操作权限解出定位并读取，真实不存在时返回读取错误。

## 11. 主路径以外的行为清单

| 路径 | 分类 | 产生成功？ | 决定面与处置 |
| --- | --- | --- | --- |
| 工作步已给 S/B；宿主用一次流取得 S/B | 主合同的两种来源 | 是 | 校验来源后进入同一收尾；只以前者免去第二次模型调用。 |
| 同一维护请求未提交后最多重发 8 次 | 用户明确更新的逻辑重试 | 只接受有效 propose | 不改 model/tools/toolChoice，不接受普通文本；网络/Provider/SSE 仍归原重试链。 |
| 宿主回包省略ID或ID不在窗口时使用原默认切点 | 既有默认路径与§1.6明确指定的备用切点 | 保存非空工具摘要 | 仅宿主通道；主动工具校验不变。复用原selector结果，无第二份摘要。 |
| 手动／Overflow | 同一维护调用的两种触发 | 只接受有效 propose | 输入消息前缀和尾首可以不同；最后一条消息的格式、工具定义、回包解析与写入相同。 |
| 热行与冷行；V1 与 Core；session 与显式 global | 同一证据合同的输入域 | 是 | 最终匹配与 read 来自同一正文；冷快筛不是第二匹配器。 |
| 失败、取消、读取受损、EOF | 原失败出口或读取进度诊断 | 不产生伪 checkpoint 或伪命中 | 诊断仅 readErrors/进度，估计新增诊断决定面 <10%；实际审计核算。 |
| 切换到纯文本掩盖漏调、捕获存储错误返回有效空结果、传输层重放分支 | 禁止的备用成功路径 | 不允许 | 新增备用成功路径预算为零。 |

## 12. 移除清单与替代依据

| 从旧候选精准移除 | 原来为何出现 | 谁已负责 |
| --- | --- | --- |
| control.pending/delivered、强制 status 先行、全局/逐 drain 控制 Map、attempt 重新占槽 | 把展示回执当成持久提交证明 | 工具完成 Part 已携带本步参数。只保留 history 的续搜状态。 |
| 两代 snapshot/finalize、父用户对象搬运、手动绑定工具/工作环境、重复整理权限 | 试图在所有入口重造现场 | 手动等基线域无需工作现场；宿主不执行 leaf。 |
| compact-preflight、unavailable、独立输出预留、room、发送/提交前重新 prepare | 把选界估算与物理发送上限混用 | 原 trigger、原 selector、原实际错误；基线自己的输出配置继续由原 owner 持有。 |
| forkMessages、来源标记、deep cache 比对、二次转换、临时替换附件 | 把逐字节命中当成功条件 | 持久 B 和已有结构化块足够，真实缓存表现另测。 |
| foldMaintenance、翻译父脚本、修改 latest/prune/HTTP 空会话、发布空摘要后清理 | 为候选新增时序补偿 | 原写入和投影合同；摘要无正文的 finish 在生产者处保持未完成；仅投影工具自己的 summary 字段。 |
| history 每轮次数/32K 退款、全库预加载、公开游标、查询专用 Tool.Context | 检索参数与所有工具共享结算耦合 | search/read 仅掌握自己的响应和进度，保留模型说明、只读查询和精确 ref。 |

## 13. 正向追踪

| 需求 / 不变量 | 生产链与变更 | 独立观测 |
| --- | --- | --- |
| R1/R2、I1/I2 | 注册 → 真实窗口 status → 完成 Part → 同代原提交 | T1：status 有 ID/摘录；主动提案用当前窗存在、未列为候选的助手 ID 验到下一窗为 S+B；覆盖直接与 child，原数据仍在。 |
| R3、I3/I4 | 原触发 → 结构化消息 + 一句指令和完整 status → propose → 原写入 | T2：Overflow 的 head 完整，保留尾部正文不进入 head；候选摘录按 status 原样出现。 |
| R4、I4/I5 | 从当前活动窗手动触发同一路径 → 同一摘要记录与下一窗 | T3：手动请求前缀保留全部当前消息，最后一条与 T2 同形；相同窗口下，附带的候选与公开 status 完全相等。 |
| R5、I6/I7 | search → 两代来源键 → 只读 inspect → ref → read → 切片 | T4：冷/热与两代 fixture 中的已知文字，global/session、续搜、read/撤回和不修改冷状态。 |
| R6、I8 | 不改公共层，实际选择和格式化后的 diff 逐文件核算 | §17–19；两包类型、规则和平台/性能 Preflight。 |
| §1.6、I4/I9 | 父请求保持 → 首次强指令 → 未提交原样重发 → 有效正文完成 | 现有父请求/插件用例检查 toolChoice、user.system、工具声明与末条文字；现有漏调用例覆盖重发及取消，隔离观测确认空边界不发布。 |
| I3/I8、§1.7 | 已处理可见消息 → 原窗口内候选 → 原维护请求；实际新工具请求 → 已有录制基线 | 沿用pending estimate、parent declarations、recorded HTTP三个既有用例，不新增用例或成功断言。 |

## 14. 反向追踪

| 新增概念 | 对应需求 | 为何不能仅用已有调用 |
| --- | --- | --- |
| 两个工具定义、各自已有输入形状 | R1/R5 | 基线没有给模型提交摘要或查询旧证据的动作；通用 Tool.define/make 只是承载。 |
| 至多三候选及真实 ID 校验 | R2 | 原 selector 只返回一个推荐结果；模型需可识别的选择，不需预算协议。 |
| 已完成工具作为摘要来源；现场请求头部作为维护输入 | R2/R3 | 原 compaction 总会生成文本摘要；复用写入而非运行第二个摘要器。 |
| 两代持久化边界原样交接 | R4 | 数据已存在，无资格为此新增 Schema、字段或消息类型。 |
| 键集续搜、同一 renderer、不透明 ref、冷包快筛 | R5 | 当前活动窗已裁旧消息；read 必须取回命中证据而非重建它；完整解码每个阴性冷包有历史测量。 |
| 单次 searchArchive 的 cold_ref→boolean Map | §1.6 第6项 | archivePage 的 project 当前每条记录都调用 matchColdBytes，后者每次解压同包；单次调用内复用预筛结果，避免同包重复解压。不跨查询、不保存计数、不持久化。 |
| 摘要无正文不写 finish；工作步失败不提交提案 | §1.6 明确修正、I2/I4 | 现有 hasText、stepSettlement、finalizer、hasProviderError 已表达所需事实；只在原发布/提交点使用，不增加状态或下游修补。 |
| parent.history引用及原窗口ID对齐 | I3、原插件可见投影和replay范围 | 父messages函数已丢来源对象，数据库history不含临时插件结果。交已有requestMsgs引用，按原窗口取对应展示消息，不重跑插件或增加提交限制。 |
| 专属权限、账户配额、传输断点快照 | 无 | 没有必要性，不实现。 |

## 15. 逐文件变更计划

行数为发布基线到目标的**格式化后增删合计估算**，不是可花完的额度。以下 10 个路径是上限，不为凑整数增加文件。能通过原调用解决时直接删掉相应改动。原生工具不额外复制一份 V1 检索入口。

| 生产路径 | 动作与边界 | 估算 |
| --- | --- | ---: |
| packages/core/src/session/compaction.ts | 共用 status、完整模板与滚动合并规则、首次立即 propose 指令；维护只改变消息前缀，不覆盖父 toolChoice；无效回包最多重发8次，窗口外ID用原默认切点。保留 blocks、原 select、原收尾及错误 owner，恢复无关排版。 | 228 |
| packages/core/src/session/runner/llm.ts | 注册无状态 compact，手动使用当前活动窗，Overflow 复用父请求；主动提案只在已结算且未失败退出时提交。保留 blocks，恢复三处无关等价改写。 | 81 |
| packages/core/src/session/history.ts | 工具调用才执行只读 search/ref/read，保留两代正文/角色/类型及续搜；单次 archivePage 的 Map 复用同 cold_ref 预筛布尔值，不跨调用、不统计次数。 | 174 |
| packages/core/src/storage/cold-store.ts | 按既有 owner/hash/codec 读取解压字节作阴性预筛；其余读写、codec、存储格式不变。 | 24 |
| packages/opencode/src/session/compaction.ts | 原选界/marker/证据/续跑；parent承接user/model/toolChoice及已处理history，候选从可见视图按原窗口生成；父模型/前缀保留，插件追加末条；不重复select；未提交重发8次，省略或窗口外ID用默认尾部。 | 393 |
| packages/opencode/src/session/prompt.ts | 原维护点传已有user/model/system/tools/toolChoice、requestMsgs引用和前缀函数；恢复原hasToolCalls，提案函数只找已完成propose。普通请求、权限及调度不改。 | 67 |
| packages/opencode/src/session/processor.ts | checkpointEvents仅交付合法工具摘要，其他回包作为未提交；摘要且无hasText时不写成功finish，普通轮沿原处理，无新状态/结束原因白名单。 | 31 |
| packages/opencode/src/session/message-v2.ts | 只投影compact自己的summary字段，保持现有成功分支与其他Part原行为。 | 9 |
| packages/opencode/src/tool/context.ts | 两个独立工具、四操作及完整指引；保持scope、ref、UTF-16、role/partType和原权限接线。 | 170 |
| packages/opencode/src/tool/registry.ts | 沿现有注册表初始化、列出两工具；其他工具筛选与权限不改。 | 7 |

累计保留6份原测试/基准代码文件：Core session-runner、location-layer、config/provider，V1 session/compaction、session/prompt及scripted回包。按§1.7再修改已有`packages/core/test/fixtures/recordings/session-runner/openai-chat-streams-text.json`，只同步实际请求的工具说明和tools字段；响应、其余请求字段、metadata及matcher不变。新增测试用例和测试文件为零。本轮V1父请求夹具只补同源history，pending estimate用例和断言不改，Core recorded测试源码不改。原T1–T4、scope、role/partType、UTF-16、冷态、目录及回包断言继续保留，session-history保持HEAD。

§1.8的既有`packages/opencode/test/server/httpapi-exercise/index.ts`增加为第7份测试代码修改路径：场景数组接收main已提供的假模型服务，summarize的首份文本回包改成该服务已有tool方法交付原summary，其余场景定义、第二份文本和断言原样保留。全任务生产仍10文件、1,201行；本轮生产增删为零。

§1.9只再修改两行现有验证配置：`packages/core/package.json`的test脚本改为`bun test --timeout 30000 --only-failures`；`packages/core/test/util/effect-flock.test.ts`的现有crashed-owner调用从`waitForFile(ready, 5_000)`改为`waitForFile(ready, 15_000)`。不改affected.ts、test.yml、锁实现、轮询或清理逻辑、依赖清单及原断言。既有测试修正按用户最新原文不受原文件数量上限限制。

R3/R4 的基准保留既有 `/summarize` 工作量、成功断言和阈值。旧请求的模拟响应仍为文本 `Bench summary.`；新请求从末尾的 status 选择保留 ID，沿已有 `invoke` 提交同一份摘要。夹具不从指令里解析宿主指定的 ID。

### 接线的具体落点（设计审查，不作编码授权）

- V1 选界复用的最小函数接受原 messages/cfg/model，返回原 head/tail_start_id。工具包引入该函数而非整个 registry/service；工具从初始 Effect 取得现有 Config，模型从 ctx.extra.model 按现有 Provider.Model 边界取用。消除 compaction 对 registry、tools、MCP、auth、LLMRequestPrep 的旧反向引用后才接入，避免环依赖。
- 只在原 V1 run/process 调用之间传可选的现场请求或已接受的 propose 入参，两种来源择一；后者只含已有工具的 B/S。复用原 sessionID、model、agent、marker parentID。Core 在原 Input 上用当前 request/entries，不复制用户对象；需要按 entry 切分时仅传已有块的引用，使用 normalizeImages 后的实际 request.messages 切段。传输签名、返回值、数据库定义不增加字段。
- 主动提案取工具结算时已有的实际参数。Core 在成功提案的工作步结束后才取提交所需的 tail；V1 消费已加载的本步工具 Part。失败与取消沿原出口，普通回复不增加读取。
- history和冷字节预筛沿既有表及inspect只读工作；没有签名密钥、正文哈希拒读和撤回判定。工具实例只持有查询进度。两个工具沿现有操作权限接线，数据层不新增调用方会话绑定、数据库结构或SDK出口。

## 16. TDD 行为切片

| 顺序与真实入口 | 基线缺什么 | 最小通过结果与反例 |
| --- | --- | --- |
| T1 普通模型调工具 → 下一次真实工作请求 | pre-R1 两个运行时没有该提交通道 | 先提交 A 的已完成事实，B 留尾。status 返回真实 ID/摘录；propose 后下一请求含 S 与 B，A 的旧工作记录不再当作活动正文；原 B ID 仍可读。至少一次提交取当前窗已有但不在候选中的助手 ID；参数说明、执行入口与最终写入均以 ID 存在为准。V1 直调/child 分别通过同一入口。 |
| T2 Overflow → 工具摘要 → 续跑 | 基线另起文本摘要请求 | 在已有宿主用例里让上传在 B 之前截止，模型从同一窗口选 C。验证上传仍按 B 截短，而成功 checkpoint 与下一工作窗口保留 C 起的尾部。沿用普通工具选择，不增加 OAuth 断言。 |
| T3 手动 → 同一工具摘要 → 读回 | 基线手动请求没有保留当前结构化消息和完整候选 | 在模型端观察原消息前缀、末尾一句话、完整 status 和 compact 声明。用工具返回 C 和 S，读回 S 与从 C 开始的尾部。只回文本不能完成压缩；恢复普通工作后工具表保持原选择。 |
| T4 历史工具从真实会话查回文字 | 基线没有历史工具；活动窗不能查回已压缩的原文 | 默认session查旧patch，global查另一会话的原生冷记录并返回标题/时间。超时先返回进度，相同查询续扫到较旧冷命中；ref读回原文，UTF-16半代理位置自动对齐并交付完整字符，冷态保持。 |

先在一个切片观察红，再写最小实现、转绿、跑回归，不一次写满整套测试。已有成功断言只有请求形态确实改变时调整；失败结果、窗口模型配置、水位、额度不得为了候选实现而放宽。性能用原 bench，不在测试断言源码、哈希、私有函数名或历史审计文本。

T1检查新工具中的原六节模板及下一次请求里的S、保留消息和SIBLING_927。T2沿原用例验证上传按B、模型选择C后按C保留。T4保留超过一页的夹具，首次global调用传timeout=0，观察timedOut和已扫条数，再以相同query/scope继续至剩余为零；不替换时钟，不断言机器耗时。UTF-16检查从实际read结果定位半代理位置，再调用chars=1，应收到完整码点。

按§1.6在原文件扩展T2/T3：父请求带实际model、非空user.system及可观察toolChoice；维护使用同一model，父工具description/schema/顺序保持，末条包含指令、status、插件文字。原漏调用例验证首发加8次重发及重试中取消后旧窗口仍在。错误工具、status、缺失operation/摘要、空摘要和截断未形成提案沿同一未提交路径；窗口外ID验证默认切点，既有省略ID夹具和成功/尾部断言原样保留。B-20失败提交用原active checkpoint场景作隔离反馈；正常成功场景保留。撤回纯格式化，不保留只约束中间函数形状或错误文案的断言。

后续修正沿既有用例验证，父请求用例只补接口输入。不得新增测试、参数化分支或测试文件；仅按§1.9调整明确指定的测试时限，成功期望、计时器门禁和真实录制响应保持原样。

HTTP练习修正沿§1.8既有失败场景做红绿，不新增场景或断言。定点执行session.summarize；用原coverage模式检查注册覆盖，再用原session.prompt场景确认共享模型服务仍按既有路径工作。HttpApi effect全量留在线上。

core时限修正只复跑原native goal continuation、native transport recovery及crashed lock owner用例。用`bun run test`验证包脚本生效，保持原成功断言；不增加延迟夹具、压力循环或新的污染断言。

## 17. 注释与格式

逐文件计算新增行的字符数/新增行数，与完整旧文件的字符数/行数比较，上限 1.2 倍；两边都计空行、缩进、注释和换行，CRLF 统一为 LF。没有同路径旧文件时单列新增均值。收敛以移除不必要的调用、参数和重复职责为准。

仅在命名难以表达处用中文说明：B 属于保留尾部；字节匹配只能判阴性，最终命中归 renderer。其余优先用类型、原有函数名和测试表达。新增和修改的生产代码、测试代码都格式化，先格式化再检查预算。对象、回调、Effect 链和多步分支按可读结构展开，不能把多条语句、判断或赋值塞在同一行；不使用 prettier-ignore、格式关闭或拼接字符串来制造低行数。完整模型指令和原始字面量可保留长行，不改变字面内容求排版。

新增文件用项目锁定的 Prettier 格式化全文件；已有文件只格式化改动的完整语句/代码块（range-start/range-end 为字符偏移），审查范围扩展后的 diff。已有大文件中无关历史格式不算本任务，不能全仓刷格式。对格式化范围按项目配置再次格式化应无差异；整文件本来就符合时使用 --check。格式化若超预算，优先删冗余决策，不删测试义务、不挤行。

## 18. 验证与可行性

### 当前 HTTP 练习反馈与隔离验证

推送后guard运行`https://github.com/SMARK2022/opencode/actions/runs/45813611832`失败；用户给出同SHA macOS对照：preflight 1293通过、1分52秒，推送后1290通过、3失败、3分02秒。源码确认core脚本缺省5秒，opencode/tui脚本及test.yml的Windows/macOS命令为30秒，affected.ts:70接受指定脚本格式。effect-flock.test.ts:431显式等待5秒，450行已有30秒整体上限。第二个runner用例是否受前例超时污染尚未确认。

- `packages/core`：`bun run test test/session-runner.test.ts -t 'defaults native goal continuation to 32|recovers native transport' --timeout 30000`，2通过、19个原断言；仅通过命令行复用用户要求的时限，未改测试。
- `packages/core`：现有隔离preload以PROBE_FIX=flock仅替换实际waitForFile调用参数，运行`bun test --preload D:\Temp\opencode\compaction-ci-probe.ts test/util/effect-flock.test.ts -t 'recovers after a crashed lock owner' --timeout 30000 --only-failures`，1通过、2个原断言。实施后必须去掉该替换preload再跑原场景；不以本地速度证明慢宿主问题已彻底消失。

分支test工作流`https://github.com/SMARK2022/opencode/actions/runs/45813611903`的唯一失败job为`必过 HttpApi gate / effect`（139887533068）；原SHA的Preflight `45809296126`通过。两者为不同验收路径，不把Preflight通过代替该路由用例。

调用链已重读：HTTP handler `session.ts:421–451`调用原promptSvc.compact；fixture index.ts:1646–1647仍提供两份文本。TestLLMServer已有tool方法，main已有该服务layer；Scenario.seed的Effect不接受额外环境，ScenarioContext只有llmText/llmWait。由main取得现有服务值并在同文件构建原数组，使该seed可使用真实工具回包而不扩大公共测试接口。

所有本地练习从packages/opencode运行，TMPDIR/TEMP/TMP均设为D:\Temp\opencode，清空OPENCODE_HTTPAPI_EXERCISE_DB/GLOBAL覆写，使用原程序按PID创建和清理的隔离数据库；OPENCODE_DISABLE_LSP_DOWNLOAD=true。

- `bun test/server/httpapi-exercise/index.ts --include session.summarize --mode effect`：pass=0、fail=1，精确复现用户的summary助手断言。
- 隔离原型仅修改已有D:\Temp\opencode\compaction-ci-probe.ts的内存loader；`PROBE_FIX=httpapi bun --preload D:\Temp\opencode\compaction-ci-probe.ts script/httpapi-exercise.ts --include session.summarize --mode effect`：pass=1、fail=0，missing=0、extra=0。通过CI实际wrapper导入index，原断言保持。

实施后不带preload运行同一wrapper定点场景、原coverage和session.prompt场景，检查包内typecheck及新增语句格式，完整实施审计后提交。新SHA须通过正常push的Preflight及分支test工作流的HttpApi effect job；本地不运行该完整路由集。

### 前版线上反馈与隔离验证

已提交SHA `fedff6c57e9093ed77a42778af19cc053ad2f650`的Preflight为`https://github.com/SMARK2022/opencode/actions/runs/45788328207`。规则与契约、basic/extended及性能基准通过；Linux和macOS均有Core recorded超时、30秒计时器泄漏，以及V1 pending estimate准备屏障超时，尚未通过最终验收。

探针仅修改已有`D:\Temp\opencode\compaction-ci-probe.ts`和进程内模块，仓库生产、测试、录制JSON未改：

- `packages/core`：`bun test test/session-runner-recorded.test.ts --only-failures --timeout 12000`，0通过、1超时。脱敏replay探针显示仅系统工具说明由WITHOUT变为Using、以及新增tools/context_compact两项body差异，随后进入原重试。
- `packages/opencode`：`bun test test/session/compaction.test.ts -t 'stores pending input estimate on summary assistant before streaming' --only-failures --timeout 12000`，0通过、1超时。实际末条候选excerpt含`plugin-hidden-compaction-history`，原断言在prepared信号前失败。
- `packages/core`：`PROBE_FIX=recording`，`bun test --preload D:\Temp\opencode\compaction-ci-probe.ts test/session-runner-recorded.test.ts --only-failures --timeout 5000`，1通过、5个原断言。仅隔离替换录制请求body，保留matcher和原响应；脱敏实际请求位于`D:\Temp\opencode\recorded-current-request.json`。正式实现仅改已有JSON，不保留运行时替换。
- `packages/opencode`：`PROBE_FIX=visible`，`bun test --preload D:\Temp\opencode\compaction-ci-probe.ts test/session/compaction.test.ts -t 'stores pending input estimate on summary assistant before streaming|keeps the parent tool declarations' --only-failures --timeout 12000`，2通过、21个原断言。可见消息按原history身份生成候选，原父请求夹具传同源history；隐藏原话不再进入候选，父前缀保持。

已重读prompt:2204–2211的插件/visible处理与2402–2411的parent交付；compaction:428–443的原replay、474–508的候选和消息准备。parent.history取已有requestMsgs，ID集合保留原replay窗口，没有第二次selector、预算算法或新fallback。

实施后重跑两个原失败用例、原parent用例和两包typecheck，必要规则及完整实现复审通过后创建修正commit、正常push。累计diff继续比较55d404f3a1，新SHA多平台与正式性能仍在线上验收。

### 前版方案隔离验证

实验仅用 `D:\Temp\opencode` 下的 Bun preload 改进程内模块，工作树生产/测试未修改。所有命令从对应包目录运行，单次约2–5秒；无本地Benchmark或全量Gate。`PROBE_CANDIDATE=0/1`分别观察当前代码与候选原型。

| 命令、cwd与环境 | 实际结果及含义 |
| --- | --- |
| packages/opencode；`bun test --preload D:\Temp\opencode\compaction-r148-probe.ts test/session/compaction.test.ts -t 'keeps the old window until a missed checkpoint call succeeds' --only-failures --timeout 12000`；PROBE_CASE=v1-publication，PROBE_CANDIDATE=1 | PROBE_REPAIR=retry-reset：失败，发布观察为`[false,false]`，两行清理前已经裁掉旧历史；PROBE_REPAIR=publication：1通过、11断言。原hasText源头修正经用户明确选择。 |
| packages/core；同一preload，`test/session-runner.test.ts -t 'active checkpoint keeps settled sibling results' --only-failures --timeout 12000`；PROBE_CASE=provider | 当前失败步把`Initial checkpoint`替换为`Current checkpoint`；已有结算/退出状态约束的候选1通过、2断言，旧checkpoint保留。 |
| packages/opencode；`bun test --preload D:\Temp\opencode\compaction-r148-prefix-probe.ts test/session/compaction.test.ts -t 'keeps the parent tool declarations' --only-failures --timeout 12000` | 当前父user.system丢失导致夹具中止、返回stop；候选复用parent.user/toolChoice并追加插件文字后1通过、9断言，父定义保持。 |
| packages/core；同一prefix preload，`test/session-runner.test.ts -t 'manual compaction stops after summarizing retained tool tail' --only-failures --timeout 12000` | 当前toolChoice是命名compact，与父缺省不同；仅删除强制覆盖后1通过、29断言。 |
| packages/core；`bun test --preload D:\Temp\opencode\compaction-r148-retry-probe.ts test/session-runner.test.ts -t 'summarizes an oversized newest message' --only-failures --timeout 12000` | 8次未提交后第9次交工具摘要，随后工作请求：当前实际3请求、期望10；候选1通过、9断言。窗口外ID采用原默认切点，原memento/整窗断言保持。 |
| packages/opencode；同一retry preload，`test/session/compaction.test.ts -t 'keeps the old window until a missed checkpoint call succeeds' --only-failures --timeout 12000`；PROBE_CANDIDATE=1 | 1通过、10断言；9次维护请求，重发中旧窗口保留，最后工具摘要与tail保存。 |
| packages/opencode；同一retry命令，PROBE_CANDIDATE=1、PROBE_EXHAUST=1 | 1通过、11断言；自动非overflow的9次未提交耗尽后返回stop，原旧窗口仍在，可见消息无新增error，不产生Saved checkpoint。 |
| R149复核；packages/opencode，同一prefix命令，PROBE_CANDIDATE=1 | 在父请求使用独立的parent-model实例，维护直接复用该实例，其他前缀字段、插件末条及原成功断言同时通过：1通过、10断言。 |
| R149复核；packages/core，同一retry命令，PROBE_CANDIDATE=1 | 撤掉必填ID门槛，保留第9次回包省略ID，原整窗/memento成功断言通过：1通过、9断言。 |
| R149复核；packages/opencode，同一retry preload，`test/session/compaction.test.ts -t 'preserves recent user instructions in compacted context' --only-failures --timeout 12000` | 未改写原省略ID成功夹具，1通过、5断言。 |

最初preload返回undefined触发Bun `onLoad() expects an object returned`，该次未运行产品路径；修正loader返回原模块后才取得表中结果。冷包缓存的实际成本来源已由`archivePage.project -> matchColdBytes -> readRaw -> decompress`确认；当前每条同包记录都再次调用该链。用户明确要求单次调用Map，正式冷数据性能仍由线上Preflight/授权样本验收，不用热数据结果代替。

下列旧实验保留为历史证据；当前行为和执行命令以本小节及§1.6为准。

**模型选择保留位置。** 在包目录仅运行下列三个既有用例，Bun preload 只改进程内代码和回包。原型没有改工作树生产或测试文件。这些结果验证设计，不是最终交付的绿测。

| 实际入口与用例 | 输入和观测 |
| --- | --- |
| V1 `test/session/compaction.test.ts`，`uses the earliest feasible cut when the recommended overflow head is too large` | 保持 B 前的上传不变；模拟模型从 status 选 C。原实现返回 `stop`，预期 `continue`。把回包中的 C 交给当前压缩调用，在活动窗找到它后沿原 marker 写入：1 pass，8 个断言，窗口含 S/C、不含 B。 |
| Core `test/session-runner.test.ts`，`manual compaction stops after summarizing retained tool tail` | 模型选择 `Keep recent tool turn`，不选宿主描述的 `Earlier answer`。按交付 ID 切 `recent`：1 pass，30 个断言，`recent` 以该用户消息开始，保留工具回执，排除早先回答；事件重放与下一工作请求沿原路径。 |
| Core `test/config/provider.test.ts`，`binds native reviewer instructions to the selected OAuth identity and final wire body` | 现有手动压缩夹具回纯文本，单跑报无可用摘要。实验只让维护回包用已有 Responses 工具帧交出夹具中真实消息 ID 和原摘要，正常工作和审查回包不变。在 Core 原型上 1 pass、原有 518 个断言通过，OAuth 新增断言 0。 |

**T4 的公开入口。** 在 `packages/opencode` 定点运行 `test/session/prompt.test.ts` 的 `reads a changed file from archived patch evidence using the ref returned to the model`：隔离夹具用超过一页的原生历史与原用例的 V1 patch。默认查询仍只有同会话命中；global 限 1 项后增大上限，返回另一会话的标题和较旧冷命中，不纳入两次调用之间新增的消息。模型用 ref 读到原文，撤回后同一 ref 不再可读，原行仍是冷投影。1 pass / 16 个断言。这个切片验证条数截止后的续搜；旧底层切片单独验证过 deadline 截止，不把前者写成超时实测。

第六轮后的隔离验证将这次条数截止换为 §16 的可控 deadline，仍用同一个用例和同一个冷记录。首次 `timedOut=true` 且有剩余，第二次剩余为零，读回、撤回和冷投影断言保留；1 pass / 18 个断言。最终候选保留这个能重跑的 deadline 切片。空候选的无 ID 工具回包沿既有 `manual compaction retries transient summary failures without committing partial text`；附录 A.2 改为同一句话允许这种回包，不引入另一个返回协议。

已有单次定位证据：`packages/core` 的 `bun test test/session-runner.test.ts -t 'active checkpoint after a prior summary: tool-calls' --only-failures --timeout 30000` 在手动准备阶段报 `Missing host replay instruction`。夹具只认旧 `HOST_REPLAY_BOUNDARY`；这不证明应改为文本回包。实施时保留它的工具响应，改为观察实际末尾一句话及完整候选；方案阶段不循环跑这个测试。

| 命令（包内命令以右列为 cwd） | cwd | 证明 / 当前结果 |
| --- | --- | --- |
| bun typecheck | packages/core | 恢复态 exit 2：旧 runner 测试调用 snapshot、传 actor、期望布尔外值；不能恢复这些旧接口来迁就夹具。 |
| bun typecheck | packages/opencode | 恢复态 exit 2：isUserInitiated、compact-preflight、compactionControl/preparation、ArchiveScan/searchArchive/readArchive、singleLine/alignOffset 等已不配套。按实际职责恢复，而非整树重放。 |
| bun test test/session-compaction.test.ts --only-failures --timeout 30000 | packages/core | 本轮 5 pass / 0 fail；证明原模板首轮/更新与交接等已有行为，不证明新功能。 |
| bun test test/session/processor-effect.test.ts -t 'stop after token overflow requests compaction|compact on structured context overflow' --only-failures --timeout 30000 | packages/opencode | 先前中间版 2 pass；在本次恢复输入与最终候选分开记录。 |
| bun test test/session-runner.test.ts -t 'summarizes an oversized newest message' --only-failures --timeout 30000 | packages/core | 先前基线成功期望复原后 1 pass；原错误分别是无压缩/错误真值循环。最终重跑。 |
| bun test test/session-runner.test.ts test/session-compaction.test.ts test/session-history.test.ts test/location-layer.test.ts --only-failures --timeout 30000 | packages/core | 目标：T1–T4、原选界和目录归属；不新增专测废弃设计的断言。 |
| bun test test/session/processor-effect.test.ts test/session/compaction.test.ts test/session/prompt.test.ts test/session/message-v2.test.ts test/session/execute.test.ts test/storage/cold.test.ts --only-failures --timeout 30000 | packages/opencode | 目标：V1 两入口、实际 tool-call、热冷历史与普通重放；T4 的模型端用例在 prompt.test.ts。 |
| bun x --no-install prettier --check <新增文件或基线已格式化文件>；既有文件按 §17 范围比对 | 仓库根 | 已对内存示例验证 Prettier 3.6.2 展开嵌套语句；恢复的 context.ts 仅格式化就在内存由 153 行变为 267 行，未写代码。 |
| git diff --check 6dd9a5b1f3；git diff --numstat 6dd9a5b1f3 | 仓库根 | 按 §15 真实路径聚合 §19 数字，包含暂存、新增、已删除行；实施前后核对未追踪文件。 |
| bun script/guard/check.ts --staged；提交时执行原 hook，普通 git push | 仓库根 / 线上 CI | 正常 push 触发 pre-push 发布 Preflight。核对 run 对应本次提交 SHA，再查多平台测试、规则与性能结果。 |

规划实证：两代摘要写入/恢复、child Part、父请求和工具定义的真实边界见 §4/5；原生 Core 没有持久 tailStartID，也无需增加一项。旧候选 de76e36408 的 archive 源码从 export type Archive 起在内存格式化由约 279 行展开至 467 行。因此不能把旧压行 stat 照抄为新设计成本。该实验是尺度参照，不是当前实装通过的证明。

性能：旧搜索实验在一个 session 的只读样本中扫描 60,680 条消息、1,406 个冷包（原始 1.146 GB），阴性全扫 8.12 秒，解析阴性冷包 0；仅是历史记录。最终在经授权的只读副本用真实工具、相同词和样本分别测 session/global 阴性/阳性，记录首个有用响应、进度、总体耗时、读错及冷态。无副本时标明未测，不以临时小库的数字冒充。旧 Preflight 45056316015 的 list/open/compact CPU 和 compact 延迟退化不证明本方案改善；候选必须跑正式配对 A/B。不得改 benchmark 工作量、阈值，或用预热掩盖冷读开销。

### 两个提交时机的隔离实验（已运行，仅内存）

以下分别在 `packages/opencode` 和 `packages/core` 以 `bun -e '<代码>'` 运行，退出均为 0。调用实际重放函数，输入是进程内 fixture；没有把 fixture 当作持久数据库或端到端 provider 测试。

```js
import { filterCompacted } from "./src/session/message-v2.ts"
const row = (id, n, parts, info = {}) => ({ info: { role: "user", id, time: { created: n }, ...info }, parts })
const text = (value) => ({ type: "text", text: value })
const rows = [row("A", 1, [text("old")]), row("B", 2, [text("keep")]), row("M", 3, [{ type: "compaction", tail_start_id: "B" }])]
const window = (finish, parts) => filterCompacted([...rows, row("S", 4, parts, { role: "assistant", parentID: "M", summary: true, finish })]).map(m => m.info.id).join(",")
console.log([window("stop", []), window(undefined, []), window("tool-calls", [text("resolved")])])
```

实际 ID 序列分别为 `M,S,B`、`A,B`、`M,S,B`。同一组源消息，仅一个错误的非空 finish 就能裁掉 A。第二个值是漏调与重试之间必须保持的可见窗口；第三个是已经收到有效正文后的结果。

```js
import { serialize } from "./src/session/compaction.ts"
import { toLLMMessages } from "./src/session/runner/to-llm-message.ts"
import { Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
const model = Model.make({ id: "m", provider: "fake", route })
const b = { id: "B", type: "user", text: "keep" }
const result = { status: "completed", input: {}, content: [{ type: "text", text: "SIBLING_927" }], structured: {} }
const a = { id: "worker", type: "assistant", content: [{ id: "x", type: "tool", name: "echo", state: result }] }
const wire = rows => JSON.stringify(toLLMMessages([{ id: "M", type: "compaction", reason: "manual", summary: "SUMMARY_A", recent: rows.map(serialize).join("\n\n") }], model))
const before = wire([b])
const after = wire([b, a])
console.log({ stale: before.includes("SIBLING_927"), settled: after.includes("SIBLING_927"), kept: after.includes("[User]: keep"), summary: after.includes("SUMMARY_A") })
```

实际结果 `stale=false, settled=true, kept=true, summary=true`。因此仅在提案确实完成时取得结算后的尾部是必要工作；不要求每次普通调用重读窗口。实际同步边界、错误/取消和真实请求留给 T1/T2 端到端验证。

## 19. Diff 预算

基准夹具实证：旧夹具两次返回纯文本 `Bench summary.`、`finish_reason=stop`，而 `bench/opencode.ts:333` 要求实际持久化的成功摘要。更新后，基线文本请求、新协议带 ID 和无用户 ID 三种回包的轻量检查均已通过。正式配对性能只在线上 Preflight 测量；本地中断的基准未产生测量结果。

| 指标 | 发布基线 → 本次恢复输入 | 计划及硬界限 |
| --- | --- | --- |
| 生产文件 | 6（含新增 context.ts） | 9 修改 + 1 新增，最多 10；存储层仅 §15 两个读取 owner。 |
| 生产行 | +594 / −429，共 1,023 | 已提交累计1,201，本轮生产增删为零；最终累计**新增 + 删除 ≤1,400**，不按净增。 |
| 测试文件 | 2 | 当前修正为8份既有测试/基准代码、1份已有JSON及1份已有test脚本配置；按§1.9，既有测试修正不计原文件数量限制。新增用例和测试文件为零。 |
| 文档 | 1；恢复输入 2,782 行 | 只维护本文件，文档不计实现行数、生产/测试文件数，没有用户指定的 200 行上限。 |
| 生成产物、迁移、基准工作量与判定、依赖清单 | 0 | 0；仅模拟模型的回包按 §15 计入测试文件。不新增配置开关，不用拆提交稀释最终总 diff。 |

每个切片以最终格式在真实文件重测。237 行的新增实现若删除 80 行，预算占用是 317；不是 157。§15 是估算，不是批准突破硬限制。若最后一项无法在总预算内完成，停在最近可验证状态，把具体超额路径与可删除责任写入本文件，不删一项工具或隐藏测试差异。

R143 实施中核算：相对当前 HEAD 的 10 个任务生产文件为 +1,044/−291，共 1,335 行，超出 135 行。V1 `session/compaction.ts` 占 405（+204/−201），Core `session/history.ts` 占 287（+285/−2），Core `session/compaction.ts` 占 218（+168/−50）。发布基线至 HEAD 在这十条路径中只有已经提交的 `message-v2.ts` 变动（+83/−81），不归入本次交付。此处记录工作区实测，最终格式化和实施审计尚未完成。

本轮已移去 V1 普通工作步为查提案而创建的工具数组，以及宿主选界传递的临时 `count`。只有准备发维护请求时才读取 agent。可继续收敛的是 V1 宿主的选界与请求组装；旧 transcript 删除和原 selector 的迁移均计入增删。归档的行恢复已用 `inspect`，列表搜索只返回会话定位，不能替代消息正文、偏移和读回复核。

R144 的中间测量为 +1,057/−290，共 1,347 行。该版本让 Core 选界额外返回一组候选位置；因调用方已有候选 ID，现已撤回这个返回字段。行数分别核算 HEAD 到暂存区、暂存区到工作区及 HEAD 到工作区，不能把前两段的增删机械相加。

R145 实施前：HEAD→index 生产 6 文件 +594/−429；index→工作区 10 文件 +1,244/−643；最终差异 10 文件 +1,056/−290，共 1,346 行，超出 146。九个有 HEAD 旧版的文件均满足逐文件平均行长上限，最高 1.117 倍；新增 `tool/context.ts` 单列均值 55.524。删除宿主切点相等约束、助手摘录/次序拼接、手动专属切块和预制 B 尾部，再核算实际增删；这些删除尚未写入生产文件，不预报已达标。

R147冻结实测：当前HEAD为`f1cd9b8d55`，其中TUI提交不属于本任务。十个生产路径为+893/−296，合计1189行；六个测试/基准路径，session-history已恢复HEAD。九个可比较生产文件的新增平均行长比值最高1.1144，小于1.2；新context.ts单列平均51.559字符/行。

| 生产文件 | 新增/删除 | 新增均长/完整旧文件均长 |
| --- | ---: | ---: |
| core/session/compaction.ts | 180/68 | 53.317/47.847 |
| core/session/history.ts | 167/2 | 37.749/47.523 |
| core/session/runner/llm.ts | 73/12 | 46.808/57.503 |
| core/storage/cold-store.ts | 20/4 | 41.850/43.704 |
| opencode/session/compaction.ts | 191/195 | 42.209/38.939 |
| opencode/session/message-v2.ts | 8/1 | 31.875/43.394 |
| opencode/session/processor.ts | 29/6 | 47.517/44.917 |
| opencode/session/prompt.ts | 48/8 | 40.938/45.338 |
| opencode/tool/context.ts | 170/0 | 51.559/新增文件 |
| opencode/tool/registry.ts | 7/0 | 43.000/39.949 |

## 20. 风险、决定和后续项

**已定。** 两工具都交付；保留原选界、祖先原话/模板和 history 的续搜，去掉检索配额。错误处理不变更标准 API；不引入第二套提交接口、跨调用压缩状态或 storage schema。当前工作区的恢复是用户选择，不按“越短越好”整份回退。

### Open Decisions Requiring the User

当前审计授权仅以§1.6最新question答复为准。R146及R147额度记录是历史；本版须取得对应方案批准后才能实施，文件数和行数上限不变。

两个新工具沿用暂存版按 `operation` 的接线。维护请求只提供工具声明，不追加局部allow，也不为工作轮缺工具创建服务。此前据此新增的decide/OAuth、权限覆盖、caller拒读的专属验收撤销。`.opencode/plugins/guard.ts`及其他agent的修改不进入本任务提交；其余每个代码差异和断言按§1原文核对。

产品路径已定。§1.6 新增两次审计额度，替代已经用完的上一批额度；两项待定设计与 B-19 源头修正已由 question 明确选择。实施只覆盖本版审计通过后的改动，不扩大文件范围、权限、存储和公共接口。可选的 Core blocks 删除不采用：toLLMMessage(system) 调 Message.system 时丢失持久 ID，空 assistant 可零输出，工具结果有一对多展开；blocks 还区分真实历史末端与临时提醒。normalizeImages 保留消息 ID 和顺序，不能补回转换前已丢掉的 ID。

### Follow-up

| 事项 | 可见证据 / 基线行为 | 处置 |
| --- | --- | --- |
| 供应商最终缓存命中和计费 | lowering/SDK、供应商保留策略可能改变命中；原产品不保证手动请求命中。 | 可在合法供应商样本单独实测；不据推测改变 wire。 |
| 与压缩无关的 CLI 进程、Sharp/registry、本机计时器门禁 | 旧日志有 59 条失败；未在同 base 同环境证明为本功能导致。 | 不冒称已修或全部是基线；最终 Gate 有关联失败时先做 A/B 归因。 |
| 已读完的页之后又撤回/恢复的记录 | 搜索是有限快照游标，不承诺全库事务快照。 | 新查询反映变化；保留不重验旧命中，不修公共Undo或并发调度。 |

### Rejected Speculation

不为每个插件生成不确定文本做字节级前缀证明，不为每个 tool Part 重验 schema，不从“模型可能调用多次”推导出提案状态机。理论异常不扩大测试/文件。搜索作用域和可见性有实在消费者，不能以“只读”理由忽略。

## 21. 审计合同

主助手只提交本版文档。独立只读方案审计按原需求、固定基线和真实消费者核查全范围；核对 §13 无遗漏、§14 无无主概念、§19 口径正确。以明示需求、契约/范围违规、可复现基线回归或主路径失败作为阻断依据；每项含生产者、路径、后果、基线。审计不得要求用新接口、状态或文件解决非本次需求。

收到 BLOCK 先核对对应要求；由设计过重造成就删原因。不劣于基线且不在本任务的事项回原 task 复议，按其最终分类保留 Follow-up。修改行为时升 revision、清空批准，从完整方案重审；同一材料不得反复自审放行。方案最多 6 轮，实施最多 3 轮。实施门禁另看全部实际 diff、格式、可运行回归和发布结果。

## 22. Revision Delta 与方案审计

| 版本 | 相对前次审计的实质差异 | 保留的记录 |
| --- | --- | --- |
| 至 R126 | 旧范围含双工具、两代、传输缓存标记、额外审批/预算。 | 用户恢复的原文件 blob ac389f8ac06adfa2f85587b5555e9f862d360f6a 含各轮逐条审计；旧实施已审过，不适用于本次输入。 |
| R128–R131 | 旧轮次评估无现场维护、空会话和保留窗；R131 方案曾 APPROVE，实施复审仍遇阻。 | 历史调用 ses_dfb1b6ad5ffe8POp93Np77bEKg、ses_df97cad33ffexv3awpgHPgqVd2；不把旧 verdict 转记为新放行。 |
| R132 | §1–21 从固定基线到双工具目标重新建模。回收状态、传输与计费范围；保留模型文案和冷热检索。以最新三个限额及格式化验收取代旧预算。 | 新需求新开方案审计，不覆写旧历史、不复制审计全文到设计章节。 |
| R133 | §1、§10、§16、§18 和附录 A。用已有 finish/Ended 与结算后的窗口修正 B-01/B-02，在原工具说明引用共享模板（B-04），补足正文清单（B-05），记录两个独立内存对照（B-06）。 | B-03 复议撤销；更正 N-01 的章节引用。不加文件、持久状态或字段；仍为同四个测试切片。 |
| R134 | 最新用户指示统一手动和 Overflow 的调用：当前消息或按尾首截取的输入 + 一条 user 消息（一句指令、完整 status），统一以 propose 完成压缩。删除手动文本回包、首轮/更新两套宿主文案与单候选指令。 | 历史检索、原持久字段及预算不变；R133 的批准仅作历史记录。 |
| R135 | 沿用当前工作 agent 与已有工具选择，禁用就不调用；一句指令描述保留范围，完整 status 原样跟在下一行。调整六个测试文件的分配，覆盖真实撤回用例。 | 据最新 question 答复移除 B-09 的额外接线提议；B-10、B-11 在本版处理。 |
| R136 | 用户明确上一工作轮未暴露工具不影响显式手动压缩。改正 R4/I4、§10.3 和 T3：压缩请求必带 compact，接受前缀失配。 | R135 复审中断，无放行结论。后续方案和实施审计均复用 `ses_df3fcd990ffeyCFnmn0j29C7J2`。 |
| R137 | V1 在原压缩入口用既有请求字段表达本次作用域；Core 在原 runner 组装点按本次工具表生成指引，禁调提示只在原工作轮使用。 | 对应 B-09/B-12；不改传输层、公共权限、数据库或文件数。 |
| R138 | 按 §1 用户原文撤掉 ref 的工具实例绑定。T4 保留同会话点读、跨调用会话拒绝、global 范围、正文变更和撤回检查；移除只断言新工具实例必须拒读的期望。 | 不给引用增加新的生命周期承诺。其余工具、预算和接口审批要求不变；R137 审计记录只适用于原版。 |
| R139 | V1 压缩复用已有 system；历史检索保留字节预筛及命中后的正文解析。 | 两个工具、文件白名单、1,200 行生产预算及 §20 的授权边界不变。本版待独立审计。 |
| R140 | 按 §1 最新原文逐项撤回：权限改线、ref 绑定发起会话、以摘录或角色拒绝提案、普通回复寻找提案、额外压缩实例、相应专属断言及无关改动。 | 复用原 Task；本次需求更正后，方案与实施审计合计最多六次。下列旧版实测仅是历史记录。 |
| R141 | 手动请求提供定义后沿原权限筛选；T1 用现有非候选消息验到写入后的下一窗，参数说明与写入点一致。 | 本轮要求更正后的第 1 次独立审计：**BLOCK — `docs/plans/cache-preserving-compaction.md`，R140，Git blob `e6b1b5de77c2431830cbb40c779f5bb8e3e20d3f`。** B-13、B-14 对应原文，修订后同 Task 复审。 |
| R142 | 依据 §1 最新原文，删去 `read` 报错时遍历并删除 `search` 续搜记录的行为。`search → ref → read` 保留；续搜仍在 search 时复核可见命中。 | 撤回 `tool/context.ts` 中这一个错误回调；沿用 T4 的点读、撤回和续搜用例。 |
| R143 | 正式性能基准的模拟模型只返回文本，不能驱动新摘要协议。沿用同一工作量，按请求返回同一摘要。 | 只将第六个测试路径分给已有 `scripted` 回包；十个生产路径、1,200 行上限和实施授权边界不变。 |
| R144 | 依最新答复撤回附录 A.1 的额外引用提示，保留六节模板、原末句和搜索词线索；明确 V1 摘要处理器的可选切点参数。按 §1.5 的发布原文，将终点由目标分支更新改为本次提交 SHA 的线上 Preflight 通过。 | HEAD、暂存区和旧候选的单参数请求均不能在不恢复工具执行及其状态机的情况下提供切点。此次接口授权仅覆盖该参数。须正常 push 一次触发 Preflight；验绿后可不再推送目标分支。文件、预算、权限不变。 |
| R145 | 用户明确最终切点由模型决定。移除 V1/Core 对宿主建议 ID 的相等校验，写入时使用模型的 C。宿主仍负责控制上传量。 | 用现有压缩用例区分 B 与 C；旧版批准仅作历史记录。预算、公共权限、重试、正式基准和线上终态不变。 |
| R146 | B-16：共用的一句指令写明有保留 ID 就带 ID，没有则只通过同一工具交摘要。B-17：T4 用真实工具的 deadline 返回及续搜替换限条数观测。同步将重试成功的验收窗口记为 S/C。 | §18 已记录单例隔离结果。未改生产或仓库测试，未追加审计轮次；R145 的 BLOCK 保留。 |
| R147 | 用户指定逐hunk核对和撤回：首条真实用户消息进入候选；取消提案角色/推荐位置判定、额外finish门禁、权限测试残留、引用签名/hash、回声与撤回复核、额外参数限制。49条引文已逐字核对原始会话记录，修正误删的role/partType与UTF-16行为；保留HEAD默认尾部、compaction模型配置和原收尾时点。 | 两工具、四操作、两代历史、原持久格式与原权限接线保持。当前实现和断言按用户原文收缩，最终审计及同SHA Preflight仍待完成。 |
| R148 | §1.6、§7–16、§18–20及附录：按用户变更单保留父toolChoice/user.system，插件文字移至末条，恢复When combining规则，单次冷包预筛缓存，撤回无关改写。后续用户将重试明确为8次，并指定宿主无效ID用默认切点。 | B-18：本版清空批准，新增额度完整审方案；B-19：两行清理原型仍发布空边界，用户明确改为已有hasText源头判断；B-20：已有结算/退出状态约束提交，隔离红绿已取得。保留blocks，不新增finish白名单或状态，仍10生产/6测试；冻结hunk-review不提交。 |
| R149 | §1.6、§6、§9–11、§15–16、§18–20：撤掉宿主ID必填门槛和改写原成功夹具要求；parent传实际model，父已开放compact时直接使用，不给前缀友好追加“同模型”前提；其余保留原compaction选模。 | B-21保留原默认尾部；B-22补齐既有请求模型接线。两项隔离验证通过。8次重试、源头finish修正、工具/权限/存储/文件上限均不变，基准夹具同步新指令匹配，不改工作量。 |
| R150 | 保留完整原设计；§1.7、§7–10、§13–19修正线上已证实的候选来源和录制请求。parent仅追加已有requestMsgs引用，status在可见准备后按原history窗口生成；同步一份已有录制JSON。 | fedff6c57e线上两端同样失败，两个原用例已分别复现并隔离转绿。用户只允许修改现有基础及基线，故不新增测试或测试文件；累计生产仍10文件、≤1,400行，测试相关为原6代码加1已有JSON。本版清空批准，待完整方案审计。 |
| R151 | 保留全部生产设计与已通过修正，仅适配用户指出的现有HttpApi summarize回包；同文件由main向原场景数组传已有TestLLMServer值，首份回复用tool交原summary。 | 用户错误已复现，原型沿CI wrapper转绿；无生产改动、新测试、DSL扩展或新服务。累计增加1份已有练习代码修改路径，生产仍1,201行。本版清空批准，待完整方案审计。 |
| R152 | 保留完整路线；§1.9记录用户明确说明既有测试修正不计文件限制，以及core脚本30秒和锁ready等待15秒的指令。修正实际显式5秒调用，不改无效默认值。 | B-26的文件预算前提由用户明确更正；两处新指令只涉及既有测试配置，原用例隔离通过。无生产增删、新增测试或文件、运行时锁改动；清空批准，提交完整方案复审。 |

本次第 2 次独立审计：No blocking findings. **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R141，Git blob `95c725b260ab45850fb591ac2d9d60c6b2ffa3f6`。** 本轮复用同一 Task，只读复审，未修改文件、未运行测试。此结论不放行当前实现，也不替代 §20 的实施授权。

本次第 3 次独立方案审计（全范围，`ses_df3fcd990ffeyCFnmn0j29C7J2`）：No blocking findings. **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R142，Git blob `fe5f18ebe2ffd101fb269682b59bc483100c794a`。** 本轮复用同一 Task，只读复审，未修改文件、未运行测试。此结论不放行当前实现，也不替代 §20 的实施授权。

本次第 4 次独立方案审计（全范围，`ses_df3fcd990ffeyCFnmn0j29C7J2`）：

> No blocking findings.
>
> **R143 方案通过。** 本轮新增的基准夹具改动有直接依据：现有模拟模型在压缩场景固定返回纯文本 `Bench summary.`，无法驱动要求 `context_compact(propose)` 回包的候选版本。调整 `scripted` 的回包格式即可，无需修改生产逻辑或放宽基准判定。
>
> Non-blocking findings：无新增项。
>
> Follow-up：按 `7190d264a7` 对方案所列 10 个生产文件核算，当前为 **+1,081 / −291，共 1,372 行**，仍超出硬上限 172 行。正式配对性能结果和最终格式化预算均待实施阶段验收。
>
> **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R143，Git blob `95b75c20a98a4fb87de8efc5c65153cbf11ac6fb`。** 本轮只读，未修改文件、未运行测试或正式基准。此结论不放行当前实现，也不替代 §20 的实施授权。

| 轮次 | 精确版本 | 全范围 | Finding / verdict | Invocation |
| --- | --- | --- | --- | --- |
| 本轮 5（复议前） | R144 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，R144，Git blob `f35fc5380abbda3c7f61f87a2e24679be37f0e70`。** B-15 线上 Preflight 通过时，目标分支可能仍未更新。Non-blocking：§24 的实施审计占位仍写作 R143。Follow-up：+1,060 / −291，共 1,351 行。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |
| 本轮 5 复议 | R144 | 是 | No blocking findings. **B-15 撤销（Withdrawn），R144 方案通过。** §1.5 第 227 行的用户原文明确：提交后须正常 push 一次触发线上 Preflight；本次提交的 Preflight 通过即满足最终验收，可不再推送目标分支。目标分支此时可能仍未更新，这一事实判断保留，但它不再构成验收失败。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |
| 本轮 6 | R145 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，R145，Git blob `c68211dbe07e36dbe5be006f0b5370886a508e3b`。** 本次是该要求更正后的第六轮，既有额度已用完；B-16、B-17 保留为开放决定。本轮只读，未修改文件或运行测试，不放行当前实现。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |

追加的 R146 全范围方案审计（`ses_df3fcd990ffeyCFnmn0j29C7J2`）：

> No blocking findings.
>
> **R146 方案通过。B-16、B-17 均已在方案层面关闭。** 按 §1.5 的追加授权，可以实施 R146 明列的改动；剩余一次审计用于最终实现。
>
> **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R146，Git blob `776431138668e60f445baf12f90d303b5404b027`。** 本轮复用同一 Task，只读核查，未修改文件或运行测试。此结论放行方案，不放行当前实现。

第六轮 blocking findings（原文）：

> **R145：BLOCK。** 核心改动符合用户原文：宿主用 B 控制上传范围，模型提交 `(C, S)` 后按 C 写入；不比较 B 与 C，也不根据摘要文字推断边界。阻断有两处，一处在模型实际收到的指令，一处在替换测试后的验收覆盖。
>
> ### B-16 空候选时，宿主指令仍要求模型交出不可见的 ID
>
> - **Violated invariant:** R3/R4；§1.5、§10.3 明确保留“没有真实用户尾首、模型也未给 ID 时沿用 HEAD 尾部”的路径。
> - **Evidence class:** reachable
> - **Producer and execution path:** 一个用户问题加一个助手回答即可触发。Core 手动选界可以保留助手回答；`status` 只从首条消息之后的用户消息取候选，因此返回 `{"candidates":[]}`。OpenAI Chat 发送角色和正文，不发送这两条消息的数据库 ID。
> - **Source evidence:** `packages/core/src/session/compaction.ts:220–239`；`packages/llm/src/protocols/openai-chat.ts:229–232,257–264`；`packages/core/test/session-runner.test.ts:2709–2723` 的短会话夹具用不带 ID 的 `checkpointReply("Recovered summary")` 完成压缩。
> - **Canonical-plan evidence:** §10.3 第 4 步（第 381 行）允许这个回包；附录 A.2 第 816、821 行却要求模型选择第一条保留消息并提交其 ID，没有表达已经允许的无 ID 形式。
> - **Responsibility owner:** 宿主压缩共用的模型指令和工具说明。
> - **Concrete behavioral consequence:** 在上述短会话中，模型拿不到可按指令提交的有效 ID。夹具能成功，是因为它直接给出了后端接受的无 ID 回包；它没有证明模型能按这份说明作出同样的调用。
> - **Pre-R1 baseline behavior:** `e93b66f` 的 `packages/core/src/session/compaction.ts:194–201,303–312,365` 由宿主保留原尾部，短会话无需模型提供数据库 ID 即可完成压缩。
> - **Round basis:** introduced by delta。R145 改写了面向模型的宿主指令，保留了后端的无 ID 约定。
> - **Minimal correction direction:** 在同一句宿主指令中允许有可用保留 ID 时提交 ID，无可用 ID 时只提交摘要；两种情况都调用同一个 `propose`。
>
> ### B-17 重排测试文件后，超时续搜失去了可重跑的验证
>
> - **Violated invariant:** R5/I7；T4 明确要求超时返回进度，重复同一查询时不跳过剩余记录。
> - **Evidence class:** contracted
> - **Producer and execution path:** `searchArchive` 对“命中数已满”和“deadline 已到”分别判断。达到 `maxResults` 时，`expired()` 为假；对应的调用不会得到 `timedOut=true`。工具层也用 `page.timedOut` 决定是否立即把进度返回给模型。
> - **Source evidence:** `packages/core/src/session/history.ts:512–524`；`packages/opencode/src/tool/context.ts:147–175`。当前 `packages/core/test/session-history.test.ts:140–174` 用 `deadline: 0` 检查首次超时，再续扫到旧命中。
> - **Canonical-plan evidence:** §15 第 463 行要求把该测试文件恢复到 HEAD；§18 第 505 行明确新公开入口只验证“限 1 项后提高上限”，而 §16 第 481 行仍承诺验证超时续搜。
> - **Responsibility owner:** T4 的历史工具公开入口用例及其验收映射。
> - **Concrete behavioral consequence:** 即使工具在 deadline 到达后继续扫描、不向模型返回首次进度，按条数截止的新用例仍可通过。旧测试曾通过是历史证据，恢复文件后无法在最终候选上重跑该断言。
> - **Pre-R1 baseline behavior:** `e93b66f` 没有面向模型的归档续搜入口；“超时先返回、下次接着查”验证的是本次所需能力。
> - **Round basis:** introduced by delta。R145 更换第六个测试文件并撤掉原 deadline 用例。
> - **Minimal correction direction:** 在已列入六文件预算的 T4 用例中保留一次可控的 deadline 截止及续搜观测，不新增文件，不断言机器耗时。
>
> ## Non-blocking findings
>
> §16 第 485 行仍用 `marker/S/B` 描述重试成功后的窗口。当该用例中的模型选 C 时，应读作 `marker/S/C`；上传是否按 B 截短是另一项观测。§10.3 和 T2 主表已经给出了正确语义。
>
> ## Follow-up
>
> 十个任务生产文件当前为 **+1,056 / −290，共 1,346 行**，比 1,200 行上限多 146 行，与 §19 的实施前记录一致。最终格式和逐文件平均行长仍待实施验收。
>
> ## Rejected speculation
>
> 不要求 C 出现在候选列表、不要求 C 等于 B，也不检查摘要是否“像是”某个切点以前的内容。B-16 不需要新增状态、哨兵 ID 或文本兜底；B-17 不需要增加测试文件或放宽预算。
>
> ## Requirement and traceability coverage
>
> §10.3、T2 和 T3 已把**上传边界 B**与**持久化边界 C**分开：V1 用 C 写原 marker，Core 从 C 起写 `Ended.recent`。T1 保留主动提案到下一窗的观测；T4 的范围、冷记录点读和撤回仍有对应路径。B-15 维持撤销：发布终点仍是本次提交 SHA 的线上 Preflight 通过。
>
> ## Primary-path and fallback verdict
>
> 手动与 Overflow 继续共用一次请求组装、一条附加消息和一种 `propose` 成功回包。两项阻断都能在这条主路径和现有测试范围内修正。
| 1 | R132 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，R132。** Blocking: B-01、B-02、B-03、B-04、B-05、B-06。Non-blocking: N-01。 | `ses_df5d681cbffevbOPo92ZPj8dsW` |
| 1 复议 | R132 | B-03 原判复核 | **B-03 最终分类：撤销（Withdrawn）。** B-01、B-02、B-04、B-05、B-06 维持阻断。N-01 维持原分类。**R132 维持 BLOCK。** | 同一任务 |
| 2 | R133 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，精确版本 R133，Git blob `23847925c76bf2b4cedb2ec3f474b4d5878a9f73`。** 初审仅 B-07、B-08 阻断；N-02 为非阻断措辞意见。 | `ses_df5d681cbffevbOPo92ZPj8dsW` |
| 2 复议 | R133 | 沿用本轮全范围复审 | **No blocking findings.** **B-07、B-08 均改列 Follow-up。** **APPROVE — 仅限方案 R133，Git blob `23847925c76bf2b4cedb2ec3f474b4d5878a9f73`。** 这是同一轮全审后的分类复议，不另计审计轮次；生产接线仍受 §20 的实施授权门禁约束。 | 同一任务 |
| 3 | R134 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，R134，Git blob `d0c5e659dc215969d641cf6ab70b05a71366cc9b`。** B-09：V1 旧 agent 的提示与工具过滤；B-10：助手尾首不可定位；B-11：撤回测试还使用文本回包。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |
| 4 | R136 | 是 | **BLOCK — `docs/plans/cache-preserving-compaction.md`，R136，Git blob `b7fcc13be1cf9324331f3cf1b30197a057abb9b3`。** B-09、B-12 未关闭，本版不进入实施。B-10、B-11 已解决。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |
| 5 | R137 | 是 | **No blocking findings.** **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R137，Git blob `685edd310abd60de20146ca6525556e41ac3b788`。** 本轮复用同一审计任务，只读复审，未运行测试或修改文件。生产接线仍按 §20 的实施授权执行。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |
| 6 | R138 | 是 | **No blocking findings.** **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R138，Git blob `279f930c76ab07eb0c8e5cb551abc08cde50d0af`。** 本轮复用同一任务，只读审计，未运行测试、未修改文件。本结论不放行当前实现。非阻断：§24 的占位版本已更正。 | `ses_df3fcd990ffeyCFnmn0j29C7J2` |

复议范围：B-07 记录 V1 直调时插件改后的实参与完成 Part 可能不同；本版按完成 Part 提交。B-08 记录 Core 终态使用最后一次已确认的用量快照；两次请求的用量合计留作后续项。两项均维持原设计与测试范围。

### R148 完整方案审计原文

~~~~markdown
## Blocking findings

### B-21 宿主新增必填 ID 门禁，把已有默认切点路径改成失败

- **Violated invariant:** 用户要求“tailStartID 不在窗口里：改用宿主默认切点，不报错”，并明确禁止新增未要求的限定。
- **Evidence class:** contracted
- **Producer and execution path:** 模型返回 `context_compact({operation:"propose", summary:"有效摘要"})`。现有工具 Schema 允许省略 `tailStartID`；Core 和 V1 宿主消费者均已有省略 ID 时使用默认切点的路径。R148 在接收摘要前新增“ID 必须为字符串”的条件，将该回包归为未提交。
- **Source evidence:** `packages/core/src/session/compaction.ts:103–108,429–432`；`packages/opencode/src/session/compaction.ts:600–604`；现有真实压缩用例包含这种回包：`packages/core/test/session-runner.test.ts:3258–3268`、`packages/opencode/test/session/compaction.test.ts:2400–2425`。隔离原型也明确新增了该门禁：`D:\Temp\opencode\compaction-r148-retry-probe.ts:22–24,42`。
- **Canonical-plan evidence:** §1.6 第331行将缺失参数与“窗口外字符串 ID”区别处理；§9.1 第436行要求 ID 字符串；§10.3 第471行规定缺失参数重试；§16 第584行要求把原省略 ID 的成功夹具改成显式或窗口外 ID。
- **Responsibility owner:** 两代宿主维护流的提案接收与默认切点处理。
- **Concrete behavioral consequence:** 已有非空工具摘要被丢弃，最多重复九次请求，最终自动压缩返回未压缩，手动压缩失败。修改成功夹具会同时移除对原默认切点行为的验证。
- **Pre-R1 baseline behavior on the same path:** 宿主自行选界，模型只提供摘要，保留范围不依赖模型提供数据库 ID。当前工具化路径仍保留这一默认切点能力。
- **Round basis (later rounds):** introduced by delta。必填字符串门禁及对应夹具替换是 R148 新增决定。
- **Minimal correction direction:** 保留宿主已有的省略 ID 使用默认切点路径，撤掉新增必填门禁及为它改写成功夹具的要求，主动工具的 ID 校验保持原样。

### B-22 V1 的父模型一致性承诺缺少可执行接线

- **Violated invariant:** §1.6、I9 明确要求自动／Overflow 且父请求已开放 `context_compact` 时，维护请求的 **model 与父请求完全一致**。
- **Evidence class:** reachable
- **Producer and execution path:** 用户可配置 `agent.compaction.model` 为不同于工作模型的模型。普通工作请求发生自动压缩后进入 `compaction.run`；维护入口仍优先解析该独立压缩模型，并把它写入 `StreamInput.model`。计划新增的 parent 数据只有 user、system、tools、toolChoice 和消息前缀，无法承接父请求实际模型。
- **Source evidence:** 配置生产者为 `packages/opencode/src/agent/agent.ts:366–383`；调用链为 `packages/opencode/src/session/prompt.ts:2393–2406`；独立选模和请求消费分别位于 `packages/opencode/src/session/compaction.ts:446–449,539–549`。
- **Canonical-plan evidence:** §7 第404行及§10.3 第470行承诺保留父 model；§9.1 第433行、§15 第553–554行没有模型接线；§6 第387行自行加入了“且同模型”的前提；§22 第765行又明确保留 compaction 模型配置。
- **Responsibility owner:** V1 宿主维护请求的选模与组装入口。
- **Concrete behavioral consequence:** 在受支持的独立压缩模型配置下，即使父请求已经开放工具，维护请求仍使用另一模型，直接违反此次明确要求的前缀友好不变量。
- **Pre-R1 baseline behavior on the same path:** 独立 compaction 模型配置原本有效；固定基线同样优先采用它。本项阻断依据是此次新增的父模型一致性要求，涉及的执行链已经由现有配置入口证明。
- **Round basis (later rounds):** strict class，用户明确要求的场景无法满足；同时涉及 R148 新增的 I9。
- **Minimal correction direction:** 在现有维护请求入口落实父模型复用，并解决它与保留独立压缩选模之间的合同冲突，不把“同模型”追加为用户未给出的放行前提。

## Non-blocking findings

- 基准夹具目前按旧指令结尾识别工具压缩：`script/guard/bench/workload.ts:35`。附录 A.2 已更换首句，实施时须同步完成§15 已列出的回包适配，否则该夹具仍返回普通文本；无需改变工作量或阈值。
- §20 第720行仍保留上一批 R146 审计额度的执行性措辞；第724行和§1.6 已给出当前额度，可作为记录更正处理。

## Follow-up

本轮独立核算当前任务代码：

- 生产 **10 文件，新增893行、删除296行，合计1,189行**。
- 测试及基准仍为 **6 文件**。
- 任务路径的 `git diff --check HEAD` 通过。
- R148 最终格式化预算、实现测试及同 SHA 的线上 Preflight，继续留在实施验收阶段。

§18 的隔离脚本已直接核对；本轮采用源码、测试和只读 Git 检查，未独立重跑其中的实验结果。

## Rejected speculation

- 不要求 C 等于推荐切点、属于候选集合或具有特定消息角色。
- 不增加 finish 白名单、调用方绑定、历史引用签名、权限接线或第二套摘要协议。
- 保留 Core `blocks` 有直接依据：系统消息转换会丢失持久 ID，助手消息还存在零输出和一对多展开，见 `packages/core/src/session/runner/to-llm-message.ts:145–172`。可选删除不构成放行要求。

## Requirement and traceability coverage

| 范围 | 核查结论 |
|---|---|
| 两个工具、四个操作、直接与 execute 调用 | 注册、执行和完成 Part 到提交入口已有对应路径及 T1/T4 |
| 主动提案与结算后尾部 | Core 重读结算后活动窗、V1 复用已加载工具 Part，责任归属一致 |
| B-19 空摘要边界 | 用已有 `hasText` 修正发布点，能覆盖原先丢弃文本后仍发布成功 finish 的首个偏离 |
| B-20 失败工作步提交 | 复用 `stepSettlement`、退出状态及 `hasProviderError`，方案修正对应原失败链 |
| 父请求、插件文字、工具定义与 toolChoice | 已映射到请求组装及测试；模型一致性仍受 B-22 阻断 |
| 八次重试、默认切点、耗尽和取消 | 主路径已列明；新增必填 ID 门禁受 B-21 阻断 |
| 历史检索、续搜、ref/read、UTF-16、冷态 | 已核对真实工具用例、共同正文展开及只读恢复路径 |
| 单次 cold_ref 缓存 | 缓存归属与重复解压调用链吻合，不跨查询、不缓存读取错误 |
| 文件、Schema、权限和传输边界 | 计划继续限定十个生产文件、六个测试文件，保留现有公共边界 |

## Primary-path and fallback verdict

主动提交和宿主生成继续汇入同代既有 checkpoint 收尾；普通文本不作为摘要。八次逻辑重试及窗口外 ID 使用默认切点均有用户明确授权。

B-21 可通过删除新增限制解决；B-22 应在现有维护请求组装点解决。两项都不需要新增状态机或备用摘要路径。

## Code quality verdict

本轮为方案审计。B-21 的新增门禁未通过反向需求追踪；B-22 的不变量尚未对应到完整执行接线。当前实现的格式、类型、测试与发布门禁仍须由后续实现审计确认。

## Release verdict

**BLOCK — 仅针对 `docs/plans/cache-preserving-compaction.md` 的 R148，内容标识 `ec0bff795e368bfebd218eee677b852ff7dff03e`。**

修订后需对完整方案复审；当前实现不由本轮放行。
~~~~

Task: `ses_dea04ff22ffeZAQ2pXP4l6DhZ8`；完整方案审计，尚未放行实施。

### R149 完整方案复审原文

~~~~markdown
## Blocking findings

No blocking findings.

**B-21、B-22 均已在 R149 方案层面关闭。**

- **B-21：** 宿主 `tailStartID` 保持可选；省略或窗口外 ID 均复用原默认切点，原省略 ID 的成功夹具保留。对应 `docs/plans/cache-preserving-compaction.md:331,442,477,590`。修订后的隔离原型已撤掉必填 ID 门禁，与现有消费者的默认切点路径一致。
- **B-22：** V1 parent 明确传递工作请求的实际 model；父请求已开放 compact 时直接复用，其他入口保留原配置选模。“同模型”前提已删除。接口、调用点、请求组装和测试均有对应安排，见 `docs/plans/cache-preserving-compaction.md:393,439,476,559–560,590`。

## Non-blocking findings

无新增项。

上轮审计额度记录已更正；基准夹具同步新指令识别已写入 R149 Revision Delta，工作量与阈值保持不变。

## Follow-up

本轮重新核算当前任务工作树：

- 生产 **10 文件，新增893行、删除296行，合计1,189行**。
- 测试及基准 **6 文件**。
- 任务路径的 `git diff --check HEAD` 通过。

R149 实施后的最终格式化预算、测试、类型检查、独立实施审计及同 SHA 的线上 Preflight，仍按计划验收。当前数字是实施前工作树测量。

## Rejected speculation

不追加切点角色、候选成员资格、推荐 ID 相等、finish 白名单、引用绑定或权限接线要求。

保留 Core `blocks` 仍有实际转换路径依据；本轮没有发现需要扩大文件范围或增加状态机的理由。

## Requirement and traceability coverage

本轮覆盖原始需求、完整现行设计、十个生产区域及直接消费者、六个测试／基准路径，并核对 R148→R149 的修订。

| 范围 | 结论 |
|---|---|
| 两个独立工具、四个操作、直接与 execute 调用 | 注册、执行、完成 Part 和 T1/T4 的映射保留 |
| 主动提案提交 | Core 结算后窗口、V1 已加载工具 Part、原 checkpoint 收尾一致 |
| 空摘要与失败工作步 | `hasText` 源头修正及既有结算／错误状态判断继续覆盖 B-19/B-20 |
| 父请求一致性 | user、实际 model、system、工具定义及顺序、toolChoice 均有明确接线与验证 |
| 宿主维护流 | 首次强制措辞、完整 status、插件末条追加、八次逻辑重试、默认切点及取消行为均有对应路径 |
| 历史检索 | session/global、续搜、ref/read、UTF-16 对齐、只读冷态继续由原定入口承担 |
| 冷包预筛缓存 | 单次 `searchArchive` 内按 `cold_ref` 复用布尔结果，错误不缓存为阴性 |
| 范围与预算 | 文件上限、生产增删上限、Schema、权限和传输边界保持 |

已直接核对修订后的隔离原型及对应现有测试；本轮未独立重跑测试，方案中的实验记录不作为最终实现通过记录。

## Primary-path and fallback verdict

主路径保持一致：主动工具或宿主维护流提供摘要，随后进入同代既有 checkpoint 收尾。

省略 ID 沿用既有默认切点；窗口外 ID 的默认切点处理和八次逻辑重试均有用户明确要求。R149 通过撤掉必填门禁、复用父模型解决阻断，没有增加第二套摘要协议或失败后的备用生成器。

## Code quality verdict

方案层面的职责、接口和复杂度检查通过。此次修订减少一项额外限制，模型传递集中在既有维护入口，文件范围保持不变。

实际实现的格式、类型、测试和最终预算由实施审计确认。

## Release verdict

**APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md` 的 R149，内容标识 `e0607f41c3b8e35fd61c636b19093b5e903355ff`。**

本轮为完整方案复审。此结论放行该精确方案版本；最终实现仍须完成独立实施审计及同 SHA 的线上 Preflight 验收。
~~~~

Task: `ses_dea04ff22ffeZAQ2pXP4l6DhZ8`。本次新增方案复审额度已使用；当时保留的一次完整实施审计现已在§24调用。

## 23. 实施证据

### R152 完整方案复审原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。Audit mode: plan；完整原始范围。

````markdown
## Blocking findings

No blocking findings.

**B-26 在 R152 中关闭。** §1.9 已记录用户原文“这本身是测试修正，不包含在文件要求内”。本批既有测试修正获得明确授权，仍保持不新增测试和测试文件的限制。

## Non-blocking findings

无新增项。

`effect-flock` 的实际等待调用显式传入 `5_000`，覆盖了函数默认的 `3_000`。计划修改该调用为 `15_000`，能落实用户要求；对应证据为 `packages/core/test/util/effect-flock.test.ts:92,431,450`。

## Follow-up

- 实施后去掉替换 preload，运行原定点用例，并通过 `bun run test` 确认包脚本自身提供30秒时限。
- native transport 的线上失败归因仍未确认，后续按原断言和线上结果验收。
- 完整实施审计及新 SHA 的线上 Preflight、相关 Core/Guard 和 HttpApi effect 检查仍须完成。
- 本轮用完此前追加的六次完整审计额度；后续实施审计需要追加授权。

## Rejected speculation

- 不把 native transport 失败归因于前例超时污染。
- 不修改生产锁时限、轮询、清理逻辑或会话运行逻辑。
- 不增加延迟夹具、压力循环、污染断言或新的测试场景。
- 不修改 `affected.ts`、CI 配置或既有成功断言。

## Requirement and traceability coverage

本轮覆盖完整原始需求、R152、保留的生产路径及本批三处既有验证修正。原17个实现文件的内容标识均与上一轮批准实现一致。

| 范围 | 核查结论 |
|---|---|
| 双工具、压缩提交、宿主维护及历史检索 | 完整设计保持，生产仍10文件、1,201行 |
| HTTP summarize 夹具 | 保留原摘要和断言，首份回复通过既有 `TestLLMServer.tool` 提交；前轮独立红绿验证继续适用 |
| Core 测试脚本 | `packages/core/package.json:12` 当前缺少 timeout；目标命令符合 `script/guard/affected.ts:70` 的既有格式检查，gate 会沿用包脚本参数 |
| 锁测试等待 | 仅将 crashed-owner 用例的实际 ready 等待改为15秒，整体30秒上限及恢复断言保持 |
| 文件范围 | 既有测试修正按§1.9获得豁免；无新增测试、测试文件或生产改动 |
| 不确定归因 | 计划保留 native transport 的未确认状态，没有据此增加生产修补 |

本轮独立执行：

- 两个既有 runner 用例，命令行使用目标30秒时限：**2通过、19个断言**。
- crashed-owner 用例，隔离替换实际等待参数为15秒：**1通过、2个断言**。
- Canonical plan 的 diff 空白检查：通过。

这些结果验证本地可行性；慢宿主上的最终表现继续由线上检查确认。

## Primary-path and fallback verdict

主路径通过。HTTP 夹具使用已批准的工具摘要协议；测试时限在测试配置和具体测试调用处调整。生产执行路径、错误处理和持久化边界保持原样，没有新增备用成功路径。

## Code quality verdict

方案层面的职责、接口和改动范围检查通过：

- HTTP 场景复用现有服务值，保持 DSL 和 runner 接口。
- Core 脚本与锁等待各改一行。
- 格式检查限定新增语句，避免重排整份旧场景数组。

实际格式、类型和最终 diff 由实施审计确认。

## Release verdict

**APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md` 的 R152。**

精确内容标识：`3f347ea4fb11601f1cf6e02c7a1bbe8ff52c13ba`。

本轮完整方案复审通过；最终实现仍须取得完整实施审计批准及对应 SHA 的线上验收结果。
````

### R151 完整方案审计原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。Audit mode: plan；完整原始范围。

````markdown
## Blocking findings

### B-26 累计测试修改范围超过已授权的文件上限

- **Violated invariant:** 用户明确要求“测试文件修改数不超过6个”；§1.7 随后只批准增加一份指定的已有录制 JSON，当前授权累计为 **6份测试／基准代码＋1份JSON**。
- **Evidence class:** contracted
- **Producer and execution path:** R151 保留上述七个已修改文件，再修改 `test/server/httpapi-exercise/index.ts` 的场景构建和 summarize 回包，累计变为八个测试相关修改文件。
- **Source evidence:** `packages/opencode/test/server/httpapi-exercise/index.ts:62,1646–1647,2006–2011`；独立检查 `git diff --numstat 55d404f3a1 HEAD`，确认现有累计范围已包含六份测试／基准代码和一份录制 JSON。
- **Canonical-plan evidence:** `docs/plans/cache-preserving-compaction.md:211`、§1.7 第363–371行；§15 第622行和§19 第782行明确增加第七份测试代码。
- **Responsibility owner:** Canonical plan 的文件预算与范围授权。
- **Concrete behavioral consequence:** 放行 R151 会批准第八个累计测试相关修改文件，超出当前明确授权的范围。§1.8 的失败报告确认了修复需求，但尚未记录对该额外修改文件的授权。
- **Pre-R1 baseline behavior on the same path:** 固定基线的同一场景已存在，并使用两次 `llmText(summary)` 驱动当时的文本摘要协议。该文件此前未进入本任务累计修改清单。
- **Round basis (later rounds):** introduced by delta，R151 新增这一修改路径。
- **Minimal correction direction:** 保留单文件夹具适配路线，为额外修改这份既有测试代码取得明确授权并将原文记入计划。

## Non-blocking findings

无新增技术缺陷。夹具修正方向与已检查的调用链一致，能够保留生产逻辑、HTTP合同及原成功断言。

## Follow-up

实施后仍须按计划完成无 preload 的定点验证、coverage、普通 prompt 场景、类型及格式检查、完整实施审计，以及新 SHA 的 Preflight 和 HttpApi effect 线上验收。

## Rejected speculation

- 不要求修改 HTTP 返回值、生产压缩逻辑或成功判定。
- 不增加工具回包之外的摘要路径。
- 不要求扩展 `ScenarioContext`、DSL、runner 或另建模型服务。
- 不新增测试场景、断言、重试次数或超时额度。

## Requirement and traceability coverage

本轮覆盖完整原始需求、R151、保留的生产设计及新增 HTTP 夹具路径。已核对原17个实现文件的内容标识，均与上一轮批准的冻结实现一致。

| 范围 | 结论 |
|---|---|
| 两工具、主动提交、宿主维护、历史检索 | 原设计及实现保持，既有审计证据继续适用 |
| HTTP summarize 失败 | 已独立复现用户报告的同一断言失败 |
| 首个偏离 | 既有夹具继续发送普通文本，当前维护消费者要求有效 `propose` |
| 修复 owner | 现有 summarize 场景的模拟模型回包 |
| 服务交付 | `main` 取得既有 `TestLLMServer`，通过场景工厂闭包使用；不扩大测试接口 |
| 原断言敏感性 | 原断言保持，隔离修正后通过 |
| 范围与预算 | 生产仍10文件、1,201行；额外测试修改路径受 B-26 阻断 |

独立执行结果：

| 检查 | 结果 |
|---|---|
| 原 wrapper，`session.summarize --mode effect` | **0通过、1失败**，精确复现 `summarize should create a summary assistant message` |
| 同一 wrapper，加载已检查的隔离原型 | **1通过、0失败**，原成功断言通过，`missing=0、extra=0` |
| 计划 diff 空白检查 | 通过 |

## Primary-path and fallback verdict

技术路线符合原要求：首份模拟回复改为既有 `TestLLMServer.tool("context_compact", { operation: "propose", summary })`，继续走原宿主默认切点和持久化路径；第二份文本回复保留。

该修正集中在已有夹具，不需要扩大生产设计。当前阻断仅涉及累计修改文件的授权范围。

## Code quality verdict

方案层面的接口和职责划分可执行。场景工厂复用现有服务值，避免修改三个公共测试接口文件。正式实现的格式、类型和实际 diff 仍由后续实施审计确认。

## Release verdict

**BLOCK — 仅针对 `docs/plans/cache-preserving-compaction.md` 的 R151。**

精确内容标识：`cae82ff7fc509a472b3e54e22b43ba340e5aff80`。

修复方案已独立验证可行；补齐 B-26 所需的明确范围授权后，再对完整方案复审。
````

### R152 当前状态

已按R152修改三个既有验证文件：HttpApi index在main取得已有TestLLMServer并构建原场景数组，summarize首次回包为工具propose；core test脚本30秒；crashed-owner实际ready等待15秒。没有生产改动、新测试、断言或测试文件，原源码生产累计仍10文件、1,201行。B-26按用户说明关闭。

服务值类型使用`TestLLMServer["Service"]`；初次写作namespace式Service导致类型错误，改为现有class的关联服务类型后通过，服务实例及行为不变。

实际验证：

- packages/opencode，沿§18的PID隔离环境运行`bun script/httpapi-exercise.ts --include session.summarize --mode effect`，1通过、0失败。
- 同目录及隔离环境，`bun script/httpapi-exercise.ts --include session.prompt --mode effect`，3通过，覆盖原v2非法prompt、prompt和prompt_async场景。
- 同目录及隔离环境，`bun script/httpapi-exercise.ts --include session.summarize --mode coverage --fail-on-missing --fail-on-skip`，1通过，effectRoutes=204、missing=0、extra=0。
- packages/core，`bun run test test/session-runner.test.ts test/util/effect-flock.test.ts -t 'defaults native goal continuation to 32|recovers native transport|recovers after a crashed lock owner'`，3通过、21个原断言；实际命令打印`bun test --timeout 30000 --only-failures ...`，未追加命令行timeout。
- 两包各执行`bun typecheck`，最终均通过。
- 仓库根，`bun script/guard/check.ts --files 'packages/opencode/test/server/httpapi-exercise/index.ts,packages/core/test/util/effect-flock.test.ts,packages/core/package.json'`，规则作用域2文件，0错误、0提示。
- 项目Prettier验证新增工厂签名、3条HTTP语句及锁等待语句，11文件目标块均unchanged；原场景数组未重新排版。`git diff --check`通过。

本批两份测试代码的新增均长比值实测：HttpApi index为0.9279，effect-flock为1.1733，均小于1.2；core/package.json的test字符串按用户指定命令原样改一行。原生产累计仍1,201行。

本轮实际代码diff为三个既有文件，另更新本计划；完整累计审计覆盖10生产、8测试/基准代码、1录制JSON、1测试脚本配置及本计划，共21路径，已通过完整实施审计。接下来提交修正并运行新SHA的Preflight、推送后Guard及HttpApi effect；本地绿测不替代慢宿主线上结果。

### R150 完整方案审计原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。Audit mode: plan；完整原始范围。

````markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无新增项。R150 的 Revision Delta 与实际计划差异一致，保留了完整设计，并明确限制本轮只修改既有代码、夹具输入和录制基线。

## Follow-up

实施验收仍须完成：

- 不带隔离 preload 重跑既有 pending estimate、parent declarations 和 recorded HTTP 用例。
- 两包 `bun typecheck`、必要规则检查、最终格式化预算及完整实施审计。
- 修正提交对应 SHA 的线上 Preflight、多平台检查和正式性能验证。

当前累计生产差异经独立核算为 **10 文件、+905/−289，共1,194行**。R150 实施后的累计结果继续从 `55d404f3a1` 计算，受 **1,400行**上限约束。

## Rejected speculation

- 不追加切点角色、候选成员资格、推荐 ID 相等或摘要内容一致性检查。
- 不增加权限接线、存储字段、传输层处理、重试次数或超时额度。
- 两个现有失败用例已提供行为反馈入口，无需新增测试用例或测试文件。
- 本轮新增的 `parent.history` 引用有明确来源和消费者，不需要扩展成另一套请求准备接口。

## Requirement and traceability coverage

本轮核查覆盖原始需求、完整 R150、十个生产区域及直接消费者、六个既有测试／基准路径和获准修改的录制 JSON。

| 范围 | 核查结论 |
|---|---|
| 两工具、四操作、直接与 execute 调用 | 注册、参数验证、完成 Part 到提交入口及既有 T1/T4 映射保留 |
| 主动提案与持久化 | 沿成功工具结算进入同代 checkpoint 收尾；Core 使用结算后的活动窗口 |
| 手动、自动与 Overflow | 保留统一工具回包、父请求字段、八次逻辑重试、默认切点及原失败出口 |
| 空摘要和失败工作步 | `hasText` 发布条件、Core 结算与错误状态判断继续覆盖原修正 |
| 历史检索 | session/global、续搜、ref/read、UTF-16 对齐、冷态只读及单次冷包缓存均有对应路径 |
| R150 候选来源修正 | 在已有可见消息准备后生成候选，并按原活动窗 ID 对齐，修复隐藏正文经 excerpt 重新进入请求的问题 |
| R150 录制基线 | 只同步实际请求的工具说明和 `tools`；保持响应、严格匹配器和成功断言 |
| 最新范围限制 | 本轮新增测试、测试文件及参数化分支均为零；保留原生产文件上限 |

两项新增修正的证据已直接核对：

1. **可见消息来源。** 当前 `compaction.ts:498` 在插件转换前生成 status；转换及可见投影位于 `packages/opencode/src/session/compaction.ts:501–504`。原测试在 `packages/opencode/test/session/compaction.test.ts:1448` 拒绝隐藏正文，并在其后才发布准备信号。固定 pre-R1 基线已有该断言及转换后可见性合同。R150 在同一请求组装入口修正来源，责任归属准确。

2. **录制请求差异。** 已直接比较现有录制与捕获的实际请求，差异仅为系统工具说明和新增 `tools.context_compact`。严格比较入口见 `packages/http-recorder/src/matching.ts:25–37`；既有成功断言位于 `packages/core/test/session-runner-recorded.test.ts:172–195`。更新这一份已有 JSON 能保留原验证强度。

## Primary-path and fallback verdict

主路径通过：主动提案或宿主维护流提供工具摘要，随后进入同代既有 checkpoint 收尾。

R150 只纠正候选正文来源及录制请求基线。原 selector、上传切点、模型提交切点和持久化消费者保持原职责；没有增加备用摘要路径。`parent.history` 直接复用已处理的 `requestMsgs`，避免重跑父请求插件或重新构造工作现场。

## Code quality verdict

方案层面的职责、接口和复杂度检查通过。本轮新增设计能对应到已有失败路径，修改集中在原 owner，文件范围符合授权。

本轮依据源码、既有测试、隔离脚本、实际请求产物和只读 Git 检查完成核验；未独立重跑测试。R150 的实际格式、类型、累计预算和执行结果仍由实施审计确认。

## Release verdict

**APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md` 的 R150。**

精确内容标识：`acaf2ade9406f1054ba6f07e5b0f914472595ff2`。

本轮为完整方案复审。最终实现须取得对应的完整实施审计批准，并通过新提交 SHA 的线上 Preflight。
````

### R150 当前状态

按R150完成现有文件修正。相对fedff6c57e只改本计划、V1 compaction/prompt、已有compaction测试的两行history输入，以及已有录制JSON的一行request.body。录制数据逐字段比对，语义差异仅为messages.0.content工具说明和tools，其他字段及响应不变；未修改recorded测试源码、matcher、重试或泄漏门禁。

累计生产以55d404f3a1为基线：10文件、+912/−289＝1,201行，最高新增均长比值1.1651。原6份测试/基准代码保持，加1份已有JSON基线；R150新增测试、测试文件、断言均为零。B-25指出新增statusResult调用未纳入原格式目标，现已按项目Prettier展开并加入检查；9文件目标块再次格式化均无变化，V1 compaction覆盖4个目标块。此返工只改变排版。

实际验证均不带诊断替换preload：

- `packages/core`：`bun test --preload ../../script/guard/leak-preload.ts test/session-runner-recorded.test.ts --only-failures --timeout 5000`，1通过、0失败、5个原断言，既有泄漏检查未报错。
- `packages/opencode`：`bun test test/session/compaction.test.ts -t 'stores pending input estimate on summary assistant before streaming|keeps the parent tool declarations' --only-failures --timeout 12000`，2通过、21个原断言。
- `packages/core`及`packages/opencode`各执行`bun typecheck`，均通过。
- 仓库根：`bun script/guard/check.ts --files 'packages/opencode/src/session/compaction.ts,packages/opencode/src/session/prompt.ts,packages/opencode/test/session/compaction.test.ts'`，3文件、0错误、2个非阻断提示。
- 仓库根：`git diff --check`通过。

完整实施复审已通过，原文见§24；累计实际diff为本计划、10生产、6测试/基准代码及1已有JSON，共18路径。其他agent的guard.ts和计划不在范围。R149线上失败结果保留，接下来创建修正提交，须重新取得该SHA线上Preflight通过。

### R149 已提交版本

已按批准行为实施。用户允许的私有函数收口落在Core captureProposal/commitProposal、V1 summaryFinish/normalCompletion；不增加状态、结束原因白名单或权限接线。Core消息与blocks在同一decide分支取得，去掉重复判断并保证两者对应。原成功回执已由工具入口验证，不重复解码或检查摘要。V1的可选tailStartID同时接受显式undefined，保留原成功夹具语义；JSON工具字段仍为可选string。

冻结生产10文件，+905/−289＝1,194；生产新增均长相对完整旧文件的最大比值1.1651，新context.ts单列51.559字符/行。测试/基准仍6文件，包含测试后的最高均长比值为1.1870，全部小于1.2。V1 execute恢复回执用例和Core原断言的纯格式化已按HEAD恢复；新增/修改语句使用项目Prettier，9文件的目标块二次格式化均无变化。当前HEAD为另一agent已提交的55d404f3a1；本任务代码差异单列，不包含其TUI提交或guard.ts。

| 验证 | 结果 |
| --- | --- |
| V1父请求和插件用例，修改生产代码前实际运行 | 0通过、2失败：父请求返回stop，插件文字仍在description。 |
| `packages/core`：`bun test test/session-runner.test.ts -t 'compaction|checkpoint|context overflow|summarizes an oversized newest message' --only-failures --timeout 15000` | 11通过，172断言；包含7次原网络恢复后8次逻辑重发、主动/手动/超窗和原成功窗口。 |
| V1父请求/插件/8次重试/重试取消 | 4通过，60断言；保留原窗口、父model/user.system/toolChoice及声明。 |
| V1最早可行边界、原话、重复压缩、execute回执 | 6通过，41断言。 |
| V1真实history search/ref/read、直接与execute提案、手动队列交接 | 5通过，42断言。 |
| 本任务16个代码路径的guard/check.ts --files | 规则作用域15文件，0错误、10提示；未改门禁规则。 |
| `packages/core`：`bun typecheck` | 最终通过。 |
| `packages/opencode`：`bun typecheck` | 最终通过。此前TUI依赖缺失经授权离线安装补齐；normalCompletion提取时错误的类型谓词导致false分支收窄为never，已恢复普通布尔函数并沿原存在性检查调用，行为不变。 |
| `packages/core`：`bun test test/config/provider.test.ts test/location-layer.test.ts -t 'binds native reviewer instructions|LocationServiceMap' --only-failures --timeout 15000` | 5通过，529断言；OAuth断言未修改，仅适配维护回包。 |
| `packages/core`：`PROBE_CASE=provider PROBE_CANDIDATE=0`，`bun test --preload D:\Temp\opencode\compaction-r148-probe.ts test/session-runner.test.ts -t 'active checkpoint keeps settled sibling results' --only-failures --timeout 12000` | 最终生产代码1通过、2断言，失败工作步未替换原checkpoint；此preload仅改变测试输入和观测，未修改生产模块。 |
| scripted维护回包轻量调用 | 新强制指令得到context_compact(propose)、原Bench summary及候选ID；未执行populate、基准工作量或计时基准。 |
| `git diff --check HEAD -- <全部任务代码路径>` | 通过。 |

完整实现复审已通过，原文见§24；提交及同SHA线上Preflight待执行。候选代码冻结，后续实质修改须按workflow处理。最终审计的实际diff限定本任务17条路径（本计划、10生产、6测试/基准），冻结hunk-review、其他plan及guard.ts不提交。禁止本地重型Gate/Benchmark，跨平台与正式性能交线上Preflight。

### 实际文件和 diff
发布基线 `6dd9a5b1f3`。V1 手动助手尾首用例转绿后的测量点：本任务生产 10 个文件，+1,177/−323，增删合计 1,500 行，超出 1,200 行上限 300 行；测试 5 个文件。相对于发布基线的同十个路径还包含 `7190d264a7` 及此前已提交的 `message-v2.ts` 变更（+83/−81），原始合计 1,664 行。两种口径分别列出，不撤回他人提交，也不把这个测量点当作最终格式或预算验收。

本任务在该测量点的生产增删：Core `session/compaction.ts` 246、`session/history.ts` 328、`session/runner/llm.ts` 150、`storage/cold-store.ts` 24；V1 `session/compaction.ts` 440、`session/message-v2.ts` 13、`session/processor.ts` 49、`session/prompt.ts` 42、`tool/context.ts` 201、`tool/registry.ts` 7。

§19 停点：V1 的 402 行含删除旧 transcript 序列化 54 行、共享原 selector 和估算器约 114 行搬移。恢复前者会留下已淘汰的路径，移回后者会让工具的 status 失去原 selector。单删 `splitTurn` 估算回调的隔离对照为 402 → 404，未采用。优先收缩新请求组装和历史投影的重复工作，保留两个工具、原成功断言和 1,200 行上限。
### Red/green 与原始反馈
Core T1 最初在下一次真实工作请求读到 `Initial checkpoint`。改为从本步成功结算的 propose 取 B/S，经 `Step.Ended` 后的活动尾部提交，现已读到一次 `Current checkpoint`、原用户消息和同一步的 `SIBLING_927`，旧工作记录退出活动窗口。T3 手动缺工具的工作轮和 T4 两个会话的定点历史读回均有通过记录。T4 当前覆盖热数据与签发者/范围，不包含冷包性能证明。
### 验证命令与结果
- `packages/core`、`packages/opencode`：分别执行 `bun typecheck`，均 exit 0。
- `packages/core`：`bun test test/session-runner.test.ts -t 'active checkpoint keeps settled sibling results after a prior summary|manual compaction advertises compact only for the requested checkpoint' --only-failures --timeout 30000`：2 pass，21 个断言。
- `packages/core`：补查手动请求中的完整工具声明和稳定 system 后，`bun test test/session-runner.test.ts -t 'manual compaction advertises compact only for the requested checkpoint' --only-failures --timeout 30000` 先失败：去掉 compact 后得到空表，工作轮实际有 `goal`、`echo` 和 `defect`。沿用 `prepareTurn` 已选声明与 epoch 后，同一用例 1 pass，10 个断言。
- `packages/core`：`bun test test/session-runner.test.ts -t 'forces one compaction and retries after provider context overflow|summarizes an oversized newest message without retaining a fragment' --only-failures --timeout 30000`：更新旧文本夹具后 2 pass，17 个断言；保留原有请求次数、尾部内容、用量及重放断言。
- `packages/core`：`bun test test/session-history.test.ts -t 'archive search scopes the evidence' --only-failures --timeout 30000`：1 pass，6 个断言。
- `packages/opencode`：`bun test test/session/prompt.test.ts -t 'manual compaction stops after summarizing retained tool tail' --only-failures --timeout 30000`：1 pass，6 个断言。`bun test test/session/processor-effect.test.ts -t 'stop after token overflow requests compaction|compact on structured context overflow' --only-failures --timeout 30000`：2 pass，13 个断言。
- 仓库根 `git diff --check 6dd9a5b1f3`：通过。编辑门禁的 `cc-excess` 仍未通过。整体回归、配对性能、独立实施审计和发布均未放行。
- `packages/opencode`：`bun test test/session/prompt.test.ts -t 'completed compaction rebuilds dates without recapturing Git|auto compaction resumes without compacting retained old tail usage again' --only-failures --timeout 30000`：原纯文本夹具 2 fail；改为工具回包后 2 pass，12 个断言。日期、保留尾部、调用次数的断言不变。
- `packages/opencode`：`bun test test/session/compaction.test.ts -t 'keeps the old window until a missed checkpoint call succeeds on retry' --only-failures --timeout 30000`：1 pass，10 个断言。重试期间旧 head 和 tail 可读；两次 system、messages、tools 一致；有效提案返回后才替换 head。
- `packages/opencode`：`bun test test/session/prompt.test.ts -t 'reads a changed file from archived patch evidence using the ref returned to the model' --only-failures --timeout 30000`：1 pass，7 个断言。模型从本会话 `patch.files` 中搜到一个命中，用该 ref 读回 snippet 之外的文件名；另一会话的同词记录没有返回。
### 实际次要路径与未验证项
V1 T2 已从红转绿。32,000 输入上限下，旧实现选择 D，错误上传 `RETAIN_B`。现在同一候选 B 同时决定上传前缀和 `tail_start_id`。`packages/opencode` 下运行 `bun test test/session/compaction.test.ts --only-failures --timeout 30000`：78 pass、1 skip、0 fail，340 个断言。`prompt.test.ts` 中主动直调与 execute 子调用两例共 11 个断言通过；模型用搜索 ref 读回原文的用例 7 个断言通过。
隔离对照（未写入生产文件）：用项目的 `estimateText`、`boundarySamples` 和 `buildReplayInstructions` 测得 D 的前缀/尾部为 35,207/37，B 为 20,176/15,068。测试进程中让请求和 marker 共用 B 后，候选选择、保留尾部、漏调重试 3 个集成用例通过（24 个断言）。另一次运行覆盖可行与不可行两种输入，2 个用例通过（8 个断言）：所有候选都不可用时，零模型请求、旧窗口保留，隐藏记录维持 `ContextOverflowError`。

早期原型以完整生成器上下文格式化后，V1 `session/compaction.ts` 增删由 402 变为 431；原型总计 1,346 行。后续工作树已实现同一切点用于上传和落库，并通过上述整组测试。`ToolRegistry.node` 没有声明 `SessionCompaction.node` 依赖，压缩服务也没有公开选界方法；把 selector 留在服务内再供工具调用会改变 §9.1/§15 的接线。
实际遍历 `LayerNode.dependencies`：注册表可达 45 个节点，压缩服务可达 44 个；接入不会成环，但会为注册表增加 11 个节点（含 processor、LLM、snapshot）。即使原 selector 的 114 行搬移全部消失、新接线按零行计，该原型仍为 1,232 行。未采用服务接线。

归档分页另做隔离对照。在 500 行、3 个命中的样本中，提前关联标题会读 500 个标题，命中后批量查询只读 3 个。全局直接按正文分页读取 4,251 行正文，先限定键再关联读取 500 行，返回顺序相同。真实归档用例覆盖跨会话范围、冷热与撤回、502 条记录续扫：`packages/core` 以临时分页加载器运行 `test/session-history.test.ts` 对应三例，3 pass、21 个断言。按项目格式计算，`session/history.ts` 由 353 行变为 352 行。该路线不能弥补预算缺口，保留现有按键批量读取。`session/search.ts` 的消费者是会话列表，明确排除工具结果与 shell 输出，不能替代检索工具的正文投影。
Core 手动入口保留当前工具声明并强制 compact。此前 retained-tail 用例误要求工具表只剩下 compact；改为断言 fixture 的完整四项，保留零工具执行、摘要、尾部和原事件检查。`packages/core` 下运行 `bun test test/session-compaction.test.ts test/session-runner.test.ts -t 'compaction|checkpoint|overflow' --only-failures --timeout 30000`：17 pass、0 fail，201 个断言。归档范围、冷热与撤回、续搜和主动提交另组 4 pass、34 个断言。两包 `bun typecheck` 通过。

十个生产文件的规则检查仍有 5 项 `cc-excess`：Core compaction 31/26、history 44/16、runner 183/173；V1 processor 96/87、prompt 248/244。`message-v2.ts` 与 `tool/context.ts` 不再阻断。global 首响、正式配对性能、完整门禁及独立实施审计仍未放行。

加入 `decide` 回归后，在 `packages/core` 重跑 `bun test test/session-compaction.test.ts test/session-runner.test.ts -t 'compaction|checkpoint|overflow' --only-failures --timeout 30000`：18 例中 17 pass、1 fail，211 个断言；同一工作树的 `bun typecheck` 通过。唯一失败的是 `allows only the checkpoint proposal during decide overflow recovery`。压缩前后的工作请求均保持空工具表和 `toolChoice: none`；中间的维护请求只有 `context_compact` 且强制选择该工具，但它的 system 仍含 `# WITHOUT any tools` 和 `Decide mode is active`。该测试捕获了普通 system 请求；OAuth 的最终请求尚未实测。

原预检用 `input.request` 的 system、messages、tools 估算，随即把同一 `input` 交给 `compactAfterOverflow`；`checkpointRequest` 只覆盖 messages、tools、toolChoice。直接把调用方的 `input.request` 换成维护请求会同时改变预检对象。在未验证预算内的修复前保留这条红测和原工作轮限制。

### 归档读回

R137 的只读复核指出，旧版 `readArchive(db, ref)` 无法验证当时方案指定的工具实例身份。该要求来自 R137 的实现选择，已在 R138 撤回；这次复核不计入实施审计。

R138 已删除 `makeArchive()` 和“换工具实例必须拒读”的断言。`reference(caller, ref)` 继续校验签名、发起会话与 scope，工具在读回当前可见正文之前检查现行权限。`packages/core` 的 `bun test test/session-history.test.ts -t 'archive search scopes|frozen archive evidence|resumes an archive search' --only-failures --timeout 10000`：3 例通过、20 个断言，耗时 1.80 秒。

**最近一次验证。** Core `decide` 的禁调指令只用于工作请求。维护请求按它实际声明的工具组装指令；预检仍用原工作请求。原失败断言保留。Core runner、history、compaction 和 location 四个测试文件共 129 例通过；V1 compaction 和 processor 两个测试文件 119 例通过、1 例跳过。十个生产文件合并运行规则检查：0 个错误、10 个提示。上文的红测和 5 项复杂度错误是修复前记录。行数预算和最终实施审计仍需分别验收。

**V1 宿主请求。** 在 `packages/opencode` 运行 `bun test test/session/compaction.test.ts -t 'uses the earliest feasible cut|anchors repeated compactions|replays the prior user turn on overflow' --only-failures --timeout 15000`：3 例通过、16 个断言。修复前，超窗请求把截短历史的 D 写进 status；现在 status 列出完整活动窗的 B、C、E，上传和落库仍选 B。

**归档工具首响（合成热数据）。** 在 `packages/opencode` 用 Bun 内存 SQLite 建立 32 个会话、16,000 条 V1 和 16,000 条原生消息，设 `PRAGMA query_only=ON` 后调用实际 `ContextHistory`。同会话命中和无命中分别为 35 ms、99 ms，均未读标题。global 命中 3 条为 17 ms，只发出一次带 3 个 ID 的标题查询；global 阴性扫完 32,000 条为 1,093 ms，未读标题。四次均无读取错误。该测量不覆盖真实冷库和正式 Preflight A/B。

**Core OAuth 请求体。** 在 `packages/core` 运行 `bun test --preload D:/Temp/opencode/r138-verify-oauth-wire-20f68e.ts test/session-runner.test.ts -t 'R138 synthetic OAuth decide overflow wire' --only-failures --timeout 15000`：1 例通过、15 个断言。临时夹具只替换测试的模型选择，并调用 Responses 协议生成实际 runner 三个请求的正文。压缩前后工作请求均为 `tool_choice: none`；维护请求的 `instructions` 包含会话基线，只指定 `context_compact`，续跑正文包含提交的摘要。未使用真实凭据或外部网络。

**R139 待审期间的预算核算。** 撤回前，相对 `HEAD 7190d264a7` 的十个生产文件为 +1,178/−323，共 1,501 行。这是历史测量点，不作为最终预算验收。

**R142 历史工具验证。** 在 `packages/opencode/src/tool/context.ts` 删除 `read` 失败时清理 `scans` 的 5 行回调。`read` 的错误原样返回，`scans` 的 get/set/delete 只在 `search` 分支。`packages/core` 运行 `bun test test/session-history.test.ts -t 'archive search scopes|reads frozen archive evidence|resumes an archive search' --only-failures --timeout 10000`：3 通过，18 个断言。`packages/opencode` 运行 `bun test test/session/prompt.test.ts -t 'reads a changed file from archived patch evidence' --only-failures --timeout 20000`：1 通过，7 个断言。沿用既有测试，未增加接口或测试文件。

## 24. 实施审计

### R152 完整实施审计原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。Audit mode: implementation；完整原始范围。记录verdict和verified状态不改变已冻结代码。

````markdown
## Blocking findings

No blocking findings.

本次实现与批准方案 R152 一致，三处既有测试修正均已完成，原成功断言保持不变。

## Non-blocking findings

无新增项。此前已记录的录制 JSON 换行差异保持不变。

## Follow-up

- 新提交 SHA 的 Preflight、推送后 Guard/Core 检查及 HttpApi effect 线上验收仍须完成。
- native transport 的线上失败归因仍未确认；本轮原用例已通过，最终以相关线上结果验收。
- 全量测试和 Benchmark 继续在线上执行。

## Rejected speculation

- 不把 native transport 失败认定为前例超时污染。
- 不增加测试场景、断言、测试文件或运行时恢复逻辑。
- 不修改生产锁时限、轮询、清理逻辑、HTTP合同或CI配置。
- 不要求改写既有测试 DSL、runner 或其服务接口。

## Requirement and traceability coverage

已核对完整原始需求、批准方案 R152、全部21条累计任务路径及直接消费者。原17个实现文件与前次批准版本一致；本批新增修改路径仅为计划指定的三个既有文件。

| 范围 | 核查结论 |
|---|---|
| 双工具、压缩提交、宿主维护及历史检索 | 原生产实现保持 |
| HTTP summarize | `index.ts:1646–1649` 使用既有工具回包提交原摘要；后续文本回复和成功断言保持 |
| 场景服务交付 | `index.ts:62,2011–2012` 从现有服务层取得同一个服务值并构建原数组，其他场景定义保持 |
| Core 测试时限 | `packages/core/package.json:12` 已采用用户指定的完整命令 |
| 锁 ready 等待 | `effect-flock.test.ts:431` 改为15秒，原30秒整体上限及恢复断言保持 |
| 范围约束 | 无新增测试、断言或测试文件；既有测试修正按用户授权执行 |

## Primary-path and fallback verdict

主路径通过。HTTP 夹具沿既有 `context_compact(propose)` 协议完成摘要；时限调整分别位于包测试脚本和具体测试调用处。

本批未改变生产执行、错误处理或持久化路径，没有新增备用成功路径。

## Code quality verdict

**通过。** 本轮独立执行结果：

| 检查 | 结果 |
|---|---|
| 无替换 preload 的 HTTP summarize | 1通过 |
| 既有 prompt 相关 HTTP 场景 | 3通过 |
| HTTP coverage 检查 | 204条路由，missing=0、extra=0 |
| 通过包脚本运行三个 Core 定点用例 | 3通过、21断言；实际命令自带30秒时限 |
| 两包 `bun typecheck` | 均通过 |
| 本批 Guard | 0错误、0提示 |
| 11文件目标块及新增工厂签名的只读格式检查 | 通过 |
| 累计 diff 空白检查 | 通过 |
| 冻结内容核对 | 21个路径全部一致；重新生成的完整实际 diff 哈希与送审 patch 相同 |

累计生产仍为 **10文件、+912/−289，共1,201行**，低于1,400行上限。本批两份测试代码的新增均长比值分别约为 **0.9278** 和 **1.1732**，均低于1.2。

## Release verdict

**APPROVE — 仅限批准方案 R152 对应的本次冻结实现。**

- 累计比较基线：`55d404f3a1e07f8f1c2015c1df4be949c6975c94`
- 实现 patch：`D:\Temp\opencode\compaction-r152-implementation.patch`
- 精确内容标识：`f5a2ada782112edfcf9cef1d0f43d31a792ff247`

本轮完整实施审计通过。最终交付仍以新提交 SHA 的相关线上验收通过为准。
````

### R150 完整实施审计原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。本轮先完成只读核查；主助手补充此前已有的必要Gate及六次审计授权原文后，继续同一轮执行验证。Audit mode: implementation，完整原始范围，patch `0469cdafffe8257f4c98181128fecd1bc2ed7bd2`。

````markdown
## Blocking findings

### B-25 新增候选调用未通过明确要求的格式化门禁

- **Violated invariant:** I8；用户要求新增和修改的代码得到格式化，§17 要求按项目 Prettier 格式化完整语句。
- **Evidence class:** observed
- **Producer and execution path:** V1 维护入口取得已处理的可见消息，按原活动窗 ID 筛选后调用 `statusResult`。R150 新增的这条调用仍保留为未格式化的单行。
- **Source evidence:** `packages/opencode/src/session/compaction.ts:512`。只读检查该新增语句时返回 `Formatting differs`；直接用仓库 Prettier 格式化同一语句，也将其展开为四行。
- **Canonical-plan evidence:** §1.5 的格式化要求；§17 第630–632行；§23 第1154行关于新增短语句符合项目格式的记录。
- **Responsibility owner:** V1 compaction 新增语句及其格式检查范围。
- **Concrete behavioral consequence:** 当前 patch 未满足用户明确的格式化交付条件。原九文件检查通过，但其目标列表未覆盖这条新增调用，不能证明该语句已通过门禁。
- **Pre-R1 baseline behavior on the same path:** 基线没有这条候选调用；问题来自本次新增语句，与旧文件的历史排版无关。
- **Round basis (later rounds):** introduced by delta，R150 新增了包含 `visible.filter(...)` 的调用。
- **Minimal correction direction:** 仅按仓库 Prettier 格式化这条新增调用，保持逻辑、文件范围和测试不变。

## Non-blocking findings

录制 JSON 的整文件 `prettier --check` 因工作区 **CRLF** 返回失败。逐行比较确认，归一为 LF 后与 Prettier 输出一致；Git 显示 `i/lf w/crlf`，审前原文件也存在相同换行差异。此项不要求改写夹具的其他内容。

## Follow-up

修正提交对应 SHA 的线上 Preflight、多平台检查及正式性能验证仍须完成，继续按用户要求在线上执行。

B-25 修正后需要对新冻结 patch 完整实施复审；当前批准方案仍为 R150。

## Rejected speculation

- 不新增测试、测试文件、参数化分支、重试次数或超时额度。
- 不追加切点角色、候选成员资格、推荐 ID 相等或摘要内容一致性检查。
- 不扩展权限、存储 Schema、传输层或备用摘要协议。
- B-25 只涉及已明确要求的机械格式化，不要求提取函数或改变设计。

## Requirement and traceability coverage

已完成原始需求、批准方案 R150、全部18条任务路径的累计 diff 及直接消费者核查。验证结束后，18个路径仍与冻结 patch 的内容标识一致。

| 范围 | 核查结论 |
|---|---|
| 两工具、四操作、直接与 execute 调用 | 注册、执行、完成 Part 和提交路径保持 |
| 主动提案与成功边界 | 继续使用成功工具结算、Core 结算后窗口及既有持久化收尾 |
| 宿主维护请求 | 父请求字段、统一工具回包、八次逻辑重试和默认切点符合方案 |
| R150 可见消息修正 | `parent.history` 复用 `requestMsgs`；候选在可见投影后按原窗口生成，原失败用例通过 |
| R150 录制基线 | 语义差异仅为系统工具说明和 `tools.context_compact`；响应、匹配器及成功断言保持 |
| 历史检索 | session/global、续搜、ref/read、UTF-16 和只读冷态的现有公开入口用例通过 |
| 最新范围限制 | R150 未新增测试、测试文件或断言；父请求夹具只补两行输入 |
| 文件与行数 | 生产10文件，累计1,198行；测试相关为原6份代码及1份已有JSON |

## Primary-path and fallback verdict

行为主路径符合 R150：主动提案或宿主维护流取得工具摘要后，进入同代既有 checkpoint 收尾。

本次可见消息修正落在请求组装入口，复用已有消息引用和候选生产者。没有增加第二套选界算法、备用摘要路径或失败后的伪成功结果。

## Code quality verdict

**未通过，唯一阻断为 B-25。** 独立执行结果如下：

| 检查 | 结果 |
|---|---|
| recorded HTTP，带既有泄漏检查 | 1通过，5断言 |
| V1 可见性与父请求用例 | 2通过，21断言 |
| V1 选界、重复压缩及原编排用例 | 7通过，49断言 |
| Core 主动提交、重试及 Overflow | 5通过，74断言 |
| V1 直接／execute 提案及历史读回 | 3通过，27断言 |
| 两包 `bun typecheck` | 均通过 |
| 全任务代码 Guard | 0错误、9个非阻断提示 |
| 原九文件目标块只读格式检查 | 通过 |
| 新增 `context.ts` Prettier | 通过 |
| R150 新增候选调用格式检查 | **失败，见 B-25** |
| 累计任务 diff 的空白检查 | 通过 |

合计 **18个定点用例通过，176个断言**。

独立预算核算：生产 **+909/−289＝1,198行**；生产新增均长比值最高约 **1.1650**，包含测试后最高约 **1.1870**，均低于 **1.2**。

## Release verdict

**BLOCK — 对应批准方案 R150，累计比较基线 `55d404f3a1e07f8f1c2015c1df4be949c6975c94`，冻结实现 patch 标识 `0469cdafffe8257f4c98181128fecd1bc2ed7bd2`。**

行为定点验证已通过；B-25 修正并完成完整实施复审后，才能放行该实现。
````

B-25返工：仅将statusResult调用按Prettier展开四行，并将该语句纳入现有格式检查脚本；重跑9文件目标块均unchanged，V1 compaction为4块。累计生产变为1,201行；无逻辑、测试或文件范围变化，待完整复审。

### R150 完整实施复审原文

Task: `ses_de89ac459ffeR45R69Shoerh6v`。Audit mode: implementation；完整原始范围。此记录和verified状态为审计后的行政更新，源码、测试和录制数据保持冻结内容。

````markdown
## Blocking findings

No blocking findings.

**B-25 已关闭。** `packages/opencode/src/session/compaction.ts:512–515` 已按项目 Prettier 展开，新增调用已纳入格式检查。本轮独立执行的只读格式检查通过，参数、筛选条件和调用顺序保持不变。

## Non-blocking findings

无新增项。

录制 JSON 的工作区 CRLF 差异维持上一轮的非阻断分类：LF 归一后的内容与 Prettier 输出一致，本轮未改动该文件。

## Follow-up

最终交付仍须取得修正提交对应 SHA 的线上 Preflight 通过，包括多平台检查和正式性能验证。

## Rejected speculation

- 不增加测试、测试文件、参数化分支或新的运行时限制。
- 不扩展权限、存储 Schema、传输层和备用摘要协议。
- B-25 已通过原语句格式化解决，无需提取函数或调整设计。

## Requirement and traceability coverage

本轮按完整原始需求复审 R150 及全部18条累计任务路径，并直接比较两份冻结 patch。生产代码的唯一返工是 `statusResult` 调用的格式化；其余生产文件、测试及录制内容均保持不变。

| 范围 | 结论 |
|---|---|
| 两工具、四操作、直接与 execute 调用 | 注册、执行、完成 Part 和提交路径保持 |
| 主动提案及成功边界 | 成功结算、结算后活动窗口及原持久化收尾保持 |
| 宿主维护请求 | 父请求字段、工具回包、八次逻辑重试和默认切点符合批准方案 |
| 可见消息来源 | 继续复用 `requestMsgs`，在可见投影后按原活动窗生成候选 |
| 历史检索 | session/global、续搜、ref/read、UTF-16 和只读冷态路径保持 |
| 录制基线与最新范围限制 | 既有录制响应、严格匹配器和成功断言保持；返工未新增测试或断言 |
| B-25 | 新增调用已通过独立格式检查 |

## Primary-path and fallback verdict

主路径符合批准方案：主动提案或宿主维护流取得工具摘要后，进入同代既有 checkpoint 收尾。

本轮返工只改变排版，没有新增状态、分支、选界算法或备用成功路径。

## Code quality verdict

**通过。**

| 本轮独立检查 | 结果 |
|---|---|
| 九文件目标块只读格式检查 | 全部通过，V1 compaction 覆盖4个目标块 |
| V1 可见性与父请求定点用例 | 2通过，21断言 |
| 两包 `bun typecheck` | 均通过 |
| 全任务代码 Guard | 0错误、9个非阻断提示 |
| 累计 diff 空白检查 | 通过 |
| 冻结 patch 与工作树内容核对 | 18个路径全部一致 |

上一轮独立完成的 **18个定点用例、176个断言**继续适用；本轮另行复跑了上述两个用例。

最终累计预算为：

- 生产 **10文件，+912/−289，共1,201行**，低于1,400行上限。
- 测试相关为原 **6份测试／基准代码，加1份已有JSON**。
- 可比较生产文件的新增均长比值最高约 **1.1650**；包含测试后最高约 **1.1870**，均低于1.2。

## Release verdict

**APPROVE — 仅限批准方案 R150 对应的本次冻结实现。**

- 累计比较基线：`55d404f3a1e07f8f1c2015c1df4be949c6975c94`
- 实现 patch：`D:\Temp\opencode\compaction-r150-implementation-r2.patch`
- 精确内容标识：`b3a29e7dbe88e5ad738451808e90edb270d457a8`

本轮完整实施复审通过。最终交付仍以修正提交对应 SHA 的线上 Preflight 通过为准。
````

### R149 完整实施审计原文

Task: `ses_dea04ff22ffeZAQ2pXP4l6DhZ8`。Audit mode: implementation；覆盖完整原始范围。审计对象为HEAD `55d404f3a1e07f8f1c2015c1df4be949c6975c94`上的17路径冻结patch，blob `47bd47a7cf4aeac451989ca11005ca1e90603621`。

````markdown
## Blocking findings

### B-23 V1 成功处理器夹具未适配提案交付，已有编排测试会返回 stop

- **Violated invariant:** 保留既有成功行为和断言；摘要协议变化所需的夹具必须同步适配，相关回归应通过。
- **Evidence class:** reachable
- **Producer and execution path:** `withCompaction()` 默认使用 `processorLayer("continue")`。其 `fake().process()` 只设置 `msg.finish` 并返回 `continue`，从不调用新增的 `onTail`。生产维护循环因此始终得不到 `checkpoint`，九次尝试后进入手动失败出口，返回 `stop`。
- **Source evidence:** `packages/opencode/test/session/compaction.test.ts:224–250,309–312`；`packages/opencode/src/session/compaction.ts:595–610`；既有测试在 `packages/opencode/test/session/compaction.test.ts:2360–2389` 明确要求返回 `continue`。
- **Canonical-plan evidence:** §15 要求只适配必要夹具；§16 要求保留原成功断言；§18 将 `test/session/compaction.test.ts` 列入回归验证。
- **Responsibility owner:** V1 compaction 测试的共享成功处理器夹具。
- **Concrete behavioral consequence:** `runs compaction as a completed boundary without a runnable task` 的成功断言与当前执行链冲突。只给假助手设置 `finish` 无法满足新的提案交付合同。当前报告的定点成功用例没有覆盖这个默认夹具路径。
- **Pre-R1 baseline behavior on the same path:** 已直接核对固定基线 `e93b66f`：同名测试及 `continue` 断言已存在，原处理器夹具返回 `continue`，原压缩入口据此完成收尾。
- **Round basis (later rounds):** strict class，本次协议变更使既有回归测试的成功路径失效。
- **Minimal correction direction:** 将共享成功夹具适配到已批准的提案交付接口，保留原成功断言并验证受影响的编排用例，生产成功判定保持不变。

本项由源码执行链证明，尚未独立运行。最窄复现命令：

```powershell
# cwd: packages/opencode
bun test test/session/compaction.test.ts -t "runs compaction as a completed boundary without a runnable task" --only-failures --timeout 15000
```

### B-24 测试仍保留用户明确要求撤回的等价改写

- **Violated invariant:** §1.6 明确要求撤回测试中的纯格式化和等价改写；只更新摘要请求形态变化所必需的夹具。
- **Evidence class:** observed
- **Producer and execution path:** split-turn 测试的原 `reply("summary", capture)` 调用被展开，并额外传入 `-1`；`reply` 的默认参数本来就是 `pick = -1`，捕获回调的返回值也未被使用。
- **Source evidence:** `packages/opencode/test/session/compaction.test.ts:364–375,1970–1974`；冻结 patch 的第3745–3754行保留了原调用与改写后的直接对照。
- **Canonical-plan evidence:** §1.6 第10项；§16“撤回纯格式化”；§17 保持改动范围克制。
- **Responsibility owner:** V1 compaction 测试夹具调用处。
- **Concrete behavioral consequence:** 该 hunk 没有改变响应、捕获内容或断言，却保留了用户要求撤回的额外测试差异，未满足明确的范围约束。它也不属于获准的生产私有函数整理。
- **Pre-R1 baseline behavior on the same path:** 原调用已完成相同的消息捕获；恢复原调用仍会使用新的工具回包 helper。
- **Round basis (later rounds):** strict class，明确的撤回要求尚未落实。
- **Minimal correction direction:** 恢复该调用处的原写法，保留共享 `reply` 的必要协议适配和本用例真正受请求形态影响的断言。

## Non-blocking findings

计划第353行仍写当前实测为 **1,198行**，§23 与本轮独立核算均为 **1,194行**。这是记录更正项，不影响预算结论。

## Follow-up

本轮已完成全部任务代码 diff hunk 的只读核查，并核对冻结 patch 中17个路径的内容标识与工作树一致。

独立核算结果：

- 生产 **10文件，新增905行、删除289行，合计1,194行**，同时低于原1,200行和更新后的1,400行上限。
- 测试及基准 **6文件**。
- 全部任务代码路径的 `git diff --check HEAD` 通过。

定点测试和两包 `bun typecheck` 的独立复跑授权尚未收到，本轮未执行这些命令。计划中的成功记录仍是待核验的执行证据。正式跨平台检查、性能测试和同 SHA 的 Preflight 继续按既定线上流程验收。

## Rejected speculation

- 不增加 ID 必填、切点角色、候选成员资格或推荐切点相等检查。
- 不要求修改权限、存储 Schema、传输层或增加备用摘要协议。
- B-23 的修复归测试夹具，不需要让生产代码把“仅返回 continue”视为成功提案。
- 私有函数整理保持原判断条件；本轮未据函数数量或命名偏好提出阻断。

## Requirement and traceability coverage

| 变更区域 | 核查结论 |
|---|---|
| Core/V1 工具注册、status/propose | 两工具及既有操作入口保留，主动提案仍经工具成功结算 |
| 父请求与维护请求 | 父 model、user.system、工具定义和 toolChoice 的接线已落实；插件文字进入末条消息 |
| 重试与默认切点 | 首次强制指令、最多八次逻辑重试、省略／窗口外 ID 使用默认切点已实现 |
| B-19 空摘要边界 | `summaryFinish` 使用已有 `hasText`，普通工作轮条件保持原样 |
| B-20 失败工作步提交 | `commitProposal` 复用结算、退出及 provider-error 状态，未结算或失败路径不提交 |
| 持久化与投影 | 继续使用原 marker／事件收尾；摘要缩短仅作用于工具参数投影 |
| history、cold-store | 单次 `cold_ref` 缓存、共同正文读取、续搜和只读冷态路径与方案一致 |
| 测试与基准 | 工具回包、父请求、取消、历史读回及基准识别已适配；共享成功夹具仍有 B-23 |
| 范围与质量 | 文件及行数预算通过；等价测试改写仍有 B-24 |

## Primary-path and fallback verdict

生产主路径保持为工具提案进入同代既有 checkpoint 收尾。逻辑重试和宿主默认切点处理符合批准方案，普通文本未作为摘要接受。

当前阻断集中在测试协议适配和明确要求撤回的额外差异，不需要扩展生产设计。

## Code quality verdict

**未通过。** B-23 使既有测试合同失效；B-24 违反明确的改动范围要求。文件数、增删量及空白检查已经通过，其余执行门禁尚未由本轮独立核验。

## Release verdict

**BLOCK — 对应批准方案 R149，比较基线 `55d404f3a1e07f8f1c2015c1df4be949c6975c94`，冻结实现 patch 标识 `47bd47a7cf4aeac451989ca11005ca1e90603621`。**

B-23、B-24 修复及相关验证完成后，仍需完整实现复审。
````

### R149 实施返工证据

两项均在原测试文件处理：共享成功fake调用既有onTail回调，沿原默认切点完成；split-turn调用恢复HEAD写法。成功断言保持原值，生产diff仍为1,194行。非阻断的1,198旧记录已改正。

cwd均为`packages/opencode`：

- 返工前：`bun test test/session/compaction.test.ts -t 'runs compaction as a completed boundary without a runnable task' --only-failures --timeout 15000`，0通过、1失败，期望continue而实际stop。
- 返工后：`bun test test/session/compaction.test.ts -t 'runs compaction as a completed boundary without a runnable task|retains a split turn suffix' --only-failures --timeout 15000`，2通过、12断言。
- 相关共享夹具：`bun test test/session/compaction.test.ts -t 'adds synthetic continue prompt|persists tail_start_id|shrinks retained tail|allows plugins to disable synthetic|replays the prior user turn' --only-failures --timeout 15000`，5通过、17断言。
- `bun typecheck`通过。

用户追加6次完整审计中的第1次已完成，下面原样记录完整复审结论。

### R149 完整实施复审原文

Task: `ses_dea04ff22ffeZAQ2pXP4l6DhZ8`。Audit mode: implementation；覆盖完整原始需求和17条实际改动路径。审计patch为`D:\Temp\opencode\compaction-r149-implementation-r2.patch`，blob `c230b531752f2225363a7ff585c7fe32bf10e832`。本记录写入及verified状态更新仅为审计后的行政记录，生产和测试不再变化。

````markdown
## Blocking findings

No blocking findings.

**B-23、B-24 均已关闭。**

- **B-23：** 共享成功夹具现在调用 `onTail(undefined)`，沿既有默认切点完成提案交付；原成功断言保持。对应 `packages/opencode/test/session/compaction.test.ts:236–242`。本轮独立复跑了原失败用例及相关共享夹具用例，全部通过。
- **B-24：** split-turn 用例已恢复原调用写法，冗余 `-1` 参数及等价展开已撤回，见 `packages/opencode/test/session/compaction.test.ts:1973`。

## Non-blocking findings

无新增项。上一轮指出的 **1,198行**旧记录已更正为 **1,194行**。

## Follow-up

同 SHA 的线上 Preflight、多平台检查及正式性能验证仍是最终验收项，按用户要求留在线上执行。

本轮未运行重型测试或 Benchmark。

## Rejected speculation

- 不增加 ID 必填、切点角色、候选成员资格或结束原因白名单。
- 不扩大权限、存储 Schema、传输层或历史引用校验。
- 本次返工只适配既有测试接口并撤回等价改写，生产成功判定保持不变。

## Requirement and traceability coverage

已核对完整原始需求、批准方案 R149、全部任务 diff，以及本轮修订与上一轮冻结 patch 的差异。**十个生产文件均未在本轮返工中变化。**

| 范围 | 结论 |
|---|---|
| 两工具、四操作、直接及 execute 调用 | 注册、执行、提案交付及对应行为测试保持 |
| 主动摘要提交 | 继续使用成功工具结算和结算后的活动窗口 |
| 宿主维护请求 | 父 model、user.system、工具定义和 toolChoice 接线保持；插件文字位于末条消息 |
| 重试与切点 | 八次逻辑重试、省略／窗口外 ID 使用默认切点、重试取消保留旧窗口均已覆盖 |
| 空摘要与失败工作步 | `hasText` 发布条件及 Core 提交条件保持；失败工作步保留旧 checkpoint 的隔离用例独立通过 |
| 历史检索 | session/global、续搜、ref/read、UTF-16 对齐和只读冷态测试通过 |
| 冷包缓存 | 单次 `searchArchive` 内复用 `cold_ref` 结果，读取错误继续计入诊断 |
| 测试、基准与范围 | 六个测试／基准文件保持，基准仅适配回包，B-23/B-24 已修复 |

## Primary-path and fallback verdict

主路径符合批准方案：主动提案或宿主维护流取得工具摘要后，进入同代既有 checkpoint 收尾。

本轮没有新增状态、重试策略或备用摘要路径。历史读取错误保留 `readErrors`，普通文本不会成为成功摘要。

## Code quality verdict

**本轮检查通过。**

| 独立执行的检查 | 结果 |
|---|---|
| Core 定点回归，4个文件 | **19通过，0失败，727个断言** |
| V1 定点回归，3个文件 | **20通过，0失败，159个断言** |
| Core 失败工作步隔离验证 | **1通过，0失败，2个断言** |
| 两包 `bun typecheck` | 均通过 |
| 全任务代码路径 Guard | **0错误、10个非阻断提示** |
| 新增 `context.ts` 的 Prettier 检查 | 通过 |
| 全任务代码路径 `git diff --check` | 通过 |

独立预算核算：

- 生产 **10文件，新增905行、删除289行，共1,194行**。
- 测试及基准 **6文件**。
- 可比较生产文件的新增均长比值最高约 **1.1650**；包含测试后的最高值约 **1.1870**，均低于 **1.2**。
- 验证结束后，全部 **17个任务路径**仍与冻结 patch 的内容标识一致。

## Release verdict

**APPROVE — 仅限批准方案 R149 对应的当前实现，比较基线 `55d404f3a1e07f8f1c2015c1df4be949c6975c94`，冻结 patch 标识 `c230b531752f2225363a7ff585c7fe32bf10e832`。**

本轮完整实现复审通过。最终交付仍以本次提交 SHA 的线上 Preflight 通过为准。
````

### R147 当前验证

原始引文在本会话`ses_e4337fe29ffeDPvE3DhnInuNDU`的用户文本和question答复中逐字核对。固定设计原始消息为`msg_209001d01001dNl2l6raKkuL2b`，Part `prt_209002328002jLcHa45JUIopU9`第88–134行；后续更正按§1.5生效。逐hunk清单为49条引用登记了消息ID、Part ID及原文行号，冻结diff未改写。

| 命令/检查 | 目录 | 当前结果 |
| --- | --- | --- |
| bun typecheck | packages/core | 通过 |
| bun typecheck | packages/opencode | 通过 |
| bun test test/session-runner.test.ts -t 'compaction\|checkpoint\|context overflow\|summarizes an oversized newest message' --only-failures --timeout 12000 | packages/core | 11通过，163断言，5.48秒 |
| bun test test/session/prompt.test.ts -t 'reads a changed file from archived patch evidence\|continues from a checkpoint proposed via\|manual compact hands a prompt\|manual compact without a queued' --only-failures --timeout 20000 | packages/opencode | 5通过，42断言，16.29秒 |
| V1此前报告的五个compaction失败用例定点运行 | packages/opencode | 5通过，35断言，20.52秒 |
| T4真实工具search/ref/read、timeout=0续搜、UTF-16及冷态 | packages/opencode | 1通过，14断言，5.25秒 |
| guard/check.ts --files 本任务完整代码路径 | 仓库根 | 0错误；非阻断提示保留 |
| git diff --check HEAD -- 本任务代码路径 | 仓库根 | 通过 |

整窗压缩曾在撤回默认尾部时变红，收到Earlier question而非压缩后的上下文；恢复原默认尾部并按ID映射后，原9条断言通过。保留模型显式C优先，不保留原先按消息角色加的分支。普通工具已验证成功的propose只传递原参数，不重复做Schema/非空检查。

新文件与新增函数/语句使用项目Prettier；旧generator的range格式化会丢失yield语境，改用generator片段格式化，保留有效yield*及未改旧回调的原格式。未运行本地Benchmark、全量测试或重型Gate；跨平台和正式性能由Preflight验收。

Core 定点验证（`packages/core`）：`bun test test/session-runner.test.ts -t 'manual compaction retries transient summary failures|active checkpoint keeps settled sibling results' --only-failures --timeout 20000`：2 通过、21 个断言，验证正常漏调重试和主动提案提交。保留内部候选位置后，`bun test test/session-runner.test.ts -t 'manual compaction identifies the retained system update|forces one compaction and retries after provider context overflow' --only-failures --timeout 20000`：2 通过、10 个断言；`bun typecheck` 通过。以上是实施证据，独立实施审计仍待预算达标。

R144 方案审计的最终记录：

> Non-blocking findings：此前的记录问题已关闭：§22 第 604 行已如实说明验收终点的变化，§24 第 711 行的实施审计占位已更正为 R144。
>
> Follow-up：实施预算仍待收敛：十个任务生产文件合计 **+1,060 / −291，共 1,351 行**，高于 1,200 行上限 151 行。实施审计及本次提交 SHA 的线上 Preflight 均待完成。
>
> **APPROVE — 仅限 `docs/plans/cache-preserving-compaction.md`，R144，复议核对的 Git blob `0b77520ac7c10835ee0300971bc899b8873edecf`。** 这是第 5 轮的最终分类，不另计轮次，不放行当前实现。本次只读，未修改文件、运行测试或触发推送。

按用户更正撤回额外提示与措辞断言后，在 `packages/core` 运行 `bun test test/session-runner.test.ts -t 'active checkpoint keeps settled sibling results after a prior summary' --only-failures --timeout 20000`：1 通过、13 个断言。实际工具说明仍含六节和搜索词线索；下一次请求仍含摘要、保留尾部与同一步工具结果。

V1 工作步与维护选界（`packages/opencode`）：`bun test test/session/prompt.test.ts -t 'continues from a checkpoint proposed via' --only-failures --timeout 20000` 验证直调和 execute 子调用，2 通过、13 个断言；`bun test test/session/compaction.test.ts -t 'uses the earliest feasible cut|keeps the parent tool declarations|keeps the old window until a missed checkpoint call succeeds' --only-failures --timeout 20000` 验证选择最早可行切点、保留父工具声明及漏调重试，3 通过、21 个断言；包内 `bun typecheck` 通过。

Core 手动请求的保留切点验证（`packages/core`）：真实上下文更新 `Changed context` 转成模型的 `system` 消息时没有持久 ID。修复前，请求保留了该消息，末条指令却标为 `the end of the supplied history`。手动入口复用 `toLLMMessages` 已生成的块后，`bun test test/session-runner.test.ts -t 'manual compaction identifies the retained system update|manual compaction stops after summarizing retained tool tail' --only-failures --timeout 20000`：2 通过、31 个断言；`bun typecheck` 通过。

V1 宿主请求定点验证（`packages/opencode`）：父请求自定义了 `context_compact` 声明时，原实现覆盖其说明和输入 Schema，测试得到 `stop`。改为只在缺失时补默认声明后，`bun test test/session/compaction.test.ts -t 'keeps the parent tool declarations|keeps plugin context outside' --only-failures --timeout 20000` 两例通过、9 个断言；`bun typecheck` 通过。基准与跨平台回归留到 CI。

R142 的 Core 手动压缩回归在真实请求中复现了切点摘录错误：消息正文为 `Earlier answer`，指令却引用了落库文本 `[Assistant]: Earlier answer`。改为从同一请求的保留消息取角色和正文后，原用例通过。`packages/core` 的 `bun test test/session-compaction.test.ts test/session-history.test.ts test/location-layer.test.ts test/session-runner.test.ts --only-failures --timeout 30000`：127 通过、1,333 个断言；`bun typecheck` 通过。

Sharp 打包用例独立运行通过。两条安装测试在本地镜像配置下失败，仅对测试子进程设置 `npm_config_registry=https://registry.npmjs.org` 后均通过；安装实现、用户配置和门禁均未修改。十个任务生产文件最近一次 `--shortstat` 为 +1,093/−290，共 1,383 行，尚未满足 1,200 行上限。

**R141 定点验证。** `packages/opencode` 的 `bun test test/session/prompt.test.ts -t 'continues from a checkpoint proposed|manual compact hands a prompt|manual compact without a queued' --only-failures --timeout 20000` 修正夹具前 2 通过、2 失败，修正后 4 通过、28 个断言。两个手动压缩夹具现在通过 `propose` 交付原摘要；队列交接、返回值、调用次数和 Idle 断言保留。`packages/core` 的 `bun test test/session-runner.test.ts test/session-compaction.test.ts -t 'active checkpoint keeps|manual compaction stops|summarizes an oversized newest message|forces one compaction' --only-failures --timeout 20000` 4 通过、58 个断言。两包的 `bun typecheck` 已通过；两处工作循环的规则检查 0 错误、1 提示。

门禁记录的 CLI `debug config` 子进程以 `startup-failed` 退出，同一用例独立运行通过；其余失败尚未逐项归因。这些定点结果不替代完整门禁。此时相对 `7190d264a7` 的十个任务生产文件为 +1,096/−325，合计 1,421 行，距上限还差 221 行。其他工作区文件不计入本任务，也不进入提交。

| 轮次 | 方案版本 | 全范围 | 阻断/非阻断 | 结果/任务引用 |
| --- | --- | --- | --- | --- |
| 最后一次实施审计 | R147；批准方案R146及用户明确撤回指令 | 是 | B-18、B-19、B-20 | BLOCK；同轮复议前保留原结论。Task ses_df3fcd990ffeyCFnmn0j29C7J2。 |

### R147 实施审计原文

~~~~markdown
## Blocking findings

**BLOCK。当前实现不能放行。** 已核对列出的完整生产与测试 diff；预算已降到 **1,189 行**，但精确版本门禁和两处压缩提交行为仍有阻断。

### B-18 当前实现对应 R147，获批方案仍是 R146

- **Violated invariant:** 实施必须对应获得独立批准的精确方案版本。
- **Evidence class:** contracted
- **Producer and execution path:** R146 获批后，R147 改变了候选范围、摘要完成判定、历史正文展开、引用校验及测试断言，并已写入当前实现。
- **Source evidence:** `.opencode/policy/first-principles-engineering.md:379–413`；`packages/core/src/session/history.ts:255–333`；`packages/opencode/src/session/processor.ts:210–229,926`。
- **Canonical-plan evidence:** 头部第 5–7 行明确记载当前 R147、历史批准 R146；§10.3、§10.4、§10.5 和 §22 记载了实质变化。
- **Responsibility owner:** Canonical plan 的修订与实施授权流程。
- **Concrete behavioral consequence:** 本轮若沿用 R146 的批准，就会直接放行未经方案审计的 R147 行为。逐 hunk 原文核对不能替代精确版本批准。
- **Pre-R1 baseline behavior:** 此项是实施放行门禁；pre-R1 行为不能为后续实质设计变更提供批准。
- **Round basis:** 本次实施审计的精确版本硬门禁。
- **Minimal correction direction:** 让 R147 的实质变更取得对应方案批准，再审其实际实现；本轮不能代替该步骤。

### B-19 V1 漏调工具后，重试期间已经形成空摘要边界

- **Violated invariant:** I4，以及“只有有效 `propose` 才形成 checkpoint，正常漏调重试一次”。
- **Evidence class:** reachable
- **Producer and execution path:** 首次维护响应只有文本并以 `stop` 结束。`checkpointEvents` 丢弃文本，却保留 `step-finish`；原事件处理器随即持久化摘要助手的 `finish="stop"`。外层发现没有提案后才发起第二次请求。
- **Source evidence:** `packages/opencode/src/session/processor.ts:210–229,926–947`；`packages/opencode/src/session/compaction.ts:599–606`；`packages/opencode/src/session/message-v2.ts:1588–1606`；`packages/core/src/session/compaction-boundary.ts:21–33`。
- **Canonical-plan evidence:** §7 I4、§10.3 第 5–6 步、§15 的“正常漏调不提前成立边界”。
- **Responsibility owner:** V1 摘要结果的发布与完成时点。
- **Concrete behavioral consequence:** 第二次请求尚未返回时，原读取路径已经把无正文摘要当作完成边界，旧活动历史退出窗口。当前仍保留的回归明确要求此时旧窗口可读，但这条执行链与其断言冲突：`packages/opencode/test/session/compaction.test.ts:2258–2300`。
- **Pre-R1 baseline behavior:** 文本是合法摘要，正文先于成功 `finish` 写入。本次把文本改为丢弃后，原完成时点已不再证明摘要存在。
- **Round basis:** 当前 diff 引入的可达回归。
- **Minimal correction direction:** 让维护摘要的成功发布与有效 `propose` 落库保持同一完成时点；普通工作轮沿原处理路径。

### B-20 Core 在工作步已失败或没有 Step.Ended 时仍提交主动摘要

- **Violated invariant:** §10.2 要求在工作步成功、工具结算且 `Step.Ended` 已发布之后提交提案；失败沿原出口。
- **Evidence class:** reachable
- **Producer and execution path:** compact 工具成功后，runner 保存 `proposal`。若随后流正常 EOF 但缺少 `step-finish`，runner 会先发布 `Step.Failed`，接着仍因 `proposal` 存在而调用压缩写入。工具调用后出现非重试型 provider-error，也能到达同一提交处。
- **Source evidence:** `packages/core/src/session/runner/llm.ts:496–505,680,727–744,777–785`；`packages/core/src/session/runner/publish-llm-event.ts:217–233`。
- **Canonical-plan evidence:** §10.2 第 394、398 行；§15 第 495 行仍明确“失败与取消沿原出口”。
- **Responsibility owner:** Core 工作步结算到压缩提交的交接处。
- **Concrete behavioral consequence:** 已标为失败、甚至未发布 `Step.Ended` 的工作步，仍能写入成功 `Compaction.Ended` 并替换活动窗口。
- **Pre-R1 baseline behavior:** 同一 EOF/失败路径只记录助手失败；没有主动提案通道，也不会在失败出口创建新 checkpoint。
- **Round basis:** 当前新增提案提交路径的可达回归。
- **Minimal correction direction:** 从已有工作步成功结算出口交付提案，失败和未结算出口保持原行为。

## Non-blocking findings

逐 hunk 清单明确标为冻结历史快照，不能用其中旧行数或旧断言代替当前 diff。当前方案已作出这一说明。

## Follow-up

本次独立核算：

- 生产：**10 文件，+893/−296，共 1,189 行**，距上限剩 11 行。
- 测试及基准：**6 文件**。
- `git diff --check HEAD -- <本任务代码路径>` 通过。
- 最终格式化后的预算、完整验证、实施放行及同 SHA 的线上 Preflight 尚未完成。

## Rejected speculation

不要求恢复“模型切点必须等于宿主切点”的检查，不从摘要内容推断边界，也不新增 caller 绑定、状态机或备用回包。上述行为阻断针对的是**尚未取得有效结果或工作步已失败，却产生成功 checkpoint**。

## Requirement and traceability coverage

已覆盖以下完整 diff 及直接消费者：

| 变更区域 | 对应行为与结论 |
|---|---|
| Core/V1 compaction、runner、prompt、processor | 工具提交、宿主请求、模型自选 C、原格式写入；存在 B-19、B-20 |
| message-v2 与 Core serializer | 仅在模型投影中缩短 compact 的 summary 参数，保留原记录 |
| history、cold-store、context、registry | 两工具注册、两代历史 search/ref/read、字节预筛与冷态读取；R147 的实质变化受 B-18 阻断 |
| provider、location-layer、runner、V1 两组测试 | 回包夹具、目录、主动/手动压缩、历史读回；已逐项查看新增及修改断言 |
| benchmark scripted 回包 | 保留原工作量、摘要内容与成功判定，仅适配工具回包 |

其他 agent 的文件未作为本任务撤回或修复对象。

## Primary-path and fallback verdict

主方向仍是一条工具压缩路径：宿主控制上传量，模型选择保留 ID，成功后沿既有存储交接。当前的问题是完成时点，不需要增加文本兜底或第二套压缩路径。

## Code quality verdict

文件数、生产增删量和空白检查已满足当前可核算门槛；行为质量门禁未通过。两包 typecheck 和定点测试通过是方案中的记录，本轮未重跑测试，不能据此覆盖 B-19 所指出的现存回归断言冲突。

## Release verdict

**BLOCK — `HEAD f1cd9b8d5561143abeafc7675eaf602ba1dad74e` 到本次工作树的任务 diff；当前方案 R147，Git blob `d8f44791486b2ada29c52d28ab7f5b0225920c9d`。**

本轮只读，未修改文件、运行测试、提交或推送。R146 的历史批准不能作为当前实现的放行依据。
~~~~

最终验收要求本次提交 SHA 的线上 Preflight 通过，记录 run 链接和各平台结果。第一次正常 push 必须触发预推送检查；Preflight 通过后可停在该结果，无需为验收再次推送目标分支。
## 附录 A. 模型看到的压缩说明

### A.1 共享摘要模板

Core 的既有六节模板是唯一 SUMMARY_TEMPLATE，检索留痕继续在上游同一文本内：

```text
Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]
- [when an omitted log, report, experiment, or analysis is likely to be needed again: one short breadcrumb describing the omitted detail and one or two exact literal search tokens; otherwise omit this bullet]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Files & Code
- [path: relevant symbols/sections and why they matter, or "(none)"]

## Errors & Fixes
- [exact error/output and fix or current status, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Respond in the same language as the conversation.
- Preserve exact file paths, symbols, commands, error strings, URLs, identifiers, and line numbers when known.
- Prefer facts over speculation; remove stale or resolved details to keep the snapshot accurate.
- Files entries must include why they matter and relevant symbols.
- Errors entries must include the fix or current status so the next model does not repeat dead ends.
- No long file contents or large command outputs — reference them, do not reproduce them.
- Do not mention the summary process or that context was compacted.
```

更新摘要时保留有效目标、较新事实、完成事项和下一步。六节模板与滚动合并规则位于静态工具说明；插件写作要求仍由既有hook取得，追加到末条user消息的status之后。末条不重复附整份模板、旧摘要或首次/更新分段包装。

### A.2 context_compact 完整 Description

`tailStartID` 参数说明是“第一条要保留的消息 ID”，不限定消息角色。status 示例里的用户消息仅是建议。

两代普通工作工具定义使用下列说明、既有SUMMARY_UPDATE_INSTRUCTIONS中的When combining规则以及A.1的**同一个SUMMARY_TEMPLATE字符串**，以两个换行连接为静态description。模型首次直接propose即收到六节结构、合并规则和检索留痕；不复制模板，不在解码器检查Markdown章节，不按插件返回改写父工具定义。

~~~text
Inspect the current conversation for candidate boundaries (status), or submit a rolling checkpoint (propose).

Call status after the existing context-pressure reminder, or after finishing a substantial phase when most earlier work will not matter for the next few steps. Finish the current debugging or closing step first. Do not poll status repeatedly.

Each candidate has the ID and opening excerpt of a real user message. tailStartID is the first message to KEEP, not the last message to summarize. Choose the ID, not a position inferred from the excerpt.

To propose a checkpoint, call context_compact with operation="propose", tailStartID, and a nonblank summary. Summarize only what precedes that message. Merge any earlier checkpoint into one self-contained replacement. Preserve objectives, constraints, verified facts, decisions, unresolved errors, and the next action. Keep exact paths, commands and error strings when they will matter again. Use the language of the conversation. A prior status call is not required.

For a host checkpoint, call context_compact(propose) now as your only action, with the summary of everything above in summary and the ID of the first message to keep in tailStartID; do not reply with text, do not call status, and do not call any other tool.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished, resolved, or no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.
~~~

手动和 Overflow 最后一条 user 消息的完整示例。第一行只有一句正文，第二行就是 `context_compact(status)` 给模型的完整返回值；这里用两项举例：
~~~text
Call context_compact(propose) now as your only action, with the summary of everything above in summary and the ID of the first message to keep in tailStartID; do not reply with text, do not call status, and do not call any other tool.
{"candidates":[{"tailStartID":"msg_A","excerpt":"检查读取结果"},{"tailStartID":"msg_B","excerpt":"继续处理构建"}]}
~~~
宿主附上 status 原文，不要求照抄推荐项；不设 `end` 消息 ID。这一条首次请求即附加，重发原样保持，只随请求发送，不写成真实用户输入。插件有prompt/context时，在status后用空行追加其原文，仍为同一条消息。When combining段直接复用现有常量；其中旧标签按之前摘要/后续对话理解，不生成新的transcript包装，也不要求工具回包包含这些标签。
status 的输出合同仅是 §10.1 的 candidates 数组，不回传模板、预算或维护指令。普通 marker 提问沿 HEAD：“What did we do so far?”。模型可在摘要缺少准确证据时用 history 工具，不改变普通系统或 compaction agent 的身份。

## 附录 B. 历史工具的完整用法

完整 Description：

```text
Search or read archived messages from earlier in this session (or prior sessions via scope="global") when a current action needs an exact detail omitted from the rolling summary and visible tail.

USE for a specific uncertainty gap: an exact error, config value, command flag, file detail, or rejected approach needed for the current step.
SKIP when the summary and visible tail already answer it. Never search merely because compaction happened or to reconstruct the transcript.

Search defaults to the current session. Use scope="global" only when the evidence may belong to another session. Global hits include a short sessionTitle and message time.

1. Search uses literal substring matching. Pass ONE short, distinctive token, not a natural-language phrase.
   Good: { operation:"search", query:"ECONNREFUSED" }
   Good: { operation:"search", query:"auth.get" }
   Bad: { operation:"search", query:"redis connection refused error fix" }
2. Inspect snippets. Read only when surrounding text is needed: pass the hit's ref unchanged. The first read includes up to 512 characters before the match and uses 4000 chars by default. Adjust chars only when you know the required window; for continuation, pass the returned nextOffset unchanged.
3. Stop as soon as the fact is recovered.

Use the default 4000 ms first. If timedOut=true, repeat the same query and scope to resume automatically without a cursor or page number. To request more hits after reaching maxResults, increase maxResults with the same query and scope; the host reuses earlier hits and resumes the scan. If timedOut=false, remainingMessages=0, and readErrors=0, an empty result means no match was found. Search again after completion if the history changed. Nonempty hits remain usable when a search stops early.
```

| 字段 | 完整 Schema description 与约束 |
| --- | --- |
| operation | Search archived evidence or read a bounded slice from a search hit. |
| query | Search query: a distinctive literal substring. |
| scope | Search only (omit for read). Use session by default; use global when evidence may belong to a prior session. |
| timeout | Milliseconds per search (default 4000). |
| maxResults | Number of search hits (default 10). |
| ref | Read only (omit for search). Copy one ref returned by search unchanged. |
| offset | Read only (omit for search). Explicit character offset; omit to include up to 512 characters before the match. |
| chars | Number of characters to read (default 4000). |

query为字符串；timeout、maxResults、offset、chars为数值，移除附加上下限与跨操作互斥拒绝。read默认从命中点前最多512个UTF-16单元开始、默认取4000；按原文要求对齐代理对，chars不足首个完整码点时扩充该码点，nextOffset取实际终点。现有`terminal-text.ts`只导出sanitizeVisibleText，没有可复用的偏移对齐函数，因此对齐留在工具自身的短函数中。

search回显items、timedOut、scannedMessages、totalMessages、remainingMessages、readErrors，以及各命中的ref、role、partType和snippet；global增加标题与时间。read的offset/total/nextOffset指向同一份原文。续搜保留已扫描位置，无次数配额、共享drain字符账本或后台扫描。
