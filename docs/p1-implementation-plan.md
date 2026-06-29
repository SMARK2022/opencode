# P1 改造方案详细设计（只调研不改代码）

> 基于穷尽式源码调研（subagent 完成全部 10 项的调用链/边界/兼容确认）
> 
> 生成时间：2026-06-29 | 基准分支：dev-smark | 前置：P0 已完成并提交

---

## 一、调研确认汇总

### 已阅读的文件

| 文件 | 调研范围 | 关键发现 |
|---|---|---|
| `tool/read.ts` | L197-250（dedup）、L728（outline 调用） | stub 仅精确/覆盖 range；overlap 仅 note 不 suppress；outline 每次 read 都重新扫描 |
| `tool/read-outline.ts` | L5-9（常量）、L227-262（readOutline） | 仅 offset<=1 && total>=600 && 源码扩展名时生成；MAX_SCAN_LINES=3000 |
| `session/compaction.ts` | L44-76（常量）、L293-305（events）、L398-586（evidence）、L606-636（splitTurn）、L763-810（prune）、L193-198（memento budget） | PRUNE_PROTECTED 仅 skill；splitTurn 跳 error turns；memento 无 floor；evidence 无 search history；EVIDENCE_FILE_LIMIT 固定 20 |
| `session/message-v2.ts` | L398-406（truncateToolOutput）、L963-969（compacted 处理） | head/tail 固定 400/2000；compacted 直接清空；正常路径不截断 |
| `tool/task.ts` | L48-60（Parameters）、L116-366（run）、L62-70（output） | background 需 experimental flag；output 无截断；不传递 inspected files |
| `session/processor.ts` | L33（DOOM_LOOP_THRESHOLD）、L427-489（doom loop 检测） | 仅同消息内检测；JSON.stringify 严格相等；无跨消息/语义/typecheck cache |
| `session/prompt.ts` | L2148-2149（maxSteps）、L2254（MAX_STEPS 注入） | agent.steps ?? Infinity；无默认 ceiling；无 80% 收敛提示 |
| `agent/agent.ts` | L51（steps 字段）、L139+（各 agent 定义） | 所有内置 agent 均未设 steps |
| `tool/grep.ts` | L14（RESULT_LIMIT）、L113-124（搜索）、L207-213（metadata） | 多取 1 条判断 truncated；metadata.matches 是截断后长度；不返回总数 |
| `tool/glob.ts` | L54（limit=100）、L69-77（截断）、L95（metadata） | 同 grep 模式；metadata.count 是截断后长度 |
| `tool/shell.ts` | L322-358（tail 函数）、L1007（tail 调用）、L1066-1084（metadata） | 固定 tail 方向；metadata 有 exit 码但无 hasErrors flag |
| `tool/truncate.ts` | L26（direction 参数）、L81-130（output 函数） | 已支持 head/tail direction，shell.ts 没用它 |
| `tool/skill.ts` | L23-72（execute） | 无 load 历史；每次重新扫描文件 + 输出完整 content |
| `util/output-notice.ts` | L13-20（ExecutionNotice）、L53-55（formatExecutionNotice） | notice 含 exit_code 但无 typecheck_error flag |

### 确认的既有行为必须保持

1. read.ts `size+modifiedMs` 同版本门控——文件修改后必须重新读
2. read.ts stub 输出格式——打破"重复读同范围"死循环的关键
3. compaction.ts prune 跳过最近 2 个 user turn
4. compaction.ts splitTurn tail anchor 必须 replayable
5. compaction.ts evidence 是公开 text part（给用户和模型看）
6. task.ts background 需 experimental flag 门控
7. processor.ts doom_loop 走 permission.ask（不直接阻断）
8. prompt.ts MAX_STEPS 注入会禁用工具强制收尾
9. message-v2.ts truncateToolOutput 在 headChars/tailChars 为 undefined 时原样返回（正常路径不截断）
10. skill.ts ctx.ask always 记住决策

### 确认的边界/兼容/时序问题

