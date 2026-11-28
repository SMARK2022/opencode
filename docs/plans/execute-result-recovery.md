# Canonical Implementation Plan: PR #5 Execute 能力、预算与工具结果

> Status: verified
> Revision: R32
> Approved revision: R32
> Audit mode: full-scope
> Requirement source: §1 用户原话
> Implementation allowed: no further material changes without revision or rework
> Last updated: 2026-11-24

需求基线是原 GOAL 实施前 HEAD `0ab20fa87080bd4fafd79d39b97fb082c4af8d62`。全文描述原需求到最终行为；用于正式重放和验收的发布基线为实际最新 dev1-smark `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，tree `e0baea4acaa886363c1c172f5c80a5422bfe620f`。#5 原线上候选 `86fc85c12074a536c8774030265092722aecf2cc` 仍保留原回执。最终目标保留全部原能力，继承最新基线已修的 Session 和两个 renderer 生命周期行为，收口现有 OpenTUI patch 的一次帧身份；V1 Read 在没有交付首行时仍返回真实截断页，Execute 合并受限调用分派并删去已无调用的错误路径。数组消费与排序保留固定基线的值、回调次数、短路和可枚举索引；双向归约沿用真正零长度的原错误。目标为一份可合并提交，合并由用户决定。R23 历史对照为 `62344f77616b549f28cba1c810dcb0c65e3eb041`；该提交的已审结果只覆盖 R23。最终同一工具经普通模式与 Code Mode 执行时，不额外制造普通基线没有的拒绝；本轮以删减为主，量化完整发布差分的新增行收缩。

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

## 2. Explicit Non-Goals

不调模型、新增宿主函数入口、提高权限、更改搜索默认超时或重写其他 PR。WebUI 不混入。Gate 原样执行；任何 Gate 失败均保留原结果，不改代码、配置、规则或执行合同，不重新启动独立 Gate/计时器 PR。旧 R7/R10 的绿灯不计作当前验证；也不追求重造一个字节不同却标为 R10 的版本。不使用机械 hunk 清单代替设计。

R8 保留既有用户功能范围，只纳入原真实路径已证实的资源所有权失配。不得改 Gate、正式测试、延时／刷新频率、协议、FFI ABI 或 native 终端构建入口；不新开专门的计时器 PR，不关闭动画、不延长测试等待、不跳过失败。渲染器选用现有 Core patch；正式源码、依赖、patch 与 lock 在批准前保持原样。

覆盖通过 Code Mode 公开的全部工具，但只修与普通调用基线相较由 Code Mode 或其本 PR 新增路径制造的额外拒绝。保留工具本身的输入合同、真实权限拒绝、I/O 错误、脚本执行/取消及用户指定的根预算；不删安全边界、改 sandbox 语言规则、改变真实错误语义、扩展 PR，或借格式化降低行数。

## 3. Repository Context

以本基线的 `docs/guides/workflow.md`、`.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md`、`CONTEXT.md`、相关 ADR 与各包 AGENTS 为约束。工具宿主决定权限和默认预算；解释器只承接受限值及媒介调用；结构化结果与展示文本分别由对应工具拥有；会话层只决定模型收据内容。红反馈先于实施；Plan 和实际最终差分都需独立审计。

基线分两层。历史 pre-R1 精确提交 0ab20fa87080bd4fafd79d39b97fb082c4af8d62，tree 23a93b4688c057bffa772ebb34ac9eb8b4dde91d；其子 cff9a3566988bf91082aa090029ce66c83f557f8（tree 481565810b7a6581e6880bbe8ff92915964bc3ac）已含初次完整修复，父关系和对象已从独立裸库验证。R7 §18 的父→初修对照是历史来源；本轮读取了两份精确对象和完整差分，未复跑历史程序。旧发布另有 e93b66fd8473e94fb414151af0fecbb31a299266→R7 的差分。本轮以 `git show -s --format="%H %P %T"` 重查独立裸库 pr5-original.git，确认同一提交、树和父关系；GitHub 的只读回执也确认两个完整 commit ID。需求与全量设计覆盖 0ab20fa8→完整目标；R17 历史实施基线为 5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0。R20 历史实施和发布基线为 6dd9a5b1f3a0110e9d1c8142e2230724f6906f42，已发布待复验的旧候选是 8f0a7c70ffd4a9b334314150927909985f639ee2。0ab20fa8 的历史程序本轮未重跑；0dfffcda 和 0b5754df 仅标识旧回执，既不充当实施基线也不充当正式发布基线。该轮相关三个文件在原需求前像和当时发布前像逐字相同：Toast owner blob fdacec41，Session route blob cf30a49d，app-lifecycle 原测试 blob a885e68e。

当前 6dd9a5b 与既有线上 #5 对照有两处重叠：Session 路由与同一个 OpenTUI 补丁。其余 19 个非 Plan 路径以空索引严格重放，逐一核验 #5 线上后像相同（§18）。下表仅列历史需求/实现对照中本轮保持的工具 owner。

| 修改 / 保留 | 两侧相同的 owner blob |
| --- | --- |
| JS-1…5、BUD-2 | codemode/src/interpreter/runtime.ts 7ce693b5；model.ts 1dc55c89；codemode.ts ff0b3053；stdlib/math.ts cc8dd067；tool-runtime.ts b9a22c4b |
| BUD-1、VIS-1、VIS-2 | opencode/src/tool/code-mode.ts 315d90f4；codemode/src/tool.ts 6c9fbf2a；core/src/tool/task.ts 8081ade0 |
| READ-1…4 | core/src/tool/read-lines.ts a6686858；opencode/src/tool/read.ts 643a0d7a |
| RG-1/2、SH-1、OUT-0 | core/src/ripgrep.ts 3354caaf；opencode/src/tool/shell.ts e6eefc1a；opencode/src/session/tools.ts 87738049 |

既有测试中，codemode 三文件、core ripgrep/tool-read-filesystem、opencode read/shell/code-mode/task/registry 均逐字相同。不同前像：core session-runner 行 1705 仅把 Git 提示标识由 Git repository state changes 改为 Git and GitHub（73242ed5→dd3897b1，与 Task 广告无关）；opencode execute 测试行 1771/1782 调整另一取消夹具 1000→5000 ms 和 join 10 秒（83b92763→ce9ede8d，不是本次用的最终失败回执）；排除的 TUI voice 在 0dff 已有另一套按 origin 转交的探针处理（2353faf7→5a3ef5af）；bun.lock 两侧只改工作区版本 1.19.17→1.19.18-smark，R17 历史验证按 5bc061b 的锁运行；锁与 27f5f62、98a9f13、0b5754df、0dfffcda 保持同一字节。上述一致性只用于定位历史 0dff 动态结果对应的生产前像；运行目录、夹具、锁文件及整条旧提交的实际执行仍只按各自已取得的证据记，不以源码相等声称重新跑过历史测试。

## 4. Files and Evidence Read

| 证据 | 来源 | 证明范围 |
| --- | --- | --- |
| 固定发布父与实际送审工作树 | 固定发布父 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，tree `e0baea4acaa886363c1c172f5c80a5422bfe620f`；实际隔离规划根 HEAD 为 `9eff6586b0c2232f88d41c3c834179ae555171d8` | GitHub 原提交对象和六条目标变更后像全部重建核实；当前原 Gate 与当前发布都固定此提交 |
| 当前原 Gate 与产品上下文 | 57a→6dd9a5b 四次提交、六条路径；原 Gate 脚本未变 | 只与 #5 的 Session 路由及 OpenTUI patch 重叠；其余十九条源和测试可严格重放并保持字节；历史 Core、Auth、bench 只作为对照 |
| 旧工作版本 | `e93b66f→1d799bca` 已发布历史；独立三文件差分恢复 R7 树 `d6ca3355f3af78d4581cffa2cc134a332ee270f2` | 旧设计来源，非当前批准 |
| 真实 rg 输入 | 本地真实 rg 输出 70,216 B 的合法结构化记录 | 原生生产者共输出三条匹配；另以同一夹具执行当前 core adapter 红测 |
| R10 历史回执 | 工作记录留有真实 PTY、审批 worker、原包类型检查及 WebUI HTTP；精确源码/Plan 工作树已缺 | 行为参考，不能转记为今天的通过 |
| 逐 owner 静态读取 | core ripgrep 与 read-lines、opencode shell/session/tools、codemode runtime、host、工具目录 | 下列分歧和计划 seam，未执行 |
| TUI 原 Gate 红与隔离诊断 | packages/tui/{src/app.tsx,src/routes/session/index.tsx,src/context/{sdk,sync}.tsx,src/ui/toast.tsx,test/app-lifecycle.test.tsx,test/fixture/tui-sdk.ts}；locked OpenTUI Solid mount/dispose；stock script/guard/leak-preload.ts；第 18 节回执 | 验明异步通知晚于已发生的卸载；原 Gate 捕获错误，不是清理 owner |
| SCROLL-1 独立红绿 | 固定 0dff / R6 原 preload 同一用例、Session route、原渲染 fixture、仅 owner 的隔离 overlay（§18） | 同一 50ms 资源在两固定臂缺少取消；active 控制仍对无关渲染资源报错 |
| RENDER-1…3 / SLOT-1 对照 | GitHub fork 标签与源码、固定发布包 JS、官方同 owner 源码、real SystemClock、两个原 stock TUI 用例与 Spinner 三臂、无探针私有原型（§18） | 区分 dependency owner 和 DialogSelect 渲染入口；隔离绿不等于正式载体或完整 Gate |

R20 重读实际 dev1-smark `6dd9a5b1` 与线上 `8f0a7c70`，当前公开比较为 ahead 1 / behind 0，21 路径。新增检查证据包括完整 V1 Read 前后像（`643a0d7a` / `d493a42a`）、共享 parser 前后像（`a6686858` / `f428a5ed`）、准确共享显示 owner 和准确解释器调用点。R19 源方案 Git blob `48347a417fc08e10cd1919ba761597701cad8286`。

R21 将当前 6dd 基线的实际公开 CodeMode 结果与 R20 封存树 `045411e1976c59eb44fcba0e8b699ad26c7119af` 对照。已知真实输入 `const a=[];a[1]=7;a.pop()` 建立长度为 1 的空槽数组。两端同样从公共 `CodeMode.execute` 进入，均无工具调用；记录见 §18。

## 5. Current Behavior

R31 实施账目沿用了 §17 的 PR #1 注释百分比，按该历史口径不足。R32 纠正 #5 放行所用的注释要求，保留同一源码和既有测试、所有用户行为要求、逐 hunk 必要性以及原 Gate / CI；原数字和范围证据见 §17、§22。

- 当前 `core/src/ripgrep.ts` 在 JSON.parse 前按 64 KiB 单记录体积报错。
- `core/src/tool/read-lines.ts` 的两处软字节预算都能在第一完整行提交前转入辅助扫描。
- 当前 Bash 结果把用于展示的 `output` 放入 `program.value.content`，可能夹入状态提醒；另有退出码、截断、超时、落盘地址字段。
- Execute 失败收据的生产入口与旧 R7 没有该功能差异，先核验是否仅需保留回归断言。不能把静态相同误写成通过。
- 受限回调、Array、根预算与工具签名的当前分歧见第 8 节；尚未执行当前红测。

Read 预算路径的第一分歧是 V1 owner 在 parser 已确定可交付页后再次拼接/估算，把文本预算判定表达为硬错误与建议 limit。两处检查使用同一 UTF-8 正文和同一扩展名比例；parser 计数含 join 换行、UTF-8 代理对、CRLF，只有尚未返回任何行时可超软窗。首行之后预算不能再放宽。现有可达路径没有触发该异常的输入；删除重复分支不应设计新人为红测。超长行无法继续推进时由 parser 的截断状态进入既有输出，无权限、读盘或越界错误需要变为成功。

原 TUI 退出测试在两个发布对照（0dff 与 R5 冻结差分）同一位置失败：可见 Session epilogue 正确，stock Guard 报 UI 已退出后仍残留一个通知 handle。正常用户在进入会话、剪贴板操作或插件通知途中退出，同样可能有待完成的 Promise；故障无需依赖测试顺序。

SCROLL-1：原 Session 挂载和会话切换可在滚动延时内卸载；回调虽读取组件已销毁状态，仍未撤销自己拥有的资源。这与 Toast 和 OpenTUI 分别独立。

已证的全量发布链有两组独立的遗留行为：
- 固定 OpenTUI 渲染器在等待一帧、手动 renderOnce、以及销毁子树触发 frame invalidation 时，可能留下用户当前进程已不再需要的延迟帧回调。
- DialogSelect 为可选搜索栏右槽读取重复的 JSX producer，可能构造一个未挂载却已自动播放的 Spinner。挂载的另一个实例照常卸载，遮不住先前遗失的那个。

**Read 证据。** V1 Read 的 16,000 token 整页拒绝与建议 limit 已存在于发布基线；按原字节窗 16 KiB 与最大估算比率 0.28，正常页至多估算为 4,588 token。线上候选新增的首行准入使用与整页相同的估算式，超过估算预算或物理捕获预算的首行由同一解析器产出截断；普通尾行仍依软窗。已知真实终端用例曾成功读出 21,000 字节首行及下一行，并对无法交付的首行返回无自指游标的截断。它没有复现整页 fail 触发；本轮将把源证据与实际公开入口分开记录。

## 6. Supported Input Domain and Reachability

实际工具链调用、合法 ripgrep JSON、物理读取限额内的文本，以及现有工具返回与权限开关属于可达输入。R7 原测试中的稀疏 Array、Array.from 对象、普通内建回调、真实子工具和受限循环属于明确使用场景。无证据说明应支持任意宿主对象、this 绑定或取消已有许可。

TUI 仅涉及正常应用退出前后、仍持有通知引用的已启动异步任务，以及卸载前已显示的通知。外部 transport、请求重试、每个页面的导航规则和通知时间配置不扩展。

可达场景包括带锚点和无锚点的会话或 review 导航、正文同步后的补滚、用户已主动滚离，以及同一组件两个待运行请求。只处理该组件生命周期。

RENDER-1…3 只覆盖固定 fork 中真实 ordinary frames、手工帧与销毁流程，包含 renderer 启动、暂停恢复、销毁期间子树 detach 和在途 async frame；不引入新的渲染 API、前后台调度模式或更改 timing。SLOT-1 支持任意现有 filterAccessory JSX，包含 undefined、搜索期间活跃 Spinner 到完成切换及仍然 truthy 时的新 JSX；复用 Show 的真实 memo，不改 busy gutter。

零进度仅表示正 limit、已确认截断且仍有未交付行、返回行数为零。空白行可计一条，空文件是 EOF；显式零 limit 维持原接口。仍允许调用方带真实 offset 显式读下一行，既有权限、原计数与扫描上限不变。

规约输入同时区分真实零长度、正长度全空槽和存在值的稀疏数组。通过旧索引写入与 pop 能构造全空槽，不依赖本 PR 引入的 Array 构造；测试的额外构造对照覆盖新入口同一行为。

## 7. Required Invariants

| ID | 必须保持 |
| --- | --- |
| OUT | 失败时保留已显式展示缓冲及 error，未展示的子工具正文不进入模型收据 |
| JS | 普通 JS 场景通过既有受限调用边界；Array.from 保留逐项读取和回调次序；旧稀疏数组消费保留按索引取值、回调次序/次数、短路和排序结果索引 |
| BUD | 1024 次工具调用不超发，显式循环累计上限由同一 root 所有子执行共享；100,000 为本计划选值，已按真实宿主相邻边界验证 |
| VIS | disabled background 不出现在可调用 schema；能力开启时已有语义和权限保持 |
| RG | 合法的长记录正常解析，真实无效输入仍报错，既有搜索超时与数量上限不变 |
| READ | 首个可返回的完整行在物理预算内能推进分页；其余行仍应用软预算和原 offset/limit |
| PARITY | 各公开工具对同一可比输入，Code Mode 不应多报普通基线没有的错误；权限、真实 I/O 和已确认执行限额沿原所有者处理。 |
| PARITY-1/2 | 成功结构先经过原声明；未声明插件保留 unknown。原深度与普通对象形状约束仍由同一处执行。真实工具成功且原声明已通过时，只有旧深度拒绝和已证实的普通领域类形状拒绝可以交付原文本；唯有可信 MCP JSON 的深度分支交付完整 JSON 文本。原附件和真实错误照旧。 |
| SH | 机器正文与人类展示分离；单独字段继续表示退出、超时和截断 |
| REL | 仅修改当前基线确有缺口的 owner，保留真实权限/审批与原范围，完整审计、验证、无合并 |
| EXIT-1 | ToastProvider 活跃时通知展示、替换、既有时长和到期行为维持；卸载释放仍在使用的 handle，过期的 provider 引用不再写入其 store 或创建通知 handle。Session epilogue 与退出路径保持。 |
| SCROLL-1 | 保持 50ms 与两入口的 respectUserScroll、锚点优先及贴底判断；有效任务原样触发；退出释放本路由全部待处理句柄，原实例晚到的同步不得重新安排 |
| RENDER-1…3 | 一次正延时 frame 的句柄须有 renderer 所有权直到正常触发、启动替代、显式挂起撤销或销毁；手工帧不能丢掉旧 continuous handle；对象进入 destroyed 后禁止安排新帧。现行间隔、即时帧、运行中连续帧及 native ABI 原样。 |
| SLOT-1 | 右槽按现有 truthiness 决定挂载，一个求值结果同时用于判断与渲染；已挂载 Spinner 继续按原来时长和动画策略运行并释放，加载完成只卸载原节点。 |

R20 不增加对既有可接受输入的拒绝；后续不变的历史拒绝只处理明确不支持的值和原安全边界。正 limit 的零进度页保留成功中的截断标记，无自指游标和已读证据。保持显式的 1,024 工具调用和 100,000 显式循环硬上限，保留已有终止反馈及预算所有权。

R30 考虑 R21 的非零长度成功保护，但以固定基线的完整值和回调语义为准：归约按原方向读取索引，空槽是原消费行为中的 `undefined`，不能把应访问的索引改成跳过。真正零长度保留原错误，密集输入及显式初值继续沿现有路径。

## 8. First Divergence and Root Cause

RG 第一分歧在 JSON 解析前的长度判定；70,216 B 真实 rg 回包证明输入可达；固定 0dff core adapter 对该三匹配输入实际报 `Ripgrep.Error: Ripgrep JSON record exceeded 65536 bytes`，32 KiB 对照正常完成。该证据覆盖 core adapter，不等于宿主工具、权限或完整应用实测。READ 第一分歧在软预算跨越时先切页再提交首行，字符累积和提交均有该门槛。已用两份固定源码的纯模块 A/B 复现；真实 V1 Read 已按同一夹具复现及对照。SH 第一分歧在 `opencode/src/tool/shell.ts:813` 的最终结果组装：`output` 已追加展示通知，却又进入机器字段；现有 `end.text` 是规范化、已有边界的子进程正文。现有可独立导入的 formatter 只能验证通知格式，不能覆盖公开 Tool 的结果投影。另一处静态依赖 `shell.ts:503` 表明真实 Shell fixture 会触发 `Plugin.trigger("shell.env")`；即便 fixture 使用 noop bootstrap，此 hooks 路径仍可触达 provider plugin。已隔离实跑原 Tool，无需用 formatter 代替。

SH 基线隔离实测（临时目录 pr5-shell-exact）：两个确定的本地子进程实际 stdout 分别为零字节（exit 0）和 plain output 加换行（exit 7）。用固定 0dff 的 V1 Shell 结果组装表达式和原输出通知函数投影这些字节，机器正文分别被填入 “(no output)” 加执行通知、原 stdout 加错误通知；exit 保持 0/7，truncated 与 timedOut 均为 false。原子进程字节是真实的；ShellTool 入口、Shell 环境插件、权限、候选修复及宿主回归未运行。完整 Shell 源码 SHA256 957b8a41e3fcd134fe2f709a432a58a19ad9f03b77ce9ac3084895771d5099c2，投影 25b041c7b3e9f7882d07ca4907686879b6f0a8ff89dee72a6b3485f11b712497，通知模块 379f9c4e261a35e4975e89477a6ea4f8f710686a59382c092edeeab725b05a67，探针 c9403ae098e52057aa9da01324f4d1898e735448a4c94c0e4dcc0146984741e1，日志 06a1abf12f2de5a814cd61e8e68c7424f4265dd0d624fa601106f329a6758664。

SH 归档 R7 正对照：将同一份真实子进程字节回执原样送入基线与归档的结果投影（不重跑子进程）。R7 两组机器正文分别为零字节和 plain output 加换行；基线含展示通知。两边的模型展示文字、UI metadata.output、exit 0/7、truncated=false、timedOut=false 全部相同。临时目录 pr5-shell-r7，原捕获 SHA256 06a1abf12f2de5a814cd61e8e68c7424f4265dd0d624fa601106f329a6758664，R7 源码 96afbfc48a7a4e3f3c26102b51d0c9d2c8b2b8e2d77bcfd4a9b2a5227144cd66，R7 提取 dbc9005982bdc4a5cd606c11d156c63fce8d4cfd5cb0be9484a00fcaf0dfd2c5，探针 0dc367b24884ca5f266e3ecd15978d5e85479086e966ef341174709136845b90，日志 36f97a75f456d7963b5f7a5a4bf88948c281e2586b4c9f49f9a50477348fc8e5。该结果验证历史投影，完整 ShellTool、现行候选和具体超时/截断分支仍未运行。

OUT 尚无静态生产分歧：`opencode/src/session/tools.ts` 在 0dff 与 R7 同 blob `87738049389d7a155cfca03b513ff7f2dac86d63`。`evidence(settled)` 只收已完成调用的元数据，不复制未显示的子工具正文；失败收据仍使用已记录的展示输出与现有终止流程。需在现有会话 launcher→processor→本地 provider fixture 的同一条路径上验证 throw 之后独立哨兵仍不泄漏；若当前行为已符合，只保留测试证据，不预设需要生产修复。JS：live `codemode/src/interpreter/runtime.ts`（blob `7ce693b5`）显式拒绝 Array.from mapper，缺普通 Array 构造与统一受限回调分派。旧 R7 `5d085631` 须作为参考而非现成补丁。数组长度一次读取，逐索引获取当时的值后立即执行 mapper；原生 Node 对可迭代数组与 array-like 两个独立合成场景分别得到 `[1,9]`，作为 mapper 读取顺序的独立预期；该预期本身不构成 CodeMode 红测。已另从 0dff 的 `codemode/src/codemode.ts` 直接实跑：无 mapper 返回 `[3,4]`，有 mapper 在第 1 行、第 8 列报 `UnsupportedSyntax`；保留真实红，不把旧中间版本的另一数值记为当前反馈。

BUD：core 已有 `maxToolCalls` 准入，但 live `opencode/src/tool/code-mode.ts`（blob `315d90f4`）只在预跑传 1024，正式 Execute 未传。 已用原样 0dff 子库对照证实该准入合同实际存在；未执行正式或预跑的宿主路径。解释器从实际显式进入循环体计数，在同一个 root 跨帧共享，下一次执行重置；不把内部数组扫描计入。复用既定预跑/执行的 500ms/600000ms 和用户 timeout，不扩大。

VIS 分开两套 Task 架构。用户所指现有 Execute 的实际 V1 路由是 `opencode/src/session/tools.ts:112,183,635–640` → `opencode/src/tool/registry.ts` 的本地 `TaskTool` → `opencode/src/tool/code-mode.ts:161–167`。V1 `opencode/src/tool/task.ts` 两树同 blob `5393197fae8c39d3fdf9e83074c419017d2e31bc`，工具定义已根据开关裁剪公开说明和 schema，真实参数仍供执行；此路径不重复裁剪。另一路固定基线 `packages/core/src/tool/task.ts`（blob `8081ade08decdaf0d44b0a6d35d088df4adcba42`）执行时已有 flag 守卫，但注册描述总宣传 background，且只传完整 `Input`，没有按开关单列公开 `inputSchema`；归档 R7 对照 blob `b7ca0eb680a1acff9596077b716e758e66186cf1` 在注册 owner 条件裁剪描述和 schema。此 core Node 经 `core/src/tool/builtins.ts` → `core/src/location-services.ts` 挂载于独立 V2 工具目录，由 `core/src/session/runner/llm.ts` 从 core ToolRegistry materialize；不是上述 V1 Execute 的 producer。是否需在当前同需求范围兑现 V2 路径须经现有 V2 开关 fixture 确认，不凭旧 diff 扩范围。固定基线 `codemode/src/tool.ts`（blob `6c9fbf2a08be6abd9d6e2325ce6b6234c77d2483`）又把 runtimeParameters 作为展示的 inputContract，覆盖已裁剪的公开 schema。

已用上述原样 0dff adapter 在 `env -i` 下隔离实跑：合成 producer 的关闭态公开键只有 `id`，但 optional `background` 存在于运行时合同，目录仍把它展示出来。同一关闭态只给 producer 合同的对照隐藏该参数；开启态正对照仍展示。三组宿主执行次数均为 0。这个红反馈证明已经裁剪的公开合同在二次投影仍可丢失；未执行真实 Task 执行、注册或许可入口。

VIS 当前候选的隔离红绿：从固定 HEAD 的 V1 code-mode.ts:153–180 原样提取 toolTree，以合成带开关的 Task 合同接真实 CodeMode。基线关闭/开启均向目录与 search({query:"host.task"}) 泄露 enabled、background 两个运行时字段；候选仅在 Tool.make 得到 definition 后令展示 inputContract 使用公开 definition.input，关闭态只见 id，开启态见 id 和 background，均保留实际传给处理器的两份 {id:"42"}（标量兼容与对象形式）以及默认值调用 2 次，目录和 search 查询本身不调用默认值。两个封装均 exit 0，按预期分别断言红差异和候选行为。临时目录 pr5-vis-exact；原样提取 SHA256 55a5673609904a20b9550e4cf08a8179a5bbbae53053b661393ecd0a4a7e2750，候选 7177c75aea19770072bdc2f78ede079ec82e295eee030a043ca83e57fe7bd66b，探针 abccf036923f56364c5adfe0cbdb3feeb43e60d02ed13a7aae45eb1d68b6255a，基线日志 446700f907afe5ad8cf1ddfb7d26a1a30d2e8fd686244b42041e2912f6d49c12，候选日志 8188bd3b75a6a46e34371f85371bbd75ab0dc6d49a300f9c0cd60370c081e5e0。实际 Task 注册生产者、许可路径、完整宿主未运行。

EXIT-1 的触发与 owner 分开。原 fixture 只列出 dummy 会话，未提供 GET /session/dummy；`args.continue` 进入同一 ID，正文读取和 question sync 各自请求该 URL。两处 catch 用会话 ID 判陈旧，退出后闭包里的 ID 没变。孤立轨迹实测 `init → cleanup(false) → show unexpected request: /session/dummy → show unexpected request: /session/dummy`，两个调用分别来自 `refreshQuestions` 和页面初始化的 catch。退出时没有旧 handle 可清；两个迟到调用中的后者替换前者，原 Guard 因此只报一个遗留的 5000 ms handle。清除卸载前的在途 handle 也是职责，但只加 clear 的候选在原测试仍红。

SCROLL-1 的历史 0ab20fa8 与发布 0dff 路径 packages/tui/src/routes/session/index.tsx 均为 blob cf30a49d43f3d045eebc6cc613ed69655648c31d，R6 未触碰。第一分歧在 scheduleSessionOpenScroll（0dff :1044–1049）不保留 setTimeout 返回值；回调内的 destroyed 判断在到期后才运行。两固定臂原用例只报该 50ms；真实切换会话可同时有两个句柄，单字段不能承接。

历史 RENDER-1/2/3 调研记录见下方原回执。当前 6dd9a5b 已为延后 activation 记录可取消句柄、在 destroyed 早退，并在手工帧接替时清除原 continuous 句柄。仍可复现的是：零延时旧 nextTick 在 suspend 后无法取消；resume 已提出新的请求时，旧回调只看复用的布尔值，抢先消费了新请求。真实 renderer 袖珍对照在中间 nextTick sentinel 已出现帧 1，只有正确的后继请求才应提交这一帧。
SLOT-1：DialogSelect :686–689 先用 props.filterAccessory 作 Show 条件，内层又读取同一 getter；SessionList :650 生产 dynamic Spinner。原 preview 实测 start 两个 id，只 stop/destroy 被挂载的 spinner-2；未挂载的 spinner-1 留下原 scheduler interval。Spinner stop/destroySelf 本身工作正常，无需修改调度器、清理策略或增加计时器。

V1 的首次分歧是已得 parser 页被 `readPageContent` 作失败投影；基线上同页是零行成功，不过 program.next 和显示 more 都指向原行。机器游标和用户可见 XML 是两个消费者。Array.from 的可达入口已由 `invokeCallable` 接手 mapper；静态 helper 反 mapper 分支已不可达，不能构成保留验证的理由。直接调用当前先列举令牌再在执行器重复分派；合并时保留原格式化诊断和单次求值。

双向 owner `invokeArrayMethod` 用同一 `inRange()` 扫描首个实际元素。R20 在循环耗尽后报「empty array」，把真正零长与扫描耗尽误作同一种状态；旧路径只在真正零长度时拒绝。首个元素尚未找到的行为由该 owner 决定，不由 JSON 序列化层纠正。

## 9. Responsibility and Seam

V1 实际 Task producer 的开关对照已隔离运行（packages/opencode，Bun 1.4.4）：bun test test/tool/task.test.ts --test-name-pattern '(rejects background execution when the experiment is disabled|execute launches background tasks without waiting for completion)$'。2 pass/6 断言：关闭时 producer 公开字段无 background 且直接使用拒绝，开启时保留启动能力。日志 pr5-visibility-task-producer.log SHA256 a04762a11635deef648fb632cc882577d6963e73567c54f9db0db2f4cdd86d33。另用原 host code-mode.test.ts 的 runtime schema owns shortcuts while defaults and permission inputs execute once 作公开搜索与参数权限验证，临时测试绝不代替这个真实 producer 对照。

VIS 公开宿主消费者同基线实测：原 code-mode.test.ts 的 runtime schema owns shortcuts while defaults and permission inputs execute once，固定公开合同两种状态、同一原 Tool.make 解码及真实宿主 permission 元数据检查。基线 0 pass/1 fail；仅 toolTree 选择公开展示合同的临时候选 1 pass/18 断言。search 的 schema 逐键匹配，未执行搜索目标，标量/对象输入、权限和默认值原行为保持。隔离日志 pr5-vis-red.log SHA256 bb2322774ae460fba1a8aff6b382ba2cb607df6cae6956b99b0b4de0a8b588d5；pr5-vis-green.log 66c057a497e4b2eb398771e1783dcf734875c60e224751092a3eb163af66dc2e。真实 producer 的独立开关测试见上，不将两项合成同一条注册链执行。

JS 固定同基线隔离 mapper 临时候选七组：Array.from 原无 mapper、mapper、回调后再读数组与类数组索引、显式 undefined、稀疏输入、已有 String 回调以及拒不可调用；两臂均零工具调用，候选保持拒绝错误类型范围。pr5-js-base.log SHA256 b934bb0a63b9e4770c7bbd9daa5ee917d69eb55ae65115fd2ad1414f918edc30，pr5-js-candidate.log c217bd2b74fd529de21b1478f0ab2393d359059aca36c1d54ab5b6ca9938b9c0。

JS 的受限内建回调与 Array 构造另用同一 Bun 1.4.4 纯解释器、空环境、不传工具和禁 fetch。原 0dff 各自拒绝 Math.floor/pow、JSON.parse 回调，Array() 不可调用、new Array() 不支持；无效长度在基线被 catch 为通用 Error。临时候选共享原令牌调用 owner、保持定参 Math 读取规则并复用 Array 两入口的构造：floor [1,2]、pow [1,3]、JSON [{},[1]]；两种构造单数字留洞、字符串为元素、多实参保留，非法长度为 RangeError，直接 Math.pow(2,3) 在两臂均 8，零工具调用。两个封装均 exit 0，分别断言基线和候选的实际区别。目录 pr5-js-expanded，补丁 SHA256 3276fefb263e8a02b5718a4f6f3afb43b8eeb8300547114b3a5b303e9db5d286，探针 6ea6f84d1d8d05ff2b188abf8457e0e3980387a41a0c6d27f0b5114edd117f38，基线 c6daa589dfd6ccafa343ec2db452f0cab2d630bbef02daa834df33953a018233，候选 a6ef7cb5c98c2e77af0295f17a364d8993cf3afbf89d07d9a7c11054d299d020。两份 JS 诊断为分别观测；合并同一 owner 后仍要复测。变参 Math、Promise/replace 与稀疏语义各用后续独立对照。

V2 Core Task 固定 0dff 的真实注册/ToolRegistry.materialize：关闭态基线 schema 与描述仍含后台，0 pass/1 fail；开启态基线 1 pass/2 断言。最小候选在生产者只根据原 flag 生成公开 schema 与描述；两档分别 2 pass/160 断言。最终复放原历史两档夹具与原 durable results/scoped permissions 用例，Bun 1.4.4，cwd packages/core，bun test test/session-runner.test.ts --test-name-pattern '(task advertises background only when enabled|executes and resumes canonical task sessions with durable results and scoped permissions)$'，2 pass/162 断言。证据目录 pr5-vis-v2-exact：关闭红 9d58dd52c347ccde07ed00a0d3fe87a5f436850d870a0c6e7dd751c6b7d8de01，开启控制 780181cb08536e3a0de2ed244bcf3aa7f9e0bbf6d5151ed413b6fd8570a4cbcc，临时 patch 4830706ed3380b240fd979d827f16958780b273dc4618a372b7927c2c8f35508，最终绿 ec3aaf6bd6a789e2b1b20386e6c3d504f293ab182acac564577ea43912e50c01。历史夹具是独立的临时测试实例，只用于本阶段；正式保留现有实例数，两个 flag assertion 在既有 SessionRunner 场景的独立作用域承接，追加后复跑全部原断言。

RG 在真实 rg → core search facade → 结构化匹配的路径观测；READ 用公开 Read 工具按 offset 看前后页；SH 用现有 Shell tool 观察两份结果和独立字段；OUT 从真实 Execute 模型回执及最终 Session 收据观测，不以 helper 的中间日志代替。JS 看解释器已公开的 Execute 行为；BUD 看有真实调用副作用的 host 入口；VIS 看公开工具签名/注册表，而非内部配置变量。

EXIT-1 的资源所有者是 ToastProvider 的 `init()` 和被引用的 `show()`。绑定 Solid 当前 owner 的 `onCleanup`；锁定 OpenTUI `mountSolidRoot` 在 renderer destroy 时释放同一个 Solid root，已实测 cleanup 确实发生。SDK 提供 app scope abort，生成的 session.get 支持 request signal；单点接线不能覆盖 question sync 的独立请求或已在执行的注入 fetch，也不防 clipboard Promise 或插件仍持有通知引用（app.tsx console copy，plugin/adapters.tsx toast）。当前修的第一偏离是已死通知 owner 仍分配自己的资源；保留 async 请求的业务结果和已存在的 abort 行为，页面取消是独立职责，不在此更改。

SCROLL-1 属于已有 Session 组件：:506 正文同步的异步后续以 true 安排尊重用户滚动的补滚；:1773 的 Solid route/review effect 默认以 false 安排普通导航。两者唯一共有的分配点是现有 scheduleSessionOpenScroll；用组件现有 Solid onCleanup，不改 SDK、共享计时器或 OpenTUI。

RENDER-1…3 的唯一运行时 owner 是 pinned core renderer。依赖同一个运行时 bundle 和 native 打包链；OpenCode Session 与测试 fixture 都不接管 renderer 句柄。SLOT-1 的唯一可修位置是 DialogSelect 使用的现有 Show / filterAccessory 单次 memo；不在调用者加保护、重复 stop 或在包层切换执行路径。

## 10. Single Approved Primary-Path Design

本稿以 6dd9a5b 的真实源为当前起点，保留所有既有工具行为。目标树继承 R19 的 21 路径，按下述规则少量调整 Read 与解释器；Read 复用共享 read-presentation；R26 的全工具结果涵盖下文真实触发的 MCP 和插件差异，最终路径和代码行数见 §15、§19。Session 路由原样继承 6dd9a5b。正式验证绑定最终单提交。

R7 可借鉴的行为为合法长 rg 记录显示、精确 Shell 原文、Array.from 逐项读取和现有上限量级控制；只使用当轮证据支撑的最小变更。R7 无界首行捕获、重复修改 Task、备用成功、重置外层预算、旧测试总量及其他历史补丁均不进入目标。

EXIT-1 沿原 ToastProvider 接入 owner 释放。关闭标志只在 Solid cleanup 时设置，同一 cleanup 取消当前 handle；在 `show()` 入口拒绝已关闭 owner 分配资源。活跃时照旧使用 duration 参数及默认 5000 ms、既有 unref、原先到期清除显示、新通知替换旧通知。无新调用接口、无全局状态、无路由改动。

SCROLL-1 的完整目标仍为现有 50ms 与两个既有入口、各自的滚动意图、销毁与晚到同步原语义。6dd9a5b 已由 Session 真 owner 跟踪、移除、清扫各句柄并在公共回调内检查 destroyed；本提交沿用对应文件原字节。

目标保留 OUT、JS、BUD、VIS、RG、READ、SH、EXIT-1、SCROLL-1 和它们的各项兼容边界。保留 SLOT-1；OpenTUI 以 6dd9a5b 的现有 renderer 为唯一修改 owner：
- RENDER-1 让 6dd9a5b 的 `updateScheduled` 保持 `false` 空闲哨兵，待执行时改为当前一次帧的唯一身份对象，不加并行槽。现有两条安排路径把当次 identity 传给 activation；迟到 handler 必须先比对当前 identity，之后才清待处理状态；延迟 handler 同样先检查 identity，再清共有物理句柄。现有启动、挂起、destroy 和手工帧接替的已存在失效点清成原 `false`，不移动触发或清除点；一次帧进入 loop 前继续按主线位置消耗记录。保留 6dd 原共用 `renderTimeout`、计时公式、原空闲语义、feed 及终端提交路径；公开 `getSchedulerState().hasScheduledRender` 仍以 `!== false` 投影布尔。
- RENDER-2 继承 6dd9a5b 已在手工帧接替前清除现有的 continuous 句柄；不再重放旧 #5 hunk。
- RENDER-3 继承 6dd9a5b 已有 destroyed 早退与清理，不重复实现；主线 Markdown 表格增量和 ScrollBox 契约原样保留。
- SLOT-1 保留同一 Show truthiness 与布局，但消费其已有 memo 参数 accessor 作为唯一渲染输入，不重复取 props.filterAccessory。保持原动态内容的更新和卸载。

READ-3 继续同一正文页路径。删除 `readPageContent` 新增的零进度 `Effect.fail`；保留旧越界，删除重复的整页 token 拒绝、建议拆分文案及只服务于该分支的二次估算。保留首行准入的同一估算器以及解析器的实际软、物理预算。V1 从同一 parser 结果计算一次零进度，沿原 text-page 传递空正文、真实 offset/count/totalExact 和 truncated=true，省略 machine next、read 覆盖，跳过依赖该覆盖的去重和 overlap；保留展示、附件、outline 和原元数据其余字段。原 XML owner 在其内部输入收一个可选的无游标标志（`continuationOffset?: false`），在现有 cut/more 判定内统一生成保留原 reason 的 offsetless marker。V1 仅在零进度时传 false；其他情况和 V2 走默认，字节不变。R30 在同一个 V1 owner 内收敛页结果：`readPageContent` 只返回正文和一个 `next` 决定（正整数表示真实续页、`undefined` 表示自然无续页、`false` 表示首行未交付而须抑制续页及读证据）。调用点本地判断 `next === false`；现有输出边界只在有正整数时发布机器 `next`，将内部 false 投影到原 XML 接口，并用同一事实决定候选历史与已读元数据。原输入 `offset` 是非负整数，宿主将 0 和缺省归一到 1；有效机器游标总大于 0。这里保留正 limit 条件，普通 `limit=0` 的原成功页仍可回报当前 offset。V2 formatter 的默认和源文件不改。保留已存在的偏移越界错误、当前 EOF、显示及两代共享解析器；不增加公开状态、判断 owner 或错误路径。原标签是 `<more offset="1" reason="byte_limit" />`，目标是 `<more reason="byte_limit" />`；不增加 MODEL 文案、公开字段、reason 或源码字符串重写。

JS-2 删除静态 helper 内反 mapper 死支。省略 mapper 和显式 `undefined` 直接共用原无 mapper 分派，删仅对显式 `undefined` 的重复转交；`null` 仍按原不合法回调。两条源读取路径保留既有受限输入，原生对照仅证明普通 JS 可接受的一些对象不在旧 sandbox 范围，当前不增加新的拒绝也不因此开放宿主。JS-1 直接调用继续保留原成员接收者形状诊断，去掉执行器前重复的令牌分支；只在唯一 dispatcher 无匹配时读取该诊断上下文，成员和 computed key 仍求值一次。集合的 callback 准入仍先于迭代（空集合也不能让非法回调悄悄通过），它是与原调用边界不同的责任，不删。若实施证明合并会破坏这两个合同，停止该 hunk 并退回更小的 Plan，原错误不要改写。

JS-3 的 `reduce`/`reduceRight` 仍共用已存在的双向 `inRange()`、回调执行和循环入口。保留既有的真正零长无初值错误；正长输入无初值从原方向第一索引取首个累加值（空槽读取为 `undefined`），其余索引按原方向逐项调用规约。显式初值从方向第一索引起照常调用。移除候选中为这两个方法寻找实际元素、跳过空槽和提前返回 undefined 的分支。此时输入已是普通解释器数组；`[]` 索引赋值后 pop 与新增 `new Array(n)` 使用同一 owner，不添加来源标记或分支。map/filter 等其余集合消费、序列化、同步或取消边界不变。

PARITY 以普通与 Execute 共用的工具入口分组；同一类共享的注册、校验、执行及普通展示所有者在 §13 映射，只有实际分歧改代码。匹配原工具结果之前的权限、显式执行上限、原输出 schema 和工具失败继续沿原路径。只在成功工具结果到脚本的数据表示这一步，复用可安全交付的普通展示文本；从不为非法参数、失败工具或授权拒绝伪造执行成功。

PARITY-1 由原 ToolRuntime copyIn 单点识别原深度拒绝及普通领域实例的原型形状拒绝；参数、函数、对象安全策略和其余数据错误保持。共享宿主适配先按原工具声明解码真实 program.value；原本可复制的数据仍交付原结构。已验证的深度或领域类形状不适合进脚本时，只使用同一工具既有的普通 output 文本，不读取更深属性，不把领域实例本身交给脚本。唯一例外是 MCP 已校验的 wire JSON 仅因深度失败时交付完整 JSON 文本；形状分支不进入该序列化。原 SDK schema 和根引用、rawText 优先级、附件、权限与真实工具异常维持。PARITY-2 只在插件注册定义未声明输出时标为 unknown，去掉 Session 将其误当字符串的默认；插件本来返回字符串时值仍是字符串，已声明 Zod 继续在原插件 owner 上校验。

R31 恢复旧数组消费和排序的原主路径。传给 `map/forEach/filter/flatMap/some/every` 的快照仍由 `target.slice()` 创建，现有 `items.entries()` 按索引取值；空槽有 `undefined` 值供同一个回调入口，不额外跳过。map 正常压入回调结果，forEach 不攒结果，filter 根据回调真值保留输入，flatMap 用原展开结果（回调返回数组的空槽也读出 undefined），some/every 保留各自原短路和空输入返回。find 系列、slice/index 和其他消费者不改。sort/toSorted 复用一个 `sortArray`：无比较器按原展开复制再排；有比较器在回调前以 `target.length - defined.length` 固定末尾 undefined 槽数，比较时仍只比较有值项，按原序列填充。保留新增受限比较器/回调入口、Array 构造、Array.from mapper、取消、显式执行预算、公开 JSON 安全结果及所有真实异常。不引入数组 provenance、fallback、补偿状态或永久的基线已绿断言。BUD-1 在现有 Execute owner 只生成一组固定根配置（1,024 工具调用、100,000 循环、原 maxLogBytes），预跑与正式入口分别叠加各自原 timeout，两个执行的计数器仍各自拥有、不会共享已消耗次数。

PARITY-3 将确有文本备选的外部成功合同交给原 `ToolRuntime.describeDefinition` 输出签名：V1 `toolTree` 继续复用真实 `inputContract`，只标记外部 JSON 输出声明（包括 MCP 和已声明插件）。V1 内置工具的 Effect 输出是固定 struct/union 加固定元素数组；其具体字段签名保持原样，不误宣传另一种结果。未声明插件的 Effect `Unknown` 保持原显示；外部 JSON schema 保留已证实的过深时完整 JSON 文本交付。原 renderer 仅在实际标记对象分支追加 `string`，原 string 或 unknown 保持；工具树、搜索、紧凑签名共享同一 renderer。删除附在每个 MCP 工具描述的重复说明，各工具描述还原原文本，保留全局说明。SDK wire schema、Effect 解码器、相对根引用、执行链、附件和返回值原样；不引入第二个 renderer、schema union 包装或错误路径。

## 11. Secondary and Replacement Path Inventory

原超时、原权限、原物理预算、原 parser 错误分支、既有可见性开启选项均保持。没有替代执行、重试、第二数据源、新开关、局部绕过或强制退出。PARITY-1 的文本出自同一次已成功工具执行，是在结果边界的既有展示投影。外部诊断仅供验证，不提交。

EXIT-1 不在测试 fixture 增加 /session/dummy 来遮住迟到通知，不在 Guard 排除 timer，也不延长或压短通知。绑定 owner 的同一入口覆盖真实通知的全部现有生产者，无另行重试或接管。

SCROLL-1 复用当前 Session 的实际 owner；不另改回调、滚动时序、等待或超时。

RENDER 唯一发布载体是已登记的同 #5 Bun core patch；现有实验只验证补丁行为，正式冻结安装与完整 Gate 是实施放行条件。等待 idle、切换 preload、忽略泄漏及临时修改安装目录全部只用于诊断或者禁止作为交付。SLOT-1 不以 animations_enabled=false 等掩盖错误。

## 12. Workaround Deletion and Replacement

删除 RG 单记录前置拒绝与 SH 展示正文误复用。保留 Read 首行准入和物理/软分页预算，删除零进度与整页 token 硬失败及其过期建议，撤销自指输出。删除解释器不可达静态 mapper 报错和重复 callable 分类。无新重试、跳行、自动补输出或修改超时。

## 13. Forward Traceability

| 需求 | 已有入口、缺口与最终验收 | 全量目标修改索引 |
| --- | --- | --- |
| OUT | V1 Registry → SessionTools → processor → 模型及恢复文件，0dff 隔离宿主 19 断言已验证；保留已展示日志和错误，不串入未显示正文 | OUT-0 |
| SH | V1 Shell 原空成功/exit 7 两条产品语义：由真实 Session Execute 的现有工作目录实例承接，原 Shell 层的展示与状态测试复用，不改文件 | SH-1 |
| READ | V1 Read tool → 共享 parser；21,000 B 首行、下一页、真实显示、零进度截断、显式尾行和 outline；精确 parser 双臂、真实 V1 Read/Execute 删除及组合已跑；正式候选的完整 V1/V2 原宿主仍按 §18 重验 | READ-1/2/3/4 |
| PARITY | 公开目录 → 普通工具 / Code Mode 前端 → 同一工具 owner；同一输入比较结果与实际错误来源。Read 的旧整页异常不可达，删重复判定；MCP 深对象动态复现原 Code Mode 独有错误，选择完整 JSON 文本的最小方案，见 §20。已证明同构工具只记覆盖，不写生产补丁。 | READ-3；MCP 仅第 1 步，尚未审计 |
| RG | 原生 rg → core adapter → 结构化匹配；固定基线 70,216 B 红，旧 R7 正对照；真实 core 当前候选和 partial/abort 等既有停止控制均已通过 | RG-1；RG-2 零改动 |
| JS | CodeMode 解释器现有数组用例：回调绑定与逐项读、稀疏洞、array-like 长度读取时机、数组构造；固定 HEAD 的真实语义与历史实施证据见 §23；本轮公开 CodeMode 十一组和真实组合见 §18 | JS-1/2/3/4/5 |
| BUD | V1 host fixture 实测原正式阶段调用 1025 次，预跑受限；对照同轮 1024 次、嵌套/并发循环及下轮重置；工具及跨函数循环限制真宿主均已红绿 | BUD-1/2 |
| VIS | V1 Task 注册 → toolTree → 目录、说明、search、建议 → 已有真实解码与权限；实际 producer 开关 2/2，真实 V1 host 搜索、解码、权限收据红绿；V2 实际注册 materialize 已红绿 | VIS-1/2 |
| REL | 从固定目标重新对齐；原 Gate 未改，测试不扩张，独立方案与实现审核，通过后交付单提交，保留合并决定 | 适用所有索引 |
| EXIT-1 | 原 Gate + 可合并版本要求 → TUI app.exit → renderer destroy → Solid owner dispose → ToastProvider；原 app-lifecycle 退出用例及 stock 两文件选择原样通过；另用仓外活跃通知验证 | EXIT-1 |
| SCROLL-1 | 原 Gate + 可合并要求 → Session 的 async sync 和 route/review effect → 原 scheduleSessionOpenScroll → 同一组件销毁。原 partial glob 窄红绿、原切换贴底与两句柄对照 | SCROLL-1 |
| RENDER-1…3 | REL 原门禁 → auto-review-render 原 active switch → owner clock / detach → pinned OpenTUI renderer；正式目标需证明同原入口＋普通帧＋真实编辑器暂停恢复＋live/显式启动＋async destroy | 现有 core patch；安装按 §20 的正式验证顺序 |
| SLOT-1 | REL 原门禁 → session preview 原用例 → DialogSelect 的 Show 不重复读取 slot → 挂载 Spinner 按原生命周期停止；active search/错误收尾证明保留行为 | SLOT-1 |

全工具覆盖按执行 owner 分组；所有公开叶子工具从普通目录或 Execute 都走同一个 SessionTools.invoke，例外只列实际差异。

| 家族及入口 | 原校验、执行与交付 | 对照和例外 |
| --- | --- | --- |
| 内置工具 | 统一 invoke，经各原 handler 与各自真实权限、校验 | Read 公开工具与 Execute 对照首行、分页、原截断；Shell、RG、Task 复用原公共状态、结果和 Task 开关用例；已声明解码按原值，并保留真实错误。 |
| MCP | 实际 SDK 验证协议与结果，再经同一 SessionTools 展示与结构投影 | schema 根引用、旧浅对象、独立文本、真实失败与原附件；深层合法结构改用完整 JSON，最终大小仍走既有会话回执和恢复。 |
| 磁盘自定义插件 | registry 的 fromPlugin，原参数/Zod 验证与 actual invoke | 未声明的普通浅结构、原纯文本与目录的真实 unknown；声明不符、业务异常均原样；深结构、正常业务实例以原普通文本和附件交付。 |
| Plugin.Service.list 扩展 | 同一 fromPlugin，注册入口独立，之后与磁盘路径会合 | 真实扩展注册的合法浅结果已对照 0ab20fa8 红与当前候选绿，两臂各 7 条，直接和 Execute 各执行原 body 一次；候选准确交付原浅对象。回执 plugin-list-session/RECEIPT.md，复用上一行的校验与深度控制。 |

## 14. Reverse Traceability

下表 Hunk 为人工划定的最小职责边界，不是从归档或临时 diff 导出的行号表。实现时每个实际 hunk 均须对应此表；没有映射的修改撤回，待证项不算放行。

EXIT-1 的新概念只有「通知 owner 已卸载」。路由 ID 与 SDK abort 都不是该通知资源的所有权信号；复用 Solid cleanup，现有 timeout 应由该 owner 单独释放。此映射来自原发布门禁同一红点与真实卸载后行为，不增加 PR 的工具功能。

SCROLL-1 的闭合信号来自该组件，不来自可变会话 ID 或 SDK。多个并行句柄实测出现；现有 scroll.isDestroyed 只能避免写入，不能取消句柄或阻止卸载后的 async 分配。

历史 RENDER-1/2/3 分别对应迟到句柄、被抹掉句柄和销毁后重新分配。R19 的新增概念仅为当前已证实过期回调混淆继任者的身份；其他行为直接复用 6dd 现有所有权。SLOT-1 只复用已经持有 Show 条件求值的 API。各有独立 red/green；不将经过的库、路由或配置自动纳入。

R20 唯一新增的显示概念是已有截断标记可以没有下一行指针（READ-4），由产生 XML 的现有函数承接；该函数原本必须计算 end+1，无法表达零进度。它不负责 V1 是否拥有结果。V1 依已有 raw/cut/more 判定，省略无效 next 与已读元数据（READ-3），不增加 parser 状态。JS 收敛为现有一次求值与一个受限分派入口，不引入生产概念。

R21 的空槽扫描留在历史记录。R30 不增生产概念：旧 length=0 判断、方向、`inRange` 和规约回调均归原双向 owner；恢复读取全部索引，所以无需为原输出添加协议修补或数组来源元数据。

本轮减法反向映射：READ-3 的整页估算重复解析器同一判定；保留原一次首行准入和真实错误。JS-2 直接复用已有静态无 mapper 路径；JS-3 恢复旧数组与排序 owner 的按索引消费，取消候选 skip 与输出 hole 形状分支；方向共享的 reducer 不变。BUD-1 共用原配置值而非运行中状态：只有 timeout 必须由两个入口决定。RENDER-1 的 pending object 仍对应实证一次帧所有权，原 false 无需替换成 null。PARITY-3 的标记只保留在已证实需要的外部 JSON 输出合同；V1 toolTree 持有声明来源，既有共享签名 renderer 不需另建逻辑。Read 的三态只存在于 V1 本地页决定，程序及显示原接口仅接收各自已有值；不添加全仓元数据。MCP 的完整 JSON 文本投影按同一深度边界验证，随完整方案送审；不视为已批准变更。

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
| PARITY-1 tool-runtime.ts、codemode.ts、opencode 的 code-mode.ts 与 session/tools.ts | 在现有宿主适配处保留原值、本来用于普通展示的文本以及已验证 MCP 的来源；同一 copyIn 的原深度或普通领域实例形状拒绝触发原普通文本；仅真实 MCP 深度分支交完整 JSON。不新增脚本 API、不读取更深插件属性、不让类实例进入脚本。原 decoder、一次 copyIn、权限、附件和原 processor 保持。 | 真实 Session 对照 32/33 层及磁盘插件 Order 领域类实例：两者普通成功，候选 Execute 保持普通文本和附件；纯记录原对象、真实失败、原协议 schema 与根引用保持。 |
| PARITY-2 opencode tool/registry.ts | 原 fromPlugin 未声明输出使用 Schema.Unknown；既有 Session/Execute 目录不再误用 Schema.String。原一次调用、参数验证、Zod 与原普通字符串不变；内置工具不换默认。 | 磁盘插件在固定 0ab20fa8 普通返回成功、Execute 浅对象原错误，候选复用已有同一测试实例。 |
| PARITY-3 V1 赋标与原真实 MCP 目录断言，`packages/opencode/src/tool/code-mode.ts`、`packages/opencode/test/tool/code-mode-integration.test.ts` | V1 只给外部 JSON 输出声明赋标，内置固定 Effect 输出不赋标；每个 MCP 的重复说明删除。保留现有实际 MCP 紧凑目录的精确完整签名及真实备选 `Promise<{ sum: number } \| string>`。不改相邻纯文本、目录、工具名、输入签名、结构化结果、错误及附件断言；不改协议、夹具、结果生产。 | 同一原生产行为：浅结果是原对象，合法过深结果是原 MCP 已验结构的完整 JSON 文本；此原用例只测目录契约，不声称单凭它测试深结果。 |
| 交付范围 | 生产仅上述有明确 owner 的候选；RG-2 与 OUT-0 均无生产文件。测试在现有实例最小修改，零新增实例；精确有效行数、文件数及注释随最终经审计差分冻结。 | 私有夹具、临时脚本及收据不进产品差分，Gate 未改。 |

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

在已有 Read 未终止长行测试中，把 R19 的失败断言改为原结果合同断言，覆盖正文为空、truncated、无 next、无覆盖与 offsetless marker；通过已有长行/辅助预算测试保留可交付边界、显式后移和全原断言。CodeMode 复用现有 public contract 和非 callable 诊断用例验证 mapped/unmapped、显式 undefined、null 源、普通 direct 调用及一次 computed key 副作用；不新立拒测，不扩大负样本。

R22 曾将 CodeMode 公共 JSON-safe 现有测试恢复为 R20 后像。R23 当前范围见下段，保留原数组能力及 JSON 合同断言。R21 临时附加的旧语法构造与双向 null 断言在正式差分中撤回：它们在原有基线通过，只检出中间实现的退化。双向红绿、真正零长原拒绝、显式初值、方向顺序和 map 等控制只保留在仓外核验。

JS-4/5 与 Promise 按固定原 R1 前 HEAD 选择正式断言。取消三条原本绿的 host shape 断言、只为它们服务的 ToolRuntime import/capture/raw fixture，移除合并用例中已实测双绿的 sort 快照输入及期望值，保留单独仓外对照。原睡眠别名用例保留旧正例与三项原 opacity 负例；Math.abs 经实现变为合法，不保留其旧负向检查，也不补在基线同样拒绝的 JSON.stringify 断言。执行代码和测试实例数保持。

## 17. Comments

按用户当前 Session GOAL 的阶段 3 和仓库 Comment Rule：只有读者无法从命名、类型、行为测试直接得知原因时才写就近中文注释。逐 hunk 写清职责、必要性和删去后果；不以代码注释数量或排版替代该审查。仓库 Comment Rule 不设比例。11 月 7 日旧比例的直接指令指定 PR #1，原定位与范围见 §22。

保留历史计量：此前 R31 实施计数 E=363、C=45（12.40%），即使把 53 行全计入 C，仍低于该历史口径要求的 55 行。空行、仅 import、仅格式、生成、纯移动和载体上下文按历史分类排除。这个数字原样保留用于追溯，R32 不重分类，不加注释凑数；其他历史轮次仍见 §23。

## 18. Verification

阶段1 用实际 0dff 锁定 Bun/依赖已完成下文各窄实验。实施阶段对最终差分重跑原入口及包级回归，执行原 Gate、类型检查和真实目标平台；完整产品、TUI、编译审批 worker 与可独立恢复归档仍系交付验收，不把阶段1临时证据记作最终结果。

当前只允许在已确认的本地隔离边界内复跑已有诊断。以下为取证入口，不是待提交的新测试或候选结果：

| 可执行捕获入口 | 输入与独立期望 | 事实边界 |
| --- | --- | --- |
| `仓外读取分页探针 <live-read-lines.ts> <r7-read-lines.ts> <tmp-file>`（探针 SHA256 `9467ababcb57e5e18cfd44451ea1cbf88cd9ec1e540c321b694ad53d4ed793b9`） | 两份精确模块；同一 21,000 B 首行及尾行 | 实测 parser A/B，不包含公开工具宿主 |
| `仓外 rg 基线探针`（SHA256 `639eb53b657506af0ab8790e7016aefdcaea309d950a8e166edf5df8b33565ec`）与旧树隔离探针 `仓外 rg 历史对照探针`（SHA256 `2b7c13382af69305869e60e6c8f0fa87a2012d4f54a21d39b242357c9e1ff6e1`） | 同短/长三匹配 fixture；通过服务层显式固定本机 rg | 实测 0dff 红及 R7 正对照，未加载默认下载器或宿主 |
| `pr5-codemode-pure/{baseline,r7}/probe.ts`，以各自隔离目录和锁定依赖运行，R7 组传 `r7`（探针 SHA256 `9dd3253641fed7dfdf9d77c9d77c2923be653c880fbf4bd2b0aa918dba445147`） | mapper、逐索引 mutation、合成目录开/关；无网络，遇工具执行即失败 | 原样模块已跑，非真实 Task。基线日志 SHA256 `562ae60cd090742174897be643bf6518d48ff2d18f4e188ff59d91c8df89d068` |
| 子库预算：原样 `src/codemode.ts` 暴露的 `execute` + 一个 `Effect.sync` 计数工具 | 显式 1024 下的 1024/1025 两组、无上限 1025 组和零工具 100001 循环 | 早期运行未留独立文件；第 23 节给出后来留存的显式参数、嵌套与重置对照脚本和日志，仍不是宿主调用 |

OUT、SH、READ、BUD、VIS 已取得隔离宿主或真实注册入口反馈；RG 已取得真实进程和 core 入口，以及当前候选完整原套件；JS 已取得真实解释器组合对照。历史、投影或临时夹具结果的范围各按回执记录。

### 完整发布放行

- 发布目标 SMARK2022/opencode 的 dev1-smark：`TARGET_SHA=6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`。最终单提交 SHA 取自此精确父之后的干净候选，依次满足本规范当前精确版本独立批准、同一批准版本实施、独立实现审计和原发布门禁；任何历史批准不授权本次实施。原用户需求基线为 0ab20fa8；实际远端 R23 对照为 `62344f77616b549f28cba1c810dcb0c65e3eb041`。历史工作仅作为复现实证，在 §22–24 按原 SHA 列档。
- 同一 FINAL_SHA 的仓库根用锁定 Bun 1.4.4 启动 stock Gate：GUARD_PREFLIGHT=required bun script/guard/gate.ts push --since "$TARGET_SHA" --sha "$FINAL_SHA"。校验 diff --check、对象、唯一提交和无未跟踪调试文件。按仓库原规则执行逐提交/选中测试/契约；禁止 GUARD_TESTS=off、GUARD_PREFLIGHT=off、跳 hook、手造 stamp 或以 commit/stop/contracts 作为通过依据。
- stock Gate 若要求 preflight，必须对应 FINAL_SHA，通过原 workflow_dispatch 的 guard.yml 及 Gate 实际要求的平台；preflight exit=10 为运行中，3 为 gh 不可用，Gate 等待/失败均不得放行。保留首次退出、workflow run/head SHA、各平台结论，使用原 bun script/guard/preflight.ts status --sha "$FINAL_SHA" --base "$TARGET_SHA" / wait --sha "$FINAL_SHA" --base "$TARGET_SHA" 后，以同一 SHA 再运行原 push tier，直到 exit 0。仅在原逻辑明确无需 preflight 时记录不触发原因。无能力时如实阻塞，不能改变 Gate 代码、规则、配置、执行合同。
- 三包以 packages/codemode、packages/core、packages/opencode 各自目录执行 bun run typecheck；执行本 Plan 原窄测试和对应包回归。然后从同一干净提交在 packages/opencode 执行 bun run build --single --skip-install；从构建输出核对真实二进制 hash，使用独立临时 HOME、XDG、配置/数据目录和本地安全测试场景，在真实终端启动构建二进制。保存原生终端截图：应用初始画面、Execute/READ/Shell 与后台开关所代表的真实输出，明确截图的命令和 FINAL_SHA；不用文本转图片。若所需 UI 依赖本地 Web 界面，使用同产物的 opencode web --hostname 127.0.0.1 --port <临时端口> 启动，在真实浏览器加载并保存原生屏幕画面，记录本机 HTTP 成功以及应用/子进程/daemon 的退出。当前 PR 不修改 WebUI 功能。
- 完整构建与本次 TUI 验收分别记账：原嵌入 WebUI 构建仍按上条执行并附同锁干净基线 A/B。已复现基线与候选同一未导出模块失败且拥有者零差分，列为独立 Follow-up，不在本 PR 修 WebUI，也不写成完整构建通过。如最终候选出现不同或更坏失败，应阻断。本 PR 的真实产品是 native Execute/TUI：用同一最终提交的原项目 native 构建及真实终端启动，从测试输入读到真实工具收据、权限与后台开关；启动路由必须能复现且记录实际证据，不能拿 serve+attach 冒称内部 daemon 直启。上述不减免任何线上原 Gate、必过测试、双平台或实现审计条件。
- 归档放在用户持久位置，使用仅本次 GOAL 文件与对应 Git 对象、manifest、批准 Plan 及必要证据的文件白名单；排除凭据、HOME、私有配置、依赖、诊断与缓存。先查包清单拒绝绝对路径、目录穿越、链接与非白名单成员，然后在独立空目录解包并执行 sha256sum -c manifest.sha256；以独立自包含 Git bundle/对象库执行 git bundle verify 与 git fsck --full --strict，重放 TARGET_SHA→FINAL_SHA 后比较 git rev-parse HEAD^{tree}、git rev-list --count "$TARGET_SHA..$FINAL_SHA"（期望 1）及 git diff --name-status "$TARGET_SHA" "$FINAL_SHA"，文件清单须与批准范围一致；将结果、日志和持久化标识绑定同一 FINAL_SHA。写入提交或 PR 不等于合并。

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

### R24 补充验证范围

**一次帧收敛试验：** 6dd 继续用原 `false` 表达空闲；只在有一次帧时用唯一对象表示所有权，公开状态仍为布尔。三臂原 native 零延迟回执：基线旧帧提前消费新身份（exit 1）；R23 与短方案都保护新身份直到正常触发（exit 0）。三臂的 request/suspend/resume/idle 公共状态同为 true/false/true/false，continuous 接替和 destroy 结果保持。只改原 pinned renderer，正反重放和未改依赖文件身份一致；Toast、Dialog 及 keyed/remount 语义原样。另以受控 clock 释放已取消旧闭包，正延时原基线 staleFrames=1、继任 pending=false；R23 与短候选均 staleFrames=0、继任 pending=true。继任正常触发为 1 帧且清资源。回执 `pr5-r24-tui-phase1/` 全部 18 件 SHA256 通过。

**JS 减法试验：** 用精确 R23 与只叠加 `Array.from(..., undefined)` 转交合并、`flatMap`/`filter` 共用循环的独立候选。十一组公开 CodeMode 结果和错误逐字节相同，覆盖省略及显式 undefined、null mapper、真稀疏回调、字符串迭代、空 / 有洞、回调访问顺序；两臂完整 Codemode 包原测试均 372 通过、1,356 断言、0 失败。宿主固定配置减法另行用真实 Execute 宿主双臂各 3 通过、26 断言，分别查预跑合并、正式 1024/1025、100000/100001、下一次工具调用重新计数，以及缺省或 25 ms 的审批后计时。原测试实例不增加。证据 `pr5-r24-stage1-code-size/` 用其 SHA256SUMS 核验。

**Read 删除臂：** 精确 `62344f77` 的 read.ts、parser 和测试输入已核对。只改 V1 owner 的一处参数/调用与整页失败块，R23→候选原始差分 +2/−16；保留 parser 及同一首行准入。真实 Read / Execute 的 .ts CRLF 首行 16,384、16,385、57,142 字节时完整交付且 next=2；57,143 字节和 1 MiB 时成功返回空截断、无 next，显式 offset=2 能读到尾行。候选 4 例通过、27 断言（直接 Tool 3 例及 Execute 1 例），仓外证据不作为新增仓库测试。删除的是不可达重复检查，不伪造触发旧硬报错的用户红反馈。真实权限、I/O 或越界的 owner 不改，最终组合需重跑原测试；回执见 `pr5-r24-stage1/read-removal/RECEIPT.md`。固定发布基线的真实 Execute 同输入只在 16,384 字节交付，较长首行均返回指向原行的游标 1；R23 及删除臂效果完全相同。三臂都能凭显式 offset=2 得到尾行。已在基线本来成功的输入上绿灯时，只做仓外回归，不造永久红测。另用 `bash replay-read-page-budget.sh <保存固定对象的副本>` 对照基线解析器 blob `a6686858` 与精确发布树 `c7c6e883` 的解析器。Node 24.22.3 运行 392 组（旧/新、四种行尾、可用偏移、四种估算比率、UTF-8 失效字节和软/硬边界），没有任何返回页估算超过 16,000；该回执只证明 parser 不变量，不冒充真实 Tool、Code Mode 或最终删除分支的对照。工具类型的对照按 §13 与 §18 全工具验证矩阵；本段只记录 Read 专项。

**真实组合宿主回执：** 在隔离的 `packages/opencode`，用 Bun 1.4.4 与私有回环执行 `bun test test/session/execute.test.ts --test-name-pattern 'R24 isolated combined Read and Execute budget'`。由 `6d7241a3…` 只投影 3 个精确 blob（Read、Execute host、解释器），不含 OpenTUI、MCP。真实 resolveTools → Execute → Read 的同一脚本读取带 CRLF 的 21,000 UTF-8 字节首行（7,000 字符），按 next=2 取得尾行；同段运行 Array.from 显式 undefined、filter 及真实稀疏 flatMap，结果含 [7,7]；100,000 轮成功，100,001 轮保留显式执行限额的原错误。R23 和组合臂均 1 pass / 4 断言，观察逐字节相同。回执 `pr5-r24-stage1/read-combination/` 的 6 件 SHA256 全部通过。组合验证不替代真实 OpenTUI、MCP 或完整 Gate，也不新增正式测试。

**PARITY/MCP 独立实证：** 实际普通 `McpCatalog` 和 Code Mode 用同一 MCP 工具、同一合法成功结果：带普通可见文本与 8 或 32 层 `structuredContent` 时两路均成功；33 或 40 层时普通路径仍保留原结构并成功、Code Mode 报 `InvalidToolOutput`。固定发布基线与现有线上相同，因此不是 #5 新增，属于本轮明确扩大的全工具 parity。分歧对应既有 32 层沙箱数据复制保护，保留原保护边界。普通输出可达而脚本结构化转换先拒绝，初步分歧不在 MCP 服务器 transport 或工具自身。不得因这组证据放宽沙箱数据边界或捕获所有错误后假成功。V1 同一个 `callTool` 结果保留 MCP 协议结构；仅当普通 content 为空时补其 JSON 文本，普通工具入口另按既有展示投影交付。程序投影优先使用 structuredContent；原无 schema 单文本 alias 已明确排除带 structuredContent 的结果。Core MCP 也分别返回独立的 structured 与 content。程序值使用任意展示文本将改变现有结构合同，不能当作无损方案；较深成功值选择完整 JSON 文本，见 §20；审计批准前仅在隔离副本验证。

**R29 的两个可重放信号。** 原 GOAL HEAD `0ab20fa87080bd4fafd79d39b97fb082c4af8d62` 与原发布基线 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42` 的真实 MCP 测试具有同一 blob `48d5185db8b219c1ed9fe042c0a14c450ce1eec5`。其原第 233 行在两个基线正确期待具体对象；它是 R28 的实际失败点，不叫作基线原红。R29 完整签名断言验证新行为，在两个基线同一用例实测各 15 通过、1 失败，当前冻结 R28 生产树同一修改后像实测 16 通过、74 断言、退出 0。官方 `32ee52bec3077c4721481220b44ce2f912299bbf` 的 Linux/macOS Test (45332489797，jobs 138236689737/138236689711) 与 Linux Guard (45332489799，job 138236839396) 均命中原第 233 行，不属于 Windows 下载失败。保留 R28 PARITY-3 在工具路径、describeDefinition、紧凑签名与 search 的完整设计；原深度、MCP SDK 校验与返回语义不改。

