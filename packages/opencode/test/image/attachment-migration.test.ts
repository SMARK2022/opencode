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
  test(
    "dry-runs, migrates once, remains idempotent, and rejects non-images",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "opencode.db")
      const backupDir = path.join(tmp.path, "backups")
      // 大图fixture确保Sharp真实执行缩放路径，而不是小图原样旁路。
      const source = path.join(FIXTURES_DIR, "large-image.png")
      const sourceBytes = Buffer.from(await Bun.file(source).arrayBuffer())
      const oldBytes = Buffer.from("known truncated image bytes")
      // 旧bytes刻意不可解码：迁移不应读取或“修补”坏数据，只将其hash作为CAS前置条件。
      const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const original = JSON.stringify({
        type: "tool",
        state: {
          status: "completed",
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${oldBytes.toString("base64")}` }],
        },
      })
      const db = new Database(dbPath)
      // WAL模式与生产库一致：备份快照必须包含未checkpoint的已提交页。
      db.run("PRAGMA journal_mode = WAL")
      // 最小真实SQLite表保留脚本依赖的四列，让测试聚焦Part行为而非复制生产schema。
      db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)")
      db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run("prt_migrate", "msg_migrate", "ses_migrate", original)
      db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run("prt_unrelated", "msg_unrelated", "ses_unrelated", original)
      const args = [
        // source和两份旧hash全部显式传入，测试同时锁住“不扫描、不猜测”的CLI契约。
        "--db",
        dbPath,
        "--part",
        "prt_migrate",
        "--source",
        source,
        "--expected-old-sha",
        hash(oldBytes),
        "--expected-source-sha",
        hash(sourceBytes),
      ]

      // Dry-run必须实际经过Sharp才能给出新hash，但不能创建备份或改写目标行。
      const dryRun = await migrateImageAttachment(args)
      expect(dryRun.exitCode).toBe(0)
      const report = JSON.parse(dryRun.stdout.slice(dryRun.stdout.lastIndexOf('{\n  "status"')))
      expect(report.status).toBe("dry-run")
      const dryRunDb = new Database(dbPath, { readonly: true })
      expect(dryRunDb.query("SELECT data FROM part").get()).toEqual({ data: original })
      dryRunDb.close()

      // 错误source hash必须在创建备份和写库前失败。
      const rejectedHash = await migrateImageAttachment([
        ...args.slice(0, -1),
        "0".repeat(64),
        "--expected-new-sha",
        report.new_sha256,
        "--backup-dir",
        backupDir,
        "--apply",
      ])
      expect(rejectedHash.exitCode).not.toBe(0)
      expect(await Bun.file(backupDir).exists()).toBe(false)

      // Apply将dry-run产出的hash变成第三个前置条件，防止Sharp版本或编码结果漂移后静默写库。
      const applyArgs = [...args, "--expected-new-sha", report.new_sha256, "--backup-dir", backupDir, "--apply"]
      // RAISE(IGNORE)让UPDATE静默零行生效，模拟并发竞争而不需要真实多进程。
      db.run("CREATE TRIGGER reject_part_update BEFORE UPDATE OF data ON part BEGIN SELECT RAISE(IGNORE); END")
      const casRejected = await migrateImageAttachment(applyArgs)
      expect(casRejected.exitCode).not.toBe(0)
      // changes=0必须保持事务零写入；之后删除触发器再验证同一命令仍可正常迁移。
      expect(db.query("SELECT data FROM part WHERE id = 'prt_migrate'").get()).toEqual({ data: original })
      db.run("DROP TRIGGER reject_part_update")
      const applied = await migrateImageAttachment(applyArgs)
      expect(applied.exitCode).toBe(0)
      expect(applied.stdout).toContain('"status": "migrated"')
      const appliedReport = JSON.parse(applied.stdout.slice(applied.stdout.lastIndexOf('{\n  "status"')))
      // Apply成功必须留下可独立恢复的一致master及其manifest，而不是只证明目标行已改变。
      expect(await Bun.file(path.join(appliedReport.backup, "master", "opencode.db")).exists()).toBe(true)
      expect(await Bun.file(path.join(appliedReport.backup, "manifest.json")).exists()).toBe(true)
      const master = new Database(path.join(appliedReport.backup, "master", "opencode.db"), { readonly: true })
      // 保持另一个WAL连接存活，确认一致快照包含已提交WAL中的无关行且仍保留迁移前目标值。
      expect(master.query("SELECT count(*) AS count FROM part").get()).toEqual({ count: 2 })
      expect(master.query("SELECT data FROM part WHERE id = 'prt_migrate'").get()).toEqual({ data: original })
      master.close()
      const migratedDb = new Database(dbPath)
      // 直接回读数据库而非相信stdout，确认实际存储的是Sharp生成且hash匹配的附件。
      const migrated = JSON.parse((migratedDb.query<{ data: string }, []>("SELECT data FROM part").get() as { data: string }).data)
      expect(migrated.state.attachments[0].mime).toBe(report.new_mime)
      expect(hash(Buffer.from(migrated.state.attachments[0].url.split(",")[1], "base64"))).toBe(report.new_sha256)
      expect(migratedDb.query("SELECT count(*) AS count FROM part").get()).toEqual({ count: 2 })

      // 重跑仍验证source与确定性输出，随后在创建备份前幂等退出。
      const repeated = await migrateImageAttachment(applyArgs)
      expect(repeated.exitCode).toBe(0)
      expect(repeated.stdout).toContain('"status": "already migrated"')

      // 相同bytes但错误MIME不能走幂等短路，避免provider按错误媒体类型解释正确payload。
      migrated.state.attachments[0].mime = report.new_mime === "image/png" ? "image/jpeg" : "image/png"
      migratedDb.query("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify(migrated), "prt_migrate")
      const mismatchedMime = await migrateImageAttachment(applyArgs)
      expect(mismatchedMime.exitCode).not.toBe(0)
      expect(mismatchedMime.stderr).toContain("MIME")

      // 即使bytes与new hash一致，非图片MIME也不能借幂等分支绕过工具的图片专用边界。
      migrated.state.attachments[0].mime = "application/pdf"
      migratedDb.query("UPDATE part SET data = ? WHERE id = ?").run(JSON.stringify(migrated), "prt_migrate")
      migratedDb.close()
      db.close()
      const rejected = await migrateImageAttachment(applyArgs)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toContain("is not an image")
    },
    120_000,
  )
})

