import { describe, expect, test } from "bun:test"
import { fetchSessionExport, sessionExportFilename } from "./session-export"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type SessionInfo } from "@opencode-ai/client/promise"

// 协议选择必须先于读取，V1回归一旦误走Native接口就直接失败。
const nativeUnused = {
  session: {
    get: async () => {
      throw new Error("Unexpected Native session read")
    },
  },
  message: {
    list: async () => {
      throw new Error("Unexpected Native message read")
    },
  },
}
const legacyProtocol = Promise.resolve("v1" as const)

describe("sessionExportFilename", () => {
  test("generates filename from title", () => {
    expect(sessionExportFilename({ id: "ses_123", title: "Clone PR in worktree from fork" })).toBe(
      "clone-pr-in-worktree-from-fork.json",
    )
  })

  test("generates filename from slug when title missing", () => {
    expect(sessionExportFilename({ id: "ses_123", slug: "my-session-slug" })).toBe("my-session-slug.json")
  })

  test("falls back to id when title and slug are empty", () => {
    expect(sessionExportFilename({ id: "ses_123" })).toBe("ses_123.json")
  })
})

describe("fetchSessionExport", () => {
  test("fetches full transcript from client", async () => {
    const session = { id: "ses_1", title: "Test Session" } as Session
    const msg = { id: "msg_1", role: "user" } as Message
    const part = { id: "prt_1", type: "text", text: "hello" } as Part
    const messages = [{ info: msg, parts: [part] }]

    const client = {
      session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: messages }),
      },
    }

    const result = await fetchSessionExport({
      sessionID: "ses_1",
      client,
      protocol: legacyProtocol,
      api: nativeUnused,
    })

    expect(result).toEqual({
      info: session,
      messages,
    })
  })

  test("throws when session not found", async () => {
    const client = {
      session: {
        get: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
      },
    }

    expect(
      fetchSessionExport({
        sessionID: "ses_missing",
        client,
        protocol: legacyProtocol,
        api: nativeUnused,
      }),
    ).rejects.toThrow("Session not found: ses_missing")
  })

  test("Native export reads every canonical page and rejects a partial transcript", async () => {
    const info: SessionInfo = {
      id: "ses_native",
      projectID: "proj_native",
      title: "Native export",
      location: { directory: "/native" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }
    const source = [
      ...Array.from({ length: 201 }, (_, index) => ({
        id: `msg_${index}`,
        type: "user",
        text: `original ${index}`,
        time: { created: index },
        files: [{ uri: "data:text/plain;base64,QQ==", mime: "text/plain", name: "evidence.txt" }],
      })),
      // 压缩前旧消息与压缩正文都不从显示窗口重建；只排除已有合法hidden标记。
      {
        id: "msg_compact",
        type: "compaction",
        reason: "auto",
        summary: "full summary",
        recent: "tail",
        time: { created: 202 },
      },
      {
        id: "msg_hidden",
        type: "user",
        text: "hidden retry",
        time: { created: 203 },
        metadata: { hidden: { time: 1, reason: "permission-reviewer-protocol-retry" } },
      },
    ]
    const requests: Record<string, string>[] = []
    // 走App实际vendor client的HTTP解包，夹具使用当前服务端canonical形状而非旧vendor DTO。
    const api = OpenCode.make({
      baseUrl: "http://export.test",
      fetch: Object.assign(
        async (request: RequestInfo | URL) => {
          const url = new URL(request instanceof Request ? request.url : request.toString())
          if (!url.pathname.endsWith("/message")) return Response.json({ data: info })
          expect(url.pathname).toBe(`/api/session/${info.id}/message`)
          requests.push(Object.fromEntries(url.searchParams))
          const offset = Number(url.searchParams.get("cursor") ?? 0)
          const data = source.slice(offset, offset + 200)
          return Response.json({ data, cursor: { next: data.length ? String(offset + data.length) : undefined } })
        },
        { preconnect() {} },
      ),
    })
    const input = {
      sessionID: info.id,
      protocol: Promise.resolve("v2" as const),
      client: {
        session: {
          get: async () => {
            throw new Error("Unexpected legacy session read")
          },
          messages: async () => {
            throw new Error("Unexpected legacy message read")
          },
        },
      },
      api,
    }
    const result = await fetchSessionExport(input)
    expect(JSON.stringify(result)).toBe(JSON.stringify({ info, messages: source.slice(0, -1) }))
    expect(requests).toEqual([
      { limit: "200", order: "asc" },
      { limit: "200", cursor: "200" },
      { limit: "200", cursor: "203" },
    ])
    // 后页失败必须拒绝整个导出，不能返回第一页或退回legacy窗口。
    await expect(
      fetchSessionExport({
        ...input,
        api: {
          ...input.api,
          message: {
            list: async (request) => {
              if (request.cursor) throw new Error("Later page failed")
              return input.api.message.list(request)
            },
          },
        },
      }),
    ).rejects.toThrow("Later page failed")
    await expect(
      fetchSessionExport({ ...input, protocol: Promise.reject(new Error("Protocol unavailable")) }),
    ).rejects.toThrow("Protocol unavailable")
    const empty = await fetchSessionExport({
      ...input,
      api: { ...input.api, message: { list: async () => ({ data: [], cursor: {} }) } },
    })
    expect(empty).toEqual({ info, messages: [] })
  })
})
