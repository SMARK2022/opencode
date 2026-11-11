# Canonical Implementation Plan: Session Title Upstream Parity

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 当前会话中关于复刻 upstream 2.2.5 标题上下文与 Prompt 的逐字要求，见第 1 节
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-12

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

用户明确要求：

> 没有问题，就按照 upstream 2.2.5的逻辑进行完整的一个检查以及复刻。按理来说，这套逻辑应该很容易被复用的，或者说复刻，那部分的 prompt，巴拉巴拉，你都可以直接复刻。然后你构建一个新的一个 plan，按照我们的这个 workflow 里面的 guide，里面的这个，就是 document，里面的 guide，里面的 workflow.md，去进行。然后保持相应修改内容最小。然后你先构建的是一个 Verify Plan。

形成该需求的问题背景逐字保留：

> 但是有一个问题啊，你当前只……我不希望它变成只有这个 active window。所以而且我经常发现一个问题，我不知道你当前这个 generate 的一个 prompt 是什么。它当前 generate prompt 的时候，它要生成的是标题，它不是要生成下一段干什么。所以当前有的时候我经常发现，比如说我弄了一个 generate，generate 之后它给我输出什么我下一步怎么怎么做，blablabla的。用户就没有……用户想要的是一个总结性的、概述性的一个标题，而不是说让模型怎么做这种话去表述在里面。你看看到底什么情况。当前的逻辑和这个具体生成，就是当前的这个 title 的 generate 的一个逻辑和我们之前默认自动的一个 generate 逻辑不一样吗？还是说怎么样？然后它有做这个 token，或者说这个消息的隔离吗？就是说让这个东西知道这个东西是需要被生成标题的一个文摘，而不是说一个任务吗？你同时也可以看一下 upstream 的 2.2.5 是以什么样的 prompt 去做的。

本任务当前终态为 **verified-implementation-and-commit**。用户随后明确要求：

> 没有关系，你不需要去把什么 title.txt 的东西去说错的和上游不一样。我的意思是，你如果要以上游为模板，为蓝板，那你就按照上游去进行复刻，或者说进行撰写即可。然后你现在进入 Workflow 的 Verify Implementation and Commit 阶段，你需要先去读取相应的 Workflow。Workflow 在 Document 里面的 Guide 里面的 Workflow.md。那文件修改的上限呢，生产代码修改行数不得超过600行，同时测试代码修改行数不得超过800行。

实施硬上限：生产代码修改少于或等于 600 行，测试代码修改少于或等于 800 行；现有 R5 估算均低于这两个上限。

## 2. Explicit Non-Goals

- 不修改 TUI、HTTP endpoint、legacy SDK、Protocol ClientApi 或生成文件；现有 `Generate` 入口继续只传 `sessionID`。
- 不搬移 upstream 的 Provider/primary-model 重试 fallback、usage accounting、事件序号 CAS 或持久化协议；这些不属于本次标题材料与 Prompt 缺陷，且当前已有明确模型和持久化合同。
- 不新增标题输出语义分类器、任务回复检测器、第二套标题 Agent、额外重试或“失败后换种 Prompt 再生成”的 alternate success path。
- 不把完整压缩前 transcript 全部注入标题请求。upstream 2.2.5 的结构是全历史第一条请求加上 latest window 的近期文本，本任务精确保持这一边界。
- 不引入新的依赖、数据库迁移、配置开关、public HTTP API、junction 或符号链接。
- 不把 upstream 的字符预算描述成精确 Provider token 计数；`2000` 与 `8000` 都是字符上限。
- 不复制 upstream 的 `Effect.orElseSucceed(() => messagePrompt(...))` 或 primary-model 失败重试；当前错误继续按现有 `TitleError`/后台 best-effort 合同传播。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `CONTEXT.md` | Session History 是经过 active compaction/epoch 投影的模型历史；标题还需一个全历史原始请求锚点，两者不能混为一个数据源。 |
| 根 `AGENTS.md` | 保持单一函数内聚、复用既有 owner、避免 single-use helper 和无依据 fallback；测试/typecheck 从 package 目录运行。 |
| `packages/opencode/AGENTS.md` | Effect 服务、typed error、Database/InstanceState 与 named Effect 约束；标题改动继续位于现有 `SessionPrompt` layer。 |
| `packages/opencode/test/AGENTS.md` | 使用真实 instance、`testEffect`、Provider readiness 与公开行为 seam，不用固定 sleep 或私有函数 mock。 |
| `docs/adr/README.md` | 唯一 accepted ADR 是 triage 标签共存，与标题生成无关；本任务不新增 ADR。 |
| upstream `v2.2.5` tag（commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`） | `SessionTitle` 已提供原始请求、近期对话、字符预算与材料包装的权威参考。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/session/prompt.ts:481-582,1975-1985` | 手动/自动共用 `title`；当前 `findIndex(real)`、`slice(0, idx+1)` 与固定 user 前缀是首个分歧点。 | observed |
| `packages/opencode/src/agent/prompt/title.txt` | 当前系统 Prompt 是旧版 50 字符规则；按 R1 审计证据，需原位替换为 upstream `PROMPT_TITLE`，而不是另加第二份 Prompt。 | contracted |
| `packages/opencode/src/agent/agent.ts:333-348,366-397` | title Agent 的模型、temperature、权限和可覆盖 Prompt；无需新增 Agent。 | contracted |
| `packages/opencode/src/session/llm/request.ts:58-103` | `agent.prompt` 与 `input.user.system` 都进入 system；标题请求必须保留前者并隔离后者，正常主回复行为不变。 | observed |
| `packages/opencode/src/session/prompt.ts:1068-1081,2526` + session route payload | 公开 prompt 输入可持久化用户级 `system`；R3 外部 red 已证明它追加进标题 Provider system。 | observed |
| `packages/opencode/src/session/prompt.ts:1200-1216,1386-1400`；`packages/schema/src/v1/session.ts:122-128` | file/agent parts 会在同一真实用户消息内生成 synthetic Read、附件正文和 task 指令；`synthetic` 与 `ignored` 是独立字段。 | observed + red |
| `packages/opencode/src/session/session.ts:491-510,853-870` | `createNext` 当前分别用 `new Date()` 与 `Date.now()` 产生默认标题和 `time.created`，需要共享创建值；`sessions.messages` 返回 chronological 全量持久历史。 | observed |
| `packages/opencode/src/session/message-v2.ts:1230-1254,1471-1592` | `filterCompactedEffect` 是 active-window owner；hidden、有效 summary 与 retained tail 已由它处理。 | contracted |
| `packages/opencode/src/session/title.ts` | 默认标题判定同时匹配 root/child；upstream 的初始命名仅针对 root fallback，因此初始分支还需 `!parentID`。 | contracted |
| `packages/opencode/test/session/prompt.test.ts:7238-7467` | 现有手动/自动成功、压缩、失败和 guards 可直接扩展为行为验收。 | observed |
| `packages/opencode/test/lib/llm-server.ts:614-617,654-765` | `titleHits` 捕获真实 Provider body；旧固定句只用于识别标题请求，Prompt 改后必须同步识别条件。 | observed |
| upstream [`session/title.ts@v2.2.5`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/title.ts) | `messagePrompt`、`conversationPrompt`、2000/8000 字符、原始请求与 recent tail 的直接来源。 | contracted |
| upstream [`plugin/agent.ts@v2.2.5`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/agent.ts) | 同一 title Agent 绑定的完整 `PROMPT_TITLE`，含自然短语、sentence case 和“name, not answer or carry out”约束。 | contracted |
| upstream [`session-title-fallback.ts@v2.2.5`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/util/src/session-title-fallback.ts) | `isExactRootFallback` 要求标题等于该 Session 创建时间的精确 root fallback，不能只匹配时间戳格式。 | contracted |
| upstream [`session/history.ts@v2.2.5`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/history.ts) | `firstUserMessage` 从全历史升序读取；`load(...,"latest")` 从最新完成压缩边界读取。 | contracted |
| upstream [`session/store.ts@v2.2.5`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/store.ts) | `store.context` 复用 latest history；不是完整压缩前 transcript。 | observed |
| 临时外部复现 `D:\Temp\opencode\title-upstream-r1` | 在真实公共 service 与 Provider HTTP seam 上复现缺失输入和包装；仓库文件未改。 | observed |

## 5. Current Behavior

```text
TUI Generate
  -> POST /session/:sessionID/title（仅 sessionID）
  -> SessionPrompt.generateTitle
  -> MessageV2.filterCompactedEffect（active window）
  -> title(manual: true)

自动首轮
  -> title(history: msgs, providerID/modelID)
  -> 同一个标题算法
```

`title` 当前执行：

1. 自动路径检查 parent/default-title/exactly-one-real-user；手动路径跳过这三个触发 guard。
2. 在传入 active history 中找到第一条真实用户 `idx`。
3. 用 `slice(0, idx + 1)` 截到该条；后续真实用户和助手进展被截掉，压缩前原始请求天然不可达。
4. 发送一个固定 user 消息 `Generate a title for this conversation:\n`，再把原始 user/assistant 角色消息展开到同一请求。
5. 原任务仍以可执行 user 指令出现；系统 Prompt 虽要求只生成标题，材料本身没有 `<conversation>` 边界和结尾标题约束。
6. 输出仅去 `<think>`、取首个非空行并截断，因此任务回复式文本也能被持久化为标题。

