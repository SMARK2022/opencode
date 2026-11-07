# Canonical Implementation Plan: V1 Execute 全工具编排与整体 AUTO 审查

> Status: verified
>
> Revision: R21
>
> Approved revision: R21
>
> Audit mode: full-scope
>
> Requirement source: 本次会话中用户关于 V1 execute、整体预检、风险升阶、运行时工具检查及逐文件实施计划的原文；见第 1 节
>
> Implementation allowed: yes — 严格执行第31节用户指定返回schema，保留V1执行器并对齐官方v2.2.5提示词与接线，完成后合并审计
>
> Target: verified-implementation
>
> Last updated: 2026-11-07

本文件是本任务唯一实施规格。当前R21执行第31节固定合同、31.11补充及第37节最新纠正；第2–36节保留历史证据，不构成与最新要求冲突的授权。V1执行器保留，Upstream唯一指官方 `anomalyco/opencode@v2.2.5`；execute默认开启同时保留全部原有直接工具入口。用户已将78文件提交撤回暂存区，禁止本轮Git改动。实施及合并审计沿第27.4节授权进行；此前批准只属于原修订。

## 1. Verbatim Requirement

> 我希望呢，我能够把这个 execute 像 2.5 一样，让它去支持全部的 Open Code 所提供的功能能力。

> 但是我们希望长期保持 V1 的基座。

> 注意具体的操作执行等等内容都应该由你自己去进行，你不应该让 sub-agent 去帮你做东西。

> 就是顶层如果有风险，发现有风险，那就直接把顶层整个去参与这个疑似 AUTO 的 reviewer 审计。如果 reviewer 审计过了，那 reviewer 审计就会带着这个风险的一个放行啊，巴拉巴拉的。然后底层再去进行一个 pre-check。如果底层的这个风险高于当前这个顶层的风险，那本身而言仍然需要去经过那个审计。但是如果顶层它就还好，顶层的审计过了，然后底层的风险又不超过顶层的，本身就直接就放行就可以了。

> 连续执行 (Recommended)

上述选项说明原文：支持全部可用工具；AUTO 等待后原地续跑。最终拒绝时停止后续执行，报告已完成操作，不自动回放或撤销。

> Abort 的话本质上就是直接去 abort 掉，就是整个这个工具被 abort 或者 interrupt 掉了。然后如果 execute 过程中关闭某个工具，那当然也直接就按照这个阻止尚未启动的调用为准。就是每一次它去调用的时候，它都去先检查一下工具列表中是有没有这个东西。

> 比如说到底要修改哪些文件，每一个文件到底准备去涉及到多少的一些分切点，或者说涉及到多少一些修改点，各种各样的一些东西。然后整体的逻辑，到底如何去修改，然后以保证它的这个整体的这个克制，还有这个整体不会扩大，巴拉巴拉的。而且这些内容你在 plan，或者说你在当前方案设计的时候，你就应该考虑到。

> 注意你要按照相应的DOCS里面的workflow的那个文档的要求去进行构建，请注意这点。相关的内容必须得到验证，且实现的方式优秀，不要过度复杂化，保持整体的高效扩展性、鲁棒性、泛化性。

> 你还没有去验证关键假设呢，你都没有去验证呢，你现在去考虑审计干嘛。

> 注意文档的修订，你不要一次写很多，或者说一口气全部写完，这是不现实的。

> 请注意你提方案的时候你要自己去验证相应的方案。你自己去写代码，现在方案逻辑可行，你不要写一个并声称，或者说声称一个本身就不可能实现的东西。然后你又要说验收标准就是这个。

用户后续澄清上一句的转录：

> 我当时说的只是这个转录，转录的时候把未知写成了位置。

> 你的 plan 里面要有清晰的解释，怎么搞？就很简单，怎么搞？

> 少说不和没有，多做事儿。多做高效的事儿，思考目标是什么，只做对目标有益的事儿。不要因为A做了B，因为B做了C，因为C做了D，然后最后发现D和用户的需求Z毫无关系。

这里按“参数尚待脚本计算”处理。路径字符串由脚本表达式或前序工具结果提供；目录创建由脚本中的正常工具调用完成；后续 Shell 接收已求值的路径，再进入原请求准备和组合权限检查。

2026-11-06 用户更新执行授权与终态：

> 然后请你准确高效地进行实施。

> **目标终态**：<verified-implementation-and-commit>

> 审计材料只由 `adversarial-auditor` subagent 加载；primary agent 不预读、不自审。

> 收到 blocker 后，先核对其对应的用户需求、必须保持的行为和具体后果，再决定是否修正，不要上来就认为是自己的问题。

> 复议消息只提供事实和引用，不提供期望 verdict、范围收缩或收敛压力；auditor 的复查结果作为本轮最终 verdict。

> 保持高效，不要花大量的时间说自己没做什么。没做什么你就立马去做。

> 不读取不必要的东西，不做不必要的事情。

后续以精确修订独立方案批准、TDD 实施、验证、独立实现批准和本任务中文多行提交为终态；不得 push、amend 或跳过 hook。执行仍由 primary 完成，独立审计使用用户新授权的 adversarial-auditor。

实现复审后的用户收尾选择（question 工具返回原文）：

> 类型检查收尾：“交给并行任务”
>
> 共享文件提交：“按片段分离提交 (Recommended)”

对应问题说明明确授权按 hunk 准备本任务提交，完整保留并行工作区和暂存内容，继续执行 hooks，审计通过后提交且不推送。token/accounting fixture 的类型修复继续由并行 owner 负责。该选择细化提交边界，保持 R7 产品需求与实现范围。

2026-11-06 R7 提交后，用户更新架构与提示词要求（以下均为原文）：

> 上游提示词如何的，本地的提示词如何的，本地这提示词只有工具的提示词只有一句话吗？什么意思？按理来说需要使用点txt去组织完整的 prompt。同时你不得进行任何形式的转述，必须完整准确复刻上游的 prompt 逻辑。

> 然后还有一点，我发现你这个统一工具编排这一套逻辑，你整体一共改了几十个文件，四十九个文件。每一个文件都是必要的吗？你能这个文件的改动能降低到比如说三十二个文件呢，或者说多少个文件以下吗？这看起来很多，感觉都很不必要啊，它真的有必要这么高的复杂度吗？

> 按照我的理解，我甚至希望的是，我们具体的东西就是只加个别的这种适配层，然后以及这种这个工具的入口点，其他就完了。你不要去过分地去增加各种什么各种各样的针对工具的一些各种各样的 test，那没有必要。按理来说工具甚至都可以不用改，比如说什么 read 工具，edit 工具，scale 工具等等东西，那直接从外面去调用不就完了吗？你为什么非要去把它做成这种每一个东西每一个工具还要自己去主动地去支持加入呢？按理来说直接上游统一去支持不就完了吗。

> 话言之，我不知道上游是怎么做的。当然如果上游去对每个工具都进行了一个适配，那我觉得你可以这样做。但如果上游本身都没有采用这样的思路，我建议你不要这样做。但请你保持高效，保持efficient，你不要去一直在思考思考思考，do something。

> 换言之，按照我的理解，一个好的修改架构是修改一处核心点就能够泛用到其他地方，而不要修改一处为了泛用又把其他的东西都给修改掉。但是同时你也不能不泛用。就比如说你修改一处，直接就能够让它去支持当前的所有的工具啊，巴拉巴拉的东西。你不要再去尝试试图把工具的 schema 变成这个什么 unknown 啊，巴拉巴拉的东西。按理来说，如果它是 unknown 的，那你也不得以这种把这个什么变成什么 preview 啊，巴拉巴拉这种形式允许它去做匹配，这是禁止的。所以请你注意这一点。就是你不允许，我不允许你对工具的 schema 进行大改，或者说使它去做这种 unknown 的一个行径。如果 Codex 等等东西它没有这样做过，那我认为你也不应该这样做。这本身是对工具的语义造成破坏性的修改。

> ？我们说过这个问题啊 我当时说的结果就是每一次进行执行前都直接先去预审一下，预审就是对整个 execute 的底层工具全部都预审一遍。预审完之后，如果没有发现 Causa、杂等等这种御医的内容，那就不需要去对全局进行审计。如果有的话，那就直接上升到全局的这种审计逻辑，先去审计一遍，后续底层在执行的时候，只要它不超过顶层的这个权限分级，那就可以被允许。

> 譬如脚本先创建文件后调用被拒绝的工具，按理来说你在执行前就能分析出来到底哪些是工具，巴拉巴拉东西，那不应该你什么东西你都不知道啊。你这套逻辑就是很奇怪的。

随后用户明确允许采用更简单的实际调用边界：

> 或者必要的话你也可以这样做，就是如果你觉得第一次的预审非常复杂的话，你也可以这样做，就是第一次先直接去送去把它执行，当执行到遇到 Cautious 的这种工具的时候，先 hang住，先等待住，对全局进行审计，审计完通过之后再继续。

> 这一块你应该去对齐什么Codex他们等等都是怎么写的。我们之前都已经讨论过好多次了。

R8 采用最后明确允许的运行时暂停路线，保留整段 AUTO、同级批准复用、升阶、真实 schema、开关、取消和结果归因；撤下逐工具 preview 及仅供静态预检的接口。该选择替换 R7 的静态初审时机，属于用户授权的主路径调整，具体范围见第 25 节。

R8 实施期间的 Git 操作授权原文：

> 请注意一点，在你修改之前，请你将你的FEAT XQUTE撤回到工作区。然后其他的FIX、STATUS接上，也就是把你的那么一个修改的节点单独去撤出来，撤到工作区。

已在独立临时工作区把 `566aebc540 fix(stats)` 重放到 `7e8ad09c3b fix(tui)` 后，得到 `72c2142d47`；range-diff 为等价。当前分支 mixed reset 到该基线，71个现存工作文件原始内容hash相同，2个已删除静态文件保持缺失，index为空。该操作只改变提交归属，R8批准的源码/接口未变化。临时工作区清理被权限预检拒绝，目录保留于 `D:/Temp/opencode/execute-uncommit-20261106`，等待单独清理授权。

R9 输出契约需求原文：

> 既然你都修改到了这个程度了，我现在有一个问题需要去斟酌一下。我不知道它在使用 JS 去调用的时候，那每一个工具它返回的结构是什么呢？它是按照那个 return 的那个东西去处理吗？那 return 的那些东西，模型有知道它会 return 什么吗？还是说怎么样呢？按理来说这些东西是不是会包含在 prompt 里面，还是说怎么样？你可以简要地高效地看一下上游是如何处理的。然后与此同时你也可以花百分之二十的，或者说百分之十的精力，也去看一下我们目前仓库中的每个工具，看一下它们的返回的形式，有没有返回一些冗余的，或者说不必要的一些字段，或者各种各样的一些内容。因为按理来说相应的这个字段，各种各样的一些内容，适当地去保持，即便不说正交，但也是这种不要过度冗余，啊，巴拉巴拉的。然后这样的话，它能够更加方便模型去利用啊，去解析啊，就是相应这个内容去包含完整，或者说包含全，但是也不要去过多地去把一些无意义的这些东西去进行一个包含，比如说各种各样的元数据，各种各样的元参数。那可能有很多东西是对模型的任务没有任何帮助的，那些东西其实本质上可以不包含也可以。但是现在就是针对这些内容呢，你可以去为我去调研并且叙述一下，保持高效即可。

调研后用户要求实施对齐：

> 应当对齐这套写法，同时保持你的修改简洁、准确，不要过度复杂，不要过度重复去造轮子。比如某些逻辑，或者说各种各样的逻辑，本身如果是能复用的话，请你尽量去复用，避免去大幅增加代码，或者说大幅去增加各种各样的一些逻辑内容。

> 当然，就逻辑可以进行一定的扩展，巴拉巴拉，适职适配你这套逻辑。也就是说，如果当前有现成的这些工具函数可以用，那如果它用起来麻烦一点，你本质上你可以简要地去扩展，使其保持泛用性，巴拉巴拉的。这样的话就能够以较小的代码修改，或者较高的代码性能收益，避免你自己去造轮子。

R8 验证期间用户选择 `由并行任务修复 (Recommended)`：`packages/core/test/permission.test.ts:1030` 的 run 参数需同步该任务新增的 LLMError 流类型，本任务保留其工作。该验证归属与 R9 输出设计独立。

## 2. Explicit Non-Goals

1. 不移植 V2 SessionRunner、Location、Tool.Service、Guardian V2 或整套新版解释器；不增加 OS sandbox、任意 fetch、持久 JS kernel。
2. 不提供整个脚本的事务回滚、崩溃续跑、从头自动重放、预执行后撤销。已完成的文件或远端操作保持事实状态。
3. 不修改普通工具现有 AUTO 分级、租户策略、reviewer 模型、重试次数或基础设施失败策略；本次批准复用只存在于一个 execute 调用内。
4. 不新增执行模式开关、审批凭证数据库、跨 execute 缓存、任务 DAG、全程序符号执行器或每种插件各自的 adapter。
5. “全部工具”以当前 V1 Agent 的有效工具表为边界，包含 native/custom/plugin/MCP/resource 工具。保留模型选择 edit/write 或 apply_patch 的既有规则；不开放隐藏审批工具。上游 session_move、artifact、schedule 等未在 V1 注册的产品功能不是通过 execute 直接导出内部服务，本次不声称实现这些新产品功能。
6. 不改 Tool Toggle 的持久化字段或现有 allow/deny 含义。重新启用写 allow 的现状保留；allow 不能伪造本次 execute 的获批风险等级，组合调用仍按本计划逐次 pre-check。
7. 不修改已有 TUI chrome 工作、历史归档方案、第三方源码或 CI。不推送；仅在精确方案与实现均独立获批、验证通过后提交本任务路径。

## 3. Repository Context

当前基线：`dev1-smark@7e8ad09c3b`，此前 TUI chrome 工作已另行提交。stats 及其它方案仍有并行修改；它们不是本任务改动，不能还原或调整其暂存状态。未来修改同一文件必须在最新内容上叠加。第 18 节保留原实验的 `321a3ffedd` 基线；当前安装的 Effect 已是 beta.83，不把旧环境失败当作持续阻塞。

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | Schema/Core/Server 依赖方向；不新增 any、重命名 import 或星号 import；包内 test/typecheck |
| `packages/opencode/AGENTS.md` | V1 Effect/InstanceState/EffectBridge 生命周期；宿主上下文必须显式注入 |
| `packages/opencode/src/session/llm/AGENTS.md` | AI SDK/native 共用 opencode-owned 工具，不能各做一套 execute |
| `packages/opencode/test/AGENTS.md` | testEffect、真实临时文件/MCP transport、Deferred 同步，不靠 sleep 碰时序 |
| `packages/codemode/AGENTS.md` | 解释器只拥有解析、受限执行和显式工具；审批、持久化和 Session 归宿主 |
| `packages/core/src/tool/AGENTS.md` | 不把 V1 改造塞入 V2 canonical registry；本计划不修改该目录 |
| `CONTEXT.md:39-54,116-125` | provider-turn 边界、模型可见输出、指令交付和捕获的 Agent 身份；不把 V2 规范假装成已有 V1 实现 |
| `docs/adr/README.md` | 当前唯一 ADR 是 triage，无 execute 专项 ADR；本次不新建第二份设计规格 |
| first-principles policy/template | 逐项前向/反向追踪，禁止新增 fallback；实现需独立审计及 15% 中文解释性注释 |
| `docs/workflow.md:27-43,45-71` | 先完成方案阶段隔离验证，再考虑独立审计；不能用静态阅读或自查冒充执行验证及批准 |

`packages/core/AGENTS.md` 不存在；不从不存在的文件推导约束。没有新增依赖、数据库列或公共 HttpApi，因此不触发客户端生成。

R2 修订依据：29 项隔离机制验证与 237 项现有 V1 解释器回归通过。移除 R1 的常量传播/工具别名静态推导，补齐未知字段表示、真实参数验证及计划阶段证据边界；不改变用户选定的整体预检和按等级升阶路线。

R3 修订依据：增加 ShellTool 请求构造及内存候选改动的 9 项验证，两组隔离验证合计 38 项通过。撤回 R2 的“command 已知、workdir 未知时拼部分请求送预检”方案；未知值只属于静态分析结果，不进入真实权限请求。不能形成原 Shell 完整请求的调用留待运行时，以已求值参数走原流程。

## 4. Files and Evidence Read

以下范围对应本次计划直接使用的证据；同版本已读内容复用，没有借用前一轮的“已批准”结论。

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `tool/code-mode.ts:39-65,134-185,188-310` | MCP-only 目录、重复 MCP 传输/权限、合成 child ID、取消和附件 | observed |
| `tool/registry.ts:124-128,134-189,217-278,298-366` | native/plugin 构造、实验开关、空 MCP 时过滤 execute、模型工具选择 | observed |
| `session/tools.ts:88-220,222-602` | 最终调用宿主、Goal 注入、真实快照屏障、MCP/resources 和 Shell abort 特例 | observed |
| `session/prompt.ts:1442-1455,1613-1621,2033-2056` | user.tools 转 Session permission、每 provider step 重读 Session、resolve 调用点 | observed |
| `session/llm/request.ts:58-67,223-235`; `llm/native-runtime.ts:213-236` | 最后可见性筛选；两种 provider runtime 复用相同 execute callback | observed |
| `tool/tool.ts:38-70,130-190` | 原生 Context/ExecuteResult、prepareArguments、Schema decode、sanitize/truncate | observed |
| `session/processor.ts:139-174,321-362,395-474,485-529,700-764` | 真 ToolPart 注册、更新、settle、快照、truth metadata 和失败清理 | observed |
| `session/message-v2.ts:843-934`; `session/summary.ts:39-47`; `session/revert.ts:89-128` | 模型回放、真实已完成工具 diff、同 Assistant 的 declared/ambient 归因 | observed |
| `tool/read.ts:106-190,204-232,600-705`; `tool/glob.ts:49-93`; `tool/edit.ts:64-121` | 展示文本不等于程序数据；read 可见性；真实修改历史 | observed |
| `tool/skill.ts:34-91`; `session/instruction.ts:16-30`; `tool/goal.ts:59-129`; `tool/task.ts` 的 ctx.metadata/abort/父读取摘要调用点 | 指令不能被脚本 return 吞掉；Goal 与 Task 使用真实 Context | reachable |
| `tool/shell.ts:298-347,442-499,645-684,833-879` | 一个命令可产生多个权限请求；原 grammar/cwd；取消等待进程 scope 清理 | observed |
| `tool/apply_patch.ts:280-368`; `tool/external-directory.ts:16-47`; `patch/index.ts` | patch 先形成真实 proposal/diff 后授权，外部目录请求和 parser 可复用 | observed |
| `permission/index.ts:74-255`; `permission/cache/session-cache.ts:32-83` | raw deny、allow/ask/auto、缓存、熔断与事件的唯一 owner | observed |
| `core/src/permission/auto.ts:48-135`; `precheck.ts:225-263,424-470,494-575` | 分级、预检来源、同级 reasons 与整体风险聚合区别 | observed |
| `permission/reviewer/service.ts:146-198,1083-1129`; `core/src/permission/reviewer/prompt.ts:100-127` | 整体 planned action 可经 metadata 送入现有 reviewer；审查显示绑定真实父 ToolPart | observed |
| `schema/src/v1/permission.ts`; `schema/src/v1/session.ts` | 不扩展 wire schema；已有 ToolPart.metadata 可承载宿主 parent 标识 | contracted |
| `codemode/src/interpreter/runtime.ts:115-149,600-775,3340+`; `codemode.ts`; `tool-runtime.ts:570-609,710-806` | 共享 TS→Acorn、并发 8、未 await 清理、JSON 边界、interrupt 不变成脚本 catch | observed |
| `tui/src/component/dialog-tool.tsx:18-68`; `tui/src/routes/session/index.tsx` 的 ToolPart/Execute | 开关实质是 Session permission；已有父调用子列表渲染 | observed |
| `test/session/tools.test.ts`; `test/tool/code-mode*.test.ts`; `test/tool/registry.test.ts`; `test/permission/auto.test.ts` | 现有 seam、真实 MCP fixture、AUTO 路由及原有回归 | observed |
| 第 18 节四项 Bun 原地实验 | parser 形状、真实 precheck 等级、低风险零 review 的当前反馈 | observed |
| `D:/Temp/opencode/execute-plan-proof-20261106/proof.test.js` | 29 项机制、真实 runtime/schema/read owner 验证；范围与替身见 18.2 | observed |
| 同目录 `shell-request.test.js`、`shell-build.ts` | 7 项原 ShellTool 请求链 + 2 项内存候选验证；发现并验证静态准备不得启动路径助手的具体改动 | observed |
| 同目录 `dist/{codemode,promise,enumeration,signature,stdlib,parity}.test.js` | 237 项由当前仓库原测试构建的解释器回归 | observed |
| 上游 v2.2.5 `9bbb8ce18c80` 的 tool/codemode；本地 Codex `481cb038c2` 的 tools/code_mode、orchestrator、Guardian V2 approval | 仅作为接口/授权对照，不成为额外移植范围 | observed |

表内无前缀的 V1 路径属于 `packages/opencode/src`，测试属于 `packages/opencode`；codemode/core/tui/schema 均明确标包。

## 5. Current Behavior

```text
ToolRegistry native/plugin definitions
    -> SessionTools.resolve -> plugin hooks / Tool.Context / snapshot barrier
    -> AITool.execute -> AI SDK 或 native provider adapter
    -> SessionProcessor 真 ToolPart -> UI / Summary / Revert / 模型回放

当前 execute:
ToolRegistry.describeCodeMode -> MCP-only catalog
    -> CodeModeTool 再次读取 MCP
    -> 自己调用 client.callTool + ask + hooks
    -> 父 metadata.toolCalls（没有真正的子 ToolPart）
```

原生工具本身不缺编排所需的能力；第一个断点是 execute 建目录时只读取 MCP，第二个断点是执行时绕过 SessionTools 的宿主链。仅增加 native 函数到工具树会遗漏 Goal 受信上下文、快照、权限进度和子调用终态。

权限按实际请求决定。普通 `Permission.ask` 的 allow 可能提前返回；auto 分支 safe/general 直过，cautious/dangerous 送审，forbidden 拒绝。当前没有“同一次 execute 已获批等级”的生命周期。

Tool Toggle 每次修改 Session；prompt 每 step 重读，现有 execute 开始时也重读一次，但其闭包在运行途中不会刷新。现有 read 的 stub 是给已经看过正文的模型使用，不能直接当成新脚本已经拿到了文本。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| JS/TS 脚本、await/循环/并行 | 模型 execute.code | 字符串，内容不可信 | prepare → interpreter | codemode | contracted |
| 字面量、const、别名、动态工具名/参数 | 同一脚本 | 动态部分不能静态确认 | static analysis / runtime invoke | codemode + host | reachable |
| native、plugin、自定义工具、MCP、resources | 当前 registry/MCP 服务 | 描述和 schema 存在，能力受可见性约束 | 一个 SessionTools inventory | SessionTools | contracted |
| 多权限的一次工具调用 | shell/apply_patch 的多个 ctx.ask | body 负责产生真实 command/diff/path | execution.ask → Permission | Permission | observed |
| 同等级多次调用、风险升阶 | 脚本分支、循环、并行 | 本次批准仅限本次脚本 | execution-scoped allowance | Permission | contracted |
| 运行中 toggle/MCP tool 移除 | Session 更新/MCP catalog 更新 | 不是编译时常量 | 每次实际 invoke 前检查 | SessionTools | contracted |
| abort 与审批拒绝 | 用户/现有 reviewer | 取消和拒绝不能被脚本吞掉后继续副作用 | 同一个 controller → 子调用/审查 | SessionTools + processor | contracted |
| 中间 read/skill、图片和 Task | 普通工具真实结果 | 模型和脚本是不同消费者 | 程序值/强制交付上下文/附件 | 工具结果 + code-mode | reachable |
| shell/MCP 等不可撤销效果 | 既有工具 | 没有通用事务能力 | 已完成子 ToolPart | 原工具 | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 所有当前可用的用户工具均可由 execute 调用；禁止 execute 递归和内部审批/修复工具 | 用户原文；registry 模型/隐藏过滤 | registry.test.ts，需新增全目录场景 |
| INV-02 | 直接调用与子调用只经过一份宿主执行、hooks、验证和副作用路径 | SessionTools.resolve | session/tools.test.ts |
| INV-03 | 顶层在任何子工具副作用前完成静态预检；已识别的 forbidden 阻止整段启动 | 用户选择 | 新增 execute 场景 |
| INV-04 | 本次允许等级按 safe/general → cautious → dangerous 单调提高；同级复用，升阶补审；forbidden 不送 reviewer | 用户明确要求；LEVELS | auto/precheck 测试 + 新增 execution 测试 |
| INV-05 | deny 和显式 ask 不被父批准吞掉；allow 不能把本次等级提升为 dangerous；不向 Session 缓存写整段批准 | Permission 当前策略 + 用户 AUTO 需求 | permission/next.test.ts + 新增 |
| INV-06 | 每次真实调用按当前工具可用性检查；已关闭、已移除工具不能开始 | 用户明确要求 | 新增 toggle/MCP 移除场景 |
| INV-07 | 用户 abort/终局拒绝停止新调用、传播取消并等待宿主清理；不会重放已完成操作 | 用户选择 | 当前 code-mode cancellation、Shell 清理测试 |
| INV-08 | 每个真实子调用具有独立 callID/ToolPart；其修改归因、partial、审查和终态可追踪 | processor/revert 现有合同 | 新增 processor + revert 组合场景 |
| INV-09 | 主模型只回放父 execute 回执；中间 ToolPart 不伪造 provider tool_use/tool_result | message-v2 转换合同 | 新增消息转换场景 |
| INV-10 | 脚本可以获得真实 read 页面/搜索路径；不会拿 stub/XML 当原始文件 | read/glob 实际返回值 | read/glob 与组合用例 |
| INV-11 | read/skill 上下文不受脚本 return 控制；父 execute 成功时附件沿原协议交付；截断必须保留恢复事实且不伪报 loaded | 现有工具交付合同 | code-mode media + 新增上下文场景 |
| INV-12 | 同一 scope 的并发升阶只进行必要审查；等待批准保留 JS 变量/前序结果 | 用户性能与连续性要求 | 新增 Deferred 审查事件场景 |
| INV-13 | 保留 V1 Promise 语义和并发 8；不引入 V2 runner/network/kernel | 用户保持 V1 | codemode/promise.test.ts |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| 01/02 | registry 的 execute 目录和 CodeModeTool executor 各自读取 MCP，未接受 session inventory/invoker | SessionTools / CodeModeTool | code-mode.ts:210-230；registry.ts:298-306 |
| 03/04/12 | interpreter 开始执行之前没有公共 prepare/analysis，Permission 只有一次 leaf ask 的生命周期 | codemode Runtime；Permission.Service | runtime.ts:115/3367；permission/index.ts:74 |
| 06 | catalog 与 ruleset 闭包只在执行开始读取 | SessionTools 每次调用入口 | code-mode.ts:207-212；tools.ts:151 |
| 08/09 | 合成 child callID 没有登记 ToolPart；直接补登记又会被模型回放器当作真实 provider 调用 | SessionProcessor / MessageV2 | code-mode.ts:227；processor.ts:485；message-v2.ts:843 |
| 10/11 | Tool.ExecuteResult 没有区分程序结果与不可丢弃的上下文；read stub 按模型历史判断 | Tool / read / skill | read.ts:605；skill.ts:41 |

这是新能力的实施计划，不把未实现能力伪装成已重现的线上 bug。红测试 seam 是真实 `SessionTools.resolve(...).execute.execute({code}, options)`：无 MCP 的 native 调用当前没有可用 execute，且没有批次审批范围。既有测试启动失败与依赖版本问题见第 18 节，不能计作功能红灯。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 同一程序的解析/静态调用事实 | codemode program / Runtime.prepare | 同一 AST 用于分析与执行；无工具副作用 | 已拥有语言语义和 parser | Permission 不解释 JS |
| 字面参数到权限请求事实 | 原生 Tool.Def.preview | 只描述能确认的权限需求 | shell/patch/path 已有真实解析 owner | execute 不复制 shell/patch parser |
| 工具集合、当前成员检查、调用 Context | SessionTools.resolve | 一个 inventory、一个 invoke，两个呈现入口 | 已拥有 native/plugin/MCP/resources 汇合点 | registry 不拥有每轮 Session/Goal/processor |
| 等级批准、并发升阶、事件/缓存策略 | Permission.Service.beginExecute | 本次执行范围的 precheck/check/ask | 复用现有 AUTO/reviewer routing | 解释器不应了解风险等级 |
| 子调用真实持久化/settlement | SessionProcessor | 复用 start/update/complete/fail、快照与 truth metadata | 已拥有 ToolPart 生命周期 | code-mode 不直接写数据库 |
| 程序结果、附件、必须交付的上下文 | Tool.ExecuteResult / CodeModeTool | 不丢弃语义、不解析展示字符串 | 两个真实消费者已有不同需求 | UI 不重建结果 |
| 模型只看父回执 / UI 分组 | MessageV2 / TUI ToolPart | 子记录可审计但不冒充 provider 调用 | 投影 owner | 不使用 hidden 隐藏子记录，避免被 summary/revert 排除 |

## 10. Single Approved Primary-Path Design

本 R7 的主路径如下；批准状态由第 22 节的独立审计记录决定。

### 10.1 调用链与唯一工具表示

```text
registry.tools + custom/plugin + MCP + MCP resources
  → SessionTools 中统一为现有 Tool.Def
  → ToolSelection.filter（Agent、Session、user.tools、模型选择）
  → eligible inventory
       ├─ direct AITool definitions + invoke 的 Promise 桥
       └─ execute Host：catalog + prepareReview + invoke
             → 同一个 invoke
             → processor.runChild（仅子调用拥有的生命周期）
             → hooks / Tool.Def.execute / ctx.ask / result
```

不增加第二个 registry 或全局 executor service。MCP/resources 的薄 Tool.Def 构造留在 `session/tools.ts`；MCP transport/result 的实现留在 `mcp/catalog.ts`。已有 local 及 MCP 的重复 hooks、timing、附件身份、abort notice 包装收敛到同一个 `invoke`，不是复制一份到 CodeModeTool。

`ToolRegistry` 始终注册 execute 基础定义，取消 V1 实验旗标和“必须存在 MCP”条件。基础定义不持有具体 Session 目录；`SessionTools.resolve` 在实际请求时补齐说明及可信 Host。debug/HTTP 的 registry definition 调用保持可读取基础 schema，不需要构造可执行 Session。

目录约定固定为：native/custom/plugin/resources 使用 `tools.$opencode[原工具ID]`；现有 MCP 保留 `tools.<server>.<local>`。`$opencode` 不会与 MCP server 冲突，现有 sanitize 明确排除 `$`。不新增 tools.local 等同义别名。

MCP 先进入 eligible inventory，再做呈现投影：execute 启用时 MCP 放在脚本目录；execute 被关闭时仍以原 flat ID 直接提供。原生/custom/plugin/resource 的直接调用保留。两种投影共享同一 executor，不是执行失败后的 fallback。

内部排除：execute、invalid、_noop、StructuredOutput、permission_review_decision。隐藏 reviewer 的决定工具绝不能通过目录搜索或猜名字找到。模型选择的 edit/write 与 apply_patch 仍取 registry 结果，不自行扩大。

### 10.2 冻结的内部接口

以下是新增接口的完整职责，都是进程内类型，不进入模型输入或 SDK。

```ts
// tool/tool.ts，保持原 ExecuteResult 三个必填字段
type PermissionRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

interface Def {
  // 仅返回静态可确认的请求；没有 preview 的扩展仍可执行。
  preview?(
    input: CodeMode.StaticInput,
    context: Pick<Context, "agent">,
  ): Effect.Effect<readonly PermissionRequest[]>
}

interface ExecuteResult {
  // 缺省时脚本获得 { title, output, metadata }；MCP 保留原 structured/text 值。
  program?: { value: unknown; attachments?: Attachment[] }
  // 仅 read/skill 产生，宿主必须投递，脚本无法通过 return 丢弃。
  context?: { kind: "instruction" | "skill"; key: string; text: string }[]
}

interface Context {
  codeMode?: CodeModeHost // 只给父 execute 注入，子调用没有此字段
  executeParent?: string // 真实父 callID，只由宿主写入
}

interface CodeModeHost {
  catalog: readonly CatalogEntry[]
  signal: AbortSignal
  prepareReview(code: string, calls: readonly StaticCall[]): Effect.Effect<void>
  invoke(id: string, input: unknown): Effect.Effect<ExecuteResult, unknown>
}
```

