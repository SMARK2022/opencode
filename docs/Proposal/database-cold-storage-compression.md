# OpenCode 数据库可逆冷热存储压缩提案

Date: 2026-07-12

Status: proposal, independently audited; round 5 has no blocking findings

Audit: 2026-07-12 两位独立 subagent 按完整原范围复核当前方案，均明确返回 `NO BLOCKING FINDINGS`。保留的意见仅是实现期错误分类、CLI 输出区分和 codec crossover 测试精度，不改变本文行为规范或文件范围。

Scope: `packages/opencode` 当前默认使用的 legacy `message` / `part` 持久化链。本文只提出方案，不包含生产实现、数据库迁移执行或现有数据改写。

## 1. 结论摘要

当前 `opencode.db` 的主要可优化空间并不是 Session 行本身，而是 Message 和 Part JSON 中的大型非检索叶子：Tool output、`message.summary.diffs`、Reasoning、图片 data URL、Provider metadata 和少量错误正文。

推荐方案是在现有 JSON 行内部只替换这些明确允许的叶子，并把原值写入同一个 SQLite 数据库中的不可变 BLOB artifact：

1. 可检索字段、结构字段、计费字段和时间字段继续原样保存在 `message.data` / `part.data`。
2. 只有显式 allowlist 中、原始字节数严格大于 4 KiB 的非检索叶子可以进入冷存储。
3. JSON 中使用小型 marker 保留原位置；marker 只有在存在精确 owner/field/hash 引用时才具有存储语义。
4. 用户显式调用 `opencode db storage compress` 才会冷冻数据；正常新写入始终保持热态。
5. Session list 搜索和 preview 继续直接查询热 JSON，不触发解压，也不会失去 compacted 历史。
6. 任意正常 domain read 第一次读到冷字段时，先完整校验、解压，再以 compare-and-swap 持久化写回原行并删除引用；以后读取保持原性能。
7. `expand` 可以完整恢复所有冷字段，恢复后旧版本 OpenCode 可重新读取数据库。
8. Fork 不采用脆弱的 parent-prefix 指针；相同冷叶子通过内容哈希自然去重，父 Session、子 Session 和多个 Fork 仍可独立修改、删除或回退。

这个方案把复杂性集中在一个 package 内部的深模块中。调用方只需要在 legacy row-to-domain seam 调用统一 resolver，搜索、Provider、TUI、export、share、fork、revert、summary 和 compaction 不需要理解 marker、BLOB、gzip 或 CAS。

## 2. 目标和非目标

### 2.1 目标

- 在不降低 Message 信息量的前提下缩小数据库的逻辑内容和物理页占用。
- 对图片、Tool、Reasoning、summary diff 等所有已确认安全的高价值内容统一处理，不做图片专项设计。
- 保持 completed compaction 之前的可检索历史参与 Session list 搜索。
- 使压缩和展开可逆，并允许用户显式控制生命周期。
- 第一次正常读取后自动持久化回热，避免每次 prompt 都重复解压和再压缩。
- 让 Fork 的相同冷叶子自然去重，同时保持各 Session 的生命周期独立。
- 尽量不修改现有 schema，不重写搜索 SQL，不引入后台状态机或新配置。
- 压缩、回热、正常更新、并发删除和 GC 都不能产生 marker 泄漏或数据丢失。

### 2.2 非目标

- 不把整个 Message、Part、Session 或 compaction 前缀压成一个不可查询的 BLOB。
- 不把 child Session 改成运行时依赖 parent Session 行的 copy-on-write 前缀链。
- 不修改 `Session.list({ search })` 的索引语义或引入 FTS。
- 不改变现有 compaction、Provider、Tool、export、share、revert 或 Git snapshot 领域语义。
- 不在正常写入时自动压缩，也不增加后台 daemon 压缩任务。
- 本阶段不压缩实验性 `session_message.data` 或可选的 retained `event.data`。
- 不使用 `Image.normalize()`；它可能 resize 或重新编码，不符合字节级可逆要求。
- 不承诺压缩后主数据库文件立即变小；SQLite 页回收由单独的 `vacuum` 操作负责。

## 3. 已完成的调研

### 3.1 已阅读的源码

| 文件 | 相关性和确认结果 |
| --- | --- |
| `packages/opencode/src/session/session.sql.ts` | `message.data`、`part.data`、`session_message.data` 都是 SQLite JSON text；Message 删除 cascade Part，Part 的 `session_id` 没有 FK |
| `packages/opencode/src/session/message-v2.ts` | legacy Message/Part 全部 schema、row hydration、page/get/parts、provider conversion 和 compaction filtering 的权威实现 |
| `packages/opencode/src/session/session.ts` | `Session.getPart()` 是独立 Part 读取 seam；`messages()`、`findMessage()`、`fork()` 的调用链 |
| `packages/opencode/src/session/search.ts` | legacy 和 v2 Session list 的直接 SQL 搜索白名单；搜索不经过 Message hydration |
| `packages/opencode/src/session/projectors.ts` | legacy Message/Part 正常 upsert/remove 的主要写入链；运行在 SyncEvent transaction 内 |
| `packages/opencode/src/session/projectors-next.ts` | `session_message` 的实验性投影；确认它是另一套存储和读取链，不应在小补丁中半接入 |
| `packages/opencode/src/session/prompt.ts` | 图片 normalize/save、legacy 历史读取、v2 dual-write 和 prompt compaction 调用顺序 |
| `packages/opencode/src/session/summary.ts` | summary 会消费 Message diff、Tool metadata 和 hydrated Parts |
| `packages/opencode/src/session/revert.ts` | revert 会读取 snapshot、patch 和 Tool metadata，必须看到完整 domain 值 |
| `packages/opencode/src/session/compaction.ts` | compaction 消费 Reasoning、Tool evidence 和 metadata；不应直接看到 marker |
| `packages/opencode/src/session/message-error.ts` | Assistant shared error 变体 |
| `packages/core/src/util/error.ts` | `NamedError` 的持久化形状是 `{ name, data }`，所以精确路径是 `error.data.*` |
| `packages/core/src/session-message.ts` | 实验性 v2 User/Shell/Assistant/Compaction schema 和搜索字段 |
| `packages/opencode/src/image/image.ts` | 现有图片处理可能 resize/re-encode，只能用于上传规范化，不能用于可逆存储 codec |
| `packages/opencode/src/config/attachment.ts` | 图片输入大小和 resize 配置；不应复用为数据库压缩配置 |
| `packages/opencode/src/storage/db.ts` | WAL、30 秒 busy timeout、`BEGIN IMMEDIATE` 和 transaction 复用行为 |
| `packages/opencode/src/sync/index.ts` | projector 和可选 EventTable 持久化位于同一 immediate transaction；event 持久化发生在 projector 之后 |
| `packages/opencode/src/sync/event.sql.ts` | retained event schema 为 `aggregate_id`、`seq`、`type`、`data` |
| `packages/opencode/src/event-v2-bridge.ts` | v2 event 通过 legacy SyncEvent bridge 投影；不应通过 EventTable 是否存在判断 Session 类型 |
| `packages/opencode/src/cli/cmd/db.ts` | 已有 DB maintenance 命令 seam，适合增加 `db storage`，无需新增顶层命令或全局配置 |
| `packages/opencode/src/cli/cmd/import.ts` | import 对 Message/Part 使用 `onConflictDoNothing()`；新行热写，冲突不会覆盖冷行 |
| `packages/opencode/src/cli/cmd/export.ts` | export 应消费 hydrated domain 值，不能导出内部 marker |
| `packages/opencode/src/share/share-next.ts` | share 订阅 domain event；representation-only 回热不应发布 Message/Part update |
| `packages/opencode/src/data-migration.ts` | 直接用 `json_extract` 读取 Message usage；计费字段必须始终保持热态 |
| `packages/opencode/src/data-migration.sql.ts` | 现有 data migration 表只记录任务状态，不适合承载 artifact |
| `packages/opencode/drizzle.config.ts` | `src/**/*.sql.ts` 都会参与 migration 生成 |

