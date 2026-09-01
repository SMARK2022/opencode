# Canonical Implementation Plan: Permission Reviewer toolChoice 强制与 Prompt 决策入口强化

> Status: implementation-audit-required
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 用户原话（2026-09-01 会话）："当前我们需要解决 permission review decision 重试机制失效或者说调用无效的问题，即模型有时存在部分幻觉或部分内容导致模型未正常进行调用，所以当前需要对其 permission review 进行加强，在正常情况时也进行适当提示其调用相应的 permission review decision 的入口，也就是系统的 prompt，就进行相应的一个优化。与此同时，在其出现不正常调用等等的时候，补充相应的防御纵深的一个重试的追加 prompt，或者说 avoid xxx，就是这种意思。与此同时增加 tool choices required 相应的要求，同时仿照现有代码库先例。如果拒绝该参数，则兼容性地重发一次。整体生产代码修改文件数不超过5个，生产代码修改行数不超过500行，保持整体设计甜点级别设计"
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-01

本文件是本任务的唯一实施规范。聊天摘要、被取代的修订与 builder 自述不构成实施授权。

## 1. Verbatim Requirement

见上方 Requirement source（逐字引用，不缩窄、不演绎）。

拆解出的四项可执行要求（均为用户显式授权，非推测）：

1. **R-REQ-1（toolChoice 强制）**：reviewer 请求增加 `tool_choice: required`，仿照现有代码库先例（`packages/opencode/src/session/prompt.ts:3194` 的 `toolChoice: format.type === "json_schema" ? "required" : undefined`）。
2. **R-REQ-2（兼容重发）**：provider 拒绝该参数时，兼容性地重发一次。
3. **R-REQ-3（正常路径入口提示）**：正常情况下 prompt 中适当提示/优化调用 `permission_review_decision` 的入口。用户括注「也就是系统的 prompt」指向评审 prompt 整体：落点为双处——system prompt 的 `OUTPUT_CONTRACT_PROMPT` 增补 judge 角色/禁止提问语义（R-REQ-3a），以及 user message 尾部（planned action 之后）的决策指令 item（R-REQ-3b，recency 权重最高处）。此解释为对原话的忠实展开，非缩窄。
4. **R-REQ-4（异常路径防御纵深 nudge）**：出现不正常调用时，重试追加 prompt 采用 avoid-xxx 语义的防御纵深指令。

范围约束：生产代码 ≤5 文件、≤500 行；甜点级设计。

## 2. Explicit Non-Goals

