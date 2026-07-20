# Canonical Implementation Plan: Task ID Illegal Resolution

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: Current Session GOAL user requirement quoted in section 1
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-07-21

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 0. Revision History

| Rev | Why |
| --- | --- |
| R1 | 初稿：26-body 补 `ses_`、miss→create+notice、inspected 跟 resolve |
| R2 | 修复 plan audit **B-01**：`SessionID.make` 对非 `ses*` 字符串同步抛 brand 错误，不能作为候选求值入口；修正现状描述与 TDD 覆盖 |

Resolved audit findings incorporated in R2:

- **B-01**（blocking）：候选求值不得对 raw 直接 `SessionID.make`；只有通过域检查或显式构造的 `ses_`+26 body 才 brand+get；brand/域不合格 = 候选未命中。

## 1. Verbatim Requirement

> 当前的整体task ID传递是有一点小麻烦的,因为有一些模型它可能在预训练的过程中,它会在相应的post-train的过程中刻意地强调模型必须传递task ID,所以导致模型即便不想传递task ID,它也可能进行一个非法的task ID传递,这就导致模型多次调用,它都以为自己没传递,但实际上传递了,会导致最终出现问题。因此,你看看能不能适当优化,解决一下,看看这个方案能不能改进一下。也就是我们理论上来说,如果模型传递了一个非法的task ID,那么我们可以首先看看它是不是一个26字符,同时这个前面如果加上SES这个下划线,看看能不能组装成一个准确的已有的task ID。如果存在的话,那么我们就调用那个。如果它不存在的话,也就是譬如说这不是一个26字符,或者它根本就不存在的话,那么我们就直接创建一个新的task。同时在task返回的时候,我们可以加一个相应的open code的一个notice或者什么东西来提示它,这是一个全新的task,由于传递了一个非法的task ID。请你看看这样的完整的方案应该去怎么去构建,同时保证相应的修改鲁棒且没有相应的静态或者潜在其他问题,进行完整检查检查。

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不修改 `task_status` 的参数 schema 或 not-found 语义（`Task not found: …` 保持现状）。
- 不改变 Agent/工具描述文案去“禁止模型传 task_id”；根因在 harness 对非法 ID 的处理，不在 prompt 说教。
- 不引入模糊匹配、Levenshtein、跨 parent 扫描、按 title 猜测 session 等第二套恢复策略。
- 不强制 parent/child 归属校验（当前 resume 已可恢复任意存在的 session；本次不扩展也不收紧）。
- 不修改 Session ID 生成算法、`SessionID` brand schema 的 `startsWith("ses")` 校验规则。
- 不改 CLI/TUI 对 `<task_result>` 的用户展示剥离逻辑（notice 面向模型上下文，留在 tool output 骨架内即可）。
- 不处理空白 trim、大小写折叠、`SES_`/`Ses_` 变体等未证实可达的 wire 变形（见 Rejected Speculation）。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | 词汇：Session、Tool、Agent、subagent；task 工具创建/恢复的是 Session。 |
| `packages/opencode/AGENTS.md` | 测试与 typecheck 在 package 目录运行；Effect module 形状。 |
| `AGENTS.md` (repo root) | 默认分支 `dev`；并行工具；不随意 commit。 |
| `.opencode/policy/first-principles-engineering.md` | 修 first divergence；禁止 fallback 堆叠；forward/reverse 映射。 |
| `packages/core/src/session.ts` + `packages/opencode/src/id/id.ts` | Brand 边界：`startsWith("ses")`；生成器写 `ses_` + 26 字符 body。 |
| `packages/opencode/src/util/output-notice.ts` | 已有模型可见 `<opencode_notice … />` 格式与 attribute escape。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/task.ts` | task_id 解析、create/resume、output/backgroundOutput 骨架 | observed |
| `packages/opencode/src/tool/task_status.ts` | 对比：not-found 显式 error；参数为 SessionID brand | observed |
| `packages/opencode/src/tool/tool.ts` | 参数 decode 失败文案；task 的 task_id 为 optional string | observed |
| `packages/core/src/session.ts` | `SessionID` = `Schema.String.check(Schema.isStartsWith("ses"))` + brand；`make` 执行 brand 检查 | observed |
| `packages/opencode/src/id/id.ts` / `packages/core/src/util/identifier.ts` | body 长度 26；完整 ID `ses_` + body（总长 30） | observed |
| `packages/opencode/src/session/session.ts` | `get` → `Session not found`；`createNext` 分配 `SessionID.descending()` | observed |
| `packages/opencode/test/tool/task.test.ts` | 存在 ID resume；`ses_missing` 时新建且不用传入 ID | observed |
| `packages/opencode/src/util/output-notice.ts` | notice 序列化契约（type/source attrs + escape） | observed |
| 本地 `SessionID.make` 复现 | `make("abcdefghijklmnopqrstuvwxyz")` / `make("not-a-session")` 抛 `Expected a string starting with "ses"`；`make("ses_missing")` 成功 | observed |
| `packages/opencode/src/cli/cmd/run/tool.ts` `taskResult` | 用户侧只抽 `<task_result>` | observed |
| `packages/opencode/src/session/prompt.ts` `handleSubtask` | Path B 不传 task_id | observed |
| `packages/opencode/test/tool/__snapshots__/parameters.test.ts.snap` | wire：`task_id` 为普通 string | observed |

## 5. Current Behavior

```text
model/tool-call args.task_id (optional string)
  -> Tool.wrap Schema.decode (accepts any string — NOT SessionID brand)
  -> TaskTool.execute
       taskID = params.task_id
       if taskID:
         // SessionID.make 同步 brand 检查 startsWith("ses")
         // 非 "ses*" 字符串：make 抛错，在 yield*/catchCause 之前炸裂整次 execute
         // 已是 "ses*"：make 成功 → sessions.get → NotFound 时 catch → undefined
         session = sessions.get(SessionID.make(taskID)).catch -> undefined
       else:
         session = undefined
       nextSession = session ? reuse : sessions.create(...)
       inspected_files default = params.task_id ? "none" : "summary"
  -> output: task_id: <nextSession.id> … <task_result>…  （无 illegal notice）
