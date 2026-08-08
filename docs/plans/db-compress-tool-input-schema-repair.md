# Canonical Implementation Plan: db-compress-tool-input-schema-repair

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: 用户 GOAL 原始需求（见 §1 verbatim）
>
> Implementation allowed: yes (R4 已实现并验证)
>
> Last updated: 2026-08-08

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户原始需求（GOAL 参数原文）：

> 解决当前的 OpenCode database maintenance `opencode db compress` 报
> `ColdStorageCorruptionError: Stored tool input is invalid` 的问题，即后续不再会产生该种错误，
> 且整体修改保持克制，即仅精准修改现有的会产生该种错误 schema 的代码路径，同时在不破坏现有功能和性能的前提下，修复该问题。
> 整体修改文件数不超过四个生产文件，不超过 200 行代码。
>
> 目标终态：verified-implementation

补充约束（用户对话中确认）：整体修改代码行数不超过 500 行（含测试），不要臃肿、不要引入新的错误面；
修复后 `db compress` 必须能继续运行。

R2 用户约束修订（最新用户消息，原文）：

> 我可以宽限到500行，这不是阻塞原因，请重新审计

## 2. Explicit Non-Goals

- 不修改 cold payload 格式、hash 算法、codec 或 `cold_storage` 表结构。
- 不把 `ColdStorage` 的损坏检测降级为“跳过/忽略坏行后继续压缩”（禁止隐藏损坏）。
- 不修改用户数据库、不自动改写既有数据（既有数据修复必须经用户显式维护命令授权）。
- 不改动正常 Tool 的权限语义（用户工具的 `* deny` 等权限行为保持不变）。
- 不新增数据库表、不新增迁移、不新增配置项。
- 不修改 `thirdparty/opencode-11720` 分支（该分支是无效分支，非生产代码）。
- 不为“保留原始 malformed input”扩展 `MessageV2.ToolState` schema（无产品证据要求保留）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Message/Tool/Part 领域词汇；`session/` 是 MessageV2 part-based 持久化 owner；`storage/` 是 SQLite 持久化。 |
| `docs/adr/README.md` + `docs/adr/0001-*` | 本任务不引入新 ADR；与 triage 无关。 |
| 根 `AGENTS.md` | 默认分支 `dev`；并行工具；测试从 package 目录运行；`bun typecheck` 从 package 目录运行。 |
| `packages/opencode/AGENTS.md` | 数据库 schema 位于 `src/**/*.sql.ts`；开发服务用 tmux；Effect 规则；`db generate` 生成迁移（本任务不新增迁移）。 |
| `.opencode/policy/first-principles-engineering.md` | primary-path 修复第一 divergence；禁止 fallback；ownership 规则；15% 中文注释门禁；审计独立性。 |
| `docs/plans/opencode-db-cold-storage*.md`、`docs/superpowers/specs/2026-07-17-opencode-db-cold-storage-design.md` | 冷存储设计背景：`partCandidate` 只筛选 `tool + completed/error` 等，最终字段白名单与 eligibility 由 JS extraction 判定；写入 seam 是 `ColdStorage.replacePart`。 |
| 根 `package.json`（catalog `ai: 6.0.168`）、`bun.lock` | AI SDK 6.0.168 的 `parseToolCall` 契约（见 §6）。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `C:\Users\Lenovo\.local\share\opencode\opencode.db`（只读查询） | 全库唯一异常 Part：`prt_fc148be86002oFlt9Ip1zk0OoA`，`tool=bash`、`status=error`、`state.input` 为 text 且本身非法 JSON（`Expected ':' before value`）；所属 session 目录为 thirdparty 分支；创建于 2026-08-02。 | observed |
| `C:\Users\Lenovo\.local\share\opencode\opencode.db.maintenance\tasks\dbm_795d2498-*.json` | compress 任务 `failed`，cursor `owner=part`，processed 14148 / skipped 3496 / rawBytes 30181054 / compressedBytes 6696024，error 为 `ColdStorageCorruptionError: Stored tool input is invalid`；证明前面批次已提交、随后在 Part 阶段失败。 | observed |
| `C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T150235.log` | 用户原始症状：`ERROR ... ColdStorageCorruptionError: Stored tool input is invalid`。 | observed |
| `packages/opencode/src/storage/cold.ts`（537-556 `projectPartStats`、653-751 `extractPart`、915-945 `eligibility/eligible`、2518-2541 `eligibleOwnerCount`、2555-2590 `partCandidate`、2617-2775 `verifyWith/verify`、3185-3250 `maintain`、3439-3538 `status`） | `storedRecord(data.state.input, "Stored tool input is invalid")` 是精确报错点；`status`/`compress` 候选扫描都经 `partV2Value → projectPartStats` 触发；`verify` 是既有显式维护入口。 | observed |
| `packages/opencode/src/session/processor.ts`（594-636 `tool-call` case、408-445 `failToolCall`、1028-1041 cleanup） | `input: value.input` 直接把 AI SDK 的 `unknown` input 写入持久化 Part；`failToolCall`/cleanup 保留该值。 | observed |
| `packages/opencode/src/session/llm.ts`（363-380 `experimental_repairToolCall`、496-504 `resolveTools`、385 `activeTools` 过滤） | `resolveTools` 用 `Permission.disabled` 过滤，把内部 `invalid` repair Tool 也剔除；导致 repair 目标 `NoSuchToolError`，AI SDK 退回原始字符串 input。 | observed |
| `packages/opencode/src/tool/selection.ts`（1-18） | `INTERNAL = {"invalid","_noop","StructuredOutput"}`；注释明确“内部支持工具不暴露给模型 active list，但 provider repair 路径需要保留注册”。 | contracted |
| `packages/opencode/src/tool/registry.ts`（123、262-266、342-360） | `invalid` 在 builtin 列表、`tools()` 不过滤它；只有 `llm.ts resolveTools` 与 `prompt.ts resolveTools`（registry.tools 自带）两处过滤。 | observed |
| `packages/opencode/src/session/message-v2.ts`（358-430 `ToolState*` Schema、980 `decodePartRow`） | 持久 schema 要求 `input: Schema.Record(Schema.String, Schema.Any)`；写入链路不执行运行时解码。 | contracted |
| `packages/opencode/src/session/session.sql.ts`（21-41 `StoredToolState`） | 存储层把 `input` 放宽为 `unknown`（为 cold projection 服务），不是业务校验。 | contracted |
| `packages/opencode/src/session/projectors.ts`（226-257 `PartUpdated`）与 `packages/opencode/src/storage/cold.ts`（1981-1998 `replacePart`） | 唯一热 Part 写入 chokepoint；无运行时 schema 门禁；`cli/cmd/import.ts` 是唯一带 `Schema.decodeUnknownSync(MessageV2.Part)` 的写入入口。 | observed |
| `node_modules/ai/src/generate-text/parse-tool-call.ts`（80-97）、`tool-call.ts`（24-43）、`run-tools-transformation.ts`（279-288）、`tool-call-repair-function.ts`（20-27） | AI SDK 契约：解析失败且 repair 未成功时，`tool-call` 事件的 `input` 可以是原始字符串（`invalid: true` 动态调用）；随后发 `tool-error`。 | contracted |
| `node_modules/ai/src/error/no-such-tool-error.ts`（13-30） | `Model tried to call unavailable tool 'invalid'. Available tools: ...` 消息来源，与坏行 error 文案逐字吻合。 | observed |
| `packages/opencode/test/storage/cold.test.ts`（180-258、562-664、1136-1166） | 既有冷存储测试 seam：直接操作 table row 制造 corruption fixture、`ColdStorage.verify({repair})`、`prepareMaintenance` verify 字面量（1166、1187）。 | observed |
| `packages/opencode/test/session/processor-effect.test.ts`（1-120、1136-1302） | 真实 processor + fake HTTP LLM server（`TestLLMServer`/`reply`/`raw`/`toolStartLine`/`toolArgsLine`）集成 seam。 | observed |
| `packages/opencode/test/lib/llm-server.ts`（500-592） | `reply().tool()` 输出合法 JSON；`raw({chunks})` 可输出任意 SSE（含非法 tool arguments）。 | observed |
| 红循环 fixture：`D:\Temp\opencode\cold-repro\data\opencode\opencode.db`（project/session/message/part 四行真实数据） | 见 §8 反馈回路。 | observed |