- 不改变 reviewer 模型选择/继承逻辑（需求原文不含此工作；规划会话中用户口头表达过相同意向，仅作背景非权威依据）。
- 不引入常驻 reviewer 会话/线程复用（同上）。
- 不增加 `MAX_REVIEWER_ATTEMPTS`（保持 3）或重试节奏（用户原话只要求升级重试追加 prompt）。
- 不改变 precheck 四级路由、`invalidReviewContract` 语义守卫、`SessionRetry` 429/5xx 分类、fail-closed/fallback 语义、hidden-attempt 审计设计。
- 不改动主会话 `SessionPrompt`/`llm.ts` 的 toolChoice 通道（先例本身不动，只仿照）。
- 不新增配置项。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 领域语言：Permission（ruleset + ask）、Session、Provider；输出用词不漂移 |
| 根 `AGENTS.md` | 测试从 package 目录运行；`bun typecheck`；风格（无多余注释、Effect 规则） |
| `packages/opencode/AGENTS.md` | 模块形态（无 namespace export）、Effect v4 规则 |
| `packages/opencode/test/AGENTS.md` | `testEffect`/`it.instance`/`llm.wait` 同步原语；禁止 sleep 竞态 |
| `.opencode/policy/first-principles-engineering.md` | 单一 primary path、fallback 禁令（用户显式授权的兼容分支除外，见 §10） |
| `docs/reviewer-retry-fix-plan.md`（历史） | 3-attempt 重试架构的来源；仅作背景，不是本次授权 |
| `docs/plans/permission-reviewer-tool-terminal-closure.md`（历史） | Tool Part 终态闭合 invariant（INV-01 关联），不得破坏 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts`（工作树，与 HEAD 一致，1352 行） | streamText 请求形状（:609-648，无 toolChoice，:640-642 注释解释原因）；3-attempt 重试（:183-209）；nudge 常量（:83-89，含"不宣传 JSON fallback"设计注释）；json_fallback（:923-933）；SessionRetry 包装（:938-949） | observed |
| `packages/opencode/src/permission/reviewer/prompt.ts` | `OUTPUT_CONTRACT_PROMPT`（:31-40，仅存在于 system prompt）；`buildUserPromptItems`（:49-71，user message 以 planned-action JSON 结尾，无尾部决策指令） | observed |
| `packages/opencode/src/permission/reviewer/schema.ts` | `Assessment` 四字段全必填（:16-21，注释说明为何不允许可选） | observed |
| `packages/opencode/src/session/prompt.ts:3194` 与 `src/session/llm.ts:50,387` | 既有 toolChoice "required" 先例与传参通道（用户点名仿照对象） | observed |
| `packages/opencode/test/permission/reviewer-service.test.ts` | `reviewerFixture` 捕获真实 wire body（:792-848）；既有 400 兼容夹具先例（`requireInstructions`/`rejectMaxOutputTokens`，:805-820）；`ReviewerRequestBody` 类型（:38-42） | observed |
| `packages/opencode/test/permission/reviewer-prompt.test.ts` | prompt 内容断言模式（buildUserPromptItems 结构断言 :87-107） | observed |
| `packages/opencode/test/session/prompt.test.ts:1697-1735` | reviewer-only 集成测试（单次 `llm.push` 即 reviewer 回复；`inputs[0]` 为 reviewer wire 请求）；`:1735` `expect(inputs[0].tool_choice).not.toBe("required")` 是「reviewer 不强制 tool_choice」历史取舍的可执行测试锁，INV-02 需将其反转 | observed |
| `packages/opencode/test/session/prompt.test.ts:1834-1930` | 协议重试集成测试（hides malformed attempts；fails closed after two malformed retries）——症状级回归锚点 | observed |
| 生产 DB 取证（`~/.local/share/opencode/opencode.db`，2026-09-01 查询） | 失败现场：reviewer 子会话 `ses_fa4abdc10ffeW2Rkg9672Ls2ZL`（smark/glm-5.3-flash）两连审 6/6 attempt 全部输出 prose（"I can't actually execute that action…"、"I need more information…"、"Yes — approving this is correct…"），3 次耗尽后终态 `reviewer did not call permission_review_decision`；同库该模型历史 296 次真实 tool_call 成功、2 次 json_fallback——失败是长混乱 transcript 下的尾部漂移，非能力缺失 | observed |
| `packages/opencode/src/session/retry.ts`（经 reviewer-retry-fix-plan §2 转引并抽查） | `SessionRetry.retry` 只重试 429/5xx/rate-limit，400 不重试——兼容重发不能依赖它 | observed |
| **NF-1 实证（R5，实施期间红测插桩发现）**：service.ts stream 消费的 `!persist` 早退分支只处理 `text-delta`/`tool-call` 后 return，`error` 事件被吞 → 非 persist 路径上 provider 错误（含 400）表现为「drain 无 assessment」→ 协议错误 → 3 次盲重试后终态失败；persist 分支（:878-884）正确 `Effect.fail(event.error)`。实证链：D 红测中 3 次 `runReviewerStream` 进入 + 3 次 400 fetch + `error` 事件到达消费者但被早退吞掉 + drain 尾部日志出现 | observed（插桩日志 + 事件序列） |

## 5. Current Behavior

```text
Permission.ask(auto ruleset)
  -> Permission.auto.evaluate -> precheck cautious
  -> PermissionReviewer.review (service.ts:107)
     -> reviewerRetry ×3 (per-attempt timeout 90s, 协议错误附加 nudge)   [:186-209]
     -> runReviewerAttempt -> runReviewerAgent (child session message)
     -> runReviewerStream (acquireUseRelease[AbortController])          [:499-950]
        -> streamText(tools={permission_review_decision}, 无 toolChoice, maxRetries:0)  [:609-648]
        -> Stream.runForEach 持久化 parts；persist 路径 error 事件 -> Effect.fail；
           非 persist 早退分支（:708-716）只认 text-delta/tool-call，error 事件被吞（NF-1）
        -> drain 后无 assessment -> json_fallback 文本解析 -> 否则协议错误 [:923-933]
     -> SessionRetry.retry (仅 429/5xx)
  -> decision allow/deny | fallback_user ask | fail closed