```

要点（R2 纠正后的现状）：

1. **`ses*` 且 DB 不存在**（如 `ses_missing`）：get miss → **静默新建**，无 notice。
2. **非 `ses*` 字符串**（如 `not-a-session`、裸 26-body）：`SessionID.make` **同步抛 brand 错误** → 整次 task 工具失败，**不是** catch→create。
3. **不做** `ses_` 前缀补全；裸 26-body 即使对应已有 session 也会在 make 处失败（或若绕过 make 也会 miss）。
4. **truthy `task_id` 参数** 即令 `inspected_files` 默认 `"none"`，即使最终 create 或工具失败。
5. 合法且存在的完整 `ses*` ID 能 resume（测试覆盖）。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path (current) | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 省略 `task_id` | 模型或 `handleSubtask` | schema optional | create，无 notice | TaskTool | observed |
| 完整存在的 `ses…` ID | 模型复制先前 output | 无格式强制（string） | make ok → get hit → resume | TaskTool | observed |
| `ses*` 但不存在（如 `ses_missing`） | 幻觉/过期 ID | 无 | make ok → get miss → create，无 notice | TaskTool | observed |
| 恰好 26 字符 body（无 `ses` 前缀） | post-train 强制传 ID 但漏前缀 | 无 | **make 抛错 → 工具失败**；需求要求 `ses_`+body 探测 resume | TaskTool | contracted + observed |
| 其他非 `ses*` 乱串 | 同上 | 无 | **make 抛错 → 工具失败**；需求要求 create+notice | TaskTool | contracted + observed |
| 空字符串 `""` | 模型 | JS falsy | 与省略等价 | TaskTool | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 省略 `task_id` 时创建新子 Session，输出含新 `task_id:`，**无** illegal-task_id notice | create 分支；“新任务”语义 | 间接 create 测试 |
| INV-02 | 提供**存在**的完整 SessionID（`ses*` 且 get hit）时 resume，输出该 ID，**无** illegal notice | task.ts + resume 测试 | `task.test.ts` resume |
| INV-03 | 提供无法解析为已存在 Session 的非空 task_id（含：非 `ses*` 乱串、`ses*` 但不存在、26-body 补前缀后仍不存在）时：**不**因 brand 炸工具；创建**新**子 Session；output 含 opencode notice（invalid_provided） | 用户需求；R2 对 brand 边界的修正 | 部分：`ses_missing` create（无 notice、未覆盖非 ses*） |
| INV-04 | 提供长度恰好 26 且**不**以 `ses` 开头的字符串，且 `ses_`+该串为已存在 Session 时：resume 该 Session，**无** illegal notice | 用户 26+ses_ 规则；body 长度 26 | 无（red） |
| INV-05 | 26 字符 body 补 `ses_` 后仍不存在 → 同 INV-03 | 用户需求 | 无（red） |
| INV-06 | `inspected_files` 默认：真实 resume → `"none"`；真实新建（含 invalid_provided）→ `"summary"` | task 注释意图 | 无 execute 级（red） |
| INV-07 | notice 使用 `<opencode_notice … />` + attribute escape；字段足以说明非法 provided 与 created_new | output-notice 契约 | shell 旁证 |
| INV-08 | 合法 resume / omit 新建骨架兼容：`task_id:` + `<task_result>`；notice 仅 invalid_provided | CLI taskResult | 旁证 |
| INV-09 | resolve 路径上，任何候选的 brand/域失败只导致该候选未命中，**不得**使整个 `TaskTool.execute` 以 brand Error 失败 | B-01；`SessionID.make` 复现 | 无（red：非 ses* 乱串须成功 create） |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-04/09 | `TaskTool.execute` 对 raw `task_id` 无条件 `SessionID.make`；裸 26-body 在 get 之前同步 brand 失败 | `TaskTool` / `task.ts:235-238` | `SessionID.make("abcdefghijklmnopqrstuvwxyz")` 抛错；core session schema startsWith `"ses"` |
| INV-03/07（ses* miss） | make 成功后 get miss 静默 create，无 notice | 同上 | test `ses_missing`；output 无 notice |
| INV-03/09（非 ses*） | 同上 make 同步失败，工具错误而非 create+notice | 同上 | make 复现 |
| INV-06 | `inspectedFilesMode` 用 raw `params.task_id` 真值 | task.ts:312 | 源码 |

根因：**Task 工具入口的 task_id resolve 合同不完整**——把任意 string 直接 brand 成 SessionID，既拦死了用户要求的 26-body 恢复，又把“假 ID”变成工具崩溃；同时在 ses* miss 路径缺少 notice，并误用参数出现性驱动 inspected 默认。

反馈信号：

1. Red：`task_id = child.id.slice(4)`（26 body）期望 resume `child.id`；现状 brand 失败或新建。
2. Red：`task_id = "not-a-session"` 期望成功 create + notice；现状 brand 失败。
3. Red：`task_id = "ses_missing"` 期望 create + notice；现状 create 无 notice。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 模型传入 task_id 的 resolve（域检查、候选、miss→create） | `TaskTool.execute` | optional string → resume 或新建子 Session | 唯一消费该参数并决定 create/resume | Session.get 只接受已品牌化 ID |
| SessionID brand 校验 | `SessionID` schema | 仅 `startsWith("ses")` 的字符串可品牌化 | 域边界 | Task 不得假定 make 对任意 string 安全 |
| 存在性查询 | `Session.Service.get` | Info 或 NotFound | 已有 | — |
| 新建子 Session | `Session.Service.create` | 分配新 `ses_` ID | 已有 | — |
| notice 序列化 | `output-notice` 导出 | 统一 escape | 惯例 | 避免 task 手写 XML |

## 10. Single Approved Primary-Path Design

**Brand 安全规则（B-01 硬约束）**：永远不要对未通过域检查的 raw 调用 `SessionID.make`。`make` 同步抛错不得成为 resolve 控制流。

```text
function lookupSession(id: string): Effect<Session | undefined>
  // 仅当 id 已满足 SessionID 域（startsWith "ses"）时：
  //   make(id) + get；NotFound/其他 → undefined
  // 否则：立即 undefined（不调用 make）

