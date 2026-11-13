import { describe, expect, test } from "bun:test"
import { connectionInfo, discoverOrSpawnDaemon, type DiscoverDaemonDeps } from "../../../src/cli/cmd/tui"

const network = { port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] as string[] }
const lock = {
  pid: 424242,
  port: 9999,
  token: "health-discovery-test",
  dbPath: "/tmp/health-discovery.db",
  channel: "local" as const,
  startedAt: new Date().toISOString(),
}

function deps(ping: DiscoverDaemonDeps["ping"], sleep: DiscoverDaemonDeps["sleep"], onClear: () => void): DiscoverDaemonDeps {
  return {
    read: async () => lock,
    alive: () => true,
    ping,
    clear: async () => { onClear() },
    acquire: async () => { throw new Error("unexpected election") },
    spawn: () => { throw new Error("unexpected spawn") },
    sleep,
    resolveDaemonFile: async () => { throw new Error("unexpected daemon target") },
    resolveNetwork: async () => ({ port: 0, hostname: "127.0.0.1", mdns: false, mdnsDomain: "opencode.local", cors: [] }),
    identity: () => ({ dbPath: lock.dbPath, channel: lock.channel }),
    placement: () => "/tmp/health-discovery.lock",
    electionTimeoutMs: 1,
    electionStaleMs: 1,
    pollMs: 1,
    waitMs: 1,
  }
}

// discovery 的复用编排是公开行为接缝；这里验证短暂忙碌恢复，而不是测试私有重试 helper。
describe("daemon health discovery", () => {
  test("retries a transient timeout and reuses the same owner", async () => {
    let pings = 0
    const sleeps: number[] = []
    let clears = 0
    const result = await discoverOrSpawnDaemon(network, deps(
      async () => {
        pings++
        return pings === 1 ? "timeout" : "ok" // 首次模拟主线程短暂忙碌，第二次恢复同一 owner 的健康响应。
      },
      async (ms) => { sleeps.push(ms) },
      () => { clears++ },
    ))
    expect(result.url).toBe("http://127.0.0.1:9999") // 恢复必须复用原 URL，不能清理锁或启动替代 Daemon。
    expect(pings).toBe(2) // 一次初始探测加一次 timeout 重试即可恢复。
    expect(sleeps).toEqual([500]) // 首次退避固定为 500ms，确定性错误不使用该等待。
    expect(clears).toBe(0) // 活 owner 的锁在整个重试期间保持原样。
  })

  test("fails deterministic authentication errors without retrying", async () => {
    let pings = 0
    const sleeps: number[] = []
    await expect(discoverOrSpawnDaemon(network, deps(
      async () => {
        pings++
        return "unauthorized" // 鉴权失败是永久错误，重试只会增加无意义启动延迟。
      },
      async (ms) => { sleeps.push(ms) },
      () => {},
    ))).rejects.toThrow("authentication failed")
    expect(pings).toBe(1) // unauthorized 在第一次响应后立即失败。
    expect(sleeps).toEqual([]) // 鉴权路径不得执行任何退避 sleep。
  })

  test("bounds exhausted timeouts and keeps connectionInfo observational", async () => {
    let pings = 0
    const sleeps: number[] = []
    const ping = async () => {
      pings++
      return "timeout" as const // 持续 timeout 用于验证初始探测加三次重试的硬上限。
    }
    const sleep = async (ms: number) => { sleeps.push(ms) }
    await expect(discoverOrSpawnDaemon(network, deps(ping, sleep, () => {}))).rejects.toThrow("timed out")
    expect(pings).toBe(4) // 总共四次调用后必须失败并保留活 owner。
    expect(sleeps).toEqual([500, 1_000, 2_000]) // 退避序列只包含批准的三档间隔。

    pings = 0
    sleeps.length = 0
    const observed = await connectionInfo(deps(ping, sleep, () => {})) // connectionInfo 只观察一次，不继承 discovery 重试。
    expect(observed).toMatchObject({ running: true, responsive: false }) // 进程存活与业务响应状态分别呈现。
    expect(pings).toBe(1)
    expect(sleeps).toEqual([]) // 单次状态观察同样不能引入隐藏等待。
  })
})
