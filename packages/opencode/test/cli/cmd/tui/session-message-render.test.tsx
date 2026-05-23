/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type {
  AssistantMessage,
  GlobalEvent,
  Part,
  Session as SessionInfo,
  UserMessage as SDKUserMessage,
} from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { CommandPaletteProvider } from "../../../../src/cli/cmd/tui/context/command-palette"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { LocalProvider } from "../../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { PromptRefProvider } from "../../../../src/cli/cmd/tui/context/prompt"
import { RouteProvider } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { FrecencyProvider } from "../../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { Session } from "../../../../src/cli/cmd/tui/routes/session"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createEventSource, createFetch, directory, json, wait } from "./sync-fixture"

const sessionID = "ses_render"

test("assistant inline tool messages are separated outside the message border", async () => {
  await withRenderedSession(
    [assistantMessage("msg_one", 1), assistantMessage("msg_two", 3)],
    {
      msg_one: [completedToolPart("part_read", "msg_one", "read", { filePath: "alpha.ts" })],
      msg_two: [completedToolPart("part_grep", "msg_two", "grep", { pattern: "needle" })],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes('Grep "needle"')))
      const read = findRow(frame, "Read alpha.ts")

      expect(frame[read]).toMatch(/^┃\s+→ Read alpha\.ts/)
      expect(frame[read + 1]?.startsWith("┃")).toBe(false)
      expect(frame[read + 2]).toMatch(/^┃\s+✱ Grep "needle"/)
    },
  )
})

test("assistant internal part spacing keeps the same message border continuous", async () => {
  await withRenderedSession(
    [assistantMessage("msg_parts", 1)],
    {
      msg_parts: [
        textPart("part_text", "msg_parts", "Thinking"),
        completedToolPart("part_read", "msg_parts", "read", { filePath: "alpha.ts" }),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(
        app,
        (lines) =>
          lines.some((line) => line.includes("Thinking")) && lines.some((line) => line.includes("Read alpha.ts")),
      )
      const thinking = findRow(frame, "Thinking")

      expect(frame[thinking]).toMatch(/^┃\s+Thinking/)
      expect(frame[thinking + 1]?.startsWith("┃")).toBe(true)
      expect(frame[thinking + 2]).toMatch(/^┃\s+→ Read alpha\.ts/)
    },
  )
})

test("assistant first visible part does not inherit top spacing from hidden parts", async () => {
  await withRenderedSession(
    [assistantMessage("msg_hidden", 1)],
    {
      msg_hidden: [
        textPart("part_empty", "msg_hidden", "   "),
        textPart("part_visible", "msg_hidden", "First visible"),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("First visible")))
      const visible = findRow(frame, "First visible")

      expect(frame[visible]).toMatch(/^┃\s+First visible/)
      expect(frame[visible - 1]?.startsWith("┃")).toBe(false)
    },
  )
})

test("assistant first visible part ignores hidden completed tool parts", async () => {
  await withRenderedSession(
    [assistantMessage("msg_hidden_tool", 1)],
    {
      msg_hidden_tool: [
        completedToolPart("part_hidden_tool", "msg_hidden_tool", "read", { filePath: "hidden.ts" }),
        textPart("part_visible", "msg_hidden_tool", "After hidden tool"),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("After hidden tool")))
      const visible = findRow(frame, "After hidden tool")

      expect(frame.some((line) => line.includes("Read hidden.ts"))).toBe(false)
      expect(frame[visible]).toMatch(/^┃\s+After hidden tool/)
      expect(frame[visible - 1]?.startsWith("┃")).toBe(false)
    },
    { tool_details_visibility: false },
  )
})

test("session follows streaming growth when the viewport is visually at the bottom", async () => {
  await withRenderedSession(
    [userMessage("msg_user", 1), assistantMessage("msg_bottom", 2, "msg_user")],
    {
      msg_user: [textPart("part_user", "msg_user", "show the bottom")],
      msg_bottom: [textPart("part_bottom", "msg_bottom", `${"wrapped content ".repeat(180)}OLD_BOTTOM`)],
    },
    async (app, emit) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("OLD_BOTTOM")))

      // Ctrl+Alt+Y scrolls up by exactly one line. The live TUI intentionally
      // treats that one-row gap as still visually bottom-aligned, so a streaming
      // text delta must remain reachable instead of leaving the new tail hidden
      // below the prompt until another terminal/sidebar reflow recalculates it.
      app.mockInput.pressKey("y", { ctrl: true, meta: true })
      await app.renderOnce()
      expect(rows(app.captureCharFrame()).some((line) => line.includes("OLD_BOTTOM"))).toBe(false)

      emit(
        partDeltaEvent("evt_bottom_growth", "msg_bottom", "part_bottom", `${" new content".repeat(80)} NEW_BOTTOM`, "text"),
      )

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("NEW_BOTTOM")))
    },
    {},
    { width: 100, height: 18 },
  )
})

