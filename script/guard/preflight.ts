#!/usr/bin/env bun
// 跨平台预检：把一个提交（默认 HEAD）交给 GitHub 在 macOS / Linux / Windows 上跑选中的测试。
// 本地不切分支、不改工作区；远端临时分支 preflight/<sha> 由 workflow 结束时自动删除。结果按 SHA 记录。
//
//   bun script/guard/preflight.ts ensure [--sha HEAD] [--platforms …]   已通过 → 0；未开始则启动、或运行中 → 10；失败 → 1 + 日志
//   bun script/guard/preflight.ts start  [--sha HEAD] [--platforms macos,linux]
//   bun script/guard/preflight.ts status [--sha HEAD]
//   bun script/guard/preflight.ts wait   [--sha HEAD]   阻塞等待（手动使用）
// 退出码 3 = gh 不可用；10 = 等待中（gate 据此拒绝本次 push，但不当作失败）。平台默认取 GUARD_PREFLIGHT_PLATFORMS，未设置时为 macos,linux。
import path from "node:path"
import { git, flag, originRepo } from "./lib"

const args = process.argv.slice(2)
const cmd = args[0] ?? "ensure"
const repo = git(process.cwd(), "rev-parse", "--show-toplevel").out || process.cwd()
const sha = git(repo, "rev-parse", flag(args, "--sha") ?? "HEAD").out
const branch = `preflight/${sha.slice(0, 12)}`
const platforms = flag(args, "--platforms") ?? process.env.GUARD_PREFLIGHT_PLATFORMS ?? "macos,linux"
const stamp = Bun.file(path.join(repo, ".git", "guard", "preflight", sha))

const slug = originRepo(repo)
const R = slug ? ["-R", slug] : []

function gh(...a: string[]) {
  const p = Bun.spawnSync(["gh", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

if (!Bun.which("gh") || !gh("auth", "status").ok) {
  console.log("gh 未安装或未登录，无法运行 preflight。")
  process.exit(3)
}

type Run = { databaseId: number; status: string; conclusion: string; event: string; url: string; createdAt: string }
function runs(): Run[] {
  const r = gh("run", "list", ...R, "--workflow", "guard.yml", "--commit", sha, "--limit", "20", "--json", "databaseId,status,conclusion,event,url,createdAt")
  return r.ok ? JSON.parse(r.out || "[]") : []
}
// 只认手动触发（workflow_dispatch）的 guard 运行：PR / push 触发的那次不跑跨平台测试，不能当作 preflight 通过
function state() {
  const list = runs().filter((r) => r.event === "workflow_dispatch")
  const green = list.find((r) => r.conclusion === "success")
  if (green) return { kind: "green" as const, run: green }
  const active = list.find((r) => r.status !== "completed")
  if (active) return { kind: "running" as const, run: active }
  const failed = list.find((r) => r.status === "completed")
  if (failed) return { kind: "failed" as const, run: failed }
  return { kind: "none" as const }
}

function start() {
  const push = git(repo, "push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`)
  if (!push.ok) throw new Error(`推送 ${branch} 失败：${push.err}`)
  const r = gh("workflow", "run", ...R, "guard.yml", "--ref", branch, "-f", "mode=preflight", "-f", `platforms=${platforms}`)
  // 触发失败时把刚推上去的临时分支删掉，不在远端留垃圾
  if (!r.ok) git(repo, "push", "--no-verify", "origin", "--delete", branch)
  // GitHub 只认默认分支上的 workflow 文件：guard.yml 还没合进默认分支时无法手动触发
  if (!r.ok && /not found on the default branch/.test(r.err))
    throw new Error(`${slug ?? "仓库"} 的默认分支上还没有 .github/workflows/guard.yml，无法触发 preflight。首次接入这次 push 请用 GUARD_PREFLIGHT=off，guard.yml 进入默认分支后即可使用。`)
  if (!r.ok) throw new Error(`触发 guard.yml 失败：${r.err}`)
  console.log(`已启动：分支 ${branch} · 平台 ${platforms}`)
}

async function report(s: ReturnType<typeof state>) {
  if (s.kind === "green") {
    await Bun.write(stamp, String(s.run.databaseId))
    console.log(`已通过：${s.run.url}`)
    return 0
  }
  if (s.kind === "running") {
    console.log(`运行中：${s.run.url}`)
    return 10
  }
  if (s.kind === "failed") {
    console.log(`失败：${s.run.url}\n${gh("run", "view", ...R, String(s.run.databaseId), "--log-failed").out.slice(-12000)}`)
    console.log("\n修复后提交新的 commit 再 push；如需对同一提交重跑：bun script/guard/preflight.ts start")
    return 1
  }
  return -1
}

try {
  if (await stamp.exists() && cmd !== "start") {
    console.log(`已通过（本地记录）`)
    process.exit(0)
  }
  if (cmd === "start") {
    start()
    process.exit(0)
  }
  if (cmd === "status") process.exit(Math.max(0, await report(state())))
  if (cmd === "wait") {
    for (;;) {
      const s = state()
      if (s.kind === "none") throw new Error("该提交没有 preflight 运行，先执行 start")
      if (s.kind !== "running") process.exit(await report(s))
      console.log(`等待中…`)
      await Bun.sleep(20_000)
    }
  }
  // ensure
  const s = state()
  if (s.kind === "none") {
    start()
    console.log("查看进度：bun script/guard/preflight.ts status")
    process.exit(10)
  }
  process.exit(await report(s))
} catch (e) {
  console.error(`[preflight] ${e instanceof Error ? e.message : e}`)
  process.exit(2)
}
