import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Layer } from "effect"
import { Config } from "../../../src/config/config"
import { resolveNetworkOptions } from "../../../src/cli/network"
import { tmpdir } from "../../fixture/fixture"

// 该用例锁定远程客户端的完整启动链，避免 discovery 后的更新检查再次打开本地数据库。
describe("remote client global config", () => {
  test("discovery and delayed updater leave the local database closed", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "data", "opencode", "client.db") // 显式临时路径让任何隐式 Database 初始化都可被直接观察。
    const lockPath = path.join(tmp.path, "state", "owner.json") // 临时 owner 模拟正在运行的远程服务，不接触开发机真实锁。
    await mkdir(path.dirname(lockPath), { recursive: true })
    await mkdir(path.join(tmp.path, "config", "opencode"), { recursive: true })
    await Bun.write(path.join(tmp.path, "config", "opencode", "opencode.json"), JSON.stringify({ autoupdate: false })) // 禁用更新网络请求后仍须覆盖 updater 的配置读取链。
    await Bun.write(path.join(tmp.path, "config", "opencode", "config"), "= invalid") // HEAD 忽略 legacy TOML 导入失败，共享 reader 必须保留该启动行为。
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ healthy: true, version: InstallationVersion }), // 内存健康端点满足复用判定，不启动真实 Daemon。
    })
    const tuiURL = new URL("../../../src/cli/cmd/tui.ts", import.meta.url).href
    const upgradeURL = new URL("../../../src/cli/upgrade.ts", import.meta.url).href
    const databaseURL = new URL("../../../../core/src/database/database.ts", import.meta.url).href
    const script = `
      import { existsSync } from "node:fs"
      const { Database } = await import(${JSON.stringify(databaseURL)})
      const { discoverOrSpawnDaemon } = await import(${JSON.stringify(tuiURL)})
      const { upgrade } = await import(${JSON.stringify(upgradeURL)})
      const result = await discoverOrSpawnDaemon({ port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] }) // 生产 discovery 是第一条配置读取入口。
      const notice = await upgrade() // 继续执行真实 updater，覆盖复用成功后的延迟初始化链。
      console.log(JSON.stringify({ result, notice, dbCreated: existsSync(${JSON.stringify(dbPath)}) }))
      process.exit(0) // 子模块测试显式结束，避免服务缓存句柄掩盖真实行为结果。
    `
    await Bun.write(lockPath, JSON.stringify({
      pid: process.pid, // owner 使用当前测试 PID，health 复用不会触发任何 spawn。
      port: server.port,
      token: "remote-client-test",
      dbPath, // owner 与客户端显式 OPENCODE_DB 身份一致，保证走复用分支。
      channel: InstallationChannel,
      startedAt: new Date().toISOString(),
    }))
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        OPENCODE_DB: dbPath,
        OPENCODE_LOCK_PATH: lockPath,
        OPENCODE_TEST_HOME: path.join(tmp.path, "home"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const output = await new Response(proc.stdout).text()
      const errors = await new Response(proc.stderr).text()
      const code = await proc.exited // 子进程非零时保留 stderr，避免把模块初始化失败误判为配置成功。
      if (code !== 0) throw new Error(`client module failed (${code}): ${errors}`)
      const result = JSON.parse(output.trim()) as {
        result: { url: string }
        notice?: unknown
        dbCreated: boolean
      }
      expect(result.result.url).toBe(`http://127.0.0.1:${server.port}`) // 返回地址必须属于既有 owner，而不是新启动服务。
      expect(result.notice).toBeUndefined() // autoupdate:false 时不会发起更新网络请求或产生更新提示。
      expect(result.dbCreated).toBe(false) // discovery 与 updater 完成后本地数据库文件仍不存在。
    } finally {
      proc.kill()
      await proc.exited.catch(() => undefined)
      server.stop(true) // 内存健康服务随用例关闭，不留下监听句柄。
    }
  }, 20_000)

  test("Effect network resolution uses the full Config service", async () => {
    const layer = Layer.mock(Config.Service, { getGlobal: () => Effect.succeed({ server: { port: 9876 } }) })
    const result = await Effect.runPromise(resolveNetworkOptions({ port: 4321, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] }).pipe(Effect.provide(layer)))
    expect(result.port).toBe(9876) // web/serve/acp 保留完整 Config 服务边界，只有 discovery 使用独立严格读取。
  })
})
