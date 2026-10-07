import { expect } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { reply, TestLLMServer } from "../../lib/llm-server"
import * as Daemon from "../../../src/cli/cmd/tui/daemon"
import type { ServerLock } from "../../../src/cli/cmd/tui/server-lock"

const it = testEffect(TestLLMServer.layer)
const win = process.platform === "win32" ? it.live : it.live.skip // 故障注入依赖Windows的父链与Job，不模拟Unix语义。

async function waitFor<T>(read: () => Promise<T | undefined>, name: string) {
  const deadline = Date.now() + 60_000 // 包含冷启动与Provider就绪；只作挂起护栏，不测启动速度。
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50) // 调度轮询而非假定已就绪，放行条件始终是read返回的真实证据。
  }
  throw new Error(`Timed out waiting for ${name}`)
}

win(
  "one capture host failure leaves a real daemon and concurrent Session usable",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()), // LIFO先回收后取得的daemon，再删除它正在使用的目录。
      )
      const lockPath = path.join(tmp.path, "daemon.json")
      const gate = path.join(tmp.path, "release-b") // B的成功输出只能发生在A故障之后，避免提前完成造成假绿。
      const markers = [path.join(tmp.path, "a.json"), path.join(tmp.path, "b.json")] // 两个LLM请求并发不等于命令都已spawn，独立marker证明两个执行均活跃。
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "opencode.json"),
          JSON.stringify({
            model: "test/test-model",
            permission: "allow", // 本例验证故障隔离；人工审批等待不能成为两个命令迟迟未启动的干扰源。
            provider: {
              test: {
                npm: "@ai-sdk/openai-compatible",
                name: "Test",
                env: [],
                options: { apiKey: "fixture", baseURL: llm.url }, // 请求只到本地确定性Provider，不依赖用户账号或外网。
                models: { "test-model": { name: "Test", tool_call: true, limit: { context: 100000, output: 10000 } } },
              },
            },
          }),
        ),
      )
      // 全部实例状态、选主及DB隔离；测试故障注入绝不读取或停止开发者的daemon。
      const daemon = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          Daemon._spawn(
            [process.execPath, fileURLToPath(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url))],
            {
              cwd: tmp.path,
              env: {
                ...process.env,
                OPENCODE_PROCESS_ROLE: "worker", // 覆盖测试父进程可能继承的角色，保证加载真实daemon入口。
                OPENCODE_DAEMON_LAUNCHER_PID: "",
                OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS: "120000", // fixture没有TUI SSE，等待LLM/命令期间不能被startup-idle回收。
                OPENCODE_PURE: "1", // 禁用用户插件加载，进程树中的业务命令完全由本夹具创建。
                OPENCODE_LOCK_PATH: lockPath,
                OPENCODE_DB: path.join(tmp.path, "session.db"),
                OPENCODE_TEST_HOME: path.join(tmp.path, "home"),
                XDG_DATA_HOME: path.join(tmp.path, "data"),
                XDG_STATE_HOME: path.join(tmp.path, "state"),
                XDG_CONFIG_HOME: path.join(tmp.path, "config"),
                XDG_CACHE_HOME: path.join(tmp.path, "cache"),
                OPENCODE_DAEMON_DIAG_DIR: path.join(tmp.path, "diag"),
                OPENCODE_SERVER_PASSWORD: "",
                OPENCODE_CONFIG_CONTENT: "", // 内联配置优先级高于项目文件，必须清除继承值才能命中本地Provider。
              },
            },
          ),
        ),
        (d) =>
          Effect.promise(async () => {
            d.kill()
            await d.exited // await清理完成后才允许目录释放，测试失败也不能把后台写入留给下个case。
          }),
      )
      const lock = yield* Effect.promise(() =>
        waitFor(async () => {
          if (!(await Bun.file(lockPath).exists())) return
          const value: ServerLock = await Bun.file(lockPath).json()
          if (value.pid !== daemon.pid) throw new Error("Fixture lock belongs to another daemon") // 先校验owner，再访问控制范围。
          const health = await fetch(`http://127.0.0.1:${value.port}/global/health`)
          if (health.ok) return value
        }, "isolated daemon health"),
      )
      const client = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${lock.port}`,
        directory: tmp.path, // 两个Session共用同一Project实例，不能靠拆开应用实例获得假隔离。
        throwOnError: true, // SDK的HTTP错误直接拒绝，不能把error包装对象当成成功响应。
      })
      const a = (yield* Effect.promise(() => client.session.create({ title: "isolation-a" }))).data
      const b = (yield* Effect.promise(() => client.session.create({ title: "isolation-b" }))).data
      if (!a || !b) throw new Error("Session creation did not return identities")
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
      for (const [index, marker] of markers.entries()) {
        // 从真正ShellTool的命令进程取父链；待会只终止本次调用所属host。
        const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; $h=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; [IO.File]::WriteAllText(${literal(marker)}, (@{root=$PID;host=$p.ParentProcessId;owner=$h.ParentProcessId}|ConvertTo-Json -Compress)); while(-not (Test-Path ${literal(gate)})){Start-Sleep -Milliseconds 50}; [Console]::Out.Write('survivor-output')`
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes(index === 0 ? "isolation-a" : "isolation-b"), // 按会话内容匹配，队列顺序不依赖并发HTTP到达顺序。
          reply().tool("bash", { command, description: "capture isolation", timeout: 60000 }),
          reply().text("finished").stop(), // Tool结果后仍需正常模型收尾，覆盖完整Agent loop而非仅工具入口。
        )
      }
      // 两个真实HTTP prompt经过LLM、权限、ShellTool及spawner，不使用独立的/session/shell实现。
      const replies = Promise.all(
        [a, b].map((chat) =>
          client.session.prompt({
            sessionID: chat.id,
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: chat.id === a.id ? "isolation-a" : "isolation-b" }],
          }),
        ),
      )
      // 就绪轮询期间提前观察拒绝，后面仍await原promise，失败不会被改写成成功。
      void replies.catch(() => {})
      const identities = yield* Effect.promise(() =>
        Promise.all(
          markers.map((marker) =>
            waitFor(async () => {
              if (!(await Bun.file(marker).exists())) return
              const identity: { root: number; host: number; owner: number } = await Bun.file(marker).json()
              return identity
            }, "both real ShellTool commands"),
          ),
        ),
      )
      // 旧共享路径允许击中自建daemon以复现全会话死亡；其它进程身份始终禁止注入。
      expect(identities.every((identity) => identity.host === daemon.pid || identity.owner === daemon.pid)).toBe(true)
      process.kill(identities[0].host, "SIGKILL")
      yield* Effect.promise(() => Bun.write(gate, "continue"))
      yield* Effect.promise(() => replies) // 旧共享路径在这里因连接断开而红，新路径必须完成两个真实HTTP调用。
      const messages = yield* Effect.promise(
        () => Promise.all([a, b].map((chat) => client.session.messages({ sessionID: chat.id }))), // 重新读取已存储状态，不只检查prompt瞬时返回值。
      )
      const tools = messages.map((response) =>
        response.data?.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash"),
      )
      if (tools[0]?.type !== "tool" || tools[1]?.type !== "tool")
        throw new Error("Real ShellTool results were not persisted")
      expect(tools[0].state.status).toBe("error")
      expect(JSON.stringify(tools[0].state)).toContain("shell capture host lost")
      expect(tools[1].state.status).toBe("completed")
      if (tools[1].state.status === "completed") expect(tools[1].state.output).toContain("survivor-output")
      expect(identities[0].host).not.toBe(identities[1].host)
      // 故障后的新写入再经HTTP读回，证明共享DB/Session服务持续可用。
      const created = (yield* Effect.promise(() => client.session.create({ title: "after-host-failure" }))).data
      if (!created) throw new Error("Post-failure Session creation failed")
      expect((yield* Effect.promise(() => client.session.get({ sessionID: created.id }))).data?.title).toBe(
        "after-host-failure",
      )
      expect((yield* Effect.promise(() => fetch(`http://127.0.0.1:${lock.port}/global/health`))).ok).toBe(true)
      const after: ServerLock = yield* Effect.promise(() => Bun.file(lockPath).json())
      expect(after.pid).toBe(lock.pid)
      expect(after.token).toBe(lock.token) // PID之外还核对选主任期，重启后碰巧复用端口不能冒充隔离成功。
    }),
  120_000,
)
