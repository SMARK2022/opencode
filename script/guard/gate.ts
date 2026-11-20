#!/usr/bin/env bun
// 分层门禁入口。hook、插件、CI 都调用它，层级决定检查对象。
//
//   bun script/guard/gate.ts commit --message <file>    commit-msg：暂存区静态检查 + 改动规模（不碰其他 Agent 未暂存的改动）
//   bun script/guard/gate.ts stop --files a.ts,b.ts     Agent 结束回合：只看本会话改过的文件 + 受影响测试
//   bun script/guard/gate.ts push [--since <ref>]       pre-push：待推送提交的静态检查 + 选中测试 + 契约测试 + 按需 preflight
//   bun script/guard/gate.ts contracts                  只跑契约与打包边界测试（CI 用）
//
// 本地不跑全量测试：选测试的结果是全量、或工作区里有会被测试加载的未提交改动时，转交 preflight，
// 在线上对同一个 SHA 跑，通过后再 push 即放行。
// 环境变量（由人设置）：
//   GUARD_TESTS=off|full                  off 跳过测试（push 之后由 CI 补测）；full 在本地也跑全量
//   GUARD_PREFLIGHT=off|auto|required     off 不触发 preflight；auto（默认）gh 不可用时只提示；required 时阻断
//   GUARD_PREFLIGHT_PLATFORMS             平台敏感改动的 preflight 平台，默认 macos,linux
//   GUARD_PREFLIGHT_FULL_PLATFORMS        只因全量测试而触发的 preflight 平台，默认 linux
import path from "node:path"
import os from "node:os"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { git, gitPath, flag, posix, originRepo } from "./lib"
import { MAIN_BRANCH, PLATFORM_SENSITIVE } from "./rules"
import { UI } from "./ui"

const args = process.argv.slice(2)
const tier = args[0] ?? "commit"
const repo = git(process.cwd(), "rev-parse", "--show-toplevel").out || process.cwd()
const here = import.meta.dir
const ci = process.env.GITHUB_ACTIONS === "true"
const testsMode = ci ? undefined : process.env.GUARD_TESTS
const started = performance.now()
const failures: { title: string; out: string; log: string }[] = []
const notes: string[] = []
let waiting = ""

type Progress = { feed: (text: string) => void; render: () => string; result: () => string }
type StepOptions = { cwd?: string; states?: Record<number, UI.State>; progress?: Progress }

// 运行一个步骤：实时显示，结束后一行结果；失败时保留输出与完整日志
async function step(name: string, detail: string, cmd: string[], opts: StepOptions = {}) {
  const task = UI.task(name, detail, opts.progress?.render)
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd ?? repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
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
  if (state === "ok")
    for (const l of out.split("\n")) if (l.includes("已按 Guard-Allow-Large 放行")) UI.sub(l.replace(/^ℹ\s*/, ""))
  return { state, out, code }
}

function saveLog(name: string, text: string) {
  const dir = gitPath(repo, "guard", "logs")
  mkdirSync(dir, { recursive: true })
  const file = path.join(
    dir,
    `${name
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)}.log`,
  )
  writeFileSync(file, text)
  return posix(path.relative(repo, file))
}

const runtimeTs = (f: string) =>
  /^packages\/(core|opencode|tui|cli|server)\/src\/.*\.tsx?$/.test(f) && !f.endsWith(".d.ts")

// 类型感知的多余防御检查：默认只提示（GUARD_UNNEEDED=error 时阻断）
async function unneededGuards(files: string[]) {
  const enforce = process.env.GUARD_UNNEEDED === "error"
  for (const [pkg, list] of Map.groupBy(files.filter(runtimeTs), (f) => f.split("/").slice(0, 2).join("/"))) {
    const r = await step(
      "多余防御检查",
      `${pkg} · ${list.length} 个文件`,
      ["bun", path.join(here, "unneeded-guards.ts"), `${pkg}/tsconfig.json`, ...list],
      {
        states: { 0: "ok", 1: enforce ? "fail" : "warn" },
      },
    )
    if (r.state === "warn") notes.push(`多余防御（提示）：\n${r.out.trim()}`)
  }
}