### 3.2 已阅读的测试和文档

| 文件 | 相关性和测试缺口 |
| --- | --- |
| `packages/opencode/test/server/session-list.test.ts` | 已有 legacy/v2 search 测试，但没有“completed compaction 旧历史冷冻后仍可检索”的回归 |
| `packages/opencode/test/server/session-preview.test.ts` | preview 直接读取 visible text；需要验证不会触发回热 |
| `packages/opencode/test/session/messages-pagination.test.ts` | 覆盖 page/get/parts 等 legacy 读取路径，适合增加 persistent warming 测试 |
| `packages/opencode/test/session/message-v2.test.ts` | 覆盖 provider conversion 和 `filterCompacted`；适合验证 domain 层永远看不到 marker |
| `packages/opencode/test/session/compaction.test.ts` | 适合验证冷 Tool/Reasoning 在 compaction 中仍完整 |
| `packages/opencode/test/session/session.test.ts` | 适合验证 projector upsert 清 ref、回热不发 domain event |
| `packages/opencode/test/storage/goal-migration.test.ts` | additive migration 测试组织范例 |
| `packages/opencode/test/storage/db.test.ts` | 当前只覆盖 DB path/runtime flags，不覆盖 maintenance transaction |
| `packages/opencode/test/image/image.test.ts` | 证明 normalize 语义；存储 codec 应单独测试，不能复用有损路径 |
| `packages/opencode/test/acp/event-subscription.test.ts` | ACP 需要收到原始图片 data URL，要求 hydration 保持字节级结果 |
| `AGENTS.md`、`packages/opencode/AGENTS.md` | migration、测试目录、Effect、模块形状和最小修改约束 |

### 3.3 搜索确认的调用点和旧逻辑

全仓搜索确认：

1. `PartTable` 主要写入点只有 legacy projector 和 import。
2. `MessageTable` 主要写入点同样集中于 projector 和 import；JSON migration 只负责旧存储导入。
3. `PartTable` 的 domain 读取集中在 `MessageV2.page/get/parts()` 与 `Session.getPart()`。
4. `Session.messages()` 和 `findMessage()` 最终委托 MessageV2 读取，不需要第二套 resolver。
5. search 和 preview 直接执行 SQL JSON 查询，不能强制经过 domain hydration。
6. Provider、TUI、export、share、fork、revert、summary 和 compaction 都消费 domain Message/Part；只要 row-to-domain seam 完整，它们无需修改。
7. legacy projector 在 SyncEvent 的 immediate transaction 中同步执行；ref 清理可以和 owner upsert 保持原子。
8. EventTable 只在 `experimentalWorkspaces` 下保留事件；不能用 generic event existence 判定 v2 Session。
9. `session_message` 是单独的实验性投影，不是 legacy row 的 artifact 索引。
10. SQLite 当前使用 WAL，但 `auto_vacuum=0`；逻辑压缩不会自动整理主文件页。

### 3.4 当前数据库空间分布

以下统计均来自对 `$HOME/.local/share/opencode/opencode.db` 的只读 SQLite 查询：

| 内容 | 逻辑字节 |
| --- | ---: |
| Tool `state.output` | 154,211,956 |
| Message `summary.diffs` | 91,415,147 |
| Reasoning text | 28,580,252 |
| File data URL / URL | 24,328,690 |
| Step start/finish 行合计 | 21,242,385 |
| Tool searchable `state.input` | 18,684,865 |
| Text metadata | 446,775 |
| Tool `state.error` | 261,927 |
| File source text | 360 |

按 Part 类型观察：

| Part 类型 | JSON 总量 | 大于等于 4 KiB 的大行总量 |
| --- | ---: | ---: |
| tool | 268,900,836 | 214,393,784 |
| reasoning | 63,638,288 | 40,648,405 |
| text | 50,390,141 | 44,691,660 |
| file | 24,335,180 | 主要是 data URL |

Text 需要进一步按检索语义拆分：

| Text 类别 | 行数 | text 字节 |
| --- | ---: | ---: |
| visible、可检索 | 14,879 | 45,860,691 |
| synthetic / ignored / hidden、不可检索 | 559 | 1,615,028 |

其他精确字段测量：

| 字段 | 行数 | 字节 |
| --- | ---: | ---: |
| user `system` | 0 | 0 |
| user `tools` | 473 | 7,900 |
| user `format.schema` | 0 | 0 |
| user summary title/body | 2,421 | 0 |
| assistant `structured` | 0 | 0 |
| assistant error message | 497 | 7,417 |
| assistant response body | 55 | 12,512 |
| retry error payload | 0 | 0 |

这些低占比字段仍可进入同一个字段矩阵，但 4 KiB 阈值会使当前绝大部分值继续 inline，不值得为它们增加专用 schema 或命令。

`session_message` 当前只有 640 行、60,881 bytes，未发现图片；`event` 当前为 0 行。它们不是当前数据库膨胀的主要来源。

### 3.5 图片压缩实测

当前 DB 有 40 个 top-level image FilePart：

| 表示 | 字节 | 相对原始 inline URL |
| --- | ---: | ---: |
| 原始 data URL | 24,328,608 | 基准 |
| base64 解码后二进制 | 18,245,765 | -25.0% |
| 二进制 gzip level 1 BLOB | 16,302,230 | -33.0% |
| gzip 后再 base64 放回 JSON | 21,737,436 | 仅 -10.6% |
| gzip 整个 URL 后再 base64 | 28,582,508 | +17.5% |

