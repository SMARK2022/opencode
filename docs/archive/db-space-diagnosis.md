# opencode.db 空间占用根因诊断

**机器**: Windows (本机)  
**DB 路径**: `C:\Users\Lenovo\.local\share\opencode\opencode.db`  
**DB 大小**: 1574.66 MB + 8.98 MB WAL  
**调查日期**: 2026-07-04  
**调查方法**: 只读 SQL 查询 (Python sqlite3 + bun:sqlite, 均 readonly mode)、代码追踪、内存压缩/hash 实验  

---

## 一、空间占用事实（本机 dbstat 实测页面统计）

### 1.1 按表页面占用（dbstat 虚拟表，非估算）

| 表/索引 | 页面数 | 大小 | 占比 |
|---------|--------|------|------|
| **part (表数据)** | 320,246 | **1250.96 MB** | **79.4%** |
| **message (表数据)** | 57,824 | **225.88 MB** | **14.3%** |
| part 索引 (3个) | 13,946 | 54.48 MB | 3.5% |
| request_usage_assistant + 索引 | 6,257 | 24.43 MB | 1.6% |
| message 索引 (1个) | 2,648 | 10.35 MB | 0.7% |
| session | 129 | 0.50 MB | <0.1% |
| 其他所有表+索引 | ~200 | ~0.8 MB | <0.1% |
| **总计** | **403,469** | **1576.05 MB** | 100% |

> 证据来源: Python sqlite3 3.53.2 的 `dbstat` 虚拟表，`SELECT name, COUNT(*), SUM(pgsize) FROM dbstat GROUP BY name`

### 1.2 part.data 按子类型分解（LENGTH 实测）

| Part 类型 | 数量 | 数据量 | 平均大小 | gzip 压缩率(实测) |
|-----------|------|--------|----------|------------------|
| tool | 101,613 | 812.51 MB | 8,389B | 20.9% |
| reasoning | 52,173 | 118.98 MB | 2,393B | 61.7% |
| text | 38,182 | 69.41 MB | 1,908B | 47.7% |
| file (base64) | 116 | 37.14 MB | 335,686B | 72.4% |
| step-finish | 63,660 | 23.70 MB | 391B | 11.9% |
| step-start | 64,944 | 15.45 MB | 250B | 0.9% |
| compaction | 323 | 2.62 MB | 8,491B | 48.9% |
| patch | 5,381 | 2.53 MB | 493B | 9.2% |

### 1.3 tool 部分按工具分解

| 工具 | 数量 | 数据量 | 平均大小 |
|------|------|--------|----------|
| read | 33,644 | 475.59 MB | 14,140B |
| bash | 28,866 | 160.49 MB | 5,558B |
| apply_patch | 5,493 | 50.73 MB | 9,233B |
| grep | 13,213 | 44.81 MB | 3,391B |
| edit | 7,464 | 40.06 MB | 5,366B |
| 其他 | 12,933 | 40.83 MB | varies |

### 1.4 message.data 按角色分解

| 角色 | 数量 | 数据量 | 其中 summary.diffs |
|------|------|--------|-------------------|
| user | 7,797 | 164.21 MB | 163.00 MB (1,344条) |
| assistant | 66,334 | 41.67 MB | N/A |

### 1.5 重复数据实测（MD5 hash 全量计算 326,458 个 part）

| 重复类别 | 重复组数 | 多余副本 | 浪费空间 |
|----------|----------|---------|----------|
| 全局 part 重复 | 28,068 | 71,908 | **142.74 MB** |
| Fork 复制 (28个fork) | — | 32,802 | **67.07 MB** |
| summary.diffs 重复 | 169 | 414 | 14.18 MB |

### 1.6 外部存储

| 目录 | 大小 | 文件数 |
|------|------|--------|
| snapshot/ (5个git仓库) | 49.98 MB | 211 |
| storage/session_diff/ | 114.97 MB | 845 (758空文件) |
| tool-output/ | 1.99 MB | 48 |

### 1.7 快照可用性验证

DB 引用 3,444 个唯一 snapshot hash。抽样 80 个检查：**仅 4 个存活，76 个已被 `git gc --prune=7.days` 清理 (95% 失效)**。

### 1.8 DB 元数据

- `auto_vacuum = 0` (不自动回收页面)
- `freelist_count = 0` (无空闲页)
- `sqlite_stat1` 不存在 (ANALYZE 从未运行)

---

## 二、冷热数据分类（代码追踪确认，非猜测）

通过追踪 `toModelMessagesEffect()` (`message-v2.ts:792-1090`) 确认每种 part 类型是否进入 LLM 上下文：

