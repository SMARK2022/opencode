import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Permission } from "../../src/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
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
  const assistant: SessionV1.Assistant = {
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
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  text?: string
  error?: NonNullable<SessionV1.Assistant["error"]>
  toolError?: string
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done", opts?.error, opts?.toolError)
      }),
  }
}

function reply(
  input: SessionPrompt.PromptInput,
  text: string,
  error?: NonNullable<SessionV1.Assistant["error"]>,
  toolError?: string,
): SessionV1.WithParts {
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
      error,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      ...(toolError
        ? [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "tool" as const,
              tool: "read",
              callID: "call-1",
              state: {
                status: "error" as const,
                input: { filePath: "/external" },
                error: toolError,
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ]
        : []),
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
        // #200：hidden 代理不出现在子代理描述列表，防止模型探测保留协议代理
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
      // task_id 保留会话身份与模型变体，权限按本轮委派重新计算。
      const permission = [{ permission: "external_directory", pattern: "/saved/*", action: "allow" }] as const
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", permission })
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
      // 从 Session owner 重读，检查旧 grant 已被本轮权限持久化替换。
      const resumed = yield* sessions.get(child.id)
      expect(resumed.permission).not.toEqual(expect.arrayContaining([...permission]))
      expect(Permission.evaluate("external_directory", "/saved/file", resumed.permission ?? []).action).toBe("ask")
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute surfaces child errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      // 真实 Task 中的父默认 ask 也须覆盖旧会话 grant，保留 source 的更强审批。
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "build",
        model: { id: ref.modelID, providerID: ref.providerID },
        time: Date.now(),
      })
      yield* sessions.setPermission({
        sessionID: chat.id,
        permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            // 父 Session 固定 build、目标为 general；plan 独立证明 ctx 才是委派权限源。
            agent: "plan",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "",
                error: new SessionV1.APIError({ message: "Network connection lost", isRetryable: false }).toObject(),
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      expect(child).toBeDefined()
      // 不调用 derive 计算期望：真实 Task 创建出的子会话必须包含固定的 plan 编辑禁令。
      expect(child?.permission).toEqual(expect.arrayContaining([{ permission: "edit", pattern: "*", action: "deny" }]))
      expect(Permission.evaluate("edit", "/some/file.ts", child?.permission ?? []).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/tmp/allowed/file", child?.permission ?? []).action).toBe("ask")
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(`Subagent failed (task_id: ${child?.id}): Network connection lost`)
    }),
  )

  it.instance("execute surfaces terminal child tool errors with a resumable task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect external directory",
            prompt: "read the external directory",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: stubOps({
                text: "I will inspect the directory.",
                toolError: "The user rejected permission to use this specific tool call.",
              }),
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected task failure")
      const child = (yield* sessions.children(chat.id))[0]
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error("expected Error defect")
      expect(failure.message).toBe(
        `Subagent failed (task_id: ${child?.id}): The user rejected permission to use this specific tool call.`,
      )
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
      // #200：bypassAgentCheck 跳过用户审批，但 hidden/保留名仍不可被模型调用
      // #200：Cause.squash 提取失败原因，验证错误信息包含 Agent type is not available
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
        // #200：项目配置 unhide + "*": allow 仍被保留名检查拒绝，安全不变量优先于配置
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
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      // #507：ses* 但 DB 不存在：新建独立上下文，并 notice 标明非法 provided
      // notice 字段固定：type/reason/provided/action，供模型识别「非法 ID → 独立新上下文」
      // 四属性逐一断言：任一字段重命名/丢失都会在此暴露，避免 notice 形态静默漂移。
      expect(result.output).toContain('type="task_id"')
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain('provided="ses_missing"')
      expect(result.output).toContain('action="created_new"')
      // 系统分配的 sessionId 绝不能回写成调用方提供的非法串
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  // #507 INV-04：裸 26-body 补 ses_ 后若 session 存在则 resume，不得 brand 失败也不得新建
  it.instance("execute resumes when task_id is the 26-char body of an existing session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Body resume child" })
      // 生成器 ID = "ses_" + 26 body；模型漏前缀时应命中同一 session
      // slice("ses_".length) 即去掉固定 4 字符前缀，剩下的正是补全候选要拼回去的 body。
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
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      // 合法恢复路径禁止 illegal notice，避免模型误判为新上下文
      expect(result.output).not.toContain('reason="invalid_provided"')
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  // #507 INV-03/09：非 ses* 乱串不得让 SessionID.make 炸掉工具；应 create + invalid notice
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
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain('action="created_new"')
      // provided 中的引号须 attribute-escape，不能原样打断 notice
      // escape 先替换 & 再替换 "，断言值 &quot; 同时锁定了转义发生与替换顺序。
      expect(result.output).toContain('provided="not-a-session&quot;with-quote"')
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  // #507 INV-01：省略 task_id 是正常新建，不得出现 invalid_provided notice
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

      // 省略参数时只有骨架与 task_result，没有 task_id 类型 notice
      // omit 与 invalid 的 notice 差异是模型可区分合同：只有「传了但没用上」才需要引导。
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(result.output).not.toContain('reason="invalid_provided"')
      expect(result.output).not.toContain('type="task_id"')
    }),
  )

  // #507 INV-02/08：完整合法 resume 骨架保持兼容，且无 illegal notice
  it.instance("execute resumes full task_id without invalid notice", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const sessions = yield* Session.Service
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
      // 与 26-body 用例互补：直连命中不经过补全分支，两条 resume 路径都不产生 notice。
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).not.toContain('reason="invalid_provided"')
    }),
  )

  // #507 INV-05：26-body 补前缀后仍不存在 → 与其他 invalid 相同，create + notice
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
      // miss 后与乱串同归 invalid_provided——验证补全分支不会制造第三种结果形态。
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(result.metadata.sessionId).toBe(kids[0]?.id)
      expect(result.output).toContain('reason="invalid_provided"')
      expect(result.output).toContain(`provided="${body}"`)
    }),
  )

  // #507 INV-06：非法 task_id 导致的新建必须走 summary 默认，不能因 raw task_id 真值伪装 resume
  it.instance("execute uses summary inspected_files default when invalid task_id creates", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "with-context", onPrompt: (input) => (seen = input) })
      // 最小已完成 read part：非法 task_id 新建应默认 summary 并注入 parent_context
      const readPart = {
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool" as const,
        tool: "read",
        callID: "call-read-1",
        state: {
          status: "completed" as const,
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
      const messages: SessionV1.WithParts[] = [
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
      // 旧缺陷回照：若 inspected 默认仍看 raw task_id 真值，本用例会走 none 而丢 parent_context。
      expect(result.output).toContain('reason="invalid_provided"')
      // prompt parts 中必须出现 parent_context，证明 inspected 默认是 summary 而非 none
      const parentCtx = seen?.parts.find(
        (part) => part.type === "text" && "text" in part && String(part.text).includes("<parent_context>"),
      )
      expect(parentCtx).toBeDefined()
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance("execute records the subagent and tightens permissions from the executing parent agent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const agent = yield* Agent.Service
      const general = yield* agent.get("general")
      const { chat, assistant } = yield* seed()
      yield* sessions.setAgentModel({
        sessionID: chat.id,
        agent: "build",
        model: { id: ref.modelID, providerID: ref.providerID },
        time: Date.now(),
      })
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

      // 持久化父代理为 build，本轮 ctx.agent 为 auto；子会话记录实际执行的 general。
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
      const parentRuntimePermission = [{ permission: "read", pattern: "/parent-blocked/*", action: "deny" }] as const
      // 旧子会话创建后更新父 Session，恢复必须读取最新的持久化 runtime ceiling。
      yield* sessions.setPermission({
        sessionID: chat.id,
        permission: parentRuntimePermission,
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

      expect(resumed.id).toBe(child.id)
      expect(resumed.permission).toEqual(expect.arrayContaining([...parentRuntimePermission]))
      expect(Permission.evaluate("read", "/parent-blocked/file.ts", effective).action).toBe("deny")
      expect(Permission.evaluate("bash", "git add .", effective).action).toBe("auto")
      expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
    }),
  )

  it.instance(
    "execute keeps primary tool denies at least as strict as parent admission ceilings",
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

        // primary_tools 在目标中是子代理禁令，不能被父 auto ceiling 覆盖。
        // reviewer 允许 task，bash 则必须保持配置给出的更严格 deny。
        expect(Permission.evaluate("bash", "git add .", child.permission ?? []).action).toBe("deny")
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
        const agent = yield* Agent.Service
        const reviewer = yield* agent.get("reviewer")
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
        const effective = Permission.merge(reviewer.permission, child.permission ?? [])
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        // 默认能力留在代理规则中；合并真实 overlay 后仍须保留原有审批规则与配置禁令。
        expect(effective).toEqual(
          expect.arrayContaining([
            { permission: "doom_loop", pattern: "*", action: "ask" },
            { permission: "external_directory", pattern: "*", action: "ask" },
            { permission: "question", pattern: "*", action: "deny" },
            { permission: "plan_enter", pattern: "*", action: "deny" },
            { permission: "plan_exit", pattern: "*", action: "deny" },
            { permission: "read", pattern: "*.env", action: "ask" },
            { permission: "read", pattern: "*.env.*", action: "ask" },
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "read",
              pattern: "*",
              action: "deny",
            },
          ]),
        )
        expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
        expect(Permission.evaluate("todowrite", "anything", effective).action).toBe("deny")
        expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
        expect(Permission.evaluate("read", "README.md", effective).action).toBe("deny")
        expect(seen?.tools).toBeUndefined()
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
      // 检查实际默认模式广告，不能只依赖完整 Parameters 的 schema 快照。
      expect(def.jsonSchema?.properties?.inspected_files).toMatchObject({ enum: ["none", "summary"] })
      expect(def.jsonSchema?.properties?.background).toBeUndefined()

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

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
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
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
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
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
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

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // 捕获真实后台完成回调送到 Prompt seam 的输入；等待信号而不是猜测后台调度时间。
      const resumed = yield* Deferred.make<SessionPrompt.PromptInput>()

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
                input.sessionID === chat.id
                  ? Deferred.succeed(resumed, input).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed(reply(input, "background done")),
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
      // 后台结果经公开prompt入口恢复；该入口负责创建新消息前的撤回清理，不另造loop接线。
      const input = yield* awaitWithTimeout(Deferred.await(resumed), "parent resume was not requested")
      expect(input.sessionID).toBe(chat.id)
      expect(JSON.stringify(input.parts)).toContain("Background task completed: inspect bug")
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

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
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
  // 验证空文本触发 nudge：首轮 prompt 返回空文本时，工具内部用 ops.prompt
  // 注入一轮温和提醒让子 agent 至少回应任务需求；第二轮返回的摘要文本
  // 作为最终 output，主 agent 因此不再盲目重试整个任务。
  it.instance("injects a nudge round when sub-agent produces no text output", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let promptCalls = 0
      // 首次 prompt 返回空文本模拟子 agent 探索后未产出；
      // nudge 注入后第二次返回有效文本
      const inputs: SessionPrompt.PromptInput[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            promptCalls++
            inputs.push(input)
            return reply(input, promptCalls === 1 ? "" : "forced summary")
          }),
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
      expect(inputs[1]).toMatchObject({
        sessionID: inputs[0]?.sessionID,
        model: inputs[0]?.model,
        agent: inputs[0]?.agent,
        variant: "xhigh",
        parts: [
          {
            type: "text",
            synthetic: true,
            text: "No text output was produced in your previous turn. Please provide a text response to the task above.",
          },
        ],
      })
      expect(inputs[1]?.messageID).not.toBe(inputs[0]?.messageID)
    }),
  )

  // 补提醒也必须传播既有错误，部分文本不能掩盖模型或工具失败。
  it.instance("propagates assistant and tool errors from the nudge round", () =>
    Effect.gen(function* () {
      for (const toolError of [false, true]) {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let promptCalls = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              promptCalls++
              if (promptCalls === 1) return reply(input, "")
              return reply(
                input,
                "partial response",
                toolError
                  ? undefined
                  : new SessionV1.APIError({ message: "nudge failed", isRetryable: false }).toObject(),
                toolError ? "nudge failed" : undefined,
              )
            }),
        }
        const exit = yield* def
          .execute(
            { description: "inspect bug", prompt: "inspect the cache", subagent_type: "general" },
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
          .pipe(Effect.exit)
        expect(promptCalls).toBe(2)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("nudge failed")
          expect(Cause.pretty(exit.cause)).toContain("Subagent failed (task_id:")
        }
      }
    }),
  )

  // 验证有文本时零干扰：首轮已有文本输出则不注入 nudge，
  // prompt 恰好调用一次——保证正常路径没有额外 token 开销。
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

  // 验证两级兜底：nudge 后仍为空时回退静态提示串，
  // 提示中带 task_id 恢复指引，主 agent 可据此 resume 而非重复派发。
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

  // 验证 abort 语义：abort 已触发时跳过 nudge——已 aborted 的 signal
  // 不会再触发 abort 事件，新 runner 无法被取消，继续 nudge 只会
  // 浪费 token；此时直接走静态兜底并让主 agent 自行决定是否恢复。
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
