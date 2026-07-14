# Session GOAL Transition Integrity

Status: audit-required
Revision: R1
Approved revision: none
Implementation allowed: no
Audit mode: full-scope
Date: 2026-07-14

## 1. Scope and Decision

本方案只处理当前 GOAL 生命周期中已经被代码和行为测试确认的完整性缺口：

- 模型可以不读取当前 GOAL，直接写入 `complete` 或 `blocked`。
- `complete` 和 `blocked` 没有持久化、可审计的理由约束。
- `blocked`/`complete` 没有受控的模型恢复到 `active` 的路径。
- 用户编辑 objective 后，旧模型 turn 仍可能依据旧快照写入终态。
- Goal continuation、usage 归属和 HTTP/TUI Resume 没有共享同一份状态代际。

本方案不引入第二个模型、evaluator、动态 stop-condition、Goal history 表、通用工作流状态机或新的配置项。`active | paused | complete | blocked` 保持现有公开状态集合；`active` 继续表示可以被 session loop 执行。

推荐方案是把不变量收敛到三个现有 owning boundary：

1. `SessionGoal` 负责持久化 revision、理由、CAS 和跨请求原子转换。
2. `GoalTool` 负责模型 turn 内的真实 read-before-write 和模型可写状态边界。
3. `SessionPrompt` 负责每个 Goal turn 的权威上下文、stale continuation 保护、resume loop 和 usage 归属。

HTTP、TUI、OpenAPI/SDK 只传播用户控制和持久化结果，不复制 Goal 业务规则。

## 2. Requirements

| ID | 必须满足的行为 | 证据/验证 |
|---|---|---|
| REQ-01 | 模型只能在当前 Goal turn 已成功读取当前 Goal 后写入模型状态；无 Goal 或未读取时写入失败且不产生写入。 | `GoalTool` 行为测试；现有红色 harness |
| REQ-02 | `complete`、`blocked` 必须带非空、受长度限制的 reason；reason 进入持久化结果和 API/SDK 响应。 | Tool、domain、HTTP 测试 |
| REQ-03 | 模型可从 `blocked` 或 `complete` 恢复到 `active`，但只能在新的真实用户 Goal turn、先读取当前 Goal 后执行；模型不能把 `paused` 自行恢复。 | prompt/Tool 行为测试 |
| REQ-04 | objective 或用户状态变更后，旧 turn 的终态写入必须因 Goal ID/revision 不匹配而失败，不能覆盖新目标。 | 并发/CAS 测试 |
| REQ-05 | 每个 Goal turn 使用权威 objective/status/revision；continuation、compaction、错误和退出路径不能继续执行旧代际。 | prompt 集成测试 |
| REQ-06 | provider 请求已开始后发生编辑/clear，不要求立即取消 provider；但旧请求的最终写入和 usage 不能污染新 Goal。 | 时序测试 |
| REQ-07 | 用户通过 HTTP/TUI 将 terminal Goal 恢复为 `active` 后，idle session 能进入现有 prompt loop；busy session 不创建重复 loop。 | HTTP/TUI 测试 |
| REQ-08 | 当前 continue-on-error、`goal_max_turns`、permission、abort、compaction 和旧 HTTP contract 的既有安全边界继续有效。 | 回归测试和边界矩阵 |
| REQ-09 | 公开字段变更同步 OpenAPI、生成 SDK、TUI 类型和事件；不手改生成文件。 | SDK build/typecheck |

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

- `GoalUpdate.expected_goal_id` 用于防止 Goal 被替换后旧 request 错误更新/计账；这是本方案采用 Goal ID + revision CAS 的依据。
- objective 外部修改会通过 steering/运行时事件告知正在运行的 turn；本方案只借鉴“下一次 provider dispatch 使用新 snapshot”，不承诺中途取消 provider。
- usage accounting 与终态状态更新分离；本方案把 request 开始时的 expected Goal ID 传到最终计账，避免先 complete/blocked 后丢 usage。
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

## 7. First Divergence and Ownership

