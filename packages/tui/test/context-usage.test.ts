import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createBindingLookup } from "@opentui/keymap/extras"
import { registerCommaBindings, registerTimedLeader } from "@opentui/keymap/addons"
import { createTestKeymap, type TestKeymapEvent, type TestKeymapTarget } from "@opentui/keymap/testing"
import { estimate } from "@opencode-ai/core/util/token"
import { TuiKeybind } from "../src/config/keybind"
import { tmpdir } from "./fixture/fixture"
import type { Agent, Message, Part, Provider, Session, TextPart } from "@opencode-ai/sdk/v2"
import { computeContextData, filterCompactedMessages, resolveToolDescriptions, type ComputeContextDataInput } from "../src/util/context-usage"
import TOOL_CATALOG from "../src/util/tool-definition-catalog.json"
import { TaskPrompt } from "@opencode-ai/core/tool/task-prompt"
import { contextUsageDetailLines, contextUsageFooter, contextUsageResource, registerContextUsageKeys } from "../src/routes/session/context-usage"

// 窗口/输入/输出故意不相等，才能让测试区分模型预留与压缩缓冲而非只验证零差额。
const provider: Provider = {
  id: "test",
  name: "Test",
  source: "custom",
  env: [],
  options: {},
  models: {
    model: {
      id: "model",
      providerID: "test",
      api: { id: "model", url: "https://example.com/model", npm: "@ai-sdk/openai" },
      name: "Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      // 输出 100 与 context-input 的 100 相等但来源独立，测试分别锁定两栏，不能合并成一个 200。
      limit: { context: 20_000, input: 19_900, output: 100 },
      status: "active",
      options: {},
      headers: {},
    },
  },
}

// tools 保留 undefined 与显式映射的区别；缺省广告全部工具不能被空对象替代。
function user(id: string, tools?: Record<string, boolean>): Message {
  return {
    id,
    sessionID: "s",
    role: "user",
    time: { created: Number(id) },
    agent: "general",
    model: { providerID: "test", modelID: "model" },
    tools,
  } as Message
}

// 摘要父 ID 指向 compaction 用户消息，测试不能用无父关联的 summary 伪造裁剪边界。
function assistant(id: string, parentID: string, summary = false): Message {
  return {
    id,
    sessionID: "s",
    role: "assistant",
    time: { created: Number(id), completed: Number(id) },
    parentID,
    modelID: "model",
    providerID: "test",
    mode: "general",
    agent: "general",
    path: { cwd: ".", root: "." },
    summary,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    // summary fixture 必须同时有 finish；缺少这个字段只会测试未完成轮次，无法验证真实裁剪。
    finish: "stop",
  } as Message
}

// 构造 TextPart：保留 text 判别，展开后 synthetic/ignored 仍属于文本部件。
function text(messageID: string, value: string): TextPart {
  return {
    id: `${messageID}-text`,
    sessionID: "s",
    messageID,
    type: "text",
    text: value,
  }
}

