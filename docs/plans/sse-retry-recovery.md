# Canonical Implementation Plan: SSE 重试与消息统一收尾

> Status: verified
>
> Revision: R9
>
> Approved revision: R9
>
> Audit mode: full-scope / combined plan and implementation
>
> Requirement source: 本次对话 2026-11-05 至 2026-11-06 的用户要求及澄清，见第 1 节
>
> Implementation allowed: verified; only task-hunk isolation and authorized commit remain
>
> User implementation authorization: 已授权；用户明确目标为 verified-implementation-and-commit，按最新澄清实施经审查的版本、验证及提交；不授权 push
>
> Last updated: 2026-11-06

本文件是本次任务唯一的实现规范。R9 按用户逐项反馈收敛 R8 已实施路径：保留极大次数上限，撤回额外的 HTTP 文本限制和 JSON 文案归一化，共享原生错误读取，使用尝试局部变量，删除新增发布失败标志及其专项测试。不增加第八个生产文件；方案与实施一次完整审阅。历史审计原文只记录当时结论，不覆盖本版第 1、10、16、23 节。其他工作区修改不得清理、覆盖或混入提交。

## 1. Verbatim Requirement

以下为当前任务的原文要求，后续澄清优先于早先讨论中的建议。

> 理论上我们的第一微分支里面，对于这种网络错误问题，它有完全的无限次数的，但是有指数退避的这种重试机制。

> 同时不要进行无关的一些操作，保持精准的执行，保持高效，efficient。

> 你直接看最终状态，然后你去看一下那些内容。我希望那些内容呢，就是重试的一些逻辑呢都需要去支持。

> 整体设计尽量保持简洁。

> 也就是这个完整，这个无论是中断的，或者说完整的 message，它的所有的可执行的工具都执行完了，才去进行下一步。所以我认为你这个东西没有任何的区别，判断也就判断一点，这个 message 的工具调用都执行完了，这就是最简单的一个判断方式。你不要去搞那么复杂，说又判断，又在下游的地方判断这个，判断那个，它们本身都是同一个终态，你不要去搞得很复杂，请注意这一点。

> 没有工具启动的时候，这个东西当然就是撤回失败尝试，原消息内重新生成就没有问题。

> 如果它失败了，就直接去把那个没有生成完的那些内容直接去 drop 掉，或者抛弃掉就 OK 的。

> 之前使用的逻辑是把那些旧的那个 message 变成一个 hidden 的，然后同时以新的这个消息进行。但其实这个状态不是特别好，因为 hidden 的话，就会导致我们后面如果用户再去撤回一个东西，你这个 hidden 的这个语义到底是因为错误被撤回啊，还是说因为用户撤回被撤回这样。

> 你到底要怎么改，哪个地方改成什么，准备怎么怎么样地改。

> 大家请注意你最终的你不能修改我们工作区内容请注意这一点。

> 注意你最终需要完整构建相应的按照相应的First Principle Plan的一个原则构建相应的文档。

> 完整的文档需要在当前工作区的DOCS那里面去做。

> 相应的逻辑应该按照workflow的流程进行。也就是你最终要给出相应的一个准确的 play，同时保持较小的修改语义，但是又要对齐我们已有的各种各样的一些重试啊，然后一些各种各样的逻辑。

> 所有旧机制中存在的各种各样的一些重试啊，巴拉巴拉的语义，都应该得到精准的，就是它们所能带来的收益，所有的内容，都应该能在我们的新的这个设计中去得到，或者获得得到。所以请注意这一点，包括但不限于什么连接重置、拒绝连接、DNS，巴拉巴拉，各种各样的一些能力都应该去保留。然后你给的 plan 里面需要包含具体的 DIFF，等等一些东西。

> 本身你的 plan 都没有经过审计，你就不要再把 revision 从 R1换成 R2，请注意这点。然后同时你如果现在就是刚刚这个审计通过的话，那你只需要去移动编号就好了。你不需要去因为移动一个编号就触发一次审计。审计必须是有实质性内容更新或者实质性内容的大幅度改变才需要去进行审计，请注意这点。

> 你也需要让相应的审计员保持高效，不阅读不必要的东西。

> 如果你需要去写很长，你可以一大段一大段地写，比如一次性写一百行，或者说一次性写几百行，等等这样。

> 你要对齐之前的操作是如何的，不要自己重复造轮子，按理来说之前的dev-smark已经全部都支持这些的重试逻辑

> 还有相应的重试的时候的处理逻辑，甚至包括tail处理逻辑等等

> 也就是那个tailmarker

> 比如一旦compact中断，那本质上hidden的同时marker就会变成hidden，不参与生效；

> 保持高效，相应的任务工程你已经进行了大把的时间了，你应该思考什么是必要的，什么是重要的，不要一直在这里试图去找补某一些部分的关键逻辑。本身你在补的时候，你都应该去想一下，是你的主逻辑有问题吗，还是说怎么为什么一直有问题，巴拉巴拉的。你不应该去一直打补丁，请注意这点。而且本身生产，而且本身不对生产逻辑产生影响的东西，那就不需要去重复审计，请你注意这点，本身那是没有必要以及没有意义的，做有意义的事情，做高效的事情，请注意这点，不做无意义的修改，不做无意义的审计。

> 任务完成了吗?目标状态是什么你看清楚了吗?

> - **目标终态**：<verified-implementation-and-commit>

授权解释：用户已授权实现、验证及提交；R7 的实质变更由以下后续澄清驱动，仍保持一个消息收尾点，不授权 push。

2026-11-06 后续原话：

> 按理来说，任何可以重试的一些错误，本质上都不应该直接以报告失败的形式返回给用户，你再注意这一点。

> 这个错误能通过删除来解决吗？能通过移除我们加的 hunk 来解决吗？你不要只想着加补丁，你要想着减少东西。

> 因为首先SZE的报错是小概率行为，小概率行为又发生在一个极其小占比的一个边界的地方，这本身是更小概率的行为。这种行为你就让它去趋向于这个更大的一个范围的一个逻辑。就比如说，你把它认为是正常完成也可以，你把它认为是SZE报错也可以，但是你不需要去因为这么一点的 border case 增加复杂度，增加 test，请你注意这么一些逻辑。

本次澄清发生在明确询问“无工具、已有完整正文/stop/usage、随后 SSE 报错”的上下文。R7 选择删除候选实现新增的 finish/stepSettlement/stepCount 重试否决，沿一般可重试失败路径处理；不新增尾错成功分支、该边界的专用测试或计费状态。未知 provider-error 的缺省资格也只在共享 owner 决定，不能在 compaction 里转换成另一类错误来取得资格。

R7 审计指出 OpenAI Responses 会把旧版不可重试的 invalid_prompt 等错误作为未标记 provider-error 发出。针对明确列举 invalid_prompt、insufficient_quota、usage_not_included，询问是否补回标记、允许无限重试或保持原资格时，用户原话：

> 这种东西不去考虑，不增加复杂度。这种东西即便是重试也不会对这个实际结果带来什么影响啊。你应该考虑后果，这种与后果其实它即便是重试了，有什么用？有什么影响呢？它该不能用的就不能用，就咋了，没有什么区别。所以 keep，保持当前的一个情况即可，不需要去做什么各种各样的一些转换啊，什么逻辑操作。说过了，保持最小 hunk。

因此 R8 明确接受这些错误在缺省流事件中的重复请求，不加 code 黑名单、不补协议 retryable 标记；这是用户对旧停止语义的有限例外。已有类型化 LLMError 和显式 retryable=false、context-overflow 继续使用既有分类；不扩大到取消或工具重放。

R9 的直接授权和审阅方式来自用户后续原话：

> 我现在开始都允许你去改动了，但是你改动的方向必须按照我说的这个方向去走。不要把事情搞复杂。

> 你现在已经进行了一大部分了，继续改，改完一块儿进行。之前说过很多遍了，一块儿进行相应的方案加实施审阅。

> 主线它只需要去知道它这个东西是否可重试，以及是否要重试，只需要知道这两个东西就可以了。

> input estimate 你是怎么清的？你清了它还会有新的吗？就是在这个时候它会不会变成零呢？

> attempt大于5改成attempt大于那个，就是我们的那个所定义的那么一个上限，就是那个基本上不会达到的上限。

用户逐项选择撤回 H15（新增的明确 HTTP 状态下文本资格收紧）和 H16（新增 JSON 固定文案归一化）。R9 恢复这两处 HEAD 行为；保留已有错误分类、解析及等待封顶。用户拒绝新增数据库保存失败测试，R9 不将这一覆盖扩展继续作为验收承诺；删除候选 publicationFailed 跟踪及对应 Core 专项测试，真实工具等待和旧错误处理仍保留。用户允许结构不同的消息 owner 内联必要清理，不要求为了形式统一增加新框架。

## 2. Explicit Non-Goals

- 普通网络重试不增加 `hidden`、重试专用隐藏原因、消息替身或新的失败消息表；既有 compact 取消时 marker/summary 的 `compaction-cancelled` 隐藏和边界失效必须原样保留，不能因本条而删除。
- 不修改用户撤回、权限规则、Goal 自动续跑策略、工具失败熔断含义及已有执行时限。
- 不增加新的重试管理器、配置开关、运行时依赖、数据库迁移或公共 Protocol 字段。
- 不以模型切换、备用 Provider、提示模型“接着写”、恢复 token 偏移作为失败回退。
- 不将所有错误无条件无限重试；已有类型化/显式不可重试语义、上下文溢出和用户取消保留。未标记的流错误按第 1 节用户选择统一重试，不另识别其业务 code。
- 不自动重放 daemon 崩溃前的外部工具；本方案处理进程存活期间的 Provider 失败。
- 不保证跨进程、跨外部服务的 exactly-once，也不按命令内容去重模型在下一轮主动提出的新调用。
- 不调查截图中的工程任务，不修复历史会话数据，不修改当前并行进行的 TUI 工作。

## 3. Repository Context

| 来源 | 约束 |
| --- | --- |
| 根 `AGENTS.md`、`packages/opencode/AGENTS.md` | 小接口、既有 Effect 风格；Core 不能依赖 Opencode；不预先抽取单次 helper |
| `packages/opencode/test/AGENTS.md`、`packages/llm/AGENTS.md` | 使用现有本地 HTTP fixture、显式闸门；测试从包目录执行 |
| `CONTEXT.md:39-52,99-104,127,135` | Provider Turn 与 Session Drain 分开；工具收尾后才进入安全边界；失败不能伪造可复用的原生续接状态 |
| `.opencode/policy/first-principles-engineering.md` | 根因修复、单一主路径、正反向追溯、独立完整审查、中文解释注释门禁 |
| `.opencode/templates/canonical-plan.md` | 本文件采用其完整 24 节结构 |
| `docs/workflow.md:27-71` | 文档阶段、独立审查、实质修订后完整重审；行政编号不触发审查 |
| `docs/adr/` | 当前 ADR 不规定重试；不为该修复新增 ADR |
| `docs/plans/grok-finish-other-retryable-repair.md` | 历史修复保留了无工具失败前缀删除；其旧范围和审批不等于本次审批 |

本次基线：分支 `dev1-smark`，调研开始时 HEAD `321a3ffedd`。行为基线是 `dev-smark` 最终代码，不依赖是否找到最早解除次数限制的单个提交。

## 4. Files and Evidence Read

| 证据 | 用途 | 分类 |
| --- | --- | --- |
| `git show dev-smark:packages/opencode/src/session/retry.ts` | 最终策略没有次数上限；2 秒指数退避、30 秒无头部上限、30 分钟总等待上限、Cloudflare/429 特例 | observed |
| 同分支 `session/message-v2.ts`、`session/processor.ts` 最终状态 | 原有错误码、cause 解包、直接删 Part、工具终态及已确认消息处理 | observed |
| `packages/core/src/session/retry.ts:27-46,90-165,193-224` | 当前共享策略额外有 5 次限制；现有文本、状态和特殊额度逻辑 | observed |
| `packages/opencode/src/session/message-v2.ts:54-80,800-808,1715-2025` | 旧码集合仍在；APIError 助手会被历史转换跳过；现有错误归一化 | observed |
| `packages/opencode/src/session/processor.ts:94-198,256-265,298-528,700-825,956-1207` | 现有接口、Part 所有权、工具终态、cleanup 和重试实际顺序 | observed |
| `packages/opencode/src/session/tools.ts:88-219,241-305,325-389,413-472,479-598` | 本地/MCP 最终执行回调及中止补偿；普通成功主要依靠流事件落库 | observed |
| `packages/opencode/src/session/llm.ts:131-180,310-431` | Workflow 执行入口；AI SDK dispatch；流 Scope 退出中止其控制器 | observed |
| `packages/opencode/src/session/llm/request.ts:58-66,160-195,223-235` | 工具权限过滤保留原执行函数；Copilot 内部无副作用占位工具 | observed |
| `packages/opencode/src/session/llm/ai-sdk.ts:88-90,223-268` | 原始 network_error 变成可捕获失败；工具事件转换 | observed |
| `packages/opencode/src/session/llm/native-runtime.ts:129-172,213-234` | V1 原生适配器最终仍调用传入的工具执行函数 | reachable |
| `packages/opencode/src/session/prompt.ts:1712-1735,1982-2006,2168-2190,2238-2276` | 已有 continue 会重新读取历史、创建下一条助手消息；不需要新的返回状态 | observed |
| `packages/opencode/src/session/compaction.ts:585-639` | 另一个 Processor caller，无工具，必须同样得到无限网络重试 | reachable |
| `packages/opencode/src/permission/reviewer/service.ts:1009-1018` | Reviewer 复用共享策略；其协议重试及外层时限不是网络重试次数 | reachable |
| `packages/core/src/session/compaction.ts:262-350` | 原生压缩直接调用 LLM；scratch chunks、确认 usage、Started/Ended 提交边界 | observed |
| `packages/core/src/permission/reviewer.ts:116-256` | 原生审查直接调用 LLM；每次协议尝试 120 秒、最多三次及既有工具选择协商 | observed |
| `packages/core/src/session/runner/llm.ts:182-183,485-622,624-745,850-858` | V2 现有工具 FiberSet；目前仅两个内部错误可进入共享重试；既有 needsContinuation 循环 | observed |
| `packages/core/src/session/runner/publish-llm-event.ts:218-267,448-475` | fail/retry/未结算工具操作已经存在；retry 复用同一助手身份 | observed |
| `packages/core/src/session/message-updater.ts:271-278,446-455` | Retried 直接清内容、清失败字段，不使用 hidden | observed |
| 旧 `dev-smark` compaction.ts:1260-1318 / 当前 V1 compaction.ts:806-873 | run.onExit 用原 hideIncomplete 隐藏同次 marker/summary，成功边界不隐藏 | observed |
| 旧 MessageV2.filterCompacted/visibleCompactions / 当前 message-v2.ts:1455-1553 | 隐藏 marker、摘要或 Compaction Part 不能建立 tail 边界；普通 hidden tail 仍能作为结构定位 | observed |
| 旧 session/compaction-boundary.ts / 当前 Core session/compaction-boundary.ts:21-79 | SQL cutoff 确定前排除隐藏的压缩对，回选上一合法边界；代码行为已保留 | observed |
| `packages/core/src/session/runner/to-llm-message.ts:89-149` | V2 失败助手仍保留工具事实，且不复用失败轮原生 metadata | observed |
| `packages/llm/src/schema/errors.ts`、`schema/events.ts:200-206` | 已有 LLMError.retryable、retryAfterMs、ProviderErrorEvent；不需要新错误体系 | contracted |
| `packages/llm/src/route/executor.ts:353-402` | 已有交付前小次数传输重试；不能误当成完整 Session 恢复 | observed |
| `packages/llm/src/protocols/openai-responses.ts:910-929`、`anthropic-messages.ts:893-908` | 原生流错误的 code/type 已进入 message 前缀，retryable 可缺省 | reachable |
| `packages/opencode/test/session/retry.test.ts`、`processor-effect.test.ts`、`test/lib/llm-server.ts:421-446,530-597` | 分类基线、弱前缀断言、可控挂起/断连 fixture | observed |
| `packages/core/test/session-runner.test.ts`、`session-runner-tool-events.test.ts` | 既有等待工具、持久终态、非重试 Provider 错误、用量及取消行为 | contracted |
| 用户指定 SQLite，只读连接及 `PRAGMA query_only=ON` | 截图助手错误是 APIError/isRetryable=true，没有本轮工具或输出 | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\opencode.log:6578-7055` | 六次 90 秒无首块请求，最后 stop；约 604 秒 | observed |

表中源码行号是本次基线位置，实现时以符号定位，不以旧行号盲打补丁。

## 5. Current Behavior

```text
Provider 字节/HTTP/协议失败
  -> AI SDK Error 或原生 LLMError/provider-error
  -> V1 Processor / V2 SessionRunner
  -> 共享 SessionRetry（当前 5 次截止）
  -> 耗尽后终止，或现有 Goal 策略另外处理

V1 工具实际 execute
  -> 普通成功返回 SDK
  -> 由之后消费的 tool-result 调 completeToolCall
  -> 若先退出消费，普通成功不一定能走到该终态入口

V1 重试
  -> currentText/reasoningMap 内存引用被重置
  -> 只有部分异常入口调用 discardIncompleteAttempt
  -> 其他断连已经落库的推理 Part 可能保留