## 5. Current Behavior

```text
model 生成非法 JSON 的 bash 参数
  -> AI SDK streamText 解析 bash 参数失败 (InvalidToolInputError)
  -> opencode experimental_repairToolCall 返回 { toolName: "invalid", input: JSON.stringify({tool,error}) }
  -> resolveTools 已按 agent "* deny" 把内部 invalid Tool 过滤出 tools
  -> AI SDK doParseToolCall("invalid") 再次 NoSuchToolError
  -> parseToolCall 兜底产出 DynamicToolCall { invalid: true, input: <原始非法 JSON 字符串> }
  -> processor "tool-call" case 直接写入 state.input = value.input (string)
  -> failToolCall/cleanup 保留该 input 写入 ToolStateError
  -> SQLite 外层 JSON 合法，坏行入库
  -> db status/compress 候选扫描 -> projectPartStats -> storedRecord -> CorruptionError("Stored tool input is invalid")
```

可观察结果（用户原始症状）：

```text
● Compressing cold data
Error: Unexpected error, check log file at C:\Users\Lenovo\.local\share\opencode\log\2026-08-07T150235.log for more details
ColdStorageCorruptionError: Stored tool input is invalid
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `tool-call` 事件 `input` 为 string（非法 JSON，invalid dynamic call） | AI SDK 6.0.168 `parseToolCall` 兜底（`parse-tool-call.ts:82-97` 显式契约：`input = parsedInput.success ? parsedInput.value : toolCall.input`） | 无；SDK 文档化行为 | `llm.ts streamText fullStream -> processor handleEvent "tool-call" -> session.updatePart -> projector -> replacePart` | processor（事件消费 seam） | observed（坏行）+ contracted（SDK 源码） |
| `input` 为其他非 object（array/number/null） | 同上兜底路径（`toolCall.input` 是 string，`safeParseJSON` 失败时保留原串；动态调用可携带任意值） | 无 | 同上 | processor | reachable |
| 内部 `invalid` Tool 被 `* deny` 权限过滤 | `llm.ts resolveTools`（`Permission.disabled` 把 `invalid` 计入 deny） | `ToolSelection` 注释声明 repair 路径需要保留注册（contracted intent），但 `llm.ts` 未遵守 | agent 配置 `"*": deny` + 白名单工具（坏行所属 agent 正是该配置） | llm.ts（工具集合组装） | observed |
| 内部 `invalid` Tool 被 `input.user.tools.invalid = false` 过滤 | `PromptInput.tools` 接受任意 Tool map 并传入 `llm.ts resolveTools` | 无上游约束禁止内部 Tool key；内部 Tool 必须保留注册供 repair | 公开 PromptInput 配置 `tools: { invalid: false }` | llm.ts（完整工具集合组装边界） | reachable |
| `experimental_repairToolCall` 目标不存在 | AI SDK `doParseToolCall` 对不在 tools 中的名字抛 `NoSuchToolError` | 无 | repair 失败 -> 兜底 DynamicToolCall | AI SDK（外部） | observed |
| 其他写入入口（import/ACP/plugin） | `cli/cmd/import.ts` 经 `Schema.decodeUnknownSync(MessageV2.Part)` 校验；ACP 无 `updatePart` 直写；plugin tool 走 processor 同一路径 | 有（import 已校验） | 无绕过 processor 的当前热写入路径 | - | speculative（不驱动任何改动） |

结论：不需要在 `replacePart` 加第二道门禁——当前没有可证实的、绕过 processor 的独立非信任写入 seam，import 已自行校验；在持久化层重复 processor 的归一化属于 duplicated responsibility（policy §Guards）。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 持久化 `ToolState.input` 必须满足 `MessageV2.ToolState` schema 的 `input: Record<string, unknown>` | `message-v2.ts:358-430`（contracted）；坏行违反（observed） | 无（本计划新增） |
| INV-02 | agent 的 `* deny` 权限只过滤用户可配置 Tool；内部 repair Tool（`invalid`）必须保留在 AI SDK `tools` 注册表（不进入 `activeTools`） | `tool/selection.ts:10-13` 注释契约；坏行 error 文案 `Available tools: bash, glob, grep, read` 证明被过滤 | 无（本计划新增） |
| INV-03 | 既有坏数据修复必须经用户显式维护命令，且默认只读报告 | `db verify` 既有 `--repair` 语义（cold.ts:719 注释）；policy 禁止静默改写用户数据 | `db-maintenance.test.ts`（既有 verify 测试） |
| INV-04 | 损坏检测不得降级为跳过/成功（`storedRecord` 的 CorruptionError 保留） | policy §Primary-Path Rules；cold.ts 设计文档 §Error | `cold.test.ts:562-664`（corruption hard-fail 用例） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-02 | `llm.ts resolveTools` 把内部 `invalid` 视为普通用户 Tool，被 `Permission.disabled` 剔除 | `packages/opencode/src/session/llm.ts`（工具集合组装 seam） | 坏行 error 文案 + `selection.ts` 注释契约；repair 目标因此二次 `NoSuchToolError` |
| INV-01 | processor `tool-call` case 把 AI SDK 的 `unknown` input 直接写入 Part | `packages/opencode/src/session/processor.ts`（LLM 事件消费 seam） | AI SDK `parse-tool-call.ts` 兜底契约 + 坏行持久化形态 |

第一 divergence 判定：INV-02 的违反导致 repair 路径失效，是观察场景的触发源头（repair 本应把非法调用转换为合法的 `invalid` 调用、input 为 object）；INV-01 的违反发生在持久化写入点，是 schema 不变量首次失效之处。两个 divergence 都位于生产代码中“会产生该种错误 schema 的代码路径”，按用户要求都需精准修复。下游症状（`ColdStorageCorruptionError`、compress 失败）不是根因，不做任何降级处理。

### Red-capable feedback loop（已实际运行）

最小复现 fixture（真实坏行原样播种，project/session/message/part 共 4 行）：

```text
fixture: D:\Temp\opencode\cold-repro\data\opencode\opencode.db
seed:    D:\Temp\opencode\cold-repro\seed.ts（从用户 opencode.db 只读拷贝真实 4 行）
```

命令（workdir `packages/opencode`，需清除 `OPENCODE_PROCESS_ROLE` 等 daemon 环境变量）：

```powershell
$env:OPENCODE_DB = "D:\Temp\opencode\cold-repro\data\opencode\opencode.db"
bun ./src/index.ts db status
```

观察结果（red）：

```text
exit=1
Error: Unexpected error, check log file at C:\Users\Lenovo\.local\share\opencode\log\dev.log for more details
Stored tool input is invalid
```

与用户原始症状一致（`db status` 与 `db compress` 共享同一候选扫描路径：`status()/eligibleOwnerCount → partV2Value → projectPartStats → storedRecord`）。运行约 10 秒（含冷启动），确定性触发，最小化后仅剩 1 条坏 Part 为 load-bearing。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 内部 Tool 免于用户权限过滤 | `llm.ts resolveTools`（工具集合组装） | `ToolSelection.isUserConfigurable` 已定义内部/用户边界；`selection.ts:10-13` 注释声明 repair 注册意图 | `invalid` 注册表由 registry 提供、`llm.ts` 是最后组装点；`prompt.ts` 已在前面按 `ToolSelection.enabled` 过滤 | `tool/selection.ts` 只声明谓词不组装集合；`tool/registry.ts` 无权限概念 |
| 事件流 `unknown` input 归一化 | `processor.ts`（LLM 事件消费 seam） | `MessageV2.ToolState.input` 契约；processor 是 AI SDK fullStream 的唯一消费点 | 首个非信任 seam（SDK 公开契约允许 string input）；失败 Tool 已由 SDK 标记 invalid/error，归一化不构成成功路径 | `projectors/replacePart` 无独立非信任写入者（import 已自行校验） |
| 既有坏行修复 | `cold.ts`（持久化 owner） | 既有 `db verify --repair` 显式维护入口 | 扫描 SQL 与 `partCandidate` 同源；事务/租约/checkpoint 复用既有 verify task 机制 | `db.ts` 只做 flag 传递；`worker.ts` 无需改动（verify task 走既有 task-backed 路径） |

## 10. Single Approved Primary-Path Design

一条主路径：**修复产生坏 schema 的两处生产代码路径 + 为既有坏数据提供显式修复能力**。

```text
[模型非法 JSON 参数]
  -> AI SDK 解析失败
  -> repairToolCall 目标 invalid 保留注册（Fix A: llm.ts resolveTools 豁免内部 Tool）
  -> AI SDK 将非法调用修复为合法 invalid 调用（input = {tool, error} object）
  -> 即使 repair 仍失败：processor 归一化 input（Fix B: isRecord ? input : {}）
  -> 持久化 ToolState.input 恒为 object（INV-01 成立）
  -> 既有坏行：db verify --repair-tool-input（Fix C: cold.ts 扫描+归一化，任务/租约复用 verify）
