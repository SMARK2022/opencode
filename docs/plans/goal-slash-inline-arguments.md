# Canonical Implementation Plan: Goal Slash Inline Arguments

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: user messages (2026-07-20) on GOAL slash UX inspection + multi-word objective integrity; subsequent Session GOAL contract with terminal state `verified-implementation-and-commit` requiring plan, independent audit, implementation, implementation audit, and commit.
>
> Implementation allowed: yes (verified)
>
> Last updated: 2026-07-20
>
> R2 delta: fix plan audit B-01 — goal local-control success must reuse the existing post-success submit tail (history + clear draft + delayed `route.navigate` when submit created the session). No second success path.

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 当前需要你完整检查一下我们的OpenCode里面的GOAL,也就是目标这个端点。在用户在prompt区域键入,写入,斜杠,GOAL之后,理论上来说,他如果加个空格,然后又加一大堆文本,那么这个文本应当成为GOAL的相应的内容。与此同时,应该也有一些保留字段,譬如说resume,或者说push,或者说start等等这种内容。然后这样的话,理论上来说用户就可以直接在对话框中进行,也就是在输入框中进行操作,而不用打开那个对话框。请你检查检查当前的逻辑,完整检查以及分析现在的行为模式和设计整体OpenCode对于命令兼容性的设计思想,提出完整的方案。请不要进行实施,不要进行任何代码修改。

> 与此同时请注意这个相应的实现,也需要考虑到我们的GOAL可能后面跟的参数是带有空格的长串文本。也就是比如说用户的任务里面会包含一些空格,那么这个任务里边来说,它要被当成一整体进行解析,而不是按照多个碎块进行解析。

> 继续,请你进行规范文档撰写。请注意,你可以一段一段的来写,避免一次写不下导致你的工具调用超时。你可以先写几十行,先写几十行这样来写。

> # Session GOAL … 目标终态：verified-implementation-and-commit … 提出完整的方案，审计并进行实施。

## 2. Explicit Non-Goals

- 不修改 `SessionGoal` domain 状态机、generation CAS、blocked 两轮审计、model `goal` tool contract（read/complete/blocked/active）。
- 不把 `/goal` 注册为 `Command.Service` 的 server template command（那条路径会变成 LLM prompt，而不是 session control）。
- 不实现 Web app（`packages/app`）Goal 管理 UI；当前 app 无 Goal 注册，本任务以 TUI prompt 为主 seam。
- 不新增 bare 全局别名 `/resume` / `/pause` 作为 Goal 操作（与既有 `/sessions` 的 `resume`/`continue` alias 冲突）。
- 不新增 Goal history 表、evaluator、第二模型、工作流状态机、新 HTTP resource。
- 不改变 `goal_max_turns`、continue-on-error 域语义、permission、compaction。
- 不实现用户口头提到但 domain 无定义的 `push` 动词（见 §10.2.1 R1 锁定决策）。
- Plan 文档本身不修改 production；implementation 仅在 exact revision 获 `Implementation allowed: yes` 后进行。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` Goal 词条 | Goal 是 Session 内结构化 objective（自有 SQL 表），不是普通 chat 文本。 |
| `packages/opencode/AGENTS.md` | 测试/typecheck 在 package 目录；HTTP/TUI 模式约束。 |
| `docs/plans/session-goal-transition-integrity.md` | 已锁定：用户 mutation 走 HTTP/`SessionGoal.set`；模型走 `GoalTool`；TUI 只传播用户控制。 |
| `docs/goal-error-continuation-control-plan.md` | `/goal` 当前是 dialog 管理入口；continueOnError 用户可控。 |
| OpenCode 双层 command 设计（见 §5） | Local UI slash 与 server template slash 语义不同；Goal 属于 local session control。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/goal.ts` | Domain CRUD、status、objective 整串校验、resume/pause、generation | observed |
| `packages/opencode/src/session/goal.sql.ts` | 持久化表与字段 | observed |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | `GoalSetPayload` / OpenAPI goal 端点 | contracted |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | POST goal → `set`；active 时可选 fork loop | observed |
| `packages/opencode/src/cli/cmd/tui/app.tsx` | `goal.manage` + `slashName: "goal"` 仅打开 dialog | observed |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | Dialog 创建/编辑/Pause/Resume/Clear/continueOnError → HTTP | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | submit：shell / server-command / normal prompt；**不识别 local slash 参数** | observed |
| `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` | local slash onSelect 立即 `run()`；server slash 插入 `/name ` | observed |
| `packages/opencode/src/cli/cmd/tui/context/command-palette.tsx` | slash 列表来自 keymap `slashName`，无 arguments 通道 | observed |
| `packages/opencode/src/command/index.ts` | Server Command：template + `$ARGUMENTS`/`$1`… | contracted |
| `packages/opencode/src/session/prompt.ts` `SessionPrompt.command` | 参数展开后变成 prompt，不是 Goal mutation | observed |
| `packages/opencode/src/tool/goal.ts` + `goal.txt` | 模型侧 operate；不可 pause/resume/clear/改 objective | contracted |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/goal.tsx` | sidebar 展示 | observed |
| `packages/app/src/components/prompt-input.tsx` + `submit.ts` | Web 同样只把 server command 当 slash 提交；无 Goal UI | observed |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | TUI submit 运输层测试 harness 可复用 | observed |
| `packages/opencode/test/session/goal.test.ts` / `httpapi-goal.test.ts` | Domain/HTTP 已覆盖；本任务不应重写 domain | observed |

## 5. Current Behavior

### 5.1 OpenCode 命令兼容性的设计思想（双层模型）

OpenCode 实际运行着**两套** slash 体系，职责刻意分离：

```text
A. Local UI slash（keymap / command palette）
   入口: appCommands / plugin keymap 的 slashName
   选择: autocomplete 立即 dispatchCommand(name)
   提交: 不参与 prompt submit 解析
   语义: UI 动作（开 dialog、切 session、exit…）
   参数: 无

