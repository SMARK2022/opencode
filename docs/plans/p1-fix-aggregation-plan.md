# P1 修复方案：Range 聚合 + Verified → Executed Commands

## 1. 已阅读的文件/测试/文档

### 源文件
| 文件 | 行范围 | 为什么相关 |
|---|---|---|
| `src/tool/task.ts` | L24-66, L280-290 | `buildParentInspectedFilesSummary` 当前实现，range 不聚合 |
| `src/session/compaction.ts` | L68-82, L327-335, L402-471, L487-549, L605-636 | `mergeRanges`、`renderInspectedFiles`、`isSimpleVerificationCommand`、`renderVerifiedCommands`、`renderEvidenceHandoff` |
| `src/tool/shell.ts` | L1107-1118 | `isVerificationCmd` regex（独立于 `isSimpleVerificationCommand`，仅用于 `hasErrors` flag，不受影响） |
| `src/tool/read.ts` | L509-520 | `InstanceState.context` 用法参照（获取 worktree） |
| `src/tool/tool.ts` | L46-56 | `Context` 类型定义，无 `worktree` 字段 |

### 测试文件
| 文件 | 行范围 | 为什么相关 |
|---|---|---|
| `test/session/compaction.test.ts` | L1000-1075, L1240-1275, L1330-1388 | 3 个测试引用 "Verified Commands" / `isSimpleVerificationCommand` 行为 |
| `test/tool/task.test.ts` | 全文 | 现有 task 测试，无 `inspected_files` 测试 |

### 数据库验证
- 293 条 completed bash tool calls 中仅 6 条匹配 `isSimpleVerificationCommand`
- 29 条 `rtk`-prefixed 命令均不匹配
- 大量 `cd ... && rtk grep ...` 被 `&&` 过滤拒绝
- `bun typecheck` / `bun test` 由用户在终端直接执行，不经过 agent bash tool

## 2. 当前逻辑职责边界和必须保持的既有行为

### `buildParentInspectedFilesSummary` (task.ts)
**职责**：从父 session 的 `ctx.messages` 提取已完成的 read tool parts，生成 markdown 表格作为子 agent 的 `<parent_context>`。

**既有行为（必须保持）**：
- 20 个文件上限
- 跳过 compacted parts
- 跳过 `stub === true`
- 按 lastRead 降序

**当前问题**：ranges 不合并、不排序、不截断；path 用 `slice(-3)` 非真实相对路径。

### `renderVerifiedCommands` (compaction.ts)
**职责**：从 events 中提取 bash 命令，生成 markdown 表格。

