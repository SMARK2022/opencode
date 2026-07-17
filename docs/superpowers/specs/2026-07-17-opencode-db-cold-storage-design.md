# OpenCode DB 冷存储与读取时持久预热设计

> Status: aligned design, implementation authority: none
>
> Date: 2026-07-17
>
> Scope: `opencode.db` 字段级冷存储、读取时同步解冻、持久回填、daemon 维护任务、fork 内容共享
>
> No implementation in this document. Production source、migration、tests 和 DB 均不在本设计阶段修改。

## 1. 目标与边界

### 1.1 目标

在不改变前端现有 Session API 语义的前提下，降低 `opencode.db` 的长期空间增长：

- 主 `message`/`part` 表继续保存所有非冷字段，作为默认读取路径。
- 只新增一个 `cold_storage` 表，保存内容寻址、压缩后的冷 payload。
- 主表通过 `cold_ref` 指向冷 payload；不建立独立 hot 表。
- TUI 或其他显示调用读取冷范围时，由后端同步解冻本次请求范围，并持久回填主表。
- session 搜索永不触发冷数据解冻。
- fork 保持独立的 message/part ID；相同冷 payload 通过 hash 共享。
- `compact` 不默认触发冷冻。用户通过 `opencode db compress` 手动执行全库维护。
- 所有冷冻/解冻路径必须可恢复、可校验、可中断后继续。

### 1.2 非目标

- 第一版不统一 fork 后的 message ID 或 part ID。
- 第一版不实现 fork prefix 的 session 级引用化；只实现冷 payload 的内容共享。
- 第一版不建立持久化 hot cache 表、LRU 热缓存或 TTL 自动再冷冻。
- 第一版不把普通用户文本整体移出主表。
- 第一版不修改 `session/search.ts` 为冷表搜索；搜索只依赖主表保留的可定位字段。
- 第一版不在 `compact` 完成事件后默认写入大量冷数据。

## 2. 本机证据与策略选择

本机 DB 在调查过程中继续增长；本节以最近一次只读测量的约 `2095 MB` DB 为当前比例基准。

### 2.1 已验证的占用来源

- `part` 表是主要占用者，历史测量约占 DB 页面空间的 79%。
- tool parts、尤其是 `read` 的 `state.output`，是最大的可冷字段来源。
- message 内的 `summary.diffs` 是大型冷字段，且 snapshot 已经大范围被 GC 清理，不能依赖重算。
- session search 已在 `src/session/search.ts` 中明确排除 tool result、reasoning、metadata 和大段结果文本，只搜索文本、工具身份/输入、文件定位字段、patch 文件路径等。
- `Session.fork` 为 fork 创建新的 message/part ID，但 part data 的内容身份与实体 ID 分离，因此可以安全使用内容 hash 共享冷 payload。

### 2.2 实测方案比较

调查脚本在只读 DB 上对 JSON 字段做了全量解析、SHA-256 内容去重和 gzip 实验。

| 方案 | 候选范围 | 原始候选 | 占 DB | 去重+gzip | 理论节省 |
| --- | --- | ---: | ---: | ---: | ---: |
| A：冷字段白名单，compact 范围 | boundary 前的 tool output、附件、reasoning、summary.diffs | 373.98 MB | 17.85% | 144.78 MB | 229.19 MB / 10.94% |
| B：compact 范围整行 | boundary 前全部 message/part JSON | 755.59 MB | 36.07% | 282.34 MB | 473.25 MB / 22.59% |
| A：全库上界 | 全历史所有冷字段白名单 | 974.43 MB | 46.51% | 385.85 MB | 588.58 MB / 28.09% |

方案 B 还需要约 53.60 MB 搜索投影，且会把低收益的普通字段引入冷/热投影同步问题。第一版采用方案 A：空间收益较大，仍保持搜索和普通读取的主表契约。

## 3. 冷却资格与字段白名单

### 3.1 Eligible session 规则

无 session 参数的 `opencode db compress` 扫描所有 session。一个 session 满足以下任一条件即可进入冷冻候选：

```text
eligible = has_completed_compaction_boundary OR time_updated <= now - 30 days
```

两条规则是 OR 关系：

