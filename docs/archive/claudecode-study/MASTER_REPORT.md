# 总览与最终建议

## 0.1 这不是两个“同类产品”，而是两种不同的工程哲学

把 OpenCode 与 Claude Code Rebuilt 放在一起时，最容易犯的错误，是把它们简单理解成“两个会调工具的终端 agent”，然后只比较哪个回答更聪明、哪个支持的模型更多、哪个上下文压缩更激进。这样看问题太浅。

从源码层面看，二者根本不是同一种架构取向。

Claude Code Rebuilt 更像一个**高耦合、高优化、强状态化的 agent 内核**。它的核心价值不在于外壳，而在于一条非常厚的 query 主循环：消息进入之后，并不会直接喂给模型，而是要经过 memory prefetch、skill discovery prefetch、tool result budget、snip、microcompact、context collapse、auto-compact、token budget 检查、stop hook、tool summary 等多层治理。它像一台已经调得很锋利的发动机，强调的是“同一轮推理之前，把上下文尽可能精炼到位，再以极高的信息密度去驱动模型”。这种系统一旦处于最佳状态，任务完成质量和长任务持续性会很强；但代价是代码结构巨大、模块之间的隐式耦合很多、维护成本非常高。

OpenCode 的气质完全不同。它更像一个**可平台化的 agent runtime**。从 `server.ts` 可以看出它是明显的 client/server 架构；从 `agent.ts`、`registry.ts`、`session/prompt.ts` 可以看出它把 agent、tool、provider、plugin、session、compaction 都拆成了清晰的服务层，并且用 Effect 风格把依赖装配得相对干净。它的设计目标不是把所有高阶行为都硬塞进一个查询回路里，而是留出足够多的扩展点，让你把行为迭代地叠加上去。这意味着它未必在初始状态下拥有最复杂的“闭源大厂式 agent trick”，但它更适合被当作工程底座长期演进。

这也是为什么，我最终给出的选择不会只是“哪个更强”，而是区分为两个问题：

第一，你要的是**现成的高阶行为体验**，还是**未来三个月到一年可持续优化的技术底座**？  
第二，你是否真的愿意承担一个高度复杂内核的维护债？

如果前者优先，Claude Code Rebuilt 的研究价值极高。  
如果后者优先，OpenCode 更适合作为主项目。

## 0.2 Claude Code Rebuilt 的本质优势：不是“工具多”，而是“上下文治理链深”

很多人看 Claude Code Rebuilt，会先被它庞大的内置工具面吓到：Read、Write、Edit、Todo、Task、Skill、Agent、Web、MCP、Search、Notebook、Sleep、Plan、LSP、Task 管理等等，工具表面确实极其丰富。但真正决定它完成复杂任务质量的，不是工具数量本身，而是**工具调用前后的上下文治理链**。

`query.ts` 里最值得注意的不是 `runTools`，而是 `runTools` 之前的那一长串准备流程。它先做 memory prefetch，再做 skill discovery prefetch；然后会对既有消息做 tool result budget，把旧工具输出收缩到预算之内；接着尝试 snip、microcompact、context collapse；最后才决定是否触发 autocompact。换句话说，这不是一个“上下文满了再压缩”的系统，而是一个“每轮发送前都在尽量瘦身”的系统。

这类架构的直接收益是三点。

第一，它能把主上下文窗口留给真正重要的信息，而不是让模型背着已经失效的大段工具输出前行。  
第二，它可以在压缩真正发生之前，先做许多小尺度的结构化裁剪，因此不会像很多 agent 一样到了临界点才突然损失大量细节。  
第三，它允许你把上下文治理分层设计：微压缩负责去掉噪音，会话摘要负责保住任务脉络，session memory 负责保住长期状态，最终压缩只负责“跨阈值保命”。

这套设计的含义，不是“Claude Code Rebuilt 的 compact 做得更厉害”，而是它把 compact 放在一个更完整的生态里。OpenCode 当前已经有 compaction 和 prune，但仍然偏向“会话快溢出时处理”；Claude Code Rebuilt 更像“从一开始就防止会话膨胀”。

## 0.3 OpenCode 的本质优势：不是“功能少”，而是“结构清楚，适合长线进化”

如果只看功能，OpenCode 似乎没有 Claude Code Rebuilt 那么“花哨”。但源码一旦展开，这种印象会迅速改变。

OpenCode 的强项在于结构秩序。`agent.ts` 把 build、plan、general、explore、compaction、summary、title 等角色明确定义出来；`registry.ts` 把 builtin tools、custom tools、plugin tools、模型差异化工具暴露都统一起来；`session/prompt.ts` 把计划模式、构建模式、agent 角色切换、工具注入、MCP tool 注入、StructuredOutput 等逻辑集中到提示词装配与执行回路层；`server.ts` 则说明它不仅是一个 CLI，而是一套能被 CLI/TUI/Desktop/ACP/SDK 同时驱动的服务。

这种架构的真正价值，在于**它给未来留了空间**。你可以比较干净地引入新的上下文治理层；可以给不同 agent 绑不同模型；可以在 plugin 里重写 compact prompt；可以给 registry 增加更细粒度的工具 gating；可以把 benchmark harness 挂到 server/session 层，而不是用猴子补丁去拦截一个黑盒循环。

它不像 Claude Code Rebuilt 那样已经高度调优，但这并不意味着它弱。相反，它意味着：**OpenCode 现在最缺的不是结构，而是几项关键的高阶机制。**

这恰好是一个很好的起点。因为“缺高阶机制”可以逐步补；而“结构已经很乱”则很难救。

## 0.4 为什么我最终建议你：以 OpenCode 为主，以 Claude Code Rebuilt 为参考库

真正适合长期做项目的人，通常不会把“短期能力上限”作为唯一标准。更重要的是：

- 你能不能持续读懂这个项目；
- 你能不能安全地改一处而不炸三处；
- 你能不能把评测体系挂进去；
- 你能不能把模型、工具、上下文策略拆开做 A/B；
- 你能不能做自己的路由、记忆、压缩和预算机制。

在这些维度上，OpenCode 明显更适合作为主干。它的核心服务边界更明确，agent 与 tool 是显式对象，session 和 compaction 是单独模块，server 化也让它更容易被基准评测和外部控制。你要做一个真正有演进路线的 CLI，OpenCode 是更合理的工程起点。

但这并不意味着 Claude Code Rebuilt 应该被放弃。恰恰相反，它应该被当成你的“高阶行为样本”。你不需要把它整个 fork 成为主项目，而是应该把它当作：

- 多层上下文治理的参考实现；
- 更强的工具预算体系参考；
- 会话记忆与背景摘要机制参考；
- 更细粒度的 stop hook / post-tool summary / agent handoff 参考；
- 更成熟的 query 主循环参考。

这样你得到的是两者最好的组合：  
OpenCode 给你可维护的骨架，Claude Code Rebuilt 给你一批已经在强 agent 体系里证明过价值的机制。

## 0.5 三个最终判断

### 判断一：如果只比“今天谁更像强力 Claude Code”
Claude Code Rebuilt 赢。

因为它的主循环、工具面、上下文治理层、session memory、skill 处理、计划模式和提示词逻辑都更接近一个已经被长期调过的高阶 agent。它不是一套干净的开源工程，但它非常像一台高度实战化的机器。

### 判断二：如果只比“哪个更适合后续开发”
OpenCode 赢。

因为它的抽象边界更清楚，服务化更明显，插件和工具注册机制更干净，agent 角色层次也比 Claude Code Rebuilt 更适合做“策略层创新”。

### 判断三：如果要做一个兼顾质量、效率、上下文成本的长期 CLI
最优方案不是二选一，而是：

**主项目选 OpenCode；  
核心改造思路借鉴 Claude Code Rebuilt；  
产品体验与任务连续性再吸收 Cline 的部分设计。**

## 0.6 最终选型结论

我会替你拍板为：

**主 CLI 项目：OpenCode**  
**参考内核与高阶机制样本：Claude Code Rebuilt**  
**产品级任务连续性与交互细节参考：Cline**

### 为什么不是直接选 Claude Code Rebuilt 做主线
因为它的强，建立在非常厚的历史层和高度耦合的运行路径之上。你当然可以基于它继续开发，但长期来看，新增一个高阶特性、替换一类工具、调整一种压缩策略、统一一个 agent 路由，都更容易触碰到隐式行为。它适合研究、借鉴、对照，甚至适合特定实验版本继续跑，但不适合成为你未来几个月最主要的产品底座。

### 为什么不是选 Cline
因为你当前的问题不是“IDE 插件产品谁更成熟”，而是“我要选一个 CLI 项目，后续怎么优化开发”。在这个语境里，Cline 的很多优势是编辑器生态优势，不是 CLI runtime 优势。它更适合被你拆来学习 task continuity、checkpoints、Memory Bank、/smol、/newtask 这些具体机制，而不是直接拿来当 CLI 中心项目。

### 为什么是 OpenCode
因为它是三者里**最适合吸收别人优点**、又最不容易被自己拖垮的那个。

后面所有模块分析和改造建议，都以这个选择为前提展开。


---

# 上下文管理模块深度对比：OpenCode vs Claude Code Rebuilt

## 1.1 为什么上下文管理是整个 agent 架构里最关键的模块

一个 coding agent 到底“贵不贵”“稳不稳”“长任务是否失忆”，并不首先取决于模型名字，而是取决于上下文系统。模型只是推理引擎；真正决定成本与稳定性的，是你如何决定把什么信息送进去，以及什么时候把什么信息移出去。

对 CLI agent 来说，最容易失控的不是用户 prompt，而是以下几类内容：

- 大量文件读取结果；
- 冗长的 terminal 输出；
- 子任务往返过程中的中间结论；
- MCP 工具的长文本响应；
- 系统提示词本身与技能说明；
- 历史回合中已经失效、但仍被模型反复背负的“旧状态”。

因此，上下文管理不是一个单点功能，而至少应当包含五层能力：

第一层，**主动避免污染**：别什么都往上下文里塞。  
第二层，**预算治理**：即便已经塞进来了，也要限制旧结果在上下文中的长期占比。  
第三层，**微压缩**：在真正溢出之前，先做局部缩减。  
第四层，**结构化摘要**：真的快满时，用摘要替换历史。  
第五层，**长期记忆旁路**：一些信息不要寄希望于每轮都带着走，而是沉淀到辅助记忆里，在需要时再回收。

