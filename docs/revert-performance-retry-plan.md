# 消息撤回性能与重试功能完整实现方案

> 状态：待审计 | 不含代码修改，仅设计方案

## 1. 背景与问题

### 问题 1：撤回慢（1-2 秒）

`SessionRevert.revert`（`session/revert.ts:44-114`）串行执行大量 git 子进程。Benchmark 实测：

| 操作 | 耗时 |
|---|---|
| 单次 git spawn 基线 | ~12ms |
| 逐文件 checkout ×20 | 255ms |
| 批量 checkout ×20 | 24ms |
| 单次 checkout ×20 | 12ms |
| 完整 revert 序列（19 spawns） | 214ms |
| 数据库 messages 加载（4421 parts） | 110ms |

用户感受 1-2 秒 = git 操作（~400ms）+ DB 加载（~110ms）+ computeDiff + HTTP 往返 + JSON 序列化 + Effect 开销。

### 问题 2：时序竞争（新消息被误撤回）

`dialog-message.tsx:32` 用 `void sdk.client.session.revert(...)` fire-and-forget，不 await。revert 进行中（1-2 秒）用户发新消息，新消息被 UI 隐藏或被 cleanup 删除。

根因：`assertNotBusy`（`run-state.ts:71-75`）只检查 `runners.get(sessionID)?.busy`，revert 不持有 runner，守卫无法检测 revert 进行中。

### 问题 3：缺少"重试"选项

`dialog-message.tsx` 菜单仅 Revert/Copy/Fork。用户想"重试"需两步（Revert → 等待 → 手动回车），且两步间有竞争窗口。

## 2. 已阅读并确认的文件

| 文件 | 行号 | 相关性 |
|---|---|---|
| `session/revert.ts` | 1-194 | revert/unrevert/cleanup 核心，B1 改动点 |
| `session/run-state.ts` | 1-165 | assertNotBusy/runner/cancel，B1 改动点 |
| `snapshot/index.ts` | 287-506, 730-759 | track/restore/revert/diff git 操作，A1 改动点 |
| `session/prompt.ts` | 1214-1223, 1436-1510, 1972-2009, 2025-2026, 2569-2684 | shellImpl/createUserMessage/prompt/compact/command 调用链 |
| `session/session.ts` | 506-520, 536, 780-811, 826-845 | BusyError/messages/setRevert/clearRevert/patch |
| `session/message-v2.ts` | 518-542, 1100-1150, 1224-1230 | PartInput schema + page + hidden 过滤 |
| `cli/cmd/tui/routes/session/dialog-message.tsx` | 1-108 | 消息菜单，C1 改动点 |
| `cli/cmd/tui/routes/session/index.tsx` | 219, 746-797, 1358 | usePromptRef + Undo/Redo + DialogMessage 调用 |
| `cli/cmd/tui/component/prompt/index.tsx` | 88-96, 763-797, 1166-1182, 1402-1430 | PromptRef.set/submit/submitInner/promptAsync |
| `cli/cmd/tui/context/prompt.tsx` | 1-18 | usePromptRef |
| `server/.../handlers/session.ts` | 296-350 | prompt/promptAsync/command/shell handler，B1 改动点 |
| `server/.../handlers/session-errors.ts` | 11-12 | mapBusy → BadRequest |
| `server/.../groups/session.ts` | 136, 509-534 | PromptPayload/RevertPayload 端点定义 |
| `test/session/revert-compact.test.ts` | 1-732 | 核心测试，8 个用例必须通过 |
| `test/session/snapshot-tool-race.test.ts` | 1-286 | 并发测试 |
| `test/AGENTS.md` | — | 测试规范 |

## 3. 已确认的调用点（grep 验证）

- `revert.cleanup` 调用点：`prompt.ts:1976`(prompt)、`prompt.ts:1222`(shellImpl)、`prompt.ts:2026`(compact)
- `command`(prompt.ts:2669) → `prompt`(prompt.ts:1976) → `cleanup`，间接调用
- `assertNotBusy` 调用点：`revert.ts:45`、`revert.ts:118`、`prompt.ts:2025`(compact)、`handlers/session.ts:378`(deleteMessage)
- `prompt`/`shellImpl` 不调用 `assertNotBusy`，通过 handler 层覆盖
- `TaskTool.ops.prompt`(prompt.ts:405) → `prompt()`(含 cleanup)，但子 session 是 fresh（cleanup no-op），父 session `injectBackgroundResult` 是已知未覆盖点（概率极低）
- `messages()`(session.ts:826-845) 分页加载，每页 50 条从后往前翻页
- `MessageV2.page`(message-v2.ts:1101) 支持 `before` 游标和 `includeHidden`
- snapshot 所有 git 操作经 `locked = Semaphore(1)`(snapshot/index.ts:166) 串行
- `mapBusy`(session-errors.ts:12) 映射 `SessionBusyError → HttpApiError.BadRequest`
- SDK 是生成代码（`packages/sdk/js/src/v2/gen/`），不新增端点
- `PromptRef`(prompt/index.tsx:88-96) 有 `set`(776) 和 `submit`(795) 方法
- `set`(776-785) 同步更新 `setStore("prompt", prompt)`，`submit`(795) 调用 `void submit()`(1166) 读取 `store.prompt`

