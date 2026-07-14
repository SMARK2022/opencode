# Session GOAL Transition Integrity

> Status: verified
>
> Revision: R12
>
> Approved revision: R12
>
> Audit mode: full-scope
>
> Requirement source: user messages `msg_f5c449851001TXbe9qMsOj9Tyd`, `msg_f5ef2b88f001TdtPW3pxfHtlGe`, `msg_f5f2f4e8c001loArXqzEeWgOEz`, `msg_f5ff725020018CBhyeqUcb0aci`, `msg_f607d9ee6001C1H9Ku2r1LPM72`, `msg_f6084b4d3001vvhOWCpgrbJIwR`, `msg_f60854e23001b2q4RPh3di0pgp`
>
> Implementation allowed: yes
>
> Last updated: 2026-07-15

本文件是本任务唯一实现规范。聊天摘要、R1 的审计前假设和本文件外的 builder rationale 均无实现授权力。

## 0. Verbatim Requirement

> 请你请你详细完整检查一下我们的 GOAL相应的实现机制,因为我目前发现有很多bug,或者很多有缺陷的地方。譬如说当前模型可以不看相应的GOAL的具体内容,就直接把GOAL进行block或者complete了。模型并不知道这是什么含义,可能就直接工具进行了其block了。这在ChatGPT中非常常见且经常发生。与此同时,理论上来说,block和complete应该要相应的理由,也就是模型需要说它为什么这样选择或者有这样的抉择。再者,请你完整检查一下,当前貌似模型没有办法将block的GOAL改成相应的执行中,也就是它没有办法把这个block的或者说已经完成的长期目标进行相应的状态修改,让其返回正在进行中的状态。同时,譬如说用户可能进行了相应的GOAL的修改,那么模型可能不知道,它以为GOAL的相应内容还是原来那个,所以它在执行完之后,它就直接执行finish了,或者complete了。但是模型并不知道这个相应的目标其实已经进行更改了。所以理论上来说,请你完整详细地检查一下这些内容到底应该去怎么抉择,以及如何确定。你可以详细完整调研一下相应的codex的具体设计,以及在open code的其他有效的比较高级的PR分支,或者说一些commit里面到底都是怎么样进行执行的。请你详细完整全量检查。

> 只调研，不改代码，输出完整方案。

> 请注意codex在.temp中，不要使用chatgpt。

> `status` 这个 schema 改个名可以，因为可能 gpt 会以为这个是要查看相应的筛选状态后的 goal 而非进行 set，所以 `status` 应该改成一个动词让模型知道这个是在设置而非筛选。

> 这个机制可能需要调整一下，这个貌似模型会每次给的文本不是 100% 一致，且你也没有提示说要保持一致，同时三次可能太多了，最好两次，然后调用返回给一定的提示，说让其再次尝试探索，然后如果真的确定自己无法根据已有信息决策则再次确认。

> 要 reason 匹配，但是需要提示。

> 需要提示让其再次尝试探索，然后如果真的确定自己无法根据已有信息决策，则使用同样 reason strings。

> 这个提示信息有些不太对，理论上应该是一整句话而不是一个短语。

R12 contract：行为 owner 和文件范围保持收敛。Tool 写参数名使用动词 `mark`；blocked 改为两个连续 eligible Goal turns，两个 attempt 必须使用 trim 后完全相同的 reason。第一次调用只记录 pending，并明确要求重读相关文件、改用不同搜索方式、把问题拆成更小的可验证步骤、检查遗漏的依赖或约束；模型完成这些探索后若仍基于现有信息无法推进，下一 Goal turn 使用 trim 后完全相同的 reason 再次调用，第二次才终态化。模型 `complete|blocked` 只能把 `active` Goal 终态化，不得重新标记 paused 或已经 terminal 的 Goal、更不得把 user-produced terminal 洗成 model-produced provenance。所有模型可见 transition 拒绝信息使用完整句子说明原因和下一步。Compaction/technical Messages 不产生或重排 Goal turn，active HTTP mutation 只在已有 user Message 时启动现有 loop，objective generation 在跨 daemon 并发下仍唯一递增。

完整规划、方案审计、TDD/注释/implementation audit 和 commit 流程以 `msg_f5ef2b88f001TdtPW3pxfHtlGe` 的逐字消息为稳定 requirement source。R2 已完成并提交；R12 保持既有 primary path，只校准真实 public HTTP test seam、effective-diff/comment budget、用户指定的 blocked 首轮指导和 terminal ownership guard。在 exact revision 获得独立 full-scope plan approval 前不得继续修改候选实现。用户已明确要求继续实施并将方案审计计数器归零；R8 起使用新的审计循环。

### Explicit non-goals

- 不新增 evaluator、第二模型、动态 stop-condition、Goal history 表、通用工作流状态机或新配置项。
- 不新增 `in_progress`；现有 `active` 继续表示可执行状态。
- 不承诺 objective edit/clear 后立即取消已进入 provider 的请求；只保证旧请求不能写终态或把 usage 归到新 objective generation。
- 不改变 permission、agent max steps、`goal_max_turns`、continue-on-error、abort、compaction 或 request-usage 的既有产品语义，除非为了本方案明确列出的 generation/turn 不变量。
- 不为外部 user-user 并发新增 optimistic concurrency contract；HTTP/TUI 用户 mutation 保持当前 last-write-wins，generation 只保护模型 stale write 和 usage attribution。

## 1. Scope and Decision

本方案只处理当前 GOAL 生命周期中已经被代码和行为测试确认的完整性缺口：

- 模型可以不读取当前 GOAL，直接写入 `complete` 或 `blocked`。
- `complete` 和 `blocked` 没有持久化、可审计的理由约束。
- `blocked`/`complete` 没有受控的模型恢复到 `active` 的路径。
- 用户编辑 objective 后，旧模型 turn 仍可能依据旧快照写入终态。
- Goal continuation、usage 归属和 HTTP/TUI Resume 没有共享同一份状态代际。

本方案不引入第二个模型、evaluator、动态 stop-condition、Goal history 表、通用工作流状态机或新的配置项。`active | paused | complete | blocked` 保持现有公开状态集合；`active` 继续表示可以被 session loop 执行。

推荐方案是把不变量收敛到三个现有 owning boundary：

1. `SessionGoal` 负责持久化 generation、理由、blocked audit 和跨请求原子转换。
2. `GoalTool` 负责模型 turn 内的真实 read-before-write 和模型可写状态边界。
3. `SessionPrompt` 负责每个 Goal turn 的权威上下文、stale continuation 保护、resume loop 和 usage 归属。

HTTP、TUI、OpenAPI/SDK 只传播用户控制和持久化结果，不复制 Goal 业务规则。

### 1A. R12 surgical delta

R12 以已提交的 R2 commit `28e9edf9b` 为基线，保持其 read gate、reason persistence、model terminal recovery、usage attribution、migration 和公开 API contract。审计以当前源码证明 generation transaction、eligible-turn derivation、late technical ordering、empty-session resume 与 terminal ownership 尚未满足不变量，因此 R12 在对应 owner 上完成遗漏实现；若下文历史 R2/R9 调研或预算描述与本节冲突，以 R12 明确列出的 delta 为准。R12 把 R9 无法注入的 HTTP mock seam改为公开 SSE seam，把真实集成测试和并发 harness 纳入预算，把用户已明确要求的四项首轮 blocked 探索动作锁定到所有模型可见 contract 和测试，并在既有 `SessionGoal.modelTransition` 原子路径增加 active-source terminal guard；不新增另一条 transition、provenance 字段或 fallback。

| R12 requirement/invariant | Authoritative path | Planned file | Behavior proof |
|---|---|---|---|
| mutation 参数表达写动作 | provider tool schema -> `GoalTool.execute` | `src/tool/goal.ts`、`src/tool/goal.txt` | schema 只暴露 `mark`；无参数仍为 get |
| 两轮且同 reason 的 blocked audit | `GoalTool -> SessionGoal.modelTransition` | `src/session/goal.ts` | turn 1 pending；turn 2 相同 trimmed reason terminal；reason 改变、跳 turn 重置；同 turn 相同 reason 幂等，同 turn 改 reason 替换 pending baseline 为 attempt 1 |
| 首轮返回可执行探索提示 | `blocked-pending -> GoalTool.output` | `src/tool/goal.ts`、`src/tool/goal.txt` | output 明确要求重读相关文件、改用不同搜索方式、拆成更小可验证步骤、检查遗漏依赖/约束；仍无法推进时下一 eligible Goal turn 使用同一 trimmed reason |
| continuation contract 与 runtime 一致 | `SessionPrompt -> SessionGoal.continuationPrompt` | `src/session/goal.ts` | prompt 使用 `mark`、two turns 和 same reason，不再出现旧 `status`/three-turn 指令 |
| transition 拒绝可恢复 | `GoalTool` read gate；`modelTransition -> GoalError -> Tool` | `src/tool/goal.ts`、`src/session/goal.ts` | 每个可达 model-facing rejection 用完整句子说明拒绝原因和下一步；真实 Tool seam 断言 cause/action |
| user terminal provenance 不可洗白 | `GoalTool -> SessionGoal.modelTransition` | `src/session/goal.ts`、`test/tool/goal.test.ts` | `complete|blocked` 仅接受 active source；user terminal 后模型 terminal re-mark 失败且后续 active recovery仍失败 |
| technical Message 不改变或重排 Goal turn | raw canonical-source Messages -> `SessionPrompt` GoalTurnContext | `src/session/prompt.ts`、`src/session/compaction.ts` | compaction marker 持久化 lineage；technical wrapper 仅引用 source；current/previous 按 canonical source persisted `(time.created, id)` 取最后两个 distinct turns |
| active HTTP resume 不启动空会话 | HTTP Goal set -> has-user gate -> existing `SessionPrompt.loop` | `src/server/routes/instance/httpapi/handlers/session.ts` | empty session 只持久化 active Goal；non-empty 调用唯一 loop；fork failure 使用现有 log + `Session.Event.Error` |
| concurrent objective edits 不复用 generation | HTTP/TUI -> `SessionGoal.set` immediate transaction | `src/session/goal.ts` | authoritative row read、effective objective compare、generation increment、update/read-back 在同一 transaction；跨 daemon 最终 generation 不丢增量，旧 B snapshot 不能终态化 C |

R12 不改变表结构、migration、HTTP payload、OpenAPI、SDK、TUI、Goal turn identity contract、usage accounting 或 recovery ownership；只修复 generation transaction、turn contract 和 model terminal source-state guard。`goal.sql.ts` 只同步两轮阈值的开发者注释。因此不生成 migration 或 SDK，也不扩张 public API。

R12 TDD seam 固定为既有 public behavior：

