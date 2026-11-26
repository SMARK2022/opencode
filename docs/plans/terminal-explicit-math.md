# 终端 Markdown：实时 Mermaid 与显式公式

> Status: verified
>
> Revision: R11
>
> Approved revision: R11
>
> Audit mode: full-scope
>
> Requirement source: 本会话下列原话
>
> Implementation allowed: no further material changes without revision or rework
>
> Target: verified-implementation-and-commit
>
> Last updated: 2026-11-26

## 1. 原始需求

以下各项是行为与 diff 的依据。旧的“闭合前不画图”方案已被 Q2 替换。

**Q1，来源与复用：**

> 我说了一遍，我再说一遍。原方案实际使用的代码，我指的是对应的DSH的那个插件，或者说什么什么那个TUI的对应代码。不是说让你看我们自己的代码，你看我们自己代码有什么用吗？没用啊。我的意思就是说你去抄对应的那个他们的实现的方式。

**Q2，实时与块边界：**

> OK，那就当我没有说 memo 这个事情。然后，有明确的块编辑的话，那你就注意了，就 OpenTUI 就使用这个围栏闭合和不闭合这个东西，请注意这点。我建议用户看到的行为是正在输出 Mermaid 的源码的时候，Mermaid 的布局调用是要去更新，读到有效闭围栏是最终更新一次。图后继续输出说明是什么意思？说明应该就是正文字符吧，正文字符那就还是那一次吧。我的意思就是说，Mermaid 更新的时候，那既然我们有这个16毫秒的正文合批窗口，那就按照这个逻辑进行，就是每一次都进行一次渲染，就是实时排版，没有问题，注意这点，实时排版。而且你自己也测了，即便是96节点的这种链式图，它排版也要不了多久。然后同时这个公式的逻辑，按理来说也是有这种，呃这个块编辑的这个逻辑，因为我们的 OpenTUI 的优化本身就是结合块边界的这个逻辑进行的。所以说，这些东西就是公式和图，两者都是按块边界的逻辑去进行。

**Q3，公式入口：**

> 而且你凭什么就能有效的判断说什么PWD啊这种东西，保留两个美刀的，你这根本你就没有办法判断这到底是不是公式啊，因为有的公式它也可能长这个样子。所以那取舍会很明显，就是说只按照这个圆括号和方括号这种逻辑去进行，对吧？

**Q4，范围、hunk 与行长：**

> 啥意思，就是单元格的行内渲染还是专门的逻辑，是吗？它的 Markdown 的渲染还跟其他不一样，是吗？就比如说我们直接放在 Markdown 的通用的渲染逻辑中，还不能让表格享受到这个收益，是吗？那反正我希望整体的改动尽量保持这个克制，保持这个精准短小的实现。短小指的是必要的这种精准凝练的这种实现，Hunk，H-U-N-K 的数量最少，然后同时你不要为了把这个 Hunk 去变小而压缩多行到一行里面。你的行数，就是每一行这个代码的长度，你不要去超过现有整个你要修改那个文件的平均长度的 1.2 倍。平均长度指的是包，整个文件的字符数除以行数，包含空行注释。然后你可以继续你的方案吧，按照 workflow 构建你的方案，或者说你可以检查一下现有的一个方案它的内容，去分析调整一下。或者如果你觉得现有的方案可能不太行的话，那你也可以直接去重构，重建。当然我指的这个不太好的意思是现有的方案实现过度冗余的话，你可以这样做。如果它实现得不冗余的话，我认为你应该去，可以去复用它。我指的冗余是做了一些用户没有要求的一些其他各种各样的一些逻辑界线操作，因为用户已经清晰地说了，就是说最多说了一个表格，还有普通 Markdown 里面的，不要去给我搞其他的各种各样的一些界线，不要又跟我说 Mermaid 又要支持公式，一会儿又要跟我说什么代码块要支持公式，用户没有提这样的需求，不要去加这样的界线逻辑。你的修改的每一个 Hunk 都应该对应到用户的需求原文上。

> 同时我说的为了行数而改写的要求，指的是不为了缩减行数而把多行聚合在一行。我没有说不能把一行拆成多行，请注意这点。

**Q5，规模和依赖：**

> 按照我的理解，上游当时实现的好像整个patch也就几百行，或者说将近1000行不到吧。所以我觉得你修改应该也不会多少，按照我的理解最多就是几百行吧，可能，然后引入一两个依赖什么的这种。按理来讲，其他的接线应该可能就不需要做吧？因为本身OpenTUI如果一旦支持，不就OK了？

**Q6，阶段更新：** 用户曾选择“先完成方案”；方案获批后用户 GOAL 明确恢复终态 `verified-implementation-and-commit`，当前按批准方案实施。

## 2. 明确不做

不接图片，不接 Mermaid 标签内数学，不接代码围栏内数学，不增加表格内 Mermaid 或显示公式节点。表格内只接行内公式。不接裸 LaTeX 环境或美元公式；不添加金额、Shell 判断。公式 body 内原引擎支持的分式、根式等语法保持。不新增计时器、节流、系统提示词、配置开关、全局缓存或独立 Markdown 解析器。不迁移 DSH 的 React/Ink 渲染器、设置与图片模块。不改 Core、HTTP、存储、SDK、事件合批、既有尾表补丁、普通引用定义语义、原生清理逻辑。普通列表和引用继续已有路径，不单独开发其中的富块嵌套功能。

## 3. 仓库与固定基线

固定基线为 `07395e4a82d40d950e6c83186cbbbf51680b6888`。独立树为 `D:/Temp/opencode/tui-explicit-math-local`，最初产品文件与基线一致，现已进入实施。主线另有其他任务的 staged/unstaged 改动，尤其 Session 测试文件；不复制这些在制内容，不覆盖、不暂存、不提交。

遵守根 `AGENTS.md`、`CONTEXT.md`、`docs/guides/workflow.md`、engineering policy 和 canonical template。无相关终端公式 ADR。方案阶段只改本文；Workflow 的新需求条款用于本次 Q1–Q5 更新后的全范围方案审计，保留旧轮次记录，不复用旧批准。

## 4. 已读证据

