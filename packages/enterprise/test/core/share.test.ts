import { describe, expect, test } from "bun:test"
import { Share } from "../../src/core/share"
import { Storage } from "../../src/core/storage"
import { Identifier } from "@opencode-ai/core/util/identifier"

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

  // share 用例通过 Share 的公开 API 间接覆盖 Storage；同样走真实 S3 适配器配置，
  // 只把测试 bucket 映射到进程内 Map，避免并发 CI 中缺少企业存储密钥导致整组用例失效。
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
      // Share.data 依赖 list 顺序和 start-after 游标；这里模拟 S3 ListObjectsV2 的关键返回字段，不伪造生产模块。
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

describe.concurrent("core.share", () => {
  test("should create a share", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    expect(share.sessionID).toBe(sessionID)
    expect(share.secret).toBeDefined()

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should sync data to a share", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data,
    })

    const snapshot = await Storage.read<{ data: Share.Data[] }>(["share_snapshot", share.id])
    expect(snapshot?.data).toHaveLength(1)

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should sync multiple batches of data", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data1: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    const data2: Share.Data[] = [
      {
        type: "part",
        data: { id: "part2", sessionID, messageID: "msg1", type: "text", text: "World" },
      },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data1,
    })

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data2,
    })

    const snapshot = await Storage.read<{ data: Share.Data[] }>(["share_snapshot", share.id])
    expect(snapshot?.data).toHaveLength(2)

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should retrieve synced data", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
      {
        type: "part",
        data: { id: "part2", sessionID, messageID: "msg1", type: "text", text: "World" },
      },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data,
    })

    const result = await Share.data(share.id)

    expect(result.length).toBe(2)
    expect(result[0].type).toBe("part")
    expect(result[1].type).toBe("part")

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should retrieve data from multiple syncs", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data1: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    const data2: Share.Data[] = [
      {
        type: "part",
        data: { id: "part2", sessionID, messageID: "msg2", type: "text", text: "World" },
      },
    ]

    const data3: Share.Data[] = [
      { type: "part", data: { id: "part3", sessionID, messageID: "msg3", type: "text", text: "!" } },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data1,
    })

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data2,
    })

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data3,
    })

    const result = await Share.data(share.id)

    expect(result.length).toBe(3)
    const parts = result.filter((d) => d.type === "part")
    expect(parts.length).toBe(3)

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should return latest data when syncing duplicate parts", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data1: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    const data2: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello Updated" },
      },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data1,
    })

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data: data2,
    })

    const result = await Share.data(share.id)

    expect(result.length).toBe(1)
    const [first] = result
    expect(first.type).toBe("part")
    expect(first.type === "part" && first.data.type === "text" && first.data.text).toBe("Hello Updated")

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should return empty array for share with no data", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const result = await Share.data(share.id)

    expect(result).toEqual([])

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should migrate legacy event data into the snapshot", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })
    const data: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    await Storage.remove(["share_snapshot", share.id])
    await Storage.write(["share_event", share.id, Identifier.descending()], data)

    const result = await Share.data(share.id)
    const snapshot = await Storage.read<{ data: Share.Data[] }>(["share_snapshot", share.id])

    expect(result).toHaveLength(1)
    expect(snapshot?.data).toHaveLength(1)

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should throw error for invalid secret", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Test" },
      },
    ]

    expect(async () => {
      await Share.sync({
        share: { id: share.id, secret: "invalid-secret" },
        data,
      })
    }).toThrow()

    await Share.remove({ id: share.id, secret: share.secret })
  })

  test("should throw error for non-existent share", async () => {
    const sessionID = Identifier.descending()
    const data: Share.Data[] = [
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Test" },
      },
    ]

    expect(async () => {
      await Share.sync({
        share: { id: "non-existent-id", secret: "some-secret" },
        data,
      })
    }).toThrow()
  })

  test("should handle different data types", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })

    const data: Share.Data[] = [
      { type: "session", data: { id: sessionID, status: "running" } as any },
      { type: "message", data: { id: "msg1", sessionID } as any },
      {
        type: "part",
        data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Hello" },
      },
    ]

    await Share.sync({
      share: { id: share.id, secret: share.secret },
      data,
    })

    const result = await Share.data(share.id)

    expect(result.length).toBe(3)
    expect(result.some((d) => d.type === "session")).toBe(true)
    expect(result.some((d) => d.type === "message")).toBe(true)
    expect(result.some((d) => d.type === "part")).toBe(true)

    await Share.remove({ id: share.id, secret: share.secret })
  })
})
