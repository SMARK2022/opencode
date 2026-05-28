import { describe, expect, test } from "bun:test"
import { grepSummary } from "./grep-summary"
import { dict } from "@opencode-ai/ui/i18n/en"
import type { UiI18n } from "@opencode-ai/ui/context/i18n"
import { readPartText } from "./message-part-text"
import { autoReviewLabel, autoReviewMetadata } from "./auto-review"
import { notebookInsertSource, notebookLanguage, notebookLine, notebookMetadata, notebookPreviewCells, notebookRows, notebookTools, notebookValue } from "./notebook-tool"

test("shares compact grep filters and incomplete results across both display entrances", () => {
  const t: UiI18n["t"] = (key, params) => dict[key].replace(/{{(\w+)}}/g, (_, name: string) => String(params?.[name] ?? ""))
  const i18n = { t, plural: ((_key, count) => t(count === 1 ? "ui.tool.grep.matches.one" : "ui.tool.grep.matches.other", { count })) satisfies UiI18n["plural"] }
  const input = { pattern: "function", include: ["*.ts", "*.tsx", "*.js"], exclude: ["cache/**", "!bin/**", "vendor/**"], timeout: 1000 }
  const expected = ["function", "*.ts,*.tsx +1", "!cache/** +2", "64+ matches, timed out"]
  // canonical items与V1 matches经过同一个实际消费者，不能只测试手工摘要字符串。
  expect(grepSummary(input, { items: Array(64), truncated: true, timedOut: true }, i18n)).toEqual(expected)
  expect(grepSummary(input, { matches: 64, truncated: true, timedOut: true }, i18n)).toEqual(expected)
  expect(grepSummary({ include: "*.ts", exclude: "!cache/**" }, { items: [1] }, i18n)).toEqual(["*.ts", "!cache/**", "1 match"])
  expect(grepSummary({}, { items: [], timedOut: true }, i18n)).toEqual(["timed out"])
  expect(grepSummary({}, { matches: 0 }, i18n)).toEqual(["0 matches"])
  expect(grepSummary(input, {}, i18n).join(" ")).not.toContain("include=")
  expect(grepSummary(input, {}, i18n).join(" ")).not.toContain("exclude=")
  expect(grepSummary(input, {}, i18n).join(" ")).not.toContain("1000")
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

test("projects actual review states and navigation identity without rendering an app", () => {
  const calls: unknown[] = []
  const i18n = { t: (key: string, params?: unknown) => { calls.push([key, params]); return key } }
  const base = { reviewID: "review", sessionID: "ses_child", precheck: { level: "cautious", reason: "bounded review" }, result: { risk_level: "high", user_authorization: "low", rationale: "Exact rationale" } }
  // 状态来自同一真实信封，取消/拒绝不能因为原工具已有输出而显示为allowed。
  for (const [status, key] of [["reviewing", "reviewing"], ["allowed", "allowed"], ["denied", "denied"], ["timed_out", "timedOut"], ["failed", "failed"], ["fallback_user", "fallbackUser"]]) {
    const review = autoReviewMetadata({ ...base, status })
    expect(review).toBeDefined()
    if (!review) throw new Error("Expected review projection")
    expect(review.sessionID).toBe("ses_child")
    expect(autoReviewLabel(review, i18n)).toBe(`ui.permission.review.${key}`)
  }
  expect(calls).toContainEqual(["ui.permission.review.denied", { risk: "high", authorization: "low" }])
  expect(calls).toContainEqual(["ui.permission.review.reviewing", { level: "cautious" }])
  expect(autoReviewMetadata(undefined)).toBeUndefined()
  expect(autoReviewMetadata({ reviewID: 1 })).toBeUndefined()
  const pending = autoReviewMetadata({ reviewID: "pending" })
  expect(pending?.status).toBe("reviewing")
  expect(pending?.sessionID).toBeUndefined()
})

test("reads all Notebook display envelopes without recreating execution results", () => {
  expect(Object.keys(notebookTools)).toEqual(["vscode_notebook_summary", "vscode_notebook_source", "vscode_notebook_run", "vscode_notebook_output", "vscode_notebook_edit", "vscode_notebook_env"])
  for (const view of ["summary", "source", "run", "output", "edit", "env"]) {
    expect(notebookMetadata({ view, path: "analysis.ipynb" })?.view).toBe(view)
  }
  expect(notebookMetadata(undefined)).toBeUndefined()
  expect(notebookMetadata({ view: "unknown" })).toBeUndefined()
  expect(notebookValue(false)).toBe("false")
  expect(notebookValue(0)).toBe("0")
  // 原执行状态与artifact路径完整可见，但不把完整artifact正文复制到行预览。
  const cells = notebookRows([{ i: 2, id: "#VSC-a", kind: "code", lang: "python", lines: 3, exec: "current-run #4 succeeded 12ms", existing_outs: ["text"], first: "df.head()" }])
  const line = notebookLine(cells[0] ?? {})
  expect(line).toContain("c2  #VSC-a")
  expect(line).toContain("current-run #4 succeeded 12ms")
  expect(line).toContain("df.head()")
  const artifacts = notebookRows([{ mime: "text/plain", bytes: 12, artifactPath: "output.txt", preview: "bounded", text: "FULL ARTIFACT" }])
  expect(notebookLine(artifacts[0] ?? {})).toContain("text/plain  12  output.txt  bounded")
  expect(notebookLine(artifacts[0] ?? {})).not.toContain("FULL ARTIFACT")
  expect(notebookRows(undefined)).toEqual([])
  // 同一实际消费者的纯决策边界，覆盖原渲染用例的源码/语言和晚失败意图。
  const inserted = notebookInsertSource({ editType: "insert", diff: "--- NOT_SOURCE\n+++ notebook.ipynb\n@@ -0,0 +1,2 @@\n+print(1)\n+++ legal source", insertedSourcePreview: "incomplete", insertedSourcePreviewTruncated: true })
  expect(inserted).toEqual({ text: "print(1)\n++ legal source", truncated: false })
  expect(inserted?.text).not.toContain("NOT_SOURCE")
  expect(notebookInsertSource({ editType: "insert", insertedSourcePreview: "bounded", insertedSourcePreviewTruncated: true })).toEqual({ text: "bounded", truncated: true })
  expect(notebookInsertSource({ editType: "edit", insertedSourcePreview: "not inserted" })).toBeUndefined()
  expect(notebookLanguage("python")).toBe("python")
  expect(notebookLanguage("typescriptreact")).toBe("typescript")
  expect(notebookLanguage("javascriptreact")).toBe("typescript")
  expect(notebookLanguage(undefined)).toBeUndefined()
  const run = Array.from({ length: 19 }, (_, i) => ({ i: i + 1, exec: i === 18 || i < 6 ? "current-run failed" : "not-run", artifacts: i === 18 ? [{ mime: "text/plain", artifactPath: "last.txt" }] : [] }))
  expect(notebookPreviewCells(run).map((cell) => cell.i)).toEqual([2, 3, 4, 5, 6, 19])
  expect(run[0]?.i).toBe(1)
  expect(notebookRows(notebookPreviewCells(run).at(-1)?.artifacts)).toMatchObject([{ artifactPath: "last.txt" }])
  expect(notebookPreviewCells(run.map((cell) => ({ ...cell, exec: "succeeded" }))).map((cell) => cell.i)).toEqual([1, 2, 3, 4, 5, 6])
})