- 有 completed compact boundary 的 session：只冷冻 boundary 之前的冷字段。
- 超过 30 天的 session：冷冻整个 session 的冷字段白名单，不受 compact boundary 限制。
- 没有 boundary 且未超过 30 天：跳过。

“30 天全量”指全 session 的冷字段白名单，不是整行 message/part；普通文本、搜索投影和结构元数据仍留在主表。

### 3.2 completed compact boundary

边界沿用 `src/session/message-v2.ts` 的真实语义：

- user message 包含 compaction part；
- 存在同一 parent 的 assistant summary；
- assistant 有 `finish` 且没有 `error`；
- compaction part 的 `tail_start_id` 是保留可见 tail 的起点。

对于最新 completed boundary：

- `tail_start_id` 之后的 tail 保持热；
- compaction marker 保持热；
- 成功 summary assistant 保持热；
- boundary 之前只冷冻字段白名单；
- 不删除原始 message/part 行，不删除普通文本。

### 3.3 第一版冷字段

#### Message

冷冻：

- `message.data.summary.diffs`。

保留在主表：

- role、普通文本、时间、模型、parentID、summary 的 additions/deletions/files、hidden 等结构和可定位字段。

#### Tool part

冷冻：

- `state.output`；
- `state.attachments` 中大型 `data:` URI/base64 内容。

保留在主表：

- type、tool、callID；
- state.status、state.input、state.title、state.time；
- 不属于大型 data URI 的附件定位信息；
- search 需要的工具身份和输入字段。

#### File part

只冷冻 `data:<mime>;base64,...` 类型的 `url`。

保留在主表：

- mime、filename、source、file://、http(s):// 和其他定位信息。

#### Reasoning part

冷冻 `reasoning.text`。session search 当前明确不搜索 reasoning，因此不会破坏搜索契约。

#### 保持热的 Part 类型

第一版保持 `step-start`、`step-finish`、`patch` 的全部 data 热态：

- snapshot 继续直接供 `SessionSummary.computeDiff()` 和 revert 路径使用；
- patch.files 继续直接供 session search 使用；
- 这部分实现简单，牺牲少量压缩机会换取边界路径稳定性。

已被 `state.time.compacted` 标记的 tool output 仍纳入冷冻。它在模型 replay 中已经被 notice 替代，且 session search 排除 tool output；将其放入冷层不会改变 prompt 语义。

### 3.4 不创建小而亏损的冷 payload

冷字段聚合后，后端比较原始 JSON 大小与“压缩 payload + 主表指针 + cold 表索引”成本。若冷冻不能带来净节省，则保留热态并在 status 中计入 skipped-small；不使用固定阈值强行制造冷引用。

## 4. 物理数据模型

### 4.1 主表变化

`message` 和 `part` 各增加一个 nullable `cold_ref`：

```sql
ALTER TABLE message ADD COLUMN cold_ref TEXT;
ALTER TABLE part ADD COLUMN cold_ref TEXT;
```

约束：

- `cold_ref IS NULL`：该实体的冷字段已经在主 `data` 中，是热态。
- `cold_ref IS NOT NULL`：主 `data` 是热投影，冷字段在 `cold_storage` 的 hash payload 中。
- 主 `data` 始终保持合法 JSON 和现有 NOT NULL 约束。
- 不用 `'{}'` 替换整行 data；主表至少保留完整 type/role 和所有搜索/结构字段。

### 4.2 单一 `cold_storage` 表

```sql
CREATE TABLE cold_storage (
  hash TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  codec TEXT NOT NULL,
  payload BLOB NOT NULL,
  raw_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL,
  time_verified INTEGER
);

CREATE INDEX cold_storage_ref_count_idx
  ON cold_storage(ref_count);
```

`payload` 解压后是实体字段聚合对象，不含 message/part identity：

```json
{
  "formatVersion": 1,
  "kind": "part",
  "fields": {
    "state.output": "...",
    "state.attachments": []
  }
}
```

hash 计算对象为 canonical JSON 的原始字段聚合 payload，而不是 owner ID。这样：

- fork 拥有不同 message/part ID 仍可共享相同 payload；
- payload 不携带 session/message/part ID，不会因为 fork identity 不同而失去去重；
- 不需要改变当前 MessageID、PartID、assistant parentID 或 compaction tail_start_id。

### 4.3 引用计数

