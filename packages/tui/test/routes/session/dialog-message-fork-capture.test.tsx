/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useRenderer } from "@opentui/solid"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogMessage } from "../../../src/routes/session/dialog-message"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { directory, json, mount, wait } from "../../cli/cmd/tui/sync-fixture"

// 这是await前捕获及空桶处理的源码合同补充，不替代真实交互Fork行为验证。
const source = readFileSync(path.join(import.meta.dir, "../../../src/routes/session/dialog-message.tsx"), "utf8")

describe("dialog message fork/revert capture window contracts", () => {
  test("Retry captures prompt info before the abort/revert awaits", () => {
    // 捕获语句必须出现在 abort await 之前：两条语句在源码中的先后顺序即运行时执行顺序。
    const captureAt = source.indexOf("const promptInfo = extractPromptInfo(msg.id)")
    const abortAt = source.indexOf("await sdk.client.session.abort(")
    expect(captureAt).toBeGreaterThan(-1)
    expect(abortAt).toBeGreaterThan(-1)
    expect(captureAt).toBeLessThan(abortAt)
    // 捕获理由注释与实现同点存放，防止后续重构把捕获再次挪回 await 之后。
    expect(source).toContain("在首个 await 前捕获选中内容")
  })

  test("Fork captures prompt from parts before awaiting the fork request", () => {
    const reduceAt = source.indexOf("(sync.data.part[msg.id] ?? []).reduce(")
    const forkAt = source.indexOf("await sdk.client.session.fork(")
    expect(reduceAt).toBeGreaterThan(-1)
    expect(forkAt).toBeGreaterThan(-1)
    // reduce（内容捕获）必须在 fork await 之前：fork 挂起期间 message 可能被删除释放正文。
    expect(reduceAt).toBeLessThan(forkAt)
    // 空桶守卫：删除后 parts 为 undefined，无守卫的晚读会抛错而非得到空 prompt。
    expect(source).toContain("sync.data.part[msg.id] ?? []")
    expect(source).toContain("fork 请求可能长时间挂起")
  })
})

test("Fork carries content captured before the async fork window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const message = { id: "msg_fork_capture", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build",
    model: { providerID: "provider", modelID: "model" } } satisfies UserMessage
  const forked = { id: "ses_forked", projectID: "proj_test", directory, slug: "forked", version: "1", title: "Forked", time: { created: 2, updated: 2 } }
  const gate = Promise.withResolvers<Response>()
  let requested = false
  function Content() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}>
      <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ClipboardProvider value={{}}><ToastProvider><DialogProvider>
      <DialogMessage sessionID={message.sessionID} messageID={message.id} />
      </DialogProvider></ToastProvider></ClipboardProvider></ThemeProvider>
      </TuiConfigProvider></OpencodeKeymapProvider>
  }
  const { app, emit, sync, route } = await mount((url) => {
    if (url.pathname !== `/session/${message.sessionID}/fork`) return undefined
    requested = true
    return gate.promise
  }, tmp.path, { type: "session", sessionID: message.sessionID }, () => <Content />)
  const landed = () => route.data.type === "session" && route.data.sessionID === forked.id
  try {
    app.renderer.resize(80, 28)
    emit({ directory, project: "proj_test", payload: { id: "evt_fork_message", type: "message.updated", properties: { sessionID: message.sessionID, info: message } } })
    emit({ directory, project: "proj_test", payload: { id: "evt_fork_part", type: "message.part.updated", properties: {
      sessionID: message.sessionID, time: 1, part: { id: "part_fork_capture", sessionID: message.sessionID, messageID: message.id, type: "text", text: "fork capture me" },
    } } })
    await wait(() => sync.data.part[message.id]?.some((part) => part.type === "text" && part.text === "fork capture me") === true)
    // 点击真实选项进入onSelect后才删除；HTTP gate使异步窗口可观察，不靠固定睡眠。
    const deadline = performance.now() + 2000
    let clicked = false
    while (performance.now() < deadline) {
      await app.renderOnce()
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Fork"))
      if (y !== -1) {
        const x = lines[y].indexOf("Fork") + 1
        await app.mockMouse.moveTo(x, y)
        await app.mockMouse.click(x, y)
        clicked = true
        break
      }
      await Bun.sleep(10)
    }
    expect(clicked).toBe(true)
    await wait(() => requested)
    expect(landed()).toBe(false)
    emit({ directory, project: "proj_test", payload: { id: "evt_fork_removed", type: "message.removed", properties: { sessionID: message.sessionID, messageID: message.id } } })
    await wait(() => !sync.data.message[message.sessionID]?.some((item) => item.id === message.id) && sync.data.part[message.id] === undefined)
    expect(landed()).toBe(false)
    gate.resolve(json(forked))
    await wait(landed)
    expect(route.data.type === "session" ? route.data.prompt?.input : undefined).toBe("fork capture me")
  } finally {
    // 失败路径先解除挂起请求，避免迟到action在renderer销毁后提交。
    gate.resolve(json(forked))
    try { if (requested) await wait(landed) } finally { app.renderer.destroy() }
  }
})