第一分歧不是 UI、HTTP 或 evaluator，而是 `GoalTool -> SessionGoal.set()`：模型可写入动作没有可信 read snapshot、reason、revision 或 actor boundary。

责任边界固定如下：

| 不变量 | 唯一 owner | 不能放在哪里 |
|---|---|---|
| row schema、revision、CAS、reason/audit streak | `SessionGoal` | 不能只放 prompt 或 TUI |
| 模型必须先 read、模型可写状态集合 | `GoalTool` + 本 turn context | 不能相信模型自报的 id/revision |
| 当前 turn 权威上下文、stale continuation、provider 起始 Goal snapshot | `SessionPrompt` | 不能让 HTTP handler 重复 loop 规则 |
| 用户 active resume 是否启动 idle loop | HTTP/TUI integration seam，调用 `SessionPrompt.loop` | 不能把 loop 复制到 Goal service |
| API schema、SDK 类型、TUI transport | OpenAPI/generated SDK | 不能手改 generated files |

## 8. Required State Invariants

### Goal row

保留现有稳定 `id`，新增最小字段：

- `revision`：从 `1` 开始，每个 objective 或 status/reason/audit 状态有效变更递增。
- `transition_reason`：当前 terminal 状态的最后有效理由；active/paused 可为 null。
- `blocked_reason`：当前连续 blocked 依据，或把同一字段作为 audit reason 使用；具体字段名由实现阶段按 schema 风格确定，但不能把 streak 仅留在内存。
- `blocked_streak`：同一连续 Goal turn 中相同 normalized reason 的有效 blocked 次数。
- `blocked_last_turn_id`：防止同一 turn 重复调用伪造多次。

如果审计认为 `transition_reason` 和 `blocked_reason` 可安全合并，必须证明不会丢失 terminal audit；否则保持两个字段，避免用隐式 JSON 扩展字段替代 schema。

### Model transition

- `complete` 和 `blocked` 必须携带 reason；空白 trim 后拒绝，长度上限固定在 domain 常量，避免无限 prompt/DB/API payload。
- 模型 transition 只能接受 `active`、`complete`、`blocked`；`paused` 仍是用户/system 控制状态。
- `blocked` 只有在连续三个不同 Goal turn、相同 normalized reason 且每个 turn 都基于当前 Goal read 后才成功；不足三次返回可观察的业务错误，不改变 status。
- 同一 turn 的第二次 blocked 不能增加 streak；reason 改变、Goal revision 改变、objective 编辑、clear/recreate 或 turn 中断都会清零并从 1 重新开始。
- `complete` 不需要三次 streak，但必须 reason 和当前 Goal read；写入时必须通过 ID + revision CAS。
- `blocked`/`complete -> active` 只允许新真实用户 Goal turn；必须先读取 terminal Goal；不能在同一模型 turn 中自解锁，不能从 `paused` 进入 active。
- 用户 HTTP/TUI 可以直接把 `paused`、`blocked`、`complete` 恢复为 `active`，但必须通过同一 domain set/CAS，并由 integration seam 触发 idle loop。

### Revision and CAS

- model tool 的 write 携带由本 turn `get` 产生的 trusted `{ goalID, revision }`，不是模型输入的自由字符串。
- `SessionGoal` 在同一个 SQLite immediate transaction 中重新确认 row ID/revision/objective 状态，再更新并递增 revision。
- mismatch 返回 typed stale transition error；不写 status、reason、streak，不吞错，不自动 fallback 到当前 Goal。
- HTTP/TUI 用户写入也使用 revision；若 UI 未携带 revision，先读当前 row 后按用户动作提交，冲突则返回明确 conflict，而不是覆盖。
 
## 9. Recommended Minimal Implementation

### 9.1 `SessionGoal` domain

在现有 service 内扩展，不新建 Goal manager：

