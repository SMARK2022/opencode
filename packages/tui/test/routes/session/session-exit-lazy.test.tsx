import { expect, test } from "bun:test"
import path from "node:path"

// 形状锁只验证惰性注册与退出边界；实际delta行为由既有headless Session fixture覆盖。
// 不把源码正则断言当作重注册次数或最终统计的运行时证据。
test("session exit snapshot registers a lazy epilogue producer instead of an eager memo", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/routes/session/index.tsx")).text()
  // 惰性 producer：一次性 onMount 注册，退出时才对最终快照求值
  expect(source).toMatch(/onMount\(\(\) =>\s*\n?\s*setEpilogue\(\(\) =>/)
  // 急路径已移除：不再有 sessionUsage 急 memo
  expect(source).not.toMatch(/sessionUsage\s*=\s*createMemo/)
  expect(source).toContain("{ session: session(), last: undefined, parts: [] }")
  // 急路径已移除：不再有 per-delta 把 setEpilogue 写成字符串的 effect
  expect(source).not.toMatch(/createEffect\(\(\) => \{[\s\S]{0,400}?setEpilogue\(/)
})

test("Tui.run evaluates the epilogue producer only at the exit boundary", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/app.tsx")).text()
  // 退出边界求值：function producer 在 shutdown 之后调用，字符串原样透传
  expect(source).toMatch(/typeof exit\.epilogue === "function" \? exit\.epilogue\(\) : exit\.epilogue/)
  // epilogue context 的 set 签名承载 producer 形态（惰性合同的存在前提）
  const epilogue = await Bun.file(path.resolve(import.meta.dir, "../../../src/context/epilogue.tsx")).text()
  expect(epilogue).toMatch(/set\(value\?: string \| \(\(\) => string \| undefined\)\): void/)
})

test("session commands do not recommend retired sharing", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/routes/session/index.tsx")).text()
  // 上游已移除分享命令；先确认命令表有效，再防止重放恢复该误触入口。
  expect(source).toContain('value: "session.rename"')
  expect(source).not.toMatch(/value:\s*["']session\.share["']/)
})
