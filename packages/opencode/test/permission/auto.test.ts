import { describe, expect, test } from "bun:test"
  test("routes structured workspace deletes to reviewer as cautious", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "edit",
            patterns: ["docs/old name.md"],
            metadata: {
              agent: "auto",
              files: [{ type: "delete", relativePath: "docs/old name.md", deletions: 4 }],
            },
          },
          {
            review: (input) =>
              Effect.sync(() => {
                called = true
                // Delete is the security boundary under test. The reviewer should
                // see cautious, not generic non-shell uncertainty, so policy can
                // distinguish irreversible filesystem effects from ordinary edits.
                expect(input.precheck.level).toBe("cautious")
                return {
                  action: "allow" as const,
                  reason: "reviewer approved explicit file deletion",
                  reviewID: "review_workspace_delete",
                  risk_level: "medium" as const,
                  user_authorization: "medium" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer" })
    expect(called).toBe(true)
  })

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

// #232：shell-origin external_directory 辅助——复用同一条 shell 命令证据做确定性预审
const shellExternalDirectory = (
  command: string,
  reviewer?: PermissionAuto.Reviewer,
  metadata?: Readonly<Record<string, unknown>>,
) =>
  Effect.runPromise(
    PermissionAuto.evaluate(
      {
        permission: "external_directory",
        patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
        metadata: { action_kind: "shell", command, cwd: process.cwd(), shell: process.platform === "win32" ? "powershell" : "bash", ...metadata },
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

  // #217：bounded file deletion 路由到 reviewer 而非 shell general allow——precheck cautious 层确保删除操作不自动放行
  test("routes bounded file deletion to reviewer instead of shell general allow", async () => {
    let called = false
    await expect(
      bash(String.raw`Remove-Item -LiteralPath "H:\\DumpStack.log.tmp" -Force -ErrorAction SilentlyContinue`, {
        review: () =>
          Effect.sync(() => {
            called = true
            return {
              action: "deny" as const,
              reason: "reviewer rejected unrequested file deletion",
              reviewID: "review_delete_file",
              risk_level: "high" as const,
              user_authorization: "unknown" as const,
            }
          }),
      }),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
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
    // #209：if(Test-Path){Get-Content} 内的 Get-Content 不紧跟行首/分隔符——去掉锚点后才能被 cautiousRaw 捕获
    // #209：验证 PowerShell 条件块内的敏感读取不再因锚点漏审——deny + reviewer 证明 cautiousRaw 命中并送审
    // #209：Test-Path 与 Get-Content 在同一行但被 { } 分隔——旧锚点 (?:^|[;&|]\s*) 无法匹配 { 后的 Get-Content
    await expect(
      bash(
        String.raw`if (Test-Path -LiteralPath "$env:USERPROFILE\.ssh\id_rsa") { Get-Content -LiteralPath "$env:USERPROFILE\.ssh\id_rsa" } else { "id_rsa not found" }`,
        reviewer,
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #232：native auto 的每个 external_directory 边界都是 cautious review seam——纯路径只读
  // #232：工具（glob/grep 等）无需逐工具 metadata 即可进入 reviewer，避免退回可点击 ask
  test("routes native auto external directory requests to cautious reviewer", async () => {
    let safeCalled = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/Alice/Logs/*" : "/Users/alice/Logs With Spaces/*"],
            metadata: {
              agent: "auto",
              filepath: process.platform === "win32" ? "C:/Users/Alice/Logs/app.log" : "/Users/alice/Logs With Spaces/app.log",
            },
          },
          {
            review: (input) =>
              Effect.sync(() => {
                safeCalled = true
                // #232：path-only 只读工具到达 reviewer 时预审层级必须是 cautious
                expect(input.precheck.level).toBe("cautious")
                return {
                  action: "allow" as const,
                  reason: "reviewer approved bounded external directory access",
                  reviewID: "review_external_auto_path",
                  risk_level: "medium" as const,
                  user_authorization: "medium" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer" })
    expect(safeCalled).toBe(true)

    let called = false
    await expect(
      shellExternalDirectory(
        "git status --porcelain",
        {
          review: (input) =>
            Effect.sync(() => {
              called = true
              expect(input.precheck.level).toBe("cautious")
              return {
                action: "allow" as const,
                reason: `reviewer approved ${input.precheck.level} shell external directory access`,
                reviewID: "review_external_shell_safe",
                risk_level: "medium" as const,
                user_authorization: "medium" as const,
              }
            }),
        },
        { agent: "auto" },
      ),
    ).resolves.toMatchObject({ action: "allow", source: "reviewer" })
    expect(called).toBe(true)

    await expect(shellExternalDirectory("rm -rf /", undefined, { agent: "auto" })).resolves.toMatchObject({
      action: "deny",
      source: "precheck",
    })
  })

  // #210：tool-origin external_directory 携带 action_kind/tool/operation 证据，路由到 reviewer
  // #210：无来源证据或证据不全的 external_directory 仍走人工审批，不进入 reviewer
  test("routes tool-origin external directory auto decisions to reviewer", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
            metadata: {
              action_kind: "tool",
              tool: "read",
              operation: "read",
              filepath: process.platform === "win32" ? "C:/Users/Alice/.ssh/id_rsa" : "/home/alice/.ssh/id_rsa",
            },
          },
          {
            review: () =>
              Effect.sync(() => {
                called = true
                return {
                  action: "deny" as const,
                  reason: "reviewer rejected tool-origin external directory access",
                  reviewID: "review_tool_external_directory",
                  risk_level: "high" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #232：仅 filepath 无 tool 证据——仍进入 cautious reviewer 边界，reviewer 决定拒绝
  test("routes external directory requests without tool evidence to reviewer", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
            metadata: {
              filepath: process.platform === "win32" ? "C:/Users/Alice/.ssh/id_rsa" : "/home/alice/.ssh/id_rsa",
            },
          },
          {
            review: () =>
              Effect.sync(() => {
                called = true
                return {
                  action: "deny" as const,
                  reason: "reviewer rejected external directory access without tool evidence",
                  reviewID: "review_external_directory_without_evidence",
                  risk_level: "high" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #232：action_kind=tool 但缺 tool/operation——证据畸形仍进入 reviewer，由 reviewer 拒绝
  test("routes native auto malformed external directory evidence to reviewer", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
            metadata: {
              agent: "auto",
              action_kind: "tool",
              filepath: process.platform === "win32" ? "C:/Users/Alice/.ssh/id_rsa" : "/home/alice/.ssh/id_rsa",
            },
          },
          {
            review: (input) =>
              Effect.sync(() => {
                called = true
                expect(input.precheck.level).toBe("cautious")
                return {
                  action: "deny" as const,
                  reason: "reviewer rejected malformed external directory evidence",
                  reviewID: "review_native_auto_malformed_external_directory",
                  risk_level: "high" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #232：action_kind=tool 但缺 tool/operation——证据不全，仍回退人工审批
  // #232：断言翻转：畸形工具证据不再走可点击 ask，reviewer 拒绝才闭合请求
  test("routes malformed tool-origin external directory requests to reviewer", async () => {
    let called = false
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "external_directory",
            patterns: [process.platform === "win32" ? "C:/Users/*" : "/home/*"],
            metadata: {
              action_kind: "tool",
              filepath: process.platform === "win32" ? "C:/Users/Alice/.ssh/id_rsa" : "/home/alice/.ssh/id_rsa",
            },
          },
          {
            review: () =>
              Effect.sync(() => {
                called = true
                return {
                  action: "deny" as const,
                  reason: "reviewer rejected malformed tool external directory evidence",
                  reviewID: "review_malformed_tool_external_directory",
                  risk_level: "high" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

  // #232：general 是确定性 allow 边界——未知 shell 与普通 edit/add/update 不消耗 reviewer
  test("allows general decisions without reviewer load", async () => {
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

    // #232：普通 edit 的 diff 是结构化 metadata 但非删除——general 确定性 allow，
    // #232：与 shell general 同一条路径，reviewer 不被调用。
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate(
          {
            permission: "edit",
            patterns: ["src/a.ts"],
            metadata: { agent: "auto", filepath: "src/a.ts", diff: "-old\n+new" },
          },
          {
            review: () =>
              Effect.sync(() => {
                called = true
                return {
                  action: "deny" as const,
                  reason: "reviewer should not see general edit requests",
                  reviewID: "review_general_edit",
                  risk_level: "medium" as const,
                  user_authorization: "unknown" as const,
                }
              }),
          },
        ),
      ),
    ).resolves.toMatchObject({ action: "allow", source: "precheck" })
    expect(called).toBe(false)
  })

  // #198：验证无 reviewer 时回退到 ask——保持原有用户审批路径，source 标记为 reviewer_unavailable
  test("falls back to existing approval path when reviewer is not wired", async () => {
    await expect(bash("git add .")).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

  // #225：测试 metadata.agent 用小写 auto，与 agent key 对齐
  // #203：原生 auto reviewer 缺失时 fail closed——cautious 不降级为可点击 ask，防止点 Allow 暴露敏感 shell 输出
  test("fails closed for native auto when reviewer is not wired", async () => {
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate({
          permission: "bash",
          patterns: ["git add ."],
          metadata: { action_kind: "shell", command: "git add .", agent: "auto" },
        }),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
  })

  // #203：显式 user reviewer 配置强于原生 auto fail-closed——保留用户审批作为 review 边界
  test("honors explicit user reviewer configuration for native auto", async () => {
    await expect(
      Effect.runPromise(
        PermissionAuto.evaluate({
          permission: "bash",
          patterns: ["git add ."],
          metadata: { action_kind: "shell", command: "git add .", agent: "auto" },
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