```

工具参数、模型结束和工具返回不作为三个恢复状态。此次唯一收尾前提是：当前消息所有已经交给执行器的可执行工具均已返回，结果或失败已保存。原始 network_error 检测本身保留，修正的是消费失败以后无条件重发原请求的动作。

旧推理残留的具体原因：`processor.ts:1092-1099` 重置内存 Map 不等于删除持久 Part；`processor-effect.test.ts:865-906` 只禁止拼成 `onetwo`，未禁止旧 `one` Part 留在消息中。

## 6. Supported Input Domain and Reachability

| 条件 | 生产者/入口 | 归属及处理范围 | 分类 |
| --- | --- | --- | --- |
| 响应头前、首块后、心跳后无进展超时 | provider timeoutFetch / HttpTransport | 保留原有 deadline；进入消息恢复，不调整时限 | observed |
| reset、socket/DNS/TLS、解压失败、嵌套 RetryError/cause | Bun/fetch/SDK，旧 fromError 白名单 | 旧最终分类原样保留 | contracted |
| 429、5xx、overload、限流、Cloudflare HTML | HTTP 或结构化错误 | 保留 Retry-After、来源指纹与限额动作 | contracted |
| partial text/reasoning + network_error/unknown/other | SDK/原生协议 | 未产生工具时清失败尝试并同消息重试 | observed |
| 已开始的本地/MCP/Workflow 工具与连接失败重叠 | 传入 tools.execute / Workflow callback | 等原调用终态后继续下一消息 | reachable |
| 完整调用与半截参数同轮出现 | tool-input 与 tool-call 事件 | 完整调用执行一次；碎片不执行、不保留悬挂输入 | reachable |
| Provider 托管工具没有结果 | providerExecuted 事件 | 沿既有 hosted-only 失败收尾，绝不本地执行或伪造成功 | contracted |
| 类型化或显式拒绝、用户取消、上下文溢出、输出上限 | 既有错误与时限 | 保留既有分类；未标记流事件的业务 code 按用户选择不作额外识别 | contracted |
| 已有有效 step-finish 后连接尾错 | StepFinish 消费者 | 沿一般完成/失败路径，不新增否决或专用测试；见用户明确澄清 | contracted |
| 原生压缩、原生审查的直接 LLM 暂时失败 | Core SessionCompaction / PermissionReviewer | 在各自现有边界共享重试，不能只依赖底层两次重试 | reachable |

## 7. Required Invariants

| ID | 可观察不变量 | 证据/验证 |
| --- | --- | --- |
| INV-01 | 旧最终策略认可的暂时故障不会因达到第 5 次而退出 | 旧策略、生产六次请求；T1 |
| INV-02 | 同一消息的正常结束和网络失败都先等其实际可执行工具收尾，再交接下一步 | 用户原文；T4/T5 |
| INV-03 | 无工具失败尝试清除文字、推理、未执行参数并复用 Message ID | 用户澄清、已有 removePart/Retried；T2/T3 |
| INV-04 | 有工具时不重发旧上下文；真实工具结果进入下一条消息的请求 | 用户澄清、既有 prompt/runTurn 循环；T4/T5 |
| INV-05 | Provider 断流不被当成用户取消原工具；主动停止仍及时生效 | 执行信号路径；T4/T7 |
| INV-06 | 已完成工具终态不被迟到的 SDK 事件/cleanup 改回 running/error | 现有 permit/终态写；T4/T6 |
| INV-07 | 类型化或显式原生拒绝、溢出保留既有资格；未标记 provider-error 按用户选择重试。旧 SDK false 下的 429/5xx/Cloudflare/OpenAI 404 特例保留 | 第 1 节后续原话、旧正负例；T1/T8 |
| INV-08 | 普通重试不新增 hidden；保留原 compact-cancelled marker/summary 隐藏及边界失效，不退款、不改 parentID 或撤回语义 | 用户原文、现有 compaction/boundary；T3/T8/T9/T12 |
| INV-09 | 普通工具错误、权限拒绝、三次失败熔断和图片/输出处理继续由现有 owner 负责 | 现有 complete/fail/doom loop；T6/T8 |
| INV-10 | 所有入口共用资格和退避；不会漏掉原生 carrier 或 reviewer/compaction caller | 调用点清单；T1/T5/T8 |
| INV-11 | 持久化失败不能被工具收尾集合吞掉后继续模型调用 | 保留结果提交及失败传播；既有隔离行为证据见第 23 节，不新增故障状态或专项测试 |

## 8. First Divergence and Root Cause

| 不变量 | origin | propagation / manifestation | owner |
| --- | --- | --- | --- |
| INV-01 | 共享 policy 的 attempt > 5 截止与旧最终语义不同 | 第六次暂时失败进入 halt；UI 显示超时 | Core SessionRetry.policy |
| INV-02/04/05 | 执行归属仍依赖 Provider 消费链：信号同源、结果主要由流回声写回；重试在工具真实收尾前就能决定重发 | 断流后可能取消工具、缺结果或重发旧请求 | V1 SessionProcessor 的执行/尝试收尾；V2 现有 turn finisher |
| INV-03 | 失败尝试删除只接在部分错误入口，其他入口仅清内存引用 | 已落库旧推理继续显示 | discardIncompleteAttempt / Retried owner |
| INV-07/10 | 原生 typed error 被降成普通 message，或 V2 policy parse 只放行两个内部 sentinel | 原生错误只能用底层有限重试，或丢 retryable/等待信息 | SessionRetry carrier 适配及两个会话 owner |

### 已运行的红色反馈

工作目录均为 `packages/opencode`，无文件写入、无外部模型请求。以下结果退出码 1 是特意表达原缺陷，不是验证通过。

```powershell
bun -e 'import { Effect, Schedule, Schema } from "effect"; import { SessionRetry } from "@opencode-ai/core/session/retry"; import { SessionV1 } from "@opencode-ai/core/v1/session"; const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(new SessionV1.APIError({ message: "SSE read timed out", isRetryable: true, responseHeaders: { "retry-after-ms": "0" } }).toObject()); const attempts = []; const exits = await Effect.runPromise(Effect.gen(function* () { const step = yield* Schedule.toStep(SessionRetry.policy({ provider: "fixture", parse: () => error, set: info => Effect.sync(() => attempts.push(info.attempt)) })); return yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.exit(step(0, error))); })); console.log(JSON.stringify({ attempts, stepExitTags: exits.map(x => x._tag) })); if (exits[5]._tag === "Failure") process.exitCode = 1;'
```

实测：`attempts=[1,2,3,4,5]`；后面三个 step 都为 Failure。约 2 秒完成，不等待退避定时器。

```powershell
bun -e 'import { Effect, Cause } from "effect"; import { LLMAISDK } from "./src/session/llm/ai-sdk"; const state = LLMAISDK.adapterState(); await Effect.runPromise(LLMAISDK.toLLMEvents(state, { type: "tool-call", toolCallId: "call_fixture", toolName: "probe", input: {} })); await Effect.runPromise(LLMAISDK.toLLMEvents(state, { type: "tool-result", toolCallId: "call_fixture", toolName: "probe", input: {}, output: "already-completed" })); const exit = await Effect.runPromise(Effect.exit(LLMAISDK.toLLMEvents(state, { type: "finish-step", finishReason: "other", rawFinishReason: "network_error", usage: {} }))); const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined; console.log(JSON.stringify({ finishStepExit: exit._tag, errorName: error?.name, errorMessage: error?.message })); if (exit._tag === "Failure") process.exitCode = 1;'
```

实测：完成工具已交付后仍抛 `ProviderResponseStreamError: Provider finish_reason: network_error`。该检测应保留；独立于工具收尾的“原请求重试”才是要修正的消费者行为。

### 已运行的方案假设实验

实际 AI SDK + `createOpenAICompatible` + `Bun.serve(127.0.0.1, port=0)`，只在内存使用工具闸门：发完整工具调用后维持 SSE，工具 started 后让 Response body error；按现有适配器消费到失败并关闭 transport controller。执行使用独立工具 controller，释放工具闸门后等待原 Promise。

实测输出：`beforeRelease={transportAborted:true,toolAborted:false,records:[started,stream-error]}`；释放后为 `[started,stream-error,completed]`、结果 `tool-proof`，`invariantHolds=true`。约 3 秒完成。服务故意断连打印了预期 fixture reset 错误，最终退出码 0。这验证的是取消归属和实际执行 Promise 收尾，不冒充完整 Session 持久化回放。

生产测量：截图这轮实际是首次加五次重试；每次 `chunkTimeoutMs=90000,chunkCount=0,bytes=0`，等待约 2.5/4.5/9/18/30 秒后第六次失败，`processor.end result=stop,durationMs=604332`。不是未捕获 SSE。

## 9. Responsibility and Seam

| 职责 | 唯一 owner / 接口 | 原因 |
| --- | --- | --- |
| 字节、连接、已有超时 | 现有 Provider transport | 不向会话泄漏 reader/心跳管理，不调整参数掩盖失败 |
| 资格及退避 | Core SessionRetry.retryable/delay/policy | V1、V2、reviewer 已共用；只在这里恢复无限次数 |
| 原生 carrier 表达 | 已有 LLMError / ProviderErrorEvent | 保留类型字段，不复制另一套异常体系 |
| V1 实际执行与结果 | SessionProcessor 传给 LLM 的工具回调包装、现有 completeToolCall/failToolCall | 工具表和 Message 都由该 owner 已经持有；不要求每个工具各自补恢复逻辑 |
| V1 消息唯一收尾 | SessionProcessor.process | 消费正常/失败均汇到一个收尾块；不用新的 Result 状态 |
| V2 消息唯一收尾 | SessionRunner 现有 awaitToolFibers 所在块 | 已有真实工具 FiberSet，直接修顺序，不添加第二份工具任务表 |
| 下一消息 | 现有 SessionPrompt / SessionRunner drain | 返回现有 continue / needsContinuation，不让 Goal 代替网络恢复 |
| 原生辅助请求重试 | Core SessionCompaction / PermissionReviewer 的现有 Provider 消费 | 直接 LLM caller 不经过普通 runTurn；在各自现有调用边界使用同一策略 |
| 权限、输出、审查、快照 | 当前各 owner | 包装执行不得绕过它们，也不得重写它们 |

## 10. Single Approved Primary-Path Design

本节为 R9 当前唯一主路径，按用户要求与已完成实现合并审阅；不以历史版本批准替代本次审批。

```text
一次 Provider 消费正常结束或失败
  -> 等当前消息实际执行的工具全部结束，结果/失败完成保存
  -> 成功：既有完成/工具续轮
  -> 不可恢复失败：既有停止/压缩/取消
  -> 可恢复且没有工具进展：删除失败尝试，同 Message 进入共享退避重试
  -> 可恢复且有工具进展：保留事实并关闭本 Message，既有循环创建下一 Message
