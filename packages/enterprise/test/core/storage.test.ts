import { describe, expect, test, afterAll } from "bun:test"
import { Storage } from "../../src/core/storage"

const storageStateKey = Symbol.for("opencode.enterprise.test.storage")

type StorageState = {
  objects: Map<string, string>
  originalFetch: typeof fetch
  installed: boolean
  bucket: string
  region: string
}

function useTestStorage() {
  const state = ((globalThis as typeof globalThis & Record<symbol, StorageState | undefined>)[storageStateKey] ??= {
    objects: new Map(),
    originalFetch: globalThis.fetch.bind(globalThis),
    installed: false,
    bucket: "opencode-enterprise-test",
    region: "us-east-1",
  })

  // 这里保留真实 Storage 的 S3 适配器路径，只把目标测试 bucket 拦截为内存对象存储；
  // 这样测试覆盖 read/write/list/remove 的真实 HTTP 形状，同时不会依赖 CI 上的云端密钥。
  process.env.OPENCODE_STORAGE_ADAPTER = "s3"
  process.env.OPENCODE_STORAGE_BUCKET = state.bucket
  process.env.OPENCODE_STORAGE_REGION = state.region
  process.env.OPENCODE_STORAGE_ACCESS_KEY_ID = "test-access-key"
  process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY = "test-secret-key"

  if (state.installed) return
  state.installed = true
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const bucketPath = `/${state.bucket}`
    if (url.host !== `s3.${state.region}.amazonaws.com` || (url.pathname !== bucketPath && !url.pathname.startsWith(`${bucketPath}/`))) {
      return state.originalFetch(input, init)
    }

    const key = decodeURIComponent(url.pathname.slice(bucketPath.length).replace(/^\//, ""))
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const startAfter = url.searchParams.get("start-after")
      const keys = Array.from(state.objects.keys())
        .filter((item) => item.startsWith(prefix))
        .filter((item) => !startAfter || item > startAfter)
        .sort((left, right) => left.localeCompare(right))
      const limited = url.searchParams.has("max-keys") ? keys.slice(0, Number(url.searchParams.get("max-keys"))) : keys
      // Storage.createAdapter 只解析 <Key> 节点；测试 key 全部由 Storage.resolve 生成，保持简单 XML 足够覆盖 S3 list 行为。
      return new Response(`<ListBucketResult>${limited.map((item) => `<Contents><Key>${item}</Key></Contents>`).join("")}</ListBucketResult>`, {
        headers: { "Content-Type": "application/xml" },
      })
    }

    if (request.method === "PUT") {
      state.objects.set(key, await request.text())
      return new Response(null, { status: 200 })
    }
    if (request.method === "DELETE") {
      state.objects.delete(key)
      return new Response(null, { status: 204 })
    }
    if (!state.objects.has(key)) return new Response(null, { status: 404 })
    return new Response(state.objects.get(key), { status: 200, headers: { "Content-Type": "application/json" } })
  }, state.originalFetch)
}

useTestStorage()

describe("core.storage", () => {
  test("should list files with after and before range", async () => {
    await Storage.write(["test", "users", "user1"], { name: "user1" })
    await Storage.write(["test", "users", "user2"], { name: "user2" })
    await Storage.write(["test", "users", "user3"], { name: "user3" })
    await Storage.write(["test", "users", "user4"], { name: "user4" })
    await Storage.write(["test", "users", "user5"], { name: "user5" })

    const result = await Storage.list({ prefix: ["test", "users"], after: "user2", before: "user4" })

    expect(result).toEqual([["test", "users", "user3"]])
  })

  test("should list files with after only", async () => {
    const result = await Storage.list({ prefix: ["test", "users"], after: "user3" })

    expect(result).toEqual([
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  test("should list files with limit", async () => {
    const result = await Storage.list({ prefix: ["test", "users"], limit: 3 })

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
    ])
  })

  test("should list all files without prefix", async () => {
    const result = await Storage.list()

    expect(result.length).toBeGreaterThan(0)
  })

  test("should list all files with prefix", async () => {
    const result = await Storage.list({ prefix: ["test", "users"] })

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  afterAll(async () => {
    const testFiles = await Storage.list({ prefix: ["test"] })

    for (const file of testFiles) {
      await Storage.remove(file)
    }

    const remainingFiles = await Storage.list({ prefix: ["test"] })
    expect(remainingFiles).toEqual([])
  })
})