采用“事务维护 + 全量校验”：

- freeze 新增 owner 指针时，`ref_count + 1`；
- thaw 清除 owner 指针时，`ref_count - 1`；
- fork 复制冷 owner 时，复用 hash 并 `ref_count + 1`；
- message/part 删除时，事务内清理对应引用；
- `ref_count = 0` 的 payload 才允许删除；
- `opencode db verify` 从 `message.cold_ref` 和 `part.cold_ref` 全量反算并报告/修复不一致。

引用计数不是安全边界本身。真正的删除前检查必须再次确认主表没有任何引用，以防进程中断或旧版本写入造成计数漂移。

## 5. Fork 语义

### 5.1 第一版原则

- 保留现有 fork 产生独立 message/part ID 的行为；
- 不修改 parentID、tail_start_id 和公开 API identity；
- fork 的冷 owner 可以指向与源 owner 相同的 `cold_storage.hash`；
- 源 owner thaw 不影响 fork owner；fork owner thaw 不影响源 owner；
- 每个 owner 独立清除 `cold_ref`，payload 只有引用归零才删除。

### 5.2 为什么不统一 ID

当前 ID 不只是存储键，还参与：

- message/part API 定位；
- assistant parentID 关系；
- compaction tail_start_id 边界；
- revert、删除、事件和同步。

统一 fork ID 会把冷存储优化扩大成 session identity 重构，不属于本阶段必要工作。内容 hash 已经提供跨 fork 的聚合收益，足够解决冷 payload 的重复空间问题。

### 5.3 未来 fork prefix 汇聚的兼容点

未来若增加 fork prefix 引用，应新增 session-level immutable segment 引用，而不是复用或改写 message/part ID。冷 payload 的 hash owner 模型可以继续使用，不需要迁移 identity。

## 6. 后端读取与持久预热

### 6.1 Deep module 与 interface

新增一个后端内部 deep module，例如 `src/storage/cold.ts`，对外只暴露少量 interface：

```ts
type ReadIntent = "search" | "prompt" | "display" | "export" | "restore" | "maintenance"

interface ColdStorage {
  readRows(input: { rows: MessageRow[] | PartRow[]; intent: ReadIntent }): Effect.Effect<HydratedRows, ColdStorageError>
  freeze(input: FreezeScope): Effect.Effect<FreezeReport, ColdStorageError>
  expand(input: ExpandScope): Effect.Effect<ExpandReport, ColdStorageError>
  status(): Effect.Effect<ColdStatus>
  verify(input?: VerifyOptions): Effect.Effect<VerifyReport, ColdStorageError>
}
```

具体压缩、canonical JSON、gzip、hash、引用计数和 CAS 更新都隐藏在该 module implementation 中。

### 6.2 Read intent

前端 API 不增加 cold/hot 字段。后端根据调用路径选择 intent：

| intent | 是否解冻 | 范围 |
| --- | --- | --- |
| `search` | 否 | 只查询主表热投影；绝不 join/读取 cold_storage |
| `prompt` | 只解冻可见 tail | 不恢复 compact hidden head；只保证进入模型的 rows 完整 |
| `display` | 是 | 按 TUI 请求的 message range 解冻 |
| `export` | 是 | 解冻导出所需范围；全量导出显式承担 I/O |
| `restore` | 是 | 解冻恢复操作实际需要的范围 |
| `maintenance` | 由命令决定 | freeze/expand/verify 不走普通读取路径 |

### 6.3 同步解冻与持久回填

TUI 请求 200 条消息时：

1. 主表按现有分页/limit 查询 rows；
2. cold module 找出这 200 条对应的 `cold_ref`；
3. 在内存解压并校验 hash；
4. 合并 payload fields 与主表 hot projection；
5. 使用 `WHERE id = ? AND cold_ref = ?` 的 CAS 条件更新主表 data 并清除 `cold_ref`；
6. 同一事务减少 blob `ref_count`，归零时删除 blob；
7. 事务成功后返回完整 rows；
8. 并发请求失败 CAS 时，重新读取主表热 row，不重复解压/扣减。

解冻是持久的：没有 TTL、LRU 或自动再冷冻。再次冷冻只由下一次显式 `opencode db compress` 执行。

### 6.4 错误语义