`CatalogEntry` 固定字段为 `id / path: string[] / description / inputSchema / outputSchema?`。catalog 不携带 Permission service，也不接受模型提供的 callID、Session、风险等级。`program` 的未知值仍通过现有 SandboxTool 输出 schema/plain-data 检查；附件只在宿主处理，不把 base64 放进脚本。

目录的 schema 使用现有 registry 的 JSON Schema。类型检查已确认 registry 的 JSONSchema7 允许 boolean 子 schema 与 tuple items，而 codemode 的 JsonSchema 声明只描述对象节点。原 renderer 实测已将 boolean 显示为 unknown、tuple items 显示为 Array<unknown>，字段名称和 required 标记均保留。

P30 保留 `JsonSchema` 的对象形状，新增 `JsonSchemaNode = boolean | JsonSchema` 表示嵌套节点；anyOf/oneOf/allOf/properties/$defs/definitions 使用节点类型，items 使用 `JsonSchemaNode | JsonSchemaNode[]`。`SchemaType`、OpenAPI.projectSchema/withDefinitions 的对象入口保持原类型，继续直接读取 description/$defs。P31 的递归展示函数消费节点：boolean 和 tuple 数组按原结果显示 unknown，字段说明只从对象节点取值。实际隔离包已经替换这两个文件的类型和分支，连同原 OpenAPI 全部源码完成 `bun typecheck` 与 264 项测试。

`CodeModeHost` 定义在 `tool/code-mode.ts`，tool.ts 只作 type import；宿主由 SessionTools 构造。CodeModeTool 不再取得 MCP、Agent、Session、Plugin 服务，不再自己授权或调用 transport。

### 10.3 prepare 与静态分析

新增 `packages/codemode/src/program.ts`，把 runtime.ts 的 `parseProgram` 原样移入，只保留一份 TS→Acorn 入口。该文件也拥有 AST 的只读分析，不引入新的 parser 依赖。

`Runtime.prepare(code)` 返回 `Failure | { ok: true; calls: StaticCall[]; execute(): Effect<Result> }`。prepare 只解析和分析；execute 捕获同一 ProgramNode，在 `Effect.suspend` 内建立一次新的解释器状态。现有 `runtime.execute(code)` 委托 prepare，保留现有结果及错误类型。审批等待不消耗程序执行 timeout，沿原宿主“进入 runtime.execute 后开始计时”的合同。

静态输入合同改为以下精确形状，类型由 codemode 导出；去掉不足以区分“省略”和“未知”的单个 complete 布尔值：

```ts
type StaticInput = {
  known: Readonly<Record<string, Schema.Json>>
  unknownKeys: readonly string[] | null
}
type StaticCall = StaticInput & {
  path?: readonly string[]
  location?: { line: number; column: number }
}
```

规则固定如下：

1. 只静态识别未被遮蔽的 tools 根、点成员和字面字符串下标。const 参数引用、工具引用别名、动态计算名称都留给真实运行时；它们仍可执行，但不为预检增加数据流分析器。
2. 已知值只含 JSON 字面量、无插值 template、递归的字面数组/对象和负数字面量。**不求值函数、getter、运算表达式、const 引用或远端结果**。这样 const 对象后续被改写时，不会错误复用声明时的旧命令。
3. 按 V1 真实绑定规则扫描：Program/block 入口提升的函数声明、函数参数、catch body 参数和 for body 声明可确定遮蔽。循环的 right/init、catch 参数初始化先按外层绑定扫描。普通 var/let/const 声明按“潜在宿主调用”保留候选，因为 V1 在执行到声明时才登记绑定；命名函数表达式同样沿用外层绑定。这样去掉原型里的 var 提升推断，保留有限候选扫描。普通局部变量导致的保守候选与未调用分支使用同一预审合同。
4. 已知且不被后续 spread/computed key 覆盖的属性放入 known；未知值的确定键放入 unknownKeys。未知 spread/键可能覆盖之前属性时清除这些已知值并令 unknownKeys=null，后续显式字面属性仍可形成已知事实。只有 unknownKeys 为数组且不含该键、known 也无该键时，preview 才能应用“省略字段”的默认值。
5. 扫描函数体和分支中的潜在调用，但不展开循环、不执行分支。静态事实表示“可能执行”，不是已执行日志；未被调用的高风险分支可能导致保守预审，这是选定方案的代价。
6. 参数随脚本计算得到的调用记录为 unresolved，静态报告携带已知字段和待计算字段名。顶层使用已经取得的请求聚合等级；事实集为空时以 general 进入运行。每个调用真正到达宿主时，对已求值参数生成完整请求并执行预检；升阶等待整段审查，批准后续跑当前调用。

原生 preview 的范围只扩展现有解析 owner：Shell 复用现有 parse/collect/cwd 和请求构造；apply_patch 复用 `Patch.parsePatch`；路径工具复用 external-directory 请求构造。preview 只可读配置和必要路径元信息，不执行工具 body、不生成/提交文件修改、不发 MCP 请求、不调用 plugin hooks。

**Shell 参数与目录的具体执行步骤：**

1. 静态阶段提取已写在脚本里的 command/workdir。字段为字面量时调用共享 prepare；省略 workdir 时由 Shell 的 InstanceContext 提供当前目录。表达式字段登记为运行时求值项，整段报告同时携带原脚本供 reviewer 理解依赖顺序。
2. V1 解释器正常执行 JS。表达式或前序工具结果生成路径字符串，`await` 保证生产该结果的工具完成后才进入消费它的调用。
3. 任务需要新目录时，模型在脚本中显式调用创建目录的工具；创建操作走同一宿主、权限、子记录链。创建成功后，后续调用使用实际路径。
4. Shell 收到已求值参数，经原 Tool.wrap 校验，然后执行 `resolvePath → parse → collect → requests`。权限服务使用该次完整请求预检；同级沿本次批准执行，升阶等待审查后续跑。
5. 创建失败或实际进程启动失败时，原工具错误返回脚本。脚本可用 JS catch 处理普通错误；权限拒绝和用户取消按整个 execute 的终止合同处理。路径值的生成、物理目录的创建、权限审批各归原 owner。

例如当前 Windows/pwsh 方言下，模型可以提交：

```js
const directory = "build-" + "check";
await tools.$opencode.bash({
  command: "New-Item -ItemType Directory -Force -Path 'build-check' | Out-Null"
});
return await tools.$opencode.bash({
  command: "Get-Location",
  workdir: directory
});
```

第一条 Shell 在当前项目创建目录，第二条在 `await` 完成后使用计算得到的 `build-check`。第二条的预检发生在其完整参数就绪时；审批暂停保留 directory 和第一条执行结果。

`ask` 请求中的 command/cwd/shell/raw_patterns 均由原 Shell owner 生成。隔离测试已验证动态 workdir 经真实 V1 interpreter 进入原 ShellTool，产生 external_directory 与 bash 请求；另一个测试真实创建临时目录，确认创建完成、目录存在后，原 ShellTool 才生成使用该目录的请求。

另一个实测边界是 Windows POSIX shell 的路径转换：原 resolvePath 可能在权限前调用 cygpath。静态 preview 不得触发这类辅助进程。P12 在原 resolvePath 的该分支、调用 cygpath **之前**识别 preparation mode；preview 返回内部 `PreviewNeedsRuntime` 未决信号，runtime 保留原路径。这一信号只由 Shell.preview 转为零个静态请求，不被原 cygpath 的 catch 吞掉，也不升级成工具执行成功。命令参数中的 POSIX 文件路径同样经原 collect→argPath→resolvePath 到达该判断。

不能静态形成真实 patch diff 时，把原始 patchText、已知 hunk 类型/路径作为证据，真实 diff 仍由原 apply_patch body 在其 ctx.ask 时产生。已知输入自身无效时记录静态输入诊断，不伪造合法请求；若该调用实际发生，原参数验证照常失败。

### 10.4 整体 AUTO 的确切插入点

在 `Permission.Service` 增加一个操作 `beginExecute`，只由 SessionTools 调用：

```ts
type ExecuteReview = {
  check(facts: readonly PermissionRequest[]): Effect.Effect<void>
  ask(request: PermissionV1.AskInput): Effect.Effect<void>
}

// beginExecute 先完成顶层静态审查，返回的两个操作捕获同一个本次调用状态。
beginExecute(input: {
  sessionID: SessionID
  tool: { messageID: string; callID: string }
  code: string
  facts: readonly PermissionRequest[]
  ruleset: PermissionV1.Ruleset
  agent: string
  stop(reason: Error): void
}): Effect.Effect<ExecuteReview>
```

只保留四项调用内状态：`approvedLevel`、`approvedOnce`（strict 首次审查）、`stopped`、一把 Semaphore。事实列表复用 Host 的静态事实和已发起子调用记录，不再复制一份完整脚本/结果到每个 child metadata。无 TTL、额度表、跨进程状态或授权 token。

`permission/index.ts` 从当前 ask 提取三段已存在的责任：`matchRequest`（raw deny/规则匹配）、`reviewAuto`（AUTO/事件/circuit/缓存）、`requestUser`（原 Deferred/pending/Asked 流程）。原 ask 仍按单请求调用；beginExecute 使用同一实现，不复制第二套人工审批或 reviewer 流程。具体顺序：

1. 原 `rawDenyPatterns` 和 `evaluate` 仍先执行；遇 deny 立即拒绝。显式 ask 保留原人工审批，父 AUTO 批准不能替代它。
2. execute 内每次调用都 pre-check，不能被普通 ask 的 allow/cache 快速返回跳过。allow 只解决原规则，不修改 approvedLevel。
3. `PermissionPrecheck.combine` 对本次确认事实取最高等级，保留所有去重 reason 及各自来源；不改变原 bash 的同级 reason 合并规则。空事实集只给组合入口 general 的路由起点，reason 明示没有静态可确认请求；不得据此声称 unresolved 子调用已经检查通过。
4. 首次 safe/general 且非 strict 按现有 AUTO 规则放行，设置允许等级；首次 cautious/dangerous 或 strict 进入 `reviewAuto`。forbidden 始终直接拒绝。
5. 后续 fact 等级小于等于 approvedLevel 时复用本次批准；更高等级在 semaphore 内再次检查，然后以父 execute 送审。批准才提高等级，拒绝则 stop。reviewer 的 low/medium/high/critical 不能冒充 precheck 的五级等级；复用的是送审的 precheck level。
6. `reviewAuto` 仍经 `PermissionAuto.evaluate`、既有 reviewer、事件、circuit、配置失败处理。为避免把合成 permission=execute 重新判成 general，evaluate 增加第四个**进程内** `prechecked?: PermissionPrecheck.Decision` 参数；普通调用省略它。不是接受用户 metadata 中的 level。
7. 组合批准不读写 PermissionSessionCache；原普通调用缓存不变。dangerous 在同一 execute 内可复用是本次用户明确选择；它绝不外溢成下一次 execute 或普通工具的缓存批准。
8. 所有 ReviewStarted/Completed/Failed 以及 reviewer UI 写都绑定父 callID。planned action 带完整 code、静态事实、此次真实触发请求、已完成子调用 ID/结果状态，不携带未过滤的中间工具正文作为授权证据。

显式叶子 ask 与 AUTO 基础设施失败后的 ask 分开处理：前者只批准该叶子请求，不提高组合等级；后者沿已有配置，把当前**整段父申请**交给用户，用户批准该整段才提高本次等级。拒绝均停止执行。不把“用户刚批准了叶子”转换成“整个脚本已经批准”，也不在批准整段后对同一请求重复弹窗。

并发不使用延迟凑批：所有升级经过一把锁，拿到锁后重新比较等级。同级并发等待第一份批准；cautious 审查期间新出现 dangerous 最多再升级一次。低风险执行仍用解释器原并发 8。没有审查失败后换另一套判断器。

固定策略且无基础设施重试时，非 strict 的等级升阶 reviewer 最多覆盖 cautious 和 dangerous 两级；这只是新机制的验收目标，不是当前已实现的性能结果。

### 10.5 子调用与真实生命周期

`SessionProcessor.Handle` 新增一个泛型操作 `runChild`，而非新建第二套日志对象：

```ts
runChild<A extends Tool.ExecuteResult>(
  input: { parentCallID: string; callID: string; tool: string; input: Record<string, unknown> },
  run: Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown>
```

runChild 内部复用 ensureToolCall、updateToolCall、completeToolCall、failToolCall：登记 → running → 执行一次 → 按 Exit settle → 原样返回值/错误。`ensureToolCall` 只增加可选 parentCallID，将 `metadata.executeParent` 作为 server-owned 字段写入。不能置 `hidden=true`，否则现有 Summary/Revert 会排除真实修改。

child ID 为 `${parentCallID}/${sequence}`，sequence 只对实际宿主工具调用递增，目录 search 不占宿主 callID。ToolPart 的 input 是经过 before hook 后实际传给 Tool.Def 的参数；格式化后的 `_syncInput` 等继续由原 completeToolCall 收口。

SessionTools 的 `context(...)` 使用 child callID 更新真实子记录；它的 ask 改由当前 ExecuteReview.ask 接管，并以最新 Session permission 构造 ruleset。Goal 的 `loadGoalTurn` 仍在目标 id=goal 时惰性执行，多个子调用共享同一对象，不克隆 read snapshot。Task/question/plan 使用原 promptOps、Session 和消息上下文，不创建新的 Session runner。

每个子调用照常在 plugin/permission 前调用 `updateToolCall(..., item.worktree)`。因此 declared/ambient 归因自动落在真实 child ToolPart；父 execute 不无条件标 ambient。Summary/Revert 的主算法不改。

child metadata 更新只影响 child；父 `toolCalls` 是现有展示摘要，不能拿它反向驱动权限、文件归因或 settlement。最终查询到的 child ToolPart 是审计事实来源。

### 10.6 运行时成员检查和取消

每次 invoke 固定执行以下顺序：

1. 检查父 signal；检查名称属于本次广告的 catalog，排除内部工具/递归。
2. 读取当前 Session permission，调用共享 ToolSelection.filter；native/custom 检查 registry.ids 当前成员，MCP 检查 mcp.tools 当前成员及连接。新的工具留到下一次 catalog，不因猜名扩大本次能力。
3. 获取真实 leaf、建立 child Context；plugin.before 只调用一次。实际 preview/precheck 使用插件修改后的参数；native 仍由原 Tool.wrap 的 decode 阻止无效参数进入 body，不能沿用修改前参数授权。
4. 进入共享宿主执行。叶子的每个 ctx.ask 都进入组合检查；没有 ctx.ask 的可信扩展至少获得 general 的调用预检，不伪称能理解任意插件内部副作用。
5. 登记/返回真实结果。关闭发生在工具已经被接纳之后不强行撤销；下一次接纳检查就必须拒绝。

隔离实验已经证明 `SandboxTool.make({input: JSONSchema})` 不校验输入：声明 string 的字段收到 number 仍会进入 run。这里不能把 catalog schema 当验证器。native 复用 Tool.wrap；`ToolRegistry.fromPlugin` 对已有 `parameters` 编译一次 `Schema.decodeUnknownEffect`，在 `def.execute` 前应用，并使用原 InvalidArgumentsError。保留原参数值，不额外启用 Zod coercion/transform。legacy JSON-schema-only 插件及 MCP 继续遵从既有执行者/服务端验证合同，不另引入 JSON Schema validator 依赖。

父 execute 使用一个本地 AbortController，连接用户 abort。Permission 拒绝、用户拒绝 question、运行时关闭导致的拒绝都会记录 stop reason 并 abort 本地 scope；它们以 interruption 离开 interpreter，脚本 try/catch 不能继续绕过。普通工具错误仍可由 JS try/catch/allSettled 处理。

宿主保留现有 EffectBridge 与 Bash 的信号特例：共享 `invoke` 是唯一业务实现，直接调用和子调用均通过同一 `run.promise` 桥执行。子调用只包装并等待这一次 Promise；被中断时先传递 signal，再在 finalizer 等待该 Promise settle，不再次调用 executor。普通工具使用原 signal 驱动 Effect 取消；Bash 继续让自身 AbortSignal 触发 kill/drain，等待其原 scope 清理，不能由外层提前丢弃 partial。

finally 删除 signal listener、关闭待审和更新尚未终态的 child。不保存可跨进程 resume 的 JS 状态、不自动重试整个脚本。父失败回执包含失败原因和 completed/error/interrupted 清单；Task 已创建的 sessionId 必须在该清单保留恢复信息。

### 10.7 返回值、上下文与模型回放

native/custom/plugin/resource 脚本返回值统一为 `{title, output, metadata}`，不是假定 read 返回 string、glob 返回 string[]。glob 增加 `metadata.files: string[]`，同时保留 count/partial/truncated；read 使用已有 `metadata.display.text` 和 range。嵌套 read 获得实际页面而非 stub；普通直接 read 的 stub 行为保持不变。示例：

```js
const found = await tools.$opencode.glob({ pattern: "**/package.json" });
if (found.metadata.partial || found.metadata.truncated) return found;
const files = await Promise.all(found.metadata.files.map(async (filePath) => {
  const file = await tools.$opencode.read({ filePath });
  if (file.metadata.truncated) return { filePath, incomplete: true };
  return { filePath, scripts: JSON.parse(file.metadata.display.text).scripts };
}));
return files;
```

MCP 保留已有 structuredContent 优先、文本次之、媒体 marker 的脚本值，以及 media 宿主附件。原 `projectMcpResult` 迁入 MCP result owner，产出可选 program view；直接 MCP 的既有模型文本/截断/附件限制保持原投影，二者共享一次 transport 调用。不会为了取得结构化结果再调用一次 MCP。

read 将真正新发现的指令写入 `result.context`；skill 将完整技能正文写入同一字段。CodeModeTool 收集并放在父输出摘要前，父 metadata 只保存 loaded/skills 的去重 key；脚本 return 不控制这一投递。中间文件正文和二进制不整体拼回父输出。

正常输出仍由原 Tool.wrap 截断并保留完整输出恢复路径。SessionTools 在父 execute 的最终结果标记 `metadata.truncated=true` 时清空 loaded/skills，避免声称未完整交付的规则已经加载；不尝试从截断后的字符串反向推断哪些规则完整。失败回执由已有 Truncate 服务界定 partial/context 文本，再写父 metadata.output。大段上下文可以按原限额截断，但必须有恢复事实，不能静默删除或伪报完整交付。

不新增存储 schema：子 ToolPart 的 `metadata.executeParent` 只是现有 metadata 的宿主字段。`MessageV2.toModelMessages` 跳过这些 child，保留父 execute 的一对 tool-call/result。错误父回执从 metadata.output 交付已经保存的上下文和 partial 清单；不能伪装成 completed 成功。

`SessionCompaction.serialize` 和 `prune` 使用同一父回执可见性：serialize 在现有 tool 分支跳过 executeParent 子记录，prune 在原工具循环计数前跳过它们。压缩模型读取父聚合结果，保护预算只计算模型可见输出；数据库子记录继续服务 Summary、Revert 和审计。修改限定这两个消费点，保持原预算、压缩模型和持久化生命周期。

read 的 `visibleReadMeta` 与旧精确输出匹配排除持久化 child read，因为模型没有看到其中正文。仅在同一次 execute 的后续 child Context 中，SessionTools 把本次已完成子调用投影到临时消息尾部，供 read→edit 时效及 Task 父读取摘要使用；不将这份临时投影写回数据库。

Instruction.extract/Skill 去重只认直接工具或**未 compacted 的已完成父 execute** 上的 loaded/skills；不把一个失败父调用里的隐藏中间结果当成已交付。UI 默认不单独渲染 child 行，复用父 Execute 的工具列表；实际 child ToolPart 仍通过原 Session 数据接口可审计。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 直接调用 / execute 调用 | proposed | primary-contract branch | yes | 两种真实输入入口，同一 invoke | preserve |
| MCP structured/text/media；native envelope | current + proposed | contracted pass-through | yes | 同一执行结果的不同消费者 | preserve |
| safe/general、同级批准、升阶、显式 ask | proposed | primary-contract branch | yes | 用户明确规定，不是失败兜底 | preserve |
| 原 reviewer 基础设施失败配置 | current | existing compatibility | 仅原策略允许后 | 不扩展 | preserve |
| 动态参数或须启动路径助手的准备未决 → 实际调用时预检 | proposed | primary-contract branch | 预检本身不执行动作 | 分析/准备的未决值域，不伪造部分请求 | preserve |
| 无 Host、unknown tool、失联 MCP、parse error | proposed | diagnostic | no | 预计 4/65～80 个改动决策分支，约 5%～6.2% | preserve |
| CodeModeTool 自己 callTool/ask/hooks | current | duplicate | yes | 被同一主路径取代 | remove |
| 审批失败后逐工具重跑、重放脚本、权限降级 | rejected | forbidden fallback | would | 0 | reject |

新 alternate success path 数量为 0。诊断预算按实现时真实分支复算；不得以估算容许吞错。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| invokeChildTool + 直接 client.callTool | 旧 MCP 专用 execute | 公共宿主 invoke 已包含 transport、hooks、权限和取消 | code-mode.ts:134-185、MCP deps |
| describeCodeMode 单独读取 MCP | catalog 尚未来自请求集合 | 同一 eligible inventory 驱动说明和执行 | registry.ts:298-307 |
| empty MCP 过滤 execute | execute 过去只有 MCP 能力 | native 目录也能工作 | registry.ts:328-331 |
| experimentalCodeMode 早 return | MCP 两种展示方式绑定实验旗标 | 由 execute 当前可用性决定 MCP 呈现 | tools.ts:477；runtime-flags 字段 |
| local/MCP/resources 重复调用包装 | 目前分散拼装 | 统一 Tool.Def 后只保留一份 invoke 包装 | tools.ts 四类包装 |

MCP 值投影保留并移动，不删除其协议能力；其它现有兼容规则不趁机重构。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| 全工具/V1，01/02/13 | eligible inventory → invoke；原 schema owner 的目录展示 | P01–P08、P24–P28、P30/P31 | T01/T02/T03/T12 |
| 顶层分析，03 | Runtime.prepare → preview → beginExecute | P01/P02/P03/P08/P10/P12–P19 | T04/T05 |
| 整体 AUTO、同级复用，04/05/12 | Permission 组合 scope → 原 AUTO | P08–P11 | T06/T07/T08 |
| 运行时存在/开关，06 | Host.invoke 接纳检查 | P06/P25/P26 | T09 |
| abort/拒绝/连续执行，07 | 同一 controller + bridge finalizer | P04/P06/P08/P22/P23 | T08/T10 |
| 文件归因/Goal/Task，08 | 真 child ToolPart + 原 ctx | P06/P22 | T03/T10/T11 |
| 聚合结果与模型历史，09 | parent metadata marker → model projection / compaction / prune | P22/P23/P28/P29 | T11/T12 |
| 程序数据、指令、附件，10/11 | result.program/context | P03/P04/P07/P14/P15/P20/P21/P23 | T02/T11/T12 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Runtime.prepare + StaticCall | 03 | parser 是私有且 execute 立即执行 | 需要副作用前检查同一 AST；只增一个公开操作 |
| Tool.Def.preview / Shell 准备模式 | 03/04 | shell/patch/path 事实在各 owner 内；实际 Windows 路径准备会请求 cygpath | 复用同一 prepare，preview 在辅助进程前退出为未决；不 dry-run 用户命令或复制 parser |
| 可信 CodeModeHost | 01/02 | CodeModeTool 当前另取 MCP，缺 Session executor | 必须注入当前目录与唯一 invoke；不是新 registry |
| Permission.beginExecute / 一个 semaphore | 04/12 | 原 ask 没有跨子调用批准生命周期 | 同级并发需共享一次批准；不能用 Session 缓存放大授权 |
| evaluate 的内部 prechecked 参数 | 04 | permission=execute 会被归为 general | 保留真实聚合等级且不重复分类，不改变用户 schema |
| processor.runChild / executeParent | 08/09 | 合成 ID 没有 ToolPart，真 ToolPart 又会被回放 | 复用已有生命周期并在投影层区分来源 |
| compaction 父回执过滤 | 09 | serialize 独立生成模型文本，prune 独立计算输出预算；隔离反例已复现中间正文重传及父回执提前被剪枝 | 两处直接沿用 executeParent 标记，数据库历史保留原记录 |
| codemode 的 JSON Schema 类型对齐 | 01/02 | 原 registry 类型和实际 JSON schema 能含 boolean/tuple；包类型检查在 P04 的 Tool.make 入参报 TS2322 | 修正原 schema owner 的声明及既有展示分支，复用原 renderer；宿主无需新增转换器或断言 |
| program/context 结果字段 | 10/11 | 文本、结构化 MCP、指令和媒体有不同消费者 | 任意 return 会丢指令；反解析展示文本不可靠 |
| 当前 Session/MCP 成员检查 | 06 | 运行中开关和 tools_changed 可达 | 入口 snapshot 不保证后续仍可用 |
| 本次 completed child 消息尾投影 | 08/10 | input.messages 是 provider-turn snapshot | 同脚本 read→edit/Task 需要已完成事实，又不能伪称主模型看过正文 |

没有审批令牌、持久 execution row、全局 capability cache、通用事务、额外 provider runtime 或沙箱模块。

## 15. File-Level Change Plan

### 15.1 生产文件与切点

每一行的数字是**修改切点数量**，不是新增抽象数量。`+/-` 是物理行估算；移动现有逻辑不计有效新增 E。精确位置用符号定位，避免覆盖并发工作后的旧行号。

| ID | File | Action / 切点 | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- | --- |
| P01 | `packages/codemode/src/program.ts` | add / 3 | 移入唯一 parseProgram；只提取字面事实并识别根遮蔽；StaticInput 显式区分未知字段，不做常量/别名传播 | +130～180，含约 35 行纯移动 |
| P02 | `packages/codemode/src/codemode.ts`、`src/interpreter/runtime.ts` | modify / 3+2 | Runtime.prepare；execute 委托 prepare；executeWithLimits 消费已解析 ProgramNode，不再二次 parse | +45～65 / -35～45 |
| P03 | `packages/opencode/src/tool/tool.ts` | modify / 3 | Def.preview、Context Host/parent、ExecuteResult.program/context；wrap 保留附加字段且不绕开 decode/sanitize | +25～40 |
| P04 | `packages/opencode/src/tool/code-mode.ts` | modify / 5 | MCP 集成替换为 Host；prepare→整体审查→执行；结果/上下文/附件；取消终态；通用 catalog | +150～210 / -220～270 |
| P05 | `packages/opencode/src/tool/registry.ts` | modify / 5 | 始终注册基础 execute；删 MCP-only describe/filter；透传 preview；fromPlugin 应用已有参数 decoder；保留原模型/隐藏过滤 | +18～30 / -25～45 |
| P06 | `packages/opencode/src/session/tools.ts` | modify / 7 | 全部工具统一 Def；共享 invoke/桥；真实 child ctx；Host/catalog；实时成员；组合审查连接；结果聚合 | +230～310 / -180～260（主要搬移重复包装） |
| P07 | `packages/opencode/src/mcp/catalog.ts` | modify / 2 | 共享一次 transport；迁入旧 CodeMode MCP program/media 投影，保留 direct 投影合同 | +80～115 / -10～20 |
| P08 | `packages/opencode/src/permission/index.ts` | modify / 4 | matchRequest/reviewAuto/requestUser 从原 ask 提取；beginExecute；等级锁；父事件与拒绝 stop | +180～240 / -30～60（提取的大部分代码只移动） |
| P09 | `packages/core/src/permission/auto.ts` | modify / 2 | 内部 prechecked 参数；沿原五级 routing，不改 reviewer 输出合同 | +5～10 / -1～3 |
| P10 | `packages/core/src/permission/precheck.ts` | modify / 1 | export combine：等级最大值+完整去重原因；不改原 evaluateShell | +12～20 |
| P11 | `packages/core/src/permission/reviewer/prompt.ts` | modify / 1 | planned action 为 execute 时说明本次整段范围、真实升阶触发与已完成状态；仍是不可执行证据 | +8～15 |
| P12 | `packages/opencode/src/tool/shell.ts` | modify / 4 | 同源 prepare/requests；确定参数资格；准备模式透传到原 cygpath 分支，preview 在启动辅助进程前变成未决；execute 复用 prepare | +45～65 / -5～10，原准备代码只移动；run/kill/drain 不改 |
| P13 | `packages/opencode/src/tool/external-directory.ts` | modify / 2 | 提取返回 Request 的 owner 操作；assert 仍通过 ctx.ask，preview 复用 | +12～20 / -5～10 |
| P14 | `packages/opencode/src/tool/read.ts` | modify / 4 | preview；nested read 不返回模型 stub；visibleReadMeta 排除 persisted child；新指令 context | +20～35 |
| P15 | `packages/opencode/src/tool/glob.ts` | modify / 2 | preview；metadata.files 直接取已有 files，保留 partial/truncated | +8～15 |
| P16 | `packages/opencode/src/tool/grep.ts` | modify / 1 | preview 复用外部目录请求；文本/匹配算法不改 | +6～12 |
| P17 | `packages/opencode/src/tool/edit.ts` | modify / 1 | preview 给出已知文件/外部目录与 edit 请求，复用原准备参数；不预测真实 diff | +6～12 |
| P18 | `packages/opencode/src/tool/write.ts` | modify / 1 | preview 给出已知写入/外部目录请求；落盘和格式化不改 | +6～12 |
| P19 | `packages/opencode/src/tool/apply_patch.ts` | modify / 1 | preview 使用既有 Patch.parsePatch 的 hunk/path/delete事实；实际 proposal/Mutation.commit 不改 | +15～25 |
| P20 | `packages/opencode/src/tool/skill.ts` | modify / 2 | context 正文；去重支持父 execute 已交付 skills，不认未交付 child | +10～18 |
| P21 | `packages/opencode/src/session/instruction.ts` | modify / 1 | extract 识别父 execute 已交付 loaded，排除 child 的“仅中间读过”事实 | +6～12 |
| P22 | `packages/opencode/src/session/processor.ts` | modify / 3 | Handle.runChild；ensureToolCall parent 标识；复用 complete/fail 与 cleanup，不造假 provider event | +65～95 |
| P23 | `packages/opencode/src/session/message-v2.ts` | modify / 2 | 模型投影跳过 executeParent child；父失败交付上下文/partial 与 Task 恢复身份 | +12～22 |
| P24 | `packages/opencode/src/session/prompt.ts` | modify / 1 | 给 resolve 传本轮 user.tools；其它 loop/Goal/Provider 编排不改 | +1～3 |
| P25 | `packages/opencode/src/tool/selection.ts` | modify / 1 | 共享当前 request 的 filter 函数，保留 internal、Permission.disabled、ToolSelection.enabled 语义 | +15～25 |
| P26 | `packages/opencode/src/session/llm/request.ts` | modify / 1 | 原 resolveTools 改调同一 filter，去掉复制规则 | +2～5 / -10～15 |
| P27 | `packages/opencode/src/effect/runtime-flags.ts` | modify / 1 | 删除不再使用的 experimentalCodeMode 字段；其它 experimental/native flag 不动 | -1 |
| P28 | `packages/tui/src/routes/session/index.tsx` | modify / 1 | ToolPart.shouldHide 排除 executeParent 子行，继续使用已有父 Execute 组件；叠加当前 chrome 修改 | +2～5 |
| P29 | `packages/opencode/src/session/compaction.ts` | modify / 2 | serialize 与 prune 按 executeParent 跳过子记录，模型上传及保护预算只消费父回执 | +4～8 |
| P30 | `packages/codemode/src/tool.ts` | modify / 1 | JsonSchema 保留对象形状，JsonSchemaNode 表示 boolean 子节点，items 接受 tuple 数组；SchemaType/OpenAPI 对象入口保持原合同 | +12～18 / -9 |
| P31 | `packages/codemode/src/tool-schema.ts` | modify / 4 | 递归 renderSchema/引用/字段说明识别 boolean/tuple；对象入口保持 JsonSchema，保留 unknown/Array<unknown> 展示及字段发现 | +15～30 / -5～15 |

P02 包含两个文件，因此合计 **1 个新增生产文件、31 个修改生产文件**。preview 在原工具内提供小型适配，风险分类由现有 PermissionPrecheck 承担。

### 15.2 关键 diff 合同

以下 diff 明确要替换的接口/条件；不是可以直接 apply 的完整实现补丁。配套实现必须满足第 10 节算法，不能补入另一条备用路径。

