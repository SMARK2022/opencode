# Canonical Implementation Plan: TUI Generate Session Title

> Status: verified
>
> Revision: R6
>
> Approved revision: R6
>
> Audit mode: full-scope
>
> Requirement source: 当前会话中关于 `/rename`、TUI 面板、`Generate` 与面板快捷键的逐字要求，见第 1 节
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-10

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户最初要求检查标题自动生成失败，随后明确把本任务推进为一个新的手动能力：

> 看看在现有的/rename以及TUI面板增加对应的自动标题的逻辑是否可行？

关于商业展示文案和快捷键，用户逐字要求：

> 但有一个商业的问题，就是这个 Generate Title，好像这个东西有点长了。我觉得要不然就是 Generate这么一个动词，但是你看一下这个快捷键应该配什么呢，就是在打开面板之后的快捷键。

用户随后确认方向并要求完整工作流：

> OK，下面请你按照相应的我们的完整的这个DOCS里面的Workflow的流程去走，也就是你要构建一个完整的Verified Play，以便后续进行实现。

本次 GOAL 参数中的目标终态最初逐字为：

> approved-plan-only

R6 获独立批准后，用户又明确要求“完整按照 workflow 中的逻辑去进行实施，也就是验证后实施的逻辑”，并把目标终态更新为：

> verified-implementation-and-commit

产品结论保持不变：在现有 `/rename` 打开的 Rename Session 面板和会话列表打开的同一面板中，以 `Generate` 为动作文案，以面板作用域内默认 `Ctrl+G` 为快捷键，显式调用 AI 生成并保存标题。后续实施仍严格使用 approved R6，不因终态授权变化修改设计。

R3 时用户新增并逐字要求最小侵入：

> 按照我的理解，整套逻辑应该是很简单的，就是做一些这个，大不了就是新增一个这个命令，然后新增一个端点，然后以及相应的绑定等等逻辑。然后按理来说，相应的什么标记算法都不需要你去实现，因为它已经有了。你大不了就是在原位置做一个封装以及 export 一下。然后巴拉巴拉的什么 title 那些东西，按理来说都应该有公共的一些 helper，或者公共的逻辑，把它按理来说只要做一些简单的接线，把它去做复用就 OK 了。所以你再看一下，按照我的理解，它整体，你如果真的要实施六百多行，我认为是过多的。你应该去想一想到底有没有这么必要。你可以去完整汇报一下相应的生产代码，修改了一个函数，大概准备修改多少行。我希望它整体尽量少地去操作，或者说侵入性的一些改动，一些各种各样的逻辑细节。就是尽量能复用尽量复用。如果你觉得复用有难度，你可以做封装，但是我的推荐是你尽量复用已有的逻辑，大不了去做封装或者说接口的一个 mock 修改，避免你去写两套这种 helper，然后再去实现两套东西，或者说直接把原来的那套东西直接删掉，然后再拉出来一个新的 helper 再接入原来的。这种各种各样的一些修改本身都是比较过于复杂的。你看一看相应的内容是否可以有效地被有效地去进行一个优化。也就是说，我希望整体的逻辑尽量你看一看能不能让相应的 hunk 数，还有相应的生产代码修改文件数最小。

因此 R3 明确放弃 R2 未实施的 `titleText` 抽取方案，改为在原 `title` 函数内增加手动触发选项并新增一个薄 public wrapper；以 6 个现有 production 文件、约 13 个局部 hunk、约 160 行有效生产改动为目标，不用牺牲已确认行为换取行数。

## 2. Explicit Non-Goals

- 不修复或规避 Provider 的 HTTP 429、超时、认证、配额或网络故障；手动路径必须如实显示失败。
- 不改变后台自动标题的触发时机、`retries: 2`、best-effort 语义或其 parent/default-title/exactly-one-real-user 限制。
- 不增加失败后自动重试标题、定时补偿、换模型、换 prompt、使用主 Agent 答案伪造标题或保留旧标题后返回成功等 fallback。
- 不增加新的 slash command、独立 Generate 面板、标题模型选择 payload、标题正文输入或配置开关。
- 不为并发标题写回新增 single-flight、CAS、版本向量、锁、跨进程协调或数据库迁移；保留当前 `Session.setTitle` 后写覆盖语义。
- 不把 Esc 解释为取消已经发出的 HTTP 请求；只防止晚到 UI 回调误操作后续面板。
- 不修改两个 Rename 入口的路由结构，不让它们各自实现生成算法。
- 不删除、搬移或重写现有标题算法，不新增 `titleText` 或另一套 helper；只允许在原 `title` 函数上封装并做必要接线。
- 不手改 `packages/client/src/generated*` 或 `packages/sdk/js/src/v2/gen`；不改变生成器的既有修补流程。
- 不把 legacy `/session` endpoint 复制到 Protocol `/api/session`，也不要求独立 ClientApi 新增同名方法；仍执行仓库规定的 Client 生成检查。
- 不更新与本单点功能无关的 ADR、领域词汇或 AGENTS 文档。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session、Agent、Provider、Message、Run state 与 Compaction 的责任词汇；标题必须基于 Session History，不能另造会话数据源。 |
| `AGENTS.md` | HttpApi 变化后在 `packages/client` 执行 `bun run generate`；legacy SDK 由 `packages/sdk/js/script/build.ts` 生成；测试/typecheck 必须从 package 目录运行；不得手改生成文件。 |
| `packages/opencode/AGENTS.md` | Effect service 形状、InstanceState 生命周期、命名 Effect、Schema typed error 与 Effect.cached 指导；不得嵌套 yield service。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | handler 稳定捕获服务；SDK 可见错误必须是显式 Schema error contract；domain error 在 handler 边界转换。 |
| `packages/opencode/test/AGENTS.md` | 使用 `testEffect`、真实 instance fixture、published readiness signal；不得用固定 sleep 猜测异步完成。 |
| `packages/opencode/test/server/AGENTS.md` | 保持真实 Effect HTTP stack、项目目录 fixture 和必要的双目录拓扑说明。 |
| `docs/adr/README.md` 及索引 | 唯一已接受 ADR 是 triage 标签共存，与本功能无关；本任务没有需要新 ADR 的跨模块长期政策选择。 |
| 现有 `DialogPrompt`/`DialogSessionRename` | 通用面板已有 busy、priority 1 binding、toast 与语音能力；Rename 已是两个入口的共享组件，必须复用。 |
| 现有 legacy HttpApi/OpenAPI/SDK 与独立 Protocol ClientApi | `Session.Info` 是已有标题读写公共表示；TUI 的新 endpoint 进入 legacy SDK。Client 生成器编译独立 Protocol `ClientApi`，本任务只运行其既定生成检查，不混用合同来源。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/prompt.ts:75-124,271-299,473-533,1565-1648,1900-1938,2444-2452` | 现有 Service interface、自动标题全部算法与 guard、active history 来源、后台 fork/导出；`deriveGoalTurn` 已用非 compaction/非 synthetic part 判定真实用户。 | observed |
| `packages/opencode/src/session/compaction.ts:770-800` 与 `message-v2.ts:761-775,1520-1571` | compaction-only marker 是 user technical Message 且位于 active window 前部；real 选择和 slice 前缀都必须排除它，否则转换成固定“What did we do so far?”；只有完成 summary 配对的 marker 才保留在 active window。 | reachable |
| `packages/opencode/src/session/session.ts:376-420,519-523,757-778,853-870` | `Session.get/messages/setTitle` 的公开合同、NotFound 和持久化 owner。 | contracted |
| `packages/opencode/src/session/message-v2.ts:652-704,1473-1588` | Provider 消息转换与 `filterCompactedEffect` 是现有 active Session History owner。 | contracted |
| `packages/opencode/src/agent/agent.ts:67,360-394,415` | `title` agent 可由用户配置 `disable`，所以缺失 agent 对手动公共入口可达。 | reachable |
| `packages/opencode/src/provider/provider.ts:1529-1535,2314,2383` | title agent 模型、小模型和当前用户模型的既有选择及 `ModelNotFoundError`。 | contracted |
| `packages/opencode/src/session/llm.ts:35-59` | 标题只能通过一次 `llm.stream`；stream error 类型为 `unknown`，手动 API 需在 domain/handler 边界显式转换。 | contracted |
| `packages/core/src/session/projector.ts` 与 `packages/opencode/src/event-v2-bridge.ts` | `Session.Updated` 持久化/桥接链和完整 Session 快照更新语义；没有现有标题 CAS。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:83-92,153-190,300-338` | Session path、update endpoint 与 OpenAPI annotation 的声明方式。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:62-90,124-137,268-289,672-709` | 稳定服务、`requireSession`、`inSessionDirectory` 和 handler 注册；跨目录操作必须绑定 Session 自身 directory。 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/errors.ts` | 可复用 `ApiNotFoundError`、`InvalidRequestError`、`ServiceUnavailableError`、`UpstreamError`，无需新 HTTP error 文件。 | contracted |
| `packages/tui/src/component/dialog-session-rename.tsx` | 当前只有 `session.update` 手动保存，是 Generate 的唯一共享接入点。 | observed |
| `packages/tui/src/routes/session/index.tsx` 与 `packages/tui/src/component/dialog-session-list.tsx` | 证明 `/rename` 当前会话入口与列表 rename 都复用上述组件。 | observed |
| `packages/tui/src/ui/dialog-prompt.tsx` | 可复用 busy/busyText、targeted priority 1 keymap、textarea 草稿和 footer；可选 action 必须避免影响其他 DialogPrompt。 | observed |
| `packages/tui/src/config/keybind.ts:141,205-228,438-481` | 全局 `messages_first=ctrl+g,home`、Dialog 定义位置和统一可覆盖 keybind contract。 | contracted |
| `packages/tui/src/keymap.tsx` 与 `packages/tui/src/context/sync.tsx:1020-1047` | 作用域 keymap 机制以及 `session.updated` 已能刷新标题，无需直接写 sync store。 | observed |
| `packages/tui/src/util/error.ts`、`packages/core/src/util/error-message.ts` | 现有 toast 可从 SDK error 或 transport Error 提取安全 message。 | observed |
| `packages/opencode/test/lib/llm-server.ts:458-714` | 标题请求目前固定返回 `E2E Title` 并绕过队列；需独立 title fixture queue，不能偷用主 Agent queue。 | observed |
| `packages/opencode/test/session/prompt.test.ts` | 真实 `SessionPrompt.Service`、持久化 user/assistant fixture、TestLLMServer 和 compaction 测试 seam。 | observed |
| `packages/opencode/test/server/httpapi-session.test.ts` | 真实 HTTP、跨目录 fixture、404/error contract 和 `createTextMessage` seam。 | observed |
| `packages/tui/test/cli/tui/dialog-prompt.test.tsx` | 真实 headless DialogPrompt/keymap/SDK provider 测试；当前 5 个测试是回归基线。 | observed |
| `packages/tui/test/cli/cmd/tui/dialog-session-list.test.tsx:660-789` | 已具备完整 SDK/Project/Sync/Dialog providers，可在同一真实组件树打开 Rename 面板并观察 transport/frame。 | observed |
| `packages/tui/test/fixture/tui-sdk.ts`、`tui-environment.tsx`、`tui-runtime.ts` | 真实 SDK transport 和 TUI 配置 fixture，不需 global mock。 | observed |
| `packages/client/script/build.ts`、`packages/client/src/contract.ts`、`packages/protocol/src/api.ts` | Client 生成器编译 `makeDefaultApi()` 的 Protocol ClientApi，而不是 legacy SessionApi；不能要求本次生成出现 `generateTitle`。 | observed |
| `packages/client/package.json`、`packages/sdk/js/package.json`、`packages/sdk/js/script/build.ts` | 两条独立生成链、typecheck 和 SDK build 的权威命令。 | contracted |
| `packages/opencode/test/server/httpapi-exercise/index.ts`、`routing.ts`、`dsl.ts`、`runner.ts` | 新公共路由必须有 scenario；LLM 场景必须 `.withLlm()` 并登记 `llmScenarios`，完整 coverage/auth/effect 门禁为 `test:httpapi`。 | contracted |
| `D:\Temp\opencode\dialog-ctrl-g-scope.test.tsx` | 外部隔离 keymap 实验，未修改仓库 production/test。 | observed |
| `C:\Users\Lenovo\.local\share\opencode\opencode.db`（只读）与 `log\opencode.log` | 先前症状是独立标题请求 429/SSE timeout，主 Agent loop 可成功；这解释需求来源，但不作为本功能的 Provider 修复授权。 | observed |

## 5. Current Behavior

后台自动命名：

```text
runLoop 读取 active Session History
  -> step === 1 时 fork ensureTitle
  -> parent/default-title/exactly-one-real-user guards
  -> title agent + small/current model + MessageV2.toModelMessagesEffect
  -> llm.stream(retries: 2)
  -> 清洗首条非空行并截断到 100 字符
  -> Session.setTitle
  -> Session.Updated/EventV2Bridge
  -> TUI Sync reconcile
```

该路径是 best-effort：调用处以 `Effect.ignore` fork；Provider 失败不阻断主 Agent loop。它没有公共手动重试方法。

手动 Rename：

```text
/rename 或会话列表 rename
  -> DialogSessionRename
  -> DialogPrompt onConfirm
  -> sdk.client.session.update(PATCH /session/:sessionID)
  -> Session.setTitle
  -> Session.Updated
```

这里没有 Generate action、生成 endpoint 或 SDK `generateTitle` 方法。TUI 的全局 `messages_first` 已使用 `Ctrl+G`，因此新 binding 必须只在提供 Generate action 的面板内生效。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 默认标题、非子 Session、恰好一条真实用户消息 | 正常首轮 prompt | runLoop 已选择 active history 与 lastUser model | 既有后台 `ensureTitle` | `SessionPrompt` | observed |
| 已有自定义标题或多条真实用户消息 | 后续 prompt、手动 rename | Session 持久化与 active history | 用户显式 Generate；不得被后台自动 guard 误拒 | `SessionPrompt.generateTitle` | contracted |
| 压缩后的 Session History | Compaction producer | `filterCompactedEffect` 负责 cutoff/hidden/order | 手动和自动都读取同一 active window | `MessageV2` + `SessionPrompt` | reachable |
| 只有 synthetic/技术消息或空 Session | Shell/system/compaction producer 或新 Session | 没有真实用户正文可摘要 | 显式 Generate 必须 400 且不写标题 | `SessionPrompt.TitleError` | reachable |
| 首条真实用户消息只有 subtask parts | Task tool | parts schema 保证 subtask prompt | 复用现有 onlySubtasks 标题输入 | `SessionPrompt` | observed |
| `title` agent 被配置禁用 | `Config.Agent.disable` | `Agent.Service.get("title")` 可返回空值 | 显式 Generate 必须 503，不得假装成功 | `SessionPrompt` + HTTP handler | reachable |
| 配置的 title/current model 不存在 | Agent/Session model config | `Provider.getModel` 返回 `ModelNotFoundError` | 显式 Generate 必须 503，不改用其他模型 | `SessionPrompt` + HTTP handler | reachable |
| Provider stream 失败 | LLM/网络 | stream error 为 unknown | 显式 Generate 必须 502、保留旧标题、UI toast | `SessionPrompt` + HTTP handler | observed |
| Provider 只返回空白/think 块 | LLM | 清洗后没有标题 | 显式 Generate 必须 502 且不写空标题；后台仍只放弃 | `SessionPrompt` | reachable |
| 生成首行超过 100 字符 | LLM | 无长度保证 | 复用既有 `97 + "..."` 截断 | `SessionPrompt` | observed |
| 缺失或已删除 Session | 公共 sessionID path | `Session.get` NotFound | endpoint 返回既有 404 contract | HTTP handler | contracted |
| 会话列表请求 ambient directory 与 Session directory 不同 | 跨目录 Session list | 持久化 Session 自带 directory | `inSessionDirectory` 后生成，不能读取错误实例 | HTTP handler | observed |
| 子 Session 有真实用户/subtask 输入 | Task/公共 API | 与 Rename 一样以 sessionID 定位 | 手动 Generate 不继承后台 parent guard | `SessionPrompt` | reachable |
| 面板配置其他 Generate key | TUI keybind config | `Keybinds.parse` 拒绝未知键、允许已声明键覆盖 | 新声明命令可独立重绑定 | `DialogPrompt` | contracted |
| 未提供 `onGenerate` 的其他 DialogPrompt | Goal/Provider/Plugin 等现有消费者 | 全局 messages_first 仍是 Ctrl+G | 不注册 Generate binding，全局行为不变 | `DialogPrompt` | reachable |
| Generate pending 时重复 Ctrl+G/Enter | 用户键盘输入 | `busy` 禁用 targeted bindings | 只能有一个面板请求，草稿不变 | `DialogPrompt` | reachable |
| Generate pending 时 Esc 并打开另一面板 | 用户与 Dialog stack | Promise 请求仍可完成 | 晚到回调不得 clear/toast 新面板 | `DialogSessionRename` | reachable |
| 自动与手动或多个手动请求并发 | 后台 fork/公共 HTTP | 当前完整行 Updated projector 无 CAS | 保持后写覆盖；不引入新一致性承诺 | `Session.setTitle` | reachable |

