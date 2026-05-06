export * as McpRuntime from "./mcp"

import { Context, Effect, Layer } from "effect"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { Config } from "./config"
import { ConfigMCP } from "./config/mcp"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { McpAuth } from "./mcp/auth"
import { McpBrowser } from "./mcp/browser"
import { McpConnection } from "./mcp/connection"

export type Interface = McpConnection.Interface
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpRuntime") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const config = yield* Config.Service
  const location = yield* Location.Service
  const events = yield* EventV2.Service
  return yield* McpConnection.make({
    directory: location.directory,
    config: () => config.entries().pipe(Effect.map(entries =>
      ConfigMCP.resolve(entries.flatMap(entry => entry.type === "document" && entry.info.mcp ? [entry.info.mcp] : [])),
    )),
    notify: notice => {
      switch (notice.type) {
        case "tools_changed":
          return events.publish(McpEvent.ToolsChanged, { server: notice.server }, { location }).pipe(Effect.asVoid)
        case "browser_open_failed":
          return events.publish(McpEvent.BrowserOpenFailed, { mcpName: notice.mcpName, url: notice.url }, { location }).pipe(Effect.asVoid)
        case "auth_required":
          return Effect.logWarning("MCP authentication required", { server: notice.server, status: notice.status })
      }
    },
  })
}))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, EventV2.node, CrossSpawnSpawner.node, McpAuth.node, McpBrowser.node],
})
