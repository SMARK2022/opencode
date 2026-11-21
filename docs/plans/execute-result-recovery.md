# Canonical Implementation Plan: PR #5 Execute 能力、预算与工具结果

> Status: approved
> Revision: R17
> Approved revision: R17
> Audit mode: full-scope
> Requirement source: §1 用户原话
> Implementation allowed: yes
> Last updated: 2026-11-21

需求基线是原 GOAL 实施前 HEAD `0ab20fa87080bd4fafd79d39b97fb082c4af8d62`。本 Plan 定义该 HEAD 至 PR #5 交付态的完整行为。发布基线是当前 dev1-smark `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0`，tree `7856a04183fb9aa562da776477c27243f8c9874f`。正式验收用该 HEAD 的原 Gate。R14（98a9f13）、R15（27f5f62）和 R16（8aead09）的重放、测试、实机及判词只按各自产物保存。此前 R5、R6、R7 仅为冻结对照，不充当需求基线或本版实施许可。目标为完整审计、验证后的单提交及可合并 PR；合并由用户决定。

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

- 最新范围原文：「这个workflow里面已经明确说了，你的那个每一个plan都要写的是从基线到现在的行为，你不要写什么从现在怎么继续去精简」。完整目标行为从原 GOAL HEAD 0ab20fa8 描述；当前发布差分从最新目标分支 5bc061b 重放。中间稿或归档树只用于对照。

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

## 2. Explicit Non-Goals

不调模型、新增宿主函数入口、提高权限、更改搜索默认超时或重写其他 PR。WebUI 不混入。Gate 原样执行；任何 Gate 失败均保留原结果，不改代码、配置、规则或执行合同，不重新启动独立 Gate/计时器 PR。旧 R7/R10 的绿灯不计作当前验证；也不追求重造一个字节不同却标为 R10 的版本。不使用机械 hunk 清单代替设计。

R8 保留既有用户功能范围，只纳入原真实路径已证实的资源所有权失配。不得改 Gate、正式测试、延时／刷新频率、协议、FFI ABI 或 native 终端构建入口；不新开专门的计时器 PR，不关闭动画、不延长测试等待、不跳过失败。渲染器选用现有 Core patch；正式源码、依赖、patch 与 lock 在批准前保持原样。

## 3. Repository Context

以本基线的 `docs/guides/workflow.md`、`.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md`、`CONTEXT.md`、相关 ADR 与各包 AGENTS 为约束。工具宿主决定权限和默认预算；解释器只承接受限值及媒介调用；结构化结果与展示文本分别由对应工具拥有；会话层只决定模型收据内容。红反馈先于实施；Plan 和实际最终差分都需独立审计。

基线分两层。历史 pre-R1 精确提交 0ab20fa87080bd4fafd79d39b97fb082c4af8d62，tree 23a93b4688c057bffa772ebb34ac9eb8b4dde91d；其子 cff9a3566988bf91082aa090029ce66c83f557f8（tree 481565810b7a6581e6880bbe8ff92915964bc3ac）已含初次完整修复，父关系和对象已从独立裸库验证。R7 §18 的父→初修对照是历史来源；本轮读取了两份精确对象和完整差分，未复跑历史程序。旧发布另有 e93b66fd8473e94fb414151af0fecbb31a299266→R7 的差分。本轮以 `git show -s --format="%H %P %T"` 重查独立裸库 pr5-original.git，确认同一提交、树和父关系；GitHub 的只读回执也确认两个完整 commit ID。需求与全量设计覆盖 0ab20fa8→完整目标；本轮实施重放、实跑和发布差分一律使用当前目标 5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0→完整目标。0ab20fa8 的历史程序本轮未重跑；0dfffcda 和 0b5754df 仅标识旧回执，既不充当实施基线也不充当正式发布基线。相关三个文件在原需求前像和当前发布前像逐字相同：Toast owner blob fdacec41，Session route blob cf30a49d，app-lifecycle 原测试 blob a885e68e。

两个基线的修改前像逐文件相等，Git blob 短码如下；等价覆盖整个文件，故也覆盖表内每个 hunk 的前像。

| 修改 / 保留 | 两侧相同的 owner blob |
| --- | --- |
| JS-1…5、BUD-2 | codemode/src/interpreter/runtime.ts 7ce693b5；model.ts 1dc55c89；codemode.ts ff0b3053；stdlib/math.ts cc8dd067；tool-runtime.ts b9a22c4b |
| BUD-1、VIS-1、VIS-2 | opencode/src/tool/code-mode.ts 315d90f4；codemode/src/tool.ts 6c9fbf2a；core/src/tool/task.ts 8081ade0 |
| READ-1…3 | core/src/tool/read-lines.ts a6686858；opencode/src/tool/read.ts 643a0d7a |
| RG-1/2、SH-1、OUT-0 | core/src/ripgrep.ts 3354caaf；opencode/src/tool/shell.ts e6eefc1a；opencode/src/session/tools.ts 87738049 |

既有测试中，codemode 三文件、core ripgrep/tool-read-filesystem、opencode read/shell/code-mode/task/registry 均逐字相同。不同前像：core session-runner 行 1705 仅把 Git 提示标识由 Git repository state changes 改为 Git and GitHub（73242ed5→dd3897b1，与 Task 广告无关）；opencode execute 测试行 1771/1782 调整另一取消夹具 1000→5000 ms 和 join 10 秒（83b92763→ce9ede8d，不是本次用的最终失败回执）；排除的 TUI voice 在 0dff 已有另一套按 origin 转交的探针处理（2353faf7→5a3ef5af）；bun.lock 两侧只改工作区版本 1.19.17→1.19.18-smark，本轮正式验证按 5bc061b 的锁运行；锁与 27f5f62、98a9f13、0b5754df、0dfffcda 保持同一字节。上述一致性只用于定位历史 0dff 动态结果对应的生产前像；运行目录、夹具、锁文件及整条旧提交的实际执行仍只按各自已取得的证据记，不以源码相等声称重新跑过历史测试。

## 4. Files and Evidence Read

| 证据 | 来源 | 证明范围 |
| --- | --- | --- |
| 固定目标 | 本工作树 HEAD `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0`，tree `7856a04183fb9aa562da776477c27243f8c9874f` | 当前源码、owner、Gate 及发布差分；旧基线运行只用于历史回执 |
| 最新 Gate 及产品上下文 | 8aead09→5bc061b 的三个原提交；HttpApi exerciser、Core SessionRunner、原 Guard workflow；§18 当前运行 | 13 条上游路径与 #5 的 22 条无交集。Auth 已有上游 cleanup owner；Core 原后置检查仍红，分别跟踪 |
| 旧工作版本 | `e93b66f→1d799bca` 已发布历史；独立三文件差分恢复 R7 树 `d6ca3355f3af78d4581cffa2cc134a332ee270f2` | 旧设计来源，非当前批准 |
| 真实 rg 输入 | 本地真实 rg 输出 70,216 B 的合法结构化记录 | 原生生产者共输出三条匹配；另以同一夹具执行当前 core adapter 红测 |
| R10 历史回执 | 工作记录留有真实 PTY、审批 worker、原包类型检查及 WebUI HTTP；精确源码/Plan 工作树已缺 | 行为参考，不能转记为今天的通过 |
| 逐 owner 静态读取 | core ripgrep 与 read-lines、opencode shell/session/tools、codemode runtime、host、工具目录 | 下列分歧和计划 seam，未执行 |
| TUI 原 Gate 红与隔离诊断 | packages/tui/{src/app.tsx,src/routes/session/index.tsx,src/context/{sdk,sync}.tsx,src/ui/toast.tsx,test/app-lifecycle.test.tsx,test/fixture/tui-sdk.ts}；locked OpenTUI Solid mount/dispose；stock script/guard/leak-preload.ts；第 18 节回执 | 验明异步通知晚于已发生的卸载；原 Gate 捕获错误，不是清理 owner |
| SCROLL-1 独立红绿 | 固定 0dff / R6 原 preload 同一用例、Session route、原渲染 fixture、仅 owner 的隔离 overlay（§18） | 同一 50ms 资源在两固定臂缺少取消；active 控制仍对无关渲染资源报错 |
| RENDER-1…3 / SLOT-1 对照 | GitHub fork 标签与源码、固定发布包 JS、官方同 owner 源码、real SystemClock、两个原 stock TUI 用例与 Spinner 三臂、无探针私有原型（§18） | 区分 dependency owner 和 DialogSelect 渲染入口；隔离绿不等于正式载体或完整 Gate |

