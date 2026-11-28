# PR #5：Execute 的工具结果、数组与执行预算

> Status: verified
> Revision: R36
> Approved revision: R36
> Audit mode: full-scope
> Requirement source: §1
> Implementation allowed: yes
> Last updated: 2026-11-29

本文件是 Execute 与其调用工具的唯一 Canonical Plan，需求、设计、实施、测试和审计均在此续写。本轮终态为验证实现并在当前工作区提交；由主agent亲自实施，保留现有文档。原Execute设计与本轮工具拒绝删减共用本文件；用户已取消本地恢复归档这一额外交付。

需求基线是原 GOAL 实施前的 `0ab20fa87080bd4fafd79d39b97fb082c4af8d62`；[PR 原 Plan](https://github.com/SMARK2022/opencode/blob/dca28c6b7839ca036dc0673bf7df028dde7717a0/docs/plans/execute-result-recovery.md) 与 `.temp/testing/OpenCode-PR5-dca28c6.patch` 保存 R32 全文和逐轮判词。旧发布父为 `6dd9a5b1`；R35 调查快照为 `07395e4a`，本轮删减前本地 HEAD 为 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`。原功能基线不变，发布父按 §18 确定；各阶段实测绑定各自源码，不互相冒用。

本方案直接支持可用的输入、交付成功的结果，保留真实错误。最重要的删减是：普通数组规约沿用原实现；目录不逐工具重复声明文本特例；不用不可达错误和只断言这些错误的测试。

## 1. Verbatim Requirement

原文从已严格重放的 R7 Plan §1 提取，保留出处供送审核对。R7 Plan SHA256 `c3088f69562705f0908228a9cf2b703cc58e2244571fe2f29e5368747c130843`。

- 「按照我的理解，它失败了，那就是既有的输出的这个完整的缓冲区的一些内容直接去返回给模型不就 OK 了吗？然后顺带附上一个结果错误的一个 error 消息就 OK 了。然后其他东西按理来说，就是本身如果模型没有让它去显示，没有去 display 的东西，应该也不用去 display 啊。」
- 「你直接把你自己的东西做支持，做支持好不就 OK 了吗？你不要去做过多这种自动报错，巴拉巴拉这种事情，请你注意一点。就是你可以做，但是按照我的理解，你让一件东西报错，你远不如直接让它去支持来得快。这样你还少了很多 test，巴拉巴拉的东西。所以这些东西你都去做吧，OK。」原对话还明确追问受限内建回调和 Array.from mapper（R7 §1、§36），并确认行分页的 offset/limit。
- 「然后与此同时， Execute我希望去复刻，或者说调整，使其加上那个循环轮次的一个上限，以及这个工具调用数量的一个上限。比如工具调用数量是1024，然后循环数量你自己看设成多少比较好。」
- 「按理来说，如果它没有启用这个功能，为什么还能够让它去看到有 background 这个签名呢。」后续原话追查同类误暴露。
- 「就比如说你这种 grip，你的 json 过长，超过 64KB能算长吗？不算长，不应该报错。就按照这种逻辑去进行，你应该去分析，去检查。按理来说，所有的这种防御性的东西都需要去检查。然后同时最终按照我们完整按照我们的 workflow 逻辑去提一个 PR。」
- 「不需要修的请不要碰」；「是逻辑或者harness才用修」；「模型的问题不管」；「不要过度修改请注意着点」。
- 「文档不得由程序化进行这种自动的hunk弄的这种导出生成。」「我说过了，PR5的问题不在那里，PR5的问题已经说过了，它是在Plan上，而且Plan必须经过完整的审计。」
- 最新要求：「不得修改gate」；不修改 Gate 的代码、配置、规则、执行合同，也不另开 Gate 或计时器 PR。「我对你的审计轮次不设上限。」保留独立方案审计、实施和独立实现审计；仅取消轮次上限。
- 最新 Workflow 验收原文：「你不能说只改写一个Plan，这是不允许的。所有的Plan都必须要完整按照Workflow进行审计以及实施以及审计请注意这点。」
- R7 §1 保留的后续约束原文：「不要大幅度地补各种各样的测试，我再说一遍」。

- 最新发布验收原文：「新的性能基准测试已经更新，你可以进行Rebase。」「Rebase完push自动它就会跑。」
- 最新范围原文：「这个workflow里面已经明确说了，你的那个每一个plan都要写的是从基线到现在的行为，你不要写什么从现在怎么继续去精简」。完整目标行为从原 GOAL HEAD 0ab20fa8 描述；当前发布差分从最新目标分支 6dd9a5b 重放。中间稿或归档树只用于对照。

最新验收及逐 hunk 约束（逐字；按后发的 Gate 更正解释较早的 pre commit）：
- 「几个内容rebase一下。而且为什么又不建议了？不建议为什么你不修呢？啥意思啊？为啥叫不建议啊？让你做的东西，你为什么跟我说不建议？Rebase完之后记得跑一下pre commit看一下情况。」
- 「要求最终验收的版本是能够被合并的版本，但你不需要去合并。意思是说要求的达到的是质量可以能够满足能够合并的版本。」
- 「说错了，不是跑pre commit是跑gate。」
- 「对的，你应该按照Gate逻辑去进行修改。」
- 「同时请注意一点，相应的Workflow也更新了。要按照新的Workflow，还有新的审计等等来走，请注意这点。」
- 「也就是把当前仓库全部都变到最新的，然后全部按照最新的路径以及文件来走。」
- 「暂不合并，但同时请你检查，你自己去分析每一个 hunk 修改是否必要。我仍然觉得你可能进行了过度的修改，请注意这点。我观察到你也有一个地方去增加了七十七行的一个 test，这个可能是必要，也可能是不必要的，但是我不知道你下面……你反正你构建了很多东西，你甚至删除了一些这个常量。我不知道你删除是否有依据，还是说你直接把那些东西去转成别的东西了，还是说你直接把那些东西去固化在那个具体的里面，还是说怎么样。按照我的理解，你像这些东西，你的修改要适当考虑避免把这些什么这种常量去写在硬编码的这个主逻辑里面，请注意这点。然后我不知道你为什么又把这个 grid 去改掉了，改成了什么 long module output is saved to a readable file。这就很奇怪，这是什么意思呢？为什么说它被保存在了一个 file，它自己又不会保存，这东西本身就不合理呀，谁让你去这么改了。而且你即便是没有 default timeout，那你没有不就没有了吗？而且为什么不能……为什么你把它关掉了呢？按理来说 grid 的 timeout 是应该有的呀，为什么不有啊？谁让你去关掉了呢？没有人让你关掉。你不要瞎改，用户没让你做的事情不得改。就比如说用户你做了所有操作，你每一条操作都必须到用户的一个需求的原文，否则你改就是在瞎改。就比如说用户只是说的是，你不应该让这种不完整的东西去影响到后续一个速度。就比如说它不完整不就不完整吗，那就怎么了？就比如说它只搜到了六十四条，OK，那就正常把这六十四条做一个列表传到后面不就 OK 了吗？做那么多干什么？什么一会儿又报错，一会儿又干什么的，这本身就不合理。」

- 「相应的Git已经更新了，你可以把最新的内容去rebase一下。」
- 「相应的GATE已经更新了，你可以使用最新的GATE的内容。最新的GATE规定了和解决了之前GATE的一些bug。」
- 「同时请注意，你的这几个PR都应该是单个Commit。」
- 「那这个东西你也连不了，请注意一点，因为你内部你无法连到外部的任何网段上。所以我也授权你说在你自己的对应的这个PR上临时进行推送啊等等一些东西，请注意这点，就是我授权你进行这种推送，因为那毕竟是你的PR，你想怎么做就怎么做，就没问题。」
- 「比如对于5的话，对于Sharp 5的话，可以把Sharp 5推到分支上，自己去做检验，看行不行。行的话你再去弄就OK了。」
- 本轮审查原话：「与此同时，检查你的SHARP 5，看是否引入了一些报错逻辑，或者给模型报错反馈的逻辑。同时检查5的逻辑是否需要进行Hunk修改数的最小化。」
- 「我怀疑你引入了用户没有要求的过度复杂的那些逻辑，用户很多逻辑都没有要求你实现，但你在这地方非常防御性在实现各种判断逻辑，然后一会又报错，一会又啥的，按理来讲可能报错都不需要。」
- 「之前没有的拒绝行为，我也希望现在不要引入新的拒绝行为。或者说极力不要引入新的。」
- 「任何拒绝报错都是对于Agent行为的退化」。


- 本轮测试规则原话：「新增的回归断言必须能检出上述基线中实际存在的问题。中间方案修改或撤回时，一并撤回或改写依赖该方案的断言；不得为基线中不存在、仅由中间方案引入的问题保留断言。」

本轮新增原始要求：

- 11 月 23 日用户原话，普通工具基线：「如果没有的话，你应当全面完整移除对应的全部这种异常的报错逻辑。按理来讲，相应的逻辑应该按照基线的普通工具，也就是工具的普通模式走，不应该让Code Mode去产生额外的报错。」
- 11 月 23 日用户原话，收敛改动：「因此请注意这一点，按理来讲很多代码，按理来讲你很多代码本质上都是在去做移除，请注意这一点，做收敛，不要做增加，或者尽量少做增加。」
- 11 月 23 日用户原话，收敛新增行数：「同时收敛你的整体的修改增加行数。」
- 11 月 23 日用户原话，不新增基线外错误：「注意我们整体的Code Mode都是这种内容。也就是Code Mode的所有涉及到的工具，基线没有的错误，我们不应该去额外的报错。」

R29 沿用以上全部原文。用户续行原话（11 月 24 日 #5/#14 放行说明、11 月 24 日继续指令）：「5跟14，我从来都没有拦截过你。」「继续」。

R30 用户本轮原话（11 月 24 日 #5 最小必要改动与 Read 验收）：「我再问一遍，我是不是说过，在你的PR内，你可以进行任何操作，只要保持相应的修改足够简化、足够必要即可。不要修改过多的无关的行内容，但是你又需要去保持相应的内容能够通过基线。同时我已经告诉你，清晰的告诉过你了。5真的已经可以合并了?」随后附现行 `readPageContent` 并问：「我已经说过好多次了，我当时对于5的验收需求是什么？」以上既有原始需求、范围和门禁全部继续生效。

本地修订原话：

> 你可以看一下他大概修了多少行的逻辑。然后我希望的是，你可以看一看，说能不能把他那个方案放进我们的工作区里面，就是放进我们的这个按照这个document里面有个guide里面有个Workflow Workflow dot markdown里面有一个Verified Plan那个逻辑，你把那个已有的Plan放到我们本地，然后把那个Plan的逻辑你看一看，调整调整。请注意这点。

> 不要求这种报错都不要报错，但是你尽量能直接去做的就尽量去做好。比如说一些工具可能实现起来就可能就二三十行就能去搞完，就能解决一个大的报错，还有各种各样的断言。那就直接去把它解决掉，不就那个性能特性支持就完了。不要去做那种无意义的一些操作，无意义的一些这种故意的这种断言和报错。然后同时不要去增加模型心智负担，把一些该做的好的功能去做好就OK了。请注意这点。

11 月 28 日后续原话与更正，按先后顺序保留：

> 目前还有单条 JSON 记录超过 64 KiB 就拒绝的限制。
> 审批等待期间文件已变；
> 审批等待期间目标状态发生变化。
> 提交前文件发生变化；
> 响应超过 5 MiB
>
> 这几个按理来说都不应该去出现，也就这几个报错都应该移除，本身这几个并不能是限制逻辑。只要不影响对应的编辑、写入等等操作，按理来讲就不应该去直接阻碍它去进行相应的流程。因为很可能相应的编辑是互不相干的，那本身一直即使应用，我觉得应该也没什么问题。
>
> 但这个地方我并不知道单条JSON超过64KB和响应超过5MB的处理逻辑。当然按照我的理解，那我们Open Code工具它本身就会对工具进行这个redundant，按理来讲它可以进行适当的这个压缩，它不应该说JSON单条记录超过64KB就直接拒绝，这是一个非常垃圾的行为。
>
> 改状态前没读当前 Goal；
>
> 同时，按理来讲这个东西可以进行调整一下，因为我们这个之前有点过激了，我觉得这一块应该是这样的，就是只要在去complete或者说这个block就改状态之前的比如三轮模型的消息之内，它有这个读的这个操作，并且状态没有被就是就是就是这个goal没有被用户去调整过，那按理来讲它就应该被通过。
>
> 那就是如上这么多需要进行调整的，请注意这点。然后其他的没有什么大问题，用户没有收到东西请不要进行调整，请注意这点。

> 不要使用task实现，请全部撤回，可以让task自己撤回

> 你可以进入到实施阶段，但按照我的理解来讲，既然你说了。你的作用就是去移除掉对应的一些错误啊等等一些内容。那你要去做纯减法，你不要去做什么代码的增加或者什么东西。按理来说不应该出现任何的代码竞争，同时也不应该再去额外去实现任何的这种逻辑最多是做修改或做删除。就比如按照我的理解，它本身就不应该引入什么migration啊，引入migration干什么东西啊？那很奇怪的一点，你到底在干什么？用户的要求意图已经很清晰，你不要去扩大用户的任何意图，用户没有说的任何东西，你都不应该去调整。用户关于这个拒绝这个错误或报错，就说了一、二、三、四、五五条，第五条可能说了两个，因为它本身多个工具都有这个东西，那你就移除掉对应的限制报错不就好了吗？让它能够正常返回，或者正常进入压缩，或者这个裁切，复用对应的裁切逻辑不就好了吗？你非得去自己写逻辑干什么？你写什么东西？用户让你写了吗？你有毛病吧？

> 不对呀，你这就很奇怪，你怎么又换了一个plan呢？我们plan原本是execute result recovery，你怎么又换了一个plan？你是在干什么？你怎么又创建了一个tool rejection and go read window？是干什么的？为什么要这样做？所有的任务逻辑都是一个路线，一个流程。你可以看到一个是execute的部分，一个是工具部分，你现在搞成两个干什么？

本次 continuation 的终态为 `verified-implementation-and-commit`。用户允许本任务在当前及隔离验证目录执行 `bun install --frozen-lockfile`，随后明确同意候选提交及原 Gate 的预检推送。用户后发更正（逐字）：

> 我没有未提交的其他改动，我再说一遍。当前工作区的所有的代码实现，按理来说只有你的东西，没有其他人的东西。除了部分文档，文档的话需要保留。

> 同时我搞不懂你为什么要加OpenUI的相关内容。然后我们的要求里面已经说了，避免增加注释避免增加注释避免增加注释，你的注释只会强化你的垃圾记忆。

> 干什么鬼啊？什么叫恢复归档啊？有毛病吧？我已经说的很清晰了， verify the implementation and commit。搞什么本地恢复归档，恢什么复啊？用户有要求这个东西吗？

该更正删除额外的恢复归档交付，不改变已批准的生产设计与测试范围。历史审计原文保留；其中的归档条件不再作为当前放行要求。

## 2. 范围之外

追加的工具拒绝需求仅删除用户点名的五条限制；原Execute范围继续按同一Plan实施。由主agent亲自实施，task仅可只读审计。不得新增迁移、数据库字段、重匹配、自动合并、重试、并发协调或替代上限。Gate与依赖锁保持原样，按§1最新GOAL和用户授权验证及提交，保留现有文档。产品范围不含WebUI、调整模型、取消沙箱限制、给Grep改默认超时、加入后台能力、重新设计审批或另开计时器PR。

## 3. 仓库与基线

按 `docs/guides/workflow.md`、canonical 模板和 first-principles policy 走方案阶段；采用根与各包 AGENTS 的模块归属。CONTEXT.md 的模型输出由 Session 限额投影；Code Mode 管受限数据，应用管理权限和工具结果，Core 注册器管理公开定义。现有 ADR 0001 讲分诊标签，与本次工具结果无关。

对照已提交的 07395e4a 与 6dd9a5b：PR 的 23 个非 Plan 路径中仅 packages/opencode/src/session/tools.ts 有差异，变化是获取最新审批规则及按原 sessionID 查子调用，不在 MCP 结果选择或目录赋值处。未来实施以干净目标父为起点，保留该变化；本地另有未提交的 registry 与 session-runner 等修改，不能覆盖或纳入 #5。

## 4. 证据

| 已读入口 | 证明什么 |
| --- | --- |
| codemode/src/{codemode,tool,tool-schema,tool-runtime,interpreter/runtime,interpreter/model,stdlib/math}.ts | 公共 Execute、工具声明与真正解码、唯一数据复制、受限调用与显式循环入口。 |
| opencode/src/{session/tools,mcp/catalog,tool/code-mode,tool/registry,plugin/vscode-bridge,tool/read,tool/shell}.ts；core/src/{ripgrep,tool/task,tool/read-lines,tool/read-presentation}.ts | 普通/嵌套的共同执行入口、插件与 MCP 生产者；Read 分页、Grep 停止、Shell 两种输出和后台开关。 |
| 原 PR 的全部差异及 §15 所列测试、TUI 使用点与现存依赖补丁 | 实际修改与基线已有行为；资源归属。原 Plan 的历史 A/B 见 §18，不冒充本机重跑。 |
| 本次 Bun 1.4.4 实际调用 McpCatalog.programResult + 公共 CodeMode.execute | 一份合法业务结果，给脚本结构值时收到 InvalidToolOutput，传同次展示文本成功；普通浅对象正常。复跑命令、局限见 §18。 |
| 两代 WebFetch、Execute fetchHTTP、Core http-body/websearch | 5 MiB 分别在三处 HTTP 获取路径拒绝；原展示层另有裁剪。WebSearch 的256KiB独立合同不在本轮删除范围。 |
| V1 file-mutation-coordinator/edit/write/apply_patch；Core file-mutation/tool-edit/tool-apply-patch | 原已生成内容在提交前又按全文件版本拒绝；最新要求直接撤回该拒绝，保留原授权、锁和提交步骤。 |

## 5. 当前行为

Grep 在解析有效 JSON 前拒绝超过 64 KiB 的记录。V1 Read 在第一完整行进入 raw 前到达软窗，可能返回空页并指回同一行。Shell 把供人读的退出提示放进了脚本正文。Execute 原正式路径没用预跑的工具调用上限，解释器缺显式循环总限和 Array.from mapper。工具开关与公开目录在 V1 投影、V2 注册两处不一致。失败时的显式日志与真实错误已经沿现有会话回执交付。

成功的外部工具先有普通输出，再按同次调用的 program.value 给脚本数据。旧版对深对象、普通领域实例和含沙箱保留字段名的业务记录会拒绝。另一方面，PR 已把固定层级插件的目录也拓宽为对象或字符串，仅因插件用 JSON Schema 公示；例如 notebook summary 的 Zod 生产者实际只产固定层级对象。目录的这个改动应撤回。

## 6. 输入范围

真实 SDK 接受的 wire JSON、插件已通过原输出声明的结果、原受限内建令牌、已有可迭代容器与数值 length 的 array-like；普通文本文件的行分页、rg 合法 JSON 记录及现有 TUI 生命周期。脚本错误、权限/取消、真实 I/O、输入或输出声明不符各走原路径。不会把任意宿主对象、函数、循环引用或受限属性交给解释器。

## 7. 不变量与验收

| ID | 用户可以观察到的行为 |
| --- | --- |
| OUT / SH | 失败保留显式展示缓冲与 error，未展示的子工具正文不自动加入；Shell 的机器正文不夹退出通知，状态单独保留。 |
| READ / RG | 完整行能读就返回并正确续页；确实无进度时给截断事实，不伪造已读或续页。合法长匹配正常交付；提前停止保留已有结果、原超时与数量限制。 |
| JS / BUD | Array、映射与已支持的内建回调能直接用。旧索引、短路、稀疏数组、排序、宿主入参和 JSON 结果语义保持。1,024 次工具调用、100,000 次显式循环体准入；每次 Execute 重置。 |
| VIS / PARITY | 目录只公开开着的能力与工具声明的业务形状；同一次成功的工具调用，应向脚本交付可用数据。真实工具错误保持，表示方式不能制造一次工具失败。 |
| REL / EXIT / SCROLL / RENDER / SLOT | 保留实际 Gate 的发布条件及原活动行为；只清理已结束 owner 的通知、滚动、帧或 Spinner。基线已修处不再改。 |
| HTTP-SIZE | 两代 WebFetch 和 Execute fetch 不因5MiB拒绝有效响应；复用原读取、转换、输出裁剪与真实错误处理。 |
| MUTATION | 删除审批后/提交前全文件版本变化的拒绝；继续提交原已批准内容，不新增重匹配或合并算法；原锁和真实写入错误保持。 |

## 8. 第一次出现偏差的位置

RG 是 parse 前的长度门禁；READ 是累积字符与提交整行这两个共享 parser 决策点及 V1 对空范围的投影；SH 是将带展示文案的 output 放入程序字段。JS 是集合入口的令牌准入/mapper 拒绝；BUD 缺正式宿主的已有调用额度及解释器循环体计数；VIS 是拿完整 decoder 当公开 schema。OUT 原回执符合要求，无生产差分。

PARITY 分三处：未声明插件被目录当作 string；已成功且已解码的结构在脚本数据复制时遇到不能表示的值，被包装成工具失败；目录仅凭声明载体类型给所有外部工具加字符串分支。TUI 偏差分别在卸载后仍持有/分配 handle、重复求值活动 JSX、过期回调消费新帧。§15 列出每处唯一改动位置。

## 9. 谁负责

HTTP-SIZE 在三个现有获取入口直接去掉长度门禁，模型展示仍由原工具包装器和 Session 控制。MUTATION 是用户最新明确要求的拒绝行为撤回，拥有者为 V1 coordinator 与 Core FileMutation；删除比较和其专用错误转换，保持原提交步骤，撤回先前提出的提交时重新匹配方案。

工具执行、Zod/SDK 验证、授权在原宿主；Code Mode 只投影已成功的结果。共享复制器负责判断能否安全表示，不能让每个插件各查一遍。宿主负责同次结果的正文、附件和 MCP 来源；Session 继续负责最后的输出预算/恢复文件。目录只展示声明，不运行工具猜类型。Read 的 parser 计量，V1 决定已读，formatter 只展示。TUI 资源由实际创建者释放。

## 10. 实施路径

1. 工具仍然只执行一次。没有 program 时直接给已有 output；显式 rawText 沿用原 fromJsonText；其它成功结果先过原 decoder，再在既有复制器中投影一次。可安全复制的浅对象、空值、0、false 原样交付。
2. 只在**已解码的成功输出**里处理已证实的三类不可表示值：超深、普通领域类、数据键名受限。沿用同一次宿主成功结果的文本。已通过 SDK 的 MCP 深结构沿用完整 JSON 文本，保证展示摘要不能替换完整结构；字段名或领域类情况只用已取得的普通 output，不读取受限字段。没有该宿主投影的纯 CodeMode API 保留原拒绝。参数检查、保留键访问禁令、循环引用、非数据值、decoder 不符、真实失败和取消保持。把不可表示视为本次结果的表示选择；不要捕获任意异常当成功，不重跑，不加第二次遍历或预检。
3. 目录/搜索复用原输出声明 renderer 和原 outputSchema。以一句共享说明区分**签名写工具声明的数据形状**和**脚本收到的表示**：普通结果是该数据；外部结果在沙箱不能表示时才交付文本，超深 MCP 交完整 JSON。查询签名共用相同含义，详细查询不改 SDK schema 或根引用。固定对象仍显示固定字段；未声明插件用 unknown。撤去逐条赋标/联合类型、重复说明和以此为目的的签名断言；不遍历 schema 猜深度、不让模型在每次调用前判类型。
4. 直接调用与集合回调继续共用受限令牌分派；工具和 Promise 仍走专门入口。集合先验明已支持的回调类型；直接调用保留一次求值的 receiver 诊断。用已有 AST node 作为错误位置的缺省值，删掉只有缺少 callee 才报错、当前调用者走不到的分支。保留原 reduce、reduceRight 两个方向的遍历；二者已有同一个 apply，不为共享循环另建 inRange。其余功能与真实门禁逐项见 §15。
5. HTTP-SIZE：V1 WebFetch 和 fetchHTTP 删除 Content-Length/实际正文的5MiB比较及常量；V2 WebFetch 删除 bounded helper 调用，直接复用现有 Response.text，仍在原 timeout 内。请求、权限、MIME、格式转换、Cloudflare既有兼容路径及模型输出裁剪不改；http-body 保留给 WebSearch。
6. MUTATION：V1 删除提交前版本循环、MutationConflict、fingerprint及比较器；Core 删除 commit、conditional write、move 的字节比较与 StaleContentError，删消费者专门翻译这些错误的分支。原名称、调用形状、授权、锁、写入内容和格式化继续使用。只删失效代码及相邻错误注释，不新增状态或算法。原生成全文可能覆盖等待期间的外部修改，这一后果已在执行前说明，不把本方案描述为无损合并。

## 11. 分支取舍

正常工具调用和业务校验只有原来的执行路径。对已成功值选结构或同次文本，是结果协议内的投影；没有第二次执行或第二数据源。无 program、显式 rawText、媒体附件和未声明插件分别保持既有入口。真正错误交原模型回执，不自动补子工具正文。零个新增重试、自动解析器、权限通道或模型诊断。TUI 只按资源所属实例清理。

## 12. 删除项

删除 64 KiB 拒绝、已有软窗后重复的整页 token 拒绝和建议 limit、mapper 专门拒绝；不采纳候选的不可达 callee 报错、合并 reducer 的重构、用于展示的 symbol/包装导出与逐条字符串签名。保留工具预算、有效偏移检查、真实解码及权限错误。

## 13. 正向映射

§15 的每行同时给出需求编号、生产路径、改动、原回归入口。普通内置、MCP、磁盘插件和 Plugin.Service.list 都走 SessionTools 的同一个 invoke；两种插件注册最终会合到 fromPlugin。OUT、RG-2、SCROLL 和已有 RENDER-2/3 用原测试，没有为已满足的行为新增生产修改。

## 14. 反向映射

首行准入及无游标 marker 只为真实行分页；循环计数只为显式上限；受限调用分派只为已支持内建；公开 input 与执行 codec 分开只为能力可见性。输出表示只为一次成功结果不被误报，MCP 来源只为保留完整的深 JSON；原 renderer 足够描述业务形状，不增加签名标志。Toast 的关闭信号、帧身份和 Show accessor 各处理已复现的资源所有权失配；不能通过改 Gate、改等待或关动画达成。每项反向映射的实际原因与原接口限制详见 §15。


## 15. File-Level Change Plan

| Hunk / 文件 | 最终行为、必要性与复用 | 原有测试及变更边界 |
| --- | --- | --- |
| OUT-0，无生产文件 | 原失败回执已经覆盖用户需求；现有 SessionTools 不补写未显示的子工具正文，不另包错误或新增输出。 | 原 execute.test.ts 夹具增强是诊断，不保留仅能验证已绿行为的新回归断言。 |
| SH-1 `packages/opencode/src/tool/shell.ts`，最终组装 | 限定将 program.value.content 改为现成 end.text；展示字段含通知，复用它无法给机器获得原文。 | 复用原 Session Execute 的两个既有实际 Shell 子调用，保留机器正文/退出/未截断/未超时的检查，原 shell.test.ts 恢复发布基线完整后像，原模型/UI 检查不动。 |
| READ-1 `packages/core/src/tool/read-lines.ts`，增量和提交预算两点 | 两点共同决定首行是否能进入 raw；仅按 V1 提供的首行准入在原软窗外捕获，后续行沿原门禁。只改一点会继续丢首行或出现提交/积累语义分叉。 | 原 read.test.ts 首行红、原 1 MiB 未闭合与 outline 共享预算回归；V2 strict 和 outline 不传准入。 |
| READ-2 同 parser，原物理块转辅助扣费 | 扣费起点仍是原软窗跨越处；同一已读块只扣一次、已读末块能结束时才返回完整首行、不能多请求普通块。否则可交付首行会蚕食 outline 额度或扩大实际 I/O。 | 原物理上限、共享预算、CRLF、有限 EOF；临时候选暂存峰值需按现有码率上限复核，禁止回到捕获整个辅助扫描的方案。 |
| READ-3 `packages/opencode/src/tool/read.ts`，V1 调用与投影 | 只在首行准入使用原 16,000 token 估算；去掉整页重复估算和无效异常；正 limit 零交付的截断页成功返回，不给自指 next，也不登记覆盖。用现成 content.length 代替重复拼接作 stub 字符计数；同一 V1 页结果只保留 next 的一次决定，外层既有三条投影复用该事实，保留所有正进度页逻辑。 | 原 ReadTool 首行/显式尾行、1 MiB 截断、limit=0 和原越界。 |
| READ-4 `packages/core/src/tool/read-presentation.ts`，原 XML 输出 | 保留原 cut/more 语义和 reason，在既有 marker owner 只收一个省略偏移的窄输入，V1 零进度拨动一次；V2 与其它调用省略，默认逐字不变。 | 复用 Read 原长行断言检查 offsetless marker；真实 V2 原 presenter/Read 现有测试。 |
| RG-1 `packages/core/src/ripgrep.ts`，记录拼接进 JSON.parse | 清除合法记录在解析前的固定 64 KiB 长度拒绝；复用现有解析/无效数据错误、超时、数量阈值、文本展示。无需加另一个大小阈值或生产 fallback。 | 原 Core ripgrep 套件保留短 Unicode 安全预览 / 原真错误；把同一原需求 70 KiB 三匹配、顺序及 Unicode 预览的正式断言移至原 Session Execute 的真实 Grep/Glob/Read 单例。 |
| RG-2 原搜索停止点，无文件 | 同基线 partial/invalid/abort/bounded 控制通过，保留原停止点及各自的错误与已完成结果语义，不预先加入条件。 | 区分正常提前停止与真正失败，不能把 partial 合同推到所有异常。 |
| JS-1 `packages/codemode/src/interpreter/runtime.ts`，Array 构造与内建调用 | 支持用户已有普通构造和受限回调，继续验证 sandbox 可调用值；不接任意宿主 callable、ToolReference、thisArg 或隐式 Promise 等待。复用现有执行器而非把回调交给原生未受限执行；已准入 Math 的 min/max/hypot 在回调分支根据原生 ABI 消费全部参数，用已有受限 coerceToNumber 转换；定参保持已验 arity，直接调用不变。 | 原 codemode 数组行为实例复用；实际红测只为固定基线差异。 |
| JS-2 同 runtime，Array.from 支持源读取 | 已受支持输入逐项读取后立即调用 mapper；保留数组稀疏长度，array-like 只固定一次长度、索引动态读。预先整批复制会让前项回调修改尾项的语义错误。 | 原 Array.from mapper/逐项读取、省略 mapper、显式 undefined 的共享入口与 null 不合法原控制。 |
| JS-3 同 runtime，稀疏集合消费与排序 | 在原数组调用 owner 维持先前索引语义：map/forEach/filter/flatMap/some/every 按 entries 取值，flatMap 原样展开回调返回数组，双向归约访问原索引；sort/toSorted 由原排序生成明确末尾索引，比较器不消费 undefined。新 Array 构造仍进入同一处理，无语法来源标记。保留已有真假短路、真正空数组失败、快照、预算及共享新增回调准入。 | 对旧可达输入的兼容对照在隔离运行，基线绿者不加入正式断言。现有构造用例只更正 map 枚举结果为 `0,1,2,3`；原基线因新增能力缺失仍会拒绝该入口。 |
| JS-4 packages/codemode/src/interpreter/model.ts，既有语法提示 | 原要求包括提示与实际能力一致；只说明受限内建回调、Array 构造与 Array.from mapper，不声称任意原生回调可用。 | 现有错误说明入口；不新增独立测试实例。 |
| JS-5 packages/codemode/src/tool-runtime.ts，copyOut 的公共 JSON 投影 | 公共执行结果 true 模式在已有 copyOut 数组分支把空位及 undefined 投影为 null；默认模式沿固定 0dff 的 map 回传，原已存在的自身键保持，真洞仍缺键。两条宿主前像都保持：字面量 [,1] 原生产已有 undefined 自身键；索引赋值造成的缺位须以洞送达 raw/JSON Schema 工具。copyIn、解释器集合与 decoder 不动。 | 保留既有 CodeMode JSON-safe 结果用例的基线红断言与直接值/Schema 往返；同例永久覆盖实际基线拒绝的 Array 构造、mapper 与受限回调。旧字面量、索引宿主参数的三条既已有相同行为的断言和其私有辅助构造只留仓外；同样把历史 sort 快照行为保留为仓外观察。零新增测试实例，保留原断言。 |
| BUD-1 `packages/opencode/src/tool/code-mode.ts`，预跑与正式两处组装 | 以一个既有范围的配置表达 1,024、100,000 与原输出字节量，共用于两阶段；每阶段独立创建执行根、保留自身 timeout。固定基线只有预跑有 1024；保持预跑 500 ms、正式产品/用户超时、输出上限、取消语义。 | 原 host preview caps 实例对照 1024/1025；受限计数仅在正式结果里观察。 |
| BUD-2 `packages/codemode/src/codemode.ts` 与 `packages/codemode/src/interpreter/runtime.ts`，预算配置与循环体入口 | 通过既有 limits 的公开解释器入口传显式循环配额，在同一个根上累计所有真实进入的循环体并跨嵌套/调用/并发消费；新 Execute 重置。工具侧复用已有 maxToolCalls admission，不重做计数。 | 用已有真实解释器控制及原 host 入口验证相邻边界与重置；100,000 已由真宿主验证。 |
| VIS-1 `packages/opencode/src/tool/code-mode.ts`，toolTree 公示 | 用 definition.input 替换展示 inputContract；保持 Tool.make 已生成的 inputForms 与原运行时解码器。修复错误引用之处已在真实 adapter A/B 验证，不改共享 codemode 适配器或重复裁剪 Task。 | 原 code-mode.test.ts 公共/运行时 schema 对照，目录、search({query})、标量与对象、开关和权限制约。 |
| VIS-2 packages/core/src/tool/task.ts，独立 V2 注册 | 使用已有背景 flag 给公开 schema 和描述，不改执行时完整 Input codec 与拒绝条件。V1 toolTree 到不了此 consumer；历史精确原修复和 R7 合同均覆盖。 | 在隔离工作树恢复历史 task advertises background only when enabled 作阶段1夹具；正式用既有 SessionRunner 测试最小承接，保持测试实例数。 |
| EXIT-1 `packages/tui/src/ui/toast.tsx` | 在原 owner cleanup 标记关闭并释放现有 handle；已关闭的 show 不再写 store 或创建 handle。两处共同维持资源生命周期：只 clear 不能处理迟到调用，只拒绝迟到调用不能释放卸载前在用的 handle。 | 原 app.exit 用例不改，复跑原 stock 两文件组合；额外生命周期诊断只留仓外。 |
| SCROLL-1 packages/tui/src/routes/session/index.tsx（继承原基线，零差分） | 6dd 的 Set、cleanup、晚到同步和 destroyed 约束已经同真实原入口验证。 | 保留原 partial glob 与原切换贴底控制；正式测试不改。 |
| SLOT-1 packages/tui/src/ui/dialog-select.tsx，filterAccessory 的 Show | 用该 Show 自己的 accessor 渲染，避免创建第二份动态节点；原布局、动画、选项保持 | 原 preview 和 scan HTTP failure 场景，不增正式实例 |
| RENDER-1…3 patches/@opentui%2Fcore@0.4.3-smark.13.patch（唯一载体） | 只在 6dd 的 renderer 调度段推进现有一次帧的身份，保留原 false 空闲态、公开布尔值与共享句柄路线；RENDER-2/3 原基线已闭合，其余表格、ScrollBox 与补丁其他模块字节保持。不能盲目拼接 #5 旧 scheduler 段。 | 原 release 严格正反 patch check，真实 native stale nextTick 红绿，连续接替/毁灭控制不回归；原表格与 TUI 测试。 |
| PARITY-1 codemode/src/{codemode,tool-runtime}.ts、opencode/src/{tool/code-mode,session/tools}.ts | 只在有宿主成功正文且已通过输出声明的 value 上选择表示。识别 depth、shape 和已证明的受限数据键。前两项及完整深 MCP JSON 保持原已验证路径，受限键只取同次普通正文；不扩大 copyIn 接受域。 | 同一 MCP 同时有文本和结构；保留 32/33 层、图像、真实失败；新场景只测拿到的业务正文。 |
| PARITY-2 opencode/src/tool/registry.ts、test/session/execute.test.ts | 无输出声明的插件保留 unknown，不把它强制解码为 string。 | 用原磁盘插件用例验证无声明返回浅对象的实际值；保留原文本、有声明结构和参数失败的独立意义，不用改签名期望代替行为。 |
| PARITY-3 opencode/src/tool/code-mode.ts | 公示输入仍按 VIS-1；目录保留具体业务形状，展示规则在现有宿主说明一次说清。无需改 codemode.describeDefinition 的输出签名，不给外部声明逐条打标。 | 真实固定输出目录沿用发布基线的期望；test/tool/code-mode-integration.test.ts 的 R32 单行变化可全部撤销，不为基线正确签名单加回归断言。 |
| VIS / PARITY，codemode/src/tool-runtime.ts 的 `makeSearchTool` | 原 `describeSchema` 已支持某一侧详情无法展示时返回 `null` 并标在 `schemaUnavailable`。把同一规则用于已发射但不能进入脚本的详情：只在请求详情时，对该侧复用现有有界复制（按最终 `page.items[i].inputSchema/outputSchema` 的嵌入深度计量）。保持终端数据校验；不遍历整份目录、不改协议定义、不删原声明的字段，不影响摘要查询。 | 复用宿主现有 MCP 用例，用同一份业务声明先精确查路径、再调用：仍拿到路径、签名及可表示的一侧，业务调用取得同次结果。已有 signature 用例验证邻项、分页、未声明和一侧不可展示的区别，不另建错误测试。 |
| 交付范围 | 生产仅上述有明确 owner 的候选；RG-2 与 OUT-0 均无生产文件。测试在现有实例最小修改，零新增实例；精确有效行数、文件数及注释随最终经审计差分冻结。 | 私有夹具、临时脚本及收据不进产品差分，Gate 未改。 |
| HTTP-SIZE `packages/opencode/src/tool/{webfetch,code-mode}.ts`、`packages/core/src/tool/webfetch.ts` | 直接删除5MiB接收拒绝，V2复用Response.text，不改输出裁剪或WebSearch。 | 原两代webfetch及Session Execute HTTP实例改用大正文；有/无声明长度继续交付完整程序结果，展示依旧有界。 |
| MUTATION `packages/opencode/src/tool/file-mutation-coordinator.ts`、`packages/core/src/{file-mutation,tool/edit,tool/apply-patch}.ts` | 删除版本比较、其专用错误和无用hash；原V1 edit/write/apply_patch只删相邻失效注释。保留原执行内容与锁，不重匹配。 | 原 file-mutation、file-mutation-concurrency、两代 edit/write/apply_patch；仅改变明确撤回的拒绝期望，核对实际最终字节，其余权限/匹配/取消/格式化检查保留。 |

历史精确原差分共 24 文件（含旧 Plan）：解释器 codemode.ts、interpreter/model.ts、interpreter/runtime.ts、stdlib/math.ts 对应 JS-1…5、BUD-2；本版保持直接 Math 的既有数值校验，不迁全局 math 改动。历史 codemode/src/tool.ts 与原 V1 host code-mode.ts 对应 VIS-1/BUD-1，本版修复已证展示覆写点并保留其他消费者。历史 core 的 ripgrep.ts、read-lines.ts、task.ts 对应 RG、READ、VIS-2；READ-3 来自当前 0dff 的 V1 自指和已有 token 合同。历史 shell.ts 对应 SH；历史 Execute 隐藏正文由 OUT-0 实跑保留。

原测试 codemode 的 codemode/promise/signature 分别覆盖 JS/VIS/BUD，core 的 ripgrep/session-runner/tool-read-filesystem 对应 RG/VIS-2/READ，opencode 的 execute/code-mode/read/shell/task 逐项对应 OUT/BUD、VIS/READ/SH/VIS。复用当前已有实例，旧新增实例及仅能验证已绿行为的临时断言不直接搬。历史 opencode/test/server/tui-control-voice.test.ts 和 tool/registry.test.ts 是语音请求隔离、SDK 依赖装载测试夹具，不在上述功能路径，本轮不预先迁移；若原 Gate 重现与本次修改有因果关系的夹具失败，再走新修订。


## 16. TDD Behavior Slices

| 行为切片 | 历史 0dff 红与最小绿（当前仍须重跑） | 原回归入口 |
| --- | --- | --- |
| RG-1 | 合法长记录被提前拒绝 → 三条依序返回；停止、非法记录、超时保持 | 固定 0ab20fa8 的真实 Execute Grep 该单例红（原 65,536 B 错误）；候选为三条依序，保留 Core 原套件、预览和错误控制 |
| READ-1…4 | 首行空、自指 → 完整可交付首行、真实 next；超预算无进度返回真实截断页，原 reason 保留、机器和 XML 均无自指、不登记覆盖 | opencode/test/tool/read.test.ts 原长行/辅助预算/未终止行 |
| PARITY-1/2 | 固定原 GOAL HEAD 的磁盘插件：有声明的 33/40 层和正常 Order 领域类实例仅旧 Execute 报错，未声明的浅层 JSON 原来也只在 Execute 报错；同一真实工具结果候选分别交普通文本或原浅对象。对照已确认普通文本、附件、纯记录原值和真实 Zod/工具错误，MCP 单独证明原 SDK 合同和仅深度时的完整 JSON 交付。 | 原真实 Session Execute 与插件工具用例；仓外重放保留两臂完整矩阵。 |
| SH-1 | 状态通知进入机器正文 → 仅原文；状态与展示保持 | opencode/test/tool/shell.test.ts 原 exit 0/7 保留展示、退出及状态；机器字段迁到原 Session Execute 工作目录实例 |
| OUT-0 | 基线已通过，不制造生产红或保留纯证明断言 | opencode/test/session/execute.test.ts 原失效收据 |
| JS-1…5 | 回调/构造被拒、mapper 预读、真洞集合消费 → 复用同一受限解释器；原字面量/赋值宿主合同、Promise/replace、时间中断与说明按对照保持 | codemode/test/codemode.test.ts 原有数组/内建入口；组合隔离回执作实施前证据 |
| BUD-1/2 | 1025 次宿主调用与 100001 次显式轮次抵达 → 截止于边界，预跑和后续执行状态保持 | opencode/test/tool/code-mode.test.ts 原 preview caps；codemode 原控制 |
| VIS-1/2 | V1 显示完整运行时字段、V2 flag 关闭仍广告 → 各注册 owner 使用公开合同；打开及实际任务结果不退化 | 原 V1 host/schema 与 Task 开关；Core 节点在现有 SessionRunner durable/scoped permissions 实例内承接两个开关断言，不新增实例、不删原断言 |
| EXIT-1 | 0dff 原 Gate 红 → 原样测试 + owner cleanup 与关闭准入变绿；单加 clear 的对照仍红 | packages/tui 原 app-lifecycle、prompt-voice-input；仓外 Solid 实例验证活跃默认时长、替换、到期、退出与迟到调用 |
| SCROLL-1 | 两臂原 partial glob stock 红 → owner-only 私有候选 1/0；切换贴底原断言保持并消除两个 50ms | 同一原 auto-review-render 两用例；依赖 loop/requestRender 残留独立记账 |
| RENDER-1…3 | 独立 pinned real-clock 红绿 + 原 active switch 组合红绿；保持正常 frame、取消 pending、暂停恢复后的活动帧、手工接替与 held async destroy | 原用例原 preload；仓外 probe 只验证渲染器自身 |
| SLOT-1 | 原 preview 在三臂都仅 spinner 红；单读取候选绿，原 loading spinner 渲染与结束消失实测 | 原 preview 和 scan fail，不改两测试 |
| HTTP-SIZE | 基线的有效大正文被5MiB拒绝；删除后进入原输出裁剪。 | 原有webfetch大响应/文本实例及Execute真实HTTP实例，不新增测试文件。 |
| MUTATION | 基线在审批后/提交前变化时拒绝原已批准操作；按最新要求删除后执行原写入。 | 原Deferred时序实例；写入结果按既有全文提交验证，不声称保留外部后写内容。 |

在已有 Read 未终止长行测试中，把 R19 的失败断言改为原结果合同断言，覆盖正文为空、truncated、无 next、无覆盖与 offsetless marker；通过已有长行/辅助预算测试保留可交付边界、显式后移和全原断言。CodeMode 复用现有 public contract 和非 callable 诊断用例验证 mapped/unmapped、显式 undefined、null 源、普通 direct 调用及一次 computed key 副作用；不新立拒测，不扩大负样本。

R22 曾将 CodeMode 公共 JSON-safe 现有测试恢复为 R20 后像。R23 当前范围见下段，保留原数组能力及 JSON 合同断言。R21 临时附加的旧语法构造与双向 null 断言在正式差分中撤回：它们在原有基线通过，只检出中间实现的退化。双向红绿、真正零长原拒绝、显式初值、方向顺序和 map 等控制只保留在仓外核验。

JS-4/5 与 Promise 按固定原 R1 前 HEAD 选择正式断言。取消三条原本绿的 host shape 断言、只为它们服务的 ToolRuntime import/capture/raw fixture，移除合并用例中已实测双绿的 sort 快照输入及期望值，保留单独仓外对照。原睡眠别名用例保留旧正例与三项原 opacity 负例；Math.abs 经实现变为合法，不保留其旧负向检查，也不补在基线同样拒绝的 JSON.stringify 断言。执行代码和测试实例数保持。


本次另用现有 MCP 成功用例带普通业务字段名和独立展示文本，检查先发现、再调用和 direct 与 Execute 得到的实际正文及附件；成功发现不应执行工具。原本就是正确的签名沿用基线测试，不新增只会在中间稿失败的断言。

## 17. 注释

依用户最新更正，本轮新增代码注释全部删除；现有文档保留。

## 18. 验证方法与证据

本轮在 packages/codemode（Bun 1.4.4）执行下面的内存对照。输入同一工具结果的展示正文为 Part A；对照只替换脚本得到的表示。原公共执行层返回 InvalidToolOutput；同次正文返回 Part A；可表示的浅对象返回 {part:"A"}。这次覆盖实际 MCP programResult 与 CodeMode API，不声称重跑 MCP transport、Session 或候选实现。待实施的产品验收用原宿主服务与真实协议入口对比 direct 与 Execute，两边各调用一次；不让脚本手工修数据或比报错文案。

```powershell
bun -e 'import {CodeMode,Tool} from "./src/index.ts"; import {Effect, Schema} from "effect"; import {McpCatalog} from "../opencode/src/mcp/catalog.ts"; const r={content:[{type:"text",text:"Part A"}],structuredContent:{prototype:"Part A"}}; const p=McpCatalog.programResult(r, undefined); const run=(v)=>Effect.runPromise(CodeMode.execute({code:"return await tools.parts.describe()",tools:{parts:{describe:Tool.make({description:"Part information",input:Schema.Struct({}),output:Schema.Unknown,run:()=>Effect.succeed(v)})}}})); const bad=await run(p.value), text=await run(r.content[0].text), plain=await run({part:"A"}); console.log(JSON.stringify({structured:bad.ok?bad.value:bad.error,text:text.ok?text.value:text.error,plain:plain.ok?plain.value:plain.error})); if(bad.ok||!text.ok||!plain.ok)process.exitCode=1;'
```

已在同一包用公共 `CodeMode.make(...).execute(...)` 对照目录查询：同一份零参数工具声明，`parts` 摘要查询返回 `tools.parts.describe`，精确查询 `parts.describe` 则在交付带业务字段的输出声明时返回 `InvalidToolOutput`。宿主工具没有参与查询。这证明只处理业务结果不足；§15 的改动沿用目录已有的“单侧不可展示”协议，可用侧、签名和同页其他工具保持。精确查询及 `detail:true` 共用此路径，普通声明仍按原形状交付（含 `$ref` 和 `$defs`）。

沿用原真实入口的两个验收对照：

- **Read：** 用 `\ntail\n` 从第 1 行读 1 行，`content=""`、`returned=1`、`next=2`，已读记录覆盖第 1 行；随后读到 `tail`。另以无法完整交付的超长首行对照：同是空正文，但 `returned=0`、`truncated=true`、无 `next`、无已读记录。依据是返回行数而非字符串长度。原方案真实 V1 对照还交付了 16,385 字节首行及 `next=2`。空白行是基线兼容验证，不新增永久断言。
- **MCP：** 真实SessionTools→Execute→processor中，32层保持结构，33/40层的完整JSON及其后同级字段交付脚本，附件保持。沿用16KiB展示预算，6042字节样本直接显示，60402及120402字节样本由原截断服务保存完整回执。读回outputPath须逐字等于含Environment前缀的完整父回执，业务JSON、同级字段及模型可见回执同时核对。当前实际候选已按此口径验证。

| 工作目录 | 后续实际候选必须通过的检查 |
| --- | --- |
| packages/codemode | `bun test test/codemode.test.ts test/promise.test.ts test/signature.test.ts`；`bun run typecheck`。原有受限回调、直接调用、排序/稀疏语义、mapper 修改后继值、预算、JSON 和目录单侧详情。 |
| packages/core | `bun test test/ripgrep.test.ts test/tool-read-filesystem.test.ts test/session-runner.test.ts`；`bun run typecheck`。真实 rg、V2 Read 与后台广告。 |
| packages/opencode | `bun test test/tool/read.test.ts test/tool/shell.test.ts test/tool/task.test.ts`、`bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts`、`bun test test/session/execute.test.ts`；`bun run typecheck`。普通/嵌套同输入，声明、附件、无声明插件、预算、失败回执与机器正文。 |
| packages/tui | 原 leak-preload 的 app.exit、prompt-voice-input、partial glob、active switch、preview 和 scan；`bun run typecheck`。按原安装方式和真实终端，不改等待、Gate 或禁动画。 |

本轮工具删减的验证仍记在本 Plan：Core 包运行 `bun test --timeout 30000 test/ripgrep.test.ts test/tool-webfetch.test.ts test/tool-websearch.test.ts`、`bun test --timeout 30000 test/file-mutation.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts`；OpenCode 包运行 `bun test --timeout 30000 test/tool/webfetch.test.ts`、`bun test --timeout 30000 test/tool/file-mutation-concurrency.test.ts test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts`、`bun test --timeout 30000 test/session/execute.test.ts -t 'execute fetch uses|saved fetch alias'`。两包 `bun typecheck`，任务 diff --check。这里的通过只证明对应删减，不替代原完整发布验收。

正式验收包含单提交、原Push Gate/preflight、适用测试与目标平台、实际编译运行及回执。交付终态为当前工作区中的验证实现与本地提交，已有PR保持原状。当前发布父以实时核验为准。

- 从 `gh api repos/SMARK2022/opencode/pulls/5 --jq .base.ref` 取实际目标分支，从 `gh api repos/SMARK2022/opencode/branches/<目标分支> --jq .commit.sha` 取当时的 `TARGET_SHA`。对该父重核涉及的owner；核对最终本地提交的父为该目标、范围内提交数为1，并检查变更文件。用同一对SHA做Gate/preflight；提交前核实目标未前移。原功能验收仍从0ab20fa8计算。
- 同一FINAL_SHA的仓库根用Bun 1.4.4启动原Gate：`bun script/guard/gate.ts push --since "$TARGET_SHA" --sha "$FINAL_SHA"`。用户配置的Guard开关保持原样。本变更触发性能基准，原Gate对不可用preflight会阻断；必须取得实际平台、契约及性能检查通过和push tier退出0。禁止关闭测试/preflight、跳hook、手造stamp或把commit/stop/contracts当作push通过。
- stock Gate 若要求 preflight，必须对应 FINAL_SHA，通过原 workflow_dispatch 的 guard.yml 及 Gate 实际要求的平台；preflight exit=10 为运行中，3 为 gh 不可用，Gate 等待/失败均不得放行。保留首次退出、workflow run/head SHA、各平台结论，使用原 bun script/guard/preflight.ts status --sha "$FINAL_SHA" --base "$TARGET_SHA" / wait --sha "$FINAL_SHA" --base "$TARGET_SHA" 后，以同一 SHA 再运行原 push tier，直到 exit 0。仅在原逻辑明确无需 preflight 时记录不触发原因。无能力时如实阻塞，不能改变 Gate 代码、规则、配置、执行合同。
- 三包以 packages/codemode、packages/core、packages/opencode 各自目录执行 bun run typecheck；执行本 Plan 原窄测试和对应包回归。然后从同一干净提交在 packages/opencode 执行 bun run build --single --skip-install；从构建输出核对真实二进制 hash，使用独立临时 HOME、XDG、配置/数据目录和本地安全测试场景，在真实终端启动构建二进制。保存原生终端截图：应用初始画面、Execute/READ/Shell 与后台开关所代表的真实输出，明确截图的命令和 FINAL_SHA；不用文本转图片。若所需 UI 依赖本地 Web 界面，使用同产物的 opencode web --hostname 127.0.0.1 --port <临时端口> 启动，在真实浏览器加载并保存原生屏幕画面，记录本机 HTTP 成功以及应用/子进程/daemon 的退出。当前 PR 不修改 WebUI 功能。
- 完整构建与本次 TUI 验收分别记账：原嵌入 WebUI 构建仍按上条执行并附同锁干净基线 A/B。已复现基线与候选同一未导出模块失败且拥有者零差分，列为独立 Follow-up，不在本 PR 修 WebUI，也不写成完整构建通过。如最终候选出现不同或更坏失败，应阻断。本 PR 的真实产品是 native Execute/TUI：用同一最终提交的原项目 native 构建及真实终端启动，从测试输入读到真实工具收据、权限与后台开关；启动路由必须能复现且记录实际证据，不能拿 serve+attach 冒称内部 daemon 直启。上述不减免任何线上原 Gate、必过测试、双平台或实现审计条件。

正式依赖安装仍以锁固定的 Bun 1.4.4 及 fork v0.4.3-smark.13 为准；在目标父和候选的干净环境执行原 frozen 安装，校验 lock 不变、实际产出 chunk、平台原生包 SRI、native hash 和正反重放；不要用本地改 node_modules 的成功代替安装成功。历史数据及安装明细见本节附录和原 Plan §20。

## 19. 差分预算

历史实数，以 6dd9a5b 到 dca28c6 的 git numstat 计，含空行和注释，不声称都是可执行语句：

| 类别 | 文件 | 新增 | 删除 | 净增 |
| --- | ---: | ---: | ---: | ---: |
| 项目生产源码 | 15 | 282 | 125 | 157 |
| OpenTUI 依赖补丁 | 1 | 48 | 14 | 34 |
| 既有测试 | 7 | 161 | 27 | 134 |
| 原方案与审计 | 1 | 2,279 | 0 | 2,279 |

上表是历史 PR 的实数，不能当成本轮全部差分。当前新增需求由同一 Plan 的 HTTP-SIZE/MUTATION 行承接；代码只能删除或作必要替换，不新增迁移或生产机制。合并记录时本轮8个生产文件为 +15/-122，8个原测试文件为 +50/-84；失效注释清理与完整审计尚未完成，最终以实际差分重算。所有数值含文本排版与注释，不称为可执行逻辑行数。

## 20. 风险和边界

范围内无待用户决定的产品选择。普通文本与脚本表示各自有事实来源；只能转换已成功结果，不能把 SDK/Zod 错误、真实工具错误或权限拒绝转换成文本成功。不能只因一个字段不能进沙箱就读取整个插件对象或删字段假装结构完整。原 MCP 超深完整 JSON、同级字段、附件以及 Session 截断保存继续验收。原 WebUI 嵌入构建如有同锁基线同错则如实列 Follow-up，不改 WebUI；候选新失败阻断。当前工作区脏，后续绝不整包覆盖；不得扩展到别的 PR、开放宿主函数，或为假想错误增加状态、告警、断言。

直接撤回文件版本拒绝后，原已生成全文会按既有步骤提交，可能覆盖等待期间外部修改；不追加合并机制。取消5MiB接收拒绝增加大响应获取内存，原裁剪仍约束模型可见输出。Goal 三模型消息的先前原话保留在§1，已提出的迁移/锚点实现已撤回；当前没有Goal代码修改，不把该项宣告完成。

## 21. 审计合同

按 docs/guides/workflow.md 独立全量审计 §1 至完整终态、文件、原收据、继承项与实际复现范围；若实质修订，递增版本并清空批准。方案批准只完成本地方案阶段；#5 要等获批版本的实现、独立实现审计及同提交的发布条件全部满足才完成。

## 22. 修订与方案审计记录

| 版本 | 变动 | 审计归属 |
| --- | --- | --- |
| R1–R32 | 原始迭代、逐轮 blocking/放行判词与精确哈希都保存在[固定提交的原记录](https://github.com/SMARK2022/opencode/blob/dca28c6b7839ca036dc0673bf7df028dde7717a0/docs/plans/execute-result-recovery.md#L650-L1438)，本地 patch 的原文完整保留。 | R32 的 verified 只对应 dca28c6。 |
| R33 | 导入原需求、逐文件设计、实验和发布条件。按最新原话保留真实错误，修正成功结果的表示边界；退回固定输出目录和原双向规约，删死报错及只断言中间行为的测试。 | 全量审计 BLOCK，B-01 至 B-04；`ses_ded4465fdffe8DFPed18vSMrJC`。 |
| R34 | 区分本地方案交付与整个 PR 的终态；按实际远端目标定发布父；在原目录详情入口保留可用信息；补回空白行续页及完整 MCP 回执的实测验收。 | 全量复审 BLOCK，仅剩 B-04 的恢复文件比较对象。 |
| R35 | §18 分别核对完整父回执和其中的业务 JSON；不改生产设计、测试入口或交付范围。 | 第三轮独立全范围方案审计：APPROVE。`ses_ded4465fdffe8DFPed18vSMrJC`。 |
| R36 | 将本轮工具拒绝删除、用户的纯减法/亲自实施/唯一Plan约束、执行证据合回原方案；保留原Execute范围。删除误建方案；撤销迁移与重匹配设计。 | 完整方案审计 APPROVE；`ses_dddc8ca5bffeHlG85tbIViXDIQ`。 |

R36交付记录更正：依用户后发原话删除额外恢复归档，终态仍为verify implementation and commit。生产路径、文件计划、功能验收和已批准设计保持；未新增实现概念。

R33 原裁决：**BLOCK — 仅针对 R33，Git blob `39457dd7a2d620343974b1bb2ec5aaf809e7130b`。** 保持 `Implementation allowed: no`。修订同一份本地 Plan 后，按完整 §1 重审。当前不能据此宣告 #5 已可合并。

R34 原裁决：**BLOCK — 仅针对 R34，Git blob `aef9fed0ecec4b9bcb181ff236be95e9239fccdc`。** 唯一剩余阻断是 §18 将恢复文件与裸业务 JSON 直接比较。修正该句后按原范围重审；本轮保持 `Implementation allowed: no`。

R35 原裁决：

No blocking findings.

**APPROVE — 仅批准 `docs/plans/execute-result-recovery.md` 的 R35，审计时 Git blob 为 `ec969a4ddf9828f95f5d069e5c58cbfd2c49e62d`。** 记录裁决后可按 R35 实施。#5 的可合并性仍须由实际单提交的独立实现审计、原 Gate 和同一 SHA 的发布验证确认。

错误拆分的审计仅作历史证据：`ses_dddf10f35ffesZzFDjapVIno0H` 曾审扩大方案，后来用户要求全部撤回；`ses_dddd8a9c9ffe52YPTzJ7dZjGBX` 对五条删减返回 `No blocking findings.`，原判词为“**APPROVE — Canonical plan R4，全范围方案审计第 4/6 轮。**”。该编号属于已删除的误建文件，不是本 Plan revision，不授权宣称R36全范围已批准。

## 23. 实施证据

R36 完整方案审计原裁决（`ses_dddc8ca5bffeHlG85tbIViXDIQ`）：

No blocking findings.

**APPROVE — 仅批准 `docs/plans/execute-result-recovery.md` 的 R36，全范围方案审计。**

审计内容 Git blob：`7e5bfb6f47debc2f5a79bcf22ee46ba206edeb20`。

可原样记录本裁决后进入获批方案的实施与验证阶段。当前工作区尚未取得完整实现审计放行；最终完成仍须满足同一版本的实现审计、发布验证和提交条件。

R32旧收据仍在[原 Plan §23](https://github.com/SMARK2022/opencode/blob/dca28c6b7839ca036dc0673bf7df028dde7717a0/docs/plans/execute-result-recovery.md#L1439-L1817)，其PR头dca28c6当次40项成功、1项跳过。原R35的全套本地实施尚未完成。

本轮 task 实现已经按用户要求撤回：SIZE 8文件、MUTATION 10文件、Goal 8个已有文件恢复到开始前，新增迁移删除；各范围 git diff --exit-code HEAD 返回0。之后以下删减均由主 agent 手工 apply_patch 完成，未暂存、提交或推送。

| 本地验证（Bun 1.4.4） | 结果 |
| --- | --- |
| Core ripgrep 原Unicode实例改为70KiB后，删除前运行 | RED：Ripgrep JSON record exceeded 65536 bytes。 |
| Core WebFetch 原大小实例、V1 WebFetch原文本实例改为>5MiB后，删除前运行 | 两项RED，分别为工具错误与exceeds 5MB limit。 |
| Session Execute真实fetch原实例改用大JSON，删除前运行 | RED：两个fetch拒绝后allSettled没有value，后续取属性失败；未伪称此处直接输出5MiB错误。 |
| 删除尺寸门禁后：Core ripgrep/tool-webfetch/tool-websearch整文件 | 47 pass。 |
| 删除尺寸门禁后：OpenCode webfetch整文件 | 4 pass，完整program正文及展示truncated。 |
| 删除尺寸门禁后：Execute fetch uses / saved fetch alias | 2 pass。 |
| V1原file-mutation-concurrency改为原批准写入成功，删除版本门禁前 | 5 pass / 5 fail，失败均为旧拒绝行为。 |
| Core file-mutation/tool-edit/tool-apply-patch四项原时序实例改期望后，删除前 | 0 pass / 4 fail，旧版本错误拒绝。 |
| 删除文件版本拒绝后：OpenCode file-mutation-concurrency/edit/write/apply_patch整文件 | 211 pass。 |
| 删除文件版本拒绝后：Core file-mutation/tool-edit/tool-apply-patch整文件 | 40 pass。 |
| Core `bun typecheck` | 通过。 |
| OpenCode `bun typecheck` | 首次仅本轮webfetch测试的metadata静态类型报错；改用同等对象断言后通过，webfetch 4项重跑通过。 |

以上为工具拒绝删减阶段的304项初次验证。误建Plan经用户明确确认后已删除；Goal、SQL、迁移与生成文件无本任务改动。后续完整实施、审计和Gate结果见下文。

R36 实施期补充（截至送实现审计）：

- 当前项目已有 §15 的 Execute、Read、Grep、Shell、Task、结果表示、工具拒绝删减及 TUI 改动；均由主 agent 通过 apply_patch 实施。用户质疑 TUI 的必要性，原始要求已补入 §1，交由完整实现审计核对。
- 所有新增代码注释已删除，包括 native patch 的两条注释；这次仅清理说明，不改变执行行为。
- CodeMode 全套：372 pass；OpenCode code-mode/code-mode-integration：83 pass；Core ripgrep/tool-read-filesystem/session-runner：139 pass；OpenCode Read/Shell/Task：384 pass；Session Execute：80 pass。无声明插件既保留旧文本，又在同一原用例检查浅对象程序值，最后该用例单跑 1 pass。
- 当前项目 CodeMode/Core/OpenCode/TUI 四包 typecheck 通过；锁定安装成功，package.json 和 bun.lock 零差分；原静态规则检查 0 errors。
- 独立验证目录 `D:/Temp/opencode/execute-r36-verification` 当时与当前任务39路径差分逐字相同，代码 +543/-367；其 Core 全套1288 pass、9 skip，TUI 全套750 pass、2 skip。后续按用户要求，验收和最终提交以当前工作区为准。
- 该目录完整 `bun run build --single --skip-install` 成功，包含 WebUI；Windows二进制、版本与语音worker smoke通过。二进制SHA256 `220f953b78ed66c2f9aedb0cf9c265caff559fc1e81ebff2b9ccd5396dcd9974`。它是已记录的候选构建，最终SHA构建尚待验证。
- 临时公开入口探针 `.temp/testing/execute-r36-probe-preload.ts`：真实SDK双端→SessionTools→Execute→processor；32/33/40层分别以6042、60402、120402字节检查。32层保持结构，33/40层交完整JSON；深节点后的同级字段与附件保留；模型回执正文与持久化回执相同；恢复文件逐字等于带Environment前缀的完整父回执。另有空白首行与零进度长首行Read对照，共10 pass、91断言。探针不进入提交。
- 对 §18 历史样本的补正：固定原始基线与当前的Truncate默认都为16KiB。当前60402和120402样本均按原预算保存完整恢复文件；6042样本直接显示。最初误按历史60402直接显示断言而失败，已查原基线阈值并以不改变预算的真实合同核验。带附件的模型回执是content类型，最初误用仅接受text的测试辅助函数，随后改为核验content里的文本；生产路径未因此变更。
- OpenCode全套仍在运行：PID 52464（worker 44320），stdout/stderr为 `D:/Temp/opencode/execute-r36-opencode-full.{stdout,stderr}.log`。已出现安装模块两项失败，尚待定位；未把全套记为通过。
- 首轮实现审计时原Push Gate/preflight、最终提交及真实编译终端截图尚未完成；后续进展见审计后记录。恢复归档已依用户更正取消。

## 24. 实现审计记录

R36首次完整实现审计及修正记录如下，最终完整复审尚待完成。R32历史原判词见[固定提交 §24](https://github.com/SMARK2022/opencode/blob/dca28c6b7839ca036dc0673bf7df028dde7717a0/docs/plans/execute-result-recovery.md#L1818-L2279)。

R36 首轮实现审计，`ses_dddc8ca5bffeHlG85tbIViXDIQ`，原文：

````text
## Blocking findings

### B-01 完整验证与发布门禁尚未满足

- **Violated invariant:** REL；实现放行必须具备完整检查通过及同一最终候选的发布证据。
- **Evidence class:** observed
- **Producer and execution path:** R36 候选 → OpenCode 全套测试 → 原 Push Gate/preflight → 最终构建、终端验收与恢复归档。
- **Source evidence:** `D:/Temp/opencode/execute-r36-opencode-full.stderr.log:23-66` 确认两项 installation 测试失败：实际请求 `registry.npmmirror.com`，断言要求 `registry.npmjs.org`。
- **Canonical-plan evidence:** §18；`docs/plans/execute-result-recovery.md:378-379` 明确记录全套仍未完成、失败待定位，以及 Gate/preflight、最终候选验证、终端截图和归档尚未完成。
- **Responsibility owner:** 验证与发布流程。
- **Concrete behavioral consequence:** 当前证据不足以将实现标记为 `verified` 或宣告达到可合并质量；窄测试和另一候选构建不能替代这些必过条件。
- **Pre-R1 baseline behavior on the same path:** installation 源码及对应测试与固定 pre-R1 基线没有差异；本轮未取得同环境基线执行结果，因此不将这两项失败归因于本次产品修改。
- **Round basis:** 首轮实现审计。
- **Minimal correction direction:** 完成同一最终候选的既定验证并核销失败，保持原 Gate，不借此顺手修改无关安装逻辑。

### B-02 新增 Read 辅助函数违反同步逻辑的 Effect 边界规则

- **Violated invariant:** 仓库代码质量门禁；同步校验及结果组装应保持同步。
- **Evidence class:** contracted
- **Producer and execution path:** `ReadTool.execute` 获得 `ReadPage` → `readPageContent` → 正文、续页及已读记录投影。
- **Source evidence:** `packages/opencode/src/tool/read.ts:106-115` 新增函数仅检查已有字段、拼接字符串和计算 `next`，却返回 `Effect.fail` / `Effect.succeed`；调用位于 `:583`。`AGENTS.md:131` 明确禁止无实际 effectful work 的 helper 返回 `Effect`。
- **Canonical-plan evidence:** §15 READ-3 要求收敛页结果及复用一次续页决定，没有授权违反仓库的同步逻辑边界。
- **Responsibility owner:** V1 Read 的页结果投影。
- **Concrete behavioral consequence:** 当前实现未满足必过代码质量规则；此项不主张已经发生读取结果错误。
- **Pre-R1 baseline behavior on the same path:** 越界失败直接位于原 Read 执行器内，没有这个新增的 Effect 包装 helper。
- **Round basis:** 首轮实现审计。
- **Minimal correction direction:** 在原执行器保留越界失败，将正文与续页计算保持同步，去掉这层无实际副作用的 Effect 包装。

### B-03 撤回版本拒绝后仍保留相反行为的注释

- **Violated invariant:** MUTATION 的实际合同及 Comment Rule；注释不得错误描述执行行为。
- **Evidence class:** observed
- **Producer and execution path:** Edit 在审批前生成 proposal → 审批完成 → `Mutation.commit` 持锁提交原内容。
- **Source evidence:** `packages/opencode/src/tool/edit.ts:342-343` 仍声称 coordinator 负责 stale proposal 防护、另一 mutation 先提交时整体失败；实际 `packages/opencode/src/tool/file-mutation-coordinator.ts:81-85` 已直接执行提交。`packages/opencode/src/tool/write.ts:58` 仍声称 proposal 防止审批后提交旧内容。
- **Canonical-plan evidence:** §10.6、§15 MUTATION 明确要求删除相邻失效注释，并承认原批准全文可能覆盖等待期间修改。
- **Responsibility owner:** Edit/Write 的提交调用点。
- **Concrete behavioral consequence:** 源码仍向维护者宣称已经撤回的并发保护，直接误述本次修改的关键行为边界。
- **Pre-R1 baseline behavior on the same path:** 版本比较存在时，相关拒绝描述与执行行为一致；本次删除比较后描述失效。
- **Round basis:** 首轮实现审计。
- **Minimal correction direction:** 删除这些失效的保护承诺，保留现有提交行为，无需增加解释性注释或新机制。

## Non-blocking findings

- §18 保留“60,402 字节直接交付”的历史验收描述，§23 已核实固定基线和当前默认预算均为 16 KiB，并改用 6,042 字节直接交付、较大样本恢复文件对照。建议同步澄清当前验收口径，避免后续继续采用旧预期；实际预算保持不变。

## Follow-up

installation 的两项失败涉及未修改的既有测试与 registry 配置。其产品归因留待同环境基线对照；本 PR 的完整验证仍受 B-01 约束，不据此扩大生产修改范围。

## Rejected speculation

- 不要求恢复用户明确撤回的文件版本拒绝，也不要求增加自动合并、重匹配或替代大小上限。
- 不将已批准的同次成功结果表示选择判为第二次工具执行或第二数据源。
- TUI 三处修改分别对应 §15 的 Toast 生命周期、Show accessor 和 renderer 帧身份；没有据此扩展到其他 UI 行为。
- 未将无关的既有类型风格、测试夹具或未修改的错误处理列为本次缺陷。

## Requirement and traceability coverage

已复核所列生产、测试及 Plan 的完整差分，并沿原调用链核对：

| 范围 | 结果 |
|---|---|
| OUT / SH | 失败回执路径保留；Shell 程序正文改用 `end.text`，退出状态独立保留。 |
| READ | 首行准入、共享扫描扣费、零进度页及无偏移 marker 已实现；存在 B-02。 |
| RG / HTTP-SIZE | 接收限制在原 owner 删除，原解析、转换和模型展示裁剪继续使用。 |
| JS / BUD | Array 构造、mapper、受限回调及两类执行预算均进入既有执行根；双向规约保持原实现。 |
| VIS / PARITY | 公开输入、未声明插件、同次结果表示及单侧 schema 不可展示均有对应实现与回归入口。 |
| MUTATION | 版本比较、专用错误和转换分支已删除；原锁、授权和提交顺序保留，失效说明见 B-03。 |
| EXIT / SLOT / RENDER | 修改局限于批准的资源 owner；其他依赖补丁内容保持。 |
| REL | 尚未完成，见 B-01。 |

新增测试主要复用既有实例，能够针对原能力缺失、大小拒绝和版本拒绝产生失败信号；未发现为中间稿专设的新测试实例。

## Primary-path and fallback verdict

实际差分保留一条真实工具执行路径，未发现新增重试、自动合并或备用解析器。结果表示在原 decoder 成功后选择；真实工具失败及取消仍沿原错误路径传播。

文件版本拒绝按批准的明确撤回执行，其覆盖语义没有被新算法掩盖。

## Code quality verdict

**未通过**，原因见 B-02、B-03。

任务相关 `git diff --check HEAD` 通过。本轮读取了源码、测试、探针及原始失败日志，未重新执行 Bun 检查；Plan 中其他通过数量未被本轮独立重认证。

## Release verdict

**BLOCK — R36 首轮完整实现审计。**

本轮 Canonical Plan 内容 Git blob：

```text
b84c8e952892dddd5b0ec0cf8943a445c52b96f4
```

保持 `implementation-audit-required`。解决上述事项并补齐验证后，对完整实际差分复审；当前裁决不支持标记 `verified` 或完成终态。
````

返工记录：B-02 已将页投影改为同步结果，原执行器继续用 Effect.fail 交付越界错误；一次性续页决定仍由页结果复用。B-03 的三行失效注释已删除。当前工作区 Read 85 pass，OpenCode typecheck通过，原静态检查0 errors，新增代码注释扫描为0。未再次送审前保持原BLOCK裁决。

B-01进展：原NpmConfig在官方源探测失败时选择npmmirror；对测试进程设置现有 `OPENCODE_NPM_REGISTRY=https://registry.npmjs.org` 后，当前工作区installation原套件39 pass。未修改安装源代码或测试。当前工作区全套OpenCode已由PID42964启动，日志为 `D:/Temp/opencode/execute-r36-main-full.{stdout,stderr}.log`。旧目录全套已有两项失败，停止该自建进程树的工具调用被权限检查拒绝，未绕过；保留其独立日志。

当前工作区完整构建 `bun run build --single --skip-install` 通过，含嵌入WebUI；Windows版本和语音worker smoke通过。二进制SHA256 `d4191af1051bcec151355b0623459ef0044a0497b9417537bcbc5b8e2e37680f`。实际本地HEAD及远端目标当前均为 `99031fc6a07a63822520ab0103b903a09eb28ea4`；pre-R1功能基线仍固定为0ab20fa8。

候选提交 `41e28e263b74754efc38eda9f575b783bdd20a7f` 以当前工作区文件创建，父为99031fc6a0，原pre-commit与commit-msg均通过；当前分支及原index未改。原Gate已触发 `preflight/41e28e263b74`，run `https://github.com/SMARK2022/opencode/actions/runs/46160279809`。首次push tier因等待CI退出1；Linux、规则与契约、性能基准已成功，macOS待结束。命令设置GUARD_PREFLIGHT=required被工具拒绝后，改用原Gate默认配置，未修改任何Guard开关，实际preflight未跳过。

当前编译二进制通过原TUI→自动daemon启动路径完成只读验收，使用已有OPENCODE_LOCK_PATH及XDG环境隔离测试数据，未采用serve+attach。实际回执含 `R36_READ_OK`、`R36_SHELL_OK`、`background:false`。原生窗口截图位于 `D:/Temp/opencode/execute-r36-native-receipt.png` 与 `execute-r36-native-home.png`；使用Win32 PrintWindow捕获真实窗口。通过既有TUI命令正常退出后，客户端、conhost、daemon PID均退出，daemon status返回running:false。用户已授权清理测试进程；旧目录失败测试及本地模型服务已清理。

候选41e28e263b74的原preflight现已全部成功：Linux、macOS、规则与契约、basic/extended性能采样、性能基准及guard-required；PR评论按原workflow跳过，预检分支按原workflow自动清理。再次执行原push tier退出0并输出“全部通过”。run为 `https://github.com/SMARK2022/opencode/actions/runs/46160279809`。当前39个生产/测试/依赖补丁路径与该候选逐文件零差分，只有Plan继续记录用户更正及验证结果。

R36第二轮完整实现审计先保留B-01等待独立GitHub核验；同一轮续审通过只读gh查询和原始job日志关闭B-01。原完整最终裁决如下（`ses_dddc8ca5bffeHlG85tbIViXDIQ`）：

````text
## Blocking findings

No blocking findings.

B-01 已关闭。已通过只读 `gh` 查询及原始 job 日志独立核验 [run 46160279809](https://github.com/SMARK2022/opencode/actions/runs/46160279809)：

- `headSha` 为 `41e28e263b74754efc38eda9f575b783bdd20a7f`。
- 比较基准为 `99031fc6a07a63822520ab0103b903a09eb28ea4`。
- 整体状态为 `completed / success`。
- Linux、macOS、规则与契约、basic/extended 性能采样、性能汇总及 `guard-required` 全部成功。
- 平台日志确认执行了原 `gate.ts suites --since <基准>`，并非仅运行静态检查。

## Non-blocking findings

保留上一轮的记录更正：§18 的历史 MCP 大小样本描述应与 §23 已核实的 16 KiB 预算口径区分。无需修改生产预算。

## Follow-up

无新增产品 Follow-up。本地 Windows 全套日志尚无结束汇总，继续保留其未完成记录；本轮必过跨平台测试已有同一候选的原 preflight 全量结果。

用户取消的额外恢复归档不再作为交付条件。

## Rejected speculation

- 不要求增加替代大小限制、自动合并、重匹配或新的兼容路径。
- 不把原 workflow 合法跳过的 PR 评论、失败日志上传步骤视为测试跳过。
- 不将已通过 CI 的同一实现，因重复本地测试尚未结束而重新判为未验证。

## Requirement and traceability coverage

本轮完整源码、测试及调用链复核结果保持，覆盖 OUT/SH、READ、RG/HTTP-SIZE、JS/BUD、VIS/PARITY、MUTATION 和 TUI 生命周期。

独立核验的原 Gate 全量测试结果：

| 包 | Linux | macOS |
|---|---:|---:|
| Core | 1,293 通过 | 1,292 通过 |
| OpenCode | 5,460 通过 | 5,460 通过 |
| TUI | 752 通过 | 752 通过 |
| CLI | 3 通过 | 3 通过 |

规则检查报告 **0 个错误、0 个提示**；Schema、Protocol 契约测试通过；两组性能采样及汇总成功，冻结依赖安装成功。

再次核对 Git：

- 当前生产、测试及依赖补丁与上述候选 **零差分**。
- 候选父提交与实时目标分支 `dev1-smark` 均为 `99031fc6a07a63822520ab0103b903a09eb28ea4`。
- 当前任务差分的 `git diff --check HEAD` 通过。

## Primary-path and fallback verdict

通过。工具执行、授权、业务解码及错误传播继续使用原路径；结果表示只消费同次成功结果。文件版本拒绝按明确要求撤回，未引入备用执行、自动合并或重试机制。

## Code quality verdict

通过。

- **B-02 已关闭：** Read 页投影保持同步，越界错误由原执行器交付。
- **B-03 已关闭：** 指认的失效并发保护注释已删除。
- 本轮返工未扩大生产设计，未发现新增代码质量阻断。

## Release verdict

**APPROVE — R36 本轮完整实现审计通过。**

裁决绑定：

```text
实现候选：41e28e263b74754efc38eda9f575b783bdd20a7f
比较基准：99031fc6a07a63822520ab0103b903a09eb28ea4
Plan blob：070bf8d040ca9a8d93eb48444c6656b9bcdd2af8
```

可原样记录本裁决，将该实现标记为 `verified`，继续完成已授权的本地提交。此批准针对当前受审差分；现有 PR #5 仍指向旧提交 `dca28c6b…`，本裁决不替旧 PR 的旧实现背书。
````

依据本裁决设置verified，仅记录裁决、同步MCP样本口径和用户取消的交付项；生产与测试未改变。最终本地提交仍执行原hooks，且以最终提交再次核验原push tier。

### 附录：沿用部分的实验证据（原文，按当时的版本解释）

下列原文保留实验输入、实际结果、范围、命令和发布物核对步骤，供独立审计重放。附录使用旧 revision 的“当前”“待审”等原称，既不定义本地实施路线，也不表示本机已执行。


### EXIT-1 已执行的方案验证

实际 Bun 1.4.4，原 Guard preload，cwd packages/tui；输入、stdout/stderr、exit 分开保留。以下标签为回执标识，全部阶段 1 临时隔离，不能当作最终发布 Gate。
- 双红：pr5-exit-stock-pair（0dff 与冻结 4ed），两臂 0 pass / 1 fail：原 Guard 仅报 Toast 同一 5000 ms、无残留子进程。基线 stderr `9f179c4e54c59a45d5dafe65d00fefe4756bed5d854a2f71fee3c0cd77540d99`，候选 `198c7a49278ebb896b702d94ebcf59892413f4d3c93b3d211d2a186a3341b4ba`。
- 只清理 active handle：pr5-toast-owner-overlay，窄测失败；原两文件 33 pass / 1 skip / 1 fail。独立 trace pr5-toast-owner-trace 明确捕获 cleanup 后的两个 GET 错误，stderr `8e268c635531a0ba8c32d3f2564a72f850e9b67e498e98dea1e36fc907a2839d`。有探针的运行不作绿验。
- 无探针完整 Toast owner 隔离候选：pr5-toast-owner-closed，原窄测 1 pass / 0 fail，原两文件 34 pass / 1 skip / 0 fail、186 断言。stderr SHA 分别 `73922fa150fbb93f91b132398c8437384d6314c5ad0039e8964d3ce9b172c17a`、`edc97318d30e2f092b8dc01b8079fdcf9df3730564c415beb41f9ee5913e1c19`。
- 仓外临时 active probe pr5-toast-owner-active，1 pass / 0 fail、6 断言：默认 5000 ms 通知、替换、实等时间后消失、退出释放仍活动的 handle、退出后迟到调用不写入。原 Guard 检查残留 handle 为零。stderr `815ce3880945a456aa071895e270b23a3cd4b633a1f950afaab783236f48d855`。
- 实施时以原 `bun test --dots --preload ../../script/guard/leak-preload.ts test/app-lifecycle.test.tsx -t "app.exit prints the session epilogue after scoped cleanup"` 及同 preload 的原两文件（另一个为 test/prompt/prompt-voice-input.test.ts）先验证；再跑新增 owner 的 packages/tui typecheck、最终差分的同一 stock Gate、真实编译产物及实机 TUI 正常退出，记录实际命令和退出，不能借窄绿宣告整个 Gate 通过。

### SCROLL-1 已执行的方案验证

固定发布 HEAD 0dfffcda 与 R6 实际差分 645aac8f…f36d0f9，锁定 Bun 1.4.4、loopback/devpts、cwd packages/tui 相同。原命令 bun test --dots --preload ../../script/guard/leak-preload.ts test/routes/session/auto-review-render.test.tsx -t '^completed partial glob remains visibly incomplete with details off$'。两固定臂均 exit 1，1 fail、2 断言，唯一 Guard 资源是 50ms scroll handle；原始输出目录 scroll50-original，清单 SHA256 a8fef3e802cffbf3db79d02811c4b561126ec58a3da12f6195cf4e19eb6b2bee。
- 0dff 私有 owner-only 投影相同用例 exit 0，1 pass、2 断言，2.37s。临时差分 SHA256 3a6c86b7d188012399405b4965eb94ee5e5eb05897071a5298f67b545c4ec630。
- 同 preload 原用例 switching sessions after scrolling away still opens the next session pinned to the bottom。两组各 2 断言；失败均只在 Guard afterEach。原组匹配两个 scroll 50ms 和三个 OpenTUI 独立句柄；原型组 scroll 为零，但两 loop 加一个 requestRender 仍红。整体未标绿。回执 scroll50-owner，清单 SHA256 96088556a94e509b612ed03393ea65bed3deb07651df1c07762a7328d90c869a。
- 批准实施后同步复跑两原用例、包级类型检查、整版实际构建与真实应用验收，再执行原 Gate 并交独立审计。窄测不能替代原 Stop、preflight 或完整实际差分审计。

### R8 方案阶段已运行的组合证据

- 冻结 R6＋SCROLL-1＋RENDER 初两处仍只报 1 个 requestRender（b06-combined，原 active switch 两断言，exit 1）；追踪（b06-late-trace）确认是 destroyed 后 detach 导致新建。无探针对照加入 owner 早退后，原 active switch 和 partial glob 均 1 pass / 0 fail，各 2 断言；独立原 real SystemClock 控制确认正常激活/手工接替保持，销毁后未触发 pending，也不从 held async frame 再安排。回执清单 SHA256 aa0c73f488edc26c19db5415602028b27df2bfd1abef4b2e6667a0921cb24758。该运行只用私有安装映射，不是正式依赖安装或 gate。
- 三臂固定基线/R6/上述组合，对原 preview 精确完整名字均只触发 pinned Spinner ~79.94ms interval（4 断言），原 slash command 对照三臂单跑全绿。真实 trace 发现两次构造、一处 destroy。只修 DialogSelect 中原 Show accessor 的无探针私有候选，原 preview 1 pass / 0 fail / 4 断言；原 scan HTTP failure（原生加载显示转圈，完成后消失）1 pass / 0 fail / 3 断言。原样 preload。清单 spinner-owner-proto/SHA256SUMS SHA256 9a874eb83591ea85d1efcf9d7e415ca94dcdd6a0f6e5378971052760924318f8。
- 以上证明单点语义与组合中的两条 RENDER/SCROLL 原用例。尚未用一个正式 carrier 汇集全部内容跑及格的 original Stop；不可把私有已绿、R6 的实机或单次 spinner 结果当作 R8 交付。批准前下一实证可用同一个隔离投影串联 known-green 原用例；正式体量的目标用实际选定 carrier、完整 stock Stop / Push tier + 必需 preflight、所有受影响包的原类型/测试、真实 native build 与 TUI 行为；原 32 文件依然可能暴露其他 owners。

### R9 暂停恢复的原行为与对照

原 GOAL 基线的注册入口即会调用 OpenTUI 的公开暂停恢复路径。外部编辑器 `packages/tui/src/editor.ts:31,51–52` 先挂起，编辑退出后恢复并请求重绘；终端挂起 `packages/tui/src/app.tsx:1035–1036` 由 SIGCONT 恢复。原发布依赖丢失正延时句柄；R8 给单一字段后，`suspend()` 清除 `updateScheduled` 却仍留下此前的真实 timeout，恢复会覆盖字段。旧回调可能在恢复后先消费新一轮安排，连 `idle()` 后销毁也仍有残留。首次失配发生在 renderer 自己撤销帧时，无需改调用者。

R9 的同 owner 补充保持一个活动字段：挂起撤销时清理已失效的正延时句柄，原销毁也调用同一私有函数；正常触发前仍先清字段，可活动的恢复帧按原策略新建。保留延迟公式、直接 nextTick、持续帧、编辑器数据、输入和原 native 接口。下面两类 Probe 均使用真实 `createTestRenderer` / `SystemClock`，只在隔离测试选 maxFps 10 留出窗口，未改原运行配置。退出码是探针运行状态，红绿看真实句柄。

- 同公开 API 先请求→暂停→恢复→再请求：R8 的 immediate 销毁臂挂起后仍 1 件，恢复后 2 件，销毁后旧 1 件实际触发；idle 臂旧任务先处理，销毁后第 2 件实际触发。修订两臂挂起后零件，恢复各只安排第 2 件。immediate 无回调触发；idle 只触发第 2 件一次，销毁后零件。
- 用原 `openEditor` 与真实 `/usr/bin/true` 子进程（保留输入文件内容）跑同两臂，R8 仍分别出现销毁后第 1/2 件触发，私有修订均为零；idle 臂第 2 件活动帧在销毁前触发一次。产物仅供方案核实，未验证真实 SIGCONT 用户操作，实施阶段在同一原生候选补一次终端挂起与恢复验收。
- 私有修订下，原 preload 的 active switch / partial glob 各 1 pass、2 断言，普通立即销毁、idle、手工替换和在途异步帧销毁控制均 exit 0。清单 `b07-suspend-clock/SHA256SUMS` SHA256 `ddc40a313da44b33e047d6b1b514e6290b1dae97e549e66d5ef0bba2e8a977a6`。正式实现冻结安装后需复跑这些负责路径及原 Gate，不沿用 R8 chunk 作为 R9 候选哈希。

### R10 一次帧所有权的完整路径

原 renderer 仅在 `requestRender()` 的非运行、非渲染、无现有安排分支创建一次帧。原布尔状态所有改写为：同入口置 true，`internalStart` / `suspend` 撤回，`activateFrame` 完成后结算。销毁清理在非渲染或异步在途路径都进一次 `cleanupBeforeDestroy`。`internalStart` 的实际来源是显式 start、首次 requestLive 和恢复先前运行 renderer；requestLive 来自 Renderable live 计数和 RAF，消费 RAF、移除最后 live 子树会 dropLive。pause/dropLive/stop 只有已有 continuous 停止逻辑且不重置一次帧；`scheduleRenderTimer` 和 loop 连续/回压路径持有独立 renderTimeout。因此只在一次帧记录失效点统一清除，不扩大暂停/停止的既有行为，也不改变 feed、interval、native 或应用调用者。

具体的 R9 红：真实 live 转换中，一次帧 1 在 start 时已失效但活着，continuous 2 开始并由 dropLive 正常清除，新的 3 盖过旧 1；立即销毁后旧 1 实际触发。idle 对照中旧 1 先抢走新帧的资格，最后 3 又在销毁后触发。R10 单活动记录分别承担两件事：仍待运行的 timeout 在所有作废分支取消；已入队的零延时或在途异步回调只对同一记录执行/结算，旧记录无权影响新记录。无需收集历史句柄集合。原 delay 公式、公有调度状态返回的布尔意义、活动 live 帧与手工帧保留；现有 renderer 声明中的旧安排字段和 activateFrame 都是 private，不改变公开类型或 native ABI。

- 同真实 SystemClock：start 后只剩连续帧 2，drop 后普通请求只剩恢复帧 3。立即销毁无触发；idle 臂 3 只正常触发一次。真实 global RAF 回调一次；显式 start/pause 对照及零延时 nextTick 均运行，销毁后零待触发句柄。
- 复验原编辑器子进程两臂、纯 suspend/restart、普通、手工替代及 held async destroy；原 active switch、partial glob、preview、active scan 四条原样 preload，共 11 原断言，均 exit 0。全组 12 命令 exit 0，红绿由事件和源码边界核对。原清单 `b07-live-owner/SHA256SUMS` SHA256 `4e2ad2fcef71910ceb454bd5f7c9d11a89c59eadc467893f65f4f250511871b1`；本轮隔离 chunk SHA256 `c139c831925bc66907d0389c63f389412ff25ef78f77bd9d96ff19b0c5ce7acb`，正式补丁和冻结安装尚待独立批准后的实际实施，不能沿用旧 R8/R9 候选。
- 实施后依次复跑上述 owner/race 对照、四原夹具的原 preload、原所有 Gate；同精确原生候选核验编辑器与终端恢复，保留 §20 的共享红放行条件。

### R12 数组方法的唯一收敛与 Gate 红反馈

R12 历史发布基线为 0b5754df，原 GOAL 实施前 HEAD 为 0ab20fa8。相对该原 HEAD 的全部行为目标、TDD、实机与单提交范围保持。#5 临时验证头 82e2baa4d8192a8fd149f949e9652cf5e4964a75 与验证用 merge checkout e3773b6a7be7baa16efb1f2279f5d4c018811acd 对应同一候选树 fb37b16684192f90a09d2038cd2edc491bc4b5e5。新 Guard 的原冻结依赖安装在对应 runner 实际通过；规则报告仍因 runtime.ts 的原尺寸条件阻断。原头和实际发布头该文件同一前像 3636 行；临时候选 3766 行，+130；新 `script/guard/size.ts:44` 判断 `r.net > BIG_FILE_GROWTH`（原上限 100）。不加例外标记、不调整配置、规则、原测试或基准。

仅收敛已涉同一 `Interpreter.invokeArrayMethod` 的两个重复循环族，原作者责任不变：
- `some` / `every` 共用同一个 present-slot 游标；每个空槽仍等量让出调度，不调用回调。按固定布尔终止值短路；无命中返回其反值。原 callback 仍接收元素、当前索引、同一个 snapshot；在 callback 修改 snapshot 后，后续索引按原 iterator 实时访问。
- `reduce` / `reduceRight` 共用带方向的游标，重复的首个存在下标查找、让出调度与 reducer 调用收口。正向边界每步读取当前 snapshot 长度，反向以 0 为下界；原有无初值长度条件、显式 undefined 初值、空槽处理、回调参数与两条报错文本保持。原公共入口、apply dispatcher、Array.from mapper 和全部其他数组方法均保持。

这是同一个运行时文件的一处语义性替换，70 行→40 行，R12 私有结果 3736 行，较当时基线 +100；R16 以最新 8aead09 的精确前像重放，仍是 3636→3736、净 +100。保持正常代码分行，不迁移现有行、注释挤压或新增模块。拒绝顺手改 Array.from 无 mapper 分支：这两族即可消掉全部 30 行且不增加审计范围。

在 R12 当时的同一 0b5754df 历史投影、相同 Bun 1.4.4 和当时的原 leak preload，临时候选 R11 与 R12 私有实现均运行原 `test/codemode.test.ts` 两条数组相关实际用例，每臂 2 pass / 5 原断言，四个真实命令自然退出 0（两 stock、两探针）。私有探针通过公开 `CodeMode.execute` 独立验证 some/every 跳洞、回调写下一个尚未读下标和短路迹线，双向 reduce 首项/显式 undefined、全洞报错与动态 Array.from mapper；两臂输出逐字一致 SHA256 `f085ddc4827bf68d8a28debde05109cfa4ebc8a817e61a88c040c58921708d03`。精确私有单 hunk SHA256 `17e3ee9fb6c649cf089e3625587ef3f6113b9b82582d8235d3a413ec40645f0e`；原始对照回执清单 SHA256 `48532ff029a3c01e0cc81400675021db1977b51c4f73b24ac77adc68538f57c5`。私有探针不加入仓库；旧候选树未变。

获 R16 精确独立方案批准后，才将 §15 的 21 条代码、原测试和既有补丁路径实施到 8aead09f29652c5acf5004675845873ab1d22a58，连同唯一 canonical Plan 为单提交。复验原公开红绿、包回归、§18 的真实 viewport fixture 和当前启动路径；原尺寸检查为 `bun script/guard/check.ts . --commit <candidate> --changed-since 8aead09f29652c5acf5004675845873ab1d22a58 --no-trailer`。正式编译、实机、Gate、CI、A/B 和独立实现审计均绑当前实际交付。

### 原 B-08 的历史 Gate 复验（R13/R14，98a9f13）

固定最新目标的 8 个差异文件均为 Gate、其说明、报告或覆盖图工具，和 #5 原 22 路径、包源码及锁文件无交集。该目标正式脚本将默认模拟响应改为每个伪 token 1 字节：20,000 个产生 20,000 字节，不再沿旧默认产生 137,800 字节并越过产品的 65,536 字符限额。修复来自已合入的 #10，一次正式验证采用目标自带脚本；#5 不修改 seed、tokens、阈值或 Gate，且没有备用运行路径。

在精确 98a9f13 checkout 上通过隔离 launcher 跑了最小真 seed。私有拷贝保留目标脚本的模拟 SSE、真实产品启动、POST session／message 和 assertReply；只替换 worktree／安装编排为预置只读依赖，并在 seed(1,1) 后退出。默认 TOKENS=20,000。旧模拟正文对照在同一产品上得到 MessageOutputLengthError，探针 exit 1；切换到目标自带的模拟正文后 exit 0，实际启动 1 条 SSE 流且完成后活跃流为 0。两臂只替换该模拟正文表达式，未减 token。命令、探针和原始退出的回执清单 SHA-256 41b4bcf9311b4e4694bf1b06af0df95949c0e7e258dae635a783f7f311ec9d75。此窄证据验证原 B-08 首个失败点已闭合；完整 seed、正式冻结安装和 stock A/B 仍须实际执行。正式用同一 R14 单提交记录目标及候选安装结果、PR workflow policy/base/head/source checkout、完整 seed 后真正进入并完成 A/B 的结果；rules 与 guard-required 必须成功。暂不能完成最小 seed 时单列环境阻塞，不能以源码预期替代。

98a9f13 的 guard.yml 删除仅针对受保护路径的标签检查，仍按目标分支规则跑 rules 和 bench，guard-required 要求产品 PR 的二者实际成功。既有 Core patch 继续由原选择器按全量输入处理，按 preflight.ts 所报同一目标、候选和全部平台复验。禁止沿用 R12 旧比较基准、旧诊断树或单点检查作为通过。

### R15 历史 Gate 与方案阶段红绿（27f5f62）

目标分支从 98a9f13 经 f0eb1b28 到 27f5f62，9 条变化仅在 Guard、workflow 及其说明/测试，与 #5 的 22 条路径无交集。独立空索引在 27f5f62 上无冲突地投影已公开 R14 的 21 个产品、原测试与补丁后像；每个后像的 Git blob 都与 d10c521 相同，投影树为 `d65c1ee026c2abb1abd7031d31ccb377bf972418`。该树不含本 Plan，不是实施或最终提交。R15 不重写用户行为、owner、公开协议、已有测试实例和 OpenTUI 载体。

- f0eb1b28 让原 Gate 输出早期测试失败和完整失败日志位置。原 GitHub preflight 若 Gate 失败，按平台保留 `guard-logs-<平台>`，包含 `.git/guard/logs/*.log`，保留 14 天。实施审计按实际工作流 ID、head/base、失败步骤、平台和 artifact 复核完整日志；下载日志是查因动作，Gate 仍按原退出结论判定。
- 27f5f62 建图为失败、缺 LCOV 或不可解析的单文件保留空记录；至少有一份有效覆盖才写图。选测保留未成功建图且仍存在的测试。原 `ESCALATE_FULL` 对全局输入的升级仍生效，#5 的唯一 Core 补丁无需依赖成功地图选中全量，也没有跳过失败文件。此范围保持当前 Gate 原判定，不在 PR 里改 Gate。
- 以最新目标工作树和精确 22 路径实跑原 `bun script/guard/affected.ts . --files <逗号分隔完整路径> --json <工作树外文件>`，Bun 1.4.4，exit 0。现有 `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 触发 25 个包全量，共 809 个测试文件；其中 OpenCode 323、Core 161、TUI 95、CodeMode 7。选择 JSON SHA-256 `128d4895ad588a606f1c41bf4f7ada45eaabfe9f186e63acfe2f13a5c6e12df6`；这是实际选择，尚未执行它选出的全量。原 workflow 可执行契约与要求的平台按同一最终 SHA 验收。
- 阶段一在两个独立 CodeMode 包投影中，对精确 27f5f62 和上述候选树用原公共 `CodeMode.execute` 跑同一临时探针。输入 `Array.from([2, 3], (value, index) => value + index + 1)`，配置相同真实锁定 Bun/Effect/Acorn，不含宿主工具调用，探针令 fetch 立即拒绝。基线回传 `UnsupportedSyntax`、exit 1；候选返回 `[3,5]`、exit 0，双方 0 个工具调用。回执清单 SHA-256 `c9d46012507a78cc64acd654d85f6877e17ad3562cc2f4344ca446b030bf5da4`。该红绿覆盖 JS-1 的用户症状；后台签名仍按 §16 的真实 V1/V2 注册 seam，不把解释器假目录当 Core owner。
- 独立的当前基线 Core 窄复验使用 27f5f62 原 `test/session-runner.test.ts` 和 stock leak preload。原场景 159 个业务断言通过，清理阶段仍留 `setTimeout(600000)`（无子进程），exit 1，2.88 秒；清单 SHA-256 `a054cf8f0e25929a987a7248acd5c0864ed71effb1e524ff3956aaf2e89621ec`。结合 §23 的 R14 精确两臂和 owner 探针，B-01 仍是原 Core 清理阻断。R15 不改原定时器、Gate 或原测试；不以本次选择成功、窄业务断言通过、旧 Auth/Guard 或旧独立判词放行正式 PR。旧 #5 的正式 Auth 是 225 项通过后仍不退出。独立 27f5f62 本地 Auth 只确认选出 225 项且无缺项或额外项，未打印完成摘要，70 秒外层时限后退出 124（清单 SHA-256 `566a1efe1902b8a9778e33493cf58a2456ad74f5f5adf41d26a89ea47818127b`）；两次失败阶段分别记账。实施时用最终 SHA 的正式 CI 复验业务通过并自然退出。

### R16 历史 Gate 与方案阶段红绿（8aead09）

当前仓库只前进一笔原提交：27f5f62→8aead09。五个变更与 #5 的 22 路径无交集：Core 的 `src/plugin/internal.ts`、TUI 的 `test/routes/session/session-viewport-follow.test.ts`、Guard 的 `affected.ts`、`select-tests.ts`、`test/selection.test.ts`。本轮以独立空 index 重放实际 21 个产品、原测试和补丁，后像逐一与 d10c521 相同，无冲突，产品树 `8814dd23ac0787e542057e3f9c64c3ea06bc1a35`。此树只供方案阶段验证，不含本 Plan，不是 release commit。原用户需求、核心 owner、预算、单提交及无新测试实例不变。

- **上游入口漂移。** Core 不再静态导入 Provider registry，由 host Layer 构造时加载，保持 Provider 模块反向引用 `define()` 的初始化边界；不修改这条主线路径。它可影响应用启动时序；当前真实构建/启动和 stock A/B 必须按最新目标重验，不继承 R15 的时序数据。TUI 现行已存在的 viewport follow fixture 增加 `ManualClock`，从真实 route 读取 `syncSessionViewportStuckToBottom` 的生产回调并驱动原生渲染。R16 保留该上游 fixture，不将其改写到 #5。
- **最新既有 TUI 窄测试。** 在两条独立投影中运行 Bun 1.4.4 和原 `leak-preload.ts`，路径 `packages/tui/test/routes/session/session-viewport-follow.test.ts` 不变。0、1、3 行三组 bottom-gap 均通过，每臂 3 pass/0 fail、43 断言，退出 0。基线使用已锁 baseline renderer `dcfc16da…`，候选用已有 Core patch 产出的 renderer `9c87d9c…`，原生库 SHA-256 `ab485d6a…` 相同。候选第一执行因自启动路径中的原生包链接不可见而在加载前报错；保持文件不动，改用只读、断网的 `/app` 投影复验通过。初次及基线回执清单 SHA-256 `ec3e38b639612a7d4840da0f29cd81265d2fb37afe08678f717d59b9f758a34b`；候选正常回执清单 SHA-256 `0c4ca68c476aa2e209a446a90599c63d9ca34bd655b7fb2f662d60bcbdc8d01c`。
- **当前 Execute 红绿。** 从当前基线及产品候选各导出精确 CodeMode 模块，Bun 1.4.4 运行同一禁用 fetch 的临时公开入口探针。原请求 `Array.from([2,3], (value,index) => value + index + 1)` 基线回复 `UnsupportedSyntax`、exit 1；候选返回 `[3,5]`、exit 0，均为零宿主工具调用。回执见同一 fresh-narrow 清单。后台签名仍见 §16 实际 Core 注册路径，不能以纯解释器替代。
- **选测与失败记录。** 当前原 `affected.ts` 让 sdk-next 源码保留在依赖图，但排除其独立套件选测；覆盖图为实际包目录统一 realpath，并给失败子进程日志加前缀。失败记录和旧正式日志上传合同仍使用目标中已经合入的版本。对 22 路径实跑原静态 selector：现有 OpenTUI Core patch 作为全局输入，选中 24 包共 807 个文件，包含 Core 161、OpenCode 323、TUI 95、CodeMode 7。未运行这些全量套件。实际选择 JSON SHA-256 `718ab2cf56cd26eccc50ce010643ac756a2e97272fc76119297e27143f6d1e68`。保留原 Gate 的契约测试步骤与按实际平台决议，不把静态选择成功写成 Gate 通过。
- **当前遗留。** 当前 8aead09 的独立 Core 窄跑仅执行既有 SessionRunner 相关场景：159 业务断言通过，原 fixture 后置清理仍发现一个 `600000 ms` ref、无遗留子进程，Bun 3.21 秒、exit 1；回执清单 SHA-256 `be82fff710d0373d92f6ced0b62794551488e2e3181e474b9f607415dce0cec4`。它单独证明此场景仍能触发残留，不判定整个正式基线 Gate。旧 R14 正式 Auth 225 项通过后不退出，与 R15 本地摘要前超时是两种记录；当前 8aead09 的正式 Auth、预检和 #5 最终 A/B 仍需核验。独立的上游基线 preflight 用官方工作流记录；即使基线通过也不能替代 #5 最终 SHA 的检查。

### R17 历史验证（5bc061b）

GitHub 目标 ref 与本地精确对象一致。自 8aead09 起有 0b2d39a、6ac1bb0 和 5bc061b 三个原提交，累计 13 个变更路径。原 AppRuntime 在宿主释放时关闭 serviceScope；HttpApi exerciser 退出时先释放已建立的 App，再清理凭据 fixture 临时目录。两条上游生命周期都保留，未进入本 PR 补丁。CodeMode、Core、Guard、锁和安装配置的目录树或 blob 身份与 8aead09 相同。用独立空索引应用 §15 的 21 路径并逐字比较后像，零冲突、零差异，产品树 `5666007b10724acdec0e66c67925932c700084ca`。该索引只用于重新验证方案，计划工作树未写入实现。

- **Execute 红绿。** 精确基线与上述候选各导出 CodeMode 包，原 Bun 1.4.4 跑同一临时公开入口探针 `bun run mapper.ts`，断言 `Array.from([2,3], (value,index) => value + index + 1)` 得到 `[3,5]`。基线在第 1 行第 8 列返回 `UnsupportedSyntax`，退出 1；候选返回 `[3,5]`，退出 0。两臂均无工具调用或网络请求。正式实施在原 CodeMode 数组行为用例内补断言，保留无 mapper 与逐项读取对照。归档清单 `b6bd1125fca027d983c7c7231b0bcf6cd234bf2366139cf40d26046255d35b0b`。
- **Core 后置检查。** 精确 5bc061b 的原测试与原 Guard preload 运行 `executes and resumes canonical task sessions with durable results and scoped permissions`。业务用例通过，159 个断言；后置检查捕获一个 `setTimeout(600000)` 引用、无子进程，2.77 秒退出 1。Core、preload、锁和输入与 8aead09 相同；此前 8aead09 的基线与 #5 候选两臂同红。继续按本版正式 Guard 验证影响；若同一红仍阻断，先确认原 owner，再判断是否必须另作方案处理，不在此版添加计时器、掩盖原检查或扩大实现范围。
- **原静态选测已跑。** Bun 1.4.4 执行原 `script/guard/affected.ts`，绑定当前基线、锁定 TypeScript 和确切 22 条目标路径。退出 0；OpenTUI Core patch 仍使 24 包、807 个测试文件被选中。选测 JSON SHA-256 `718ab2cf56cd26eccc50ce010643ac756a2e97272fc76119297e27143f6d1e68`，与 R16 相同。此步没有执行这些套件。
- **官方基线。** `44893573585` 已通过当前 Auth、Coverage、Effect 和三平台 Core、TUI；不继承到候选，也不替代原 Core preload。原 Guard `44893573612` 的 rules、contracts 和汇总通过；该运行是分支 push，未执行 PR bench 或 dispatch preflight。正式 #5 的测试与性能只收实际 R17 checkout 结果。围绕当前上游关闭路径应重跑本版候选的原 HttpApi、完整构建与实机，历史 R16 截图只按其原版本留档。

### R19 当前基线与原行为路径

- 57a→6dd9a5b 官方比较为四个提交、六条路径。当前工作树用 GitHub 六条经过 Git blob 校验的后像写出官方 tree 并重建精确 6dd commit。另用空索引严格施加 19 条未重叠 #5 源码/测试后像，全部等于线上 86fc 的同路径；树 `62df7f9bead3f45f616ac9dee52d98263623e90c` 只是规划取证，不是最终候选。Session 普通三路合并实冲突；旧 patch 容器普通三路显示成功，却生成重复 native 调度 hunk，原发行包 strict apply 失败于 `index-b5dpwnes.js:7756`。
- 临时隔离以 6dd 原 patch（blob `fad957e0970a05aa422708eeb05c11bc5ccb0161`）严格施加到锁定 OpenTUI 基包后，以真实 native 库和公开 start/renderOnce/destroy 跑连续帧接替。当前基线与最小 identity 候选均将 [1] 更换为 [2]，destroy 后空集合、推进时钟无遗留、均退出 0。
- 同一真实 native 的零延时路径：requestRender、suspend、排进一个内部观测 sentinel、resume。目标在 sentinel 已出现 frame 1（过期 callback 领取了新请求），最后帧数仍 1，断言退出 1。隔离 identity 候选 sentinel 为 frame 0，随后真实 frame 1，退出 0。旧 #5 精确 native 也通过同一观测。候选只是仓外诊断；不改定时器策略、native 库或原门禁。
- 复用上述原始 patch 的全部运行文件和目标 Session blob `f9e71e900d9b6f6214f40e8233a63e6a580be189`，Bun 1.4.4 从 packages/tui 用原 `script/guard/leak-preload.ts` 分别执行原 `completed partial glob remains visibly incomplete with details off` 和 `switching sessions after scrolling away still opens the next session pinned to the bottom`；各 1 pass、零失败、自然退出 0，无 50ms 相关引用资源。此前撤回旧 Session hunk 会重新触发真 50ms 遗留只作为历史对照。
- 新证据的私有相邻清单 SHA-256 `adeaa916ce18986b0e5fa402dcc4579b21145edba711da87459e7de036d6acad`：包含精确对象、已验证两处重叠、严格失败、逐臂实际 native 及原 route 日志和原断言退出。临时 native 诊断 diff SHA-256 `6508836e36ef0f513e2101a1e272ea79c35af67e5b6fead1ecc91baec8ac4c30`，不直接代替完整原依赖的独立实施审核。
- 本轮额外以 6dd 真实新表格测试 blob `823ed32dcad2bcf2835f9f49e0e89ef2d134c30c` 独立对照其原 `keeps Markdown tables, fences, formulas, and callbacks coherent across deltas`。主线整套 OpenTUI patch 与只改变 renderer identity 的仓外 overlay 分别 1 pass、5 断言、零失败、自然退出 0。保持 patch 的另外两个输出文件逐字节相同，回执清单 SHA-256 `4b7afd51bf2577aebf1ae51a963f702d01917eb8d3ae2517b83ba7eae0262208`。
- 实施验收在准确 6dd 和最终候选的现有完整 TUI 路径重跑上述红/绿，包括普通首帧、正延时、手工连续接替、恢复和真实原终端。原 `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` 的表格、围栏、公式、回调与增量边界须复验；保持最新原表格补丁、ScrollBox 和非调度模块逐 hunk 无变化。完整原 A/B 必须在新的真实候选/基线执行；历史 57a→86fc 原 30 对 compact.cpuMs 640→760ms、p=.01416239 的红照录，新候选不继承通过。旧单次滚动红、最新 57a 同场滚动绿、及暖缓存 compact A/A/A/B 的波动是历史对照；不据此改产品或阈值。新 Patch 并不声称直接修理 compact，仍由原 Gate 裁定。

### R20 Phase 1 边界对照

当前公开同时具备 parser 长行改善与 V1 新硬失败。Node 24.22.3 用准确基线、候选 `readTextPage` 实际读盘，40,000B ASCII/UTF-8 CRLF 与 57,142B token 边界成功交付，超过 1B、1 MiB 或超预算未终止首行均零交付；后者仍受物理 278,528B 上界。显式 offset 2 的尾行正常。另在准确候选 parser 与实际共享 renderer 函数中对照拟议内部输入，9 条通过：3 条零进度基准 XML 都自指，目标只去偏移，保留 reason；6 条普通路径逐字不变。每条又断言新 renderer 省略该输入的结果与原 renderer 字节相等，对应 V2 同一默认调用合同。证据见 `exact-parser-control.log`、`render-owner-control.sh`／`render-owner-control.log`／`render-owner-control.exit`。这是实际 parser/renderer及其薄投影，未执行 Bun Tool 注册及真实 V2 host；Stage 3 须由准确目标锁运行既有 V1 Read 和 V2 输出控制、公开 CodeMode、原类型及原 Gate。

原生 Node 独立对照包含显式 undefined mapper、对象 length、null 及普通 RangeError，7 项；sandbox 拒绝集合以准确源及历史 CodeMode 公共运行记录核对。阶段 3 重跑候选单一调用分派的公开接收者诊断、成员及普通调用，以及集合提前准入，避免按不可达分支的文本写新拒测。

### R21 双向规约原路径红绿

准确 6dd 和冻结 R20 的原公共入口同输入对照，见 `R20-audit-hole.log`：长度为 1、槽位 0 缺失；当前基线双向皆返回成功/null，R20 双向均在首个槽耗尽后返 ExecutionFailure，保留同一明确初值 5 控制。固定 Bun 1.4.4、真实解释器包和冻结依赖，在私有源码复制上只变换该 reducer hunk。阶段 1 真公共对照覆盖两方向旧输入、长度 3 全空槽且回调不得调用、显式 5/undefined、存在实际元素的双向结果 27/72、真正空数组两条旧诊断和原稀疏 map，共 11 组通过（`hole-r20.log`、`hole-r21.log`）。使用同一既有 CodeMode 公共测试实例的最窄修改跑原 preload：R20 0 通过／1 失败，R21 私有投影 1 通过、3 断言，实际自然退出 0；原 CodeMode 两文件 190 通过、738 断言、退出 0。

该验证绑定准确 R20 和精确隔离后像，不是正式候选或替换原 Gate。R22 保持 22 条累计路径；相对 R20，正式源码仅保留原 runtime 的相同修正，原 CodeMode 测试后像与 R20 相等。Read 新旧真实宿主证据、完整 Gate 与本地宽测既有资源现象各保持实际状态。

### R22 测试保留边界

同一正长度全空槽输入在发布前基线 6dd 双向均成功。R20 中间实现失败，R21 已验证的源修正恢复成功。四份直接公开调用与实际既有用例对照作为隔离证据，不形成发布测试差分；正式 CodeMode 既有测试相对中间实现撤回追加的旧语法构造、双向调用和期望值，回到 R20 这一份已经保留原用户需求断言的文件。使用同一源修正，在准确实施树重新运行未加临时断言的原 CodeMode 两文件、原 OpenCode Execute 文件及独立仓外对照，不把历史回执记成正式通过。

### R23 原基线永久断言核对

精确 pre-R1 `0ab20fa8` 的 27 项 CodeMode 源 blob 与 6dd 全部相同，六个直接 owner 也相同。测试七文件中六个 Git blob 相同，SessionRunner 区别只在既有 Git 提示措辞。实际 Bun 公共调用对照：宿主形状原本 1 项/7 断言两臂都通过；sort 快照副作用两臂均 `[[1,3],1]`；JSON.stringify 回调两臂均同一错误，而 Math.abs 由真红转绿。旧公开稀疏 JSON 的 index 0 没有自身键，目标将其正当投影为 null 属性；Array/new Array、Array.from mapper、Math/JSON.parse 正例在初始基线确实失败。证据为 `pre-r1-codemode-source.blobs`、`pre-r1-test-owners.blobs`、`pre-r1-test-inputs.blobs`、`positive-base/r22.log`、`promise-base/r22/r23.log` 及真实原 stock preload CodeMode 回归（190 通过、734 断言、自然退出 0）。

逐组处置与必要边界见本轮 `permanent-test-map.md`；保留的六类其他正式用例对应长 rg、Task 公示、正式额度、Read 长首行／自指页、Shell 纯正文及公共解释能力的真实原差异。R22 精确会话 Execute 原文件用真实系统 rg 和 stock preload 80/0、776 断言、162.72s 自然退出 0，真实长场景用时 121.123s；原两次不够的外层超时仍保留。R23 需在最终实施树重跑相关 CodeMode 与 Execute 入口。


### 唯一发布载体与正式安装门禁

当前唯一载体 `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 的目标前像为 Git blob `fad957e0970a05aa422708eeb05c11bc5ccb0161`；保持 6dd 原表格、ScrollBox、highlighter 和其余补丁 hunk。只替换已存在 renderer scheduler 片段的必要行，不能再附加旧 R10 的重复变换。生产 `index.js` 与 `testing.js` 共享同一 renderer chunk。依赖 manifest、Gitlink、Bun 锁、bunfig 和 native 二进制目标皆保持 6dd 原字节。

以下文件均来自固定 release `https://github.com/SMARK2022/opentui/releases/download/v0.4.3-smark.13/`，文件名列与此前缀组成完整发布坐标；SRI 逐项取原锁。只有 Linux x64 native 已与原包完整 SRI 对过；本表其余坐标是实施期的检查输入。

| 发布文件 | 锁定 SRI |
| --- | --- |
| `opentui-core-0.4.3-smark.13.tgz` | `sha512-vXHFEghKp/mNnaE4CbX3w0pyqhdKaJ8okFvD186L1M+VQXN/QCxCkHTzkzSS3dTptWvYWsF63TAnUwWyal2sdw==` |
| `opentui-core-darwin-arm64-0.4.3-smark.13.tgz` | `sha512-IQVj5J6WL77x3o2ebo0rOtXU7us3bLQGBhDuN5SaBJKg7GVHJcCMrE4X2WW/yvwEqJG0hNYuPQrkxBdZeLhrHw==` |
| `opentui-core-darwin-x64-0.4.3-smark.13.tgz` | `sha512-50SYX56C7OKF/L6Miu73f5YkiluWvReFbrdMIKHNkE639cGaKjEILZfxb4d0Og0u0NZIgVp3UIMoKcOjE6hONw==` |
| `opentui-core-linux-arm64-0.4.3-smark.13.tgz` | `sha512-TAaWZ5x6qgesUKwYdT70ujS9FW+BeG4Po4srKzg0bzUBYYS9Yyd0zWsQeQexM7tKBeVq7EuEPNL3DQxI3LOrvQ==` |
| `opentui-core-linux-arm64-musl-0.4.3-smark.13.tgz` | `sha512-pYgUrqYh9VNT0DVImRvfJ/RaomehV3MvR44U7WW+jTBkph250coj4KXygDEGgd7/nNzMWxuCp5Va5VG2L4orlw==` |
| `opentui-core-linux-x64-0.4.3-smark.13.tgz` | `sha512-Vw6+qSnjVa3SAObwxycscc3sQzql8TgBTdI05SLX+KUdtc4N7W7Yt3uxhhuAqMQS2y/1MyRqWXFC6BVbj1Am4g==` |
| `opentui-core-linux-x64-musl-0.4.3-smark.13.tgz` | `sha512-ZWe1GDt4ZBHrSV65t8kZ0CWHLjTTOr/duZy1xly7MSrhb//Btw76nHTDFY99WFFNBKKoZ+MsSNPMgsPXr4E/qQ==` |
| `opentui-core-win32-arm64-0.4.3-smark.13.tgz` | `sha512-IOFCYZ2cDuIMFYCwuHxZNtNN+47Yps0YCGODBSLsJqGeYSJ4usRzpY4gj0xdx5TNLEZp7vHD1h3ezkReKO66eA==` |
| `opentui-core-win32-x64-0.4.3-smark.13.tgz` | `sha512-tt+ZS85wpRSccejdT7adf0EnIGcZM0zH+9QgJ0D1gdejKSplh2lcG0Sx3VZp4VDXURPiAxMxjZwTZRS6j/DuEw==` |
| `opentui-keymap-0.4.3-smark.13.tgz` | `sha512-NrfcLjXbrOOdF3ER2Ry5jx5EdPYofcspZHwvf7Knq+17yzgaLg0V/nnZnD7gkw6N7fZ/NE7E421CDj4/ip0cLg==` |
| `opentui-solid-0.4.3-smark.13.tgz` | `sha512-p1n7JOvwNKrGlELQIGN2hemOLnWePhmXTNGdrtEbepjwGOgi9+h9zghM+Lagdb7kUPSN91WFiqcENZwIBR6DWQ==` |

**R8 阶段 1 已跑的载体对照（历史私有 chunk）。** 原缓存未打补丁 core chunk SHA256 `316dae73791ad3b76c7e80dcf0d7d95c34c88576ff8fc7da8c455d2d55c0b368`，原 patch 重放与正式 donor 字节一致。私有合并 patch SHA256 `76ce17e4546d91898e2ff757c53ef9092a0e08289f724ca33a80b12c528a4dd7`。空目录按原锁投影 115 项，Bun 1.4.4 在实际安装过程生成预期 renderer chunk `73af5b316a0e2589a9a0e0879102ee476986d437b6a2236a7f2bc4864e586bab`，投影锁未改，最终 exit 1。Linux x64 真实发布包内 `libopentui.so` SHA256 `ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d`。补丁加载与其余依赖安装的退出分别记录。

**缺包和库存。** 完整工作区原锁 SHA256 `56c20270792f5ce4ecced742b5e3667ca53573da26a3af6153e6f9a484635ed5`，排除初次私有缓存不可写后仍报 831 条离线缺项。窄验证的 59 个缺名映射到 67 条精确锁记录；38 条在三份缓存都无同版本索引候选，去重为 35 个发布物。可见 npm 归档缓存按完整 SHA-512 查找，67 条均无匹配归档。首批为 diff@9.0.0、@babel/core@7.28.0、@jridgewell/sourcemap-codec@1.5.5、@jridgewell/resolve-uri@3.1.2 和 browserslist@4.28.2；最小材料清单 `direct/cache-absent-immutable.tsv` SHA256 `af2a589cbcfef35dc5e475afdd7c4420aad83452863b545720aca8fddeed4294`。官方源单包请求在普通和已允许路径均因 DNS 失败；旧 GitHub Actions 44483454932 只保留测试/Playwright Artifact，旧锁 blob 059b8a82，与 0dff 和当前 dev1-smark 的 b8df0bea 不同。Bun 解包缓存同版本索引、已装 node_modules、旧锁、真实发布包的完整 SRI 是分别验收的对象；不改解析规则补齐。

**实施期必须执行的顺序。** 获独立精确批准后，先在已有能访问原锁发行源的 runner 建固定 6dd9a5b 和实际候选两棵私有空工作树，记录旧锁 SHA、Bun 1.4.4 / OS / 架构、无初始 node_modules，然后在各仓库根按原基准安装入口执行 `HUSKY=0 bun install --frozen-lockfile`。逐臂保存真实原始退出、锁安装前后哈希、补丁/产出 chunk、所选平台原生包 SRI 及 native 文件 hash。两臂安装须 exit 0 且锁字节不变；正式候选加载应匹配所审补丁，后续实机驱动必须使用同一安装。当前原 `guard.yml` 的 rules 和 bench 作业给候选 checkout 明确传 `--frozen-lockfile`；新 bench 脚本对 base detached 也每次执行原冻结安装。用现有 #5 的 `execute-result-recovery` 分支作用户已授权的临时线上验证。普通 PR 的 Guard rules 使用目标分支 policy，runtime 改动运行原 bench 对照；核实实际 head、policy、merge-base 和合并检出树，并查两臂真实安装与执行退出。普通 PR 不运行 dispatch-only 的 Push preflight；线上其他必过测试和原 preflight 分别按各自结论记录。仅在仓库原 Gate 明确要求且已授权相应 ref 时触发正式预检入口，按 sha＋base＋platforms 核实际 job。没有该 ref 权限或物料时用既有同锁 runner 的独立私有工作目录执行原命令，不改流程、不开额外 PR。无可用原发布物就停在此放行条件，记录原错并更换已有正式验证环境，不改锁、规则或测试。

**原夹具放行。** 冻结 R6 32 文件原 TUI Stop exit 1，基线与冻结 R6 的同选集直接 A/B 为 185/1/200 与 187/1/198（通过/跳过/失败）；双方 197 个失败同文件同用例名。阶段 1 只证明 EXIT-1、SCROLL-1、RENDER-1…3、SLOT-1 指定路径的红绿，未证明 197 个共同失败都已关闭。正式同一候选先跑原 active switch、partial glob、preview、active scan 和 app.exit，随后用完整原 Stop/Push、按原 Gate 需要的 preflight、锁定 native 构建和实机验收。若仍有原夹具红，保存准确用例和资源归属；只有实证是否由已批准责任路径负责后才修正。超出此版责任边界的已存在红点保持发布阻断，重走完整方案范围裁定，不能用固定等待、关闭动画、排除夹具、改 Gate 或单纯重跑放行。
