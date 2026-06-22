import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { NetworkProxy } from "../src/network-proxy"

const originalFetch = globalThis.fetch
const originalSpawn = Bun.spawn

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
})