## 5. Current Behavior

- 当前 `core/src/ripgrep.ts` 在 JSON.parse 前按 64 KiB 单记录体积报错。
- `core/src/tool/read-lines.ts` 的两处软字节预算都能在第一完整行提交前转入辅助扫描。
- 当前 Bash 结果把用于展示的 `output` 放入 `program.value.content`，可能夹入状态提醒；另有退出码、截断、超时、落盘地址字段。
- Execute 失败收据的生产入口与旧 R7 没有该功能差异，先核验是否仅需保留回归断言。不能把静态相同误写成通过。
- 受限回调、Array、根预算与工具签名的当前分歧见第 8 节；尚未执行当前红测。

原 TUI 退出测试在两个发布对照（0dff 与 R5 冻结差分）同一位置失败：可见 Session epilogue 正确，stock Guard 报 UI 已退出后仍残留一个通知 handle。正常用户在进入会话、剪贴板操作或插件通知途中退出，同样可能有待完成的 Promise；故障无需依赖测试顺序。

SCROLL-1：原 Session 挂载和会话切换可在滚动延时内卸载；回调虽读取组件已销毁状态，仍未撤销自己拥有的资源。这与 Toast 和 OpenTUI 分别独立。

已证的全量发布链有两组独立的遗留行为：
- 固定 OpenTUI 渲染器在等待一帧、手动 renderOnce、以及销毁子树触发 frame invalidation 时，可能留下用户当前进程已不再需要的延迟帧回调。
- DialogSelect 为可选搜索栏右槽读取重复的 JSX producer，可能构造一个未挂载却已自动播放的 Spinner。挂载的另一个实例照常卸载，遮不住先前遗失的那个。

## 6. Supported Input Domain and Reachability

实际工具链调用、合法 ripgrep JSON、物理读取限额内的文本，以及现有工具返回与权限开关属于可达输入。R7 原测试中的稀疏 Array、Array.from 对象、普通内建回调、真实子工具和受限循环属于明确使用场景。无证据说明应支持任意宿主对象、this 绑定或取消已有许可。

TUI 仅涉及正常应用退出前后、仍持有通知引用的已启动异步任务，以及卸载前已显示的通知。外部 transport、请求重试、每个页面的导航规则和通知时间配置不扩展。

可达场景包括带锚点和无锚点的会话或 review 导航、正文同步后的补滚、用户已主动滚离，以及同一组件两个待运行请求。只处理该组件生命周期。

RENDER-1…3 只覆盖固定 fork 中真实 ordinary frames、手工帧与销毁流程，包含 renderer 启动、暂停恢复、销毁期间子树 detach 和在途 async frame；不引入新的渲染 API、前后台调度模式或更改 timing。SLOT-1 支持任意现有 filterAccessory JSX，包含 undefined、搜索期间活跃 Spinner 到完成切换及仍然 truthy 时的新 JSX；复用 Show 的真实 memo，不改 busy gutter。

## 7. Required Invariants

| ID | 必须保持 |
| --- | --- |
| OUT | 失败时保留已显式展示缓冲及 error，未展示的子工具正文不进入模型收据 |
| JS | 普通 JS 场景通过既有受限调用边界；稀疏洞、Array.from 读取与回调次序保持 |
| BUD | 1024 次工具调用不超发，显式循环累计上限由同一 root 所有子执行共享；100,000 为本计划选值，已按真实宿主相邻边界验证 |
| VIS | disabled background 不出现在可调用 schema；能力开启时已有语义和权限保持 |
| RG | 合法的长记录正常解析，真实无效输入仍报错，既有搜索超时与数量上限不变 |
| READ | 首个可返回的完整行在物理预算内能推进分页；其余行仍应用软预算和原 offset/limit |
| SH | 机器正文与人类展示分离；单独字段继续表示退出、超时和截断 |
| REL | 仅修改当前基线确有缺口的 owner，保留真实权限/审批与原范围，完整审计、验证、无合并 |
| EXIT-1 | ToastProvider 活跃时通知展示、替换、既有时长和到期行为维持；卸载释放仍在使用的 handle，过期的 provider 引用不再写入其 store 或创建通知 handle。Session epilogue 与退出路径保持。 |
| SCROLL-1 | 保持 50ms 与两入口的 respectUserScroll、锚点优先及贴底判断；有效任务原样触发；退出释放本路由全部待处理句柄，原实例晚到的同步不得重新安排 |
| RENDER-1…3 | 一次正延时 frame 的句柄须有 renderer 所有权直到正常触发、启动替代、显式挂起撤销或销毁；手工帧不能丢掉旧 continuous handle；对象进入 destroyed 后禁止安排新帧。现行间隔、即时帧、运行中连续帧及 native ABI 原样。 |
| SLOT-1 | 右槽按现有 truthiness 决定挂载，一个求值结果同时用于判断与渲染；已挂载 Spinner 继续按原来时长和动画策略运行并释放，加载完成只卸载原节点。 |

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

RENDER-1：固定 fork renderer.ts 的 requestRender 同 bundled :7803 非运行延迟分支未持有句柄，destroy 只能清原 renderTimeout。RENDER-2：同源 loop 先让 renderTimeout=null 再调用曾经应清它的旧逻辑，手动帧覆盖旧目标；真实 clock 请求 1 未清，destroy 只清请求 2。RENDER-3：组合前两处后，原用例仍红；独立追踪发现同一 renderer 先 cleanup（当时无 pending），root.destroyRecursively → Renderable.destroy/remove 又在 destroyed=true 时请求新帧，故取消现存和拒绝新任务都必要。in-flight callback 对照无后继 frame 调度，不给它另加实现。
SLOT-1：DialogSelect :686–689 先用 props.filterAccessory 作 Show 条件，内层又读取同一 getter；SessionList :650 生产 dynamic Spinner。原 preview 实测 start 两个 id，只 stop/destroy 被挂载的 spinner-2；未挂载的 spinner-1 留下原 scheduler interval。Spinner stop/destroySelf 本身工作正常，无需修改调度器、清理策略或增加计时器。

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

