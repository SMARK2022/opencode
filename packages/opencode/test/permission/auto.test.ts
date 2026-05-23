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

// #203：shell-origin external_directory 辅助——复用同一条 shell 命令证据做确定性预审
const shellExternalDirectory = (command: string, reviewer?: PermissionAuto.Reviewer) =>
  Effect.runPromise(
    PermissionAuto.evaluate(
      {
        permission: "external_directory",
        patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
        metadata: { action_kind: "shell", command, cwd: process.cwd(), shell: process.platform === "win32" ? "powershell" : "bash" },
      },
      reviewer,
    ),
  )

describe("permission auto routing", () => {
  // #202：验证 precheck safe 路径——只读命令不经过 reviewer，source 标记为 precheck
  test("allows safe commands after precheck without reviewer load", async () => {
    await expect(bash("git status --porcelain")).resolves.toMatchObject({ action: "allow", source: "precheck" })
  })

  // #202：验证 precheck dangerous 路径——危险命令在 reviewer 前拦截，source 标记为 precheck
  test("denies dangerous commands before reviewer routing", async () => {
    await expect(bash("rm -rf /")).resolves.toMatchObject({ action: "deny", source: "precheck" })
  })

  // #202：验证 cautious 路径路由到 reviewer——reviewer 返回 allow/deny 透传到最终决策
  test("routes cautious decisions to reviewer when available", async () => {
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

  // #208：验证 onReviewStart 在 reviewer 完成前报告确定性 precheck 边界
  test("reports the deterministic precheck boundary before reviewer completion", async () => {
    const starts: { reviewID: string; precheck: { level: string; reason: string } }[] = []

    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "bash",
            patterns: ["git push origin main"],
            metadata: { command: "git push origin main" },
          },
          {
            review: (input) =>
              // #208：reviewer 返回的 reviewID 应与 onReviewStart 收到的一致
              Effect.succeed({
                action: "allow",
                reason: "reviewer approved explicit push",
                reviewID: input.reviewID,
                risk_level: "high",
                user_authorization: "high",
              }),
          },
          (input) =>
            Effect.sync(() => {
              starts.push(input)
            }),
        ),
      ),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer", reviewID: starts[0]?.reviewID })
    expect(starts).toHaveLength(1)
    // #208：precheck level 为 cautious——git push 属于 cautious 路由到 reviewer
    expect(starts[0].precheck).toMatchObject({ level: "cautious" })
  })

  // #208：验证 reviewer 失败时保留已 minted 的 reviewID
  test("keeps the started review id when reviewer execution fails closed", async () => {
    let started: string | undefined

    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "bash",
            patterns: ["git push origin main"],
            metadata: { command: "git push origin main" },
          },
          { review: () => Effect.fail(new Error("provider unavailable")) },
          (input) =>
            // #208：onReviewStart 回调记录 minted reviewID——deny 仍携带此 ID 供审计
            Effect.sync(() => {
              started = input.reviewID
            }),
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer", reviewID: started })
  })

  // #203：PowerShell 用户目录凭据读取走 cautious → reviewer，防止 $env:USERPROFILE 展开绕过敏感路径检测
  test("routes PowerShell user-profile credential reads to reviewer", async () => {
    let called = false
    await expect(
      bash(String.raw`Get-Content -LiteralPath "$env:USERPROFILE\.aws\credentials"`, {
        review: () =>
          Effect.sync(() => {
            called = true
            return {
              action: "deny" as const,
              reason: "reviewer rejected user-profile credential read",
              reviewID: "review_powershell_credentials",
              risk_level: "high" as const,
              user_authorization: "unknown" as const,
            }
          }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #203：PowerShell SSH 私钥读取/列举走 cautious → reviewer，覆盖 id_rsa/id_ed25519/id_ecdsa 与目录列举
  test("routes PowerShell SSH private key access to reviewer", async () => {
    let called = false
    const reviewer = {
      review: () =>
        Effect.sync(() => {
          called = true
          return {
            action: "deny" as const,
            reason: "reviewer rejected SSH private key access",
            reviewID: "review_ssh_key",
            risk_level: "high" as const,
            user_authorization: "unknown" as const,
          }
        }),
    }

    await expect(
      bash(
        String.raw`Get-Content -Path "$env:USERPROFILE\.ssh\id_rsa" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ed25519" -ErrorAction SilentlyContinue; Get-Content -Path "$env:USERPROFILE\.ssh\id_ecdsa" -ErrorAction SilentlyContinue`,
        reviewer,
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    await expect(
      bash(String.raw`Get-ChildItem -Path "$env:USERPROFILE\.ssh" -Force -ErrorAction SilentlyContinue`, reviewer),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #203：shell-origin external_directory 复用命令证据——safe 放行，cautious 也放行给 bash auto，dangerous 拒绝
  test("uses shell evidence for external directory auto routing", async () => {
    await expect(shellExternalDirectory("git status --porcelain")).resolves.toMatchObject({ action: "allow", source: "precheck" })

    let called = false
    await expect(
      shellExternalDirectory("cat ~/.aws/credentials", {
        review: () =>
          Effect.sync(() => {
            called = true
            return {
              action: "deny" as const,
              reason: "reviewer rejected sensitive external read",
              reviewID: "review_external_shell",
              risk_level: "high" as const,
              user_authorization: "unknown" as const,
            }
          }),
      }),
    ).resolves.toMatchObject({ action: "allow", source: "precheck" })
    expect(called).toBe(false)

    await expect(shellExternalDirectory("rm -rf /")).resolves.toMatchObject({ action: "deny", source: "precheck" })
  })

  // #203：非 shell external_directory 缺少命令证据，走既有人工审批，不进入 reviewer
  test("keeps non-shell external directory auto on the user approval path", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
            metadata: { filepath: process.platform === "win32" ? "C:/Users/Alice/.ssh/id_rsa" : "/home/alice/.ssh/id_rsa" },
          },
          {
            review: () =>
              Effect.sync(() => {
                called = true
                return {
                  action: "deny" as const,
                  reason: "reviewer should not decide non-shell external_directory gates",
                  reviewID: "review_non_shell_external_directory",
                  risk_level: "high" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "ask", source: "precheck" })
    expect(called).toBe(false)
  })

  // #203：开发期 shell general 直接 allow——Auto shell 不弹人工确认；未命中 dangerous/cautious 的命令先放行
  test("allows shell general decisions during development without reviewer load", async () => {
    let called = false
    await expect(
      bash("unknown-tool --maybe-read", {
        review: () =>
          Effect.sync(() => {
            called = true
            return {
              action: "deny" as const,
              reason: "reviewer should not see general commands",
              reviewID: "review_general",
              risk_level: "medium" as const,
              user_authorization: "unknown" as const,
            }
          }),
      }),
    ).resolves.toMatchObject({ action: "allow", source: "precheck" })
    expect(called).toBe(false)
  })

  // #198：验证无 reviewer 时回退到 ask——保持原有用户审批路径，source 标记为 reviewer_unavailable
  test("falls back to existing approval path when reviewer is not wired", async () => {
    await expect(bash("git add .")).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

  // #203：原生 Auto reviewer 缺失时 fail closed——cautious 不降级为可点击 ask，防止点 Allow 暴露敏感 shell 输出
  test("fails closed for native Auto when reviewer is not wired", async () => {
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate({
          permission: "bash",
          patterns: ["git add ."],
          metadata: { action_kind: "shell", command: "git add .", agent: "Auto" },
        }),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
  })

  // #203：显式 user reviewer 配置强于原生 Auto fail-closed——保留用户审批作为 review 边界
  test("honors explicit user reviewer configuration for native Auto", async () => {
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate({
          permission: "bash",
          patterns: ["git add ."],
          metadata: { action_kind: "shell", command: "git add .", agent: "Auto" },
          reviewerDisabled: true,
        }),
      ),
    ).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

  // #202：验证 strict 模式——precheck safe 仍路由到 reviewer，level 透传为 safe，reason 标注 strict auto review required
  test("strict mode remains an explicit reviewer override for safe commands", async () => {
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
                expect(input.precheck.level).toBe("safe")
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
