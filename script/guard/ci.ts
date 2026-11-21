#!/usr/bin/env bun
// CI 的小工具，只给 .github/workflows/guard*.yml 用。
//
//   bun script/guard/ci.ts plan --base <ref> [--head <ref>] [--platforms macos,linux]
//       把改动分类写进 $GITHUB_OUTPUT：runtime / protected（true|false）、files（改动文件数）
//       以及需要执行的 tests / bench 和 preflight 平台矩阵 matrix（JSON）。
//   bun script/guard/ci.ts commits <"sha sha …" | A..B> [--max 20]
//       把用户输入展开成 JSON 数组（完整 SHA，旧→新），写进 $GITHUB_OUTPUT 的 list
//   bun script/guard/ci.ts nightly-base <site/data/index.json>
//       nightly 的对比基准：看板里最近一次测过、且是 HEAD 祖先的提交；HEAD 已测过时 skip=true
import { appendFileSync } from "node:fs"
import { PROTECTED_GLOBS, PROTECTED_PATHS } from "./rules"
import { guardPlan } from "./affected-rules"
import { gh, preflightRuns, preflightState } from "./preflight"
import { isCompleteBench } from "./report"

// 不依赖 ./lib（它会加载 typescript）：plan 任务只装 bun，不装工作区依赖
const flag = (a: string[], name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined)
const posix = (p: string) => p.replaceAll("\\", "/")
function git(cwd: string, ...a: string[]) {
  const p = Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" })
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const repo = process.cwd()
const [cmd, ...args] = process.argv.slice(2)

function output(pairs: Record<string, string>) {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`)
  for (const l of lines) console.log(l)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n")
}

function must(r: { ok: boolean; out: string; err: string }, what: string) {
  if (!r.ok) {
    console.error(`${what} 失败：${r.err}`)
    process.exit(2)
  }
  return r.out
}

const RUNNERS: Record<string, string> = { linux: "ubuntu-latest", macos: "macos-latest", windows: "windows-latest" }
if (cmd === "plan") {
  const base = flag(args, "--base")
  if (!base) throw new Error("plan 需要 --base")
  const head = flag(args, "--head") ?? "HEAD"
  const from = must(git(repo, "rev-parse", "--verify", `${base}^{commit}`), "解析比较基准")
  const to = must(git(repo, "rev-parse", "--verify", `${head}^{commit}`), "解析待检提交")
  const files = must(git(repo, "diff", "--name-only", "-z", "--no-renames", from, to), "git diff")
    .split("\0")
    .map(posix)
    .filter(Boolean)
  const protectedHit = files.filter(
    (f) => PROTECTED_PATHS.some((p) => f === p || f.startsWith(p)) || PROTECTED_GLOBS.some((re) => re.test(f)),
  )
  if (protectedHit.length) console.log(`受保护路径改动：\n  ${protectedHit.join("\n  ")}`)
  const plan = guardPlan(files, repo, flag(args, "--platforms"))
  const reusable =
    process.env.GH_TOKEN &&
    process.env.MODE !== "preflight" &&
    process.env.POLICY === from &&
    !protectedHit.length &&
    !files.some((f) => f.startsWith(".github/")) &&
    preflightState(preflightRuns(gh, process.env.GITHUB_REPOSITORY!, to), plan.platforms, from, plan.bench).kind ===
      "green"
  output({
    files: String(files.length),
    runtime: String(plan.bench),
    tests: String(!reusable),
    bench: String(plan.bench && !reusable),
    protected: String(protectedHit.length > 0),
    matrix: JSON.stringify({ include: plan.platforms.map((os) => ({ os, runner: RUNNERS[os] })) }),
  })
} else if (cmd === "commits") {
  const input = (args[0] ?? "").trim()
  const max = Number(flag(args, "--max") ?? 20)
  if (!Number.isSafeInteger(max) || max < 1) {
    console.error("--max 必须是正整数")
    process.exit(2)
  }
  const refs = input.includes("..")
    ? must(git(repo, "rev-list", "--reverse", "--first-parent", input), "git rev-list")
        .split("\n")
        .filter(Boolean)
    : input.split(/[\s,]+/).filter(Boolean)
  const shas = refs.map((r) => must(git(repo, "rev-parse", "--verify", `${r}^{commit}`), `解析 ${r}`))
  if (!shas.length) {
    console.error("没有可测的提交")
    process.exit(2)
  }
  if (shas.length > max) {
    console.error(`一次最多 ${max} 个提交（收到 ${shas.length} 个）。请缩小范围，或分批运行。`)
    process.exit(2)
  }
  const time = (sha: string) => Number(git(repo, "show", "-s", "--format=%ct", sha).out)
  output({ list: JSON.stringify([...new Set(shas)].sort((a, b) => time(a) - time(b))) })
} else if (cmd === "nightly-base") {
  const head = must(git(repo, "rev-parse", "HEAD"), "rev-parse")
  const file = Bun.file(args[0] ?? "site/data/index.json")
  const data: { commits: Record<string, { sha: string; date: string; bench?: unknown[] }> } = (await file.exists())
    ? await file.json()
    : { commits: {} }
  if (data.commits[head]?.bench?.some(isCompleteBench)) {
    output({ skip: "true", base: "" })
    process.exit(0)
  }
  const prev = Object.values(data.commits)
    .filter((c) => c.bench?.some(isCompleteBench) && git(repo, "merge-base", "--is-ancestor", c.sha, head).ok)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  // 第一次运行没有历史：和第一父提交比
  output({ skip: "false", base: prev?.sha ?? must(git(repo, "rev-parse", "HEAD~1"), "rev-parse HEAD~1") })
} else {
  console.error("用法：ci.ts plan | commits | nightly-base")
  process.exit(2)
}