test("pending edit tool shows streamed deletion and addition counts", async () => {
  await withRenderedSession(
    [assistantMessage("msg_pending_edit", 1)],
    {
      msg_pending_edit: [
        pendingToolPart(
          "part_edit",
          "msg_pending_edit",
          "edit",
          JSON.stringify({
            oldString: 'first "quoted" line\nsecond \\ path line\n',
            filePath: "src/space file.ts",
            newString: 'replacement "quoted" line\n',
          }),
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Edit src/space file.ts +1 -2")),
      )
      expect(frame[findRow(frame, "Edit src/space file.ts")]).toContain("+1 -2")
    },
  )
})

test("pending edit tool reports deletions before the JSON input is complete", async () => {
  await withRenderedSession(
    [assistantMessage("msg_pending_edit_partial", 1)],
    {
      msg_pending_edit_partial: [
        pendingToolPart(
          "part_edit_partial",
          "msg_pending_edit_partial",
          "edit",
          '{"filePath":"src/partial.ts","oldString":"one\\ntwo',
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Edit src/partial.ts -2")))
      const row = frame[findRow(frame, "Edit src/partial.ts")]

      expect(row).toContain("-2")
      expect(row).not.toContain("+1")
    },
  )
})

test("pending apply_patch tool summarizes streamed multi-file changes", async () => {
  await withRenderedSession(
    [assistantMessage("msg_pending_patch", 1)],
    {
      msg_pending_patch: [
        pendingToolPart(
          "part_patch",
          "msg_pending_patch",
          "apply_patch",
          JSON.stringify({
            patchText: [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@",
              "-old",
              "+new",
              "*** Add File: src/b.ts",
              "+one",
              "+two",
              "*** End Patch",
            ].join("\n"),
          }),
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Patch 2 files +3 -1")))
      expect(frame[findRow(frame, "Patch 2 files")]).toContain("+3 -1")
    },
  )
})

test("pending write tool shows streamed addition counts", async () => {
  await withRenderedSession(
    [assistantMessage("msg_pending_write", 1)],
    {
      msg_pending_write: [
        pendingToolPart(
          "part_write",
          "msg_pending_write",
          "write",
          JSON.stringify({ filePath: "src/new file.ts", content: "one\ntwo\n" }),
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Write src/new file.ts +2")))
      expect(frame[findRow(frame, "Write src/new file.ts")]).toContain("+2")
    },
  )
})

test("task tool click opens its subagent session", async () => {
  const childID = "ses_child"
  await withRenderedSession(
    [assistantMessage("msg_task", 1)],
    {
      msg_task: [
        completedToolPart(
          "part_task",
          "msg_task",
          "task",
          { description: "inspect files", subagent_type: "general" },
          { sessionId: childID },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("General Task") && line.includes("inspect files")))
      const raw = app.captureCharFrame().split("\n")
      const y = raw.findIndex((line) => line.includes("General Task") && line.includes("inspect files"))
      expect(y).toBeGreaterThanOrEqual(0)

      await app.mockMouse.click(11, y + 1)

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("child session visible")))
    },
    {},
    {},
    {
      [childID]: {
        info: sessionInfo({ id: childID, parentID: sessionID, title: "inspect files (@general subagent)" }),
        messages: [
          {
            id: "msg_child",
            sessionID: childID,
            role: "assistant",
            time: { created: 2, completed: 3 },
            parentID: "msg_child_user",
            modelID: "model",
            providerID: "provider",
            mode: "build",
            agent: "general",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } satisfies AssistantMessage,
        ],
        parts: { msg_child: [textPart("part_child", "msg_child", "child session visible", { sessionID: childID })] },
      },
    },
  )
})

test("task tool click refreshes a stale prefetched subagent session", async () => {
  const childID = "ses_child_stale"
  let childMessageRequests = 0
  const childMessage = {
    id: "msg_child_stale",
    sessionID: childID,
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID: "msg_child_user",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "general",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage

  await withRenderedSession(
    [assistantMessage("msg_task_stale", 1)],
    {
      msg_task_stale: [
        completedToolPart(
          "part_task_stale",
          "msg_task_stale",
          "task",
          { description: "inspect stale child", subagent_type: "general" },
          { sessionId: childID },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("inspect stale child")))
      await wait(() => childMessageRequests >= 1)
      const raw = app.captureCharFrame().split("\n")
      const y = raw.findIndex((line) => line.includes("inspect stale child"))
      expect(y).toBeGreaterThanOrEqual(0)

      await app.mockMouse.click(11, y + 1)

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("child session refreshed")))
      expect(childMessageRequests).toBeGreaterThan(1)
    },
    {},
    {},
    {
      [childID]: {
        info: sessionInfo({ id: childID, parentID: sessionID, title: "inspect stale child (@general subagent)" }),
        messages: () => {
          childMessageRequests++
          return childMessageRequests === 1 ? [] : [childMessage]
        },
        parts: { msg_child_stale: [textPart("part_child_stale", "msg_child_stale", "child session refreshed", { sessionID: childID })] },
      },
    },
  )
})

test("pending tool line counts update from streamed raw deltas", async () => {
  await withRenderedSession(
    [assistantMessage("msg_live_delta", 1)],
    {
      msg_live_delta: [pendingToolPart("part_live_delta", "msg_live_delta", "edit", "")],
    },
    async (app, emit) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("Preparing edit...")))

      emit(
        partDeltaEvent(
          "evt_live_delta",
          "msg_live_delta",
          "part_live_delta",
          JSON.stringify({ filePath: "src/live.ts", oldString: "one\ntwo", newString: "three\n" }),
        ),
      )

      await Bun.sleep(50)
      await app.renderOnce()
      expect(rows(app.captureCharFrame()).some((line) => line.includes("Edit src/live.ts +1 -2"))).toBe(false)

      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Edit src/live.ts +1 -2")))
      expect(frame[findRow(frame, "Edit src/live.ts")]).toContain("+1 -2")
    },
  )
})

test("shell tool renders auto review as a second status line", async () => {
  await withRenderedSession(
    [assistantMessage("msg_auto_review", 1)],
    {
      msg_auto_review: [
        runningToolPart("part_shell_review", "msg_auto_review", "bash", {
          command: 'Get-Content -Path "$env:USERPROFILE\\.ssh\\id_rsa"',
          metadata: {
            autoReview: {
              reviewID: "review_shell",
              sessionID: "ses_reviewer_child",
              status: "reviewing",
              precheck: { level: "cautious", reason: "private key access requires reviewer approval" },
            },
          },
        }),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("◌ auto review · cautious · @permission-reviewer")),
      )
      const command = findRow(frame, 'Get-Content -Path "$env:USERPROFILE\\.ssh\\id_rsa"')
      expect(frame[command + 1]).toContain("◌ auto review · cautious · @permission-reviewer")
    },
  )
})

