import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { Truncate } from "../../src/tool/truncate"
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
    const subagentSessionPermission = deriveSubagentSessionPermission(
      { parentSessionPermission, subagent: generalAgent! },
      planAgent!.permission,
    )

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    // 共享计划文件例外保留工具入口，普通文件仍由上面的实际权限断言拒绝。
    expect(Permission.evaluate("edit", path.join(".opencode", "plans", "delegated.md"), effective).action).toBe("allow")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
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
      const subagentSessionPermission = deriveSubagentSessionPermission(
        { parentSessionPermission, subagent: my! },
        planAgent!.permission,
      )
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
      // 自定义子代理也只继承父子共享的计划文件例外，不放开普通文件。
      expect(Permission.evaluate("edit", path.join(".opencode", "plans", "delegated.md"), effective).action).toBe(
        "allow",
      )
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
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

it.instance("subagent inherits explicit parent auto ceilings without depending on agent name", () =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const generalAgent = yield* agent.get("general")
    expect(generalAgent).toBeDefined()
    const reviewerParent = testAgent({
      name: "reviewer_parent",
      mode: "primary",
      permission: {
        bash: "auto",
        edit: "auto",
        external_directory: {
          "*": "auto",
          [Truncate.GLOB]: "allow",
        },
      },
    })

    const effective = Permission.merge(
      generalAgent.permission,
      deriveSubagentSessionPermission(
        {
          parentSessionPermission: [],
          subagent: generalAgent,
        },
        reviewerParent.permission,
      ),
    )

    // auto 是权限 action 的 admission ceiling，不是名为 auto 的 agent 的特例。
    // 任意 parent agent 只要显式配置 auto，就应把 child 的 allow/ask 收紧到 auto。
    expect(Permission.evaluate("bash", "git add .", effective).action).toBe("auto")
    expect(Permission.evaluate("edit", "src/a.ts", effective).action).toBe("auto")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, effective).action).toBe("allow")
  }),
)

it.effect("permission meet preserves child denies and shared external-directory allow exceptions", () =>
  Effect.sync(() => {
    const reviewerParent = testAgent({
      name: "reviewer_parent",
      mode: "primary",
      permission: {
        bash: "auto",
        edit: "auto",
        external_directory: {
          "*": "auto",
          [Truncate.GLOB]: "allow",
        },
      },
    })
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: {
          "*": "allow",
          "git push *": "deny",
        },
        edit: "deny",
        external_directory: {
          "*": "ask",
          [Truncate.GLOB]: "allow",
        },
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission(
        {
          parentSessionPermission: [],
          subagent: executor,
        },
        reviewerParent.permission,
      ),
    )

    // parent auto 与 child allow/ask 的交集是 auto；child deny 仍是终止边界；
    // 双方共同 allow 的内部外部目录例外继续 allow。
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("auto")
    expect(Permission.evaluate("bash", "git push origin dev", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/a.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, effective).action).toBe("allow")
  }),
)

it.effect("permission meet tightens child-specific allows behind wildcard deny fallbacks", () =>
  Effect.sync(() => {
    const reviewerParent = testAgent({
      name: "reviewer_parent",
      mode: "primary",
      permission: {
        bash: "auto",
        external_directory: "auto",
      },
    })
    const restricted = testAgent({
      name: "restricted",
      mode: "subagent",
      permission: {
        "*": "deny",
        bash: {
          "git status": "allow",
        },
        external_directory: {
          [Truncate.GLOB]: "allow",
        },
      },
    })

    const effective = Permission.merge(
      restricted.permission,
      deriveSubagentSessionPermission(
        {
          parentSessionPermission: [],
          subagent: restricted,
        },
        reviewerParent.permission,
      ),
    )

    // 子 agent 常用 `*: deny` fallback 加少量 allow 暴露能力。parent 的 broad
    // auto ceiling 必须只收紧这些 child 已允许的具体 pattern，不能因为 child
    // 在 `*` 上是 deny 就完全丢失 ceiling，也不能把其他 denied pattern 放宽。
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("auto")
    expect(Permission.evaluate("bash", "git push origin dev", effective).action).toBe("deny")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, effective).action).toBe("auto")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("deny")
  }),
)