```

### 10.1 `packages/core/src/session/retry.ts`

1. 保留 `RETRY_MAX_RETRIES` 及 policy 中的次数截止，值由 5 改为 `Number.MAX_SAFE_INTEGER`，实际会话中等效持续重试。
2. 保留现有 APIError/旧文本/429/5xx/Cloudflare/限额动作判定、jitter、Retry-After、30 秒和 30 分钟上限。指数计算在达到可用等待上限后饱和，不能无限指数溢出成 NaN。按用户撤回 H15，legacy 文本识别维持 HEAD 的较宽规则，不新增 HTTP 状态限制。
3. `Err`/policy parse 输入扩为现有 legacy error object、`LLMError`、`ProviderErrorEvent` 的 union；不新增 class。
4. 原生 LLMError 先按已有 context classification 与 retryable 判断；明确业务拒绝不被 message 正则翻成 true。旧 OpenAI 404 特例仅在同样的 provider 前缀、真实 404 且 InvalidRequest 分类下延续，不覆盖上下文/鉴权/策略拒绝。获得资格后不能直接返回 message，必须将真实 status/headers/body 通过既有 APIError 表达进入同一个 Free/Go 限额动作分支。delay 优先把原 retry-after-ms/retry-after 响应头交给同一个旧解析器，仅两种提示头均未提供时采用已有 retryAfterMs；不能让过期日期归一化的 0 绕开旧退避，也不重复解析日期。
5. ProviderErrorEvent 先保留 context-overflow 和显式 retryable=false 的既有语义，其余流错误统一可重试，包括缺省 retryable 的未知错误；不再要求各入口或正文正则再次放行。资格只有共享 owner 一处决定。
6. 所有原有普通错误负例、原有 V1 cause 解包规则继续保留，不在此另造 JSON/HTTP parser。按用户撤回 H16，不新增固定 JSON 文案分支；原来的通用识别和原 parseJSON 调用不变。
7. 在同一模块保留可复用的 `apiError(error: LLMError | ProviderErrorEvent)` 纯字段投影；增加共享 `fromError`，集中原生错误到已有 V1 错误类别的适配，MessageV2 只调用它。policy 的 parse 变为可选，默认直接识别原生 carrier；set 同时交付原有 APIError 数据，调用方不再重复拼装。无新错误类或第二次正文解析。

### 10.2 `packages/opencode/src/session/processor.ts` 的执行入口

在 `process` 把 `streamInput.tools` 交给 `llm.stream` 前统一包装其已有 execute。仍使用原工具定义、权限过滤、插件、schema 和执行函数，不逐工具重写业务逻辑，也不新增 Handle 公共方法。

- 包装回调在任何 await 之前同步登记本次真实执行，设置现有 hasToolCall；登记发生在工具自己的权限询问和异步日志之前。
- 消息内仅增加真实执行的 Promise 收尾集合和工具 AbortController。它们不是新的消息状态或重试器。
- 复用 ensureToolCall/updateToolCall 建立 running；实际执行结果的成功/失败均先用现有 completeToolCall/failToolCall 保存，再兑现回调给 SDK。普通工具失败仍作为原来的工具失败交给模型。
- ensureToolCall 的 callID 检查、Part 创建和 ctx.toolcalls 登记整个放进已有 toolPermit；移除创建子块原有的内层同一 permit，避免嵌套死锁。流事件和 execute 并发进入时只能取得同一条记录，不新增去重缓存。
- 跟踪 Promise 的普通工具失败是“已保存失败结果”的完成值；登记/终态持久化及必须完成的权限或熔断收尾失败则阻止续跑。统一等全部 Promise settled，再传播这种收尾失败，禁止吞掉后继续。Provider 消费的 cause-to-error 转换移入消费边界；收尾失败以 defect 跳过网络 retry，由 retry 外的既有 halt/cleanup 记录真实失败。
- SDK 收到原有返回值和异常，禁止归一化成另一种外部 Tool 输出；图片 proof、同步输入、权限审查 metadata、截断、shell partial 均继续由原函数处理。
- 工具使用消息所有的取消信号；Provider 连接的 Scope 退出只取消连接。主动停止在现有 onInterrupt 中先取消工具，再走原有取消收尾和 2 秒补偿合同，不进入下一轮。
- settleToolCall 不立即遗忘本次已终态调用；保留到本消息清理。晚到的 tool-call/result/error 对已终态本地调用不再改回 running，不重复终态或三次失败熔断。普通失败熔断仍在首次被接受的失败终态执行一次。
- 半截参数从不进入 execute 集合。Provider 托管调用不本地执行，沿既有 providerExecuted 记录和缺失结果失败合同收尾。

### 10.3 同文件 `process` 的单一收尾块

保留现有 `Result = "compact" | "stop" | "continue"`。将原来直接 `Stream.runDrain -> SessionRetry.retry` 改为捕获一次消费结果、统一等待执行结束、然后只在这里决定是否向共享 retry 抛错。

```ts
// 控制流定位示意；原有用户取消/压缩哨兵在各自已有分支传播。
const exit = yield* stream.pipe(Stream.tap(handleEvent), Stream.runDrain, Effect.exit)
// 此处等真实 execute，而不是 cleanup 为唤醒协调而调用的 Deferred.succeed。
yield* waitForRecordedExecutions()
if (Exit.isSuccess(exit)) return
const error = Cause.squash(exit.cause)
const retry = SessionRetry.retryable(toRetryCarrier(error), input.model.providerID)
if (!retry) return yield* Effect.failCause(exit.cause)
yield* discardIncompleteAttempt()
if (!ctx.hasToolCall) return yield* Effect.failCause(exit.cause)
ctx.assistantMessage.finish = "unknown"
// 不抛错：既有 cleanup 发布 completed，process 返回 continue。
```

示意中的等待操作在 process 内直接展开；`toRetryCarrier` 是被收尾判断和 policy parse 共同使用的私有输入适配，保留既有原生对象，否则调用原 fromError，不新增 parser。附录 B 给出定位 diff。用户取消必须传播原 Cause 并触发现有 onInterrupt，不能被 Effect.exit 吞掉后无限等工具。

- 原有 SessionRetry.retry 包装保持在该尝试外，parse 先保留原生 carrier，否则使用 MessageV2.fromError。halt 仍把最终错误投影为 V1 消息错误。
- 有工具的可恢复中断仅记录已有日志，设置既有 unknown 完成原因；不写整条助手 message.error，避免现有历史转换丢掉其工具结果。不伪造正常 stop 或 step-finish 用量。
- `SessionPrompt` 不增加重试分支、不新增 Result；现有 `continue` 会重新组装历史并在 `prompt.ts:1982` 创建下一助手。
- `ai-sdk.ts:88-90` 原始 network_error 检测保留。删除 Processor 只针对这一个错误字符串的清理特判，所有可恢复未提交失败由本块负责。
- 不为 finish/usage 后的尾部运输错误新增特殊规则。删除候选实现中的两处 finish 重试否决；parse 直接复用 toRetryCarrier，可重试故障沿同一失败尝试清理/退避路径，不直接向用户返回失败。既有 step-finish Part 和账本逻辑不改。

### 10.4 同文件 `discardIncompleteAttempt` / `cleanup`

- 无工具进展：用现有 session.removePart 删除 attemptPartIDs 中失败尝试的正文、推理、step-start；删除本次未执行工具参数 Part；清空对应 Map/缓冲/Part ID，助手 ID、parentID 不变。
- 有工具进展：删除仍未完成的 currentText、未关闭 reasoning 和未执行的输入碎片；保留已完成工具、失败工具及其配对结果、已经完成的上下文内容和已确认账单。未执行碎片若为同轮已声明调用的配对所需，沿现有工具错误结果合同记录“输入中断，未执行”，不得伪造成功或执行空参数。
- 仍由这同一个失败收尾操作处理 metadata：对失败尝试保留下来的 text/reasoning/tool Part，移除既有 MessageV2.providerMeta 会回放的 provider namespace。遍历仅限 attemptPartIDs 与本轮 toolcalls 的 Part ID，不扫历史；保留可见文本、callID、结果、Part.metadata 的 server primitive 及 ToolState.metadata（审查、截断、partial 等）。把现有 providerMeta 导出给该 owner 复用，不增加 failed/hidden 持久标志，也不另写下游补救分支。
- cleanup 只在上述实际执行屏障后进行正常终态发布和快照收尾，不以“唤醒了 Deferred”冒充真实工具已完成。
- 不改 hidden，不隐藏整个 Message；同 ID 的 Part 删除事件继续驱动现有 UI。

### 10.5 `packages/opencode/src/session/llm.ts` 的 Workflow 回调

现有 Workflow toolExecutor 在调用真实工具前先 await timing 日志。将该非业务日志改为现有 bridge.fork 的异步记录，使包装后的 execute 在第一次业务 await 前立即被调用、登记。保留日志字段及实际业务返回值。该改动只封闭一个已存在的异步登记空窗，不增加 Workflow 专用重试。

其他 V1 AI SDK/原生适配器继续接收同一工具回调；native-runtime 无需复制执行登记。

### 10.6 `packages/core/src/session/runner/llm.ts`

- 复用已有 toolFibers 和 awaitToolFibers，不另建 Promise 集合。一次尝试的 Provider 结果和工具结果在已有统一收尾处合并后才决定恢复。
- 将裸 Provider 消费外的 retry 调整为包住这个尝试收尾；Provider 消费、工具等待和退避仍通过现有 restore 保持可取消。
- policy parse 只保留已有工具不可重放的边界和 incomplete、outputLength 两个 sentinel 的原有语义额度，最后把本轮原始 carrier 交给共享策略；删除新增的 stepSettlement 否决及 publicationFailed 跟踪。正常失败/成功、普通工具异常仍使用既有结算，不增加持久化故障产品合同。
- 消费 provider-error 时先保留原事件作为本轮失败，不在工具尚未收尾时发布整条助手失败；收尾及外层 parse 均取 overflowFailure ?? 后续错误，不能一处取原事件、另一处改取随后 reset。复用现有变量，不新增错误缓存或末端特判。
- 无工具的可恢复失败：使用现有 failAssistant(discardIncompleteAttempt=true) 和 publisher.retry；删除该分支新增的 stepSettlement 条件。`message-updater.ts:446-455` 已直接清内容并复用助手，无需 hidden 或新投影事件。
- 有工具的可恢复失败：等实际工具及持久终态，保存真实失败与已确认用量，返回现有 `{ needsContinuation: true, canContinueGoal: false, step: currentStep }`。现有 drain 自然进入下一轮，工具不重放。
- 原生失败助手的工具事实已经由 to-llm-message 保留，失败原生 metadata 不复用。不为此修改历史转换器。
- 非重试 provider-error、权限拒绝、用户停止、上下文溢出、输出上限、已有 Goal continueOnError 保持既有含义；不以 Goal 人工注入消息实现网络恢复。

### 10.7 `packages/core/src/session/compaction.ts`

在现有 `compactAfterOverflow` 的一次摘要消费外使用同一个 SessionRetry.retry，不让暂时错误先到 `catchTag("LLM.Error")` 被自动压缩转换成 false。

- Compaction.Started、messageID、startedEventID、terminalEventID、原历史选择和提交动作保持在重试之外，只创建一次。每次 Effect.suspend 内创建局部 chunks 并重新调用 dependencies.llm.stream；失败尝试自然释放，不显式清空共享前缀，不重读历史。
- provider-error 一到现有消费边界就用原事件失败并交给共享策略，不保存在中间变量继续读流。这样明确的 context-overflow/不可重试语义不会被后续 reset 覆盖，也删除原 failed 布尔值。最终不可重试的 provider-error 仍返回现有 false；最终 LLMError 仍按原规则在 manual 传播、auto/overflow 返回 false，不制造成功摘要。
- step-finish 为 unknown 时，在确认 usage 前转换成与普通 owner 相同语义的既有 InvalidProviderOutputReason 哨兵；policy.parse 先把该哨兵映射到可重试 APIError，再处理一般原生 carrier。空的正常 stop 仍沿现有不可用摘要处理，不扩大协议语义。
- 删除新增的 usage.stepCount 重试否决，不为已完成尾错另建合同。Started/Ended/Failed 的同一身份和既有退出保护保持不变；不修改账本 owner。
- 成功后才执行原有 todos/FileEvidence/Compaction.Ended。重试中不提交新压缩边界、不隐藏消息；取消与现有 Provider 时限继续生效，不增加辅助请求的第二套配置或时限。
- set 使用 Effect.void：原生压缩没有独立重试 UI 合同，不为接线新造状态事件；资格、等待及限额识别仍来自共享策略。

### 10.8 `packages/core/src/permission/reviewer.ts`

在 `runReviewerAttempt` 中，把现有 request 构造、client.stream、工具选择协商、事件消费及 assessment 解码放进可重新订阅的 Effect.suspend，并在其外、现有 timeoutOrElse 之前使用共享 SessionRetry.retry。

- 每个网络尝试局部声明 assessment、textOutput；inputEstimate 不清空，由下一次真实 onPrepared 覆盖，失败前未完成 compile 时保留此前估算。forced/toolChoice 每次从既有 toolChoiceRejectedProviders 读取，已完成的 typed400 协商不因网络重试重复开启。
- reviewerRequestID/Synthetic/publisher 仍由同一次协议尝试拥有。这里只声明和记录 permission_review_decision，没有外部工具执行；有效审查结果只在 review 返回后由既有 owner 应用。
- provider-error 在丢成 Failed.reason 之前进入共享策略；先以原事件失败，网络重试结束后才映射回现有 Failed，其他错误身份不改变。protocolError、timedOut 不获得网络资格。
- 删除新增的 stepSettlement 重试否决和入口 parse 分类。获准时 set 复用 publisher.failAssistant(discardIncompleteAttempt=true)、failUnsettledTools 和 publisher.retry，依次关闭已流式落盘的残片/声明输入；不触发 MessagesHidden。retry 的 error 直接取共享 policy 交付的原有 APIError 数据，不把 next/action 塞进公共事件。
- 现有 timeoutOrElse 必须包住网络重试及退避整体，每个协议尝试仍只有原 120000ms 或配置值，不能因一次网络重试续期。其后的 onExit、协议错误隐藏和三次 attempt(index) 完整保持；网络错误不消耗或重置协议/超时额度。
- 现有显式人工回退/拒绝只在原 deadline、非重试错误或协议额度真正结束后发生；网络暂时失败期间父工具保持原 reviewing 状态。既有 protocol-retry 的专用隐藏合同不扩展到网络重试。

### 10.9 旧 tailmarker / compact 中断处理：复用，不新增实现

该部分已逐项对照 `dev-smark` 最终代码和当前代码，现有 owner 已保留，不加入新的 marker 生命周期。

- 此处 marker 指携带 Compaction Part/tail_start_id 的压缩 user 消息。V1 run 预分配 parentID，非成功 continue 的退出统一调用 hideIncomplete；同一次未提交压缩的 marker 和 summary 使用同一时间戳、reason=compaction-cancelled 隐藏。已完成且无错的 summary 不被取消后的可选操作反向隐藏。
- 不必清空持久 tail_start_id，也不另造 marker-hidden 字段。现有 filterCompacted/visibleCompactions 同时验证 marker、summary 与 Compaction Part 的可见成功配对；任一侧隐藏，整对不能裁剪或进入 Provider 历史。
- 现有 CompactionBoundary.latest 在 SQL cutoff 确定前排除该隐藏对，继续选更早合法边界；不能只在 UI 或最后 visible() 才过滤。普通 tail 内一条用户撤回消息隐藏时，仍保留其结构 ID 定位能力，不错误撤销另外一个成功 Compaction。
- hard exit 来不及运行 finalizer 时，未配对成功的 marker 也不能生效。原 tail 选择继续排除 hidden/pending/errored 锚点；recent_user_messages 继续排除 hidden、synthetic、ignored 和压缩 marker。
- 普通 Provider 重试仍在同一摘要助手内清失败 Part，不重跑 compaction.run、不另建 marker。真实取消或最终 stop 仍由原 run.onExit 隐藏整对；不能把 marker 用户消息传给普通失败 Part 删除器。
- V2 原生没有先追加可裁剪的 scratch marker：只有原 Compaction.Ended 才追加成功 compaction 消息并改变边界。保留该既有表示，不为“对齐”复制 V1 hidden 字段；R4 的网络包装必须在 Ended 之前，不允许失败尝试提交边界。

这些函数的生产 diff 为 0；只保留并运行回归。用户此次明确了已有收益的验收，不是授权重写压缩算法、tail 预算或用户撤回机制。

## 11. Secondary and Replacement Path Inventory

| 路径 | 分类 | 产生何种结果 | 处置 |
| --- | --- | --- | --- |
| 无工具同消息重试 / 有工具下一消息 | 同一个消息恢复合同的状态分支 | 真实重新请求 / 真实任务续轮 | 保留，唯一主路径 |
| APIError / LLMError / ProviderErrorEvent | 主合同的已有输入适配 | 相同资格与退避 | 复用，无新 parser |
| V1 / V2 会话 owner | 已存在的产品入口 | 相同收尾不变量 | 都修，不能互相依赖 |
| transport 已有交付前有限重试 | 既有已发布合同 | 没有工具副作用的 HTTP 重发 | 不新增、不提升为会话恢复 owner |
| reviewer 协议重试、Goal continuation | 既有产品合同 | 原有明确策略 | 不扩张、不借用作故障回退 |
| 原生压缩/审查的网络重试 | 同一共享合同的现有直接 caller | 真实摘要/裁决恢复，提交和期限仍由原 owner 管理 | 补齐，不复制策略 |
| 网络失败日志 | diagnostic | 不改变结果 | 复用；新增日志最多 1 个决策路径 |
| 网络失败新增 hidden 替身、备用 Provider、换模型、重新提示继续 | forbidden fallback | 会产生另一套成功途径 | 不引入；不包含既有 compact 取消/审查协议隐藏 |

预估修改决策面 22-30 项，诊断最多 1 项，占比不超过 4.55%。新增 alternate success path 为 0。

## 12. Workaround Deletion and Replacement

| 位置/重复职责 | 处理 |
| --- | --- |
| policy 五次截止 | 按用户逐项选择保留判断，上限改为实际不可达的 Number.MAX_SAFE_INTEGER |
| Processor 针对 raw network_error 字符串的单独清理 | 合并到统一尝试收尾 |
| 仅清 reasoningMap 而未删失败持久 Part | 改为对应 removePart，不另写 hidden |
| SDK 回声可以重新启动已终态本地 ToolPart | 加既有终态判断，终态只接受一次 |
| 正常工具结果必须等 Provider 消费链才能保存 | 实际执行回调先保存；流回声复用同一幂等终态入口 |
| V2 只放行两个内部错误的 parse | 保留语义额度分支，补现有原生 carrier，不复制重试循环 |
| 流/execute 双入口并发创建 ToolPart | 修复既有 ensureToolCall 的原子检查-创建-登记，不叠加 callID 去重表 |
| 带工具失败轮仍保留 opaque provider metadata | 在同一个失败收尾点剥离该尝试的 provider namespace，保留真实工具及可见内容 |
| 原生重试提前只返回 message | 进入既有 APIError 共同分支，继续产生 Free/Go 动作 |

## 13. Forward Traceability

| 要求 | 生产路径 | 修改位置 | 测试 |
| --- | --- | --- | --- |
| 无限次数、退避、旧分类全保留 | 所有 policy consumer | core/session/retry.ts | T1/T8 |
| 单一工具收尾后决策 | V1、V2 | processor.ts / runner/llm.ts | T4/T5/T6 |
| 无工具清失败前缀、同 ID | V1 removePart、V2 Retried | processor.ts；复用 message-updater | T2/T3 |
| 有工具携结果下一轮 | Prompt/drain | 原有 continue / needsContinuation | T4/T5 |
| 不混淆取消 | 实际 execute 回调与原有中断 | processor.ts，Workflow 登记顺序 | T4/T7 |
| 不吞持久化失败/不回滚终态 | 工具完成 owner | processor.ts / 现有 V2 publisher | T6 |
| 普通重试不新增 hidden、保持用量/撤回 | Part 删除及原消息身份 | processor.ts / 原生现有投影 | T3/T9 |
| 不缩减权限/熔断/语义额度 | 既有工具与 reviewer | 不另行改动策略 | T6/T8 |
| 原生辅助调用获得同一恢复收益 | Core compactAfterOverflow / runReviewerAttempt | 在现有错误兜底与期限内接共享 retry | T10/T11 |
| 失败 compact 的 tailmarker 不生效，成功 tail 保留 | V1 hideIncomplete → MessageV2 / SQL cutoff；V2 仅 Ended 提交 | 原 owner 无生产 diff，保留既有回归及隔离证据 | T12、C35/C36 |

## 14. Reverse Traceability

| 新增或变更概念 | 对应不变量 | 为什么不能只复用现状 |
| --- | --- | --- |
| 共享策略的已有原生 carrier union | INV-07/10 | 现状会丢 retryable/headers，V2 直接拒绝大多数错误 |
| V1 实际执行 Promise 收尾集合 | INV-02/11 | 当前 Deferred 能被 cleanup 主动唤醒，不证明真实 execute 结束 |
| 消息所属工具取消信号 | INV-05 | 当前 Provider Scope 退出会连带取消原工具 |
| 私有统一 execute 包装 | INV-02/06/09 | 能覆盖传入工具而不在本地/MCP 每个实现复制生命周期 |
| 保留本轮终态工具登记至收尾 | INV-06 | 当前删除登记后晚到回声可能创建新的 pending Part |
| Workflow 首 await 前登记 | INV-02 | 已有日志 await 能使工具进入时点晚于该消息收尾快照 |
| V2 拓宽已有失败 carrier / 调整 retry 包装范围 | INV-02/04/10 | 现有 retry 位于真实工具等待之前，且 parse 只认可两个 sentinel |
| 既有登记入口扩大 permit 范围 | INV-02/06 | 新执行回调与流事件可并发，旧检查在锁外不能保证唯一 Part |
| 失败尝试剥离 provider namespace | INV-04/08，CONTEXT.md:135 | 不设置整条错误后，原投影仍会回放失败轮 opaque 凭据；在源头清除，保留工具事实 |
| apiError 纯字段投影 | INV-07/10，C24/C25 | 原生字段需进入现有限额动作、等待及 Retried/V1 投影，单独返回 message 会丢收益 |
| 删除候选实现的确认后停止条件 | 第 1 节最新澄清 | 旧 dev-smark 没有该产品限制；复用一般失败路径，不为低概率尾错增加分支和测试 |
| 原生辅助调用的共享包装及 scratch reset | INV-03/10，C34 | 两个 caller 不经过 runTurn，且复用失败 text/assessment 会污染下一尝试；只在原 owner 内接线 |

不新增运行时模块、公开状态、持久化字段、配置或依赖。tailmarker、hidden 配对和 SQL 边界是旧 owner 已满足的合同，不是新增 production concept；它们没有新的反向映射项或修补分支。

## 15. File-Level Change Plan

用户现已授权实施本表。仅纳入本任务改动；当前并行的用量报告字段及相应测试保持原样，不纳入本任务提交。

| 文件 | 操作 | 函数及准确职责 | 预计有效代码 |
| --- | --- | --- | --- |
| `packages/core/src/session/retry.ts` | modify | retryable/delay/policy：极大次数上限、保留旧判定、共享原生错误适配、有限等待饱和 | 45-75 |
| `packages/opencode/src/session/processor.ts` | modify | create/process：统一执行收尾；ensureToolCall 原子登记；settle/handleEvent：回声幂等；discard：清内容并剥离失败尝试续接凭据 | 115-180 |
| `packages/opencode/src/session/llm.ts` | modify | Workflow toolExecutor：移除实际登记前的日志 await，仅改变观测调度 | 2-5 |
| `packages/opencode/src/session/message-v2.ts` | modify | fromError：复用共享投影并保留具体拒绝类别；导出原有 providerMeta 供失败收尾使用 | 16-31 |
| `packages/core/src/session/runner/llm.ts` | modify | runTurn 尝试：现有工具等待后统一恢复；扩大 policy carrier 输入；保留语义额度及用量 | 65-110 |
| `packages/core/src/session/compaction.ts` | modify | compactAfterOverflow：新订阅、清 scratch、共同资格/退避；保留已确认用量和单次压缩提交 | 50-80 |
| `packages/core/src/permission/reviewer.ts` | modify | runReviewerAttempt：期限内网络重试、清 scratch、重用已有 publisher；外层协议额度不变 | 35-65 |
| `packages/opencode/test/session/retry.test.ts` | modify | 分类、无限次数、延迟上限及原生错误负例 | 50-85 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | 无工具前缀清理、工具仍在执行的真实断连、一次终态、基础设施失败 | 100-160 |
| `packages/opencode/test/session/prompt.test.ts` | modify | 公开 prompt 下一消息携带结果、无 Goal 时恢复、权限拒绝 | 60-100 |
| `packages/core/test/session-runner.test.ts` | modify | 同一语义的原生工具/无工具恢复、取消、用量 | 80-130 |
| `packages/core/test/session-runner-tool-events.test.ts` | modify | 原生终态及事件顺序的公共接口回归 | 20-40 |
| `packages/opencode/test/lib/llm-server.ts` | modify | 现有 reset fixture 在写出 head 后尊重已有 wait 闸门，再销毁连接 | 5-10 |
| `packages/core/test/session-compaction.test.ts` | modify | 原生 auto/overflow/manual 真正消费失败后恢复；内容和提交不污染 | 30-60 |
| `packages/core/test/permission.test.ts` | modify | 原生真实审查入口恢复、总期限和协议额度、fail-closed 不变 | 40-70 |

不修改 `tools.ts` 中具体业务执行，不修改 ai-sdk 原始 network_error 检测，不为恢复修改 Prompt Result 或历史转换接口。当前 reset fixture 忽略 Item.wait，不能可靠证明“工具已启动后才断连”；只补其已有 wait 字段的执行顺序，不新增独立服务器框架。

`session/compaction.ts` 的 marker/hideIncomplete、`message-v2.ts` 的 tail 过滤与 Core `compaction-boundary.ts` 保持原行为；不为补写 tailmarker 文档修改这些函数。其既有 `test/session/compaction.test.ts`、`test/session/message-v2.test.ts` 列为保留回归，不新增重复测试框架或同义用例。

## 16. TDD Behavior Slices

拟定测试 seam 为现有 SessionPrompt.prompt、SessionV2.prompt/resume、SessionCompaction 的 compact/compactAfterOverflow、Permission.Service.ask 及公开 messages/status/event 接口；纯策略补充测 SessionRetry 的已导出接口。测试使用本地真实 HTTP、临时测试工具和现有原生运输边界 fixture，不访问用户业务数据库。该 seam 在实施前的批准版中冻结。

| ID/顺序 | Red 行为及现状缺口 | Green 及独立验收值 |
| --- | --- | --- |
| T1 | 暂时失败超过五次后仍应能得到成功；当前第六次截止 | 七次失败后第八次给固定回复 `recovered`；最终成功、没有终止错误，退避和取消可观察 |
| T2 | text/reasoning 后真实 reset、超时、raw network_error、unknown | 原 Message ID；最终只有 `recovered`，明确断言旧 `one`/partial 不存在，不仅禁止 `onetwo` |
| T3 | 只给半截工具参数就断流；失败尝试没有实际 execute | 工具测试记录为空；碎片被移除；原 Message ID 恢复；hidden 未变化 |
| T4 | 完整工具 started 后用闸门阻止完成，再真实断开 SSE | 工具不被 Provider 断流取消；闸门释放后记录恰好一份真实副作用；下一请求含原 callID/结果，新助手 ID |
| T5 | V2/原生适配器复现 T2/T4，使用 typed failure 与 provider-error | 不依赖 Goal；已有工具不重放；未知非重试错误保持停止 |
| T6 | 工具完成回声迟到、并行一成一败、普通错误三次 | 一个调用只有一个终态，熔断仍一次；不因审计增加数据库故障专项测试 |
| T7 | 退避和等工具时用户停止；工具自身超时 | 用户停止不自动恢复；工具时限仍由原工具处理，正常失败结果可供下一轮使用 |
| T8 | 分类 golden matrix 与上下文/输出/Reviewer/权限规则 | 旧正负例全保留；明确原生 false 不重试；64 KiB 语义单次额度、拒绝、Reviewer deadline 不被放宽 |
| T9（既有回归） | 正常用量结算、失败清理、用户撤回、托管工具缺结果 | 保留既有结算/隐藏/真实工具合同；按用户澄清不为 stop/usage 后断连新增专用测试 |
| T10 | Core 压缩暂时 LLMError/provider-error 超过五次后成功；partial unknown 后恢复；明确上下文错误帧后连接再断开 | auto/overflow/manual 均只有成功摘要进入原提交边界，旧 prefix 不在最终摘要；Started/Ended 同身份；未成功前旧上下文不变；明确拒绝不被后续运输故障改成可重试 |
| T11 | Core 审查暂时 LLMError/provider-error 后成功、退避中耗尽 deadline、协议错误 | 实际 ask 得到恢复后的裁决；不提前转人工/拒绝；网络重试不续期、不消耗协议三次额度、不隐藏网络失败 |
| T12（保留回归） | 既有 compact 取消、隐藏 marker/summary/part、普通 tail 撤回；此行不要求正确的旧实现先变红 | 失败压缩对不可见且不裁剪，采用前个成功边界；普通隐藏 tail 不复活旧 head；V2 失败/取消不提交 Ended；原 tokens/cost 保留 |

首轮审查对应的确定性回归补充：

- B-01：一般 LLMError 之前分别验证 unknown 恢复和输出上限首次恢复/第二次停止，不能仅验证一般 TransportReason。
- B-02：用公开 PartUpdated 的 inline observer 闸门阻塞首次登记通知，使流事件与 execute 同时进入；释放后从公开消息历史验证同 callID 恰好一个 Part、一个终态、一个真实副作用。
- B-03：本地 OpenAI Responses fixture 先结束带 itemId/encryptedContent 的 reasoning，再发完整工具调用并断流；下一请求保留可见推理和原工具结果，但不含失败轮 item reference、encryptedContent 等 provider namespace。server-owned 审查/partial 事实不丢。
- B-04：原生 429 的 FreeUsageLimitError、GoUsageLimitError 分别验证完整 action 对象、工作区链接和实际等待提示；与 legacy carrier 使用同一字面量期望值。
- 原 B-05 的确认后停止与专用成对测试承诺在 R7 撤销，依据第 1 节用户最新澄清；不删除正常用量的既有回归。
- B-09：T1/T8 的旧日期断言同时给 native/legacy 相同原头；过期、非法或空提示沿旧退避，显式 0 仍为 0；没有原提示头时保留 native 毫秒值。使用固定 random=0 和已过期的字面量日期，不修改全局时钟、不复制日期解析。

每次一个纵向 slice：先观察当前缺陷的红色行为，再最小修复，再跑相关回归。工具“只执行一次”测的是临时测试工具写出的可观察记录，不 mock 私有方法或数内部 helper 调用。HTTP 请求内容使用 fixture 的公开 capture seam，验证结果实际交付而非只验证请求数量。

## 17. Chinese Comment Budget

当前实现统计及独立复算见第 23 节；门禁仍按实际 E 要求 `C >= max(1, ceil(E*0.15))`。历史预计区间不代替当前结果。

解释分布在：实际 execute 与流回声的差别、网络取消/用户停止归属、持久化失败不能吞掉、已确认用量不撤回、未执行参数不得调用、同消息/下一消息恢复的唯一判定，以及测试闸门/独立期望值。不得用复述赋值或重复测试标题凑数。

## 18. Verification

当前方案阶段：生产日志/只读 DB、两个真实导出函数红色命令和本地 SDK 取消归属实验已执行。早先源码探针因 workspace 模块解析失败未启动；之后解析恢复，两个正式红色探针已真实运行并得到第 8 节结果，不再把旧缺依赖列为当前阻塞。

2026-11-06 首轮修订隔离验证：在 `packages/opencode` 执行 `bun -e`，仅内存构造已有 RateLimitReason/HttpContext，将真实 429 status、headers、body 投影为已有 SessionV1.APIError，再调用实际 SessionRetry.retryable/delay。FreeUsageLimitError 得到完整 `free_tier_limit/subscribe/https://opencode.ai/go` 动作；GoUsageLimitError 得到完整 `account_rate_limit/open settings/https://opencode.ai/workspace/fixture-workspace/go` 动作；两者均按 `retry-after: 7` 返回 7000ms，退出码 0。该实验验证复用旧分支的收益，未把尚未实现的原生端到端路径宣称为通过。

