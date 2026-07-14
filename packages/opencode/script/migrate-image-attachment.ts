#!/usr/bin/env bun

import { Image } from "../src/image/image"
import { Config } from "../src/config/config"
import { MessageID, PartID, SessionID } from "../src/session/schema"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

const usage = `Usage:
  bun script/migrate-image-attachment.ts --db <opencode.db> --part <part-id> --source <complete-image> \\
    --expected-old-sha <sha256> --expected-source-sha <sha256> [--expected-new-sha <sha256>] \\
    [--attachment-index 0] [--token-budget 1600] [--backup-dir <dir>] [--apply]

The default mode is read-only. Run it once to obtain expected-new-sha, then repeat with
--apply, --expected-new-sha and --backup-dir. The script never searches for replacement files.`

type Options = {
  db: string
  part: string
  source: string
  oldSha: string
  sourceSha: string
  newSha?: string
  attachmentIndex: number
  tokenBudget: number
  apply: boolean
  backupDir?: string
}

type PartRow = { id: string; message_id: string; session_id: string; data: string }
type FileAttachment = { type: "file"; mime: string; url: string; [key: string]: unknown }

const values = parseArgs({
  // 所有恢复依据都由调用者显式提供；脚本不扫描目录或根据文件名猜测完整原件。
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean" },
    db: { type: "string" },
    part: { type: "string" },
    source: { type: "string" },
    "expected-old-sha": { type: "string" },
    "expected-source-sha": { type: "string" },
    "expected-new-sha": { type: "string" },
    "attachment-index": { type: "string", default: "0" },
    "token-budget": { type: "string", default: "1600" },
    "backup-dir": { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
}).values

if (values.help) {
  console.log(usage)
  process.exit(0)
}

const options: Options = {
  db: path.resolve(required("db", values.db)),
  part: required("part", values.part),
  source: path.resolve(required("source", values.source)),
  oldSha: required("expected-old-sha", values["expected-old-sha"]).toLowerCase(),
  sourceSha: required("expected-source-sha", values["expected-source-sha"]).toLowerCase(),
  newSha: values["expected-new-sha"]?.toLowerCase(),
  attachmentIndex: finiteInteger("attachment-index", values["attachment-index"]),
  tokenBudget: finiteInteger("token-budget", values["token-budget"]),
  apply: values.apply ?? false,
  backupDir: values["backup-dir"] ? path.resolve(values["backup-dir"]) : undefined,
}

if (options.apply && (!options.newSha || !options.backupDir))
  throw new Error("--apply requires --expected-new-sha and --backup-dir")
if (options.newSha === options.oldSha) throw new Error("--expected-new-sha must differ from --expected-old-sha")

await main(options)

async function main(input: Options) {
  // Dry-run以只读方式打开数据库；任何写权限和备份成本都只在显式--apply后启用。
  const db = input.apply ? new Database(input.db) : new Database(input.db, { readonly: true })
  try {
    const row = db.query<PartRow, [string]>("SELECT id, message_id, session_id, data FROM part WHERE id = ?").get(input.part)
    // 只接受精确Part ID，不按session、文件名或附件内容模糊扫描历史数据。
    if (!row) throw new Error(`Part not found: ${input.part}`)
    const part = JSON.parse(row.data)
    const state = isRecord(part) && part.type === "tool" && isRecord(part.state) ? part.state : undefined
    const value = state?.status === "completed" && Array.isArray(state.attachments) ? state.attachments[input.attachmentIndex] : undefined
    if (!isRecord(value) || value.type !== "file" || typeof value.mime !== "string" || typeof value.url !== "string")
      throw new Error(`Completed Tool attachment ${input.attachmentIndex} was not found`)
    // 维护工具只能修复图片；即使调用者提供了匹配hash，也不能把PDF或任意文件替换成Sharp输出。
    if (!value.mime.startsWith("image/")) throw new Error(`Attachment ${input.attachmentIndex} is not an image`)
    const attachment = value as FileAttachment
    if (!attachment.url.startsWith(`data:${attachment.mime};base64,`))
      throw new Error("Attachment MIME does not match its data URL")
    const oldSha = digest(dataUrlBytes(attachment.url))
    // oldSha描述数据库当前收到的payload；它不是文件名、MIME或source的替代品。
    // 三个身份分别校验，避免把“内容看似正确”的错误记录当作已修复记录。
    const migrated = input.newSha !== undefined && oldSha === input.newSha
    if (!migrated && oldSha !== input.oldSha) throw new Error(`Attachment SHA mismatch: expected ${input.oldSha}, found ${oldSha}`)

    const source = Buffer.from(await Bun.file(input.source).arrayBuffer())
    const sourceSha = digest(source)
    // 完整源hash是恢复的数据来源契约，必须在调用Sharp之前确认。
    // 脚本不截断、拼接或尝试修补旧bytes；唯一新内容来自调用者确认的完整源文件。
    // 即使当前记录已经命中新hash，也必须重新确认source，保证幂等结果仍可审计。
    if (sourceSha !== input.sourceSha) throw new Error(`Source SHA mismatch: expected ${input.sourceSha}, found ${sourceSha}`)
    const sharp = (await import("sharp")).default
    const format = (await sharp(source).metadata()).format
    // Sharp的format是解码器识别出的实际格式，不信任原记录的扩展名或MIME声明。
    const sourceMime = format === "svg" ? "image/svg+xml" : format ? `image/${format}` : undefined
    // 小图可能由Image.Service原样返回，因此必须用实际源格式而不是损坏附件声明的MIME。
    if (!sourceMime) throw new Error(`Unsupported source image format: ${format ?? "unknown"}`)
    const normalized = await normalize(row, sourceMime, source, input.tokenBudget)
    const output = dataUrlBytes(normalized.url)
    // normalized.url再次按其自报MIME校验，防止服务实现返回bytes与metadata不一致。
    if (!normalized.url.startsWith(`data:${normalized.mime};base64,`)) throw new Error("Normalized MIME does not match its data URL")
    // metadata成功不足以证明历史修复可用；迁移前强制Sharp走完整输出路径。
    await sharp(output).toBuffer()
    const newSha = digest(output)
    if (input.newSha && newSha !== input.newSha)
      throw new Error(`Normalized SHA mismatch: expected ${input.newSha}, found ${newSha}`)
    // 幂等成功同样完整验证source和确定性输出，不能仅凭调用者把当前hash填进new参数就伪造成功。
    if (migrated) {
      // 幂等只表示同一份完整附件已存在，不表示可以修复错误的媒体声明。
      if (attachment.mime !== normalized.mime || !attachment.url.startsWith(`data:${normalized.mime};base64,`))
        throw new Error("Migrated attachment metadata does not match its bytes")
      console.log(JSON.stringify({ status: "already migrated", part: input.part, sha256: oldSha }, null, 2))
      return
    }

    // 只有所有内容前置条件通过后才生成2GB级备份；错误参数和幂等重跑不会制造无用副本。
    // backup返回后master已通过独立clone校验，后续代码不得打开或修改master本身。
    const backup = input.apply ? await backupDatabase(db, input.db, input.backupDir!) : undefined
    const report = {
      status: input.apply ? "ready" : "dry-run",
      part: input.part,
      attachment_index: input.attachmentIndex,
      old_sha256: oldSha,
      source_sha256: sourceSha,
      new_sha256: newSha,
      new_mime: normalized.mime,
      new_bytes: output.length,
      backup,
    }
    if (!input.apply) {
      // Dry-run只给出确定的新hash，供第二次--apply形成old/source/new三重前置条件。
      console.log(JSON.stringify(report, null, 2))
      return
    }

    // 写事务前再次确认master没有被验证过程或外部程序改动。
    // 备份hash失配时在UPDATE前终止，live数据库仍保持原值。
    await verifyBackupManifest(backup!)
    const next = structuredClone(part)
    next.state.attachments[input.attachmentIndex] = { ...attachment, mime: normalized.mime, url: normalized.url }
    const nextData = JSON.stringify(next)
    db.transaction(() => {
      // 完整旧JSON参与CAS，哪怕同一Part被别的进程改了非附件字段也会拒绝覆盖。
      // 校验与UPDATE位于同一事务，任一检查抛错都由SQLite原子回滚。
      const result = db.query("UPDATE part SET data = ? WHERE id = ? AND data = ?").run(nextData, input.part, row.data)
      if (result.changes !== 1) throw new Error(`CAS updated ${result.changes} rows instead of 1`)
      // 比较完整序列化JSON，确保目标附件之外的字段没有在构造或落库时丢失。
      const stored = db.query<{ data: string }, [string]>("SELECT data FROM part WHERE id = ?").get(input.part)
      if (stored?.data !== nextData) throw new Error("Stored Part does not match the intended JSON")
      if (db.query("PRAGMA foreign_key_check").all().length !== 0) throw new Error("foreign_key_check failed")
      const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      if (integrity?.integrity_check !== "ok") throw new Error("integrity_check failed")
    })()
    console.log(JSON.stringify({ ...report, status: "migrated" }, null, 2))
  } finally {
    db.close()
  }
}

async function normalize(row: PartRow, mime: string, source: Buffer, tokenBudget: number) {
  // 迁移复用生产Image.Service；空Config只采用现有默认限制，不复制另一份resize算法。
  const layer = Image.layer.pipe(
    Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({}) })),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Image.Service).normalize(
        {
          id: PartID.make(row.id),
          messageID: MessageID.make(row.message_id),
          sessionID: SessionID.make(row.session_id),
          type: "file",
          mime,
          url: `data:${mime};base64,${source.toString("base64")}`,
        },
        { tokenBudget },
      )
    }).pipe(Effect.provide(layer)),
  )
}

