/** @jsxImportSource @opentui/solid */
// #192：prompt 提交传输层行为测试——失败保留 draft / 成功清除 / shell 后台 / slash / 新会话
import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { Prompt, type PromptRef } from "../../../../src/component/prompt"
import { FrecencyProvider } from "../../../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../../src/component/prompt/stash"
import { ArgsProvider } from "../../../../src/context/args"
// #192：DataProvider——Autocomplete 组件通过 useData 获取数据
import { DataProvider } from "../../../../src/context/data"
import { ExitProvider } from "../../../../src/context/exit"
import { KVProvider } from "../../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../../src/context/local"
import { LocationProvider } from "../../../../src/context/location"
import { PermissionProvider } from "../../../../src/context/permission"
import { ProjectProvider } from "../../../../src/context/project"
import { PromptRefProvider } from "../../../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../../../src/context/route"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { ThemeProvider } from "../../../../src/context/theme"
import { TuiConfigProvider } from "../../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/keymap"
import { EditorContextProvider } from "../../../../src/context/editor"
import { DialogProvider } from "../../../../src/ui/dialog"
import { ToastProvider } from "../../../../src/ui/toast"
import { createEventSource, createFetch, directory, json, wait, worktree } from "./sync-fixture"

const sessionID = "ses_prompt_transport"

const model = {
  id: "model",
  providerID: "provider",
  api: { id: "model", url: "", npm: "" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 4_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2024-01-01",
} satisfies Model

const provider = {
  id: "provider",
  name: "Provider",
  source: "custom",
  env: [],
  options: {},
  models: { model },
} satisfies Provider

const agent = {
  name: "general",
  mode: "primary",
  permission: [],
  options: {},
} satisfies Agent

// #192：prompt 提交失败时 draft 必须保留——用户不会丢失输入
test("failed TUI prompt submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0

  // #192：/config/providers 和 /provider 返回测试 model——LocalProvider 初始化需要
  // #192：/agent 返回 general agent——Prompt 组件需要可用 agent 列表
  // #192：/message 和 /prompt_async 都抛异常——覆盖两种提交路径
  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/message`) {
        attempts += 1
        throw new Error("simulated transport failure")
      }
      if (url.pathname === `/session/${sessionID}/prompt_async`) {
        attempts += 1
        throw new Error("simulated transport failure")
      }
    },
    async (prompt) => {
      // #192：set 设置 draft 文本和空 parts——模拟用户输入
      prompt.set({ input: "Keep this draft", parts: [] })
      // #192：submit 触发 promptAsync——应失败并保留 draft
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：失败后 draft 必须保留——用户输入不丢失
      expect(prompt.current.input).toBe("Keep this draft")
    },
    tmp.path,
  )
})

// #192：shell 提交失败时 draft 必须保留——含空格/引号的复杂命令不丢失
test("failed TUI shell submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/shell`) {
        attempts += 1
        throw new Error("simulated shell transport failure")
      }
    },
    async (prompt) => {
      // #192：mode: "shell" 切换到 shell 模式——走 /shell 端点
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：shell 失败后 draft 和 mode 都必须保留
      expect(prompt.current.input).toBe(draft)

      // #192：不重新 set，直接重试以验证输入框与 shell 模式都已恢复。
      prompt.submit()
      await wait(() => attempts === 2)
      await Bun.sleep(20)
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
  )
})

// #192：shell 提交成功后立即清除——不等后台完成，避免阻塞用户输入
test("accepted TUI shell submission clears without waiting for completion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/shell`) {
        attempts += 1
        return new Promise<Response>(() => {})
      }
    },
    async (prompt) => {
      // #192：mode: "shell"——成功提交后应立即清除输入
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：成功后 input 为空——不等 shell 后台完成
      expect(prompt.current.input).toBe("")
    },
    tmp.path,
  )
})