OpenCode 与 Claude Code Rebuilt 的差异，恰恰就在于：  
它们不是有没有这些层，而是谁做得更深、谁更容易扩展、谁的默认行为更保守。

## 1.2 Claude Code Rebuilt：多层治理链，而不是单点 compact

### 1.2.1 query 主循环中的上下文治理顺序

Claude Code Rebuilt 的上下文治理，必须从 `query.ts` 看，而不能只看 `compact.ts`。因为真正的设计思想是“多层清理链”。

在每轮核心请求前，它会经历这样一条路线：

1. 启动 memory prefetch  
2. 启动 skill discovery prefetch  
3. 应用 `applyToolResultBudget`  
4. 视情况执行 `snipCompactIfNeeded`  
5. 视情况执行 `microcompact`  
6. 视情况执行 `contextCollapse`  
7. 再决定是否 `shouldAutoCompact`  
8. 之后才进入真正的模型回合与工具执行

这条顺序意味着一个重要事实：  
**Claude Code Rebuilt 并不把“自动压缩”当作唯一解决方案。**

它更像在做“渐进式减肥”：

- tool result budget 先处理旧工具输出；
- snip 尝试做较轻量的历史裁剪；
- microcompact 尝试做更小粒度的摘要性清理；
- context collapse 是更激进的中间层；
- autocompact 是最后保险。

这类多层链的优势非常明显：  
真正进入大规模 compact 的频率会下降；而且越早的层越倾向保留原有结构，而不是一下子把历史扁平化为摘要。这对复杂编程任务尤其重要，因为编程任务常常需要保留某些精确上下文，而不是一个“概括得不错”的摘要。

### 1.2.2 autoCompact 的阈值思想：不是用满，而是预留大块安全边界

从 `autoCompact.ts` 可以看出，Claude Code Rebuilt 对自动压缩的触发非常保守。

它会先计算一个 `effective context window size`，这个值不是模型原始窗口，而是减去一段给 summary 输出预留的空间。默认逻辑里，最大摘要输出预留是 20,000 tokens 或模型最大输出中的较小值。然后在这个有效窗口基础上，再减去一段 `AUTOCOMPACT_BUFFER_TOKENS = 13,000` 作为触发线。

这意味着 Claude Code Rebuilt 并不会等上下文“只剩一点点”才压，而是会在还有相当余量的时候先行触发。这种保守策略带来两个好处：

第一，compact 本身需要消耗上下文与输出，如果你等到临界才做，很容易在 compact 过程中再次出问题；  
第二，预留足够 buffer，意味着 compact 完成后还能顺利继续当前任务，而不是 compact 一次就立刻再次接近阈值。

它甚至还定义了 warning/error buffer，以及连续失败次数上限。这说明它把 compact 当成一个可能失败、需要防抖和恢复的系统行为，而不是理所当然一定成功的步骤。

### 1.2.3 compact 前处理：先剥离不该参与总结的块

`compact.ts` 进一步揭示了 Claude Code Rebuilt 的成熟之处：  
它不是拿当前 messages 原样喂给“压缩 agent”，而是先做若干预处理。

最重要的几件事包括：

- 剥离图片和文档块，避免它们污染压缩请求；
- 剥离某些会被自动重注入的 attachments，尤其是 skill discovery / skill listing 之类“本就可恢复”的内容；
- 在 compact 前触发 hooks；
- compact 后再做 post-compact cleanup；
- 控制 post-compact 恢复的文件与 skills 数量和 token 预算。

尤其值得强调的是 invoked skills 的处理。Claude Code Rebuilt 不希望压缩后整个技能体系“失忆”，所以会把被真正调用过的 skill 内容做成专门 attachment，在压缩后重新带回来，同时给每个 skill 与总 skill 设定预算。这个设计非常精细：它承认 skill 文件通常开头部分最重要，因此采用“按 skill 头部截断”，而不是简单按 skill 整体保留或整体丢弃。

### 1.2.4 session memory：把一部分状态搬到主上下文之外

Claude Code Rebuilt 另一个非常关键、而且 OpenCode 目前还没有原生对应物的能力，是 `SessionMemory`。

从 `sessionMemory.ts` 可以看出，它会周期性地在后台提取当前对话的重要信息，写入一个 markdown memory 文件。也就是说，它不是把所有长期状态都寄托在聊天历史中，而是建立了一个旁路：会话历史负责回合内连续性，session memory 负责阶段性沉淀。

这种机制特别适合 coding task。因为很多任务的信息其实是“慢变状态”：

- 当前要修改哪些文件；
- 已确认的设计约束；
- 已经验证过的结论；
- 还没做但后面必做的验证步骤；
- 用户偏好和禁止事项。

这些内容如果每轮都靠历史消息维持，会非常昂贵。把它们沉淀到 session memory 里，再在适当时机回收，是一种典型的“把 token 开销转成结构化状态管理”的思路。

### 1.2.5 Claude Code Rebuilt 的代价

第一，复杂。你要同时理解 budget、snip、microcompact、context collapse、auto-compact、session memory，各自的触发条件和数据流都不一样。  
第二，隐式。很多清理不是集中在一个模块里完成，而是分散在 query 前后、compact 前后、attachment 注入和 memory 旁路里。  
第三，验证困难。只要上下文行为不稳定，就很难快速判断到底是哪一层出了问题。

## 1.3 OpenCode：更干净的分层，但目前还停留在“两层半”

### 1.3.1 overflow 触发：以 usable window 为核心

OpenCode 的 `overflow.ts` 代表了它最基础的上下文治理思想：不是简单拿模型最大窗口做比较，而是先计算一个 `usable` 区间。这个 usable 会扣掉一段 reserved 空间；如果模型有明确 input limit，就用 input limit 减 reserved；否则用 context window 减去 max output。

这和 Claude Code Rebuilt 的思想是一致的：  
**压缩阈值不能直接贴着模型上限。**

差别在于，OpenCode 的实现更清爽，策略更容易理解；但也意味着它目前没有像 Claude Code Rebuilt 那样继续往前细分出更多治理层。

### 1.3.2 prune-first：先清老工具输出，再 full compaction

OpenCode 的 `session/compaction.ts` 里，一个很值得肯定的设计，是它不是一上来就 full compaction，而是先做 prune。

它会：

- 保护最近若干轮 turn；
- 统计老工具输出的 token；
- 达到一定量后才真正裁掉；
- 保留一部分 recent tail 的预算；
- 对 skill 等工具做保护。

这里的思想非常对：  
coding agent 中最先该清理的，往往不是用户对话，而是历史工具结果。尤其是 terminal、grep、read、webfetch 这种产出长文本的工具，如果旧输出还一直占着上下文，模型很快就会被拖垮。

### 1.3.3 hidden compaction agent：压缩是显式 agent 行为

OpenCode 的 `agent.ts` 里内置了一个隐藏 `compaction` agent。这是个很好的结构选择。它说明 compact 不是一种特殊 case，而是一种 agent 角色：有自己的 prompt、自己的权限边界、自己的用途。

这样做的好处是：

- 你可以给 compaction 绑便宜模型；
- 你可以单独测 compaction agent 的 summary 质量；
- 你可以在 plugin 中改 compact prompt；
- 你可以以后给 compact agent 加更多 metadata 或 structured summary 约束。

### 1.3.4 OpenCode 当前的短板：缺少中间层与长期记忆层

OpenCode 的问题不是 compact 做得差，而是上下文治理层数还不够。

它当前大致是：

- 读写工具有各自截断逻辑；
- overflow 判断快满；
- prune 老工具输出；
- 必要时 compaction agent 做摘要。

这可以说是“两层半”：

- 第一层：工具自身的输出边界；
- 第二层：prune；
- 第三层：full compaction。

相比之下，Claude Code Rebuilt 还有：

- tool result budget 的更显式预算层；
- snip / microcompact / context collapse 这些中间层；
- session memory 这种主上下文之外的长期记忆层；
- memory / skill prefetch 的前置式状态恢复。

## 1.4 两者的核心差异，不是“压不压”，而是“治理时机”与“状态位置”

Claude Code Rebuilt 是前置治理重。每轮发送前都会尽量处理。  
OpenCode 更偏后置治理。接近溢出时开始 prune / compact。

Claude Code Rebuilt 明确允许 session memory 旁路存在。  
OpenCode 目前主要仍然依赖会话内部状态和 compact summary。

这两点决定了它们的使用体验差异：

- Claude Code Rebuilt 更像一个一直在“瘦身健身”的系统；
- OpenCode 更像一个“快超重了就开始管理体重”的系统。

前者在长任务中通常更稳；  
后者在工程上更简单、更好改。

## 1.5 OpenCode 应当如何吸收 Claude Code Rebuilt 的优点

### 第一项：引入显式 Tool Result Budget 层
不要等 overflow 才考虑清理。应当在每轮发送前，先统计“旧工具输出占比”，尤其是 bash/read/webfetch/code search 这类高膨胀工具，并给它们单独预算。超过预算时，优先把旧输出换成简短摘要、preview 或路径引用，而不是直接留原文。

### 第二项：引入 Session Memory Service
OpenCode 应该新增独立的 `session/memory.ts` 或 `session/long_memory.ts`，在满足一定 token 增长或工具调用阈值后，把阶段性状态提炼成 markdown 记忆文件。这个记忆不应自动常驻系统 prompt，而应按需注入，或者在 compact 后作为一部分补回信息使用。

### 第三项：引入轻量 Micro-Compaction
在 prune 之后、full compaction 之前，加一个轻量层。它不做完整对话摘要，而只处理局部块：

- 将连续工具输出折叠成“已执行 X 次 read / grep / bash，结论如下”；
- 将大段错误输出保留最后 N 行与错误类型；
- 将多个 explore 子任务的中间结果折叠成一组 bullet summary。

### 第四项：把 compact 的恢复内容设计成一等公民
至少应恢复：

- 当前 agent 模式；
- 当前计划文件或计划结论；
- 当前任务的关键文件列表；
- 当前待办与未验证项；
- 最近一次失败尝试及原因。

