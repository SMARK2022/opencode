import { describe, expect, test } from "bun:test"
import { parsePatch } from "diff"
import { previewDiff } from "../../src/util/preview-diff"

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
    // 截断必须重写 @@ 计数，parsePatch 才不会越界读行
    expect(hunk?.newLines).toBe(6)
    expect(preview).not.toContain("\n…")
  })

  test("keeps small diffs unchanged", () => {
    // 小 diff 原样返回，避免无谓重建 Renderable
    expect(previewDiff(completeSmall, 20)).toBe(completeSmall)
  })

  // #233：hunk 体内形似文件头的 +/- 行是合法源码——不得被误当 patch 头截断
  // #233：hunk 体内的 ---/+++ 行是源码而非文件头——正则排除会让解析器误断行
  test("keeps hunk body lines that look like diff headers", () => {
    const input = `Index: /tmp/notebook.py
===================================================================
--- /tmp/notebook.py
+++ /tmp/notebook.py
@@ -1,2 +1,2 @@
-old line
--- legal removed source
+new line
+++ legal added source`
    const hunk = parsePatch(previewDiff(input, 10))[0]?.hunks[0]

    expect(hunk?.lines).toContain("--- legal removed source")
    expect(hunk?.lines).toContain("+++ legal added source")
    expect(hunk?.oldLines).toBe(2)
    expect(hunk?.newLines).toBe(2)
  })

  // #233：预算允许时不平衡 hunk 的额外 +/- 行全部保留
  test("keeps unbalanced hunk body lines when preview budget allows them", () => {
    const input = `Index: /tmp/notebook.py
===================================================================
--- /tmp/notebook.py
+++ /tmp/notebook.py
@@ -1,1 +1,2 @@
-old line
+new line
+++ legal added source`
    const hunk = parsePatch(previewDiff(input, 10))[0]?.hunks[0]

    expect(hunk?.lines).toEqual(["-old line", "+new line", "+++ legal added source"])
    expect(hunk?.oldLines).toBe(1)
    expect(hunk?.newLines).toBe(2)
  })

  // #233：完整 hunk 之后的文件头不得被当作前一 hunk 的源码体
  // #233：双文件输入解析出两个 patch——Index 头行数不进入任一 hunk 的计数
  test("does not treat later file headers as previous hunk source", () => {
    const input = `Index: /tmp/one.py
===================================================================
--- /tmp/one.py
+++ /tmp/one.py
@@ -1,1 +1,1 @@
--- legal removed source
+++ legal added source
Index: /tmp/two.py
===================================================================
--- /tmp/two.py
+++ /tmp/two.py
@@ -1,1 +1,1 @@
-old two
+new two`
    const patches = parsePatch(previewDiff(input, 10))

    expect(patches).toHaveLength(2)
    expect(patches[0]?.hunks[0]?.lines).toContain("--- legal removed source")
    expect(patches[0]?.hunks[0]?.lines).toContain("+++ legal added source")
    expect(patches[1]?.oldFileName).toBe("/tmp/two.py")
    expect(patches[1]?.hunks[0]?.lines).toContain("+new two")
  })

  // #233：完整 hunk 后紧跟相邻文件头时各自独立解析
  test("does not consume adjacent file headers after a complete hunk", () => {
    const input = `--- /tmp/one.py
+++ /tmp/one.py
@@ -1,1 +1,1 @@
-old one
+new one
--- /tmp/two.py
+++ /tmp/two.py
@@ -1,1 +1,1 @@
-old two
+new two`
    const patches = parsePatch(previewDiff(input, 10))

    expect(patches).toHaveLength(2)
    expect(patches[0]?.oldFileName).toBe("/tmp/one.py")
    expect(patches[0]?.hunks[0]?.lines).toEqual(["-old one", "+new one"])
    expect(patches[1]?.oldFileName).toBe("/tmp/two.py")
    expect(patches[1]?.hunks[0]?.lines).toEqual(["-old two", "+new two"])
  })

  // #233：不完整 hunk 后跟已满足侧的行——flush 省略号并透传，不进入死循环
  test("does not loop when an incomplete hunk is followed by an already-satisfied side", () => {
    const input = `Index: /tmp/incomplete.py
===================================================================
--- /tmp/incomplete.py
+++ /tmp/incomplete.py
@@ -1,2 +1,1 @@
-old
+new
+++ already satisfied side`
    const preview = previewDiff(input, 10)

    expect(preview).toContain(" …")
    expect(preview).toContain("+++ already satisfied side")
  })

  test("repairs an already-clipped hunk before diff rendering", () => {
    // 上游已裁剪的 hunk 头计数失真，按实际可见行修复
    const hunk = parsePatch(previewDiff(partialHunk, 10))[0]?.hunks[0]

    expect(hunk?.lines.at(-1)).toBe(" …")
    expect(hunk?.oldLines).toBe(11)
    expect(hunk?.newLines).toBe(5)
  })
})
