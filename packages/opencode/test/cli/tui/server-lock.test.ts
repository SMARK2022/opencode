import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"

// 锁 fixture 必须隔离 XDG owner；测试 clear 的行为不能影响用户实际 daemon 的发现状态。
describe("ServerLock", () => {
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(async () => {
    const tmp = await tmpdir()
    ServerLock._setLockPath(path.join(tmp.path, "tui-server.json"))
    // fixture dispose 仍负责临时目录；覆盖锁路径不是另一个文件清理机制。
    cleanup = tmp[Symbol.asyncDispose]
  })

  afterEach(async () => {
    // 路径覆盖是模块级测试 seam，必须先恢复默认，后续 suite 才不会读已删除的目录。
    ServerLock._setLockPath(undefined)
    await cleanup?.()
    cleanup = undefined
  })

  describe("write / read", () => {
    test("round-trips pid and port", async () => {
      // 使用非默认端口防止 writer 硬编码 4096 的错误在往返测试中被默认值掩盖。
      await ServerLock.write(54321)
      const lock = await ServerLock.read()
      // read 的字段校验会拒绝缺失 token/身份的记录，writer 和 validator 错配不能产生成功锁。
      expect(lock).toBeDefined()
      expect(lock!.pid).toBe(process.pid)
      expect(lock!.port).toBe(54321)
      expect(typeof lock!.startedAt).toBe("string")
    })

    test("read returns undefined when file is absent", async () => {
      const lock = await ServerLock.read()
      // ENOENT 是首启的正常入口，与权限失败不同；不能让不存在的锁阻止第一次选举。
      expect(lock).toBeUndefined()
    })

    test("read returns undefined for corrupt JSON", async () => {
      // 故意绕过 writer 的 atomic rename，验证外部损坏记录不能被转换为可信 PID。
      const tmp2 = await tmpdir()
      const p = path.join(tmp2.path, "bad.json")
      await Bun.write(p, "{ not valid json }")
      ServerLock._setLockPath(p)
      const lock = await ServerLock.read()
      // SyntaxError 不能冒泡为 TUI 崩溃，也不能保留上次成功解析的 owner 缓存。
      expect(lock).toBeUndefined()
      await tmp2[Symbol.asyncDispose]()
    })
  })

  describe("clear", () => {
    test("removes the lock file", async () => {
      // 先建立有效锁再清除，排除只对本来就不存在的路径执行 force rm 的假阳性。
      await ServerLock.write(1234)
      await ServerLock.clear()
      // 从磁盘重新读取而不是检查内存变量，确保 clear 真正撤销了发现记录。
      const lock = await ServerLock.read()
      expect(lock).toBeUndefined()
    })

    test("does not throw when file is already absent", async () => {
      // 两个清理出口先后处理同一已删除文件应保持幂等，其他 I/O 异常仍由真实实现报告。
      await expect(ServerLock.clear()).resolves.toBeUndefined()
    })
  })

  describe("alive", () => {
    test("current process is alive", () => {
      // 以当前 PID 验证 signal 0 的只读存在性路径，测试不发送实际终止信号。
      expect(ServerLock.alive(process.pid)).toBe(true)
    })

    test("very large PID is not alive", () => {
      // 超大正 PID 检验不存在/无效 OS 结果，不能把任何异常都解释成 EPERM 的存活语义。
      expect(ServerLock.alive(2_000_000_000)).toBe(false)
    })
  })

  describe("ping", () => {
    test("returns true for a running HTTP server that responds with 200", async () => {
      // fixture 有真实 HTTP socket 与认证门，不能用对 fetch 的 mock 掩盖漏带 header 的错误。
      const credentials = { username: "health-test", password: "protected" }
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          // 无认证或错误密码返回 401，验证客户端不能依靠开放 health 绕过安全边界。
          if (req.headers.get("authorization") !== ServerLock.headers(credentials)?.Authorization)
            return new Response("unauthorized", { status: 401 })
          if (new URL(req.url).pathname === "/global/health")
            return Response.json({ healthy: true, version: InstallationVersion })
          return new Response("not found", { status: 404 })
        },
      })
      try {
        // 同一 listener 上正误 credentials 必须得到不同结果，防止 health 被偷偷改为公共路由。
        expect(await ServerLock.ping(server.port!, credentials)).toBe(true)
        expect(await ServerLock.ping(server.port!, { password: "wrong" })).toBe(false)
      } finally {
        server.stop(true)
      }
    })

    test("returns false for a port with no listener", async () => {
      // 先持有后释放端口而非猜一个固定数字，避免误探测用户机器上其他正常服务。
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
      const port = server.port!
      server.stop(true)
      await Bun.sleep(50)
      const result = await ServerLock.ping(port)
      // 网络拒绝必须成为 false，不能 catch 后返回一个伪健康成功供 discover 复用。
      expect(result).toBe(false)
    })

    test("returns false for health endpoint returning non-200", async () => {
      // HTTP 可达但状态为 502 不能算就绪，检测 resp.ok 不能退化为 fetch 未抛错。
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("bad gateway", { status: 502 })
        },
      })
      try {
        expect(await ServerLock.ping(server.port!)).toBe(false)
      } finally {
        server.stop(true)
      }
    })
  })
})
