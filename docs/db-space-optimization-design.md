# opencode.db 空间优化设计方案 (v2 — Gate 2 修正版)

**基于**: diagnosis.md (Gate 1 已通过)  
**机器**: Windows (本机), DB 1574.66 MB  
**设计日期**: 2026-07-04  
**约束**: 全程可逆、零数据损失、收益基于本机实测  

---

## 方案总览

| # | 方案 | 针对根因 | 本机实测节省 | LLM 影响 | 可逆 |
|---|------|---------|-------------|---------|------|
| 1 | Content-Addressable 压缩存储 (CAC) | RC1+RC3 | 646 MB (parts) + 153 MB (msgs) | 仅冷数据 | ✅ |
| 2 | 分层压缩策略 (L1/L2/L3) | RC1+RC2 | L1: 175 MB, L2: 715 MB, L3: 849 MB | L1零, L2旧会话, L3热路径 | ✅ |
| 3 | summary.diffs 提取压缩 | RC2 | 136 MB | 零 (不发送LLM) | ✅ |
| 4 | Fork 前缀引用化 | RC3 | 138 MB (与方案1去重叠加后增量~67 MB) | 零 | ✅ |
| 5 | 回溯截断大工具输出 | RC5 | 10 MB (DB) / 40 MB (LLM上下文) | 改善 | ✅ |
| 6 | VACUUM + auto_vacuum | RC4 | 回收已释放页面 | 零 | N/A |
| 7 | Snapshot ref 保护 | 预防 | 0 (预防未来损失) | 零 | N/A |
| 8 | CLI 命令接口 | 实施 | — | — | — |

**保守收益** (方案 2-L1 + 3 + 6): DB 1574 → ~1250 MB (21%), LLM 零影响  
**组合收益** (方案 1+3+6): DB 1574 → ~600 MB (62%), LLM 零影响(冷数据)  
**极限收益** (全部+L3): DB 1574 → ~500 MB (68%), 含热路径解压

---

## 核心设计决策 (Gate 2 修正)

### 压缩数据存储方式

**问题**: `part.data` 是 NOT NULL JSON 列，存储完整 part 内容（含 `type` 字段）。直接置空会丢失 `type`，导致所有 `part.type ===` 检查失败。

**解决方案**: 双列设计 — 保留 `data` 列存储最小判别 JSON，新增 `data_blob` 列存储压缩数据。

```
未压缩行: data = '{"type":"tool","tool":"read","state":{"output":"..."},...}', data_blob = NULL
压缩行:   data = '{"type":"tool","_compressed":true}', data_blob = <gzip of original data>
```

**优势**:
- `type` 字段始终可读（不需解压即可判断 part 类型）
- 旧版本读取 `data` 仍能获取 `type`（降级但不崩溃）
- `_compressed` 标记明确指示是否需要解压
- `data` 保持 NOT NULL 约束，无需修改列约束

### 向后兼容

- 新增列默认 NULL，旧版本忽略
- 旧版本读取压缩行: `data = '{"type":"tool","_compressed":true}'` → 获取 type 但无完整内容
  - `part()` 函数 (`message-v2.ts:739-745`) 展开 `row.data` → 产生 `{type:"tool", _compressed:true, id, sessionID, messageID}`
  - `toModelMessagesEffect()` 中 `part.type === "tool"` 匹配，但 `state` 为 undefined → 工具输出为空
  - **降级行为**: 旧版本看到压缩会话时，LLM 上下文缺少工具输出内容，但不会崩溃
- 新版本检测 `_compressed` 标记 → 从 `data_blob` 解压获取完整数据

### 数据完整性保护

1. **压缩前自动备份**: 首次执行 `opencode compress` 时，自动复制 DB 到 `opencode.db.bak`
2. **原子写入**: 使用 SQLite 事务，`data_blob` 和 `data` 更新在同一事务中提交
3. **SHA-256 校验**: `data_blob` 存储 gzip 原始数据 + SHA-256 hash (存储在 content_store)
4. **验证命令**: `opencode compress --verify` 遍历所有压缩行，解压并校验 hash
5. **最小 JSON 保留 type**: 即使 `data_blob` 损坏，`data` 中的 `type` 信息仍然存在（内容丢失但结构完整）

---