冷 payload 缺失、codec 不支持、hash 不匹配或 JSON 恢复失败时：

- 返回 typed `ColdStorageError`；
- 不删除 `cold_ref`；
- 不删除损坏 payload；
- 保留主表热投影，便于诊断；
- `db verify` 报告具体 owner、hash、codec 和失败原因。

禁止静默返回不完整历史，避免用户把降级投影误认为完整消息。

## 7. 代码 seam 与调用路径

### 7.1 数据 schema

- `packages/opencode/src/session/session.sql.ts`
  - `MessageTable` 增加 `cold_ref`；
  - `PartTable` 增加 `cold_ref`；
  - 新增 `ColdStorageTable` 或由独立 `src/storage/cold.sql.ts` 定义并由 schema 入口导出。
- 迁移只新增一张表和两个 nullable 主表列，不改变现有 data NOT NULL 约束。

### 7.2 读取 seam

- `packages/opencode/src/session/message-v2.ts:732-745`
  - `info()`、`part()` 不直接各自实现压缩逻辑；
  - 在 `hydrate()` 以及 `parts()`/`get()` 的 row-to-model 前调用 cold module 的 `readRows`，保证所有 direct read path 一致。
- `packages/opencode/src/session/message-v2.ts:750-774`
  - `hydrate()` 是批量读取的主要 seam，支持一次查询多个 cold hash，避免逐行查询。
- `packages/opencode/src/session/session.ts:822-841`
  - `messages()` 根据 display/prompt intent 读取；
  - prompt 路径先应用现有 `filterCompacted` 可见窗口，再请求冷字段。
- `packages/opencode/src/session/search.ts`
  - 保持 SQL 主表搜索；不得调用 cold module；不得触发解冻。

### 7.3 写入 seam

- `packages/opencode/src/session/projectors.ts`
  - `MessageV2.Event.Updated` 和 `PartUpdated` 的 upsert 必须清除 `cold_ref`，因为任何 durable update 都以新的热 data 为准；
  - 清除引用和 `ref_count` 递减必须与 projector 写入在同一事务内完成。
- `packages/opencode/src/session/compaction.ts`
  - 继续生成和维护 completed boundary；默认不调用 freeze；
  - `state.time.compacted` 的工具输出在后续手动 compress 中按范围纳入冷字段。
- `packages/opencode/src/session/summary.ts`
  - summary.diffs 仍按现有路径生成；compress 只在维护任务中把它提取到 cold payload。

## 8. Daemon、CLI 与前后端隔离

### 8.1 实际写入者

daemon 是唯一长期运行的数据库写入 owner。`opencode db compress/expand/vacuum` 作为维护任务客户端：

- daemon 内的 cold module 执行实际 DB 写入；
- CLI 不直接与正在运行的 daemon 争夺 SQLite writer；
- daemon 不可用时，CLI 启动同一维护 implementation 的单进程模式，并获取全局 maintenance lock；
- `db query` 继续保持现有只读行为，不进入冷存储业务路径。

### 8.2 HTTP/API 约束

- 普通 session/message API 的 response schema 不增加冷状态字段；
- 后端在 handler/service 内完成 read intent、hydrate 和回填；
- 维护命令的进度通过 CLI/status 返回，不推入 TUI 的普通 session 事件；
- 如需 daemon 控制端点，应在 `server/routes/instance/httpapi/groups/` 新增数据库维护 group，handler 只调用 cold module，不把 HttpApi 类型泄漏到 storage module。

### 8.3 CLI

基于现有 `packages/opencode/src/cli/cmd/db.ts`：

```text
opencode db compress [--session <id>] [--dry-run] [--verify]
opencode db expand [--session <id>] [--all]
opencode db status
opencode db verify [--repair-ref-count]
opencode db vacuum [--incremental]
opencode db path
opencode db migrate
```

语义：

- `db compress` 无 session：全库扫描所有 eligible session，按 boundary OR 30-day 规则处理；
- `db compress --session`：只处理指定 session；
- `db compress --dry-run`：只计算候选行、原始大小、压缩估计和可节省空间；
- `db expand --session`：同步展开指定 session 全部 cold owner；
- `db expand --all`：全库展开，需要显式确认；无 `--all` 不允许无 session 全量展开；
- `db status`：显示冷 owner 数量、唯一 blob 数量、raw/compressed bytes、ref_count、eligible/skip 原因、最近任务；
- `db verify`：校验 hash、codec、JSON、owner 引用和 ref_count；
- `db vacuum`：先 checkpoint，再执行维护；必须处理 daemon lock 和活动 writer。

