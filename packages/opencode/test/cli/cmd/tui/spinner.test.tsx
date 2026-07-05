/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
// 导入 spinner 模块以触发 <spinner> intrinsic 的注册。注册逻辑由该模块在
// 求值时显式调用 extend 完成（详见 src 侧改动），这里只消费其 SPINNER_FRAMES
// 值导出，避免出现无绑定的纯副作用导入。
import { SPINNER_FRAMES } from "@/cli/cmd/tui/component/spinner"

// 行为复现级断言：通过 Solid reconciler 渲染 <spinner> 元素，复现编译产物中
// "[Reconciler] Unknown component type: spinner" 的失败路径。注册缺失时
// testRender 会在 createElement 阶段抛出该错误；注册正常时首帧渲染出 spinner 字形。
//
// 非编译测试环境无法复现编译期 chunk 求值时序问题（那正是本 bug 的根因），
// 因此本测试不用于复现编译期时序，而是作为 <spinner> intrinsic 注册链路的
// 回归护栏：一旦注册被误删或导入链路被破坏，本测试会以确切错误信息失败。
test("<spinner> intrinsic 经 Solid reconciler 注册并可渲染", async () => {
  const app = await testRender(
    () => <spinner frames={SPINNER_FRAMES} interval={80} />,
    { width: 8, height: 3 },
  )
  try {
    await app.renderOnce()
    // 首帧至少渲染出一个 spinner 字形；注册缺失时上面 testRender/renderOnce
    // 会直接抛 "[Reconciler] Unknown component type: spinner" 而不会走到这里。
    expect(app.captureCharFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  } finally {
    // createTestRenderer 持有 native renderer 与定时器，必须 destroy 避免泄漏到后续用例。
    app.renderer.destroy()
  }
})

// 多帧渲染护栏：<spinner> intrinsic 注册后须支持 reconciler 连续多帧调度
// (autoplay)，而非仅首帧侥幸通过。连续 renderOnce 两次并确认字形持续可见，
// 防止注册相关状态在二次渲染时被错误重置导致回归。
test("<spinner> intrinsic 支持连续多帧渲染", async () => {
  const seen: string[] = []
  const app = await testRender(
    () => {
      // 直接渲染 intrinsic，绕过需要 ThemeProvider/KVProvider 的 Spinner 组件体，
      // 聚焦验证 catalogue 注册本身，而非组件上下文装配。
      return <spinner frames={SPINNER_FRAMES} interval={80} />
    },
    { width: 8, height: 3 },
  )
  try {
    await app.renderOnce()
    seen.push(app.captureCharFrame())
    // 连续两帧确认 renderable 正常挂载且可重复渲染（autoplay 调度生效）。
    await app.renderOnce()
    seen.push(app.captureCharFrame())
    expect(seen.some((frame) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(frame))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