**SH-1 的覆盖迁移。** 复用 `packages/opencode/test/session/execute.test.ts` 中 `computed workdir is created by an earlier shell and consumed by the next shell` 原用例和原生两次 Shell 调用。捕获原静默建目录调用的空正文、exit 0、未截断和未超时；第二次仍在计算的 workdir 调用原 Bash `pwd` 或 PowerShell `(Get-Location).Path`，随后由同一进程 `exit 7`。精确比较实际目录正文，只归一化路径分隔符并去掉一个行尾，断言 exit 7、未截断、未超时；显示通知不能渗进正文。现有独立 Shell 退出展示用例仍运行，原基线 blob `e83b41f0` 恢复为唯一后像，包含模型及界面既有断言。无第三次调用、无新增用例。三个真实源树的等价仓外测试，使用 Bun 1.4.4、各自真实包 preload；R28 候选本例通过 5 条断言，两个旧基线均因所收机器正文带旧通知而红；仅在仓外把退出 7 断言移到空成功断言前，分别证实原两条行为均可单独检出旧通知污染。真实 Windows 由相同 SHA 的正式 runner 验证，不从 Linux 结果外推。

实施保持完整目标生产清单不变。先核对三臂回执与审计后像，再运行原完整的 MCP、Session Execute、Shell 文件，原全量 Test、Guard、Typecheck、同提交发布验收；复跑只解决 runner 可用性，已知断言红须在 R29 审计后用新提交核验。临时副本及回执在 `pr5-r29-plan-builder/`，不进 PR。

**R30 Read 局部隔离对照。** 工作副本固定发布父 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，公开待收敛版本 `9eff6586b0c2232f88d41c3c834179ae555171d8` 仅作为等价反证，不替代需求基线。读取两个基线及现行 V1 Read、共享页 parser/formatter、历史覆盖消费者和公开测试。原 0ab20fa8 和 6dd9a5b 都在 V1 页投影把已经截断的零交付页误指向原 offset，基线已有的实际失败对照见上段 Read 隔离回执；对已经修好的 9eff 不伪造新红。最先修的是 V1 把 parser 已知的零交付页转成游标与覆盖事实的边界，parser 本身保留既有边界。

- 同一份 Bun 1.4.4、真实 V1 Tool 和同版本公开 Execute 入口，在 9eff 与隔离后像比对五组：首分页、尾页、`limit=0`、空文件、1 MiB 未交付首行。入口在 `packages/opencode`，由既有 Read Tool 与现有「execute composes native glob and read with no MCP server」的夹具启动。去掉每次新建的执行环境标识后逐项对照脚本业务 JSON；普通 V1 同时对照了 next 属性是否存在、XML reason/offset 和 read metadata。五组一一相同。
- `bun check.ts . --files packages/opencode/src/tool/read.ts --baseline <固定父基线>` 用固定父原 checker：9eff 与最终隔离后像均 0 错误、0 提示。中间 `typeof` 候选多一项提示，已放弃。最终后像相对 9eff 只改一生产文件 +7/−11；相对固定父 V1 Read 是 +32/−29（9eff 为 +36/−29），未增加任何正式测试用例。
- Core 原 V2 Read 与 ReadToolFileSystem 两文件共 32 通过、246 断言，未改 V2 / parser / renderer。仓内永久验证复用原 `test/tool/read.test.ts`、`test/session/execute.test.ts` 及两个 Core 测试文件。隔离对照按上述范围证明设计等价，不能作为完整发布门禁、远端同 SHA 验收或 R30 方案放行。 固定 9eff 与最终隔离后像又各自在独立 Linux user/net namespace 内完整跑 `bun test test/tool/read.test.ts --timeout 30000`：84 通过、395 断言、退出 0。运行前验证只有 lo、无 IPv4 外部路由、全部 IPv6 路由只经 lo、实际本机往返成功；清空继承环境，仅保留临时 HOME/XDG、PATH 和仓库现有禁模型下载选项，不在外部网络重试先前被审批拦截的动作。该局部隔离回执不替代剩余原 Gate 或远端同 SHA 验证。

**R30 JS-3 规约兼容对照。** 同一公共 CodeMode 入口使用固定父 6dd、现行 9eff、只改现行一个 reducer hunk 的隔离臂 C。旧可达面以索引写入并 pop 构造两洞，不依赖新语法。无初值且回调给常数时，双向原值 `[42,43]` 在 9eff 变成 `[null,null]`，C 逐项恢复；显式初值的回调次数 `[2,2]` 在 9eff 变 `[0,0]`，C 恢复。部分稀疏的 `["u7","7u"]` 在 9eff 变 `[7,7]`，C 恢复。密集双向 `[27,72]`、真正空数组双向既有错误文案/位置均不变。独立标准 Node 归约会跳过洞，且全空槽无初值抛 TypeError；用户没有要求用这一行为覆盖本解释器基线上已成功的输入。本轮保留基线而非扩张为完整 ECMAScript 稀疏合同。