B. Server template slash（Command.Service）
   入口: command.list → sync.data.command
   选择: autocomplete 插入 "/name " 供用户继续填参
   提交: prompt submit → session.command({ command, arguments })
   语义: 展开 template（$ARGUMENTS / $1…）→ 作为 user prompt / subtask 进入 loop
   参数: 字符串 arguments（首行 split 后 join，可跨行）
```

这是兼容性设计的核心：

1. **Local slash 不进 LLM**——避免把 UI 控制误送成聊天。
2. **Server slash 专做 prompt 模板**——配置命令、MCP prompt、skill 共用同一参数展开。
3. **Submit 判别只查 server 列表**（`sync.data.command`）；local slash 名若不在列表中，会被当成**普通聊天文本**发出。
4. **Goal 目前挂在 A 层**：`/goal` 只是 `goal.manage` 的 UI 入口，没有 arguments 契约。

### 5.2 Goal 端到端现状

```text
用户 /goal
  -> autocomplete 选中
  -> keymap.dispatchCommand("goal.manage")
  -> 无 goal: DialogGoal (DialogPrompt 输入 objective)
  -> 有 goal: DialogGoalMenu (Edit / Continue after errors / Pause|Resume / Clear)
  -> useGoalApi → POST|DELETE /session/:id/goal
  -> SessionGoal.set|clear → Bus session.goal.updated|cleared
  -> TUI sync store + sidebar/footer 展示

用户 typed "/goal 修登录 bug 并补测试" + Enter
  -> autocomplete 因空格后第二段文本而 hide
  -> submit 检查 sync.data.command 无 "goal"
  -> 走 session.promptAsync，把整串 "/goal 修登录 bug 并补测试" 发给模型
  -> Goal 表不变更
```

Domain/HTTP 已支持用户需要的 mutation：

| 用户意图 | 已有能力 |
| --- | --- |
| 设置/改写 objective | `POST { objective }`（整串 trim；空/超长拒绝） |
| resume | `POST { status: "active" }`（可 fork loop） |
| pause | `POST { status: "paused" }` |
| clear | `DELETE` |
| continue-on-error | `POST { continueOnError }` |
| 模型 complete/blocked | GoalTool（与 slash 无关） |

缺口不在 domain，在 **TUI prompt 对 local `/goal` 参数路径缺失**。

### 5.3 关键路径摘要

```text
producer: 用户 prompt 输入框
  -> seam: Prompt.submitInner
  -> 今日分支: shell | server-command | normal prompt
  -> 缺失分支: local control slash（goal）
  -> adapter: (应) goal HTTP client → SessionGoal
  -> observable: session.goal.updated + 草稿清空 + toast/错误保留草稿
```

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| `/goal` 无参数 | TUI prompt / autocomplete / palette | session 路由 | `goal.manage` → dialog | TUI keymap | observed |
| `/goal` + 空格 + 多词 objective（含空格） | TUI prompt Enter | 用户整段文本 | **当前误走 normal prompt** | Prompt.submit | observed gap |
| `/goal resume` / `pause` / `clear` 等保留动词 | TUI prompt Enter | 用户控制意图 | **当前误走 normal prompt** | Prompt.submit | observed gap |
| objective 长度 ≤ 6400 | SessionGoal.set | MAX_OBJECTIVE_CHARS | domain 拒绝 | SessionGoal | contracted |
| 空 objective | SessionGoal / dialog | trim 后空 | 拒绝创建 | SessionGoal + dialog | observed |
| 已有 goal 时改 objective | SessionGoal.set | generation 递增规则 | HTTP POST | SessionGoal | contracted |
| terminal goal 只改 objective | SessionGoal.set | 自动回 active（无显式 status 时） | HTTP POST | SessionGoal | contracted |
| Web app `/goal …` | app prompt-input | 无 Goal 命令 | 当作聊天或无匹配 | app | observed non-goal |
| server `/init foo bar` | Command.Service | arguments 整串/占位 | session.command | SessionPrompt.command | observed（对照） |
| bare `/resume` | sessions slash alias | 打开 session list | **不是 Goal resume** | app.tsx sessions | observed 冲突 |
| home / `props.sessionID == null` 时提交 `/goal …` | TUI home prompt | submit 先 `session.create` 再发送 | **必须**与 shell/command/prompt 共享成功尾：history + 清草稿 + delayed navigate 到新 session | Prompt.submitInner | observed（现有 submit 尾）+ R2 合同 |

### 6.1 空格与“一体解析”约束（硬需求）

用户明确要求：`/goal` 后面的**任务文本**可以很长且含空格，必须作为**一个整体**成为 Goal objective，不得按词切成多个碎片参数。

因此本方案的解析模型是：

```text
line = "/goal" SP* rest?
rest = reserved-verb-line | free-objective