## 方案 1: Content-Addressable 压缩存储 (CAC)

### 针对根因
RC1 (工具输出无压缩, 812 MB) + RC3 (无去重, 143 MB)

### 本机实测收益

| 维度 | 原始 | 去重后 | 去重+压缩后 | 节省 |
|------|------|--------|------------|------|
| Parts (全量 327,123) | 1084.99 MB | 942.24 MB | 438.64 MB | **646.36 MB (59.6%)** |
| Messages (全量 74,192) | 210.87 MB | 197.00 MB | 58.15 MB | **152.72 MB (72.4%)** |
| **合计** | **1295.86 MB** | — | **496.79 MB** | **799.08 MB (61.7%)** |

**实测方法**: 对全部 327,123 个 parts 和 74,192 条 messages 计算 MD5 hash，对唯一内容 (255,207 个 unique parts, 73,054 个 unique messages) 做 gzip 压缩，统计总大小。

**按 Part 类型分解**:

| 类型 | 原始 | 去重+压缩 | 节省率 |
|------|------|----------|--------|
| tool | 813.99 MB | 303.20 MB | 62.8% |
| reasoning | 119.69 MB | 65.48 MB | 45.3% |
| text | 69.72 MB | 27.55 MB | 60.5% |
| file (base64) | 37.14 MB | 18.25 MB | 50.9% |
| step-finish | 23.78 MB | 13.14 MB | 44.7% |
| step-start | 15.51 MB | 9.01 MB | 41.9% |
| patch | 2.55 MB | 0.57 MB | 77.7% |

### 可逆性设计

**压缩** (compress):
```
对每行 part/message:
1. 计算 data 的 SHA-256 hash
2. 若 content_store 中不存在该 hash:
   a. gzip 压缩 data → compressed_blob
   b. INSERT INTO content_store (hash, data) VALUES (hash, compressed_blob) 
      [ON CONFLICT DO NOTHING]
3. 生成最小判别 JSON: {type: original.type, _compressed: true}  (part)
   或 {role: original.role, _compressed: true}  (message)
4. UPDATE part SET data = minimal_json, data_blob = hash WHERE id = ?
   [在同一事务中]
```

**展开** (expand):
```
对每行 data_blob IS NOT NULL 的 part/message:
1. SELECT data FROM content_store WHERE hash = data_blob
2. gunzip(data) → original_data
3. UPDATE part SET data = original_data, data_blob = NULL WHERE id = ?
4. [事务提交后] 可选: 清理无引用的 content_store 条目
   DELETE FROM content_store WHERE hash NOT IN 
     (SELECT data_blob FROM part WHERE data_blob IS NOT NULL
      UNION SELECT data_blob FROM message WHERE data_blob IS NOT NULL)
```

**零损失验证**: 压缩前计算所有 `data` 的 SHA-256 → 压缩 → 展开 → 重新计算 SHA-256 → 比对一致。

### Schema 变更

```sql
-- 内容存储表 (去重+压缩)
CREATE TABLE content_store (
  hash TEXT PRIMARY KEY,              -- SHA-256 of original data
  data BLOB NOT NULL,                 -- gzip compressed original data
  time_created INTEGER NOT NULL
);
-- 不设 ref_count: 通过子查询清理无引用条目
-- 不设 level: 压缩层级记录在 part/message 行上

-- part 表增加压缩列
ALTER TABLE part ADD COLUMN data_blob TEXT REFERENCES content_store(hash);
-- data_blob IS NOT NULL → data 为最小判别 JSON, 完整数据在 content_store

-- message 表增加压缩列
ALTER TABLE message ADD COLUMN data_blob TEXT REFERENCES content_store(hash);

-- part 表增加压缩层级 (方案 2 使用)
ALTER TABLE part ADD COLUMN compress_level INTEGER DEFAULT 0;
-- 0=未压缩, 1=L1, 2=L2, 3=L3

-- message 表增加压缩层级
ALTER TABLE message ADD COLUMN compress_level INTEGER DEFAULT 0;
```

**向后兼容**: 新列默认 NULL/0，旧版本忽略。`data` 保持 NOT NULL，存储最小 JSON。

### 读写路径修改点