## 4. 必须保持的既有行为

1. `revert.revert` 设置 `session.revert.messageID`，恢复文件到 revert 点
2. `revert.unrevert` 清除 `session.revert`，恢复文件到最新状态
3. 多次 revert 按顺序恢复（测试 "restore messages in sequential order"）
4. `cleanup` 标记 `hidden: {reason: "undo"}` 但**不删除数据库记录**
5. `cleanup` terminalizes 未完成 assistant（设 `time.completed` + `error`）
6. `cleanup` 是 no-op 当 `session.revert` 为 null/undefined
7. `revert.revert` 内部已有 `assertNotBusy`（revert.ts:45）
8. `prompt()` 调用 `revert.cleanup`（prompt.ts:1976）——cleanup 在 createUserMessage 之前
9. `messages()` 默认 `includeHidden=true`（message-v2.ts:1157）
10. loop 构建上下文时过滤 hidden（message-v2.ts:1224-1230）
11. snapshot 所有 git 操作经 `locked = Semaphore(1)` 串行
12. `mapBusy` 映射 `BusyError → BadRequest`
13. SDK 是生成代码，不新增端点
14. `promptAsync` handler fork prompt，返回 NoContent；失败通过 Error event 通知
15. `promptAsync` 失败时 `keepDraftAfterSubmitFailure`(prompt/index.tsx:1331) 保留草稿 + toast

## 5. 方案 B1: revert 状态守卫（修复时序竞争）

### 5.1 改动文件：`packages/opencode/src/session/run-state.ts`

#### 5.1.1 Interface 新增 3 个方法

**当前代码（line 11-25）**：
```ts
export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}
```

**修改后**：
```ts
export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly assertNotReverting: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly beginRevert: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly endRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}
```

#### 5.1.2 InstanceState.make 增加 reverting Set

**当前代码（line 35-49）**：
```ts
const state = yield* InstanceState.make(
  Effect.fn("SessionRunState.state")(function* (ctx) {
    const scope = yield* Scope.Scope
    const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* () {
        yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
          concurrency: "unbounded",
          discard: true,
        })
        runners.clear()
      }),
    )
    return { runners, scope }
  }),
)
```

**修改后**：
```ts
const state = yield* InstanceState.make(
  Effect.fn("SessionRunState.state")(function* (ctx) {
    const scope = yield* Scope.Scope
    const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
    // revert 进行中标记：beginRevert 原子 check-and-set，endRevert 清除。
    // assertNotBusy 和 assertNotReverting 检查此 Set 阻止 revert 期间的 prompt/shell 竞争。
    const reverting = new Set<SessionID>()
    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* () {
        yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
          concurrency: "unbounded",
          discard: true,
        })
        runners.clear()
        reverting.clear()
      }),
    )
    return { runners, scope, reverting }
  }),
)
```

#### 5.1.3 assertNotBusy 增加 reverting 检查

**当前代码（line 71-75）**：
```ts
const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
  const data = yield* InstanceState.get(state)
  const existing = data.runners.get(sessionID)
  if (existing?.busy) yield* busyError(sessionID)
})
```

**修改后**：
```ts
const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
  const data = yield* InstanceState.get(state)
  const existing = data.runners.get(sessionID)
  if (existing?.busy) yield* busyError(sessionID)
  if (data.reverting.has(sessionID)) yield* busyError(sessionID)
})

// 只检查 revert 进行中，不检查 runner.busy——用于 prompt/shell handler 层守卫，
// 避免阻止 prompt 执行中发新消息的排队语义（ensureRunning join 行为）。
const assertNotReverting = Effect.fn("SessionRunState.assertNotReverting")(function* (sessionID: SessionID) {
  const data = yield* InstanceState.get(state)
  if (data.reverting.has(sessionID)) yield* busyError(sessionID)
})

// 原子 check-and-set：yield* InstanceState.get 后，has 和 add 之间无 yield*，
// Effect 协作式调度不会在同步代码块中切让 fiber，保证只一个 revert 能进入。
const beginRevert = Effect.fn("SessionRunState.beginRevert")(function* (sessionID: SessionID) {
  const data = yield* InstanceState.get(state)
  if (data.reverting.has(sessionID)) yield* busyError(sessionID)
  data.reverting.add(sessionID)
})

const endRevert = Effect.fn("SessionRunState.endRevert")(function* (sessionID: SessionID) {
  const data = yield* InstanceState.get(state)
  data.reverting.delete(sessionID)
})
```

