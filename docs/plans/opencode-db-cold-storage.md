# Canonical Plan: OpenCode DB Field-Level Cold Storage

Status: verified
Revision: R9
Approved revision: R9
Implementation allowed: yes
Target terminal state: verified-implementation-and-commit
Audit mode: implementation
Requirement source: user GOAL contract plus the confirmed grilling decisions recorded in `docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md`

## 1. Outcome

为 OpenCode 的 SQLite 数据库增加可逆的字段级冷存储能力：低访问概率的历史字段压缩进入同一数据库的 `cold_storage` 表，主 `message`/`part` 行保留热投影和引用；daemon 在读取范围需要真实内容时负责解冻、完整恢复到主表并持久保持热态；CLI 提供可恢复的压缩、展开、状态、校验和清理入口。

R9 已在完整逻辑自查后获得 full-scope plan approval；实施必须严格遵守本 revision 的 owner、interface、test seam 和 22-file mapping。

## 2. Original Requirement

当前用户需求的可执行范围如下：

- 对 OpenCode DB 实现完整的冷存储和自动预热/持久预热方案。
- 前端/TUI 读取路径不应关心 hot/cold；后端 daemon 负责解冻、恢复、维护和持久预热。
- 使用同一个 SQLite 数据库内的冷存储 blob 表，并包含引用计数以支持清理。
- 支持手动 `opencode db compress` 等冷冻命令，并支持显式全量展开命令。
- 检查 `Session.list`/session search 是否索引工具内容，避免工具内容进入 session list 索引。
- 检查过于激进的 `Messages` 全量请求，避免无意义地读取或解冻不需要的历史范围。
- 已 compact 的内容可按冷存储策略处理；compact marker、summary 和 tail 语义必须保持正确。
- 方案必须可逆、零消息丢失、跨平台、可交接实施。
- 主要范围为 TUI CLI/daemon，不修改 webapp 行为；优先保持总文件改动不超过 16 个，上限不得超过 32 个。
- 当前后续 GOAL 终态为 `verified-implementation-and-commit`；实现必须严格使用最终获批 revision，并通过独立 implementation audit 后才能提交。

## 3. Confirmed Decisions

以下决定已在 `docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md` 的 `Grilling Decision Log` 中记录，不再重新询问：

| 主题 | 决定 |
|---|---|
| 冷存储位置 | 只新增同库 `cold_storage` 表，不建立独立 cold DB、独立 hot 表或外部归档文件 |
| 主表连接 | `message` 和 `part` 各增加 nullable `cold_ref` |
| 冷冻粒度 | 按字段/字段集合冷冻，不整行冷冻；每个 owner 行最多一个聚合冷 payload |
| 共享方式 | canonical payload 按 hash 去重；fork 保留独立 message/part ID，owner 独立 thaw |
| 引用计数 | 写入/解冻/删除在事务内维护 `ref_count`；`verify` 用 owner 反算值校验并修复 |
| 30 天策略 | 默认 `time_updated <= now - 30 days`；age-only session 的全部 owner 都可检查冷字段白名单 |
| compact | boundary 之前的 owner 立即可检查冷字段；marker/summary/tail 不因 boundary 冷冻，但 session 满 30 天后其冷字段仍按 age 规则检查；结构字段和普通 text 始终热 |
| 普通文本 | 普通 user/assistant text 永远保持热，不因 30 天策略压缩 |
| search | session list/search 保留既有 tool identity/input 搜索，只排除 tool output/result、provider metadata、reasoning 和 cold blob；查询不触发 thaw |
| 解冻 | 请求需要真实内容时同步按读取范围 thaw，并持久回填主表；无 TTL、LRU 或自动再冷冻 |
| compress | `opencode db compress` 无 session 时扫描全库 eligible session，后台分批、可中断、可恢复 |
| expand | `opencode db expand --all` 才允许全量展开；默认拒绝无范围的 destructive-size operation |
| daemon | daemon 是长期 DB writer；CLI 启动时若存在 live daemon 只走私有 control；启动时无 live daemon 则进入用户明确选择的同一实现单进程维护模式 |
| CLI 范围 | 扩展现有 `opencode db`，不新增顶层 `opencode storage` |
| codec | 第一个 cold schema 只写/读 zstd level 3；`codec` 持久化用于格式验证和未来显式 migration；未知 codec 或解压失败不得猜算法或静默 fallback |
| runtime | Bun 和 Node 均使用各自原生 zstd API；不引入 Rust sidecar、Rust N-API addon、WASM 或外部压缩进程 |

本 canonical R9 是实现方向的唯一权威。非 canonical spec 中“gzip legacy”与“tail 永远热”的旧表述已被 R1 独立审计证明缺乏 persisted consumer 或存在 eligibility 歧义，因此分别由单 codec 合同和 §7.7 四象限真值表取代；这不是备用实现路径。

用户在 grilling 中明确选择并已落盘的 maintenance contract（`docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md:498`）是：`daemon 是长期 DB 写入 owner；CLI opencode db 作为维护任务客户端；daemon 不可用时使用同一 implementation 的单进程锁定模式。` 因此 offline CLI 是受支持输入域，不是 primary failure 后的 fallback。唯一分流条件在尝试执行前决定：

- lock 指向 live daemon 且 dbPath 匹配时，只走 daemon control；control 请求失败返回 typed unavailable，禁止切换到 direct execution。
- 启动时不存在 live daemon 时，CLI 获取 maintenance lock 后调用与 daemon 完全相同的 `ColdStorage.maintain` owner；没有第二套维护算法。

## 4. Repository Evidence

### 4.1 Local DB evidence

`docs/db-space-diagnosis.md` 和 `docs/db-space-optimization-design.md` 的 `1574.66 MB` 数字只保留为历史证据，不能支撑本 revision。R2 在固定副本上重新测量：

- `2026-07-16T20:01:07.091Z` 使用 Python sqlite3 `Connection.backup()` 从只读 URI `file:C:/Users/Lenovo/.local/share/opencode/opencode.db?mode=ro` 复制包含当前 WAL 可见状态的快照到 `D:\Temp\opencode\opencode-r2-evidence-20260717.db`；源 DB 未写入。
- 快照为 `2,213,416,960` bytes，即 `2110.88 MB`；page size `4096`，page count `540,385`，freelist `29` pages。
- 行数：session `1,223`、message `96,557`、part `435,771`。
- Python sqlite3 3.53.2 `dbstat` 查询 `SELECT name, SUM(pgsize), SUM(payload), SUM(unused), COUNT(*) FROM dbstat GROUP BY name`：`part` pages `1,790,816,256` bytes（80.90% DB，payload `1,644,374,810`）；`message` pages `283,734,016` bytes（12.82% DB，payload `272,371,023`）。
- 30 天 cutoff 为 `2026-06-16T20:01:20.154Z`。session 四象限：age-only `613`、compact-only `31`、age+compact `79`、neither `500`；latest completed boundary 共 `110` 个 session。
- 可复现脚本 `D:\Temp\opencode\cold-r2-evidence.ts` 只读扫描 snapshot；按 §7.1 的 canonical envelope 提取字段，按未压缩 envelope SHA-256 去重，然后调用 `Bun.zstdCompressSync(bytes, { level: 3 })`。它不写 snapshot。

固定 snapshot 上的 zstd level 3 结果：

| minimum canonical envelope | owners | unique payloads | raw envelope | unique zstd | payload reduction | 占 DB |
|---:|---:|---:|---:|---:|---:|---:|
| 0 B | 158,103 | 109,518 | 730.86 MB | 285.98 MB | 444.88 MB | 21.08% |
| 1 KiB | 62,958 | 50,345 | 701.78 MB | 271.80 MB | 429.97 MB | 20.37% |
| **4 KiB** | **33,703** | **27,114** | **637.94 MB** | **250.29 MB** | **387.65 MB** | **18.36%** |
| 16 KiB | 5,609 | 4,595 | 422.52 MB | 192.34 MB | 230.17 MB | 10.90% |

R2 采用 `4 KiB`：相较无门槛减少 78.7% owner/blob 操作，仍保留 87.1% 的实测 payload reduction。`387.65 MB` 是主表字段抽取前后的 **payload gross reduction**，尚未扣除 SQLite row/index/cold_ref overhead，不宣称等于最终 DB 文件缩减；实现验证必须在临时 DB copy 上报告 net page delta。

### 4.2 Producer evidence

| 数据 | producer | 当前存储原因/行为 |
|---|---|---|
| `message.data.summary.diffs` | `session/projectors.ts`、summary/session update | 每轮用户消息直接内嵌完整 diff，便于历史展示和导出；不能依赖可被 GC 的 snapshot 重算 |
| `part.data.state.output` | tool processor/projector | 工具终态输出作为完整 JSON 保存在 part，prompt 需要时转换为 model message |
| reasoning text | processor/model stream | 作为完整 part 保存，历史回放和上下文构建都会读取 |
| file data URI/base64 | tool/file producers | 图片/附件内容嵌在 part JSON，造成大单行 payload |
| ordinary text/tool input | prompt/processor/projector | 当前进入模型上下文或驱动工具调用，必须保持热 |
| compact marker/summary/tail metadata | compaction/projector | 驱动 `filterCompacted`、recent-user memento 和 tail 恢复，不能冷冻其结构 |

### 4.3 Consumer evidence

