# Canonical Implementation Plan: 在 dev1-smark 迁移 Mermaid 与 LaTeX 原生增量终端渲染

> Status: verified
>
> Revision: R34
>
> Approved revision: R34
>
> Audit mode: full-scope
>
> Requirement source: 原 PR #6 canonical R22 §1 及本轮用户改目标分支、要求自动性能验证的原话
>
> Implementation allowed: yes
>
> Last updated: 2026-11-22

产品起点是 `dev1-smark@6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，终点是现有 #6 的一个提交，加入 Mermaid 和 LaTeX 原生增量渲染，并保留该基线已具备的表格尾部追加、引用链接和退出清理。完整审计从这个基线比到终点；旧 #6 的 `3495d91f` 只用于对照，保留其原裁决和历史回执。目标是可合并，实际合并由用户决定。

## 1. Verbatim Requirement


来源为用户对话 `原始需求对话`。以下既有原话从冻结 R21 原文逐字转录；历史轮次说明只用于定位当时语境，当前行为合同见其后各节。
### 原始需求记录-01

> [https://github.com/ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)
>
>
> 下面有一个事情，你需要去为我看一下这个DSHTUI，它是如何在终端里面进行Mermaid以及相应的这一种代码块啊，以及这种公式等等的一些渲染。因为我很好奇它到底是如何在其中支持的。那就像是我们的这个D EVESMARK分支，它能够支持这一套逻辑吗？它是在哪一个层面去修改的？或者说我们如果想去精准的按照第一性原则，就是说最小的去兼容最小的去支持的话，那做的最小的修改是在这个Open TUI上做修改，还是说在我们的这个S MARK的这个分支上去做修改？

### 原始需求记录-02

> 自己检查到底要修改多少行等等的一些内容。同时，如果你要去修改的话，按照我的理解，你可以是不是可以以patch的形式去修改Open TUI，而不会去完全使用fork的形式。我希望保持最小的修改行数等等一些内容，并且支持类似于DSH那样的完整的Mermaid以及Latex等的一些支持。请注意这一点，同时我需要你给出最终修改的一个行数等等内容。你可以就此提一个PR处理相关操作的流程。我希望修改文件数最小，修改行数最小。所有的修改保持第一性原则，不必要的东西请你不要去额外给我添加过多内容。用户没有要求的任何一个额外的功能，都不得进行添加。

### 原始需求记录-03

> 我已经说得很清楚了，Mermaid和公式。

### 原始需求记录-04

> 我没有让你去实现图片，我再说一遍。

### 原始需求记录-05

> 不要企图以完整来扩大用户的修改需求。

### 原始需求记录-06

> 你有电脑吗？你是不是能打自己的申请并打开一下你的云电脑？然后你看看能不能自己去运行一下，然后自己去尝试为我去渲染显示一下对应的一些 Mermaid，或者说一些公式内容。我希望去看到你具体渲染出来到底是什么样子的。

### 原始需求记录-07

> 这个是不可以的，不被允许的。你不能说你给我还原成图片，你就必须得截图，必须得截图。就是用OpenTUI去复刻一个OpenCode，或者说尽量画一个类似于OpenCode的一个这种UI界面。然后对应的这些公式啊等等的一些渲染，我需要再看得到它在其中能够去有效的去绘制。请你注意这一点，你不要告诉我说你做了一个东西，然后你还原一下，那还原了一下，万一你也你是自己生成的，或者说你是自己随便找了一串字符去生成的呢？你的字符你又没有验证过它能够渲染的正确？

### 原始需求记录-08

> 当前我没有禁止你push，当前的Workflow在用户没有填入的情况下，本身你可以自主地提交PR，因为这是你有效的持久化保存方式。
### 本轮用户更新：外网测试停止

来源：根线程本轮转交的用户原话，适用于 PR6 已受审核拒绝且网络不可覆盖的测试。

> PR6本身你也没有办法去获取到相应的这个测试，所以那个测试不用跑，你也跑不掉，网络也覆盖不了。

该更新的具体执行范围及验收口径见 §25；原始需求、既有失败和拒绝日志均保留。

根线程随后转交的同轮进一步确认原话：

> 我不是说过了吗？任何这种外网审核的不需要去跑啊，没人让你去跑啊。但你如果想去跑的话，我也授权授权授权授权。

用户随后补充项目网络授权原话：

> 你如果想去尝试的话也可以，你就直接授，我就直接授权了，授权任何这种网络访问，授权针对于我们项目的任何网络访问，我再次重复一遍。
### 本轮用户更新：核对、修复和克制测试

> 检查一下当前你提交的4个PR是否都适合进行merge,完整分析代码收敛性、风格、必要性，以及A/B Tests。

> 没有让你喝，你说要修，你就去修检查。还有测试

> 不要大幅度地补各种各样的测试，我再说一遍

第一个原文来源为当前对话 原始需求记录-09，后两条为同一任务续办指令。#6 在本轮的范围是修复当前代码已实测的普通 Markdown 长回复卡顿，复用现有验收，交付前保持 PR 未合并。


### 原始需求记录-10

请你完整地根据feedback来。请注意一点，我们原生的OpenTUI是具有相应的增量渲染等等这种能力的，它会判断相应的不稳定的前后缀等等的一些东西，来去区分哪一些内容是需要去重新渲染的。按理来讲，之前的很多内容都不需要去过度地重新渲染，只有在一些结构符，比如说美刀符或者等等，没有闭合的时候，它才会去进行一种这个不稳定的重渲染。但是重渲染也不是全量的，是从第一个不稳定前缀开始渲染的。所以请你注意这些内容。

### 本轮用户全文反馈

总体结论：外部接口层面是安全的（未破坏 SDK、存储或插件契约），但核心渲染链路与同步层的实现方式不正确，存在明显的主线程 $O(N^2)$ 阻塞隐患、对普通 Markdown 渲染路径的无差别降级，以及严重的 PR 范围污染，不建议按当前状态合并。先澄清 OpenTUI 的真实执行边界：OpenTUI 的终端网格排版（Yoga/TextBuffer）、字符宽度光栅化、以及 Tree-sitter 语法高亮与 Conceal 掩码确实在原生层（Zig / Native Worker）执行；但 @opentui/core 的 MarkdownRenderable 在 JS 层本身有一套增量块切分器（parseMarkdownIncremental），只对流式尾部的活跃块做增量更新。本 PR 真正的问题在于：它在 OpenTUI 的增量管线之前硬插了一层全量同步的 JS 二次词法扫描与字符串重写，并解除了流式渲染门禁，直接破坏了原有的增量性能边界。一、 核心性能与架构缺陷分析1. 流式主线程的 $O(N^2)$ 阻塞陷阱（R19 只是掩盖了测试样本）对比 session/index.tsx 与 session-v2.tsx 的原始代码，基线分支原本通过 !streaming() 严格隔离了实验性富文本组件，流式阶段不挂载完整 MarkdownRenderable。本 PR 删除了 !streaming() 限制，使每个 SSE 增量帧都同步触发 prepareMath(content())。R19 的实测数据恰恰证明了阻塞有多严重：在 28KB 长回复下，prepareMath 导致可见推进 P95 从 108.4 ms 恶化至 318.6 ms，单次最大卡顿高达 2,823.7 ms（主线程假死近 3 秒）。R19 的短路条件在真实编程场景下几乎形同虚设：TypeScriptif (
  !source.includes("$") && !source.includes("\\(") && !source.includes("\\[") &&
  !source.includes("\\begin{") && !source.includes("]:")
)
R19 之所以跑出 107.25 ms 的回归绿灯，是因为它的测试长样本是不含任何 $ 的纯散文。在 opencode 这种代码 Agent 场景中，只要回复第一段出现一个 Shell 变量 $PATH、模板字符串 ${id}、正则 /foo$/、金额 $5、引用链接 [1]:，或者哪怕只有一个行内公式 $x$，该短路在整轮后续几百次流式分片中永久失效，瞬间退回以下三重同步开销：全量双遍 Marked 解析：每一帧都在 JS 主线程对整篇累积文本（最高 32,768 字符）从头跑一遍 marked.lexer(source)，拼回字符串后再交给 OpenTUI 跑第二遍 Marked；若含 blockquote 或 list_item，project() 还会剥离前缀递归调用 prepareMath，触发多遍重复分词。行内公式零缓存重算：math-markdown.ts:269 在分词期间同步执行 renderLatex(token.text)。前文早已闭合的几十个公式，在后续每收到一个流式 token 时都会被无差别重算一遍。未闭合 Mermaid 围栏逐帧跑完整图布局：Marked 会把流式末尾未闭合的 ```mermaid 识别为 code token，而 rich-markdown.ts:82 没有检查围栏是否已闭合，导致模型每吐出几个字符，主线程就同步调用一次 lovely-mermaid 的 render() 对半成品语法做完整有向图（DAG）布局计算。2. OpenTUI Patch 把函数引用当布尔开关，误伤全局普通引用与列表代码块session/index.tsx 和 session-v2.tsx 无条件向 MarkdownRenderable 传入了 renderNode={rich}（函数对象恒为 truthy），导致 patches/@opentui%2Fcore@0.4.3-smark.13.patch 中的两处判断改变了全局默认行为：所有普通 Blockquote 丢失原生样式并被迫走重量级递归（index.js:8362）：JavaScriptrenderable.add(this._renderNode ? new MarkdownRenderable(this.ctx, { ... })
  : this.createMarkdownCodeRenderable(..., "markup.quote", ...));