```

正常时模型自行调用决策工具（DB：flash 296/298 成功为真实 tool_call）。漂移时模型输出 prose（判断正确但不调工具、或反问、或自认无法执行），json_fallback 仅能救回含 JSON 的文本；纯 prose 走 3 次同形重试（nudge 追加在重建的全新 `[system, user]` 上下文尾部，模型看不到自己上一轮输出）后 fail-closed → 打断用户（本次事故即此路径，两次 auto 审查把整个 auditor 会话卡死在 permission 弹窗）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| auto ruleset 命中 + precheck cautious 的任意 ask | Session/Tool 权限升级 | Permission.evaluate 已过滤 safe/general/dangerous | `review()` 主路径 | PermissionReviewer | observed |
| 长混乱 transcript 的评审 prompt（触发模型漂移） | transcript 投影（REVIEWER_MESSAGE_FETCH_LIMIT=120 + 预算裁剪） | 无上游保证能防漂移 | `runReviewerStream` 消费 | PermissionReviewer | observed（DB 失败现场） |
| provider 接受 `tool_choice:"required"` | OpenAI/Anthropic/GLM 等 OpenAI 兼容端点 | AI SDK 映射 `toolChoice:"required"` → wire `tool_choice` | streamText 请求 | runReviewerStream | reachable（llm.ts 同参数先例已在生产运行） |
| provider 400 拒绝 `tool_choice`（报文含该词） | service.ts:640-642 历史注释记载"Some OpenAI-compatible providers reject forced tool_choice" | 无（400 不被 SessionRetry 重试） | streamText error 事件 → Effect.fail | runReviewerStream | reachable（注释即仓库内证据；本次兼容分支由用户显式授权） |
| provider 400 与 tool_choice 无关（如 Codex instructions/max_output_tokens） | 既有 fixture 复现 400 wire 形态（reviewer-service.test.ts:805-820） | — | 同上 | runReviewerStream | reachable（"无关 400 → 不重发"的行为锁由新测 D 建立；既有 fixture 只锁 400 wire 形态与 plugin 清参路径） |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 评审终态只能是：可解析决策（tool_call/json_fallback）或既有 3-attempt fail-closed/fallback_user；工具 Part 终态与 message 终态同收 | 仓库规则（fail-closed 历史门禁）；schema.ts:13-15 | prompt.test.ts:1834/1904；reviewer-service.test.ts closure 组 |
| INV-02 | reviewer 的 provider 请求必须在 API 层约束决策工具提交（`toolChoice:"required"`），先例为 prompt.ts:3194；provider 已知拒绝（INV-03 触发过）的进程内除外 | 用户原话 R-REQ-1 + 先例 observed | 本计划新增（当前无） |
| INV-03 | provider 以 400 且报文指向 tool_choice 拒绝时，同次评审去参重发一次；该 provider 进程内后续评审不再强制 | 用户原话 R-REQ-2 | 本计划新增（当前无） |
| INV-04 | 正常路径 user prompt 尾部（planned action 之后）携带决策入口指令：立即以 permission_review_decision 提交一次决策；信息不足映射为结构化 deny/unknown 而非提问 | 用户原话 R-REQ-3 + DB 失败形态（反问/自认无法执行） | 本计划新增（当前无） |
| INV-05 | 协议重试 nudge 采用 avoid-xxx 防御纵深语义，并显式给出裸 JSON 逃生口 | 用户原话 R-REQ-4 + DB 证据（flash 2 次仅靠 json_fallback 救回） | prompt.test.ts:1834（nudge 行为结构已锁；文本断言本计划新增） |
| INV-06 | 与 tool_choice 无关的 400 不得被去参重发掩盖（仍按现行为失败） | 既有兼容 fixture 语义 | reviewer-service.test.ts:805-820 模式，本计划新增反例 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `runReviewerStream` 构造 streamText 请求（service.ts:609-648）时不传 `toolChoice`——决策工具提交完全依赖模型自觉；:640-642 注释记录了因"部分 provider 拒绝"而全局放弃强制的历史取舍 | `PermissionReviewer.runReviewerStream` | DB 失败现场 6/6 prose；同模型 296 次成功证明非能力缺失，属请求形状缺约束 |
| INV-04 | `buildUserPromptItems`（prompt.ts:49-71）最后一个 item 是 planned-action JSON——输出契约只存在于 system prompt，user message 尾部（小模型权重最高处）没有任何决策指令 | `PermissionReviewerPrompt.buildUserPromptItems` | 失败 attempt 的 reasoning 显示模型把输入当成"用户求助/要求执行" |
| INV-05 | `PROTOCOL_RETRY_USER_ITEM`（service.ts:83-89）只说"不要 prose"，未阻断反问/自认无能力形态，且按 :85-87 注释刻意不宣传 JSON 逃生口——观测证据表明该形态恰是可救回路径 | `PermissionReviewer`（service.ts 常量） | DB：review-1 第 3 次尝试靠裸 JSON 文本救回；review-2 纯 prose 耗尽 |
| INV-03（非 persist seam 前置） | NF-1：非 persist 早退分支吞掉 `error` 事件（:708-716），provider 400 无法以原始 APICallError 形状到达 catchIf——兼容重发在该 seam 上结构不可达 | `runReviewerStream` 消费循环 `!persist` 分支 | R5 插桩实证（§4 NF-1 行） |

Red-capable feedback loop（bug 类，捕获原始症状）：

- 命令（packages/opencode 目录）：`bun test test/session/prompt.test.ts -t "auto permission reviewer fails closed after two malformed protocol retries"`
- 症状：reviewer 连续输出 prose（不调工具）→ 3 次耗尽 → `reviewer did not call permission_review_decision` fail-closed。
- 该测试即用户事故的受控最小复现（llm mock `reply().text(...)` 三连），当前绿——作为"不破坏 fail-closed"的回归锚点；新增行为的红测见 §16。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| reviewer 请求形状（toolChoice） | `runReviewerStream` | 构造并发起评审的 provider 请求 | 请求在此组装；llm.ts 通道只服务主会话 SessionPrompt，reviewer 刻意独立（安全边界注释 service.ts:572-584） | `SessionPrompt`/`llm.ts` 不承载 reviewer 请求；不能为 reviewer 改主会话通道 |
| tool_choice 400 兼容重发 + provider 能力记忆 | `runReviewerStreamWithToolChoice`（`runReviewerAgent` 内私有协商入口）+ 层闭包 Set | 用户显式授权的同次去参重发一次 | 400 在本 seam 产生；SessionRetry 按契约只管 429/5xx | `SessionRetry` 明确不重试 400（retry.ts 分类）；Plugin hooks 不应感知 reviewer 内部参数协商 |
| 决策入口尾指令 | `PermissionReviewerPrompt` | 组装 reviewer prompt items | user prompt items 的唯一 owner | service.ts 只消费 items，不拼装 |
| nudge 文案 | `service.ts` 常量 | 协议错误重试的追加 user item | 已有常量即 owner | prompt.ts 只管正常路径组装 |

## 10. Single Approved Primary-Path Design

一条权威路径：**把"是否调决策工具"的决定权从模型移到 harness 请求层，并在 prompt 两端（正常入口 + 异常 nudge）补齐决策指令**。

```text
runReviewerStream 增参 forcedToolChoice: boolean（函数本身已可重入：每次调用自建
AbortController + streamText + SessionRetry，调用点仅 runReviewerAgent 内 :416/:462 两处）

新增私有协商入口（两调用点共用，owner 不变）：
runReviewerStreamWithToolChoice(messages, model, persist?)
  = runReviewerStream(messages, model, persist, !toolChoiceRejectedProviders.has(providerID))
      .pipe(
        Effect.catchIf(isToolChoiceRejection, () => {              [仅 400 + 报文含 tool_choice]
          toolChoiceRejectedProviders.add(providerID)                [层闭包 Set]
          return runReviewerStream(messages, model, persist, false)  [用户授权的兼容重发，恰一次]
        }),
      )
