import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// JSX 模板合同覆盖 formatter 无法观察的箭头分隔符与累计括号；不冒称真实子会话导航帧验证。
// 数值侧另经 accounting→formatter 验证，context/cost 仍用中点追加。
const source = readFileSync(
  path.join(import.meta.dir, "..", "..", "..", "src", "routes", "session", "subagent-footer.tsx"),
  "utf8",
)

describe("SubagentFooter usage flow template", () => {
  test("joins input/output arrows with a plain space, not a middot", () => {
    // ↑ 后数字与 ↓ 之间必须是空格内聚（与主面板 live flow 和 formatUsageStats 的 flow.join(" ") 同构）
    expect(source).toContain(`<span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span> {Locale.number(item().input)}{" "}`)
    expect(source).toContain(`<span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span> {Locale.number(item().output)}`)
    // 箭头行内不得回退到中点分隔（B-01 曾把 ` ·{" "}` 保留在 ↑/↓ 之间，与主面板形态分裂）
    const usageRow = source.split("\n").find((line) => line.includes("usageFlow().input"))
    expect(usageRow).toBeDefined()
    expect(usageRow).not.toContain(` ·{" "}`)
    // 可选段（context/cost）仍以 ` · ` 前缀追加，总量段保留中点层级
    expect(source).toContain("{item().context ? ` · ${item().context}` : \"\"}")
    expect(source).toContain("{item().cost ? ` · ${item().cost}` : \"\"}")
    expect(source).not.toContain("item().totalInput")
    expect(source).not.toContain("item().totalOutput")
  })
})
