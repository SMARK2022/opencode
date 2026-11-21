#!/usr/bin/env bun
// 结果页：CI summary 与 PR 置顶评论的 Markdown，以及看板数据（data/index.json）的合并。
//
//   bun script/guard/report.ts comment --guard guard.json [--bench bench.json] --out comment.md
//   bun script/guard/report.ts publish --site <bench-data 检出目录> [--bench a.json b.json …] [--guard guard.json --sha <sha>]
import path from "node:path"
import { METRICS, type Verdict } from "./bench/harness"
import { SCENARIO_BUDGETS } from "./bench/budgets"
import type { CheckResult } from "./check"
import { BOUNDARY_RULES, SHAPE_RULES, OTHER_RULES, RATCHETS } from "./rules"

// 不依赖 ./lib（它会加载 typescript）：评论与看板任务只装 bun，不装工作区依赖
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

// 复杂度类规则记录的是超额量，不是"处数"，不计入存量总数
export const SIZE_RULES = new Set(["cc-excess", "depth-excess"])
// 改动规模类规则：位置就是 key（提交或文件），不带行号
const SIZE_KEYS = new Set(["change-size", "file-lines", "tiny-module"])
const ruleInfo = (rule: string) =>
  BOUNDARY_RULES[rule] ??
  SHAPE_RULES[rule] ??
  OTHER_RULES[rule] ??
  RATCHETS.find((r) => r.id === rule) ?? { level: "error", fix: "" }

// ── 规则检查报告 ──
export function renderMarkdown(r: CheckResult) {
  const errors = r.violations.filter((v) => v.level === "error")
  const warns = r.violations.filter((v) => v.level === "warn")
  const out: string[] = []
  out.push(`## ${errors.length ? "🔴" : "🟢"} Guard 规则检查`)
  out.push(
    `\n\`${r.mode}\` · ${r.files} 个文件 · **${errors.length}** 个错误 · ${warns.length} 个提示${r.baselineFound ? "" : " · ⚠️ 未找到基线"}`,
  )
  for (const n of r.notes) out.push(`\n> ${n}`)
  if (r.violations.length) {
    out.push(`\n| 级别 | 规则 | 位置 | 计数 / 允许 |\n|---|---|---|---|`)
    for (const v of [...errors, ...warns].slice(0, 60))
      out.push(
        `| ${v.level === "error" ? "错误" : "提示"} | \`${v.rule}\` | \`${(SIZE_KEYS.has(v.rule) ? v.key : `${v.key}:${v.lines[0]}`).replaceAll("|", "\\|")}\` | ${v.count} / ${v.allowed} |`,
      )
    if (r.violations.length > 60) out.push(`\n…另有 ${r.violations.length - 60} 条，见 artifact 中的 guard.json。`)
    out.push(`\n<details><summary>修复方向</summary>\n`)
    for (const rule of new Set(r.violations.map((v) => v.rule))) out.push(`- \`${rule}\`：${ruleInfo(rule).fix}`)
    out.push(`\n</details>`)
  }
  const debt = Object.entries(r.totals)
    .filter(([, t]) => t.current || t.baseline)
    .sort(([a], [b]) => a.localeCompare(b))
  if (debt.length) {
    out.push(
      `\n<details><summary>存量规则计数（当前 / 基线）</summary>\n\n| 规则 | 当前 | 基线 | 变化 |\n|---|--:|--:|--:|`,
    )
    for (const [rule, t] of debt) {
      const d = t.current - t.baseline
      out.push(`| \`${rule}\` | ${t.current} | ${t.baseline} | ${d === 0 ? "—" : d > 0 ? `+${d}` : d} |`)
    }
    out.push(`\n</details>`)
  }
  return out.join("\n") + "\n"
}

export type Commit = { sha: string; date: string; subject: string }
export type BenchResult = {
  kind: "bench"
  head: Commit
  base: Commit
  rounds: number
  createdAt: string
  runner: { os: string; cpus: number; ci: boolean }
  runUrl?: string
  unavailable?: Record<string, string>
  scenarios: Record<
    string,
    { pairs?: number; verdict: Verdict[]; headMedians: Record<string, number>; baseMedians: Record<string, number>; errors: string[] }
  >
  regressed: boolean
  error?: string
  note?: string
}