手动和自动共享同一 Prompt 与输出清洗；差异只在触发 guard、调用参数和后台错误隔离。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| root 默认标题、首个真实用户 | `sessions.create()` + 首轮用户 | `isDefaultTitle` 且 `!parentID` | 自动或手动 Generate | `SessionPrompt.title` | observed |
| 已有自定义标题、多轮 Session | 用户 Rename/既往标题 | 手动允许重生成 | 手动 Generate | `SessionPrompt.title` | observed |
| child 默认或自定义标题 | `parentID` | 自动 guard 跳过，手动允许 | 手动 Generate | `SessionPrompt.title` | observed |
| 完成压缩后的 Session | `SessionCompaction` + 完成 summary | active owner 提供有效边界 | 全历史原始请求 + active recent | `Session.messages` / `filterCompactedEffect` | observed |
| 第二条及后续真实用户、assistant 文本 | 正常 Session 持久化 | chronological `WithParts` | recent conversation | `SessionPrompt.title` | observed |
| synthetic-only / compaction-only user | 系统续跑、技术 marker | 当前 real predicate 可识别 | real-user 选择与 recent 过滤 | `SessionPrompt.title` | observed |
| 混合真实文本 + file/agent synthetic parts | 公开 prompt 的文本、附件和 agent mention | real guard 允许整条消息，synthetic 标记在逐 part 上 | 标题只保留真实文本，过滤 Read/附件/task 指令 | `SessionPrompt.title` 文本投影 | observed + red |
| subtask-only 首个真实用户 | subtask part | 当前算法使用 prompt 拼接 | 标题文本投影 | `SessionPrompt.title` | contracted |
| 文件/媒体与 tool output | 用户附件、助手工具 part | 当前转换可序列化，upstream 标题只取文本 | 文本-only 标题材料；媒体字节和 tool output 不进入 | `SessionPrompt.title` | reachable |
| 长原始请求与长 recent | 持久化文本 | upstream 明确 2000/8000 字符预算 | 初始/重生成两个模板 | `SessionPrompt.title` | contracted |
| 用户级 `system` | 公开 prompt/promptAsync payload → `User.system` | 通用 `LLMRequest.prepare` 会追加到 system | 标题请求剥离、主回复保留 | `SessionPrompt.title` | observed + red |
| 无真实用户 | 空历史或全技术消息 | 当前 typed `no_user_message` | Provider 调用前失败 | `SessionPrompt.title` | observed |
| Agent/model/stream/空输出失败 | 配置或 Provider | 当前 `TitleError` 合同 | 手动 typed failure；自动后台忽略 | `SessionPrompt.title` | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 标题原始请求锚点来自全历史第一条真实用户，包括其位于压缩边界之前的情况。 | 用户要求 + upstream `firstUserMessage` + red | 当前手动测试反而断言旧请求不存在，需改写 |
| INV-02 | 重生成材料包含 active window 中后续真实用户与 assistant 文本，保留时间顺序。 | upstream `Recent conversation` + red | 当前第二条 active 用户未进入 Provider body |
| INV-03 | 标题材料由单一 user 材料消息承载，使用 `<message>` 或 `<conversation>` 并以 `Reply with only the title.` 收尾。 | upstream 明确防执行注释与模板 | 当前无包装，红信号可直接捕获 |
| INV-04 | 只有 root 且标题精确等于该 Session `time.created` 对应 fallback 时使用 `messagePrompt`；新 Session 的默认标题和 `time.created` 必须共用同一个创建值；其他标题或 child Session 使用 `conversationPrompt`。 | upstream `isExactRootFallback` + R2 分离时钟证据 | 确定性跨毫秒创建、自动首轮、非精确时间戳和 child 测试 |
| INV-05 | 重生成原始请求最多 2000 字符；完整 conversation Prompt 最多 8000 字符，recent 超预算保留尾部。 | upstream 常量与 `slice(-budget)` | 新增长文本 Provider body 验收 |
| INV-06 | real-user、synthetic/compaction 过滤、有效 summary、retries、输出清洗和持久化保持现有合同；active 有真实用户时仍由 active 首条真实用户选择模型。 | 当前可达回归面与 R1 B-01 | 现有成功/失败/guards + 跨压缩模型切换测试 |
| INV-07 | 自动 parent/default/exactly-one guards、后台 fork/`Effect.ignore` 与主回复隔离保持不变。 | 当前自动合同 | 现有自动 characterization |
| INV-08 | 不新增 alternate success path、Provider fallback、输出语义 workaround、API 或依赖。 | 用户最小复刻要求 + policy | diff/path audit |
| INV-09 | 标题用户文本逐 part 排除 `synthetic`/`ignored`，不携带附件正文、Read/agent 指令、媒体字节或 tool output；real-user guard 与 subtask-only 合同不变。 | upstream 文本-only + R4 混合消息 red | 公共入口混合消息 Provider body 验收 |
| INV-10 | 默认 title Agent system Prompt 精确复刻 upstream `PROMPT_TITLE`，继续使用同一个 Agent 和配置覆盖；标题请求不得追加原用户 `system`，正常主回复仍保留它。 | upstream 请求合同 + R1/R3 system 证据 | Provider body 同时验收 upstream system、无用户 system 与主回复隔离 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02 | `input.history.slice(0, idx + 1)` 在组装材料时丢弃全历史原始请求和第一条 active 用户之后的内容；active 无真实用户时更早的 `idx === -1` 直接失败。 | `SessionPrompt.title` | `prompt.ts:496-509`；主 red 与 original-only red |
| INV-03 | 固定 user 前缀后直接展开原角色消息，原始任务仍可被模型当成新指令执行。 | `SessionPrompt.title` | `prompt.ts:535-549`；缺 `<conversation>` 与 closing instruction |
| INV-04 | 默认标题由 `createDefaultTitle` 内的 `new Date()` 生成，`time.created` 随后另读 `Date.now()`，精确比较会受跨毫秒影响。 | `Session.createNext` + `session/title.ts` | `session.ts:491-510`；确定性 fake-time red |
| INV-05 | 当前没有 upstream 的原始请求和 conversation 字符预算。 | `SessionPrompt.title` | 当前无 2000/8000 常量或 tail 截断 |
| INV-09 | real guard 以“任一真实 part”接纳混合消息，但当前材料转换不过滤其中的 synthetic text，附件正文和工具指令进入标题。 | `SessionPrompt.title` 文本投影 | `prompt.ts:1200-1216,1386-1400`；R4 外部 red |
| INV-10 | 当前 `title.txt` 是旧版规则，且 `llm.stream` 接收的 `firstInfo` 携带持久化 `user.system`，会被通用 prepare 追加到标题 system。 | `agent/prompt/title.txt` + `SessionPrompt.title` | 本地 Prompt 差异；R3 外部 red 实际捕获冲突指令 |

**Origin**：材料选择与请求表示的首个分歧位于 `SessionPrompt.title`，system 指令位于现有 `agent/prompt/title.txt`，默认标题/创建时间身份事实由 `Session.createNext` 与 `session/title.ts` 共同生产。TUI、HTTP、标题写回与 Provider 错误映射只是后续消费者，不应承担修复。

### Red-capable feedback loop

临时复制品只修改外部测试副本，通过真实 `SessionPrompt.generateTitle` 和真实 TestLLMServer HTTP body 断言 upstream 必需材料。

```text
Command: bun test "D:\Temp\opencode\title-upstream-r1\test\session\prompt.resolved.test.ts" --test-name-pattern "manual title generation uses active real users" --timeout 30000
Working directory: packages/opencode
Observed: 0 pass / 153 filtered out / 1 fail / 4 expect calls
Missing values:
  history outside the active compaction window
  active project constraints
  <conversation>
  Reply with only the title.
Present as expected:
  active project requirements
  completed compacted summary
```

同一运行先通过 `sessions.messages` 全历史 probe，证明 old request、两个 active 用户均可由现有 owner 提供；失败发生在标题材料组装，而非持久化数据缺失。

依赖修复获得用户明确许可后执行了 `bun install --frozen-lockfile`（repository root），安装 434 个缺失包，lockfile 与源码未改。临时目录中曾创建的 junction 已全部仅删除链接本体；后续复现未创建任何链接。

R2 审计新增的两个外部红信号也已实际运行：

```text
default title shares the exact session creation timestamp
0 pass / 1 fail
Expected: New session - 2023-11-14T22:13:20.002Z
Received: New session - 2023-11-14T22:13:20.000Z
```

该测试用 `setSystemTime` 固定 `new Date()`，用递增的 `Date.now()` 模拟跨毫秒；修复后创建 owner 只读取一次 `created`，同一测试应变绿。

```text
manual title generation uses the pre-compaction request without active real users
0 pass / 1 fail
SessionPrompt.TitleError: no_user_message
```

该测试先通过 `filterCompactedEffect` 证明 active 只剩 compaction marker/summary，再调用公共 `generateTitle`；全历史原始请求存在，但当前在 Provider 调用前失败。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 全历史消息读取 | `Session.messages` | chronological `WithParts[]` | 已有公开读取合同，能覆盖压缩前首条用户 | TUI/HTTP 不应查询数据库 |
| active window | `MessageV2.filterCompactedEffect` | 有效压缩边界、hidden 与 retained tail | 现有 Session History owner | 标题函数不另写压缩边界算法 |
| 默认标题身份事实 | `Session.createNext` + `session/title.ts` | 新 Session 的标题和 `time.created` 共用一次创建值；精确 fallback 可重建 | 创建者是唯一能保证一致的 owner | 标题消费者不应猜测或容忍两个不同时间戳 |
| 标题材料与 Prompt | `SessionPrompt.title` | 选择原始请求、recent、预算，构造不携带用户 `system` 的标题请求用户身份 | 当前首个分歧与唯一标题算法所在 | 通用 `LLMRequest.prepare` 仍为主回复保留 `user.system`，不能全局删除 |
| 标题系统指令 | `title` Agent + `title.txt` | 原位提供 upstream 完整 `PROMPT_TITLE`，保留配置覆盖与无工具合同 | 同一 title Agent 已拥有 system Prompt | 无需新增系统 Prompt 文件或第二 Agent |
| Provider 行为证据 | `TestLLMServer.titleHits` | 捕获实际 HTTP body | 公共 Provider seam，能检查材料而非私有 helper | 不测私有函数、不凭标题 readback 推断输入 |
| 标题 fixture 路由识别 | `TestLLMServer.isTitleRequest` | 区分标题与主 Agent queue | 新 upstream 模板不再含旧固定句 | production 不为测试保留旧 Prompt |

## 10. Single Approved Primary-Path Design

主修复仍位于现有 `SessionPrompt.title` 的材料组装；另在原 `title.txt` 复刻同一 Agent 的 upstream system Prompt，并在默认标题纯函数中复用精确时间戳构造。保留 public manual wrapper、自动调用方、Agent/model/stream/error/persistence 合同。

### 10.1 历史输入

1. 保留 `input.history` 作为 active window。
2. 自动 guards 与 exactly-one 统计继续基于 active real users，guard 未通过时不做额外全历史读取。
3. 需要生成时调用 `sessions.messages({sessionID: input.session.id})`，用同一个 `real` predicate 找全历史第一条真实用户；这条消息只提供 Original request 与标题文本/subtask 材料。
4. 全历史没有真实用户时继续返回 `no_user_message`；手动路径不再要求 active window 必须另有真实用户，压缩前原始请求本身可以构成材料。
5. active window 有真实用户时，继续用 active 首条真实用户的 `info.model` 作为现有模型锚点；只有 active 没有真实用户的新支持分支才复用现有 `currentModel(sessionID)` 解析当前 Session 模型。不得用压缩前 original 用户覆盖 active 的新 Provider/模型。
6. 标题请求用户身份继续使用 active 首条真实用户，active 空缺时才使用全历史 original 用户；这只决定请求元数据，不改变第 5 步模型锚点。传给 `llm.stream` 前以 `{ ...titleUser, system: undefined }` 去除用户级 system，持久化原文不变。

该复用增加一次按需全历史读取：自动首轮历史很短，手动 Generate 是用户显式低频操作；本任务不新增一个只服务标题的 SQL/public history API。重生成 Prompt 有明确字符上界，初始 Prompt 按 upstream 不截断首条全文。

### 10.2 upstream 文本投影与常量

在原 `title` 函数附近保留少量私有纯函数/常量，直接采用 upstream 文本：

```text
MAX_CONTEXT_LENGTH = 8_000
MAX_FIRST_MESSAGE_LENGTH = 2_000

Here is the first message of the conversation:

<message>
${text}
</message>

Reply with only the title.
```

```text
Here is the conversation so far:

<conversation>
${text}
</conversation>

Reply with only the title.
```

文本投影规则：

- 原始用户：只保留 `type === "text"`、`!ignored` 且非 `synthetic` 的 parts，用 `\n` 连接并 `trim()`；subtask-only 继续将 subtask prompts 用换行连接。
- recent 用户：使用同一逐 part 非 synthetic/非 ignored 文本投影，排除全历史首条用户 ID，格式为 `User: ${text.trim()}`，保持 active 顺序。
- recent 助手：每个 text part 先 `trim()`，过滤空文本后用 `\n` 连接；最终结果非空才格式化为 `Assistant: ${text}`，包括有效 compaction summary。
- recent 条目用 `join("\n\n")` 连接；synthetic-only、compaction-only、媒体字节、reasoning 和 tool output 不进入这份文本投影。

### 10.3 初始与重生成模板