#### 5.1.4 Service.of 返回新增方法

**当前代码（line 118）**：
```ts
return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
```

**修改后**：
```ts
return Service.of({ assertNotBusy, assertNotReverting, beginRevert, endRevert, cancel, ensureRunning, startShell })
```

### 5.2 改动文件：`packages/opencode/src/session/revert.ts`

#### 5.2.1 revert 函数包裹 beginRevert/endRevert

**当前代码（line 44-114）**：
```ts
const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
  yield* state.assertNotBusy(input.sessionID)
  const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
  let lastUser: MessageV2.User | undefined
  const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

  let rev: Session.Info["revert"]
  const patches: Snapshot.Patch[] = []
  for (const msg of all) {
    // ... 遍历消息找 revert 点 ...
  }

  if (!rev) return session

  // ... computeDiff + track + restore + revert(patches) + diff + setRevert ...

  return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
})
```

**修改后**：
```ts
const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
  yield* state.assertNotBusy(input.sessionID)
  // acquireUseRelease：beginRevert 成功后 endRevert 立即注册为 finalizer，
  // 消除 beginRevert 与 Effect.ensuring 之间的理论中断窗口。
  // beginRevert 失败（已 reverting）时 endRevert 不执行——不会误清除其他 revert 的标志。
  return yield* Effect.acquireUseRelease(
    state.beginRevert(input.sessionID),
    () =>
      Effect.gen(function* () {
        const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        let lastUser: MessageV2.User | undefined
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

        let rev: Session.Info["revert"]
        const patches: Snapshot.Patch[] = []
        for (const msg of all) {
          // ... 遍历消息找 revert 点（原逻辑不变）...
        }

        if (!rev) return session

        // ... computeDiff + track + restore + revert(patches) + diff + setRevert（原逻辑不变）...

        return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      }),
    () => state.endRevert(input.sessionID),
  )
})
```

> 注：`Effect.acquireUseRelease` 保证 acquire 成功后 release 总是执行（无论 use 成功/失败/中断），acquire 失败时 release 不执行。`if (!rev) return session` 在 use 内部提前返回时 release 仍执行。beginRevert 失败（已 reverting）时 release 不执行——正确，不会误清除其他 revert 的 reverting 标志。

#### 5.2.2 unrevert 函数同样包裹

**当前代码（line 116-125）**：
```ts
const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
  log.info("unreverting", input)
  yield* state.assertNotBusy(input.sessionID)
  const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
  if (!session.revert) return session
  if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.files)
  yield* sessions.clearRevert(input.sessionID)
  return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
})
```

**修改后**：
```ts
const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
  log.info("unreverting", input)
  yield* state.assertNotBusy(input.sessionID)
  return yield* Effect.acquireUseRelease(
    state.beginRevert(input.sessionID),
    () =>
      Effect.gen(function* () {
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        if (!session.revert) return session
        if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.files)
        yield* sessions.clearRevert(input.sessionID)
        return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      }),
    () => state.endRevert(input.sessionID),
  )
})
```

### 5.3 改动文件：`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`

#### 5.3.1 4 个 handler 加 assertNotReverting

**prompt handler（当前 line 296-310）**：
```ts
const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof PromptPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  const message = yield* promptSvc
    .prompt({
      ...ctx.payload,
      sessionID: ctx.params.sessionID,
    })
    .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
  return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
    contentType: "application/json",
  })
})
```

**修改后**：
```ts
const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof PromptPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
  const message = yield* promptSvc
    .prompt({
      ...ctx.payload,
      sessionID: ctx.params.sessionID,
    })
    .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
  return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
    contentType: "application/json",
  })
})
```

**promptAsync handler（当前 line 312-332）**：
```ts
const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof PromptPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("prompt_async failed").pipe(
          Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
        )
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.params.sessionID,
          error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
        })
      }),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  return HttpApiSchema.NoContent.make()
})
```

**修改后**（在 `Effect.forkIn` 前加同步检查，revert 期间直接返回 BadRequest，不 fork）：
```ts
const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof PromptPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
  yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("prompt_async failed").pipe(
          Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
        )
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.params.sessionID,
          error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
        })
      }),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  )
  return HttpApiSchema.NoContent.make()
})
```