- `packages/opencode/src/session/message-v2.ts:742-755` 当前直接将 `MessageTable.data`/`PartTable.data` 映射为 model object。
- `packages/opencode/src/session/message-v2.ts:760-784` 的 `hydrate()` 对 message rows 批量读取所有 parts；这是显示/上下文读取的共同 seam。
- `packages/opencode/src/session/message-v2.ts:1119-1173` 的 `page()` 已按 message page 分页，但 `hydrate()` 尚未有 cold-aware read intent。
- `packages/opencode/src/session/session.ts:841-860` 的 `messages()` 在无 `limit` 时完整扫描 session；fork、compaction、summary、revert、export 等调用是有意全量读取，不能一概改成分页。
- `packages/opencode/src/session/message-v2.ts:1180-1197` 的 `stream()` 是历史扫描共同路径，必须经过同一 thaw seam，不能另建解压实现。
- `packages/opencode/src/session/message-v2.ts:1199-1227` 的 `parts()` 和 `get()` 直接映射 rows；HTTP 单消息 endpoint 使用 `get()`，必须共享同一 cold-aware row mapping。
- `packages/opencode/src/session/session.ts:708-728` 的 `getPart()` 当前直接 spread `PartTable.data`；这是独立 direct-read path，不能只修改 page/hydrate。
- `packages/opencode/src/session/request-usage.ts:280-304` 为只统计 `step-finish` 调用 `MessageV2.parts()`，会无意义读取同 message 的 tool/reasoning cold fields；应改为 hot-only step-finish query。
- `packages/opencode/src/session/session.ts:896-910` 的 `findMessage()` 通过 `MessageV2.page()` hydrate 每个扫描页；全部 7 个当前 predicate 只读取 role/model 等热 info，但匹配结果中的 Parts 仍被 `lastAssistant`/task status 消费，因此需要“热 info 定位、单个匹配 hydrate”的两阶段 contract。
- `packages/opencode/src/session/message-v2.ts:1229-1333` 的 `filterCompacted()` 只保留 compaction boundary、summary 和 tail 语义；隐藏 head 不能因为 cold projection 而消失。
- `packages/opencode/src/session/search.ts` 当前保留 tool identity/input 搜索，同时排除 tool output/result、reasoning、structured/provider metadata；这是应保留的现有 allowlist，不新增第二套 search index。
- `packages/opencode/src/session/projectors.ts:173-196` 的 durable upsert 是 cold owner 更新时清除 stale `cold_ref`、维护引用和避免旧 blob 残留的 producer seam。
- `packages/opencode/src/session/session.ts:655-672` 的 remove 发布 `Session.Event.Deleted`；`projectors.ts:121-123` 当前只删除 SessionTable，message/part 由 cascade 删除。这是 session-level ref release 必须修复的正常生产路径，不能留给事后 verify。
- `packages/opencode/src/cli/cmd/tui/worker.ts:194-224` 已有带 token 的本机私有 control server，可承载 daemon 维护请求而不改变 public HTTP API/webapp。
- `packages/opencode/src/cli/cmd/tui/server-lock.ts` 和 `packages/opencode/src/cli/cmd/daemon.ts` 已有 lock token、health、control port 请求模式。
- `packages/opencode/src/cli/cmd/db.ts:31-73` 当前直接打开 DB 执行 query/path/migrate；compress/expand 等维护命令应优先转发 daemon，保留现有 query/path/migrate 行为。
- `packages/opencode/src/cli/cmd/tui/worker.ts:226-305` 的 `isActive()` 只计算 SSE/SessionActivity；后台 maintenance 若不占用该 lifecycle，会在 startup/idle timeout 正常退出。

### 4.4 Codec evidence

本机只读运行时验证：

- Bun `1.3.14`：`Bun.zstdCompressSync` 和 `Bun.zstdDecompressSync` 存在，round-trip 成功。
- Node `v24.16.0`：`node:zlib` 的 `zstdCompressSync` 和 `zstdDecompressSync` 存在。
- Bun/Node 均使用字节数组，不把路径、平台分隔符或外部命令写进 payload；Windows/macOS/Linux 的跨平台验证必须作为实现阶段 CI 矩阵，而不是把本机 probe 当作全部证据。

## 5. Domain, Reachability, and Scope

### 5.1 Domain terms

- **owner row**：`message` 或 `part` 中拥有一个冷引用的主表行。
- **cold payload**：从 owner JSON 中抽出的字段集合，以 canonical JSON 编码并压缩后存入 `cold_storage`。
- **hot projection**：主表中保留的结构骨架和安全占位值；只在 `cold_ref` 非空时有效。
- **thaw**：验证 hash、解压 payload、把字段恢复到 owner JSON、清除 `cold_ref` 并使内容在主表中持久热化。
- **prewarm**：正常读取中完成 thaw 并回填主表；不是内存缓存，也没有 TTL。
- **maintenance owner**：daemon control task 或持有维护锁的 CLI 单进程。
- **HotInfo**：Message 中保证常驻主表的 info 字段类型，明确排除 `summary.diffs`；只用于定位 predicate，不能作为完整 Message 返回。

### 5.2 Reachable paths

必须覆盖的生产 interface/producer/consumer：

1. DB schema/migration：`session.sql.ts`、Drizzle migration 输出。
2. 写入：`projectors.ts` 的 message/part durable upsert、`Session.fork` 的 clone path。
3. 读取：`MessageV2.info`、`part`、`hydrate`、`page`、`parts`、`get`、`stream`、`Session.getPart`、`Session.messages`、`Session.findMessage` 两阶段查询、HTTP 单消息 consumer。
4. 上下文/统计：`toModelMessagesEffect`、compaction、prompt、permission reviewer、Task/TaskStatus、processor doom-loop、`RequestUsage.recordAssistant`。
5. search/list：`session/search.ts` 和 session list，必须不访问 cold blob。
6. maintenance：`DbCommand`、TUI daemon private control endpoint、lock contention/daemon-absent supported mode。
7. integrity：startup migration compatibility、`verify`、orphan cleanup、expand and round-trip.

明确不在本 revision 修改：

- public HTTP API schema、webapp、SDK generated files。
- `src/v2/` session implementation；`CONTEXT.md` 已确认当前生产路径是 v1 `src/session/`。
- ACP `sendUsageUpdate` 等非 TUI full-history callsite；它们必须在审计中记录为未修改的边界，除非 auditor 证明它们属于本需求的 reachable TUI path。
- session_diff 外部文件删除、snapshot GC 策略和历史 summary.diffs 外置；这些不是本方案的主路径，不能导致消息数据丢失。

## 6. Invariants and First Divergence

### 6.1 Invariants

| ID | invariant |
|---|---|
| I1 | `cold_ref IS NULL` 时，主表 `data` 是完整 canonical JSON；`cold_ref IS NOT NULL` 时，`data + cold_storage[cold_ref]` 可无损恢复原 JSON |
| I2 | 每个 cold payload 的 hash 精确为 `SHA-256(UTF8(owner) + 0x00 + UTF8(canonicalJSON(envelope)))`；codec、原始字节数、压缩字节数持久化，解压失败或 hash 不匹配必须 hard fail |
| I3 | 正常 freeze/thaw/fork/update/message delete/part delete/session cascade delete 都在其 projector transaction 内维护精确 `ref_count`；`verify` 只修复外部 SQL/旧版本/损坏状态，清理同时要求计数为零且无 owner 引用 |
| I4 | 普通 text、tool input/name、file filename/path、compact marker、summary、tail metadata 不因冷存储而丢失或被 prompt 错误替换 |
| I5 | search/list 不触发 thaw，不从 `cold_storage` 建索引，不因 cold projection 改变结果面 |
| I6 | 同一个读取 owner 只有一个 thaw implementation；display、prompt、fork、export 不能各自实现解压和 merge |
| I7 | fork 的 child message/part ID 独立；共享只发生在 cold payload 层；父/子任一 owner thaw 不改变另一 owner 的引用语义 |
| I8 | `compress`/`expand` 可重复执行、可中断恢复；每次 payload 变更都在同一 SQLite transaction 内完成 |
| I9 | migration 前的热数据保持可读；当前 cold schema 唯一 codec 是 `zstd`，codec dispatch 只接受持久化的 `zstd`，未知值或异常均 hard fail |
| I10 | compact boundary 与 `tail_start_id` 的过滤结果在压缩前、压缩后和展开后相同 |
| I11 | info-only Message predicate 只扫描 HotInfo；只有最终匹配 Message 可以 hydrate Parts/cold fields，无匹配时零 Part 读取 |
| I12 | queued/running/resuming maintenance 是 daemon active work；idle/startup timeout 不得中断，显式 stop/signal 必须在关闭 DB 前 checkpoint interrupted |

### 6.2 First divergence and owner

| divergence | owner | reason existing logic cannot carry requirement |
|---|---|---|
| 大字段直接嵌入 `message.data`/`part.data` | `ColdStorage` + projector | 当前 schema 没有 blob/reference ownership，无法在不改写 payload 的情况下去重和计数 |
| row mapping 直接 `...row.data` | `MessageV2` hydration | 没有 cold_ref 路由，压缩后会返回占位数据或解析失败 |
| hydrate 只按 message ID 加载全部 parts | `MessageV2.hydrate/page` | 没有 read intent 和统一 thaw seam，无法保证只解冻请求范围 |
| fork 通过已 hydrate object 重新写 child | `Session.fork` | 如果不保留 cold_ref，fork 会把共享 payload 展开为重复热 JSON，失去 fork 去重 |
| projectors durable upsert 不认识 cold_ref | `projectors` | owner 更新后会留下 stale reference 或覆盖 cold payload |
| Session delete 依赖 SQLite cascade | `projectors` + `ColdStorage.releaseSession` | cascade 不会递减应用层 ref_count；正常删除必须先在同一 transaction 聚合并释放 refs |
| `getPart`/`parts`/`get` 直接 spread row data | `MessageV2` shared row decoder | 只修改 hydrate 会让 direct consumers 得到 placeholder |
| request usage 为 step-finish 扫描全部 parts | `RequestUsage` hot-only query | `MessageV2.parts` 的完整对象合同会触发不需要的 cold thaw |
| `findMessage` 为 info predicate hydrate 整页 Parts | `MessageV2.findHot` + `Session.findMessage` | 当前 page 合同返回完整 Messages，不能表达热定位后单行 hydrate |
| CLI 没有维护任务路由 | `DbCommand` + daemon private control | 直接 CLI 写 DB 会与 daemon 并发写入，且无法统一后台批处理/锁语义 |
| daemon active 只计算 SSE/SessionActivity | TUI worker lifecycle | 后台 maintenance 在 CLI 断线后会被正常 idle shutdown 中断 |

