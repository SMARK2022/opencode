import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import path from "path"
import { NetworkProxy } from "../src/network-proxy"

const originalFetch = globalThis.fetch
const originalSpawn = Bun.spawn

async function runChild(script: string, env: Record<string, string>) {
  // 子进程从干净的 Bun 启动环境开始，否则 idle timeout 可能已在 parent 中初始化。
  // inherited environment 保留代理/证书等真实运行条件，只覆盖本测试需要的 idle 变量。
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const child = Bun.spawn(["bun", "-e", script], {
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  // 同时读取 stdout/stderr，避免 child 在失败时因 pipe 背压而掩盖真正的 timeout 结果。
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`child exited ${exit}: ${stderr || stdout}`)
  // 返回 stdout 而不是解析实现细节，测试只依赖 native fetch 的最终可见响应。
  return stdout
}

afterEach(() => {
  globalThis.fetch = originalFetch
  // Bun.spawn 是全局进程边界；测试替换后必须恢复，避免污染后续真实网络/进程测试。
  Bun.spawn = originalSpawn
})

describe("NetworkProxy", () => {
  test("routedFetch still uses proxy routing when global fetch is mocked", async () => {
    let called = false
    globalThis.fetch = Object.assign(() => {
      called = true
      return Promise.resolve(new Response("mocked"))
    }, { preconnect: originalFetch.preconnect })

    const response = await NetworkProxy.routedFetch("http://127.0.0.1:1", { purpose: "infrastructure" }).catch(
      (error) => error,
    )

    expect(called).toBe(false)
    expect(response).toBeInstanceOf(Error)
  })

  test("infrastructureHttpClientLayer keeps Effect HTTP calls off global fetch mocks", async () => {
    let called = false
    globalThis.fetch = Object.assign(() => {
      called = true
      return Promise.resolve(new Response("mocked"))
    }, { preconnect: originalFetch.preconnect })
    // 本地 Bun server 固定成功路径：缺少 HttpClient layer 会直接失败，误用 globalThis.fetch 会返回
    // "mocked"，只有走 NetworkProxy 捕获的 native fetch 才能拿到真实服务端返回的 "native"。
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("native")
      },
    })

    try {
      const body = await Effect.runPromise(
        HttpClient.get(`${server.url}`).pipe(
          Effect.provide(NetworkProxy.infrastructureHttpClientLayer),
          Effect.flatMap((response) => response.text),
        ),
      )

      expect(body).toBe("native")
      expect(called).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("hides Windows system proxy helper processes", async () => {
    // reg.exe/conhost 弹窗只存在于 Windows；macOS scutil 与 Linux env proxy 保持原平台行为即可。
    if (process.platform !== "win32") return

    let calls = 0
    let hidden = false
    Bun.spawn = ((command: string[], options?: { windowsHide?: boolean }) => {
      // 该测试保护的是外部可见行为：系统代理刷新不能创建前台 reg.exe/conhost 弹窗。
      if (command[0] === "reg") {
        calls++
        hidden = options?.windowsHide === true
      }
      return {
        exited: Promise.resolve(1),
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            // 空 stdout + 非零退出模拟 reg query 失败；代理读取失败仍必须回退 direct，不能影响请求路径。
            controller.close()
          },
        }),
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    // refresh=true 绕过 10s 系统代理缓存，确保测试覆盖真实 helper 启动边界而不是命中旧 Promise。
    const route = await NetworkProxy.resolveProxyRoute("https://example.com", "provider", true)

    expect(calls).toBe(1)
    expect(hidden).toBe(true)
    expect(route).toEqual({ type: "direct", reason: "refresh-no-proxy" })
  })

  test("preserves timeout false through custom fetch pass-through", async () => {
    let timeout: false | number | undefined
    // 这个 seam 只观察 custom adapter 收到的 init，不复制 NetworkProxy 的 route 选择算法。
    // false 是显式关闭 Bun idle timeout 的值；undefined 会让 custom adapter 无法区分未传递和默认行为。
    await NetworkProxy.fetchWithRoute(
      async (_input: Request | string | URL, init?: RequestInit & { timeout?: false | number }) => {
        timeout = init?.timeout
        return new Response("ok")
      },
      "https://provider.invalid",
      { timeout: false },
    )

    expect(timeout).toBe(false)
  })

  test("preserves timeout false through direct native fetch beyond Bun idle timeout", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch() {
        await Bun.sleep(6_500)
        return new Response("ok")
      },
    })

    try {
      // 子进程在 Bun 启动时固定 idle timeout，只有真实 native transport 才能证明选项没有被丢弃。
      // 延迟响应故意超过 Bun 的缩放 idle 上限，但仍短于测试超时，避免把“请求慢”误写成“测试挂起”。
      // localhost 属于 NetworkProxy 的 direct supported domain；这里不测试 proxy resolver，只测试 native option。
      // 若实现把 timeout 当成 route-owned 字段剥离，child 会在同一真实延迟下返回 TimeoutError。
      // 断言完整响应正文，确认不是仅收到 headers 后 native body 仍被提前关闭。
      // 这个 direct case 是 transport owner 的最小回归，不依赖 Provider、SDK 或 Session 层。
      const output = await runChild(
        `const { NetworkProxy } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/network-proxy.ts"))}); const response = await NetworkProxy.fetch(${JSON.stringify(server.url.toString())}, { timeout: false }); console.log(await response.text())`,
        { BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      )
      expect(output.trim()).toBe("ok")
    } finally {
      server.stop(true)
    }
  }, 15_000)

  test("preserves timeout false through explicit proxy native dispatch", async () => {
    const proxy = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch() {
        await Bun.sleep(6_500)
        return new Response("ok")
      },
    })

    try {
      const target = "http://provider.invalid/explicit-proxy"
      // 非 local target 强制进入系统代理分支；direct、macOS、Windows、Linux 都走真实 public route resolver。
      // 子进程隔离 Bun 启动时的 idle 配置，parent 只提供延迟 proxy，不替代 native dispatch。
      // provider.invalid 不会命中 LOCAL/NO_PROXY，避免把 direct 成功误认为 explicit-proxy 成功。
      // explicit proxy 使用同一个 timeout contract，不能只修 direct 分支而遗漏 routed native fetch。
      // proxy server 的响应也延迟同样的时间，使 direct 与 explicit route 的比较只改变 transport path。
      // finally 停止 proxy，避免后续测试继承一个仍监听端口的进程。
      const output = await runChild(
        `const proxy = process.env.TEST_PROXY!; if (process.platform === "linux") { process.env.HTTP_PROXY = proxy; process.env.HTTPS_PROXY = proxy; process.env.NO_PROXY = "" } else { const output = process.platform === "darwin" ? "<dictionary> {\\n  HTTPEnable : 1\\n  HTTPProxy : 127.0.0.1\\n  HTTPPort : " + new URL(proxy).port + "\\n  HTTPSEnable : 0\\n}" : "ProxyEnable    REG_DWORD    0x1\\r\\nProxyServer    REG_SZ    127.0.0.1:" + new URL(proxy).port + "\\r\\nProxyOverride  REG_SZ"; Bun.spawn = ((command) => ({ exited: Promise.resolve(command[0] === "scutil" || command[0] === "reg" ? 0 : 1), stdout: new Response(output).body!, kill() {} })) as typeof Bun.spawn } const { NetworkProxy } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/network-proxy.ts"))}); await NetworkProxy.resolveProxyRoute(${JSON.stringify(target)}, "provider", true); const response = await NetworkProxy.fetch(${JSON.stringify(target)}, { timeout: false }); console.log(await response.text())`,
        { BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1", TEST_PROXY: proxy.url.toString() },
      )
      expect(output.trim()).toBe("ok")
    } finally {
      proxy.stop(true)
    }
  }, 15_000)
})