1. **outline cache 失效**：文件被 edit/write 修改后必须失效，cache key 需含 size+modifiedMs
2. **prune 保护 read**：prune 和 compaction（summary）是两个不同机制，保护 read 不被 prune 不等于不被 compaction
3. **splitTurn 放宽 error**：errored assistant 被 undo/repair 删除会导致 tail_start_id 悬空
4. **memento 加 4K floor**：小模型（8k context）的 compaction 请求自身可能溢出
5. **background 默认 true**：需处理 flag 关闭时的回退
6. **跨消息 doom loop**：compaction 后旧 parts 可能被清空，无法检测
7. **grep total count**：继续计数有性能成本（大仓库可能扫很久）
8. **skill dedup**：skill 被 edit 修改后需能强制重载

---

## 二、P1-1：Read dedup 增强

### 改动 1：overlap>=80% suppress

**文件**：`src/tool/read.ts`

**改动**：新增 `OVERLAP_SUPPRESS_RATIO = 0.8` 常量。在 `findReadStub` 之后、`findOverlapNote` 之前，增加高重叠 suppress 分支：

```typescript
// read.ts L27 附近
const OVERLAP_SUPPRESS_RATIO = 0.8

// read.ts L679 之后（findReadStub 返回 undefined 后）
const overlapNote = findOverlapNote(visibleReads, current)
if (overlapNote) {
  // [local-smark] 当重叠率 >= 80% 时 suppress（返回 stub），
  // 而非仅 note。这减少了大量部分重叠的重复读取。
  // 仍走 size+modifiedMs 同版本门控（findOverlapNote 内部已检查）。
  const overlapRatio = computeOverlapRatio(visibleReads, current, overlapNote)
  if (overlapRatio >= OVERLAP_SUPPRESS_RATIO) {
    // 返回 stub，文案复用 renderReadStub 的 nextOffset 逻辑
    const stub = { status: "stub_high_overlap_visible" as const, coveredBy: overlapNote }
    // ... 返回 stub 输出
  }
}
```

需新增 `computeOverlapRatio` 函数（从 findOverlapNote 的逻辑提取）和 `stub_high_overlap_visible` 到 `ReadStubStatus` 类型。

**边界**：suppress 仍需 `size+modifiedMs` 同版本门控（findOverlapNote 已内置）；stub 文案需告诉模型哪段已可见、往哪读。

### 改动 2：whole-file outline cache

**文件**：`src/tool/read-outline.ts`、`src/tool/read.ts`

**改动**：在 read-outline.ts 的 `readOutline` 外层加 per-(canonicalPath, size, modifiedMs) 的 LRU cache：

```typescript
// read-outline.ts 新增
// [local-smark] outline cache：按 canonicalPath+size+modifiedMs 缓存，
// 文件修改后自动失效。LRU 上限 50 条（每条 ≤640 chars，总内存可控）。
const outlineCache = new Map<string, { outline: Outline; size: number; modifiedMs: number }>()
const OUTLINE_CACHE_LIMIT = 50

export async function readOutlineCached(filepath: string, total: number, offset: number, size: number, modifiedMs: number): Promise<Outline | undefined> {
  const canonical = process.platform === "win32" ? filepath.replaceAll("\\", "/").toLowerCase() : filepath.replaceAll("\\", "/")
  const key = canonical
  const cached = outlineCache.get(key)
  if (cached && cached.size === size && cached.modifiedMs === modifiedMs) {
    return cached.outline
  }
  const outline = await readOutline(filepath, total, offset)
  if (outline) {
    if (outlineCache.size >= OUTLINE_CACHE_LIMIT) {
      // 删最早的（Map 保持插入顺序）
      const firstKey = outlineCache.keys().next().value
      if (firstKey) outlineCache.delete(firstKey)
    }
    outlineCache.set(key, { outline, size, modifiedMs })
  }
  return outline
}
```

read.ts L728 改为调用 `readOutlineCached`，传入 `size` 和 `versionMs`（已在作用域内）。

**边界**：cache 是模块级 Map（非 InstanceState），跨 project 可能泄漏但 key 含路径所以不会误命中；LRU 上限 50 条防止无限增长。

---

## 三、P1-2：Evidence Handoff 扩展

### 改动 1：Search History section

**文件**：`src/session/compaction.ts`

**改动**：在 `renderEvidenceHandoff`（L562-586）新增 `### Search History` section：

```typescript
// compaction.ts 新增函数
function renderSearchHistory(input: { events: ToolEvent[] }): string {
  // 从 events 中提取 grep/glob tool events
  // 每个 event 提取：pattern/pattern + path + result count + truncated
  // 去重（同 pattern+path 只保留最新），取前 EVIDENCE_SEARCH_LIMIT 条
  const EVIDENCE_SEARCH_LIMIT = 10
  // ... 类似 renderVerifiedCommands 的结构
}
```

