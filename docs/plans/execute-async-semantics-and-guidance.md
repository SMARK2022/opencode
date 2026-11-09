# Execute 异步语义与编排提示词优化计划

> Status: draft
>
> Revision: R2
>
> Approved revision: none
>
> Audit mode: waived for this planning task by explicit user instruction
>
> Self-check: completed (plan only)
>
> Implementation allowed: no
>
> Requirement source: 本会话 2026-11-07 用户要求及后续两项纠正，原文见第 1 节
>
> Repository baseline: `70670d1b030bee4198887c633ce2607ad6360e66`
>
> Last updated: 2026-11-07

这是新任务的独立计划，不更新、替换或重新批准 `execute-v1-unified-tools-auto-review.md`。本轮只调研、复现、写文档和自检；没有实施授权，也不启动独立审计。原计划已经建立的 V1 直接调用、权限、工具返回合同继续有效。

## 1. 用户原始要求

> OK，那我就需要让我们，就是首先需要完成一个问题，就是我们的 Asynchronous 这个自定义的一些函数啊，它的这些各种异常表现，还有说一些，就是你去看一下，把这些什么各种各样的一些并发算法或者等等东西，都去给做相应的优化。然后呢，还有一个就是把我们的这个 prompt 你去看一下，对这个 prompt 按理来说应该去进行一定的调整。你可以去结合一下，比如说这种 Cloud Code，或者说等等，他们这些这个，比如说 Ultra Work，或者说 Ultra 那种模式，它本身会增加很多这种使用脚本去进行一定的这个结构化的一些调用嘛。但本身那种，它这里面就提到了很多这种各种各样的一些工程实践的一个优点，就是工程实践的一个方式。你可以去对照他们去看一看他们有什么样的优点。按照我们逻辑呢，本质上我们本地去可以有一套比较好的一个提示的一个手段，就是去告诉模型可以如果需要去进行复杂的一些分析的话，可以去使用这个 Execute 去进行。这样的话能够帮助它以更加简洁高效的形式去进行这个功能的一些使用。然后呢，与此同时，就是我觉得这个 Execute 的 prompt 可以简单地给一条示例，比如说它应该去，它的 Workflow，或者说流程是，比如说先去 search 需要用的工具，然后再去直接去进行一些，比如说并发呀，或者说等等一些这个流程机制。所以类似这种情况，你看一下。 当前的话呢，我们是需要去构建一个新的一个 play，你不需要去审计，只需要去检查即可，保持较小的修改，然后保持语义呢准确流畅自然，然后相应的修改改动呢保持尽量去让这个我们具体使用的时候保持一个高效的一个泛化性，就是你以较小的修改，然后同时又能够让运行的时候它能以较少的一个逻辑区分和复杂度。就比如说它不需要去过度地去区分什么到底是什么状态啊，或者说什么什么什么一些这个函数签名啊等等一些东西，它能够非常自然而然地去使用，就是按照第一性去进行思考和使用，就是让一些即使不是很会去使用 TypeScript，或者说这个 JavaScript 的一些这种模型呢，它都能够去有效地很好地去非常轻易地去进行调用，就是让我们的这个相应的一个使用曲线呢不要过于高，但是它相应的这个具体背后能够实现的一个情况呢，整体而言是上限又非常的高的这么一套逻辑，所以请你注意这一点。然后你看一下去构建一个完整的一个 play，你可以先去 search 一下，先去 T-A-V-I-L-Y 去 search 一下，再去构建一个 plan

> 注意，我当时没有说当前的 execute 提示词非常冗长，我没有让你去精简它。我说的让你去优化它。当然部分的词，如果你觉得叙述得过于拖沓，你也可以适当优化。但是我的目标不是去精简，而是去优化这一套 execute 提示词的一套逻辑性，或者说整套逻辑，使得它能够更加地有效且高效地去增强我们 Harness 的一个实用以及高效性，也就是处在复杂任务以及判断逻辑语意的一个高效性，节省 token 成本。

> 注意请注意是写新计划，不是更新计划。

验收对象是常用脚本的正确性、编排效果和完整任务成本，不是提示词字符数下降。允许为有效指导增加文本，不删现有权限、目录和沙箱约束来追求短提示词。

后续补充要求原文：

> 注意一点，相应的修复方向并不是说什么复用，巴拉巴拉巴。修复方向是让工具变得更加好用，而且上限更高，且使用难度，使用的统一性保持优秀。也就是说，它不要，比如说，本来是模型以为能 await 的，但是结果它 await 有问题。这种东西本身就是一个有歧义，或者说有这种有问题的一套逻辑。

> 然后你说直接让 await 什么报错，这本身就是更更有问题的逻辑。能解决的错误我们就不要去报出来。

> 比如工具层面的错误，如果能工具自己去避免那个错误发生，那工具就不要再把那个错误，就是工具不要把工具自己去解决自己的问题的责任去归给后面或者归给模型去解决。

> 或者换言之，工具，Agent调用了一个合法的一个工具手段，结果工具返回了一个报错，这本身就是一个不太好的行为。应该给它了一个合法东西，它按理来说应该自己能执行啊，那不应该再去报个错呀。所以注意这一点逻辑。

> 不应该做踢皮球这件事情。

R2 据此把使用合同置于实现取舍之上：合法的 async/await、函数和并发组合应直接工作；能由执行器解决的调度、作用域和 Promise 缺陷在执行器内修复，不成为模型必须识别的特殊状态、绕行写法或错误。复用只是一种可能的实现手段，不是验收目标。R1 中保留 race 主动取消败方及空数组报错的设计撤销，因为它会使合法操作失败。

## 2. 明确不做的事项