```diff
--- packages/opencode/src/tool/registry.ts
- const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
- const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined
+ const codeMode = yield* Effect.promise(() => import("./code-mode"))
+ const codeModeTool = yield* codeMode.CodeModeTool
- const codeModeDescription = filtered.some((tool) => tool.id === "execute") ? yield* describeCodeMode(input) : undefined
- const visible = filtered.filter((tool) => tool.id !== "execute" || codeModeDescription)
+ const visible = filtered
```

CodeModeTool 模块顶层只加载基础 Tool/Schema，不在 ids 初始化期间导入 TypeScript interpreter；运行时包在生成目录/执行的窄作用域动态加载。

```diff
--- packages/opencode/src/session/tools.ts
- if (flags.experimentalCodeMode) return tools
+ // MCP 必须先登记到 eligible inventory，再按 execute 是否可用决定直接呈现。

- const ctx = context(args, options)
+ const ctx = context(args, options, execution)

- ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
+ ruleset: Permission.merge(input.agent.permission, latestSession.permission ?? []),
```

`latestSession` 在子调用接纳及每个真实 ctx.ask 时读取；普通直接调用保持原 request snapshot。禁止为了这几行在每个子调用重跑所有 `tool.definition` hooks 或重建整个 registry。

Shell 的具体拆分限定为以下三个位置，不允许 execute 自己拼请求：

```ts
// shell.ts 内部，捕获的 shell/name 来自原 Shell.acceptable(cfg.shell)。
type PreparationMode = "preview" | "execute"
// prepare 返回现有 cwd 和 Scan；移动原 execute 的 resolve/parse/collect，保留资源释放。
prepare(params: Pick<Parameters, "command" | "workdir">, mode: PreparationMode)
// requests 从原 ask 中提取，保留 command/raw_patterns/cwd/shell/agent 的原构造。
requests(scan: Scan, input: { command: string; cwd: string; shell: string }, agent: string)
```

preview 先按 StaticInput 判断参数是否确定；确定后调用 `prepare(..., "preview")` 和 requests，agent 取第二个可信参数。实际 execute 经原参数验证后调用 `prepare(..., "execute")`，逐个 ctx.ask，然后进入原 run。mode 仅在 prepare→collect/argPath→resolvePath 的路径转换链透传，禁止传进 run 或暴露为用户配置。preview 的内部未决信号必须在 Shell.preview 收口；实际请求不包含 unknown 标记。

```diff
--- packages/core/src/permission/auto.ts
  export function evaluate(input, reviewer?, onReviewStart?,
+   prechecked?: PermissionPrecheck.Decision,
  ) {
-   const precheck = yield* Effect.promise(() => PermissionPrecheck.evaluate(input))
+   const precheck = prechecked ?? (yield* Effect.promise(() => PermissionPrecheck.evaluate(input)))
```

实际提交保留文件已有完整类型，不以这里的缩写引入隐式 any。第四参仅由宿主组合审批产生，不能从 `request.metadata.precheck` 读取。

```ts
// permission/index.ts，进入这里前完成原规则检查；reviewAuto/requestUser 均从原 ask 提取。
const check = (facts: readonly PermissionRequest[]) => gate.withPermit(
  Effect.gen(function* () {
    if (stopped) return yield* Effect.interrupt
    const current = PermissionPrecheck.combine(
      yield* Effect.forEach(facts, (fact) => Effect.promise(() => PermissionPrecheck.evaluate(fact))),
    )
    if (current.level === "forbidden") return yield* stopWithDenial(current.reason)
    if (approvedOnce && rank(current.level) <= rank(approvedLevel)) return
    const decision = yield* reviewAuto(parentRequest(current), current, { cache: false })
    if (decision.action === "deny") return yield* stopWithDenial(decision.reason)
    if (decision.action === "ask") yield* requestUser(parentRequest(current))
    approvedLevel = rank(current.level) > rank(approvedLevel) ? current.level : approvedLevel
    approvedOnce = true
  }),
)
```

`rank` 直接使用已有 LEVELS.indexOf，不创建第二套数值风险表。`stopWithDenial` 写 stop reason 并取消本地 scope。上段 requestUser 只用于原 AUTO 失败策略选定的整段申请；原显式叶子 ask 在前置规则阶段处理，不写整段等级批准。共享锁同时用于顶层和叶子，不能各自持一把锁。

```diff
--- packages/opencode/src/session/processor.ts
  const ensureToolCall = Effect.fn(...)(function* (input: {
    id: string
    name: string
    providerExecuted?: boolean
+   parentCallID?: string
  }) {
    // 原 metadata 构造位置
+   ...(input.parentCallID ? { executeParent: input.parentCallID } : {}),
  })
```

`runChild` 用同一 call map 和 Deferred，不额外建立 child registry；所有退出都进入原 complete/fail，补全 parent-owned 字段不能被 tool metadata 替换。

```diff
--- packages/opencode/src/session/message-v2.ts
  if (part.type === "tool") {
+   if (typeof part.metadata?.executeParent === "string") continue
    toolNames.add(part.tool)

--- packages/tui/src/routes/session/index.tsx
  const shouldHide = createMemo(() => {
+   if (typeof props.part.metadata?.executeParent === "string") return true
    if (ctx.showDetails()) return false
```

上述判断位于模型与 UI 投影层，数据库 history 留给 Summary/Revert/审计读取。压缩的两个入口同样在原位置按父子归属过滤：

```diff
--- packages/opencode/src/session/compaction.ts
  // serialize 的原 tool 分支
- if (part.type !== "tool") return []
+ if (part.type !== "tool" || part.metadata?.executeParent) return []
  // prune 的原 part 循环，位于 token 估算之前
- if (part.type !== "tool") continue
+ if (part.type !== "tool" || part.metadata?.executeParent) continue
```

```diff
--- packages/opencode/src/tool/glob.ts
  metadata: {
    count: files.length,
+   files: files.map((file) => path.resolve(search, file.path)),
    total: totalFiles,
    truncated,

--- packages/opencode/src/tool/read.ts
- const stub = findReadStub(visibleReads, current, file.raw.join("\n").length)
+ const stub = ctx.executeParent ? undefined : findReadStub(visibleReads, current, file.raw.join("\n").length)
```

read 的旧精确输出 stub 分支也必须使用同一接收者判断，不仅改范围 stub。这属于“程序没有正文”的新接收域，不是读取失败后的 fallback。

### 15.3 明确不改的邻接实现

`SessionSummary.computeDiff`、`SessionRevert.revert`、`Mutation.commit`、GoalTool 状态机、Task 子 Session runner、AI SDK/native transport、Schema/Protocol/SDK generated 均保持算法不变。它们通过真实 child ToolPart、原 ctx 与原 executor 自动得到正确输入；T11 必须证明这一点。若实现只能靠修改这些算法才能通过测试，先回到本计划的 child/context 接线检查，不直接扩大范围。

### 15.4 测试文件

| Test file | Action | 覆盖 |
| --- | --- | --- |
| `packages/codemode/test/program.test.ts` | add | prepare/analysis 的值域、遮蔽、动态参数、一次 AST 执行 |
| `packages/codemode/test/promise.test.ts` | modify | prepare 后执行仍保留并发、await、取消的原合同 |
| `packages/codemode/test/signature.test.ts` | modify | registry JSON schema 的 boolean/tuple 经真实公开 catalog/search 保持原展示，入参仍交宿主校验 |
| `packages/opencode/test/permission/execute.test.ts` | add | 真实 Permission service + 可控 reviewer，顶层/升阶/拒绝/strict/显式 ask |
| `packages/opencode/test/permission/auto.test.ts` | modify | 预计算等级与普通 evaluate 兼容 |
| `packages/opencode/test/permission/precheck.test.ts` | modify | combine 不丢同级/低级原因，不降低最高风险 |
| `packages/opencode/test/permission/reviewer-prompt.test.ts` | modify | 完整脚本/触发请求是 planned action，不能被当成人类授权 |
| `packages/opencode/test/session/tools.test.ts` | modify | 真实 shared invoke、Goal 上下文、动态成员和 before hook 改参 |
| `packages/opencode/test/session/execute.test.ts` | add | 无 MCP 的全链、文件/Task/取消/聚合历史和实际 diff |
| `packages/opencode/test/session/compaction.test.ts` | modify | 父 execute 的聚合结果进入压缩请求；子正文保留于历史；剪枝预算按父输出计数 |
| `packages/opencode/test/tool/code-mode.test.ts` | modify | 替换旧 MCP-only harness，保留 JSON/错误/搜索/媒体断言 |
| `packages/opencode/test/tool/code-mode-integration.test.ts` | modify | 原真实 MCP transport 继续使用，从 SessionTools 入口驱动 |
| `packages/opencode/test/tool/registry.test.ts` | modify | 默认 execute；空 MCP 仍可用；关闭 execute 不删除 MCP 能力 |
| `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` | modify | 父聚合行可见、child 不重复显示；保留并发 chrome 测试 |

测试共 3 个新增、11 个修改文件；schema 与压缩验收各放进已有 owner 测试。

## 16. TDD Behavior Slices

主要 seam 是 `SessionTools.resolve` 返回的 execute、`Permission.Service.beginExecute/ask`、`CodeMode.Runtime.prepare`、`MessageV2.toModelMessages`、`SessionCompaction.process/prune` 和已有 TUI 渲染。批准后按以下行为切片实施。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| T01 | 无 MCP 的 build Agent 调用 native glob/read，返回真实文件 | registry 过滤 execute，MCP-only tree 无 native | 共享 inventory/invoke + Host | MCP 原目录、模型工具选择 |
| T02 | native/custom/plugin/MCP/resource 各调用一个，structured 与附件均正确；registry JSON Schema 可直接描述 boolean/tuple 节点 | 只支持 MCP，schema 类型声明窄于原 registry | 同一 Def 汇合和结果投影；原 schema owner 对齐类型 | 原 MCP transport/media、目录展示与宿主校验 |
| T03 | before hook 修改参数后真实修改文件；Goal read→complete；Task 留下子 session | 直接函数绕过宿主，缺受信 extra | 共享 ctx 与 runChild | hooks 恰好一份业务路径、Goal 原 gate |
| T04 | prepare 提取字面事实；参数表达式在运行时求值，前序创建目录成功后 Shell 使用实际路径生成请求 | 无公开 prepare/analysis | 同一 AST 的有限扫描和真实 Shell owner | 原 V1 绑定规则、请求 schema、await 顺序 |
| T05 | 后续 literal forbidden 在第一项写入前被拒绝；含未执行 var、稍后声明、声明初始化、命名函数表达式和循环 right/init | 原 runtime 直接依序执行，旧原型按另一套提升语义漏掉候选 | 保留潜在宿主调用并整体预检；对照真实解释器的副作用 | 已确认局部参数遮蔽仍有效 |
| T06 | 多个 cautious 子调用只有一份父 ReviewStarted/Completed；文件实际全部完成 | 每个 ctx.ask 独立审查 | 同级批准复用 | 不写 Session cache，下一次 execute 再审 |
| T07 | 顶层 general，运行时得出 cautious；审查 pending 时文件未改；批准后原变量和前序结果继续使用 | 没有升级 scope | 原地暂停、批准后继续 | 不重跑前面操作；dangerous 再升阶 |
| T08 | 并发同级只出现一份审查事件；deny/forbidden 即使被 JS catch 也不能启动后续写 | permission error 当前可被 catch | shared gate + terminal stop | 普通工具异常仍可 allSettled |
| T09 | Deferred 卡住前一工具，关闭后续工具/移除 MCP，再放行；后续不可执行 | catalog/rules snapshot 固定 | 接纳时实时检查 | 未知名称报错，无任意猜名调用 |
| T10 | 审查中/真实子进程中 abort；进程退出、listener 清理、全部 child 终态、Task ID 保留 | 只有父摘要，没有完整 child 生命周期 | scope 取消+桥 settle | Shell partial/kill/drain，禁止重放 |
| T11 | patch/edit 成功后父失败；Summary/Revert 归因真实文件；普通及压缩模型读取父回执，剪枝预算只计算可见输出 | 新增 child 被 converter/serialize 回放，并进入 prune 预算 | 真记录+各模型消费者按父子标记投影 | 数据库保留 child；readonly/declared/ambient 原归因 |
| T12 | read 已见页仍向脚本返回正文；read 指令/skill 正文即使 return 1 也交付；compaction 后可重新加载 | stub 或脚本丢弃正文 | receiver-aware read + context | 原直接 read stub、附件与 V1 Promise 行为 |

每个切片按红→最小绿完成再进入下一片，不一次写完所有测试。用真实临时文件与已有 InMemoryTransport；reviewer 的决定是可控外部依赖。通过 Permission 事件、最终文件、Session API 和模型消息观察行为，禁止断言私有 helper、源码字符串或复制实现算法。审查事件数量是用户要求的费用行为，不使用 mock 函数调用次数替代它。

必须单独覆盖：普通 ask 的 allow/auto/ask/deny 既有矩阵；scope 内 allow 不伪造最高风险；strict 首次仍审；MCP 图片字节不进入 sandbox；父错误只交付 partial、不宣称全部成功；JSON catalog schema 不替代 native/plugin 的真实入参验证；大段 context 截断后不误报 loaded/skills。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| 有效生产改动 E | 850～1,200 | 移除常量/别名推导；排除 import、格式化、纯 parser/包装移动 |
| 有效测试改动 E | 600～850 | 只计新增/实质改动测试，不计旧 fixture 移动 |
| 总 E | 1,450～2,050 | 以实际 diff 复算 |
| 所需 C | 218～308，计划上限预留 320 | `C >= max(1, ceil(E * 0.15))`，实际 E 增长同步调整 |

解释集中在真实约束：静态未知/遮蔽/对象变异；preview 不执行 body；风险等级与 reviewer 风险词汇不同；同级锁内再检查；批准不进会话缓存；deny/ask 与父批准的关系；child 持久化但不作为 provider 调用；Bash 中断后等待清理；read 的模型可见性与脚本数据；指令交付先于标记 loaded；测试 Deferred 和独立预期的意图。禁止填充逐行翻译或把说明拆行凑数。

## 18. Verification

### 18.1 已完成的计划阶段验证

| Check | Observed result | Scope / limitation |
| --- | --- | --- |
| 当前分支及工作树 | dev1-smark@321a3ffedd；存在并发 TUI 修改，未改动它们 | 固定计划基线，不证明实现 |
| TypeScript→Acorn 原地实验 | TS 声明被移除，Program 成功；直接成员、动态 computed member、嵌套调用三类 CallExpression 均可取得 | 使用当前真实 typescript/acorn；没有执行工具；尚未实现新的分析器 |
| 直接调用真实 PermissionPrecheck.evaluate | read→general；edit delete→cautious；external_directory→cautious | 验证 preview 可复用的分类 seam |
| 真实 shell classifier，只分析不执行命令 | `git status --short`→safe；`git push origin main`→cautious；`rm -rf /`→forbidden | 三条命令从未由 shell 执行，仅作为解析输入 |
| 真实 PermissionAuto.evaluate + 可控 reviewer 原地实验 | read 来源 precheck、0 次 review；edit delete 来源 reviewer、1 次 review | 验证原有成本来源；不是新批次机制的性能证明 |
| 原 CodeMode 包测试尝试 | 加载阶段 `Schema.Defect is not a function`；Effect 实装 beta.65，分支 catalog 要求 beta.83 | 未得到功能测试通过证据 |
| 原 opencode code-mode 测试尝试 | 缺 @opencode-ai/codemode 与 @opencode-ai/schema 工作区链接 | 不能把依赖失败当成红绿测试 |

工作区原 Bun 为 1.3.14，仓库 packageManager 为 1.4.4。上述两组加载失败记录保留，不改称为测试通过。随后获得用户对隔离安装的明确授权，只在临时目录安装匹配依赖；工作区 node_modules/lockfile 未变。完整宿主实现前仍需恢复分支环境。

计划阶段可复现预检实验（cwd=`packages/core`）：

```powershell
bun -e 'import { PermissionPrecheck } from "./src/permission/precheck"; for (const command of ["git status --short", "git push origin main", "rm -rf /"]) console.log(command, await PermissionPrecheck.evaluate({permission:"bash",patterns:[command],metadata:{command,cwd:process.cwd(),shell:"bash"}}));'
```

### 18.2 新机制隔离验证：已执行

隔离目录为 `D:/Temp/opencode/execute-plan-proof-20261106`。执行器使用已存在的 `D:/Temp/opencode/bun-1.4.4/bun-windows-x64/bun.exe`。用户明确批准安装 effect `4.0.0-beta.83`、typescript `5.8.2`、acorn `8.15.0`，安装采用 `--ignore-scripts`，无全仓安装或源码修改。

`build.ts` 从当前仓库构建真实 codemode、PermissionPrecheck、PermissionAuto、V1 ToolPart schema、read-presentation 和六个原测试文件；这些 owner 的源码未被重写。`analysis.js` 是待采用的窄字面扫描原型；`proof.test.js` 的批准 scope 是待采用的机制原型，reviewer 为可控制的测试依赖，不发起真实 LLM 请求。