在 `renderEvidenceHandoff` 中插入：
```typescript
return [
  "## Evidence Handoff", "",
  yield* renderInspectedFiles(...), "",
  renderVerifiedCommands(...), "",
  renderSearchHistory({ events }), "",  // 新增
  renderOutstandingTodos(...), "",
  "### Lost Context Notice", ...
].join("\n")
```

**边界**：grep/glob 的 `state.input` 含 pattern/path/include；`state.metadata` 含 matches/truncated。需防御性解析。上限 10 条防止膨胀。

### 改动 2：EVIDENCE_FILE_LIMIT 自适应

**文件**：`src/session/compaction.ts`

**改动**：L71 `EVIDENCE_FILE_LIMIT = 20` 改为根据 compaction 次数自适应：

```typescript
// [local-smark] 文件保留上限自适应：基础 20 + 每次额外 compaction +2，
// 上限 40。长 session 经历多次 compaction 后保留更多文件证据。
function evidenceFileLimit(compactionCount: number): number {
  return Math.min(40, 20 + compactionCount * 2)
}
```

在 `renderInspectedFiles` 调用处传入 `compactionCount`（来自 `completedCompactions(history).length`）。

---

## 四、P1-3：Compaction 保留增强

### 改动 1：pruning 保护 read

**文件**：`src/session/compaction.ts`

**改动**：L52 `PRUNE_PROTECTED_TOOLS = ["skill"]` 改为 `["skill", "read"]`。

**注释**：一行改动。read output 占 42.7% 上下文，保护 read 使其不被 prune（但仍会被 compaction summary 处理），减少 post-prune re-read。

### 改动 2：splitTurn 保留 error

**暂缓 P2**：需先验证 undo/repair 删除 errored message 时 tail_start_id 的防御逻辑。代码注释 L618-621 明确记录了跳过 error 的原因（"errored messages can disappear from visible history"），未确认前不应移除此防线。

### 改动 3：compaction 计数

**文件**：`src/session/compaction.ts`

**改动**：在 `renderEvidenceHandoff` 的 "### Lost Context Notice" 段增加 compaction 次数：

```typescript
const compactionCount = completedCompactions(input.messages).length
// 在 Lost Context Notice 段追加：
`- This is compaction #${compactionCount}. Summary fidelity may be degraded; verify critical facts by re-reading.`
```

### 改动 4：head/tail content-aware

**文件**：`src/session/compaction.ts`

**改动**：L50-51 固定值改为根据 tool 类型动态分配：

```typescript
// [local-smark] content-aware head/tail：read 输出用更大 head（保 path+outline+首行内容），
// bash 输出保持 tail-heavy（保 error/结果在末尾）。
function toolOutputTruncationFor(tool: string): { head: number; tail: number } {
  if (tool === "read") return { head: 1000, tail: 2000 }
  return { head: 400, tail: 2000 }  // 默认（bash 等）
}
```

在 `processCompaction` 调用 `toModelMessagesEffect` 时传入动态值。但 `toModelMessagesEffect` 的 `toolOutputTruncation` 参数是全局的（不按 tool 区分），需改为 per-part 传递或在 `truncateToolOutput` 中按 tool 名分支。**更简单方案**：在 `truncateToolOutput`（message-v2.ts L398）内部根据 tool 名分支。

### 改动 5：memento min 4K

**文件**：`src/session/compaction.ts`

**改动**：L197 `preserveRecentUserBudget`：

```typescript
// 原：return Math.min(DEFAULT_PRESERVE_RECENT_USER_TOKENS, Math.max(0, Math.floor(usable(input) * PRESERVE_RECENT_USER_RATIO)))
// 改为：
// [local-smark] memento 条件化 floor：仅当 usable >= 20K 时设 4K floor，
// 小模型（8K context）的 20% 仅 1.6K，4K floor 会吃掉 2/3 预算加剧溢出。
// 大模型 4K floor 确保关键 user intent 不被截断。
const mementoFloor = usable(input) >= 20_000 ? 4_000 : 0
return Math.min(DEFAULT_PRESERVE_RECENT_USER_TOKENS, Math.max(mementoFloor, Math.floor(usable(input) * PRESERVE_RECENT_USER_RATIO)))
```

---

## 五、P1-4：Subagent 效率（含可配置 inspected files 传递 + resume 增量处理）

### 改动 1：可配置 inspected files 传递

**文件**：`src/tool/task.ts`、`src/session/compaction.ts`

**参数设计**：在 task.ts Parameters 中新增可选参数：

```typescript
// task.ts Parameters 新增
inspected_files: Schema.optional(
  Schema.Literal("none", "summary").annotate({
    description: "Controls whether to pass parent session's inspected file list to the subagent. " +
      "'none': no file list (default for resume). " +
      "'summary': compact file path + range table (default for new subagents).",
  })
)
```

默认行为：
- **新 subagent（无 task_id）**：默认 `"summary"`——传递父 session 的 inspected files 摘要
- **resume（有 task_id）**：默认 `"none"`——子 session 已有自己的 read 历史，不重复传递

**inspected files 提取逻辑**：

导出 compaction.ts 的 `completedToolEvents`，新增轻量 `renderInspectedFilesSummary`：

```typescript
// compaction.ts 新增导出和函数
export { completedToolEvents }