```

**Fix A — `llm.ts`（~8 行）**：`resolveTools` 过滤条件改为“用户权限只作用于用户可配置 Tool”：

```ts
return Record.filter(
  input.tools,
  (_, key) =>
    !ToolSelection.isUserConfigurable(key) ||
    (input.user.tools?.[key] !== false &&
      !disabled.has(key) &&
      ToolSelection.enabled(key, input.permission)),
)
```

`activeTools` 过滤（`llm.ts:385`）保持不变：`invalid` 不暴露给模型。内部 Tool 在完整用户禁用边界（`input.user.tools` 与 `Permission.disabled`）上豁免注册过滤；用户可配置 Tool 仍保留 `ToolSelection.enabled` 与原有禁用条件。这恢复 `experimental_repairToolCall` 的既定契约，同时不改变用户 Tool 权限。

**Fix B — `processor.ts`（~10 行）**：`tool-call` case 写 `state.input` 前归一化：

```ts
function normalizeToolInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}
```

`isRecord` 已由 `@/util/record` 导入。SDK 标记 `invalid: true` 的调用必然伴随 `tool-error`，`{}` 只是 schema 合规的占位，不是成功路径；该 Tool 不会被执行（AI SDK 对 invalid call 不发 execute）。

**Fix C — `cold.ts`（~50 行）+ `db.ts`（~5 行）**：为既有坏行提供显式修复，复用既有 `verify` task-backed 机制：

- `VerifyReport` 增加 `toolInputFixed: number`（additive，只读 verify 为 0）。
- `MaintenanceRequest` 的 verify 变体增加可选 `repairToolInput?: boolean`（`parseMaintenanceRequest` 默认 false；类型可选，保持既有测试字面量 `{ operation: "verify", repair: true, batchSize }` 兼容）。
- `prepareMaintenance` task-backed 条件：`verify && (repair || repairToolInput)`。
- `verifyWith(db, { repair, repairToolInput })`：`repairToolInput` 为 true 时先执行 `repairToolInputShape(db)`——SQL 谓词与 `partCandidate` 同源（`type='tool'` 且 `state.status in ('completed','error')` 且 `json_type(state.input) <> 'object'`），逐行：string 且可 JSON.parse 为 object 则取解析结果，否则 `{}`；仅更新 `data`（保留 `time_updated`），返回修复数。整个 verify task 已由 `maintain` 包在 immediate transaction + maintenance lease 内。
- 公开 `verify(input)` 的事务门禁同步更新为 `if (!input.repair && !input.repairToolInput) return Database.use(...)`，否则走 `Database.transaction(..., { behavior: "immediate" })`——`repairToolInput` 单独为 true 时（T1/T2 直接 API 路径）也必须获得 immediate transaction 写权限。
- `db.ts` `VerifyCommand` 增加 `--repair-tool-input` flag，传入 request。

修复语义说明：非 object 的 input 无法重建为合法 Tool input（原始值本身违反 schema），`{}` 是唯一 schema 合规表示；该行本就对应未执行的失败/非法调用，`state.error` 保留原始错误信息。修复前用户应先备份数据库（沿用 `db verify --repair` 的显式授权模式）。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `storedRecord` CorruptionError 保留 | current | primary-contract 损坏检测（diagnostic） | no | - | preserve（INV-04） |
| processor `normalizeToolInput` 的 `{}` 分支 | proposed | primary-contract 分支：非 object input 的 schema 合规表示（该 Tool 已被 SDK 判 invalid/error，无执行语义） | no（不产生工具成功执行） | ~1/5 分支 | add（INV-01 必需） |
| `db verify --repair-tool-input` | proposed | 显式维护诊断/修复路径（用户显式调用；默认只读） | no（修复数据不伪造成功，report 如实计数） | 1 个分支 + 1 个 SQL 谓词 | add（INV-03） |
| repair 时 JSON.parse 成功取解析对象 | proposed | primary-contract 分支：可恢复输入的规范化 | no | 与 `{}` 分支同属一个 helper | add |
| “compress 遇坏行自动跳过/自动修复” | rejected | forbidden fallback | yes | - | reject（INV-04；隐藏损坏） |
| “replacePart 加运行时 schema 门禁” | rejected | duplicated responsibility（无独立非信任写入 seam） | - | - | reject（§6 speculative） |
| “扩展 ToolState schema 保留 rawInput” | rejected | speculative（无产品证据） | - | - | reject |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `llm.ts resolveTools` 对内部 Tool 做用户权限过滤 | 与 `ToolSelection` 内部边界契约不一致的历史行为；`prompt.ts` 已按 `enabled` 过滤、`llm.ts` 又重复过滤且未豁免内部 Tool | Fix A 恢复单一边界：用户权限只过滤用户可配置 Tool，内部 Tool 只注册不暴露 | `llm.ts resolveTools` 过滤条件（修改而非新增） |
| （无其他需删除的 workaround） | - | - | - |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-02：`* deny` agent 下内部 repair Tool 保留注册、不进入 activeTools | `llm.ts resolveTools` 豁免 `!isUserConfigurable` | `session/llm.ts`（Fix A） | T4（processor-effect 集成测试：非法 bash JSON + `* deny` agent → 持久化 input 为 object 且 repair 路径生效） |
| INV-01：AI SDK string/非 object input 不落入持久化 | `processor.ts` `tool-call` case 归一化 | `session/processor.ts`（Fix B） | T4 + T6（processor 直接注入 string/数组 input 事件 → Part input 为 `{}`） |
| INV-03：既有坏行可经显式维护命令修复，默认只读 | `cold.ts verifyWith/repairToolInputShape` + `db.ts VerifyCommand` | `storage/cold.ts` + `cli/cmd/db.ts`（Fix C） | T1/T2/T3（cold.test.ts）+ T5（db-maintenance CLI 端到端） |
| 用户原始症状消除（`db status`/`compress` 不再抛错） | 修复后坏行被归一化，候选扫描通过 | Fix C | 红循环复跑 + T5 |
| INV-04：损坏检测不降级 | `storedRecord` 不变 | 无改动 | T3（只读 verify 后 status 仍抛错，证明未隐藏损坏） |
| ≤4 生产文件、≤200 生产行 | 见 §15 | 4 个生产文件 | 实施后统计 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `resolveTools` 豁免 `!isUserConfigurable` | INV-02 | 坏行 error 文案（`Available tools: bash, glob, grep, read`）+ `selection.ts:10-13` 契约注释 | 现有 `Permission.disabled` 无条件过滤所有工具名；`ToolSelection` 谓词存在但未被 `llm.ts` 使用 |
| `normalizeToolInput` helper | INV-01 | AI SDK `parse-tool-call.ts:82-97` 契约 + 坏行持久化形态 | `MessageV2.ToolState` schema 只在读取/import 边界执行，写入边界无解码 |
| `repairToolInputShape` SQL 谓词 + 归一化 | INV-03、用户症状消除 | 坏行唯一存在（全库查询证实）且 compress/status 扫描会命中 | `verifyWith` 只校验 payload/refcount，不扫描 hot Part 的 input 形状；`cleanup` 只删 orphan payload |
| `verify` 变体 `repairToolInput` + task-backed | INV-03 | 既有 `verify --repair` 显式授权模式（db.ts:719 注释、prepareMaintenance taskBacked） | `MaintenanceRequest` 现有 verify 变体只有 `repair`；新增标志复用既有 task/lease/checkpoint 机制，无需新调度代码 |
| `VerifyReport.toolInputFixed` | INV-03 | report 需如实区分“扫描过/修复过”，与既有 `repaired` 字段同语义 | 无现有字段承载 tool-input 修复计数 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/llm.ts` | modify | `resolveTools` 内部 Tool 豁免 + `ToolSelection` import | +8 ~ +10 |
| `packages/opencode/src/session/processor.ts` | modify | `normalizeToolInput` helper + `tool-call` case 调用 | +10 ~ +14 |
| `packages/opencode/src/storage/cold.ts` | modify | `repairToolInputShape`、`VerifyReport` 字段、`MaintenanceRequest` verify 变体、`parseMaintenanceRequest`、`prepareMaintenance` taskBacked、`verifyWith`/`verify`/`maintain` 传递 | +45 ~ +55 |
| `packages/opencode/src/cli/cmd/db.ts` | modify | `VerifyCommand` 增加 `--repair-tool-input` 并传入 request；`renderTask` 的 detail 标签条件扩展为 `repair || repairToolInput`（N-02，避免任务视图把 tool-input 修复误标为普通 verify） | +5 ~ +7 |
| `packages/opencode/test/storage/cold.test.ts` | modify | T1/T2/T3（修复能力、可解析字符串、只读不动） | +60 ~ +80 |
| `packages/opencode/test/session/processor-effect.test.ts` | modify | T4（非法 bash JSON + `* deny` agent 集成） | +35 ~ +50 |
| `packages/opencode/test/cli/db-maintenance.test.ts` | modify | T5（CLI `verify --repair-tool-input` 端到端 + status 恢复） | +30 ~ +45 |