本稿描述原 GOAL HEAD 0ab20fa8 至 PR 目标的完整行为；发布基线固定 5bc061b，§15 的 21 个产品、原测试及补丁前像不变。正式验收用 R17 最终单提交，按实际候选复验当前宿主关闭和原 viewport 夹具。OUT 的真实失败路径已满足合同，作为原行为保留。SH 在机器字段使用现成有界子进程正文，其他投影保持。RG 将完整合法记录送入现有解析，保留已完成匹配与现有搜索停止条件。READ 只给 V1 第一条请求行使用现有 token 准入，parser 沿旧辅助账本读块，后续行继续用原软窗；没有任何已交付行且首行预算切断时，由 V1 现有错误通道报告且不返回自指页。JS 沿既有沙箱值和同步回调入口扩展普通 Array 和 Array.from 表达式。BUD 由宿主把 1024 和经验证的显式循环容量分别给预跑与常规入口，由解释器的独立执行根负责累计；采用已完成真宿主相邻边界实验的 100,000。VIS 只在 V1 toolTree 切换模型可见的合同；既有 Task producer 的条件裁剪、运行时参数、权限保留。独立 V2 Core Task 与 V1 不共用注册层；精确原修复与 R7 所保留的合同明确覆盖它。固定 0dff 已复现关闭仍广告，按已有 flag 在 core Task 注册处省略后台描述和公开字段，原 Input codec 和执行门禁不动。

R7 可借鉴的行为为合法长 rg 记录显示、精确 Shell 原文、Array.from 逐项读取和现有上限量级控制；只使用当轮证据支撑的最小变更。R7 无界首行捕获、重复修改 Task、备用成功、重置外层预算、旧测试总量及其他历史补丁均不进入目标。

EXIT-1 沿原 ToastProvider 接入 owner 释放。关闭标志只在 Solid cleanup 时设置，同一 cleanup 取消当前 handle；在 `show()` 入口拒绝已关闭 owner 分配资源。活跃时照旧使用 duration 参数及默认 5000 ms、既有 unref、原先到期清除显示、新通知替换旧通知。无新调用接口、无全局状态、无路由改动。

SCROLL-1 在原入口跟踪每个已有 50ms 句柄。正常回调首先移除记录，然后按原 destroyed/滚动判断运行；组件 cleanup 关闭安排入口并取消所有未触发的自有句柄。保留多个有效请求的时序和独立参数，不 debounce。

R8 完整目标保留 OUT、JS、BUD、VIS、RG、READ、SH、EXIT-1、SCROLL-1 和它们的所有测试与兼容边界，然后解决两个必要 owner：
- RENDER-1 由 renderer 用一个私有活动记录替代原有的安排布尔值和单独句柄；记录持有当前 activation 身份与可选 timeout，旧回调只能检查自己的身份，旧 async finally 只能释放自己的记录。启动替代、挂起和销毁同时撤销记录与其中仍活动的 timeout。保持 0 延时 nextTick（不增加 timer）、feed、原延迟公式和普通激活；不复用有独立生命周期的 continuous renderTimeout。
- RENDER-2 移除 loop 入口先抹掉 renderTimeout 的一句，使其原 clear 分支能处理手动帧打断时已有目标。定时器自身回调仍从此前相同位置清字段、调用 loop，不改间隔或 useThread/native 路径。
- RENDER-3 在既有 requestRender 早退判定纳入 _isDestroyed，拒绝子树 detach 在 destroy 后重建资源。该约束也由官方 OpenTUI 现行所有者采用；不迁入官方新 scheduler/native Session。
- SLOT-1 保留同一 Show truthiness 与布局，但消费其已有 memo 参数 accessor 作为唯一渲染输入，不重复取 props.filterAccessory。保持原动态内容的更新和卸载。

## 11. Secondary and Replacement Path Inventory

原超时、原权限、原物理预算、原 parser 错误分支、既有可见性开启选项均保持。没有拟定新的 fallback、开关、数据源、局部绕过或强制退出。外部诊断仅供验证，不提交。

EXIT-1 不在测试 fixture 增加 /session/dummy 来遮住迟到通知，不在 Guard 排除 timer，也不延长或压短通知。绑定 owner 的同一入口覆盖真实通知的全部现有生产者，无另行重试或接管。

SCROLL-1 沿现有回调，无备用路由、额外测试等待或调整超时。保留既有 destroyed 判断，同时在 owning Solid cleanup 释放资源。

RENDER 唯一发布载体是已登记的同 #5 Bun core patch；现有实验只验证补丁行为，正式冻结安装与完整 Gate 是实施放行条件。等待 idle、切换 preload、忽略泄漏及临时修改安装目录全部只用于诊断或者禁止作为交付。SLOT-1 不以 animations_enabled=false 等掩盖错误。

## 12. Workaround Deletion and Replacement

若实测成立，删除 RG 单记录前置拒绝与 SH 展示正文误复用；保留 Read 的两类已有预算，仅纠正首行归属。JS/BUD/VIS 证据未全部核验前不指定旧规避方案的删改。不得用增大超时来掩盖行为红。

## 13. Forward Traceability

| 需求 | 已有入口、缺口与最终验收 | 全量目标修改索引 |
| --- | --- | --- |
| OUT | V1 Registry → SessionTools → processor → 模型及恢复文件，0dff 隔离宿主 19 断言已验证；保留已展示日志和错误，不串入未显示正文 | OUT-0 |
| SH | V1 Shell 原空成功/exit 7 两组真子进程；当前夹具 2 红→2 绿，对机器正文逐字断言，保留展示和状态 | SH-1 |
| READ | V1 Read tool → 共享 parser；21,000 B 首行、下一页、展示、零进度错误与未终止输入/outline 控制；固定 HEAD 真宿主已同夹具红绿，正式差分回归待跑 | READ-1/2/3 |
| RG | 原生 rg → core adapter → 结构化匹配；固定基线 70,216 B 红，旧 R7 正对照；真实 core 当前候选和 partial/abort 等既有停止控制均已通过 | RG-1；RG-2 零改动 |
| JS | CodeMode 解释器现有数组用例：回调绑定与逐项读、稀疏洞、array-like 长度读取时机、数组构造；固定 HEAD 完整组合的各项反馈及状态见 §20/23 | JS-1/2/3/4/5 |
| BUD | V1 host fixture 实测原正式阶段调用 1025 次，预跑受限；对照同轮 1024 次、嵌套/并发循环及下轮重置；工具及跨函数循环限制真宿主均已红绿 | BUD-1/2 |
| VIS | V1 Task 注册 → toolTree → 目录、说明、search、建议 → 已有真实解码与权限；实际 producer 开关 2/2，真实 V1 host 搜索、解码、权限收据红绿；V2 实际注册 materialize 已红绿 | VIS-1/2 |
| REL | 从固定目标重新对齐；原 Gate 未改，测试不扩张，独立方案与实现审核，通过后交付单提交，保留合并决定 | 适用所有索引 |
| EXIT-1 | 原 Gate + 可合并版本要求 → TUI app.exit → renderer destroy → Solid owner dispose → ToastProvider；原 app-lifecycle 退出用例及 stock 两文件选择原样通过；另用仓外活跃通知验证 | EXIT-1 |
| SCROLL-1 | 原 Gate + 可合并要求 → Session 的 async sync 和 route/review effect → 原 scheduleSessionOpenScroll → 同一组件销毁。原 partial glob 窄红绿、原切换贴底与两句柄对照 | SCROLL-1 |
| RENDER-1…3 | REL 原门禁 → auto-review-render 原 active switch → owner clock / detach → pinned OpenTUI renderer；正式目标需证明同原入口＋普通帧＋真实编辑器暂停恢复＋live/显式启动＋async destroy | 现有 core patch；安装按 §20 的正式验证顺序 |
| SLOT-1 | REL 原门禁 → session preview 原用例 → DialogSelect 的 Show 不重复读取 slot → 挂载 Spinner 按原生命周期停止；active search/错误收尾证明保留行为 | SLOT-1 |

## 14. Reverse Traceability

