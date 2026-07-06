# Permission Auto-Reviewer 重试失效修复方案

## 0. 问题

reviewer "生成一半就不生了"，然后显示 unavailable。用户期望未产生完整 tool call 时重试最多 3 次，
但数据库 forensics 证实：超时场景 **零次重试**，socket 断开 **零次重试**，协议错误只重试 **1 次**。

### 数据库证据

| 数据库 | 总审查请求 | 成功返回决策 | 悬空(无工具返回) | 悬空率 |
|--------|-----------|-------------|----------------|--------|
| MAIN (`~/.local/share/opencode/opencode.db`) | 524 | 514 | 10 | 1.9% |
| TESTING (`.temp/testing/opencode.db`) | 605 (采样) | 570 | 33 | 5.5% |

| 错误类型 | MAIN | TESTING | 占比 |
|---------|------|---------|------|
| `auto reviewer timed out` (超时) | 3 | 8 | **42%** |
| `Bad Request` (400) | 2 | 5 | 27% |
| `reviewer did not call permission_review_decision` (协议错误) | 3 | 0 | 12% |
| `身份验证失败。` / `令牌已过期` (认证失败) | 0 | 3 | 12% |
| `socket connection closed` (连接断开) | 1 | 0 | 4% |
| `[object Object]` (序列化bug) | 0 | 1 | 4% |

## 1. 已阅读的文件/测试/文档（及相关性）

- `src/permission/reviewer/service.ts`：**核心修改文件**。`review`(98-233)、`runReviewerAttempt`(143-168)、
  `runReviewerAgent`(368-414)、`runReviewerStream`(416-776, 含 `acquireUseRelease`+`SessionRetry.retry`)、
  `handleReviewerFailure`(199-224)、`errorMessage`(905-910)、`assessmentFromJsonText`(950-961)、
  `updateToolAutoReview`(804-860)、`isReviewerDecisionProtocolError`(891-896)。
  **关键管道**：169-187 行 `runReviewerAttempt.pipe(catchIf, timeoutOrElse, mapError)`。
- `src/permission/auto.ts`：`evaluate` 的 `Effect.match` onFailure → `reviewer_unavailable` ask。
  `invalidReviewContract`(167-178) 语义守卫。
- `src/session/retry.ts`：`SessionRetry.retry`(204) 和 `retryable()`(71) 的重试分类逻辑。
  无 max attempts 限制，只靠 `retryable()` 返回值决定是否继续。
- `src/session/message-v2.ts`：`fromError`(1337) 错误分类链、`transportError`(1534) 传输错误识别、
  `TRANSIENT_TRANSPORT_CODES`(42) 已含 `UND_ERR_SOCKET` 但不覆盖无 code 的错误。
- `src/session/prompt.ts:2246-2262`：`finalizeInterruptedAssistant` 模式（`Effect.onInterrupt` 的参照模板）。
- `src/session/processor.ts:38-43`：`interruptedToolMetadata` 已有的 "aborted" 写入机制。
- `src/config/permission.ts:22`：`timeout_ms` 配置描述（需更新语义说明）。
- `test/session/prompt.test.ts:894-1157`：现有 reviewer 集成测试（JSON fallback、protocol retry、retry failure、503 retry）。
- `test/permission/reviewer-service.test.ts:816`：`openAIReviewDecisionStream` 始终返回成功 tool call，不覆盖错误路径。
- `test/lib/llm-server.ts:519`：`llm.hang()` 可模拟 provider 无响应；`llm.error(status, body)` 可模拟错误。

## 2. 调用点/引用点/旧逻辑确认

### 管道结构（当前，`service.ts:169-187`）

```
runReviewerAttempt(messages, true)           ← 第1次尝试
  └─ runReviewerAgent → runReviewerStream
       └─ acquireUseRelease(stream).pipe(SessionRetry.retry)  ← (D) provider级重试
  └─ tapError(隐藏协议失败)
.pipe(catchIf(协议错误, 第2次尝试))            ← (A) 协议重试：只重试1次
.pipe(timeoutOrElse(90s))                    ← (B) 超时：包裹 (A) 和 (D)
.pipe(mapError)                              ← (C) 错误映射
```