streamText(..., toolChoice: forcedToolChoice ? "required" : undefined)

runReviewerAgent :462 persist 路径：tapError/onInterrupt 管道接在协商入口之外——
tool_choice 400 被内层 catchIf 消化，不会触发 message error 终态写入；重发成功后
同一 child message 行正常完成（首次 400 无任何 stream 事件/parts 落库）。
```

- `isToolChoiceRejection(error)`：`statusCode === 400 && /tool[_ ]?choice/i.test(responseBody ?? "")`。与 tool_choice 无关的 400（instructions/max_output_tokens）不匹配 → 原样失败，维持既有行为（INV-06）。检测用 `errorMessage` 已提取的 `responseBody`（service.ts:1092-1100）同源数据 + `statusCode`。
- 重发安全性：400 在任何 stream 事件前发生——首次调用无 parts 落库、`safeFinalize` 无开放 Tool 可闭合（no-op）；第二次调用重建 AbortController/streamText/SessionRetry（与既有无 persist→persist 两次独立调用的生命周期同构），persist 路径复用同一 child message 行正常完成；`runReviewerAgent` 的 `tapError` 只在整体失败时写 message error。
- 不做 `runConsume` 式大段搬移：`runReviewerStream` 函数粒度已提供全部所需重入语义（R2 审计 B-01 采纳：~330 行机械移动会以 churn 口径冲破用户 ≤500 行生产修改预算，且自造零语义回归面）。
- **NF-1 修复（R5 新增，INV-03 在非 persist seam 的前置条件）**：`!persist` 早退分支补一行 `if (event.type === "error") return yield* Effect.fail(event.error)`——与 persist 分支（:878-884）及其"保持原始 shape 直到 SessionRetry 分类"注释语义对齐。行为影响仅限非 persist 路径的 provider 错误分类：原先被吞成协议错误盲重试 3 次，现以原始错误形状立即进入 SessionRetry 分类（429/5xx 可重试、其余直接失败）——即把 §5 原先错误声明为已有的行为在缺失分支上补齐，非新概念。
- 生产文件 2 个：`service.ts`（增参 + 协商入口 ~14 行 + Set + `isToolChoiceRejection` + nudge 常量）、`prompt.ts`（system 契约增补 + 尾部决策指令 item）。

**为何修复 first divergence**：INV-02 的根因是请求形状缺约束——`toolChoice:"required"` 在 provider 解码层排除 prose 输出的可能（模型"自以为调用不了"不再相关：它没有不调的自由）；INV-03 是用户对历史"全局放弃强制"取舍（:640-642 注释）的显式替代——把"部分 provider 拒绝"从全局禁用收窄为按 provider 运行时探测 + 单次兼容重发；INV-04/05 在 prompt 层补齐漂移场景的决策指令与逃生口。三者共同把"依赖模型自觉"替换为"harness 约束"。

**Secondary path 分类**（§11 全列）。compat 重发是**用户显式授权的兼容分支**（原话："如果拒绝该参数，则兼容性地重发一次"），quoted authorization 记录于 §1 R-REQ-2；它不是失败后的备用成功路径——去参重发仍是同一 primary 请求路径的兼容参数协商，且恰一次、带进程内能力记忆防重复付费。

设计注释更新（有意为之，非夹带）：service.ts:85-87"nudge 不宣传 JSON fallback"与 :640-642"不强制 tool_choice"两条历史注释分别被 INV-05（DB 证据：json_fallback 是漂移场景实测可救回路径）与 INV-02/03（用户显式取舍）取代，随 diff 同步改写，不留过时注释。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| tool_call 决策 | current | primary-contract branch | yes | 主 | preserve |
| json_fallback 文本 JSON | current（shipped compatibility） | existing compatibility | yes | 既有 | preserve（不改） |
| 协议错误 3-attempt retry + hidden | current | primary-contract branch（诊断驱动重试） | 间接 | 既有 | preserve |
| tool_choice 400 去参重发一次 + provider Set | proposed | explicit user-requested compatibility（§1 R-REQ-2 原话授权） | yes（同一 primary 路径） | 新增分支 1 条 + Set 读写 2 处 | add |
| timeout 重试（保持原 prompt） | current | primary-contract branch | 间接 | 既有 | preserve |
| nudge 升级（avoid-xxx + JSON 逃生口） | proposed | 用户授权的 prompt 内容变更 | 间接 | 文案，不计分支 | add |
| 与 tool_choice 无关 400 → 原样失败 | current | diagnostic（fail-closed） | no | 既有 | preserve（INV-06 反例锁定） |

新增决策面：1 条 catchIf 兼容分支 + 1 个 Set 记忆。该分支为用户原话授权的兼容路径（R-REQ-2），不属 fallback/诊断面，不受 10% 诊断预算约束；无任何未分类成功路径。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| :640-642 "全局不强制 tool_choice" 注释性取舍 | 部分 provider 拒绝 forced tool_choice | INV-03 按 provider 探测 + 单次兼容重发，把全局放弃收窄为按 provider 降级 | service.ts:640-642 注释随 diff 改写为新语义 |
| `prompt.test.ts:1735` `tool_choice` 不为 required 断言 | 上述取舍的测试级锁（reviewer-only 测试，`inputs[0]` 即 reviewer 请求） | INV-02 反转该行为后断言同步反转为 `toBe("required")`（属预期行为变更，非回归） | prompt.test.ts:1735 断言反转 |
| :85-87 "nudge 不宣传 JSON fallback" 注释 | 保持 tool 协议优先 | DB 证据表明漂移场景裸 JSON 是实测可救回形态；用户授权防御纵深 nudge | service.ts:85-88 注释改写 |
| `prompt.ts:27-30` "provider tool forcing is intentionally not required" 注释 | 与 :640-642 同源的"不强制"取舍在 prompt 模块的记载 | INV-02/03 反转同一取舍，注释同步改写以免过时（R4 审计 N-01 吸收） | prompt.ts:27-30 注释随 diff 改写 |

无代码级 workaround 需删除（历史取舍以注释形态存在）。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| R-REQ-1 / INV-02 | streamText toolChoice:"required" | service.ts `runReviewerStream` 增参 + 协商入口 | reviewer-service 新测 A：wire body `tool_choice === "required"`；prompt.test.ts:1735 断言反转为 `toBe("required")`（reviewer-only 集成面同步） |
| R-REQ-2 / INV-03 | catchIf → Set → 去参重发 | service.ts | reviewer-service 新测 B（非 persist 单元面：400→重发成功+body 无 tool_choice）+ C（同层第二次评审首发即无 tool_choice）+ G（persist 生产常规面：见 §16-7） |
| INV-06 | isToolChoiceRejection 仅匹配 400+报文含 tool_choice | service.ts | reviewer-service 新测 D（无关 400 不重发，调用数 1，评审失败） |
| R-REQ-3 / INV-04 | OUTPUT_CONTRACT_PROMPT 增补 judge/禁问语义 + buildUserPromptItems 尾部指令 item | prompt.ts | reviewer-prompt 新测 E（last item 断言）；reviewer-prompt.test.ts:66 既有 system prompt 断言组扩展（含新语义短语） |
| R-REQ-4 / INV-05 | PROTOCOL_RETRY_USER_ITEM 新文案 | service.ts | prompt.test 既有 hides 用例扩展 F（第 2 次请求 user input 含 nudge 新标记 + avoid 语义） |
| INV-01（不回归） | — | 不改终态闭合逻辑 | 既有 prompt.test.ts:1834/1904 + reviewer-service closure 组原样跑绿 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| streamText toolChoice 参数 | R-REQ-1/INV-02 | 先例 prompt.ts:3194；DB 失败现场 | 现请求无任何 API 层约束；prompt-only 强制有观测失败尾部 |
| runConsume 抽取 | R-REQ-2 | （R3 已删除：R2 审计 B-01 证实 `runReviewerStream` 函数粒度已可重入，大段搬移属过度设计） | 已删除概念 |
| isToolChoiceRejection | R-REQ-2/INV-06 | service.ts:640 注释；fixture 400 先例 | SessionRetry 契约排除 400；errorMessage 不返回 statusCode |
| toolChoiceRejectedProviders Set | R-REQ-2 | 重发授权为"一次"，需防每审付费 400 | 无既有跨评审 provider 能力状态 |
| 决策入口尾指令 item | R-REQ-3/INV-04 | DB 失败 reasoning（反问/自认无法执行） | 现指令仅在 system prompt，user 尾部为 JSON blob |
| nudge 新文案 | R-REQ-4/INV-05 | DB：2 次 json_fallback 救回 + 纯 prose 耗尽 | 现文案未阻断反问形态、无逃生口 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/permission/reviewer/service.ts` | modify | ① `runReviewerStream` 增 `forcedToolChoice` 参数（streamText 增 `toolChoice` 三元）；② 新增私有 `runReviewerStreamWithToolChoice` 协商入口（catchIf 恰一次去参重发，两调用点共用）；③ 层闭包 `toolChoiceRejectedProviders` Set；④ `isToolChoiceRejection` 检测；⑤ `PROTOCOL_RETRY_USER_ITEM` 新文案 + 两条历史注释改写；⑥ NF-1 修复：`!persist` 早退分支补 error 事件传播（+1 行 fail + 注释）。无大段搬移 | +46 / -10（净增 ~36） |
| `packages/opencode/src/permission/reviewer/prompt.ts` | modify | ① 新增 `DECISION_DIRECTIVE_USER_ITEM` 常量；② `buildUserPromptItems` 末尾追加；③ `OUTPUT_CONTRACT_PROMPT` 增补 judge 角色/禁止提问/信息不足→结构化 deny 语义（R-REQ-3a）；④ 相应中文注释 | +26 / -2 |
| `packages/opencode/test/permission/reviewer-service.test.ts` | modify（测试） | `ReviewerRequestBody` 增 `tool_choice` 字段；fixture 增 `rejectToolChoice` 选项（复用 :805-820 400 模式）；新测 A-D；新增 `reviewerPersistResendFixture`（复用 :744-768 session mock 形态）+ 新测 G | +165 |
| `packages/opencode/test/permission/reviewer-prompt.test.ts` | modify（测试） | 新测 E：last user item 断言；system prompt 新语义短语断言（扩既有 :66 组） | +24 |
| `packages/opencode/test/session/prompt.test.ts` | modify（测试） | 既有 hides 用例扩展 F：断言第 2 次 reviewer 请求含新 nudge 标记；`:1735` 断言反转为 `toBe("required")`（reviewer-only 面，随 INV-02 同步） | +14 / -1 |