// #192：新会话 shell 提交失败时留在 home 且 draft 保留——导航可取消
test("failed new-session shell submission stays on home with the draft", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  let shellPath = ""
  const nextSessionID = "ses_new_prompt_transport"
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      // #192：POST /session 创建新会话——FetchHandler 只接收 url，用 search 区分 GET/POST
      // #192：GET /session?... 返回空列表——避免 sync 上下文 toSorted 报错
      if (url.pathname === "/session" && url.search) return json([])
      if (url.pathname === "/session") {
        return json({
          id: nextSessionID,
          slug: nextSessionID,
          projectID: "proj_test",
          directory,
          title: "New Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (url.pathname.endsWith("/shell")) {
        attempts += 1
        shellPath = url.pathname
        throw new Error("simulated shell transport failure")
      }
    },
    async (prompt, route) => {
      // #192：promptSessionID 为 undefined——触发新会话创建
      // #192：POST /session 返回新 sessionID——shell 发送到新端点
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(80)

      // #192：shell 发送到了新会话端点——不是当前 sessionID
      expect(shellPath).toBe(`/session/${nextSessionID}/shell`)
      // #192：失败后留在 home——导航被取消
      expect(route.data.type).toBe("home")
      // #192：draft 保留——新会话创建失败不丢输入
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
    { initialRoute: { type: "home" }, promptSessionID: undefined },
  )
})

// #192：slash 命令提交失败时 draft 必须保留
test("failed TUI slash-command submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `/review "path with spaces" '$HOME' | cat > out.txt $(pwd) rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/command") {
        return json([{ name: "review", source: "command", template: "", hints: [] }])
      }
      if (url.pathname === `/session/${sessionID}/command`) {
        attempts += 1
        throw new Error("simulated command transport failure")
      }
    },
    async (prompt) => {
      // #192：/review 开头的输入识别为 slash 命令
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：slash 命令失败后 draft 保留
      expect(prompt.current.input).toBe(draft)

      // #192：直接重试必须再次到达 command 端点，不能被空输入框抹掉草稿。
      prompt.submit()
      await wait(() => attempts === 2)
      await Bun.sleep(20)
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
  )
})

// #192：slash 命令提交成功后立即清除——不等后台完成
test("accepted TUI slash-command submission clears without waiting for completion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `/review "path with spaces" '$HOME' | cat > out.txt $(pwd) rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/command") {
        return json([{ name: "review", source: "command", template: "", hints: [] }])
      }
      if (url.pathname === `/session/${sessionID}/command`) {
        attempts += 1
        return new Promise<Response>(() => {})
      }
    },
    async (prompt) => {
      // #192：slash 命令成功——返回 pending Promise 模拟后台
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：命令后台执行期间输入即可清空，无需等待完成回执
      expect(prompt.current.input).toBe("")
    },
    tmp.path,
  )
})

// #0503：INV-01 + INV-04：多词 objective 必须整串 POST body.objective，
// 且不得误走 prompt_async（控制面 mutation ≠ 聊天消息）
// 期望值 "fix the login bug" 为独立规格字面量，证明未 argv 切碎
test("TUI /goal multi-word objective posts whole string without prompt_async", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let goalPosts = 0
  let promptAsync = 0
  let postedObjective = ""
  // 故意含空格的自然语言任务：若被 split 成多 token，POST 字段会错
  const draft = "/goal fix the login bug"

  await withPrompt(
    (url, _request, init) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      // 仅统计 Goal 控制面 POST；init 由 #0503 fixture 转发，方法可能在 init 或 Request 上
      if (url.pathname === `/session/${sessionID}/goal` && (init?.method === "POST" || _request?.method === "POST")) {
        goalPosts += 1
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
        postedObjective = body.objective ?? ""
        // 返回完整 Goal 形态，触发 reconcile 路径但不依赖 SSE
        return json({
          goal: {
            sessionID,
            id: "goal_test",
            objective: body.objective,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            continueOnError: false,
            generation: 1,
            reason: null,
            time: { created: 1, updated: 1 },
          },
        })
      }
      // 若 submit 误路由到聊天，此处会计数，断言要求保持 0
      if (url.pathname === `/session/${sessionID}/prompt_async`) {
        promptAsync += 1
        return json({})
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, parts: [] })
      // 与既有 shell/command transport 一致：不 await，避免测试 harness 生命周期竞态
      void prompt.submit()
      await wait(() => goalPosts > 0)
      // 成功尾必须清草稿（store），证明共享 post-success 完成
      await wait(() => prompt.current.input === "")
      expect(postedObjective).toBe("fix the login bug")
      expect(promptAsync).toBe(0)
      expect(prompt.current.input).toBe("")
    },
    tmp.path,
  )
})