## 7. Proposed Design To Be Audited

### 7.1 Schema and migration

在 `session.sql.ts` 增加：

```sql
CREATE TABLE cold_storage (
  hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  codec TEXT NOT NULL,
  payload BLOB NOT NULL,
  raw_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

ALTER TABLE message ADD COLUMN cold_ref TEXT REFERENCES cold_storage(hash) ON DELETE RESTRICT;
ALTER TABLE part ADD COLUMN cold_ref TEXT REFERENCES cold_storage(hash) ON DELETE RESTRICT;

CREATE INDEX message_cold_ref_idx ON message(cold_ref);
CREATE INDEX part_cold_ref_idx ON part(cold_ref);
CREATE INDEX cold_storage_ref_count_idx ON cold_storage(ref_count);
```

Drizzle schema 使用 snake_case；`payload` 使用 binary buffer mode。`cold_ref` 的 `RESTRICT` 防止 refcount bug 或手工 SQL 删除仍被 owner 引用的 payload。正常 owner/session 删除必须先在同一个 projector transaction 聚合并递减 ref，再删除 owner；verify 不是正常删除路径的替代品。

`MessageTable.data`/`PartTable.data` 的 Drizzle row type 改为 storage-private `StoredInfoData`/`StoredPartData`：它们允许由 `cold_ref` 证明的字段占位，但不能直接赋值给 `MessageV2.Info`/`Part`。完整业务类型保持不变，只有 cold-aware decoder 可以把 stored row 转成业务对象；这用类型边界阻止 projector caller 把 raw skeleton 传回完整替换 API。

Cold payload 的未压缩 canonical envelope 形状：

```json
{
  "version": 1,
  "owner": "message|part",
  "fields": {
    "summary.diffs": "original value",
    "state.output": "original value",
    "state.attachments.0.url": "original data URI",
    "text": "original value",
    "url": "original value"
  }
}
```

只包含实际存在且符合白名单的字段；`hash = SHA256(owner + NUL + canonicalJSON(envelope))`。`canonicalJSON` 递归按 Unicode code-point 升序排列 object keys，array 保持原顺序，使用标准 JSON number/string/null 编码，省略 object 中的 `undefined`，拒绝非 JSON 值；该实现只存在于 `cold.ts`。字段路径写入 envelope，避免同一 JSON 值在不同语义 owner 间误共享。聚合 envelope 的 UTF-8 长度必须至少 `4096` bytes 才 freeze；不足门槛的 owner 保持完整热 JSON。

冷字段白名单和热投影：

| owner/type | 可冷字段 | hot projection |
|---|---|---|
| user message | `summary.diffs` | 保留 summary 结构，`diffs: []` 作为明确占位；实际值只由 cold-aware read path 暴露 |
| completed tool part | `state.output`、嵌套 attachment 中满足 data URI/base64 判定的各个 `url` | output 使用空字符串占位；attachment 结构/filename/mime 保留，仅对应 URL 置空 |
| reasoning part | `text` | 空字符串占位 |
| file part | 仅 data URI/base64 `url` | 空字符串占位；filename/path/source 永远保留 |

`step-start`、`step-finish`、`patch` 保持完整热 JSON。普通 text、tool input/name、非 data URI file URL 和 compact structural fields 保持热。

### 7.2 Codec adapter

在 `storage/cold.ts` 内定义单一 codec seam：

- `zstd`：本 schema 唯一 codec，固定 level 3；Bun 使用 `Bun.zstdCompressSync`/`Bun.zstdDecompressSync`，Node 使用 `node:zlib` 对应 API。
- 当前仓库没有 persisted cold payload，因此不实现 gzip legacy success path；未来 codec 必须由新的 schema/version migration 和独立审计引入。
- payload 保存压缩 bytes，不保存平台路径或外部文件依赖。
- 运行时缺少请求 codec 时返回 typed unavailable error；不静默改写为另一 codec。
- 解压后验证 `raw_bytes` 和 SHA-256；不匹配返回 corruption error，禁止返回占位内容冒充成功。

### 7.3 ColdStorage module contract

`storage/cold.ts` 是唯一实现 owner/cold payload 边界的 deep module，公开最小接口：

- `freezeOwner(owner, eligibility, now)`：提取白名单字段、建立 hot projection、insert-or-reuse payload、增加引用、写回 owner。
- `thawOwner(owner)`：按 `cold_ref` 读取、codec dispatch、hash verify、merge 原字段、清除引用、回填 owner 并减少引用。
- `thawRows(rows)`：在 `MessageV2.page/hydrate` 中批量使用，但每个 owner 只解冻一次。业务对象读取一律完整 thaw；search/status/step-finish 等 hot-only 查询直接选择热列，不向前端暴露 read intent。
- `replaceOwner(db, owner, fullObject)`：durable update 的唯一完整替换 seam；若旧 row 有 cold_ref，先 release，再写入调用方提供的完整热对象并清空 cold_ref。
- `cloneOwner(source, target)`：fork 保留 hot projection 和 cold_ref，事务内增加引用；不先把大字段展开到 JS 再重压缩。
- `clonePrefix(db, sourceSessionID, targetSessionID, idMap, beforeMessageID)`：直接查询 raw MessageTable/PartTable rows，复制 skeleton/cold_ref 或完整热 JSON，重写 parent/tail IDs 并聚合增加 refcount。
- `releaseOwner(owner)`：显式 message/part 删除或覆盖时在 projector transaction 内减少引用。
- `releaseSession(db, sessionID)`：在 `Session.Event.Deleted` projector 内先按 hash 聚合该 session 的 message/part refs、递减计数，再执行 SessionTable delete/cascade；该 transaction 失败则全部 rollback。
- `verify({repair})`：反算 owner 引用、检查 payload hash/codec/size、报告或修复 orphan/ref_count。
- `expand({scope})`：将指定范围全部 thaw；`--all` 才允许全库。
- `prepareMaintenance(request)`：规范化 scope/defaults，判定 immediate 或 task-backed operation，并为 task-backed operation 生成初始 queued record；CLI/worker 不复制该判定。
- `maintain(prepared, runtime)`：唯一 maintenance operation dispatcher 与 batch state machine；daemon 和 offline CLI 都只调用此函数。

Maintenance production contract：

```ts
type MaintenanceRequest =
  | { operation: "compress"; sessionID?: SessionID; olderThanMs: number; batchSize: number }
  | { operation: "expand"; sessionID?: SessionID; all: boolean; batchSize: number }
  | { operation: "status" }
  | { operation: "verify"; repair: boolean; batchSize: number }
  | { operation: "cleanup"; delete: boolean; batchSize: number }
  | { operation: "vacuum"; confirm: boolean }

type MaintenanceRuntime = {
  task?: MaintenanceTask
  lease?: { assertOwned(): void }
  signal?: AbortSignal
  checkpoint(task: MaintenanceTask): Promise<void>
}

type MaintenanceResult =
  | { type: "task"; task: MaintenanceTask }
  | { type: "status"; report: StatusReport }
  | { type: "verify"; report: VerifyReport }
  | { type: "cleanup"; report: CleanupReport }
  | { type: "vacuum"; pagesBefore: number; pagesAfter: number }
```

- `prepareMaintenance` 唯一决定：compress/expand/verify-repair/cleanup-delete 是 task-backed；status、verify-report、cleanup-preview、vacuum 是 immediate。
- `maintain` 唯一拥有 operation dispatch、eligibility、SQL、batch transaction、cursor advance、task transition 和 report 计算。`db.ts`、`worker.ts`、`server-lock.ts` 不能包含 cold row 查询、refcount SQL 或 operation-specific cursor logic。
- task-backed 调用必须提供 task、lease 和 checkpoint。每批先 `lease.assertOwned()`，在 immediate DB transaction 内执行 owner changes，提交后更新 cursor/counts 并 `checkpoint`；checkpoint 失败使 task 失败但不回滚已提交 batch，恢复时由幂等 owner state + last committed cursor 继续。
- `signal` 只在 batch 边界观察；abort 不打断正在提交的 SQLite transaction。当前 batch 提交后把 task checkpoint 为 interrupted 再返回，不关闭 DB 或伪造 completed。
- immediate read-only 调用不需要 lease。vacuum 是唯一 immediate write，必须提供 lease 且 `confirm=true`；它没有 task/cursor。
- `status` 返回 `{ eligibleOwners, coldOwners, rawBytes, compressedBytes, sharedBytes, refCountMismatches, orphans }`。
- `verify` 返回 `{ checkedOwners, checkedPayloads, refCountMismatches, missingPayloads, corruptPayloads, repaired }`；`repair=false` 只读，`repair=true` 逐 batch checkpoint。
- `cleanup` 返回 `{ candidates, candidateBytes, deleted, deletedBytes }`；`delete=false` 只读，`delete=true` 每 batch 用 `NOT EXISTS` 二次确认后删除。
- `prepareMaintenance`/`maintain` 返回 typed validation、busy、unavailable、conflict、corruption errors；调用层只序列化错误，不合成成功。