| 分类 | Part 类型 | 发送给 LLM? | 代码证据 | 本机数据量 |
|------|-----------|------------|---------|-----------|
| **HOT** (全文发送) | text | ✅ 全文 | message-v2.ts:865-869, 947-955 | 69.41 MB |
| **HOT** | tool | ✅ input+output | message-v2.ts:960-1035 | 812.51 MB |
| **HOT** | reasoning | ✅ 全文 | message-v2.ts:1036-1051 | 118.98 MB |
| **HOT** | file (base64) | ✅ url | message-v2.ts:871-885 | 37.14 MB |
| **HOT** (转换) | compaction | ✅ 转为文本 | message-v2.ts:887-902 | 2.62 MB |
| **WARM** (仅标记) | step-start | ⚠️ 仅 `{type:"step-start"}` | message-v2.ts:956-959 | 15.45 MB |
| **WARM** (仅标签) | subtask | ⚠️ 静态标签 | message-v2.ts:903-908 | ~0 |
| **COLD** (不发送) | step-finish | ❌ 无handler | 无if块 | 23.70 MB |
| **COLD** | patch | ❌ 无handler | 无if块; revert.ts:55 | 2.53 MB |
| **COLD** | agent | ❌ 无handler | 无if块 | ~0 |
| **COLD** | summary.diffs | ❌ 不在parts中 | summary.ts:153; 不在toModelMessages | 163.00 MB |

**HOT parts**: 1042.68 MB (text+tool+reasoning+file+compaction)  
**WARM parts**: 15.50 MB (step-start, subtask) — 发送结构性标记但不发送内容  
**COLD parts**: 26.31 MB (step-finish+patch+agent) — 不进入 LLM 上下文  
**COLD message data**: 167.83 MB (summary.diffs) — 不进入 LLM 上下文  
**Total non-HOT**: **209.64 MB** (WARM+COLD parts+COLD diffs)

> 注意: summary.diffs 存储在 `message.data` JSON 中，不是 part。上表 COLD parts 不含 diffs。两者相加为 209.64 MB。

### 补充: tool part 的 state.output vs 完整 data 分解

| 维度 | 数据量 | 说明 |
|------|--------|------|
| tool parts 完整 `data` 列 | 812.51 MB | 包含 output + input + metadata + JSON 结构开销 |
| tool parts `state.output` 字段 | 295.65 MB | 实际工具输出文本（文件内容/命令输出） |
| 差额 (JSON开销+input+metadata) | 516.86 MB | JSON 包装、state.input（工具参数）、callID、tool名等 |

> 证据: `SELECT SUM(LENGTH(json_extract(data, '$.state.output'))) FROM part WHERE type='tool'` = 295.65 MB

---

## 三、根因诊断

### 根因 1: 工具输出内联存储无压缩（812 MB，占DB 51.6%）

**症状**: tool parts 占 812.51 MB (完整 data 列)，其中 `state.output` 字段 295.65 MB，JSON 结构+input+metadata 开销 516.86 MB。read 工具占 475.59 MB。

**根因**: 
- `read` 工具 (`read.ts:537,809-823`) 将文件内容包装为 XML 格式 (`<content>...</content>`)，直接存入 `part.data.state.output`
- `bash` 工具 (`shell.ts:838,1030-1071`) 将命令输出存入 `part.data.state.output`
- 存储为未压缩 JSON 文本，实测各工具 gzip 压缩率: read=36.6%, bash=8.2%, grep=20.8%, apply_patch=8.8%, edit=9.5%

**各工具 state.output 实测分解**:

| 工具 | 数量 | state.output 总量 | output >16KB | 有截断文件 |
|------|------|-------------------|-------------|-----------|
| read | 33,730 | 187.23 MB | 1,736 | 0 |
| bash | 28,900 | 52.99 MB | 733 | 1,607 |
| grep | 13,255 | 34.99 MB | 70 | 0 |
| glob | 4,842 | 7.16 MB | 1 | 0 |
| task | 649 | 3.34 MB | 23 | 33 |
| apply_patch | 5,493 | 0.50 MB | 0 | 0 |
| edit | 7,481 | 0.30 MB | 0 | 0 |
| 其他 | 12,440 | 9.14 MB | 49 | 77 |
| **合计** | **101,790** | **295.65 MB** | **2,612** | **1,717** |

> read 工具是 state.output 最大贡献者 (187 MB)，且 1,736 个 parts 超过 16KB 但 0 个有截断文件——read 工具的输出从未被外置到 tool-output/。
- **截断机制仅部分生效**（详见下方截断分析）

**截断机制分析（本机实测）**:

存储时截断 (`Truncate.output()`, `truncate.ts:16-17`, MAX_LINES=1000, MAX_BYTES=16384):
- 2,612 个 tool parts 的 `state.output` 超过 16KB 阈值（应被截断），总计 53.38 MB
- 仅 1,717 个 parts 有 `metadata.outputPath`（实际截断到文件）
- **直接查询**：1,956 个 parts 的 `state.output` > 16KB 且无 `outputPath`（40.52 MB）——这些是超过阈值但未被截断的
- `metadata.truncated` 短路机制 (`tool.ts:149`): `result.metadata.truncated !== undefined` 时跳过 `Truncate.output()`。本机实测：
  - read 工具：382 parts `metadata.truncated=null`（走截断路径），12,680 parts `=0`（bypass），20,679 parts `=1`（bypass）——**read 始终设置此标记**，`Truncate.output()` 对 read 结果几乎从不生效
  - 这就是 read 有 0 个 `outputPath` 但 1,736 个 parts 超过 16KB 的原因——read 通过 bypass 跳过了 `Truncate.output()`，使用自身更大的截断阈值
- `tool-output/` 目录仅 48 文件 / 1.99 MB，但 `RETENTION = 7.days` (`truncate.ts:14`)，旧截断文件已被清理

**未截断大输出按工具分解**:

| 工具 | output>16KB且无outputPath | state.output 总量 |
|------|--------------------------|-------------------|
| read | 1,736 | 35.06 MB |
| bash | 121 | 2.44 MB |
| grep | 70 | 2.42 MB |
| 其他 | 29 | 0.60 MB |
| **合计** | **1,956** | **40.52 MB** |

上下文构建时截断 (`truncateToolOutput()`, `message-v2.ts:398-406`):
- 仅在 compaction 模式下生效（`headChars`/`tailChars` 均 undefined 时返回原文），对 `state.output` 做 head/tail 字符截限
- 可通过 `state.time.compacted` 标记完全清除工具输出（替换为 notice, `message-v2.ts:963-964`）
- **本机实测: 0 个 tool parts 设置了 `state.time.compacted`**——compaction 从未在本机使用

**结论**: 截断机制存在两层（存储时 + 上下文构建时），但存储时截断因 `metadata.truncated` bypass 对 read 工具完全失效（read 是最大输出贡献者），上下文构建时截断从未触发。即使截断完全生效，未压缩的 JSON 文本仍然膨胀。

**增长机制**: 每次 read/bash/grep 调用都产生一条新 part，文件内容被重复存储（同一文件被多次读取 = 多份副本）。本机 142.74 MB 全局重复中大部分来自 read 工具读取相同文件。

**排除的假想路径**: 
- "截断阈值太高"不是根因——即使阈值降至 4KB，旧数据不受影响（非回溯），且 read 工具的 XML 格式本身冗余
- "read 工具设计有问题"不是根因——read 工具需要返回文件内容给 LLM，问题是存储时未压缩/去重

### 根因 2: summary.diffs 内联存储且不可重算（163 MB，占DB 10.4%）

**症状**: 1,344 条 user 消息内联 163.00 MB 的文件 diff 数据，最大单条 88.73 MB。

**根因**:
- `SessionSummary.summarize()` (`summary.ts:128-155`) 在每次 LLM step 后异步执行，计算文件 diff 并写入 `message.data.summary.diffs` (summary.ts:153)
- diff 计算依赖 `snapshot.diffFull(from, to)` (summary.ts:111)，from/to 来自 step-start/step-finish 的 snapshot hash
- snapshot hash 指向 `git write-tree` 创建的 **dangling tree 对象** (snapshot/index.ts:304)，无 ref 引用
- `git gc --prune=7.days` (snapshot/index.ts:274) 每小时运行，清理 7 天前的 dangling 对象
- **本机实测 95% 的 snapshot 已被清理** → diffs 无法重算 → 消息内联是唯一副本

**增长机制**: 每次用户消息（prompt提交）后，系统计算该 turn 的文件改动并存入消息数据。88 MB 怪物消息来自 "检查本地分支与 upstream/dev 差异" 会话，diff 包含 8,879 个文件——整个代码库的差异。

**排除的假想路径**:
- "diffs 可以从快照重算"——本机证据表明 95% 快照已失效，不成立
- "可以外置到 storage/ 目录"——session_diff 外部文件已有 115 MB，且用户可能清理；消息内联是唯一可靠副本

### 根因 3: 无内容寻址去重（142.74 MB 浪费）

**症状**: 28,068 组重复 part data，71,908 个多余副本，浪费 142.74 MB。

**根因**:
- `part.data` 列存储完整 JSON 文本，无 hash 去重
- `Session.fork` (`session.ts:734-774`) 逐条复制父会话所有消息和 parts，`{ ...part, id, messageID, sessionID }` 展开**逐字节复制** data 字段
- 本机 28 个 fork 浪费 67.07 MB（部分 fork 共享率 96-100%）
- 跨会话读取相同文件（read 工具）产生完全相同的 part data 但各自独立存储

**增长机制**: 每次 fork 或重复读取同一文件都产生新行，data 内容完全相同但独立存储。

### 根因 4: auto_vacuum=0 导致空间不回收