R3 准入隔离验证：同目录 `bun -e` 使用实际 SessionRetry.policy/Schedule.toStep，向其 parse 传入本方案否决表达式。同一个可重试 SSE APIError 在 `confirmed=false` 时得到 `scheduleExit=Success,retryPublished=true`；在 `confirmed=true` 时得到 `scheduleExit=Failure,retryPublished=false`，退出码 0。验证了否决发生在调度与 Retried 副作用之前；完整 Anthropic 会话回放仍属于 T9，尚未实施。

2026-11-06 tailmarker 保留验证：同目录 `bun -e` 调用实际 MessageV2.filterCompacted，合成 head/tail/marker/summary/after 五条内存消息。正常返回 `[marker,summary,tail,after]`；分别隐藏 marker、summary、二者或 Compaction Part，均返回 `[head,tail,after]`；仅普通 tail 因 undo 隐藏时返回 `[marker,summary,after]`。六例退出码 0，证明失败对不裁剪，普通 tail 隐藏不会反向复活已压缩 head。

同次 SQL 入口验证使用 `bun:sqlite` 的 `:memory:` 和当前 `drizzle({ client: raw })` 绑定，调用实际 CompactionBoundary.latest。内存表放置前后两个成功压缩对：正常选择 `{messageID:msg_new,tailStartID:msg_tail_new}`；新对的 marker/summary/both/part 任一隐藏均选择旧对 `{messageID:msg_old,tailStartID:msg_tail_old}`。五例退出码 0。两项只验证当前未修改 owner，不写业务数据库、不声称完整会话恢复 Green，也不为其非生产记录追加单独审计。

R5 两项接线验证：同目录 `bun -e` 调用现有 SessionEvent.RetryError 的 Schema.decodeUnknownOption，原 `{message,next}` 因缺少 isRetryable 被拒绝，修正的 `{message,isRetryable:true}` 被接受；同一命令让真实 Effect Stream 先发 context-overflow ProviderErrorEvent、再排入连接错误，消费边界立即 Effect.fail(event) 后观察到的 cause 仍为原事件，后续运输失败未覆盖它。退出码 0，仅内存运行。该实验验证既有类型和 Effect 传播，不替代 T10/T11 的完整入口测试。

R6 原生等待适配隔离验证：同目录 `bun -e` 构造实际 LLMError/RateLimitReason/HttpContext，再将真实响应头交给现有 SessionRetry.delay，random=0。10 例均通过，退出码 0：过期日期为 2000ms，第八次同一过期日期为 256000ms；秒/毫秒显式 0 均为 0；123ms/7 秒分别为 123/7000ms；非法/空日期为 2000ms；无原提示头及只有其他响应头时均保留 native 250ms。仅候选适配在内存中，旧日期/等待实现未复制；未将完整入口宣称 Green。

实施后由下列命令验证，当前并未实施，不宣称这些测试通过：

| 命令 | 工作目录 | 证明 |
| --- | --- | --- |
| `bun test test/session/retry.test.ts` | `packages/opencode` | 旧分类、无限次数、等待边界 |
| `bun test test/session/processor-effect.test.ts test/session/prompt.test.ts` | `packages/opencode` | 真实 Session 的清理、执行、取消、下一请求 |
| `bun test test/session-runner.test.ts test/session-runner-tool-events.test.ts` | `packages/core` | 原生会话同等语义及事件/用量 |
| `bun test test/session-compaction.test.ts test/permission.test.ts` | `packages/core` | 两个原生辅助 owner 的恢复、期限及原有提交/审查合同 |
| `bun test test/session/compaction.test.ts test/session/message-v2.test.ts` | `packages/opencode` | 保留 compact 取消隐藏、有效 tail 和原历史过滤的既有合同 |
| `bun test test/session/llm.test.ts` | `packages/opencode` | Provider timeout、原始 network_error 检测未回退 |
| `bun typecheck` | 分别 `packages/core`、`packages/opencode` | 新 carrier/执行包装不靠 any 或类型抑制 |
| `bun run lint` | 仓库根，使用既有脚本 | 相关代码质量；不自动格式化其他人的修改 |
| 第 8 节两个红色命令 | `packages/opencode` | 上限探针转绿；适配器仍抛错的检测探针保留为特征测试，完整会话恢复测试转绿 |

原事件 schema 未改，不运行 SDK 生成，不修改生成文件。最终必须重新运行原始场景的最小等价 HTTP fixture，而不是等待真实 Provider 连续 90 秒。外部服务可用性仍由实际 Provider 决定，方案只保证正确恢复和等待。

## 19. Diff Budget

| 项目 | 预计 | 理由 |
| --- | --- | --- |
| 新运行时文件/依赖/配置/迁移/生成文件 | 0 | 复用已有 owner 和 carrier |
| 修改生产文件 | 7 | 共同策略、两个会话 owner 及直接调用 LLM 的原生辅助 owner |
| 修改测试/fixture 文件 | 8 | 现有公共 seam，补齐辅助入口与 reset/wait，不新增测试框架 |
| 生产有效行 | 328-546 | 统一收尾、已有状态修正及两个缺失 caller 的共享接线 |
| 测试/fixture 有效行 | 385-655 | 真实失败序列、辅助恢复、审查期限及兼容负例 |
| R9 当前阶段 | 已完成实现及验证 | 方案与实际任务 diff 一起审阅；不另开实施前方案审计 |

预算是审查信号，不授权省略已确认入口，也不授权无关重构。若实现需要越过这些模块，先回到本文件说明证据并重新完整审查，不静默扩大范围。

## 20. Real Risks and Open Decisions

- V1 真实执行屏障保留已有结果提交失败的传播，不扩展为跨入口的发布失败状态或专项数据库故障验收；Core 不新增 publicationFailed 标志。
- 实际执行登记必须早于异步等待；Workflow 已存在前置日志 await，需要封闭这一具体空窗。
- 必须保护迟到 SDK 回声，否则执行回调提前落库后可能被重建成 running。
- 历史转换丢弃 V1 整条错误助手，所以可恢复带工具消息不能简单交给 halt 再让 Goal 继续。
- 保留既有正常结算回归；按用户最新澄清，不为已完成之后的尾部断连增加产品限制、专用状态或测试。
- 旧分支最早解除次数限制的独立提交号未确认；最终分支无限语义及当前截止已经直接验证，不依赖该提交号。

### Open Decisions Requiring the User

恢复方式已由用户澄清：等工具收尾；无工具失败内容直接丢弃，同消息重试；普通网络恢复不新增 hidden，原 compact 取消的 marker/summary 隐藏保留。当前没有待用户决定的恢复分叉；用户已授权实现、验证及提交。

### Rejected Speculation

不设计跨进程 exactly-once、外部命令内容去重、Provider token 续传、自动切模型、关闭 TLS 校验、网络特定 Provider 分流或新的 retry 配置。这些都不是本次已证明的修复需求。

## 21. Audit Contract

独立审查读取原始用户要求、本文件和必要仓库证据，覆盖全部受影响入口及不变量。验证主路径可实施性、真实 execute 收尾归属、取消/终态/用量、旧分类完整性、普通重试无新增 hidden/fallback、类型与中文注释门禁；不能因修订缩小行为范围，也不重复扫描未受影响的代码。

阻塞问题必须给出生产者、执行链、代码/方案位置、可观察后果和最小根源修复。审查只读，不修改工作区。只有影响生产语义的实质修订才递增版本、清除审批并重审；编号、引用、估算、既有正确行为的证据补录不单独触发审计。R4 的送审原因是 B-06 两个直接 LLM caller 的实质接线；R5 是修正该接线的事件合同和错误优先级，不是 tailmarker 的零生产改动记录；最多 6 轮完整方案审查。

## 22. Plan Audit Record

| 轮次 | 版本 | 完整范围 | Blocking | Non-blocking | 结论 | 调用引用 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1（原编号 R2，仅编号校正） | 是 | B-01、B-02、B-03、B-04 | 无 | BLOCK | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 2 | R2（四项实质修复） | 是 | B-05；B-01 至 B-04 已解决 | 无 | BLOCK | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 3 | R3（已确认 step 准入否决） | 是 | B-06；B-01 至 B-05 已解决 | 无 | BLOCK | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 4 | R4（原生辅助 owner 接线） | 是 | B-07、B-08；B-06 入口已补齐 | 无 | BLOCK | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 5 | R5（既有事件合同与即时错误传播） | 是 | B-09；B-01 至 B-08 已解决 | 无 | BLOCK | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 6 | R6（复用旧日期等待语义） | 是 | 无；B-01 至 B-09 已解决 | 无 | APPROVE | `ses_e535bc0a8ffexgNIniHc8OdlN3` |
| 用户澄清后 1 | R7（删除候选限制） | 是 | B-01：未标记 invalid_prompt 获得资格，与旧合同冲突 | 旧 R6 字样残留 | BLOCK | `ses_e4fc9e420ffeh5R70bSkQrA38z` |
| 用户澄清后 2 | R8（用户明确接受未标记流错误重试） | 是 | No blocking findings. | “R7 方案修订阶段”版本文字残留，已行政校正 | APPROVE | `ses_e4fbf196fffeJZFI6CqFxwnJNp` |

R8 release verdict 原文：

> **APPROVE — 仅放行本次完整审计的 R8 方案。**
>
> Canonical plan：`docs/plans/sse-retry-recovery.md`
>
> Plan blob：`b17ece2c7aa96608ce4e30908c6a69a553b6a3e2`
>
> 源码 HEAD：`72c2142d47f0e5fe560f74ab3b61fe853924ebd6`，同时核对了当前相关工作树内容。
>
> 本结论是方案放行。当前候选实现尚需按 R8 完成、验证，并通过独立完整实现审计。

R7 release verdict 原文：**BLOCK — 仅针对本次审查的 R7 方案。** Plan blob：`17bbf81a425b10c639dfd9f07b79ccb32eafd81d`；源码 HEAD：`72c2142d47f0e5fe560f74ab3b61fe853924ebd6`；阻塞项：**B-01**。该项已交给用户作上述明确选择；R8 不为其增加实现，仅同步用户授权例外并重新送审。

审查结论由主 agent 原样记录。Implementation allowed 按 workflow 表示技术放行，User implementation authorization 独立记录当前执行授权；下列审查原文中的“未授权”保留审计当时状态，当前用户已明确要求实现并提交。

按用户纠正，首轮审计前各次草稿统一记为 R1。首轮审计输出中的“R2”是当时的原编号，下面保留原文，不改写独立结论；本次行政编号校正不触发审计。后续只有实质设计修订才递增版本并重审。审计员应复用本次已读且未变化的相关证据，保持完整需求覆盖，不扫描无关模块。

### 首轮独立结论原文

审计原方案 blob：`e3227717fadcc1903330378a8154f395c224f21d`；源码 HEAD：`321a3ffeddc22a6c9ffe14d876fe35a3f5dadc62`。

**R2 审查结论：BLOCK，共 4 项阻塞。**

**B-01 通用原生错误分支截断了既有的语义重试**

- Violated invariant: INV-07、INV-09；`unknown` 完成恢复及输出上限的一次重试额度必须保留。
- Evidence class: reachable
- Producer and execution path: V2 在未知完成或输出超限时产生 `incomplete`、`outputLength`。两者都是 `LLMError`，其 `InvalidProviderOutputReason.retryable` 为 `false`。附录 B.5 新增的通用 `LLMError` 返回分支位于哨兵处理之前，因此共享策略直接拒绝重试，原有转换为可重试 APIError 的代码不再执行。
- Source evidence: `packages/core/src/session/runner/llm.ts:486-493,549-552,607-615`；`packages/llm/src/schema/errors.ts:135-146`；现有行为测试见 `packages/core/test/session-runner.test.ts:1054-1078,1153-1169`。
- Canonical-plan evidence: §10.6 声称保留语义额度，但附录 B.5 的实际分支顺序与其冲突：`docs/plans/sse-retry-recovery.md:810-814`。
- Responsibility owner: V2 SessionRunner 的 policy 输入适配。
- Concrete behavioral consequence: 无工具的未知完成立即失败；首次超出 64 KiB 的输出也失去既有的一次恢复机会。
- Minimal correction direction: 在 V2 输入适配中先保留两个已知哨兵的资格和额度处理，再处理一般原生 carrier。

