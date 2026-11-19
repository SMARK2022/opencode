#!/usr/bin/env bun
// OpenCode 日常操作端到端基准：base 与 head 在同一台机器上交替运行并比较。
//
//   bun script/guard/bench/opencode.ts                         head=工作区，base=与 origin/dev1-smark 的 merge-base
//   bun script/guard/bench/opencode.ts --head <sha> --base <sha>   任意两个提交（历史回测）
//   选项：--rounds 7  --only list,stream  --sessions 2000  --turns 40  --tokens 20000
//         --json out.json  --markdown out.md（可指向 $GITHUB_STEP_SUMMARY）
// 退出码：0 无退化；1 有退化；2 执行异常（例如旧提交缺少场景所需接口）。
import path from "node:path"
import os from "node:os"
import { mkdtemp } from "node:fs/promises"
import { abRun, judge, median, waitHealthy, METRICS, type Target, type Sample, type Verdict } from "./harness"
import { SCENARIO_BUDGETS } from "./budgets"
import { renderBenchMarkdown, type BenchResult } from "../report"

const args = process.argv.slice(2)
const opt = (n: string, d?: string) => {
  const i = args.indexOf(n)
  return i === -1 ? d : args[i + 1]
}
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a]).stdout.toString().trim()
const repo = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim()
const rounds = Number(opt("--rounds", "7"))
const only = (opt("--only", "") ?? "").split(",").filter(Boolean)

const commitInfo = (ref: string) => {
  const [sha, date, ...subject] = git("show", "-s", "--format=%H%x00%cI%x00%s", ref).split("\0")
  return { sha, date, subject: subject.join(" ") }
}

// 每个被测提交一个缓存工作树，只在第一次安装依赖
function worktreeFor(sha: string) {
  const dir = path.join(os.tmpdir(), `opencode-bench-${sha.slice(0, 12)}`)
  if (!Bun.spawnSync(["test", "-f", path.join(dir, "package.json")]).success) {
    console.log(`[bench] 准备 ${sha.slice(0, 8)} 的工作树…`)
    Bun.spawnSync(["git", "-C", repo, "worktree", "add", "--force", "--detach", dir, sha], { stdout: "inherit", stderr: "inherit" })
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: dir, stdout: "inherit", stderr: "inherit", env: { ...process.env, HUSKY: "0" } })
    if (install.exitCode !== 0) throw new Error(`${sha.slice(0, 8)} 依赖安装失败`)
  }
  return dir
}

const headRef = opt("--head")
const head = headRef ? commitInfo(headRef) : { ...commitInfo("HEAD"), sha: commitInfo("HEAD").sha, subject: `工作区（基于 ${commitInfo("HEAD").sha.slice(0, 8)}）` }
const base = commitInfo(opt("--base") ?? git("merge-base", "origin/dev1-smark", "HEAD"))
const headDir = headRef ? worktreeFor(head.sha) : repo
const baseDir = worktreeFor(base.sha)

// ── 模拟 LLM：OpenAI 兼容 SSE，固定速率，两边输入完全一致 ──
const TOKENS = Number(opt("--tokens", "20000"))
const llm = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.json().catch(() => ({}))
    const chunks = Array.from({ length: TOKENS / 20 }, (_, i) => `tok${i} `.repeat(20))
    const stream = new ReadableStream({
      async start(c) {
        for (const text of chunks) {
          c.enqueue(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] })}\n\n`)
          await Bun.sleep(1)
        }
        c.enqueue(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: TOKENS } })}\n\n`)
        c.enqueue("data: [DONE]\n\n")
        c.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})