没有 speculative 行参与生产设计。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 后台自动命名仍只在首轮满足 parent/default/exactly-one-real-user 时 best-effort 执行，不阻塞主 Agent loop。 | 用户非目标 + `prompt.ts:473-533,1930-1936` | 无标题专项测试；新增 characterization。 |
| INV-02 | 用户可从两个 Rename 入口显式生成标题，即使当前标题已自定义或已有多条真实用户消息。 | 用户逐字需求 + 两入口共享组件 | 无。 |
| INV-03 | 手动与自动使用同一 active history、首个真实用户、subtask/model/message 转换、清洗和 100 字符规则；算法保留在原 `title` 函数，不抽取第二 helper。 | 现有算法只有一份 + 用户 R3 最小侵入要求 | 无标题专项测试。 |
| INV-04 | 成功只通过 `Session.setTitle` 持久化，并返回持久化后的 `Session.Info`；现有 Session.Updated 驱动 UI。 | Session owner 与 Sync consumer | update/sync 既有测试覆盖一般路径。 |
| INV-05 | 无真实用户、agent/model 不可用、Provider 失败或空输出都不是成功；旧标题不被这些失败改写，公共错误有明确 HTTP 合同。 | 可达输入与 HttpApi AGENTS | 无。 |
| INV-06 | Rename 面板显示 `Generate`，默认面板快捷键为 Ctrl+G；两个入口共享同一实现。 | 用户逐字文案/快捷键要求 | 无 Generate 测试。 |
| INV-07 | Generate key 可配置，并且只在有 `onGenerate` 的面板内优先于全局 messages_first；其他 DialogPrompt 不吞 Ctrl+G。 | keymap contract + 隔离实验 | 5 个 DialogPrompt 基线，无 Generate 项。 |
| INV-08 | pending 显示 `Generating…` 并阻止重复生成/提交；失败保留面板和草稿；卸载后的晚到响应不误关或提示后续面板。 | 现有 busy + 可达 Dialog 生命周期 | 无 Rename 异步测试。 |
| INV-09 | legacy Server HttpApi 是本 TUI 功能的唯一公共 wire 来源，legacy SDK 由既有 build 得到 `generateTitle`；独立 Protocol ClientApi 不被扩张，Client 只通过既定生成检查。 | AGENTS 生成规则 + Client/Protocol 源码 | legacy SDK build/typecheck；Client generate/test/typecheck。 |
| INV-10 | 跨目录会话操作在 Session 自身 directory 中解析 Provider、Agent、history 和持久化。 | `inSessionDirectory` 现有约束与跨目录入口 | 其他 Session action 有跨目录测试，标题无。 |
| INV-11 | 本功能没有备用生成算法、失败后的成功形结果或新的并发一致性路径。 | 第一性 policy + 非目标 | 行为失败测试 + diff audit。 |
| INV-12 | production 只修改 6 个既有文件，原 `title` 算法不搬移；按函数控制局部 hunk 和有效行数，目标约 13 hunks/160 行。 | 用户 R3 逐字要求 + 第 15.1 节函数预算 | 实施 diff/hunk 审计。 |

## 8. First Divergence and Root Cause

本任务是新能力，不把先前 Provider 429/timeout 误当作“手动 Generate 不存在”的根因。

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02/03 | 用户进入 Rename 后只能调用 `session.update`；从该公共动作无法到达现有标题算法。第一处缺失是 `SessionPrompt.Interface` 没有按 sessionID 生成并持久化标题的操作。 | `SessionPrompt.Service` | `dialog-session-rename.tsx:18-27` 与 `prompt.ts:271-285`；算法仅是 runLoop 私有 helper。 |
| INV-05 | 私有自动路径把空输出/agent 缺失作为无声返回、stream 作为后台忽略错误；直接暴露它会让手动用户无法区分失败与成功。 | `SessionPrompt` domain error + HttpApi handler | `prompt.ts:496-532`、`llm.ts:57-59`、HttpApi error 规则。 |
| INV-06/07/08 | `DialogPrompt` 只有 submit/voice commands，`DialogSessionRename` 只有 onConfirm，因此 Generate 没有可执行输入路径。 | `DialogPrompt` optional action + `DialogSessionRename` | 当前组件源码；全局 Ctrl+G 已存在。 |
| INV-09/10 | legacy Session HttpApi 没有 title generation endpoint，legacy SDK 因而不可能提供该方法；handler 若只使用 ambient directory 会破坏已有跨目录约束。 | legacy Session HttpApi group/handler | `groups/session.ts` 与 `handlers/session.ts` 没有该 endpoint；`inSessionDirectory` 已存在。 |

Feature feedback seam 是三层公共行为测试：直接调用 `SessionPrompt.generateTitle` 当前因方法不存在而 red；POST `/session/:sessionID/title` 当前为 404 而非 200；Rename 面板 Ctrl+G 当前不会发出 title POST。它们分别捕获用户能力缺失、wire 缺失和最终 UI 症状，不需要把本任务伪装成 bug regression。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| active Session History | `MessageV2.filterCompactedEffect` | 返回 Provider 当前保留的消息窗口 | 已有 cutoff/hidden/order 规则 | TUI/HTTP 不得读取 raw DB 后自行过滤。 |
| 标题生成算法 | `SessionPrompt` 现有私有 `title` 原函数 | 从首个真实用户生成一个清洗后的标题字符串 | 现有唯一算法、title agent/model/subtask/LLM 均在此；R3 不搬移它 | Session storage 不应调用 LLM；TUI 不应重建 prompt。 |
| 显式生成用例 | `SessionPrompt.Service.generateTitle` | 按 sessionID 加载并调用原 `title(manual: true)`，返回 Session.Info 或 typed failure | 消费者只需要薄 wrapper，自动路径仍调用同一原函数 | handler 不应拼接多个 domain 调用。 |
| 标题持久化 | `Session.setTitle` / `Session.get` | 保存标题、发布 Updated、读取最终快照 | 现有唯一 title writer | 新代码不得直接 update DB/sync store。 |
| 公共 wire/error | Session HttpApi group/handler | POST、Session.Info、404/400/503/502 typed errors | 公共 adapter 负责 wire 和 domain error 转换 | domain service 不依赖 HttpApi 类型。 |
| Session directory placement | `inSessionDirectory` | 用持久化 Session directory 提供实例上下文 | 已有 Session action 约束 | TUI 不应传 directory 让调用方猜测。 |
| Generate 键盘合同 | TuiKeybind + `DialogPrompt` | 可配置、可选、面板作用域的 action | 通用组件拥有 targeted keymap 和 busy | Rename 不应使用 raw keyboard 或全局快捷键。 |
| Rename 异步交互 | `DialogSessionRename` | 调用 SDK、toast、保持草稿、忽略卸载后的 UI 完成 | 只有该组件知道请求和 Dialog 生命周期 | 通用 DialogPrompt 不应知道 Session SDK。 |
| 客户端表示 | legacy SDK generator；独立 Client generator 仅作既有检查 | legacy SDK 从 legacy HttpApi/OpenAPI 生成方法和错误类型；Client 继续从 Protocol ClientApi 生成 | 两条合同来源独立，TUI 只消费 legacy SDK | 禁止手维护第二份 SDK 类型，也禁止为未使用的 Client 方法扩张 Protocol。 |

## 10. Single Approved Primary-Path Design

### 10.1 Domain operation

在 `packages/opencode/src/session/prompt.ts` 保留现有 `title` 函数及其全部算法位置，只在同一连续代码区域增加 `TitleError`、修改该函数并放一个薄 public wrapper：

```text
SessionPrompt.generateTitle(sessionID)            // 新 wrapper，约 10 行
  -> Session.get(sessionID)
  -> MessageV2.filterCompactedEffect(sessionID)
  -> 现有 title({ session, history, manual: true }) // 原函数，不抽取 titleText
  -> Session.Info

现有 title(input)                                  // 原函数，约 30 行有效调整
  -> manual 缺省时维持自动 parent/default/exactly-one guards
  -> manual=true 时跳过这三个触发 guard
  -> 沿用原 real-user/context/subtask/agent/model/message/LLM/cleanup 算法
  -> 失败时返回 TitleError，成功时通过原 Session.setTitle 写回
  -> manual=true 时 Session.get 返回最终快照；自动路径保持原日志和忽略边界
```

原函数的具体修改仅限：

1. input 增加可选 `manual`，providerID/modelID 可缺省；缺省时从已找到的 `firstInfo.model` 取值，避免 wrapper 重复 real-user 查找。
2. 三个自动 guard 改为 `!input.manual && ...`；无真实用户、agent 缺失、清洗后为空在原位置返回 `TitleError`，自动调用方仍由既有 `Effect.ignore` 忽略，所以可观察 best-effort 不变。
3. 原 `real` 就地改为 `role === "user"` 且 `parts.some(part => part.type !== "compaction" && !("synthetic" in part && part.synthetic))`。这与本文件 `deriveGoalTurn` 已有 userInitiated 技术边界一致，只改一个 predicate，不抽 helper、不改 Goal 逻辑；compaction-only 技术消息因此进入 no_user_message，混合真实 part 的消息仍是真实用户。原 `context = history.slice(0, idx + 1)` 同一语句再 `.filter(m => m.info.role !== "user" || m.parts.some(p => p.type !== "compaction"))`，只剔除 compaction-only user，保留 synthetic 文本、summary assistant、混合 part 和首个真实用户，防止 marker 经模型转换进入 Provider。`firstUser` 改为锚定未过滤的 `input.history[idx]`，过滤后的 `context` 只用于 Provider 转换，不能再从缩短后的 `context[idx]` 取用户。
4. 保留 title agent model -> small model -> first user model 的顺序，只在原模型解析边界把 `ModelNotFoundError` 转为 `TitleError(unavailable)`；不换模型。
5. 原 `Effect.orDie` 仅替换为 `TitleError(failed)` 的窄错误映射；`MessageV2.toModelMessagesEffect`、固定标题请求、单次 `llm.stream`、`retries: 2`、think 清理、首行和 100 字符规则均不搬移、不重写。
6. 写回处仅在 `manual=true` 时让 `setTitle` 错误传播并读取最终 Session.Info；自动分支保留原 `setTitle` 日志后返回当前 `input.session`，因此原函数始终有统一的 Session.Info 返回类型，不需要 cast、non-null assertion 或不可达成功 guard。

`TitleError` 是原函数附近新增的 `Schema.TaggedErrorClass`，字段为 `message` 和 `reason: "no_user_message" | "unavailable" | "failed"`。公开 interface 的错误联合为 `TitleError | Session.NotFound`。静态、安全的用户消息分别是：无真实用户可生成、标题生成当前不可用、标题生成失败/上游未返回标题；不暴露 raw provider body。

后台 runLoop 的调用形状保持原样，仍 fork 并 `Effect.ignore`。手动 public wrapper 不执行 parent/default/exactly-one 自动 guard，但也不复制 real-user predicate、模型选择、标题 prompt、cleaner 或持久化算法。

### 10.2 HTTP operation

在 SessionPaths 增加 `title: ${root}/:sessionID/title`，声明：

```text
POST /session/:sessionID/title
query: WorkspaceRoutingQuery
payload: none
success: Session.Info
errors: ApiNotFoundError | InvalidRequestError | ServiceUnavailableError | UpstreamError
OpenAPI identifier: session.generateTitle
```

handler 通过既有 `inSessionDirectory(sessionID, promptSvc.generateTitle(sessionID))` 执行，并注册为 `generateTitle`：

- Session NotFound -> 既有 `ApiNotFoundError`/404。
- `no_user_message` -> `InvalidRequestError`/400，`kind: "title"`。
- `unavailable` -> `ServiceUnavailableError`/503，`service: "session.title"`。
- `failed` -> `UpstreamError`/502，`service: "session.title"`。

错误转换只覆盖声明的 domain errors；storage defect 和未知 defect 不转换成成功，也不伪造 Upstream。成功响应来自生成后 `Session.get`，不是客户端提交一个标题。

同时在 `test/server/httpapi-exercise/index.ts` 登记 `session.generateTitle`：protected POST `/session/{sessionID}/title`、`.mutating().withLlm()`，seed 一个 Session 和真实用户消息，断言 200/`E2E Title` 且 `sessionGet` 已持久化，并把场景名加入 `llmScenarios`。`.withLlm()` 已提供 `small_model=test/test-model`，不需要扩张 ScenarioContext 或改写用户 model fixture。该 scenario 是 coverage/auth/effect 三种 `test:httpapi` 模式的同一路由所有者。

### 10.3 TUI operation

- 在 `TuiKeybind.Definitions` 声明 `"dialog.prompt.generate" = "ctrl+g"`，走现有 parse/override/which-key 体系。
- `DialogPromptProps` 增加可选 `onGenerate?: () => void`；读取对应 shortcut，注册 command，但仅当 prop 存在时把该 command 加入 `gather("dialog.prompt", ...)`。没有 prop 的现有面板不注册此 binding。
- footer 仅在 `onGenerate` 存在时显示 `<shortcut> Generate`；busy 时沿用现有 processing/spinner 展示。
- `DialogSessionRename` 传入 `onGenerate`，以 `generating` signal 驱动 `busy={generating()}` 和 `busyText="Generating…"`。
- 调用生成后的 `sdk.client.session.generateTitle({ sessionID: props.session })`，保持 SDK 默认 `throwOnError: false`，同时用 `.catch` 把 transport rejection 纳入同一失败终态。
- 成功时 `dialog.clear()`，标题由既有 Session.Updated/Sync 刷新；不再发 PATCH，不直接写 sync store。
- HTTP error 或 transport error 时用现有 `useToast` + `errorMessage` 显示错误，保持面板和 textarea 草稿，并恢复非 busy。
- `onCleanup` 记录组件已卸载。Promise 完成后若已卸载，不执行 `dialog.clear`、toast 或 signal 更新；服务端请求不伪称取消。

两个现有 caller 不传新 prop，因为它们已经渲染共享 `DialogSessionRename`；不需要修改 caller 文件。

### 10.4 Legacy SDK generation and independent Client check

公共 legacy group 批准后：

1. 在 `packages/sdk/js` 执行 `bun run build`，保留脚本已有 OpenAPI 修剪、numeric history patch、SSE patch、prettier 和 tsc；这里必须出现 `session.generateTitle`。
2. 按 AGENTS 要求在 `packages/client` 执行 `bun run generate`。该生成器从 Protocol `ClientApi` 编译，本任务不修改 Protocol，因此不得期待或手工制造 Client 的 `generateTitle`。
3. 审查 legacy 生成 diff 只包含新 title endpoint 及其引用错误/类型和生成器规范化结果；Client 不应出现本任务的 title 方法 diff。两条链都不得手改。

### 10.5 Why this repairs the first divergence

用户在 Rename 的单一动作现在能直接进入拥有历史、模型和持久化责任的 `SessionPrompt.generateTitle`。R3 只给原 `title` 增加手动触发选项和薄 wrapper，没有算法搬迁或第二 helper；自动与手动保留各自触发合同，也没有失败后的替代成功路径。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 首轮后台 ensureTitle | current + 原函数 manual 选项 | primary-contract branch | yes | 既有自动触发分支，不新增替代算法 | preserve |
| 显式 SessionPrompt.generateTitle | proposed | primary-contract operation | yes | 薄 wrapper 调原 title(manual=true) | implement |
| no-user/unavailable/failed typed outcomes | proposed | primary-contract rejection | no | 是主操作失败终态，不是额外 diagnostic 服务或成功路径 | implement |
| HTTP 404/400/503/502 | proposed | contracted pass-through / error adapter | no | 仅既有 domain-to-wire 映射 | implement |
| TUI error toast/保留草稿 | proposed | primary-contract rejection | no | 只呈现真实失败 | implement |
| 卸载后忽略 UI completion | proposed | lifecycle guard | no | 防止误关另一面板，不撤销服务端真实结果 | implement |
| TestLLMServer 未配置 title fixture 时 `E2E Title` | current/preserved test-only | existing compatibility | test success only | 不属于 production decision surface | preserve |
| Provider 失败后换模型/换 prompt/返回旧标题成功 | rejected | forbidden fallback | would be false success | 0% | reject |
| single-flight/CAS 第二套写回协议 | rejected | unrequested replacement consistency path | no new required success | 0% | reject |

没有独立 logging/diagnostic side path；领域失败和 UI 错误均是主合同的非成功终态。新增 alternate success path 为 0，diagnostic side-path 占比为 0%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| R2 计划的 `titleText` 抽取（未实施） | 曾用于让自动/手动共享算法 | 用户要求最小侵入；R3 直接在原 `title` 增加 manual 选项，算法行不移动 | 从本 plan 删除该候选设计；production 无 workaround 可删。 |
| TestLLMServer 标题请求无条件固定 `E2E Title` 并绕过所有 queue | 防止后台标题偷走主 Agent 测试 fixture | 增加独立 title queue 和外部 `titleHits`；显式 fixture 可表达 text/empty/error，负向 guard 可观察无标题 HTTP 请求，未配置仍走原默认，主 queue 完全隔离 | `packages/opencode/test/lib/llm-server.ts` title branch 与 test Service。 |
| TUI 手动 PATCH | 用户主动保存文本的正式功能 | 它不被 Generate 替代；Generate 成功不再额外发 PATCH | 保留 `DialogSessionRename.onConfirm` 和现有 update endpoint。 |

