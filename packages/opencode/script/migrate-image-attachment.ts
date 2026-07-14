#!/usr/bin/env bun

import { Image } from "@opencode-ai/core/image"
// 两代历史映射到同一生产图片服务，不为Native伪造V1 Part身份或复制缩放算法。
import { Config } from "@opencode-ai/core/config"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import path from "node:path"
import { parseArgs } from "node:util"

const unavailableNote = "[Image unavailable: stored image data could not be decoded.]"
// 弃用说明字符串是产品契约：TUI与provider都会原样看到它，不能改写或本地化。
const usage = `Usage:
  bun script/migrate-image-attachment.ts <opencode.db>
  bun script/migrate-image-attachment.ts <opencode.db> --apply

The default mode is a read-only preview. --apply updates the current database in one transaction.`

// Native的type在独立SQL列，不在data里；两代始终保留完整旧JSON用于CAS。
type ImageRow = { id: string; session_id: string; data: string; type?: string }
type ImageAttachment = { location: string; index: number; value: Record<string, unknown>; mime: string; uri: string; field: "url" | "uri"; list: unknown[]; state?: Record<string, unknown>; toolIndex?: number }

// 数据库路径使用唯一位置参数，避免重新引入part/source/hash等需要人工拼装的旧协议。
// allowPositionals是全库扫描语义的入口：旧协议的散装参数不再存在。
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
// 参数个数硬失败：多路径或无路径都是调用方错误，不猜默认值。
if (args.positionals.length !== 1) throw new Error(`Exactly one database path is required\n\n${usage}`)

const dbPath = path.resolve(args.positionals[0])
const apply = args.values.apply ?? false
// 仅在正式生效前解析绝对路径，防止相对路径随CWD漂移指向错误的库存文件。
// Preview从连接权限开始就是只读；apply则在第一条SELECT前锁住写入，库存与提交之间不留并发窗口。
const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true })