params.task_id 缺失或 "" ->
  resolve = { mode: "create", reason: "omitted" }

params.task_id = raw (非空) ->
  candidates: string[] = []

  // 候选 1：raw 本身已是 SessionID 域成员
  if raw.startsWith("ses"):
    candidates.push(raw)

  // 候选 2：用户指定的 26-body 补全（生成器前缀字面量 ses_）
  // 仅当 raw 长度 === 26 且尚未是 ses* 域成员时构造
  if raw.length === 26 && !raw.startsWith("ses"):
    candidates.push("ses_" + raw)

  for each candidate in candidates:
    session = lookupSession(candidate)   // brand 仅发生在已是 ses* 的 candidate 上
    if session:
      resolve = { mode: "resume", session, canonicalId: session.id }
      break

  if no hit:
    resolve = { mode: "create", reason: "invalid_provided", provided: raw }

// 执行
if resolve.mode === "resume":
  nextSession = session + 既有 permission overlay
  inspected default = "none"
  run → output(task_id=canonical)  // 无 illegal notice

if resolve.mode === "create":
  nextSession = sessions.create(...)  // 系统分配新 ID，绝不使用 raw 作主键
  inspected default = "summary"
  run → output(task_id=newId)
  if reason === "invalid_provided":
    在元信息块与 <task_result> 之间插入
    <opencode_notice type="task_id" source="task" severity="warning"
      reason="invalid_provided" provided="<escaped raw>" action="created_new" />
