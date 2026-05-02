import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

// `deriveSubagentSessionPermission` is imported from production. The test
// exercises the actual helper that task.ts uses to build the subagent's
// session permission, so any regression in that helper trips this test.

it.instance("subagent inherits the executing parent agent's edit restriction", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    const generalAgent = yield* Agent.use.get("general")

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    const parentSessionPermission: PermissionV1.Ruleset = []

    // 传真实父权限，固定期望才会检查 Task 的继承分支而非空默认。
    const subagentSessionPermission = deriveSubagentSessionPermission({ parentSessionPermission, subagent: generalAgent! }, planAgent!.permission)

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set(["edit", "write", "apply_patch"]))
  }),
)

it.instance("subagent's own read-only restriction remains effective", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.use.get("explore")
    expect(explore).toBeDefined()

    const parentSessionPermission: PermissionV1.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
  }),
)

it.instance(
  "custom subagent cannot enable edits denied to its executing parent agent",
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.use.get("plan")
      const my = yield* Agent.use.get("my_subagent")
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: PermissionV1.Ruleset = []
      // 自定义子代理同样承接执行代理限制，不以子代理身份绕过 source 顺序。
      const subagentSessionPermission = deriveSubagentSessionPermission({ parentSessionPermission, subagent: my! }, planAgent!.permission)
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set(["edit", "write", "apply_patch"]))
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
          permission: {
            edit: "allow",
          },
        },
      },
    },
  },
)

it.effect("subagent self permissions are preserved", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        bash: "allow",
        task: {
          "*": "deny",
          worker: "allow",
        },
        edit: "allow",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.effect("subagent inherits parent session deny rules as hard runtime ceilings", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "allow",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ bash: "deny" }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
  }),
)

it.effect("directory grants retain source parent non-allow precedence", () =>
  Effect.sync(() => {
    const executor = testAgent({ name: "executor", mode: "subagent", permission: { external_directory: "allow" } })
    const grant = Permission.fromConfig({ external_directory: { "/tmp/allowed/*": "allow" } })
    // 六行固定 oracle 同时约束父 ask、deny、原序与无父限制的 grant，不能由 helper 反算期望。
    for (const [parent, expected] of [
      [[], "allow"],
      [Permission.fromConfig({ external_directory: "ask" }), "ask"],
      [Permission.fromConfig({ external_directory: "deny" }), "deny"],
      [Permission.fromConfig({ external_directory: { "*": "deny", "/tmp/allowed/*": "ask" } }), "ask"],
      [Permission.fromConfig({ external_directory: { "*": "ask", "/tmp/allowed/*": "deny" } }), "deny"],
      [Permission.fromConfig({ external_directory: "allow" }), "allow"],
    ] as const) {
      const rules = deriveSubagentSessionPermission({ parentSessionPermission: grant, subagent: executor }, parent)
      expect(Permission.evaluate("external_directory", "/tmp/allowed/file", executor.permission, rules).action).toBe(expected)
    }
  }),
)