## 1.6 最终判断

如果只比“谁的上下文系统今天更强”，Claude Code Rebuilt 更强。  
如果只比“谁的上下文系统更适合被你继续开发”，OpenCode 更优。

对你来说，最正确的做法不是复制 Claude Code Rebuilt 的全部复杂性，而是把它拆成三类资产：

- 必须移植的：tool result budget、session memory；
- 可以渐进移植的：microcompact、中间层压缩；
- 不必照抄的：过于厚重且高耦合的 query 内部状态机。

OpenCode 的上下文系统已经拥有一个好的基础：usable overflow、prune-first、hidden compaction agent、plugin 可改写 compact prompt。你要做的不是推翻它，而是把它从“两层半”升级为“真正的四到五层治理链”。

这会是你后续所有优化里，投资回报比最高的一块。

---

# 主循环与执行调度模块深度对比：OpenCode vs Claude Code Rebuilt

## 2.1 主循环为什么决定了 agent 的“人格”

一个 agent 是否稳定，很多人第一反应会说取决于模型；第二反应会说取决于 prompt。其实真正长期决定体验的，是主循环。

因为主循环回答的是几个比模型更底层的问题：

- 一轮对话从哪里开始，在哪里结束？
- 工具调用前有哪些准备动作？
- 工具结果回来之后怎样进入下一轮？
- 子代理如何被创建、恢复、汇总？
- 停止条件、失败恢复、模式切换由谁负责？
- token 预算、compact、hook、summary 是哪个时点介入？

你可以把主循环理解为 agent 的“呼吸系统”。  
呼吸节奏不对，哪怕模型再强，整个系统也会显得笨重、迟钝、失忆，甚至经常在无意义的循环里空转。

OpenCode 与 Claude Code Rebuilt 在这个层面差异很大：  
Claude Code Rebuilt 是一条厚重的“集权式主循环”；  
OpenCode 更像一个“由多个服务协作的执行回路”。

## 2.2 Claude Code Rebuilt：query.ts 是真正的心脏

### 2.2.1 query.ts 的特征：几乎所有关键行为都压在同一条循环里

Claude Code Rebuilt 的 `query.ts` 不只是“发个请求然后等 tool call 回来”。它更像一个总控中心。

在其中你能看到的核心职责至少包括：

- 初始化与追踪 query 状态；
- 处理 memory prefetch；
- 处理 skill discovery prefetch；
- 应用 tool result budget；
- 触发 snip / microcompact / contextCollapse / autocompact；
- 维护 token budget tracker；
- 构造 full system prompt；
- 驱动模型回合；
- 解析工具调用；
- 调用 `runTools`；
- 处理 stop hooks；
- 生成 tool use summary；
- 维护 turn 计数与多种 recovery 状态。

这种设计有一个非常大的优点：  
**所有行为都在一个统一的执行语境里。**

### 2.2.2 runTools：并行与串行不是统一处理，而是基于工具性质调度

Claude Code Rebuilt 的工具执行逻辑并非简单“一个个跑”。从 `tools.ts` 与 `Tool.ts` 的结构，以及 `runTools` 的调用方式可以看出，它会区分哪些工具是只读、可并发、安全的，哪些工具是有状态、危险或需要串行保证的。

这背后的思想非常重要。因为在 coding agent 中，并发不是越多越好。真正合理的并发策略应当是：

- 读取型、搜索型、分析型工具可以并发；
- 修改文件、运行副作用命令、跨 agent 状态变更等动作应串行；
- 有些工具虽然表面只读，但会修改内存态或权限态，也不应盲目并发。

Claude Code Rebuilt 在这方面明显更成熟。它不是把并发当“性能优化”，而是把它当成一种权限与一致性策略。

### 2.2.3 stop hooks、tool summary、reactive behavior 都嵌在主循环里

Claude Code Rebuilt 的另一个特点，是它不把“后处理”视为工具执行完的外部事情，而是把 stop hooks、tool summary、恢复逻辑都嵌入主循环。

这意味着它的主循环不是“模型一轮 -> 工具执行 -> 模型下一轮”的线性流水线，而是一个可以被多个旁路逻辑打断、改写、补充的状态机。这样的好处是：

- 更容易在高阶行为上做一致性；
- 更容易在内部做恢复与防抖；
- 更容易把 stop / post-tool / compact / budget 看作统一系统的一部分。

### 2.2.4 Claude Code Rebuilt 主循环的代价：极高的读写门槛

它的问题不是“写得不好”，而是进入门槛太高。  
因为主循环承担了太多职责，很多局部行为都依赖全局状态。这样一来：

- 新人阅读成本很高；
- 局部重构风险很大；
- 想做功能 A/B 很容易牵扯到其他逻辑；
- 主循环会成为整个系统中最难替换、最难验证的部分。

## 2.3 OpenCode：主循环更分层，执行行为更多通过服务装配实现

### 2.3.1 `session/prompt.ts` 才是 OpenCode 的真正执行中心

OpenCode 的 `agent.ts` 更像 agent 角色注册表；真正驱动一轮执行的，是 `session/prompt.ts`。这个文件做的事情很多：

- 组合 session、agent、provider、processor、compaction、plugin、registry、permission、MCP、LSP 等服务；
- 处理 prompt 输入与 parts 解析；
- 处理计划模式与构建模式；
- 构造 system prompt 与 tool schema；
- 调用 provider model；
- 处理工具执行前后 plugin 事件；
- 生成 structured output 工具；
- 把子代理 task 视为工具调用的一部分来编排。

和 Claude Code Rebuilt 不同的是，OpenCode 没有把所有逻辑都硬写进一个大状态机，而是通过 Effect service 把依赖拿进来，再在 prompt 层进行协作。

### 2.3.2 TaskTool：子代理不是主循环的“特殊 case”，而是一种工具

OpenCode 中最漂亮的一点，就是 `TaskTool` 的设计。它没有把子代理做成某种 query.ts 内部魔法，而是明确把“创建/恢复一个子任务会话”做成一个工具。这个工具本身知道：

- 需要什么 agent 类型；
- 是否是恢复已有任务；
- 子会话继承哪些权限；
- 是否禁用某些工具；
- 如何调用新的 prompt session；
- 如何把结果包装回 `<task_result>`。

这样主循环就不需要对它做过多特判。你可以：

- 单独约束 task 工具；
- 单独测 task 工具；
- 对不同 agent 类型做不同 routing；
- 在后续给 task 增加缓存、session pin、summary 恢复机制。

### 2.3.3 PlanExit 与模式切换：显式，而不是隐式魔法

OpenCode 的 `plan.ts` 很小，但体现了一个重要设计选择：  
计划模式退出不是藏在模型 prompt 里的隐式推断，而是通过 `plan_exit` 工具显式完成。用户确认计划之后，再切回 build agent 并注入合成消息。

这种做法虽然没有 Claude Code Rebuilt 那么“内核级原生”，但非常适合工程维护。模式切换一旦显式化，你就更容易：

- 在 benchmark 中观察模式转换；
- 给 plan/build 绑不同模型；
- 统计计划阶段与执行阶段的 token 成本；
- 在失败时重回计划模式。

### 2.3.4 OpenCode 主循环的当前短板：缺少“主循环前置治理链”

OpenCode 的 prompt 执行结构已经足够清晰，但相比 Claude Code Rebuilt，它仍缺少一层非常重要的东西：  
**主循环发送前的多层预处理链。**

今天的 OpenCode 更像这样：

- 解析 prompt parts；
- 准备 system prompt；
- 解析 tools；
- 如果 overflow，做 prune/compact；
- 发给模型；
- 工具执行；
- 再回来。

这已经不错，但还不够“老练”。因为在真正复杂的 coding task 中，主循环前还有很多值得做的治理：

- 对旧工具输出做预算裁剪；
- 对探索性子代理结果做中间层归并；
- 对最近失败但无价值的长输出做折叠；
- 对 session memory 做条件性回收；
- 对当前工作集做轻量提示注入。

## 2.4 执行调度：谁更懂并行，谁更适合继续发展

### 2.4.1 Claude Code Rebuilt：并行调度更深，但也更隐式

Claude Code Rebuilt 的并行能力主要体现在：  
它能区分哪些工具可并发运行，且主循环本身已经默认接受子代理、skill 搜索、memory prefetch 等异步结构。这让它在复杂任务中能更充分地利用并发。

问题在于，这种并发多半是系统内建、隐式地散布在 query 和 tools 体系里。也就是说，能力上限很高，但后续想调整并发策略比较困难。

### 2.4.2 OpenCode：并行还没走到最深，但形态更可控

OpenCode 在 `prompt.ts` 的 plan workflow 中，已经明确鼓励 explore agents 并行跑，说明它不是不懂并行；只是目前这种并行更多是**agent 设计层面的并行**，还没有像 Claude Code Rebuilt 那样，把各种前置治理与工具并发都系统化做深。

## 2.5 OpenCode 应当如何改造主循环

### 第一项：在 `session/prompt.ts` 发送模型前插入统一 Preflight Pipeline
建议增加一个 `PreflightPipeline`，至少包含以下步骤：

1. `ToolResultBudget`
2. `WorksetHintBuilder`
3. `SessionMemoryRecall`
4. `MicroCompaction`
5. `OverflowCheck`
6. `FullCompactionIfNeeded`

### 第二项：把 task 子代理结果收敛成统一中间格式
建议给每个子代理结果加统一 envelope，包括：

- 子代理 id
- 角色类型
- 结论摘要
- 关键文件列表
- 待继续问题
- token 花费与轮次

### 第三项：建立只读工具并行执行器
在 registry 或 prompt 执行层增加工具元数据，例如：

- `readonly`
- `sideEffectFree`
- `parallelSafe`
- `stateful`

然后对满足条件的工具支持 batch/parallel execution。

### 第四项：增加主循环观测指标
主循环一旦继续复杂化，必须同步增强可观测性。建议所有关键阶段都打点：

- preflight 前 token
- budget 后 token
- microcompact 后 token
- compact 次数与压缩比
- 子代理数量与平均轮次
- 并行工具任务数量
- 模型回合平均耗时

## 2.6 最终判断

主循环这一项，Claude Code Rebuilt 的“完成度”更高；OpenCode 的“可塑性”更好。

