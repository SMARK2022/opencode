#!/usr/bin/env bun

import { Image } from "../src/image/image"
import { Config } from "../src/config/config"
import { MessageID, PartID, SessionID } from "../src/session/schema"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import path from "node:path"
import { parseArgs } from "node:util"

const unavailableNote = "[Image unavailable: stored image data could not be decoded.]"
const usage = `Usage:
  bun script/migrate-image-attachment.ts <opencode.db>
  bun script/migrate-image-attachment.ts <opencode.db> --apply

The default mode is a read-only preview. --apply updates the current database in one transaction.`

type PartRow = { id: string; message_id: string; session_id: string; data: string }
type FileAttachment = { type: "file"; mime: string; url: string; [key: string]: unknown }

// 数据库路径使用唯一位置参数，避免重新引入part/source/hash等需要人工拼装的旧协议。
const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean" },
    apply: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
})

if (args.values.help) {
  console.log(usage)
  process.exit(0)
}
if (args.positionals.length !== 1) throw new Error(`Exactly one database path is required\n\n${usage}`)

const dbPath = path.resolve(args.positionals[0])
const apply = args.values.apply ?? false
// Preview从连接权限开始就是只读；apply则在第一条SELECT前锁住写入，库存与提交之间不留并发窗口。
const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true })