结论是：把压缩 bytes 再 base64 放回 JSON 不能获得理想收益，有时反而膨胀。图片必须进入 SQLite BLOB，且保留原始 data URL prefix，才能同时去掉 base64 膨胀并做到字节级恢复。

## 4. 必须保持的既有行为

### 4.1 搜索不变量

legacy Session list 当前直接搜索以下路径，这些路径必须始终是普通 JSON：

- visible `text.text`；
- Tool 名称、`state.title`、`state.input`、合法 JSON `state.raw`；
- File/Agent 的 filename、name、source path、URI、symbol name、client name；
- Subtask description、prompt、agent、command；
- Patch files。

Reasoning、Tool output/error/metadata、图片 data URL bytes 和 Message summary diff 当前不参与 legacy 搜索。

search SQL 没有调用 `filterCompacted()`，因此 completed compaction 之前的旧 Message/Part 本来就参与检索。本方案不得用删除旧行、whole-row BLOB 或 parent-prefix 指针破坏该行为。

### 4.2 Domain 完整性不变量

- 正常读取返回的 Message/Part 必须通过现有 Schema decode。
- Provider、TUI、export、share、fork、revert、summary 和 compaction 不得看到 storage marker。
- 图片 URL、Tool output、Reasoning、metadata、summary diff 展开后必须与压缩前 domain 值一致。
- 回热只改变存储表示，不发布 domain event，不更新 Session/Message/Part timestamps。
- 新写入、import 和 event replay 仍然写普通热 JSON。
- 正常 upsert 可以自然覆盖冷行，但不能留下指向旧 artifact 的有效 ref。
- 删除 owner 后 artifact 不能立即丢失；只有显式 GC 才能回收孤儿引用和 BLOB。

### 4.3 Fork 独立性不变量

- Parent 后续修改或删除不能改变已存在 child 的内容。
- Child 的 revert、修改、删除不能影响 parent 或 sibling fork。
- 相同数据可以共享不可变 artifact，但不能共享可变 Message/Part owner。
- Fork 第一次读取 source Session 会按产品要求使 source 回热；fork clone 自身以普通热 JSON 写入。

## 5. 推荐模块和 seam

新增 package 内部模块：

```text
packages/opencode/src/session/cold-artifact.ts
```

它是一个深模块，隐藏以下实现：

- 闭合字段矩阵；
- marker 编码和 ref 授权；
- artifact 哈希、gzip 和 data URL codec；
- 批量 artifact 获取和校验；
- exact raw-text CAS；
- 首次读取持久化回热；
- status/compress/expand/verify/gc maintenance；
- typed storage errors。

调用方只需要少量 package 内部 interface：

```ts
resolveMessageRows(rows)
resolvePartRows(rows)
clearOwnerRefs(tx, owner)
maintain(action, options)
```

这不是 HTTP、SDK 或 plugin 公共接口。marker、field ID、artifact schema 和 codec 都不能泄漏到 domain MessageV2 类型。

`MessageV2.parts()` 当前同步返回，resolver 必须保留同步形状。SQLite、hash、gzip 和 transaction 均可同步执行；page/get 等 Effect seam 只需把 typed error 映射到现有错误通道，不需要把整个调用图改成异步。

## 6. 最小 additive schema

### 6.1 Artifact 表

概念 schema：

```sql
CREATE TABLE cold_artifact (
  hash TEXT PRIMARY KEY NOT NULL,
  format INTEGER NOT NULL,
  kind TEXT NOT NULL,
  codec TEXT NOT NULL,
  raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
  data BLOB NOT NULL,
  CHECK (format = 1),
  CHECK (kind IN ('utf8', 'json', 'data-url')),
  CHECK (codec IN ('identity', 'gzip', 'data-url', 'data-url-gzip'))
);
```

`hash` 的 lowercase 64-hex 约束由 artifact 模块验证，不在 SQL 中重复复杂字符串 CHECK；migration 测试验证模块拒绝非法 hash。

### 6.2 Artifact ref 表

```sql
CREATE TABLE cold_artifact_ref (
  owner_type TEXT NOT NULL CHECK (owner_type IN ('message', 'part')),
  owner_id TEXT NOT NULL,
  field TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES cold_artifact(hash) ON DELETE RESTRICT,
  PRIMARY KEY (owner_type, owner_id, field)
);

CREATE INDEX cold_artifact_ref_hash_idx
ON cold_artifact_ref(hash);
```

`field` 不是自由 JSONPath，而是代码中的闭合稳定标识，例如：

```text
message.user.summary.diffs
part.reasoning.text
part.tool.completed.output
part.file.url
```

模块根据 owner discriminator 和 field ID 使用显式 getter/setter。这样不需要通用 JSONPath parser，也不会因为任意 metadata 中出现同名属性而误解码。

generic ref 无法同时对 MessageTable 和 PartTable 声明一个传统 FK。本方案有意不增加 polymorphic trigger 或两套重复 ref 表；owner 删除后的 ref 由 verify/gc 处理。

### 6.3 Marker

冷叶子替换为精确对象：