free-objective = 从首个非空白开始到输入结束的全部字符（含空格、换行、标点）
                —— 只做 trim 边界空白，不做 token split 语义
```

对照反例（**禁止**）：

```text
# 错误：把 "fix the login bug" 拆成 $1=fix $2=the $3=login …
/goal fix the login bug
```

正确语义：

```text
objective = "fix the login bug"   // 一整串
```

多行同样一体：

```text
/goal 修登录
并补集成测试
```

`objective = "修登录\n并补集成测试"`（首行 `/goal` 之后的其余 + 后续行，与 server command 的 multi-line arguments 拼接方式对齐，但**不**按词 token 化）。

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | `/goal` + 非保留 rest 时，rest 整串（保留内部空格）成为 `objective`，不得词级 split | 用户要求；SessionGoal 以单 string 存 objective | 无 TUI 测试；domain 有 objective string |
| INV-02 | 有保留动词时，动词后的载荷仍按该动词契约一体处理（见 §10）；不得把动词后文本当多个位置参数 | 用户要求 reserved fields | 无 |
| INV-03 | 仅 `/goal` 无 rest 时保持现有 dialog UX（不向模型发聊天） | app.tsx + dialog-goal | 无自动化，行为可观察 |
| INV-04 | `/goal …` 成功 mutation 后草稿清空且**不**调用 `session.promptAsync` | submit 分支设计 | prompt-submit-transport 可扩 |
| INV-05 | `/goal …` 失败时保留草稿 + 用户可见错误（toast/HTTP message） | dialog-goal 已有错误模式 | dialog 无测；transport 测可仿 |
| INV-06 | Goal mutation 仍只经现有 HTTP/`SessionGoal.set|clear`，不新增第二写路径 | session-goal-transition-integrity | httpapi-goal / goal.test |
| INV-07 | 不把 `/goal` 注册进 `Command.Service` 以免变成 LLM template | command/index 职责 | 无 |
| INV-08 | bare `/resume` 继续表示 sessions alias，不改为 Goal resume | app.tsx slashAliases | 无 |
| INV-09 | 模型 `goal` tool 权限边界不变：模型不可 pause/clear/改 objective | tool/goal.txt | tool/goal.test |
| INV-10 | free-objective 与保留动词的判定必须确定性，避免“首词碰巧是 resume 但本意是任务”的 silent 误解析 | 产品安全 | 见 §10 语法 |
| INV-11 | 当本次 submit 创建了新 session（进入 submit 时 `props.sessionID` 为空）时，goal local-control **成功**路径必须执行与 shell / server-command / normal-prompt 相同的 post-success completion：`history.append`、清空草稿、delayed `route.navigate({ type: "session", sessionID })`；失败路径不得清草稿、不得 navigate | `prompt/index.tsx` 现有成功尾 1432–1454；create session 1241+ | R2 运输层测试必覆盖 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/04 | `Prompt.submitInner` 只识别 `sync.data.command`，不识别 local `goal` | `component/prompt/index.tsx` submit 分支 | 源码：`inputText.startsWith("/")` 后 `sync.data.command.some(...)` |
| INV-01（autocomplete） | local slash `onSelect` 立即 `run()`，从不把 rest 留给用户再提交 | `command-palette` → autocomplete | `onSelect: () => run(entry.command.name)` |
| INV-03 | 无参数路径仍正确；参数路径从未建立 | `app.tsx` `goal.manage` | 仅 dialog，无 args |
| domain | 无 divergence | `SessionGoal` | POST objective 已是整串 |

**Root cause（feature seam，非 domain bug）**：

Goal 的用户控制写接口已在 HTTP/domain 完成，但 TUI 把 `/goal` 只接到 **零参数 local UI action**。用户期望的 **“slash + 一体 arguments”** 是 server template 路径的交互形态，却从未挂到 Goal 控制面。第一分叉点是 **Prompt 提交路由**，不是 `SessionGoal.set`。

反馈信号（feature，非现有红测）：

- 红-capable 行为：在 TUI submit harness 中提交 `"/goal fix the login bug"`，断言 `POST /session/.../goal` body.objective 等于整串，且不调用 `prompt_async`。
- 今日失败原因：走 `prompt_async` 或根本无 goal POST。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 解析 `/goal` 行与一体 rest | 新 pure helper `parseGoalSlashInput`（TUI 侧） | string → GoalSlashIntent | 无 I/O；可单测 | SessionGoal 不该懂 slash 语法 |
| submit 路由插入 local control | `Prompt.submitInner` | 在 server-command 之前识别 goal slash | 唯一用户 Enter 边界 | Command.Service 是 prompt 模板 |
| 执行 intent → HTTP | 抽出/复用 `useGoalApi` 同级 client helper | POST/DELETE + toast + optional reconcile | dialog 已有同一 adapter | 不把 fetch 放进 parser |
| 零参数 UX | 现有 `goal.manage` / dialog | 打开 Set/Manage | 保留 discoverability | parser 无参数时委托 |
| domain 校验 | `SessionGoal.set` | 空/长度/status/reason | 权威校验 | TUI 只做 UX 预检（长度） |
| 模型 goal 写 | `GoalTool` | read-before-write | 与用户 slash 正交 | 禁止合并 |
| server template slash | `Command` + `SessionPrompt.command` | LLM prompt | 不承载 Goal mutation | 禁止注册 goal 模板 |

## 10. Single Approved Primary-Path Design

### 10.1 一句话方向

在 **TUI Prompt 提交主路径**增加 **local control slash** 分支：识别 `/goal`，用**非词碎片**语法解析 rest，映射到既有 Goal HTTP mutation；零参数仍打开 dialog。不新增 domain 写路径，不接入 `Command.Service`。

### 10.2 权威语法（R1 推荐）

命令名大小写：与现有 slash 一致，按 **首 token 名不区分大小写匹配 `goal`**（若现网 slash 列表为小写 `goal`，提交时 normalize 为小写比较）。

```text
input trimmed for leading/trailing outer whitespace only at whole-input level
must start with "/"

