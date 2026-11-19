#!/usr/bin/env bun
// 静态 import 图的测试选择（覆盖率图不可用时的保守兜底）。
//   bun script/guard/affected.ts <repo> [--base <ref>] [--files a,b] [--json out]
import path from "node:path"
import { posix, pjoin, git, flag, listFiles, loadPackages, collectImports, isTestFile } from "./lib"
import { ESCALATE_FULL, ALWAYS_RUN, FULL_RATIO } from "./affected-rules"

const args = process.argv.slice(2)
const repo = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".")

const lines = (s: string) => s.split("\n").map(posix).filter(Boolean)
const changed = flag(args, "--files")
  ? flag(args, "--files")!.split(",").map(posix)
  : [
      ...new Set([
        ...lines(git(repo, "diff", "--name-only", git(repo, "merge-base", flag(args, "--base") ?? "origin/dev1-smark", "HEAD").out, "HEAD").out),
        ...lines(git(repo, "diff", "--name-only", "HEAD").out),
        ...lines(git(repo, "ls-files", "--others", "--exclude-standard").out),
      ]),
    ]

const pkgs = await loadPackages(repo)
const files = await listFiles(repo, "packages/**/*.{ts,tsx}")
const fileSet = new Set(files)

function withExt(p: string) {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`]) if (fileSet.has(c)) return c
  if (/\.[a-z0-9]+$/i.test(p)) return p
}

function resolve(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return withExt(pjoin(path.posix.dirname(from), spec))
  const dir = pkgs.dirOf(from)
  if (spec.startsWith("@/") && dir) return withExt(`packages/${dir}/src/${spec.slice(2)}`)
  if (spec.startsWith("@test/") && dir) return withExt(`packages/${dir}/test/${spec.slice(6)}`)
  if (spec.startsWith("#") && dir) {
    const target = pkgs.byDir.get(dir)?.json.imports?.[spec]
    const t = typeof target === "string" ? target : target?.bun ?? target?.default
    return typeof t === "string" ? withExt(pjoin(`packages/${dir}`, t)) : undefined
  }
  for (const [name, p] of pkgs.byName) {
    if (spec !== name && !spec.startsWith(name + "/")) continue
    const sub = spec === name ? "." : "./" + spec.slice(name.length + 1)
    const exp = p.json.exports
    const pick = (v: unknown): string | undefined =>
      typeof v === "string" ? v : v && typeof v === "object" ? pick((v as Record<string, unknown>).bun ?? (v as Record<string, unknown>).default ?? Object.values(v)[0]) : undefined
    const direct = exp && typeof exp === "object" ? pick((exp as Record<string, unknown>)[sub]) : sub === "." && typeof exp === "string" ? exp : undefined
    if (direct) return withExt(pjoin(`packages/${p.dir}`, direct))
    const star = exp && typeof exp === "object" ? pick((exp as Record<string, unknown>)["./*"]) : undefined
    if (star && sub !== ".") return withExt(pjoin(`packages/${p.dir}`, star.replace("*", sub.slice(2)).replace(/\.tsx?$/, "")))
    return withExt(pjoin(`packages/${p.dir}`, "src", sub.slice(2)))
  }
}

const reverse = new Map<string, Set<string>>()
for (const f of files) {
  for (const ref of collectImports(f, await Bun.file(path.join(repo, f)).text())) {
    const t = resolve(f, ref.spec)
    if (t && t !== f) (reverse.get(t) ?? reverse.set(t, new Set()).get(t)!).add(f)
  }
}

const escalations = changed.filter((f) => ESCALATE_FULL.some((re) => re.test(f)))
const unknown = changed.filter((f) => f.startsWith("packages/") && !escalations.includes(f) && !reverse.has(f) && !fileSet.has(f))
const seen = new Set<string>()
const queue = changed.filter((f) => fileSet.has(f) || reverse.has(f))
while (queue.length) {
  const f = queue.pop()!
  if (seen.has(f)) continue
  seen.add(f)
  for (const dep of reverse.get(f) ?? []) queue.push(dep)
}
const isTest = (f: string) => /\.test\.tsx?$/.test(f)
const allTests = files.filter(isTest)
const selected = [...seen].filter(isTest)

const byPkg = new Map<string, { total: number; selected: string[] }>()
for (const t of allTests) {
  const d = `packages/${pkgs.dirOf(t)}`
  const e = byPkg.get(d) ?? byPkg.set(d, { total: 0, selected: [] }).get(d)!
  e.total++
}
for (const t of selected) byPkg.get(`packages/${pkgs.dirOf(t)}`)?.selected.push(t)

const plan: { pkg: string; mode: "full" | "files"; tests: string[]; reason: string }[] = []
for (const [pkg, e] of byPkg) {
  const escalated = escalations.filter((f) => f.startsWith(pkg + "/") || !f.startsWith("packages/"))
  const unresolved = unknown.filter((f) => f.startsWith(pkg + "/") && !isTestFile(f))
  if (escalated.length) plan.push({ pkg, mode: "full", tests: [], reason: `全局输入改动：${escalated[0]}` })
  else if (unresolved.length) plan.push({ pkg, mode: "full", tests: [], reason: `改动文件不在 import 图中：${unresolved[0]}` })
  else if (e.selected.length > e.total * FULL_RATIO) plan.push({ pkg, mode: "full", tests: [], reason: `受影响测试 ${e.selected.length}/${e.total} 超过 ${FULL_RATIO * 100}%` })
  else if (e.selected.length) plan.push({ pkg, mode: "files", tests: e.selected.sort(), reason: "import 图反向闭包" })
}
const always = allTests.filter((t) => ALWAYS_RUN.some((re) => re.test(t)))

const result = { changed: changed.length, plan, always }
const out = flag(args, "--json")
if (out) await Bun.write(out, JSON.stringify(result, null, 1))
for (const p of plan) console.log(`${p.mode.padEnd(5)} ${p.pkg}  ${p.mode === "files" ? p.tests.length + " 个文件" : ""}  （${p.reason}）`)
console.log(`always: ${always.length} 个文件；改动：${changed.length} 个文件`)
