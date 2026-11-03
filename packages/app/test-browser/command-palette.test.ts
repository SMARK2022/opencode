import { describe, expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { createRoot } from "solid-js"
import { createServerSessionEntries } from "@/components/command-palette"
import type { LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { getProjectAvatarSource } from "@/pages/layout/helpers"

const stored: Project = {
  id: "project-1",
  name: "Palette project",
  worktree: "/workspace/project",
  sandboxes: [],
  time: { created: 1, updated: 1 },
}

const session: SessionInfo = {
  id: "session-1",
  projectID: stored.id,
  agent: "build",
  model: { id: "model-1", providerID: "provider-1" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  location: { directory: stored.worktree },
  title: "Palette session",
  time: { created: 1, updated: 2 },
}

describe("command palette sessions", () => {
  test("uses the home project avatar and cancels superseded searches", async () => {
    const server = ServerConnection.Key.make("selected-server")
    const opened: LocalProject = {
      ...stored,
      icon: { override: "home-project-avatar" },
      expanded: true,
    }
    const searches: { search: string; limit: number; start: number; parentID: null }[] = []
    const startedAt = Date.now()
    const result = await new Promise<Awaited<ReturnType<ReturnType<typeof createServerSessionEntries>>>>(
      (resolve, reject) => {
        createRoot((dispose) => {
          const search = createServerSessionEntries({
            server,
            opened: () => [opened],
            stored: () => [{ ...stored, icon: { url: "stored-project-avatar" } }],
            load: async (query, signal) => {
              searches.push(query)
              expect(signal.aborted).toBe(false)
              return {
                data: [
                  // 超过旧50条预算的真实结果仍经条目映射，归档行保持原有过滤。
                  ...Array.from({ length: Math.min(query.limit, 60) }, (_, index) => ({
                    ...session,
                    id: index ? `session-${index + 1}` : session.id,
                  })),
                  { ...session, id: "archived-session", time: { ...session.time, archived: 3 } },
                ],
              }
            },
            untitled: () => "Untitled",
            category: () => "Sessions",
          })
          const first = search("palette")
          const second = search("palette session")
          Promise.all([first, second])
            .then(([cancelled, entries]) => {
              expect(cancelled).toEqual([])
              resolve(entries)
            })
            .catch(reject)
            .finally(dispose)
        })
      },
    )

    expect(searches.map((query) => query.search)).toEqual(["palette session"])
    expect(searches[0]).toMatchObject({ parentID: null, limit: 100 })
    expect(searches[0]?.start).toBeGreaterThanOrEqual(startedAt - 90 * 24 * 60 * 60 * 1000)
    expect(searches[0]?.start).toBeLessThanOrEqual(Date.now() - 90 * 24 * 60 * 60 * 1000)
    expect(result).toHaveLength(60)
    expect(getProjectAvatarSource(result[0]?.project?.id, result[0]?.project?.icon)).toBe("home-project-avatar")
    expect(result[0]).toMatchObject({
      server,
      sessionID: session.id,
      description: stored.name,
      project: { id: stored.id, icon: opened.icon },
    })
  })
})