1. `test/session/goal.test.ts` 断言两轮相同 reason 成功、同 turn 相同 reason 幂等、同 turn 改 reason 替换 pending baseline、跳 turn 重置、跨 turn 改 reason 重置为 attempt 1。
2. `test/tool/goal.test.ts` 断言第一次返回 `attempt 1 of 2`，并逐项断言重读相关文件、不同搜索方式、拆成更小可验证步骤、检查遗漏依赖/约束；还必须断言下一 eligible Goal turn 复用同一 trimmed reason，第二个连续 turn 才 blocked。另通过 Tool seam 复现同 turn 改 reason 后下一 turn 只有新 reason 可终态化。
3. `test/session/goal.test.ts` 的 `continuationPrompt` 行为断言模型看到 `mark`、two turns、same reason，并且不再看到旧 three-turn contract。
4. `test/tool/goal.test.ts` 通过仓库既有 `Effect.exit` + `Cause.squash` 检查 no-read、stale/reason 和 recovery 的真实 Tool defect：断言消息是完整句子，同时包含具体 cause 与可执行 next step；不为类型系统已排除的非法 `mark` 构造测试后门。
4a. 同一 Tool seam 先由 user `set` 产生 `terminal_turn_id=null` 的 terminal Goal，再由模型 get 后分别尝试 `mark=complete` 与 `mark=blocked`；两者必须在第一次调用即失败、不写 pending/provenance。后续新真实 user turn 的 `mark=active` 仍因 user ownership失败。断言 rejection 说明 terminal mark 只允许 active source，以及 paused/user-terminal 等待用户恢复、model-terminal 等待下一真实用户 turn的合法动作。
5. `test/session/compaction.test.ts` 断言 compaction marker 继承创建前最新 canonical user 的 `goalTurnID ?? id`；`test/session/prompt.test.ts` 通过真实 provider/Tool seam 证明 compacted/reordered provider window 和旧无-lineage compaction marker都不会伪造 previous eligible turn。另固定 `B(real) -> C(new real) -> S(technical, goalTurnID=B)`：current 必须保持 C、previous=B；C 使用合法但 lexical 小于 B 的 caller-supplied `messageID` 时结果不变；C 未提出 blocked 时后续 continuation 不能沿用 B 的 pending baseline，且 B 的 read snapshot 不能在 C 上复用。
6. `test/session/prompt.test.ts` 增加 producer-to-consumer recovery authorization：先产生 `terminal_turn_id=A` 的 model terminal；actual Goal continuation C 通过真实 GoalTool 尝试 `mark=active` 必须因 `userInitiated=false` 失败；继承 A 的 technical Message 不能创建新授权 turn；后续真实 user B 经相同 Prompt/Tool path 才恢复成功。该测试不直接构造 `GoalTurnContext`。
7. `src/tool/goal.ts` 按其他 Tool 的既有 module shape 导出唯一 `Parameters` schema；`test/tool/parameters.test.ts` 使用 provider serialization 所用的 `ToolJsonSchema.fromSchema` 检查 Goal 参数 properties：必须包含 `mark`/`reason` 且不包含 `status`，并断言 `mark` description 明确说明两个连续 eligible Goal turns 和同一 trimmed reason。该 internal schema export 不改变 provider/API surface，也不向 production 添加非法参数 fallback。
8. HTTP Goal 测试使用真实 Session/Goal/HTTP handler 和公开 Event SSE：empty session 的 active mutation不能发布 busy；已有 user Message 时必须发布 busy，loop defect 必须发布既有 `session.error`。`Server.Default()` 自行组装 handler layer，当前公开 test surface 不能替换其中的 `SessionPrompt.Service`；因此不新增 injection seam，也不通过源码结构或调用次数断言 owner boundary。
9. `test/session/goal.test.ts` 增加真实多连接数据库并发 harness：一个独立 Bun SQLite connection/worker 持有 write lock 并提交 objective C，另一条生产 `SessionGoal.set` 路径竞争 objective B；旧 read-outside-transaction 路径复用 generation，新 immediate transaction 必须在取得锁后读取 C 并写入下一 generation。测试随后用 B snapshot 对 C/model transition 证明 stale write 失败，不以源码结构为断言。
10. 从上述窄测试扩展到 Goal domain/Tool/compaction/migration/HTTP 回归、prompt goal tests、tool parameter contract 和 package-local `bun typecheck`。R2 三轮测试、非原子 generation、同 turn 改 reason 的旧幂等分支、旧 continuation 文案、caller-ID/late compaction marker、terminal provenance laundering、错误 recovery actor 和 empty-session loop 构成 red-capable baseline；R12 断言必须在 R2 baseline 上失败。

模型可见 rejection 只包含以下可达 owner，不扩张到 user HTTP `set` validation 或类型系统已经排除的非法 `mark`：

| Owner | Reachable rejection class | Required next action | Behavior proof |
|---|---|---|---|
| `GoalTool` | mutation 前未 get/read | 先以无参数调用当前 Goal，再重试 transition | Tool error cause/action assertion |
| `SessionGoal.modelTransition` | Goal 被 clear/recreate、objective/status 已变导致 snapshot stale | 重新 get current Goal，再基于新 snapshot 决策 | Tool/domain stale assertions |
| `SessionGoal.modelTransition` | complete/blocked reason 空白或超过上限 | 提供非空 reason 或缩短后重试 | Tool/domain reason assertions |
| `SessionGoal.modelTransition` | 对 paused 或 terminal Goal 再次 complete/blocked | terminal mark 只允许 active Goal；paused/user-owned terminal 等用户恢复，model-owned terminal 仅在后续真实用户 turn按 active recovery合同恢复 | Tool provenance assertions |
| `SessionGoal.modelTransition` | paused、already-active、user-produced terminal、same terminal turn、continuation turn recovery | 继续工作、等待新真实用户 turn，或等待用户恢复其拥有的状态 | Tool recovery assertions |

`GoalTool` 缺少内部 `goalSvc` 属于 wiring defect，不是模型输入；`Schema.Literals` 和 typed `ModelTransitionInput` 排除非法 `mark/status`。它们保持失败但不为满足模型文案 contract 新增运行时 fallback 或测试后门。

R12 预计修改 7 个 production/contract 文件、6 个测试文件和本 plan，不新增 production module、schema 或 migration。真实 public Prompt/SSE integration、独立 SQLite lock harness 和 provenance test 证明 R9 的 `E=145~250` 低估装配成本；R12 排除 imports、blank/format-only、纯移动和中文注释后，最终有效代码预算 `E=600~730`。合格中文解释性注释计划 `C=110~125`，确保最坏 `E=730` 时仍满足 `C >= ceil(E*0.15)=110`；分布在 atomic generation、same-turn exact-reason 重置、terminal active-source guard、persisted canonical ordering、compaction lineage、recovery actor、provider schema、empty-session gate、fork failure observability、prompt contract、拒绝恢复动作、public SSE 同步和测试意图附近。

## 2. Requirements

| ID | 必须满足的行为 | 证据/验证 |
|---|---|---|
| REQ-01 | 模型只能在当前 Goal turn 已成功读取当前 Goal 后写入模型状态；无 Goal 或未读取时写入失败且不产生写入。 | `GoalTool` 行为测试；现有红色 harness |
| REQ-02 | 每个新产生的 `complete`、`blocked` 必须带非空、trim 后不超过 6400 字符的 reason；当前 terminal reason 进入持久化 Goal、event 和 API/SDK。 | Tool、domain、HTTP、migration 测试 |
| REQ-03 | 模型可把自己产生的 `blocked` 或 `complete` 恢复到 `active`，但只能在后续新的真实用户 Goal turn、先读取当前 Goal 后执行；模型不能恢复 `paused` 或用户直接写入的 terminal 状态，也不能通过重新 complete/blocked 改写 user terminal provenance。 | prompt/Tool provenance 行为测试 |
| REQ-04 | objective 变更后，旧 turn 的终态写入必须因 Goal ID/generation 不匹配而失败；status 竞态通过 expected status/turn 校验失败，不能覆盖新目标或用户暂停。 | 并发/transaction 测试 |
| REQ-05 | 每个 Goal turn 使用权威 objective/status/generation；continuation、compaction、错误和退出路径不能继续执行旧代际。 | prompt 集成测试 |
| REQ-06 | provider 请求已开始后发生 edit/clear，不要求立即取消 provider；旧请求 usage 只有在 `{goalID, generation}` 仍一致时才能计入，terminal/status 变化不应丢失已开始请求的 usage。 | 时序/usage 测试 |
| REQ-07 | HTTP/TUI create/edit/resume 成功后，只要返回 Goal 为 `active` 且 session 已有 user message，就进入现有 `SessionPrompt.loop`；busy session 由 `RunState` 去重，空 session 等首条 prompt。 | HTTP/TUI/run-state 测试 |
| REQ-08 | 当前 continue-on-error、`goal_max_turns`、permission、abort、compaction 和旧 HTTP contract 的既有安全边界继续有效。 | 回归测试和边界矩阵 |
| REQ-09 | 公开字段变更同步 OpenAPI、生成 SDK、TUI 类型和事件；不手改生成文件。 | SDK build/typecheck |
| REQ-10 | 现有 HTTP/TUI user mutation 保持无 expected revision 的 last-write-wins；每个有效 objective edit 原子递增 generation，使旧模型快照失效，不宣称提供 user-user conflict。 | HTTP 兼容和并发模型测试 |
| REQ-11 | Tool mutation 参数名固定为 `mark`。blocked 只在两个连续 eligible Goal turns 使用完全相同的 trimmed reason 时成功：attempt 1 保持 active，并逐项提示重读相关文件、使用不同搜索方式、拆成更小可验证步骤、检查遗漏依赖/约束；attempt 2 才 blocked；同 turn 改 reason 必须替换 pending baseline。模型可见 schema/description、Tool output、continuation prompt、runtime 和 rejection prose 必须一致。 | provider schema、Tool/domain/prompt 行为测试和真实 Tool error assertions |

## 3. Repository and Process Constraints

- 当前仓库生产路径以 `packages/opencode/src/session` 为准；`CONTEXT.md` 标明 v1 是当前有效路径，v2 仍在进行中。
- 测试必须从 `packages/opencode` 等 package 目录运行，不能从仓库根目录运行。
- 任何 implementation 前必须先以本方案获得独立 full-scope audit 的 `approved` revision；当前文件明确禁止实施。
- 未来实现须先写行为级测试，再确认当前实现能暴露缺口，再实现生产代码。
- 未来 git diff 中新增/修改的有效代码行至少 15% 对应清晰中文解释性注释；注释解释不变量、竞态、兼容或安全原因，不复述表面代码。
- 不覆盖工作树中预先存在的 `.gitignore`、`.opencode/*`、`docs/Proposal/stats-foreground-theme-repair-plan.md`、`docs/prompts.md`、`thirdparty/chatgpt-browser-agent` 修改。
- 本次调研只使用仓库 `.temp/codex` 的本地 Codex 源码和 `gh` 只读查询；不使用 ChatGPT 证据。

## 4. Evidence Read Before Planning

### OpenCode production and tests

