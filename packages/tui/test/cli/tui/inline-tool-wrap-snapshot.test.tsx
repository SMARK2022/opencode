import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createContext, createEffect, createMemo, createSignal, For, Match, Show, Switch, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { BoxRenderable, MouseButton, type ScrollBoxRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import stripAnsi from "strip-ansi"
import { SplitBorder } from "../../../src/ui/border"
import { selectedForeground } from "../../../src/context/theme"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import {
  formatCompletedSubagentDetail,
  formatSubagentRetry,
  formatSubagentTitle,
  formatSubagentToolcalls,
  InlineToolRow,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
  alwaysSeparate,
  toolDisplay,
  autoReviewLabel,
} from "../../../src/routes/session"
import { layoutGroups } from "../../../src/util/layout"
import { collapseToolOutput } from "../../../src/util/collapse-tool-output"
import { goalContinuation } from "../../../src/routes/session/goal-continuation"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function ShellOutput() {
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      marginTop={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <box gap={1}>
        <text>$ ls</text>
        <text>file.ts</text>
      </box>
    </box>
  )
}

function UserMessage() {
  return (
    <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2}>
        <text>Check whether the next tool remains separated.</text>
      </box>
    </box>
  )
}

function Fixture(props: { errorExpanded?: boolean; before?: "shell" | "user" }) {
  return (
    <box flexDirection="column" width={72}>
      {props.before === "shell" && <ShellOutput />}
      {props.before === "user" && <UserMessage />}
      {/* 用户和工具分属不同消息，沿用旧快照才能捕获新增分组吞掉边界空行。 */}
      <box flexDirection="column" flexShrink={0} ref={(el: BoxRenderable) => layoutGroups.add(el)}>
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function TaskRowsFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="✱" complete={true} pending="">
        Grep "Task" (2 matches)
      </InlineToolRow>
      <InlineToolRow icon="⠙" complete={true} pending="" separate={true}>
        Explore Task — Inspect active task spacing
      </InlineToolRow>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"General Task — Confirm completed task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </box>
  )
}

function LoadedReadBeforeTaskFixture() {
  return (
    <box flexDirection="column" width={72}>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
      <box paddingLeft={3}>
        <text paddingLeft={3}>↳ Loaded src/cli/cmd/tui/routes/session/tools.tsx</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="" separate={true}>
        {"Explore Task — Inspect active task spacing\n↳ 1 toolcall · 501ms"}
      </InlineToolRow>
    </box>
  )
}

function AssistantSummaryBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
        <text>▣ Build · Little Frank · 53.1s</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
      </InlineToolRow>
    </box>
  )
}

function AssistantErrorBeforeInlineFixture() {
  return (
    <box flexDirection="column" width={72}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        border={["left"]}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
      >
        <text>Managed inference requires an active Member plan</text>
      </box>
      <InlineToolRow icon="✓" complete={true} pending="">
        {"Build Task — Review changes\n↳ 48 toolcalls · 1m 40s"}
      </InlineToolRow>
    </box>
  )
}

function StickyScrollFixture(props: { separated: boolean; scroll: (scroll: ScrollBoxRenderable) => void }) {
  return (
    <scrollbox ref={props.scroll} stickyScroll={true} stickyStart="bottom" height={3} width={72}>
      <box height={1}>
        <text>First row</text>
      </box>
      <box height={1}>
        <text>Second row</text>
      </box>
      <Show when={props.separated}>
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)}>
          <text>Assistant text</text>
        </box>
      </Show>
      <InlineToolRow icon="→" complete={true} pending="">
        Read src/cli/cmd/tui/routes/session/index.tsx
      </InlineToolRow>
    </scrollbox>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch…" failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file…" failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

// 新增真实点击用例复用可见文本坐标，避免布局变化把操作落到父卡片。
function findVisibleText(frame: string[], text: string) {
  const y = frame.findIndex((line) => line.includes(text))
  if (y < 0) return undefined
  const x = frame[y].indexOf(text)
  if (x < 0) return undefined
  return { x, y }
}