没有需要删除的 production fallback、feature flag、兼容 adapter 或迁移。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| `/rename` + 列表 Generate、INV-02/06 | 两入口 -> DialogSessionRename -> SDK POST -> generateTitle | `dialog-session-rename.tsx`、`dialog-prompt.tsx`、Session HttpApi | 真实 Rename frame/transport 测试；既有 caller 无需改。 |
| 多轮/自定义/子 Session 标题、INV-02/03 | wrapper -> 原 title(manual=true)，跳过自动 guards | `session/prompt.ts` | 压缩 active window 中保留多条真实用户 + 自定义旧标题成功；带 parentID 的手动子 Session 也成功；输入取首个 active 真实用户且不含 marker。 |
| 自动条件不变、INV-01 | runLoop step1 -> 原 title 自动 guards | `session/prompt.ts` | 默认首轮成功；自定义标题、子 Session、多轮真实用户均无标题请求/改写；标题 Provider 失败时主回复仍成功。 |
| 单 writer、INV-04/11 | 原 title -> Session.setTitle -> Session.get/Updated | `session/prompt.ts` | public 返回和重新读取均为生成标题，event 仍走既有 Sync。 |
| 输入与上游失败、INV-05 | TitleError + endpoint error mapping + UI failure | `prompt.ts`、handler、rename | no-user、agent disabled、model unavailable、empty、stream error；旧标题不变，400/503/502，UI toast。 |
| Ctrl+G/Generate、INV-06/07 | conditional DialogPrompt command + keybind definition + footer | `keybind.ts`、`dialog-prompt.tsx` | 默认冲突、rebind、无 onGenerate 的全局行为；真实 frame 含独立 `Generate` 且不含 `Generate Title`。 |
| busy/draft/late response、INV-08 | generating signal + existing busy + mounted guard | `dialog-session-rename.tsx`、`dialog-prompt.tsx` | deferred POST 下重复键无效、Generating…、失败草稿、Esc 后 sentinel panel 存活。 |
| 公共路由覆盖、INV-09 | title route -> `session.generateTitle` exerciser scenario + llmScenarios | `test/server/httpapi-exercise/index.ts` | `.withLlm()` 的 200/持久化场景及完整 `bun run test:httpapi` coverage/auth/effect。 |
| 公共 SDK、INV-09 | legacy HttpApi -> legacy SDK build；独立 ClientApi -> Client generate check | group + legacy generated outputs | legacy SDK 方法类型可用；Client 生成/test/typecheck 通过且无 title 方法扩散。 |
| 跨目录、INV-10 | inSessionDirectory | handler | ambient B 无 Provider，Session A 有 Provider；用 B header 仍成功生成 A 标题。 |
| 无 fallback、INV-11 | 只有原 title/setTitle 一条成功路径 | 全部 production diff | provider/empty/error 测试无成功结果；独立 diff audit。 |
| 最小侵入、INV-12 | 原 title 连续区域 + 薄 wrapper + 既有 HTTP/TUI owners | 第 15.1 节 6 文件函数预算 | 实施逐 hunk/有效行审计，禁止 titleText 抽取和额外 production 文件。 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `SessionPrompt.Service.generateTitle` | INV-02/03/04 | 用户需要显式生成；现有算法私有 | 没有此操作时 handler 必须拼接 history/model/write，造成责任泄漏。 |
| 原 `title` 的可选 manual 输入 | INV-01/02/03/12 | 自动 guards 与手动触发不同，算法完全相同 | 无选项时公共手动调用会被 guards 拒绝；抽取 titleText 又违反用户最小侵入要求。 |
| `SessionPrompt.TitleError` 三种 reason | INV-05 | 空用户、禁用 agent、model/stream/empty 均可达 | 自动路径的无声 return/ignore 无法向手动用户表达真实失败。 |
| POST title endpoint + Session.Info success | INV-02/04/09 | TUI 只拥有 SDK transport | 私有 service 无法被 TUI 调用；PATCH 需要客户端先知道标题。 |
| 复用 inSessionDirectory | INV-10 | 会话列表跨目录已存在 | ambient directory 可指向另一实例；不是新增并发/路由系统。 |
| `dialog.prompt.generate` 定义 | INV-06/07 | 用户要求面板快捷键，Ctrl+G 已被全局占用 | raw keyboard 不可配置且会绕过现有作用域系统。 |
| 可选 `DialogPrompt.onGenerate` | INV-06/07 | 只有 Rename 需要 Generate | 给所有面板无条件 binding 会吞掉其他面板的全局 Ctrl+G。 |
| Rename generating signal | INV-08 | 网络请求真实异步，busy 已存在 | 无状态时重复键和 Enter 可发并发/保存旧草稿。 |
| Rename 卸载后的 UI guard | INV-08 | Esc + deferred response 可达 | 直接 late `dialog.clear()` 会关闭后来打开的面板。 |
| generated legacy SDK method | INV-09 | TUI 依赖 legacy SDK | 手写类型会偏离 legacy HttpApi 且违反 AGENTS。 |
| Client generate check（非新 API） | INV-09 | AGENTS 要求 Server HttpApi 变化后运行；ClientApi 来源独立 | 只运行生成/test/typecheck即可满足仓库约束，扩张 Protocol 会引入未消费公共合同。 |
| 独立 test title queue/titleHits（test-only） | INV-01/05 | 当前固定标题 bypass 使 empty/error 不可测，负向 guard 也缺少外部请求证据 | 使用主 queue 会被并发后台标题偷走主 Agent fixture；独立 queue 保留隔离，titleHits 观察真实 Provider transport 而非内部调用。 |
| exerciser title scenario（test-only） | INV-09 | 新公共路由会被 coverage gate 枚举 | 没有 scenario 时 `--fail-on-missing` 确定性失败；定向 HTTP 测试不能替代仓库级门禁。 |