try {
  // BEGIN IMMEDIATE而非延迟事务：写锁在扫描前就持有，杜绝扫描结果与提交之间被并发插入。
  if (apply) db.run("BEGIN IMMEDIATE")
  else db.run("PRAGMA query_only=ON")
  // query_only在数据库层面挡写：比依赖应用层纪律更强，preview副作用无从发生。

  // 显式识别两代表，兼容只含其中一代的合法库存；SQL错误不转成空成功。
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name))
  if (!tables.has("part") && !tables.has("session_message")) throw new Error("No supported message table was found")
  const rows = (["part", "session_message"] as const).flatMap(table =>
    tables.has(table)
      ? db.query<ImageRow, []>(
          `SELECT id, session_id, data${table === "session_message" ? ", type" : ""} FROM ${table} WHERE instr(data, 'image/') > 0 ORDER BY id`,
        ).all().map(row => ({ ...row, table }))
      : [],
  )
  // Effect.runPromise桥接CLI顶层；gen内的错误沿rejection进入catch统一回滚。
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      // 单次解析Image.Service：整批共享同一实例与内部缓存，避免每行重复装载。
      const image = yield* Image.Service
      const changes: Array<{ row: ImageRow & { table: "part" | "session_message" }; nextData: string }> = []
      // 计划与统计分离：changes只存待写行，报告字段由四组计数器推导，避免双重真相。
      const normalizedItems: Array<Record<string, unknown>> = []
      const unavailableItems: Array<Record<string, unknown>> = []
      let imageAttachments = 0
      // 四组计数器互相独立：unchanged是fast-path命中数，normalized是实际重写数。
      let unchanged = 0
      let oldPayloadBytes = 0
      let newPayloadBytes = 0
      let oldPartJsonBytes = 0
      let newPartJsonBytes = 0
      let oldMessageJsonBytes = 0
      let newMessageJsonBytes = 0

      for (const row of rows) {
        // JSON.parse失败会让整批失败：损坏到无法解析的Part不属于本工具的授权范围。
        // clone后只修改已授权的图片字段，Part未来新增的未知字段不会因迁移丢失。
        const part = JSON.parse(row.data)
        const next = structuredClone(part)
        const attachments: ImageAttachment[] = []
        // 槽位保留clone对象和原索引：多个坏图删除后也不会错写相邻图片。
        const addAttachments = (list: unknown, field: "url" | "uri", location: string, state?: Record<string, unknown>, toolIndex?: number) => {
          if (!Array.isArray(list)) return
          list.forEach((value: unknown, index) => {
            if (!isRecord(value)) return
            const uri = value[field]
            if (typeof value.mime !== "string" || !value.mime.startsWith("image/") || typeof uri !== "string") return
            if ((field === "url" || location === "tool-content") && value.type !== "file") return
            attachments.push({ location, index, value, mime: value.mime, uri, field, list, state, toolIndex })
          })
        }
        if (row.table === "part") {
          if (next?.type === "file") addAttachments([next], "url", "part")
          if (next?.type === "tool" && next.state?.status === "completed")
            addAttachments(next.state.attachments, "url", "tool", next.state)
        }
        if (row.table === "session_message" && row.type === "user") addAttachments(next.files, "uri", "user")
        if (row.table === "session_message" && row.type === "assistant" && Array.isArray(next.content))
          next.content.forEach((tool: unknown, toolIndex: number) => {
            if (!isRecord(tool) || tool.type !== "tool" || !isRecord(tool.state) || tool.state.status !== "completed") return
            // Native模型实际消费content文件；展示attachments不是它的替代数据源。
            addAttachments(tool.state.attachments, "uri", "tool-attachment", tool.state, toolIndex)
            addAttachments(tool.state.content, "uri", "tool-content", tool.state, toolIndex)
          })
        // SQL可能命中普通文本中的image/，结构筛选确保这类行不进入空间统计或UPDATE计划。
        // attachments为空说明只是文本命中image/：不计空间也不进UPDATE计划。
        if (attachments.length === 0) continue

        // JSON字节数按原始data文本计量，避免二次序列化引入编码偏差。
        if (row.table === "part") oldPartJsonBytes += Buffer.byteLength(row.data)
        if (row.table === "session_message") oldMessageJsonBytes += Buffer.byteLength(row.data)
        // unavailable按原数组index收集，先规范化后统一移除，保证写回次序与扫描次序无关。
        const unavailable = new Set<Record<string, unknown>>()
        let rowChanged = false
        for (const attachment of attachments) {
          // 每个附件独立normalize：一个坏图不能阻断同Part内其他正常图片的修复。
          imageAttachments++
          // 坏图的旧载荷也计入总量，弃用后new bytes为零，报告才能体现真实释放空间。
          const oldBytes = dataUrlBytes(attachment.uri).length
          oldPayloadBytes += oldBytes
          const detail = row.table === "part"
            ? { part: row.id, location: attachment.location, index: attachment.index }
            : { message: row.id, location: attachment.location, index: attachment.index, tool_index: attachment.toolIndex }
          // 所有来源共用默认Image.Service，不传token budget，保证正常图片走metadata fast-path而不被二次压缩。
          const normalized = yield* image
            .normalize(attachment.uri, {
              uri: attachment.uri,
              mime: attachment.mime,
              content: attachment.uri.slice(attachment.uri.indexOf(";base64,") + ";base64,".length),
              encoding: "base64",
            })
            .pipe(
              // match把失败变成数据：同一循环内区分弃用与终止，而不是中断整个扫描。
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            )

          if (!normalized.ok) {
            // 非Tool位置或非DecodeError都向上传播：迁移工具绝不掩盖授权范围之外的失败。
            // 用户只授权弃用真实存在的completed Tool坏图；Sharp装载失败或顶层失败绝不能转成成功。
            if (!attachment.state || !(normalized.error instanceof Image.DecodeError))
              return yield* normalized.error
            // DecodeError说明数据库bytes自身不可恢复；移除附件并保留Tool文本比猜外部源更符合当前持久化链。
            attachment.list.splice(attachment.list.indexOf(attachment.value), 1)
            unavailable.add(attachment.state)
            // 弃用决策同时进入报告明细，preview阶段用户可逐条审计后再--apply。
            unavailableItems.push(detail)
            rowChanged = true
            continue
          }

          const url = normalized.value.mime === attachment.mime && normalized.value.content === attachment.uri.slice(attachment.uri.indexOf(";base64,") + ";base64,".length)
            ? attachment.uri
            : `data:${normalized.value.mime};base64,${normalized.value.content}`
          const newBytes = dataUrlBytes(url).length
          // 新载荷先计量再写回，saved_payload_bytes才能在报告里反映真实的存储收益。
          newPayloadBytes += newBytes
          if (normalized.value.mime === attachment.mime && url === attachment.uri) {
            // fast-path以MIME和URL双重相等为准，正常图片不能仅因被扫描就产生数据库写入。
            unchanged++
            continue
          }

          rowChanged = true
          // 明细记录old/new bytes：重编码收益需要逐条可见，而不是只有聚合计数。
          normalizedItems.push({
            ...detail,
            old_bytes: oldBytes,
            new_bytes: newBytes,
          })
          // 两代只替换目标图片字段，其他字段及数组顺序均由clone原样保留。
          attachment.value.mime = normalized.value.mime
          attachment.value[attachment.field] = url
        }

        for (const state of unavailable) {
          if (Array.isArray(state.attachments) && state.attachments.length === 0) delete state.attachments
          // Native保留必需content数组；每个Tool只追加一次说明，不改opaque result/structured。
          if (row.table === "session_message") {
            if (!Array.isArray(state.content)) throw new Error("Completed native tool is missing content")
            if (!state.content.some((value: unknown) => isRecord(value) && value.type === "text" && typeof value.text === "string" && value.text.includes(unavailableNote)))
              state.content.push({ type: "text", text: unavailableNote })
            continue
          }
          if (typeof state.output !== "string") throw new Error("Completed legacy tool is missing output")
          if (!state.output.includes(unavailableNote)) state.output = `${state.output}\n\n${unavailableNote}`
        }

        const nextData = rowChanged ? JSON.stringify(next) : row.data
        // 未变更的Part也计入new bytes：逻辑节省量必须以全库为分母才有意义。
        if (row.table === "part") newPartJsonBytes += Buffer.byteLength(nextData)
        if (row.table === "session_message") newMessageJsonBytes += Buffer.byteLength(nextData)
        // changed_parts按Part而非附件计数，同一Part有多图时仍只执行一次CAS UPDATE。
        if (rowChanged) changes.push({ row, nextData })
      }

      // 返回值聚合计划与报告：apply段只消费changes，输出段只消费report。
      return {
        changes,
        report: {
          status: apply ? "applied" : "preview",
          image_attachments: imageAttachments,
          unchanged,
          normalized: normalizedItems.length,
          unavailable: unavailableItems.length,
          changed_parts: changes.filter(change => change.row.table === "part").length,
          changed_messages: changes.filter(change => change.row.table === "session_message").length,
          old_payload_bytes: oldPayloadBytes,
          new_payload_bytes: newPayloadBytes,
          saved_payload_bytes: oldPayloadBytes - newPayloadBytes,
          old_part_json_bytes: oldPartJsonBytes,
          new_part_json_bytes: newPartJsonBytes,
          logical_part_json_bytes_saved: oldPartJsonBytes - newPartJsonBytes,
          old_message_json_bytes: oldMessageJsonBytes,
          new_message_json_bytes: newMessageJsonBytes,
          logical_message_json_bytes_saved: oldMessageJsonBytes - newMessageJsonBytes,
          // UPDATE释放的页不会自动缩小SQLite主文件；物理回收需要本任务之外的VACUUM。
          database_file_shrinks_without_vacuum: false,
          normalized_items: normalizedItems,
          unavailable_items: unavailableItems,
        },
      }
    }).pipe(
      // 空配置只选择Image.Service仓库默认值；迁移策略不再因历史来源或当前Project配置分叉。
      Effect.provide(Image.layer.pipe(Layer.provide(Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })))),
    ),
  )

  if (apply) {
    // 写段在Effect之外：计划生成与落库执行严格分离，便于审查各自的失败语义。
    // CAS循环不做批量预备语句：错误在第一行失配时立即抛出并回滚整批。
    // 完整旧JSON参与CAS；即使未来改变锁策略，也不能覆盖同一Part的未知并发字段。
    result.changes.forEach((change) => {
      const updated = db
        .query(`UPDATE ${change.row.table} SET data = ? WHERE id = ? AND data = ?`)
        .run(change.nextData, change.row.id, change.row.data)
      if (updated.changes !== 1)
        throw new Error(`CAS updated ${updated.changes} rows for ${change.row.id} instead of 1`)
    })
    // 报告只在COMMIT成功后输出，调用方不会把已回滚计划误认为已应用结果。
    db.run("COMMIT")
  }
  // preview与apply共用同一份报告结构：调用方可以用同一解析器处理两种模式。
  console.log(JSON.stringify(result.report, null, 2))
} catch (error) {
  // apply中任何Sharp、解析或CAS错误都回滚整批；preview连接没有事务也没有写权限。
  if (db.inTransaction) db.run("ROLLBACK")
  throw error
} finally {
  // finally释放连接：query_only与WAL状态都随连接销毁，不污染后续进程。
  db.close()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 排除数组：附件必须是对象，数组形态的payload视为结构损坏。
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataUrlBytes(url: string) {
  // 真实库存均为规范base64 data URL；非法值应使整批失败，不能被误认成空图后弃用。
  const marker = ";base64,"
  const start = url.indexOf(marker)
  // 允许自定义MIME前缀但拒绝非base64形态：字节计量错误不能静默归零。
  if (!url.startsWith("data:") || start === -1) throw new Error("Image attachment is not a base64 data URL")
  return Buffer.from(url.slice(start + marker.length), "base64")
}