const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-ws-"))
const config = path.join(workspace, "opencode.json")
await Bun.write(
  config,
  JSON.stringify({
    model: "bench/mock",
    provider: { bench: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${llm.port}/v1`, apiKey: "x" }, models: { mock: {} } } },
    autoupdate: false,
    share: "disabled",
  }),
)

const dirs = new Map<number, string>()
const target = (label: string, root: string): Target => ({
  label,
  healthPath: "/global/health",
  start: (port) => {
    const home = dirs.get(port)!
    return Bun.spawn(["bun", "run", "--cwd", path.join(root, "packages/opencode"), "src/index.ts", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env: { ...process.env, OPENCODE_CONFIG: config, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: path.join(os.tmpdir(), "opencode-bench-cache"), XDG_CONFIG_HOME: home, OPENCODE_DISABLE_LSP_DOWNLOAD: "true" },
      stdout: "ignore",
      stderr: "ignore",
    })
  },
})

const q = `?directory=${encodeURIComponent(workspace)}`
async function call(method: string, base: string, p: string, body?: unknown) {
  const r = await fetch(base + p + q, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${method} ${p} → HTTP ${r.status}`)
  return r.json()
}

// ── 场景：每个都是用户每天会做的事 ──
const SCENARIOS: Record<string, (base: string) => Promise<void>> = {
  // 打开会话选择框
  list: async (base) => {
    for (let i = 0; i < 20; i++) await call("GET", base, "/session")
  },
  // 进入一个已有长对话的会话
  open: async (base) => {
    const list = (await call("GET", base, "/session")) as { id: string }[]
    for (const s of list.slice(0, 10)) await call("GET", base, `/session/${s.id}/message`)
  },
  // 等待一次长回复流式完成：墙钟扣除模拟 LLM 自身耗时后即为 opencode 的开销
  stream: async (base) => {
    const s = (await call("POST", base, "/session", {})) as { id: string }
    await call("POST", base, `/session/${s.id}/message`, { parts: [{ type: "text", text: "go" }] })
  },
  // 流式输出中途按 Esc
  abort: async (base) => {
    const s = (await call("POST", base, "/session", {})) as { id: string }
    const pending = call("POST", base, `/session/${s.id}/message`, { parts: [{ type: "text", text: "go" }] }).catch(() => undefined)
    await Bun.sleep(300)
    await call("POST", base, `/session/${s.id}/abort`, {})
    await pending
  },
}

// 种子数据由 base 代码生成一次；head 启动时自行迁移（迁移耗时计入 startupMs，不计入场景）
async function seed(sessions: number, turns: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-seed-"))
  const port = 40000 + Math.floor(Math.random() * 10000)
  dirs.set(port, dir)
  const t = target("seed", baseDir)
  const proc = t.start(port)
  const url = `http://127.0.0.1:${port}`
  try {
    await waitHealthy(url + t.healthPath, 120_000, proc)
    for (let i = 0; i < sessions; i++) {
      const s = (await call("POST", url, "/session", { title: `bench ${i}` })) as { id: string }
      if (i < 10) for (let k = 0; k < turns; k++) await call("POST", url, `/session/${s.id}/message`, { parts: [{ type: "text", text: `turn ${k}` }] })
    }
  } finally {
    proc.kill()
    await proc.exited
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
  runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
  scenarios: {},
  regressed: false,
}

let exit = 0
try {
  const template = await seed(Number(opt("--sessions", "2000")), Number(opt("--turns", "40")))
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue
    const fresh = (t: Target): Target => ({
      ...t,
      start: (port) => {
        const dir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim()
        Bun.spawnSync(["cp", "-r", template + "/.", dir])
        dirs.set(port, dir)
        return t.start(port)
      },
    })
    console.log(`[bench] ${name}：${rounds} 轮 × 2`)
    const res = await abRun(fresh(target("base", baseDir)), fresh(target("head", headDir)), scenario, rounds)
    const verdict: Verdict[] = judge(res.head, res.base, SCENARIO_BUDGETS[name] ?? SCENARIO_BUDGETS.default)
    const med = (xs: Sample[]) => Object.fromEntries(METRICS.map((m) => [m, median(xs.map((s) => s[m]))]))
    result.scenarios[name] = {
      verdict,
      headMedians: med(res.head),
      baseMedians: med(res.base),
      errors: [...res.head, ...res.base].map((s) => s.error).filter((e): e is string => !!e).slice(0, 5),
    }
    if (verdict.some((v) => v.regressed)) result.regressed = true
    console.table(verdict)
  }
  exit = result.regressed ? 1 : 0
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e)
  console.error(`[bench] ${result.error}`)
  exit = 2
} finally {
  llm.stop(true)
}

const json = opt("--json")
if (json) await Bun.write(json, JSON.stringify(result, null, 1))
const md = opt("--markdown")
if (md) {
  const prev = (await Bun.file(md).exists()) ? await Bun.file(md).text() : ""
  await Bun.write(md, prev + renderBenchMarkdown(result))
}
process.exit(exit)