最好的路线依然不是照抄，而是：

- 保留 OpenCode 的显式 agent / task / server / registry 结构；
- 引入 Claude Code Rebuilt 的 preflight 多层治理思想；
- 用清晰的服务边界去承载那些本来在 Claude query loop 中混在一起的高阶逻辑。



## 2.7 更细一级的源码观察：OpenCode 与 Claude 在“谁驱动谁”上的差异

Claude Code Rebuilt 的 query 循环有一个非常鲜明的特征：它几乎天然假设“主循环知道一切”。也就是说，无论是工具预算、技能发现、会话记忆、系统提示词、停止钩子还是自动压缩，最终都要回到 query 的上下文中完成统筹。因此它更像一个强协调者。

OpenCode 则更像“主循环负责召集，具体行为由各服务完成”。`session/prompt.ts` 虽然很长，但它不像 Claude query 那样试图把所有策略都内卷到一个状态机里，而是不断把工作交给 Agent、Registry、Permission、MCP、Compaction、Processor、Plugin 等服务去处理。

这种差异非常值得你认真体会。前者意味着“能力密度高”；后者意味着“演进弹性大”。如果你未来想加入自己的 routing、memory、benchmark、artifact 存储、结果缓存，那么 OpenCode 这种服务化装配方式会轻松很多。

## 2.8 对“执行效率”的正确理解：不是一轮更快，而是完成同一任务更省

在主循环比较里，很容易被“单次回合的干脆程度”迷惑。Claude Code Rebuilt 常常会给人一种执行非常流畅的感觉，因为它在一轮开始之前做了很多准备，模型拿到的上下文质量更高，于是更容易在一轮里做出正确工具决策。

但从工程角度，真正应该衡量的是：**完成同一任务的总成本**。这个总成本包括：

- 多少轮模型回合；
- 多少次工具调用；
- 多少次重复读取；
- 多少次大规模 compact；
- 多少次子代理往返；
- 多少次用户额外纠偏；
- 多少人工返工。

Claude Code Rebuilt 的优势在于“减少盲目试错”；OpenCode 的优势在于“更容易把每一步拆开度量并优化”。所以，如果你后续真的打算做长期项目，OpenCode 的主循环不一定要在第一天就追上 Claude 的“老练感”，但必须尽早具备两个能力：

第一，能记录每一轮真正做了什么；  
第二，能让你替换掉低效步骤而不推翻整个系统。

## 2.9 针对 OpenCode 的进一步设计建议：把主循环拆成三层而不是继续堆一个大文件

当前 `session/prompt.ts` 已经承担很多职责。后续如果直接继续往里塞功能，很容易慢慢走向 Claude query 的复杂度，但又没有 Claude 那么多历史调优积累。为避免这条路，建议把 OpenCode 的执行设计正式分成三层：

### 层一：Preflight Layer
职责是“发给模型前的治理”，包括：
- 工作集摘要
- 旧工具结果预算
- 记忆回收
- 微压缩
- overflow 检查

### 层二：Reasoning & Tooling Layer
职责是“与模型交互以及驱动工具”，包括：
- system prompt 装配
- tool schema 暴露
- provider transform
- structured output
- tool execute before/after hooks
- task 子代理调用

### 层三：Postflight Layer
职责是“本轮完成后的沉淀和恢复准备”，包括：
- 会话记忆提取
- tool summary
- 关键工作集更新
- metrics 打点
- potential compact recommendation

只要这三层边界划清，OpenCode 后续就不容易失控。你甚至可以很自然地把 benchmarking、A/B、dry-run、trace replay 都插到这三层里。

## 2.10 最终结论补充

主循环这一章最重要的收获，不是“Claude 比 OpenCode 强多少”，而是：

- Claude Code Rebuilt 证明了：一个强 agent 绝不是单轮 prompt + 工具执行那么简单；
- OpenCode 证明了：你不必复制那种巨大状态机，也能为自己搭一个更适合长期演进的执行框架。

因此，OpenCode 的正确方向不是“把 `session/prompt.ts` 改成另一个 `query.ts`”，而是：

**把 Claude 那些高价值策略抽成前置层、后置层与任务层的独立服务。**


---

# 工具注册、MCP、Skill 与子代理体系对比：OpenCode vs Claude Code Rebuilt

## 3.1 工具系统为什么不能只看“数量”

agent 工具系统真正重要的是四件事：

- 工具如何被注册和暴露；
- 工具是否与 agent 模式、模型类型、权限边界耦合；
- MCP 与技能是否只是“附加工具”，还是深度参与系统提示词和上下文生命周期；
- 子代理是否是独立一等公民，还是主循环里的临时 hack。

从这个角度看，OpenCode 与 Claude Code Rebuilt 是两种不同的成熟路线。

## 3.2 Claude Code Rebuilt：大而全的工具生态，深度嵌入主系统

从 `tools.ts` 可以看到，Claude Code Rebuilt 的工具面非常大。它不仅包含基础的读写编辑、bash、grep、glob、web、todo、notebook、sleep、LSP、task 管理，还包含 Agent、Skill、DiscoverSkills、Plan、REPL、MCP resource、tool search 等高级工具。这意味着它不是“给模型一把瑞士军刀”，而是构建了一个真正的 agent 工具生态。

更值得注意的是：这些工具并不是统一的“纯函数插件”，而是深度耦合进 `ToolUseContext`。从 `Tool.ts` 看，ToolUseContext 里包含的内容非常多：

- commands
- tools
- mcpClients
- mcpResources
- customSystemPrompt
- appendSystemPrompt
- refreshTools
- renderedSystemPrompt
- app state
- query tracking
- content replacement state
- permission 与 plan mode 相关状态

换句话说，Claude Code Rebuilt 的工具不是外围模块，而是主系统的延伸器官。

### Skill 不只是工具，而是提示词与上下文系统的一部分

Claude Code Rebuilt 的 skill 体系至少包括三层：

- skill discovery / listing 进入系统流程；
- invoked skills 会跨 compact 被保留；
- skill content 预算与 truncation 单独处理。

这说明在 Claude Code Rebuilt 里，skill 本质上是一种介于“工具”和“提示词资源”之间的东西。它既不是全局常驻，也不是一次性读取的纯文档。它会被发现、被调用、被记录、被跨 compact 恢复。

### 子代理：高度原生化，接近内核能力

Claude Code Rebuilt 的 AgentTool 以及相关 built-in agents，给人的感觉不是“主 agent 调另一个助手”，而是“系统内天然存在多角色 agent 工作流”。 explore、plan、verification 等角色不是外置工具集，而是 query 内核认得的参与者。

## 3.3 OpenCode：工具注册更加清晰，MCP/Skill/Task 都是一等对象

### `registry.ts` 是 OpenCode 工具系统的核心资产

OpenCode 的工具系统最值得夸的地方，就是 `registry.ts` 的设计。  
它把工具分为：

- builtin tools
- custom local tools
- plugin tools
- named tools（如 task/read）

并通过统一接口暴露 `ids`、`all`、`named`、`tools(model, agent)`。

更重要的是，它不是机械地把所有工具都暴露给所有 agent。registry 会根据：

- providerID
- modelID
- agent
- feature flags

来决定实际向模型暴露哪些工具。甚至 patch/edit 的暴露方式也会根据模型类型变化，例如 GPT 类模型可走 ApplyPatchTool，其他模型偏向 EditTool/WriteTool。

### plugin tools 与本地 tools 的装载路径非常优雅

OpenCode 不仅支持内置工具，还会扫描配置目录中的 `{tool,tools}/*.{js,ts}`，并把外部定义转为统一 Tool.Def；plugin 也能提供工具。这个结构对于二次开发极其友好，因为你不需要改核心仓库就能加新工具。

### Skill 在 OpenCode 中更轻，但也因此更容易进化

OpenCode 的 SkillTool 与 SystemPrompt.skills 逻辑说明：skills 是被显式列出来的资源，系统提示词会告诉模型“有这些 skill，可用 skill tool 加载”，同时 registry 在工具描述中也能插入当前可用 skills。

这比 Claude Code Rebuilt 轻很多。它的好处是：

- 理解成本低；
- 调试容易；
- 可控性强。

### TaskTool：OpenCode 最值得保留的“未来支点”

OpenCode 的 `TaskTool` 不是“为了支持 subagent 临时加的一个接口”，而是真正把子任务做成了：

- 可创建；
- 可恢复；
- 可指定 agent 类型；
- 可继承和裁剪权限；
- 可独立会话；
- 可被主线程以工具形式调度。

## 3.4 MCP：两者都支持，但 OpenCode 更容易在接入层做治理

Claude Code Rebuilt 的 MCP 能力与系统深度整合，甚至 MCP instructions 会进入 system prompt，mcpClients/mcpResources 也进入 ToolUseContext。它更像“把 MCP 当作系统扩展总线”。

OpenCode 的 MCP 则更多体现在：

- prompt 层将 mcp tools 注入当前 tools；
- 每个 MCP 调用也经过 tool.execute.before/after plugin hook；
- 仍然要走统一 permission ask；
- 输入 schema 会被 provider transform。

这种设计没有 Claude Code Rebuilt 那么“原生一体化”，但治理起来很舒服。你可以很自然地：

- 统计某类 MCP 工具的 token 消耗；
- 给某些 MCP 工具加截断与 summarize wrapper；
- 给某类 MCP 工具单独设权限策略；
- 将高噪声 MCP 输出自动摘要化。

## 3.5 两者在工具与代理体系上的真正差异

### Claude Code Rebuilt 的强项
- 工具生态更全面；
- 技能生命周期更完整；
- 子代理与系统主循环结合得更深；
- tool context 能影响 prompt、agent 行为、状态追踪；
- 并发与只读工具调度更成熟。

### OpenCode 的强项
- registry 设计更干净；
- agent、tool、plugin、provider 的边界更明晰；
- task 作为工具的设计更利于持续扩展；
- 更适合做按模型差异化工具暴露；
- 更适合做可观测、可测试、可替换的工程。

## 3.6 OpenCode 的建议改造方向

### 第一项：给 Tool.Def 增加更多元数据
建议在 registry 层为工具补充元数据，例如：

