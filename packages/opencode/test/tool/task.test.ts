import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, opts?.text ?? "done")),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)
        expect(first).not.toContain("permission-reviewer")

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute rejects hidden subagents even when permission checks are bypassed", () =>
    Effect.gen(function* () {
      // bypassAgentCheck skips the normal user permission prompt for internal
      // task resumes, but hidden/reserved agent names must still be unavailable
      // to model-authored task calls.
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          {
            description: "review permission",
            prompt: "approve this command",
            subagent_type: "permission-reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps(), bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error instanceof Error ? error.message : String(error)).toContain("Agent type is not available")
      }
    }),
  )

  it.instance(
    "execute rejects permission reviewer even if project config unhides it",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* def
          .execute(
            {
              description: "review permission",
              prompt: "approve this command",
              subagent_type: "permission-reviewer",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps(), bypassAgentCheck: true },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    {
      config: {
        agent: {
          "permission-reviewer": {
            mode: "primary",
            hidden: false,
            permission: { "*": "allow" },
          },
        },
      },
    },
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
        loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "done")),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      // ses* 但 DB 不存在：新建独立上下文，并 notice 标明非法 provided
      // notice 字段固定：type/reason/provided/action，供模型识别「非法 ID → 独立新上下文」
      expect(result.output).toContain('type="task_id"')
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain('provided="ses_missing"')
      expect(result.output).toContain('action="created_new"')
      // 系统分配的 sessionId 绝不能回写成调用方提供的非法串
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  // INV-04：裸 26-body 补 ses_ 后若 session 存在则 resume，不得 brand 失败也不得新建
  it.instance("execute resumes when task_id is the 26-char body of an existing session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Body resume child" })
      // 生成器 ID = "ses_" + 26 body；模型漏前缀时应命中同一 session
      const body = child.id.slice("ses_".length)
      expect(body.length).toBe(26)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed-body", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "continue prior subagent work",
          subagent_type: "general",
          task_id: body,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // resume 成功：metadata 与 prompt 的 session 必须是原 child，不是新建 ID
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      // 合法恢复路径禁止 illegal notice，避免模型误判为新上下文
      expect(result.output).not.toContain('reason="invalid_provided"')
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  // INV-03/09：非 ses* 乱串不得让 SessionID.make 炸掉工具；应 create + invalid notice
  it.instance("execute creates a child for non-ses task_id without brand failure", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "fresh", onPrompt: (input) => (seen = input) })
      // 含引号以锁定 notice attribute escape（INV-07）
      const provided = 'not-a-session"with-quote'

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "start work without a real task id",
          subagent_type: "general",
          task_id: provided,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 非 ses* 输入：execute 必须成功完成（无 brand Die），并只创建一个 child
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(kids[0]?.id)
      // 主键永远是系统 ses_ ID，从不把非法 provided 当 session 主键
      expect(result.metadata.sessionId).not.toBe(provided)
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain('action="created_new"')
      // provided 中的引号须 attribute-escape，不能原样打断 notice
      expect(result.output).toContain('provided="not-a-session&quot;with-quote"')
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  // INV-01：省略 task_id 是正常新建，不得出现 invalid_provided notice
  it.instance("execute creates without invalid notice when task_id is omitted", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({ text: "omit-ok" })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "fresh subagent",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 省略参数时只有 task_id 行与 task_result，没有 task_id 类型 notice
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(result.output).not.toContain('reason="invalid_provided"')
      expect(result.output).not.toContain('type="task_id"')
    }),
  )

  // INV-02/08：完整合法 resume 骨架保持兼容，且无 illegal notice
  it.instance("execute resumes full task_id without invalid notice", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Full id child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({ text: "full-resume" })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "resume with full id",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 完整 ID 命中：sessionId 不变，且无 invalid notice
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).not.toContain('reason="invalid_provided"')
    }),
  )

  // INV-05：26-body 补前缀后仍不存在 → 与其他 invalid 相同，create + notice
  it.instance("execute creates for unknown 26-char body with invalid notice", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps({ text: "unknown-body" })
      // 12 hex + 14 base62 形态的占位 body，保证长度门闸触发 ses_ 候选
      const body = "0".repeat(12) + "a".repeat(14)
      expect(body.length).toBe(26)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "no matching body",
          subagent_type: "general",
          task_id: body,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 26 乱串：触发 body 候选但 get miss，仍 create 且 notice 回显 provided body
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(kids[0]?.id)
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain(`provided="${body}"`)
    }),
  )

  // INV-06：非法 task_id 导致的新建必须走 summary 默认，不能因 raw task_id 真值伪装 resume
  it.instance("execute uses summary inspected_files default when invalid task_id creates", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "with-context", onPrompt: (input) => (seen = input) })
      // 最小已完成 read part：非法 task_id 新建应默认 summary 并注入 parent_context
      const readPart: MessageV2.ToolPart = {
        id: PartID.ascending(),
        type: "tool",
        tool: "read",
        callID: "call-read-1",
        sessionID: chat.id,
        messageID: assistant.id,
        state: {
          status: "completed",
          input: { filePath: "/tmp/repo/src/a.ts" },
          output: "ok",
          title: "Read",
          metadata: {
            read: {
              path: "/tmp/repo/src/a.ts",
              canonicalPath: "/tmp/repo/src/a.ts",
              start: 1,
              end: 20,
              total: 20,
              size: 100,
              modified: "2026-01-01 00:00:00",
              modifiedMs: 1,
            },
          },
          time: { start: Date.now(), end: Date.now() },
        },
      }
      const messages: MessageV2.WithParts[] = [
        {
          info: assistant,
          parts: [readPart],
        },
      ]

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "use parent context",
          subagent_type: "general",
          task_id: "not-a-real-id",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages,
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 非法 ID 新建仍应带 invalid notice
      expect(result.output).toContain('reason="invalid_provided"')
      // prompt parts 中必须出现 parent_context，证明 inspected 默认是 summary 而非 none
      const parentCtx = seen?.parts.find(
        (part) => part.type === "text" && "text" in part && String(part.text).includes("<parent_context>"),
      )
      expect(parentCtx).toBeDefined()
    }),
  )

  it.instance("execute records the subagent and tightens permissions from the executing parent agent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agent = yield* Agent.Service
      const general = yield* agent.get("general")
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const child = yield* sessions.get(result.metadata.sessionId)
      const effective = Permission.merge(general.permission, child.permission ?? [])

      // ctx.agent 是本轮真实委派来源；child session 记录真实执行 subagent。
      expect(child.agent).toBe("general")
      expect(Permission.evaluate("bash", "git add .", effective).action).toBe("auto")
      expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
      expect(seen?.agent).toBe("general")
    }),
  )

  it.instance("execute recomputes an existing task session permission when resumed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agent = yield* Agent.Service
      const general = yield* agent.get("general")
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        permission: [{ permission: "external_directory", pattern: "/outside/project/*", action: "allow" }],
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "auto",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const resumed = yield* sessions.get(result.metadata.sessionId)
      const effective = Permission.merge(general.permission, resumed.permission ?? [])

      expect(Permission.evaluate("bash", "git add .", effective).action).toBe("auto")
      expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
    }),
  )

  it.instance(
    "execute keeps primary tool allowances below parent permission ceilings",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "auto",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)

        // primary_tools 给 subagent 临时补工具能力，但它不能排在 parent auto ceiling
        // 后面把 reviewer 边界改回 allow。
        expect(Permission.evaluate("bash", "git add .", child.permission ?? []).action).toBe("auto")
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash"],
        },
      },
    },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(Permission.evaluate("external_directory", "/tmp/outside", child.permission ?? []).action).toBe("ask")
        expect(child.permission).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
        expect(child.permission).toContainEqual({ permission: "bash", pattern: "*", action: "allow" })
        expect(child.permission).toContainEqual({ permission: "read", pattern: "*", action: "allow" })
        expect(child.permission).not.toContainEqual({ permission: "task", pattern: "*", action: "allow" })
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("state: running")
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent resume loop", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.noReply
                  ? Effect.gen(function* () {
                      const user = yield* sessions.updateMessage({
                        id: input.messageID ?? MessageID.ascending(),
                        role: "user",
                        sessionID: input.sessionID,
                        agent: input.agent ?? "build",
                        model: input.model ?? ref,
                        time: { created: Date.now() },
                      })
                      const parts = input.parts.map((part) => ({
                        ...part,
                        id: part.id ?? PartID.ascending(),
                        messageID: user.id,
                        sessionID: input.sessionID,
                      }))
                      yield* Effect.forEach(parts, (part) => sessions.updatePart(part), { discard: true })
                      return { info: user, parts }
                    })
                  : Effect.succeed(reply(input, "background done")),
              loop: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  // [local-smark] 空结果温和提醒：子 agent 未产出文本时注入一轮 nudge，
  // 让它至少回应任务需求。nudge 不限制工具/不覆盖指令/不强加格式。
  it.instance("injects a nudge round when sub-agent produces no text output", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      // 首次 prompt 返回空文本模拟子 agent 探索后未产出；
      // nudge 注入后第二次返回有效文本
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            promptCalls++
            return reply(input, promptCalls === 1 ? "" : "forced summary")
          }),
        loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "done")),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // nudge 触发：prompt 被调用两次，结果含 nudge 产出的文本
      expect(promptCalls).toBe(2)
      expect(result.output).toContain("forced summary")
    }),
  )

  it.instance("does not inject nudge when sub-agent produces text", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      const promptOps = stubOps({
        text: "normal result",
        onPrompt: () => {
          promptCalls++
        },
      })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // 有文本时 nudge 不触发：prompt 仅调用一次
      expect(promptCalls).toBe(1)
      expect(result.output).toContain("normal result")
    }),
  )

  it.instance("falls back to static string with resume hint when nudge also produces no text", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      // 两轮都返回空文本，nudge 仍空时回退含 resume 提示的静态字符串
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            promptCalls++
            return reply(input, "")
          }),
        loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "")),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // nudge 触发但仍空：prompt 调用两次，回退含 resume 提示
      expect(promptCalls).toBe(2)
      expect(result.output).toContain("Subagent produced no output")
      expect(result.output).toContain("You may resume this task")
    }),
  )

  it.instance("does not inject nudge when abort signal fires before nudge", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      let promptCalls = 0
      // 首次 prompt 阻塞直到 cancel resolve，返回空文本模拟 abort 后的 lastAssistant
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            promptCalls++
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, ""))),
        loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "")),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      // 等待首次 prompt 被调用后 abort；cancel resolve 使首次 prompt 返回空文本
      yield* Effect.promise(() => ready.promise)
      abort.abort()
      yield* Effect.promise(() => cancelled.promise)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        // abort 已发生：nudge 不触发，prompt 仅调用一次，回退静态提示
        expect(promptCalls).toBe(1)
        expect(exit.value.output).toContain("Subagent produced no output")
      }
    }),
  )
})