1. 为 schema 增加 revision/reason/streak 所需字段和默认值；保留旧数据可读，旧 row 默认 `revision=1`、空 reason、`blocked_streak=0`。
2. 将普通用户/system `set` 保持为公开入口，但让它在 transaction 内完成目标读取、校验、更新、revision++ 和事件发布。
3. 新增一个只供模型 Tool 使用的 domain method，例如 `modelTransition`；方法接收 trusted read snapshot、turn ID、目标状态和 reason，内部重新读取并 CAS。
4. model transition 明确拒绝：缺 snapshot、snapshot id/revision 过期、`paused -> active`、同 turn 自解锁、reason 不合法、blocked streak 未达到三次。
5. `accountUsage` 增加 optional expected Goal ID；普通调用保持旧 active-only 兼容，prompt 对 provider 开始时捕获的 active Goal 使用 expected ID，row ID 不一致时跳过而不是计入新 Goal。
6. 所有跨字段更新使用 `Database.transaction` 的 immediate 行为，避免“读到旧 revision 后两个 writer 都成功”。SQLite busy/error 继续向上返回，不改成静默重试。

不增加 Goal history 表：本需求只需要当前 terminal reason 和 blocked 连续审计；完整历史不是当前真实缺口，增加它会扩大 migration、API 和清理面。

### 9.2 `GoalTool`

在现有 `GoalToolExtra` 中增加当前 Goal turn 的受信上下文，最小形状为：

```ts
goalTurn: {
  id: string
  userInitiated: boolean
  read?: { goalID: string; revision: number }
}
```

具体字段名可在实现时按现有命名调整，但必须满足以下不变量：

- `get` 读取到 Goal 后，Tool 自己把 `{ goalID, revision }` 写入 turn context；模型不能通过参数伪造该值。
- `status` 写入前必须发现该 turn context 已有 read；没有 read 直接返回业务错误，不能调用 `set`。
- `complete`/`blocked` 需要 `reason`；`active` 只允许满足 recovery 条件的模型 turn，不能把普通模型 turn 的初始 active 写入当作有效操作。
- Tool 只调用 domain `modelTransition`，不在 Tool 中实现 blocked 三轮、CAS 或 DB 更新，避免规则重复。
- Tool 输出必须包含成功后的 status/revision/reason，失败输出必须明确是未读取、stale、非法 transition、缺 reason 或 blocked 尚未达标。

`goal.txt` 继续保留给模型的目标判断和证据提示，但不再承担安全约束；prompt 文案与 runtime 拒绝规则必须一致，不能把“请记住三轮”当作唯一防线。

### 9.3 `SessionPrompt`

在 `runLoop` 已有每轮循环边界内建立 Goal turn，不抽出第二个 loop：

1. 在每次真实用户 Goal turn 或 continuation turn 开始时读取 Goal snapshot。
2. 创建新的 `goalTurn.id`；只有 `lastUser` 来源于真实用户提交时才设置 `userInitiated=true`。
3. 将当前 objective、status、revision、terminal reason 和剩余 budget 注入本轮 Goal continuation context；注入内容来自 service，不来自旧 assistant 文本。
4. 将 `goalTurn` 放入现有 Tool extra；同一 turn 的 Tool 调用共享它，下一 turn 必须新建。
5. provider dispatch 前再次确认当前 Goal revision；若 objective/status 已变更，放弃旧 continuation，重新读取并只继续新的 active Goal。
6. 用户明确 edit/clear 时，不强杀已经在 provider 内的请求；provider 返回后，任何旧 terminal write 用 CAS 拒绝，旧 usage 用 expected Goal ID 隔离。
7. 将 Goal usage accounting 放在所有 provider result 分支之前，包括 structured output、normal stop、terminal error 和 abort cleanup 能提供 message usage 的路径；只有 provider 开始时捕获 active Goal ID 的请求使用 expected ID 计入。
8. 保持 `goal_max_turns=0`、continue-on-error、abort、compaction 和现有 permission 行为；新增的 revision check 只阻止 stale continuation，不改变正常 active continuation 的上限。

### 9.4 HTTP/TUI Resume