| 证据 | 作用 | 类别 |
|---|---|---|
| `packages/tui/src/routes/session/index.tsx:2594–2625` | TextPart 预算后创建原生 markdown | observed |
| `src/util/text-budget.ts` | 保留 32768 字符、1000 行预算 | contracted |
| `src/context/sdk.tsx:92–116`、`sync.tsx:724–749,905–908` | 正文已有约 16ms 合批和终值前 flush | observed |
| 已安装 `@opentui/core/index.js:5755–5759,7904–7961,8177–8319` | 围栏、增量 parser、共享行内 renderer | observed |
| 同文件 `5910–5923,8780–8836,9128–9151` | 表格单元格走相同 inline tokens 和 chunks | observed |
| 同包 `index-b5dpwnes.js:3484–3564` | 段落初始字形之后会被异步高亮重新提交 | observed |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch:94–99` | 已有完成态末表回读，不覆盖 | contracted |
| 现有 Session 渲染测试、OpenTUI streaming runtime 测试 | 实际帧、完成态尾表/引用与资源释放 | observed |
| DSH `2d6c9a13` 的 `src/terminal-utils/{math,latex,mermaid}.ts`、`components/{MermaidDiagram,MathBlock,StreamingMarkdown}.tsx` | 直接移植来源、实时图与公式文本策略 | observed |
| DSH `scripts/verify-mermaid-diagram.tsx:83–90` | 原作者逐字符成图验证 | observed |
| Pi `f07218c4` 的公开 `src/index.ts` 和 `latex.ts`、npm `@earendil-works/pi-tui@0.87.1` 元数据 | `renderLatex` 是公开导出，可省去本地引擎副本 | observed |

DSH 只读原件在 `F:/ML/PythonAIProject/Claude-Code/opencode/.temp/.testing/dsh-upstream-2d6c9a13`；其仅删定界符的实验副本在同一父目录的 `dsh-explicit`。本方案不以旧 PR #6 自研适配器作为行为来源。

## 5. 当前行为与实测

`Part → 原合批/store → TextPart → 原生 Markdown parser → token 树 → block renderer / table inline renderer`。

同版本原生探针已证明主线把 `\(x^2\)`、`\[y^2\]` 和 Mermaid 显示为源码；没有图和公式语义。DSH 收窄后的原扩展给正文与表格单元格产生相同 `type: math, text: x^2`，同一 `renderInlineMath` 均产出 `x²`。不能只接 paragraph seed：实测原生 CodeRenderable 初始 seed 为 `x²`，等待 `highlightingDone` 后又显示 `\(x^2\)`。这直接证明段落异步提交也需要消费同一公式结果。

已用真正的 DSH `renderMermaid` 和发布源码绘出未闭合图；闭合后 `Following` 被原 Marked 分成普通段落。Bun 1.4.4 / Ryzen 5800H 的 200 次暖调用中位数：5 节点 0.856ms、32 节点分支 2.143ms、96 节点链 4.024ms。它们是引擎实验，不是全应用性能结论。

可复核入口为主工作树根执行 `bun --no-install .temp/.testing/rich-plan-probe.ts`，脚本在忽略目录，不进入产品 diff。该脚本包含完整 fixture：共享 inline token、DSH provisional 判断、原生内容/完成 setter 顺序、Pi/DSH 18 项受控比较，以及 5/96 节点计时。2026-11-26 实跑退出 0；先完成后加最后正文得到旧 `A --> B` 和 3 个块，先内容后完成得到完整 `A --> B\nB --> C` 和 1 个块；18 项输出一致。本次复测暖调用中位数 0.334ms / 3.420ms，P95 0.624ms / 6.444ms。计时依运行负载浮动，不作为整体性能 gate。

## 6–8. 输入、约束与首个分歧

| ID | 要求及可达输入 | 首个分歧 / owner |
|---|---|---|
| I1 | Q1/Q3：普通正文 `\(...\)`、独立 `\[...\]`；美元保留 | native lexer 未注册 DSH 扩展 |
| I2 | Q4：表格表头/单元格 `\(...\)`，与正文相同输出 | 共享 inline renderer 尚无数学结果 |
| I3 | Q1/Q2：每批变化的 Mermaid body 实时布局，闭围栏最终更新，后文不重画旧图 | native code token 未向 DSH 图引擎派发 |
| I4 | Q2/Q4：稳定前缀、原尾表、普通样式/链接/conceal 与源文保持 | 原生块和高亮缓存边界，不能改源文后二次分词 |
| I5 | Q4/Q5：少量必要 hunk，长行可拆，生产新行受 1.2 倍限制 | diff 和源码验收，不改变产品算法来凑指标 |

输入由正常助手文本 Part 进入；语法识别仍由原生 Marked，代码 body 不递归解释 Markdown 数学。既有超预算路径原样保留。未完成公式、过宽布局及引擎不支持使用 DSH 已有源码显示策略，不增加第二引擎。

## 9–10. 单一路径与必要接口

### 依赖与 DSH 代码

锁定 `lovely-mermaid@0.3.3` 和公开 `@earendil-works/pi-tui@0.87.1`，不使用私有 `dist/latex.js` 深导入。本地不添加 1500 行 `latex.ts`。后者公开提供 DSH 复制的同系 `renderLatex`；用它替换 DSH `math.ts` 的本地引擎 import，保留 DSH 的单行/显示模式调用。发布源码与 DSH 的算法正文仅内部负间距标记值不同；在相同列宽函数的受控实验中，9 个表达式×两种 display 模式共 18 项一致。实际安装包及其列宽、启动影响留实施验证，不把受控实验称为包级验证。该包解包 2,866,399 字节，运行依赖 `marked@18.0.11` 与 `get-east-asian-width@1.6.0`；OpenTUI 仍只使用自己已有的 Marked。

合并为一个 TUI util `rich-markdown.ts`，放 DSH 所需定界符函数、公式输出函数及图节点注册。明确删除 `$`/`$$`、裸环境、额外围栏数学入口和相关猜测函数。保留 MIT 来源和许可文本。直接复制的函数可以换行，不改算法。只针对普通 Markdown 和表格的 token 注册扩展，不添加独立列表/引用富节点工厂。

### 原生词法与行内输出

在原生 Markdown 实例上增加可选扩展配置，包含 Marked extensions 和一个 `renderInline(token)` 回调。TUI 回调只处理 DSH 的 math token，调用 DSH 的 `renderInlineMath`；其余返回未认领。原生默认实例完全保持原 lexer。扩展实例在同一个增量 parser 内调用配置后的 Marked，仍使用原 raw 前缀匹配和不稳定尾部；不继承/重算全局引用定义，不做额外源码投影。

扩展配置同时承接 DSH 自带 `mayBecomeCodeSpan` 和 `StreamingMarkdown.tsx:261–275` 的唯一稳定前缀裁决：paragraph 后紧邻 mathBlock 且仍可能被随后闭合的 code span 吸收时，原生 `stableTokenCount` 停在该 paragraph 前。下一批只复用该点之前的前缀，仍交同一 lexer 重读尾部。回调只回传允许稳定的 token 边界，不解析正文，不维护第二棵树。没有该组合时保留原两 token 尾部策略；未注册扩展的实例保持原行为。借用现有 parseState 的边界，不新增容器状态机。DSH 的 provisional 条件保持（paragraph 后接 mathBlock 且同段仍有未匹配开启符），不把它改造成通用括号判断。
DSH 的完整代码跨度排除辅助函数存在已复现差异：三行 `` `example\n\[y^2\]\nC:\` `` 在主线是一个代码 span，原 DSH helper 把闭合反引号前的反斜线当转义，导致它分成数学块。block extension 的 start 提示改为调用本次原生 lexer 已有的 `codespan` 方法确认已闭合 span，沿用原 tokenizer 规则；不复制另一套反引号闭合算法。完整跨度和 provisional 判断共用原生 `codespan`：遍历当前段落反引号 run，跳过已经由原 tokenizer 消耗的跨度，余下未匹配 run 供 DSH 原 provisional 条件使用；已匹配跨度的 raw 范围用于判断 mathBlock 候选是否在代码中。原 `backtickRuns/unmatchedBacktickRuns` 的另一套配对判断删除。start 提示使用该次 lexer 的 tokenizer；stablePrefix 回调由同一个原生实例配置传入其 codespan 函数，原生只增加一个纯函数引用参数，不新增闭合状态或第二次文档分词。测试附加到原数学功能 slice 的普通代码示例对照中，不提供代码内数学能力。

表头与单元格已有 `renderInlineContent`，直接共用上述回调。带样式的行内路径保留原样式与链接，公式字形作为 literal chunk，不把字形拼回 Markdown。普通正文初始 seed 和后续高亮提交也消费同一回调结果。后续提交仅对实际 math token 对应的源文范围替换字形，其余高亮片段保持原生转换。范围跟随当前原生节点，不做全文缓存；异步回执沿用已有 snapshot/cacheGeneration，范围变化只使受影响的缓存失效。这是 I1/I2 的同一路径分解，不另建表格公式 parser。

### 原生块与图输出

Mermaid 的 `code` token 每次 body 变化交给 DSH `renderMermaid`。宽度来自实际分配的原生节点，遵循 DSH 的自然宽度与源码显示规则。只移植文本显示，不移植 React/Ink、图像或设置系统。

围栏的 `closed` 元数据由原生 Marked 已有围栏匹配结果给出，TUI 不再次用 regex 解析闭合行。块现有状态保存的 token 已能表示 body 与 closed；开→闭触发一次最终更新，body/closed 均未变时复用当前图。仅追加普通正文以及 Message 完成时间不重新调用图引擎。字号/主题/宽度更新走原节点样式和 fit 更新，不重新分词图源。源码发生更正时按现有块 diff 更新，不另建闭合栈、状态队列或轮询器。

显示公式直接使用 DSH mathBlock token 和 display renderer；未闭合时保持 DSH 原文显示，闭合时排版。行内公式在同一当前块里随着定界符完整而生效。原始 Part 一直是源 Markdown。

TextPart 同一批最终正文和完成状态可同时变更，因此把 `<markdown>` 的 `content` prop 放在 `streaming` prop 前；同一 Solid 更新中先交付最新正文、后稳定尾块。仅调换两项已有 props，不增加 effect、队列、计时器或终态重读分支。原预算保持。以真实 Session 的同批 final delta + message completion 验收，不能只分两次 await 后声称完成态正确。

## 11–12. 路径取舍

| 路径 | 处理 | 原因 |
|---|---|---|
| 普通 Markdown、原表格与预算外正文 | 保留 | Q4，原功能不回归 |
| Mermaid 流式、最终闭合、后续正文 | 同一原生 token/节点 | Q2，无计时器/全局缓存 |
| 显式数学及未支持/未闭合的源文 | DSH 单一路径 | Q1/Q3，不尝试其他数学引擎 |
| 原方案的末行分类、通用终态重读、dirty-reference/trivia、全篇模式切换 | 全部不移植 | Q4，不属于本轮功能 |
| 代码/图中的数学、表格中的图或显示块、额外容器富渲染 | 不新增 | Q4 已排除 |

新增异常恢复路径为零；保留 DSH 原有有界输入与源码返回语义时，必须在依赖/适配审计中标明原函数出处。普通输出分支是同一接口的显示策略。不得扩展为多解析器 catch-and-success。

## 13–15. 逐 hunk 正向与反向映射

以下编号是实施 diff 的审计槽位，按默认 `git diff -U3` 统计。每一个真实 hunk 必须登记到编号、Q 原文、必要性及验证；不能只按文件笼统映射。原生补丁同时统计外层 patch 文件 hunk 和内部源码 hunk，不用大上下文合并计数。

| ID | 文件/准确区域 | 原文 | 原因与验证 |
|---|---|---|---|
| H01 | `packages/tui/package.json` dependencies | Q1/Q5 | 两个现成引擎；公开 API import / 冻结安装 |
| H02 | `bun.lock` 对应 workspace 与新包节点 | Q1/Q5 | 固定版本及 integrity；只允许依赖解析生成的必要变化 |
| H03 | `packages/tui/src/util/rich-markdown.ts` 新文件 | Q1/Q2/Q3 | DSH 原函数、两个定界符与同一行内输出；源码对照和行为探针 |
| H04 | `packages/tui/src/routes/session/index.tsx` import | Q2/Q4 | 注册能力所需 import，仅一个导入区域 |
| H05 | 同文件 TextPart 的配置与 markdown props | Q2/Q4 | 注册能力，并使 content 在 streaming 前更新；原预算与 streaming 值不改 |
| H06 | 原生 `index.js` bundled fences matcher/return | Q2 | 提供自身识别的闭合元数据；开/闭及后文计数 |
| H07 | 同文件 markdown-parser 的 lexer 调用、既有 stableTokenCount 及实例选项 | Q1/Q2/Q3/Q4 | 注册 DSH 扩展及其原有 provisional 边界；普通 Markdown 对照，不早封前段 |
| H08 | 同文件 MarkdownRenderable 的 inline/带样式 inline 入口 | Q3/Q4 | 正文 seed 和表格共用公式；粗体、链接与表头样式 |
| H09 | 同文件正文 CodeRenderable 构造/更新的 token 接线 | Q3/Q4 | 公式范围送到既有高亮提交；等 highlightingDone 后仍正确 |
| H10 | `index-b5dpwnes.js` CodeRenderable 范围及 chunk 转换区 | Q3/Q4 | 字形不被异步高亮覆盖；原缓存/snapshot 有效 |
| H11 | 原生 `index.js` top-level 块 diff / stream 完成刷新 | Q2 | 实时变化重画，闭合最终一次，后文保持节点 |
| H12 | 原生 `renderables/Markdown.d.ts` 必需的公开选项 | Q2/Q3/Q4 | 仅消费接口，TUI typecheck |
| H13 | 原生 `renderables/Code.d.ts` 若消费者需访问范围 setter | Q3/Q4 | 仅在确有 TypeScript 消费时保留；否则删除此槽位 |
| H14 | 既有 `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` 一处测试区 | Q2/Q3/Q4 | 相同正文 Part 实时图、正文公式、表格公式和美元原文 |
| H15 | 与 H14 同一个 TUI 测试文件的尾表数据驱动输入 | Q4 | 直接消费同包 util；默认模式与扩展模式都保住迟到尾表 inline/reference 链接。OpenCode 原回归文件不修改 |
| H16 | 本计划 | Q6/Q4 | 单一规范、裁决及实际 hunk 账本 |

H06–H13 最终保存在现有 `patches/@opentui%2Fcore@0.4.3-smark.13.patch`，不覆盖其前 249 行已有修复。若自然的构造/更新调用确实分成多个不相邻 hunk，分别列 H09a、H09b 等，仍须逐个证明直接影响；不为减少编号合并无关代码。

## 16. TDD 与验收

公共 seam：真实 Session Part 事件→终端帧，以及安装包 MarkdownRenderable→帧/表格单元格。先对当前基线运行并捕获缺失图/数学的红灯，然后一次接通一个行为 slice。混合帧同时包含真实公式与美元文字，负断言附着于功能 slice，不新增仅区别被撤回方案的测试。

1. 两批未闭合 Mermaid 图正文依次显示可见节点，闭围栏最终更新，再追加说明；原生图块的布局次数按每批 body 变化递增，闭合 +1，后文 +0。原 SDK 合批不改。
2. 段落 `\(x^2\)` 与独立 `\[\frac{1}{2}\]`；等待真正的异步高亮后仍可见，更新正文后仍正确。
3. 同一个 `\(x^2\)` 出现在表头与单元格，使用与正文相同结果；表格追加、链接、宽度与既有节点保持。普通无公式表格与基线逐帧对照。
4. 当前真实路径中已有的粗体/链接/conceal、未支持公式源文、窄宽切换与资源销毁；不测试或实现用户排除的新能力。
5. 上述同一数学/图功能 slice 中加入同批 final delta + completion，最后节点、闭围栏及公式都可见。另以 DSH 自带 provisional 行为对照第一批 `` `example\n\[x^2\]\nmore ``、第二批闭合反引号；流式终态与一次输入相同，公式源码仍归代码 span。这是保留基线普通 Markdown，不提供“代码内公式渲染”。

