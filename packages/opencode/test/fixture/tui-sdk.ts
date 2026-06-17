import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { SDKTestTransport } from "@opencode-ai/tui/context/sdk"

export const worktree = "/tmp/opencode"
export const directory = `${worktree}/packages/opencode`

export function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

type TestEventSource = NonNullable<SDKTestTransport["events"]>

export function eventSource(): TestEventSource {
  return { subscribe: async () => () => {} }
}

export function createEventSource() {
  let fn: ((event: GlobalEvent) => void) | undefined

  return {
    source: {
      subscribe: async (handler: (event: GlobalEvent) => void) => {
        fn = handler
        return () => {
          if (fn === handler) fn = undefined
        }
      },
    } satisfies TestEventSource,
    emit(event: GlobalEvent) {
      if (!fn) throw new Error("event source not ready")
      fn(event)
    },
    dispose() {
      fn = undefined
    },
  }
}

export type FetchHandler = (url: URL, request?: Request, init?: RequestInit) => Response | Promise<Response> | undefined

export function createFetch(override?: FetchHandler) {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input))
    const pathname = url.pathname.replace(/^\/api(?=\/)/, "")
    const location = { directory }
    if (pathname === "/session") session.push(url)

    if (url.pathname.startsWith("/api/")) {
      switch (pathname) {
        case "/location":
          return json(location)
        case "/agent":
        case "/command":
        case "/integration":
        case "/model":
        case "/provider":
        case "/reference":
        case "/skill":
          return json({ location, data: [] })
      }
    }

    const normalized = new URL(url)
    normalized.pathname = pathname
    const overridden = await override?.(normalized, request, init)
    if (overridden) return overridden

    switch (pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/config":
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree, directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      // Most sync tests do not care about in-memory blockers; default empty
      // lists let reconnect/bootstrap recovery run without every test stubbing them.
      case "/permission":
      case "/question":
        return json([])
      case "/session":
        return json([])
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session }
}
