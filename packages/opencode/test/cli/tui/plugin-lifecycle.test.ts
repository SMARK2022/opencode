import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { mockTuiRuntime } from "../../fixture/tui-runtime"

const { TuiPluginRuntime } = await import("../../../src/cli/cmd/tui/plugin/runtime")

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
  // acquire 在途时卸载：scope.track 的释放先标记，晚到的句柄也必须立即释放，
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
  // 释放幂等性回归守卫：显式 release 已消费本次 acquisition，随后 dispose 不得
  // 再产生第二次底层释放。该守卫在修复前后均绿，锁定的是 track 包装不破坏幂等性。
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
    await new Promise((resolve) => setTimeout(resolve, 0))
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
      await TuiPluginRuntime.init({ api: createTuiPluginApi(), config })

      const done = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 7000)
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
