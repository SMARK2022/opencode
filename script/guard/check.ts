#!/usr/bin/env bun
// 机械门禁执行器。退出码：0 通过（可能有 warn）；1 有 error 级新增违规；2 执行异常。
//
//   bun script/guard/check.ts [repo]                 检查工作区
//   bun script/guard/check.ts . --staged             检查 git index（pre-commit：即将提交的内容）
//   bun script/guard/check.ts . --commit HEAD        检查某个提交的树（pre-push / CI）
//   bun script/guard/check.ts . --files a.ts,b.ts    只检查这些文件（插件、Agent 结束闸门）
//   bun script/guard/check.ts . --write-baseline     以当前状态写基线（首次接入、上游同步后）
//
// 改动规模（size.ts，不读基线）：暂存区模式需要 --message <提交信息文件>（commit-msg 阶段）；
// --commit 配合 --changed-since 时逐个提交判定；--files 时只提示。
//   --allow-large  已由审批放行（CI：PR 有维护者 approve）   --no-trailer  不认提交信息里的放行标记（CI 的 PR 模式）
//
// 输出：--json <file>  --markdown <file>（可指向 $GITHUB_STEP_SUMMARY）  --annotate [--diff-base <ref>]
import path from "node:path"
import { readFileSync } from "node:fs"
import {
  posix, pjoin, git, flag, listFiles, loadPackages, collectImports, isPureForwarder,
  exportIndex, exportCommit, isTestFile, isSrcFile, type Pkg,
} from "./lib"
import {
  PACKAGE_DEPS, UNGOVERNED, CORE_ENTRY_ALLOW, SERVER_STORAGE_SCOPE, STORAGE_SPEC, DESKTOP_ZONES,
  BOUNDARY_RULES, RATCHETS, SHAPE_SCOPE, SHAPE_RULES, OTHER_RULES, type Level,
} from "./rules"
import { measure } from "./shape"
import { renderMarkdown } from "./report"
import { rangeSize, stagedSize, worktreeSize, type SizeHit } from "./size"

type Counts = Record<string, Record<string, number>>
type Lines = Record<string, Record<string, number[]>>
export type Baseline = { version: 2; generatedAt: string; counts: Counts; forwarders: string[] }
export type Violation = { rule: string; level: Level; key: string; file: string; count: number; allowed: number; lines: number[]; fix: string }
export type CheckResult = {
  mode: string
  sha?: string
  files: number
  baselineFound: boolean
  violations: Violation[]
  totals: Record<string, { current: number; baseline: number }>
  notes: string[]
}

const args = process.argv.slice(2)
const repo = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".")
const commitRef = flag(args, "--commit")
const staged = args.includes("--staged")
const since = flag(args, "--changed-since")
// 每条规则都按文件判定，新增违规只可能出现在改动过的文件里：暂存区与提交范围模式只扫描改动文件
const changedList = (out: string) => out.split("\n").map(posix).filter(Boolean)
const only: string[] | undefined =
  flag(args, "--files")?.split(",").map((f) => posix(f.trim())).filter(Boolean) ??
  (staged && git(repo, "rev-parse", "--verify", "--quiet", "HEAD").ok
    ? changedList(git(repo, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "HEAD").out)
    : since
      ? changedList(git(repo, "diff", "--name-only", "--diff-filter=ACMR", since, ...(commitRef ? [commitRef] : [])).out)
      : undefined)
const mode = staged ? "staged" : commitRef ? `commit ${commitRef}` : since ? `changed-since ${since}` : only ? "files" : "worktree"

export const ruleInfo = (rule: string): { level: Level; fix: string } =>
  BOUNDARY_RULES[rule] ??
  SHAPE_RULES[rule] ??
  OTHER_RULES[rule] ??
  RATCHETS.find((r) => r.id === rule) ?? { level: "error", fix: "" }

async function main(): Promise<CheckResult> {
  const snap = staged ? await exportIndex(repo, only) : commitRef ? await exportCommit(repo, commitRef) : undefined
  const root = snap?.dir ?? repo
  try {
    return await analyze(root)
  } finally {
    await snap?.cleanup()
  }
}