生产行合计约 70~85（预算 200 内）；测试合计约 125~175；总计约 195~260（预算 500 内，实际实施为 414 changed lines）。

## 16. TDD Behavior Slices

测试 seam：公开维护 API（`ColdStorage.verify`/`status`）与公开 session 持久化路径（processor + fake LLM server）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | T1：坏行（string input）存在时 `ColdStorage.status()` 抛 `Stored tool input is invalid`；`verify({repairToolInput:true})` 后 status 不再抛且 `toolInputFixed===1`，input 变为 `{}` | `projectPartStats` 对非 object input 抛 CorruptionError；verify 无修复路径 | `repairToolInputShape` 归一化坏行 | INV-01 修复路径 + INV-04 不隐藏损坏 |
| 2 | T2：string 为合法 JSON object 时修复后 input 为解析后的 object（非 `{}`） | 修复函数未实现解析分支 | JSON.parse 成功取 object | 可恢复输入不丢失 |
| 3 | T3：`verify({repair:false})` 不改行、`toolInputFixed===0`，status 仍抛错 | 只读 verify 未触碰行（现状即如此，测试锁定） | 保持现状 | 默认只读、损坏不被隐藏 |
| 4 | `* deny` + 白名单 agent，且 `input.user.tools` 显式包含 `invalid: false` 时，mock LLM 返回非法 JSON bash tool call，结束后持久化 tool part 的 input 是 object，repair 路径把调用转为 `invalid`（completed、input 含 `{tool, error}`） | `resolveTools` 的任一用户禁用边界都可能剔除 invalid 使 repair 失败；processor 直写 string | Fix A + Fix B | INV-02 修复路径 + INV-01 事件 seam；测试意图注释须说明：非法 JSON 必须走 `raw` SSE 而非 `reply().tool()`，且内部 Tool 不受 user-tool disable map 影响 |
| 5 | T5：CLI `db verify --repair-tool-input`（fixture DB）task completed、随后 `db status` 退出 0，SQL `json_type(state.input)` 为 object；修复数量由同步 API T1 的 `toolInputFixed===1` 断言覆盖，task JSON 不承载该字段 | 同 T1，但走完整 CLI/任务/租约链路 | Fix C 的 CLI 面 | 用户原始场景端到端 |
| 6 | T6：processor 收到 `tool-call` 且 input 为数组/数字等非 object 时，持久化 input 为 `{}`（不抛、不写坏形） | 现状直写 | Fix B 的 `{}` 分支 | INV-01 全输入域 |

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~342（生产与测试，排除 import/格式化/纯注释/纯移动） | 以 §23 实际 diff 统计为准 |
| Required Chinese explanatory comments `C` | 53（`ceil(0.15 * 342)` 需要 52） | `E=0 → C=0`；否则 `C >= max(1, ceil(E*0.15))` |