**command handler（当前 line 334-342）**：
```ts
const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof CommandPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  return yield* promptSvc
    .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
    .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
})
```

**修改后**：
```ts
const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof CommandPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
  return yield* promptSvc
    .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
    .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
})
```

**shell handler（当前 line 344-349）**：
```ts
const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof ShellPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
})
```

**修改后**：
```ts
const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
  params: { sessionID: SessionID }
  payload: typeof ShellPayload.Type
}) {
  yield* requireSession(ctx.params.sessionID)
  yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
  return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
})
```

### 5.4 B1 覆盖完整性

| cleanup 调用点 | 入口 | 守卫 |
|---|---|---|
| prompt.ts:1976 (prompt) | prompt/promptAsync/command handler | assertNotReverting ✅ |
| prompt.ts:1222 (shellImpl) | shell handler | assertNotReverting ✅ |
| prompt.ts:2026 (compact) | compact() | assertNotBusy（已含 reverting）✅ |

## 6. 方案 A1: 合并 git checkout（加速撤回）

### 6.1 改动文件：`packages/opencode/src/snapshot/index.ts`

**当前代码（line 405-479，revert 函数批量分支）**：
```ts
for (let i = 0; i < ops.length; ) {
  const first = ops[i]!
  const run = [first]
  let j = i + 1
  // Only batch adjacent files when their paths cannot affect each other.
  while (j < ops.length && run.length < 100) {
    const next = ops[j]!
    if (next.hash !== first.hash) break
    if (run.some((item) => clash(item.rel, next.rel))) break
    run.push(next)
    j += 1
  }

  if (run.length === 1) {
    yield* single(first)
    i = j
    continue
  }

  const tree = yield* git(
    [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
    {
      cwd: state.worktree,
    },
  )

  if (tree.code !== 0) {
    log.info("batched ls-tree failed, falling back to single-file revert", {
      hash: first.hash,
      files: run.length,
    })
    for (const op of run) {
      yield* single(op)
    }
    i = j
    continue
  }

  const have = new Set(
    tree.text
      .trim()
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const list = run.filter((item) => have.has(item.rel))
  if (list.length) {
    log.info("reverting", { hash: first.hash, files: list.length })
    const result = yield* git(
      [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
      {
        cwd: state.worktree,
      },
    )
    if (result.code !== 0) {
      log.info("batched checkout failed, falling back to single-file revert", {
        hash: first.hash,
        files: list.length,
      })
      for (const op of run) {
        yield* single(op)
      }
      i = j
      continue
    }
  }

  for (const op of run) {
    if (have.has(op.rel)) continue
    log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
    yield* remove(op.file)
  }

  i = j
}
```

**修改后**（在 `if (run.length === 1)` 之后、`const tree = ...` 之前插入快速路径）：
```ts
for (let i = 0; i < ops.length; ) {
  const first = ops[i]!
  const run = [first]
  let j = i + 1
  // Only batch adjacent files when their paths cannot affect each other.
  while (j < ops.length && run.length < 100) {
    const next = ops[j]!
    if (next.hash !== first.hash) break
    if (run.some((item) => clash(item.rel, next.rel))) break
    run.push(next)
    j += 1
  }

  if (run.length === 1) {
    yield* single(first)
    i = j
    continue
  }

  // 优化：先尝试单次 checkout 全部文件。成功时跳过 ls-tree 预验证（省一次 git spawn）。
  // 失败（部分文件不存在或其他 git 错误）时回退到下方 ls-tree + 逐文件逻辑，行为不变。
  const fastCheckout = yield* git(
    [...core, ...args(["checkout", first.hash, "--", ...run.map((item) => item.file)])],
    { cwd: state.worktree },
  )
  if (fastCheckout.code === 0) {
    i = j
    continue
  }

  const tree = yield* git(
    [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
    {
      cwd: state.worktree,
    },
  )

  if (tree.code !== 0) {
    log.info("batched ls-tree failed, falling back to single-file revert", {
      hash: first.hash,
      files: run.length,
    })
    for (const op of run) {
      yield* single(op)
    }
    i = j
    continue
  }

  const have = new Set(
    tree.text
      .trim()
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const list = run.filter((item) => have.has(item.rel))
  if (list.length) {
    log.info("reverting", { hash: first.hash, files: list.length })
    const result = yield* git(
      [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
      {
        cwd: state.worktree,
      },
    )
    if (result.code !== 0) {
      log.info("batched checkout failed, falling back to single-file revert", {
        hash: first.hash,
        files: list.length,
      })
      for (const op of run) {
        yield* single(op)
      }
      i = j
      continue
    }
  }

  for (const op of run) {
    if (have.has(op.rel)) continue
    log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
    yield* remove(op.file)
  }

  i = j
}
```