export const METRIC_LABEL: Record<string, [string, string]> = {
  startupMs: ["启动到就绪", "ms"],
  wallMs: ["场景耗时", "ms"],
  cpuMs: ["CPU 时间", "ms"],
  maxBlockMs: ["最长阻塞", "ms"],
  p50Ms: ["探针 p50", "ms"],
  p95Ms: ["探针 p95", "ms"],
  p99Ms: ["探针 p99", "ms"],
  probeErrorRate: ["探针失败率", "%"],
  maxOutageMs: ["最长掉线", "ms"],
  peakRssMb: ["峰值内存", "MB"],
  rssGrowthMb: ["内存增量", "MB"],
  crashed: ["崩溃次数", ""],
  prepMs: ["发送准备", "ms"],
  finishMs: ["回复收尾", "ms"],
  editTurnMs: ["编辑回合", "ms"],
  compactMs: ["压缩", "ms"],
  revertMs: ["撤回", "ms"],
  unrevertMs: ["恢复撤回", "ms"],
  tuiFirstPaintMs: ["TUI 首屏", "ms"],
  tuiFullMs: ["长会话就绪", "ms"],
  tuiInputMs: ["流中输入延迟", "ms"],
  scrollFrameP95Ms: ["翻页帧 p95", "ms"],
  scrollFrameMaxMs: ["翻页最长帧", "ms"],
  streamFrameP95Ms: ["流式帧 p95", "ms"],
  streamFrameMaxMs: ["流式最长帧", "ms"],
}
const fmt = (metric: string, v: number) =>
  metric === "probeErrorRate" ? `${(v * 100).toFixed(1)}%` : Number.isInteger(v) ? String(v) : v.toFixed(1)
const short = (sha: string) => sha.slice(0, 8)

function benchError(r: BenchResult) {
  if (r.error !== undefined) return r.error || "基准运行失败"
  if (!Object.keys(r.scenarios).length) return "没有完成任何基准场景"
  for (const [name, scenario] of Object.entries(r.scenarios)) {
    if (
      !scenario.verdict.length ||
      scenario.verdict.some((v) => !Number.isFinite(v.base) || !Number.isFinite(v.head) || !Number.isFinite(v.p))
    )
      return `${name} 缺少有效的比较指标`
    if (scenario.errors.length && !scenario.verdict.some((v) => v.metric === "crashed" && v.regressed))
      return `${name} 未完成：${scenario.errors.join("；")}`
  }
}