## 17–19. 代码形状、行长及验证命令

目标是数百行必要的渲染接线，不预先承诺全部 diff 小于某个数字。单列手写生产新增/删除、DSH 原逻辑搬入、生成锁、测试、文档与补丁上下文；不把复用代码或内部 diff 从总量里扣掉。本路线不复制 LaTeX 引擎，拟新增 1 个生产 util，修改入口/manifest/lock/现有 patch 和一份既有测试。原生代码变更以约 200–350 实际行、TUI util 约 180–260 行、入口约 10–20 行作为预算信号；行长要求拆行后如超出估计，据实际报告，不压成一行。原方案 805 行 patch 文本不作为实现额度。

行长计算遵循 Q4：现有目标生产文件修改前的字符数 / 行数，包含空行注释，乘 1.2 后向下取整作为新增/修改生产行上限。按 LF 规范和字符计数一致执行，不能增加填充注释或空格抬均值。当前 Session 入口基线均值 37.38，上限 44；manifest 均值 36.68，上限 44。原生补丁检查实际修改的生产目标文件，同时报告 patch 文本行数；未变的上下文不算新的生产行。新增 util 无修改前文件，不套用最终均值反算；保持正常多行格式，不把多条语句挤到一行。允许一行拆成多行，禁止多语句挤一行。锁与文档不伪装成生产代码。所有改动注释只说明必要约束和来源许可。

