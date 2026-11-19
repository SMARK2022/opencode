// 门禁自身的正反例：违规样例必须失败，合法样例必须通过。
//   bun test script/guard/test
import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { posix } from "../lib"

const CHECK = path.join(import.meta.dir, "..", "check.ts")
const PKGS: Record<string, string> = {
  schema: "@opencode-ai/schema",
  protocol: "@opencode-ai/protocol",
  core: "@opencode-ai/core",
  server: "@opencode-ai/server",
  app: "@opencode-ai/app",
  tui: "@opencode-ai/tui",
  desktop: "@opencode-ai/desktop",
  opencode: "opencode",
}

async function fixture(files: Record<string, string>, opts: { extraPkgs?: Record<string, string> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-fixture-"))
  for (const [d, name] of Object.entries({ ...PKGS, ...opts.extraPkgs }))
    await Bun.write(path.join(dir, "packages", d, "package.json"), JSON.stringify({ name }))
  for (const [f, text] of Object.entries(files)) await Bun.write(path.join(dir, f), text)
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe" })
  git("init", "-q")
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
  return {
    dir,
    git,
    write: (f: string, text: string) => Bun.write(path.join(dir, f), text),
    run: async (...extra: string[]) => {
      const out = path.join(dir, ".guard.json")
      const p = Bun.spawnSync(["bun", CHECK, dir, "--json", out, "--quiet", ...extra], { stdout: "pipe", stderr: "pipe" })
      const json = (await Bun.file(out).exists()) ? await Bun.file(out).json() : undefined
      return { code: p.exitCode, rules: (json?.violations ?? []).map((v: { rule: string }) => v.rule) as string[], json, stderr: p.stderr.toString() }
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function expectRules(files: Record<string, string>, rules: string[], opts?: { extraPkgs?: Record<string, string> }) {
  const fx = await fixture(files, opts)
  const r = await fx.run()
  await fx.cleanup()
  expect(r.stderr).toBe("")
  for (const rule of rules) expect(r.rules).toContain(rule)
  if (!rules.length) expect(r.rules.filter((x) => !["defensive-check", "fallback", "await-in-loop"].includes(x))).toEqual([])
  return r
}

describe("依赖矩阵 B1：值、类型、动态、re-export、require、import() 类型都受约束", () => {
  const cases: [string, string][] = [
    ["值导入", `import { a } from "@opencode-ai/core/x"\nexport const b = a`],
    ["类型导入", `import type { A } from "@opencode-ai/core/x"\nexport type B = A`],
    ["动态导入", `export const m = () => import("@opencode-ai/core/x")`],
    ["re-export", `export { a } from "@opencode-ai/core/x"`],
    ["require", `export const m = require("@opencode-ai/core/x")`],
    ["import() 类型", `export type T = import("@opencode-ai/core/x").A`],
  ]
  for (const [name, code] of cases)
    test(`schema 通过${name}依赖 core → 失败`, async () => {
      const r = await expectRules({ "packages/schema/src/a.ts": code }, ["B1-package-deps"])
      expect(r.code).toBe(1)
    })
  test("protocol 依赖 schema → 通过", async () => {
    const r = await expectRules({ "packages/protocol/src/a.ts": `import { s } from "@opencode-ai/schema/x"\nexport const p = s` }, [])
    expect(r.code).toBe(0)
  })
})

describe("B2 界面包只能使用 core 的登记叶子入口", () => {
  test("app → core/util/flock（同目录的宿主能力）→ 失败", () =>
    expectRules({ "packages/app/src/a.ts": `import { lock } from "@opencode-ai/core/util/flock"\nexport const l = lock` }, ["B2-core-entry"]))
  test("app → core/util/path → 通过", () =>
    expectRules({ "packages/app/src/a.ts": `import { p } from "@opencode-ai/core/util/path"\nexport const q = p` }, []))
  test("tui → core/session/part-view → 失败", () =>
    expectRules({ "packages/tui/src/a.ts": `import { v } from "@opencode-ai/core/session/part-view"\nexport const w = v` }, ["B2-core-entry"]))
})

describe("B3–B7 包内边界", () => {
  test("core 新代码引用 ./v1 → 失败", () =>
    expectRules({ "packages/core/src/session/a.ts": `import { x } from "../v1/session/x"\nexport const y = x` }, ["B3-core-v1"]))
  test("相对路径读取另一个包的 txt 资产 → 失败", () =>
    expectRules({ "packages/tui/src/a.ts": `import p from "../../core/src/prompt.txt"\nexport const q = p` }, ["B4-relative-escape"]))
  test("server handler 导入 drizzle-orm → 失败", () =>
    expectRules({ "packages/server/src/handlers/a.ts": `import { eq } from "drizzle-orm"\nexport const e = eq` }, ["B5-server-storage"]))
  test("renderer 引用 main 实现 → 失败", () =>
    expectRules({ "packages/desktop/src/renderer/a.ts": `import { w } from "../main/windows"\nexport const v = w` }, ["B6-desktop-zones"]))
  test("renderer 以类型方式引用 preload/types → 通过", () =>
    expectRules({ "packages/desktop/src/renderer/a.ts": `import type { Api } from "../preload/types"\nexport type A = Api` }, []))
  test("生产代码引用测试 fixture → 失败", () =>
    expectRules({ "packages/core/src/a.ts": `import { f } from "../test/fixture/f"\nexport const g = f` }, ["B7-prod-imports-test"]))
  test("未登记的新包 → 失败", () => expectRules({ "packages/newpkg/src/a.ts": `export const a = 1` }, ["B0-unregistered-package"], { extraPkgs: { newpkg: "@opencode-ai/newpkg" } }))
})

describe("能力与写法棘轮", () => {
  test("core 业务代码里的裸 setTimeout → 失败", () =>
    expectRules({ "packages/core/src/a.ts": `export const t = () => setTimeout(() => {}, 10)` }, ["raw-timer"]))
  test("tui/src/util/signal.ts 是登记的调度入口 → 通过", () =>
    expectRules({ "packages/tui/src/util/signal.ts": `export const t = (f: () => void) => setTimeout(f, 10)` }, []))
  test("Solid async effect → 失败", () =>
    expectRules({ "packages/tui/src/a.tsx": `import { createEffect } from "solid-js"\ncreateEffect(async () => {})` }, ["solid-async-effect"]))
  test("测试里 new Function 执行源码 → 失败", () =>
    expectRules({ "packages/tui/test/a.test.ts": `const f = new Function("return 1")\nf()` }, ["test-source-exec"]))
  test("历史型注释 → 失败；说明约束的中文注释 → 通过", async () => {
    await expectRules({ "packages/core/src/a.ts": `// #263：这里先这样处理\nexport const a = 1` }, ["history-comment"])
    await expectRules({ "packages/core/src/a.ts": `// 名称缺省时显示为匿名，与 TUI 占位文案保持一致\nexport const label = (n: string | undefined) => n ?? "anonymous"` }, [])
  })
  test("提示级规则（defensive-check）不改变退出码", async () => {
    const r = await expectRules({ "packages/core/src/a.ts": `export const f = (a?: { b?: number }) => a?.b ?? 0` }, ["defensive-check"])
    expect(r.code).toBe(0)
  })
})

describe("基线：按边登记，只减不增", () => {
  test("已登记的违规放行；同一文件换个目标新增违规 → 失败", async () => {
    const fx = await fixture({ "packages/schema/src/a.ts": `import { a } from "@opencode-ai/core/x"\nexport const b = a` })
    await fx.run("--write-baseline")
    expect((await fx.run()).code).toBe(0)
    await fx.write("packages/schema/src/a.ts", `import { a } from "@opencode-ai/core/x"\nimport { c } from "@opencode-ai/core/y"\nexport const b = [a, c]`)
    const r = await fx.run()
    expect(r.code).toBe(1)
    expect(r.json.violations[0].key).toContain("@opencode-ai/core/y")
    await fx.cleanup()
  })
  test("已登记的纯转发模块长出实现 → 失败", async () => {
    const fx = await fixture({ "packages/opencode/src/compat.ts": `export { a } from "@opencode-ai/core/x"\n` })
    await fx.run("--write-baseline")
    await fx.write("packages/opencode/src/compat.ts", `export { a } from "@opencode-ai/core/x"\nexport const patched = 1\n`)
    expect((await fx.run()).rules).toContain("F1-forwarder-lock")
    await fx.cleanup()
  })
  test("PR 抬高基线 → C2 失败", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1` })
    await fx.run("--write-baseline")
    const prev = path.join(fx.dir, "prev.json")
    await Bun.write(prev, await Bun.file(path.join(fx.dir, "script/guard/baseline.json")).text())
    await fx.write("packages/core/src/a.ts", `export const t = () => setTimeout(() => {}, 1)`)
    await fx.run("--write-baseline")
    expect((await fx.run("--previous-baseline", prev)).rules).toContain("C2-baseline-raised")
    await fx.cleanup()
  })
})

describe("暂存区模式检查即将提交的内容", () => {
  test("暂存区违规、工作区已修正 → 仍然失败；暂存区合法、工作区违规 → 通过", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1` })
    await fx.run("--write-baseline")
    fx.git("add", "-A")
    await fx.write("packages/core/src/b.ts", `export const t = () => setTimeout(() => {}, 1)`)
    fx.git("add", "packages/core/src/b.ts")
    await fx.write("packages/core/src/b.ts", `export const t = 1`)
    expect((await fx.run("--staged")).code).toBe(1)
    fx.git("add", "packages/core/src/b.ts")
    await fx.write("packages/core/src/b.ts", `export const t = () => setTimeout(() => {}, 1)`)
    expect((await fx.run("--staged")).code).toBe(0)
    await fx.cleanup()
  })
})

describe("改动规模：按提交计，不读基线", () => {
  const body = (n: number, tag = "v") => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i}`).join("\n") + "\n"
  const msg = async (fx: { dir: string }, text: string) => {
    const f = path.join(fx.dir, ".msg")
    await Bun.write(f, text)
    return f
  }

  test("暂存区净增超过预算 → 失败；提交信息带放行标记 → 通过；没有提交信息（pre-commit）→ 跳过", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1\n` })
    await fx.run("--write-baseline")
    await fx.write("packages/core/src/feature.ts", body(350))
    fx.git("add", "-A")
    const blocked = await fx.run("--staged", "--message", await msg(fx, "feat: 大功能"))
    expect(blocked.rules).toContain("change-size")
    expect(blocked.code).toBe(1)
    const allowed = await fx.run("--staged", "--message", await msg(fx, "feat: 大功能\n\nGuard-Allow-Large: 会话分组是一个整体"))
    expect(allowed.code).toBe(0)
    expect(allowed.json.notes.join()).toContain("会话分组是一个整体")
    expect((await fx.run("--staged")).rules).not.toContain("change-size")
    await fx.cleanup()
  })

  test("超过 2000 行的文件：单次净增 150 行 → 失败；50 行 → 通过", async () => {
    const fx = await fixture({ "packages/core/src/big.ts": body(2100) })
    await fx.run("--write-baseline")
    fx.git("add", "-A")
    fx.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    await fx.write("packages/core/src/big.ts", body(2100) + body(150, "w"))
    fx.git("add", "-A")
    expect((await fx.run("--staged", "--message", await msg(fx, "fix"))).rules).toContain("file-lines")
    await fx.write("packages/core/src/big.ts", body(2100) + body(50, "w"))
    fx.git("add", "-A")
    expect((await fx.run("--staged", "--message", await msg(fx, "fix"))).rules).not.toContain("file-lines")
    await fx.cleanup()
  })

  test("只有一个导入方的小新文件 → 失败；两个导入方或只被入口转出 → 通过", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1\n`, "packages/core/src/b.ts": `export const b = 2\n` })
    await fx.run("--write-baseline")
    await fx.write("packages/core/src/helper.ts", `export const twice = (n: number) => n * 2\n`)
    await fx.write("packages/core/src/a.ts", `import { twice } from "./helper"\nexport const a = twice(1)\n`)
    fx.git("add", "-A")
    const one = await fx.run("--staged", "--message", await msg(fx, "refactor"))
    expect(one.rules).toContain("tiny-module")
    expect(one.json.violations.find((v: { rule: string }) => v.rule === "tiny-module").key).toContain("packages/core/src/a.ts")
    await fx.write("packages/core/src/b.ts", `import { twice } from "./helper"\nexport const b = twice(2)\n`)
    fx.git("add", "-A")
    expect((await fx.run("--staged", "--message", await msg(fx, "refactor"))).rules).not.toContain("tiny-module")
    await fx.cleanup()

    const barrel = await fixture({ "packages/core/src/a.ts": `export const a = 1\n` })
    await barrel.run("--write-baseline")
    await barrel.write("packages/core/src/util/helper.ts", `export const twice = (n: number) => n * 2\n`)
    await barrel.write("packages/core/src/util/index.ts", `export * from "./helper"\n`)
    barrel.git("add", "-A")
    expect((await barrel.run("--staged", "--message", await msg(barrel, "feat"))).rules).not.toContain("tiny-module")
    await barrel.cleanup()

    // handlers.ts 逐个导入 handlers/*：沿用目录登记约定的新文件不算拆碎
    const registry = await fixture({ "packages/server/src/handlers.ts": `import { a } from "./handlers/a"\nexport const all = [a]\n`, "packages/server/src/handlers/a.ts": body(50) })
    await registry.run("--write-baseline")
    await registry.write("packages/server/src/handlers/b.ts", `export const b = 1\n`)
    await registry.write("packages/server/src/handlers.ts", `import { a } from "./handlers/a"\nimport { b } from "./handlers/b"\nexport const all = [a, b]\n`)
    registry.git("add", "-A")
    expect((await registry.run("--staged", "--message", await msg(registry, "feat"))).rules).not.toContain("tiny-module")
    await registry.cleanup()
  })

  test("推送范围逐个提交判定：带标记的大提交放行，另一个大提交失败；--no-trailer 时都不认标记", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1\n` })
    await fx.run("--write-baseline")
    fx.git("add", "-A")
    fx.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    const base = fx.git("rev-parse", "HEAD").stdout.toString().trim()
    const commit = async (file: string, text: string, message: string) => {
      await fx.write(file, text)
      fx.git("add", "-A")
      fx.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message)
    }
    await commit("packages/core/src/f1.ts", body(320, "x"), "feat: 一\n\nGuard-Allow-Large: 已确认")
    await commit("packages/core/src/f2.ts", body(320, "y"), "feat: 二")
    const r = await fx.run("--commit", "HEAD", "--changed-since", base)
    expect(r.json.violations.filter((v: { rule: string }) => v.rule === "change-size").map((v: { key: string }) => v.key.split(" ")[1])).toEqual(["feat:"])
    expect(r.json.violations.find((v: { rule: string }) => v.rule === "change-size").key).toContain("二")
    const strict = await fx.run("--commit", "HEAD", "--changed-since", base, "--no-trailer")
    expect(strict.json.violations.filter((v: { rule: string }) => v.rule === "change-size").length).toBe(2)
    expect((await fx.run("--commit", "HEAD", "--changed-since", base, "--no-trailer", "--allow-large")).code).toBe(0)
    await fx.cleanup()
  })

  test("Agent 回合结束（--files）：规模超出只提示，不阻断", async () => {
    const fx = await fixture({ "packages/core/src/a.ts": `export const a = 1\n` })
    await fx.run("--write-baseline")
    fx.git("add", "-A")
    fx.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    await fx.write("packages/core/src/feature.ts", body(350))
    const r = await fx.run("--files", "packages/core/src/feature.ts")
    expect(r.json.violations.find((v: { rule: string }) => v.rule === "change-size")?.level).toBe("warn")
    expect(r.code).toBe(0)
    await fx.cleanup()
  })
})

test("Windows 路径统一转为正斜杠", () => {
  expect(posix("packages\\core\\src\\a.ts")).toBe("packages/core/src/a.ts")
})
