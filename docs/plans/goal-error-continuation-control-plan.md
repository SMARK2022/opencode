# GOAL 错误后续跑控制设计

## 1. 目标

为持久化 Session GOAL 增加一个由用户控制的策略：当一次模型调用以可识别的终止错误结束时，用户可以决定当前 active GOAL 是否自动创建下一次 continuation。

该策略必须满足以下目标：

- 默认保持当前行为，错误发生后停止，不自动续跑。
- 用户可以在现有 `Manage Goal` 对话框中以勾选项开启或关闭。
- 配置属于单个 Session GOAL，并跨 TUI 重连、daemon 重启和进程重启持久化。
- 不改变同一次 provider 请求内部的既有重试机制。
- 不把 provider 错误内容重新注入模型上下文。
- 错误续跑与正常 GOAL 续跑共享现有次数上限和安全约束。
- 修改集中在既有模块中，不新增手写业务模块，不引入第二套状态机。

本文档是本需求唯一的设计与实施依据，不再创建补充设计、解释性修订或独立审计文档。

## 2. 调研范围与依据

### 2.1 已阅读的实现

本设计基于以下现有实现建立：

- `packages/opencode/src/session/prompt.ts`
  - prompt loop、processor outcome、GOAL continuation、`goalTurns`、`goal_max_turns`、compaction 和退出路径。
- `packages/opencode/src/session/processor.ts`
  - provider stream、错误重试、终止错误持久化和 `stop` 返回。
- `packages/opencode/src/session/retry.ts`
  - 同一次 provider 请求内部的 retry 分类和退避策略。
- `packages/opencode/src/session/message-v2.ts`
  - provider error 转换、assistant error schema，以及 errored assistant 从后续 model messages 中排除的行为。
- `packages/opencode/src/provider/error.ts`
  - structured stream error 和 API error 分类。
- `packages/opencode/src/session/goal.ts`
  - GOAL domain interface、状态、持久化映射、usage 和 continuation prompt。
- `packages/opencode/src/session/goal.sql.ts`
  - `session_goal` 表及 session 级唯一约束。
- `packages/opencode/src/config/config.ts`
  - 顶层 `goal_max_turns` 配置。
- `packages/opencode/src/tool/goal.ts`
  - 模型可执行的 GOAL 读取和 `complete/blocked` 更新范围。
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
  - GOAL HTTP contract 和 OpenAPI schema。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
  - GOAL payload 到 domain service 的显式映射。
- `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx`
  - `Manage Goal` 菜单和 GOAL HTTP 调用。
- `packages/opencode/src/cli/cmd/tui/component/dialog-tool.tsx`
  - `✓ Enabled`、`○ Disabled`、保存状态和防重复点击交互。
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
  - GOAL 初始同步、SSE 更新和 TUI store 类型。
- `packages/opencode/src/cli/cmd/tui/app.tsx`
  - `/goal` 和 `/tools` 命令入口。
- `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/goal.tsx`
  - sidebar GOAL 状态展示。
- `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx`
  - footer active/blocked 状态展示。
- `packages/sdk/js/script/build.ts`
  - OpenAPI 和 JavaScript SDK 生成链。
- `packages/opencode/migration/20260704053848_session_goal/migration.sql`
  - GOAL 初始数据库迁移。

### 2.2 已阅读的测试

- `packages/opencode/test/session/goal.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/processor-effect.test.ts`
- `packages/opencode/test/session/retry.test.ts`
- `packages/opencode/test/server/httpapi-goal.test.ts`
- `packages/opencode/test/storage/workspace-time-migration.test.ts`
- `packages/opencode/test/storage/json-migration.test.ts`

这些测试确认了 domain service、prompt/processor 集成、provider retry、HTTP contract、数据库迁移和 Effect 测试的现有组织方式。

### 2.3 数据库证据

对 `/Users/sunbenteng/Project/opencode/.temp/testing/opencode.db` 的只读查询发现 10 条 `cyber_policy` 错误。其共同特征是：

- `request_usage.status = "error"`。
- `request_usage_assistant.status = "error"`。
- assistant error 落为 `UnknownError`。
- assistant 没有 `finish`。
- 错误不属于 tool part error。
- 相关 session 没有由错误触发的 `source="system_continue"` 消息。
- 错误后的后续调用由新的真实 user message 发起。

这些记录发生在 GOAL 功能加入之前，因此只用于确认错误形态和终止行为。当前代码调用链用于确认该错误形态在现有 GOAL 中同样会终止 prompt loop。