// 覆盖率图由 nightly 发布到 release「guard-coverage-map」；本地没有或超过一天才去取（GUARD_MAP_SYNC=off 关闭）
function syncMaps() {
  if (process.env.GUARD_MAP_SYNC === "off" || testsMode === "off") return
  const dir = gitPath(repo, "guard-cache")
  const probe = Bun.file(path.join(dir, "coverage-map-opencode.json"))
  if (probe.size > 0 && Date.now() - probe.lastModified < 86_400_000) return
  const slug = originRepo(repo)
  const cmd = [
    "gh",
    "release",
    "download",
    "guard-coverage-map",
    ...(slug ? ["-R", slug] : []),
    "--pattern",
    "coverage-map-*.json",
    "--dir",
    dir,
    "--clobber",
  ]
  const r = Bun.which("gh") ? Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" }) : undefined
  if (r?.exitCode !== 0)
    notes.push("没有取到覆盖率图（gh release download guard-coverage-map），本次按静态依赖图选测试")
}

// ── 选测试：静态依赖图给出计划；覆盖率图可用时以它为准（静态图经测试夹具几乎连到全部测试，单靠它常升级为全量）──
type Plan = {
  pkg: string
  full: boolean
  tests: string[]
  via: string
  runner: "bun" | "script"
  command: string[]
  commands?: string[][]
}

async function planTests(files: string[]) {
  const selection = await staticPlan(files)
  for (const plan of selection.plans) {
    if (plan.runner !== "bun") continue
    const map = gitPath(repo, "guard-cache", `coverage-map-${plan.pkg.split("/").slice(1).join("-")}.json`)
    if (!Bun.file(map).size) continue
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(here, "select-tests.ts"),
        "select",
        plan.pkg,
        "--map",
        map,
        "--files",
        files.join(","),
      ],
      { cwd: repo },
    )
    const pick: { mode?: string; tests?: string[]; unmapped?: string[] } = JSON.parse(result.stdout.toString() || "{}")
    if (result.exitCode !== 0 || !pick.mode || pick.mode === "stale" || pick.unmapped?.length) continue
    plan.full = pick.mode === "full"
    plan.tests = pick.tests ?? []
    plan.via = "覆盖率图"
  }
  return { plans: selection.plans.filter((p) => p.full || p.tests.length), inputs: selection.inputs }
}

