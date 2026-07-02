# 完整方案：Overlap Suppress 调整 + Stub 引导式文案 + Edit Closest Match 字符级 diff

## 1. 已阅读的文件/测试/文档

### 源文件（完整阅读，非抽样）
| 文件 | 行范围 | 为什么相关 |
|---|---|---|
| `src/tool/read.ts` L20-32 | 常量定义区 | `OVERLAP_SUPPRESS_RATIO=0.8` 需改为 0.95 |
| `src/tool/read.ts` L74-98 | `ReadStubStatus` 类型 + `ReadMetadata` 类型 + `ReadToolMetadata` 类型 | suppress 分支设置的 `stub: true` + `stubStatus` + `coveredBy` 字段 |
| `src/tool/read.ts` L126-131 | `readToolMetadata` 函数 | 所有 return 分支共用同一 metadata shape |
| `src/tool/read.ts` L184-200 | `isReadMetadata` 类型守卫 | 验证 `stub: boolean` 字段存在 |
| `src/tool/read.ts` L202-222 | `collectVisibleReads` | 收集同 canonicalPath 的非 stub、非 compacted reads——**不过滤版本** |
| `src/tool/read.ts` L224-237 | `findReadStub` | 100% overlap suppress（same range / covering range），做同版本 filter |
| `src/tool/read.ts` L239-255 | `findOverlapNote` | 部分重叠检测，做同版本 filter，返回 best 单区间 `"start-end"` |
| `src/tool/read.ts` L300-344 | `renderReadStub` | stub 输出格式 + nextOffset 逻辑 |
| `src/tool/read.ts` L680-748 | suppress 执行分支 | `findReadStub` → overlap suppress → 正常 read |
| `src/tool/edit.ts` L1-15 | import 区 | 已导入 `diffLines`，需新增 `diffChars` |
| `src/tool/edit.ts` L725-758 | `findClosestMatch` + `charOverlap` | 当前 excerpt 截断 `.slice(0, 500)` |
| `src/tool/edit.ts` L790-803 | error 构造 | `closest.excerpt` 直接拼入 error message |
| `src/tool/task.ts` L38-55 | `buildParentInspectedFilesSummary` stub 过滤 | `m.stub === true → continue`（跳过 high_overlap_visible） |
| `src/session/compaction.ts` L399-401 | `renderInspectedFiles` stub 过滤 | `read.stub === true → continue`（同上） |
| `src/util/range.ts` | `mergeRanges` | `computeNewRanges` 应复用 |

### 测试文件
| 文件 | 行范围 | 为什么相关 |
|---|---|---|
| `test/tool/edit.test.ts` L239-256 | 现有 closest match 测试 | 断言 `error.message.toContain("actual content")`——需验证新 diff 格式是否破坏 |
| `test/tool/read.test.ts` L987-1008 | 现有 overlap 测试 | 需新增 95% 阈值 + 引导式文案测试 |

### 依赖确认
| 确认项 | 结果 |
|---|---|
| `diffChars` 是否在 `diff` 包中导出 | **是**——`node_modules/diff/libcjs/index.d.ts` L17 导出 `diffChars` |
| `diff` 包版本 | 8.0.2 |
| `Change` 类型 | `{ value: string, added: boolean, removed: boolean, count: number }` |
| `diffLines` `change.value` 是否可含多行 | **是**——连续同类型行合并为一个 change，`value` 含 `\n` |
| `diffLines` `oneChangePerToken` 选项 | **是**——设为 `true` 时每个 change 恰好一行 |

## 2. 当前逻辑职责边界和必须保持的既有行为

### 必须保持
| 行为 | 位置 | 原因 |
|---|---|---|
| `findReadStub` 的 100% overlap suppress | read.ts L224-237 | 完全冗余读取，suppress 合理 |
| `findOverlapNote` 的 note 逻辑（< 95% 时显示 note 不 suppress） | read.ts L239-255 | 部分重叠仍需 note 提示 |
| `collectVisibleReads` 不做版本过滤 | read.ts L202-222 | 版本过滤在 findReadStub/findOverlapNote 各自做 |
| `stub: true` 布尔标志 | read.ts L720, L686 | task.ts 和 compaction.ts 按 `stub === true` 过滤 |
| `charOverlap` 匹配算法 | edit.ts L751-758 | findClosestMatch 的核心匹配逻辑不变 |
| edit 的所有 replacer 逻辑 | edit.ts L260-724 | 不受影响 |
| `renderReadStub` 的 nextOffset 逻辑 | read.ts L300-344 | findReadStub 分支仍用它 |

