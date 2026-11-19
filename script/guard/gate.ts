#!/usr/bin/env bun
// 分层门禁入口。hook、插件、CI 都调用它，层级决定检查对象。
//
//   bun script/guard/gate.ts commit --message <file>    commit-msg：暂存区静态检查 + 改动规模（不碰其他 Agent 未暂存的改动）
//   bun script/guard/gate.ts stop --files a.ts,b.ts     Agent 结束回合：只看本会话改过的文件 + 受影响测试
//   bun script/guard/gate.ts push [--since <ref>]       pre-push：待推送提交的静态检查 + 选中测试 + 契约测试 + 按需 preflight
//   bun script/guard/gate.ts contracts                  只跑契约与打包边界测试（CI 用）
//
// 本地不跑全量测试：选测试的结果是全量时转交 preflight，在线上对同一个 SHA 跑，通过后再 push 即放行。
// 环境变量（由人设置）：
//   GUARD_TESTS=off|full                  off 跳过测试；full 在本地也跑全量
//   GUARD_PREFLIGHT=off|auto|required     默认 auto：gh 不可用时只提示
//   GUARD_PREFLIGHT_PLATFORMS             平台敏感改动的 preflight 平台，默认 macos,linux
//   GUARD_PREFLIGHT_FULL_PLATFORMS        只因全量测试而触发的 preflight 平台，默认 linux
import path from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { git, flag, posix, originRepo } from "./lib"
import { MAIN_BRANCH, PLATFORM_SENSITIVE } from "./rules"
import * as ui from "./ui"

const args = process.argv.slice(2)
const tier = args[0] ?? "commit"
const repo = git(process.cwd(), "rev-parse", "--show-toplevel").out || process.cwd()
const here = path.join(repo, "script/guard")
const ci = process.env.GITHUB_ACTIONS === "true"
const testsMode = process.env.GUARD_TESTS
const started = performance.now()
const failures: { title: string; out: string; log: string }[] = []
const notes: string[] = []
let waiting = ""

type Progress = { feed: (text: string) => void; render: () => string; result: () => string }
type StepOptions = { cwd?: string; states?: Record<number, ui.State>; progress?: Progress }

// 运行一个步骤：实时显示，结束后一行结果；失败时保留输出与完整日志
async function step(name: string, detail: string, cmd: string[], opts: StepOptions = {}) {
  const task = ui.task(name, detail, opts.progress?.render)
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } })
  let out = ""
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      out += text
      opts.progress?.feed(text)
    }
  }
  await Promise.all([read(p.stdout), read(p.stderr)])
  const code = await p.exited
  const state = opts.states?.[code] ?? (code === 0 ? "ok" : "fail")
  task.done(state, opts.progress?.result())
  if (state === "fail") failures.push({ title: `${name}  ${detail}`, out, log: saveLog(`${name}-${detail}`, out) })
  // 通过时也转出放行记录，让人看到哪些提交是按 Guard-Allow-Large 放行的
  if (state === "ok") for (const l of out.split("\n")) if (l.includes("已按 Guard-Allow-Large 放行")) ui.sub(l.replace(/^ℹ\s*/, ""))
  return { state, out, code }
}