cmd, rest = splitOnceOnFirstAsciiWhitespaceRun(input[1:])
  // 仅在第一个空白 run 处切一刀：
  //   left  = 命令名 token（无空格）
  //   right = 从该空白 run 之后到全文结束的全部字符（含内部空格/换行）——一体 rest
  // 禁止：对 right 再 split 成 argv[] 当作多个位置参数

if cmd.lower() != "goal":
  not this branch

if rest is empty or rest is only whitespace:
  intent = { type: "dialog" }   // 现有 Manage/Set dialog
else:
  verb, payload = matchReservedVerb(rest)
  if verb found:
    intent = verb intent + payload
  else:
    intent = { type: "set-objective", objective: rest.trim() }  // 整串一体
```

#### 保留动词表（R1）

动词匹配：**仅当 rest 的第一个空白分隔 token（case-insensitive）等于保留字，且满足该动词的 arity 规则**时才消费为动词；否则整个 rest 视为 free-objective。

| Verb | Match form | Payload rule | Maps to |
| --- | --- | --- | --- |
| `resume` | rest 整段（trim 后）等于 `resume` | 无 payload | `POST { status: "active" }` |
| `pause` | 整段 = `pause` | 无 | `POST { status: "paused" }` |
| `clear` | rest 整段（trim 后，case-insensitive）等于 `clear` 或 `delete` 或 `remove` | 无 | `DELETE` |
| `start` | 首 token = `start`，其后 **一体 payload** 非空 | payload = rest 去掉首 token 与紧随空白后的全部 | `POST { objective: payload, status: "active" }`（显式 active） |
| `set` | 首 token = `set`，其后一体 payload 非空 | 同上 | `POST { objective: payload }` |
| `edit` | 同 `set` | 同 `set` | 同 `set`（别名，降低 discoverability 摩擦） |
| `continue` | rest 整段（trim 后，case-insensitive）**精确**等于下列之一：`continue on` / `continue off` / `continue true` / `continue false`；多出的 trailing tokens **不**匹配 → 整 rest 作 free-objective | 布尔映射：on/true→true，off/false→false | `POST { continueOnError: bool }` |

**禁止**把 `resume` 当“首词动词 + 剩余 objective”：

```text
/goal resume fixing flaky tests
```

按 INV-10，若采用“仅整段等于 resume 才是动词”，则上式 **objective 整串**为 `"resume fixing flaky tests"`，而不是误 pause 逻辑。  
若用户要 resume：**必须**精确 `/goal resume`。

`start`/`set`/`edit` 用于：任务文本**故意**以保留词开头时的消歧：

```text
/goal set resume the migration carefully
→ objective = "resume the migration carefully"
```

#### 10.2.1 R1 产品决策锁定（仓库证据，非猜测）

以下在 R1 内视为**已决**，不再作为实施阻塞 open decision：

| 决策 | R1 锁定 | 证据 |
| --- | --- | --- |
| `push` | **不实现** | domain/HTTP/dialog 无 push；用户仅举例，无精确定义 |
| 裸 `/goal <text>` | **set-objective only**（`POST { objective }`）；status 完全遵循现有 `SessionGoal.set` | dialog 确认路径同样只传 objective；新建默认 active；terminal 仅改 objective 回 active；paused 改 objective 保持 paused（goal.ts） |
| `start` | 显式 `POST { objective, status: "active" }` | 用户举例 reserved；与裸 set 消歧 |
| `continue on\|off` | **R1 实现**（映射 dialog 已有 toggle） | dialog-goal 已暴露 continueOnError；同一 HTTP 字段 |
| Web app | **非目标** | app 无 Goal 注册 |
| autocomplete `/goal` | **选中插入 `/goal `**，不立即 run；命令面板 `goal.manage` 仍直接 dialog | 对齐 server slash 参数输入；支持长 objective 再 Enter |

未知 `push` 语义若用户后续定义，开新 revision，不在 R1 猜测。

#### 关于 `start` vs 裸 objective

| 输入 | 语义 |
| --- | --- |
| `/goal 修登录 bug` | set-objective 整串；`POST { objective }` only |
| `/goal start 修登录 bug` | `POST { objective, status: "active" }` |
| `/goal set 修登录 bug` | 同裸 set-objective |

### 10.3 Submit 主路径（修复第一分叉）

```text
submitInner:
  // 既有：若 props.sessionID 为空则 session.create，得到 sessionID（局部变量）
  // 既有：agent/model gate 等前置检查不变

  if shell mode → session.shell  // fire-and-forget，然后 fall-through 到共享成功尾
  else if parseGoalSlash(input) is Some(intent):
       result = await executeGoalSlash(intent, sessionID)  // HTTP / dialog
       if result.failed:
         // 保留草稿；toast；不 history；不 navigate；return false
         return false
       // 成功：禁止第二套清草稿逻辑。fall-through 到与 shell/command/prompt
       // 相同的共享成功尾（见下）。不得在此 early-return 跳过 navigate。
  else if server command match → session.command(arguments 整串)
  else → session.promptAsync  // 失败则 keepDraft 并 return false

  // === 共享 post-success completion（shell / goal / command / prompt 成功后唯一尾）===
  history.append(...)
  clear draft / extmarks
  props.onSubmit?.()
  if !props.sessionID:   // 本次 submit 创建了 session
    delayed route.navigate({ type: "session", sessionID })
  input.clear()
  return true
