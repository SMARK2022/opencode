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