新 `new Array(2)` 在固定父原本不支持，9eff 已支持构造但归约得到 `[null,null]`，C 对同一真实稀疏数组应用统一 reducer 得到 `[42,43]`，没有来源特判，不恢复构造拒绝。C 相对 9eff 在已有 `packages/codemode/src/interpreter/runtime.ts` 只留一处归约修改，实测 +1/−9；既有公开测试实例中的临时兼容断言为 6dd 通过、9eff 失败、C 通过。该断言对原基线是绿，按用户约束只记隔离证据，不进入正式测试；既有构造能力断言仍需对原基线为红，且密集、空数组诊断和预算回归保留。

**R30 RG/Shell 精确对照，保留原有两处必要修复。** 原需求 0ab20fa8 与固定发布父 6dd9a5b1 的 rg 入口、Shell、Execute 注册及对应工具 owner 保存同一 Git blob。用 rg 15.2.0 实际生成 73,898 字节合法 JSON 匹配记录；固定 6dd 的真实 Execute 对同一记录在解析前报 `Ripgrep JSON record exceeded 65536 bytes`，9eff 保留首中尾 1/2/3 三条有序匹配及 Unicode 正文截取。真实 Shell 的成功空 stdout 在固定父机器结果混入 `(no output)` 与 `<opencode_notice>`，9eff 交付空正文、exit 0；实际工作目录与 exit 7、timeout/truncated 仍按原合同。固定父原测试两组通过／14 断言；在固定父及原夹具只替换 9eff 的两份既有验证用例内容，两组均失败；9eff 同两组真实用例通过／17 断言。正式不增加测试实例，保留 `packages/core/src/ripgrep.ts` 去掉解析前体积硬拒和 V1 Shell 机器正文来源两处既有修改，保留原展示与权限。执行入口为 `packages/opencode` 下 `bun test --preload ../../script/guard/leak-preload.ts test/session/execute.test.ts -t 'execute composes native glob and read with no MCP server|computed workdir is created by an earlier shell and consumed by the next shell'`。这两条是原始基线可复现的 red→green，不要求新造测试框架。Shell 固定工具签名表示单独按下述交付边界控制，不改这两处运行时归属。

**R30 PARITY-3 目录边界。** 原 9eff 将模型目录中的文本备选标记施加到所有工具，实际固定结构的 V1 Bash/Read 被宣称可返回 `string`，且 MCP 描述重复追加同一解释。最先修目录赋标点；不是改变工具实际文本表示或深度限制。范围仅 `packages/opencode/src/tool/code-mode.ts` 的现有 V1 `toolTree`，前像 blob `7b8ded563e042cbb4f6c5850685e7168c0663d80`，隔离后像 `aa6145bded1ce9dcb98a478ae141ac7e8dfd833d`，精确补丁 SHA256 `d0ff55f0561f06e7fe56a6995be0f0b5003ca448337aa3624e8af78989d26d43`。内建与资源帮助工具已核对固定 Effect schema；真实 Bash/Read 结构及 PNG 附件不变。MCP SDK 内存传输仍返回浅对象、可交付完整 JSON 的深结果及图像附件；组合保留两张 PNG，MCP 搜索签名仍含 `| string`，原工具描述文字还原。隔离真实宿主对照 4 通过／24 断言，原 V1 host fixture `bun test test/tool/code-mode.test.ts` 67 通过／553；原 MCP 目录断言和深 JSON 既有验收继续运行。内置错误 union 的兼容对照只检出现行候选偏离，原基线相同固定签名保持正确，因此不增加正式测试实例。

**R30 独立核验与合并后的原规则窄查。** 另一隔离副本在真实 V1 公开入口验证负 offset 的原 schema 拒绝、越界原文、空文件及 1 MiB 截断不登记读覆盖：9eff 与 Read/归约组合各通过。扩展后的同源真实 V1 边界组各 2 通过／17 断言：空白首行后有尾行时 content 为空但 returned=1、保留 read 和 next=2；超过 16 KiB 一个字节且未超原估算上限的完整首行仍送达 16,385 字节，read 与 next=2 不变。该组合的两个原 CodeMode/Promise 文件 190 通过／734，双向旧值由上述七组控制独立复现。三处拟议后像再在独立索引组装，对照树 `3cc66330a4b06af0252e0137e2cf6d1dc10142c5`（包含旧 Plan，仅记录代码测试集合，不是发布树）分别为 Read `34bd7d99984271b2d8b0db075f64ed1b706c2509`、目录 `aa6145bded1ce9dcb98a478ae141ac7e8dfd833d`、归约 `2477095b878b4b4f99ad4f64dbcf3f0b7ba3545b`。固定父真实原 checker 只扫三个路径：组合前后各 0 错误／0 提示。已核对原完整发布路线：原 push tier → 原 preflight 或其正常不触发判定 → 同 SHA 推送 → 原 Guard/Test/Typecheck → 独立实现审计和真实运行；局部命令和隔离测试不等价于该完整门禁。

阶段 3 实机复用既有本机夹具，离线 stdio 已验的隔离配方清单：`fixture.py` SHA256 `b40c944229b01b9e76d9301b650e9b199a13f16f35739f576cb772849366705c`，配方说明 SHA256 `ec1d98baa695785f6cd2290a56f96f2b3d6124fb22e1276e34c3f40bd56f38da`。此时未用实际 R30 发布提交构建和捕获原生画面；阶段 3 从已批准、固定最终源启动，依原流程执行，不用旧截图或夹具输出代替。

**R31 B-01，五臂精确上下界。** 原需求基线 0ab20fa8 与发布父 6dd9a5b1 的解释器是同一 blob `7ce693b5d3df3157121c421308a4aad0f103f7b3`，另两臂是现行 9eff 与 R30 归约修复，以及隔离 R31。用 Bun 1.4.4 从真实公共 `CodeMode.execute` 运行同一 25 条旧可达场景；用脚本内 Object.keys/回调记录观察索引，再按机器 JSON 收据比较值。R31 与 0ab、6dd 的旧入口全部逐条相同；9eff/R30 仅保留部分。原对照的真实空槽由旧 `a[2]=7; a.pop()` 或 `a[1]=2` 构造，未使用此次新增语法。

| 原有输入／输出 | 固定两基线与 R31 | 9eff／R30 的实际偏差 |
| --- | --- | --- |
| 两洞 map 与 forEach | 双向相同索引顺序；map 回调 2 次并有 0/1 两个结果键，forEach 2 次 | 两者均 0 次，map 仅在公共输出序列化为两个 null，脚本内没有键 |
| 两洞 filter、flatMap、some、every | 输入空槽传给回调；filter 接收两个 undefined，flatMap 依返回值展开，some/every 按回调原结果短路 | 跳过空槽导致少返回值和回调，布尔值翻转 |
| 稠密源 flatMap 回调返回两洞数组 | 输出枚举 0/1 并返回两个 null | 空数组 |
| 双向规约、显式初值、真空数组 | 恢复旧值、回调和真正零长错误；空数组有初值 5/6 原样 | 9eff 成功值或回调偏离；R30 已恢复归约 |
| 直接 sort/toSorted、显式比较器、比较器回调修改输入 | 排序副本补足原 undefined 索引；改写输入只向源末尾追加，排序结果保持原长度，比较器不读 undefined | sort 可枚举键丢失；有值次序及 toSorted 已相等的分支保持 |
| 其余同域旧对照 | find/findIndex/findLast/findLastIndex、密集输入、部分稀疏及回调改变快照长度的结果经真实测试 | 没有新支持范围或独立生产分支 |

**保留用户要求的新增入口。** 用户直接原话（11 月 12 日内建回调、Array.from 与工具结果原话）：「什么叫不接受内间方法作为回调？然后改成箭头函数后成功？什么叫改成箭头函数后成功？是你让它去支持了，还是说只是你改了模型调用方法。然后关于 error，为什么不支持这样调用？这样调用支持很难吗？然后同时 Array.from 当前不支持第二个参数，这个支持很难吗。」未找到要求 map 对新构造的空槽采取与旧生产者不同语义的用户原话。新增 Array 构造在原基线从公开入口报 UnsupportedSyntax；R31 构造原数组为真稀疏（自身键 1/3、长度 4），map 消费共享旧逐索引语义（结果自身键 0/1/2/3；公开值依旧 `[null,4,null,8]`），不是按生产来源分派。原受限 Math/JSON、比较器、动态 Array.from mapper 及 Array.from 消费空槽共四组新增能力控制通过。R31 保留 `tool-runtime.copyOut` default 的宿主数组参数形状以及 true 模式已在范围内的 JSON-safe 归一；脚本内 Object.keys 的确是可观察变化，不能用机器 JSON 的相同 null 值掩盖它。已有构造验证实例只更新一条返回/期望形状以同时验证构造和映射，原基线仍因构造不支持而红；不新增旧已绿兼容测试。

精确隔离 R31 runtime blob `11fac7780f7ca2519e8f16e7b99fe549f4b00f53`，SHA256 `fea904e3464a0a5f8ce09df27576f6f040050403f40caeda4dc64a864f09ce51`。原测试不改时，同一 190 测试中唯一失败为中间稿 map 键断言；更新该实例的来源键/映射键期望（test blob `6d1a376f47c553c8f8c528e2ba3ef24bd5ea1c4e`），在 `packages/codemode` 执行 `bun test --preload ../../script/guard/leak-preload.ts test/codemode.test.ts test/promise.test.ts`，190 通过、734 断言，6.75 秒自然退出；新增正式测试实例为 0。用户要求的新增构造前提原基线失败、旧访客单独两基线绿色，避免把结果枚举变化当作新语法能力。

用同一固定原 Guard 对累积四条已改变的源码/测试路径做阶段 1 联合窄查：`packages/opencode/src/tool/{read,code-mode}.ts`、`packages/codemode/src/interpreter/runtime.ts`、`packages/codemode/test/codemode.test.ts`，0 错误、0 提示；未改 Guard。精确可回放代码/测试索引树 `c471065082aabd61443912385f54c68dd9f4d40c` 保留旧文档，不是最终发布树或提交。R30 取证继续绑定各自原回执；未以任何窄查替代原 Gate、远端或实机。

## 19. Diff Budget

目标单提交、原有用例中最小断言、零无关文件；EXIT-1 的目标只多一个生产文件及一个 owner hunk，预估新增有效 6–9 行，仍零新增正式测试实例；实际差分需用原规则核实。不借改写空行或旧 Plan 压指标。按当轮 Scope 与 Gate 的文件/行数要求逐项核对。

本版以 16 个生产路径、7 个既有测试路径及本规范 1 路径（合计 24）为上限；既有 OpenTUI 补丁计入生产路径。提交前检查完整路径清单、逐 hunk 必要性和仓库 Comment Rule，维持一个正式提交及零新增正式测试实例。若脚本签名的验证需要不同 owner，先在阶段 1 说明并提供账目、删去不必要 hunk；不得按旧版 22 路径口径放行。R29 替换一个既有测试路径：加入真实 MCP 集成路径，去掉恢复为基线的 Shell 测试路径；已在范围内的 Session Execute 承接机器正文合同行为。冻结的 16 个生产文件保持字节相同，测试七条，Plan 一条，总数 24；无新增正式测试实例。原构建、锁、依赖、Gate、阈值和权限范围保持。 R30 的固定父至完整拟议代码累计为 16 个生产路径 +372/−160，七个既有测试路径 +161/−27，加本 Plan 共 24 路径；相对 9eff 只是已在集合内的三生产路径 +13/−25，不增测试、生成物或依赖。R30 的 E/C 为历史计量，现行放行按 §17。
当前可追溯发布对照为 `6dd9a5b1… → 62344f77…`。R23 全量恢复差分 22 份，其中按路径排除 Plan 和测试、包含原 OpenTUI 补丁的 14 份生产路径原始增删为 +390/−142，净增 +248。最终保持同一口径比较完整差分，生产新增行数必须实际收缩；原有 E/C 规则另外核验。逐项记录每一处删减、映射到的旧行为及对照结果；不通过折叠代码、移文件、改注释或删必要行为凑数。目前已验证两项 JS 减法：单独叠加时 R23 runtime.ts 整文件 +9/−20（净少 11），对发布基线该文件原始差分从 +166/−71 收为 +162/−78，整体生产相应从 +390/−142 收为 +386/−149。再独立收敛宿主固定配置时，R23 code-mode.ts +3/−16，相对 6dd 的该文件从 +19/−3 收至 +6/−3；三项合并生产 +373/−149。Read 整页失败删除另算；OpenTUI 同一受审补丁相对 6dd 由 +78/−17 收为 +48/−14，安装后的真正 renderer 代码从 +16/−12 收为 +10/−6。隔离空暂存完整组合已量出档（不含 MCP 待定项）：四份独立路径从准确线上树 `c7c6e883…` 重放得 `6d7241a3…`，`git diff --check` 通过。对固定发布基线 `e0baea4a…`，全部 14 个生产文件的原始增加行从 390 降到 329、净增从 248 降到 183，候选完整口径为 +329/−146。第二个空索引得到同一生产数字；原始 diff 分段由 56 到 61，生产文件仍 14、测试差分仍 7 文件 +158/−18；不按 hunk 数冒充代码增量。只证明完整组合可重放及差分度量；已另做三份运行时源的同宿主组合回归（§18），仍不替代 OpenTUI、MCP 或完整 Gate；最终选择、验收和计数仍须绑定包含全工具 parity 结果的正式提交。见 `evidence/isolated-known-reductions-numstat.log`。

MCP 单项精确增量为 +31/−5。与其余收敛组合后，生产树 `bf4d67508e5a3f54f06c40d238ddc3b313b41586` 的同口径发布差分为 15 个文件 +360/−151，净增 209；与 R23 比少新增 30、少净增 39。未包含插件待核对项，不是最终提交预算。回执 `mcp-json-text/production-preserve-schema.numstat` 和 `production-total.numstat`。

R31 四个同范围文件较现行 9eff：三生产路径 +34/−66（Read +7/−11，目录 +5/−5，runtime +22/−50），一个现有测试路径 +2/−2。固定父 6dd 到完整目标：16 个生产路径 +331/−139、7 个现有测试路径 +161/−27、Plan 一条，共 24 路径；不增加测试实例、文件、生成物、依赖或 Gate 变更。两段统计各自固定基线，实施仍以完整经审计终态为准。

## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

在当前范围内重建可继续规划；对外提交仍按已有用户要求和执行审核决定。需超出原需求、改变原权限或替代历史行为时先请用户决定，不以旧审批代替。

**MCP 完整 JSON 文本，阶段 1 候选。** 只对已通过 SDK 合法性校验且超过原沙箱深度边界的结构成功值返回完整 JSON 文本。真实 MCP SDK、McpCatalog 与原解释器组合 48 条核查通过：8/32 层仍是原对象；33/40 层完整文本；带独立展示、无展示、附件、UTF-8 约 18 KB/60 KB 以及 isError 都已走到。终端回执的既有裁剪留在原 Session 输出端，脚本中的文本未先裁剪。样本有独立展示时，普通展示文本本身不能充当完整结构。纯文本方案无需新写盘，类型须公开对象或文本；JSON.parse 仍执行相同沙箱限制。已进一步复用真实 SessionTools、Execute 与 processor 对照，原臂 1 例 14 条，复现 33/40 层四组错误；候选 1 例 26 条，32 层原对象、33/40 层完整 JSON、合法 isError、图片附件均达到预期。60,402 字节直接交付；120,402 字节沿既有 Session 截断，原 outputPath 保存完整 JSON，模型所见与会话历史一致。不会先强制写盘。两臂来源及补丁在 `pr5-r24-stage1/mcp-json-text`。接下来核对共用单一深度规则、公开类型以及生产差分。方案未批准。隔离证据 `pr5-r24-error-parity/deep-json-text-probe`。

### Follow-up

当前发布范围固定 6dd9a5b 至最终候选。最新目标已落地的部分只保留原验证，不重演历史补丁；其余目标完整保留。正式 Guard 与恢复如实记录；若真实主线再动，先核各 owner 前像和发布合同，不能用历史结果覆盖新失败。

READ 选定现有 V1 token 准入与共享 parser 物理记账；真实 V1 对照支持该路线。淘汰 32 KiB 固定首读、捕获整个旧辅助扫描、R7 无界组装及虚构 next。合法正文由真实行与原预算决定，展示限额保持。

V1 有普通工具错误通道（read.ts:574–587）。候选优先复用现有 parser 结果：对固定 V1 路径（正 limit、raw 捕获开启、非辅助起步），越界先走原有规则；参数允许 limit=0（read.ts:203），该值保留现有零行请求行为。若 raw.length=0 且 cut=true、more=true，当前首行未交付。仍返回真实截断页；保留原 reason，去掉机器 next 和 XML offset，不增加文本报错或覆盖记录。只要交付至少一行（包括空白行），保留正文、截断标记及指向首个未交付行的 next。正常 EOF 保留成功。当前不新增原因字段；只有宿主实证必须提供不同且可准确区分的恢复动作时，再评估最小内部信号。

固定 HEAD 的 READ parser 直接消费入口为 V1 read.ts:561（普通原文捕获）、V2 read-filesystem.ts:276（strict UTF-8、BOM/二进制检查）和共享 read-outline.ts:261（从辅助模式起步、captureRaw=false、Infinity、回调消费）。不将 V1 的判定复用于后两者。parser 仅两处置 cut：完整行提交的字节预算检查（read-lines.ts:151）与追加字符前的增量字节预算检查（:179）；行数用完和正常 EOF 均不置 cut。方案若用旧辅助额度保护未完成的超软窗首行，需要维持 cut/more 的既有含义；8 组已跑对照涵盖空白行/部分页/空 EOF 与两类负样本，已追加无原因字段的中性投影对照，见实测记录。

交付行数取 parser 实际保留的 raw.length：共享 parser 在确认行完整后才 push（read-lines.ts:157）；V1 read.ts:717 和 V2 read-filesystem.ts:345 都按返回条数算 next。R20 选择 V1 既有成功 text-page 合同处理零进度首行，V2 默认调用和 outline 不动。本 PR 沿用按行 offset，不引入行内游标或分段续读。中性替身和实际 V1 窄实验已验证；实施后仍对最终差分重跑正常分页、权限、展示和部分页。

阶段1 回归修订：R2 审计发现排序比较器改动源数组后会截断快照，以及公开结果直接消费会观察到不符合 JSON 的洞。R3 在原 sortArray 记录比较器尚未执行的长度；在原 copyOut(…, true) 仅把公共 JSON 数组投影稠密化。已取固定基线、R2 组合候选和 R3 的同输入回归证据，未改变解释器内部稀疏语义或 copyIn。R3/R4 的出站实验记录见 §23。R4 让所有默认出站数组密化，会把已有索引赋值等路径产生的真洞改成属性；应撤销全面密化和未经需求授权的字面量生产改动，从源头分别维持旧字面量和旧真洞宿主合同，只保留公共 true 模式结果投影。

EXIT-1 只修原测试实测暴露的 ToastProvider 生命周期；保持 fixture 与产品两个迟到 producer 原样，以证明 owner 正确拒绝其过期写入。不能把此红绿扩展解释为全部 Gate、其他包或远端配置已绿。

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

MCP 候选保持原协议 JSON Schema 根引用和 SDK 校验。仅在既有 Code Mode 的工具目录说明 Git 树中验证的文本投影；普通模式目录不变。真实 Session 34 条断言覆盖含根 `#/properties/child` 引用的原 schema（search 深比较相同），SDK required 拒绝、真实 isError、深值后的合法同级字段、附件以及 60 KB 直出/120 KB 既有恢复。生产路径四份：`session/tools.ts` 仅标记 MCP 目录项，`tool/code-mode.ts` 为对应结构化成功加内部标记并注明投影，`codemode.ts` 通过既有宿主适配面交接，`tool-runtime.ts` 唯一 copyIn 将深度拒绝分类并仅对可信 JSON 转文本。其余数据错误不变，未增加深度常量或物理写入。

插件真实红测：以磁盘插件文件走正式 registry、普通 Tool 与 Execute。同合法 JSON 8/32/33/40 层均可在普通模式成功；未声明输出 schema 时，Execute 四组均错误，首先错误归于目录默认 `Schema.String`；声明 `z.object({child:z.json()})` 时 8/32 层两路成功，33/40 层只在 Execute 失败，归于旧 copyIn 深度。真实业务 throw 和 Zod 拒绝均按两路保持。原臂 1 例 36 条断言，`plugin-depth/RECEIPT.md`。收敛方案仍用这两处 owner，区分普通本应交付的文本与声明过的结构，不擅自读取任意宿主值的更深属性，也不缩短真正的工具出错信息。

历史深度片隔离回执（由本版领域类分支和精确联合树替代）：Session 继续从现有普通与 Execute 的同一 invoke 得到必填 output 文本及附件；Execute 组织程序值、既有普通文本和可信来源，保留 rawText 优先。解释器按原真实 schema 在原候选值上解码，再照旧复制一次；仅发生原深度拒绝时，MCP 用已经 SDK 校验的完整 JSON 文本，其他工具用原本交付的 output 字符串，不遍历更深宿主属性。原合法浅对象、原体积处理、schema 与真实错误都保留。真实磁盘插件声明结构与 MCP 合计 3 例 50 条通过。未声明输出的插件另外只修真实插件定义所属 registry 一行 `Schema.Unknown`，使其目录如实公开 unknown，旧文本仍是文本，明确 Zod 声明保持。组合正反及最终差分待复核，不能以单项回执当作已批准。

完整 R24 隔离交接：对准确 R23 合入之前全部删减以及 PARITY-1/2 后，固定发布基线 tree `e0baea4a…` 对候选 `c8725ffc5b96a7fbc6c4d732a9f71bf4fb70be3d`，生产 16 文件 +371/−160（净 211），比 R23 少新增 19、少净增 37。最窄 MCP/插件片 5 路径 +42/−14。新增临时夹具不进提交；历史 R24 插件宿主回归隔离时曾改旧签名；R27 将单个签名预期修正在原 Session 既有实例，原业务输出和明确结构化 schema 断言原样。正式范围仍 16 生产 + 7 测试 + 本方案 = 24，原发布基线的 Core Ripgrep 测试文件恢复不改，既有 Execute 用例接同计划的长记录；零新增实例。全真实宿主 3 例 83 条通过，解释器 372 例 1,356 条通过；原固定 0ab20fa8 磁盘插件基线 1 例 36 条验证确红。SDK 执行过真实根引用与 required 校验，Effect codec 在原结构不合时拒绝、仅数据深拒绝触发文本。回执 `mcp-json-text/PRODUCTION-COMBINED.md`，独立插件 `plugin-depth/RECEIPT.md`。源样本仓根 `mcp-session`（隔离样本），原 GOAL 只读工作树 `daemon-exact-0ab`（只读原始基线样本）；正式 Git 基线 6dd9a5b1 不调整。整体产物须按 §18 原 Gate、实机和最终提交验证，当前不进入实施。

R25 联合验证：在固定发布基线加入全部既有收敛、B-01、B-02 及当前正式 7 个测试前后像，得到最终隔离树 659688c75b1b7f21880781357b72257ff12a3672（替代未统一格式及现有断言的 05401581…）。原 SessionTools 真实运行 3 组 109 条断言通过，包括磁盘插件的浅层、深层和领域类、真实 MCP、原协议 schema 和根引用、Tool discovery 的类型与脚本 typeof 消费。B-03 的独立实际扩展入口两臂各 7 条并验证一次调用，见 §13；与磁盘插件共用后段。生产 16 路径 +386/−162（净 224）对 R23 +390/−142（净 248）；正式测试仍 7 路径，+166/−21：在既有 tool/code-mode.test.ts 两个实例修正原对象签名预期，一个已有结构实例复用同一夹具，补固定原需求基线能检出的深值普通文本断言。加唯一 Plan 共 24，零新增测试实例；Session 探针仍全部仓外。最终原工具文件 67/553、解释器 372/1,356、CodeMode 类型检查、原 staged 静态检查均 exit 0；静态 checker 覆盖 22，跳过 commit-msg 的大小判断，不能替代最终 Gate。Guard/check、shape、baseline 与 6dd 字节一致。参见 signature-depth-text/r25-*、final-* 回执。

## 21. Audit Contract

R5 的固定基线与候选回执覆盖两条既有来源的宿主 ABI 与公共结果/集合行为。R6 完整重审包含历史 GOAL HEAD 到全部目标行为、EXIT-1 的实测生命周期根因和新 owner seam；此前 R5 APPROVE 不承继至 R6。R7 §1 的 R-JS 归纳和 §6–7 明定 Array()/new Array()、Array.from mapper 与按方法跳真洞；§1 的对应原文未要求重写数组字面量。精确历史 0ab20fa→cff9a356 的 runtime hunk 也未修改 evaluateArrayExpression。此次保留历史要求，不把可选的 JS 一致性扩展当作修复。之后只按现有计划审计合同提交独立审计。

R7 按完整原 GOAL HEAD 0ab20fa8 至最终行为送独立全范围审计，保留 R6 已批准的全部合同。R6 的批准只对应冻结快照，不授权实施 R7。

R10 仍从 pre-R1 0ab20fa8 写到完整交付目标。R8、R9 的 B-07 精确 verdict 如下，本版从 renderer 一次帧所有者统一收口，沿用现有 Core patch 和 §20 冻结安装、原夹具放行条件。本版待独立全范围审计，实施不允许。

R17 从原需求基线到完整终态交独立全范围审计。R16 判词仅适用于历史 R16 冻结版本。R17 仅在本版独立批准后实施并交独立实现审计。

## 22. Revision Delta and Plan Audit Record

| Revision | Sections | 修订理由 | 状态 |
| --- | --- | --- | --- |
| R1 | 原草稿 | 恢复需求及证据；无审计、无批准 | 已被当前草稿替代 |
| R2 | §1、§10、§13–15 | 按用户原话，把目标完整映射到固定 0dff，不以历史/阶段差分作实施范围 | 已独立审计 BLOCK（见原 verdict） |
| R3 | §1、§10/15、§18、§20 | R2 BLOCK：排序长度、公开 JSON 值边界和验收合同 | audit-required，清批准；动态三臂完成，正式验收留实施 |

| R4 | §10、§13–16、§20、§23 | R3 BLOCK B-04：既有工具出站参数 own index/undefined；保留 R3 已关闭项 | audit-required，批准 none，实施 no；三臂与回归均已验证 |

| R5 | §10、§13–16、§20、§23 | R4 BLOCK B-05：撤回字面量和默认参数强制密化，保真洞来源及公共 JSON | audit-required；Approved revision: none；Implementation allowed: no；回执已验证 |
| R6 | §1–24（全范围重审） | 原 Gate 双臂同红；增加 EXIT-1 的必要 owner 设计；原历史需求基线与发布基线分开 | audit-required；Approved revision: none；Implementation allowed: no |
| R7 | §1–24（全范围重审） | 固定两臂复现 route 遗留滚动句柄，只加 SCROLL-1 | audit-required；Approved revision: none；Implementation allowed: no |
| R8 | §1–24（全范围重审） | 为 B-06 明确 renderer owner、SLOT-1、唯一现有 core patch 及原门禁前置 | 独立审计 BLOCK B-07；实施 no |
| R9 | §1–24（全范围待审） | RENDER-1 暂停恢复须同步撤销旧的正延时句柄 | 独立审计 BLOCK B-07；实施 no |
| R10 | §1–24（全范围待审） | RENDER-1 统一一次帧活动记录、物理句柄和启动/暂停/销毁作废 | audit-required；Approved revision: none；Implementation allowed: no |

| R11 | 最新发布基线与验收 | rebase 至 0b5754df，沿用新版 Gate | 已独立方案批准；历史 |
| R12 | §18、§23 | runtime.ts 从净 +130 行收敛至 +100；固定基线 stock benchmark seed 仍失败 | 独立审计 BLOCK B-08；保留原判词 |
| R13 | §1、§3、§10、§18、§20、§22–23 | rebase 至 98a9f13；目标自带 B-08 修复，重新绑定原静态、原基准及发布验收 | 独立审计 BLOCK B-09/B-10；历史 |
| R14 | §1、§3、§4、§18、§20、§21–22 | 修复 B-09：消除现行发布对 0dff/0b 的引用，正式命令与父提交统一 98a9；B-10：补完整 Workflow 原文 | 独立方案批准；见原裁决，仅限历史 R14 |
| R15 | §1、§3–4、§10、§18、§20–22 | 发布基线移到 27f5f62，原 Guard 失败日志、覆盖建图及实际选测重新绑定；产品目标与 21 路径不扩大 | 已独立方案批准；旧实现和验收仍按各自证据 |
| R16 | §1、§3–4、§10、§18、§20–22 | 移到 8aead09；当前入口、viewport 原夹具、选测和最新基线复核，保持 21 产品后像和完整原需求 | audit-required；批准 none；实施 no |
| R17 | §1、§3–4、§10、§18、§20–22 | 发布基线移到 5bc061b；复验 mapper、原 Core afterAll、原选测；按 #5 已授权验证分支执行原发布验收，保留 21 个后像 | audit-required；批准 none；实施 no |
| R19 | 全范围独立方案审计 | 相对真实 6dd 保留完整需求和十九条冻结后像；继承 Session 与已关闭 renderer 生命周期，只修可实测的一次帧身份缺口 | audit-required；批准 none；实施 no |

| R24 | §1、§7、§10、§13–16、§18–20 | 汇合整体收敛、删 Read 重复报错，验证 MCP 与插件的真实普通/Execute 分歧 | 独立审计 BLOCK，B-01、B-02、B-03；不实施 |
| R25 | §7、§10、§13–16、§18–20 | 合法领域实例展示、脚本类型独立于 wire schema、冻结全工具和放行合同 | 独立审计 BLOCK：B-01 正文漏同步，B-02/B-03 关闭；不实施 |
| R26 | §7、§10、§15、§16、§18、§22 | 将领域类形状分支写入正式执行和验收合同 | 曾全范围批准并复放；实际原 Session 失败，现已停止，不能放行 R27 |
| R27 | §15、§16、§18、§19、§22 | 原 Session 未声明输出断言修正，长 rg 断言迁入同一文件已有 Grep 用例，原 Core 测试文件保留 | 独立复审 BLOCK B-04（原 Session 未有终态），实施 no |
| R28 | §18、§22 | 补原 Session 整文件自然退出 0，记录独立精确差分重放；代码与测试不变 | 全范围 No blocking findings / APPROVE，实施 yes；历史 |
| R29 | §1、§13、§15–16、§18–19、§22 | 保留原生产合同，同步真实 MCP 已有签名断言，并在既有 Session Execute 实例保留 Shell 行为，同时替换测试路径保持 24 条 | audit-required；Approved revision: none；Implementation allowed: no |

### 已归档的 R2/R3 历史方案审计

原审计逐字保存在发布归档 `32ee52bec3077c4721481220b44ce2f912299bbf:docs/plans/execute-result-recovery.md` §22（全文 SHA-256 `5635c2b96be54c3f46a23d60275f0f0a5a37c7d97c914822c19ac4bfb8011446`）；完整副本 `R28-published-plan.archive.md`。原历次裁决未改，以下保留分类、原编号与结论。

- R2 blocking B-01（比较器改变源数组长度时，`sort` 丢失结果）、B-02（解释器空槽泄漏到公开 JSON 结果）、B-03（最新交付要求仍未进入可执行验收合同）；原 non-blocking 是混合历史/现有宿主回执与计数标签。原 Release verdict：**BLOCK**。修订同一份 canonical plan，补齐三项后重新做全范围方案审计。
- R3 blocking B-04（稀疏字面量改变了宿主工具收到的参数）；原 non-blocking 是分别记账原 Gate 临时 preflight 与最终分支更新。原 Release verdict：**BLOCK**。补齐宿主参数兼容并重审同一 canonical plan。

<details>
<summary>R4 独立方案审计原文</summary>

## Blocking findings

### B-05 R4 把已有的稀疏宿主输入改成显式 `undefined`，原本成功的工具调用失败

- Violated invariant: JS。支持新的构造与回调行为，同时保留既有宿主参数合同。
- Evidence class: observed
- Producer and execution path: `CodeMode.execute → 给数组下标赋值 → copyIn → copyOut 默认模式 → raw 或 JSON Schema 工具处理器`。
- Source evidence: `packages/codemode/src/interpreter/runtime.ts:3260–3283` 支持下标赋值；`packages/codemode/src/tool-runtime.ts:298–303,326–332,771–797` 保留空槽并把参数交给宿主；R4 临时候选的 `r4-delta.diff` 将默认模式也改为 `Array.from` 遍历每个位置。
- Canonical-plan evidence: §10、§15 JS-3/JS-5、§23 R4 验证。验证覆盖了数组字面量与显式 `undefined`，但没有覆盖基线上已经能产生的真实空槽。
- Responsibility owner: CodeMode 数组生产与出站合同。
- Concrete behavioral consequence: 独立实跑 `const list=[]; list[1]={name:"one"}; return await tools.host.raw({list});`。普通宿主处理器用 `list.map(item => item.name).join(",")` 消费。R4 给索引 `0` 写入 `undefined`，导致工具返回 `ToolFailure`。换成 `Tool.make` 的 JSON Schema 工具，同样失败。
- Pre-R1 baseline behavior on the same path: 固定 `0dff` 和 R3 都保持索引 `0` 为空槽，两种工具均成功返回 `",one"`。
- Round basis: introduced by delta；strict class，原本成功的宿主调用退化。
- Minimal correction direction: 保留默认出站模式的既有空槽行为；若按 R7 §6–7 的合同只需支持 `Array(n)` 和集合方法的空槽语义，撤回额外的字面量生产变更，继续在最终 JSON 值边界规范化为 `null`。

## Non-blocking findings

R4 的三臂报告准确覆盖其字面量样本；应把「历史外部 ABI」收窄为经测的字面量输入合同。

## Follow-up

V2 Read、通用集合重写和 Gate 改造继续留在范围外。

## Rejected speculation

不需要修改宿主解码器、为数组添加来源标签，或另建序列化路径。R7 的明确覆盖面是构造、集合消费和 mapper，归档中没有要求改变旧的字面量生产路径。

## Requirement and traceability coverage

核对了 R4 SHA-256 `af0f9e2d04839be53927afff9960b991ca9ede018a862672f205197598cbbeb4`，重跑了原 `host.ts` 三臂，确认 R4 对 B-04 的原始字面量输入已恢复。后续探针独立覆盖下标赋值产生的空槽，结果见 B-05。B-01 至 B-03 的排序、公开 JSON 结果和发布验收修订仍有效。OUT、SH、READ、RG、BUD、VIS 未发现新增阻断项。

## Primary-path and fallback verdict

未新增备用成功路径。基线内已存在的两种数组输入仍需由原生产与出站路径共同保持各自合同。

## Release verdict

**BLOCK**。修订同一 canonical plan，并用原字面量和下标赋值两组公开宿主路径重审。

</details>

<details>
<summary>R5 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

§23 保留了研发过程中的旧候选和淘汰路线。实现审计时以 R5 §10、§15 和最终实测收据为准，避免将 R2–R4 的临时字面量断言误作正式验收。

## Follow-up

V2 Read、通用集合重写和 Gate 改造仍在范围外。

## Rejected speculation

无需给数组标记来源、改变宿主解码器或增加备用序列化路径。R5 保留旧字面量表示与原宿主投影，在既有公开 JSON 边界处理空槽。

## Requirement and traceability coverage

核对了 R5 SHA-256 `6de775c44e1834894f1ccac3257923bca9b39f90160299d5bd056b43d3f682ff` 和固定 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。独立重跑基线、R4、R5 的公开执行入口及 R5 纯解释器对照：

- B-01：比较器缩短源数组时，排序结果仍为 `[1,3]`。
- B-02：公开结果将真实空槽投影为 `null`，直接结果与 JSON/Schema 往返一致。
- B-03：原始验收指令、同 SHA 的 Gate/preflight、真实终端截图及独立恢复步骤均已锁定。
- B-04、B-05：两类宿主工具继续收到旧字面量的索引 `0`，并跳过下标赋值产生的真实空槽。R4 的工具失败在 R5 恢复；两种新 Array 构造也通过同一宿主入口。

OUT、SH、READ、RG、BUD、VIS 均保留明确的 owner、原路径和行为验证。正式实施、Gate 与最终交付验收按 R5 执行。

## Primary-path and fallback verdict

各项修复沿既有主路径，没有新增备用成功路径。R5 撤回了导致宿主兼容回归的字面量和默认出站改动。

## Release verdict

**APPROVE**。仅放行上述哈希对应的 R5 方案。

</details>

### R6 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

区分 EXIT-1 的隔离回执与最终单提交的 Gate 回执。前者证明方案有效，后者仍须按 R6 对最终 SHA 验收。

## Follow-up

保留现有会话请求取消策略。EXIT-1 只处理通知所有者卸载后的资源释放和迟到写入。

## Rejected speculation

单独清除现有计时器不能阻止卸载后的通知重新分配计时器，隔离对照仍红。补齐 fixture 响应会避开已复现路径，改 Gate 则违背用户要求。两个方向都无需纳入。

## Requirement and traceability coverage

核对了 R6 SHA-256 `75242c9b71f945aad54f9a1ebd2f79ce254cb4d71f5f750793608ba7d1f9fb74`、历史需求基线及发布 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。原 OUT、SH、READ、RG、JS、BUD、VIS 和 REL 的设计及验证范围保持完整。

EXIT-1 对应原 Gate 已复现的退出问题。独立复核了双红报告和候选差分，并重跑原 TUI 退出测试与通知生命周期探针，两者均通过，共 9 条断言。正常通知仍按既有时长展示、替换和消失；卸载释放活动计时器，迟到调用不再写入。

## Primary-path and fallback verdict

EXIT-1 留在 ToastProvider 所有者的卸载和通知入口，保留会话退出、原 fixture 和 Gate。未新增备用成功路径。