| 命令 | 目录 | 验证 |
|---|---|---|
| `bun install --frozen-lockfile` | 独立树根，实施获准后 | 发布包、patch 安装，完整锁 |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx` | packages/tui | Session 帧、原有行为 |
| `bun test test/routes/session/session-layout.test.ts` | packages/tui | 布局回归 |
| `bun typecheck` | packages/tui | 选项、包导出与调用一致 |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | packages/opencode | 表格/缓存与资源释放 |
| `git diff --check`、`git diff --numstat`、默认 `git diff -U3` | 独立树 | 空白、真实 hunk 账本、范围 |
| 对 Q4 的新增/修改行逐行长度核验 | 独立树，仓外工具 | 每文件均值、上限、超限清单 |

实施需另外对实际 npm 公共入口测 import/首次调用及暖调用，核实与 DSH 输出、CJK 宽度和字体样式兼容。必要临时实验留忽略目录，本文记录命令和结果；不将实验工具加入生产依赖。

## 20. 已知事项

目前没有需要用户决定的新功能。实际 npm 包导入开销、原生接线的 hunk 数及既有文件新增行长在实施时核验。方案阶段未安装包或修改产品代码；当前实施进度见 §23。

只恢复上下文所需的原生行为，不借机改普通 Markdown 的终态追加分块。主线 Session 测试有其他任务改动，实施时必须读取最新版本，在不覆盖的前提下工作；进入提交阶段时若同一路径混合变更，按 Workflow 停下来协调，不能提交他人内容。发布许可保留依赖的 MIT/Apache 许可，二进制分发另由发布验收负责。

## 21. 审计合同

对 Q1–Q6 和当前 revision 全文独立审计，逐项核对生产概念和每个实际变更区域。每个阻塞项应给出用户原文或相对固定基线的可见后果；禁止从未要求的语法边界推导新产品能力。方案审计批准只允许 exact revision 后续实施，当前终态为 verified-implementation-and-commit。

## 22. Revision Delta 与旧审计记录

R1–R6 曾由 `ses_ded498a9affeesM96hhvxToDuC` 审计，均为 BLOCK。最后裁决原文：**BLOCK — `docs/plans/terminal-explicit-math.md`，R6，第 6/6 轮全范围方案审计。** 当时唯一剩余 B-09 为闭合行制表符与自研“非空白”门槛不一致；B-01 至 B-08 在方案层关闭。那些版本未实施。

R7 按用户新原话重建全文：明确 DSH 直接来源，改为每批实时图；删除 R1–R6 的所有额外终态回读/封闭判断与全篇模式方案；共享普通正文/表格的行内输出；用公开依赖替代引擎副本；新增逐 hunk 和生产行长约束。本轮不是对旧闭合前禁画方案的第七次补丁修补，是 Workflow“需求更新→新审计任务”条款下的重审。其余原语法代码保持原生归属。

R7 独立方案审计 `ses_debd2bd64ffetaE52EDQHqcfij`（新需求第 1/6 轮）原裁决：**BLOCK — `docs/plans/terminal-explicit-math.md`，R7，全范围方案审计。** Blocking B-01 最后一批正文与完成事件合批时，闭合更新可能绕过原图块；B-02 移植 DSH 公式分块，却遗漏其必要的增量稳定边界。Non-blocking N-01 实验记录需补齐复核入口。Follow-up：无新增。未授权实施。

R8 delta：B-01 在同一 H05 中调整既有 props 次序并增加同批验收；B-02 在 H03/H07 直接承接 DSH 原函数和原判断，复用现有稳定前缀字段；N-01 补绝对源码目录和保存的可执行探针。未增加产品文件或新渲染能力；两处因果判断已实测。R8 已完成独立全范围复审，裁决原文见下。

## 23–24. 实施与实现审计

实施中，以下逐项补充实际 diff、红绿、测试、包导入、行长、逐 hunk 对照、实际源码复用来源和独立实现审计。最终本地 Commit 须正常通过钩子，不由方案批准替代。

2026-11-26 用户 GOAL continuation 明确将终态更新为 `verified-implementation-and-commit`，现按 exact R8 实施。主线已有 `f1cd9b8d55`，目标生产入口、包依赖和原生 patch 与固定基线相同；其 Session 测试变动为模型选择 fixture 和新增模型用例，原 Mermaid/数学接入 seam 未变。独立树继续从固定基线施工；集成主线时保留这些已提交修改，并在集成后的树重跑目标套件。

用户纠正：没有要求对新增文件按最终均值反算。删除本计划自行添加的该项规则；已有文件仍按修改前均值乘 1.2 核查。维护文档位于当前主工作区，独立工作树副本不再单独维护。

实施记录：已获本任务全部必要安装授权；两个依赖安装成功，公开 API 能绘制 `x²` 与真实 Mermaid 字符图。实时图用例先红后绿，公式/表格用例先红后绿。独立树 `packages/tui` 会话和布局合跑 47 pass / 0 fail / 773 assertions，`packages/opencode` 原生流式回归 10 pass / 0 fail / 31 assertions，TUI `bun typecheck` 通过。随后原生变更已生成 patch 并成功冻结回放；完整重测与最终 hunk/行长核查仍在进行。

R9 delta：用户已明确撤回 assistant 自设的新增文件最终均值规则，且文档现已维护于主工作区。已生成原生增量 patch 并通过冻结安装；R8 的 H15 跨包引入 TUI util 被原 Guard 的 B4 阻断，因此将同一数据驱动尾表用例移入 H14 所在的 TUI 测试文件，撤掉 OpenCode 测试修改。不增加 util 的公开包导出、不绕过 Guard、不新建测试文件。生产设计和验收内容保持 R8，待全范围方案复审。

## R8 独立方案裁决原文

审计任务 `ses_debd2bd64ffetaE52EDQHqcfij`；以下为完整裁决的行政登记，不改变设计。`Implementation allowed: yes` 仅表示 exact R8 已通过方案门禁；本轮用户选择仍是 `approved-plan-only`。

## Blocking findings

No blocking findings.

R7 的两项阻塞已在 **R8 方案层关闭**：

- **B-01：关闭。** `docs/plans/terminal-explicit-math.md:121` 将现有 `content` prop 移到 `streaming` 前，先交付最终正文，再稳定尾块。这与实际 Solid 属性更新顺序一致，直接修正交付接缝；`:168` 增加同批 final delta＋completion 的真实 Session 验收。
- **B-02：关闭。** `docs/plans/terminal-explicit-math.md:109` 承接 DSH 的 `mayBecomeCodeSpan` 稳定边界，并明确约束下一批可复用的前缀；`:147` 将生产改动落实到原生 parser，`:168` 覆盖流式与一次性输入的一致性。该修正保护新增数学分块影响的既有 Markdown 语义。

## Non-blocking findings

无新增非阻塞项。

**N-01：关闭。** `docs/plans/terminal-explicit-math.md:73`、`:83` 已补绝对源码目录、探针命令、fixture 范围和结果记录。已直接阅读 `F:/ML/PythonAIProject/Claude-Code/opencode/.temp/.testing/rich-plan-probe.ts`；其覆盖共享数学 token、DSH provisional 判断、原生 setter 顺序和受控引擎比较。

## Follow-up

无新增 Follow-up。普通引用定义及其他未受此次新增能力影响的旧 Markdown 问题继续留在本任务之外。

## Rejected speculation

- 不要求增加代码内公式、Mermaid 内公式或额外容器富渲染。
- 不将尚未产生的实际行数、hunk 数或包启动耗时推定为缺陷。
- 不要求迁移 DSH 完整流式状态、另建 parser，或恢复全篇终态回读机制。

## Requirement and traceability coverage

本轮覆盖 Q1–Q6、R8 全文、H01–H16，以及相应生产者、消费者和验证路径。

| 要求 | 结论 |
|---|---|
| Q1：复用 DSH | 原函数、引擎来源及数学分块所需稳定边界均有明确归属。 |
| Q2：实时图与块边界 | body 变化、闭合最终更新、后续正文复用和同批完成路径均有实现位置与验收。 |
| Q3：显式公式入口 | 圆括号行内公式、方括号显示公式及美元原文均有映射。 |
| Q4：正文与表格共享、克制改动 | 共用 inline 输出；正文异步高亮接线有源码依据；逐 hunk 和行长检查保留。 |
| Q5：规模与依赖 | 两个现成依赖、一个生产 util，避免复制 LaTeX 引擎；实际规模留待 diff 验收。 |
| Q6：先完成方案 | 产品文件与固定基线一致，当前工作树仅有计划文件。 |

**Revision Delta 审查：** 新增内容限于已有 props 的次序调整、DSH 原有稳定边界接线及对应验收。两项都修复上轮明确的需求失败或回归；撤回它们会恢复原阻塞。未发现为消除非严格问题而扩张设计。

测试仍以基线缺失图或公式能力为红灯，保留行为断言附着于这些功能 slice，符合测试敏感性要求。

## Primary-path and fallback verdict

通过。权威路径保持为：

**原生增量 Markdown → DSH token／渲染函数 → 原生节点和 chunks。**

稳定边界回调只限制同一 parser 的前缀复用，没有新增第二棵语法树、计时器、队列或全篇模式。未闭合、不支持和过宽输入的源文显示仍属于已声明的显示契约；未增加失败后尝试另一引擎的成功路径。

方案代码形状与职责划分通过审查。实际风格、类型、行长、依赖运行和最终 diff 由实现阶段验证。

## Release verdict

**APPROVE — `docs/plans/terminal-explicit-math.md`，exact R8，全范围方案审计，第 2/6 轮。**

- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- 审计计划 blob：`d67a957209d5325ce58f6116027d4cea9e8dcf00`
- 未解决阻塞：**0**

验证边界：本轮完成源码、探针文件和只读 Git 核验，未重新运行 Bun 探针。实际 npm 包入口、红绿测试、行长及 hunk 账本仍是计划明确要求的实施验收项。

本轮终态为方案批准；实施、安装和提交留在后续授权阶段。

## R9 独立方案裁决原文

任务 `ses_debd2bd64ffetaE52EDQHqcfij`，本节仅作行政登记。

用户纠正原话：
> 我不是已经说的很清楚了吗？我没有要求你按最终均值反算。谁告诉你这样的逻辑了？这种逻辑又不是我说的，你问我干嘛呀？就跟我没有说太阳从西边升起，你开始又问我说太阳从东边升起，这个是否成立？你是有毛病吗？

## Blocking findings

No blocking findings.

R9 保留了 B-01、B-02 的修正路径。本轮变更未引入新的需求缺口、行为回归或替代成功路径。

## Non-blocking findings

### N-02 当前状态与历史记录仍有混写

`F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md:53`、`:190`、`:196`、`:210–218` 同时保留了“产品文件与基线一致”“本轮只完成方案”“实施记录为空”“尚需生成 patch”及后续实施记录。

建议作行政修正：标明历史阶段，统一当前状态，并将本次用户纠正原话完整登记。它们不改变可执行方案，也未构成实现已获放行的声明，因此不阻塞本次方案批准。

另外，独立树中的 `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts:7` 仍存在跨包相对导入。R9 已明确要求撤回；**H15 迁移目前是实施待办，不能登记为已完成。**

## Follow-up

无新增 Follow-up。

## Rejected speculation

- 新增 util 没有修改前文件，不再套用最终均值反算；不据此增加另一套行长规则。
- 不因测试迁移增加 util 的公开包导出、Guard 豁免或新测试文件。
- 不以目标行数估算代替实际需求覆盖和 diff 验收。

## Requirement and traceability coverage

已复核 Q1–Q6、R9 全文、H01–H16、当前相关源码与在制变更，并检查主线新增提交对集成位置的影响。

| 范围 | 结论 |
|---|---|
| Q1–Q3：DSH 复用、实时图、显式公式 | 生产设计与 R8 一致，原生 lexer、渲染节点及异步高亮接线继续完整映射。 |
| Q4：正文/表格共享、hunk、行长 | 既有文件仍按修改前均值的 1.2 倍核查；删除新增文件的自设反算规则符合原始要求。 |
| Q5：规模与依赖 | 保留两个依赖、一个生产 util；没有新增生产概念。 |
| H15 测试迁移 | 移入 TUI 包内直接消费同包 util，保留默认/扩展模式及 inline/reference 尾表验证；原 OpenCode 回归继续运行。 |
| 主线集成 | 已核实 `f1cd9b8d55` 对相关 Session 测试 fixture 的改动；R9 要求保留并在集成后重跑，覆盖充分。 |
| 当前阶段 | 本次执行方案审计。实现验证与本地提交仍须完成各自门禁。 |

H15 的迁移有明确仓库依据：`script/guard/check.ts:438–441` 对测试同样禁止跨包相对导入。将测试留在 util 所属包，减少了改动文件和接口暴露，验证内容没有缩减。

本轮 Revision Delta 是约束纠正和测试位置调整，未增加状态、分支或产品能力。功能测试的基线红灯要求及原行为保护断言仍然保留。

## Primary-path and fallback verdict

通过。权威路径保持为：

**原生增量 Markdown → DSH token／渲染函数 → 原生节点和 chunks。**

R9 没有改变解析、闭合更新、稳定前缀或高亮提交的责任归属，也没有新增 fallback。

方案层的代码形状与范围约束通过。当前在制代码的完整正确性、实际行长、测试完成度和安装回放结果，仍需实现审计独立核验；计划中的测试通过记录未被本轮直接视为放行证据。

## Release verdict

**APPROVE — exact R9，全范围方案审计，第 3/6 轮。**

- 唯一 canonical plan：`F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md`
- 计划 blob：`b059649c198f73e599f7c2f57e1d0a0a207cb4aa`
- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- 未解决方案阻塞：**0**

本次批准适用于 R9 的后续实施合同，不构成当前 implementation diff 的放行，也不替代提交前的独立实现审计。

行政处理 N-02：已标明历史与当前阶段，登记完整纠正原话。H15 移动和跨包测试撤回在下轮验证后记录。

R9 实施补充：H15 已移入同一 TUI 测试文件，OpenCode 测试恢复基线；Guard 0 errors。最小锁只新增 8 行，冻结安装成功。隔离树已快进到主线 `f1cd9b8d55` 并自动合并本任务测试，52 个相关测试/790 断言及 TUI typecheck 通过，原生回归 10 个通过。仓外真实引擎与 native 探针通过 16 个断言：图调用 `1,2,3,3`、稳定图身份、窄宽切换、异步高亮、原 DSH provisional。既有生产文件新增行符合上限（native JS 39、声明 44、Session 44、manifest 44）。

R10 delta：普通代码示例对照实测发现上述 DSH helper 与原 lexer 不一致，富模式生成 `paragraph, mathBlock, paragraph` 并错误显示 `y²`，默认模式是一个 paragraph/code span。H03 将已闭合 code span 判断直接委托本次原 lexer，其余生产路径和文件不变；H14 数学功能 slice 补原文对照。此处为原 Markdown 回归修复，未增加新语法、状态、依赖或文件，待全范围复审。

R10 审计 `ses_debd2bd64ffetaE52EDQHqcfij` 第 4/6 轮原裁决：**BLOCK — exact R10，全范围方案审计，第 4/6 轮。** B-03 完整代码跨度与稳定前缀仍采用不同的闭合规则；无新增非阻塞项、无新增 Follow-up。反例第一批 `` `C:\` `example\n\[y^2\]\nmore ``，第二批追加反引号；原生已关闭的第一段不能让 DSH 忽略第二段的真实开启符。

