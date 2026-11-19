#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"

const repo = process.env.GITHUB_REPOSITORY ?? "SMARK2022/opencode"
const kinds = ["feat", "fix", "perf", "refactor", "test", "docs", "chore", "ci", "style", "revert", "other"]

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", short: "v" },
    output: { type: "string", short: "o", default: "release-notes.md" },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
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

const version = (values.version ?? "").replace(/^v/, "")
if (!version) throw new Error("Missing --version, e.g. bun script/release-notes.ts --version 1.15.13-smark")

const tag = `v${version}`
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()

type Entry = {
  hash: string
  subject: string
}

function kind(subject: string) {
  const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:/)
  const name = match?.[1]?.toLowerCase() ?? ""
  return kinds.includes(name) ? name : "other"
}

async function log(range: string) {
  const text = await $`git log ${range} --format=%H%x00%s --reverse`.text()
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): Entry => {
      const sep = line.indexOf("\0")
      return { hash: line.slice(0, sep), subject: line.slice(sep + 1) }
    })
    .filter((item) => item.hash && item.subject && !item.subject.startsWith("Merge "))
}

function stats(list: Entry[]) {
  const counts = new Map<string, number>()
  for (const entry of list) {
    const name = kind(entry.subject)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return kinds
    .filter((name) => counts.has(name))
    .map((name) => `${name} ×${counts.get(name)}`)
    .join(" · ")
}

function line(entry: Entry) {
  return `- [\`${entry.hash.slice(0, 9)}\`](https://github.com/${repo}/commit/${entry.hash}) ${entry.subject}`
}

const tags = (await $`git tag --sort=-creatordate`.text()).split("\n").filter(Boolean)
const prev = tags.find((name) => name !== tag && name.match(/^v\d+\.\d+\.\d+(-smark)?$/))

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
  const bump = found.split("\n").filter(Boolean)[0]

  const current = bump ? await log(`${bump}..HEAD`) : []
  const accumulated = await log(bump ? `${prev}..${bump}^` : `${prev}..HEAD`)

  if (bump && current.length > 0) {
    lines.push(`## ${tag} 新增`, "", `本版共 ${current.length} 项变更（${stats(current)}）。`, "", ...current.map(line), "")
    if (accumulated.length > 0) {
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

  lines.push("---", "", `完整对比：[${prev}...${tag}](https://github.com/${repo}/compare/${prev}...${tag}) · 自动构建于 \`${sha.slice(0, 9)}\``)
}

const body = lines.join("\n").trim() + "\n"
await Bun.write(values.output!, body)
console.log(body)