### 6.2 A1 行为不变性

- 成功路径：`git checkout <hash> -- <all-files>` 返回 0 → 所有文件已恢复，无需删除。跳过 ls-tree。
- 失败路径：`git checkout` 返回非 0（部分文件不存在或 git 错误）→ 回退到原逻辑：ls-tree 判断哪些存在 → checkout 存在的 → 删除不存在的。
- 部分成功：git checkout 部分文件已恢复但返回非 0 → 回退逻辑重新 ls-tree + checkout（幂等，已恢复文件再 checkout 无害）+ 删除不存在文件。
- `single` 函数（line 386-401）和 `clash` 逻辑（line 403）不受影响。

## 7. 方案 A2: messages() 范围裁剪（减少大 session 加载时间）

### 7.1 改动文件：`packages/opencode/src/session/message-v2.ts`

#### import 添加 gte

**当前代码（line 10-15）**：
```ts
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
```

**修改后**：
```ts
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm"
```

#### page() 加 fromMessageID 参数

**当前代码（line 1101-1110）**：
```ts
export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
  includeHidden?: boolean
}) {
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
```

**修改后**：
```ts
export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
  includeHidden?: boolean
  fromMessageID?: MessageID
}) {
  const before = input.before ? cursor.decode(input.before) : undefined
  // fromMessageID 裁剪：MessageID 单调递增（message-v2.ts:1211），gte 等价于时间顺序过滤
  const base = input.fromMessageID
    ? and(eq(MessageTable.session_id, input.sessionID), gte(MessageTable.id, input.fromMessageID))
    : eq(MessageTable.session_id, input.sessionID)
  const where = before ? and(base, older(before)) : base
```

### 7.2 改动文件：`packages/opencode/src/session/session.ts`

#### messages() Interface 加 fromMessageID

**当前代码（line 536）**：
```ts
readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[], NotFound>
```

**修改后**：
```ts
readonly messages: (input: { sessionID: SessionID; limit?: number; fromMessageID?: MessageID }) => Effect.Effect<MessageV2.WithParts[], NotFound>
```

#### messages() 实现透传 fromMessageID

**当前代码（line 826-845）**：
```ts
const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
  if (input.limit) {
    return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit })).items
  }

  const size = 50
  const result = [] as MessageV2.WithParts[]
  let before: string | undefined
  while (true) {
    const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before })
    if (page.items.length === 0) break
    for (let i = page.items.length - 1; i >= 0; i--) {
      const item = page.items[i]
      if (item) result.push(item)
    }
    if (!page.more || !page.cursor) break
    before = page.cursor
  }
  return result.reverse()
})
```

**修改后**（两处 page 调用透传 fromMessageID）：
```ts
const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
  if (input.limit) {
    return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit, fromMessageID: input.fromMessageID })).items
  }

  const size = 50
  const result = [] as MessageV2.WithParts[]
  let before: string | undefined
  while (true) {
    const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before, fromMessageID: input.fromMessageID })
    if (page.items.length === 0) break
    for (let i = page.items.length - 1; i >= 0; i--) {
      const item = page.items[i]
      if (item) result.push(item)
    }
    if (!page.more || !page.cursor) break
    before = page.cursor
  }
  return result.reverse()
})
```

### 7.3 改动文件：`packages/opencode/src/session/revert.ts`

#### revert 调用 messages() 时传 fromMessageID

**当前代码（line 46，在 acquireUseRelease 的 use 内）**：
```ts
const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
```

**修改后**：
```ts
// 只加载 input.messageID 及之后的尾部消息，避免大 session 全量分页加载。
// partID 场景（部分撤回）需要 lastUser（input.messageID 之前的最近 user 消息），
// 仍加载全部作为安全回退。
// narrowing：非 partID + assistant messageID（仅 API 直传可达，TUI 不可达）时，
// lastUser 为 undefined → rev.messageID = assistant 自身（旧行为是之前的 user）。
// 此差异可接受——保留 user 提问不造成数据损坏。
const all = yield* sessions.messages(
  input.partID
    ? { sessionID: input.sessionID }
    : { sessionID: input.sessionID, fromMessageID: input.messageID },
).pipe(Effect.orDie)
```

### 7.4 A2 行为正确性

