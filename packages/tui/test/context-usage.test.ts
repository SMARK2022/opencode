import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createBindingLookup } from "@opentui/keymap/extras"
import { registerCommaBindings, registerTimedLeader } from "@opentui/keymap/addons"
import { createTestKeymap, type TestKeymapEvent, type TestKeymapTarget } from "@opentui/keymap/testing"
import { estimate } from "@opencode-ai/core/util/token"
import { TuiKeybind } from "../src/config/keybind"
import { tmpdir } from "./fixture/fixture"
import type { Agent, Message, Part, Provider, TextPart } from "@opencode-ai/sdk/v2"
import { computeContextData, filterCompactedMessages, resolveToolDescriptions } from "../src/util/context-usage"
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
  test("subscribes to in-place text, pending input, and confirmed token changes", async () => {
    const mounted = createRoot((dispose) => {
      const [store, setStore] = createStore({
        messages: [user("1"), assistant("2", "1"), assistant("3", "1")],
        parts: {
          "1": [text("1", "abcd")],
          "2": [{ id: "raw", sessionID: "s", messageID: "2", type: "tool" as const, callID: "call", tool: "bash",
            state: { status: "pending" as const, input: {}, raw: "" } }],
          "3": [{ id: "sf", sessionID: "s", messageID: "3", type: "step-finish" as const, reason: "stop", cost: 0,
            tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
        },
        providers: [provider], paths: { cwd: process.cwd() }, instructionFiles: [], skills: [], toolDefinitions: [],
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
    // 注入定义恰为 16 字符；历史调用输入不能放大这 4 个定义 token。
    expect(data.details.toolDefs.find((item) => item.name === "bash")?.tokens).toBe(4)
    // 自定义 schema 不关闭环境/系统载荷，不能通过减少分类项让整体占用看似更低。
    expect(data.categories.find((item) => item.name === "System prompt")?.tokens).toBeGreaterThan(100)
    // 输入分类包含 synthetic 正文和工具结果，两者来自不同角色，不应按 message.role 粗分。
    expect(data.categories.find((item) => item.name === "Input Messages")?.tokens).toBe(6)
    // 助手文本 3、调用输入 4、推理 1 都归输出；工具结果仍只归输入。
    expect(data.details.messages.reasoning).toBe(1)
    expect(data.categories.find((item) => item.name === "Output Messages")?.tokens).toBe(8)
    // 小输出模型只预留输出上限对应的缓冲，不能使用固定 20k 把整个窗口扣成零。
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(100)
    // providerReserve 只反映 catalog 的输入差额，不能再把 100 输出限额叠加进来。
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(100)
    // 同时检查输入上限与 usable，避免只显示正确 buffer 标签却使用错误压缩阈值。
    expect(data.details.window).toMatchObject({ inputLimit: 19_900, usableInput: 19_800, compactionBuffer: 100 })
    // 小 fixture 应留下可用输入空间；若 reserve 被再次加到 used，这个余量会错误下降。
    expect(data.categories.find((item) => item.name === "Free space")?.tokens).toBeGreaterThan(0)
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

    // 输出 cap 为 32k，默认输入缓冲只扣 20k；完整窗口 oracle 同时锁定 usable 与输入上限。
    expect(data.details.window).toMatchObject({
      contextLimit: 204_800,
      inputLimit: 73_700,
      usableInput: 53_700,
      providerReserve: 131_100,
      compactionBuffer: 20_000,
    })
    // provider reserve 属于模型容量，既不计入 used，也不从 usable 再扣一次。
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(131_100)
    // 压缩缓冲独立于 context-input 差额，不能把 131100 当作安全余量。
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(20_000)
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

  // 超长 Windows 路径保留文件尾部，验证中间截断而非简单 slice 掩盖真正的文件身份。
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
})