需要邻近中文解释的不变量/边界（计划 C ≥ 11）：

- Fix A：内部 Tool 豁免只作用于注册表、`activeTools` 仍排除（为何不暴露给模型）。
- Fix B：`{}` 只出现在 SDK 已判 invalid/error 的调用上，不构成成功路径；非 object 无法重建合法 input。
- Fix C：SQL 谓词与 `partCandidate` 同源；修复只改写 `data`、保留 `time_updated` 与 `cold_ref/cold_key`；`repairToolInput` 必须与 `repair` 一样进入 task-backed（写事务需要 maintenance lease）。
- `VerifyReport.toolInputFixed` 与 `repaired` 语义分离（refcount 修复与 input 形状修复独立计数）。
- T4 中“非法 JSON 必须走 `raw` SSE 而非 `reply().tool()`（后者总会 stringify 成合法 JSON）”的测试意图。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/storage/cold.test.ts` | `packages/opencode` | T1/T2/T3 绿 |
| `bun test test/session/processor-effect.test.ts` | `packages/opencode` | T4/T6 绿 |
| `bun test test/cli/db-maintenance.test.ts` | `packages/opencode` | T5 绿（CLI 端到端） |
| `bun typecheck` | `packages/opencode` | 类型通过 |
| `$env:OPENCODE_DB=fixture; bun ./src/index.ts db status`（先 `db verify --repair-tool-input`） | `packages/opencode` | 原红循环转绿：status 退出 0 |
| 完整候选集 `bun test`（package 内相关 suite） | `packages/opencode` | 无回归 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | 不新增文件 |
| Files modified | 4 生产 + 3 测试 | 用户约束 ≤4 生产文件 |
| Files deleted | 0 | - |
| Production lines | ~118 changed lines | 用户约束 ≤200 |
| Test lines | ~296 added lines | 用户约束总 changed lines ≤500 |
| Generated lines | 0 | 无迁移/生成物 |

## 20. Real Risks and Open Decisions

- 修复 `{}` 会丢失坏行原始 input 内容：该内容本身违反 schema 且无法重建为合法 Tool input；对应调用从未成功执行，`state.error` 保留错误文案。风险可接受（属显式维护授权行为，报告 `toolInputFixed` 数量）。
- `repairToolInputShape` 全表谓词扫描：谓词在 SQL 层过滤（`json_type`），仅在显式维护命令时运行；1.8GB 库上预计数秒级，可接受（与 `eligibleOwnerCount` 同一扫描成本级）。
- 既有 `verify` task 的 `VerifyReport` 新增字段：`db-maintenance.test.ts`/`daemon.test.ts` 若有整对象断言需同步（实施时核对；已知两处 `prepareMaintenance` 字面量因类型可选不破坏）。

### Rejected Speculation

- `replacePart` 加运行时门禁：无独立非信任写入 seam（§6 结论），属 duplicated responsibility。
- 扩展 `ToolStateError` 增加 `rawInput`：无产品证据；会牵动 cold extraction/restore/stats/export 全链路，超出克制约束。
- compress 扫描自动修复坏行：属失败后恢复分支（forbidden fallback），且会隐藏损坏证据。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15
  percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 无 | N-01（doom_loop 键收敛，窄双失败路径，无需修改）、N-02（verify 任务标签，已并入 §15）、N-03（缺失 input 行无生产者，speculative 不驱动改动）、N-04（verify() 事务门禁，已并入 §10） | No blocking findings / APPROVE | ses_02117df99ffeemSP13GODqRz2J（并行第二审计会话 ses_02117d953ffeen4T7hMRuiC4yO 无输出丢失，不影响本 verdict） |  |
| 2 | R2 | yes | B-01（Fix A canonical snippet 漏写既有 `ToolSelection.enabled` 权限谓词；A 判 BLOCK） | N-01（内部 Tool 豁免范围宽于 invalid）；N-02（T6 数组/数字测试 seam 未具体展示）；N-03（完整候选集命令边界未具体化）；N-04（R2 需独立记录审计结果） | 分歧：A 为 BLOCK，B 为 No blocking findings / APPROVE；已修订为 R3 | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |
| 3 | R3 | yes | B-01（`input.user.tools.invalid = false` 仍可过滤内部 `invalid` Tool；B 判 BLOCK） | N-01（T6 fixture 未具体化）；N-02（完整候选集命令边界开放）；N-03（内部 Tool 范围宽于 invalid）；N-04（历史审计记录需单独保留） | 分歧：A 为 No blocking findings / APPROVE，B 为 BLOCK；已修订为 R4 | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |
| 4 | R4 | yes | 无 | N-01（T6 fixture 仍需实现证据具体化）；N-02（broad-suite 命令边界略开放）；N-03（内部 Tool 豁免覆盖完整内部集合，需保留明确 rationale）；N-04（历史审计记录需与 R4 verdict 分开） | No blocking findings / APPROVE（两次独立审计一致） | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |

R4 审计 A 逐字结论：

```text
No blocking findings.
Plan verdict: APPROVE
R4 is a complete, evidence-backed canonical plan for the requested scope. The prior Fix A permission-boundary finding is resolved: internal Tools bypass both user-tool and wildcard disabled registration filters, while user-configurable Tools retain all existing permission conditions. Remaining issues are non-blocking clarification and verification-record gaps.
```

R4 审计 B 逐字结论：

```text
No blocking findings.
Plan verdict: APPROVE — R4 plan
R4 resolves the prior reachable Fix A gap by making internal Tools bypass both `input.user.tools` and `Permission.disabled`, while retaining `ToolSelection.enabled` and the existing disable conditions for user-configurable Tools. It covers the full producer/consumer chain, repairs both first divergences at their owning seams, preserves normal user Tool permission behavior, avoids forbidden fallback paths, provides complete forward/reverse traceability, adds the relevant T4 regression scenario, remains within all revised budgets, and satisfies the Chinese-comment plan gate.
```

## 23. Implementation Evidence

### Actual Files and Diff

```text
packages/opencode/src/cli/cmd/db.ts                | 14 additions / 4 deletions
packages/opencode/src/session/llm.ts              |  5 additions / 1 deletion
packages/opencode/src/session/processor.ts        |  8 additions / 1 deletion
packages/opencode/src/storage/cold.ts             | 73 additions / 11 deletions
packages/opencode/test/cli/db-maintenance.test.ts | 44 additions
packages/opencode/test/session/processor-effect.test.ts | 198 additions（T4/T6 + parsed array + invalid:false 边界）
packages/opencode/test/storage/cold.test.ts       | 96 additions
总计 438 insertions / 17 deletions，455 changed lines（≤500 预算）
```

### Red-Green Test Evidence

- T1/T2/T3（cold.test.ts）：RED——`report.toolInputFixed` undefined、status 抛 `Stored tool input is invalid`；GREEN——修复后 toolInputFixed=1、input 归一化、status 不再抛。
- T6（processor-effect.test.ts，v1-only env）：malformed string 与 safeParseJSON 成功后的 array 都走真实 LLM/processor seam；Fix B 前非 object 会直接持久化，GREEN——两者均为 `{}`。
- T4（processor-effect.test.ts）：RED——`input.user.tools.invalid=false` 时 status=error（repair 目标被过滤）；GREEN——status=completed、input 含 `{tool: "bash", error: <string>}`。
- T5（db-maintenance.test.ts）：RED——`db status` exit 1 且 stderr 含错误；GREEN——`db verify --repair-tool-input` exit 0、行 input 变为 object、`db status` exit 0。

### Verification Commands and Results

| Command | Directory | Result |
| --- | --- | --- |
| `bun test test/storage/cold.test.ts` | packages/opencode | 35 pass / 0 fail |
| `bun test test/session/processor-effect.test.ts --timeout 30000` | packages/opencode | 26 pass / 0 fail（含 parsed-array T6；默认 5s 超时在负载环境下偶发 timeout，30s 下全绿） |
| `bun test test/cli/db-maintenance.test.ts` | packages/opencode | 14 pass / 1 个预存 compress-vacuum 时序 flake；T5 通过，目标用例隔离通过 |
| `bun typecheck` | packages/opencode | exit 0；此前 smoke 文件错误已不再出现 |

### Original Feedback-Loop Result

R4 当前实现已在获授权的临时 fixture 上完成完整复跑：

```text
$env:OPENCODE_DB=<fixture>; bun ./src/index.ts db status        -> exit 1，stderr 含 “Stored tool input is invalid”（RED）
bun ./src/index.ts db verify --repair-tool-input              -> exit 0（task completed）
bun ./src/index.ts db status                                  -> exit 0（GREEN）
bun ./src/index.ts db compress --older-than 0ms --json       -> exit 0，processed 1 / raw 204 → compressed 172

