import { describe, expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle, TreeSitterClient } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { tmpdir } from "../../../fixture/fixture"
import path from "node:path"

// 核对真实消费版本，防止派生安装的旧链接冒充catalog中的新发布包。
describe("installed OpenTUI streaming runtime", () => {
  for (const hook of ["onHighlight", "onChunks"] as const) {
    for (const reject of [false, true]) {
      test(`queued teardown keeps the client destroyed after ${hook} ${reject ? "rejects" : "fulfills"}`, async () => {
        await using tmp = await tmpdir()
        // 必须走安装包的真实 parser；只测空 buffer 会漏掉没有请求却仍存活的 worker。
        const client = new TreeSitterClient({ dataPath: tmp.path })
        const setup = await createTestRenderer({ width: 60, height: 10, useThread: false, consoleMode: "disabled" })
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
const setup = await createTestRenderer({ width: 60, height: 10, useThread: false, consoleMode: "disabled" })
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
    const manifest = await Bun.file(new URL("../../../../../../package.json", import.meta.url)).json()
    const installed = await Bun.file(new URL("./package.json", import.meta.resolve("@opentui/core"))).json()
    expect(installed.version).toBe(manifest.workspaces.catalog["@opentui/core"])
    // 渲染器禁用控制台/独立线程：测试只关心 highlight 管线本身，不引入终端副作用。
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
      // 空主题 + 不画无样式文本：排除着色层干扰，断言只锁定 streaming 分块语义。
      syntaxStyle: SyntaxStyle.fromTheme([]),
      conceal: false,
      drawUnstyledText: false,
      // streaming 是本断言的核心前置：增量解析不得把每个 delta 当独立文档重解析。
      streaming: true,
      // onChunks 必须原样返回 chunks——收集副本的同时不得改变渲染管线输入。
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
        // renderOnce/highlightingDone/renderOnce 的顺序锁定增量高亮完成边界：先提交帧、等解析、再取终帧。
        await setup.renderOnce()
        await code.highlightingDone
        await setup.renderOnce()
      }
      // plainText 必须与累积内容逐字相等——任何分块丢失/重复都会在这里暴露。
      expect(code.plainText).toBe(content)
      expect(callbackText.join("")).toContain("| name | value |")
      expect(callbackText.join("")).toContain("const value = 1")
      // 公式块断言含换行——验证 chunk 切分不吞结构内的空白边界。
      expect(callbackText.join("")).toContain("$$x\n+y$$")
    } finally {
      // destroy 是测试自己的清理责任：highlight 线程不随断言失败泄漏。
      setup.renderer.destroy()
    }
  })

  test("stale one-shot settle reports no in-flight highlight and the next render re-highlights", async () => {
    await using tmp = await tmpdir()
    const client = new TreeSitterClient({ dataPath: tmp.path })
    const setup = await createTestRenderer({ width: 60, height: 10, useThread: false, consoleMode: "disabled" })
    const style = SyntaxStyle.create()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // one-shot（非 streaming）是已完成消息正文的实际高亮路径；onHighlight 门闩把
    // 首次高亮钉在在途状态，使 content 变更确定落在 stale 窗口内，不靠睡眠猜时序。
    const code = new CodeRenderable(setup.renderer, {
      id: "stale-one-shot",
      content: "# First\n",
      filetype: "markdown",
      syntaxStyle: style,
      treeSitterClient: client,
      onHighlight: async () => {
        entered.resolve()
        await release.promise
        // 显式 undefined 满足 OnHighlightCallback 的返回契约（不修改高亮结果）；
        // 字面量键会被类型检查，不能用计算键的宽松路径。
        return undefined
      },
    })
    setup.renderer.root.add(code)
    try {
      await client.initialize()
      await setup.renderOnce()
      await entered.promise
      // 内容换代后故意不再渲染：任何在 stale 结算前到达的新渲染都会启动下一代
      // 高亮，让断言失去对「旧请求是否归位标志」的分辨力。
      code.content = "# Second\n"
      release.resolve()
      await code.highlightingDone
      // 过期结算不等于在途：驻留驱逐与重测门闩都信任该标志，滞留 true 会把屏外
      // 消息永久钉在挂载态并逐帧请求重绘（用户可见的分钟级卡死链路的起点）。
      expect(code.isHighlighting).toBe(false)
      // 归位不能吃掉更新：setter 留下的脏标志须驱动下一次真实渲染重启高亮。
      await setup.renderOnce()
      await code.highlightingDone
      expect(code.isHighlighting).toBe(false)
      // plainText 读出 "Second\n" 而非 "# Second\n"：conceal 只在高亮落地后生效，
      // 该断言同时证明重启的高亮真实完成，而不是仅归位了标志。
      expect(code.plainText).toBe("Second\n")
    } finally {
      release.resolve()
      code.destroy()
      await client.destroy()
      setup.renderer.destroy()
      style.destroy()
    }
  }, 30_000)

  test("stale settle of a superseded one-shot keeps the in-flight flag owned by the newer request", async () => {
    await using tmp = await tmpdir()
    const client = new TreeSitterClient({ dataPath: tmp.path })
    const setup = await createTestRenderer({ width: 60, height: 10, useThread: false, consoleMode: "disabled" })
    const style = SyntaxStyle.create()
    // 双门闩按调用次序绑定请求代次：第 1 次 onHighlight 属 A，第 2 次属 B。
    // 先确认 B 在途再放行 A，确定构造旧请求结算时新请求仍持有标志的窗口。
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let call = 0
    const code = new CodeRenderable(setup.renderer, {
      id: "stale-overlap",
      content: "# First\n",
      filetype: "markdown",
      syntaxStyle: style,
      treeSitterClient: client,
      onHighlight: async () => {
        const index = call++
        entered[index].resolve()
        await release[index].promise
        // 与切片 1 相同：显式 undefined 满足 OnHighlightCallback 返回契约。
        return undefined
      },
    })
    setup.renderer.root.add(code)
    try {
      await client.initialize()
      await setup.renderOnce()
      await entered[0].promise
      code.content = "# Second\n"
      // 脏渲染立即启动 B（renderSelf 不等待旧请求），entered[1] 确认 B 已在途。
      await setup.renderOnce()
      await entered[1].promise
      release[0].resolve()
      // macrotask 排空：A 放行后的 stale 判定与分支是纯同步尾巴，setTimeout(0)
      // 保证微任务队列 drain 后再断言，这是确定性同步点而非睡眠猜时序。
      await new Promise((resolve) => setTimeout(resolve, 0))
      // 旧请求的过期结算不得清掉 B 已置位的在途标志；否则驻留层会把 B 在途的
      // 节点当作高亮已排空，提前冻结高度并销毁正文（B-01 回归锁）。
      expect(code.isHighlighting).toBe(true)
      release[1].resolve()
      await code.highlightingDone
      // 只有最新请求的终结才归位标志；conceal 生效证明 B 的高亮真实落地。
      expect(code.isHighlighting).toBe(false)
      expect(code.plainText).toBe("Second\n")
    } finally {
      release[0].resolve()
      release[1].resolve()
      code.destroy()
      await client.destroy()
      setup.renderer.destroy()
      style.destroy()
    }
  }, 30_000)
})