describe("context usage", () => {
  test("confirmed allocation composes input history and live output on the panel path", async () => {
    const inputBreakdown = {
      system: 300, instructions: 100, skills: 0, tools: 100,
      messages: { userText: 50, assistantText: 80, reasoning: 60, toolInput: 40, toolOutput: 70, attachments: 100, total: 500 },
    }
    const finish: Part = {
      id: "sf", sessionID: "s", messageID: "2", type: "step-finish", reason: "stop", cost: 0,
      tokens: { input: 300, output: 150, reasoning: 50, cache: { read: 60, write: 40 } }, inputChars: 1000, inputBreakdown,
    }
    const request: NonNullable<Session["request"]> = {
      messageID: "1", assistantID: "2", input: 4000, output: 300, cost: 2, stepInput: 400, stepOutput: 200,
      model: { providerID: "test", modelID: "model", contextLimit: 20000 },
      inputEstimate: { input: 250, bodyChars: 1000, confirmed: true, charsPerToken: 4, inputBreakdown },
    }
    const session: Session = {
      id: "s", slug: "s", projectID: "p", directory: ".", title: "s", version: "1", time: { created: 0, updated: 0 },
      tokens: { input: 9000, output: 700, reasoning: 30, cache: { read: 100, write: 20 } }, cost: 3, request,
    }
    const input: ComputeContextDataInput = {
      messages: [user("1"), assistant("2", "1")], parts: { "1": [text("1", "short")], "2": [text("2", "abcdefghijkl"), finish] },
      session, providers: [provider], paths: { cwd: process.cwd() }, instructionFiles: [], skills: [], toolDefinitions: [],
    }
    const data = await computeContextData(input)
    // provider input 含缓存共 400，不能用旧 prepared 的 250 或输入密度 4 重解释分类。
    expect(data.categories.find((item) => item.name === "System prompt")?.tokens).toBe(120)
    expect(data.categories.find((item) => item.name === "Instructions")?.tokens).toBe(40)
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBe(40)
    expect(data.details.messages).toMatchObject({ assistantText: 182, reasoning: 74, toolCalls: 16, attachments: 40 })
    expect(data.details.usage).toMatchObject({ input: 9000, output: 700, reasoning: 30, cacheRead: 100, cacheWrite: 20, total: 9850, cost: 3 })
    const native = await computeContextData({ ...input,
      messages: input.messages.map((message) => message.role === "assistant"
        ? { ...message, tokens: finish.tokens, inputEstimate: request.inputEstimate } : message),
      parts: { "2": [text("2", "abcdefghijkl")] },
    })
    expect(native.details.messages).toMatchObject({ assistantText: 182, reasoning: 74, toolCalls: 16 })
    const estimate = { input: 777, bodyChars: 1554, confirmed: false, charsPerToken: 2, inputBreakdown, afterPartID: "sf" }
    const pending = await computeContextData({ ...input,
      messages: input.messages.map((message) => message.role === "assistant"
        ? { ...message, time: { created: 2 }, inputEstimate: estimate } : message),
      session: { ...session, request: { ...request, estimatedInput: 777, inputEstimate: estimate } },
    })
    // 新快照的 system=150；旧 finish 的 120 及其输出不能继续占据下一轮分类。
    expect(pending.categories.find((item) => item.name === "System prompt")?.tokens).toBe(150)
    expect(pending.details.messages).toMatchObject({ assistantText: 40, reasoning: 30, toolCalls: 20 })
    const zeroBreakdown = { system: 0, instructions: 0, skills: 0, tools: 0,
      messages: { userText: 0, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 0, total: 0 } }
    const zero = await computeContextData({ ...input, messages: [], parts: {},
      session: { ...session, request: { ...request, assistantID: "evicted", estimatedInput: 0,
        inputEstimate: { input: 0, bodyChars: 0, confirmed: false, inputBreakdown: zeroBreakdown } } },
    })
    expect(zero.categories.filter((item) => !item.isDeferred).map((item) => item.tokens)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(zero.details.usage.total).toBe(9850)
    const confirmed = await computeContextData({ ...input, messages: [], parts: {},
      session: { ...session, request: { ...request, assistantID: "evicted" } },
    })
    expect(confirmed.categories.find((item) => item.name === "System prompt")?.tokens).toBe(120)
    expect(confirmed.details.usage.total).toBe(9850)
  })

  test("subscribes to in-place text, pending input, and confirmed token changes", async () => {
    const session: Session = {
      id: "ses_context", slug: "context", projectID: "p", directory: ".", title: "Session", version: "1",
      time: { created: 0, updated: 0 }, permission: [],
    }
    const mounted = createRoot((dispose) => {
      const [store, setStore] = createStore({
        messages: [user("1"), assistant("2", "1"), assistant("3", "1")].map((message) => ({ ...message, sessionID: session.id })),
        parts: {
          "1": [text("1", "abcd")],
          "2": [{ id: "raw", sessionID: "s", messageID: "2", type: "tool" as const, callID: "call", tool: "bash",
            state: { status: "pending" as const, input: {}, raw: "" } }],
          "3": [{ id: "sf", sessionID: "s", messageID: "3", type: "step-finish" as const, reason: "stop", cost: 0,
            tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
        },
        session,
        providers: [provider], paths: { cwd: process.cwd() }, instructionFiles: [], skills: [], toolDefinitions: [{ name: "read", text: "read" }],
      })
      // 挂载生产 helper 的唯一 resource，不能在测试中复制 JSON 快照或计算公式。
      const [data] = contextUsageResource(() => store)
      let notify: ((value: NonNullable<ReturnType<typeof data>>) => void) | undefined
      createComputed(() => {
        // refreshing 的旧值不是新一轮结果；只在真实 resource 完成时交付观察值。
        if (data.state !== "ready") return
        const value = data()
        if (value) notify?.(value)
      })
      const next = () => new Promise<NonNullable<ReturnType<typeof data>>>((resolve) => { notify = resolve })
      return { dispose, setStore, next }
    })
    try {
      const initial = await mounted.next()
      expect(initial.details.toolDefs.map((item) => item.name)).toEqual(["read"])
      // 原位持久权限更新保持 Session/消息身份不变，必须由现有 tracked snapshot 捕获。
      const permissionChanged = mounted.next()
      mounted.setStore("session", "permission", [{ permission: "read", pattern: "*", action: "deny" }])
      expect((await permissionChanged).details.toolDefs).toEqual([])
      // 数组身份与长度不变，只替换 text 字段，必须被 tracked 快照捕获。
      const textChanged = mounted.next()
      mounted.setStore("parts", "1", 0, "text", "abcdefghijkl")
      expect((await textChanged).details.messages.userText).toBe(3)
      // bus raw delta 更新嵌套 pending state，不能依赖 Part 数组重新赋值。
      const rawChanged = mounted.next()
      mounted.setStore("parts", "2", 0, "state", "raw", "abcdefgh")
      expect((await rawChanged).details.messages.toolCalls).toBe(initial.details.messages.toolCalls + 2)
      // 确认用量原位变化同样刷新 footer；之前结果是快照，不随 store 变动。
      const usageChanged = mounted.next()
      mounted.setStore("parts", "3", 0, "tokens", "input", 25)
      expect((await usageChanged).details.usage.input).toBe(25)
      expect(initial.details.usage.input).toBe(10)
    } finally { mounted.dispose() }
    // 默认及用户覆盖都走真实 keymap dispatch；配置映射只提供 app.exit 的按键，不复制面板处理逻辑。
    for (const custom of [false, true]) {
      // 官方纯 host 保留真实序列和传播状态，测试不用 renderer 或伪造不存在的旧 keybind.match。
      const harness = createTestKeymap({ defaultKeys: true })
      const offComma = registerCommaBindings(harness.keymap)
      const offLeader = registerTimedLeader(harness.keymap, { trigger: TuiKeybind.LeaderDefault, name: "leader", timeoutMs: 2000 })
      const lookup = createBindingLookup<TestKeymapTarget, TestKeymapEvent>({
        app_exit: custom ? { key: "ctrl+z", preventDefault: false, fallthrough: true } : TuiKeybind.defaultValue("app_exit"),
      }, { commandMap: TuiKeybind.CommandMap })
      let closed = 0
      let exited = 0
      const close = () => { closed++ }
      // 真正的全局 app.exit 同时存在，不能只测单独面板 layer 后假定应用不会退出。
      const offGlobal = harness.keymap.registerLayer({
        commands: [{ name: "app.exit", run: () => { exited++ } }],
        bindings: lookup.gather("app_exit", ["app.exit"]),
      })
      const panel = createRoot((dispose) => {
        const [popup, setPopup] = createSignal(false)
        registerContextUsageKeys(harness.keymap, {
          bindings: () => lookup.gather("app_exit", ["app.exit"]), enabled: () => !popup(), onClose: close,
        })
        return { dispose, setPopup }
      })
      try {
        await Promise.resolve()
        expect(harness.keymap.getActiveKeys({ includeBindings: true }).flatMap((key) => key.bindings ?? []).some((binding) => binding.command === close)).toBe(true)
        for (const name of ["escape", "c", custom ? "z" : "d"]) {
          const before = closed
          const event = harness.host.press(name, name === "escape" ? undefined : { ctrl: true })
          // 自定义配置故意允许两种传播；这组相反输入能暴露面板没有强制消费事件的实现。
          expect(closed).toBe(before + 1)
          expect(exited).toBe(0)
          expect(event.defaultPrevented).toBe(true)
          expect(event.propagationStopped).toBe(true)
        }
        if (!custom) {
          const before = closed
          harness.host.press("x", { ctrl: true })
          // leader 前缀本身不关闭，必须由同一 keymap 完成后续 q 序列。
          expect(closed).toBe(before)
          harness.host.press("q")
          expect(closed).toBe(before + 1)
          expect(exited).toBe(0)
        }
        panel.setPopup(true)
        await Promise.resolve()
        // 更高优先级的 dialog 可掩盖未撤销的面板 layer，另查真实活跃集合才能发现该残留。
        expect(harness.keymap.getActiveKeys({ includeBindings: true }).flatMap((key) => key.bindings ?? []).some((binding) => binding.command === close)).toBe(false)
        let dialogClosed = 0
        const offDialog = harness.keymap.registerLayer({ priority: 2, bindings: [{ key: "ctrl+c", cmd: () => { dialogClosed++ } }] })
        const before = closed
        harness.host.press("c", { ctrl: true })
        // 弹层消费真实事件时面板回调保持不动，不能仅检查 binding 存在就声称具备 popup 优先级。
        expect(dialogClosed).toBe(1)
        expect(closed).toBe(before)
        expect(exited).toBe(0)
        offDialog()
        panel.setPopup(false)
        await Promise.resolve()
        harness.host.press(custom ? "z" : "d", { ctrl: true })
        expect(closed).toBe(before + 1)
        panel.dispose()
        // 卸载之后恢复全局动作，能捕获残留 layer；单测关面板成功无法证明 owner 清理正确。
        harness.host.press(custom ? "z" : "d", { ctrl: true })
        expect(closed).toBe(before + 1)
        expect(exited).toBe(1)
        expect(harness.diagnostics.errors).toEqual([])
      } finally {
        // host 与 leader timer 比面板 owner 活得更久；断言失败也须清理，不能让下个 case 继承监听。
        panel.dispose()
        offGlobal()
        offLeader()
        offComma()
        harness.cleanup()
      }
    }
  })


  // 无 custom agent prompt 时，System 分类必须计入 default/provider 系统提示词（禁止空 stub）
  test("system prompt category includes model base provider prompt text", async () => {
    const data = await computeContextData({
      messages: [user("1")],
      parts: { "1": [text("1", "hi")] },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
    })
    // 同输入只替换 agent prompt，环境段落不能掩盖模板缺失。
    const custom = await computeContextData({
      messages: [user("1")], parts: { "1": [text("1", "hi")] }, providers: [provider],
      agents: [{ name: "general", prompt: "x" } as Agent],
      config: {}, paths: { cwd: process.cwd(), worktree: process.cwd() },
    })
    expect(data.categories.find((item) => item.name === "System prompt")!.tokens - custom.categories.find((item) => item.name === "System prompt")!.tokens).toBeGreaterThan(100)
    // 缺省定义来自内嵌完整 catalog，无需历史工具调用或测试注入才能广告能力。
    expect(data.details.toolDefs.length).toBeGreaterThan(10)
    expect(data.details.toolDefs.every((item) => item.tokens > 0)).toBe(true)
    // 独立完整对象锁定默认广告：只检查字段数量无法发现 task_id 文档或 required 被替换。
    const base = {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 words) description of the task" },
        prompt: { type: "string", description: "The task for the agent to perform" },
        subagent_type: { type: "string", description: "The type of specialized agent to use for this task" },
        task_id: { type: "string", description: "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)" },
        command: { type: "string", description: "The command that triggered this task" },
      }, required: ["description", "prompt", "subagent_type"],
    }
    const full = { ...base, properties: { ...base.properties,
      background: { type: "boolean", description: "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress" },
    } }
    const backgroundDescription = "Background mode: background=true launches the subagent asynchronously and returns immediately. Foreground is the default; use it when you need the result before continuing. Use background only for independent work that can run while you continue elsewhere. You will be notified automatically when it finishes."
    expect(TOOL_CATALOG.task.baseParameters).toEqual(base)
    expect(TOOL_CATALOG.task.parameters).toEqual(full)
    expect(TOOL_CATALOG.task.backgroundDescription).toBe(backgroundDescription)
    const flags = ["OPENCODE_EXPERIMENTAL", "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"] as const
    const previous = flags.map((key) => process.env[key])
    try {
      // 覆盖无开关、实验伞、专用关闭与单独开启；全部调用生产 resolver，不在测试中复制条件。
      for (const [umbrella, dedicated, enabled] of [[undefined, undefined, false], ["true", undefined, true], ["true", "false", false], ["false", "yes", true]] as const) {
        for (const [key, value] of [[flags[0], umbrella], [flags[1], dedicated]] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        const task = resolveToolDescriptions({ cwd: process.cwd() }).find((entry) => entry.name === "task")!
        // 完整文本检查同时约束参数选择、后台说明的有无和分隔符，非空 token 无法提供这个保证。
        expect(task.text).toBe(["Tool: task", enabled ? [TaskPrompt.description, backgroundDescription].join("\n\n") : TaskPrompt.description, `Parameters: ${JSON.stringify(enabled ? full : base)}`].join("\n"))
      }
    } finally {
      // 恢复缺失与显式值的区别，后续 provider/flag 测试不能继承本 case 的后台模式。
      flags.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
    // Question.Prompt 只广告 base，不包含内部 Info 才支持的 custom 字段。
    expect(TOOL_CATALOG.question.parameters.properties.questions.items.required).toEqual(["question", "header", "options"])
    expect(TOOL_CATALOG.question.parameters.properties.questions.items.properties.options.items.required).toEqual(["label", "description"])
    // LSP 的运行时枚举与一基坐标约束都是定义开销，不能留下 operations 符号。
    expect(TOOL_CATALOG.lsp.parameters.properties.operation.enum).toHaveLength(9)
    expect(TOOL_CATALOG.lsp.parameters.properties.line.minimum).toBe(1)
    // Todo.status 是带描述的字符串，目录不能擅自收窄成枚举并改变广告契约。
    expect(TOOL_CATALOG.todowrite.parameters.properties.todos.items.required).toEqual(["content", "status", "priority"])
  })

  
  test("counts message, instruction, skill, tool, buffer, and free categories", async () => {
    // 历史调用与显式 bash 映射同时存在，注入定义的唯一来源仍是 toolDefinitions，不能再叠加真实目录。
    const messages = [user("1", { bash: true }), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      // synthetic 指令正文发送给模型；ignored 文本不参与分类。
      "1": [{ ...text("1", "abcdefgh"), synthetic: true }, { ...text("1", "ignored"), ignored: true }],
      "2": [
        text("2", "abcdefghijkl"),
        { id: "2-reason", sessionID: "s", messageID: "2", type: "reasoning", text: "abcd", time: { start: 1, end: 2 } },
        {
          id: "2-tool",
          sessionID: "s",
          messageID: "2",
          type: "tool",
          callID: "call",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "abcdefghijklmnop",
            title: "pwd",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        } as Part,
      ],
    }

    // 分类 oracle 使用固定文本与 schema 注入，磁盘内容变化不能影响消息分栏的精确断言。
    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      // 注入正文避开真实 home/config 文件，确保这个 oracle 检查的是分类而非本机规则长度。
      instructionFiles: [{ path: "/tmp/AGENTS.md", content: "abcdefgh" }],
      // 单项技能仍包含公告标签，不能把 description 的 2 token 误当成完整 Skills 分类值。
      skills: [{ name: "demo", description: "abcdefgh", path: "/tmp/SKILL.md" }],
      toolDefinitions: [{ name: "bash", text: "abcdefghijklmnop" }],
    })

    // synthetic 的 8 字符被计入而 ignored 的 7 字符被排除；两种错误过滤都会改变这个值。
    expect(data.details.messages.userText).toBe(2)
    // 推理另有一个部件，助手文本仍只为 3，防止把 reasoning 混入 assistantText 后再次相加。
    expect(data.details.messages.assistantText).toBe(3)
    // completed 工具结果归输入，不能把这个 4 加入工具调用开销或助手正文。
    expect(data.details.messages.toolResults).toBe(4)
    // instructionFiles 是完整覆盖，真实 AGENTS.md 不应偷偷叠加进注入的 2 token。
    expect(data.details.instructions[0]?.tokens).toBe(2)
    // 固定 16 字符定义只计 4 token，权限过滤和历史调用不能扩大注入定义的载荷。
    expect(data.details.toolDefs.find((item) => item.name === "bash")?.tokens).toBe(4)
    // 自定义 schema 不关闭环境/系统载荷，不能通过减少分类项让整体占用看似更低。
    expect(data.categories.find((item) => item.name === "System prompt")?.tokens).toBeGreaterThan(100)
    expect(data.details.messages.reasoning).toBe(1)
    // 同一助手同时承载正文、推理与工具，分桶断言才能发现按外层角色归类导致的正文膨胀。
    expect(data.categories.find((item) => item.name === "User Messages")?.tokens).toBe(2)
    expect(data.categories.find((item) => item.name === "Tool Results")?.tokens).toBe(4)
    expect(data.categories.find((item) => item.name === "Assistant Messages")?.tokens).toBe(4)
    expect(data.categories.find((item) => item.name === "Tool Calls")?.tokens).toBe(4)
    expect(data.categories.slice(4, 8).map(item => item.name)).toEqual(["User Messages", "Tool Results", "Assistant Messages", "Tool Calls"])
    // 有 input 上限时缓冲抵消 provider reserve；小输出限额不能替代下一轮输入余量。
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(19_900)
    // providerReserve 只反映 catalog 的输入差额，不能再把 100 输出限额叠加进来。
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(100)
    // 同时检查输入上限与 usable，避免只显示正确 buffer 标签却使用错误压缩阈值。
    expect(data.details.window).toMatchObject({ inputLimit: 19_900, usableInput: 0, compactionBuffer: 19_900 })
    // 缓冲已占满输入上限，free 必须归零，不能沿旧小输出公式留下伪余量。
    expect(data.categories.find((item) => item.name === "Free space")?.tokens).toBe(0)
    // 100 列终端使用固定采样密度，分类个数增加也不能把总 cells 增长成无限列表。
    expect(data.gridRows.flat()).toHaveLength(100)
    // buffer 预先保留尾部，free 填补舍入空格时不能把它覆盖成自由空间。
    expect(data.gridRows.flat().at(-1)?.categoryName).toBe("Autocompact buffer")
    await using tmp = await tmpdir()
    const filepath = `${tmp.path}/AGENTS.md`
    const current = "Changed instructions on disk after the historical Read completed."
    await Bun.write(filepath, current)
    // 这份 wire output 保留实际 Read 的 reminder 包装，磁盘刻意保存不同版本以发现偷偷重读。
    const output = `<path>${tmp.path}/file.txt</path>\n<type>file</type>\n<content>\n1: old file\n</content>\n\n<system-reminder>\nInstructions from: ${filepath}\nOld instructions already visible to the model.\n</system-reminder>`
    // satisfies 校验真实 ToolPart 判别与完成状态，metadata.loaded 和正文不能放在虚构的 text/agent 部件上。
    const read = {
      id: "read", sessionID: "s", messageID: "2", type: "tool", callID: "read-call", tool: "read",
      state: { status: "completed", input: { filePath: `${tmp.path}/file.txt` }, output, title: "file.txt",
        metadata: { loaded: [filepath] }, time: { start: 1, end: 2 } },
    } satisfies Part
    // 空 instructionFiles 隔离当轮系统规则扫描；AGENTS 文件在磁盘真实存在，只能由 loaded 分支观察。
    const request = { messages: [user("1", { read: true }), assistant("2", "1")], parts: { "1": [], "2": [read] },
      providers: [provider], paths: { cwd: tmp.path }, instructionFiles: [], skills: [], toolDefinitions: [] }
    const inline = await computeContextData(request)
    // 旧正文全部归 toolResults；loaded 不是另一份载荷，当前磁盘版本不能再进入 Instructions 分栏。
    expect(inline.details.messages.toolResults).toBe(estimate(output))
    expect(inline.details.loadedInstructions).toEqual([])
    expect(inline.categories.find((item) => item.name === "Instructions")?.tokens).toBe(0)
    const notInline = await computeContextData({ ...request, parts: { "1": [], "2": [{ ...read,
      state: { ...read.state, output: "Read file contents without an inline instruction reminder." } }] } })
    // metadata.loaded 的未内联分支仍补充真实磁盘规则，不能用一律忽略 loaded 来让去重样例通过。
    expect(notInline.details.loadedInstructions).toEqual([{ path: filepath, tokens: estimate(`Instructions from: ${filepath}\n${current}`) }])
    // 磁盘补充仅归 Instructions，不能写回 toolResults 并让同一正文在两个分类中出现。
    expect(notInline.details.messages.toolResults).toBe(estimate("Read file contents without an inline instruction reminder."))
    const compacted = await computeContextData({ ...request, parts: { "1": [], "2": [{ ...read,
      state: { ...read.state, time: { start: 1, end: 2, compacted: 3 } } }] } })
    // 原 output 仍留在部件上，但窗口只计占位符；内联证明也必须忽略这份已不可见的旧正文。
    expect(compacted.details.messages.toolResults).toBe(estimate("[Old tool result content cleared]"))
    expect(compacted.details.loadedInstructions).toEqual(notInline.details.loadedInstructions)
  })

  // 真实小 input/大 context 情形能暴露 reserve 被当作 compaction buffer 的错误分配。
  test("splits provider input reserve from the real autocompact buffer", async () => {
    const constrained: Provider = {
      ...provider,
      models: {
        model: {
          ...provider.models.model,
          // 输入上限刻意小于窗口的一半；误用 context 仍有非零余量，只检查非零无法发现这个错误。
          limit: { context: 204_800, input: 73_700, output: 32_000 },
        },
      },
    }

    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [constrained],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 180,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [],
    })

    // 输出 cap 与输入缓冲来自独立预算，窗口 oracle 同时锁定 input 上限和实际 usable。
    expect(data.details.window).toMatchObject({
      contextLimit: 204_800,
      inputLimit: 73_700,
      usableInput: 68_700,
      providerReserve: 131_100,
      compactionBuffer: 5_000,
    })
    // provider reserve 属于模型容量，既不计入 used，也不从 usable 再扣一次。
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(131_100)
    // provider reserve 抵消默认缓冲后仍保留 5000 floor，安全余量不取输出 cap 或整个差额。
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(5_000)
    // 自由空间只能位于 buffer 前面，尾部安全缓冲不能因类别排序移到 used 之间。
    expect(data.categories.findIndex((item) => item.name === "Free space")).toBeLessThan(
      data.categories.findIndex((item) => item.name === "Autocompact buffer"),
    )
    // 大额 provider reserve 不能抢走 buffer 的尾格；这项断言独立于小窗口 fixture。
    expect(data.gridRows.flat().at(-1)?.categoryName).toBe("Autocompact buffer")
  })

  // 缺省 tools 没有权限上的子集含义，无历史调用也不能把定义折叠成空列表。
  test("estimates all built-in tool definitions when the request did not explicitly disable tools", async () => {
    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      // 固定两个定义隔离本机实验 flag，测试缺省广告语义不能依赖环境里启用了哪些工具。
      toolDefinitions: [
        { name: "bash", text: "bash description" },
        { name: "read", text: "read description" },
      ],
    })

    // 两个注入工具均无历史调用，若实现从已调用部件推导定义集合，这个完整集合断言必然失败。
    expect(data.details.toolDefs.map((item) => item.name)).toEqual(["bash", "read"])
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBeGreaterThan(0)
  })


  test("does not collapse tool definitions to historical tool calls", async () => {
    const messages = [user("1"), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "hello")],
      "2": [
        {
          id: "2-tool",
          sessionID: "s",
          messageID: "2",
          type: "tool",
          callID: "call",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "inspect", prompt: "inspect", subagent_type: "general" },
            output: "done",
            title: "inspect",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ],
    }

    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
    })

    // 历史只有 task 仍应广告全部可用定义；只从已调用工具反推集合会低估后续请求的 prompt。
    expect(data.details.toolDefs.length).toBeGreaterThan(10)
    expect(data.details.toolDefs.find((item) => item.name === "task")?.tokens).toBeGreaterThan(20)
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBeGreaterThan(1000)
  })

  test("explicit false tools disable definitions without turning true tools into a subset", async () => {
    const input: ComputeContextDataInput = {
      messages: [user("1", { read: true, bash: false }), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [{ name: "general", mode: "primary", options: {}, permission: [{ permission: "bash", pattern: "*", action: "allow" }] }],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [
        { name: "bash", text: "bash description" },
        { name: "grep", text: "grep description" },
        { name: "read", text: "read description" },
      ],
    }
    const data = await computeContextData(input)

    // false 是撤销广告，true 不是 allow-list；未提及的 grep 必须继续留在定义集合。
    // 注入 fixture 也经过消息级禁用过滤，避免测试 seam 绕过真实 false-tools 语义。
    expect(data.details.toolDefs.map((item) => item.name)).toEqual(["grep", "read"])
    const session: Session = { id: "ses_context", slug: "context", projectID: "p", directory: ".", title: "Session", version: "1",
      time: { created: 0, updated: 0 }, permission: [{ permission: "bash", pattern: "*", action: "deny" }] }
    const messages = [user("1", { read: true, bash: false }), assistant("2", "1"), user("3"), assistant("4", "3")].map((message) => ({ ...message, sessionID: session.id }))
    // 第二条 prompt 没有 tools；runtime 持久化的 deny 仍必须撤销 bash 广告。
    expect((await computeContextData({ ...input, messages, session })).details.toolDefs.map((item) => item.name)).toEqual(["grep", "read"])
    input.agents = [{ name: "general", mode: "primary", options: {}, permission: [{ permission: "bash", pattern: "*", action: "deny" }] }]
    session.permission = [{ permission: "bash", pattern: "*", action: "allow" }]
    expect((await computeContextData({ ...input, messages, session })).details.toolDefs.map((item) => item.name)).toEqual(["bash", "grep", "read"])
    // 最后匹配 permission 的定向规则保留工具；不能跳过它回看更早的全资源 deny。
    session.permission = [{ permission: "bash", pattern: "*", action: "deny" }, { permission: "bash", pattern: "private/*", action: "allow" }]
    expect((await computeContextData({ ...input, messages, session })).details.toolDefs.map((item) => item.name)).toEqual(["bash", "grep", "read"])
  })

  test("selects editing tools by resolved API ID in both alias directions", async () => {
    for (const [modelID, apiID, patch] of [["coding", "gpt-5-codex", true], ["gpt-5-codex", "claude-sonnet", false]] as const) {
      const message = user("1")
      if (message.role === "user") message.model = { providerID: "test", modelID }
      const aliased: Provider = { ...provider, models: { [modelID]: { ...provider.models.model,
        id: modelID, api: { ...provider.models.model.api, id: apiID } } } }
      const data = await computeContextData({ messages: [message], parts: {}, providers: [aliased],
        paths: { cwd: process.cwd() }, instructionFiles: [], skills: [] })
      // 显示键不变；真正发送给 registry 的 API ID 决定 patch/edit/write 分支。
      expect(data.model).toBe(`test/${modelID}`)
      expect(data.details.toolDefs.some((item) => item.name === "apply_patch")).toBe(patch)
      expect(data.details.toolDefs.some((item) => item.name === "edit")).toBe(!patch)
      expect(data.details.toolDefs.some((item) => item.name === "write")).toBe(!patch)
    }
  })

  test("matches task wildcard permissions and websearch provider flags", async () => {
    const keys = ["OPENCODE_EXPERIMENTAL", "OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL_EXA",
      "OPENCODE_ENABLE_PARALLEL", "OPENCODE_EXPERIMENTAL_PARALLEL", "OPENCODE_ENABLE_QUESTION_TOOL", "OPENCODE_CLIENT"]
    const previous = keys.map((key) => process.env[key])
    try {
      // 使用真实 catalog 而非注入定义，覆盖 provider 与两种 Parallel 开关。
      for (const key of keys) process.env[key] = "false"
      process.env.OPENCODE_CLIENT = "api"
      const primary: Agent = { name: "general", mode: "primary", options: {}, permission: [
        { permission: process.platform === "win32" ? "TaSk" : "task", pattern: "revie?", action: "deny" },
        { permission: "task", pattern: "team\\revie?", action: "deny" },
      ] }
      async function compute(providerID: string, agents: Agent[]) {
        const message = user("1")
        if (message.role === "user") message.model = { providerID, modelID: "model" }
        return computeContextData({ messages: [message], parts: {}, providers: [provider], config: {},
          agents, paths: { cwd: process.cwd() }, columns: 100, instructionFiles: [], skills: [] })
      }
      const base = await compute("test", [primary])
      const denied = await compute("test", [primary,
        { name: "review", mode: "subagent", options: {}, permission: [], description: "secret ".repeat(100) },
        { name: "team/review", mode: "subagent", options: {}, permission: [], description: "hidden ".repeat(100) }])
      // ? 与反斜杠规则必须移除动态子代理文本，不能只过滤整个 task 定义。
      expect(denied.details.toolDefs.find((item) => item.name === "task")?.tokens)
        .toBe(base.details.toolDefs.find((item) => item.name === "task")?.tokens)
      expect(base.details.toolDefs.some((item) => item.name === "websearch")).toBe(false)
      for (const providerID of ["opencode", "opencode-go"])
        expect((await compute(providerID, [primary])).details.toolDefs.some((item) => item.name === "websearch")).toBe(true)
      // 原始字符串交给真实 Config codec；大小写或非法值不能静默变成 false。
      for (const [key, tool] of [["OPENCODE_EXPERIMENTAL", "websearch"], ["OPENCODE_ENABLE_EXA", "websearch"],
        ["OPENCODE_EXPERIMENTAL_EXA", "websearch"], ["OPENCODE_ENABLE_PARALLEL", "websearch"],
        ["OPENCODE_EXPERIMENTAL_PARALLEL", "websearch"], ["OPENCODE_ENABLE_QUESTION_TOOL", "question"]]) {
        for (const [value, enabled] of [["true", true], ["yes", true], ["on", true], ["y", true], ["1", true],
          ["false", false], ["no", false], ["off", false], ["n", false], ["0", false], [undefined, false]] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
          expect((await compute("test", [primary])).details.toolDefs.some((item) => item.name === tool)).toBe(enabled)
        }
        for (const value of ["TRUE", "Yes", "ON", "Y", "False", "invalid", ""]) {
          process.env[key] = value
          for (const providerID of ["test", "opencode"])
            await expect(compute(providerID, [primary])).rejects.toThrow()
        }
        process.env[key] = "false"
      }
      // CLI/app/desktop 广告 question 不依赖专用开关；缺省 client 仍是 cli，实验伞不授权其他客户端。
      delete process.env.OPENCODE_CLIENT
      expect((await compute("test", [primary])).details.toolDefs.some((item) => item.name === "question")).toBe(true)
      for (const client of ["app", "cli", "desktop"]) {
        process.env.OPENCODE_CLIENT = client
        expect((await compute("test", [primary])).details.toolDefs.some((item) => item.name === "question")).toBe(true)
      }
      process.env.OPENCODE_CLIENT = "api"
      process.env.OPENCODE_EXPERIMENTAL = "yes"
      expect((await compute("test", [primary])).details.toolDefs.some((item) => item.name === "question")).toBe(false)
      expect(base.categories.find((item) => item.name === "Tool definitions")?.color).toBe("secondary")
    } finally {
      // 环境开关恢复原始缺省状态，避免影响非折叠与 false-tools 的既有用例。
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    }
  })


  test("context usage detail lines are bounded so they do not push into the grid", async () => {
    const data = await computeContextData({
      messages: [user("1", { bash: true }), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      // 宿主可以是 Unix，保存的 Windows 路径仍应按两种分隔符保留 AGENTS.md 的文件尾部。
      // 超长 Windows 路径保留文件尾部，验证中间截断而非简单 slice 掩盖真正的文件身份。
      instructionFiles: [{ path: "F:\\very\\long\\nested\\workspace\\path\\that\\should\\not\\overflow\\AGENTS.md", content: "body" }],
      skills: [],
      toolDefinitions: [{ name: "bash", text: "bash description" }],
    })

    // formatter 使用调用时的 80 列，而不是 compute 时的 100 列，resize 必须独立重排明细。
    const lines = contextUsageDetailLines(data, 80)
    // 文件数量或工具数量增加也只能改变三行内容，不能把明细展开成长列表挤走网格。
    expect(lines.length).toBeLessThanOrEqual(3)
    // 独立检查上界，避免某条路径绕开 formatter 后仍因其他行正常而被平均长度掩盖。
    expect(lines.every((line) => line.length <= 72)).toBe(true)
    // 再检查精确补齐，防止只满足上界却让连续 resize 后的明细列位置跳动。
    expect(lines.every((line) => line.length === 72)).toBe(true)
    // 截断必须保留文件身份与三类入口，不能为了守住宽度直接删掉整条重要明细。
    expect(lines.join("\n")).toContain("AGENTS.md")
    expect(lines.join("\n")).toContain("Input")
    expect(lines.join("\n")).toContain("Output")
    expect(lines.join("\n")).toContain("Prompt")
    // 空技能列表没有可用能力，明细不能制造一个看似有已注册工具的 Skills 占位项。
    expect(lines.join("\n")).not.toContain("Skills 0")
  })

  // 确认 fixture 与消息正文估算无关，footer 必须取 provider 字段而非用字符数近似计费用量。
  test("footer reports confirmed session input, output, reasoning, and cache totals", async () => {
    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [
          {
            id: "sf",
            sessionID: "s",
            messageID: "2",
            type: "step-finish",
            reason: "stop",
            // 非零 cost 独立于 tokens，能暴露把金额当 token 或遗漏费用展示的两种错误。
            cost: 0.01,
            tokens: {
              input: 100,
              output: 40,
              reasoning: 10,
              // cache 仍是确认 producer 的两个独立数值，若被正文长度替代，总额和 W/R 次序断言会同时失败。
              cache: { read: 20, write: 5 },
            },
          } as Part,
        ],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [],
    })

    // output 已扣除 reasoning；真实生产者的两栏只能各累计一次。
    expect(data.details.usage).toMatchObject({ input: 100, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 5 })
    // 缓存、推理与普通输入输出合计 175；金额独立保留。
    expect(data.details.usage.total).toBe(175)
    expect(data.details.usage.cost).toBe(0.01)
    expect(contextUsageFooter(data, 100)).toContain("Reason 10")
    // 正文仅有 hello/world，账本的 100 输入来自 step-finish；显示总额不能取短正文的字符估算。
    expect(contextUsageFooter(data, 100)).toContain("Session Totals")
    // Footer 的 Output 与 Reason 是同一生产者的独立字段。
    expect(contextUsageFooter(data, 100)).toContain("Output 40")
    // 非对称缓存数值才能验证 W/R 展示次序，两个字段相等会掩盖反转。
    expect(contextUsageFooter(data, 100)).toContain("Cache W/R 5/20")
    // 有确认字段时也要留关闭提示宽度，不能因为切到 Session Totals 就绕过 formatter。
    expect(contextUsageFooter(data, 100).length).toBe(82)
  })

  // 真实 tail 同时跨用户与助手记录，fixture 不把保留区压缩成只有 summary 的特殊例外。
  test("filters compacted history and keeps summary plus retained tail", () => {
    // fixture 先按时间正序构造，调用处显式 toReversed 进入倒序裁剪路径。
    const messages = [
      { info: user("1"), parts: [text("1", "old")] },
      { info: assistant("2", "1"), parts: [text("2", "old answer")] },
      // tail_start_id 的用户消息本身也保留，不能只留下其助手回复。
      { info: user("3"), parts: [text("3", "tail")] },
      { info: assistant("4", "3"), parts: [text("4", "tail answer")] },
      {
        info: user("5"),
        // 边界放在一对中间轮次之前，能暴露实现只保留最新助手回复却丢弃它所回答的用户消息。
        parts: [{ id: "c", sessionID: "s", messageID: "5", type: "compaction", auto: true, tail_start_id: "3" } as Part],
      },
      { info: assistant("6", "5", true), parts: [text("6", "summary")] },
    ]

    // 旧 1/2 与保留的 3/4 同时存在，断言能发现全部历史未裁剪和 tail 被全部丢弃两类错误。
    const result = filterCompactedMessages(messages.toReversed()).map((item) => item.info.id)
    // 精确顺序要求先 tail 后请求/摘要；只比较集合会掩盖倒序结果或 summary 移到窗口开头。
    expect(result).toEqual(["3", "4", "5", "6"])
  })

  test("keeps raw fallback totals across compaction", async () => {
    // 旧助手被窗口裁剪后，持久消息上的确认用量仍属于整场会话。
    const old = { ...assistant("2", "1"), tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } }, cost: 0.01 } as Message
    const data = await computeContextData({
      messages: [user("1"), old, user("3"), assistant("4", "3", true)],
      parts: {
        "1": [text("1", "old")],
        "2": [text("2", "old answer")],
        // 无 tail_start_id 表示旧消息全部压缩，窗口仅保留请求与摘要。
        "3": [{ id: "c", sessionID: "s", messageID: "3", type: "compaction", auto: true } as Part],
        "4": [text("4", "summary")],
      },
      providers: [provider],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      instructionFiles: [], skills: [], toolDefinitions: [],
    })
    // 无 step-finish 时走真实助手字段回退，不能因裁剪把总额清零。
    expect(data.details.usage).toMatchObject({ input: 100, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 5, total: 175, cost: 0.01 })
    // 窗口分类仍只含摘要；会话总额与窗口估算是两个既有口径。
    expect(data.details.messages.assistantText).toBe(0)
    expect(data.details.messages.compactionSummary).toBe(2)
    // Footer 分栏输出，reasoning 没有再次混入 Output。
    expect(contextUsageFooter(data, 180)).toContain("Output 40")
    expect(contextUsageFooter(data, 180)).toContain("Reason 10")
    expect(contextUsageFooter(data, 180)).toContain("Cost $0.0100")
  })

  test("uses daemon text breakdown and keeps confirmed usage separate", async () => {
    const inputBreakdown = {
      system: 8000, instructions: 1000, skills: 0, tools: 5000,
      messages: { userText: 8000, assistantText: 8000, reasoning: 0, toolInput: 2000, toolOutput: 2000, attachments: 0, total: 20000 },
    }
    const finish: Part = {
      id: "sf", sessionID: "s", messageID: "2", type: "step-finish", reason: "stop", cost: 0.001,
      tokens: { input: 12000, output: 600, reasoning: 0, cache: { read: 3000, write: 2000 } }, inputChars: 34000, inputBreakdown,
    }
    // 可见正文刻意远小于服务端细分，能发现面板仍用短消息重建分类、覆盖 prepared 证明的回归。
    const input: ComputeContextDataInput = {
      messages: [user("1"), assistant("2", "1")], parts: { "1": [text("1", "short")], "2": [finish] },
      providers: [provider], paths: { cwd: process.cwd() }, instructionFiles: [], skills: [], toolDefinitions: [],
    }
    // Source 的 ratio=2.0 保留输入/cache分母；此处只验证文本分类，附件另验视觉估算。
    const legacy = await computeContextData(input)
    expect(legacy.categories.find(item => item.name === "System prompt")?.tokens).toBe(4000)
    expect(legacy.categories.find(item => item.name === "Instructions")?.tokens).toBe(500)
    expect(legacy.categories.find(item => item.name === "Tool definitions")?.tokens).toBe(2500)
    expect(legacy.categories.find(item => item.name === "Skills")?.tokens).toBe(0)
    expect(legacy.details.messages.attachments).toBe(0)
    expect(legacy.details.messages.toolCalls).toBe(1000)
    expect(legacy.details.messages.toolResults).toBe(1000)
    // 确认输出600与费用来自 step-finish；细分的17000输入估算不能重写普通输入或抹掉缓存两栏。
    expect(legacy.details.usage).toMatchObject({ input: 12000, cacheRead: 3000, cacheWrite: 2000, output: 600, cost: 0.001 })
    expect(legacy.categories.slice(4, 8).map(item => [item.name, item.tokens])).toEqual([
      ["User Messages", 4000], ["Tool Results", 1000], ["Assistant Messages", 4600], ["Tool Calls", 1000],
    ])
    expect(legacy.totalTokens).toBe(17600)
    expect(legacy.details.usage.total).toBe(17600)
    // 小额与超过输入上限的 reserved 分别验证显式覆盖和可用窗口归零，不能沿用缺省缓冲公式。
    for (const reserved of [100, 20000]) {
      const explicit = await computeContextData({ ...input, config: { compaction: { reserved } } })
      expect(explicit.details.window.usableInput).toBe(Math.max(0, 19900 - reserved))
      expect(explicit.details.window.compactionBuffer).toBe(Math.min(19900, reserved))
      expect(explicit.details.window.providerReserve).toBe(100)
    }
    const request: NonNullable<Session["request"]> = { messageID: "1", input: 0, output: 0, cost: 0, stepInput: 0, stepOutput: 0,
      model: { providerID: "test", modelID: "api-model", contextLimit: 8000 },
      inputEstimate: { input: 17000, bodyChars: 34000, confirmed: false, charsPerToken: 2, inputBreakdown } }
    const session: Session = { id: "s", slug: "s", projectID: "p", directory: ".", title: "s", version: "1", time: { created: 0, updated: 0 }, request }
    // native 首包前或分页淘汰后可没有任何可见消息；空 transcript 仍须从同一请求投影得到五类占用。
    const native = await computeContextData({ ...input, messages: [], parts: {}, session,
      instructionFiles: [{ path: "a", content: "abcd" }, { path: "b", content: "abcdefgh" }],
      toolDefinitions: [{ name: "a", text: "abcd" }, { name: "b", text: "abcdefgh" }] })
    expect(native.categories.filter(item => !item.isDeferred).map(item => item.tokens)).toEqual([4000, 500, 0, 2500, 4000, 1000, 4000, 1000])
    expect(native.totalTokens).toBe(17000)
    // 4:8的本地权重不能整除500或2500，明细总额断言可捕获逐项舍入导致的余数丢失。
    expect(native.details.instructions.reduce((sum, item) => sum + item.tokens, 0)).toBe(500)
    expect(native.details.toolDefs.reduce((sum, item) => sum + item.tokens, 0)).toBe(2500)
    // 不对称本地权重要求按比例分摊且保住服务端总额，逐项独立舍入可能在明细中制造或丢失余数。
    expect(native.details.instructions).toEqual([{ path: "a", tokens: 167 }, { path: "b", tokens: 333 }])
    expect(native.details.toolDefs).toEqual([{ name: "a", tokens: 833 }, { name: "b", tokens: 1667 }])
    expect(native.details.usage.total).toBe(0)
    expect(native.maxTokens).toBe(8000)
    expect(native.model).toBe("test/api-model")
    // 字典仍有20000窗口，冻结预算零若被当成缺失值就会错误借用该 Catalog 上限。
    const zero = await computeContextData({ ...input, session: { ...session, request: { ...request,
      model: { providerID: "test", modelID: "api-model", contextLimit: 0 } } } })
    expect(zero.maxTokens).toBe(0)
    // parts 中保留上一请求的完整细分；新请求没有 carrier 时必须阻止旧确认点接管分类。
    const missing = await computeContextData({ ...input, session: { ...session, request: {
      messageID: "new", input: 0, output: 0, cost: 0, stepInput: 0, stepOutput: 0 } } })
    expect(missing.categories.find(item => item.name === "Instructions")?.tokens).toBe(0)
    // 两例仅有 prepared 输入，零估算也未获 provider 确认，必须显式保留未确认状态。
    const edges = await computeContextData({ ...input, messages: [], parts: {},
      session: { ...session, request: { ...request,
        inputEstimate: { ...request.inputEstimate, confirmed: false, input: 7258, bodyChars: 29032, charsPerToken: 4,
          inputBreakdown: { ...inputBreakdown, skills: 12, tools: 20 } } } },
      instructionFiles: [{ path: "a", content: "" }, { path: "b", content: "" }],
      skills: [{ name: "a", description: "a", path: "a" }, { name: "b", description: "b", path: "b" }],
      toolDefinitions: [{ name: "a", text: "a" }, { name: "b", text: "b" }],
    })
    // 空指令正文只有路径展示权，没有可分摊的内容证明；清零明细仍须保留服务端指令分类总额。
    expect(edges.details.instructions).toEqual([{ path: "a", tokens: 0 }, { path: "b", tokens: 0 }])
    expect(edges.categories.find(item => item.name === "Instructions")?.tokens).toBe(250)
    // 工具本地估值全零时仍须承接服务端广告总额，均分后的余数只能按累计边界归属，不能每项再 round。
    expect(edges.details.toolDefs).toEqual([{ name: "a", tokens: 3 }, { name: "b", tokens: 2 }])
    // 技能正文长度不代表服务端公告份额，各技能等权分摊同一总额；奇数总量能揭示遗漏余数或重复分配。
    expect(edges.details.skills.map(item => item.tokens)).toEqual([2, 1])
    expect(edges.totalTokens).toBe(7258)
    const cleared = await computeContextData({ ...input, messages: [], parts: {},
      session: { ...session, request: { ...request,
        inputEstimate: { ...request.inputEstimate, confirmed: false, input: 0, bodyChars: 0, charsPerToken: 4,
          inputBreakdown: { system: 0, instructions: 0, skills: 0, tools: 0,
            messages: { userText: 0, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 0, total: 0 } } } } },
      instructionFiles: [{ path: "a", content: "abcd" }, { path: "b", content: "abcdefgh" }],
      skills: [{ name: "a", description: "a", path: "a" }, { name: "b", description: "b", path: "b" }],
      toolDefinitions: [{ name: "a", text: "abcd" }, { name: "b", text: "abcdefgh" }],
    })
    // 服务端明确的零细分必须压过本地非空文件和定义，否则旧估值会在已清空窗口中残留。
    expect(cleared.categories.filter(item => !item.isDeferred).map(item => item.tokens)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(cleared.details.messages).toEqual({ userText: 0, assistantText: 0, reasoning: 0, toolCalls: 0, toolResults: 0, attachments: 0, compactionSummary: 0 })
    expect(cleared.details.instructions).toEqual([{ path: "a", tokens: 0 }, { path: "b", tokens: 0 }])
    expect(cleared.details.skills.map(item => item.tokens)).toEqual([0, 0])
    expect(cleared.details.toolDefs).toEqual([{ name: "a", tokens: 0 }, { name: "b", tokens: 0 }])
    expect(cleared.totalTokens).toBe(0)
    expect(cleared.details.usage.total).toBe(0)
  })

  test("excludes attachment chars from calibration and uses image/PDF visual tokens", async () => {
    const inputBreakdown = {
      system: 0, instructions: 0, skills: 0, tools: 0,
      messages: { userText: 4000, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 6000, total: 10000 },
    }
    const finish: Part = { id: "sf", sessionID: "s", messageID: "2", type: "step-finish", reason: "stop", cost: 0.001,
      tokens: { input: 1600, output: 0, reasoning: 0, cache: { read: 200, write: 200 } }, inputChars: 10000, inputBreakdown }
    const input: ComputeContextDataInput = { messages: [user("1"), assistant("2", "1")],
      parts: { "1": [text("1", "short"),
        { id: "image", sessionID: "s", messageID: "1", type: "file", mime: "image/png", url: `data:image/png;base64,${"x".repeat(1500)}` },
        { id: "pdf", sessionID: "s", messageID: "1", type: "file", mime: "application/pdf", url: `data:application/pdf;base64,${"x".repeat(2200)}` },
      ], "2": [finish] }, providers: [provider], paths: { cwd: process.cwd() },
      instructionFiles: [], skills: [], toolDefinitions: [] }
    const data = await computeContextData(input)
    // 确认分类共享含缓存的 2000 输入，附件字符占比不能再次变成本地视觉估值。
    expect(data.details.messages.userText).toBe(800)
    expect(data.details.messages.attachments).toBe(1200)
    expect(data.categories.find(item => item.name === "User Messages")?.tokens).toBe(2000)
    expect(data.totalTokens).toBe(2000)
    expect(data.details.usage).toMatchObject({ input: 1600, cacheRead: 200, cacheWrite: 200 })
  })

  test("ratio=2.5 tracks JSON-heavy input and ignores user or other-model calibration", async () => {
    const longText = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `message ${i} with JSON, code and tool results`.repeat(4) })))
    const confirmed = Math.round(longText.length / 2.5)
    const finish: Part = { id: "sf", sessionID: "s", messageID: "2", type: "step-finish", reason: "stop", cost: 0.01,
      tokens: { input: confirmed, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, inputChars: longText.length,
      inputBreakdown: { system: 0, instructions: 0, skills: 0, tools: 0,
        messages: { userText: longText.length, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 0, total: longText.length } } }
    const input: ComputeContextDataInput = { messages: [user("1"), assistant("2", "1")],
      parts: { "1": [text("1", longText), { ...finish, messageID: "1", inputChars: 100000 }], "2": [finish] },
      providers: [provider], paths: { cwd: process.cwd() }, instructionFiles: [], skills: [], toolDefinitions: [] }
    const data = await computeContextData(input)
    const tokens = data.categories.find(item => item.name === "User Messages")?.tokens ?? 0
    expect(Math.abs(tokens - confirmed) / confirmed).toBeLessThan(0.02)
    expect(tokens).toBeGreaterThan(Math.round(longText.length / 4))
    // 异模型样本的十万字符足以主导比率，追加后结果不变才能证明过滤使用实际执行模型。
    const other = { ...assistant("3", "1"), modelID: "other" }
    const unchanged = await computeContextData({ ...input, messages: [...input.messages, other],
      parts: { ...input.parts, "3": [{ ...finish, messageID: "3", inputChars: 100000 }] } })
    expect(unchanged.details.messages.userText).toBe(data.details.messages.userText)
  })
})