// [local-smark] 轻量版 inspected files 摘要：不做 fs.stat（避免 I/O），
// 双源合并：从 ctx.messages 的 read tool parts 提取（精确，但仅 retained tail 范围）
// + 从 Evidence Handoff text part 中解析 ### Inspected Files 表格（覆盖 compaction 前的 reads）。
// worktree 用于 displayPath 相对路径显示。
export function renderInspectedFilesSummary(
  messages: MessageV2.WithParts[],
  worktree: string,
): string {
  // 源 1：从 messages 中的 read tool parts 提取（仅 retained tail 范围内的）
  const events = completedToolEvents(messages)
  // ... 复用 renderInspectedFiles 的提取逻辑，跳过 fs.stat，跳过 stub
  // 源 2：从 Evidence Handoff text part 中解析 ### Inspected Files 表格
  // Evidence Handoff 在 compaction 时写入（metadata.kind === EVIDENCE_HANDOFF_KIND），
  // 包含 compaction 前的完整 inspected files 列表
  // 两源合并去重（按 canonicalPath），输出 markdown 表格
}
```

**关键边界（subagent 复核修正）**：
- **full compaction 后 ctx.messages 只含 retained tail（最近 4 turns）**：full compaction 的 `filterCompacted` 完全移除 retained tail 之外的旧消息。`ctx.messages` 中只有最近 4 turns 的 read parts。补充数据源：Evidence Handoff text part（在 compaction 时已生成完整 inspected files 列表）。
- **prune 后 metadata.read 完整保留**：prune 只设 `time.compacted`，不清空 output/metadata。但 `completedToolEvents` 不跳过 compacted parts——这是有意选择（父 session 确实读过这些文件）。
- **Path B（handleSubtask）无法传 inspected_files 参数**：prompt.ts 构造 taskArgs 时只有 prompt/description/subagent_type/command。Path B 走默认值（无 task_id → "summary"）。
- **renderInspectedFilesSummary 需要 worktree 参数**：从 `InstanceState.context` 获取，用于 displayPath 相对路径显示。

**task.ts 注入逻辑**：

```typescript
// task.ts runTask 函数内（L226 之后）
const parts = yield* ops.resolvePromptParts(params.prompt)