**关键问题**：`timeoutOrElse` (B) 在 `catchIf` (A) 的**外层**。超时时：
1. `timeoutOrElse` 以 **interruption**（中断）方式杀死内部 fiber
2. `SessionRetry.retry` (D) 看到的是 cancellation，不是 failure → **不重试**
3. `orElse` 返回 `Effect.fail(ReviewerTimedOut)` —— 这是 (B) 产生的**新 failure**，在 (A) 的**外层**
4. `catchIf` (A) 已经被应用过了，无法捕获 (B) 产生的 failure → **不重试**
5. `ReviewerTimedOut` 直达 `handleReviewerFailure` → unavailable

### `transportError` 分类（`message-v2.ts:1534-1573`）

检查 `error.code` 是否在 `TRANSIENT_TRANSPORT_CODES` 中（含 `UND_ERR_SOCKET`），以及 `message` 是否匹配
`"fetch failed"` / `"failed to fetch"` / `"SSE read timed out"` / `"Cannot connect to API:"`。

**问题**：socket 断开的 message 是 `"The socket connection was closed unexpectedly"`，不匹配任何模式。
如果 AI SDK 包装后 error 没有 `code` 属性，`transportError` 返回 `undefined` → `retryable()` 返回 `undefined` → 不重试。

### `maxRetries: 0`（`service.ts:560`）

AI SDK `streamText` 的内置重试（默认 `maxRetries: 2`，共 3 次尝试）被显式禁用。
注释提到 "Some OpenAI-compatible providers reject forced tool_choice"，但该注释是关于 tool_choice 的，
`maxRetries: 0` 是为了避免与 `SessionRetry.retry` 双重重试。保持不变。

### 数据库验证

- `22fa9737`（超时）：reasoning 持续 85s，只有一个 reasoning part（无第二次尝试痕迹）→ 零重试
- `031645e6`（socket close）：reasoning 22ms 后 socket 断开，只有一个 reasoning part → 零重试
- `2f03699d`（超时，并发）：5 个并发 review，4 个 2-3s 成功，唯独此 review 90s 超时 → 零重试
- `7455cd9a`（协议错误）：reviewer 输出合法 JSON 文本但未调用工具，`assessmentFromJsonText` 失败，
  无 hidden 消息（协议重试未执行）→ 最多 1 次重试

## 3. 必须保持的既有行为

| 行为 | 依据 |
|------|------|
| precheck 四级路由（safe/general → allow, cautious → reviewer, dangerous → deny） | `auto.ts:68-77` |
| 协议重试时隐藏第一次尝试 + 附加 protocol nudge | `service.ts:160-165,174`；`prompt.test.ts:946` |
| `fallback=user` 默认回退到 ask；`fallback=deny` 保持 fail-closed | `auto.ts:86-90`；`auto.test.ts:564` |
| `invalidReviewContract` 语义守卫（allow+critical → deny 等） | `auto.ts:167-178`；`auto.test.ts:603` |
| `Schema.decodeUnknownSync(Assessment)` 结构校验 | `service.ts:957,968` |
| `SessionRetry.retry` 只重试 429/5xx/rate-limit | `retry.ts:71-155` |
| `maxRetries: 0` 禁用 AI SDK 内置重试 | `service.ts:560` |
| reviewer 子会话复用（每父会话一个 permission-reviewer 子会话） | `service.ts:306-323` |
| `markToolReviewFailed` 的 `Effect.catch(() => Effect.void)` best-effort 写入 | `service.ts:209-215` |

## 4. 推荐的最小实现方案

### 方案选择

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 仅交换 pipe 顺序（catchIf 在 timeoutOrElse 外层） | 最小改动 | 仍只重试 1 次 | ❌ |
| **交换 pipe 顺序 + 递归 3 次重试** | 修复超时零重试 + 协议 1→3 次 | `timeout_ms` 语义从 total 变 per-attempt | ✅ |
| 新增 `max_retries` 配置项 | 可配置 | 违反"不新增不必要配置项" | ❌ |
| 重新启用 `maxRetries: 2` | 利用 AI SDK 内置重试 | 与 `SessionRetry.retry` 双重重试 | ❌ |

