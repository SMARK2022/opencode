import { describe, expect, test } from "bun:test"
import { parsePatch } from "diff"
import { previewDiff } from "../../../../src/cli/cmd/tui/util/preview-diff"

const sample = `Index: /tmp/models.test.ts
===================================================================
--- /tmp/models.test.ts
+++ /tmp/models.test.ts
@@ -132,47 +132,26 @@
 describe("ModelsDev Service", () => {
   it.live("get() returns providers from disk when cache file exists", () =>
     Effect.gen(function* () {
       yield* writeCache(fixture)
-      const state = yield* Ref.make(initialState)
-      const cache = yield* ModelsDev.get(state)
+      const cache = yield* ModelsDev.get()
+      expect(cache.providers).toHaveLength(1)
       expect(cache.providers[0]?.id).toBe("anthropic")
     })
   )
`

const partialHunk = `Index: /tmp/prompt.ts
===================================================================
--- /tmp/prompt.ts
+++ /tmp/prompt.ts
@@ -512,10 +512,10 @@
 const result = yield* item.execute(args, ctx).pipe(
   Effect.catchCauseIf(
     (cause) => !Cause.hasInterruptsOnly(cause),
     (cause) => {
-    const error = Cause.squash(cause)
-    if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
-      return Effect.fail(error)
-    }
-    return Effect.succeed({
-      title: item.id,`

const completeSmall = `Index: /tmp/small.ts
===================================================================
--- /tmp/small.ts
+++ /tmp/small.ts
@@ -1,3 +1,3 @@
 const value = 1
-const oldName = value
+const newName = value
 export { value }`

describe("previewDiff", () => {
  test("returns a parseable truncated diff with rewritten hunk counts", () => {
    const preview = previewDiff(sample, 5)
    const hunk = parsePatch(preview)[0]?.hunks[0]

    expect(hunk?.lines).toEqual([
      " describe(\"ModelsDev Service\", () => {",
      "   it.live(\"get() returns providers from disk when cache file exists\", () =>",
      "     Effect.gen(function* () {",
      "       yield* writeCache(fixture)",
      "-      const state = yield* Ref.make(initialState)",
      "+      const cache = yield* ModelsDev.get()",
      " …",
    ])
    expect(hunk?.oldLines).toBe(6)
    expect(hunk?.newLines).toBe(6)
    expect(preview).not.toContain("\n…")
  })

  test("keeps small diffs unchanged", () => {
    expect(previewDiff(completeSmall, 20)).toBe(completeSmall)
  })

  test("repairs an already-clipped hunk before diff rendering", () => {
    const hunk = parsePatch(previewDiff(partialHunk, 10))[0]?.hunks[0]

    expect(hunk?.lines.at(-1)).toBe(" …")
    expect(hunk?.oldLines).toBe(11)
    expect(hunk?.newLines).toBe(5)
  })
})