- **创建事实**：`createDefaultTitle(isChild = false, created = Date.now())` 用 `new Date(created).toISOString()` 生成标题。`Session.createNext` 在构造 `result` 前只读取一次 `const created = Date.now()`，同时传给 `createDefaultTitle(!!input.parentID, created)` 和 `time.created`；`time.updated` 的现有语义不变。
- **初始命名**：仅在 `!input.session.parentID` 且 `input.session.title === createDefaultTitle(false, input.session.time.created)` 时使用 `messagePrompt(originalText)`；自动触发 guard 的宽泛 `Session.isDefaultTitle` 判定不变。
- **重生成**：已有标题或 child Session 使用 `conversationPrompt`：
  - `Original request:\n${originalText.slice(0, 2000)}`
  - 有 recent 时添加 `Recent conversation:\n${recent}`。
  - `budget = 8000 - conversationPrompt("").length - prefix.length`。
  - 使用 `recent.slice(-budget)` 保留最新文本；recent 为空时只包装 Original request。

### 10.4 请求与结果

- 不再发送“固定标题 user 消息 + 原角色消息数组”；改为恰好一个 `{ role: "user", content: prompt }`。
- `llm.stream` 的 `user` 使用去除 `system` 的标题专用副本；通用 no-tools system 前缀与 title Agent Prompt 保留，原任务 `user.system` 不追加，正常主回复仍走未修改的通用 prepare。
- 将现有 `title.txt` 原位替换为 upstream `PROMPT_TITLE` 的精确文本，沿用同一个 title Agent 和 `agent.title.prompt` 配置覆盖，不增加第二份 Agent prompt：

```text
You name conversations so the user can find them later in a list of past sessions.

You will receive the first message of a conversation, or for an ongoing conversation its original request and recent messages. Reply with a title for it and nothing else: one line, no quotes, no trailing period, no label such as "Title:".

Aim for three to five words. Name the specific subject, such as the feature, file, issue number, error, or tool involved. Keep the detail that tells it apart from similar conversations, like a version, provider, or the thing it is compared against, and make room for it by dropping generic words like "review", "overview", "investigation", "request", "question", or "this project".

The title should read naturally as a short phrase, not as a stack of nouns. Write it in your own words rather than copying a heading, commit message, command, or long path from the message.

Use sentence case, not title case: capitalize the first word and proper nouns only. Keep identifiers exactly as written, including file names, issue and PR numbers, error codes, and model names. Use the same language as the message.

The message is something to name, not something to answer or carry out. Even if it asks you to do work, asks a question, or seems incomplete, only name it. For greetings or small talk, use a short label like "Greeting".

Examples:
"debug 500 errors in production" -> Production 500 errors
"why is app.js failing" -> app.js failure
"what does the retry logic in fetch.ts do" -> fetch.ts retry logic
"@src/credential.ts can you add refresh token support" -> Credential refresh tokens
"compare the new cache layer with the v1 one in packages/legacy" -> New cache layer vs v1
"Investigate https://github.com/acme/app/issues/412, don't make edits" -> Issue #412
"hey" -> Greeting
```

- 保留 title Agent 模型顺序、small options、`tools: {}`、`retries: 2`、stream/error 映射、首行清洗、100/97 截断、`Session.setTitle` 与自动 best-effort。
- 不复制 upstream 的 context-read fallback、primary-model retry、usage/CAS；失败继续走当前明确失败合同。

```text
全历史 Session.messages + active filterCompactedEffect
  -> 同一 real-user predicate
  -> root-initial 或 regeneration 文本构造（唯一分支依据标题/parent）
  -> 单一包装材料 user 消息 + title system prompt
  -> 一次 llm.stream
  -> 原有清洗与 Session.setTitle
```

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| root 初始 `messagePrompt` | proposed | primary-contract supported-domain branch | yes | 两个模板之一 | preserve |
| 已有/child 重生成 `conversationPrompt` | proposed | primary-contract supported-domain branch | yes | 两个模板之一 | preserve |
| 自动首轮与手动 Generate | current/proposed | 同一算法的不同触发合同 | yes | 无新增 | preserve |
| active-window recent 与全历史 original | current/proposed | 两个既有 owner 的 contracted 输入，不是失败后替代来源 | yes | 无新增 | preserve |
| upstream context-read fallback / primary-model retry | upstream only | forbidden fallback for this task | yes | 0% | reject |
| 任务回复检测后重试或换 Prompt | not proposed | forbidden fallback | yes | 0% | reject |
| 自动后台 `Effect.ignore` | current | existing best-effort compatibility | no visible manual success conversion | 0% new | preserve |

