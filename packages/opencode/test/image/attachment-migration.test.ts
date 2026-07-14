import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
const FIXTURES_DIR = path.join(import.meta.dir, "../tool/fixtures")
const MIGRATION_SCRIPT = path.join(import.meta.dir, "../../script/migrate-image-attachment.ts")
async function migrateImageAttachment(args: string[]) {
  const child = Bun.spawn([process.execPath, MIGRATION_SCRIPT, ...args], { cwd: path.join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode, stdout, stderr }
}

test("bundles the real Sharp loader and native assets without executing a program", async () => {
  const { createSharpNativeFileMap, sharpPlugin } = await import("../../script/sharp-native")
  const native = await createSharpNativeFileMap({ os: process.platform, arch: process.arch === "arm64" ? "arm64" : "x64" })
  expect(native.supported).toBe(true)
  const unsupported = await createSharpNativeFileMap({ os: "win32", arch: "arm64" })
  expect(unsupported.supported).toBe(false)
  expect(unsupported.source).toContain('"addon":null')
  // 只验证正式plugin与资源表能生成bundle；不compile、不运行产物或OpenCode helper。
  const result = await Bun.build({
    target: "bun", conditions: ["bun", "node"], plugins: [sharpPlugin], root: path.join(import.meta.dir, "../.."),
    files: {
      "sharp-build-probe.gen.ts": 'import sharp from "sharp"; export default sharp.versions',
      "opencode-sharp.gen.ts": native.source,
    },
    entrypoints: ["sharp-build-probe.gen.ts", "opencode-sharp.gen.ts"],
  })
  if (!result.success) throw new AggregateError(result.logs, "Sharp bundle failed")
  const output = (await Promise.all(result.outputs.filter((file) => file.kind === "entry-point").map((file) => file.text()))).join("\n")
  expect(output).toContain("__OPENCODE_SHARP_NATIVE_PATH")
  expect(result.outputs.length).toBeGreaterThan(2)
})

describe("image attachment migration", () => {
  // fixture集中构造四类库存形态：正常小图/正常大图/Tool大图/Tool坏图。
  async function fixture(dbPath: string) {
    // 小WebP作为正常图片基线，能够证明全库扫描不会自动触发重编码。
    const small = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
    // 同一大图分别落在顶层和Tool中，用于锁定“来源不改变规范化结果”的不变量。
    const large = Buffer.from(await Bun.file(path.join(FIXTURES_DIR, "large-image.png")).arrayBuffer()).toString("base64")
    // 保留合法PNG data URL外形，确保迁移面对的是Sharp DecodeError而非参数错误。
    const broken = Buffer.from("truncated image bytes").toString("base64")
    const rows = [
      // preserved字段是未知字段哨兵：迁移后必须原样存在，证明局部更新而非重建对象。
      JSON.stringify({ type: "file", mime: "image/webp", url: `data:image/webp;base64,${small}`, preserved: "small" }),
      JSON.stringify({ type: "file", mime: "image/png", url: `data:image/png;base64,${large}`, preserved: "large" }),
      JSON.stringify({
        // Tool行携带output与metadata，锁定重编码不会波及非图片字段。
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          output: "large tool output",
          metadata: { preserved: true },
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${large}`, filename: "large.png" }],
        },
      }),
      JSON.stringify({
        // 坏图行是弃用授权的唯一来源：bytes损坏但MIME与URL形态合法。
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          output: "broken tool output",
          metadata: { preserved: true },
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${broken}`, filename: "broken.png" }],
        },
      }),
    ]
    const db = new Database(dbPath)
    // 最小真实表只保留脚本使用的Part列，测试不复制无关生产schema。
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)")
    rows.forEach((data, index) =>
      // prt_N有序ID让ORDER BY比对稳定，报告里的part定位可读。
      db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run(`prt_${index}`, `msg_${index}`, "ses_migrate", data),
    )
    db.close()
    // 返回原始bytes供空间断言独立重算，不依赖脚本自身的统计。
    return { rows, small: Buffer.from(small, "base64"), large: Buffer.from(large, "base64"), broken: Buffer.from(broken, "base64") }
  }

  test("previews and applies one unified image migration", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const input = await fixture(dbPath)

    // 路径参数默认必须只读，但仍实际经过Sharp，才能准确识别规范化和不可用图片。
    const preview = await migrateImageAttachment([dbPath])
    expect(preview.exitCode).toBe(0)
    // lastIndexOf定位JSON报告起点，前导日志不会破坏解析。
    const previewReport = JSON.parse(preview.stdout.slice(preview.stdout.lastIndexOf('{\n  "status"')))
    // 四张图覆盖不变、两处规范化和一处弃用，计数变化能直接暴露漏扫或重复扫描。
    expect(previewReport).toMatchObject({
      status: "preview",
      image_attachments: 4,
      unchanged: 1,
      normalized: 2,
      unavailable: 1,
      changed_parts: 3,
      database_file_shrinks_without_vacuum: false,
    })
    expect(previewReport.unavailable_items).toEqual([{ part: "prt_3", location: "tool", index: 0 }])
    const previewDb = new Database(dbPath, { readonly: true })
    // preview不仅报告为只读，四行原始JSON也必须逐字不变，防止隐藏的落库副作用。
    expect(previewDb.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)).toEqual(input.rows)
    previewDb.close()

    // apply复用同一fixture库：验证preview→apply的两阶段流转而非两个孤例。
    const applied = await migrateImageAttachment([dbPath, "--apply"])
    expect(applied.exitCode).toBe(0)
    const report = JSON.parse(applied.stdout.slice(applied.stdout.lastIndexOf('{\n  "status"')))
    expect(report.status).toBe("applied")
    // apply断言重新读取SQLite，而不是复用CLI内存计划，确保验证的是实际持久化结果。
    const db = new Database(dbPath, { readonly: true })
    const storedText = db.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)
    const stored = storedText.map((data) => JSON.parse(data))
    db.close()

    // 正常小图必须保持字节级不变；两种来源的同一大图必须得到完全相同的统一输出。
    expect(storedText[0]).toBe(input.rows[0])
    // URL改变证明真实重编码发生，而不是只改报告计数。
    expect(stored[1].url).not.toBe(JSON.parse(input.rows[1]).url)
    expect(stored[1].mime).toBe(stored[2].state.attachments[0].mime)
    expect(stored[1].url).toBe(stored[2].state.attachments[0].url)
    // 保留断言覆盖两种Part的未知字段，防止迁移用重建对象替代局部更新。
    expect(stored[1].preserved).toBe("large")
    expect(stored[2].state.metadata).toEqual({ preserved: true })

    // 用户授权只弃用无法解码的completed Tool图片，原Tool文本和其他字段都必须保留。
    expect(stored[3].state.attachments).toBeUndefined()
    expect(stored[3].state.output).toBe(
      "broken tool output\n\n[Image unavailable: stored image data could not be decoded.]",
    )
    expect(stored[3].state.metadata).toEqual({ preserved: true })

    // 空间值由实际输入和落库结果独立计算，不能只相信CLI自己的聚合字段。
    // 期望来自fixture输入，实际来自回读，两侧互不引用CLI内部状态。
    const oldPayload = input.small.length + input.large.length * 2 + input.broken.length
    const newPayload = input.small.length + Buffer.from(stored[1].url.split(",")[1], "base64").length * 2
    expect(report.old_payload_bytes).toBe(oldPayload)
    expect(report.new_payload_bytes).toBe(newPayload)
    expect(report.saved_payload_bytes).toBe(oldPayload - newPayload)
    // JSON逻辑空间独立于payload统计，包含data URL编码和不可用说明带来的真实差值。
    expect(report.old_part_json_bytes).toBe(input.rows.reduce((total, data) => total + Buffer.byteLength(data), 0))
    expect(report.new_part_json_bytes).toBe(storedText.reduce((total, data) => total + Buffer.byteLength(data), 0))

    // 已规范化和已标记不可用的数据再次preview必须完全幂等，不重复有损编码或追加说明。
    // 幂等计数为0同时证明弃用标记的contains检查生效。
    const repeated = await migrateImageAttachment([dbPath])
    expect(repeated.exitCode).toBe(0)
    expect(JSON.parse(repeated.stdout.slice(repeated.stdout.lastIndexOf('{\n  "status"')))).toMatchObject({
      normalized: 0,
      unavailable: 0,
      changed_parts: 0,
    })
    // 120s上限覆盖Sharp首次装载与四次真实解码的完整链路。
  }, 120_000)

  test("rolls back every row when a later CAS update fails", async () => {
    // 回滚用例与主用例共享fixture，唯一差异是触发器。
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const input = await fixture(dbPath)
    const db = new Database(dbPath)
    // 只拒绝最后一行，确保测试证明前面成功执行的UPDATE也随事务回滚。
    db.run("CREATE TRIGGER reject_last_update BEFORE UPDATE OF data ON part WHEN OLD.id = 'prt_3' BEGIN SELECT RAISE(IGNORE); END")
    db.close()

    const result = await migrateImageAttachment([dbPath, "--apply"])
    // 非零退出是事务失败的外部契约；随后逐行比对证明没有留下部分成功状态。
    expect(result.exitCode).not.toBe(0)
    const check = new Database(dbPath, { readonly: true })
    expect(check.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)).toEqual(input.rows)
    check.close()
  }, 120_000)

  test("normalizes both durable media layouts in one atomic transaction", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const input = await fixture(dbPath)
    const small = { mime: "image/webp", uri: `data:image/webp;base64,${input.small.toString("base64")}`, name: "small.webp" }
    const large = { mime: "image/png", uri: `data:image/png;base64,${input.large.toString("base64")}`, name: "large.png", source: { preserved: true } }
    const broken = { mime: "image/png", uri: `data:image/png;base64,${input.broken.toString("base64")}` }
    const pdf = { mime: "application/pdf", uri: "data:application/pdf;base64,AA==" }
    const note = "[Image unavailable: stored image data could not be decoded.]"
    // Native的type在SQL列，data中没有type/id；content-only媒体不能依赖展示附件发现。
    const messages = [
      { type: "user", data: JSON.stringify({ text: "small", files: [small], preserved: "small" }, null, 2) },
      { type: "user", data: JSON.stringify({ text: "large", files: [large], preserved: "large" }) },
      { type: "assistant", data: JSON.stringify({ content: [
        { type: "tool", id: "done", name: "read", time: { created: 1, completed: 2 }, state: {
          status: "completed", input: { file: "large.png" }, structured: { preserved: true }, outputPaths: ["kept"],
          attachments: [large, broken, pdf], content: [{ type: "text", text: "original output" }, { type: "file", ...large }, { type: "file", ...broken }],
        } },
        { type: "tool", id: "content-only", name: "read", time: { created: 1, completed: 2 }, state: {
          status: "completed", input: {}, structured: {}, content: [{ type: "file", ...large }],
        } },
        { type: "tool", id: "running", name: "read", time: { created: 1 }, state: {
          status: "running", input: {}, structured: {}, content: [{ type: "file", ...broken }],
        } },
        { type: "tool", id: "error", name: "read", time: { created: 1, completed: 2 }, state: {
          status: "error", input: {}, structured: {}, content: [{ type: "file", ...broken }], error: { message: "kept" },
        } },
      ], preserved: "assistant" }) },
    ]
    const db = new Database(dbPath)
    try {
      db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)")
      messages.forEach((message, index) => db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(`msg_native_${index}`, "ses_native", message.type, index, index + 1, index + 1, message.data))
      const read = (table: "part" | "session_message") => db.query<{ data: string }, []>(`SELECT data FROM ${table} ORDER BY id`).all().map(row => row.data)
      const preview = await migrateImageAttachment([dbPath])
      expect(preview.exitCode).toBe(0)
      const previewReport = JSON.parse(preview.stdout.slice(preview.stdout.lastIndexOf('{\n  "status"')))
      // 计数按实际存储槽位，不把attachments/content两份物理载荷误当一次。
      expect(previewReport).toMatchObject({ image_attachments: 11, unchanged: 2, normalized: 6, unavailable: 3, changed_parts: 3, changed_messages: 2 })
      expect(read("part")).toEqual(input.rows)
      expect(read("session_message")).toEqual(messages.map(message => message.data))
      // Native后行拒绝CAS时，先完成的V1写入和Native用户行也必须一起撤销。
      db.run("CREATE TRIGGER reject_native_update BEFORE UPDATE OF data ON session_message WHEN OLD.id = 'msg_native_2' BEGIN SELECT RAISE(IGNORE); END")
      expect((await migrateImageAttachment([dbPath, "--apply"])).exitCode).not.toBe(0)
      expect(read("part")).toEqual(input.rows)
      expect(read("session_message")).toEqual(messages.map(message => message.data))
      db.run("DROP TRIGGER reject_native_update")
      const applied = await migrateImageAttachment([dbPath, "--apply"])
      expect(applied.exitCode).toBe(0)
      const report = JSON.parse(applied.stdout.slice(applied.stdout.lastIndexOf('{\n  "status"')))
      const nativeText = read("session_message")
      const stored = nativeText.map(data => JSON.parse(data))
      const legacy = read("part").map(data => JSON.parse(data))
      expect(nativeText[0]).toBe(messages[0].data)
      expect(stored[1].preserved).toBe("large")
      const uri = stored[1].files[0].uri
      const mime = stored[1].files[0].mime
      expect(uri).toBe(legacy[1].url)
      expect(uri).not.toBe(large.uri)
      expect(stored[1].files[0].source).toEqual({ preserved: true })
      const tools = stored[2].content
      expect(tools[0].state.attachments).toEqual([{ ...large, uri, mime }, pdf])
      expect(tools[0].state.content).toEqual([{ type: "text", text: "original output" }, { type: "file", ...large, uri, mime }, { type: "text", text: note }])
      expect(tools[0].state.structured).toEqual({ preserved: true })
      expect(tools[0].state.outputPaths).toEqual(["kept"])
      expect(tools[1].state.content).toEqual([{ type: "file", ...large, uri, mime }])
      expect(tools.slice(2)).toEqual(JSON.parse(messages[2].data).content.slice(2))
      expect(stored[2].preserved).toBe("assistant")
      expect(db.query("SELECT type, seq, time_created, time_updated FROM session_message ORDER BY id").all()).toEqual(messages.map((message, index) => ({ type: message.type, seq: index, time_created: index + 1, time_updated: index + 1 })))
      // 空间按回读JSON与fixture载荷独立重算，不复用迁移器计数来证明自己。
      expect(report.old_payload_bytes).toBe(input.small.length * 2 + input.large.length * 6 + input.broken.length * 3)
      expect(report.new_payload_bytes).toBe(input.small.length * 2 + Buffer.from(uri.split(",")[1], "base64").length * 6)
      expect(report.old_message_json_bytes).toBe(messages.reduce((sum, message) => sum + Buffer.byteLength(message.data), 0))
      expect(report.new_message_json_bytes).toBe(nativeText.reduce((sum, data) => sum + Buffer.byteLength(data), 0))
      const repeated = await migrateImageAttachment([dbPath])
      expect(repeated.exitCode).toBe(0)
      expect(JSON.parse(repeated.stdout.slice(repeated.stdout.lastIndexOf('{\n  "status"')))).toMatchObject({ normalized: 0, unavailable: 0, changed_parts: 0, changed_messages: 0 })
      // 用户坏图不能借Tool的弃用授权变成成功，非base64错误同样保持原行。
      const invalid = JSON.stringify({ text: "broken user", files: [broken] })
      db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run("msg_native_bad", "ses_native", "user", 3, 4, 4, invalid)
      expect((await migrateImageAttachment([dbPath, "--apply"])).exitCode).not.toBe(0)
      expect(read("session_message")).toEqual([...nativeText, invalid])
      const remote = JSON.stringify({ files: [{ ...broken, uri: "https://example.invalid/image.png" }] })
      db.query("UPDATE session_message SET data = ? WHERE id = 'msg_native_bad'").run(remote)
      expect((await migrateImageAttachment([dbPath, "--apply"])).exitCode).not.toBe(0)
      expect(read("session_message")).toEqual([...nativeText, remote])
      db.run("DELETE FROM session_message WHERE id = 'msg_native_bad'")
      // Native-only库也合法，不通过捕获缺表异常伪造空扫描。
      db.run("DROP TABLE part")
      const nativeOnly = await migrateImageAttachment([dbPath])
      expect(nativeOnly.exitCode).toBe(0)
      const nativeReport = JSON.parse(nativeOnly.stdout.slice(nativeOnly.stdout.lastIndexOf('{\n  "status"')))
      expect(nativeReport.changed_messages).toBe(0)
    } finally {
      db.close()
    }
  }, 120_000)
})