- 不改生产代码、测试或运行配置来完成本轮计划，不修改旧计划，不执行 Git 写操作。
- 不移除或隐藏 V1 直接工具，不改旧 V1 基础测试来迁就 execute，不另建执行器或回退模式。
- 不修改通用 `gpt.txt`、`gpt-astra.txt`、用户自定义提示词、Agent Loop、权限政策或工具输入输出 schema。
- 本次保证 async/await、普通函数与已支持的五个 Promise 入口能正确组合，不以实现完整 ECMAScript 引擎作为修复前提。新增 API 不是本次修复所必需的；现有内部实现限制也不能成为拒绝修正合法调用的理由。
- 不新增 worker pool、并发配置、自动重试、通用结果解包器、自动补页器或新的模型可见状态协议。
- 不移植 ultrawork 的多代理调度、模式开关、任务图或审计流程。
- Shell 非零退出、超时以及两层输出裁切已观测到正确结果，本任务保留其合同，通过提示词和回归覆盖正确消费方式。

## 3. 仓库约束与外部调研

| 来源                                                              | 对本任务的约束或借鉴                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 根 `AGENTS.md`                                                    | 最小正确修改；测试和 typecheck 从包目录运行；不升级成另一套 Session 执行体系                     |
| `packages/codemode/AGENTS.md:3-6`                                 | codemode 拥有受限语言和工具编排；宿主拥有授权、持久化和工具交付语义；提示词保持宿主无关          |
| `packages/opencode/AGENTS.md`、`packages/opencode/test/AGENTS.md` | 复用 Effect 服务和既有 fixture；用就绪信号验证并发，不用固定 sleep 猜测启动状态                  |
| `CONTEXT.md:54-58`                                                | Model Tool Output 和 Managed Tool Output File 是不同职责；脚本汇总不能取消宿主的完整输出恢复机制 |
| `.opencode/policy/first-principles-engineering.md`                | 修正第一处语义偏离；不以提示词绕开实现缺陷；用户明确要求高于默认审计流程                         |
| `.opencode/templates/canonical-plan.md`                           | 本文包含证据、单一路径、双向追踪、TDD、范围和验证；审计章节明确标注本轮豁免                      |
| `docs/adr/`                                                       | 当前只有 triage ADR 和说明文件，没有可替代本任务语言合同的异步执行 ADR                           |

先用 Tavily 搜索，再读取以下正文，检索日期为 2026-11-07：