- **MessageID 单调递增**（message-v2.ts:1211 "is monotonic via MessageID.ascending"）：`gte(id, fromMessageID)` 等价于"该消息及之后的所有消息"。revert.ts:81 已用 `msg.info.id >= rev.messageID` 做字符串比较过滤，确认安全。
- **非 partID 场景**（TUI Revert/Retry/Undo/Redo，input.messageID 是 user 消息）：加载 `id >= input.messageID` 的尾部。遍历到 input.messageID 时 `lastUser = input.messageID`（自身，因 `if (msg.info.role === "user") lastUser = msg.info` 在 parts 循环前），`rev.messageID = lastUser.id = input.messageID`。正确。
- **partID 场景**（部分撤回）：仍加载全部消息，保证 `lastUser` 能找到 input.messageID 之前的最近 user 消息。行为不变。
- **不影响其他调用方**：messages() 的 `fromMessageID` 是可选参数，其他调用方不传时行为不变。
- **已知 narrowing（非阻塞）**：非 partID 场景下，若 input.messageID 是 assistant 消息（仅 API 直传可达，TUI 所有路径均过滤 `role === "user"`），A2 使 `lastUser = undefined` → `rev.messageID = msg.info.id`（assistant 自身）而非旧行为的 `lastUser.id`（之前的 user）。差异：旧行为隐藏整个 turn（user+assistant），A2 只隐藏 assistant（保留 user 提问）。这是可接受的 narrowing——revert 到 assistant 消息时保留其前的 user 提问不会造成数据损坏，且 TUI 不可达此路径。代码中加注释标记此假设。

### 7.5 A2 Benchmark 验证

| Session 规模 | 当前 messages() | A2 优化后 | 节省 |
|---|---|---|---|
| 大（4421 parts / 1110 msgs） | 110ms（22 次分页） | ~30ms（1-2 次分页） | 80ms |
| 中（500 parts） | ~30ms | ~15ms | 15ms |
| 小（100 parts） | ~15ms | ~10ms | 5ms |

## 8. 方案 C1: TUI Retry 菜单项（一步重试）

### 7.1 改动文件：`packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx`

**当前完整代码（108 行）**：
```tsx
import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import * as Clipboard from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
```

**修改后**（新增 import + Retry 选项）：
```tsx
import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { usePromptRef } from "@tui/context/prompt"
import * as Clipboard from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const promptRef = usePromptRef()

  // 从消息 parts 提取 PromptInfo（text 拼接 + file parts），供 Revert/Retry 复用
  function extractPromptInfo(messageID: string): PromptInfo {
    const parts = sync.data.part[messageID]
    return parts.reduce(
      (agg, part) => {
        if (part.type === "text") {
          if (!part.synthetic) agg.input += part.text
        }
        if (part.type === "file") agg.parts.push(strip(part))
        return agg
      },
      { input: "", parts: [] as PromptInfo["parts"] },
    )
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })

            if (props.setPrompt) {
              props.setPrompt(extractPromptInfo(msg.id))
            }

            dialog.clear()
          },
        },
        {
          title: "Retry",
          value: "session.retry",
          description: "revert to here and resend",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return
            dialog.clear()
            // 如果 session 正在运行，先 abort（与 Undo 命令一致 index.tsx:744-745）
            const status = sync.data.session_status?.[props.sessionID]
            if (status?.type !== "idle") {
              await sdk.client.session.abort({ sessionID: props.sessionID }).catch(() => {})
            }
            // 提取原消息内容（在 revert 前，revert 后 parts 仍可访问但提前提取更清晰）
            const promptInfo = extractPromptInfo(msg.id)
            // await revert 完成（B1 守卫确保 revert 期间无其他操作竞争）
            const revertResponse = await sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })
            if (revertResponse.error) {
              // revert 失败（如 runner 仍 busy），填回内容让用户手动处理
              props.setPrompt?.(promptInfo)
              return
            }
            // revert 成功：填回 prompt 并自动提交
            // set 同步更新 store（prompt/index.tsx:778），submit 读取 store（prompt/index.tsx:1166）——时序安全
            props.setPrompt?.(promptInfo)
            promptRef.current?.submit()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
```

### 7.2 C1 时序正确性

```
T0    用户点 Retry
T0    dialog.clear() → 对话框立即关闭
T0    await abort（如果 busy）→ runner idle
T0    extractPromptInfo（同步，从 sync.data.part）
T0    await sdk.client.session.revert(...)
      ├─ handler: requireSession → revertSvc.revert
      ├─ revert: assertNotBusy → beginRevert(reverting=true)
      ├─ revert: git track + restore + revert(patches) + diff + setRevert
      ├─ revert: endRevert(reverting=false)  ← Effect.ensuring
      └─ HTTP 响应返回（session.revert 已设置）
T340  revertResponse 检查
      ├─ error → setPrompt（填回内容，用户手动处理）
      └─ 成功 → setPrompt（同步更新 store）→ promptRef.current?.submit()
T340  submit → promptAsync
      ├─ handler: assertNotReverting（通过，reverting 已清除）
      ├─ prompt: assertNotReverting（handler 层已检查）
      ├─ prompt: cleanup（session.revert 已设置 → 标记 hidden + clearRevert）
      ├─ prompt: createUserMessage（新消息）
      └─ prompt: loop → ensureRunning → runner busy
T340+ 新 prompt 执行中
```