export function renderBenchMarkdown(r: BenchResult, status?: string) {
  const out: string[] = []
  const error = benchError(r) ?? (status && status !== "success" ? `基准任务状态：${status}` : undefined)
  const regressed = r.regressed || Object.values(r.scenarios).some((s) => s.verdict.some((v) => v.regressed))
  const icon = error ? "⚪" : regressed ? "🔴" : "🟢"
  out.push(`## ${icon} 性能基准 \`${short(r.head.sha)}\` 对比 \`${short(r.base.sha)}\``)
  out.push(
    `\n${r.head.subject} · ${r.rounds} 轮交替 · ${r.runner.os} · ${r.runner.cpus} 核${r.runUrl ? ` · [运行记录](${r.runUrl})` : ""}`,
  )
  if (error) out.push(`\n> 基准未完成：${error}`)
  if (r.note) out.push(`\n> ${r.note}`)
  for (const [name, reason] of Object.entries(r.unavailable ?? {})) out.push(`
> ${name}：无基准（${reason}）`)
  const names = Object.keys(r.scenarios)
  if (names.length) {
    const key = ["wallMs", "cpuMs", "maxBlockMs", "probeErrorRate", "peakRssMb"]
    out.push(
      `\n| 场景 | ${key.map((m) => METRIC_LABEL[m][0]).join(" | ")} | 结论 |\n|---|${key.map(() => "--:").join("|")}|---|`,
    )
    for (const n of names) {
      const s = r.scenarios[n]
      const cell = (m: string) => {
        const v = s.verdict.find((x) => x.metric === m)
        if (!v) return "—"
        const ratio = v.ratio === null ? "" : ` (${v.ratio}×)`
        return `${v.regressed ? "**" : ""}${fmt(m, v.head)}${ratio}${v.regressed ? "**" : ""}`
      }
      const bad = s.verdict.filter((v) => v.regressed).map((v) => METRIC_LABEL[v.metric]?.[0] ?? v.metric)
      out.push(
        `| \`${n}\` | ${key.map(cell).join(" | ")} | ${bad.length ? `🔴 ${bad.join("、")}` : s.errors.length ? "⚪ 未完成" : "🟢"} |`,
      )
    }
    out.push(`\n<details><summary>全部指标（中位数，base → head，单侧检验 p 值）</summary>\n`)
    for (const n of names) {
      out.push(`\n**${n}**（${r.scenarios[n].pairs ?? r.rounds} 对样本）\n\n| 指标 | base | head | 比例 | p | |\n|---|--:|--:|--:|--:|---|`)
      for (const v of r.scenarios[n].verdict) {
        const [label, unit] = METRIC_LABEL[v.metric] ?? [v.metric, ""]
        out.push(
          `| ${label}${unit && unit !== "%" ? ` (${unit})` : ""} | ${fmt(v.metric, v.base)} | ${fmt(v.metric, v.head)} | ${v.ratio ?? "—"} | ${v.p} | ${v.regressed ? "🔴" : ""} |`,
        )
      }
      for (const [key, value] of Object.entries(r.scenarios[n].headMedians)) {
        if (r.scenarios[n].verdict.some((v) => v.metric === key)) continue
        out.push(`| ${METRIC_LABEL[key]?.[0] ?? key} | ${fmt(key, r.scenarios[n].baseMedians[key])} | ${fmt(key, value)} | — | — | 仅展示 |`)
      }
      if (r.scenarios[n].errors.length) out.push(`\n错误：${r.scenarios[n].errors.map((e) => `\`${e}\``).join("；")}`)
    }
    out.push(
      `\n判定：中位数变差超过预算比例、超过绝对噪声下限，且 p < 0.05；head 任意一次崩溃直接判退化。\n\n</details>`,
    )
  }
  return out.join("\n") + "\n"
}

// PR 置顶评论：带标记，workflow 用它找到并更新同一条评论
export const COMMENT_MARKER = "<!-- opencode-guard-report -->"

async function comment() {
  const parts = [COMMENT_MARKER]
  const guard = flag(process.argv, "--guard")
  if (guard && (await Bun.file(guard).exists())) parts.push(renderMarkdown(await Bun.file(guard).json()))
  else if (guard)
    parts.push(
      "## 🔴 Guard 规则检查\n\n没有产出结果（检查在开始前就失败了），请看本次运行日志。\n",
    )
  const bench = flag(process.argv, "--bench")
  const status = flag(process.argv, "--bench-status")
  if (bench && (await Bun.file(bench).exists())) parts.push(renderBenchMarkdown(await Bun.file(bench).json(), status))
  else if (status === "skipped" || (!status && bench === "none"))
    parts.push("## 性能基准\n\n本次未运行：未触发性能基准，或已有相同输入的成功结果。\n")
  else if (bench || status)
    parts.push(`## 🔴 性能基准\n\n基准结果缺失${status ? `（任务状态：${status}）` : ""}，请查看本次运行日志。\n`)
  await Bun.write(flag(process.argv, "--out") ?? "guard-comment.md", parts.join("\n"))
}

// ── 看板数据 ──
type SiteBench = {
  base: string
  createdAt: string
  runUrl?: string
  runner: BenchResult["runner"]
  regressed: boolean
  error?: string
  unavailable?: Record<string, string>
  scenarios: Record<string, { head: Record<string, number>; base: Record<string, number>; regressed: string[] }>
}
type SiteCommit = Commit & {
  bench: SiteBench[]
  debt?: Record<string, number>
  debtTotal?: number
  guardErrors?: number
}
type Site = { updatedAt: string; repository?: string; commits: Record<string, SiteCommit> }

export function isCompleteBench(value: unknown) {
  if (!value || typeof value !== "object" || ("error" in value && value.error !== undefined)) return false
  if (!("scenarios" in value) || !value.scenarios || typeof value.scenarios !== "object") return false
  const entries = value.scenarios
  const required = Object.keys(SCENARIO_BUDGETS)
  if (!required.some((name) => Object.hasOwn(entries, name))) return false
  const missing = "unavailable" in value ? value.unavailable : undefined
  const metrics = (entry: unknown, name: string) =>
    entry &&
    typeof entry === "object" &&
    [...METRICS, ...SCENARIO_BUDGETS[name].map((b) => b.metric)].every((key) => {
      const metric: unknown = Reflect.get(entry, key)
      return (
        typeof metric === "number" &&
        Number.isFinite(metric) &&
        (key === "rssGrowthMb" || metric >= 0) &&
        (key !== "probeErrorRate" || metric <= 1) &&
        (key !== "crashed" || metric === 0)
      )
    })
  return (
    required.every((name) => {
      const reason: unknown = missing && typeof missing === "object" && Object.hasOwn(missing, name)
        ? Reflect.get(missing, name) : undefined
      if (!Object.hasOwn(entries, name)) return typeof reason === "string" && reason.trim().length > 0
      if (reason !== undefined) return false
      const scenario: unknown = Reflect.get(entries, name)
      if (
        !scenario ||
        typeof scenario !== "object" ||
        !("head" in scenario) ||
        !("base" in scenario) ||
        !("regressed" in scenario)
      )
        return false
      return (
        metrics(scenario.head, name) &&
        metrics(scenario.base, name) &&
        Array.isArray(scenario.regressed) &&
        !scenario.regressed.includes("crashed")
      )
    })
  )
}

async function publish() {
  const site = flag(process.argv, "--site")
  if (!site) throw new Error("缺少 --site")
  const file = path.join(site, "data", "index.json")
  const data: Site = (await Bun.file(file).exists()) ? await Bun.file(file).json() : { updatedAt: "", commits: {} }
  const benches: string[] = []
  const i = process.argv.indexOf("--bench")
  if (i !== -1)
    for (const a of process.argv.slice(i + 1))
      if (!a.startsWith("--")) benches.push(a)
      else break
  for (const f of benches) {
    if (!(await Bun.file(f).exists())) continue
    const r: BenchResult = await Bun.file(f).json()
    const c = (data.commits[r.head.sha] ??= { ...r.head, bench: [] })
    c.bench = c.bench.filter((b) => b.base !== r.base.sha)
    c.bench.push({
      base: r.base.sha,
      createdAt: r.createdAt,
      runUrl: r.runUrl,
      runner: r.runner,
      regressed: r.regressed || Object.values(r.scenarios).some((s) => s.verdict.some((v) => v.regressed)),
      error: benchError(r),
      unavailable: r.unavailable,
      scenarios: Object.fromEntries(
        Object.entries(r.scenarios).map(([n, s]) => [
          n,
          {
            head: s.headMedians,
            base: s.baseMedians,
            regressed: s.verdict.filter((v) => v.regressed).map((v) => v.metric),
          },
        ]),
      ),
    })
  }
  const guard = flag(process.argv, "--guard")
  if (guard && (await Bun.file(guard).exists())) {
    const sha = flag(process.argv, "--sha")
    if (!sha) throw new Error("--guard 需要同时给出 --sha")
    const g = await Bun.file(guard).json()
    const info = Bun.spawnSync(["git", "show", "-s", "--format=%cI%x00%s", sha]).stdout.toString().trim().split("\0")
    const c = (data.commits[sha] ??= { sha, date: info[0] ?? "", subject: info[1] ?? "", bench: [] })
    c.debt = Object.fromEntries(
      Object.entries(g.totals as Record<string, { current: number }>).map(([k, v]) => [k, v.current]),
    )
    c.debtTotal = Object.entries(c.debt).reduce(
      (s, [k, n]) => (SIZE_RULES.has(k) || ruleInfo(k).level !== "error" ? s : s + n),
      0,
    )
    // 没有基线的旧提交（引入 guard 之前）每处存量都会算成错误，没有意义，只记存量
    c.guardErrors = g.baselineFound
      ? (g.violations as { level: string }[]).filter((v) => v.level === "error").length
      : undefined
  }
  data.updatedAt = new Date().toISOString()
  data.repository = process.env.GITHUB_REPOSITORY ?? data.repository
  await Bun.write(file, JSON.stringify(data))
  await Bun.write(path.join(site, "index.html"), Bun.file(path.join(import.meta.dir, "dashboard", "index.html")))
  await Bun.write(path.join(site, ".nojekyll"), "")
  console.log(`看板数据：${Object.keys(data.commits).length} 个提交`)
}

export async function merge(files: string[], head: string, base: string) {
  const parts = await Promise.all(files.map(async (file) => await Bun.file(file).json() as BenchResult))
  const first = parts[0]
  const merged: BenchResult = { ...first, scenarios: {}, unavailable: {}, regressed: false }
  const names = new Set<string>()
  for (const part of parts) {
    if (part.kind !== "bench" || part.head.sha !== head || part.base.sha !== base || part.rounds !== first.rounds || part.runner.os !== first.runner.os)
      throw new Error("分组结果不属于同一次比较")
    if (part.error) throw new Error(part.error)
    for (const name of [...Object.keys(part.scenarios), ...Object.keys(part.unavailable ?? {})]) {
      if (names.has(name)) throw new Error(`重复场景：${name}`)
      names.add(name)
    }
    if (Object.keys(part.scenarios).length && benchError(part)) throw new Error(benchError(part))
    Object.assign(merged.scenarios, part.scenarios)
    Object.assign(merged.unavailable!, part.unavailable)
    merged.regressed ||= part.regressed || Object.values(part.scenarios).some((s) => s.verdict.some((v) => v.regressed))
  }
  for (const name of Object.keys(SCENARIO_BUDGETS))
    if (!names.has(name)) throw new Error(`缺少分组结果：${name}`)
  if (!Object.keys(merged.scenarios).length) throw new Error("没有可比较的场景")
  return merged
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === "comment") await comment()
  else if (cmd === "publish") await publish()
  else if (cmd === "merge") {
    const [head, base, ...files] = process.argv.slice(3)
    const merged = await merge(files, head, base)
    await Bun.write("bench.json", JSON.stringify(merged))
    console.log(renderBenchMarkdown(merged))
    process.exitCode = merged.regressed ? 1 : 0
  }
  else {
    console.error("用法：report.ts comment|publish|merge …")
    process.exit(2)
  }
}