## Release verdict

**APPROVE**。仅放行上述哈希对应的 R6 方案；最终代码差分、Gate 与发布仍须按方案验收。

### R7 独立方案审计原文（全范围，B-06）

<details>
<summary>独立审计原文</summary>

## Blocking findings

### B-06 R7 保留了验收条件，但没有安排解决已复现的 Gate 阻断

- Violated invariant: REL。最终交付须通过原 Gate，达到可合并质量。
- Evidence class: observed
- Producer and execution path: 现有受影响测试选择 → `auto-review-render.test.tsx` → 切换会话用例 → 原 `leak-preload` 清理检查 → Gate。
- Source evidence: `script/guard/gate.ts:157–174,215–242`；原选集 `affected.plan.json:67`；`scroll50-owner/active-overlay.stderr`。我独立重跑候选：partial glob 通过；切换会话的两条业务断言通过，但原清理检查仍报告两个渲染循环句柄和一个 `requestRender` 句柄，命令退出 1。
- Canonical-plan evidence: §18 记录该红点；§2、§20 明确排除对应所有者或依赖修复，现有路线只有重跑。
- Responsibility owner: REL 发布方案负责处理阻断；剩余资源属于 OpenTUI，不属于 Session 滚动调度。
- Concrete behavioral consequence: SCROLL-1 消除了会话自身的 50 ms 句柄，但实施计划内的所有变更后，已知的原验收路径仍会拒绝放行。
- Pre-R1 baseline behavior on the same path: 固定发布基线在同用例同时报告两个 Session 滚动句柄和三个 OpenTUI 句柄。后者是已有的发布阻断，非 SCROLL-1 引入的回归。
- Round basis: strict class，用户明确要求的最终验收路径仍失败。
- Minimal correction direction: 保留原 Gate，将剩余红点列为明确的发布前置条件，绑定已验证的兼容基线，或取得范围决定后在实际所有者处修复；不要把重跑写成解决路径。

## Release verdict

**BLOCK**。先补齐已知 Gate 阻断的发布前置条件，再全范围重审。

</details>

### R7 B-06 后续隔离事实（非审计原文）

原 active switch 在单独 SCROLL-1 后仍报两个 OpenTUI loop 与一个 requestRender。精确依赖隔离先证实两种句柄丢失：延迟单帧未保存句柄，直接 renderOnce 进入 loop 时先抹掉已有连续帧句柄。原组合仍报一处 requestRender，私有追踪查到同一个 renderer 已 cleanup 后，销毁子节点的 remove 调用在 destroyed 状态重新安排。隔离组合保留现有帧延时与 native ABI，只验证上述 owner 生命周期事实；正式载体未选。

无探针隔离组合用同一原 stock leak-preload、相同两个原文件用例：active switch 1 pass / 0 fail（2 条断言，2.81s）；partial glob 1 pass / 0 fail（2 条断言，2.47s）。独立实际 SystemClock 对照确认活跃渲染仍会触发、销毁取消活动句柄、异步 frame 被销毁后未重新安排。收据 b06-destroyed-guard/SHA256SUMS，SHA256 aa0c73f488edc26c19db5415602028b27df2bfd1abef4b2e6667a0921cb24758。固定 fork .12、.13 与 smark/main 的 renderer 源码相同，核对的 .14/.15 标签不存在；现有依赖版本、实际源码、Gate、Plan 的实施范围及审批状态保持原样。这些窄绿不替代原 Stop 或下一轮独立方案审计。

另用原 stock leak-preload 单独核查 Spinner。斜杠命令提交用例在固定发布基线、R6 和上述隔离组合各 1 pass / 0 fail，未单独复现。原 session preview 的 `preview refetches only the session whose version changed` 在相同三组均 exit 1，原断言共 4 条，唯一错误均为 `opentui-spinner/dist/src-DjeqLSfu.mjs:1:335` 的约 79.94 ms interval，未出现 Session scroll 或 OpenTUI renderer 残留。原始清单 spinner-stock-ab/SHA256SUMS，SHA256 ee46fa0b794815241be5a45f6b93ca673bdae7151296472f35069ba1c33ab393。Spinner 仍独立待归属，未纳入本版实施范围。

### R8 独立方案审计原文

来源 sidecar SHA256 `26ec32621db0662223ffcd76af4ef8329b5dd941a02f767850b13c0a39d83767`。

<details>
<summary>R8 独立审计原文（逐字）</summary>

## Blocking findings

### B-07 暂停再恢复会覆盖尚未触发的渲染句柄

- Violated invariant: RENDER-1、REL。渲染器销毁须释放自身仍持有的延迟渲染句柄。
- Evidence class: observed
- Producer and execution path: `requestRender → suspend → resume → requestRender → destroy`。TUI 的终端挂起和外部编辑器都调用这条公开暂停／恢复路径。
- Source evidence: 锁定候选的 `index-b5dpwnes.js:7775–7810,9580–9643,9688–9723`；`packages/tui/src/app.tsx:1035–1036`；`packages/tui/src/editor.ts:31,51`。
- Canonical-plan evidence: §10 RENDER-1、§15、§18、§20。单字段只记录最后一次安排；已执行对照覆盖正常激活、手动接替和异步帧销毁，缺少暂停／恢复。
- Responsibility owner: OpenTUI renderer 自己的延迟渲染调度和清理。
- Concrete behavioral consequence: 用真实 `createTestRenderer` 与既有时钟接口，在同一候选独立复现：第一次请求后有 1 个句柄，暂停恢复后有 2 个，销毁后仍有 1 个。`suspend()` 先重置 `updateScheduled`，`resume()` 再安排一帧，覆盖保留的句柄。探针 SHA-256 `832eaf947f3e4b9c8ee62c0ac6676e83ba8039757fa9a29708ad3d493b8981d3`。
- Pre-R1 baseline behavior on the same path: 未改的锁定依赖在同输入下销毁后仍有两个句柄。R8 修掉其中一个，明确承接的资源释放行为仍有缺口。
- Round basis: introduced by delta 的单字段所有权失配；也是 B-06 所需关闭的渲染资源路径。
- Minimal correction direction: 让现有 renderer 所有者释放全部待触发句柄；若选择在替换时取消旧句柄，先实测暂停恢复期间仍保留正确的有效帧。

## Non-blocking findings

独立用同一私有组合运行了原 active switch、partial glob、preview 和 active scan，四项共 11 条断言均通过。现有 Core patch 是单一载体；已核对补丁及生成 chunk 哈希。完整冻结安装和同 SHA 原 Gate 仍按 R8 的发布前置条件执行。

## Follow-up

保留原 Gate、原夹具与原冻结依赖验证。当前私有组合通过不能替代正式验收。

## Rejected speculation

无需改动画频率、加测试等待、改 native ABI 或修改 Gate。

## Requirement and traceability coverage

核对了 R8 SHA-256 `995236a13686cbee91f48861d066f71c003257c39375d91b77f148861d208c89` 和固定发布 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。原功能路径和 EXIT-1、SCROLL-1 的合同保持。R8 为 B-06 增加了明确的产品责任方和原 Gate 放行条件；RENDER-1 仍缺 B-07 所述的实际生命周期。

## Primary-path and fallback verdict

设计继续沿既有 Session、DialogSelect 和 renderer 路径，没有新增备用成功路径。修正应留在 renderer 调度及清理的原所有者。

## Release verdict

**BLOCK**。补齐暂停／恢复的句柄所有权，验证有效帧与销毁，再全范围重审。

</details>

### R9 独立方案审计原文

来源 sidecar SHA256 `37391d15f007dbb88d0327706691aea160bbb62a8e419dff5fd825ef55c5c095`。

<details>
<summary>R9 独立审计原文（逐字）</summary>

## Blocking findings

### B-07 普通帧切入活动渲染时，仍会遗留被覆盖的句柄

- **违反约束：** RENDER-1。渲染器须持有延迟帧句柄，直到触发、撤销或销毁。
- **证据：** 我独立重跑 R9 的暂停／恢复用例，原问题已修复。随后用真实 `createTestRenderer` 和已有时钟接口实跑 `requestRender → requestLive → dropLive → requestRender → destroy`。待处理的单次渲染句柄数量依次为 **1 → 2 → 1**；销毁后第一个句柄仍未释放。探针 SHA-256：`0f39905cc0c2633df25d9b869f0f771c59af3764786511d01c08b721a55055c2`。
- **实际路径：** 锁定 renderer chunk `index-b5dpwnes.js:1437–1444` 的 `propagateLiveCount` 会调用 `requestLive`／`dropLive`。`:9551–9578` 的 `internalStart` 清除 `updateScheduled`，但不撤销此前的延迟帧。回到空闲后，新一次 `requestRender` 覆盖该字段里的句柄。
- **方案缺口：** R9 §10、§15、§18 只补了 `suspend` 的撤销，保留了其余可覆盖单字段的路径。旧基线本就不追踪这类单次句柄；R9 在这条路径上仍未兑现新方案明确承接的销毁合同。
- **最小修订方向：** 在同一个 renderer 所有者内统一处理所有实际可达的撤销入口，或记录并释放全部待触发句柄。复验有效帧与销毁，不改 Gate、帧间隔或调用方。

## Non-blocking findings

原暂停／恢复复现已绿。B-07 剩下的是同一所有权缺口的活动渲染入口，不需要扩大到其他 UI 模块。

## Follow-up

正式冻结安装、原 Gate 和同 SHA 实机验收继续按 canonical Plan 执行。

## Rejected speculation

无需改变原测试、native ABI 或禁用活动渲染。

## Requirement and traceability coverage

核对了 R9 SHA-256 `4d216d7ba6fd724b1368aab0bc3e3b6f19a3ca5cfb6b680a7d6acede1a5007c5` 和固定发布基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。原功能、EXIT-1、SCROLL-1 和 SLOT-1 的路径保持；尚未关闭的是 RENDER-1 的完整句柄生命周期。

## Primary-path and fallback verdict

修订应留在原 renderer 调度及清理路径，无需备用路径。

## Release verdict

**BLOCK**。补齐活动渲染切换的句柄所有权，再做全范围重审。

</details>

<details>
<summary>R14 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

§10 把待复验的候选写成「R13 实际候选」。实际验收按 §18 的 R14 单提交执行。记录本轮裁决时，可一并补存 R13 的 B-09、B-10 原文；§22 目前只记了编号和结论。

## Follow-up

实施后用最终同一 SHA 核验原冻结安装、完整 benchmark 双臂、最新 Gate、真实构建和终端、独立实现审计及空目录恢复。单轮 seed 证据只关闭上次 benchmark 的最早失败点。

## Rejected speculation

无需修改 Gate、降低 benchmark 输入、额外增加产品改动或另开计时器 PR。已合入的 benchmark 修复随目标分支继承。

## Requirement and traceability coverage

B-09、B-10 已关闭。§1 补齐用户原话，要求方案审计、实施及独立实现审计。现行重放、正式尺寸检查和 Push Gate 统一绑定 `98a9f13`；GitHub 与送审仓库均确认该目标。`0ab20fa8` 保持固定需求基线，其他基线只用于历史回执。

完整保留 21 个代码、测试及补丁路径与唯一 Plan。冻结补丁在当前基线重新执行 `git apply --check` 通过；上游八个 Guard 路径零交集。最新 seed 的原回执重新验哈希，目标原 mock 退出 0，旧 mock 对照退出 1。保持单提交，合并由用户决定。

## Primary-path and fallback verdict

沿用原工具语义、已核验的数组收敛、唯一 Core 补丁载体及最新原 Gate。新增备用成功路径为零。

## Release verdict

**APPROVE**

批准精确 **PR #5 R14 方案**，SHA-256 `f5cbd6373815871f2c1ba25383abcdc2aa16f660f552723e32d6a9750377a023`。原样记录裁决后可实施；实际差分须独立审核，可合并质量由最终单提交的全部原门禁确认。

</details>

<details>
<summary>R13 独立方案审计阻断原文（B-09、B-10）</summary>

### B-09 当前发布基线有互相冲突的执行指令

- **Violated invariant:** REL。按最新真实目标分支和原样 Gate 形成、验证同一个单提交。
- **Evidence class:** contracted / observed。
- **Producer and execution path:** Canonical Plan → 实施工作树 → 提交范围与 Gate 比较基准。
- **Source evidence:** GitHub 对比确认 `dev1-smark` 与 `98a9f13f30372c8c80a68cf40fcaf371974bd2b3` 一致；送审仓库 HEAD 也为该提交。
- **Canonical-plan evidence:** §18:289–291 正确指定 `98a9f13`；§3:51 仍指示按 `0dfffcda` 重放，§4:68 将其写成当前 HEAD，§20:372 将其写成当前范围。§18:349 还要求实施时从 `0b5754df` 派生并用它运行正式尺寸检查。
- **Responsibility owner:** Canonical Plan 的发布基线与正式验收合同。
- **Concrete behavioral consequence:** 按这些旧指令执行，会在错误基线上形成或验收候选，无法证明最终单提交使用用户要求的最新 Gate。
- **Pre-R1 baseline behavior on the same path:** `0ab20fa8` 仍是固定需求基线；`0dfffcda` 和 `0b5754df` 仅用于各自的历史验证。
- **Round basis:** introduced by delta。
- **Minimal correction direction:** 所有现行实施、派生和验收指令统一绑定 `98a9f13`；旧命令和回执明确标为历史，保留原始结果。

### B-10 §1 缺少本轮用户明确要求的逐字内容

- **Violated invariant:** Canonical Plan 必须保留原始需求和本轮逐字更新。
- **Evidence class:** contracted。
- **Producer and execution path:** 用户逐字更新 → §1 → 方案批准、实施、实现审计。
- **Source evidence:** 本轮原文「你不能说只改写一个Plan，这是不允许的。所有的Plan都必须要完整按照Workflow进行审计以及实施以及审计请注意这点。」
- **Canonical-plan evidence:** §1:22–24 保留了完整审计的另一条原话，并概述各阶段；上引内容未逐字收入。
- **Responsibility owner:** Canonical Plan 的需求记录。
- **Concrete behavioral consequence:** 当前文档尚未完整保存要求继续完成实施和独立实现审计的本轮原始合同。
- **Pre-R1 baseline behavior on the same path:** 此要求是后续新增，应保留在现行方案中。
- **Round basis:** strict class。
- **Minimal correction direction:** 将该条原文补入 §1，保持 §18 与 §21 的三阶段执行合同。

</details>

R15 · Independent plan audit · 2026-11-21 · audited SHA-256 `a32a894615f0be9f9b263198d387bfb6c692d376c166ed590bc35e588a1acc4f`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的独立 `mapper` 回执确认为基线退出 1、候选退出 0，候选返回 `[3,5]`。相邻的旧组合探针两臂均退出 1，其中候选卡在合成后台目录断言。两套回执须分开引用；旧组合探针不能证明 V1/V2 的真实后台签名。

## Follow-up

最新 Core 基线仍在 stock preload 收尾留下 600,000 ms 计时器，原 HttpApi Auth 本地对照也未自然完成。保留这两条开放门禁。最终候选必须跑原 Gate、原 CI、类型检查、原生验收和恢复验证，再交独立实现审计。

## Rejected speculation

不因现有 Gate 阻断扩大 #5 的产品范围，不修改 Gate、计时器或原测试来换取通过，不把旧验收或局部通过记为可合并。

## Requirement and traceability coverage

R15 保持从原需求基线 `0ab20fa8` 到完整交付行为的映射，更新发布基线为 `27f5f62`。本轮核对了精确 HEAD、目标树、21 条产品及既有测试和补丁路径，以及 mapper 原始正反回执。最新选测将原 Core 补丁视为全局输入，25 个有测试的包进入全量范围。最终放行绑定同一单提交，并要求未修改的 Guard、规定平台和真实验收通过。

## Primary-path and fallback verdict

保留已审的工具输出、预算、可见签名和现有所有者路径。R15 只改发布基线及验收证据，不增加产品路径或备用成功分支。

## Release verdict

**APPROVE**。仅放行 **PR #5 R15 方案**，SHA-256 `a32a894615f0be9f9b263198d387bfb6c692d376c166ed590bc35e588a1acc4f`。当前裁决允许按方案实施，不是可合并裁决。
```

R16 · Independent plan audit · 2026-11-21 · audited SHA-256 `ae03d39c510e9ab92e0f4c978f80ecf8bfefa3d17056acc411b456293a82501e`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

最新基线的 Core 原场景通过 159 个业务断言后，仍因一个 600 秒计时器残留退出 1。实施后用当前基线和最终候选分别核验 Core 清理、原 Auth、正式 Gate、A/B 和实机；旧 R15 的实机回执保留为历史记录。

## Rejected speculation

Core Provider 延迟加载只证明初始化顺序改变，不能据此判定 Core 资源残留或 Auth 挂起已修复。

## Requirement and traceability coverage

复核了 R16 SHA-256 `ae03d39c510e9ab92e0f4c978f80ecf8bfefa3d17056acc411b456293a82501e`。原需求基线仍为 `0ab20fa8`，当前发布基线为 `8aead09f`。我用独立空索引重放了全部 21 个产品路径，`git diff --check` 通过，得到同一产品树 `8814dd23ac0787e542057e3f9c64c3ea06bc1a35`。核对了 Execute mapper 原红绿、viewport 两臂各 3 项与 43 断言，以及最新原静态选测的 24 包、807 文件。方案保留从原需求基线到完整交付的设计与测试映射。

## Primary-path and fallback verdict

R16 更新发布基线和验证入口，保留原有输出、配额、公开签名、Read/Shell 和渲染资源的责任归属。没有新增备用成功路径，不改 Gate。

## Release verdict

**APPROVE。** 仅批准上述精确 R16 方案进入实施。
```

### R17 独立方案审计原文

<details>
<summary>独立方案审计 R17</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

`5bc061bb` 的原 Core 场景通过 159 个业务断言后，仍因一个 600 秒计时器残留退出 1。基线官方 CI 的 Auth、Coverage、Effect 已通过；候选须分别复验 HttpApi 自然退出和 Core 原 preload 的清理结果，再跑正式 Gate、A/B、实机与恢复验证。

## Rejected speculation

OpenCode 新增的运行时释放流程不构成 Core 计时器已修复的证据。基线分支 push 的 Guard 通过记录也不覆盖候选的 PR 性能基准或 dispatch preflight。

## Requirement and traceability coverage

核对 R17 SHA-256 `f16509e898478cfbd8dbcf5671787d13efa68080bc0940b15dc2003b41c7a3f6`。原需求基线保持 `0ab20fa8`；发布基线更新为 `5bc061bb`。独立空索引重放全部 21 个产品路径，`git diff --check` 通过，得到同一产品树 `5666007b10724acdec0e66c67925932c700084ca`。核对了公共 Execute mapper 的原红绿、Core 原清理失败及原静态选测 24 包、807 文件。用户授权的临时验证限于 #5 分支；最终仍要求单提交，由用户决定是否合并。

## Primary-path and fallback verdict

R17 保留已审的输出、配额、Task 签名、Read/Shell 和渲染资源责任归属，继承基线的 OpenCode 清理流程，不扩大产品范围、不改 Gate。

## Release verdict

**APPROVE。** 仅批准上述精确 R17 方案进入实施。

</details>

### R19 独立方案裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§1 应补录用户关于更新性能基准、Rebase 后推送自动触发的两句原话，并把该节残留的发布基线 `5bc061b` 改为 `6dd9a5b`。§18 和 §20 已明确按 `6dd9a5b` 与最终候选运行原基准，执行范围不受影响。

## Follow-up

正式冻结安装、原 Gate 和性能基准、实机截图、恢复归档和独立实现审计仍是交付条件。

## Rejected speculation

现有证据只证明旧一次帧回调会抢领恢复后的新帧。没有把之前的 `compact.cpuMs` 波动归到渲染器，也不据此修改产品或基准。

## Requirement and traceability coverage

核对了当前 GitHub 基线及六条上游变更、十九条重放路径和两份证据清单。R19 保留原 Execute 行为、测试边界和单提交要求，继承上游已有的滚动与渲染清理。

## Primary-path and fallback verdict

一次帧身份留在原渲染器，由排队回调持有。原生对照证明基线旧回调抢领新帧、候选只让新回调领取。连续帧接替与原表格测试通过，未增加备用执行路径。

## Release verdict

**APPROVE**。仅批准 SHA-256 `582cffa1f5208009be0346e569ee139dab01ba4f541404f6acf1e182703c1e54` 对应的 R19 进入实施。

### R20 送审状态

本轮只更新 Plan，尚无批准。R19 的实现及审计回执以下原样留作历史：其中验证的「中性错误」是旧投影结果，R20 的验收要求以 §10、§15–18 为准。

### R20 独立方案审计（逐字）

## Blocking findings

No blocking findings.

## Non-blocking findings

将 §3 中的 `5bc061bb…` 和 §18 中仍称「当前线上」的 `86fc85c…` 标成历史记录。当前发布基线是 `6dd9a5b…`，线上 #5 是 `8f0a7c70…`。§18 的正式命令已绑定正确基线。

## Follow-up

实施后用真实 ReadTool 验证零交付页：成功返回、保持 `truncated`、省略机器 `next` 和 XML `offset`、不登记已读覆盖。复跑 V2 默认输出，确认逐字不变。CodeMode 用现有用例确认成员接收者和计算属性只求值一次，诊断原样保留，集合回调准入不变。

## Rejected speculation

无需增加行内游标、扩大读取预算、开放宿主 callable 或删除用户明确要求的两项执行上限。原生 Node 对照只说明 JavaScript 行为，不能替代 CodeMode 宿主验证。

## Requirement and traceability coverage

核对了用户原文、R19 和 R20 的差异，以及准确 6dd 和 `8f0a7c70` 的文件。线上候选已证实存在新增的 V1 Read 硬错误；R20 改回原成功结果合同，并移除会指回同一行的两处续读提示。共享 XML 文件具体负责后一个问题，V2 保持原默认。精确 parser 和 renderer 对照覆盖 9 组，原 V1/V2 宿主验收仍留到实施阶段。

源码也确认 `invokeCallable` 已在进入静态 `Array.from` helper 前处理 mapper，包括显式 `undefined`。删除 helper 中不可达的报错，及将直接调用收敛到现有分派器，都不扩大允许调用的范围。未发现本轮设计新增拒绝行为。

## Primary-path and fallback verdict

Read 继续使用同一 parser 及输出组装路径，零交付只改变现有截断页的元数据。CodeMode 继续使用同一受限调用分派，保留工具、Promise 和集合各自的准入。没有失败后重试或备用成功路径。

## Release verdict

**APPROVE**。批准精确 **R20 方案**，SHA-256 `bc511b6c2e51e7c96f2be2fd9a3e346c8c25c46a818f9cec4fd927aeb8eb1da2`。登记后可实施；实际差分另行独立审计。

### R22 修订记录与送审状态

相对获批 R21，R22 保留完全相同的规约修正；永久回归断言仅测原 R1 已有缺陷，撤回中间退化专用的测试追加行。该撤回源于最新逐字规则。R21 原标志、审批与红绿原回执照录，仓外实际验证继续执行。当前唯一 Canonical Plan 以原 R1 前 HEAD 记载全量目标；暂未按 R22 改动正式候选源码，R22 须全范围重审。

### R21 独立方案审计（逐字）

## Blocking findings

No blocking findings.

## Non-blocking findings

§3 仍把 `6dd9a5b` 写作 R20 的当前实施基线；R21 卷首与 §18 已明确使用同一个发布基线。登记裁决时可将 §3 标成历史记录。

## Follow-up

在准确实施树上复跑原双向归约入口、既有数组用例和两文件回归，再按 §18 执行正式 Gate、A/B、实机验收与空目录恢复。此前候选与基线共见的 Read 预载退出 1 按原回执保留。

## Rejected speculation

无需修改数组字面量、调度预算或宿主回调准入，也无需改写真正零长度的既有错误。测试保留原固定基线的能力断言，本轮双向 `null` 项用于锁定既有成功行为。

## Requirement and traceability coverage

复核了原始需求、后续不新增拒绝的原话、完整方案及 22 条发布差分路径。R20 的 B-01 已在方案层关闭：准确 `6dd9a5b` 的旧语法构造调用正反向归约均成功；封存 R20 同输入两条都失败；R21 私有投影两条均恢复成功。实际核对 R20 探针前像与封存树的 Git blob 一致。独立期望覆盖显式初值、方向顺序和真正空数组原错误；现有实例由红转绿，两文件 190 通过、738 条断言，退出 0。其余工具、权限、预算、Read、Shell 和 TUI 的范围及原验证要求保持。

## Primary-path and fallback verdict

原双向 reducer 保留真正零长度的拒绝。正长度数组沿同一循环跳过空槽，找不到实际元素时返回 `undefined`，由既有公共结果边界投影为 `null`。没有第二个归约器、异常后重试或备用成功路径。

## Release verdict

**APPROVE**。批准精确 **R21 方案**，SHA-256 `613bf98db99c968841d9514003655151d26baf3f6cea0cac12b79a1ff03e2b4c`。登记后可实施，完整实际差分另行独立审计。


### R22 独立方案审计（逐字）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的 `opencode-execute` 隔离回执实际运行了 `test/tool/code-mode.test.ts`，67 例通过、550 条断言、退出 0。登记时写明路径；`test/session/execute.test.ts` 是 OUT-0 的独立验证入口。

## Follow-up

在准确实施树核对 `test/codemode.test.ts` 与 R20 封存 blob `c56ba738dad7300393ea7e223fd449c8a345aac6` 一致，复跑双向归约、原 CodeMode 两文件及原 OpenCode 入口。正式 Gate、A/B、实机和空目录恢复仍按 §18 验收。

## Rejected speculation

无需为仅在中间版本出现的拒绝新增正式测试，也无需删除原有的数组能力、参数形状和结果序列化断言。

## Requirement and traceability coverage

核对了逐字需求、固定 pre-R1 基线、完整方案和 22 条发布差分路径。旧语法构造的正长度全空槽在原基线已经成功，R20 中间实现新增了拒绝。R22 撤回只针对这个中间退化的正式断言，保留仓外真实 `CodeMode.execute()` 对照。原 CodeMode 两文件用 R20 测试后像和修正后的解释器运行，190 例通过、738 条断言、退出 0。Read、Shell、权限、预算、TUI 与正式验收范围保持。

## Primary-path and fallback verdict

仍由原双向归约分支处理。真正空数组保留原错误；正长度全空槽跳过后返回 `undefined`，由现有公开结果边界投影为 `null`。未增加重试、备用路径或新拒绝。

## Release verdict

**APPROVE**。批准精确 **R22 方案**，SHA-256 `267c659482111f18c878271c34a7e6cfcb2d8c0b8f3305487568c3cbfba40c7f`。登记后可实施；完整实际差分须另经独立审计。


### R23 修订记录与送审状态

固定原 R1 前 HEAD 与全量发布目标不变，累计仍为 22 路径。本轮只撤回三个已证实非原基线红点的永久测试输入／断言组，并保留原测试与隔离观察；其他产品源后像继承已验证 R22 的功能修正。历史 R22 Plan/实现审查保留。获批后只实施既有 CodeMode 与 Promise 两个测试文件的最小收敛，并发送完整最终差分审查。

<details>
<summary>R23 独立方案审计原文</summary>

## Blocking findings

No blocking findings.

## Non-blocking findings

§16 的「保持 R20 后像」是 R22 的历史边界。登记时可标注为历史，当前测试范围以紧接的 R23 段落为准。

## Follow-up

在准确 R23 实施树核对两个测试文件的实际差分，重跑原 CodeMode 两文件和 Session Execute 原入口，再按 §18 完成正式验收。

## Rejected speculation

无需调整产品代码、宿主数组投影、归约或权限。`Math.abs` 已支持，旧拒绝断言应撤回；无需用原基线同样拒绝的 `JSON.stringify` 填补。

## Requirement and traceability coverage

复核了逐字需求、固定 pre-R1 基线、完整方案及 22 条累计路径。R22 的 B-01 在方案层关闭：撤回三条仅防中间密化的宿主形状断言和专用夹具。已经双绿的排序快照转为仓外观察。公开稀疏结果的 `null`／JSON 往返、Array 构造、动态 mapper 和受限回调仍能检出原基线缺陷。Promise 原正例和三条不透明性断言保留。私有 CodeMode 两文件 190 通过、734 条断言、退出 0；封存 R22 的 Session Execute 全文件 80 通过、776 条断言，162.72 秒自然退出。

## Primary-path and fallback verdict

R23 只收敛正式测试。归约保留旧空数组错误与正长度全空槽的成功结果；宿主默认投影和公开 JSON 投影仍由各自现有路径处理。未增加模型拒绝、重试或备用成功路径。

## Release verdict

**APPROVE**。批准精确 **R23 方案**，SHA-256 `385d10ee59134e87f9806325c844adc5df7d72ad6462fb8cf12258319daa8563`。登记后可实施，完整实际差分另经独立审计。

</details>

### R24 修订记录

纳入 §1 最新四条原话；保留原始 GOAL 基线、当前发布基线与完整已确认目标，将 Read 的重复防御作为删除候选，并建立 Code Mode 全工具等价覆盖与整体行数收敛合同。R24 后经独立全范围方案审计 BLOCK，需修订后再送；未实施。以下实施、审计记录均为历史，不会放行 R25。

R24 独立方案审计原文保存在 R24-independent-plan-verdict.md，SHA-256 a64afa31239ea97834c7cd922da996d6bf205de750d19bf41b3e454acceef586。审计对象 SHA-256 911219259d47be2c1faef4a61d4fc4248d6bca799e68eec761dec2dcbd92c3f6。判词原样：**BLOCK。** 修订上述 3 项，记录 R24 判词及修订差分，保持实施禁用，再按完整范围复审。

### R25 修订记录

B-01：真实磁盘插件普通成功返回 Order 34，R24 Execute 对普通领域类实例额外拒绝。原 copyIn 仍拒绝对象进入；对普通业务类这一已复现表示差异，工具校验完成后只交原普通文本。声明失败、数据键检查及其它错误不泛化捕获；MCP 只在深度分支生成完整 JSON。试验 3 例 99 条会话断言，CodeMode 372/1,356。隔离树 c337521023b71c1fb964f4ed1871dbc919df9f2b，16 生产路径 +376/−161（此时未加 B-02），回执 mcp-json-text/production-representation.patch。B-02：从 Code Mode 自有签名如实表达文本，不变更 wire schema 或原 SDK validator；验证基于真实目录与脚本消费、同一候选的精确行数，见 §20。B-03：已修正当前版本放行、固定预算和全工具覆盖矩阵，并补真实 Plugin.Service.list 红绿。R25 独立复审 BLOCK，B-01 正文与验证范围冲突，B-02 和 B-03 关闭；未实施。

R25 独立方案复审原文 R25-independent-plan-verdict.md，SHA-256 96c477eeacfcadc3c2e82c286c983cf61b26c545a68c928ac520d5114e39203d，审计对象 3c1de6fbbaa8bfb13710ac864110b3d06d29a8cd78d94c2510a5dc9c519f9761。判词原样：**BLOCK。** B-01 的代码方向已有实测支持，但同一份方案不能同时要求和排除它。同步正式合同后复审，保持实施禁用。

### R26 修订记录

把 §7、§10、§15、§16 已验证的普通领域类形状分支统一为强制要求；与 §13、§20 同一真实 Order 阳性、普通记录及真错误回执一致。MCP 只有深度分支给完整 JSON，域实例仅用所属工具普通文本；真实输出校验和原数据边界保留。§11 区分同一次成功结果的既有展示投影与未经许可的另一次执行。正式放行固定 R26。方案文书修正，未改变隔离产品/测试树 659688c75b1b7f21880781357b72257ff12a3672 或差分 SHA-256 f181a11001cbc419d913b9a3cdc898ace4b2e5d39f51499ca6671a26f70e77f6，现有 109 条真实对照继续适用；新的精确方案仍须独立全范围批准。

R26 独立复审原文（SHA-256 ce94c5b1a54396879d5f0b018875ecc4760c8ec8c2824098c87fcd5cbdff8f23）：

<details>
<summary>R26 独立方案审计原文</summary>

# R26 独立方案复审：APPROVE

审计对象 SHA-256：`4dcadccdd0c0c7ac6f586ff8e7952470c37df9b9833f124b5934a2b8b335b144`。

## Findings

**No blocking findings.** B-01 已关闭。§7、§10、§15、§16 均将已实测的领域类形状分支写入实施和验收合同：原工具和原声明成功后，Code Mode 交付同一次调用已有的普通展示文本与附件，类实例不进入脚本。可信 MCP 结构仅在旧深度限制触发时交付完整 JSON 文本，原协议校验、权限和真实错误照旧。§11 已区分结果投影与替代执行。

B-02、B-03 保持关闭。脚本签名如实标明文本分支，原协议 schema 与根引用保持；全工具覆盖、24 路径上限及最终单提交放行绑定当前 R26。

## Evidence and scope

核对了隔离树 `659688c75b1b7f21880781357b72257ff12a3672` 和生产及测试差分 SHA-256 `f181a11001cbc419d913b9a3cdc898ace4b2e5d39f51499ca6671a26f70e77f6`，与 R26 记载一致。归档记录为真实会话 3 项、109 条断言通过，CodeMode 372 项、1,356 条断言通过。本轮核验回执与冻结差分，未独立重跑这些测试。

## Release verdict

**APPROVE，仅限上述精确 R26 方案。** 这项判词允许登记方案批准；实际实施仍须按 R26 完成最终验证和独立实现审计。

</details>

### R27 正式实施发现

R26 精确批准并在固定 6dd 干净树应用；同一原 Session Execute 全文件在 1397 行失败。旧用例要求未声明 schema 的磁盘工具显示 Promise<string>；新工具值仍返回原文本，但由于该类工具也能返回原先被错误拒绝的合法对象，目录已实证须显示 Promise<unknown>。这不是并发超时，正式修订需改回归实例的既有签名断言并保留其文本、原 Zod 和纯结构控制。原 24 个路径已占满，评估把真实长 rg 记录的现行新增断言移到同一 Session 的既有 Grep 真实用例，保持 Core 自有旧用例原样。没有更改批准源或正式测试；必须用同固定基线实际红、整文件绿和不超预算证明再送独审。

R27 精确阶段 1 差分（不含本方案）树 46198086ae0272d2a54adcbde7bdb2f739d1ae6c，文件 r26-implementation-run/r27-full-production-and-tests.patch，SHA-256 1ed77a201ab823deaf20c1a9396ffe5835ce00f64fe546e29a030e931353df04。R26 所有 16 生产后像与该树逐字相同，+386/−162；7 测试 +165/−22，含计划共 24。原 Core 原样恢复，Session 仅改变两个原有实例（改无声明签名并验证原文本；真实 Grep 追踪 70KiB 合法记录、Unicode 预览与按顺序三匹配）。固定原 0ab20fa8 的新 Grep 代表真实失败为 Ripgrep JSON record exceeded 65536 bytes；候选两例 19 条通过。完整 Session 的首个疑似长例是原带真实 shell 子进程的 timeout cleanup；详名相同原配置已通过该例（5.147 秒）；仍以原命令、原计时、全文件实际终态为准。

同 Bun 1.4.4、同本地 checked-in models 快照以及原 packages/opencode build --single --skip-install，干净 6dd 与 R26 完整嵌入构建均 exit 1，第一条同为 [commonjs--resolver] Missing "./promise" specifier in "@opencode-ai/client" package；相关 WebUI import 和 client exports 三 blob 与基线相同，原基线运行前后 clean。回执 r26-implementation-run/native-baseline-AB.txt。本次产品不改 WebUI 依赖。仍记录原完整构建的线上/基线结果，不把它写成通过；已另通过用于实际 TUI 范围的原 native 构建，真实 Xfce serve+attach 启动、3 Read/1 Execute/1 Shell 和退出捕获。直接启动曾 60 秒超时；开启背景模式尚需验证。发布验收见 §18，不为无关基线改 Gate、锁或未授权 WebUI。

R27 独立复审原文 R27-independent-plan-verdict.md，SHA-256 cf14ac8eb2f74459c4016dbf0ccf90b8600182b9781d178936020c99aa77eea4，审计对象 3f037bc19e08acb175657d67a96f39c955f5199261b7d8459ad8633d1df51dbf。B-04 判词原样：**BLOCK，保持实施禁用。**

### R28 修订记录

B-04 的原整文件已实测自然退出 0。复用精确 r27-full-production-and-tests.patch（SHA-256 1ed77a201ab823deaf20c1a9396ffe5835ce00f64fe546e29a030e931353df04），从固定 6dd9a5b1 分别重放到物理工作树和独立空 index；两次同树 ed145d11394a8fc97a6b68e13224183443af961d，按实际 Git diff 的 23 个非计划文件前后像为准（原 R27 小索引转述树 46198086… 不作为正式验收哈希），24 路径上限及固定原始红不变。运行目录 packages/opencode，Bun 1.4.4，命令 OPENCODE_DISABLE_MODELS_FETCH=1 bun test --preload ../../script/guard/leak-preload.ts test/session/execute.test.ts。使用仓库已有离线开关防外发模型目录，原固定 preload 的本地模型夹具、原 80 测试、原用例时间未改，不滤选、无外层 timeout。最后 80 pass、0 fail、777 断言，163.61s，含真实 121.167s 长用例，独立 exit 文件 0。完整命令、日志与退出在 r26-implementation-run/r27-root-session.{command,log,exit}。当前仍需 R28 精确独立批准、正式实现审计和发布验收，没有修改测试或产品差分来处理 B-04。

R28 独立复审原文（SHA-256 c526882d64b62ca3fe4a862a838ae24d38db61994ee2537f704986e4d485319e）：

<details>
<summary>R28 独立方案审计原文</summary>

# R28 独立方案复审：APPROVE

审计对象 SHA-256：`a6cfd0fcc4a67c11f682b7c6e2b8be271513f51330708b1c092c39dbcd928021`。