function saveLog(name: string, text: string) {
  const dir = path.join(repo, ".git", "guard", "logs")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60)}.log`)
  writeFileSync(file, text)
  return posix(path.relative(repo, file))
}

const runtimeTs = (f: string) => /^packages\/(core|opencode|tui|cli|server)\/src\/.*\.tsx?$/.test(f) && !f.endsWith(".d.ts")

// 类型感知的多余防御检查：默认只提示（GUARD_UNNEEDED=error 时阻断）
async function unneededGuards(files: string[]) {
  const enforce = process.env.GUARD_UNNEEDED === "error"
  for (const [pkg, list] of Map.groupBy(files.filter(runtimeTs), (f) => f.split("/").slice(0, 2).join("/"))) {
    const r = await step("多余防御检查", `${pkg} · ${list.length} 个文件`, ["bun", path.join(here, "unneeded-guards.ts"), `${pkg}/tsconfig.json`, ...list], {
      states: { 0: "ok", 1: enforce ? "fail" : "warn" },
    })
    if (r.state === "warn") notes.push(`多余防御（提示）：\n${r.out.trim()}`)
  }
}

// 覆盖率图由 nightly 发布到 release「guard-coverage-map」；本地没有或超过一天才去取（GUARD_MAP_SYNC=off 关闭）
function syncMaps() {
  if (process.env.GUARD_MAP_SYNC === "off" || testsMode === "off") return
  const dir = path.join(repo, ".git", "guard-cache")
  const probe = Bun.file(path.join(dir, "coverage-map-opencode.json"))
  if (probe.size > 0 && Date.now() - probe.lastModified < 86_400_000) return
  const slug = originRepo(repo)
  const cmd = ["gh", "release", "download", "guard-coverage-map", ...(slug ? ["-R", slug] : []), "--pattern", "coverage-map-*.json", "--dir", dir, "--clobber"]
  const r = Bun.which("gh") ? Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" }) : undefined
  if (r?.exitCode !== 0) notes.push("没有取到覆盖率图（gh release download guard-coverage-map），本次按静态依赖图选测试")
}

// ── 选测试：覆盖率图优先；没有图、图过期或有图外文件时，退回静态依赖图（三个包共用一次计算）──
type Plan = { pkg: string; full: boolean; tests: string[]; via: string }
const PKGS = ["packages/opencode", "packages/core", "packages/tui"]

async function planTests(files: string[]) {
  const plans: Plan[] = []
  let fallback: Plan[] | undefined
  for (const pkg of PKGS) {
    const map = path.join(repo, ".git", "guard-cache", `coverage-map-${pkg.split("/")[1]}.json`)
    if (Bun.file(map).size > 0) {
      const r = Bun.spawnSync(["bun", path.join(here, "select-tests.ts"), "select", pkg, "--map", map, "--files", files.join(",")], { cwd: repo })
      const pick = JSON.parse(r.stdout.toString() || "{}")
      if (pick.mode && pick.mode !== "stale" && !pick.unmapped?.length) {
        plans.push({ pkg, full: pick.mode === "full", tests: pick.tests ?? [], via: "覆盖率图" })
        continue
      }
    }
    fallback ??= await staticPlan(files)
    const p = fallback.find((x) => x.pkg === pkg)
    if (p) plans.push(p)
  }
  return plans.filter((p) => p.full || p.tests.length)
}

async function staticPlan(files: string[]): Promise<Plan[]> {
  const out = path.join(repo, ".git", "guard-cache", "affected.json")
  const r = await step("选测试", `静态依赖图 · ${files.length} 个文件`, ["bun", path.join(here, "affected.ts"), repo, "--files", files.join(","), "--json", out])
  if (r.state !== "ok") return []
  const plan: { pkg: string; mode: string; tests: string[] }[] = (await Bun.file(out).json()).plan ?? []
  return plan.map((p) => ({ pkg: p.pkg, full: p.mode === "full", tests: p.tests ?? [], via: "静态依赖图" }))
}

// bun test --dots：每个通过的用例输出一个点，失败输出 (fail) 行；总数按测试文件里的 test()/it() 估算
const CASE = /^\s*(?:test|it)(?:\.(?:skip|todo|only|if\([^)]*\)|each\([^)]*\)|concurrent|serial|failing))*\s*\(/gm
async function estimateCases(cwd: string, files: string[]) {
  const list = files.length ? files : await Array.fromAsync(new Bun.Glob("**/*.test.{ts,tsx}").scan({ cwd })).then((all) => all.filter((f) => !f.includes("node_modules")))
  let n = 0
  for (const f of list) n += ((await Bun.file(path.join(cwd, f)).text().catch(() => "")).match(CASE) ?? []).length
  return n
}

function testProgress(total: number): Progress {
  let pass = 0
  let fail = 0
  let tail = ""
  const dots = () => (/^\.+$/.test(tail) ? tail.length : 0)
  return {
    feed(text) {
      const lines = (tail + text).split("\n")
      tail = lines.pop() ?? ""
      for (const l of lines) {
        if (/^\.+$/.test(l)) pass += l.length
        else if (l.startsWith("(fail)")) fail++
      }
    },
    render() {
      const done = pass + dots() + fail
      const failed = fail ? `  ${ui.red(`✗${fail}`)}` : ""
      // 估算偏低（循环生成用例等）时不再画进度条，只计数
      return done < total ? `${ui.bar(done / total)} ${done}/~${total}${failed}` : `${done} 个用例${failed}`
    },
    result: () => `${pass + dots()} 通过${fail ? ` · ${ui.red(`${fail} 失败`)}` : ""}`,
  }
}

// 返回被转交给 preflight 的全量包
async function runTests(files: string[]) {
  if (testsMode === "off" || !files.length) return []
  const deferred: string[] = []
  for (const plan of await planTests(files)) {
    const scope = plan.full ? "全量" : `${plan.tests.length} 个文件`
    if (plan.full && !ci && testsMode !== "full") {
      ui.line("skip", "测试", `${plan.pkg} · ${scope}`, "本地不跑全量，转交 preflight")
      deferred.push(plan.pkg)
      continue
    }
    const cwd = path.join(repo, plan.pkg)
    const rel = plan.tests.map((t) => posix(path.relative(cwd, path.join(repo, t))))
    await step("测试", `${plan.pkg} · ${scope} · ${plan.via}`, ["bun", "test", "--dots", "--preload", path.join(here, "leak-preload.ts"), ...rel], {
      cwd,
      progress: testProgress(await estimateCases(cwd, rel)),
    })
  }
  return deferred
}

// 已有契约与打包边界测试：原先不在任何必过任务里
async function contracts() {
  if (testsMode === "off") return
  for (const [pkg, target] of [["schema", "./test"], ["protocol", "./test"], ["client", "./test/import-boundaries.test.ts"], ["sdk-next", "./test/import-boundaries.test.ts"]])
    await step("契约测试", pkg, ["bun", "test", target], { cwd: path.join(repo, "packages", pkg) })
}

// 跨平台 / 全量测试交给 GitHub：同一个 SHA 通过后再 push 即放行
async function preflight(sha: string, sensitive: string[], deferred: string[]) {
  const mode = process.env.GUARD_PREFLIGHT ?? "auto"
  const why = [sensitive.length && "平台敏感改动", deferred.length && `全量测试（${deferred.join("、")}）`].filter(Boolean).join(" + ")
  if (mode === "off") {
    if (deferred.length) notes.push(`${why}没有在本地运行，preflight 也已关闭（GUARD_PREFLIGHT=off）：push 后由 test.yml 补测`)
    return
  }
  const platforms = sensitive.length
    ? (process.env.GUARD_PREFLIGHT_PLATFORMS ?? "macos,linux")
    : (process.env.GUARD_PREFLIGHT_FULL_PLATFORMS ?? "linux")
  const r = await step("preflight", `${sha.slice(0, 8)} · ${platforms} · ${why}`, ["bun", path.join(here, "preflight.ts"), "ensure", "--sha", sha, "--platforms", platforms], {
    states: { 0: "ok", 10: "wait", 3: mode === "required" ? "fail" : "skip" },
  })
  for (const l of r.out.trim().split("\n").filter(Boolean)) if (r.state !== "fail") ui.sub(l)
  if (r.state === "wait") waiting = "通过后再 push 一次即可，本地不用等"
  if (r.state === "skip") notes.push(`gh 不可用，跳过 preflight：${why}交给 push 后的 test.yml（GUARD_PREFLIGHT=required 可改为阻断）`)
}

if (tier === "commit") {
  const message = flag(args, "--message")
  await step("规则检查", "暂存区", ["bun", path.join(here, "check.ts"), repo, "--staged", ...(message ? ["--message", message] : [])])
} else if (tier === "stop") {
  const files = (flag(args, "--files") ?? "").split(",").map(posix).filter(Boolean)
  if (!files.length) process.exit(0)
  await step("规则检查", `本会话 ${files.length} 个文件`, ["bun", path.join(here, "check.ts"), repo, "--files", files.join(",")])
  await unneededGuards(files)
  if (!failures.length) {
    const deferred = await runTests(files)
    if (deferred.length) notes.push(`${deferred.join("、")} 需要全量测试，留到 push 时由 preflight 在线上运行`)
  }
} else if (tier === "push") {
  const sha = git(repo, "rev-parse", flag(args, "--sha") ?? "HEAD").out
  const since = flag(args, "--since") ?? `origin/${MAIN_BRANCH}`
  const stamp = Bun.file(path.join(repo, ".git", "guard", "green", `push-${sha}`))
  if (await stamp.exists()) {
    ui.line("ok", "push 检查", sha.slice(0, 8), "此前已通过，跳过")
    process.exit(0)
  }
  const range = git(repo, "diff", "--name-only", since, sha).out.split("\n").map(posix).filter(Boolean)
  await step("规则检查", `${since}..${sha.slice(0, 8)} · ${range.length} 个文件`, ["bun", path.join(here, "check.ts"), repo, "--commit", sha, "--changed-since", since])

  // 多 Agent 共用工作区：测试跑在工作区上，与 HEAD 不一致的文件要说明
  const dirty = git(repo, "status", "--porcelain", "--", ...range).out
  if (dirty) notes.push(`以下待推送文件在工作区还有未提交改动，测试结果对应的是工作区内容：\n${dirty}`)

  let deferred: string[] = []
  if (!failures.length) {
    await unneededGuards(range)
    syncMaps()
    deferred = await runTests(range)
    await contracts()
  }
  const sensitive = range.filter((f) => PLATFORM_SENSITIVE.some((re) => re.test(f)))
  if (!failures.length && (sensitive.length || deferred.length)) await preflight(sha, sensitive, deferred)
  if (!failures.length && !waiting) await Bun.write(stamp, new Date().toISOString())
} else if (tier === "contracts") {
  await contracts()
} else {
  console.error(`未知层级：${tier}（可选 commit | stop | push | contracts）`)
  process.exit(2)
}

for (const n of notes) ui.note(n)
for (const f of failures) {
  ui.section(f.title)
  ui.raw(f.out.trim().slice(-8000))
  ui.raw(ui.dim(`完整日志：${f.log}`))
}
if (tier === "push" || failures.length || waiting) {
  const ms = performance.now() - started
  if (failures.length) ui.line("fail", `未通过（${failures.length} 项）`, "", "", ms)
  else if (waiting) ui.line("wait", "等待 preflight", waiting)
  else ui.line("ok", "全部通过", "", "", ms)
}
process.exit(failures.length || waiting ? 1 : 0)