下表 Hunk 为人工划定的最小职责边界，不是从归档或临时 diff 导出的行号表。实现时每个实际 hunk 均须对应此表；没有映射的修改撤回，待证项不算放行。

EXIT-1 的新概念只有「通知 owner 已卸载」。路由 ID 与 SDK abort 都不是该通知资源的所有权信号；复用 Solid cleanup，现有 timeout 应由该 owner 单独释放。此映射来自原发布门禁同一红点与真实卸载后行为，不增加 PR 的工具功能。

SCROLL-1 的闭合信号来自该组件，不来自可变会话 ID 或 SDK。多个并行句柄实测出现；现有 scroll.isDestroyed 只能避免写入，不能取消句柄或阻止卸载后的 async 分配。

RENDER-1/2/3 三个概念分别对应可观测的迟到句柄、被抹掉句柄和销毁后重新分配。SLOT-1 只复用已经持有 Show 条件求值的 API。各有独立 red/green；不将经过的库、路由或配置自动纳入。

## 15. File-Level Change Plan

| Hunk / 文件 | 最终行为、必要性与复用 | 原有测试及变更边界 |
| --- | --- | --- |
| OUT-0，无生产文件 | 原失败回执已经覆盖用户需求；现有 SessionTools 不补写未显示的子工具正文，不另包错误或新增输出。 | 原 execute.test.ts 夹具增强是诊断，不保留仅能验证已绿行为的新回归断言。 |
| SH-1 `packages/opencode/src/tool/shell.ts`，最终组装 | 限定将 program.value.content 改为现成 end.text；展示字段含通知，复用它无法给机器获得原文。 | 在原 shell.test.ts 两用例加红可捕获的机器字段断言；原模型/UI/退出和状态检查不动。 |
| READ-1 `packages/core/src/tool/read-lines.ts`，增量和提交预算两点 | 两点共同决定首行是否能进入 raw；仅按 V1 提供的首行准入在原软窗外捕获，后续行沿原门禁。只改一点会继续丢首行或出现提交/积累语义分叉。 | 原 read.test.ts 首行红、原 1 MiB 未闭合与 outline 共享预算回归；V2 strict 和 outline 不传准入。 |
| READ-2 同 parser，原物理块转辅助扣费 | 扣费起点仍是原软窗跨越处；同一已读块只扣一次、已读末块能结束时才返回完整首行、不能多请求普通块。否则可交付首行会蚕食 outline 额度或扩大实际 I/O。 | 原物理上限、共享预算、CRLF、有限 EOF；临时候选暂存峰值需按现有码率上限复核，禁止回到捕获整个辅助扫描的方案。 |
| READ-3 `packages/opencode/src/tool/read.ts`，V1 调用与投影 | 用同一已有码率/16,000 token 估算为捕获提供准入，保留现有页最终检查；正 limit、零交付行且 cut/more 时走中性错误，无自指 next。已有行按行数计算 next，limit=0、越界、普通 EOF 不变。只有 V1 知道本机结果合同，parser 不持其 token 常量。 | 原 ReadTool 真实首行/尾行断言；1 MiB 中性错误及原控制。 |
| RG-1 `packages/core/src/ripgrep.ts`，记录拼接进 JSON.parse | 清除合法记录在解析前的固定 64 KiB 长度拒绝；复用现有解析/无效数据错误、超时、数量阈值、文本展示。无需加另一个大小阈值或生产 fallback。 | 原 core ripgrep 夹具覆盖 32/70 KiB 三匹配及错误。 |
| RG-2 原搜索停止点，无文件 | 同基线 partial/invalid/abort/bounded 控制通过，保留原停止点及各自的错误与已完成结果语义，不预先加入条件。 | 区分正常提前停止与真正失败，不能把 partial 合同推到所有异常。 |
| JS-1 `packages/codemode/src/interpreter/runtime.ts`，Array 构造与内建调用 | 支持用户已有普通构造和受限回调，继续验证 sandbox 可调用值；不接任意宿主 callable、ToolReference、thisArg 或隐式 Promise 等待。复用现有执行器而非把回调交给原生未受限执行；已准入 Math 的 min/max/hypot 在回调分支根据原生 ABI 消费全部参数，用已有受限 coerceToNumber 转换；定参保持已验 arity，直接调用不变。 | 原 codemode 数组行为实例复用；实际红测只为固定基线差异。 |
| JS-2 同 runtime，Array.from 支持源读取 | 已受支持输入逐项读取后立即调用 mapper；保留数组稀疏长度，array-like 只固定一次长度、索引动态读。预先整批复制会让前项回调修改尾项的语义错误。 | 原 Array.from mapper/逐项读取和无 mapper 正控制。 |
| JS-3 同 runtime，稀疏集合消费与排序 | 数组构造与现有索引赋值可产生真正空槽；保持旧数组字面量省略元素的既有表示，按方法合同在 map/flatMap/filter/some/every/forEach/reduce/reduceRight 跳过洞并让出调度，map 保留索引，find 系列照旧访问洞；sort 保留洞、toSorted 复制读成 undefined。比较器调用前捕获已有目标长度，不能在比较器有副作用后重读长度并截掉已完成快照。普通字面量生产不属于原要求，不改变；方法只按收到的容器本身区分实际空槽与已存在的 undefined。 | 同真实 0dff 与完整候选；真洞输入由新构造或原索引赋值得来，原字面量单独作现有合同对照；原百万空槽超时与 find/sort 保持。 |
| JS-4 packages/codemode/src/interpreter/model.ts，既有语法提示 | 原要求包括提示与实际能力一致；只说明受限内建回调、Array 构造与 Array.from mapper，不声称任意原生回调可用。 | 现有错误说明入口；不新增独立测试实例。 |
| JS-5 packages/codemode/src/tool-runtime.ts，copyOut 的公共 JSON 投影 | 公共执行结果 true 模式在已有 copyOut 数组分支把空位及 undefined 投影为 null；默认模式沿固定 0dff 的 map 回传，原已存在的自身键保持，真洞仍缺键。两条宿主前像都保持：字面量 [,1] 原生产已有 undefined 自身键；索引赋值造成的缺位须以洞送达 raw/JSON Schema 工具。copyIn、解释器集合与 decoder 不动。 | 复用既有 CodeMode JSON-safe 结果用例核对直接值/Schema 往返；在已有 raw JSON Schema 工具调用用例补两组输入：普通字面量与既有索引赋值，观察实际收到的参数键、值、长度及原生 map 是否跳过真洞；现有 Array 构造/集合用例验证新产生真洞的能力。零新增测试实例，保留原断言。 |
| BUD-1 `packages/opencode/src/tool/code-mode.ts`，预跑与正式两处组装 | 用同套上限给两个独立阶段；当前只有预跑有 1024。保持预跑 500 ms、正式产品/用户超时、输出上限、取消语义。 | 原 host preview caps 实例对照 1024/1025；受限计数仅在正式结果里观察。 |
| BUD-2 `packages/codemode/src/codemode.ts` 与 `packages/codemode/src/interpreter/runtime.ts`，预算配置与循环体入口 | 通过既有 limits 的公开解释器入口传显式循环配额，在同一个根上累计所有真实进入的循环体并跨嵌套/调用/并发消费；新 Execute 重置。工具侧复用已有 maxToolCalls admission，不重做计数。 | 用已有真实解释器控制及原 host 入口验证相邻边界与重置；100,000 已由真宿主验证。 |
| VIS-1 `packages/opencode/src/tool/code-mode.ts`，toolTree 公示 | 用 definition.input 替换展示 inputContract；保持 Tool.make 已生成的 inputForms 与原运行时解码器。修复错误引用之处已在真实 adapter A/B 验证，不改共享 codemode 适配器或重复裁剪 Task。 | 原 code-mode.test.ts 公共/运行时 schema 对照，目录、search({query})、标量与对象、开关和权限制约。 |
| VIS-2 packages/core/src/tool/task.ts，独立 V2 注册 | 使用已有背景 flag 给公开 schema 和描述，不改执行时完整 Input codec 与拒绝条件。V1 toolTree 到不了此 consumer；历史精确原修复和 R7 合同均覆盖。 | 在隔离工作树恢复历史 task advertises background only when enabled 作阶段1夹具；正式用既有 SessionRunner 测试最小承接，保持测试实例数。 |
| EXIT-1 `packages/tui/src/ui/toast.tsx` | 在原 owner cleanup 标记关闭并释放现有 handle；已关闭的 show 不再写 store 或创建 handle。两处共同维持资源生命周期：只 clear 不能处理迟到调用，只拒绝迟到调用不能释放卸载前在用的 handle。 | 原 app.exit 用例不改，复跑原 stock 两文件组合；额外生命周期诊断只留仓外。 |
| SCROLL-1 packages/tui/src/routes/session/index.tsx，原滚动调度与组件销毁 | 保存各现有句柄，触发移除，卸载关闭入口且清扫；两个既有调用及原时序保持。 | 复跑原 partial glob 与原切换贴底控制；正式测试不改。 |
| SLOT-1 packages/tui/src/ui/dialog-select.tsx，filterAccessory 的 Show | 用该 Show 自己的 accessor 渲染，避免创建第二份动态节点；原布局、动画、选项保持 | 原 preview 和 scan HTTP failure 场景，不增正式实例 |
| RENDER-1…3 patches/@opentui%2Fcore@0.4.3-smark.13.patch（唯一载体，待独立批准） | 既有 one-shot、continuous、start/suspend/destroy entry 只改各自失去所有权处。以 fork TS owner 为语义依据；不提交临时安装树、生成包或额外锁文件 | 原 active switch / partial glob、原选中的 TUI、真实时钟控制，最终原 Gate 与原生验收 |
| 交付范围 | 生产仅上述有明确 owner 的候选；RG-2 与 OUT-0 均无生产文件。测试在现有实例最小修改，零新增实例；精确有效行数、文件数及注释随最终经审计差分冻结。 | 私有夹具、临时脚本及收据不进产品差分，Gate 未改。 |