**既有行为**：
- `isSimpleVerificationCommand` 过滤——仅匹配 typecheck/test/build/lint 等命令
- 拒绝含 `&&`/`||`/`|<>`;$(` 的命令
- 按 `cwd\0command` 去重
- `redactCommand` 剥离 API keys/tokens
- `commandDisplay` 截断到 120 chars
- 限制 10 条（`EVIDENCE_COMMAND_LIMIT`）

**用户要求**：移除 `isSimpleVerificationCommand` 过滤，显示全部 executed commands。

### `isSimpleVerificationCommand` (compaction.ts L496-511)
**调用点**：仅 `renderVerifiedCommands` L528
**删除后影响**：无其他调用点。shell.ts L1111-1114 有独立的 `isVerificationCmd` regex（用于 `hasErrors` flag），不引用此函数。

### `stripLeadingEnvAssignments` (compaction.ts L487-494)
**调用点**：
1. `isSimpleVerificationCommand` L502（将被删除）
2. `renderVerifiedCommands` L531（dedup key 中使用，**保留**）

**结论**：保留 `stripLeadingEnvAssignments`，因为 dedup key 仍需剥离 env 赋值（`FOO=bar git status` 和 `git status` 是同一条命令）。

### `redactCommand` / `commandDisplay` / `commandCwd`
**保留不变**——secret redaction 和 display truncation 与命令过滤无关，仍需执行。

## 3. 推荐的最小实现方案

### 修改 1：Range 聚合（task.ts）

提取 `mergeRanges` 到 `src/util/range.ts`（共享模块），在 `task.ts` 和 `compaction.ts` 中都引用。

`buildParentInspectedFilesSummary` 增加 `worktree` 参数：
- ranges 从 `string[]` 改为 `Array<{start, end}>`，渲染前 `mergeRanges` + 截断 8 个
- path 显示从 `slice(-3)` 改为 `displayPath` 同款三分支逻辑
- 调用处通过 `InstanceState.context` 获取 worktree

### 修改 2：Verified → Executed Commands（compaction.ts）

移除 `isSimpleVerificationCommand` 过滤，显示全部已执行命令。

- 删除 `isSimpleVerificationCommand` 函数（L496-511）
- `renderVerifiedCommands` → `renderExecutedCommands`
- 移除 L528 的 `isSimpleVerificationCommand` 过滤
- 保留 `if (!command) continue` 空命令过滤
- 保留 `stripLeadingEnvAssignments` 用于 dedup key
- 保留 `redactCommand`/`commandDisplay`/`commandCwd`
- 保留 `EVIDENCE_COMMAND_LIMIT = 10` 和去重逻辑
- 标题 "### Verified Commands" → "### Executed Commands"
- Omitted 文本 "verified commands" → "executed commands"

**为什么不保留任何过滤**：
- `isSimpleVerificationCommand` 的 `&&`/`||`/pipe 过滤会漏掉合法命令（如 `cd ... && bun typecheck`）
- 白名单机制无法覆盖所有验证工具（漏掉 `rtk`、PowerShell `&` 前缀等）
- secret redaction 由 `redactCommand` 独立处理，不依赖命令过滤
- 用户明确要求："不如不进行筛选"

**为什么不调高 `EVIDENCE_COMMAND_LIMIT`**：
- 10 条已去重命令 × 120 chars = ~1200 chars，在 compaction summary 预算内
- 去重保证 10 条都是不同命令，不是 10 次重复执行
- 用户未要求调整限制

### 修改 3：shell.ts 注释更新

L1109 注释引用了 `isSimpleVerificationCommand`，需更新为描述独立 regex。

## 4. 预计修改/新增/删除的文件

### 新增文件

#### `packages/opencode/src/util/range.ts`
```typescript
// [local-smark] 区间合并：将重叠或相邻（start <= last.end + 1）的区间合并为一个。
// 被 compaction.ts renderInspectedFiles 和 task.ts buildParentInspectedFilesSummary 共享。
export function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end)
  return sorted.reduce<Array<{ start: number; end: number }>>((result, range) => {
    const last = result.at(-1)
    if (!last || range.start > last.end + 1) return [...result, { ...range }]
    last.end = Math.max(last.end, range.end)
    return result
  }, [])
}
```

### 修改文件

#### `packages/opencode/src/tool/task.ts`
1. 新增 import：`path`、`InstanceState`、`mergeRanges`
2. `buildParentInspectedFilesSummary` 增加 `worktree: string` 参数
3. ranges 类型改为 `Array<{ start: number; end: number }>`
4. 渲染前调用 `mergeRanges` + 截断 8 个
5. path 显示改为 `displayPath` 同款三分支逻辑（内联 5 行，不提取 `displayPath` 到共享模块——两处使用场景有细微差异，`mergeRanges` 提取是因为完全相同的纯函数）
6. 调用处通过 `InstanceState.context` 获取 worktree
7. export + `/** @internal */` 供测试调用

#### `packages/opencode/src/session/compaction.ts`
1. 新增 import：`mergeRanges` from `@/util/range`
2. 删除局部 `mergeRanges` 函数（L327-335）
3. 删除 `isSimpleVerificationCommand` 函数（L496-511）
4. 重命名 `renderVerifiedCommands` → `renderExecutedCommands`
5. 移除 L528 的 `isSimpleVerificationCommand` 过滤，保留 `if (!command) continue`
6. 标题改为 "### Executed Commands"
7. Omitted 文本改为 "executed commands"
8. 更新 L621 调用处函数名

#### `packages/opencode/src/tool/shell.ts`
1. L1109 注释更新：移除对 `isSimpleVerificationCommand` 的引用，描述为独立 regex

### 修改测试

#### `packages/opencode/test/session/compaction.test.ts`

**Test 1**（L1058-1061）:
- `"### Verified Commands"` → `"### Executed Commands"`
- 移除 `expect(text).not.toContain("git status")`
- 新增 `expect(text).toContain("| git status |")`（git status 现在会出现）

**Test 2**（L1269）:
- `"Omitted: 1 verified commands"` → `"Omitted: 1 executed commands"`

**Test 3**（L1330-1388 "renders verification commands without exposing unsafe shell content"）:
- 测试名改为 "renders executed commands with secret redaction"
- 保留所有 redaction 断言（`OPENAI_API_KEY=[redacted]`、`--token=[redacted]`、`--api-key [redacted]`、`[cmd:`、`not.toContain("sk-secret")` 等）
- 移除过滤断言：`not.toContain("piped-sentinel")`、`not.toContain("redirected-sentinel")`、`not.toContain("subcommand-sentinel")`、`not.toContain("dangerous-sentinel")`
- 新增断言：这些命令现在出现（验证 redaction 仍生效，但命令本身不再被过滤）
- **注意 `|` 转义**：`evidenceCell`（compaction.ts:343）会把 `|` 转义为 `\|`（markdown table cell 转义）。故 `expect(text).toContain("piped-sentinel")` 应使用 sentinel 词而非完整命令（`"node --check piped-sentinel.js | tee out.txt"` 在输出中为 `node --check piped-sentinel.js \| tee out.txt`）。`>`、`&&`、`$(` 不被转义。

### 新增测试

#### `packages/opencode/test/tool/task.inspected-files.test.ts`
15 个行为级测试（range 合并/截断/包含/逆序、stub 过滤、路径显示、canonicalPath 去重、空输入）

## 5. 正常路径、错误路径、并发/退出/清理/安全边界

### 正常路径
- 父 session 有多个 read → 合并 ranges → 输出 parent_context
- compaction 时所有 bash 命令 → 去重 + redact + 截断 → 输出 Executed Commands

### 错误路径
- 空 command → `if (!command) continue` 过滤
- read metadata 缺少 start/end → 跳过该 part
- `InstanceState.context` 失败 → Effect 链失败

### 安全边界
- `redactCommand` 仍剥离 API keys/tokens/secrets——不依赖 `isSimpleVerificationCommand`
- `commandDisplay` 仍截断到 120 chars
- 去重仍按 `cwd\0command` 执行
- path 显示不暴露 worktree 外的敏感路径结构（worktree 外显示绝对路径，与 `displayPath` 一致）

### 并发/退出/清理
- 无新增并发问题——所有修改都是纯函数或渲染逻辑
- `InstanceState.context` 是已有 Effect service

## 6. 行为级测试计划

### 新增测试（task.inspected-files.test.ts）
1. 重叠 range 合并（1-100, 50-150 → 1-150）
2. 相邻 range 合并（1-100, 101-200 → 1-200）
3. 包含关系（1-100, 20-30 → 1-100）
4. 逆序输入（200-300, 1-50 → 1-50, 200-300）
5. 不相邻 range 保持（1-100, 200-300）
6. range 截断 + `...(+N)` 后缀
7. 文件截断 + `Omitted: N files`
8. canonicalPath 去重
9. stub: true 过滤
10. stub: "high_overlap_visible" 保留
11. compacted 过滤
12. worktree 内相对路径
13. worktree 外/跨盘符绝对路径
14. 空 messages → undefined
15. 无 read parts → undefined

### 修改测试（compaction.test.ts）
1. "Verified Commands" → "Executed Commands" 标题
2. git status 不再被过滤
3. "verified commands" → "executed commands" omitted 文本
4. unsafe shell constructs 不再被过滤（redaction 仍生效）

### 当前实现下暴露的缺口
- task.ts range 不合并 → 测试 1-5 会失败
- task.ts range 不截断 → 测试 6 会失败
- task.ts path 用 slice(-3) → 测试 12-13 会失败
- compaction.ts 过滤 git status → 测试 2 会失败
- compaction.ts 过滤 piped/redirected 命令 → 测试 4 会失败

## 7. 建议运行的验证命令

```bash
cd packages/opencode && bun typecheck
cd packages/opencode && bun test --timeout 30000 test/tool/task.inspected-files.test.ts
cd packages/opencode && bun test --timeout 30000 test/tool/task.test.ts
cd packages/opencode && bun test --timeout 30000 test/session/compaction.test.ts
cd packages/opencode && bun test --timeout 60000 test/tool/ test/session/compaction.test.ts
```

## 8. 预估 git 文件数、增删行数

| 文件 | 操作 | 预估增/删行 |
|---|---|---|
| `packages/opencode/src/util/range.ts` | 新增 | +10 |
| `packages/opencode/src/tool/task.ts` | 修改 | +30 / -12 |
| `packages/opencode/src/session/compaction.ts` | 修改 | +5 / -20（删 isSimpleVerificationCommand + 局部 mergeRanges，加 import + 重命名） |
| `packages/opencode/src/tool/shell.ts` | 修改 | +1 / -1（注释更新） |
| `packages/opencode/test/tool/task.inspected-files.test.ts` | 新增 | +150 |
| `packages/opencode/test/session/compaction.test.ts` | 修改 | +8 / -6 |
| **合计** | 6 文件 | +204 / -39 |

不涉及：生成文件、迁移。

## 9. 真实风险与开放问题

### 风险

1. **`InstanceState.context` 在 task.ts 中的可用性**：
   - read.ts L509 在相同 `Tool.Context` 下使用 `InstanceState.context` → task.ts 也可以
   - `InstanceContext` 同时有 `directory` 和 `worktree` 字段
   - 风险等级：低

2. **Windows 跨盘符 `path.relative`**：
   - `path.relative("C:\\wd", "D:\\f")` 返回 `"D:\\f"`（绝对路径）
   - 修复：三分支判断 `relative === ""` / `!startsWith("..") && !isAbsolute` / 否则
   - 风险等级：低

3. **compaction.ts 删除局部 `mergeRanges`**：
   - grep 确认仅 compaction.ts 内部引用，无外部 import
   - 风险等级：极低

4. **移除 `isSimpleVerificationCommand` 后 unsafe 命令出现在 Evidence Handoff**：
   - `redactCommand` 仍剥离关键词型 secrets（`api_key=`、`token=`、`password=`、`secret=`、`authorization: bearer`）
   - `commandDisplay` 仍截断到 120 chars
   - Evidence Handoff 是 compaction summary 的一部分，模型可见但不执行
   - 不构成安全风险——仅展示文本，不执行命令
   - **窄风险**：裸位置参数 secret（如 `./deploy sk-live-xxxx | tee log`）不被 `redactCommand` 匹配，此前因含 `|` 被过滤、现在会显示。实际风险极低——secret 几乎都走 env var 或 `--flag=`，裸位置参数 secret 罕见且属于反模式。不做额外加固。
   - 风险等级：低

5. **dedup key 对非验证命令的 env var 归约**：
   - `stripLeadingEnvAssignments` 把 `FOO=prod deploy` 与 `FOO=staging deploy` 都归约为 `deploy` → 同 key → 只留最近一条
   - 对验证命令合理（`FOO=bar git status` ≡ `git status`），对一般命令 env var 可能语义相关
   - 此前因非验证命令被过滤而不暴露，现在所有命令都受此归约
   - 属设计 tradeoff——用户明确要求"不筛选"，env var 差异在 Evidence Handoff 中不是关键信息
   - 风险等级：低

5. **export `buildParentInspectedFilesSummary` 用于测试**：
   - `/** @internal */` JSDoc 标记
   - 风险等级：低

6. **compaction.test.ts Test 3 行为变更**：
   - 原测试验证 unsafe 命令被过滤，现在验证它们被 redact 后显示
   - 需确保新断言正确（piped-sentinel 等命令在 120 chars 内，会完整显示）
   - 风险等级：低

### 已确认无问题
- `mergeRanges` 算法正确（与 compaction.ts 逐字节一致）
- `stripLeadingEnvAssignments` 保留（dedup key 仍需）
- `redactCommand`/`commandDisplay` 保留（redaction/truncation 独立于过滤）
- shell.ts `isVerificationCmd` 独立于 `isSimpleVerificationCommand`，不受影响
- `EVIDENCE_COMMAND_LIMIT = 10` 保持不变

## 推荐方案摘要

**新增 1 个共享模块 + 修改 3 个源文件 + 新增 1 个测试文件 + 修改 2 个测试文件**：

1. `src/util/range.ts`：提取 `mergeRanges` 为共享工具函数
2. `src/tool/task.ts`：range 合并 + 截断 + path 相对路径 + worktree 参数
3. `src/session/compaction.ts`：删除 `isSimpleVerificationCommand`，Verified → Executed Commands，删除局部 `mergeRanges` 改为 import
4. `src/tool/shell.ts`：注释更新
5. `test/tool/task.inspected-files.test.ts`：15 个行为级测试
6. `test/session/compaction.test.ts`：3 个测试更新（标题、git status 不再过滤、unsafe 命令不再过滤但 redaction 仍生效）
