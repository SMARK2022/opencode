import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Git } from "@/git"
import * as Tool from "./tool"

const Repository = Schema.String.annotate({ description: "GitHub repository shorthand owner/repo or GitHub URL" })

export const Parameters = Schema.Struct({
  repository: Repository,
  branch: Schema.optional(Schema.String).annotate({ description: "Optional branch to checkout" }),
  refresh: Schema.optional(Schema.Boolean).annotate({ description: "Fetch and update an existing cached clone" }),
})

type Repo = {
  owner: string
  name: string
}

type Metadata = {
  status: "cloned" | "cached" | "refreshed"
  localPath: string
  branch?: string
}

export const RepoCloneTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | Git.Service>(
  "repo_clone",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service

    const run = Effect.fn("RepoCloneTool.git")(function* (cwd: string, args: string[]) {
      const result = yield* git.run(args, { cwd })
      if (result.exitCode === 0) return result.text().trim()
      throw new Error(result.stderr.toString().trim() || result.text().trim() || `git ${args.join(" ")} failed`)
    })

    const execute = Effect.fn("RepoCloneTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      _ctx: Tool.Context,
    ) {
      const repo = parseRepository(params.repository)
      const localPath = path.join(Global.Path.repos, "github.com", repo.owner, repo.name)
      const exists = yield* fs.existsSafe(path.join(localPath, ".git"))
      const branch = params.branch

      if (exists && !params.refresh) {
        return result({ status: "cached", localPath, branch })
      }

      if (exists) {
        yield* run(localPath, ["fetch", "origin", "--prune"])
        const active = branch ?? (yield* git.branch(localPath))
        if (active) {
          yield* run(localPath, ["checkout", active])
          yield* run(localPath, ["pull", "--ff-only", "origin", active])
        } else {
          yield* run(localPath, ["pull", "--ff-only"])
        }
        return result({ status: "refreshed", localPath, branch: active })
      }

      yield* fs.ensureDir(path.dirname(localPath)).pipe(Effect.orDie)
      yield* run(path.dirname(localPath), [
        "clone",
        ...(branch ? ["--branch", branch] : []),
        cloneUrl(repo),
        localPath,
      ])
      return result({ status: "cloned", localPath, branch })
    })

    return {
      description: "Clone a GitHub repository into opencode's managed repository cache.",
      parameters: Parameters,
      execute,
    }
  }),
)

function result(metadata: Metadata) {
  return {
    title: metadata.localPath,
    metadata,
    output: `${metadata.status} ${metadata.localPath}`,
  }
}

function parseRepository(input: string): Repo {
  if (input.startsWith("file:")) throw new Error("Local file repository URLs are not allowed")
  if (input.startsWith("-") || input.includes("..")) throw new Error("Expected a GitHub repository shorthand or git URL")

  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input)
  if (shorthand) return { owner: shorthand[1]!, name: shorthand[2]!.replace(/\.git$/, "") }

  try {
    const url = new URL(input)
    if (url.protocol === "file:") throw new Error("Local file repository URLs are not allowed")
    if (url.hostname !== "github.com") throw new Error("Expected a GitHub repository shorthand or git URL")
    const [owner, name, extra] = url.pathname.replace(/^\/+/, "").split("/")
    if (!owner || !name || extra || owner.startsWith("-") || name.startsWith("-")) {
      throw new Error("Expected a GitHub repository shorthand or git URL")
    }
    return { owner, name: name.replace(/\.git$/, "") }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Local file")) throw error
    throw new Error("Expected a GitHub repository shorthand or git URL")
  }
}

function cloneUrl(repo: Repo) {
  const base = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
  if (base) return new URL(`${repo.owner}/${repo.name}.git`, base).href
  return `https://github.com/${repo.owner}/${repo.name}.git`
}