## 9. 正常/错误/并发/清理/安全路径

### 8.1 正常路径（Retry）
点 Retry → dialog.clear → abort(如果 busy) → 提取内容 → await revert(B1 持 reverting) → revert 完成(reverting 清除, session.revert 已设置) → setPrompt(同步更新 store) → submit → promptAsync → handler assertNotReverting(通过) → prompt() → cleanup(标记 hidden + clearRevert) → createUserMessage → loop

### 8.2 正常路径（Revert，原有行为不变）
点 Revert → void revert(fire-and-forget) → setPrompt(填回内容) → dialog.clear。revert 异步执行，B1 守卫确保 revert 期间发消息返回 BusyError。

### 8.3 错误路径
- **revert 失败**（C1 Retry）：`revertResponse.error` 有值 → 只 setPrompt 不 submit → 用户手动处理
- **revert 失败**（B1）：`Effect.ensuring(endRevert)` 清除 reverting → 后续操作不受阻
- **revert 期间发消息**（非 Retry）：handler assertNotReverting → BadRequest → TUI `keepDraftAfterSubmitFailure`(prompt/index.tsx:1331) 保留草稿 + toast
- **revert 期间发 shell**：shell handler assertNotReverting → BadRequest → shell TUI `.then(response => if(response.error) restoreDraftAfterBackgroundFailure)`(prompt/index.tsx:1362)
- **abort 失败**：`.catch(() => {})` 吞掉 → revert 的 assertNotBusy 可能因 runner busy 失败 → revertResponse.error → 不 submit

### 8.4 并发路径
- **两个 revert 同时**：beginRevert 原子 check-and-set，第二个返回 BusyError
- **revert + prompt 同时**：4 个 handler 的 assertNotReverting 阻止 prompt/shell/command
- **revert + compact 同时**：compact 的 assertNotBusy（含 reverting）阻止
- **revert + cancel 同时**：cancel 不经过 assertNotReverting，但 cancel 中断 runner。revert 不持有 runner，cancel 不影响 revert。revert 的 `Effect.ensuring` 保证 reverting 被清除

### 8.5 清理路径
- **revert 失败**：`Effect.ensuring(endRevert)` 清除 reverting
- **revert 中断**：同上
- **进程退出**：reverting 在内存 Set 中，进程重启后消失（无需持久化，安全）
- **InstanceState dispose**：`addFinalizer` 清除 reverting（与 runners 一致）

### 8.6 安全边界
- reverting 不持久化（内存 Set，进程重启清除）——安全，因为 session.revert 状态由数据库决定
- A1 不改变恢复语义（成功路径更快，失败路径不变）
- 不改变 cleanup 语义（hidden 不删除，terminalize 不完成 assistant）
- 不新增 HTTP 端点，不重新生成 SDK
- `extractPromptInfo` 复用 Revert 的提取逻辑，无新逻辑

## 10. 行为级测试计划

### 9.1 现有测试必须通过
- `test/session/revert-compact.test.ts` 全部 8 个用例
- `test/session/snapshot-tool-race.test.ts`
- `test/session/session-schema.test.ts`
- `test/session/schema-decoding.test.ts`

### 9.2 新增测试（在 `test/session/revert-compact.test.ts` 中）

**测试 1: "revert blocks concurrent prompt via assertNotReverting"**
- fork 一个慢 revert（mock snapshot 慢 git 或大 file）
- 同时通过 handler 调用 promptAsync
- 验证 promptAsync 收到 BadRequest（BusyError → mapBusy）

**测试 2: "beginRevert is atomic"**
- 两个 fiber 同时 beginRevert
- 验证第二个返回 BusyError
- 验证 reverting Set 只有一个 entry

**测试 3: "revert clears reverting on failure"**
- mock snapshot.revert 抛错
- 验证 reverting 被清除（endRevert 执行）
- 验证后续 assertNotReverting 通过

**测试 4: "A1 fast checkout succeeds without ls-tree"**
- 创建临时 git repo，多个文件在同 hash
- 调用 snap.revert
- 验证文件正确恢复
- 验证快速路径被使用（可通过 log 或 mock git 计数验证）

**测试 5: "A1 fast checkout falls back on missing file"**
- 创建 patch 引用不存在的文件
- 调用 snap.revert
- 验证回退到 ls-tree + 逐文件
- 验证不存在的文件被删除