**B-02 新增并发登记入口会为同一调用创建两个 ToolPart**

- Violated invariant: INV-02、INV-06；一次真实工具调用必须对应一个登记和一个持久终态。
- Evidence class: reachable
- Producer and execution path: AI SDK 转发工具事件后独立启动 execute，不等待 Processor 完成事件落库。方案让流事件和 execute 包装同时调用 `startToolCall`，而它原样复用的 `ensureToolCall` 在许可外检查记录、在许可内创建 Part、退出后才登记到 `ctx.toolcalls`。首次 PartUpdated 尚未返回时，另一入口仍可读到“未登记”，随后创建第二个 Part。
- Source evidence: `node_modules/ai/src/generate-text/run-tools-transformation.ts:276-277,328-351`；`packages/opencode/src/session/processor.ts:485-528`；`packages/opencode/src/session/session.ts:652-659`。事件发布会等待 inline listener，见 `packages/core/src/event.ts:415-428`，因此上述交错并未被同步合同排除。
- Canonical-plan evidence: §10.2、附录 B.2 新增 execute 登记，且明确将现有 tool-call 登记原样提取复用：`docs/plans/sse-retry-recovery.md:680-681,710-720`。
- Responsibility owner: SessionProcessor 的唯一工具登记入口。
- Concrete behavioral consequence: 两个 Part 具有同一 callID，内存登记只保留其中一个；另一 Part 留在持久历史中，后续终态写入和 cleanup 无法完整覆盖，下一请求可能携带重复调用及孤立的中断结果。
- Minimal correction direction: 在现有登记入口内原子完成 callID 的检查、创建和登记，让事件与 execute 共享同一记录。

**B-03 V1 恢复路径会复用失败轮的原生续接元数据**

- Violated invariant: 仓库规定原生续接元数据仅用于成功且模型匹配的 Provider Turn；失败轮不得复用。
- Evidence class: reachable
- Producer and execution path: OpenAI Responses 可以先完成带 `itemId`、加密续接内容的 reasoning，再发出本地工具调用，之后断流。方案保留已经结束的 reasoning，将助手设为 `finish="unknown"`，同时明确不写 `message.error`。现有 V1 历史转换对同模型 reasoning 直接保留其 provider metadata，下一请求因此继续携带失败轮的原生续接凭据。
- Source evidence: 合同见 `CONTEXT.md:135`；元数据生产见 `packages/llm/src/protocols/openai-responses.ts:660-685,865-877`；已结束 reasoning 退出开放集合见 `packages/opencode/src/session/processor.ts:476-482`；V1 回放见 `packages/opencode/src/session/message-v2.ts:947-972`；原生协议会据此构造 reasoning 或 item reference，见 `packages/llm/src/protocols/openai-responses.ts:285-302,405-408`。
- Canonical-plan evidence: §10.3 不写整条助手错误，§10.4 保留已完成上下文；附录 B.3 仅设置 unknown：`docs/plans/sse-retry-recovery.md:268-276,744-746`。方案未给出失败轮元数据的清理路径。
- Responsibility owner: V1 失败尝试收尾与历史交接边界。
- Concrete behavioral consequence: 新恢复请求将失败轮的 opaque 状态当作可续接凭据发送，违反现有回放合同；V2 已有的失败元数据隔离也没有覆盖这条 V1 路径。
- Minimal correction direction: 在 V1 失败收尾中保留工具事实和可见内容，同时剥离该失败尝试不可复用的原生续接元数据。

**B-04 原生 carrier 提前返回，绕过旧有限额恢复动作**

- Violated invariant: INV-10、C24/C25；旧机制的限额提示、动作及等待收益必须到达受支持入口。
- Evidence class: reachable
- Producer and execution path: 已支持的 opencode 原生入口收到 HTTP 429、正文含 `FreeUsageLimitError` 时，RequestExecutor 将其构造成可重试的 `RateLimitReason`。附录 B.1 对所有可重试 `LLMError` 直接返回 `{ message }`，因此永远不会进入现有 Free/Go 限额动作分支。
- Source evidence: 原生入口支持 opencode provider，见 `packages/opencode/src/session/llm/native-runtime.ts:60-65`；HTTP 429 分类见 `packages/llm/src/route/executor.ts:248-257`；既有限额动作见 `packages/core/src/session/retry.ts:108-154`，行为断言见 `packages/opencode/test/session/retry.test.ts:395-456`。
- Canonical-plan evidence: 附录 A 的 C24/C25 明确要求保留动作合同；附录 B.1 却提前返回：`docs/plans/sse-retry-recovery.md:560-561,594-599`。
- Responsibility owner: Core SessionRetry 的原生输入适配及共同分类路径。
- Concrete behavioral consequence: 原生模式虽继续重试，却丢失订阅动作、工作区链接及相应限额说明，无法满足“旧机制收益全部保留”的要求。
- Minimal correction direction: 在保留明确原生拒绝优先级后，让符合资格的原生 HTTP carrier 复用现有限额动作和原因归一化分支。

Non-blocking findings: 无其他需要单列的非阻塞项。

**BLOCK — 仅针对本次审查的 R2。**

实施授权：仍为 **no**。B-01 至 B-04 修订后，需要对新版本重新进行完整范围审查。

### R2 实质修订对应关系

| 首轮阻塞 | 本次根源修订 | 对应位置 |
| --- | --- | --- |
| B-01 | sentinel/语义额度优先于一般原生 carrier | §10.6、附录 B.5 |
| B-02 | 原有 ensureToolCall 内原子完成检查、创建、登记 | §10.2、附录 B.2 |
| B-03 | 同一失败收尾点剥离该尝试可回放的 provider namespace | §10.4、附录 B.3/B.4 |
| B-04 | 原生适配后复用现有 APIError 限额动作分支 | §10.1、附录 B.1 |

### 第二轮独立结论原文

**B-05 V1 的“已确认 step”判断仍会把错误交回重试，无法阻止重放**

- Violated invariant: §10.3 明确要求有效 `step-finish` 确认的内容和用量不得重放；T9 必须保留该边界。
- Evidence class: reachable
- Producer and execution path: 原生 Anthropic 在 `message_delta` 中发布 `step-finish` 和 `finish`，此时运输流仍可继续读取。无工具情况下，Processor 已保存正文、用量并设置 `assistantMessage.finish`；随后连接重置产生可重试的 `TransportReason`。附录 B.3 的 `finish && !hasToolCall` 分支执行 `Effect.failCause`，但它仍位于共享 retry 内，因此错误再次被接纳并重发原请求。
- Source evidence: `packages/llm/src/protocols/anthropic-messages.ts:880-890,936-940`；`packages/llm/src/protocols/utils/lifecycle.ts:80-99`；`packages/llm/src/route/client.ts:279-294`；`packages/llm/src/route/transport/http.ts:208-218`；确认落库及外层重试见 `packages/opencode/src/session/processor.ts:823-844,1179-1191`。
- Canonical-plan evidence: 不重放约束见 `docs/plans/sse-retry-recovery.md:280`；实际分支见 `:851-855`；policy 输入适配仍仅透传原生 carrier，见 `:867`，没有已确认状态的重试否决。
- Responsibility owner: V1 SessionProcessor 的统一收尾及重试准入边界。
- Concrete behavioral consequence: 已确认的请求仍被再次发送；旧确认内容没有删除，恢复结果又写入同一助手，产生额外正文、确认步骤和 Provider 消费。移除次数上限后，该分支也失去原来的五次截止。
- Minimal correction direction: 在 V1 重试准入处真正阻止已确认 step 的重放，保留其内容和用量，并沿既有收尾路径结束该尝试。

Non-blocking findings: 无。

首轮四项阻塞已在当前设计中解决：

| finding | 本轮核对结果 |
| --- | --- |
| B-01 | 两个语义哨兵先于一般原生 carrier 处理，见方案 `:945-965` |
| B-02 | ensureToolCall 的检查、创建、登记统一纳入原有许可，并移除内层重复许可，见 `:758-768` |
| B-03 | 同一失败收尾清除当前尝试的 provider namespace，保留工具状态和服务端事实，见 `:883-895` |
| B-04 | 获准重试的原生 HTTP 错误进入既有 APIError 限额动作分支，见 `:697-703` |

**BLOCK — 当前 R2，剩余阻塞 B-05。**

- 方案 blob：`5bb3868aac26756e6cb3efb73aa182c2d88628f9`
- 源码 HEAD：`321a3ffeddc22a6c9ffe14d876fe35a3f5dadc62`
- 本轮未修改任何文件；实施授权仍为 **no**。

B-05 修订后需要对实质更新后的方案进行完整范围审查。

### R3 实质修订对应关系

仅针对 B-05，在 V1 policy.parse 增加已确认 step 的非重试准入；继续复用原 finish/hasToolCall，不新增状态、不改正常工具收尾。原始 cause 仍交 halt，确认结果不删，T9 同时覆盖确认后停止与未确认时继续重试。

### 第三轮独立结论原文

**B-06 原生 compaction 和 Reviewer 仍未获得旧机制的共享重试收益**

- Violated invariant: 用户要求旧重试机制的收益完整保留；INV-10、C34 已明确包含 compaction、Reviewer 和 V2 Native，但方案只覆盖了它们的 V1 对应入口。
- Evidence class: reachable
- Producer and execution path: V2 自动压缩、溢出恢复和手动压缩调用 Core SessionCompaction。其直接消费 `dependencies.llm.stream`；暂时性 LLMError 在自动模式下转为 `false`，手动模式下直接传播，均不经过计划修改的 SessionRunner 普通回合重试。原生权限审查直接消费 `client.stream`。Provider 错误直接终止审查；外层三次额度仅处理协议错误和超时，不处理暂时性 Provider 错误。之后进入已有人工审批或拒绝路径。两者剩余的网络重试只有底层 RequestExecutor 的有限重试。
- Source evidence: `packages/core/src/session/compaction.ts:296-333`；`packages/core/src/session/runner/llm.ts:411,634,817`；`packages/core/src/permission/reviewer.ts:155-165,188-214,229-236`；`packages/core/src/permission.ts:134,227,411`；`packages/core/src/permission/auto.ts:99-117`；`packages/llm/src/route/executor.ts:37,361-371`。
- Canonical-plan evidence: 证据清单仅列 V1 对应入口，见 `docs/plans/sse-retry-recovery.md:102-103`；§10.6 修改普通 V2 Provider Turn，见 `:297-305`；§15 未包含两个 Core owner，见 `:371-383`；完整保留承诺见 INV-10 `:169`、C34 `:704`。
- Responsibility owner: Core SessionCompaction 与原生 PermissionReviewer 各自的 Provider 调用边界。
- Concrete behavioral consequence: 普通会话恢复后，原生压缩仍会因短暂断流或 503 提前失败；原生自动审查也会在现有 deadline 尚未耗尽时提前转人工审批或拒绝。旧入口具备的自动恢复收益没有完整迁移到新设计。
- Minimal correction direction: 让两个现有原生 owner 在自身调用边界复用共享资格与退避，保留审查期限、协议额度和压缩提交边界，并补充实际入口的行为测试。

Non-blocking findings: 无。

**B-01 至 B-05 均已在当前方案中解决。**

**BLOCK — 当前 R3，剩余阻塞 B-06。**

- 方案 blob：`9d40ba84c5899512445a63c35a541bec122e4672`
- 源码 HEAD：`321a3ffeddc22a6c9ffe14d876fe35a3f5dadc62`
- 实施授权仍为 **no**。

B-06 修订后，需要对实质更新后的方案进行完整范围审查。

### R4 实质修订对应关系

B-06 对应两个已经存在的直接 LLM caller；本次在其现有调用边界接共享策略，不增加恢复器。原生压缩保留同一提交身份、失败只清 scratch；原生审查把网络重试放在既有期限内，保留协议三次额度、工具选择协商和最终 fail-closed 路由。具体 owner、diff 和 T10/T11 已列入本规范。

### 第四轮独立结论原文

```text
## Blocking findings

**R4 仍有两项阻塞，均来自新增原生辅助入口的具体接线。**

### B-07 原生 Reviewer 向 publisher.retry 传入了错误的数据结构

- Violated invariant: 必须复用现有 Retried 事件合同，不新增公共字段；网络重试必须能通过现有发布接口继续审查。
- Evidence class: contracted
- Producer and execution path: 原生审查发生可重试错误 → SessionRetry 调用 `set` → 方案调用 `publisher.retry`，传入 `{ message, next, action }`。该参数需要的是 `SessionEvent.RetryError`，其中 `isRetryable` 为必填字段，`next`、`action` 不属于该结构。
- Source evidence: `packages/core/src/session/runner/publish-llm-event.ts:234-237`；`packages/schema/src/session-event.ts:422-432`。
- Canonical-plan evidence: 附录 B.8，`docs/plans/sse-retry-recovery.md:1246-1251`。
- Responsibility owner: Core PermissionReviewer 的重试发布接线。
- Concrete behavioral consequence: 该 DIFF 无法满足 `publisher.retry` 的参数类型和既有事件合同，首次进入网络重试时不能按方案完成 Retried 发布。
- Minimal correction direction: 向 `publisher.retry` 传入符合现有 RetryError 合同的数据，等待时间和动作继续由共享 policy 的既有接口管理。

### B-08 原生压缩会让后续断连覆盖已经明确的不可重试错误

- Violated invariant: INV-07、C08；明确的上下文溢出等 Provider 语义不能被后续运输错误重新赋予重试资格。
- Evidence class: reachable
- Producer and execution path: 原生 Anthropic 先交付被分类为 `context-overflow` 的 error 帧，随后连接重置。方案只将原事件保存到 `failed`，继续读取；后续断连产生可重试的 Transport LLMError。用于传播 `failed` 的 `Effect.flatMap` 只在消费成功时执行，因此此时跳过它，policy 收到的是运输错误，下一次尝试又清除了原 `failed`。
- Source evidence: Provider 错误分类见 `packages/llm/src/protocols/anthropic-messages.ts:902-908`；该协议没有配置提前终止谓词，见 `:936-940`；继续读取和错误传播见 `packages/llm/src/route/client.ts:279-294`；断连转换见 `packages/llm/src/route/transport/http.ts:208-218`。
- Canonical-plan evidence: 附录 B.7 中记录后继续消费、仅在成功出口传播原事件，见 `docs/plans/sse-retry-recovery.md:1182-1188`；准入适配直接接纳后续 LLMError，见 `:1193-1199`。
- Responsibility owner: Core SessionCompaction 的 Provider 事件消费边界。
- Concrete behavioral consequence: 已经明确拒绝的压缩请求被再次发送；若每次错误帧后都发生断连，该请求会进入无限重试，失去原有上下文错误的停止语义。
- Minimal correction direction: 原生压缩收到 provider-error 时就在现有消费边界传播原事件，让共享策略先判断该语义，避免后续运输故障覆盖它。

## Non-blocking findings

无。

B-01 至 B-05 的修订继续成立。B-06 指出的两个遗漏入口已经补入 §10.7、§10.8 和文件计划；新增接线仍受 B-07、B-08 阻塞。

## Rejected speculation

- 不要求重写压缩算法、tail 预算、用户撤回或 marker 生命周期。
- 不要求跨进程 exactly-once、命令去重、备用 Provider 或新的重试管理器。
- 未把编号、引用、预算估算或既有正确行为的证据补录作为重审理由。

## Requirement and traceability coverage

本轮覆盖 R4 全部有效设计、DIFF、7 个生产修改区域、8 个测试/fixture 修改区域及直接相关调用链。已核对新 HEAD 的变化，相关重试源码未变，沿用前轮直接读取的证据。

| 要求范围 | 结果 |
|---|---|
| 无限重试、指数退避、旧分类及限额动作 | 共同策略路径和 T1/T8 已覆盖 |
| 工具统一收尾、唯一登记、终态幂等 | V1/V2 路径及 T4/T6 已覆盖 |
| 无工具清失败内容、有工具携结果续轮 | removePart / Retried / Prompt / drain 已覆盖 |
| 已确认 step 不重放、取消与权限额度 | 原修订保留；Reviewer 发布接线存在 B-07 |
| 原生 compaction、Reviewer 恢复 | owner 和测试已补齐；压缩错误优先级存在 B-08 |
| tailmarker、取消隐藏及边界失效 | 复用现有 owner 的方案成立，无需新增生产逻辑 |

tailmarker 部分已直接对照旧分支与当前代码：V1 `hideIncomplete` 隐藏同次未完成 marker/summary，历史过滤与 SQL cutoff 排除失效压缩对；普通隐藏 tail 仍保留结构定位。对应当前源码见：

- `packages/opencode/src/session/compaction.ts:806-873`
- `packages/opencode/src/session/message-v2.ts:1455-1553`
- `packages/core/src/session/compaction-boundary.ts:21-79`

本轮未运行 Bun 测试、typecheck 或文档中的隔离实验，未修改文件。上述阻塞分别依据明确接口合同和可达执行链建立。

代码质量与中文注释：方案承诺按实际改动达到 15% 中文解释注释目标，预计 `E=713–1201、C=107–181` 可满足该承诺。当前仅文档，实际 **E=0、C=0，C/E=N/A**；无关工作区修改不计入。

## Primary-path and fallback verdict

主路径继续复用共享分类与退避，工具收尾、原生辅助请求和压缩提交各归原 owner，没有发现新增 fallback。

当前两个阻塞均可在既有接线处直接修正，无需增加状态机、公共事件字段或其他恢复路径。

## Release verdict

**BLOCK — 当前 R4，阻塞项为 B-07、B-08。**

- 方案 blob：`d8563f2bdee8dc909eff65372e698d545c674c40`
- 源码 HEAD：`7e8ad09c3b7b71f7dc2310a6da79585e0c54c284`
- 实施授权仍为 **no**。

两项涉及生产语义，修订后需要对更新后的方案进行完整范围审查。
```

### R5 实质修订对应关系