| 已运行命令（cwd 为隔离目录） | 结果 | 能证明什么 |
| --- | --- | --- |
| `bun-1.4.4 --no-install test --timeout 10000 proof.test.js` | 29 pass，0 fail，91 assertions，1.207s | 实际 V1 脚本中的批准复用、升阶、连续变量、终局拒绝、开关、取消、真实 JSON 边界和 schema/read 合同 |
| `bun-1.4.4 --no-install test --timeout 30000 --only-failures dist/codemode.test.js dist/promise.test.js dist/enumeration.test.js dist/signature.test.js dist/stdlib.test.js dist/parity.test.js` | 237 pass，0 fail，646 assertions，2.06s | 匹配依赖下原解释器六组回归；不是新宿主集成测试 |
| `bun-1.4.4 --no-install test --timeout 10000 shell-request.test.js`，首次 | 4 pass，2 fail | 暴露测试把显式 Windows workdir 的分隔符假定为 `/`；真实 ShellTool 产生 `\`，需保留 owner 规范化 |
| 同一 Shell 请求命令，修正独立预期后 | 6 pass，0 fail，27 assertions，654ms | 未知参数暂缓、真实参数形成完整请求、参数错误在权限前拒绝 |
| `bun-1.4.4 --no-install test --timeout 10000 proof.test.js shell-request.test.js` | 35 pass，0 fail，118 assertions，1.107s | 修改为不提交 unknown Shell 请求后，两组行为仍一致 |
| 新增 Windows POSIX 准备测试，首次 | 35 pass，1 fail | 测试写死了不存在的 C 盘 Git Bash，真实 Shell.acceptable 选择了 pwsh；测试改用真实 Shell.gitbash 获取可用路径 |
| 同一命令，改用真实 shell 选择后 | 36 pass，0 fail，123 assertions，1.259s | 证实原 resolvePath 确实会请求 cygpath，不可假定准备始终无进程 |
| `shell-build.ts --preview-probe`，首次 | 构建失败，未运行候选测试 | 内存文本修改未匹配 CRLF；仅对内存副本归一换行后重新构建，生产源文件不变 |
| 构建 preview-probe 后运行上述两组测试 | **38 pass，0 fail，133 assertions，1.89s** | 候选 flag 真正阻止原 cygpath 调用点；完整 preview/runtime 请求与未修改原 ShellTool 深度相等 |
| R4 审计发现复现：`bun-1.4.4 --no-install test --timeout 10000 proof.test.js compaction-projection.test.js --test-name-pattern 'static binding\|compaction upload\|prune budget'` | **8 fail**，34 assertions，889ms | 6 个绑定反例先执行了前序修改；原 serialize 重传 child 正文；原 prune 把 70,000-token 含子记录预算中的父回执剪掉 |
| 新目录生产→Shell 消费专项 | **1 pass**，6 assertions，617ms | 真实创建自有临时目录，经真实 V1 await 后交给原 ShellTool；确认实际 cwd 及先后顺序 |
| R5 候选三组：`PROOF_COMPACTION_CANDIDATE=1`，运行下方 PowerShell 命令 | **47 pass，0 fail，177 assertions，1.454s** | 简化绑定扫描后前序副作用为零；compaction 两个原消费点过滤后预算为 20,000、pruned=0，父回执保留 |
| `bun-1.4.4 --no-install test --timeout 10000 proof.test.js --test-name-pattern 'registry-compatible JSON Schema'` | **1 pass，4 assertions，580ms** | 原 renderer 对真实 boolean/tuple 输入已生成 unknown/Array<unknown> 并保留字段/required，运行时按原 render-only 合同交给 Host |
| 临时包内 `bun typecheck`，目标 `schema-compatibility.ts` | **exit 0** | 使用当前仓库安装的 tsgo，验证 boolean/tuple 节点类型扩展后原 JSONSchema7 可直接赋值；真实类型直接 import 已安装 provider 与 codemode 源码，全程无断言或额外安装 |
| R7 全包候选：`bun --no-install run schema-candidate.ts` | 生成 codemode-candidate | 从真实 codemode 的 src/test 构建隔离副本，仅在 tool/tool-schema 改候选；JsonSchema 保留对象入口 |
| codemode-candidate 中 `bun typecheck` | **exit 0** | 完整 src/test，包含原 OpenAPI 消费者，以及原 JSONSchema7 直接进入候选 Tool.make 的 typed fixture |
| codemode-candidate 中 `bun --no-install test --timeout 30000 --only-failures` | **264 pass / 0 fail / 788 assertions / 2.20s** | 263 项原包测试及 boolean/tuple typed fixture；catalog 展示、render-only 执行、OpenAPI 原行为均通过 |

表中 bun-1.4.4 是上述已核实绝对路径的简写，不是 PATH 上的旧 bun。完整复现命令：

```powershell
& "D:\Temp\opencode\bun-1.4.4\bun-windows-x64\bun.exe" --no-install run build.ts
& "D:\Temp\opencode\bun-1.4.4\bun-windows-x64\bun.exe" --no-install run shell-build.ts
& "D:\Temp\opencode\bun-1.4.4\bun-windows-x64\bun.exe" --no-install run shell-build.ts --preview-probe
& "D:\Temp\opencode\bun-1.4.4\bun-windows-x64\bun.exe" --no-install test --timeout 10000 proof.test.js shell-request.test.js
$env:PROOF_COMPACTION_CANDIDATE = '1'
& "D:\Temp\opencode\bun-1.4.4\bun-windows-x64\bun.exe" --no-install test --timeout 10000 proof.test.js shell-request.test.js compaction-projection.test.js
```

核心可观察结果：

1. 没有顶层预检的对照会先记录第一项修改，再在后面的 forbidden 操作处停止；有顶层预检时第一项修改也没有开始。
2. 两项静态 cautious 操作只出现一次 reviewer 请求；四项并行动态 cautious 操作也只出现一次。动态 dangerous 到来时确实再升一次级。
3. reviewer 待决时没有产生受保护效果；批准后原 JS 变量仍在，返回 42，前序操作不重跑。
4. JS try/catch 不能把终局拒绝变成后续修改；普通工具错误仍能被捕获。
5. 用户 abort 取消待审；另一个测试真实启动自有 Bun 子进程，abort 返回前确认进程退出且后续修改没有开始。
6. JSON Schema 只渲染的工具实际接收了 `{key:42}`；加入宿主真实 Effect Schema 后 body 不再收到该非法输入。这直接支持 P05 的必要性。
7. V1 ToolPart 的 JSON 往返保留 executeParent/worktree/files，无须新 wire schema；这**不等于**已经验证数据库 settlement 或 Revert 全链。
8. 真实 read 展示输出不能被 JSON.parse；真实 stub owner 只在给定可见页证据时产生 stub。这支持原始程序数据与模型可见历史分开处理。

Shell 专项验证没有复制请求构造算法：`shell-build.ts` 构建仓库原 `ShellTool`、`Tool.wrap`、ShellPrompt schema、grammar、路径和权限请求代码，仅替换 Config/Plugin/Agent/Truncate/RuntimeFlags/InstanceState 的服务提供。文件类型检查使用真实 stat；spawner 禁止执行输入命令；在真实 ctx.ask 捕获完整请求后停止。动态场景由真实 V1 interpreter 求出 workdir 后调用该 ShellTool。未定值没有传给 PermissionPrecheck。

额外的 `--preview-probe` 在内存副本中改动原 resolvePath/argPath/collect 的 mode 传递和 cygpath 前的退出点，输出到独立 dist-preview；不覆盖 baseline bundle。测试对比未修改原模块、候选 preview、候选 runtime 的完整请求数组，并验证需要路径助手时没有调用 spawner.lines。测试临时用 ctx.extra.__proofPreview 注入模式；生产实现只采用第 15.2 节内部 prepare(mode)，不把测试探针字段带入产品。

R5 的 `compaction-projection.test.js` 使用 TypeScript AST 提取原 serialize/prune 及其常量，在内存中绑定消息读取、更新、配置和确定性 token 估算替身；候选只替换第 15.2 节两个条件。它验证原 owner 的序列化内容及剪枝选择。实施阶段以原 compaction fixture 继续验证数据库和真实 LLM 请求。目录专项的创建者为测试 Host，消费者为原 ShellTool；清理由测试释放自己创建的目录。

### 验证边界

这些实验验证机制及接线假设，不是已经实现最终生产改动。以下仍由实施 TDD 验收：新 Runtime.prepare 的单次 AST 接线、真实 SessionTools/Permission service 的完整事件与缓存组合、runChild 数据库生命周期、真实 ShellTool 双流 kill/drain、MCP 集成、Summary/Revert/UI、上下文截断。可控 reviewer 没有验证真实模型审查质量或线上 token 成本；自有进程测试没有假称覆盖全部进程树/远端取消。

### 18.3 实施验证命令

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 仓库根，仅安装不运行测试 | 匹配已提交依赖；不得顺便改 lockfile/全局 Git 配置 |
| `bun test --timeout 30000 --only-failures test/program.test.ts test/promise.test.ts` | packages/codemode | 先验证 parser/prepare/原并发与取消 |
| `bun test --timeout 30000 --only-failures test/permission/execute.test.ts test/permission/auto.test.ts test/permission/precheck.test.ts test/permission/next.test.ts test/permission/reviewer-prompt.test.ts` | packages/opencode | AUTO 批次与既有权限回归 |
| `bun test --timeout 30000 --only-failures test/session/tools.test.ts test/session/execute.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts` | packages/opencode | 公共组合调用、真实 MCP、生命周期 |
| `bun test --timeout 30000 --only-failures test/session/compaction.test.ts` | packages/opencode | 压缩上传与剪枝的父回执语义、既有压缩回归 |
| `bun test --timeout 30000 --only-failures test/tool/read.test.ts test/tool/glob.test.ts test/tool/grep.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts` | packages/opencode | 原工具行为未被 preview/结果扩展破坏 |
| `bun test --timeout 30000 --only-failures test/cli/cmd/tui/session-message-render.test.tsx` | packages/tui | 父子显示及并发 chrome 修改兼容 |
| `bun test --timeout 30000 --only-failures` | packages/codemode | 整包标准库/运行时回归 |
| `bun typecheck` | packages/codemode、packages/core、packages/opencode、packages/tui，分别运行 | 不用根 tsc，不用局部 transpile 冒充类型通过 |
| `bun run lint`（按实际改动路径限定仓库既有 oxlint 参数） | 仓库根 | 禁止顺便格式化其它文件；只验本任务文件 |
| `git diff --check` | 仓库根 | 空白和 diff 卫生；不代表运行验证 |

实施前先确认上述既有测试文件仍存在；文件重命名只更新对应已存在目标，不删除验收场景。任何失败必须保留原始证据，不能以较窄通过替代。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| 新增生产文件 | 1 | program.ts 同时拥有共享 parser 与分析，不分散成 compiler/IR/optimizer 多层 |
| 修改生产文件 | 31 | 第 15.1 节完整清单；P02 为两文件，P29 为压缩，P30/P31 为原 schema owner |
| 新增测试文件 | 3 | program、permission execution、session execute 三个真实 seam |
| 修改测试文件 | 11 | 保留和扩展既有回归，schema/compaction 使用原 fixture |
| 删除文件 | 0 | 删除被取代的代码块，不做文件清理 |
| 文档 | 1 | 本 canonical plan |
| 生产有效代码 E | 850～1,200 | 字面扫描替代数据流推导；主要变化集中于 parser、宿主、Permission、processor |
| 测试有效代码 E | 600～850 | 正常、权限、取消、history 和媒体的垂直验收 |
| 新增 runtime dependencies / DB migration / generated lines | 0 / 0 / 0 | 复用依赖、ToolPart metadata 和现有客户端协议 |

预算是审计信号，不是实施时补漏的借口。新增清单外的生产责任必须先说明哪个 INV 无法满足、为何现有 owner 无法承载，并修订计划；不以人为规定函数/概念数量替代必要性判断，也不以“后续保持最小”放任新框架。

## 20. Real Risks and Open Decisions

### 已确定的取舍

- 用户选择整段预检与等级复用，不另加“同级但目标变化必须重审”的第二授权机制；当前 deny/ask 与实时关闭仍优先。风险等级不是安全证明，动态同级行为依赖顶层 reviewer 和现有 precheck 的覆盖。
- 静态分析是潜在调用集合，未知保持未决，不伪造叶子预检等级。组合入口没有确认的更高风险时按 general 路由启动，实际叶子仍检查完整请求；不保证完全提前发现动态风险，也不为追求覆盖增加任意代码求值。
- 审查中暂停不等于事务。已经开始的并行/远端操作可能完成；本计划只保证未接纳调用不再开始、宿主等待自己的清理。
- 现有插件可以在 hooks/body 内执行宿主代码；本次不把它们变成沙箱代码，也不假称能够推导插件内部全部副作用。
- 新 child 记录增加持久化行数，但复用正常 ToolPart；不存第二份原始结果到父 metadata，不重放中间正文给模型。
- 在同一文件范围存在并发 TUI 修改，P28 只能作局部叠加，不能覆盖 chrome 工作。

### Open Decisions Requiring the User

无新的产品路线选择。用户已经决定整体预检/升阶、连续执行、运行时检查和 abort。最新授权只允许独立审计委派，实施由 primary 完成。接口与文件位置由本计划固定，不推给实施者再决定。独立审计尚未完成属于审批状态，不冒充用户仍未决定产品语义。

### Rejected Speculation

不增加 approval JWT、Session execution 表、跨主机批准同步、sandbox fallback、补偿事务、调度 DAG、自动重放、按工具专设并发池、未被需求支持的文件大小/工具次数新阈值。已有资源限额保持原值。

## 21. Audit Contract

独立审计读取本 R7、原始需求和真实仓库，依自身 skill/policy 独立核对完整范围。

R4 更新终态、基线和独立审计授权，沿用 R3 的产品设计与验证记录。用户最新 GOAL 已授权 adversarial-auditor；依完整范围审计并原样记录 verdict。blocker 先核对需求、必要行为与实际后果；无依据扩张用事实和引用复议，不以替换审计员或缩小范围寻求批准。实质修订须递增版本、清空批准并全范围重审。

R5 按用户最新原文写清参数计算、目录创建和权限检查顺序；修订已实测的绑定遗漏与压缩消费点。前者删除错误提升推断，后者在既有两个消费点复用 executeParent。实验结果和责任范围分别记入第 10/15/16/18 节。

R6 来自 R5 实施中的真实类型检查：P04 接收 registry schema 时发现原 JsonSchema 声明窄化。新增 P30/P31 和原 signature 测试，用原 owner 表达真实输入域，产品执行及权限合同沿用 R5。当前 R5 部分实现保留，新增范围经本轮完整方案审计后实施。

R7 保留 JsonSchema 的对象承诺，仅把嵌套节点表示为 boolean/object。原 OpenAPI 继续使用对象入口，范围仍为 P30/P31；验证从局部类型赋值扩展为真实候选全包的 typecheck 和行为测试。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| none | R1–R3 | 未审 | 未判定 | 未判定 | 先完成用户要求的隔离验证；当时尚无委派例外授权 | 无独立调用 |
| 1 | R4 | yes | B-01 静态绑定语义；B-02 压缩与剪枝消费点 | N-01 记录版本残留 | BLOCK | ses_e530a4da8ffeukeji9eYW1h7H5 |
| 2 | R5 | yes | No blocking findings | N-01 原文补全；N-02 按既定 T11 验证失败父回执压缩 | APPROVE | ses_e52f6b10bffeASu9bKFi7bZxJO |
| 3 | R6 | yes | B-01 schema 类型扩展遗漏了现有 OpenAPI 对象消费点 | 原 N-01 已解决；原 N-02 保持实施核对项 | BLOCK | ses_e52f6b10bffeASu9bKFi7bZxJO |
| 4 | R7 | yes | No blocking findings | 原 N-02 保持实施验收项 | APPROVE | ses_e52f6b10bffeASu9bKFi7bZxJO |

### Round 1 Verdict（原文）

**R4：BLOCK。发现 2 项有明确可达路径的阻塞问题。**

**B-01 静态遮蔽分析采用了 V1 解释器并不具备的变量提升语义**

- **Violated invariant:** INV-03、INV-13：静态可识别的 forbidden 调用必须在任何子工具副作用前阻止整段启动，且保留现有 V1 执行语义。
- **Evidence class:** reachable
- **Responsibility owner:** codemode 的程序分析与绑定解析边界。
- **Concrete behavioral consequence:** 一个明确写在脚本里的 forbidden 调用被漏出顶层预检；前面的文件修改已经发生，破坏用户要求的整段预检保证。运行时仍拒绝危险调用，但无法恢复“任何副作用前拒绝”的约束。
- **Minimal correction direction:** 让静态分析对齐现有 V1 的真实绑定规则，仅在能证明运行时已遮蔽时排除调用，并用同一脚本的实际执行验证前序副作用为零。

**B-02 新增持久化子 ToolPart 后，压缩路径仍会重新上传中间正文并污染剪枝预算**

- **Violated invariant:** INV-09，以及 §10.7 的父回执投影约束：子记录用于审计和文件归因，模型历史消费父 execute 回执。
- **Evidence class:** reachable
- **Responsibility owner:** `SessionCompaction` 的模型历史序列化与剪枝。
- **Concrete behavioral consequence:** 批量读取或 MCP 调用即使只返回很小的聚合结果，压缩时仍会重新上传大量中间正文，增加上下文和费用，并可触发已有的压缩溢出停止路径。另一路径中，大量非 read/skill 子输出会占用剪枝预算，导致实际模型可见输出尚少时提前清除父 execute 回执。这是新增子记录带来的回归。
- **Minimal correction direction:** 在现有 `SessionCompaction` 中对齐父／子可见性，使模型序列化和剪枝预算消费父回执，同时保留数据库子记录供 Summary、Revert 和审计使用。

**BLOCK — 仅针对 `docs/plans/execute-v1-unified-tools-auto-review.md` 的 R4。**

B-01、B-02 均须修订规范、补充行为验证，并对新 revision 重新进行完整范围审计。当前维持 `Approved revision: none`、`Implementation allowed: no`；本轮不授予实施或提交放行。

### Primary 处置记录

B-01 对应用户的执行前整段预检，B-02 对应减少中间正文和 token 的原始目的。primary 核对源码后先跑反例，8 项失败证明具体后果，再修改隔离候选；47 项验证通过。R5 对 B-01 删除原型的 var 提升推断，对 B-02 复用父子标记过滤原 serialize/prune，均修在既有 owner。N-01 已按记录修正当前实施审计占位版本。完整调用报告由上述 task ID 保留；批准以当前修订独立 verdict 为准。

### Round 2 Verdict（原文）

No blocking findings.

**APPROVE — 仅批准 `docs/plans/execute-v1-unified-tools-auto-review.md` 的 R5，完整范围方案审计通过。**

记录本轮 verdict 后，可按仓库流程将 R5 标记为 approved 并进入 TDD 实施。`verified-implementation-and-commit` 终态仍须完成产品验证、独立实现审计及规定的提交检查。

### Round 2 Non-Blocking Records

N-01 的用户原文已补全于第 1 节。N-02 按审计原文记录：

> 现有 `packages/opencode/src/session/compaction.ts:109` 对错误工具只读取 `state.error`；计划 §10.7 则把 execute 的失败清单、上下文及 Task 恢复信息保存在 `metadata.output`。
>
> 因此，仅复制 §15.2 的“跳过 child”示意条件，还不能完成失败回执的压缩交付。实施时应按 **§10.7 与 T11 已规定的完整合同**，验证压缩请求确实包含失败父回执的 partial 与恢复信息，同时保留错误状态。
>
> 这项行为已经映射到 P29、`serialize` 消费点和 T11，作为实施核对项记录，不判为方案缺少 owner 或验收路径。现有隔离用例 `D:/Temp/opencode/execute-plan-proof-20261106/compaction-projection.test.js:33-45` 只覆盖 completed 父回执。

### Round 3 Verdict（原文）

**B-01 schema 类型扩展遗漏了现有 OpenAPI 对象消费点**

- **Violated invariant:** INV-01／INV-02，以及仓库的包级类型检查门禁：统一工具目录的 schema 扩展必须兼容同一类型的现有消费者。
- **Evidence class:** contracted
- **Responsibility owner:** codemode 的公共 schema 类型及现有 OpenAPI schema 组装边界。
- **Concrete behavioral consequence:** 按记录的联合类型拓宽实际 `JsonSchema` 后，上述 `$defs`、`description` 访问失去对象类型保证，无法通过规定的 codemode 包级类型检查；局部别名实验的 `exit 0` 未验证这一影响。实施者必须再作未进入当前规格的类型边界选择或邻接修改，才能完成既定验证。
- **Minimal correction direction:** 在现有 schema 类型中明确区分对象形状与可为 boolean 的节点，优先保留 OpenAPI 的对象型入口，并验证真实包的全部类型消费者，无需新增 schema 转换层。

**BLOCK — 仅针对 `docs/plans/execute-v1-unified-tools-auto-review.md` 的 R6。**

保留 B-01，明确 schema 节点与对象消费边界、补足对应验证后，对新 revision 进行完整范围重审。R5 的既有批准不能覆盖 R6 新增的类型范围；当前保持 `Approved revision: none`、`Implementation allowed: no`。

Primary 核对 OpenAPI 的两个对象消费者后，采用保留原对象类型的更小修正。R7 的真实全包隔离候选 typecheck 与 264 项测试通过，生产范围维持两个 schema owner 文件。

### Round 4 Verdict（原文）

No blocking findings.

**APPROVE — 仅批准 `docs/plans/execute-v1-unified-tools-auto-review.md` 的 R7，完整范围方案审计通过。**

记录本轮 verdict 后，可将 R7 标记为 approved 并继续 TDD 实施。目标 `verified-implementation-and-commit` 仍须完成全部产品验证、独立完整实现审计及规定的提交检查。

**原 N-02 继续作为实施验收项：** T11 须验证失败父 execute 的 `metadata.output` 进入压缩请求，包含 partial 清单及 Task 恢复信息，并保留错误状态。该要求已记录于计划 §10.7、P29、T11 和审计记录，映射完整。

## 23. Implementation Evidence

R7 实现已接入全部批准主路径，并完成第 16 节的实际宿主、权限、取消、文件归因和投影验证。独立实现 Round 3 已对精确实现给出 No blocking findings / APPROVE，四个包的类型检查全部通过；当前进入本任务片段分离提交。

### Actual Files and Diff

实际为 1 个新增生产文件、31 个修改生产文件，覆盖 P01–P31；新增 program/session execute/permission execute 三个测试文件，修改 13 个现有测试文件。额外 owner 回归落在 read/skill/instruction 原测试，promise 的已有整组用例通过 Runtime.execute→prepare 原路径复验。

生产改动：`packages/codemode/src/{program,codemode,tool,tool-schema}.ts`、`src/interpreter/runtime.ts`；`packages/core/src/permission/{auto,precheck,reviewer/prompt}.ts`；`packages/opencode/src/effect/runtime-flags.ts`、`mcp/catalog.ts`、`permission/index.ts`、`session/{tools,processor,prompt,message-v2,compaction,instruction}.ts`、`session/llm/request.ts`、`tool/{tool,code-mode,registry,selection,shell,external-directory,read,glob,grep,edit,write,apply_patch,skill}.ts`；`packages/tui/src/routes/session/index.tsx` 的 child 展示条件。

测试改动：`packages/codemode/test/{program,signature}.test.ts`；`packages/opencode/test/permission/{execute,auto,precheck,reviewer-prompt}.test.ts`、`test/session/{execute,tools,compaction,instruction}.test.ts`、`test/tool/{code-mode,code-mode-integration,registry,read,skill}.test.ts`；`packages/tui/test/cli/cmd/tui/session-message-render.test.tsx`。

同路径并行归属：processor 的 reportedUsage/inputEstimate 变化、TUI Session/AssistantMessage 的 token accounting 变化属于其它任务；本任务只增加 runChild/executeParent 与 ToolPart 的两行展示条件。`test/session/processor-effect.test.ts` 当前全部差异属于并行工作，作为回归运行，不计入本任务提交或 E/C。

旧 CodeMode 测试按实际 owner 迁移：纯解释器目录/错误/日志/媒体断言通过显式 Host 保留；原 permission/hooks 断言迁至新 session/execute 的真实 SessionTools + MCP transport，包含真实 Asked/reply、改参持久化和多下划线 server 命名。媒体也在真实 SessionTools 验证，协议单元组继续补充原 wire/result 边界。

### Red-Green Test Evidence

T01：`packages/opencode` 内运行 `bun test --timeout 30000 --only-failures test/session/execute.test.ts`，初次在 `expect(tools.execute).toBeDefined()` 得到 undefined（1 fail）。接线后 fixture 补齐既有 SessionProjector 与合法 Config 形状，`bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/tools.test.ts` 为 **2 pass、7 assertions、3.40s**，结果来自真实磁盘 glob/read。

- T02：真实 InMemoryTransport MCP structured/resources 和自定义工具参数验证已转绿；非法自定义参数从进入 body 改为原 decoder 拒绝。
- T05：先写文件、再 literal forbidden Shell 的红测试证明原前序文件已生成；Shell 同源 prepare 后通过。JS 计算目录、真实 Shell 创建、下一 Shell 使用 cwd 的集成通过。
- T05 文件工具：read/glob/grep/apply_patch/edit/write 六项先写文件再命中 deny 的测试均从前序文件已生成转绿；模型选择分别经过 GPT patch 与非 GPT edit/write 原 registry 规则。
- T06：真实 Permission 事件验证一次整体审批复用同级，下一 execute 重新审批，1 pass / 8 assertions。
- T11：真实 processor + Task 创建子 Session 后失败，父模型回执原先只有错误文字；现包含真实 task_id 与 partial，保留 error 状态。
- T11：压缩序列化原先重传 child 正文且丢失父 partial；prune 原先让大 child 挤掉父预算。两项产品红测试修复后通过。
- T12：glob 路径数据、重复嵌套 read 正文、脚本 return 标量仍交付指令/skill、父已交付与 child 审计记录去重均完成红绿验证。

### Verification Commands and Results

临时目录的 47 项机制/候选验证与 237 项既有回归已通过。产品实施验证按第 18.3 节记录真实 Session 集成、包检查和红绿结果。

实施前实际工作区基线（Bun 1.4.4，Effect beta.83）：`packages/codemode` 中 `bun test --timeout 30000 --only-failures` 为 263 pass / 0 fail / 784 assertions，`bun typecheck` 通过；`packages/opencode` 中 `bun test --timeout 30000 --only-failures test/session/compaction.test.ts` 为 74 pass / 1 skip / 0 fail / 321 assertions。它们作为改动前基线，实施后分别复验。

R5 共享 parser/prepare 修改后：codemode 整包仍为 **263 pass / 0 fail / 784 assertions**，包内 `bun typecheck` 通过。Permission 共享逻辑提取后：opencode 的 auto/precheck/next 三组为 **268 pass / 0 fail / 1,005 assertions**。

opencode `bun typecheck` 已运行：发现 JSON Schema 类型域不匹配（R6 P30/P31），以及旧 CodeMode 测试尚需接入新 Host（已在 R5 T02 范围）。本任务的服务捕获、Context 类型与 fixture 方法缺失已按原入口修正。同期 token/accounting 的报错来自并行任务，保留其工作；最终包检查会整体复验。

2026-11-06 R7 产品增量（以下命令均在 `packages/opencode`）：

- `bun test --timeout 30000 --only-failures test/session/execute.test.ts`：**15 pass / 40 assertions**。
- `bun test --timeout 30000 --only-failures test/session/compaction.test.ts`：**76 pass / 1 skip / 332 assertions**。
- `bun test --timeout 30000 --only-failures test/tool/read.test.ts test/tool/skill.test.ts test/session/instruction.test.ts test/session/execute.test.ts`：当时 **106 pass / 444 assertions**，包含六项文件 preview 之前的 execute 用例。
- `bun test --timeout 30000 --only-failures test/tool/shell.test.ts --test-name-pattern 'permission|workdir|outside|cwd'`：**123 pass / 479 assertions**。
- registry 回归：**17 pass / 31 assertions**；shared SessionTools 与 execute 在失败回执切片后：**9 pass / 28 assertions**。
- `packages/codemode` 的 `test/signature.test.ts`：**25 pass / 65 assertions**，`bun typecheck` 通过，R7 schema 类型红测试已转绿。
- 最新 opencode 包 typecheck 的原生 preview `Effect.try` 签名已修正；旧 CodeMode harness 与并行 token/accounting 报错继续分别处理及复验。

最终增量结果：

| cwd | command | result |
| --- | --- | --- |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/tools.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts` | 97 pass / 278 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/compaction.test.ts test/session/instruction.test.ts test/tool/read.test.ts test/tool/skill.test.ts` | 173 pass / 1 skip / 748 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/permission/auto.test.ts test/permission/precheck.test.ts test/permission/next.test.ts test/permission/execute.test.ts test/permission/reviewer-prompt.test.ts` | 300 pass / 1,134 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/tool/glob.test.ts test/tool/grep.test.ts test/tool/apply_patch.test.ts test/tool/edit.test.ts test/tool/write.test.ts` | 221 pass / 4,490 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/tool/goal.test.ts test/tool/task.test.ts` | 48 pass / 227 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/tools.test.ts test/session/processor-effect.test.ts` | 当时 69 pass / 296 assertions；之后新增两项 hook/审查取消均通过，并纳入最终 97 项 |
| packages/codemode | `bun test --timeout 30000 --only-failures` | 275 pass / 821 assertions |
| packages/tui | `bun test --timeout 30000 --only-failures test/cli/cmd/tui/session-message-render.test.tsx` | 36 pass / 743 assertions |
| packages/codemode, packages/core, packages/tui | 各包内 `bun typecheck` | 全部通过 |
| packages/opencode | `bun typecheck` | 并行 owner 补齐 fixture 字面量类型后，最终复跑通过；历史两处 TS2322 保留在 Round 2 记录 |
| repository root | `git diff --check` | 通过；仅显示仓库已有 CRLF 警告 |

Shell 全套最初运行 `bun test --timeout 30000 --only-failures test/tool/shell.test.ts` 达到终端 300 秒总时限。原样 120 秒诊断运行观察到前 105 项结束、106 项启动；该项及 Bash/pwsh 子进程单独均通过。临时测试序号探针已撤除；首次探针误用 Bun 尚无的 expect.getState，产生的 243 项 setup failure 不算产品失败或有效验收，随后改为序号验证并清理。

按原 describe 分组并行运行全部 243 项，保持每项 30 秒与全部断言，结果 243 pass / 939 assertions；四组耗时总计约 408 秒，解释了单进程终端 300 秒限额。命令均为 `bun test --timeout 30000 --only-failures test/tool/shell.test.ts --test-name-pattern '<pattern>'`，cwd 为 packages/opencode：

| pattern | result |
| --- | --- |
| `tool.shell permissions` | 120 pass / 461 assertions / 106.78s |
| `tool.shell (display output\|background launch completion\|post-root lifetime\|abort\|truncation)` | 30 pass / 128 assertions / 96.29s |
| `tool.shell (windows\|CP936\|local command\|text decoding\|execution notice\|native)` | 73 pass / 256 assertions / 157.39s |
| `^(?:tool.shell (?!(?:permissions\|display output\|background launch completion\|post-root lifetime\|abort\|truncation\|windows\|CP936\|local command\|text decoding\|execution notice\|native))\|guards Windows)` | 20 pass / 94 assertions / 47.73s |

### Original Feedback-Loop Result

真实 SessionTools 入口已证明：空 MCP native 组合；native/custom/MCP/resource 目录及验证；静态 Shell/六类文件请求先于副作用；动态并发升阶原地续跑；strict/显式 ask/风险复用隔离；运行中关闭工具和移除 MCP；审查及真实 Shell 中断；Question 拒绝终止脚本；Goal read→complete；Task 错误恢复身份；patch/edit 后父失败仍可 Summary/Revert；read/skill 规则与截断恢复；普通/压缩模型和 TUI 只展示父聚合回执。

额外红绿发现按原 owner 修正：QuestionRejectedError 曾被当作普通工具错误供 JS catch 继续写盘，现由 Host 终止本次 scope；patch preview 曾只给 operation 而未给分类器既有 files.type，导致删除风险直到实际 leaf 才升阶，现提供原结构化事实。均属 R7 既定终止/预检合同。

### Actual Secondary and Replacement Path Inventory

实际沿第 11 节：direct/execute 是同一 invoke 的受支持入口；MCP structured/text/media 是同一结果的消费投影；动态参数在真实调用就绪后检查；原 AUTO 配置失败策略保持；解析/Host 缺失/成员撤销/参数错误返回失败。原 CodeMode 自己的 MCP transport/permission/hooks、空 MCP 隐藏和 experimental flag 路径已移除。新增失败后备用成功路径为 0；禁止重放和事务回滚的边界由失败父回执与 Revert 验证。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines E | 1,846 | Round 1 返工后 git unified=0 增量，排除空行/import/注释及同文件未改变行；再排除并行 processor/TUI 的 20 行、原 parser 跨文件移动 24 行 |
| Qualifying Chinese comment lines C | 277 | 独立 Round 2 确认：增量候选 291，排除并行 7 行与重复解释 7 行 |
| Ratio C / E | 15.0054% | 独立 Round 2 完成实际复算并确认门禁通过 |
| Required minimum C | 277 | ceil(1,846 × 0.15) |

计算输入包含 44 个 tracked 改动路径与四个相关 untracked 源码/测试，用 `git diff --no-index -- NUL <file>` 纳入新增文件；文档和其它并行路径排除。同文件 trim 后完全相同行按多重集消去，只排除已有语句的移动/缩进；跨文件 MCP 重排保守计入 E。代表性说明位于 program 的 V1 绑定规则、Permission 的等级/缓存隔离、SessionTools 的真实终态与当前成员、processor 的结算顺序，以及集成测试的暂停点和真实副作用预期。

### Remaining Unverified Items

并行 owner 已在 `test/token/accounting.test.ts:85` 将 fixture 的 `type: "text"` 标注为字面量；primary 与独立 auditor 均复跑 packages/opencode 的 `bun typecheck` 并通过。该修改由并行任务拥有，保持在本任务提交之外。原两处 TS2322 的发生与复验记录保留，B-03 已关闭。

用户已授权 processor.ts 与 TUI session/index.tsx 的片段分离提交；准备时检查 index 为空，HEAD 为 7e8ad09c3b。仅将本任务 hunks 与独占路径纳入提交，保持并行内容原状。独立完整实现审核已放行，剩余交付为执行正常 hooks 和本任务提交。Windows 本地各受影响测试已验证，其它 OS 的运行留给原跨平台 CI。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | 是，静态完整范围 | B-01、B-02 | 并行 hunks 与类型检查保留；独立 E/C 待复算 | BLOCK | ses_e520fc1e2ffevO6R1SaN4iGNCV |
| 2 | R7 | 是，完整范围及独立执行 | B-03 包级类型检查 | B-01/B-02 已关闭；同路径并行 hunks；lint 0 errors/376 warnings | BLOCK | ses_e520fc1e2ffevO6R1SaN4iGNCV |
| 3 | R7 | 是，完整原始需求及精确实现 | No blocking findings | 并行归属与既有 lint warnings 保留 | APPROVE | ses_e520fc1e2ffevO6R1SaN4iGNCV |

只有当前实现相对已批准修订取得独立完整范围 `No blocking findings`，才能标记 verified。

### Implementation Round 1 Verdict（原文）

## Blocking findings

### B-01 解释器取消子调用时，宿主 Promise 未收到取消，`Promise.race` 可永久等待

- **Violated invariant:** INV-07、INV-13；保持 V1 Promise 语义，并在取消后完成宿主清理。
- **Evidence class:** reachable
- **Producer and execution path:** 脚本启动 `question`，等待另一个正常工具完成，再执行 `Promise.race([questionPromise, "done"])`。解释器选出即时结果后中断 question 的子 fiber；新宿主桥却只等待底层 Promise，没有向该次宿主执行传递取消。
- **Source evidence:**
  - `packages/codemode/src/interpreter/runtime.ts:2162-2166`：race 获胜后等待败方 fiber 中断完成。
  - `packages/opencode/src/session/tools.ts:254-260`：另行启动 `invoke(...)` Promise，并在 finalizer 中等待它结束。
  - `packages/opencode/src/session/tools.ts:200-202,352-353`：宿主取消仅连接外部 signal 和整个 execute 的 controller，没有连接解释器对子调用的中断。
  - `packages/opencode/src/effect/bridge.ts:68-69`：`promise` 使用独立 `Effect.runPromise`。
  - `packages/opencode/src/question/index.ts:103-110`：question 持续等待用户回复，其清理依赖自身 Effect 结束。
- **Canonical-plan evidence:** §10.6 明确要求“被中断时先传递 signal，再在 finalizer 等待该 Promise settle”；§7 INV-13 保留原 V1 Promise 语义。
- **Responsibility owner:** `SessionTools` 的嵌套调用与 Promise 桥接边界。
- **Concrete behavioral consequence:** 即时分支已经获胜，execute 仍等待被取消的 question，直到用户额外回复或中止整个执行；同类 Shell 败方会继续运行。现有 `codemode/test/promise.test.ts:313-364` 使用 Effect-native 工具，覆盖不到这个新增桥接断点。
- **Minimal correction direction:** 在现有宿主调用边界把子 fiber 中断传递给该次执行，先取消、再等待清理，并保留 race 只取消败方的语义。

### B-02 同一父 execute 已获人工批准后，会再次弹出相同审批

- **Violated invariant:** 整段批准后原地续跑，同一父申请不得重复询问。
- **Evidence class:** reachable
- **Producer and execution path:** 配置 `execute: ask`，并使用现有 `approvals_reviewer: user`，提交包含 cautious 静态事实的脚本。`check()` 经 AUTO 路由请求人工批准；用户批准后，`beginExecute()` 又根据此前保存的 `matched.needsAsk` 对同一父申请调用 `requestUser()`。
- **Source evidence:**
  - `packages/opencode/src/permission/index.ts:155-159,174`：现有 user reviewer 配置进入人工路由。
  - `packages/core/src/permission/auto.ts:86-90`：该路径返回 `action: "ask"`。
  - `packages/opencode/src/permission/index.ts:322-327`：首次父申请获得人工批准并记录等级。
  - `packages/opencode/src/permission/index.ts:333-336`：随后再次询问同一父申请。
- **Canonical-plan evidence:** §10.4 明确规定，用户批准整段后提高本次等级，并且“不在批准整段后对同一请求重复弹窗”。
- **Responsibility owner:** `Permission.beginExecute` 的父申请审批编排。
- **Concrete behavioral consequence:** 用户必须连续批准两次相同脚本，第一次批准后执行仍停住；这直接破坏连续执行的确认流程。现有 `test/permission/execute.test.ts:104-126` 验证的是独立的叶子 ask，没有覆盖父申请重复询问。
- **Minimal correction direction:** 让同一父申请已经取得的人工批准同时满足该父申请的显式 ask，保持叶子 ask 独立。

## Non-blocking findings

- 送审差异混有 processor 和 TUI 的 token-accounting hunks。已按其实际行为与 execute 改动区分；提交材料仍需明确分离，不能把文件级通过视为这些并行修改也获批。
- 计划 §23 记录的包级类型检查尚有并行 token-accounting 错误。这里保留其未通过状态，不将它列为 execute 的实现缺陷，也不要求本任务顺带修复。

## Rejected speculation

- 动态参数未被静态分析完全解析：R7 明确允许运行时检查，不能据此要求符号执行器。
- 同等级但目标不同仍复用批准：这是原始需求选定的授权范围，不额外要求逐目标审批。
- 已启动远端操作无法事务撤销：原始需求明确接受已完成效果保留。
- apply_patch move 的 edit 模式沿 source 授权：与既有执行路径一致，不把未改动的授权语义列成本次回归。

## Requirement and traceability coverage

已读取完整送审差异、四个新增文件及直接影响的 producer／consumer，核对结果如下：

| 范围 | 结论 |
|---|---|
| 全工具目录、默认 execute、模型工具选择、内部工具排除 | 接入同一 eligible inventory；保留 V1 基座 |
| parser／prepare／静态事实及原工具 preview | 同一 AST；未知参数留待实际调用；未发现新增执行备用路径 |
| 整体 AUTO、等级复用、并发升阶、缓存隔离 | 责任集中在 Permission；父申请重复询问见 B-02 |
| 实时关闭、MCP 移除、参数验证、hooks | 已接入真实宿主入口和当前成员检查 |
| abort、子调用终态、Promise 行为 | 外部 abort 有接线；解释器内部取消的桥接缺口见 B-01 |
| Goal／Task、文件归因、Summary／Revert | 真实 child ToolPart 与受信 Context 接线可追踪 |
| 程序数据、指令、附件、模型历史、压缩、TUI | 父回执与审计子记录分离；已有对应行为测试 |

测试内容具有独立预期，能区分前序副作用、真实子记录、父回执和运行时批准。**本轮尚未独立复跑测试，因此不确认计划中的运行结果或历史 red-green 记录。**

## Primary-path and fallback verdict

原 MCP-only 目录与独立执行链已收敛到 `SessionTools.invoke`；direct／execute 是同一实现的两个入口。MCP structured／text／media 属于结果投影，动态参数属于获批输入域，现有 reviewer 人工路由属于保留策略。

未发现新增“主路径失败后换另一套实现取得成功”的路径。当前阻塞集中在取消传播和父审批编排，均应修在现有 owner，无需增加执行模式、重试或替代执行器。

## Code quality and Chinese-comment verdict

- 本轮独立执行的 `git diff --check` 通过。
- 改动中未发现新增 `any`、类型抑制或新的运行时依赖。
- 包内测试、typecheck、限定路径 lint，以及实际 E/C 独立复算仍待非 Git 命令授权。
- **实际 E、合格 C、C/E：尚未完成独立计算。** 计划记录的 `1780 / 278` 不作为本轮已验证数值，中文注释门禁当前不判通过。计数须排除 import-only、空行、纯移动、格式化和并行任务 hunks，并逐项判断解释性注释资格。

## Release verdict

**BLOCK — 针对 R7 与本次送审实现。**

B-01、B-02 均有当前可达执行链，阻止实现放行。静态完整范围检查已完成；独立执行验证和 E/C 复算仍未完成。继续审计所需授权为：包内相关测试与 typecheck、限定改动路径的 lint、只读内存差异计数。当前不能进入 `verified` 或提交阶段。

Primary 复议核对：两项均对应用户要求的连续执行与低成本审查，是既定 owner 的真实断点。按原 R7 合同补宿主 race 取消和父人工审批回归，不增执行模式、审批缓存或恢复路径。

### Implementation Round 1 Rework Evidence

- B-01 产品红测试：`bun test --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'Promise.race cancels'`，实际等待中的 Question 败方在 5 秒反馈界限报 `race did not release its host child`。宿主桥增加该次调用的取消信号，在子 fiber 中断时先 abort 再等待现有 pending Promise；父 execute 的 controller 保持独立。
- B-01 绿与回归：真实 Question race 与真实 Shell race 均返回 `done`，之后的 glob 继续执行，全部 child 完成结算。`--test-name-pattern 'Promise.race'` 为 2 pass / 7 assertions；外部 abort、Question 用户拒绝、实时关闭和审查取消合并为 5 pass / 15 assertions。
- B-02 产品红测试：`bun test --timeout 30000 --only-failures test/permission/execute.test.ts --test-name-pattern 'one human approval'`，仅回复一次后报 `duplicate parent approval`。Permission 内部 check 返回该次是否取得人工批准，初始父 ask 消费该结果；公开 check 仍为 void，叶子显式 ask 仍独立处理。
- B-02 绿与回归：permission/execute 为 5 pass / 18 assertions；与原 next 权限矩阵合并为 111 pass / 214 assertions。
- 两项返工后的完整宿主与 scoped Permission 回归：`bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/tools.test.ts test/permission/execute.test.ts`，40 pass / 134 assertions。以上命令 cwd 均为 packages/opencode。
- 返工后 opencode `bun typecheck` 仍仅报告同两处并行 token/accounting TS2322，本任务代码无新增类型诊断。E/C 已按本次实际差异重算，表见第 23 节。

### Implementation Round 2 Verdict（原文）

## Blocking findings

### B-03 当前候选尚未通过规定的包级类型检查

- **Violated invariant:** 实现放行前，规定的 package-local typecheck 必须通过。
- **Evidence class:** observed
- **Producer and execution path:** `packages/opencode` 执行 `bun typecheck`，编译 token-accounting 测试；混合数组中的 `text.type` 被推断为 `string`，无法满足当前 `TokenPart` 的字面量类型。
- **Source evidence:** `packages/opencode/test/token/accounting.test.ts:85,88,93-94`；`packages/tui/src/util/token-accounting.ts:297-299`。本轮命令实际退出码为 **2**，报告两处 TS2322。
- **Canonical-plan evidence:** §18.3 要求四个受影响包分别执行 typecheck；§23“Remaining Unverified Items”也保留了这两处失败。
- **Responsibility owner:** 并行 token-accounting 任务的类型接口与测试 fixture；本任务的发布验证流程负责等待门禁恢复。
- **Concrete behavioral consequence:** 当前候选不能标记 `verified` 或进入规定的提交阶段。这是实际验证阻塞，**不归因于 execute 实现，也不要求扩大 execute 的修复范围**。
- **Minimal correction direction:** 由对应 owner 解决这两处类型不匹配，再对最终候选复跑完整 opencode 包级检查。

## Non-blocking findings

- **原 B-01 已解决。** `packages/opencode/src/session/tools.ts:257-262` 将解释器子调用中断连接到该次宿主执行，再等待原 Promise 清理；真实 Question、运行中 Shell 的 race 回归均通过，后续工具仍可执行。
- **原 B-02 已解决。** `packages/opencode/src/permission/index.ts:324-341` 复用同一父申请取得的人工批准；仅回复一次的回归通过，叶子显式 ask 保持独立。
- 限定 48 个路径的 lint 返回 **0 errors、376 warnings**。其中包含既有告警，也有删除旧调用后留下的未使用绑定，例如 `tool/registry.ts:60,105`、`session/llm/request.ts:6`，可随相关清理处理；本轮没有把所有 touched-file 告警升级为缺陷。
- 送审 artifact 混有并行 token hunks及一处 CRLF warning。审计使用实际 Git 差异和源码核对，最终 **48 个文件的 blob 均与送审版本一致**。

## Rejected speculation

继续排除以下扩张：全程序符号执行、同级风险逐目标重新审批、已完成副作用的事务撤销、V2 runner 移植，以及未有可达证据的额外兼容或恢复路径。

未将并行 token-accounting 的实现问题列作 execute 的功能回归。

## Requirement and traceability coverage

本轮保持完整原始范围：重新核对完整差异与上一轮逐项源码证据，检查所有新增变更及其相邻调用路径，并执行完整相关回归。

| 需求范围 | 核对结果 |
|---|---|
| V1 全工具目录、模型选择、内部工具排除 | native/custom/plugin/MCP/resource 汇入同一宿主路径 |
| 静态整体预检、动态求值、风险升阶 | parser、preview、Permission 分工保持；同级批准与缓存隔离有行为覆盖 |
| 实时工具关闭、MCP 移除、hooks、参数验证 | 当前成员检查和实际参数进入原执行 owner |
| 连续执行、拒绝、abort、Promise 行为 | 原两项阻塞修复；真实宿主取消与结算回归通过 |
| Goal、Task、文件归因、Summary／Revert | 受信 Context 和真实 child ToolPart 路径通过 |
| 程序数据、指令、附件、模型历史、压缩、TUI | 父回执交付与审计子记录分离通过 |

**独立执行结果：**

| 检查 | 结果 |
|---|---:|
| codemode 整包 | 275 pass |
| execute 与 scoped Permission 集成 | 39 pass |
| 权限、目录、hooks、MCP transport 回归 | 364 pass |
| compaction、instruction、read、skill | 173 pass，1 skip |
| glob、grep、edit、write、apply_patch | 221 pass |
| Goal、Task、processor | 86 pass |
| Shell 全部原分组 | 243 pass |
| TUI session rendering | 36 pass |
| **合计** | **1,437 pass，1 skip，0 fail** |
| codemode／core／tui typecheck | 通过 |
| opencode typecheck | 两处 TS2322，见 B-03 |
| 限定路径 lint／`git diff --check` | 0 errors／通过 |

首次将 12 个测试文件合并运行时达到终端 **240 秒总时限**；随后按原文件分组全部完成，保留每项 30 秒时限及原断言。

## Primary-path and fallback verdict

直接调用与 execute 子调用继续共用 `SessionTools.invoke`。MCP structured/text/media 是同次结果的投影；动态参数进入实际调用时预检；原 reviewer 人工路由保持既有合同。

**未发现新增失败后备用成功路径。** 两项返工均修在现有责任边界，没有引入重放、额外执行模式、跨 execute 批准缓存或第二套执行器。

## Code quality and Chinese-comment verdict

独立计数采用实际 Git 差异与四个新增文件，未直接采用计划中的结果：

| 项目 | 审计值 |
|---|---:|
| 有效代码行 E | **1,846** |
| 中文注释候选 | 284 |
| 排除重复解释 | 7 |
| 合格解释性注释 C | **277** |
| C/E | **15.0054%** |
| 15% 所需行数 | **277** |

排除范围包括空行、import-only、同文件未改变／移动行、parser 纯移动，以及并行 processor/TUI hunks。七条重复说明分布在 session execute、program、permission execute 测试中。

**中文注释门禁通过。** 包级验证门禁因 B-03 尚未通过。

## Release verdict

**BLOCK — R7、本次送审的精确实现版本。**

原 B-01、B-02 已关闭；本轮未发现新的 execute 行为阻塞。剩余阻塞是独立复现的 **opencode 包级 typecheck 失败**。在该检查恢复并核对最终候选前，保持 `implementation-audit-required`，不得进入 `verified` 或提交阶段。

### Implementation Round 3 Verdict（原文）

## Blocking findings

No blocking findings.

B-01、B-02、B-03 均已关闭。当前实现与批准的 R7 一致，发布验证门禁已通过。

## Non-blocking findings

- 本任务 48 个源码／测试文件与上一轮逐项同 hash，当前文件也全部匹配送审 artifact；上一轮完整源码审计和回归证据继续有效。
- 限定路径 lint 的既有结果为 **0 errors、376 warnings**。并行类型修复文件本轮检查为 **0 errors、9 warnings**，告警均落在原有断言代码。
- processor、TUI 共享文件中的并行 token-accounting hunks，以及 `test/token/accounting.test.ts` 的并行修复，继续保持独立归属；本次放行不覆盖这些并行任务的整体实现。

## Rejected speculation

不要求增加全程序符号执行、同级风险逐目标审批、事务撤销、跨 execute 批准缓存或 V2 runner。动态参数运行时预检、已完成效果保留、原 reviewer 人工路由，均属于已确认合同。

## Requirement and traceability coverage

本轮保持完整原始需求及全部变更范围，复核当前规范、完整差异身份和相邻调用链；未将审计缩减为类型修复检查。

| 需求范围 | 结论 |
|---|---|
| V1 全工具支持、统一目录与执行 | native/custom/plugin/MCP/resource 共用宿主调用路径 |
| 整体预检、同级复用、升阶审批 | 静态事实与实际请求分离；批准限于本次 execute |
| 实时关闭、拒绝、abort、Promise 行为 | 当前成员检查、取消传播及清理符合合同 |
| Goal、Task、真实子记录、文件归因 | 受信 Context、ToolPart、Summary／Revert 路径完整 |
| 程序数据、指令、附件及父回执 | read 正文可供脚本消费；上下文不受 return 控制；模型与压缩消费父回执 |

**独立验证证据：**

- 上一轮同一实现的完整回归：**1,437 pass、1 skip、0 fail**，覆盖 codemode、权限、宿主、MCP、文件工具、Shell、生命周期、压缩及 TUI。
- 本轮执行 `token/accounting`、`session/execute`、`permission/execute`、`session/tools`：**45 pass、143 assertions、0 fail**。
- 本轮分别执行 codemode、core、opencode、tui 的 `bun typecheck`：**全部通过**。
- 本轮 `git diff --check`：**通过**。

B-03 的修复位于 `packages/opencode/test/token/accounting.test.ts:85`，仅保留 `"text"` 的字面量类型；原断言保持不变，两处 TS2322 已消失。

## Primary-path and fallback verdict

**通过。** 直接调用与 execute 子调用共用 `SessionTools.invoke`；解析、权限、工具执行和子记录结算各由原 owner 承担。

旧 MCP-only 目录、独立 transport/hooks 调用链和实验开关限制已被统一路径替代。新增失败后备用成功路径为 **0**，没有脚本重放、权限降级或 catch-and-success。

## Code quality and Chinese-comment verdict

本轮再次从实际差异独立复算：

| 指标 | 结果 |
|---|---:|
| 有效代码行 E | **1,846** |
| 合格中文解释性注释 C | **277** |
| C/E | **15.0054%** |
| 15% 所需注释数 | **277** |

已排除空行、import-only、未改变／移动行、parser 纯移动、并行 hunks，以及七条重复解释。**中文注释门禁通过。**

代码质量、相关测试、四包类型检查及限定路径 lint 门禁均已满足。

## Release verdict

**APPROVE — 仅批准 `docs/plans/execute-v1-unified-tools-auto-review.md` 的 R7，以及 artifact `tool_1aed0c7f200174B044AzFYGWOI` 中经核对属于本任务的精确实现 hunks。**

可原样记录本轮完整范围 verdict，并将实现状态更新为 `verified`。后续提交须保持已确认的片段分离边界、保留并行内容并正常执行 hooks；本审计未执行暂存或提交。

## 25. R8 当前修订：统一调用与原工具权限边界

### 25.1 当前证据与主路径

| Evidence | 直接核实的行为 | Classification |
| --- | --- | --- |
| 上游 v2.2.5 `packages/core/src/codemode/tool.ts` 的 inventoryTools | 遍历统一 inventory，将原 input/output schema 与公共 executeTool 接到解释器；工具名没有逐个适配分支 | observed |
| 上游 v2.2.5 `packages/core/src/tool/runtime.ts` 的 execute/decodeInput | 普通及嵌套调用共享原参数校验，再执行工具函数 | observed |
| 上游 v2.2.5 `packages/core/src/tool/plugin/edit.ts` | edit 注册原 Input/Output 与 execute；codemode:false 控制目录可见性，工具未增加预检适配接口 | observed |
| 本地 Codex `481cb038c2`（2026-11-05），`codex-rs/tools/src/code_mode.rs:161-178` | Function 工具目录直接序列化原 tool.parameters；不是将输入 schema 替换为 unknown | observed |
| 同修订 `codex-rs/core/src/tools/code_mode/mod.rs:337-421` | 嵌套调用构造成普通 ToolCall，经 handle_tool_call_with_source 执行并 await 结果；执行工具自身禁止递归 | observed |
| 同修订 `codex-rs/core/src/tools/orchestrator.rs:164-235` | 操作的原始请求产生审批需求，await request_approval 后进入执行；strict 和 forbidden 保持独立分支 | observed |
| 同修订 `codex-rs/core/src/tools/approvals.rs:685-743` | 自动审批经原 Guardian 路由等待；本地整段风险等级复用属于用户产品要求，不归称为 Codex 原算法 | observed |
| 当前 SessionTools:179-184,254-264,310,601-625；Tool.wrap:174-188 | 原 registry 定义被两个入口共享；真实 schema 解码在工具 body 前；逐工具 preview 另加于此之外 | observed |

```text
当前有效 registry / MCP / resource 定义
  -> 同一目录和原始 schema
  -> execute 脚本计算实际参数
  -> SessionTools.invoke / 原 hooks / 原参数校验
  -> 原工具 ctx.ask 的完整权限请求
  -> 本次 ExecuteReview：precheck -> 同级复用或整段 AUTO 等待
  -> 原工具继续执行 -> 原 child 结算 -> 父聚合输出