async function staticPlan(files: string[]) {
  const cache = gitPath(repo, "guard-cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "affected-"))
  try {
    const out = path.join(dir, "plan.json")
    const r = await step("选测试", `静态依赖图 · ${files.length} 个文件`, [
      "bun",
      path.join(here, "affected.ts"),
      repo,
      "--files",
      files.join(","),
      "--json",
      out,
    ])
    if (r.state !== "ok") return { plans: [] as Plan[], inputs: [] as string[] }
    const result: { plan: (Omit<Plan, "full" | "via"> & { mode: string })[]; inputs: string[] } =
      await Bun.file(out).json()
    return {
      plans: result.plan.map((p) => ({ ...p, full: p.mode === "full", via: "静态依赖图" })),
      inputs: result.inputs,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// bun test --dots：每个通过的用例输出一个点，失败输出 (fail) 行；总数按测试文件里的 test()/it() 估算
const CASE = /^\s*(?:test|it)(?:\.(?:skip|todo|only|if\([^)]*\)|each\([^)]*\)|concurrent|serial|failing))*\s*\(/gm
async function estimateCases(cwd: string, files: string[]) {
  const list = files.length
    ? files
    : await Array.fromAsync(new Bun.Glob("**/*.test.{ts,tsx}").scan({ cwd })).then((all) =>
        all.filter((f) => !f.includes("node_modules")),
      )
  let n = 0
  for (const f of list)
    n += (
      (
        await Bun.file(path.join(cwd, f))
          .text()
          .catch(() => "")
      ).match(CASE) ?? []
    ).length
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
      const failed = fail ? `  ${UI.red(`✗${fail}`)}` : ""
      // 估算偏低（循环生成用例等）时不再画进度条，只计数
      return done < total ? `${UI.bar(done / total)} ${done}/~${total}${failed}` : `${done} 个用例${failed}`
    },
    result: () => `${pass + dots()} 通过${fail ? ` · ${UI.red(`${fail} 失败`)}` : ""}`,
  }
}

// 并行执行：每个测试命令和契约测试各占一个槽位
const LIMIT = Math.max(2, Math.floor(os.availableParallelism() / 2))
async function parallel(jobs: (() => Promise<unknown>)[]) {
  const queue = [...jobs]
  await Promise.all(
    Array.from({ length: Math.min(LIMIT, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job()
    }),
  )
}

// 本地不跑全量（转交 preflight，CI 里照跑；GUARD_TESTS=full 时本地也跑）；返回测试任务和被转交的包
function testJobs(plans: Plan[]) {
  const deferred: string[] = []
  const jobs = plans.flatMap((plan) => {
    const scope = plan.full ? "全量" : `${plan.tests.length} 个文件`
    if (plan.full && !ci && testsMode !== "full") {
      UI.line("skip", "测试", `${plan.pkg} · ${scope}`, "本地不跑全量，转交 preflight")
      deferred.push(plan.pkg)
      return []
    }
    const cwd = path.join(repo, plan.pkg)
    const rel = plan.full ? [] : plan.tests.map((t) => `./${posix(path.relative(cwd, path.join(repo, t)))}`)
    const native = plan.runner === "bun" || plan.commands !== undefined
    return (plan.commands ?? [plan.command]).map((command) => async () =>
      step(
        "测试",
        `${plan.pkg} · ${scope} · ${plan.via}`,
        native ? [...command, "--dots", "--preload", path.join(here, "leak-preload.ts"), ...rel] : command,
        { cwd, progress: native ? testProgress(await estimateCases(cwd, rel)) : undefined },
      ),
    )
  })
  return { jobs, deferred }
}

// 已有契约与打包边界测试：原先不在任何必过任务里
const contractJobs = () =>
  [
    ["schema", "./test"],
    ["protocol", "./test"],
    ["client", "./test/import-boundaries.test.ts"],
    ["sdk-next", "./test/import-boundaries.test.ts"],
  ].map(
    ([pkg, target]) =>
      () =>
        step("契约测试", pkg, ["bun", "test", target], { cwd: path.join(repo, "packages", pkg) }),
  )

// 跨平台 / 全量测试交给 GitHub：同一个 SHA 通过后再 push 即放行
async function preflight(sha: string, base: string, sensitive: string[], deferred: string[]) {
  const mode = process.env.GUARD_PREFLIGHT ?? "auto"
  if (!["off", "auto", "required"].includes(mode)) throw new Error(`未知 preflight 模式：${mode}`)
  const why = [sensitive.length && "平台敏感改动", deferred.length && `测试（${deferred.join("、")}）`]
    .filter(Boolean)
    .join(" + ")
  if (mode === "off") {
    if (!ci) notes.push(`GUARD_PREFLIGHT=off：${why}没有在推送前验证，push 之后由 CI 补测`)
    return
  }
  const platforms = sensitive.length
    ? (process.env.GUARD_PREFLIGHT_PLATFORMS ?? "macos,linux")
    : (process.env.GUARD_PREFLIGHT_FULL_PLATFORMS ?? "linux")
  const r = await step(
    "preflight",
    `${sha.slice(0, 8)} · ${platforms} · ${why}`,
    ["bun", path.join(here, "preflight.ts"), "ensure", "--sha", sha, "--base", base, "--platforms", platforms],
    { states: { 0: "ok", 10: "wait", 3: mode === "required" ? "fail" : "skip" } },
  )
  if (r.state !== "fail") for (const l of r.out.trim().split("\n").filter(Boolean)) UI.sub(l)
  if (r.state === "wait") waiting = "通过后再 push 一次即可，本地不用等"
  if (r.state === "skip")
    notes.push(`gh 不可用，跳过 preflight：${why}交给 push 之后的 CI（GUARD_PREFLIGHT=required 可改为阻断）`)
}

// 会影响测试结果的仓库根配置
const ROOT_INPUT = /^(package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|patches\/)/

async function push() {
  const revision = git(repo, "rev-parse", "--verify", `${flag(args, "--sha") ?? "HEAD"}^{commit}`)
  if (!revision.ok) throw new Error(`无法解析待推送提交：${revision.err}`)
  const sha = revision.out
  const since = flag(args, "--since") ?? `origin/${MAIN_BRANCH}`
  const comparison = git(repo, "rev-parse", "--verify", `${since}^{commit}`)
  if (!comparison.ok) throw new Error(`无法解析比较基准：${comparison.err}`)
  const base = comparison.out
  // 同一个提交、同一个基准只需通过一次
  const stamp = gitPath(repo, "guard", "green", `push-${sha}-${base.slice(0, 12)}`)
  if (await Bun.file(stamp).exists()) {
    UI.line("ok", "push 检查", sha.slice(0, 8), "此前已通过，跳过")
    return
  }
  const diff = git(repo, "diff", "--name-only", "-z", base, sha)
  if (!diff.ok) throw new Error(`无法计算待检改动：${diff.err}`)
  const range = diff.out.split("\0").map(posix).filter(Boolean)
  const testing = testsMode !== "off"
  if (!testing) notes.push("GUARD_TESTS=off：本次没有运行测试与契约，push 之后由 CI 补测")

  // 规则检查、多余防御检查、选测试互不依赖，同时进行
  if (testing) syncMaps()
  const [, , selection] = await Promise.all([
    step("规则检查", `${since}..${sha.slice(0, 8)} · ${range.length} 个文件`, [
      "bun",
      path.join(here, "check.ts"),
      repo,
      "--commit",
      sha,
      "--changed-since",
      base,
    ]),
    unneededGuards(range),
    testing ? planTests(range) : undefined,
  ])

  const deferred: string[] = []
  if (!failures.length && selection) {
    // 测试跑在工作区上：待推送提交就是 HEAD，且测试会加载的包里没有未提交改动时，本地结果才代表这个提交
    // 不经过 git()：它会裁掉首行行首的空格，而那是状态列的一部分
    const status = Bun.spawnSync([
      "git",
      "-C",
      repo,
      "status",
      "--porcelain",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ])
    if (status.exitCode !== 0) throw new Error(`无法检查测试工作区：${status.stderr.toString()}`)
    const pending = status.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => posix(entry.slice(3)))
      .filter((file) => ROOT_INPUT.test(file) || selection.inputs.some((dir) => file.startsWith(dir + "/")))
    const head = git(repo, "rev-parse", "HEAD").out
    if (sha === head && !pending.length) {
      const tests = testJobs(selection.plans)
      deferred.push(...tests.deferred)
      await parallel([...tests.jobs, ...contractJobs()])
    } else {
      const why = sha !== head ? "待推送提交不是当前检出" : `${pending.length} 处未提交改动会被测试加载`
      UI.line("wait", "工作区", why, "测试交给 preflight")
      if (pending.length)
        notes.push(`测试会加载这些未提交的改动，本地结果不能代表待推送提交：\n${pending.slice(0, 20).join("\n")}`)
      deferred.push("提交快照的测试与契约")
    }
  }
  const sensitive = range.filter((f) => PLATFORM_SENSITIVE.some((re) => re.test(f)))
  if (!failures.length && (sensitive.length || deferred.length)) await preflight(sha, base, sensitive, deferred)
  if (!failures.length && !waiting) {
    mkdirSync(path.dirname(stamp), { recursive: true })
    writeFileSync(stamp, new Date().toISOString())
  }
}

async function main() {
  if (tier === "commit") {
    const message = flag(args, "--message")
    await step("规则检查", "暂存区", [
      "bun",
      path.join(here, "check.ts"),
      repo,
      "--staged",
      ...(message ? ["--message", message] : []),
    ])
  } else if (tier === "stop") {
    const files = (flag(args, "--files") ?? "").split(",").map(posix).filter(Boolean)
    if (!files.length) return 0
    const [, , selection] = await Promise.all([
      step("规则检查", `本会话 ${files.length} 个文件`, [
        "bun",
        path.join(here, "check.ts"),
        repo,
        "--files",
        files.join(","),
      ]),
      unneededGuards(files),
      testsMode === "off" ? undefined : planTests(files),
    ])
    if (!failures.length && selection) {
      const tests = testJobs(selection.plans)
      await parallel(tests.jobs)
      if (tests.deferred.length)
        notes.push(`${tests.deferred.join("、")} 需要全量测试，留到 push 时由 preflight 在线上运行`)
    }
  } else if (tier === "push") {
    await push()
  } else if (tier === "contracts") {
    await parallel(contractJobs())
  } else {
    console.error(`未知层级：${tier}（可选 commit | stop | push | contracts）`)
    return 2
  }

  for (const n of notes) UI.note(n)
  for (const f of failures) {
    UI.section(f.title)
    UI.raw(f.out.trim().slice(-8000))
    UI.raw(UI.dim(`完整日志：${f.log}`))
  }
  if (tier === "push" || failures.length || waiting) {
    const ms = performance.now() - started
    if (failures.length) UI.line("fail", `未通过（${failures.length} 项）`, "", "", ms)
    else if (waiting) UI.line("wait", "等待 preflight", waiting)
    else UI.line("ok", "全部通过", "", "", ms)
  }
  return failures.length || waiting ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(await main())
  } catch (error) {
    console.error(`[gate] 执行异常：${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}
