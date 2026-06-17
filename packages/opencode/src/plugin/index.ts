import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
// [local-smark] VscodeBridgePlugin
import { VscodeBridgePlugin } from "./vscode-bridge"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
// [local-smark] provider alias support
import { aliasContext, buildBaseProviderMap } from "@/provider/alias"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    VscodeBridgePlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  if (isServerPlugin(mod.default)) return [mod.default]

  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  const named = Object.entries(mod).filter(
    ([name, entry]) => name !== "default" && name.endsWith("Plugin") && isServerPlugin(entry),
  )
  const candidates =
    named.length > 0
      ? named.map(([, entry]) => entry)
      : Object.entries(mod)
          .filter(([name, entry]) => name !== "default" && isServerPlugin(entry))
          .map(([, entry]) => entry)

  if (named.length === 0 && candidates.length > 1) {
    throw new TypeError("Plugin module has multiple function exports; export a default plugin or name plugin exports with a Plugin suffix")
  }

  for (const entry of candidates) {
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    if (seen.has(plugin)) continue
    seen.add(plugin)
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}

function wrapClientForAlias(raw: ReturnType<typeof createOpencodeClient>) {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "auth") {
        return new Proxy(Reflect.get(target, prop, receiver), {
          get(authTarget, authProp, authReceiver) {
            if (authProp === "set") {
              const origSet = Reflect.get(authTarget, authProp, authReceiver)
              return async (params: { path: { id: string }; body: any }) => {
                const alias = aliasContext.getStore()
                if (alias && params.path.id === alias.baseProviderID) {
                  return origSet.call(authTarget, {
                    ...params,
                    path: { ...params.path, id: alias.providerID },
                  })
                }
                return origSet.call(authTarget, params)
              }
            }
            return Reflect.get(authTarget, authProp, authReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function createAliasHook(baseHook: Hooks, providerID: string, baseProviderID: string): Hooks {
  const aliasHook: Hooks = {}

  if (baseHook.auth) {
    aliasHook.auth = {
      ...baseHook.auth,
      provider: providerID,
      loader: baseHook.auth.loader
        ? async (getAuth, provider) => {
            return aliasContext.run({ providerID, baseProviderID }, () =>
              baseHook.auth!.loader!(getAuth, provider),
            )
          }
        : undefined,
    }
  }

  if (baseHook.provider) {
    aliasHook.provider = {
      ...baseHook.provider,
      id: providerID,
      models: baseHook.provider.models
        ? async (provider, ctx) => {
            return aliasContext.run({ providerID, baseProviderID }, () =>
              baseHook.provider!.models!(provider, ctx),
            )
          }
        : undefined,
    }
  }

  const chatHeaders = baseHook["chat.headers"]
  if (chatHeaders) {
    aliasHook["chat.headers"] = async (input, output) => {
      const mappedInput = {
        ...input,
        model: input.model ? { ...input.model, providerID: baseProviderID } : input.model,
      }
      return chatHeaders(mappedInput as any, output)
    }
  }

  const chatParams = baseHook["chat.params"]
  if (chatParams) {
    aliasHook["chat.params"] = async (input, output) => {
      const mappedInput = {
        ...input,
        model: input.model ? { ...input.model, providerID: baseProviderID } : input.model,
      }
      return chatParams(mappedInput as any, output)
    }
  }

  const systemTransform = baseHook["experimental.chat.system.transform"]
  if (systemTransform) {
    aliasHook["experimental.chat.system.transform"] = async (input, output) => {
      const mappedInput = {
        ...input,
        model: input.model ? { ...input.model, providerID: baseProviderID } : input.model,
      }
      return systemTransform(mappedInput as any, output)
    }
  }

  return aliasHook
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const baseClient = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const client = wrapClientForAlias(baseClient)
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        // Generate alias hooks for extended providers (multi-account isolation)
        const baseProviderMap = buildBaseProviderMap(cfg.provider ?? {})
        const aliasHooks: Hooks[] = []
        for (const baseHook of hooks) {
          const baseAuthProvider = baseHook.auth?.provider
          if (!baseAuthProvider) continue
          for (const [aliasID, baseType] of Object.entries(baseProviderMap)) {
            if (baseType !== baseAuthProvider) continue
            const aliasHook = createAliasHook(baseHook, aliasID, baseType)
            aliasHooks.push(aliasHook)
            yield* Effect.logInfo("created alias hook", { alias: aliasID, base: baseType })
          }
        }
        for (const aliasHook of aliasHooks) {
          hooks.push(aliasHook)
          yield* Effect.tryPromise({
            try: () => Promise.resolve((aliasHook as any).config?.(cfg)),
            catch: (err) => {
              return errorMessage(err)
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin alias config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, Config.node, RuntimeFlags.node])

export * as Plugin from "."