```

**R2 合同（审计 B-01）**：goal 分支**成功**不得 `return` 在共享尾之前。失败才 early-return。dialog intent（零参数打开 Manage/Set）算成功控制面完成：打开 dialog 后同样走共享尾（清输入并在 home 时 navigate），避免 goal 写到未聚焦 session 而路由停在 home。

`executeGoalSlash`：

- `dialog` → 复用 `goal.manage`（`dialog.replace` DialogGoal / DialogGoalMenu），使用**本次 submit 解析得到的** `sessionID`（含刚 create 的）
- 其它 → 与 `dialog-goal.tsx` 相同 HTTP（抽出共享 `goalClient` 避免双份 fetch）
- 成功后可选 `sync.goal.reconcile`；SSE 仍为其它客户端真相源
- 不负责 history/clear/navigate——那是 submit 共享尾的责任

### 10.4 Autocomplete 兼容

今日 local `/goal` 选中立即开 dialog。为支持“选命令再打长 objective”：

- `/goal` 在 autocomplete 的 onSelect 改为与 server command 类似：插入 `"/goal "` 并聚焦输入（**不**立即 run），**或**
- 保留立即 dialog，但文档/帮助说明：参数化用法需手打后 Enter。

R1 **推荐**：参数化优先——选中插入 `"/goal "`；用户直接再 Enter（仅 `/goal `）仍走 dialog。这样与“空格后长大串文本”一致。

零参数 palette 命令 `goal.manage` 快捷键/命令面板仍可直接开 dialog（不经 prompt 文本）。

### 10.5 为什么这是 primary path 而非 fallback

- 修复的是 submit 路由缺失，不是在 prompt 失败后再猜 Goal。
- Domain 仍是唯一写权威。
- 解析器 pure + 单一 intent 代数；执行器只做映射。
- 不引入 “先当聊天再纠正” 的 B/B1 路径。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Dialog Set/Manage Goal | current + proposed | primary-contract branch（零参数 discoverability） | yes | low | preserve |
| Prompt `/goal` + 一体 rest → HTTP | proposed | primary path（参数化主路径） | yes | high | add |
| Server `Command` 注册名 `goal` | hypothetical | forbidden fallback | would mis-route to LLM | — | reject |
| 词级 argv 解析 objective | hypothetical | forbidden | wrong semantics | — | reject |
| bare `/resume` → Goal resume | hypothetical | forbidden（alias 冲突） | would break sessions | — | reject |
| Web app Goal slash | future | out of scope | — | — | non-goal R1 |
| GoalTool model path | current | orthogonal | yes | model only | preserve |
| 失败后把原文当 prompt 发出 | hypothetical | forbidden fallback | yes but wrong | — | reject：失败保留草稿 |

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 用户只能开 dialog 粘贴长 objective | local slash 无 args | prompt 内联一体 objective | 保留 dialog 作为零参数路径，不删除 |
| 用户把 `/goal …` 当聊天让模型“理解” | submit 误路由 | submit 识别后直写 Goal | 无代码可删；消除误路由即可 |
| dialog-goal 内联 `sdk.fetch` 与未来 submit 可能双份 | 历史 TUI 封装 | 抽出共享 goal HTTP helper | `dialog-goal.tsx` 改为调用 helper |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| 空格后长文本 = 一体 objective（INV-01） | parse → set-objective → POST | `parse-goal-slash.ts` + submit | unit：多词/多行/中英混排；TUI：POST body 全串 |
| 保留 resume/pause/clear/start/set（INV-02） | parse verb → HTTP | same | unit 表驱动；TUI pause/resume |
| 无参 dialog（INV-03） | intent dialog → goal.manage | submit + 可选 autocomplete | 行为：仅 `/goal` 开 dialog、无 prompt_async |
| 成功不聊天（INV-04） | goal 成功后 fall-through 共享尾，不 promptAsync | `prompt/index.tsx` | transport test：无 prompt_async |
| 失败保留草稿（INV-05） | execute 失败 early-return，不进共享尾 | goal client + submit | transport：400 后 input 仍在 |
| home 创建 session 后 navigate（INV-11） | 共享 post-success 尾 | `prompt/index.tsx` | transport：`promptSessionID` 空 + `/goal a b c` 断言 goal POST **且** route 进入新 session |
| 唯一写路径（INV-06） | 仅 HTTP SessionGoal | helper 复用 dialog | 无第二 domain API |
| 不进 Command.Service（INV-07） | 不注册 | — | 代码审查 / 无 command list 项 |
| bare resume 不变（INV-08） | 不改 sessions alias | — | 回归 sessions slash |
| 模型边界（INV-09） | 不改 tool | — | 现有 tool tests |
| 消歧 set/start（INV-10） | 动词 arity | parser | unit：`/goal resume x` 为 objective |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| `parseGoalSlashInput` pure parser | INV-01/02/10 | submit 无 local 解析 | dialog 无文本语法；Command hints 是 $N 不是 Goal |
| submit local-control 分支 | INV-04 | 第一分叉在 submit | server-command 列表不含 goal |
| shared goal HTTP helper | INV-05/06 | dialog 与 submit 双调用方 | 避免复制 fetch/directory query |
| autocomplete 插入 `/goal ` | INV-01 UX | 现 onSelect 立即 run | 立即 run 阻止参数输入 |
| 保留动词表 | 用户 reserved fields | dialog 已有 pause/resume/clear | 需文本入口 |
| 明确不实现 push | non-goal / open | domain 无 push | 防猜测 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/parse-goal-slash.ts`（路径可微调，保持 TUI util） | add | pure：input → GoalSlashIntent；文档化一体 rest | +80–140 |
| `packages/opencode/src/cli/cmd/tui/util/goal-http.ts` 或 `component/goal-api.ts` | add | 从 dialog 抽出 POST/DELETE + directory query + 错误 message 提取 | +60–100 |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | modify | 改用 shared helper；行为不变 | ±20–40 |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | modify | submit 插入 goal 分支；成功清草稿 | +40–80 |
| `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` 或 command-palette slash onSelect | modify | `/goal` 选中插入 `/goal `（若采用 §10.4 推荐） | +10–30 |
| `packages/opencode/src/cli/cmd/tui/app.tsx` | modify（可选） | title/description 文案提示 “/goal \<objective\>” | +5–15 |
| `packages/opencode/test/cli/cmd/tui/parse-goal-slash.test.ts` | add | 表驱动 parser | +120–200 |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` 或新 goal-slash-submit test | modify/add | POST body 一体字符串；无 prompt_async | +80–160 |
| Domain/HTTP/tool 文件 | none | — | 0 |

## 16. TDD Behavior Slices

Public seam：**pure parser** + **TUI submit 运输层**（不测 dialog 像素）。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `parse("/goal fix the login bug")` → set-objective `"fix the login bug"` | 无 parser | 实现 splitOnce + free-objective | 空格一体 |
| 2 | 多行 rest 保持换行 | 无 | 首刀后全文 | 多行任务 |
| 3 | `/goal resume` → resume；`/goal resume the work` → objective 含 resume… | 无 | 整段等于才是 verb | INV-10 |
| 4 | `/goal set resume the work` → objective `"resume the work"` | 无 | start/set 消费首 token | 消歧 |
| 5 | `/goal` / `/goal   ` → dialog | 无 | empty rest | 零参数 |
| 6 | TUI submit `/goal a b c` → fetch POST objective `"a b c"`，无 prompt_async | submit 无分支 | 接入 parser+http | INV-04 |
| 7 | POST 400 → 草稿保留 | 无 | 对齐 transport 失败语义 | INV-05 |
| 8 | `/goal pause` 有 goal 时 POST status paused | 无 | verb map | 保留字段 |
| 9 | home 提交 `/goal a b c`：POST objective=`a b c` 且 navigate 到新 session | R1 方案 early-return 会跳过 navigate | 成功 fall-through 共享尾 | INV-11 / B-01 |
| 10 | autocomplete 选中 `/goal` 插入 `"/goal "` 而非立即 dispatch | 现 onSelect 立即 run | palette/autocomplete 特判 goal | §10.2.1 锁定 |

测试独立期望值：字面量 objective 字符串，不复述 parser 实现。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 180–280 | 排除纯 import/格式化；含 parser+submit+helper |
| Required Chinese explanatory comments `C` | ≥ max(1, ceil(0.15E)) ≈ 27–42 | 硬门禁 |

必须用中文说明的非显而易见点（计划内清单，实施时落在邻近代码）：

1. **为何只在第一个空白 run 切一刀**——保证 objective 含空格仍一体（INV-01）。
2. **为何 resume/pause/clear 要求 rest 整段等于动词**——避免任务以保留词开头被误伤（INV-10）。
3. **为何 set/start 需要显式动词**——消歧；start 与 set 对 status 的差异。
4. **为何 submit 中 goal 分支优先于 server-command**——防止未来若有人注册同名 command 时的语义冲突（若仍无同名则注释记录顺序意图）。
5. **为何不把 goal 放进 Command.Service**——避免变成 LLM prompt。
6. **失败保留草稿、成功不 promptAsync**——控制面与聊天面边界。
7. **与 dialog helper 共用 HTTP**——单一用户写适配器。

禁止复述赋值/控制流的空话注释。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/parse-goal-slash.test.ts` | `packages/opencode` | parser 一体 rest / 动词表 |
| `bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx`（或新增 goal submit 文件） | `packages/opencode` | 运输层 POST / 失败保留 |
| `bun test test/session/goal.test.ts test/server/httpapi-goal.test.ts` | `packages/opencode` | domain/HTTP 无回归（本任务不应改红） |
| `bun typecheck` | `packages/opencode` | 类型 |

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2–3 | parser + helper + tests |
| Files modified | 3–5 | prompt submit、dialog、autocomplete、可选 app.tsx |
| Files deleted | 0 | — |
| Production lines | +150–280 / −20–40 | 抽出重复 + 新分支 |
| Test lines | +200–360 | 表驱动 + transport |
| Generated lines | 0 | 不改 OpenAPI/SDK 生成 |