async function analyze(root: string): Promise<CheckResult> {
  const notes: string[] = []
  const counts: Counts = {}
  const lines: Lines = {}
  const hit = (rule: string, key: string, line: number, n = 1) => {
    ;(counts[rule] ??= {})[key] = (counts[rule][key] ?? 0) + n
    ;((lines[rule] ??= {})[key] ??= []).push(line)
  }

  const pkgs = await loadPackages(root)
  const all = await listFiles(root, "packages/**/*.{ts,tsx,mts,cts}")
  const inScope = only ? all.filter((f) => only.includes(f)) : all

  // B0：新增包必须登记（部分扫描时，只有改到 package.json 才检查）
  if (!only || only.some((f) => f.endsWith("package.json")))
    for (const dir of pkgs.byDir.keys())
      if (!(dir in PACKAGE_DEPS) && !UNGOVERNED.includes(dir)) hit("B0-unregistered-package", `packages/${dir}`, 1)

  for (const file of inScope) {
    const text = await Bun.file(path.join(root, file)).text()
    const dir = pkgs.dirOf(file)
    if (!dir) continue
    const dts = file.endsWith(".d.ts")
    boundary(file, dir, text, pkgs, hit)
    if (dts) continue
    ratchets(file, text, hit)
    if (isSrcFile(file) && SHAPE_SCOPE.test(file)) {
      const m = measure(text, file)
      for (const [rule, n] of Object.entries(m.counts)) {
        if (!n) continue
        ;(counts[rule] ??= {})[file] = n
        ;(lines[rule] ??= {})[file] = m.lines[rule] ?? [1]
      }
    }
  }

  // CI 配置：软失败与超时覆盖
  if (!only || only.some((f) => f.startsWith(".github/workflows/")))
    for (const wf of await listFiles(root, ".github/workflows/*.{yml,yaml}")) {
      if (only && !only.includes(wf)) continue
      const text = await Bun.file(path.join(root, wf)).text()
      for (const [rule, re] of [["ci-soft", /^\s*continue-on-error:\s*true/gm], ["ci-timeout", /--timeout[ =]\d+/g]] as const)
        for (const m of text.matchAll(re)) hit(rule, wf, lineAt(text, m.index ?? 0))
    }

  // 纯转发模块
  const forwarders = (await listFiles(root, "packages/{opencode,cli}/src/**/*.{ts,tsx}")).filter(Boolean)
  const forwarderNow = new Set<string>()
  for (const f of forwarders) if (isPureForwarder(f, await Bun.file(path.join(root, f)).text())) forwarderNow.add(f)

  const baselinePath = flag(args, "--baseline") ?? path.join(root, "script/guard/baseline.json")
  if (args.includes("--write-baseline")) {
    if (only || staged || commitRef) throw new Error("--write-baseline 只能在完整工作区模式下使用")
    const baseline: Baseline = {
      version: 2,
      generatedAt: new Date().toISOString(),
      counts: sortCounts(counts),
      forwarders: [...forwarderNow].sort(),
    }
    await Bun.write(flag(args, "--baseline") ?? path.join(repo, "script/guard/baseline.json"), JSON.stringify(baseline, null, 1) + "\n")
    notes.push(`基线已写入：${Object.values(counts).reduce((s, c) => s + Object.keys(c).length, 0)} 条存量记录，${forwarderNow.size} 个纯转发模块`)
  }

  const baselineFile = Bun.file(args.includes("--write-baseline") ? (flag(args, "--baseline") ?? path.join(repo, "script/guard/baseline.json")) : baselinePath)
  const baselineFound = await baselineFile.exists()
  const baseline: Baseline = baselineFound
    ? await baselineFile.json()
    : { version: 2, generatedAt: "", counts: {}, forwarders: [] }
  if (!baselineFound) notes.push("未找到 script/guard/baseline.json：全部存量都会被当作新增。首次接入请运行 bun script/guard/check.ts . --write-baseline")

  for (const f of baseline.forwarders)
    if ((!only || only.includes(f)) && forwarders.includes(f) && !forwarderNow.has(f)) hit("F1-forwarder-lock", f, 1)

  const violations: Violation[] = []
  for (const [rule, perKey] of Object.entries(counts))
    for (const [key, n] of Object.entries(perKey)) {
      const allowed = baseline.counts[rule]?.[key] ?? 0
      if (n <= allowed) continue
      const info = ruleInfo(rule)
      violations.push({ rule, level: info.level, key, file: key.split(" -> ")[0], count: n, allowed, lines: lines[rule]?.[key] ?? [1], fix: info.fix })
    }

  // 改动规模：只看这一次改了什么，不读基线
  const size = sizeChecks()
  notes.push(...size.notes)
  for (const h of size.hits) {
    const info = ruleInfo(h.rule)
    violations.push({ rule: h.rule, level: h.warn ? "warn" : info.level, key: h.key, file: h.file, count: h.count, allowed: h.allowed, lines: [1], fix: info.fix })
  }

  // C2：基线只能下降（CI 用目标分支的基线比较 PR 中的基线）
  const prevPath = flag(args, "--previous-baseline")
  if (prevPath) {
    const prev: Baseline = await Bun.file(prevPath).json()
    for (const [rule, perKey] of Object.entries(baseline.counts))
      for (const [key, n] of Object.entries(perKey))
        if (n > (prev.counts[rule]?.[key] ?? 0))
          violations.push({ rule: "C2-baseline-raised", level: "error", key: `${rule}: ${key}`, file: "script/guard/baseline.json", count: n, allowed: prev.counts[rule]?.[key] ?? 0, lines: [1], fix: "基线只能下降。放宽规则必须由维护者在独立 PR 中修改。" })
    for (const f of prev.forwarders)
      if (!baseline.forwarders.includes(f) && forwarderNow.has(f))
        violations.push({ rule: "C2-baseline-raised", level: "error", key: `forwarder: ${f}`, file: "script/guard/baseline.json", count: 1, allowed: 0, lines: [1], fix: "不得从基线中移除仍是纯转发的模块。" })
  }

  // 局部检查时基线也只统计范围内的文件，否则"当前"偏小、看起来像大幅下降
  const scope = only ? new Set(inScope) : undefined
  const scoped = (perKey: Record<string, number> | undefined) =>
    scope && perKey ? Object.fromEntries(Object.entries(perKey).filter(([k]) => scope.has(k.split(" -> ")[0]))) : perKey
  const totals: CheckResult["totals"] = {}
  for (const rule of new Set([...Object.keys(counts), ...Object.keys(baseline.counts)]))
    totals[rule] = { current: sum(counts[rule]), baseline: sum(scoped(baseline.counts[rule])) }

  violations.sort((a, b) => (a.level === b.level ? a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key) : a.level === "error" ? -1 : 1))
  return { mode, sha: commitRef ? git(repo, "rev-parse", commitRef).out : undefined, files: inScope.length, baselineFound, violations, totals, notes }
}