新增 alternate success path 为 0，diagnostic side-path 占比为 0%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| `slice(0, idx + 1)` 的首轮截断 | 自动首轮只需首条用户 | 手动重生成需要原始请求加近期文本 | `prompt.ts` 的 `context` 构造整段移除 |
| 固定 `Generate a title...` user 前缀加原角色展开 | 复用普通历史转换最省事 | 单一 `<message>/<conversation>` 明确材料边界 | `prompt.ts` 的 `messages` 构造原位替换 |
| `onlySubtasks` 独立消息分支 | 普通转换不直接输出 subtask prompt | 用户文本投影统一保留 subtask prompt | 折叠到同一文本投影，不保留第二套消息算法 |
| 旧 `isTitleRequest` 固定句 | 测试 fixture 识别旧 Prompt | upstream 两个模板共用新的 closing instruction | `test/lib/llm-server.ts` 一行替换 |
| 旧版 `title.txt` 50 字符与示例规则 | 早期通用标题 Agent Prompt | 用户明确选择 upstream 完整标题 system Prompt | `agent/prompt/title.txt` 原位替换，不保留第二份 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 | 全历史 `sessions.messages` + 同一 real predicate | `prompt.ts` | 压缩前 old request 出现在实际 title HTTP body |
| INV-02 | active recent 用户/助手文本 | `prompt.ts` | 第二条 active 用户与 summary 出现在同一 conversation |
| INV-03 | 单一 upstream 材料消息 | `prompt.ts`、fixture 识别 | `<message>/<conversation>`、closing instruction 与单消息角色验收 |
| INV-04 | 共享创建值、精确 root fallback 与 regeneration/child/相似时间戳分支 | `session.ts`、`session/title.ts`、`prompt.ts` | 确定性跨毫秒创建、自动首轮、非当前创建时间标题和 child 分别验收 |
| INV-05 | 2000/8000 与 recent tail | `prompt.ts` | 长文本长度、原始截断和最新 marker 保留验收 |
| INV-06/09 | real-user、逐 part 文本投影与现有模型/输出/持久化 | `prompt.ts` | 混合真实/file/agent 输入排除 synthetic；跨压缩模型及既有 synthetic/compaction/subtask/failure 回归 |
| INV-07 | 自动 guards 与后台 best-effort | 不改调用方 | 现有自动首轮、三个 guard、主回复隔离测试 |
| INV-08 | 仅 owner 修复，无新增路径/API | 第 15 节六个既有文件 | diff、path inventory、typecheck、HttpApi regression |
| INV-10 | 同一 title Agent 的 upstream system Prompt 与标题专用无用户 system 请求 | `agent/prompt/title.txt`、`prompt.ts` | 冲突用户 system 的公共入口 red-green；标题 body 排除它，主回复 body 保留它 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 全历史第一条真实用户 | INV-01 | red 显示 active owner 无法提供压缩前原始请求；`Session.messages` probe 通过 | active `input.history` 已永久丢失该消息 |
| active recent 用户/助手文本 | INV-02 | red 缺第二条 active 用户；upstream recent 合同 | 当前 `slice` 在第一条用户处终止 |
| 两个私有 Prompt 模板 | INV-03/04 | upstream 明确文本与防执行注释 | 当前固定前缀不具备材料边界和 closing instruction |
| 2000/8000 字符常量与 tail budget | INV-05 | upstream 明确常量与 `slice(-budget)` | 当前没有任何标题材料预算 |
| 用户/助手文本投影 | INV-02/06/09 | upstream 文本-only；R4 证明混合消息 synthetic Read/附件/task 指令会进入标题 | 通用转换和仅排除 synthetic-only 整条消息都不能提供逐 part 隔离 |
| `Session.messages` 全历史读取 | INV-01 | 现有 public chronological owner | 新增专用 SQL/public history API 会扩大文件与接口范围，无必要 |
| active 模型锚点 + active 空缺时 `currentModel` | INV-06 | R1 B-01 证明每轮模型可变化；`currentModel` 是当前 Session 模型 owner | 用 original 用户选择模型会回退到压缩前旧 Provider/模型 |
| `createDefaultTitle` 可选创建时间 + `createNext` 共享 `created` | INV-04 | upstream 精确 fallback；R2 证明分离时钟使正常默认标题也可能不相等 | 仅匹配正则会丢 recent，仅加精确比较又会让正常首轮跨毫秒失配 |
| upstream `PROMPT_TITLE` 原位替换 | INV-10 | R1 B-03 与 upstream `plugin/agent.ts` | 旧 `title.txt` 不包含完整标题风格及材料防执行 system 约束 |
| 标题请求用户副本 `system: undefined` | INV-10 | R3 B-01 与公共入口 red；通用 prepare 明确追加 `user.system` | 仅替换材料/Prompt 无法阻止高优先级任务指令进入标题请求；全局删除会破坏主回复 |
| fixture 新 closing 识别 | INV-03 | 新模板没有旧固定句 | 不改会把标题请求送入主 Agent queue，破坏测试 seam |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/session/prompt.ts` | modify | 在原 `title` 内复用 original/recent，保留 active 模型锚点，加入 upstream 模板、预算、精确 root fallback、单材料消息与标题专用无用户 system 副本 | 约 +77 / -45，有效改动约 87 行 |
| `packages/opencode/src/session/title.ts` | modify | `createDefaultTitle` 增加可选 `created = Date.now()`，复用精确 fallback 格式 | 2 行有效改动 |
| `packages/opencode/src/session/session.ts` | modify | `createNext` 只读取一次 `created`，同时用于默认标题和 `time.created`；接口与其他字段不变 | 3 行有效改动 |
| `packages/opencode/src/agent/prompt/title.txt` | modify | 原位替换为 upstream `PROMPT_TITLE` 精确文本，不新增 Agent 或配置 | 约 29 个非空有效文本行 |
| `packages/opencode/test/session/prompt.test.ts` | modify | 更新手动压缩验收；增加创建时钟、original-only、用户 system、混合 synthetic、upstream Prompt、active 模型、精确 fallback、预算与文本投影 | 约 +240 / -15，有效改动约 245 行 |
| `packages/opencode/test/lib/llm-server.ts` | modify | 标题请求识别从旧固定句改为 upstream 共用 closing instruction | 1 行有效改动 |
| `docs/plans/session-title-upstream-parity.md` | add | 唯一 canonical plan 与审计记录 | 文档，不计 E |

不改 MessageV2、Session public API、TUI、HTTP、SDK 或 generated 文件；`session.ts` 仅修改上述创建者三行。

## 16. TDD Behavior Slices

公共 seam 是现有 `SessionPrompt.generateTitle` / 自动 `prompt.loop` 与真实 Provider HTTP body；标题 readback 只证明持久化，body 证明模型实际收到的材料。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | `setSystemTime` 固定 `new Date()`、递增 `Date.now()` 时，新 Session 默认标题仍精确等于 `time.created` 对应 fallback | 当前分离时钟已实际红跑 | `createNext` 与 `createDefaultTitle` 共享一次 `created` | 自定义标题、child 前缀和 `time.updated` 不变 |
| 2 | 自动首轮 title Agent system 段精确等于 upstream `PROMPT_TITLE`，材料含 `<message>`、首条全文、closing，且只有一个材料 user 消息 | 当前 system/材料均为旧版 | 原位替换 `title.txt`，实现精确 root-default `messagePrompt`；fixture 改识别 closing | 自动标题仍写回且主回复不被偷走 |
| 3 | 公共 prompt 写入冲突 `user.system` 后，标题 body 排除它而正常主回复 body 保留它 | 当前外部红测实际捕获冲突指令进入标题 system | 仅标题请求使用 `system: undefined` 用户副本 | 通用 prepare、主回复 system 和持久化原文不变 |
| 4 | 同一用户消息混合真实文本、text file 与 agent part 时，标题仅有真实文本，没有 Read、附件正文或 task 指令 | 当前外部 red 实际捕获 synthetic 文本 | original/recent 用户文本逐 part 排除 synthetic/ignored | real-user guard、附件持久化与 subtask-only 不变 |
| 5 | 压缩后的手动重生成同时含全历史 original、两个 active 用户、summary 与 `<conversation>` | 当前缺 old request、第二用户和包装（已实际红跑） | 加入全历史 original 与 active recent 的 `conversationPrompt` | compaction-only marker 继续排除，summary 保留 |
| 6 | 压缩前存在 real、active 只剩 marker/summary 时，公共 `generateTitle` 使用 original 与当前 Session 模型成功生成 | 当前已在公共入口红跑为 `no_user_message` | 全历史 original + active 空缺时 `currentModel`；检查 Provider model/body | 技术 marker 不进入，full-history 也无 real 的既有失败不变 |
| 7 | 压缩前旧模型、active 新模型时标题仍使用 active 新模型 | R1 B-01 揭示 original 锚点会污染模型选择 | original 仅提供文本，保留 active 模型锚点 | 不新增失败重试或 Provider fallback |
| 8 | 非当前创建时间的相似默认标题、自定义/child 重生成使用 conversation；subtask 与技术消息按文本合同投影 | 宽泛正则或首条截断会丢 recent | 精确 root fallback 与统一文本投影 | 手动 child、多轮、自定义标题与 synthetic 失败合同 |
| 9 | 超长 original/recent 满足 2000/8000 并保留最新 marker | 当前无预算 | 加入两个常量和 `slice(-budget)` | 短输入逐字不变，recent 为空仍只含 original |
| 10 | 运行既有手动七类失败、自动 guards/失败、完整 prompt 回归 | 新逻辑可能破坏错误和触发边界 | 仅为已确认回归做 owner 内修正 | 无 fallback、错误映射、后台 best-effort、标题写回 |

每个 slice 按 `red -> minimal approved behavior -> green -> related regression` 执行，不一次性横写全部测试。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 367（生产/Prompt 121、测试/fixture 246） | 排除 imports、formatter、文档与 pure moves |
| Required Chinese explanatory comments `C` | `ceil(367 × 0.15) = 56`，计划至少 56 | 实施时按实际 E 重算，禁止凑数 |

必须靠近真实决策的注释：

- 默认标题与 `time.created` 共用一次时钟读取是精确 root-fallback 的生产者前提。
- 精确 root-default 才走初始模板，相似时间戳与 child 默认标题按 upstream 属重生成。
- 全历史 original 只提供文本，active 首条真实用户继续拥有模型选择；active 空缺才使用 `currentModel`。
- 全历史 original 与 active recent 的职责差异，以及 exactly-one 仍只看 active real users。
- system Prompt 与单材料 user 消息共同约束“命名而非执行”，标题专用用户副本还要剥离 `user.system`，通用主回复不变。
- real-user 是整条消息判定，标题文本还必须逐 part 排除 synthetic/ignored，避免附件与 agent 指令混入；compaction-only 排除与有效 summary 保留。
- 2000/8000 是 upstream 字符预算，recent 超顶保留尾部。
- 单材料 user 消息用于防止原任务被当成新指令执行。
- 测试为何同时检查全历史锚点、后续文本、实际 Provider body 和最新 tail，而非私有 helper。

## 18. Verification

### 18.1 Plan-stage checks already executed

| Command / check | Working directory | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | repository root | 用户授权后成功修复 434 个缺失依赖；lockfile/源码未改 |
| 外部复制真实 prompt fixture 并按 upstream 期望运行 | `D:\Temp\opencode\title-upstream-r1` + `packages/opencode` | 成功建立真实 public seam；无仓库测试修改、无残留 junction |
| `bun test "D:\Temp\opencode\title-upstream-r1\test\session\prompt.resolved.test.ts" --test-name-pattern "manual title generation uses active real users" --timeout 30000` | `packages/opencode` | 预期红：0 pass / 1 fail；同时缺 old request、second active user、conversation wrapper、closing |
| 同一外部测试，pattern `default title shares the exact session creation timestamp` | `packages/opencode` | 预期红：fake-time 下标题 `.000Z`、`time.created` `.002Z`，证明创建者分离时钟 |
| 同一外部测试，pattern `manual title generation uses the pre-compaction request without active real users` | `packages/opencode` | active 无 real 探针通过后，公共 `generateTitle` 预期红为 `no_user_message` |
| 同一外部测试，pattern `manual title generation excludes user system without changing the main reply` | `packages/opencode` | 预期红：标题 Provider system 实际包含冲突用户指令；后续 green 还需证明主回复保留 |
| 同一外部测试，pattern `manual title generation excludes synthetic parts from mixed real user input` | `packages/opencode` | 真实文本存在断言通过后，预期红为标题 body 包含 `Called the Read tool`；同 fixture 还覆盖附件正文和 agent 指令 |
| 同一次运行的 `sessions.messages` 全历史 probe | `packages/opencode` | 在最终失败断言前通过，证明现有 owner 能提供全部所需原始文本 |
| upstream tag/source 对照 | `anomalyco/opencode@v2.2.5` | 核对 `title.ts`、`history.ts`、`store.ts`、`plugin/agent.ts`、精确 fallback 与 tag commit，不依赖记忆 |

### 18.2 Approved implementation verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 全部新旧 title slices 与 SessionPrompt 回归通过 |
| `bun typecheck` | `packages/opencode` | Effect/Schema/ModelMessage 类型通过 |
| `bun run test:httpapi`（在仓库支持的 Ubuntu/Linux Bun 1.4.4 环境） | `packages/opencode` | coverage/auth/effect 全量路由回归，title scenario 继续通过 |
| `git diff --check` | repository root | 无 whitespace error |
| `git status --short` + `git diff --name-only` | repository root | 实施改动只涉及第 15 节文件和本 plan；无关工作区修改保持原样 |

不运行 SDK/Client 生成，因为 public HttpApi 不变；不运行 TUI 测试，因为 TUI 不变。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1（canonical plan；实施阶段无新增 production/test 文件） | 用户要求新 Verify Plan |
| Files modified | 实施 6 个既有文件：4 production/Prompt + 2 test/fixture | R1/R2 确认的模型、创建事实、精确 fallback 与 system Prompt 均由原 owner 承载 |
| Files deleted | 0 | 无需删除文件 |
| Production lines | 有效改动约 121：标题函数 87、默认标题纯函数 2、创建者 3、upstream system Prompt 29 | 完成 upstream 行为且保持单主路径 |
| Test lines | 有效改动约 246 | 覆盖创建时钟、original-only、用户 system、混合 synthetic、recent/模型/精确模板/预算及回归 |
| Generated lines | 0 | 无公共 API 或生成面变化 |

预算是审计信号，不允许删去已确认行为来换取更小 diff。

## 20. Real Risks and Open Decisions

### Real risks

- upstream 的初始 `messagePrompt(firstUser.text)` 没有 2000 字符截断；本任务保持该精确行为，2000 上限只用于重生成 Original request，不能声称所有初始标题材料都有同等字符上限。
- recent 来自 latest active window，压缩前只有全历史第一条真实用户作为锚点；完整旧 transcript 不会进入标题请求。
- 字符预算控制的是文本长度，Provider 实际 token 仍受模型 tokenizer 影响。
- upstream system Prompt 与单一材料消息共同强化标题语义，但模型输出仍由模型决定；当前与 upstream 都取首个非空行，本任务不添加输出语义判定或二次重试。
- 全历史读取是手动重生成新增的按需成本；当前没有测量到性能回归，不能用未测量性能猜测替换公开 owner 或新增 SQL API。

### Open Decisions Requiring the User

无。用户已明确选择 upstream 2.2.5 的标题上下文与 Prompt 逻辑，并要求最小修改及先完成 Verify Plan。

### Rejected Speculation

- 不增加“下一步回复”正则、关键词黑名单或输出分类器；没有 upstream 合同支持这类第二算法。
- 不恢复 primary-model retry、context-read fallback、usage/CAS、single-flight 或锁；它们与本次首个分歧无直接关系。
- 不把压缩前所有消息拼入 recent；upstream 本身只保留全历史原始请求和 latest recent。
- 不序列化媒体字节、reasoning 或 tool output 以追求更多上下文；upstream 标题文本投影明确只取用户/助手文本。
- 不为首条用户新增专用 SQL/public API；现有 `Session.messages` 已证明能提供所需数据，且没有测量要求新增查询接口。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository and upstream evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Verify the red-capable signal actually exercises the public title service and Provider request, rather than a private or synthetic prompt builder.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 模型锚点回归；B-02 默认标题判定过宽；B-03 漏复刻 system Prompt | R2 历史表述；初始 Prompt 上界表述 | BLOCK | `ses_e3517803effeAoBkvsDw75eyvU` |
| 2 | R2 | yes | B-01 默认标题/创建时间分离时钟；B-02 active 无 real 新分支无验收 | 文本投影细节与表格记录建议 | BLOCK | `ses_e34ffbf11ffe2SkYjqQnRUlkmV` |
| 3 | R3 | yes | B-01 用户级 system 仍进入标题请求 | 无 | BLOCK | `ses_e34e53ff7ffeZJjaQO7fLYkMhv` |
| 4 | R4 | yes | B-01 混合真实/synthetic 消息的材料隔离 | 验证文件清单记录建议 | BLOCK | `ses_e34d33542ffeKd6ljoMCwCrioM` |
| 5 | R5 | yes | No blocking findings | 无 | APPROVE | `ses_e34c2c2efffep3Yupxar4sTqjB` |

### Round 1 — R1 independent verdict（原样记录）

## Blocking findings

### B-01 全历史文本锚点被错误复用为模型选择锚点

- Violated invariant: INV-06 要求模型选择保持现有合同；标题材料修复不应把手动重生成切换到压缩前的旧 Provider/模型。
- Evidence class: reachable
- Producer and execution path: `PromptInput.model` 允许每轮选择不同模型并持久化到用户消息 → 压缩后 active window 使用新模型 → 手动 `generateTitle` → 计划将 `firstInfo` 改为全历史首条用户 → `getSmallModel/getModel` 改用旧用户的 Provider/模型。
- Source evidence: `packages/opencode/src/session/prompt.ts:509-530` 当前从 active 首条真实用户解析模型；`packages/opencode/src/session/prompt.ts:1058-1100` 每轮模型可以变化；`packages/opencode/src/session/prompt.ts:577-581` 手动入口没有显式传入模型覆盖。
- Canonical-plan evidence: §10.1 第 5 步明确要求“`firstInfo`、默认模型选择……锚定这条全历史用户”，与 §7 INV-06、§10.4 的“保留模型顺序”冲突；§16 没有跨压缩模型切换测试。
- Responsibility owner: `SessionPrompt.title` 中原始文本选择与请求模型选择的职责边界。
- Concrete behavioral consequence: 旧 Provider 已不可用而 active Provider 可用时，当前逻辑能够生成标题，计划却会返回 `unavailable`；旧 Provider 仍可用时则会静默使用非当前模型生成标题。
- Minimal correction direction: 全历史首条用户只提供 original 文本，保留 active 首条真实用户作为现有 `firstInfo`/模型锚点，并补充“压缩前旧模型、active 新模型”的回归测试；active 无真实用户的新支持分支不得改变上述现有行为。

### B-02 初始与重生成模板使用了过宽的默认标题判定

- Violated invariant: INV-02/INV-04 及 upstream `isUntitled` 合同：只有当前 root Session 的精确默认标题走 `messagePrompt`，其他手动重生成必须保留 recent conversation。
- Evidence class: reachable
- Producer and execution path: `sessions.create({title})` 或 `Session.setTitle` 可以产生符合默认标题正则、但不等于本 Session 创建时间的标题 → 后续存在 active 用户/助手 → 手动 Generate → 计划的宽泛 `Session.isDefaultTitle` 判定选择 `messagePrompt` → 后续 active 文本全部消失；upstream 的 `isExactRootFallback` 会选择 `conversationPrompt`。
- Source evidence: `packages/opencode/src/session/session.ts:478-510,776-778` 允许自定义及重命名标题；`packages/opencode/src/session/title.ts:12-15` 只匹配时间格式，不核对 `session.time.created`；upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/util/src/session-title-fallback.ts:30-33` 要求标题与该 Session 的精确 root fallback 相等。
- Canonical-plan evidence: §10.3 使用 `!parentID && Session.isDefaultTitle(...)`，并声称这与 upstream root fallback 一致；§7 INV-04 和 §16 未覆盖“格式像默认标题但并非当前 Session 精确 fallback”的手动重生成。
- Responsibility owner: `SessionPrompt.title` 的初始/重生成模板分支。
- Concrete behavioral consequence: 对这类可达的自定义或历史标题，计划会退回首条消息命名，丢失本轮修复要求加入的后续用户和助手材料。
- Minimal correction direction: 仅在模板分支按 upstream 的 `title + time.created + !parentID` 精确 root-fallback 条件判定初始命名，并增加非精确时间戳标题的手动多轮测试；无需改变现有自动触发 guard。

