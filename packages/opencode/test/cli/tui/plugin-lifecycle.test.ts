import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { awaitWithTimeout, pollWithTimeout } from "../../lib/effect"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { mockTuiRuntime, waitForTuiPlugins } from "../../fixture/tui-runtime"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

test("runs onDispose callbacks with aborted signal and is idempotent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "marker.txt")

      await Bun.write(
        file,
        `export default {
  id: "demo.lifecycle",
  tui: async (api, options) => {
    api.event.on("event.test", () => {})
    api.route.register([{ name: "lifecycle.route", render: () => null }])
    api.lifecycle.onDispose(async () => {
      const prev = await Bun.file(options.marker).text().catch(() => "")
      await Bun.write(options.marker, prev + "custom\\n")
    })
    api.lifecycle.onDispose(async () => {
      const prev = await Bun.file(options.marker).text().catch(() => "")
      await Bun.write(options.marker, prev + "aborted:" + String(api.lifecycle.signal.aborted) + "\\n")
    })
  },
}
`,
      )

      return { spec, marker }
    },
  })

  const { config, restore } = mockTuiRuntime(tmp.path, [[tmp.extra.spec, { marker: tmp.extra.marker }]])

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    // 本例验证已加载插件的退出回调；未进入 init 的取消由独立 pending 用例验证。
    await waitForTuiPlugins()
    await TuiPluginRuntime.dispose()

    const marker = await fs.readFile(tmp.extra.marker, "utf8")
    expect(marker).toContain("custom")
    expect(marker).toContain("aborted:true")

    // second dispose is a no-op
    await TuiPluginRuntime.dispose()
    const after = await fs.readFile(tmp.extra.marker, "utf8")
    expect(after).toBe(marker)
  } finally {
    await TuiPluginRuntime.dispose()
    restore()
  }
})

test("plugin dispose releases an in-flight acquireParts and its late handle", async () => {
  // [0624] acquire 在途时卸载：scope.track 的释放先标记，晚到的句柄也必须立即释放，
  // 否则一个失败的/慢速 sync 会让该 Session 的正文消费计数永久泄漏。
  const gate = Promise.withResolvers<void>()
  let releases = 0
  const api = createTuiPluginApi({
    state: {
      acquireParts: async () => {
        await gate.promise
        return { release: () => releases++ }
      },
    },
  })

  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      await Bun.write(
        file,
        `export default {
  id: "demo.acquire",
  tui: async (api, options) => {
    api.state.acquireParts("ses_inflight").then(() => options.onSettled?.())
  },
}
`,
      )
      return { spec: pathToFileURL(file).href }
    },
  })

  let settled = false
  const { config, restore } = mockTuiRuntime(tmp.path, [[tmp.extra.spec, { onSettled: () => (settled = true) }]])
  try {
    await TuiPluginRuntime.init({ api, config })
    await waitForTuiPlugins()
    // acquire 已在途；此时卸载必须在 resolve 后释放句柄。
    await TuiPluginRuntime.dispose()
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(true)
    expect(releases).toBe(1)
  } finally {
    await TuiPluginRuntime.dispose()
    restore()
  }
})

test("explicit release then dispose releases the underlying handle exactly once", async () => {
  // [0625] 释放幂等性回归守卫：显式 release 已消费本次 acquisition，随后 dispose 不得
  // 再产生第二次底层释放。该守卫锁定 track 包装不破坏幂等性。
  let releases = 0
  const api = createTuiPluginApi({
    state: {
      acquireParts: async () => ({ release: () => releases++ }),
    },
  })

  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      await Bun.write(
        file,
        `export default {
  id: "demo.release",
  tui: async (api, options) => {
    const handle = await api.state.acquireParts("ses_explicit")
    handle.release()
    options.onReleased?.()
  },
}
`,
      )
      return { spec: pathToFileURL(file).href }
    },
  })

  let released = false
  const { config, restore } = mockTuiRuntime(tmp.path, [[tmp.extra.spec, { onReleased: () => (released = true) }]])
  try {
    await TuiPluginRuntime.init({ api, config })
    await waitForTuiPlugins()
    expect(released).toBe(true)
    expect(releases).toBe(1)
    await TuiPluginRuntime.dispose()
    expect(releases).toBe(1)
  } finally {
    await TuiPluginRuntime.dispose()
    restore()
  }
})
test("rolls back failed plugin and continues loading next", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const bad = path.join(dir, "bad-plugin.ts")
      const good = path.join(dir, "good-plugin.ts")
      const badSpec = pathToFileURL(bad).href
      const goodSpec = pathToFileURL(good).href
      const badMarker = path.join(dir, "bad-cleanup.txt")
      const goodMarker = path.join(dir, "good-called.txt")

      await Bun.write(
        bad,
        `export default {
  id: "demo.bad",
  tui: async (api, options) => {
    api.route.register([{ name: "bad.route", render: () => null }])
    api.lifecycle.onDispose(async () => {
      await Bun.write(options.bad_marker, "cleaned")
    })
    throw new Error("bad plugin")
  },
}
`,
      )

      await Bun.write(
        good,
        `export default {
  id: "demo.good",
  tui: async (_api, options) => {
    await Bun.write(options.good_marker, "called")
  },
}
`,
      )

      return { badSpec, goodSpec, badMarker, goodMarker }
    },
  })

  const { config, restore } = mockTuiRuntime(tmp.path, [
    [tmp.extra.badSpec, { bad_marker: tmp.extra.badMarker }],
    [tmp.extra.goodSpec, { good_marker: tmp.extra.goodMarker }],
  ])

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    // 回滚与下一插件激活都归外部任务，先等该任务再区分失败清理与成功继续。
    await waitForTuiPlugins()
    // bad plugin's onDispose ran during rollback
    await expect(fs.readFile(tmp.extra.badMarker, "utf8")).resolves.toBe("cleaned")
    // good plugin still loaded
    await expect(fs.readFile(tmp.extra.goodMarker, "utf8")).resolves.toBe("called")
  } finally {
    await TuiPluginRuntime.dispose()
    restore()
  }
})

