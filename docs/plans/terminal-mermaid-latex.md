# Canonical Implementation Plan: Mermaid 与 LaTeX 原生增量终端渲染

> 公开版仅清理证据定位符及私有会话、消息和资料库标识，改用验收归档相对引用；用户需求原文、审计裁决主体、命令及哈希保持。完整私有原样 Plan、审计和 Gate 回执另行留存。

> Status: verified
>
> Revision: R22
>
> Approved revision: R22
>
> Audit mode: full-scope
>
> Requirement source: 本对话逐字需求及 §1；流程版本 dev1-smark@0dfffcda
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-20

本文件是唯一有效设计。产品固定基线为原始 R1 实施前 `26061b595b3140d37717248222c7ed2016421db0`，也是本轮核对的 dev-smark 最新目标。首次功能提交 `931f0316767a011fe53c784ac033a76214fcd6c7` 的直接父提交为该 SHA；原四提交链为 `03060e4c → febf83b3 → 96919fe9 → 931f0316 → 26061b59`，逐级 Git commit/API 记录保存在 `verification-archive/shared/pr6-r22-plan-history/original-base-chain.json`。R19 或当前 PR HEAD 不再充当原始需求基线。

流程权威为 dev1-smark `0dfffcda2bcd07e28014d1e82270453e3dc586d3` 内的 `docs/guides/workflow.md`、共享 policy、规划 skill 和 24 节模板；流程更新提交 `abb9b6b1ae6caeb94b1cceaf26e344e3a0db0ef8`。产品仓库本身的 `docs/workflow.md` 是旧版本。流程材料来源与产品目标分开记录，dev1 产品代码不进入此 PR。

本轮重建 Plan 合同，生产目标保持已形成的 R21 候选字节；另在§16精确规划批准后删除一项中间方案专用的重复测试夹具，净删54行。终态继续为经过完整验收、独立实现审计、正常 hook、单提交与持久化的 PR，保持未合并。R22 方案批准前不授权正式产品、测试、依赖或锁文件改动。

R21 原文及全部验收、审计记录已逐字冻结在 `verification-archive/shared/pr6-r22-plan-history/R21-canonical-original.md`，SHA256 `b2596500def628921cba4601e264b585382f0883f2f2eeb4e95735150cdde77a`。该历史文件用于核查证据与裁决，现行设计以本文件 §2–20 为准。

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

## 2. Explicit Non-Goals

- 不加入图片渲染、外部网页或图形浏览器；终端文本图形和公式是本次能力。
- 不修改 HTTP、SDK、插件接口、数据库格式、消息原文、权限系统、模型请求与服务端分页合同。
- 不复制 dev1 产品代码到 dev-smark；不引入新全局缓存、第二套 Markdown 解析器、渲染服务或新功能开关。
- 不改既有正文 32,768 字符/1,000 行预算与实验开关；不扩大支持语法来追求抽象“完整”。
- 不保留 external-directory.test.ts 的宿主目录修正及 session-integration.test.ts 的旧内部断言删除；两文件最终与固定基线相同。
- R22 是文档改版，新增正式测试数为零。全 PR 中原本新增的功能测试按固定基线明列，不能将“R21 不再增测试”误写成全 PR 零新增测试。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| dev1@0dff 的 docs/guides/workflow.md | 固定 R1 前基线、完整目标、分阶段加载、独立审计、24 节现行合同 |
| 同版本 .opencode/policy/first-principles-engineering.md | owner、原生单路径、证据、Follow-up、无注释配额 |
| 同版本 .opencode/templates/canonical-plan.md | 完整 24 节，整篇不超过 2,000 行 |
| 同版本 .opencode/skills/first-principles-planning/SKILL.md | 先重建上下文和反馈信号，只改 Plan |
| 产品树根 AGENTS.md | 本地风格、避免 any/不必要 helper；测试及 typecheck 从包目录执行 |
| packages/opencode/AGENTS.md | Effect/命名约定，完整 TUI 生命周期及显式清理 |
| packages/opencode/test/AGENTS.md | 真实实例、scope 自动释放、就绪信号代替任意等待 |
| 产品树 CONTEXT.md | Session/Message/Part、事件 producer、v1/v2 两个有效 consumer |
| docs/adr/README.md | 当前索引的 triage ADR 不决定本渲染路径 |
| recovered-skills/{diagnosing-bugs,tdd}/SKILL.md | 真实红信号、单 seam 纵向红绿；已有原始技能包继续复用 |

当前流程文件由审计员按上述精确 Git ref 自行读取。审计专用 skill/agent 文件仅交独立审计员，本轮规划者不加载其内容。

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| 原首次实现 commit 931f0316 的 GitHub parent，旧 03060e4 commit 对象 | 核证 R1 前 HEAD=26061b5，消除中间基线歧义 | observed |
| 26061b5→当前冻结候选完整 diff；两个 Session 入口 | 原功能缺口与最终全 PR 文件边界 | observed |
| util/{math-markdown,rich-markdown,latex}.ts；OpenTUI patch | 数学词法、图形布局、字面字形与原生增量 owner | reachable |
| context/sync-v2.tsx、session/processor.ts | 正文事件与 HTTP/SSE 合并完整调用链 | reachable |
| math-markdown/rich-markdown/sync-v2-hydration 现有候选测试 | 功能、字面量、容器、缩放、水合 seam | observed |
| session-message-render、slot-replace、processor-effect 测试及基线 | 原生资源结算与 producer 行为 | reachable |
| package.json、bun.lock、原发布 core 与 patches | lovely-mermaid 唯一新增运行依赖、原生补丁与锁定图 | observed |
| verification-archive/shared/pr6-merge-ab/{REPORT.md,ATTRIBUTION.md,formal-summary.txt,r19-evidence} | 目标分支/旧候选真实长会话与单点归因 | observed |
| verification-archive/shared/pr6-r20-probes；pr6-r20-hydrate.jb499h | 原投影成本、未闭合布局、节点身份、终态优先级红信号 | observed |
| verification-archive/shared/pr6-r21-amount-refs-ab；pr6-r21-stream-ab-prep | 原 R19/R21 同输入同节奏实际 SSE/PTY 对照 | observed |
| verification-archive/shared/pr6-r21-native.jdUrWl | 真实原生应用、截图、公式/引用/布局与运行物哈希 | observed |
| verification-archive/shared/pr6-r21-recovery-prep.BbzZDx | 已冻结证据清单、源码身份与恢复脚本 | observed |
| 冻结 R21 原文 §23、27、33、39、43、45 | 历次实际命令、成功/失败及限制原样保留 | observed |

这些路径用于定位原始材料。测试结果只能归属于其记录的源码、Bun、依赖和输入；本轮 exact graph gate 的新结果由实际执行负责人记录后加入 §23。

## 5. Current Behavior

固定基线 `26061b5`：实验 Markdown 在非流式完成时挂载，流式正文用既有 code 路径；没有数学扩展或 Mermaid 节点。v2 已定义 Text.Started/Ended 等事件，但接受正文增量时未桥接 Text.Delta；HTTP hydrate 直接 reconcile 返回页面，可覆盖客户端已收到的内容。基线没有本 PR 新增的 math/rich/latex 文件及专门功能测试。

完整目标链：

```text
Provider SSE → processor 接受并记账文本 → 既有 PartDelta + v2 Text.Delta
→ v1 Part / v2 SessionMessage → 原预算和实验开关
→ 同一 MarkdownRenderable 原生增量 lexer + 数学 token 扩展
→ 原生 CodeRenderable 字面数学片段 / 闭合围栏 custom 节点
→ Yoga 实际宽度 → 终端网格及直接截图
HTTP messages → sync-v2 在途请求身份和变更 ID → 服务端终态优先 → 同一消息 store
```