it.effect("permission meet does not replay tool wildcard deny over child-specific tightened allows", () =>
  Effect.sync(() => {
    const reviewerParent = testAgent({
      name: "reviewer_parent",
      mode: "primary",
      permission: {
        bash: "auto",
      },
    })
    const restricted = testAgent({
      name: "restricted",
      mode: "subagent",
      permission: {
        bash: {
          "*": "deny",
          "git status": "allow",
        },
      },
    })

    const effective = Permission.merge(
      restricted.permission,
      deriveSubagentSessionPermission(
        {
          parentSessionPermission: [],
          subagent: restricted,
        },
        reviewerParent.permission,
      ),
    )

    // tool-specific `*: deny` fallback 与全局 `*: deny` 一样，只是 child 的默认
    // 关闭边界。parent auto 应收紧 child 明确允许的 git status，但不能把 fallback
    // deny 重放到 overlay 末尾后再次盖掉这个 narrow allow。
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("auto")
    expect(Permission.evaluate("bash", "git push origin dev", effective).action).toBe("deny")
  }),
)

it.instance("nested subagents keep auto ceilings inherited from the parent session", () =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const generalAgent = yield* agent.get("general")
    expect(generalAgent).toBeDefined()
    const reviewerParent = testAgent({
      name: "reviewer_parent",
      mode: "primary",
      permission: {
        bash: "auto",
        edit: "auto",
        external_directory: "auto",
      },
    })

    const childPermission = deriveSubagentSessionPermission(
      {
        parentSessionPermission: [],
        subagent: generalAgent,
      },
      reviewerParent.permission,
    )
    const grandchildPermission = deriveSubagentSessionPermission(
      {
        parentSessionPermission: childPermission,
        subagent: generalAgent,
      },
      generalAgent.permission,
    )
    const effective = Permission.merge(generalAgent.permission, grandchildPermission)

    // 第二跳的 direct parent agent 已经是 general；因此第一跳写入 parent session
    // 的 auto ceilings 必须继续作为 runtime ceiling 传递。
    expect(Permission.evaluate("bash", "git add .", effective).action).toBe("auto")
    expect(Permission.evaluate("edit", "src/a.ts", effective).action).toBe("auto")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
  }),
)

it.effect("parent session allow cannot relax child ask or auto decisions", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "ask",
        external_directory: "auto",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({
          bash: "allow",
          external_directory: "allow",
        }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("ask")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("auto")
  }),
)

it.effect("parent ask remains a user-approval ceiling over child auto", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "auto",
        external_directory: "auto",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({
          bash: "ask",
          external_directory: "ask",
        }),
        subagent: executor,
      }),
    )

    // parent session 的 ask 是人工审批 ceiling；child 自己愿意 auto-review
    // 不能把用户审批要求降级成自动 reviewer 路径。
    expect(Permission.evaluate("bash", "git add .", effective).action).toBe("ask")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("ask")
  }),
)

it.effect("directory grants preserve child-shared session exceptions over parent agent defaults", () =>
  Effect.sync(() => {
    const executor = testAgent({ name: "executor", mode: "subagent", permission: { external_directory: "allow" } })
    const grant = Permission.fromConfig({ external_directory: { "/tmp/allowed/*": "allow" } })
    // 共享会话授权后叠加；六组同时固定授权路径和未授权路径的行为，不能只检查 grant 存在。
    for (const [parent, outside] of [
      [[], "allow"],
      [Permission.fromConfig({ external_directory: "ask" }), "ask"],
      [Permission.fromConfig({ external_directory: "deny" }), "deny"],
      [Permission.fromConfig({ external_directory: { "*": "deny", "/tmp/allowed/*": "ask" } }), "deny"],
      [Permission.fromConfig({ external_directory: { "*": "ask", "/tmp/allowed/*": "deny" } }), "ask"],
      [Permission.fromConfig({ external_directory: "allow" }), "allow"],
    ] as const) {
      const rules = deriveSubagentSessionPermission({ parentSessionPermission: grant, subagent: executor }, parent)
      expect(Permission.evaluate("external_directory", "/tmp/allowed/file", executor.permission, rules).action).toBe(
        "allow",
      )
      expect(Permission.evaluate("external_directory", "/tmp/outside/file", executor.permission, rules).action).toBe(
        outside,
      )
    }
  }),
)