**No blocking findings.** B-04 已关闭。冻结候选树 `ed145d11394a8fc97a6b68e13224183443af961d` 的原 Session 测试整文件运行了 80 项，全部通过，777 条断言，163.61 秒自然退出，退出码 0。命令保留原 Guard 预载，不筛选测试、不设外层超时；只使用仓库已有的离线模型开关。已核对命令、终态日志和退出文件，未将已有回执计作独立重跑。

工作区暂存差分与已审补丁 SHA-256 `1ed77a201ab823deaf20c1a9396ffe5835ce00f64fe546e29a030e931353df04` 一致。23 个非计划路径，加唯一方案共 24 个；暂存差分通过 `git diff --cached --check`。本轮未改变已审产品及测试差分，B-01 至 B-03 保持关闭。

**APPROVE，仅限上述精确 R28 方案。** 最终发布仍须完成独立实现审计及 R28 原发布门禁。

</details>

### R30 修订入口（完整范围待独立审计）

| 修订 | 更新 | 范围 | 放行 |
| --- | --- | --- | --- |
| R30 | §1、§10、§18、§22 | 完整目标仍基于原需求 HEAD；V1 Read 删除重复派生返回形状，双向归约恢复原成功值与回调；目录只保留可达的外部 JSON 文本备选，保留原 RG/Shell 修复 | audit-required；Approved revision: none；Implementation allowed: no |

本行记录 Read、双向规约、V1 目录及应保留的 RG/Shell 修复。实验只建立阶段 1 的可行性，后续审计覆盖原需求完整范围。

### R31 修订入口（完整范围待独立审计）

| 修订 | 来源 | 任务 | 放行 |
| --- | --- | --- | --- |
| R31 | R30 精确全范围审计 B-01；冻结原案 `b6cfa19b…` | 恢复原公开数组消费、排序的全部已证可达回归，保持单一原 owner 和现有构造能力；五臂 25+4 同输入，按固定原始和发布基线重审 | audit-required；Approved revision: none；Implementation allowed: no |

### R32 修订入口（完整范围待独立审计）

| 修订 | 更新 | 范围 | 放行 |
| --- | --- | --- | --- |
| R32 | §5、§17–19、§22 | 修正将 PR #1 专属注释比例归入 #5 的错误，保留 R31 计量、实际全部后像、逐 hunk 必要性和仓库注释要求；原基线、行为、接口、责任、测试、构建、CI 与 Gate 条件均不变 | audit-required；Approved revision: none；Implementation allowed: no |

