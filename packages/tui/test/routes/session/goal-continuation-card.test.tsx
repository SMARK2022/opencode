/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { goalContinuation } from "../../../src/routes/session/goal-continuation"

// 直接执行路由使用的纯派生函数，覆盖持久快照与历史数据，不加载 Session JSX 或 renderer。
// 颜色、间距和动作绑定另由下方模板合同核对；这不冒充完整 frame/hitbox 认证。

type PartLike = Parameters<typeof goalContinuation>[0][number]

function textPart(text: string, options?: { synthetic?: boolean; metadata?: Record<string, unknown> }): PartLike {
  return {
    id: "prt_test",
    type: "text",
    text,
    synthetic: options?.synthetic ?? false,
    metadata: options?.metadata,
    time: { start: 0, end: 0 },
  } as PartLike
}

function envelope(objective: string, extra: string[] = []) {
  return [
    "<session-goal-continuation>",
    `<objective>${objective}</objective>`,
    ...extra,
    "</session-goal-continuation>",
  ].join("\n")
}

describe("goalContinuation view model", () => {
  test("derives labels and paired counts from persisted marker metadata", () => {
    // 三种 mode 共用同一 producer 字段；label/count 全部来自手写 literal，不复制实现映射。
    const cases = [
      { mode: "continue", label: "CONTINUE", turn: 1 },
      { mode: "replan", label: "REPLAN", turn: 2 },
      { mode: "block-check", label: "BLOCK CHECK", turn: 3 },
    ] as const
    for (const item of cases) {
      const view = goalContinuation([
        textPart(envelope(`Objective ${item.mode}`), {
          synthetic: true,
          metadata: {
            goal_continuation: true,
            goal_continuation_mode: item.mode,
            goal_continuation_turn: item.turn,
            goal_continuation_max_turns: 8,
          },
        }),
      ])
      expect(view?.objective).toBe(`Objective ${item.mode}`)
      expect(view?.label).toBe(item.label)
      // turn 与 max 必须成对有效并拼接为 "n / m"；缺任一值时整体省略计数。
      expect(view?.count).toBe(`${item.turn} / 8`)
    }
  })

  test("omits counts when turn or max is missing or invalid", () => {
    const base = { goal_continuation: true, goal_continuation_mode: "continue" as const }
    // 历史 Message 缺少任一计数字段时不得显示半套数字；非正整数同样视为缺失。
    expect(
      goalContinuation([textPart(envelope("No count"), { synthetic: true, metadata: base })])?.count,
    ).toBeUndefined()
    expect(
      goalContinuation([
        textPart(envelope("Half count"), { synthetic: true, metadata: { ...base, goal_continuation_turn: 2 } }),
      ])?.count,
    ).toBeUndefined()
    expect(
      goalContinuation([
        textPart(envelope("Zero turn"), {
          synthetic: true,
          metadata: { ...base, goal_continuation_turn: 0, goal_continuation_max_turns: 8 },
        }),
      ])?.count,
    ).toBeUndefined()
    // 非整数 max 不是内部 producer 承诺的形态；TUI 不构造第二套计数语义。
    expect(
      goalContinuation([
        textPart(envelope("Fractional max"), {
          synthetic: true,
          metadata: { ...base, goal_continuation_turn: 1, goal_continuation_max_turns: 1.5 },
        }),
      ])?.count,
    ).toBeUndefined()
  })

  test("accepts pre-marker history via exact envelope only", () => {
    // exact envelope + synthetic：无 marker/mode 的历史记录默认 CONTINUE。
    const view = goalContinuation([textPart(envelope("Historical envelope"), { synthetic: true })])
    expect(view?.objective).toBe("Historical envelope")
    expect(view?.label).toBe("CONTINUE")
    expect(view?.count).toBeUndefined()
    // 正文片段不是完整 envelope，不得命中（防止普通 synthetic XML 偶然进入 Revert-only 卡片）。
    expect(
      goalContinuation([textPart("<session-goal-continuation>\npartial only", { synthetic: true })]),
    ).toBeUndefined()
    // 非 synthetic 的同形 XML 是真实用户输入，绝不降级成 Goal 卡片。
    expect(goalContinuation([textPart(envelope("Real user XML"))])).toBeUndefined()
  })

  test("infers replan from strategy-switch tag for marker-only legacy records", () => {
    // marker-only 历史（无 mode 字段）：strategy-switch tag 是唯一被绑定的 shipped 事实。
    const marker = goalContinuation([
      textPart(envelope("Historical marker", ['<strategy-switch mode="breadth-first-replan">', "</strategy-switch>"]), {
        synthetic: true,
        metadata: { goal_continuation: true },
      }),
    ])
    expect(marker?.label).toBe("REPLAN")
    expect(marker?.count).toBeUndefined()
    // 无 strategy-switch 的 marker-only 历史按 CONTINUE 展示。
    expect(
      goalContinuation([textPart(envelope("Plain marker"), { synthetic: true, metadata: { goal_continuation: true } })])
        ?.label,
    ).toBe("CONTINUE")
  })

  test("rejects unknown stored mode instead of falling back to CONTINUE", () => {
    // 已持久化但未知的 mode 表示契约不匹配；退回 CONTINUE 会掩盖 producer 错误。
    expect(
      goalContinuation([
        textPart(envelope("Future mode"), {
          synthetic: true,
          metadata: { goal_continuation: true, goal_continuation_mode: "future-mode" },
        }),
      ]),
    ).toBeUndefined()
  })

  test("unescapes only the three XML entities shipped by continuationPrompt", () => {
    // objective 反转义顺序固定：amp 最后还原，避免把用户原文 `&lt;` 二次解码。
    const view = goalContinuation([
      textPart(envelope("A &lt;tag&gt; &amp; &amp;lt;"), {
        synthetic: true,
        metadata: { goal_continuation: true, goal_continuation_mode: "continue" },
      }),
    ])
    expect(view?.objective).toBe("A <tag> & &lt;")
  })
})

