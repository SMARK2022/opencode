import { expect, test } from "bun:test"
import { YAML } from "bun"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"

test("工作流汇总拒绝缺失、跳过或失败的必需任务", async () => {
  const file = path.resolve(import.meta.dir, "../../../.github/workflows/guard.yml")
  const workflow = YAML.parse(await Bun.file(file).text()) as {
    on: { pull_request: { types: string[] } }
    jobs: { result: { steps: { run?: string }[] } }
  }
  const events = [
    { action: "synchronize", head: "A" },
    { action: "labeled", head: "A" },
    { action: "unlabeled", head: "A" },
    { action: "synchronize", head: "B" },
  ]
  expect(events.filter(({ action }) => workflow.on.pull_request.types.includes(action)).map(({ head }) => head)).toEqual([
    "A", "B",
  ])
  const script = workflow.jobs.result.steps.find((step) => step.run)?.run
  expect(script).toBeDefined()
  const cases = [
    { WANT_TESTS: "true", WANT_BENCH: "true", BENCH: "success", expected: 0 },
    { WANT_TESTS: "true", WANT_BENCH: "true", BENCH: "skipped", expected: 1 },
    { WANT_TESTS: "true", WANT_BENCH: "true", BENCH: "failure", expected: 1 },
    { WANT_TESTS: "true", WANT_BENCH: "false", expected: 0 },
    { WANT_TESTS: "true", WANT_BENCH: "false", PREFLIGHT: "cancelled", expected: 1 },
    { WANT_TESTS: "true", WANT_BENCH: "false", RULES: "skipped", expected: 1 },
    { WANT_TESTS: "false", WANT_BENCH: "false", PREFLIGHT: "skipped", expected: 0 },
    { WANT_TESTS: "false", WANT_BENCH: "false", PREFLIGHT: "skipped", PLAN: "failure", expected: 1 },
    { WANT_TESTS: "", WANT_BENCH: "true", expected: 1 },
  ]
  for (const { expected, ...values } of cases) {
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script!], {
      env: {
        ...process.env,
        PLAN: "success",
        RULES: "success",
        BENCH: "skipped",
        PREFLIGHT: "success",
        ...values,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(expected)
  }
})

test("规则检查只在仓主明确授权当前提交时放行改动规模", async () => {
  const file = path.resolve(import.meta.dir, "../../../.github/workflows/guard.yml")
  const workflow = YAML.parse(await Bun.file(file).text()) as {
    jobs: { rules: { steps: { name?: string; run?: string }[] } }
  }
  const script = workflow.jobs.rules.steps.find((step) => step.name === "规则检查")?.run
  if (!script) throw new Error("缺少规则检查步骤")
  const head = "1".repeat(40)
  const repo = { id: 10, private: false, owner: { id: 40, type: "User" } }
  const event = {
    action: "synchronize",
    repository: repo,
    sender: { id: 40 },
    pull_request: { user: { id: 40 }, head: { sha: head, repo } },
  }
  const other = { ...event, sender: { id: 41 } }
  const grant = { body: `Guard-Allow-Large: ${head}`, author: { databaseId: 40 }, editor: null, lastEditedAt: null }
  const page = (nodes: object[]) => ({ data: { repository: { pullRequest: { comments: { nodes } } } } })
  const cases = [
    { input: event, expected: "trailer" },
    { input: other, expected: "default" },
    { input: event, checkout: "2".repeat(40), expected: "default" },
    { input: other, pages: [page([]), page([grant])], expected: "grant" },
    { input: other, pages: [page([{ ...grant, lastEditedAt: "2026-01-01" }])], expected: "default" },
    { input: other, pages: [page([{ ...grant, editor: { __typename: "User" } }])], expected: "default" },
    { input: other, pages: [page([{ ...grant, editor: undefined }])], expected: "default" },
    { input: other, pages: [page([{ ...grant, author: { databaseId: 41 } }])], expected: "default" },
    { input: other, pages: [page([{ ...grant, body: "Guard-Allow-Large: " + "2".repeat(40) }])], expected: "default" },
    { input: other, pages: [page([{ ...grant, body: "提及 " + grant.body }])], expected: "default" },
    { input: other, pages: [{ errors: [{ message: "Forbidden" }] }], expected: "failure" },
    { input: other, apiStatus: 9, expected: "failure" },
  ]
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-workflow-"))
  try {
    await Bun.write(path.join(dir, "check.ts"), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const input = path.join(dir, "event.json")
    const comments = path.join(dir, "comments.json")
    for (const entry of cases) {
      await Bun.write(input, JSON.stringify(entry.input))
      await Bun.write(comments, JSON.stringify(entry.pages ?? [page([])]))
      const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", `
        git() { printf '%s\n' "$CHECKOUT_HEAD"; }
        gh() {
          if [ "$2" != graphql ]; then printf '[[]]'; return; fi
          if [ "$API_STATUS" -ne 0 ]; then return "$API_STATUS"; fi
          cat "$COMMENT_PAGES"
        }
        ${script}
      `], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
          MODE: "pr",
          BASE: "base",
          DIR: dir,
          PR: "9",
          PR_HEAD: head,
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_EVENT_PATH: input,
          GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
          RUNNER_TEMP: dir,
          CHECKOUT_HEAD: entry.checkout ?? head,
          COMMENT_PAGES: comments,
          API_STATUS: String(entry.apiStatus ?? 0),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (entry.expected === "failure") {
        expect(result.exitCode).toBeGreaterThan(0)
        expect(result.stdout.toString()).toBe("")
        continue
      }
      expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: "" })
      const checks: string[][] = result.stdout.toString().trim().split("\n").map((line) => JSON.parse(line))
      expect(checks).toHaveLength(2)
      for (const args of checks) {
        const decision = args.includes("--allow-large") ? "grant" : args.includes("--no-trailer") ? "default" : "trailer"
        expect(decision).toBe(entry.expected)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