只修正两处既有接线：Reviewer 传原 RetryError 的必填 isRetryable，不增加 next/action 公共字段；Compaction 收到 provider-error 就失败传播，删去 failed 中间状态，避免运输故障覆写明确语义。主恢复路径、工具收尾、tailmarker、期限和压缩提交边界均不扩张；隔离验证见 §18，生产入口回归见 T10/T11。

### 第五轮独立结论原文

```text
## Blocking findings

### B-09 原生错误的过期 Retry-After 日期会被当作零等待，绕过指数退避

- Violated invariant: 用户要求保留旧机制的指数退避收益；C26 明确规定过期 HTTP 日期应回到原退避。
- Evidence class: reachable
- Producer and execution path: 原生 Provider 返回暂时性 429/5xx，`Retry-After` 为已过期的 HTTP 日期。RequestExecutor 将该日期归一化为 `retryAfterMs=0`，同时保留原响应头。方案新增的原生 delay 分支先读取这个 `0` 并立即返回，不再经过既有 HTTP 日期有效性判断。
- Source evidence: 日期归一化见 `packages/llm/src/route/executor.ts:94-105,254,276,290`；LLMError 暴露该值，见 `packages/llm/src/schema/errors.ts:186-187`；旧策略仅接受未来日期，否则进入指数退避，见 `packages/core/src/session/retry.ts:64-78`。现有独立断言见 `packages/opencode/test/session/retry.test.ts:96-99`。
- Canonical-plan evidence: C26 见 `docs/plans/sse-retry-recovery.md:885`；提前接受原生 `retryAfterMs` 的分支见 `:963-965`。
- Responsibility owner: Core SessionRetry.delay 的原生输入适配。
- Concrete behavioral consequence: 同一过期日期在 legacy 路径按指数退避，在原生路径变成零等待。移除次数上限后，持续返回该响应的 Provider 会被无额外退避地反复请求。
- Minimal correction direction: 在共享 delay 的原生适配中保留旧 HTTP 日期有效性语义，避免将过期日期归一化出的 `0` 当成服务端显式零等待。

## Non-blocking findings

无。

**B-01 至 B-08 在当前设计中已解决。** 本轮核对确认：

- Reviewer 已传入现有 `{ message, isRetryable: true }` 合同，见方案 `:1334-1337`。
- Compaction 已在消费边界立即传播 provider-error，并删除中间 `failed` 状态，见 `:1261-1269,1291-1293`。
- 原生辅助入口、确认后不重放、工具原子登记及失败元数据隔离的既有修订均保留。

## Rejected speculation

- 不要求新的重试管理器、配置、错误类型或备用 Provider。
- 不要求重写 tailmarker、压缩算法或用户撤回机制。
- B-09 对应已支持的 HTTP 日期输入和现有测试合同，不涉及假设性的异常数字或额外防御。

## Requirement and traceability coverage

本轮覆盖 R5 全部有效设计、DIFF、7 个生产修改区域、8 个测试/fixture 修改区域及相关调用链。相关源码未变化，复用前轮直接读取的证据。

| 要求范围 | 结果 |
|---|---|
| 无限次数及指数退避 | 次数限制修复成立；原生日期等待存在 B-09 |
| 旧错误分类、cause 解包、Cloudflare、限额动作 | 共同策略及 T1/T8 已映射 |
| 工具统一收尾、唯一登记、终态幂等 | V1/V2 路径及 T4/T6 已覆盖 |
| 无工具清失败尝试、有工具携结果续轮 | removePart / Retried / Prompt / drain 已覆盖 |
| 取消、权限、语义额度、确认用量 | 既有边界与相应测试设计保留 |
| 原生 compaction、Reviewer | 接线、期限、错误优先级及 T10/T11 已覆盖 |
| compact 取消隐藏、tailmarker 失效 | 复用原 owner，T12 保留回归，无新增生产逻辑 |

本轮未运行 Bun 测试、typecheck 或文档中的隔离实验，未修改任何文件。B-09 由现有生产者到新增 delay 分支的可达链建立。

代码质量与中文注释：方案继续复用既有 owner 和合同，承诺按实际改动达到 15% 中文解释注释目标；预计 `E=713–1201、C=107–181` 可满足承诺。当前仅文档，实际 **E=0、C=0，C/E=N/A**；无关工作区修改不计入。

## Primary-path and fallback verdict

恢复主路径和责任归属保持统一，未发现新增 fallback。剩余问题位于现有共享 delay 的输入适配，可直接复用已保留的原始响应头及旧日期判断修正，无需扩展恢复架构。

## Release verdict

**BLOCK — 当前 R5，剩余阻塞 B-09。**

- 方案 blob：`8a4af5aa8b2b98ed61d8a0a522d6e8149a2cc58a`
- 源码 HEAD：`7e8ad09c3b7b71f7dc2310a6da79585e0c54c284`
- 实施授权仍为 **no**。

该项涉及实际退避语义，修订后需要对更新后的方案进行完整范围审查。
```

### R6 实质修订对应关系

B-09 不新增日期规则：原始提示头优先复用原 delay；仅提示头缺省时保留 native 毫秒值。保留显式零等待与原日期退避的区别，不修改 LLM 底层运输策略，不新增 parser、配置或 caller；验证见 §18 的十个内存用例。

### 第六轮独立结论原文

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。B-01 至 B-09 均已在当前 R6 方案中解决。

## Rejected speculation

未将跨进程 exactly-once、命令内容去重、备用 Provider、token 续传或新的 marker 生命周期列为要求；未因编号、引用、估算及既有行为的证据补录增加阻塞。

## Requirement and traceability coverage

本轮覆盖原始需求、R6 全部有效设计与 DIFF、7 个生产修改区域、8 个测试/fixture 修改区域及直接相关调用链。相关源码未变化，复用了前轮直接读取的证据。

| 要求 | owner 与验证映射 |
|---|---|
| 无限重试、指数退避、旧分类及限额动作 | Core SessionRetry；T1/T8 |
| 正常与失败统一等待真实工具终态 | V1 Processor / V2 SessionRunner；T4–T7 |
| 无工具清失败尝试、有工具携结果续轮 | removePart / Retried / Prompt / drain；T2–T5 |
| 确认用量不重放、原生元数据隔离、权限与语义额度 | 现有消息及工具 owner；T6/T8/T9 |
| 原生压缩、Reviewer 的网络恢复和既有期限 | Core SessionCompaction / PermissionReviewer；T10/T11 |
| compact 取消隐藏、tailmarker 失效及成功边界保留 | 原 hideIncomplete、历史过滤和 SQL cutoff；T12，无新增生产逻辑 |

B-09 的修正已核对：原始提示头存在时复用旧 delay 解析；仅提示头缺省时采用原生毫秒值，保留过期日期退避与显式零等待的区别。见 `docs/plans/sse-retry-recovery.md:1036-1043`，对应现有 owner `packages/core/src/session/retry.ts:52-82`。

正向需求映射和反向概念映射完整；测试设计通过公开消息、事件、真实工具记录和下一请求内容观察行为，能够区分原缺陷与恢复结果。

## Primary-path and fallback verdict

**通过。**

共享策略统一负责资格与等待，各会话和辅助请求 owner 负责收尾、持久化及继续执行。无工具同消息重试与有工具下一消息属于同一恢复合同的状态分支。

未发现新增 fallback、重复解析器、第二套重试管理器或责任外移。诊断决策面估算符合预算。

## Code quality and Chinese-comment verdict

**方案阶段通过。**

设计复用已有接口、状态和提交边界，没有新增公共 Protocol 字段、持久字段、配置或依赖。实际实现仍须接受类型、风格及代码质量检查。

中文注释承诺为：

`C >= max(1, ceil(E × 0.15))`

预计 `E=713–1201、C=107–181` 可满足目标。本轮只有文档，实际 **E=0、C=0，C/E=N/A**；文档及无关工作区修改不计入实现统计。

## Release verdict

**APPROVE — 仅批准本次审查的 R6 方案。**

- Canonical plan：`docs/plans/sse-retry-recovery.md`
- 方案 blob：`0429bfa64800748f5c9100177f4ea97235bae0e2`
- 源码 HEAD：`7e8ad09c3b7b71f7dc2310a6da79585e0c54c284`
- 用户实施授权：仍为 **no**

