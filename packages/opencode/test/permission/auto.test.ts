import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionAuto } from "../../src/permission/auto"

const bash = (command: string, reviewer?: PermissionAuto.Reviewer) =>
  Effect.runPromise(
    PermissionAuto.evaluate(
      {
        permission: "bash",
        patterns: [command],
        metadata: { command },
      },
      reviewer,
    ),
  )

describe("permission auto routing", () => {
  // #198：验证 precheck allow 路径——只读命令不经过 reviewer，source 标记为 precheck
  test("allows low-risk commands after precheck", async () => {
    await expect(bash("git status --porcelain")).resolves.toMatchObject({ action: "allow", source: "precheck" })
  })

  // #198：验证 precheck deny 路径——危险命令在 reviewer 前拦截，source 标记为 precheck
  test("denies critical commands before reviewer routing", async () => {
    await expect(bash("rm -rf /")).resolves.toMatchObject({ action: "deny", source: "precheck" })
  })

  // #198：验证 prompt 路径路由到 reviewer——reviewer 返回 allow/deny 透传到最终决策
  test("routes prompt decisions to reviewer when available", async () => {
    await expect(
      bash("git add .", {
        review: () =>
          Effect.succeed({
            action: "allow",
            reason: "reviewer approved bounded git staging",
            reviewID: "review_test",
            risk_level: "medium",
            user_authorization: "medium",
          }),
      }),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer" })

    await expect(
      bash("git push", {
        review: () =>
          Effect.succeed({
            action: "deny",
            reason: "reviewer rejected unrequested push",
            reviewID: "review_test",
            risk_level: "high",
            user_authorization: "unknown",
          }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
  })

  // #198：验证无 reviewer 时回退到 ask——保持原有用户审批路径，source 标记为 reviewer_unavailable
  test("falls back to existing approval path when reviewer is not wired", async () => {
    await expect(bash("git add .")).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

  // #198：验证 strict 模式——precheck allow 仍路由到 reviewer，reason 标注 strict auto review required
  test("strict mode routes precheck allows to reviewer", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "bash",
            patterns: ["git status --porcelain"],
            metadata: { command: "git status --porcelain" },
            strict: true,
          },
          {
            review: (input) =>
              Effect.sync(() => {
                called = true
                expect(input.precheck.reason).toContain("strict auto review required")
                return {
                  action: "allow" as const,
                  reason: "strict reviewer approved read-only git status",
                  reviewID: "review_strict",
                  risk_level: "low" as const,
                  user_authorization: "low" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #198：验证 reviewer 失败路由——TimedOut fail closed 为 deny，FallbackToUser 回退到 ask
  test("reviewer failures fail closed unless they explicitly request user fallback", async () => {
    await expect(
      bash("git add .", {
        review: () => Effect.fail({ _tag: "PermissionReviewerTimedOut", message: "timed out" }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })

    await expect(
      bash("git add .", {
        review: () => Effect.fail({ _tag: "PermissionReviewerFallbackToUser", message: "fallback to user" }),
      }),
    ).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

  // #198：验证合约校验——critical+allow 和非低风险+allow+unknown authorization 均转为 deny
  test("reviewer contract contradictions fail closed", async () => {
    await expect(
      bash("git add .", {
        review: () =>
          Effect.succeed({
            action: "allow",
            reason: "critical but allowed",
            reviewID: "review_bad",
            risk_level: "critical",
            user_authorization: "high",
          }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })

    await expect(
      bash("git add .", {
        review: () =>
          Effect.succeed({
            action: "allow",
            reason: "missing authorization",
            reviewID: "review_bad_auth",
            risk_level: "medium",
            user_authorization: "unknown",
          }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
  })
})