## 3. 当前行为

当前错误终止链如下：

1. provider 返回错误或 stream 抛出错误。
2. `SessionRetry` 先处理被判定为 retryable 的错误。
3. retry 未发生、不能发生或最终仍失败时，`SessionProcessor.halt()` 写入 `assistant.error`。
4. `SessionProcessor.process()` 返回 `"stop"`。
5. `SessionPrompt.runLoop()` 将该结果收敛为 `"break"` 并退出。
6. 正常 GOAL continuation 要求 assistant 存在 `finish` 且没有 `error`，因此错误 assistant 不会触发 continuation。

当前系统存在两层不同机制：

- `SessionRetry` 负责同一次 provider 请求内部的瞬时重试。
- GOAL continuation 负责一个 assistant turn 结束后创建新的 synthetic user turn。

本需求只扩展 GOAL continuation，不修改 `SessionRetry`。

## 4. 设计原则

### 4.1 策略归属

错误后续跑策略属于单个持久化 GOAL，而不是全局配置、TUI 本地偏好或 provider retry 配置。

原因如下：

- 只有 active GOAL 使用该策略。
- 不同 session 的成本和风险不同。
- 用户在 `/goal` 中管理该策略符合现有交互模型。
- daemon 必须在没有 TUI 本地状态参与时作出续跑决策。
- GOAL 已经是 objective、status、budget 和 usage 的持久化所有者。

### 4.2 默认兼容

新增字段默认值必须为 `false`。旧数据库行迁移后得到 `false`，旧客户端省略字段时保持已有值，升级后所有现有 GOAL 的行为不变。

### 4.3 单一续跑入口

正常完成和错误终止最终都使用现有 GOAL continuation 注入入口。错误路径只负责证明此次重新进入 loop 的来源，不创建第二套 prompt、计数器或 continuation 实现。

### 4.4 不传播错误内容

错误内容不进入 GOAL continuation prompt。实现不读取、截断、转义或重放 `error.data.message`，也不增加 `<previous-error>` 等 prompt 字段。

该决定保持 `SessionGoal.continuationPrompt(goal)` 的现有 interface 和文本不变，避免新增外部错误数据注入面。

## 5. 数据模型

### 5.1 Domain 字段

`SessionGoal.Goal` 增加：

```ts
continueOnError: boolean
```

`SessionGoal.SetInput` 增加：

```ts
continueOnError?: boolean
```

字段语义：

- `false`：eligible terminal error 后退出 prompt loop。
- `true`：eligible terminal error 后允许 GOAL continuation 决策。
- 更新时省略：保留数据库中的现有值。

模型的 `goal` tool 不增加该字段。模型仍只能读取 GOAL，或将其标记为 `complete/blocked`。开启和关闭策略只能由用户或显式 HTTP 调用完成。

### 5.2 数据库字段

`SessionGoalTable` 增加 SQLite boolean：

```ts
continue_on_error: integer({ mode: "boolean" }).notNull().default(false)
```

迁移应由 Drizzle 生成，语义等价于：

```sql
ALTER TABLE `session_goal`
ADD `continue_on_error` integer DEFAULT false NOT NULL;
```

domain 映射要求：

- `fromRow()` 返回 `continueOnError`。
- 新建 GOAL 使用 `input.continueOnError ?? false`。
- 更新已有 GOAL 时，只在 input 提供字段时写入。
- objective、status、budget 和 usage 的局部更新不得重置该字段。

## 6. HTTP 与同步契约

`GoalSetPayload` 增加可选 boolean：

```ts
continueOnError?: boolean
```

HTTP handler 将其显式传递给 `SessionGoal.set()`。GET、POST response 和 `session.goal.updated` event 通过 `SessionGoal.Goal` schema 返回该字段。

以下行为必须保持：

- 非 boolean 值由 schema 拒绝。
- missing session 仍返回 404。
- domain `GoalError` 的 wire body 保持不变。
- 旧客户端省略字段时不重置策略。
- DELETE GOAL 和删除 session 的级联清理行为不变。

TUI sync store 的 Goal 类型必须显式包含 `continueOnError`。不能在 dialog 中使用 `as any`、重复 shadow state 或未持久化的本地 override 绕过类型链。

成功 POST 的 response body 是本次切换的权威结果。`sync.tsx` 应在现有 sync context 中提供一个仅用于接收完整 Goal response 的 reconcile 操作，由其内部 `setStore` 更新对应 `session_goal`；dialog 不直接持有 store setter，也不创建第二份策略状态。SSE 继续负责其他客户端和后续事件同步，但当前 dialog 不等待 SSE 才显示成功结果。

