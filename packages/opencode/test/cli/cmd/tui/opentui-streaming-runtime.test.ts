import { describe, expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle, TreeSitterClient } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { tmpdir } from "../../../fixture/fixture"
import path from "node:path"

describe("installed OpenTUI streaming runtime", () => {
  for (const hook of ["onHighlight", "onChunks"] as const) {
    for (const reject of [false, true]) {
      test(`queued teardown keeps the client destroyed after ${hook} ${reject ? "rejects" : "fulfills"}`, async () => {
        await using tmp = await tmpdir()
        // 必须走安装包的真实 parser；只测空 buffer 会漏掉没有请求却仍存活的 worker。
        const client = new TreeSitterClient({ dataPath: tmp.path })
        const setup = await createTestRenderer({ width: 60, height: 10 })
        const style = SyntaxStyle.create()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        // 两个公开异步 hook 共用因果门闩，避免用睡眠猜测高亮是否已进入在途状态。
        const pause = async () => {
          entered.resolve()
          await release.promise
          if (reject) throw new Error("controlled highlight rejection")
        }
        const code = new CodeRenderable(setup.renderer, {
          id: "queued-teardown",
          content: "# First\n",
          filetype: "markdown",
          syntaxStyle: style,
          treeSitterClient: client,
          streaming: true,
          drawUnstyledText: false,
          [hook]: pause,
        })
        setup.renderer.root.add(code)
        try {
          await client.initialize()
          await setup.renderOnce()
          await entered.promise
          // 第二帧在首个 hook 未结算时到达，公开 setter/render 路径因此留下下一轮工作。
          code.content = "# Second\n"
          await setup.renderOnce()
          const done = code.highlightingDone
          code.destroy()
          await client.destroy()
          // 先完成 owner 销毁再放行 continuation，直接暴露旧循环重新初始化 client 的缺陷。
          release.resolve()
          await done
          // idle 结算不能被提前返回跳过；client 状态同时排除只释放 parser buffer 的假修复。
          expect(code.isHighlighting).toBe(false)
          expect(client.isInitialized()).toBe(false)
          // 禁止通过封死 client 生命周期取巧：合法的新 owner 仍能重新初始化并实际解析。
          await client.initialize()
          const parsed = await client.highlightOnce("const value = 1;", "javascript")
          expect(parsed.highlights?.length).toBeGreaterThan(0)
        } finally {
          // 失败断言也须释放门闩；此清理发生在行为取证之后，不参与成功条件。
          release.resolve()
          code.destroy()
          await client.destroy()
          // renderer/style 与显式 client 是不同资源 owner，测试结束时分别归还。
          setup.renderer.destroy()
          style.destroy()
        }
      }, 30_000)
    }
  }

  test("queued teardown permits a finite child to exit naturally", async () => {
    await using tmp = await tmpdir()
    // 脚本位于临时目录，但依赖必须来自当前 consumer，不能意外解析到另一份安装包。
    const script = path.join(tmp.path, "streaming-exit.ts")
    await Bun.write(
      script,
      `
import { CodeRenderable, SyntaxStyle, TreeSitterClient } from ${JSON.stringify(import.meta.resolve("@opentui/core"))}
import { createTestRenderer } from ${JSON.stringify(import.meta.resolve("@opentui/core/testing"))}
const client = new TreeSitterClient({ dataPath: ${JSON.stringify(tmp.path)} })
await client.initialize()
const setup = await createTestRenderer({ width: 60, height: 10 })
const style = SyntaxStyle.create()
const entered = Promise.withResolvers()
const release = Promise.withResolvers()
// 使用真实高亮到达公开 hook 的信号，不把输出文字或时间间隔当作工作完成。
const code = new CodeRenderable(setup.renderer, {
  id: "natural-exit", content: "# First\\n", filetype: "markdown",
  syntaxStyle: style, treeSitterClient: client, streaming: true, drawUnstyledText: false,
  onHighlight: async () => { entered.resolve(); await release.promise },
})
setup.renderer.root.add(code)
await setup.renderOnce()
await entered.promise
// 第二个公开内容更新故意先于 owner 销毁，保留原故障的 pending 拓扑。
code.content = "# Second\\n"
await setup.renderOnce()
const done = code.highlightingDone
code.destroy()
await client.destroy()
// 这里只销毁一次 client；放行后若复活，必须由自然退出断言暴露。
release.resolve()
await done
// renderer/style 正常释放不再补杀旧 client，避免清理替生产 guard 完成工作。
setup.renderer.destroy()
style.destroy()
console.log(JSON.stringify({ initialized: client.isInitialized(), highlighting: code.isHighlighting }))
`,
    )
    // 独立进程的退出及两个 EOF 才是成功条件，不能用测试进程 finally 二次销毁蒙混通过。
    const child = Bun.spawn([process.execPath, script], {
      cwd: tmp.path,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let expired = false
    // 20 秒只界定失败清理，并为 CI 原生启动留余量；没有任何生产 quiet-window 语义。
    const timer = setTimeout(() => {
      expired = true
      child.kill()
    }, 20_000)
    try {
      // 并行排空两条管道，防止监督测试自身制造背压；exited 单独成功不算完整返回。
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      // watchdog 即使遇到退出竞争也不能被计为正常成功。
      expect(expired).toBe(false)
      expect(exit).toBe(0)
      expect(stderr).toBe("")
      // JSON 仅检验公开状态，不用于触发终止或提前结束管道读取。
      expect(JSON.parse(stdout)).toEqual({ initialized: false, highlighting: false })
    } finally {
      // 只回收此 fixture 自己的进程；不扫描或终止任何共享 worker/daemon。
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
    }
  }, 30_000)

  test("keeps Markdown tables, fences, formulas, and callbacks coherent across deltas", async () => {
    const setup = await createTestRenderer({
      width: 100,
      height: 20,
      footerHeight: 0,
      useThread: false,
      consoleMode: "disabled",
    })
    const callbackText: string[] = []
    const code = new CodeRenderable(setup.renderer, {
      id: "installed-streaming-code",
      filetype: "markdown",
      syntaxStyle: SyntaxStyle.fromTheme([]),
      conceal: false,
      drawUnstyledText: false,
      streaming: true,
      onChunks: (chunks) => {
        callbackText.push(chunks.map((chunk) => chunk.text).join(""))
        return chunks
      },
    })
    setup.renderer.root.add(code)

    try {
      let content = ""
      // 每个delta都故意停在未闭合结构内，验证真实安装包不会把片段当作独立Markdown文档。
      for (const delta of [
        "| name | value |\n| --- | --- |\n| first |",
        " second |\n\n```typescript\nconst value = 1\n",
        "```\n\n$$x\n+y$$",
      ]) {
        content += delta
        code.content = content
        await setup.renderOnce()
        await code.highlightingDone
        await setup.renderOnce()
      }

      expect(code.plainText).toBe(content)
      expect(callbackText.join("")).toContain("| name | value |")
      expect(callbackText.join("")).toContain("const value = 1")
      expect(callbackText.join("")).toContain("$$x\n+y$$")
    } finally {
      setup.renderer.destroy()
    }
  })
})