### 8.4 后台分批与可恢复

- 以固定小批量处理 owner，例如每批 100 行；
- 每批独立事务；
- 每行根据 `cold_ref IS NULL` 和 eligibility 决定是否跳过；
- 中断后重新运行不会重复生成 blob，不会重复增加 ref_count；
- 写入前先确保 payload hash 行存在，owner 指针最后提交；
- 不引入长期任务表，除非实际 daemon 生命周期证明仅靠扫描无法恢复；status 可以从主表和 cold_storage 推导当前状态。

## 9. 数据一致性与恢复

### 9.1 Freeze 原子顺序

1. 读主 row，确认 owner 当前 `cold_ref IS NULL`；
2. 提取冷字段，生成 hot projection 和 canonical payload；
3. 写入或复用 `cold_storage(hash)`；
4. 更新主 row data + `cold_ref`；
5. `ref_count + 1`；
6. 提交事务。

失败时整个 owner 不改变；已存在的 orphan blob由 verify/status 清理流程处理。

### 9.2 Thaw 原子顺序

1. 读取 owner 的 `cold_ref`；
2. 读取 payload 并校验 hash；
3. 合并回原始 data；
4. CAS 更新主 row，清除 `cold_ref`；
5. `ref_count - 1`；
6. 引用归零时删除 payload；
7. 提交事务。

### 9.3 备份与校验

- 第一次实际 compress 前提示并生成 DB 备份；
- `verify` 不依赖备份才能工作；
- hash 校验保护内容一致性，ref_count 全量反算保护引用一致性；
- 数据损坏时保留引用和主表投影，不自动销毁证据。

## 10. 测试策略

### 10.1 冷字段恢复

- 对实际 message/part 样本 freeze → thaw；
- 比较 freeze 前后完整 canonical JSON SHA-256；
- 覆盖空 attachments、非 data URI 附件、多字段 payload、summary.diffs 空数组和超大 diff。

### 10.2 Read intent

- `search` 对含 cold_ref 的 session 不访问 cold_storage；
- `prompt` 不恢复 compact hidden head，只恢复可见 tail 内命中的冷字段；
- `display` 只恢复请求的 message range；
- `export/restore` 按显式范围恢复。

### 10.3 Fork

- fork owner 使用独立 message/part ID；
- 相同 payload hash 只有一个 cold_storage 行；
- 源 owner thaw 不改变 fork owner；
- fork owner thaw 不改变源 owner；
- 引用归零后才删除 payload。

### 10.4 并发与恢复

- 两个请求同时 thaw 同一 owner，只有一个 CAS 成功；
- 两个不同 owner 同时 thaw 同一 hash，ref_count 正确减二；
- freeze/expand 中断后可重跑；
- payload 损坏返回 typed error，verify 能定位；
- projector 更新冷 owner 时清除 stale cold_ref。

### 10.5 CLI/daemon

- `db compress --dry-run` 与实际候选一致；
- 全库 compress 扫描 30 天 OR boundary 规则；
- `db expand --all` 没有确认不能执行；
- daemon 运行期间 CLI 不直接抢 SQLite writer；
- daemon 重启后维护任务可继续；
- API response schema 与现有前端保持兼容。

## 11. 实施顺序

1. 先实现 cold schema、canonical payload、hash/gzip、verify 和只读 status。
2. 接入 `hydrate` seam，先只支持 display/prompt，保证 cold_ref 不会进入模型上下文。
3. 接入 projector stale-ref 清理和 owner 级 CAS thaw。
4. 实现手动 `db compress`，先支持指定 session，再支持全库扫描。
5. 实现 `db expand`、`db verify`、ref_count 修复和全量确认。
6. 最后接入 daemon maintenance owner 和 CLI 客户端路径。
7. 在全部 round-trip、search isolation、fork sharing 和中断恢复测试通过后，才允许对真实 DB 执行实际 compress。

## 12. 当前结论

第一版采用字段级冷存储，而不是整行冷冻：