| 已核实来源                                                                                                                                                                    | 可借鉴的实践                                                                                                               | 在本地的取舍                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Anthropic: Introducing advanced tool use](https://www.anthropic.com/research/advanced-tool-use)                                                                              | 通过代码表达循环、条件、并行和数据转换；工具中间结果在代码中处理；模型只接收有用的最终输出；工具搜索和调用示例降低使用成本 | 借鉴编排流程和结果筛选，不引入其 Python 容器、API 协议或宣称其 token 节省数字可直接复现 |
| [Oh My OpenAgent overview](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/overview.md) 与 [项目 README](https://github.com/code-yeongyu/oh-my-openagent) | 先了解代码和任务，再编排独立工作，在真实结果上验证后收尾                                                                   | 借鉴依赖意识、并行和验证，不把“开更多代理”写成 execute 的使用条件                       |

Anthropic 来源讲的是 Claude API 的程序化工具调用；ultrawork 来源是第三方 OmO 项目。它们不是同一个产品，也没有据此证明 Claude Code 内部存在与本地 execute 相同的解释器或调度机制。外部宣传中的性能数字不作为本项目验收证据。

## 4. 本地证据清单

| 证据                                                                                     | 作用                                                                                                        | 分类       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/codemode/src/interpreter/model.ts:43-48`                                       | 函数值只有参数、函数体、捕获作用域，没有保存 AST 的 `async` 标记                                            | observed   |
| `packages/codemode/src/interpreter/runtime.ts:847-860,2219-2256`                         | 创建函数时丢弃 `async`；调用时在同一解释器上执行完整函数体并返回普通值                                      | observed   |
| 同文件 `:602-628,822-844,2222-2253`                                                      | `scopes` 和 `lastValue` 是实例可变状态；不能直接把当前函数体随意 fork 并共享这些字段                        | observed   |
| 同文件 `:1449-1455`                                                                      | await 普通值或已完成 immediate Promise 没有真正的让出点                                                     | observed   |
| 同文件 `:2105-2215`                                                                      | all/allSettled/race 调用直接等待结果；all 按下标等待，可能迟迟看不到后面的拒绝                              | observed   |
| 同文件 `:2187-2207`、`values.ts:4` 及 R2 两项探针                                        | race 主动取消败方并维护 interrupted 特殊状态；race([]) 直接报错，导致合法调用失败                           | observed   |
| 同文件 `:718-775,2645-2711,3369-3408`                                                    | 工具 eagerly fork；数组回调共用函数调用入口；存在固定并发限额、执行超时和最终输出边界                       | observed   |
| `packages/codemode/src/values.ts:3-9`                                                    | 现有 SandboxPromise 已能表达运行中的 fiber 或立即结果，不需要另造 Promise 类型                              | observed   |
| `packages/codemode/test/promise.test.ts`                                                 | 覆盖直接工具 Promise、八并发限额、混合值、取消、超时、数据边界；没有锁住本次自定义 async 和组合器返回值缺陷 | observed   |
| `packages/codemode/test/parity.test.ts:6-22`                                             | 普通 JS 行为和 JSON 边界是已有公开测试约定，undefined 在边界归一化为 null                                   | contracted |
| `packages/codemode/src/code-mode.txt`、`src/tool-runtime.ts:25-33`、`src/codemode.ts:62` | 固定 execute 描述从同一个文本来源导出，目录说明有独立分段                                                   | observed   |
| `packages/opencode/src/tool/code-mode.ts:99-113,158-217`                                 | 预跑与真实执行使用同一 codemode；权限终止保持中断；logs、附件、强制指令由宿主交付                           | observed   |
| `packages/opencode/test/tool/code-mode.test.ts:141-147`                                  | 新增 execute 测试锁定旧官方说明 hash；此次明确优化提示词后应改为有效指导和目录隔离验收，而非盲目换 hash     | observed   |
| Effect 参考仓库 `packages/effect/src/Effect.ts:8563-8607`                                | forkIn 接受明确 scope 和 startImmediately；scope 关闭负责中断挂起工作                                       | observed   |
| 本轮内存探针，见第 8、18 节                                                              | 直接运行当前 CodeMode，确认缺陷，并验证现有 Effect 原语可承担修复                                           | observed   |

初始 Git 状态只有 `packages/tui/test/cli/cmd/tui/session-message-render.test.tsx` 的并行修改及五个无关未跟踪计划；本任务不触碰它们。后续并行变化同样按归属保留。

## 5. 当前调用链

```text
模型脚本
  -> CodeModeTool：同一解释器预跑 / host.begin / 真实执行
  -> CodeMode.execute / executeWithLimits
  -> AST -> createFunction / invokeFunction / invokePromiseMethod
  -> SandboxPromise -> await / 组合器观察
  -> ToolRuntime.invoke -> 原 SessionTools.invoke -> 原工具与权限
  -> 解释器结果 -> 宿主 logs / context / attachments / 裁切 -> 模型
```

直接工具调用已经能提前启动；问题是自定义函数和组合器把“调用产生 Promise”错误地实现成“调用时先等完”。因此最终值正确的测试仍可能漏掉串行执行和错误传播时机。

`search` 是同步目录发现，返回 `path/description/signature`。签名是从 schema 渲染的接口描述，不是原始 JSON Schema 全量交付。本任务不改变这个接口，也不让脚本猜测未知工具的参数。

## 6. 支持域与可达性

| 输入/条件                                        | 生产者与路径                                       | 分类       | 处理                                         |
| ------------------------------------------------ | -------------------------------------------------- | ---------- | -------------------------------------------- |
| async 声明、表达式、箭头函数                     | 已支持 AST -> createFunction -> invokeFunction     | observed   | 三种形式统一保留 async 标记                  |
| 返回普通值、抛异常、返回已有 Promise、嵌套 await | 用户脚本及 fetch 响应的 async text/json/bytes 方法 | reachable  | 统一 Promise 返回及采用结果语义              |
| map(async ...)、for...of 中 await、组合器嵌套    | 普通数组回调和现有 Promise API                     | observed   | 修复函数调用，不给 map 特判加速路径          |
| 并发函数捕获同一外部变量、各自拥有局部变量       | 同一 CodeModeFunction 捕获的 Binding map           | reachable  | 共享外部 binding，隔离调用帧栈               |
| 慢首项、快失败后项                               | Promise.all 的合法参数数组                         | observed   | 同时观察，及时拒绝，成功结果仍按输入顺序     |
| helper 返回后在外层继续等待它创建的 Promise      | Promise 是现有可存储的一等值                       | reachable  | 生命周期归整段 execute，不归 helper 的 fiber |
| 权限拒绝、取消、超时                             | 原宿主权限和 AbortSignal                           | contracted | 保留不可被脚本 catch/allSettled 吞掉的中断   |
| 无结果分支、大中间结果、部分失败                 | 用户请求的复杂任务及前轮实测                       | observed   | 提示模型按需分支、筛选、保留必要证据         |

## 7. 必须保持的不变量

| ID  | 合同                                                                                                                                          | 验收入口                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| U1  | 对外支持的合法调用自然执行；工具内部可避免的问题在 owner 修复，不要求模型换写法、增加类型探测或补偿重试；使用一致性和能力优先于复用数量       | 下列所有公开接口及原用户场景      |
| A1  | async 调用立即返回独立 Promise；函数体错误成为拒绝，外部实参求值仍遵循普通调用规则                                                            | CodeMode.execute                  |
| A2  | await 在普通值和已完成 Promise 上也形成让出点；返回 Promise 被采用，重复 await 不重做操作                                                     | CodeMode.execute                  |
| A3  | 并发函数的参数、局部变量、作用域栈和表达式记录不串扰；共享闭包变量保持共享                                                                    | CodeMode.execute                  |
| A4  | all/allSettled/race 返回 Promise；all 及时拒绝且成功结果保序；allSettled 保序收取普通失败；race 不取消其他 Promise，race([]) 返回挂起 Promise | CodeMode.execute                  |
| A5  | 原工具入口继续承担既有许可和调用预算，async/组合器自身不额外占用或重置预算；整段仍最多八个并行工具调用，嵌套编排不死锁                        | CodeMode.execute + 工具 fixture   |
| A6  | 同一 execute 只拥有一份任务生命周期；helper 结束不误杀外部仍会等待的 Promise，整段结束和超时可收口所有工作                                    | CodeMode.execute + CodeModeTool   |
| A7  | 原 V1 直接调用、权限终止、预跑无副作用、child 终态、真实结果及强制上下文交付不变                                                              | Session execute / permission 回归 |
| P1  | 模型知道何时适合 execute、如何发现未知接口、如何按依赖编排以及如何返回足够而有界的证据                                                        | 描述出口 + 可执行示例 + 使用验收  |
| P2  | 优化完整任务的正确性、轮次和 token 成本；提示词长度本身不是成功指标                                                                           | 同条件任务对照                    |
| S1  | 新建计划、只检查不审计、本轮不实施、不改旧计划与无关文件                                                                                      | 工作区差异                        |

## 8. 第一处偏离与已运行反馈

| 不变量 | 根因所在                                                                 | 传播与表现                                                                           |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| A1     | createFunction 没有把 AST async 位存进 CodeModeFunction                  | invokeFunction 无法分派 async 调用，普通值直接返回、异常提前抛出、map 等待完整函数体 |
| A2     | AwaitExpression 对 immediate/普通值直接成功，无让出                      | `started,resumed,caller`，而不是 `started,caller,resumed`                            |
| A3     | 单实例 scopes 的保存/替换/恢复                                           | 当前串行实现暂时掩盖问题；直接 fork 当前实现会让多个调用互相覆盖作用域               |
| A4     | invokePromiseMethod 用求值 Effect 直接代表组合器调用                     | 数组/数字直接返回；按下标 join 会把后项失败压在首项后面                              |
| U1/A4  | race 将“选择先完成结果”附加为“取消其他任务”，并拒绝空数组                | 后续 await 合法败方 Promise 报错；只创建空 race 而不等待也无法继续                   |
| A6     | 当前 forkChild 依赖调用位置的 fiber；补 async fiber 后会产生新的父子层级 | 如果照搬到新函数帧，helper 返回可能提前终止仍需使用的调用                            |

本轮已在 `packages/codemode` 用 `bun --eval` 执行四项带独立期望值的探针。四项均失败，进程 exit 1，约 1.2 秒；工具调用数均为零。这是红灯证据，不是实施后的测试结果。

| 脚本核心                                                               | 期望                     | 当前实际                            |
| ---------------------------------------------------------------------- | ------------------------ | ----------------------------------- |
| `async function f(){return 7}; const p=f(); return [typeof p,await p]` | `["object",7]`           | `["number",7]`                      |
| `(async()=>{throw new Error("probe")})()` 交给 allSettled              | `[["rejected","probe"]]` | `ExecutionFailure: Uncaught: probe` |
| async 内 `await 0`，调用者记录 caller                                  | `started,caller,resumed` | `started,resumed,caller`            |
| 对 all/allSettled 返回值检查 Array.isArray、对 race 检查 typeof        | `[false,false,"object"]` | `[true,true,"number"]`              |

最小、可重复的红绿命令如下，不创建文件：

```powershell
bun --eval 'import { CodeMode } from "./src/index.ts"; import { Effect } from "effect"; const r = await Effect.runPromise(CodeMode.execute({ tools: {}, code: "const p=(async()=>{throw new Error(\"probe\")})(); return (await Promise.allSettled([p])).map(x=>[x.status,x.reason.message]);" })); console.log(JSON.stringify(r)); if (!r.ok || JSON.stringify(r.value) !== JSON.stringify([["rejected","probe"]])) process.exitCode=1;'
```

另外，真实 Tool.make fixture 把首项设为 `Effect.never`、第二项立即失败，再执行 `try { await Promise.all([wait(), fail()]) } catch(e) { return e.message }`。在 250ms 整段预算下，当前得到 `TimeoutExceeded`，而不是预期的 `EXPECTED_FAILURE`。这证明串行观察不仅影响性能，还会掩盖已经发生的失败。250ms 只是探针上限，不是提议修改生产超时。

此前两个 Shell 各等待 1 秒的实测中，直接工具 Promise 的运行区间重叠 974ms，async 包装版本重叠 0ms。本计划新增确定性的屏障/事件测试，不把这个机器上的毫秒数字写成 CI 阈值。

R2 又运行了两个带期望值的当前 CodeMode 探针，均失败，exit 1：`const p=Promise.race([]); return "continued"` 实际立即报告 never settle；`const slow=tools.host.slow({}); const first=await Promise.race([1,slow]); return [first,await slow]` 预期 `[1,2]`，实际报告败方被中断。这两种情况都应由工具内部纠正，不能要求模型捕获错误后重新发起调用。

## 9. 责任归属和验证接口

| 责任                                  | 唯一 owner                                              | 验证接口                                     |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| 函数调用、作用域、await、Promise 组合 | codemode interpreter                                    | CodeMode.execute / CodeMode.make().execute   |
| 工具限流、输入校验和调用事实          | 原 ToolRuntime / interpreter 宿主调用入口               | 真实声明式测试工具，经公开 CodeMode API 调用 |
| 权限、预跑、持久化与模型结果交付      | 原 CodeModeTool / SessionTools                          | 现有 execute 集成测试                        |
| 通用 execute 使用说明                 | `packages/codemode/src/code-mode.txt` 的 description 段 | CodeMode.description 与实际工具描述出口      |
| 原生工具具体返回状态和输入 schema     | 各工具的原定义及 search 结果                            | 不复制一套通用适配层                         |

这些是后续实施建议使用的既有公开测试接口；本轮未新增测试文件。计划批准时一并确认测试范围，不以私有方法或源代码字符串匹配代替行为验收。

## 10. 单一主路径设计

设计目标是让模型用普通语言语义表达任务：`await value`、嵌套 await、`return helper()`、`map(async ...)`、先 race 再 await 另一个结果，都无需了解执行器的内部实现。内部状态不变成模型可见的调用参数或分支规则。以下机制只是完成这个使用合同的最小候选方案；若机制不能通过行为验收，应修机制，而不是缩小合法输入域。

### 10.1 恢复函数值和 await 的本义

在 CodeModeFunction 保存 AST 的 async 布尔值。所有函数声明、表达式和箭头函数都经同一个 createFunction；fetch 响应工厂及其 async 方法也遵循这条路径。

同步函数继续返回普通值。async 函数调用复用 SandboxPromise，立即启动函数体至首次让出，返回 Promise；参数初始化与函数体抛错进入该 Promise 的失败结果。async 的 return 若得到已有 SandboxPromise，先采用其结算结果，再完成外层 Promise；普通函数返回 Promise 不隐式等待。

AwaitExpression 统一负责等待和让出：无论输入是普通值、immediate Promise 还是工具 Promise，都保留 await 后续代码晚于调用者继续执行的正常顺序。使用现有 Effect 调度原语，不自己实现微任务队列，不引入 Node VM/eval 作为第二执行路径。

### 10.2 调用帧与整段任务各自拥有正确状态

并发 async 调用使用同一 Interpreter 实现的独立调用帧。每帧拥有自己的 scopes 数组、参数/局部 scope 和 lastValue；捕获的外层 Map/Binding 保持引用共享，不深拷贝闭包。同步嵌套调用在所属帧内继续复用原作用域逻辑。

执行期共享的只有原宿主 invoke、目录、日志、并发许可及一个 execute 级 Scope。内置全局绑定只在根帧创建一次；创建函数帧不重建工具树、不重新解析全局工厂、不重置预算。

工具、async 函数和组合器共用一个私有 Promise 启动入口，以 `Effect.forkIn(..., executionScope, { startImmediately: true })` 将任务归入整段执行。工具调用才进入现有 Semaphore；函数/组合器不占该许可，避免“八个函数各占一个许可，又等待八个工具”的自锁。

Scope 负责整体生命周期，替代 pendingSettlements 的手工任务收口记录；不同时维护两套权威任务清单。普通 helper 返回不关闭它创建的 Promise；根脚本完成、失败、超时或宿主中断时关闭执行 Scope。先完成任务收口，再投影 logs/toolCalls 和宿主回执，保证取消终态不会停留在 running。

### 10.3 修正组合器，不扩展成新的并发框架

| API                    | 计划行为                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promise.resolve/reject | 保留现有 SandboxPromise 表达和 resolve 的已有 Promise 身份；不增加任意 thenable 协议                                                                      |
| Promise.all            | 立即返回 Promise；并行观察已经启动的成员；任一拒绝及时拒绝，全部成功时保持输入顺序；观察者失败不误杀其他底层任务                                          |
| Promise.allSettled     | 立即返回 Promise；收取全部普通成功/失败并保持输入顺序；宿主权限/取消等中断继续穿透                                                                        |
| Promise.race           | 立即返回 Promise，首个结算胜出；不取消任何输入 Promise，其他成员仍可继续 await 或参与别的组合；空数组返回挂起 Promise，是否继续等待由脚本表达             |
| map / for...of         | map 不自动 await callback，自然收集 async 返回的 Promise；for...of 中显式 await 自然串行。filter/some 等仍采用普通 JS 回调语义，不新增隐式 async 集合方法 |

删除 race 败方取消分支、SandboxPromise.interrupted 标记和两处“因 race 被取消而转换成可捕获错误”的特殊处理。只取消失去用途的观察者，不取消它们观察的任务。未完成底层工作统一受整段执行 Scope 约束，无须建立 Promise 依赖图或递归取消传播。`race([])` 未被等待时不影响后续语句；若确实一直等待，原整段执行预算仍然生效，不新增空数组专用报错。

组合器的输入校验也在其 Promise 结算路径内表达，避免调用点提前抛出造成另一套用法。脚本主动 throw 和真实外部操作失败按原合同表达；执行器制造的可避免失败不能借这个错误通道推给模型，也不能吞错伪造成功。

当前 `.then` 和 `new Promise` 尚未实现，这一事实不能证明已有 async/await 的异常合理。本文不宣称完整 Promise API 已实现，也不以新增这些 API 为修复前提；优先把已经接受和声明支持的调用完整做对，不新增使用限制来换取较小 diff。

### 10.4 优化 execute 提示词的决策流程

只修改 code-mode.txt 的固定 description 段，保留 empty/complete/partial 目录段、精确调用路径、宿主能力边界和原有返回规则。必要时合并重复句，但不以字数更少作为目标。

模型应得到这条简单流程：识别有价值的编排任务 -> 获取缺失的工具定义 -> 按数据依赖执行/并行 -> 在代码里筛选或归纳 -> 返回足够判断任务的事实。简单直接调用仍自然可用，不强制为了用 execute 而包脚本。

待实施的英文描述草案如下；它是唯一草案，不是已经生效的提示词：

```text
Run JavaScript in a confined runtime to orchestrate tools and process their results.

Use execute when a workflow benefits from dependent tool calls, conditions, loops,
parallel independent work, or filtering and aggregating results before they reach
the model. Use a directly available tool when a simple call is sufficient.

Use the current catalog and search to discover any missing tool definitions.
Inspect the returned paths and input/output signatures before writing calls that
depend on them; return the search result first when you need to inspect it.
Reuse definitions already present in the current catalog. Do not guess names,
arguments, or result fields. Only tools in the Code Mode catalog are callable
here. Use their exact call expressions, including bracket notation when shown;
do not treat a full path string as tools[path].

Use await for dependencies. Start independent work together with Promise.all;
use Promise.allSettled when individual failures should not discard useful results.
Do not run conflicting writes in parallel. The runtime already limits concurrent
tool calls. Async functions and map(async ...) can express multi-step work per item.

Filter and summarize intermediate data in code. Return the findings, counts,
failures, and evidence needed for the next decision instead of full intermediate
datasets. console.log is included in the result, so avoid logging those datasets.
Check relevant execution-status, pagination, and completeness fields: a fulfilled
tool call need not mean that its command succeeded or its data is complete.
Follow the tool's recovery path only when the task needs the missing data.

Prefer an explicit return; otherwise the final top-level expression is returned.
Await every call whose completion matters. Pending work is interrupted when the
execution ends. Within an execution, Promise.race selects the first result without
cancelling other work. Supported promise APIs are async/await, Promise.all,
Promise.allSettled, Promise.race, Promise.resolve, and Promise.reject. Imports,
direct filesystem access, and timers are unavailable. fetch, when provided by the
host, performs HTTP requests; all other external access goes through tools.
```

保留宿主无关性，示例不把 `$opencode` 内置工具当成所有 codemode 使用者必有的能力。追加一个明确标为假设目录的两阶段例子；示例工具将在测试 fixture 中真实声明，不把它注入真实目录：

```text
Example: discover a lookup tool in one execution:
```

```js
return search({ query: "inventory lookup" })
```

```text
If the returned signature is tools.inventory.lookup({ id: string }):
Promise<{ id: string, count: number }>, a later execution can be:
```

```js
const ids = ["a", "b"]
const rows = await Promise.all(
  ids.map(async (id) => {
    const row = await tools.inventory.lookup({ id })
    return { id: row.id, count: row.count }
  }),
)
return rows.filter((row) => row.count > 0)
```

这个例子教发现接口、跨调用读取签名、并行异步处理和本地筛选。它不教模型把未知 search 结果字符串直接当函数执行，也不强制每次重新搜索已经可见的签名。发布时原说明和新增内容合并成一份，不保留两套互相竞争的调用建议。

## 11. 次级路径清单

| 路径                                          | 分类                    | 处理                                           |
| --------------------------------------------- | ----------------------- | ---------------------------------------------- |
| 同步函数和 async 函数的返回差异               | primary-contract branch | 保留语言本身需要的区分，不新增对外选项         |
| V1 直接工具调用                               | existing compatibility  | 完整保留；与 execute 共用原宿主调用链          |
| 当前未提供的 API、实际非法数据输入            | diagnostic              | 不冒充成功；不借此拒绝本次已支持域中的合法组合 |
| race 败方取消、空 race 报错                   | 当前错误的主路径分支    | 删除，使合法 await 和 Promise 组合直接工作     |
| Shell exit/timedOut、工具部分结果             | pass-through            | 原合同原样交付，不包装成新的通用状态           |
| 捕获 async 错误后伪造正常值、失败后切换执行器 | forbidden fallback      | 拒绝                                           |
| 无视 async 标记但在 map/allSettled 中补偿     | forbidden fallback      | 拒绝，修函数调用的起点                         |

新增备用成功路径为零；并发算法的分支仅实现已支持 API 的明确合同。

## 12. 删除或替换的旧逻辑

- 用 execute 级 Scope 替换 pendingSettlements 的 add/delete/finalizer 收口逻辑，避免新旧生命周期并存。
- 用统一 Promise 启动路径替换组合器“调用即等完”的逻辑，保留数组回调的普通实现。
- 删除 race 的额外取消政策、空数组立即报错、interrupted 特殊标记及错误转换；相应测试改验“选择结果”和“执行结束收口”两个真实职责。
- 替换“顺序 join 不影响并发”的笼统注释；它没有覆盖及时拒绝合同。
- 更新 tool-runtime 中要求固定描述逐字保留上游的过时注释，目录段解析逻辑不变。
- 原新增 execute 提示词 hash 测试改验实际语义和目录隔离；不改旧 V1 基础测试，不通过删除其他断言让回归变绿。

## 13. 正向追踪

| 要求                      | 实施位置                                 | 行为验证                                                   |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| U1 合法输入由工具负责完成 | 所有本次 owner 修改，尤其函数/await/race | 原样运行自然写法，不要求模型增加 workaround；六项红灯转绿  |
| A1-A2 正常函数/await 语义 | model.ts + runtime.ts                    | 四项红灯、三种 async 形式、嵌套返回与错误                  |
| A3 作用域隔离             | runtime.ts 调用帧                        | 两个暂停/恢复的函数保留各自局部值，共享外部计数正确        |
| A4 组合器                 | runtime.ts Promise 入口                  | 即时返回、及时拒绝、保序、混合值、重复引用、嵌套组合       |
| A5-A6 并发和生命周期      | runtime.ts 共用启动入口/执行 Scope       | 屏障并行、超过八项嵌套、helper 逃逸 Promise、结束/超时收口 |
| A7 宿主与 V1              | 原 owner 不改，仅新增集成覆盖            | async 包装后权限/取消/child 终态；原直接调用测试不改       |
| P1 使用指导               | code-mode.txt                            | 公开描述出口、可执行发现/并行/筛选示例、普通/OAuth请求回归 |
| P2 完整任务成本           | 第 18 节同条件使用验收                   | 任务正确性优先，比较真实 usage 和中间数据暴露量            |
| S1 新计划边界             | 仅新建本文                               | 文件差异和无审计调用记录                                   |

## 14. 反向追踪

| 新/调整概念                        | 对应要求 | 必要性                                                                                 |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| 删除 race 私有取消语义和空数组拒绝 | U1/A4    | 两个合法脚本已复现人为失败；恢复正常选择语义，同时减少特殊状态和分支                   |
| async 位                           | A1       | 丢失的信息不能靠调用者猜回                                                             |
| 独立词法调用帧                     | A3       | 共享可变 scopes 无法安全执行真正重叠的函数体                                           |
| 一次执行的 Scope                   | A6       | 新增 async fiber 后不能把任务寿命绑定到 helper；现有 Effect 提供所有权，无需自建状态机 |
| 私有共用 Promise 启动入口          | A1/A4/A5 | 工具、函数、组合器都需一等 Promise，避免三套预算/取消实现                              |
| 并行结算观察                       | A4       | 顺序观察可以无限期遮住已发生的后项失败                                                 |
| 一条两阶段示例和使用判断指导       | P1/P2    | 让模型知道如何发现未知接口、编排和减少无用中间数据；不靠重试学习私有约定               |

## 15. 文件级修改计划

以下是后续实施范围，本轮实际只新增本文。

| 文件                                             | 预期变化              | 责任                                                                   |
| ------------------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `packages/codemode/src/interpreter/model.ts`     | 约 1-4 行             | 保存 async 标记                                                        |
| `packages/codemode/src/interpreter/runtime.ts`   | 约 120-220 行有效修改 | 调用帧、执行 Scope、统一 Promise、await 让出、组合器；尽量在原位置修改 |
| `packages/codemode/src/values.ts`                | 删除 1 行字段         | 移除 race 专用 interrupted 标记                                        |
| `packages/codemode/src/code-mode.txt`            | 约 35-65 行文本调整   | 固定描述的工作流和示例，保留其他目录分段                               |
| `packages/codemode/src/tool-runtime.ts`          | 1 行注释              | 清除与新提示词目标冲突的“逐字保留上游”说明，不改目录实现               |
| `packages/codemode/test/promise.test.ts`         | 约 140-230 行有效修改 | 复用现有 run/fixture，按行为切片增加核心回归                           |
| `packages/codemode/test/codemode.test.ts`        | 约 30-60 行           | 执行说明中的示例；覆盖 fetch 方法采用相同 async 路径                   |
| `packages/opencode/test/tool/code-mode.test.ts`  | 约 10-25 行           | 提示词出口和旧 hash 测试更新                                           |
| `packages/opencode/test/session/execute.test.ts` | 约 30-70 行           | 真实宿主中 async/组合器取消与权限交付                                  |

不预计修改工具 schema、SDK、Server API、Session 生产逻辑或 TUI。若实施发现必须增加 owner，先拿出可达性和失败证据修订本新计划，不能以“保险”为由顺手扩散。

## 16. TDD 行为切片

每次先让一个公共接口测试因真实缺陷失败，再做最小修改；保留其他现有断言。

| 顺序 | 红灯行为                                                      | 最小修复/保护                                                                                                           |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | async 返回普通值、throw 在调用点逃出                          | async 标记 + Promise 返回；覆盖声明/表达式/箭头及返回已有 Promise                                                       |
| 2    | await 普通值/已完成 Promise 的 continuation 提前执行          | 显式让出；字面量 trace 与宿主 JS oracle 交叉验证                                                                        |
| 3    | 两个 async 项等待对方开始，当前无法同时到达屏障               | 调用帧隔离并启动；核实外部共享变量和局部变量，不用总时长猜并发                                                          |
| 4    | all/allSettled/race 返回数组/数值，后项失败被永不结束首项遮挡 | 返回 SandboxPromise，并行观察；catch 失败后仍可等待另一个成员                                                           |
| 5    | race 人为取消败方、拒绝空数组及嵌套生命周期                   | 先 race 后 await 其他结果可成功；空 race 可保持挂起而继续执行；helper 返回不误杀任务；重复 await/repeated member 不重做 |
| 6    | 新路径可能绕过八并发和调用预算，或把中断当普通失败            | 超过八项嵌套、maxToolCalls、整段超时、普通错误/allSettled 与宿主中断区分                                                |
| 7    | async finally、脚本 return、race、abort 后宿主 child 未收口   | 沿真实 CodeModeTool/Session fixture 检查终态与无遗留工作，不新增 UI 修补                                                |
| 8    | 提示词只有规则，没有可执行的完整使用示例                      | 声明示例 lookup 工具，先 search 确认签名，再执行示例，期望仅返回 count>0 的行                                           |

正常分支、失败分支、空输入组合器、Promise 数据边界和 filter(async ...) 的普通 JS 行为一并作为相关回归。测试不复刻解释器，不用自写假 all/allSettled 算法充当 oracle。

现有 codemode race 测试中“败方立即中断”和“空 race 报错”的断言固定了本次已确认的错误行为，需要改验正常语义。Session execute 中 `race cancels ...` 的测试改为验证根脚本结束/显式 abort 才收口；保留完整 child 终态和后续工具可用断言。这是本次明确的语义修正，不改原 V1 基础测试，不以减少断言掩盖错误。

## 17. 注释预算

本轮只有文档，实际有效代码修改 E=0、C=0。后续实施估计 E 为 330-610 行（包含有效测试代码，不含导入、格式、纯移动及提示词文本），按仓库规则要求 C 至少为 `max(1, ceil(E * 0.15))`，约 50-92 行，最终必须从实际 diff 计算。

中文解释集中于真实约束：调用帧与共享 binding、Scope 生命周期、取消传播和权限不可吞、观察者与底层任务的区别、只对工具加许可、await 顺序、测试屏障和独立期望值。复用已合格解释，不注释显然赋值，不为满足比例扩大实现或制造无意义注释。

## 18. 检查与后续验证

### 18.1 本轮已经执行的检查

| 检查                                          | 结果                                                                 | 能证明什么                                                           |
| --------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tavily 搜索并读取 Anthropic/OmO 正文          | 完成                                                                 | 提示词借鉴有真实来源，不把两种产品混为一谈                           |
| 当前 CodeMode 四项内存断言                    | 4 项失败，exit 1                                                     | 返回类型、throw、await 顺序、组合器的已复现缺陷                      |
| R2 两项合法 race 操作断言                     | 2 项失败，exit 1                                                     | 败方继续 await 和创建空 race 被工具自身错误地拒绝                    |
| 首项永不结束、后项立即失败的 all 探针         | 250ms 后 TimeoutExceeded                                             | 顺序观察会遮住真实失败                                               |
| Effect forkChild(startImmediately) + yieldNow | `started,caller,resumed`                                             | 已有调度原语支持所需局部顺序，无需自己写调度器                       |
| 同一执行 Scope 中 helper 返回后等待其内部任务 | `alive after helper return`                                          | 生命周期可归执行而非 helper                                          |
| 并行 join 观察失败，再释放慢成员              | `EXPECTED_FAILURE`、stillPending=true、`sibling kept running`        | 可及时失败而不取消其他底层任务                                       |
| execution Scope 关闭中断 never 任务           | interrupted=1，exit 0                                                | 同一个 scope 可负责最终收口                                          |
| 第 10.4 节示例经真实 Tool.make/schema 执行    | search 返回声明的 lookup 签名；最终 `[{"id":"b","count":2}]`，exit 0 | 示例可直接运行且筛选正确；该立即返回 fixture 不证明 async 并发已修好 |
| 第 8 节文档中的原样最小命令                   | `ExecutionFailure: Uncaught: probe`，exit 1                          | 文档提供了实际可运行的红绿入口                                       |

这些隔离实验验证了修复的关键原语，不等于已修复解释器。首次探针用 eval 承载静态 import 导致 harness 语法错误，随后改为直接 `bun --eval` 成功运行；不把该 harness 错误计入解释器缺陷。一次额外 Tavily 搜索超时、一次无关键词请求被拒绝；本文引用仅来自成功读取的页面。

### 18.2 实施后的命令

| 命令                                                                                                                                                                                                                                                                                                                     | 工作目录            | 验证目标                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------- |
| `bun test --timeout 30000 --only-failures test/promise.test.ts`                                                                                                                                                                                                                                                          | `packages/codemode` | 原 Promise 回归和新增异步语义红绿切片               |
| `bun test --timeout 30000 --only-failures`                                                                                                                                                                                                                                                                               | `packages/codemode` | 解释器、fetch、集合、schema、搜索全包回归           |
| `bun typecheck`                                                                                                                                                                                                                                                                                                          | `packages/codemode` | 新调用帧/Scope 的 Effect 环境和类型不泄露到公共 API |
| `bun test --timeout 30000 --only-failures test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/session/execute.test.ts test/permission/execute.test.ts`                                                                                                                                              | `packages/opencode` | 描述出口、MCP、预跑、权限、child 终态               |
| `bun test --timeout 30000 --only-failures test/session/prompt.test.ts test/session/tools.test.ts test/cli/run/run-process.test.ts`                                                                                                                                                                                       | `packages/opencode` | 旧 V1 调用和执行顺序继续可用，基础测试不改          |
| `bun typecheck`                                                                                                                                                                                                                                                                                                          | `packages/opencode` | 宿主兼容性                                          |
| `bun run lint packages/codemode/src/interpreter/model.ts packages/codemode/src/interpreter/runtime.ts packages/codemode/src/tool-runtime.ts packages/codemode/test/promise.test.ts packages/codemode/test/codemode.test.ts packages/opencode/test/tool/code-mode.test.ts packages/opencode/test/session/execute.test.ts` | 仓库根目录          | 仅任务代码 lint，不在根目录运行测试                 |
| `git diff --check`                                                                                                                                                                                                                                                                                                       | 仓库根目录          | 空白问题；只读 Git                                  |

最后重新通过实际 execute 跑用户原来的 async throw、map(async ...) 并发、错误后继续以及精简结果工作流。Shell 就绪/运行区间只作真实交互确认；跨平台自动化以屏障和原平台适配为准，不增加全局 timeout、不增加 skip。

### 18.3 提示词和成本验收

1. 保留当前有效约束：发现未知工具、精确路径、可用能力、await/return、取消和直接调用共存。检查普通 provider 与 OAuth 指令出口，不改通用模型提示词。
2. 示例本身能在声明对应工具的 fixture 上直接运行；其他任务通过相同普通 JS 结构表达，而不是依赖示例专用 helper。
3. 选三个固定任务作前后对照：一个简单查询；一个“发现数据 -> 条件分支 -> 并发读取 -> 汇总”的复杂任务；一个含普通失败与大/部分结果的批处理。输入、模型、目录、缓存条件和任务成功判据保持一致，每个至少三次，记录失败和重试。
4. 正确性先验收：事实覆盖、工具参数、数据依赖、错误保留、部分数据标志和授权均正确；不允许为了少 token 漏读必要材料、跳过验证或吞掉错误。
5. 成本记录完整输入/输出 usage、模型往返、无效工具调用、输入脚本与最终结果；把新增固定提示词和搜索成本算进去。重点比较复杂任务的中间数据入上下文量及总任务 token，不把字符数换算成精确 token，不以输出更短直接宣称净收益。
6. 若没有实际模型 usage，只报告行为与载荷规模，明确“token 收益尚未验证”。不新增生产遥测模块或 benchmark 框架来满足本计划。

## 19. 修改预算

| 项目                               | 预算                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| 本轮新增                           | 本文 1 个 Markdown 文件                                                    |
| 后续修改                           | 9 个现有文件，其中 4 个功能/提示词生产文件、1 个注释修正文件、4 个测试文件 |
| 新增生产/测试文件                  | 0                                                                          |
| 删除文件、迁移、SDK 生成、配置开关 | 0                                                                          |
| 生产有效代码                       | 约 120-225 行；不为了凑预算省掉已确认合同                                  |
| 测试有效代码                       | 约 210-385 行，优先复用 fixture 和表驱动                                   |
| 提示词                             | 依据有效指导组织内容，允许变长；不设“必须更短”的门槛                       |

预算用于提醒范围膨胀，不是允许降低正确性的硬上限。尽量不移动大段代码、不整文件格式化。

## 20. 真实风险与决策

- 直接 fork 原 invokeFunction 会造成作用域串扰；调用帧隔离是修复的一部分，不能留待以后。
- 新 async fiber 若自行拥有工具，会误杀返回到外层的 Promise；执行 Scope 与独立帧要作为同一行为切片验收。
- all 的快速失败和 race 的结果选择均不取消其他输入任务；执行结束的统一收口负责资源生命周期，不建立新的依赖图。
- `Effect.yieldNow` 的局部原语实验已通过；完整解释器的嵌套顺序、finally 和 Scope 关闭仍需实际红绿测试，不能拿原语实验替代。
- prompt 的示例名是条件示例而非真实工具广告，必须保留“search 返回该签名后”的条件；未知工具仍需发现。
- 支持正常 async 后，`filter(async ...)` 等会遵循 JavaScript 的 Promise truthiness，而不是偷偷等待。这是普通 JS 合同，不再发明集合专用语义。
- 新提示词是否降低完整任务 token 尚无 A/B 数据；本轮不能作节省百分比承诺。

没有必须由用户在多个实现路线中选择的开放问题。当前目标是让合法调用按正常 async/await 与组合器语义工作，内部机制承担其自身复杂度；候选实现是在原解释器的 owner 修正，并删除 race 私有取消分支。用户尚未授权实施。

不采纳的扩展包括完整 Promise API、独立微任务调度器、无限 thenable 兼容、自动工具 schema 猜测、通用状态包装和自动翻页。这些都不是修复已证实缺陷所需的主路径。

## 21. 本轮检查约定

用户原话是“你不需要去审计，只需要去检查即可”。本轮以证据、需求追踪、示例可执行性、边界和文档完整性自检交付，不调用独立 auditor，不借用旧 R21 的 APPROVE，不把自检标成独立审计批准。

## 22. 计划审计记录

不适用：用户明确要求本轮不审计。R2 保持 draft、Approved revision 为 none、Implementation allowed 为 no。新计划完成不等于生产实现已经获准。

## 23. 实施证据

尚未实施。生产/测试有效修改为零，本文以外的并行工作不属于本任务。第 18.1 节是计划阶段的缺陷与原语证据，不是实施通过记录。

待实施验证：完整解释器所有新切片、宿主/权限回归、类型检查、lint、原场景重测、提示词任务对照与真实 token usage。Linux/macOS 没有在本轮运行，不将 Windows 探针外推成三平台全部通过。

## 24. 实施审计记录

不适用：本轮未实施，也未启动审计。未来实施阶段的验收方式以用户届时要求为准，不能从本轮“只写新计划”推导出代码修改或独立审计授权。
