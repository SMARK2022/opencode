import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  const options = {
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  }
  const client = OpenCode.make(options)
  const fetcher = input.fetch ?? globalThis.fetch
  return {
    ...client,
    session: {
      ...client.session,
      // 已发布的客户端只挑选旧查询字段；在唯一请求边界补start，保留原序列化和错误处理。
      list: (
        query?: Parameters<OpenCodeClient["session"]["list"]>[0] & { start?: number },
        requestOptions?: Parameters<OpenCodeClient["session"]["list"]>[1],
      ) =>
        OpenCode.make({
          ...options,
          fetch: Object.assign(
            async (url: string | URL | Request, init?: RequestInit) => {
              const target = new URL(url instanceof Request ? url.url : url)
              if (query?.start !== undefined) target.searchParams.set("start", String(query.start))
              return fetcher(target, init)
            },
            { preconnect: fetcher.preconnect },
          ),
        }).session.list(query, requestOptions),
    },
  }
}

export type ServerApi = ReturnType<typeof createApiForServer>
