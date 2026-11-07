/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"

const TEAM = {
  tui: ["kommander", "simonklee"],
  desktop_web: ["Hona", "Brendonovich"],
  core: ["jlongster", "rekram1-node", "neriousy", "nexxeln", "kitlangton"],
  inference: ["fwang", "vaprdev", "vimtor"],
  windows: ["Hona", "neriousy"],
} as const

function pick<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]!
}

function getIssueNumber(): number {
  const issue = parseInt(process.env.ISSUE_NUMBER ?? "", 10)
  if (!issue) throw new Error("ISSUE_NUMBER env var not set")
  return issue
}

async function githubFetch(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : options.headers),
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

// 保留已安装插件工厂的参数合同，扩展字段在导出定义上组合，不要求更新依赖。
export default Object.assign(tool({
  description: `Use this tool to assign a GitHub issue.

Provide the team that should own the issue. This tool picks a random assignee from that team and does not apply labels.`,
  args: {
    team: tool.schema
      .enum(Object.keys(TEAM) as [keyof typeof TEAM, ...(keyof typeof TEAM)[]])
      .describe("The owning team"),
  },
  async execute(args) {
    const issue = getIssueNumber()
    const owner = "anomalyco"
    const repo = "opencode"
    const assignee = pick(TEAM[args.team])

    await githubFetch(`/repos/${owner}/${repo}/issues/${issue}/assignees`, {
      method: "POST",
      body: JSON.stringify({ assignees: [assignee] }),
    })

    // 回执使用已提交给GitHub的同一次选择，不能为返回值重新随机抽取。
    return { output: `Assigned @${assignee} from ${args.team} to issue #${issue}`,
      program: { value: { issueNumber: issue, assignee } } }
  },
}), {
  output: tool.schema.object({ issueNumber: tool.schema.number(), assignee: tool.schema.string() }),
})