### B-03 upstream 2.2.5 的标题系统 Prompt 没有复刻

- Violated invariant: 用户明确要求完整检查并复刻 upstream 2.2.5 的标题逻辑和 Prompt，以获得“给对话命名，而不是回答或执行任务”的标题生成行为。
- Evidence class: contracted
- Producer and execution path: 手动或自动 Generate → `SessionPrompt.title` → `agents.get("title")` → `LLMRequest.prepare` 将 `agent.prompt` 放入 system；计划继续发送本地旧版 `title.txt`，而 upstream 2.2.5 使用另一份完整的 `PROMPT_TITLE`。
- Source evidence: `packages/opencode/src/agent/prompt/title.txt:1-44` 是旧规则；`packages/opencode/src/agent/agent.ts:333-348` 将其绑定到 title Agent；`packages/opencode/src/session/llm/request.ts:68-78` 将其送入 system。upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/core/src/plugin/agent.ts:19-37,100-107` 定义并绑定了新的标题 Prompt，包括自然短语、sentence case、禁止引号/结尾句号/标签，以及“The message is something to name, not something to answer or carry out”。
- Canonical-plan evidence: §4、§9、§10.4 明确保留现有 `title.txt`，§15 又明确“不改 `title.txt`”；因此该确认需求没有文件变更和 Provider system-body 验证。
- Responsibility owner: 现有 `packages/opencode/src/agent/prompt/title.txt`，无需新增 Agent 或第二份系统 Prompt。
- Concrete behavioral consequence: 实际 Provider 请求仍受旧的“≤50 characters”等规则约束，缺少 upstream 的标题风格及防执行指令，计划所称的 upstream Prompt parity 并未交付。
- Minimal correction direction: 用 upstream 2.2.5 的 `PROMPT_TITLE` 原位替换现有 `title.txt`，沿用同一 title Agent，并在真实 Provider body 验收中同时检查 upstream system Prompt 和单一材料 user 消息。

## Non-blocking findings

- `docs/plans/session-title-upstream-parity.md:266` 在 R1 中写着“R2 曾计划但未实施”，修订历史表述不一致，下一版应删除或澄清。
- §10.1 第 182 行称 Prompt 仍有明确字符上界，但 §20 第 374 行正确指出初始 `messagePrompt` 不截断首条消息；建议统一为有界重生成 Prompt、初始 Prompt 沿用 upstream 不设 2000/8000 上限。

## Rejected speculation

- 不要求搬移 upstream 的 primary-model retry、context-read fallback、usage/CAS；它们不是本次材料与 Prompt 修复的必要条件，且新增 fallback 违反仓库门禁。
- 不要求注入完整压缩前 transcript、增加任务回复分类器、额外重试或序列化媒体/tool output；upstream 的边界就是全历史首条真实用户加 latest active recent。
- 全历史读取的性能成本目前没有测量证据，不构成额外 blocker。
- 已直接检查 `D:\Temp\opencode\title-upstream-r1\test\session\prompt.resolved.test.ts:7278-7303`：该外部红测确实通过公开 `SessionPrompt.generateTitle` 和真实 Provider body 捕获缺失材料，并非私有 Prompt helper 的合成断言。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不复刻为仅 active window | §10.1 的全历史 original 加 active recent 方向正确，但 B-02 仍存在丢失 recent 的可达分支。 |
| 标题应是总结性标题，而非下一步任务回复 | 单一 `<message>/<conversation>` 材料消息和 closing instruction 能修复消息角色混淆；upstream 系统 Prompt 仍缺失，见 B-03。 |
| 手动与自动逻辑是否不同 | 计划正确还原了二者共用 `SessionPrompt.title`、仅触发 guard 和后台错误隔离不同的现状。 |
| 是否存在 token/消息隔离 | 计划正确区分了字符预算与 Provider token，并将原角色数组折叠为一个材料 user 消息。 |
| 按 upstream 2.2.5 完整检查与复刻 | 已独立核对精确 commit `9bbb8ce18c80f099e0e448775f59d965ead40a21` 的 `title.ts`、`history.ts`、`store.ts`、`plugin/agent.ts` 和 fallback predicate；B-01 至 B-03 尚未满足。 |
| 最小修改、先构建 Verify Plan | `approved-plan-only` 和单 owner 方向正确，但下一版必须纳入 `title.txt`、精确分支条件及模型锚点修复，不能以最小 diff 为由删除这些已确认行为。 |

## Primary-path and fallback verdict

计划选择现有 `SessionPrompt.title` 作为唯一修复 owner，保留一次 `llm.stream`，并拒绝 upstream 的错误后替代成功路径，符合 primary-path 方向。初始与重生成模板可以属于同一支持域内的两个正常分支，全历史 original 与 active recent 也是互补输入而非失败后替代来源。

但 B-01 改变了无关的模型选择语义，B-02 让部分重生成错误进入初始分支，B-03 漏掉同一 title Agent 的 upstream 系统 Prompt，因此当前 R1 不能按“单一且完整的 upstream 主路径”放行。

## Code quality and Chinese-comment verdict

文件范围和私有纯函数方向总体克制，无需新增 public API、Agent、依赖或第二套标题服务；下一版应直接修正现有分支和 Prompt 文件，避免增加兼容分支或模型 fallback。

计划估算 `E = 191`、`C ≥ 30`，目标比例约 `30 / 191 = 15.7%`，算术上满足 15% implementation target，且列出了与真实决策相邻的注释主题。当前为 plan audit，没有实际实现 diff，因此实际 `E`、 qualifying `C` 和比例均为 **N/A**；实施审计仍须重新逐行计算，不能用该估算替代。

## Release verdict

**BLOCK** — `docs/plans/session-title-upstream-parity.md` **R1** 不予批准，`Implementation allowed: no` 必须保持。完成 B-01 至 B-03 的修订、递增 revision 后，需要重新进行完整原始范围的独立 plan audit。

### Round 2 — R2 independent verdict（原样记录）

## Blocking findings

### B-01 默认标题与 `time.created` 来自两次时钟读取，精确 root-fallback 判断不可靠

- Violated invariant: INV-04、INV-07 及 §16 Slice 1 要求正常 root 默认标题的自动首轮使用 upstream `messagePrompt`；这要求本地创建出的默认标题能与该 Session 的创建时间精确对应。
- Evidence class: reachable
- Producer and execution path: `sessions.create()` → `createNext` 在 `title` 字段调用 `createDefaultTitle()`，内部读取一次 `Date.now()` → 随后为 `time.created` 再次调用 `Date.now()` → 自动 `prompt.loop` → `SessionPrompt.title` → 计划用 `createDefaultTitle(false, new Date(session.time.created))` 重建标题并比较。两次读取跨越毫秒或时钟调整时，比较失败并误入 `conversationPrompt`。
- Source evidence: `packages/opencode/src/session/session.ts:491-510` 分别在 `session.ts:500` 和 `session.ts:508` 生成标题与创建时间；`packages/opencode/src/session/title.ts:6-8` 当前默认标题自行读取当前时间；`packages/opencode/src/session/prompt.ts:1980-1985` 是自动标题入口。upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/util/src/session-title-fallback.ts:30-36` 的精确比较依赖一致的创建时间。
- Canonical-plan evidence: §10.3 使用 `session.time.created` 重建精确默认标题；§15 明确 `createDefaultTitle` 的“现有调用不变”，没有修改 `session.ts` 的生产者；§16 Slice 1 却要求自动首轮稳定得到 `<message>`。
- Responsibility owner: `Session.createNext` 的默认标题/创建时间生产职责；`SessionPrompt.title` 只消费这份身份事实。
- Concrete behavioral consequence: 正常新 Session 的自动首轮可能使用 `<conversation>` 而非 upstream 的 `<message>`，计划的自动首轮精确模板测试也会随时钟时序失败，因而无法保证所声明的 upstream parity。
- Minimal correction direction: 在创建 owner 让新 Session 的默认标题与 `time.created` 共用同一个 `created` 值，将 `session.ts` 纳入最小文件计划并增加确定性的跨毫秒创建回归测试；保留精确比较，不退回宽泛时间戳正则。

### B-02 “压缩前存在原始请求、active 无真实用户”的新支持路径没有行为验收