- 结构简单：一张 `cold_storage` 表 + 主表 `cold_ref`；
- 搜索稳定：普通文本、工具输入和路径继续留在主表；
- 前端隔离：前端不理解 cold/hot，后端按 intent 处理；
- 预热持久：读取指定范围后直接回填主表，不再重复解压；
- fork 安全：ID 独立、payload hash 共享、owner 独立解冻；
- compact 安全：marker、summary、tail 保持热，boundary 前冷字段按需恢复；
- 全库能力：`opencode db compress` 扫描所有 eligible session，`opencode db expand --all` 支持显式全量展开；
- 可逆性：hash、事务、引用计数、verify 和错误保留共同保证不静默丢失数据。

该文档只记录设计，不授权实现。实现前仍需将本设计转化为 canonical implementation plan，并完成独立审计。

## 13. Grilling Decision Log

以下决策来自本次 grilling，对后续 canonical plan 具有约束力：

| 决策 | 已确认内容 |
| --- | --- |
| 冷表拓扑 | 同一个 `opencode.db` 内只新增一张 `cold_storage` 表；不建立 hot 表，不使用独立 cold.db 或文件归档。 |
| 主表引用 | `message`/`part` 增加 `cold_ref`；主表继续保存热投影。 |
| Payload 粒度 | 同一个 message/part 的冷字段聚合成一个 payload；hash 不包含 owner ID。 |
| Fork identity | message/part ID 保持独立；fork owner 可以共享同一 hash；各 owner 独立 thaw。 |
| 引用计数 | freeze/thaw/fork/delete 在事务内维护 `ref_count`；verify 全量反算并报告或修复。 |
| 冷字段 | `summary.diffs`、tool output、reasoning text、大型 data URI/base64；普通文本和搜索投影保持热。 |
| Step 元数据 | 第一版保持 step-start/step-finish/patch 热态。 |
| Compact 内容 | marker、summary assistant、tail 保持热；boundary 前冷字段按白名单冷冻；已 `state.time.compacted` 的 tool output 可冷冻。 |
| Eligibility | `completed boundary OR time_updated >= 30 days old`；30 天规则冷冻整个 session 的冷字段白名单，不冷冻普通文本。 |
| Thaw | TUI display 按请求范围同步 thaw，成功后持久回填主表；无 TTL、LRU 或自动再冷冻。 |
| Search | session search 只查主表热投影，永不触发 cold_storage 解冻。 |
| Maintenance owner | daemon 是长期 DB 写入 owner；CLI `opencode db` 作为维护任务客户端；daemon 不可用时使用同一 implementation 的单进程锁定模式。 |
| CLI | 使用现有 `opencode db` 命令组：compress、expand、status、verify、vacuum、path、migrate。 |
| Compress | 无 session 时全库扫描 eligible session；后台小批量、可恢复；默认不与 compact 自动联动。 |
| Expand | 指定 session 可直接执行；全量展开必须显式 `--all` 或确认。 |
| API | 前端不接收 cold/hot 状态；普通 Session API 保持透明，维护状态只经 status/CLI。 |
| Error | cold payload 缺失、hash 不匹配或解压失败时返回 typed error，保留引用和诊断证据，不静默降级成功。 |

## 14. Cross-Platform Codec Decision

本机 Windows + Bun `1.3.14` 只读运行时探针已经确认：

```text
Bun.zstdCompressSync: function
Bun.zstdDecompressSync: function
round-trip: passed
```

因此压缩 codec 采用：

- 新写入默认 `zstd`，初始 level 3；
- `cold_storage.codec` 必须持久化为 `zstd` 或 `gzip`，读取按 codec dispatch，不依赖“解压失败后换算法”；
- 旧 gzip payload 保持可读取；
- 不引入 Rust sidecar、Rust N-API addon 或 WASM 作为默认实现，避免 Windows/Linux/macOS 预编译资产和启动/内存复制差异；
- codec adapter 的唯一接口隐藏 Bun API，未来 Node/其他 runtime 若需要，只增加明确 adapter，不改变数据库 payload 契约；
- 真实 OpenCode payload 的 zstd level 1/3/8 必须在实现前以 `db --dry-run`/离线 benchmark 比较，不能直接把公开 benchmark 当作收益证明。