所有调用方使用该模块，不在 `Session`、projector、CLI、prompt 或 daemon 中复制压缩算法。

### 7.4 Write path and concurrency

`compress` 对一个 owner 执行单事务：

1. 重新读取 owner 和 session `time_updated`，确认 eligibility 仍成立且 `cold_ref IS NULL`。
2. 提取字段并 canonical encode/hash/compress。
3. `INSERT ... ON CONFLICT(hash) DO NOTHING` 创建或复用 payload。
4. 更新 owner hot projection 和 `cold_ref`。
5. 增加 payload `ref_count`。
6. 提交；批次间释放事务，保证中断后已提交 owner 可继续、未提交 owner 不变。

`Session.updateMessage` 和 `Session.updatePart` 继续维持现有 **完整对象替换** 合同，不新增 patch mask，也不猜测字段是否被触及：

1. hot projection row 是 storage-private 形状，不能作为 `MessageV2.Info`/`Part` 业务对象返回或传入 update API。
2. 所有业务读取先通过 cold-aware decoder thaw，调用方拿到完整对象后才能修改并提交 update。
3. projector 收到完整对象时，无条件调用 `replaceOwner`：若旧 owner 有 cold_ref，事务内 release；随后写入完整 incoming JSON、设置 `cold_ref = NULL`。
4. 因而“修改非冷字段”由上游完整对象自然保留原冷字段，“真实把 cold field 改为空”则按完整替换写空并释放旧 payload；不存在根据空占位猜测 retain/release 的分支。
5. fork 不调用该完整替换 API；它只走 §7.6 raw clone seam，避免 storage projection 进入业务对象合同。
6. freeze 和 projector update 都使用 immediate transaction：若 update 先提交，freeze 读取最新完整对象；若 freeze 先提交，后续 update 按完整替换 release old ref。不存在并发窗口需要字段触及猜测。

正常删除路径同样是 projector transaction 的 primary path：

1. `MessageV2.Event.PartRemoved` 读取该 part 的 ref，递减后删除 part。
2. `MessageV2.Event.Removed` 聚合其 message 与 parts 的 refs，递减后删除 message/cascade parts。
3. `Session.Event.Deleted` 聚合整个 session 的 message/part refs，递减后删除 SessionTable/cascade owners。
4. 每条路径只删除 `ref_count = 0` 且 `NOT EXISTS` 于 message/part owner 的 payload；共享 fork payload 必须保留。
5. `verify --repair` 仅处理手工 SQL、旧版本 crash 或外部破坏，不是正常删除最终一致性方案。

### 7.5 Read path, thaw, and persistent prewarm

`MessageV2.info`、`part`、`hydrate`、`page`、`parts`、`get`、`stream` 和 `Session.getPart` 统一经过 cold-aware row mapping：

- session list/search 只读 SessionTable/热投影，不调用 thaw。
- page/display 请求只先选取 message page，再 hydrate 该 page 的 parts；只为返回范围 thaw。
- prompt/model conversion 读取到的历史范围全部 thaw，但只解冻该 prompt 实际获取的 rows。
- thaw 成功后主表恢复完整原 JSON 并清除 `cold_ref`，后续读取不再解压；这是持久预热，不是内存缓存。
- cold blob 缺失、hash 错误、codec 不可用时返回明确错误；不得使用空占位继续向模型发送。
- HTTP 单消息 handler 继续调用 `MessageV2.get`，因此无需修改 public schema；其 cold behavior 由 HTTP 公开行为测试覆盖。
- `RequestUsage.recordAssistant` 不需要完整 parts，改为直接查询热态 `step-finish` rows，不调用 `MessageV2.parts`，避免统计请求 thaw tool/reasoning payload。
- `db query` 仍是原始 SQL 诊断命令，不承诺把 cold projection 自动变成业务对象；业务读取必须使用 `MessageV2`/`ColdStorage` seam。

`Session.findMessage` 使用独立但同属 `MessageV2` owner 的两阶段查询：

1. 定义 `HotInfo = Assistant | (Omit<User, "summary"> & { summary?: Omit<NonNullable<User["summary"]>, "diffs"> })`；assistant info 全热，user summary 明确移除唯一冷字段 `diffs`，storage-private `cold_ref` 和 placeholder 不进入该类型。
2. `MessageV2.findHot({ sessionID, predicate })` 以 newest-first page 只选择 MessageTable rows，构造 HotInfo 并执行 `(info: HotInfo) => boolean`；不查询 PartTable、不调用 thaw。
3. 找到首个匹配 row 后，只对该 row 调用现有 `MessageV2.get`/shared decoder，返回完整 `WithParts`；predicate 扫描无匹配时返回 `Option.none` 且零 Part query。
4. `Session.findMessage` 的 predicate contract 改为 HotInfo；全部 7 个当前调用点只把 `(m) => m.info.*` 改为 `(info) => info.*`，匹配后的返回值仍是完整 `WithParts`，因此 `lastAssistant`/TaskStatus 的 Parts 行为不变。
5. 禁止在 prompt、Compaction、HTTP handler、permission reviewer、Task 或 TaskStatus 中复制 Message SQL；它们只调用 Session owner。

### 7.6 Fork behavior

`Session.fork` 不再调用 `session.messages()`/`MessageV2.page()` 取得 hydrated business objects。可达主路径如下：

1. `Session.fork` 创建 target session，并只查询 source message/part IDs 与结构关系，生成确定的 source-to-target MessageID/PartID map。
2. 新增 `Session.Event.Forked` sync event；payload 包含 source session、target session、fork point 和 ID map，不包含业务 payload。aggregate 是 target session ID。
3. `projectors.ts` 在 `SyncEvent.run` 已有的 immediate SQLite transaction 中处理 `Forked`，调用 `ColdStorage.clonePrefix` 直接查询 raw source MessageTable/PartTable rows；它不经过 `info()`、`part()`、`hydrate()` 或 update events。
4. hot source row 复制完整 JSON；cold source row 复制 storage-private skeleton 与同一 `cold_ref`，按 hash 聚合增加 ref_count。assistant parentID 和 compaction `tail_start_id` 使用事件中的 ID map 重写。
5. clone transaction 失败时 target owner inserts 与 ref increments 全部 rollback，`Session.fork` 返回失败；禁止回退到 hydrate-and-rewrite 成功路径。
6. 父或子 owner thaw 后只改变自身 row；另一 owner 保留共享 cold_ref。删除任一 owner 必须遵守 §7.4 transaction release，不删除仍被另一 fork 引用的 payload。
7. fork point 之后的新 child 内容走普通完整热 update，后续由 eligibility 决定是否 freeze。

### 7.7 Compact boundary and eligibility

Eligibility 由 `ColdStorage.isEligibleOwner` 唯一实现，compress、status 和测试不得复制判定。先选择 owner，再只提取冷字段白名单且要求 canonical envelope `>= 4096` bytes：

| session/owner 状态 | owner eligibility |
|---|---|
| age-only：超过 30 天、无 completed boundary | session 内所有 owner 可检查冷字段白名单 |
| compact-only：未超过 30 天、有 completed boundary | 只检查 `message_id < tail_start_id` 的 compacted head；marker、summary、tail 不因 boundary eligible |
| age+compact | 所有 owner 可检查：head 由两条规则命中，marker/summary/tail 只由 age 规则命中 |
| neither | 不检查、不 freeze |

结构字段不在白名单，因此 compact marker、summary assistant 普通 text、recent-user memento、tail metadata 在四种情况下都保持热。tail 内的 tool output/reasoning/data URI 只有 session 已超过 30 天时才可冷冻。`filterCompacted` 的输出在 freeze/thaw/expand 前后必须相同；压缩不替代 compaction，也不删除任何 structural part。

### 7.8 Avoiding over-aggressive Messages reads

先按调用意图分类，不把所有 `Session.messages({sessionID})` 视为错误：

- 有意全量：fork、compaction、summary、revert、export/share、完整 prompt 构建；这些保留全量语义，但通过统一 thaw seam，避免每个调用方独立解冻。
- 已有范围：`limit`/cursor page、ACP 最近 20 条等保持范围。
- 本 revision 修复的可证明过度读取：`processor.ts` doom-loop 分支当前为了寻找前一个 assistant message 调用完整 `session.messages`。在 `message-v2.ts` 增加按时间倒序、只取所需前一个 assistant/tool tail 的查询 seam，processor 不再加载完整 session。
- `RequestUsage.recordAssistant` 当前只需要 `step-finish`，改用 hot-only query，不再经 `MessageV2.parts` thaw 同 message 的 tool/reasoning/file payload。
- session list/search 保留既有 tool identity/input 搜索，只证明 cold tool output/result、provider metadata 和 reasoning 不会被 thaw 或加入结果。
- public HTTP handler 和 webapp 不改 wire contract；无 `limit` 的完整 API 请求仍返回完整历史，这是明确的外部 API 语义，不在本 revision 私自改变。

### 7.9 Daemon and CLI workflow

复用现有 `ServerLock` token/control port，并新增一个确定的 maintenance protocol：

- `POST /maintenance` 接收 `MaintenanceStart`，只接受 lock token。request 是 `{ operation, sessionID?, olderThanMs?, batchSize, all?, repair?, cleanup?, confirm? }`；response 是 `{ taskID, operation, status: "queued" | "running", createdAt }`。
- `GET /maintenance/status?task=<taskID>` 返回持久 task record；task 不存在返回 404，不把 daemon health 当 task status。
- `POST /maintenance/resume` 接收 `{ taskID }`，只允许 `interrupted` task；completed/failed/running 返回明确 conflict。
- `GET /status` 保持现有 daemon health contract，不承载 maintenance data；`opencode db status` 是 DB metrics，`opencode db status --task <id>` 才查询 task record。
- `DbCommand` 在执行前判定运行域：live daemon 存在时只请求 control；启动时无 live daemon 时使用同一 `ColdStorage.maintain`。control 失败返回 unavailable，不自动切换模式。

