import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Agent.defaultLayer)

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

it.instance("[#26514] subagent spawned from plan mode inherits read-only restriction (edit denied)", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.Service.use((svc) => svc.get("plan"))
    const generalAgent = yield* Agent.Service.use((svc) => svc.get("general"))

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    // Simulate the plan-mode parent session: in real flow the plan
    // session's `permission` field is empty (Plan Mode lives on the agent
    // ruleset, not the session). So we pass [] through as the parent
    // session permission, exactly like the actual code path.
    const parentSessionPermission: Permission.Ruleset = []

    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      parentAgent: planAgent,
      subagent: generalAgent!,
    })

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "/another/path/index.tsx", effective).action).toBe("deny")
  }),
)

it.instance("[#26514] explore subagent launched from plan mode also stays read-only", () =>
  // Sibling check: even though `explore` is intrinsically read-only, the
  // bug surface is the same. Including this case to document that the fix
  // should propagate the parent **agent** permissions, not just deny edit
  // when the subagent happens to already deny it.
  Effect.gen(function* () {
    const planAgent = yield* Agent.Service.use((svc) => svc.get("plan"))
    const explore = yield* Agent.Service.use((svc) => svc.get("explore"))
    expect(planAgent).toBeDefined()
    expect(explore).toBeDefined()

    const parentSessionPermission: Permission.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      parentAgent: planAgent,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
  }),
)

it.instance(
  "[#26514] custom user subagent launched from plan mode bypasses Plan Mode read-only",
  // The most damaging case: a user-defined subagent with default
  // permissions (allow-by-default, like `general`). The subagent must NOT
  // be able to edit when the parent agent is `plan`.
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.Service.use((svc) => svc.get("plan"))
      const my = yield* Agent.Service.use((svc) => svc.get("my_subagent"))
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: Permission.Ruleset = []
      const subagentSessionPermission = deriveSubagentSessionPermission({
        parentSessionPermission,
        parentAgent: planAgent,
        subagent: my!,
      })
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      // BUG: on origin/dev edit resolves to "allow" because the plan
      // agent's `edit: deny *` rule never reaches the subagent.
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("subagent inherits explicit parent auto ceilings without depending on agent name", () =>
  Effect.gen(function* () {
    const generalAgent = yield* Agent.Service.use((svc) => svc.get("general"))
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
      generalAgent!.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: reviewerParent,
        subagent: generalAgent!,
      }),
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
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: reviewerParent,
        subagent: executor,
      }),
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
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: reviewerParent,
        subagent: restricted,
      }),
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
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: reviewerParent,
        subagent: restricted,
      }),
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
    const generalAgent = yield* Agent.Service.use((svc) => svc.get("general"))
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

    const childPermission = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: reviewerParent,
      subagent: generalAgent!,
    })
    const grandchildPermission = deriveSubagentSessionPermission({
      parentSessionPermission: childPermission,
      parentAgent: generalAgent,
      subagent: generalAgent!,
    })
    const effective = Permission.merge(generalAgent!.permission, grandchildPermission)

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
        parentAgent: undefined,
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
        parentAgent: undefined,
        subagent: executor,
      }),
    )

    // parent session 的 ask 是人工审批 ceiling；child 自己愿意 auto-review
    // 不能把用户审批要求降级成自动 reviewer 路径。
    expect(Permission.evaluate("bash", "git add .", effective).action).toBe("ask")
    expect(Permission.evaluate("external_directory", "/outside/project/*", effective).action).toBe("ask")
  }),
)

it.effect("[#26700] controller self-restrictions do not erase executor permissions", () =>
  Effect.sync(() => {
    const controller = testAgent({
      name: "controller",
      mode: "primary",
      permission: {
        "*": "deny",
        read: "deny",
        bash: "deny",
        task: {
          "*": "deny",
          executor: "allow",
        },
        edit: "deny",
        write: "deny",
      },
    })
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
        edit: "deny",
        write: "deny",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: controller,
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(
      new Set(["edit", "write", "apply_patch"]),
    )
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