候选保留消息与持久化原文。CRLF/lone CR→LF 仅发生在 Markdown consumer 的 raw 边界，数据库正文不重写。原生前缀身份/节点复用沿单一解析路径；全文预投影已从两入口删除。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| Mermaid、math、latex 围栏 | Assistant Markdown | 普通 code token 可能未闭合 | 两 Session→renderNode | richMarkdown/原生 code | contracted |
| `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 与既有数学环境 | 模型正文 | 仍可能含金额、变量、代码 | 同一 Marked lexer 扩展 | math-markdown | contracted |
| 代码 span/普通围栏、金额、shell、模板、正则 | 正常代码任务 | 字面美元不保证公式 | 原 lexer 先保护代码、扩展识别合法定界 | math-markdown/Marked | observed |
| 列表、引用、表格中的公式及图 | 正常 Markdown | 具原容器语义及缩进 | 原生容器/inline | OpenTUI | observed |
| streaming→完成、同消息更正文、窄→宽→窄 | Session props/真实窗口 | 同一消息不等于内容不变 | Solid→Markdown→Yoga | 入口/节点 | observed |
| conceal 开关及异步 Tree-sitter | v1 配置/native highlight | 高亮会晚于首帧 | CodeRenderable | OpenTUI | observed |
| 同 Session 反序 HTTP、期间 SSE、缺项/静默页面 | sync/reconnect | HTTP 可能已完成，SSE 终态可能缺失 | sync-v2 合并 | SyncProviderV2 | observed |
| 超原正文预算、未知图/公式、过窄布局 | 原输入及实际宽度 | 原文仍可读 | 既有 budget/source branch | 原入口/rich | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 图和公式在两入口的真实终端可读；不增加图片 | REQ-01/02 | math/rich + 真 TUI |
| INV-02 | 普通 Markdown、代码、金额/变量及原文存储保持；公式字形不受 conceal/异步高亮破坏 | 原基线行为、REQ-04 | rich 原生帧与 math 字面输入 |
| INV-03 | 沿原生稳定前缀/不稳定后缀；闭合后布局；宽度与完成更新保留同实例 | REQ-04、R19 实测成本 | 真 SSE/PTY、原生组件对照 |
| INV-04 | 已接受非 summary 正文按现有开关发 v2 增量，保留旧事件及预算 | producer 原接口 | processor-effect |
| INV-05 | HTTP 终态不被本地半截覆盖；旧请求不覆盖新请求；分页/同毫秒排序和 Session 隔离保持 | hydrate seam | sync-v2-hydration |
| INV-06 | 原预算/开关、错误源码展示、真实宽度和清理生命周期保持 | 原产品规则 | session-message-render/slot/rich |
| INV-07 | 全 PR 文件各有职责；MIT 来源完整、只加必要图引擎、不混宿主测试修复 | 用户范围与许可 | diff/锁图/来源核对 |
| INV-08 | 正常 gate、独立审计、单提交及可恢复持久化后才交付 | REQ-03/06 | gate、Git/tree、空目录恢复 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | 基线 lexer/renderNode 没有数学/图形语义，完成态仍把围栏当源码 | 原生 Markdown 扩展与 rich 节点 | 首次功能提交新增 owner；基线 tree 缺文件 |
| INV-04 | processor 接受 value.text 后只走旧 PartDelta，v2 consumer 缺 Delta | processor Text lifecycle | 原红测 v2 Text.Delta=0，候选逐片一致 |
| INV-05 | HTTP reconcile 整页覆写 live；缺少请求归属与消息权威判断 | SyncProviderV2.sync | 旧页回包清空前缀、反序请求覆盖的既有红绿 |
| INV-02/03 | 中间实现先全量 prepareMath 再 native lexer；callback truthy 误改普通容器；全局转义掩码 | 最终必须删除这些中间 workarounds | R19 73 帧解析约108万字符、未闭合20次布局、普通容器/异步字形红信号 |
| INV-05 | 中间实现两次 stringify 全消息且 changed 优先于 saved.completed | 最终合并优先级/在途 ID owner | 无补偿 Ended 的竞态 R19 8/9→终态优先9/9 |

后两行定位已实施中间路线的退化来源，帮助验证删除路径；它们不改变固定基线，也不单独授权保留仅区分中间设计的正式测试。基线功能红信号与中间性能实验分列 §16/23。

反馈 loop 复用冻结 R21 的真实 Provider→Session→PTY harness，输入包括普通长文、早期 shell/金额/公式/引用；各消息最终原文逐字回读，画面推进与 CPU 分开。历史执行命令和输出保存在冻结历史 §37–45，R22 文档阶段不伪造新的运行结果。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 数学定界及 raw/source | math 扩展，注册到 native lexer | 只产生合法数学 token | 同一次 Markdown 词法分析 | Session 不应再全文解析 |
| 字面公式显示、异步样式 | OpenTUI inline/CodeRenderable | source offset→StyledText | 原生高亮与缓存 owner | 全局 conceal 掩码无法维护字形 |
| 闭合图/显示公式及宽度 | rich callback/TextRenderable | 合法闭合内容到一个可恢复节点 | token 语义与 Yoga 宽度已在该 seam | 消息不能按提示宽度重建整个树 |
| SSE 正文桥 | processor | accepted delta 与原 lifecycle 一致 | 最早知道预算已接受的位置 | TUI 不可从终值伪造增量 |
| HTTP/live 合并 | SyncProviderV2 | 请求身份、终态权威与分页 | 唯一 store mutation/HTTP owner | renderer 不决定消息新旧 |
| 资源清理 | 原测试 fixture | 原生高亮结算再销毁 | fixture 持有 renderer | 产品不加入等待/探针 |

## 10. Single Approved Primary-Path Design

### 数学词法与来源

`makeMathExtensions(renderLatex)` 返回 block/inline 扩展，`mathExtensions` 保持稳定引用，由 native 为 Markdown 实例构建自己的 lexer。扩展的 lastBlockSource 只记录同步分词最近的块视图，恢复 start 探测切片偏移；不保存消息图或公式缓存。双美元先于单美元；反斜线奇偶决定转义，显式括号按完整闭合识别。行内不吞跨行/空式；美元的空白、数字金额、变量、模板和后续连续字母数字保留普通文本。代码 span 的反引号 run 按等长配对，跨段不拼接；普通 fenced/缩进代码归 Marked。

块公式识别最多三格缩进下的 `$$`、`\[` 及 equation/align/alignat/gather/multline/flalign/eqnarray/displaymath/aligned/gathered（可带星）的配对环境。同名环境有嵌套深度，闭合后同行其它正文不被误收为独立块。未闭合数学块保留 pending/raw；不提前执行显示布局。inline token 使用独立 `opencode_math_inline` 类型，保持原 raw 与已转换字形；转换不可用、超4096源码或非单行结果保留源码。转换和字面数据随 token 生命周期，不设永久全局公式缓存。

LaTeX 取 pi-tui v1.5.2 单文件实现，保留 MIT 署名和冻结上游来源。唯一适配为可见宽度使用项目 Bun.stringWidth，原上游逻辑保持；28 个已记录常见行内/显示/多宽 Unicode 输出与原引擎逐字对照。Mermaid 使用 lovely-mermaid@0.3.3 的实际文本布局，唯一新增运行依赖。

### 原生增量及字面区间

OpenTUI `parseMarkdownIncremental` 是唯一 Markdown 解析 owner；两入口传入原文的 LF 规范化视图和实例稳定的扩展/回调，不执行 prepareMath 或递归字符串投影。按原 token.raw 对齐、稳定前缀及不稳定尾部更新；引用定义使用 bundled Marked 的 first-definition-wins。稳定定义带入尾部 lexer；有效 links 语义变化才从受影响边界失效，同标签后定义仍消耗原文但不覆盖首定义。定义使前文语义变化时允许回到首 token，不以字符包含 `]:` 为由无条件全文扫描。

初始 inline seed 与异步 `convertHighlightRegion` 使用同块的 literal ranges。范围内输出字面 StyledText，范围外沿原 converter 的高亮、链接、复制和 conceal；UTF-16 offset 对齐 content.slice。样式缓存截断落入公式时向范围起点收敛，避免切开字形。列表/引用按真实去前缀输入计算 offset，引用保留原基色；表格沿原 inline StyledText。无数学范围的普通块使用原路径。

### 围栏、容器、宽度及两入口

`closedLanguage` 同时用于 callback 和 handlesCode：仅 mermaid/math/latex，源码分别不超过20,000/4,096，普通围栏须匹配同字符、足够长度闭合；数学扩展的 math 标志只来自已闭合块。未闭合/普通代码直接走原生源码节点。合法闭合图/式布局一次；未知或布局失败返回默认源码。该源码展示是既有兼容分支，不构造第二种成功解析。

custom TextRenderable 保存原文和布局结果，初始可换行源码；实际 Yoga 宽度达到图形宽度时切换到无折行艺术文本，缩窄再回源码。只在 fits 状态改变时更新，复用同一节点；父引用/列表边距已含在实际宽度。普通引用仅在 token 子树真含目标 custom code 时用嵌套 Markdown，普通引用保持 markup.quote；普通列表 code 继续原位更新，节点类型实际变更才替换。

两个 Session 入口都保留原预算和实验开关，实验 Markdown 在流式及完成态共用同实例，删除该分支的 completedKey keyed 重建。v1 保留 top-level、grid、动态 conceal，v2 保留自身 coalesced/主题合同。非实验 code 分支保留既有 keyed 行为，其 completedKey 流式取宽度，完成取宽度和内容。配置、消息身份或原预算模式切换按原生命周期换实例。

### 事件与水合

processor 在累计预算接受 value.text、更新当前正文后，非 summary 且 experimentalEventSystem 启用时，发布 SessionEvent.Text.Delta，使用当前 Session ID、原片段及 DateTime；旧 PartDelta、metadata、终值及持久化继续原路径。

sync-v2 用 `Map<sessionID, Set<messageID>>`：Set 同时是请求身份和本次 GET 期间变化集合。事件 mutation owner 仅在真实更新时标记 ID，新增 prompt/assistant/compaction 标记实际消息；Step.Started 改动前后两个 assistant 时标记两个。不存在 owner 或工具状态不符时不标记。没有全文 JSON 序列化或持久版本表。

sync 返回先确认仍持有同一请求身份；以 HTTP items 建 Map。服务端已完成 assistant 优先；其余真实变化或未完成 live 前缀保留，本地已完成 assistant 不退回同 ID 未完成快照；静默请求仍保留 active prefix。未变化且不在服务端页面中的完成消息按分页淘汰。按 time.created 降序、BINARY ID 降序排列。旧请求 finally 只能释放自己的 Set，新请求继续收集变化；独立 Session 各自隔离。

### 正式测试与交付

测试使用原生缓冲区、实际 Session/SDK/事件公共 seam，不新增产品探针或用于测试的接口。fixture 结算原生高亮再销毁，沿仓库 scoped 生命周期。固定基线→目标全部代码、测试、依赖和 patch 明列 §15；无关两测试回到基线。唯一新增实施范围是批准后执行§16的54行重复测试删除，其余生产、测试、锁字节保持。方案阶段只在隔离副本核证，不改正式文件。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| native Markdown+数学扩展+闭合图节点 | 目标 | primary-contract branch | 是 | 全部新增渲染语义 | preserve |
| 非实验分支、超原预算纯文本 | 基线已有 | existing compatibility | 保留原文 | 原路径 | preserve |
| 未闭合/未知语法/过长/过窄源码 | 支持域的可读原文 | primary-contract branch | 不声称图形成功 | 图节点内有限分支 | preserve |
| 无公式的原 native 样式、高亮、列表更新 | 基线已有 | pass-through | 是 | 原路径 | preserve |
| 两次 Markdown 解析、先全量转义再掩码 | 中间产物 | forbidden fallback/duplicate | 曾产生显示文本 | 目标为0 | remove |
| 永久公式缓存、另一 lexer、按空行切文档 | 反馈中建议路径 | forbidden competing implementation | 不进入产品 | 0 | reject |
| CPU/词法量/PTY阶段记录 | 仓库外验收 | diagnostic | 无产品结果 | 产品中0 | preserve evidence |

新增产品诊断决策面为0，新增失败后第二成功路线为0。源码显示始终保留真实输入，不把渲染异常包装成另一公式引擎的成功。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| prepareMath 全文/容器递归字符串投影 | 中间实现先转换公式再交 native | 同一 lexer 扩展维护 raw 与字面内容 | math/rich 与两入口 |
| onHighlight 全局转义 conceal | 掩盖合成反斜线 | literal ranges 由样式 owner 处理 | OpenTUI patch/rich |
| callback truthy 强制所有引用/列表重建 | 扩展渲染过宽 | handlesCode 同 token 判断 | 原生容器更新 |
| 宽度/完成态重挂 Markdown | 用重建刷新图形 | 同节点 Yoga 宽度切换 | 两入口实验分支 |
| hydrate 前后全量 stringify/unwrap | 比较整个消息图 | 实际 mutation owner 标记在途 ID | sync-v2 |
| 整包 pi-tui 与重复 Marked 18 | 借用单文件公式引擎 | 许可完整单文件+native Marked | package/lock/latex |
| external-directory fixture与内部 tokenAccounting 断言修复 | 旧验收环境问题 | 不属本功能责任 | 两测试回到26061b5字节 |

以上既有中间路线退出最终全 PR；历史失败日志继续保留，不为维持旧方案增添补偿代码。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-01/INV-01 | token→图/公式文本 | math/rich/latex、lovely dependency、native patch | 固定字形、图形连线、两块模式及九类图/五类公式既有矩阵 |
| REQ-04/INV-02 | token/raw→inline/native highlighter | literal ranges、容器选择 | 异步结算后 conceal两态、引用/列表/表格、代码和金额 |
| REQ-04/INV-03 | content更新→native增量→同节点 | 两入口与native parser/更新 | 73片真SSE、宽窄往返、最终正文、节点/分词诊断证据 |
| INV-04 | accepted text→v2 events | processor9行桥 | 真实provider片段、summary开关、旧事件和终值 |
| INV-05 | HTTP/SSE→store | sync-v2请求Set/权威合并 | pending、静默、反序、终态、跨Session、同毫秒分页 |
| INV-06 | 原预算/开关/资源生命周期 | 两入口、fixture | 原message-render与slot断言，真实TUI清理 |
| INV-07 | dependencies/patch/full diff | 单LaTeX文件、两无关文件回撤 | 冻结来源/锁图/安装及逐路径diff |
| REQ-02/03/05/06、INV-08 | 完整应用→gate→单提交恢复 | 本Plan+完整产物 | 直接截图、真实原hook、独立审计、空目录重放 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 数学 block/inline 扩展 | REQ-01 | 原始基线无数学token | 原Markdown把这些内容当普通源码 |
| literal source ranges | INV-02 | 公式含Markdown标点，异步高亮可重解释 | text转义后conceal无法保留动态开关字形 |
| custom闭合图节点及handlesCode | INV-01/02/03 | 未闭合前缀布局、普通容器退化、实际窄宽 | 默认code只显示源码；全局callback不表达某token是否接管 |
| native链接表/稳定raw处理 | INV-02/03 | 定义影响前缀且重复定义不得显示 | 自定义token接入须保持native定义语义与raw偏移 |
| 实例稳定的数学/图回调及流式Markdown | REQ-01/04 | 基线流式禁用富渲染、key重建 | 需求要求流式内容与原增量能力共同工作 |
| accepted Text.Delta发布 | INV-04 | 基线v2没有逐片producer | consumer不能凭HTTP终值重建时序 |
| 请求Set+mutation mark+终态合并 | INV-05 | 原HTTP覆写，旧请求/缺失终态真实竞态 | reconcile没有来源权威或请求身份 |
| 单文件latex/必要图引擎 | INV-01/07 | pi仅需单文件、Lovely已有文本引擎 | native没有该数学和图布局能力；整套竞争TUI无必要 |

## 15. File-Level Change Plan

以下均以26061b5为起点。行数是当前冻结目标的实际 diff 量，用来界定完整范围，不替代设计。`packages/opencode/` 下路径在表中省略该前缀。

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| bun.lock | modify | 唯一新增lovely-mermaid锁项及workspace依赖 | +3/-0 |
| package.json | modify | 声明lovely-mermaid@0.3.3 | +1/-0 |
| src/cli/cmd/tui/util/latex.ts | add | MIT来源公式引擎及Bun宽度适配 | +1535/-0 |
| src/cli/cmd/tui/util/math-markdown.ts | add | §10合法数学语法、raw、pending与代码保护 | +284/-0 |
| src/cli/cmd/tui/util/rich-markdown.ts | add | §10闭合判断、图/式布局、实际宽度节点 | +63/-0 |
| src/cli/cmd/tui/routes/session/index.tsx | modify | v1原预算下同实例原生扩展 | +20/-16 |
| src/cli/cmd/tui/feature-plugins/system/session-v2.tsx | modify | v2原预算下同实例原生扩展 | +15/-14 |
| src/cli/cmd/tui/context/sync-v2.tsx | modify | §10请求身份、变更ID与终态合并 | +129/-61 |
| src/session/processor.ts | modify | 已接受文本v2事件桥 | +9/-0 |
| patches/@opentui%2Fcore@0.4.3-smark.13.patch（根） | modify | native lexer扩展、字面范围、容器/节点更新及相应类型 | +870/-86 patch文本行 |
| test/cli/tui/math-markdown.test.ts | add | 数学公开token行为、源码及代码保护 | +82/-0 |
| test/cli/tui/rich-markdown.test.ts | add | 原生字符帧、嵌套图/式、conceal与实际宽度 | +413/-0 |
| test/cli/tui/sync-v2-hydration.test.tsx | add | 实际Provider/SDK/事件合并时序；按§16删除中间专用route-effect重复夹具 | 当前+340/-0；目标+286/-0 |
| test/session/processor-effect.test.ts | modify | 真实接受片段与v2/旧事件一致性 | +54/-0 |
| test/cli/cmd/tui/session-message-render.test.tsx | modify | 既有fixture结算高亮后销毁、全局路径恢复 | +16/-2 |
| test/cli/tui/slot-replace.test.tsx | modify | 原slot断言后释放自己创建的renderer | +7/-3 |
| docs/plans/terminal-mermaid-latex.md（根） | modify | 单一完整设计、原文、历史裁决和新验收状态 | 整篇≤2000行 |

两个撤回测试路径在最终固定基线diff中为0。基线外产品路径合计16，另1份Plan。R22 本轮实际编辑是本 Plan 和 §16 批准的 hydration 重复测试删除；其余产品与测试字段保持已冻结 R21 字节。当前patch改动中的 index.js/index-b5dpwnes.js/Markdown声明须和实际发布core包对应，不把 node_modules 当交付源。

## 16. TDD Behavior Slices

| Order | Red behavior | Why baseline code before R1 fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 行内/显示公式与图仍显示源码 | 基线无math/rich/LaTeX接线 | 同native lexer扩展和闭合node | 代码、金额、容器、raw及未知语法 |
| 2 | v2同provider正文没有逐片Text.Delta | accepted-text位置缺发布 | 原lifecycle9行桥 | summary、预算、PartDelta、终值 |
| 3 | pending/静默HTTP清空live前缀或旧请求覆盖新页 | 直接reconcile整页 | 请求Set、消息来源权威 | 缺项、短终值、跨Session、排序/分页 |
| 4 | 两入口流式无富节点、完成/宽度变更重挂 | 基线实验分支有!streaming和key | 同实例native streaming+Yoga图节点 | 原code分支、预算、主题 |
| 5 | 原渲染fixture结束时原生资源未结算或renderer泄漏 | 基线finally直接destroy/slot未destroy | fixture先结算后释放 | 原mount及完整渲染断言 |

切片1的预期从固定字形/图形样例与原参考实现取得，不能以导入缺文件的异常冒充用户功能红测。已存在的R19/R21性能红绿用于证明删除中间重复工作；它们与原始基线功能缺口单列。

### 删除中间方案重复夹具的精确边界

对 `sync-v2-hydration.test.tsx` 的 `route effect does not subscribe to live message mutations` 已做同依赖、同测试的独立对照。只替换Provider为26061b5原文件，原HTTP计数断言通过，回包后正文从`prefix $x`变空才失败：0 pass/1 fail、3次expect、3.98秒。R21 Provider同例1 pass/0 fail、7次expect、2.90秒。Bun均1.3.14，直接运行子进程测试路径；没有外网调用。原始日志与输入hash在 `verification-archive/shared/pr6-r22-plan-history/hydration-probe/{baseline.log,candidate.log,result.json}`。

因此HTTP重复请求检查针对已撤回R14同步快照订阅问题；该例唯一原始基线红信号（hydrate覆盖prefix）已由`pending hydration keeps new live text and returned history`及`existing live prefix survives quiet pages until shorter server completion`两例直接覆盖。批准后删除整个`route effect…`测试块，从原第189行到后一个`Text.Ended received…`测试之前的空行，并删除仅此块使用的`createEffect, createSignal`导入，合计54行。删除其7个expect及Capture/effects/route专用接线，不迁移计数断言到其他用例，不加入替代helper或新测试。

保留已有pending、quiet-page、反序请求、Text.Ended、同ID权威终态、跨Session、排序/分页的8个内部用例与外层隔离runner，输入和断言逐字保持。隔离删除候选仅用于显示精确diff，SHA256 `39efce618c5b43534770e73ef92a54d637d153da54555c6cddb0242691429846`，原测试SHA256 `57a48266d79609bf2d369ba03e5bcc41fd06f8e9729b68f99dc9c26979366a0e`；差异文件 `proposed-test-simplification.diff`。此删除尚未实施到正式树，批准后运行完整原hydration文件验证8例、外层隔离和原退出合同。

数学/图形的字面源码和普通Markdown兼容断言与新增能力共享相同输入slice；不能用缺少适配器的导入错误代替原始基线功能红信号。已有原始功能/producer/hydrate证据与中间R19性能对照继续各记实际基线，独立审计核对完整26061b5→目标测试范围。

## 17. Comments

无配额。保留仅靠名称/类型看不出的原因：raw与字形分离、异步literal范围缓存边界、真正闭合与宽度恢复、HTTP终态优先、旧请求不能释放新身份、原生高亮清理顺序、上游许可/宽度适配。本revision不授权生产注释改写；§16删除测试时连同其专用注释一起移除。

历史E/C统计仅描述当时审计口径，不继续构成放行门禁或凑数目标。

## 18. Verification

包命令均在 `packages/opencode`，Bun1.3.14、与锁及patch精确对应的依赖图；heavy测试串行协调。现有真实素材和命令脚本继续复用。

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test --timeout 30000 test/cli/tui/math-markdown.test.ts test/cli/tui/rich-markdown.test.ts` | packages/opencode | 公式/图、原生frame、容器、宽度及字面内容 |
| `bun test --timeout 30000 test/cli/tui/sync-v2-hydration.test.tsx` | packages/opencode | HTTP/SSE真实store时序 |
| `bun test --timeout 30000 test/session/processor-effect.test.ts` | packages/opencode | accepted文本producer与原事件行为 |
| `bun test --timeout 30000 test/cli/tui/slot-replace.test.tsx` | packages/opencode | 原slot断言与释放 |
| 已保存pr6-r21-spacing-recheck.H9HEBk/run.sh原命令 | packages/opencode | session-message-render原101项及明确3项过滤 |
| `GOMAXPROCS=1 bun run typecheck --singleThreaded`（按执行负责人记录确切内存参数） | packages/opencode | 当前exact graph的真实类型结果 |
| 仓库原`.husky/pre-push`完整命令 | repo root由hook进入原package | 原质量门禁；不跳过或改写失败 |
| 固定loopback provider+真实应用PTY/Sky，沿已保存runner | 原独立fixture工作目录 | 两路、原文/终态、宽度、conceal、真实屏幕 |
| `git diff --check`与`git diff 26061b5 --numstat` | repo root | 排版、完整文件范围及实际行数 |
| 冻结恢复脚本，空目录Git/tree/SHA校验 | 独立空目录 | 无临时依赖的源码与证据恢复 |

原始反馈loop需覆盖早期shell、金额、公式、引用、未闭合围栏与完成收尾；可见推进、首屏、最终延迟、CPU、分词量各自报告。只复用输入/产品/依赖身份仍一致的证据，其余运行明确排队复验。外网审核及用户排除的notebook/Python资源项保持取消，不拆分成绕过路径。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 6 | 三个生产util与三个功能测试，均为固定基线新增 |
| Files modified | 10非Plan+1Plan | 两入口、水合、processor、三既有测试、package、lock、core patch |
| Files deleted | 0 | 中间无关改动回撤后与基线相同 |
| Production lines | 以§15完整raw diff及patch内实际JS另计 | LaTeX1535行含原样上游，不把patch上下文重复计为产品代码 |
| Test lines | 当前+912/-5，目标+858/-5 | 三新增文件与三既有文件，R22净删54；原始基线统一计量 |
| Generated lines | lock+3；patch是实际发布包补丁 | 没有生成SDK/迁移 |
| Plan | ≤2000行 | 全文含原始要求和原样审计历史 |

用户要求最小、必要、可读。预算不允许压缩单行、漏行为或把复制上游内容隐藏为零。R21三个专项测试“新增有效140”仅是相对R19的历史增量口径，不等于本表全PR行数。

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

当前没有新增产品选择。原始能力、范围、最新流程和离线优先已有明确要求。门禁失败继续按可执行证据任务处理。

### Follow-up

| Concern | Evidence | Baseline behavior | Raised in round |
| --- | --- | --- | --- |
| 宿主/tmp/.git影响external-directory用例 | 原R16隔离记录 | 同一宿主原基线也有问题，非图/式责任 | R16→R21回撤 |
| session-integration旧tokenAccounting内部断言 | 原集成失败与当前基线内容 | 固定基线同样存在，正式文件回撤 | R16→R21回撤 |
| 远端macOS/Windows或外网资源不可用 | 原失败、审核拒绝与用户取消原文 | 平台/资源可用性不由本渲染实现创建 | R17 |

这些条目保留真实状态，不扩大本功能实现；当前仓库硬gate仍由其规则判定，不能因为记入Follow-up就伪记为绿。

### Rejected Speculation

不加入另一解析器、全局永久公式缓存、按空行切块、无依据小容量报错、渲染重试或新权限层。未观测输入不得驱动产品扩编。CPU不宣称一致下降，Windows未实机的结论不从Linux截图推出。

## 21. Audit Contract

独立审计读取本exact revision、§1原话、固定26061b5→全部最终文件/测试和0dff版本流程。方案审计覆盖完整目标设计、实际路径、双向映射及§16尚需核证的原始基线敏感性；不得把旧R21增量裁决代替全任务设计批准。

独立审计员自行读取审计专属材料。handoff仅含原始需求、Plan路径、repo root、Audit mode: plan。R22尚未收到裁决，Implementation allowed=no。

后续轮次复用审计任务并保留完整scope，按新policy记录Revision Delta、此前blocker与真实新增差异；正常质量门禁结果按实际覆盖范围使用。APPROVE只更新行政字段，不夹带产品改动。实现审计再核对全部实际hunk、原反馈、测试和撤回路径；最终仍需正常hook和持久化验收。

## 22. Revision Delta and Plan Audit Record

历史审计裁决在下文逐字保留；旧基线、旧注释门禁和旧轮次状态属于当时记录，当前放行只认R22的新裁决。

| Revision | Sections changed | Prior findings and resolution | Invariants, states, concepts, or files added or removed |
| --- | --- | --- | --- |
| R2 | 旧实现迭代 | 冻结材料未保存该revision独立delta | 不补造设计；最终保留行为见§5–16 |
| R3 | 旧实现迭代 | 同上，原四提交链可核对 | 最终保留行为见§5–16 |
| R4 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R5 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R6 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R7 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R8 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R9 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R10 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R11 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R12 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R13 | 旧实现迭代 | 同上 | 最终保留行为见§5–16 |
| R14 | 旧§1–24 | hydrate请求前prefix丢失/响应依赖阻塞 | 引入水合验证范围 |
| R15 | 原hydrate设计 | 处理两个已记录blocker | 活动前缀/请求隔离；旧方案内容现由§10最终设计替换 |
| R16 | fixture/验证 | 宿主目录fixture修正 | 无关external-directory改动后来回撤 |
| R17 | 验收合同 | 用户停止指定外网验收，原失败保留 | 产品行为不变 |
| R18 | 全PR注释/单提交 | 当时注释配额及全PR审计 | 后续新版取消配额，历史记录保留 |
| R19 | 普通长回复投影 | 无数学标记时跳过prepareMath的中间方案 | 该短路和全量投影现全部退出产品 |
| R20 | 原生路径设计 | 窄宽/实例重建问题经隔离probe修订 | 转向native lexer、字面range、ID集合 |
| R21 | 原§41–46 | 补全width恢复、金额/引用A/B及测试接线收敛 | 当前目标产品字节，未以此替代R1前基线 |
| R22 | 全24节 | 固定26061b5、完整目标、流程出处、结构化历史/Follow-up、原始基线对照 | 文档重组；规划删除54行中间专用重复测试，生产/锁不变，旧批准清空 |

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 历史各轮 | R14–R21 | 按下列原文 | 原样保留 | 原样保留 | 见原文 | 原裁决中的invocation |
| 本次待审 | R22 | yes，固定26061b5→完整目标 | 待独立审计 | 待独立审计 | pending | root派发 |

### 历史方案裁决原文（转录）