R11 delta：在同一 H03/H07 统一完整与 provisional 的代码跨度裁决，删除重复配对，回调接收原生 tokenizer 的纯 codespan 函数。三组隔离输入实测：完整跨行例得到 1 个 span/0 个 open，第一段已闭合加第二开启得到 1 个 span/1 个 open，单独未闭合得到 0 个 span/1 个 open。新旧判断一致性是此次根因修正，文件、依赖、产品能力不变；同一数学 slice 覆盖 R10 例和 B-03 两批例。R11 已获独立全范围批准，原文如下。

## R11 独立方案裁决原文

任务 `ses_debd2bd64ffetaE52EDQHqcfij`。

## Blocking findings

No blocking findings.

**B-03 在 R11 方案层关闭。**
`F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md:109–110` 已明确：

- 完整跨度识别与 provisional 判断共用原生 `codespan`。
- 已匹配跨度整体跳过，剩余未匹配开启符用于限制稳定前缀。
- 删除原 `backtickRuns/unmatchedBacktickRuns` 的重复配对规则。
- `stablePrefix` 从同一原生实例取得函数引用。

这直接消除了上轮反例中“第一段的关闭符被忽略，随后第二段的开启符被错误配对”的原因。原生规则及其返回的 raw 范围可在 `node_modules/@opentui/core/index.js:5625`、`:6042–6046` 核实。计划 `:368` 将 R10 完整输入反例与 B-03 两批输入纳入同一数学功能 slice。

## Non-blocking findings

### N-03 R11 新增隔离实验需补复核入口

计划 `:368` 记录了三组 span/open 结果，但没有对应命令或脚本位置；`:83` 指向的现有 `rich-plan-probe.ts` 尚未包含这三组新扫描实验。

补充已有实验的命令、位置和测试范围即可。该项属于证据记录补全，不改变方案，也不阻塞本次批准。

## Follow-up

无新增 Follow-up。

## Rejected speculation

- 不要求增加代码内公式、额外容器或通用闭合状态机。
- 不要求重新实现反引号闭合算法；现有原生 tokenizer 已拥有该语义。
- 不将尚未完成的实现验收数字作为方案缺陷或通过证据。

## Requirement and traceability coverage

本轮覆盖 Q1–Q6、R11 全文、H01–H16，以及相关生产者、消费者和当前源码。

| 范围 | 结论 |
|---|---|
| DSH 来源、显式公式、正文与表格共享 | 原映射完整保留。 |
| Mermaid 实时更新、闭合最终更新、后文复用 | 原路径与验收保持；内容先于完成态交付的修正保留。 |
| 普通 Markdown 与稳定前缀 | R11 统一完整/provisional 闭合依据，解决 B-03。 |
| 接口与文件范围 | 函数引用参数落实在既有 H07/H12；未增加依赖、文件、配置或第二棵语法树。 |
| 测试敏感性 | 图和公式能力继续提供基线红灯，代码原文保护断言附着于同一功能 slice。 |
| 行长、hunk 与提交终态 | 保留用户纠正后的约束，以及实现审计、安装回放和正常提交门禁。 |

**Revision Delta 审查：** 此次增加的是必要函数接线，同时删除重复配对规则。它解决已有行为回归，没有扩张产品能力。撤回统一规则会恢复 B-03；无需保留旧判断作为备用路径。

## Primary-path and fallback verdict

通过。权威路径仍为：

**原生增量 Markdown → DSH token／渲染函数 → 原生节点和 chunks。**

原生 tokenizer 负责代码跨度语义，扩展只据其结果决定数学分块和稳定边界。未新增失败后切换实现的路径。

方案层的职责与代码形状通过审查。当前在制 util 尚保留旧配对 helper；其删除、函数接线及回归验证仍须在实现阶段完成。

## Release verdict

**APPROVE — exact R11，全范围方案审计，第 5/6 轮。**

- Canonical plan：`F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md`
- 计划 blob：`00565ff3b284f65853e6be0dbf337c2155778169`
- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- 未解决方案阻塞：**0**

