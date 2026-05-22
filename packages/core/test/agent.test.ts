import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("registers approval agents without changing other built-in bash policies", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      // 单独持有插件作用域，验证新增代理不会在插件卸载后残留。
      const scope = yield* Scope.make()
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Scope.provide(scope),
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "Auto",
        "build",
        "compaction",
        "decide",
        "explore",
        "general",
        "interactive",
        "plan",
        "summary",
        "title",
      ])
      const decide = yield* agent.resolve("decide")
      expect(decide).toMatchObject({ id: "decide", mode: "primary", hidden: false })
      for (const action of ["read", "bash", "edit", "task", "skill"])
        expect(PermissionV2.evaluate(action, "*", decide?.permissions ?? []).effect).toBe("deny")
      // 新增审批代理是唯一例外，既有内置代理仍沿用原来的 bash 策略。
      for (const item of agents) {
        if (item.id === "interactive" || item.id === "Auto") continue
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
      // 从实际注册表 resolve 后求值，缺失注册或错误动作会直接使断言失败。
      for (const id of ["interactive", "Auto"]) {
        const item = yield* agent.resolve(id)
        if (!item) throw new Error(`expected registered ${id} agent`)
        expect(item).toMatchObject({ id, mode: "primary", hidden: false })
        expect(item.system).toBe((yield* agent.resolve("build"))?.system)
        expect(item.system).toBeUndefined()
        expect(PermissionV2.evaluate("bash", "git status", item.permissions).effect).toBe(id === "Auto" ? "auto" : "ask")
        // 文件修改入口共用 edit；交互代理不应意外收紧普通编辑权限。
        expect(PermissionV2.evaluate("edit", "src/index.ts", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("question", "*", item.permissions).effect).toBe("allow")
        expect(PermissionV2.evaluate("plan_enter", "*", item.permissions).effect).toBe("allow")
        // 默认敏感文件和外部目录规则必须随两个新代理一起继承。
        expect(PermissionV2.evaluate("read", ".env", item.permissions).effect).toBe("ask")
        expect(PermissionV2.evaluate("external_directory", "/outside/*", item.permissions).effect).toBe("ask")
      }
      // 显式默认可以选择Auto；仅剩Auto时仍不能成为隐式fallback。
      const explicit = yield* agent.transform((draft) => draft.default(AgentV2.ID.make("Auto")))
      expect((yield* agent.default())?.id).toBe(AgentV2.ID.make("Auto"))
      expect((yield* agent.all())[0]?.id).toBe(AgentV2.ID.make("Auto"))
      yield* explicit.dispose
      const only = yield* agent.transform((draft) => {
        for (const item of draft.list()) if (item.id !== "Auto") draft.remove(item.id)
      })
      expect(yield* agent.default()).toBeUndefined()
      expect((yield* agent.resolve("Auto"))?.id).toBe(AgentV2.ID.make("Auto"))
      yield* only.dispose
      expect((yield* agent.default())?.id).toBe(AgentV2.ID.make("build"))
      const listed = yield* agent.all()
      expect(listed.slice(1).map((item) => item.id)).toEqual(listed.slice(1).map((item) => item.id).toSorted((a, b) => a.localeCompare(b)))
      // 后注册规则覆盖内置 ask，验证配置插件依赖的最后匹配契约。
      const override = yield* agent.transform((draft) =>
        draft.update(AgentV2.ID.make("interactive"), (item) => {
          item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
          item.permissions.push({ action: "edit", resource: "src/*", effect: "allow" })
        }),
      )
      const review = yield* agent.resolve("interactive")
      if (!review) throw new Error("expected configured interactive agent")
      expect(PermissionV2.evaluate("edit", "src/index.ts", review.permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", "README.md", review.permissions).effect).toBe("deny")
      // 先撤销覆盖注册，插件 scope 关闭后注册表应完全回到空状态。
      yield* override.dispose
      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.all()).toEqual([])
    }),
  )
})