### 需要修改
| 行为 | 位置 | 修改内容 |
|---|---|---|
| `OVERLAP_SUPPRESS_RATIO = 0.8` | read.ts L32 | → 0.95 |
| suppress 分支文案 | read.ts L714-747 | "do NOT re-read" → 引导式 "Read offset=X limit=N" |
| `findClosestMatch` excerpt | edit.ts L746 | `.slice(0, 500)` 原始 code → diffChars 字符级 diff |
| task.ts L47-48 陈旧注释 | task.ts | 注释说"保留"但代码 `m.stub === true → continue` 跳过——修正注释 |

## 3. 推荐的最小实现方案

### 改动 1：阈值 0.8 → 0.95

**文件**：`src/tool/read.ts` L32

```typescript
// [local-smark] 高重叠 suppress 阈值：95% 时 suppress。
// 80% 过于激进——20% 新内容被抑制可能导致模型缺失关键行。
// 95% 意味着仅 5% 新内容被抑制（200 行请求中仅 10 行），
// 且 stub 文案会明确引导模型读取新内容（见 computeUnreadRanges）。
const OVERLAP_SUPPRESS_RATIO = 0.95
```

### 改动 2：Stub 引导式文案 + computeUnreadRanges

**文件**：`src/tool/read.ts`

新增局部函数 `computeUnreadRanges`：

```typescript
// [local-smark] 计算请求范围内未被任何同版本已可见读取覆盖的行区间。
// 复用 mergeRanges（src/util/range.ts）合并已覆盖区间后再做减法。
// 必须做同版本 filter（size+modifiedMs）——collectVisibleReads 不过滤版本，
// findOverlapNote/findReadStub 各自过滤。此处也必须过滤，否则会减算旧版本区间，
// 错误地告诉模型"这些行没读过"。
function computeUnreadRanges(
  visibleReads: ReadMetadata[],
  current: ReadMetadata,
): Array<{ start: number; end: number }> {
  // 1. 收集同版本 visible reads 的区间
  const covered = visibleReads
    .filter((r) => r.size === current.size && r.modifiedMs === current.modifiedMs)
    .map((r) => ({ start: r.start, end: r.end }))
  if (covered.length === 0) return [{ start: current.start, end: current.end }]
  // 2. 合并已覆盖区间
  const merged = mergeRanges(covered)
  // 3. 从请求范围中减去已覆盖区间，得到未覆盖部分
  const unread: Array<{ start: number; end: number }> = []
  let pos = current.start
  for (const m of merged) {
    if (m.start > pos) unread.push({ start: pos, end: Math.min(m.start - 1, current.end) })
    pos = Math.max(pos, m.end + 1)
    if (pos > current.end) break
  }
  if (pos <= current.end) unread.push({ start: pos, end: current.end })
  return unread
}
```

需新增 import：`import { mergeRanges } from "@/util/range"`

修改 suppress 分支（L714-747）的 message 构造：

```typescript
if (overlapLines / requestedLines >= OVERLAP_SUPPRESS_RATIO) {
  const read = { ...current, returned: 0, stub: true, stubStatus: "stub_high_overlap_visible" as const, coveredBy: overlapRange }
  // [local-smark] 引导式文案：告诉模型哪些行是新的、如何精确读取
  const unread = computeUnreadRanges(visibleReads, current)
  const message = unread.length === 0
    ? `Lines ${start}-${end} fully covered by visible reads (same version, file unchanged); no new content to read.`
    : `Lines ${start}-${end} requested; lines ${overlapRange} already visible (same version, file unchanged).\n` +
      `New unread lines: ${unread.map((r) => `${r.start}-${r.end}`).join(", ")}.` +
      ` Read offset=${unread[0]!.start} limit=${unread[0]!.end - unread[0]!.start + 1} for just the new content.`
  const output = [
    `<path>${escapeXmlText(filepath)}</path>`,
    `<type>file</type>`,
    `<file size="${size}" modified="${escapeXmlAttr(modified)}" />`,
    `<range start="${start}" end="${end}" total="${file.count}" returned="0" />`,
    `<stub status="stub_high_overlap_visible" covered_by="${overlapRange}">`,
    message,
    "</stub>",
  ].join("\n")
  return { title, output, metadata: readToolMetadata({ preview: output, truncated: false, loaded: [] as string[], read }) }
}
```

