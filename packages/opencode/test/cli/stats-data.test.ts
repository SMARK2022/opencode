import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { aggregateStats } from "@/cli/cmd/stats/data"
import { renderBreakdown } from "@/cli/cmd/stats/render"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  await resetDatabase()
})

const seedToolBreakdownReport = (input: { legacyEmptyMessages?: boolean } = {}) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })
    const assistant = yield* session.updateMessage({
      id: MessageID.ascending(),
      sessionID: info.id,
      role: "assistant",
      parentID: user.id,
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
    })
    const now = Date.now()
    const stepPartID = PartID.ascending()
    const stepData = {
      type: "step-finish" as const,
      reason: "stop",
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      inputChars: 100,
      inputBreakdown: {
        system: 10,
        instructions: 10,
        skills: 0,
        tools: 10,
        messages: {
          userText: 10,
          assistantText: 10,
          reasoning: 0,
          toolInput: 30,
          toolOutput: 20,
          attachments: 0,
          total: 70,
        },
      },
    }

    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: info.id,
      messageID: assistant.id,
      type: "tool",
      callID: "call_bash",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "ok",
        title: "pwd",
        metadata: {},
        time: { start: now, end: now },
      },
    })
    yield* session.updatePart({ id: stepPartID, sessionID: info.id, messageID: assistant.id, ...stepData })

    if (input.legacyEmptyMessages) {
      // Some 1.15.3 local rows persisted the `messages` object without the per-category counters.
      // Mutating the stored JSON keeps this test at the stats boundary: current writes remain schema-shaped,
      // while reads must stay compatible with historical rows copied from user databases.
      yield* Effect.sync(() =>
        Database.Client().$client.run("update part set data = ? where id = ?", [
          JSON.stringify({ ...stepData, inputBreakdown: { ...stepData.inputBreakdown, messages: {} } }),
          stepPartID,
        ]),
      )
    }

    return yield* aggregateStats()
  })

describe("stats data", () => {
  it.instance("attributes tool context tokens from complete input breakdowns", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport()

      expect(report.totalTools).toBe(1)
      expect(report.toolUsage).toEqual([
        {
          id: "bash",
          count: 1,
          inputChars: expect.any(Number),
          outputChars: 2,
          contextTokens: 50,
        },
      ])
      expect(renderBreakdown(report, { color: "never", by: "tool" })).toContain("Tool context tokens")
    }),
  )

  it.instance("keeps tool breakdown finite for legacy empty message breakdowns", () =>
    Effect.gen(function* () {
      const report = yield* seedToolBreakdownReport({ legacyEmptyMessages: true })

      expect(report.toolUsage).toEqual([
        {
          id: "bash",
          count: 1,
          inputChars: expect.any(Number),
          outputChars: 2,
          contextTokens: 0,
        },
      ])
      expect(report.toolUsage.every((tool) => Number.isFinite(tool.contextTokens))).toBe(true)
      expect(report.toolSeries).toEqual([])
      expect(() => renderBreakdown(report, { color: "never", by: "tool" })).not.toThrow()
    }),
  )
})