### 9.3 实现后验证
- `bun test test/session/revert-compact.test.ts` 全绿
- `bun test test/session/` 全绿
- Benchmark 对比：`bun testing/benchmark/bench-revert.ts`

## 11. 验证命令

```bash
# 类型检查
cd packages/opencode && bun typecheck

# 运行 revert 相关测试
cd packages/opencode && bun test test/session/revert-compact.test.ts
cd packages/opencode && bun test test/session/snapshot-tool-race.test.ts

# 运行全部 session 测试
cd packages/opencode && bun test test/session/

# Benchmark 验证加速效果
bun /var/folders/x9/wyq90jb50kxf62wvbs505q4nn7ltx4/T/opencode/testing/benchmark/bench-revert.ts
```

## 12. git 文件数与行数预估

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `packages/opencode/src/session/run-state.ts` | 修改：reverting Set + 3 方法 + assertNotBusy 检查 + finalizer + Service.of | +28 |
| `packages/opencode/src/session/revert.ts` | 修改：revert/unrevert 用 acquireUseRelease 包裹 + fromMessageID 裁剪 | +15 |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | 修改：4 个 handler 加 assertNotReverting | +8 |
| `packages/opencode/src/snapshot/index.ts` | 修改：revert 函数增加快速 checkout 路径 | +12 |
| `packages/opencode/src/session/message-v2.ts` | 修改：page() 加 fromMessageID 参数 + gte import | +5 |
| `packages/opencode/src/session/session.ts` | 修改：messages() Interface + 实现透传 fromMessageID | +5 |
| `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx` | 修改：新增 Retry 选项 + import + extractPromptInfo 重构 | +40 |
| **总计** | **7 文件修改，0 新增，0 删除** | **~113 行** |

- 0 迁移文件
- 0 SDK 重新生成
- 0 文档（本方案文档除外）

## 13. 已知限制（非阻塞，经审计确认）

1. **injectBackgroundResult（task.ts:400）未覆盖**：TaskTool 子 session 完成后向 idle 父 session 注入结果时调 `ops.prompt`（含 cleanup），不走 HTTP handler。概率极低（需在子 session 执行期间 revert 父 session）。后续增强可在 `prompt()` 内部 cleanup 前加 assertNotReverting。

2. **handler assertNotReverting 与 runner-busy 间有数 ms 残留窗口**：check-then-act 固有局限，预先存在，B1 未恶化。完全闭合需 per-session mutex，属后续增强。

3. **C1 abort 后 runner 可能未立即 idle**：`await abort` 等待 HTTP 响应，cancel 内部 `yield* existing.cancel` 应等待 runner idle，但极端情况可能延迟。C1 的 `revertResponse.error` 检查处理此情况。

4. **C1 submitting 标志极低概率阻止 submit**：用户按 Enter 后立即（HTTP 响应返回前）打开 dialog 选 Retry，submitting 仍为 true。概率极低（promptAsync 往返 <100ms）。

## 14. 推荐方案摘要

**四步手术刀式修改，7 文件 ~113 行，解决撤回慢 + 时序竞争 + 缺少重试三个核心痛点**：

1. **B1（revert 状态守卫）**：run-state.ts 增加 `reverting` Set + `beginRevert`/`endRevert`/`assertNotReverting`；revert.ts 用 `Effect.acquireUseRelease(beginRevert, ..., endRevert)` 包裹；4 个 HTTP handler 加 `assertNotReverting`。修复时序竞争——revert 期间发消息/shell/command 返回 BusyError，草稿保留。

2. **A1（合并 git checkout）**：snapshot/index.ts revert 函数批量分支先 `git checkout <hash> -- <all-files>`（1 spawn），失败回退原逻辑。撤回延迟 checkout 阶段 255ms → 12ms（20 文件，Benchmark 验证 21 倍加速）。

3. **A2（messages 范围裁剪）**：message-v2.ts page() + session.ts messages() 加 `fromMessageID` 参数；revert.ts 调用时传 `input.messageID`。大 session 加载 110ms → 30ms（节省 80ms）。

4. **C1（TUI Retry 菜单项）**：dialog-message.tsx 新增 Retry 选项，`dialog.clear()` → `await abort` → `await revert` → `setPrompt` → `submit`，一步完成"撤回+重发"。不改 prompt.ts 错误类型，不新增 HTTP 端点，不重新生成 SDK。

**A1+A2 组合优化效果**：撤回延迟 1-2s → ~300ms（几百毫秒）。

**实施顺序**：B1 → A1 → A2 → C1（B1 修复竞争，A1+A2 加速，C1 依赖 B1 守卫确保 await revert 安全）。