**选择方案**：交换 pipe 顺序 + 递归 3 次重试。不新增配置项，`MAX_REVIEWER_ATTEMPTS` 硬编码为 3
（匹配 AI SDK 默认 `maxRetries: 2` 的 3 次总尝试语义）。

## 5. 预计修改/新增/删除的文件

### 文件 1: `packages/opencode/src/permission/reviewer/service.ts`

#### Change 1（核心修复）: 交换 pipe 顺序 + 递归重试 + per-attempt 超时

**删除** 169-187 行的管道：
```ts
const assessment = yield* runReviewerAttempt(messages, true).pipe(
  Effect.catchIf(isReviewerDecisionProtocolError, () =>
    runReviewerAttempt(buildMessages({ system, userItems: [...userItems, PROTOCOL_RETRY_USER_ITEM] }), false),
  ),
  Effect.timeoutOrElse({
    duration: `${autoReview?.timeout_ms ?? 90_000} millis`,
    orElse: () => Effect.fail(new ReviewerTimedOut()),
  }),
  Effect.mapError((error) =>
    isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }),
  ),
)
```

**替换**为递归重试函数 + per-attempt 超时：

```ts
// timeout_ms 现在是每次尝试的超时，不是总超时。总最差时间为 timeout_ms * MAX_REVIEWER_ATTEMPTS。
const MAX_REVIEWER_ATTEMPTS = 3
const perAttemptTimeout = autoReview?.timeout_ms ?? 90_000

// 协议错误（reviewer 完成但未调用工具）和超时都触发重试。
// provider 级 429/503 由 SessionRetry.retry 在每次尝试内处理，不经过此层。
function isReviewerRetryable(error: unknown): boolean {
  return isReviewerDecisionProtocolError(error) || error instanceof ReviewerTimedOut
}

// 递归重试：最多 MAX_REVIEWER_ATTEMPTS 次。per-attempt 超时在 catchIf 内层，
// 使 ReviewerTimedOut 可被外层 catchIf 捕获并重试。
function reviewerRetry(
  attemptNum: number,
  currentMessages: readonly ModelMessage[],
  hideOnProtocolError: boolean,
): Effect.Effect<Schema.Schema.Type<typeof Assessment>, unknown> {
  return runReviewerAttempt(currentMessages, hideOnProtocolError).pipe(
    // per-attempt 超时：每次尝试独立计时。超时产生 ReviewerTimedOut，
    // 被下方 catchIf 捕获后触发重试，而非直接失败。
    Effect.timeoutOrElse({
      duration: `${perAttemptTimeout} millis`,
      orElse: () => Effect.fail(new ReviewerTimedOut()),
    }),
    // catchIf 在 timeoutOrElse 外层：能捕获 ReviewerTimedOut 进行重试。
    // 旧代码的 pipe 顺序相反（timeoutOrElse 在 catchIf 外层），导致超时绕过重试。
    Effect.catchIf(isReviewerRetryable, (error) => {
      if (attemptNum >= MAX_REVIEWER_ATTEMPTS - 1) return Effect.fail(error)
      // 协议错误：附加 protocol nudge；超时：保持原 prompt
      const nextMessages = isReviewerDecisionProtocolError(error)
        ? buildMessages({ system, userItems: [...userItems, PROTOCOL_RETRY_USER_ITEM] })
        : currentMessages
      return reviewerRetry(attemptNum + 1, nextMessages, false)
    }),
  )
}

const assessment = yield* reviewerRetry(0, messages, true).pipe(
  Effect.mapError((error) =>
    isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }),
  ),
)
```

**时序分析：**

| 场景 | 流程 | 重试次数 |
|------|------|---------|
| 超时 | `timeoutOrElse` 中断 `runReviewerAttempt` → `orElse` 产生 `ReviewerTimedOut` → `catchIf` 捕获 → 递归重试 | 最多 2 次 |
| 协议错误 | `runReviewerAttempt` 失败 → `timeoutOrElse` 透传 → `catchIf` 捕获 → 递归重试（附加 nudge） | 最多 2 次 |
| 429/503 | `SessionRetry.retry` 在 `runReviewerStream` 内重试 → 如果耗尽，错误传播为非 ReviewerError → `mapError` 包装 → `catchIf` 不捕获 → `handleReviewerFailure` | 由 SessionRetry 处理 |
| 400/401 | 不重试，直接传播 | 0 |
| 所有 3 次都失败 | 最后一次错误传播 → `mapError` → `handleReviewerFailure` | — |