function sizeChecks(): { hits: SizeHit[]; notes: string[] } {
  const opts = { allowLarge: args.includes("--allow-large"), ignoreTrailer: args.includes("--no-trailer") }
  if (staged) {
    const msg = flag(args, "--message")
    if (!msg) return { hits: [], notes: ["改动规模在 commit-msg 阶段检查（需要提交信息），本次跳过"] }
    return stagedSize(repo, readFileSync(msg, "utf8"), opts)
  }
  if (commitRef && since) return rangeSize(repo, since, commitRef, opts)
  if (flag(args, "--files") && only) return worktreeSize(repo, only)
  return { hits: [], notes: [] }
}

function boundary(file: string, dir: string, text: string, pkgs: Awaited<ReturnType<typeof loadPackages>>, hit: (r: string, k: string, l: number) => void) {
  const src = isSrcFile(file)
  const policy = PACKAGE_DEPS[dir]
  for (const ref of collectImports(file, text)) {
    const spec = ref.spec
    const relative = spec.startsWith(".")
    const resolved = relative ? pjoin(path.posix.dirname(file), spec) : undefined
    let target: { pkg: Pkg | undefined; sub: string } | undefined
    if (resolved) target = { pkg: pkgs.byDir.get(pkgs.dirOf(resolved + "/") ?? pkgs.dirOf(resolved) ?? ""), sub: "" }
    else
      for (const [name, pkg] of pkgs.byName)
        if (spec === name || spec.startsWith(name + "/")) {
          if (!target || name.length > (target.pkg?.name.length ?? 0)) target = { pkg, sub: spec === name ? "" : spec.slice(name.length + 1) }
        }

    // B4：相对路径越过包根（所有文件，包括测试、脚本与 .d.ts）
    if (resolved && !resolved.startsWith(`packages/${dir}/`)) hit("B4-relative-escape", `${file} -> ${resolved}`, ref.line)
    if (!src) continue

    const tdir = target?.pkg?.dir
    if (!relative && tdir && tdir !== dir && Array.isArray(policy) && !policy.includes(tdir))
      hit("B1-package-deps", `${file} -> ${spec}`, ref.line)
    if (!relative && tdir === "core" && dir in CORE_ENTRY_ALLOW && !CORE_ENTRY_ALLOW[dir].includes(target!.sub))
      hit("B2-core-entry", `${file} -> ${spec}`, ref.line)
    if (dir === "core" && !file.startsWith("packages/core/src/v1/")) {
      const intoV1 = (tdir === "core" && target!.sub.startsWith("v1/")) || resolved?.startsWith("packages/core/src/v1/")
      if (intoV1) hit("B3-core-v1", `${file} -> ${resolved ?? spec}`, ref.line)
    }
    if (SERVER_STORAGE_SCOPE.test(file) && (STORAGE_SPEC.test(spec) || /\.sql(\.ts)?$/.test(resolved ?? "")))
      hit("B5-server-storage", `${file} -> ${spec}`, ref.line)
    if (file.startsWith("packages/desktop/src/") && resolved) {
      const z = DESKTOP_ZONES
      const fromRenderer = file.startsWith(z.renderer)
      const intoRenderer = resolved.startsWith(z.renderer)
      const intoMainOrPreload = resolved.startsWith(z.main) || resolved.startsWith(z.preload)
      const preloadTypes = ref.type && /preload\/types(\.ts)?$/.test(resolved)
      if ((fromRenderer && intoMainOrPreload && !preloadTypes) || (!fromRenderer && intoRenderer)) hit("B6-desktop-zones", `${file} -> ${resolved}`, ref.line)
    }
    if (/(^|\/)(test|tests|fixture|fixtures|__tests__)(\/|$)/.test(resolved ?? (spec.startsWith("@test/") ? "test/" : "")))
      hit("B7-prod-imports-test", `${file} -> ${resolved ?? spec}`, ref.line)
  }
}