test("completed shell tool keeps the auto review result line", async () => {
  await withRenderedSession(
    [assistantMessage("msg_auto_review_done", 1)],
    {
      msg_auto_review_done: [
        completedToolPart(
          "part_shell_review_done",
          "msg_auto_review_done",
          "bash",
          { command: "git push origin main" },
          {
            output: "pushed",
            autoReview: {
              reviewID: "review_shell_done",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "git push requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user explicitly requested push" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("✓ auto review · allowed · auth high · @permission-reviewer")),
      )
      const command = findRow(frame, "$ git push origin main")
      expect(frame[command + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
    },
  )
})

test("collapsed completed shell preview keeps the auto review result line", async () => {
  await withRenderedSession(
    [assistantMessage("msg_auto_review_collapsed", 1)],
    {
      msg_auto_review_collapsed: [
        completedToolPart(
          "part_shell_review_collapsed",
          "msg_auto_review_collapsed",
          "bash",
          { command: "git push origin main" },
          {
            output: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"),
            autoReview: {
              reviewID: "review_shell_collapsed",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "git push requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user explicitly requested push" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Click to expand")))
      expect(frame.some((line) => line.includes("✓ auto review · allowed · auth high · @permission-reviewer"))).toBe(
        true,
      )
    },
  )
})

test("errored shell tool keeps the denied auto review result line", async () => {
  await withRenderedSession(
    [assistantMessage("msg_auto_review_error", 1)],
    {
      msg_auto_review_error: [
        errorToolPart(
          "part_shell_review_error",
          "msg_auto_review_error",
          "bash",
          { command: "git push origin main" },
          "auto reviewer denied",
          {
            autoReview: {
              reviewID: "review_shell_error",
              sessionID: "ses_reviewer_child",
              status: "denied",
              precheck: { level: "cautious", reason: "git push requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "unknown", rationale: "push was not authorized" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("! auto review · denied · high risk · auth unknown")),
      )
      const command = findRow(frame, "git push origin main")
      expect(frame[command + 1]).toContain("! auto review · denied · high risk · auth unknown")
    },
  )
})

test("permission review decision renders as a reviewer cell", async () => {
  await withRenderedSession(
    [assistantMessage("msg_review_decision", 1)],
    {
      msg_review_decision: [
        completedToolPart(
          "part_review_decision",
          "msg_review_decision",
          "permission_review_decision",
          {
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "private key read was not explicitly authorized",
          },
          {
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "private key read was not explicitly authorized",
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(
        app,
        (lines) =>
          lines.some((line) => line.includes("denied")) &&
          lines.some((line) => line.includes("high")) &&
          lines.some((line) => line.includes("unknown")) &&
          lines.some((line) => line.includes("rationale")) &&
          lines.some((line) => line.includes("private key read was not explicitly authorized")),
      )
      expect(frame.some((line) => line.includes("! Permission review decision"))).toBe(false)
    },
  )
})

test("reviewer child session shows full reviewer prompt and assistant rationale before decision tool", async () => {
  await withRenderedSession(
    [userMessage("msg_review_request", 1), assistantMessage("msg_review_answer", 2, "msg_review_request")],
    {
      msg_review_request: [
        textPart(
          "part_review_request",
          "msg_review_request",
          [
            "system:",
            "You are opencode's isolated permission reviewer.",
            "",
            "user:",
            ">>> TRANSCRIPT START",
            "[1] user: please inspect the exact key file",
            ">>> TRANSCRIPT END",
            ">>> APPROVAL REQUEST START",
            '{"permission":"bash"}',
            ">>> APPROVAL REQUEST END",
          ].join("\n"),
          { metadata: { permissionReviewerRequest: true } },
        ),
      ],
      msg_review_answer: [
        textPart(
          "part_review_text",
          "msg_review_answer",
          "The requested private key read is not explicitly authorized.",
        ),
        completedToolPart(
          "part_review_decision_flow",
          "msg_review_answer",
          "permission_review_decision",
          {
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "private key read was not explicitly authorized",
          },
          {
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "private key read was not explicitly authorized",
          },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(
        app,
        (lines) =>
          lines.some((line) => line.includes(">>> TRANSCRIPT START")) &&
          lines.some((line) => line.includes(">>> APPROVAL REQUEST START")) &&
          lines.some((line) => line.includes("rationale")) &&
          lines.some((line) => line.includes("private key read")),
      )
    },
    {},
    { height: 42 },
  )
})

async function withRenderedSession(
  messages: Array<AssistantMessage | SDKUserMessage>,
  parts: Record<string, Part[]>,
  run: (app: Awaited<ReturnType<typeof testRender>>, emit: (event: GlobalEvent) => void) => Promise<void>,
  kv: Record<string, unknown> = {},
  dimensions: { width?: number; height?: number } = {},
  extraSessions: Record<
    string,
    {
      info: SessionInfo
      messages: Array<AssistantMessage | SDKUserMessage> | (() => Array<AssistantMessage | SDKUserMessage>)
      parts: Record<string, Part[]>
    }
  > = {},
) {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify(kv))

  const info = sessionInfo()
  const calls = createFetch((url) => {
    const sessions: Record<
      string,
      {
        info: SessionInfo
        messages: Array<AssistantMessage | SDKUserMessage> | (() => Array<AssistantMessage | SDKUserMessage>)
        parts: Record<string, Part[]>
      }
    > = { [sessionID]: { info, messages, parts }, ...extraSessions }
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|todo|diff))?$/)
    if (url.pathname === "/session") return json(Object.values(sessions).map((session) => session.info))
    if (match) {
      const session = sessions[match[1]]
      if (!session) return undefined
      if (!match[2]) return json(session.info)
      if (match[2] === "message") {
        const sessionMessages = typeof session.messages === "function" ? session.messages() : session.messages
        return json(sessionMessages.map((message) => ({ info: message, parts: session.parts[message.id] ?? [] })))
      }
      return json([])
    }
    return undefined
  })

  const events = createEventSource()
  const app = await testRender(() => <SessionHarness fetch={calls.fetch} events={events.source} />, {
    width: dimensions.width ?? 80,
    height: dimensions.height ?? 16,
    footerHeight: 0,
  })

  try {
    await run(app, events.emit)
  } finally {
    app.renderer.destroy()
    Global.Path.state = previous
  }
}

function SessionHarness(props: {
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ArgsProvider>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID }}>
                <TuiConfigProvider config={config}>
                  <SDKProvider
                    url="http://test"
                    directory={directory}
                    testTransport={{ fetch: props.fetch, events: props.events }}
                  >
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <CommandPaletteProvider>
                                  <FrecencyProvider>
                                    <PromptHistoryProvider>
                                      <PromptRefProvider>
                                        <EditorContextProvider>
                                          <Session />
                                        </EditorContextProvider>
                                      </PromptRefProvider>
                                    </PromptHistoryProvider>
                                  </FrecencyProvider>
                                </CommandPaletteProvider>
                              </DialogProvider>
                            </PromptStashProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </OpencodeKeymapProvider>
  )
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, predicate: (lines: string[]) => boolean) {
  const start = Date.now()

  for (;;) {
    await app.renderOnce()
    const frame = rows(app.captureCharFrame())
    if (predicate(frame)) return frame
    if (Date.now() - start > 2_000) throw new Error(`timed out waiting for frame:\n${frame.join("\n")}`)
    await Bun.sleep(10)
  }
}

function rows(frame: string) {
  return frame.split("\n").map((line) => line.replace(/\s*█$/, "").trimEnd().trimStart())
}

function findRow(frame: string[], text: string) {
  const index = frame.findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`missing row ${JSON.stringify(text)}:\n${frame.join("\n")}`)
  return index
}

function sessionInfo(extra: Partial<SessionInfo> = {}) {
  return {
    id: sessionID,
    slug: "render",
    projectID: "proj_test",
    directory,
    title: "render",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
    ...extra,
  } satisfies SessionInfo
}

function userMessage(id: string, created: number) {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "permission-reviewer",
    model: { providerID: "provider", modelID: "model" },
  } satisfies SDKUserMessage
}

function assistantMessage(id: string, created: number, parentID = "msg_user") {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 1 },
    parentID,
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage
}

function textPart(id: string, messageID: string, text: string, extra: Partial<Extract<Part, { type: "text" }>> = {}) {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
    ...extra,
  } satisfies Extract<Part, { type: "text" }>
}

function completedToolPart(
  id: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "completed",
      input,
      output: "",
      title: tool,
      metadata,
      time: { start: 1, end: 2 },
    },
  } satisfies Extract<Part, { type: "tool" }>
}

function runningToolPart(
  id: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown> & { metadata?: Record<string, unknown> },
) {
  const metadata = input.metadata ?? {}
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "running",
      input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "metadata")),
      title: tool,
      metadata,
      time: { start: 1 },
    },
  } satisfies Extract<Part, { type: "tool" }>
}

function errorToolPart(
  id: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  error: string,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "error",
      input,
      error,
      metadata,
      time: { start: 1, end: 2 },
    },
  } satisfies Extract<Part, { type: "tool" }>
}

function pendingToolPart(id: string, messageID: string, tool: string, raw: string) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "pending",
      input: {},
      raw,
    },
  } satisfies Extract<Part, { type: "tool" }>
}

function partDeltaEvent(id: string, messageID: string, partID: string, delta: string, field = "raw"): GlobalEvent {
  // Most existing streaming-tool tests append to the pending tool `raw` buffer,
  // which mirrors the daemon event shape for incremental tool input. The session
  // bottom-stickiness regression streams a normal text part instead, so keep the
  // historical default and only override `field` at that call site.
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.delta",
      properties: { sessionID, messageID, partID, field, delta },
    },
  }
}