#### Change 2: `runReviewerAgent` 添加 `Effect.onInterrupt`（~line 394）

在 `runReviewerStream(...).pipe(Effect.tapError(...))` 后追加 `Effect.onInterrupt`。
复用 `prompt.ts:2246-2262` 的 `finalizeInterruptedAssistant` 模式：

```ts
const assessment = yield* runReviewerStream(input.messages, input.model, {
  sessionID: session.id,
  messageID: message.id,
  reviewID: input.reviewID,
  message,
}).pipe(
  Effect.tapError((error) =>
    Effect.gen(function* () {
      message.error = MessageV2.fromError(error, { providerID: input.model.providerID })
      message.time.completed = Date.now()
      yield* sessions.updateMessage(message)
    }),
  ),
  // 超时中断不会触发 tapError；onInterrupt 确保子会话 assistant 消息始终
  // 写入终态，避免 repair-empty-dangling-assistant 延迟修复。
  Effect.onInterrupt(() =>
    Effect.gen(function* () {
      if (message.time.completed) return
      message.error ??= MessageV2.fromError(
        new DOMException("Aborted", "AbortError"),
        { providerID: input.model.providerID, aborted: true },
      )
      message.time.completed = Date.now()
      yield* sessions.updateMessage(message)
    }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)),
  ),
)
```

#### Change 3: `review` 函数添加外部 `Effect.onInterrupt`（~line 226）

```ts
return yield* run.pipe(
  Effect.catchDefect((defect) => Effect.fail(defect)),
  Effect.catch(handleReviewerFailure),
  // 外部取消（session cancel/compaction）不触发 handleReviewerFailure；
  // onInterrupt 作为 processor.interruptedToolMetadata 的补充，
  // 覆盖 processor 清理未触达的边界（stuck reviewing 案例）。
  Effect.onInterrupt(() =>
    markToolReviewFailed(input, "aborted", "reviewer interrupted").pipe(
      Effect.catch(() => Effect.void),
      Effect.catchDefect(() => Effect.void),
    ),
  ),
)
```

#### Change 4: `updateToolAutoReview` 添加守卫 + 类型更新（~line 826）

在 `current` 计算后添加：
```ts
// onInterrupt 可能在 handleReviewerFailure 写入终态后延迟触发；
// "aborted" 不应覆盖更具体的终态（timed_out/failed/fallback_user/allowed/denied）。
if (patch.status === "aborted" && current.status && current.status !== "reviewing") return
```

`markToolReviewFailed` 和 `updateToolAutoReview` 的 `status` 联合类型添加 `"aborted"`：
```ts
// markToolReviewFailed (line 798)
status: "timed_out" | "failed" | "fallback_user" | "aborted"

// updateToolAutoReview patch (line 807)
status: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user" | "aborted"
```

#### Change 5: `errorMessage` 诊断增强（~line 905）

```ts
function errorMessage(error: unknown) {
  if (error instanceof Error) {
    // AI SDK APICallError carries responseBody/statusCode absent from message;
    // include them so reviewer failures are diagnosable. responseBody is the
    // provider's error response (not request body), safe for diagnostics.
    const withResponse = error as Error & { responseBody?: string; statusCode?: number }
    if (withResponse.responseBody) {
      return `${error.message}${withResponse.statusCode ? ` (${withResponse.statusCode})` : ""}: ${withResponse.responseBody.slice(0, 300)}`
    }
    return error.message
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error) ?? String(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}
```

#### Change 6: `assessmentFromJsonText` 宽容 JSON 提取（~line 950）