历史精确原差分共 24 文件（含旧 Plan）：解释器 codemode.ts、interpreter/model.ts、interpreter/runtime.ts、stdlib/math.ts 对应 JS-1…5、BUD-2；本版保持直接 Math 的既有数值校验，不迁全局 math 改动。历史 codemode/src/tool.ts 与原 V1 host code-mode.ts 对应 VIS-1/BUD-1，本版修复已证展示覆写点并保留其他消费者。历史 core 的 ripgrep.ts、read-lines.ts、task.ts 对应 RG、READ、VIS-2；READ-3 来自当前 0dff 的 V1 自指和已有 token 合同。历史 shell.ts 对应 SH；历史 Execute 隐藏正文由 OUT-0 实跑保留。

原测试 codemode 的 codemode/promise/signature 分别覆盖 JS/VIS/BUD，core 的 ripgrep/session-runner/tool-read-filesystem 对应 RG/VIS-2/READ，opencode 的 execute/code-mode/read/shell/task 逐项对应 OUT/BUD、VIS/READ/SH/VIS。复用当前已有实例，旧新增实例及仅能验证已绿行为的临时断言不直接搬。历史 opencode/test/server/tui-control-voice.test.ts 和 tool/registry.test.ts 是语音请求隔离、SDK 依赖装载测试夹具，不在上述功能路径，本轮不预先迁移；若原 Gate 重现与本次修改有因果关系的夹具失败，再走新修订。

## 16. TDD Behavior Slices

| 行为切片 | 历史 0dff 红与最小绿（当前仍须重跑） | 原回归入口 |
| --- | --- | --- |
| RG-1 | 合法长记录被提前拒绝 → 三条依序返回；停止、非法记录、超时保持 | core/test/ripgrep.test.ts 原预览用例及原包控制 |
| READ-1…3 | 首行空、自指 → 完整首行、真实 next；超预算无进度为中性错误 | opencode/test/tool/read.test.ts 原长行/辅助预算/未终止行 |
| SH-1 | 状态通知进入机器正文 → 仅原文；状态与展示保持 | opencode/test/tool/shell.test.ts 原 exit 0/7 |
| OUT-0 | 基线已通过，不制造生产红或保留纯证明断言 | opencode/test/session/execute.test.ts 原失效收据 |
| JS-1…5 | 回调/构造被拒、mapper 预读、真洞集合消费 → 复用同一受限解释器；原字面量/赋值宿主合同、Promise/replace、时间中断与说明按对照保持 | codemode/test/codemode.test.ts 原有数组/内建入口；组合隔离回执作实施前证据 |
| BUD-1/2 | 1025 次宿主调用与 100001 次显式轮次抵达 → 截止于边界，预跑和后续执行状态保持 | opencode/test/tool/code-mode.test.ts 原 preview caps；codemode 原控制 |
| VIS-1/2 | V1 显示完整运行时字段、V2 flag 关闭仍广告 → 各注册 owner 使用公开合同；打开及实际任务结果不退化 | 原 V1 host/schema 与 Task 开关；Core 节点在现有 SessionRunner durable/scoped permissions 实例内承接两个开关断言，不新增实例、不删原断言 |
| EXIT-1 | 0dff 原 Gate 红 → 原样测试 + owner cleanup 与关闭准入变绿；单加 clear 的对照仍红 | packages/tui 原 app-lifecycle、prompt-voice-input；仓外 Solid 实例验证活跃默认时长、替换、到期、退出与迟到调用 |
| SCROLL-1 | 两臂原 partial glob stock 红 → owner-only 私有候选 1/0；切换贴底原断言保持并消除两个 50ms | 同一原 auto-review-render 两用例；依赖 loop/requestRender 残留独立记账 |
| RENDER-1…3 | 独立 pinned real-clock 红绿 + 原 active switch 组合红绿；保持正常 frame、取消 pending、暂停恢复后的活动帧、手工接替与 held async destroy | 原用例原 preload；仓外 probe 只验证渲染器自身 |
| SLOT-1 | 原 preview 在三臂都仅 spinner 红；单读取候选绿，原 loading spinner 渲染与结束消失实测 | 原 preview 和 scan fail，不改两测试 |

## 17. Comments

按用户 Session GOAL 记录实际 E/C：空行、import-only、formatter-only、generated、pure-move 不计；E=0 时 C=0，否则 C 至少 max(1, ceil(E×0.15))。适用仓库中文注释规则，解释真正的行为约束；R14 实际计数见 §23。

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