本轮完成源码与只读 Git 核验，未重跑 Bun 实验。批准仅适用于 R11 方案；当前 implementation diff、最终测试结果及提交仍需独立实现审计放行。

## 最终实施证据

当前隔离树 HEAD 为 `f1cd9b8d5561143abeafc7675eaf602ba1dad74e`；固定需求基线仍为 `07395e4a82d40d950e6c83186cbbbf51680b6888`。主线新提交已合入隔离树，原模型 fixture 和测试完整保留。主工作区仅维护本文，其他任务的暂存与未暂存内容保持原样。

实际六个产品/测试/依赖文件的 diff 为 1030 additions / 1 deletion；本文另计。原生 patch 前 249 行保持原样，追加 561 行 transport diff；其实际源码为 353 additions / 18 deletions。手写 util 288 行、入口 10 additions / 1 deletion、manifest 2 行，合计生产源码 653 additions / 19 deletions。锁只有 8 行新增，测试 161 行新增。不以 patch transport 和源码重复相加冒充生产规模。

TDD 与修正：真实 Session Mermaid 用例先显示源码，图形断言红灯；公式用例先显示 `(x^2)` 等源码，字形断言红灯。接线后转绿。宽度事件重入在最初窄用例中暴露并修正。测试跨包引入由 Guard B4 阻断，按 R9 移回 TUI 包；函数复杂度通过拆分实际宽度显示职责解决。R11 把 DSH 重复反引号配对替换为原生 codespan，原完整与两批代码示例保持源码。一次测试曾发送更短的旧 Part，被现有累积流规则正确忽略；测试已改成真实追加，不改生产流处理。同一功能 slice 继续验证公式关闭与完成事件同批到达。

| 最终命令 | 工作目录 | 结果 |
|---|---|---|
| `bun install --frozen-lockfile` | 独立树根 | 原生 patch 与最小锁回放成功 |
| `bun test --timeout 30000 test/cli/cmd/tui/session-message-render.test.tsx test/routes/session/session-layout.test.ts` | 独立树 `packages/tui` | 52 pass、0 fail、797 assertions |
| `bun typecheck` | 独立树 `packages/tui` | 通过 |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | 独立树 `packages/opencode` | 10 pass、0 fail、31 assertions |
| `bun test F:/ML/PythonAIProject/Claude-Code/opencode/.temp/.testing/rich-runtime-probe.test.ts` | 独立树 `packages/tui` | 1 pass、17 assertions；真实 lovely 引擎计数 1/2/3/3、节点复用、窄宽切换、异步高亮、conceal 和 provisional 均通过；捕获终端 span 的 `x²` bold=1、`y²` 为链接颜色 |
| `bun --no-install .temp/.testing/rich-plan-probe.ts --installed` | 主工作区根 | 18 个实际公开包/DSH 输出对照、3 个 native span/open 对照通过；同时重跑正文/表格共享 token 与更新次序实验 |
| `bun script/guard/check.ts . --files packages/tui/src/util/rich-markdown.ts,packages/tui/src/routes/session/index.tsx,packages/tui/package.json,packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | 独立树根 | 0 errors，3 个非阻断提示 |
| `git diff --cached --check` | 独立树根 | 通过 |

已安装两个公开入口首次联合导入单次测量 53.824ms、RSS 增加 10,383,360 bytes；中文图标签、中文文本、负间距、上下标和分式输出正常。这是本机单次观测，不作跨平台性能保证。原生 JS 上限 39、声明/入口/manifest 上限 44，所有新增生产行检查 0 violations；新增 util 按用户纠正使用正常多行格式。N-03 的可复核入口为上表 `rich-plan-probe.ts --installed`，实验代码位于 `.temp/.testing/rich-plan-probe.ts:70` 起。

路径清单：普通 token 仍走原生渲染，math token 走共享 literal chunks，显示公式与 Mermaid 走同一原生自定义块节点。未完成或引擎未接受的输入及宽度不足沿 DSH 约定显示源码，属于批准的输入/显示分支；没有新增备用 parser、计时器、用户开关或缓存层。已删除 DSH 的 `backtickRuns/unmatchedBacktickRuns` 配对，使用原生 tokenizer 的同一闭合语义。

### 实际 Hunk 台账

下表行号取固定生产文件的修改前位置；每个逗号分隔的位置均为独立实际 hunk。外层使用 `git diff --cached -U3`，原生使用基线快照对应的 `git diff -U3`。

| 文件 / hunk 位置 | 槽位 / 需求 | 必要变化 |
|---|---|---|
| `bun.lock` 949、964、1527、4299 | H02 / Q1、Q5 | 两个直接依赖与发布包依赖图 |
| `packages/tui/package.json` 50、65 | H01 / Q1、Q5 | 两个精确版本公开包 |
| `packages/tui/src/routes/session/index.tsx` 99 | H04 / Q1 | 引入适配器 |
| 同文件 2594 | H05 / Q2、Q3 | 每个正文实例的配置 |
| 同文件 2610 | H05 / Q2、Q3 | 接线与最终 content 先交付 |
| `packages/tui/src/util/rich-markdown.ts` 新文件 | H03 / Q1–Q5 | DSH 显式定界符与渲染适配、原生跨度回调 |
| `session-message-render.test.tsx` 1、311 | H14、H15 / Q2–Q4 | 同包真实 Session 与尾表行为 |
| 原生 `index.js` 5590、5756 | H06 / Q2 | 原围栏匹配器提供闭合事实 |
| 同文件 7901、7932、7946 | H07 / Q2–Q4 | 原增量 parser 使用配置 lexer 与稳定前缀 |
| 同文件 8010、8042、8138 | H07 / Q2–Q4 | 实例配置与原 tokenizer 函数引用 |
| 同文件 8175、8202、8298 | H08 / Q3、Q4 | 初始 seed、正文/表格及样式继承 |
| 同文件 8323、8342 | H09 / Q3、Q4 | 创建节点并定位已有 math token 范围 |
| 同文件 9007、9158 | H09 / Q3、Q4 | 原节点创建/更新调用点传入范围 |
| 同文件 9173 | H11 / Q2 | 已稳定自定义块复用 |
| 同文件 9266 | H07 / Q2–Q4 | 增量 parser 调用接线 |
| 原生 `index-b5dpwnes.js` 3481 | H10 / Q3、Q4 | 范围更新只使受影响缓存失效 |
| 同文件 3513 | H10 / Q3、Q4 | 高亮前缀按完整 literal 边界提交 |
| 同文件 3538 | H10 / Q3、Q4 | 字形与原高亮 chunks 同一路径合并 |
| 原生 `renderables/Markdown.d.ts` 4、67、158 | H12 / Q2–Q4 | 实际消费接口；H13 没有 TS 消费故未增加 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 247 | H06–H12 / Q2–Q4 | 上述 23 个原生 hunk 的可重放载体 |
| 本文新文件 | H16 / Q4、Q6 | 规范、逐项映射及审计证据 |

实现审计已放行，正常提交钩子、提交与主线集成在其后完成并以 Git 记录核对。运行验证范围为 Windows；未执行 macOS/Linux 运行验收。无新增 Follow-up 产品需求。

## 历史 R10 审计原文

以下为任务 `ses_debd2bd64ffetaE52EDQHqcfij` 第 4/6 轮原文；B-03 已由上文 R11 处理。

## Blocking findings

### B-03 完整代码跨度与稳定前缀仍采用不同的闭合规则

- **Violated invariant:** I4 要求保持普通 Markdown 语义；同一最终文本的流式与一次性输入应一致。
- **Evidence class:** reachable
- **Producer and execution path:** 普通助手正文可以先输出以下三行，再追加一个反引号：
  ```text
  `C:\` `example
  \[y^2\]
  more
  ```
  原生 tokenizer 将第一行的 `` `C:\` `` 识别为完整代码跨度，后面的反引号开启另一个尚未闭合的跨度。保留的 DSH `backtickRuns` 却忽略反斜线后的关闭反引号，将第一个开启符与第二个开启符配成一对，于是 `mayBecomeCodeSpan` 返回 false。首批的 paragraph、mathBlock、paragraph 因而允许固定第一个 paragraph。下一批关闭符到达后，尾部重读已经看不到真正的开启符。
- **Source evidence:**
  - `packages/tui/src/util/rich-markdown.ts:229–254`：过滤“转义”反引号后配对。
  - 同文件 `:277–290`、`:130–141`：上述判断决定可稳定前缀。
  - `node_modules/@opentui/core/index.js:5625`、`:6042–6046`：原生 codespan 允许关闭反引号前出现反斜线。
  - 同文件 `:7941–7945`、`:7954–7978`：三 token 首批可以稳定一个 token，后续直接复用该前缀。
- **Canonical-plan evidence:** `F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md:109–110` 明确只替换完整跨度判断，并继续原样使用 `mayBecomeCodeSpan`；`:364` 将 R10 修正范围限定于已闭合跨度。
- **Responsibility owner:** 数学 block extension 与原生增量 parser 之间的稳定边界判断。
- **Concrete behavioral consequence:** 最终流式结果仍残留 mathBlock 并显示 `y²`；完整输入应将该公式源码保留在第二个代码跨度内。只修改 `start` 的完整跨度判断无法修复已经复用、脱离尾部解析的开启符。
- **Pre-R1 baseline behavior on the same path:** 基线没有 mathBlock 扩展，这段正文保持一个 paragraph，尾部重读包含所有反引号，最终识别两个代码跨度并保留 `y^2` 原文。
- **Round basis (later rounds):** strict class：相对固定基线的普通 Markdown 回归；R10 明确保留的 provisional 判断仍能产生该后果。
- **Minimal correction direction:** 让完整跨度识别与稳定前缀判断共享原生 tokenizer 的闭合语义，收拢现有分歧，并把上述两批输入附加到同一数学功能 slice，无需新增状态机或解析器。

## Non-blocking findings

无新增非阻塞项。

**N-02 的主要记录问题已处理。** 当前阶段与历史阶段已区分，用户纠正原话已登记；已直接核实 OpenCode 测试恢复基线，H15 数据驱动用例已移入 TUI 测试文件。

## Follow-up

无新增 Follow-up。

## Rejected speculation

- 不要求增加代码内公式渲染。B-03 保护的是基线已有的代码原文显示。
- 不要求扩展到新的容器、图内公式或通用括号状态。
- 不以估算行数、尚未独立重跑的性能数字或假设中的依赖问题提出阻塞。

## Requirement and traceability coverage

本轮复核了 Q1–Q6、R10 全文、H01–H16、当前相关源码及 Revision Delta。

| 范围 | 结论 |
|---|---|
| DSH 复用、显式公式、正文/表格共享 | 原映射保留。 |
| Mermaid 实时更新、闭合更新、后文复用 | 原设计与验收保留；B-01 的交付顺序修正仍在。 |
| 普通 Markdown 与稳定前缀 | R10 修正了完整输入中的闭合差异，但 provisional 路径仍有 B-03。 |
| hunk、行长、依赖及文件范围 | 保持 R9 的约束，没有新增文件、依赖或用户配置。 |
| H15 与主线集成 | 测试已迁入所属包；独立树 HEAD 已为 `f1cd9b8d55`。 |
| 验证与提交终态 | 实现测试、安装回放、独立实现审计和正常提交门禁继续保留。 |

R10 调用原生 `codespan` 的方向合理，减少重复的闭合规则。修正应覆盖现有完整/暂定两处判断的语义一致性；撤回 R10 会恢复其已定位的完整输入回归。

## Primary-path and fallback verdict

原生增量 Markdown、DSH 渲染函数及原生节点的主路径仍然清晰，没有新增引擎或失败后切换 parser 的路径。

当前阻塞位于该主路径内部：**完整跨度识别已经计划复用原生规则，稳定前缀仍保留与之冲突的闭合规则。** 方案尚未完成这一处根因修正。

实际代码质量和实现验证结果仍须由后续实现审计核验。本轮未执行 Bun；B-03 依据直接读取的规则、调用链和可满足输入，分类为 reachable。

## Release verdict

**BLOCK — exact R10，全范围方案审计，第 4/6 轮。**

- Canonical plan：`F:/ML/PythonAIProject/Claude-Code/opencode/docs/plans/terminal-explicit-math.md`
- 计划 blob：`ead30a40b0633b4cfca593aba6d3b4e6b46517d8`
- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- 未解决阻塞：**B-03**

修订后需再次全范围审计；R9 的批准不自动覆盖 R10 的语义变更。

## 实现审计第 1 轮原文

任务 `ses_dea5bf0b6ffej4Ous4rsk3mqme`。

## Blocking findings

### B-01 稳定前缀被旧值永久限制，流式解析退回全文重读

- **Violated invariant:** I4，以及 Q2 的块边界优化要求。Canonical §9–10 明确要求：没有 provisional 组合时保留原来的两 token 尾部策略。
- **Evidence class:** reachable
- **Producer and execution path:** 助手正文经 SDK 合批、`TextPart`、带 `rich.syntax` 的 Markdown 实例进入 `parseMarkdownIncremental`。首批只有一两个 token 时，`stableTokenCount` 为零。
- **Source evidence:**
  - `packages/tui/src/routes/session/index.tsx:2600–2624`：所有预算内正文启用扩展。
  - `patches/@opentui%2Fcore@0.4.3-smark.13.patch:468–470`：复用数量受上一批 `stableTokenCount` 限制。
  - 同文件 `:490–493`：流式状态下，新稳定数量又取本批已经复用的 `stableTokens.length`。
  - 安装后对应实现：`node_modules/@opentui/core/index.js:7936–7947,7970–8000`。
- **Canonical-plan evidence:** §6–8 I4；§9–10“没有该组合时保留原两 token 尾部策略”；H07。
- **Responsibility owner:** 原生增量 Markdown parser 的稳定边界推进。
- **Concrete behavioral consequence:** 首批稳定数量为零后，后续每批都满足“复用数量 ≤ 旧稳定数量 = 0”，新稳定数量继续为零。即使随后出现大量完整普通段落，也一直执行 `lex(newContent)`。这是正常流式正文每批可达的全文重复解析；已有块节点仍可复用，但词法前缀优化已经失效。
- **Pre-R1 baseline behavior on the same path:** 基线按 raw 匹配前缀，再扣除两个不稳定 token；随着完整块增多，复用前缀可以增长，不受上一批稳定数量的永久上限约束。
- **Round basis:** 首轮实现审计；相对固定基线的热路径退化。
- **Minimal correction direction:** 在原 parser 内恢复稳定边界的正常推进，仅让 DSH provisional 判断限制当前允许稳定的位置，并在现有流式功能 slice 验证前缀能够增长。

### B-02 转义反引号后的剩余 run 仍与原生 lexer 语义不一致

- **Violated invariant:** I4 要求保留普通 Markdown 原文语义；R11 要求跨度定位与稳定边界共用原生代码跨度语义。
- **Evidence class:** reachable
- **Producer and execution path:** 普通助手正文可以包含以下合法 Markdown：
  ```text
  \``example
  \[y^2\]
  `
  ```
  原生 inline lexer 先消费转义的第一个反引号，剩余反引号开启跨行 code span。新增 `codeSpans` 却把整个连续 run 一并跳过，随后 block extension 把中间一行切成数学块。