### 改动 3：Edit closest match 字符级 diff

**文件**：`src/tool/edit.ts`

新增 import：`import { createTwoFilesPatch, diffLines, diffChars } from "diff"` + `import type { Change } from "diff"`（L10 扩展）

重写 `findClosestMatch` 的 excerpt 构造（L743-747）：

```typescript
// [local-smark] 字符级 diff：diffLines 定位差异行，diffChars 显示字符级差异。
// 解决长行场景下 .slice(0,500) 截断导致 ]; vs }; 不可见的问题。
// diffLines 的 change.value 可含多行，用 oneChangePerToken 确保每个 change 一行。
function formatClosestMatchDiff(
  oldString: string,
  fileExcerpt: string,
  fileStartLine: number,
  maxChars: number,
): string {
  // pendingRemoved 必须在函数内声明——跨调用持久化会导致配对错误
  const pendingRemoved: string[] = []
  // 用 oneChangePerToken 获取逐行 change，便于精确配对
  const changes = diffLines(oldString, fileExcerpt, { oneChangePerToken: true })
  const parts: string[] = []
  let oldIdx = 0
  let newIdx = 0
  let totalChars = 0
  let diffLineCount = 0
  let totalLineCount = 0
  let totalDiffLines = 0
  // 先统计差异行比例，决定是否回退
  for (const c of changes) {
    const lineCount = c.value.split("\n").filter((l) => l.length > 0).length
    totalLineCount += lineCount
    if (c.added || c.removed) diffLineCount += lineCount
  }
  // 差异行 > 60% → 结构严重错位，回退 head+tail excerpt
  if (totalLineCount > 0 && diffLineCount / totalLineCount > 0.6) return ""

  for (const change of changes) {
    const lines = change.value.split("\n").filter((l) => l.length > 0)
    if (change.added) {
      // 文件中的行——与上一个 removed 行做 diffChars
      for (const line of lines) {
        const oldLine = pendingRemoved.shift()
        if (oldLine !== undefined) {
          // diffChars 只输出变化片段，自然紧凑
          const charDiff = diffChars(oldLine, line)
          const formatted = formatCharDiffLine(fileStartLine + newIdx, oldLine, charDiff, 40)
          if (formatted && totalChars + formatted.length < maxChars) {
            parts.push(formatted)
            totalChars += formatted.length + 1
          } else {
            totalDiffLines++
          }
        }
        newIdx++
      }
    } else if (change.removed) {
      // oldString 中的行——暂存，等待下一个 added 配对
      for (const line of lines) { pendingRemoved.push(line); oldIdx++ }
    } else {
      // 未变化行——跳过（不占用预算），只推进行号
      oldIdx += lines.length
      newIdx += lines.length
    }
  }
  if (parts.length === 0) return ""
  // 截断标记：预算耗尽时告知模型还有更多差异
  if (totalDiffLines > 0) parts.push(`...(+${totalDiffLines} more diff lines)`)
  return parts.join("\n")
}
```

`formatCharDiffLine` 辅助函数：

```typescript
// [local-smark] 格式化单行字符级 diff：只输出变化片段 + 两侧 context。
// 例：行末 }; vs ]; → "line 41: ...[:300])\n\"",\n    [-}+];"
// 不输出 900 字符公共前缀，信息密度极高。
// charDiff 是 diffChars 返回的 Change[]——{ value, added, removed, count }
function formatCharDiffLine(
  lineNum: number,
  oldLine: string,
  charDiff: Change[],
  contextChars: number,
): string | undefined {
  // 找到第一个变化位置
  let prefixLen = 0
  for (const c of charDiff) {
    if (c.added || c.removed) break
    prefixLen += c.value.length
  }
  if (prefixLen >= oldLine.length) return undefined // 无差异（oldLine 全部在前缀中）
  // 提取变化点前后的 context（从 oldLine 取，因为 oldLine 是模型提供的、模型认得的内容）
  const ctxStart = Math.max(0, prefixLen - contextChars)
  const ctxEnd = Math.min(oldLine.length, prefixLen + contextChars)
  const context = oldLine.slice(ctxStart, ctxEnd)
  // 找到变化部分
  let oldPart = ""
  let newPart = ""
  for (const c of charDiff) {
    if (c.removed) oldPart += c.value
    else if (c.added) newPart += c.value
  }
  if (!oldPart && !newPart) return undefined
  return `line ${lineNum}: ...${context} [-${oldPart}+${newPart}]`
}
```

