import { expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, SessionMessage, SessionMessageAssistant } from "@opencode-ai/sdk/v2"
import type { useSyncV2 } from "../../../src/cli/cmd/tui/context/sync-v2"
import { Identifier } from "../../../src/id/id"

// mock.module 会影响同进程其他测试；只在独立子进程替换网络和事件传输边界。
if (!process.env.OPENCODE_HYDRATION_TEST_CHILD) {
  test("v2 hydration preserves live messages in an isolated provider", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENCODE_HYDRATION_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    // 同时读取两条输出管道，保留子进程具体失败断言，防止日志背压阻塞退出。
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
    } finally {
      // 断言或读取失败同样释放子进程，避免污染后续原生 renderer 用例。
      child.kill()
      await child.exited
    }
  })
} else {
  type Sync = ReturnType<typeof useSyncV2>
  // 响应只提供HTTP公开items字段，不伪造服务端没有的事件水位。
  type Response = { data: { items: SessionMessage[] } }
  // 每个请求持有独立Promise，反序回包由测试显式控制，不借助网络延迟。
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  // 未订阅时直接报fixture就绪错误，避免把丢事件误报为hydrate缺陷。
  let receive: (event: Event) => void = () => {
    throw new Error("event subscription is not ready")
  }
  // 只控制消息传输的先后；store、reconcile 和 provider 生命周期保持真实实现。
  mock.module("../../../src/cli/cmd/tui/context/event", () => ({
    useEvent: () => ({
      subscribe: (listener: typeof receive) => {
        receive = listener
      },
    }),
  }))
  // SDK替身仅替换历史读取，真实provider仍负责合并和事件消费。
  mock.module("../../../src/cli/cmd/tui/context/sdk", () => ({
    useSDK: () => ({
      client: {
        v2: {
          session: {
            messages: () => {
              const pending = Promise.withResolvers<Response>()
              requests.push(pending)
              return pending.promise
            },
          },
        },
      },
    }),
  }))
  // 替身注册先于动态导入，确保测试不会接触真实外部服务。
  const { SyncProviderV2, useSyncV2 } = await import("../../../src/cli/cmd/tui/context/sync-v2")
  // v2 消息ID来自 Started；固定时间用于构造可重复的同时间排序边界。
  const oldID = Identifier.create("evt", "ascending", 1700000000000)
  const liveID = Identifier.create("evt", "ascending", 1700000000000)
  // 模型引用使用SDK要求的三个字段，避免fixture类型缺损冒充同步失败。
  const model = { id: "fixture", providerID: "local", variant: "" }
  // SDK使用毫秒数；结束时间晚于创建时间以锁定completed的公开语义。
  const properties = { sessionID: "session", timestamp: 20 }
  // 历史创建时间早于活动消息，首例同时约束旧历史保留与最新正文的展示位置。
  const history: SessionMessage = {
    id: oldID,
    type: "user",
    text: "old history",
    files: [],
    agents: [],
    time: { created: 1 },
  }
  // 同ID区分未完成投影与完成投影，不把响应替换成另一个消息规避冲突。
  function assistant(text: string, completed?: number): SessionMessageAssistant {
    return {
      id: liveID,
      type: "assistant",
      agent: "local",
      model,
      content: [{ type: "text", text }],
      time: { created: 20, completed },
    }
  }
  function reply(index: number, items: SessionMessage[]) {
    const pending = requests[index]
    if (!pending) throw new Error(`request ${index} has not started`)
    // 回包后必须等待sync自身结束，断言观察合并后的公共结果。
    pending.resolve({ data: { items } })
  }
  // 按生产Started→Text.Started→Delta顺序输入，确保正文归属真实活动assistant。
  function start() {
    receive({ id: liveID, type: "session.next.step.started", properties: { ...properties, agent: "local", model } })
    receive({ id: "text-start", type: "session.next.text.started", properties })
    receive({ id: "text-delta", type: "session.next.text.delta", properties: { ...properties, delta: "prefix $x" } })
  }
  // 从公开fromSession读取正文，避免测试只验证某个私有合并容器。
  function text(sync: Sync, sessionID = "session") {
    const message = sync.session.message.fromSession(sessionID)[0]
    if (message?.type !== "assistant") return
    const part = message.content[0]
    return part?.type === "text" ? part.text : undefined
  }
  async function fixture(run: (sync: Sync) => Promise<void>) {
    // 每例创建独立provider，既不复用请求世代，也不继承前例消息。
    requests.length = 0
    const ready = Promise.withResolvers<Sync>()
    // 通过真实Context消费者拿到接口，provider初始化和订阅都经过实际挂载。
    function Capture() {
      ready.resolve(useSyncV2())
      return null
    }
    const app = await testRender(
      () => (
        <SyncProviderV2>
          <Capture />
        </SyncProviderV2>
      ),
      { width: 40, height: 8 },
    )
    try {
      // 消费者发布就绪信号，测试不依赖固定 sleep 猜测挂载时机。
      await run(await ready.promise)
    } finally {
      // 此fixture没有代码高亮节点；直接销毁真实renderer关闭原生资源。
      app.renderer.destroy()
    }
  }

  test("pending hydration keeps new live text and returned history", () =>
    fixture(async (sync) => {
      const pending = sync.session.message.sync("session")
      start()
      // 先验证事件已显示，随后失败才能准确归因于hydrate覆盖。
      expect(text(sync)).toBe("prefix $x")
      // 旧快照包含历史却看不到刚到达的Started，两个来源必须同时可见。
      reply(0, [history])
      await pending
      expect(text(sync)).toBe("prefix $x")
      expect(sync.session.message.fromSession("session").map((message) => message.id)).toEqual([liveID, oldID])
    }))

  test("older concurrent response cannot replace a newer completed page", () =>
    fixture(async (sync) => {
      // 页面已有终值，较新请求可以返回相同内容；值比较不能代替请求归属。
      const seed = sync.session.message.sync("session")
      reply(0, [assistant("new final", 30), history])
      await seed
      const first = sync.session.message.sync("session")
      const second = sync.session.message.sync("session")
      // 第二次请求先完成；第一份快照随后返回也不能撤销已显示的终值。
      reply(2, [assistant("new final", 30), history])
      await second
      reply(1, [assistant("old prefix")])
      await first
      expect(text(sync)).toBe("new final")
      expect(sync.session.message.fromSession("session")).toHaveLength(2)
    }))

  test("existing live prefix survives quiet pages until shorter server completion", () =>
    fixture(async (sync) => {
      start()
      const empty = sync.session.message.sync("session")
      // Delta未写持久投影；请求期间静止也必须保留请求前已经显示的正文。
      reply(0, [assistant(""), history])
      await empty
      expect(text(sync)).toBe("prefix $x")
      // 活动项未出现在旧页时仍需可见；这不授权保留已完成的历史旧页。
      const missing = sync.session.message.sync("session")
      reply(1, [history])
      await missing
      expect(text(sync)).toBe("prefix $x")
      // 完成插件允许缩短文本，权威终值承接不能依赖正文长度。
      const final = sync.session.message.sync("session")
      reply(2, [assistant("x", 30), history])
      await final
      expect(text(sync)).toBe("x")
      expect(sync.session.message.fromSession("session")[0]?.time).toEqual({ created: 20, completed: 30 })
    }))

  test("Text.Ended received during hydration survives the older unfinished snapshot", () =>
    fixture(async (sync) => {
      start()
      const pending = sync.session.message.sync("session")
      // 插件只发布一个最终文本；旧快照在该事件之前已读取，不能回退终值。
      receive({
        id: "text-ended",
        type: "session.next.text.ended",
        properties: { ...properties, text: "plugin final" },
      })
      // 持久层不投影Delta，因此此处旧未完成正文是正常生产响应。
      reply(0, [assistant("old partial"), history])
      await pending
      expect(text(sync)).toBe("plugin final")
      expect(sync.session.message.fromSession("session")).toHaveLength(2)
    }))

  test("same-ID persisted completion wins over a prefix changed during sync", async () => {
    // 分别覆盖错过 SSE 终态和本地先结束；权威正文都从同一 ID 的 HTTP 终态承接。
    for (const localCompleted of [false, true]) {
      await fixture(async (sync) => {
        start()
        const pending = sync.session.message.sync("session")
        receive({
          id: "late-delta",
          type: "session.next.text.delta",
          properties: { ...properties, delta: " half" },
        })
        // 先读到 SSE 前缀，才能区分 HTTP 覆盖与测试根本没收到事件。
        expect(text(sync)).toBe("prefix $x half")
        if (localCompleted) {
          receive({
            id: "step-ended",
            type: "session.next.step.ended",
            properties: {
              ...properties,
              timestamp: 29,
              finish: "stop",
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          const local = sync.session.message.fromSession("session")[0]
          expect(local?.type === "assistant" ? local.time.completed : undefined).toBe(29)
        }
        // 最后不发送补偿事件；观察结果必须由同步本身收敛。
        reply(0, [assistant("server final", 30), history])
        await pending
        expect(text(sync)).toBe("server final")
        expect(sync.session.message.fromSession("session")[0]?.time).toEqual({ created: 20, completed: 30 })
      })
    }
  })

  test("different sessions keep their own concurrent hydration results", () =>
    fixture(async (sync) => {
      const first = sync.session.message.sync("session")
      const second = sync.session.message.sync("other")
      // 两个Session都允许落盘；同Session的过期判定不能跨页面共享。
      reply(1, [assistant("other final", 30)])
      await second
      reply(0, [assistant("session final", 30)])
      await first
      expect(text(sync)).toBe("session final")
      // 分别检查两个Session，防止只保住最后返回的一个页面。
      expect(text(sync, "other")).toBe("other final")
    }))

  test("equal timestamps retain server binary event ID ordering", () =>
    fixture(async (sync) => {
      const pending = sync.session.message.sync("session")
      // 使用真实升序ID生产器创建的相邻ID，不用自造名称掩盖排序问题。
      receive({
        id: liveID,
        type: "session.next.prompted",
        properties: {
          ...properties,
          timestamp: 1,
          prompt: { text: "new", files: [], agents: [] },
        },
      })
      reply(0, [history])
      await pending
      expect(sync.session.message.fromSession("session").map((message) => message.id)).toEqual([liveID, oldID])
    }))

  test("unchanged completed history obeys the authoritative response page", () =>
    fixture(async (sync) => {
      const seed = sync.session.message.sync("session")
      reply(0, [assistant("old completed", 30), history])
      await seed
      // 默认接口仅返回首50条；无期间变化的旧页不能变成无限本地缓存。
      const pending = sync.session.message.sync("session")
      // 缺失的completed项按原分页淘汰，与上方活动项保留形成语义边界。
      reply(1, [history])
      await pending
      expect(sync.session.message.fromSession("session").map((message) => message.id)).toEqual([oldID])
    }))
}