try {
  if (apply) db.run("BEGIN IMMEDIATE")
  else db.run("PRAGMA query_only=ON")

  // SQL只做已观察数据库形态的低成本预筛，真正图片边界仍由Part结构和声明MIME决定。
  const rows = db
    .query<PartRow, []>("SELECT id, message_id, session_id, data FROM part WHERE instr(data, 'image/') > 0 ORDER BY id")
    .all()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const image = yield* Image.Service
      const changes: Array<{ row: PartRow; nextData: string }> = []
      const normalizedItems: Array<Record<string, unknown>> = []
      const unavailableItems: Array<Record<string, unknown>> = []
      let imageAttachments = 0
      let unchanged = 0
      let oldPayloadBytes = 0
      let newPayloadBytes = 0
      let oldPartJsonBytes = 0
      let newPartJsonBytes = 0

      for (const row of rows) {
        // clone后只修改已授权的图片字段，Part未来新增的未知字段不会因迁移丢失。
        const part = JSON.parse(row.data)
        const next = structuredClone(part)
        const attachments: Array<{ location: "part" | "tool"; index: number; value: FileAttachment }> = []
        // 顶层FilePart是当前Prompt持久化形态，与Tool attachment必须进入同一Sharp策略。
        if (
          part?.type === "file" &&
          typeof part.mime === "string" &&
          part.mime.startsWith("image/") &&
          typeof part.url === "string"
        )
          attachments.push({ location: "part", index: 0, value: part })
        if (part?.type === "tool" && part.state?.status === "completed" && Array.isArray(part.state.attachments))
          part.state.attachments.forEach((value: unknown, index: number) => {
            if (
              isRecord(value) &&
              value.type === "file" &&
              typeof value.mime === "string" &&
              value.mime.startsWith("image/") &&
              typeof value.url === "string"
          )
              // 原数组index必须保留到写回和报告，过滤非图片后不能重排定位。
              attachments.push({ location: "tool", index, value: value as FileAttachment })
          })
        // SQL可能命中普通文本中的image/，结构筛选确保这类行不进入空间统计或UPDATE计划。
        if (attachments.length === 0) continue

        oldPartJsonBytes += Buffer.byteLength(row.data)
        const unavailable = new Set<number>()
        let rowChanged = false
        for (const attachment of attachments) {
          imageAttachments++
          // 坏图的旧载荷也计入总量，弃用后new bytes为零，报告才能体现真实释放空间。
          const oldBytes = dataUrlBytes(attachment.value.url).length
          oldPayloadBytes += oldBytes
          // 所有来源共用默认Image.Service，不传token budget，保证正常图片走metadata fast-path而不被二次压缩。
          const normalized = yield* image
            .normalize({
              id: PartID.make(row.id),
              messageID: MessageID.make(row.message_id),
              sessionID: SessionID.make(row.session_id),
              type: "file",
              mime: attachment.value.mime,
              url: attachment.value.url,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            )

          if (!normalized.ok) {
            // 用户只授权弃用真实存在的completed Tool坏图；Sharp装载失败或顶层失败绝不能转成成功。
            if (attachment.location !== "tool" || normalized.error._tag !== "ImageDecodeError")
              return yield* normalized.error
            // DecodeError说明数据库bytes自身不可恢复；移除附件并保留Tool文本比猜外部源更符合当前持久化链。
            unavailable.add(attachment.index)
            unavailableItems.push({ part: row.id, location: attachment.location, index: attachment.index })
            rowChanged = true
            continue
          }

          const newBytes = dataUrlBytes(normalized.value.url).length
          newPayloadBytes += newBytes
          if (normalized.value.mime === attachment.value.mime && normalized.value.url === attachment.value.url) {
            // fast-path以MIME和URL双重相等为准，正常图片不能仅因被扫描就产生数据库写入。
            unchanged++
            continue
          }

          rowChanged = true
          normalizedItems.push({
            part: row.id,
            location: attachment.location,
            index: attachment.index,
            old_bytes: oldBytes,
            new_bytes: newBytes,
          })
          if (attachment.location === "part") {
            // 顶层FilePart只替换图片载荷，filename/source等未知字段由clone原样保留。
            next.mime = normalized.value.mime
            next.url = normalized.value.url
            continue
          }
          next.state.attachments[attachment.index] = {
            ...attachment.value,
            mime: normalized.value.mime,
            url: normalized.value.url,
          }
        }

        if (unavailable.size > 0) {
          // 先完成同一ToolPart内其他图片的规范化，再按原index统一移除坏附件，避免数组位移写错对象。
          next.state.attachments = next.state.attachments.filter((_: unknown, index: number) => !unavailable.has(index))
          if (next.state.attachments.length === 0) delete next.state.attachments
          // 固定说明是用户可见的弃用凭据；包含检查保证异常中断后的重跑也不会重复追加。
          if (!next.state.output.includes(unavailableNote)) next.state.output = `${next.state.output}\n\n${unavailableNote}`
        }

        const nextData = rowChanged ? JSON.stringify(next) : row.data
        newPartJsonBytes += Buffer.byteLength(nextData)
        // changed_parts按Part而非附件计数，同一Part有多图时仍只执行一次CAS UPDATE。
        if (rowChanged) changes.push({ row, nextData })
      }

      return {
        changes,
        report: {
          status: apply ? "applied" : "preview",
          image_attachments: imageAttachments,
          unchanged,
          normalized: normalizedItems.length,
          unavailable: unavailableItems.length,
          changed_parts: changes.length,
          old_payload_bytes: oldPayloadBytes,
          new_payload_bytes: newPayloadBytes,
          saved_payload_bytes: oldPayloadBytes - newPayloadBytes,
          old_part_json_bytes: oldPartJsonBytes,
          new_part_json_bytes: newPartJsonBytes,
          logical_part_json_bytes_saved: oldPartJsonBytes - newPartJsonBytes,
          // UPDATE释放的页不会自动缩小SQLite主文件；物理回收需要本任务之外的VACUUM。
          database_file_shrinks_without_vacuum: false,
          normalized_items: normalizedItems,
          unavailable_items: unavailableItems,
        },
      }
    }).pipe(
      // 空配置只选择Image.Service仓库默认值；迁移策略不再因历史来源或当前Project配置分叉。
      Effect.provide(Image.layer.pipe(Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({}) })))),
    ),
  )

  if (apply) {
    // 完整旧JSON参与CAS；即使未来改变锁策略，也不能覆盖同一Part的未知并发字段。
    result.changes.forEach((change) => {
      const updated = db
        .query("UPDATE part SET data = ? WHERE id = ? AND data = ?")
        .run(change.nextData, change.row.id, change.row.data)
      if (updated.changes !== 1)
        throw new Error(`CAS updated ${updated.changes} rows for ${change.row.id} instead of 1`)
    })
    // 报告只在COMMIT成功后输出，调用方不会把已回滚计划误认为已应用结果。
    db.run("COMMIT")
  }
  console.log(JSON.stringify(result.report, null, 2))
} catch (error) {
  // apply中任何Sharp、解析或CAS错误都回滚整批；preview连接没有事务也没有写权限。
  if (db.inTransaction) db.run("ROLLBACK")
  throw error
} finally {
  db.close()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataUrlBytes(url: string) {
  // 真实库存均为规范base64 data URL；非法值应使整批失败，不能被误认成空图后弃用。
  const marker = ";base64,"
  const start = url.indexOf(marker)
  if (!url.startsWith("data:") || start === -1) throw new Error("Image attachment is not a base64 data URL")
  return Buffer.from(url.slice(start + marker.length), "base64")
}