// [local-smark] 根据 inspected_files 参数传递父 session 的已读文件列表。
// 新 subagent 默认 "summary"，resume 默认 "none"（子 session 已有自己的 read 历史）。
const inspectedFilesMode = params.inspected_files ?? (params.task_id ? "none" : "summary")
if (inspectedFilesMode !== "none" && ctx.messages.length > 0) {
  const ctx2 = yield* InstanceState.context
  const summary = renderInspectedFilesSummary(ctx.messages, ctx2.worktree)
  if (summary) {
    parts.push({ type: "text", text: `<parent_context>\n${summary}\n</parent_context>` })
  }
}
```

**stale 风险处理**：不做 fs.stat，无法判断文件是否 stale/deleted。但子 agent 会自己 read 文件，stale 判断由 read 的 `size+modifiedMs` 门控处理。stale 文件路径可能误导子 agent 浪费一次 read 尝试，但影响可控。

### 改动 2：空结果验证

**文件**：`src/tool/task.ts`

**改动**：L242 `result.parts.findLast(...text)?.text ?? ""` 后加空结果检查。

**subagent 复核修正**：不能 `return output(sessionID, "...")`，因为 runTask 返回裸字符串，调用方 L348 会再次 `output()` 包裹——双重嵌套。改为返回裸字符串：

```typescript
if (!text || text.trim().length === 0) {
  // [local-smark] 空结果验证：子 agent 未产出任何文本，
  // 返回裸字符串由调用方统一包裹，避免 <task_result> 双重嵌套。
  text = "Subagent produced no output (may have been aborted or lacked required tools)."
}
```

### 改动 3：result 截断预算

**文件**：`src/tool/task.ts`

**改动**：`output`（L62-70）对 `text` 加截断。**subagent 复核修正**：截断需同时覆盖前台 `output()` 和后台 `inject()` 路径：

```typescript
const TASK_RESULT_MAX_CHARS = 32_000
// [local-smark] 子 agent 结果截断预算：32KB（约 8K tokens）。
// 前台 output() 和后台 inject() 路径都需截断，防止大结果撑爆父上下文。
function truncateTaskResult(text: string): string {
  if (text.length <= TASK_RESULT_MAX_CHARS) return text
  return text.slice(0, TASK_RESULT_MAX_CHARS) + "\n...[truncated]"
}
```

在 `output()`（L62-70）和 `backgroundOutput`/`backgroundMessage`（L72-97）中调用 `truncateTaskResult`。

### 改动 4：background 默认

**暂缓 P2**：background 需 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag。改默认 true 需同步处理 flag 关闭场景，且需验证 `task_status` 轮询机制稳定性。

---

## 五补、Bash timeout no-output 增强提示（Finding F-2 补充实施）

### 调研确认

- shell.ts L949 用 `ChildProcessSpawner`（pipe），非 pty
- shell.ts L985 `Fiber.join(output)` 排干 pipe 已缓冲的尾部 chunk，但进程内部 block buffer 仍丢
- shell.ts L1018-1019 emptyOutput 判定
- **pty 基础设施已完整存在**（`src/pty/`，`@lydell/node-pty`，`bun-pty`），但仅 server routes 使用，shell 工具不引用
- 89 次 timeout-no-output 历史记录

### P1 实现：timeout empty-output 增强提示

**文件**：`src/tool/shell.ts`

**改动**：L1018-1019 的 emptyOutput 分支，在 timeout 时追加更详细的诊断：

```typescript
// [local-smark] timeout + 空输出时追加诊断提示，
// 帮助模型区分"进程 hang 住"vs"block-buffered 未 flush"vs"等待交互输入"。
// 不改 pipe 架构（pty 改造是 P2），仅改善模型决策质量。
// 注意 output 顺序：(no output) + 增强提示 + diagnosticAppendix
if (emptyOutput && expired) {
  output += "\n\nThe process produced no output before timeout. This may indicate:" +
    "\n- The command is block-buffering output (common for build tools like bun install, bundle install);" +
    " consider adding --verbose or running with a larger timeout." +
    "\n- The process is waiting for interactive input; provide input or use a non-interactive flag." +
    "\n- The process is hung; check the command and environment."
}
```

**边界**：
- timeout + 有 output → 不触发增强提示（有 output 说明不是 block-buffering）
- abort + 无 output → 不触发增强提示（abort 是用户主动操作）
- 正常完成 → 不受影响

### P2 可选：pty 模式（设计概要，不在 P1 实施）

已有 pty 基础设施（`src/pty/`），可渐进引入：
1. Parameters 新增 `interactive?: boolean`（默认 false）
2. `interactive === true` 时用 `src/pty` 的 `Proc` 替代 `ChildProcessSpawner`
3. `Proc.onData` → `Queue` → `Stream.fromQueue` → `onChunk`（用 EffectBridge 桥接）
4. onChunk 后加 ANSI 净化层（复用 bash-compress 虚拟终端渲染，跳过 normalizePowerShellOutput）
5. timeout race 结构不变

**P2 风险**：Windows conpty 兼容（Win10 1809+）；ANSI 净化可能误删真实错误输出；bun-pty vs node-pty 行为差异；测试需新增 pty spawner layer。

---

## 六、P1-5：循环检测增强

### 改动 1：跨消息 doom loop 检测

**文件**：`src/session/processor.ts`

**改动**：L463 `parts = MessageV2.parts(ctx.assistantMessage.id)` 改为查询跨 assistant message 的最近 parts：

```typescript
// [local-smark] 跨消息检测：不只看当前 assistant message，
// 还看前一个 assistant message 的末尾 parts，防止跨消息的重复循环。
const currentParts = MessageV2.parts(ctx.assistantMessage.id)
// 获取前一个 assistant message（如果存在）
const recentParts = [...prevAssistantParts, ...currentParts].slice(-DOOM_LOOP_THRESHOLD)
```

需在 processor 的 ctx 中维护 `prevAssistantParts`（或从 session messages 查询）。

**边界**：compaction 后旧 parts 可能被清空，跨消息检测在 compaction 后可能失效。可接受——compaction 本身打破了循环。

### 改动 2：typecheck result caching

**暂缓 P2**：需先实现 edit/write/apply_patch 完成事件触发 cache 清除的 hook。当前无现成 hook，待确认 = 不可实施。

### 改动 3：consecutive-error breaker

**文件**：`src/session/processor.ts`

**改动**：在 `case "tool-result"` 统计连续 error：

```typescript
// [local-smark] consecutive-error breaker：同一工具连续 3 次 error 后
// 注入策略变更提示，避免盲目重试。
if (result.status === "error") {
  consecutiveErrors[toolName] = (consecutiveErrors[toolName] ?? 0) + 1
  if (consecutiveErrors[toolName] >= 3) {
    // 注入 system-reminder 或 permission.ask
  }
} else {
  delete consecutiveErrors[toolName]
}
```

### 改动 4：semantic 3-gram 检测

**暂缓**：引入 3-gram 相似度计算需要分词和相似度算法，改动面较大且性能不确定。**建议 P2**。

---

## 七、P1-6：Step ceiling

**文件**：`src/session/prompt.ts`、`src/agent/agent.ts`

**改动**：

```typescript
// prompt.ts L2148
// 原：const maxSteps = agent.steps ?? Infinity
// 改为：
const maxSteps = agent.steps ?? 200
// [local-smark] 默认 step ceiling 200：111 sessions >100 steps 的无界循环
// 占用了大量 cost。200 覆盖正常任务，超过时强制收尾。

