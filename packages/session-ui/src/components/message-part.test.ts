import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { autoReviewLabel, autoReviewMetadata } from "./auto-review"
import { notebookLine, notebookMetadata, notebookRows, notebookTools, notebookValue } from "./notebook-tool"

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
})