**读取** (解压):
- `src/session/message-v2.ts:739-745` `part()` 函数 — 增加 `data_blob` 检查:
  ```ts
  const part = (row) => {
    if (row.data_blob) {
      const full = gunzip(contentStore.get(row.data_blob))
      return { ...JSON.parse(full), id: row.id, sessionID: row.session_id, messageID: row.message_id }
    }
    return { ...row.data, id: row.id, sessionID: row.session_id, messageID: row.message_id }
  }
  ```
- `src/session/message-v2.ts:732-737` `info()` 函数 — 增加 `data_blob` 和 `diffs_blob` 统一处理:
  ```ts
  const info = (row) => {
    let data = row.data
    if (row.data_blob) {
      data = JSON.parse(gunzip(contentStore.get(row.data_blob)))  // 全量解压
    }
    if (row.diffs_blob) {
      // 若 data_blob 已解压则注入到解压结果; 否则注入到 data
      const diffs = JSON.parse(gunzip(contentStore.get(row.diffs_blob)))
      data = { ...data, summary: { ...data.summary, diffs } }
    }
    return { ...data, id: row.id, sessionID: row.session_id } as Info
  }
  ```
  **注意**: `data_blob` (全量压缩) 和 `diffs_blob` (仅 diffs 提取) 可同时存在——先解压 `data_blob` 获取完整 data，再注入 `diffs_blob`。
- `src/session/message-v2.ts:750-774` `hydrate()` 函数 — 调用 `part()` 和 `info()`，自动处理解压
- `src/session/session.sql.ts:75-91` `PartTable` — 增加 `dataBlob` 和 `compressLevel` 列定义
- `src/session/session.sql.ts:61-73` `MessageTable` — 增加 `dataBlob` 和 `compressLevel` 列定义

**写入** (需修改 — 清除压缩标记):
- 新数据始终写入 `data` 列，`data_blob = NULL`, `compress_level = 0`
- `src/session/projectors.ts:186` `onConflictDoUpdate` — **必须同时清除 `data_blob` 和 `compress_level`**:
  ```ts
  .onConflictDoUpdate({
    target: PartTable.id,
    set: { data: rest, data_blob: null, compress_level: 0, time_updated: sql`${PartTable.time_updated}` }
  })
  ```
  否则压缩后的 part 被更新时，`part()` 会解压旧的 `data_blob` 而忽略新的 `data`
- `src/session/session.ts:679` `updatePart()` — 同理，更新时清除压缩标记
- `src/session/projectors.ts:66` `toPartialRow()` — 不修改 (新列默认 NULL)

**LLM 上下文构建** (零变更):
- `src/session/message-v2.ts:792-1090` `toModelMessagesEffect()` — 无需修改，读取的 parts 已在 `hydrate()` 时解压
- `src/session/summary.ts:83-126` `computeDiff()` — 读取 step-start/step-finish 的 `snapshot` 字段，通过 `hydrate()` 解压后可用

**TUI 显示**:
- `src/session/session.ts:816-820` `diff()` 函数 — 读取 `storage/session_diff/` 外部文件，不读取 `message.data.summary.diffs`，不受影响
- TUI 消息详情若显示 diffs: 通过 `info()` 函数读取，解压后 `summary.diffs` 可用

### CLI 设计

```bash
opencode compress [--level 1|2|3] [--session <id>] [--dry-run] [--verbose] [--verify]
```

### 风险评估

| 风险 | 概率 | 缓解 |
|------|------|------|
| 解压开销影响旧会话恢复 | 低 | L2 仅压缩 >7d 会话；批量解压 ~1-2s |
| content_store 损坏 | 极低 | 首次压缩前自动备份；事务原子写入；`--verify` 命令校验 |
| 并发写入与压缩冲突 | 低 | 每行独立事务 (小批量 100 行/事务)；WAL 允许并发读 |
| 旧版本读取压缩行 | 中 | `data` 保留 `{type, _compressed:true}`，旧版本降级但不崩溃 |
| 压缩中断 | 低 | 每行独立事务；中断后重新运行自动跳过已压缩行 (`data_blob IS NOT NULL`) |

### 测试策略

