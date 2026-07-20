import { describe, expect, test } from "bun:test"
import { parseGoalSlashInput } from "../../../../src/cli/cmd/tui/util/parse-goal-slash"

// 表驱动行为规格：objective 含空格时必须整串保留，不得 argv 切碎（INV-01）
// 期望值均为独立字面量，不复述 parser 实现算法
// 覆盖：dialog / free-objective / exact verb / set|start 消歧 / continue / 大小写
describe("parseGoalSlashInput", () => {
  // 非 goal slash 必须 undefined，避免误吃 /models 等 local 命令
  test("returns undefined for non-goal input", () => {
    expect(parseGoalSlashInput("hello")).toBeUndefined()
    expect(parseGoalSlashInput("/models")).toBeUndefined()
    // 前缀相似但不是命令名 goal
    expect(parseGoalSlashInput("/goalish fix")).toBeUndefined()
  })

  // 零参数：仅空白 rest → dialog，不创建空 objective
  test("bare /goal opens dialog", () => {
    expect(parseGoalSlashInput("/goal")).toEqual({ type: "dialog" })
    expect(parseGoalSlashInput("/goal   ")).toEqual({ type: "dialog" })
    expect(parseGoalSlashInput("  /goal  ")).toEqual({ type: "dialog" })
  })

  // 核心用户场景：空格后多词自然语言整段成为 objective
  test("multi-word free objective is one whole string", () => {
    expect(parseGoalSlashInput("/goal fix the login bug")).toEqual({
      type: "set-objective",
      objective: "fix the login bug",
    })
  })

  // 中文空格与首行后换行均保留在同一 objective 字段
  test("preserves internal spaces and multiline rest", () => {
    expect(parseGoalSlashInput("/goal 修 登录 bug")).toEqual({
      type: "set-objective",
      objective: "修 登录 bug",
    })
    // 首刀在 /goal 后空格；后续换行属于 rest 内部
    expect(parseGoalSlashInput("/goal 修登录\n并补集成测试")).toEqual({
      type: "set-objective",
      objective: "修登录\n并补集成测试",
    })
  })

  // INV-10：整段等于才是动词；否则首词 resume 只是任务文本的一部分
  test("exact reserved verbs only when whole rest matches", () => {
    expect(parseGoalSlashInput("/goal resume")).toEqual({ type: "resume" })
    expect(parseGoalSlashInput("/goal pause")).toEqual({ type: "pause" })
    expect(parseGoalSlashInput("/goal clear")).toEqual({ type: "clear" })
    expect(parseGoalSlashInput("/goal delete")).toEqual({ type: "clear" })
    expect(parseGoalSlashInput("/goal remove")).toEqual({ type: "clear" })
    // 首词碰巧是 resume 但后有任务文本 → 整串 objective，不误触发 resume
    expect(parseGoalSlashInput("/goal resume the migration carefully")).toEqual({
      type: "set-objective",
      objective: "resume the migration carefully",
    })
  })

  // 显式 set/start/edit 用于任务文本必须以保留词开头时的消歧
  test("set/start/edit take remainder as one objective payload", () => {
    expect(parseGoalSlashInput("/goal set resume the migration carefully")).toEqual({
      type: "set-objective",
      objective: "resume the migration carefully",
    })
    expect(parseGoalSlashInput("/goal edit fix the login bug")).toEqual({
      type: "set-objective",
      objective: "fix the login bug",
    })
    expect(parseGoalSlashInput("/goal start 修登录 bug")).toEqual({
      type: "start",
      objective: "修登录 bug",
    })
    // 动词后无 payload → 不当动词，整 rest 当 objective（字面 "set"）
    expect(parseGoalSlashInput("/goal set")).toEqual({
      type: "set-objective",
      objective: "set",
    })
  })

  // continue 仅四种整段形式；trailing 多余词降级 free-objective
  test("continue requires exact whole-rest boolean forms", () => {
    expect(parseGoalSlashInput("/goal continue on")).toEqual({
      type: "continue",
      continueOnError: true,
    })
    expect(parseGoalSlashInput("/goal continue off")).toEqual({
      type: "continue",
      continueOnError: false,
    })
    expect(parseGoalSlashInput("/goal continue true")).toEqual({
      type: "continue",
      continueOnError: true,
    })
    expect(parseGoalSlashInput("/goal continue false")).toEqual({
      type: "continue",
      continueOnError: false,
    })
    expect(parseGoalSlashInput("/goal continue on please")).toEqual({
      type: "set-objective",
      objective: "continue on please",
    })
  })

  // 命令名大小写不敏感；动词匹配同样 lower 比较
  test("command name is case-insensitive", () => {
    expect(parseGoalSlashInput("/GOAL fix a b")).toEqual({
      type: "set-objective",
      objective: "fix a b",
    })
    expect(parseGoalSlashInput("/Goal RESUME")).toEqual({ type: "resume" })
  })
})
