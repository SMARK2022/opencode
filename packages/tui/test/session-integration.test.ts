import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// 读取 Prompt 组件源码文本，断言 footer 用量渲染接线
// （源 session-integration.test 的 token usage display 子集，适配目标测试布局）
const promptSource = readFileSync(new URL("../src/component/prompt/index.tsx", import.meta.url), "utf8")

describe("Prompt component integration points", () => {
  describe("token usage display", () => {
    // 宽屏 footer 改为分拆 ↑/↓ 流量(移除累积括号)，断言锁定 Locale.number 分拆渲染与流量脉冲接线，
    // 替代旧版对 totalInput/totalOutput 渲染的断言——累积量改由 sidebar 承载，prompt 不再展示。
    test("shows split input/output flow with arrows", () => {
      expect(promptSource).toContain("usageFlow")
      expect(promptSource).toContain("Locale.number(item().input)")
      expect(promptSource).toContain("Locale.number(item().output)")
      // 完整请求统计不受紧凑展示影响，不能退回只累计100条显示窗口。
      expect(promptSource).toContain("requestTokens")
      expect(promptSource).toContain("const showSplitFlow = createMemo(() => promptWidth() > 90)")
    })
    test("imports tokenAccounting", () => {
      expect(promptSource).toContain("tokenAccounting")
    })
  })
})