1. **正确性**: 压缩 100 条随机 parts → 展开 → 比对 SHA-256 一致
2. **去重验证**: content_store 行数 < part 行数 (去重生效)
3. **type 保留**: 压缩后 `data.type` 可读，`part()` 返回正确类型
4. **LLM 上下文**: 压缩后构建 LLM 上下文，输出与未压缩一致
5. **可逆性**: compress → expand → compress 幂等
6. **中断恢复**: 压缩中断后重新运行，已完成行跳过
7. **旧版本兼容**: 模拟旧版本读取压缩行，`type` 可读不崩溃
8. **`--verify`**: 校验所有压缩行可正确解压

---

## 方案 2: 分层压缩策略

### 针对根因
RC1 (工具输出) + RC2 (summary.diffs) — 区分冷热数据

### 本机实测收益

| 层级 | 压缩范围 | 原始大小 | 压缩后 | 节省 | LLM 影响 |
|------|---------|---------|--------|------|---------|
| **L1** | COLD parts (step-finish+patch+step-start) + summary.diffs | ~209.67 MB | ~34.84 MB | **~175 MB** | 零 (不发送LLM) |
| **L2** | L1 + >7d 会话全部 parts+msgs | 1162.49 MB | 447.33 MB | **715.16 MB** | 旧会话恢复 ~1-2s |
| **L3** | L2 + <=7d 会话 parts | +106.80 MB | +43.24 MB | +63.56 MB | 每次 LLM 调用 ~50ms |

**实测方法**: 
- L1: 直接查询 COLD part 类型 + summary.diffs 数据量，乘以实测 gzip 压缩率
- L2: 对 >7d 会话的所有 parts+messages (335,427 行) 去重+gzip
- L3: 对 <=7d 会话的 parts (53,206 行) 去重+gzip

### L1 详细分解

| 数据 | 大小 | gzip 压缩率(实测) | 压缩后 | 节省 | LLM 读取? |
|------|------|------------------|--------|------|----------|
| summary.diffs (msg) | 167.83 MB | 18.9% | 31.7 MB | 136.1 MB | 否 |
| step-finish parts | 23.78 MB | 11.9% | 2.8 MB | 21.0 MB | 否 (无handler) |
| step-start parts | 15.51 MB | 0.9% | 0.14 MB | 15.4 MB | 仅标记 |
| patch parts | 2.55 MB | 9.2% | 0.23 MB | 2.3 MB | 否 (revert用) |
| **L1 合计** | **209.67 MB** | — | **34.87 MB** | **174.80 MB** | — |

**L1 读取影响分析**:
- `summary.diffs`: 不在 LLM 上下文路径。TUI `diff()` 读取外部文件。`computeDiff()` 重新计算 diffs 时不读取已存储的 diffs。→ **零影响**
- `step-finish`: `toModelMessagesEffect()` 无 handler。`computeDiff()` (`summary.ts:107-108`) 读取 `part.snapshot` → 需解压。但 `computeDiff` 仅在 `summarize()` 时调用（异步后台），不影响 LLM 调用。→ **后台解压，零LLM影响**
- `step-start`: `toModelMessagesEffect()` 推送 `{type:"step-start"}` (message-v2.ts:957-959)。需解压获取完整数据但仅取 `type`。→ **解压开销极小 (0.14 MB)**
- `patch`: `toModelMessagesEffect()` 无 handler。`revert.ts:55` 读取。→ **仅 revert 时解压**

### 层级标记

`compress_level` 列在 `part`/`message` 表上 (不在 `content_store` 上):
- `compress_level = 0`: 未压缩
- `compress_level = 1`: L1 压缩 (COLD 数据)
- `compress_level = 2`: L2 压缩 (非活跃会话)
- `compress_level = 3`: L3 压缩 (活跃会话)

`expand --level N` 展开 `compress_level > N` 的所有行 (保留 `compress_level <= N` 的压缩)。

**注意**: `content_store` 不存储 level — 同一 hash 可被不同 level 的行引用，互不影响。

### CLI 设计

```bash
opencode compress                    # 默认 L1
opencode compress --level 2          # L1 + 非活跃会话
opencode compress --level 3          # 全部
opencode expand                      # 展开所有
opencode expand --level 2            # 展开 L3 (保留 L1+L2)
opencode expand --level 1            # 展开 L2+L3 (保留 L1)
opencode compress --status           # 显示各层级状态
opencode compress --verify           # 校验所有压缩行
```

### 读写路径修改点