```

说明：

1. **单一 resolve 合同**的有序域分支：omit；exact ses* hit；26-body→`ses_`+body hit；provided miss→create+notice。不是 A 失败后换算法 B。
2. **`startsWith("ses")` vs `ses_`**：brand 边界是 `ses`；生成与补全字面量是 `ses_`。`lookup` 用 brand 边界；构造用 `ses_`。
3. **为何 `!raw.startsWith("ses")` 才补前缀**：已是 `ses*` 的字符串走候选 1；对完整 ID 再套 `ses_` 无意义且错误。
4. **notice**：`formatTaskIdNotice({ provided })` 复用 `formatNotice`/escape；foreground 与 background output 同源。
5. **公共可观察面**：`output` notice + `metadata.sessionId`。可选 metadata 镜像仅当与 resolve 同值且有测试；默认可不加，避免第二语义。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| omit → create | preserve | primary-contract | yes | ~20% | preserve |
| ses* exact hit → resume | preserve | primary-contract | yes | ~20% | preserve |
| 26-body → ses_+body hit → resume | proposed | primary-contract | yes | ~20% | add |
| provided miss → create + notice | proposed | primary-contract | yes | ~25% | add |
| brand 失败当工具 Error | current（非 ses*） | defect | no | — | remove via safe lookup |
| 模糊匹配 / 扫 children | not proposed | forbidden fallback | yes | — | reject |
| task_status 同步 normalize | not proposed | out of scope | — | — | reject |

Diagnostic share：notice 附着 create，不构成第二成功算法。Alternate success budget：0。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无条件 `SessionID.make(raw)` + catchCause(get) | 假设任意 string 可 brand | brand 安全 lookup + 显式候选 | task.ts:235-238 |
| `inspected_files` 用 raw `params.task_id` | 假设有参数=resume | `resolve.mode === "resume"` | task.ts inspectedFilesMode |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 omit 无 notice | resolve omitted | task.ts | output 无 `type="task_id"` notice |
| INV-02 完整 ID resume | lookup(raw) hit | task.ts | 既有 resume + 无 notice |
| INV-03 ses* miss + notice | miss → create + notice | task.ts + output-notice | `ses_missing`：新 ID；含 notice |
| INV-03 非 ses* 乱串 + notice | 无 candidate / miss → create + notice | 同上 | `task_id: "not-a-session"`：**成功** execute；新建；notice；**无** brand Error |
| INV-04 26-body resume | candidate ses_+body | task.ts | `child.id.slice(4)` → sessionId === child.id；无 notice |
| INV-05 26-body miss | candidate miss → create+notice | task.ts | 26 乱串；新建；notice |
| INV-06 inspected 默认 | resolve.mode | task.ts | 非法新建 + 父 read → parent_context；真 resume → 无 |
| INV-07 notice 格式 | formatTaskIdNotice | output-notice.ts | provided 含 `"` 时 escape |
| INV-08 骨架 | output helpers | task.ts | omit/resume 仍有 task_id 与 task_result |
| INV-09 brand 不炸 | lookup 门闸 | task.ts | 与 INV-03 非 ses* 同测 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| brand-safe `lookupSession` / 候选 resolve | INV-02/03/04/09 | make 抛错复现；B-01 | 现逻辑对 raw 直接 make |
| `SESSION_ID_BODY_LENGTH = 26` + `ses_` 构造 | INV-04 | identifier LENGTH；用户规则 | 无候选 |
| `formatTaskIdNotice` | INV-03/07 | 用户 notice；output-notice | 无类型 |
| resolve.mode 驱动 inspected 默认 | INV-06 | task.ts:312 | raw 参数伪装 resume |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/tool/task.ts` | modify | brand-safe resolve；create/resume；inspected；output notice | +50–90 |
| `packages/opencode/src/util/output-notice.ts` | modify | `formatTaskIdNotice` | +10–20 |
| `packages/opencode/test/tool/task.test.ts` | modify | 切片 1–7 | +100–180 |

## 16. TDD Behavior Slices

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 26-char body of existing child resumes same sessionId | make(body) 抛 brand 或 create | ses_+body lookup hit | 完整 ID resume |
| 2 | `task_id: "not-a-session"` **成功** create + notice | make 抛 → execute 失败 | brand-safe miss → create+notice | — |
| 3 | `task_id: "ses_missing"` create + notice | 无 notice | create+notice | 新 ID ≠ provided |
| 4 | 26-char 不存在 body → create + notice | brand 失败或无 notice | 同 create+notice | — |
| 5 | 省略 task_id → create **无** task_id notice | 应保持 | 不插 notice | — |
| 6 | 完整合法 resume → **无** notice | 应保持 | 不插 | 既有 resume |
| 7 | 非法 task_id 新建 + 父 read → parent_context | inspected 因 raw task_id 用 none | create → summary | 真 resume 仍 none |

Seam：`TaskTool.execute` 的 `output` / `metadata.sessionId`；不断言 private helper 源码。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | ~60–100 | 排除 import/格式 |
| Required Chinese explanatory comments `C` | `max(1, ceil(E*0.15))` → **9–15** | 邻近非显然点 |

须中文解释：

1. 为何禁止对 raw 直接 `SessionID.make`（brand 同步抛错会短路整次 resolve）。
2. brand 边界 `ses` 与补全字面量 `ses_` 的分工。
3. 26-body 候选是单一合同域分支，不是二次 fallback。
4. `invalid_provided` vs `omitted` 的 notice 差异。
5. inspected_files 跟 `resolve.mode`。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/tool/task.test.ts` | `packages/opencode` | 切片 1–7 |
| `bun typecheck` | `packages/opencode` | 类型 |
| 同文件既有 resume/cancel/background 用例 | `packages/opencode` | 回归 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 0 | — |
| Files modified | 3 | task.ts、output-notice.ts、task.test.ts |
| Files deleted | 0 | — |
| Production lines | ~70–120 | resolve + notice |
| Test lines | ~120–200 | 含非 ses* 与 26-body |
| Generated lines | 0 | — |

