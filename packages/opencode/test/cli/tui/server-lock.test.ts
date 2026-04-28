import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as ServerLockModule from "../../../src/cli/cmd/tui/server-lock"

// Each test suite redirects the lock file into a temp directory.
describe("ServerLock", () => {
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(async () => {
    const tmp = await tmpdir()
    ServerLockModule._setLockPath(path.join(tmp.path, "tui-server.json"))
    cleanup = tmp[Symbol.asyncDispose]
  })

  afterEach(async () => {
    ServerLockModule._setLockPath(undefined)
    await cleanup?.()
    cleanup = undefined
  })

  describe("write / read", () => {
    test("round-trips pid and port", async () => {
      await ServerLockModule.write(54321)
      const lock = await ServerLockModule.read()
      expect(lock).toBeDefined()
      expect(lock!.pid).toBe(process.pid)
      expect(lock!.port).toBe(54321)
      expect(typeof lock!.startedAt).toBe("string")
    })

    test("read returns undefined when file is absent", async () => {
      const lock = await ServerLockModule.read()
      expect(lock).toBeUndefined()
    })

    test("read returns undefined for corrupt JSON", async () => {
      const { _setLockPath } = ServerLockModule
      // Write garbage directly
      await Bun.write(path.join((await tmpdir()).path, "x"), "")
      // Use a path that exists but has invalid content
      const tmp2 = await tmpdir()
      const p = path.join(tmp2.path, "bad.json")
      await Bun.write(p, "{ not valid json }")
      _setLockPath(p)
      const lock = await ServerLockModule.read()
      expect(lock).toBeUndefined()
      _setLockPath(p) // keep pointing at bad file, afterEach resets anyway
      await tmp2[Symbol.asyncDispose]()
    })
  })

  describe("clear", () => {
    test("removes the lock file", async () => {
      await ServerLockModule.write(1234)
      await ServerLockModule.clear()
      const lock = await ServerLockModule.read()
      expect(lock).toBeUndefined()
    })

    test("does not throw when file is already absent", async () => {
      await expect(ServerLockModule.clear()).resolves.toBeUndefined()
    })
  })

  describe("alive", () => {
    test("current process is alive", () => {
      expect(ServerLockModule.alive(process.pid)).toBe(true)
    })

    test("very large PID is not alive", () => {
      // PIDs are bounded by the OS (typically < 4 million); this should not exist.
      expect(ServerLockModule.alive(2_000_000_000)).toBe(false)
    })
  })

  describe("ping", () => {
    test("returns true for a running HTTP server that responds with 200", async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/global/health")
            return Response.json({ healthy: true, version: "test" })
          return new Response("not found", { status: 404 })
        },
      })
      try {
        expect(await ServerLockModule.ping(server.port!)).toBe(true)
      } finally {
        server.stop(true)
      }
    })

    test("returns false for a port with no listener", async () => {
      // Port 1 is privileged and almost certainly not open in tests.
      // Use a high ephemeral port instead and verify quickly (2 s timeout in ping).
      // We bind to 0 to get a free port, then immediately close it — the OS
      // may not reuse it immediately.
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
      const port = server.port!
      server.stop(true)
      // Give the OS a brief moment to release the port.
      await Bun.sleep(50)
      const result = await ServerLockModule.ping(port)
      // The port was just freed; with very high probability it is not yet re-bound.
      // If it is re-bound this assertion may flip — acceptable flakiness for this edge case.
      expect(result).toBe(false)
    })

    test("returns false for health endpoint returning non-200", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("bad gateway", { status: 502 })
        },
      })
      try {
        expect(await ServerLockModule.ping(server.port!)).toBe(false)
      } finally {
        server.stop(true)
      }
    })
  })
})