## 7. Prompt Loop 控制流

### 7.1 显式 outcome

当前局部 `"break"` 同时表示 provider error、structured output、compaction stop 和其他退出路径，不能直接作为错误续跑依据。

内层 prompt processing outcome 应局部收敛为：

```ts
"continue" | "break" | "terminal-error"
```

分类规则：

- `handle.process()` 返回 `"stop"`，且当前 assistant error 属于 eligible allowlist 时，返回 `"terminal-error"`。
- structured output 成功或失败仍返回 `"break"`。
- preflight compaction 和 overflow compaction 的 stop 仍返回 `"break"`。
- abort、auth、context overflow、output length 和其他非 eligible error 仍返回 `"break"`。
- tool continuation 和正常未完成步骤仍返回 `"continue"`。

eligible error allowlist 第一版固定为：

```text
APIError
UnknownError
```

选择 `UnknownError` 是因为数据库中真实的 `cyber_policy` 错误当前落为该类型。它也可能包含本地未分类错误，因此必须同时受用户 opt-in 和现有 GOAL 上限约束。

实现只定义一个未导出的精确 predicate，并在产生 `"terminal-error"` 和消费 marker 两处复用：

```ts
MessageV2.APIError.isInstance(error) || NamedError.Unknown.isInstance(error)
```

不得通过 error truthiness、错误消息文本、HTTP status 范围或排除式判断代替该 allowlist。

明确排除：

```text
MessageAbortedError
ContextOverflowError
ProviderAuthError
StructuredOutputError
MessageOutputLengthError
```

### 7.2 一次性来源标记

当 outcome 为 `"terminal-error"` 时：

1. 读取当前持久化 GOAL。
2. GOAL 不存在、非 active 或 `continueOnError=false` 时，直接退出。
3. 条件满足时，设置一次性 marker 并重新进入 while loop。

marker 只保存：

```ts
{
  assistantID: string
}
```

marker 不保存 error object、error name 或 error message。

下一次 iteration 开头将共享 marker 复制到 iteration-local 常量，并立即清空共享值。只有 marker 的 `assistantID` 与 latest assistant ID 匹配，且 latest assistant error 再次通过同一个精确 allowlist predicate 时，才允许该无 `finish` 的 errored assistant 进入 GOAL continuation 决策。

该不变量确保：

- 历史 error 不会在新的 runLoop 中触发续跑。
- structured output 和 compaction break 不会触发续跑。
- marker 在资格检查失败后不会残留。
- maxSteps 和 maxGoalTurns 退出后不会恢复旧 marker。
- errored assistant 仍然不会作为 assistant content 进入 model messages。

### 7.3 统一 continuation 决策

现有 continuation block 接受两种来源：

- 现有的正常完成 assistant。
- 与一次性 marker 匹配的 eligible terminal error assistant。

两种来源共同执行以下检查：

- `goal_max_turns > 0`。
- 主 session，无 `parentID`。
- `goalTurns < goal_max_turns`。
- GOAL 存在且为 active。
- agent 存在。
- agent 不是 decide agent。
- `step < agent.steps`，未配置时为 Infinity。

通过后执行现有逻辑：

- `goalTurns++`。
- 注入 `source="system_continue"` 的 synthetic user message。
- prompt 内容继续使用未经修改的 `SessionGoal.continuationPrompt(goal)`。
- 进入下一次 loop iteration。

达到 `goal_max_turns` 时，继续按现状将 active GOAL 改为 paused。

达到 agent `maxSteps` 时，继续保持现有行为：本次 loop 退出，但 GOAL 仍为 active。不得只为错误续跑改变该状态语义。

## 8. GUI 设计

现有 `DialogGoalMenu` 增加一个原地切换选项：

```text
✓ Continue after errors    Enabled
```

关闭时显示：

```text
○ Continue after errors    Disabled
```

交互复用 `DialogTool` 的既有模式：

- enabled 使用 success 色和 `✓`。
- disabled 使用 muted 色和 `○`。
- 保存中显示 `⋯ Saving`。
- loading 期间阻止重复切换。
- 点击或选择该行切换当前值。
- HTTP 成功后该菜单保持打开。
- Edit、Pause、Resume 和 Clear 继续按现状关闭菜单。
- HTTP 失败显示 toast，并清理 loading。
- 不做 optimistic update。
- HTTP 成功后解析完整 Goal response，先通过 sync context reconcile 到 `session_goal` store，再结束 loading。
- SSE 继续作为跨客户端和后续变更同步来源，但不是本次点击解除 loading 的前置条件。