由于 this._renderNode 恒为真，原本轻量的 createMarkdownCodeRenderable(..., "markup.quote") 彻底沦为死代码。哪怕只是普通文字引用，也会实例化完整的嵌套 MarkdownRenderable（且在 session-v2 中未开启 internalBlockMode: "top-level"），同时丢失 "markup.quote" 专属引用前景色。列表内的所有普通代码块丧失原位流式更新（index.js:8515）：JavaScriptapplyListChildRenderable(renderable, token, previousToken, id) {
  if (token.type === "code" && this._renderNode)
    return previousToken?.raw === token.raw;
此处没有判断 token.lang 是否属于 mermaid | math | latex。当模型在编号列表（如 1. 修改配置：）下流式输出普通的 TypeScript / Python / Bash 代码块时，previousToken?.raw === token.raw 每帧都返回 false，迫使外层不断销毁并重建整个 CodeRenderable，直接打断 OpenTUI 原有的 runStreamingLoop() 增量 Tree-sitter 高亮。3. 行内公式的反斜杠硬转义与 conceal 动态开关冲突rich-markdown.ts:43 为了防止公式输出字符被二次解析为 Markdown 操作符，把几乎所有标点都硬加了反斜杠：TypeScriptif (token.type === "text") return token.text.replace(/([\\`*_{}[\]()#+\-.!|<>~&])/g, "\\$1")
随后依赖 OpenTUI 补丁里的 onHighlight 拦截 Tree-sitter 的 string.escape 高亮组来隐藏反斜杠。但在 session/index.tsx:2645 中，conceal={ctx.conceal()} 是用户可动态切换的状态。一旦用户关闭 conceal，或者在 Tree-sitter 异步高亮尚未结算的窗口期，终端会直接裸露 x \+ y \= \(a \* b\) 这种带满反斜杠的破损文本。4. sync-v2.tsx 的双倍全量序列化开销与状态机倒退漏洞为了解决开启 v2 流式渲染后暴露的 Hydrate 覆盖问题，sync-v2.tsx 的修法违背了低复杂度原则：主线程全量 JSON.stringify 浪费：每次 sync(sessionID) 在 await 前后对当前会话的所有消息执行两次 JSON.stringify(unwrap(message))。在真实编码会话中，Assistant 消息挂载的 Tool 输出（文件读取、Diff、终端日志）动辄数 MB，在 UI 线程反复全量序列化极不经济。未完成前缀反向覆盖服务端终态（sync-v2.tsx:52-58）：TypeScriptif (
  before.get(message.id) !== JSON.stringify(unwrap(message)) ||
  (message.type === "assistant" && !message.time.completed && ...)
) {
  messages.set(message.id, message)
}
若 sync() 发起后本地收到了一个 Delta（使第一个条件为 true），而服务端此时已完成整轮输出并在 HTTP 回包中返回了权威终态（saved.time.completed 已存在），本地未完成的半截前缀会强行覆盖服务端已完成的消息。如果这次 sync 恰恰是因为 SSE 闪断重连触发（后续不会再收到已错过的 Step.Ended），该消息将永久卡死在半截未完成状态。二、 接口影响、依赖卫生与 PR 范围审查审查维度现状评估具体问题点公开接口兼容性无破坏性修改（合格）数据库持久化仍存原始 Markdown；SDK 类型、HTTP 路由、插件接口均未改动。processor.ts 补发 9 行 SessionEvent.Text.Delta 位置准确、逻辑干净。第三方依赖卫生冗余且脆弱（不合格）1. 使用未导出的包内部深路径 @earendil-works/pi-tui/dist/latex.js，为单文件能力引入整套外部 TUI 框架。2. 仓库原本已有 marked@17.0.1，本 PR 新增 marked@18.0.7，pi-tui 又拉入 marked@18.0.11，导致 bun.lock 同时存在 3 个版本的 marked，且新增包源地址为空串 ""，与仓库原有的 npmmirror 源混杂。PR 收敛性与范围严重越界（不合格）。 混入与 TUI 渲染毫无关系的 external-directory.test.ts（宿主机 /tmp/.git 挂载修复）与 session-integration.test.ts（删除旧 tokenAccounting 断言）。3. 为凑注释率门禁在测试和适配器中堆砌了大量复述性双行注释。三、 第一性原则下的最小重构建议如果要在不阻塞 Zig/UI 渲染管线、不误伤现有 Markdown 路径、保持最小 Diff 的前提下正确合入此功能，建议按以下 4 点收敛重写：按块增量投影 + 仅对已闭合围栏做重型图渲染流式尾部隔离：按双换行或闭合围栏切分稳定前缀，历史已闭合段落的 prepareMath 结果与 renderLatex(formula) 结果用轻量 Map 缓存，流式每帧只对末尾最后一个活跃块分词，将流式总复杂度从 $O(N^2)$ 降回 $O(N)$。未闭合代码块直通：在 richMarkdown（或传入的流式上下文）中，对流式末尾尚未闭合的 mermaid / math / latex 围栏直接走 context.defaultRender() 显示源码，待围栏闭合后再执行一次 lovely-mermaid 布局。收窄 @opentui/core Patch 的拦截条件createBlockquoteRenderable 仅当 this._renderNode 存在且引用内容实际包含自定义代码块（如 mermaid/math/latex 围栏）时才降级为嵌套 MarkdownRenderable，其余普通引用保持 CodeRenderable("markup.quote") 快速路径。applyListChildRenderable 将拦截条件收紧为仅匹配自定义渲染语言（或检查当前节点是否并非原生 CodeRenderable），保留普通代码块的原位流式高亮。prepareMath 接收 conceal: boolean 参数（或仅转义真正会破坏行内结构的极少数定界符），在 conceal 关闭时不注入裸反斜杠。sync-v2.tsx 用单调版本号替代 JSON.stringify在事件订阅处维护 Map<messageID, number> 递增修订号，O(1) 判断请求期间是否有新事件到达。补齐终态单调性约束：只要服务端回包 saved?.type === "assistant" && Boolean(saved.time.completed) 为真，无条件采信服务端终态，禁止未完成前缀倒退覆盖。清理依赖与无关变更直接复用工作区现有的 marked@17.0.1（其 TokenizerExtension 接口与 18.x 完全兼容），并将 MIT 协议的纯文本 latex 转换逻辑像 math-markdown.ts 一样按署名单文件收敛进 util/，彻底移除 @earendil-works/pi-tui 及其传递依赖。剔除external-directory.test.ts 和 session-integration.test.ts，将渲染核心改动收敛在纯粹的 TUI 与事件同步边界内。


### 本次 Workflow 与最新路径更新原文

> 同时请注意一点，相应的Workflow也更新了。要按照新的Workflow，还有新的审计等等来走，请注意这点。

> 也就是把当前仓库全部都变到最新的，然后全部按照最新的路径以及文件来走。

需求编号：REQ-01 为 Mermaid/LaTeX 终端能力与最小修改；REQ-02 为真实完整应用及直接截图；REQ-03 为完整 PR 收敛、实际 A/B、正常 hook、单提交、持久化和不合并；REQ-04 为原生增量、普通 Markdown 兼容、水合和依赖清理的全文反馈；REQ-05 为停止指定外网审核测试、优先离线验收；REQ-06 为最新版 Workflow、审计与路径。


### 本轮目标和性能验收原话

> 6呢？6跑了吗？
>
> 按理来说6是不是也要去测一下是否有退化？
>
> 不对，应该rebase一下。
>
> Rebase完push自动它就会跑。
>
> 都对着`dev1-smark`

> 新的性能基准测试已经更新，你可以进行Rebase。

> 6，现在给我对基线，不要给我等，立马对基线，现在提交，我限你1分钟之内做完。

来源：同一任务的目标分支与性能验收对话；本轮目标分支前进，需求和验收范围保持。

### 允许走现有规模审批的用户原话

> 可以large

来源：`Sentinel_6d291ce916c48191863c26a1d08fe363`。

> 我再说一遍，我不允许拆成多个

来源：`Sentinel_1123bcee353c8191848f41303200a113`。

> 我已经说过了，你如果想要去调成大的，那你就 large

来源：`Sentinel_9815bce2f22481918d758cd93c29867e`。保留原 MIT 实现、单提交和现有规则；聊天授权与 GitHub 针对准确提交的审阅分别记录。

> 原推送钩子你本来就跑不通，创建临时预检分支没问题，因为它是preflight会自动删除。

来源：`Sentinel_4be94b1c36d4819197819311262caea6`。

> 而且你在本地，你本来推就推不通。

来源：`Sentinel_f954f411b9c48191a097dc861e6ee796`。

### 候选先推送、合入由用户决定

> 但是最终提交还没有呢呀，哪有Approve呀？你都没有去推上来，我怎么去Approve呀？你有病吗？对Latch你加Commit信息就可以了呀，哪有现行Guard的呀？你有毛病吗？你Push PR是没有任何影响的呀，只是PR的合入需要我Approve有什么毛病吗你？

来源：`Sentinel_6841f32147308191a07e385a76e8f264`。

> 干什么呀？6本来就是要去推到DEV1上面。

来源：`Sentinel_3c4ac7fb853c8191ba95e019baf9debd`。

本轮来源为同一交付会话中关于已发布 PR 的续办消息；最后一句明确覆盖 R22 的旧目标。最新需求映射为 REQ-01–06（上文）及 REQ-07（所有 PR 对齐 dev1-smark，要求正式性能退化验证）。

### 使用当前仓库 Workflow 的注释规则

> 你再看一眼现有指令呢，谁说过啊？我说过了让你按照 workflow 走，你看了 workflow 没。

来源：`Sentinel_c07848165aa48191baff735edbb91cc8`。

### LaTeX 文件首部的来源署名

> .....所以许可证不用保留，只保留署名链接即可。

来源：`Sentinel_932d385410d88191a70f014c025fc67d`。

> 不要去做无意义的什么跟MIT文件前，没有让你让你这样做操作，不得进行这种无意义的操作。

来源：`Sentinel_918ecdbd3d04819190e9dce575a7a30d`。

> MIT协议正文体本来就是一致的，只是署名有差异，那就在对应使用的文件前加一几两三行注释，写上署名，写上链接就好了。

来源：`Sentinel_7393c600b1b4819198da83180d94aa26`。

### 修改范围保持克制

> 任何这种操作都不要扩大用户的意图，我再说一遍，用户让你去做什么了，你就去调整什么，你的代码的修改、增量、减量本身都应当保持克制，没在用户要求的，或者说没有用户明说的地方，你都不要去调整。

来源：`Sentinel_7c0d1fc5238481918ef7b3a649e99929`。

## 2. Explicit Non-Goals

不改已有 Gate、计时器、预算、SDK、插件、数据库格式或接口；不加图片与新图形语言。不把 dev-smark 内嵌 TUI、实验开关、旧事件桥或旧水合实现搬入 dev1。完整应用截图是直接捕获的画面；性能采样和观察器留在仓库外。保留既有测试断言，不扩建测试套件。终态是可合并的现有 #6，不代为合并。

## 3. Repository Context

- 当前权威 `docs/guides/workflow.md` blob `3c66b0ff…`，模板 `.opencode/templates/canonical-plan.md`、planning skill `651a6b80…`、policy `22ada9cb…`，根 `AGENTS.md` `0de029d9…`，`CONTEXT.md` `ce94abc1…`。此功能在 `packages/tui` 和单个已有 OpenTUI 补丁内；根指令适用，目标无 packages/tui 或 patches 专属 AGENTS。当前 ADR 中没有将富文本渲染移出 TUI 的决策。
- dev1 App 同时挂 SyncProvider 和 DataProvider；core 已有 v2 文本事件发布。原 #6 `77f3aff…` 修改的是内嵌路由，两线的结构和责任已分开。现行 TUI 命令链和 npm 依赖归属均以 dev1 为准。
- `docs/adr/README.md`、`docs/agents/domain.md` 已通过精确基线读取；TUI 的消息展示继续消费既有消息/Part 数据。依赖改动只由富图实际绘制需要引入。
- 症状与反馈循环使用 diagnosing-bugs；测试 seam 使用 tdd。独立审计和批准实现材料留给各自阶段。

## 4. Files and Evidence Read

| 证据 | 核对结论 |
|---|---|
| `packages/tui/src/routes/session/index.tsx` `f9e71e90…`，TextPart／会话开页 | 当前 `streaming` 由 message.completed 派生；修剪后的全文先判定预算，再送原生 Markdown。开页滚动 timer 归 Session cleanup，富接线只触及另一处 TextPart。 |
| `packages/tui/src/util/text-budget.ts` `f51400a6…` | 32KiB/1000 行预算仅决定 renderer 类别，保持。 |
| `packages/tui/src/{app.tsx,context/sync.tsx,context/data.tsx,context/data-deltas.ts}` | 当前 App 挂载两提供者；data reducer 已追加 text delta；既有 sync/hydrate 必须保持。 |
| `packages/core/src/session/runner/publish-llm-event.ts:304–311` `b6d8f873…` | 已发布 v2 text delta，不需要旧 processor 桥。 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` `fad957e0…`＋包缓存原始字节 | 基线已包含完成态表格回读以及 renderer 退出清理，保留原 ScrollBox 等独立规则。旧基线 `ca34a93e…` 与旧候选 `138379bb…` 只用于三方求差。 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` `823ed32d…` | 新基线已有表格 inline/reference 两例。沿真实原生 setter `md.streaming=false` 后追加正文，断言链接、尾片与最后一个 block。保留原测试。 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | 已有 native renderer + 正式 Session fixture 与既有事件入口，可复用做最窄集成信号。 |
| exact #6 `77f3aff…` 的 R22 §39/§43/终审 | 旧线 40 个计划轮、生产身份、正反向严格补丁和真实屏幕证明可作为历史指引；不计为 dev1 的最终验收。 |
| 邻置 `probe-nested-token-positive.ts`、`evidence/nested-native-token-positive.{log,exit}` | parent 真 native lexer 的引用子 token 直接传给 child 原 `updateTopLevelBlocks`，交接两次对象身份相同，父更新6次、子 lexer 0次。46→100列在同一富节点恢复排版；再加不相关尾部，不调用额外富布局。普通引用/普通代码节点不变。SHA-256 `fa658daf976de1f7dc12341719b9158b34e365489dc1a8effa39eb8d97416669`、exit 0。探索副本而非产品验收。 |
| 邻置 `probe-nested.ts`、`evidence/nested-native-red.{log,exit}` | 现成 callback 只到 TOP-SOURCE，引用及列表闭合后仍为源码；普通列表 JS 更新后节点身份相同，exit 1。 |
| 邻置 `probe.ts`、`evidence/stock-native-red.{log,exit}` | 本轮实际不装依赖、仅 loopback renderer，已闭合 Mermaid 与公式仍是源码，尾标正确，exit 1（目标能力断言红）。 |

**6dd 基线复核：** 57a→6dd 共四提交／六路径。 `82063d8b` 加完成态尾表 append，`bd4e2f34` 收尾 renderer frame 和 session-open scroll，另两提交只改冷冻结和 Bash 既有测试。正式基线 [Guard](https://github.com/SMARK2022/opencode/actions/runs/45052333040) 已绿；依赖锁、TUI manifest、原性能与 Guard 没有在这四提交改动。打开同一包发布产物分别应用三份准确 patch，再从安装后的四个目标文件合成。最新基线的表格测试转到旧候选时 0/2；新基线、合成品各 2/2。合成品另开启富 lexer 重放同两例，仍 2/2；旧候选和合成品均通过既有富正文探针。

## 5. Current Behavior

历史 c621/57a 原生反馈：同一段 Markdown 经 TextPart 首先走预算，再进入 OpenTUI 正常块切分；常规块、引用、列表、普通围栏正常运行。实际复现的帧依次显示 `BASELINE_PREFIX`、未闭合 Mermaid 源、闭合后仍为 `graph TD / Alpha --> Beta`，以及 `BASELINE_TAIL`；`$x^2$` 与 `$20` 都保留原文。探针用的 native `index.js` SHA-256 为 `91e61520103383c0a1c896e8e800fcfed43495f2dc2b456c60e0907198bc2dc1`，renderer chunk 为 `dcfc16dafda2fe2a8fda61a4ca647dbe0a48b32e6a464794754c680c66f17668`，对 c621 原 patch 执行严格 reverse-check 通过。该信号测真实 renderer，不等同于完整应用或性能。

## 6. Supported Input Domain and Reachability

输入是现有终端助手文本 Part：普通 Markdown 与金额/Shell/正则/转义、受支持的行内和显示 LaTeX、数学围栏以及 Mermaid 围栏，包括引用和列表嵌套。用户正文未经产品源重写、以目标分支预算决定是否可解析。达不到预算时保留现存明文分支；未闭合块用现有 Markdown 文本/代码渲染直到证实闭合；不改主机/插件路径。缓存只服务当前原生节点及布局宽度，不保存到会话或对多用户共享。

## 7. Required Invariants

1. 活动尾部由 OpenTUI 原生 first unstable prefix 控制。累积 SSE 更新不用应用层全量 marked 或全文 stringify；稳定前缀原生节点、布局和普通路径保持。
2. Mermaid/数学围栏仅在实际闭合后调用重型排版；同一闭合 token 与宽度复用。过窄显示源码的既有行为不改变后续加宽的能力。
3. 数学 token 使用真实样式渲染，保持 conceal 动态及普通标点。未闭合、金额、Shell、普通 fenced/Treesitter 原语义不变。
4. 用户仍可达的实时与历史消息输入使用目标分支现有生命周期。保留最新的权威完成内容、已读分页和正文，除非用真实 dev1 测试证明有缺口；若有缺口先修订方案，不借 R22 旧缺口扩大范围。
5. 锁图保持现行依赖源与已有 OpenTUI patch；候选基线、CI 与本地运行分别绑定精确 SHA，用户保留合并决定。完成态最后一张表追加文本时，在原 lexer 重读该表；引用定义要求从更早位置解析时依原路径执行。保留基线的 renderer 和开页定时器释放。

## 8. First Divergence and Root Cause

真实 native red 显示流入正文、前缀、尾标和默认 parser 均有结果；首个语义分歧是目标 TextPart 对 native Markdown 只传普通选项，原生 lexer 不产生数学结构，Mermaid 闭合块仍走普通代码节点。当前已经有文本流 producer 和现成 UI consumer。历史旧实现的全量投影及水合竞态可用来设计对照，目标线上没有旧适配器可删。

## 9. Responsibility and Seam

- 保留 dev1 TUI TextPart 归属：既有文本预算、完成标志、颜色与 conceal。
- 原生 lexer 负责数学 token 和 first-unstable-prefix；原生块 render/update seam 负责普通分支及专用块。TUI util 负责专用公式/图布局和现有原生节点的注册，不做第二次解析。
- Core/HTTP/store 维持既有消息事件和水合权威；依赖属于使用图渲染的 TUI package；持久源保持 Markdown。

## 10. Single Approved Primary-Path Design

1. 在现有 TextPart 的预算内 fallback 分支将数学 lexer 注册以及闭合围栏 renderer 作为 native Markdown 选项；继续使用原 `content()`、`internalBlockMode="top-level"`、streaming、theme 与 conceal。原超预算 `<text>` 不进入富路径。
2. 原生 Markdown 增量 lexer 接受可选实例扩展并在同一首个不稳定前缀机制执行。普通调用继续使用原默认 lexer。解析输出由专用 token 节点承载，不拼回待再次解析的字符串；普通列表/引用/代码继续复用各自既有节点。历史定义或未闭合 delimiter 可能使稳定前缀退到更早的一块，这个边界由原生解析器决定，不从文本开头重扫。
3. 同一 native renderer 用专用 token 判定，在三个实际 owner 接线：
   - 顶层沿现有 `renderCustomNode`，仅封闭的 Mermaid/数学围栏或已闭合的 display math token 进入专用节点。
   - 列表 `createListChildRenderable` 初次建立时按同一专用判定派发。就地更新用现有 `applyListItemChildren` 的逐子项入口：普通 code→普通 code 原 `applyCodeBlockRenderable`；闭合之前保留同一 code，闭合时只换该子节点；已是富节点且 token 不变不重建，内容或宽度变化只更新该富节点。若编辑使 token 重新未闭合，单个子节点回到正常原文。
   - 引用保留现有外框、缩进及普通 `markup.quote` 节点；只有 native 已解析后代出现已闭合且受支持的专用块，内部才用同一扩展的 native Markdown 实例。不用全文字符串查找，不以存在 renderNode 判断。引用状态转换只替换内部正文，普通引用不创建额外 Markdown。内部原生实例仅消费父 lexer 已分词的 `blockquote.tokens` 并直接走现有 native 块状态 diff（`updateTopLevelBlocks` 对稳定块/变化块的现成更新）；不把 `blockquote.text` 写入子 renderer 的 `content`，也不触发子 lexer。前缀保持由父增量状态负责。native 扩展或主题样式更新传到同一渲染状态；后续 append 未改变 quote token 时既有走 identity/原文快路。函数输出走节点既有扩展，不经含转义的二次字符串。
   - 宽度更新归专用块已挂载节点：初始窄时仍显示源文，占位节点保有 token 和宽度；加宽后重排该块，依其实际内宽更新。子块无内容或有效列宽变化时沿用布局；不靠重挂会话/普通引用/列表触发回算。
4. 只用 TextPart 原有 32KiB / 1,000 行预算。行内与块级数学、Mermaid 不另设字符数阈值。已闭合并符合 lexer 语义的输入直接调用各自唯一引擎；正常返回无字形（LaTeX 返回 `undefined`；Mermaid 返回 `null`，或没有可见行）沿用原节点给用户看源文。行内公式得到多行时原样显示，保持现有行内布局合同。Mermaid 产出图并带 warnings 时显示图。删除两处不分类型的静默 catch，既有异常链继续归原生调用者，不编写第二引擎或成功兜底。
5. OpenTUI `createMarkdownLexer` 是原生模块内部 helper，只从原生 Markdown 实例调用；不作为模块导出，不写对外声明。现有 TUI 实际消费的 renderer/token 类型和 props 维持原接线。
6. 复用旧 #6 已验证的语法边界和可追溯 MIT 终端 LaTeX 实现；用旧 `lovely-mermaid@0.3.3` 已审图布局版本（仓外已用现存图包验证原生窄路径，正式候选仍按锁图做冻结安装）。不引入 Pi TUI、新版 marked 或重复 lexer。旧版 `latex.ts` 不是 KaTeX 依赖；锁图按 dev1 实情维护。不将旧补丁整个覆盖现有文件。

7. 保持同一 `latex.ts` 和同一解析器，按已有职责收敛其复杂度。命令词法、控制符／数学符号／参数命令、续行及各环境仍按原优先级匹配。沿现有语法族拆出小段处理：`renderLayout` 分开行内 token 定位、节点排版、整行拼接；`parseSequence` 保持游标、分组和终止条件，在同一 parser owner 内分开标记合并、关系符和矩阵尾标更新；`parseScripts` 与 `parseOperator` 继续顺序消费既有上下标并按显示模式合成；`parseCommand` 保持命令识别和语法族的原先后关系；`parseEnvironment` 保持探测结束标记、原行列读取和环境布局的原先后关系。现有递归路径是语法的一部分，不加限制，不创建第二解析器或备用路径。
8. 十个静态命令词汇表（命名算子、上下限、显示符号、关系、两类间距、字体、忽略、大小与包装）只做成员查询。改用冻结普通对象与 `Object.hasOwn`，保持原键集合、一次查表、避免继承属性参与判断；不引入模块状态、缓存或每次构造集合。图/数学围栏的语言判断与 `hasClosingFence(raw)` 分离，直接复用相同开尾标规则，不改变图和公式适用域、原生 owner、回调未命中或引擎正常无结果语义。
9. 以 6dd 已应用的 OpenTUI 为底，仅追加合成后相对该版本的三处原生文件差分。已完成尾表的基线回读条件仍在 `parseMarkdownIncremental` 重算 offset 和切 stableTokens 之前，条件、引用回读和退回一张表的原六行不改；同一函数照常走已注册的富 lexer。renderer 退出修复在原 chunk 的 renderer 区域，#6 的 chunk 差分仅触及 CodeRenderable 富字面量附近；`Session` 的开页滚动清理原样保留，富接线只入 TextPart。保持已有补丁字节为前缀，追加原包安装后验证的差分；严格正反应用对四个目标文件逐字比对。


## 11. Secondary and Replacement Path Inventory

| 路径 | 本次处理 |
|---|---|
| 实时与历史正文，旧实验 Session v2 UI | 6dd 正文页面 `useSync`，从 `message.part.delta/updated` 到同一 TextPart；DataProvider 的 v2 事件不是此页的第二份渲染入口。目标中不存在旧实验 Session v2 页面。验证现有实时/历史路径，不接第二份 renderer 或事件桥。 |
| 普通 Markdown、列表/引用和 code 渲染 | 保持既有 native 默认，含普通 Tree-sitter 高亮。 |
| 超预算正文、未闭合专用 fence、宽度不足 | 保留现有 plain text 或 native code 的展示分支；闭合/加宽后由同一块正常升级，不增加失败后备用实现。 |
| 最新 HTTP 完成态、SSE 前缀、已有合并/分页 | 保留生产 owner；实际触发缺口须单独附证据并改 Plan，当前不改。 |
| 私有 probe、官方 Bench driver | 仓外留证；Guard、时窗、阈值和 fixture 本次不改。 |

## 12. Workaround Deletion and Replacement

当前 6dd 无历史 R19 `prepareMath(content())`、旧字符串反斜杠投影和旧 `sync-v2` 全量 stringify；迁移明确不带这些 workaround。无需改变 dev1 既有正文 trim、预算或热路径。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
|---|---|---|---|
| REQ-01, REQ-04 / 开闭、稳定前缀 | TUI TextPart → native lexer/render → rich helpers | route props、现有 OpenTUI 补丁和专用 util | 先 Part 更新后 Message 完成的现有 Session 原红循序转绿；预算域内长例、稳定前块实例及计数；同一固定 SSE 的 Mermaid/LaTeX 帧和源持久性。 |
| REQ-02 / 真应用 | 实际 dev1 TUI 路由、终端 | 既有 Session 路由，不改 Guard | 直接终端截图，宽/窄、打开/闭合、完整尾标，真输入回显。 |
| REQ-03, REQ-07 / 原分支合并质量 | dev1 原 Guard + Test，exact synthetic SHA | 原流程与远端 PR，仓外专项 fixture | 普通长会话 TUI 正式 scroll、输入、首屏、全屏；供应者收到的富专项 SSE 另作真实成对实验；以全门禁实际完成为验收条件。 |
| REQ-04 / 普通内容、事件、权威终态 | 同 TextPart、native 默认与既有 Core/数据提供者 | 只改富 TextPart/options，Core 不变 | 普通 Markdown/list/quote/CJK，金额、Shell、普通代码和重连完成都走现有动作。 |
| REQ-05/06 / 环境授权、Workflow | 仓库现行流程 | 本 canonical Plan、原工作流不改 | 记录允许跳过的具体外网场景，不把跳过记作通过；保留本地授权替代和原 Gate。 |
| REQ-03/04 / 基线已修普通表格与生命周期 | native 尾表条件 → 原 offset／lexer；原 renderer 和 Session cleanup | 继承原 patch、原 Session 区域，两处不引入新概念 | 两个既有 inline/reference 尾表用例、既有 Session 正文测试、原 macOS Guard 的清理检查。 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
|---|---|---|---|
| 实例 math token 接入 | REQ-01/04 | stock native red | 普通 lexer 留源码且没有相应 extension 注册。 |
| 专用闭合块 renderer、布局缓存 | REQ-01/04 | stock 已闭合图仍显示源码，历史未闭合图逐帧重算反馈 | 普通 fenced code 不认识图；重型计算需要闭合后选择性处理。 |
| 终端公式/图实现和一项依赖 | REQ-01 | R22 已验证终端渲染、MIT 文件及固定图包 | 现有文本节点不能排数学与图。 |
| TextPart narrow props | REQ-01/04 | exact 6dd 路由 | 当前渲染未启用扩展；保持先预算，避免变化波及其他使用点。 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
|---|---|---|---:|
| `packages/tui/src/routes/session/index.tsx` | modify | 只在 TextPart 接入原生扩展；不接则业务路径仍显示源码。 | +6–12 |
| `packages/tui/src/util/rich-markdown.ts` | add | 选择闭合 fence 类型和实际宽度，路由使用这一张 renderer；围栏闭合判断单独成小函数，保留原选语言与命中规则；无来回改写 Markdown。 | +50–65 |
| `packages/tui/src/util/math-markdown.ts` | add | 既有专用数学 delimiter/上下文边界，普通文本和金额由 native 默认处理。 | ≤284 |
| `packages/tui/src/util/latex.ts` | add | 原 MIT 实现留同一文件和单一执行路径；只收敛 §10.7–8 列出的函数与十份词汇表，保持输出字节、识别域、游标次序和 Bun 列宽。现有三行 Mario Zechner 版权、固定链接和许可位置逐字不改。 | +1566 实际行（含来源） |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | modify | 仅 native lexer seam 和专用节点 update/resize，在现有补丁末尾追加相对已应用基线的差分；词法工厂保持私有。 | 离线合成 +807/-0，硬上界见 §19 |
| `packages/tui/package.json`、`bun.lock` | modify | 图包由实际 TUI lock owner 声明并锁定。 | +1 / +3–5 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 原 fixture 保持旧消息行断言及未闭合、金额、闭合成功断言。修改同一助手加载状态，让末次 Part 先于完成事件；完成后同一帧保留富内容。不复制 App 搭建，不新增测试实例。 | +12–40 |
| 本 canonical Plan | add | 保留完整合同和验证记录。 | 当前约 300 行 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why baseline fails | Minimal green behavior | Regression protected |
|---|---|---|---|---|
| 1 | 真实 Session fixture 给同一 TextPart 未闭合与最后片；已闭合图/公式须排版，前缀尾标仍有效。 | 实测原 native 未识别数学与语义 fence。 | 按真实生产时序先发送仍在输出的 Part，再在闭合后发 Message 完成；仅运行已批准的原生专用 lexer/render。 | 未闭合时原样、金额及正常尾标。 |
| 2 | 同一真实 native node 流式活动尾部、闭合、拉宽；前块身份稳定，嵌套普通节点复用。 | 基线没有专用块的闭合/撑宽行为。 | 专用块复用自己的稳定 token 和宽度，普通节点保留原样。 | 普通列表、引用、普通 Tree-sitter 代码与 conceal。 |
| 3 | 专项真实 SSE/PTY 测等量长富串，历史和实时从真正应用 route 入。 | 基线合法显示原文；候选有富语义且不得引入稳定推进退化。 | 以原 phase capture 记录首屏、尾标、逐帧间隔和 CPU。 | 官方普通长历史滚动、不掉输入、同字节持久。 |

复用现有测试和断言；仓外性能夹具复用同 73 片节奏。现有 Core `session/processor.ts:1007–1034,1071–1076,1122–1128` 先落 Part 再更新消息完成时间；`core/src/event.ts:379–430` 事件按序发布；TUI `context/sync.tsx:1595–1680` 同次水合先处理 Parts 后处理 Messages。R30 fixture 先创建已完成消息再发两次追加，复现的是原 native settled 分词的未闭合尾块保留行为。按同字节改用实际 Part→completion 次序，现有 Session fixture 仓外对照已转绿，原版全部逐字断言保留；本次不扩展 settled 分词、水合或测试套件。

在同一仓外原生对照增补输入覆盖：合法 4,103 字符公式输出 `x²`、20,657 字符图输出原盒线图；与它们同处现有总预算的普通 Markdown 继续走原路径。验证引擎正常的无结果和已有部分图输出契约，不新增产品测试实例。

现有精确 R32 LaTeX 输入/输出作为实施对照，不作为 57a 产品基线。随附独立仓外输入集固定 2,516 输入和 5,032 模式，覆盖命令表、转义、分组、矩阵、环境、横纵运算、混排宽度和无结果。通过条件是字节、换行、Bun 列宽、`undefined` 同步一致；另留 31,501 字符真实递归压力输入与 30,001 字符分组输入，确认结构拆分没有缩小预算内可达语法。实现后重跑原 stock commit-msg，从实际 57a 同 tree 索引得到 0 错误；不改 Gate、不提交 test 数据或探针。

## 17. Comments

按准确目标版的仓库《Workflow》Comment Rule 与配套 policy（“Comments have no quota.”）验收。生产中文注释写在确有说明价值的代码旁，交代原生分词复用边界、闭合后才布局、宽度变更沿用原节点这类不从代码直接看出的约束。删掉复述代码的注释，不设置注释占比。LaTeX 文件首部保留上游版权与固定来源链接，许可正文沿用未修改的根 `LICENSE`，并在源文件首部指向；许可正文不作为工程注释。原 Guard 代码和变更行数口径保持不变。

## 18. Verification

1. **实测起点**：6dd `latest-rich.log` SHA-256 `6452b11a193f0e163825fe892b0fb1b133c477a9331e95e6c371318af4596b4b`、exit 1；原生输出缺 inline/未知表达式/尾标。历史 c621/57a：使用相邻目录里仓外 `probe.ts`，运行 `unshare -Urn bash <same-loopback.sh> <bun1.4.4> probe.ts`；原生 `MarkdownRenderable` 帧日志 SHA-256 `32dfdea5d090360d7d07bd59787b6c81bb75397479fc31ba0db267753ebed18e`、exit `1`。同原 patch strict reverse check exit0；渲染布局依赖复用，非完全应用挂载。
2. **实现之后**：目标与候选在验证后的确切工作区，用目标锁定 Bun、同版本 native 平台和原 fixture 命令。先运行 `cd packages/tui && bun test test/cli/cmd/tui/session-message-render.test.tsx`，再用该包原 `bun run typecheck` 与相关 Gate 自动选择，不扩大外部测试权限。不靠候选自身证明 baseline correctness。
3. **真实应用和 A/B**：同一完整 OpenCode、120×36 或实际能通过原采帧屏宽，原 loopback SSE、相同设置/字节；以 AB/BA 交错同时测普通长输入、富长输入和纯文本对照。统计首次可见、稳定推进 P95、模型末片到最终可见、CLI PID CPU、完整字节及完成态。基线合法显示富源码，候选应显示图与公式，不用图形等价来过滤基线样本。静态历史滚动单独看官方 TUI 指标，不用 SSE P95 代替；至少保留官方每阶段原配对数，专项初始与现有 73 片等量对照沿用每场景两对，记录所有失败。若实测退化，定位第一个路径分歧并修订，保留现有 Guard 阈值。取保存原生截图而非回放字符串生成图像。
4. **私有实现与单提交**：独立方案通过才实施。独立实施审计认可准确差分且 §18.1–2 原本地验证通过后，核对最新 dev1 和产品树，运行原本地提交钩子，按 §19 留 stock trailer，形成一个 Large 提交。§18.3 能在本地真实环境完成的应用验证仍优先完成；依赖正式 head、托管运行器或当前缺失终端条件的验收在候选发布后的原步骤完成。分别记录实际命令与退出状态，本地钩子要求不变。
5. **原 preflight 与候选发布**：独立实现审计、本地测试和正常单提交完成后，如环境支持，先对准确候选走现有 `guard.yml` 的 `workflow_dispatch` preflight，使用 `base=6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`、原计划平台和用户授权的 stock `preflight/<head前12位>` 临时 ref。核对实际作业和 cleanup；不改钩子、工作流或基准。现有 #6 目标已经是 `dev1-smark`；只更新原来源分支，候选先发布再按平台现行规则审阅，不开新产品分支或新 PR。
6. **原线上验收及合入**：现有 #6 推送触发原 `pull_request.synchronize`。保留准确 head 与 6dd 的 Guard、冻结安装、macOS/Linux、普通 Test、Typecheck、正式 A/B，并继续完成 §18.3 的完整应用、直接截图和场景。原 Large 规则有效时按 §19 对准确 head 办理。准确 head 的 §18.3、正式 Guard/Test、空目录恢复及合入前资产核验都完成才称可合并；不代为合并。
7. **基线新增行为的窄验证**：先用 Bun 1.4.4 在 exact 6dd 与候选各执行 `packages/opencode` 下 `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts -t 'keeps late text'`，再跑 §18.2 的原 Session 路由。原 macOS Guard 核实际 renderer 清理和会话滚动结果。仓外重放的固定摘要：表格旧候选 0/2 (`186db595…`)，6dd 2/2 (`45196a2a…`)，合成 2/2 (`a4039af8…`)，富 lexer 开启亦 2/2 (`d47d05cd…`)；29,013 字符 native 富输出七检查旧候选与合成均通过，日志字节相同 (`46c63195…`)。这些是局部证据，不替代最新工作树、冻结安装或正式平台。

## 19. Diff Budget

计划涉及至多六个功能路径（路由、最多三份专用 util、现有依赖声明及 patch）加锁、现有测试与 Plan；保持零新配置、模型、timer、core API 或跨包职责。单一 MIT 文件在旧分支为约1,535物理行，须逐字保留来源并单列 vendor 与 dev1 业务接线的实际行数；既有 R22 接受不自动覆盖这次新分支预算。富 lexer/原生 patch 的差分不超过旧 exact patch 的 956 行加删总和，目标应明显低于该上限，去掉目前 dev1 已覆盖及不触达渲染的 hunk；实际边界按 §8/10 逐 hunk 证明，禁止整文件覆盖。实施变动超出精确预算或有未经审计的新包接口须停并改 Plan。实做后分别记录生产/总路径、有效 Delta、真实 C、纯移动/来源字节和测试实例数。完成时只一提交。

Guard 的单提交源码净增上限为 300。MIT 实现文件保留完整的语法覆盖及可核对来源，仍在 Guard 统计里，不能扣除它、更名避开计数或拆提交。按用户明确确认选择原 MIT 实现，保留本地 commit-msg 的原流程，在正常提交信息写 `Guard-Allow-Large: 保留既有 LaTeX 公式谱系的可追溯 MIT 实现；配套代码同一原生渲染入口`。远端 PR CLI 强制 `--no-trailer`；必须由非 PR 作者、符合仓库实际 `OWNER/MEMBER` 条件的维护者对当前准确 head 提交 GitHub APPROVED 审阅，然后由维护者重跑原规则作业。工作流核对该审阅者最新非 COMMENTED 状态、head SHA 顺序与角色后才传 `--allow-large`；再次更新 head 须重新审批，总门禁原样执行。不接受聊天文字、GitHub 自我批准或单独一次 preflight 替代。

## 20. Real Risks and Open Decisions

- **已知风险**：两分支原生依赖版本标签相同但补丁差很大。必须 strict apply/strict reverse 并核原 package、原 patch base 与候选 installed native 指纹。仓外合成已经使用现有图包并转绿；正式候选冻结安装仍待验证，不能拿 renderer mock 充当候选。
- **待完成验收**：确认目标 actual Test 中从 producer 至消费者的路线、最新候选本地锁图的供应以及正式 Gate。富 A/B 对照场景和同标记必须在准备时冻结，旧分支数值仅用于告警。
- **Rejected speculation**：看到 v2 producer 即假设有旧实验 UI；用过预算禁用用户富流，或新增下游 state machine/全部重新分词；将见到 host 性能差无证据归为噪音。设计不引入这些变化。
- **Open Decisions Requiring the User**：方案与私有实现现已无范围选择待问。用户确认现有 #6、一个提交以及允许 large，保留署名 MIT 源与完整语法，不引入 Pi，不拆、不改 Gate。
- **线上机械阻断**：只有准确 head 的 GitHub OWNER/MEMBER 审阅能解锁原 PR 检查。个人仓由 `SMARK2022` 拥有，同一人创建了现有 #6，作者自审不成立，常规协作者也不满足 stock 角色。当前未核实有实际可提交合格评审的账号/资格；root 正独立核实。不得将未获审批写成通过。只保留现有 PR 和 stock preflight 自动清理的临时 ref。独立评审对象是已发布的 exact head；私有实现、真实环境验证和单提交可在独立 Plan 批准后先完成，最终可合并状态保持开放。
- **引擎候选证据**：相邻 `evidence/standalone-engine-alternatives.md` 记录已核查的发布/能力边界与实际对照。现成替代仍无通过矩阵且符合用户依赖和普通 300 行 Gate 的证据。可行的长期选项是先取得或另获授权发布独立 MIT 公式库，再用实际候选证实数值；不把该未来动作写为本 PR 已可执行的依赖。
- **Follow-up**：原 #6 旧线包及历史作只读证据；保留只影响旧线的关闭外网用例记录。

现行二进制发布物单独记录：源码压缩包含根 `LICENSE`；基线 `.github/workflows/build-opencode.yml:150,227,356` 的发布压缩包和裸 Windows 二进制，以及 `packages/opencode/script/build.ts:439–465` 的本地打包路径，均未将该文件放进二进制资产。R30 核验源码首部的上游版权及链接，并核对随源码归档的原根许可证正文；发布独立二进制须随附版权和许可正文。具体二进制打包接线需确认发布范围后另行审计，本 PR 保持原构建工作流。

## 21. Audit Contract

全文按 6dd9a5b→目标审查。审计输入为此 Plan、完整 §1、immutable GitHub 快照与旁证；后续实现审计看完整实际差分、实际路径、red/green、真实 A/B 及仓库 Comment Rule 核对结果。没有 No blocking findings + APPROVE 的 exact revision 不实施。候选发布前复查最新分支和原 Guard，不合并。

## 22. Revision Delta and Plan Audit Record

R34 对齐 6dd。基线和候选同时进入同一原生增量 lexer，需验证结构合成，不能沿用 R33 裁决放行。只调整原生补丁和会话文件的基线组合；锁、图依赖、LaTeX、富工具及既有测试的产品差分保持。下列 R29–R33 裁决和实现回执保留原文，按各自快照解释。

R23 将 R22 的旧目标换为 dev1，并建立原生顶层真红；该版本独立审计结论为 BLOCK。完整原裁决原样保存在邻置 `evidence/R23-independent-verdict.md`。R24 明确列表、引用与闭合/内宽更新路径并加入原生红灯。R25 补充原生窄试验与用户允许大变更的逐字授权；末次 R25 试验中的引用字符串二次词法只保留为历史。R26 改为从父 lexer 向子渲染 owner 直接传递同一 token，再用真实 native 试验验证零额外词法、无关 append 不重排和普通节点原位；最新基线复查仍为 c621。R25 独立结论为 BLOCK，逐字原裁决见相邻 `evidence/R25-independent-verdict.md`；R27 记录两条最新用户原话，明确采用 stock large 的本地单提交路径；独立审计按可实施、可验证的私有阶段先审，最终发布门禁原样保持开放。R28 纳入两条最新原话，准许 stock preflight 临时 ref，分开记录本地命令和原工作流验收，按发布 exact head、独立审批、原 Gate 的实际执行顺序验证。产品设计、职责及已冻结的验证路径不变。

R28 原精确快照与已有审计保留，不用作 R29 通过凭据。R29 以原目标最新 57a 比较，记录用户确认候选先发布、审阅和合入在后；更新现有 #6 的目标和原来源 head 是待完成步骤。本轮重新独立送审，实施尚不放行。

### R29 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

原 B-02 改列为发布后的线上验收事项。R29 §1 的两条用户原话明确了交付顺序：先把正常单提交候选推到现有 #6，目标设为 `dev1-smark`；用户看到准确 head 后再审阅并决定合入。候选发布有可执行路径，无需等 GitHub 审阅后才实施或上传。

原 large 规则仍有效。当前 #6 由个人仓所有者 `SMARK2022` 创建，唯一既有审阅为 `COMMENTED/NONE`。本地 `Guard-Allow-Large` 可用于原提交钩子；线上 Guard 仍按 `guard.yml:145–163,363–387` 核对当前 head 的合格审阅并要求规则作业通过。正式结果未绿时，交付候选链接，保留可合并状态待定。

## Follow-up

实现后核对真实 OpenCode 终端截图、普通与富流配对性能、原 Gate/Test、空目录重放及单提交。用现有 #6 的准确 head 和实际基线记录线上回执。若运行获准的 stock preflight，核对实际作业和临时 ref 清理结果。

## Rejected speculation

不为旧水合问题扩大到 Core，不新增第二遍分词、备用渲染或生产计时器。聊天中的 large 授权、临时 preflight 和准确 head 的正式 GitHub 审阅各按原规则记录。

## Requirement and traceability coverage

复核了完整 §1、原生正反向回执、原 Guard 及当前 GitHub refs。`dev1-smark` 的实测 head 为 `57a50ae146f8265e6fbbb348cddcfa3d3f3d6c56`。从 `c6217876…` 到该点改变的 12 路径均不与 §15 的目标文件、锁、OpenTUI 补丁或 Gate 重叠。既有原生窄实验继续证明同字节组件边界，完整应用和 A/B 按新基线重跑。原 B-01、B-03 保持关闭。

## Primary-path and fallback verdict

现有 TextPart 接入 OpenTUI 原生增量 lexer；富引用消费父级已解析 token；专用块闭合后才布局。普通内容、未闭合围栏和过窄块沿用现有显示契约。发布先于审阅，正式 Gate 完整保留。

## Release verdict

**APPROVE。** 批准精确 **R29 方案**，SHA-256 `8c1c770faa8e29d2e1fea4c4894b6ecc62624f9d75c3564b29f9ac7b4084fef0`。登记本轮裁决后可实施；实际差分须另经独立实现审计。只有准确候选的正式验收通过后才可称可合并，由用户决定合入。


R30 按 §1 最新用户原话采用准确仓库 Workflow 的 Comment Rule，§17 删除数字配额；按最新原话缩短 LaTeX 文件首部，在原 LaTeX 文件内保留版权与固定链接，根许可证不改。完整功能范围、运行验证、单提交 Large、原 Guard 计数和授权顺序不变。R29 原批准方案和裁决已冻结。既有 R29 实施和验证材料保留为候选证据；R30 独立通过前不放行新实现。

### R30 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

R30 把 `latex.ts` 文件头缩到两三行，保留 Mario Zechner 的版权、固定上游源码链接和根 `LICENSE` 的位置。已对照 [上游许可证](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/LICENSE) 和 [57a 根许可证](https://github.com/SMARK2022/opencode/blob/57a50ae146f8265e6fbbb348cddcfa3d3f3d6c56/LICENSE)：两份许可正文一致，版权署名不同。候选源码及其源码恢复包须同时保留文件头和根许可证，满足 [MIT 许可](https://opensource.org/license/mit) 的保留条件，无需在文件头重抄正文。

§1 漏录 `Sentinel_7c0d1fc5238481918ef7b3a649e99929` 的逐字原话。我从会话核对了原文；§2、§15 和 §22 已覆盖这条消息重申的范围约束。补录原文及来源即可，设计和批准范围保持原样。

## Follow-up

**合入前核对二进制许可。** 原工作流在 `dev1-smark` 收到命中 `packages/tui/**` 或 `bun.lock` 的推送时会自动打包并上传发布资产。现有 macOS、Linux 和 Windows 二进制打包路径缺少 R30 规定的上游版权与许可随附。候选推送到现有 #6 不触发这条发布链；用户合入前须验证实际发布资产已随附。需要改打包时，另行确认范围并审计。

实际差分仍须独立审计，并核验公式正文除既有列宽适配外保持不变、源码归档含根许可证、完整应用截图、配对性能、原 Gate/Test 和单提交。

## Rejected speculation

不添加重复 MIT 正文、注释比例、打包改造或新功能。原 large 线上验收条件保持原样。

## Requirement and traceability coverage

核对了最新用户原话、精确 57a 基线、R29→R30 差异、原生正反回执和实际发布触发条件。R30 仅调整既有 LaTeX 来源文件头和注释验收口径。仓库 Comment Rule 要求中文注释解释代码看不出的原因，不设配额。R29 已审的产品路径及验收继续适用。

## Primary-path and fallback verdict

OpenTUI 原生增量解析、父级 token 交接和闭合后布局保持同一路径。R30 只改来源标注和工程注释口径，没有增加解析、渲染或发布替代路径。

## Release verdict

**APPROVE。** 批准精确 **R30 方案**，SHA-256 `4e581fef9b05f27c29d473291cfb5a8f6c24400979372796b1fda53dbbb43574`。登记裁决后可实施，实际差分须另经独立实现审计。候选可按原顺序发布到现有 #6；正式可合并状态仍取决于原 Gate/Test 和合入前的发布资产许可核验。

### R30 独立实现审计原文

## Blocking findings

### B-01 正式 Session 路径的富文本断言仍然红

- **Violated invariant:** REQ-01、REQ-02、REQ-04；§7.2–4、§16–18。
- **Evidence class:** observed。
- **Producer and execution path:** `message.part.updated` → 现有 Session/TextPart → OpenTUI → 用户终端帧。
- **Source evidence:** `session-message-render.test.tsx:287–303`；两文件测试回执 `r30/stock-session.ns1cW4/{command,stdout,exit}`。
- **Canonical-plan evidence:** §16 要求基线红、实际候选绿；§23 仍列正式 Session、完整应用截图和配对 A/B 待验。
- **Responsibility owner:** 实际 Session 提供的渲染入口及其依赖解析。
- **Concrete behavioral consequence:** 两文件回执为 44 通过、1 失败，退出 1。实际帧收到 `RICH_SESSION_END`，图仍显示 `A[Start] --> B[End]`，公式仍显示 `$x^2$`。这份回执没有冻结运行时 native 依赖身份，可作红灯，不能证明实际候选绿。直接构造 `MarkdownRenderable` 的 14/14 图库不能替代真实 Session 回执。
- **Pre-R1 baseline behavior on the same path:** 57a 保留图与公式原文。
- **Minimal correction direction:** 在同一 Session 测试中绑定实际候选 native 与冻结依赖，定位收到正文后仍未排版的第一处分歧。原断言保持，修正后复跑并完成真实终端截图与配对 A/B。

### B-02 新增块级长度限制会漏掉可排版的公式

- **Violated invariant:** REQ-01、REQ-04；§6、§9、§10.1–3、§11。
- **Evidence class:** observed。
- **Producer and execution path:** 预算内助手正文 → 已闭合 `latex` 围栏 → `richMarkdown.handlesCode` → 源码显示。
- **Source evidence:** `text-budget.ts:4–12`；`rich-markdown.ts:8–23,60–62`。直接用实际候选验证：4,103 字符公式、4,116 字符完整正文，原 Part 预算接受，`renderLatex` 得到 `x²`，`handlesCode` 返回 `false`。
- **Canonical-plan evidence:** 原预算决定富文本资格；计划保留未闭合和过窄边界。实际差分另设 4,096 字符公式围栏和 20,000 字符 Mermaid 围栏上限。§10.4 复用旧语法边界，未批准把旧分支的长度阈值移入新基线。
- **Responsibility owner:** TextPart 的既有内容预算与富块的闭合判定。
- **Concrete behavioral consequence:** 用户能在原预算内收到合法、引擎能排版的公式，候选却直接显示源码，加宽也不会升级。
- **Pre-R1 baseline behavior on the same path:** 57a 只用 Part 预算决定是否挂 Markdown；本次承诺补上的富渲染在这条输入上仍缺失。
- **Minimal correction direction:** 将围栏资格收回到已批准的预算及实际闭合判定。若需要额外限制，用实际运行证据修订 Plan 后再审。

### B-03 排版异常被静默转换为默认代码显示

- **Violated invariant:** §11 明定不新增失败后备用实现；原 Workflow 禁止 `catch-and-success`。
- **Evidence class:** contracted。
- **Producer and execution path:** 已被接受的闭合富块 → `render` 或 `renderLatex` → `catch {}` → `context.defaultRender()`。行内公式有同类路径。
- **Source evidence:** `rich-markdown.ts:27–36`；`math-markdown.ts:263–279`。
- **Canonical-plan evidence:** §10–11 明确的源码显示分支是未闭合、过窄与原预算外；§23 也未登记排版失败后的出路。
- **Responsibility owner:** 富文本排版入口。
- **Concrete behavioral consequence:** 排版器抛错和正常未命中产生相同默认显示，调用方无法分辨已接受富块的排版失败。
- **Pre-R1 baseline behavior on the same path:** 57a 直接显示普通代码，没有途经富排版器的失败路径。
- **Minimal correction direction:** 保持原生直通用于预先判明不适用的输入；去掉静默异常转成功。需要保留源码的失败行为时，按 Workflow 把可见失败结果写入 Plan 并验证。

### B-04 补丁公开了产品没有消费的 lexer API

- **Violated invariant:** §2、§10、§14–15；本次只为现有 TextPart 接入实例级扩展。
- **Evidence class:** reachable。
- **Producer and execution path:** OpenTUI bundle 的公开 export 和声明文件 → 外部消费者可调用 `createMarkdownLexer`。
- **Source evidence:** `patches/@opentui%2Fcore@0.4.3-smark.13.patch:26,200,225,717,909`。在准确候选树中搜索，两个生产调用均为 `MarkdownRenderable` 自身构造与 setter；无仓库消费者需要公开函数。
- **Canonical-plan evidence:** §10.2 批准原生实例扩展；§14–15 没有独立 lexer API 的需求或使用者。
- **Responsibility owner:** OpenTUI 补丁的模块导出。
- **Concrete behavioral consequence:** 增加一条可由调用方绕开原生块状态直接调用的永久接口；现有路线不依赖它。
- **Pre-R1 baseline behavior on the same path:** 57a 不导出该函数。
- **Minimal correction direction:** 保留内部 helper，去掉公开 export 和对应声明。

## Non-blocking findings

LaTeX 文件头符合 R30 的三行署名方案，根 `LICENSE` 未变，公式实现正文与 R29 字节一致。保留有效中文说明；新增注释里的审计历史标签 `（B-01）` 可删。原 `git diff --check` 无错误。

## Follow-up

完成候选原锁冻结安装、Session 绿灯、完整应用真实屏幕、配对 A/B 和正式 Gate。之前看到的 `screenshot-uk.png` 是历史 Desktop 设置截图，不属于候选。合入前另按 R30 核对自动发布的二进制许可随附。

## Rejected speculation

未把图包 Git tag 源码运行等同于发布 tarball 安装，未把等宽原生帧等同于完整应用性能。没有为了这次渲染要求改 Core、Gate 或计时器的依据。

## Requirement and traceability coverage

核对了完整 §1、R30 原批准范围、57a 基线、实际九路径和恢复包。候选为 `+3187/-51`，含 448 行 Plan；空索引回放树与候选树相同。现有路由、父级已解析 token 交接、普通原生节点、依赖归属和许可文件头均有可追溯证据，正式行为缺口见 B-01–B-04。

## Primary-path and fallback verdict

父级 token 复用和原生块更新方向符合批准设计。围栏限制和静默失败分支改变了该主路径的交付结果，正式 Session 入路尚待绿灯。

## Code quality verdict

路径清单与计划一致，格式检查通过。公开无消费者的 lexer、额外围栏阈值和静默失败不通过本轮代码质量门禁。

## Release verdict

**BLOCK**。适用于候选树 `dd098f2425d3f6b5e6be51a7bac73ba6b1256fa3`、实际差分 SHA-256 `69d5e18948a8944201a00b5ca9ec7a7f80f2969357942856b4f42bad6b4dab80`。

### R30 独立实现审计补充原文

# R30 实现审计补充说明

与原裁决分开记录。R30 收到的两文件回执中，测试先把 assistant 消息构造为已完成，然后再为同一消息追加正文。已确认常规生产先发布最后文本、再发布完成事件。等按严格真实顺序运行隔离测试，核对实际候选的富文本帧；现有 fixture 的构造顺序不作为常规生产缺口的证据。原裁决和哈希保持不变。

R31 保持完整 57a→目标比较。收回局部容量上限、静默 catch 与内部 helper 导出；既有 Session 用例按生产的 Part→completion 次序验证，同一用户需求、范围、最新基线、单提交和发布合同不变。R30 实际九路径差分与完整 44 通过／1 失败回执继续保留，不能替代 R31 的独立审计或验收。

### R31 独立方案初审原文

## Blocking findings

### B-03 删除局部 `catch` 后，原生解析仍会吞掉异常并替换整条正文

- **Violated invariant:** §7.1、§10.2、§11。稳定前缀应保留，单个公式的排版异常应与正常无字形结果区分。
- **Evidence class:** observed。用候选原生组件注入受控异常，验证了计划选择的异常路径；未把该异常说成真实引擎的常规输出。
- **Producer and execution path:** 行内公式的排版异常 → 原生 tokenizer → `parseMarkdownIncremental` → `updateBlocks`。
- **Source evidence:** 候选 OpenTUI `index.js:7994–8005,8057–8063,9487–9505`。在三个已有普通块后追加一个公式，受控异常使 tokenizer 调用两次，三个原有节点全部被单个 `local-owner-fallback` 节点替换，用户帧没有局部失败提示。
- **Canonical-plan evidence:** §10.4 删除两处静默 `catch` 后，把异常交回原生调用者；§11 未登记该出路。受控实验显示，原生调用者会先重扫整条正文，再把异常转成整条源码显示。
- **Responsibility owner:** 富文本扩展与原生 Markdown 的异常交接点。
- **Concrete behavioral consequence:** 单个公式的异常能触发全 Part 重分词并清空已稳定的节点；原生层仍把异常呈现为普通显示。
- **Pre-R1 baseline behavior on the same path:** 57a 没有行内排版调用。既有 tokenizer 的异常处理会显示整条源码；R31 把富引擎异常接入这条路径。
- **Round basis:** unresolved prior B-03；R31 把原来的局部静默失败移交给会整段回退的原生路径。
- **Minimal correction direction:** 保留 `undefined`、`null` 等正常无字形结果的现有显示；给异常确认一个可见的局部失败契约，并用窄回执证明普通前缀不重算、不销毁。

## Non-blocking findings

R30 的 Session 红灯已定位到 fixture 时序。用同一 R30 产品源码改为真实 Part→completion 顺序，原 Session 单例 1 通过、0 失败、12 次断言。可以按 R31 修改该既有测试，原断言和测试实例数保持。

R31 的方案已处理 B-02 和 B-04：统一使用现有 32 KiB／1,000 行预算，把 lexer helper 留在原生模块内部。已读引擎回执，4,103 字符的公式和 20,657 字符的 Mermaid 都正常产生字形。实际删除仍须用候选差分核对。

## Follow-up

修订后保留精确冻结安装、完整 Session 验证、真实应用截图、新基线配对 A/B、原 Guard/Test 和独立实现审计。

## Rejected speculation

不把“先完成再追加”的构造用例当作常规生产缺陷。不改既有预算、Gate、Core 事件次序或全局 settled 解析。

## Requirement and traceability coverage

复核了完整 §1、R30 实际差分及裁决、有序 Session 原回执、两套引擎返回契约和 57a 的目标路径。R31 收窄了原方案范围。仍须修正的是异常交接，正常消息、正常无字形结果及原生增量路径均已定位。

## Primary-path and fallback verdict

现有 TextPart、原生增量解析和已闭合块布局保持同一路径。正常无字形结果可留在原显示契约内；异常进入原生整段回退仍违反稳定前缀和可见失败要求。

## Release verdict

**BLOCK**。适用于精确 **R31 方案**，SHA-256 `cc521311d498732a90fd2d451cae675b264786b4b6cc2d7fdeeda321d788aed6`。

### R31 独立方案复议原文

## Blocking findings

No blocking findings.

## Non-blocking findings

复议撤回 B-03 的阻断判定。受控异常证实了原生 Markdown 会重扫并显示整条源码；57a 已有这条异常路径。固定版 LaTeX 和 Mermaid 的实际回执只观察到正常排版、带警告的图和 `undefined`／`null`。受控注入验证了下游反应，未建立真实引擎异常的生产入口。按现行 policy，本轮不为此新增异常提示或改全局解析。

## Follow-up

若实际候选出现引擎异常，保留原始输入、首次失败点和终端帧，再判断是否要修。当前实作继续完成精确冻结安装、Session 绿灯、完整应用真实截图、配对 A/B 和原 Gate。

## Rejected speculation

不以人工抛异常代替真实引擎回执，不把“先完成再追加”的测试顺序当作常规生产缺陷。

## Requirement and traceability coverage

R31 保留原 Part 预算，移除重复的长度上限和无消费者的 lexer 导出。有序 Session 单例验证先发布 Part、再发布完成事件，实测 1 通过、0 失败、12 次断言。它验证了计划阶段接线；正式候选仍须重跑原测试。B-01、B-02、B-04 保持计划阶段关闭。

## Primary-path and fallback verdict

计划保留现有 TextPart、原生增量解析和闭合后布局。排版器正常返回无字形时保留原内容，不尝试第二个引擎，不新增静默成功分支。

## Release verdict

**APPROVE。** 批准精确 **R31 方案**，SHA-256 `cc521311d498732a90fd2d451cae675b264786b4b6cc2d7fdeeda321d788aed6`。登记复议裁决后可实施；实际差分须另经独立实现审计。

R32 只纠正候选发布与最终验收的先后关系。用户在 §1 明确指出，先给现有 #6 的准确候选，再对它审阅并决定合入。R31 所有代码/测试、正式性能与直接截图验收不变；原 Guard 规则不变。发布候选和宣布可合并分别记录。

### R32 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

R32 调整验收顺序。§18.4 保留独立实现审计、本地 Session 与类型检查、原提交钩子和一个 Large 提交；发布到现有 #6 后，再补齐当前环境缺少的真实终端截图、完整应用配对 A/B 和冻结安装。R31 的实现阻断记录继续保留，截图和完整应用性能仍待验。

## Follow-up

对实际差分单独做实现审计。候选发布后，在准确 head 上记录 §18.3 的原场景与指标、直接屏幕截图、冻结安装和原 Guard/Test。合入前核验发布资产随附许可证；合入由用户决定。

## Rejected speculation

不把 Session 帧当作实机截图，不把官方 Git tag 源码投影当作冻结安装，也不修改 Gate、性能阈值或验收样本。

## Requirement and traceability coverage

核对了完整 §1、R31→R32 的差异和实时 GitHub refs。目标仍为 `dev1-smark@57a50ae146f8265e6fbbb348cddcfa3d3f3d6c56`；现有 #6 仍在来源分支 `feat/terminal-mermaid-latex`，head 为 `77f3aff…`，目标待更新。R32 保留原产品范围及全部合入条件，按用户原话先上传候选，再针对实际 head 审阅。

## Primary-path and fallback verdict

TextPart、原生增量解析、父 token 交接和闭合后排版保持原样。发布到现有 #6 和最终可合并验收分别记录，原正式门禁完整保留。

## Release verdict

**APPROVE。** 批准精确 **R32 方案**，SHA-256 `a5e66e9e9b5250d04b9b3b8607750cc867c0f65eb7ac0d3632691b751255a5b6`。登记裁决后，实际差分仍须另经独立实现审计。

R33 记录正常 stock commit-msg 实际挡住 R32 的规则，Large trailer 只放行规模。基于原始用户要求继续用 MIT 来源的单文件实现；必要修改仅限现有 LaTeX 语法结构、静态表和现有富围栏判断。实际服务接口、输出、增量、前缀与发布顺序不变。

### R32 独立实现审计原文

## Blocking findings

### B-01 原提交钩子拒绝了准确候选

- **Violated invariant:** REQ-03、REQ-06；§18.4 要求用原钩子形成一个 Large 提交。
- **Evidence class:** observed。
- **Producer and execution path:** 基线树 `95ab31d…`、候选暂存树 `960b72a…` → 原 `.husky/commit-msg` → `gate.ts commit` → 原规则检查。
- **Source evidence:** `r32/commit-msg.{command,log,exit}`。原钩子接收了 `Guard-Allow-Large`，随后以 4 个错误退出 1：`latex.ts:741` 命中 `cc-excess` 和 `depth-excess`，`latex.ts:234` 命中 `module-state`，`rich-markdown.ts:8` 命中 `cc-excess`。
- **Canonical-plan evidence:** §18.4 保留原本地钩子；§19 的 trailer 只放行规模；§15 同时规定公式实现正文原样复用。
- **Responsibility owner:** 公式引擎移植与富块识别代码。
- **Concrete behavioral consequence:** 现有候选无法按批准路径形成单提交。这项检查不在 R32 允许发布后完成的验收范围内。
- **Pre-R1 baseline behavior on the same path:** 57a 没有这两个新增源码文件；原规则保持不变。
- **Round basis:** 本轮新增的准确候选实测，触发强制代码质量门禁。
- **Minimal correction direction:** 用同一 Plan 审计最小的行为等价调整，保持署名、公式输出、单提交和原 Gate。用原钩子复验准确暂存树。

## Non-blocking findings

R31→R32 只有 Plan 改动。原两个 Session 文件仍为 45 通过、0 失败、772 次断言；TUI 类型检查和原生大样本探针通过。

## Follow-up

按 R32 在准确候选发布后补齐真实终端截图、完整应用配对 A/B、冻结安装和正式 Guard/Test。合入前核验发布资产附带许可证。

## Rejected speculation

Large trailer 的规模放行已实测成功。四个错误来自其余原规则，无需修改 Gate、阈值或基线来核实。

## Requirement and traceability coverage

核对了完整 §1、R32 原批准方案、九条实际变更、原钩子退出状态及空索引回放。实际差分 `+3429/-52`，含 696 行 Plan；工作树文件与候选 blob 一致，回放树相同，`git diff --check` 通过。

## Primary-path and fallback verdict

原生增量解析、父 token 交接、闭合后排版保持 R31 已核验的路径。当前阻断在正常单提交检查。

## Code quality verdict

原钩子的 `cc-excess`、`depth-excess` 和 `module-state` 未通过。大小例外已生效，四项错误仍须处理。

## Release verdict

**BLOCK**。适用于候选树 `960b72af42cc765bb6646ab8238bd8fcdb9d3994`、实际差分 SHA-256 `c77fe3ed0acff849b26b6cef2e9aeac65a1a173d2cd796de29deb49c37fb3b3f`。

### R33 独立方案裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

R33 已用原钩子验证修订路线。两份仓外对照的 blob 与暂存索引一致；相对 R32 只换入 `latex.ts` 和 `rich-markdown.ts`。同一 57a 父树上的原 `commit-msg` 用时 8.5 秒、退出 0，Large trailer 保留。该回执验证方案可行，实际实施后仍须对准确暂存树重跑。

`latex.ts` 的仓外对照为 1,566 行。实际实施后按真实差分记录行数，更新 §15 的约数。

## Follow-up

在准确 R33 候选上重跑原钩子、公式与围栏对照、真实 Session、TUI 类型检查及长样本。正常 `pre-commit` 的冻结安装曾因磁盘不足退出；须在空间足够的环境用原钩子完成。真实截图、完整应用 A/B 和正式 Guard/Test 仍按 R32 的顺序验收。

## Rejected speculation

不为通过规则改 Gate、基线或阈值，不拆提交，不更换排版引擎，不新增解析限制或备用分支。

## Requirement and traceability coverage

复核了完整 §1、R32 原失败回执、R33 实际仓外差分及原规则回执。公式对照共 2,516 个输入、5,032 次计算，输出字节、换行、列宽和无结果一致。八种围栏输入的识别结果一致。R33 把调整限定在六组既有函数、十份静态词汇表和原围栏判断；其余产品路径、署名和验收条件不变。

## Primary-path and fallback verdict

同一 LaTeX 解析器保留原命令优先级、游标和布局。静态词汇表继续只做成员查询；抽出的围栏判断继续由同一 renderer 调用。没有新增解析链或备用成功路径。

## Release verdict

**APPROVE。** 批准精确 **R33 方案**，SHA-256 `57d1d5bccbcda266669379e4f4fda6e385d9ef22f0b2b5427c0ca22a3c10186f`。登记裁决后可实施；准确差分另经独立实现审计。

### R34 独立方案裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

将 §5、§16 的旧基线引用标成历史证据。§18.1 直接登记 6dd 的 `latest-rich` 红灯，保留 c621 和 57a 的原回执供对照。§20 更新依赖记录：合成探针已用现有图包运行，正式冻结安装仍待验证。

## Follow-up

在正式候选上完成冻结安装、Session 与表格测试、原提交钩子、真实终端截图及普通／富文本成对 A/B。推送现有 #6 后，核对正式 Guard 的候选和比较基线。#14 仍未合并，6dd 上的原 Large 检查仍读取 GitHub review。按实际生效规则验收，并在合入前核对二进制资产的许可随附。

## Rejected speculation

无需复制旧 OpenTUI 补丁、改 Gate 或 Core 水合，也无需重做普通表格和开页定时器清理。仓外 native 帧和窄探针只用于验证合成，不作为完整应用截图或性能回执。

## Requirement and traceability coverage

GitHub 当前 `dev1-smark` 为 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，树为 `e0baea4acaa886363c1c172f5c80a5422bfe620f`。从 57a 到 6dd 的四个提交中，与 #6 产品路径重叠的是 Session 和 OpenTUI 补丁。合成保留基线的尾表回读和清理；旧候选尾表 0/2，6dd 与合成各 2/2，合成开启富 lexer 仍为 2/2。29,013 字符富文本对照显示 6dd 红、合成绿；新增补丁比 6dd 增加 807 行，严格反向检查通过。现有 Guard 已包含正式 TUI 性能入口。

## Primary-path and fallback verdict

现有 TextPart 继续接入一条 OpenTUI 原生增量路径。表格保持原基线的回读条件，富块沿同一个 lexer 和节点更新入口处理。计划没有新增二次分词或备用引擎。

## Release verdict

**APPROVE**。批准精确 **R34 方案**，SHA-256 `d3b99be97080bfb6490b0926e71b3bac8ed14b1f1c01e001a8aada88fb76c133`。登记本裁决后可实施，实际差分另行独立审计。

## 23. Implementation Evidence

### Actual Files and Diff

R33 实际只改两个既有生产文件和本 Plan，整个 57a→候选是九路径。LaTeX 共 1,566 行，首部三行、已有渲染入口、布局和列宽合同不变。R32 差分及回放树原样保留。

### Red-Green Test Evidence

真实 stock `.husky/commit-msg` 使用精确 R32 stage、同 57a 树的本地对照 HEAD，Large trailer 已放行规模，仍 exit 1：公式实现 CC excess 143/depth excess 3/module-state 10，围栏匹配 CC excess 6。公式超限的实际边界：renderLayout 30/2，parseSequence 14/1，parseScripts 8/0，parseCommand 67/0，parseOperator 12/0，parseEnvironment 12/0；两列是 CC 超量和嵌套超量。Rich 仓外提取闭合判定后 CC excess 0，八类输入命中与现状一致。词汇表单项对照在 5,032 次计算中 4,244 个字形与 788 个无结果逐一相同，消除 10 处 stock module-state 输入。合并所有私有切片后，原 `script/guard/shape.ts` 的公式 CC excess 143→0、嵌套超量 3→0；固定 5,032 个结果无字节、宽度或无结果差异，30,001 字符分组和 31,501 字符嵌套根式在横排、块级共四个对照也逐字节相同。Rich 同一关闭判定在八种已开、已闭、错符、短标、普通与数学 token 下逐项结果一致。 使用完整旧候选索引、两份独立仓外切片组成的对照件及同一 57a 树的隔离 HEAD，运行原 `.husky/commit-msg` 规则，8.5 秒退出 0，Large 准许字样实测出现。本轮只验证静态门禁，没写入实际源码、没创建发布提交。

### Verification Commands and Results

使用 Bun 1.4.4 的实际原钩子与静态度量，不改阈值或基线。正常 pre-commit 在独立临时依赖投影执行原冻结安装，提取 drizzle-orm、wrangler、drizzle-kit 时 ENOSPC；中止后清理可重建依赖，将空间恢复至约 307 MiB，保留原日志。不能将这条本地安装当成线上冻结安装结果。R33 按 §18 保留本地钩子和正式原验收。

### Original Feedback-Loop Result

57a 原生语义红灯与现有 45 个候选回执仍分别保留。实际 45 个既有测试通过，0 失败，772 次断言；TUI 整包类型检查退出 0；29,013 字符、846 行真实 native 探针通过。实际 LaTeX 源对照 5,032 输出逐字节与逐列一致；两组 30KiB 附近的深输入在两种排版中四次等价。实际文件与通过原 staged 钩子的两份仓外对照字节相同，独立索引重放保持相同；最终准确 stage 补跑原 commit-msg 并交原回执。

### Actual Secondary and Replacement Path Inventory

正式源码只含既有路径重组和词汇表，实验留仓外；保留原生前缀、一次排版、开闭语义、普通内容与唯一解析路径。

### Remaining Unverified Items

完整应用直接截图、正式成对 A/B、当前正式 head 的原 Guard/Test 及合入前发布资产核验。当前仅实施阶段验收提交，发布和可合并仍分开。

### R34 实施证据（6dd→现有 #6）

- **文件与入口**：准确基线 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42` 的树 `e0baea4acaa886363c1c172f5c80a5422bfe620f`。九路径均按 §15。锁、TUI manifest、三份 renderer util 和 Session 测试共六个 blob 与已发布的 3495 逐字一致。路由相对基线只新增六行 TextPart 接线；导入、富 renderer 与 lexer options 原样，基线开页滚动清理保持。相对基线，OpenTUI patch 仅追加 805 行。为通过外层 `git diff --check`，缩掉单个内嵌 diff hunk 的两行前置上下文，严格正反向验证后四份实际包产物仍逐字相同。包补丁 SHA-256 `bd947f8bc7a9080237a5731996d1a6ff4a7dec8e06af415aa3a336347b5f08de`。
- **真实红绿**：6dd 的富语义反馈 exit 1，已验证原 #6 在两例新基线表格用例均红；合成通过富语义的七项断言、尾表 inline/reference 两例（富 lexer 开启亦通过）。原生索引和 renderer chunk 安装态 SHA-256 分别为 `96da740ded37d7f50e0c14d5bd756b5f65220a49d26eb2d9ee46103d8b7dc9e1`、`bf6db79dd972e51f1bc1c3f43c0793b6deaeb5ae65d659568e1db42df0a13198`。四份 native 产物与来自包原字节的严格补丁应用一致；载入的 lovely-mermaid 实际版本 0.3.3。
- **实际验证**：使用 Bun 1.4.4。于 `packages/opencode` 执行 `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts -t 'keeps late text'`，2 通过、0 失败、4 断言，8 个不属于该选择的用例保留；日志 `2ea5ec702bb5118703112b29924b987cde53bf153aa85d2770527dcd68abaad4`。于 `packages/tui` 执行 `bun test test/cli/cmd/tui/session-message-render.test.tsx test/routes/session/session-layout.test.ts`，45 通过、0 失败、772 断言，日志 `c8b69c730c5cc105dec1097fc1d73fa0be2db5a754aea5c4f65faabdac69d3e7`；`bun run typecheck --singleThreaded` 退出 0，日志 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e26211eea1`；`bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts test/cli/cmd/tui/dialog-session-list.test.tsx`，20 通过、0 失败、49 断言，原泄漏预载无红，日志 `82e9f564594361663f51342cd1b35621567a5f6284f74c05a4d0a06b7d6511b8`。这轮复用原冻结的依赖及只读投影，并逐文件核对候选；正式 6dd 候选冻结安装仍单独验证。
- **路径与注释**：保留一条原生增量入口与既有兼容分支。原表格条件和退出清理来自基线；测试没有新增实例。新增部件中文注释说明富 token 与高亮缓存切片的边界、IDE live 才会遇到的节点生命周期和闭合条件；只保留能解释代码行为的注释。此版本未改变或引入临时 workaround。
- **待确认**：独立实现审计、候选原冻结安装和钩子、最终单提交及空目录恢复、已有 #6 的原正式 Guard/Test/Typecheck、完整应用终端截图与配对性能、二进制资产许可随附。历史 57a 与基线 6dd 的绿色回执分别保留，均不作为候选线上验收。

补充核对：以精确 6dd 的既有测试原文件执行 §18.7 同一命令，2 通过、0 失败、4 断言，日志 SHA-256 `a2375eca9a97c003079426691b300813a582a6be438955cf18a999968a648297`。

## 24. Implementation Audit Record

### R33 独立实现裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

R32 的提交钩子阻断已关闭。准确 R33 暂存树运行原 `commit-msg`，8.6 秒退出 0。Large trailer 通过，原 `cc-excess`、`depth-excess` 和 `module-state` 错误均已清除。完整 `pre-commit` 冻结安装曾因磁盘不足退出，仍须在实际提交前用原钩子完成。

## Follow-up

按 §18 完成原提交钩子，向现有 #6 发布单提交候选。随后针对准确 head 补齐冻结安装、真实终端截图、完整应用配对 A/B 和原 Guard/Test。合入前核验二进制发布资产随附许可证；合入由用户决定。

## Rejected speculation

不修改 Gate、基线、预算或计时器，不把原生探针当作整应用截图，不把阶段审计通过当作线上验收通过。

## Requirement and traceability coverage

核对了完整 §1、准确批准方案、57a 基线和实际九路径差分。R32→R33 只改两个既有生产文件与 Plan。实际总差分 `+3523/-52`，含 730 行 Plan；九个工作树文件与候选 blob 一致，独立回放树相同，`git diff --check` 通过。两份既有测试文件 **45 通过、0 失败、772 次断言**。TUI 类型检查和 846 行原生探针通过。5,032 次公式输出的字节、列宽及无结果一致；两组长输入在横排、块级四次对照一致。

## Primary-path and fallback verdict

公式继续走同一解析器和布局，命令表只做成员查询。围栏的原闭合判定仍由同一 renderer 调用。原生增量、父 token 交接和普通 Markdown 路径不变。

## Code quality verdict

准确候选通过原 `commit-msg`。重组限定在 R33 已批准的函数、静态命令表和围栏判断；未新增测试实例、接口或备用解析。LaTeX 三行署名和根许可保持原样。

## Release verdict

**APPROVE。** 批准候选树 `c17d6cbdfc11617b01538bc6a6ead56c3b412f6c`，实际差分 SHA-256 `6772a78574e1099680bfdc3a9dc247bade5e4b957e5d904c4fc90483377a6756`。本裁决通过独立实现审计；仍须按 §18 完成正常提交和正式验收。

### 行政登记

准确 57a50ae146f8265e6fbbb348cddcfa3d3f3d6c56 父和 R33 施工树上，原 commit-msg 规则退出 0，Large trailer 生效；原 pre-commit 用 Bun 1.4.4 在只读已热依赖及私有写层完整运行，冻结安装与原 postinstall 完成，退出 0（65.10 秒），准确锁定的 lovely-mermaid@0.3.3 实际解析成功。前次冷安装磁盘中止的回执保留。批准后的这次登记只改本 Plan，八份实现/依赖/测试的 blob 与上面审计的候选完全相同。正式平台和实机验收按 §18 执行。

### R34 独立实施裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

将 6dd 原命令的回执 `a2375eca…` 补录 §23。该命令与候选使用同一原测试文件和过滤条件，两边均 2 例通过、0 失败。

## Follow-up

按 §18 完成原提交钩子，向现有 #6 推送单提交候选，再核对准确 head 的冻结安装、正式 Guard/Test/Typecheck、真实终端截图和普通／富文本配对 A/B。合入前核验发布资产随附许可。

## Rejected speculation

无需改 Gate、Core、计时器或预算。原生探针和测试帧不计作完整应用截图或性能验收。

## Requirement and traceability coverage

核对九路径和完整差分。六个依赖、渲染及测试文件与已发布 #6 逐字相同；Session 仅新增六行富渲染接线，OpenTUI 补丁保留 6dd 原字节并追加 805 行，严格反向检查通过。6dd 富渲染红灯在合成候选转绿。候选两例尾表测试、45 例 Session／布局测试、20 例带原泄漏预载的测试及 TUI 类型检查均通过。

## Primary-path and fallback verdict

仍由一条 OpenTUI 原生增量路径处理正文，保留 6dd 的尾表回读、引用链接和退出清理。没有新增二次分词或备用引擎。

## Code quality verdict

`git diff --check` 通过，测试实例零净增。总差分 `+3571/-3`，其中 Plan 816 行。

## Release verdict

**APPROVE**。批准 R34 实际差分 SHA-256 `b5d559ed4b97ee722cec9baeadb272390d9578fc58ca18397ab79ecad0144b38`，候选树 `929f08b0d0e681feca6f3a54e4031374c4098df6`。实现审计通过；合并就绪仍按 §18 的正式回执判定。
