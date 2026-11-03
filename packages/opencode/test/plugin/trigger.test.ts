import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, EventV2Bridge.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => {",
        "  const received = []",
        "  return {",
        `    ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '      output.system.unshift("sync")',
        "      output.system.push(...received)",
        "    },",
        "    event: ({ event }) => {",
        '      if (event.type === "message.updated") {',
        "        received.push(event.properties.info.error.name)",
        "        return new Promise(() => {})",
        "      }",
        "      return Promise.resolve()",
        "    },",
        "  }",
        "}",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
        // 使用真实 Plugin loader/adapter；闭包收件由已有 transform hook 读回，不写全局状态。
        const events = yield* EventV2Bridge.Service
        const directory = (yield* TestInstance).directory
        const terminal: SessionV1.Assistant = {
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: SessionID.make("ses_plugin_terminal"),
          role: "assistant",
          agent: "build",
          mode: "build",
          path: { cwd: directory, root: directory },
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, completed: 2 },
          finish: "error",
          error: { name: "MessageAbortedError", data: { message: "Cancelled before provider" } },
        }
        // hook 返回永不完成的 Promise，Scope 退出仍须完成并保留同步交付顺序。
        yield* Effect.addFinalizer(() =>
          events
            .publish(MessageV2.Event.Updated, { sessionID: terminal.sessionID, info: terminal }, { finalizer: true })
            .pipe(Effect.asVoid),
        ).pipe(Effect.scoped)
        expect(yield* triggerSystemTransform()).toEqual(["sync", "MessageAbortedError"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