- 发布目标为 SMARK2022/opencode 的 dev1-smark，规划时固定 TARGET_SHA=5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0；完整行为从原 GOAL 基线 0ab20fa87080bd4fafd79d39b97fb082c4af8d62 描述。FINAL_SHA 只有在 R17 独立方案批准、实施及审计达到提交合同后，从实际干净单提交读取。编写时 PR #5 的公开头 d10c52132f1e8f44ca742f077191d7db8743cb5d 仍是 R14 的 98a9f13 发布记录；R15/R16 为离线历史。当前 PR 元数据仍关联旧合并树；正式核验读取 dev1-smark 分支实际 ref，核对新试验 checkout 的父提交与树。重新核对 GitHub base、head、policy 和 merge checkout；目标变化须重新读规范、重放完整需求、修订并独立审计。最终质量须可合并；合并由用户决定。
- 同一 FINAL_SHA 的仓库根用锁定 Bun 1.4.4 启动 stock Gate：GUARD_PREFLIGHT=required bun script/guard/gate.ts push --since "$TARGET_SHA" --sha "$FINAL_SHA"。校验 diff --check、对象、唯一提交和无未跟踪调试文件。按仓库原规则执行逐提交/选中测试/契约；禁止 GUARD_TESTS=off、GUARD_PREFLIGHT=off、跳 hook、手造 stamp 或以 commit/stop/contracts 作为通过依据。
- stock Gate 若要求 preflight，必须对应 FINAL_SHA，通过原 workflow_dispatch 的 guard.yml 及 Gate 实际要求的平台；preflight exit=10 为运行中，3 为 gh 不可用，Gate 等待/失败均不得放行。保留首次退出、workflow run/head SHA、各平台结论，使用原 bun script/guard/preflight.ts status --sha "$FINAL_SHA" --base "$TARGET_SHA" / wait --sha "$FINAL_SHA" --base "$TARGET_SHA" 后，以同一 SHA 再运行原 push tier，直到 exit 0。仅在原逻辑明确无需 preflight 时记录不触发原因。无能力时如实阻塞，不能改变 Gate 代码、规则、配置、执行合同。
- 三包以 packages/codemode、packages/core、packages/opencode 各自目录执行 bun run typecheck；执行本 Plan 原窄测试和对应包回归。然后从同一干净提交在 packages/opencode 执行 bun run build --single --skip-install；从构建输出核对真实二进制 hash，使用独立临时 HOME、XDG、配置/数据目录和本地安全测试场景，在真实终端启动构建二进制。保存原生终端截图：应用初始画面、Execute/READ/Shell 与后台开关所代表的真实输出，明确截图的命令和 FINAL_SHA；不用文本转图片。若所需 UI 依赖本地 Web 界面，使用同产物的 opencode web --hostname 127.0.0.1 --port <临时端口> 启动，在真实浏览器加载并保存原生屏幕画面，记录本机 HTTP 成功以及应用/子进程/daemon 的退出。当前 PR 不修改 WebUI 功能。
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

### R17 当前验证（5bc061b）

GitHub 目标 ref 与本地精确对象一致。自 8aead09 起有 0b2d39a、6ac1bb0 和 5bc061b 三个原提交，累计 13 个变更路径。原 AppRuntime 在宿主释放时关闭 serviceScope；HttpApi exerciser 退出时先释放已建立的 App，再清理凭据 fixture 临时目录。两条上游生命周期都保留，未进入本 PR 补丁。CodeMode、Core、Guard、锁和安装配置的目录树或 blob 身份与 8aead09 相同。用独立空索引应用 §15 的 21 路径并逐字比较后像，零冲突、零差异，产品树 `5666007b10724acdec0e66c67925932c700084ca`。该索引只用于重新验证方案，计划工作树未写入实现。

- **Execute 红绿。** 精确基线与上述候选各导出 CodeMode 包，原 Bun 1.4.4 跑同一临时公开入口探针 `bun run mapper.ts`，断言 `Array.from([2,3], (value,index) => value + index + 1)` 得到 `[3,5]`。基线在第 1 行第 8 列返回 `UnsupportedSyntax`，退出 1；候选返回 `[3,5]`，退出 0。两臂均无工具调用或网络请求。正式实施在原 CodeMode 数组行为用例内补断言，保留无 mapper 与逐项读取对照。归档清单 `b6bd1125fca027d983c7c7231b0bcf6cd234bf2366139cf40d26046255d35b0b`。
- **Core 后置检查。** 精确 5bc061b 的原测试与原 Guard preload 运行 `executes and resumes canonical task sessions with durable results and scoped permissions`。业务用例通过，159 个断言；后置检查捕获一个 `setTimeout(600000)` 引用、无子进程，2.77 秒退出 1。Core、preload、锁和输入与 8aead09 相同；此前 8aead09 的基线与 #5 候选两臂同红。继续按本版正式 Guard 验证影响；若同一红仍阻断，先确认原 owner，再判断是否必须另作方案处理，不在此版添加计时器、掩盖原检查或扩大实现范围。
- **原静态选测已跑。** Bun 1.4.4 执行原 `script/guard/affected.ts`，绑定当前基线、锁定 TypeScript 和确切 22 条目标路径。退出 0；OpenTUI Core patch 仍使 24 包、807 个测试文件被选中。选测 JSON SHA-256 `718ab2cf56cd26eccc50ce010643ac756a2e97272fc76119297e27143f6d1e68`，与 R16 相同。此步没有执行这些套件。
- **官方基线。** `44893573585` 已通过当前 Auth、Coverage、Effect 和三平台 Core、TUI；不继承到候选，也不替代原 Core preload。原 Guard `44893573612` 的 rules、contracts 和汇总通过；该运行是分支 push，未执行 PR bench 或 dispatch preflight。正式 #5 的测试与性能只收实际 R17 checkout 结果。围绕当前上游关闭路径应重跑本版候选的原 HttpApi、完整构建与实机，历史 R16 截图只按其原版本留档。

## 19. Diff Budget

目标单提交、原有用例中最小断言、零无关文件；EXIT-1 的目标只多一个生产文件及一个 owner hunk，预估新增有效 6–9 行，仍零新增正式测试实例；实际差分需用原规则核实。不借改写空行或旧 Plan 压指标。按当轮 Scope 与 Gate 的文件/行数要求逐项核对。

沿用 R6 的 18 个代码路径，加 SCROLL-1、SLOT-1 各一个应用路径及上述唯一已有 Core patch，共 21 个代码/补丁路径加唯一 Plan。零新增正式测试实例与一份提交。对 package/lock、生成包、Gate、测试计时和其它文件的净变更为零。最终实际 E/C、总修改、净增、文件计划逐项对现行规则；必要近邻注释解释三处 renderer 句柄所有权，不沿用旧补丁既有注释计数。
## 20. Real Risks and Open Decisions

### Open Decisions Requiring the User

在当前范围内重建可继续规划；对外提交仍按已有用户要求和执行审核决定。需超出原需求、改变原权限或替代历史行为时先请用户决定，不以旧审批代替。

### Follow-up

当前发布范围由 5bc061b 至本 Plan 的完整目标收口（原用户行为从 0ab20fa8 描述）。旧基准、真实图像和验证按原对象保留；当前红绿、选测、viewport 回归和未结条件见 §18。实施复跑实际补丁、原测试预算、最新 Gate、完整产品和平台，随后交独立实现审计。

READ 选定现有 V1 token 准入与共享 parser 物理记账；真实 V1 对照支持该路线。淘汰 32 KiB 固定首读、捕获整个旧辅助扫描、R7 无界组装及虚构 next。合法正文由真实行与原预算决定，展示限额保持。

V1 有普通工具错误通道（read.ts:574–587）。候选优先复用现有 parser 结果：对固定 V1 路径（正 limit、raw 捕获开启、非辅助起步），越界先走原有规则；参数允许 limit=0（read.ts:203），该值保留现有零行请求行为。若 raw.length=0 且 cut=true、more=true，当前首行未交付。用中性提示说明现有读取预算内无法返回完整首行，不宣称 token 超限，也不给自指 next。只要交付至少一行（包括空白行），保留正文、截断标记及指向首个未交付行的 next。正常 EOF 保留成功。当前不新增原因字段；只有宿主实证必须提供不同且可准确区分的恢复动作时，再评估最小内部信号。