- `readonly`
- `parallelSafe`
- `returnsLargeText`
- `supportsPreview`
- `preferredForAgents`
- `compactPriority`

### 第二项：把 Skill 做成跨 compact 的弱持久资源
可以做轻量版：

- 记录本 session 已调用 skills；
- compact 时自动把“skill 名称 + 简短摘要 + 文件路径”带入摘要；
- 必要时允许在 compact 后自动重提示已调用 skills。

### 第三项：为 TaskTool 建立子代理结果标准化协议
建议所有子代理结果统一输出：

- `summary`
- `key_files`
- `open_questions`
- `next_actions`
- `confidence`
- `cost`

### 第四项：在 MCP 层增加统一输出瘦身器
高噪声 MCP 工具非常容易把上下文炸掉。建议对 MCP tool output 加统一的：

- preview
- truncation
- optional summary
- path/reference fallback

## 3.7 最终判断

工具、MCP、Skill、子代理这一块，Claude Code Rebuilt 的能力上限更高；  
OpenCode 的工程秩序更好，更适合你继续做体系化增强。

如果你后续只做两件事，我建议优先做：

1. **TaskTool 结果标准化 + 角色化模型路由**  
2. **Skill 与 MCP 输出的跨 compact 轻持久化**



## 3.8 从“工程整洁度”再看一遍：为什么 OpenCode 的 registry 值得你珍惜

如果你真的打算把 OpenCode 做成自己的长期 CLI，那么 `registry.ts` 是最不应该被破坏的模块之一。因为它承担了一个非常关键的职责：**把“系统具有什么能力”和“当前回合向模型展示什么能力”分开。**

这两个概念看似接近，实际上天差地别。

一个项目可以在内部安装二十种工具，但当前回合不一定都该暴露给模型。比如：
- plan agent 不应该看到 edit/write 这类执行工具；
- compaction agent 根本不应该看到 bash；
- 某个 provider 或某类模型不适合暴露 patch 类工具；
- 某些工具在当前 client 模式下就不该打开；
- 某些实验工具只应该在特定 flag 下出现。

Claude Code Rebuilt 也有类似能力，但它的实现路径更偏“系统深处的条件组合”；而 OpenCode 把这件事放在 registry 层，意味着你将来做任何优化，都能围绕一个很干净的中心点展开。

## 3.9 Skill 体系为什么不必一开始就做得像 Claude 那么重

很多人看到 Claude Code Rebuilt 的 skill 机制，会很自然地产生一种冲动：把 OpenCode 的 skill 也做成跨 compact 恢复、跨 agent 记忆、跨 prompt 注入的全功能体系。这个方向没错，但时机要非常谨慎。

因为 skill 体系一旦过重，会迅速出现两个副作用：

第一，skill 会从“按需指令资源”变成“系统级常驻状态”。这会让系统提示词、compact、memory、task 协同都变复杂。  
第二，skill 一旦深度耦合进 query 行为，它就不再只是“可选能力”，而会开始影响几乎所有回合的成本结构。

OpenCode 当前的 skill 体系更轻，反而给了你一个更舒服的演进起点。推荐做法不是直接重构成 Claude 式 rich lifecycle，而是分三步走：

第一步，增强可发现性。  
第二步，增强“已调用 skill”的持久性。  
第三步，增强“重入能力”。

## 3.10 子代理体系的下一阶段：从“会调用”走向“可运营”

OpenCode 今天的 TaskTool 已经能把子代理跑起来，但真正要把多 agent 做成优势，而不是成本黑洞，你还需要再往前走一步：**让子代理成为可以被运营的资源。**

所谓“可运营”，至少包括以下几件事：

### 一，能度量
每个子代理要知道：
- 自己用了多少 token；
- 读了多少文件；
- 调了多少工具；
- 最后产出了什么粒度的结果；
- 是否真的减少了主线程负担。

### 二，能压缩
Explore 类子代理的输出特别容易变成长段观察日志。必须要求它们以结构化 envelope 返回，否则越多子代理，主上下文越快膨胀。

### 三，能恢复
如果用户下一轮继续同一问题，或者任务被 compact 过一次，系统应该尽量恢复已有 task session，而不是再新开一个“几乎重复”的子任务。

### 四，能分档
并不是所有子代理都值得上强模型。  
Explore 可能更适合便宜模型；  
Plan 可能需要更强模型；  
Summary/Compaction 则应该极便宜。

## 3.11 MCP 治理的一个关键原则：不要只盯着权限，要盯着输出形状

很多工程师做 MCP 接入时，第一反应是权限系统。权限当然重要，但从上下文成本角度，更关键的是**输出形状**。

后续对 MCP 的治理，建议你把“输出形状”作为一个一等问题来设计：

- 能否只返回 preview 而把全文落盘；
- 能否返回结构化元数据而非长自然语言；
- 能否对高噪声字段自动做丢弃；
- 能否对长输出先本地 summarize 再回传给模型；
- 能否把“这类 MCP 结果适合 compact 掉”的信号写入 metadata。

## 3.12 最终补充结论

工具、MCP、Skill、子代理这块，Claude Code Rebuilt 给你的是一个“高完成度样板”；OpenCode 给你的是一个“高可塑性平台”。

如果你的目标是继续建设自己的体系，那么工具系统的核心不是“赶紧变多”，而是：
- 让 registry 成为真正的能力总线；
- 让 Skill 保持轻而可进化；
- 让 Task 成为多 agent 的运营中心；
- 让 MCP 输出变成被治理的资源，而不是被动洪水。


---

# 系统提示词、Agent 模式控制与路由设计对比：OpenCode vs Claude Code Rebuilt

## 4.1 提示词系统不是“写一段长 prompt”，而是系统架构的一部分

在 coding agent 里，系统提示词最常被误解。真正成熟的 agent 系统里，prompt 从来不是一段静态文本，而是：

- 与工具表一起生成；
- 与 agent 模式绑定；
- 与 provider 模板绑定；
- 与 permissions、skills、MCP 指令绑定；
- 与上下文压缩和恢复机制绑定。

这正是 OpenCode 与 Claude Code Rebuilt 差异很大的地方。

## 4.2 Claude Code Rebuilt：提示词是主系统的延伸，而不是独立资源

### `constants/prompts.ts` 的意义：不是一份静态 prompt，而是一整套 section 生成器

Claude Code Rebuilt 的 `prompts.ts` 非常能说明问题。它不是一段单文件 prompt，而是一系列 system prompt sections 的生成系统。你可以看到其中会拼入：

- hooks section
- system reminders
- language section
- output style section
- MCP instructions section
- system section
- doing tasks section
- actions with care section
- 以及大量与工具名、slash commands、plan mode、技能、模型家族、环境信息相关的动态内容

这种设计很强，因为它带来三种收益：

第一，针对不同模型族、不同输出风格、不同语言偏好，可以动态拼接。  
第二，系统提示词本身可以与工具系统深度保持同步。  
第三，可以做缓存友好与动态段分离，从而降低 system prompt 反复发送的成本。

### Claude Code Rebuilt 的 prompt 与工具、skills、MCP 是强联动的

在这个项目里，prompt 不只是描述工具，而是随着：

- 当前工具列表；
- skill discovery 结果；
- MCP server instructions；
- plan mode 状态；
- hooks 配置；
- output style；
- language preference；
- 某些实验 feature

一起变化。

### plan mode 与角色切换在 Claude Code Rebuilt 中更偏“原生状态机”
Claude Code Rebuilt 不只是“有个计划模式工具”，而是 plan mode 会影响权限、影响 prompt 注入、影响 compact 恢复，并且在主系统里被明确视为一种状态。

## 4.3 OpenCode：提示词系统更加模块化，模式控制更显式

### `session/system.ts`：按 provider 选择系统基底 prompt

OpenCode 的提示词体系有一个很好的特点：  
它把 provider-specific prompt 模板单独抽了出来。

在 `system.ts` 里，你能看到它会根据模型 ID 选择：

- anthropic
- gpt
- codex
- gemini
- kimi
- trinity
- default
- 特殊 beast 模板

这一步非常重要。因为不同 provider 对 tool calling、system prompt 风格、冗余约束的容忍度不同。OpenCode 不是试图用一套 prompt 打所有模型，而是承认 provider 差异，并建立 provider prompt 层。

### `session/prompt.ts`：把模式控制、工具注入、任务切换都拉到 prompt 层显式处理

这个文件里能看到：

- 计划模式的 workflow prompt；
- build-switch 提示；
- max-steps 控制；
- structured output system prompt；
- 工具 schema 解析与注入；
- task tool / subagent 调用；
- MCP tool 注入；
- plugin before/after execute 钩子。

尤其是 plan mode，那段 prompt 设计非常明确：  
先用 explore agent 做理解，再用 general agent 做设计，再写 plan file，最后必须 `plan_exit`。

### `agent.ts`：角色不是 prompt 里的约定，而是显式对象

OpenCode 的 agent 角色注册尤其值得保留。`build`、`plan`、`general`、`explore`、`compaction`、`summary`、`title` 都是显式对象，各自有：

- mode
- hidden / native
- permission
- 可选 model
- prompt
- option
- steps

## 4.4 两者最本质的差别

Claude Code Rebuilt 的 prompt 系统非常强，强在：

- 动态 section 极多；
- 与工具和会话状态深度一致；
- 能做缓存分段；
- 与 plan mode、skill、MCP、hooks 深度耦合。

OpenCode 则更像：

- provider 层模板；
- agent 角色层 prompt；
- session/prompt 执行层装配；
- plugin/hook 层补充。

它的表现可能不如 Claude Code Rebuilt 那样“老辣”，但它更利于你做自己的策略创新。

## 4.5 OpenCode 最值得做的路由增强

### 4.5.1 真正的角色化模型路由
默认路由表建议：

- build -> 强模型
- plan -> 强模型或高 reasoning 模型
- general -> 中档模型
- explore -> 便宜长上下文模型
- compaction -> 便宜模型
- summary/title -> 极便宜模型

### 4.5.2 Prompt Layer 应该开始输出“角色成本意识”
比如 explore agent 提示：

- 优先列出关键文件，不要过度展开；
- 尽量用路径、符号名、简要结论，而不是大段复述；
- 对长输出生成结构化 findings。