// L2149 后新增 80% 收敛提示
const nearCeiling = step >= Math.floor(maxSteps * 0.8)
if (nearCeiling && !isLastStep) {
  // 在 messages 中注入收敛提示（不禁用工具，仅提醒）
  msgs.push({ role: "assistant", content: "You are approaching the step limit. Prioritize convergence." })
}
```

**agent.ts**：不需改动——所有 agent 未设 steps，自动获得 200 默认。config 显式设 steps 的可覆盖。

---

## 八、P1-7：Grep/Glob count

### 改动：truncation 时返回 total count

**文件**：`src/tool/grep.ts`、`src/tool/glob.ts`

**grep.ts 改动**：

```typescript
// L113-124 附近：ripgrep 搜索后，若 truncated，额外跑 rg --count 获取总数
if (resultLimitTruncated) {
  // [local-smark] 截断时获取真实总数，帮助模型评估搜索密度
  const total = yield* rg.count(pattern, { cwd: search, include, signal: ctx.abort })
  metadata.totalMatches = total
}
// L171 输出文案改为：
`Found ${total ?? final.length} matches${resultLimitTruncated ? ` (showing first ${RESULT_LIMIT})` : ""}`
```

需在 ripgrep.ts 新增 `count` 方法（用 `rg --count-matches` 或流式计数，设上限如 10000 避免大仓库扫描过久）。

**glob.ts 改动**：同理，截断后额外计数。

**边界**：计数有性能成本，设上限（如最多多扫 10000 条就报 ">10000"）。

---

## 九、P1-8：Bash truncation 方向

**文件**：`src/tool/shell.ts`

**改动**：L1007 `tail(...)` 改为根据命令名选方向：

```typescript
// [local-smark] command-aware truncation direction：
// 列表/树形命令（ls/find/tree/git status/git diff）用 head 保开头，
// 日志/流式命令（typecheck/test/build/tail）用 tail 保末尾。
function shouldUseHead(command: string): boolean {
  const cmd = command.trim().toLowerCase()
  return /^(ls|dir|find|tree|git\s+(status|diff|log|ls-files))/.test(cmd)
}