````text
## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R14-recovery | yes | B-01请求前前缀丢失；B-02响应式依赖触发额外hydrate | 路径清单、测试注释计数、验收门禁 | BLOCK | /root/adversarial_auditor |
| 2 | R15-recovery | yes | No blocking findings | HEAD基线、日志revision、正式E/C与排版 | APPROVE | /root/adversarial_auditor |
| 3 | R16-recovery | yes | No blocking findings | E/C与行数按最终diff复算；保留旧结果并追加R16验证 | APPROVE | /root/adversarial_auditor |

旧R8有历史批准报告，缺原文和exact资产，本次不继承 approval。独立 verdict 必须逐字记录。

### R14 独立审计原文

````markdown
## Blocking findings

### B-01 请求开始前的实时前缀仍会被历史回包清除

- **Violated invariant:** INV-03，流式正文在 hydrate 后保持可见，并收敛到完成终值。
- **Evidence class:** observed。
- **Producer and execution path:** 新增 `Text.Delta` 发布 → `SyncProviderV2` 保存实时前缀 → 进入或重新进入 v2 页面触发 hydrate → 服务端返回仍未持久化 delta 的消息。
- **Source evidence:** `packages/opencode/src/session/projectors-next.ts:169` 对 `Text.Delta` 不更新持久投影；`packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:72–74` 触发同步；隔离候选 `owner-candidate.txt:297–304` 只保留请求期间变化的消息。
- **Canonical-plan evidence:** §10、§14、§16 第2/3片。
- **Responsibility owner:** `SyncProviderV2.session.message.sync`。
- **Concrete behavioral consequence:** 请求开始前已经显示的公式前缀，在请求期间没有新事件时被空正文覆盖。独立运行真实 provider 隔离实验得到：

```json
{"before":"prefix $x","after":""}
```

实验顺序为 Started → Delta → 开始 hydrate → 返回同消息的未完成空正文，使用仓库现有事件投影可产生的状态。本轮新增 delta 发布会使这一正文丢失路径直接影响正常流式显示。

- **Minimal correction direction:** 在同一同步 owner 内保护尚未由持久终态承接的实时正文，补上“前缀早于请求、请求期间无事件”的公共行为测试，同时保留完成终值和权威分页行为。

### B-02 快照读取改变生产 createEffect 的依赖，触发额外 hydrate

- **Violated invariant:** INV-03；同步读取不能让消息更新反向触发新的历史加载并撤销实时显示。
- **Evidence class:** observed。
- **Producer and execution path:** 生产 `View.createEffect` 调用 `sync` → 候选在第一次 `await` 前读取响应式消息数组 → 新消息或历史合并触发 effect → 再次请求历史。
- **Source evidence:** `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx:72–74`；隔离候选 `owner-candidate.txt:297`。HEAD 的 `sync-v2.tsx:292–295` 在第一次 `await` 前没有这次 store 读取。
- **Canonical-plan evidence:** §10 的请求快照设计；§16 的 hydrate 测试未经过生产调用方式。
- **Responsibility owner:** `SyncProviderV2` 的快照读取与调用边界。
- **Concrete behavioral consequence:** 用真实 provider 复刻生产 `createEffect(() => sync(...))` 后，历史回包触发第三次请求，额外回包随后清除刚保留的前缀：

```json
{
  "requestsBeforeResponse": 2,
  "requestsAfterResponse": 3,
  "prefixAfterFirstResponse": "prefix $x",
  "prefixAfterExtraResponse": ""
}
```

现有9例直接调用 `sync`，全部通过，但没有覆盖该响应式调用链。

- **Minimal correction direction:** 让快照读取脱离调用者的响应式依赖收集，并通过生产等价 effect 验证消息更新和回包不会自行启动 hydrate。

## Non-blocking findings

- §11 应补录 hydrate 的期间更新合并、过期请求丢弃和权威分页路径。它们在正文已有设计，属于同步主路径，当前没有新增诊断分支。
- §17 已承诺实际15%中文注释门禁；最终计算须包含新增测试，隔离候选中的压缩排版和 `any` 不能直接进入正式实现。
- 真实截图、完整测试和外部授权阻碍已明确保留为实施验收门禁，本次未将其视为已经通过。

## Rejected speculation

- DSH 固定版本资料确有公式4096、Mermaid20000的源码边界。本次不沿用早期仅凭较小阈值判定缺陷的结论。
- 不要求新增图片、第二渲染器、全局事件账本或服务端协议扩展。
- 不以未测负载推断要求另建缓存；已核查的缺口来自具体时序和响应式依赖。

## Requirement and traceability coverage

审计对象为 **R14-recovery**，基线为 `03060e4c859965521959a7a91dd5aba6aadc55ca`。

已重新读取当前审计 skill、policy、合同、Workflow、模板、适用仓库指令、领域文档、ADR、恢复的 TDD 文档和 DSH 参考源码，并核查计划全部修改区域及直接调用链。

- Mermaid/公式、图片排除、共享适配器和既有 patch 保留有对应源码与回归路径。
- producer 补发 delta 位于现有预算判断之后，与 Started/Ended 条件一致。
- fixture 清理和淘汰内部名称断言有对应失败记录及现有公共行为覆盖。
- hydrate 的9个现有隔离用例由本次审计独立重跑，结果 **9 pass / 0 fail**；上述两项独立时序实验仍暴露缺口。
- 单提交、真实屏幕、完整检查及持久交付保留在终态要求中。

## Primary-path and fallback verdict

producer 与 fixture 的责任位置有依据。hydrate 继续由单一 provider 管理，方向符合职责边界；当前快照判定及响应式读取尚未满足实时正文保持要求。

## Release verdict

**BLOCK**

R14-recovery 保持 `Implementation allowed: no`。修订同一 canonical plan 后，按完整原始范围重新审计。
````

### R15 独立审计原文

````markdown
## Blocking findings

No blocking findings.

R14 两项阻塞在 R15-recovery 中已解决：

- **B-01**：未完成 assistant 的实时正文保留到同 ID 的服务端完成终值承接。请求前已有前缀、请求期间无事件、回包缺失活动消息，以及更短完成终值均有行为验证。
- **B-02**：首次快照的整段 store 读取置于 `untrack` 中。生产等价 `createEffect` 验证显示，消息更新和 hydrate 回包不再触发额外请求，路由变化仍触发同步。

## Non-blocking findings

- §16 第3a/3b片的缺陷说明仍引用 R14。正式 TDD 日志应以 HEAD `03060e4c` 为基线，R14 结果保留为规划实验记录。本次独立运行已确认新测试也能捕获 HEAD 的正文丢失。
- §18 的旧9例和 R15 的12例使用同一测试路径。历史结果已有版本说明；后续记录应继续附准确 revision，避免将旧命令对应到当前文件内容。
- 正式实现继续执行 §17 的15%中文注释要求，覆盖生产与新增、修改测试；隔离实验中的 `any`、压缩排版和固定等待写法不作为正式代码范例。

## Rejected speculation

- 不要求增加事件账本、第二数据源、服务器水位协议或新的渲染引擎。
- DSH 固定版本具有同样的源码长度边界，保留当前边界有参考合同依据。
- 原生截图、完整包测试、构建和持久恢复仍是实施验收项；已记录的环境阻碍不改变这些终态要求。

## Requirement and traceability coverage

本轮审计覆盖 **R15-recovery 的完整原始范围**，包括既有渲染路径、两个消费入口、processor 事件发布、hydrate、测试生命周期、淘汰断言及交付验证。

重新加载当前审计 skill 与 policy，并结合本线程已直接读取的合同、Workflow、模板、仓库指令、领域文档、ADR、TDD 文档和 DSH 固定版本源码核查：

- Mermaid/公式继续复用现有适配器、依赖与 OpenTUI patch。
- `Text.Delta` 在预算接受片段后发布，沿用既有 summary/flag 条件。
- hydrate 保持一个同步 owner，兼顾实时正文、完成终值、请求顺序、首50条分页和稳定排序。
- fixture 修复归属各自生命周期，保留原行为断言。
- 新概念均有实际缺口、所属文件和公共行为测试映射。

本次独立运行同一组12例：

| 被测版本 | 结果 |
|---|---|
| 当前 HEAD | 4 pass / 8 fail |
| R15 隔离候选 | 12 pass / 0 fail，28次断言 |

## Primary-path and fallback verdict

R15 在事件首次遗漏处和历史同步 owner 内修复问题。活动正文保留、完成终值承接、期间变化合并及过期请求丢弃共同组成一条同步路径，没有失败后另试算法或新增诊断生产分支。

`untrack` 解除调用者依赖，`unwrap` 支持值快照，两者职责明确。方案保留现有分页和完成态收敛行为。

## Release verdict

**APPROVE**

仅批准 **R15-recovery**。可原样记录本裁决并更新该版本的行政审批字段；正式实施、完整验收和独立实现审计按批准方案继续。
````

### R16 独立审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

- §17 的 E/C 与 §19 行数继续作为估算。正式实现审计须按 HEAD 到最终 diff 重算，包含新增 hydrate 测试及三个 fixture 修改。
- §23 保留的 runtime 19 项失败、integration 中断和 R15 验收记录，应分别保留原始结果，再追加 R16 完整验证结果。

## Rejected speculation

- 不要求修改 Project 发现逻辑、containsPath、权限规则或 `/tmp/.git` 挂载。已定位的首次分歧在测试输入。
- 不要求加入图片子进程环境补丁。图片原用例本轮通过，R16 保持其源码与断言。
- 不要求扩充公式引擎、图片能力、配置或 OpenTUI fork。
- 不将最终全片、目标平台与持久化验收提前充当方案批准条件；这些仍是实现交付门禁。

## Requirement and traceability coverage

本轮按完整原始需求审计 **R16-recovery**，基线为 `03060e4c859965521959a7a91dd5aba6aadc55ca`。

- **Mermaid、LaTeX 与普通 Markdown**：保留两页共同适配器及既有 OpenTUI patch。原始渲染日志为 57 pass、0 fail、154 个断言，覆盖语法、流式、嵌套与宽度恢复；真实完整应用双入口截图继续列入验收。
- **事件 producer**：补发 Text.Delta 的位置位于累计输出预算检查之后，保持 Started/Ended 的 summary 与实验开关条件；旧 PartDelta、metadata 和终值路径保持。
- **hydrate owner**：请求序号、请求期间变化合并、未完成正文保留、持久 completed 承接、首 50 条分页及排序均归 SyncProviderV2。已读取 12 例候选原始结果，12 pass、0 fail；请求前前缀与 createEffect 依赖两项既有 blocker 已有对应行为覆盖。
- **renderer 生命周期**：slot 调用者释放 renderer；共享 fixture 排干子树高亮任务后销毁。原断言保留，淘汰的 tokenAccounting 名称断言由现有公共行为覆盖承接。
- **R16 三个外部目录 fixture**：已核对原测试、候选、Project 祖先发现、containsPath、权限调用及标准实例 fixture。固定 `/tmp/project` 与 `/tmp/outside` 被同一祖先 worktree 包含，导致三个 permission 请求缺失。候选复用 `it.instance` 与 `TestInstance.directory`，保持非 Git 语义、原请求断言及 Windows 归一化，未新增测试注册。
- **红绿证据**：同一完整 external-directory 文件，原始结果 3 pass、3 fail；标准实例候选 6 pass、0 fail、11 个断言。干净 TMPDIR 的环境前提已明确写入计划。
- **交付范围**：完整 runtime、integration、TUI、类型检查、构建、真实屏幕截图、最新基线及持久恢复验证仍保留，未由窄测替代。

正向需求映射及反向概念归属完整。中文注释承诺保持 `C >= max(1, ceil(E × 0.15))`。

## Primary-path and fallback verdict

生产修复保持唯一事件与同步路径；新增 fixture 复用现有实例生命周期 owner。新增备用成功路径为 0，新增生产诊断路径为 0。

三个 fixture 的修改修复测试输入边界，权限判定与请求输出继续由原生产实现执行。

## Release verdict

**APPROVE**

批准 exact revision **R16-recovery**。可原样记录本裁决并设置：

```text
Status: approved
Revision: R16-recovery
Approved revision: R16-recovery
Implementation allowed: yes
```

随后按该 revision 实施，并对 HEAD 到最终全部实际 diff 进行独立实现审计。

## 26. R17 Independent Plan Audit

以下为本轮独立 auditor 完整裁决原文。已按非阻塞项同步 §13、§19、§20 的过程记录；生产设计保持 R17 原文。§25 的送审叙述保留为本轮历史，当前批准状态以页首和本节为准。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §13 仍列“原 runtime 全片”，应标注按 §25 用户更新取消执行；§19“尚无 R16 测试改动”和 §20“正在处理外部授权”也应同步为当前状态。§24、§25 已明确实际范围与结果，这些属于记录修正。
- 最终清单分别保留历史失败、审核中断、用户取消执行和已通过项目，完整分片通过栏保持空白。

## Rejected speculation

- 不要求继续执行用户已取消的外网测试，也不要求拆片、替换网络或伪造响应。
- 不据外网验收取消扩展生产补丁、修改权限或放宽断言。
- 不要求重做仍与最终源码一致的既有验证；复用时核对源码哈希及实际覆盖范围。

## Requirement and traceability coverage

本轮按全部原始需求及 §1 新增用户原话，审计 **R17-recovery**。

- Mermaid、LaTeX、普通 Markdown、双入口、流式及宽度恢复继续由现有适配器和 OpenTUI patch 承载。
- Text.Delta 在预算检查后发布；hydrate 的请求归属、非响应式快照、实时正文保护、完成终值承接及分页顺序保持原设计。
- renderer 清理、淘汰内部名称断言、三个外部目录 fixture 均保持已审 owner、测试切片及原行为断言。
- 已读取当前生产 diff、external-directory diff，以及 runtime 拒绝原文和请求核查。R17 的新增调整限定于验收合同，未增加产品行为。
- §25 明确停止已被拒的 runtime/integration 外网路径，保留历史记录；离线验证、类型检查、完整构建、真实应用截图、最新基线、独立实现审计及持久恢复继续执行。
- 当前八个生产/测试文件仍与需求和不变量对应，中文注释要求保持至少 15%。实际 E/C 留待完整实现审计逐 hunk 核算。

## Primary-path and fallback verdict

生产路径及责任归属保持 R16 设计。新增备用成功路径为 0，新增生产诊断路径为 0。

取消指定验收项按用户原话记录，不改变产品成功或失败语义。

## Release verdict

**APPROVE**

批准 exact revision **R17-recovery**。可原样记录本裁决并设置：

```text
Status: approved
Revision: R17-recovery
Approved revision: R17-recovery
Implementation allowed: yes
```

随后按更新后的验收合同完成核验，对 HEAD 到最终全部实际 diff 发起独立实现审计。


## 32. R18 Independent Plan Audit

## Blocking findings

No blocking findings.

## Non-blocking findings

- 开篇仍以 R17 作为当前叙述，应更新为 R18，并明确当前本地 HEAD 为 `bd2bdbd2f13f9bcacff24ecfe9d588ccc1045a77`；原 PR HEAD `03060e4c` 保留为需求与历史实施起点。
- §30“完整裁决收到后原样附录”可改为指向已存在的 §31。

## Rejected speculation

- 不要求为补注释增加产品行为、修改依赖、重排代码或增加测试实例。
- 不要求重新制造已验证行为的红测。注释返工以执行代码同一性、既有回归和完整实现复审验证。
- 120行是写作预算；合格数量仍按每条解释的实际内容核算。

## Requirement and traceability coverage

本轮完整审计 **R18-recovery**，覆盖原始 Mermaid/LaTeX 需求、双入口渲染与同步、测试生命周期、真实截图、整条 PR 注释门禁和单提交交付。

已核对：

- 当前工作区仅修改 canonical Plan。
- 全部17个非Plan文件与上一轮整条PR审计对象逐字相同。
- 六个拟编辑文件与具体解释位置明确，分别对应解析边界、Markdown投影、宽度与生命周期、测试输入和断言意图。
- 方案保持行为、接口、依赖、patch、常量、默认超时、断言及测试数量。
- 全PR预计 E=1,139，C从67增至约187，承诺达到至少171行合格解释。
- 验证包括去注释转译结果比较、非编辑文件哈希、原渲染测试、完整TUI分片、类型检查及真实hook。
- 最终实现审计继续覆盖目标分支到最终树的全部内容；单提交在审计批准后创建，旧提交保留，恢复包验证父节点、tree和文件身份。

既有行为验证及真实构建截图的复用以执行代码同一性为前提，方案对此设置了明确检查。

## Primary-path and fallback verdict

R18 保持既有解析、投影、字符布局、事件发布和同步路径，仅补邻近解释。

新增产品概念、备用成功路径及生产诊断分支均为 **0**。

## Release verdict

**APPROVE**

批准 **R18-recovery 方案**。可原样记录裁决并设置：

- `Status: approved`
- `Approved revision: R18-recovery`
- `Implementation allowed: yes`

上一轮整条PR实现审计的 **B-01** 继续开放，待注释返工及完整实现复审通过后关闭。

## 38. R19 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

R19 性能命令使用新样本名 `C2`；现有汇总脚本应纳入该样本名，或用逐样本数据计算中位数。原始逐样本记录足以核验，结果口径不受影响。

## Rejected speculation

- 无须改动 v1/v2 渲染路由、终端预算、依赖或 Hydrate；同一渲染器的差分实验已定位公式预处理的额外成本。
- 无须新增仓库测试。现有渲染用例与临时真实应用回放分别验证功能和性能。
- 不把早期实验中一次 450 毫秒内未稳定的宽屏帧判为正式修订回归；R19 已规定如何验证宽度恢复。

## Requirement and traceability coverage

完整审计 R19，包括 §1 原始需求及三条续办原话、原 Mermaid/LaTeX 行为、§37 性能修复。当前 HEAD `571db6d`，工作树仅修改 canonical Plan。

已核对 v1/v2 在预算内进入共享 `prepareMath`，其输出继续交给原 OpenTUI 渲染器；公式扩展入口、引用定义候选、CRLF/CR 正规化和围栏渲染职责均有源码依据。重新汇总原始时序，长样本正文推进间隔 P95 中位数为目标分支 `108.4 ms`、当前头 `318.6 ms`；同渲染器的归因实验为 `329.4 → 75.2 ms`。独立复跑八个实际 OpenTUI 双模式兼容场景全部匹配，另对 1,587 个不含候选标记的普通 Markdown 组合核对投影字节，无差异。这些结果支持方案预判；R19 实际实现仍须完成正式性能、缩放及渲染回归验收。

## Primary-path and fallback verdict

修复落在 `prepareMath`。无候选标记时保留既有换行语义并直通，存在公式或引用定义候选时保留原投影；两支都进入原渲染器。`]:` 分支有重复引用定义实际显示差异支撑，没有新增解析器或失败后备用路径。单文件修改、测试净增零，方案的中文注释估算能满足实施门槛。