```

R8 的首个分歧位于 SessionTools.prepareReview 与实际 invoke 中读取 Tool.Def.preview 的两个位置：它们要求每个领域工具重新提供一份静态权限事实。用户允许运行至真实权限边界后暂停，因此这些接口、静态参数模型与各工具接入代码已失去必要性。原工具在其真实副作用前构造的 ctx.ask 请求直接成为唯一权限事实来源。

### 25.2 已运行的隔离验证

临时加载器：`D:/Temp/opencode/execute-no-preview-proof.ts`。Bun plugin 只在内存中将 SessionTools 的静态 facts 改为空，并移除 invoke 中的 preview/check 块；原工具 schema、body、ctx.ask、Permission 和 SessionProcessor 均使用当前真实实现。仓库源码保持原状。

| Command（cwd=`packages/opencode`） | Observed result | 验证范围 |
| --- | --- | --- |
| `bun test --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'custom tools use their existing argument validator before body effects'` | 1 pass / 2 assertions | 无 preview 的真实自定义工具可调用；错误参数被原 decoder 拒绝，磁盘仍为合法调用产生的 3 |
| `bun --eval` 调真实 CodeMode.prepare 提取先 write 后 read 的字面调用 | 两个 path、完整字面参数、unknownKeys=[] | 证明该明确例子可提前识别，未执行任何工具；不是运行时路线的必要模块 |
| `bun test --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'whole-script precheck rejects a literal forbidden shell\|whole-script preview rejects read before earlier file mutation'` | 2 pass / 6 assertions | 记录 R7 整段初审的真实行为基线 |
| 下述候选命令，首次 | 7 pass / 1 fail | 原取消测试要求审批前零 child；运行时路线已接纳一个等待审批的 child，故该原断言失败 |
| 同一候选命令，取消观察改为恰好一个 error child 后 | 8 pass / 23 assertions | 原 schema、自定义工具、native 组合、动态 cwd、并发同级一次审查、JS 变量续跑、hook 改参拒绝、实时开关、MCP hooks、审批取消结算 |

```powershell
bun test --preload D:/Temp/opencode/execute-no-preview-proof.ts --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'custom tools use|dynamic parallel calls|hook-modified shell|abort during whole-script|computed workdir|runtime toggle|native glob|MCP child hooks'
```

取消验证保留原 Exit 失败与 reviewer 清理断言，增加真实 child 数量与 error 终态检查，变更的是用户新路线中的审批时机预期。候选仍由原 ctx.ask 在进程启动前暂停；审批批准后返回 42，两个 cautious 调用只出现一份整段审查。以上证据验证公共接线可去掉 preview，未代替 R8 最终修改的类型检查、完整回归与独立审计。

### 25.3 当前实施边界

1. 全工具接入集中在 SessionTools 和 CodeModeHost。新注册工具通过同一有效工具表自动可用，保留工具自己的 schema、decoder、hooks 与执行函数。
2. 权限接口只接受原工具已经生成的完整请求。保留本次脚本、父 callID、允许上界、并发审批锁与停止回调；同级复用，升阶等待，forbidden 终止。原 strict、显式 ask/deny、实时开关仍生效。
3. 原生工具移除本任务新增的 preview。Shell 撤下 PreparationMode、PreviewNeedsRuntime 和 cygpath 的预览分支，恢复唯一真实请求准备链；edit/write/grep/apply_patch 的本任务修改随 preview 一起退出。
4. read/skill 的上下文交付与 glob 的结构化结果属于真实结果消费者差异，继续按原合同处理；它们与工具注册资格分离。取消、归因、压缩及 TUI 已验证的接线继续复用。
5. 删除只服务静态调用枚举的 StaticInput/StaticCall、analyzeProgram 与多处分支；执行解析仍由原 V1 解释器拥有。精确删除范围与原 parser 的还原位置列入送审文件表。
6. 提示词改用 TXT 保存上游原文，目录、空目录与部分目录的原生成分支必须保持逐字一致。上游 V1.19.5 的完整运行时说明与本地同 blob；V2.2.5 另带 fetch 等运行时扩展，范围与 TXT 组织在本修订送审前固定。
7. 测试集中在现有 SessionTools/Permission/CodeMode 公共入口；用原回归验证工具行为，移除已退出的静态预检专属用例，不逐工具新增适配测试。

### 25.4 冻结的接口与执行顺序

R8 沿用第 3 节仓库约束及第 6 节真实输入域。第 7 节 INV-01/02/04–13 的全工具、上界、开关、取消、记录和结果合同继续成立；INV-03 替换为用户最新允许的“在每个实际工具的原权限边界完成预检，需整段审查时暂停该执行链再续跑”。静态初审先于任何副作用的保证退出，不保留为第二种模式或备用路径。

`CodeModeHost.prepareReview` 改为 `begin(code: string)`，仅建立本次调用的 Permission scope。CodeModeTool 调用 begin 后执行原 `runtime.execute(code)`；CodeMode runtime 恢复原 V1 解析入口，删除 prepare/StaticCall/StaticInput 的宿主预审扩展。输入 code 仍经原 Tool.wrap 的 Parameters 校验；语法错误继续由原解释器返回原诊断。

`Permission.beginExecute` 删除 `facts` 入参；`ExecuteReview` 只保留 `ask(request: PermissionV1.AskInput)` 和 `ready(): Effect<void>`。原 schema、tool parameters、真实 request 内容均原样使用。执行顺序：

1. begin 创建本次上界和同一 Semaphore，检查父 execute 的显式规则。初始 general 沿原 AUTO 路由，普通配置零模型审查；strict、父 ask 保持原配置要求。
2. 每个 child 接纳仍检查当前工具开关与成员；进入共享 invoke 后先 `yield* review.ready()`，随后原 hooks、Tool.wrap 校验和工具 body。ready 使用同一审批锁等待当前整段审查结束，并观察 stopped；它替代原调用前 check 的等待职责，不伪造一个缺参数权限请求。
3. 工具原 `ctx.ask` 产生完整权限请求后，ExecuteReview.ask 先按当前规则匹配 deny/ask，再在同一锁中调用原 PermissionPrecheck.evaluate(request)。每个真实请求的原完整理由继续保留，Shell 内部多原因归并继续由原分类器负责。
4. safe/general 沿原路由；首次 cautious/dangerous、后续高于本次上界的请求调用原 reviewAuto，审查对象是父 execute。父 planned action 携带完整 code、实际 trigger 和已完成 child 摘要；移除静态 facts 字段与相关提示语。
5. reviewer 通过后提高本次上界并释放等待；同级/更低请求复用。forbidden、deny、人工拒绝和用户取消继续终止 scope；同级复用不进入 Session cache。
6. 可信扩展若原实现没有 ctx.ask，保持其普通调用的权限语义与参数校验，仍经过当前工具选择和 ready 等待。不会为了接入 execute 给每个扩展追加虚构权限规则。

用户新路线保留已经完成的正常效果：先成功创建文件、后在真实拒绝请求处停止时，前一文件保留，失败父回执列出事实。已开始的并行任务沿原取消/清理合同结算；ready 让后续接纳的调用在全局审查等待期间暂停。拒绝后全部后续调用仍受同一 controller 和 stopped 状态约束。

### 25.5 TXT 与原文合同

选定与长期 V1 基座相同的官方 `v1.19.5` 运行时提示词为逐字来源。官方及当前 `packages/codemode/src/tool-runtime.ts` 的 Git blob 均为 `f4ccc61d4c49a4f7572906559e5a4e2a11acdec9`。V2.2.5 用于核对统一目录和调用设计，fetch 扩展及全局 search 名称保持在本次产品范围外。

1. 新建 `packages/codemode/src/code-mode.txt`，保存上游 intro/workflow/rules/language/目录标题/search 提示的完整原文块。`@@ <key>` 仅作文件内块分隔，不进入模型文本；部分目录标题中的 shown/total 是原动态计数位置。
2. `tool-runtime.ts` 用现有 Bun text import 加载一次 TXT，以 split/map 取得原文块。保留 empty/complete/partial 条件、目录预算、namespace 计数、签名渲染、search 广告时机与原排列顺序；不增加自定义模板执行器或 prompt 翻译。
3. SessionTools 对 execute 直接使用 `describeCatalog(catalog)` 的完整上游说明，撤下自写短描述的拼接前缀。CodeModeTool 注册时的基础说明改为上游首句 `This is a restricted JavaScript language for calling tools, not a general-purpose runtime.`，实际 provider 说明仍完整来自 TXT 与动态目录。
4. 工具 inputSchema 继续取同一有效 registry 的 ToolJsonSchema.fromTool；参数校验继续在原 Tool.wrap / plugin decoder / MCP owner。原 JSON schema 节点兼容与未知 output 的展示保持既有语义；不将已存在的输入字段、required、enum 或 validator 换成 unknown。

隔离 TXT 为 `D:/Temp/opencode/execute-prompt.txt`，加载器还在内存中替换原 tool-runtime 的字符串拼装。已对同一公开 CodeMode.instructions 进行替换前/后完整文本 SHA-256 比对：

| 分支与固定 fixture | 字符数 | 原文和候选共同 SHA-256 |
| --- | ---: | --- |
| empty，tools={} | 682 | `45e2095a39da0219e81f035abe289ef7d4f3fb358e38a85b3c8e7bbef8b715a2` |
| complete，host.lookup，input={id:string}, output=string，description=Lookup a record | 2310 | `cb41917c248838f8fe76d5549ec6dae20eb53b30d5e39ba836eb4953ffd81d72` |
| partial，同一工具，catalogBudget=0 | 2563 | `5d48fc77be831f5add84f9d93d00a2342a42784aa1fcfa66b8ddcef52960e799` |

三分支通过真实 Bun text import 与显式哈希相等断言。当前 @types/bun 已声明 `*.txt`，无需修改包配置、导出范围或安装依赖。对应运行时现有两组测试 `bun test --preload D:/Temp/opencode/execute-no-preview-proof.ts --timeout 30000 --only-failures test/codemode.test.ts test/signature.test.ts` 在 packages/codemode 得到 **68 pass / 280 assertions**。

保留的全部 SessionTools 集成候选通过：`bun test --preload D:/Temp/opencode/execute-no-preview-proof.ts --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern '^(?!.*(?:whole-script precheck|whole-script preview|literal patch deletion)).*$'`，cwd=packages/opencode，**26 pass / 93 assertions**。8 项被筛选的是已退出的静态审批时机断言，最终按下一节明确的新行为处理，而非在产品验收中长期排除。

### 25.6 逐文件修改与必要性

相对 R7 提交的修改表如下。精确恢复只针对 `11d619643f` 引入的本任务代码，使用 apply_patch；并行 worktree 保持原样。

| 路径 | 切点与确切改动 | 预计增删 |
| --- | --- | --- |
| `packages/opencode/src/session/tools.ts` | 3：Host.begin 建 scope；删除两处 preview；invoke 开始等待 ready；provider 直接用完整上游说明 | +8 / -35 |
| `packages/opencode/src/tool/code-mode.ts` | 3：Host.begin 取代 prepareReview；原 runtime.execute 取代静态 prepare；基础首句用上游原文 | +5 / -12 |
| `packages/opencode/src/tool/tool.ts` | 2：去掉 preview 和其 StaticInput 依赖、PermissionRequest 别名；保留结果/Context 接线 | -5～10 |
| `packages/opencode/src/tool/registry.ts` | 2：去掉 preview 透传；清理旧 MCP-only 目录删除后留下的未使用绑定 | -3～5 |
| `packages/opencode/src/permission/index.ts` | 4：去掉静态 facts；单个真实请求预检；保留上界锁并提供 ready；父 metadata 只保留 code/trigger/completed | +12～20 / -35～50 |
| `packages/core/src/permission/precheck.ts` | 1：撤下仅供静态集合的 combine；原 evaluate 完整保留 | -9 |
| `packages/core/src/permission/reviewer/prompt.ts` | 1：撤下 Static facts 句；保留整段范围、真实 trigger、上界与连续执行说明 | +1 / -1 |
| `packages/opencode/src/tool/shell.ts` | 恢复 R7 前唯一 parse/collect/ask 链；撤下 preview mode、异常、requests/prepare 拆分和相关传参 | 撤回 R7 +76/-51 |
| `packages/opencode/src/tool/external-directory.ts` | 恢复原 assertExternalDirectoryEffect，撤下只为 preview 提取的 request helper | 撤回本任务修改 |
| `packages/opencode/src/tool/edit.ts`、`write.ts`、`grep.ts`、`apply_patch.ts` | 各1：移除本任务 preview 与新增 import，实际工具 body 回到 R7 前原内容 | 每项约 -10～25 |
| `packages/opencode/src/tool/read.ts`、`glob.ts` | 各1：只移除 preview/import；正文/结构化结果与指令交付继续服务真实消费者 | 每项约 -10～15 |
| `packages/codemode/src/codemode.ts`、`src/interpreter/runtime.ts` | 恢复 R7 前原解析执行入口，去掉 prepare 和额外 AST 参数；保留原 V1 语言/Promise 行为 | 撤回 R7 对两文件修改 |
| `packages/codemode/src/program.ts` | 删除：StaticInput/StaticCall/分析器退出；原 parser 移回 runtime | -170 |
| `packages/codemode/src/code-mode.txt` | 新增：上游完整文案分块原文 | +53 |
| `packages/codemode/src/tool-runtime.ts` | 2：加载原文块；原条件分支选择原文并填目录计数 | +20～30 / -65～80 |
| `packages/codemode/test/program.test.ts` | 删除：静态 prepare 接口退出；原 codemode 语言/绑定/Promise 整包回归保留 | -91 |
| `packages/codemode/test/codemode.test.ts` | 1：在公开 instructions seam 固定三种上游原文结果；其余原断言保持 | +15～25 |
| `packages/opencode/test/permission/precheck.test.ts` | 1：撤下 combine 专属测试，原分类矩阵不动 | -9 |
| `packages/opencode/test/permission/execute.test.ts` | 5：原 scope 场景从 facts/check 迁到真实 ask；审批等待/取消验证 ready，保持 strict/ask/隔离/升阶 | +15～25 / -15～25 |
| `packages/opencode/test/permission/reviewer-prompt.test.ts` | 1：fixture 去掉静态 facts，保留整段 code/trigger/恢复身份断言 | -1 |
| `packages/opencode/test/session/execute.test.ts` | 4：合并退出的逐工具静态矩阵；真实请求前等待、此前效果保留、取消 error child；同级复用仍断言一次整段审查 | +30～50 / -85～110 |
| `packages/opencode/test/tool/code-mode.test.ts`、`code-mode-integration.test.ts` | 各1：Host.prepareReview 改 begin，原目录/媒体/异常用例保持 | 各 +1/-1 |
| `docs/plans/execute-v1-unified-tools-auto-review.md` | 本修订、原文、证据和审计记录 | 同一 canonical artifact |

恢复到 R7 前后，从初始统一编排基线累计计算，预计生产影响从 32 降至 **24 文件**：6 个普通工具/目录文件、3 个静态执行文件、1 个 combine 文件退出，新增 TXT 与其原 owner 的引用共2文件；测试从16降至15文件。累计约40个路径（含方案），不是再新增40套逻辑。精确结果在实际 diff 核算；文件数是用户关心的成本指标，不通过删除结果消费者来凑数。

R7 保留文件各自只有一项已验证职责：mcp/catalog 的同一 transport/结果投影；runtime-flags/registry 的默认可用；selection/prompt/llm.request 的当前有效目录；processor 的真 child；message-v2/compaction/TUI 的父回执投影；instruction/read/skill 的必达上下文；Tool/CodeMode 的结果桥；PermissionAuto 的原风险路由；codemode schema/render 的原输入域兼容。Summary/Revert/Goal/Task 的算法保持原实现。

### 25.7 前向与反向映射

| Requirement / invariant | Owner / 实际路径 | 本轮文件与行为验收 |
| --- | --- | --- |
| 当前全部工具自动加入，原 schema 原语义；INV-01/02/13 | eligible inventory -> 同一 invoke -> 原 decoder/body | SessionTools、Tool/registry、CodeModeHost；原 custom schema、native/MCP/resources/Goal/Task 集成保持 |
| 用户允许的首次谨慎请求挂起；R8 INV-03、INV-04/12 | 原 ctx.ask -> ExecuteReview.ask -> 原 precheck/AUTO -> 父审查 | Permission、SessionTools；等待期间目标文件/进程未发生效果，批准后原 JS 值为42、同级只审一次 |
| strict/显式规则/跨执行隔离；INV-05 | 原 matchRequest/reviewAuto/requestUser，scope 私有等级 | Permission/execute 原五类场景改用真实请求；strict+user+父ask的一次申请仍满足两门禁 |
| 审查期间后续工具等待；INV-07/12 | 原 Semaphore -> ready -> invoke | Permission 的公共 scope 测试验证等待、批准放行及拒绝后不继续；真实 Session 集成保留取消和并发 |
| 实时开关和成员；INV-06 | Host.invoke 当前 Session/registry/MCP | 原 toggle/MCP-removal 集成，保持拒绝不可被JS catch绕过 |
| 连续执行、取消、归因、结果；INV-07–11 | 原 child settlement、context、父投影 | Session execute、compaction、instruction、read/skill、TUI 的既有公共验收；将静态零前序效果改为新路线的真实 partial |
| 原文 TXT、完整动态说明 | CodeMode.instructions -> SessionTools provider description | TXT/tool-runtime、原 codemode test；三分支完整文本等价及目录/搜索原测试 |
| 减少文件及逐工具接入 | 删除 preview/AST/prepare 与静态专属测试 | 第25.6节；实际累计 diff 清单，不以删除已有参数验证或下游归因来换数字 |

| 本轮 concept / 删除 | 需求及 owner 证据 | 复用与必要性 |
| --- | --- | --- |
| ready | 用户要求暂停整段；旧 invoke.check 原来为每个 child 经过同一锁 | 直接复用已有 Semaphore，仅等待和观察 stopped；无需伪造权限请求、全局队列或新状态机 |
| 单个原 request 驱动上界 | 用户最后允许的路线；原 ctx.ask 已构造 command/cwd/diff 等完整事实 | 复用 PermissionPrecheck.evaluate 与 reviewAuto；combine、preview、unknownKeys 的额外模型退出 |
| TXT 分块 | 用户要求原文 TXT；原上游按 empty/complete/partial 选择不同段落 | 单文件保存全部段落，用 split/map 载入，原生成器继续拥有目录和分支；不创建 prompt DSL |
| 恢复原 parser/runtime | 静态预检调用者退出，原 runtime 已拥有解析执行 | 删除本任务新增的静态 prepare/analysis，恢复 `11d619643f^` 的两个文件内容，不保留兼容层 |
| 原结果差异继续保留 | 脚本与主模型是两个实际消费者，已验证指令丢失与stub问题 | 继续复用原 program/context，不为了减少文件把 read/skill 行为反解析进统一入口 |

所有新动作沿同一主路径，新增失败后备用成功路径为0。原 ordinary/direct 与 execute 是同一执行器的两个入口；native/MCP 结果差异是既有协议投影；原 reviewer 基础设施策略、strict/ask 为保留分支。用户明确允许的运行时暂停直接替换静态初审，而非静态失败后再走运行时。既有诊断出口保持，不新增诊断分支，新增诊断决策占比为0。

### 25.8 TDD、验证与预算

沿用用户已确认的 SessionTools/Permission/CodeMode 公共验收点，按以下次序逐片执行：

1. 将已有“literal forbidden 在前序 patch 前拒绝”改为新路线：前序合法 patch 完成、真实 forbidden 请求在其效果前拒绝、后续 mutation 保持未发生。当前 R7 会在开始前拒绝，因此前序效果预期形成真实 red；移除静态预检并接原 ctx.ask 后 green。
2. 收敛 Permission scope：原同级/升阶/strict/显式 ask/跨执行用例通过真实 request 驱动；增加一个 scope 等待场景，观察待审期间下一个已接纳调用的业务效果及终局拒绝后的停止。只复用原锁和停止链。
3. 原自定义 schema 合法/非法参数、native/MCP/resource、动态 cwd、hooks、媒体/指令、Goal/Task、取消及 Summary/Revert 回归。旧六项逐工具静态矩阵退出；literal patch 删除改为真实删除请求处待审，观察删除前文件保留和此前效果已经发生。
4. TXT 三分支精确等价固定为 public instructions 验收；provider 的 execute description 直接消费该完整结果。复跑已有目录搜索、语言约束和整个解释器测试。

取消测试改为真实 child error 终态，保留原失败 Exit、reviewer 清理与停止后续效果的断言。被删除的检查均只针对退出的静态接口/时机；原工具普通调用测试保持全部原断言。

| Command | cwd | 证明 |
| --- | --- | --- |
| `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/tools.test.ts test/permission/execute.test.ts` | packages/opencode | 原 schema、统一宿主、运行时审查/暂停、结果和生命周期 |
| `bun test --timeout 30000 --only-failures test/permission/auto.test.ts test/permission/precheck.test.ts test/permission/next.test.ts test/permission/reviewer-prompt.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts` | packages/opencode | 原五级路由、显式规则、目录、MCP、原失败处理 |
| `bun test --timeout 30000 --only-failures test/tool/read.test.ts test/tool/glob.test.ts test/tool/grep.test.ts test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts test/tool/skill.test.ts test/session/instruction.test.ts test/session/compaction.test.ts` | packages/opencode | 恢复工具体、结果消费者、指令/压缩 |
| 第23节 Shell 原四分组命令，每项保持 timeout 30000 | packages/opencode | 原 Shell 请求/路径/进程/取消全组；不使用预览 helper |
| `bun test --timeout 30000 --only-failures` | packages/codemode | 原解释器及上游 prompt 全组 |
| `bun test --timeout 30000 --only-failures test/cli/cmd/tui/session-message-render.test.tsx` | packages/tui | 保留父聚合/child审计显示 |
| `bun typecheck` | packages/codemode、packages/core、packages/opencode、packages/tui 各自目录 | 实际最终源码与所有类型消费者 |
| 限定本任务改动路径运行根包既有 oxlint；`git diff --check` | root | 代码质量与差异卫生 |

计划阶段的最后候选把 ready 也接回原 Semaphore，并保留同一 TXT 提取；上列26项 Session 集成再次得到 **26 pass / 93 assertions**。这证明真实接线继续工作；最终接口删减、parser 恢复后的完整测试和包类型检查属于实施验收，不以该内存候选冒充最终发布验证。

R8 主要为删除：约25个源码/测试路径修改、2个静态源码/测试文件删除、1个TXT新增；相对R7预计删除净代码250～450行。新增/实质修改有效代码 E 预计180～260，合格邻近中文说明 C 至少27～39，实际必须 `C >= max(1, ceil(E * 0.15))`；纯 parser 恢复/移动、英文原文移动、空行、import-only、并行修改不计E。说明位于真实权限请求、同一锁等待、原文分支、取消/partial和固定上游预期的行为断言旁；不靠逐行翻译凑数。

### 25.9 风险、决定与审计

实际取舍：首次 cautious 前的正常效果允许完成；第一次 reviewer 读取整段 code 与真实 trigger，而非逐工具预演结果。动态参数沿原 schema 和权限 owner 求值，插件副作用继续按原信任合同执行。当前并行 processor/TUI/token/retry 修改保持其独立归属。R8 不增加 V2 runtime、fetch、跨执行缓存、事务、重放、符号执行或逐工具配置。

用户已经允许本节选定路线，实施选择由本计划固定。工具输入 schema 保持原定义；TS 边界的 unknown 值类型、MCP 原服务端校验和上游本已有的未知输出文案不等于把工具输入替换为 unknown。本次不新造该类降级。

完整原始需求与最新原文均在第1节；R7历史审计保留于第22/24节。R8 审计覆盖本节的完整当前修订及其保留的全部产品合同，独立核对原文、撤下的路径、schema、调用/权限链、结果消费者和验证；不把上一轮批准作为本轮放行。实际代码实施仍由 primary 完成。

R8 方案审计见25.10，精确R8已批准。R8 实现证据与实现审计：待实施、记录。目标仍为 verified-implementation-and-commit，沿第1节授权边界提交本任务并保留并行修改，正常hooks，禁止push/amend。

### 25.10 R8 独立方案审计记录

Round 5；revision R8；full scope yes；invocation `ses_e50b4057affeszwaS7Qs5TdsL0`。

首次返回 `No blocking findings.`，独立执行验证待确认授权；初次 release 原文为：

> **BLOCK — R8 独立验证待完成，当前没有要求方案返工的 blocking finding。**

primary 转交用户已要求实际验证及即时审计的原文授权；同一 auditor 在同一 R8 执行两组隔离测试，并返回以下最终完整 verdict。此过程没有设计修订或范围缩减。

#### Final Verdict（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

无。上一轮待完成的独立运行验证已完成，无需为此修改方案或递增 revision。

## Rejected speculation

- 不要求恢复逐工具 preview：用户已明确允许在实际权限边界暂停，原 `ctx.ask` 提供真实请求。
- 不把边界类型 `unknown` 或既有未知输出展示认定为输入 schema 降级；目录及实际 decoder 保留原定义。
- 不要求增加事务、符号执行、第二种执行模式或逐工具适配测试。
- 不将并行 token/retry 工作区修改纳入本任务，也不以无关既存问题阻止 R8。

## Requirement and traceability coverage

已按完整原始需求核对 R8 §25 的所有修改区域及保留合同。

| 要求 | 核对结果 |
|---|---|
| 当前全部工具自动接入、共享原执行与校验 | `packages/opencode/src/session/tools.ts:179–184,533–625` 汇合有效工具表；`packages/opencode/src/tool/tool.ts:174–188` 与 `packages/opencode/src/tool/registry.ts:145–170` 保留原 decoder。 |
| 实际请求触发整体审查、同级复用及升阶 | §25.4 将权限事实统一归于原 `ctx.ask`，复用 `packages/opencode/src/permission/index.ts:288–348` 的调用级上界与审批锁；显式 deny/ask、strict 和跨执行隔离保留。 |
| 取消、部分完成事实及子调用归因 | `packages/opencode/src/session/tools.ts:254–276,340–352`、`packages/opencode/src/session/processor.ts:563–584` 保留取消清理和真实结算；模型回放继续消费父回执。 |
| 完整上游提示词 TXT | 已直接读取官方 v1.19.5 提示词源码并核对原文块；§25.5 保留 empty/complete/partial、目录预算、搜索提示及排列逻辑。 |
| 简化架构、集中验证 | §25.6 覆盖 preview、静态分析及全部相关消费者的删除；保留的结果与上下文修改均有实际消费者。§25.8 的前序文件效果断言能够在 R7 上形成行为红灯。 |

**本轮独立实测：**

| 工作目录 | 验证范围 | 结果 |
|---|---|---|
| `packages/opencode` | 临时加载器下的 Session execute 集成 | **26 pass、93 assertions、0 fail**；8 项退出的静态时机用例被筛选 |
| `packages/codemode` | 同一加载器下的 codemode/signature 回归 | **68 pass、280 assertions、0 fail** |

合计 **94 项通过、373 条断言、0 失败**。已检查加载器的实际替换内容；这些结果支持计划阶段的统一接线与 TXT 提取假设。8 项旧时机用例的删除、合并和替代验收已在 §25.6、§25.8 明确规定。

## Primary-path and fallback verdict

**通过。**

权威路径为：

`有效工具表 → 共享 invoke → 原 decoder/body → 原 ctx.ask → ExecuteReview → 原工具续跑与结算`

运行时暂停直接替换用户已允许撤下的静态初审，没有失败后切换的备用成功路径。`ready()` 复用同一审批锁；原工具继续拥有领域请求和副作用，Permission 拥有审批，SessionProcessor 拥有结算。

新增备用成功路径为 **0**；新增诊断决策分支为 **0**。未发现缺乏需求或可达证据的新生产概念。

## Code quality and Chinese-comment verdict

**计划阶段通过。**

修改集中于共享接线、权限范围和提示词原 owner，并删除逐工具预览及静态专属接口，没有新增依赖、配置模式或公共协议。

§25.8 承诺实际满足：

```text
C >= max(1, ceil(E × 0.15))
```

预计 `E=180–260`、合格邻近中文说明 `C≥27–39`，预算可行。实际 E/C、最终类型检查及完整回归须依据实现 diff 独立核算，本轮不提前认定其完成。

## Release verdict

**APPROVE — 仅批准 `docs/plans/execute-v1-unified-tools-auto-review.md` 当前 R8 的完整方案。**

本轮完整范围审计及计划阶段验证通过。可原样记录本 verdict，将 `Approved revision` 设为 `R8`，并按工作流进入实施。最终实现仍须完成规定的 TDD、完整回归、包级类型检查及独立实现审计。

## 26. R9 当前修订：复用输出契约与程序值通道

### 26.1 需求、证据与首个分歧

R9 完整保留第25节的 V1 统一执行、运行时 AUTO、暂停/升阶、当前工具集合、取消、归因、上下文及上游 TXT 合同；替换原生结果的 `{title, output, metadata}` 脚本投影。输入 schema、原工具执行/权限和普通模型文本保持原职责。

| Evidence | 直接观察 | Owner / classification |
| --- | --- | --- |
| 官方 v2.2.5 `core/src/codemode/tool.ts:300–327` | schema 来自原工具定义；JS 取业务 output，否则取原文本；宿主 metadata 独立 | 上游对照 / observed |
| 官方 v2.2.5 `codemode/src/tool-runtime.ts` describeTool、`tool-schema.ts` outputTypeScript | 输出 schema 生成 Promise 返回签名，搜索同样返回完整签名 | 现有运行时能力 / observed |
| Codex `481cb038c2` 的 `code-mode-protocol/src/description.rs:443–491`、`core/src/tools/context.rs:493–518` | schema 描述返回值，Shell 只投影程序结果字段；未声明输出时才显示 unknown | 上游对照 / observed |
| 本地 `session/tools.ts:600–601`、`tool/code-mode.ts:91–97` | native 输出 schema 为 undefined，且整个 metadata 进入 JS；输入仍取原 ToolJsonSchema | 第一分歧 / observed |
| 本地 `codemode/src/tool-schema.ts:285–307` | 原输出渲染器接受 Effect schema，原 decodeOutput 同时校验与投影；无需新转换器/validator | CodeMode / observed |
| `tool/tool.ts:54–62`、`mcp/catalog.ts:60–98` | 已有 program.value 与宿主附件、context 分离的通道 | Tool / MCP / observed |
| `read.ts:208–235,698–717`、`glob.ts:60–95`、`grep.ts:154–168,229–243` | 原始 display、绝对路径数组、匹配行已存在；展示文本另外生成 | 各原工具 / observed |
| `shell.ts:791–810`、`task.ts:282–287,427–478,506–515` | exit/恢复路径、task身份/后台状态均来自原执行结果 | 各原工具 / observed |
| `todo.ts:6–7,36–41`、`question.ts:6–8,34–40` | Todo.Info、Question.Answer schema 与实际数组可直接复用 | 原 domain schema / observed |
| `processor.ts:75–79,423–467,563–584` | 临时真值字段只从持久化副本移除；原 Exit 保留完整宿主结果 | SessionProcessor / reachable |
| `server/.../handlers/experimental.ts:94–104`、`cli/cmd/debug/agent.handler.ts:66–96` | HTTP工具列表显式取 id/description/parameters，debug 的可用性只取id；新增内部输出字段不进入公共 HttpApi | 直接消费者 / observed |

R9 的 origin 是原生目录没有接入输出声明，原生 JS 投影又直接选择了整个宿主结果。修复在已有 Tool 定义和 CodeMode 桥完成：工具声明业务结果，桥只交付程序值，原 CodeMode schema 机制描述并验证该值。

### 26.2 唯一主路径与字段扩展

```text
Tool.Def 的原 parameters / 新增可选 output schema
  -> 原 registry.tools 透传
  -> SessionTools 的同一 catalog
  -> 原 CodeMode.Tool.make 的 output / 原 signature + decodeOutput

