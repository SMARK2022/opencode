import { expect, test } from "bun:test"
import { YAML } from "bun"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"

test("工作流汇总拒绝缺失、跳过或失败的必需任务", async () => {
  const file = path.resolve(import.meta.dir, "../../../.github/workflows/guard.yml")
  const workflow = YAML.parse(await Bun.file(file).text()) as {
    jobs: { result: { steps: { run?: string }[] } }
  }
  const script = workflow.jobs.result.steps.find((step) => step.run)?.run
  expect(script).toBeDefined()
  const cases = [
    { MODE: "pr", RUNTIME: "false", RULES: "success", expected: 0 },
    { MODE: "pr", RUNTIME: "true", RULES: "success", BENCH: "success", expected: 0 },
    { MODE: "pr", RUNTIME: "true", RULES: "success", expected: 1 },
    { MODE: "pr", RUNTIME: "false", RULES: "success", BENCH: "failure", expected: 1 },
    { MODE: "pr", RUNTIME: "false", RULES: "success", BENCH: "cancelled", expected: 1 },
    { MODE: "pr", RUNTIME: "false", RULES: "skipped", expected: 1 },
    { MODE: "pr", RUNTIME: "false", RULES: "success", PLAN: "failure", expected: 1 },
    { MODE: "preflight", PREFLIGHT: "success", expected: 0 },
    { MODE: "preflight", PREFLIGHT: "skipped", expected: 1 },
    { MODE: "preflight", PREFLIGHT: "failure", expected: 1 },
    { MODE: "push", RUNTIME: "false", RULES: "success", expected: 0 },
    { MODE: "push", RUNTIME: "", RULES: "success", expected: 1 },
    { MODE: "", expected: 1 },
  ]
  for (const { expected, ...values } of cases) {
    const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script!], {
      env: {
        ...process.env,
        PLAN: "success",
        RULES: "skipped",
        BENCH: "skipped",
        PREFLIGHT: "skipped",
        RUNTIME: "false",
        ...values,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(expected)
  }
})

test("工作流审批读取全部页面，并按当前提交与各审核人最新有效意见放行", async () => {
  const file = path.resolve(import.meta.dir, "../../../.github/workflows/guard.yml")
  const workflow = YAML.parse(await Bun.file(file).text()) as {
    jobs: { rules: { steps: { name?: string; run?: string }[] } }
  }
  const script = workflow.jobs.rules.steps.find((step) => step.name === "规则检查")?.run
  expect(script).toBeDefined()
  const head = "1".repeat(40)
  const review = (id: number, state: string, changes: Record<string, unknown> = {}) => ({
    user: { id },
    state,
    commit_id: head,
    author_association: "OWNER",
    submitted_at: "2026-01-01T00:00:00Z",
    ...changes,
  })
  const cases = [
    { pages: [[]], approved: false },
    { pages: [[review(1, "APPROVED")]], approved: true },
    { pages: [[review(1, "COMMENTED")], [review(2, "APPROVED", { author_association: "MEMBER" })]], approved: true },
    {
      pages: [[review(1, "APPROVED")], [review(1, "CHANGES_REQUESTED", { submitted_at: "2026-01-02T00:00:00Z" })]],
      approved: false,
    },
    {
      pages: [[review(1, "DISMISSED", { submitted_at: "2026-01-02T00:00:00Z" })], [review(1, "APPROVED")]],
      approved: false,
    },
    {
      pages: [[review(1, "APPROVED"), review(1, "COMMENTED", { submitted_at: "2026-01-02T00:00:00Z" })]],
      approved: true,
    },
    { pages: [[review(1, "APPROVED", { commit_id: "2".repeat(40) })]], approved: false },
    {
      pages: [
        [
          review(1, "APPROVED"),
          review(1, "APPROVED", { submitted_at: "2026-01-02T00:00:00Z", commit_id: "2".repeat(40) }),
        ],
      ],
      approved: false,
    },
    { pages: [[review(1, "APPROVED", { author_association: "CONTRIBUTOR" })]], approved: false },
    { pages: [[review(1, "APPROVED")]], approved: false, status: 9 },
    { raw: "invalid JSON", approved: false, status: 0 },
  ]
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-workflow-"))
  try {
    await Bun.write(
      path.join(dir, "check.ts"),
      `
      const file = Bun.file(process.env.CHECK_ARGS!)
      const previous = await file.exists() ? await file.text() : ""
      await Bun.write(file, previous + JSON.stringify(process.argv.slice(2)) + "\\n")
    `,
    )
    for (const [index, entry] of cases.entries()) {
      const pages = path.join(dir, `pages-${index}.json`)
      const calls = Bun.file(path.join(dir, `calls-${index}.jsonl`))
      await Bun.write(pages, entry.raw ?? JSON.stringify(entry.pages))
      const result = Bun.spawnSync(
        [
          "bash",
          "--noprofile",
          "--norc",
          "-e",
          "-c",
          `
        gh() {
          local slurp=0 filter=0
          for arg in "$@"; do
            case "$arg" in
              --slurp) slurp=1 ;;
              --jq|--template) filter=1 ;;
            esac
          done
          if [ "$slurp" -eq 1 ] && [ "$filter" -eq 1 ]; then
            echo 'the --slurp option is not supported with --jq or --template' >&2
            return 2
          fi
          if [ "$API_STATUS" -ne 0 ]; then
            echo 'reviews unavailable' >&2
            return "$API_STATUS"
          fi
          cat "$REVIEW_PAGES"
        }
        ${script}
      `,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
            MODE: "pr",
            BASE: "HEAD",
            DIR: dir,
            PR: "9",
            PR_HEAD: head,
            GITHUB_REPOSITORY: "example/repo",
            GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
            RUNNER_TEMP: dir,
            CHECK_ARGS: calls.name,
            REVIEW_PAGES: pages,
            API_STATUS: String(entry.status ?? 0),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      if (entry.status || entry.raw) {
        expect(result.exitCode).toBeGreaterThan(0)
        expect(await calls.exists()).toBe(false)
        continue
      }
      expect({ index, code: result.exitCode, err: result.stderr.toString() }).toEqual({ index, code: 0, err: "" })
      const checks: string[][] = (await calls.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(checks).toHaveLength(2)
      for (const args of checks) {
        expect(args.includes("--no-trailer")).toBe(true)
        expect(args.includes("--allow-large")).toBe(entry.approved)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