## Release verdict

**APPROVE**

批准精确 **R19** 方案，允许记录裁决后按该 revision 实施。

| 轮次 | 审计 revision | 全原始范围 | Blocking | 非 blocker | 结果 | Invocation |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | R21 | 是 | No blocking findings | 有，见裁决原文 | APPROVE | adversarial-auditor |

## Blocking findings

No blocking findings.

## Non-blocking findings

§41.9 的待审占位按流程替换成本次裁决。隔离样机验证方案关键假设；两条真实 Session 路由、端到端 A/B 和原生截图仍按 §41.5–41.8 在实施阶段验收。

## Rejected speculation

不要求第二套解析器、全局公式缓存、永久水合版本表或新增正式测试用例。引用定义实际变化时，只按受影响的语义边界失效。

## Requirement and traceability coverage

- §41.4(1–2)：公式接入原生 Markdown 增量分词，保留稳定前缀、原始文本和普通高亮。现有回放提供全量投影与后缀处理的对照，阶段验收用真实 SSE/PTY 对比显示推进时间。
- §41.4(3)：R20 的 B-01 已解决。两条路由改用同一 Markdown 实例接收宽度、流式状态和正文。闭合有效围栏即使初始过窄也保留一次布局结果，依据实际父布局原地切换源码和图形。独立核对的 Mermaid 对照在两种块模式均通过 11→80→11→80，图形、稳定前缀节点身份不变，每模式布局一次。长分式对照在两种块模式均通过 12→32，完整往返已列入现有测试的实施验收。
- §41.4(4)：变化集合归属在途 HTTP 请求；服务端已完成 Assistant 优先，即使本地同一消息已收到完成事件。已有水合复现移除了补偿终态事件，隔离对照由 8/9 转为 9/9。
- §41.4(5)：复用 OpenTUI 自带的 Marked，保留固定来源、MIT 许可和宽度适配的 LaTeX 单文件，撤回两份无关测试差异，保留 v2 正文事件链路。

## Primary-path and fallback verdict

原生增量 Markdown 是唯一主路径。既有源码展示继续覆盖未闭合、无法渲染和宽度不足的围栏；宽度恢复复用同一节点的布局结果。

## Release verdict

**APPROVE**。仅放行 R21，SHA256 `dbe5016da0c63a5fffab17fc5073cd0875224e0a36441956faa3f259d010e27d`，基线树 `71b84f3308c060c69b5ad6191e21ae1dced49bf8`。

R21 实施证据和实现审计记录在后续批准实施完成后填写。


````

### R22 独立方案审计裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

当前工作树另有 `packages/console/app/public/email` 的未暂存删除，未列入 R22 文件计划。实施与发布清单应继续排除该项，保持无关工作区内容原状。

## Follow-up

按 §16 删除指定 54 行后，运行完整 hydration 文件，核对保留的 8 个内部用例及外层隔离 runner。随后按 §18 完成最终差分、正常 hook、独立实现审计和持久化验收。

## Rejected speculation

- 不为已撤回的中间方案保留专用测试或追加替代接线。
- 不要求扩大解析器、缓存、兼容分支或测试数量。
- 不要求重跑用户明确取消的外网资源测试。

## Requirement and traceability coverage

本轮完整审计 **R22**，以 `26061b595b3140d37717248222c7ed2016421db0` 为原始基线，按 dev1-smark `0dfffcda` 的最新流程核对完整目标。

已核对：

- 原始 Mermaid/LaTeX、真实终端截图、OpenTUI 原生增量渲染、rebase、Gate、最小修改及单提交交付要求。
- 原生 lexer、公式字面范围、围栏闭合与宽度恢复、普通 Markdown 节点复用、双 Session 入口、预算后的 Text.Delta 发布和 v2 水合时序。
- 全部 16 个产品及测试文件的 SHA256，与冻结候选逐项一致。
- R22 删除测试的隔离差异恰为 54 行。原始基线在 HTTP 计数断言通过后，于前缀保留断言失败；该原始缺口已有另外两项保留用例覆盖。删除对象针对中间方案的重复接线，保留用例输入与断言保持原样。
- 原 Gate 日志记录 14/14 成功、零缓存及两个子模块 tip 校验；金额与引用定义的追加 A/B 保留完整逐轮结果、异常观测和源锁差异说明。
- 方案共 1,612 行，当前 SHA256 为 `a6e03508f771e13778e7fbef0fc7e16f6713d64540ac77b1c39437f3294a2cab`。

## Primary-path and fallback verdict

方案把数学扩展接入 OpenTUI 原生增量分词与渲染链；普通内容沿原路径处理。引用失效、异步字面范围和水合终态分别由其现有责任模块承载。旧全量投影、重复解析依赖及无关测试修改有明确撤回决定。

R22 新增生产行为、备用成功路径和生产诊断分支均为 0。

## Release verdict

**APPROVE**

批准精确 **R22 方案**。可原样记录裁决并设置：

```text
Status: approved
Approved revision: R22
Implementation allowed: yes
```

按批准范围实施后，对固定原始基线到最终树的全部实际差分开展独立实现审计。

## 23. Implementation Evidence

### R22 批准后的实际实施与回归

释放旧tmp副本约175MiB后，原成功目录同参数第三次完整Gate仍在opencode类型检查SIGKILL：10/14任务通过、零缓存、1m57.52s、exit1。两秒采样确认实际GOMEMLIMIT=900MiB、GOGC=10、GOMAXPROCS=1；末次tsgo RSS为2,066,316KiB，完整子进程maxrss为2,068,924KiB，当时宿主MemAvailable约1.45GiB。证据为`gate-after-ram-release.log`、`retry-process-samples.jsonl`和`retry-result.json`。进程已退出，停止同条件重复，先交还其他PR的重负载窗口并继续内存/进程限制归因；当前R22完整Gate仍待通过。

R22最新Gate实测：独立staging原hook在opencode类型检查遭SIGKILL，exit1，6/14任务通过、零缓存、1m12.61s；随后在R21曾成功的原验收树`verification-archive/tmp/pr6-r21-rebase.bPGgR9`先备份原Plan/测试，再仅原子导入这两文件。导入前index tree为`b8f5d009819015389685a66ed83a72098ebca742`，包含R22两文件的临时index tree为`02a05bdb2f227142bb005438cbc2a1a6ab5ace1d`（该tree含本段加入前的Plan）。原树完整hook再次在opencode类型检查SIGKILL，exit1、1m14.318s；两次均使用GOMAXPROCS=1、GOMEMLIMIT=900MiB、GOGC=10、Turbo串行且force。日志分别为`gate-staging-sigkill.log`和`gate-original-tree.log`，旧R21成功回执保持。当前R22重型Gate尚未通过，继续资源/执行环境核证后重跑，不能沿用R21绿态。

批准版本为R22，批准记录时Plan SHA256为`48d215a1df2576a3cbdba71c2235d4c3a7c9ca034e0937ceef6fe473ab6ad2c9`。在独立`verification-archive/tmp/pr6-r22-plan-stage`用独立临时文件加原子替换实施§16的54行删除；其余8个内部用例、22个断言及外层隔离runner逐字保持。测试文件最终SHA256为`39efce618c5b43534770e73ef92a54d637d153da54555c6cddb0242691429846`，原R21源树文件仍为`57a48266d79609bf2d369ba03e5bcc41fd06f8e9729b68f99dc9c26979366a0e`。本轮生产、锁、其他测试字节保持冻结目标；新增产品行为为0，移除专用Capture/effects/route接线和唯一Solid导入。

验证工作目录为该独立树的`packages/opencode`，Bun1.3.14。完整`bun test --timeout 30000 test/cli/tui/sync-v2-hydration.test.tsx`通过外层隔离runner，1 pass/0 fail、1 expect、8.53秒、exit0；同命令加`OPENCODE_HYDRATION_TEST_CHILD=1`直接复核全部8例，8 pass/0 fail、22 expect、2.48秒、exit0。pending/quiet-page两项原始前缀合同、反序请求、Text.Ended、同ID完成态、跨Session、同时间排序及权威分页均通过。原红绿对照继续引用§16的同依赖基线与候选日志，本轮只删除批准的冗余夹具。

日志位于`verification-archive/shared/pr6-r22-implementation-evidence/hydration-outer.log`与`hydration-inner.log`，对应`.exit`均为0。完整固定26061b5到当前目标的17路径diff保存在同目录`full-approved-scope.diff`；原staging额外显示的`packages/console/app/public/email`缺失为既有副本状态，保持原样并明确排除出本GOAL路径。独立实现审计尚待执行，R22最终重型gate与恢复包也待主线程协调编译窗口后完成，当前状态保持implementation-audit-required。

### Actual Files and Diff

R22文档staging的产品快照来自 `verification-archive/tmp/pr6-r21-rebase.bPGgR9`。HEAD `7e87066f7fc729a0ea99f462aaad596b722f3b64` 的父为26061b5；R21工作区产品差异由原index与逐路径字节固定，详见 `verification-archive/shared/pr6-r22-plan-history/frozen-target-full.patch`。该patch含旧Plan，仅用作历史快照；本轮新的唯一Plan在当前repo。§16拟删54行尚未应用到本repo或正式树。

当前完整产品文件清单及raw diff见§15。R22未改正式产品/测试/锁文件，未安装依赖或创建提交；在独立副本完成§16两次窄例对照。对原gate源树只读；本staging的产品文件用于独立检查，不能在其中直接编辑共享硬链接inode。

### Red-Green Test Evidence

下列原样证据保留其实际版本，不改写为26061b5统一红绿。正式接手时先核证源码/测试/依赖hash，再将可复用材料绑定到当前候选；原始基线assertion敏感性仍按§16完成。历史样机、真实组件、完整应用及真实屏幕四种证据不互相替代。

### Verification Commands and Results

当前产品图 `b8f5d009` 的原 dev-smark gate 已实际退出0：14/14类型任务成功、零缓存，耗时2m46.625s，双gitlink均通过tip核对。完整日志 `verification-archive/shared/pr6-r21-rebase-gate-evidence/gate-success.log` 的SHA256为 `5e44ec8617006f97ede3a0767789e47d3b52593199f92f387c00ba35f552258e`；`gate-exact-graph-result.json` 的SHA256为 `8c401fa40b52ed9bbfe1a23e5ddf4bba95e1db22030fc8bf8e02a8f5bfd681e1`，记录exit0、maxrss2372192。早前SIGKILL失败保留，已由这次精确产品图的成功执行补齐。R22改写Plan后，旧gate的产品/依赖验证按字节同一性继承；新文档的方案/实现审计与最终行政状态仍须完成，不能沿用旧终态标记。外网原取消项继续按§1执行。

### Original Feedback-Loop Result

R19→R21共40个计划SSE/PTY样本，另1个引用v1额外观察，金额/引用新增16轮包含于40。稳定推进与最终延迟改善、首屏和CPU逐项保留；额外只终态可见样本不纳入等样本P95。它们验证中间实现退化已收敛，不代替本轮产品基线的完整功能合同。

### Actual Secondary and Replacement Path Inventory

当前目标源码与§11一致：原生single lexer、literal math、闭合rich、实际宽度、原预算源码分支和请求Set。全量prepareMath、全局转义掩码、两次JSON快照、整包pi-tui/Marked18以及两处无关测试差异已经退出目标字节；发布前再核对完整diff。

### Remaining Unverified Items

- R22 exact revision独立方案审计，以及批准后完整实现审计。
- 批准后仅应用§16明确的54行删除，运行完整hydration测试文件及其隔离runner，并按实际测试diff完成实现审计与最终gate；其余测试保持原样。
- R22新Plan的审批及最终行政终态；产品图b8f5d009的精确依赖gate已成功，后续若产品、测试或依赖改变则重验对应门禁。
- 最终产品快照与既有运行物/截图hash对齐，变化的责任链实际复验。
- 最终单commit父/tree、正常hook、远端最新base、持久化和空目录恢复；本轮未合并。

### 已冻结历史实施证据原文

以下逐字转录原R21文档的实施证据段，作为其版本的原始账本。历史文字中的“最终/通过/待验收”只适用于该段明确的版本；R22当前状态以上述开放清单为准。

````text
## 23. Implementation Evidence

本节保存获批R15已经产生的实施与验收历史。R16经§22独立批准后已实施新增fixture，首次正式红绿结果追加如下；全片、类型检查和最终实现审计继续逐项记录。

R16正式红测：同HEAD的external-directory.test.ts，在packages/opencode、Bun1.3.14及获准干净TMPDIR下3pass/3fail/6断言，4.42秒，exit1。按获批候选实施三处it.instance后，同一完整文件6pass/0fail/11断言，3.06秒，exit0。命令为`TMPDIR=/home/agent/pr6-test-tmp bun test --timeout 30000 test/tool/external-directory.test.ts`，日志在`pr6-r16-implementation-evidence/external-{red,green}.log/.exit`。原read.test.ts保持HEAD字节，integration保持原拒绝状态。

### Actual Files and Diff

R15正式实施已写入§15列出的两生产、五测试文件；当前HEAD增量为生产+49/-2，测试+409/-9，共7文件+458/-11，另有本Plan。没有新增依赖、设置、生成文件或渲染器改动。新hydrate测试332行，高于最初210至290行估计；差额来自子进程隔离、明确类型和15%解释注释，行为仍按批准slice，未压缩排版。

具体来源：pr6-implementation-evidence/producer-fixture-accounting.{md,diff,sha256}，pr6-hydrate-implementation/REPORT.md及最终hash。正式源码hash在final-check-start.sha256，typecheck结束后重新校验一致。

### Red-Green Test Evidence

规划期原渲染基线57pass；hydrate旧9例HEAD4pass5fail、R14全绿，独立审计新增时序揭示两项blocker；最终12例R14为9pass3fail，R15为12pass0fail28断言。真实producer精确片段HEAD红、隔离8行候选绿；slot原两文件103pass/2fail，单独清理两次132，完整生命周期候选105pass/0fail；过期源码断言34pass/1fail，公开accounting8pass；当前HEAD全配置typecheck exit0。截至上述规划实验记录时，正式TDD实施尚未开始；批准后的正式红绿记录列于下表。

以上为保留的规划阶段记录。批准后正式TDD已完成：

| Slice | 正式red | 最小批准修改后的green | 日志 |
| --- | --- | --- | --- |
| producer两通道增量 | HEAD v2片段为空，0pass/1fail | 1pass/0fail/4断言 | pr6-implementation-evidence/producer-{red,green}.log |
| hydrate前缀+历史 | HEAD前缀变undefined | 同公开provider用例通过 | pr6-hydrate-implementation/01-* |
| hydrate请求归属 | 当前值相同的新回包完成后，旧回包倒序回退 | 请求世代修正后通过 | pr6-hydrate-implementation/02-* |
| hydrate请求前未持久前缀 | 安静请求回包清除已显示前缀 | 活动assistant保留后通过 | pr6-hydrate-implementation/03-* |
| 生产等价effect | store写入触发第二次请求 | untrack后仅路由变化触发新请求 | pr6-hydrate-implementation/04-* |
| fixture生命周期 | 原两文件103pass/2fail/767断言 | 105pass/0fail/864断言，exit0 | pr6-implementation-evidence/fixture-{red,green}.log |
| 淘汰内部名称断言 | 34pass/1fail | 同文件+公开accounting共42pass/0fail/89断言 | pr6-implementation-evidence/accounting-*.log |

hydrate正式child最终9pass/0fail/25断言，父隔离入口1pass/0fail；身份诊断已移除，静止前缀、缺页与更短终值合并为同一公共行为用例。所有正式red均从原HEAD或该次已通过的前一slice推进，不以规划R14代替HEAD。首次父入口未传项目标准超时时发生5秒超时，原日志保留；按既有`--timeout 30000`重跑exit0，没有修改源码默认超时或断言。

### Verification Commands and Results

git fetch 指定 SHA、detached checkout、Bun1.3.14冻结安装均退出0；本轮基线命令与结果见§18。4张早期图片字节恢复完成；本轮完整应用静态与流式验收结果列于下文，保留早期图片作为历史记录。

正式命令cwd均为packages/opencode，Bun1.3.14：

- `bun test test/session/processor-effect.test.ts --test-name-pattern 'publishes the same accepted text fragments' --preload verification-archive/shared/pr6-processor-feedback/local-only-preload.ts --timeout 30000`。外置本地边界preload属于隔离验收材料，不进入产品。
- `bun test test/cli/tui/slot-replace.test.tsx test/cli/cmd/tui/session-message-render.test.tsx --timeout 30000`，105/0，74.56秒。
- `bun test test/cli/cmd/tui/session-integration.test.ts test/cli/cmd/tui/sync-accounting.test.tsx test/token/accounting.test.ts --timeout 30000`，42/0，4.80秒。
- `bun test test/cli/tui/sync-v2-hydration.test.tsx --timeout 30000`，父隔离入口exit0，最终child9/0。
- `GOMEMLIMIT=1500MiB GOGC=20 GOMAXPROCS=1 bun typecheck --singleThreaded`，最终代码全配置exit0，final-typecheck.log/.exit。
- `OPENCODE_TEST_SHARD=tui bun run test:ci`，完整84文件分片854pass/21既有skip/0fail，3140断言，501.70秒，exit0；final-tui.log/.exit保留原始输出。
- `bun run script/build.ts --single`，首次Sharp smoke因默认用户数据目录只读而EROFS退出1，原日志final-build.log/.exit保留；仅设置工作区可写XDG_DATA_HOME、XDG_CACHE_HOME、XDG_CONFIG_HOME、XDG_STATE_HOME，原命令重跑exit0，日志final-build-writable-xdg.log/.exit。默认Web UI、Sharp原生smoke、--version和compiled voice Worker smoke均通过。Linux x64产物189069440字节，SHA256 cb6e0a5563165c10f088ab4103f3b70a3582e0edb89f227d4dd51872190b88fc。构建生成的models snapshot差异另存后恢复HEAD，lock和manifest保持不变。
- 仓库根目录`GOMEMLIMIT=1500MiB GOGC=20 GOMAXPROCS=1 bun typecheck --concurrency=1`已尝试全工作区预检，执行器断线中断，final-workspace-typecheck.log停在OpenCode类型检查，无exit回执；恢复后进程表无turbo/tsgo/tsc，保留中断状态，待PR5 hook释放资源后重跑。
- PR5释放资源后同一全工作区命令重跑exit0，20 workspace纳入、14/14实际类型任务成功、0缓存，56.438秒；final-workspace-typecheck-retry.log/.exit。两个子模块固定SHA也与远端跟踪tip一致。随后完整原始`.husky/pre-push`预检已启动，最终推送时仍须实际执行hook。
- 完整原始`.husky/pre-push`预检exit0：14/14类型任务成功，30.485秒，两个子模块均为远端跟踪tip；final-pre-push-precheck.log/.exit。实际推送时仍由Git执行hook。
- 原生静态验收使用完整OpenCode、官方Sky直接截图、隔离synthetic Session，真实v1/v2入口均显示Mermaid、公式、普通正文和列表。连续图像工具呈现曾导致“v2丢正文”的错误报告；四张宽屏原始PNG字节相同，直接PNG像素与OCR验证正文完整，新文件复采得到相同宽/窄SHA。该错误结论已撤回，临时R16草稿未实施，当前恢复原R15批准设计与行政字段。全过程见visual-review-correction/STATE.md和native/STATUS.md。静态截图未提交模型请求；随后完成的完整应用流式/hydrate联动见下一条记录。
- 后续完整应用流式/hydrate联动已完成。`native/stream/start-session.sh`在同一桌面shell启动仅loopback的本地provider与真实应用，复用test/lib/llm-server的SSE格式。attempt2于14:35:35.495发首段，v1显示未闭合公式前缀，切真实v2入口触发hydrate后前缀保留；14:36:19.540文件门释放终段，v1/v2均显示完整Mermaid、公式、列表及END。events.jsonl按该次ready区分，只有一次stream-model请求，挂起44.045秒无重试；四张attempt2原生PNG已分别直接OCR复核。该动作验证实际联动，旧快照乱序继续由正式公开provider用例验证。attempt1夹具默认idle timeout导致ECONNRESET并重试的日志保留，设置夹具idleTimeout=0后重跑，产品代码及超时未改。