在现有 HTTP handler 与 `SessionPrompt` 注入之间增加一个小的 integration seam，不把 loop 代码复制到 Goal service：

- 读取 mutation 前后的状态；只有 transition 造成 `non-active -> active` 且 session 当前 idle 时才 fork 一个 `SessionPrompt.loop`。
- busy 时不 fork 第二个 loop；复用 `RunState` 现有互斥/加入行为。
- `active -> active`、objective-only edit、clear、pause 或 stale conflict 不启动新的 loop。
- fork 失败通过现有 session error/log path 暴露；不把 HTTP 200 当作 loop 已成功执行。
- TUI 改为使用 generated SDK contract；在 SDK 生成前不手写新的 transport type，也不在 sync 层复制状态规则。

### 9.5 OpenAPI and SDK

同步公开 Goal response/request：

- `revision`、`transition_reason`/当前 reason、必要的 blocked audit 信息只公开确实需要给客户端展示/冲突处理的字段。
- model-only read token、内部 `goalTurn.id`、provider expected ID 不公开为用户 API 字段。
- HTTP conflict、invalid transition、missing reason 使用现有错误 contract 体系，不添加未被现有客户端消费的自由错误格式。
- 修改 OpenAPI source 后运行 `./packages/sdk/js/script/build.ts`；只接受 generator 产生的 `packages/sdk/js/src/v2/gen/sdk.gen.ts`、`types.gen.ts` 及实际受影响的 generated siblings。
- TUI 删除 raw `fetch` 和重复 Goal response 类型，改用 SDK；生成链完成后运行 SDK typecheck。

## 10. Existing Logic to Replace or Remove

本方案不是在现有逻辑旁边叠加兼容分支，以下旧行为必须收敛：

| 旧逻辑 | 处理 |
|---|---|
| `GoalTool` 直接把可选 `status` 传给 `goalSvc.set` | 替换为 read-gated `modelTransition`，删除无 reason/无 snapshot 的写路径 |
| `goal.txt` 单独要求模型记住三轮 blocked | 保留解释性文本，删除其作为唯一约束的含义；runtime/domain 成为唯一强制路径 |
| `SessionGoal.set` 允许所有调用者无 revision 覆盖 | 收敛为 transaction/CAS；用户/system 与 model 使用明确不同入口 |
| `accountUsage` 只看当前 row status | 保留旧调用兼容，同时让 prompt 使用 expected Goal ID；删除按 session ID 无条件归属的路径 |
| HTTP/TUI Resume 只写 `active` | 写成功后调用统一 idle-loop integration seam；不在 TUI 增加另一套 loop |
| TUI raw fetch/手写 Goal type | SDK 生成完成后删除重复 transport 代码 |
| 旧 prompt continuation 只看 status/turn count | 增加 revision/snapshot guard；不增加 evaluator fallback |

不删除 `docs/goal-error-continuation-control-plan.md` 的历史设计；实现后只在必要处增加“revision/usage 规则已由本方案 supersede”的链接，避免读者把旧 best-effort 描述当成新不变量。

## 11. Traceability: Requirement to Code and Test

| Req | Production owner | 行为测试 | 当前红色缺口 |
|---|---|---|---|
| REQ-01 | `tool/goal.ts`, `session/goal.ts` | GoalTool 无 read 不能 write；read 后可 write | 当前 `get=0,set=1` |
| REQ-02 | `tool/goal.ts`, `session/goal.ts`, API schema | 空 reason、超长 reason、complete/blocked 持久化 | 当前无 reason 参数 |
| REQ-03 | `tool/goal.ts`, `session/prompt.ts` | blocked/complete 新用户 turn 恢复；同 turn/paused 拒绝 | 当前不存在模型 active recovery contract |
| REQ-04 | `session/goal.ts`, migration | objective edit/clear/recreate 后 stale write 被拒绝 | 当前无 revision/CAS |
| REQ-05 | `session/prompt.ts`, `message-v2.ts` | continuation 使用最新 objective；compaction 不复活旧 snapshot | 当前没有 Goal revision 注入 |
| REQ-06 | `session/prompt.ts`, `request-usage` | edit/clear 与 provider 完成竞态；旧 usage 不污染新 Goal | 当前按 session/current status 归属 |
| REQ-07 | HTTP handler、run-state、TUI sync | idle resume 启动一次；busy resume 不重复启动 | 当前 handler 只写 DB |
| REQ-08 | prompt/processor/selection | continue-on-error、max turns、abort、permission、terminal error 回归 | 既有测试未覆盖新 revision 边界 |
| REQ-09 | OpenAPI、SDK、TUI | generated client 调用和 typecheck | 当前 SDK v2 缺 Goal schema/method |

