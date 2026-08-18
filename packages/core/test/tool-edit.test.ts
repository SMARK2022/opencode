import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "@opencode-ai/core/format"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { closestMatch } from "@opencode-ai/core/tool/edit-excerpt"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions, toolHistory } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_edit_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let reads = 0
let denyAction: string | undefined
let denyReason: string | undefined
let afterRead = (_target: string, _content: Uint8Array): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [], reason: denyReason })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  reads = 0
  denyAction = undefined
  denyReason = undefined
  afterRead = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        fs
          .readFile(target)
          .pipe(
            Effect.tap((content) =>
              Effect.sync(() => reads++).pipe(Effect.andThen(Effect.suspend(() => afterRead(target, content)))),
            ),
          ),
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
      writeFile: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFile(target, content, options))),
      writeFileString: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFileString(target, content, options))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>, history: ReturnType<typeof toolHistory> = [], formatter: Format.Interface["file"] = () => Effect.succeed(false)) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          EditTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          // 仅替换进程型 formatter，文件条件提交及工具真实结算保持原实现。
          [Format.node, Layer.succeed(Format.Service, { file: formatter })],
          [SessionStore.node, Layer.mock(SessionStore.Service, { context: id => Effect.succeed(id === sessionID ? history : []) })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof EditTool.Input.Type | { path: string; oldString: string; newString: string; replaceAll?: boolean }, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "edit", input },
})

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("applies snapshot batches and normalized literals through the same Native leaf", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      tmp => Effect.gen(function* () {
        reset()
        const target = path.join(tmp.path, "batch.txt")
        const run = (edits: typeof EditTool.Input.Type["edits"]) => withTool(tmp.path,
          registry => settleTool(registry, call({ path: "batch.txt", edits })), toolHistory("batch.txt"))
        yield* Effect.promise(() => fs.writeFile(target, "alpha\nbeta\ngamma\n"))
        // 逆序输入且替换长度不同，必须按同一快照坐标倒序写入。
        const batch = yield* run([{ oldString: "gamma", newString: "long-G" }, { oldString: "alpha", newString: "A" }])
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("A\nbeta\nlong-G\n")
        expect(batch.output?.structured).toMatchObject({ replacements: 2 })
        expect(batch.output?.structured).not.toHaveProperty("inputProvenance")
        expect(writes).toHaveLength(1)
        for (const example of [
          { before: "foo", edits: [{ oldString: "foo", newString: "bar" }, { oldString: "bar", newString: "baz" }], reason: "Could not find" },
          { before: "abcdef", edits: [{ oldString: "abcd", newString: "X" }, { oldString: "cdef", newString: "Y" }], reason: "overlap" },
        ]) {
          reset()
          yield* Effect.promise(() => fs.writeFile(target, example.before))
          expect((yield* run(example.edits)).result).toMatchObject({ type: "error", value: expect.stringContaining(example.reason) })
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(example.before)
        }
        reset()
        yield* Effect.promise(() => fs.writeFile(target, "pad  \nsay \u201Chello\u201D end\n"))
        const quoted = yield* run([{ oldString: '"hello"', newString: "$& $1" }])
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("pad  \nsay $& $1 end\n")
        expect(quoted.output?.structured).toMatchObject({ syncInput: { path: "batch.txt", edits: [{ oldString: "\u201Chello\u201D", newString: "$& $1" }] } })
        // 使用source独立常量验证原ASCII提交指纹，而非实际弯引号slice或production自行生成的期望。
        const original = { byteLength: 7, sha256: "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a" }
        expect(quoted.output?.structured).toMatchObject({ inputProvenance: { rewrites: [{ editIndex: 0, original }] } })
        const quotedText = quoted.result.type === "text" ? quoted.result.value : ""
        expect(quotedText).toContain(`original=7 UTF-8 bytes sha256=${original.sha256}`)
        expect(quotedText).toContain("normalized oldString truth rewrites")
        // formatter 真正改写磁盘后，回执展示最终 diff，历史局部 newString 仍保留用户意图。
        const formatted = yield* withTool(tmp.path,
          registry => settleTool(registry, call({ path: "batch.txt", edits: [{ oldString: "end", newString: "done" }] })),
          toolHistory("batch.txt", "edit"), filepath => Effect.promise(async () => {
            await fs.writeFile(filepath, (await fs.readFile(filepath, "utf8")) + "\n")
            return true
          }))
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("pad  \nsay $& $1 done\n\n")
        expect(formatted.result).toMatchObject({ type: "text", value: expect.stringContaining("+say $& $1 done") })
        expect(formatted.output?.structured).toMatchObject({ syncInput: { edits: [{ oldString: "end", newString: "done" }] } })
        reset()
        // 真实结算同时观察归一化跳写字节、warning、替换次数和历史，不只测试孤立 matcher。
        const mixedEdits = [{ oldString: "x", newString: "y" }, { oldString: "foo - bar", newString: "foo - bar" }]
        yield* Effect.promise(() => fs.writeFile(target, "x\nfoo \u2013 bar\n"))
        const mixed = yield* run(mixedEdits)
        expect(mixed.output?.structured).not.toHaveProperty("inputProvenance")
        expect(mixed.result).toMatchObject({ type: "text", value: expect.stringContaining("Warning: 1 of 2 edit(s) were no-ops") })
        expect(mixed.output?.structured).toMatchObject({ replacements: 1, syncInput: { edits: mixedEdits } })
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("y\nfoo \u2013 bar\n")
        expect(writes).toHaveLength(1)
        for (const example of [
          { before: "x\nsame same", edits: [{ oldString: "x", newString: "y" }, { oldString: "same", newString: "same" }], reason: "occurrences" },
          { before: "x\nsame", edits: [{ oldString: "x", newString: "y" }, { oldString: "missing", newString: "missing" }], reason: "Could not find edits[1]" },
          { before: "foo \u2013 bar", edits: [{ oldString: "foo - bar", newString: "foo - bar" }], reason: "identical" },
        ]) {
          reset()
          // 无操作条目同样必须定位且唯一；任何失败整批零写入，漂移全 no-op 也不能成功。
          yield* Effect.promise(() => fs.writeFile(target, example.before))
          expect((yield* run(example.edits)).result).toMatchObject({ type: "error", value: expect.stringContaining(example.reason) })
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(example.before)
        }
        reset()
        yield* Effect.promise(() => fs.writeFile(target, "x\nsame same"))
        const repeated = yield* run([{ oldString: "x", newString: "y" }, { oldString: "same", newString: "same", replaceAll: true }])
        expect(repeated.output?.structured).toMatchObject({ replacements: 1 })
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("y\nsame same")
        yield* Effect.promise(() => fs.writeFile(target, "x-y and x\u2013y"))
        const hybrid = yield* run([{ oldString: "x-y", newString: "z", replaceAll: true }])
        // 异构replaceAll虽不能把所有actual塞入一个oldString，真实覆写事实仍须保留。
        expect(hybrid.output?.structured).toMatchObject({ inputProvenance: { rewrites: [{ editIndex: 0, original: { byteLength: 3, sha256: "cc96fed8b030120e59a6a0372a92de2d6abebf40d83d57012d449419c6799b7f" } }] } })
        yield* Effect.promise(() => fs.writeFile(target, "before\r\nline\r\n"))
        const physical = yield* run([{ oldString: "before\r\nline", newString: "new\nline" }])
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("new\r\nline\r\n")
        expect(physical.output?.structured).toMatchObject({ syncInput: { edits: [{ oldString: "before\nline", newString: "new\nline" }] } })
        const rewrites = Array.from({ length: 14 }, (_, index) => ({ oldString: `"v${index}"`, newString: `"n${index}"` }))
        yield* Effect.promise(() => fs.writeFile(target, rewrites.map((_, index) => `say \u201Cv${index}\u201D`).join("\n") + "\nstable"))
        const many = yield* run([...rewrites, { oldString: "stable", newString: "stable" }])
        // 完整数组独立于有限模型尾段，SHA必须整行展示且省略数可见。
        expect(many.output?.structured).toHaveProperty("inputProvenance.rewrites.length", 14)
        const manyText = many.result.type === "text" ? many.result.value : ""
        expect(manyText).toMatch(/- edits\[0\]: original=4 UTF-8 bytes sha256=[0-9a-f]{64}/)
        expect(manyText).toMatch(/- \.\.\. \d+ more rewrite fingerprint\(s\) stored in structured\.inputProvenance/)
        expect(manyText).toContain("Warning: 1 of 15 edit(s) were no-ops")
        expect(Schema.decodeUnknownSync(EditTool.Output)(many.output?.structured).warning?.split("\n").length).toBeLessThanOrEqual(10)
        // 超过通用默认预算仍必须在实际模型结果尾部看到 warning，原文保留沿用既有 owner。
        const long = "z".repeat(20000)
        yield* Effect.promise(() => fs.writeFile(target, `${long}\nkeep`))
        const bounded = yield* run([{ oldString: long, newString: `${long}q` }, { oldString: "keep", newString: "keep" }])
        expect(bounded.result).toMatchObject({ type: "text", value: expect.stringContaining("Warning: 1 of 2 edit(s) were no-ops") })
        expect(bounded.outputPaths?.length).toBeGreaterThan(0)
        expect(bounded.output?.structured).toMatchObject({ replacements: 1 })
      }),
      tmp => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("diagnoses the failed Native edit from the shared DP span", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      tmp => Effect.gen(function* () {
        const target = path.join(tmp.path, "candidate.txt")
        const candidate = "prefix target sequence alpha beta gamxa suffix"
        const renderActual = "actual-only:" + Array.from({ length: 2200 }, (_, index) => String.fromCharCode(33 + ((index * 37) % 90))).join("")
        // 单字符差异先满足距离条件，必须仅由展示输入预算拒绝，不能泄漏大型actual。
        const renderRequested = renderActual.slice(0, 1000) + (renderActual[1000] === "X" ? "Y" : "X") + renderActual.slice(1001)
        // 场景均调用真实registry/leaf；formatter替身隔离进程，任何失败不得落盘。
        for (const example of [
          { before: `target sequence alpha beta deltta\n${candidate}\n`, edits: [{ oldString: "target sequence alpha beta gamma", newString: "replacement" }], shown: ["Closest match at line 2", candidate], absent: ["target sequence alpha beta deltta"] },
          { before: "\u{1F600} prefix\r\nactual content\r\n", edits: [{ oldString: "actual contxnt", newString: "replacement" }], shown: ["Closest match at line 2", 'line 2 actual: "actual content"'], absent: [] },
          { before: "alpha\n\nbeta\n", edits: [{ oldString: "alpha\nbeta", newString: "replacement" }], shown: ["Closest match at line 1", "alpha\n\nbeta"], absent: [] },
          // 长上下文不能把已证明的变长actual裁掉，也不能重新按expected行数截窗。
          { before: `${"p".repeat(400)}alpha\n\nbeta${"s".repeat(400)}\n`, edits: [{ oldString: "alpha\nbeta", newString: "replacement" }], shown: ["alpha\n\nbeta"], absent: [] },
          { before: "ab", edits: [{ oldString: "abcd", newString: "replacement" }], shown: ['line 1 actual: "ab"'], absent: [] },
          { before: "a", edits: [{ oldString: "abcd", newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["Closest match"] },
          // 内部子串和整段同距时也必须抑制，不能靠遍历顺序选择其中一条证据。
          { before: "xb", edits: [{ oldString: "ab", newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["Closest match"] },
          { before: "actual contant\nactual contont", edits: [{ oldString: "actual content", newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["Closest match"] },
          { before: "say \u201Chello\u201D\nworld\n", edits: [{ oldString: '"hello"', newString: '"hi"' }, { oldString: "worxd", newString: "mars" }], shown: ["edits[1]", "Closest match at line 2", "world"], absent: ["say \u201Chello\u201D"] },
          { before: "ba", edits: [{ oldString: "aa", newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["Closest match"] },
          { before: "target sequence alpha beta gammo\nfiller\ntarget sequence alpha beta gammi\n", edits: [{ oldString: "target sequence alpha beta gamma", newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["gammo", "gammi"] },
          // 两类超限均必须经过真实wrapper后仍不展示actual，不能由第二renderer绕过。
          { before: renderActual, edits: [{ oldString: renderRequested, newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["actual-only:"] },
          { before: "actual content must remain private", edits: [{ oldString: "x".repeat(1_000_000), newString: "replacement" }], shown: ["No reliable nearby candidate was found"], absent: ["actual content"] },
          { before: "filler\n".repeat(20_000) + "target sequence alpha beta gamxa\n", edits: [{ oldString: "target sequence alpha beta gamma", newString: "replacement" }], shown: ["Closest match at line 20001", "gamxa"], absent: [] },
          // 独立构造十四档partial-word/carry边界，不让短oracle冒称覆盖32位进位。
          ...[31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 399, 400].map(length => {
            const actual = Array.from({ length }, (_, index) => String.fromCharCode(33 + ((index * 37) % 90))).join("")
            const index = Math.floor(length / 2)
            const expected = actual.slice(0, index) + (actual[index] === "X" ? "Y" : "X") + actual.slice(index + 1)
            return {
              before: `unrelated decoy\n${actual}\n`,
              edits: [{ oldString: expected, newString: "replacement" }],
              shown: ["Closest match at line 2", `difference: requested columns ${index + 1}-${index + 1}`],
              absent: [],
            }
          }),
        ]) {
          reset()
          yield* Effect.promise(() => fs.writeFile(target, example.before))
          const result = yield* withTool(tmp.path,
            registry => executeTool(registry, call({ path: "candidate.txt", edits: example.edits })), toolHistory("candidate.txt"))
          expect(result.type).toBe("error")
          if (result.type !== "error") throw new Error("Expected failed edit")
          for (const shown of example.shown) expect(result.value).toContain(shown)
          for (const absent of example.absent) expect(result.value).not.toContain(absent)
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(example.before)
        }
      }),
      tmp => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("registers and replaces relative exact text through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "hello.txt")
        const history: ReturnType<typeof toolHistory> = []
        return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["edit"])
                // 相同真实leaf先验证缺失/跨Session历史均拒绝，再显式提供当前文件的已读证据。
                const blind = call({ path: "hello.txt", oldString: "before", newString: "after" })
                expect(yield* executeTool(registry, blind)).toEqual({ type: "error", value: `File has not been read in this session: ${target}. Read it first to verify current content, then retry the edit.` })
                history.push(...toolHistory("hello.txt"))
                expect(yield* executeTool(registry, { ...blind, sessionID: SessionV2.ID.make("ses_other") })).toEqual({ type: "error", value: `File has not been read in this session: ${target}. Read it first to verify current content, then retry the edit.` })
                expect(assertions).toEqual([])
                expect(reads).toBe(0)
                expect(writes).toEqual([])

                expect(yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(
                  [],
                )
                const settled = yield* settleTool(
                  registry,
                  call({ path: "hello.txt", oldString: "before", newString: "after" }),
                )
                const shown = settled.result.type === "text" ? settled.result.value : ""
                expect(settled.result).toEqual({
                  type: "text",
                  value: expect.stringContaining("Edited file successfully: hello.txt\nReplacements: 1\nChanged:\n```diff\n"),
                })
                expect(settled.output?.structured).toEqual({
                  replacements: 1,
                  syncInput: { path: "hello.txt", edits: [{ oldString: "before", newString: "after" }] },
                  files: [
                    {
                      file: "hello.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                  ],
                })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\nrest\n")
                expect(shown).toContain("-before\n+after\n rest")
                expect(shown).toEndWith("\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.")
                expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["hello.txt"], save: ["*"] }])
                expect(writes).toEqual([yield* Effect.promise(() => fs.realpath(target))])
              }),
              history,
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
              toolHistory("absolute.txt", "write"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
              toolHistory(target, "edit"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              // 授权证据保留原始替换串，不通过提前读取外部文件生成第二份内容。
                expect(assertions[0]?.metadata).toMatchObject({ action_kind: "tool", tool: "edit", operation: "edit", edits: [{ oldString: "before", newString: "after" }] })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          yield* Effect.promise(() => fs.writeFile(external, "before"))
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
              toolHistory(external),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to edit ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
              toolHistory(external),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to edit ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("denied edit reads no target content and does not disclose whether oldString matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "secret.txt")
        return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const matching = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "not present", newString: "replacement" }),
                )

                expect(matching).toEqual({ type: "error", value: "Unable to edit secret.txt" })
                expect(missing).toEqual(matching)
                expect(assertions.map((input) => input.action)).toEqual(["edit", "edit"])
                expect(reads).toBe(0)
                expect(writes).toEqual([])

                // 自动拒绝保留审查反馈，但同样不能先探测文件内容。
                denyReason = "Automatic review rejected this edit. Ask the user before attempting it again."
                expect(yield* executeTool(registry, call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }))).toEqual({ type: "error", value: denyReason })
                expect(reads).toBe(0)
                expect(writes).toEqual([])
              }),
              toolHistory("secret.txt"),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects no-op, empty, missing, and ambiguous exact replacements", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "matches.txt")
        return Effect.promise(() => fs.writeFile(target, "same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "same" })),
                ).toEqual({
                  type: "error",
                  value: "No changes to apply: oldString and newString are identical.",
                })
                // 全 no-op 使用唯一 needle；独立歧义断言仍沿用多候选原文。
                yield* Effect.promise(() => fs.writeFile(target, "same same"))
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value: "oldString must not be empty. Use write to create or overwrite a file.",
                })
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "missing", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value: "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.\n\nNo reliable nearby candidate was found. Read the file and retry with exact text.",
                })
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value:
                    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
                })
                // 重叠literal也是第二候选，不能只按replaceAll的非重叠计数放行。
                yield* Effect.promise(() => fs.writeFile(target, "aaaa"))
                expect(yield* executeTool(registry, call({ path: "matches.txt", oldString: "aa", newString: "x" }))).toMatchObject({ type: "error", value: expect.stringContaining("multiple matches") })
                // 候选行号是实际窗口起点，而非带上一行context的起点。
                yield* Effect.promise(() => fs.writeFile(target, "header\nconst preferred = true\n"))
                const missing = yield* executeTool(registry, call({ path: "matches.txt", oldString: "const preferred = false", newString: "x" }))
                expect(missing).toMatchObject({ type: "error", value: expect.stringContaining('Closest match at line 2:\nline 2 actual: "const preferred = true"') })
                // 请求仍由原始 Tool input 保存，模型结果只呈现 actual 差异和位置。
                expect(JSON.stringify(missing)).not.toContain("const preferred = false")
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("header\nconst preferred = true\n")
                // 真实Native Edit失败必须显示900字符行末差异，不只证明孤立formatter可用。
                const prefix = "p".repeat(900)
                yield* Effect.promise(() => fs.writeFile(target, `return value;\n${prefix} private int x = 0;`))
                const mismatch = yield* executeTool(registry, call({ path: "matches.txt", oldString: `return value;\n${prefix} private int x = 1;`, newString: "replacement" }))
                expect(mismatch).toEqual({ type: "error", value: expect.stringContaining("x = 0") })
                // requested已在输入中；DP回执保留精确差异列及实际尾部，不重复请求正文。
                expect(mismatch).toEqual({ type: "error", value: expect.stringContaining("difference: requested columns 918-918 differ from actual columns 918-918") })
                expect(JSON.stringify(mismatch)).not.toContain("x = 1")
                expect(JSON.stringify(mismatch)).not.toContain("p".repeat(500))
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(`return value;\n${prefix} private int x = 0;`)
                expect(writes).toEqual([])
              }),
              toolHistory("matches.txt"),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces every exact occurrence when replaceAll is true", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "all.txt")
        return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "all.txt", oldString: "same", newString: "after", replaceAll: true })),
              toolHistory("all.txt"),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.output?.structured).toMatchObject({ replacements: 3 })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after after")
              expect(writes).toHaveLength(1)
              const literal = "$&! $1 $` $' $$"
              const replaced = yield* withTool(tmp.path, (registry) => settleTool(registry, call({ path: "all.txt", oldString: "after", newString: literal, replaceAll: true })), toolHistory("all.txt", "edit"))
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe([literal, literal, literal].join(" "))
              expect(replaced.result).toMatchObject({ type: "text", value: expect.stringContaining(literal) })
              // 唯一变化在第七行，模型必须看到真实 diff，而非前六行输入片段。
              const original = "a\nb\nc\nd\ne\nf\ng\n"
              const final = "a\nb\nc\nd\ne\nf\nG\n"
              yield* Effect.promise(() => fs.writeFile(target, original))
              const lastLine = yield* withTool(tmp.path, (registry) => settleTool(registry, call({ path: "all.txt", oldString: original, newString: final })), toolHistory("all.txt", "edit"))
              expect(lastLine.result).toMatchObject({ value: expect.stringContaining("-g\n+G") })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(final)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves BOM and file line endings in edits and diffs", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        const target = path.join(tmp.path, "windows.txt")
        for (const ending of ["\n", "\r\n", "\r"]) {
          reset()
          yield* Effect.promise(() => fs.writeFile(target, `\uFEFFbefore${ending}rest${ending}`))
          // 真实 registry 结算还要校验逻辑 diff，不能只看到写盘正文正确。
          const settled = yield* withTool(tmp.path, (registry) =>
            settleTool(registry, call({ path: "windows.txt", oldString: "before\r\nrest", newString: "after\nrest" })),
            toolHistory("windows.txt"),
          )
          const output = Schema.decodeUnknownSync(EditTool.Output)(settled.output?.structured)
          expect(output.replacements).toBe(1)
          expect(output.files[0]).toMatchObject({ additions: 1, deletions: 1 })
          expect(output.files[0]?.patch).toContain("-before\n+after\n")
          expect(output.files[0]?.patch).not.toContain("\r")
          expect(output.files[0]?.patch).not.toContain("\uFEFF")
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(`\uFEFFafter${ending}rest${ending}`)
          expect(writes).toHaveLength(1)
        }
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an in-place content change after matching but before conditional commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "concurrent.txt")
        afterRead = () => (reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "concurrent.txt", oldString: "before", newString: "after" })),
              toolHistory("concurrent.txt"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({
                type: "error",
                value: "File changed after permission approval. Read it again before editing.",
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
              expect(writes).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps the locked edit schema, semantics docstring, and deferred TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/edit.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["edits", "path"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  // exact-only合同已生效，移除旧fuzzy移植待办而非恢复已废弃的成功域。
  expect(source).not.toContain("TODO: Port V1 fuzzy correction")
  for (const todo of [
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})

test("Native diagnostic wrapper agrees with an exhaustive scalar span oracle", () => {
  // 独立逐span标量距离不共享production的bit-vector、carry、endpoint或恢复过程。
  const distance = (left: string[], right: string[]) => {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let i = 1; i <= left.length; i++) {
      let diagonal = row[0]
      row[0] = i
      for (let j = 1; j <= right.length; j++) {
        const above = row[j]
        row[j] = Math.min(above + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
        diagonal = above
      }
    }
    return row[right.length]
  }
  // 穷举所有非空连续span后才判断全局tie与一次score gate，不能偏好终点或长度。
  const oracle = (content: string, expected: string) => {
    const text = Array.from(content)
    const pattern = Array.from(expected)
    let best = Infinity
    let spans: { start: number; end: number }[] = []
    for (let start = 0; start < text.length; start++) {
      for (let end = start + 1; end <= text.length; end++) {
        const value = distance(pattern, text.slice(start, end))
        if (value > best) continue
        if (value < best) {
          best = value
          spans = []
        }
        spans.push({ start, end })
      }
    }
    // 同end不同起点也是真实tie；不能让高分替不唯一的证据背书。
    if (spans.length !== 1) return undefined
    const span = spans[0]
    const score = 1 - best / Math.max(pattern.length, span.end - span.start)
    return score >= 0.5 ? { line: 1, score } : undefined
  }
  // 二元1..5长共62×62对检验公开结果；跨word和真实leaf另由上面的场景覆盖。
  const samples: string[] = []
  for (let length = 1; length <= 5; length++) {
    for (let bits = 0; bits < 2 ** length; bits++) {
      samples.push(Array.from({ length }, (_, index) => (bits >>> index) & 1 ? "a" : "b").join(""))
    }
  }
  for (const content of samples) {
    for (const expected of samples) {
      const actual = closestMatch(content, expected)
      expect(actual && { line: actual.line, score: actual.score }).toEqual(oracle(content, expected))
    }
  }
})