// #520 R1 B-01 回归：源仓四个全 frame 渲染用例中的「dialog subtype 过滤」与「徽章布局/颜色/间距」
// 两组用户可见契约在目标无 withRenderedSession harness；按 #506 subagent-footer-flow 先例
// 以源码模板合同断言兜底——filter 反转、title 回退、徽章配色错误、gap 缺失都会在此失败。
const dialogSource = readFileSync(path.join(import.meta.dir, "../../../src/routes/session/dialog-message.tsx"), "utf8")
const sessionSource = readFileSync(path.join(import.meta.dir, "../../../src/routes/session/index.tsx"), "utf8")

describe("goal continuation card template contracts", () => {
  test("dialog filters to Revert-only for continuation and keeps all actions otherwise", () => {
    // subtype 过滤必须在原有四个 option 之上收窄，而不是重建一套 Revert handler。
    expect(dialogSource).toContain('title={props.goalContinuation ? "Goal Continuation" : "Message Actions"}')
    for (const action of ["session.revert", "session.retry", "message.copy", "session.fork"]) {
      expect(dialogSource).toContain(`value: "${action}"`)
    }
    // 过滤谓词锁定：continuation 只保留 Revert；普通消息（goalContinuation falsy）全集保留。
    expect(dialogSource).toContain('].filter((option) => !props.goalContinuation || option.value === "session.revert")')
  })

  test("session route passes subtype and renders the integrated badge row", () => {
    // subtype 由同一 memo 决议后经 onMouseUp 传入 DialogMessage，不重复解析 XML。
    expect(sessionSource).toContain("onMouseUp={() => props.onMouseUp(goal() !== undefined)}")
    expect(sessionSource).toContain("goalContinuation={goalContinuation}")
    // 正文来源替换：卡片内 continuation 独占 objective，普通用户文本仍走 text memo。
    expect(sessionSource).toContain("const content = createMemo(() => goal()?.objective ?? text())")
    // 徽章行合同：两个 badge 以 gap={1} 分列；GOAL 用 Agent 身份色（color()/queuedFg()），
    // mode badge 用中性 backgroundElement——不得伪造第二个 Agent 角色（源用 captureSpans 断言同一合同）。
    expect(sessionSource).toContain('<box flexDirection="row" paddingTop={1} gap={1}>')
    expect(sessionSource).toContain("<span style={{ bg: color(), fg: queuedFg(), bold: true }}> GOAL </span>")
    expect(sessionSource).toContain("<span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>")
    // label 与配对计数以 ` · ` 连接；count 缺失时省略整个后缀（与 view model 合同一致）。
    // 断言用单引号串原样锁定模板字面量（源仓同款运行时语义，目标为未转义形态）。
    expect(sessionSource).toContain('item().count ? ` · ${item().count}` : ""}')
    // 主卡片与 compaction 锚点都消费 content()，旧 text() 直读不得回流。
    expect(sessionSource).toContain("<Show when={content()}>")
    expect(sessionSource).toContain("id={content() ? undefined : props.message.id}")
  })
})
