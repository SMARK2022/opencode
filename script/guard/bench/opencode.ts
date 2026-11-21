#!/usr/bin/env bun
// OpenCode 日常操作端到端基准：base 与 head 在同一台机器上交替运行并比较。
//
//   bun script/guard/bench/opencode.ts                         head=工作区，base=与 origin/dev1-smark 的 merge-base
//   bun script/guard/bench/opencode.ts --head <sha> --base <sha>   任意两个提交（历史回测）
//   选项：--rounds 15  --only list,stream 或 --group basic  --sessions 2000  --turns 40  --tokens 20000
//         --json out.json  --markdown out.md（可指向 $GITHUB_STEP_SUMMARY）
// 退出码：0 无退化；1 有退化；2 执行异常（例如旧提交缺少场景所需接口）。
import path from "node:path"
import os from "node:os"
import { cpSync, mkdtempSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import {
  abRun,
  runOnce,
  judge,
  median,
  stopTarget,
  waitHealthy,
  validateRounds,
  METRICS,
  type Target,
} from "./harness"
import { GROUPS, SCENARIO_BUDGETS } from "./budgets"
import { guardPlan } from "../affected-rules"
import { assertReply } from "./protocol"
import { renderBenchMarkdown, type BenchResult } from "../report"
import { editFiles, lastUser, original, populate, relative, scripted } from "./workload"
import { runTui } from "./tui"
import { listening, valueOf, type Measurement, type Scenario } from "./harness"

type ToolMessage = {
  info: { id: string; role: string; summary?: boolean; error?: unknown }
  parts: { type: string; text?: string; tool?: string; state?: { status: string } }[]
}
async function main() {
  const args = process.argv.slice(2)
  const opt = (n: string, d?: string) => {
    const i = args.indexOf(n)
    return i === -1 ? d : args[i + 1]
  }
  const git = (...a: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...a])
    if (!result.success) throw new Error(result.stderr.toString().trim() || "Git 查询失败")
    return result.stdout.toString().trim()
  }
  const repo = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim()
  const rounds = Number(opt("--rounds", "15"))
  const only = (opt("--only", "") ?? "").split(",").filter(Boolean)
  const sessions = Number(opt("--sessions", "2000"))
  const turns = Number(opt("--turns", "40"))
  const TOKENS = Number(opt("--tokens", "20000"))

  try {
    validateRounds(rounds)
    for (const [name, value] of [
      ["sessions", sessions],
      ["turns", turns],
      ["tokens", TOKENS],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} 必须为正整数`)
    if (args.includes("--group")) {
      const group = opt("--group")
      if (!group || !Object.hasOwn(GROUPS, group)) throw new Error("未知基准分组：" + group)
      if (args.includes("--only")) throw new Error("--group 和 --only 不能同时指定")
      only.push(...Object.keys(GROUPS[group]))
    }
    if (args.includes("--only") && (!only.length || only.some((name) => !Object.hasOwn(SCENARIO_BUDGETS, name))))
      throw new Error("--only 包含未知场景或为空")
  } catch (e) {
    console.error(`[bench] ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  const commitInfo = (ref: string) => {
    const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)
    const [sha, date, ...subject] = git("show", "-s", "--format=%H%x00%cI%x00%s", commit).split("\0")
    return { sha, date, subject: subject.join(" ") }
  }

  // 缓存源码工作树；每次确认依赖完整，安装失败后的目录仍可重试。
  async function worktreeFor(sha: string, side: string) {
    const dir = path.join(os.tmpdir(), `opencode-bench-${side}-${sha.slice(0, 12)}`)
    if (!(await Bun.file(path.join(dir, "package.json")).exists())) {
      console.log(`[bench] 准备 ${sha.slice(0, 8)} 的工作树…`)
      const created = Bun.spawnSync(["git", "-C", repo, "worktree", "add", "--force", "--detach", dir, sha], {
        stdout: "inherit",
        stderr: "inherit",
      })
      if (!created.success) throw new Error(`${sha.slice(0, 8)} 工作树创建失败`)
    }
    const revision = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"])
    const changes = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"])
    if (!revision.success || revision.stdout.toString().trim() !== sha || !changes.success || changes.stdout.length)
      throw new Error(`${sha.slice(0, 8)} 缓存工作树与被测提交不一致`)
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, HUSKY: "0" },
    })
    if (!install.success) throw new Error(`${sha.slice(0, 8)} 依赖安装失败`)
    return dir
  }

  const headRef = opt("--head")
  const info = commitInfo(headRef ?? "HEAD")
  const head = headRef ? info : { ...info, subject: `工作区（基于 ${info.sha.slice(0, 8)}）` }
  const base = commitInfo(opt("--base") ?? git("merge-base", "origin/dev1-smark", "HEAD"))
  const headDir = headRef ? await worktreeFor(head.sha, "head") : repo
  const baseDir = await worktreeFor(base.sha, "base")

  // ── 模拟 LLM：OpenAI 兼容 SSE，预热和正式轮固定速率，两边输入完全一致；每 token 1 字节，正文须低于 processor 的 64 KiB 上限 ──
  let paced = false
  let streamStarts = 0
  let activeStreams = 0
  let compacting = false
  let received = 0
  let sent = 0
  const phasePrompt = "bench:timed"
  let timedRequests = 0
  let tuiProgress = -1
  const llm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "GET" && new URL(req.url).pathname === "/bench/progress") return Response.json(tuiProgress)
      const body = await req.json() as { messages: Parameters<typeof lastUser>[0]; tools?: unknown[] }
      const user = lastUser(body.messages)
      const timed = user.includes(phasePrompt) && !!body.tools?.length
      if (timed) {
        received = performance.now()
        timedRequests++
      }
      const reply = scripted(body.messages, workspace, compacting)
      if (reply) return reply
      const chunks = Array.from({ length: Math.ceil(TOKENS / 20) }, (_, i) =>
        "x".repeat(Math.min(20, TOKENS - i * 20)),
      )
      // 在长回复的尾部留下可见标记，不靠在视口外搜索最后一条用户消息。
      const turn = user.match(/turn (\d+)$/)?.[1]
      const marker = turn === undefined ? "" : `tail-${turn}`
      if (marker && chunks.at(-1)!.length >= marker.length) chunks[chunks.length - 1] = chunks.at(-1)!.slice(marker.length) + marker
      streamStarts++
      activeStreams++
      let index = 0
      const stream = new ReadableStream({
        async pull(c) {
          if (index < chunks.length) {
            c.enqueue(
              `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunks[index++] } }] })}\n\n`,
            )
            if (paced) await Bun.sleep(1)
            if (user.includes("bench:tui-live")) tuiProgress = index / chunks.length
            return
          }
          c.enqueue(
            `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: TOKENS } })}\n\n`,
          )
          c.enqueue("data: [DONE]\n\n")
          c.close()
          if (timed) sent = performance.now()
          if (user.includes("bench:tui-live")) tuiProgress = -1
          activeStreams--
        },
        cancel() {
          activeStreams--
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })

  const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-ws-"))
  const cache = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-cache-"))
  const temporary = new Set([workspace, cache])
  const config = path.join(workspace, "opencode.json")
  await Bun.write(
    config,
    JSON.stringify({
      model: "bench/mock",
      permission: { edit: "allow", read: "allow", grep: "allow", bash: "deny" },
      provider: {
        bench: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${llm.port}/v1`, apiKey: "x" },
          models: { mock: { limit: { context: 2_000_000, output: 32_000 } } },
        },
      },
      autoupdate: false,
      share: "disabled",
    }),
  )

  type Side = Target & { root: string; workspace: string; home: string }
  const target = (label: string, root: string): Side => ({
    root, workspace, home: "",
    label,
    healthPath: "/global/health",
    start() {
      const home = this.home
      return Bun.spawn(
        [
          "bun",
          "run",
          "--cwd",
          path.join(root, "packages/opencode"),
          "src/index.ts",
          "serve",
          "--port",
          "0",
          "--hostname",
          "127.0.0.1",
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            OPENCODE_CONFIG: config,
            XDG_DATA_HOME: home,
            XDG_STATE_HOME: home,
            XDG_CACHE_HOME: path.join(cache, label),
            XDG_CONFIG_HOME: home,
            OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
          },
          stdout: "pipe",
          stderr: "inherit",
        },
      )
    },
  })

  const q = `?directory=${encodeURIComponent(workspace)}`
  async function call(method: string, base: string, p: string, body?: unknown) {
    const r = await fetch(base + p + q, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status}`)
    return r.json()
  }

  // ── 场景：每个都是用户每天会做的事 ──
  const prompt = (base: string, id: string, text: string) =>
    call("POST", base, `/session/${id}/message`, { parts: [{ type: "text", text }] })
  let long: { id: string; title: string }
  const timedTurn = async (base: string, id: string) => {
    timedRequests = 0
    sent = 0
    const start = performance.now()
    const reply = await prompt(base, id, phasePrompt)
    const end = performance.now()
    assertReply(reply)
    if (timedRequests !== 1 || sent < received) throw new Error("无法定位本轮模型请求的起止点")
    return { prepMs: received - start, finishMs: end - sent }
  }
  const SCENARIOS: Record<string, Scenario<Side>> = {
    // 打开会话选择框
    list: async (base) => {
      for (let i = 0; i < 20; i++) await call("GET", base, "/session")
    },
    // 进入一个已有长对话的会话
    open: async (base) => {
      const list = (await call("GET", base, "/session")) as { id: string }[]
      if (!list.length) throw new Error("open 场景缺少种子会话")
      for (const s of list.slice(0, 10)) {
        const messages: unknown = await call("GET", base, `/session/${s.id}/message`)
        if (!Array.isArray(messages) || messages.length < turns * 2) throw new Error("open 场景未读取到种子长对话")
      }
    },
    // 等待一次长回复流式完成：墙钟扣除模拟 LLM 自身耗时后即为 opencode 的开销
    stream: async (base) => {
      const s = (await call("POST", base, "/session", { title: "bench stream" })) as { id: string }
      return timedTurn(base, s.id)
    },
    // 流式输出中途按 Esc
    abort: async (base) => {
      const s = (await call("POST", base, "/session", { title: "bench abort" })) as { id: string }
      const started = streamStarts
      let finished = false
      const pending = call("POST", base, `/session/${s.id}/message`, { parts: [{ type: "text", text: "go" }] }).then(
        (value) => {
          finished = true
          return { value }
        },
        (error: unknown) => {
          finished = true
          return { error }
        },
      )
      const deadline = performance.now() + 10_000
      while (streamStarts === started && !finished && performance.now() < deadline) await Bun.sleep(10)
      if (streamStarts === started || !activeStreams || finished) throw new Error("abort 场景未进入活动的模型流")
      await call("POST", base, `/session/${s.id}/abort`, {})
      const outcome = await pending
      if ("error" in outcome) throw outcome.error
      assertReply(outcome.value, true)
    },
    continue: (base) => timedTurn(base, long.id),
    tools: async (base) => {
      const s = await call("POST", base, "/session", { title: "bench tools" }) as { id: string }
      assertReply(await prompt(base, s.id, "bench:tools"))
      const messages = await call("GET", base, `/session/${s.id}/message`) as ToolMessage[]
      const parts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
      if (parts.map((p) => p.tool).join() !== "grep,read" || parts.some((p) => p.state?.status !== "completed"))
        throw new Error("grep/read 工具链未完成")
    },
    compact: async (base) => {
      compacting = true
      const start = performance.now()
      try {
        await call("POST", base, `/session/${long.id}/summarize`, { providerID: "bench", modelID: "mock", auto: false })
      } finally {
        compacting = false
      }
      const compactMs = performance.now() - start
      const messages = await call("GET", base, `/session/${long.id}/message`) as ToolMessage[]
      if (!messages.some((m) => m.info.summary && !m.info.error && m.parts.some((p) => p.text?.includes("Bench summary."))))
        throw new Error("未找到本次压缩摘要")
      return { compactMs }
    },
    revert: async (base, side) => {
      const s = await call("POST", base, "/session", { title: "bench revert" }) as { id: string }
      const url = `/session/${s.id}`
      const files = [0, 10, 19]
      const check = async (edited: boolean) => {
        for (const i of files) {
          const text = await Bun.file(path.join(side.workspace, relative(i))).text()
          if (text !== (edited ? "edited" : original(i))) throw new Error(`revert 文件不匹配：${relative(i)}`)
        }
      }
      const start = performance.now()
      assertReply(await prompt(base, s.id, "bench:edit"))
      const editTurnMs = performance.now() - start
      const messages = await call("GET", base, url + "/message") as ToolMessage[]
      const tools = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")
      if (tools.length !== editFiles.length || tools.some((p) => p.tool !== "write" || p.state?.status !== "completed"))
        throw new Error("20 次文件写入没有全部完成")
      await check(true)
      const messageID = messages.find((m) => m.info.role === "user")!.info.id
      const undo = performance.now()
      await call("POST", base, url + "/revert", { messageID })
      const revertMs = performance.now() - undo
      await check(false)
      const redo = performance.now()
      await call("POST", base, url + "/unrevert")
      const unrevertMs = performance.now() - redo
      await check(true)
      return { editTurnMs, revertMs, unrevertMs }
    },
    tui: (base, side) => runTui(base, side.root, side.workspace, long, turns, `http://127.0.0.1:${llm.port}/bench/progress`),
  }

  // 种子会话由 base 创建一次。base、head 再分别打开副本，确保两边都已完成数据库迁移。
  // 正式轮从各自的模板启动，startupMs 衡量日常启动耗时，不重复计算一次性迁移。
  const missing: Record<string, Set<string>> = {}
  async function seed(t: Side, source?: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-seed-"))
    temporary.add(dir)
    if (source) cpSync(source, dir, { recursive: true })

    t.home = dir
    const proc = t.start()
    try {
      const url = await listening(proc, 120_000)
      await waitHealthy(url + t.healthPath, 120_000, proc)
      if (source) {
        await call("GET", url, "/session")
        const doc = await call("GET", url, "/doc") as { paths: Record<string, { post?: unknown }> }
        const absent = missing[t.label] = new Set<string>()
        for (const [name, operations] of Object.entries({ compact: ["summarize"], revert: ["revert", "unrevert"] }))
          if (operations.some((op) => !Object.entries(doc.paths).some(([p, methods]) => p.endsWith(`/{sessionID}/${op}`) && methods.post))) absent.add(name)
        if (!(await Bun.file(path.join(t.root, "packages/tui/test/fixture/tui-runtime.ts")).exists())) absent.add("tui")
        return dir
      }

      for (let i = 0; i < sessions; i++) {
        const s = (await call("POST", url, "/session", { title: `bench ${i}` })) as { id: string }
        if (i === sessions - 1) long = { id: s.id, title: `bench ${i}` }
        if (i >= Math.max(0, sessions - 10))
          for (let k = 0; k < turns; k++)
            assertReply(
              await call("POST", url, `/session/${s.id}/message`, { parts: [{ type: "text", text: `turn ${k}` }] }),
            )
      }
    } finally {
      await stopTarget(proc)
    }
    return dir
  }

  const result: BenchResult = {
    kind: "bench",
    head,
    base,
    rounds,
    createdAt: new Date().toISOString(),
    runner: { os: `${os.platform()}-${os.arch()}`, cpus: os.cpus().length, ci: !!process.env.GITHUB_ACTIONS },
    runUrl: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
    scenarios: {},
    regressed: false,
  }

  let exit = 0
  try {
    populate(workspace)
    const seedDir = await seed(target("seed", baseDir))
    const templates: Record<string, string> = {
      base: await seed(target("base", baseDir), seedDir),
      head: await seed(target("head", headDir), seedDir),
    }
    paced = true

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (only.length && !only.includes(name)) continue
      const fresh = (t: Side): Side => ({
        ...t,
        prepare() {
          const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-bench-run-"))
          temporary.add(dir)
          cpSync(templates[t.label], dir, { recursive: true })
          this.home = dir
        },
        async release() {
          if (name === "revert") {
            const git = Bun.spawnSync(["git", "-C", workspace, "restore", "--source=HEAD", "--worktree", "--", ...editFiles])
            if (!git.success) throw new Error(`恢复基准工作区失败：${git.stderr.toString().trim()}`)
          }
          const dir = this.home
          await rm(dir, { recursive: true, force: true })
          temporary.delete(dir)
        },
      })
      console.log(`[bench] ${name}：预热 1 轮，正式 ${rounds} 轮 × 2`)
      // 首次运行承担磁盘缓存、转译缓存等冷启动开销，两边各空跑一轮再计数
      if (missing.head.has(name)) throw new Error(`head 缺少 ${name} 接口`)
      const a = fresh(target("base", baseDir))
      const b = fresh(target("head", headDir))
      for (const t of missing.base.has(name) ? [b] : [a, b]) {
        const sample = await runOnce(t, scenario)
        if (sample.error !== undefined) throw new Error(`${name} ${t.label} 预热失败：${sample.error}`)
      }
      if (missing.base.has(name)) {
        (result.unavailable ??= {})[name] = "base 缺少所需接口；head 已完成预热"
        continue
      }
      const budgets = SCENARIO_BUDGETS[name]
      const res = await abRun(a, b, scenario, rounds)
      let verdict = judge(res.head, res.base, budgets)
      if (verdict.some((v) => v.regressed) && !verdict.some((v) => v.metric === "crashed" && v.regressed)) {
        const again = await abRun(a, b, scenario, rounds, rounds)
        res.base.push(...again.base)
        res.head.push(...again.head)
        verdict = judge(res.head, res.base, budgets)
      }
      for (const [label, samples] of Object.entries(res)) {
        for (const metric of ["startupMs", "wallMs"] as const)
          console.log(`[bench] ${name} ${label} ${metric}: ${samples.map((s) => Math.round(s[metric])).join(", ")}`)
      }
      const med = (xs: Measurement[]) => {
        const keys = [...METRICS, ...Object.keys(xs.find((s) => s.extra)?.extra ?? {})]
        return Object.fromEntries(keys.map((key) => [key, median(xs.filter((s) => !s.crashed).map((s) => valueOf(s, key)))]))
      }
      result.scenarios[name] = {
        verdict,
        pairs: res.head.length,
        headMedians: med(res.head),
        baseMedians: med(res.base),
        errors: [...res.head, ...res.base]
          .map((s) => s.error)
          .filter((e): e is string => !!e)
          .slice(0, 5),
      }
      if (verdict.some((v) => v.regressed)) result.regressed = true
      console.table(verdict)
    }
    if (!Object.keys(result.scenarios).length && !Object.keys(result.unavailable ?? {}).length) throw new Error("没有执行基准")
    // 两个提交之间没有运行时代码改动时，差异只能来自环境：只记录，不判定退化
    const changed = git("diff", "--name-only", base.sha, ...(headRef ? [head.sha] : [])).split("\n")
    if (
      !(headRef && head.sha === base.sha) &&
      !guardPlan(changed, repo).bench &&
      !Object.values(result.scenarios).some((s) => s.verdict.some((v) => v.metric === "crashed" && v.regressed))
    ) {
      result.note = "两个提交之间没有运行时代码改动，只记录数据，不判定退化"
      result.regressed = false
      for (const s of Object.values(result.scenarios)) for (const v of s.verdict) v.regressed = false
    }
    exit = result.regressed ? 1 : 0
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    console.error(`[bench] ${result.error}`)
    exit = 2
  } finally {
    llm.stop(true)
    await Promise.all([...temporary].map((dir) => rm(dir, { recursive: true, force: true })))
  }

  const json = opt("--json")
  if (json) await Bun.write(json, JSON.stringify(result, null, 1))
  const md = opt("--markdown")
  if (md) {
    const prev = (await Bun.file(md).exists()) ? await Bun.file(md).text() : ""
    await Bun.write(md, prev + renderBenchMarkdown(result))
  }
  process.exit(exit)
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(`[bench] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
