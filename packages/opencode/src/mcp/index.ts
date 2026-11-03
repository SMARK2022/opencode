import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { McpConnection } from "@opencode-ai/core/mcp/connection"
import { McpAuth } from "@opencode-ai/core/mcp/auth"
import { McpBrowser } from "@opencode-ai/core/mcp/browser"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"

export {
  Resource,
  Status,
  Failed,
  NotFoundError,
  ToolsChanged,
  BrowserOpenFailed,
  type AuthStatus,
  type McpTool,
  type ServerInstructions,
} from "@opencode-ai/core/mcp/connection"

export interface Interface extends Omit<McpConnection.Interface, "add"> {
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => ReturnType<McpConnection.Interface["add"]>
  readonly native: () => Effect.Effect<McpConnection.Interface>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}
export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const browser = yield* McpBrowser.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const publish = (notice: McpConnection.Notice) => {
      switch (notice.type) {
        case "tools_changed":
          return events.publish(McpConnection.ToolsChanged, { server: notice.server }).pipe(Effect.asVoid)
        case "browser_open_failed":
          return events
            .publish(McpConnection.BrowserOpenFailed, { mcpName: notice.mcpName, url: notice.url })
            .pipe(Effect.asVoid)
        case "auth_required":
          return events
            .publish(TuiEvent.ToastShow, {
              title: "MCP Authentication Required",
              message:
                notice.status === "needs_client_registration"
                  ? `Server "${notice.server}" requires a pre-registered client ID. Add clientId to your config.`
                  : `Server "${notice.server}" requires authentication. Run: opencode mcp auth ${notice.server}`,
              variant: "warning",
              duration: 8000,
            })
            .pipe(Effect.asVoid)
      }
    }
    const state = yield* InstanceState.make((instance) =>
      Effect.gen(function* () {
        // 仅在旧实例内捕获桥接；Native取出同一连接后不再要求ambient InstanceRef。
        const bridge = yield* EffectBridge.make()
        return yield* McpConnection.make({
          directory: instance.directory,
          config: () =>
            bridge.run(config.get().pipe(Effect.map((info) => ConfigMCP.resolve([ConfigMigrateV1.mcp(info) ?? {}])))),
          notify: (notice) => bridge.run(publish(notice)),
        }).pipe(
          Effect.provideService(McpAuth.Service, auth),
          Effect.provideService(McpBrowser.Service, browser),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
      }),
    )
    const native = () => InstanceState.get(state)
    const withConnection = <A, E>(f: (connection: McpConnection.Interface) => Effect.Effect<A, E>) =>
      Effect.flatMap(native(), f)
    return Service.of({
      native,
      status: () => withConnection((connection) => connection.status()),
      clients: () => withConnection((connection) => connection.clients()),
      instructions: () => withConnection((connection) => connection.instructions()),
      tools: () => withConnection((connection) => connection.tools()),
      snapshot: () => withConnection((connection) => connection.snapshot()),
      prompts: () => withConnection((connection) => connection.prompts()),
      resources: (name) => withConnection((connection) => connection.resources(name)),
      resourceTemplates: (name) => withConnection((connection) => connection.resourceTemplates(name)),
      add: (name, mcp) => withConnection((connection) => connection.add(name, ConfigMigrateV1.migrateMcp(mcp))),
      connect: (name) => withConnection((connection) => connection.connect(name)),
      disconnect: (name) => withConnection((connection) => connection.disconnect(name)),
      getPrompt: (client, name, args) => withConnection((connection) => connection.getPrompt(client, name, args)),
      readResource: (client, uri) => withConnection((connection) => connection.readResource(client, uri)),
      startAuth: (name) => withConnection((connection) => connection.startAuth(name)),
      authenticate: (name, onAuthorization) =>
        withConnection((connection) => connection.authenticate(name, onAuthorization)),
      finishAuth: (name, code) => withConnection((connection) => connection.finishAuth(name, code)),
      removeAuth: (name) => withConnection((connection) => connection.removeAuth(name)),
      supportsOAuth: (name) => withConnection((connection) => connection.supportsOAuth(name)),
      hasStoredTokens: (name) => withConnection((connection) => connection.hasStoredTokens(name)),
      getAuthStatus: (name) => withConnection((connection) => connection.getAuthStatus(name)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node, McpBrowser.node],
})

export * as MCP from "."