**症状**: DB 文件 1574 MB，freelist_count=0。

**根因**:
- `db.ts:106-108` 设置 `PRAGMA journal_mode = WAL` 和 `PRAGMA synchronous`，但未设置 `PRAGMA auto_vacuum`
- SQLite 默认 `auto_vacuum=0`（本机实测确认）
- 即使删除/压缩数据，DB 文件不会自动缩小，需手动 `VACUUM`

**影响**: 优化方案如果不配合 VACUUM，DB 文件大小不会减小。

### 根因 5: 截断机制对 read 工具完全失效且不回溯（contributing factor to RC1）

**症状**: 1,956 个 tool parts 的 `state.output` 超过 16KB 阈值且无截断文件（40.52 MB），其中 read 工具占 1,736 个（35.06 MB）。0 个 parts 被 compaction 清除。

**根因**: 
- `Truncate.output()` (`truncate.ts:82-127`) 仅在 `Tool.wrap` (`tool.ts:149-156`) 执行时调用一次，**不回溯处理旧数据**
- `metadata.truncated` 短路 (`tool.ts:149`): `result.metadata.truncated !== undefined` 时跳过 `Truncate.output()`。本机实测 read 工具在当前代码中始终设置此标记（0 或 1），**read 结果几乎从不经过 `Truncate.output()`**（仅 382 个历史遗留 parts 的 `metadata.truncated` 为 null，走截断路径）——这是 read 有 0 个 `outputPath` 但 1,736 个 parts 超过 16KB 的直接原因
- 上下文构建时截断 (`truncateToolOutput`, `message-v2.ts:398-406`) 仅在 compaction 模式下生效——本机 compaction 从未使用（0 个 compacted parts）

**与 RC1 的关系**: 这是 RC1（工具输出无压缩）的 contributing factor。read 工具通过 bypass 跳过截断，导致 35.06 MB 未截断的大输出直接存入 DB。但即使截断完全生效，未压缩的 JSON 文本仍然膨胀。收益预估不单独计算（已包含在 RC1 的压缩收益中）。

**排除的假想路径**:
- "降低阈值即可解决"——不成立，read 通过 bypass 跳过 `Truncate.output()`，阈值对 read 无效
- "tool-output/ 文件少证明截断未发生"——不成立，7天保留期 (`RETENTION = 7.days`) 会清理旧截断文件

---

## 四、显式排除的假想路径

| 假想根因 | 排除理由 |
|---------|---------|
| session_diff 外部文件过大导致 DB 膨胀 | session_diff 在文件系统不在 DB 中；DB 中 session.summary_diffs 列实测为空 (0 sessions) |
| request_usage 表占用大 | 实测 request_usage_assistant 仅 11.11 MB (0.7%)，request_usage 仅 1.57 MB |
| 索引过多导致膨胀 | 索引总计 82 MB (5.2%)，不是主要问题 |
| event/session_message 表膨胀 | event=0行, session_message=748行/0.07 MB |
| WAL 文件过大 | WAL 仅 8.98 MB，checkpoint 正常 |
| 碎片化问题 | freelist_count=0，无碎片 |

---

## 五、根因优先级排序

| 排名 | 根因 | 占用 | 可优化空间 | 影响 |
|------|------|------|-----------|------|
| 1 | 工具输出内联无压缩 (RC1+RC5) | 812 MB | ~640 MB (压缩) | LLM 热路径 |
| 2 | summary.diffs 内联不可重算 | 168 MB | ~137 MB (压缩) | 冷数据，零影响 |
| 3 | 无内容寻址去重 | 143 MB | ~143 MB (去重，与压缩叠加收益递减) | 与压缩叠加 |
| 4 | auto_vacuum=0 | 0 MB (但阻碍回收) | 需配合VACUUM | 实施必需 |

> 注: RC5（截断不完整）是 RC1 的 contributing factor，不单独计算收益。RC1+RC3 有重叠——去重收益是压缩收益的子集（相同内容压缩后仍占空间，去重消除冗余副本）。

---

## 六、会话活跃度分布

| 活跃度 | 会话数 | Part 数据 | 消息数据 | summary.diffs | 合计 |
|--------|--------|-----------|---------|---------------|------|
| 今天 (<1d) | 11 | 60.40 MB | 9.21 MB | 4.65 MB | 74.26 MB |
| 本周 (1-7d) | 90 | 45.90 MB | 12.61 MB | 9.13 MB | 67.64 MB |
| 本月 (7-30d) | 336 | 382.87 MB | 130.27 MB | 119.92 MB | 633.06 MB |
| >30d | 469 | 593.89 MB | 53.85 MB | 29.30 MB | 677.04 MB |

**52% 的会话超过 30 天未活跃**，占用 677 MB (43%)。这些会话的数据几乎不会被访问，是压缩的理想目标。