// #0503：INV-05：Goal HTTP 失败时不得清草稿、不得降级为 prompt_async 发出原文
// 400 模拟 domain 拒绝（如空 objective）；用户应能就地改字重试
test("failed TUI /goal submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let goalPosts = 0
  const draft = "/goal fix the login bug"

  await withPrompt(
    (url, _request, init) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/goal` && (init?.method === "POST" || _request?.method === "POST")) {
        goalPosts += 1
        // NamedError 形态：data.message 应被 toast 消费（本用例只断言草稿保留）
        return json({ name: "GoalError", data: { message: "goal objective must not be empty" } }, { status: 400 })
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, parts: [] })
      void prompt.submit()
      await wait(() => goalPosts > 0)
      // 给失败路径 early-return 一点时间，确保没有异步清草稿
      await Bun.sleep(20)
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
  )
})

// #0503：INV-11 / plan B-01：home 无 sessionID 时先 create，再 goal POST，
// 成功必须 fall-through 共享尾 delayed navigate，不能 early-return 丢路由
// 同时断言多词 objective "a b c" 仍整串写入（与 INV-01 叠加）
test("home TUI /goal creates session posts objective and navigates", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  // 固定 create 返回 id，便于断言 navigate 目标 session
  const createdID = "ses_goal_home_nav"
  let goalPosts = 0
  let postedObjective = ""
  let promptAsync = 0
  const draft = "/goal a b c"

  await withPrompt(
    (url, _request, init) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      // submit 在 props.sessionID 为空时创建 session
      if (url.pathname === "/session" && (init?.method === "POST" || _request?.method === "POST")) {
        // #0503：directory 回显 fixture 常量——create 后 sync bootstrap 依赖它判定工作区
        return json({ id: createdID, slug: "x", version: "1", projectID: "proj_test", directory, title: "t", time: { created: 1 } })
      }
      // Goal 必须写到刚创建的 session，而不是旧常量 sessionID
      if (url.pathname === `/session/${createdID}/goal` && (init?.method === "POST" || _request?.method === "POST")) {
        goalPosts += 1
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
        postedObjective = body.objective ?? ""
        return json({
          goal: {
            sessionID: createdID,
            id: "goal_home",
            objective: body.objective,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            continueOnError: false,
            generation: 1,
            reason: null,
            time: { created: 1, updated: 1 },
          },
        })
      }
      if (url.pathname.includes("prompt_async")) {
        promptAsync += 1
        return json({})
      }
    },
    async (prompt, route) => {
      prompt.set({ input: draft, parts: [] })
      void prompt.submit()
      await wait(() => goalPosts > 0)
      expect(postedObjective).toBe("a b c")
      expect(promptAsync).toBe(0)
      // 共享尾 setTimeout(50) navigate；等到 route 进入新 session
      await wait(
        () => route.data.type === "session" && (route.data as { sessionID?: string }).sessionID === createdID,
      )
      expect(route.data).toEqual({ type: "session", sessionID: createdID })
    },
    tmp.path,
    {
      // 显式 home + 无 promptSessionID，复现 create-then-send 生产路径
      initialRoute: { type: "home" },
      promptSessionID: undefined,
    },
  )
})

// #491：三态单行矩阵——160 列终端内限制真实 Prompt 为 75 列，锁定“终端宽但 Prompt 窄”的偏差。
// IDE registry 腿经 env 播种确定化（不依赖宿主 IDE 会话）；voice 交互腿依赖宿主转写子进程，
// 由 prompt-voice-input 单测覆盖 compact 文案矩阵。
test("keeps the constrained Prompt extension bar on one row across active states", async () => {
  // #491：宽度选项经 withPrompt 注入，验证的是分栏布局下的真实 Yoga 宽度而非终端总宽。
  await using tmp = await tmpdir()
  const stateDir = path.join(tmp.path, "state")
  await fs.mkdir(stateDir, { recursive: true })
  await Bun.write(path.join(stateDir, "kv.json"), "{}")
  // #491：OPENCODE_IDE_REGISTRY_DIR 指向用例私有目录，宿主 IDE 注册表不会渗入断言。
  const registryDir = path.join(stateDir, "ide")
  await fs.mkdir(registryDir, { recursive: true })
  const previousRegistry = process.env.OPENCODE_IDE_REGISTRY_DIR
  process.env.OPENCODE_IDE_REGISTRY_DIR = registryDir
  // 重复片段刻意让标签超过 75/3 的预算：断言的是可见 suffix，而非 JavaScript 字符数阈值。
  await Bun.write(
    path.join(registryDir, "vscode.json"),
    JSON.stringify({
      schema: 1,
      updatedAt: Date.now(),
      workspaceFolders: [{ fsPath: worktree, uri: pathToFileURL(worktree).toString() }],
      active: {
        textEditor: pathToFileURL(path.join(directory, `${"very-long-".repeat(8)}hotspots.md`)).toString(),
      },
    }),
  )

  try {
    await withPrompt(
      () => undefined,
      async (_prompt, _route, app, context) => {
        // 断言最终字符帧而非复制 Yoga 算法，确保 flex 收缩和 renderer 换行都走生产路径。
        const waitForFrame = async (predicate: (frame: string) => boolean) => {
          for (let index = 0; index < 200; index++) {
            await app.renderOnce()
            const frame = app.captureCharFrame()
            if (predicate(frame)) return frame
            await Bun.sleep(10)
          }
          throw new Error("Prompt footer frame did not settle")
        }
        // #491：行数统计基于 trim 后非空行——纯空白行是 renderer 留白，不构成“扩展栏”证据。
        const extensionRows = (frame: string) => {
          const lines = frame.split("\n")
          // 输入框底边是稳定的用户可见边界，避免用组件节点或私有 renderer 尺寸定义“扩展栏”。
          const separator = lines.findIndex((line) => line.includes("╹"))
          return lines.slice(separator + 1).filter((line) => line.trim()).length
        }

        // idle 帧必须等到 bridge registry 文件标签渲染，证明该腿走生产消费链而非仅探针验证。
        const idle = await waitForFrame((frame) => frame.includes("hotspots.md"))
        emitSessionStatus(context, "evt-prompt-footer-busy", { type: "busy" })
        await wait(() => context.sync.data.session_status?.[sessionID]?.type === "busy")
        const busy = await settlePromptFrame(app)

        // 超长 retry 同时施压摘要、固定元数据和 interrupt，防止仅修普通文件行却漏掉错误态。
        emitSessionStatus(context, "evt-prompt-footer-retry", {
          type: "retry",
          attempt: 7,
          next: Date.now() + 9_000,
          message:
            "Cannot connect to API: The socket connection was closed unexpectedly. Inspect the full provider transport failure for a complete diagnostic trace of this retry cycle.",
        })
        await wait(() => context.sync.data.session_status?.[sessionID]?.type === "retry")
        const retry = await settlePromptFrame(app)

        // idle 基线进入矩阵，防止修 active 状态时破坏原始长文件场景。
        expect([idle, busy, retry].map(extensionRows)).toEqual([1, 1, 1])
        expect(idle).toContain("hotspots.md")
        expect(busy).toContain("hotspots.md")
        expect(busy).toContain("interrupt")
        expect(retry).toContain("details")
        expect(retry).toContain("retry in 9s · #7")
      },
      stateDir,
      { width: 160, promptWidth: 75 },
    )
  } finally {
    // env 恢复保证同进程后续用例不会读到本用例的私有注册表。
    if (previousRegistry === undefined) delete process.env.OPENCODE_IDE_REGISTRY_DIR
    else process.env.OPENCODE_IDE_REGISTRY_DIR = previousRegistry
  }
})

  // #491：长度落在旧 80/120 门槛夹缝内，并携带换行与重复空格以区分摘要和原始详情。
  // 点击路径同时覆盖 DialogAlert 的原始文本保真：压平只发生在 footer 展示层。
test("opens the original retry error from the compact details affordance", async () => {
  await using tmp = await tmpdir()
  const stateDir = path.join(tmp.path, "state")
  await fs.mkdir(stateDir, { recursive: true })
  await Bun.write(path.join(stateDir, "kv.json"), "{}")
  const message = "Retry provider request failed:\nThe socket   closed before the response completed. diagnostic-tail-81-to-120"

  await withPrompt(
    () => undefined,
    async (prompt, _route, app, context) => {
      // 模块级 draft stash 会跨同文件用例保留，先清空以免前一条草稿污染对话框帧。
      prompt.reset()
      emitSessionStatus(context, "evt-prompt-footer-details", { type: "retry", attempt: 2, next: Date.now() + 9_000, message })
      await wait(() => context.sync.data.session_status?.[sessionID]?.type === "retry")
      let frame = await settlePromptFrame(app)

      // footer 只展示压平后的单行摘要；换行和重复空格不能重新占用状态栏宽度。
      const lines = frame.split("\n")
      const detailsToken = "(details)"
      const detailsY = lines.findIndex((line) => line.includes(detailsToken))
      const footerLine = lines[detailsY] ?? ""
      // #505：中间截断保留可辨识后缀与详情入口；不再要求完整前缀连续出现。
      expect(footerLine).toContain("Retry provider request")
      expect(footerLine).toContain("tail-81-to-120")
      expect(footerLine).toContain(detailsToken)
      expect(footerLine).not.toContain("socket   closed")
      expect(footerLine).not.toContain("click to expand")
      const detailsX = lines[detailsY]?.indexOf(detailsToken) ?? -1
      expect(detailsX).toBeGreaterThanOrEqual(0)
      // 坐标来自最终字符帧中的可见令牌，确保测试覆盖用户实际能点击的命中区域。
      const targetX = detailsX + Math.floor(detailsToken.length / 2)
      app.renderer.clearSelection()
      await app.mockMouse.moveTo(targetX, detailsY)
      await app.renderOnce()
      await app.mockMouse.click(targetX, detailsY)

      // 点击行为通过真实 dialog frame 验证，避免断言私有 handler 或 DialogAlert 调用次数。
      frame = await settlePromptFrame(app)
      expect(frame).toContain("Retry Error")
      // 对话框保留三连空格，证明压平只属于 footer 展示层，没有污染诊断原文。
      expect(frame).toContain("The socket   closed before the response completed")
      expect(frame).toContain("diagnostic-tail-81-to-120")
    },
    stateDir,
    { width: 160, promptWidth: 100 },
  )
})

// #505：短错误必须与红色 (details) 左起成组；flexGrow 会把详情推到行尾并制造“两端对齐”假象。
test("keeps short retry details left-aligned and error-colored", async () => {
  await using tmp = await tmpdir()
  const stateDir = path.join(tmp.path, "state")
  await fs.mkdir(stateDir, { recursive: true })
  await Bun.write(path.join(stateDir, "kv.json"), "{}")

  await withPrompt(
    () => undefined,
    async (_prompt, _route, app, context) => {
      emitSessionStatus(context, "evt-prompt-footer-short-details", {
        type: "retry",
        attempt: 1,
        next: Date.now() + 9_000,
        message: "Short error",
      })
      await wait(() => context.sync.data.session_status?.[sessionID]?.type === "retry")
      const frame = await settlePromptFrame(app)

      const footerLine = frame.split("\n").find((line) => line.includes("(details)")) ?? ""
      // 连续 token 证明 summary 未占用剩余空白把 details 推远。
      expect(footerLine).toContain("Short error (details)")

      // 色彩断言走 spans： fg 归一为字符串后比较，两个 span 必须同色（error）。
      const spans = (app as unknown as { captureSpans: () => { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> } }).captureSpans()
      const line = spans.lines.find((item) => item.spans.some((span) => span.text.includes("(details)")))
      const errorSpan = line?.spans.find((span) => span.text.includes("Short error"))
      const detailsSpan = line?.spans.find((span) => span.text.includes("(details)"))
      expect(errorSpan).toBeDefined()
      expect(detailsSpan).toBeDefined()
      const colorKey = (fg: unknown) => JSON.stringify(typeof fg === "function" ? fg.name : fg)
      // 详情入口与错误摘要同色，避免 muted 弱化可点击诊断入口。
      expect(colorKey(detailsSpan!.fg)).toBe(colorKey(errorSpan!.fg))
    },
    stateDir,
    { width: 160, promptWidth: 100 },
  )
})

type FetchHandler = Parameters<typeof createFetch>[0]
// #491：状态必须经过 SDK event source 进入 SyncProvider，测试不能直接写 store 绕过生产消费链。
type PromptContext = { emit: ReturnType<typeof createEventSource>["emit"]; sync: ReturnType<typeof useSync> }
type PromptStatus = NonNullable<PromptContext["sync"]["data"]["session_status"]>[string]

function emitSessionStatus(context: PromptContext, id: string, status: PromptStatus) {
  context.emit({ directory, project: "proj_test", payload: { id, type: "session.status", properties: { sessionID, status } } })
}

async function settlePromptFrame(app: Awaited<ReturnType<typeof testRender>>) {
  // promptWidth 在首帧由 Yoga 回填；等待固定数量的真实渲染帧后再读取最终布局。
  for (let index = 0; index < 5; index++) await app.renderOnce()
  return app.captureCharFrame()
}

// #192：withPrompt——挂载完整 TUI Provider 树并暴露 PromptRef
// #192：override 控制 fetch 行为——模拟 transport 成功/失败
// #192：run 回调接收 PromptRef 和 route——测试操作 prompt 并验证路由
// #192：options 控制 initialRoute 和 promptSessionID——新会话测试需要
// #192：mounted promise 确保 Prompt ref 就绪后再执行测试
// #192：state 传入 tmp.path——TestTuiContexts 设置路径
// #192：mounted promise 是测试同步屏障，避免在 ref 未挂载时操作导致空指针
async function withPrompt(
  override: FetchHandler,
  run: (
    prompt: PromptRef,
    route: ReturnType<typeof useRoute>,
    app: Awaited<ReturnType<typeof testRender>>,
    context: PromptContext,
  ) => Promise<void>,
  state: string,
  options: {
    initialRoute?: Route
    promptSessionID?: string
    width?: number
    promptWidth?: number
  } = {},
) {
  const calls = createFetch(override)
  const events = createEventSource()
  let prompt!: PromptRef
  let sync!: ReturnType<typeof useSync>
  let local!: ReturnType<typeof useLocal>
  let route!: ReturnType<typeof useRoute>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  const app = await testRender(
    () => (
      <PromptHarness
        state={state}
        fetch={calls.fetch}
        events={events.source}
        initialRoute={options.initialRoute ?? { type: "session", sessionID }}
        promptSessionID={"promptSessionID" in options ? options.promptSessionID : sessionID}
        onContext={(nextSync, nextLocal) => {
          sync = nextSync
          local = nextLocal
        }}
        onRoute={(nextRoute) => {
          route = nextRoute
        }}
        onPrompt={(ref) => {
          prompt = ref
          ready()
        }}
        promptWidth={options.promptWidth}
      />
    ),
    {
      // #491：默认 100 列保持旧 transport 用例不变，只有布局回归显式模拟首页的 75 列 Prompt。
      width: options.width ?? 100,
      height: 20,
      footerHeight: 0,
    },
  )

  try {
    await mounted
    await wait(() => sync.status === "complete" && local.model.ready)
    // #491：只把 renderer 传给需要断言用户可见帧的测试；既有 transport 测试会自然忽略后两个参数。
    await run(prompt, route, app, { emit: events.emit, sync })
  } finally {
    app.renderer.destroy()
  }
}

function PromptHarness(props: {
  state: string
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
  initialRoute: Route
  promptSessionID: string | undefined
  promptWidth: number | undefined
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider exit={() => {}}>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={props.initialRoute}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                      <ProjectProvider>
                        <PermissionProvider>
                          <LocationProvider>
                            <DataProvider>
                            <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocalProvider>
                              <PromptStashProvider>
                                <DialogProvider>
                                  <FrecencyProvider>
                                    <PromptHistoryProvider>
                                      <PromptRefProvider>
                                        <EditorContextProvider>
                                          <PromptProbe
                                            sessionID={props.promptSessionID}
                                            width={props.promptWidth}
                                            onContext={props.onContext}
                                            onRoute={props.onRoute}
                                            onPrompt={props.onPrompt}
                                          />
                                        </EditorContextProvider>
                                      </PromptRefProvider>
                                    </PromptHistoryProvider>
                                  </FrecencyProvider>
                                </DialogProvider>
                              </PromptStashProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                            </DataProvider>
                          </LocationProvider>
                        </PermissionProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function PromptProbe(props: {
  sessionID: string | undefined
  width: number | undefined
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  props.onContext(useSync(), useLocal())
  props.onRoute(useRoute())
  // #491：width 包裹模拟首页分栏下的真实 Prompt Yoga 宽度，而不是终端总宽。
  const prompt = (
    <Prompt
      sessionID={props.sessionID}
      placeholders={{ normal: [], shell: [] }}
      ref={(ref) => {
        if (!ref) return
        props.onPrompt(ref)
      }}
    />
  )
  if (!props.width) return prompt
  return <box width={props.width}>{prompt}</box>
}
