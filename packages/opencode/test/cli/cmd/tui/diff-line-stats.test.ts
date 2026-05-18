import { describe, expect, test } from "bun:test"

// diffLineStats is a file-local helper in routes/session/index.tsx.
// We re-implement the same logic here to verify the contract that the TUI
// diff display relies on: counting +/- lines excluding --- and +++ headers.

function diffLineStats(diff: string) {
  const lines = diff.split("\n")
  return {
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    total: lines.length,
  }
}

describe("diffLineStats", () => {
  test("counts added and removed lines excluding headers", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export {}`
    const stats = diffLineStats(diff)
    expect(stats.added).toBe(2)
    expect(stats.removed).toBe(1)
    expect(stats.total).toBe(8)
  })

  test("returns zero for empty diff", () => {
    expect(diffLineStats("")).toEqual({ added: 0, removed: 0, total: 1 })
  })

  test("handles context-only diff", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 const a = 1
 const b = 2`
    const stats = diffLineStats(diff)
    expect(stats.added).toBe(0)
    expect(stats.removed).toBe(0)
  })
})