```json
{
  "$opencode_cold": {
    "format": 1,
    "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

只有同时满足以下条件才是 storage marker：

1. owner 类型和 ID 精确匹配；
2. field 是当前 owner discriminator 允许的闭合 field ID；
3. marker 外层和内层对象形状精确且没有额外 key；
4. format 和 hash 合法；
5. ref 表存在完全匹配的 `(owner_type, owner_id, field, hash)`。

只有 hash 相同、只有 marker 外形相同或只有 artifact 存在都不足以授权解码。没有 ref 的 marker-shaped `Schema.Any` 对象仍是普通用户数据。

正常 domain read 与 destructive maintenance 必须采用不同的保守规则：

- 正常 domain read 仍然只有在 ref 完整匹配时解码；无 ref 对象必须作为用户数据返回，避免 marker 碰撞改变合法内容。
- `status`、`verify`、`expand`、downgrade 判定和 `gc` 必须额外扫描所有 allowlisted owner/field。只要该位置出现精确 marker 外形但没有匹配 ref，就记为 **ambiguous marker candidate**。
- Ambiguous candidate 可能是用户有意保存的普通对象，也可能是真实冷 marker 丢失了 ref。系统无法安全区分两者，因此 maintenance 只能 fail closed，不能猜测或删除。
- `verify` 报告 owner/field/hash 和 ambiguous 类别；不输出字段内容。
- `expand` 在写入 selected scope 前完成预检；scope 内存在 ambiguous candidate 时零修改并拒绝报告 downgrade-safe。
- `gc` 在任何删除前完成全库预检；存在 ambiguous candidate 时零修改，并保留 candidate 所命名 hash 的任何 artifact。
- `compress` 遇到 ambiguous candidate 时跳过该 owner并报告，不把该对象改写成另一个 artifact。

这是 maintenance 层的保守安全门，不改变正常读取的碰撞语义。合法用户对象可能因此阻止 full downgrade/GC，用户需要先通过正常领域操作改写该值；相比误删原 artifact，这是可接受的安全误报。

## 7. 精确字段矩阵

共同规则：只有下表明确列出的叶子、满足对应 discriminator、原始 artifact bytes 严格大于 4096 时才可冷冻。4096 bytes 本身保持 inline。未列出的字段一律保持 inline。

### 7.1 Message 字段

| owner | field ID | JSON 位置 | kind | 条件 |
| --- | --- | --- | --- | --- |
| user | `message.user.summary.title` | `summary.title` | utf8 | 值存在 |
| user | `message.user.summary.body` | `summary.body` | utf8 | 值存在 |
| user | `message.user.summary.diffs` | `summary.diffs` whole array | json | 值存在 |
| user | `message.user.system` | `system` | utf8 | 值存在 |
| user | `message.user.format.schema` | `format.schema` | json | `format.type === "json_schema"` |
| user | `message.user.tools` | `tools` whole map | json | 值存在 |
| assistant | `message.assistant.structured` | `structured` | json | 值存在 |
| assistant | `message.assistant.error.message` | `error.data.message` | utf8 | error name 属于下述允许集合 |
| assistant | `message.assistant.error.response_body` | `error.data.responseBody` | utf8 | APIError 或 ContextOverflowError |
| assistant | `message.assistant.error.response_headers` | `error.data.responseHeaders` | json | APIError |
| assistant | `message.assistant.error.metadata` | `error.data.metadata` | json | APIError |

`message.assistant.error.message` 允许的 error name：

- `MessageAbortedError`；
- `StructuredOutputError`；
- `ProviderAuthError`；
- `UnknownError`；
- `APIError`；
- `ContextOverflowError`。

以下 Message 字段必须 inline：

- role、hidden、time；
- model、provider、agent、parent ID；
- format type/retryCount；
- error name、retries、providerID、statusCode、isRetryable；
- path、summary flag、finish、variant；
- cost、tokens、inputChars、inputTokens、inputBreakdown。

### 7.2 Part 字段

| Part | field ID | JSON 位置 | kind | 条件 |
| --- | --- | --- | --- | --- |
| text | `part.text.nonsearch_text` | `text` | utf8 | `synthetic === true` 或 `ignored === true` 或 `hidden != null` |
| text | `part.text.metadata` | `metadata` | json | 值存在 |
| reasoning | `part.reasoning.text` | `text` | utf8 | 总是允许 |
| reasoning | `part.reasoning.metadata` | `metadata` | json | 值存在 |
| file | `part.file.url` | `url` | utf8/data-url | 总是允许 |
| file | `part.file.source_text` | `source.text.value` | utf8 | source 存在 |
| agent | `part.agent.source_value` | `source.value` | utf8 | source 存在 |
| compaction | `part.compaction.recent_user_messages` | `recent_user_messages` whole array | json | 值存在 |
| retry | `part.retry.error.message` | `error.data.message` | utf8 | APIError |
| retry | `part.retry.error.response_body` | `error.data.responseBody` | utf8 | APIError |
| retry | `part.retry.error.response_headers` | `error.data.responseHeaders` | json | APIError |
| retry | `part.retry.error.metadata` | `error.data.metadata` | json | APIError |
| tool any state | `part.tool.metadata` | top-level `metadata` | json | 值存在 |
| tool running | `part.tool.running.metadata` | `state.metadata` | json | status=running |
| tool completed | `part.tool.completed.output` | `state.output` | utf8 | status=completed |
| tool completed | `part.tool.completed.metadata` | `state.metadata` | json | status=completed |
| tool completed | `part.tool.completed.attachments` | `state.attachments` whole array | json | status=completed，值存在 |
| tool error | `part.tool.error.error` | `state.error` | utf8 | status=error |
| tool error | `part.tool.error.metadata` | `state.metadata` | json | status=error，值存在 |

以下 Part 保持完全 inline：

- snapshot；
- patch；
- subtask；
- step-start；
- step-finish。

以下字段即使很大也保持 inline：

- visible `text.text`；
- Tool `tool`、`callID`、status、input、raw、title、time；
- File mime、filename、source type/path/URI/name/clientName/range/kind/start/end；
- Agent name/start/end；
- Compaction auto/overflow/tail_start_id；
- Retry name/statusCode/isRetryable/attempt/time；
- Patch files/hash；
- Subtask prompt/description/agent/command/model；
- 所有 Part type、hidden 和外层 ID。

`state.attachments` 作为 whole array 冷冻，因为 legacy search 不查询 Tool 附件内部字段；正常 Provider/TUI/ACP 消费前必须经过 resolver。

当父 Message 是 hidden、但 TextPart 自身没有 synthetic/ignored/hidden 标记时，现有 search 外层同样不会检索该文本。首版仍有意保持它 inline，因为 Part-local field matrix 无需额外查询父 Message；这是一个潜在压缩机会，不是搜索正确性缺口。

## 8. Artifact identity 和 codec

### 8.1 哈希身份

artifact identity 不是简单字符串拼接。SHA-256 preimage 使用无歧义 framing：

```text
domain-separator bytes
uint32-be format version
uint32-be kind byte length
kind UTF-8 bytes
uint64-be raw byte length
raw logical bytes
```

`format` 和 `kind` 必须进入 preimage。`codec` 不进入 identity，因为 identity、gzip 和 data-url-gzip 只是同一个 raw artifact 的不同物理表示。

命中已有 hash 时必须核对 `format`、`kind` 和 `raw_size`；任一不匹配都属于 corruption，不能当作 dedupe success。

### 8.2 Raw bytes

- string：UTF-8 bytes；
- array/object：稳定 JSON serialization 的 UTF-8 bytes；
- data URL：identity 仍基于完整、精确的原始 URL bytes。

JSON object key 顺序不作为 domain 信息；恢复目标是 schema/domain 值等价。正常 Drizzle 写入本来就是规范 JSON。非规范 raw SQL 行的 CAS 必须保持 owner 外层并发正确性，但不承诺压缩后恢复相同空白字符。

### 8.3 Gzip

- 只使用 level 1；
- 只有物理 bytes 确实小于 identity 时才使用 gzip；
- 小于或等于 4 KiB 的叶子不建立 artifact；
- 单 artifact 的 `MAX_RAW_BYTES` 固定为 64 MiB；compress 对超过上限的热叶子保持 inline 并报告 oversized，不创建无法安全恢复的 artifact；
- decode 前验证声明大小不超过 64 MiB；gzip 输出、data URL 重建结果和最终 raw bytes 任一超过该上限都 fail closed；
- decode 后再次验证长度和 hash。

当前实测最大 eligible leaf 是约 17.6 MiB 的 `summary.diffs`，64 MiB 留有明显余量，同时避免单个损坏 artifact 造成无界内存分配。

### 8.4 Data URL

对 canonical `data:<exact-prefix>;base64,<payload>`：

1. 保留逗号之前和 `base64,` 的精确原始 prefix bytes，包括大小写和参数；
2. 严格 base64 decode payload；
3. 将 prefix 和 binary payload 作为物理 envelope 存入 BLOB；
4. 只有重新编码后与原 URL 逐 byte 相等才接受 data-url codec；
5. 否则退回 generic UTF-8 codec；
6. binary envelope 仅在 gzip 后更小时使用 data-url-gzip。

对可精确重建的 canonical data URL，encoder 计算并选择四种合法表示中最小的 physical bytes：generic UTF-8 identity、generic UTF-8 gzip、data-url binary envelope、data-url-gzip。相同 raw URL 的 artifact identity 不随选择变化，status/dry-run 使用同一选择函数，因此估算和实际写入一致。

这个流程不调用 `Image.normalize()`，不会 resize、改变 MIME、改变 metadata 或重新编码像素。

## 9. 用户命令

在现有 `opencode db` 下增加：

```text
opencode db storage status [--session <id>]
opencode db storage compress [--session <id>] [--dry-run]
opencode db storage expand [--session <id>]
opencode db storage verify [--session <id>]
opencode db storage gc
opencode db storage vacuum
```

不增加 `opencode --compress`、`opencode --pure`、配置项或后台 schedule。`db storage` 与现有 DB maintenance seam 一致，也使危险度和作用域更清晰。

### 9.1 `status`

只读报告：

- 每个 field ID 的热 eligible logical bytes；
- 已冷冻 logical bytes；
- unique artifact physical bytes；
- dedupe 引用数；
- 预计和实际节省；
- marker/ref overhead；
- ambiguous marker candidate 数量；
- `session_message` 和 `event.data` 的 excluded logical bytes；
- freelist/page/WAL 信息，但不声称逻辑 bytes 与文件 bytes 可直接相加。

共享 artifact 的 physical bytes 只计一次；per-session logical bytes 可以重复计入，但报告必须明确是 logical attribution。

### 9.2 `compress`

1. 按稳定 owner ID 分页读取 exact raw JSON text。
2. 解析 schema discriminator，只访问闭合字段矩阵。
3. 已有合法 marker/ref 保持不变；只处理仍为热值的 eligible field；出现 ambiguous marker candidate 时跳过该 owner 并报告。
4. 在事务外编码、hash、gzip，避免长时间持有写锁。
5. 进入短 `BEGIN IMMEDIATE` transaction。
6. 重新确认 owner 存在且 raw JSON 仍与扫描值完全相等。
7. 插入 immutable artifacts；已存在 hash 必须核对 metadata。
8. exact CAS 更新 owner JSON；若 changed rows 不是 1，回滚并进入有界重读。
9. 只在 owner CAS 成功后插入对应 refs。
10. marker、owner、refs 和 artifacts 在同一 transaction commit。

`--dry-run` 执行扫描和 codec 估算，但不建立表内容、不写 marker、不执行 VACUUM。

### 9.3 `expand`

1. 预扫描 selected scope 的 allowlisted fields；存在 ambiguous marker candidate 时整个 scope 零修改并返回 ambiguous corruption。
2. 读取 owner raw JSON、精确 refs 和 artifacts。
3. 在事务外完成完整校验和解码。
4. 进入短 immediate transaction，exact CAS 写回所有字段。
5. owner CAS 成功后在同一 transaction 删除该 owner refs。
6. CAS 丢失时重新读取；如果新行已热，接受新值；如果仍冷，重新解析新 refs。
7. 完成 scope 后运行安全 GC，或明确报告仍有 unreferenced blobs。

全库 `expand` 只有满足以下条件才能报告 downgrade-safe：

- 全局无 `cold_artifact_ref`；
- legacy owner 中无被 ref 授权的 marker；
- legacy allowlisted fields 中无任何 ambiguous marker candidate；
- 所有 owner 均可通过当前 domain Schema decode；
- leftover unreferenced blob 已删除，或明确报告为不影响旧 binary 的无引用数据。

不能通过只删 ref 来“展开”；那会把 marker 变成普通对象并丢失透明恢复能力。

### 9.4 `verify`

`verify` 完全只读，检查：

- ref owner 是否存在；
- allowlisted field 中是否存在无匹配 ref 的 ambiguous marker candidate；
- owner discriminator 是否允许 field；
- field 当前位置是否为精确 marker；
- marker hash 是否等于 ref hash；
- artifact 是否存在；
- format/kind/codec/raw_size 是否合法；
- 解码长度和 SHA-256 是否匹配；
- 恢复后的 owner 是否通过 domain Schema；
- FK 和索引是否正常。

错误只打印 owner type、owner ID、field、hash 和错误类别，不输出用户内容。

### 9.5 `gc`

GC 必须比普通“无 ref 就删 blob”更保守：

1. 使用一个 immediate transaction 读取和验证 refs/owners/markers。
2. 独立于 ref 扫描所有 allowlisted owner/field；存在 ambiguous marker candidate 时 GC 整体失败、零修改，并保留 candidate hash 对应 artifact。
3. owner 已删除，或该 field 已明确成为普通热值时，ref 才能归类为 stale。
4. owner 仍有 marker但 hash 不匹配、marker malformed、artifact 缺失或解码失败时，GC 整体失败且不做任何删除；由 `verify` 报告 corruption。
5. 删除已确认 stale refs。
6. 只删除剩余 ref 集合完全未引用、且没有被 ambiguous candidate 命名的 artifacts。
7. 不解压仍被引用 artifact 来决定是否删除；corrupt 但仍引用的 blob 必须保留以便恢复和诊断。

### 9.6 `vacuum`

- 与 compress/expand/gc transaction 完全分离；
- 确认没有 active transaction 后执行；
- busy/disk-full 失败单独报告；
- vacuum 失败不能把已经成功的逻辑压缩标成回滚或失败；
- 默认 compress 不自动 vacuum，避免一次命令持有长时间全库锁。

## 10. 首次读取持久化回热

### 10.1 读取 seam

以下 legacy row-to-domain 路径全部必须调用同一个 resolver：

- `MessageV2.page()`；
- `MessageV2.get()`；
- `MessageV2.parts()`；
- `Session.getPart()`。

`Session.messages()` 和 `findMessage()` 已委托上述路径，不新增第二套逻辑。

每个 resolver query 同时投影：

- Drizzle parsed `data`；
- `CAST(data AS TEXT) AS data_raw`。

不能用 `JSON.stringify(row.data)` 重新构造 CAS expected value，因为 raw SQL 或历史行可能包含不同空白、key order 或数字拼写。

### 10.2 Batch resolution

1. 收集本批 owner IDs。
2. 查询这些 owner 的 refs。
3. 按完整 `(owner_type, owner_id, field, hash)` 授权 marker。
4. 授权后才按 hash 去重。
5. 对 hash 使用 bounded `IN` chunks 获取 BLOB。
6. 在内存中为每个 owner 一次性恢复全部冷字段。
7. 通过 Schema decode 后再尝试持久化回热。

只按 hash 批量获取不能授权另一个 owner 或 field。

### 10.3 CAS 收敛状态

| 状态 | 行为 |
| --- | --- |
| 初始 owner 已热 | 返回当前热值，不写 DB |
| 初始 owner 冷，CAS 成功 | 返回恢复值；owner update 和 ref delete 同事务提交 |
| CAS 失败，重读为更新后的热行 | 返回更新者的热值，不返回旧 snapshot |
| CAS 失败，重读为另一份冷行 | 重新读取新 refs/artifacts，再进行下一次有界尝试 |
| owner 被删除 | 保持当前 get/page/parts 的 not-found/undefined 语义 |
| 重复冲突超过预算 | 抛 typed storage contention error |
| marker/ref/blob corruption | 抛 typed storage corruption error，DB 不变 |

任何失败路径都不能返回含 marker 的 domain 对象，也不能在 CAS 失败后返回已经过时的解压 snapshot。

### 10.4 回热副作用

成功回热 transaction 只修改：

- owner 的 `data`；
- 对应 `cold_artifact_ref`。

它不修改 `time_created`、`time_updated` 或 Session 时间，不发布 Message/Part event，不写 EventTable，不触发 share/bus。

当前 prompt 路径先读取 legacy history，再执行 compaction filter。因此恢复一个被压缩的 Session 时可能把其整段请求历史回热。这是用户要求的“第一次冷启动，之后持续热启动”，不是额外回归。Session list search 和 preview 不走 resolver，所以不会因为浏览列表而回热。

## 11. 正常写入、事件和删除

### 11.1 Projector upsert

Message/Part projector 的顺序：

1. 执行现有 full-row upsert；
2. upsert 成功后同步删除该 owner 的全部 refs；
3. usage 差额继续使用 inline step/accounting 字段；
4. 所有操作留在现有 SyncEvent transaction 内；
5. 若 ref delete 失败，整个 projector/event transaction 回滚；
6. foreign-key late update 被现有逻辑忽略时，不删除 refs。

不能把 ref 清理放入 `Database.effect()`；该 callback 在 transaction 后执行，会破坏原子性。

### 11.2 Event replay

本方案不根据 `EventTable` 或 `SessionMessageTable` 是否有行跳过 legacy compression。

原因：

- generic event 存在不能可靠表示 Session 使用哪套 message projection；
- event 和 legacy owner 是不同副本；
- replay/update 通过同一个 legacy projector 执行 full-row hot upsert；
- projector 随后原子清 refs，等价于一次正常自然回热；
- retained event payload 不需要理解 marker，也不存在“先检查 event、后 compress”的授权竞态。

EventTable 和 `session_message` 当前不参与 artifact codec，`status` 只报告 excluded bytes。若未来它们成为实际主要占用，应单独设计 v2/event 读写和 replay 语义，而不是在本补丁中添加半套兼容逻辑。

### 11.3 Import 和 JSON migration

- 新 import ID 写入普通热 JSON；
- 冲突 ID 使用 `onConflictDoNothing()`，不会覆盖冷 owner，也不应清 ref；
- JSON migration 只生成普通热行；
- 不在 import/migration 过程中自动压缩。

### 11.4 删除

Message/Part/Session 删除可以暂时留下 generic refs。这不会造成 owner 数据丢失，因为 artifact 继续存在；显式 GC 后才删除 orphan refs 和 unreferenced blobs。

为了少改删除链，不新增 SQLite trigger，也不在每个 cascade path 手动枚举 refs。

## 12. Search、Compaction 和 Fork

### 12.1 Search

本方案不修改 `session/search.ts`。

- visible text 保持 inline；
- 只有 existing search predicate 已排除的 synthetic/ignored/hidden text 才可冷冻；
- Tool input/raw/title/name 保持 inline；
- File/Agent search metadata 保持 inline；
- Subtask 和 Patch search 字段保持 inline；
- marker、Tool output、Reasoning、data URL payload 不应产生搜索命中。

因此普通历史和 completed-compaction 历史的搜索结果都应在 compress 前后完全一致。

### 12.2 Compaction

不修改 compaction 生产逻辑。Compaction 通过 hydrated domain Message/Part 消费：

- Reasoning；
- Tool output/error/metadata；
- compaction recent user messages；
- summary diff。

集成测试证明这些值完整且无 marker 即可。

### 12.3 Fork 和共享前缀

不把 Fork 改成 parent-pointer 前缀链。那种方案会使 child 的可读性依赖 parent 行存在、parent 修改语义、搜索 JOIN/递归、删除保护和跨版本迁移，明显超出小修小改范围。

推荐的共享发生在不可变 artifact 层：

- parent 与 child 各自仍拥有完整 Message/Part 行；
- 相同 Tool output、Reasoning、summary diff 或图片会计算出相同 hash；
- 多个 ref 指向一个 immutable BLOB；
- 修改任一 owner 只改变自身 JSON/ref；
- 其他 owner 不受影响；
- 只有最后一个 ref 消失并执行 GC 后才回收 BLOB。

可检索前缀仍然重复保存，这是保持搜索简单、Session 独立和 schema 克制的有意取舍。

## 13. 错误、安全和退出边界

### 13.1 Fail closed

下列情况不得返回降级内容：

- ref 指向不存在的 artifact；
- marker/ref hash 不一致；
- format/kind/codec 不支持；
- gzip 解压失败；
- raw size 超过上限或与结果不符；
- SHA-256 不匹配；
- 恢复值不通过 owner Schema；
- CAS 重试耗尽。

失败时 owner/ref/blob 原样保留，并返回 typed error。日志不包含原始 Tool output、图片、Reasoning 或 metadata。

### 13.2 并发和 WAL

- 扫描、hash、压缩和解压在 transaction 外进行；
- mutation 使用短 `BEGIN IMMEDIATE`；
- owner update 必须包含 ID、Session ownership 和 exact raw text predicate；
- 一个 transaction 中 owner CAS 与 ref mutation不可分割；
- busy timeout 继续使用现有 30 秒配置；
- 超时后返回 contention，不通过无界 retry 阻塞 daemon；
- 同一 owner 的并发首读最终只保留 winner 的热值；
- 正常 hot writer 永远优先，warming 不得复活旧行。

### 13.3 退出和中断

每个 owner mutation 都是独立完整 transaction。CLI 被 SIGINT、进程崩溃或磁盘满时：

- 当前 transaction 全部回滚；
- 已完成 owner 保持合法冷或热态；
- 未开始 owner 不变；
- 下次命令可以幂等继续；
- 不存在 marker 已提交但 ref/blob 未提交的中间态。

## 14. 行为级测试计划

遵循先测试后实现，分四组建立红灯。

### 14.1 第一组：migration、field matrix 和 codec

建议新增 `test/session/cold-artifact-codec.test.ts`：

- 两张表、PK、CHECK、ref hash index、RESTRICT FK 和 `foreign_key_check`；
- 每个 Message role 和每个 Part discriminator 的 table-driven field matrix；
- 每个 eligible path 能 round-trip；
- 每个 searchable/structural/accounting path 始终 inline；
- 4096 inline、4097 eligible；
- marker-shaped literal 无 ref 时不解码；
- 正常 domain read 把无 ref marker-shaped `Schema.Any` 值作为普通用户数据；
- maintenance 把 allowlisted field 中无 ref 的精确 marker 外形报告为 ambiguous candidate；
- owner/field/hash 任一不匹配都不授权；
- canonical data URL 在四种可逆表示中选择最小值；
- format/kind length-framed hash；
- existing hash metadata mismatch 报 corruption；
- canonical/noncanonical data URL exact round-trip；
- 64 MiB 上限、声明大小和实际展开大小不一致均 fail closed；
- 所有 Assistant error 变体，包括 Unknown 和 OutputLength；
- malformed、oversized、truncated、hash mismatch fail closed。

当前实现没有表、marker、codec 或 field matrix，这组测试会首先暴露基础能力缺口。

### 14.2 第二组：resolver、CAS 和 writer

建议新增 `test/session/cold-artifact-resolver.test.ts`，并扩展现有 session projector 测试：

- page/get/parts/getPart 都恢复完整值；
- 首次读取持久化回热，第二次无解压；
- `MessageV2.parts()` 仍保持同步 interface；
- batch owner 和 hash chunk 去重；
- 非规范 raw SQL JSON 使用 exact raw CAS；
- CAS winner 已热时返回 winner；
- CAS winner 是另一份冷行时重新解析；
- 连续多个 newer-cold replacement 后有界收敛；
- owner 删除保持现有 not-found；
- hot writer win，不复活旧 output；
- 回热不发 event、不更新时间；
- successful projector upsert 清 refs；
- failed/ignored projector 保留 refs；
- 对已冷 owner 执行 `SyncEvent.replay()` 后得到热 owner、ref 原子清除、retained event 仍是普通热 payload；ref 清理失败时 owner/event/ref 全部回滚；
- 旧 cold Tool row 的 usage subtraction 仍正确；
- import conflict 不覆盖 cold owner。

### 14.3 第三组：search、preview 和 domain consumers

扩展现有 `session-list.test.ts`、`session-preview.test.ts`、`message-v2.test.ts` / compaction 测试：

- completed compaction 之前的 visible text 仍命中；
- Tool name/title/input/raw 仍命中；
- File/Agent/Subtask/Patch 字段仍命中；
- Reasoning、Tool output、data URL payload 和 marker 不产生新命中；
- search 结果 compress 前后相同；
- search 和 preview 不触发 warming；
- Provider conversion、export、share、fork、revert、summary、compaction 永远不收到 marker；
- 图片、Tool output、summary diff 和 metadata domain 值完整。

### 14.4 第四组：maintenance CLI

建议新增 `test/cli/db-storage.test.ts`：

- status 和 dry-run 只读；
- compress 可按 Session 限定且幂等；
- mixed hot/cold owner 只补充新 artifact；
- expand 可按 Session 限定且幂等；
- full expand 满足 downgrade completion criteria；
- verify 发现 orphan、missing blob、hash mismatch、malformed marker 和 ambiguous marker candidate；
- ambiguous candidate 下 full expand 零修改且不能报告 downgrade-safe；
- GC 保留 referenced/corrupt blob，只删除安全 stale refs 和 unreferenced blobs；
- corruption 或 ambiguous candidate 时 GC 零修改，并保留 candidate 命名的 artifact；
- command 中断只影响当前未提交 owner；
- event/session_message 数据不被改写，并在 status 中报告 excluded bytes；
- vacuum 与逻辑命令分离，busy/failure 不改变逻辑结果。

## 15. 预计文件变更

### 15.1 生产文件

| 文件 | 具体改动 |
| --- | --- |
| `packages/opencode/src/session/session.sql.ts` | 新增两张 additive table 和 hash index |
| `packages/opencode/src/session/cold-artifact.ts` | 新深模块：field matrix、codec、resolver、CAS、maintenance 和 typed errors |
| `packages/opencode/src/session/message-v2.ts` | row query 携带 raw text，并在 page/get/parts 的 row-to-domain seam 调用 resolver |
| `packages/opencode/src/session/session.ts` | `getPart()` 复用统一 Part resolver |
| `packages/opencode/src/session/projectors.ts` | successful Message/Part upsert 后同事务清 owner refs |
| `packages/opencode/src/cli/cmd/db.ts` | 增加 `db storage` 子命令，薄适配到 cold-artifact maintenance interface |

不修改：

- `session/search.ts`；
- `session/compaction.ts`；
- `session/projectors-next.ts`；
- `sync/index.ts`；
- Provider/TUI/export/share/revert 生产文件；
- config 和 SDK schema。

### 15.2 Migration

使用现有生成流程新增一个 migration 目录：

- `migration.sql`；
- `snapshot.json`。

Migration 只 CREATE TABLE / INDEX，不 backfill、不 rewrite 原表、不自动 compress。

### 15.3 测试和文档

预计：

- 新增 2 个 focused session/codec/resolver 测试；
- 新增 1 个 DB storage CLI 测试；
- 新增或扩展 1 个 migration 测试；
- 扩展现有 search/preview/compaction/projector 测试，尽量不重复 fixture；
- 保留本 proposal 作为设计依据；实现时只在确有用户入口文档要求时更新 CLI EN/ZH 文档。

## 16. 验证命令

所有测试从 package 目录运行：

```bash
cd packages/opencode

