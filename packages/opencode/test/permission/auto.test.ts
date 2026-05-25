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
        metadata: {
          action_kind: "shell",
          command,
          cwd: process.cwd(),
          shell: process.platform === "win32" ? "powershell" : "bash",
          ...metadata,
        },
      },
      reviewer,
    ),
  )

describe("permission auto routing", () => {
  test("allows safe commands after precheck without reviewer load", async () => {
    await expect(bash("git status --porcelain")).resolves.toMatchObject({ action: "allow", source: "precheck" })
  })

  test("denies dangerous commands before reviewer routing", async () => {
    await expect(bash("rm -rf /")).resolves.toMatchObject({ action: "deny", source: "precheck" })
  })

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

  test("routes bounded file deletion to reviewer instead of shell general allow", async () => {
    let called = false
    await expect(
      bash(String.raw`Remove-Item -LiteralPath "H:\DumpStack.log.tmp" -Force -ErrorAction SilentlyContinue`, {
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
    expect(starts[0].precheck).toMatchObject({ level: "cautious" })
  })

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
            Effect.sync(() => {
              started = input.reviewID
            }),
        ),
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer", reviewID: started })
  })

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
    await expect(
      bash(
        String.raw`if (Test-Path -LiteralPath "$env:USERPROFILE\.ssh\id_rsa") { Get-Content -LiteralPath "$env:USERPROFILE\.ssh\id_rsa" } else { "id_rsa not found" }`,
        reviewer,
      ),
    ).resolves.toMatchObject({ action: "deny", source: "reviewer" })
    expect(called).toBe(true)
  })

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
                // Native auto treats every external-directory boundary as the
                // cautious review seam. Path-only read tools such as glob/grep do
                // not need per-tool metadata just to avoid a clickable user ask.
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

  test("falls back to existing approval path when reviewer is not wired", async () => {
    await expect(bash("git add .")).resolves.toMatchObject({ action: "ask", source: "reviewer_unavailable" })
  })

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