现有 `useGoalApi.setGoal()` 成功后会无条件关闭 dialog。实现应让该 helper 返回解析后的 Goal，并增加一个最小的 close policy；toggle 调用方把 response 交给 sync context reconcile 后保持菜单打开。Edit、Pause、Resume 和 Clear 保留既有关闭语义，不复制 fetch、directory routing 和错误处理逻辑。

GUI 文案使用 `Continue after errors`，不使用 `Retry provider request`。该行为创建新的 GOAL continuation turn，并不是重放同一个 provider HTTP 请求。

## 9. 必须保持的既有行为

- 新字段默认 false。
- 正常成功结束继续自动 continuation。
- `goal_max_turns=0` 完全禁止 continuation。
- 达到 `goal_max_turns` 后 active GOAL 自动 paused。
- 达到 agent `maxSteps` 后 GOAL 保持 active。
- 子 session 不自动 continuation。
- decide agent 不自动 continuation。
- paused、blocked 和 complete GOAL 不 continuation。
- 用户 Abort 不自动恢复。
- context overflow 继续交给 compaction。
- retryable provider error 继续先由 `SessionRetry` 处理。
- 模型不能修改 `continueOnError`。
- objective、usage、budget、goal ID 和创建时间在局部更新中保持。
- session 删除继续级联删除 GOAL。
- 正常和错误 continuation 共用同一个 `goalTurns`。
- continuation prompt 文本和 interface 保持不变。

## 10. 并发、退出与清理

该设计维持现有 GOAL continuation 的 best-effort 并发语义：

- Pause 或 Clear 在 continuation 决策读取之前提交，本次 injection 被抑制。
- Pause 或 Clear 在读取之后提交，可能仍多写入一个 synthetic continuation message。
- 不宣称 GOAL 读取和 synthetic message injection 是原子操作。
- 本次不增加 CAS、revision、continuation claim 或 dispatch 前版本检查。

一次性 marker 属于单个 `runLoop` 的局部状态：

- loop 退出后自然释放。
- 新 runLoop 不继承。
- 不需要数据库字段或显式 finalizer。
- marker 在 iteration 开头消费，避免资格失败后残留。

若未来要求“Pause 提交后绝不再启动 provider”，应作为独立需求设计原子 claim 或 dispatch 前二次校验，不在本次改动中叠加。

## 11. Usage 与预算边界

当前 prompt loop 在 processor 返回 `stop` 后先退出，再执行正常 GOAL usage accounting。因此终止错误请求可能不会累加到 `tokensUsed`。

本次保持该既有行为，不移动 accounting，不引入 assistant 去重或失败 usage 补记，以避免扩大改动和产生重复计费风险。错误自动续跑的实际安全上限由 `goal_max_turns` 提供，而不是 token budget。

该限制应在实现注释或测试名称中准确表达，但不新增独立文档。

## 12. 文件变更计划

### 12.1 手写源码

端到端持久化和 GUI 控制最少需要修改以下 7 个既有源码文件：

1. `packages/opencode/src/session/goal.sql.ts`
   - 增加 `continue_on_error`。
2. `packages/opencode/src/session/goal.ts`
   - 增加 schema、input、DB mapping、create/update 处理。
   - 不修改 continuation prompt。
3. `packages/opencode/src/session/prompt.ts`
   - 增加显式 `terminal-error` outcome、一次性 marker 和统一 continuation 判断。
4. `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
   - 增加 HTTP payload boolean。
5. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
   - 显式传递 boolean。
6. `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx`
   - 增加 toggle、loading 和保留 dialog 的提交路径。
7. `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
   - 更新 GOAL store 类型或采用生成后的 typed Goal。

7 个文件是当前分层下的最小完整集合。强制压缩为 6 个会导致字段被 handler 丢弃、HTTP schema 不接受、TUI 使用 cast，或产生重复的未持久化状态。

不新增手写 production module，不大幅重写已有文件。手写源码预计修改 120 至 240 行，保守上限低于 450 行。

### 12.2 测试文件

修改 3 个既有测试文件，并新增 1 个职责单一的 migration compatibility 测试文件：

1. `packages/opencode/test/session/goal.test.ts`
2. `packages/opencode/test/server/httpapi-goal.test.ts`
3. `packages/opencode/test/session/prompt.test.ts`
4. `packages/opencode/test/storage/goal-migration.test.ts`