### Reverse traceability

- 每个新增 production branch 必须关联上表至少一个 REQ 和一个失败前置测试；没有需求映射的 helper、字段、API 或 migration 不加入 diff。
- 每个新增字段必须有：schema/migration 默认值测试、service round-trip 测试、API/SDK 是否公开的明确结论。
- 每个新增错误必须有调用方断言其“无写入/不启动 loop/不计 usage”的行为，不能只断言错误字符串。

## 12. Concurrency and Failure Matrix

| 场景 | 预期结果 | 防线 |
|---|---|---|
| 两个 model tool writes 同一 revision | 一个成功，一个 stale；只有一个 event/revision++ | immediate transaction + CAS |
| 用户 edit 与 model complete 同时发生 | 以 transaction 先后为准；旧 snapshot 失败，不覆盖新 objective | Goal ID + revision |
| clear 后 recreate 同 session | 旧 provider usage 不记入新 row；旧 terminal write 失败 | expected Goal ID + revision |
| 用户 pause 在 provider 执行中 | 不取消 provider；返回后不自动继续，usage 仍计入 provider 起始 Goal | initial expected ID + current paused status |
| 用户 resume blocked/complete，session idle | 一次 fork loop，进入 active continuation | handler integration seam + RunState |
| 用户 resume 时 session busy | 不 fork 第二 loop；现有运行完成后由状态/事件收敛 | RunState mutex |
| model 在同 turn `blocked` 后 `active` | active transition 拒绝；blocked audit 不被绕过 | `goalTurn.id` + userInitiated |
| model 从 paused 写 active | 拒绝；必须用户/system resume | actor boundary |
| blocked reason 改变 | streak 清零，从新 reason 第一次开始 | normalized reason + revision |
| 同一 blocked reason 重复 tool call | streak 不增加 | last turn ID |
| provider error/abort | 按现有 error/abort 结束；若有 usage 则按 expected ID 计入；不自动把失败伪装成 complete | prompt accounting ordering |
| compaction 期间 objective 改变 | synthetic continuation 使用最新 revision；旧 summary 不能覆盖 | snapshot before dispatch |
| GoalTool 被 permission 禁用 | 保持现有工具选择行为；不新增绕过 permission 的写入口 | `ToolSelection.enabled` |
| DB busy/transaction failure | 向上返回错误，不静默 fallback、不重复写 | existing Effect error path |
| 进程重启后 blocked streak | 从持久化字段恢复；不依赖内存 | schema fields |
| 旧 row 无新增字段 | 默认值可读，第一次有效更新补齐 revision | migration default/backfill |

## 13. TDD Implementation Slices (Future, Not Authorized Now)

实现获批后严格按以下垂直切片，不先改生产代码：

### Slice A: Domain schema and model transition

- 先补 `test/session/goal.test.ts`：无 snapshot、stale revision、reason validation、complete/blocked CAS、paused boundary。
- 当前实现必须红：无 modelTransition、无 reason/revision。
- 再改 `goal.sql.ts`、migration、`goal.ts`；运行 migration/round-trip tests。

### Slice B: GoalTool read gate and recovery

- 新增 `test/tool/goal.test.ts`，通过真实 Tool public seam 断言 read count/write count、输出和持久化状态。
- 覆盖 no Goal、read then complete、read then blocked streak 1/2/3、same turn duplicate、terminal recovery、paused rejection、invalid reason。
- 当前红色 harness 固定为回归测试，不能改成源码结构断言。

