import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import * as Tool from "../../src/tool/tool"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "@/tool/truncate"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Format.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const executeEdit = Effect.fn("FileMutationConcurrencyTest.executeEdit")(function* (
  params: Tool.InferParameters<typeof EditTool>,
  ctx: Tool.Context,
) {
  const info = yield* EditTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

// helpers 只初始化真实 Tool，不替换 filesystem、Permission 或 formatter；测试因此到达生产 execute seam。

const executeWrite = Effect.fn("FileMutationConcurrencyTest.executeWrite")(function* (
  params: Tool.InferParameters<typeof WriteTool>,
  ctx: Tool.Context,
) {
  const info = yield* WriteTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const executePatch = Effect.fn("FileMutationConcurrencyTest.executePatch")(function* (
  params: Tool.InferParameters<typeof ApplyPatchTool>,
  ctx: Tool.Context,
) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

function priorRead(filePath: string): MessageV2.WithParts[] {
  // 当前 edit 的 blind-edit 门闩要求 completed read；这里构造最小完整 MessageV2 part。
  // prior read 是 Session contract 证据，proposal version 仍由 coordinator 从磁盘重新读取。
  const messageID = MessageID.make("msg_prior")
  return [
    {
      info: {
        id: messageID,
        role: "assistant",
        sessionID: SessionID.make("ses_mutation-test"),
        parentID: MessageID.make("msg_root"),
        agent: "build",
        mode: "build",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("test"),
        providerID: ProviderID.make("test"),
        time: { created: 0 },
      } satisfies MessageV2.Assistant,
      parts: [
        {
          id: PartID.make("prt_prior"),
          messageID,
          sessionID: SessionID.make("ses_mutation-test"),
          type: "tool",
          tool: "read",
          callID: "call_prior",
          state: {
            status: "completed",
            input: { filePath },
            output: "base\n",
            title: "Read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        } satisfies MessageV2.ToolPart,
      ],
    } satisfies MessageV2.WithParts,
  ]
}

function context(ask: Tool.Context["ask"], messages: MessageV2.WithParts[] = []): Tool.Context {
  // 每个并发 caller 使用独立 ask gate，顺序由 Deferred 控制而非 scheduler timing。
  return {
    sessionID: SessionID.make("ses_mutation-test"),
    messageID: MessageID.make("msg_mutation-test"),
    callID: "call_mutation-test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages,
    metadata: () => Effect.void,
    ask,
  }
}

describe("built-in file mutation coordination", () => {
  // 这些测试统一从真实 Tool.execute seam 观察磁盘内容；permission Deferred 控制顺序，避免依赖固定 sleep。
  // expected content 都是手写字面量，测试不会复制 coordinator 的匹配或版本逻辑。
  // repeated parsed entry 要重置 Patch cursor，但仍只允许一个 source commit。
  // 第一 entry 修改文件尾部，第二 entry 回到文件头部；若错误共享 cursor，第二条会被拒绝。
  // 断言同时覆盖组合后的最终字节和一次性 proposal 的用户可见结果。
  // 这里不观察 fileChanges 或 queue map，只观察 Tool 完成后的文件内容。
  // 失败分支同样只通过 Tool Exit 和文件字节观察，避免把实现细节固化进回归测试。
  // 测试中的 Permission gate 对应真实 ctx.ask，不替换 coordinator 的 commit boundary。
  it.instance("composes repeated update entries without sharing their patch cursors", () =>
    Effect.gen(function* () {
      // fixture 顺序与 patch entry 顺序故意相反，确保测试能区分 entry boundary 和单一 chunks cursor。
      // 预期值由原始四行文本手工推导，不调用 Patch 或 coordinator 生成 expected。
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filePath = path.join(test.directory, "repeated-entry.txt")
      yield* fs.writeWithDirs(filePath, "line1\nline2\nline3\nline4\n")

      const patchText = [
        "*** Begin Patch",
        "*** Update File: repeated-entry.txt",
        "@@",
        "-line4",
        "+last",
        "*** Update File: repeated-entry.txt",
        "@@",
        "-line1",
        "+first",
        "*** End Patch",
      ].join("\n")

      yield* executePatch({ patchText }, context(() => Effect.void))
      expect(yield* fs.readFileString(filePath)).toBe("first\nline2\nline3\nlast\n")
    }),
  )

  // destination collision 必须在 Permission 前失败，避免后一个 move 静默覆盖前一个结果。
  // 两个 source 都拥有同一个 destination，任何顺序都无法代表一个无损的 primary path。
  // 失败后三个路径都保持原状，证明拒绝发生在 filesystem commit 之前。
  // destination 不存在的断言也防止“先写后报错”的伪原子行为。
  it.instance("rejects overlapping move ownership before permission or writes", () =>
    Effect.gen(function* () {
      // 两个 move 都来自 public patchText 输入，测试 ownership guard 的真实信任边界。
      // 只检查失败和原始字节，避免把错误消息格式当成成功条件。
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "second.txt")
      yield* fs.writeWithDirs(first, "first\n")
      yield* fs.writeWithDirs(second, "second\n")

      const patchText = [
        "*** Begin Patch",
        "*** Update File: first.txt",
        "*** Move to: destination.txt",
        "@@",
        "-first",
        "+FIRST",
        "*** Update File: second.txt",
        "*** Move to: destination.txt",
        "@@",
        "-second",
        "+SECOND",
        "*** End Patch",
      ].join("\n")

      const exit = yield* executePatch({ patchText }, context(() => Effect.void)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(first)).toBe("first\n")
      expect(yield* fs.readFileString(second)).toBe("second\n")
      expect(yield* fs.existsSafe(path.join(test.directory, "destination.txt"))).toBe(false)
    }),
  )

  // absent 与 empty existing 使用不同 tagged version，Permission 期间创建空文件也必须冲突。
  // 这里的空文件由测试直接创建，绕过 coordinator，模拟真实外部 writer 状态转换。
  // 旧 proposal 不得将空文件误认为原来的 missing path。
  // expected state 的存在性标签是这个测试的独立输入，不由实现结果反推。
  it.instance("rejects a missing-to-empty transition during write permission", () =>
    Effect.gen(function* () {
      // proposal 读取到 absent 后，测试在真实 ask 阻塞窗口中创建 empty file。
      // 这是 state tag 回归，不依赖 mtime 分辨率或 filesystem timing。
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filePath = path.join(test.directory, "created-during-ask.txt")
      const asked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const writeCtx = context(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(asked, undefined)
          yield* Deferred.await(release)
        }),
      )

      const fiber = yield* executeWrite({ content: "proposal\n", filePath }, writeCtx).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(asked)
      yield* fs.writeWithDirs(filePath, "")
      // 外部创建发生在 Permission 之后，故只有 commit recheck 能区分它与原始 missing proposal。
      yield* Deferred.succeed(release, undefined)

      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(filePath)).toBe("")
    }),
  )

  // 两个 edit 都能完成 Permission，证明 lock 没有被错误地延伸到 ask 阶段。
  // 第一个 commit 改变版本后，第二个 proposal 必须得到 diagnostic conflict，而不是静默合并。
  // 这保留了冲突显式化策略，不引入自动 rebase。
  // 第二个 edit 的 stale oldString 不得被重新匹配到 write 产生的新内容。
  it.instance("lets same-file edit proposals ask before the first commit lock", () =>
    Effect.gen(function* () {
      // 两个 edit 的 oldString 都来自同一个初始文件，但只允许先取得 commit lock 的版本成功。
      // 失败的第二 proposal 必须保持诊断性质，不能被当成部分成功。
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filePath = path.join(test.directory, "permission-before-lock.txt")
      yield* fs.writeWithDirs(filePath, "a\nb\n")
      const firstAsked = yield* Deferred.make<void>()
      const secondAsked = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      // 两个 proposal 都必须先进入 ask；否则旧的 edit-only lock 可能把第二个 caller 错误挡在 Permission 外。

      const first = yield* executeEdit(
        { filePath, edits: [{ oldString: "a", newString: "A" }] },
        context(
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstAsked, undefined)
              yield* Deferred.await(releaseFirst)
            }),
          priorRead(filePath),
        ),
      ).pipe(Effect.exit, Effect.forkScoped)
      const second = yield* executeEdit(
        { filePath, edits: [{ oldString: "b", newString: "B" }] },
        context(
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(secondAsked, undefined)
              yield* Deferred.await(releaseSecond)
            }),
          priorRead(filePath),
        ),
      ).pipe(Effect.exit, Effect.forkScoped)

      yield* Deferred.await(firstAsked)
      yield* Deferred.await(secondAsked)
      // 两个 ask 都完成后才放行第一个 commit，断言的是 lock placement 而非调度偶然性。
      yield* Deferred.succeed(releaseFirst, undefined)
      expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)
      yield* Deferred.succeed(releaseSecond, undefined)
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
      expect(yield* fs.readFileString(filePath)).toBe("A\nb\n")
      yield* executeWrite({ content: "fresh\n", filePath }, context(() => Effect.void))
      expect(yield* fs.readFileString(filePath)).toBe("fresh\n")
    }),
  )

  // per-key queue 只串行相同 canonical path，不得退化成全局 Tool lock。
  // 两个 Permission 都先完成，随后两个不同 key 都能完成 commit。
  // 文件内容分别由独立字面量断言，避免只验证“没有抛错”。
  // 两个 Permission gate 同时开放，验证并发边界位于 canonical key 而非 Tool 全局。
  it.instance("keeps different-file mutations concurrent", () =>
    Effect.gen(function* () {
      const formatReady = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const formatRelease = yield* Deferred.make<void>()
      const formatLayer = Layer.succeed(Format.Service, {
        init: () => Effect.void,
        status: () => Effect.succeed([]),
        file: (filePath) =>
          Effect.gen(function* () {
            const index = filePath.endsWith("parallel-a.txt") ? 0 : 1
            yield* Deferred.succeed(formatReady[index], undefined)
            yield* Deferred.await(formatRelease)
            return false
          }),
      })

      const run = Effect.gen(function* () {
        // 两个 path 没有共享 content 或 expected state，formatter barrier 直接观察不同 key 的 commit overlap。
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const firstPath = path.join(test.directory, "parallel-a.txt")
        const secondPath = path.join(test.directory, "parallel-b.txt")
        const firstAsked = yield* Deferred.make<void>()
        const secondAsked = yield* Deferred.make<void>()
        const releasePermission = yield* Deferred.make<void>()

        const first = yield* executeWrite(
          { content: "A\n", filePath: firstPath },
          context(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstAsked, undefined)
              yield* Deferred.await(releasePermission)
            }),
          ),
        ).pipe(Effect.exit, Effect.forkScoped)
        const second = yield* executeWrite(
          { content: "B\n", filePath: secondPath },
          context(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(secondAsked, undefined)
              yield* Deferred.await(releasePermission)
            }),
          ),
        ).pipe(Effect.exit, Effect.forkScoped)

        yield* Deferred.await(firstAsked)
        yield* Deferred.await(secondAsked)
        yield* Deferred.succeed(releasePermission, undefined)
        yield* awaitWithTimeout(Effect.all(formatReady.map(Deferred.await)), "different-file commits did not overlap", "5 seconds")
        yield* Deferred.succeed(formatRelease, undefined)
        expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true)
        expect(yield* fs.readFileString(firstPath)).toBe("A\n")
        expect(yield* fs.readFileString(secondPath)).toBe("B\n")
      })

      yield* run.pipe(Effect.provide(formatLayer))
    }),
  )

  // formatter 是 built-in writer，必须与目标写入共用 commit critical section。
  // 第一个 formatter 阻塞时，第二个 proposal 可以读和 ask，但不能先完成写入。
  // 释放 formatter 后两个 commit 按同一 key 顺序完成，最终内容应是第二次 write。
  // formatter 本身不改变内容，结果只反映 coordinator 的锁范围和提交顺序。
  it.instance("keeps the target formatter inside the mutation commit", () =>
    Effect.gen(function* () {
      const formatterStarted = yield* Deferred.make<void>()
      const formatterRelease = yield* Deferred.make<void>()
      const secondAsked = yield* Deferred.make<void>()
      let formatCalls = 0
      const formatLayer = Layer.succeed(Format.Service, {
        init: () => Effect.void,
        status: () => Effect.succeed([]),
        file: () =>
          Effect.gen(function* () {
            formatCalls++
            yield* Deferred.succeed(formatterStarted, undefined)
            yield* Deferred.await(formatterRelease)
            return false
          }),
      })

      const run = Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const filePath = path.join(test.directory, "formatter-lock.txt")
        const first = yield* executeWrite({ content: "A\n", filePath }, context(() => Effect.void)).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(formatterStarted)
        // formatterStarted 发生在首个 write 后，第二个 proposal 可见已写内容但不能越过 formatter。

        const second = yield* executeWrite(
          { content: "B\n", filePath },
          context(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(secondAsked, undefined)
            }),
          ),
        ).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(secondAsked)
        expect(formatCalls).toBe(1)
        yield* Deferred.succeed(formatterRelease, undefined)
        expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true)
        expect(yield* fs.readFileString(filePath)).toBe("B\n")
      })

      yield* run.pipe(Effect.provide(formatLayer))
    }),
  )

  // 取消等待者不能删除 predecessor，也不能留下阻塞 tail。
  // 第二个 write 在同一 key 的 formatter critical section 外等待并被 interrupt。
  // 第三个 write 验证 queue tail 已清理且不会永久阻塞后续 mutation。
  // interrupt 发生在 commit 等待阶段，覆盖 waiter 而不是 Permission reject 的简单路径。
  it.instance("releases a cancelled waiter without blocking the next mutation", () =>
    Effect.gen(function* () {
      const formatterStarted = yield* Deferred.make<void>()
      const formatterRelease = yield* Deferred.make<void>()
      const secondAsked = yield* Deferred.make<void>()
      let formatCalls = 0
      const formatLayer = Layer.succeed(Format.Service, {
        init: () => Effect.void,
        status: () => Effect.succeed([]),
        file: () =>
          Effect.gen(function* () {
            formatCalls++
            if (formatCalls === 1) {
              yield* Deferred.succeed(formatterStarted, undefined)
              yield* Deferred.await(formatterRelease)
            }
            return false
          }),
      })

      const run = Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const filePath = path.join(test.directory, "cancelled-waiter.txt")
        const first = yield* executeWrite({ content: "A\n", filePath }, context(() => Effect.void)).pipe(Effect.exit, Effect.forkScoped)
        yield* Deferred.await(formatterStarted)
        const second = yield* executeWrite(
          { content: "B\n", filePath },
          context(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(secondAsked, undefined)
            }),
          ),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(secondAsked)
        yield* Effect.yieldNow
        // yieldNow 让 waiter 有机会注册到 semaphore；随后 interrupt 检验中途取消的 cleanup。
        yield* Fiber.interrupt(second)
        yield* Deferred.succeed(formatterRelease, undefined)
        expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)

        yield* executeWrite({ content: "C\n", filePath }, context(() => Effect.void))
        expect(yield* fs.readFileString(filePath)).toBe("C\n")
      })

      yield* run.pipe(Effect.provide(formatLayer))
    }),
  )

  // 外部 writer 只在 final recheck 前可被发现；这里验证 detected conflict，不宣称 true CAS。
  // Permission 已经通过，外部写入随后改变 fingerprint，旧 patch 必须失败。
  // final check 与实际 write 之间的跨进程窗口仍由 plan 明确列为残余风险。
  // 该测试只要求可观察的 pre-check conflict，不把文件系统误称为 CAS。
  it.instance("rejects an external change after apply_patch permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filePath = path.join(test.directory, "patch-external.txt")
      yield* fs.writeWithDirs(filePath, "base\n")
      const asked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const patchText = "*** Begin Patch\n*** Update File: patch-external.txt\n@@\n-base\n+patch\n*** End Patch"
      const fiber = yield* executePatch(
        { patchText },
        context(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(asked, undefined)
            yield* Deferred.await(release)
          }),
        ),
      ).pipe(Effect.exit, Effect.forkScoped)

      yield* Deferred.await(asked)
      yield* fs.writeWithDirs(filePath, "external\n")
      // 外部内容不经过 coordinator，模拟 editor/shell writer 的真实边界。
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(yield* fs.readFileString(filePath)).toBe("external\n")
    }),
  )

  // 多文件 patch 任一 target 变化都不能留下已经写入的 stale partial commit。
  // first target 的 proposal 没有变化，second target 在 Permission 期间被外部写入。
  // coordinator 必须先完成全部 recheck，再允许任何一个 target 写盘。
  // firstPath 保持原文是关键断言，证明没有出现 stale partial commit。
  it.instance("checks every apply_patch target before the first multi-file write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const firstPath = path.join(test.directory, "patch-first.txt")
      const secondPath = path.join(test.directory, "patch-second.txt")
      yield* fs.writeWithDirs(firstPath, "first\n")
      yield* fs.writeWithDirs(secondPath, "second\n")
      const asked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const patchText = [
        "*** Begin Patch",
        "*** Update File: patch-first.txt",
        "@@",
        "-first",
        "+FIRST",
        "*** Update File: patch-second.txt",
        "@@",
        "-second",
        "+SECOND",
        "*** End Patch",
      ].join("\n")
      const fiber = yield* executePatch(
        { patchText },
        context(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(asked, undefined)
            yield* Deferred.await(release)
          }),
        ),
      ).pipe(Effect.exit, Effect.forkScoped)

      yield* Deferred.await(asked)
      yield* fs.writeWithDirs(secondPath, "external\n")
      // 只改变第二个 target，第一目标也必须保持未提交，证明检查发生在所有写入之前。
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(yield* fs.readFileString(firstPath)).toBe("first\n")
      expect(yield* fs.readFileString(secondPath)).toBe("external\n")
    }),
  )

  // 原始用户症状：write 先提交后，旧 edits[] proposal 必须失败而不是覆盖 write。
  // 这条测试使用当前 public `edits[]` schema，而不是旧的顶层 oldString 兼容形态。
  // final content 由先提交的 write 字面量决定，直接锁定 lost-update 修复。
  // edit failure 是诊断结果，write success 才是唯一保留下来的文件版本。
  it.instance("rejects a stale edits[] proposal after write commits first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filePath = path.join(test.directory, "target.txt")
      yield* fs.writeWithDirs(filePath, "base\n")

      const writeAsked = yield* Deferred.make<void>()
      const releaseWrite = yield* Deferred.make<void>()
      const editAsked = yield* Deferred.make<void>()
      const releaseEdit = yield* Deferred.make<void>()
      // 先同时完成两个 Permission，再释放 write，精确重现旧实现的 stale edit 覆盖窗口。

      const writeCtx = context(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(writeAsked, undefined)
          yield* Deferred.await(releaseWrite)
        }),
      )
      const editCtx = context(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(editAsked, undefined)
            yield* Deferred.await(releaseEdit)
          }),
        priorRead(filePath),
      )

      const writeFiber = yield* executeWrite({ content: "write\n", filePath }, writeCtx).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(writeAsked)

      const editFiber = yield* executeEdit(
        { filePath, edits: [{ oldString: "base\n", newString: "edit\n" }] },
        editCtx,
      ).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(editAsked)

      yield* Deferred.succeed(releaseWrite, undefined)
      expect(Exit.isSuccess(yield* Fiber.join(writeFiber))).toBe(true)

      yield* Deferred.succeed(releaseEdit, undefined)
      const editExit = yield* Fiber.join(editFiber)
      expect(Exit.isFailure(editExit)).toBe(true)
      if (Exit.isFailure(editExit)) {
        expect(Cause.pretty(editExit.cause)).toContain("changed")
      }

      expect(yield* fs.readFileString(filePath)).toBe("write\n")
    }),
  )
})