- Violated invariant: INV-01、INV-06 以及 §10.1 第 4–5 步：压缩前原始请求本身可以构成材料，active 无真实用户时使用 `currentModel`；该确认行为必须有 behaviorally sensitive verification。
- Evidence class: contracted
- Producer and execution path: 真实用户消息 → 完成压缩且 retained active window 只剩 compaction marker/summary → 手动 `generateTitle` → 当前 `prompt.ts:496-501` 因 active 无真实用户返回 `no_user_message` → R2 改为从全历史取得 original 并走 `currentModel`。这是 upstream 已支持、R2 明确新增的可执行分支，但现有及计划测试没有直接覆盖它。
- Source evidence: `packages/opencode/src/session/prompt.ts:496-503` 是当前首个失败点；`packages/opencode/test/session/prompt.test.ts:7238-7301` 的主压缩用例仍加入两个 active 真实用户；`prompt.test.ts:7303-7385` 的 compaction-only 失败用例没有任何压缩前真实用户，不能证明新分支成功。upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/core/src/session/title.ts:105-132` 先独立读取 `firstUser`，recent 为空仍能构造 original。
- Canonical-plan evidence: §10.1 第 4–5 步和 §14 的 `currentModel` 概念明确了该新分支；§13 只列出“旧模型/active 新模型”及既有失败回归；§16 Slice 2 有两个 active 用户，Slice 3 的红测是 active 新模型，“active 无 real”仅出现在 regression-protected 备注中，没有独立红行为和 Provider body 断言。
- Responsibility owner: `SessionPrompt.title` 的 original-only 材料分支及其 `generateTitle` 公共行为测试。
- Concrete behavioral consequence: 实现可以仍在这一核心场景返回 `no_user_message`、发送错误材料或选择旧模型，而所有已明确映射的测试保持绿色；这正是用户要求摆脱“只有 active window”的边界之一。
- Minimal correction direction: 增加一个经公共 `generateTitle` 的 red-green 用例：压缩前存在真实用户、完成压缩后 active 无真实用户，断言请求包含全历史 original、使用当前 Session 模型且不包含技术 marker；同时保留“全历史也无真实用户”的既有失败用例。

## Non-blocking findings

- §7 第 128 行将 INV-09 与 INV-10 合并在同一个表格行，导致 INV-09 缺少独立 Evidence/Test 单元格。这是文档记录问题，可在下一次实质修订时一并修正，不单独构成放行阻塞。
- §10.2 可在文本投影规则中直接写明 upstream 的 `trim()`、空文本过滤和 `join("\n\n")` 细节，减少实施时对“精确复刻”的自由解释；现有 upstream 引用足以确认正确行为。

## Rejected speculation

- 不要求注入完整压缩前 transcript；upstream 的边界就是全历史首条真实用户加 latest active recent。
- 不要求新增“下一步回复”分类器、关键词过滤、额外重试或失败后换 Prompt；这些会形成无依据的第二算法或 alternate success path。
- 不要求搬移 upstream 的 context-read fallback、primary-model retry、usage accounting 或事件 CAS；它们不是本次材料与 Prompt 首个分歧的必要修复。
- 不要求序列化媒体字节、reasoning 或 tool output，也不要求为首条用户新增 SQL/public API；现有 `Session.messages` 已能提供所需历史。
- 全历史读取尚无测量到性能回归，不以性能猜测要求新的存储接口。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不复刻为仅 active window | 全历史 original 加 active recent 的方向正确，但 B-02 使 original-only 核心分支缺少验收。 |
| 生成总结性标题，而非下一步任务回复 | §10.4 的 upstream `PROMPT_TITLE` 与 upstream `plugin/agent.ts:19-37` 一致；单一材料 user、`<message>/<conversation>` 和 closing instruction 能直接修复角色混淆。 |
| 手动与自动逻辑是否不同 | 计划正确还原了共用 `SessionPrompt.title`、仅自动触发 guards 和后台错误隔离不同的现状。 |
| 是否存在 token/消息隔离 | 正确区分了字符预算与 Provider token；2000/8000 的计算与 upstream 一致，且改为一个材料 user 消息。 |
| 完整检查并复刻 upstream 2.2.5 | 两个模板、recent tail、原始请求截断和 system Prompt 已直接核对；B-01 的本地生产者差异仍未解决。 |
| 最小修改、先构建 Verify Plan | `approved-plan-only`、单 owner 和无新 API 的方向正确；修复 B-01 需要把现有 `session.ts` 纳入最小范围，B-02 只需补足行为测试。 |

## Primary-path and fallback verdict

计划仍以现有 `SessionPrompt.title` 为唯一标题算法，保持一次 `llm.stream`，没有新增失败后替代成功路径。初始与重生成模板属于同一支持域内的正常分支，全历史 original 与 active recent 是互补输入而非 fallback。

拒绝 upstream 的错误后重试和 context-read fallback 符合仓库门禁。当前阻塞点是默认标题生产事实不兼容，以及新支持分支缺少验证，不需要引入任何新 fallback 来解决。

## Code quality and Chinese-comment verdict

复用现有 `Session.messages`、`filterCompactedEffect`、title Agent 和 `createDefaultTitle` 的方向克制，私有纯函数与文本投影有实际复杂度依据，没有新增第二套标题服务、配置或依赖。

计划估算 `E = 247`、`C = 38`，目标比例为 `38 / 247 ≈ 15.4%`，满足 15% implementation target；列出的注释主题与精确分支、模型锚点、材料边界和字符预算相邻。当前为 plan audit，实际 `E`、qualifying `C`、排除行和实际比例均为 **N/A**，实施审计必须重新计算。

## Release verdict

**BLOCK** — `docs/plans/session-title-upstream-parity.md` **R2** 不予批准，`Implementation allowed: no` 必须保持。完成 B-01、B-02 并递增 revision 后，需要重新进行完整原始范围的独立 plan audit。

### Round 3 — R3 independent verdict（原样记录）

## Blocking findings

### B-01 原任务的用户级 system 指令仍会进入标题请求

- Violated invariant: INV-10 及原始需求中的消息隔离要求：标题请求应只包含 title Agent 的 upstream system 指令和单一材料 user 消息，原任务的用户级 system 不得继续参与标题生成。
- Evidence class: reachable
- Producer and execution path: 公开 prompt/promptAsync payload 接收 `system` → `createUserMessage` 将其持久化为 `User.system` → 自动首轮或手动 `generateTitle` 进入 `SessionPrompt.title` → 当前及 R3 保留的 `user: firstInfo` 被传给 `llm.stream` → `LLMRequest.prepare` 将 `input.user.system` 追加到 title Agent prompt 后。R3 只替换材料消息和 `title.txt`，没有切断这条路径。
- Source evidence: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:112` 与 `packages/opencode/src/session/prompt.ts:2526` 证明公开 payload 包含 `system`；`packages/opencode/src/session/prompt.ts:1068-1081` 持久化该字段；`packages/opencode/src/session/prompt.ts:538-549` 将 `firstInfo` 传给标题请求；`packages/opencode/src/session/llm/request.ts:68-75` 把 `input.user.system` 加入 system。upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/core/src/session/title.ts:71-76` 只发送 `input.agent.system` 和一个材料 user 消息。
- Canonical-plan evidence: §10.4 仅规定单材料消息和替换 `title.txt`，没有要求标题请求排除 `user.system`；§6 的支持域未覆盖该公开输入；§16 Slice 2 的 system 精确验收没有包含携带冲突 `user.system` 的输入，因此实现可以保持现状并通过全部计划测试。
- Responsibility owner: `SessionPrompt.title` 的标题专用请求构造；通用 `LLMRequest.prepare` 仍必须为正常主回复保留 `user.system`，不能全局删除该行为。
- Concrete behavioral consequence: 用户传入诸如“回答任务并给出下一步”的 system 时，该指令仍会以更高优先级进入标题请求，使 R3 修复后仍可出现用户报告的“下一步怎么做”式输出；同时 Provider system body 也不再精确等于 upstream 标题 system。
- Minimal correction direction: 在 `SessionPrompt.title` 内保留现有模型锚点但构造不携带 `system` 的标题请求用户身份，并增加经公共入口的 red-green 测试，断言冲突 `user.system` 不进入标题 Provider body、正常主回复仍保留该字段。

## Non-blocking findings

无。

## Rejected speculation

- 不要求增加“下一步回复”分类器、关键词过滤、额外重试或失败后替换 Prompt；这些会形成无依据的第二算法。
- 不要求注入完整压缩前 transcript；全历史首条真实用户加 active recent 已符合本次 upstream 材料边界。
- 不要求复制 upstream 的 context-read fallback、primary-model retry、usage accounting 或事件 CAS；它们不是本次材料与 Prompt 修复的必要条件。
- 不要求为首条用户新增 SQL/public history API；现有 `Session.messages` 已能提供按时间排序的全历史读取。
- 不要求把字符预算改为精确 Provider token 计数；upstream 的 2000/8000 本身就是字符上限。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不复刻为仅 active window | §10.1 使用全历史 original 加 active recent，并为 active 无真实用户的 original-only 分支安排了公共入口验收，覆盖完整。 |
| 生成总结性标题，而非下一步任务回复 | 单一 `<message>/<conversation>` 材料、closing instruction 和完整 `PROMPT_TITLE` 方向正确，但 B-01 使冲突任务指令仍可绕过这套隔离。 |
| 手动与自动逻辑是否不同 | 计划正确还原了二者共用 `SessionPrompt.title`，差异仅在自动 guards、显式模型参数和后台错误隔离。 |
| token／消息隔离 | 2000/8000 字符预算、recent tail 和单材料 user 消息映射完整；用户级 system 隔离缺失，见 B-01。 |
| 完整检查并复刻 upstream 2.2.5 | 已直接核对 pinned commit 的两个模板、文本投影、预算、精确 root fallback、标题 Agent Prompt 和请求 system；除 B-01 外，主要材料路径一致。 |
| 最小修改、先构建 Verify Plan | `approved-plan-only`、六个既有实施文件、无新 API/依赖/Agent 的范围克制；所需修正仍可留在现有 `prompt.ts` 与测试中。 |

## Primary-path and fallback verdict

计划维持一个 `SessionPrompt.title` 算法和一次 `llm.stream`。初始与重生成模板属于同一支持域的正常分支；全历史 original 与 active recent 是互补输入；active 无真实用户时使用 `currentModel` 是新支持分支的模型解析，不是失败后的备用成功路径。

未发现新增 alternate success path。拒绝 upstream 的错误后替代路径符合仓库门禁，但 B-01 使当前主路径仍未完整实现用户要求的标题隔离。

## Code quality and Chinese-comment verdict

文件范围、现有 owner 复用和私有文本投影设计总体克制，无需新增配置、public API、依赖或第二套标题服务。所需 system 隔离应在标题请求 owner 内完成，不应改变通用主回复请求行为。

R3 估算 `E = 295`、`C = 45`，目标比例为 `45 / 295 ≈ 15.3%`，算术上满足 15% implementation target，注释主题也与真实决策相邻。当前为 plan audit，实际 `E`、qualifying `C` 和比例均为 **N/A**；修订及实施审计必须重新计算。

## Release verdict

**BLOCK** — `docs/plans/session-title-upstream-parity.md` **R3** 不予批准，`Implementation allowed: no` 必须保持。修复 B-01、递增 revision 后，需要重新进行完整原始范围的独立 plan audit。

### Round 4 — R4 independent verdict（原样记录）

## Blocking findings

### B-01 混合真实／合成消息仍会把工具指令和附件正文注入标题材料

- Violated invariant: INV-06、INV-09 及原始需求的消息隔离要求：标题材料应复刻 upstream 的用户请求与助手文本，不能把本地展开的 synthetic 指令、Read 调用或附件正文当作用户原话。
- Evidence class: reachable
- Producer and execution path: 公开 `SessionPrompt.prompt` 接收文本与 file/agent parts → `resolveUserPart` 为文本附件生成 `synthetic: true` 的 Read 调用和文件正文，为 agent part 生成调用 task tool 的 synthetic 指令 → `Session.messages` 返回同一用户消息中的这些 parts → 计划仅排除 `ignored` 文本和 **synthetic-only 整条消息** → 混合消息中的 synthetic 文本进入 original/recent 标题材料。
- Source evidence: `packages/opencode/src/session/prompt.ts:494-495` 明确让含任一真实 part 的混合消息通过 real-user 判定；`packages/opencode/src/session/prompt.ts:1200-1216` 生成 synthetic Read 调用及附件正文；`packages/opencode/src/session/prompt.ts:1386-1400` 生成 synthetic task-tool 指令。`packages/schema/src/v1/session.ts:122-128` 证明 `synthetic` 与 `ignored` 是两个独立字段。upstream `9bbb8ce18c80f099e0e448775f59d965ead40a21:packages/core/src/session/title.ts:108-124` 使用 `firstUser.text` 和普通 user/assistant 文本，不包含这些本地 synthetic 展开内容。
- Canonical-plan evidence: §10.2，`docs/plans/session-title-upstream-parity.md:241-244` 只要求“非 ignored text parts”，同时仅排除 synthetic-only 消息；§16 Slice 7（第 377 行）也只有 synthetic 失败合同，没有混合真实／synthetic 的 Provider-body 验收。
- Responsibility owner: `SessionPrompt.title` 的标题文本投影；无需改变 real-user guard、通用消息转换或持久化。
- Concrete behavioral consequence: 带附件或 agent mention 的正常请求会把文件正文、“call the task tool”等非标题材料送入模型；这些内容可能盖过真实请求，重新引入任务执行式标题，并使初始 `messagePrompt` 意外携带大段附件文本。即使剥离 `user.system`，该隔离漏洞仍存在，因而不满足 upstream 文本边界和用户报告的原始症状。
- Minimal correction direction: 在同一文本投影中只保留非 `synthetic`、非 `ignored` 的用户文本，保留现有 real-user 与 subtask-only 合同，并增加一个经公共 `generateTitle` 的混合消息测试，断言真实文本存在而 synthetic Read/agent 指令及附件正文不存在。

## Non-blocking findings

- §18.2 的 `git diff --check` 只能验证 whitespace，不能证明“只允许第 15 节文件”。实施证据应另记录 `git status` 或 `git diff --name-only`；这是验证记录修正，不影响当前方案的可执行性。

## Rejected speculation

- 不要求注入完整压缩前 transcript；upstream 的边界就是全历史首条真实用户加 latest active recent。
- 不要求增加任务回复分类器、关键词过滤、额外重试或失败后替换 Prompt。
- 不要求复制 upstream 的 context-read fallback、primary-model retry、usage/CAS，也不要求新增专用 SQL/public history API。
- 不把字符预算改为 Provider token 计数，也不以未测量的全历史读取成本要求重新设计存储接口。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不只使用 active window | 全历史 original、active recent 及 original-only 公共入口验收均已映射。 |
| 生成概述性标题而非下一步回复 | upstream system Prompt、单一材料消息、closing instruction 和 `user.system` 隔离方向正确；B-01 仍允许 synthetic 指令绕过这层隔离。 |
| 手动与自动逻辑是否不同 | 计划正确还原了二者共用 `SessionPrompt.title`，差异在自动 guards、调用参数和后台错误隔离。 |
| token／消息隔离 | 2000/8000 字符预算、recent tail 和单材料 user 消息符合 upstream；混合 synthetic parts 的文本边界不完整。 |
| 完整检查并复刻 upstream 2.2.5 | 已直接核对 pinned commit 的标题材料、模板、预算、精确 root fallback、title Agent Prompt 和 upstream 测试；B-01 尚未满足。 |
| 最小修改并先完成 Verify Plan | `approved-plan-only`、六个既有实施文件、无新增 API/依赖的范围克制，所需修正仍可留在现有投影与测试中。 |

## Primary-path and fallback verdict

计划维持一个 `SessionPrompt.title` 算法和一次 `llm.stream`。初始与重生成模板是同一支持域内的正常分支；全历史 original 与 active recent 是互补输入；active 无真实用户时使用 `currentModel` 也不是失败后的备用成功路径。

未发现新增 alternate success path。拒绝 upstream 的错误后替代路径符合仓库门禁；当前阻塞属于标题材料边界不完整，不需要引入任何 fallback。

## Code quality and Chinese-comment verdict

复用现有 `Session.messages`、`filterCompactedEffect`、title Agent 和 `createDefaultTitle` 的方向克制。B-01 可通过收紧现有纯文本投影并补一个行为测试解决，无需新模块、配置或第二套标题服务。

计划估算 `E = 327`、`C ≥ 50`，`ceil(327 × 0.15) = 50`，目标比例约 **15.3%**，满足 15% implementation target。估算排除了 imports、formatter、文档和 pure moves；实际实施仍须重新逐行计算。

当前为 plan audit，实际 `E`、qualifying `C`、排除行及实际比例均为 **N/A**。

## Release verdict

**BLOCK** — `docs/plans/session-title-upstream-parity.md` **R4** 不予批准，`Implementation allowed: no` 必须保持。修复 B-01、递增 revision 后，需要重新进行完整原始范围的独立 plan audit。

### Round 5 — R5 independent verdict（原样记录）

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- 不要求注入完整压缩前 transcript；upstream 2.2.5 的边界是全历史第一条真实用户请求，加上 latest active window 的近期文本。
- 不增加“下一步回复”分类器、关键词过滤、额外生成重试或失败后替换 Prompt；这些会形成没有需求依据的第二套标题算法。
- 不复制 upstream 的 context-read fallback、primary-model retry、usage accounting 或事件 CAS；它们不是本次标题材料与 Prompt 修复的必要条件，其中错误后替代成功路径还违反仓库门禁。
- 不将 upstream 的 `2000` 和 `8000` 字符预算改成 Provider token 计数，也不要求序列化媒体字节、reasoning 或 tool output。
- 不为标题读取新增专用 SQL/public history API；现有 `Session.messages` 已提供按时间排序的全历史读取，见 `packages/opencode/src/session/session.ts:853-870`。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不应只使用 active window | 已覆盖。R5 §10.1 通过 `Session.messages` 取得全历史第一条真实用户，并将其与 `filterCompactedEffect` 提供的 active recent 组合。active 没有真实用户时，也能使用压缩前 original，而不是继续返回 `no_user_message`。 |
| 标题应是总结性、概述性标题，而非下一步任务回复 | 已覆盖。§10.2–10.4 复刻 upstream 的 `<message>`、`<conversation>`、`Reply with only the title.` 以及完整 `PROMPT_TITLE`，明确“name, not answer or carry out”。现有 `title.txt` 将原位替换，不会并存第二份系统 Prompt。 |
| 手动 Generate 与自动标题逻辑是否不同 | 已还原。两者共用 `SessionPrompt.title`，见 `packages/opencode/src/session/prompt.ts:481-575`；自动路径仅额外具有 parent/default/exactly-one guards、显式模型参数和后台错误隔离，见 `prompt.ts:1975-1985`。 |
| 是否进行了 token／消息隔离 | 已覆盖。原来“固定标题消息加原角色消息数组”会保留可执行任务角色；R5 改为单一材料 user 消息，并保留 upstream 字符预算。标题请求还通过 `system: undefined` 去除持久化的 `User.system`，避免它经 `packages/opencode/src/session/llm/request.ts:68-75` 重新进入标题 system；正常主回复路径不变。 |
| 完整检查并复刻 upstream 2.2.5 | 已直接核对 v2.2.5 的 `session/title.ts`、`session/history.ts`、`session/store.ts`、`plugin/agent.ts`、`session-title-fallback.ts` 和 `packages/core/test/session-title.test.ts`。两个模板、文本投影、2000/8000 字符预算、recent tail、精确 root fallback 及完整系统 Prompt 均已映射。压缩摘要、本地模型选择、错误映射和标题写回保留现有合同，属于必要的本地适配。 |
| 最小修改并先构建 Verify Plan | 已满足。计划保持 `approved-plan-only`，只修改六个既有实施文件，不增加 public API、依赖、配置、Agent 或数据库迁移。创建时间共享修改位于真实生产者 `Session.createNext`，不是下游兼容补丁。 |
| 行为验证 | §16 覆盖自动首轮、手动重生成、original-only、压缩前后模型切换、混合 real/synthetic parts、用户 system 隔离、精确默认标题分支和字符预算。现有外部红测通过公共 `generateTitle` 与真实 Provider HTTP body 捕获当前缺陷，而非测试私有 Prompt helper。 |

## Primary-path and fallback verdict

计划维持一个 `SessionPrompt.title` 标题算法和一次 `llm.stream`：

- root 精确默认标题使用 `messagePrompt`，其他重生成使用 `conversationPrompt`，属于 upstream 同一支持域内的正常分支。
- 全历史 original 与 active recent 是互补输入，不是失败后的替代来源。
- active 没有真实用户时使用 `currentModel`，是新支持场景的唯一模型解析路径，不是 Provider 失败后的备用成功路径。
- 旧的首条截断、固定标题前缀加原角色展开、独立 subtask 消息算法均被删除或折叠，没有保留竞争实现。
- 新增 alternate success path 为 **0**，新增 diagnostic side-path 为 **0%**。

根因修复位于标题材料与请求表示的所有者，默认标题时间身份则由实际创建者修复，符合 primary-path 与责任归属门禁。

## Code quality and Chinese-comment verdict

文件范围和职责划分克制。计划复用现有 `Session.messages`、`filterCompactedEffect`、title Agent、`currentModel` 和 `createDefaultTitle`，没有新增浅包装模块、无依据 abstraction 或生产测试专用路径。

计划估算：

- `E = 367`，其中生产代码及 Prompt 约 121 行，测试及 fixture 约 246 行。
- `C ≥ ceil(367 × 0.15) = 56`。
- 目标比例约为 `56 / 367 = 15.3%`，满足 15% implementation target。
- 注释主题与精确 root fallback、共享创建时间、全历史/active 职责、模型锚点、逐 part 隔离、用户 system 隔离和字符预算等真实决策相邻。

当前为 plan audit，实际 `E`、qualifying `C`、排除行及实际比例均为 **N/A**；实施审计必须根据实际 diff 重新逐行计算。

## Release verdict

**APPROVE** — `docs/plans/session-title-upstream-parity.md` **R5** 通过完整原始范围的独立 plan audit。

本结论仅适用于当前 **R5**。主代理可原样记录本次 verdict，并仅进行行政审批字段更新：`Status: approved`、`Approved revision: R5`、`Implementation allowed: yes`。任何实质设计变更都需要递增 revision 并重新进行 full-scope audit。

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

按用户授权的 R5 完成实施；设计范围、revision 和 approved revision 均未改变。

### Actual Files and Diff

| File | Raw added / deleted | Effective `E` | Responsibility |
| --- | ---: | ---: | --- |
| `packages/opencode/src/session/prompt.ts` | 70 / 18 | 49 | original/recent、模型锚点、文本投影、模板、预算与标题专用请求 |
| `packages/opencode/src/session/session.ts` | 4 / 2 | 3 | 共享默认标题与 `time.created` 的创建值 |
| `packages/opencode/src/session/title.ts` | 4 / 3 | 2 | 可注入创建时间的默认标题纯函数 |
| `packages/opencode/src/agent/prompt/title.txt` | 16 / 40 | 14 | upstream `PROMPT_TITLE` 原位替换 |
| `packages/opencode/test/session/prompt.test.ts` | 309 / 63 | 262 | 公共入口与 Provider body 行为验收 |
| `packages/opencode/test/lib/llm-server.ts` | 2 / 1 | 1 | upstream 共用 closing 的标题 fixture 识别 |
| **合计** | **405 / 127** | **331** | 生产 raw 94/63、测试 raw 311/64，均低于 600/800 上限 |

另修改唯一 canonical plan 以记录目标、实施证据和审计结果；无新增 production/test 文件、依赖、配置、public API、generated file、junction 或符号链接。

### Red-Green Test Evidence

以下测试均从 `packages/opencode` 运行，使用公共 `SessionPrompt.generateTitle` / 自动 `prompt.loop` 与真实 TestLLMServer HTTP body。

| Slice | 实际 red | Minimal green 与回归 |
| --- | --- | --- |
| 创建时钟 | `default title shares the exact session creation timestamp` 期望 `.002Z`、实际 `.000Z` | `createNext` 共享 `created` 后 1 pass |
| 自动首轮 | `automatic title generation preserves the default first-turn behavior` 红在旧 title system | 原位 upstream Prompt 与单一 `<message>` 后通过，自动 guards/主回复相关 6 pass |
| 用户 system | `manual title generation excludes user system without changing the main reply` 实际捕获冲突指令进入标题 system | 标题专用用户副本剥离 system；修正测试对 `llm.inputs` 已解码 body 的读取后 2 pass |
| 混合 synthetic | `manual title generation excludes synthetic parts from mixed real user input` 实际包含 `Called the Read tool` | 逐 part 过滤 synthetic/ignored 后 2 pass，并验证持久化附件仍保留 |
| original + recent | 主压缩用例缺 old request、第二 active 用户、`<conversation>` 和 closing；相似时间戳用例缺 conversation/recent | 全历史 original + active recent 与单材料模板后标题相关 14 pass |
| active 无 real | `manual title generation uses the pre-compaction request without active real users` 红为 `no_user_message` | 全历史 original + `currentModel` 后 1 pass；全技术历史仍拒绝 |
| active 模型 | `manual title generation keeps the active model across compaction` 作为既有行为 characterization | original 旧模型、active 新模型与 original-only/currentModel 两组 2 pass |
| 支持域 | subtask-only 为既有行为 characterization；相似时间戳与 child 在 original+recent slice 先红 | subtask/相似时间戳/child 3 pass |
| 字符预算 | `manual title generation bounds context and preserves the latest recent text` 实测材料 10802 字符 | original 2000、完整材料 8000、recent tail 后 1 pass |

类型验证曾发现 active 空缺的 original 用户缺少 LLM 请求必需的 `model`；仅在该分支注入已解析的 `currentModel` 后 typecheck 与 original-only 行为均通过。最终 upstream 示例断言使用 `JSON.stringify(...).slice(1, -1)` 对齐 HTTP JSON 转义，避免把测试转义错误当成生产缺陷。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/session/prompt.test.ts --test-name-pattern "title generation" --timeout 30000` | `packages/opencode` | 最终 18 pass / 0 fail / 78 expect calls |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 147 pass / 15 skip / 0 fail / 766 expect calls，585.80s |
| `bun typecheck` | `packages/opencode` | 生产修复后通过；随后共享工作区出现并发 `test/config/config.test.ts` 类型错误 |
| `bun install --frozen-lockfile`，随后 `bun typecheck` | `D:\Temp\opencode\session-title-verify-r5\repo` 及其 `packages/opencode` | clean `git archive` + 仅本任务 6 文件副本中依赖安装成功，typecheck 通过 |
| `bun test test/session/prompt.test.ts --test-name-pattern "title generation" --timeout 30000` | 隔离目录 `packages/opencode` | 18 pass / 0 fail / 78 expect calls，104.18s |
| WSL Linux Bun 1.4.4 `bun run test:httpapi` | `packages/opencode` | 225 pass / 0 fail / 0 skip / 0 missing / 0 extra，328.571s；`session.generateTitle` 通过 |
| `git diff --check` | repository root | 通过，无 whitespace error；仅有并发文件的 LF/CRLF 提示 |