```ts
function assessmentFromJsonText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const direct = parseAssessmentJson(trimmed)
  if (direct) return direct
  // 模型可能在 JSON 前后附加 prose 或 markdown fence。reviewer 模型是可信系统组件
  //（非用户输入），Schema 校验和 invalidReviewContract 仍保证结构与语义安全。
  // 提取仅扩大解析范围，不削弱 schema 或策略守卫。
  const extracted = extractFirstJsonObject(trimmed)
  if (extracted) return parseAssessmentJson(extracted)
}

function parseAssessmentJson(text: string) {
  try {
    return Schema.decodeUnknownSync(Assessment)(JSON.parse(text))
  } catch {
    return
  }
}

// 用括号深度扫描提取第一个完整 JSON 对象，避免正则对嵌套结构的误匹配。
// 处理字符串内的花括号和转义引号，防止误截断。
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start < 0) return
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return
}
```

### 文件 2: `packages/opencode/src/session/message-v2.ts`

#### Change 7: `transportError` 添加 socket close 识别（~line 1553）

在 `retryable` 计算中添加 socket close 模式：

```ts
const retryable =
  retryCode !== undefined ||
  message === "fetch failed" ||
  message === "failed to fetch" ||
  message.startsWith("Cannot connect to API:") ||
  message.includes("socket connection was closed")  // undici socket close 在 AI SDK 包装后可能丢失 code
```

### 文件 3: `packages/opencode/src/config/permission.ts`

#### Change 8: `timeout_ms` 配置描述更新（line 22）

```ts
timeout_ms: Schema.optional(Schema.Number).annotate({
  description: "Per-attempt reviewer timeout in milliseconds. Total worst-case is 3x this value (one initial attempt plus two retries). Defaults to 90000.",
}),
```

### 文件 4: `packages/opencode/test/session/prompt.test.ts`

#### Change 9: 更新协议重试失败测试（line 1015-1056）

**当前**测试推送 2 个 malformed 响应，期望 `llm.calls` 为 2。
**更新**为推送 3 个 malformed 响应，期望 `llm.calls` 为 3：

```ts
it.instance(
  "auto permission reviewer fails closed after two malformed protocol retries",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { auto_review: { fallback: "deny" } },
      }))
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer protocol retry failure" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      yield* llm.push(
        reply().text("first malformed reviewer response").stop().item(),
        reply().text("second malformed reviewer response").stop().item(),
        reply().text("third malformed reviewer response").stop().item(),
      )

      const exit = yield* permissions
        .ask({
          sessionID: chat.id,
          permission: "bash",
          patterns: [command],
          metadata: { command, agent: "auto" },
          always: ["*"],
          ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.AutoDeniedError)
      expect(yield* llm.calls).toBe(3)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return

      const visible = yield* MessageV2.filterCompactedEffect(reviewer.id)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("first malformed")))).toBe(false)
      expect(visible.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("second malformed")))).toBe(true)
    }),
  { git: true },
)
```

#### Change 10: 新增超时重试测试

```ts
it.instance(
  "auto permission reviewer retries on timeout before falling back to user",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        permission: { auto_review: { timeout_ms: 500 } },
      }))
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer timeout retry" })
      const command = String.raw`rm "/tmp/file with spaces.txt"`
      // 第一次：hang（超时）；第二次：正常返回
      yield* llm.hang
      yield* llm.push(
        reply()
          .tool("permission_review_decision", {
            outcome: "allow",
            risk_level: "high",
            user_authorization: "high",
            rationale: "retry after timeout succeeded",
          })
          .item(),
      )

      yield* permissions.ask({
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })

      expect(yield* llm.calls).toBe(2)
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      // 第一个 assistant 消息（超时中断）应有终态
      const msgs = yield* MessageV2.page({ sessionID: reviewer.id, limit: 20, includeHidden: true })
      const assistants = msgs.items.filter((m) => m.info.role === "assistant")
      expect(assistants.length).toBeGreaterThanOrEqual(2)
      // 被超时中断的 assistant 应有 error 和 completed
      const interrupted = assistants[0]
      expect(interrupted.info.time.completed).toBeDefined()
      expect(interrupted.info.error).toBeDefined()
    }),
  { git: true },
)
```

#### Change 11: 新增 prose-prefixed JSON fallback 测试