修改 `findClosestMatch` 返回值构造（L743-747）：

```typescript
if (bestLine < 0 || bestScore < 0.3) return undefined
const oldLineCount = oldLines.length
const fileStart = Math.max(0, bestLine - 1)
// [local-smark] 窗口按 oldString 行数缩放：确保 fileExcerpt 覆盖 oldString 对应区域
const fileEnd = Math.min(contentLines.length, bestLine + oldLineCount + 2)
const fileExcerpt = contentLines.slice(fileStart, fileEnd).join("\n")
// 优先用字符级 diff（信息密度高）；回退时用 head+tail excerpt
const diffExcerpt = formatClosestMatchDiff(oldString, fileExcerpt, fileStart + 1, 500)
const excerpt = diffExcerpt || (() => {
  const full = fileExcerpt
  return full.length <= 500 ? full : full.slice(0, 200) + `\n...[${full.length - 400} chars omitted]...\n` + full.slice(-200)
})()
return { line: fileStart + 1, excerpt }
```

### 改动 4：修正 task.ts 陈旧注释

**文件**：`src/tool/task.ts` L47-48

```typescript
// 旧注释（与代码矛盾）：
// stub: true 表示 read 被完全抑制（如 high overlap suppress），跳过；
// stub: "high_overlap_visible" 保留——它记录了文件已被读过的事实

// 新注释（与代码一致）：
// stub: true 表示 read 被抑制（same range / covered range / high overlap），
// 这些 read 没有实际内容输出，不纳入 parent context 的文件列表。
```

## 4. 预计修改/新增/删除的文件

| 文件 | 操作 | 改动 |
|---|---|---|
| `src/tool/read.ts` | 修改 | L32 阈值 0.8→0.95；新增 `computeUnreadRanges` 函数（~20 行）；新增 `mergeRanges` import；L714-747 message 改为引导式 |
| `src/tool/edit.ts` | 修改 | L10 新增 `diffChars` import；L725-758 `findClosestMatch` excerpt 改为 diffChars 格式；新增 `formatClosestMatchDiff` + `formatCharDiffLine`（~50 行） |
| `src/tool/task.ts` | 修改 | L47-48 注释修正（2 行） |
| `test/tool/read.test.ts` | 修改 | 新增 95% 阈值 + 引导式文案 + 多区间全覆盖 + 同版本 filter 测试（~50 行） |
| `test/tool/edit.test.ts` | 修改 | 新增字符级 diff + 长行 + 回退 + 单行测试（~40 行） |

## 5. 正常路径、错误路径、安全边界

### 正常路径
- **95%+ overlap**：suppress + 引导式文案（"Read offset=X limit=N for just the new content"）
- **< 95% overlap**：显示 note，不 suppress
- **edit 不匹配 + 长行单字符差异**：diffChars 显示 `[-}+];`，500 字符内可见
- **edit 不匹配 + 短行差异**：diffChars 显示差异片段 + context

### 错误路径
- `computeUnreadRanges` 返回空（多区间联合全覆盖）→ "no new content to read"
- `formatClosestMatchDiff` 差异行 > 60% → 回退 head+tail excerpt
- `formatClosestMatchDiff` 无差异 → 回退 head+tail excerpt
- `diffChars` 输出超 500 字符 → 截断 + `...(+N more)`

### 并发/退出/清理
- 无新增并发问题——`computeUnreadRanges` 是纯函数
- `diffChars`/`diffLines` 是纯函数，无副作用