新增 migration 测试是验证旧 `session_goal` 行升级兼容性的必要例外；把该场景并入 JSON migration 或 workspace time migration 会混淆测试职责。仍不新增 TUI test harness。预计测试修改 180 至 340 行，测试文件总数保持在用户允许的 6 个以内。

### 12.3 生成文件

必须生成：

- 一个新的 migration 目录，包含 `migration.sql` 和 `snapshot.json`。
- 受 OpenAPI schema 变化影响的 `packages/sdk/js/src/v2/gen/**` 文件。

迁移和 SDK 文件属于必要生成产物，单独审查，不计入手写业务代码行数。若 SDK regeneration 产生大量无关变动，必须调查 generator drift，不能静默省略 public contract 生成结果。

SDK diff 的通过标准不是“生成命令成功”本身，还必须确认：

- Goal response 和 `session.goal.updated` event 类型包含 `continueOnError`。
- Goal set payload 包含可选 `continueOnError`。
- 生成客户端包含 `goal`、`goalSet` 和 `goalClear` 方法。
- 没有意外删除或重命名无关 endpoint。

不创建第二份设计、审计、迁移解释或测试说明文档。

## 13. 行为级测试计划

### 13.1 Domain 测试

在 `test/session/goal.test.ts` 覆盖：

- 新 GOAL 默认 `continueOnError=false`。
- 创建时设置 true 后可读取。
- 单独切换 true 和 false。
- objective 更新保留该字段。
- Pause、Resume、complete 和 blocked 更新保留该字段。
- usage accounting 不改变该字段。
- 旧字段行为和 continuation prompt 输出不变。

### 13.2 HTTP 测试

在 `test/server/httpapi-goal.test.ts` 覆盖：

- POST 创建 true，GET 返回 true。
- POST 只更新 boolean，不改变 objective/status/usage。
- POST 省略字段时保留现值。
- 默认返回 false。
- 字符串 `"true"`、数字 `1` 等非 boolean payload 被 schema 拒绝。
- missing session 仍返回 404。
- 现有 `GoalError` wire body 不回归。

### 13.3 Prompt Loop 集成测试

在 `test/session/prompt.test.ts` 分两层验证，不宣称所有 typed error 都能由 HTTP TestLLMServer 自然产生。

使用现有 TestLLMServer 和真实 prompt/processor 链覆盖：

- 默认 false 时，一个 cyber-like `UnknownError` 后退出，只调用一次 provider，不生成 `system_continue`。
- 开启 true 时，一个 eligible terminal error 后生成一条标准 `system_continue`。
- synthetic continuation prompt 不包含 provider error message。
- `APIError` 和 `UnknownError` 可以触发。
- Abort 不触发。
- ContextOverflow 继续进入 compaction，不触发该分支。
- successful structured output 不触发。
- compaction stop 不触发。
- normal successful GOAL continuation 不回归。
- 连续 eligible errors 产生恰好 `goal_max_turns=N` 条 continuation message，随后 GOAL paused。
- 原始 user 请求不计入 `goalTurns`。
- 在决策读取前将 GOAL Pause 或 Clear，可以确定性抑制 injection。

对 TestLLMServer 无法自然构造的错误，使用 `prompt.test.ts` 内的 test-only `SessionProcessor.Service` layer 注入一个最小 processor handle，使 `process()` 返回 `"stop"` 并持久化指定的 schema error。该 layer 只替换 processor seam，不增加 production hook，并覆盖：

- `ProviderAuthError` 不产生 `terminal-error` continuation。
- `StructuredOutputError` 不产生 `terminal-error` continuation。
- `MessageOutputLengthError` 不产生 `terminal-error` continuation。
- `MessageAbortedError` 即使由 processor stop 返回也不产生 continuation。

marker ID 匹配是 loop 内部的一次性 provenance 不变量，不为其新增 production seam。通过 test-only processor layer 配合 `Deferred` 或 Bus latch，在 terminal error 产生后、下一 iteration 读取 latest assistant 前持久化一个更新的 assistant，验证旧 marker 不会授权该更新后的 assistant。该测试必须使用已发布同步信号，不使用 wall-clock sleep。

并发测试统一使用 mock LLM 请求计数、Deferred、Latch、Bus event 或现有等待 helper，不使用固定 sleep。

### 13.4 Migration Compatibility 测试

