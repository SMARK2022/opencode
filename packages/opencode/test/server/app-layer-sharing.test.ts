import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

// 共用目标应用图，但认证配置与关闭资源仍由每个listener独立拥有。
test(
  "two listeners keep their own auth while serving the same route tree",
  async () => {
    const shared = HttpApiApp.createSharedServices()
    const make = (password: string) =>
      HttpRouter.toWebHandler(
        HttpApiApp.createRoutes(undefined, undefined, shared).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password }))),
        ),
        { memoMap: Layer.makeMemoMapUnsafe(), disableLogger: true },
      )
    const first = make("first-secret")
    const second = make("second-secret")
    const request = (password: string) =>
      new Request("http://localhost/global/health", {
        headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
      })
    try {
      expect((await first.handler(request("first-secret"), HttpApiApp.context)).status).toBe(200)
      expect((await second.handler(request("second-secret"), HttpApiApp.context)).status).toBe(200)
      // 交叉密码必须 401：listener 本地鉴权不因路由树复用而串号。
      expect((await second.handler(request("first-secret"), HttpApiApp.context)).status).toBe(401)
      await first.dispose()
      expect((await second.handler(request("second-secret"), HttpApiApp.context)).status).toBe(200)
    } finally {
      await first.dispose()
      await second.dispose()
    }

    // 原共享层生命周期例同时验证失败后的重建；新进程隔离数据库路径。
    await using tmp = await tmpdir()
    const child = Bun.spawn([process.execPath, "--no-install", "--eval", `
      const { mkdir, rm } = await import("node:fs/promises")
      const { Context, Effect, Exit, Layer, Scope } = await import("effect")
      const { HttpApiApp } = await import(${JSON.stringify(new URL("../../src/server/routes/instance/httpapi/server.ts", import.meta.url).href)})
      const { Database } = await import("@opencode-ai/core/database/database")
      const shared = HttpApiApp.createSharedServices()
      const scopes = [Scope.makeUnsafe(), Scope.makeUnsafe()]
      try {
        await mkdir(process.env.OPENCODE_DB)
        const failed = await Effect.runPromiseExit(Layer.buildWithMemoMap(shared.layer, shared.memoMap, scopes[0]))
        if (failed._tag !== "Failure") throw new Error("directory must reject SQLite open")
        await Effect.runPromise(Scope.close(scopes[0], Exit.void))
        await rm(process.env.OPENCODE_DB, { recursive: true })
        const context = await Effect.runPromise(Layer.buildWithMemoMap(shared.layer, shared.memoMap, scopes[1]))
        await Effect.runPromise(Context.get(context, Database.Service).db.run("SELECT 1"))
        console.log("retried")
      } finally {
        await Promise.all(scopes.map(scope => Effect.runPromise(Scope.close(scope, Exit.void))))
      }
    `], {
      cwd: import.meta.dir,
      env: { ...process.env, OPENCODE_DB: path.join(tmp.path, "retry.db"), OPENCODE_PURE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 50_000,
    })
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
      expect(stdout.split("\n")).toContain("retried")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  },
  60000,
)
