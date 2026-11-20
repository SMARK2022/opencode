#!/usr/bin/env bun
// preflight 按实际执行的测试平台判定；每次查询远端最新结果，避免复用已重跑或覆盖不全的成功记录。
import { git, flag, originRepo } from "./lib"
import { MAIN_BRANCH } from "./rules"

export type PreflightRun = {
  databaseId: number
  status: string
  conclusion: string | null
  event: string
  displayTitle: string
  url: string
  createdAt: string
  updatedAt?: string
  attempt?: number
  jobs: {
    name: string
    status: string
    conclusion: string | null
    steps?: { name: string; conclusion: string | null }[]
  }[]
}

// 门禁本身那一步之外的失败（checkout、安装依赖、下载工具等）视为线上环境问题，自动重跑一次
export const GATE_STEP = "规则 + 选中测试 + 契约"
export function environmentFailure(run: PreflightRun) {
  const failed = run.jobs
    .filter((job) => job.conclusion === "failure")
    .flatMap((job) => (job.steps ?? []).filter((step) => step.conclusion === "failure"))
  return (run.attempt ?? 1) < 2 && failed.length > 0 && failed.every((step) => !step.name.startsWith(GATE_STEP))
    ? failed[0].name
    : undefined
}

export function preflightPlatforms(value: string) {
  const names = [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((name) => name.toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (!names.length || names.some((name) => !["linux", "macos", "windows"].includes(name)))
    throw new Error(`未知平台：${value || "（空）"}。可选 linux, macos, windows`)
  return names
}

export function preflightState(runs: PreflightRun[], platforms: string[], base: string) {
  const ordered = runs
    .filter(
      (run) =>
        run.event === "workflow_dispatch" &&
        run.displayTitle.startsWith(`preflight base=${base} · `) &&
        platforms.every((platform) => run.displayTitle.split(" · ").at(-1)?.split(",").includes(platform)),
    )
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
  for (const run of ordered) {
    const jobs = platforms.map((platform) => run.jobs.find((job) => job.name === `preflight / ${platform} / ${base}`))
    if (run.status !== "completed") return { kind: "running" as const, run }
    if (
      run.conclusion === "success" &&
      jobs.every((job) => job?.status === "completed" && job.conclusion === "success")
    )
      return { kind: "green" as const, run }
    return { kind: "failed" as const, run }
  }
  return { kind: "none" as const }
}

export function preflightRuns(
  gh: (...params: string[]) => { ok: boolean; out: string; err: string },
  slug: string,
  sha: string,
) {
  const result = gh(
    "run",
    "list",
    "-R",
    slug,
    "--workflow",
    "guard.yml",
    "--commit",
    sha,
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,event,displayTitle,url,createdAt,updatedAt,attempt",
  )
  if (!result.ok) throw new Error(`查询 preflight 运行失败：${result.err}`)
  const runs: Omit<PreflightRun, "jobs">[] = JSON.parse(result.out)
  return runs
    .filter((run) => run.event === "workflow_dispatch")
    .map((run) => {
      const result = gh("run", "view", "-R", slug, String(run.databaseId), "--json", "jobs")
      if (!result.ok) throw new Error(`查询 preflight 平台结果失败：${result.err}`)
      const data: { jobs: PreflightRun["jobs"] } = JSON.parse(result.out)
      if (!Array.isArray(data.jobs)) throw new Error(`preflight ${run.databaseId} 缺少平台结果`)
      return { ...run, jobs: data.jobs }
    })
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? "ensure"
  if (!["ensure", "start", "status", "wait"].includes(cmd)) throw new Error(`未知命令：${cmd}`)
  const root = git(process.cwd(), "rev-parse", "--show-toplevel")
  if (!root.ok) throw new Error(root.err)
  const repo = root.out
  const revision = git(repo, "rev-parse", "--verify", `${flag(args, "--sha") ?? "HEAD"}^{commit}`)
  if (!revision.ok) throw new Error(`无法解析待检提交：${revision.err}`)
  const sha = revision.out
  const comparison = git(repo, "rev-parse", "--verify", `${flag(args, "--base") ?? `origin/${MAIN_BRANCH}`}^{commit}`)
  if (!comparison.ok) throw new Error(`无法解析比较基准：${comparison.err}`)
  const base = comparison.out
  const branch = `preflight/${sha.slice(0, 12)}`
  const platforms = preflightPlatforms(
    flag(args, "--platforms") ?? process.env.GUARD_PREFLIGHT_PLATFORMS ?? "macos,linux",
  )
  const slug = originRepo(repo)
  if (!slug) throw new Error("origin 必须指向待验证的 GitHub 仓库")
  const gh = (...params: string[]) => {
    const proc = Bun.spawnSync(["gh", ...params], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() }
  }
  if (!Bun.which("gh") || !gh("auth", "status").ok) {
    console.log("gh 未安装或未登录，无法运行 preflight。")
    return 3
  }

  const state = () => preflightState(preflightRuns(gh, slug, sha), platforms, base)

  const start = () => {
    const push = git(repo, "push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`)
    if (!push.ok) throw new Error(`推送 ${branch} 失败：${push.err}`)
    const result = gh(
      "workflow",
      "run",
      "-R",
      slug,
      "guard.yml",
      "--ref",
      branch,
      "-f",
      "mode=preflight",
      "-f",
      `platforms=${platforms.join(",")}`,
      "-f",
      `base=${base}`,
    )
    if (!result.ok) git(repo, "push", "--no-verify", "origin", "--delete", branch)
    if (!result.ok) throw new Error(`触发 guard.yml 失败：${result.err}`)
    console.log(`已启动：分支 ${branch} · 比较基准 ${base.slice(0, 12)} · 平台 ${platforms.join(",")}`)
  }

  const report = (result: ReturnType<typeof state>) => {
    if (result.kind === "none") {
      console.log(`尚无覆盖基准 ${base.slice(0, 12)}、平台 ${platforms.join(",")} 的 preflight 结果`)
      return 10
    }
    if (result.kind === "green") {
      console.log(`已通过（${platforms.join(",")}）：${result.run.url}`)
      return 0
    }
    if (result.kind === "running") {
      console.log(`运行中：${result.run.url}`)
      return 10
    }
    const environment = environmentFailure(result.run)
    if (environment && gh("run", "rerun", "-R", slug, String(result.run.databaseId), "--failed").ok) {
      console.log(`线上环境问题（失败在「${environment}」），已自动重跑一次：${result.run.url}`)
      return 10
    }
    console.log(
      `失败：${result.run.url}\n${gh("run", "view", "-R", slug, String(result.run.databaseId), "--log-failed").out.slice(-12000)}`,
    )
    console.log("修复后提交新版本；重跑当前提交可执行 preflight.ts start")
    return 1
  }

  if (cmd === "start") {
    start()
    return 10
  }
  if (cmd === "status") return report(state())
  if (cmd === "wait") {
    for (;;) {
      const result = state()
      if (result.kind !== "running") return report(result)
      console.log("等待中…")
      await Bun.sleep(20_000)
    }
  }
  const result = state()
  if (result.kind !== "none") return report(result)
  start()
  console.log(
    `查看进度：bun script/guard/preflight.ts status --sha ${sha} --base ${base} --platforms ${platforms.join(",")}`,
  )
  return 10
}

if (import.meta.main) {
  try {
    process.exit(await main())
  } catch (error) {
    console.error(`[preflight] ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}