## 20. Real Risks and Open Decisions

| Risk | Mitigation |
| --- | --- |
| 26-char 碰撞 | 仅 get hit 才 resume |
| 模型误读 notice | warning + action=created_new + 合法 task_id |
| brand 边界 `ses` 与生成 `ses_` 混淆 | 注释与 lookup 门闸写清；补全固定 `ses_` |
| 旧行为：非 ses* 曾是工具失败，现改为 create+notice | **用户明确要求**；测试锁定新合同 |

### Open Decisions Requiring the User

无。

### Rejected Speculation

- trim/大小写/`SES_`：无生产者证据。
- parent/child 强制：改变既有 resume 语义。
- task_status normalize：用户范围是 task 创建/恢复。
- 模糊匹配：forbidden。

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
- Re-verify B-01 is fully addressed in the resolve design (no raw `SessionID.make` on non-`ses*` strings).

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 | 3 non-blocking | BLOCK | task `ses_07f761842ffetmIYDDE31bAJFN` |
| 2 | R2 | yes | No blocking findings | 3 non-blocking (candidates shape; background notice; escape slice) | APPROVE | task `ses_07f6f8758ffeVacVvPvG7GfBLM` |

Independent plan audit verdict (R2, copied without paraphrase):

```text
No blocking findings.
APPROVE
```