function ratchets(file: string, text: string, hit: (r: string, k: string, l: number) => void) {
  const test = isTestFile(file)
  const src = isSrcFile(file)
  for (const r of RATCHETS) {
    if (r.scope === "src" && !src) continue
    if (r.scope === "test" && !test) continue
    if (r.packages && !r.packages.test(file)) continue
    if (r.only && !r.only.test(file)) continue
    if (r.exclude?.test(file)) continue
    for (const m of text.matchAll(r.pattern)) hit(r.id, file, lineAt(text, m.index ?? 0))
  }
}

const lineAt = (text: string, index: number) => {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
const sum = (c?: Record<string, number>) => Object.values(c ?? {}).reduce((s, n) => s + n, 0)
const sortCounts = (c: Counts) =>
  Object.fromEntries(Object.keys(c).sort().map((r) => [r, Object.fromEntries(Object.entries(c[r]).sort(([a], [b]) => a.localeCompare(b)))]))

// ── 输出 ──
// 改动规模类规则的 key 已经说明位置（提交或文件），不带行号
const where = (v: Violation) => (["change-size", "file-lines", "tiny-module"].includes(v.rule) ? v.key : `${v.key}:${v.lines[0]}`)
function printConsole(r: CheckResult) {
  for (const n of r.notes) console.log(`ℹ ${n}`)
  const groups = Map.groupBy(r.violations, (v) => v.rule)
  for (const [rule, list] of groups) {
    const lv = list[0].level
    console.log(`\n${lv === "error" ? "✗" : "△"} ${rule}  (${list.length})${lv === "warn" ? "  [提示，不阻断]" : ""}\n  修复方向：${list[0].fix}`)
    for (const v of list.slice(0, 12)) console.log(`  ${where(v)}  ${v.count} > 允许 ${v.allowed}`)
    if (list.length > 12) console.log(`  … 另有 ${list.length - 12} 处`)
  }
  const errors = r.violations.filter((v) => v.level === "error").length
  const warns = r.violations.length - errors
  console.log(`\n[guard] ${r.mode} · ${r.files} 个文件 · ${errors} 个错误 · ${warns} 个提示`)
}

function addedLines(base: string) {
  const out = new Map<string, Set<number>>()
  let file = ""
  for (const l of git(repo, "diff", "-U0", base, "--").out.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(6)
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (m && file) {
      const set = out.get(file) ?? out.set(file, new Set()).get(file)!
      for (let i = 0; i < Number(m[2] ?? 1); i++) set.add(Number(m[1]) + i)
    }
  }
  return out
}

function printAnnotations(r: CheckResult) {
  const diffBase = flag(args, "--diff-base")
  const added = diffBase ? addedLines(diffBase) : undefined
  for (const v of r.violations) {
    const onAdded = added?.get(v.file) ? v.lines.filter((l) => added.get(v.file)!.has(l)) : []
    const pick = onAdded.length ? onAdded.slice(0, 3) : [v.lines.at(-1) ?? 1]
    const msg = `${v.key.includes(" -> ") ? v.key.split(" -> ")[1] + "：" : ""}${v.fix}（${v.count} > 允许 ${v.allowed}）`.replace(/\r?\n/g, " ")
    for (const line of pick) console.log(`::${v.level === "error" ? "error" : "warning"} file=${v.file},line=${line},title=${v.rule}::${msg}`)
  }
}

if (import.meta.main) {
  try {
    const r = await main()
    if (!args.includes("--quiet")) printConsole(r)
    if (args.includes("--annotate")) printAnnotations(r)
    const json = flag(args, "--json")
    if (json) await Bun.write(json, JSON.stringify(r, null, 1))
    const md = flag(args, "--markdown")
    if (md) {
      const prev = (await Bun.file(md).exists()) ? await Bun.file(md).text() : ""
      await Bun.write(md, prev + renderMarkdown(r))
    }
    process.exit(r.violations.some((v) => v.level === "error") ? 1 : 0)
  } catch (e) {
    console.error(`[guard] 执行异常：${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
}