生产文件 2 个（≤5 ✅），生产净增 ~58 行（≤500 ✅，churn 与净增同量级——无大段搬移）。

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 (E) | `buildUserPromptItems(...)` 最后一个 item 为决策指令（含 `permission_review_decision`、"insufficient evidence"→deny/unknown 语义、禁止提问）；system prompt 含 judge/禁问新语义短语 | 现最后 item 是 planned action；OUTPUT_CONTRACT_PROMPT 无该语义 | prompt.ts 追加指令 item + system 契约增补 | reviewer-prompt 既有结构断言不破坏 |
| 2 (A) | reviewer 请求 wire body `tool_choice === "required"`；prompt.test.ts:1735 集成面同步反转为 `toBe("required")` | streamText 无 toolChoice；:1735 现锁为 not.toBe("required") | service.ts ①（增参+三元）+ :1735 断言反转 | — |
| 3 (B) | fixture 对含 `tool_choice` 的请求回 400（body 含 "tool_choice"）→ 决策仍成功；`bodies[0].tool_choice==="required"`、`bodies[1].tool_choice===undefined` | 无兼容重发 | service.ts ②③④ | 既有 400 fixture 语义（instructions/max_output_tokens）不被误伤 |
| 4 (C) | 同一 layer 内第二次 review：首个请求即无 `tool_choice` | 无能力记忆 | Set 生效 | 重发恰一次的边界 |
| 5 (D) | 400 body 不含 tool_choice（复现 requireInstructions 形态）→ 不去参重发，评审按现行为失败（calls 不增） | —（回归锁） | isToolChoiceRejection 窄匹配 | INV-06 |
| 6 (F) | 协议重试第 2 次请求 user input 含新 nudge 标记（如 "avoid" 语义短语 + JSON 逃生口字段名） | nudge 文案旧 | service.ts ⑤ | prompt.test:1834 hidden/计数断言原样 |
| 7 (G) | **persist 路径兼容重发**：reviewInput 带 sessionID（生产常规路径，message 行先建、tapError/onInterrupt 在协商入口之外）；fixture 对含 `tool_choice` 的请求回 400（报文含 tool_choice），无参请求回决策流 → 决策成功；`bodies[0].tool_choice==="required"`、`bodies[1]` 无该参；捕获的 child assistant message 达到 `finish="tool-calls"` 且 `error===undefined`（首次 400 不写伪 error 终态，不双终态化复用行） | 现无兼容重发；且 reviewerFixture（空 session mock、无 sessionID）结构上触达不了 :462 persist 分支 | service.ts ② 于 :462 调用点 | 首次 400 与重发的消息行生命周期（§20 风险 2 的实际兜底） |
| 8 | 既有 fail-closed 与 closure 组全量回归 | — | — | INV-01 |