```ts
it.instance(
  "auto permission reviewer extracts JSON from prose-prefixed text",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const permissions = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reviewer JSON extraction" })
      const command = String.raw`rsync -av "/Volumes/My Passport/Calibration/" Sensetimex4:~/project/Calibration/`
      yield* llm.push(
        reply()
          .text(
            `Based on my analysis:\n${JSON.stringify({
              outcome: "allow",
              risk_level: "high",
              user_authorization: "high",
              rationale: "user explicitly authorized the bounded remote transfer",
            })}`,
          )
          .stop()
          .item(),
      )
      yield* permissions.ask({
        sessionID: chat.id,
        permission: "bash",
        patterns: [command],
        metadata: { command, agent: "auto" },
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "auto" }],
      })
      const reviewer = (yield* sessions.children(chat.id)).find((item) => item.agent === "permission-reviewer")
      expect(reviewer).toBeDefined()
      if (!reviewer) return
      const reviewerParts = (yield* MessageV2.filterCompactedEffect(reviewer.id)).flatMap((msg) => msg.parts)
      expect(
        reviewerParts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "permission_review_decision" &&
            part.state.status === "completed" &&
            part.state.metadata?.source === "json_fallback",
        ),
      ).toBe(true)
    }),
  { git: true },
)
```

## 6. 正常路径、错误路径、并发/退出/清理/安全边界

### 正常路径（reviewer 成功）
1. `reviewerRetry(0, messages, true)` → `runReviewerAttempt` → `runReviewerStream` 成功
2. `timeoutOrElse` 未触发 → `catchIf` 不触发
3. `markToolReviewed` 写入 "allowed"/"denied" → 返回 assessment

### 错误路径——超时（核心修复）
1. `reviewerRetry(0, ...)` → `runReviewerAttempt` → stream 运行中
2. `timeoutOrElse(perAttemptTimeout)` 中断 fiber → `onInterrupt`(Change 2) 写入子 assistant 终态
3. `acquireUseRelease` release 运行 `abort.abort()` → `SessionRetry.retry` 看到 cancellation 停止
4. `orElse` 产生 `ReviewerTimedOut`
5. `catchIf(isReviewerRetryable)` 捕获 → `reviewerRetry(1, sameMessages, false)` 重试
6. 重复直到成功或 3 次用完 → 最后一次错误到 `mapError` → `handleReviewerFailure`

### 错误路径——协议错误（reviewer 完成但未调用工具）
1. `runReviewerStream` 完成 → `!assessment` → `assessmentFromJsonText` 失败 → `ReviewerRunError(PROTOCOL_ERROR)`
2. `timeoutOrElse` 透传 → `catchIf` 捕获 → `tapError` 隐藏第一次尝试 → `reviewerRetry(1, nudgedMessages, false)` 重试
3. 重复直到成功或 3 次用完

### 错误路径——socket 断开（Change 7 修复）
1. stream error 事件 → `Effect.fail(event.error)` → `SessionRetry.retry` 检查 `retryable()`
2. `transportError` 现在匹配 `"socket connection was closed"` → `isRetryable: true` → `SessionRetry.retry` 重试
3. 如果 `SessionRetry.retry` 耗尽 → 错误传播为非 ReviewerError → `mapError` 包装 → `catchIf` 不捕获 → `handleReviewerFailure`

### 错误路径——外部取消
1. fiber 被中断 → `onInterrupt`(Change 2) 写入子 assistant 终态
2. `onInterrupt`(Change 3) 写入父工具 part "aborted"
3. `handleReviewerFailure` 不触发（中断不是 failure）
4. 守卫(Change 4) 防止 "aborted" 覆盖已写入的终态

### 并发/时序安全
- `tapError`（failure）和 `onInterrupt`（interruption）互斥
- `handleReviewerFailure`（failure）和外部 `onInterrupt`（interruption）互斥
- 递归 `reviewerRetry` 深度 ≤ 2，每次尝试顺序执行（前一次 fiber 完全终止后才启动下一次）
- `if (message.time.completed) return` 防止子 assistant 双写
- `message.error ??=` 防止覆盖已设置的 error
- 守卫 `if (patch.status === "aborted" && current.status !== "reviewing") return` 防止覆盖终态