### 4.5.3 compact / summary agent 应采用专门的高度结构化 prompt
OpenCode 已经有 compact/summary agent，但还可以进一步升级成：

- 当前目标
- 已完成工作
- 未完成工作
- 关键文件
- 关键命令/验证
- 失败尝试
- 用户约束
- 下一轮建议第一步

## 4.6 OpenCode 不应该照抄 Claude Code Rebuilt 的地方

OpenCode 不需要复制的是：

- 过多的实验 feature prompt 分支；
- 与主循环高度纠缠的 prompt 拼接逻辑；
- 太深的内核级隐式模式切换；
- 让工具与 prompt 互相引用到难以维护的程度。

它应该吸收的是“原则”，而不是“复杂度”。

## 4.7 最终判断

提示词与模式控制这一项，Claude Code Rebuilt 的成熟度更高；  
OpenCode 的可设计空间更大。

对你后续项目而言，最优路线是：

- 保留 OpenCode 的 provider prompt 层、agent 对象层、session/prompt 装配层；
- 借鉴 Claude Code Rebuilt 的 section 化思想和动态恢复意识；
- 在 OpenCode 里建立更清晰的角色化模型路由与 compact/summary 结构化输出。



## 4.8 系统提示词真正要解决的，不只是“说什么”，而是“如何少说却不失控”

系统提示词经常被做得越来越长，尤其在 coding agent 里，很容易出现一种坏习惯：一旦发现模型在某件事上做得不好，就往 system prompt 里再加一条规定。久而久之，prompt 变成巨大的规章制度集合。

Claude Code Rebuilt 之所以虽然复杂、却仍然显得相对成熟，关键不在于它“写了更多规定”，而在于它把 prompt 做成了**分层 section**，并且区分了哪些内容可以缓存，哪些内容必须动态生成。

OpenCode 当前已经具备 provider prompt 层和 agent prompt 层，这是很好的开始。后续你应该重点强化的，不是单纯把 prompt 变长，而是做三件事：

### 一，建立“常驻信息”和“动态信息”的明确边界
比如：
- 常驻：基本行为规范、工具哲学、风险原则；
- 角色常驻：某 agent 的工作职责；
- 动态：当前工作目录、当前 agent、当前可用 skills、当前 plan 文件、当前 workset。

### 二，让提示词尽量消费结构化状态，而不是重复自然语言叙事
如果系统已经知道：
- 当前计划文件路径；
- 最近工作集；
- 已调用技能；
- 当前 agent 类型；
- 当前工具列表；

那么 prompt 不应再长篇累牍地“解释世界”，而应尽量使用结构化区块，让模型快速对齐状态。

### 三，让模式控制成为对象化状态，而不是继续堆文字规则
OpenCode 现在这一点做得比很多项目好。plan/build/general/explore/compaction 都是对象，不只是 prompt 中的一句“你现在扮演……”。你后续应继续沿着这条路走，而不是退回到“为了省事，把模式差异都写进一长段 system prompt 里”。

## 4.9 对 OpenCode 的一个重要建议：把 Agent Prompt 设计成“可组合块”而不是“整段模板”

当前 OpenCode 的模式控制已经足够清楚，但如果后续要继续增强，我建议你把 agent prompt 更进一步拆成可组合块，例如：

- `role`：职责说明
- `tooling_policy`：工具使用策略
- `cost_policy`：成本意识与输出节制
- `verification_policy`：验证要求
- `handoff_policy`：对子代理或 compact 的交接格式
- `safety_policy`：高风险动作的确认规则

然后不同 agent 去组合不同块：
- build：role + tooling_policy + verification_policy + safety_policy
- plan：role + tooling_policy（只读版） + handoff_policy
- explore：role + cost_policy + handoff_policy
- compaction：role + handoff_policy + structured summary policy

## 4.10 路由策略应该和 prompt 策略联动，而不是两套平行配置

很多系统在做多模型路由时，只做了“agent A 用模型 X，agent B 用模型 Y”。这远远不够。因为不同模型对 prompt 风格的承载能力不同：

- 有的模型喜欢简短硬规则；
- 有的模型适合较强的步骤化指令；
- 有的模型对 structured output 非常听话；
- 有的模型遇到过长的政策性 prompt 反而变笨。

OpenCode 的 `system.ts` 已经有 provider-specific prompt，这是非常好的基础。后续你做 agent 路由时，应该把路由策略与 prompt block 策略绑在一起。

## 4.11 最终补充结论

系统提示词这一模块里，Claude Code Rebuilt 最值得你学习的，不是某一段具体话术，而是三种意识：

- section 化意识；
- 动态边界意识；
- 状态恢复意识。

而 OpenCode 最值得你坚持的，则是：

- provider 分层；
- agent 对象化；
- prompt 装配集中化；
- 模式切换显式化。

只要你把这两组优点结合起来，OpenCode 在这块不需要照抄 Claude，也能走到非常强的水平。


---

# 内置工具设计对比：Read / Edit / Bash / Task 的系统性分析

## 5.1 为什么这四个工具最值得比较

无论工具列表多长，coding agent 的核心执行闭环始终离不开四类动作：

- **Read**：把世界读进来；
- **Edit**：把改动写回去；
- **Bash**：用运行时验证或探索外部状态；
- **Task**：把复杂任务切给其他 agent/子流程。

这四类工具决定了一个 agent 的基本姿态。

## 5.2 Read：Claude Code Rebuilt 更“生态型”，OpenCode 更“边界清晰”

Claude Code Rebuilt 的读取不是孤立工具。它在整个系统里常与：

- skill discovery
- memory prefetch
- agent exploration
- compact 恢复
- plan mode
- tool search

一起发生。也就是说，它的读文件行为往往嵌在更大的策略里。系统不是简单地“用户叫你 read 你就 read”，而是围绕当前 query、当前技能、当前模式与当前压缩状态去决定读什么、读多少、读后怎样进入后续状态。

OpenCode 的 `read.ts` 则展示了另一种风格。它的边界相当清晰：

- 有默认读取行数限制；
- 有最大行长与最大字节数限制；
- 路径解析明确；
- 目录和文件分开处理；
- 二进制、图片、PDF 会走专门附件逻辑；
- 会在读之前 ask permission；
- 元数据中会标注 preview、truncated、loaded 等信息。

这类 Read 设计非常利于做“高性价比上下文控制”。

### OpenCode 的可优化方向
- 增加重复读取抑制
- 支持“摘要替代原文”的可选模式
- 维护一个工作集视图

## 5.3 Edit：OpenCode 的 Edit 非常适合继续打磨

OpenCode 的 `edit.ts` 是一个非常好的基础实现。它具备几个很关键的优点：

- 使用 per-file semaphore，避免并发编辑同一文件；
- 参数简单明确：`filePath`、`oldString`、`newString`、`replaceAll`；
- 保留行尾风格；
- 在写入前 ask permission，并把 diff 作为 metadata；
- 写入后自动 format、发布 file edited / watcher updated 事件；
- 再跑 LSP diagnostics，把错误反馈回输出。

### OpenCode Edit 应继续增强的方向
- 增加“多处候选匹配解释”
- 把 edit 结果摘要化写入工作集日志
- 为 edit 工具补充“连续编辑批次”概念
- 未来加入“显式 region anchoring”模式

## 5.4 Bash：应当成为受预算控制的高价值工具，而不是上下文黑洞

Claude Code Rebuilt 的 Bash 融入整体权限与风险系统，它在高阶任务中很自然地承担探索、验证、测试等动作。问题不在功能，而在：它返回的信息如果缺少治理，很容易把上下文炸掉。因此 Claude Code Rebuilt 才会非常强调 tool result budget、summary 与压缩层。

OpenCode 当前的优势在于，Bash 处于统一 permission、plugin before/after hook、tool metadata 路径下，说明它天然适合被预算治理系统接管。

### OpenCode 对 Bash 的建议强化
- 建立 Bash Output Normalizer  
- 区分“验证型”与“探索型”命令  
- 把 Bash 结果纳入 ToolResultBudget 的重点治理对象  
- 在 compact 摘要中单独保留“已运行验证步骤”与“失败命令”  

## 5.5 Task：OpenCode 当前最强资产之一

Claude Code Rebuilt 中子代理是整个系统的天然部分，因此表现得非常强大。但 OpenCode 的 `TaskTool` 更适合后续平台化发展。它把子任务做成了：

- 可创建；
- 可恢复；
- 可指定 agent 类型；
- 可继承和裁剪权限；
- 可独立会话；
- 可被主线程以工具形式调度。

这意味着你完全可以围绕 Task 做很多“平台级能力”：

- 子代理缓存；
- 子代理模型分档；
- 子代理质量评分；
- 子代理摘要标准化；
- 子代理并发上限控制；
- 子代理工作集隔离；
- 子代理 token 账本。

### TaskTool 的下一步应当是什么
- 标准化结果输出，不要只是自由文本 `<task_result>`  
- 引入 resume policy  
- 给 explore/build/general/summary 等角色建立不同预算和 compact 策略  
- 把 task 生命周期纳入 benchmark harness  

## 5.6 四个核心工具的总体判断

### Read
OpenCode 更适合继续做成“成本敏感的上下文入口”。  
Claude Code Rebuilt 更像“强 agent 生态中的读取器”。

### Edit
OpenCode 的 Edit 很漂亮，是非常好的长期打磨基础。  
Claude Code Rebuilt 的 Edit 胜在系统协同，而不一定胜在单模块优雅。

### Bash
OpenCode 当前结构更适合把 Bash 做成受预算治理的高价值工具。  
Claude Code Rebuilt 已经证明 Bash 必须被纳入整体上下文系统治理。

### Task
OpenCode 的 TaskTool 是当前最值得下注的基础设施。  
它未必今天就比 Claude Code Rebuilt 更强，但它是更适合你继续做深的一块。



## 5.7 进一步的源码级观察：Read 与 Edit 为什么构成了 OpenCode 的“舒适基础”

OpenCode 这两个工具有一个共同特点：**都在工具层就开始做约束，而不是把约束全部留给主循环或 prompt。**

Read 的约束包括：
- 默认读取上限；
- 目录分页；
- 图片/PDF 特别处理；
- preview 与 loaded 元数据；