隔离验证通过普通 `git archive`、zip 解压与 `Copy-Item` 完成，没有 junction、符号链接或 git worktree 修改。并发 `config.ts` / `test/config/config.test.ts` 修改未纳入本任务 diff。

### Original Feedback-Loop Result

原仓库外 harness 目录在最终复跑前已被外部清理，直接路径不再存在。所有原始 red 场景已提升为仓库内同一公共 service/Provider seam 的行为测试，并在当前工作区及 clean archive 中均转绿；原始创建时钟、主压缩上下文、original-only、用户 system 与混合 synthetic 症状均有最终通过证据。

### Actual Secondary and Replacement Path Inventory

| Path | Actual classification | Result |
| --- | --- | --- |
| root 精确默认标题 `messagePrompt` | primary-contract supported-domain branch | 保留，自动首轮验证 |
| 其他标题/child `conversationPrompt` | primary-contract supported-domain branch | 保留，多轮/相似标题/child 验证 |
| 全历史 original + active recent | 两个既有 owner 的互补输入 | 无失败后替代来源 |
| active 空缺时 `currentModel` | 新支持场景的唯一模型解析 | 无 Provider 失败后重试 |
| 自动后台 `Effect.ignore` | 既有 best-effort compatibility | 未修改 |
| 首条截断、固定标题前缀加原角色展开、独立 subtask 消息算法、旧 fixture 识别、旧 title Prompt | superseded workarounds | 已删除或折叠，无竞争实现 |

