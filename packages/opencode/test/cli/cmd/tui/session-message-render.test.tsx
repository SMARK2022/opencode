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
        lines.some((line) => line.includes("Edit src") && line.includes("space file.ts") && line.includes("+1 -2")),
      )
      expect(frame[findRow(frame, "space file.ts")]).toContain("+1 -2")
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
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Edit src") && line.includes("partial.ts") && line.includes("-2")))
      const row = frame[findRow(frame, "partial.ts")]

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
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Write src") && line.includes("new file.ts") && line.includes("+2")))
      expect(frame[findRow(frame, "new file.ts")]).toContain("+2")
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

      await app.mockMouse.click(35, y + 1)

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

      await app.mockMouse.click(35, y + 1)

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
      expect(rows(app.captureCharFrame()).some((line) => line.includes("Edit src") && line.includes("live.ts") && line.includes("+1 -2"))).toBe(false)

      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Edit src") && line.includes("live.ts") && line.includes("+1 -2")))
      expect(frame[findRow(frame, "live.ts")]).toContain("+1 -2")
    },
  )
})

test("pending notebook edit shows throttled line counts without rendering raw source", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_live_delta", 1)],
    {
      msg_notebook_live_delta: [pendingToolPart("part_notebook_live_delta", "msg_notebook_live_delta", "vscode_notebook_edit", "")],
    },
    async (app, emit) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("Preparing notebook edit")))

      emit(
        partDeltaEvent(
          "evt_notebook_live_delta",
          "msg_notebook_live_delta",
          "part_notebook_live_delta",
          JSON.stringify({
            filePath: "notebooks/analysis notebook.ipynb",
            cellId: "#VSC-12345678",
            editType: "edit",
            oldCode: "old one\nold two",
            newCode: ["new one", "new two", "new three"],
          }),
        ),
      )

      await Bun.sleep(50)
      await app.renderOnce()
      expect(rows(app.captureCharFrame()).some((line) => line.includes("Notebook edit") && line.includes("+3 -2"))).toBe(false)

      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Notebook edit") && line.includes("analysis notebook.ipynb") && line.includes("+3 -2")),
      )
      expect(frame.some((line) => line.includes("new two"))).toBe(false)
    },
  )
})