test("assigns sequential slot ids scoped to plugin", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "slot-plugin.ts")
      const spec = pathToFileURL(file).href
      const marker = path.join(dir, "slot-setup.txt")

      await Bun.write(
        file,
        `import fs from "fs"

const mark = (label) => {
  fs.appendFileSync(${JSON.stringify(marker)}, label + "\\n")
}

export default {
  id: "demo.slot",
  tui: async (api) => {
    const one = api.slots.register({
      id: 1,
      setup: () => { mark("one") },
      slots: { home_logo() { return null } },
    })
    const two = api.slots.register({
      id: 2,
      setup: () => { mark("two") },
      slots: { home_bottom() { return null } },
    })
    mark("id:" + one)
    mark("id:" + two)
  },
}
`,
      )

      return { spec, marker }
    },
  })

  const { config, restore } = mockTuiRuntime(tmp.path, [tmp.extra.spec])
  const err = spyOn(console, "error").mockImplementation(() => {})

  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })
    await waitForTuiPlugins()

    const marker = await fs.readFile(tmp.extra.marker, "utf8")
    expect(marker).toContain("one")
    expect(marker).toContain("two")
    expect(marker).toContain("id:demo.slot")
    expect(marker).toContain("id:demo.slot:1")

    // no initialization failures
    const hit = err.mock.calls.find(
      (item) => typeof item[0] === "string" && item[0].includes("failed to initialize tui plugin"),
    )
    expect(hit).toBeUndefined()
  } finally {
    await TuiPluginRuntime.dispose()
    err.mockRestore()
    restore()
  }
})

test(
  "times out hanging plugin cleanup on dispose",
  async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const file = path.join(dir, "timeout-plugin.ts")
        const spec = pathToFileURL(file).href

        await Bun.write(
          file,
          `export default {
  id: "demo.timeout",
  tui: async (api) => {
    api.lifecycle.onDispose(() => new Promise(() => {}))
  },
}
`,
        )

        return { spec }
      },
    })

    const { config, restore } = mockTuiRuntime(tmp.path, [tmp.extra.spec])

    try {
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config, disposeTimeoutMs: 25 })
      // 此例只测 cleanup deadline，插件加载耗时不能混进 500ms 的 dispose 竞速窗口。
      await waitForTuiPlugins()

      const done = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 500)
        void TuiPluginRuntime.dispose().then(() => {
          clearTimeout(timer)
          resolve("done")
        })
      })
      expect(done).toBe("done")
    } finally {
      await TuiPluginRuntime.dispose()
      restore()
    }
  },
  { timeout: 15000 },
)
test("disposes pending external init and resources registered after abort", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "pending-plugin.ts")
      const started = path.join(dir, "started.txt")
      const marker = path.join(dir, "cleaned.txt")
      await Bun.write(file, `export default {
  id: "demo.pending.exit",
  tui: async (api, options) => {
    await Bun.write(options.started, "started")
    await new Promise<void>((resolve) => {
      if (api.lifecycle.signal.aborted) {
        resolve()
        return
      }
      api.lifecycle.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    api.event.on("demo.pending.event", () => {})
    api.route.register([{ name: "demo.pending.route", render: () => null }])
    api.lifecycle.onDispose(async () => { await Bun.write(options.marker, "cleaned") })
  },
}
`)
      return { spec: pathToFileURL(file).href, started, marker }
    },
  })
  const { config, restore } = mockTuiRuntime(tmp.path, [[tmp.extra.spec, { started: tmp.extra.started, marker: tmp.extra.marker }]])
  const count = { event_add: 0, event_drop: 0, route_add: 0, route_drop: 0, command_add: 0, command_drop: 0 }
  try {
    await TuiPluginRuntime.init({ api: createTuiPluginApi({ count }), config })
    // marker 确认真实 init 已进入等待，不用 sleep 或尚未激活的空状态作为退出证据。
    await Effect.runPromise(pollWithTimeout(
      Effect.promise(() => Bun.file(tmp.extra.started).exists().then((exists) => exists ? true : undefined)),
      "external plugin init did not start",
    ))
    const before = { ...count }
    // dispose 必须主动 abort 才能解开 init；完成后再验证 abort 后登记的资源也被回收。
    await Effect.runPromise(awaitWithTimeout(
      Effect.promise(() => TuiPluginRuntime.dispose()), "pending external plugin init did not exit",
    ))
    expect(count.event_add).toBe(before.event_add + 1)
    expect(count.route_add).toBe(before.route_add + 1)
    expect(count.event_drop).toBe(count.event_add)
    expect(count.route_drop).toBe(count.route_add)
    await expect(fs.readFile(tmp.extra.marker, "utf8")).resolves.toBe("cleaned")
  } finally {
    // 失败路径仍有界清理 fixture，原测试错误保持，不能再用无界 dispose 把失败挂住。
    await Effect.runPromise(awaitWithTimeout(
      Effect.promise(() => TuiPluginRuntime.dispose()), "pending plugin fixture cleanup did not exit",
    )).catch(() => {})
    restore()
  }
}, { timeout: 15000 })