自包含阶段恢复包Library `私有验收归档-01`版本1已下载空目录重放，含原HEAD bundle+浅边界、8文件overlay和阶段日志，哈希cb2f3e7c1d5c8da3f0e7b46f2d3ce39b80f2531a218e9df5891680426cf9c1e6。其捕获早于最后注释补齐，后续最终快照沿同资产更新。

同资产版本2已包含最终注释、正式TDD和全配置typecheck结果，下载至新空目录后通过清单SHA256、bundle clone/fsck、overlay恢复及diff --check，exit0；归档SHA256为3472b6930f97c7f76907bfd792aefbae0db318b1d1bfead0433af39002d4eef2。该快照捕获时完整TUI仍在运行，TUI最终日志待下一次更新归档。

此前已验证源码实施恢复包为同资产version8，74424320字节，SHA256 7413b17d422aca58f10f212ad304ba4c66e2585af0f8b655c7fc56761ee9da67，含全部正式红绿、完整运行日志、22张原生截图、runtime路径与图片迁移诊断及integration审核中断原文。回下载空目录SHA256、bundle clone/fsck、overlay、diff --check及Plan/原诊断包逐字比较均通过，记录stage8-restore-check.log；本地保留stage6/7/8三套。真实终端证据单独保存于Library `私有验收归档-02` version2，967959字节，SHA256 ebebc0a12ecb6836f816b87ead38f74acebfa8d7d0cdcee4dc621344c207fb35；已空目录回下载并核对19张截图。该包含attempt2联动四阶段、OCR、受控夹具、去除请求system prompt后的时间线/SSE及attempt1失败记录。

### Original Feedback-Loop Result

hydrate原HEAD反馈使用真实SyncProviderV2与testRender，只有SDK历史响应和事件传输边界被替换；挂起请求、注入step/text/delta、确认prefix，再返回空旧快照，公开store丢失prefix。正式实现后的相同公开路径保留prefix；请求前安静前缀、effect依赖、乱序回包和终值承接也已通过正式用例。

### Actual Secondary and Replacement Path Inventory

实际代码沿§11同一同步owner实现期间更新合并、活动正文保留、完成终值承接、过期请求丢弃和权威分页。producer沿既有summary/flag条件发布已接受增量。产品中没有加入隔离诊断分支；外置验收preload与实验候选留在证据目录。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 373（保守计数） | hydrate生产31+新测试272，其他五文件70；排除import/空行，尚未扣除3行pure move |
| Qualifying Chinese comment lines `C` | 65 | hydrate生产7+测试44；processor2+其测试8+slot1+共享fixture3 |
| Ratio `C / E` | 17.43% | 65/373；由独立实现审计复核语义资格 |
| Required minimum `C` | 56 | ceil(373*0.15)，当前65；所有新增测试纳入 |

### Remaining Unverified Items

INV-04的v1同页连续往返已补齐：复用真实完整应用已完成Session，窗口1177px→417px→1167px，不切页、不发新模型请求。窄屏Mermaid源码、放宽恢复三节点图，三个阶段正文、公式、列表及END完整。三张直接Sky PNG及逐字节hash/OCR见native/v1-resize/，源码hash保持R15快照。

当前原脚本完整分片清点为TUI84、integration81、runtime157文件。TUI已完成。runtime经正常审核执行原入口后完整退出1：157文件2739pass、14skip、19fail，16 snapshots、12458断言，321.42秒。原始runtime-test-ci-approved-attempt.log/.exit/.xml完整保留。19项由路径/外部目录10项、cold-v2 8项、图片迁移1项组成，逐项仍按实际对照核实。

cold-v2隔离对照确认原/tmp父级空.git造成worktree误认；同环境原HEAD与R15原断言均出现临时目录前缀。经批准的干净TMPDIR下，post-wrap与legacy prefix两例在HEAD及R15各2pass/4断言。该结果只覆盖两例；原全片19项失败记录继续保留。原git:true因果干预仅属于隔离实验，不修改正式夹具或代替完整回归。日志见cold-path-diagnostic。

后续ColdStorage已补齐原8项失败的同版本对照：Bun1.3.14 (0d9b296a)、干净TMPDIR=/home/agent/pr6-test-tmp，HEAD与R15均8pass/0fail、34filtered、19断言，分别4.57秒和3.14秒、exit0。原测试与全部断言不变，测试SHA256 d77ec5f4f46342561d2b6747e9fc80358e8b1d2a97a89588aa4a51e427f0bd1a。此前两例局部对照使用Bun1.4.4；本次补齐其余6例及原Bun版本覆盖。准确命令、原日志和报告见cold-eight-diagnostic；原证据包SHA256 05be8a2848ba80854cb79d497dc75b317d6d3f508647a34df263bd38196ff571。完整runtime成功门禁继续开放。

路径10项已完成同原断言HEAD/R15对照：原/tmp下两侧non-git项目都错误放行/tmp/other；设置已批准的干净TMPDIR后，两侧均8pass/3fail、19断言，其中包含额外1个原本已通过的File.list用例。原失败7项（containsPath、File两项、LSP、Shell三项）转绿；其余3项external-directory用例硬编码/tmp/project和/tmp/outside，继续受祖先/tmp/.git影响，两侧同样失败。正式源码和断言保持原样。准确命令、逐项映射及日志见runtime-path-diagnostic/REPORT.md。

图片迁移原失败已抓取子进程stderr：CLI导入初始化创建/home/agent/.local/share/opencode遇EROFS。当前环境最小实验显示Bun.spawn默认未传递父进程动态设置的XDG环境；隔离副本只显式传env:{...process.env}并保留原断言后，1pass/0fail、22断言，preview/apply/repeated-preview三个真实CLI子进程均exit0。正式测试仍未改，完整runtime成功门禁继续开放。最新诊断原包pr6-runtime-path-evidence.tar.gz的SHA256为9fda3f7690e58dddef55290aa0bd1b221bf601fe70c6b9fe7f4d714f23cbdd26，已纳入恢复包version8。

integration原入口首次审核接受并启动，随后轮询明确遭拒，进程退出；日志止于httpapi-compression，无test-shard-end、汇总或exit回执。原拒绝文字保存于integration-test-ci-approval-rejection.txt：审核认为该测试可能访问app.opencode.ai，无法确认发送的数据，禁止用变通路径继续。保持停止，未拆文件、改路由或环境续跑。完整integration成功门禁仍开放。

文件清单保存于pr6-implementation-evidence/{tui,integration,runtime}-full-file-list.txt。完整静态及流式应用截图、包/全工作区类型检查、构建和pre-push预检均已取得本轮结果；原§20历史环境阻碍按本节实测更新。本次只读远端复核确认 dev-smark 仍为 26061b595b3140d37717248222c7ed2016421db0，PR HEAD 仍为 03060e4c859965521959a7a91dd5aba6aadc55ca，ahead 4 / behind 0，mergeable=true。独立实现审计与最终提交推送仍待完成；发布前须再次确认远端基线。

## 39. R19 实施与验证证据

当前工作树基线为 `571db6d67baaa4ea8001222963631829acf25713`。产品仅改 `packages/opencode/src/cli/cmd/tui/util/rich-markdown.ts:11–21`，+8/-0；其余 tracked 变更仅为此 Plan。测试、设置、生成物和依赖变更均为 0。实际 diff 在 `verification-archive/shared/pr6-merge-ab/r19-evidence/production.diff`。未创建提交、推送或合并。

### 原始红绿与保持行为

先记录 B 当前头相对目标的三次长输入可见进度 P95 108.4→318.6 ms。按批准 R19 实施后，完整 OpenCode、Linux PTY、Bun 1.3.14、相同 loopback 输入与实际 OpenTUI 依赖交错运行 B:short/C2:short/B:long/C2:long/C2:long/B:long。

| 长输入指标，中位数（每侧两次） | B 当前头 | C2 R19 |
| --- | ---: | ---: |
| 可见正文推进间隔 P95，ms | 404.95 | 107.25 |
| 单次最长可见正文间隔，ms | 814.75 | 206.30 |
| 可见正文推进次数 | 23.5 | 59.5 |
| 首段输入到首个可见标记，ms | 142.28 | 109.59 |
| 最后一段输入到尾部标记，ms | 1151.24 | 1265.77 |
| 首段输入到 SSE 结束的应用进程 CPU，ms | 6090 | 6050 |

两对 P95 都下降（B 315.4/494.5、C2 76.2/138.3 ms），C2 中位达到已测健康基线范围。短输入各一次，首段 105.36/109.64 ms、尾部 533.46/530.54 ms；六次持久正文都与固定输入逐字相同。实际证明改善的是持续显示的节奏。长尾标中位仍多 114.53 ms，CPU 基本持平，不作普遍提速结论。

同一真实应用用处于恢复期的两帧条件独立复核 C2 长输入的 120→82→120：先见完整布局的最右列 81/119，再等同步正文中的引用、列表、粗体、链接及尾标齐全。82 列 626.21 ms；回到 120 列 776.20 ms，均小于 3 秒。最初 450 ms 观察内未等齐的原记录、后续精确时点、原始 PTY、6 个输入哈希、进度序列均保留。

### 命令、目录与结果

- 在 `verification-archive/shared/pr6-merge-ab`，以案中相同 Bun 执行 `XDG_DATA_HOME="$PWD/r19-evidence/xdg-data" bun projection-compat.ts verification-archive/shared/pr6-r19-plan/packages/opencode/src/cli/cmd/tui/util/rich-markdown.ts`，退出 0；顶层、引用、列表、仅定义、混合定义、CRLF/CR、tab 和迟到的公式开记号共 8 个输入在两种真实 OpenTUI 缓冲区布局的流式/完成画面及投影字节与 B 相同。
- 在 `packages/opencode`，`bun test --timeout 30000 test/cli/tui/math-markdown.test.ts test/cli/tui/rich-markdown.test.ts`，57 pass / 154 断言 / 0 fail，4.53 秒，exit 0。无新用例或断言，原公式、Mermaid、缩放代码保持。
- 在 `verification-archive/shared/pr6-merge-ab`，原六次准确命令是 `AB_PREFIX=r19 python ab-r19-initial.py B:short C2:short B:long C2:long C2:long B:long`；`AB_PREFIX=resize19 python ab.py C2:long` 与 `python validate-resize.py resize19` 绑定实际目标宽度及稳定正文。计时、持久字节和原始控制序列在 `r19-evidence/runtime*.{log,txt}`、`resize-validated.jsonl` 及 `r19-*/resize19-*`。
- 实机 Xfce 原生终端执行 `verification-archive/shared/pr6-merge-ab/r19-ui/start.sh`。看到尾标 `R19_VISIBLE_COMPLETE`、引用、两个列表项（含粗体）、`x²` 和 Start→End 字符图，`/exit` 正常返回 shell。原生截图 `r19-ui/markdown-success.png`，SHA256 `635f11d46c2cdd3cd5a18ceaa97714ba4198c7f960385ee05b4087c6bb925b46`。本机提供者只记录各一次 title/stream。
- 在验收的同一基线与同一 R19 源文件的独立类型检验树内，原命令 `GOMEMLIMIT=1500MiB GOGC=20 GOMAXPROCS=1 bun typecheck --singleThreaded`，最终结果 exit 0，未输出诊断。先前依赖链接布局中的 `tsgo` 启动找不到、重复 OpenTUI 类型和重复外部插件 SDK 类型日志照实保留。恢复原锁定命令与文件身份；不改源代码、tsconfig、断言或锁文件。
- 仓库 `git diff --check` 通过。原用户取消的外网资源验收未启动。

### 路径与注释计算

保留唯一渲染器。无公式或定义候选时保留换行正规化后直接交还同一渲染路径，省去当前 HEAD 对普通正文的整段额外分词；有候选时仍用原 lexer。原不支持/过宽源码保留及超预算纯文本属于历史兼容分支。新增备用成功路径和产品诊断点均为 0。

实际 E=6，C=2，C/E=33.33%，至少需 1 行。E 为条件、两个候选行、分支结构和返回的有效修改行；2 行相邻中文注释只计 C。首条解释没有开记号/定义收口时无需做全段分词，第二条解释保留 Marked 的换行正规化是为了 OpenTUI 稳定前缀匹配。Plan 行及临时脚本不计生产或测试变更。

R19 独立实现裁决见第 40 节。验证证据和精确工作树补丁供完整重放。与 R19 条件无关的历史已取消外网项仍按原批准记录；没有把外网项记为通过。

## 43. R21 实施证据

### 文件和责任边界