两种运行域的调用链必须固定：

- daemon：worker 只做 token/request decode → `ColdStorage.prepareMaintenance` → task-store/lease 准备 → `ColdStorage.maintain`；response 只序列化 result/error。
- offline CLI：db command 只做 argv decode → `ColdStorage.prepareMaintenance` → 同一 task-store/lease 准备 → `ColdStorage.maintain`；输出只渲染 result/error。
- `server-lock.ts` 只实现 lock/task record 的原子文件生命周期和 `MaintenanceRuntime` callbacks，不实现 operation dispatch、SQL、eligibility、report 或 cursor advance。

Maintenance ownership 与持久状态由 `server-lock.ts` 统一拥有：

- root 是 `<opencode.db>.maintenance/`；原子锁目录是 `lock/`，持久 task records 位于 `tasks/<taskID>.json`。这些文件只保存控制元数据，不保存 Message/Part/cold payload。
- `mkdir(lock)` 的跨平台原子成功是唯一获取条件；`lock/owner.json` 含 pid、随机 token、规范化 dbPath、taskID、startedAt。daemon 与 offline CLI 使用同一 acquire/release helper。
- task record 是 `{ version: 1, taskID, dbPath, operation, args, status, cursor, processed, skipped, failed, rawBytes, compressedBytes, createdAt, updatedAt, error? }`；每批完成后以 tmp+rename 原子更新。
- cursor 对 compress/expand 是 `{ owner: "message" | "part", lastID }`，对 verify/cleanup 是 `{ stage, lastHash }`。真正数据完成状态仍由 owner `cold_ref`/hash/refcount 决定，cursor 只避免重复扫描。
- 同一 DB 最多一个 nonterminal task。新 start 遇到 queued/running/interrupted task 返回 conflict；不会猜测应恢复哪一个。
- 若 lock owner pid 存活，立即 busy。pid 不存活时把对应 running task 原子标记为 interrupted，再以 token 二次确认后移除 stale `lock/`；PID 复用只会保守阻塞。
- daemon 启动并写好主 lock 后扫描唯一 interrupted task，获取 maintenance lock 并调用同一 `ColdStorage.maintain` 从持久 cursor 继续。多个 nonterminal records 或损坏 record hard fail 并等待人工 `db status --task`/修复，不选择任意 task。
- release 只在 owner token 一致时删除 `lock/`；task record 保留以供断线后查询。维护 task 批次间释放 DB transaction，但持续持有 maintenance lock。
- vacuum 是前台、不可 resume 的原子 SQLite operation；它使用同一 maintenance lock，但不创建后台 task record。中断后 SQLite 自身保证原 DB transaction，不伪造 completed。

Worker lifecycle contract：

- worker 维护唯一 `activeMaintenance = { taskID, controller, promise } | undefined`；daemon startup recovery 在调用 `maybeScheduleStartupIdleShutdown()`/launcher watcher 前登记 active；新 start/resume 在返回 response 前登记 active并取消 startup/idle timer。
- `isActive()` 精确为 `sseClients > 0 || SessionActivity.count() > 0 || activeMaintenance !== undefined`；launcher watcher、startup timer 和 regular idle timer 都复用该函数。
- task promise 在 completed/failed/interrupted checkpoint 后才清除 active，并重新调用 `maybeScheduleIdleShutdown()`；不得在 checkpoint 前让 daemon 变 idle。
- `gracefulShutdown` 对显式 daemon stop、SIGTERM、fatal error 先 abort controller，再 await 当前 batch transaction 与 interrupted checkpoint，之后才 dispose instances、关闭 control/internal server 和 Database。
- idle/startup timeout 因 active task 不会进入 gracefulShutdown；测试必须在无 SSE、startup timeout 小于任务总时长的情况下观察 task 完成且 daemon 仍存活，然后 task 完成后正常 idle exit。

命令契约：

```text
opencode db compress [--session <id>] [--older-than 30d] [--batch-size N]
opencode db expand --all [--session <id>] [--yes] [--batch-size N]
opencode db status [--task <task-id>]
opencode db resume <task-id>
opencode db verify [--repair] [--batch-size N]
opencode db cleanup [--dry-run] [--yes] [--batch-size N]
opencode db vacuum [--yes]
```

- `compress`/`expand`/`verify --repair`/`cleanup --yes` 由 daemon 返回 task ID；CLI 可断线，使用 `status --task` 查询。
- `expand` 没有 `--all` 且没有明确 session scope 时拒绝执行；展开是 thaw+持久回填，不是复制到外部文件。
- `status` 无 `--task` 时输出 DB metrics；带 `--task` 时只输出 task record，不执行 integrity scan。
- `resume` 只恢复持久 `interrupted` task，operation/args 来自 record，调用同一 `ColdStorage.maintain`；禁止 CLI 改写参数后继续同一 task ID。
- `verify` 默认同步只报告；`--repair` 才创建可恢复 task，并且只修复可证明的 ref_count/orphan 状态。
- `cleanup` 默认/`--dry-run` 同步列出实际 owner 反算为零的 payload；`--yes` 创建 task，在每批 transaction 内再次确认 `NOT EXISTS` owner 后删除。它不隐式 repair 或 vacuum。
- `vacuum` 仅在 verify 后、确认无 nonterminal task 时执行；不作为 compress/cleanup 的隐式步骤。

## 8. File and Diff Budget

R8 目标变更文件为 22 个：原 16 个 owner/test 文件，加上 6 个现有 `findMessage` HotInfo predicate 调用点。该增加由可达的无意义 thaw 证据要求，仍低于用户硬上限 32；超过 22 必须先修订并重审。

### Production/schema files

1. `packages/opencode/src/storage/cold.ts` — 新增 codec、canonical envelope、freeze/thaw/clone/verify/expand deep module。
2. `packages/opencode/src/session/session.sql.ts` — `ColdStorageTable`、`MessageTable.cold_ref`、`PartTable.cold_ref` 和 indexes。
3. `packages/opencode/src/session/message-v2.ts` — cold-aware row mapping、storage-private raw clone seam、hydrate/page/parts/stream、bounded previous-assistant query。
4. `packages/opencode/src/session/session.ts` — full-replacement update contract、raw-ID fork event 与 `getPart` shared decoder。
5. `packages/opencode/src/session/projectors.ts` — durable full replacement、raw fork clone、delete release/refcount 规则。
6. `packages/opencode/src/session/processor.ts` — doom-loop 路径改为 bounded previous-assistant seam。
7. `packages/opencode/src/session/request-usage.ts` — step-finish hot-only query，避免统计触发 cold thaw。
8. `packages/opencode/src/cli/cmd/db.ts` — `db compress/expand/status/verify/cleanup/vacuum` 命令和 daemon/offline 受支持模式路由。
9. `packages/opencode/src/cli/cmd/tui/worker.ts` — 私有 token-protected maintenance control handler。
10. `packages/opencode/src/cli/cmd/tui/server-lock.ts` — maintenance path/request helper，复用现有 token/lock contract。
11. `packages/opencode/src/session/prompt.ts` — current model/last assistant 的 predicate 改用 HotInfo；匹配返回完整 Message 的行为不变。
12. `packages/opencode/src/session/compaction.ts` — compaction source predicate 改用 HotInfo。
13. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — Goal resume 的 user existence predicate 改用 HotInfo，不改 public API。
14. `packages/opencode/src/permission/reviewer/service.ts` — reviewer model lookup predicate 改用 HotInfo。
15. `packages/opencode/src/tool/task.ts` — latest user predicate 改用 HotInfo。
16. `packages/opencode/src/tool/task_status.ts` — latest assistant predicate 改用 HotInfo，匹配后仍消费完整 Parts。

### Generated migration files

17. `packages/opencode/migration/<timestamp>_cold_storage/migration.sql` — 由 Drizzle 生成，不能手写绕过 schema。
18. `packages/opencode/migration/<timestamp>_cold_storage/snapshot.json` — 与 migration 同步生成。

### Test files

19. `packages/opencode/test/storage/cold.test.ts` — codec、hash、freeze/thaw、all direct reads、session/message/part delete、fork/refcount、search no-thaw、verify/expand/failure atomicity。
20. `packages/opencode/test/session/messages-pagination.test.ts` — page-range thaw、HotInfo find、单匹配 hydrate、`MessageV2.get`、HTTP single-message、persistent prewarm。
21. `packages/opencode/test/session/compaction.test.ts` — 四象限 eligibility、boundary、tail、summary、recent-user-memento 在 cold/expand 前后等价。
22. `packages/opencode/test/cli/tui/daemon.test.ts` — 扩展现有真实 daemon 进程测试，覆盖 token、maintenance dispatch、daemon-absent lock、批次恢复和 maintenance idle-liveness；禁止创建平行 seam。

现有 `packages/opencode/test/storage/db.test.ts`、session、projector 和 migration test suite 必须作为回归命令运行，但本 revision 不额外修改该文件；若实施中必须修改，必须先增加 plan revision 并重审。

## 9. TDD and Verification Plan

每个 slice 按 `red -> minimal approved behavior -> green -> regression` 执行，禁止测试复制 production algorithm。