### 安全边界
- `Schema.decodeUnknownSync(Assessment)` 结构校验不变
- `invalidReviewContract` 语义守卫不变
- `extractFirstJsonObject` 只提取第一个 `{...}` 块，Schema 校验仍拒绝无关 JSON
- `responseBody` 是 provider 错误响应（非请求体），截断 300 字符

## 7. 行为级测试计划

### 先写的测试（TDD 红灯）

| 测试 | 验证内容 | 当前实现预期 |
|------|---------|------------|
| 超时重试 | `llm.hang` 后正常响应 → 2 次 calls | **失败**：当前超时零重试，只有 1 次 call |
| prose-prefixed JSON | 混合文本提取 JSON → `json_fallback` | **失败**：当前只接受纯 JSON |
| 协议重试 3 次 | 3 个 malformed → `llm.calls` 为 3 | **失败**：当前只重试 1 次，`llm.calls` 为 2 |

### 现有测试验证（不应回归）

| 测试 | 文件:行 | 验证 |
|------|--------|------|
| "accepts structured JSON text decisions" | `prompt.test.ts:894` | 纯 JSON → `json_fallback` ✓ |
| "hides malformed protocol attempts before retrying" | `prompt.test.ts:946` | 1 malformed + 1 valid → 2 calls ✓ |
| "retries malformed decision tool input" | `prompt.test.ts:1058` | 1 malformed tool + 1 valid → 2 calls ✓ |
| "retries transient provider failures" | `prompt.test.ts:1110` | 503 + valid → `SessionRetry.retry` 处理 ✓ |
| "cancel aborts an in-flight shell auto review" | `prompt.test.ts:1292` | cancel → "aborted" ✓ |

## 8. 建议运行的验证命令

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test test/permission/auto.test.ts
cd packages/opencode && bun test test/permission/reviewer-service.test.ts
cd packages/opencode && bun test test/session/prompt.test.ts -t "reviewer"
cd packages/opencode && bun test test/permission/
```

## 9. 预估 git 文件数、增删行数

| 文件 | 类型 | 增 | 删 | 净 |
|------|------|---|---|---|
| `packages/opencode/src/permission/reviewer/service.ts` | 修改 | ~95 | ~20 | +75 |
| `packages/opencode/src/session/message-v2.ts` | 修改 | ~2 | 0 | +2 |
| `packages/opencode/src/config/permission.ts` | 修改 | ~1 | ~1 | 0 |
| `packages/opencode/test/session/prompt.test.ts` | 修改 | ~90 | ~5 | +85 |
| **总计** | 4 文件 | ~188 | ~26 | +162 |

不涉及生成文件、迁移、文档（本文件除外）。

## 10. 真实风险与开放问题

### 已确认风险（已在方案中处理）

| 风险 | 处理方式 |
|------|---------|
| `timeout_ms` 语义从 total 变 per-attempt | 更新 config 描述；无现有测试配置 `timeout_ms` |
| 协议重试 3 次（原 1 次） | 更新测试推送 3 个 malformed 响应 |
| `extractFirstJsonObject` 安全性 | Schema 校验 + `invalidReviewContract` 不变 |
| `onInterrupt` 清理写入可能失败 | `Effect.catch(() => Effect.void)` |
| `JSON.stringify(undefined)` 返回 undefined | `?? String(error)` 兜底 |
| `JSON.stringify` 循环引用 | try-catch 兜底 |

### 开放问题（不阻塞）

1. **270s 最差总时间**：3 × 90s = 270s。用户可减小 `timeout_ms` 缩短总时间。权限路径非延迟敏感（agent 等待权限时本就阻塞）。
2. **7455cd9a 案例的精确根因**：持久化 text 是合法 JSON 但 `assessmentFromJsonText` 失败，且协议重试未执行。Change 6 的宽容提取 + Change 1 的 3 次重试可减少此类场景，但根因可能涉及运行时 `textOutput` 变量不一致，需额外日志诊断。
3. **模型回退（auth/400）**：当 reviewer 模型 provider 返回 401/400 时无回退到其他模型。属于行为变更，不在本次范围内。