新增 `test/storage/goal-migration.test.ts`，复用 `workspace-time-migration.test.ts` 的按 timestamp 分段应用 migration 模式：

1. 在内存 SQLite 中只应用到 `20260704053848_session_goal`，不包含新 migration。
2. 插入满足 FK 的 project、session 和一条旧结构 `session_goal` 记录。
3. 应用新 migration 及其后的剩余 migrations。
4. 断言迁移不抛错。
5. 断言原 goal 的 ID、objective、status、budget、usage 和 timestamps 未改变。
6. 断言新增 `continue_on_error` 为 false。
7. 使用更新后的 Drizzle schema 读取该行，确认 boolean 解码为 `false`。

该测试验证的是真实旧行升级，不以已完成全部 migrations 的临时数据库替代。

## 14. 验证命令

所有测试从 package 目录运行，不从仓库根运行。

在 `packages/opencode`：

```bash
bun test test/session/goal.test.ts
bun test test/server/httpapi-goal.test.ts
bun test test/session/prompt.test.ts
bun test test/storage/goal-migration.test.ts
bun typecheck
```

生成数据库迁移：

```bash
bun run db generate --name goal_continue_on_error
```

从仓库根执行 SDK 生成脚本：

```bash
./packages/sdk/js/script/build.ts
```

在 `packages/sdk/js`：

```bash
bun typecheck
```

聚焦验证通过后，可在 `packages/opencode` 扩大到相关 session tests。

手工 TUI 验证内容：

- `/goal` 菜单显示 `Continue after errors`。
- `✓`、`○` 和 Saving 状态正确。
- toggle 成功后菜单保持打开。
- Edit、Pause、Resume、Clear 行为不变。
- daemon 重启后设置保持。
- 开关关闭时错误终止。
- 开关开启时 eligible error 创建标准 GOAL continuation。
- Abort 后不 continuation。

## 15. 风险与边界

- `UnknownError` 可能包含本地运行时错误，不保证全部来自 provider。
- 默认 `goal_max_turns=32`，用户开启后最多可能增加 32 次自动 continuation。
- provider 可能针对相同上下文重复拒绝。
- 错误内容不传给模型，因此模型无法直接获知 provider 的具体拒绝原因。
- 终止错误请求当前可能不计入 GOAL `tokensUsed`。
- Pause/Clear 与 injection 之间存在现有 best-effort race。
- SDK 当前生成物可能落后于 GOAL contract，regeneration 可能带出已有 schema 差异。

这些风险均由默认关闭、用户显式选择、eligible allowlist、同一个 `goalTurns` 上限和既有 agent/session guard 限制。它们不要求新增模块或扩大本次实现范围。

## 16. 设计放行条件

实施前必须确认以下设计不变量同时成立：

- generic `break` 不作为错误续跑来源。
- 产生和消费 marker 时都使用同一个精确 allowlist predicate。
- marker 同时匹配 latest assistant ID，且不携带错误内容。
- Pause/Clear 只承诺 best-effort，不宣称原子保证。
- agent maxSteps 到顶后 GOAL 仍保持 active。
- migration compatibility 测试证明真实旧行升级为 false 且其他字段不变。
- 无法由 TestLLMServer 构造的 typed error 通过 test-only processor layer 验证，不增加 production hook。
- POST 成功结果先 reconcile 到 sync store，再解除 toggle loading。
- continuation prompt 不注入错误内容。
- SDK 生成结果包含完整 Goal endpoint、payload、response 和 event 类型。

独立审计若发现任何会导致回归、安全降级、兼容降级、边界漏洞或时序错误的阻塞项，必须继续修改本文档并重新执行原范围审计；不能以历史审计结论替代当前文档的放行。

## 17. 最终推荐

在 `session_goal` 上增加默认关闭的 `continueOnError`，由现有 `Manage Goal` 菜单以勾选项管理。prompt loop 使用显式 `terminal-error` outcome 和一次性 assistant-ID marker，仅允许 `APIError`、`UnknownError` 进入现有 GOAL continuation 入口。正常和错误续跑共享 `goalTurns`、`goal_max_turns`、主 session、active status、非 decide agent 和 agent step 限制。错误内容不进入模型上下文，`SessionGoal.continuationPrompt(goal)` 保持不变。

该方案不修改 `SessionRetry`，不新增全局配置、状态机、服务或手写 production module；预计修改 7 个既有源码文件、3 个既有测试文件，新增 1 个 migration compatibility 测试文件，并生成必要迁移和 SDK 产物，手写代码显著低于 1000 行。