- **Source evidence:**
  - `packages/tui/src/util/rich-markdown.ts:240–243`：`matchAll(/`+/g)` 找到整个 run，`isEscaped` 为真时直接跳过。
  - 同文件 `:67–74,254–269`：上述结果决定是否允许数学块切断段落。
  - `node_modules/@opentui/core/index.js:5624–5625`：原生 escape 与 codespan 规则。
  - 同文件 `:6239–6241,6261–6263`：escape 消费后，剩余输入继续交给 codespan。
- **Canonical-plan evidence:** §9–10 的原生 codespan 统一规则；§16.5 的普通代码原文保护；R11 Revision Delta。
- **Responsibility owner:** H03 中数学块起点判断使用的代码跨度定位。
- **Concrete behavioral consequence:** 上述输入会被拆出 `mathBlock` 并显示 `y²`，原代码示例中的 `y^2` 被解释为公式。闭合判断虽然调用了原生 `codespan`，调用前的 run 跳过规则仍改变了原生输入位置。
- **Pre-R1 baseline behavior on the same path:** 基线没有数学 block extension，这段内容保持一个 paragraph；原生 inline lexer 得到转义字符加完整 code span，保留公式源码。
- **Round basis:** 首轮实现审计；新增扩展造成的普通 Markdown 回归。
- **Minimal correction direction:** 在现有跨度定位中保留原生 escape 消费后剩余的反引号，再交给同一个 codespan，并将该原文对照附加到现有数学功能 slice。

## Non-blocking findings

无新增非阻塞项。

## Follow-up

无新增 Follow-up。

## Rejected speculation

- 不要求增加列表、引用、代码块或 Mermaid 标签内的公式能力。
- 不对新增 util 按最终均值反算行长。
- 不把 Pi 包携带的 Marked 依赖视为第二条解析路径；当前接线仍调用 OpenTUI 的 lexer。
- 不将 one-shot 高亮路径列为公式丢失问题：本次正文节点由 `createMarkdownCodeRenderable` 固定以 `streaming: true` 创建。

## Requirement and traceability coverage

本轮覆盖 Q1–Q6、R11 全文、六个实现文件的全部 diff、23 个新增原生源码 hunk，以及直接相关的生产者和消费者。

| 要求 | 审计结果 |
|---|---|
| Q1：复用 DSH | 已直接核对 DSH 定界符、公式输出、Mermaid 引擎和宽度显示策略；来源许可保留。 |
| Q2：实时图、闭合更新、后文复用 | body/closed 与节点复用接线存在；增量词法边界存在 B-01。 |
| Q3：显式公式入口 | 圆括号行内公式、独立方括号显示公式、美元原文路径均已接线。 |
| Q4：正文与表格共享、保护原行为 | 共用 inline 回调，正文异步高亮消费 literal ranges；普通代码原文存在 B-02。 |
| Q4/Q5：范围与规模 | diff 为 1025 additions / 1 deletion；既有 patch 前缀保留，两个依赖、一个生产 util，未发现计划外产品文件。 |
| Q6：验证并提交 | 实现审计尚未放行；提交仍属后续阶段。 |

已核对固定基线至当前 HEAD 的相关文件差异：已提交的模型选择 fixture 与测试变动保留，本任务没有覆盖它们。

**验证状态：**
- 已独立执行只读 Git 核验，`git diff HEAD --check` 通过。
- 已阅读新增测试和两个现有探针；图形、公式字形断言能区分基线缺失能力。
- Bun 测试、typecheck、Guard、安装回放和行长检查的通过数字目前来自 canonical 记录，本轮尚未独立复跑或核验原始执行输出。运行授权请求仍待回复。

## Primary-path and fallback verdict

权威路径保持为：

**Session Part → 原生增量 Markdown → DSH token／渲染函数 → 原生节点与 chunks。**

未发现新增备用 parser、失败后切换引擎、配置逃生路径或全局缓存。未支持、未闭合及过宽输入显示源码，符合批准的 DSH 显示契约。

当前阻塞发生在主路径内部：稳定边界推进错误，以及跨度定位仍有语义分歧。

## Code quality verdict

**未通过。** B-01 破坏增量解析范围，B-02 造成已有 Markdown 行为回归。

其余已检查区域未发现新增 `any`、类型抑制、失效 helper、计划外重构或测试断言削弱。必需运行验证仍需完成独立核验。

## Release verdict

**BLOCK — exact R11，首轮全范围实现审计（1/3）。**

- 仓库：`D:/Temp/opencode/tui-explicit-math-local`
- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- 当前 HEAD：`f1cd9b8d5561143abeafc7675eaf602ba1dad74e`
- 审计对象：当前 `git diff HEAD --` 与指定 canonical
- Canonical blob：`c261ba11558716a7916aa4d8067bd61b0b9691fb`
- 未解决阻塞：**B-01、B-02**

修正后需完整复审，并补齐运行验证核验，方可进入 verified 与提交阶段。

## 实现审计返工记录

B-01/B-02 均已实际复现。增量探针第八批对 188 字符全文重新词法解析，现有数学 Session slice 中转义反引号例错误显示 `q²`，两者红灯。H07 按当前 token 数推进允许稳定的边界，再由既有 provisional 限制；未开启扩展的实例保持原算法。H03 按原 escape 一次消费一个反引号，将剩余 run 交原 codespan。没有新增生产概念、文件或 parser，属于 R11 批准路径的实现返工。

修正后窄 Session 用例通过 13 assertions；增量探针末批只解析 46/188 字符，全部 17 assertions 通过，真实图引擎计数仍为 1/2/3/3。`bun typecheck` 通过。新版原生差异已物化，等待最后冻结回放和原范围完整复审。
上述返工的最终冻结安装已通过，原范围完整重测为 52 pass / 797 assertions、原生 10 pass / 31 assertions、TUI typecheck 通过、Guard 0 errors。实际 hunk 位置不变，新增行长仍符合原上限。现送第二轮全范围实现审计。

## 实现审计第 2 轮最终原文

任务 `ses_dea5bf0b6ffej4Ous4rsk3mqme`。本轮中间裁决因缺少独立运行核验而暂为 BLOCK；补齐 `F:/ML/PythonAIProject/Claude-Code/opencode/.temp/.testing/rich-verification.log` 及其执行器后，同轮最终裁决如下。代码 diff 未改变。

## Blocking findings

No blocking findings.

**B-01、B-02 均已关闭，第二轮运行验证门禁已补齐。**

- **B-01：** 稳定边界按当前 token 数推进；真实探针末批仅解析 **46/188 字符**，不再持续全文重读。见 `patches/@opentui%2Fcore@0.4.3-smark.13.patch:490–497`、`.temp/.testing/rich-verification.log:86`。
- **B-02：** 转义仅消费一个反引号，剩余 run 交给原生 codespan；对应输入已进入现有数学 Session slice，完整套件通过。见 `packages/tui/src/util/rich-markdown.ts:240–244`、`packages/tui/test/cli/cmd/tui/session-message-render.test.tsx:394`。

## Non-blocking findings

**N-01：关闭。** Canonical `docs/plans/terminal-explicit-math.md:446` 已更新为 1030 additions / 1 deletion、util 288 行、patch 新增 561 行，与当前 Git 结果一致。

无新增非阻塞项。

## Follow-up

无新增 Follow-up。

## Rejected speculation

- 不要求增加额外容器、代码内公式或第二套解析器。
- 不对新增 util 按最终均值反算行长。
- Guard 的三个提示已结合源码审查：可选扩展配置及 DSH 已约定的源码显示分支有明确归属，不构成新增备用成功路径。

## Requirement and traceability coverage

本次完成**当前第二轮**的证据核验，沿用同轮对 Q1–Q6、R11、全部六个实现文件及 23 个原生源码 hunk 的全范围审查。

已直接阅读 `.temp/.testing/rich-verify.ts` 与完整 `.temp/.testing/rich-verification.log`，核对命令、工作目录、输出、退出码及执行前后 diff 一致检查。另以只读 Git 核对：
- HEAD 与日志一致；
- 六个实现文件的对象标识与本轮已审 diff 一致；
- 三个已安装原生文件的差异对象标识与 transport patch 一致。

| 验证 | 核验结果 |
|---|---|
| 冻结安装 | exit 0，依赖无变化 |
| TUI Session 与布局测试 | **52 pass / 0 fail / 797 assertions** |
| TUI `bun typecheck` | exit 0 |
| OpenTUI 原生流式回归 | **10 pass / 0 fail / 31 assertions** |
| Guard | **0 errors，3 个非阻断提示** |
| 真实引擎与原生运行探针 | **1 pass / 17 assertions**；布局调用 1/2/3/3，节点复用、宽度切换、异步高亮、conceal、provisional 通过 |
| 已安装公开 API 与 DSH 对照 | **18 项输出对照及 3 项跨度探针通过** |
| 既有生产文件行长 | 全部 **0 violations** |
| diff 空白及执行前后稳定性 | 通过 |

图、正文公式、表格公式、美元原文、闭合更新、后文复用与普通代码原文保护均有对应实现和验证。

## Primary-path and fallback verdict

通过。

**Session Part → 原生增量 Markdown → DSH token／渲染函数 → 原生节点与 chunks** 保持为权威路径。

本轮返工在原 owner 内修正稳定边界与跨度定位，没有增加解析器、缓存层、计时器、配置开关或失败后切换实现的路径。

## Code quality verdict

通过。

完整 diff 与批准的 R11 范围一致；上轮回归已修复，原有断言保留，必要运行检查通过，失效的重复反引号配对规则已删除。新增概念与 hunk 均能映射到原始需求或必须保持的既有行为。

运行验证覆盖 Windows；macOS/Linux 仍为已披露的未执行项。

## Release verdict

**APPROVE — exact R11，第二轮全范围实现审计（2/3）。**

- 仓库：`D:/Temp/opencode/tui-explicit-math-local`
- 固定基线：`07395e4a82d40d950e6c83186cbbbf51680b6888`
- HEAD：`f1cd9b8d5561143abeafc7675eaf602ba1dad74e`
- Canonical blob：`aa237f67b960a963d441dfd8dcf9ba34e9797e28`
- Patch blob：`e64927f2f3224d74118a0117e3083b48923c45e5`
- 验证日志记录的 diff SHA256：`16fcc50dfac2ee8cc034561c576f6339d4157c47eb94577ac1eb2b1dc404ee97`
- 未解决阻塞：**0**

批准适用于上述精确实现 diff。可登记为 `verified`，随后按既定流程完成正常提交钩子、提交及主线集成核对。