### 安全边界
- `computeUnreadRanges` 的同版本 filter 是正确性红线——遗漏会导致错误引导
- `stub: true` 标志不变 → task.ts/compaction.ts 行为不变
- `diffChars` 不执行任何 I/O，无安全风险
- 回退策略确保任何 diff 异常都不会导致空 error message

## 6. 行为级测试计划

### read.test.ts 新增（7 个）

1. **95% overlap suppress 触发**：请求 1-200，已读 1-190（95%）→ suppress，文案含 "New unread lines: 191-200" 和 "Read offset=191 limit=10"
2. **94% overlap 不 suppress**：请求 1-200，已读 1-188（94%）→ 不 suppress，正常 read + overlap note
3. **引导式文案——尾部新内容**：请求 1-250，已读 1-200 → "New unread lines: 201-250. Read offset=201 limit=50"
4. **引导式文案——头部新内容**：请求 1-250，已读 50-250 → "New unread lines: 1-49"
5. **引导式文案——两端新内容**：请求 1-250，已读 50-200 → "New unread lines: 1-49, 201-250"
6. **多区间联合全覆盖→空回退**：请求 1-200，已读 1-190 + 191-200 → "no new content to read"
7. **同版本 filter**：visible reads 含旧版本（size/modifiedMs 不同）→ computeUnreadRanges 不减算旧版本区间

### edit.test.ts 新增（5 个）

1. **字符级 diff 显示差异**：oldString 多行（3 行，末行 `};`），文件末行 `];` → 差异行比例 1/4 < 60% → 走 diff 路径 → error 含 `[-}+];`
2. **长行不截断关键差异**：oldString 含 900 字符行末尾 `};`（多行 oldString，其余行精确匹配），文件含相同行末尾 `];` → diff 只显示 `}` → `]` 的变化，不含 900 字符公共前缀
3. **回退策略**：oldString 与文件结构严重错位（>60% 行不同）→ error 含 head+tail excerpt（200+200 字符）
4. **diff 截断标记**：差异行很多，超出 500 字符 → 末尾含 `...(+N more diff lines)`
5. **现有测试不破坏**：`error includes closest match when oldString not found`——oldString `"actual contnet"` 单行 vs fileExcerpt 多行 → 差异比例 > 60% → 回退 head+tail → excerpt 含 `"actual content"`（测试通过，但走的是回退路径而非 diff 路径）