### Slice C: Prompt turn context and stale continuation

- 扩展 `test/session/prompt.test.ts`，使用 readiness/poll，不用 fixed sleep。
- 覆盖 objective edit/clear 与 continuation/provider completion 的时序、最新 revision 注入、旧 transition 拒绝、compaction 和 max turns。
- 再改 `prompt.ts`，保持 processor/abort 现有语义。

### Slice D: Usage and terminal/error paths

- 补 normal stop、structured output、tool error、provider error、abort、pause/clear race 的 Goal usage 行为测试。
- 断言旧 Goal ID 归属、不污染新 Goal、terminal status 不丢失已开始 request 的 usage。

### Slice E: HTTP/TUI user resume

- 扩展 `test/server/httpapi-goal.test.ts` 和必要的 run-state integration test。
- 断言 idle 只启动一次、busy 不重复、stale conflict 不启动、user pause/resume 与 model recovery 分离。
- 再改 handler/TUI sync；不在测试中 mock 自己实现的 Goal rules。

### Slice F: Contract, generated SDK and compatibility

- 先更新 OpenAPI source/schema tests，再运行 SDK generator。
- 断言 generated SDK 能读写新字段，TUI 不再依赖重复 raw fetch type。
- 运行 storage migration tests、opencode typecheck、SDK typecheck 和完整相关测试。

## 14. Expected File Scope and Diff Budget

### Expected modified/added files

| 文件 | 预计动作 | 预计有效增量 | 原因 |
|---|---|---:|---|
| `packages/opencode/src/session/goal.sql.ts` | 修改 | +10~25 | revision/reason/streak schema |
| `packages/opencode/src/session/goal.ts` | 修改 | +120~220/-30~60 | CAS、model transition、usage expected ID |
| `packages/opencode/src/tool/goal.ts` | 修改 | +60~120/-15~35 | read gate、reason、recovery boundary |
| `packages/opencode/src/tool/goal.txt` | 修改 | +15~30/-5~15 | 与 runtime 规则对齐的模型说明 |
| `packages/opencode/src/session/prompt.ts` | 修改 | +100~180/-20~50 | GoalTurn、snapshot、usage ordering、resume guard |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 修改 | +25~70 | user resume idle-loop seam、conflict/error mapping |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | 修改 | +10~40 | request/response/OpenAPI fields |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | 修改 | +10~40/-20~60 | generated SDK transport、reason/conflict display |
| `packages/opencode/src/cli/cmd/tui/context/sync.tsx` | 修改 | +10~35/-15~45 | generated response/event reconcile |
| `packages/opencode/migration/<generated-session-goal-revision>/migration.sql` | 新增 | +15~35 | schema default/backfill |
| `packages/opencode/test/session/goal.test.ts` | 修改 | +100~220 | domain behavior |
| `packages/opencode/test/tool/goal.test.ts` | 新增 | +100~220 | public Tool behavior |
| `packages/opencode/test/session/prompt.test.ts` | 修改 | +120~260 | turn/continuation/usage races |
| `packages/opencode/test/server/httpapi-goal.test.ts` | 修改 | +70~160 | HTTP/resume behavior |
| `packages/opencode/test/storage/goal-migration.test.ts` | 修改 | +20~60 | migration compatibility |
| `packages/sdk/openapi.json` | 生成/必要源更新 | generator-dependent | public contract |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | 生成 | generator-dependent | Goal methods |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | 生成 | generator-dependent | Goal types |

### Budget and scope guard

- 预计生产/contract 文件约 10~12 个，测试约 5 个，migration 1 个，generated SDK 2 个主要文件；总有效新增约 700~1,400 行，删除约 150~350 行，最大不超过 18 个文件，除非 generator/审计证明必要。
- 预期没有新的 dependency、独立 Goal history 表、全仓库重命名或 unrelated formatting。
- 如果实现中发现需要超过上述范围，必须先增加 canonical plan revision 并重新 full-scope audit，不能在 implementation 阶段自行扩张。
- 中文解释性注释预算：生产新增/修改有效行预计 450~900，至少 70~150 行分布在 CAS、streak、usage attribution、resume race、migration default、错误边界附近；测试新增有效行预计 450~900，至少 70~150 行说明每个行为断言保护的回归边界。生成文件不手写注释，也不计入手工注释预算。