Edit 的约束包括：
- 同文件锁；
- old/new string 的严格替换语义；
- permission ask；
- diff metadata；
- format + file watcher + LSP diagnostics。

这意味着 OpenCode 的核心工具不是“黑箱工具”，而是天然携带大量可治理信号。后续你做预算、compact、benchmark 时，这些信号会非常有用。相比之下，很多 agent 项目之所以会慢慢变得不可控，就是因为工具层返回的只是大段文本，缺乏结构化 metadata。

## 5.8 未来最值得新增的一层：工具输出形状契约

如果你真想把 OpenCode 做成一个高性价比 agent，后续一定要建立“工具输出形状契约”。也就是说，不同工具都应该逐渐统一成：

- `title`
- `output`
- `metadata.preview`
- `metadata.truncated`
- `metadata.artifactPath`（如有）
- `metadata.semanticType`
- `metadata.compactPriority`

为什么这件事重要？因为只要工具输出形状统一了：
- Tool Result Budget 才能做得更聪明；
- Micro-Compaction 才能跨工具工作；
- Session Memory 才能知道哪些结果值得沉淀；
- Benchmark 才能比较不同工具链的真实成本。

OpenCode 已经有相当好的雏形，现在最适合把它继续收束成系统级协议。

## 5.9 对 Claude Code Rebuilt 的一个重要启发：工具本身也要有“会话观”

Claude Code Rebuilt 虽然在单个工具实现上未必总是更优雅，但它给你一个很重要的启发：**工具不是一次性动作，而是会话生态的一部分。**

比如读取工具不只是把文件内容给模型，还会影响后续工作集、技能发现、compact 恢复与任务路线；bash 不只是运行命令，而会变成预算治理对象和验证历史；skill 与 task 更是直接参与 agent 行为学。

所以 OpenCode 后续加强工具时，也不要只想着“把每个工具做强”，还要问：
- 这个工具如何被 compact 理解？
- 这个工具如何被 memory 提炼？
- 这个工具的结果如何进入 task handoff？
- 这个工具是否应该在不同 agent 下有不同输出策略？

## 5.10 最终补充结论

从内置工具这一章可以得出一个非常实际的结论：

- OpenCode 已经有一组很适合长期打磨的“优雅基础工具”；
- Claude Code Rebuilt 则提醒你：这些工具最终必须被放回整个会话系统里看。

因此，你后续不需要推翻 OpenCode 的 Read/Edit/Bash/Task 设计，真正应该做的是：

**给它们建立统一的输出治理层与会话级协同关系。**



## 5.11 再进一步：四类工具之间其实应该形成“工具链协同”而不是彼此孤立

真正强的 coding agent，不会把 Read、Edit、Bash、Task 看成四个相互独立的按钮，而会让它们形成一个闭环。Claude Code Rebuilt 给人的“完成任务很顺”之感，某种意义上正来自这种闭环感。

理想状态下，这四类工具之间应该形成如下关系：

### Read -> Task
读取不是终点，而是决定是否值得派发 explore/general/build 子代理的依据。  
如果某文件群已经被 Read 命中并确认为关键工作集，TaskTool 在拆任务时就应该直接携带这些文件线索，而不是让子代理重新从零搜索。

### Task -> Read
子代理返回的结果，不应只是“我看完了，结论如下”，而应明确指出：
- 哪些文件已经足够读过；
- 哪些文件只是可能相关；
- 哪些文件建议主线程继续深读。

这样主线程后续的 Read 才不会盲目重复。

### Read/Edit -> Bash
如果这轮编辑修改了某个测试文件、某个构建入口、某个接口实现，那么 Bash 的下一步验证命令就不应由模型自由发挥，而应尽量从工作集和修改信息中推导。也就是说，Edit 不只是改文件，还应把“建议验证入口”沉淀为结构化元数据。

### Bash -> Session Memory / Compact
验证命令的通过与失败，不应只是短期输出。  
对复杂任务来说，“哪些命令已经跑过、结果如何、失败在哪里”本身就是重要状态，应该在 compact 或 session memory 中被保留。

OpenCode 当前最大的机会，就在于它的工具层已经足够结构化，完全可以把这种协同显式化地做出来，而不必依赖隐藏魔法。

## 5.12 面向 OpenCode 的一个具体建议：建立 Tool Lifecycle Hooks

虽然 OpenCode 已经有 `tool.execute.before/after` 插件触发点，但如果你未来想把工具协同做深，建议继续往前走一步，形成真正的 Tool Lifecycle 约定。比如：

- `tool.normalize.before`
- `tool.execute.before`
- `tool.execute.after`
- `tool.summarize.after`
- `tool.compact.export`
- `tool.memory.export`

这样每类工具都能明确回答五个问题：

1. 执行前需要什么上下文；
2. 执行后原始输出是什么；
3. 对主线程更友好的摘要输出是什么；
4. compact 时该保留什么；
5. memory 时该沉淀什么。

对 Read 而言，compact export 可能是“关键文件列表 + 最近读过的段落范围”；  
对 Edit 而言，memory export 可能是“修改过的文件 + 核心差异 + 需要验证项”；  
对 Bash 而言，summarize after 可能是“命令意图 + 退出码 + 关键 tail”；  
对 Task 而言，compact export 则应是“子代理结论包”。

一旦这套 lifecycle 形成，OpenCode 的工具系统就不只是“能执行”，而会真正成为上下文治理和任务连续性的基础设施。

## 5.13 最终补充结论

内置工具这一章最值得你记住的，不是哪一个单独工具更花哨，而是：

- OpenCode 的工具已经足够优雅，适合做成系统级协议；
- Claude Code Rebuilt 则提醒你：工具最终必须参与整个会话、记忆、compact 与任务流的协同。

如果你后续认真做 Tool Lifecycle、工作集、预算与 memory 的联动，那么 OpenCode 在工具层的长期上限会非常高。


---

# OpenCode 改造蓝图与文件级落地方案

## 6.1 设计目标：不是复制 Claude Code，而是有选择地吸收其高回报机制

在真正开始改 OpenCode 之前，必须先把原则说清楚。

你现在最容易走入的误区，不是“改不够多”，而是“贪心地把 Claude Code Rebuilt 所有机制都搬过来”。这会直接毁掉 OpenCode 原本的结构优势。

因此，本蓝图坚持三个原则：

### 原则一：只引入高回报、低破坏的机制
优先移植那些能显著提升上下文性价比、长任务连续性、任务完成稳定性，但不要求重写整个运行时的东西。例如：

- Tool Result Budget
- Session Memory
- 角色化模型路由
- 轻量 Micro-Compaction
- Task 结果标准化

### 原则二：机制以独立服务形式接入，不破坏现有骨架
OpenCode 当前最大的优点是结构分层清楚。所有增强都应优先做成：

- service
- plugin trigger
- policy module
- metadata layer

### 原则三：每一项增强都必须能被 benchmark harness 衡量
否则“感觉更聪明了”这种主观反馈很快会误导你。

## 6.2 第一阶段改造：Preflight Pipeline

### 目标
把当前 OpenCode 在模型请求前较为简洁的准备流程，升级为一个清晰的预处理管线。目标不是无限复杂，而是把“发送前治理”做成显式系统能力。

### 新增模块建议
- `packages/opencode/src/session/preflight.ts`
- `packages/opencode/src/session/tool_budget.ts`
- `packages/opencode/src/session/workset.ts`
- `packages/opencode/src/session/micro_compaction.ts`

### 为什么从这里开始
因为这是影响全局成本与稳定性的最大杠杆，而且对现有结构侵入最小。

## 6.3 第二阶段改造：Tool Result Budget

### 目标
不等 overflow 才治理，而是在每轮前把旧工具输出压到预算内。

### 新增文件
- `packages/opencode/src/session/tool_budget.ts`

### 核心策略
按工具类型分预算：

- bash / webfetch / mcp：高风险膨胀工具，优先治理
- read / grep / glob / codesearch：中风险，按 preview+path 方式折叠
- task / summary：原则上保留摘要，不保留长原文
- edit / write：保留 diff 摘要和结果，不保留不必要重复描述

### 应修改的现有文件
- `session/prompt.ts`：模型调用前注入 budget
- `tool/registry.ts`：为 Tool.Def 补充 `returnsLargeText`、`compactPriority` 等元数据
- `tool/*`：逐步让高膨胀工具输出更多结构化 metadata

## 6.4 第三阶段改造：Session Memory

### 目标
建立“主上下文之外的慢变状态存储”。

### 新增文件
- `packages/opencode/src/session/memory.ts`
- `packages/opencode/src/session/memory_prompt.txt`
- `packages/opencode/src/session/memory_store.ts`

### 触发条件建议
满足以下条件之一时触发 memory 提取：

- token 较上次增长超过阈值；
- 工具调用累计超过阈值；
- plan/build 模式切换；
- task 子代理批量完成；
- full compaction 之前或之后。

### 注入方式建议
不要每轮都自动把 entire memory 注入 system prompt。  
更好的方式是：

- 由 preflight 判断当前任务是否需要 recall；
- recall 时只注入 relevant sections；
- compact 后优先注入 memory 摘要，而非整个长历史。

## 6.5 第四阶段改造：Micro-Compaction

### 目标
在 full compaction 之前，新增一个低成本中间层。

### 新增文件
- `packages/opencode/src/session/micro_compaction.ts`

### 适用对象
- 多段连续 read 输出
- 多段 grep / code search 输出
- 多段 bash 错误输出
- 多个 explore 子代理返回

## 6.6 第五阶段改造：角色化模型路由

### 目标
让 agent 架构真正成为“高质量 / 高性价比”的核心抓手。

### 应修改的现有文件
- `agent/agent.ts`
- `session/prompt.ts`
- `provider/*`
- `config/*`
- 可新增 `agent/router.ts`

### 建议策略
默认路由表：

- build：强模型
- plan：强模型 / reasoning 模型
- general：中档模型
- explore：便宜但长上下文/高搜索性价比模型
- compaction：便宜模型
- summary/title：极便宜模型

## 6.7 第六阶段改造：TaskTool 结果标准化

### 目标
把多 agent 协同从“好用”升级为“可运营、可压缩、可评测”。

### 应修改的文件
- `tool/task.ts`
- `session/prompt.ts`
- `agent/agent.ts`
- 可新增 `session/task_result.ts`

