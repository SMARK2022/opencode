#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"

// Release 页脚与 commit 链接的仓库前缀：CI 内由 GITHUB_REPOSITORY 提供，本地预览回落到 fork 主仓。
const repo = process.env.GITHUB_REPOSITORY ?? "SMARK2022/opencode"
// 类型目录同时是统计输出的固定顺序——新增类型必须同步插入此处，避免 stats 段落顺序抖动。
const kinds = ["feat", "fix", "perf", "refactor", "test", "docs", "chore", "ci", "style", "revert", "other"]

// 三参数最小接口与 workflow 步骤一一对应；多余参数留给未来扩展而不放宽校验。
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", short: "v" },
    // output 默认值与 workflow 步骤的 --output 参数保持同一约定，单独运行也能产出同名文件。
    output: { type: "string", short: "o", default: "release-notes.md" },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  // help 分支先于版本校验退出，便于在 CI 上快速自查调用方式而不触发缺参报错。
  console.log(`
Usage: bun script/release-notes.ts [options]

Generates release-notes.md for the SMARK CLI GitHub Release.

Options:
  -v, --version <version>   Release version (required, e.g. 1.15.13-smark)
  -o, --output <file>       Output file (default: release-notes.md)
  -h, --help                Show this help message
`)
  process.exit(0)
}

// 接受 v 前缀是为了与 workflow 传入的 tag 形态兼容；内部统一用无前缀版本串拼 tag。
const version = (values.version ?? "").replace(/^v/, "")
if (!version) throw new Error("Missing --version, e.g. bun script/release-notes.ts --version 1.15.13-smark")

const tag = `v${version}`
// CI 外运行时用 HEAD 兜底，保证页脚“自动构建于”始终指向真实构建提交。
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

type Entry = {
  // hash 保留完整 40 位：commit 链接需要全长度 SHA，短 hash 只在展示层截断。
  hash: string
  subject: string
}

function kind(subject: string) {
  // 只识别 conventional commit 首段类型；scope 与 breaking 标记不影响分类。
  const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:/)
  const name = match?.[1]?.toLowerCase() ?? ""
  return kinds.includes(name) ? name : "other"
}

async function log(range: string) {
  // %H%x00%s 用 NUL 分隔 hash 与 subject，规避 subject 内含空格或特殊字符时的切分歧义。
  const text = await $`git log ${range} --format=%H%x00%s --reverse`.text()
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): Entry => {
      const sep = line.indexOf("\0")
      return { hash: line.slice(0, sep), subject: line.slice(sep + 1) }
    })
    // Merge 提交只是合并噪音，不属于本仓的语义变更，统一过滤。
    .filter((item) => item.hash && item.subject && !item.subject.startsWith("Merge "))
}

function stats(list: Entry[]) {
  const counts = new Map<string, number>()
  for (const entry of list) {
    const name = kind(entry.subject)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  // 按 kinds 固定顺序输出，避免 Map 插入序受提交顺序影响造成统计段抖动。
  return kinds
    .filter((name) => counts.has(name))
    .map((name) => `${name} ×${counts.get(name)}`)
    .join(" · ")
}

function line(entry: Entry) {
  // 9 位短 hash 与 GitHub UI 展示宽度一致；链接本身仍指向完整 commit。
  return `- [\`${entry.hash.slice(0, 9)}\`](https://github.com/${repo}/commit/${entry.hash}) ${entry.subject}`
}

// 按创建时间倒序取最新历史 tag；浅克隆缺 tag 时自然落入首次发布分支而不是报错。
const tags = (await $`git tag --sort=-creatordate`.text()).split("\n").filter(Boolean)
// 排除当前版本自身：同版本重发时 prev 必须指向更早历史，否则会出现自比较空区间。
const prev = tags.find((name) => name !== tag && name.match(/^v\d+\.\d+\.\d+(-smark)?$/))

// lines 按输出顺序收集全部行，统一 join 保证节间空行节奏一致。
const lines: string[] = []

if (!prev) {
  // 仓库里还没有可对比的历史 tag，首次发布退化为最早 50 条提交
  const first = (await log("HEAD")).slice(0, 50)
  lines.push(
    `## ${tag} 首次发布`,
    "",
    `共收录 ${first.length} 项早期变更。`,
    "",
    ...first.map(line),
    "",
    "---",
    "",
    `自动构建于 \`${sha.slice(0, 9)}\``,
  )
} else {
  // 版本 bump commit 是“新增/积累”两节的分界；它自身只是版本号改动，不进入任何列表
  const found =
    await $`git log ${`${prev}..HEAD`} --reverse --format=%H -S ${`"version": "${version}"`} -- packages/opencode/package.json`.text()
  // pickaxe 结果取首个命中：bump 定义为最早把版本串写进 package.json 的提交。
  const bump = found.split("\n").filter(Boolean)[0]

  // bump 之后的区间排除 bump 自身；无 bump 时全量进单节，两分支共享同一过滤规则。
  const current = bump ? await log(`${bump}..HEAD`) : []
  const accumulated = await log(bump ? `${prev}..${bump}^` : `${prev}..HEAD`)

  // 有 bump 且确有新增才分两节；bump 后零提交的异常重发由单节分支兜底。
  if (bump && current.length > 0) {
    lines.push(`## ${tag} 新增`, "", `本版共 ${current.length} 项变更（${stats(current)}）。`, "", ...current.map(line), "")
    if (accumulated.length > 0) {
      // 积累区默认折叠：同版本重发常伴随大量历史提交，展开会淹没本版新增。
      lines.push(
        "<details>",
        `<summary>📦 自 ${prev} 以来积累的 ${accumulated.length} 项变更（${stats(accumulated)}）</summary>`,
        "",
        ...accumulated.map(line),
        "",
        "</details>",
        "",
      )
    }
  } else if (accumulated.length > 0) {
    // 无版本 bump（同版本重发或手动覆盖版本号）：单节展示全部增量，无需折叠
    lines.push(`## 自 ${prev} 以来的变更`, "", `共 ${accumulated.length} 项变更（${stats(accumulated)}）。`, "", ...accumulated.map(line), "")
  } else {
    lines.push("本版无代码变更。", "")
  }

  // 页脚携带完整 compare 链接：读者从 Release 页即可进入逐提交 diff，不必信任摘要。
  lines.push("---", "", `完整对比：[${prev}...${tag}](https://github.com/${repo}/compare/${prev}...${tag}) · 自动构建于 \`${sha.slice(0, 9)}\``)
}

// trim 掉分段 join 产生的首尾空白后补单一换行，保证文件以恰好一个换行符结束。
const body = lines.join("\n").trim() + "\n"
await Bun.write(values.output!, body)
console.log(body)