新增 alternate success path 为 0，新增 diagnostic side-path 为 0%；仍是一次 `llm.stream`，无 context-read fallback、primary-model retry、usage/CAS、输出分类器或额外生成重试。

### Chinese Comment Calculation

统计使用 `git diff --unified=0` 的新增/实质修改行：排除空行、import-only、formatter-only、generated 和 pure-move；注释不计入代码 `E`。`C` 逐行检查中文解释是否邻近真实 invariant、边界、常量、测试意图或 compatibility，未将重复测试名和显然流程计入。

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | **331**（生产/Prompt 68，测试/fixture 263） | 排除 21 个空行、2 个 import-only 行；无 generated、formatter-only 或 pure-move 行 |
| Qualifying Chinese comment lines `C` | **51** | `prompt.ts` 17、`session.ts` 1、`title.ts` 2、`prompt.test.ts` 30、`llm-server.ts` 1 |
| Ratio `C / E` | **51 / 331 = 15.41%** | 高于 15% 门槛 |
| Required minimum `C` | **50** | `ceil(331 × 0.15) = 50` |

代表性注释包括共享创建时钟、全历史 original 与 active recent 的职责、active 模型锚点、逐 part synthetic 隔离、精确 root fallback、2000/8000 字符预算、用户 system 隔离，以及 Provider body 与持久化双向测试意图。

### Remaining Unverified Items

本批准范围无未验证项。共享工作区仍有其他 agent 的 config/Core 修改和一项并发 config 测试类型错误；本任务通过 clean archive 的独立 typecheck 与行为测试排除了这些并发修改对本 diff 的影响，未还原、覆盖或纳入它们。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R5 | yes | No blocking findings | 无 | APPROVE | `ses_e33af0dc6ffef6FUGQQcLkExZb` |

### Round 1 — R5 implementation verdict（原样记录）

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

## Rejected speculation

- 不要求注入完整压缩前 transcript；upstream 2.2.5 的边界是全历史第一条真实用户请求与 latest active window 近期文本。
- 不增加任务回复分类器、额外生成重试、primary-model fallback 或 context-read fallback；这些不属于本次材料与 Prompt 修复，并可能形成替代成功路径。
- 不将 2000/8000 字符预算改为 Provider token 计数，也不要求序列化媒体、reasoning 或 tool output。
- 不基于未测量的全历史读取成本要求新增 SQL 或 public history API。

## Requirement and traceability coverage

| 原始要求 | 审计结果 |
| --- | --- |
| 不只使用 active window | `prompt.ts:531-588` 从 `Session.messages` 选择全历史 original，并从 active history 构造 recent；压缩、original-only、后续用户及 summary 均有公共入口测试。 |
| 生成概述性标题而非任务回复 | `title.txt:1-20` 与 upstream 2.2.5 `PROMPT_TITLE` 一致；`prompt.ts:282-288` 复刻两个材料模板，`prompt.ts:600` 只发送一个材料 user 消息。 |
| 隔离原任务指令 | `prompt.ts:288-299` 逐 part 排除 synthetic/ignored 文本；`prompt.ts:593` 仅对标题请求移除 `user.system`，正常主回复路径保持不变。 |
| 保持手动与自动既有关系 | 两者仍共用 `SessionPrompt.title`；自动 parent/default/exactly-one guards、后台 `Effect.ignore`、错误映射和标题写回未被替换。 |
| 复刻 upstream 初始与重生成逻辑 | `prompt.ts:577-588` 实现 2000 字符 original、8000 字符 conversation、recent tail 和精确 root-fallback 分支；`session.ts:491-510` 保证默认标题与创建时间共享同一时钟值。 |
| 保持模型行为 | `prompt.ts:540-555` 保留 active 用户模型锚点；仅 active 无真实用户的新支持分支复用现有 `currentModel`，没有回读 original 旧模型或增加 Provider fallback。 |
| 最小修改及行数上限 | 生产/Prompt raw 94 增、63 删，合计 157 行，低于 600；测试 raw 311 增、64 删，合计 375 行，低于 800。实际改动文件与 R5 §15 一致。 |
| 行为验证 | 新测试通过公共 `generateTitle`/自动 `prompt.loop` 和真实 Provider HTTP body 观察行为，能够分别捕获旧版缺失 original/recent、旧 Prompt、多角色消息、用户 system 泄漏、synthetic 展开、错误模型及分离时钟。既有失败与 guard 测试未被削弱。 |

Canonical §23 记录：标题测试 18 pass、完整 Prompt 测试 147 pass / 15 skip、隔离环境 typecheck 通过、HTTP API 225 pass。本审计直接检查了相关测试与调用链，并独立复跑 `git diff --check`，结果通过；未独立重跑上述耗时测试和 typecheck。

## Primary-path and fallback verdict

实现维持一个 `SessionPrompt.title` 算法和一次 `llm.stream`：

- root 精确默认标题与其他标题/child 的两种模板是 upstream 同一支持域内的正常分支。
- 全历史 original 与 active recent 是互补输入，不是失败后的替代来源。
- active 空缺时使用 `currentModel` 是该支持场景的唯一模型解析路径。
- 旧首条截断、固定标题前缀加原角色展开、独立 subtask 消息算法及旧 Prompt 均已删除或折叠。
- 新增 alternate success path 为 **0**，新增 diagnostic side-path 为 **0%**。

修复位于标题材料、请求表示及默认标题创建事实的实际所有者，没有新增无依据 fallback、配置、依赖或 public API。

## Code quality and Chinese-comment verdict

代码符合本地 Effect、不可变数据、函数式数组处理及测试 fixture 约束。`completedCompaction` 被多处复用，不是一次性抽象；确定性时钟 mock 有直接回归依据，并在 `finally` 中恢复。

独立按 zero-context 实际 diff 重算：

- **E = 331**：生产/Prompt 68，测试/fixture 263。
- **C = 51**：`prompt.ts` 17、`session.ts` 1、`title.ts` 2、`prompt.test.ts` 30、`llm-server.ts` 1。
- **比例：51 / 331 = 15.41%**。
- 排除 21 个空行、2 个 import-only 行及全部中文解释注释；无 generated、formatter-only 或 pure-move 行计入。
- 15% implementation target 要求 `C ≥ 50`，10% audit floor 要求 `C ≥ 34`；实际同时满足两者。注释邻近模型锚点、材料边界、字符预算、system 隔离、创建时钟及行为测试意图。

## Release verdict

**APPROVE** — 当前实际 diff 符合 canonical plan **R5**、原始 upstream parity 要求、行数上限、行为验证、单一主路径及中文注释门禁。

本结论仅适用于本次审计的七个文件及其当前 diff，不覆盖工作区中的其他并发修改，也不构成 commit 或 push 授权。

The task may be marked `verified` only after a separately authorized implementation and an independent full-scope result of `No blocking findings` for the actual diff and approved plan revision.