async function backupDatabase(db: Database, dbPath: string, parent: string) {
  // Master是SQLite生成的完整一致数据库，不依赖外部进程是否正在checkpoint WAL。
  // VACUUM INTO由SQLite持有读快照，已提交WAL页面会被合并进单一可恢复数据库。
  await fs.mkdir(parent, { recursive: true })
  // page_count包含WAL可见页面，比主db文件大小更接近VACUUM快照的真实空间需求。
  const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0
  const bytes = pageCount * pageSize
  const disk = await fs.statfs(parent)
  // 峰值同时存在master和validation clone；空间不足时必须在接触live DB前停止。
  // validation结束即删除，因此长期只保留一份master和很小的manifest。
  if (disk.bavail * disk.bsize < bytes * 2) throw new Error("Backup drive lacks space for master and validation clone")
  const root = path.join(parent, `image-attachment-${new Date().toISOString().replaceAll(":", "-")}`)
  // 每次apply使用独立目录，避免旧备份与本次manifest混合后被误认为同一快照。
  const master = path.join(root, "master")
  const clone = path.join(root, "validation")
  await fs.mkdir(master, { recursive: true })
  const name = path.basename(dbPath)
  const masterDb = path.join(master, name)
  // 路径由脚本生成，但仍转义单引号，避免合法目录名破坏VACUUM语句。
  db.run(`VACUUM INTO '${masterDb.replaceAll("'", "''")}'`)
  // VACUUM完成返回后master已是完整文件；此后只读hash，不再对其执行SQLite操作。
  const manifest = { [name]: await fileDigest(masterDb) }
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2))
  // 打开clone可能触发SQLite WAL恢复，所以永远不能直接打开唯一master。
  // clone同时做结构和外键检查，避免把不可恢复的备份当作写库许可。
  await fs.cp(master, clone, { recursive: true })
  const validation = new Database(path.join(clone, path.basename(dbPath)), { readonly: true })
  try {
    const result = validation.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    if (result?.integrity_check !== "ok") throw new Error("Backup validation clone failed integrity_check")
    if (validation.query("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("Backup validation clone failed foreign_key_check")
  } finally {
    validation.close()
    await fs.rm(clone, { recursive: true, force: true })
  }
  await verifyBackupManifest(root)
  return root
}

async function verifyBackupManifest(root: string) {
  // Manifest不接受“文件仍存在”作为成功，必须逐个验证原始物理内容。
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as Record<string, string>
  for (const [name, expected] of Object.entries(manifest)) {
    if ((await fileDigest(path.join(root, "master", name))) !== expected) throw new Error(`Master backup changed: ${name}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataUrlBytes(url: string) {
  // Hash比较针对Provider最终接收的bytes，而不是可能包含不同前缀文本的完整data URL。
  // 无data前缀或分隔逗号立即失败，不把任意文本静默解释为空图片。
  const marker = ";base64,"
  const start = url.indexOf(marker)
  if (!url.startsWith("data:") || start === -1) throw new Error("Attachment is not a base64 data URL")
  return Buffer.from(url.slice(start + marker.length), "base64")
}

function digest(input: Buffer) {
  return createHash("sha256").update(input).digest("hex")
}

async function fileDigest(file: string) {
  // opencode.db可能超过2GB；流式hash避免为了备份校验把整库一次性装入内存。
  // reader逐块更新同一SHA状态，内存占用与数据库大小无关。
  const hash = createHash("sha256")
  const reader = Bun.file(file).stream().getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    hash.update(next.value)
  }
  return hash.digest("hex")
}

function required(name: string, value: string | undefined) {
  if (!value) throw new Error(`--${name} is required\n\n${usage}`)
  return value
}

function finiteInteger(name: string, value: string | undefined) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`--${name} must be a non-negative integer`)
  return result
}