1. **Codec red**：zstd round-trip、raw size/hash mismatch、unknown codec hard-fail、Bun/Node adapter contract；green 后在 Windows/Linux/macOS CI 运行。
2. **Schema red**：migration 从旧 DB 升级、旧热 row 仍可读、nullable `cold_ref`、旧 DB 无 payload 时无数据变化。
3. **Freeze/thaw/update red**：各白名单字段和 placeholder 结构、canonical hash、共享 payload、refcount transaction、异常 rollback；cold-aware read 后只改非冷字段会保留原 cold field，真实把 cold field 改为空会释放旧 ref 并持久写空；expand 后 byte-level canonical JSON 相等。
4. **Read red**：分页、`MessageV2.parts/get`、`Session.getPart`、HTTP single-message 都恢复完整字段；HotInfo `findMessage` 扫描多页时零 Part thaw、只 hydrate 最终匹配 Message，无匹配零 Part query；第二次读取命中热主表；缺 blob/hash 错误不向 model path 发送占位。
5. **Search/statistics red**：tool output/provider metadata 不进入 session list/search且不 thaw；request-usage 只查热 `step-finish`，不 thaw tool/reasoning/file。
6. **Compact red**：四象限 eligibility、boundary、tail、summary、recent-user memento 在 freeze/thaw 前后 `filterCompacted` 和 `toModelMessages` 结果相等。
7. **Fork/delete red**：从 cold source 执行公开 `Session.fork` 后，在任何 thaw 前直接验证 child 使用独立 IDs、相同 cold_ref、正确 grouped refcount，且 clone path 未产生完整热副本；父子独立 thaw；part/message/session cascade delete 均事务性递减且不破坏另一 fork。
8. **Bounded history red**：doom-loop 只取前一个 assistant/tool tail，不执行完整 session hydrate；有意全量调用的行为保持不变。
9. **Daemon/CLI red**：无 token 401；start 返回 taskID；`status --task` 与 daemon health/DB metrics 分离；子进程在批次后退出会留下 interrupted record，重启 daemon 从同一 cursor 自动完成；显式 resume 只接受 interrupted；同一个 prepared request 通过 daemon 和 daemon-absent CLI 后得到相同 DB/result；live daemon control 失败只返回 unavailable；无 SSE 且 startup/idle timeout 小于任务时长时 daemon 保持存活至 terminal checkpoint，显式 stop 会 checkpoint interrupted 后退出。
10. **Integrity/cleanup red**：verify 报告/修复 refcount；cleanup dry-run 不写、`--yes` 只删除实际零 owner payload且不 vacuum；vacuum 前后 row/hash/expanded JSON 不变。

实现阶段的最窄命令和扩展验证：

```powershell
# cwd: packages/opencode
bun test test/storage/cold.test.ts test/session/messages-pagination.test.ts test/session/compaction.test.ts test/cli/tui/daemon.test.ts
bun test test/storage/db.test.ts test/session/session.test.ts test/storage/cold.test.ts
bun typecheck
bun run db generate --name cold_storage
bun test
```

`bun run db generate` 只能在 schema/test red 已明确 migration 形状后执行；本 plan 阶段不运行写入性 migration generation。

## 10. Empirical Benefit and Performance Guardrails

收益基于 §4.1 固定 snapshot 的只读 zstd level 3 实验。R2 `4 KiB` 门槛的直接观测值是：33,703 owners、27,114 unique payloads、637.94 MB raw canonical envelopes、250.29 MB unique zstd、387.65 MB gross payload reduction。按 eligibility 来源的 raw envelope 是 age-only 303.77 MB、compact-only 139.24 MB、age+compact 194.93 MB；cross-scope hash 共享后才计算唯一 zstd，因此不把三类各自估算相加。

实现阶段必须复制同一输入 DB 到临时目录，执行真实 migration/freeze 后以 `dbstat` 比较 net pages，再 expand 并逐 owner 比较 SHA-256。只有该结果可称最终 DB 文件收益；当前 plan 只承诺已实测的 payload reduction。

性能硬约束：

- hot read 不读取或解压 cold payload。
- page hydrate 只处理 page rows，不因 session ID 读取全历史 parts。
- HotInfo find scan 不查询 PartTable；只对最终匹配 Message 执行一次完整 hydrate。
- cold payload 已持久 thaw 后，后续同一 owner 不重复解压。
- compress 使用批次 transaction，不持有全库长事务，不阻塞正常短写入超过测试阈值。
- `verify` 可以全库扫描，但不在正常 prompt/session list 请求路径运行。

## 11. Risks, Speculation, and Non-goals

### Real risks and mitigations

- **数据库中断导致部分完成**：每个 owner transaction 原子提交，批次 cursor 可重建；测试进程中断后检查所有 owner/hash/refcount。
- **payload 损坏**：持久 hash/size/codec 校验；返回 typed corruption error，禁止以 placeholder 成功。
- **旧代码绕过 thaw**：将所有生产业务 row mapping 收敛到 `MessageV2` seam；raw SQL 只保留诊断用途；增加 search/page 回归测试。
- **cascade 删除遗漏引用**：Session/Message/Part delete projector 在同一 transaction 先聚合 release，再 cascade；FK `RESTRICT` 阻止错误清理；verify 只处理外部不一致。
- **daemon 与 CLI 并发**：daemon token path 或全局 maintenance lock 二选一串行，禁止两个 owner 同时维护。
- **Node/Bun API 差异**：codec adapter 封装 runtime API；payload 只保存 codec 名和 bytes；Windows/Linux/macOS 运行时矩阵验证。
- **fork 跨共享 payload 的引用错误**：clone transaction 测试父/子独立 thaw、删除和 verify。

### Explicitly unproven/speculative and excluded

- 不假设 snapshot tree 一定可重建 summary.diffs；不把外部 `session_diff` 清理当作消息恢复来源。
- 不假设所有历史 full-message 请求都可以改为 limit；只有有证据证明只需要 tail 的 doom-loop path 改为 bounded query。
- 不新增自动 TTL/LRU/re-cold；持久预热是已确认语义。
- 不压缩普通 text 以追求更大数字；这会把频繁 prompt 读取引入解压成本。
- 不在本 revision 做 fork 前缀虚拟 session；只共享 cold payload，避免改变 message ID、分页和删除语义。
- 不修改 public HTTP/webapp/SDK contract。

## 12. Traceability

### Forward mapping: requirement to owner/path/test

| requirement/invariant | owner/path | planned test |
|---|---|---|
| 同库 cold blob、字段引用、refcount | `session.sql.ts` + `storage/cold.ts` | `cold.test.ts` migration/refcount |
| 可逆压缩、零丢失 | `storage/cold.ts` | codec/hash/expand round-trip |
| daemon 后端 thaw、前端透明 | `worker.ts` + `message-v2.ts` | daemon + pagination |
| 持久 prewarm | `message-v2.ts` thaw/writeback | second-read no decompress |
| compact 内容处理 | eligibility + `filterCompacted` | `compaction.test.ts` |
| fork 共享 | `session.ts` + `cold.ts` | parent/child refcount/thaw |
| cold owner 正常更新 | `Session.updateMessage/updatePart` + projector `replaceOwner` | 非冷字段 update 保留完整值；真实 cold-field clear 生效 |
| raw fork clone 可达 | `Session.Event.Forked` + projector `clonePrefix` | public fork 在 thaw 前共享 cold_ref |
| search 不索引 tool output | existing `search.ts` identity/input allowlist | `cold.test.ts` output/result no-thaw behavior |
| 避免无意义 Messages/Parts thaw | `message-v2.ts` + `session.ts` + 6 HotInfo consumers + `processor.ts` + `request-usage.ts` | HotInfo find、bounded history、hot-only statistics |
| CLI compress/expand/status/verify/cleanup/vacuum | `db.ts` + private control | `daemon.test.ts` |
| 后台 task 不受 idle shutdown | worker `activeMaintenance` lifecycle | no-SSE short-timeout completion + stop interruption |
| 跨平台 zstd | `cold.ts` codec adapter | Bun/Node runtime matrix |

### Reverse mapping: production concept to justification

| concept | justification | why existing logic cannot be reused |
|---|---|---|
| `cold_storage` table | DB space root cause and user cold storage requirement | no existing blob/refcount owner |
| canonical envelope/hash | fork duplication and zero-loss recovery | raw row JSON includes identity fields and cannot safely share directly |
| `ColdStorage` deep module | single thaw/prewarm owner | current row helpers have no storage boundary |
| `cold_ref` projection | hot/cold separation | current `data NOT NULL` has no cold marker |
| full-replacement update seam | zero-loss owner mutation | current event is complete object replacement and has no field-touch mask；猜 placeholder 会丢数据 |
| raw `Session.Event.Forked` clone | fork cold payload sharing | current hydrate-and-rewrite business path cannot carry storage-only cold_ref |
| bounded previous-assistant query | processor full-history evidence | `Session.messages` intentionally returns all rows when no limit |
| HotInfo two-stage find | info-only predicates must not thaw scanned Parts | current `findMessage` hydrates every page before evaluating role/model predicates |
| daemon maintenance control | frontend/backend separation and writer ownership | direct `DbCommand` writes race with daemon |
| `prepareMaintenance`/`maintain` | user-selected same implementation across daemon/offline domains | current CLI and worker have no shared operation owner or task state machine |
| maintenance lock directory | user-selected daemon-absent cross-platform execution mode | current daemon lock identifies the server but does not serialize offline maintenance |
| task ID/progress snapshot | background CLI observability | long owner batches cannot be represented by one blocking HTTP response；DB owner state remains resume authority |
| persisted task record/cursor | CLI disconnect and daemon-restart recovery | existing daemon health status has no maintenance identity or resumable cursor |
| `activeMaintenance` worker lease | background task must outlive disconnected CLI | current `isActive` only sees SSE and SessionActivity and will idle-exit |
| status metrics | user needs measurable compression/integrity state | existing `db path/query` has no eligible/refcount/orphan visibility |
| explicit vacuum | reclaim SQLite free pages after reversible expansion/compression | payload deletion alone does not shrink the SQLite file；implicit vacuum would create an unbounded blocking write |
| explicit cleanup | user-required logical cold payload cleanup | verify reports/repairs counts and vacuum reclaims pages；neither owns transactional deletion of proven zero-owner payloads |
| typed unavailable/corruption errors | zero-loss hard-fail invariant | placeholder success or codec guessing would silently change model-visible data |
| transactional release + verify | normal cascade ownership plus external corruption risk | current cascade does not update refcount; verify remains repair-only |