| 范围 | 文件 / 内容 | 通过预期或结果 |
| --- | --- | --- |
| 原生解析、渲染、类型 | `patches/@opentui%2Fcore@0.4.3-smark.13.patch`，实质改动 `index.js`、`index-b5dpwnes.js`、`renderables/Markdown.d.ts` | 只有原生增量解析器掌握稳定前缀和活动尾部，附加数学 token 不再产生第二轮全文投影。参考链接继承稳定段的定义，晚到定义只使受影响语义失效，重复定义仍保留原始偏移而不重复绘制。原生高亮照旧，只有实际公式字面范围走 StyledText 替换；不安装全屏 onHighlight。 |
| 两条 Session 路由 | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`、`feature-plugins/system/session-v2.tsx` | 实验路径直接给原文、词法扩展和稳定回调。宽度及流式完成不重挂 Markdown；普通非实验代码路径保持原实现。 |
| 公式、围栏和显示 | `util/math-markdown.ts`、`util/rich-markdown.ts`、`util/latex.ts` | 已闭合才转换；不能布局的内容保留已有原生源码，首次窄栏也保留一次有效布局，随后只在同一块内切换视图。 |
| 水合 | `context/sync-v2.tsx`、`test/cli/tui/sync-v2-hydration.test.tsx` | 去掉前后全量 JSON；以在途请求身份记真实变动 ID，同 ID 服务端已完成终态优先；本地已完成不会被服务端未完成倒退；旧请求不能清除新请求集合。 |
| 既有专项测试 | `test/cli/tui/{math-markdown,rich-markdown}.test.ts` 与上述水合文件 | 固定真实 native lexer 和绘制契约；既有测试净数量不增加，不动 Session 首帧断言。 |
| 依赖和原提交范围 | `packages/opencode/package.json`、`bun.lock`；从最终 PR 回撤 `test/cli/cmd/tui/session-integration.test.ts` 和 `test/tool/external-directory.test.ts` | 去掉新引入的 Pi TUI 及其独占依赖和重复 Marked，保留仓库既有其它版本；两回撤文件对 `26061b5` 无 diff。既有生产 Text.Delta bridge 与其原正交测试相对 R19 无改动。 |

锁定 patch SHA256 `eb911576523a0fc9f51dbf89b7498bc1a31858dd516b5862a8e43cd0d962c519`；实装 `index.js` `a540a49bf02a4244a422c00058f88c6215a921c9fa5b31463e8471cab1001b4e`，`index-b5dpwnes.js` `2fcfe76413a3a489d58472bca4564c612c97628010ff383857f269a590558cde`。从未修改的锁定发布包 strict apply、strict reverse 和四文件逐字节比较通过。旧 patch `ce18ccd9…468f` 留作首帧红信号，不能当成最终运行物。普通路径未启用扩展时，R19/R21 两种原生布局各 4 帧逐字节一致。

### 实际红绿、原始反馈和备选路径

- 精确旧 R19 现有汉字邻接用例红：Marked 将 `$x^2$` 和后续汉字合入同一 text token，无法表达精确字面范围；原生 bundled 17 装配后 15 原有测试 / 24 断言通过。孤立性能根因实验记录在 `pr6-r20-probes/{probe.log,ownership.log,bundled-lexer.log}`；73 个增量、29 KB 的开发者回复中，旧全文共 1,081,511 字符 / 公式转换 73 次，按原生首个不稳定块累计 33,466 字符 / 转换 1 次。这是隔离分词信号，不是最终真实 SSE/PTY p95。
- 最终已安装 core 上首次窄屏→放宽真实测试、关闭 conceal 后实际高亮结算、普通引用与原生列表更新，与原有 math/rich 一并 57 pass、192 断言、0 fail；未另加正式用例。实际追加、流式结束和主题刷新：普通节点在前两种变化保留身份，主题刷新才按原生方式更新；已经闭合的 rich-art 节点身份不变，重型布局总调用 1。
- 水合红：请求中收到 SSE Delta 后，同 ID HTTP 完整终态被本地半截内容覆盖，8 pass / 1 fail。补充对照证明两边均已结束且内容不同，也须服从同 ID HTTP 完成快照。最终真实 Provider 原有 9 pass / 29 断言，无补发 SSE 终态来掩盖修复。
- 首帧红：旧 R19 两条真实 V1 终端标记仅在 ANSI row2；预最终 R21 在两个完整 DEC 同步输出中依次出现在 row1、row2。真实布局现象是初帧 viewport 13 / content 14 / scrollTop 1，然后 viewport 14 / scrollTop 0；R19 没有把前一状态的普通 Markdown 字形先画出。拆分 JS 路径、只分离样式强制刷新的验证见保留日志；不恢复旧高亮 callback、无滚动参数改动、无 sleep。最终锁定 Bun 1.3.14 的两条原断言 2 pass / 5 断言，真实 V1 两标记各只一次 row2；V2 同其自己的布局基线，标记一次 row1。这里用实际 Session/Solid/native renderer 加 SDK fixture，不能折抵正式真实 SSE A/B 或完整程序和 Sky 截图。
- 保留已有的未闭合、无有效图、超长度、过窄源码展示；这不是新增备用成功路径。删除全量 `prepareMath`、合成反斜线的全局 conceal hack、用 renderNode truthiness 修改普通引用/列表，以及水合全量快照比较。无官方测试临时探针遗留。

### 静态测试与运行物口径

最终冻结执行树 `verification-archive/tmp/pr6-r21-frozen.iYYTOI/tree`，锁定 Bun 1.3.14。质量凭证由所列 SHA 确定；路径为相对 `verification-archive/shared` 的证据位置。原测试套件以文件隔离运行，防止全局 Bun mocks 抢占同进程 fixture。早期合并单进程组合 exit 137 及所见错误保留，不误计为完成。

| 执行 | 当前观察 |
| --- | --- |
| `bun test --timeout 30000 test/cli/tui/math-markdown.test.ts test/cli/tui/rich-markdown.test.ts` | 最终已安装 core 57 pass / 192 断言 / 0 fail，退出 0；独立重复 57 pass。 |
| `session-message-render.test.tsx`，用冻结的 Bash parser 资源，精确排除用户已排除的三 notebook/Python 资源测试 | 101 pass / 855 断言 / 3 filtered / 0 fail，退出 0；没有修改测试文件。过滤的完整名称写在 `pr6-r21-spacing-recheck.H9HEBk/run.sh`；未运行的三项不计通过。 |
| `sync-v2-hydration.test.tsx`、`slot-replace.test.tsx`、`processor-effect.test.ts` 各自运行 | 9 / 1 / 32 pass；1x/32x 各自记录在原序列证据，源文件相对这些跑次的运行差异等待汇总 SHA；独立水合为 29 断言。 |
| `GOMAXPROCS=1 GOMEMLIMIT=1500MiB GOGC=20 bun run typecheck --singleThreaded`（包目录） | 既有精确运行 exit 0（`tsgo --noEmit --singleThreaded`）；最终仅 JS 修复后声明和参与编译的源码逐项同字节，另有 before/after compile SHA。不能称为第二次实际重跑。 |
| 宿主外资源与离线锁定图 | 一次 `bun install --frozen-lockfile` 真尝试 exit 1，缓存快照缺 GitHub/registry 元数据；使用对应固定提交、真实已缓存依赖和原始发布 core 的替代离线重建，通过包身份/锁图和补丁校验，专用安装目录不带旧 Pi/CJK/Marked 18。只描述为离线固定图，不能描述为全新联网冻结安装成功。 |
| vendored 内容核对 | 上游 pi v1.5.2 commit `b4afdddf…b470`，源码 blob `060fd052…a995`、MIT license blob `b0a8e9b8…8197`。28 个行内/显示与样本列宽输入对照逐字相同；不能推断任意 ANSI 文本兼容。 |

### 有效行 E / 中文解释 C，破除统计口径歧义

统计相对 R19 实施增量；用底层 JS/类型有效差异看 bundle，不用 patch 文字重新分块产生的重复 context 和 diff 标记。机械缩进按 `git diff -w` 排除，import-only、空行、格式化、原样移动、生成 lock、完整法定许可证、原样导入的第三方代码和两个回撤文件分别列明。用例更换 lexer、构造器参数和真正的观察断言属于行为验证，不能按复用外观当作机械改动排除。全部实际修改与注释逐行相配；没有改动的历史中文注释不能重新计数。

| 有效组 | E | C | 边界 |
| --- | ---: | ---: | --- |
| 原生核心修补 | 286 | 43 | 展开 JS/类型物理 +330/-78；只计有效新增和修改。继承的 ScrollBox 声明/bundle 旧更改不重复计。 |
| 水合应用与 existing test | 106 | 17 | 保守统计，包含重复事件适配和测试变更；生产新逻辑删去大块纯重排后的真实 ≤75 行，不以源 diff 粗行数等同行为复杂度。 |
| 数学扩展应用 | 6 | 2 | 数学 token 边界和 raw 保留说明。 |
| 数学专项既有测试 | 5 | 1 | 真实 bundled lexer 工厂与精确字面区间用例有行为含义。 |
| V1 / V2 路由 | 5 / 3 | 2 / 1 | JSX 去掉 wrapper 后仅缩进的属性行排除，明确保留新 props、原文与身份变化。 |
| 富节点 util | 23 | 7 | 运行行为、闭合、阻塞和实际布局边界。 |
| 富节点 existing test | 127 | 12 | 保守，保留所有观察 seam 变更及重复 API 更换，如审计明确定位原样移动再逐行扣。 |
| 第三方列宽适配 | 1 | 1 | 1,535 物理行内原样 1,505 行、被替换的 upstream import 1 行、通告不计；自有 width 一行和制表符合同解释仍计入。 |
| 合计（保守） | 562 | 86 | 最低 ceil(562×15%)=85。 |

专项测试预算单列：数学 5、富节点 127、水合 18，共 150 行保守新增有效测试代码（移除与纯缩进未计）。仅靠精确同文的移动标记，尚不足以支撑 Plan 的 140；重复的实际 helper/API 迁移没有从 E 中抹掉。最终须给出真正机械移动的逐例分类、进一步收敛，或把该偏差明确交回流程决定。

正式 24 轮完成并确认源锁之后，按批准仅在既有 `rich-markdown.test.ts` 增加五条邻近解释，分别覆盖 URL 目的地、原生显示块、超限与运行失败的分工、异步高亮红信号、列表尾字面范围。源文件 SHA256 `3cc54e35bf72504e90fe282c173cbbba313bdebbe3695ca84ddb4886f1c9a395` → `6fe32c69c2df419b777b3b298dae5a7b0025870906848e3e0361d80a9fd18dd4`，正式 Bun 1.3.14 transpiler 输出逐字相同 `acc58b131068dcb097b6eae2e3a77ecc9f78712048d852735b4abf858286bc71`。最终原富节点测试 42 pass / 168 断言 / 0 fail，退出 0；没有测试数量变化、生产源码变化或原样本运行时变更。

### 正式安静 PTY A/B

Bun 1.3.14 与同一真实 CLI，本地 SSE 使用固定分片与节奏，120×36 PTY；A=R19，B=冻结 R21。24/24 有效，三批启动/清理均退出 0，A 947 / B 900 源和安装文件均核对原 SHA。首标记、实际可见推进与最后片后的终态分开统计；短回复只有 10 片，保护组每臂仅一轮。

| 真实长场景 | 稳定推进 P95：A→B（ms） | 完整尾屏：A→B（ms） |
| --- | ---: | ---: |
| shell v1 | 204.62→62.98 | 717.28→91.79 |
| shell v2 | 174.62→78.36 | 447.51→34.47 |
| 已闭合早期公式 v1 | 262.54→65.84 | 1073.14→83.78 |
| 已闭合早期公式 v2 | 223.97→96.21 | 864.35→81.81 |

原纯文本保护组：稳定 P95 的长样本 v1 从 66.88 到 79.03 ms，v2 从 71.39 到 76.34 ms。v1 短样本首可见从 133.19 到 176.35 ms，稳定 P95 从 124.46 到 151.97 ms；v2 短样本首可见 79.58→74.95 ms，稳定 P95 125.22→121.80 ms。单对照如实保留，不声称所有普通输入的所有指标均更快。长目标场景首可见变化见逐轮原表；例如公式 v2 86.25→108.24 ms，但尾屏与推进显著改善。缩放、路线、持久 UTF-8 全文和完成状态已记入各轮证据。完整报告 `pr6-r21-stream-ab-prep/FORMAL-REPORT.md`，源锁、后复核、逐轮原始 PTY/JSON 通过 `recovery-manifest.json` 索引。

### 完整构建、两条实际路由与持久化

- 在锁定的离线候选包目录用 Bun 1.3.14 和 `OPENCODE_CHANNEL=dev-smark` 执行 `bun run build --single --skip-install`，退出 0。嵌入式 Web UI 处理 2,066 模块；编译成品 `0.0.0-dev-smark-202611190949` 的版本与语音 Worker 冒烟均通过。Linux x64 成品 184,633,472 字节，SHA256 `02543fef6121abbebe4e556ac59c91b8687bf30d038cb4f0526b2f5a1d0a485c`；构建前后 15 个路径内容哈希一致。
- 用该精确二进制在真实 Xfce 终端请求同一条含引用、列表、闭合 Mermaid 和显示分式的固定回复。标准 v1 与明确切换到 `session.v2.messages` 的 v2 均显示完整前缀、Start→End 图、分式与终态。分辨率 1364×1024 的原生截图分别为 `v1-sky.jpg`（SHA256 `c154031db34ea1ff68d819e8d26ff8065c217310e6192f5c65d0b0de1c1a44e0`）和 `v2-sky.jpg`（SHA256 `2a38b637c964e7358ad822b3d91976f67429f28ad3d210515a014d5cffe2bd21`）。实际 SQLite 的 `part` 和 `session_message` 同时逐字匹配源；模型流仅开始并结束一次，应用退出且专用 daemon 已停止。
- A/B 24/24 的原始报告、24 份 PTY 及复现脚本均已保存；证据包 `pr6-r21-formal-ab-24.tar.gz` 的 199 个文件逐项读回相同，SHA256 `48ffa5c70fca521abf8afbcfccd6d14defee6ed125ead857e66fbae76522e000`。首次窄屏源码到宽屏图的节点复用另外由原生测试验证。
- 独立空目录离线恢复已重建已发布 R19 的树并应用本次批准的源码，包括 LaTeX 单文件；Git 对象核验及十五路径逐字校验通过。此次送审快照只追加审核所需的 Plan 证据。最终持久化恢复包需在独立审计结束后用该 Plan 再重放一次。
- 剩余外部条件保持明示：完整冷启动冻结安装被外网元数据阻断；已用锁定的实际包重建，运行、编译与补丁身份均逐项验证。用户排除的三项 Python 资源测试单列。保守新增测试代码与方案行数估计的差异交由实质范围审计核对。

### 静态证据 SHA256
```text
02d2695117b987a4d2d356759aee94279bc3a14a4a6c05b82c8c7b7547897861  pr6-r21-native.jdUrWl/r21-native.sha256
a0bacc08f9ef06b8ae8b4f2f25647cebbfe7297b2b744f34963071113f044a87  pr6-r21-native.jdUrWl/r21-native-final-math-rich.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-native.jdUrWl/r21-native-final-math-rich.exit
bcff029ebf52b4510c54593a8277fc417b571862a114a67545944aa982e92ae1  pr6-r21-native.jdUrWl/refs-render.log
ab2d6f54d3031ade1f075386967cb360614bfa7a908cc49ea3dadb15f397d1dc  pr6-r21-native.jdUrWl/ordinary-compat.log
ee81b4409613657bf3342d56d320c44604cf28f483a269cf8856a0a490b97b0a  pr6-r21-native.jdUrWl/r21-effective-native.diff
ff1f406206526e800e5c1ba2a0ad2d31e7e1bec5a11705b76eddcd89ce1fbfea  pr6-r21-native.jdUrWl/math-red.log
38c7c0daa8118a5aceb1e25fd747555cba9ec665311efe947f0579d58a403278  pr6-r21-native.jdUrWl/finalize-lifecycle.log
202c6c5ce162e8e158726a8a5a5f721416b80eb17a8e9674899e878ed09a2e91  pr6-r21-native.jdUrWl/finalize-tests.log
7a814ff10b00edecd9384df00e5c021b4098fbd299a5fb1092fa1cfa5c24cebd  pr6-r21-native.jdUrWl/finalize-pty.log
a78eb146ef9e27ff7adb5ae943a253f1c2f40f017c72b8d2392bff1f01f198c5  pr6-r21-native.jdUrWl/forced-refresh-1.log
333ed560b66328d3791144dce7c748e3e1cd8577fe44d3b858ca4fafe7f467db  pr6-r21-native.jdUrWl/forced-refresh-2.log
753b2a96d0317f89ded7fc4a4dbec365e5784fbef2b98c28a2e26fdd1c472eae  pr6-r21-spacing-recheck.H9HEBk/run.sh
27492929964c57401d655d81da3a71812ddbb1c9758664287516644ee3218f0c  pr6-r21-spacing-recheck.H9HEBk/spacing.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-spacing-recheck.H9HEBk/spacing.exit
30fff51de69aec7dd922f515cb2f03c8b1e64336070a4eeb967370e8711eaac0  pr6-r21-spacing-recheck.H9HEBk/render.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-spacing-recheck.H9HEBk/render.exit
554159131b70c0e023083aa06743c366a92df23d3bced52a7a4655c54852c8e9  pr6-r21-spacing-recheck.H9HEBk/narrow.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-spacing-recheck.H9HEBk/narrow.exit
0175755019158a0d74f0a730f959ea65140ca3b4934e00ee67973dd9df8941cb  pr6-r21-spacing-recheck.H9HEBk/native-installed.sha256
b57ccf7a0f38ba94f1073bb95a4b3e6dc7c81c252fa0b2021d4bab121e1d7974  pr6-r21-spacing-recheck.H9HEBk/compile-paths-before.sha256
b57ccf7a0f38ba94f1073bb95a4b3e6dc7c81c252fa0b2021d4bab121e1d7974  pr6-r21-spacing-recheck.H9HEBk/compile-paths-after.sha256
b0899e5f2a3a06c3237181160c8ac1f904b4dc478b30387665535391b69bc3c3  pr6-r21-spacing-recheck.H9HEBk/declarations-before.patch
b0899e5f2a3a06c3237181160c8ac1f904b4dc478b30387665535391b69bc3c3  pr6-r21-spacing-recheck.H9HEBk/declarations-after.patch
bd92de5de3be0c3bc1ea2972dcf55cf405e0b120b4ba9e26a38112fa80cce30e  pr6-r21-spacing-recheck.H9HEBk/typecheck-inheritance-patches.sha256
156c82b153afdce8263948864077e8745b094ac4129b109546e7edf26c68cbd1  pr6-r21-spacing-recheck.H9HEBk/native-render-after.sha256
c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1  pr6-r21-final-typecheck.Yx2CTJ/typecheck-exact.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-final-typecheck.Yx2CTJ/typecheck-exact.exit
287ce9e00fde08d36aecb438c458bddbcc1ceee1214b192445f71d796413e809  pr6-r21-final-typecheck.Yx2CTJ/hydration-exact-child.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-final-typecheck.Yx2CTJ/hydration-exact-child.exit
c06fd092a4f6bbd911e86b96165ad2f1e99755de3795b307a89de0c508488384  pr6-r21-final-typecheck.Yx2CTJ/offline-exact-after.sha256
7f0d512498f1574bb7d81a82dd84511f97983afc6c16bb04ac24ead80aac20dd  pr6-r21-final-serial.9p6tPS/processor-effect.test.ts.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-final-serial.9p6tPS/processor-effect.test.ts.exit
04249a085139ff53e1947953a90720dc3e161c7eac9b3978dd14bfca8a621f0f  pr6-r21-final-serial.9p6tPS/slot-replace.test.tsx.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-final-serial.9p6tPS/slot-replace.test.tsx.exit
c79bb14c74602668b40ab6ca0e649253ecebe6bedfd0b938c1737fb632912629  pr6-r20-probes/r21-first-visible-native-evidence.md
99ffbc0a32aabbeadfb59c1dccad6258a1944cd78fd5a1994969c92cb1d04c24  pr6-r20-probes/R21-final-first-visible-locked-tests.log
5be9c3eb86736963ea8df83a7e5437207317a652f666bca6b6686e0785e10612  pr6-r20-probes/R21-final-v1-1314.native.log
9326bf9024fca3a2453bd94568cc8fe73bec28fdc4e82f7b5d392dc57c92ae40  pr6-r20-probes/R21-final-v2-1314.native.log
efc94b77ad2e0de8b0a642ae7c28207a4b79bca86f901e340019172c2cd2e6d9  pr6-r20-probes/R21-final-v1-1314-first-visible-native.pty
a4a4ef1531fb7275953d048d80fbdfc805cc4e4c66b4a2e641febf3a08ae6537  pr6-r20-probes/R21-final-v2-1314-first-visible-native.pty
e14cc644bf41962fb77b58bc665934eb8ed50c56ac00d80c26266557e5054b10  pr6-r20-probes/R21-native-finalize-first-visible-native.pty
2eba69bfdbf03c8aa227169f86dd15b41db7119a2a270563c2e6701edae213db  pr6-r20-probes/latex-width.log
7fe4422442eb94a73c841dce2a66a230817db5aa2c1872898fa253723656a8e3  pr6-r20-probes/probe.log
d450a3b24519b4077c560fa955221bb48a903f60594ecfc4bb44dee6f06ba360  pr6-r20-probes/ownership.log
52f03806b3205bffced859f26ec066399c27d2e82eebd72f0cb670f1debe99f8  pr6-r20-probes/bundled-lexer.log
e42ca2592fe4990be768a4dfeabd052d12d1e60058ac2a7cc8bb1cef2cc3a368  pr6-r20-probes/refs-dirty-boundary.jsonl
417e4401683bc8f9871d9e8f127bb2460041ee5c3515b8175faef3d9833413fe  pr6-r21-dependency-evidence.vU6dnG/frozen-install-final.log
d9000a211fd4c893be30838a6db1f8e9e1cfbc8b86a9e91c34e72adf2a115062  pr6-r21-dependency-evidence.vU6dnG/offline-installed-graph.json
e362fae6d4aafd9b1c110f283f94f682d711cc5f2380b8c846a1a4cad46491ef  pr6-r21-dependency-evidence.vU6dnG/offline-final-native-overlay.log
2eba69bfdbf03c8aa227169f86dd15b41db7119a2a270563c2e6701edae213db  pr6-r21-dependency-evidence.vU6dnG/latex-parity.log
c7950857ccf080a993997bdcafa9b21fd36d60bb1717e933e81f77f20985723a  pr6-r21-stream-ab-prep/formal-source-lock-summary.json
88b8fb4fc4e1cc07589b23a7ed6caf14af758f45d4ff9cd74c92341e93eb072a  pr6-r21-stream-ab-prep/minimal-matrix.json
d6f319cd97a1e3bf78c470248ba5e2dc960b07f214f366f97f73273a4559bcfa  pr6-r20-hydrate.jb499h/red.log
49dd25d600264fd950ee1858cf9c9495c95d4215a9cc5fa0ac7b274b73eff6fc  pr6-r20-hydrate.jb499h/both-terminals-red.log
67385e447cc8197aacc4f51c1d76cf0d4cf08d09a80b0dbbbd675d0c656502f3  pr6-r20-hydrate.jb499h/both-terminals-green.log
b01083df945502382f39c0b47fcefade150ca95d1eba89adf59b3ffeb791cb78  pr6-r20-hydrate.jb499h/journal-green.log
df0d106a9ed691cbb29384a9e7a18c545dd5734bb573d8b4a1bcf14ca0c09f7e  pr6-r21-native.jdUrWl/rich-test-comment-equivalence.json
873de42be6f64df183e9ca7af32b5d540244240646ec8324d1feaf5e962392c9  pr6-r21-native.jdUrWl/r21-rich-after-final-comments.log
9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa  pr6-r21-native.jdUrWl/r21-rich-after-final-comments.exit
e9d13dac7be554f6798b3fc9df2144843a9a6b4fbd11daa3c06106990d7aa435  pr6-r21-stream-ab-prep/FORMAL-REPORT.md
e063894b0b0a9b3b38e41ed67ce596b011f6cdbf56c01a56c4af0635242d0952  pr6-r21-stream-ab-prep/formal-results.json
2ab25f44b7cd81c04937187cd64ca54f619b0d7d4497250e24b31157cf42210b  pr6-r21-stream-ab-prep/formal-source-lock.json
1e8f3df70d497138796928ef84509c33c6a225d6b66dcc5bbbdde1c7259e8e17  pr6-r21-stream-ab-prep/formal-source-postcheck.json
208ae92289909cb373da172a026d06c20dcc5f2215b798aac8ae51fb5feb4c7c  pr6-r21-stream-ab-prep/recovery-manifest.json
```

## 45. R21 第一轮实装审计修正

### B-01：金额、引用定义、CPU 与原生分词量

用同一 Bun 1.3.14、v1/v2 实际路由、120×36 PTY、同一发送节奏、同一临时存储逐一跑原用户反馈覆盖的两组 73 片输入；每组每条路由 ABBA。补充计划轮 16/16 通过，共 40 个计划轮。另有一次完整性通过的 R19 引用 v1 额外观测：首可见为 4,683 ms，直到 SSE 结束后约 942 ms 才一次性显示全文，没有可比较的流中 P95；同设置重跑有中间帧，额外观测不计入等样本中位数。

| 实际场景 | 路由 | 首可见中位数 A→B（ms） | 末片到可见终态 A→B（ms） | 稳定推进 P95 A→B（ms） |
| --- | --- | ---: | ---: | ---: |
| 金额 | v1 | 150.91→222.61 | 1249.44→78.95 | 221.81→75.65 |
| 金额 | v2 | 90.10→74.28 | 518.10→46.81 | 200.27→85.39 |
| 引用定义 | v1 | 154.70→175.61 | 649.48→92.45 | 239.21→106.99 |
| 引用定义 | v2 | 89.93→100.75 | 569.59→49.35 | 221.61→74.60 |

- 40 个计划样本及 1 个额外观测均有实际配对 CPU 数据。主 CLI PID 的线程累计 user+sys，采样窗从首次观测到首片发送到首次观测到 SSE 结束，不含其他进程和最后可见帧；不使用 wall-time 代替。完整配对在 `CPU-REPORT.md`。CPU 无一致下降，例如引用 v1 5735→6430 ms（金额 v1 5885→6035 ms），引用 v2 5515→5465 ms；与可见推进/收尾收益分别报告。
- 控制分词量对照在私有 OpenTUI/App 副本计数，应用和原生 lexer 保持实际入口，固定相同 73 次累积原文赋值及 completion，使用 Bun 1.3.14。计数单位为 JS UTF-16 代码单元；两种 native block 模式一致。shell 的 R19 额外全文投影 1,082,909 加原生块 40,617，R21 单一路径 34,089；公式 1,082,198+39,989→33,444；金额 1,082,046+39,745→33,305；引用 1,081,749+39,730→33,306。流式 native inline 计数为 0，completion 单列：R19 重新挂载增约 35,200 块字符和 27,700 inline，R21 同一实例仅空尾，实际解析 0 字符。计数不等同于终端绘制帧数，也不作为 CPU 时间。
- R19/R21 安静 PTY 原始记录、CPU、全文和操作证明来自 `pr6-r21-amount-refs-ab`。补充 tar.gz SHA256 `d965bc76274401d80d0304b62ae70e83767566e9f6e792a6b35307b2e375b25f`；原 24 轮包保持不变。唯一锁文件中的新旧运行输入差异是前一真实构建生成的 B 模型快照；回放明确采用本地空模型文件，实际调用优先回传该文件，不动态导入编译快照，见 `MODEL-SNAPSHOT-CHECK.md`。独立分词量计数 16/16，源码前后相同；可重放计数的原始包 SHA256 `c675724f6bfbcecd0bc18743ec8915929ed37edbd769130f7bd407b35def57bc`。

### B-02：收敛既有专项测试接线

只在原 `rich-markdown.test.ts` 内把重复的富节点构造与两次布局/等待高亮测试接线合并，保留每个原有测试声明及所有断言；渲染、语法、配置、生产文件及原生包字节不变。相对 R19 用同样 `git diff -w -U0` 和有效新增口径，三个专项测试分别 5、117、18，合计 **140**（上一轮 150）。整体保守 E=552、C=86，最低 83。冻结文件 SHA256 `a7e9f05757f9b985dbb5c8001d6624bc2e40ef735926231a051d60932e4ed563`。相同冻结 Bun 1.3.14、已校验 native 包上原富节点测试 **42 通过、168 断言、0 失败**，5 秒内完成。既有构建成品和真终端证据的所有生产输入均相同；运行物 SHA 未变。
- B-02 原包完整类型重跑：Bun 1.3.14，`GOMAXPROCS=1 GOMEMLIMIT=1500MiB GOGC=20 bun run typecheck --singleThreaded`，退出 0、零诊断（59.721s）。无资源限制的首轮被 SIGKILL，单列日志，不作通过凭证。收敛测试的完整计数、测试/断言指纹、产品输入和成品不变的逐项校验见 `B02-implementation-evidence.md`，SHA256 `e47d5553d1026812c3e7d8a4943c310c551657850832d666f406dcf2e329d543`。


````


### R22 原 Gate 最终验证回执

在原隔离目录执行原 `sh .husky/pre-push`。Turbo 串行、tsgo 原完整范围与单线程，真实收据为 **14/14 成功，0 缓存，退出 0，2m10.162s**。两个子模块指针分别为 `51fa88d946bec6c8695ea52b373ce51fb26a9bff` 和 `b0cf25352ca75b964eca476af3554e6aa8dd8b20`，均等于对应远端分支 tip。采样峰值 2,371,248 KiB。运行前后 17 路径哈希完全一致；本段及 §15 为 Gate 收据与记录纠正，未改变生产或测试。原失败、SIGKILL 及重试输出仍留档。

原日志 `gate-after-second-ram-release.log` SHA256 `6344cc751ae008b086eba9b30d052f21f618bb4151cf83ec3a5d7a6779b73c56`；配套 `retry2-result.json`、`retry2-inputs.json` 与采样位于同一实施证据目录。重新交完整实现独立复审。


## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 历史各轮 | R16–R21 | 见当时原文；基线口径不替换R22 | 原样保留 | 原样保留 | 见下 | 原裁决记录 |
| R22待办 | R22 | 必须固定26061b5完整目标 | 尚未审计 | 尚未审计 | pending | root安排 |

下列历史裁决逐字保留。R22必须先方案批准，再把完整实际diff和最新验收交独立实现审计；历史APPROVE不授权本轮新增改动，也不自动将当前状态设为verified。

````text
## 24. Implementation Audit Record

R16新增实施记录：HEAD到当前树共8个生产/测试文件，+477/-27（另计本Plan），包含332行新hydrate测试。R16相对原R15仅external-directory既有测试+19/-16，测试注册总数保持8（Linux运行6、Windows专属2）。图片read.test.ts仍与HEAD的SHA256 `4ea8408e0836363a8506a136dfefc744494c2305883f00a3bfef3e131bf49d65`一致，两个生产文件及hydrate测试与R15正式验证快照hash一致。

本轮包目录执行`GOMEMLIMIT=1500MiB GOGC=20 GOMAXPROCS=1 bun typecheck --singleThreaded`退出0，日志`pr6-r16-implementation-evidence/typecheck.log/.exit`。原runtime完整157文件分片启动后，轮询因copilot-api.ghe.example.com外发目的地不明遭审核拒绝；没有最终exit、JUnit或test-shard-end，不能计全片通过。原始拒绝、精确命令和只读请求核查位于`pr6-r16-implementation-evidence/runtime-{approval-rejection.txt,network-readonly.md}`，保持停止，未拆片或改路由重跑。integration继续保持原拒绝状态。

当前完整diff的E/C为384/67，最低58，比例17.45%。排除import、空行和4行纯移动（renderer销毁/路径恢复2行、mounts断言1行、metadata对象1行）；重复fixture解释只计一条，Windows注释同义改写不新增C。明细在`pr6-r16-implementation-evidence/EC-AND-SCOPE.md`，供独立实现审计逐hunk复核。没有新增生产诊断分支或备用成功路径。

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 未开始 | R15-recovery | 待审 | 待审 | 待审 | 实施已完成，验收推进中，未送审 | 无 |

R16-recovery 已完成整个原始范围的独立方案审计。当前按批准revision实施新增slice、核对保留的R15实现并完成剩余真实验收，再对全部实际diff发起独立实现审计。R15历史批准与验收保持原文，当前批准字段以本文件顶部为准。


## 28. R17 Independent Implementation Audit

## Blocking findings

No blocking findings.

## Non-blocking findings

- 原样记录本轮裁决，并将实现状态更新为 verified。
- 发布前继续执行 §27 已列的远端基线核对、真实 hook 和最终归档重放。当前裁决对应本次八文件实际 diff。
- runtime/integration 保持“用户取消执行，原审核拒绝保留”的记录，完整分片通过栏留空。

## Rejected speculation

- 不要求恢复用户已取消的外网测试。
- 不要求添加图片、第二渲染引擎、配置或额外兼容分支。
- 不要求重跑源码身份一致的已有验证。已独立核对八文件哈希、14 条历史源码记录及两条流式验收生产源码记录，全部一致。
- 不将空的 `final-tui-source.sha256` 计作证据；本轮使用实际存在的运行前及分阶段源码清单核对。

## Requirement and traceability coverage

审计对象为 **R17-recovery**，基线：

```text
03060e4c859965521959a7a91dd5aba6aadc55ca
```

全部实际实现为 **8 个生产/测试文件，+477/-27**，Plan 另计。

- **事件 producer**：已接受片段在预算检查后发布 Text.Delta，沿既有 summary/flag 条件执行，旧 PartDelta 与终值路径保持。正式红测捕获 v2 空增量，绿测验证两个固定片段及最终正文。
- **hydrate**：请求归属、请求前安静前缀、请求期间更新、完成终值承接、跨 Session、排序、分页及 createEffect 依赖均有公共行为测试。已读取四组正式红测及最终 **9 pass、0 fail、25 个断言**。
- **测试生命周期**：renderer 清理及高亮排干归调用 fixture；原 mounts、颜色和 resize 断言保持。过期内部名称断言删除后，公共 accounting 回归保持。
- **项目边界 fixture**：三个原用例复用标准实例 scope，保留权限、glob、always、来源元数据及 Windows 归一化断言。正式整文件结果 **6 pass、0 fail、11 个断言**。
- **完整验证**：TUI **84 文件、854 pass、21 skip、0 fail、3,140 个断言**；包类型检查、全工作区 **14/14** 类型任务、原 pre-push 预检及完整构建均有成功回执。
- **真实应用**：已直接查看原生 PNG，并核对启动脚本和 SSE 时间线。单次流式请求挂起 **44.045 秒**，v2 hydrate 保留前缀，完成态显示 Mermaid、公式、正文及列表；v1 同页窄宽往返恢复图形。
- **范围**：产品修改限 processor 与 SyncProviderV2；其余修改对应批准的行为反馈和 fixture 生命周期。未增加图片能力或渲染引擎。

## Primary-path and fallback verdict

修复落在事件 producer、同步 owner 和测试 fixture。请求期间数据合并与持久终态承接共同维护同一同步合同。

新增备用成功路径 **0**，新增生产诊断路径 **0**。淘汰内部名称断言，替换三个固定 `/tmp` fixture 输入；生产权限规则保持。

## Code quality and Chinese-comment verdict

独立逐行统计并核对语义后：

| 范围 | E | C |
|---|---:|---:|
| 两个生产文件 | 38 | 9 |
| 六个测试文件 | 346 | 58 |
| 合计 | **384** | **67** |

排除 import、空行、文档及 4 行纯移动；重复 fixture 解释仅计一次，Windows 同义注释改写不计新增解释。

**C/E = 17.45%**，满足最低 **58** 行要求。注释邻近请求归属、响应式依赖、终态承接、事件顺序及生命周期决策。实际修改未新增 `any`、类型抑制、公开接口或依赖。

## Release verdict

**APPROVE**

批准 **R17-recovery 对应的本次完整八文件实现 diff**。可原样记录裁决并设置 `Status: verified`，随后推进计划中的发布与持久交付步骤。


## 31. Whole-PR Implementation Audit Before R18

## Blocking findings

### B-01 整条 PR 的中文解释注释比例低于门槛

- **Violated invariant:** 整个实际 diff 必须满足中文解释注释门禁。
- **Evidence class:** contracted。
- **Producer and execution path:** 本次将目标分支到最终树的全部变化压合为单提交，原 Mermaid/LaTeX 适配器、测试及 OpenTUI patch 均进入实现审计范围。
- **Source evidence:** `math-markdown.ts:28–241`、`rich-markdown.ts:1–94`、`math-markdown.test.ts:1–62`、`rich-markdown.test.ts:1–392` 均增加实质代码，中文解释注释为 0；OpenTUI patch 另有 28 行实质新增代码。
- **Canonical-plan evidence:** §17 要求逐 hunk 核算实际 E/C；§27、§28 的 `384/67` 对应 HEAD 到最终的八文件增量。
- **Responsibility owner:** 整条 PR 的实现与交付范围。
- **Concrete behavioral consequence:** 完整提交的 **E=1,139、C=67，比例5.88%**，低于审计最低10%及实施要求15%，无法通过整条 PR 的实现门禁。
- **Minimal correction direction:** 在既有解析、投影、嵌套渲染和行为测试的实际决策附近补足必要解释，按完整 diff 重新核算并复审；保持产品行为和测试断言不变。

## Non-blocking findings

完整 PR 共18文件、+2,271/-74；其中 Plan 873行，其余17文件+1,398/-74。最终记录应同时保留这个口径和此前八文件增量口径。

## Rejected speculation

- 不要求为满足注释比例新增功能、拆分模块或压缩代码排版。
- 不把 DSH 已有语法范围和源码展示合同扩展成图片渲染或第二个公式引擎。
- OpenTUI patch 中既有滚动、高亮生命周期逻辑仅调整补丁位置，不重复计为本次新增代码。

## Requirement and traceability coverage

已核对全部联合 diff。隔离树基线为 `26061b595b3140d37717248222c7ed2016421db0`，暂存 diff 与 `whole-pr.diff` 逐字一致，diff-check 通过；重建树与已验证树均为 `2fbd4ce58e1184269287b4e5335b146e0c08de83`。

行为覆盖包括：

- DSH 来源公式识别、普通 Markdown 和未闭合流式文本保留。
- Mermaid及LaTeX字符渲染、宽度变化、引用和列表嵌套。
- v1/v2 两页接线与流式更新。
- OpenTUI 转义隐藏、嵌套自定义节点及更新路径。
- processor 文本增量、hydrate 并发与终值承接。
- 原生渲染生命周期和外部目录 fixture 修正。

源码身份相同，既有验证继续适用：原渲染矩阵57例、hydrate及producer红绿、完整TUI分片854 pass/21 skip/0 fail、类型检查、构建和真实完整应用截图。最新原pre-push退出0。用户取消执行的外网测试保持原记录。

## Primary-path and fallback verdict

公式识别、Markdown投影、字符布局及双页消费各有明确归属。普通文本、未闭合内容、超宽或引擎不支持语法按批准合同保留源码。

本轮未发现新增备用成功路径或额外产品功能。同步修复继续由事件producer和SyncProviderV2承担。

## Code quality and Chinese-comment verdict

独立核算如下：

| 范围 | E | C |
|---|---:|---:|
| 生产、配置及实质patch代码 | 370 | 9 |
| 测试 | 769 | 58 |
| 合计 | **1,139** | **67** |

排除空行、imports、许可证、生成锁文件、补丁上下文与位置变化、4行纯移动，以及两条不增加解释内容的注释改写。

中文解释比例为 **5.88%**。15%要求至少 **171行**合格解释，当前相差104行。此前八文件的17.45%结果保持有效，完整联合 diff 的门禁尚未通过。

## Release verdict

**BLOCK**

整条 PR 当前由 **B-01** 阻塞。完成注释门禁返工后，提交完整联合 diff 复审，再创建单提交。


## 34. R18 Full Implementation Audit Round 1

## Blocking findings

### B-02 离线组合回归仍有失败，验收门禁未通过

- **Violated invariant:** 批准方案要求关联回归通过；用户取消外网测试后，离线测试继续保持原断言和组合验证。
- **Evidence class:** observed、contracted。
- **Producer and execution path:** Session 测试创建真实渲染器，notebook diff 触发语法高亮，fixture 在 finally 等待子树高亮后销毁共享渲染资源。
- **Source evidence:** `packages/opencode/test/cli/cmd/tui/session-message-render.test.tsx:2134–2235、4718–4747`；`pr6-r18-evidence/fixture-recheck.log:55–78、134–142`。
- **Canonical-plan evidence:** §30 Verification 第3项；§33、§33.1。
- **Responsibility owner:** Session 渲染测试的组合执行与生命周期验证。
- **Concrete behavioral consequence:** 完整 TUI 出现两项失败；原两文件复跑再次出现 Python 超时及随后 TypeScript 颜色断言失败。TypeScript 使用包内资源，单例通过尚未覆盖组合执行。当前材料尚未证明这项离线失败已消除，或能归入用户取消的外网执行范围。
- **Minimal correction direction:** 按用户取消范围排除外部资源入口，保留其余原测试和断言，完成离线组合回归；若仍失败，再定位首个错误生命周期转换。

## Non-blocking findings

- §30 的 Current Gate 保留送审前状态，可标明为历史状态，与文件顶部当前状态对应。
- §33 的候选 C=189 应按下述独立核算修正为187。比例仍通过门禁。

## Rejected speculation

- 本轮六文件仅增加注释，执行代码同一性已核实；不据此要求修改产品实现。
- Python 超时后紧接 TypeScript 失败提供调查线索，现有记录尚未锁定两者的因果关系。
- 不要求重跑用户取消的外网测试，不要求修改超时、断言或添加备用解析路径。

## Requirement and traceability coverage

本轮覆盖目标基线 `26061b595b3140d37717248222c7ed2016421db0` 到当前工作树的全部18文件。

实际 diff 与提交的 `whole-pr.diff` 逐字相同，SHA-256：

```text
18a50281669889388b32db41d936c335068203674554ef56b3b53851b5cfec5f
```

`git diff --check` 通过。完整统计为 **18文件、+2589/-74**；其中 Plan +1069，另外17文件 **+1520/-74**。

已核对公式识别与投影、Mermaid/LaTeX 字符布局、v1/v2 消费入口、OpenTUI 嵌套节点与转义隐藏、文本事件 producer、hydrate 合并及测试生命周期。相对 R17，六文件共增加122行注释，其余11个非 Plan 文件逐字相同。

验证记录：

- 原渲染矩阵：57 pass、0 fail、154断言。
- 包类型检查：exit 0。
- 原 pre-push：14/14任务成功，exit 0。
- 完整 TUI：852 pass、21 skip、2 fail。
- 两文件组合复跑：103 pass、2 fail。
- TypeScript 单例：1 pass、0 fail。
- 历史完整构建、真实应用截图及行为反馈通过执行代码同一性继续对应当前实现。

## Primary-path and fallback verdict

原公式解析、Markdown 投影、字符布局、事件发布及同步路径保持原样。普通正文、未闭合输入及适配器合同内的源码展示保持既有归属。

R18 新增产品概念、备用成功路径和生产诊断分支均为0。当前阻塞集中于组合回归验收。

## Code quality and Chinese-comment verdict

独立核算：

| 范围 | E | C |
|---|---:|---:|
| 生产、配置与实质 patch | 370 | 83 |
| 测试 | 769 | 104 |
| 合计 | **1139** | **187** |

比例 **16.42%**，超过最低171行要求。原 **B-01 已关闭**。

排除空行、import-only、许可证、生成锁文件、补丁上下文与位置变化、纯移动及此前不合格注释。新增122行中另排除：

- `rich-markdown.ts:34`：重复前一行的 Markdown 字面量保护解释。
- `rich-markdown.test.ts:51`：复述相邻测试名称中的输入组合。

其余新增解释分布在解析边界、容器投影、宽度切换和测试意图附近，执行语句、断言及测试注册保持一致。

## Release verdict

**BLOCK**

注释门禁已通过；当前由 **B-02** 阻塞。取得原断言下的离线组合回归结果后，继续完整实现复审。


## 36. R18 Full Implementation Audit Round 2

## Blocking findings

No blocking findings.

**B-01、B-02 均已关闭。**

## Non-blocking findings

- §30 的 Current Gate 可标为历史状态。
- §33 候选注释统计仍为 C=189，应更新为独立核算的187。
- 保留完整 TUI 原始失败记录，最终报告分别列出原分片结果与本次离线组合结果。

## Rejected speculation

- 不要求重跑用户取消的三个 Python 外部语法资源用例。
- 不把先后发生的超时和高亮失败写成已经锁定的因果关系。
- 不要求为本轮验证增加产品代码、修改超时或削弱断言。

## Requirement and traceability coverage

本轮复审覆盖原始需求及目标基线 `26061b595b3140d37717248222c7ed2016421db0` 到当前工作树的全部18文件。

实际 diff 与送审文件逐字相同，SHA-256：

```text
698313bd9023faaf5ada3eede14393b0d4bb08fa5fa9f188ae656be72a93768c
```

`git diff --check` 通过。统计为 **18文件、+2682/-74**；其中 Plan +1162，另外17文件 **+1520/-74**。全部17个非 Plan 文件哈希与上一轮审计对象一致。

覆盖范围保持：

- Mermaid/LaTeX 识别、投影、字符布局及普通 Markdown 保留。
- v1/v2 接线、流式更新、嵌套容器与宽度变化。
- OpenTUI patch、文本增量发布与 hydrate 合并。
- 原生高亮生命周期、测试 fixture 及原行为反馈。

本轮直接核对名称过滤命令、测试源码和解析器配置。三个被过滤用例均指定 Python，资源指向外部 GitHub 地址；其余测试注册、断言和30000毫秒超时保持原样。

**离线两文件组合：102 pass、3 filtered out、0 fail、856断言，exit 0。** TypeScript notebook 原颜色断言在组合中通过，耗时369.69毫秒，补齐 B-02 所缺组合验证。

其余验证继续适用：

- 渲染矩阵57 pass、0 fail、154断言。
- 包类型检查 exit 0。
- 原 pre-push 14/14任务成功。
- 既有 producer/hydrate 红绿反馈、完整构建和真实应用截图，通过源码及执行代码同一性对应当前实现。

## Primary-path and fallback verdict

公式解析、Markdown 投影、字符布局、事件发布与同步各自保持已批准的责任归属。源码保留行为遵循既有适配器合同。

R18 新增产品概念、备用成功路径和生产诊断分支均为0。名称过滤仅落实用户取消的测试范围。

## Code quality and Chinese-comment verdict

| 范围 | E | C |
|---|---:|---:|
| 生产、配置与实质 patch | 370 | 83 |
| 测试 | 769 | 104 |
| 合计 | **1139** | **187** |

中文解释比例 **16.42%**，满足至少171行要求。

排除空行、import-only、许可证、生成锁文件、补丁上下文和位置变化、纯移动及重复解释。此前指出的两条重复注释继续排除。当前代码与上一轮逐字相同，核算结果保持。

## Release verdict

**APPROVE**

批准 **R18-recovery 的完整实际实现 diff**。可原样记录本裁决并设置 `Status: verified`，随后按批准方案执行单提交与持久化重放验证。

## 40. R19 独立实现审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

正式 A/B 的长样本共两对。正文推进间隔 P95 改善，末段输入到尾标的中位数增加 115 ms，CPU 基本持平。§39 已按这三项分别报告；发布说明沿用这个口径。

## Rejected speculation

- 不要求追加测试文件或改动 v1/v2 路由。现有渲染矩阵和临时真实应用回放覆盖本次增量。
- 不把此前 450 ms 内未完成宽屏绘制视为未修复回归。最终候选的宽度与正文同步帧实测分别在 626.21 ms 和 776.20 ms 完成，满足已批准的 3 秒上限。

## Requirement and traceability coverage

完整核对 §1 原始需求及续办指令、批准的 R19 和当前全部 diff。当前 HEAD `571db6d`；生产只在 `rich-markdown.ts:12–19` 增加八行，另更新 canonical Plan。实际 diff 与送审文件逐字一致，`git diff --check` 通过；基准 C2 和类型检查副本的生产文件与送审版同字节。

两组长输入的可见正文推进间隔 P95 均下降，中位数 `404.95 → 107.25 ms`，达到批准的健康基线上界 `109.4 ms`；六次回放持久正文均与输入逐字相同。57 项现有测试、154 条断言全部通过，包类型检查退出 0。核对八种真实 OpenTUI 双模式兼容结果及原生终端截图，图、公式、列表、引用和尾标可见。外网资源用例按用户批准的范围未跑，未计作通过。

## Primary-path and fallback verdict

两个调用方留在原渲染链。普通文本在 `prepareMath` 保持原换行语义后直通；公式及引用定义候选保留原投影，避免重复引用定义外露。新增备用成功路径和诊断分支均为零；既有超预算与源码显示行为保持。

## Code quality and Chinese-comment verdict

独立计数 E=6、C=2，比例 33.33%，超过最低 1 行。六行包括条件、返回及分支结构。两行中文解释分别说明整段分词的非适用边界、换行正规化对增量前缀的必要性。Plan、空白、环境脚本与运行证据不计。新增仓库用例为零。

## Release verdict

**APPROVE**

当前实际 diff 通过精确 **R19** 独立实现审计。可原样记录裁决并标为 `verified`；本裁决不执行提交、推送或合并。

## 44. R21 独立实现审计第一轮

## Blocking findings

### B-01 正式 A/B 缺金额和引用定义场景

- Violated invariant: R20-I1 及批准方案 §41.5 的完整回放要求。
- Evidence class: observed。
- Producer and execution path: SSE 增量正文 → v1/v2 Session 路由 → OpenTUI 原生增量分词 → PTY 可见帧。
- Source evidence: `pr6-r21-stream-ab-prep/FORMAL-REPORT.md` 的分组与 24 轮明细只有 shell、公式、纯文本长短保护组。金额和引用定义只出现在隔离实验，正式报告也缺配对 CPU 口径。
- Canonical-plan evidence: §41.5 明列早期 shell、金额、参考定义、闭合公式，并要求分开统计分词量、可见推进、首尾与 CPU。§43 的台账与原始报告一致。
- Responsibility owner: 真实 SSE/PTY 验收。
- Concrete behavioral consequence: 已测场景的收益有实机数据；用户点名的早期金额及定义密集回复缺同宿主可见推进对照。晚到定义会触发语义边界回退，shell 对照无法替代该场景。
- Minimal correction direction: 复用固定源和现有回放脚本，补金额与参考定义的 v1/v2 配对，并按原方案记录分词量与 CPU；保持正式测试文件数量不变。

### B-02 专项测试超过批准的改动预算

- Violated invariant: §41.8 三份既有专项测试合计 ≤140 行的批准范围。
- Evidence class: observed。
- Producer and execution path: 数学词法、富节点和 v2 水合三个既有 seam 的测试迁移。
- Source evidence: 实际 diff 的专项路径物理新增为 8/149/35 行；§43 在排除注释、纯缩进等后仍计有效新增 5/127/18，共 150 行，尚无逐项排除依据。
- Canonical-plan evidence: §41.8、§43 的专项测试预算。零净增用例的门禁已满足，与行数门禁分别核算。
- Responsibility owner: 三份专项测试改动。
- Concrete behavioral consequence: 实施跨出当前批准的专项测试范围 10 行，用户明确要求控制测试扩张。
- Minimal correction direction: 给出至少 10 行确属原样移动或机械变更的逐行依据，或直接收敛重复接线，并保留三个 seam 的核心断言。

## Non-blocking findings

冻结安装已实际尝试，发布元数据受网络限制；已有固定包身份、严格补丁校验、实际构建与原生运行证据，按已验证的离线重建记录。最终恢复包应在裁决写入 Plan 后按交付流程再做空目录核验。

## Rejected speculation

不要求新增外网或 Python 测试、第二套 Markdown 解析器、全局公式缓存或永久水合版本表。

## Requirement and traceability coverage

两份送审 diff 的 SHA256 与 handoff 一致。终端主路径接入原生增量分词，两条实验路由撤掉宽度与完成重建；闭合围栏缓存本块布局，普通引用与列表沿原生节点；HTTP 已完成 Assistant 优先于同 ID 本地前缀；LaTeX 单文件保留来源和 MIT 许可，两份无关测试从完整目标差异撤回，Text.Delta 桥保留。已有 24 轮真实 A/B、Linux 构建与两路终端截图的证据可保留。

## Primary-path and fallback verdict

源码回退沿既有 Markdown 围栏路径。公式与图形的宽窄切换归属同一块，没有另加解析路径。

## Code quality and Chinese-comment verdict

送审核算 E=562、C=86，门槛 85；围栏原地切换、引用首定义、异步字面范围和旧请求释放的代表性注释解释了相应边界。专项测试预算独立按 B-02 处理。

## Release verdict

**BLOCK**。送审候选树 `d5f055efb241947c3ff1c700d590f89c524ce8e6`。

## 46. R21 独立实现审计第二轮

## Blocking findings

No blocking findings.

## Non-blocking findings

保留报告中的 CPU 和首屏变化：可见推进与收尾延迟下降，CPU 并未一致下降。引用 v1 额外观察轮只在结束后显示全文，单列，不纳入等样本 P95。最终恢复包按交付流程用记录本轮裁决的 Plan 再做一次空目录重放。

## Rejected speculation

不新增正式测试，不引入第二套解析器、全局公式缓存或永久水合版本表。

## Requirement and traceability coverage

- **B-01 已关闭。** 补齐金额与引用定义的 v1/v2 真实 SSE/PTY 对照，16/16 计划轮有效。四组稳定推进 P95 均下降，从 200–239 ms 降至 75–107 ms。CPU 和原生分词量分开核算，保留原 24 轮证据。
- **B-02 已关闭。** 三份专项测试按批准口径分别为 5、117、18 行，合计 140。收敛只改富节点测试的重复接线，保留测试声明和断言；42 项通过、168 个断言，包类型检查退出 0。产品源码和运行物未变。
- 全范围复核保留上轮已有的语义与运行证据：两条 Session 原生增量路径、闭合围栏宽度恢复、普通 Markdown 样式与节点复用、v2 水合终态优先级、LaTeX 来源许可和两份无关测试回撤。两份送审 diff SHA256 与 handoff 一致。

## Primary-path and fallback verdict

沿 OpenTUI 原生增量主路径。源码展示沿既有围栏路径，放宽时复用当前富节点的布局结果。

## Code quality and Chinese-comment verdict

E=552、C=86，最低 83。邻近中文注释保留对稳定前缀、字面范围、布局宽度和请求身份的解释。

## Release verdict

**APPROVE**。仅放行 R21 对应的候选树 `1721a97869beaad33f1a3a915622ff0710e1aac2`。

````

### R22 独立实现审计第 1 轮原文

## Blocking findings

### B-01 当前候选的 Gate 尚未通过

- **Violated invariant:** 用户要求按 Gate 验收到可合并质量；R22 §18、§21 保留正常质量门禁。
- **Evidence class:** observed。
- **Producer and execution path:** 原 `.husky/pre-push` → 全包类型检查 → `opencode` 的 `tsgo --noEmit --singleThreaded`。
- **Source evidence:** `verification-archive/shared/pr6-r22-implementation-evidence/gate-after-ram-release.log:42,50–64`。最新运行记录 `SIGKILL`、`10 successful, 14 total`；对应 `.exit` 为 `1`。
- **Canonical-plan evidence:** §18 Verification、§21 Audit Contract。
- **Responsibility owner:** 最终候选的 Gate 执行与验收环境。
- **Concrete behavioral consequence:** 当前候选尚缺完整 Gate 成功回执，发布门禁未满足。
- **Pre-R1 baseline behavior on the same path:** 本轮未运行原始基线 Gate；已有冻结 R21 的 14/14 成功记录，当前 R22 重跑失败单独保留。
- **Round basis:** 当前实现验收的硬门禁。
- **Minimal correction direction:** 排除导致类型检查进程被终止的执行条件，在当前精确候选与依赖图上完成原 Gate，保留命令、目录及退出码。

## Non-blocking findings

§15“R22 本轮实际编辑只有 Plan”仍是方案阶段记录，应更新为 Plan 与批准的 hydration 测试删除。生产文件身份保持一致。

## Follow-up

Gate 成功后，携原始回执复审本轮候选；若产品或测试字节发生变化，提交更新后的完整差分。

## Rejected speculation

本轮 SIGKILL 日志未给出 TypeScript 类型诊断，不据此增加生产补丁、放宽断言或修改类型检查范围。

## Requirement and traceability coverage

完整实际差分与送审文件逐字一致：

```text
SHA256: e1270d3f98aab7740a4b49d8e93aed9d50bab824f43e431020268021cde228dd
固定基线: 26061b595b3140d37717248222c7ed2016421db0
17 文件，+5464/-182
其中 Plan：+1677
其余 16 文件：+3787/-182
```

已核对全部修改区域及直接路径。15 个非 Plan 文件与批准候选逐字一致；hydration 文件精确落实批准的 54 行删除，SHA256 为 `39efce618c5b43534770e73ef92a54d637d153da54555c6cddb0242691429846`。

删除后真实验证通过：

- hydration 内层：8 pass、0 fail、22 个断言。
- 外层隔离 runner：1 pass、0 fail。
- `git diff --check` 通过。
- 无关 email 删除及两份已撤回测试均未进入完整实际差分。

原生增量解析、公式与 Mermaid、双入口、Text.Delta、水合终态与分页、真实应用截图及 A/B 的既有证据按相同产品身份保留。

## Primary-path and fallback verdict

实现沿批准的 OpenTUI 原生增量主路径，责任归属与 R22 一致。本轮测试收敛新增生产行为及备用成功路径均为 0。

## Code quality verdict

代码与测试变更符合批准范围。重复夹具及专用导入精确删除，其他测试输入和断言保持原样；上游公式来源许可、邻近行为解释及原有排版保留。

## Release verdict

**BLOCK**

当前阻塞项为 **B-01：精确候选 Gate 未通过**。源码范围与测试收敛核对通过；取得完整 Gate 成功回执后继续本轮复审。

### R22 独立实现审计第 2 轮原文

## Blocking findings

No blocking findings.

## Non-blocking findings

无。上一轮 §15 的记录修正已完成。

## Follow-up

将本轮裁决原样写入 canonical Plan，按批准流程完成单提交及持久化验收。

## Rejected speculation

本轮环境调整仅改变执行资源参数，原类型检查范围与子模块校验保持完整。无需新增生产修复或测试。

## Requirement and traceability coverage

**B-01 已关闭。** 已读取原 Gate 脚本、运行命令、完整日志及退出码：

- 14/14 成功，0 缓存，退出码 0。
- 用时 2 分 10.162 秒。
- 两个子模块指针均通过远端 tip 校验。
- 原 SIGKILL 失败记录继续保留。

完整实际差分与送审文件逐字一致：

```text
SHA256: 74dd8ecd9b800b34456fe9faa8f265c6f559b0b0b4ddc065b9e3caea548d7590
固定基线: 26061b595b3140d37717248222c7ed2016421db0
17 文件，+5538/-182
其中 Plan：+1751
其余 16 文件：+3787/-182
```

全部 16 个非 Plan 文件与上一轮审计对象逐字一致。新增差异仅为 Plan 中的 Gate 回执、记录修正和上一轮裁决。完整需求、修改路径、原生渲染、真实截图、A/B、hydration 8 项及外层隔离验证继续由已核对的同一产品证据覆盖。`git diff --check` 通过。

## Primary-path and fallback verdict

实现保持 R22 批准的 OpenTUI 原生增量路径及责任归属。新增生产行为、备用成功路径和诊断分支均为 0。

## Code quality verdict

完整实际差分符合批准范围。测试精确删除 54 行重复夹具，其他输入和断言保持原样；原有排版、来源许可及行为解释保留。

## Release verdict

**APPROVE**

批准 **R22 对应的完整实际差分**。可原样记录裁决并设置 `Status: verified`，随后执行批准的提交与持久化流程。