本轮未修改文件，未执行 Bun 测试、typecheck 或重放文档实验。取得实施授权后，仍须执行计划规定的 TDD、回归验证及独立完整实现审计。
```

批准后仅行政记录结论与执行授权，R6 设计未变化，不递增版本或再次送审。实施前核对的并行改动只补充 step-start/finish 用量报告及测试，没有改变 finish 的重试准入、实际工具收尾或取消合同；实现将保留这些现有改动。

## 23. Implementation Evidence（R9）

### Actual Files and Diff

实际 diff 覆盖 7 个生产文件和 5 个测试/fixture 文件，未改 Protocol、公共 API、配置、迁移或生成代码：

```text
packages/core/src/permission/reviewer.ts                  34 + / 18 -
packages/core/src/session/compaction.ts                   59 + / 39 -
packages/core/src/session/retry.ts                        69 + /  9 -
packages/core/src/session/runner/llm.ts                   50 + / 33 -
packages/core/test/permission.test.ts                     40 + /  6 -
packages/core/test/session-runner.test.ts                104 + / 25 -
packages/opencode/src/session/llm.ts                       2 + /  1 -
packages/opencode/src/session/message-v2.ts               13 + /  3 -
packages/opencode/src/session/processor.ts               169 + / 72 -
packages/opencode/test/lib/llm-server.ts                   4 + /  1 -
packages/opencode/test/session/processor-effect.test.ts  140 + / 40 -
packages/opencode/test/session/retry.test.ts              90 + /  3 -
```

`processor.ts` 与 `processor-effect.test.ts` 同时包含任务前已存在的 token-accounting hunks；实施前快照为 `D:\Temp\opencode\sse-preexisting-worktree-20261106.patch`（19 行生产、7 行测试），这些 hunks 不属于本 GOAL，提交时必须排除。`message-v2.ts` 中 execute child 回放 hunks 也属于并行改动；本 GOAL 只拥有 `providerMeta` 导出和 `fromError` 原生错误映射。

### Red-Green Test Evidence

Red 证据在实施前或初版实现上实际出现：

- `policy continues beyond five transient failures` 只记录到第 5 次，证明 `RETRY_MAX_RETRIES` 截断违反旧机制。
- 原生 quota/refusal 映射曾降级为 `UnknownError`，Cloudflare/429/5xx/OpenAI 404 的共享分类不能进入原 Free/Go 与等待逻辑。
- V1 原生断流初版曾吞掉普通工具 defect；Core 全量曾出现 `unexpected tool defect`，随后用真实工具边界回归固定。
- 原生手动压缩初版在 7 次 transient provider-error 后不能提交成功摘要；现由同一 Started/Ended 身份和第 8 次成功摘要覆盖。
- 原生 Reviewer 初版遇 provider-error 立即 `Failed`；现通过网络恢复、deadline 共享及协议三次额度测试固定。

Green 证据见下一节；这些测试同时覆盖旧机制的无限次数、指数退避、Cloudflare、429/5xx、OpenAI 404、连接重置/拒绝/DNS/超时文本、工具真实收尾、取消和 compact tailmarker 保留语义。

R8 新增 red/green：既有共享测试对 `provider request failed` 得到 undefined；既有原生会话测试提前得到 stopped。修改共享默认资格后，两者转绿，原手动压缩七次失败/第八次成功 fixture 也改用同一未标记错误并通过。删除四个入口的候选确认否决、compaction 的 providerFailure 转换；runner parse 复用原始 carrier，未增加新状态。既有永久失败投影/Goal fixture 补显式 retryable=false，原断言不变；没有增加完成后尾错测试。

第二轮实现审计返工：原生运输 fixture 保持真实 native dispatch 与实际工具执行，先交付带 itemId 的 tool-call，新增断言实际观察到持久 metadata 从 `{openai:{itemId:"fc_1"}}` 变成 `{}`。修复只在既有 startToolCall 的 metadata 展开前保留 match.metadata 一行，测试转绿。原 SSE 工具闸门用例扩展至真实 SessionPrompt.loop，检查新助手、下一 HTTP 请求的原 callID/结果，以及持久和 wire 均无失败 itemId。V1 扩展用例在同一 HEAD 隔离下也 red（工具被断流取消，副作用记录为空），当前 green。随后新增的 Core/V1 保存失败专项测试及 Core publicationFailed 标志均按用户要求撤回；这些历史实验不再构成 R9 的生产合同或新增覆盖义务。

R9 收敛：次数常量/判断保留、值改为安全整数极值；H15/H16 恢复 HEAD；原生错误分类从 MessageV2 移入共享 fromError，policy 默认直接识别原生 carrier，set 直接提供原错误数据。Reviewer/压缩的失败输出改用尝试局部变量，Reviewer 估算不清零。Core 删除 publicationFailed、retryErrorForAttempt 及其依赖分支，复用原发布锁和旧结算。生产原始 diff 共新增 396 行、删除 175 行，含并行内容与纯移动，不新增第八个生产文件。

V1 保存失败的隔离行为证据已在专项测试撤回前实际取得，用户随后完整贴回了执行记录：在 packages/opencode 执行 `bun test test/session/processor-effect.test.ts --test-name-pattern 'real tool result cannot be saved'` 得到 **1 pass / 0 fail / 4 expect**，同次 `bun typecheck` 通过。测试只拦真实 completed ToolPart 的 updatePart，保留 running、原错误收尾及后续成功 Provider 回复作为陷阱；返回 stop，未消费下一回复。随后 `SSE_BASELINE=v1-no-save-guard` 配合 `--preload D:\Temp\opencode\sse-head-baseline-preload.ts` 仅在内存移除 processor 的失败检查，同一测试由 stop 变 continue 而失败。该实验已验证现有 V1 屏障的失败退出；之后移除的是测试及 spyOn 导入，processor 这条生产路径未改动。用户要求不把该实验继续作为持久专项测试 hunk 保留，不等同于该分支没有运行过行为验证。

### Verification Commands and Results

- `packages/opencode`：`bun test test/session/retry.test.ts test/session/processor-effect.test.ts` → **133 pass / 0 fail / 399 expect**（R9 当前代码）。
- `packages/opencode`：`bun typecheck` → 通过。
- `packages/core`：`bun test test/session-runner.test.ts test/session-runner-tool-events.test.ts test/session-compaction.test.ts test/permission.test.ts` → **132 pass / 0 fail / 1605 expect**（R9 当前代码）。
- `packages/core`：`bun typecheck` → 通过。
- `packages/llm`：`bun test test/executor.test.ts --test-name-pattern "identified Cloudflare"` → **1 pass / 44 expect**，Cloudflare 分类仍由上游 RequestExecutor 负责。
- `packages/opencode`：`bun test test/session/compaction.test.ts test/session/message-v2.test.ts test/session/llm.test.ts` → **188 pass / 1 skip / 0 fail / 666 expect**。
- `packages/opencode`：`bun test test/session/prompt.test.ts` → **125 pass / 15 skip / 1 fail**，失败为 `refreshes queued Permission, Tool definition and MCP in one continuation`，断言旧名 mcp_mutate，但并行 Code Mode 提供 tools.mcp.mutate。用 `D:\Temp\opencode\sse-head-baseline-preload.ts` 将全部七个生产文件通过 Bun loader 替换为 HEAD 内容（只在内存、不改工作区）后，单独运行该用例仍以同一断言失败。测试输出已明确列出全部 HEAD baseline 模块；不把该无关失败改绿。
- prompt 整套两次外部命令时限不足后，延长的只是 shell 命令生存期，未修改测试自身 timeout。Reviewer 503 恢复单例曾因 10 秒时限失败；当前原码及 HEAD 隔离复跑均通过（当前 1 pass / 3 expect），完整 prompt 最终也通过该项。未弱化测试时限。
- repo root：`bun run lint` → **6193 warnings / 1 error**，错误为未改动的 `packages/session-ui/src/v2/components/prompt-input/index.tsx:163` 中已有 `\200B` 八进制转义；保留失败记录，不修改无关文件。R9 对本任务 12 个代码/测试文件执行 `bun run lint -- ...` → **116 warnings / 0 errors**。`git diff --check` 通过。

### Original Feedback-Loop Result

原始真实日志中的 SSE 中断和旧五次截断已由 red 测试与 `dev-smark` 最终源码双向定位；未再次调用真实远端模型。替代验证为真实 SSE fixture 断流、真实工具 execute 闸门、TestClock 退避和 Core/V1 全量回归；外部 Provider/Cloudflare 的实时复现仍是部署后观察项。

### Actual Secondary and Replacement Path Inventory

- OpenAI 404：保留旧 `parseAPICallError` 的精确兼容分支，只在 `provider.startsWith("openai")` 且 SDK 否决时覆盖。
- Reviewer tool-choice 400：保留既有同次去参重发，不扩展为通用 400 重试。
- JSON fallback、Goal continuation、compact tailmarker、普通工具错误回传模型：均沿既有路径，不新增第二 policy。
- 共享 `apiError/fromError` 读取原生 carrier 并适配既有 V1 表达；资格、等待、Free/Go 和 Cloudflare 判定归 `SessionRetry`。入口只保留生命周期所需的调用，不复制错误分类。
- 未引入 catch-and-success、fallback provider、配置开关、迁移或平行重试算法。

### Chinese Comment Calculation

| 指标 | 实际 | 方法 |
| --- | --- | --- |
| 生产 E / C | 230 / 46 | 独立审阅逐 hunk 排除 imports、空行、格式、纯移动及并行内容 |
| 测试及 fixture E / C | 308 / 37 | 不计已删除的数据库故障测试及并行用量测试 |
| 合计 E / C | 538 / 83 | 有效邻近中文说明，不含无关或纯移动注释 |
| C/E / 最低 C | 15.43% / 81 | 83 >= ceil(538 × 0.15)，门禁通过 |

代表性注释覆盖：工具断流不取消真实 execute、原错误 carrier 不被后续 reset 替换、失败轮 provider metadata 不回放、共享 retry 不制造第二政策、退避消耗原 deadline。以上采用最终独立任务口径，不用原始路径统计代替实际任务门禁，不添加凑数注释。

### Remaining Unverified Items

- R9 已获方案与实施完整合并放行；完整 prompt 和仓库 lint 的既有/并行失败如实保留，不宣称全仓全绿。
- 真实远端 Cloudflare/OpenAI 会话未重新复跑；若部署后仍出现不重试，应按新日志补 red case，而不是新增下游分支。
- 提交时必须排除任务前已存在的 processor/message-v2/test hunks 和全部无关工作区文件。

## 24. Implementation Audit Record

| 轮次 | 批准方案 | 完整原始范围 | Blocking | Non-blocking | 结论 | 调用引用 |
| --- | --- | --- | --- | --- | --- | --- |
| implementation-1 | R6 | 是 | B-01、B-02、B-03 | 并行 hunk、测试落点、既有 V1 续轮、托管工具透传 | BLOCK | `ses_e5060d168ffe5zib0SP7eyJUfC` |
| 独立复议 | R6 + 当时用户澄清 | 是 | B-01 收窄、B-02 保留、B-03 待产品选择 | 删除重复分类；确认后限制为候选设计而非旧合同 | BLOCK | `ses_e4fe6881affekmpVohG2SbEgc0` |
| implementation-2 | R8 | 是 | B-01 正常调用 metadata 被再登记覆盖；B-02 续轮/持久化失败验收缺口 | compaction 注释已同步；独立命令未执行 | BLOCK | `ses_e4f942a3bffeh4rPCVjXQzMCwy` |

第二轮 release verdict 原文：**BLOCK — 针对获批 R8 与本次实际任务 diff，阻塞项为 B-01、B-02。** 审计基线：`72c2142d47f0e5fe560f74ab3b61fe853924ebd6`。本轮只读，未修改文件、索引或提交。修正后须对完整原始范围和实际 diff 重新审计。

第二轮独立 E/C 原文口径：排除 import-only、空行、格式、纯移动、并行 hunk，生产 E=243/C=48，测试 E=272/C=31，合计 E=515/C=79（15.34%）。该口径为上述返工前；最终审计需复算返工实际 diff。

两轮 release verdict 原文分别为：

> **BLOCK — 针对当前实际 diff（对应已批准 R6）。** 阻塞项 B-01、B-02、B-03。修订后需对全部原始范围与实际 diff 重新进行完整实现审计。

> **BLOCK——仅针对当前 R6 与本次审阅的任务 diff。**
>
> B-01、B-02 优先通过删除重复转换、统一失败身份来解决。B-03 随新增限制的产品选择处理，不能成为继续堆补丁或擅自缩减无限重试需求的理由。

用户随后对 B-03 的具体场景作出第 1 节澄清，R7 删除限制及其专用测试义务。R7 的必要变更只涉及共享缺省资格、删除完成否决、删除压缩本地转换及统一 runner carrier；无新生产文件、状态、配置或恢复算法。方案阶段隔离命令 `bun -e 'import { SessionRetry } from "./src/session/retry"; import { LLMEvent } from "@opencode-ai/llm"; console.log(SessionRetry.retryable(LLMEvent.providerError({message:"provider request failed"}),"test"))'`（`packages/core`）已运行，当前输出 `undefined`，是缺省流错误被终止的 red 信号。R7 在现有共享策略测试及真实会话 fixture 增加此常规未知错误恢复用例；不增加完成后尾错测试。

任何后续实现完成声明仍要求当前批准版本、必跑验证和独立完整实现审查；只有实现审计对实际 diff 给出 `No blocking findings` 与 `APPROVE` 后，才可设置 `verified` 并按用户已授权的 commit 边界提交。仍不授权 push。

R9 按第 1 节用户新指令合并方案与实施审阅，复用第二轮上下文及仍有效证据。R8 后续复查已确认正常 metadata 修复，剩余意见为 V1 数据库保存失败专项覆盖；用户随后明确拒绝该扩展，并要求收敛新增生产防护。R9 不重新添加这项测试或 Core publicationFailed 合同；审阅仍覆盖完整 SSE 恢复、真实工具交接和本轮全部实际任务 diff。

| 后续合并审阅 | 完整原始范围 | 结论 | 调用引用 |
| --- | --- | --- | --- |
| R9 方案与实际实现 | 是 | BLOCK；仅 B-02 失败退出行为证据缺口，未发现其他生产阻塞 | `ses_e4f942a3bffeh4rPCVjXQzMCwy` |
| R9 证据复议及完整范围确认 | 是 | No blocking findings；B-02 依据已执行隔离实验撤销 | 同一上下文 |

最终 release verdict 原文：

> **APPROVE — 放行本次完整审阅的 R9 方案及当前任务实施 diff。**
>
> 基线为 `72c2142d47f0e5fe560f74ab3b61fe853924ebd6`。B-01 保持解决，B-02 依据原始红绿证据撤销；历史 verdict 保留。
>
> 批准仅覆盖本次任务所属 hunk，不包含共享工作树中的并行修改，也不表示完整 Prompt 或全仓 lint 已全绿。本轮未修改文件、索引或 Git 历史。

审阅独立读取原始执行记录 `prt_1b098f149001tjYMVo385HoHZv`（1 pass / 4 expect）及 mutation 记录 `prt_1b099b7db001KqJNfCq6xEq7AZ`（Expected stop / Received continue），并核对留存测试源码、preload 和未变的生产分支。没有重新加入用户拒绝的测试。最终 task-only E=538/C=83，独立命令与第 23 节一致；HTTP 400 原正例撤回 hunk 后独立 retry.test.ts 93 pass / 0 fail。

提交边界已另获用户明确批准：允许只把本任务 hunk 写入索引并提交，工作区及并行修改保持原样；不授权 push、amend 或跳过 hook。

## Appendix A. 旧机制逐项保留清单

本表不是举例清单。每一行均须形成参数化 golden case，验证“是否重试、原因、等待、保留的数据、退出方式”，不能只测最终 HTTP 请求次数。对齐 `dev-smark` 最终状态中可观察的恢复收益；类型化/显式拒绝保留分类，未标记流事件的业务 code 按第 1 节用户明确选择重试，不扩展协议代码。

### A.1 错误码完整集合

```text
ECONNRESET
ECONNREFUSED
ETIMEDOUT
ENOTFOUND
EAI_AGAIN
EPIPE
ConnectionClosed
ConnectionRefused
FailedToOpenSocket
UND_ERR_SOCKET
UND_ERR_CONNECT_TIMEOUT
UND_ERR_HEADERS_TIMEOUT
UND_ERR_BODY_TIMEOUT
UND_ERR_ABORTED
CERT_HAS_EXPIRED
DEPTH_ZERO_SELF_SIGNED_CERT
SELF_SIGNED_CERT_IN_CHAIN
UNABLE_TO_VERIFY_LEAF_SIGNATURE
UNABLE_TO_GET_ISSUER_CERT
UNABLE_TO_GET_ISSUER_CERT_LOCALLY
ERR_TLS_CERT_ALTNAME_INVALID
ERR_TLS_HANDSHAKE_TIMEOUT
SSE_READ_TIMEOUT
```

`ECONNRESET` 保留旧顶层独立消息/metadata 规则；其余 22 个码维持旧集合。TLS 重试不等于关闭 TLS 校验。用户取消时控制流优先退出，不能因为出现其中的码而重新发请求。

### A.2 分类、等待及恢复收益

| ID | 旧机制的精确条件 | 新设计必须保留的收益/输出 | 验收 |
| --- | --- | --- | --- |
| C01 | A.1 的顶层错误及已有嵌套 cause 形态 | 可恢复；原 message、code、syscall、name metadata 保留，不在 UI 退化成不可重试 Unknown | T1/T8，逐码参数化 |
| C02 | `ZlibError`，非用户中止 | `Response decompression failed`，可恢复；用户中止仍为 Aborted | T1/T8 |
| C03 | 无 code 的 `TimeoutError`、`SSE read timed out` | 识别超时；SSE 文本保留 `SSE_READ_TIMEOUT` 诊断 | T1/T2 |
| C04 | `fetch failed`、`failed to fetch`、`Cannot connect to API:`；无 code 的 socket connection was closed | 保留旧文本识别；不靠 Provider 名称白名单 | T1/T8 |
| C05 | `AI_RetryError.lastError` 或 errors 最后一项 | 解开真正最终错误，不把包装异常本身当成永久失败 | T1/T8 |
| C06 | 无状态码、SDK false 的 APICallError 内嵌 transport cause | 按旧规则升级为可重试，原始 code/message metadata 保留 | T1/T8 |
| C07 | 外层普通 Error 内嵌 APICallError；已有有限 cause 深度 | 保留显式 HTTP 状态及其原语义，不被外层 fetch failed 覆盖 | T1/T8 |
| C08 | 结构化 stream error 在 message/cause 中 | 先识别上下文/服务端语义，再判通用网络错误；保留 responseBody | T1/T8 |
| C09 | 已经分类的 APIError 实例 | fromError 不降级；isRetryable、status、headers、body 保留 | T1/T8 |
| C10 | HTTP 429，即使 SDK false | 可恢复，仍尊重服务端等待提示 | T1/T8 |
| C11 | HTTP >=500，即使 SDK false | 可恢复，不仅支持一个固定的 503 | T1/T8 |
| C12 | OpenAI provider 前缀的 404 | 保留既有模型暂时不可见时的重试；其他 Provider 的普通 404 不扩张 | T1/T8；原生 InvalidRequest 等价 case |
| C13 | 普通 HTTP 400/401/403，SDK false，无旧特例 | 不因正文包含 try again/网络关键词而误重试 | T1/T8 |
| C14 | 403 + cloudflare server + 非空 cf-ray + HTML + challenge 指纹 | 各 Provider 都重试；不把任意 403 当成 Cloudflare | T1/T8 |
| C15 | C14 的 cf-mitigated=challenge | 保留该单独指纹分支 | T1/T8 |
| C16 | C14 的 window._cf_chl_opt + /cdn-cgi/challenge-platform/ | 保留该单独指纹分支 | T1/T8 |
| C17 | C14 的 cf-error-details + /cdn-cgi/styles/cf.errors.css | 保留该单独指纹分支 | T1/T8 |
| C18 | C14 的 Unable to load site + Please try again later + status.openai.com | 保留旧 outage 页识别，不能只保留 challenge | T1/T8 |
| C19 | 普通文本 rate increased too quickly / rate limit / too many requests | 保留原因与可恢复资格 | T1/T8 |
| C20 | 序列化 `type:error,error.type:too_many_requests` | 原有 `Too Many Requests` 归一化文案及资格 | T1/T8 |
| C21 | 序列化 code 含 exhausted 或 unavailable | 原有 `Provider is overloaded` 归一化文案及资格 | T1/T8 |
| C22 | 序列化 `type:error,error.code` 含 rate_limit | 保留 HEAD 识别和原文字；按用户撤回 H16，不为固定文案新增分支 | T1/T8 |
| C23 | 不认识的普通 JSON / Invalid request body | 不因“扩大捕获”而变成无限循环 | T1/T8 |
| C24 | FreeUsageLimitError | 保留 reason/provider/title/label/link 的动作合同和限额提示，不改成裸重试文字 | T1/T8 |
| C25 | GoUsageLimitError + workspace/limitName/retry-after | 保留 account_rate_limit 动作、重置时间/工作区链接，仍用原 policy 等待 | T1/T8 |
| C26 | retry-after-ms、retry-after 秒数或未来 HTTP 日期 | 优先服务端提示；非法/过去日期回原退避；有头最大 30 分钟 | T1/T8 |
| C27 | 无服务端提示 | 2/4/8/16 秒增长、无头最大 30 秒；保留新版 25% jitter；到上限后不溢出 | T1，含第 10000 次尝试及 random=0 |
| C28 | 暂时错误持续超过五次 | 实际不可达的安全整数上限；恢复后返回真实最终内容，可主动停止 | T1/T7 |
| C29 | partial text/reasoning + reset/timeout/network_error/other/unknown，尚无完整工具进展 | 删除失败内容和未执行输入；同 Message ID 重生成；不隐藏、不拼前缀 | T2/T3 |
| C30 | 已有完整本地/MCP/Workflow/托管调用进展 | 先实际收尾；保留成功/失败结果，下一消息携带事实，不重发旧请求 | T4/T5/T6 |
| C31 | 普通工具失败、权限拒绝、三次错误熔断 | 原有工具结果、停止条件和一次询问保留，不借网络重试绕过 | T6/T8 |
| C32 | 用户中止、context overflow、已有输出上限语义 | 不无限重试；保留取消、压缩及单次语义额度 | T7/T8 |
| C33 | 已确认用量、父请求、用户撤回 | 不退款、不换父请求、不借 hidden 混合撤回原因 | T9 |
| C34 | Reviewer、compaction、V1 AI SDK/Native、V2 Native | 同一旧资格/等待收益到达所有现存 caller；各 caller 自有期限和协议额度保留 | T1/T5/T8 |
| C35 | compact 中断/失败与 tailmarker | 原 hideIncomplete 隐藏 marker/summary；隐藏任一侧或 Part 均不能生效，SQL cutoff 前排除，保留前个成功边界 | T12 |
| C36 | tail 保留与普通撤回 | tail_start_id/recent_user_messages 原筛选和双锚点不改；普通 tail 隐藏不撤销合法压缩，失败重试不重建 marker；V2 只提交 Ended | T10/T12 |

精确差异说明：本任务恢复旧恢复收益；按用户对 H15/H16 的选择，legacy HTTP 文本识别及 JSON 展示文字维持 HEAD，不额外收紧或归一化。不能将本表各项收益换成一句“网络错误可重试”。源码码集合、cause 递归深度、Cloudflare 条件直接复用现有函数/集合。

## Appendix B. 预期代码 DIFF

以下是**文档内的定位/语义 diff**，省略未变化的估算、权限、输出处理和用量结算，不作为可直接应用的补丁。R9 已实施部分以当前 Git diff 和第 23 节验证为准；导入合并及现有 tool-call 登记代码的纯移动不改变语义。方案与当前实际 diff 本次一起审阅。

### B.1 Core 共享重试策略

```diff
--- a/packages/core/src/session/retry.ts
+++ b/packages/core/src/session/retry.ts
@@
-import { Cause, Clock, Duration, Effect, Schedule } from "effect"
-import { isCloudflareBlock } from "@opencode-ai/llm"
+import { Cause, Clock, Duration, Effect, Schedule } from "effect"
+import { isCloudflareBlock, isContextOverflowFailure, LLMError, LLMEvent, type ProviderErrorEvent } from "@opencode-ai/llm"
@@
-export type Err = ReturnType<NamedError["toObject"]>
+export type Err = ReturnType<NamedError["toObject"]> | LLMError | ProviderErrorEvent
+
+export function apiError(error: LLMError | ProviderErrorEvent) {
+  const http = error instanceof LLMError && "http" in error.reason ? error.reason.http : undefined
+  return new SessionV1.APIError({
+    message: error instanceof LLMError ? error.reason.message : error.message,
+    isRetryable: error instanceof LLMError ? error.retryable : error.retryable ?? false,
+    statusCode: http?.response?.status,
+    responseHeaders: http?.response?.headers,
+    responseBody: http?.body,
+  })
+}
@@
-export const RETRY_MAX_RETRIES = 5
+export const RETRY_MAX_RETRIES = Number.MAX_SAFE_INTEGER
@@ export function retryable(error: Err, provider: string) {
+  if (error instanceof LLMError) {
+    if (isContextOverflowFailure(error)) return undefined
+    const http = "http" in error.reason ? error.reason.http : undefined
+    const openai404 = error.reason._tag === "InvalidRequest" && provider.startsWith("openai") && http?.response?.status === 404
+    if (!error.retryable && !openai404) return undefined
+    // 复用既有 APIError 分支，包括 Free/Go 动作，不在原生适配处提前结束分类。
+    return retryable(new SessionV1.APIError({ ...apiError(error).data, isRetryable: true }).toObject(), provider)
+  }
+  if (LLMEvent.is.providerError(error)) {
+    if (error.classification === "context-overflow" || error.retryable === false) return undefined
+    return { message: error.message }
+  }
@@ export function delay(
-  error?: SessionV1.APIError,
+  error?: SessionV1.APIError | LLMError,
@@
+  if (error instanceof LLMError) {
+    const projected = apiError(error)
+    const headers = projected.data.responseHeaders
+    // 原始提示头先走旧解析；过期日期不能被原生归一化的 0 覆盖。
+    if (error.retryAfterMs !== undefined && headers?.["retry-after-ms"] === undefined && headers?.["retry-after"] === undefined) {
+      return cap(error.retryAfterMs)
+    }
+    return delay(attempt, projected, random)
+  }
@@ function exponential(attempt: number, random: number) {
-  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
+  const base = Math.min(RETRY_MAX_DELAY, RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
@@
       if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
@@
-        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
+        const wait = delay(meta.attempt, error instanceof LLMError || SessionV1.APIError.isInstance(error) ? error : undefined)
```

旧 `TRANSIENT_TRANSPORT_CODES`、fromError 的 RetryError/cause 解包和 parseStreamError 不替换。C01-C09 的收益来自保留这些原有代码，不是再次复制它们。

R9 额外共享接线（旧 HTTP 文本规则和 JSON 文案不再产生 diff）：

```diff
@@ policy 参数及原生 carrier 默认识别
-  parse: (error: unknown) => Err
+  parse?: (error: unknown) => Err | undefined
@@
-      const error = opts.parse(meta.input)
+      const error = opts.parse?.(meta.input) ?? (
+        meta.input instanceof LLMError || LLMEvent.is.providerError(meta.input)
+          ? meta.input : { name: "UnknownError", data: {} }
+      )
@@ set 数据
+        const data = error instanceof LLMError || LLMEvent.is.providerError(error)
+          ? apiError(error).data : SessionV1.APIError.isInstance(error) ? error.data : undefined
@@
+          error: { ...data, message: retry.message, isRetryable: true },
--- a/packages/opencode/src/session/message-v2.ts
+++ b/packages/opencode/src/session/message-v2.ts
@@ fromError 开头；原生类别读取放在共享 SessionRetry.fromError 内
+  const native = SessionRetry.fromError(e, ctx.providerID)
+  if (native) return native
```

### B.2 V1 工具执行登记及实际结果落地

```diff
--- a/packages/opencode/src/session/processor.ts
+++ b/packages/opencode/src/session/processor.ts
@@
-import { Usage, type LLMEvent } from "@opencode-ai/llm"
+import { Usage, LLMEvent, LLMError, ToolResultValue } from "@opencode-ai/llm"
+import { EffectBridge } from "@/effect/bridge"
@@ ensureToolCall 的登记临界区
-        const part = yield* toolPermit.withPermits(1)(
-          session.updatePart({
+        const part = yield* session.updatePart({
@@ 原 session.updatePart 对象末尾
-          } satisfies SessionV1.ToolPart),
-        )
+        } satisfies SessionV1.ToolPart)
@@ ensureToolCall 函数结尾（check、create、ctx.toolcalls 登记均在此许可内）
-      })
+      }, toolPermit.withPermits(1))
@@ const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")
-        delete ctx.toolcalls[toolCallID]
+        // 终态登记保留到本消息收尾，防止 SDK 回声重新创建同一工具 Part。
@@ case "tool-call":
-            ctx.hasToolCall = true
-            /* 此 case 现有 ensure/input/running/providerMetadata 登记代码 */
+            yield* startToolCall(value)
+            return
@@ case "provider-error":
-            throw new Error(value.message)
+            return yield* Effect.fail(value)
@@ const process = Effect.fn("SessionProcessor.process")
+        const bridge = yield* EffectBridge.make()
+        const toolAbort = new AbortController()
+        const executions: Promise<Exit.Exit<void, unknown>>[] = []
+        const tools = Object.fromEntries(Object.entries(streamInput.tools).map(([name, item]) => {
+          const execute = item.execute
+          if (!execute) return [name, item]
+          return [name, { ...item, execute: (args: Parameters<typeof execute>[0], options: Parameters<typeof execute>[1]) => {
+            if (toolAbort.signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
+            ctx.hasToolCall = true
+            const job = bridge.promise(Effect.gen(function* () {
+              yield* startToolCall({ type: "tool-call", id: options.toolCallId, name, input: args })
+              const exit = yield* Effect.tryPromise({
+                try: () => Promise.resolve(execute(args, { ...options, abortSignal: toolAbort.signal })),
+                catch: error => error,
+              }).pipe(Effect.exit)
+              if (Exit.isSuccess(exit)) {
+                yield* completeToolCall(options.toolCallId, toolResultOutput(LLMEvent.toolResult({
+                  id: options.toolCallId, name, result: ToolResultValue.make(exit.value),
+                })))
+                return exit
+              }
+              if (yield* failToolCall(options.toolCallId, Cause.squash(exit.cause))) {
+                yield* askDoomLoopIfTripleFailure(name, isRecord(args) ? args : { value: args })
+              }
+              return exit
+            }))
+            // 立即接收收尾拒绝，普通工具失败作为 Exit 值返回，不产生无人处理的 rejected Promise。
+            executions.push(job.then(() => Exit.succeed(undefined), error => Exit.fail(error)))
+            return job.then(exit => {
+              if (Exit.isSuccess(exit)) return exit.value
+              throw Cause.squash(exit.cause)
+            })
+          } }]
+        }))
@@ const stream = llm.stream(
-              ...streamInput,
+              ...streamInput, tools,
```

`startToolCall` 是从现有 `case "tool-call"` 提取的私有登记操作，由事件与实际执行两个入口复用。上面的 ensureToolCall 临界区扩大是配套必改项，不能只复用旧的锁外检查。还需在原 running/input 更新表达式增加如下保护，providerMetadata/worktree/providerExecuted 合并仍使用现有代码：

```diff
@@ state: match.state.status === "running"
-                  match.state.status === "running"
+                  match.state.status === "completed" || match.state.status === "error"
+                    ? match.state
+                    : match.state.status === "running"
```

该保护与保留当前 callID 登记一起使用，不能只改其中一处。`completeToolCall` 的输出准备、同步 input、审查 metadata 和首次终态许可代码不替换；直接中止补偿和 SDK 回声继续消费同一个幂等入口。

### B.3 V1 单收尾及直接清理

```diff
@@ 单次消费开始（现有 Effect.gen 内）
+            executions.length = 0
@@
-            yield* stream.pipe(
+            const exit = yield* stream.pipe(
               Stream.tap(handleEvent),
               Stream.takeUntil(() => ctx.needsCompaction),
               Stream.runDrain,
+              Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), cause => Effect.fail(Cause.squash(cause))),
+              Effect.exit,
             )
+            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
+            const settled = yield* Effect.promise(() => Promise.all(executions))
+            const failed = settled.find(Exit.isFailure)
+            if (failed) return yield* Effect.die(Cause.squash(failed.cause))
+            if (Exit.isSuccess(exit)) return
+            const error = Cause.squash(exit.cause)
+            const retry = SessionRetry.retryable(toRetryCarrier(error), input.model.providerID)
+            if (!retry) return yield* Effect.failCause(exit.cause)
+            yield* discardIncompleteAttempt()
+            if (!ctx.hasToolCall) return yield* Effect.failCause(exit.cause)
+            ctx.assistantMessage.finish = "unknown"
@@ Effect.onInterrupt
                 aborted = true
+                toolAbort.abort()
@@ SessionRetry.retry 的 policy 输入适配
-              parse,
+              parse: toRetryCarrier,
@@ 共享 retry 外
-            Effect.catch(halt),
+            Effect.catchCauseIf(cause => !Cause.hasInterruptsOnly(cause), cause => halt(Cause.squash(cause))),
             Effect.ensuring(cleanup()),
+            Effect.ensuring(Effect.sync(() => toolAbort.abort())),
```

同时移除原来位于共享 retry 前、对整个尝试进行 cause-to-error 转换的 catch，以及仅识别 raw network_error 字符串的 tapError。转换只保留在上面的 Provider 消费块，收尾 defect 才不会重新进入网络 policy。`toRetryCarrier(error)` 定义为：原对象是 LLMError 或 ProviderErrorEvent 时透传，否则使用当前 parse(error)，并供 policy.parse 复用。

`discardIncompleteAttempt` 的变更集合必须是以下两个确定集合，不隐藏消息：

```diff
@@ 无工具进展时
-        /* 只删除 attemptPartIDs 中的非工具 Part */
+        // 删除 attemptPartIDs，以及本次尚未执行的参数 Part；确认 step-finish 和历史 Part 不在集合中。
+        // 然后清空 currentText、reasoningMap、toolInputBuffer、对应 toolcalls，保留助手 id/parentID。
@@ 有工具进展时
+        // 只移除未完成 currentText/开放 reasoning；真实工具及其结果不能进入删除集合。
+        // 尚未执行的参数若已声明 callID，沿现有 error-result 配对收尾，不执行空参数。
```

上面两行集合描述是对现有 `session.removePart` 循环的修改约束，不引入新删除接口。implementation diff 必须实际写出对应循环并用 T2/T3/T4 验证，不能留下注释代替实现。

同一循环在带工具失败时，对保留下来的 Part 应执行以下字段操作；位置在清空 attemptPartIDs 之前，不另开扫描历史的流程：

```ts
const provider = MessageV2.providerMeta(part.metadata)
if (provider) {
  yield* session.updatePart({
    ...part,
    metadata: Object.fromEntries(Object.entries(part.metadata ?? {}).filter(([key]) => !(key in provider))),
  })
}
```

这里的 part 已由当前尝试的 Part ID 取得并收窄为 text/reasoning/tool。只改 Part.metadata，不改工具 state/ToolState.metadata，不删除结果、审查事实或 primitive 服务端标记。已结束 reasoning 也在 attemptPartIDs 中，因此其 opaque 凭据不会因退出 reasoningMap 而漏清。

### B.4 Workflow 和最终错误投影

```diff
--- a/packages/opencode/src/session/llm.ts
+++ b/packages/opencode/src/session/llm.ts
@@ workflowModel.toolExecutor
-          await bridge.promise(Effect.logInfo("tool timing", { phase: "tool.start", ...timing }))
+          bridge.fork(Effect.logInfo("tool timing", { phase: "tool.start", ...timing }))
```

`t.execute(...)` 随后在首次业务 await 前立即调用，因此 B.2 的同步登记不会晚于收尾快照。未知工具分支、参数解析、原返回值和日志字段保持现状。

```diff
--- a/packages/opencode/src/session/message-v2.ts
+++ b/packages/opencode/src/session/message-v2.ts
@@
-function providerMeta(metadata: Record<string, any> | undefined) {
+export function providerMeta(metadata: Record<string, any> | undefined) {
@@ fromError 的普通 Error catch-all 之前
+    // 先投影已有原生 carrier；上下文、鉴权、内容拒绝沿已有具体 V1 错误类别。
+    // 其余 native error 通过共享 apiError 投影；isRetryable 取共享 SessionRetry.retryable 的结果。
+    // LLMError 的真实 http status/headers/body 不丢；ProviderErrorEvent 保留 classification/明确 false。
```

此投影不参与另一次资格计算；共享 policy 收到的始终是原生原对象，而不是重新解析投影后的 message。不得让该 projection 重新打开 context/auth/content-policy 错误的 Goal 资格。

### B.5 V2 原生 owner 的定位 diff

```diff
--- a/packages/core/src/session/runner/llm.ts
+++ b/packages/core/src/session/runner/llm.ts
@@ provider-error 消费
-            yield* publish(event)
+            // provider-error 先保存为本轮 carrier，等待已有 toolFibers 后才正式发布失败。
@@ providerStream
-      }).pipe(Effect.retry({ schedule: SessionRetry.policy(/* 当前仅两个 sentinel */) }))
+      })
@@ 现有统一收尾块
           const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