与方案 1 相同。额外:
- `src/session/session.ts:822-841` `messages()` 函数 — 读取非活跃会话时，parts 已在 `hydrate()` 中解压，无需额外处理
- `src/session/message-v2.ts:750-774` `hydrate()` — 批量查询时，content_store 查询可批量优化 (一次查询多个 hash)

### 风险评估

| 风险 | 缓解 |
|------|------|
| L2 解压延迟影响旧会话恢复 | 批量解压 + 内存缓存；实测 447 MB 解压 ~2s |
| L3 解压影响 LLM 调用 | L3 不推荐日常使用 |
| 事务粒度 | 每批 100 行一个事务，避免长时间锁库 |

### 测试策略

1. L1 压缩后 `computeDiff()` 正常工作 (解压 step-finish.snapshot)
2. L1 压缩后 `toModelMessagesEffect()` 输出不变 (step-start 解压后取 type)
3. L2 压缩后恢复 >7d 会话，消息完整
4. 各层级独立展开/压缩互不干扰

---

## 方案 3: summary.diffs 提取压缩

### 针对根因
RC2 (summary.diffs 内联不可重算, 167.83 MB)

### 本机实测收益

| 维度 | 值 |
|------|-----|
| 含 diffs 的 user 消息 | 1,344 条 |
| diffs 总量 | 167.83 MB |
| gzip 压缩后 | 31.7 MB (实测 18.9%) |
| **节省** | **136.1 MB** |
| 重复 diffs | 169 组 / 414 副本 / 14.18 MB 浪费 |
| 最大单条 | 88.73 MB → 16.8 MB |

### 可逆性设计

此方案是方案 1 (CAC) 的特化应用——将 `summary.diffs` 从 `message.data` JSON 中提取，存入 `content_store`。

**提取**:
```
1. 解析 message.data JSON
2. 提取 summary.diffs 字段 → diffs_json
3. 计算 SHA-256(diffs_json) → hash
4. gzip(diffs_json) → content_store[hash]
5. 从 data 中移除 summary.diffs: data.summary.diffs = null
6. 设置 data._diffs_compressed = true
7. UPDATE message SET data = modified_data, diffs_blob = hash
```

**恢复**:
```
1. SELECT data FROM content_store WHERE hash = diffs_blob
2. gunzip → diffs_json
3. 解析 data, 设 summary.diffs = JSON.parse(diffs_json)
4. 移除 data._diffs_compressed
5. UPDATE message SET data = restored_data, diffs_blob = NULL
```

### Schema 变更

```sql
ALTER TABLE message ADD COLUMN diffs_blob TEXT REFERENCES content_store(hash);
-- diffs_blob IS NOT NULL → summary.diffs 已提取压缩
-- data 中 _diffs_compressed = true 标记
```

### 读写路径修改点

**读取**:
- `src/session/message-v2.ts:732-737` `info()` 函数 — 若 `diffs_blob` 存在，解压注入 `summary.diffs`
- `src/session/session.sql.ts:61-73` `MessageTable` — 增加 `diffsBlob` 列

**写入** (零变更):
- `src/session/summary.ts:153` `target.info.summary.diffs = msgDiffs` — 仍写入 `data.summary.diffs`
- `src/session/summary.ts:154` `sessions.updateMessage(target.info)` — 正常写入

**LLM 上下文** (零影响):
- `src/session/message-v2.ts:792-1090` `toModelMessagesEffect()` — 不读取 `summary.diffs`

**TUI**:
- `src/session/session.ts:816-820` `diff()` — 读取外部 `session_diff/` 文件，不受影响
- TUI 消息详情: 通过 `info()` 函数解压后可用

**Export**:
- `src/cli/cmd/export.ts:206` `diff("message-diff", msg.info.summary.diffs)` — 通过 `info()` 解压后可用

### CLI 设计

由方案 2 的 `opencode compress` (L1) 自动包含。

### 风险评估

| 风险 | 缓解 |
|------|------|
| diffs_blob 损坏 | content_store 事务保护；首次压缩前备份 |
| TUI 显示异常 | `info()` 正确注入；测试覆盖 |
| 旧版本读取 | `diffs_blob` 默认 NULL，`data.summary.diffs` 正常 |

### 测试策略