- Audited revision: R2
- Full scope: yes
- B-01 addressed: no raw `SessionID.make` on non-`ses*` strings; brand/domain failure = candidate miss only
- Implementation allowed for exact R2 only

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/tool/task.ts` | brand-safe resolve；invalid notice；inspected 跟 resolve.mode；foreground/background output 挂 notice |
| `packages/opencode/src/util/output-notice.ts` | `formatTaskIdNotice` |
| `packages/opencode/test/tool/task.test.ts` | INV-01–09 行为切片（26-body resume、非 ses* create、ses_missing notice、omit/full resume、unknown body、inspected summary） |
| `docs/plans/task-id-illegal-resolution.md` | plan + approval + evidence（非 production） |

`git diff --stat`（implementation paths）: task.ts +56/-10 region; output-notice +13; task.test.ts +256.

### Red-Green Test Evidence

- Seam: `TaskTool.execute` → `output` / `metadata.sessionId`.
- Prior red conditions (from plan): non-`ses*` brand failure; 26-body miss-as-create; `ses_missing` silent create; inspected raw task_id.
- Green: `bun test test/tool/task.test.ts` → **30 pass, 0 fail** (packages/opencode).

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/tool/task.test.ts` | `packages/opencode` | 30 pass, 0 fail |
| `bun typecheck` | `packages/opencode` | pass (`tsgo --noEmit`) |

### Original Feedback-Loop Result

Feature/behavior contract (not a separate external repro loop): illegal/missing task_id no longer crashes on non-`ses*`; usable IDs resume (full or 26-body); unusable IDs create new session + `opencode_notice` with `invalid_provided` / `created_new`.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| omit → create | primary-contract | implemented |
| ses* exact hit → resume | primary-contract | implemented |
| 26-body → ses_+body hit → resume | primary-contract | implemented |
| provided miss → create + notice | primary-contract | implemented |
| brand-safe lookup (no make on non-ses*) | primary-contract guard | implemented |
| fuzzy match / scan children | forbidden | not added |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 273 | `git diff` 新增非空非 import 行（task.ts + output-notice.ts + task.test.ts） |
| Qualifying Chinese comment lines `C` | 41 | brand 门闸、ses vs ses_、候选域、notice 条件、inspected 跟 mode、INV 测试意图、escape、background 同源 |
| Ratio `C / E` | 0.150 | `41/273` |
| Required minimum `C` | 41 | `max(1, ceil(273 * 0.15)) = 41` |

### Remaining Unverified Items

- background 路径 notice 未单独 `background=true` 测试（与 foreground 共用 `backgroundOutput(..., notice)` 参数；plan non-blocking 已记）。
- 未跑全量 package 测试套（仅 task.test.ts + typecheck）。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | No blocking findings | 4 non-blocking (background notice test; INV-06 resume half; comment margin; notice attrs) | APPROVE | task `ses_07f6240e0ffehMK12aLj8l7bip` |

Independent implementation audit verdict (copied without paraphrase):

```text
No blocking findings.
APPROVE
```

- Audited plan revision: R2
- Full original scope: yes
- E=273, C=41, required=41, ratio≈0.150
- Clean verdict applies only to this exact implementation diff against approved R2

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