固定 HEAD 的 READ parser 直接消费入口为 V1 read.ts:561（普通原文捕获）、V2 read-filesystem.ts:276（strict UTF-8、BOM/二进制检查）和共享 read-outline.ts:261（从辅助模式起步、captureRaw=false、Infinity、回调消费）。不将 V1 的判定复用于后两者。parser 仅两处置 cut：完整行提交的字节预算检查（read-lines.ts:151）与追加字符前的增量字节预算检查（:179）；行数用完和正常 EOF 均不置 cut。方案若用旧辅助额度保护未完成的超软窗首行，需要维持 cut/more 的既有含义；8 组已跑对照涵盖空白行/部分页/空 EOF 与两类负样本，已追加无原因字段的中性投影对照，见实测记录。

交付行数取 parser 实际保留的 raw.length：共享 parser 在确认行完整后才 push（read-lines.ts:157）；V1 read.ts:717 和 V2 read-filesystem.ts:345 都按返回条数算 next。草案选择 V1 既有工具错误通道处理零进度首行，保持 V2 和 outline 不动。本 PR 沿用按行 offset，不引入行内游标或分段续读。中性替身和实际 V1 窄实验已验证；实施后仍对最终差分重跑正常分页、权限、展示和部分页。

阶段1 回归修订：R2 审计发现排序比较器改动源数组后会截断快照，以及公开结果直接消费会观察到不符合 JSON 的洞。R3 在原 sortArray 记录比较器尚未执行的长度；在原 copyOut(…, true) 仅把公共 JSON 数组投影稠密化。已取固定基线、R2 组合候选和 R3 的同输入回归证据，未改变解释器内部稀疏语义或 copyIn。R3/R4 的出站实验记录见 §23。R4 让所有默认出站数组密化，会把已有索引赋值等路径产生的真洞改成属性；应撤销全面密化和未经需求授权的字面量生产改动，从源头分别维持旧字面量和旧真洞宿主合同，只保留公共 true 模式结果投影。

EXIT-1 只修原测试实测暴露的 ToastProvider 生命周期；保持 fixture 与产品两个迟到 producer 原样，以证明 owner 正确拒绝其过期写入。不能把此红绿扩展解释为全部 Gate、其他包或远端配置已绿。

### 唯一发布载体与正式安装门禁

R10 沿用现有 `patches/@opentui%2Fcore@0.4.3-smark.13.patch` 承载 RENDER-1…3。原 GOAL HEAD 和当前发布头的该补丁前像均为 Git blob `ca34a93ee779ccf266e977ec2601a5f7ad71a5e6`，SLOT-1 的 `dialog-select.tsx` 前像均为 `1bbf6fe45517cef2753d07d1630f6d882c3ceda4`。补丁内保留原功能，生产 `index.js` 与 `testing.js` 只共享一份 renderer chunk。依赖声明、`bun.lock`、bunfig、gitlink `b0cf25352ca75b964eca476af3554e6aa8dd8b20`、tag 和 native ABI 保持原样。Solid 补丁、parser worker CJS 别名、fork、新发布、另开计时器 PR 均排除。保留原 0 延时 nextTick 分支、命中时原等待长度和活动帧；renderer 一次帧的活动身份和可选句柄由同一个 owner 记录，启动接替、挂起撤销与销毁统一失效，显式取代已有连续帧时沿用旧 clear，owner 销毁后不再调度。候选测试差分只允许前文已列出的原实例内断言，不修改本次暴露故障的原 fixtures 或 preload。

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

**实施期必须执行的顺序。** 获独立精确批准后，先在已有能访问原锁发行源的 runner 建固定 5bc061b 和实际候选两棵私有空工作树，记录旧锁 SHA、Bun 1.4.4 / OS / 架构、无初始 node_modules，然后在各仓库根按原基准安装入口执行 `HUSKY=0 bun install --frozen-lockfile`。逐臂保存真实原始退出、锁安装前后哈希、补丁/产出 chunk、所选平台原生包 SRI 及 native 文件 hash。两臂安装须 exit 0 且锁字节不变；正式候选加载应匹配所审补丁，后续实机驱动必须使用同一安装。当前原 `guard.yml` 的 rules 和 bench 作业给候选 checkout 明确传 `--frozen-lockfile`；新 bench 脚本对 base detached 也每次执行原冻结安装。用现有 #5 的 `execute-result-recovery` 分支作用户已授权的临时线上验证。普通 PR 的 Guard rules 使用目标分支 policy，runtime 改动运行原 bench 对照；核实实际 head、policy、merge-base 和合并检出树，并查两臂真实安装与执行退出。普通 PR 不运行 dispatch-only 的 Push preflight；线上其他必过测试和原 preflight 分别按各自结论记录。仅在仓库原 Gate 明确要求且已授权相应 ref 时触发正式预检入口，按 sha＋base＋platforms 核实际 job。没有该 ref 权限或物料时用既有同锁 runner 的独立私有工作目录执行原命令，不改流程、不开额外 PR。无可用原发布物就停在此放行条件，记录原错并更换已有正式验证环境，不改锁、规则或测试。

**原夹具放行。** 冻结 R6 32 文件原 TUI Stop exit 1，基线与冻结 R6 的同选集直接 A/B 为 185/1/200 与 187/1/198（通过/跳过/失败）；双方 197 个失败同文件同用例名。阶段 1 只证明 EXIT-1、SCROLL-1、RENDER-1…3、SLOT-1 指定路径的红绿，未证明 197 个共同失败都已关闭。正式同一候选先跑原 active switch、partial glob、preview、active scan 和 app.exit，随后用完整原 Stop/Push、按原 Gate 需要的 preflight、锁定 native 构建和实机验收。若仍有原夹具红，保存准确用例和资源归属；只有实证是否由已批准责任路径负责后才修正。超出此版责任边界的已存在红点保持发布阻断，重走完整方案范围裁定，不能用固定等待、关闭动画、排除夹具、改 Gate 或单纯重跑放行。

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

<details>
<summary>R2 独立方案审计原文</summary>

## Blocking findings

### B-01 比较器改变源数组长度时，`sort` 丢失结果

- Violated invariant: JS。保留现有排序结果，只纠正空槽语义。
- Evidence class: observed
- Producer and execution path: `CodeMode.execute → Array.sort → sortArray → 受限比较器 → 公开结果`。
- Source evidence: 基线 `packages/codemode/src/interpreter/runtime.ts:2864–2906`；§23 哈希匹配的候选 `runtime.ts:2982–2990` 在比较器执行后将 `target.length` 赋给结果。
- Canonical-plan evidence: §7 JS、§15 JS-3、§23 完整组合候选。
- Responsibility owner: 解释器的 `sortArray`。
- Concrete behavioral consequence: 独立实跑 `const a=[3,1];const r=a.sort((x,y)=>{a.pop();return x-y});return [r.length,a.length,r];`，候选返回 `[1,1,[1]]`，丢失已排序的 `3`。比较器执行 `push` 时，候选又会给结果额外加一个空槽。
- Pre-R1 baseline behavior on the same path: 固定 `0dff` 返回 `[2,1,[1,3]]`；`push` 对照中源数组增长，结果仍为 `[1,3]`。
- Round basis: strict class，既有行为回归。
- Minimal correction direction: 计算排序结果空槽数时使用比较器执行前的长度和元素快照，在现有排序用例加一个公开结果断言。

### B-02 解释器空槽泄漏到公开 JSON 结果