describe("TUI inline tool wrapping", () => {
  test("separates assistant groups without separating tools inside one group", async () => {
    // 使用生产行和实际布局，空组不能吞掉边界或给同组工具增加空行。
    const frame = await renderFrame(
      () => (
        <box flexDirection="column" width={40}>
          <For each={["A", "", "B"]}>{(label) => (
            <box flexDirection="column" ref={(el: BoxRenderable) => layoutGroups.add(el)}>
              <Show when={label}>
                <InlineToolRow icon="→" complete={true} pending="">{label}1</InlineToolRow>
                <InlineToolRow icon="→" complete={true} pending="">{label}2</InlineToolRow>
              </Show>
            </box>
          )}</For>
        </box>
      ),
      { width: 40, height: 8 },
    )
    // 首个工具真实占一行消息顶距，组内紧排和跨消息分隔仍由下面的断言验证。
    expect(frame.split("\n")[0]).toBe("")
    expect(frame).toMatch(/A1\n[^\n]*A2\n\n[^\n]*B1\n[^\n]*B2/)
  })

  test("falls back for unknown tool names", () => {
    expect(toolDisplay("bash")).toBe("bash")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("pending fallback renders string pending with tilde prefix", async () => {
    // #187：string pending 走单一 text 节点，complete 前保留 ~ 占位（B-01 修复）
    const frame = await renderFrame(() => <InlineToolRow icon="←" complete={false} pending="Preparing write…">Write src/a.ts</InlineToolRow>, { width: 60, height: 3 })
    expect(frame).toContain("~ Preparing write…")
    // #187：pending 态 label 未就绪，仅 ~ 占位（complete/failed 分支才显示 label）
  })

  test("pending fallback renders JSX stats fragment directly", async () => {
    // #187：使用生产工具的裸文本/span 形态，不能让测试自带 text 父节点掩盖容器错误。
    const frame = await renderFrame(
      () => (
        <InlineToolRow icon="←" complete={false} pending={<>Edit src/b.ts<span> -2</span><span> +1</span></>}>
          Edit src/b.ts
        </InlineToolRow>
      ),
      { width: 60, height: 3 },
    )
    expect(frame).toContain("-2 +1")
    // #187：pending 态 label 未就绪；JSX 片段与 ~ 前缀同行渲染
  })

  test("keeps boxed auto review below pending and completed tool text", async () => {
    const [complete, setComplete] = createSignal(false)
    // 审查行使用真实 box，原生渲染器会拒绝把它嵌入正文 text。
    const frame = await renderFrame(
      () => (
        <InlineToolRow
          icon="$"
          complete={complete()}
          pending="Writing command"
          review={
            <box>
              <text>auto review</text>
            </box>
          }
        >
          echo hello
        </InlineToolRow>
      ),
      { width: 72, height: 4 },
    )
    expect(frame.split("\n").map((line) => line.trim())).toEqual(["", "~ Writing command", "auto review"])

    setComplete(true)
    await testSetup!.renderOnce()
    await testSetup!.renderOnce()
    expect(
      testSetup!
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(["$ echo hello", "auto review"])
  })

  test.serial.each(["read", "edit"] as const)("auto review preserves %s card actions and narrow user layout", async (kind) => {
    const require = createRequire(import.meta.resolve("@opentui/solid"))
    const runtime = { ...(await import("solid-js")), ...(await import("@opentui/solid")) }
    const source = await Bun.file(new URL("../../../src/routes/session/index.tsx", import.meta.url)).text()
    // 沿用 #212 的生产源码执行边界，编译真实组件，不另写点击或布局算法。
    const names = [
      "UserMessage",
      "useInteraction",
      "autoReviewColor",
      "autoReviewLineID",
      "autoReviewLabelID",
      "autoReviewLineTarget",
      "AutoReviewLine",
      "ToolAutoReviewLine",
      "InlineTool",
      "BlockTool",
      "Shell",
      "previewText",
      "stringValue",
      "openAutoReviewSession",
      "openAutoReviewFromToolChrome",
    ]
    const functions = names.map((name) => {
      const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}(?=\\r?\\n|$)`))?.[0]
      expect(found).toBeDefined()
      return found!
    })
    const compiler = require("@babel/core") as {
      transformSync(source: string, options: Record<string, unknown>): { code?: string } | null
    }
    // 编译实际模块常量，不能在 fixture 另写一套字符预算。
    const budget = source.match(/^const DEFAULT_BLOCK_CHAR_THRESHOLD = \d+$/m)?.[0]
    expect(budget).toBeDefined()
    const compiled = compiler.transformSync([budget, ...functions].join("\n"), {
      filename: "session-review-fixture.tsx",
      configFile: false,
      babelrc: false,
      presets: [[require("babel-preset-solid"), { generate: "universal", moduleName: "@opentui/solid" }]],
      plugins: [[require("@babel/plugin-transform-typescript"), { isTSX: true }]],
    })?.code
    expect(compiled).toBeDefined()
    const code = compiled!.replace(
      /import \{([\s\S]*?)\} from "(?:@opentui\/solid|solid-js)";/g,
      (_: string, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = runtime;`,
    )
    expect(code).not.toMatch(/\bimport\s/)
    const review = {
      tool: kind,
      reviewID: "review_click", sessionID: "ses_reviewer_child", status: "allowed",
      result: { risk_level: "high", user_authorization: "high", rationale: "user requested this action" },
    } as const
    // 导航夹具保留可选锚点，普通 Session 导航仍可省略。
    const navigation: { type: string; sessionID: string; reviewID?: string }[] = []
    const navigate = (route: { type: string; sessionID: string; reviewID?: string }) => navigation.push(route)
    const [expanded, setExpanded] = createSignal(false)
    let parentClicks = 0
    const ToolAutoReview = createContext(() => review)
    // 真实组件通过响应式属性重绘，普通对象无法验证点击后的展开状态。
    const [interaction, setInteraction] = createStore<Record<string, boolean>>({})
    const theme = createTuiPluginApi().theme.current
    const dependencies = {
      createEffect,
      createMemo,
      createSignal,
      on: runtime.on,
      useContext,
      Show,
      For,
      Match,
      Switch,
      InlineToolRow,
      alwaysSeparate,
      SplitBorder,
      selectedForeground,
      MouseButton,
      collapseToolOutput,
      // 执行生产 JSX 时注入同一个纯函数，避免另写 Goal 卡片判定。
      goalContinuation,
      stripAnsi,
      autoReviewLabel,
      ToolAutoReview,
      useRenderer: runtime.useRenderer,
      useTheme: () => ({ theme }),
      useRoute: () => ({ navigate }),
      use: () => ({
        sessionID: "ses_render", showTimestamps: () => false, width: 72,
        messageView: () => undefined,
        pinnedMessages: () => new Set<string>(),
        markMessageDirty: () => {},
        interaction: {
          get: (key: string) => interaction[key] ?? false,
          set: (key: string, value: boolean) => setInteraction(key, value),
        },
      }),
      usePathFormatter: () => ({ format: (value: string) => value }),
      useLocal: () => ({ agent: { color: () => theme.text } }),
      useSync: () => ({ data: { permission: {} } }),
    }
    const production = new Function(
      "runtime",
      "dependencies",
      `const {${Object.keys(dependencies).join(",")}} = dependencies;\n${code}\nreturn {UserMessage, InlineTool, BlockTool, Shell, openAutoReviewSession, openAutoReviewFromToolChrome};`,
    )(runtime, dependencies) as Record<"UserMessage" | "InlineTool" | "BlockTool" | "Shell", (props: Record<string, unknown>) => JSX.Element> &
      Record<"openAutoReviewSession" | "openAutoReviewFromToolChrome", (...args: unknown[]) => boolean>
    const Card = kind === "edit" ? production.BlockTool : production.InlineTool
    await renderFrame(
      () => (
        <ToolAutoReview.Provider value={() => review}>
          <Card
            title="Edit external folder/config.json with a long wrapped title that spans another row"
            icon="→"
            complete={true}
            pending=""
            part={{ tool: kind, state: { status: "completed" } }}
            preview={kind === "edit" && !expanded() ? <text>diff preview</text> : undefined}
            onClick={() => {
              parentClicks++
              setExpanded((value) => !value)
            }}
          >
            {kind === "edit" ? <text>expanded diff body</text> : "Read external folder/secret key.txt"}
          </Card>
        </ToolAutoReview.Provider>
      ),
      { width: 72, height: 18 },
    )
    const app = testSetup!
    const label = autoReviewLabel(review)
    const point = findVisibleText(app.captureCharFrame().split("\n"), label)
    expect(point).toBeDefined()
    const reviewTarget = app.renderer.root.findDescendantById(`auto-review-${review.reviewID}`)
    expect(reviewTarget).toBeInstanceOf(BoxRenderable)
    expect(reviewTarget!.height).toBe(1)
    expect(reviewTarget!.screenY).toBe(point!.y)
    expect(reviewTarget!.getChildren()[0].selectable).toBe(false)
    // #292：使用原生零基坐标，先进入标签再点击，避免误中父卡 hitbox。
    app.renderer.clearSelection()
    await app.mockMouse.moveTo(point!.x + Math.floor(label.length / 2), point!.y)
    await app.renderOnce()
    await app.mockMouse.click(point!.x + Math.floor(label.length / 2), point!.y)
    // 状态行点击必须携带精确审查锚点，不能退回子会话末尾。
    expect(navigation).toEqual([{ type: "session", sessionID: "ses_reviewer_child", reviewID: "review_click" }])
    expect(parentClicks).toBe(0)
    expect(expanded()).toBe(false)
    if (kind === "edit") expect(app.captureCharFrame()).toContain("Click to expand")
    navigation.length = 0
    await app.mockMouse.click(reviewTarget!.screenX + reviewTarget!.width - 1, reviewTarget!.screenY)
    expect(navigation).toEqual([{ type: "session", sessionID: "ses_reviewer_child", reviewID: "review_click" }])
    expect(parentClicks).toBe(0)
    expect(expanded()).toBe(false)
    navigation.length = 0
    // 明确点击审查入口会清除旧选区；缺少子会话或命中无关目标仍不导航。
    const effects: string[] = []
    const evt = { preventDefault: () => effects.push("default"), stopPropagation: () => effects.push("bubble"), target: app.renderer.root, y: -1 }
    const selected = { getSelection: () => ({ getSelectedText: () => "selected review" }), clearSelection: () => effects.push("clear") }
    expect(production.openAutoReviewSession(review, navigate, selected, evt)).toBe(true)
    expect(effects).toEqual(["default", "bubble", "clear"])
    expect(navigation).toEqual([{ type: "session", sessionID: "ses_reviewer_child", reviewID: "review_click" }])
    navigation.length = 0
    expect(production.openAutoReviewSession({ ...review, sessionID: undefined }, navigate, app.renderer, evt)).toBe(false)
    expect(production.openAutoReviewFromToolChrome(review, navigate, app.renderer, evt)).toBe(false)
    expect(production.openAutoReviewFromToolChrome(review, navigate, app.renderer, undefined)).toBe(false)
    expect(navigation).toEqual([])
    expect(production.openAutoReviewSession(review, navigate, app.renderer)).toBe(true)
    expect(navigation).toEqual([{ type: "session", sessionID: "ses_reviewer_child", reviewID: "review_click" }])
    navigation.length = 0
    const rowEvent = { ...evt, y: reviewTarget!.screenY }
    for (const target of [reviewTarget!, reviewTarget!.getChildren()[0], reviewTarget!.parent!]) {
      expect(production.openAutoReviewFromToolChrome(review, navigate, app.renderer, { ...rowEvent, target })).toBe(true)
      expect(navigation).toEqual([{ type: "session", sessionID: "ses_reviewer_child", reviewID: "review_click" }])
      navigation.length = 0
    }
    // 相邻行仍属于标题或正文，不能把零基坐标再减一。
    expect(production.openAutoReviewFromToolChrome(review, navigate, app.renderer, { ...rowEvent, y: reviewTarget!.screenY - 1 })).toBe(false)
    expect(production.openAutoReviewFromToolChrome(review, navigate, app.renderer, { ...rowEvent, y: reviewTarget!.screenY + 1 })).toBe(false)
    expect(navigation).toEqual([])
    // 标题和正文仍执行父卡动作，审查导航不能扩展成整卡点击。
    const title = findVisibleText(app.captureCharFrame().split("\n"), kind === "edit" ? "Edit external folder/config.json" : "Read external folder/secret key.txt")
    expect(title).toBeDefined()
    app.renderer.clearSelection()
    await app.mockMouse.moveTo(title!.x + 1, title!.y)
    await app.renderOnce()
    await app.mockMouse.click(title!.x + 1, title!.y)
    await app.renderOnce()
    await app.renderOnce()
    expect(navigation).toEqual([])
    expect(parentClicks).toBe(1)
    if (kind === "edit") {
      const body = findVisibleText(app.captureCharFrame().split("\n"), "expanded diff body")
      expect(body).toBeDefined()
      await app.mockMouse.moveTo(body!.x + 1, body!.y)
      await app.renderOnce()
      await app.mockMouse.click(body!.x + 1, body!.y)
      expect(navigation).toEqual([])
      expect(parentClicks).toBe(2)
    }
    app.renderer.destroy()
    // 可见诊断只保留一份，右键模型上下文仍须显示独立的退出状态。
    if (kind === "edit") {
      const visible = "fatal: visible root cause"
      const notice = '<opencode_notice type="execution" source="shell" severity="error" reason="exit" exit_code="9" />'
      await renderFrame(
        () => (
          <production.Shell
            input={{ command: "failed command" }}
            metadata={{ output: visible }}
            output={`${visible}\n${notice}`}
            part={{ id: "part_shell_error", tool: "shell", state: { status: "completed" } }}
          />
        ),
        { width: 160, height: 12 },
      )
      const shell = testSetup!
      const diagnostic = findVisibleText(shell.captureCharFrame().split("\n"), visible)
      expect(diagnostic).toBeDefined()
      // 实际生产组件在普通/上下文视图中都只留一行分隔，不靠源码中的 gap 字样判定。
      const command = findVisibleText(shell.captureCharFrame().split("\n"), "$ failed command")
      expect(command).toBeDefined()
      expect((diagnostic?.y ?? -1) - (command?.y ?? -1)).toBe(2)
      expect(shell.captureCharFrame()).not.toContain('reason="exit"')
      expect(shell.captureCharFrame()).not.toContain("<bash_high_signal_excerpt>")
      shell.renderer.clearSelection()
      await shell.mockMouse.moveTo(diagnostic!.x + 1, diagnostic!.y)
      await shell.renderOnce()
      await shell.mockMouse.click(diagnostic!.x + 1, diagnostic!.y, MouseButton.RIGHT)
      await shell.renderOnce()
      await shell.renderOnce()
      const context = shell.captureCharFrame()
      expect(context).not.toContain("Model context output")
      expect(context).toContain("returned to model")
      const contextCommand = findVisibleText(context.split("\n"), "$ failed command")
      const contextOutput = findVisibleText(context.split("\n"), visible)
      expect((contextOutput?.y ?? -1) - (contextCommand?.y ?? -1)).toBe(2)
      expect(context.split(visible)).toHaveLength(2)
      expect(context).toContain(notice)
      expect(context).not.toContain("<bash_high_signal_excerpt>")
      expect(navigation).toEqual([])
      shell.renderer.destroy()
      // 空输出的大内联命令必须可展开；真实组件的点击不能只由字符串断言代替。
      await renderFrame(
        () => <production.Shell input={{ command: `echo ${"x".repeat(1100)} TAIL` }} metadata={{ output: "" }} part={{ id: "part_shell_long", tool: "shell", state: { status: "completed" } }} />,
        { width: 72, height: 32 },
      )
      const longShell = testSetup!
      const collapsedCommand = longShell.captureCharFrame()
      expect(collapsedCommand).toContain("Click to expand")
      expect(collapsedCommand).not.toContain("TAIL")
      const commandPoint = findVisibleText(collapsedCommand.split("\n"), "$ echo")
      expect(commandPoint).toBeDefined()
      longShell.renderer.clearSelection()
      await longShell.mockMouse.moveTo(commandPoint!.x + 1, commandPoint!.y)
      await longShell.renderOnce()
      await longShell.mockMouse.click(commandPoint!.x + 1, commandPoint!.y)
      await longShell.renderOnce()
      await longShell.renderOnce()
      expect(longShell.captureCharFrame().replace(/[┃\s]/g, "")).toContain("TAIL")
      expect(longShell.captureCharFrame()).toContain("Click to collapse")
      longShell.renderer.clearSelection()
      await longShell.mockMouse.click(commandPoint!.x + 1, commandPoint!.y)
      await longShell.renderOnce()
      await longShell.renderOnce()
      expect(longShell.captureCharFrame()).not.toContain("TAIL")
      expect(longShell.captureCharFrame()).toContain("Click to expand")
      longShell.renderer.destroy()
    }
    let scroll: ScrollBoxRenderable | undefined
    // 窄屏加载生产 UserMessage，断言真实外框高度和回绕边框，而非复制一个 box。
    const frame = await renderFrame(
      () => (
        <scrollbox ref={(value) => (scroll = value)} width={52} height={8}>
          <production.UserMessage
            message={{ id: "msg_user_narrow", agent: "build", time: { created: 0 } }}
            parts={[{ type: "text", text: "keep this user request visible with wrapped detail for this narrow viewport" }]}
            index={0}
            onMouseUp={() => {}}
          />
          <text>assistant remains below user</text>
          <text>{"later assistant detail\n".repeat(12)}</text>
        </scrollbox>
      ),
      { width: 52, height: 8 },
    )
    const lines = frame.split("\n")
    const user = findVisibleText(lines, "keep this user request visible")
    const wrapped = findVisibleText(lines, "narrow viewport")
    const assistant = findVisibleText(lines, "assistant remains below user")
    expect(user).toBeDefined()
    expect(wrapped).toBeDefined()
    expect(assistant).toBeDefined()
    expect(wrapped!.y).toBeGreaterThan(user!.y)
    expect(lines[user!.y]).toMatch(/^┃/)
    expect(lines[wrapped!.y]).toMatch(/^┃/)
    expect(assistant!.y).toBeGreaterThan(wrapped!.y)
    const card = scroll!.getChildren().find((item) => item.id === "msg_user_narrow")
    expect(card).toBeInstanceOf(BoxRenderable)
    expect(card!.height).toBeGreaterThanOrEqual(4)
    expect(card!.screenY + card!.height).toBeLessThanOrEqual(assistant!.y)
    expect(scroll!.scrollHeight).toBeGreaterThan(scroll!.viewport.height)
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0 },
      ]),
    ).toEqual([
      { type: "add", relativePath: "a.ts", filePath: "a.ts", patch: "diff", deletions: 0, movePath: undefined },
    ])
    expect(parseTodos([null, { status: "pending" }, { status: "pending", content: "Safe" }])).toEqual([
      { status: "pending", content: "Safe" },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("formats completed subagent toolcall details", () => {
    expect(formatCompletedSubagentDetail(0, "501ms")).toBe("501ms")
    expect(formatCompletedSubagentDetail(1, "501ms")).toBe("1 toolcall · 501ms")
    expect(formatCompletedSubagentDetail(2, "501ms")).toBe("2 toolcalls · 501ms")
    expect(formatSubagentToolcalls(0)).toBe("0 toolcalls")
  })

  test("keeps background state attached to the subagent identity", () => {
    expect(formatSubagentTitle("Explore", "Inspect renderer", false)).toBe("Explore Task — Inspect renderer")
    expect(formatSubagentTitle("Explore", "Inspect renderer", true)).toBe(
      "Explore Task (background) — Inspect renderer",
    )
  })

  test("keeps retry status ahead of wrapping messages", () => {
    expect(formatSubagentRetry(2, "Rate limited by provider")).toBe("Retrying (attempt 2) · Rate limited by provider")
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("keeps separation after a shell output block", async () => {
    expect(await renderFrame(() => <Fixture before="shell" />, { width: 72, height: 16 })).toMatchSnapshot()
  })

  test("keeps separation after a padded user message", async () => {
    expect(await renderFrame(() => <Fixture before="user" />, { width: 72, height: 14 })).toMatchSnapshot()
  })

  test("separates after a multi-line task row", async () => {
    expect(await renderFrame(() => <TaskRowsFixture />, { width: 72, height: 10 })).toMatchSnapshot()
  })

  test("separates a task row from a preceding inline detail", async () => {
    expect(await renderFrame(() => <LoadedReadBeforeTaskFixture />, { width: 72, height: 8 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant summary", async () => {
    expect(await renderFrame(() => <AssistantSummaryBeforeInlineFixture />, { width: 72, height: 5 })).toMatchSnapshot()
  })

  test("separates an inline row from the previous assistant error", async () => {
    expect(await renderFrame(() => <AssistantErrorBeforeInlineFixture />, { width: 72, height: 7 })).toMatchSnapshot()
  })

  test("updates sticky-bottom geometry when a text separator mounts and unmounts", async () => {
    const [separated, setSeparated] = createSignal(false)
    let scroll: ScrollBoxRenderable | undefined
    testSetup = await testRender(
      () => <StickyScrollFixture separated={separated()} scroll={(value) => (scroll = value)} />,
      {
        width: 72,
        height: 3,
      },
    )

    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(true)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(5)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))

    setSeparated(false)
    await testSetup.renderOnce()
    expect(scroll?.scrollHeight).toBe(3)
    expect(scroll?.scrollTop).toBe(Math.max(0, scroll!.scrollHeight - scroll!.viewport.height))
  })
})