## 20. Real Risks and Open Decisions

### Real risks（有证据）

1. **保留词与自然语言冲突**：任务以 `resume`/`pause` 开头时，必须用 `/goal set …`；需在 `/goal` help/dialog 文案提示。
2. **sessions 的 `resume` alias**：用户可能以为 `/resume` 恢复 Goal——文档/错误提示可引导 `/goal resume`（不改 alias）。
3. **autocomplete 行为变更**：从立即 dialog 改为插入 `/goal ` 可能让习惯“点一下就开菜单”的用户多按一次 Enter；palette 快捷仍可直达 dialog。
4. **与未来同名 server command**：submit 顺序必须固定；禁止静默双解释。

### Open Decisions Requiring the User

Not applicable for R1 implementation gate：§10.2.1 已用仓库证据锁定全部原 open items。  
若用户日后定义 `push` 或要求 Web 同步，开新 revision。

### Rejected Speculation

- 在 daemon 增加 `/goal` RPC 平行于 HTTP：无必要，HTTP 已是用户写边界。
- 用 LLM 解析 slash 意图：与确定性控制面相反。
- 把 objective 再按引号/逗号切多目标：用户要求单 goal 整串；session 仅一个 current goal。

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
- Especially verify: multi-word objective is never argv-split; Goal is not registered as server template command; bare `/resume` sessions alias undisturbed.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 Null-session success path omits required session navigation | Appendix A drift; clear aliases wording; autocomplete missing red slice; continue arity; model gate inherited | BLOCK | task ses_0810c192effeMBzIm4RYGt7hEW |
| 2 | R2 | yes | none | N-01 Appendix A header R1 label; N-02 do not dispatch goal.manage with route guard on home — use submit sessionID + dialog.replace; N-03 continue/clear alias cases in parser table | APPROVE — No blocking findings | task ses_081059d11ffeRFXwtGCKr0tQbh |

