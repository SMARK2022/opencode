/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
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

interface PR {
  title: string
  html_url: string
}

// 项目安装的旧tool工厂只接收原API字段；额外输出声明由当前registry消费。
export default Object.assign(tool({
  description: `Use this tool to search GitHub pull requests by title and description.

This tool searches PRs in the anomalyco/opencode repository and returns LLM-friendly results including:
- PR number and title
- Author
- State (open/closed/merged)
- Labels
- Description snippet

Use the query parameter to search for keywords that might appear in PR titles or descriptions.`,
  args: {
    query: tool.schema.string().describe("Search query for PR titles and descriptions"),
    limit: tool.schema.number().describe("Maximum number of results to return").default(10),
    offset: tool.schema.number().describe("Number of results to skip for pagination").default(0),
  },
  async execute(args) {
    const owner = "anomalyco"
    const repo = "opencode"

    const page = Math.floor(args.offset / args.limit) + 1
    const searchQuery = encodeURIComponent(`${args.query} repo:${owner}/${repo} type:pr state:open`)
    const result = await githubFetch(
      `/search/issues?q=${searchQuery}&per_page=${args.limit}&page=${page}&sort=updated&order=desc`,
    )

    const prs = result.items as PR[]
    const formatted = prs.map((pr) => `${pr.title}\n${pr.html_url}`).join("\n\n")
    // 展示沿原分页文案；程序完整性只取GitHub实际返回的标志。
    return { output: result.total_count === 0 ? `No PRs found matching "${args.query}"`
      : prs.length === 0 ? `No other PRs found matching "${args.query}"`
      : `Found ${result.total_count} PRs (showing ${prs.length}):\n\n${formatted}`,
      program: { value: { totalCount: result.total_count,
        items: prs.map((pr) => ({ title: pr.title, path: pr.html_url })), partial: result.incomplete_results,
      } },
    }
  },
}), {
  output: tool.schema.object({ totalCount: tool.schema.number(),
    items: tool.schema.array(tool.schema.object({ title: tool.schema.string(), path: tool.schema.string() })),
    partial: tool.schema.boolean(),
  }),
})
