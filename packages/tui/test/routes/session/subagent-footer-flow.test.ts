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
    expect(source).toContain(
      `<span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span> {Locale.number(item().input)}{" "}`,
    )
    expect(source).toContain(
      `<span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span> {Locale.number(item().output)}`,
    )
    // 箭头行内不得回退到中点分隔（B-01 曾把 ` ·{" "}` 保留在 ↑/↓ 之间，与主面板形态分裂）
    const usageRow = source.split("\n").find((line) => line.includes("usageFlow().input"))
    expect(usageRow).toBeDefined()
    expect(usageRow).not.toContain(` ·{" "}`)
    // 可选段（context/cost）仍以 ` · ` 前缀追加，总量段保留中点层级
    expect(source).toContain('{item().context ? ` · ${item().context}` : ""}')
    expect(source).toContain('{item().cost ? ` · ${item().cost}` : ""}')
    expect(source).not.toContain("item().totalInput")
    expect(source).not.toContain("item().totalOutput")
  })
})

// #550：retry 红字簇合同——摘要压平 + (details) 独立入口 + retry in/attempt 元数据 + 优先级。
describe("SubagentFooter retry display contract", () => {
  test("flattens retry message for the inline summary only", () => {
    // 摘要压平空白；gemini quota 特例与主 Prompt footer 同文案，避免两个 footer 分叉。
    expect(source).toContain('r.message.replace(/\\s+/g, " ").trim()')
    expect(source).toContain('"gemini is way too hot right now"')
  })
  test("renders details entry and retry meta with error color", () => {
    // (details) 与摘要/meta 同 theme.error；两层 onMouseUp 与 Prompt 同款（子 text 冒泡不可靠）。
    expect(source).toContain('<text flexShrink={0} fg={theme.error} wrapMode="none" onMouseUp={openRetryDetails}>')
    expect(source).toContain("(details)")
    // 元数据模板与 prompt/index.tsx retryInfo 逐字对齐（retry in X · #n / retry · #n）。
    expect(source).toContain("`retry in ${duration} · #${r.attempt}`")
    expect(source).toContain("`retry · #${r.attempt}`")
  })
  test("opens the original message in a Retry Error dialog", () => {
    expect(source).toContain('DialogAlert.show(dialog, "Retry Error", r.message)')
  })
  test("scopes retry to the child session status only", () => {
    // retry memo 只读当前 route.sessionID 的 status——禁止串到 parent 的 retry 态。
    expect(source).toContain("const s = status()")
    expect(source).toContain('if (s?.type !== "retry") return')
  })
  test("usage yields width before the retry cluster", () => {
    // usage text 可收缩（flexShrink/minWidth/truncate）；nav 外层不收缩。
    expect(source).toContain('<text fg={theme.textMuted} wrapMode="none" flexShrink={1} minWidth={0} truncate>')
    expect(source).toContain('flexDirection="row" gap={2} flexShrink={0}')
  })
  test("counts down via a retry-gated refresh clock", () => {
    // createRefreshClock 以 retry 态门控——非 retry 不持 interval（组件首个计时器）。
    expect(source).toContain("createRefreshClock(() => !!retry())")
  })
})
