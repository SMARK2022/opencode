import { run } from "@opencode-ai/tui"
import { TuiConfigHost } from "@opencode-ai/tui/config/host"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  // Native必须读取真实host配置；保留该入口的终端挂起策略，避免空配置禁用语音。
  return TuiConfigHost.load(process.cwd(), { terminalSuspend: false }).pipe(
    Effect.flatMap((config) =>
      run({
        ...transport,
        args: {},
        config,
        // #165：native CLI 的既有 HTTP 适配承接 legacy 查询，与被移除的线程 RPC 无关。
        fetch: gracefulFetch,
        pluginHost: {
          async start() {},
          async dispose() {},
        },
      }),
    ),
    Effect.provide(AppNodeBuilder.build(LayerNode.group([Global.node, FSUtil.node]))),
  )
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

const gracefulFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    if (response.status !== 404) return response
    const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
    if (fallback === undefined) return response
    return Response.json(fallback)
  },
  { preconnect: fetch.preconnect },
)