原 execute -> 原 hooks/校验/权限/结算
  -> 已有 result.program.value（结构化业务值）或 result.output（原文本）
  -> 同一输出 schema 校验 -> JS -> 脚本 return 的父回执
```

精确接口：

```ts
// tool/tool.ts；其余 Def、Context、ExecuteResult 字段保持原定义。
interface Def {
  output?: Schema.Decoder<unknown>
}

// tool/code-mode.ts；沿用已有字段名，同时接受原 MCP JSON schema 和原生 Effect schema。
interface CatalogEntry {
  outputSchema?: JSONSchema7 | Schema.Decoder<unknown>
}
```

`registry.tools` 在原返回对象透传 `output: tool.output`。原生/custom/resource 目录使用 `item.output ?? Schema.String`；MCP 继续使用原 MCP outputSchema。CodeModeTool 的返回选择改为 `result.program ? result.program.value : result.output`，保留显式 null 值。原 `Tool.ExecuteResult.output` 必为 string，缺省文本是已支持的值域，不是失败后的替代实现。

结构化工具使用已经存在的 program.value；output schema 直接交原 CodeMode，不经过第二套 JSON schema 转换。已有 `outputTypeScript` 使用 decoded 类型生成精确字段，已有 `decodeOutput` 拒绝错误结果并排除未声明字段。输入参数、参数 decoder 与 ProviderTransform 原样复用；原 JSON Schema 类型兼容继续保留。MCP 未声明输出 schema 时保持既有协议事实，不猜测远端字段。

宿主仍取得完整 title/output/metadata/attachments/context，继续完成输入真值回写、UI、Summary/Revert、截断和指令交付。JS 不再批量收到 `_syncInput`、`_formattedContent`、面板副本、压缩计数等宿主字段；直接选择业务值即可，无需新增字段黑名单、清理器或元数据注册表。

### 26.3 输出值域与复用点

| 工具 | JS 返回值与输出 schema | 复用位置 / 精简效果 |
| --- | --- | --- |
| read | 现有 Display 的 file/directory 对象，或媒体/省略提示 string；file 保留 type/path/text/lineStart/lineEnd/totalLines/totalLinesExact/truncated，directory 保留 type/path/entries/offset/totalEntries/truncated | 把既有 Display 类型改为同形 Schema 并从其推导 Type，避免两份字段定义；原 run 的结果复用 metadata.display，媒体分支使用原 output。正文只保留一份，版本证明和preview留宿主 |
| glob | `{files: string[], truncated: boolean, partial: boolean}` | 绝对路径数组计算一次，文本与program共用；metadata保留原计数与标志，文件数可由数组得出 |
| grep | `{matches: {path:string,line:number,text:string}[], totalMatches:number, truncated:boolean, partial:boolean, timedOut:boolean}` | 复用现有 bounded final rows；空结果/超时/partial沿原分支提供空数组和真实状态。totalMatches沿用已观察匹配数，截断时为下界；原文本及metadata不变 |
| shell / bash | `{output:string, exit:number|null, truncated:boolean, outputPath?:string}` | 在原 execute 的结果映射处选择原模型文本、退出码和已有恢复路径；用户面板output、耗时及压缩统计留宿主 |
| task | `{task_id:string, status:"running"|"completed", output:string}` | 在原 run 的成功结果映射一次：sessionId作为task_id，实际background标志区分running/completed，output沿用完整原文本和notice；错误时原child metadata继续提供恢复ID |
| todowrite | 原 todos 数组；schema直接复用 Parameters.fields.todos | 不解析已有JSON展示文本，不重复定义Todo字段 |
| question | 原 answers 数组；schema复用 Schema.Array(Question.Answer) | 直接复用答案数组，问题身份由原输入顺序关联 |
| edit/write/apply_patch | 原完整模型文本 string | 保留修改摘要、受控diff、部分失败与诊断文字；完整 metadata.diff、逐文件patch及临时真值不再作为第二/第三份副本进入JS；这些工具无需为本轮新增输出适配 |
| webfetch/websearch/skill/goal/plan_exit、custom与resource入口 | 原 output 文本 string | 原文本与附件/context合同保持；已有JSON文本仍按文本契约交付，脚本需要解析时调用JSON.parse；新注册的文字工具自动支持 |
| MCP | 原 structured/text/media-marker 程序值 | 原 programResult、输出声明、附件通道保持；不引入新的远端协议映射 |

plain text 与结构化输出是同一桥接接口的两种明确值域。新增输出 schema 只描述实际返回值，metadata本身仍留在原宿主生命周期；不重建 ToolResult 或改公共 Session/wire/schema/SDK。

### 26.4 已执行的计划阶段验证

| Check | Result | 证据范围 |
| --- | --- | --- |
| 原 CodeMode.make + Effect结构化output，返回含未声明 `_syncInput` 的对象 | Promise签名包含files/truncated；程序值仅保留这两字段 | 原渲染器与decoder已经具备所需能力 |
| 同一原decoder返回 `{files:123}` | `InvalidToolOutput` | 错误字段被既有机制拒绝，不回退为宿主metadata或文本 |
| `bun typecheck --project D:/Temp/opencode/execute-output-types.json`，cwd=packages/opencode | exit 0 | 真实 Tool.Def、CatalogEntry、JSONSchema7 与 CodeMode.Tool.make 类型消费；候选仅加上述字段，无断言规避 |
| `D:/Temp/opencode/execute-output-proof.ts` 初次加载 | 加载失败 `Expected the registry pass-through` | 临时匹配误覆盖Core同名文件；限定到opencode/src后修正，仅为夹具故障 |
| 下述真实Session候选命令 | 5 pass / 13 assertions | 真实glob/read组合、原插件参数校验、私有metadata隔离、read/skill上下文、真实MCP结构化及媒体 |
| 同一真实read结果在桥处度量 | 宿主信封884字节，程序值174字节，重复读取同样结果 | 该固定样本序列化体积约减少80%；只说明此样本，不作为整套性能/token收益 |

```powershell
# cwd: packages/opencode；仅内存模块替换，原工具执行体、权限和fixture均真实运行。
bun test --preload D:/Temp/opencode/execute-output-proof.ts --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'native glob and read|custom tools use|delivers read instructions|real MCP structured call|MCP media stays'
bun typecheck --project D:/Temp/opencode/execute-output-types.json
```

候选只在V1模块载入时添加输出透传、glob/read业务值与现有schema声明，并调整该公共验收中的脚本消费形式；自定义fixture返回真实内部metadata，同时保持非法参数在写盘前拒绝。剩余结构化工具的值域已从原生产分支定位，实施时通过公共Session组合回归验证，不为每个字段另建测试框架。

### 26.5 文件、职责与双向映射

以下为R9相对当前R8工作区的增量；第25节剩余验收及全部保留接口仍在完整任务内。具体 schema/value 以26.3为唯一字段清单。

| File | 修改切点与责任 | 预计行差 |
| --- | --- | --- |
| `packages/opencode/src/tool/tool.ts` | 1：Def新增可选output声明；现有program/context和输入契约不变 | +2～4 |
| `packages/opencode/src/tool/registry.ts` | 1：原返回对象透传output，原hook/input校验及成员选择不变 | +1 |
| `packages/opencode/src/session/tools.ts` | 1：同一catalog接入native输出，原文本工具明确Schema.String；MCP取原schema | +1/-1 |
| `packages/opencode/src/tool/code-mode.ts` | 2：现有outputSchema字段接受Effect schema；统一返回program.value或原output文字 | +3～5/-3 |
| `packages/opencode/src/tool/read.ts` | 3：Display改同形schema并推导类型；声明Display|string；原run结果映射到program | +15～25/-19 |
| `packages/opencode/src/tool/glob.ts` | 3：声明输出；绝对路径数组只算一次；同一数组/标志进入program | +8～12/-2 |
| `packages/opencode/src/tool/grep.ts` | 3：声明输出；已有empty/timeout/partial分支补对应程序值；复用final rows与已有状态 | +20～35 |
| `packages/opencode/src/tool/shell.ts` | 2：声明输出；对原execute成功结果映射program，原进程、parse、ask、kill/drain不动 | +12～18 |
| `packages/opencode/src/tool/task.ts` | 2：声明输出；在既有run出口统一映射task_id/status/output，保留错误metadata和notice | +10～15 |
| `packages/opencode/src/tool/todo.ts`、`question.ts` | 各2：复用原schema声明输出，并返回原数组的program值 | 各 +2～4 |
| `packages/opencode/test/session/execute.test.ts` | 原公共fixture中更新调用方式；整合文件/搜索/状态数据、返回签名、宿主字段隔离及原输入校验；其余既有场景沿同一新返回契约 | +40～80/-15～30 |
| `packages/opencode/test/tool/code-mode.test.ts` | 若需独立固定错误输出行为，在既有真实CodeMode/Host seam加一项；MCP原契约与附件用例保持 | 0～15 |
| 本canonical plan | 用户原文、R9证据、文件表、完整审计与实现记录 | 文档分段更新 |

零新增生产模块、依赖、配置、公共HttpApi、迁移或生成文件。`tool/json-schema.ts`、`codemode/tool-schema.ts` 与 `Tool.wrap` 的现有算法可直接承载R9，保持原实现。程序值沿producer现有采集/分页边界；Tool.wrap继续只界定普通模型文本，父execute最终输出仍沿原截断。Task的program使用原run返回文本，普通模型/持久化的截断与恢复路径继续由原owner处理，避免在Task重做一套通用截断。

| Requirement / invariant | Production owner / path | 文件与行为验证 |
| --- | --- | --- |
| OUT-01 模型可获知真实返回类型，输入不被降级 | Def.output -> registry -> catalog -> 原outputTypeScript/search | 四个公共接点；真实目录中返回字段/Promise<string>，原非法输入依旧在body前拒绝 |
| OUT-02 JS只取得业务值或原文本，宿主字段留宿主 | 原program.value / output -> 原CodeMode.decodeOutput | 原生read数据、普通custom文本、原MCP值；临时真值/UI副本不出现在程序结果，原child仍保留审计数据 |
| OUT-03 正文、匹配、退出/分页/部分结果、任务恢复信息完整 | 26.3的各producer，原metadata/context仍并行交宿主 | Session组合一次验证read/glob/grep/bash，现有Task失败恢复、Question/Todo数组与read/skill上下文回归 |
| OUT-04 单一真实结果与schema同步 | 原Tool.make.output + decodeOutput | 原InvalidToolOutput回归，真实目录与执行共享toolTree，不新增第二个validator |
| R8全部权限/取消/归因/投影/原文合同 | 第25节原路径 | 继续执行25.8全组与最终独立审计 |

| 生产概念 | 需求、证据与为何现有接线不足 |
| --- | --- |
| Def.output可选字段及原透传 | OUT-01；原目录仅接MCP输出。只补同一个定义字段即可驱动现有渲染和校验，不新增结果注册表 |
| 原生program.value | OUT-02/03；字段已经由MCP使用，原生有现成结构化数据。复用此通道隔离宿主信息，不建另一结果类型或通用过滤器 |
| Display的schema取代手写type | OUT-01/03；相同字段既服务已有metadata又服务返回声明，推导Type消除双份契约 |
| 原文String缺省 | OUT-01/02；Tool.ExecuteResult已经承诺output:string，新文字工具直接可调用；这是主路径值域，不是解码失败后的降级 |

新增失败后备用成功路径为0；新增诊断决策分支为0。结构化/文本/MCP属于同一值域的约定分支。拒绝输出schema的结果沿既有InvalidToolOutput失败，继续保留JS可捕获普通工具错误、权限/取消穿透的区别。

### 26.6 TDD、验证与余项

沿已确认的SessionTools/CodeMode公开seam逐片实施：

1. 先将现有真实glob/read组合脚本改用`found.files`与`file.text`，并通过原目录搜索观察返回签名。R8会因仍返回宿主信封而失败。最小接入Def.output、原program投影与两个producer后转绿。
2. 将真实custom fixture输出中加入宿主临时字段，验证JS仍只获得原文本，同时保留合法/非法参数与磁盘结果的原断言。目录声明String，普通输入schema完全不变。
3. 扩展同一文件/搜索组合和既有Shell场景，覆盖空结果、truncated/partial/timedOut、退出码及输出路径；复用现有参数化原工具测试，不逐工具新建文件。Todo/Question用真实服务与答案等待观察原数组；Task保留原恢复ID和后台状态回归。
4. 复验MCP structured/media、运行时AUTO上界与暂停、取消、Goal、Task、Summary/Revert、正文/指令交付、compaction/TUI。更新既有脚本里的`.output`/`.metadata`消费位置，不增加旧新输出并行兼容层。

沿25.8规定命令执行完整包内检查，新增常用输出场景仍放原session/execute文件；最终四包typecheck、限定路径lint、git diff --check及独立实现审计全部完成后放行。原TXT空/完整/部分目录的固定原文hash继续复验，动态工具签名则按真实新增output声明生成。

R9输出扩展预计11个生产文件、1～2个现有测试文件、0个新生产/测试文件。相对R8新增有效代码约150～230行，邻近中文说明至少23～35行；最终门禁对当前HEAD以上完整本任务diff计算，排除并行hunks、纯移动/原文移动、import-only和空行，严格满足`C >= max(1, ceil(E * 0.15))`。解释只覆盖宿主/JS视图、同源数据、真实部分结果、媒体/Task恢复与验证意图。

R8已执行证据继续保留：核心35 pass/130 assertions；CodeMode整包265 pass/791 assertions；原工具/指令/压缩394 pass/1 skip；TUI36 pass；权限/目录批次初次357 pass/2个旧短描述断言失败，按已批准上游首句同步后相关三文件64 pass/169 assertions；限定lint为0 errors/387 warnings。codemode/opencode/tui类型检查通过，core的并行测试类型问题已交原任务处理。

Shell四组为120 pass、30 pass、20 pass，以及Windows/native组72 pass/1 timeout/1异步清理error；失败用例`reports final PowerShell status with native exit codes [powershell]`在原30秒界限复现。该文件当时已恢复为R7前逐字内容；独立运行两种Shell的同名用例仍为1 pass/1 timeout。此失败保留为实际未完成验收，后续定位累计十次进程调用的耗时；不增加超时、跳过断言或把它记为通过。

### 26.7 范围与审计

目标仍为完整verified-implementation-and-commit，R7/R8已有的全工具和生命周期合同保持。此前JS宿主信封属于本任务尚未发布的候选，用户明确要求改为对齐上游的返回值；直接替换该投影，持久化历史/公共SDK/普通工具文本继续原格式。MCP声明及附件按既有协议保持。

本轮不追求全部工具都返回JSON对象；准确的String签名同样是完整输出契约。文字工具及小型元数据保持原生产实现；仅对已经存在且适合程序组合的数据提供结构化视图。未来字段由同一Def.output与program维护，执行入口无需按工具名新增分支。

R9方案审计覆盖第1节完整原始需求、第25节保留合同及本节全部新增路径；记录独立原文verdict后，才继续生产修改。实现审计覆盖撤回到工作区的完整本任务最终diff及所有直接消费者，保留并行修改归属。未完成的包类型/Shell验收继续处理，当前记录不构成发布或提交放行。

### 26.8 独立方案审计记录（Round 6 / R9）

- Invocation: `ses_e503d92b1ffeey3fvtbHnfj4so`，`Audit mode: plan`，完整范围。
- 首次临时 release verdict 原文：**BLOCK — R9 独立运行验证待完成；当前没有要求方案返工的 blocking finding。**
- 同一轮补齐独立运行验证；下面完整保留最终verdict，替代临时BLOCK，设计无夹带修改。

## Blocking findings

No blocking findings.

## Non-blocking findings

无。上一条 verdict 中待完成的独立运行验证已完成，R9 无需因此修订。

§26.6 已记录的 Windows Shell 超时、异步清理错误及未完成的最终验收继续作为**实现阶段待办**保留，本轮未将它们记作通过。

## Rejected speculation

- 不要求恢复逐工具 preview 或静态预演；用户已授权在真实权限请求处暂停、审查后续跑。
- 不要求所有工具返回结构化对象；文本工具的准确 `Promise<string>` 同样满足输出契约。
- 不将 MCP 未声明输出类型或边界值类型 `unknown` 认定为原生输入 schema 降级。
- 不要求新增元数据黑名单、第二套校验器、结果注册表、跨执行审批缓存或事务机制。
- 不将并行 token/retry 工作区改动及无关既存问题扩入本任务。

## Requirement and traceability coverage

本轮完整覆盖 §1 原始及更新需求、§25 保留合同和 §26 全部新增路径。

| 要求 | 核对结果 |
|---|---|
| 当前全工具共享原执行与校验 | `packages/opencode/src/session/tools.ts:178–183,519–611` 汇合有效工具表；`tool/tool.ts:169–183`、`tool/registry.ts:133–183` 保留原 decoder 与执行体。 |
| 整段 AUTO、同级复用与升阶 | `packages/opencode/src/permission/index.ts:286–341` 使用真实请求、调用级上界及同一审批锁；显式规则、终局拒绝和跨执行隔离保持。 |
| 取消、部分完成事实与归因 | `session/tools.ts:248–270,326–339`、`session/processor.ts:563–584` 保留宿主清理、真实子记录及失败回执；模型投影和压缩消费父回执。 |
| 模型可获知真实返回类型 | R9 补齐 `Def.output → registry → catalog`，复用 `packages/codemode/src/tool-schema.ts:285–307` 的签名生成和输出解码。 |
| JS 取得业务值，宿主保留完整结果 | §26.2–26.3 复用 `program.value` 和原文本；已核对 read/glob/grep/Shell/Task/Todo/Question 的实际生产分支及下游消费者。 |
| 上游 TXT 与简洁架构 | 已直接核对官方 v1.19.5 提示词及 v2.2.5 编排源码；TXT 保持原文分支，R9 复用既有 schema、结果通道和 decoder，无新增生产模块或依赖。 |

TDD 切片具备行为敏感性：`found.files`、`file.text` 和 custom 文本断言能够捕获当前宿主结果信封与目标契约的差异；原输入拒绝、权限、取消、上下文和归因断言继续保留。

**本轮独立实测：**

| 工作目录 | 验证范围 | 结果 |
|---|---|---|
| `packages/opencode` | §26.4 R9 内存候选：真实 glob/read、custom、上下文、MCP structured/media | **5 pass，13 assertions** |
| `packages/opencode` | Session execute、SessionTools、ExecuteReview 回归 | **35 pass，130 assertions** |
| `packages/codemode` | codemode/signature，含输出解码及上游提示词三分支 | **69 pass，283 assertions** |
| `packages/opencode` | AUTO/precheck/显式权限/reviewer prompt、CodeMode、registry | **359 pass，1285 assertions** |
| `packages/opencode` | `bun typecheck --project D:/Temp/opencode/execute-output-types.json` | **通过，exit 0** |
| 仓库根目录 | `git diff --check` | **通过，仅提示并行 SDK 文件的换行转换** |

合计 **468 项测试通过、1711 条断言、0 失败**。R9 候选组按计划筛选了 5 项测试，其余 23 项未在候选组运行；保留的执行合同另由上述完整回归覆盖。这些结果支持方案可行性，最终 R9 实现仍须独立验收。

## Primary-path and fallback verdict

**通过。**

权威路径为：

```text
有效工具表 → 共享 invoke → 原 decoder / hooks / body
                         → 原 ctx.ask → ExecuteReview → 原执行与结算
                         → program.value 或原 output
                         → 原 CodeMode 输出解码 → JS