const direction = shouldUseHead(input.command) ? "head" : "tail"
const end = direction === "head"
  ? head(normalized, limits.maxLines, limits.maxBytes)
  : tail(normalized, limits.maxLines, limits.maxBytes)
```

需新增 `head` 函数（对称于 `tail`），或复用 `Truncate.output` 的 head 分支。但 `tail` 返回 `{text, cut, hidden}` 供诊断，`head` 需对称返回。

**边界**：`formatOutputTruncatedNotice` 的 `shown.direction` 需同步更新。

---

## 十、P1-9：Skill load dedup

**文件**：`src/tool/skill.ts`

**改动**：在 `execute` 入口检查 `ctx.messages` 中是否已有同 name 的 completed skill tool part：

```typescript
// [local-smark] skill load dedup：若当前 session 上下文中已加载过同名 skill，
// 返回 stub 而非重新输出完整 content（~7KB）。
// 通过扫描 ctx.messages 中已完成的 skill tool part 实现，
// 不需要 InstanceState 或额外状态——与 read.ts collectVisibleReads 同一模式。
const alreadyLoaded = ctx.messages.some(msg =>
  msg.info.role === "assistant" &&
  msg.parts.some(part =>
    part.type === "tool" && part.tool === "skill" &&
    part.state.status === "completed" &&
    // [local-smark] 补 compacted 守卫对齐 collectVisibleReads（read.ts L205）：
    // compacted 的 skill part 内容已被 prune 清空，不应视为"已加载"。
    // 当前 skill 在 PRUNE_PROTECTED_TOOLS 中受保护不会被 prune，
    // 但 full compaction 会移除旧消息——此时 alreadyLoaded=false 正确触发重载。
    !part.state.time.compacted &&
    (part.state.input as Record<string, unknown>)?.name === params.name
  )
)
if (alreadyLoaded) {
  return {
    title: `Skill ${params.name} already loaded`,
    output: `Skill '${params.name}' was already loaded in this session. Refer to the prior tool output for instructions.`,
    metadata: { name: params.name, deduped: true },
  }
}
```

**边界**：compaction 后 skill part 可能被清空，此时 `alreadyLoaded` 为 false，skill 会被重新加载——这是正确行为（compaction 丢失了 skill content，需要重新加载）。

---

## 十一、P1-10：Typecheck error flag

**文件**：`src/tool/shell.ts`、`src/util/output-notice.ts`

**改动**：在 bash metadata 中增加 `hasErrors` flag：

```typescript
// shell.ts L1066-1084 metadata 区域
// [local-smark] 对已知验证命令（typecheck/tsc/test/lint）的输出，
// 检测 error pattern 并设置 hasErrors flag，帮助模型识别验证失败。
const isVerification = isSimpleVerificationCommand(input.command)
const hasErrors = isVerification && (
  exitCode !== 0 ||
  /error TS\d|SyntaxError|FAIL|Error:|✗/i.test(output)
)
metadata: {
  ...existing,
  hasErrors,
}
```

在 output 中追加提示：
```typescript
if (hasErrors) {
  output = `Verification found errors. Address them before reporting complete.\n` + output
}
```

**边界**：error pattern 正则需覆盖多语言（tsc/eslint/python/mypy），易误判。复用 `isSimpleVerificationCommand`（compaction.ts L492-507）的命令白名单限定检测范围。

---

## 十二、实施路线图

| Phase | P1 项 | 预计工期 | 依赖 |
|---|---|---|---|
| Phase 1 | P1-3（pruning 保护 read + memento 条件化 floor + compaction 计数）+ Bash timeout 提示 | 3 天 | 无 |
| Phase 2 | P1-6（step ceiling）+ P1-9（skill dedup）+ P1-10（typecheck flag）| 3 天 | 无 |
| Phase 3 | P1-1（read dedup + outline cache）| 4 天 | 无 |
| Phase 4 | P1-2（Evidence Handoff search history）+ P1-7（grep/glob count）| 4 天 | 无 |
| Phase 5 | P1-8（bash truncation 方向）+ P1-5（跨消息 doom loop + consecutive-error breaker）| 5 天 | P1-1 |
| Phase 6 | P1-4（subagent inspected files + 空结果 + result 截断）| 4 天 | P1-2 |

**降级到 P2 的项**：
- P1-3 splitTurn 放宽 error（需先验证 undo/repair 防御）
- P1-4 background 默认 true（需 flag 处理 + 轮询稳定性验证）
- P1-5 typecheck cache（需先实现 edit/write 失效 hook）
- P1-5 semantic 3-gram（改动面大 + 性能不确定）
- Bash pty 可选模式（需 ANSI 净化层 + Windows 兼容验证）

---

## 十三、预估 Git 影响

| P1 项 | 修改文件 | 新增文件 | 预计净增行 | 删除行 |
|---|---|---|---|---|
| P1-1 | read.ts, read-outline.ts | 0 | ~80 | ~5 |
| P1-2 | compaction.ts | 0 | ~50 | 0 |
| P1-3 | compaction.ts, message-v2.ts | 0 | ~15 | ~3 |
| P1-4 | task.ts, compaction.ts | 0 | ~60 | ~3 |
| P1-5 | processor.ts | 0 | ~25 | ~3 |
| P1-6 | prompt.ts | 0 | ~10 | ~1 |
| P1-7 | grep.ts, glob.ts | 0 | ~40 | ~5 |
| P1-8 | shell.ts | 0 | ~25 | ~3 |
| P1-9 | skill.ts | 0 | ~18 | 0 |
| P1-10 | shell.ts, output-notice.ts | 0 | ~20 | ~2 |
| Bash timeout | shell.ts | 0 | ~12 | 0 |
| **合计** | **~12 文件** | **0** | **~345** | **~24** |

- 不涉及生成文件/迁移/文档
- 不涉及新配置项（step ceiling 200 是默认值，可被 config 覆盖）
- 所有改动用 `[local-smark]` 标记

---

## 十四、风险与开放问题

### 已确认风险

1. **P1-3 splitTurn 放宽 error**：undo/repair 删除 errored message 导致 tail_start_id 悬空。**待确认**：undo/repair 逻辑是否已有防御。
2. **P1-5 跨消息 doom loop**：compaction 后旧 parts 被清空，检测失效。可接受——compaction 本身打破循环。
3. **P1-7 grep total count**：大仓库扫描过久。设上限 10000。
4. **P1-1 outline cache**：模块级 Map 跨 project 可能泄漏。key 含路径不会误命中。

### 暂缓项

- P1-3 splitTurn 放宽 error → P2（需先验证 undo/repair 防御）
- P1-4 background 默认 true → P2（需 flag 处理 + 轮询稳定性验证）
- P1-5 typecheck cache → P2（需先实现 edit/write 失效 hook）
- P1-5 semantic 3-gram → P2（改动面大 + 性能不确定）
- Bash pty 可选模式 → P2（需 ANSI 净化层 + Windows 兼容验证）

### 待确认项

1. **splitTurn undo/repair**：需阅读 undo/revert 逻辑确认 tail_start_id 防御
2. **P1-7 ripgrep count API**：需确认 `rg --count-matches` 是否可用或需流式计数
3. **P1-5 typecheck cache 失效**：需确认 edit/write/apply_patch 事件如何触发 cache 清除

---

## 十五、推荐方案摘要

P1 改造共 10 项（4 项暂缓 P2）+ Bash timeout 增强，涉及 ~12 个源文件，预计净增 ~345 行、删除 ~24 行，不新增文件/配置/API。

核心改动按影响排序：
1. **P1-1**（read dedup + outline cache）→ 减少 1248 hot pairs 中 >50% 的重复读取
2. **P1-3**（pruning 保护 read + memento + compaction 计数）→ 减少 post-compaction 信息丢失
3. **P1-5**（跨消息 doom loop + consecutive-error breaker）→ 循环检测覆盖率 5%→40%
4. **P1-6**（step ceiling 200）→ 消除 111 sessions >100 steps 的无界循环
5. **P1-2**（Evidence Handoff search history）→ 减少 post-compaction 重复搜索
6. **P1-7**（grep/glob count）→ 消除 20.3% grep 密度盲区
7. **P1-8**（bash truncation 方向）→ 减少 257 次 git diff tail-truncation
8. **P1-9**（skill dedup）→ 减少 70 次重复加载 × 7KB
9. **P1-10**（typecheck flag）→ 减少 13% typecheck error 被忽略
10. **P1-4**（subagent inspected files + 空结果 + 截断）→ 减少 92% re-read + 12% 空结果

所有改动遵循 Effect-first 架构、[local-smark] 标记、向后兼容、手术刀式修改。