没有新服务文件、配置项、依赖、缓存、锁、迁移、fallback 或直接 DB/Sync 写入。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/prompt.ts` | modify | 原 title 增加 manual/错误/写回分支，邻近新增 TitleError 和薄 generateTitle wrapper，interface/export 接线；算法不移动。 | +55 / -12；无 pure-move。 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | modify | title path、POST endpoint、Session.Info 与四类错误、OpenAPI metadata。 | +25 / 0 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | modify | generateTitle handler、inSessionDirectory、domain-to-wire errors、注册。 | +45 / 0 |
| `packages/tui/src/config/keybind.ts` | modify | 声明可覆盖的 `dialog.prompt.generate=ctrl+g`。 | +1 / 0 |
| `packages/tui/src/ui/dialog-prompt.tsx` | modify | optional onGenerate、conditional binding/command、Generate footer。 | +25 / -3 |
| `packages/tui/src/component/dialog-session-rename.tsx` | modify | SDK 调用、busy、toast、草稿保留和卸载 guard。 | +50 / -3 |
| `packages/opencode/test/lib/llm-server.ts` | modify | 独立 title fixture queue 和外部 titleHits，未配置默认不变。 | +30 / -5 |
| `packages/opencode/test/session/prompt.test.ts` | modify | public 成功、表驱动错误、自动正负向 characterization 和失败非阻塞；复用现有 user/seed fixture。 | +110 / 0 |
| `packages/opencode/test/server/httpapi-session.test.ts` | modify | 合并 200/跨目录场景与表驱动 404/400/503/502。 | +60 / 0 |
| `packages/opencode/test/server/httpapi-exercise/index.ts` | modify | 为 title POST 登记 `.withLlm()` 成功 scenario 和 `llmScenarios` 成员。 | +35 / 0 |
| `packages/tui/test/cli/tui/dialog-prompt.test.tsx` | modify | onGenerate fixture、默认冲突、rebind、无 action 全局行为。 | +50 / -5 |
| `packages/tui/test/cli/cmd/tui/dialog-session-list.test.tsx` | modify | 复用完整 provider harness，合并验证 POST/busy/failure/late response。 | +75 / 0 |
| `packages/client/src/generated/**`、`src/generated-effect/**` | verify only | 按 AGENTS 运行 `bun run generate`；ClientApi 未改，预期没有本任务 title 方法 diff。 | 0 intentional task delta |
| `packages/sdk/js/src/v2/gen/**` | generated modify | 由 `bun run build` 产生的 `session.generateTitle`、request/response/error 类型。 | generator-owned，不手算或手改 |

不修改 `packages/tui/src/routes/session/index.tsx`、`dialog-session-list.tsx` 的 production 逻辑，不新增手写文件。SDK build 的 `openapi.json` 只是脚本既有临时输入，结束时由脚本删除，不进入最终 diff。

### 15.1 Production function and hunk budget

以下是用户要求的生产代码逐函数预算。数字是实施前的有效改动估算，不含 import-only/formatter/generated；不能用删减 INV-01 至 INV-11 来迎合预算。

| File / function | Planned change | Local hunks | Effective production lines |
| --- | --- | ---: | ---: |
| `prompt.ts` 现有 `title` | 原地增加 manual guard、compaction-aware real/context、history 锚定 firstUser、缺省 model 来源、typed failure 和 manual 写回；算法行保持原位 | 与 wrapper 共 1 个连续区域 | 约 30 |
| `prompt.ts` 新 `generateTitle` wrapper | `Session.get` + `filterCompactedEffect` + 调原 `title(manual:true)` | 与 title 同区域 | 约 10 |
| `prompt.ts` `TitleError` / `Interface` / `Service.of` | 错误类型、方法签名和导出接线 | 2 | 约 8 |
| `groups/session.ts` `SessionPaths` / endpoint | title path 和一个 POST 声明 | 2 | 约 20 |
| `handlers/session.ts` `generateTitle` / 注册 | 一个 inSessionDirectory handler、reason 映射和一行注册 | 2 | 约 33 |
| `config/keybind.ts` Definitions | 一行 `dialog.prompt.generate=ctrl+g` | 1 | 约 1 |
| `dialog-prompt.tsx` props/shortcut | optional onGenerate 与 shortcut accessor | 与 command 同区域可合并 | 约 6 |
| `dialog-prompt.tsx` command/bindings/footer | conditional command/gather 和 Generate footer | 2 | 约 13 |
| `dialog-session-rename.tsx` generate callback | generating、SDK、toast、卸载 guard | 与 JSX/imports 共 2 | 约 40 |
| **合计** | **6 个既有 production 文件** | **约 13** | **约 160** |

生产文件数不得增加；若某 hunk 因 formatter 被拆分不计为语义扩张。若实际语义 hunk 或行数明显超出，必须逐项映射到用户要求或可达失败，优先回到原函数复用，而不是新增 helper。

## 16. TDD Behavior Slices

公共 seam 依次为 `SessionPrompt.Service.generateTitle`、真实 Session HttpApi、真实 DialogPrompt/DialogSessionRename。每一列完成 red -> minimal green -> 相邻 regression 后再进入下一列；不能先写完全部 production 再补测试。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 0 | 为 TestLLMServer 增加独立 title queue/titleHits；先证明未配置时仍返回字面量 `E2E Title`，主 queue 不被消耗，titleHits 只记录标题 HTTP 请求。 | 当前 title branch 无条件固定响应，无法注入 empty/error 或观察负向 guard；直接复用主 queue 会偷主回复。 | 仅 test fixture 增加 title queue、外部 titleHits 和默认兼容。 | 现有 prompt tests 的主 Agent fixture 顺序。 |
| 1 | public generateTitle：自定义旧标题 + 压缩边界外旧用户 + 不含 memento 的 active marker/完成 summary + active window 内两条真实用户；返回和重读均为 `Generated project title`，Provider 输入含首个 active 真实用户且不含 `What did we do so far?`。另一正向用例给带 parentID 的手动子 Session 生成 `Generated child title`。 | 当前 Service 没有 generateTitle；原 real 会误选 marker，slice 会带入 marker，过滤后沿用 context[idx] 还会丢首个真实用户；parent guard 也可能误伤手动子 Session。 | 薄 wrapper 加载 active history；原 title 用非 compaction/非 synthetic part 判定真实用户，过滤 context 的 compaction-only user，并从 input.history[idx] 锚定 firstUser；manual 跳过 parent/default/exactly-one guards。 | INV-02/03/04；一个非-subtask 压缩 slice 加一个孩子正向用例，覆盖多轮、active history、real/context、索引和 parent 触发合同，不另测未改 cleaner。 |
| 2 | 表驱动 public failure：空/纯 synthetic，以及“完成且无错的 summary + compaction-only marker、无 memento、无其他真实用户”均为 no_user_message；agent disabled/model-not-found 为 unavailable；empty/stream error 为 failed；旧标题均不变。 | 自动私有路径只 return/ignore/orDie，没有公共 typed failure；完成配对的 compaction-only 还会被误判真实用户，未配对 marker 又会被 active-window owner 移除而形成假 red。 | 在原 title 对应行转 TitleError，不写标题；用独立 instance 参数化而非五套测试 helper。 | INV-05/11；不新增 fallback，fixture 不依赖被过滤掉的未配对 marker。 |
| 3 | 自动 characterization：默认首轮 `Auto Title` 与 `Main Reply` 成功；表驱动自定义标题/子 Session/多轮真实用户保持原标题且 title provider 无请求；title stream error 时仍返回 `Main After Title Failure`。 | 当前没有专项测试，删除 guard/ignore 会变 red。 | 原 title 只改 guard 条件和错误返回，runLoop 调用形状不变。 | INV-01；独立 scope 结算后 readback + 外部 titleHits，禁止固定 sleep。 |
| 4 | HTTP：合并真实 POST 200 与跨目录 B header 生成 A 标题；表驱动 404/400/503/502；exerciser 得到 `E2E Title`。 | 当前 route 不存在，成功请求为 404；新 scenario 在旧 API 下属于 extra；定向 fixture 的 `test/test` 与注册的 `test/test-model` 不一致。 | group + handler + inSessionDirectory + exerciser scenario/llmScenarios；仅新 HTTP 用例配置增加 `small_model: "test/test-model"`。 | INV-05/09/10；完整 coverage/auth/effect 门禁，不改共享 testProviderConfig。 |
| 5 | DialogPrompt：有 onGenerate 时 Ctrl+G 只调用 generate；rebind 后新键生效；无 onGenerate 时全局 messages_first 生效；真实 frame 含独立 `Generate` 且明确不含 `Generate Title`。 | 当前没有 command/prop/binding/footer 文案，单测键盘分发无法捕获文案缺失或回退成长文案。 | 可选 prop、conditional gather、footer Generate；复用现有 renderOnce/frame seam，不增加生产抽象。 | INV-06/07 与现有 5 个 DialogPrompt 测试。 |
| 6 | Rename success：deferred POST 期间 Generating…，重复 Ctrl+G/Enter 无额外 POST/PATCH；resolve 后关闭 Rename。 | 当前 Rename 只能 PATCH。 | generating + SDK generateTitle + success clear。 | INV-02/06/08；真实 transport 断言 method/url。 |
| 7 | Rename failure/late completion：502/transport rejection 保留草稿并 toast；Esc 后打开 sentinel 再 resolve，sentinel 不被 clear。 | naive 成功实现若直接 clear 会误关后续面板。 | 同一失败终态恢复 busy；onCleanup 后忽略 UI 完成。 | INV-08；服务端写回不被假称取消。 |
| 8 | legacy SDK 暴露 session.generateTitle；Client 生成/test/typecheck 通过且没有该新方法。slice 4 group/handler 完成后、slice 6 Rename 前先执行一次 legacy `bun run build`，此处最终复验。 | 当前 legacy SDK 没有方法；ClientApi 来源独立。 | 只运行两条既有生成器，不改 Protocol、不手改输出、不增加第二 HTTP transport。 | INV-09 与生成器 patches，实施顺序不产生假 red。 |

测试不得只检查 source text、private helper、内部函数调用次数或复制清洗算法生成期望值。TestLLMServer 的 title HTTP 请求有无是外部 Provider 可观察行为，可用于自动负向 guard，不属于内部 call-count 断言。`llm.wait`/Session 读取/`pollWithTimeout`/deferred response/instance scope 结算是 readiness seam；禁止固定 sleep 等待后台标题。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 500（生产约 160，测试约 340） | 排除空行、import-only、formatter-only、generated；R3 没有算法 pure move，测试复用 fixture/表驱动。 |
| Required Chinese explanatory comments `C` | 至少 75（按 E=500 估算） | `C >= max(1, ceil(E * 0.15)) = 75`；实施按实际 E 重新计算，估算漂移不得降低实际比例。 |

必须在修改点附近分布有信息量的中文解释，不能用逐行翻译凑数：

- 原 title 的 manual 触发选项只跳过自动 guards，算法不得搬移或复制；说明禁止把 exactly-one/default guard 下移到手动的理由。
- active history、首个真实用户和 onlySubtasks 的兼容边界；real 选择和 slice 前缀都必须排除 compaction-only，但不能误删 replay 的真实 part；固定 `100/97` 截断与空输出不写标题的既有约束。
- unknown stream/model errors 的窄转换和安全公共 message，为什么不能把 raw provider body 直接 toast。
- `inSessionDirectory` 的双目录测试拓扑及为什么 B 无 Provider 能证明实例定位正确。
- 独立 title fixture queue 与主 Agent queue 隔离的原因，默认 `E2E Title` 是既有测试兼容而非 production fallback。
- 自动负向 guard 的 scope 结算与外部 titleHits 证据，以及标题失败不得阻断主回复的非阻塞合同。
- `session.generateTitle` exerciser 的真实用户/`.withLlm()` 拓扑和 ClientApi 与 legacy SessionApi 的独立合同来源。
- conditional Generate binding 对全局 `messages_first` 和其他 DialogPrompt 的作用域不变量。
- pending busy 防重复 POST/PATCH、失败保留草稿、卸载后 UI completion guard 的 Dialog 生命周期约束。
- deferred response、跨目录、active multi-turn、agent/model unavailable 和 empty/error tests 各自独立的行为意图与 red 证据。
- generated 文件不写中文注释，也不计 E/C。

实际实施报告必须列出排除行、逐文件 E/C 和代表性注释；如果实际 E 高于估算，C 同步增加。

## 18. Verification

### 18.1 Plan-stage checks already executed

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test "D:\Temp\opencode\dialog-ctrl-g-scope.test.tsx" --timeout 30000` | `packages/tui` | `1 pass, 0 fail`。实验把 `dialog.prompt.submit` 与全局 `messages_first` 同时设为 Ctrl+G，观察 `confirmed=["draft"]`、`global=[]`，证明 targeted priority 1 可隔离同键。实验没有最终 Generate command，因此不能替代第 16 节最终 Generate 验收。 |
| `bun test test/cli/tui/dialog-prompt.test.tsx --timeout 30000` | `packages/tui` | `5 pass, 0 fail`；现有 DialogPrompt 基线可用。 |
| 只读 SQLite/log 流式检查 | 仓库外真实 opencode data/log | 近期标题失败与 429/SSE timeout 对应；没有以本 plan 修改真实数据，也没有把 Provider 修复夹带进范围。 |

临时 harness 首次缺少 KeymapProvider 的 `Keymap not found` 已通过在 `OpencodeKeymapProvider` 内放置 GlobalBindings 修正；最终通过结果以上表为准。

### 18.2 Approved implementation verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | public title 全部 red-green、自动正负向 characterization、失败非阻塞和现有 prompt regression。 |
| `bun test test/server/httpapi-session.test.ts --timeout 30000` | `packages/opencode` | title HTTP status/body、跨目录 placement、既有 Session routes。 |
| `bun run test:httpapi` | `packages/opencode` | 新 title scenario 在 coverage/auth/effect 三模式通过，公共路由无 missing/skip，LLM 场景使用 TestLLMServer。 |
| `bun test test/cli/tui/dialog-prompt.test.tsx test/cli/cmd/tui/dialog-session-list.test.tsx --timeout 30000` | `packages/tui` | 最终 Ctrl+G/rebind/无 action 行为、真实 Rename POST/busy/draft/late response 和列表回归。 |
| `bun run generate` | `packages/client` | 独立 Protocol ClientApi 按 AGENTS 完整重建；命令失败即阻止后续，不期待 title 方法。 |
| `bun test --timeout 5000` | `packages/client` | Client 既有测试与未扩张的 Protocol 合同兼容。 |
| `bun run build` | `packages/sdk/js` | OpenAPI 生成、legacy v2 SDK、既有 patches、prettier、tsc 全部成功；临时 openapi.json 被清理。 |
| `bun test` | `packages/sdk/js` | legacy SDK 回归。 |
| `bun typecheck` | `packages/opencode` | Service/handler/domain error 类型完整。 |
| `bun typecheck` | `packages/tui` | generated SDK method、Dialog props 和异步处理类型完整。 |
| `bun typecheck` | `packages/client` | Client generated contract 类型完整。 |
| `bun typecheck` | `packages/sdk/js` | legacy generated contract 类型完整。 |
| `git diff --check` | repository root | 无 whitespace error；不运行 root tests。 |
| `git status --short` 与完整 `git diff` | repository root | 只包含 approved paths 与生成输出；既有 `bun.lock` 和 4 个无关 plan 保持原状，不提交、不清理。 |

`packages/client` 的 `check:generated` 会把当前尚未提交的 intentional generated diff 与 HEAD 比较，因此不作为本地实施中的干净性命令；以实际执行 `bun run generate`、审查完整 diff 和 typecheck/test 为证据，不伪造 clean-tree 结论。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 handwritten | 复用现有 owner 和测试文件。 |
| Files modified | 12 handwritten + legacy generator-owned files | 6 个 production、6 个 test/fixture；Client 预期无本任务 generated diff，legacy 生成文件数量以实际输出为准。 |
| Files deleted | 0 | 无淘汰 production 文件；SDK 临时 openapi.json 由脚本自清。 |
| Production lines | 约 160 effective / 6 files / 13 local hunks | 原 title 算法不搬移；逐函数预算见第 15.1 节。 |
| Test lines | 约 355 gross additions，约 340 effective | 复用 fixture 和表驱动合并错误/guard；不测试未改算法的重复边缘组合。 |
| Generated lines | legacy generator-owned，按实际 diff 审查；Client 预期 0 task delta | 不设伪造行数，不手改；任何超出 legacy endpoint 及引用类型的异常扩散必须解释。 |

预算不是删减已确认行为的理由；若实际 diff 增加，必须能映射到第 13/14 节，否则移除。

## 20. Real Risks and Open Decisions

### Real risks

- Provider 429/timeout 在手动 Generate 仍可发生；本功能的价值是用户可显式重试并看到失败，不是提高上游成功率。
- 后台自动请求与手动请求可以并发，当前 writer 是后写覆盖；本 revision 不改变该语义，测试不得把完成顺序包装成新的一致性保证。
- 生成后标题依赖既有 Session.Updated 进入 TUI Sync；HTTP response 也返回最终 Session.Info，TUI 不直接写 store，避免两个客户端状态来源。
- `Ctrl+G` 与全局动作冲突是已证实风险；只有最终真实 Generate command 测试通过才算解决，计划阶段 submit 实验只证明机制。
- 关闭 Rename 不会取消服务端请求；已用卸载 guard 防止晚到 UI 副作用，但服务端最终标题仍可能变化，这是明确保留的行为。
- 两条生成链来源不同：legacy SDK 必须新增方法，Client 只验证独立 Protocol 合同；不得为了形式一致扩张 Protocol。legacy 生成器若产生较多格式化 diff，只接受实际输出并审查，不通过手改缩小。

### Open Decisions Requiring the User

无。动作文案 `Generate`、默认面板快捷键 `Ctrl+G` 和两个共享入口均已由用户确定；用户随后把终态升级为 verified-implementation-and-commit。子 Session 与多轮 Session 沿用公共 Rename 的 Session 域，不需要新的产品分支。

### Rejected Speculation

- **single-flight/CAS/锁**：有并发可达性，但没有新的标题一致性需求或安全后果；现有 rename 本来就是后写覆盖，本任务不构建新协议。
- **后台定时重试、失败后恢复、Provider/model fallback**：不能解决上游配额根因，会改变 best-effort 并引入备用成功路径。
- **摘要整个 Session、最新消息或用户可编辑 title prompt**：现有 title 明确使用 active window 的首个真实用户，用户没有要求另一种摘要产品。
- **R2 的 titleText 抽取和算法边缘组合测试**：R3 已用原函数 manual 选项取得同一行为，不保留无收益的搬迁和重复测试。
- **请求取消 API/AbortController**：用户只要求面板生成；需要防止的实际 UI 问题由卸载 guard 覆盖，不能把 Esc 伪称为服务端取消。
- **直接更新 Sync store**：现有 Session.Updated 已是唯一同步路径，重复写 store 会产生竞争来源。
- **单独 `/generate-title` 命令或额外按钮面板**：用户明确选择现有 `/rename`/TUI 面板和短文案 Generate。
- **新配置、依赖、迁移、ADR**：没有对应行为需求或跨项目政策决策。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

审计还必须核对：自动与手动 guard 没有混用且自动负向/失败非阻塞测试敏感、active history 没有绕开 owner、错误不伪装成功、两个 Rename 入口共享实现、无 onGenerate 面板不吞 Ctrl+G、晚到响应不清理其他面板、跨目录定位、HttpApi exerciser 门禁、legacy SDK 与独立 ClientApi 没有合同混淆，以及 R6 是否真正在原 title 上接线、同时从 real 选择和 context 前缀排除 compaction-only 技术消息、从 input.history 锚定 firstUser、保留其他合法前缀、验证手动子 Session 和精确 Generate 文案，并保持 6 个 production 文件的最小侵入。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01; B-02; B-03 | 无 | BLOCK | `ses_e4011f394ffeBpRxp3e6qBNEpH` |
| 2 | R2 | yes | No blocking findings | 无 | APPROVE | `ses_e3ff9bebeffeGNaDuZnCrBXtGG` |
| 3 | R3 | yes | B-01 | NB-01 | BLOCK | `ses_e3f3b1650ffe5vvCxP2XqNdq2a` |
| 4 | R4 | yes | B-01 | NB-01; NB-02 | BLOCK | `ses_e3f20e86dffeMJUDtYV4PX5r5Y` |
| 5 | R5 | yes | B-01; B-02; B-03 | None | BLOCK | `ses_e3ef7f2d9ffedRgh2nkLssoChp` |
| 6 | R6 | yes | No blocking findings | 无 | APPROVE | `ses_e3edda139ffeBsIdPJbkLMiBjI` |

### Round 1 independent verdict (verbatim)

````text
## Blocking findings

### B-01 `packages/client` 不会从 legacy `SessionApi` 生成 `generateTitle`

- Violated invariant: INV-09 要求 Client 与 legacy SDK 都由既有生成器得到同一 `generateTitle` 操作；当前文件计划无法实现该合同。
- Evidence class: observed
- Producer and execution path: 计划修改的是 legacy `/session` 的 `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`，legacy SDK 会从其 OpenAPI 获得新端点；但 `packages/client/script/build.ts` 编译的是 `ClientApi`，而 `ClientApi` 来自 Protocol 的 `makeDefaultApi()`，其 Session 组独立声明 `/api/session` 路由，不引用 legacy `SessionApi`。因此仅执行计划中的文件修改后，`bun run generate` 不会产生 Client 的 `generateTitle`。
- Source evidence: `packages/client/script/build.ts:3-7`；`packages/client/src/contract.ts:14-17`；`packages/protocol/src/api.ts:38-43`；`packages/protocol/src/groups/session.ts:109-123`；`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:192-196`。TUI 实际使用 legacy SDK，见 `packages/tui/src/context/sdk.tsx:45-52`。
- Canonical-plan evidence: 第 7 节 INV-09、第 10.4 节、第 13 节公共 SDK 行、第 15 节 generated Client 文件计划、第 16 节 slice 9。
- Responsibility owner: legacy Server HttpApi 与 legacy SDK 生成链负责本 TUI 功能；Protocol `ClientApi` 是另一套独立公共合同。
- Concrete behavioral consequence: TDD slice 9 中“Client 与 legacy SDK 均暴露 `session.generateTitle`”会持续失败；若为满足该承诺而手改 generated Client，又会违反仓库生成规则。
- Minimal correction direction: 按原始 TUI 需求收敛为 legacy `/session → legacy SDK` 主路径，删除“Client 必须新增同名方法及 generated diff”的过度承诺，保留 AGENTS 要求的 Client 生成检查，不为未使用的方法扩张 Protocol。

### B-02 新公共路由未纳入强制 HttpApi 覆盖门禁

- Violated invariant: 新增公共端点必须具有仓库要求的路由场景并通过 `test:httpapi`；当前计划遗漏该测试所有者及验证命令。
- Evidence class: reachable
- Producer and execution path: 计划新增 `POST /session/:sessionID/title` 后，`OpenApi.fromApi(modules.PublicApi)` 会枚举该路由；`httpapi-exercise` 将找不到对应 scenario，形成 `missing`，随后 `--fail-on-missing` 使命令失败。CI 对 coverage、auth、effect 三种模式均执行该门禁。
- Source evidence: `packages/opencode/test/server/httpapi-exercise/index.ts:1983-1985`、`:2017-2018`；`packages/opencode/test/server/httpapi-exercise/routing.ts:25-35`；`packages/opencode/package.json:22`；`.github/workflows/test.yml:325-356`。现有 LLM 路由还必须使用 `.withLlm()`，见 `packages/opencode/test/server/httpapi-exercise/index.ts:1971-1977`、`:1988-1991`。
- Canonical-plan evidence: 第 10.2 节新增端点；第 15 节文件清单没有 `test/server/httpapi-exercise/index.ts`；第 18.2 节没有 `bun run test:httpapi`。
- Responsibility owner: `packages/opencode/test/server/httpapi-exercise` 路由覆盖套件。
- Concrete behavioral consequence: 即使计划中的 service、HTTP 和 TUI 定向测试全部通过，实现后仍会在现有 CI 的 HttpApi exerciser gate 中确定性失败。
- Minimal correction direction: 为 title POST 增加带真实用户消息和 `.withLlm()` 的成功场景、登记其 LLM 场景归属，并在 `packages/opencode` 增加完整的 `bun run test:httpapi` 验证。

### B-03 自动命名的负向 guard 与失败非阻塞回归测试不敏感

- Violated invariant: INV-01 及第 2 节非目标要求自动命名继续保持 parent/default/exactly-one-real-user guards 和 best-effort 非阻塞语义。
- Evidence class: contracted
- Producer and execution path: 当前 `runLoop` 在第一步 fork `title()`，并 `Effect.ignore`；`title()` 在调用 LLM 前拒绝子 Session、自定义标题和多条真实用户消息。计划重构该函数以共享 `titleText`，但手动 Generate 测试刻意要求没有这些 guards，自动 characterization 又只覆盖默认首轮成功，因此“完全删除自动 guards”或“移除失败忽略边界”都可能通过计划的测试。
- Source evidence: `packages/opencode/src/session/prompt.ts:479-486`、`:505-533`、`:1930-1936`。
- Canonical-plan evidence: 第 2 节自动命名非目标；第 7 节 INV-01；第 13 节“自动条件不变”仅安排默认首轮成功并以“源码最小 diff”代替 guard 行为断言；第 16 节 slice 4 使用成功的 `Auto Title`，却在 Regression protected 中声称覆盖“标题失败不阻断主 Agent loop”。
- Responsibility owner: `packages/opencode/test/session/prompt.test.ts` 中的自动命名 characterization。
- Concrete behavioral consequence: 实现可能让后台标题覆盖自定义标题、子 Session 或多轮 Session 标题，或让标题 Provider 失败阻断主 Agent，而计划内测试仍全部通过。
- Minimal correction direction: 增加自动路径负向 characterization，分别证明自定义标题、子 Session、多条真实用户消息不会请求或改写标题，并增加标题请求失败时主回复仍成功的行为测试。

## Non-blocking findings

无。

## Rejected speculation

- 未将自动/手动并发后的后写覆盖视为缺陷；它与现有 Rename 语义一致，用户没有要求新的 CAS 或锁协议。
- 未要求 Esc 取消已发出的 HTTP 请求；计划仅抑制卸载后的 UI 副作用，边界明确。
- 未把 TestLLMServer 未配置 title fixture 时返回 `E2E Title` 视为 production fallback；它是保留现有测试隔离的 test-only 兼容行为。
- 未要求额外的 Provider/model fallback、定时重试、请求取消 API、raw keyboard binding 或直接写 Sync store；这些都会扩大范围或形成第二语义路径。

## Requirement and traceability coverage

| 原始要求/行为 | 独立核对结果 |
| --- | --- |
| `/rename` 与会话列表都能 Generate | 两个入口分别位于 `packages/tui/src/routes/session/index.tsx:1085-1095` 和 `packages/tui/src/component/dialog-session-list.tsx:721-726`，确实共享 `DialogSessionRename`，单一接入点成立。 |
| 使用短文案 `Generate` | 第 10.3 节明确映射到共享 Rename 面板 footer，符合逐字要求。 |
| 面板打开后的快捷键 | `Ctrl+G` 与全局 `messages_first` 的冲突真实存在；conditional targeted binding、可覆盖 keybind 和无 `onGenerate` 时不注册的路径均有源码依据。外部实验只证明 priority 1 机制，计划也正确未把它冒充最终 Generate 验收。 |
| 复用现有自动标题逻辑 | `titleText` 复用 active history、首个真实用户、subtask、模型选择、消息转换、清洗和截断，主算法归属正确；自动与手动仅触发合同不同。 |
| 成功、失败和 UI 生命周期 | `Session.setTitle`、typed failure、真实 HTTP 错误、busy/draft/late-response 路径均有计划 owner 和行为测试。 |
| TDD 敏感性 | Service 方法不存在、路由 404、Ctrl+G 不发 POST 都能在旧行为上产生有效 red；自动首轮 characterization 可在当前基线通过，计划没有伪称其必然 red。 |
| 自动行为不变 | **不完整，受 B-03 阻断。** |
| Client 与 SDK 生成 | **不完整，受 B-01 阻断。** |
| 仓库级公共路由验证 | **不完整，受 B-02 阻断。** |

除上述缺口外，第 13/14 节对 INV-02 至 INV-08、INV-10、INV-11 的 forward/reverse traceability 基本对应真实 owner，没有发现需要通过复制算法或直接写数据库/Sync store 才能满足的需求。

## Primary-path and fallback verdict

领域主路径设计本身成立：

```text
Rename 面板
  → legacy SDK POST
  → SessionPrompt.generateTitle
  → 共享 titleText
  → Session.setTitle
  → Session.get / Session.Updated
```

现有后台自动命名与显式 Generate 是同一算法在不同触发合同下的使用，不构成失败后替代成功路径。typed rejection、HTTP 错误和 UI toast 都没有制造成功形结果；未发现换模型、换 prompt、旧标题冒充成功或 catch-and-default fallback。

主路径问题不在 fallback，而在 B-01 错误假设了 Client 的合同来源，以及 B-02/B-03 的验证缺口。

## Code quality and Chinese-comment verdict

- 计划复用现有模块，没有新增服务文件、依赖、迁移、锁或配置开关，责任边界总体符合仓库风格。
- generated 文件明确要求由生成器产生，不手改；B-01 应通过删除未使用的 Client 方法承诺解决，而不是扩大实现。
- 计划估算 `E ≈ 520`，要求 `C ≥ ceil(520 × 0.15) = 78`，算术正确，且列出了自动/手动 guard、active history、错误转换、双目录、keymap 和 Dialog 生命周期等可解释的注释位置。
- 当前没有 implementation diff，因此实际 `E`、`C` 和比例为 `N/A`。实施时须重新计算；审计阻断底线为 `C/E < 0.10`，10% 至不足 15% 为非阻断质量提示。
- 中文注释预算本身不构成阻断，但修订 B-02 后应同步调整文件与估算范围。

## Release verdict

**BLOCK**

R1 不能批准，`Implementation allowed` 必须保持 `no`，当前也未达到 `approved-plan-only` 终态。修正 B-01 至 B-03 后应递增 canonical revision，并重新进行完整范围的独立计划审计。
````

### Round 2 independent verdict (verbatim)

````text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- **不要求 single-flight、CAS 或锁。** 自动与手动生成、多个手动请求确实可能并发，但现有 Rename 和 `Session.setTitle` 本来就是后写覆盖；用户没有要求新的一致性协议。保留现语义不构成回归，见 `packages/opencode/src/session/session.ts:757-778`。
- **不要求 Esc 取消服务端请求。** 可达问题是卸载后的 Promise 回调误关新面板或显示陈旧 toast；计划的卸载守卫覆盖了该 UI 问题，没有伪称取消服务端写回。
- **不要求为独立 Protocol ClientApi 增加同名方法。** TUI 实际消费 legacy SDK，见 `packages/tui/src/context/sdk.tsx:45-52`；Client 生成器则编译独立的 Protocol `ClientApi`，见 `packages/client/script/build.ts:3-7`、`packages/client/src/contract.ts:14-17`。仅执行既定 Client 生成检查即可，扩张 Protocol 会制造未消费合同。
- **不把 TestLLMServer 默认 `E2E Title` 视为 production fallback。** 它是现有测试消费者的兼容行为；独立标题队列用于表达成功、空输出和错误，主 Agent 队列保持隔离。
- **不要求换模型、换 prompt、自动重试或返回旧标题成功。** 这些会改变现有 best-effort 边界或引入备用成功路径。
- **不要求改为摘要最新消息或整个 Session。** 现有算法明确使用 active history 中首个真实用户及其前缀，见 `packages/opencode/src/session/prompt.ts:482-504`；用户没有要求另一种摘要产品。
- **未将自动与手动模型回退输入的设计选择扩大为阻断项。** 自动路径仍共享同一 title-agent → small-model → 用户模型选择链；没有发现其变化会破坏本次明确要求的已确认行为。

## Requirement and traceability coverage

| 原始要求或行为 | 独立核对结果 |
| --- | --- |
| 完整引用要求且只批准计划 | 第 1 节逐字保留三条用户要求及 `approved-plan-only`；当前元数据为 `R2 / audit-required / Implementation allowed: no`，没有夹带实施完成声明。 |
| 现有 `/rename` 入口支持 Generate | `/rename` 在 `packages/tui/src/routes/session/index.tsx:1085-1095` 打开共享 `DialogSessionRename`。计划只修改共享组件，调用方无需增加第二套生成逻辑。 |
| 会话列表 Rename 面板支持同一能力 | 列表入口在 `packages/tui/src/component/dialog-session-list.tsx:721-726` 渲染同一个组件，因此共享接入点覆盖两个入口。 |
| 短文案 `Generate` | 第 10.3 节将其放在 Rename 面板 footer，符合用户对 `Generate Title` 过长的商业展示顾虑。 |
| 面板打开后的快捷键 | 默认 `Ctrl+G` 与全局 `messages_first` 的冲突真实存在，见 `packages/tui/src/config/keybind.ts:141`。条件式 priority-1 binding、独立 rebind，以及无 `onGenerate` 时不注册的路径均有现有 keymap 机制支持。外部实验也直接覆盖了同键隔离，且计划没有把它冒充最终 Generate 验收。 |
| 复用现有自动标题逻辑 | 当前算法位于 `packages/opencode/src/session/prompt.ts:473-533`；计划提取单一 `titleText`，保留 active history、首个真实用户、onlySubtasks、模型选择、消息转换、清洗和 `97 + "..."` 截断。没有复制第二套算法。 |
| 自动命名行为保持不变 | `runLoop` 当前仅在第一步 fork 标题任务并 `Effect.ignore`，见 `packages/opencode/src/session/prompt.ts:1929-1936`。R2 明确保留 parent/default/exactly-one-real-user guards，并增加自定义标题、子 Session、多轮真实用户及标题失败不阻断主回复的 characterization，修复了 R1 的测试敏感性问题。 |
| Active Session History 所有权 | 手动路径调用 `MessageV2.filterCompactedEffect`，其 cutoff、隐藏记录和顺序处理位于 `packages/opencode/src/session/message-v2.ts:1577-1588`；HTTP 和 TUI 没有自行读取或过滤持久化消息。 |
| 成功持久化与 UI 同步 | 唯一成功写入路径为 `Session.setTitle`，随后 `Session.get` 返回最终快照。现有 Updated/Sync 路径继续负责 UI 更新，没有直接写数据库或 Sync store。 |
| 失败可见且不伪装成功 | 无真实用户、agent/model 不可用、Provider/转换失败及空输出均映射为 typed rejection；HTTP 400/503/502 与 UI toast 均有 owner 和测试。失败发生在 `setTitle` 前，旧标题保持不变。 |
| 跨目录 Session | handler 复用 `inSessionDirectory`，现有实现会读取持久化 Session directory 后执行 Effect，见 `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:82-90`。双目录测试能够证明不会使用 ambient B 的 Provider。 |
| Busy、草稿与晚到响应 | `DialogPrompt` 已有 busy 禁用 targeted bindings 和 textarea 保留机制，见 `packages/tui/src/ui/dialog-prompt.tsx:77-112`。计划的 deferred POST、重复 Ctrl+G/Enter、失败草稿、Esc 后 sentinel panel 测试覆盖真实异步生命周期。 |
| 公共 SDK 与路由门禁 | legacy SDK 由既有 `packages/sdk/js/script/build.ts` 生成；新增路由登记 `.withLlm()` exerciser scenario 和 `llmScenarios`，并执行完整 `bun run test:httpapi`，覆盖 coverage/auth/effect 三种模式。R1 的 B-01、B-02 均已实质修正。 |
| TDD 敏感性 | Service 方法不存在、路由 404、Ctrl+G 不发 POST 均能在当前行为上产生有效 red。自动 characterization 可在基线通过，但删除 guards 或失败忽略边界会由外部 titleHits、标题 readback 和独立主回复断言捕获。 |

第 13 节 forward traceability 已将 INV-01 至 INV-11 映射到生产路径、文件和行为测试；第 14 节 reverse traceability 对新增 domain 操作、typed error、endpoint、keybind、可选 prop、异步状态、卸载守卫及测试 fixture 均给出了实际证据和现有逻辑无法承载的原因。没有发现无需求支撑的生产概念。

## Primary-path and fallback verdict

R2 的权威主路径成立：

```text
/rename 或会话列表 Rename
  → 共享 DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 共享 titleText
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

后台自动命名和显式 Generate 是同一算法在不同触发合同下的使用，不是主路径失败后的替代成功路径。

typed rejection、HTTP 错误适配、toast、保留草稿和卸载后忽略 UI completion 都不产生成功形结果。TestLLMServer 的默认标题仅是 test-only 兼容路径。计划没有新增 alternate success path，诊断侧路径占比为 0%，符合第一性政策。

## Code quality and Chinese-comment verdict

- 变更落在现有拥有者：`SessionPrompt` 负责历史、模型和生成，`Session` 负责持久化，HTTP handler 负责 wire 错误，`DialogPrompt` 负责通用面板 keymap，`DialogSessionRename` 负责 Session SDK 与 Dialog 生命周期。
- 没有新增服务文件、依赖、迁移、锁、配置开关、raw keyboard 路径或直接 DB/Sync 写入。
- generated 文件明确由两条既有生成器分别处理，不要求手改输出。
- 验证命令的工作目录正确，未从仓库根目录运行测试；定向测试、完整 HttpApi exerciser、SDK build/test、Client generate/test 和各包 typecheck 均已列入。
- 计划估算 `E ≈ 655`，要求 `C ≥ ceil(655 × 0.15) = 99`，算术正确。排除空行、import-only、formatter-only、generated 和 `ensureTitle → titleText` pure move 的方法符合政策。
- 中文注释计划覆盖自动/手动 guard 差异、active history、错误转换、双目录拓扑、fixture 队列隔离、keymap 作用域及 Dialog 生命周期，且要求靠近对应决策分布，具备可执行性。
- 当前是计划审计，没有 implementation diff，因此实际 `E`、实际合格 `C` 和实际比例为 **N/A**。实施审计必须重新计算；阻断底线为 `E > 0 && C/E < 0.10`，10% 至不足 15% 仅为非阻断质量提示。

## Release verdict

**APPROVE**

仅批准当前审计的 **R2** canonical plan：`docs/plans/tui-generate-session-title.md`。

编排主代理可将本独立 verdict 原样记录后，对同一 R2 执行行政审批字段转换。任何实质性计划修改都会使本次批准失效并需要新的 full-scope audit。

本次批准不包含任何 implementation diff、测试通过或实施完成声明；后续实施必须严格依据 R2，并在完成后接受独立 full-scope implementation audit。
````

### Round 3 independent verdict (verbatim)

````text
## Blocking findings

### B-01 Compaction marker 被误判为首个真实用户

- Violated invariant: INV-03 要求手动生成使用 active history 中首个真实用户；INV-05 要求只有技术消息时返回 `no_user_message`，不得生成成功。
- Evidence class: reachable
- Producer and execution path: `SessionCompaction.createMarker` 写入只有 `CompactionPart` 的 user 消息，且没有 `synthetic` 字段；`filterCompactedEffect` 将 marker 放在 active window 前部。手动 `generateTitle` 进入原 `title` 后，`real` 仅排除全 synthetic 消息，因此把 marker 当成真实用户，`slice(0, idx + 1)` 只保留该 marker。随后 Provider 输入是最近用户 memento 或固定的 “What did we do so far?”，而不是首个真实用户正文。
- Source evidence: `packages/opencode/src/session/compaction.ts:779-797`；`packages/schema/src/v1/session.ts:99-105,215-234`；`packages/opencode/src/session/message-v2.ts:1533-1540,1577-1588,761-775`；`packages/opencode/src/session/prompt.ts:482-504`。
- Canonical-plan evidence: 第 6 节“压缩后的 Session History”和“只有 synthetic/技术消息”两行；第 7 节 INV-03、INV-05；第 10.1 节“原函数的具体修改仅限”未包含 real-user 判定修复；第 16 节 slice 1 的压缩 active-window 验收及 slice 2 的 `no_user_message` 验收。
- Responsibility owner: `SessionPrompt` 原 `title` 函数中的 real-user 选择，不是 `MessageV2.filterCompactedEffect` 或新的 wrapper。
- Concrete behavioral consequence: 含真实用户尾部的压缩会话会基于技术 marker 生成偏离会话内容的标题；只有 compaction marker/summary 的 active window 会调用 LLM 并保存标题，而不是按计划返回 400。当前计划的生产修改清单无法同时满足其压缩成功与无真实用户失败测试。
- Minimal correction direction: 在原 `title` 的 real-user 判定中排除 compaction-only 技术消息，并用不含 memento 的压缩 fixture 验证“保留尾部时选择首个真实用户、只有技术消息时返回 `no_user_message`”，不要在 wrapper 中增加第二套 history filter 或 helper。

## Non-blocking findings

**NB-01 定向 HTTP 成功测试需要显式对齐模型夹具。**

`createTextMessage` 写入 `test/test`，而 `testProviderConfig` 只注册 `test/test-model` 且未设置 `small_model`，见 `packages/opencode/test/server/httpapi-session.test.ts:85-104` 和 `packages/opencode/test/lib/test-provider.ts:9-36`。直接 HTTP 200/跨目录测试应在既定测试配置中增加 `small_model: "test/test-model"`，或让 seeded user 使用 `test/test-model`；否则会在标题请求前得到 model-not-found。该修正属于已规划测试文件内的夹具细节，不扩大生产范围，因此不单独阻断。

## Rejected speculation

- 未要求 single-flight、CAS 或锁；现有 Rename 与 `Session.setTitle` 已是后写覆盖，用户没有要求新的一致性协议。
- 未要求 Esc 取消服务端请求；计划只抑制卸载后的 UI 副作用，边界正确。
- 未要求给独立 Protocol `ClientApi` 增加同名方法；TUI 消费 legacy SDK，Client 生成器来自另一套 Protocol 合同。
- 未要求 Provider/model fallback、自动重试、旧标题冒充成功、直接写 Sync store 或绕过 keymap 的 raw keyboard 路径。
- 未以“约 160 行、6 个生产文件”本身判定过设计；除 B-01 外，这些生产概念均有实际职责和需求映射。
- 未要求恢复 R2 的 `titleText` 抽取；B-01 可在原函数内用局部判定修复，不需要搬迁算法。

## Requirement and traceability coverage

| 原始要求/行为 | 独立核对结果 |
| --- | --- |
| 完整要求与 `approved-plan-only` | R3 逐字保留了原始三条要求、最小侵入要求和终态；当前 `Implementation allowed: no` 正确。 |
| `/rename` 与会话列表共用 Generate | 两个入口分别复用 `DialogSessionRename`，只需修改共享组件，不需要 caller 各自实现。 |
| 短文案 `Generate` | 计划的共享面板 footer 符合要求。 |
| 面板快捷键 | `Ctrl+G` 与全局 `messages_first` 的冲突真实存在；条件式 priority-1 binding、独立 rebind 和无 `onGenerate` 时不注册的设计成立。 |
| 复用现有自动标题算法 | 全库只有 `prompt.ts` 这一处生产标题算法；复用方向正确，但压缩输入的 real-user 选择受 B-01 阻断。 |
| 自动行为保持 | 自动负向 guard 和标题失败不阻断主回复的 characterization 具备行为敏感性。 |
| 成功持久化与 UI 同步 | `Session.setTitle → Session.get → Session.Updated` 是唯一写回路径；TUI 使用不过滤目录的 `/global/event`，跨目录更新可以到达 Sync。 |
| 失败与异步生命周期 | typed failure、HTTP 400/503/502、toast、busy、草稿保留和卸载 guard 均有真实 owner 与测试。 |
| SDK 与公共路由门禁 | legacy SDK 生成路径正确；`.withLlm()` exerciser scenario、`llmScenarios` 和完整 `test:httpapi` 覆盖了仓库门禁。 |
| 最小侵入 | 6 个既有生产文件的主结构合理；B-01 也可在原 `prompt.ts` 内修复，无需增加生产文件。 |
| 验证命令 | 工作目录和生成命令正确。本轮审计未执行测试，只读复核了计划记录的 keymap harness 与相关源码。 |

## Primary-path and fallback verdict

计划的权威主路径本身成立：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

自动与手动是同一算法的不同触发合同，不是失败后的替代成功路径。typed rejection、HTTP 错误、toast 和卸载 guard 均不产生成功形结果，未发现新增 fallback。

当前阻断点不是主路径数量，而是主路径在进入 LLM 前选择了错误的标题输入。

## Code quality and Chinese-comment verdict

- 生产变更集中在现有 owner，没有新增服务文件、依赖、迁移、锁、配置开关或第二套标题 helper。
- `TitleError`、可选 `onGenerate`、busy 状态和卸载 guard 都有可达行为依据，不属于推测性防御。
- generated SDK 与 Client 文件均要求通过既有生成器处理，没有手改生成输出的计划。
- 计划估算 `E ≈ 500`、要求 `C ≥ 75`，符合 `ceil(500 × 0.15)`；注释位置覆盖真实边界。
- 当前没有 implementation diff，实际 `E`、合格 `C` 和比例均为 **N/A**。实施审计必须重新计算；阻断底线为 `E > 0 && C/E < 0.10`。
- B-01 的修复可以保持在原函数和生产预算内，不需要借最小侵入之名保留错误行为。

## Release verdict

**BLOCK**

仅针对当前 **R3**：不能批准，`Implementation allowed` 必须保持 `no`，尚未达到 `approved-plan-only` 终态。

修复 B-01 后应递增 canonical revision，并重新进行完整范围的独立计划审计。
````

### Round 4 independent verdict (verbatim)

````text
## Blocking findings

### B-01 Compaction marker 仍会进入标题 Provider 请求

- Violated invariant: INV-03 及 slice 1 要求标题请求跳过 compaction marker，并使用 active history 中首个真实用户；仅修正 `real` predicate 没有满足该合同。
- Evidence class: reachable
- Producer and execution path: `SessionCompaction.createMarker` 写入仅含 `CompactionPart` 的 user 消息；`filterCompactedEffect` 将 marker、summary 和 retained real users 放入 active window。R4 的 `real` 虽跳过 marker，但首个真实用户的 `idx` 因而位于 marker 之后，现有 `context = input.history.slice(0, idx + 1)` 仍把 marker 包含在标题上下文中。随后 `toModelMessagesEffect` 将该 part 转换为固定的 `What did we do so far?`，最终进入 `llm.stream`。
- Source evidence: `packages/opencode/src/session/compaction.ts:779-797`；`packages/opencode/src/session/message-v2.ts:761-775,1533-1540,1577-1588`；`packages/opencode/src/session/prompt.ts:482-504`，尤其是当前 `context` 构造所在的 `prompt.ts:488`。
- Canonical-plan evidence: 第 7 节 INV-03；第 10.1 节第 3 项仅修改 `real`；第 16 节 slice 1 明确要求“请求跳过 marker 并使用首个 active 真实用户”。
- Responsibility owner: `SessionPrompt` 原 `title` 函数的标题上下文构造；`MessageV2.filterCompactedEffect` 的 active-window 合同本身正确，不应为标题需求改变。
- Concrete behavioral consequence: 压缩会话的手动 Generate 仍会把技术 marker 及摘要前缀送入标题模型，可能生成受压缩提示影响的标题；计划中“marker 不进入请求”的验收无法由当前生产修改方案通过。自动路径复用同一函数，也共享该输入污染。
- Minimal correction direction: 在原 `title` 构造 `context` 时同步剔除 compaction-only 技术消息，保留首个真实用户、其余前缀及现有转换/清洗逻辑，并用非-subtask 的压缩 fixture 验证 marker 未进入 Provider；无需新增 helper、生产文件或另一套 history filter。

## Non-blocking findings

**NB-01 `no_user_message` 的 compaction fixture 需要完成配对的 summary。**

`visibleCompactions` 会移除未与完成 summary 配对的 marker，见 `packages/opencode/src/session/message-v2.ts:1543-1571`。如果 slice 2 只写 marker，active window 会为空，旧 predicate 与新 predicate 都返回无用户，无法专门捕获 R3 的误判。fixture 应保留“完成且无错的 summary + compaction-only marker、无 memento、无其他真实用户”的拓扑；这不扩大生产范围。

**NB-02 明确 legacy SDK 的生成时点。**

slice 6/7 在 slice 8 前调用 `sdk.client.session.generateTitle`，而当前 SDK 尚无该方法。第 10.4 节已允许在 legacy group 完成后立即构建，因此实施时应在 group 完成后、Rename TDD 前执行 `bun run build`，slice 8 再作最终生成验证；不要手改 generated 文件或临时增加第二条 HTTP transport。

## Rejected speculation

- 不应 blanket 排除所有带 `goalTurnID` 的消息。compaction replay 会复制原始非 synthetic 用户 parts，见 `packages/opencode/src/session/compaction.ts:665-694`；这些正文仍可作为标题输入。B-01 只需处理 compaction-only 技术消息。
- 不要求 single-flight、CAS、锁或 Esc 取消已发出的 HTTP 请求；现有后写覆盖与卸载后的 UI guard 已对应实际合同。
- 不要求扩张独立 Protocol `ClientApi`。TUI 消费 legacy SDK，Client 生成器来自 Protocol 的独立合同。
- 不要求恢复 `titleText` 抽取、修改 `filterCompactedEffect`、增加 Provider/model fallback 或新增 slash command。
- 6 个生产文件、约 13 个局部 hunk、约 160 行本身不构成过设计；B-01 可在既定 `prompt.ts` 区域内修复。

## Requirement and traceability coverage

| 原始要求/行为 | 独立核对结果 |
| --- | --- |
| 完整要求与 `approved-plan-only` | R4 逐字保留原始要求和最小侵入要求；元数据为 `audit-required / R4 / Approved revision: none / Implementation allowed: no`，状态一致。 |
| `/rename` 与会话列表共用 Generate | `/rename` 在 `packages/tui/src/routes/session/index.tsx:1085-1095` 打开共享 `DialogSessionRename`；列表入口在 `packages/tui/src/component/dialog-session-list.tsx:721-726` 复用同一组件。无需修改两个 caller。 |
| 短文案 `Generate` 与面板快捷键 | `Ctrl+G` 与全局 `messages_first` 的冲突真实存在，见 `packages/tui/src/config/keybind.ts:141`。条件式 priority-1 binding、独立 rebind 和无 `onGenerate` 时不注册的设计符合现有 keymap。外部实验只证明机制，最终 Generate 测试仍有必要。 |
| 复用现有标题算法 | 原算法位于 `packages/opencode/src/session/prompt.ts:473-533`；R4 保持原函数和薄 wrapper，没有第二套 helper，但压缩上下文覆盖受 B-01 阻断。 |
| 自动命名行为保持 | parent/default/exactly-one guards、fork + `Effect.ignore`、负向 characterization 和失败不阻断主回复均有敏感测试安排。 |
| Active Session History 所有权 | wrapper 使用 `MessageV2.filterCompactedEffect`，没有绕开 cutoff/hidden/order owner。B-01 应在标题消费者局部处理，不应改变公共 active-window owner。 |
| 成功持久化与 UI 同步 | 唯一成功写入路径为 `Session.setTitle → Session.get → Session.Updated → TUI Sync`，见 `packages/tui/src/context/sync.tsx:1031-1047`；不直接写数据库或 Sync store。 |
| 失败与异步生命周期 | typed failure、400/503/502、toast、busy、草稿保留和卸载 guard 均有真实 owner 与测试映射，没有 catch-and-default success。 |
| SDK 与公共路由门禁 | legacy SDK 生成来源正确；独立 Client 只运行既定生成检查。`.withLlm()` exerciser scenario、`llmScenarios` 和完整 `test:httpapi` 已覆盖仓库门禁。 |
| 最小侵入 | 6 个生产文件分别对应 domain、HTTP group、handler、keybind、通用 DialogPrompt 和共享 Rename，属于当前架构下的合理硬最小集合。B-01 的修复不需要增加文件。 |
| 验证命令 | 工作目录和生成命令正确。本轮仅做只读源码核对，没有重新执行计划记录的测试或 keymap 实验。 |

## Primary-path and fallback verdict

计划的权威主路径成立：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title(manual: true)
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

后台自动命名与显式 Generate 是同一算法在不同触发合同下的使用，不是失败后的替代成功路径。typed rejection、HTTP 错误、toast 和卸载 guard 均不产生成功形结果；TestLLMServer 默认 `E2E Title` 仅是保留的 test-only 兼容行为。新增 alternate success path 为 0，diagnostic side-path 占比为 0%。

当前阻断点是主路径内部的标题上下文仍包含技术 marker，而不是 fallback 数量或责任边界错误。

## Code quality and Chinese-comment verdict

- 生产变更集中在现有 owner，没有新增服务文件、依赖、迁移、锁、配置开关或第二套标题 helper。
- `TitleError`、可选 `onGenerate`、busy 状态和卸载 guard 均有可达行为依据。
- generated SDK 与 Client 文件均要求通过既有生成器处理，没有手改生成输出的计划。
- 计划估算 `E ≈ 500`，要求 `C ≥ ceil(500 × 0.15) = 75`，算术正确；注释位置覆盖真实边界。
- 当前没有 implementation diff，实际 `E`、合格 `C` 和比例均为 **N/A**。实施审计必须重新计算；阻断底线为 `E > 0 && C/E < 0.10`，10% 至不足 15% 仅为非阻断质量提示。
- 只读 `git diff --stat` 为空，确认当前没有 tracked implementation diff。

## Release verdict

**BLOCK**

仅针对当前 **R4**：不能批准，`Implementation allowed` 必须保持 `no`，尚未达到 `approved-plan-only` 终态。

修复 B-01 后应递增 canonical revision，并重新进行完整范围的独立计划审计。
````

### Round 5 independent verdict (verbatim)

````text
## Blocking findings

### B-01 过滤 compaction marker 后仍使用旧索引，首个真实用户会丢失

- Violated invariant: INV-02/INV-03 要求压缩后的手动 Generate 使用 active history 中首个真实用户并成功保存标题。
- Evidence class: reachable
- Producer and execution path: 完成的 compaction 产生 `marker → summary → retained real users` 的 active window。R5 用 `findIndex(real)` 在未过滤 history 上取得 `idx`，随后从 `slice(0, idx + 1)` 中删除 marker，却仍沿用当前 `context[idx]` 获取 `firstUser`。marker 位于首个真实用户之前时，过滤后的数组缩短，`context[idx]` 因而为 `undefined` 或错误消息，提前返回而不是生成标题。
- Source evidence: `packages/opencode/src/session/prompt.ts:484-490` 当前先计算 `idx`，再读取 `context[idx]`；`packages/opencode/src/session/message-v2.ts:1533-1540` 证明 marker 和 summary 排在 retained users 之前；`packages/opencode/src/session/compaction.ts:779-797` 证明正常 marker 是 compaction-only user。
- Canonical-plan evidence: 第 10.1 节第 3 项只给 `context` 增加过滤，没有同步修正 `firstUser` 的索引来源；第 16 节 slice 1 明确要求上述压缩拓扑成功生成。
- Responsibility owner: `SessionPrompt` 原 `title` 函数中的首个用户选择与标题上下文构造。
- Concrete behavioral consequence: 按计划实施时，slice 1 的核心压缩成功场景仍无法得到 `200`/持久化标题；手动路径可能返回 `no_user_message` 或空成功，自动路径也会跳过本应生成的标题。
- Minimal correction direction: 在原 `title` 中让 `firstUser` 继续锚定未过滤的 `input.history[idx]`（或改用过滤后重新计算的索引），过滤后的 `context` 仅用于 Provider 转换，并用既定压缩成功用例锁定，无需新增 helper 或生产文件。

### B-02 用户明确要求的 `Generate` 展示文案没有行为敏感验收

- Violated invariant: INV-06 要求 Rename 面板显示短文案 `Generate`，不能继续显示用户认为过长的 `Generate Title`。
- Evidence class: contracted
- Producer and execution path: 用户打开 Rename 面板后，由 `DialogSessionRename` 渲染 `DialogPrompt`，footer 是动作文案的实际消费者。R5 的生产设计包含 footer，但具体 TDD slices 只断言 Ctrl+G 分发、rebind、全局键行为、busy、草稿和晚到响应，没有断言最终 frame 中的动作文案。
- Source evidence: `packages/tui/src/ui/dialog-prompt.tsx:173-199` 是当前 footer 所有者；`packages/tui/test/cli/tui/dialog-prompt.test.tsx:104-166` 展示现有键盘行为测试的观察 seam，可用于最终 frame 验收。
- Canonical-plan evidence: 第 1 节逐字商业文案要求；第 10.3 节要求显示 `Generate`；第 13 节 INV-06 行；第 16 节 slices 5–7 没有对应的文案断言。
- Responsibility owner: `DialogPrompt` footer 及其真实渲染测试。
- Concrete behavioral consequence: 实现即使完全不显示动作、或错误显示 `Generate Title`，仍可能通过计划中的全部测试，导致用户明确提出的商业展示要求未被验证。
- Minimal correction direction: 在既定 DialogPrompt/Rename frame 测试中增加精确 `Generate` 文案且排除 `Generate Title` 的断言，不增加任何生产抽象。

### B-03 子 Session 的手动 Generate 合同缺少正向测试

- Violated invariant: 第 6 节明确规定子 Session 的手动 Generate 不继承后台 parent guard；INV-02 要求现有 Rename 入口能够显式生成标题。
- Evidence class: reachable
- Producer and execution path: 子 Session 路由同样提供 `/rename`，该命令没有 parent 限制并打开共享 `DialogSessionRename`。当前原 `title` 在 LLM 前直接拒绝 `parentID`；R5 要求仅在非 manual 时保留该 guard，但测试只覆盖自动子 Session 负向 guard，没有手动子 Session 成功用例。
- Source evidence: `packages/tui/src/routes/session/index.tsx:1085-1095` 证明子 Session 也可到达 Rename；`packages/opencode/src/session/prompt.ts:479` 是现有 parent guard。
- Canonical-plan evidence: 第 6 节“子 Session 有真实用户/subtask 输入”行；第 10.1 节第 2 项；第 16 节 slice 1 的手动成功场景不是子 Session，slice 3 只验证自动子 Session 不生成。
- Responsibility owner: `SessionPrompt` 的 manual 触发合同及 `packages/opencode/test/session/prompt.test.ts`。
- Concrete behavioral consequence: 实现若错误地让 parent guard 同时作用于 manual，子 Session 的 Rename Generate 会失败，而计划内全部测试仍可通过。
- Minimal correction direction: 在既定 public `generateTitle` 成功测试中增加一个带 `parentID` 的正向用例，同时保留自动子 Session 负向 characterization，不扩大生产范围。

## Non-blocking findings

None.

## Rejected speculation

- 不要求 single-flight、CAS、锁或跨进程协调；现有 Rename 与 `Session.setTitle` 已采用后写覆盖，用户没有要求新的一致性协议。
- 不要求 Esc 取消已发出的请求；计划只抑制卸载后的 UI 副作用，边界正确。
- 不要求扩张独立 Protocol `ClientApi`。TUI 消费 legacy SDK，而 Client 生成器编译独立的 Protocol 合同。
- 不要求恢复 `titleText` 抽取、新增第二套标题 helper、Provider/model fallback、旧标题冒充成功或直接写 Sync store。
- 6 个生产文件、约 13 个局部 hunks、约 160 行本身不构成过设计；这些文件分别对应当前架构中不可省略的 domain、HTTP、keymap 和共享 UI owners。

## Requirement and traceability coverage

| 原始要求/行为 | 独立核对结果 |
| --- | --- |
| `approved-plan-only` | 元数据为 `R5 / audit-required / Approved revision: none / Implementation allowed: no`，状态一致；当前尚无 tracked implementation diff。 |
| `/rename` 与会话列表共用 Generate | 两个入口分别通过 `packages/tui/src/routes/session/index.tsx:1085-1095` 和 `packages/tui/src/component/dialog-session-list.tsx:721-726` 复用 `DialogSessionRename`，共享接入点正确。 |
| `Generate` 与面板快捷键 | 条件式 priority-1 binding、可覆盖 keybind、无 `onGenerate` 时不注册的设计符合现有 keymap；精确文案验收受 B-02 阻断。 |
| 复用现有算法并最小侵入 | 保留原 `title`、增加 manual 选项和薄 wrapper 的方向符合要求，没有算法搬迁；压缩上下文实现受 B-01 阻断。 |
| 自动命名行为保持 | parent/default/exactly-one guards、fork + `Effect.ignore`、负向 characterization 和失败不阻断主回复均有敏感测试安排。 |
| Active Session History | wrapper 使用 `MessageV2.filterCompactedEffect`，没有绕开 cutoff/hidden/order owner；R5 的 marker 过滤位置正确，但索引修正不完整。 |
| 成功、失败与 UI 生命周期 | `Session.setTitle → Session.get → Session.Updated` 是唯一写回路径；typed failure、HTTP 400/503/502、toast、busy、草稿和卸载 guard 均有 owner。 |
| 子 Session | 手动跳过 parent guard 有明确生产设计，但正向验证受 B-03 阻断。 |
| SDK 与公共路由门禁 | legacy SDK 生成来源正确；独立 Client 只运行既定检查。`.withLlm()` exerciser scenario、`llmScenarios` 和完整 `test:httpapi` 已覆盖仓库门禁。 |
| 跨目录 Session | handler 复用 `inSessionDirectory`，双目录测试能够发现 ambient Provider/Agent 误用。 |
| 验证命令 | 工作目录与生成命令正确。本轮只读复核源码及计划记录的 harness，没有重新执行测试。 |

## Primary-path and fallback verdict

计划的权威主路径保持单一：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title(manual: true)
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

自动与手动是同一算法在不同触发合同下的使用，不是失败后的替代成功路径。typed rejection、HTTP 错误、toast 和卸载 guard 均不产生成功形结果；TestLLMServer 默认 `E2E Title` 仅是 test-only 兼容行为。新增 alternate success path 为 0，diagnostic side-path 占比为 0%。

当前主路径在压缩输入上的首个真实用户选择受 B-01 阻断，另有两项确认行为的测试敏感性缺口。

## Code quality and Chinese-comment verdict

- 生产变更集中在现有 owners，没有新增服务文件、依赖、迁移、锁、配置开关或第二套标题 helper。
- `TitleError`、可选 `onGenerate`、busy 状态和卸载 guard 都有可达行为依据。
- legacy SDK 与 Client 文件均要求通过既有生成器处理，没有手改生成输出的计划。
- 计划估算 `E ≈ 500`，要求 `C ≥ ceil(500 × 0.15) = 75`，算术正确；注释位置覆盖真实边界，排除空行、import-only、formatter-only 和 generated 的方法符合政策。
- 当前是计划审计，实际 `E`、合格 `C` 和比例为 **N/A**。实施审计必须重新计算；阻断底线为 `E > 0 && C/E < 0.10`。
- 只读 `git diff --stat` 及目标生产文件 diff 均为空，确认当前没有 implementation diff；本轮未执行实施验证。

## Release verdict

**BLOCK**

仅针对当前 **R5**：不能批准，`Implementation allowed` 必须保持 `no`，尚未达到 `approved-plan-only` 终态。

修复 B-01 至 B-03 后应递增 canonical revision，并进行第 6 轮完整范围独立计划审计。
````

### Round 6 independent verdict (verbatim)

````text
## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- **不要求 single-flight、CAS、锁或跨进程协调。** 自动与手动生成、多个手动请求确实可能并发，但现有 Rename 与 `Session.setTitle` 已采用后写覆盖；用户没有要求新的一致性协议，见 `packages/opencode/src/session/session.ts:757-778`。
- **不要求 Esc 取消已发出的请求。** 可达问题是卸载后的 Promise 回调误关新面板或显示陈旧 toast；计划的卸载守卫覆盖了该 UI 问题，没有伪称取消服务端写回。
- **不要求扩张独立 Protocol `ClientApi`。** TUI 消费 legacy SDK，见 `packages/tui/src/context/sdk.tsx:45-52`；Client 生成器编译独立的 Protocol 合同，见 `packages/client/script/build.ts:3-7`、`packages/client/src/contract.ts:14-17`。
- **不要求 Provider/model fallback、自动补偿、旧标题冒充成功或直接写 Sync store。** 这些会改变既有 best-effort 边界或增加第二成功路径。
- **不恢复 `titleText` 抽取，不新增第二套标题 helper。** 当前生产标题请求只存在于 `packages/opencode/src/session/prompt.ts:473-533`，R6 在原函数上接线符合用户的最小侵入要求。
- **不把 TestLLMServer 默认 `E2E Title` 视为 production fallback。** 它是保留现有测试隔离的 test-only 兼容行为；独立标题队列用于表达成功、空输出和错误。
- **不因约 160 行、6 个生产文件本身判定过设计。** 这些文件分别对应当前架构中的 domain、HTTP group、HTTP handler、keybind、通用 DialogPrompt 和共享 Rename owner，没有发现可删除而不损失确认行为的文件。

## Requirement and traceability coverage

| 原始要求或行为 | 独立核对结果 |
| --- | --- |
| 完整要求与 `approved-plan-only` | R6 第 1 节逐字保留三条原始要求、最小侵入要求和终态；元数据为 `R6 / audit-required / Approved revision: none / Implementation allowed: no`，状态一致。 |
| `/rename` 与会话列表共用 Generate | `/rename` 在 `packages/tui/src/routes/session/index.tsx:1085-1095` 打开共享 `DialogSessionRename`；列表入口在 `packages/tui/src/component/dialog-session-list.tsx:721-726` 复用同一组件。无需修改两个 caller。 |
| 短文案 `Generate` | R6 第 10.3 节由共享 DialogPrompt footer 显示 `Generate`；第 16 节 slice 5 明确要求真实 frame 含 `Generate` 且不含 `Generate Title`，修复了 R5 的验证缺口。 |
| 面板快捷键 | 全局 `messages_first` 已占用 `Ctrl+G`，见 `packages/tui/src/config/keybind.ts:141`。DialogPrompt 已有 targeted priority-1 binding，见 `packages/tui/src/ui/dialog-prompt.tsx:85-112`；隔离 harness 在同键下得到 `confirmed=["draft"]`、`global=[]`，见 `D:\Temp\opencode\dialog-ctrl-g-scope.test.tsx:53-55,102-104`。R6 仍安排最终 Generate command、rebind 和无 `onGenerate` 时的全局行为测试，没有用机制实验替代验收。 |
| 复用现有标题算法 | 原算法位于 `packages/opencode/src/session/prompt.ts:473-533`，涵盖真实用户选择、subtask、模型选择、消息转换、单次 `llm.stream`、清洗及 100 字符截断。R6 仅增加 manual 触发选项和薄 wrapper，没有复制或搬移算法。 |
| 压缩历史的首个真实用户 | `filterCompactedEffect` 是 active-window owner，见 `packages/opencode/src/session/message-v2.ts:1577-1588`；正常 marker 是 compaction-only user，见 `packages/opencode/src/session/compaction.ts:779-797`。R6 同时修正 real predicate、Provider context 过滤和 `firstUser=input.history[idx]`，避免了此前三轮分别出现的误选 marker、marker 进入请求和过滤后索引漂移。 |
| 子 Session 与多轮 Session | manual 仅跳过 parent/default/exactly-one 自动 guards；slice 1 现包含带 `parentID` 的手动子 Session 正向用例，slice 3 保留自动子 Session 负向 characterization，手动与自动合同均有行为敏感验证。 |
| 自动命名行为保持 | 当前后台路径在第一步 fork 并 `Effect.ignore`，见 `packages/opencode/src/session/prompt.ts:1929-1936`。R6 保留该调用形状，并安排默认首轮成功、自定义标题/子 Session/多轮负向 guard，以及标题失败不阻断主回复的测试。 |
| 成功持久化与 UI 同步 | 唯一写入路径为 `Session.setTitle → Session.get → Session.Updated → TUI Sync`；Sync 已消费完整更新快照，见 `packages/tui/src/context/sync.tsx:1031-1047`。计划没有直接写数据库或 Sync store。 |
| 失败可见且不伪装成功 | 无真实用户、agent/model 不可用、Provider/empty 输出分别进入 typed rejection；HTTP 400/503/502 与 UI toast 均有 owner 和测试。既有 wire error 类型可直接复用，见 `packages/opencode/src/server/routes/instance/httpapi/errors.ts:3-51`。失败发生在写回前，旧标题保持不变。 |
| Busy、草稿与晚到响应 | DialogPrompt 已有 busy 禁键、textarea 保留和 spinner，见 `packages/tui/src/ui/dialog-prompt.tsx:77-88,124-138,169-175`。deferred POST、重复 Ctrl+G/Enter、失败草稿和 Esc 后 sentinel panel 测试覆盖新增异步生命周期。 |
| 跨目录 Session | `inSessionDirectory` 从持久化 Session directory 提供实例上下文，见 `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:82-90`。双目录测试能够发现 ambient Provider/Agent 误用。 |
| legacy SDK 与 Client 生成 | legacy SDK 由 `packages/sdk/js/script/build.ts` 从 legacy OpenAPI 生成；独立 Client 只运行既定生成/test/typecheck。两条合同来源没有混淆，也不要求手改 generated 输出。 |
| 公共路由门禁 | 新路由登记 `.mutating().withLlm()` exerciser scenario、加入 `llmScenarios`，并运行完整 `bun run test:httpapi`。coverage/auth/effect 门禁及 LLM 约束见 `packages/opencode/test/server/httpapi-exercise/index.ts:1971-2018`、`packages/opencode/package.json:22`。 |
| TDD 敏感性 | Service 方法不存在、路由 404、Ctrl+G 不发 POST 均能在当前行为上产生有效 red。自动 characterization 可在基线通过，但删除 guards 或失败忽略边界会由外部 titleHits、标题 readback 和主回复断言捕获。 |
| 最小侵入 | 第 15.1 节将生产修改限制为 6 个既有文件、约 13 个局部 hunks、约 160 有效行；逐函数预算与真实 owner 对应，没有以删减确认行为换取行数。 |

第 13 节 forward traceability 已覆盖 INV-01 至 INV-12；第 14 节 reverse traceability 对新增 domain 操作、manual 选项、typed error、endpoint、keybind、可选 prop、异步状态、卸载守卫和测试 fixture 均给出了证据及现有逻辑无法承载的原因。没有发现无需求支撑的生产概念。

## Primary-path and fallback verdict

R6 的权威主路径成立：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title(manual: true)
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

后台自动命名与显式 Generate 是同一算法的不同触发合同，不是失败后的替代成功路径。typed rejection、HTTP 错误、toast、保留草稿和卸载后忽略 UI completion 均不产生成功形结果；TestLLMServer 默认标题仅是 test-only 兼容行为。

新增 alternate success path 为 **0**，diagnostic side-path 占比为 **0%**。R5 的压缩索引、精确文案验收和手动子 Session 验收三项阻断均已在 R6 的生产路径或行为测试中得到实质修正。

## Code quality and Chinese-comment verdict

- 变更集中在现有 owners，没有新增服务文件、依赖、迁移、锁、配置开关、raw keyboard 路径或第二套标题 helper。
- `TitleError`、可选 `onGenerate`、busy 状态和卸载 guard 都有可达行为依据，不属于推测性防御。
- legacy SDK 与 Client 文件均要求通过既有生成器处理，没有手改生成输出的计划。
- 验证命令使用正确的 package 工作目录，包含定向测试、完整 HttpApi exerciser、两条生成链、SDK/Client 测试和各包 typecheck；没有从仓库根目录运行测试。
- 计划估算 `E ≈ 500`，其中生产约 160、测试约 340；要求 `C ≥ ceil(500 × 0.15) = 75`，算术正确。空行、import-only、formatter-only、generated 和 pure move 的排除方式符合政策。
- 中文注释计划覆盖 manual/automatic guard、active history、压缩 marker、错误转换、双目录、fixture 队列隔离、keymap 作用域和 Dialog 生命周期，并要求靠近对应决策分布，具备可执行性。
- 当前是计划审计，没有 implementation diff，因此实际 `E`、实际合格 `C` 和实际比例为 **N/A**。实施审计必须重新计算；阻断底线为 `E > 0 && C/E < 0.10`，10% 至不足 15% 为非阻断质量提示。
- 只读 `git status --short` 仅显示既有未跟踪计划文件，`git diff --stat` 为空，确认当前没有 tracked implementation diff。本轮未执行实施测试。

## Release verdict

**APPROVE**

仅批准当前审计的 **R6** canonical plan：`docs/plans/tui-generate-session-title.md`。

编排主代理可将本独立 verdict 原样记录后，对同一 R6 执行行政审批字段转换：

```text
Status: approved
Revision: R6
Approved revision: R6
Implementation allowed: yes
```

任何实质性计划修改都会使本次批准失效并需要新的 full-scope audit。

本次批准不包含任何 implementation diff、测试通过或实施完成声明；后续实施必须严格依据 R6，并在完成后接受独立 full-scope implementation audit。
````

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

用户已把终态升级为 verified-implementation-and-commit。本节记录 exact R6 的实际实施证据；设计没有新增 revision。

### Actual Files and Diff

- 6 个既有 production 文件：`session/prompt.ts`、Session HttpApi group/handler、TUI keybind、DialogPrompt、DialogSessionRename。
- 6 个既有 test/fixture 文件：`test/lib/llm-server.ts`、`test/session/prompt.test.ts`、`test/server/httpapi-session.test.ts`、`test/server/httpapi-exercise/index.ts`、DialogPrompt 测试、DialogSessionList 测试。
- 2 个 legacy generator-owned 文件：`packages/sdk/js/src/v2/gen/sdk.gen.ts` 和 `types.gen.ts`；Client 没有 title 方法 diff。
- Canonical plan 本身是唯一新增的 untracked handwritten 文件。既有无关 plan 保持未跟踪、未修改。
- 第 1 轮审计时的 tracked diff 为 14 个文件、848 additions / 41 deletions（含注释、测试和 generated）。审计独立计算生产有效代码为 128 行；没有新增 production 文件。
- 曾误运行全文件 Prettier并经用户明确授权恢复 8 个文件后重放 R6 hunks；最终 diff 不包含那次格式化扩散。`packages/opencode/config.json` 的换行副作用已手工复原，不属于本 GOAL diff。

### Red-Green Test Evidence

| Slice | Red evidence | Green evidence |
| --- | --- | --- |
| Public service success | `prompt.generateTitle is not a function`，0 pass / 1 fail | 压缩 active history 与子 Session 成功，1 pass；修正测试对第二条 active 用户的越界预期后保持通过 |
| Public service failures | `Schema.Literal` 只接受首项，4 fail / 3 pass；改为 `Schema.Literals` | 7 个 typed failure 全过，旧标题不变；stream/orDie 窄映射保留安全失败 |
| Automatic characterization | 新增默认首轮、三个 guard 和失败非阻塞用例 | 5 pass / 0 fail；主回复与 title queue 隔离 |
| HTTP | 旧路由落入 UI fallback，成功请求返回 `200 HTML`，错误期望不满足 | 初轮 NotFound 映射过宽后为 5 pass / 0 fail；跨目录 200 和 404/400/503/502 全过 |
| DialogPrompt | 缺少 `Generate`、rebind 未声明；全局 probe 初用配置键而非 command 名 | 修正 probe 为 `session.first` 后 3 个新用例通过，完整文件 8 pass |
| Rename | 打开面板后没有 Generate，POST 未发出 | deferred success、HTTP/transport failure、卸载 sentinel 共 4 pass；真实 Toast 和草稿进入验收 |
| Exerciser | 新路由没有 scenario | 定向 `session.generateTitle` 为 1 pass / 0 fail / missing=0 / extra=0 |

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 139 pass / 15 skip / 0 fail；包含 13 个新 title 用例 |
| `bun test test/server/httpapi-session.test.ts --timeout 30000` | `packages/opencode` | 32 pass / 0 fail |
| `bun test test/cli/tui/dialog-prompt.test.tsx test/cli/cmd/tui/dialog-session-list.test.tsx --timeout 30000` | `packages/tui` | 28 pass / 0 fail；注释最终复验同为 28 pass |
| `bun run script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip`（由 `test:httpapi` 执行） | `packages/opencode` | 225 pass / 0 fail / missing=0 / extra=0 |
| 同上 `--mode auth` | `packages/opencode` | 225 pass / 0 fail / missing=0 / extra=0 |
| `bun run script/httpapi-exercise.ts --mode effect --include session.generateTitle --fail-on-skip` | `packages/opencode` | 1 pass / 0 fail；title 路由通过 |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip` | `packages/opencode` | 222 pass / 3 fail；失败仅为 `pty.create`、`v2.pty.create`、`worktree.reset`，title 通过 |
| 上述 effect `--include pty.create` | `packages/opencode` | 隔离复跑仍 1 pass / 2 fail；两个 PTY create 失败可重复 |
| 上述 effect `--include worktree.reset` | `packages/opencode` | 隔离复跑仍 0 pass / 1 fail；不是并行瞬时失败 |
| Linux Bun 1.4.4：`bun run script/httpapi-exercise.ts --mode effect --include pty.create --fail-on-skip` | WSL `/mnt/f/.../packages/opencode` | 3 pass / 0 fail / missing=0 / extra=0；两个 PTY create 均通过 |
| Linux Bun 1.4.4：上述 effect `--include worktree.reset` | WSL `/mnt/f/.../packages/opencode` | 1 pass / 0 fail；reset 通过 |
| Linux Bun 1.4.4：`bun run test:httpapi` | WSL `/mnt/f/.../packages/opencode` | coverage、auth、effect 各 225 pass / 0 fail / skip=0 / missing=0 / extra=0；完整命令 exit 0 |
| `bun run generate && bun test --timeout 5000 && bun typecheck` | `packages/client` | 生成成功，16 pass，typecheck 通过；无 title Client diff |
| `bun run build && bun test && bun typecheck` | `packages/sdk/js` | legacy 生成成功，1 pass，typecheck 通过；存在 `session.generateTitle` |
| `bun typecheck` | `packages/opencode`、`packages/tui` | 均通过；最终注释后再次通过 |
| `git diff --check` | repository root | 通过，无 whitespace error；未从 root 运行测试 |

### Original Feedback-Loop Result

最初缺失的手动生成 seam 已从公共 service、真实 HTTP 和真实 TUI 三条路径完成 red-green。既有 Provider 429/SSE timeout 属于上游可靠性，不在本 feature 内修复；手动路径现在以 typed HTTP/UI 失败呈现，不伪装成功。

### Actual Secondary and Replacement Path Inventory

- 主路径保持 `Rename → legacy SDK POST → inSessionDirectory → SessionPrompt.generateTitle → 原 title(manual=true) → Session.setTitle → Session.Updated`。
- 自动 ensureTitle 与手动 Generate 是同一算法的两个触发合同；alternate success path 为 0，replacement path 为 0，diagnostic side-path 占比为 0%。
- 没有 catch-and-success、旧标题冒充成功、Provider/model fallback、直接 DB/Sync store 写入或新增锁。
- TestLLMServer 默认 `E2E Title` 仅是既有 test-only 兼容，不是 production fallback。
- 没有需要保留的被淘汰 workaround；R2 的 `titleText` 抽取方案未实施，最终没有第二套标题 helper。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | **600** | 第 1 轮独立审计按 755 个 handwritten tracked added lines 排除 28 空行、21 import-only、97 comment-only 和 9 formatter-only 后计算；generated、generated 类型移动及 untracked plan 均不计。生产 128，测试/fixture 472。 |
| Qualifying Chinese comment lines `C` | **97** | 分布在 12 个 handwritten 修改文件；解释 manual guard、压缩 marker、索引、错误映射、双目录、fixture 隔离、快捷键作用域和 Dialog 生命周期，不复述代码。 |
| Ratio `C / E` | **16.17%** | `97 / 600 = 0.161667`，审计报告按两位小数记为 16.17%。 |
| Required minimum `C` | **90** | `ceil(600 × 0.15) = 90`；实际 97，满足门禁。 |

### B-01 Rework Evidence

- 直接 Windows 复现保持稳定：PTY 为 1 pass / 2 fail，worktree reset 为 0 pass / 1 fail。仓库 HttpApi CI 在 `.github/workflows/test.yml:320-356` 明确使用 `ubuntu-latest`；相关 PTY/worktree 单测也对 Windows 有平台限制，因此改用同一 POSIX 运行环境，而不修改或跳过场景。
- 在已批准的 `D:\Temp\opencode\bun-linux-1.4.4-title-gate` 隔离放置与根 `packageManager` 一致的 Linux Bun 1.4.4。实际执行形式为 `wsl --cd /mnt/f/ML/PythonAIProject/Claude-Code/opencode/packages/opencode --exec bash -lc 'export PATH=/mnt/d/Temp/opencode/bun-linux-1.4.4-title-gate/bun-linux-x64-baseline:$PATH; bun run test:httpapi'`；没有向仓库安装依赖或修改 production/test。
- Linux 定向复跑将 PTY 转为 3 pass / 0 fail、worktree reset 转为 1 pass / 0 fail；随后同一最终工作树完整 `bun run test:httpapi` exit 0，coverage、auth、effect 三种模式各 **225 pass / 0 fail / skip=0 / missing=0 / extra=0**。B-01 已消除，E/C 与生产 diff 不变。
- Linux 验证过程中 `packages/opencode/config.json` 仅丢失末尾换行；已恢复为 HEAD 内容，最终不属于本 GOAL diff。

### Remaining Unverified Items

- 无。所有 approved 行为测试、生成检查、typecheck 和完整 HttpApi 门禁均已执行并取得通过结果；Windows 原生 HttpApi 失败由上述支持平台差异解释，不再作为最终门禁缺口。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R6 | yes | B-01：完整 `test:httpapi` 的 effect 模式 222 pass / 3 fail | NB-01：diff 与 E 统计行政校正 | **BLOCK** | `ses_e3e49d6e0ffeepm1gpMrSlWa1l` |
| 2 | R6 | yes | No blocking findings | NB-01：实际 17 个 production hunks 高于约 13 的估算，但 6 文件、128 有效行且无语义扩张 | **APPROVE** | `ses_e3e2ddcc5ffe312frftE430sCZ` |

### Round 1 independent verdict (verbatim)

## Blocking findings

### B-01 全量 HttpApi 门禁未通过，不能进入 verified

- Violated invariant: R6 第 18.2 节要求完整 `bun run test:httpapi` 的 coverage、auth、effect 三种模式全部通过；仓库完成门禁也要求必需的测试命令通过。
- Evidence class: observed
- Producer and execution path: `bun run test:httpapi` 依次执行 coverage、auth、effect。coverage/auth 记录为通过，但完整 effect 为 **222 pass / 3 fail**；`pty.create`、`v2.pty.create`、`worktree.reset` 隔离复跑仍失败。因此完整命令没有得到成功终态，title 定向场景通过不能替代该命令。
- Source evidence: `packages/opencode/package.json:22`；`docs/plans/tui-generate-session-title.md:1130-1132`、`:1161-1162`。
- Canonical-plan evidence: 第 18.2 节“Approved implementation verification”及第 23 节“Remaining Unverified Items”。
- Responsibility owner: HttpApi exerciser 验证所有者及相关失败场景/运行环境的责任模块；本审计不将这三个失败归因于 title diff。
- Concrete behavioral consequence: 当前实现不满足 R6 自己规定的验证完成条件，不能标记 `verified`，也不能进入目标终态中的验证后提交。
- Minimal correction direction: 在相应场景或环境责任边界内恢复完整 `bun run test:httpapi` 全绿，并在同一最终工作树重跑；不要用 title 定向通过、跳过场景或收窄门禁替代全量验证。

## Non-blocking findings

**NB-01 实施证据中的统计需要行政校正。**

实际 tracked diff 为 **848 additions / 41 deletions**，不是计划记录的约 863 / 54。独立重算得到 `E=600`、`C=97`，而计划记录为 `E=625`。这些属于记录漂移，不影响行为或注释门禁结论。

本轮仅执行了只读 git 检查；`git diff --check` 通过。没有重跑 Bun 测试，上述 B-01 来自 R6 已记录的失败结果与仓库命令合同。

## Rejected speculation

- 没有把 `pty.create`、`v2.pty.create`、`worktree.reset` 认定为本次 diff 引入的回归；R6 明确没有 HEAD 基线复跑。阻断依据是必需门禁未通过，而不是要求本功能顺带修复这些模块。
- 不要求为自动/手动并发增加 single-flight、CAS 或锁；现有 `Session.setTitle` 保持后写覆盖语义，用户没有要求新一致性协议。
- 不要求 Esc 取消已发出的 HTTP 请求；当前卸载守卫只抑制晚到 UI 副作用，边界正确。
- 不要求扩张独立 Protocol ClientApi、增加 Provider/model fallback、恢复 `titleText` 抽取或另建标题 helper；这些都不属于原始最小接入需求。

## Requirement and traceability coverage

| 原始要求或 R6 行为 | 独立核对结果 |
| --- | --- |
| `/rename` 与会话列表都能 Generate | 两个入口分别位于 `packages/tui/src/routes/session/index.tsx:1094` 和 `packages/tui/src/component/dialog-session-list.tsx:725`，共同渲染 `DialogSessionRename`，没有两套生成逻辑。 |
| 短文案 `Generate` | `packages/tui/src/ui/dialog-prompt.tsx:195-200` 显示精确文案；真实 frame 测试同时排除 `Generate Title`。 |
| 面板快捷键 | `dialog.prompt.generate=ctrl+g` 已声明；`dialog-prompt.tsx:120-124` 仅在存在 `onGenerate` 时注册局部 binding。测试覆盖默认冲突、rebind 和无 action 时的全局行为。 |
| 复用已有标题算法 | `packages/opencode/src/session/prompt.ts:481-575` 仍是唯一标题算法；手动 wrapper 在 `:577-582` 只加载 Session/active history 并调用 `title(manual:true)`。没有第二套 cleaner、模型选择或持久化路径。 |
| 多轮、自定义及子 Session | manual 只跳过 parent/default/exactly-one 自动 guards；compaction-only 过滤、真实用户选择和未过滤索引锚点位于 `prompt.ts:492-509`。测试覆盖压缩 active window、多轮、自定义标题及手动子 Session。 |
| 自动命名行为保持 | 后台仍在 `prompt.ts:1979-1985` fork 并 `Effect.ignore`；默认首轮、三个负向 guard 和失败不阻断主回复均有行为测试。 |
| 持久化及 UI 同步 | 唯一写回为 `Session.setTitle`，手动随后 `Session.get`；TUI 继续消费既有 `session.updated`，没有直接写数据库或 Sync store。 |
| HTTP、错误及跨目录 | endpoint、四类领域错误映射和 `inSessionDirectory` 均已接线；测试覆盖 200、400、404、502、503、旧标题保留和跨目录 Provider 定位。 |
| Busy、草稿及晚到响应 | `dialog-session-rename.tsx:19-44` 使用 generating 和 disposed；测试覆盖重复 POST/PATCH、HTTP/transport 失败草稿保留及卸载后的 sentinel。 |
| legacy SDK 与 Client 边界 | legacy SDK 新增 `generateTitle` 及对应错误/响应类型；Client 没有 title 方法扩散。 |
| 最小侵入 | 仅 6 个既有 production 文件，独立计算 production `E=128`，低于 R6 约 160 行预算；没有新增 production 文件。 |
| 必需仓库验证 | **不完整，受 B-01 阻断。** |

新增测试对原缺失能力具有敏感性：原 Service 没有 `generateTitle`、原路由不存在、原面板没有 Generate binding。自动路径 characterization 可在旧基线通过，但删除 guards 或失败隔离边界会由标题请求、readback 和主回复断言捕获。

## Primary-path and fallback verdict

实际权威主路径为：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title(manual: true)
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

后台自动命名与显式 Generate 是同一算法的不同触发合同，不是失败后的替代成功路径。无真实用户、模型不可用、Provider/空输出失败均进入非成功终态；HTTP 错误、toast 和卸载后忽略 UI completion 不会制造成功结果。

TestLLMServer 的默认 `E2E Title` 是保留的 test-only 兼容行为。实际新增 alternate success path 为 **0**，diagnostic side-path 占比为 **0%**。

## Code quality and Chinese-comment verdict

- 变更落在现有 domain、HTTP、keymap、DialogPrompt 和共享 Rename 所有者内，没有新增依赖、迁移、锁、配置开关或重复标题 helper。
- 未发现新增 `any`、unchecked cast、non-null assertion、错误吞没或权限削弱。
- generated diff 仅包含 title endpoint、相关类型及生成器导致的既有类型位置变化。
- 中文注释独立计算如下：

```text
12 个 handwritten tracked 文件新增行：755
排除空行：28
排除 import-only：21
排除 comment-only：97
排除纯格式化行：9
E = 755 - 28 - 21 - 97 - 9 = 600

合格中文解释注释 C = 97
C / E = 97 / 600 = 16.17%
15% 目标所需 C = ceil(600 × 0.15) = 90
10% 阻断底线所需 C = 60
```

另行排除了 93 行 generated additions、generated 类型移动及 untracked 计划文档。9 行格式化排除项来自 TestLLMServer 的 SSE 对象展开和 DialogPrompt 测试的 JSX 展开。注释分布在 12 个 handwritten 文件的实际决策附近，解释 guard、压缩边界、错误映射、双目录、fixture 隔离、keymap 和 Dialog 生命周期，满足 15% 目标。

## Release verdict

**BLOCK**

仅审计当前 **R6** 与指定实际 diff。主路径、复用范围、代码质量和中文注释门禁通过，但完整 `test:httpapi` 尚未通过，因此不能标记 `verified` 或进入验证后提交。解决 B-01 后需要进行完整范围的独立实现复审。

### Round 2 independent verdict (verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

**NB-01 生产 hunk 数高于估算，但没有语义扩张。** 实际为 **17 个局部 production diff hunk**，R6 估算约 13 个；差异来自 import、endpoint 注册、props/shortcut 和 footer 等必要接线。实际仍是 **6 个既有生产文件、128 个有效改动行**，低于约 160 行预算，符合用户的最小侵入要求。

## Rejected speculation

- **不需要 single-flight、CAS 或锁。** 自动与手动生成仍复用现有 `Session.setTitle` 后写覆盖语义，用户没有要求新一致性协议。
- **不需要 Esc 取消服务端请求。** `dialog-session-rename.tsx:20-44` 只抑制卸载后的 UI 回调，避免误关后续面板，没有伪称取消 HTTP。
- **不需要扩张 Protocol ClientApi。** TUI 消费 legacy SDK；新生成方法位于 `packages/sdk/js/src/v2/gen/sdk.gen.ts:4175`。Client 生成器仍编译独立的 `ClientApi`，见 `packages/client/script/build.ts:7-25`。
- **不需要第二套标题 helper、Provider/model fallback 或直接写 Sync store。** 失败均进入 typed rejection、HTTP 错误或 toast，没有旧标题冒充成功。
- **transport rejection 没有漏处理。** legacy SDK 会把 fetch rejection 转成 `result.error`，见 `packages/sdk/js/src/v2/gen/client/client.gen.ts:90-116`；TUI 同时处理 `result.error` 和 Promise rejection，见 `dialog-session-rename.tsx:36-44`。

## Requirement and traceability coverage

| 原始要求或 R6 行为 | 独立核对结果 |
|---|---|
| 两个 Rename 入口 | `/rename` 在 `packages/tui/src/routes/session/index.tsx:1094`、列表入口在 `packages/tui/src/component/dialog-session-list.tsx:725`，共同使用 `DialogSessionRename`。 |
| 短文案与快捷键 | `dialog.prompt.generate=ctrl+g` 位于 `packages/tui/src/config/keybind.ts:213-214`；局部 binding 和 footer 位于 `dialog-prompt.tsx:87-127,195-200`。测试覆盖默认冲突、rebind、无 action 时的全局行为及精确 `Generate` 文案。 |
| 复用现有算法 | `packages/opencode/src/session/prompt.ts:481-575` 仍是唯一标题算法；`generateTitle` wrapper 在 `:577-582` 仅加载 Session/active history 并调用 `title(manual:true)`。 |
| 自动行为保持 | 后台仍在 `prompt.ts:1979-1985` fork 并 `Effect.ignore`；默认首轮、三个负向 guard 和失败不阻塞主回复均有测试，见 `prompt.test.ts:7389-7467`。 |
| 多轮、自定义、压缩及子 Session | manual 只跳过自动 parent/default/exactly-one guards；真实用户选择、compaction-only 过滤和未过滤索引锚点位于 `prompt.ts:488-537`。正向与七类失败测试位于 `prompt.test.ts:7239-7384`。 |
| HTTP、持久化及跨目录 | endpoint 位于 `groups/session.ts:333-346`；handler 复用 `inSessionDirectory` 并映射 400/404/502/503，见 `handlers/session.ts:297-316`。真实 HTTP 测试位于 `httpapi-session.test.ts:1504-1572`。 |
| Busy、草稿及晚到响应 | `dialog-session-rename.tsx:19-44` 使用 generating/disposed；测试覆盖重复 POST/PATCH、HTTP/transport 失败和卸载 sentinel，见 `dialog-session-list.test.tsx:660-768`。 |
| 公共路由门禁 | `httpapi-exercise/index.ts:1461-1486` 登记真实 `.mutating().withLlm()` 场景，`:1997-1998` 纳入 `llmScenarios`。 |
| SDK 与 Client 边界 | legacy SDK 新增 `generateTitle` 和对应类型；Client 没有 title 方法扩散。 |
| 最小侵入 | 仅 6 个既有生产文件、128 个有效生产改动行；没有新增生产文件、依赖、迁移、配置开关或重复算法。 |

新增测试对原缺失能力具有敏感性：原 Service 没有 `generateTitle`、原路由不存在、原面板不会发出 title POST。自动 characterization 则由 Provider HTTP `titleHits`、标题 readback 和主回复结果保护。

验证证据位于 canonical plan 第 23 节：

- Service：**139 pass / 15 skip / 0 fail**。
- Session HTTP：**32 pass / 0 fail**。
- TUI：**28 pass / 0 fail**。
- Client：generate 成功、**16 pass**、typecheck 通过。
- legacy SDK：build 成功、**1 pass**、typecheck 通过。
- opencode/tui typecheck 均通过。
- Linux Bun 1.4.4 下完整 `bun run test:httpapi`：coverage/auth/effect 各 **225 pass / 0 fail / skip=0 / missing=0 / extra=0**。仓库该门禁本来就在 Ubuntu 运行，见 `.github/workflows/test.yml:317-356`；第 1 轮的 Windows PTY/worktree 环境失败已不再构成验证缺口。
- 本轮独立执行了 `git diff --check`，通过；未重跑 Bun 命令。

## Primary-path and fallback verdict

实际权威主路径为：

```text
/rename 或会话列表 Rename
  → DialogSessionRename / DialogPrompt Generate
  → legacy SDK POST /session/:sessionID/title
  → inSessionDirectory
  → SessionPrompt.generateTitle
  → MessageV2.filterCompactedEffect
  → 原 title(manual: true)
  → Session.setTitle
  → Session.get / Session.Updated / TUI Sync
```

后台自动命名与显式 Generate 是同一算法的不同触发合同，不是失败后的替代成功路径。现有手动 PATCH 仍是用户直接命名功能，不是标题生成 fallback。TestLLMServer 默认 `E2E Title` 仅为 test-only 兼容行为。

实际新增 alternate success path 为 **0**，replacement path 为 **0**，diagnostic side-path 占比为 **0%**。

## Code quality and Chinese-comment verdict

独立按实际 diff 重算：

```text
12 个 handwritten tracked 文件新增行：755
排除空行：28
排除 import-only：21
排除 comment-only：97
排除纯格式化行：9

E = 755 - 28 - 21 - 97 - 9 = 600
生产 E = 128
测试/fixture E = 472

合格中文解释注释 C = 97
其中生产 26，测试/fixture 71

C / E = 97 / 600 = 16.17%
15% 目标所需 C = 90
10% 阻断底线所需 C = 60
```

另行排除了 **93 行 generated additions**、generated 类型移动及 untracked 计划文档。9 行格式化排除项来自 TestLLMServer 的 SSE 对象展开和 DialogPrompt 测试的 JSX 展开。注释分布在对应 guard、压缩边界、错误转换、双目录、fixture 隔离、keymap 和 Dialog 生命周期附近，满足 **15% 实施目标**。

未发现新增 `any`、unchecked cast、non-null assertion、错误吞没、权限削弱、无关格式化或被淘汰 workaround。

## Release verdict

**APPROVE**

仅批准当前 **R6** 与本轮指定的实际 diff：14 个 tracked 文件、848 additions / 41 deletions，以及当前 untracked canonical plan。

第 1 轮 B-01 已由同一最终工作树上的 Linux 全量 HttpApi 通过记录消除。当前实现可进入 `verified` 记录及用户已授权的 commit 步骤。本审计未修改文件，未创建 commit，未 push。

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision. 只有 verified 后才按用户授权创建本 GOAL commit；不得 push。