## 13. Implementation Comment Gate

实施 diff 必须遵守仓库 policy 的中文解释性注释门禁：

- 以 effective changed lines `E` 排除空行、import-only、formatter-only、generated 和 pure-move changes。
- R8 目标变更文件为 22 个且不得通过拆行或集中注释凑数；任何第 23 个文件都需 plan revision。
- 若 `E > 0`，必须有 `C >= ceil(E * 0.15)` 条相邻且有信息量的中文注释。
- R8 预计 `E` 为 1100-1500 effective lines，因此实现前按上界预留至少 225 行合格中文注释；最终以实际 `E` 重新计算，不能用估算替代 gate。
- 注释只解释真实 invariant、transaction 原子性、codec compatibility、compact boundary、fork refcount、placeholder 安全边界和测试意图，不翻译 identifier、不复述流程。
- 代表性注释位置应邻近：cold envelope/hash、thaw corruption hard-fail、projector full-replacement/release、raw fork clone、HotInfo two-stage find、daemon maintenance lock/active lifecycle、compaction tail boundary。
- audit handoff 必须报告 `E`、`C`、排除行和代表性注释位置。

## 14. Audit Gate

本 plan 提交后必须由独立 `adversarial-auditor` 进行完整 plan audit。Primary agent 不加载审计 skill、不预读审计材料、不发送自评或设计辩护。

Auditor handoff 只能包含：

- 原始用户需求/GOAL 合同；
- canonical plan 路径：`docs/plans/opencode-db-cold-storage.md`；
- repository root：`F:\ML\PythonAIProject\Claude-Code\opencode`；
- `Audit mode: plan`。

放行条件：当前 exact revision 必须得到 auditor 原样 verdict `No blocking findings` 和 `APPROVE`。任何中高阻塞 finding 都必须修订同一 plan、递增 revision、清空 approval，并按原始需求和完整 affected interface full-scope 重审。用户在 R7 后明确把当前 plan-audit 上限提高到 10 次，并要求每次送审前先做完整逻辑自查；没有批准前保持 `Implementation allowed: no`。

## 15. Audit History

| round | revision | task | result | disposition |
|---:|---|---|---|---|
| 1 | R1 | `ses_09385cb35ffeIdO6AU0wTuUigJ` | Blocking findings present; not approved | B-01 current evidence、B-02 cascade release、B-03 eligibility、B-04 speculative gzip、B-05 direct reads 全部在 R2 修订 |
| 2 | R2 | `ses_09372037cffe4qRQ2Z5d7tSsjR` | `BLOCK` | B-01 owner update ambiguity 与 B-02 fork raw clone path 在 R3 修订并完成 full-scope 重审 |
| 3 | R3 | `ses_093699a18ffewFOy9HBzykVdm8` | `No blocking findings.` / `APPROVE` | exact R3 获得 full-scope plan approval；只授权未来按批准 revision 实施，本目标不实施代码 |
| 4 | R4 | `ses_091fa0c42ffepg9pjVxn1hkvlZ` | `BLOCK` | 修正真实 daemon test seam 后，B-01 cleanup command 与 B-02 offline maintenance 授权/单一路径在 R5 修订，等待 full-scope 重审 |
| 5 | R5 | `ses_091f49488ffeSOVX6m7fWFyzqV` | `BLOCK` | B-01 task status/restart recovery contract 在 R6 以持久 task record、独立 status route 和 resume contract 修订，等待 full-scope 重审 |
| 6 | R6 | `ses_091ee034cffeZDjOEbXXQv2Ufk` | `BLOCK` | B-01/B-02 shared maintenance owner、status/cleanup production contract 在 R7 以 `prepareMaintenance`/`maintain` 唯一 storage owner 修订，等待 full-scope 重审 |
| 7 | R7 | `ses_091e7d8acffebOo92xeq5rsFPI` | `BLOCK — exact revision R7 is not approved.` | B-01 info-only `findMessage` 无意义 thaw 与 B-02 maintenance 未占用 daemon active lifecycle；auditor 判定 plan-audit 上限已耗尽，转为用户 open decisions，禁止实施 |
| 8 | R8 | `ses_091d6013cffeNctH8T0QnVZzQg` | `BLOCK` | R7 blocker 已解决；B-01 验证命令误引不存在的 `test/session/projectors.test.ts`，R9 改为真实 `test/storage/cold.test.ts` owner，等待 full-scope 重审 |
| 9 | R9 | `ses_091d052adffe1A4vf3YnHMMBho` | `No blocking findings.` / `APPROVE` | exact R9 获得 full-scope plan approval，允许进入 TDD 实施 |

Independent R3 release verdict, recorded verbatim:

```text
No blocking findings.
APPROVE
```

R3 non-blocking record disposition（不改变 approved behavior）：

- I2 已与 §7.1 统一为精确的 owner-prefix byte hash 定义。
- cleanup 现为独立逻辑命令，只删除反算零 owner payload；`verify --repair` 负责计数一致性，`vacuum` 负责物理 page 回收，三者责任不重叠。
- `status` 的 owner 反算成本、生成后的真实 migration 目录名以及 Windows/Linux/macOS codec matrix 保留为实施验证项；不得在 implementation audit 中省略。

Independent R9 release verdict, recorded verbatim:

```text
No blocking findings.
APPROVE
```

## 16. R8 Pre-Audit Logic Check

按用户要求，在提交独立审计前先完成完整的非审计式逻辑核对：

1. `findMessage` 全部 7 个生产调用点已逐一检查：prompt 两处、Compaction、Goal HTTP resume、permission reviewer、Task、TaskStatus 的 predicate 都只读取 role/model/id 等 HotInfo；其中 prompt lastAssistant 与 TaskStatus 在匹配后消费 Parts，因此 R8 保持返回完整 `WithParts`，只改变定位阶段。
2. raw Message/Part DB consumers 已复核：`data-migration.ts` 只聚合 role/cost/tokens 热字段；`cli/cmd/import.ts` 只对新 row `onConflictDoNothing`，不会覆盖现有 cold owner；`src/v2/` 仍是明确非生产范围。没有发现需要第 23 个实施文件的 cold-field bypass。
3. worker shutdown 全链已检查：startup timer、regular idle timer、launcher watcher 都复用 `isActive()`；R8 将 maintenance lease 加入该唯一函数。显式 stop/SIGTERM/fatal shutdown 通过 AbortSignal 在 batch 边界 checkpoint interrupted 后再关闭 DB，不增加另一 shutdown 算法。
4. daemon/offline routing、task persistence、cleanup/status、codec、fork、update/delete、Compaction eligibility 和 direct reads 仍分别归属 R7 已定义的单一 owner；R8 没有新增 fallback、codec 或外部业务数据源。
5. 文件预算从 16 增至 22 的每个新增文件都对应真实 HotInfo caller；22 仍低于用户硬上限 32。当前无未映射 requirement、producer、consumer、test seam 或 open design decision。
6. R9 验证命令已逐项核对：`test/storage/db.test.ts`、`test/session/session.test.ts`、`test/session/messages-pagination.test.ts`、`test/session/compaction.test.ts` 和 `test/cli/tui/daemon.test.ts` 当前存在；`test/storage/cold.test.ts` 是 §8 明确计划新增的唯一新 test file；不再引用不存在的 projector test。

## 17. R9 Implementation Evidence

### 17.1 Implemented scope and paths

实现严格使用 §8 的 22-file mapping，没有增加第 23 个 production/test/migration 文件：16 个 production/schema owner、2 个 Drizzle generated migration artifacts、4 个批准 test files。核心行为如下：

- `src/storage/cold.ts` 是 canonical envelope、Unicode code-point key ordering、owner-prefix SHA-256、zstd level 3、4 KiB exact threshold、freeze/thaw/refcount、raw clone、verify/cleanup/status/expand 与 resumable maintenance 的唯一 owner。
- `session.sql.ts` 新增同库 `cold_storage`、两个 nullable `cold_ref` 和 indexes；`StoredInfoData`/`StoredPartData` 只放宽四类 cold field，不能静态冒充完整业务 `Info`/`Part`。
- `message-v2.ts`/`session.ts` 提供透明持久 thaw、page-bounded hydrate、HotInfo two-stage find、bounded previous-assistant tool tail、hot-only step-finish query 和 ID-only raw fork map；`limit: 0` 明确返回空范围。
- `projectors.ts` 统一 full replacement、Part/Message/Session release、raw fork clone、fork usage totals；没有 touched-field mask、hydrate-and-copy fallback 或 verify-as-normal-cleanup。
- `db.ts`、`worker.ts`、`server-lock.ts` 实现同一 `prepareMaintenance`/`maintain` 的 daemon/offline 路由、token-protected control、原子 task records、跨平台 `mkdir(lock)` lease、startup recovery、active lifecycle 和 explicit confirmation gates。
- 7 个 HotInfo caller 均只使用 role/model 等热 predicate；匹配后仍获得完整 `WithParts`，hidden Message/Part 可见性与旧路径一致。
- migration 由 Drizzle 生成到 `migration/20260717035626_cold_storage/`；未手写 generated snapshot。