# 实现阶段生成 migration，一次即可
bun run db generate --name cold-artifact

# 最窄测试
bun test test/session/cold-artifact-codec.test.ts
bun test test/session/cold-artifact-resolver.test.ts
bun test test/cli/db-storage.test.ts

# 相关行为回归
bun test test/session/messages-pagination.test.ts \
  test/session/message-v2.test.ts \
  test/session/compaction.test.ts \
  test/session/session.test.ts \
  test/server/session-list.test.ts \
  test/server/session-preview.test.ts

# 静态和构建验证
bun typecheck
bun run build
```

迁移测试还应在旧 schema fixture 上执行 migration，检查表、索引、FK，并运行：

```sql
PRAGMA foreign_key_check;
```

真实用户数据库只做 copy 上的演练：status -> dry-run -> compress -> verify -> domain read warming -> expand -> verify。不能在测试中直接修改 live `opencode.db`。

## 17. 规模预估

不含本调研 proposal：

| 类别 | 文件数 | 手写增删行预估 |
| --- | ---: | ---: |
| 生产代码 | 6 | 650-1,000 |
| 测试 | 4-7 | 750-1,200 |
| 生成 migration | 2 | 由 Drizzle 生成，snapshot 可能较大 |
| 用户文档 | 0-2 | 0-120 |

预计 Git 文件数为 12-17，主要新增量集中在一个深模块和行为测试；现有生产文件只做 seam 接入。若实现显著超过这个范围，应先重新审计，而不是继续增加 adapter、配置或状态机。

不涉及 SDK 生成，不涉及现有表数据迁移，不涉及删除文件。

## 18. 真实风险和处理

### 18.1 首次读取延迟

恢复一个长期 Session 时，prompt 当前会读取整段 legacy history，因此第一次可能解压较多内容并写回。该延迟是明确产品取舍；batch hash fetch、gzip level 1、transaction 外解码和一次 owner CAS 用于限制成本。

### 18.2 数据库写放大和 WAL

首次读取会重写 owner JSON，并产生 WAL。手动 compress 与后续 warming 不应并发无限争抢；bounded CAS 和现有 busy timeout 提供收敛。大规模 compress/expand 使用小批次，不能开启一个覆盖全库的长 transaction。

### 18.3 SQLite 文件不立即变小

compress 释放的是原 JSON page 内容并新增 BLOB；page layout 和 freelist 决定主文件何时缩小。`status` 必须区分 logical、physical artifact 和 file size；用户需要时单独执行 vacuum。

### 18.4 实验性副本

如果未来 `session_message` 或 retained `event.data` 大量保存相同 payload，本阶段只压 legacy 会留下副本。当前实测二者占比可忽略，强行纳入会引入另一套 schema、projector、replay 和 read seam。`status` 的 excluded bytes 使该风险可观测，未来应以独立 proposal 处理。

### 18.5 旧版本兼容

Cold marker 存在期间，旧 binary 不能透明读取这些行。压缩是用户显式 opt-in；完整 `expand` 是 downgrade 前置条件。Additive tables 本身不影响旧 binary，真正的兼容边界是 owner JSON marker。存在无 ref 的 ambiguous marker candidate 时，即使当前 Schema 能把它解释为普通 `Schema.Any`，maintenance 也不得宣称 downgrade-safe。

### 18.6 Corruption

Artifact hash、raw size、format、kind、codec、ref 和 owner marker 提供多层校验，但不能代替备份。GC 遇到任何仍有 marker 的不一致或 ambiguous marker candidate 必须停止，不能试图“修复”或删除可恢复证据。

## 19. 被拒绝的方案

### 19.1 删除 compaction 前缀

拒绝。旧历史仍参与 Session list 搜索，删除会降低信息量，并使 summary diff 或外部 snapshot 清理后失去唯一证据。

### 19.2 压缩整个 Message/Part JSON

拒绝。会破坏 JSON search、preview、usage migration 和 discriminator 查询，迫使重写大量 SQL。

### 19.3 所有读取都临时解压但不回热

拒绝。长期 Session 每次 prompt 都重复解压，违背用户要求的自然冷启动/热启动模型。

### 19.4 解压后只放内存 cache

拒绝。daemon 重启后重复付费，并增加 cache invalidation、生命周期和内存上限问题。

### 19.5 gzip 后 base64 继续塞入 JSON

拒绝。图片实测收益很低或膨胀，且仍承担 base64 开销。

### 19.6 Fork parent-prefix 引用

拒绝。会让 child 依赖 parent 存在和版本，复杂化搜索、删除、修改、revert 和迁移。不可变 artifact 去重已经提供安全的共享层。

### 19.7 压缩所有 metadata/Schema.Any 的任意递归叶子

拒绝。marker 可能与用户 JSON 冲突，消费者无法穷举，通用 JSONPath 也会扩大安全面。只使用闭合 discriminator-aware field matrix。

### 19.8 把 artifact 放到外部 session diff/snapshot 目录

拒绝。用户可能独立清理该目录；数据库 marker 不能依赖易清理的第二存储，否则会造成不可恢复缺失。

### 19.9 自动后台压缩

拒绝。增加 daemon 并发、退出、调度、配置和不可预期延迟；当前需求用显式 maintenance 命令即可满足。

## 20. 开放问题

当前没有必须由用户先决策的行为问题。推荐默认值已经收敛为：

- 4 KiB 严格阈值；
- 64 MiB 单 artifact 上限；
- gzip level 1；
- 手动 compress；
- 首次 domain read 持久化回热；
- search/preview 不回热；
- vacuum 独立；
- legacy-only 首版；
- full expand 后才支持 downgrade。

实现前仍需由独立 subagent 对本文完整复核。任何会导致数据丢失、搜索回归、marker 泄漏、并发覆盖、兼容退化或不可逆 GC 的意见均为阻塞项；出现阻塞项时必须修改本文并重新进行同范围审计。

## 21. 推荐方案摘要

推荐实现一个 legacy selective-leaf cold artifact 模块：保留所有搜索和结构字段在原 JSON 中，把大于 4 KiB 的明确非搜索叶子写入同库不可变 BLOB，通过 owner/field/hash ref 授权 marker，并在首次正常读取时 exact-CAS 持久化回热。

它能直接覆盖当前数据库中最大的安全候选：约 154.2 MB Tool output、91.4 MB summary diff、28.6 MB Reasoning 和 24.3 MB File URL，同时保留 compacted 历史搜索、完整 Message 信息、Fork 独立性和 downgrade 能力。相比 whole-row 压缩、parent-prefix 共享或后台状态机，它的 schema 变化更小、调用 seam 更少、失败边界更清晰，也更符合当前仓库的模块和测试组织。