| 文件 | 关联职责 |
|---|---|
| `packages/opencode/src/session/goal.ts` | Goal service、CRUD、状态写入、usage、continuation prompt |
| `packages/opencode/src/session/goal.sql.ts` | `session_goal` 表和现有状态/字段 |
| `packages/opencode/src/tool/goal.ts` | 模型可见 Goal read/write tool |
| `packages/opencode/src/tool/goal.txt` | 当前 prompt-only completion/blocked 规则 |
| `packages/opencode/src/tool/registry.ts` | GoalTool 注册、service layer 注入 |
| `packages/opencode/src/tool/selection.ts` | permission/tool 可见性过滤 |
| `packages/opencode/src/session/prompt.ts` | run loop、Goal continuation、provider dispatch、usage、abort |
| `packages/opencode/src/session/processor.ts` | provider stream、tool settle、retry、stop、error、abort |
| `packages/opencode/src/session/run-state.ts` | busy/idle、ensureRunning、cancel、运行互斥 |
| `packages/opencode/src/session/request-usage.ts` | request/assistant usage 聚合和错误边界 |
| `packages/opencode/src/session/compaction.ts` | compaction、summary、synthetic continuation |
| `packages/opencode/src/session/message-v2.ts` | 消息类型、metadata、parts、latest/compacted 读取 |
| `packages/opencode/src/session/request-usage.sql.ts` | request/root request 持久化；确认它不能替代 Goal turn identity |
| `packages/opencode/src/session/schema.ts` | Session/Prompt 输入 schema |
| `packages/opencode/src/session/session.sql.ts` | session 状态和消息关联 |
| `packages/opencode/src/session/request-usage.sql.ts` | request usage 持久化结构 |
| `packages/opencode/src/session/todo.ts` | 同 session 内另一种模型任务状态边界，用于避免复制其抽象 |
| `packages/opencode/src/storage/db.ts` | SQLite transaction、migration、事务行为 |
| `packages/opencode/src/storage/db.bun.ts` | Bun 数据库实现入口 |
| `packages/opencode/src/tool/truncate.ts` | Tool wrapper 的输出截断依赖 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | Goal HTTP handler、service layer、错误转换 |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | Goal endpoint、OpenAPI payload/response |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | HTTP layer 注入 SessionPrompt/SessionGoal |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | HTTP API 共享 contract |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | TUI create/edit/pause/resume/clear |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | TUI Goal store、SSE/POST reconcile |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/goal.tsx` | Goal 状态/usage 展示 |
| `packages/opencode/src/config/config.ts` | `goal_max_turns` 和配置边界 |
| `packages/opencode/migration/20260704053848_session_goal/migration.sql` | 原始 Goal schema |
| `packages/opencode/migration/20260710195446_goal_continue_on_error/migration.sql` | `continue_on_error` 历史 migration |
| `packages/opencode/test/session/goal.test.ts` | Goal CRUD、resume、continueOnError |
| `packages/opencode/test/server/httpapi-goal.test.ts` | Goal HTTP 行为 contract |
| `packages/opencode/test/storage/goal-migration.test.ts` | 旧 schema/default/migration 兼容 |
| `packages/opencode/test/session/prompt.test.ts` | continuation、terminal error、usage、prompt 时序 |
| `packages/opencode/test/lib/effect.ts` | readiness/poll 测试辅助，避免固定 sleep |

### Contract and generation

| 文件 | 关联职责 |
|---|---|
| `packages/sdk/openapi.json` | 当前生成输入 contract；现有 HTTP Goal 描述未完整同步到 SDK v2 |
| `packages/sdk/js/script/build.ts` | SDK 生成链，未来不能手改 generated output |
| `script/generate.ts` | 生成 committed `packages/sdk/openapi.json` 并调用 SDK build 的仓库入口 |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 当前生成 client；无完整 Goal method |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | 当前生成 types；无完整 Goal schema |
| `packages/sdk/js/src/v2/gen/client.gen.ts` | 生成 client 基础实现 |
| `packages/sdk/js/src/v2/gen/client/types.gen.ts` | 生成 client types |
| `packages/sdk/js/src/v2/gen/core/*.gen.ts` | 生成基础序列化/SSE/auth/query 支撑 |

### Existing design and repository constraints

| 文件 | 关联职责 |
|---|---|
| `CONTEXT.md` | 当前 v1/v2 边界和领域上下文 |
| `AGENTS.md` | 测试、类型检查、SDK 生成和工作树约束 |
| `packages/opencode/AGENTS.md` | Drizzle migration 命令和 `migration.sql` + `snapshot.json` 产物约束 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | HttpApi handler、公开错误和 stable service 注入约束 |
| `package.json`, `packages/opencode/package.json` | root 禁止测试、package-local test/typecheck/db scripts |
| `docs/adr/README.md` | ADR/领域文档布局约定 |
| `docs/goal-error-continuation-control-plan.md` | 既有 continue-on-error、race、usage 和上限设计 |
| `docs/prompts.md` | 本次 workflow 的调研、审计、TDD 和 commit 要求；文件有预存修改，未覆盖 |
| `.opencode/policy/first-principles-engineering.md` | canonical plan 和审计门槛 |
| `.opencode/templates/canonical-plan.md` | plan 必须包含的结构和 traceability 要求 |
| `.opencode/skills/first-principles-planning/SKILL.md` | first-principles 调研和方案流程 |
| `.opencode/skills/adversarial-audit/SKILL.md` | 独立 full-scope plan/diff audit 规则 |
| `.opencode/skills/tdd/SKILL.md` | 未来 implementation 的 TDD 约束 |

## 5. External First-Party Evidence

### Local Codex source

本地 Codex 仓库为 `.temp/codex`，当前 HEAD 为 `0d1733b5e9ea027a0ff9d75cc3e11103f045f1ce`，工作树干净。已读取：

- `codex-rs/ext/goal/src/tool.rs`、`api.rs`、`runtime.rs`、`spec.rs`、`steering.rs`、`accounting.rs`、`extension.rs`。
- `codex-rs/state/src/model/thread_goal.rs`、`state/src/runtime/goals.rs`。
- `codex-rs/app-server/src/request_processors/thread_goal_processor.rs`。
- `codex-rs/tui/src/app/thread_goal_actions.rs`、`tui/src/chatwidget/goal_menu.rs`。
- `codex-rs/state/migrations/0029_thread_goals.sql`、`0033_thread_goal_stopped_statuses.sql`。
- `codex-rs/ext/goal/tests/goal_extension_backend.rs`。

可借鉴但不直接移植的事实：

- `GoalUpdate.expected_goal_id` 用于防止 Goal 被替换后旧 request 错误更新/计账；本方案借鉴 expected identity，但增加 objective generation 和 status/turn guard，不能直接复制。
- objective 外部修改会通过 steering/运行时事件告知正在运行的 turn；本方案只借鉴“下一次 provider dispatch 使用新 snapshot”，不承诺中途取消 provider。
- usage accounting 与终态状态更新分离；本方案把 request 开始时的 expected `{goalID,generation}` 传到最终计账，避免先 complete/blocked 后丢 usage，也避免 edit 后污染新 objective。
- idle gate 接受用户提交；本方案用同一原则补齐 HTTP/TUI active resume 的 idle loop 触发。
- Codex 当前 model tool schema 仍主要是 status 更新，不能证明 read-before-write、reason 或 revision 约束已经存在，因此不能把它当作本需求的完整解决方案。

已核对的本地 Codex 相关提交：

- `1e65b3e0af32cc6b29bd7bb2e326f50c4d212e93`：Goal edit 和 objective 更新路径。
- `c4fe2bdf11e9d21d7eab043683b8f495bb7b0bfe`：durable external thread goals。
- `c62d79259d0ccd83ad515d3444840e0e0e18059a`：terminal turn error 后 block active Goal。
- `b6841f6adb591120722e80f5f66b334f462a6505`：idle gate 接受用户提交。
- `542585959ce9ab66c509be7111a1627fceb97bb1`：Goal continuation permission context。

### OpenCode upstream PR evidence

| PR | 状态/结论 | 本方案的取舍 |
|---|---|---|
| [#27163](https://github.com/anomalyco/opencode/pull/27163) | OPEN；native per-session Goal、持久化、continuation、SDK/TUI；模型写入仍偏终态，不提供本需求的 read/CAS/reason 不变量 | 借鉴 ownership，不直接 cherry-pick |
| [#32743](https://github.com/anomalyco/opencode/pull/32743) | OPEN；`/goal`、active/paused/completed、model update/complete/pause/resume、auto continuation；仍未证明旧 turn revision 和真实 read gate | 借鉴公开 contract 方向，拒绝直接扩大为另一套状态实现 |
| [#31770](https://github.com/anomalyco/opencode/pull/31770) | CLOSED；evaluator-based auto continuation、fail-open、`MAX_GOAL_REACT` | 不采用第二模型/evaluator；fail-open 与本需求的安全不变量冲突 |
| [#33944](https://github.com/anomalyco/opencode/pull/33944) | CLOSED；evaluator stop-condition，主要是 judge/service seam | 不采用 evaluator；本次只修复当前 Goal state ownership |

## 6. Current Behavior and Call Chain

### Model write path

1. `SessionPrompt.runLoop` 在 `packages/opencode/src/session/prompt.ts` 中组装工具。
2. `packages/opencode/src/tool/registry.ts` 注册 `GoalTool`，注入 `SessionGoal.defaultLayer`。
3. `packages/opencode/src/tool/goal.ts` 的 schema 将 `status` 作为可选字段；模型可以直接传 `complete`/`blocked`。
4. `GoalTool` 当前对 `status` 做最小判断后直接调用 `goalSvc.set(ctx.sessionID, { status })`。
5. `SessionGoal.set()` 在数据库写入并发布 Goal event；没有检查本 turn 是否调用过 get，没有 expected id/revision，没有 reason。

已用真实 GoalTool 路径复现：

```text
bun -e '... GoalTool ... def.execute({ status: "complete" }, ctx) ...'
=> {"calls":{"get":0,"set":1},"result":"Failure"}
```

`result: Failure` 是 harness 的 output wrapper 失败，不影响关键事实：`get=0`、`set=1`。现有行为因此满足“模型无需阅读 Goal 即可触发终态写入”的红色证据。

### User edit/resume path

1. HTTP `POST /session/{sessionID}/goal` 在 `handlers/session.ts` 调用 `goalSvc.set`。
2. TUI `dialog-goal.tsx` Edit/Resume 通过 raw fetch 发送 objective/status。
3. TUI sync 通过 SSE/POST response 更新本地 Goal store。
4. 当前 handler 只写 DB，不会在 idle session 上自动 fork `SessionPrompt.loop`；因此 `complete/blocked -> active` 可能只改变状态，不恢复执行。

### Continuation and usage path

1. `SessionPrompt.runLoop` 读取 Goal continuation 条件并在正常完成后注入下一轮。
2. continuation 与 Goal 状态没有共同 revision；用户 Edit/Clear 后旧 loop 仍可能继续。
3. 当前 `accountUsage()` 主要要求当前 row status 为 `active`。模型先写终态后，当前已完成 request 可能不计账。
4. clear/recreate 后若只按 session ID 计账，旧 request 可能污染新 Goal；当前没有 expected Goal ID 保护。

## 6A. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Class |
|---|---|---|---|---|---|
| Goal Tool read with current Goal | model tool call | Tool registry/permission admits GoalTool；session ID trusted from context | `resolveTools -> GoalTool -> SessionGoal.get` | GoalTool | observed |
| Goal Tool terminal write without prior read | model tool call | 当前 schema 允许直接 status | `GoalTool -> SessionGoal.set` | GoalTool/model transition seam | observed |
| Goal Tool write after objective edit | provider 与 HTTP/TUI 并发 | Goal ID 保留，当前无 generation | old Tool context -> current row | SessionGoal transaction | reachable |
| complete/blocked with blank or oversized reason | model or public Goal POST | 当前没有 reason 字段/校验 | Tool/HTTP -> domain | SessionGoal validation | reachable |
| blocked attempts across provider steps in one user message | one model request and tool-result loops | assistant message ID 每 step 改变；latest user ID 保持 | `runLoop` while iterations | SessionPrompt GoalTurn derivation | observed |
| blocked attempts across real user and Goal continuation messages | user prompt + `system_continue` | 每条 user message 有稳定 MessageID；Goal continuation 可加内部 part marker | raw persisted message history -> GoalTurn | SessionPrompt | reachable |
| compaction replay/continue、task summary technical user | compaction/task pipeline | replay 可复制 non-synthetic parts；当前没有 durable Goal-turn lineage | runLoop latest user changes | MessageV2 lineage + SessionPrompt | observed |
| model terminal -> later real user asks to resume | GoalTool then new public prompt | new real user message ID，不是 synthetic continuation | prompt loop -> GoalTool active | GoalTool + SessionGoal | reachable |
| model attempts to resume same turn or paused Goal | model Tool | Tool context knows current/previous eligible turn and source kind | GoalTool -> modelTransition | SessionGoal | reachable |
| user POST create/edit/pause/resume/terminal | public HTTP/TUI/SDK | payload schema validates types；无 user expected revision contract | handler -> SessionGoal.set | SessionGoal user mutation | observed |
| active Goal POST on empty session | public HTTP | session 可存在但没有 user message | handler -> optional loop | HTTP integration seam | reachable |
| provider starts active then Goal terminal/pause | model/user mutation during request | Goal ID/generation unchanged unless objective edit | dispatch snapshot -> accountUsage | SessionPrompt + SessionGoal | reachable |
| provider starts active then objective edit | HTTP/TUI during request | Goal ID 保留，generation 将递增 | old request -> accountUsage | SessionGoal atomic usage update | reachable |
| clear/recreate during provider request | HTTP/TUI during request | recreate 生成新 Goal ID | old request -> accountUsage/transition | SessionGoal | reachable |
| legacy persisted terminal row | migration input | 旧 schema 无 reason/generation/audit | migration -> current Goal GET | migration/SessionGoal | contracted |
| GoalTool denied by permission | session permission | `ToolSelection.enabled` 排除工具 | resolveTools filters GoalTool | ToolSelection | observed |
| evaluator/第二模型 | 无当前 producer | 无 contract | 不可达于当前 primary path | none | speculative/rejected |

## 6B. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test state |
|---|---|---|---|
| INV-01 | 模型状态写入必须基于同一 eligible Goal turn 内由 GoalTool 真实读取形成的 trusted snapshot。 | 当前 red harness `get=0,set=1`；用户明确要求 | 缺失，未来 Tool test 先红 |
| INV-02 | 所有新 terminal transition 必须有 trim 后非空、最多 6400 字符的 reason；public Goal 在 terminal 时 reason 非空。 | 用户明确要求；公开 Tool/HTTP producer | 缺失 |
| INV-03 | blocked 只在两个不同、连续 eligible Goal turns 以完全相同的 trimmed reason 提出时成功；同 turn 相同 reason 幂等，同 turn 改 reason 替换 baseline 为 attempt 1，中断 turn 也从 attempt 1 开始。第一次返回探索提示，第二次相同 reason 才终态化。 | 现有 goal.txt contract + 用户要求 block 有依据 | 仅 prompt 文案，无 runtime test |
| INV-04 | model complete/blocked 只允许 active source；model active recovery 只允许 model-produced terminal Goal 在后续新的真实 user turn、先 read 后执行。same turn、Goal continuation、user-produced terminal、paused 和 terminal re-mark 均拒绝，user ownership 不可被 provenance laundering 改写。 | 用户要求恢复 + 用户暂停/终态 ownership | 缺失 |
| INV-05 | `{goalID, generation, expectedStatus, eligibleTurnID}` 是 model transition 的原子前置条件；objective edit、pause、clear/recreate 后旧 write 无副作用。 | 当前 ID 保留 edit 行为和并发链 | 缺失 |
| INV-06 | eligible Goal turn 的稳定 ID 是 real user message ID 或带 `goal_continuation` metadata 的 synthetic user message ID；assistant/provider steps 不产生新 turn，compaction/task technical user 通过 optional `goalTurnID` 继承原 turn。 | `message-v2.ts`/`prompt.ts`/`compaction.ts` 消息拓扑 | 缺失 |
| INV-07 | provider dispatch 时捕获 active `{goalID, generation}`；结束时只对同一 generation 原子计 usage，status terminal/paused 不丢 usage，edit/clear 不污染新 generation。 | 当前 usage status gate 缺口；审计 B-02 | 缺失 |
| INV-08 | 成功 Goal mutation 返回 active 且已有 user message时复用唯一 `SessionPrompt.loop -> RunState.ensureRunning`；empty session 不启动，busy 不重复。 | 当前 handler 只写 DB；现有 RunState contract | 缺失 |
| INV-09 | generation/reason 通过 Goal event、HTTP、committed OpenAPI、generated SDK 和 TUI 一致传播；内部 audit 字段不公开。 | 公开 GoalResponse 直接使用 domain Goal | 缺失 |
| INV-10 | user HTTP mutation 保持 last-write-wins；有效 objective change 递增 generation，status/budget/policy-only change 不递增。 | 当前公开 contract 无 expected revision；兼容要求 | 现有 last-write-wins，缺 generation test |
| INV-11 | transaction/validation 失败保持失败；不存在 evaluator、current-row fallback、catch-and-success 或第二数据源。 | first-principles policy | 无专门测试，靠路径审计和错误测试 |
| INV-12 | legacy terminal row 获得诚实的“reason unavailable”迁移标记；不能伪造历史阻塞理由。 | persisted-data compatibility | migration test 缺失 |

## 7. First Divergence and Ownership

第一分歧不是 UI、HTTP 或 evaluator，而是 `GoalTool -> SessionGoal.set()`：模型可写动作没有 trusted read snapshot、reason、generation 或 actor boundary。

| Invariant | First divergence | Owning module/interface | Proof |
|---|---|---|---|
| INV-01/02/03/04 | `GoalTool.execute` 接受可选 status 并直接调用通用 `set` | `GoalTool` model seam + `SessionGoal.modelTransition` | `src/tool/goal.ts` 当前无 get gate/reason/actor |
| INV-05/10 | `SessionGoal.set` 保留 Goal ID 更新 objective，未建立 generation | `SessionGoal` transaction | `src/session/goal.ts:128-150` |
| INV-06 | runLoop 每个 assistant step 重建 Tool context，但 Goal turn 实际由 latest user message 组织 | `SessionPrompt` | `prompt.ts:2223-2231, 2344-2388` |
| INV-07 | request 完成后 `accountUsage` 只看 session/current active row | `SessionPrompt` dispatch snapshot + `SessionGoal.accountUsage` | `prompt.ts:2674-2691`, `goal.ts:203-224` |
| INV-08 | Goal POST 只写 DB 并返回 | HTTP integration seam | `handlers/session.ts:461-483` |
| INV-09/12 | Goal schema/migration 无 generation/reason/audit | `SessionGoal` schema + generation chain | `goal.sql.ts:17-36`, Goal migrations |

职责固定如下：

| Concern | Owner | Interface promise | Why here | Not owned by |
|---|---|---|---|---|
| row/generation/reason/audit 原子更新 | `SessionGoal` | 单 transaction 校验并写 current Goal | DB row 是唯一语义源 | prompt/TUI 不能复制 DB 状态机 |
| 模型先 read 和可写状态集合 | `GoalTool` | 只从本 turn context 取 trusted snapshot | Tool 是 model actor seam | 模型参数不能自报 token/generation |
| eligible turn identity、raw history 顺序、dispatch snapshot | `SessionPrompt` | 同 user steps 共享；新 eligible user 才重置 | prompt 拥有消息拓扑和 provider 生命周期 | SessionGoal 不解析 messages |
| active mutation 启动唯一 loop | HTTP handler 调用 `SessionPrompt.loop` | active + 有 user message时 ensure running | handler 已拥有 prompt/run-state integration | Goal domain 不启动 fibers |
| API/SDK/TUI shape | HttpApi schema + generator | generation/reason 一致传播 | 公开 contract owner | generated files 不手改 |

## 8. Exact Persisted and Transition Model

### 8.1 Exact columns and public fields

保留稳定 Goal `id`，新增且只新增以下列：

| DB column | Public Goal field | Lifecycle |
|---|---|---|
| `generation integer not null default 1` | `generation: number` | create=1；只有 trimmed objective 值真正改变时 +1；status/budget/continueOnError/reason/audit 不增加 |
| `reason text null` | `reason: string | null` | 只表示当前 `complete`/`blocked` 的 terminal reason；active/paused 为 null |
| `blocked_reason text null` | 不公开 | active 状态下待确认的 trimmed exact reason |
| `blocked_streak integer not null default 0` | 不公开 | 连续 eligible turns 的 blocked attempt 数 |
| `blocked_last_turn_id text null` | 不公开 | 最近一次有效 attempt 的 eligible user MessageID |
| `terminal_turn_id text null` | 不公开 | model-produced terminal transition 的 eligible user MessageID；user-produced terminal 为 null |

不新增 `revision`、`blocked_last_turn_index`、Goal history 或 JSON audit blob。`generation` 专指 objective generation，使 model stale-write 和 usage attribution 使用同一语义，不会因 terminal status 变化而错误丢 usage。

### 8.2 Reason lifecycle

| Operation | `reason` | blocked audit | `terminal_turn_id` |
|---|---|---|---|
| create active/paused | null | reset | null |
| create complete/blocked by user API | required trimmed reason | reset | null |
| blocked attempt 1 | remains null | save exact trimmed reason/streak/current turn ID | unchanged null |
| model blocked attempt 2 | required reason; status=blocked | reset pending fields | current eligible turn ID |
| model complete | required reason; status=complete | reset pending fields | current eligible turn ID |
| user changes objective, status omitted | null; generation++；active 保持 active，paused 保持 paused，旧 complete/blocked 自动回到 active | reset | null |
| user changes objective with explicit status | terminal 时要求新 reason；active/paused reason=null；generation++ | reset | model terminal ID不继承 |
| user/model resumes active | null | reset | null |
| user pauses | null | reset | null |
| budget/continueOnError-only update | preserve current reason/audit/status | preserve | preserve |
| clear/recreate | row deleted/new row defaults | reset | reset |

`reason` 和 `blocked_reason` 都只做 `trim()`，不 lower-case、不折叠内部空白；连续 blocked 采用 trim 后完全相等，避免把语义不同的理由错误合并。空白拒绝；最大长度复用 `MAX_OBJECTIVE_CHARS=6400`，不新增配置项。

旧 migration 中已经是 `complete`/`blocked` 的 row 统一写入准确兼容标记 `Legacy terminal transition (reason unavailable)`；active/paused reason 为 null。该字符串说明历史理由不可恢复，不伪造判断依据。

### 8.3 Eligible Goal turn

- `MessageV2.User` 增加 optional `goalTurnID: MessageID`，只表示 technical replay/summary 继承哪个既有 Goal turn，不是模型可写 token。普通 real user 和新 Goal continuation 省略它，以自身 ID 开始新 turn。
- real user turn：canonical user message 至少一个 part 不是 synthetic；turn ID 是其 `MessageID`，`userInitiated=true`。
- Goal continuation turn：canonical user 的 synthetic text part 具有内部 metadata `{ goal_continuation: true }`；turn ID 是其 `MessageID`，`userInitiated=false`。
- compaction replay/continue、Task summary 等已确认 technical user producer 写入 `goalTurnID = original.goalTurnID ?? original.id`；它们不产生新 turn。runLoop 以 `lastUser.goalTurnID ?? lastUser.id` 解析 canonical message和 source kind。
- assistant/provider/tool-result steps：latest eligible user ID 不变，复用同一个内存 `GoalTurnContext` 和 read snapshot。
- 其他没有 lineage 的全 synthetic user messages不产生 eligible turn；向 raw history 后退到最近 canonical eligible user。同一 runLoop 沿用 context；进程重启后 raw history/`goalTurnID` 仍可重建 turn ID/previous ID，但内存 read snapshot 丢失，必须重新 read。
- 当前/前一个 eligible turn 从未裁剪的 `MessageV2.stream(sessionID)` 中按持久化消息顺序取得；因此 compaction 不会把中间 turn 隐藏后误判为连续。

R9 把上述 contract 固定为一个 `SessionPrompt` 内部推导步骤：从 raw user Messages 建立 canonical-turn map，而不是把每个 wrapper 依次映射后追加。无 `goalTurnID` 的真实 user 和 `goal_continuation` 分别以自身 MessageID 建立 canonical source（`userInitiated=true/false`）；有 `goalTurnID` 的 technical message 只验证并引用已经存在的 canonical source，不创建新 source、不改变 source 顺序，找不到 source 时 fail-closed 忽略；无 lineage 的 compaction marker和其他全 synthetic technical user 也忽略。current/previous 按 canonical source 自身持久化的 `(time.created, id)` 顺序取最后两个 distinct entries；`id` 只处理同 timestamp tie，不能单独代表 chronology，也不能使用 technical wrapper 的落盘位置或 `filterCompactedEffect` 的 provider window 数组位置。因此即使 C 的 caller-supplied ID lexical 小于 B，`B -> C -> S(goalTurnID=B)` 仍为 current=C、previous=B。`SessionCompaction.create` 在写 marker 前通过 newest-first `Session.findMessage` 取得最近 user，并持久化其 `goalTurnID ?? id`；旧数据库里没有 lineage 的 marker仍由 classifier 忽略。

### 8.4 Model transition rules

- GoalTool `get` 把 current `{goalID, generation, status}` 写入当前内存 GoalTurnContext；这些值不出现在模型 write 参数中。
- write 必须携带当前 context 的 read snapshot；domain 在 immediate transaction 中校验 current row 的 ID/generation/status 以及 supplied eligible turn ID。
- complete/blocked 共同 source guard：current row 与 trusted snapshot 都必须是 `active`；paused 或已 terminal 时立即失败且不写 audit、reason 或 `terminal_turn_id`。这防止模型把 user-produced terminal 重新标记为 model-produced，也避免 terminal row 返回“仍 active”的 pending 语义。
- blocked attempt：通过 active-source guard 后，若 DB `blocked_last_turn_id === currentTurnID` 且 reason 相同，幂等返回当前 pending attempt；若是同 turn但 reason 改变，则把 `blocked_reason` 替换为新 trimmed reason、保持 `blocked_streak=1` 和当前 turn ID，并返回新的 attempt 1。其他 turn 只有 `blocked_last_turn_id === previousEligibleTurnID` 且 reason 相等才 +1，其余从 1 开始。attempt 1 是 primary intermediate result，不改 status，并返回要求继续探索的完整提示；attempt 2 仅在同一 trimmed reason 下原子写 blocked/reason。
- complete：通过 active-source guard、reason 合法且 expected row/status/turn 一致时原子写 complete/reason。
- active recovery：snapshot/current status 必须 complete/blocked，`terminal_turn_id` 非 null，current turn 必须 real user 且 ID 与 terminal turn 不同；因此仅恢复 model-produced terminal。paused、same turn、Goal continuation 或 user-produced terminal 失败。用户仍可通过既有 HTTP/TUI 直接恢复任意 terminal/paused。
- objective edit 重置 audit、generation++；旧 snapshot 失败。用户 pause/terminal 改变 expected status；旧 model write 失败。clear/recreate 由 Goal ID 失败。
- domain 继续使用现有 `GoalError` 传递缺 read、缺 reason、stale、非法状态；不新增错误 hierarchy 或 catch-and-success fallback。blocked pending 是明确中间结果，不是错误或 terminal success。
 
## 9. Recommended Minimal Implementation

### 9.1 `SessionGoal` domain

在现有 service 内扩展，不新建 Goal manager：

1. `set` 保持 user/system mutation 的唯一入口和 last-write-wins contract；纯输入 validation 在 transaction 前完成，随后一个 immediate transaction 内完成 authoritative row read、create/update 分支、effective objective comparison、generation/audit lifecycle、row write 和 read-back。只有相对 transaction 内 current row 的 trimmed objective 真正改变才 generation++；terminal Goal 的 objective-only edit 自动 active，paused edit 保持 paused，显式 status 始终优先且 terminal 要求新 reason。transaction 返回 row/error，`GoalError` 与唯一 `Event.Updated` 在 commit 后发布；不做 stale-row retry 或 conflict response。
2. 新增唯一 model actor 方法 `modelTransition`，输入只来自 GoalTool 的 trusted snapshot/turn context；transaction 重读 row 并按 §8.4 校验。`complete|blocked` 在同一 transaction 内先执行 active-source guard，再进入各自 reason/audit 写入；不调用通用 `set`，也不 fallback 到新 row。
3. `modelTransition` 返回 `updated Goal` 或 `blockedPending { goal, attempt, required: 2 }`；所有拒绝继续使用 `GoalError`。
4. `accountUsage` 改为接收 required expected `{ goalID, generation }`；prompt 仅在 provider dispatch 时 Goal 为 active 才调用。SQL update 的 where 同时包含 session/ID/generation，并使用列原子加法；不再要求结束时仍 active。
5. `clear` 在 transaction 内删除并保持现有 event contract；clear/recreate 的 ID mismatch 自然拒绝旧 transition/usage。
6. bus event 只在 transaction 成功并读回 current Goal 后发布一次；DB busy/defect 原样失败并记录现有日志，不转换为成功。

### 9.2 `GoalTool`

在现有 `GoalToolExtra` 中增加当前 Goal turn 的受信上下文，精确形状为：

```ts
goalTurn: {
  id: string
  previousID?: string
  userInitiated: boolean
  read?: { goalID: string; generation: number; status: GoalStatus }
}
```

该 context 由 `SessionPrompt` 创建并在同一 eligible turn 的 provider steps 间复用；模型 schema 不暴露 id/generation。Tool schema 明确为“无 `mark` 表示 read；有 `mark` 表示 transition”，`complete|blocked` 时 reason 必填，`active` 时忽略 reason；`blocked` description 必须明确两个连续 eligible Goal turns 使用同一 trimmed reason，而不是模糊的“two failed attempts”。Tool 自己只负责 read gate 和 actor status allowlist；blocked continuity/CAS/reason persistence 全部由 domain owner 处理。

Tool 成功输出固定包含 current status、generation、reason；blocked pending 明确输出 `attempt 1/2` 且 Goal 仍 active，并在同一结果中逐项要求重读相关文件、使用不同搜索方式、拆成更小可验证步骤、检查遗漏依赖/约束。完成这些探索后仍无法推进时，结果必须指示下一 eligible Goal turn 使用同一 trimmed reason 再次调用。no Goal、no read、stale、invalid reason/status 均为失败且断言零 terminal 写入。

`goal.txt` 继续保留给模型的目标判断和证据提示，但不再承担安全约束；它必须与 provider schema、blocked-pending output 和 continuation prompt 使用同一 two eligible turns / same trimmed reason / 四项探索动作 contract，不能把“请记住两轮”当作唯一防线。

### 9.3 `SessionPrompt`

在现有 `runLoop` 内保存一个 `GoalTurnContext | undefined`，不建立第二个 loop 或 ambient store：

1. 每次 while iteration 从 raw `MessageV2.stream(sessionID)` 按 §8.3 canonical-source classifier 和 canonical source 自身持久化的 `(time.created, id)` chronology 找到最后两个 distinct eligible turns；provider-oriented `filterCompactedEffect`、technical wrapper persistence order 和 caller-controlled MessageID lexical order 都不参与 Goal turn continuity。
2. 如果 eligible ID 改变，或 current Goal ID/generation 与 context read 不一致，建立新 context 并清空 read；assistant message ID 变化不重置。
3. Goal continuation text 增加 `{ goal_continuation: true }` 并以自身 ID 成为下一 eligible turn；`SessionCompaction.create`、compaction replay/continue 和其他已确认 technical producer 设置 inherited `goalTurnID`，因此不会伪造 blocked 次数；旧无-lineage compaction marker由 classifier 忽略。
4. Tool extra 引用同一个 context 对象；GoalTool get 原地记录 snapshot，后续 provider step 的 write 可使用，但新 eligible turn 必须重新 read。
5. provider dispatch 前获取 Goal；若 active，捕获 `{goalID,generation}` 用于本次 usage，并向本轮 reminder/continuation 注入 current objective/status/generation/reason。旧 assistant 文本或 summary 不能替代 service snapshot。
6. continuation 决策再次读取 Goal；只有 snapshot 仍 active 且 generation 与当前 continuation candidate 一致才注入。edit 后使用新 generation/objective，pause/terminal/clear 不注入。
7. request 完成后在 structured output、normal stop、terminal error 和可计量 abort 分支统一调用 generation-aware `accountUsage`，然后再执行 break/continue；objective edit/clear mismatch 是显式 no-op diagnostic，不重归属。
8. 保持 max-turn、error allowlist、permission、compaction、abort 和 processor control flow；没有 evaluator 或 catch-and-continue fallback。

### 9.4 HTTP/TUI Resume

成功 `goalSvc.set` 后，如果返回 Goal 为 active：

- raw message history 有至少一个 user message时，将 `promptSvc.loop({sessionID})` fork 到 handler 已有 scope；`RunState.ensureRunning` 是唯一 idle/start 与 busy/join owner。
- session 尚无 user message时不 fork，保留 active Goal；首条普通 prompt 自然启动 loop。
- create、active objective edit、paused/terminal resume 都走同一路径；重复 active POST 也只调用幂等 ensure-running，不需要竞态不可靠的前后读。
- handler 使用 newest-first `session.findMessage(sessionID, role === "user")` 做 has-user gate，不另建消息索引或状态位。mutation HTTP 响应只表示持久化成功，不声称后台 loop 已完成；fork failure 复用 `promptAsync` 的 `Effect.catchCause -> Effect.logError + Bus.publish(Session.Event.Error)` observability，不回滚已提交 mutation，也不启动替代 loop。
- clear/pause/terminal 不调用 loop。TUI 通过 generated SDK 调用同一 endpoint，不复制判断。

### 9.5 OpenAPI and SDK

同步公开 contract：Goal 增加 read-only `generation` 和 nullable `reason`；`GoalSetPayload` 增加 optional `reason`，且 domain 要求它仅与显式 terminal status 一起使用。内部 blocked fields、terminal turn、GoalTurn/read snapshot 和 usage expected tuple不公开。

HTTP 继续用现有 `GoalApiError` 映射 `GoalError`，不新增 conflict error，因为 user mutation 明确保留 last-write-wins。运行 root `./script/generate.ts` 同时更新 committed `packages/sdk/openapi.json` 和 SDK；TUI 删除 raw Goal fetch/重复 response type，使用 generated method，并展示 terminal reason。任何 generator 额外文件以实际 deterministic diff 为准，不手改。

## 10. Existing Logic to Replace or Remove

本方案不是在现有逻辑旁边叠加兼容分支，以下旧行为必须收敛：

| 旧逻辑 | 处理 |
|---|---|
| `GoalTool` 直接把可选 `status` 传给 `goalSvc.set` | 替换为 read-gated `modelTransition`，删除无 reason/无 snapshot 的写路径 |
| `goal.txt` 单独要求模型记住两轮 blocked | 保留解释性文本，删除其作为唯一约束的含义；runtime/domain 成为唯一强制路径 |
| `SessionGoal.set` 同时承载 model 与 user，无 generation | user `set` 保持 last-write-wins；model 移入唯一 `modelTransition`；objective edit 原子 generation++ |
| `accountUsage` 只看 current active row | 替换为 required expected Goal ID + generation 和原子 SQL 增量；删除结束状态 gate |
| HTTP/TUI active mutation 只写 DB | 成功返回 active 后调用唯一 `SessionPrompt.loop`；不在 TUI 增加另一套 loop |
| TUI raw fetch/手写 Goal type | SDK 生成完成后删除重复 transport 代码 |
| 旧 prompt continuation 没有 durable marker/turn identity | 增加 part metadata marker、eligible message derivation 和 generation guard；不增加 evaluator fallback |

不删除 `docs/goal-error-continuation-control-plan.md` 的历史设计；实现后只在必要处增加“generation/usage 规则已由本方案 supersede”的链接，避免读者把旧 best-effort 描述当成新不变量。

## 10A. Secondary and Replacement Path Inventory

| Path | Current/proposed | Classification | Produces success? | Decision-surface share | Disposition |
|---|---|---|---|---:|---|
| `GoalTurn -> GoalTool get -> modelTransition -> transaction` | proposed | primary-contract branch | yes | 42% | sole model semantic path |
| blocked pending attempt 1 of 2 through same modelTransition | proposed | primary-contract intermediate | no terminal success | 8% | preserve as audited progress |
| HTTP/SDK user `set -> transaction -> event` | current, modified | primary-contract actor branch | yes | 18% | preserve last-write-wins |
| active Goal mutation -> `SessionPrompt.loop -> RunState.ensureRunning` | proposed using current loop | primary-contract branch | yes | 8% | preserve as sole resume path |
| Goal continuation marker -> next eligible Goal turn | current, modified | primary-contract branch | yes | 6% | preserve |
| technical user messages inherit `goalTurnID` or backward-scan | current, modified | pass-through | no | 4% | preserve, never count blocked |
| legacy terminal migration marker | proposed for persisted rows | existing compatibility | yes, readable current row | 3% | preserve while legacy rows exist |
| no Goal/no read/invalid reason or transition | current/proposed | diagnostic | no | 4% | fail with GoalError, no write |
| stale ID/generation/status/turn | proposed | diagnostic | no | 3% | fail, no current-row retry |
| usage expected tuple mismatch | proposed | diagnostic | no | 2% | skip attribution with log/metric; never reassign |
| empty-session active mutation | proposed | pass-through | persistence yes, loop no | 2% | wait for first real prompt |
| evaluator/second model/current-row fallback | rejected | forbidden fallback | no | 0% | do not add |

Decision-surface sum is 100%；diagnostic-only rows total 9%，below the 10% gate。没有 `try primary then alternate success`、catch-and-default、第二 parser/data source 或 feature-disable fallback。User `set` 与 model transition 是同一 domain row 的不同 actor contract，不是在失败后竞争的成功实现。

## 11. Traceability: Requirement to Code and Test

| Req | Production owner | 行为测试 | 当前红色缺口 |
|---|---|---|---|
| REQ-01 / INV-01 | `SessionPrompt GoalTurnContext -> GoalTool read -> SessionGoal.modelTransition` | no-read zero-write；same eligible turn read then write | 当前 `get=0,set=1` |
| REQ-02 / INV-02/12 | Goal schema/migration、Tool、HTTP/API | blank/6401 reject；terminal round-trip；legacy marker | 当前无 reason |
| REQ-03 / INV-04 | raw GoalTurn classifier + terminal_turn_id + GoalTool + modelTransition | actual continuation/technical producer rejects recovery；later real user producer recovers；user-terminal/paused reject | 当前无 classifier-to-recovery proof |
| REQ-04 / INV-05 | atomic user `set` generation + model generation/status/turn guards | concurrent edits produce distinct generations；edit/pause/clear/recreate races zero stale write | 当前 set read/update 不在同一 SQL transaction |
| REQ-05 / INV-06 | raw message eligible derivation + continuation marker | multi assistant steps same turn；new continuation different；compaction/task not count | 当前 Tool context 每 assistant step 重建 |
| REQ-06 / INV-07 | dispatch `{goalID,generation}` -> atomic accountUsage | terminal/pause still count；edit/clear skip；concurrent increments no lost update | 当前按 current active row |
| REQ-07 / INV-08 | active HTTP result -> `SessionPrompt.loop -> RunState` | create/edit/resume idle；busy dedupe；empty session waits；pause/terminal no loop | 当前 handler 只写 DB |
| REQ-08 / INV-11 | existing prompt/processor/selection branches | error allowlist、max turns、abort、compaction、permission 回归 | 现有测试需与新 context 联跑 |
| REQ-09 / INV-09 | HttpApi Goal schema -> root generator -> SDK/TUI | committed OpenAPI diff、generated method/type、TUI reason | 当前 SDK v2 无完整 Goal contract |
| REQ-10 / INV-10 | user `set` immediate transaction | no expected revision remains last-write-wins；concurrent effective objective edits each generation++ | 当前 multi-daemon read/update 可复用 generation |
| REQ-11 / INV-03 | `GoalTool.mark` schema/read gate + `goal.txt` + `SessionGoal.continuationPrompt` + `modelTransition` | provider JSON schema has mark/reason and no status；first pending guidance；second same-reason blocked；same/cross-turn reset；Tool error cause/action | R2 三轮 contract、same-turn bypass 与新要求冲突 |

### Reverse traceability

| Proposed production concept | Requirement/invariant | Evidence | Why existing logic cannot carry it |
|---|---|---|---|
| `generation` column/public field | REQ-04/06/09/10; INV-05/07/09/10 | objective edit preserves Goal ID | ID/status cannot distinguish objective A from B |
| nullable public `reason` column | REQ-02; INV-02/12 | user requires auditable terminal reason | current Goal has no reason storage |
| internal `blocked_reason` | REQ-02; INV-03 | exact same reason required across turns | terminal reason must stay null while active pending |
| internal `blocked_streak` | INV-03 | two-turn contract | prompt text cannot enforce count |
| internal `blocked_last_turn_id` | INV-03/06 | same-turn duplicate and skipped-turn detection | assistant message ID changes per step |
| internal `terminal_turn_id` | REQ-03; INV-04 | same-turn self-unlock must fail | status alone cannot identify producing turn/actor |
| in-runLoop `GoalTurnContext` | REQ-01/03/05; INV-01/04/06 | latest user spans multiple provider steps | current Tool extra is rebuilt per assistant step |
| optional `MessageV2.User.goalTurnID` lineage | INV-03/06 | compaction replay copies non-synthetic user parts and otherwise looks real | adjacency/text heuristics misclassify replay；request usage is different owner |
| `{goal_continuation:true}` TextPart metadata | INV-03/06 | Goal continuation itself is synthetic and starts a new eligible turn | lineage omission alone cannot distinguish it from other synthetic messages |
| `SessionGoal.modelTransition` method | REQ-01~04; INV-01~05 | model/user actor contracts differ | generic set cannot require trusted read without breaking user set |
| `GoalTool.mark` mutation parameter | REQ-11 | 用户要求用动词表达 mutation | `status` 容易被模型理解为查询筛选条件 |
| blocked-pending result union | INV-03/REQ-11 | attempt 1 of 2 is valid progress, not terminal/error | throwing would lose observable attempt semantics |
| expected `{goalID,generation}` usage input | REQ-06; INV-07 | edit retains ID；terminal changes status | current session/status gate either contaminates B or drops final usage |
| atomic SQL usage increment | INV-07 | concurrent provider/request completion reachable | read-add-write can lose increments |
| active-set loop fork | REQ-07; INV-08 | current handler persists only | Goal domain cannot own Effect fiber/session history |
| legacy terminal reason marker | INV-12 | persisted terminal rows lack recoverable reason | null would violate terminal response invariant；invented reason is false |
| public generation/reason + generated SDK | REQ-09; INV-09 | GoalResponse directly exposes schema | manual TUI/raw types drift from contract |
| existing `GoalError` reuse | INV-11 | domain already exposes typed message error | new error hierarchy has no additional consumer |
| user last-write-wins branch | REQ-10; INV-10 | public payload has no expected revision and has external consumers | server read-then-CAS cannot detect stale user intent |

## 12. Concurrency and Failure Matrix

| 场景 | 预期结果 | 防线 |
|---|---|---|
| 两个 model writes 同 snapshot/turn | transaction 先成功者改变 status/audit；后者由 expected status/turn 或 same-turn rule 拒绝/幂等 pending；event 不重复 | immediate transaction + expected tuple |
| 两个 daemon 并发 user objective edits | immediate transaction 串行读取 current row；每个相对 current 生效的 objective edit 各自 generation++，后提交者保持 last-write-wins | `SessionGoal.set` immediate transaction |
| 用户 edit 与 model complete 同时发生 | 以 transaction 先后为准；若 edit 先提交则 generation mismatch，若 complete 先提交则后续 edit 清 reason/audit 并 generation++ | Goal ID + generation transaction |
| clear 后 recreate 同 session | 旧 provider usage 不记入新 row；旧 terminal write 失败 | expected Goal ID + generation |
| 用户 pause/terminal 在 provider 执行中 | 不取消 provider；旧 model write expected status 失败；usage 仍计入同 generation | status guard + usage generation |
| user active create/edit/resume，session idle | 有 user history时 fork existing loop；empty session 等首 prompt | handler + `SessionPrompt.loop` |
| user active mutation时 session busy | 调用同一 loop 但 `ensureRunning` join，不创建第二 runner | RunState mutex |
| model 在 terminal 同 turn写 active | active transition 拒绝；terminal_turn_id 相同 | eligible turn ID + actor source |
| model 从 paused 写 active | 拒绝；必须用户/system resume | actor boundary |
| model 对 user-produced terminal 再写 complete/blocked | 第一次调用即拒绝且不写 pending/terminal_turn_id；后续 active 仍由 user ownership 拒绝 | modelTransition active-source guard + provenance test |
| blocked reason 改变 | streak 从 1 开始，不继承旧 reason | exact trimmed reason + previous turn ID |
| 同一 blocked reason 重复 tool call | streak 不增加 | last turn ID |
| 同一 turn 改变 blocked reason | 新 reason 替换 pending baseline，streak 保持 1；旧 reason 下一 turn 不能终态化 | same-turn ID + exact trimmed reason |
| 一个 eligible turn 没有 blocked attempt | 下一 turn 的 previous ID 与 DB last attempt 不同，streak 从 1 开始 | raw message ordering |
| provider error/abort | 按现有 error/abort 结束；若已有可计 usage则按 expected generation 计入；不自动 complete | prompt accounting ordering |
| compaction/task technical user message | 通过 `goalTurnID` 继承 canonical turn，不生成新 eligible turn | MessageV2 lineage + raw history |
| compaction 后进程重启 | 内存 read snapshot 不恢复，模型必须重新调用 Goal get | fail-closed read gate |
| GoalTool 被 permission 禁用 | 保持现有工具选择行为；不新增绕过 permission 的写入口 | `ToolSelection.enabled` |
| DB busy/transaction failure | 向上返回错误，不静默 fallback、不重复写 | existing Effect error path |
| 进程重启后 blocked streak | reason/streak/last eligible turn 从 DB 恢复，前一 eligible turn从 raw message history重建 | schema + raw messages |
| 旧 row 无新增字段 | migration generation=1；terminal 用 legacy reason marker；audit reset | generated migration + snapshot |
| 两个 concurrent usage increments | where ID+generation 原子列加法，不丢更新 | one SQL update per completion |

## 13. TDD Implementation Slices (Future, Not Authorized Now)

实现获批后严格按以下垂直切片，不先改生产代码：

### Slice A: Domain schema and model transition

- 先补 `test/session/goal.test.ts`：generation lifecycle、reason lifecycle、blocked current/previous turn、model terminal/recovery、expected status/ID/generation、atomic usage。
- 当前实现必须红：无 modelTransition、generation/reason/audit fields 和 expected generation usage。
- 再改 `goal.sql.ts`、migration、`goal.ts`；运行 migration/round-trip tests。

### Slice B: GoalTool read gate and recovery

- 新增 `test/tool/goal.test.ts`，通过真实 Tool public seam 断言 read count/write count、输出和持久化状态。
- 覆盖 no Goal、no-read zero-write、read then complete、blank/6401 reason、blocked streak 1/2、same-turn duplicate、skipped eligible turn reset、later-real-user recovery、same/continuation/user-terminal/paused rejection。
- 当前红色 harness 固定为回归测试，不能改成源码结构断言。

### Slice C: Prompt turn context and stale continuation

- 扩展 `test/session/prompt.test.ts`，使用 readiness/poll，不用 fixed sleep。
- 覆盖一个 real user 下多个 assistant steps 共享 read、Goal continuation marker 产生新 turn、compaction/task synthetic 不计 turn、objective edit/clear 与 provider completion 时序、最新 generation/objective 注入和 max turns。
- 再改 `prompt.ts`，保持 processor/abort 现有语义。

### Slice D: Usage and terminal/error paths

- 补 normal stop、structured output、tool error、provider error、abort、pause/clear race 的 Goal usage 行为测试。
- 断言 terminal/pause 后同 generation usage 仍计入、objective edit generation mismatch 跳过、clear/recreate ID mismatch 跳过、两个并发 increment 不丢失。

### Slice E: HTTP/TUI user resume

- 扩展 `test/server/httpapi-goal.test.ts` 和必要的 run-state integration test。
- 断言 active create/edit/resume 在有 user history时进入唯一 loop、busy join、empty session等待、pause/terminal/clear不启动；user last-write-wins 与 model generation guard 分离。
- 再改 handler/TUI sync；不在测试中 mock 自己实现的 Goal rules。

### Slice F: Contract, generated SDK and compatibility

- 先生成 Drizzle migration+snapshot 并补 legacy terminal/active defaults test；再更新 HttpApi schema。
- 运行 root generator，断言 committed OpenAPI 和 generated SDK 都包含 generation/reason/Goal method，TUI 不再依赖重复 raw fetch type。
- 运行 migration tests、opencode typecheck、SDK typecheck 和完整相关测试。

## 14. Expected File Scope and Diff Budget

### R12 exact delta

| 文件 | R12 动作 | 原因 |
|---|---|---|
| `packages/opencode/src/session/goal.ts` | 修改 | atomic user generation、两轮/same-turn reason 规则、continuation contract、model-facing rejection prose |
| `packages/opencode/src/session/goal.sql.ts` | 注释修改 | 两轮阈值说明，不改 schema |
| `packages/opencode/src/tool/goal.ts` | 修改 | `mark` contract、pending guidance、no-read actionable rejection |
| `packages/opencode/src/tool/goal.txt` | 修改 | two-turn/same-reason 模型说明 |
| `packages/opencode/src/session/prompt.ts` | 修改 | raw chronological eligible-turn derivation |
| `packages/opencode/src/session/compaction.ts` | 修改 | compaction marker 继承 canonical Goal turn lineage |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 修改 | active mutation has-user gate 与既有 error observability |
| `packages/opencode/test/session/goal.test.ts` | 修改 | domain/same-turn/continuation prompt behavior |
| `packages/opencode/test/tool/goal.test.ts` | 修改 | Tool pending/rejection/same-turn behavior |
| `packages/opencode/test/tool/parameters.test.ts` | 修改 | provider-visible schema 只暴露 `mark`，不暴露 `status` |
| `packages/opencode/test/session/prompt.test.ts` | 修改 | raw turn identity across compaction/provider window |
| `packages/opencode/test/session/compaction.test.ts` | 修改 | marker lineage producer behavior |
| `packages/opencode/test/server/httpapi-goal.test.ts` | 修改 | empty/non-empty resume loop owner behavior与 failure event |
| `docs/plans/session-goal-transition-integrity.md` | 修改 | canonical R12 contract/audit/evidence |

除此列表外不修改 production/test 文件。HTTP public SSE seam 已在既有 `httpapi-goal.test.ts` 内承载，不新增测试文件或 production injection seam。以下表格保留 R2 原始实施预算作为历史记录，不是 R12 授权范围。

### Expected modified/added files

| 文件 | 预计动作 | 预计有效增量 | 原因 |
|---|---|---:|---|
| `packages/opencode/src/session/goal.sql.ts` | 修改 | +15~35 | exact generation/reason/internal audit columns |
| `packages/opencode/src/session/goal.ts` | 修改 | +160~280/-35~80 | user transaction、modelTransition、reason/audit lifecycle、generation-aware atomic usage |
| `packages/opencode/src/tool/goal.ts` | 修改 | +60~120/-15~35 | read gate、reason、recovery boundary |
| `packages/opencode/src/tool/goal.txt` | 修改 | +15~30/-5~15 | 与 runtime 规则对齐的模型说明 |
| `packages/opencode/src/session/message-v2.ts` | 修改 | +2~8 | optional Goal turn lineage on technical user messages |
| `packages/opencode/src/session/compaction.ts` | 修改 | +8~25 | replay/continue user messages继承 canonical Goal turn ID |
| `packages/opencode/src/session/prompt.ts` | 修改 | +120~220/-20~60 | eligible GoalTurn、marker、snapshot、usage ordering/generation guard |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 修改 | +20~60 | reason passthrough、active-result loop fork、empty-session guard |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | 修改 | +5~20 | reason payload；Goal response由domain schema传播 generation/reason |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | 修改 | +10~45/-20~70 | generated SDK transport、terminal reason display/error |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | 修改 | +10~35/-15~45 | generated response/event reconcile |
| `packages/opencode/migration/<generated-session-goal-integrity>/migration.sql` | 新增 | generator-dependent | columns/defaults/legacy terminal reason backfill |
| `packages/opencode/migration/<generated-session-goal-integrity>/snapshot.json` | 新增 | generator-dependent | required Drizzle snapshot |
| `packages/opencode/test/session/goal.test.ts` | 修改 | +100~220 | domain behavior |
| `packages/opencode/test/tool/goal.test.ts` | 新增 | +100~220 | public Tool behavior |
| `packages/opencode/test/session/prompt.test.ts` | 修改 | +120~260 | turn/continuation/usage races |
| `packages/opencode/test/server/httpapi-goal.test.ts` | 修改 | +70~160 | HTTP/resume behavior |
| `packages/opencode/test/storage/goal-migration.test.ts` | 修改 | +20~60 | migration compatibility |
| `packages/sdk/openapi.json` | 生成 | generator-dependent | committed public contract；由 root script 生成 |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 生成 | generator-dependent | Goal methods |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | 生成 | generator-dependent | Goal types |

### Budget and scope guard

- 预计手写 production/contract 文件 11 个、测试 5 个、migration 目录 2 个产物、committed OpenAPI 1 个、generated SDK 2 个主要文件；总计预计 21 个文件。手写有效新增约 780~1,500 行、删除约 150~380 行；generator 若改变额外 deterministic siblings，可超过 21，但必须逐项核对且不能手改。
- 预期没有新的 dependency、独立 Goal history 表、全仓库重命名或 unrelated formatting。
- 如果实现中发现需要超过上述范围，必须先增加 canonical plan revision 并重新 full-scope audit，不能在 implementation 阶段自行扩张。
- 中文解释性注释预算：手写 production/test/config 有效行 `E=900~1,800`；最低 `C=ceil(E*0.15)=135~270`。计划 `C=150~300`，分布在 eligible-turn 判定、trusted read、generation/status guard、blocked adjacency、reason lifecycle、usage attribution、resume/empty-session race、migration legacy marker和对应行为测试附近。imports、格式、生成文件、snapshot、纯移动不计 E/C。

### Chinese comment budget

| Metric | Estimate | Method |
|---|---:|---|
| Effective changed code lines `E` | 900~1,800 | exclude imports, blank/format-only, generated files, snapshots and pure moves |
| Required Chinese explanatory comments `C` | 135~270 | `ceil(E * 0.15)` |
| Planned qualifying `C` | 150~300 | nearby rationale/invariant/test-intent comments, not restatements |

## 15. Verification Commands

实现获批后建议按窄到宽执行：

| Command | Working directory | Evidence produced |
|---|---|---|
| `bun run db generate --name session-goal-integrity` | `packages/opencode` | 生成 `migration.sql` 和 `snapshot.json`，不手写 snapshot |
| `bun test test/storage/goal-migration.test.ts` | `packages/opencode` | 旧 active/paused/complete/blocked rows 的 defaults/backfill |
| `bun test test/session/goal.test.ts test/tool/goal.test.ts --filter goal` | `packages/opencode` | domain generation/reason/audit 和真实 Tool read gate |
| `bun test test/tool/parameters.test.ts --filter goal` | `packages/opencode` | provider-visible Goal schema 包含 `mark`/`reason` 且排除 `status` |
| `bun test test/session/compaction.test.ts test/session/prompt.test.ts --filter goal` | `packages/opencode` | compaction marker lineage、raw eligible-turn continuity 和 continuation contract |
| `bun test test/session/prompt.test.ts --filter goal` | `packages/opencode` | eligible turns、continuation、usage、error/abort/compaction 时序 |
| `bun test test/server/httpapi-goal.test.ts --filter goal` | `packages/opencode` | HTTP reason/last-write-wins/active loop/empty session contract |
| `bun typecheck` | `packages/opencode` | production/test TypeScript |
| `./script/generate.ts` | repository root | SDK build + committed `packages/sdk/openapi.json` + formatter；随后检查仅 Goal 相关 deterministic diff |
| `bun typecheck` | `packages/sdk/js` | generated SDK contract typecheck |
| `bun test test/session/goal.test.ts test/tool/goal.test.ts test/tool/parameters.test.ts test/session/compaction.test.ts test/server/httpapi-goal.test.ts test/session/prompt.test.ts test/storage/goal-migration.test.ts` | `packages/opencode` | 完整相关行为回归，不依赖 `--filter` |
| `git diff --check` | repository root | whitespace/patch hygiene |

R12 当前仅允许 plan 审计；工作树中的候选实现和既有绿色测试不构成 exact-revision 授权。R12 获批后继续使用已经记录的 red-capable assertions 和 red/green 证据，并先补 provider description、四项探索动作和 terminal provenance laundering 的敏感断言，不重写或弱化其他测试。R12 不改 schema/SDK，因此不运行写入性 migration/generation 命令；只运行既有 migration regression 和 SDK typecheck 证明无 drift。

## 16. Risks and Open Questions

### Resolved decisions

- 状态集合不变；`active` 即可执行，不新增 `in_progress`。
- objective identity 使用稳定 Goal ID + objective-only `generation`；status/reason 改变不影响 generation，因此 final usage 不丢失。
- user API 不增加 expected revision；明确保留 last-write-wins，避免虚假的 server-read CAS。
- terminal public 字段固定为 nullable `reason`；pending blocked audit 固定为内部三字段，阈值固定为两个连续 turns 且 reason 完全一致，不再留给 implementation 选择。
- eligible turn 固定为 real user/marked Goal continuation MessageID；provider steps/其他 synthetic 不计数。
- model 只恢复 model-produced terminal；user-produced terminal/paused 仍由用户 API 恢复。

### Real residual risks

- edit 发生在 provider 已开始之后，旧请求仍可能消耗 token/执行外部读操作；本方案只阻止旧 terminal write 和 usage 归到新 generation。立即取消属于独立 cancellation requirement。
- migration 无法恢复历史 terminal 理由，只能写诚实 legacy marker；完整历史审计需要未来独立 Goal history 需求。
- internal synthetic message 后进程重启会丢 trusted read，模型必须重新 get；这是 fail-closed，不是兼容失败。
- user-user concurrent HTTP mutation 继续 last-write-wins；这是现有公开 contract，非本需求承诺。
- root generator 可能更新额外 deterministic generated siblings；implementation 必须逐项核对，任何非 Goal/formatter 必要 diff 不纳入提交。

### Rejected speculation

- 不要求 edit/clear 时立即取消 provider；原始需求只要求旧状态不能覆盖新 Goal。
- 不引入 evaluator、第二模型或通用状态机；当前 read/reason/generation/recovery 不变量不需要。
- 不因 GoalTool permission deny 自动终态化 Goal；没有该产品 contract，现有 max-turn/permission 保持。
- 不新增完整 Goal history 表；当前消费者只需要 current reason 和 blocked audit。
- clear/recreate 已由新 Goal ID 隔离；generation 主要修复保留 ID 的 objective edit。

### Open decisions requiring the user

None。用户已要求继续实施并将审计计数器归零，R12 保持 atomic generation、persisted canonical chronology 与 user terminal ownership。获得新的独立 `APPROVE` 前保持 `Approved revision: none`、`Implementation allowed: no`。

## 17. Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
|---|---|---|---|---|---|---|
| 1 | R1 | yes | `B-01` contracted；`B-02` reachable；`B-03` reachable；`B-04` contracted；`B-05` reachable；`B-06` contracted | 根因总体定位正确；R1 数值注释预算可满足；audit metadata 合格；plan audit 未执行实现命令 | **BLOCK** | `ses_0a078639fffeah1balTXVC5aXT` |
| 2 | R2 | yes | `No blocking findings.` | `N-01` compaction-continue goalTurnID source；`N-02` migration backfill supplement；`N-03` "Task summary" producer not located | **APPROVE** | `ses_0a04a1ba5ffeuI7EyLSd05fToR` |
| 3 | R3 | yes | `B-01` same-turn changed reason bypasses reset；`B-02` model-facing rejection seam mapping incomplete | `N-01` historical R2 implementation sections stale；`N-02` historical current-behavior statements stale | **BLOCK** | `ses_09e762f45ffeas5RAC3RiOxAmm` |
| 4 | R4 | yes | `B-01` eligible-turn derivation still uses compacted window；`B-02` empty-session HTTP resume silently starts failing loop；`B-03` `Effect.flip` cannot observe wrapped Tool defects | `N-01` historical R2 sections stale；`N-02` prospective comment count not numerically expanded | **BLOCK** | `ses_09e7047abffefFIqR7V5G5Zjli` |
| 5 | R5 | yes | `B-01` actual classifier-to-recovery authorization test missing；`B-02` provider-visible mark-only schema test missing | historical R2 sections stale；three-turn `goal.sql.ts` comment already planned | **BLOCK** | `ses_09e644a17ffe6ItV6FXpcJ2qHP` |
| 6 | R6 | yes | `B-01` late technical Message can rewind authoritative Goal turn | none | **BLOCK** | `ses_09e594871ffe3WlkdjQAPDK2g2` |
| 7 | R7 | yes | `B-01` user objective generation transition is not SQL-atomic；`B-02` canonical turn ordering trusts caller-controlled MessageID lexical order | none | **BLOCK** | `ses_09e4cd8f5ffevj9DO9gA3Hyybj` |

R1 release verdict 原文：`BLOCK`。R2 对应修复：B-01 由 §0/§6A/§6B/§10A/§11 完整契约处理；B-02 由 objective-only generation + expected tuple usage 处理；B-03 由 §8.3 eligible MessageID 和 raw history 处理；B-04 由 §8.1/8.2 exact fields/lifecycle 处理；B-05 通过明确保留 user last-write-wins 并删除虚假 conflict 承诺处理；B-06 由 migration SQL+snapshot 和 root generation commands 处理。

R2 release verdict 原文：`APPROVE`。独立 auditor 确认：所有 material current-behavior claim 已对照源码验证；codex 证据准确且未过度依赖；根因（GoalTool→`set` 无 read/reason/generation）在 owner 处以唯一权威 primary path 修复；无禁止 fallback、responsibility leak 或未映射 concept；forward/reverse traceability 完整；secondary-path 预算低于 gate；TDD slices 可 red；prospective 中文注释预算满足 15% 公式。三项 non-blocking observations（N-01 compaction-continue `goalTurnID` source、N-02 migration backfill supplement、N-03 "Task summary" producer）是实现澄清项，有可用数据和 red-capable test，非 contract defect。

Non-blocking disposition：N-01 在 implementation 时将 compaction-continue 路径的 `goalTurnID` source 显式固定为 `userMessage`；N-02 在 §13/§14 明确 generated `migration.sql` 补充 backfill UPDATE（不手写 `snapshot.json`）；N-03 若无独立 "Task summary" user-message producer 则删除该提及，backward-scan fallback 已覆盖。

R3 release verdict 原文：`BLOCK`。R4 对应修复：B-01 在 §1A/§8.4/§12/TDD 明确同 turn 相同 reason 幂等、同 turn 改 reason 替换 pending baseline 并保持 attempt 1；B-02 将 `GoalTool` read gate 与 `SessionGoal.modelTransition` 的全部可达 model-facing rejection owner 纳入 cause/action contract 和真实 Tool seam 测试。N-01/N-02 是已由 §1A precedence 明确隔离的 R2 历史叙述，不改变 R4 行为或文件范围，保持 non-blocking。

R4 release verdict 原文：`BLOCK`。R5 对应修复：B-01 把 `SessionCompaction.create` lineage producer、raw chronological classifier、旧无-lineage marker 兼容和 prompt/compaction tests 纳入 §1A/§8.3/§9.3/§14；B-02 在既有 HTTP owner 增加 newest-first has-user gate，并复用 `promptAsync` 的 log + `Session.Event.Error` observability；B-03 将 Tool rejection test 改为仓库真实 wrapper 已采用的 `Effect.exit` + `Cause.squash`。R4 non-blocking 历史段落由 §1A/§14 明确标为 R2 记录，R5 comment budget 已展开为 `C=17~29`。

R5 release verdict 原文：`BLOCK`。R6 对应修复：B-01 在 §1A TDD 中加入 actual `SessionPrompt` producer -> `GoalTurnContext.userInitiated` -> GoalTool -> recovery consumer 的完整行为链，分别证明 Goal continuation、继承 terminal turn 的 technical Message 和后续真实 user；B-02 使用 provider serialization 已采用的 `ToolJsonSchema.fromSchema` 断言 properties 包含 `mark`/`reason` 且不包含 `status`，并把 `test/tool/parameters.test.ts` 纳入 exact file scope。两项都只增加敏感测试，不增加 runtime fallback 或新 abstraction。

R6 release verdict 原文：`BLOCK`。唯一 blocker 指向 `B(original) -> C(real user) -> S(technical, goalTurnID=B)` 的可达顺序：R6 按 wrapper 持久化顺序映射 lineage 会得到 current=B、previous=C，违反 technical Message 不改变 Goal turn 的不变量。由于方案审计轮次已达 6，本文件不自行创建 R7，按 workflow 将最小 canonical-source ordering 修正作为开放决定交用户。

R7 release verdict 原文：`BLOCK`。B-01 证明当前 `SessionGoal.set` 的 row read/generation calculation/update 不在同一个 SQL transaction，无法以 plan 证据保证 concurrent objective edits 产生唯一递增 generation；B-02 证明 public Prompt 接受 caller-supplied `messageID`，其 lexical order 不是 persisted chronology。最小 R8 修正仍在既有 `SessionGoal`/`SessionPrompt` owner 和既有测试文件内，不需要新 schema、API、module 或 fallback，但未经用户再次授权不得创建 R8。

### Reset audit cycle

用户随后明确要求继续实施并将计数器归零。历史 Round 1~7 保留为证据，但 R8 起新的 plan-audit cycle 从 Round 1 计数；仍要求 exact revision 获得 `No blocking findings` 和 `APPROVE` 后才允许实施。

| Cycle 2 round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
|---|---|---|---|---|---|---|
| 1 | R8 | yes | `B-01` §9.3 reintroduced MessageID-max ordering contrary to persisted chronology | stale historical R2 sections；comment estimate arithmetic valid | **BLOCK** | `ses_09e4365a6ffePXLJvqZKGK2LAH` |
| 2 | R9 | yes | `No blocking findings.` | historical R2 execution/current-behavior sections remain stale but are superseded explicitly by R9 | **APPROVE** | `ses_09e3eedafffegi0ijBR5QJ0C5G` |
| 3 | R10 | yes | `B-01` comment budget lower bound fails worst-case arithmetic；`B-02` model-visible blocked contract/tests do not lock the four required exploration actions or exact eligible-turn/reason semantics | historical R2 scope remains clearly superseded | **BLOCK** | `ses_09e00fcaeffe0ryy0qSTg3R7h1` |
| 4 | R11 | yes | `B-01` model can re-mark a user-produced terminal Goal, overwrite `terminal_turn_id`, then recover it on a later user turn | stale R2 scope；commit constraints are available through stable repository workflow docs | **BLOCK** | `ses_09dfb2df5ffeG2r9I8qEw8Mq5S` |
| 5 | R12 | yes | `No blocking findings.` | historical/R12 budget wording and stale R2 sections remain non-authoritative clarity debt | **APPROVE** | `ses_09df4d227ffeOGpn0t0eKdncoq` |

R8 release verdict 原文：`BLOCK`。R9 只消除同一 plan 内的 ordering 矛盾：§8.3 与 §9.3 现在都以 canonical source 自身持久化的 `(time.created, id)` chronology 为唯一规则，明确排除 caller-controlled ID lexical max；行为、文件范围和 primary owners 不变。

R9 release verdict 原文：`APPROVE`。独立 auditor 结论为 `No blocking findings.`；exact R9 的 requirement/owner/TDD/file/verification mapping、primary-path/fallback gate 和 prospective 中文注释预算均通过。Non-blocking 仅为已由 §1A/§14 明确 supersede 的 R2 历史段落，不改变 R9 实施授权。

R10 release verdict 原文：`BLOCK`。R11 对 B-01 将 planned qualifying comments 下界从 103 提高到 105，使 `E=700` 时仍满足 `ceil(E*0.15)=105`；对 B-02 在 §0/§1A/REQ-11/§9.2/TDD mapping 同时锁定 provider schema 的 two eligible turns/same trimmed reason，以及 blocked-pending 的重读文件、不同搜索方式、拆分可验证步骤、检查遗漏依赖/约束四项动作。R11 不改变 production owner、行为范围、文件范围或 primary path。

R11 release verdict 原文：`BLOCK`。R12 对唯一 blocker 在既有 `SessionGoal.modelTransition` owner 增加 `complete|blocked` active-source guard：paused 或 terminal source 在 reason/audit/provenance 写入前失败。真实 GoalTool 测试覆盖 user terminal -> complete/blocked re-mark拒绝 -> later active 仍拒绝，证明 `terminal_turn_id=null` 的 user ownership 不会被洗白；不新增 provenance 字段、旁路或 fallback。

R12 release verdict 原文：`APPROVE`，并明确 `No blocking findings.`。独立 auditor 确认 exact R12 的 requirement/owner/TDD/file/verification mapping、active-source ownership guard、primary-path/fallback gate和 prospective 中文注释预算均通过；两项 non-blocking 仅为已由 §1A/§14 precedence 隔离的历史预算与旧 R2 叙述，不改变 R12 实施授权。

## 18. R12 Implementation Evidence

### 18.1 Exact scope and route

- 实施严格落在 R12 批准的 7 个 production/contract 文件、6 个测试文件和本 plan，共 14 个文件；未新增 module、dependency、配置、schema、migration、OpenAPI、SDK 或 TUI diff。
- 不计 plan 的 raw diff 为 `+905/-256`。大部分 `goal.ts` deletion/addition来自把既有 user set 分支包入同一 immediate transaction；E/C 计算按规则排除 imports、空行、纯格式和同文件 pure-move。
- model primary path 保持唯一：`SessionPrompt GoalTurnContext -> GoalTool read -> SessionGoal.modelTransition -> immediate transaction`；user path 保持 `HTTP/TUI -> SessionGoal.set -> immediate transaction -> Event.Updated`。
- 删除/替换的 workaround：三轮 blocked contract、same-turn reason-only bypass、provider-window/technical-wrapper turn ordering、read-outside-transaction generation、empty-session failing loop 和 `catchDefect(() => Effect.void)` 静默失败；没有添加 fallback 或第二状态机。

Exact changed files：

1. `packages/opencode/src/session/goal.ts`
2. `packages/opencode/src/session/goal.sql.ts`
3. `packages/opencode/src/tool/goal.ts`
4. `packages/opencode/src/tool/goal.txt`
5. `packages/opencode/src/session/prompt.ts`
6. `packages/opencode/src/session/compaction.ts`
7. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
8. `packages/opencode/test/session/goal.test.ts`
9. `packages/opencode/test/tool/goal.test.ts`
10. `packages/opencode/test/tool/parameters.test.ts`
11. `packages/opencode/test/session/prompt.test.ts`
12. `packages/opencode/test/session/compaction.test.ts`
13. `packages/opencode/test/server/httpapi-goal.test.ts`
14. `docs/plans/session-goal-transition-integrity.md`

### 18.2 Red -> green evidence

| Behavior slice | Red evidence before production repair | Green evidence |
|---|---|---|
| same-turn changed reason | expected `blocked-pending`, received `updated` | Goal domain suite `46 pass`；最终矩阵覆盖 |
| continuation `mark`/two turns | 旧 prompt 仍暴露 `status`/three-turn contract | Goal domain suite `47 pass` |
| provider-visible schema | `Parameters` 未导出；随后 description 缺 `two consecutive eligible Goal turns` | parameters suite `61 pass, 16 snapshots` |
| no-read/reason actionable rejection | 旧错误仅说明状态名或缺 reason，无合法下一步 | Goal Tool suite `11 pass` |
| Compaction lineage | expected canonical source MessageID，received `undefined` | Compaction suite `65 pass`；最终矩阵覆盖 |
| late technical chronology | expected Goal `active`，received `blocked` | Prompt goal suite通过；最终矩阵覆盖 |
| cross-connection generation | lock harness expected generation `3`，received `2` | Goal domain suite `47 pass`；最终矩阵覆盖 |
| empty-session HTTP gate | SSE expected no `busy`，received `["busy","idle"]` | HTTP Goal suite `12 pass`；最终矩阵覆盖 |
| blocked four-action guidance | pending output缺 `smaller verifiable steps` 等精确动作 | Goal Tool suite `11 pass` |
| user terminal provenance | expected terminal re-mark failure，received success/pending | Goal Tool suite `11 pass`，complete/blocked 两种 mark 均覆盖 |
| continuation full blocked contract | expected `two consecutive eligible Goal turns`，旧 prompt 只有 generic two-turn prose | Goal domain suite `47 pass` |

### 18.3 Final verification

| Command | Working directory | Result |
|---|---|---|
| `bun test test/session/goal.test.ts test/tool/goal.test.ts test/tool/parameters.test.ts test/session/compaction.test.ts test/server/httpapi-goal.test.ts test/session/prompt.test.ts test/storage/goal-migration.test.ts` | `packages/opencode` | `281 pass, 0 fail, 16 snapshots, 896 expect()` |
| `bun typecheck` | `packages/opencode` | pass (`tsgo --noEmit`) |
| `bun typecheck` | `packages/sdk/js` | pass (`tsgo --noEmit`) |
| `git diff --check` | repository root | pass |
| generated-surface diff check | repository root | `packages/sdk` 和 `packages/opencode/migration` 均无 diff |

Prompt suite 中打印的 `AI_APICallError: Service Unavailable` / `temporary reviewer outage` 来自既有可重试错误测试；命令最终为 281/0，不是未处理失败。R12 明确不改 schema/SDK，因此没有运行写入性的 generator；SDK typecheck 与 generated-surface zero diff 是对应 no-drift 证据。

### 18.4 Comment gate

- Round 1 独立口径修正 pure-move/comment classification 后，blocker 修复的最终保守上界为 `E <= 679`；仍把 formatter/wrapping 变化计入 E。
- 当前 changed Chinese comment candidates 为 124。以 Round 1 独立确认的 `C=96` 为基线，仅计入其点名的 7 条表面复述改写、stale 三轮字段合同改写、already-active 新行为测试 2 行和 active ownership/action 3 行，得到不依赖其他候选的下界 `C >= 109`。最坏要求 `ceil(679*0.15)=102`，保守比例仍至少 `16.05%`。
- 代表性注释分布在：immediate-lock 后 generation/time invariant、same-turn exact-reason baseline、terminal active-source ownership、canonical-source chronology、Compaction lineage flattening、HTTP has-user gate/failure observability、SSE readiness/session filtering、provider schema、四项 blocked guidance 和各行为测试意图。
- 无集中堆放、标识符翻译或“调用函数/返回结果”式注释计入 C。

### 18.5 Path verdict and residuals

- `APPROVED PRIMARY PATH`：read gate、two-turn exact reason、terminal ownership、atomic generation、canonical Goal-turn chronology、Compaction lineage、empty/non-empty HTTP resume 均由最终 public behavior tests证明。
- `FORBIDDEN FALLBACK ABSENT`：无 evaluator、current-row retry、第二 turn classifier、替代 loop、catch-and-success 或 test-only production injection seam。
- 未验证项：无 requirement-level 未验证项。立即取消已进入 provider 的请求和 user-user optimistic concurrency 仍是 R12 明确 non-goals。
- 工作树中的 `bun.lock`、`docs/workflow.md`、permission/model snapshot 与其他 plan 变更不属于本 Goal，不得进入后续 implementation audit diff 或 commit。
- Material change freeze：Round 1 blocker 修复和本节证据更新后不得再改变 production behavior、test assertions、file scope 或 ownership；任何后续必要 material 修复都必须按审计结论返工并再次 full-scope audit。

### 18.6 Implementation audit record

| Round | Audited revision/diff | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
|---|---|---|---|---|---|---|
| 1 | R12 implementation | yes | `B-01` already-active rejection缺合法下一步；`B-02` `blocked_streak` 注释仍写三轮；`B-03` 独立 qualifying `C=96 < 101` | none | **BLOCK** | `ses_09de5369affejeee38cXJWF0M9` |
| 2 | R12 implementation | yes | `No blocking findings.` | non-authoritative historical approval sentence remains clarity debt | **APPROVE** | `ses_09dd7c9fdffeBIeNBvOq75e63C` |

Round 1 disposition：B-01 在既有 `modelTransition` rejection owner 补充 “Continue working toward the current objective”，并在真实 Goal Tool recovery 测试中先红后绿；B-02 只把 owning schema field contract 同步为两个不同 eligible turns，不改 schema/migration；B-03 将 auditor 点名的表面复述改写为邻近 invariant/test-intent，并补 active ownership/action 的真实解释。修复后完整矩阵为 `281 pass, 0 fail, 16 snapshots, 896 expect()`，两个 package typecheck 和 `git diff --check` 均通过。

Round 2 release verdict 原文：`APPROVE`，并明确 `No blocking findings.`。独立 auditor 对完整原始需求、R12、全部 affected interface 和 exact implementation diff 重审，确认 read/reason/ownership、two-turn exact reason、四项探索指导、canonical chronology、atomic generation、HTTP loop/failure observability、usage attribution、primary-path/fallback gate和所有验证均通过；独立 E/C 结果为 `E=679`、qualifying `C=109`、required `C=102`、ratio `16.05%`。该 verdict 不包含工作树中的 `bun.lock`、`docs/workflow.md`、model snapshot、permission 或其他非本 Goal 文件，也不授权 amend、push 或跳过 hook。