### 17.2 TDD and self-review corrections

实施期间建立并运行的 red-capable signals 包括：HotInfo no-match 仍 thaw、raw fork target `session_id`/parent map、缺失 maintenance dispatcher、daemon JSON promise/response shape、forced-exit task recovery、near-threshold file envelope、fork usage totals、hidden bounded-history semantics、`limit: 0` 全量退化、task path/dbPath/cursor validation 和 canonical collision reuse。最终自查在送审前额外修正：

1. storage-private stored row type 与业务 decoder 边界，移除新增 unchecked casts/non-null assertions。
2. task/owner JSON runtime validation、safe task/token path characters、record root 与 embedded dbPath 一致性。
3. 新任务先 acquire lease、再写 queued、后执行 batch，消除 status 把启动中任务误判 interrupted 的窗口。
4. startup recovery 在启动 idle timer/launcher watcher 前 await 到 active registration，`isActive` 保持批准的精确三项。
5. SQL candidate 从 4096 降为保守 4032 bytes，最终 canonical envelope 仍 exact `>=4096`；行为测试覆盖 stored row 4095/envelope 4100 的反例。
6. raw fork 第一阶段只读取 ID/关系，完整 rows 只在 clone transaction 读取一次；clone 后由 projector 恢复 child Session usage totals。
7. retained payload 每次复用都比较 requested canonical bytes；同批 hash map 建立前拒绝不同 raw，不能用 digest/size 或缓存掩盖 collision。
8. bounded find/doom-loop 保留 hidden Message/Part 过滤；显式 zero limit 不查询 Message/Part。
9. `summary.diffs` 使用 Schema predicate 验证但不做有损 decode transform，expand 保留持久 JSON 的可枚举字段。
10. batch size 后端统一限制为 `1..5000`，避免 CASE/inArray 超 SQLite 变量上限或单事务 WAL 失控。

### 17.3 Verification results

所有命令 cwd 均为 `packages/opencode`，除明确标注 repository root 的 Git/format 检查：

| command | result |
|---|---|
| `bun test test/storage/cold.test.ts test/session/messages-pagination.test.ts test/session/compaction.test.ts test/cli/tui/daemon.test.ts --timeout 30000` | `158 pass, 0 fail, 560 expect()` |
| `bun test test/storage/db.test.ts test/session/session.test.ts test/storage/cold.test.ts --timeout 30000` | `21 pass, 0 fail, 126 expect()` |
| `bun test test/session/compaction.test.ts --timeout 20000` | `66 pass, 0 fail, 253 expect()` |
| `bun test test/cli/tui/daemon.test.ts --timeout 20000` | `22 pass, 0 fail, 62 expect()` |
| `bun typecheck` | pass, no diagnostics |
| `bunx prettier --check src/storage/cold.ts test/storage/cold.test.ts` | pass |
| approved-path `git diff --check` | pass |
| isolated temp DB `bun src/index.ts db status` | zero-owner status report succeeded |
| isolated temp DB `bun src/index.ts db expand --all` | exit 1 with `expand --all requires --yes` |
| isolated temp DB `bun src/index.ts db expand --all --yes --batch-size 10` | completed task, zero failures |

`bun run test` was also run package-wide with the repository-standard 30-second per-test timeout. The process reached the tool-level 30-minute command timeout before all 1292 discovered files completed. Before termination it recorded two failures: FileWatcher 5-second event wait and HTTP SDK promptAsync persistence wait. Each exact failing test was rerun alone and passed (`1 pass, 0 fail` each). No cold-storage test failed in that run. This remains a disclosed full-suite completion gap rather than being hidden or weakened.

`bun run build` was not run because `script/build.ts` unconditionally executes `script/generate.ts`, which overwrites the concurrently user-modified `packages/core/src/models-snapshot.js`; running it would violate the shared-worktree constraint. Package typecheck and all changed behavior suites passed, and migration loading was exercised by fresh/old copied DB runs.

### 17.4 Empirical performance, benefit, and reversibility

真实 implementation 在迁移后的本机 2.2 GB snapshot 上执行，不是纯推算：

| metric | measured result |
|---|---:|
| eligible/frozen owners | 33,851 |
| unique payloads | 27,258 |
| raw owner envelopes | 670,465,547 bytes |
| unique zstd payload | 262,921,898 bytes |
| shared logical bytes | 127,417,546 bytes |
| full compress task | 266.46 s (4.44 min) |
| full expand task | 75.58 s |
| pure canonicalize+zstd 740 MB | 16.68 s |
| migrated DB before physical reclaim | 2,218,065,920 bytes |
| DB after explicit VACUUM | 1,798,090,752 bytes |
| SQLite pages | 541,523 -> 438,987 |

最终 conservative SQL candidate 从 4096 改为 4032 后，在保留的只读 benchmark DB 上实测 candidate 增量仅为 Message `1744 -> 1750`、Part `73880 -> 74793`（总增量 919，约 1.2%），不改变 SQLite I/O 主导的分钟级结论。按用户后续“已释放临时文件、不要重复浪费”要求，没有再次复制/全量写入 2.2 GB snapshot。

同一全热副本在 compress -> expand 前后逐 row 流式 SHA-256 完全相同：

- Message rows `96,557`：`2b07b677fcc7e54942f23b8df9e04af45f57cf18df2061b5b7e896be8dc7169c`
- Part rows `435,771`：`9508e50bac8ed48608d46109670637b7abf5b1c160789f3e73a04c259b3a10c7`

该证据与测试中的每个 cold-field family、shared fork 独立 thaw、full replacement、corruption hard-fail、interrupted resume 和 explicit expand 联合证明零数据损失与可逆性。

### 17.5 Chinese explanatory comment gate

最终保守计数方法：tracked files 只统计 diff 中新增/实质修改的非空、非 import、非 comment code lines；两个全新手写文件统计全部非空、非 import、非 comment code lines；generated migration、canonical plan、空行和 import-only 排除。Prettier 纯换行本可排除，但下列保守值仍将其计入 `E`：

- tracked：`E=1361`、`C=210`
- `src/storage/cold.ts`：`E=1733`、`C=268`
- `test/storage/cold.test.ts`：`E=1112`、`C=154`
- total：`E=4206`、`C=632`（独立 auditor 计数为 `C=633`）
- required：`ceil(4206 * 0.15) = 631`

因此 primary self-count `C=632 >= 631`，独立 auditor count `C=633 >= 631`，无需依赖 formatter-only 排除即可通过。代表性注释分布在 canonical/hash、collision、threshold、stored/business type、thaw/refcount、fork/usage、HotInfo/hidden、task parser、lease/startup/shutdown、CLI confirmations、compact truth table 和每个行为测试附近。

### 17.6 Implementation audit handoff

当前 R9 implementation 已冻结为 `implementation-audit-required`。Primary agent 只向独立 auditor 发送原始需求、plan/R9、repository root、`Audit mode: implementation` 和 changed files/diff；不发送本节作为设计辩护或缩小审计范围。任何 blocking finding 都必须返工并重新 full-scope implementation audit。

本轮 audit 后的 repair evidence：

- auditor B-01 指出 `Session.remove()` 捕获 `SyncEvent.run(Session.Event.Deleted)` 的 cold corruption 并伪造成功；该 finding 属于 R9 已批准的 I3/I9 删除 hard-fail owner，不改变 schema、public contract、文件 mapping 或 primary route。
- 先在 `test/storage/cold.test.ts` 的公开 `Session.remove` seam 建立红测试：persisted `ref_count=99` 后删除必须失败，session 必须仍可读取；原实现确实返回 success。
- 最小修复移除 `Session.remove` 的 broad catch，保留缺少 instance context 的 best-effort 分支，但让 projector/ColdStorage error 传播；fixture 在断言后恢复 metadata 并删除 session，避免污染后续测试。
- Windows 实际 `EPERM` checkpoint race 在同一 owner `server-lock.ts:writeAtomic` 增加仅对 `EPERM/EACCES/EBUSY` 的 5 次 25ms retry；rename 仍是唯一原子发布，其他错误和耗尽仍失败。
- 修复后 cold corruption test、Session suite、daemon suite 和完整四文件 suite 均重新通过；没有添加 fallback 或 catch-and-success 路径。

## 18. Implementation Audit History

| round | approved revision | task | result | disposition |
|---:|---|---|---|---|
| 1 | R9 | `ses_08e9bacdcffeLbxRtfkRDH3DuG` | `BLOCK` | B-01：`Session.remove` 吞掉 cold corruption 并伪造成功；另记录 package-wide suite 未在该轮完整完成、Node/multi-OS adapter 未实测、plan metadata trailing whitespace 为 non-blocking |
| 2 | R9 | `ses_08e9bacdcffeLbxRtfkRDH3DuG` | `No blocking findings.` / `APPROVE` | Full-scope re-audit after B-01 repair; primary-path verdict PASS. Non-blocking: package-wide suite timeout gap, Linux/macOS matrix not run, plan metadata trailing whitespace |

Independent implementation release verdict, recorded verbatim:

```text
No blocking findings.
APPROVE
```

Audited revision: `R9`. Audit mode: `implementation`. Full-scope affected interface audit: completed. B-01 resolution: `Session.remove` no longer swallows projector/ColdStorage corruption; public deletion now fails and leaves the session intact when refcount corruption is present. The implementation is eligible for the target `verified-implementation-and-commit` terminal state.