## 7. 建议运行的验证命令

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test --timeout 30000 test/tool/read.test.ts
cd packages/opencode && bun test --timeout 30000 test/tool/edit.test.ts
cd packages/opencode && bun test --timeout 60000 test/tool/
cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts
cd packages/opencode && bun test --timeout 30000 test/session/compaction.test.ts
```

## 8. 预估 git 文件数、增删行数

| 文件 | 增/删 |
|---|---|
| `src/tool/read.ts` | +30 / -12 |
| `src/tool/edit.ts` | +60 / -5 |
| `src/tool/task.ts` | +2 / -2 |
| `test/tool/read.test.ts` | +50 |
| `test/tool/edit.test.ts` | +40 |
| **合计** | +182 / -19 |

不涉及：生成文件、迁移、新依赖（`diffChars` 已在 `diff@8.0.2` 中）。

## 9. 真实风险与开放问题

### 风险

1. **95% 阈值后 suppress 极少触发**：历史数据仅 1 个 83% 数据点。改到 95% 后，在已观测数据范围内 suppress 不会触发。引导式文案可能成为死代码。**缓解**：上线后观察 suppress 触发频率；如果确实极少触发，考虑降低到 90%。
2. **`diffChars` 在行结构差异大时产出噪声**：通过 >60% 差异行回退策略兜底。回退后使用 head+tail excerpt（200+200 字符），仍比当前纯 head 500 字符更好。
3. **`pendingRemoved` 配对逻辑**：`diffLines` 的 removed 和 added change 不保证严格交替。如果连续多个 removed 后跟一个 added（多行删除→单行新增），`pendingRemoved.shift()` 只配对第一行。**缓解**：未配对的 removed 行被跳过，不影响正确性（只是少显示一些差异）。**注意**：`pendingRemoved` 必须在函数内声明，不能在函数外（否则跨调用持久化导致配对错误）。
4. **单行 oldString 永远走回退**：单行 oldString vs 多行 fileExcerpt → 差异比例 > 60% → 回退 head+tail。这是预期行为——单行 oldString 不匹配时，diff 无法提供额外信息，head+tail excerpt 更有用。
5. **`fileEnd` 从固定 `bestLine+4` 改为 `bestLine+oldLineCount+2`**：对长 oldString，excerpt 更大，无匹配行更多，更容易触发回退。但回退后 head+tail 仍可用，不影响正确性。
6. **task.ts 注释修正**：仅改注释，不改代码行为。

### 已确认
- `diffChars` 和 `diffLines` 都在 `diff@8.0.2` 中导出，edit.ts 已导入 `diffLines`，新增 `diffChars` + `type Change` import 即可
- `mergeRanges` 在 `src/util/range.ts` 已有，read.ts 新增 import 即可
- `collectVisibleReads` 不做版本过滤——`computeUnreadRanges` 必须自己做（与 findReadStub:228 / findOverlapNote:242 一致）
- `findOverlapNote` 只返回 best 单区间——`computeUnreadRanges` 用全部同版本区间（口径不一致是有意的：决策保守、引导精确）
- `stub: true` 标志不变 → task.ts L49 `m.stub === true → continue` 和 compaction.ts L401 `read.stub === true → continue` 行为不变
- `diffLines` `oneChangePerToken: true` 选项确保每个 change 恰好一行（`node_modules/diff/libcjs/types.d.ts:24-26` 确认）
- `Change` 类型：`{ value: string, added: boolean, removed: boolean, count: number }`——需 `import type { Change } from "diff"`
- `pendingRemoved` 必须在 `formatClosestMatchDiff` 函数体内声明
- 500 字符预算含每行 `line N:` header + diff 内容；预算耗尽时追加 `...(+N more diff lines)` 截断标记

## 推荐方案摘要

**4 个改动，3 个源文件 + 2 个测试文件，~+185/-19 行**：

1. **read.ts 阈值**：`OVERLAP_SUPPRESS_RATIO` 0.8 → 0.95
2. **read.ts 引导式文案**：`computeUnreadRanges`（同版本 filter + 复用 `mergeRanges`）计算未覆盖新行范围，文案从 "do NOT re-read" 改为 "Read offset=X limit=N for just the new content"。空回退处理多区间联合全覆盖。
3. **edit.ts 字符级 diff**：`diffLines`（`oneChangePerToken: true`）定位差异行 + `diffChars` 显示字符级差异（只输出变化片段 + 40 字符 context）。`pendingRemoved` 在函数内声明。>60% 差异行时回退 head+tail excerpt（200+200）。500 字符预算含 header + 截断标记 `...(+N more)`。`import type { Change } from "diff"` 补类型。`fileEnd` 从固定 `bestLine+4` 改为 `bestLine+oldLineCount+2`。
4. **task.ts 注释修正**：L47-48 注释与代码矛盾——修正为"所有 `stub: true` 的 read 都被跳过"。

**Subagent 两轮审查全部修正已 incorporated**：

第一轮 9 个问题：
- ✅ `diffLines` → `diffChars`（行级 diff 无法解决长行单字符差异）
- ✅ `computeUnreadRanges` 同版本 filter（正确性红线）
- ✅ 复用 `mergeRanges`（不重复造轮子）
- ✅ 多区间联合全覆盖→空回退测试用例
- ✅ task.ts 注释与代码矛盾修正
- ✅ `diffLines` `oneChangePerToken: true` + `split("\n")` 处理多行
- ✅ unchanged 行完全跳过（行号通过 oldIdx/newIdx 保持对齐，formatCharDiffLine 提供 40 字符行内 context）
- ✅ 500 字符预算含 header（`totalChars += formatted.length + 1`）
- ✅ >60% 差异行回退策略

第二轮 7 个新问题：
- ✅ `pendingRemoved` 移入函数体内（严重：跨调用状态泄漏）
- ✅ 单行测试用例改用多行 oldString（严重：单行触发回退非 diff 路径）
- ✅ 补 `...(+N more diff lines)` 截断标记
- ✅ 删除 `newCtx` 死代码
- ✅ 补 `import type { Change } from "diff"`
- ✅ 修正现有测试推理（走回退路径非 diff 路径）
- ✅ `fileEnd` 变更记入文档