- Violated invariant: JS 与既有公开 JSON 数据边界。解释器内可以保留空槽，公开结果仍保持原 JSON 值合同。
- Evidence class: observed
- Producer and execution path: `CodeMode.execute → evaluateArrayExpression → 返回值数据检查 → copyOut → CodeMode.Result`。
- Source evidence: `packages/codemode/src/interpreter/runtime.ts:2971–2998,3538`；`packages/codemode/src/tool-runtime.ts:298–303,326–332`；`packages/codemode/src/codemode.ts:70,109–132`；`packages/codemode/test/codemode.test.ts:232`。
- Canonical-plan evidence: §15 JS-3 修改字面量空槽生产，§16、§23 未把公开数据边界纳入该切片。
- Responsibility owner: CodeMode 的出站数据转换。
- Concrete behavioral consequence: 独立实跑 `return [,1]`。候选公开结果只有索引 `1`，编码并按 `CodeMode.Result` 解码后有索引 `0`，该值为 `null`；回环深度比较失败。
- Pre-R1 baseline behavior on the same path: 直接执行返回 `[null,1]`，JSON 编码再解码后深度相等。
- Round basis: strict class，既有公开结果行为回归。
- Minimal correction direction: 仅在原出站数据边界把空槽按 JSON 合同转成 `null`，保留解释器内的空槽，并在既有公开结果测试中验证。

### B-03 最新交付要求仍未进入可执行验收合同

- Violated invariant: REL，以及用户要求原文进入 canonical plan、按当前 Workflow 和 Gate 验收。
- Evidence class: contracted
- Producer and execution path: 用户原消息 → §1 需求 → §18 验证 → 正式 Gate 和交付验收。
- Source evidence: 房间消息  明确说「说错了，不是跑pre commit是跑gate。」； 要求新 Workflow 和新审计。`.husky/pre-push:8`、`script/guard/gate.ts:4–7,185–200`、`.github/workflows/guard.yml:132–150,269` 显示不同入口的作用和结果。
- Canonical-plan evidence: §1 把六条最新原话压成摘要，并写明须在送审前回查；§1 所列关于主逻辑避免硬编码常量的要求也未收录。§18 写「执行原 Gate」，但没有选定 Gate 入口、验证哪个基线与候选 SHA、如何判定线上 preflight 结果，也没有写全应用启动、原生截图和空目录恢复的复验步骤。
- Responsibility owner: canonical plan 的需求及验收章节。
- Concrete behavioral consequence: 执行者可以跑较窄的 contracts 或本地检查后声称通过，而真实提交 Gate 或其转交的 preflight 尚未执行。用户明确更正过的验收路径仍取决于执行者自行解释。
- Pre-R1 baseline behavior on the same path: 当前固定基线已有 `push`、`contracts` 及线上 preflight 路由，各自覆盖范围不同；无需改 Gate。
- Round basis: strict class，明确的交付验收尚未落到可执行步骤。
- Minimal correction direction: 收录适用原话和优先关系，在 §18 锁定真实 Gate 与验收命令、工作目录、基线和候选 SHA、必须通过的结果，以及全应用与恢复包的重验入口。

## Non-blocking findings

§8 与 §23 混合了早期「未运行宿主」和后来的宿主实测；§10 还把 100,000 写成待选值，§7 和 §23 已有实测。整理阶段标签即可，已有报错、入口和回执仍可审查。

## Follow-up

暂不扩到 V2 Read 分页、通用 JS 集合重写或 Gate 改造。这些路径不属于当前已证缺口。

## Rejected speculation

未发现理由为 ripgrep 换另一条小记录上限，或用旧归档的整片差分覆盖当前基线。V1/V2 Task 可见性分别发生在可达的不同注册路径，不能仅凭名称相同认作重复修复。

## Requirement and traceability coverage

核对了 R2 SHA-256 `97c0782a7f4bb7f5a85d82fe431640aae80a175afa3c8b4d4cc8f3a806a90289`、固定基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`、R7 原文档哈希，以及房间中的最新验收补充。OUT 保留原路径；SH 机器正文、READ 首行与辅助扣费、RG 解析及停止条件、BUD 宿主与执行根、VIS 两条注册路径均有明确 owner 和行为测试入口。JS 的两项回归及 REL 验收缺口见上。

## Primary-path and fallback verdict

RG、READ、SH、OUT、BUD、VIS 的计划沿现有主路径，未发现新增备用成功路径。JS 的修订应留在现有排序和数据边界，避免另建一套集合执行或序列化路径。

## Release verdict

**BLOCK**。修订同一份 canonical plan，补齐三项后重新做全范围方案审计。

</details>

<details>
<summary>R3 独立方案审计原文</summary>

## Blocking findings

### B-04 稀疏字面量改变了宿主工具收到的参数

- Violated invariant: JS 修复只改变解释器内的空槽语义，保留既有工具调用合同。
- Evidence class: observed
- Producer and execution path: `CodeMode.execute → 稀疏字面量 → tools.host.* → copyIn/copyOut → 原始及 JSON Schema 工具处理器`。
- Source evidence: `packages/codemode/src/interpreter/runtime.ts:2971–2998`；`packages/codemode/src/tool-runtime.ts:298–303,326–332,771–797`。宿主参数走 `copyOut` 默认模式，R3 只稠密化了 `undefinedAsNull=true` 的分支。
- Canonical-plan evidence: §10、§15 JS-5、§23 R3 三臂；将默认模式当作内部投影，测试又全程零工具调用，因此漏掉了真实出站路径。
- Responsibility owner: CodeMode 既有出站数据转换。
- Concrete behavioral consequence: 独立运行 `await tools.host.schema({list:[,1]})`，R3 的宿主处理器只收到自有索引 `"1"`，`0 in list` 为 `false`。同样的差异在原始工具处理器复现，两条路径都能观察到参数形状变化。
- Pre-R1 baseline behavior on the same path: 固定 `0dff` 中两类工具都收到自有索引 `"0","1"`，`0 in list` 为 `true`，第零项是 `undefined`。
- Round basis: strict class，既有工具输入行为回归。
- Minimal correction direction: 在同一出站转换中，让实际宿主收到原有显式 `undefined`，让公开 JSON 结果收到 `null`，解释器内部继续保留空槽；用已有真实工具处理器实例核对参数形状。

## Non-blocking findings

§18 的发布步骤应把 Gate 脚本内部的临时 `preflight/<sha>` 推送与最终 PR 分支更新分别记账。当前引用原脚本，未授权手工绕过 hook，实际执行仍由仓库既有流程负责。

## Follow-up

V2 Read、通用集合改写和 Gate 改造仍在本轮范围之外。

## Rejected speculation

未发现需要改变现有工具解码器、放宽权限或改用第二套序列化器。B-04 可在已有出站边界收口。

## Requirement and traceability coverage

核对了 R3 SHA-256 `12464d5f382fdf170f7bf51b880ed29cd44de6fd824bf395b744e2bc473ea4b8` 和固定 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。重跑哈希匹配的三臂探针，确认 B-01 的排序长度和 B-02 的公开 JSON 回环已修复。B-03 的逐字需求、同 SHA Gate 与条件 preflight、真实启动截图和独立恢复验收已补齐。OUT、SH、READ、RG、BUD、VIS 在本次全范围复核中没有新增阻断项。

## Primary-path and fallback verdict

现有设计沿原工具、解释器和发布路径，未引入备用成功路径。B-04 应继续复用同一出站数据转换。

## Release verdict

**BLOCK**。补齐宿主参数兼容并重审同一 canonical plan。

</details>

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

## 23. Implementation Evidence

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

## 24. Implementation Audit Record

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