公开 seam：reviewer 的 provider wire request（fixture 捕获）与 prompt item 构造函数——均为现有公开测试面，无私有方法断言。红测均先跑红（当前代码 A-E/G 七类断言必失败，D 为防御性回归锁无红态）。测 G 落在 persist 能力 fixture：新增 `reviewerPersistResendFixture`，session mock 复用 `reviewerClosureFixture`（:744-768）已验证的 `get/children/create/updateMessage(捕获写入)/getPart/updatePart` 形态——该形态已被现有 closure 组绿灯证明足以走通 :462 persist 分支。约束（R4 审计 N-03 吸收）：`toolChoiceRejectedProviders` Set 在层闭包内存活、跨同一 fixture 的多个 `it` 共享——测 A（首发必有 tool_choice）与测 B/C（需要 Set 已被 400 污染）必须使用互不共享的 fixture 实例，禁止顺序耦合。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~62 | service.ts +46/-10 与 prompt.ts +26/-2 的净差（≈62）；排除注释、空行；无搬移 | 
| Required Chinese explanatory comments `C` | ≥ 10（计划 13） | `ceil(62×0.15)=10` |

需中文注释点：① toolChoice 强制的取舍变更原因（替代 :640 注释）与先例引用；② isToolChoiceRejection 窄匹配边界（为何必须 400+报文含 tool_choice）；③ Set 的进程内生命周期与"恰一次重发"边界；④ 兼容重发首次 400 无 parts 落库的安全性依据；⑤ nudge 文案变更理由（json_fallback 实测证据 + 用户授权）；⑥ prompt.ts 指令 item 的 recency 依据与"信息不足→结构化 deny"映射；⑦ system 契约增补与尾指令的分工（R-REQ-3a/3b）；⑧ fixture `rejectToolChoice` 复现的生产 400 形态说明；⑨（R5）NF-1 修复的原因：非 persist 分支必须与 persist 分支同样传播 error 事件，否则 provider 400 被吞成协议错误盲重试，兼容重发在该 seam 不可达。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/permission/reviewer-prompt.test.ts` | packages/opencode | 测 E 绿 + 既有 prompt 断言不回归 |
| `bun test test/permission/reviewer-service.test.ts` | packages/opencode | 测 A-D 绿 + closure/token 组不回归 |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | 测 F 绿 + fails-closed/hides/json_fallback 集成不回归 |
| `bun test test/session/prompt.test.ts` | packages/opencode | 全文件回归；`:1735` 为 reviewer-only 集成面，随 INV-02 反转为 `toBe("required")` 后全绿（该测试单 push 即 reviewer 请求，非主会话通道） |
| `bun typecheck` | packages/opencode | 类型门禁 |

原始反馈环（§8）在全部改动后必须仍绿——证明 fail-closed 语义未被削弱。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified（production） | 2 | service.ts + prompt.ts，用户 ≤5 约束 |
| Files deleted | 0 | — |
| Production lines | ~58（净；无大段搬移，churn ≈ 净） | 甜点级：每概念最小承载；采纳 R2 审计 B-01 后消除 ~330 行机械移动 |
| Test lines | ~198 | 8 个新断言面（含 persist 重发 G）+ fixture 选项 + :1735 反转 |
| Generated lines | 0 | 不触 SDK/生成物 |

## 20. Real Risks and Open Decisions

### Real risks（observed/reachable）

1. **强制 tool_choice 与 reasoning 模型交互未知**：某 provider 可能接受参数但改变推理行为——可达但未观测；兼容分支只在显式 400 时触发，不对此推测加配置或分支。
2. **persist 路径重发的消息行复用**：首次 400 无事件落库的前提下二次调用写同一 child message 行——由新测 G（§16-7）断言决策成功且 child message `finish="tool-calls"`、无 error 终态兜底；风险面收缩到协商入口 ~14 行。
3. **nudge 宣传 JSON 逃生口与 tool 优先的张力**：可能略微提高 json_fallback 占比（决策源可观测，metadata.source 区分，不损审计）。

### Open Decisions Requiring the User

无——四项要求用户已逐项授权；无新增产品/策略选择。

### Rejected Speculation

- "provider 可能 400 报文不含 tool_choice 字样却确因它拒绝"——未观测；窄匹配保守处理，残余场景走既有 3-attempt/fail-closed，不加宽匹配。
- "按 provider 预置能力表"——推测性配置面，被运行时探测 + Set 取代。
- "重试间加退避/增加次数"——用户明确排除。

## 21. Audit Contract

独立审计员必须：读取本文件与原始需求；从仓库证据重建行为；把 builder 摘要视为不可信；每轮审计完整原始范围；每个 blocking finding 附证据；同时检查 under-design 与 over-design；检查根因修复、fallback、owner、测试、代码质量与 15% 中文注释计划。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01：`prompt.test.ts:1735` 是「reviewer 不强制 tool_choice」的可执行测试锁（reviewer-only 测试，`inputs[0]` 即 reviewer 请求），INV-02 必然使其翻红；R1 误将其归为"主会话契约不回归"且未排期反转，验证合同自相矛盾 | N-01：§11 决策面占比口径矛盾（<30% vs 10% 禁线）；N-02：R-REQ-3 "也就是系统的 prompt" 落点未显式记录；N-03：测试行数估算缺 :1735 反转 | BLOCK（修订 R2：§1 R-REQ-3 双落点显式化；§4 补 :1697-1735 证据；§12 增测试锁反转行；§13/§15/§16/§17/§18/§19 同步排期与口径修正） | task ses_fa2ca1f51ffenWSfEM4YD6XlPC |
| 2 | R2 | yes | B-01：§14「现结构单次消费无法重入」为假——`runReviewerStream`（service.ts:499，调用点仅 :416/:462）本身可参数化重入实现同一去参重发；runConsume ~330 行纯搬移以 churn 口径冲撞用户 ≤500 行生产修改预算并自造零语义回归面 | N-01：§6 行 5 evidence-class 高估；N-02：§11 严格口径算术句松动；N-03：§19 未并列 churn 口径 | BLOCK（修订 R3：删除 runConsume 概念，改为 `runReviewerStream` 增参 + 私有协商入口 `runReviewerStreamWithToolChoice`；§6/§10/§11/§14/§15/§17/§19/§20 同步） | task ses_fa2bd5350ffeRIyylyZ46qX77G |
| 3 | R3 | yes | B-01：兼容重发的全部排期测试（B/C）落在 `reviewerFixture`（sessionLayer 为空 mock `Layer.mock(Session.Service)({})`，:56；reviewInput 均不带 sessionID），结构上只能触达非 persist 调用点 :416；生产常规路径（sessionID ⇒ :462 persist 分支）的重发与消息行复用无排期切片，而 §20 风险 2 声称由新测 B 兜底——该断言在排期 fixture 上不可产生，验证合同自相矛盾 | N-01：§16 slice 2/§13 引用粒度（测 A 绿只需 ①）；N-02：§2 非目标归属"用户明确排除"无逐字需求依据；N-03：§15 prompt.test.ts +9/-1 估算偏紧 | BLOCK（修订 R4：新增 persist 路径重发切片 G（reviewerPersistResendFixture 复用 :744-768 session mock 形态）；§13/§15/§16/§19/§20 同步；§2 归属改写；引用粒度修正） | task ses_fa2aec1f7ffeORzC8VpcH1IdMC |
| 4 | R4 | yes | 无 | N-01：§12 未列 `prompt.ts:27-30` 过时注释；N-02：§17 `E` 算式松散；N-03：层闭包 Set 跨 `it` 持久需分 fixture 实例 | APPROVE | task ses_fa2a3ae55ffe9WfrLTePn2cyiX |
| 5 | R5 | yes | 无 | N-01：§4/§5/§8/§12 部分行以实施前基线描述当前树（实施中途的合法产物，随 §23 在飞状态标注修正）；N-02：§16 称测 D 无红态——实际当前红（NF-1 使无关 400 变 3 次盲重试），红态反而强化回归锁；N-03：行号引用相对 HEAD 锚定漂移（元数据） | APPROVE（仅限 R5；N-01 记录修正随本 verdict 一并完成） | task ses_fa280d829ffeTTA4UqtYZsdcFx |
## 23. Implementation Evidence

### Actual Files and Diff

生产（2 文件，+72/-14，净 +58——与 §15 估算一致）：
- `packages/opencode/src/permission/reviewer/service.ts` +54/-9：① forcedToolChoice 参数 + streamText toolChoice 三元；② runReviewerStreamWithToolChoice 协商入口（catchIf 恰一次去参重发，两调用点改走此入口）；③ 层闭包 toolChoiceRejectedProviders Set；④ isToolChoiceRejection 窄匹配（400+报文含 tool_choice）；⑤ PROTOCOL_RETRY_USER_ITEM 新文案 + :85-88/:640 注释改写；⑥ NF-1：!persist 分支 error 事件传播。
- `packages/opencode/src/permission/reviewer/prompt.ts` +18/-5：OUTPUT_CONTRACT_PROMPT judge/禁问/信息不足→deny 语义（R-REQ-3a）+ DECISION_DIRECTIVE_USER_ITEM 尾部指令（R-REQ-3b）+ :27-30 过时注释改写。

测试（3 文件，+233/-2）：reviewer-service（fixture rejectToolChoice/Unrelated 选项、reviewerPersistResendFixture、测 A-D/G）；reviewer-prompt（测 E）；prompt.test（hides 扩展 F、:1735 反转）。

### Red-Green Test Evidence

- E：先红（items[last-2] 为 transcript、指令项缺失）→ 绿（19/19）。
- A：先红（body.tool_choice undefined）→ 绿；prompt.test:1735 反转后集成组绿。
- B/C：先红（无重发，review 失败为 FallbackToUser / bodies 断言失败）→ 绿。
- D：先红（NF-1：无关 400 被吞成协议错误盲重试 ×3，Expected 1 Received 3）→ 绿（1 次、评审失败）。D 的红态即 NF-1 实证。
- F：先红（"Avoid prose, questions" 不在第 2 次请求）→ 绿。
- G：无独立红运行记录（写入时协商机制已实现）；其目标机制（兼容重发）的红态由 B 覆盖，persist 面差异（message 行复用无伪 error 终态）由 G 断言锁定。诚实披露于此。
- 实施中发现并吸收的事实：① NF-1（非 persist 分支吞 error 事件，R5 已审）；② SDK 在 toolChoice 未强制时默认发 tool_choice:"auto"——fixture 触发条件因此从 `!== undefined` 修正为 `=== "required"`（与生产一致：今日请求同形且被 provider 接受），B/C 断言相应为 `not.toBe("required")` 语义锁定。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/permission/reviewer-prompt.test.ts` | packages/opencode | 19 pass / 0 fail |
| `bun test test/permission/reviewer-service.test.ts` | packages/opencode | 22 pass / 0 fail |
| `bun test test/session/prompt.test.ts -t "auto permission reviewer"` | packages/opencode | 8 pass / 0 fail |
| `bun test test/session/prompt.test.ts` | packages/opencode | 96 pass / 14 skip / 0 fail |
| `bun typecheck` | packages/opencode | clean（tsgo --noEmit 无错误） |