1. 提取后 TUI 显示文件变更正常
2. 提取后 `opencode export` 导出包含 diffs
3. 提取 → 恢复 → SHA-256 一致
4. 88 MB 怪物消息提取后正常显示
5. `computeDiff()` 不受影响 (不读取已存储 diffs)

---

## 方案 4: Fork 前缀引用化

### 针对根因
RC3 (fork 复制, 138 MB shared)

### 本机实测收益

| 维度 | 值 |
|------|-----|
| Fork 会话 | 28 |
| Fork parts 总量 | 233.42 MB |
| 与其他会话共享 | 137.83 MB (59.1%) |
| Fork 自有数据 | 95.59 MB |
| **方案 4 节省** | **137.83 MB** |

**与方案 1 (CAC 去重) 的叠加关系**: 方案 1 的 content-addressable 去重已自动消除 fork 复制的冗余 (相同 data → 相同 hash → 一份存储)。方案 4 的增量收益是减少 99,151 个 fork part 行的行开销 (每行 ~100B 元数据 = ~10 MB) 和查询时无需扫描 fork 前缀的 parts。

### 可逆性设计

**引用化**:
```
1. session 表记录 fork_source_session_id 和 fork_point_message_id
2. Fork 时不复制 parts/messages
3. 读取时: 若 fork_source_session_id 存在:
   a. 从源会话读取 fork_point 之前的消息+parts
   b. 从 fork 会话读取 fork_point 之后的消息+parts
   c. 合并返回
```

**展开** (恢复为完整副本):
```
1. 遍历 fork 会话在 fork_point 之前的所有消息 (从源会话读取)
2. 复制 parts/messages 到 fork 会话 (使用 Session.fork 的复制逻辑)
3. 清除 fork_source_session_id 和 fork_point_message_id
```

### Schema 变更

```sql
ALTER TABLE session ADD COLUMN fork_source_session_id TEXT;
-- 使用 ON DELETE RESTRICT 防止源会话被删除时 fork 丢失数据
-- 不使用 REFERENCES 约束 (避免 cascade 复杂性)，在应用层检查

ALTER TABLE session ADD COLUMN fork_point_message_id TEXT;
-- fork_point_message_id: 源会话中 fork 点的消息 ID (不复制此消息及之后的)
```

### 读写路径修改点

**Fork 创建**:
- `src/session/session.ts:734-774` `fork()` 函数 — 改为:
  ```ts
  const fork = Effect.fn("Session.fork")(function* (input) {
    const session = yield* createNext({ ... })
    // 不复制消息，仅记录引用
    yield* patch(session.id, {
      fork_source_session_id: input.sessionID,
      fork_point_message_id: input.messageID,
    })
    return session
  })
  ```

**消息读取**:
- `src/session/session.ts:822-841` `messages()` 函数 — 增加前缀解析:
  ```ts
  const messages = Effect.fn("Session.messages")(function* (input) {
    const session = yield* get(input.sessionID)
    if (session.fork_source_session_id) {
      // 读取源会话到 fork_point 的消息
      const sourceMsgs = yield* messagesFromSource(
        session.fork_source_session_id, 
        session.fork_point_message_id
      )
      // 读取 fork 会话自身的消息
      const ownMsgs = yield* ownMessages(input.sessionID)
      return [...sourceMsgs, ...ownMsgs]
    }
    return yield* ownMessages(input.sessionID)
  })
  ```

- `src/session/message-v2.ts` `page()` / `hydrate()` — 需处理跨会话查询

**源会话删除保护**:
- `src/session/session.ts` `remove()` 函数 — 删除前检查是否有 fork 引用:
  ```ts
  const forks = db.select().from(SessionTable)
    .where(eq(SessionTable.fork_source_session_id, sessionID)).all()
  if (forks.length > 0) {
    throw new Error(`Cannot delete session: ${forks.length} forks depend on it. 
      Run 'opencode expand --forks --session <id>' to detach forks first.`)
  }
  ```

**源会话不可变性保证**:
- Fork 创建后，源会话的 fork_point 之前消息不可修改/删除
- `removeMessage()` / `removePart()` / `updatePart()` / `updateMessage()` 检查是否有 fork 引用该消息
- 这是**语义变更**: 当前 fork 是不可变副本，引用化后变为共享前缀。但 fork 的语义是"从某个时间点分叉"，源会话在 fork 点之前的历史不应被修改（undo/redo 只影响 fork 点之后）