fixture：`D:\Temp\opencode\audit-repro\data\opencode\opencode.db`；用户真实数据库未修改。
```

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| `normalizeToolInput` 的 `{}` 分支 | primary-contract 分支（SDK 已判 invalid 的调用，不执行） | 实现 |
| `repairToolInputShape` 的 JSON.parse 恢复分支 | primary-contract 分支（可重建输入不丢失） | 实现 |
| `db verify --repair-tool-input` | 显式维护诊断/修复路径（默认只读、task-backed 写） | 实现 |
| compress 自动跳过/自动修复坏行 | forbidden fallback | 未实现（拒绝） |
| replacePart 运行时门禁 | duplicated responsibility（无独立非信任写入 seam） | 未实现（拒绝） |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~378（生产与测试） | 排除 import、纯注释、格式化与纯移动；新增 parsed-array T6 的 executable test lines 纳入 E |
| Qualifying Chinese comment lines `C` | ~58 | 见下方代表性注释；新增 T6 注释解释 parsed-array seam 与公开 Part 契约 |
| Ratio `C / E` | ~0.153 | - |
| Required minimum `C` | 57 | `ceil(0.15 * 378)` |

代表性注释（邻近修改点、解释 invariant/真实边界/测试意图/compatibility/safety，不复述代码）：`llm.ts` resolveTools 豁免（内部 repair Tool 保留注册、activeTools 仍排除）；`processor.ts` normalizeToolInput（非 object 只出现在 SDK 已判 invalid 的调用，空对象不构成成功路径）；`cold.ts` repairToolInputShape 头部（谓词与 partCandidate 同源、completed/error 是唯一可冻结状态、置空理由）、verifyWith（修复与 refcount repair 同一事务）、verify()（两类修复共享同一 immediate 事务边界）、VerifyReport（独立计数）；`db.ts` verify 命令（--repair-tool-input 独立授权写事务）；测试侧：seedMalformedToolPart（绕过 Schema 校验才能构造真实损坏形态）、T1（{} 是契约占位）、db-maintenance T5（CLI 完整往返覆盖 task-backed 边界、SQL 断言不依赖 task 计数）、processor-effect T4/T6（Fix A 回归哨兵、Fix B 不依赖 invalid 注册）。

> 历史 R1 曾补充中文解释注释；R4 当前实际值为 E≈378、C≈58、ratio≈0.153，以本节当前计算为准。

### Remaining Unverified Items

- 用户真实 1.8GB 数据库未执行修复（需用户显式运行 `opencode db verify --repair-tool-input`；fixture 已证明同路径可修复）。
- 8 个 processor-effect 用例在 5s 默认超时下于高负载环境偶发 timeout；30s 超时下全绿，与本改动无关（隔离运行亦通过）。
- `db-maintenance.test.ts` 整跑 14/15：1 个预存 compress-vacuum 时序 flake（负载下超时，隔离 31.7s 通过），与本 diff 无关；最终 `bun typecheck` exit 0 全绿。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | 无 | N-01 E/C 含测试时 0.11 < 0.15（补注释后 0.155）；N-02 task 输出不含 toolInputFixed（plan 描述偏差）；N-03 doom_loop 键收敛（plan 已接受）；N-04 StructuredOutput 在 `* deny` 下可见（功能改善）；N-05 verify task skipped 计数不含 toolInputFixed（cosmetic）；N-06 缺 input 键行不修复（plan N-03 已接受） | No blocking findings / APPROVE（两次独立审计一致） | ses_020e2f497ffeKZE5yNttu0T6ME（A）、ses_020e2ebc1ffepNin8pRUHQaeEl（B） |
| 2 | R1 | yes | B-01 当前 diff 为 397 additions + 17 deletions = 414 changed lines，超过 R1 的 ≤400 约束 | N-01 task 输出不含 toolInputFixed；N-02 typecheck 记录矛盾；N-03 实施证据过期；N-04 内部 Tool 豁免范围宽于 invalid | BLOCK（R1 复议；两次独立审计一致） | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |
| 3 | R2 | yes | B-01（A：Fix A canonical snippet 漏写 `ToolSelection.enabled`；B：`input.user.tools.invalid = false` 仍可过滤内部 Tool） | N-01 T6 seam 抽象；N-02 broad-suite 命令未具体化；N-03 内部 Tool 范围宽于 invalid；N-04 历史审计记录需与当前 verdict 分开 | BLOCK（R2 复审；存在已证实 producer 路径） | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |
| 4 | R4 | yes | 无 | N-01 CLI/full package suite 时序敏感；N-02 broad-suite 边界开放；N-03 processor suite 需 30s timeout；N-04 内部 Tool 豁免覆盖完整内部集合；N-05 用户真实数据库按要求未修改 | No blocking findings / APPROVE — exact current implementation against approved R4（两次独立审计一致） | ses_01fc4546effek7M4xnfxpm5JVS（A）、ses_01fc45381ffeHeqrtGcy3h6YVi（B） |

R4 implementation audit A 逐字结论：

```text
No blocking findings.
APPROVE
The exact current implementation against approved R4 has no remaining blocking findings. It repairs both identified first divergences, covers the newly required parsed-array T6 behavior through the real producer/consumer seam, preserves permissions and corruption detection, provides explicit historical-row repair, respects all budgets, and contains no unauthorized fallback. Remaining test-suite flake, unrerun verification commands, and real-database operational execution are explicitly documented gaps and do not establish a change-induced release blocker.
```

R4 implementation audit B 逐字结论：

```text
No blocking findings.
APPROVE — exact current implementation against approved R4
The implementation satisfies the full original requirement and revised budgets. It repairs both producer-side divergences, preserves user Tool permissions and corruption detection, supports explicit existing-row repair, verifies malformed-string and parsed-array input through the real processor path, and reproduces the original database-maintenance recovery sequence on the authorized fixture.

The package-wide and CLI timing failures remain recorded as non-blocking verification gaps because they do not implicate or arise from the audited behavior.
```

审计 A 逐字结论：

```text
No blocking findings.
APPROVE — the actual diff against approved revision R1 implements the approved primary-path repair (Fix A/B/C), preserves corruption detection (INV-04), keeps db compress operational, respects the file/line budgets, passes all changed test suites and typecheck, and the original user-visible RED→GREEN loop was reproduced first-hand (status exit 1 → verify --repair-tool-input → status exit 0 → compress exit 0).
```

审计 B 逐字结论：

```text
APPROVE — exact audited diff against approved plan revision R1. No blocking findings; every hard gate passes (root-cause repair at both first-divergence owners, no fallbacks, ownership respected, INV-01–INV-04 verified, red-green tests pass, original symptom loop reproduced RED→GREEN→compress, E/C floor passes, ≤4 production files / ≤400 total lines, typecheck clean).
```

审计后动作：按双方 N-01 追加 15 行合格中文注释（C≈53，ratio≈0.155），纯注释无行为变化；`db-maintenance.test.ts` 整跑 14/15（1 个预存 compress-vacuum 时序 flake，隔离运行通过，与本 diff 无关）。