### Original Feedback-Loop Result

§8 原始反馈环（`prompt.test.ts` "auto permission reviewer fails closed after two malformed protocol retries"）在全量运行中绿——fail-closed 语义未削弱；"hides malformed attempts" 同绿（hidden 结构 + calls 计数不变）。

### Actual Secondary and Replacement Path Inventory

新增决策面：streamText toolChoice 三元（1）、Set 查询/写入（2 处）、catchIf 兼容重发（1）、isToolChoiceRejection 窄匹配（1）——与 §11 分类一致；无未分类成功路径；json_fallback 原样保留。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 31 | 生产 diff 新增 69 行中扣除 38 行注释、0 空行；排除测试文件 |
| Qualifying Chinese comment lines `C` | 38 | 全部为贴邻修改点的 [local-smark] 中文解释（取舍反转、窄匹配、Set 生命周期、重发安全、nudge 理由、NF-1、双落点、fixture 形态） |
| Ratio `C / E` | 1.23 | — |
| Required minimum `C` | 5 | `ceil(31×0.15)=5` |

### Remaining Unverified Items

- 真实 provider（smark/GLM chat-completions 端点）对强制 tool_choice 的实机行为未验证：fixture 为 OpenAI Responses wire 形状；llm.ts 先例表明 chat 形状同样映射 tool_choice:"required"，且 400 拒绝场景由兼容重发覆盖；实机验证留给用户运行环境。
- 测 G 无独立红态（见 Red-Green 披露）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | 无 | N-01：测 G 无独立红运行（§23 已诚实披露，断言对改前代码可红，机制红态由 B 覆盖）；N-02：NF-1 关闭非 persist 路径「中途 error + 此前完整 JSON 文本」的 json_fallback 救回窗口（R5 已声明的行为对齐，persist 路径本就如此，非阻断）；N-03：新 nudge 文案仍含 "your previous reply was rejected" 而注释自证重试上下文为重建全新（措辞自洽性 nit，契约内容 avoid-xxx + JSON 逃生口已交付并经 wire 断言）；N-04：§23 E/C 仅按生产口径（31/38）计算，policy 口径含测试为 E=214/C=70=0.327，两种口径均过 0.10 阻断线与 0.15 目标 | APPROVE（独立复现：reviewer-service 22/0、reviewer-prompt 19/0、prompt.test 96 pass/14 skip/0 fail、typecheck clean） | task ses_fa25a46d3ffe0HRPzs3A4glO2u |