### CLI 设计

```bash
opencode expand --forks              # 展开所有 fork 引用
opencode expand --forks --session <id>  # 展开指定 fork
```

### 风险评估

| 风险 | 缓解 |
|------|------|
| 源会话被删除 | 应用层 ON DELETE RESTRICT；删除前检查 fork 依赖 |
| 源会话前缀被修改 | `removeMessage`/`removePart` 检查 fork 引用；fork 点之前不可变 |
| 跨会话查询性能 | 源会话数据可缓存；fork 点之前的数据通常不频繁访问 |
| 源会话 undo 影响 fork | undo 只影响 fork 点之后的消息 (语义保证) |

### 测试策略

1. Fork 后读取消息，前缀与源会话一致
2. Fork 后新增消息，不影响源会话
3. 尝试删除有 fork 的源会话 → 报错
4. 尝试删除 fork 点之前的消息 → 报错
5. `expand --forks` 后 parts 数据与引用模式一致
6. 源会话 undo 后 fork 不受影响 (undo 在 fork 点之后)

---

## 方案 5: 回溯截断大工具输出

### 针对根因
RC5 (截断 bypass, 40.52 MB 未截断)

### 本机实测收益

| 维度 | 值 |
|------|-----|
| 未截断大输出 (>16KB, 无 outputPath) | 1,956 parts, 40.52 MB |
| 截断后预览 (16KB head+tail) | ~30 MB |
| 外置到 tool-output/ | ~40 MB (保留期需延长) |
| **DB 节省** | **~10 MB** |
| **LLM 上下文节省** | ~10 MB (减少 token 消耗) |

> 收益较小。主要价值是减少 LLM 上下文 token 消耗，而非 DB 空间。

### 可逆性设计

**截断** (回溯):
```
1. 查询 output > 16KB 且无 outputPath 的 tool parts
2. 对每个 part:
   a. 将完整 output 写入 tool-output/tool_<ulid>
   b. 生成截断预览 (head 8KB + notice + tail 8KB) — 使用现有 Truncate.output() 逻辑
   c. UPDATE part SET data = json_set(data, '$.state.output', preview, '$.state.metadata.outputPath', filepath)
   d. UPDATE part SET data = json_set(data, '$.state.metadata.truncated', true)
```

**恢复**:
```
1. 查询有 outputPath 的 tool parts (回溯截断的)
2. 读取 tool-output/ 文件获取完整 output
3. UPDATE part SET data = json_set(data, '$.state.output', full_output)
4. UPDATE part SET data = json_remove(data, '$.state.metadata.outputPath')
```

**注意**: 回溯截断的文件需延长保留期。建议为回溯截断的文件使用单独目录 `tool-output/retroactive/`，不受 7 天保留期限制。

### 修改点

- 使用现有 `src/tool/truncate.ts` 的 `Truncate.output()` 和 `Truncate.write()` 逻辑
- CLI 命令调用现有函数处理旧数据
- 无代码变更

### CLI 设计

```bash
opencode truncate --retroactive [--session <id>] [--dry-run]
# 使用单独保留目录，不受 7 天清理
```

### 风险评估

| 风险 | 缓解 |
|------|------|
| tool-output/ 文件被清理 | 使用 `retroactive/` 子目录，不受 RETENTION 影响 |
| 截断后 LLM 缺少完整输出 | outputPath 可按需读取 |
| read bypass 设计意图 | read 不截断可能是故意的——仅对 bash/grep 等工具回溯截断 |

### 测试策略

1. 截断后 LLM 上下文构建正常
2. 通过 outputPath 可恢复完整输出
3. 截断 → 恢复 → SHA-256 一致
4. retroactive/ 文件不受 7 天清理

---

## 方案 6: VACUUM + auto_vacuum

### 针对根因
RC4 (auto_vacuum=0)

### 设计

```sql
-- 步骤 1: WAL checkpoint (将 WAL 数据写回主 DB)
PRAGMA wal_checkpoint(TRUNCATE);

-- 步骤 2: 启用 auto_vacuum (需 VACUUM 生效)
PRAGMA auto_vacuum = INCREMENTAL;

-- 步骤 3: VACUUM (重建数据库, 回收空间, 使 auto_vacuum 设置生效)
VACUUM;
```