### 推荐结果结构
- `summary`
- `key_files`
- `open_questions`
- `next_actions`
- `confidence`
- `cost`

## 6.8 第七阶段改造：工作集 Workset

### 目标
让系统显式知道“当前真正相关的文件集合”。

### 新增文件
- `session/workset.ts`

### 输入来源
- ReadTool
- EditTool
- TaskTool 结果
- grep/code search 命中
- bash 中出现的文件路径

### 输出用途
- compact 摘要重点保留
- preflight recall 提示
- build agent prompt 提示
- benchmark 统计“工作集膨胀率”

## 6.9 第八阶段改造：观测与评测钩子

### 目标
所有策略升级都必须可量化。

### 建议新增
- `metrics/session_metrics.ts`
- `metrics/tool_metrics.ts`
- `metrics/agent_metrics.ts`

### 关键指标
- 单任务总 token
- compact 次数
- budget 减少量
- 子代理数量与成本
- 工具输出压缩比
- 人工修正轮次
- 首次完成率

## 6.10 推荐实施顺序

1. Preflight Pipeline
2. Tool Result Budget
3. Session Memory
4. TaskTool 结果标准化
5. 角色化模型路由
6. Micro-Compaction
7. Workset
8. Metrics & Harness

## 6.11 最终建议

如果你要让 OpenCode 在未来成为一个：

- 任务质量不差；
- 上下文成本可控；
- 长任务不容易失忆；
- 多 agent 协作自然；
- 结构仍然优雅；

的 CLI，那么最应该坚持的一点是：

**永远以服务与策略的方式增强它，而不是把所有聪明逻辑重新塞回一个巨大的 prompt 主循环。**



## 6.10 再往前一步：建议把改造分成“硬机制”和“软机制”两类

如果把所有改造都放在一个迭代里，你很难判断哪项真正有效。建议你把它们拆成两大类：

### 硬机制
直接影响数据流或会话状态：
- Tool Result Budget
- Session Memory
- Micro-Compaction
- Workset
- Task 结果标准化

### 软机制
更多影响行为策略或成本选择：
- 角色化模型路由
- Prompt cost policy
- Agent-specific output schema
- Compact prompt 强化
- Verification policy

先做硬机制，你会更快看到 token 与连续性改善；  
再做软机制，才能真正提升完成率和体感。

## 6.11 文件级落地顺序的一个更细版本

### Sprint 1：观测打底
改：
- `session/prompt.ts`
- `tool/registry.ts`
- 新增 `metrics/*`

目标：
- 能测每轮 token、每次 tool output 大小、每个 agent 成本。

### Sprint 2：预算层
改：
- 新增 `session/tool_budget.ts`
- `session/prompt.ts`
- 为高噪声工具补 metadata

目标：
- 压低长任务中旧工具输出占比。

### Sprint 3：Session Memory
改：
- 新增 `session/memory.ts`
- `session/compaction.ts`
- `task.ts`

目标：
- 把慢变状态移出主上下文。

### Sprint 4：Task 标准化 + 路由
改：
- `task.ts`
- `agent.ts`
- `session/prompt.ts`
- 新增 `agent/router.ts`

目标：
- 多 agent 成本可控、结果可运营。

### Sprint 5：Micro-Compaction + Workset
改：
- 新增 `session/micro_compaction.ts`
- 新增 `session/workset.ts`
- `read.ts` / `edit.ts` / `bash.ts` 接入工作集更新

目标：
- full compaction 次数下降，长任务连续性上升。

## 6.12 再强调一次：OpenCode 的正确胜法不是变成另一个 Claude

这一点值得反复说。你最终要赢，不是靠“看起来更复杂”，而是靠：

- 在相同预算下完成更多任务；
- 在相同复杂度下让系统更稳；
- 在后续几个月里仍能持续演进而不把自己拖垮。

Claude Code Rebuilt 给你的是大量宝贵启发，但 OpenCode 要走的是“有节制地吸收”，不是“冲动式模仿”。

## 6.13 最终建议

如果你要让 OpenCode 在未来成为一个：
- 任务质量不差；
- 上下文成本可控；
- 长任务不容易失忆；
- 多 agent 协作自然；
- 结构仍然优雅；

的 CLI，那么最应该坚持的一点是：

**永远以服务与策略的方式增强它，而不是把所有聪明逻辑重新塞回一个巨大的 prompt 主循环。**

OpenCode 的成功，不会来自“越来越像 Claude Code Rebuilt”，而会来自：

**在保持自身架构整洁的前提下，有节制地吸收 Claude Code Rebuilt 那些真正高回报的机制。**


---

# 评测基线与 Benchmark Harness 设计

## 7.1 为什么必须先建评测，而不是先拼命改

做 agent 项目最危险的一件事，就是你非常容易“觉得它变好了”。  
更聪明的提示词、更复杂的上下文系统、更多的 agent 角色、更多的 hooks，看起来都像进步。但如果没有一套稳定的评测，你其实并不知道：

- 它是不是只是变贵了；
- 它是不是只是把原本一次完成的任务拆成了三次；
- 它是不是因为 compact 更频繁而导致任务成功率反而下降；
- 它是不是虽然答案更像“高级工程师”，但实际返工变多。

所以 benchmark harness 不是锦上添花，而是你整个项目能否健康演进的前提。

## 7.2 评测目标：不是只看 token，也不是只看任务完成

建议把评测分成三层。

### 第一层：任务结果层
- 是否完成任务
- 是否第一次就完成
- 是否引入明显回归
- 是否通过验证步骤
- 是否满足用户约束

### 第二层：过程成本层
- 总输入 token
- 总输出 token
- 总工具输出 token
- compact 次数
- tool budget 减少量
- 子代理数量与成本
- 总回合数

### 第三层：人工返工层
- 用户需要追加澄清的轮次
- 用户需要纠正的次数
- 用户需要自己手改的文件数
- 用户是否需要重置任务/重开新任务

## 7.3 任务集应该如何构建

建议至少构建四类任务集。

### 小修小补集
修一个明确报错、改一个 API 字段名、加一个参数、修一个测试。

### 中型重构集
提取公共逻辑、修改一组相关文件、加一层中间抽象、替换旧接口实现。

### 长任务探索集
用户只给高层目标，需要 explore + plan + build，需要读多个目录与配置，需要运行命令验证。

### 高噪声工具集
大量 grep/read/bash 输出，MCP 返回长文本，日志分析与错误定位。

## 7.4 对比维度设计

建议每条任务跑多组配置：

- 基线组：原始 OpenCode
- 对照组 A：OpenCode + Tool Result Budget
- 对照组 B：OpenCode + Tool Result Budget + Session Memory
- 对照组 C：OpenCode + Tool Result Budget + Session Memory + 角色化路由
- 对照组 D：OpenCode + 全部改造

## 7.5 Harness 需要记录什么

建议每次任务执行结束后记录一份 JSON：

- 任务 id
- 配置
- 模型映射
- 完成情况
- 输入输出 token
- 工具 token
- compact 次数
- tool budget 节省量
- 子代理数量
- follow-up 轮次
- manual corrections

## 7.6 如何衡量“返工也很实惠”

必须新增一个指标：

**Rework Efficiency =（最终完成所需总成本）/（第一次失败后的额外成本）**

如果一个方案第一次经常不完美，但二次修正极其廉价、结构也不乱，那它依然可能是好方案。

## 7.7 实施建议

- 从日志而不是 UI 抓数据
- 统一 replay 能力
- 先求稳定，再求规模

## 7.8 最终建议

benchmark harness 不是后话，而应该与第一批改造同步进行。

最推荐的顺序是：

1. 先给 OpenCode 增加基本 metrics 事件；
2. 再做 Tool Result Budget；
3. 再做 Session Memory；
4. 同时建立小规模 benchmark；
5. 然后用数据决定后续是否继续加 Micro-Compaction、复杂路由与更多 agent 角色。


---

# 源码检查清单与引用文件列表

## Claude Code Rebuilt
本研究重点参考的源码文件：

- `src/query.ts`
- `src/Tool.ts`
- `src/tools.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/SessionMemory/sessionMemory.ts`
- `src/constants/prompts.ts`

### 核心观察摘要
- `query.ts`：主循环中包含 memory prefetch、skill prefetch、tool result budget、snip、microcompact、contextCollapse、autoCompact、runTools、stop hooks 等。
- `autoCompact.ts`：auto-compact 采用保守阈值与缓冲区策略，不贴着模型上限执行。
- `compact.ts`：compact 前会剥离不适合总结的块，compact 后会重建最小工作环境，包含 skills 与模式恢复。
- `sessionMemory.ts`：存在会话旁路记忆提取逻辑，用于长期状态沉淀。
- `Tool.ts`：ToolUseContext 面很宽，说明工具系统与系统状态耦合较深。
- `tools.ts`：工具面非常大，且包含 agent/skill/task/search 等高阶能力。
- `prompts.ts`：系统提示词不是静态文案，而是动态 section 装配系统。

## OpenCode
本研究重点参考的源码文件：

- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/overflow.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/tool/edit.ts`
- `packages/opencode/src/tool/bash.ts`
- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/tool/plan.ts`

### 核心观察摘要
- `agent.ts`：agent 角色对象化，包含 build/plan/general/explore/compaction/summary/title。
- `prompt.ts`：会话 prompt 装配中心，处理模式控制、工具注入、MCP、structured output、task 调用等。
- `system.ts`：provider-specific 系统 prompt 模板分层清晰。
- `compaction.ts`：prune-first + compaction agent 方案，且 compact prompt 可通过 plugin 改写。
- `overflow.ts`：使用 usable window，而不是贴模型理论上限。
- `server.ts`：OpenCode 是明显的 client/server runtime，而非单一 CLI 入口。
- `registry.ts`：工具注册是整个项目的关键资产，支持 builtin、custom、plugin，并根据模型/agent 决定暴露。
- `read.ts`：读取边界明确、适合做成本控制入口。
- `edit.ts`：Edit 工具实现严谨，是长期打磨的好基础。
- `task.ts`：TaskTool 是子代理会话与角色化工作流的优良基础设施。
- `plan.ts`：计划模式退出显式化。