test("completed notebook edit renders a diff card instead of raw generic input", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_edit", 1)],
    {
      msg_notebook_edit: [
        completedToolPart(
          "part_notebook_edit",
          "msg_notebook_edit",
          "vscode_notebook_edit",
          {
            filePath: "notebooks/analysis.ipynb",
            cellId: "#VSC-12345678",
            editType: "edit",
            newCode: "RAW_ONLY_SHOULD_NOT_RENDER",
          },
          {
            vscodeNotebook: {
              view: "edit",
              path: "notebooks/analysis.ipynb",
              cellLabel: "c3",
              editType: "edit",
              language: "python",
              dirty: true,
              cellCountBefore: 4,
              cellCountAfter: 4,
              diff: ["--- notebooks/analysis.ipynb#c3.py", "+++ notebooks/analysis.ipynb#c3.py", "@@ -1 +1,2 @@", "-old value", "+new value", "+rendered diff line"].join("\n"),
              added: 2,
              removed: 1,
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Notebook edit") && line.includes("+2 -1")))
      expect(frame.some((line) => line.includes("rendered diff line"))).toBe(true)
      expect(frame.some((line) => line.includes("RAW_ONLY_SHOULD_NOT_RENDER"))).toBe(false)
    },
  )
})

test("completed notebook edit uses notebook language for supported diff syntax highlighting", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_edit_highlight", 1)],
    {
      msg_notebook_edit_highlight: [
        completedToolPart(
          "part_notebook_edit_highlight",
          "msg_notebook_edit_highlight",
          "vscode_notebook_edit",
          { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-12345678", editType: "edit" },
          {
            vscodeNotebook: {
              view: "edit",
              path: "notebooks/analysis.ipynb",
              cellLabel: "c3",
              editType: "edit",
              language: "typescript",
              dirty: true,
              cellCountBefore: 4,
              cellCountAfter: 4,
              diff: [
                "--- notebooks/analysis.ipynb#c3.typescript",
                "+++ notebooks/analysis.ipynb#c3.typescript",
                "@@ -1 +1 @@",
                "-const verified = false",
                "+const verified = true",
              ].join("\n"),
              added: 1,
              removed: 1,
            },
          },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("const verified = true")))
      const start = Date.now()
      for (;;) {
        await app.renderOnce()
        const line = app.captureSpans().lines.find((item) => item.spans.map((span) => span.text).join("").includes("const verified = true"))
        const identifierSpan = line?.spans.find((span) => span.text.includes("verified"))
        const keywordSpan = line?.spans.find((span) => span.text.includes("const"))
        if (identifierSpan && keywordSpan && JSON.stringify(keywordSpan.fg) !== JSON.stringify(identifierSpan.fg)) break
        if (Date.now() - start > 2_000) {
          expect(keywordSpan?.fg).not.toEqual(identifierSpan?.fg)
          break
        }
        await Bun.sleep(10)
      }
    },
  )
})

test("completed shell edit uses the existing bash parser for shellscript file extensions", async () => {
  await withRenderedSession(
    [assistantMessage("msg_shell_edit_highlight", 1)],
    {
      msg_shell_edit_highlight: [
        completedToolPart(
          "part_shell_edit_highlight",
          "msg_shell_edit_highlight",
          "edit",
          { filePath: "scripts/install.sh" },
          {
            diff: [
              "--- scripts/install.sh",
              "+++ scripts/install.sh",
              "@@ -1 +1 @@",
              "-echo \"old\"",
              "+echo \"new\"",
            ].join("\n"),
          },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes('echo "new"')))
      // 这里刻意通过最终渲染颜色区分行为，而不是检查 parser 配置项本身：
      // `.sh` 在 LSP 语义上仍然是 `shellscript`，TUI 高亮必须由已有 bash
      // parser 的 alias 承接，后续重构只要用户可见颜色行为不退化即可。
      await waitForDistinctSpanColors(app, 'echo "new"', "echo", '"new"')
    },
  )
})

test("completed toml edit uses the registered toml parser", async () => {
  await withRenderedSession(
    [assistantMessage("msg_toml_edit_highlight", 1)],
    {
      msg_toml_edit_highlight: [
        completedToolPart(
          "part_toml_edit_highlight",
          "msg_toml_edit_highlight",
          "edit",
          { filePath: "config/opencode.toml" },
          {
            diff: [
              "--- config/opencode.toml",
              "+++ config/opencode.toml",
              "@@ -1 +1 @@",
              "-name = \"old\"",
              "+name = \"opencode\"",
            ].join("\n"),
          },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes('name = "opencode"')))
      // `.toml` 之前没有扩展名映射，虽然 parser 已注册也无法被 edit diff 使用；
      // 这里通过 key/value 颜色差异锁定用户可见行为，避免未来只保留 parser
      // 配置却丢失扩展名入口时测试仍然误通过。
      await waitForDistinctSpanColors(app, 'name = "opencode"', "name", '"opencode"')
    },
  )
})

test("completed oversized notebook insert renders inserted source preview when the full diff is omitted", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_insert_preview", 1)],
    {
      msg_notebook_insert_preview: [
        completedToolPart(
          "part_notebook_insert_preview",
          "msg_notebook_insert_preview",
          "vscode_notebook_edit",
          {
            filePath: "notebooks/large analysis.ipynb",
            cellId: "#VSC-anchor",
            editType: "insert",
            newCode: "RAW_INSERT_INPUT_SHOULD_NOT_RENDER",
          },
          {
            vscodeNotebook: {
              view: "edit",
              path: "notebooks/large analysis.ipynb",
              cellLabel: "c4",
              editType: "insert",
              language: "python",
              dirty: true,
              cellCountBefore: 3,
              cellCountAfter: 4,
              diffOmitted: "too-large",
              added: 3003,
              removed: 0,
              insertedSourcePreview: ["import pandas as pd", "df = pd.read_csv('large file.csv')", "df.head()"].join("\n"),
              insertedSourcePreviewTruncated: true,
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Notebook insert") && line.includes("+3003 -0")) &&
        lines.some((line) => line.includes("import pandas as pd")) &&
        lines.some((line) => line.includes("df.head()")),
      )
      expect(frame.some((line) => line.includes("RAW_INSERT_INPUT_SHOULD_NOT_RENDER"))).toBe(false)
      expect(frame.some((line) => line.includes("Click to expand"))).toBe(true)
      expect(frame.some((line) => line.includes("Diff omitted"))).toBe(false)
    },
    {},
    { height: 24 },
  )
})

test("completed notebook insert renders inserted source as code instead of a diff", async () => {
  const inserted = Array.from({ length: 12 }, (_, index) => `print('inserted line ${index + 1}')`)
  inserted[5] = "++ legal source prefix"
  await withRenderedSession(
    [assistantMessage("msg_notebook_insert_code", 1)],
    {
      msg_notebook_insert_code: [
        completedToolPart(
          "part_notebook_insert_code",
          "msg_notebook_insert_code",
          "vscode_notebook_edit",
          { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-anchor", editType: "insert" },
          {
            vscodeNotebook: {
              view: "edit",
              path: "notebooks/analysis.ipynb",
              cellLabel: "c4",
              editType: "insert",
              language: "python",
              dirty: true,
              cellCountBefore: 3,
              cellCountAfter: 4,
              diff: ["--- DIFF_HEADER_SHOULD_NOT_RENDER", "+++ notebooks/analysis.ipynb#c4.py", "@@ -0,0 +1,12 @@", ...inserted.map((line) => `+${line}`)].join("\n"),
              added: 12,
              removed: 0,
              insertedSourcePreview: inserted.slice(0, 10).join("\n"),
              insertedSourcePreviewTruncated: true,
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("print('inserted line 12')")))
      expect(frame.some((line) => line.includes("++ legal source prefix"))).toBe(true)
      expect(frame.some((line) => line.includes("DIFF_HEADER_SHOULD_NOT_RENDER"))).toBe(false)
      expect(frame.some((line) => line.includes("Inserted source preview is truncated"))).toBe(false)
    },
  )
})

test("notebook tool switches from pending inline summary to completed rich card", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_transition", 1)],
    {
      msg_notebook_transition: [pendingToolPart("part_notebook_transition", "msg_notebook_transition", "vscode_notebook_edit", "")],
    },
    async (app, emit) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("Preparing notebook edit")))

      emit(
        partUpdatedEvent(
          "evt_notebook_transition_done",
          completedToolPart(
            "part_notebook_transition",
            "msg_notebook_transition",
            "vscode_notebook_edit",
            { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-12345678", editType: "edit" },
            {
              vscodeNotebook: {
                view: "edit",
                path: "notebooks/analysis.ipynb",
                cellLabel: "c3",
                editType: "edit",
                diff: ["--- notebooks/analysis.ipynb#c3.py", "+++ notebooks/analysis.ipynb#c3.py", "@@ -1 +1 @@", "-before transition", "+after transition"].join("\n"),
                added: 1,
                removed: 1,
              },
            },
          ),
        ),
      )

      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("after transition")))
      expect(frame.some((line) => line.includes("Preparing notebook edit"))).toBe(false)
    },
  )
})