```

结构化值、文本及 MCP 协议值属于接口约定的不同值域。输出解码失败沿既有错误路径退出；运行时暂停直接替换用户允许撤下的静态预审。

新增备用成功路径为 **0**，新增诊断决策分支为 **0**。新增概念均有需求、真实生产者及责任归属。

## Code quality and Chinese-comment verdict

**计划阶段通过。**

修改集中于原工具定义、数据生产者及统一桥接入口；现有签名生成、解码、权限和生命周期逻辑继续复用。内部输出声明不扩展公共 HTTP 协议。

§26.6 预计增量 `E=150–230`、合格邻近中文说明 `C≥23–35`，并承诺对最终完整本任务 diff 满足：

```text
C >= max(1, ceil(E × 0.15))
```

预算可行。实际 E/C、排除行及最终代码质量须由实现审计按实际 diff 核算。

## Release verdict

**APPROVE — 仅批准 `docs/plans/execute-v1-unified-tools-auto-review.md` 当前 R9 的完整方案。**

同一 R9、同一轮审计的独立验证已完成，本 verdict 取代此前“待执行验证”的临时 BLOCK。可原样记录本结果，将 `Approved revision` 设为 `R9`，进入获批范围的实施。

最终实现仍须完成规定的 TDD、完整回归、包级检查、已记录失败项的处理及独立实现审计，之后才能进入提交阶段。

### 26.9 R9 实施证据（持续更新）

用户进一步明确：

> 我没有说不让你扩展功能范围，我指的意思是说你扩展的时候你要保持克制。你要思考是否必要，思考是否必要。你不要左，用户左说一下右说一下，然后你就左干一下右干一下。你像一条蛇一样在扭来扭去。你要保持 stable，思考你的 main principle 是什么东西。

按同一必要性标准检查实际diff：保留已批准输出合同及全部原执行/权限/归因行为。移除本任务旧信封阶段新增的glob.metadata.files副本：现有消费者只在edit/apply_patch路径读取metadata.files，脚本现已使用program.files。原glob持久化计数/标志与普通文本恢复原形，公开程序值不变。readToolMetadata为既有实现，保留其原职责；MCP协议分支、读取可见性、强制上下文、当前工具接纳及取消路径各有既有消费者与行为测试，继续保持。

红绿证据：原native glob/read脚本改为直接消费files/text后，失败为`Cannot access a property on a non-object value`；公共输出接线与原数据投影完成后1 pass/6 assertions。Shell程序值要求退出码/完整性时原文字结果失败，接回原真实字段后动态并发审批与JS状态续跑通过。grep要求结构化行时收到原格式化文本而失败，复用原final rows后通过。Todo/Question/Task组合最先因todos还是JSON字符串失败，复用已有schema/数组及原任务身份后通过，前后台身份与真实child metadata一致。

实际验证：

- `packages/opencode`：原Execute/SessionTools/ExecuteReview三文件，**36 pass / 148 assertions**。
- `packages/opencode`：25.8权限/CodeMode/registry七文件，**359 pass / 1285 assertions / 120.18s**。
- `packages/opencode`：25.8原工具/指令/compaction九文件加现有task测试，**432 pass / 1 skip / 5388 assertions / 128.63s**。
- 上述两个大批次初次达到终端120秒总限额，重跑仅把终端等待改为600秒；原命令中的每测试`--timeout 30000`及全部断言保持。
- `packages/codemode`整包：**265 pass / 791 assertions**；`packages/tui`原session-message-render：**36 pass / 743 assertions**。
- `packages/opencode`、`packages/core`、`packages/codemode`、`packages/tui`的`bun typecheck`均通过；此前Core测试类型错误已由并行任务修复。
- 用户再次要求核对TXT：从官方v1.19.5 API直接取得原源码，固定文案逐行匹配；开头原句位于上游tool-runtime.ts:554。唯一存储占位差异为PARTIAL计数的`{{shown}}/{{total}}`，运行时恢复原动态文本；原三分支完整SHA验收再次**1 pass / 3 assertions**。

Shell余项的额外证据：`D:/Temp/opencode/shell-status-proof.ts`只在内存记录原用例耗时，前8条命令均通过，耗时6450/3872/2799/2905/2904/2425/2348/2715毫秒；原30秒总界限在第9条处触发。余下param与Write-Information场景单独使用同一真实工具与原断言通过，耗时5608/2530毫秒。无竞争测试进程时原整组仍30秒超时。此证据证明所有原退出码场景，但原10次启动合并限时的验收仍记为失败，等待明确预算处理决定；原测试与Shell运行逻辑保持。

## 27. R10：按独立调用校正已有状态矩阵的验证粒度

### 27.1 原文、实测与责任

在询问增加整组预算后，用户原文要求：

> 你需要按照Workflow里面的逻辑去，或者说First Principle的逻辑去思考。你不要直接告诉我什么要不要把它改成60秒，改成60秒万一也会超呢？你要去思考到底怎么回事儿。

预期不变量：既有每一种PowerShell调用都返回准确退出码；非零码的模型文本还包含同一码与真实方言。每个独立场景继续使用原30秒保护。真实缺陷是测试把十个独立场景串在一个固定计时窗口，平台启动次数叠加后先耗尽窗口；既无单条卡住，也无退出清理等待泄漏的证据。

| Evidence | Observed / contracted fact |
| --- | --- |
| 原用例命令，已多次执行 | `bun test --timeout 30000 test/tool/shell.test.ts --test-name-pattern 'reports final PowerShell status with native exit codes \[powershell\]'`，cwd=packages/opencode；在30秒处失败，至少22/23条原断言已完成；测试强退引出随后capture host lost |
| 直接启动系统powershell.exe | 相同短命令Write-Output与Write-Information绕过OpenCode仍分别耗时2255/2047毫秒，退出码0 |
| `D:/Temp/opencode/shell-phases-proof.ts`，原IPC信号计时 | 第一条ready/started/root-exit/completed/close为1858/2610/4676/4679/4697毫秒；第二条为666/933/2948/2951/2966毫秒。命令约2秒、宿主约0.9秒，退出排空与关闭仅约20毫秒 |
| `core/src/windows-shell-output.ts:429–476,544–575` | 每次openRemote新建独立宿主，started确认独立根PID；该状态矩阵没有复用Shell/宿主进程的测试语义 |
| `test/tool/shell.test.ts:99–112,196–213,3650–3677` | 每次run都initShell，withShell仅选择和恢复相同方言；cases是独立常量，断言只依赖本条命令/预期码，不消费上一条输出或文件 |

第一分歧及owner：`test/tool/shell.test.ts:3652–3676`在一次it.live内循环十个案例，却只给一次30秒。脚本退出码语义、生产capture的Job/IPC/清理以及工具输入/权限均保持原实现。无需为这个验证错误增加宿主复用池、第二种spawn、运行时缓存、时间常量或放宽生产超时。

### 27.2 最小修正与已运行候选

唯一增量文件为`packages/opencode/test/tool/shell.test.ts`：原cases数组移到it.live注册之前，原`for (entry of cases)`移动到注册层；每条以原测试名前缀、方言及命令标识注册。回调内仍执行原withShell/runIn/run与三条原断言，`30_000`保持不变。

```ts
for (const item of ps) {
  const cases = [/* 原十条原样移动 */]
  for (const entry of cases) {
    it.live(`reports final PowerShell status with native exit codes [${item.label}] ${entry.command}`,
      () => withShell(item, runIn(projectRoot, Effect.gen(function* () {
        // 原单条执行及退出码/错误notice/方言断言原样移动。
      }))), 30_000)
  }
}
```

隔离加载器`D:/Temp/opencode/shell-case-registration-proof.ts`直接截取原cases字面量和原执行/断言块，移动注册位置，未新增测试场景。初次探针因源文件CRLF而未匹配到块，修正内存换行读取后执行：

```powershell
# cwd: packages/opencode
bun test --preload D:/Temp/opencode/shell-case-registration-proof.ts --timeout 30000 test/tool/shell.test.ts --test-name-pattern 'reports final PowerShell status with native exit codes'
```

结果：**20 pass / 48 assertions / 96.92秒 / 0 fail**，覆盖两种已安装PowerShell各十条原命令。其余241个注册项未在此窄验证运行；实施后按第23节四组运行整个Shell套件，原243个注册项变为261个，实际命令场景与断言总量保持原值。两组矩阵拆开会多走原测试scope，实测耗时已记录，不声称此修改提高生产进程性能。

### 27.3 映射、验证与完整放行

- Forward：准确退出码/真实方言 -> 原Shell.run生产路径 -> shell.test原case -> 原expected exit与notice断言。修改只让时间保护按该独立行为粒度生效。
- Reverse：将循环移到注册层 -> 已观测的累计平台启动开销与独立输入域；继续复用it.live/withShell/runIn/run，无新增helper或生产概念。
- Paths：全部原case仍执行同一生产路径；备用成功/诊断生产路径增量均为0，无测试skip或输出伪造。
- TDD：已复现的原整组失败为red；保持原场景和断言的内存候选为green。实施后同一测试名前缀仍选中全部原场景，随后执行完整Shell四组及第25/26节所需回归和包级检查。
- Diff/comment：单文件三个相邻移动点，约+4/-2有效行，其余为纯移动/缩进；邻近两行中文说明独立场景与超时owner，达到增量门禁。最终仍对完整任务计算实际E/C。
- Scope：第25、26节全部产品需求、输入/输出契约、上游原文、权限/取消/归因与代码质量继续约束实现；R10仅补这一已确认的验证修正。原有基线失败继续保留历史记录，候选成功不替代最终完整验收。

本轮属于用户追加根因调查要求后的规划阶段；此前R9方案审计已批准，未遗留方案blocking finding。送审按完整原始需求与本修订全范围进行，历史审计记录继续保留，不用新阶段消解任何现存blocker。

### 27.4 用户授权的阶段合并

用户最新原文：

> 请注意一点啊，我觉得就是你不要每次都是你改一点，然后你去审计一下方案，然后再去执行，再去打。我觉得我现在可以允许你进行这个，就反正我们最终的目标就是做出来一个高质量的一个东西。然后呢，我也授权你进行，就是你先改，改完之后呢，然后你到时候你这个方案审计，还有这个实施审计你一块去做就OK。那请注意这一点，你给他们一些必要的这个 background，就是说用户去，为了加快，用户为了去允许这个，用户为了怎么怎么样，然后允许了进行怎么怎么样，然后现在你需要干什么，巴拉巴拉巴拉。反正就是你就是做出来一个这个 hunk 修改数较少，然后就是保持这个内容质量又保持较高的这种泛用性、泛化性，等等的这种一套逻辑行为，巴拉巴拉的。

该明确授权调整本轮阶段门禁：先完成必要的代码与验证，再对完整方案和完整实际diff合并进行独立审计。`Approved revision`仍为none，避免把用户流程授权记成独立APPROVE。完整需求、原路径、输入语义、质量/注释门禁、最终独立审计与提交边界保持；最终审计handoff附本段原文作为授权背景。

## 28. R11 最终实施与合并审计材料

### 28.1 最后一处验证竞态

完整Shell四组首次为120/30/20组全部通过，Windows/native组90 pass/1 fail：`does not append block-buffering hint on timeout with output`在负载下于输出到达前触发原3000毫秒超时。该例要验证的是“已有输出时的超时诊断”，原代码用平台启动耗时猜测就绪，实际进入了另一分支。生产行为对空输出给出诊断正确，修复owner为同一`test/tool/shell.test.ts`中的观察条件。

使用现有it.effect/TestClock与ctx.metadata：真实输出含started时完成Deferred，之后推进虚拟时间触发原timeout，再等待原进程清理并执行全部三条旧断言。初次只推进timeoutMs仍未越过原生产代码的100毫秒调度宽限，15秒测试保护暴露等待；修正为虚拟推进timeoutMs*2后，真实工具的timeoutMs、15秒测试保护和断言均保持。该变化只替换测试的时间同步方法，零新增生产行为/常量/重试/文件。

窄验证`bun test --timeout 30000 test/tool/shell.test.ts --test-name-pattern 'does not append block-buffering hint on timeout with output'`：1 pass/3 assertions。原Windows/native完整分组再次91 pass/256 assertions/202.18秒；结合另三组，最终261 pass/939 assertions，覆盖全部原场景。新增注册数量来自展开原矩阵，场景与原断言总数不增。

### 28.2 最终验证

| cwd | 命令/范围 | 实际结果 |
| --- | --- | --- |
| packages/opencode | 25.8 Execute/SessionTools/ExecuteReview三文件 | 36 pass / 148 assertions |
| packages/opencode | 25.8权限/CodeMode/registry七文件 | 359 pass / 1285 assertions |
| packages/opencode | 25.8文件工具/指令/compaction九文件 + test/tool/task.test.ts | 432 pass / 1 skip / 5388 assertions |
| packages/codemode | bun test --timeout 30000 --only-failures | 265 pass / 791 assertions |
| packages/tui | 25.8 session-message-render测试 | 36 pass / 743 assertions |
| packages/opencode | 第23节四个互斥Shell分组，原每例时限与断言 | 261 pass / 939 assertions |
| packages/opencode/core/codemode/tui | 各包bun typecheck | 全部exit 0；最后opencode再次通过 |
| root | 52个相关源码/测试路径调用原bun run lint | 396 warnings / 0 errors；包含整文件既有及共享文件并行告警 |
| root | git diff --check | 通过 |

主验收合计1389 pass、1个既有skip、9294 assertions。额外用`D:/Temp/opencode/execute-result-regression.ts`在内存复用原read/glob/grep/task回归：共享结果边界调用与CodeMode相同的Effect decoder；原grep literal partial/timedOut断言同步观察program值。`bun test --preload D:/Temp/opencode/execute-result-regression.ts --timeout 30000 --only-failures test/tool/read.test.ts test/tool/glob.test.ts test/tool/grep.test.ts test/tool/task.test.ts`得到143 pass/593 assertions，无新生产路径或永久测试文件。

上游TXT固定原文及动态三分支保持26.9的实测结果。Windows上执行了所有上述检查；其他OS执行留给原跨平台CI。生产源码不含临时计时/注册探针，诊断脚本仅在已标记的`D:/Temp/opencode/*-proof.ts`及`execute-result-regression.ts`中。

### 28.3 归属、差异与必要性

完整本任务diff artifact：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b07d49e7001pMDDj3eAR5PeoU`。基线HEAD为`72c2142d47f0e5fe560f74ab3b61fe853924ebd6`。artifact包含45个生产/测试路径，canonical plan为第46个路径；生产29个、测试16个。R7为32个生产、16个测试及plan，共49路径；保留全部行为后收敛到46路径。

共享文件`session/processor.ts`、`session/message-v2.ts`、TUI `routes/session/index.tsx`仅保留R7原归属hunks；已检查相对`11d619643f`的当前差异，新增token/retry/SSE内容归并行任务。artifact对这三文件使用原feature父提交到feature的精确diff，其余使用当前HEAD到worktree，新增文件使用no-index diff。完整共享文件仍供审计检查直接消费者；本任务最终提交按已授权hunk边界分离，保持并行内容原样。

必要性分组：

- Tool/registry/SessionTools/CodeMode/selection/prompt/request/runtime-flags：当前全工具目录、原参数校验与唯一执行入口；新工具自动接入。
- Permission/auto/reviewer prompt：真实请求的整体AUTO、风险上界与等待；原strict、ask/deny及拒绝/取消保留。
- MCP及read/glob/grep/Shell/Task/Todo/Question：原协议与同源程序值、准确输出声明；复用decoder，无结果注册表或第二种执行器。
- processor/message-v2/compaction/instruction/skill/TUI：真实子归属、父结果投影、必达上下文及显示/压缩消费者。
- CodeMode schema/运行时TXT：保留原输入域，完整原文与原目录/搜索分支。
- 16个测试路径：现有入口的约束、生命周期与下游消费者；仅Session execute和Permission execute是原R7新增文件，本轮继续使用这些seam。

已撤下静态preview/prepare/StaticInput/StaticCall/analyzeProgram/combine及专属用例；原parser归还原owner。移除旧glob.metadata.files副本和7条重复fixture说明；external-directory仅残留的import-only修改亦已撤回，该文件完整回到原基线。输入schema、edit/write/apply_patch执行体、公共协议、生成文件与并行源码保持其原职责。新增备用成功路径和诊断生产决策分支均为0。

### 28.4 E/C 与放行要求

计数脚本`D:/Temp/opencode/execute-diff-accounting.ts`，按45个实际diff路径计算：排除空行、import-only、同文件相同行/移动/缩进、纯注释行及原文TXT移动；C单独统计邻近中文解释并去重，重复fixture说明已删除。代码分母E=1657，合格中文解释C=251，要求ceil(1657*0.15)=249，C/E约15.15%。脚本在R7上得到E=1870/C=284；再排除当时24行跨文件parser纯移动与7条重复说明，与独立R7审计1846/277一致。当前parser已复原，无该跨文件排除项。

代表性说明位于：Permission.ready锁的并发边界；CodeMode保留null/false/0；read复用display与解释器复制边界；glob真实search锚点；Task回执状态与完成通知owner；Shell测试的输出就绪及独立计时责任。实际资格、完整代码质量和计数仍由最终独立审计核验。

按27.4原文进行一次完整合并审计，同时审方案和实际全部hunks/直接行为链；审计未通过前保持未verified。批准后才按原授权提交，正常hooks、中文多行conventional message、保留并行修改、不push、不amend。

## 29. R12：无副作用预检与相对HEAD收敛

### 29.1 本轮用户要求

用户原文（msg_1b0d30999001w0xI3dZdeK66TK）：

> 所以我说过了，相应的脚本的 execute 的解析，初始请求会落到 general，那不就是？那所以我说的东西就是，你让这个，你最多做的东西就是把这个 precheck 就增加一个 execute 的解析逻辑，就是把，因为本身 execute 它就是 JS 脚本去有各种各样的一些东西，那本身我们就可以，比如说类似一种 sandbox 或者什么东西，那本身它不就是进行各种各样的一些执行吗？那本身执行的具体操作，我们把它这个有一个 mock 掉，就是具体的这个命令的运行啊，返回啊，我们就不去执行。就比如说这个 execute 脚本调用那个 read，但是这个 read 我们就把它让这个 JS 的逻辑以为它是空不就 OK 了吗。所以按照这一套逻辑，你本身不就可以动态地去解析出来各种工具的它的一个初始的一个调用的一个结果，巴拉巴拉的东西吗。所以按照这种逻辑，你不就很好去做吗？然后就相应的各种工具的一个调用，调什么工具它都出来了，你直接先去进行一个 precheck 不就 OK 了吗。所以这样的话，你不就能避免所有的 execute 都直接默认判定为 general 吗。这样你还能部分地有一些明显的一些关键的 cautious 等等逻辑，都能够去进行一个有效的预审，然后加上这个 auto reviewer。

用户原文（msg_1b0a01153001Tke6Fb3T864DE7）：

> 不要试图增加一点用户本身没有要求或要求你改的 schema，schema 大部分内容，绝大多数内容，schema 都是避免去直接去改动的。除非用户说的一些，比如说像是那种什么 metadata，去和上游去做对齐啊，巴拉巴拉东西。你其他东西你改它干什么？比如说什么 boolean，为什么要改 boolean。然后又从 JSON Schema 改成 JSON Schema Node，然后或者又改成什么各种各样那些数组啊，巴拉巴拉的东西。这就很奇怪呀，不 make sense 啊。

用户本轮再次要求：

> 请保持你的 hunk 最小，相对于 HEAD 的修改最小，请注意这点。

> 因此请你保持收敛，保持必要的修改，不要进行无意义的一些各种各样的一些调整。

### 29.2 实测与实施映射

`bun D:/Temp/opencode/execute-precheck-probe.ts`（cwd packages/opencode）exit 0：read/bash桩返回null，独立git push被原分类器判cautious；依赖read真值的分支仅捕获read；访问read.text在空值处停止。真实工具、命令、hooks与reviewer的调用数均为零。

| 需求/不变量 | owner及本轮改动 | 行为验证 |
| --- | --- | --- |
| 整段代码先经过代码预检 | tool/code-mode.ts复用原toolTree、CodeMode.execute；桩只记录工具ID/参数并返回null | 同一Session场景的字面命令在首个文件写入前被拒；真实read结果依赖在运行时被拒 |
| 复用原schema与执行器 | 桩与真实树使用同一inputSchema；仅桩自身声明null返回；session/tools.ts将calls透传beginExecute，原invoke保持 | 原native/MCP/custom输入校验、结果、工具开关与子结算回归 |
| 原规则分级后决定AUTO | core/permission/precheck.ts新增execute聚合分支，复用evaluate及Patch.parse、structured files删除规则；最高风险与原因并集 | Permission execute的初次cautious审查、同级复用、升阶、forbidden及strict |
| 准确宿主上下文 | permission/index.ts显式捕获现有Config服务，使用InstanceState目录及原Shell.acceptable配置；candidate calls进入probe证据，真实请求进入trigger | 原配置与权限路由回归、computed workdir Session场景 |
| 预跑保持有界 | 使用原CodeMode预算1000毫秒/128次调用；诊断前观察到的调用仍送分类 | 空值中断探针及真实Session动态分支；真实执行保留原预算 |

本节替代第25节初始execute固定general的行为。实际child仍以原完整权限请求逐次检查，较高等级沿原暂停/整段审批路径处理。预跑中的空返回值可能改变分支，因此候选调用并非真实已完成动作；真实工具执行体、hooks、持久化、文件与进程操作仅由原invoke执行。

workdir使用捕获值和当前实例目录进行平台路径解析，复用FSUtil.windowsPath；PowerShell盘符相对路径沿原语义处理。MSYS专有挂载由实际Shell的cygpath解析，预检先复用分类器中与目录无关的命令规则；实际完整请求继续覆盖目录风险。预跑使用Core纯Patch.parse提取删除类型；候选补丁解析失败时保留原工具的实际校验职责。

### 29.3 收敛与验证

已将codemode/src/tool.ts、tool-schema.ts、test/signature.test.ts完全恢复HEAD，撤下JsonSchemaNode、Boolean/tuple扩展和专属测试。桥接沿用V1原有JsonSchema签名适配，schema对象及真实校验路径保持。core/permission/reviewer/prompt.ts及对应测试也完全恢复HEAD，额外execute专用提示退出。原JSON证据仍包含整段脚本、预跑候选及真实升阶请求。

read的Display声明服务返回签名并保持原字段；grep复用原匹配行及完整性事实；Task复用原sessionId与前后台结果。它们承担用户要求的程序结果与准确返回声明，原输入schema和工具执行过程保持。本轮继续保留有消费者的executeParent，供读取可见性、投影、压缩与TUI使用。

红绿：修改生产前，字面禁用命令场景因before.txt已写入而失败，动态场景通过。接线后两种均通过。扩大回归发现两条旧时机断言：前置审查时child数应为0、补丁删除拒绝应先于前序写入；对应更新后六文件109 pass/394 assertions。随后文档与Session测试被外部恢复为R11，引出三条旧断言失败；用户选择“恢复对应小改动”，本次仅恢复这些断言、动态分支对照与本节记录。

当前已执行：权限/CodeMode/registry八文件364 pass/1303 assertions；CodeMode整包264 pass/787 assertions；opencode/core/codemode各包typecheck通过；git diff --check通过。八文件命令为 `bun test --timeout 30000 --only-failures test/permission/auto.test.ts test/permission/precheck.test.ts test/permission/next.test.ts test/permission/reviewer-prompt.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts test/permission/execute.test.ts`，cwd packages/opencode。原生工具/Task/下游、Shell及TUI的第28节证据仍对应其未继续改动的实现。

本轮代码范围为41个源码/测试路径，连同本计划42个路径；第28节为46个路径。完整本任务hunk归属按28.3，三个共享文件保留原feature diff，其余相对HEAD。最新差异和有效行计数由原 `D:/Temp/opencode/execute-diff-accounting.ts` 输出，最终审计时读取当前文件。

恢复后最终Session Execute/SessionTools回归31 pass/130 assertions；当前差异artifact为 `C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b1347089001oo2bwYG68a53BT`。提交方核算E=1634、C=250、要求246；该计数及注释资格交由独立审计核验。

R11独立审计任务 `ses_e4f7f6168ffegsfbJcfr8JB9Mk` 返回BLOCK，提出等待审批的race败方取消及debug入口两项意见。用户要求先判断是否真实需求和设计语义；本轮保持这两处实现，交由完整新修订审计按更新需求核对。当前修订尚待合并方案/实现审计，最终提交沿原授权并保留并行修改。

### 29.4 R12合并审计与必要性复核

任务 `ses_e4eca6fa6ffehnUC8Mua4v3SeA` 的 release verdict 原文：

> **BLOCK — R12 方案与当前实现均不放行。**
>
> B-01、B-02 有独立核实的可达调用链。完整静态范围已检查，独立执行验证和实际 E/C 核算仍未完成；当前不能标记 `verified` 或据此进入提交阶段。

审计静态覆盖41路径，B-01指等待权限的race败方取消，B-02指debug agent直接执行execute时缺少Host。非blocking记录指出原动态并发测试现在覆盖的是前置审批。用户随后明确选择“允许执行验证”，授权审计员执行本地Bun测试、typecheck、lint和计数，代码与Git状态仍由主线程处理。

主线程按用户要求先复现再判断：现有Permission测试增加撤销未决子请求后ready仍成功的检查；现有Session race测试用实际Permission.list等待read审批出现，随后释放Question、由JS的Promise.race撤销read，并执行后续glob。生产取消代码原样，两个场景均通过，因此保持取消实现，提交实际证据复议B-01。

debug Agent在真实CLI handler入口经原registry取execute，复现 `execute requires the current Session tool host.`。这是本任务新增必需Host造成的现有消费者回归；R13只在原debug执行分支复用SessionTools.resolve，使用已创建的Session和助手身份，以及原SessionProcessor、SessionGoal和SessionPrompt服务。其他debug工具继续原直接执行；不增加第二个execute实现。测试沿已有Session集成seam调用公开debugAgent并检查真实读取结果。

R13还将现有并发审批场景区分可预跑表达式与真实read结果依赖，记录各自审批时机；生产预检、输出、schema、取消与工具执行路径保持R12实现。CLI类型检查指出AppRuntime尚未直接导出Goal服务，因此在原group中增加既有SessionGoal.node，复用同一依赖实例。合并审计按原始完整范围复核当前全部hunks。

R13最终验证：`bun test --timeout 30000 --only-failures test/session/execute.test.ts test/permission/execute.test.ts test/session/tools.test.ts`为40 pass/171 assertions；现有CLI `effect-cmd-instance-als.test.ts`与`debug-config.test.ts`为4 pass/7 assertions；opencode包typecheck通过。新接线初次类型检查发现PromptInput错误通道及ModelNotFoundError需沿原Task/CLI错误合同传递，随后又确认AppRuntime的Goal导出要求，均在原边界修正，最终检查通过。

当前43个源码/测试路径，加本计划44个路径。完整diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b15862a80018prjhcU5tbjCKG`。提交方计数E=1687、C=255、要求254。R12窄lint为33 warnings/0 errors，包含原文件既有告警及V1原签名适配断言。完整原始需求、全部实际hunks与直接消费者继续送同一审计上下文完整复核，并携带用户明确的本地验证授权。

### 29.5 R13独立完整审计放行

同一任务 `ses_e4eca6fa6ffehnUC8Mua4v3SeA` 完成原始完整范围的静态及执行审计。最终verdict原文：

> No blocking findings.
>
> **APPROVE — R13 合并方案与实现审计通过。**
>
> 批准仅适用于本次核对的 **R13、43 个源码／测试路径的精确任务 diff，以及已检查的当前共享消费者**。原 B-01 撤回，原 B-02 关闭，独立执行验证与实际 E/C 门禁均已完成。

独立核实B-01撤回依据：Effect外部中断跳过可中断状态下的普通失败恢复continuation（`node_modules/effect/src/internal/core.ts:538–540`），原推导没有成立；实际read审批撤销后父脚本继续、glob完成、权限队列清空。生产取消路径保持原样。B-02经debug真实读取及原AppRuntime接线关闭。

独立执行结果（各包本地运行，测试每例时限30000毫秒）：

| cwd与范围 | 结果 |
| --- | --- |
| opencode：Execute/SessionTools/Permission execute、现有CLI两个文件 | 44 pass / 178 assertions |
| opencode：原AUTO/precheck/next/reviewer prompt、CodeMode两个文件及registry | 358 pass / 1280 assertions |
| opencode：read/glob/grep/edit/write/apply_patch/skill/task/goal | 355 pass / 5104 assertions |
| opencode：instruction/compaction | 87 pass / 1既有skip / 361 assertions |
| codemode：整包 | 264 pass / 787 assertions |
| tui：session-message-render | 36 pass / 743 assertions |
| opencode：Shell四个互斥分组（第23节命令） | 120/30/91/20 pass，共939 assertions |

合计1405 pass、1个既有skip、9392 assertions、0 fail；复议窄测试3 pass/10 assertions不重复计入。首次扩大命令遇到终端总时限，审计员保留每例时限并完整重跑相同范围，最终通过。opencode/core/codemode/tui四包typecheck全部通过；全部42个本任务TS/TSX路径lint为268 warnings/0 errors；git diff --check通过。本机验证平台为Windows。

独立注释核算：E=1687，候选C=255，合格C=254，C/E=15.06%，要求254。排除Session execute测试第290行与前一行重复的“双观察面”说明，其他排除项含空行、import-only、纯移动、原文TXT及非任务hunks。纠正提交方C记录为254，此为非blocking记录修正，保持批准。独立清单：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b15f20e8001b6WngE2vRJwoCF`。

审计确认共享目录、单一真实执行链、原schema/权限/结果归属的主路径通过；原输入语义和上下文交付保持，额外parser/schema/preview扩展退出。按§1授权隔离本任务hunks提交，其他工作区和暂存内容保持原样。

## 30. R14：官方v2.2.5合同迁移至V1

唯一Upstream为 `anomalyco/opencode@v2.2.5`，所有本轮对照源码均经GitHub API显式指定该ref。当前用户原文：

> 换言之，确实要以 V1 为执行器，提示词需要使用 V2 的，相关接线需要使用上游的逻辑，也就是上游的接线思想是怎么接的，你本地就去怎么接。上游是的执行时的消息传递啊，消息的这个，这个类型的构建啊，比如说它每一个工具去返回了什么东西啊，你都需要最好去做对齐。就比如说上游的 read 去返回了多少东西，grep 返回了多少东西，你本地去做对齐。你不要去额外地去自己造轮子，造一套无意义的语义，能抄的东西就抄。即使它是 V2，V2 的东西可以迁移到 V1 里面，注意这点，保持最小修改。

R13的提示词校验基准为1.19.5，当前改为指定的2.2.5；原批准只属于历史修订。R13提交尝试被权限预检拦截，尚未创建commit，当前已暂存版本保留。

源文件为 `packages/core/src/codemode/{tool,instructions,catalog,fetch}.ts` 与 `packages/core/src/tool/plugin/`。本轮按既有Session execute seam验证原文、输入与输出声明、实际返回值、权限和结算，保持V1 Agent Loop及解释器。

已确认：glob返回Entry[]，grep返回Match[]，read返回file/text-page/list-page，question返回{answers}，todowrite返回{todos}，subagent返回{sessionID,status,output}；shell返回output/truncated及可选exit/signal/shellID/timeout/status。Entry、Match及其Submatch在本仓库schema/filesystem中与官方v2.2.5一致，直接复用。输入schema及V1原工具执行路径保持，宿主metadata与模型文本继续原通道。

首个切片修改原Session组合测试，glob/grep的上游数组合同使旧实现报 `Cannot access a property on a non-object value`；随后仅修改原结果投影并复用Entry/Match，原搜索事实、偏移和子匹配保留。先前测试曾被外部恢复导致旧断言通过；已核实本次red实际运行的是新增合同。其余返回合同及提示词/宿主接口在同一修订内继续完成后合并审计。

## 31. R15：用户指定的固定JS返回合同

### 31.1 权威约束

用户原文：

> 请注意，目前我们准备使用如上的这套 schema，那因此你需要先将 schema 写到我们的 plan 里面，然后去按照 plan 串严格去执行。你不应该去做过多的一些什么，就返回值啊等等一些 schema 的逻辑你应该按照这套逻辑去执行。不进行自己的一些调整或者说修改，巴拉巴拉的，就按照这套逻辑去执行。如果真的有问题你再去 question 用户，就是 grill with docs，就是 grill 我。

下列内容逐项记录用户表格第三列，作为当前最终目标，替代前面修订中不同的返回约定。`?`表示可选；定位统一为`path`，正文统一为`content`；不同对象分支保留`type`或既有`operation`判别字段；ID后缀统一为`ID`。外部插件、外部MCP工具排除，保留仓库内置资源入口。输入schema保持原合同，所有值来自原执行器或桥接真实结果。出现真实数据缺口、冲突或必须改变合同的情况，先通过question/grill-with-docs向用户确认，再实施对应变更。

### 31.2 文件与搜索

**read**
```ts
{type:"file",path:string,content:string,mime:string,encoding:"utf8"|"base64"}
| {type:"text-page",path:string,content:string,mime:string,offset:number,totalLines:number,totalLinesExact:boolean,truncated:boolean,next?:number}
| {type:"list-page",path:string,entries:{path:string,type:"file"|"directory"|"symlink"|"other"}[],offset:number,totalEntries:number,truncated:boolean,next?:number}
| {type:"omitted",path:string,content:string}
```
每个分支都有稳定的type/path；同一文件只保留一个定位字段。

**glob**
```ts
{files:{path:string,type:"file"|"directory"}[],truncated:boolean,partial:boolean}
```
与read目录条目统一，保留完整性标志。

**grep**
```ts
{matches:{path:string,line:number,offset:number,content:string,submatches:{content:string,start:number,end:number}[]}[],totalMatches:number,truncated:boolean,partial:boolean,timedOut:boolean}
```
去掉额外entry层；保留匹配位置和完整性信息。totalMatches为已观察数量，结果不完整时为下界。

### 31.3 Shell与写入

**bash / ShellTool**
```ts
{content:string,exit:number|null,truncated:boolean,timedOut:boolean,path?:string}
```
path为完整输出文件；字段只反映V1实际具备的执行结果。

**write**
```ts
{files:{path:string,operation:"add"|"update",patch?:string,additions?:number,deletions?:number}[],diagnostics:null|{existingCount:number,newErrors:{path:string,line:number,column:number,message:string,code?:string|number}[]}}
```
操作类型已表达是否新建，删除重复的定位和existed。

**edit**
```ts
{files:{path:string,operation:"update",patch:string,additions:number,deletions:number}[],diagnostics:null|{existingCount:number,newErrors:{path:string,line:number,column:number,message:string,code?:string|number}[]}}
```
统一使用一份实际差分；newErrors.length提供新增错误数。

**apply_patch**
```ts
{files:{path:string,operation:"add"|"update"|"delete"|"move",fromPath?:string,patch:string,additions:number,deletions:number}[],diagnostics:null|{existingCount:number,newErrors:{path:string,line:number,column:number,message:string,code?:string|number}[]}}
```
合并applied/files；移动时path是目标，fromPath是原位置。

### 31.4 任务与交互

**task**
```ts
{sessionID:string,status:"running"|"completed",content:string}
```
保留恢复身份，正文取子任务实际回复。

**todowrite**
```ts
{todos:{content:string,status:string,priority:string}[]}
```
保留本地优先级和现有合法状态范围。

**question**
```ts
{answers:string[][]}
```
每个内层数组对应一道问题的选择结果。

### 31.5 网络、技能与目标

**webfetch**
```ts
{path:string,content:string,mime:string,encoding:"utf8"|"base64"}
```
与read的内容表示一致；保留附件交付，省去重复回显的格式参数。

**websearch**
```ts
{content:string}
```
保留现有后端实际提供的正文；提供方名称留在宿主元数据。

**skill**
```ts
{path:string,content:string}
```
path为技能资源目录，content为技能正文；技能名由调用参数提供，加载去重由宿主处理。

**goal**
```ts
null | {objective:string,status:"active"|"paused"|"complete"|"blocked",generation:number,reason:string|null,tokensUsed:number,tokenBudget:number|null,timeUsedSeconds:number,blockedAttempt?:{attempt:number,required:number}}
```
统一返回目标快照；null表示无目标，预算null表示无限额；删除可计算的remainingTokens。

**plan_exit**
```ts
{approved:true,agent:"build",path:string}
```
path为被批准的计划文件。

### 31.6 VS Code Notebook

**vscode_notebook_summary**
```ts
{path:string,dirty:boolean,cells:{cellID:string,type:"code"|"markdown",language:string,range:{start:number,end:number},execution:{status:"succeeded"|"failed"|"unknown",provenance:"saved"|"unknown"},outputMimes:string[]}[]}
```
数组位置表示cell顺序；cellID是稳定身份，源码范围使用一基行号。

**vscode_notebook_source**
```ts
{path:string,cells:{cellID:string,offset:number,content:string}[],totalLines:number,truncated:boolean,next?:number,sourcePath?:string}
```
保留原始代码与cell边界；sourcePath是超长源码导出文件，和notebook本身是不同资源。

**vscode_notebook_edit**
```ts
{path:string,operation:"add"|"update"|"delete",applied:boolean,cellID:string|null,dirty:boolean,content?:string}
```
返回受影响的稳定ID；content是修改后实际源码，删除操作省略。

**vscode_notebook_run**
```ts
{path:string,completed:boolean,cells:{cellID:string,skipped:boolean,timedOut:boolean,execution:{status:"succeeded"|"failed"|"unknown",provenance:"saved"|"unknown"},outputs:{path:string,mime:string,bytes:number,content?:string}[][]}[]}
```
保留本次等待结果与原生执行状态的区别；输出按“output → MIME item”分层，数组位置代替重复索引字段。

**vscode_notebook_output**
```ts
{path:string,cellID:string,execution:{status:"succeeded"|"failed"|"unknown",provenance:"saved"|"unknown"},outputs:{path:string,mime:string,bytes:number,content?:string}[][]}
```
与run共用输出结构，每个artifact保留一个可访问地址。

**vscode_notebook_env**
```ts
{operation:"info",path:string,runtime:{language:string,kernelStatus:string}|null,savedMetadata:{kernelDisplayName:string|null,kernelName:string|null,language:string|null,languageVersion:string|null}|null}
| {operation:"configure",path:string,status:"configured"|"selected"|"needs-selection"|"selection-requested"|"failed",error?:string}
| {operation:"restart"|"stop",path:string,requested:boolean,verified:false,error?:string}
| {operation:"save",path:string,saved:boolean,dirty:boolean,error?:string}
| {operation:"create",path:string,created:boolean,alreadyExists:boolean,error?:string}
```
每个分支都有稳定的operation/path；活动内核与保存元数据分别保留。

### 31.7 仓库GitHub工具

**github-pr-search**
```ts
{totalCount:number,items:{title:string,path:string}[],partial:boolean}
```
直接复用原响应，PR地址统一使用path。

**github-triage**
```ts
{issueNumber:number,assignee:string}
```
保留操作结果，省去重复回显的team参数。

### 31.8 内置MCP资源入口

**list_mcp_resources**
```ts
{resources:{server:string,name:string,path:string,description?:string,mime?:string}[],templates:{server:string,name:string,pathTemplate:string,description?:string,mime?:string}[]}
```
统一定位和MIME字段；server保留所属连接身份。

**list_mcp_resource_templates**
```ts
{templates:{server:string,name:string,pathTemplate:string,description?:string,mime?:string}[]}
```
与上一行使用相同条目结构。

**read_mcp_resource**
```ts
{server:string,contents:{path:string,content:string,mime?:string,encoding:"utf8"|"base64"}[]}
```
统一内容表示；encoding明确区分正文和base64，省去顶层重复定位。

### 31.9 Execute与内部控制边界

**execute**：脚本可返回null、boolean、number、string、数组或普通对象。保留上述JSON值及递归数组/对象返回能力；自身继续排除在JS子工具目录外。

**invalid**：内部错误回执保持string，继续排除JS子工具目录。

**permission_review_decision**：保持审核器内部协议string，JSON正文为：
```ts
{outcome:"allow"|"deny",risk_level:"low"|"medium"|"high"|"critical",user_authorization:"unknown"|"low"|"medium"|"high",rationale:string}
```
继续排除普通JS目录。

**StructuredOutput**：保持宿主回执：
```ts
{output:"Structured output captured successfully.",title:"Structured Output",metadata:{valid:true}}
```
继续排除JS子工具目录。

**_noop**：保持宿主回执：
```ts
{output:"",title:"",metadata:{}}
```
继续留在Provider内部。

### 31.10 实施与验收约束

逐项从真实producer投影以上合同，复用既有业务字段、schema及执行通道；Model目录声明与JS收到的数据保持一致。原模型文本、宿主metadata、附件、权限、取消、归因及工具开关继续由既有owner负责。用户表格明确排除的外部插件和外部MCP结果保持原协议。

沿既有公开seam分组验证文件/搜索、写入/诊断、交互/任务、网络/目标、Notebook、仓库GitHub工具及内置资源入口；对每项固定字段、判别分支、可选值与真实结果来源作行为验收。输入schema保持原样。现有producer若不足以形成某个必需值，记录具体缺口并提问，不代填、不自改合同。提示词及宿主接线继续以官方v2.2.5为准，V1解释器及Agent Loop保留。

### 31.11 已确认的类型补充

FSUtil.DirEntry真实包含other类型。用户经question确认原文：“只增加other，不要扩张既有逻辑语义，且不得进行过滤使得结果不全”。因此仅在read目录条目的type枚举中增加other；保留全部原条目、原排序、分页和计数，既有展示与读取语义保持。

Notebook插入继续await既有applyNotebookEditAndWait。用户确认未应用且未产生单元格时cellID可为空；只在该失败回执返回null，不增加等待器、重试或其他状态。成功操作继续返回真实稳定ID。为固定合同提供range、分页cells和run等待事实时，只在既有桥接捕获点带出已有数据，不解析展示文本或另建执行路径。

用户要求剩余实现集中一次完成，再统一测试和全范围合并审计；因此后续不再按逐小切片重复测试。仍须保留实际失败证据、修复确认的问题并通过最终验收，实施由主线程完成。

## 32. 集中实施与验收记录

- 输出合同由各原producer形成program.value，原input、展示output、metadata和真实执行过程继续保留。三个写工具共用原Diagnostic模块的结构化投影，未新增诊断算法。
- 内置Notebook和仓库GitHub工具通过现有plugin registry接入可选output/program；已有外部插件不提供这些字段时行为不变。Notebook复用原分页、applyNotebookEditAndWait、执行状态和artifact writer，只带出固定合同必需的数据。
- 固定execute说明与空/完整/部分目录文案取自官方anomalyco/opencode@v2.2.5。固定说明独立SHA-256为4e1d4d35251719086df5e5c85baf32dd27364519b2c1556912dc806e2c74eea8，由官方源码AST中的description常量计算；本地测试不从实现生成预期值。
- SessionTools同时返回工具和当轮instructions；execute开启时目录工具只从execute调用，关闭时沿原直接工具入口。SessionPrompt使用原system交付位置承载目录，不增加第二消息循环或目录状态机。
- V1解释器继续处理程序；全局search复用原搜索入口，fetch由宿主显式提供并复用原权限上下文。HTTP方法/URL先进入整段预检，预跑不发送网络请求；真实请求保留webfetch权限、30秒预算、已有5MiB响应上限及取消信号。响应方法使用沙箱内闭包，bytes沿V1普通数值数组边界，不引入宿主对象或typed-array运行时。
- 未等待调用沿v2.2.5固定说明在执行结束时取消；原Promise、并发限制和子调用清理继续复用，不重放已完成动作。
- 验收覆盖固定合同、原权限/取消/归属路径及官方prompt。以下为本修订执行证据，独立全范围合并审计尚待完成，历史R13批准不用于放行R16。

### 32.1 本轮验证

| 工作目录 | 命令 | 结果 |
| --- | --- | --- |
| packages/codemode | `bun test --timeout 30000 --only-failures` | 261 pass，0 fail |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/permission/execute.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts test/plugin/vscode-bridge.test.ts test/plugin/vscode-notebook-tool-summary.test.ts test/session/tools.test.ts` | 158 pass，0 fail |
| packages/opencode | `bun test --timeout 30000 --only-failures test/tool/read.test.ts test/tool/glob.test.ts test/tool/grep.test.ts test/tool/edit.test.ts test/tool/write.test.ts test/tool/apply_patch.test.ts test/tool/task.test.ts test/tool/skill.test.ts test/tool/goal.test.ts test/tool/webfetch.test.ts test/tool/websearch.test.ts test/session/instruction.test.ts test/session/compaction.test.ts test/permission/auto.test.ts test/permission/precheck.test.ts test/permission/next.test.ts test/permission/reviewer-prompt.test.ts` | 750 pass，1既有skip，0 fail |
| packages/opencode | `bun test --timeout 30000 --only-failures test/tool/shell.test.ts` | 261 pass，0 fail |
| packages/tui | `bun test --timeout 30000 --only-failures test/cli/cmd/tui/session-message-render.test.tsx` | 36 pass，0 fail |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/tool/goal.test.ts test/plugin/vscode-bridge.test.ts` | 补充断言复验57 pass，0 fail；与上表重叠不重复计数 |
| packages/opencode、core、codemode、plugin、tui | 各包目录 `bun typecheck` | 全部通过 |
| sdks/vscode | `bun run check-types` | 通过；该包使用既有check-types脚本 |
| sdks/vscode | `bun run test --run out/test/notebook-source.test.js out/test/notebook-run.test.js --timeout 30000` | VS Code 1.145.2真实宿主2 pass，0 fail；pretest的编译、类型检查及eslint通过 |
| repository root | `bun run lint <任务归属的71个TS/TSX/MJS路径>` | 456 warnings，0 errors；未扩大清理原文件既有告警 |
| repository root | `git diff --check` | 通过，仅Git换行提示 |

独立测试集合合计1468 pass、1既有skip。首次集中检查遇到4处旧字段/旧文案断言，已按固定合同修正并复验。SDK最初失败于旧夹具注册了serializer但没有对应editor type；改用VS Code内置jupyter-notebook。随后原version断言揭示内置serializer自动补齐cell metadata，捕获前后快照确认新增execution_count/metadata；夹具预置原生默认值，保留版本不变断言。产品读取、等待、执行和保存逻辑均未因夹具失败改变。

### 32.2 差异和审计材料

- 基线：HEAD `219f2a416dba00f970b3a73a4f638271d033c136`。本任务72个代码/测试/配置路径，另有本plan；不包含并行processor-effect测试、其他plan或测试缓存。
- 统计脚本：`D:/Temp/opencode/execute-diff-accounting.ts`。对processor/message-v2/TUI session三个共享文件使用R7精确任务hunk，其余使用当前HEAD-to-worktree差异；实际工作区仍保留并行改动。
- 当前测量E=2144、候选C=330、要求322；C是否合格交由独立审计逐项确认。import-only、纯搬移、空行、TXT和匹配的格式变化排除。
- 全量任务diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b2fb510b001lTL6wzUpgvcpaQ`。Native SDK成功记录：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b2f9973b001XdtnQXhCobZt6R`。Lint记录：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b2f4cc58001daCC6DWKGvFqWR`。
- 最终提交仍需新的明确授权；先前R13提交被权限预检拒绝，未重试、未绕过、未push。R16尚未获独立APPROVE。

## 33. R16 独立审计与 R17 修正

审计任务：`ses_e4d01b941ffegox6rvLwZChbcT`。原样verdict：**BLOCK — R16 合并方案与实现暂不放行。**

独立审计覆盖72个任务路径、256个hunk，并复验1468 pass、1 skip、0 fail及各包类型检查。审计核定E=2122（额外排除22行纯移动）、合格C=324（330候选排除6条），15.27%，注释门禁通过。

| Finding | 独立证据与需求核对 | R17 owner及最小修正 |
| --- | --- | --- |
| B-01 | 已成功POST后脚本失败，恢复正文只有Partial execution空数组；违反已完成事实交付要求 | SessionTools父失败回执并入同一次runtime进度中的fetch事实；复用原列表，不重发、不增加执行路径。真实Session回放验证 |
| B-02 | 合法重复头数组被Object.fromEntries折叠；本地服务实收second而原生fetch为first, second | fetchHTTP用原生Headers保留序列语义；既有loopback用例检查实际收到的头 |
| B-03 | Notebook existing_outs是shortMime展示值，程序误收到png/x-png/text | 在原existingOuts helper允许保留原MIME，summary捕获raw字段供程序；展示继续旧缩写。真实VSCode producer及插件一起验收 |
| B-04 | read非文本分支、other、非空LSP诊断及仓库GitHub程序回执缺少行为敏感断言 | 在既有测试文件复用真实producer和外部边界夹具补齐，不建立新适配框架 |

三处生产问题均对应用户要求的已完成事实、上游请求语义或固定MIME合同；因此采纳。未采纳额外HTTP方法风险分类、事务重放或历史race毒化推断。顺带同步两处已经不准确的说明。R17保留全部原范围，修正后需要全范围独立复核。

### 33.1 R17 验证记录

- `packages/opencode`：`bun test --timeout 30000 --only-failures test/session/execute.test.ts test/tool/read.test.ts test/tool/write.test.ts test/tool/registry.test.ts test/plugin/vscode-bridge.test.ts`：178 pass、0 fail。增加other目录分页、非空诊断和GitHub工具三个案例；并在已有真实HTTP与读取媒体案例补充断言。
- `packages/opencode`：`bun typecheck`通过。GitHub测试改用真实registry动态加载原模块，避开项目局部旧插件声明与应用类型上下文的冲突，未修改模块解析策略或生产依赖；LSP夹具使用实际severity字面量，Session身份使用原create工厂。
- `sdks/vscode`：原真实宿主命令2 pass，包含标准MIME、缩写别名MIME和文本MIME的producer断言；原展示缩写另行保留验证。测试编译、类型检查和eslint通过。
- R17改动范围11个TS路径lint：63 warnings、0 errors，记录`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b32e43ef0019JLC06ghNDCmTn`。
- 当前全量任务diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b331c69f001Cmn1eFPKcpeiaO`；新增`sdks/vscode/src/notebook/format.ts`归属。原R16全部需求及所有未变hunk继续在复核范围内。
- HTTP错误结果正文的最终敏感性检查：`bun test --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'execute fetch uses'`，1 pass、6 assertions；只检查tool-result的error-text，不以调用参数中的URL充当恢复证据。最终包类型检查和`git diff --check`通过。

## 34. R17 复核与 R18 类型修正

同一独立审计任务原样verdict：**BLOCK — R17 合并方案与实现暂不放行。** 原样处置：**B-01～B-04 已关闭；新增 B-05 保持阻塞。**

R17复核覆盖73路径、266个hunk；本轮1210 pass、1 skip、0 fail，未变Shell保留前轮独立261 pass证据。独立核定E=2224、C=339、15.24%，注释门禁通过。

B-05由两份GitHub模块实际解析到.opencode安装的1.14.20插件声明造成：旧tool工厂入参没有output，源码新增该字段产生两处TS2353。HEAD原源码在同依赖同选项下没有诊断。动态加载行为验收不能替代原模块类型检查，因此采纳此问题。

R18仅在两份导出定义外层组合output声明，原tool工厂只接收原API字段；program返回与当前registry消费保持原样。没有依赖升级、安装策略改造或新执行逻辑。新增原模块自身的验证命令：在packages/opencode执行`bun typecheck --ignoreConfig --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target esnext --types bun ../../.opencode/tool/github-pr-search.ts ../../.opencode/tool/github-triage.ts`。全部原需求仍须完整复核。

R18上述两份源码的独立类型检查通过，应用包`bun typecheck`通过，`bun test --timeout 30000 --only-failures test/tool/registry.test.ts`为18 pass、0 fail，`git diff --check`通过。全量冻结diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b34205ff001LB97HGEADDagsb`。其余R17任务hunk和已运行的验收集合保持不变，第三轮仍按完整需求复核。

### 34.1 最终独立批准

审计任务：`ses_e4d01b941ffegox6rvLwZChbcT`。第三轮原样verdict：

> No blocking findings.
>
> APPROVE — R18 合并方案与实现的完整范围审计通过。
>
> B-01～B-05 全部关闭，无剩余阻塞。

批准范围为R18、HEAD `219f2a416dba00f970b3a73a4f638271d033c136`、冻结artifact `tool_1b34205ff001LB97HGEADDagsb`的73路径任务diff及当前消费者，三个共享文件保留既定精确hunk归属。完整审计共267个hunk，未缩减为已列问题复查。

适用于当前实现的去重独立验收集合为1471 pass、1既有skip、0 fail；本轮59项/215断言属于重跑不重复计数。五个工作区包类型检查、VSCode编译/类型检查/eslint和两份GitHub原模块独立类型检查均通过；任务路径lint为459 warnings、0 errors，diff检查通过。

独立核定实际E=2228、合格C=341、C/E=15.31%，15%所需335；排除了22行MCP纯移动及5条重复说明。主路径、fallback和代码质量门禁通过，没有剩余阻塞。

验收平台为Windows。GitHub变更请求只到测试网络边界，不触碰真实远端；VSCode实测覆盖源码/MIME生产者和执行范围边界，不声称运行了用户真实内核任务。提交和推送继续分别受用户授权约束，尚未创建本轮提交。

## 35. R19 官方发现接口与最终提示词补齐

用户反馈原文：“你仍然未对齐2.2.5的部分内容，包括相关prompt等等”，随后要求“继续”。R18批准和验收保留为历史证据，不放行本修订。继续沿§27.4、§31.11授权集中实施后合并完整方案/实现审计；不另建计划，不改第31节字段合同。

用户随后要求暂停实施、完整解释差异与取舍；当时仅修改本计划，生产/测试未动。解释后用户明确授权：“OK，这个地方就按上游来改。”并要求核对prompt如何指导工具调用、获取schema与await/Promise。按该确认实施上述差异；验收同时覆盖官方调用示例、同步search签名、工具Promise返回签名和分页发现。固定官方文案保持原文，不另写教程。V1每轮当前目录的接线适配和第31节合同继续保留。

用户进一步限定原文：“如果你只是改了这么一点点，那没有问题。不要再试图对通用提示词进行修改。我说的东西都是在Execute的提示词内容里面的。”GPT/Astra各仅已改同一条并行规则，增加For direct tool calls范围限定，用户接受保留。此后通用提示词锁定；剩余实施限execute相关内容，不能以对齐为由继续调整provider通用文本。

### 35.1 证据、首个分歧与责任

官方来源均为anomalyco/opencode@v2.2.5：packages/codemode/src/tool-runtime.ts、packages/core/src/codemode/catalog.ts、instructions.ts、tool.ts。固定description已经对齐，但完整的模型可见接口还包含目录签名、search实际语义、恢复提示与组合后的system文本。

| ID | 已证实差异 / 路径 | 原owner最小修正 / 验收 |
| --- | --- | --- |
| ALIGN-01 | 本地`search({}).items[0].path`实际失败为un-awaited Promise；官方searchSignature为同步返回 | 原解释器ToolReference调用分支直接完成已有search调用；复用原校验、预算、hooks，不创建第二搜索器。公开CodeMode.execute直接读取items |
| ALIGN-02 | 本地`await tools.host.ping()`实际失败expects exactly one input object；官方零参规范化为{} | 原ToolRuntime.invoke在描述工具边界规范化零参，其余仍原schema校验；签名去人工input标签，空输入显示()。公开调用及必需参数拒绝 |
| ALIGN-03 | 本地搜索仅顶层namespace、缺少路径词权重；目录未计namespace预算且长描述截断长度不同 | 原rank/prepare复用官方namespace前缀、pathWords权重12、确定性路径顺序、namespace基础预算、120字符截断；参数/返回schema不变 |
| ALIGN-04 | UnknownTool建议仍指向旧内部search；partial目录仍显示Promise签名 | 原错误建议改官方全局search用法，复用同一rank提供最近工具；partial目录直接生成官方同步签名。测试错误恢复和完整目录字节 |
| ALIGN-05 | GPT/Astra静态文本的exclusive parallel规则与execute内Promise.allSettled指导范围混淆 | 只限定现有wrapper规则适用于direct tool calls；其余本地provider定制、agent/user/project提示原样保留。真实SessionTools结果进入LLMRequestPrep，分别检查普通system和OAuth instructions |

预修改隔离实验：packages/codemode内`bun --eval`调用真实CodeMode.make/execute；search直接取items返回InvalidDataValue，零参ping返回InvalidToolInput，目录为`tools.host.ping(input: {}): Promise<string>`。这两项是行为失败，不是仅源码推断。

### 35.2 接线范围与复用边界

V1现有路径为SessionTools.resolve -> SessionPrompt每轮system -> LLMRequestPrep.prepare -> SDK/native或OAuth instructions。已追踪实际调用，目录没有丢失。官方V2的Instructions持久化初始baseline及changed/removed增量，本地V1每轮从真实可用工具重建当前目录，因此不同时保留旧baseline，不需要新增目录状态机、持久化表或搬迁V2 runner。验收检查关闭execute后当前请求没有旧目录，用户自定义提示保持原样。

现有V1的`tools.$codemode.search`可继续指向同一搜索器，模型只获知官方global search；旧入口不是新增兼容路径。未声明output的外部工具继续既有unknown/pass-through，用户明确排除其结果协议，不能照抄官方void丢失实际返回值。未提供namespace描述/pinned元数据的V1目录继续原inventory，不编造新的原生工具标记。工具输入schema和Boolean/tuple支持不改。

### 35.3 文件、测试和门禁

生产增量：codemode/src/tool-runtime.ts、interpreter/runtime.ts；core/src/system-context/prompt/{gpt,gpt-astra}.txt各一处范围限定。测试增量集中原codemode.test.ts/signature.test.ts和opencode/test/session/execute.test.ts/system.test.ts；不新建生产模块、依赖或配置，不修改工具返回producer。

沿既有公开CodeMode与SessionTools/LLMRequestPrep seam验证：同步search及await兼容、空参和原输入拒绝、深层namespace/路径词排序、精确目录/预算、未知工具恢复、普通与OAuth最终提示、execute关闭与自定义提示。原测试中旧签名预期一次同步，原行为断言不删除。目录/搜索变更后运行codemode整包、opencode execute/权限/registry/LLM/system相关组及包类型检查；未变31项producer及真实VSCode证据保留，不重复重跑无关宿主场景。

预计新增有效代码约80～140行，主要是行为验收；邻近中文说明解释同步发现与异步副作用边界、零参规范化、预算/排序来源、系统与OAuth互斥及用户文本隔离。最终E/C按完整任务diff重算，仍须15%合格说明门禁；不为比例新增重复说明。新增备用成功路径0。最后完整独立合并审计覆盖§1、§31及所有任务diff，提交继续等待明确授权。

### 35.4 R19 实施证据

真实调用仍由原ToolRuntime.invoke完成；同步search只免去解释器为目录查询生成Promise，不复制权限、目录或hooks。已收敛到原rank/prepare/resolve调用点，零参进入原decoder。补齐原enumeration与MCP目录测试的旧签名/恢复提示预期，未删除原行为断言。未修改任何工具输入/输出schema。

| 工作目录 | 验证 | 结果 |
| --- | --- | --- |
| packages/codemode | `bun test --timeout 30000 --only-failures` | 264 pass，0 fail，752 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/execute.test.ts test/session/system.test.ts test/permission/execute.test.ts test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts test/session/tools.test.ts` | 141 pass，0 fail，507 assertions |
| packages/opencode | `bun test --timeout 30000 --only-failures test/session/llm.test.ts` | 42 pass，0 fail，158 assertions |
| packages/codemode、packages/opencode | 各包`bun typecheck` | 通过；opencode在最后测试修正后复验通过 |
| repository root | 本修订9个TS路径`bun run lint` | 162 warnings，0 errors；未扩大清理原文件告警 |
| repository root | `git diff --check` | 通过，仅换行提示 |

首次集中检查保留失败记录：codemode为262 pass/2旧错误提示预期失败；opencode四文件为110 pass/6 fail，其中5项旧签名预期、1项标题计数误把二级标题作为一级标题。仅同步预期并将一级标题断言改为锚定整行；上表完整复验通过。中途含LLM的合并批次被用户消息中断，不记作通过；随后两个完整批次分别运行完毕。

当前完整任务归属77路径（另本plan），冻结diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b435c7cd0010rms0sjPE7txXL`。归属仍使用§32.2三个共享文件精确hunk，其余HEAD-to-worktree；并行processor-effect测试和其他plan不纳入。脚本初算E=2406、候选C=364、要求361，纯移动/说明合格性须独立核定。未变R18原生producer、VSCode和其他包证据保留；本轮447项为当前重跑集合，不与历史重复累加。

## 36. R19 审计与 R20 有证据收尾

独立审计任务`ses_e4bc8ca9fffeI5GOoS97XWZ94v`覆盖77路径/297 hunk。原样verdict：**BLOCK — R19 合并方案与实现暂不放行。** 核定E=2384、C=359、15.06%，要求358，中文说明门禁通过。审计本轮没有执行非Git检查，不把历史汇总当作其独立运行。

| Finding | 需求核对与复现 | 最小处置 |
| --- | --- | --- |
| B-01 父进度终态未更新 | 既有SessionTools集成分别执行race取消和return退出取消；父已返回done、question的toolCalls仍为running。`bun test --timeout 30000 --only-failures test/session/execute.test.ts --test-name-pattern 'settles parent progress'`实际0 pass/2 fail，明确复现 | ToolRuntime原observeEnd增加interruption终态通知，复用failure/error，不修改取消决策、审批、脚本返回或schema；原child结算继续原owner |
| B-02 websearch/plan_exit未验固定返回 | 当前测试只检查websearch解析器，未执行这两个真实producer的program结果；对应§31.5已确认合同 | 在原SessionTools公开seam补组合验收，HTTP只替换外部客户端，Question使用真实队列/答案；观察JS返回和实际build消息，不改生产工具 |

两项均核对原合同后采纳。生产增量仅原observeEnd一个hunk；测试复用原execute.test.ts，取消用例同时保留原child清理和后续工具断言。通用提示词继续锁定。原R19全范围及历史证据保留，修改后独立完整复审；审计可运行本地测试/typecheck/lint，禁止Git写操作与真实远端副作用。

### 36.1 验证与冻结

上述两种取消和组合输出验收3 pass/13 assertions；完整execute七文件143 pass/516 assertions，0 fail。codemode整包264 pass/752 assertions，0 fail。两个包typecheck通过。新增HTTP夹具曾遇到LayerNode可变tuple推导错误，改为固定replacement项（未替换时保留原httpClient node），没有类型强转或依赖改变；最后execute.test.ts整文件37 pass/194 assertions、应用typecheck再次通过。R19 LLM 42 pass证据继续适用。

R20两文件lint为10 warnings/0 errors；git diff --check通过。全任务计数候选E=2434、C=368，待审计扣除纯移动/重复说明。冻结全量diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b4470320001Ub8FUa5n2P7zD0`。77任务路径、原共享hunk归属和HEAD均保持。

### 36.2 独立完整批准

同一审计任务`ses_e4bc8ca9fffeI5GOoS97XWZ94v`第二轮原样verdict：

> No blocking findings.
>
> APPROVE — R20 合并方案与实现的完整范围审计通过。
>
> B-01、B-02 均已关闭，无剩余阻塞。

批准对应R20、HEAD `219f2a416dba00f970b3a73a4f638271d033c136`、冻结artifact `tool_1b4470320001Ub8FUa5n2P7zD0`及§32.2共享文件精确归属。审计覆盖77路径、298 hunk，重新生成当前任务diff并确认与artifact完全一致；未缩减为最新两项修复。

独立运行去重集合1553 pass、1既有skip、0 fail：codemode264，execute37，目录/权限/LLM/system/registry/插件九文件201，文件六文件307，权限四文件294，任务/技能/目标/网络/指令/压缩七文件151+1skip，Shell261，TUI36，真实VSCode2。opencode/core/codemode/plugin/tui五包typecheck、两份GitHub原模块独立typecheck及VSCode前置编译/类型检查/eslint均通过。全任务lint466 warnings/0 errors，git diff --check HEAD通过。

审计首次17文件合并批次超过终端300秒时限，拆分后752 pass/1skip/0 fail；原单项30秒限制和断言不变。独立反向内存探针撤去终态修复时ended为空并断言失败，当前ended为failure且脚本仍返回done；没有修改源文件以制造验证结果。

最终核定E=2412、C=363、15.05%，所需362；排除22行跨文件纯移动及5条重复说明。主路径、fallback、完整合同和中文说明门禁通过。Windows验收范围保持；VSCode未运行用户真实内核任务。测试生成的`sdks/vscode/.opencode/cache/notebook-outputs/`保留且不属交付diff。通用提示词没有进一步修改，尚未提交或推送，Git授权仍独立等待用户明确指令。

## 37. R21 恢复直接调用与完整CI验收

最新用户原文：“executor应该设置为默认开启，而且相应的工具必须原本保留。也就是说，你需要去缩减现有的收减现有的修改范围，不得破坏 V1 的原有直接调用能力，同时保持修改 Hunk 简洁。”以及“本地还在工作暂存区里面，你不要进行 Git 的改动。”此要求替代此前隐藏直接工具入口的候选设计；不通过关闭execute或转换旧测试调用来规避失败。

用户再次确认：“需要在不修改V1基础测试的基础上，使得 execute 等等相关能力存在而且共存。也就是说，你不得去把V1的那套逻辑给移除掉。”本轮未修改CLI、prompt、snapshot、httpapi、shell isolation原测试；新execute测试中的两个互斥预期改为共存，并断言最终普通/OAuth请求同时提供read、bash与execute。

首个分歧已复现：SessionTools在eligible.execute存在时跳过所有catalog工具的provider注册，正常bash/task/goal请求因此变成invalid。三项原CLI测试未经修改直接运行全部失败，与Linux/Windows CI一致。恢复原for循环注册所有eligible工具，execute仍默认可见，两个入口共用同一invoke、权限及参数校验。仅删除该额外筛选，工具schema、预检、子调用和原执行体保持。

验证范围补齐原CLI run-process、Session prompt全组、snapshot-tool-race、HttpApi Session foreground Task、Windows shell-capture-isolation及原execute集成。旧测试保持原调用和断言；仅修正本任务新加的“直接入口不存在”断言以匹配用户合同。Linux/macOS/Windows的CI日志分别核对，不以本地一个平台通过冒称跨平台验证。

独立daemon SSE退出超时在本地原限制下4次通过，尚无失败阶段证据；DB压缩锁测试的任意.lock就绪条件和Windows既有跳过已记录，不以修改超时/跳过/断言处理。必要的其他修正须先证明根因。并行token/统计修改、其他plan和Git状态保持。

Build/Test注解来源已通过GitHub API核实：Test运行42342270890的JUnit publisher按SHA创建check，Linux26条和Windows TUI5条被关联到Build suite114722643506；Build自身10个job均成功，无调用Test工作流的依赖。此轮只解释来源，不擅自修改CI流水线。

### 37.1 当前行为验收与剩余边界

本轮原V1测试未改，逐文件对已发布3be36822bf核对无差异。Windows本地原CLI整组13 pass/47 assertions；原prompt整组126 pass/15既有skip/681 assertions；snapshot-tool-race、httpapi-session、execute、session/tools四文件66 pass/374 assertions；原Windows shell-capture-isolation 1 pass/10 assertions。全部0 fail，原超时、断言、模拟模型调用及生产默认开关保持。opencode包typecheck通过，本轮两文件lint6 warnings/0 errors，限定diff空白检查通过。

CI三平台核对：Linux和macOS均为相同26项失败，其中25项是直接工具入口被隐藏导致的CLI3/prompt20/snapshot1/HttpApi1，另1项为独立DB选主测试。Windows会话组21项对应prompt19/snapshot1/HttpApi1（原截断Shell场景在Windows跳过）；TUI组为CLI3、Shell隔离1、daemon退出超时1。恢复入口后，当前Windows可运行的这些回归均已通过；没有新的Linux/macOS运行结果，不能声称远端CI全绿。

独立残留：daemon退出原测试本地4次通过，CI失败阶段未定位；POSIX DB压缩锁测试当前Windows为原有skip，WSL没有Bun/Node，按用户效率要求不安装环境或绕去扩张。源码显示测试用任意.lock作为就绪条件，可能在目标选主锁取得前启动竞争者；这仍是待POSIX证据确认的独立问题，不归因于execute，不改V1基础测试来隐藏失败。

本次收敛的生产差异仅删除SessionTools两行；新execute验收更新两个互斥断言并加bash共存断言。完整78路径包含25测试、1计划，另52实现/配置（19工具定义与适配、7 Notebook桥接/配置、2内置GitHub、2用户已接受通用提示限定、22解释器/权限/宿主与上下文接线）。第31节固定合同及实际消费者仍要求这些职责，不能通过移除工具数据或测试来人为达到文件数。独立审计继续按完整需求检查必要性；通用提示、旧测试及并行token改动不扩张。

R21完整归属冻结diff：`C:/Users/Lenovo/.local/share/opencode/tool-output/tool_1b4a8fd23001ORSLgF6gvrPDSA`。基线219f2a416d，除本轮tools.ts/execute.test.ts取当前工作区外，未改路径取此前3be36822bf任务内容，三个历史共享文件仍按R7精确hunk；避免把并行token修改混入本任务。旧V1七个失败相关测试文件与3be36822bf逐文件比较无差异。上述Git调用均为只读检查，未更改暂存区、refs或工作树。

### 37.2 独立完整批准

审计任务`ses_e4b56620affeBkxw3guF97GH2q`原样verdict：

> No blocking findings.
>
> APPROVE — R21 合并方案与实现的完整范围审计通过。

批准限R21和冻结artifact `tool_1b4a8fd23001ORSLgF6gvrPDSA`。完整77代码/测试/配置路径及计划均按最新共存要求核查，排除并行token/统计修改；原V1七份失败相关测试逐文件确认未变。

独立去重验收1484 pass、16既有skip、0最终未解决失败；包含codemode264、execute/权限/MCP112、文件/搜索/写入/Notebook360、原V1 prompt/CLI/HttpApi/snapshot/Windows Shell隔离、普通权限和其他消费者、TUI36、真实VSCode2及本次触及的Shell21项。其余Shell240项本轮未重跑。五包typecheck、GitHub工具独立typecheck及VSCode编译/类型检查/eslint通过；全任务lint466 warnings/0 errors、diff检查通过。

独立并行验证曾遇到一次Task就绪超时及三次命令总时限耗尽，随后保留原测试/断言/单项时限分别复验通过；未把并行负载认定为唯一原因。E=2412、C=363、15.05%，要求362。新增备用成功路径0，两个入口共用SessionTools.invoke，固定schema与原执行体保留。Linux/macOS未重新运行；独立POSIX DB选主和远端daemon超时仍保留，不宣称完整CI全绿。