## 15. Verification Commands

实现获批后建议按窄到宽执行：

```bash
# from packages/opencode
bun test test/session/goal.test.ts test/tool/goal.test.ts test/server/httpapi-goal.test.ts test/storage/goal-migration.test.ts --filter goal
bun test test/session/prompt.test.ts --filter goal
bun typecheck

# after OpenAPI source changes, from repository root
./packages/sdk/js/script/build.ts

# from packages/sdk/js, using the package's existing scripts/typecheck
bun typecheck

# final focused and repository hygiene checks
bun test test/session/goal.test.ts test/tool/goal.test.ts test/server/httpapi-goal.test.ts test/session/prompt.test.ts test/storage/goal-migration.test.ts
git diff --check
```

当前阶段只运行了既有相关测试和 `bun typecheck`，没有运行生成、migration 或任何写入性实现命令。

## 16. Risks and Open Questions

### Resolved by this plan

- 不新增 `in_progress`：现有 `active` 已表达可执行状态，避免状态集合膨胀。
- 模型恢复 `complete/blocked` 只允许新真实用户 Goal turn；`paused` 保持用户/system-only。该选择直接保护“模型不能自己绕过用户暂停”的边界。
- blocked streak 使用持久化的 normalized reason + Goal turn ID；不使用时间窗口或第二模型判断，减少不可重放因素。
- provider 中途不强制取消；用 dispatch snapshot、CAS 和 expected Goal ID 保护后续写入/usage，避免引入新的 cancellation protocol。

### Must be addressed by implementation/audit

- `transition_reason` 与 `blocked_reason` 是否可以合并：必须由 schema/API/历史可读性证明，不能为了少一个字段丢失审计语义。
- `GoalTurn.id` 使用哪个现有 message/request identifier：必须选当前 session loop 已有稳定 ID，不能用 Date.now 或随机值造成测试/重启不确定性。
- HTTP 用户 mutation 是否要求 client 携带 revision：推荐兼容无 revision client，server 先读后 CAS；但 stale conflict 必须可观察，不能无条件覆盖。
- SDK generator 是否会改动 `core/*.gen.ts`：以实际 generator diff 为准；若改动与 Goal 无关，必须回退并记录原因，不能扩大提交。
- 现有旧 Goal rows 的 blocked 语义没有历史 streak：migration 默认从 0 开始；旧 terminal row 恢复 active 后再按新规则累计，不伪造历史三轮。
- permission 禁用 GoalTool 时 continuation 的既有行为是否需要额外停止：本方案不新增绕过 permission 的路径；如果 audit 证明会造成 runaway cost，必须在 revision 中加入明确 guard 和回归测试。
- provider 已开始后 objective 修改仍可能让一次请求基于旧 objective 消耗 token；这是本方案明确承认的残余风险，若产品要求“立即取消”，应另立需求而不是隐式扩大本方案。

没有需要当前用户做产品选择的阻塞问题；上述选择均来自用户明确要求和当前仓库既有边界。任何 auditor 证明的行为级风险必须先回到本方案修订，不得在实施时临时决定。

## 17. Audit Record

本方案由当前调研建立，尚未获得独立 auditor 放行：

| revision | auditor | result | blocking findings | disposition |
|---|---|---|---|---|
| R1 | pending | pending | pending | implementation forbidden |

审计要求：subagent 必须从仓库和本文件独立重建 full scope，检查行为、依赖、并发、错误、退出、清理、生成、兼容、安全和 15% 中文注释预算；不能只检查摘要或选定文件。若存在任意 blocking finding，新增 R2+ 并重新审计完整范围。