+          // 到此才发布失败或决定恢复；原工具拒绝和异常沿既有结算。
@@ policy.parse（移动至一次收尾操作外）
-            if (error !== incomplete && error !== outputLength) return { name: "UnknownError", data: {} }
-            if (error === outputLength && (hasToolCall || outputLimitRetried)) return { name: "MessageOutputLengthError", data: {} }
-            if (error === outputLength) outputLimitRetried = true
-            retryErrorForAttempt = error === outputLength
-              ? new SessionV1.APIError({ message: outputLength.reason.message, isRetryable: true, metadata: { reason: "output-length" } })
-              : retryError
-            return retryErrorForAttempt.toObject()
+            if (hasToolCall) return { name: "UnknownError", data: {} }
+            if (error === incomplete) return retryError.toObject()
+            if (error === outputLength) {
+              if (outputLimitRetried) return { name: "MessageOutputLengthError", data: {} }
+              outputLimitRetried = true
+              return new SessionV1.APIError({
+                message: outputLength.reason.message, isRetryable: true, metadata: { reason: "output-length" },
+              }).toObject()
+            }
+            return overflowFailure
@@ policy.set
+          set: ({ attempt, error }) => Effect.gen(function* () {
+            hasToolCall = false
+            overflowFailure = undefined
+            terminalError = false
+            yield* withPublication(publisher.retry(attempt, error))
+          }),
@@ 可恢复、已有工具、真实工具收尾成功且没有权限停止
+          return { needsContinuation: true, canContinueGoal: false, step: currentStep }
@@ 可恢复、无工具
+          // 向共享 policy 传播当前 Provider carrier；set 复用 publisher.retry。
```

移动的是当前整个 SessionRetry.policy 调用及其已有语义额度分支，不创建第二个 retry。outputLength 的既有单次额度保持；删除候选实现新增的确认后重试否决。`publisher.retry`/Retried reducer 本身不改，已具备同助手 ID 直接清内容的能力。

### B.6 测试及可复现 fixture diff

```diff
--- a/packages/opencode/test/session/retry.test.ts
+++ b/packages/opencode/test/session/retry.test.ts
@@
-  it.instance("policy stops after five retries", () =>
+  it.instance("policy continues beyond five transient failures", () =>
@@
-      yield* Effect.forEach(Array.from({ length: SessionRetry.RETRY_MAX_RETRIES + 1 }), () =>
+      yield* Effect.forEach(Array.from({ length: 8 }), () =>
@@
-      expect(attempts).toStrictEqual([1, 2, 3, 4, 5])
+      expect(attempts).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8])
--- a/packages/opencode/test/session/processor-effect.test.ts
+++ b/packages/opencode/test/session/processor-effect.test.ts
@@ reset reasoning state across retries
-        expect(reasoning.some((part) => part.text === "two")).toBe(true)
-        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
+        expect(reasoning.map((part) => part.text)).toEqual(["two"])
--- a/packages/opencode/test/lib/llm-server.ts
+++ b/packages/opencode/test/lib/llm-server.ts
@@ const reset = Effect.fn("TestLLMServer.reset")
     for (const part of item.head) res.write(line(part))
     for (const part of item.tail) res.write(line(part))
-    res.destroy(new Error("connection reset"))
   })
+  const wait = item.wait
+  if (wait) yield* Effect.promise(() => wait)
+  yield* Effect.sync(() => res.destroy(new Error("connection reset")))
   return yield* Effect.never
```

T4 将 wait 接在测试工具 started 信号上，工具完成另外用独立闸门；这样能保证“已启动后断流”，不会把未收到首块的失败误当成同一个复现。T1 的公开 Session 成功回复、T4 的可观察一次副作用/下一请求结果交付仍是主要验收，不能只保留上述纯策略断言。

### B.7 Core 原生压缩的共享接线

```diff
--- a/packages/core/src/session/compaction.ts
+++ b/packages/core/src/session/compaction.ts
@@ imports
+import { SessionRetry } from "./retry"
+import { SessionV1 } from "../v1/session"
+// 合并到现有 @opencode-ai/llm 导入：InvalidProviderOutputReason。
@@ Started 之后，摘要消费之前
+    const incomplete = new LLMError({ module: "SessionCompaction", method: "summary",
+      reason: new InvalidProviderOutputReason({ message: "Provider returned incomplete completion (finish_reason: unknown)" }) })
-    let failed = false
-    const summarized = yield* dependencies.llm
+    const summary = yield* Effect.suspend(() => {
+      const chunks: string[] = []
+      return dependencies.llm
         .stream(
@@ 既有 request/onPrepared 保持原样
-          if (LLMEvent.is.providerError(event)) failed = true
+          if (LLMEvent.is.providerError(event)) return yield* Effect.fail(event)
@@ stepFinish 的 usage 确认之前
+            if (event.reason === "unknown") return yield* incomplete
@@ 消费改为 Effect.gen；返回本次局部摘要，catchTag 移到共享 retry 之后
-        Effect.as(true),
+        Effect.map(() => chunks.join("")),
+      )
+    }).pipe(
+      SessionRetry.retry({
+        provider: String(input.model.provider),
+        parse: error => {
+          if (error === incomplete) return new SessionV1.APIError({
+            message: incomplete.reason.message, isRetryable: true, metadata: { finishReason: "unknown" },
+          }).toObject()
+          return undefined
+        },
+        set: () => Effect.void,
+      }),
+      Effect.catchIf(LLMEvent.is.providerError, () => Effect.void),
+      Effect.catchTag("LLM.Error", (error) => reason === "manual" ? Effect.fail(error) : Effect.void),
       )
@@ 原不可用摘要判断
-    if (!summarized || failed || !summary.trim()) {
+    if (!summary || !summary.trim()) {
```

仅把现有一次消费改为重新订阅和同一个策略包装。Started/终态 ID、原摘要/上下文选择、最终 false 判定与 Ended 提交代码不挪进 retry。原事件通过 Effect.gen 消费器直接失败并由 retry 后的 catchIf 保留原 false 合同；不再建立 providerFailure 或其他本地分类。T10 使用既有原生运输 fixture 和 TestClock。

### B.8 Core 原生审查的期限内共享接线

```diff
--- a/packages/core/src/permission/reviewer.ts
+++ b/packages/core/src/permission/reviewer.ts
@@ imports
+import { SessionRetry } from "../session/retry"
@@ 保留 reviewerRequestID、Synthetic、samples、publisher；估算仍归协议尝试
-        let assessment: typeof PermissionReviewerSchema.Assessment.Type | undefined
-        let textOutput = ""
-        const forced = !toolChoiceRejectedProviders.has(selected.model.provider)
+        return yield* Effect.suspend(() => {
+          let assessment: typeof PermissionReviewerSchema.Assessment.Type | undefined
+          let textOutput = ""
+          const forced = !toolChoiceRejectedProviders.has(selected.model.provider)
           const request = LLM.request({
@@ 原 request/onPrepared 和 typed400 协商保持在本次订阅内
-        return yield* client.stream(request, onPrepared).pipe(
+          return client.stream(request, onPrepared).pipe(
@@ Stream.runForEach，在 publisher.publish 之前保留原生失败对象
             if (event.type === "tool-error") return yield* protocolError
+            if (event.type === "provider-error") return yield* Effect.fail(event)
             yield* publisher.publish(event)
-            if (event.type === "provider-error") return yield* new Failed({ reason: event.message })
@@ 既有 assessment / JSON 裁决提取 flatMap 后
+          )
+        }).pipe(
+          SessionRetry.retry({
+            provider: String(selected.model.provider),
+            set: input => Effect.gen(function* () {
+              yield* publisher.failAssistant(input.message, false, false, true)
+              yield* publisher.failUnsettledTools(input.message)
+              yield* publisher.retry(input.attempt, input.error)
+            }),
+          }),
+          Effect.catchIf(LLMEvent.is.providerError, error => Effect.fail(new Failed({ reason: error.message }))),
           // 每次拥有完整执行期限；仍先完成原onExit收尾，再向外层交付超时供补试。
           Effect.timeoutOrElse({ duration: options.timeout_ms ?? 120_000, orElse: () => Effect.fail(timedOut) }),
@@ 其后的 onExit、协议 MessagesHidden、attempt(index) 原样保留
```

timeout 仍包住整段订阅、网络重试和退避，不是每次网络失败重新计时。成功/非重试失败继续进入原有裁决或 fail-closed；protocolError、timedOut 的对象身份不变，外层三次额度不增不减。这里的 decision 工具仅记录裁决，不能类比实际外部工具而提前应用审批；返回 assessment 前发生可重试失败，必须先清掉本次 scratch。既有协议失败的专用隐藏与已确认用量不撤回；无新增事件、隐藏原因、工具或第二套资格策略。