### 修改点

- `src/storage/db.ts:104-110` — 新建 DB 时设置 `PRAGMA auto_vacuum = INCREMENTAL`
- CLI 命令执行 VACUUM

### CLI 设计

```bash
opencode vacuum              # 完整 VACUUM (需退出 opencode)
opencode vacuum --incremental  # 增量回收 (PRAGMA incremental_vacuum, 不锁库)
```

### 风险评估

| 风险 | 缓解 |
|------|------|
| VACUUM 锁库 | 提示退出 opencode；先执行 WAL checkpoint |
| 临时空间需求 | 检查磁盘空间；压缩后 DB 更小 |

---

## 方案 7: Snapshot ref 保护

### 针对根因
预防——防止 snapshot 被 GC 清理

### 设计

在 `src/snapshot/index.ts:304-310` `track()` 函数中，`git write-tree` 后创建 ref:

```bash
git update-ref refs/snapshots/<hash> <hash>
```

### 修改点

- `src/snapshot/index.ts:304-310` `track()` — 增加 `update-ref`
- `src/snapshot/index.ts:269-285` `cleanup()` — 不清理 `refs/snapshots/` 下的 ref (仅 gc 松散对象)

### CLI 设计

```bash
opencode snapshot --protect    # 为 DB 引用的 snapshot 创建 ref
opencode snapshot --status     # 显示存活/失效数量
opencode snapshot --prune <days>  # 清理 >N 天的 ref
```

### 风险评估

| 风险 | 缓解 |
|------|------|
| ref 积累 (64K+ refs) | 定期 `--prune`；git 对大量 ref 有优化 |
| 增加每次 snapshot 开销 | `update-ref` ~1ms |

---

## 方案 8: CLI 命令接口

### 设计

```bash
# 压缩
opencode compress [options]
  --level 1|2|3        压缩层级 (默认 1)
  --session <id>       仅指定会话
  --dry-run            预估不执行
  --verbose            详细输出
  --verify             校验所有压缩行
  --status             显示压缩状态

# 展开
opencode expand [options]
  --level 1|2|3        展开到层级
  --session <id>       仅指定会话
  --forks              展开 fork 引用
  --verbose            详细输出

# 截断
opencode truncate --retroactive [--session <id>] [--dry-run]

# VACUUM
opencode vacuum [--incremental]

# Snapshot
opencode snapshot --protect|--status|--prune <days>

# 综合状态
opencode db --status
```

### 修改点

- `src/cli/cmd/` — 新增 `compress.ts`, `expand.ts`, `truncate-cmd.ts`, `vacuum.ts`, `snapshot-cmd.ts`
- `src/cli/cmd/index.ts` — 注册新命令

### 测试策略

1. `--dry-run` 输出准确预估
2. `--status` 显示正确状态
3. `--verify` 校验所有压缩行
4. 中断后可重新运行 (幂等)
5. 各命令组合无冲突

---

## 组合实施建议

### 阶段 1 (最高优先级, 最低风险)
- 方案 3 (summary.diffs 提取) + 方案 6 (VACUUM)
- 预估节省: ~136 MB + 空间回收
- LLM 影响: 零
- 工作量: 1-2 天

### 阶段 2 (中等优先级)
- 方案 1+2 L2 (非活跃会话压缩)
- 预估额外节省: ~550 MB
- LLM 影响: 旧会话恢复 ~1-2s
- 工作量: 2-3 天

### 阶段 3 (可选)
- 方案 4 (fork 引用化) + 方案 7 (snapshot 保护)
- 预估额外节省: ~10 MB (行开销) + 预防数据丢失
- 工作量: 2-3 天

### 总收益预估

| 阶段 | 累计节省 | DB 预估 | LLM 影响 |
|------|---------|---------|---------|
| 原始 | — | 1574 MB | — |
| 阶段 1 | 136 MB | ~1438 MB | 零 |
| 阶段 2 | 686 MB | ~888 MB | 旧会话 |
| 阶段 3 | 696 MB | ~878 MB | 零额外 |
| 极限 (L3) | 949 MB | ~625 MB | 热路径 |