Any substantive revision invalidates earlier approval.

## 23. Implementation Evidence

### Actual Files and Diff

| File | Change |
| --- | --- |
| `packages/opencode/src/cli/cmd/tui/util/parse-goal-slash.ts` | add — pure parser |
| `packages/opencode/src/cli/cmd/tui/util/goal-http.ts` | add — HTTP helper + executeGoalSlashIntent |
| `packages/opencode/src/cli/cmd/tui/component/dialog-goal.tsx` | modify — use helper; export openGoalDialog |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | modify — submit local goal branch; destroyed-buffer guard |
| `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` | modify — `/goal` insert text |
| `packages/opencode/src/cli/cmd/tui/app.tsx` | comment only |
| `packages/opencode/test/cli/cmd/tui/parse-goal-slash.test.ts` | add |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | add 3 goal transport tests |
| `docs/plans/goal-slash-inline-arguments.md` | plan |

### Red-Green Test Evidence

1. Parser table: multi-word objective, exact verbs, set/start disambiguation, continue exact forms — green.
2. Transport: POST whole objective, no prompt_async; 400 keeps draft; home create+POST+navigate — green.

### Verification Commands and Results

| Command | Cwd | Result |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/parse-goal-slash.test.ts test/cli/cmd/tui/prompt-submit-transport.test.tsx` | packages/opencode | 21 pass, 0 fail |
| `bun typecheck` | packages/opencode | pass |

### Original Feedback-Loop Result

Feature: missing capability reproduced as red parser/transport expectations before green; post-fix green confirms `/goal fix the login bug` → POST objective whole string.

### Actual Secondary and Replacement Path Inventory

| Path | Classification | Disposition |
| --- | --- | --- |
| dialog zero-arg | primary-contract branch | preserved |
| parameterized HTTP | primary path | added |
| server Command.Service goal | forbidden | not added |
| fail-as-chat | forbidden | not added |
| destroyed-buffer guard on clear | safety for async success tail | added (existing async paths share tail) |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | ~410 | production+test 实质性增改；排除 import-only 与 dialog HTTP pure-move |
| Qualifying Chinese comment lines `C` | ~70+ | parser/HTTP/submit/autocomplete 不变量 + transport/parser 测试意图与规格说明 |
| Ratio `C / E` | >= 0.15 | 补强后满足 hard gate |

Required `C >= ceil(0.15*410)=62`；在 transport/parser 测试与执行映射处补强后达标。

### Remaining Unverified Items

- Manual TUI visual for dialog after zero-arg `/goal` Enter not automated beyond open path.
- Autocomplete insert not unit-tested (slice 10 planned; partial via code path only).

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 | yes | B-01 Chinese comment gate (E≈413 C≈37 need 62) | N-01 LF separator; N-02 verb transport; N-03 autocomplete test; N-04 dirty worktree; N-05 double parse | BLOCK | task ses_080f433e7ffe1grY60dTR1GXA5 |
| 2 | R2 | yes | none — No blocking findings | N-01 autocomplete untested; N-02 verb transport thin; N-03 double parse; N-04 dirty worktree out of scope; N-05 auditor did not re-run shell | APPROVE | task ses_080e9e796ffewjqzWS6Ll3HCqt |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.

---

## Appendix A — 当前 vs 目标行为对照

| 用户输入 | 今日 | R1 目标 |
| --- | --- | --- |
| `/goal`（选中 autocomplete） | 立即 dialog | 插入 `/goal `；命令面板 `goal.manage` 仍直接 dialog |

| `/goal` + Enter | 若未匹配 server：当聊天发出 | dialog |
| `/goal 修 登录 bug` | 当聊天发出 | POST objective=`修 登录 bug` |
| `/goal resume` | 当聊天发出 | POST status=active |
| `/goal pause` | 当聊天发出 | POST status=paused |
| `/goal clear` | 当聊天发出 | DELETE |
| `/goal set resume later` | 当聊天发出 | POST objective=`resume later` |
| `/resume` | session list | 不变（session list） |

## Appendix B — 与 server command 参数哲学的对齐

Server command：

- 首行：`/name` + 剩余首行 args
- 可拼接后续行进 `arguments` 字符串
- template 用 `$ARGUMENTS` 吃**整串**，或 `$1`… 再切词

Goal slash **只借用“整串 arguments”哲学**，**不**借用 `$1` 词切：

- Goal 的 payload 是单个 domain 字段 `objective: string`
- 词切会破坏自然语言任务描述

故 parser 明确：**最多一次切分（命令名 | rest）**；动词层最多再切 **一个** 前导 verb token，其后再次全部一体。