test("notebook summary renders cells from notebook metadata without enabling generic output", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_summary", 1)],
    {
      msg_notebook_summary: [
        completedToolPart(
          "part_notebook_summary",
          "msg_notebook_summary",
          "vscode_notebook_summary",
          { filePath: "notebooks/analysis.ipynb" },
          {
            vscodeNotebook: {
              view: "summary",
              path: "notebooks/analysis.ipynb",
              dirty: false,
              runtime: "Python 3.11",
              cells: [
                { i: 1, id: "#VSC-11111111", kind: "markdown", lang: "markdown", lines: 3, exec: "not-run", existing_outs: [], first: "# Analysis" },
                { i: 2, id: "#VSC-22222222", kind: "code", lang: "python", lines: 5, exec: "current-run #1 failed 12ms ended=2026-05-25T00:00:00.000Z", existing_outs: ["error"], first: "raise Error" },
              ],
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Notebook summary") && line.includes("2 cells")) && lines.some((line) => line.includes("#VSC-22222222") && line.includes("failed")),
      )
      expect(frame.some((line) => line.includes("Notebook:"))).toBe(false)
    },
  )
})

test("collapsed notebook summary preview surfaces late failed cells", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_summary_late_failure", 1)],
    {
      msg_notebook_summary_late_failure: [
        completedToolPart(
          "part_notebook_summary_late_failure",
          "msg_notebook_summary_late_failure",
          "vscode_notebook_summary",
          { filePath: "notebooks/long.ipynb" },
          {
            vscodeNotebook: {
              view: "summary",
              path: "notebooks/long.ipynb",
              dirty: false,
              runtime: "Python 3.11",
              cells: Array.from({ length: 19 }, (_, index) => ({
                i: index + 1,
                id: `#VSC-${String(index + 1).padStart(8, "0")}`,
                kind: index === 18 || index % 3 !== 0 ? "code" : "markdown",
                lang: index === 18 || index % 3 !== 0 ? "python" : "markdown",
                lines: 3,
                exec: index === 18 || index < 6 ? `current-run #${index + 1} failed 12ms ended=2026-05-25T00:00:00.000Z` : "not-run",
                existing_outs: index === 18 || index < 6 ? ["error"] : [],
                first: index === 18 ? "raise Error" : `cell ${index + 1}`,
              })),
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Notebook summary") && line.includes("19 cells")) &&
        lines.some((line) => line.includes("c19")) &&
        lines.some((line) => line.includes("failed")),
      )
      expect(frame.some((line) => line.includes("Click to expand"))).toBe(true)
    },
    {},
    { height: 18 },
  )
})

test("notebook env renders operation status from notebook metadata", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_env", 1)],
    {
      msg_notebook_env: [
        completedToolPart(
          "part_notebook_env",
          "msg_notebook_env",
          "vscode_notebook_env",
          { filePath: "notebooks/analysis.ipynb", operation: "configure", reason: "path with spaces | no shell" },
          {
            vscodeNotebook: {
              view: "env",
              path: "notebooks/analysis.ipynb",
              operation: "configure",
              status: "needs-selection",
              guidance: "Select a kernel manually from the notebook toolbar, then call configure to verify.",
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Notebook env") && line.includes("needs-selection")))
      expect(frame.some((line) => line.includes("Select a kernel manually"))).toBe(true)
      expect(frame.some((line) => line.includes("path with spaces | no shell"))).toBe(false)
    },
  )
})

test("notebook source, run, and output tools render rich notebook cards", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_readbacks", 1)],
    {
      msg_notebook_readbacks: [
        completedToolPart(
          "part_notebook_source",
          "msg_notebook_readbacks",
          "vscode_notebook_source",
          { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-source" },
          {
            vscodeNotebook: {
              view: "source",
              path: "notebooks/analysis.ipynb",
              target: "cell 3",
              cellId: "#VSC-source",
              returned: 2,
              totalLines: 12,
              truncated: false,
            },
          },
        ),
        completedToolPart(
          "part_notebook_run",
          "msg_notebook_readbacks",
          "vscode_notebook_run",
          { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-run" },
          {
            vscodeNotebook: {
              view: "run",
              path: "notebooks/analysis.ipynb",
              target: "cell 4",
              completed: true,
              cells: [
                {
                  i: 4,
                  id: "#VSC-run",
                  kind: "code",
                  lang: "python",
                  lines: 3,
                  exec: "current-run #4 succeeded 12ms ended=2026-05-25T00:00:00.000Z",
                  existing_outs: ["text"],
                  artifacts: [{ mime: "text/plain", bytes: 32, preview: "ok", artifactPath: ".opencode/cache/notebook-outputs/run.txt" }],
                },
              ],
            },
          },
        ),
        completedToolPart(
          "part_notebook_output",
          "msg_notebook_readbacks",
          "vscode_notebook_output",
          { filePath: "notebooks/analysis.ipynb", cellId: "#VSC-output" },
          {
            vscodeNotebook: {
              view: "output",
              path: "notebooks/analysis.ipynb",
              cell: { i: 5, id: "#VSC-output", kind: "code", lang: "python", lines: 2, existing_outs: ["png"] },
              artifacts: [{ mime: "image/png", bytes: 4096, preview: "<image/png 4096 bytes>", artifactPath: ".opencode/cache/notebook-outputs/plot.png" }],
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(
        app,
        (lines) =>
          lines.some((line) => line.includes("Notebook source")) &&
          lines.some((line) => line.includes("Notebook run") && line.includes("completed")) &&
          lines.some((line) => line.includes(".opencode/cache/notebook-outputs/run.txt")) &&
          lines.some((line) => line.includes("Notebook output") && line.includes("1 artifacts")) &&
          lines.some((line) => line.includes(".opencode/cache/notebook-outputs/plot.png")),
      )
      expect(frame.some((line) => line.includes("vscode_notebook_source ["))).toBe(false)
    },
    {},
    { height: 24 },
  )
})

test("collapsed notebook run preview surfaces late failed cells", async () => {
  await withRenderedSession(
    [assistantMessage("msg_notebook_run_late_failure", 1)],
    {
      msg_notebook_run_late_failure: [
        completedToolPart(
          "part_notebook_run_late_failure",
          "msg_notebook_run_late_failure",
          "vscode_notebook_run",
          { filePath: "notebooks/long.ipynb", cellId: "#VSC-start", endCellId: "#VSC-end" },
          {
            vscodeNotebook: {
              view: "run",
              path: "notebooks/long.ipynb",
              target: "range 1-19",
              completed: false,
              cells: Array.from({ length: 19 }, (_, index) => ({
                i: index + 1,
                id: `#VSC-${String(index + 1).padStart(8, "0")}`,
                kind: "code",
                lang: "python",
                lines: 3,
                exec: index === 18 ? "current-run #19 failed 12ms ended=2026-05-25T00:00:00.000Z" : "current-run #1 succeeded 4ms ended=2026-05-25T00:00:00.000Z",
                existing_outs: index === 18 ? ["error"] : index < 6 ? ["text"] : [],
                artifacts: index === 18
                  ? Array.from({ length: 8 }, (_, artifact) => ({
                      mime: "text/plain",
                      bytes: 32,
                      preview: `artifact ${artifact}`,
                      artifactPath: `.opencode/cache/notebook-outputs/artifact-${artifact}.txt`,
                    }))
                  : index === 17
                    ? [{ mime: "text/plain", bytes: 32, preview: "extra artifact", artifactPath: ".opencode/cache/notebook-outputs/artifact-extra.txt" }]
                    : [],
              })),
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) =>
        lines.some((line) => line.includes("Notebook run") && line.includes("failed")) &&
        lines.some((line) => line.includes("c19")) &&
        lines.some((line) => line.includes("failed")),
      )
      expect(frame.some((line) => line.includes("Click to expand"))).toBe(true)
      expect(frame.some((line) => line.includes("Artifacts: 9 available after expand"))).toBe(true)
      expect(frame.some((line) => line.includes("artifact-7.txt"))).toBe(false)
    },
    {},
    { height: 18 },
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

test("pending shell auto review navigation is owned by the status line", async () => {
  const childID = "ses_reviewer_child"
  await withRenderedSession(
    [assistantMessage("msg_shell_review_click", 1)],
    {
      msg_shell_review_click: [
        runningToolPart("part_shell_review_click", "msg_shell_review_click", "bash", {
          command: "git push origin main",
          metadata: {
            autoReview: {
              reviewID: "review_shell_click",
              sessionID: childID,
              status: "reviewing",
              precheck: { level: "cautious", reason: "git push requires reviewer approval" },
            },
          },
        }),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("git push origin main")))
      let raw = app.captureCharFrame().split("\n")
      const commandY = raw.findIndex((line) => line.includes("git push origin main"))
      const reviewY = raw.findIndex((line) => line.includes("◌ auto review · cautious"))
      expect(commandY).toBeGreaterThanOrEqual(0)
      expect(reviewY).toBeGreaterThanOrEqual(0)

      await app.mockMouse.click(11, commandY + 1)
      await app.renderOnce()
      expect(rows(app.captureCharFrame()).some((line) => line.includes("reviewer child visible"))).toBe(false)

      await app.mockMouse.click(35, reviewY + 1)

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("reviewer child visible")))
    },
    {},
    {},
    {
      [childID]: {
        info: sessionInfo({ id: childID, parentID: sessionID, title: "Auto permission review (@permission-reviewer subagent)" }),
        messages: [
          {
            ...assistantMessage("msg_reviewer_child_shell", 2),
            sessionID: childID,
            agent: "permission-reviewer",
          },
        ],
        parts: { msg_reviewer_child_shell: [textPart("part_reviewer_child_shell", "msg_reviewer_child_shell", "reviewer child visible", { sessionID: childID })] },
      },
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
      expect(findRow(frame, "✓ auto review · allowed · auth high · @permission-reviewer")).toBeLessThan(
        findRow(frame, "$ git push origin main"),
      )
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
      expect(frame.some((line) => line.includes("✓ auto review · allowed · auth high"))).toBe(true)
    },
    {},
    { height: 24 },
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

test("aborted shell auto review renders as a terminal review line", async () => {
  await withRenderedSession(
    [assistantMessage("msg_auto_review_aborted", 1)],
    {
      msg_auto_review_aborted: [
        errorToolPart(
          "part_shell_review_aborted",
          "msg_auto_review_aborted",
          "bash",
          { command: "cat id_rsa" },
          "Tool execution aborted",
          {
            interrupted: true,
            autoReview: {
              reviewID: "review_shell_aborted",
              sessionID: "ses_reviewer_child",
              status: "aborted",
              precheck: { level: "cautious", reason: "sensitive file read requires explicit approval" },
              error: "Tool execution aborted",
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("cat id_rsa")))
      const command = findRow(frame, "cat id_rsa")
      // Aborted reviews are terminal, not a still-running reviewer. The parent
      // shell card should keep the compact review row but switch from the ◌
      // reviewing marker to the same non-allow marker used by failed/denied rows.
      expect(frame[command + 1]).toContain("! auto review · aborted · @permission-reviewer")
    },
  )
})

test("read tool shows auto review status below its inline row", async () => {
  await withRenderedSession(
    [assistantMessage("msg_read_auto_review", 1)],
    {
      msg_read_auto_review: [
        completedToolPart(
          "part_read_auto_review",
          "msg_read_auto_review",
          "read",
          { filePath: "external folder/secret key.txt" },
          {
            autoReview: {
              reviewID: "review_read_done",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "external file read requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user asked for the exact file" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read external folder")))
      const row = findRow(frame, "Read external folder")
      expect(frame[row + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
    },
  )
})

test("edit block shows auto review status below its card title", async () => {
  await withRenderedSession(
    [assistantMessage("msg_edit_auto_review", 1)],
    {
      msg_edit_auto_review: [
        completedToolPart(
          "part_edit_auto_review",
          "msg_edit_auto_review",
          "edit",
          { filePath: "external folder/config.json", oldString: "old", newString: "new" },
          {
            diff: ["--- external folder/config.json", "+++ external folder/config.json", "@@", "-old", "+new"].join("\n"),
            diagnostics: {},
            autoReview: {
              reviewID: "review_edit_done",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "external edit requires reviewer approval" },
              result: { risk_level: "medium", user_authorization: "high", rationale: "user requested this edit" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Edit external folder")))
      const row = findRow(frame, "Edit external folder")
      expect(frame[row + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
    },
  )
})

test("tools without auto review metadata keep their original chrome", async () => {
  await withRenderedSession(
    [assistantMessage("msg_read_without_review", 1)],
    {
      msg_read_without_review: [completedToolPart("part_read_without_review", "msg_read_without_review", "read", { filePath: "src/local.ts" })],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read src")))
      expect(frame.some((line) => line.includes("auto review"))).toBe(false)
    },
  )
})

test("errored non-shell tools keep auto review status below the inline row", async () => {
  await withRenderedSession(
    [assistantMessage("msg_read_auto_review_error", 1)],
    {
      msg_read_auto_review_error: [
        errorToolPart(
          "part_read_auto_review_error",
          "msg_read_auto_review_error",
          "read",
          { filePath: "external folder/secret key.txt" },
          "auto reviewer denied",
          {
            autoReview: {
              reviewID: "review_read_error",
              sessionID: "ses_reviewer_child",
              status: "denied",
              precheck: { level: "cautious", reason: "external file read requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "unknown", rationale: "private key read was not authorized" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read external folder")))
      const row = findRow(frame, "Read external folder")
      expect(frame[row + 1]).toContain("! auto review · denied · high risk · auth unknown")
    },
  )
})

test("generic tools inherit the shared auto review chrome", async () => {
  await withRenderedSession(
    [assistantMessage("msg_future_tool_review", 1)],
    {
      msg_future_tool_review: [
        completedToolPart(
          "part_future_tool_review",
          "msg_future_tool_review",
          "future_tool",
          { path: "external folder/secret key.txt" },
          {
            autoReview: {
              reviewID: "review_future_tool",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "future tool external access requires reviewer approval" },
              result: { risk_level: "medium", user_authorization: "high", rationale: "user approved this external access" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("future_tool")))
      const row = findRow(frame, "future_tool")
      expect(frame[row + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
    },
  )
})

test("completed apply_patch without auto review keeps per-file blocks only", async () => {
  await withRenderedSession(
    [assistantMessage("msg_patch_without_review", 1)],
    {
      msg_patch_without_review: [
        completedToolPart(
          "part_patch_without_review",
          "msg_patch_without_review",
          "apply_patch",
          { patchText: "*** Begin Patch\n*** End Patch" },
          {
            files: [
              {
                filePath: "src/a.ts",
                relativePath: "src/a.ts",
                type: "update",
                patch: ["--- src/a.ts", "+++ src/a.ts", "@@", "-old", "+new"].join("\n"),
                additions: 1,
                deletions: 1,
              },
            ],
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Patched src/a.ts")))
      expect(frame.some((line) => line.includes("% Patch"))).toBe(false)
      expect(frame.some((line) => line.includes("auto review"))).toBe(false)
    },
  )
})

test("completed apply_patch with delete file shows diff content and stats in title", async () => {
  await withRenderedSession(
    [assistantMessage("msg_patch_delete_diff", 1)],
    {
      msg_patch_delete_diff: [
        completedToolPart(
          "part_patch_delete_diff",
          "msg_patch_delete_diff",
          "apply_patch",
          { patchText: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch" },
          {
            files: [
              {
                filePath: "/tmp/test/src/old.ts",
                relativePath: "src/old.ts",
                type: "delete",
                // 删除文件的 patch 是带有完整 - 行的 unified diff，
                // DiffView 应将其逐行渲染而非降级为纯 -N lines 摘要。
                // "KEEP_THIS" 用作断言锚点，确保 diff 内容真实可见。
                patch: ["--- src/old.ts", "+++ src/old.ts", "@@ -1,3 +0,0 @@", "-KEEP_THIS_first", "-KEEP_THIS_second", "-KEEP_THIS_third", "\\ No newline at end of file"].join("\n"),
                additions: 0,
                deletions: 3,
              },
            ],
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Deleted src/old.ts")))
      // 标题应包含 +0 -3 行数统计，与 add/update/write/edit 风格一致
      const titleLine = findRow(frame, "Deleted src/old.ts")
      expect(frame[titleLine]).toContain("+0")
      expect(frame[titleLine]).toContain("-3")
      // 删除文件的 patch 通过 DiffView 渲染后，应能直接看到删除内容行，
      // 而非只有纯文本 '-N lines' 摘要（摘要只在 legacy 无 patch 时兜底）。
      // KEEP_THIS 是 patch fixture 中的唯一锚点文本，出现在任何行即证明 diff 已渲染。
      expect(frame.some((line) => line.includes("KEEP_THIS"))).toBe(true)
    },
  )
})

test("completed apply_patch with delete file and no patch falls back to -N lines", async () => {
  await withRenderedSession(
    [assistantMessage("msg_patch_delete_legacy", 1)],
    {
      msg_patch_delete_legacy: [
        completedToolPart(
          "part_patch_delete_legacy",
          "msg_patch_delete_legacy",
          "apply_patch",
          { patchText: "*** Begin Patch\n*** Delete File: src/stale.ts\n*** End Patch" },
          {
            files: [
              {
                filePath: "/tmp/test/src/stale.ts",
                relativePath: "src/stale.ts",
                type: "delete",
                // 旧格式 metadata 可能没有 patch 字段，此时应退回 -N lines 文本摘要
                additions: 0,
                deletions: 5,
              },
            ],
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Deleted src/stale.ts")))
      // legacy 数据无 patch 时标题不显示 stats（diffLineStats 无数据可算）
      const titleLine = findRow(frame, "Deleted src/stale.ts")
      expect(frame[titleLine]).not.toContain("+0")
      expect(frame[titleLine]).not.toContain("-5")
      // 退回纯 -N lines 摘要作为兜底
      expect(frame.some((line) => line.includes("-5 lines"))).toBe(true)
    },
  )
})

test("shell auto review status is not duplicated by generic tool chrome", async () => {
  await withRenderedSession(
    [assistantMessage("msg_shell_no_duplicate", 1)],
    {
      msg_shell_no_duplicate: [
        completedToolPart(
          "part_shell_no_duplicate",
          "msg_shell_no_duplicate",
          "bash",
          { command: "git push origin main" },
          {
            output: "pushed",
            autoReview: {
              reviewID: "review_shell_no_duplicate",
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
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("git push origin main")))
      expect(frame.filter((line) => line.includes("✓ auto review · allowed · auth high · @permission-reviewer"))).toHaveLength(1)
    },
  )
})

test("shell block uses default review placement above the command", async () => {
  await withRenderedSession(
    [assistantMessage("msg_shell_default_review", 1)],
    {
      msg_shell_default_review: [
        completedToolPart(
          "part_shell_default_review",
          "msg_shell_default_review",
          "bash",
          { command: 'Get-Content "$env:USERPROFILE\\.ssh\\id_rsa" 2>&1', description: "Read id_rsa via shell" },
          {
            output: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret",
            autoReview: {
              reviewID: "review_shell_default",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "private key access requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user asked for the exact file" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read id_rsa via shell")))
      const title = findRow(frame, "Read id_rsa via shell")
      expect(frame[title + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
      expect(findRow(frame, "Get-Content")).toBeGreaterThan(title + 1)
    },
  )
})

test("running shell output card keeps review placement below the title", async () => {
  await withRenderedSession(
    [assistantMessage("msg_shell_running_review", 1)],
    {
      msg_shell_running_review: [
        runningToolPart("part_shell_running_review", "msg_shell_running_review", "bash", {
          command: 'Get-Content "$env:USERPROFILE\\.ssh\\id_rsa" 2>&1',
          description: "Read SSH private key via shell",
          metadata: {
            output: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret",
            description: "Read SSH private key via shell",
            autoReview: {
              reviewID: "review_shell_running",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "private key access requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user asked for the exact file" },
            },
          },
        }),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read SSH private key via shell")))
      const title = findRow(frame, "Read SSH private key via shell")
      // Running shell cards use the same BlockTool review slot as completed
      // cards. This guards the real streaming state where shell output metadata
      // already exists but the command has not reached a completed tool result.
      expect(frame[title + 1]).toContain("✓ auto review · allowed · auth high · @permission-reviewer")
      expect(findRow(frame, "Get-Content")).toBeGreaterThan(title + 1)
    },
  )
})

test("multi-file apply_patch renders one auto review status for the whole patch", async () => {
  await withRenderedSession(
    [assistantMessage("msg_patch_auto_review", 1)],
    {
      msg_patch_auto_review: [
        completedToolPart(
          "part_patch_auto_review",
          "msg_patch_auto_review",
          "apply_patch",
          { patchText: "*** Begin Patch\n*** End Patch" },
          {
            files: [
              {
                filePath: "external/a.ts",
                relativePath: "external/a.ts",
                type: "update",
                patch: ["--- external/a.ts", "+++ external/a.ts", "@@", "-old", "+new"].join("\n"),
                additions: 1,
                deletions: 1,
              },
              {
                filePath: "external/b.ts",
                relativePath: "external/b.ts",
                type: "add",
                patch: ["--- external/b.ts", "+++ external/b.ts", "@@", "+created"].join("\n"),
                additions: 1,
                deletions: 0,
              },
            ],
            autoReview: {
              reviewID: "review_patch_done",
              sessionID: "ses_reviewer_child",
              status: "allowed",
              precheck: { level: "cautious", reason: "external patch requires reviewer approval" },
              result: { risk_level: "medium", user_authorization: "high", rationale: "user requested this patch" },
            },
          },
        ),
      ],
    },
    async (app) => {
      const frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Patched external/a.ts")))
      const reviewRows = frame.filter((line) => line.includes("✓ auto review · allowed · auth high · @permission-reviewer"))
      expect(reviewRows).toHaveLength(1)
      expect(findRow(frame, "✓ auto review · allowed · auth high · @permission-reviewer")).toBeLessThan(
        findRow(frame, "Patched external/a.ts"),
      )
    },
  )
})

test("non-shell auto review status opens the reviewer child session", async () => {
  const childID = "ses_reviewer_child"
  await withRenderedSession(
    [assistantMessage("msg_read_review_click", 1)],
    {
      msg_read_review_click: [
        completedToolPart(
          "part_read_review_click",
          "msg_read_review_click",
          "read",
          { filePath: "external folder/secret key.txt" },
          {
            autoReview: {
              reviewID: "review_read_click",
              sessionID: childID,
              status: "allowed",
              precheck: { level: "cautious", reason: "external file read requires reviewer approval" },
              result: { risk_level: "high", user_authorization: "high", rationale: "user asked for the exact file" },
            },
          },
        ),
      ],
    },
    async (app) => {
      await waitForFrame(app, (lines) => lines.some((line) => line.includes("Read external folder")))
      await clickVisibleText(app, "✓ auto review · allowed · auth high · @permission-reviewer")

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("reviewer child visible")))
    },
    {},
    {},
    {
      [childID]: {
        info: sessionInfo({ id: childID, parentID: sessionID, title: "Auto permission review (@permission-reviewer subagent)" }),
        messages: [
          {
            ...assistantMessage("msg_reviewer_child", 2),
            sessionID: childID,
            agent: "permission-reviewer",
          },
        ],
        parts: { msg_reviewer_child: [textPart("part_reviewer_child", "msg_reviewer_child", "reviewer child visible", { sessionID: childID })] },
      },
    },
  )
})

test("block auto review click opens reviewer without toggling the tool card", async () => {
  const childID = "ses_reviewer_child"
  await withRenderedSession(
    [assistantMessage("msg_edit_review_click", 1)],
    {
      msg_edit_review_click: [
        completedToolPart(
          "part_edit_review_click",
          "msg_edit_review_click",
          "edit",
          { filePath: "external folder/config.json", oldString: "old", newString: "new" },
          {
            diff: Array.from({ length: 30 }, (_, index) => `+line ${index}`).join("\n"),
            diagnostics: {},
            autoReview: {
              reviewID: "review_edit_click",
              sessionID: childID,
              status: "allowed",
              precheck: { level: "cautious", reason: "external edit requires reviewer approval" },
              result: { risk_level: "medium", user_authorization: "high", rationale: "user requested this edit" },
            },
          },
        ),
      ],
    },
    async (app) => {
      let frame = await waitForFrame(app, (lines) => lines.some((line) => line.includes("Click to expand")))
      await clickVisibleText(app, "✓ auto review · allowed · auth high")

      await waitForFrame(app, (lines) => lines.some((line) => line.includes("reviewer child visible")))
      frame = rows(app.captureCharFrame())
      expect(frame.some((line) => line.includes("Click to collapse"))).toBe(false)
    },
    {},
    {},
    {
      [childID]: {
        info: sessionInfo({ id: childID, parentID: sessionID, title: "Auto permission review (@permission-reviewer subagent)" }),
        messages: [
          {
            ...assistantMessage("msg_reviewer_child_block", 2),
            sessionID: childID,
            agent: "permission-reviewer",
          },
        ],
        parts: { msg_reviewer_child_block: [textPart("part_reviewer_child_block", "msg_reviewer_child_block", "reviewer child visible", { sessionID: childID })] },
      },
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

async function waitForDistinctSpanColors(
  app: Awaited<ReturnType<typeof testRender>>,
  lineText: string,
  leftText: string,
  rightText: string,
) {
  const start = Date.now()

  for (;;) {
    await app.renderOnce()
    const line = app.captureSpans().lines.find((item) =>
      item.spans.map((span) => span.text).join("").includes(lineText),
    )
    const left = line?.spans.find((span) => span.text.includes(leftText))
    const right = line?.spans.find((span) => span.text.includes(rightText))
    // Tree-sitter 高亮由 OpenTUI worker 异步回填，字符帧先出现不代表颜色已稳定；
    // 这里等待同一可见行里的两个语法片段呈现不同前景色，`leftText`/`rightText`
    // 只描述用户可见 token，不绑定 parser 名称、查询文件或内部 capture 结构。
    if (left && right && JSON.stringify(left.fg) !== JSON.stringify(right.fg)) break
    if (Date.now() - start > 2_000) {
      expect(left?.fg).not.toEqual(right?.fg)
      break
    }
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

async function clickVisibleText(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const raw = app.captureCharFrame().split("\n")
  const y = raw.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = raw[y].indexOf(text)
  expect(x).toBeGreaterThanOrEqual(0)
  // Click inside the rendered label rather than at a fixed column. The exact
  // gutter can shift between OpenTUI renderers in the same process on Linux, but
  // the user-visible label is the stable behaviour this test cares about.
  await app.mockMouse.click(x + 1, y + 1)
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

function partUpdatedEvent(id: string, part: Extract<Part, { type: "tool" }>): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.updated",
      properties: { sessionID, part, time: 2 },
    },
  }
}