- 2026-11-07 13:35 UTC，用户在 `用户续用原 PR 分支说明` 要求把 Promise.race 相关修改追加到现有 PR 的原分支。13:41 的 `用户对原 PR 的注释要求` 原话：「你的修改的每一处 hunk 都要有中文注释。然后同时整体的这个中文注释的，就是你修改的所有的 hunk 的 diff 的中文注释量，按理来说应该大于 15%。也就是说你整个 PR 都要满足这一点。」14:09 同一轮的 `用户指定原分支与 PR #1` 亲自指定 `SMARK2022/opencode:execute-async-flow`、[草稿 PR #1](https://github.com/SMARK2022/opencode/pull/1)。11 月 8 日 `用户关于 PR #1 注释凑数的原话` 继续讨论 `docs/plans/execute-async-flow.md` 的凑数；相邻用户消息 `用户明示 PR #1 的相邻消息` 用「当前 PR #1」点名。用户 `用户对 PR #1 提示词计量的说明` 对同一任务补充：「这个 code mode.txt本身不参与这个注释的一个增加和计算，和它的那个底数的一个计算。」
- GitHub 元数据：#1 11 月 7 日 12:40 UTC 创建、11 月 11 日 10:47 UTC 已合并，head `execute-async-flow`。[PR #5](https://github.com/SMARK2022/opencode/pull/5) 同日 19:12 UTC 另建，head `execute-result-recovery`，标题 `fix(execute): support builtin callbacks and bound execution work`。#5 用户原文 `11 月 12 日内建回调、Array.from 与工具结果原话`、`11 月 12 日支持语法及减少错误、测试的原话`、`11 月 23 日用户原话，收敛新增行数`、`11 月 23 日用户原话，不新增基线外错误`、`11 月 24 日 #5 最小必要改动与 Read 验收` 对应回调、实际工具结果、收缩新增、基线等价与最小必要改动。11 月 10 日以来的用户注释记录有许可证署名、其他 PR 及 Plan 栏目对话；#5 上述验收历史未扩入 #1 的百分比。

R31 完整独立批准仍按原文留档，仅对应审计入参 `c89789cbb9053a0d726d7e9510f53fc37876ff7ddd419a48b1604a86b24392e3`。R32 变更放行标准，需独立全范围方案审计。相对已批准 R31 唯一改动为本 canonical Plan；其余 23 个发布路径字节逐一相同，候选正常回归证据可按同一源身份重用，正式发布仍须本版批准、实践证据、独立实现审计和原完整门禁。

### R30 独立方案审计裁决（原文）

审计原文 SHA256 `7f9f751c5afa984d77614765ae778d35e66d7e15f7b694391434207f3b89db70`。

## Blocking findings

### B-01 稀疏数组的旧调用仍丢失回调和值

- Violated invariant: `JS` / `REL`。新增回调支持与 `Array.from` 不应改写已支持脚本的成功值、回调次数或可枚举索引。
- Evidence class: observed。
- Producer and execution path: 已有的数组字面量、索引赋值和 `pop()` 形成真实空槽，经公开 `CodeMode.execute` 进入同一个解释器数组方法。探针不使用本 PR 新增语法或工具。
- Source evidence: 固定基线 `packages/codemode/src/interpreter/runtime.ts:2772–2814、2873–2879`；R30 精确候选同文件 `:2834–2886、2935–2942`。GitHub 原需求提交与发布基线的解释器 blob 均为 `7ce693b5d3df3157121c421308a4aad0f103f7b3`；候选为 `2477095b878b4b4f99ad4f64dbcf3f0b7ba3545b`。
- Canonical-plan evidence: §7 `JS`；§10 把跳过空槽写成原行为并保留 `map/filter` 等消费改动；§18 R30 仅修复了双向归约的兼容性。
- Responsibility owner: `Interpreter.invokeArrayCallbackMethod` 的数组消费，以及 `sortArray` 原排序结果。
- Concrete behavioral consequence: 独立运行显示，`map` 的 `[回调次数, 结果]` 从 `[2,[42,42]]` 变为 `[0,[null,null]]`；`forEach` 回调次数从 `2` 变为 `0`；`flatMap/filter/some/every` 从 `[[42,42],[null,null],true,false]` 变为 `[[],[],false,true]`。一个稠密源的 `flatMap` 回调返回已有稀疏数组时，结果也从 `[null,null]` 变为 `[]`。已有调用 `Object.keys(a.sort())` 从 `["0","1"]` 变为 `["0"]`。所有对照都成功退出，因此只检查拒绝或成功状态看不出回归。
- Pre-R1 baseline behavior on the same path: 已有遍历按索引读取空槽，旧 `flatMap` 展开时也读取回调数组的空槽；旧默认排序结果把空槽物化为可枚举的 `undefined`。独立原始回执为 `probe.log`（SHA256 `d020792e9734d955c44716cdac754ffa8f9329cbd76c18de8b2c199d7a878e56`）和 `sort.log`（SHA256 `593c36c41528aaf5bbebf2141274c980bc1752fcd5c7cbc79ba76a79b3769671`）；私存完整裁决保留原始字节、SHA256 `7f9f751c5afa984d77614765ae778d35e66d7e15f7b694391434207f3b89db70`，公开记录仅改写回执路径。
- Round basis: strict class，已有可执行路径相对固定基线回归。
- Minimal correction direction: 在原数组消费与排序实现中保留上述旧遍历及结果语义，继续复用新增回调入口和 `Array.from`；不用数组来源标记或备用路径，旧行为探针留作隔离 A/B。

## Non-blocking findings

§4 将送审工作树的 `HEAD` 写为 `6dd9a5b1`；实际 `HEAD` 为 `9eff6586`，`6dd9a5b1` 是明确固定的发布父。§18 及精确对象对应正确，改证据表措辞即可。

## Follow-up

无新增项。

## Rejected speculation

不要求在 Read 再加偏移保护或续页状态。现有输入归一、正偏移及固定边界回执已覆盖此处；没有可达的新错误路径。未发现固定 V1 内置输出要求再追加文本签名的现有生产者。

## Requirement and traceability coverage

重新核对固定基线到候选的 24 条路径、R30 三处生产后像及其行为边界。Read、原生与 MCP 目录、RG/Shell、执行预算、Task 广告和 TUI 资源生命周期均保留对应 owner 与验收入口。原 Gate、同提交正式测试、实机和空目录重放仍是最终发布条件。B-01 需要把兼容性映射扩大到上述已有数组消费者，不能只证明 `reduce/reduceRight`。

## Primary-path and fallback verdict

Read 的单一 `next` 决定与目录表示收敛仍沿现有 owner。观察到的数组回归发生在原主路径本身，应直接恢复原行为，无需另建路径。

## Release verdict

**BLOCK**。完整范围审计适用于精确 R30 方案 `b6cfa19b2d341ecbb3215599c150a6e887f109b395e81cfabf4ced33d4452ff6`。保留 `Implementation allowed: no`，修订 B-01 后重审。

### R29 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

计划开头将 `62344f77` 称为“现有线上对照”，建议改为“R23 历史对照”。§18 已正确绑定当前候选 `32ee52be`，这处措辞不影响审计或实施范围。

## Follow-up

在实现阶段重跑完整 MCP、Session Execute、Shell 测试，并以同一最终提交完成正式 Typecheck、Test、Guard 和发布验收。Linux 隔离实验不能代替正式 Windows 验证。

## Rejected speculation

无需为了旧目录断言恢复仅对象的签名，也无需新增 Shell 测试实例或更改 Shell 实现。

## Requirement and traceability coverage

核对了原始要求、固定 R1 基线、R28 发布计划和完整 R29 变更。真实 MCP 夹具只更新一条完整签名断言；保留原结构化返回、工具元数据、错误和附件验证。`toolTree` 与 `describeDefinition` 产生的类型与已批准的 PARITY-3 一致。修改后的同一个断言在原始和发布基线失败，在冻结候选上 16 项通过、74 条断言。

Shell 两条机器正文断言移至既有 Session Execute 实例，复用原有的两个真实子进程；空成功和退出码 7 的路径都能单独检出基线通知污染。独立 Shell 测试恢复发布基线，保留展示和状态覆盖。最终范围仍为 16 个生产路径、7 个既有测试路径及 1 个 Plan，零新增测试实例。

## Primary-path and fallback verdict

R29 没有新增生产路径、成功路径、重试或错误转换；保留现有工具执行、校验和权限边界，只使测试直接观察已批准的脚本结果合同。

## Release verdict

**APPROVE**。本裁决仅批准 SHA-256 `541d820452dffc65d27399b624a2b95bdef4bf325771ba134ad0f7651dfa7dc7` 的 R29 计划。实施和发布验收仍须按计划完成。

## 23. Implementation Evidence

### R32 第一轮实现审计返工

审计 B-01 的静态误述只存在于 V1 Read 调用共享 parser 的一行注释。删除该行；首个完整行超软窗口时仍用原估算与上限，普通分页仍按原字节窗，无新增执行分支。前后 `read.ts` Git blob `34bd7d99984271b2d8b0db075f64ed1b706c2509` → `6c780989efee9dbe6e9614bae4317c3da8f2ddbd`。前后逐字节差为删除这条注释；TypeScript 上下文解析的 4,413 个叶标记和去注释的 23,176 字节 JS 均相等。其他 22 非 Plan 后像保持。固定父完整产品补丁 SHA256 `5271638d4dedeac8048444ad1489e2e3d64a5e927deaa880374dcc9ce2ef3f89`，从固定父空索引验证得到产品树 `d20124a92515698f44f5069ed77405f5763b38ba`。生产新增减少一注释行；24 路径、原测试数不变。

同一后像在 packages/opencode 用 Bun 1.4.4、空继承环境和只开 lo 的网络命名空间跑原 `bun test test/tool/read.test.ts`：84 通过、395 断言、退出 0，14.83 秒。第一轮 B-02 的 OpenCode 单包和完整检查 SIGKILL 回执留存，不作为通过；在匹配新后像的冻结安装上重跑。第一轮原裁决同本节后的原文，保留两个原阻断以便独立复审；两臂同失败的 Read 严格 preload 与 Shell 附加观察保持原分类。

独立重放同样得产品树 `d20124a92515698f44f5069ed77405f5763b38ba`，返工产品差分只减 1 条注释（`read.ts +0/−1`）。七个改动测试文件共 439 个可静态识别的测试声明，名字逐一一致；独立复核回执 `pr5-r32-independent-replay.rIParz/test-instances.log`，SHA256 `9d81f2b16d8aac32e52d4d31e4c08c2358d6942991a5ffd1806eb2863e8ddcb3`。实际累计 16 生产路径 +330/−139、七个已有测试路径 +161/−27、唯一 Plan，合计 24。

B-02 返工重验以同一冻结依赖安装和最新 comment-only 后像为输入，验前验后核对树及清单 `1060ed02954484761ca35cd84f9bbaea8301833c`，23 个发布非 Plan 后像逐字相等。OpenCode 在 packages/opencode 运行原 `bun run typecheck`，exit 0、145.253 秒。整仓在仓库根运行 `bun typecheck --log-order=stream --concurrency=1`，30 个实际任务完成、0 个缓存命中，exit 0、586.863 秒。只通过外层串行和 Go 运行时内存参数 `GOMAXPROCS=2`、`GOMEMLIMIT=1000MiB`、`GOGC=20` 保持本机峰值；Turbo 本次使用 loose 环境模式让参数传入实际编译子进程。保持原 36 包范围、原 workspace 图、各包 typecheck/tsgo 参数和所有输入，不改仓库脚本、Gate、CI 或依赖。回执整仓原终端日志 SHA256 `15acce794ed2c2283d33b6335d57539965c4ddfe6583069403eb560d1cbad4c2`，OpenCode 原日志 SHA256 `ae47736bb2a9401aa9743893f2f64b9a605e65a99d78cd991a8021e0f7722d87`；历史资源终止照录。本次为本机完整类型验收；最终同提交远端原 Typecheck 和发布 Gate 仍执行原命令、原标准。

### R32 实际实施与验证

- 当前工作区 HEAD 为 `9eff6586b0c2232f88d41c3c834179ae555171d8`；正式父为 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，原需求基线为 `0ab20fa87080bd4fafd79d39b97fb082c4af8d62`。R31 在原独立批准入档后重放四个后像；R32 精确方案批准后逐个比对，复用同一源码和测试字节。改动相对前线上 9eff：解释器 `11fac7780f7ca2519e8f16e7b99fe549f4b00f53`（保真数组消费、排序/归约）；V1 Read `34bd7d99984271b2d8b0db075f64ed1b706c2509`（单续页决定）；V1 目录 `aa6145bded1ce9dcb98a478ae141ac7e8dfd833d`（只对有据可达的外部文本投影描述合同）；同一个已有构造测试 `6d1a376f47c553c8f8c528e2ba3ef24bd5ea1c4e`。四路径补丁 SHA256 `a3958cb64026c44dc9c8e59d25ba1b6ba0c5c47c2790e64eafb3a8602dfaefe4`。固定父累积 16 生产路径 +331/−139、7 既有测试路径 +161/−27，Plan 一份，共 24；测试实例净增零。git diff --check 通过。原 staged checker 保持两个基线及既有消息，扫描有效 22 路径、零错零提示；不把该回执当最终 Push Gate。
- 原红绿：固定两原始版本均拒绝新 Array 构造和 Array.from mapper；原真实 RG/Shell fixture 在 6dd 两例失败。实施再跑五臂公开 CodeMode 入口：25 原稀疏、排序、回调/短路、错误/空值行为等于两份固定基线，保留 4 新能力，真实构造来源键 1/3、映射结果键 0/1/2/3。旧兼容性数据未进入正式测试。从 packages/codemode 用 Bun 1.4.4 跑 `bun test --preload ../../script/guard/leak-preload.ts test/codemode.test.ts test/promise.test.ts test/signature.test.ts`，211 通过 929 断言，exit 0。
- 通过真实 V1、Session、插件与 MCP 原入口验证已批准的行为。从 packages/opencode 按原包 preload、Bun 1.4.4，独立的网络命名空间只开 lo 并证明没有外网路由。组件结果：`bun test test/tool/read.test.ts` 84/395、`bun test --preload ../../script/guard/leak-preload.ts test/tool/task.test.ts` 38/150、原 Session Execute 80/779、原 MCP host+wire 83/627，均 exit 0。Session 和 MCP 命令使用 `bun test --timeout 30000 --preload ../../script/guard/leak-preload.ts` 加原两个入口（`test/session/execute.test.ts`；`test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts`）。Host 实际覆盖工具权限、真 rg 长记录、Bash 退出收据、带图附件和深 MCP 输出。
- 在同 namespace 额外对 V1 Read 加原 Guard preload 的严格运行：自身 84 行为全过，固定父也为 84 行为全过；两边各报相同 afterAll 20 秒、10 秒引用，未当作绿。Read+host 合并，R31 两份独立投影各 151 行为全过、949 断言，同一 afterAll 20 秒和 60 秒引用。原 Shell coalescing 在无外网 launcher 的 6dd 与候选均耗尽原 60 秒；通用 Shell 附加运行另记回执，未改普通 Shell 合同、断言或 Gate。
- 实际路径沿 §11–12：数组消费者沿原单一分派，Read 与目录沿原各自所有者。Read 首行未交付真实截断和外部已校验 JSON 可交付表示用原契约分支，不隐藏工具、权限或数据错误。已删除数组跳洞/提前归约、Read 重复派生和原零进度拒绝、固定工具多余签名后缀。新增备用成功路径为零；保留原已审批的普通展示或可信 MCP 深 JSON 交付表示。正式源码没有加跟踪、夹具或调试工具；不把私有隔离实验纳入产品差分。
- 全部 23 个非 Plan 路径以固定父 `6dd9a5b1` 写入独立空索引，`git apply --cached --check`、实际 apply、`git diff --cached --check` 均通过；后像树 `629d300fa272682e3ead02e57268425f1b00d267` 与实际产品工作区逐字一致，固定父全部生产与已有测试的 full-index 补丁 SHA256 `3893f0d15880ef7e33b72eb8711c9dfd178ac6c271215eab7cec913f431b41ec`。完整 Shell 补充运行 210 秒外限 exit 124，原共同超时未被抹去；完全冻结依赖的候选单例亦到 60 秒，固定父同样。真实 Bash 状态与结果已由 Session 和下面实屏两处验证。
- 独立现实运行：精确同源冻结安装 2386 个包；Linux 从 packages/opencode 跑原 `bun run build --single --skip-install`，完整构建及嵌入 Web UI 成功，CLI 版本/Voice worker smoke 通过。二进制 236,566,704 B，SHA256 `84b0bad16cb41b7f490280699ba2bcf134e524adc625856eef0fa25446c9b2f2`。真实 Xfce 终端七张原始画面，同一会话 5 组验收：继承行为、Read/Shell、数组、目录/MCP、预算。真实 Bash 退出 7；rg 三条及 71,687 B 中间行；旧数组和新 mapper；V1 Read/目录、MCP 33 层及真实 2 附件；第 100,001 次循环轨迹。应用与 daemon 退出 0，无残留 lock。验收回执 manifest SHA256 `fe019254c905fd7a9dca9927256b4bbc58b4613c724106e42014507bd0966726`；独立空目录回放归档 25/25。文件在私有验收包 `pr5-r31-acceptance.12EEOd`；同源唯 Plan 文本后来升级至 R32。
- 包级类型按各包目录跑原 `bun run typecheck`：CodeMode exit 0（2.55 秒），SDK-next exit 0（65.74 秒）；OpenCode 同一冻结安装的单包控制在运行。完整仓库 stock 并发曾三次分别在 CLI、Core、SDK-next 的编译子进程收到 SIGKILL，三次均 exit 1，没有对应 TypeScript 诊断；原检查图降并发的完整重验另计，本轮冻结时尚无全绿回执。包级/完整检查仍为发布条件，保留所有原失败记录。正式发布实际单提交仍须原 Push Gate，以及原选择器要求的 Linux / macOS、敏感 benchmark 和 schema/protocol，遵循 §18 的原平台、CI、持久交付约定。
- 当前只冻结实现审计资料；无新 commit、无远端写入、无合并。独立实现审计必须核对完整 24 路径和实际差分。局部本机通过、终端实测和 stock staged shape 不能替代最终发布门禁。

### R29 当前实施与验证

- 固定父 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`，精确 R29 审计输入 SHA-256 `541d820452dffc65d27399b624a2b95bdef4bf325771ba134ad0f7651dfa7dc7`；登记原全范围批准后 Plan SHA-256 `114f148715c059296046f6fcabf2624024546b22da997a1cdc422869a2213a55`。已实施仅两个既有测试后像，恢复 `shell.test.ts` 至原 Git blob `e83b41f06534543a1405ea0ff1c752252b06e23b`。全部 16 源/补丁文件相对 R28 后像完全不变，完整生产 patch SHA-256 `07dd659dc4b758cdcb23979ee0c0e13972b1a8cb68782554eabe9d1a283b333c`。固定父至 R29，生产 16 文件 +386/−162，既有测试 7 文件 +161/−27，Plan 一文件，合计 24、零新增用例。
- 完整源与测试 full-index 差分 SHA-256 `537e9ef31a1925fe78b55ccb547e6535e4b460916241aef9043e0b3ae99cce4a`，从空索引载入固定父独立重放得 `e1541e922094f0f9ed943e5e64afc7d2cb878fc6`，不含 Plan。完整路径、差分、日志、SHA-256 清单在 `pr5-r29-plan-builder/r29-implementation/`。实际产品与 R28 的真实 MCP/Session/工具/渲染器路径一致；不改 Gate、CI、协议、锁、生产文件、既有应用行为，不加兜底路径。
- 原红回路见 §18：两个固定基线在新的完整 MCP 签名断言和原 Shell 机器正文断言确红；原始 MCP 测试在两旧基线 16/74 全绿，但在已发布 `32ee52b` 的本地对照以及官方 Linux/macOS Test、Linux Guard 都失败于同一旧签名。仓外交换断言顺序确认空成功和非空退出 7 可各自检出基线显示污染。
- 在实际实施目录 `packages/opencode` 使用冻结 Bun 1.4.4 和各包原 preload 跑完整三文件：MCP 集成 16 项、74 条断言；Session Execute 80 项、779 条断言；Shell 75 项、278 条断言，全部自然退出 0。MCP 用原 `bun test test/tool/code-mode-integration.test.ts`；Session 用已验证原 Gate 入口 `OPENCODE_DISABLE_MODELS_FETCH=1 bun test --preload ../../script/guard/leak-preload.ts test/session/execute.test.ts`；Shell 显式将同一固定 Bun 加入子进程 PATH，原 `bun test --timeout 30000 test/tool/shell.test.ts`。原待审区规则与 `git diff --cached --check` 均通过。首轮未向子进程提供 Bun 的旧日志保留，未改测试或放宽规则。
- 下一验收：独立实现审计、同一最终单提交的官方 Typecheck/Test/Guard（含 Windows 和真实发布回执），并按 §18 核对实机和持久化证据。R28 的原线上类型绿灯、测试失败和已有临时运行不充当本版本正式证据。当前未提交、未推送、未合并。

### R28 当前实施与验证

实际精确父为 6dd9a5b1f3a0110e9d1c8142e2230724f6906f42。在分离的干净工作树复放已批准的后像，排除唯一计划后，经独立 index 验证实际源和测试树 ed145d11394a8fc97a6b68e13224183443af961d（同 R28 审计），实际 full-index diff SHA-256 2144fe9fc15901568cea34eefdafecd453a59e6ec515a3269690e43e92f5f702。前一份缩写索引封存补丁 SHA-256 1ed77a201ab823deaf20c1a9396ffe5835ce00f64fe546e29a030e931353df04，内容相同。生产 16 路径 +386/−162（相对 R23 少新增 4、少净增 24）；既有测试 7 路径 +165/−22，计划 1，共 24。Git diff --check 通过；锁、workflow、Gate、包清单和工作区别处原样，未提交。完整路径和 numstat 在 r26-implementation-run/r28-changed-paths.txt 和 r28-numstat.txt。

- 原 fixed 0ab20fa8 的 Session Grep 真实红；同合法 70KiB 行在候选依次返回三条并保留 Unicode 预览。已执行 2 例 19 条窄对照；最终精确重放树原 Session 文件 80/0、777 条断言、163.61 秒自然退出 0（唯一原离线目录开关和原 leak preload，未改原测试时间）。保留已声明插件 Zod 校验、真实错误、权限、附件；域实例是同一调用原展示文本，可信 MCP 只在深度分支保持全 JSON；无重试、第二源或替代执行。原输出路径和 Script 签名、MCP 协议与根引用已按 §18/20 验证。
- 实施树原 CodeMode 测试 372/1,356、tool/code-mode.test.ts 67/553、Read/Shell 159/675、原 Core Runner 105/1,186 通过；修改前后原短 ripgrep 夹具保留，已从同实施源码验证 Core Ripgrep 23/129；R28 正式 ripgrep 测试文件为固定父字节，已迁移长例到真实 Session 通过。CodeMode 与 Core 原 types exit 0。首轮并发的 5 秒超时按原不变预算串行复跑绿，旧日志保留。原 staged Guard 在未变的源路径扫描 22、零错零提示，原 size 分析无豁免；不是最终 commit 或发布 Gate 的回执。
- OpenCode 原类型检查本地未完成。候选及独立干净 6dd 使用同 Bun/锁/检查器和原类型命令串行各实测内层 tsgo SIGKILL、无类型诊断（候选 40.61s、基线 102.57s；两者不到外层安全超时）。既有官方 CI 只能读已存在的远端提交，不能用旧版之绿代替。记录外部执行容量未完成，不视为类型通过，不降低约束。
- 同锁原完整 WebUI 构建在候选与精确干净 6dd A/B 均 exit 1、同一 client ./promise 导出错误。相关 owner 零差分，按 §18 独立 Follow-up，未改 WebUI。已成功用原 native 构建在真实 Xfce 启动并完成 Read/Execute/Shell、退出；背景开关的原任务和 CodeMode 目录对照通过（关无、开有），当前直接启动的本机测试及最终提交原线上 Gate 仍待验收，不把 serve+attach 当直启。
- 余下真实验收：OpenCode 全包原类型检查、最终提交绑定的原 Gate/双平台或实际要求平台、发布前独立实现裁决、不可变恢复包及最终用户分支验收。当前不提交、不推送、不合并。

### R16 实施回执（8aead09）

实际父提交为 `8aead09f29652c5acf5004675845873ab1d22a58`。按 §15 原样重放批准的 21 个产品、既有测试和唯一 OpenTUI 依赖补丁，后像逐一与 R15/已公开 R14 相同。产品树 `8814dd23ac0787e542057e3f9c64c3ea06bc1a35` 不含唯一 canonical Plan，产品差分 SHA-256 `09c96a57c3e6f59b4f35c325ee91f69d62043e4ca2c94a2784d57599849354bf`；产品 +615/-137（源码 +313/-119、已有测试 +186/-18、补丁 +116/-0）。原测试实例数不变，runtime.ts 3636→3736，现有合同和产品路径不扩大。前后像和注释与独立审核过的原计数输入相同，E=410、C=63（15.37%，阈值 62）。代表注释说明循环扣费、规约实时长度与 renderer 一次帧 owner。没有修改 Gate、锁、包声明、上游初始化或 viewport 夹具。

- §18 的真实公共 Execute mapper 红绿和现行真实 viewport fixture 均按当前基线及实际 21 个后像验证。现行原 `leak-preload.ts` 下，从 `packages/codemode` 原 `test/codemode.test.ts` 运行公共 JSON 和结构化数组两用例，2 pass、0 fail、5 断言；从 `packages/core` 跑原 `test/ripgrep.test.ts`，23 pass、0 fail、129 断言。保留真实三条 rg 命中和超长行的约定显示截断，两个命令均自然 exit 0。
- 各包目录使用原 `bun run typecheck --singleThreaded`：codemode exit 0（1.0 秒），core exit 0（13.0 秒），opencode exit 0（74.5 秒），tui exit 0（10.0 秒）。OpenCode 使用只读、断网且同一工作区的依赖投影。命令、原始退出和输出清单 SHA-256 `0fb38653d034d616580288f768f7dc61600af4604efd0b62e8b4d32c1791d1a6`。
- 在私有临时 index 使用当前原 `bun script/guard/check.ts . --staged --changed-since 8aead09f29652c5acf5004675845873ab1d22a58 --message <提交说明> --no-trailer`，按规则检查 20 文件、零错误零提示、exit 0。实际 `git diff --check` 通过。此项不替代正式 Push Gate 或 §18 的平台。
- 当前路径删除原单条 rg 体积拒绝和 Shell 展示正文误复用，纠正 V1 首个完整行与 next 归属；既有合法域、诊断及兼容分类按 §11，不增加备用成功路径。R16 仍需最新完整原 Gate、候选正式 CI/A/B 和最终 SHA 持久化验收。当前 8aead09 的 Core 窄复验仍出现 stock 600 秒清理残留，不能拿来推断所有正式平台；旧正式 Auth 通过后不退出与本地摘要前超时分开记录。R15 实机证据继续按 27f5f62 历史留档。未创建本 R16 最终提交。


- R16 同一 21 个产品后像在 Linux 从 `packages/opencode` 使用原 `bun run build --single --skip-install` 完成完整原生构建，约 43 秒，自然 exit 0；WebUI 编译 30.62 秒，CLI 与 Voice Worker 冒烟通过。构建投影前后源树一致，版本 `0.0.0-dev1-smark-202611210918`，CLI 二进制 SHA-256 `cffead4990ec821a1fec371d62f3f5d390c73c05807016c59ef349753487a75b`。
- 2026-11-21 香港时间 17:21:30–17:23:02，在真实 Xfce 终端运行该二进制。实拍四张：Read 完整首行与第二行续页及 Shell exit 7、原生 rg 三条命中与禁用态 Task 后台参数省略、100000 次循环预算及部分输出、应用正常退出。独立运行回执还记录建连后显示的 CLI 版本、交互退出、daemon 和 loopback provider 均 exit 0。四张原 JPEG 均为 1177×808，逐张校验及采集时间保存在 `pr5-r16-native-screen-bridge/original-jpeg`，原图清单 SHA-256 `28a942dcd10531da191dc686e1e8b5d9701a03e3ca2db2788fc743ba97d4867d`，运行回执清单 SHA-256 `4771f0f53eb75a542be4fa3b55d3352c1053525090961792ed202b56b8824b90`。正式 Gate 和正式 A/B 仍按 §18 执行。


- 对已冻结的实机证据树 `712fa9b76723d37701ffe66f4cae53b790641a60`，原 Contracts 的 schema、protocol 均通过，原默认 Stop 自然 exit 0。Stop 按原选择器将全量 24 包的 807 个测试文件延后到线上 Push preflight；本次只验证 Contracts、Stop 和选择器。原始回执清单 SHA-256 `24c273818a4966754c79a1d2e1c808966d4cb67d1eda39897cc35bd3582247ef`。
- 用该冻结树与原 8aead09 分别运行同名 Core 窄测。两侧的业务用例都通过；原 afterAll 均发现 `setTimeout(600000) @ unknown`，无子进程残留，两侧均 exit 1。候选本地 Auth 选择 225 项（missing=0、extra=0），外层时限在汇总前以 124 结束。两项结果各按原出口记录，正式实现审计 B-01 仍待当前线上完整 preflight 与 A/B。候选回执清单 SHA-256 `c5f47c5d543283fae8344cff57d5399046b5b42c11c795fca1c3a2923e60eb91`。
- 对上述已冻结树的 22 路径差分完成自包含归档，并从无网络、无外部对象库的空仓重放验证。原归档 SHA-256 `14cd14ea83635e6a6dfcb427e3e7afe73b34c259ec8dc839fa42e5c8088e87c9`，已保存至私有 Library 原条目 第 3 版；该版绑定 `712fa9b7`，本条行政回执追加后的 Plan 不在该存档内。

### R15 历史实施回执（27f5f62）

实际工作树父提交 `27f5f6259b43678482bd0f98eb42361e6a768849`。本轮按 §15 原样重放四个 CodeMode 生产文件和两份原测试、Core 三个生产文件和两份原测试、OpenCode 三个生产文件和三份原测试、TUI 三个生产文件及唯一现有 OpenTUI Core 补丁。21 个产品路径的实际 Git blob 与已公开 R14 逐项相等，源树 `d65c1ee026c2abb1abd7031d31ccb377bf972418`，不含 canonical Plan。产品差分 SHA-256 `09c96a57c3e6f59b4f35c325ee91f69d62043e4ca2c94a2784d57599849354bf`。原产品统计 +615/-137（源码 +313/-119、测试 +186/-18、补丁 +116/-0），现有测试实例总数不变，runtime.ts 3636→3736。产品前后像、分行和注释与 R14 精确一致，沿用同一有效行口径 E=410、C=63（15.37%，要求至少 62）。示例：根配额只在进入循环体时扣费，规约正向索引重读长度，旧异步帧只结算自身记录。Gate/workflows、锁、包声明无变更，工作树没有纳入探针或运行文件。

原路径和实测：§18 已在同一 27f5f62 前像看到公开 `Array.from` mapper 的 `UnsupportedSyntax`，实际同后像返回 `[3,5]` 且无宿主工具调用。阶段三从实际工作树、Bun 1.4.4 和原 `leak-preload.ts` 跑包内回归：`packages/codemode` 执行 `bun test --dots --preload ../../script/guard/leak-preload.ts test/codemode.test.ts -t 'returns JSON-safe data and normalizes undefined to null|opted-in object and array support structured operations and exact source coercion'`，2 pass/0 fail、5 断言；`packages/core` 执行 `bun test --dots --preload ../../script/guard/leak-preload.ts test/ripgrep.test.ts`，23 pass/0 fail、129 断言，保留三条原生 rg 结构化命中（含超 64 KiB 的 Unicode 中行）及显示截断。两命令自然 exit 0。

分别在四个包目录运行原 `bun run typecheck --singleThreaded`：codemode exit 0（3.0 秒），core exit 0（13.0 秒），opencode exit 0（170.4 秒），tui exit 0（14.0 秒）。三包的工作树链接投影和 OpenCode 的只读、网络隔离投影均通过。OpenCode 第一次直接从符号链接投影运行 exit 2，报导入了两个不同绝对路径的工作区 Plugin 类型；此回执保留，复验只调整隔离依赖映射，未改代码或测试。

使用临时 Git index 放入精确 21 路径及本 Plan，原 `bun script/guard/check.ts . --staged --changed-since 27f5f6259b43678482bd0f98eb42361e6a768849 --message <原提交说明文件> --no-trailer` 检查 20 个规则范围的文件，零错误、零提示、自然 exit 0；实际 `git diff --check` 通过。暂存规则检查与 §18 安全选测不替代正式原 Push Gate。

实际源删除 §12 明列的单条 rg 体积拒绝和将展示状态塞进模型正文的旧输出接线，纠正 V1 读取首行与 next 的归属。§11 的兼容、诊断和同合同分支分类不变，无新增备用成功路径。已保留历史原始回执；正式冻结安装、原 Push Gate/所需的平台、A/B、产品构建、实机及持久归档须绑定实际最终单提交。最新基线 stock Core 窄跑仍有 600 秒临时资源残留，旧 R14 精确两臂都红；本轮无授权在本 PR 内改其上游定时器或原 Gate。最新本地 Auth 是摘要前超时，旧正式 CI 是 225 项通过后不退出，不能把两者混作一条已验证修复。尚无 R15 最终 SHA、当前正式 Gate/A/B 或独立实现放行。

### R15 历史实施审计补证（27f5f62）

- **编译检查与原 TUI 包内回归。** 本工作树四包原 `bun run typecheck --singleThreaded` 均自然 exit 0，上节保留每包耗时及第一次隔离链接类型冲突；命令和结果清单 SHA-256 `bfdda74017aa4506fc740ad4ae4ab164ee81c663c6dc8f11c087d023ca98cf2b`。Bun 1.4.4 在 `packages/tui` 分别用原 leak preload 运行会话切换、部分 glob、扫描失败、预览重取和 app.exit 五个既有测试，每个 1 pass、0 fail、自然 exit 0，断言依次 1、1、2、3、2。终端测试清单 SHA-256 `21d5143965547ff8eca31b5d1df4edcf33da5af85a3aba96cbdfeecd14df0f2a`；没有追加测试实例。
- **原生完整产品。** 以实际 R15 工程、同锁 Bun 1.4.4 和已验证 OpenTUI 依赖投影运行原 `packages/opencode` 的 `bun run build --single --skip-install`。构建前后校验树一致；37 秒自然 exit 0，内嵌 WebUI 构建 28.11 秒，CLI 版本与 Voice Worker smoke 均过。Linux x64 二进制 229,759,152 字节，版本 `0.0.0-dev1-smark-202611210842`，SHA-256 `59034e3bd9894f5ed5f8b715fd68d685bac025fb75a43e711629115c187f985c`；OpenTUI 0.4.3-smark.13 的 Linux 原生库 SHA-256 `ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d`。这次构建使用已安装的依赖，不计作 §18 的两臂冻结安装证明。
- **真实 Xfce 终端。** 用同一二进制、私有 HOME/XDG 及 loopback 模型夹具跑真实 PTY。四次实际捕获为初屏、Execute 的长首行/续页和 Shell exit 7、超过 64 KiB 的 rg 三条匹配及禁用态不展示后台签名、10 万次循环配额及部分输出。部分截图底部保留原隔离 socket 提示，目标画面可读。应用收到 Ctrl+D 后 exit 0，daemon 进程及停止命令、loopback provider 和外层驱动均 exit 0。命令、二进制与运行记录清单 SHA-256 `f1792b72e250e713262e1c708e74646115d2e70c2f6dfe835e7fbfb462347963`。实拍保存于本轮执行的原生桌面工具记录，不在文件恢复包里；历史 R14 暂停恢复和编辑器回执不记作本轮新捕获。
- **重放与持久化边界。** 补证前冻结的 22 路径实际补丁已在独立空 Git 库、只读精确 27f5f62 对象供给和新 index 中校验。原补丁往返逐字相同，得到当时树 `631b6bff04c434004feaa052fcb0abfffed15aab`；规范文档仅追加本段，21 个产品后像不变。本段加入后的完整路径、实际补丁与空 index 重放须一并冻结。上次文件包 SHA-256 `178c79d703a1b32d82804243dbd53a060eb5dab8b6645f469c545e2285486b1e`，只含文件差分和回执引用，不含基础对象、最终提交、图像或依赖。正式最终提交后的持久化及独立重放仍按 §18。
- **原 Gate 与 A/B 仍开放。** 当前目标的原选择器已实际选出 25 包、809 文件，不能用上述窄验收替代原 Push Gate；基线已知的 Core 与 Auth 状态按上节分别记录。本轮尚无绑定 27f5f62 与 R15 最终提交的正式 A/B。原 workflow 从目标取基准脚本，准备两条源码工作树并分别冻结安装，使用 2,000 会话、最后 10 会话各 40 轮、20,000 模拟 token，覆盖 list/open/stream/abort，每场景一轮预热和每臂七轮。旧 R14 GitHub 40 项通过只记作旧提交结果；不改脚本、阈值、用例或 Gate 来替代。当前局部实机、类型与原回归结果独立有效，合并质量仍待 §18 所列实际最终 Gate、CI、A/B 和独立审核。

### R14 历史实现回执（98a9f13）

固定父树为 `98a9f13f30372c8c80a68cf40fcaf371974bd2b3`。21 个代码、测试与唯一 OpenTUI 载体路径按已审方案原样重放；实际补丁 SHA-256 `41b02dbd8524c967548a4f1d56332e531e41e123b51b9a2833f0fd0b14f4950f`。包源码 +313/-119，原测试文件 +186/-18，载体 +116/-0，合计 +615/-137；既有测试实例数不变。唯一解释器文件净增 100 行（3636→3736）。新空 Git 索引从同一父树重放这 21 路径后补丁逐字相同，树为 `024adfed57ee72dc2d65a0ee658a4e1a89f06c6b`。完整正式单提交和持久恢复包单独验收。

原已记账 R10 的 20 个其他路径前、后像保持相同。runtime.ts 仅以 §18 的数组循环合并替换重复内容，新增实质代码少 3 行；同样两个必需行为说明改为说明正向动态长度和无初值首个存在项。实际 E=410，C=63，至少须 62，C/E=15.37%。原空行、import-only、排版、移动、复述式注释及依赖补丁载体的上下文/原变更按历史口径排除；载体真正新增的 renderer 逻辑及邻近说明仍计入，OpenTUI 原 source map 无改动。代表约束是根配额只在进入循环体时扣费、规约正向索引每步重读长度、旧异步帧只结算自身记录。保留 §11 的既有兼容、诊断和主路径支持分支分类，本轮新增备用成功路径为零。淘汰的入口限制和重复读取仍按 §12。

原 Bun 1.4.4 和 98a9 原 leak preload，在隔离只读同身份依赖投影上执行：
- `packages/codemode` 原 `test/codemode.test.ts` 两条公开数组与公共 JSON 用例：2 pass、5 断言，exit 0。
- `packages/core` 原 `test/ripgrep.test.ts` 单文件：23 pass、129 断言，exit 0。同入口配 `test/session-runner.test.ts` 的整轮，候选与原 98a9 均 128 pass/1 fail、exit 1；唯一失败报同样的 `setTimeout(600000) @ unknown`，无残留子进程。候选 1316 断言，基线 1312。共享失败仍待正式原 Gate 覆核与定位。
- `packages/opencode` 原 `test/tool/code-mode.test.ts`、`test/tool/read.test.ts`、`test/tool/shell.test.ts`，选择原长行/不可拼接超长行条件的 2 个用例：2 pass、16 断言，exit 0。三原文件整轮，候选、原 98a9 均 225 pass/1 fail、exit 1。双方只红同一既有测试的 `/dev/zero` 软链：隔离运行器没有映射该设备，收到 File not found；候选 1199、基线 1170 断言。原测试留待正式 runner。
- `packages/tui` 原 active switch、partial glob、preview、active scan、app.exit 各自独立运行，均 1 pass / 0 fail、exit 0；原断言依次 1、1、3、2、2。测试依赖载入的 renderer chunk SHA-256 `9c87d9cfea63558f79e820f0e828cc91ee746ea301e59ff8655b31022e8455d8`，和已审补丁的产出一致。各历史红反馈的精确输入与证明边界保留于 §18。
- 仓库根运行原暂存检查 `bun script/guard/check.ts . --staged --changed-since 98a9f13f30372c8c80a68cf40fcaf371974bd2b3 --message <commit-message> --no-trailer`，20 个规则检查源、0 错误、0 提示、exit 0；带尺寸检查和完整依赖图，正式 `--commit` 仍须候选提交对象。已复验 `git diff --cached --check`。原始命令、退出码、日志及文件变更清单的 manifest SHA-256 `a57d78997bb9f98950a202a9959a01f227c4666388aa02d7307d3934569788fc`。

同一最终 SHA 的冻结安装、四包类型检查、原 Push Gate 及所需 preflight、完整 stock A/B、真实构建、终端与截图、正式持久恢复包，以及独立实现审计保持 §18 的放行条件。

### R14 实现复审补证

下列复验使用首轮实现送审的同一源码树 `bf94388dcb9c4e6e33c0a82eb3c380ab361b3728`，父为 `98a9f13f30372c8c80a68cf40fcaf371974bd2b3`。本段只登记补证；21 个代码、测试与补丁路径字节及已有审计结论保持原样。

- 原 OpenCode 三文件整轮以 Bun 1.4.4 从 `packages/opencode` 运行 `bun test --dots --preload ../../script/guard/leak-preload.ts test/tool/code-mode.test.ts test/tool/read.test.ts test/tool/shell.test.ts`。使用原 Linux 字符设备 `/dev/zero`（1:5，只读、nosuid、noexec），私有 HOME、XDG 与同锁依赖投影。226 通过、0 失败、1221 断言，自然 exit 0（38.05 秒），前后源码树一致。漏挂设备的原整轮失败仍按上段保留。复验日志清单 SHA-256 `ab163120f32793c7ee484312f013eb94b72b38b733304dcfa9a71342bad38547`。
- 各包工作目录按原脚本 `bun run typecheck --singleThreaded`（实际 `tsgo --noEmit --singleThreaded`）串行：codemode 3.21 秒、core 30.11 秒、opencode 72.17 秒、tui 28.11 秒，各自然 exit 0，前后源码树相同。命令与原输出清单 SHA-256 `010699abfb535ff2e1e91e552fa73044069cf45d92f030606a039eb1ae7dfd05`。
- 复用同锁只读依赖投影，核对真实 Bun、OpenTUI gitlink、补丁后的 renderer chunk 和原生库。工作目录 `packages/opencode` 的原完整 `bun run build --single --skip-install` 自然 exit 0，WebUI 编译 29.97 秒、实际 CLI 版本与 Voice Worker smoke 皆通过。Linux x64 二进制 229,759,152 字节，SHA-256 `c70fbf0a3d73092296cb653e6e08d3402e7fe6efe9c8a167b27c6894e4927aff`；唯一构建 tar SHA-256 `907ab63693610d5f5d1dab3b42c8c64da68f5e030957fa04f6f53bb8e0b5388d`。这一轮不是正式 frozen install 或最终提交 Gate。
- 同一个二进制在私有 HOME、XDG、loopback 模型夹具运行真实 PTY，在 Xfce 直接实拍初屏、Execute/READ/Shell（含长首行、续页、原正文与 exit 7）、三条原生 rg 命中与禁用态背景签名、100000 次循环上限及部分结果。实际 footer 可见。源夹具模型沿历史显示名“R10 acceptance”。隔离界面显示的 socket 权限提示保留于原截图。应用、daemon 停止命令、daemon 进程及 local provider 均实际 exit 0。
- 同二进制另用真实终端 job control，Ctrl+Z 使 Bash 观察到前台任务 Stopped，`fg` 发出 SIGCONT 后 prompt 恢复。原快捷键进入 nano，保存退出后输入回到原 prompt，按 Enter 走真实模型工具入口，Execute/READ/Shell 成功并重绘，应用及 daemon/provider 自然 exit 0。保留一次仓外采样员等待旧 nano 存盘提示的失败，以及实拍停止、恢复、编辑器和成功补验的末屏。构建和原图清单 SHA-256 `5ecd567760f50a76da0f47103a95b4d8e36a2c51168949a0dc7d71038ed7632b`。
- **B-01 仍开放。** 原 98a9 和候选的两文件 Core 整轮原 preload 都以 exit 1 收尾，均是同一个 600000 ms ref timer。对 exact 98a9 的原 `test/session-runner.test.ts` 用例 `executes and resumes canonical task sessions with durable results and scoped permissions` 做仓外 tracer，原 preload、产品和测试不动。第三次普通前台恢复遇取消时，无异步让出点的 race 已开始注册，取消链先结算父级，之后创建第 4 个 600 秒 timeout 子纤程；afterAll 该子纤程仍 ref，日志未见其 interrupt/clear。先前三个计时器有 interrupt 和 clear，对照保持。追踪臂仍 exit 1，原命令、原栈及事件序列的清单 SHA-256 `3a1d3dc2d4d0b9f62860e4d9fdbe47ca97b984c335b5e01e1808f9d09aa23d8b`。证据定位原基线已有的取消生命周期失配；本 PR 不改变该责任归属，不把同源红归为故障已修、宽测通过或 Gate 放行，也不调整 Gate/测试。

R8 未实施、未产生新的 formal Gate 或 release 结果。下文保留旧修订回执，仅作为历史，不得用于放行 R8。

以下为冻结 R5/R6 证据，R7 隔离回执在 §18。当前没有正式 R7 实施或 R7 Gate 结果。

冻结的 R5 参考记录：批准后的 Plan SHA256 `c3687d2d82f21fc4fc559d248d1b74bc33c2b4281197e87375d5f8608afddbb5`，实现 diff SHA256 `4ed0a8492626af97f8c1ef78c18fbed0d31c40dcc25ba83aab30c1856a11ddd4`。以下 §23 原实现数据仅作 R5 对照；EXIT-1 隔离试验在 §18，R6 已按独立批准实施；同一 §23 下的 R6 回执与 R5 冻结记录分别归档。

### Actual Files and Diff

阶段 3 固定基线为 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`，当前冻结跟踪差分 SHA256 `4ed0a8492626af97f8c1ef78c18fbed0d31c40dcc25ba83aab30c1856a11ddd4`。批准快照 SHA256 `5a1f10dda5a20cb6e7c5069da4332b4996928a88d99573a1da53084bf35a798b`；本节追加实施回执，批准的设计、范围和裁决原文不变。

- CodeMode 四个生产文件：`codemode.ts`、`interpreter/model.ts`、`interpreter/runtime.ts`、`tool-runtime.ts`；既有 `codemode.test.ts`、`promise.test.ts` 覆盖受限回调、构造、稀疏/序列化以及预算。
- Core 三个生产文件：`ripgrep.ts`、`tool/read-lines.ts`、`tool/task.ts`；既有 `ripgrep.test.ts`、`session-runner.test.ts` 覆盖长记录和 V2 目录，V2 Read 沿原接口回归。
- OpenCode 三个生产文件：`tool/code-mode.ts`、`tool/read.ts`、`tool/shell.ts`；既有 `tool/code-mode.test.ts`、`tool/read.test.ts`、`tool/shell.test.ts` 覆盖真宿主预算、V1 目录、分页和机器正文；OUT 不改生产。

READ 函数拆分前的历史差分为 17 个跟踪文件、+444/-85、净增测试实例 0，E=362、C=55，门槛 55。新增记录分为 371 行代码、59 行注释、12 空行、2 import-only；E 另剔除六行移位的接收者诊断、两行只重排的 RG 闭包和一行移位的文件扩展名计算；C 剔除移位、复述流程或断言的四行。代表性注释解释回调前快照排序长度、稀疏内部与公共 JSON 边界分工，以及 V1 首行准入复用既有预算。逐文件 blob、增减、注释分类和完整补丁见 `pr5-r5-integration-receipts/{formal.blobs,formal.numstat,formal.comments.tsv,formal.accounting.md,formal.patch}`，清单 SHA256 `2d13d1363346110b242bcbd0c596a854ee1639f0226bb047df0d5c2b7ebb2f69`。

类型检查定位到 V1 VIS 现有测试的字面量扩宽后，只给 `packages/opencode/test/tool/code-mode.test.ts` 的 `inputSchema` 加上 `CatalogEntry["inputSchema"]` 上下文类型，原断言、输入和计算保持相同。17 个路径的逐 blob 对照只变化该测试（`24e8bfc4268f1bb399977ffeba99bd61bd0b560f` → `a7f428dbb7cf966a72ff74d2985f874309a4f7b3`）；所有生产、原生和构建输入逐字一致。行数、E/C 与测试实例统计保持不变。锁定新差分与 blob 清单见 `pr5-r5-integration-receipts/manifest.type-fixed.sha256`，其 SHA256 `b8a48f589e5427dc75182ceaa6cb59caa4eb177782fcd8871fb91046b257c4b8`。

既有 Gate 的 `stop` 档在类型收窄后的 `e239712c…` 返回 exit 1；两处阻断都是 READ 的函数圈复杂度，core parser 为 22 > 19，V1 tool 为 72 > 67。原回执 `pr5-r5-release-prep/gate-stop.stdout` SHA256 `68568e9d9423c461f7f0fe36623583024872aab03f39e6e30bdea56f99aae3aa`。在既有 READ owner 内抽出 parser 的分块结算和 V1 页正文验证；结算顺序、错误优先级、已读/分页语义和上限不变。两文件候选补丁 SHA256 `cefde7c36dfe1499c49902fb2ad6a572efebfc8f82c1b48e2b4d9fc5cbd627e7`。随后仅在 V1 页转交点增加一条中文注释，解释不可交付的页不登记为去重证据。所有测试和 Gate 配置逐字维持。

最终 17 路径 +475/-105、净增测试实例 0。395 行候选代码排除接收者/解码闭包的 8 行原移位和 V1 页正文 15 行原移位，E=372，所需 C=56；62 行候选注释排除两行 READ 原移位与之前四项无效说明，C=56。独立实施审计复核。新补丁、blob 对照、重算分类见 `pr5-r5-integration-receipts/manifest.read-shape-final.sha256`，清单 SHA256 `03ee06de4d0321b436671ea783a801f293ac2b135011ce623149f336427f1588`。

### Red-Green Test Evidence

RG 当前 0dff 临时候选正规 core 夹具对照：固定真实 rg，原 does not split surrogate pairs in oversized line previews 用例增强为长行夹在前后命中之间。基线 0 pass/1 fail；候选仅删除结构化解析前的 64 KiB 拒绝，包级 ripgrep.test.ts 23 pass、129 断言，三项顺序、显示边界，以及既有 search-partial/invalid/bounded/abort 等控制均通过。未改产品超时/数量阈值，不将通过的 partial 控制记作新生产补丁；仅在另有可达丢结果红时再改停止分支。原始回执 SHA256：候选 8c7b084fbd5ed72299ebb792f1e832ce4de5907bc5b09b89c482b8eb2e41eddd，红 0dca6e7e56d8550d178075534700739798075a20d124d0d08cdfe21bcfa292d5，绿 501994f5cf6958db8b10f26024d8d4d2a59ad81c0ecca9685503dc1fadf19116。

READ 核心模块已有真实隔离 A/B。Bun 1.4.4，用完全相同的第一行（`"河".repeat(7000)`，UTF-8 21,000 B）和第二行 `tail`；offset 1、limit 1：基线 `raw=[]`、`cut=true`、`more=true`；归档 R7 返回整个 21,000 B 首行、`cut=false`、`more=true`。两边 offset 2 都返回 `tail`。这两份 `read-lines.ts` 仅依赖标准 fs；实验不经过宿主 Read 工具，R7 只作对照，不是当前候选。原生 rg 70,216 B 记录是三匹配合法输入；固定基线 core adapter 对它报 `Ripgrep.Error: Ripgrep JSON record exceeded 65536 bytes`（诊断封装刻意返回 exit 3，非 rg 自身退出码）。同夹具的 32 KiB 对照正常完成，exit 0。归档 R7 树 `d6ca3355f3af78d4581cffa2cc134a332ee270f2` 的精确 adapter（`a7789e495173e2af4016e48c5d2e087346764d08`）以隔离同锁依赖、同一绝对系统 rg 15.2.0、同样 32 KiB 与 70 KiB 夹具验证；未启动 provider 或 installer。两组均 exit 0，仍返回行 1/2/3，中间展示文本 2003 字符、`truncated:false`。原始回执 的短记录与长记录日志 完全一致，SHA256 `e7077f2a9e26990794e5a7de03be8ded81c797ef22de465624365e80b0d959e1`。这是旧源码的实际正对照，不是当轮候选或宿主验证。

CodeMode 已取得固定基线的真实红反馈：原样 `packages/codemode`、锁定 Effect、Bun 1.4.4，直接从 `src/codemode.ts` 运行同一解释器。使用 `env -i`、新 HOME、`--no-env-file --no-install`，无 fetch、宿主、应用或真实工具执行。`Array.from([3,4])` 返回 `[3,4]`；同一数组的 `Array.from([3,4], (v,i)=>v+i)` 返回 `UnsupportedSyntax`（unsupported map，第 1 行、第 8 列），两次均 `toolCalls=[]`。诊断断言封装 exit 0 表示准确捕获基线结果，不是 mapper 通过；原生语义的独立预期为 `[3,5]`。归档 R7 同树原样 CodeMode（入口 blob `3081c255b110990248a7ee52e46c20ac9055b6d2`，工具投影 blob `0acea6523ef754a7bc5770730d32b39f7325bb2e`）在相同依赖、`env -i`、禁止 fetch、无 provider/真工具的核对下，mapper 返回 `[3,5]`，逐索引 mutation 对可迭代和 array-like 均返回 `[1,9]`；合成目录关闭态隐藏 background，开启态保留。基线诊断组和 R7 正对照组的断言封装均 exit 0，实际行为由各自日志区分。证据 `pr5-codemode-pure/{origin,r7.log,r7.exit,dependency.provenance,probe.ts}`，`r7.log` SHA256 `334b89b6d1a8b231d2b653bc5e12c04894377c79662743e87762818c158a2f5b`，`probe.ts` SHA256 `9dd3253641fed7dfdf9d77c9d77c2923be653c880fbf4bd2b0aa918dba445147`。没有执行真实 Task、宿主启动或任何新候选。

同一固定基线的预算控制：Bun 1.4.4、`env -i`、`--no-env-file --no-install`，只注册一个以 `Effect.sync` 累加真实准入次数的合成工具，不启动 provider。显式传 `maxToolCalls=1024` 时，1024 次请求成功且计数 1024；请求第 1025 次返回 `ToolCallLimitExceeded`，计数仍 1024。不传上限时 1025 次均准入并成功。结果证明子库计数已存在；当前 Execute 宿主是否正确传限额仍只做源码追踪，不计作宿主测试。另一个零工具的显式循环进入循环体 100001 次，耗时 1477 ms，在超时前返回 100001。旧 Plan 选定 100000，用户明确要求的是设定上限、没有指定 100000。当前证据说明时间兜底未替代循环次数门槛，不是对嵌套累计或宿主配置的验证。

READ 扩展对照使用原样的 live/R7 parser，各保留文件名 `read-lines.ts` 以解析自导出。使用 Bun 1.4.4、`env -i`、临时 HOME、`--no-install --no-env-file`，只写合成双行或短多行文件。原始证据 `仓外读取矩阵探针` SHA256 `12b47bb88bb1b98ae63db92f9dd6bd6b35f3030a6154e70be925a0bd730f5b2f`；`result.ndjson` SHA256 `18bf68f1db19104c21e8bae12d809b447e8fefa8c3ede297d7eed9e856eaaaed`。以下每格为 `raw；cut/more`，数字量是完整 UTF-8 行的字节数，T/F 为真/假；15 行的 totalExact 均为 true，两树的 count/physicalBytesRead 相同。

| 合成文件；offset/limit | 0dff | R7 |
| --- | --- | --- |
| 21,000 B + tail；1/1 | []；T/T | [21000]；F/T |
| 21,000 B + tail；1/5 | []；T/T | [21000]；T/T |
| 同文件；2/1 | [tail]；F/F | 同左 |
| a、b、21,000 B、tail；1/2 | [a,b]；F/T | 同左 |
| 同文件；1/5 | [a,b]；T/T | 同左 |
| 同文件；3/1 | []；T/T | [21000]；F/T |
| 同文件；4/1 | [tail]；F/F | 同左 |
| 两个 21,000 B 行 + tail；1/3 | []；T/T | [21000]；T/T |
| 同文件；2/2 | []；T/T | [21000]；T/T |
| one、two、three；1/2 | [one,two]；F/T | 同左 |
| 同文件；3/1 | [three]；F/F | 同左 |
| one、two 恰好两行；1/2 | [one,two]；F/F | 同左 |
| 16,384 B + tail；1/5 | [16384]；T/T | 同左 |
| one、two 共两行；3/1 | []；F/F | 同左 |
| 单个 21,000 B 行且无末尾换行；1/1 | []；T/T | [21000]；F/F |

结构化包表达式已从基线原样提取并隔离运行，完整宿主仍未运行。源码合同见 `packages/opencode/src/tool/read.ts:561–575,598–602,710–728` 和 `packages/core/src/tool/read-filesystem.ts:341–345`：正文为 `raw.join("\n")`，`truncated=cut||more`，仅在 `more` 为真时给出 `next=offset+raw.length`。因此同一输入的包级独立断言是：首个大行基线为 `content="" / next=1`，候选应为 `content=完整首行 / next=2`；短前缀未改变，`next=3`，从 3 续读完整大行后是 4；尾行与无换行的已读 EOF 不给 next。不能把 parser 的 EOF 空结果外推成宿主成功，V1 另有越界守卫。保留绝对路径、V1 token 校验、展示层 2,000 字符截断、物理/辅助预算、后续行累计限制、重叠和 stub 识别（`core/src/tool/read-presentation.ts`）；parser 正对照不等于 Tool 或展示层实测。

READ v3 可行性对照仅作仓外隔离实验。检测点：在增量与提交两处保留首行限制；从原软限制触发处记录物理块的待扣字节，进入辅助模式时不论首行已接收还是被截断，都只扣一次此前已读块。若待扣量耗尽旧剩余额度，原块结束后停止，不预读下一块。21,000 B 首行在 offset 1/3 由空页变为整行，投影 next 由 1→2、3→4；strict UTF-8/CRLF 跨块仍完整；无换行 EOF 返回整行且不带 next。两种偏移的 1 MiB 无换行输入及七种剩余额度（0、1、16383、16384、16385、32768、262144）均逐字段同基线；默认 offset 1/3 的 physical/post-window 仍为 278528/262144 B。

跨块已接收首行、后接 1 MiB 尾部的对照曾发现原型多读 16,384 B：前缀长度 16,376/32,760 B 时 278528→294912/294912→311296，limit=1。v3 在成功切到辅助扫描时也扣回先前已读块，30 组长尾/短尾/EOF 与不同块对齐、limit=1/2 对照均保持同基线 physical 字节，两个异常收敛为 278528/294912 B，仍返回完整首行且下一页为 3。固定哈希：临时 parser `a13c7fc309cf634a5c0ec26ff1491d10c52e49125e99d45712e411b558968210`；`result-v3.log` `9f1d64c4dfa0d7b0ed3b90f0f3381f30c3b9f0afd093f8ca5c740d0d36e5e808`；`exhausted-v3.log` `1e81c0e397174e452fcf3fbdb3042b5ddd5afa65389c6a28af1a651e61a5fa90`；`long-tail-v3.log` `600ff0d464d04a120014992dd5f5b07d2f91e7a69ac4fec295963d225054dbd0`。有限窗口之外的自指 next 仍未解决，宿主 Tool 与正式源码均未跑。

补充对照（Node 24.22.3、空环境、纯文件解析器、offset 1/3、limit 1）：只复用旧辅助扫描会读取的块，40 KiB ASCII 首行在 EOF 返回 40,960 B，物理读取 40,960/40,964 B；48 KiB ASCII 首行后接 CRLF 和短尾，返回 49,152 B，物理读取 49,159/49,163 B，投影 next 2/4。八组的物理读取、辅助扣费、余额、行数和精确性均与基线一致。旧账仅余 16 KiB 时，同一 48 KiB 行仅读 32,768 B、无正文、投影 next 1/3。1 MiB 无换行时，读取仍为 278,528 B、扣费仍为 262,144 B，但候选未提交正文峰值为 278,528/278,524 B，基线在约 16 KiB 软限后停止累积。这里是暂存正文的编码字节数，不是进程堆测量；候选放大未终止行暂存，且低预算仍自指，故淘汰。临时证据目录 pr5-read-existing-budget，候选 SHA256 a92acbe533e0c1747fa4f9461fea1874b26ae5b638587cc297a096389ff8c4da，脚本 b6d1044d1214834bcd02a2adda033b9d9198a6478fd1390b87c455a2569a069b，日志 b86f05b00716761495c057acafc090e805de4438b676787e28a7891602316356。V1 的结构化包、展示和超估算预算行为尚未实测。

V1 准入隔离对照（Node 24.22.3、空环境、仅纯 parser）：18 组按 offset 1/3 验证。调用方模拟源码既有 Math.ceil(UTF8 字节数 × 扩展名比率) ≤ 16,000，parser 不持 token 常量。TS 比率 0.28：40/48 KiB 均完整；57,141/57,142 B 放行，57,143 B 拒绝。多字节与 ASCII 尾字符混合、默认比率 0.25：63,999/64,000 B 放行，64,001 B 拒绝。每组的物理字节、辅助扣费、余额、行数和精确性均与基线一致。1 MiB 无换行仍读 278,528 B；TS 暂存峰值降至 57,142 B，高于基线约 16 KiB。这是正文编码字节数，不是堆测量。拒绝组按现有包投影仍自指 1/3。临时目录 pr5-read-v1-admission，候选 SHA256 481ab12317cebba72d0d4c1ccc61d00927564cab015560affeaae0831056016f，脚本 8bb979dcb47203e42b37d6f83b249632528b4cbd9985cfba19e8079c8565157e，日志 6ab557bd288f33c300f811b1d82e90d2f86a1cec5a10ea11369143ab689a6e28。真实 V1 的预算、回执、包投影仅查源码，尚未执行该路径。

分页投影隔离对照：用纯 parser 的实际输出驱动最小投影替身，八组通过。空文件零行和 EOF 的空白行一行都成功、不带 next；空白行后接短尾或超长次行，正文虽为空字符串，均已交付一行并返回 next=2；普通部分页保留 kept 和 next=2；越过 EOF 走原越界行为。超 token 首行由原型显式原因产生无 next 的错误；旧扫描余额仅 16 KiB 时，48 KiB 首行得到零行、cut/more=true、totalExact=false，替身仅在注入明确扫描耗尽原因后才得到对应错误。该注入是契约探索，现有接口没有此字段。本轮只证明已有字段在这些样本可识别零进度；totalExact 不能区分原因。中性错误不要求为两类样本新增原因字段。证据目录 pr5-read-project，脚本 SHA256 fffbb41334928b95a62b458648ab5f69aa6d956b9988b7e98d83b8ed8ffb2989，日志 1eeb416c9d5db8744b311b2e99ae6838253ef1568f5af543c48ca339d51097dd。未执行真实宿主。

中性投影对照（Node 24.22.3、空环境、纯 parser + 最小替身）9/9：正 limit、零交付行且 cut/more 为真时，超 token 与扫描余额 16 KiB 的两个样本都返回“现有读取预算内无法返回完整首行”，无 next；判断不读 token/扫描原因或 totalExact。新增 limit=0 对照保留原有零行成功、cut=false 和 next=1；普通部分页保留 kept/next=2，空白首行及空白部分页保留 next=2，空文件和 EOF 空白行正常结束，越界仍走原错误。临时目录 pr5-read-neutral，脚本 SHA256 1ac0e0e31c3f7eed8dc688718f008e075f31acce2a5713b560a843b43be633b4，日志 d0235939b4cfeae1a39eb5e538baf338eb174ff9e9f92c36eb65a4ad48e22f8c。真实 V1 尚未实测。

基线 V1 分页包隔离实测（Node 24.22.3、空环境）：固定 0dff 的 read.ts:575、604、715–718 原样置入只传 file、filepath、mime 的包装，接固定基线的真实 parser（仅为 Node 自引用加 .ts 扩展名）。六组断言通过：21,000 B 首行得到空正文、offset=1/next=1、truncated=true、total=2/exact=true；offset=2 返回 tail 并结束；空文件及无终止换行的 EOF 没有 next；空白行和普通部分页均 next=2，部分页保留 kept。该红反馈覆盖实际包投影表达式；未执行宿主初始化、权限、回执分支或工具输出验证。临时目录 pr5-read-exact；V1 源码 SHA256 20bf6771cb1199db7623c610bf8f80d20115f8399cddf4b935862fe3235dc185，parser 原文 69ff961e3bed0c187fe85d40d38bca620c66c9e671acd45432b7f56f7ad481b8，提取 db2dcfba67a86f9f9db7b9d2c7f47ebc9600732546fcc14c3ebb7f246a411ff2，探针 ba52f6728c3ad199d7642ba1b88782836ef1f5d31136e41e8aed6f87e65caf4c，日志 ff0820d027dac956feb3b4a185e5ee368009f3b34d620a63f51d45a41d9e20ec。

固定 0dff 的宿主补证均在私有隔离环境，Bun 1.4.4，cwd 均为 packages/opencode。正式仓库零测试改动；临时 OUT/SH 断言补丁 SHA256 53a7d3bec69dfb34b1e09502dea83430cb722887a649cf3f57577dab0ecf4647。

- OUT：bun test test/session/execute.test.ts --test-name-pattern '^final Execute failure bounds original diagnostics and provider error text$'。1 pass、19 断言，实际 read 子任务完成且子输出含哨兵，模型错误回执和完整恢复文件都不含该正文，同时保留显式日志和错误头尾。基线满足该要求，不改 OUT 生产代码。pr5-out-fixture.log SHA256 4c804aa0accc1cbe351423af664166af053c78fa2a73ccdf1f78192e7470ed55。
- SH：bun test test/tool/shell.test.ts --test-name-pattern 'reports exit notice for (empty successful output|non-empty failed output without diagnostics)$'。同输入的基线 2 fail，机器正文夹进通知；只将 program.value.content 改为 end.text 的临时候选 2 pass、10 断言，机器正文精确为空或 plain output 加换行，exit 0/7、显示与 UI 原有断言、truncated/timedOut 保留。pr5-shell-red.log SHA256 f4cf54e8e16f5ca1ec9a72a767356e5e20fcfa075664ce98cfed409b22f9c87b；pr5-shell-green.log SHA256 2b455ce1009e6ee0fb80a3202800f319f102fea5172400e041c9cc7e78478a61。
- BUD：bun test test/tool/code-mode.test.ts --test-name-pattern 'preview caps total calls while review retains unique tool inputs$'。现有基线原用例 1 pass、5 断言；断言明确通过的是预跑记录收敛、正常阶段实际执行 1025 次并返回 7，后者与新需求相冲突。此结果确认真实宿主缺口，不是候选通过。pr5-host-base-fixed.log SHA256 32fd38917eaa1aee7b60668837892023712bc1619627a556650670b694bffb7a。

真实 V1 READ 已完成同基线红绿（Bun 1.4.4、私有隔离环境，cwd packages/opencode）：bun test test/tool/read.test.ts --test-name-pattern '(bounds displayed long lines within the byte budget|bounds an oversized unterminated line without assembling it|shares the bounded auxiliary budget between page accounting and outline)$'。临时 test SHA256 3942bb28ef581901775a6985d64e3da2a59b6edaf8442bbc1ff5961734baf05d；临时诊断 SHA256 9d9c5cb0a7a9b47ac60fa839857c1b61ee3adfea7be9c75a494396e65a0c424d。基线 2 pass/1 fail，实际长首行 program.value.content 为空、next=1；候选 3 pass/20 断言，首行 21,000 B 完整且 next=2、尾页无 next、显示仍裁剪、超大首行走中性错误；1 MiB 无分隔符原控制与共享 outline 两臂都过。红日志 SHA256 47cefcdb923560af5cc405ef4e75103cd6f00e9acf069870df04e448c43c3184；绿日志 048b7d00a7c388105aa800e621bf6944f24c5f495c119bba073f5a438014498e。结果覆盖真实 V1 Tool 化及包格式，暂存上限仍沿已验证的候选设计边界，正式差分与范围回归尚未开始。

BUD 工具上限已完成真宿主同基线红绿：Bun 1.4.4，在隔离的 packages/opencode 运行原 preview caps 用例，临时 test SHA256 364e97c8e1939a62a3b82afbd9d3ec562ddf99b4fa5602051bc4bcda9ca23c1c、临时诊断 SHA256 f0f2033129abcacb084acc739d961274704e32d125c2d3f0fcca1b73107d9ea6。两个独立 Execute：1024 次仍返回 7；再请求第 1025 次时基线实际进入 1025（0 pass/1 fail），候选只进入 1024 并报预算，预跑唯一参数记录不变（1 pass/7 断言）。命令 bun test test/tool/code-mode.test.ts --test-name-pattern 'preview caps total calls while review retains unique tool inputs$'。红日志 7abbff913162ecb012b112cc124fe464bea75d363144610fd16e105bfc17fe1d；绿日志 2f72e211d3953a77637680816d3567e96ac881e3100c9c5f5bf67ff70b103807。

显式循环另用同一现有宿主用例（原工具调用断言作不相关控制）；在同一个 Execute 内跨两个函数调用累计，验证 100,000 成功、100,001 拒绝，随后新 Execute 能再次消费 50,001。临时 test SHA256 08748e623872993335ac91b57a9235d4ce43576a0df1a802634f215e2482a718，诊断 SHA256 db9b7664404ff849a2b8493786d0aac6cbd843bac43ac3a15e29335471c33667；同输入真宿主基线 0 pass/1 fail/9 断言，临时候选 1 pass/12 断言；红日志 SHA256 f2eea80d9b1ea5f1409c0a677a64e3ea36fd9e617d1458138a0887e3fa4a94ca，绿日志 d842d052b2deb8780bb6e7aa314a0eec85ebbcc997728bd7cf98a91e8e0ae756。另保留纯库已有并发/嵌套控制，串联两次函数调用不记为并发实测。

JS 组合验证：空环境 Bun 1.4.4、同一 0dff 依赖，组合 Array 构造、受限回调、mapper 后，原 7+7 对照的日志逐字相同，Promise.then(String)/用户回调与 replace(String)/用户回调基线和候选均通过，不为其另动生产或添加永久测试。1,000,000 空位置的 some 以 10ms 逻辑超时运行，两臂均 TimeoutExceeded、实测约 38/40ms；1,000 空位置宽预算均成功。单数字 Array 构造洞已证，不过稀疏数组字面量接 map 时，两臂都返回所有索引而不是仅 1/3；套用历史数组消费 hunk 的粗对照仍红。应把字面量来源与 slice/map 消费拆开检测，定位首个变密处后才确定 JS-3，不以计时控制或构造成功冒充稀疏全覆盖。临时 pr5-js-combined：组合补丁 SHA256 9c40d68b4bc2bd8b0bedafd574c85d05157ba14ba3f8ae35445e1eb971738328，控制脚本 c190778ef71eaf9ba62ff308ccea1c8d7002a8f98cbf9998c10a35e5efcda500，基线 a2dcf7cc44c5e9744d6da8c89a2ba2f28cbf50381aa76d734869b6f3fbc0b566，候选 954acc543df425003dd7d1253f27cdc5fdadba379678def0ec554dd30baa9bb1。

稀疏 JS 最终诊断红绿：evaluateArrayExpression 用 values.push(undefined) 把 Acorn 的 null 空槽密化，改为仅增长 length，配合同 owner 方法各自的跳洞/访问与调度规则。固定基线与完整临时候选九组同输入，候选 map/flatMap/filter/some/every/forEach/reduce/reduceRight/sort/toSorted 的观察恢复，findIndex 控制保持。候选另有字面量与两种 Array 构造、四种 find、比较器排序/非破坏排序和十个百万空槽方法的 10ms 超时控制；此前 mapper/expanded/extra 三套组合继续通过。临时 pr5-js-sparse-current，full-js.patch SHA256 7283556097b307e144dfcc0eabfcb39c7b9cf23e595dcf91e08dd7a77008ae1b；单个 producer 修正 31a34cb8992123981fecadcee864157bfb27b52744c671fd481d9e4ab6f16a6e；baseline.log c635f5ac496b00a9fb525238ad962991a44b5e5ba364ba449c4d8a21f6fe3aa7；candidate.log 0dcf2385c4d3e0849141b933168ae9253ec4b4f1b46ca163537d8b711653188c；boundary.log d594589b967cdde8f30ba56465409466d4e68524e51c84f02a291349a55a0f66。

变参 Math 独立三臂（Bun 1.4.4，空环境，同基线纯解释器，每臂九项、断言封装皆 exit 0、零工具调用）：原生 map 第三实参就是数组，单元素 [3] 的 max/min/hypot 分别返回 [3]/[0]/[4.242640687119286]，双元素数组转数值是 NaN，故 [3,4].map(Math.max) 两项均 NaN。0dff 拒绝回调；未转换的完整组合接受回调令牌，却由既有 Math 检查拒绝数组；最终只在已准入的三个变参 Math 回调转入现有 coerceToNumber，再走原调用器，全部原生对照通过。Array.from 的两实参 mapper、定参 floor 与纯数值直接调用保持预期；直接传数组或字符串，三臂都保留 numbers-only 约束，不改 stdlib，也不扩展 Number.isNaN 等未计划的回调。证据 pr5-js-math-variadic：完整 patch SHA256 1388fb990d923705fb4ed4d126ba1b9b607a1b8509bfbc7e5cb551f08250597c，探针 6428973dc224187dc28c17f6d376d7200893891efea72dd009f62414d7d9623d，基线 93809ae4dff2949f699ba26fb2f755a4766710b1e8ad2c22cf379b48310d1777，旧组合 74a647add93a9901ec2d6ac96c439afc6329e24d50074f8099c09fc3dc2a0fcc，候选 c238998b2f5c66045cd5a180c0bf0bb0941bf6cf2fbfdfba6b7194e497bf1329。

R3 两个审计发现的三臂隔离复现：相同 Bun 1.4.4、空环境、无工具、网络拒绝，在每臂目录运行 bun run repro.ts baseline|r2|r3。10 个同输入加原五套 probe，R3 全通过。B-01 比较器把源长度改为 1：R2 结果 [1,1,[1]]，固定 0dff 和 R3 同为 [2,1,[1,3]]；稀疏结果 R2 长 3，R3 长 4 且仅键 0/1/2；toSorted 保持现有行为。B-02 直接返回 [,1]：R2 公共数组只枚举键 1，直出与 Schema 运输值不同；R3 公共键 0/1、值 [null,1] 且直出和 Schema 结果一致；嵌套、构造、结果列表、map、flatMap、undefined、NaN 的公共结果等价，内部稀疏 map 仍仅键 1/3。隔离 pr5-js-r3-paired，探针 SHA256 3e43a795be627448a748e5e7c62f73125e27e3b4e4b49cbdbe078de232643604；R3 相对 R2 临时实验 ad058524370a4337d28aa03ce12513c542057a036bd0bd9edc79886324d17770；0dff 到完整 JS 候选 e0376f3647c797dd845b2677213159da8662edd5d9e6d824eaf6e5d2ea1be20e；固定日志 9bbeb06114e371fd64c902d911726c9d10adf38fe358878022cfca7977b35034，R2 日志 82d9cc8344cc9b8408de3df29f2eac64d0f0a822d4a9715643ad74b9222b613e，R3 日志 661151b8fb15cf6c2211967b71a5aafc48c491fa4caf1cf755a5ad95d3b9ee28。R2 对照只用于辨识审计回归，不构成正式实施基线。

R4 的 B-04 隔离实测（固定 0dff、R3、R4 同输入，锁定 Bun 1.4.4、空环境、禁止 fetch；每臂执行 bun run host.ts baseline|r3|r4，三臂断言封装均 exit 0）：通过真实 CodeMode.execute 注册 raw 函数与 JSON Schema 工具，在实际 handler 和 onToolCallStart 两侧观察含洞/显式 undefined 的数组和嵌套对象。0dff 和 R4 两类工具、两条观察路径都收到顶层键 0/1/2、嵌套数组键 0/1，新增的自身 0 号索引值是 undefined，显式 undefined 自身键不丢；R3 在两个 owner 都丢失洞对应索引。R4 解释器内部仍保留洞；最终 JSON/Schema 往返仍以 null 表示空位；两个旁路三臂字节一致：JSON.stringify 得到 [null,1,null]，未捕获 throw 的错误正文为 Uncaught: [null,1]；同套工具调用顺序、长度和显式字段保持。唯一 R4 修订在 copyOut 数组分支复用 Array.from 并递归传原模式。现有调用点清单：tool-runtime invoke、stdlib JSON.stringify 和 runtime throw 用默认模式；runtime console.table 与最终执行结果用 true；内部数组和 copyIn 都不走这项改动。目录 pr5-js-r4-host：host.ts SHA256 b7b0cf58b921c43f1d35488f973b5071ae5682813997d76a7e1fb16f8936ec0c；基线 b24952a06b51cb6d05e6716fff76d47b0fb5f21e6bbfeb06438dccdee583c8ad，R3 c3a2292cd364f249e8f868c2f331f37f363c950db8ef9f19af65afb15a0a9a45，R4 781573e9dd5db65706c39b80e872196a7ff4e4514be713617342e79f96e8a6a0；临时差异 99725ff80542f620f1166a8765bd74ee19513db1f63e0d88100ca735140454e0，0dff→完整 JS 诊断差分 4476ad09665939ad0f060d86ad970eb0d4b67bfefe283edeb4db835d27183c19。原组合 expanded、extra、mapper、R3 sort/公开结果、稀疏主/边界六组在新候选均通过（同目录 prior-*.log），其中五份与此前文件逐字一致。以上是阶段1收据；正式实现仍须在原既有测试中补上述边界且保持零新增实例，复跑原命令。

R5 B-05 实测：Bun 1.4.4，空环境，fetch 禁用，逐臂执行 bun run host-r5.ts baseline|r4|r5。raw 与 JSON Schema 两个真实调用处理器都观察原字面量 [, "one"] 的自身键 0/1、map 回调两次；索引赋值的真实洞在固定 0dff 和 R5 均仅键 1、map 一次、结果 ,ONE，R4 错误填洞导致真实工具失败。原基线的 Array()/new Array() 各自拒绝，R5 支持两种构造产生同样的真洞并能正常调用两个工具。固定 0dff 的公开索引赋值结果原数组与 Schema 解码有洞差异，R5 的公开结果保持 null 且直出和 JSON/Schema 回环一致；解释器内部仍区分字面量自身键和真实洞。R5 另跑五个 pure-r5.ts 控制：比较器改长度、真实稀疏排序、真实空槽集合回调、旧字面量语义、嵌套 JSON 值均通过。另复跑 mapper/expanded 均 exit 0，十个百万空位用例依旧 TimeoutExceeded，budget-r5.log SHA256 d594589b967cdde8f30ba56465409466d4e68524e51c84f02a291349a55a0f66，与上一轮边界回执逐字一致。不得把 R2–R4 中以字面量制造真洞的临时断言保留为正式新增测试；原实例改用真正构造/赋值样本，旧字面量仅作不回退控制。临时目录 pr5-js-r5-host：0dff→完整 JS 试验差分 SHA256 95ced020f1ee5fcc28e4e87886b279834ae052d284e7f574b490e853ce20bf96；R4→R5 仅为对照 250b94ba9937da3ddf8ce58af5a1db7a09f6c4ee54780447b06f68a1b4e9c980；host-r5.ts c4466e02370fbabcacb6e270abf3f520e35f5d52fa6745d7cf9576aeb68b5f51；pure-r5.ts b322860700d6fa616c346c9bc98d4e0388df97485ff7918f1286f26533c33cb0；基线 d383b5ad6a5d4b9360953e20ccc3289197b13f11b4575b437ed179b84f84f96f，R4 16c3a56e5d37694f535db188efba45a6f583926563751b2af43ae48aaa3a4843，R5 b48a95b5e910d453015e6943e26fe28356b776fff548ac9b0f40a4c05c99c7ad，纯回归 73d034f96a74e2442f4390005ec97e61b23051ef1f27ba6dff9eefd0908d7970。

后续已留存的 BUD 脚本见 `pr5-budget-receipt-0453/caps.ts`（SHA256 `11533cbffa0ca5dd5d23bd38743d8f44a88c40dd932b0b5259473ddc577d1a7b`）、`nested-reset.ts`（`9d02b5e702b288dd372eff95184d092de21e94a81a49c007dc0b3cf0e535edac`）。后者从运行稿 `pr5-codemode-budget-pure/probe.ts`（`66668771bc5888fc6c1808dfe6ea3b992ecbb0825f3aa797da4315b50c9c8ab0`）只去掉一行未使用的函数，原始 0dff/R7 日志仍在同目录 `{baseline,r7}/{result.log,explicit-host-opts.log}`；四个日志字节校验与 `pr5-budget-receipt-0453/result.sha256` 一致。原样子库运行显示 0 额度零次准入、第 1025 次之前截住、下一轮工具计数复位；用阈值 3 的嵌套和并发 async 循环在 0dff 成功，在旧 R7 得到 `LoopIterationLimitExceeded`，同一持久 lexical environment 的两个新执行均通过并按预期得到 2/4。复制宿主参数的控制组显示未传限制时实际 1025、循环 100001；显式传旧 R7 两项时限制 1024/100000。同样是不启动宿主/provider 的子库验证，而非宿主预算验收。

### Verification Commands and Results

**阶段 3 原冻结候选及类型收窄后的复跑**

下列 778 项测试、首次型检和原生构建使用原冻结差分 `1e60c5db8049ce238e61f3d72514e0f6755db6b0bfdc4d0103aecf29e41d3501`。新旧差分仅有上述现有测试的类型声明变化；产品实测仍使用这个生产字节一致的二进制。

- 独立目录以锁定 Bun 1.4.4 运行包内既有用例，使用审查过的 loopback-only 隔离和测试所需的 `/dev/zero`。在 `packages/opencode` 运行 Read、CodeMode、Task、Shell 264 项 / 1,371 断言，另运行 OUT 3 项 / 50 断言；在 `packages/core` 运行 RG、session-runner、V2 Read 139 项 / 1,417 断言；在 `packages/codemode` 运行全包 372 项 / 1,360 断言。共 778 项、4,198 断言，exit 0，`pr5-r5-impl-exact-frozen.log` SHA256 `95296c91aa5c1521f2958ca00c186ca7a23aac52d3849787fa114e840a7ede4f`。
- 同一冻结差分在 Codemode/Core 的包目录分别执行 `bun run typecheck`，均 exit 0，日志同为 `ae47736bb2a9401aa9743893f2f64b9a605e65a99d78cd991a8021e0f7722d87`。OpenCode 的第一次同范围调用收到 SIGKILL，wrapper exit 1，无 TS 诊断，原日志 `9eba98065c448aad47f8d14788a638e9024049b9417d2cf7fb7b7caf425d519f`。
- OpenCode 在原包目录以 `env GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB bun run typecheck --singleThreaded` 复测同一 `tsgo --noEmit` 项目范围，exit 2，实际发现 `test/tool/code-mode.test.ts:288:44` TS2322。启用分支内联 schema 的 `type` 从字面量扩宽为 `string`，与注册条目要求的 `JSONSchema7` 冲突。系统可用内存采样最低 4,231,704 kB，未收到信号。日志 SHA256 `7136440c01f273b71601c47e17d7dc9a4473147749f69d90c91aee519cd1431c`，三秒采样 SHA256 `bc23a95b473a2ebb3845c7f65b7f0786d262ed17a34ba831916872756df19a51`（`pr5-r5-impl-opencode-type-limited.{log,exit,memory}`）。
- 当前冻结差分的同范围 OpenCode 复测（`packages/opencode`，同一 `env GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB bun run typecheck --singleThreaded`）exit 0，约 79 秒，系统可用内存最低 3,423,652 kB，无 TS 诊断。日志 SHA256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`，三秒采样 SHA256 `51119f6a12bcf554cba26bc9e3a05a9b42af6a1135383e8b9f6d0efa7e80dd1b`。随后在同目录执行 `bun test test/tool/code-mode.test.ts test/tool/task.test.ts`，105 项 / 700 断言，0 失败，12.39 秒，exit 0，日志 SHA256 `7c282bfd7760414f99b9d199f3773ceda12a0ff158a84a4a88ba0936af287237`。
- 类型声明修正后的 `e239712c…` 跑同四组全量选定回归，778 项 / 4,198 断言，exit 0，日志 SHA256 `9d6dab86884794ed04318a2ea2ffc89e62a3874f3978c7b214299f2ca1624b34`。READ 拆分后的 `f86bfa5d…` 用同命令、同隔离再次跑四组，778 项 / 4,198 断言、0 失败、exit 0，日志 SHA256 `9b93072db6aa3b4a1b396edd11087771c10ee2e2dab2ea09c07ab7d921f6054e`。最终 `4ed0a849…` 仅多一条交接注释，精确字节在 `packages/opencode` 运行 `bun test test/tool/read.test.ts`，在 `packages/core` 运行 `bun test test/tool-read-filesystem.test.ts`，84 + 11 项 / 391 + 102 断言，0 失败、exit 0，`pr5-r5-read-shape-final-boundaries.log` SHA256 `9244e2e931a347ebad7f6cc98faef8cbefcbe151892c7d626b260b579a99a6c3`。
- 冻结源码投影使用 `packages/opencode` 原生构建入口 `bun run build --single --skip-install`，exit 0，墙钟 41.932 秒，WebUI 31.43 秒，CLI 和 Voice Worker 冒烟均通过。回执在 `pr5-r5-native/`：日志 SHA256 `0d1f58d29a2c9ce3c697c68d240177e8aaae177e862679691f46e5ddfd0b1dc5`；投影来源回执 SHA256 `89076eae4a9141bc95d438a66e3328b5453729e475412b39f1df338a6963151a`。原生产物 tar SHA256 `1faee472698a69d03a497a75a91be4212c589515412051978e35c38e04d166e8`，二进制 SHA256 `b6179de1598a236621b76f27fcd8351773d70b5665d726c1c9caabdbc599a93c`。

**最终冻结差分 4ed0a8492626af97f8c1ef78c18fbed0d31c40dcc25ba83aab30c1856a11ddd4**

- 从各包原目录串行执行 Codemode、Core、OpenCode 的完整 `tsgo --noEmit` 范围，同一 Bun 1.4.4，仅用 `--singleThreaded` 约束资源；三包均退出 0，无诊断，运行 112 秒。逐包回执清单 SHA256 `ada0d6f29c6a09fa26f8fe78a5487cb8d92fc5bc498e02176cfa8e9e43e2434a`。
- 用相同冻结生产源构建原生完整应用，退出 0、用时 46.587 秒；二进制 SHA256 `9311f675c93ecfff54ab3999329ecf0492f1ddda5f506422e89c6165735613e6`。在真实 Xfce 终端运行并分别拍摄启动、READ 长行续页与 Shell、真实 rg 三条匹配与 Task background 可见性、执行预算四张屏幕。应用、守护进程及本地 provider 均正常退出。回执和 JPEG 在 `pr5-r5-final-native/native-screens/`；真实二进制与生产差分相符。
- 原工作区 Stop 规则及测试选择通过，原测试入口退出 1。当前冻结候选与精确 0dff 基线在同环境、同顺序各为 33 通过、1 既有跳过、1 失败、186 断言，唯一失败同为 `app.exit prints the session epilogue after scoped cleanup`，指向原 5 秒 toast 生命周期。配对只给出归因，原 Gate 保持失败，后续按原要求重验。
- 17 个代码文件从空目录重放校验通过。最终 Plan 与代码合并的正式恢复包及发布验收仍待 Gate。

以下保留阶段 1 的原始验证和复跑配方：

READ 复跑配方：在一个新临时目录，用 `git show 0dfffcda:packages/core/src/tool/read-lines.ts > live.ts` 和归档对象库 `git show d6ca3355:packages/core/src/tool/read-lines.ts > retained.ts` 逐字导出模块。用同一 Bun 1.4.4 创建上述双行文本，将模块分别导入，调用 `readTextPage(file, {offset: 1, limit: 1})` 与 `readTextPage(file, {offset: 2, limit: 1})`，记录 `raw.map(line => Buffer.byteLength(line))`、`cut`、`more`，并断言第二页正文为 `tail`。第一行超软预算而低于物理扫描上限；不调预算、不启动 OpenCode、不导入包测试。

RG 已跑的最窄入口是 `Ripgrep.Service.search`。Bun 1.4.4；固定 0dff 的 `packages/core` 与 `packages/schema` 原样。用已核验的锁定依赖，在隔离进程替换 `RipgrepBinary.node` 为返回系统 `rg` 绝对路径的 `Layer.succeed`；不构造可能下载的默认 binary layer。保留真实 `AppProcess.node` 和 `FSUtil.node`，只传合成目录、单一文件、固定本地 pattern/limit。清空继承环境并使用临时 HOME/XDG，不启动应用、不载入用户配置，也未启动 provider 进程。本地 rg 15.2.0。未执行包测试、Gate 或真实 UI。

### Original Feedback-Loop Result

阶段 3 实施红绿沿已有用例：Shell 两个正式红测 exit 1，修复后 2 项 / 10 断言，包内原套件 75 项 / 280 断言；OUT 原样回归 3 项 / 50 断言。RG 原长记录红后回归 23 项 / 129 断言，V1 和 V2 暴露路径各有实际红绿，READ 的 V1 首行红后连 V2 一同回归 95 项 / 493 断言，JS/BUD 宿主与解释器验收 439 项 / 1,903 断言；最后统一运行冻结差分（见上）。

以下保留阶段 1 的红测记录：

已取得 READ 核心原样基线与 R7 的隔离对照、RG 核心原样基线红和短记录控制、VIS 原样 adapter 红和两个对照。VIS 固定输入为同一 `id`/可选 `background` 的公开与运行时合同，原样模块由 Git blob 固定（第 8 节）；其中无保留的脚本或结果文件可据以给出 SHA，不能声称存在持久化日志。另已从 CodeMode 真实解释器取得 mapper 红与不传 mapper 的正对照。RG、mapper/逐索引读取与投影已有独立的精确 R7 正对照。下一步核验拟议当前候选和真实公开宿主路径；历史树正对照不是 R10 恢复，其他入口仍无固定基线红反馈。

### Actual Secondary and Replacement Path Inventory

替换发生在现有 owner：RG 解码器移除 64 KiB 人为拒绝；V1 Read 只在现有准入与扫描预算内承接首行；Shell 机器输出只取现有 `end.text`；V1/V2 工具说明保留原解码；JS/BUD 复用既有运行、分发与 JSON 边界。OUT 继续使用原恢复信封。未引入并行路径或失败后兜底。

### Remaining Unverified Items

当前剩余：原 Stop 的基线共有失败须按原 Gate 路径解决并复验；再完成精确最终单提交的原 Push Gate、同 SHA 所需平台回执、正式恢复包独立重放及独立实现审计。上述为冻结 R5 当时第 3 步结果；R6 目前等待第 2 步独立方案审计。

### R6 当前实施回执

固定发布 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`；批准方案原样快照 SHA256 `6e16d278cdebc240df17b599457cfd05136b0c4f23f193a4f3f9a0724ac75262`。实际 18 代码路径补丁 `645aac8f92e487cd3e165b0a6834b449fdd609bf00cac1d5250ce36e9f36d0f9`，+483/-106，diff-check 通过；相对冻结的 4ed 唯一改动是批准的 EXIT-1 owner。EXIT-1 的单文件补丁 SHA256 `05782bd47ad3bd1ab3e3e824d79bce47c85cb1bba47cacd8060d04416953f8c1`。专属有效代码 E=6，中文约束说明 C=1（排除单独 import 修改）；全差分 E/C 仍以完整同源收据登记。原规则扫描 18 路径，0 错误、1 既有 runtime 文件长度提示。原 Gate 脚本、测试及 fixture 没有 R6 新差分。

- EXIT-1 实施采用阶段 1 原反馈，Bun 1.4.4、cwd `packages/tui`、stock `leak-preload.ts`、原用例和原夹具。未改 owner 时 focused 原测试同一 5000 ms 计时句柄被 Guard 捕获（exit 1）；实现后原 focused 1 pass / 0 fail（exit 0）。原两文件组合 34 pass / 1 skip / 0 fail、186 断言（exit 0，129.08s）。同精确补丁的仓外活跃场景 1 pass / 0 fail、6 断言（exit 0，6.12s）：原 5000 ms、替换、到期、卸载释放活动句柄、卸载后回执不再写入。回执：pr5-r6-implementation/{red,focused,two,active}.{command,stderr,exit}。场景探针不在实际差分，未弱化原 Guard。
- 相同实质差分在 `packages/opencode` 原命令 `bun run build --single --skip-install`：exit 0，45.325 秒；WebUI 编译 33.68 秒，CLI 版本及 Voice Worker smoke 成功。锁定 OpenTUI release gitlink `b0cf25352ca75b964eca476af3554e6aa8dd8b20`，编译原生日志记录其 .so SHA256。真实 Linux x64 可执行文件 229759152 字节 SHA256 `a6db196dcb495dde952979afa3b70573b890ef84f568d06b8d42203540151972`，原构建 tar `8b4826fba8e8702235202fdf9e9ab70c8928bbf4443b14aab7c925640d13a23c`。
- 从该可执行文件在独立 HOME/XDG、loopback、本地模型夹具和真实 POSIX PTY/Xfce 运行，截得四张原生 1177×808 图：初屏 `0e91756be796d954790dbfb273df6f273e0def97f57d8c9480f99949e476d4f2`；READ/Shell `686a26d574aa27972f159337fd4f55189bc35024de21651106e7f97fa2f9e0f9`；rg/Task `d3b01ef309352b85de210a996041e59f231941b211272547b7d15fc136a7eb83`；预算 `cd780c571fca24626a233cf03663b07ea67f507c01e915fea9c15b031aeaec8c`。原产品显示完整长行/续页、纯输出及 exit 7、原生 rg 三条命中与关闭态隐藏后台参数、100000 次执行预算与部分结果。Ctrl+D 退出、守护进程实际退出、stop 命令及本地 provider 均 exit 0，实机回执 SHA256 `56c99163fc2de4ba3c43984808874adb435e34146242af6d4a9b69c5f7f9ddaa`。图中 R10 acceptance 是复用的本地模型显示名。回执绑定当前 diff 和批准 Plan；最终 Push Gate 与正式单提交不在这些结果内。

### R6 类型检查、恢复点与门禁状态

对同一 `645aac8f…f36d0f9` 差分，用四个包各自的目录执行原 `bun run typecheck`（各包日志实际为 `tsgo --noEmit --singleThreaded`）。香港时间 21:56:09–21:58:49，codemode、core、opencode、tui 四包各自 exit 0，同一总运行 exit 0。原日志、四个退出码与时间在 pr5-r6-implementation/type-r6；清单 SHA256 `593220b3d8c15b4293cab2415ed4f6cde553cdf7ed7fefefa948f79a45179522`，清单全项复验通过。

阶段三恢复点 v1 已独立空目录重放两次，对应 18 路径 overlay、批准快照及已取得的原生/类型/窄测证据。恢复包 SHA256 `4948d7a27b54339395f8f18f971f0a7b18b77bba25ace6d5cc3b07d21e72fdba`；包内管理性 Plan 保留 v1 写入时的 `7193031c…8bb3` 快照。该恢复点绑定本轮实施中间态。原 formal Stop、正式 SHA 对应的原 Push Gate／所需 preflight、最终恢复归档和独立实现审计仍为单独门禁。

用原 `script/guard/affected.ts` 对 18 个代码路径和 canonical Plan 共 19 路径实际取选集。原 Gate 默认本地 Stop 的执行顺序是 opencode → core → tui：opencode 253/323 和 core 112/161 达到全量阈值，由原流程交给 preflight；tui 选择 32 个文件（同序清单、原 preload 命令和 JSON 保存于 pr5-r6-implementation，JSON SHA256 `fb1bef161f4e79bde41755974170c8f163110ec3e461eb79ed3515c2c816b94a`）。直接执行原 32 文件命令只能验证其子步骤，不能替代正式 Stop。香港时间 22:21 启动原 Stop（同一 19 文件，实质差分 645aac8，启动前管理记录 70438315…166d）。首轮隔离 checkout 缺可写报告挂载点，在选集时因 EROFS 退出，尚未跑测试；在同一原 launcher 的约定下预建两个空挂载目录，供私有 tmpfs 存储报告。原命令与代码均未调整；重跑规则、TUI 多余防御检查及选择器通过，opencode/core 全量由原 Stop 延迟到 preflight，TUI 32 文件实跑 168.50 秒，191 pass / 1 skip / 194 fail、2670 断言。原 Stop exit 1（3m11s）。原 Gate stdout `d8e8ab502589caad62a35a8d86a982d4a850a3761cd593cbf816d7216ed66ad5`，stderr 为空；日志末尾样本由原 Guard 报告 Session 滚动延时、OpenTUI spinner 和帧循环等，未据此推断全部 194 项的来源。原 EXIT-1 窄测/两文件结果仍单独有效；完整 Gate 未放行。

### R6 原 Stop 的固定基线对照

香港时间 22:30:53，原 HEAD `0dfffcda` 的同 32 TUI 文件直接使用原 Gate 选择顺序、cwd、Bun/依赖锁、原 leak preload 的对照结束。真实 exit 1，185 pass / 1 skip / 200 fail，386 用例、2670 断言，169.60 秒；200 个失败均命中原 Guard afterEach。stderr SHA256 `fd80bb035a1d9ce37ab8d5d6b46da8129ba1e97b1d742e2b897abbe52c0eb531`。候选正式 Stop 的末 8 KB 显示 8 项失败及其资源位置；这 8 项及全部可见位置在基线重现，基线也单独记录了旧 app.exit 的 Toast 5000 ms。候选正式轮次净少 6 项失败；尚缺候选全量原测试流，不能据净差证明其余用例无回归。候选同 argv 的直接原始流对照为后续诊断，不能代替原 Stop 或正式 Gate。

### R6 同选集全原始流与偶发渲染对照

固定 0dff 与 R6 645aac8 的同 32 文件直接原始流，按完整文件路径与测试名对照。基线 185 pass / 1 skip / 200 fail，候选 187 pass / 1 skip / 198 fail，两组均为 386 用例、2670 断言，失败均在原 leak-preload afterEach；197 个失败名称共有。三个仅基线失败（含 app.exit），一个仅候选失败（single reasoning tree replay: selection）；10 个基线 Toast 5000 ms 报告在候选原始流为 0 个。候选 stderr `12d3f8fbc446016fbefd5983413a5f2f97b60b545fb6a3438329d2b185431953`，逐用例与资源比较 `714291c9c4f2f6887aed7845ea189ed1d4a5ea4ea830e5e2365419a0392127fa`。正式 Stop 的同组曾有 194 项失败，与候选直接运行的 198 项不同；保留各自原始结果。

对完整同名 `single reasoning tree replay: selection`，使用同 test.tsx、原 preload 与相同依赖串行 A/B/B/A，每轮实际执行一项、三条断言：基线首轮通过，两次候选通过，基线第二轮在原 Guard 报一个 OpenTUI `requestRender` 定时句柄（相同锁定模块、相同生成代码 7803:18）。基线该次 13.700 ms，候选全选集同签名为 15.303 ms，无残留子进程、无 Toast。证明同名同位置故障在未改动的固定基线也可出现；不能按单次 A/B 差异归到 EXIT-1。四轮原始输出及实测 timing 见 pr5-r6-implementation/reasoning-selection-runs，SHA256SUMS 的 SHA256 为 `88bdbd4a43123d37faab3055c4688fb70b9abe7b18069afa3958502c1df74c55`。原 Stop 仍未通过，剩余共享渲染资源位置没有因本对照自动放行。

### R10 第 3 步阶段回执（2026-11-21 HKT 01:05–01:07）

- 独立批准快照 SHA256 `b0e6aed9fb8a1d21a5e8a23eba15de03c90625afb89f4752d974c22b1c6a200f`。阶段3实际从原发布基线 0dff 重放，21 个代码／测试／既有补丁路径，+618/-110，零新增测试实例，diff-check exit 0。实际全差分 SHA256 `39279e802611a5128d798a0207d797ef78304a979bf25a7a8c765eb3e87ab572`，前像与后像清单 `c5938e9a82584d46490a23fa3673fc275b84ff8e05bdf91509e6bfac9d534d5a`。原 Plan §1、批准记录、范围与方案不变。
- E413/C63（门槛62）；保守将两行仅缩进的 JSX 标签计入 E 仍为 E415/C63、门槛63。补丁文件的上下文、补丁语法、已保留内容不计作有效业务代码；用实际旧安装 chunk→新 chunk 单独计算 Core 21 有效行、4 保持所有权约束的近邻说明。Scroll 和 Spinner 说明各 1 条。完整分类与排除记录 SHA256 `a251cf7b3d338ed48068921bfb2c2d7ec3e3aa935b050aaab2b9ea815d157304`。
- 现有 Core patch 原有字节保持为新文件完整前缀，补充 116 载体行；实际 patch SHA256 `d418d3334ea6eb051c10ae9c0698edd3cf4e3437f6d4755feb1acd27e610586b`，对真实发布包前像逐段重放后，原有 index.js／ScrollBox.d.ts 与旧安装逐字节相同；新 renderer chunk SHA256 `9c87d9cfea63558f79e820f0e828cc91ee746ea301e59ff8655b31022e8455d8`。只覆盖私有执行时依赖投影；原锁 SHA256 `56c20270792f5ce4ecced742b5e3667ca53573da26a3af6153e6f9a484635ed5` 未变。该重放不计正式 frozen 安装。
- 同一实际代码与 chunk 在 packages/tui 用原 leak-preload 依次运行 active switch、partial glob、preview、active scan，每项 1 pass、0 fail，原断言依次 2/2/4/3，共 11 条；四命令的独立启止、原 stdout/stderr、退出与源身份前后校验记录存于 receipts。清单 SHA256 `8dab2afad23f70df0095b24c5715e55c28777525fd7b72a251d73cbd9b8832d3`。预先观察的 Red 仍按 §18 原版本分别记录。
- 原 affected.ts 以准确 22 路径（21 上述路径＋本 Plan）静态选择 exit 0，所有 25 个有测试的包均为 full，原因一致为既有 Core patch 属全局输入。选择 JSON SHA256 `f387083c39bb8ac27dbc5e2558be5a58c91896f0dd0e3c7897c403a75864b42f`；这一步未运行测试。当时仍第 3 步；冻结两臂安装须在可访问锁定发行源的现有正式宿主完成，真实 Gate/所需 preflight、当前版本 type/native/runtime 和审计尚未通过。保留阶段 1 的离线缺包和 DNS 实测，不因局部四绿收缩验收集。

### R11 最新发布基线重放（验证用）

原 R10 方案在固定 0dff 的独立批准记录保留，代码行为从原 0ab20fa8 到目标一致。现发布目标 0b5754df 相对 0dff 前进两个提交，官方比较的 32 条路径全部属于 Guard、workflow、hook；与 21 个实现路径、包目录和锁无交集。项目已合入的新 Gate 是外部验收依赖，不由本 PR 修改。

上面的 R10 执行回执各自绑定 0dff 私有投影，不能作新版本的冻结安装或原 Gate 放行。新 leak preload 将限制从用例逐次检查改为整轮 afterAll，对旧输出不做等效换算。R10 的真实时钟与编辑器/活动渲染实跑仍独立证实销毁后陈旧句柄实际触发，修复行为与旧 Gate 的分类无关。最终按照新 selector、原 fixtures 和新的真实同 SHA CI 重新验证，既有结果只作对照。

候选临时验证推送只限 #5 自己的当前分支，用于触发官方资料可用环境的冻结安装和测试。该临时目标并非批准合并或实现审计通过。当前不写发布目标分支，不增加计时器 PR。以上 R11 运行只对应临时树；R12 的正式验证必须重新绑定其精确树。

### R12 另一个正式发布阻断：原基准输入

[#5 验证头的官方 run 44782018814 / job 136447136892](https://github.com/SMARK2022/opencode/actions/runs/44782018814/job/136447136892) 的原日志为 `[bench] 场景返回模型错误：{"data":{},"name":"MessageOutputLengthError"}`，进程 exit 2。两臂原冻结安装均完成 2386 个包，失败发生在计算两臂测量前：最新 stock `script/guard/bench/opencode.ts:255–311` 先用固定基线 0b5754df 执行 seed，未到具名场景也未启动候选测量。当前原 mock 默认 20,000 伪 token 所造文本 137,800 ASCII 字符，超过固定产品 65,536 字符限制；相应原 Guard workflow 未降低 `--tokens`。因此没有 A/B 结果。该独立前置不归本版 CodeMode 收敛；保留原失败，拒绝改 Gate、临时减小输入或者把较小输入的诊断当正式通过。等待原上游 fixture 正式可用或按完整范围规则另行裁定；期间可推进本 Plan 当前范围及原型、审计、其他实测。

### 98a9f13 发布基线与 R12 的历史对照（R13 核对、R14 保留）

原 R12 诊断提交 00ac941a7d26119262229196e7b067c682c1fa67、tree 99f5d7a05595daa2e4dcba39aa902af419b136db 的父提交为 0b5754df。原静态回执 0 错误、0 提示仍是旧基线事实；其范围为同一 22 路径，runtime.ts 净增 +100。在最新真基线独立 checkout 逐路径比对，目标新增 8 路径和候选 22 路径无交集；排除 canonical Plan 后，以冻结 R12 单提交执行 git apply --check 当场通过，未把产品补丁写入工作树。runtime.ts 仍为 3,636 行，R12 原 +100 由相同前像和同一 hunk 保持；新版正式规则须按最终单提交重新实际执行。上游 benchmark 修复从目标自然进入候选父树，最终 #5 差分里不得包含这 8 个路径。

<details>
<summary>R12 独立方案审计原文（B-08）</summary>

## Blocking findings

### B-08 固定基线的必过基准在候选启动前失败

- **违反约束：** REL。#5 正式交付须通过原样新版 Gate。
- **证据：** 官方 run `44782018814` 的基准任务在 `0b5754df` 生成种子数据时以 `MessageOutputLengthError` 退出，尚未开始 A/B。`script/guard/bench/opencode.ts:255–311` 先执行固定基线的种子请求；`.github/workflows/guard.yml:195–224,334–341` 从目标分支取基准脚本，并要求运行时代码 PR 的基准成功。
- **方案缺口：** R12 §23 已明确记录该发布前置条件，但尚无可用且已验证的上游基线。修改 #5 候选无法改变这个发生在候选启动前的失败。
- **最小放行条件：** 目标分支的原基准先恢复可用，再绑定实际目标 SHA，按同一新版 Gate 重验。保留原错误，不降低基准输入、不改 Gate，也不用临时结果代替正式通过。

## Non-blocking findings

R12 的唯一收敛改动有明确边界。核对了单 hunk 与回执哈希，两版公开探针输出逐字相同，四条命令均退出 0。文件从净增 130 行降至 100 行，达到当前规则边界。正式仍须用实际单提交复跑尺寸检查。

## Follow-up

用户授权的临时单提交验证可以继续检查尺寸、功能和其他 Gate 作业。临时验证和最终可合并判定分别记账。

## Rejected speculation

无需为 #5 修改基准脚本、调整阈值或增加 Gate 例外。

## Requirement and traceability coverage

核对了 exact R12 SHA-256 `a7f8dd2bed85339c5c6c077bf3d54c78dc3355886c0be3a387330812216ebc91`、固定目标 `0b5754df` 及数组收敛前后证据。其余产品范围沿用 R11。

## Primary-path and fallback verdict

数组收敛留在既有解释器方法内，未引入备用路径。已知阻断在目标分支的必过基准。

## Release verdict

**BLOCK**。正式可合并放行等待目标分支的原基准恢复；本结论不阻止用户已授权的临时验证。

</details>


### R19 实施收据（6dd9a5b）

准确父 `6dd9a5b1f3a0110e9d1c8142e2230724f6906f42`、树 `e0baea4acaa886363c1c172f5c80a5422bfe620f`。十九条源码／既有测试路径的每个后像与冻结的 #5 一致；另改唯一 OpenTUI 补丁载体和本 Plan，共 21 路径。产品差分 +563/-152（含补丁载体上下文漂移，不计 Plan）。Session route、锁、依赖声明、Gate、基准脚本不变，零新增正式测试实例、零替代成功路径。补丁 blob `a2306d057413c4f5ea795c55f2c184bd6bfc43b9`；对锁定发行依赖顺向 apply-check、实际 apply、反向 apply-check 均通过。第二至第五段的补丁字节、两项非调度输出和整个目标 Session 文件均不变；新产物仅比已在阶段 1 单独验证的 identity 产物多两条中文注释。

按原冻结记账 E=410/C=63，剔除已经由目标接管的 Session 新增有效行 11/1、旧 renderer 有效行 21/4，计入当轮新 renderer 13/2，得 E=391、C=60（15.35%，最低 59）。原口径排除空行、import-only、排版、纯移动和载体上下文。两条新注释解释挂起后旧回调不得领取新帧，以及过期的延迟回调不得清掉新帧的句柄。

- 在私有 loopback 和固定 Bun 1.4.4，以真实 OpenTUI 原库及公开 renderer API 重放批准的零延时 red/green。准确基线 sentinel 先见 frame 1、最终 1、退出 1；从最终补丁实装的候选 sentinel 为 0、最终 1、退出 0；连续帧接替两臂均由 [1] 换为 [2]，销毁后空集合，推进时钟无遗留，退出 0。
- 从候选各 package 目录运行原测试。OpenCode 原表格、围栏、公式、回调与分片测试 1/0、5 断言；TUI 原 partial Glob 与换会话贴底各 1/0、1 断言，均使用原 leak preload，自然退出 0。CodeMode 原 `test/codemode.test.ts test/promise.test.ts` 加原 preload 190/0、738 断言，退出 0。Core 原 `executes and resumes canonical task sessions with durable results and scoped permissions` 加原 preload 1/0、162 断言，退出 0。
- `bun run script/guard/check.ts --staged` 自然退出 0，19 文件、0 错误、0 提示；`git diff --cached --check` 通过。此命令的原输出说明规模在 commit-msg 阶段检查。
- 仍需最终同一候选的原冻结安装及类型／发布链、完整原 Gate 和 A/B、真实终端实机、空目录恢复及全范围独立实现审计。以仍红的历史正式 compact 回执为历史，不以本地 stock 选测替代正式检查。

### R19 第一次实施审计返工：公开调度状态

保留首轮实施树 `5801442313f6aef41dcabdaa8b625d3349a0937a` 与其 BLOCK 裁决。用真实 renderer 的公开 `getSchedulerState()` 重跑 idle、即时帧排队、挂起、销毁四态：6dd 为布尔 false/true/false/false，exit 0；首轮候选在排队态给出对象，exit 1；修正候选恢复四个原布尔值，exit 0。原 owner 中唯一新增改动是把公开投影改为 `this.updateScheduled !== null`；内部身份仍只用于一次帧所有权。修正后的实际依赖 JS 和首轮实施仅差这一表达式；另两份输出完全一致，顺向和反向 apply-check 均通过。唯一补丁后像 `91d259b18760779584473f94bba5b217ef2d3c41`，总范围仍 21 路径；有效行 E=392、C=60（最低 59）。

修正后重跑首轮同范围：零延时 witness sentinel=0、最终帧=1；连续换帧／销毁 witness、原 OpenCode 表格用例 1/0/5、TUI 原 Glob 与换会话贴底各 1/0/1、原 CodeMode 两文件 190/0/738、原 Core 选测 1/0/162，全部自然退出 0。原 TUI、CodeMode、Core 选测保留 stock leak preload，运行命令及退出回执逐项留存。现待全范围独立实现重审。


### R20 实施与验证

基线对象树为 `e0baea4acaa886363c1c172f5c80a5422bfe620f`。从精确线上 R19 `8f0a7c70…` 的全树回放 6dd 准确前像，独立索引写出同一基线树。R20 相对该基线为 22 个路径；相对 R19 只变更 CodeMode runtime、共享 Read 显示、V1 Read、原 Read 测试和本 Plan。Gate、锁、依赖、原测试实例数和目标单提交合同不变。

- **Read 原回环。** 静态差分前先改同一原测试断言，运行真正 V1 ReadTool：精确 R19 在旧新增错误处自然退出 1（9 断言），R20 同名测试和原 leak preload 1 通过、14 断言、退出 0。完整 V1 两臂各 84 个业务用例通过，原 afterAll 在同样的 20,000/10,000 ms 引用计时器、无子进程处退出 1；按正式 CI 再设置 `OPENCODE_DISABLE_LSP_DOWNLOAD=true` 对照，结果仍相同。完整回执保留，当前不声称该全文件 leak 检查已绿。
- **V2 与解释器。** Core 原 ReadTool 和文件系统原两文件 32 项通过、246 断言，原 leak preload 退出 0。Bun 1.4.4 内用准确 parser、候选和原 projector 对照 7 组，V2 真实默认渲染函数全部字节一致；V1 超预算并有尾行/无终止两类由原失败恢复为原截断结果，marker 只省略 offset。准确工作树 CodeMode 两个原文件 190 通过、738 断言，原 leak preload 退出 0；11 项实际公开执行对照确认 R19/R20 逐字一致，保留原 receiver 诊断、一次 computed key、数组 mapper、undefined/null 和回调准入。
- **安装、规则与类型。** 锁定 Bun 1.4.4、准确锁；原冻结安装限制在 opencode 与 @opencode-ai/core 两个包，退出 0。完整 monorepo 冻结安装此前到达隔离期限，未记作通过。初步 V1 差分的原暂存区检查报圈复杂度 71>67；同一既有 `readPageContent` 承接已经在运行的页投影，恢复原入口复杂度，原暂存区检查 4 文件、0 错误、0 提示。CodeMode、Core 原类型检查退出 0；OpenCode 原包型检已在首次实现退出 0，最终同一页投影的重新核验另存原回执。
- E=408，C=62，门槛 62。排除 Plan、空行、import-only、原样移动和无意义格式化；继承 R19 已审口径，R20 加 16 有效行、2 条解释。新注释解释旧页不能证明本次零交付以及已有截断标记仅在不能继续时省略 offset。
- 原完整 Gate、正式 A/B、发布构建/实机、持久空目录恢复及独立实现审核作为交付门禁继续保持。无新增备用成功路径、无新的读取错误、无新增模型说明。

收据组：`read-red`、`read-v1-green`、`read-v1`、`read-v1-base`、`read-v1-ci`、`read-v1-base-ci`、`read-v2`、`read-seam`、`codemode-exact`、`codemode-shapes`、`frozen-read.lock`、`local-static`、`type-codemode/core/opencode`。


### R22 实施与验证

正式发布基线为 6dd 的已核对全树；累计范围仍是 22 条。相比冻结 R20，产品仅变更原双向归约的一段代码（+4/-2），并更新唯一 Plan。实际 CodeMode 原测试 blob 为 `c56ba738dad7300393ea7e223fd449c8a345aac6`，移除 R21 对中间版本退化的正式断言，保留 R1 已有缺陷的全部原验证。新代码只在真正零长时走旧拒绝，正长度全空槽保持成功，原显式初值、空槽跳过、动态扫描、工具/循环预算和其他数组方法保持。

- 精确实施树的仓外 Bun 公共对照 11 项通过，记录两方向成功/null、真正空数组旧错误、已给初值和混合空槽。R20 原退化红反馈继续保留在 R21 验证历史。
- 原 CodeMode 两文件 190/0、738 断言，原 OpenCode Execute 适配器 67/0、550 断言，原 leak preload 均退出 0。独立真实原 OUT-0 会话路径 `test/session/execute.test.ts` 的 `final Execute failure bounds original diagnostics and provider error text` 1/0、16 断言、退出 0。
- 原会话全文件试跑初次因隔离 PATH 缺少真实 ripgrep 而出现相关测试错误；旧回执保留。已按原 CI 前置步骤补齐本机真实 ripgrep 后重跑。相关全文件与各包型检以独立原始终态回执为准；本地 Read 全文件两臂共见的资源检查失败保留 R20 原记录，不改 preload。
- 原暂存区规则 4 文件、0 错误、0 提示，Git diff check 通过。基于 R20 已记账口径 E=408、C=63。额外中文说明解释为什么全空槽仍成功且不调用回调。正式原 Gate、A/B、完整实机和独立实现审计仍按 §18 验收。

### R23 实施与验证

固定原需求基线及发布基线均保持。相对冻结 R22，实际只改同一 canonical Plan、`packages/codemode/test/codemode.test.ts`（后像 `95e0201c97f802b7094303a425305cbc0d529059`）与 `packages/codemode/test/promise.test.ts`（后像 `54940fa005366991c62eb1addfa31ac8cda2a7d4`）。其他路径逐 blob 等同 R22，产品行为不变。包括 Plan 共 22 文件；21 个非 Plan 路径相对发布树 +548/-160，完整差分另附。源码和测试差分 SHA-256 `71282a95c66e93da4b009bcd6ad74f244a5f34bad651681c8f1d2b106273b78e`。原有效行口径中，这两个测试剔除 27 个新增实质行与三处随夹具删除的说明，累计 E=381、C=60，阈值 58。

- 原 R22 实施审计 BLOCK 原文仍见 §24，摘要/来源及全部永久测试映射见 `permanent-test-map.md`；同一原调用在固定需求基线与 R22 均通过，移除三条 shape 专用断言和其专用样本、双绿 sort 对照和空置替代负向。保留达成目标的原测试和 off-tree 对照，原测试数不变。R22 的原 Execute 全套历史结果 80/0、776 断言、162.72 秒，原日志 SHA-256 `94e4c3ab395bdbd9243dd675dea4fac526686de5ebbc01109fc26ad7e88a57ab`；较短外层期限的原始失败回执并列留档。
- 用同锁 Bun 1.4.4、真实 rg 15.2.0、私有 loopback 与 XDG 及原 `leak-preload.ts` 验证实际 R23。CodeMode 原两文件 190/0、734 断言、自然退出 0，日志 SHA-256 `9efcd0dbf5cefcb2f7e3659b516c3ad738d78413524d6604a70923cde226dab8`。Session Execute 原全文件 80/0、776 断言、自然退出 0，`Ran 80 tests across 1 file. [161.83s]`，保留原 OUT-0 及同一真实长用例；日志 SHA-256 `a36af057bb2a05fbdc4682f27489a664294d67a321b4149d7fc6819b9c98ab22`。仅用 300 秒外层保护，不改用例计时。
- 原暂存区静态检测 6 文件、0 错误、0 提示，`git diff --cached --check` 通过；CodeMode、Core、OpenCode 三包各用原 `bun run typecheck` 自然退出 0。现行正式原 Gate、同一提交完整 A/B、发布构建和实机、独立实现审计与持久化仍按 §18 验收。

## 24. Implementation Audit Record

### R28 独立实现审计裁决（原文）

第一轮、完整原需求及 24 条实际路径；独立实现审计稿 SHA-256 c06ac4bf0f655f0ed04cf0e8a771dd04999ffb6210f823bb2f29e6ad33196505。

<details>
<summary>R28 独立实现审计原文</summary>

# R28 独立实现审计：BLOCK

## Blocking findings

### B-01 OpenCode 全包类型检查未完成

- **违反的约束：** R28 §18 要求在 `packages/opencode` 运行原 `bun run typecheck` 并通过。
- **证据类别：** observed + contracted。
- **执行路径：** 原包脚本启动锁定的 `tsgo --noEmit`。候选进程被 `SIGKILL`，外层退出 1，无类型诊断。
- **源码与回执：** `packages/opencode/package.json` 的 `typecheck` 脚本；`r27-opencode-typecheck-serial-receipt.{log,exit}`；R28 §23。
- **责任归属：** 验证环境及正式发布门禁。没有定位到候选源码的类型错误。
- **具体后果：** 缺少当前精确实现的全包类型检查通过回执，不能标记 `verified`。
- **基线对照：** 干净发布基线 `6dd9a5b1…` 使用同一锁、检查器与命令也被 `SIGKILL`，证明本地中断并非候选独有。未用不同的原需求基线替代该环境对照。
- **最小修正：** 在能完成全包检查的环境重放同一冻结差分，使原命令自然退出 0；不缩小检查范围。

## Non-blocking findings

实现记录中的类型失败分类准确。没有把旧提交的绿灯、无诊断的中止或局部检查当成当前全包类型通过。

## Follow-up

干净发布基线和候选的完整 WebUI 嵌入构建同样因 `@opencode-ai/client` 未导出 `./promise` 失败，拥有该接口的路径无差分。按 R28 §18 保留独立后续事项，不算候选回归，也不算完整构建通过。

## Rejected speculation

不把进程收到 `SIGKILL` 推断为源码类型错误，也不把系统全局 OOM 计数当作该进程的确定死因。

## Requirement and traceability coverage

核对了 24 个实际路径，包含 16 个生产文件、7 个现有测试文件和唯一 canonical plan。23 个非计划路径的 full-index 差分重算 SHA-256 为 `2144fe9fc15901568cea34eefdafecd453a59e6ec515a3269690e43e92f5f702`；`git diff --cached --check` 通过。原 Session 整文件实测 80 项通过、777 条断言、163.61 秒、退出 0。已核对 Read/Grep/Shell、数组回调与执行配额、工具目录、MCP 与插件输出投影、TUI 资源生命周期的变更路径；未独立重跑全部测试。

## Primary-path and fallback verdict

工具原调用、权限和声明校验仍沿原路径。表示层只在已批准的深度或形状拒绝时交付同一次调用的文本；未引入重试、替代执行或第二数据源。可信 MCP 结构只在深度分支转换为完整 JSON 文本。

## Code quality verdict

实际差分在批准范围内，生产差分为 +386/−162；未发现须扩大实现范围的证据。OpenCode 全包类型门禁尚未通过。

## Release verdict

**BLOCK。** 在精确冻结树的原全包类型检查完成前，不得标记 `verified` 或发布；最终提交绑定的原发布 Gate 仍须验收。

</details>

保持 implementation-audit-required；不把同样发生在基线的资源中断视为绿。原 scope 的确切再次验证仍是放行条件。

2026-11-24：为完成 B-01，用户确认本次将同一冻结候选推至既有 #5 分支，仅用于原 GitHub Typecheck 验证。此单次流程例外不改生产和测试差分；状态仍为 implementation-audit-required，正式门禁照旧，最终合并由用户决定。

R7 原方案审计 B-06 见 §22。R8 方案审计 BLOCK B-07，未实施。R9 方案审计 BLOCK B-07，未实施。R10 仅交独立方案审计。

### R10 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

隔离回执证明了方案行为。正式冻结安装、同 SHA 原 Gate 和原生终端验收仍按 R10 执行。

## Follow-up

保留实际补丁、冻结安装产出的 renderer chunk 与最终 Gate 回执的哈希对应关系。

## Rejected speculation

无需加测试等待、改变帧间隔、修改 Gate 或另开计时器 PR。

## Requirement and traceability coverage

核对了 exact Plan SHA-256 `551a100723aa56378ef167f77f6483017b84716cfc5a268de423706477e9bccd`。重跑活动渲染、暂停恢复、`nextTick`、原切换会话与 preview，均通过。独立复跑上一轮 B-07 的触发路径：待处理句柄由 **1 → 2 → 1** 改为 **1 → 1 → 0**，销毁后 `hasScheduledRender=false`。B-07 已关闭。R10 保留原功能与 SLOT-1、EXIT-1、SCROLL-1，并明确保留 B-06 的原 Gate 发布条件。

## Primary-path and fallback verdict

一次帧的活动身份与句柄留在原 renderer 所有者。启动接替、挂起和销毁共用撤销路径；旧回调只检查原记录，不会结算新帧。无备用成功路径。

## Release verdict

**APPROVE**。仅放行上述哈希对应的 R10 方案；实现与发布仍须独立验收。


### R19 首轮独立实施审计（原文，内部路径已隐去）

完整独立审计原件 SHA-256 `a6577a1a35d73964c662befff266196118afc6210df4f18972621edc9a1ac933`。

## Blocking findings

### B-01 渲染器把内部调度对象返回给公开布尔字段

- 违反约束：R19 §7、§10 的 RENDER-1 要求只调整一次帧的内部身份，保留现行接口。`renderer.d.ts:75–79` 明确声明 `hasScheduledRender: boolean`。
- 证据类别：observed。使用真实 OpenTUI renderer，在正常 `requestRender()` 后、即时回调执行前读取 `getSchedulerState()`。准确 6dd 基线返回 `true`，退出 0；候选树 `5801442313f6aef41dcabdaa8b625d3349a0937a` 返回 `{}`，退出 1。两臂都在第 0 帧。原始脚本和回执在 [已隐去内部路径：R19 首轮公开 getter 对照原始脚本与执行回执]。
- 首次分歧：实际补丁 `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 中 `getSchedulerState()` 直接用 `||` 返回 `this.updateScheduled`。补丁后的 `index-b5dpwnes.js:7865` 因此在即时帧排队时返回身份对象。
- 影响：公开 API 的调用者用 `=== true`、深比较或 JSON 输出检查待调度状态时会收到错误类型。现有滚动测试只在 idle 后读取，未覆盖待调度状态。
- 最小修正：在 renderer 的公开 getter 中把身份判断写成 `this.updateScheduled !== null`，保留内部身份比较；用同一真实调用重跑对照。

## Non-blocking findings

无。

## Follow-up

修正后重审完整实际差分。准确候选仍须完成原冻结安装、包类型检查、原 Gate 和完整 A/B、真实终端与恢复重放。依赖正式线上环境的验证继续使用已授权的现有 #5。

## Rejected speculation

历史 compact CPU 红测属于 `57a→86fc`。本轮原 A/B 才能裁定当前候选。

## Requirement and traceability coverage

核对了 21 路径、对象树、完整差分及相邻证据清单。审计覆盖 Execute 预算与解释器数组、Shell 结构化正文、Read 分页、长 ripgrep 记录、Task 公示、TUI 生命周期和实际 OpenTUI 补丁。Gate、基准脚本、锁和 Session 路由与 6dd 基线一致。

## Primary-path and fallback verdict

保留原工具、解析、权限和渲染路径。B-01 的修正归唯一 renderer owner。

## Code quality verdict

补丁需要在公开 getter 中保留布尔投影。已记录的红绿和选测可用于对应路径，当前正式验证未完成。

## Release verdict

**BLOCK**，适用于 R19 实际差分 `11ed692adf05ed1bf63dc489a26f4e0174c166b6f212c14fe14b57e7e024ebb9`。


### R19 第二轮独立实施审计（完整原文）

## Blocking findings

No blocking findings.

B-01 已关闭。用真实 OpenTUI renderer 独立重跑，即时帧排队时，`getSchedulerState().hasScheduledRender` 恢复为布尔值 `true`，退出 0。原样重放补丁所得字节与实测产物一致。

## Non-blocking findings

补丁首个 hunk 的 `index` 行记录后像 `bd86b4e`，严格重放产物的实际 Git blob 前缀为 `1d4581e`。普通正向、反向检查及独立应用均通过。验收记录应引用实际产物哈希。

## Follow-up

用同一候选完成原冻结安装、包类型检查和发布构建、原 Gate、完整 A/B、真实终端及恢复重放。沿现有 #5 取得正式回执。

## Rejected speculation

历史 `57a→86fc` 的 compact 红测按原 SHA 留存；当前候选由本轮完整 A/B 判定。

## Requirement and traceability coverage

核对准确 21 路径。上一轮到本轮只改 Plan 回执和公开 getter 的布尔投影；其余 19 条产品和测试路径字节不变。Gate、基准脚本、锁及 Session 路由保持 6dd 原样。

## Primary-path and fallback verdict

继续由同一 renderer 管理一次帧身份。公开 getter 只报告调度状态，没有第二条执行路径。

## Code quality verdict

修正保留原公开类型和内部身份隔离；即时回调和连续帧接替的原对照均通过。

## Release verdict

**APPROVE**：准确 R19 实现树 `06488703535edcea81c5f95fdfdf7f9ac6985fb7` 可推进至现有 #5 的正式验证。差分 SHA-256 为 `eaf852e24ac30aa36aa40fbf6ec4b0abb704263bbabe00aebc666411b7a087db`。合并就绪待上述正式回执。

登记：原发行包严格应用该补丁后，实际 `index-b5dpwnes.js` 的 Git blob 为 `1d4581e` 开头（精确产物，不使用补丁第一段的中间 postimage 前缀）。独立实现审计已放行正式验证；完整验证按 §18 记录。

### R20 独立实施审计（逐字）

报告原件 SHA-256 `16720affc7c5023068cbb2eab1ea9e4b4a7f3549140a6c73c10c14bb924f7eff`。

## Blocking findings

### B-01 稀疏数组原本成功的 `reduce` 和 `reduceRight` 现在会报错

- **Violated invariant:** R20 §7 明确保持已有可接受输入，不新增拒绝。
- **Evidence class:** observed。
- **Producer and execution path:** CodeMode 中执行 `const a=[]; a[1]=7; a.pop()`，得到长度为 1、没有元素的数组。调用不带初值的 `reduce` 或 `reduceRight`，进入修改后的稀疏数组归约分支。
- **Source evidence:** 原始需求基线和 6dd 的 `packages/codemode/src/interpreter/runtime.ts:2816–2849` 只拒绝长度为 0 的数组。实际候选跳过空槽后，把长度非零、但没有实际元素的数组也判为错误。
- **Canonical-plan evidence:** §1 最新用户原话、§7、§15 的 JS-3。
- **Responsibility owner:** CodeMode 的数组归约分支。
- **Concrete behavioral consequence:** 用相同 Bun 1.4.4 和真实 `CodeMode.execute()` 实测，两条调用在 6dd 均成功返回 `null`，在准确 R20 均返回 `ExecutionFailure`。两边均确认数组形状为 `[1,false]`；显式传入初值 `5` 时两边均返回 `5`。
- **Pre-R1 baseline behavior on the same path:** `0ab20fa8` 使用同一长度判定；6dd 的成功结果已有实际对照。
- **Round basis:** strict class。本轮明确重审新增拒绝，且实际完整差分保留了这条拒绝。
- **Minimal correction direction:** 保留真正空数组的旧错误；长度非零但全是空槽且未传初值时保留旧成功结果。用同一现有数组测试覆盖正反向归约。

## Non-blocking findings

V1 Read 完整文件的 84 个业务用例全部通过。候选与准确 6dd 均在原泄漏预载发现相同的 20 秒、10 秒句柄并退出 1，保留原回执，不记为全文件通过。

## Follow-up

修正归约边界并重审完整差分。正式 Gate、A/B、真实应用验收及空目录恢复继续按 §18 执行。

## Rejected speculation

无需改变数组预算、回调准入、V2 Read、现有合法错误或 Gate。正式失败范围只落实到无初值的正反向归约。

## Requirement and traceability coverage

核对了准确基线、批准方案及 22 路径实际差分。V1 Read 原硬错误已转为成功截断页，机器与展示均无自指游标、不登记已读；真实窄测 14 条断言通过。V2 默认输出逐字保持，三个包类型检查通过。CodeMode 原 190 个用例通过，独立精确对照补获 B-01。

## Primary-path and fallback verdict

Read 和调用分派仍走原有主路径，没有重试或备用成功分支。稀疏归约需恢复上面的旧成功合同。

## Code quality verdict

完整差分 `git diff --check` 通过；拟议返工只需触及现有归约分支和已有数组测试。

## Release verdict

**BLOCK**。适用于 R20 实际差分 `fc0c43d9b8881f5d6901730b4cf67fea7a9f6ecf4f546bab689284f6039551fc`，候选树 `045411e1976c59eb44fcba0e8b699ad26c7119af`。

### R22 独立实施审计（逐字）

## Blocking findings

### B-01 正式差分仍保留三条只检出中间退化的断言

- **Violated invariant:** 用户明确要求新增回归断言能检出 pre-R1 已存在的问题；只检出中间方案问题的断言须撤回或改写。
- **Evidence class:** observed。
- **Producer and execution path:** `accepts render-only JSON Schema input and omitted output` 将普通字面量和索引赋值生成的数组分别送入真实 JSON Schema handler 和 raw `ToolRuntime.invoke`，校验自身键、长度和值。
- **Source evidence:** `packages/codemode/test/codemode.test.ts:778–805` 新增三条断言。原 `tool-runtime.ts:322–335,771` 的默认出站复制已保留真实空槽；pre-R1 `runtime.ts:2978–2980` 已把字面量省略项保存为显式 `undefined`。
- **Canonical-plan evidence:** §1、§15 JS-5、§18 R22 测试保留边界和 §23 的 R5 B-05 三臂记录。
- **Responsibility owner:** CodeMode 正式回归测试。
- **Concrete behavioral consequence:** 对精确 `6dd9a5b` 和 R22 源码分别运行同一封存测试后像、Bun 1.4.4 和原泄漏预载，两臂均为 1 通过、7 条断言、退出 0。三条新增断言只防止已撤回的中间出站密化。
- **Pre-R1 baseline behavior on the same path:** 核对官方 `0ab20fa8` 的解释器和 `tool-runtime.ts`，两文件与 `6dd9a5b` 字节一致；原路径已产生相同形状。
- **Round basis:** 原始需求补充了测试保留规则；完整实际差分仍保留这三条断言。
- **Minimal correction direction:** 同步修订 Plan，将三条出站形状断言及其专用夹具移回仓外，保留原测试及能检出基线缺陷的公开结果 `null`／JSON 往返断言。

## Non-blocking findings

补齐真实 ripgrep 后，原 Session Execute 全文件打印 67 条通过记录，外层仍以 124 退出，未给出 Bun 终态摘要。原 OUT-0 单例独立退出 0。两条回执分别登记，全文件仍待正式验收。

## Follow-up

按修订后的 Plan 重审完整差分。正式 Gate、A/B、真实应用验收和空目录恢复仍按 §18 执行。

## Rejected speculation

无需改变 `copyOut` 的默认宿主行为、数组调度、预算或权限。测试整改限于 B-01 对应的三条断言及专用夹具。

## Requirement and traceability coverage

重算了基线到候选的完整 22 路径差分。相对封存 R20，只有原归约分支和 Plan 改变；R21 的双向临时断言已撤回。实际双向原输入均恢复成功，真正空数组的错误保持。CodeMode 原两文件 190 通过、Execute 适配器 67 通过、OUT-0 独立通过，三个包的类型检查均退出 0。

## Primary-path and fallback verdict

归约仍在同一个分支内完成。真正空数组沿用旧错误；正长度全空槽扫描后返回 `undefined`，沿原公开边界投影为 `null`。没有备用成功路径，也未更改 Read、Shell 或 TUI 的既有修正。

## Code quality verdict

`git diff --check` 通过，实际归约修正仍在原 owner 内。B-01 的测试及专用夹具超出用户保留范围。

## Release verdict

**BLOCK**。适用于 R22 实际差分 `6877f10de53f4e90f917f2ec050862724552745019cba31e8d4c51e27b5edc86`，候选树 `94e89c2450433e276dae894f96490eeb58a48658`。

### R23 独立实现审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Follow-up

按 §18 用正式单提交跑原 Gate 和 A/B，完成发布构建、真实应用验收和空目录恢复。当前裁决放行已审实现，正式门禁回执另行登记。

## Rejected speculation

无需修改宿主参数投影、数组归约、权限或 Gate，也无需用另一条基线已拒绝的输入替代撤回的 Promise 断言。

## Requirement and traceability coverage

重算了固定发布基线到候选的完整 22 路径差分。两个测试后像与 R23 方案验证版本逐字一致，其余产品与测试路径保持 R22 后像。R22 的 B-01 已关闭：三条只检出中间密化的断言及其专用夹具已移除。排序快照转为仓外验证；保留能检出原基线缺陷的公开 `null`／JSON 往返、Array 构造、mapper 和受限回调断言，以及原 Promise 不透明性检查。CodeMode 两文件 190 通过、734 条断言；Session Execute 全文件 80 通过、776 条断言，161.83 秒。两组均用原预载自然退出 0，三个包的类型检查均退出 0。

## Primary-path and fallback verdict

本轮只收敛测试。原归约保留真正空数组的错误和正长度全空槽的成功结果；默认宿主投影与公开 JSON 投影继续走原路径。未增加模型拒绝、重试或备用成功路径。

## Code quality verdict

`git diff --check` 通过，原暂存检查 0 错误、0 提示。无新增测试实例；删掉的 import 和夹具只服务已撤回的断言。

## Release verdict

**APPROVE**。批准精确 **R23 实施差分**，SHA-256 `d40819137f6acce1489e24dad62ebf7748924f372e38b30bd9714e41646ed83b`，候选树 `16309378424442c5ec4783bc5f62146ac6bffc86`。最终发布仍按 §18 判定。

R23 独立实现审计已批准上述精确差分。当前只登记裁决，代码和测试保持已审后像。状态仍保留为 `implementation-audit-required`，待 §18 其余验收完成再登记 verified；正式同一提交原 Gate、A/B、发布构建及真实应用验收均待回执。

### R31 full-scope independent plan audit

Audited plan SHA256 `c89789cbb9053a0d726d7e9510f53fc37876ff7ddd419a48b1604a86b24392e3`; verbatim verdict SHA256 `eed02b9a5b9c3c91a93ac5ee21959b8b2128f8b3c99a31f0fea71b2e501ba955`.

## Blocking findings

No blocking findings.

R30 的 B-01 已关闭。独立重跑原公开 CodeMode 探针，精确 R31 runtime `11fac7780f7ca2519e8f16e7b99fe549f4b00f53` 与原基线的旧输入结果一致：map 回调两次并返回两个值，filter/flatMap 保留旧空槽语义，some/every 保留原布尔值，forEach 回调两次，sort/toSorted 的可枚举键与旧行为一致。未增加数组来源分派或备用路径。

## Non-blocking findings

§10 的 R30 归约段末句「map/filter 等其余集合消费……不变」建议标为 R30 历史范围。该节 R31 段及 §18 已清楚写明当前目标和这些消费者的原路径恢复，无需重新设计。

## Follow-up

无新增项。

## Rejected speculation

不要求为新增 Array 构造选择独立的 map 消费语义；原用户要求是支持构造和回调，已有数组消费者共用原规则。也不要求把原基线已通过的兼容性探针作为新增正式用例。

## Requirement and traceability coverage

复核固定原需求和发布基线、完整 24 路径、R31 四个同范围后像及原 Guard 窄查。现有构造测试仍可检出固定原基线缺少 Array 构造；R31 修正该既有用例的来源键和映射键，未另增测试实例。Read、目录、权限、执行预算、RG/Shell 及 TUI 资源的原验收仍须执行，局部绿不算发布放行。

## Primary-path and fallback verdict

批准在同一解释器消费和排序入口恢复原行为，并保留新增受限回调和 Array.from。Read 的续页决定和目录的签名表示继续使用各自现有 owner；没有新备用成功路径。

## Release verdict

**APPROVE**。完整范围方案审计仅适用于精确 R31 `c89789cbb9053a0d726d7e9510f53fc37876ff7ddd419a48b1604a86b24392e3`。这不是实现审计或发布放行。

### R32 full-scope independent plan audit

Audited plan SHA256 `7ce921071721bcfd7c81ba426665c030548ae0b498dcae212cc1d86b337fcdc7`; verbatim verdict SHA256 `ccafbeacc32e89ce2ce10bf46640b1de937ab5227c082119ad9d9d83a5d58e79`.

## Blocking findings

No blocking findings.

## Non-blocking findings

无新增项。§17 保留的 R31 注释计量是历史数据，不作为 #5 验收结论。

## Follow-up

无新增项。

## Rejected speculation

不将 #1 的「每处 hunk 中文注释、全 PR 超过 15%」推及 #5。独立读取原指令及同一轮用户指定的分支和草稿 PR：该事项追加到 `execute-async-flow` 的 #1。当前 #5 原文保留逐 hunk 必要性、收敛增量及原 Gate。仓库 Comment Rule 继续约束就近中文注释的必要性；原政策和 Guard 未发现对应比例门槛。

## Requirement and traceability coverage

复核固定原需求基线及发布基线、完整 24 路径及 R32 变化。单独索引把当前非 Plan 路径投影为 `c471065082aabd61443912385f54c68dd9f4d40c`，与 R31 审过的代码/测试树完全一致，差分为空；对固定发布父的 diff check 通过。R31 关闭的 B-01 以及已核对的 Read、目录、权限、预算、RG/Shell 和原生终端行为未改变。保留已有测试、原 Gate、同提交正式 CI、独立实现审计和实机/空目录验收。

## Primary-path and fallback verdict

仅修正 Plan 对历史注释要求的适用范围。执行、表示、数组和渲染路径未变；没有新增备用成功路径或放宽 Gate。

## Release verdict

**APPROVE**。完整范围方案审计仅适用于精确 R32 `7ce921071721bcfd7c81ba426665c030548ae0b498dcae212cc1d86b337fcdc7`。这不是实现审计或发布放行。

### R32 第一轮独立实现审计（原文）

完整范围 R32。审计输入 Plan SHA256 `e7bb2e2969ddf9f063f0cae564cf9e74191820250e288cf2235f003b5cc982df`，实际固定父差分 SHA256 `05cdc4f5a3e4218defbf5f87f1beda5908c04f2ef02eaa9ba3efb9bdc5e91e92`；原文 SHA256 `c98da62d1d9a9e0cae0c97d4248cfb3b3531e5a6905f08cb2c328ec23df39e44`。

## Blocking findings

### B-01 Read 注释误称仍有整页 token 估算

- Violated invariant: READ-3；仓库 Comment Rule 禁止注释描述未发生的行为。
- Evidence class: contracted。
- Producer and execution path: V1 普通 Read 和 Execute 的同一工具先将 `firstLineAdmitsBytes` 交给共享 parser，再调用 `readPageContent` 形成结果。该回调仅在第一行超软窗口时参与准入。
- Source evidence: `packages/opencode/src/tool/read.ts:105–118,578–579`；`packages/core/src/tool/read-lines.ts:89–93,155–159`。固定父至实际后像的差分新增「首行与整页共用现有 token 估算」，同时删除整页的 token 估算与拒绝。
- Canonical-plan evidence: §10 READ-3、§15 Read 及 §17。
- Responsibility owner: V1 Read 的首行准入调用点。
- Concrete behavioral consequence: 注释将已撤去的整页 token 路径描述为仍参与准入，误导读者判断在普通分页何处拒绝输入。实际没有第二个调用者；整体仍按原字节窗口分页。
- Pre-R1 baseline behavior on the same path: 原 V1 对拼接后整页估算；没有现行首行回调。实际后像只有首行估算。
- Minimal correction direction: 删除这条误述，或只写首行沿用原 token 阈值，不改行为。

### B-02 要求的类型检查未通过

- Violated invariant: REL、§18 的原包级类型和完整验收；实现审计对必过验证适用 Code-Quality Gate。
- Evidence class: observed。
- Producer and execution path: 同源冻结安装工作树执行原 `bun run typecheck`，OpenCode 单包和整仓检查实际启动 TypeScript 子进程。
- Source evidence: `package.json`、`packages/opencode/package.json` 的原 typecheck 入口；同源 `typecheck-attempt4.exit/log` 与 `package-controls/opencode/typecheck.exit/log`。
- Canonical-plan evidence: §18 完整发布放行及 §23 R32 类型验证。
- Responsibility owner: 执行检查的实际构建/验收环境。
- Concrete behavioral consequence: 第四次整仓串行及 OpenCode 单包都退出 1，日志显示子进程 SIGKILL，没有 TypeScript 诊断。没有通过回执，不能完成所需类型验收。这不认定源码有类型错误。
- Pre-R1 baseline behavior on the same path: 无同环境完整基线 typecheck 通过或失败回执，不能把资源终止归因于候选改动。
- Minimal correction direction: 保留失败回执，在能完成编译的现有环境重跑同一原检查，以准确源树的真实退出 0 重审；不改命令或源码来掩盖信号。

## Non-blocking findings

Read 的严格 preload 后置超时及 Shell 的额外 coalescing 超时，两臂同样失败，须继续保留为原始证据。未发现它们由受审改动引起；不把直接 Read、Session Bash 或实机回执冒充相应严格检查已过。

## Follow-up

无新增产品范围项。

## Rejected speculation

不因旧 #1 注释比例或已证无变化的私有夹具结果扩大 #5 源码改动。未发现以工具输出表示跳过权限、业务失败或声明解码的路径。

## Requirement and traceability coverage

核对固定父实际 24 路径和累计补丁。R31 已关闭的数组回调、排序和归约回归仍对应同一后像；Read、RG/Shell、Task、MCP、执行配额和终端生命周期均映射到原 owner、现有用例或已记录的实机验证。阶段内保存原有测试实例数和受影响路径；stock staged 小范围检查、原生终端与可回放物都不替代最终同提交原 Gate 和远端必过 CI。

## Primary-path and fallback verdict

仍沿各自原主路径。可交付文本只表示已成功并经声明解码的同一次工具结果，未增加备用执行路径。Read 不交付首行时保留截断事实，不造续页游标和覆盖。

## Code quality verdict

源与测试后像和已批准 R32 的非 Plan 投影一致。没有新增越界生产路径；B-01 的误述与 B-02 的未通过验证仍阻止实现放行。

## Release verdict

**BLOCK**。完整范围实现审计仅针对 R32 Plan `e7bb2e2969ddf9f063f0cae564cf9e74191820250e288cf2235f003b5cc982df` 与实际固定父差分 `05cdc4f5a3e4218defbf5f87f1beda5908c04f2ef02eaa9ba3efb9bdc5e91e92`。修正 B-01、取得 B-02 的合格同源回执后重审。最终同提交 Push Gate、所需 preflight 和正式 CI 仍待执行。

### R32 第二轮独立实现审计（原文）

完整范围 R32。审计输入 Plan SHA256 `122dc1d8185e9215c09a4a9ea15845e1323754eac083a24adcc6628d4417a5f9`，固定父全差分 SHA256 `83bfa4b5662449ba8c141024a42b461a575c327874d79ad0bcd134f2f54e8c1d`，审计产物原文 SHA256 `5838c629b5c3babe82b3aa3184030c4fe8051555d2a857a7061000e6453d9718`。

## Blocking findings

No blocking findings.

- B-01 已关闭。固定父完整差分中的返工相对初次候选只删除了 Read 的一条误述注释。原首行阈值、字节窗口与后续页语义均保留。新 Read 后像跑原包 84 项通过、395 条断言、退出 0。
- B-02 已关闭。OpenCode 原包类型检查退出 0；同一冻结依赖图的整仓类型检查 30/30 成功、零缓存命中、退出 0。只改本机的资源分配和任务并发，未改任务范围或编译器参数。独立逐一对比验证树 `1060ed02954484761ca35cd84f9bbaea8301833c` 与候选产品树 `d20124a92515698f44f5069ed77405f5763b38ba` 的 23 个非 Plan 路径，Git blob 全部相同。

## Non-blocking findings

原严格 Read preload 和额外 Shell coalescing 的双臂超时记录仍保留，未当作通过；同环境固定父与候选同样失败，没有归因到本次改动。最终以批准的原发布验证继续核对。

## Follow-up

无新增产品范围项。

## Rejected speculation

不为历史 #1 注释比例、资源终止或旧夹具共同失败额外改变 #5 的源码、测试、锁或 Gate。

## Requirement and traceability coverage

已复核相对固定父的全 24 路径，空索引重放得到 `0541c909834f41a913c85bd4900c8fe2036c1d50`，与精确 Plan SHA 和送审路径相符，`git diff --check` 通过。未改变测试实例。原数组消费、Read、目录、RG/Shell、权限、执行预算和 TUI 生命周期沿已审 R32 路径；原生终端的已验证产品行为未被仅删注释的返工改变。

## Primary-path and fallback verdict

维持一条既有执行路径。纯文本投影仅承接真实已成功且经过原声明解码的同一次工具结果；未增加替代执行、绕过权限或伪造 Read 读取证据。

## Code quality verdict

本轮仅删除不准确的注释，不增加解释层、守卫或额外分支；原类型验证已取得同源通过回执。

## Release verdict

**APPROVE**。完整范围实现复审适用于精确 R32 Plan `122dc1d8185e9215c09a4a9ea15845e1323754eac083a24adcc6628d4417a5f9` 和固定父实际差分 `83bfa4b5662449ba8c141024a42b461a575c327874d79ad0bcd134f2f54e8c1d`。这是实现审计放行；最终同提交原 Push Gate、所需 preflight 及正式 CI 仍为发布条件。
