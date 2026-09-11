# Canonical Implementation Plan: Session Git 与日期上下文持久化

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: 本文 §1 的用户原文；2026-09-11 当前 Session 请求
>
> Implementation allowed: yes
>
> Last updated: 2026-09-11
>
> Delivery target: canonical-plan-only；用户明确要求本阶段不发起审计、不实施。

本文是本任务唯一 canonical plan。聊天摘要、旧调研和 builder 自述不是实施授权。本文完成不代表已经审批；下一位 Agent 必须先完成所需的独立放行流程。

## 1. Verbatim Requirement

用户的功能需求原文：

> 是的，它本质上就是两个东西，一个是这个 Git，Git 相关的内容应该去固定到相应的 Session 里面。但是请你看一下上游固定的一个方式。理论上来说，它是否要固……就是我本身不是特别希望直接在这个我们的存储里面去新建一个表，去把这个东西全部搬进去。就是你看一看有没有什么比较好的一个方法去进行处理。然后同时我也不希望在本地去、本地的工作区去写文件，因为这样的话会带来一些不必要的一些文件的创建，像是垃圾一样。那你看一看有没有什么比较好的方式去存到我们相应的这个数据库里面。然后与此同时，这个日期，那理论上来说，这个日期本质上也是需要进行相应的数据库的一个保存嘛。然后同时相应的这个跨日时追加更新，这个确实是可以去增加一个。所以你可以看一看这两个东西，按照上游的一个相应的改法，去看一看在本地去如何进行修改。

用户的阶段合同原文：

```text
# Session GOAL

## 参数

- **原始需求**：<逐字需求，或稳定 issue / specification 路径>
- **目标终态**：<approved-plan-only | verified-implementation | verified-implementation-and-commit>
- **Canonical plan**：<用户路径；否则按仓库约定，最终回退到 docs/plans/<task-slug>.md>

## GOAL 合同

- 跨 continuation 保持完整需求、范围和放行标准，不得缩小终态。
- skills 和文档按阶段即时加载，禁止开局一次性读取全部内容。
- 审计材料只由 `adversarial-auditor` subagent 加载；primary agent 不预读、不自审。
- 阶段加载的 policy、skill、template、仓库指令和 canonical plan 是权威依据。
- 仅在目标终态被当前证据逐项证明后标记 `complete`。同一真实阻塞在两个连续 eligible GOAL turns 中保持不变且无法继续推进时，才在第二次标记 `blocked`。

## 第一性门禁

- “完整”覆盖证据证明受影响的 interface、producer、consumer、调用链和行为映射，不等于扫描整个仓库。无法绕过的上游保证不得在下游重复实现，speculative 边界不得驱动代码或 blocking finding。
- 默认修复 primary path 的 first divergence。禁止 A -> B -> B1/B2/B3、平行实现、catch-and-success 和临时 fallback。只有用户原文明确要求时才允许精确 rollback，且不得成为失败后的备用成功路径。
- 必要增强可由 invariant、仓库规则、真实 compatibility、reachable safety risk 或 threat model 证明，无需逐字对应用户原句，但须归属正确 owner、保持必要范围并具备行为验证。speculative defense-in-depth 禁止。
- 门禁只约束行为、证据、owner 和验证，不规定函数数、文件数或代码结构。采用仓库最自然、内聚且足以承载需求和必要安全性的设计。
- 每个 production concept 必须映射到用户需求、既有 invariant、仓库规则或真实安全/兼容证据，并说明现有逻辑为何无法承载。diff 大小不能替代完整性判断。
- 只维护一个 canonical plan；聊天摘要、旧审计和 builder 自述不构成实施授权。

## 阶段 1：构建 Canonical Plan

### 此时加载

- `first-principles-planning`，并按其要求读取当前 policy、canonical template、`CONTEXT.md`、ADR 和适用的 `AGENTS.md`。
- bug、失败或性能回归在建立反馈信号时加载 `diagnosing-bugs`。
- 仅在设计 test seam 和 behavior slice 时加载 `tdd`。
- 不得加载 `adversarial-audit` 或 `approved-plan-implementation`。

### 产物和门禁

- 从当前仓库重新调查，不把旧方案或旧审计当作已确认事实。只创建或修订 plan，不修改 production、tests、config、migration 或 generated files。
- bug 类任务必须建立并实际运行能够捕获用户原始症状的 red-capable feedback loop。没有该信号时不得仅靠源码阅读猜根因，应继续构建信号或记录真实环境阻塞。
- 完成 template 各字段：evidence/domain/reachability、invariant/divergence/owner、route/paths/workaround、file/TDD/verification/diff、risks/speculation/audit/comments。
- forward mapping：requirement/invariant -> owner/path/file/test。reverse mapping：concept -> requirement/invariant/safety evidence + 不可复用原因。确认行为没有 executable path、行为测试或明确 unverifiable reason 时不得提交；引用位置、估算和重复证据不构成映射缺失。
- 完成后设置 `Status: audit-required`、`Approved revision: none`、`Implementation allowed: no`。
```

用户的交付与预算原文：

> 同时按照如上的这个合同进行。然后请注意，理论上来说，你需要负责的内容只是进行相应的完整 plan 的一个构建。同时这个 plan，理论上来说我们修改的文件数生产代码不超过八个文件，同时修改代码行数不超过1200行。那理论上来说，而且理论上来说，你需要完整考虑包括测试等等在内的一些完整全部的内容，就是需要适当地去保证之后不会发生相应的红测，或者说你新引入的一些测试不会发生红测。然后同时请注意最终你不需要进行相应的一个审计，就是你完成相应的完整的 plan 的一个构建就行。然后同时之后我会将其交给其他 agent 去完整完成。所以现在请你结合完整全面忠实于上游的一个修改的思想，还有上游的 schema 的一个相应的一个存储方式，因为本身我们后面将会迁移到上游的一个 schema。那所以你可以看一看，对于这两个，我们先利用上游的这个 schema 的一个格式进行相应的一个存储会比较好一点。然后请你完整去结合这些内容去进行一个 plan 的构建。plan 实施的内容理论上来说应该包含相应的 Git 以及相应的日期这两个内容。具体内容需要清晰写出，包括你需要修改的等等一些各种文件数啊，修改的文件范围等等内容。

## 2. Explicit Non-Goals

- 本轮不实施、不修改测试或 migration、不审计、不提交、不推送。
- 不新增数据库表；不使用工作区文件、`Storage.write()` JSON 文件或另一个数据库保存运行时上下文。
- 不迁移整个 v2 runner、EventV2、SystemContext registry、SDK 或公开 Message union。
- 不冻结模型身份、Agent 提示词、权限、工具集合、skills 或项目指令；这些内容仍按现有规则生效。
- 不实时刷新 Git 快照；工具执行 `git status` 的实时能力不变。
- 不改变 Goal、用户消息身份、任务完成、max-steps、授权及 compaction 总结提示词。
- 不承诺 provider 缓存 TTL、缓存路由或实际 cached-token 命中率；验证对象是本任务所拥有的请求内容稳定性。
- 不扩展跨机器 export/import 或事件重建的格式。当前数据库内同一 Session 的恢复属于本任务；导入缺少该字段的 Session 采用首次初始化规则。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 `AGENTS.md` | 最小内聚改动；从包目录运行测试与 `bun typecheck` |
| `packages/opencode/AGENTS.md` | Drizzle `.sql.ts` owner；标准生成 migration.sql + snapshot.json；Effect v4 规则 |
| `packages/opencode/test/AGENTS.md` | 使用 `testEffect`、scoped fixture；OS 集成 live 测试；不用 sleep 等待异步就绪 |
| `CONTEXT.md:9–11,33–49,179–181` | Session 为 SQLite 会话；工作树 Snapshot 与本方案上下文 snapshot 不混称；v1/v2 不假定等价 |
| `docs/adr/README.md` | 现有索引仅含 triage ADR，没有本任务的持久化决策；不新增无关 ADR |
| `.opencode/policy/first-principles-engineering.md` | 单一路径、实际 red、正反映射、15% 中文解释注释 |
| `.opencode/templates/canonical-plan.md` | 本文完整沿用 24 节结构 |
| `first-principles-planning`、`diagnosing-bugs`、`tdd`、`effect` | 按阶段加载；未加载 audit/implementation skill |

本任务重新读取了实际生产文件。`CONTEXT.md` 中版本与部分 v2 目录说明可能落后，不据此推断当前实现已经持久化上下文。

## 4. Files and Evidence Read

下文路径无前缀时相对于 `packages/opencode/`；上游固定版本为 `anomalyco/opencode@0b934e9516f8eda63cddcfb34ee6bd9a363d493d`，不是浮动 dev。

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `src/session/system.ts:174–347` | 唯一 environment 接口、cwd Map、Git 字段、日期生产者 | reachable |
| `src/session/prompt.ts:2520–2587,2850–3204,3434–3466` | canonical history、decide 选择、转换块缓存、估算、dispatch、依赖组装 | reachable |
| `src/session/message-v2.ts:1062–1174,1380–1413,1750–1964` | provider 转换、chunk 边界、hidden 与 compaction window、proof.boundary | reachable |
| `src/session/compaction-boundary.ts:1–80` | 已完成 compaction 的唯一判定 owner | reachable |
| `src/session/session.sql.ts:109–161,164–217,238–253` | 现有 Session 无通用 metadata；Message JSON 和 v2 表有专用语义 | reachable |
| `src/session/session.ts:56–140,623–674,795–847` | Session row 映射、创建、fork 为新 ID | reachable |
| `src/session/projectors.ts:100–159` | patch 不覆盖未列出的列；删除 session；fork 仅复制 message/part | reachable |
| `src/session/revert.ts:46–88,152–200` | cleanup 隐藏历史；unrevert 在 cleanup 前保留历史 | reachable |
| `src/session/run-state.ts` ensureRunning / runner / assertNotBusy | 既有每 Session orchestration，不再增加另一把 Agent-loop 锁 | reachable |
| `src/session/llm.ts:105–161,218` | system/instructions 与 history 分离；工具排序 | reachable |
| `src/storage/db.ts:31–44,95–169,179–220` | 既有 DB 路径、恢复、同步 immediate transaction、失败传播 | reachable |
| `src/storage/storage.ts:59–71` | Storage 是外部 JSON 文件，不能当作数据库 KV 使用 | reachable |
| `src/storage/schema.ts`、`drizzle.config.ts`、`package.json` | 表导出、迁移生成入口、Bun/类型检查命令 | contracted |
| `src/effect/instance-state.ts:15–19`、`src/project/instance-context.ts` | 最小复现调用实际环境服务所需的 context | reachable |
| `src/permission/index.ts:1–39`、`test/preload.ts:85–98` | 初次 inline probe 的循环导入问题；使用现有 projectors import 顺序解决 | observed |
| `test/session/system.test.ts` | 当前只覆盖路由与 skills，不覆盖环境持久性 | observed |
| `test/session/prompt.test.ts:1–150,3650–3709` | HTTP fixture、真实 SessionPrompt/RunState seam | reachable |
| `test/session/llm.test.ts:1–100` | provider 请求捕获 seam | reachable |
| `test/fixture/fixture.ts:1–220`、`bunfig.toml` | fixture 隔离、runtime reload、preload 清理 | contracted |
| `test/storage/db.test.ts`、`test/storage/workspace-time-migration.test.ts` | DB 路径和逐目录升级测试范例 | reachable |
| `migration/20260718230857_cold_storage_pack_v2/snapshot.json` | 标准生成元数据已有 2728 行 / 62904 bytes；见预算说明 | observed |
| `.opencode/references/effect-smol/packages/effect/src/DateTime.ts:830–857` | 已确认 `DateTime.nowAsDate`，可用 TestClock 控制 | contracted |
| 根 `node_modules/@ai-sdk/anthropic/src/convert-to-anthropic-messages-prompt.ts:126–132` | 真实 adapter 拒绝中途 system 消息 | reachable |
| 上游 `packages/core/src/system-context/index.ts` SourceSnapshot / Snapshot / Generation | `baseline: string` 与 namespaced `{value, removed?}` 格式 | contracted |
| 上游 `packages/core/src/system-context/builtins.ts` | `core/date`、toDateString、初始与增量文本 | contracted |
| 上游 `packages/core/src/session/sql.ts:168–175` | 上游独立表包含 baseline、snapshot、baseline_seq | contracted |
| 上游 `packages/core/src/session/context-epoch.ts:40–80` | 持久 baseline 复用、更新 snapshot 与事件、完成压缩后 replace | reachable |
| 上游 `packages/schema/src/session-message.ts:23–66` | System 编码为 id / type / text / time.created / optional metadata | contracted |
| §8 inline 命令输出 | 两个真实 environment 前缀差异的 red signal | observed |
| §18 定向基线输出 | 14 pass / 0 fail / 31 expect | observed |

搜索结论：`packages/` 下 `.environment(` 当前只有 `src/session/prompt.ts:2988` 一个生产调用点；测试中没有另一组 `environment` stub 需要保留旧签名。`SessionMessageTable` 被 `src/v2/session.ts`、`projectors-next.ts` 和搜索消费，不能挪作 v1 隐藏 KV。

## 5. Current Behavior

```text
SessionPrompt.runLoop
  -> 已有 canonical history / compaction proof / lastUser
  -> SystemPrompt.environment(model, tools)
  -> cwd-keyed service Map 或重新调用 Git
  -> 每次 new Date().toDateString()
  -> env + instructions + skills
  -> 请求估算、processor.process、LLM.stream
  -> provider 的 system / instructions 前缀
```

Map 没有 Session ID，没有数据库恢复。在同目录同服务中，新 Session 还可能读取旧 Session 首次采集的 Git。重建服务重新采集 Git，日期跨日直接变更前缀。现有注释“会话级快照”不符合实际生命周期。

v1 的 Message info 仅支持 user/assistant，`latest()`、Goal 和排队用户处理都依赖这个事实。为了日期伪造一个持久 user 消息会改变业务流程。把日期写进已发送的旧 user Part 则会改写历史前缀。两条路线均不采用。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 同一 DB 中已有/新建 Session | Session.create / get | 有 Session row 和 ID | runLoop -> environment | ContextEpoch | contracted |
| Git、非 Git、disableGit | InstanceContext / Flag / Git | 沿用当前分支和截断规则 | 当前 getGitContext | SystemPrompt | reachable |
| 服务/进程重建 | daemon 重启 | DB 保留，Map 不保留 | environment 再调用 | ContextEpoch | observed |
| 同目录不同 Session / fork | Session.create / fork | fork 生成新 ID，不复制 Session 私有字段 | 首次 request | ContextEpoch | reachable |
| 日期变化，包括一次跳过数日 | DateTime 当前本地日期 | 与上游相同的 toDateString 语义 | 每次 dispatch 前 prepare | ContextEpoch | contracted |
| 完成/失败 compaction | CompactionBoundary / proof | 只认已完成合法边界 | canonical window 更新 | 既有边界 owner + ContextEpoch | reachable |
| hidden / undo cleanup | SessionRevert | canonical visible window 已过滤 | prepare 的 anchor 可消失 | ContextEpoch | reachable |
| decide 裁剪 / plugin 删除消息 | 既有 selector/transform | 仅改变本次 projection，不应删 DB 日期记录 | conversion -> request | prompt projection | reachable |
| 首次并发采集 /同日重复 prepare | 多请求、不同服务实例 | 单实例已有 Runner；DB transaction 是跨实例持久边界 | 读取与提交之间可能重入 | ContextEpoch transaction | reachable |
| Anthropic 请求 | 已安装 SDK | 不允许分隔的 system 消息 | LLM.stream adapter | prompt projection | reachable |
| 旧数据库升级 | 标准 migration | 新列 NULL；旧记录没有快照 | 首次 post-upgrade request | ContextEpoch | contracted |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 同一 Session 首次采集的 Git 文本在重启、跨日、compaction、undo 后不重新采集 | 用户原文 | 缺失；T1/T4 |
| INV-02 | 新 Session 独立采集，不能继承 cwd Map；fork 作为新 Session 首次请求独立建立上下文 | Session ID owner + 用户原文 | 缺失；T2 |
| INV-03 | 同一上下文 generation 的 baseline 原文稳定；日期变化追加一次，重启后仍在同一位置且不重复 | 用户原文 + upstream epoch | 缺失；T3/T4 |
| INV-04 | Git、日期和更新记录在既有 DB 原子持久化，无新表、无运行时侧文件 | 用户原文 | 缺失；T1/T5 |
| INV-05 | baseline / snapshot 采用上游结构；本地顺序适配明确标识，不伪造 v2 event sequence | 用户迁移意图 + schema | 缺失；T5 |
| INV-06 | 日期不能成为新的业务 user turn，不能拆开 tool-call/result，也不能触发 Anthropic system 错误 | 当前 Message/Goal/adapter 合同 | 部分现有转换测试；T3/T6 |
| INV-07 | compaction、undo、decide 后当前日期仍可见，失效历史不得被日期记录复活 | 已有 window owner | 部分已有 compaction 测试；T4/T6 |
| INV-08 | DB 失败不能退回内存/实时值；初始化竞争只采用数据库最终胜出的值 | 持久性要求 + transaction 合同 | 缺失；T5 |
| INV-09 | 新增更新在实际 token 估算中只计一次；复用现有转换块、不重转整个稳定历史 | 现有 prompt 热路径 | 缺失；T6 |
| INV-10 | 生产变更文件 <=8，代码含测试预算 <=1200；不改无关工作区 | 用户原文 | 实施 diff 门禁 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/02/04 | environment 第一次获取 Git 时只以 cwd 查 Map，丢失 Session 归属及持久恢复能力 | SystemPrompt.environment / Session context persistence | system.ts:174,189,242；下列 restart probe |
| INV-03 | 每次渲染 baseline 都读取当前日期，没有保存初始文本及变化位置 | SystemPrompt.environment | system.ts:314；下列 cross-day probe |

已运行的最小 feedback loop，cwd=`packages/opencode`，Bun 1.3.14；仅执行内联代码，没有创建测试或诊断文件。Git 是可控的外部采集边界；environment 的实际实现未替换。重建 Effect layer 模拟丢失服务内存，同服务跨日单独比较。它证明服务输出差异，不冒充真实 provider cache 命中测量。

```powershell
bun -e 'import "./src/server/projectors"; import { Effect, Layer } from "effect"; import { SystemPrompt } from "./src/session/system"; import { Git } from "./src/git"; import { Skill } from "./src/skill"; import { InstanceRef } from "./src/effect/instance-ref"; let status = "before.ts"; const OriginalDate = Date; let day = "2026-09-11T12:00:00"; globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [day])); } }; const deps = Layer.mergeAll(Layer.mock(Skill.Service, {}), Layer.mock(Git.Service, { branch: () => Effect.succeed("dev"), defaultBranch: () => Effect.succeed({name:"dev"}), status: () => Effect.succeed([{code:" M",file:status}]), run: () => Effect.succeed({text:()=>"fixed"}) })); const model = {api:{id:"gpt-6-astra"},providerID:"openai"}; const ctx = {directory:process.cwd(),worktree:process.cwd(),project:{vcs:"git"}}; const run = (f) => Effect.runPromise(Effect.gen(function*(){return yield* f(yield* SystemPrompt.Service)}).pipe(Effect.provide(SystemPrompt.layer.pipe(Layer.provide(deps))),Effect.provideService(InstanceRef,ctx))); const first = await run(s => s.environment(model,[])); status="after.ts"; const restarted = await run(s => s.environment(model,[])); const gitEqual=JSON.stringify(first)===JSON.stringify(restarted); console.log("RESTART_PREFIX_EQUAL",gitEqual); const dates = await run(s => Effect.gen(function*(){const a=yield* s.environment(model,[]); day="2026-09-12T12:00:00"; const b=yield* s.environment(model,[]); return [a,b]})); const dateEqual=JSON.stringify(dates[0])===JSON.stringify(dates[1]); console.log("CROSS_DAY_PREFIX_EQUAL",dateEqual); globalThis.Date=OriginalDate; process.exitCode=gitEqual && dateEqual ? 0 : 1;'
```

Observed result：`RESTART_PREFIX_EQUAL false`、`CROSS_DAY_PREFIX_EQUAL false`，exit 1，3.364 秒。首次尝试未导入 projectors 时遭遇 `Cannot access 'Ruleset' before initialization`，不算本问题的 red；沿用 preload 的模块入口后得到上述实际信号。

正式实施将这个行为迁入 T1/T3，适配新的 mandatory Session 输入，并增加 T1 的真实文件数据库跨进程恢复。不能保留旧接口作为让 probe 继续运行的 fallback。原命令仅是 R1 诊断证据。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| Git 采集和现有环境布局 | SystemPrompt | 生成模型环境说明 | 当前已有 Git/Shell/model 依赖 | 不下沉到数据库，不复制 Git 实现 |
| snapshot 初始化、日期比较、原子保存 | 新 `session/context-epoch.ts` | 给 Session 返回权威 baseline 与更新记录 | 真实持久化/生命周期边界 | cwd Map 和 token cache 无法承载 |
| compaction/hidden window | 现有 MessageV2 / CompactionBoundary | 提供有效历史及 boundary | 已有唯一判断 | ContextEpoch 只消费结果，不另扫描/判定 compaction |
| 更新插入与请求估算 | SessionPrompt | 生成模型实际输入 | 已拥有 canonical IDs、selection 和 conversion chunks | LLM adapter 不认识 MessageID 或 Session 历史 |
| SQLite DDL | session.sql.ts + 标准 migration | 升级旧数据库 | 现有存储 owner | 不运行时 ALTER、不用私有文件 |

测试 seam 在本文提议为 SystemPrompt.environment、SessionPrompt.loop 的捕获请求、Session.create/fork/delete、真实 DB 升级/恢复。本文未新增测试；审批此 revision 时同时确认这些 seam，实施不能擅自改为 private helper 测试。

## 10. Single Approved Primary-Path Design

本节是待批准设计，当前 Implementation allowed 仍为 no。

### 10.1 存储格式与上游映射

在 `session` 表增加单个可空 JSON 列 `context_epoch`。不向公开 `Session.Info`、Patch 或 SDK 暴露它。列随 Session row 删除；普通标题/权限 patch 不覆盖它。

```ts
// 持久数据的说明性形状；实现使用 Effect Schema 和既有 branded MessageID。
{
  baseline: "Is directory a git repo: yes\n...\nToday's date: Fri Sep 11 2026",
  snapshot: {
    "smark/git": { value: "Is directory a git repo: yes\n..." },
    "core/date": { value: "Sat Sep 12 2026" }
  },
  boundary: "null",
  updates: [{
    after_message_id: "msg_...",
    message: {
      id: "msg_...",
      type: "system",
      time: { created: 1789200000000 },
      text: "Today's date is now: Sat Sep 12 2026"
    }
  }]
}
```

- `baseline` 为准确的模型可见 Git+初始日期文本，写入后普通日期更新不重渲染。SystemPrompt 只在 `<env>` 中施加固定两空格缩进，不保存整个模型/工具/权限提示词。
- `snapshot` 对齐上游 `Record<Key, {value: Json, removed?: string}>`；当前两来源都是字符串，没有来源删除，因此不增加 removed 行为。Git 使用本地命名空间 `smark/git`，日期使用上游 `core/date`。
- 日期 `message` 的编码字段对齐上游 `Session.Message.System`，时间是编码后的毫秒数；`after_message_id` 是本地 v1 顺序适配，不能混称上游字段。
- `boundary` 直接使用现有 `PromptWindowProof.boundary` 字符串。它是当前历史 generation 标识，不是模型版本或 token 上限。
- 不伪造 `baseline_seq: 0`：上游字段引用它自己的 event timeline，本地没有同一个 timeline。未来迁移可直接搬运 baseline/snapshot 和 System message 的 payload，但必须在迁移 owner 重新分配 v2 sequence 和消息 ID/锚点。本文不实施该未来迁移。
- snapshot 是最新比较状态；baseline 是初始渲染文本。两者语义与上游一致，不能拿更新后的 snapshot 日期去重写 baseline。
- `SessionMessageTable` 不用作隐藏 KV；它已有 v2 Message 消费者。现有 `Storage` 会创建 JSON 文件，也不使用。

### 10.2 唯一初始化及刷新入口

`SystemPrompt.environment` 改成一个 mandatory object 参数：`sessionID`、`model`、`registeredTools`、`history: {boundary, messageIDs}`。返回 `{system: string[], updates}`；仅有的生产 caller 同步修改，不保留无 Session 参数的兼容路径。

SystemPrompt 保留现有私有 Git 采集函数，删除全部 Map get/set。它将惰性的 Git Effect、`DateTime.nowAsDate` 取得的当前时间及 history 交给 `SessionContextEpoch.prepare`；后者不复制 Git 命令，不再引入一套 Effect runtime/service registry。

```text
canonical history/proof
 -> environment(Session ID, history, model, tools)
 -> 读取 session.context_epoch
 -> 仅 NULL 时在事务外采集 Git
 -> 同步 immediate transaction 内重读、解码、决定并保存
 -> 返回实际已提交的 baseline + updates
 -> 动态非持久环境 + baseline -> system
 -> 原有转换块 + 持久日期更新投影 -> messages
 -> 估算、dispatch
```

初始化规则：Session row 必须存在；NULL 表示新 Session 或升级前旧 Session，首次请求采集一次。并发采集者最终在短事务内重读，使用已胜出的值，绝不以本地候选覆盖已经持久化的 Git。事务内不运行 Git、不 await。格式解码使用 Effect Schema；坏数据或数据库失败按现有错误路径终止本次请求，不产生实时/内存替代结果。

同日且 boundary/历史未收缩时只读返回，不更新 Session time_updated，不让环境准备改变 Session 排序。不引入定时任务、每秒刷新、后台扫描或无限增长的进程缓存。

### 10.3 日期追加与原子性

按上游语义比较本地 `toDateString()`，不按 UTC 日期、不用固定 24 小时推算。当前日期与 snapshot 不同且无需重建 generation 时，在同一个 JSON 更新中追加一条 System 格式记录并推进 `snapshot['core/date'].value`；baseline 不变。一次跳过多日只追加当前日期，不补造未发生的请求。时区/系统时钟使日期后退时也以当前观测日期更新，与上游字符串比较一致。

新更新锚定于本次 prepare 已接纳的 canonical window 最后一条 Message 之后；不要锚定尚未持久化的 pending assistant，不修改该 Message 的内容/时间。相同 anchor 可以承载多次真实日期变化，顺序采用持久 updates 数组的插入顺序。

准备完成但尚未 dispatch 就取消/崩溃时，这条记录仍然有效：恢复后从 DB 重放一次。它描述已观察到的环境，不伪装成模型已经回答或用户新发言。snapshot 与 record 同一事务保证不会出现“比较状态已推进但更新记录丢失”。

### 10.4 模型输入投影与缓存

canonical history 的 ID 和 proof 必须在 plugin 改写、decide 裁剪前取得；prepare 不能把一个临时裁剪当成持久历史删除。

持久记录虽为上游 System 格式，本地 wire 统一投影为 `role: 'user'` 的独立日期提醒：`<system-reminder>\n${message.text}\n</system-reminder>`。这是固定的 v1 adapter 行为，不是 provider 失败后重试；不写入 MessageTable、不成为 lastUser、不改变 Goal turn、不增加用户输入或任务。

在每个 canonical Message 对应的完整转换块之后插入更新，必须在该块的所有 tool-result/media 消息之后。继续使用 `toModelMessageChunksEffect` 与已有 `messageEntry.chunks`，缓存中只放原有 Message 的转换结果，日期投影在 flatten 时合并。不能让日期更新污染 chunk 缓存，不能为插入几个日期重转稳定前缀。dirty suffix 也使用已有 chunk converter，以保留 MessageID 到输出块的对应。

decide / plugin 省略 anchor 时按 canonical 顺序把更新投影到第一个仍保留的后继 Message 之前；不存在保留后继时放在尾部。同一 slot 内保持更新原顺序；同一记录只出现一次。完整历史不裁剪时，更新保持原插入位置。转换器和 selector 不持久化这个临时位置，也不从数据库重新读取用户文本。

`selectDecideMessages` 的候选估算与最终 dispatch 必须使用同一个更新投影。最终 inputChars、estimatedInput 和 messages.total 包含更新一次；日期字节归入 system 语义统计，不虚增真实 userText。具体复用既有估算函数，不另造 tokenizer。MAX_STEPS 和 near-overflow 提示仍按现有顺序在最后加入。

### 10.5 历史变化与 Session 生命周期

- 同一 Session 普通恢复、模型/Agent 切换：保留 Git 和 generation baseline；其他动态指令照旧更新。
- 同目录新 Session、fork：新 Session row 的列为 NULL，首次请求独立采集当前 Git 和日期。fork 不复制父 Session 的私有上下文，也不更改现有 message/part 克隆流程。
- 已完成 compaction 导致 `proof.boundary` 改变：使用已保存 `smark/git` 与当前日期建立新 baseline，清空旧日期 updates，保存新 boundary。Git 不重新采集。这与上游重建日期 generation 的思想一致，同时遵守用户更强的 Session 级 Git 固定要求。
- 失败或取消 compaction：既有 owner 没有生成新 boundary，不重建 baseline。
- undo cleanup 删除/隐藏了某个已保存更新的 anchor：在 prepare 中根据 canonical 可见 ID 判定 generation 的历史收缩，采用与上述相同的重建操作；Git 保留、日期取当前、旧 updates 清空。这样不需要猜测被撤回历史的日期，也不重放 hidden 内容。
- partial Part undo 保留 anchor Message 时，更新仍位于该 Message 的可见输出块之后。日期不是用户指令，不恢复任何 hidden Part。
- unrevert 在 cleanup 前恢复原范围时，没有 anchor 消失，不需要新 generation；若历史结构实际变化，仍走同一 boundary/anchor 合同。
- 删除 Session：列随 row 自动删除，无清理器或外部文件。重新创建的 Session 不读取已删除行的上下文。
- 升级/导入旧 Session：无法还原从未持久化的进程快照，只在首次新请求初始化；此后执行本合同。不得声称升级首次请求也逐字保留旧进程前缀。

compaction 的摘要模型继续使用其既有专用 system；不把这个上下文存储变成摘要模型的新依赖。正常 Agent 在 compaction 后的首个请求获得新的日期 baseline。当前 scope 不承诺摘要文本包含所有历史日期提醒。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| NULL 首次初始化 / 已有 row 复用 / 日期变化 / generation 重建 | proposed | primary-contract branch | yes | 主路径 100% | implement |
| 非 Git / disableGit / 原有 status 截断 | current | primary-contract branch | yes | 既有 | preserve |
| 当前 Git 采集里已有的个别字段失败为空 | current | existing compatibility | yes | 不扩展 | preserve，仅删除缓存，不顺手改采集语义 |
| API adapter 将 System 日期记录固定投影为 user reminder | proposed | contracted pass-through | yes | 主路径内单一转换 | implement |
| DB/解码失败后重采 Git、内存兜底、忽略日期记录 | rejected | forbidden fallback | would | 0% | reject |
| 临时文件 / 第二张表 / 第二套 v2 runner | rejected | forbidden fallback 或多余平行实现 | would | 0% | reject |

新增 alternate success paths=0；新增诊断分支=0，diagnostic decision-surface ratio=0%。现有错误传播不转换为成功。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| cwd-keyed gitContextCache | 在进程内尽量保持前缀稳定 | Session DB 是唯一权威 | system.ts:187–189,242–243,249,254,291 |
| 每次环境渲染插入当前日期 | 提供实时日期，但改写开头 | 初始日期 baseline + 持久更新 | system.ts:314 |
| “会话级” Map 注释 | 原实现意图 | 已不准确 | 随缓存删除，改为真实生命周期解释 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/02 | lazy capture -> Session row -> saved baseline | system.ts、context-epoch.ts | T1 跨进程；T2 新建/fork |
| INV-03 | current date -> transaction -> updates -> anchored projection | context-epoch.ts、prompt.ts | T3 跨日/同日/跳日/恢复 |
| INV-04/08 | existing DB -> immediate atomic JSON write | session.sql.ts、context-epoch.ts、migration | T5 升级、竞争、失败、删除 |
| INV-05 | Generation / SourceSnapshot / System encoded payload | context-epoch.ts | T5 独立固定 schema fixture roundtrip |
| INV-06 | chunk complete -> reminder projection -> existing adapter | prompt.ts | T3 Goal/lastUser；T6 Anthropic/tool pair |
| INV-07 | canonical proof -> generation replace / projected selection | context-epoch.ts、prompt.ts | T4 压缩/撤回；T6 decide |
| INV-09 | cached chunks + update projection -> shared estimator | prompt.ts | T6 最终 payload/估算一致 |
| INV-10 | 明确文件白名单、禁止附加实现 | §15/19 | diff 检查；不删功能来凑预算 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| Session JSON 列 | INV-01/04 | SessionTable 没有可复用上下文列 | model/revert/summary 是专有语义，不能塞字段；Storage 写文件 |
| baseline / namespaced snapshot | INV-03/05 | upstream Generation/SourceSnapshot | 仅保存 Git 命令字段会重新渲染；当前日期无初始文本 |
| updates + anchor + boundary | INV-03/06/07 | v1 无 System history union，已有 chunks/proof | 新建 user Message 会改变 lastUser，旧 Part 原位修改破坏前缀 |
| 一个 ContextEpoch 模块 | INV-01/03/04/08 | 跨服务持久 owner | SystemPrompt 私有 Map 不承担历史代际与 SQLite 原子性 |
| lazy capture + transaction 重读 | INV-01/08 | 采集为异步、DB 为同步事务 | 只在事务前检查 NULL 可能覆盖并发胜者 |
| 固定 user-reminder adapter | INV-06 | Anthropic 明确拒绝中途 system | 不能直接复制上游 v2 wire 行为 |
| 按既有 proof 重建 generation | INV-07 | compaction/undo 会裁去 anchors | 只保存 lastDate 会让被裁掉的更新永久不再出现 |
| 标准 migration 和 nullable 初始化 | INV-04/08 | 旧数据库与 package guide | 不允许临时 ALTER 或跳过升级 |
| 日期计入实际估算 | INV-09 | preflight compaction 使用估算值 | 估算后追加会低估请求 |

## 15. File-Level Change Plan

下表是实施白名单；所有行数是 additions+deletions 预算，含相邻解释注释，不只统计 net delta。

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `src/session/context-epoch.ts` | add | 内部 schema、一次 prepare 原子持久化、generation 与日期记录；固定 projection 可复用纯函数 | <=260 |
| `src/session/system.ts` | modify | mandatory Session/history 参数；lazy Git；删除 cwd Map；日期改用 DateTime；返回 system/updates | <=110 |
| `src/session/prompt.ts` | modify | capture canonical proof/IDs；新的 environment 返回值；chunk/date 合并；decide 与估算共用投影 | <=120 |
| `src/session/session.sql.ts` | modify | 单个 nullable JSON context_epoch 列；type-only 引用避免 runtime 循环 | <=8 |
| `migration/<generated_timestamp>_session_context_epoch/migration.sql` | add, generated | 只 ADD COLUMN；不修改旧 migration | <=5 |
| 同目录 `snapshot.json` | add, generated | Drizzle 完整 schema 元数据，独立计数见 §19 | 预计约 2740 行 |
| `test/session/system.test.ts` | modify | T1–T3 服务 seam、外部 Git stub、TestClock；路由/skills 断言保留 | <=155 |
| `test/session/prompt.test.ts` | modify | T3/T4/T6 请求与生命周期集成，使用现有 fixture | <=270 |
| `test/session/llm.test.ts` | modify | T6 Anthropic + OpenAI 请求角色/位置；复用捕获服务 | <=70 |
| `test/storage/session-context-migration.test.ts` | add | T1 文件 DB 跨进程、T5 schema 升级/删除/原子性；只使用临时测试数据目录 | <=150 |

生产源码 4 个；包含 SQL 和生成 snapshot 的生产交付文件共 6 个，低于 8。测试 4 个。未来实施改动共 10 个文件，另有本 canonical plan 1 个文档。这里的新测试/源码文件是计划实施产物；运行时不会向用户工作区创建快照文件。

## 16. TDD Behavior Slices

实施时逐片 red -> green，不批量堆积失败测试；最终交付不得留下预期失败、skip 或 weakened assertion。本轮仅规划，不声称新测试已经通过。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| T1 | 同一 Session，Git A 后服务/进程重建，外部 Git 为 B，输出仍为 A；文件 DB 恢复前缀逐字相同 | 当前只存 Map，无 DB | nullable 列、lazy prepare、DB 读取 | 不以共享 runtime/memoMap 假装重启 |
| T2 | 同目录新 Session 与 fork 首次读 B；旧 Session 仍读 A；非 Git/disableGit 文本保留 | cwd Map 跨 Session 复用 | 全部按 session_id 存储 | 独立性、原 Git 分支和截断 |
| T3 | D1 baseline；D2 在工具轮次后追加一个提醒；D2 下一轮和重启重放相同位置；D4 只追加 D4 | 每轮替换日期，无历史记录 | date snapshot+record 同事务；固定 wire 投影 | 不出现新业务 user turn，lastUser/Goal identity 不变；时间后退也更新 |
| T4 | 完成压缩后日期仍正确且 Git A；失败压缩不改 baseline；undo/partial undo/unrevert 不复活隐藏历史 | 无持久 generation；未来实现若只记 lastDate 会漏更新 | 消费既有 boundary/visible IDs | retained tail、hidden anchor、跨日后恢复 |
| T5 | 旧 DB 升级后旧记录保留且列为 NULL；首次初始化持久；两份 service prepare 不覆盖胜者；事务失败无部分更新；删除 row 清除 | 无列/持久原子性 | 标准迁移、事务重读、失败传播 | 不触碰真实用户 DB；不创建新表；encoded fixture 与上游形状一致 |
| T6 | OpenAI/Anthropic 均正常处理日期；tool call/result 完整；decide 裁剪后日期仍可见；估算与最终请求含同一份提醒 | 直接中途 system 会触发 SDK 错误；尾部临时重插会漂移 | 完整 chunk + 单一 projection | stable chunk 复用、候选预算、model switch；不得为日期触发额外任务 |

测试实现约束：

- T1 使用隔离的文件 SQLite 和两个独立 Bun 子进程，共享同一个临时 DB 路径；子进程以环境变量传递 DB/目录，在 import 前设置。不得在共享测试进程关闭全局 DB 再重开 `:memory:`，那会抹掉数据并干扰其他测试。
- 子进程代码可以在测试中内联 `bun -e`，避免新增 fixture 源文件；初始化采用既有 projectors 入口。所有临时文件位于 fixture 的系统临时目录，由 scoped finalizer 清理，不能指向生产 DB。
- Git 服务单元测试使用边界 stub，预期文本为固定独立字面量；至少一个生命周期测试使用真实 Git fixture。此处调用 Git 的测试行为遵循测试环境的授权与安全规则，不对真实工作区执行 git 写操作。
- 日期服务测试使用 TestClock，跨日点固定在本地中午以避免 DST 午夜歧义，不 mock 全局 Date 污染并行测试。内联诊断中 Date 替换只活在独立短进程，不复制为通用测试方案。
- 异步集成依赖 `llm.wait(n)` / Deferred / 已有状态信号，不使用固定 sleep。不依赖系统当天日期、网络模型 API 或完整 prompt 的脆弱大快照。
- schema fixture、数据库 row/DDL 检查只出现在 storage seam；prompt 测试断言捕获请求，不查询私有表替代行为验证。不用源码 grep、私有调用次数或自造转换器做行为断言。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines E | 约 650–750 | 生产与测试；排除 imports、纯移动、生成元数据 |
| Required Chinese explanatory comments C | 至少 ceil(E*0.15)，预计 98–113 | 最终按实际 E 重算，不能用估算代替门禁 |

注释分布在 Session/目录生命周期差异、Git 惰性采集与事务竞争、baseline/snapshot 不同含义、日期锚点位于完整工具块之后、上游 System 编码和 v1 wire 差异、compaction/undo generation、旧数据首次初始化、子进程 DB 隔离、TestClock 与 provider payload 断言附近。不得以翻译赋值、重复测试名或拆短句凑比例。§15 预算已经包含这些注释。

## 18. Verification

本轮已运行：

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| §8 原样 inline probe | `packages/opencode` | 两项 false，exit 1；真实 service prefix red |
| `bun test test/session/system.test.ts test/session/session-schema.test.ts test/storage/db.test.ts` | `packages/opencode` | 14 pass、0 fail、31 expect，3.18 秒 |

未来实施必须依次运行：

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun run db generate --name session_context_epoch` | `packages/opencode` | 单列标准 migration；检查无无关 DDL |
| `bun test test/session/system.test.ts test/storage/session-context-migration.test.ts --timeout 30000` | `packages/opencode` | 服务、真实文件 DB 恢复和升级 |
| `bun test test/session/prompt.test.ts -t 'session context' --timeout 30000` | `packages/opencode` | 新增集成用例统一名称前缀；必须报告实际执行数，0 个用例不算通过 |
| `bun test test/session/llm.test.ts -t 'session context' --timeout 30000` | `packages/opencode` | 新增跨 provider wire 验证，检查实际执行数 |
| `bun test test/session/message-v2.test.ts test/session/compaction.test.ts test/session/revert-compact.test.ts test/session/session-schema.test.ts --timeout 30000` | `packages/opencode` | 相关转换/压缩/撤回/公开 schema 回归 |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 改动核心组装后的完整相关文件，不是全仓库测试 |
| `bun typecheck` | `packages/opencode` | Effect 接口、调用点、类型与 schema 导出 |
| `git diff --check`、限定文件 `git diff --numstat` | 仓库根 | 空白、文件范围、代码与生成元数据分别计数 |

T1/T3 是 §8 的正式 red-green 替代，必须先看到与缺失能力对应的失败，不能把循环导入/配置失败算功能 red。无须运行整个仓库测试；若已有 unrelated failure，记录具体命令和对照，不通过 skip/改现有断言掩盖。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Production source files | 4 | 三个现有源码 + 一个 context owner |
| Production delivery files including migration | 6，硬顶 8 | 再加 migration.sql / snapshot.json |
| Test files | 4 | 三个现有 + 一个 storage 集成文件 |
| Files added | 4 实施文件 + 本 plan | context 源码、storage 测试、迁移二件套 |
| Files modified | 6 | system/prompt/schema + 三个既有测试 |
| Files deleted | 0 | 删除 superseded Map 代码，不删文件 |
| Production code additions+deletions | <=503 | 包含 SQL 与解释注释，来自 §15 |
| Test code additions+deletions | <=645 | 包括子进程代码与解释注释 |
| Total code additions+deletions | <=1148，硬顶 1200 | 不以 net delta 抵消修改成本，预留 52 行 |
| Generated schema metadata | 约 2740 行 / 64 KB，单独披露 | Drizzle 必须生成完整 JSON snapshot；这不是 2740 行新增执行逻辑 |

**预算口径边界：** 上述 1200 是代码（生产、测试、SQL、相邻注释）口径，不包含完整历史 schema 的生成 JSON 数据。若用户的 1200 指 `git diff --numstat` 的所有文件原始行数，则标准 Drizzle 新 snapshot 单独已超过该值，本路线不能声称满足那个更严格口径。实施前必须确认该口径；不得擅自跳过 snapshot、修改旧 migration 或压成一行来规避预算。这个具体约束列在 §20，不能被下一位 Agent 忽略。

## 20. Real Risks and Open Decisions

- 接口改动：生产 environment 调用点仅一个；仍须跑 typecheck 防止测试/后续并发修改新增调用。
- Anthropic 不兼容中途 system 是实际 adapter 限制，本计划用统一投影解决，不留失败后重试分支。
- dates 更新 array 按真实发生的跨日请求增长，压缩/历史收缩时退休；没有每轮记录或定时日志。
- baseline 的可迁移 payload 不等于已经迁移上游 event timeline；未来 baseline_seq 必须重建，不能宣称零转换兼容。
- 初次升级没有历史 Git 快照可恢复，存在一次初始化前缀变化；此后才有本合同的恢复保证。
- 公开 export/import、跨机器事件重放不携带私有列；不会更改这些现有接口，缺字段按 NULL 初始化。不承诺导出后跨机器保留首次快照。
- 本轮没有跑新测试、新 migration 或真实 provider 缓存实验；plan 不能保证尚未编写的实现必然全绿。通过 §16/18 的门禁才能证明完成。

### Open Decisions Requiring the User

只有一项实施前口径需确认：**1200 行是否包含 Drizzle 生成的完整 snapshot.json 原始数据行。** 若包含，不能原样批准这个标准单列迁移方案；需要用户明确调整预算或另行批准不修改 SQL schema 的设计。本 revision 不偷偷放宽数字、不设计第二条备用成功路径。

功能语义不留待猜测：Git 整个 Session 固定；fork 为新 Session；日期 generation 在完成 compaction/真实历史收缩时重建；普通跨日只追加。若这些明确语义被用户调整，需 revision++。

### Rejected Speculation

- 不因未来完整 v2 迁移增加 registry、codec negotiation、schema version 状态机或多种 decoder。
- 不假定 skills/tool 顺序随机；已有排序，不修无证据的问题。
- 不重复实现 compaction 完成判定、hidden 过滤、Runner 锁、tokenizer 或 provider cache 策略。
- 不冻结权限和项目指令来追求整段 system 永久字节一致。
- 不把数据库读取失败解释成“未初始化”；只有合法 NULL 才初始化。

## 21. Audit Contract

用户明确本轮不审计，primary 不加载审计材料、不调用审计 subagent、不作独立审批结论。未来独立 auditor 应按原始需求审查本文件完整 R1，重新从仓库建立证据，检查 ownership、no-fallback、完整行为、测试、预算口径和中文注释；不得只审最近修改段落。审计输入仅为原文、本文路径、仓库根与 `Audit mode: plan`。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | NB-01, NB-02 | APPROVE | task_id ses_f6e98e20cffe2sk3w9MphLEUiY |

Round 1 verdict（原样记录，未转述）：

```text
Blocking findings: No blocking findings.

NB-01 — Requirement quotation is split and slightly paraphrased, not narrowed. The handoff verbatim ends with "尽量按照上游的schema相存储以减少后续匹配上游的麻烦与负担"; the plan's §1 instead carries two transcript quotes whose union covers the same substance, and INV-05/INV-10 convert them into invariants. No requirement substance is lost; the quotation is not byte-verbatim against the handoff text. Non-blocking.

NB-02 — Open decision: 1200-line scope vs generated `snapshot.json` (~2740 raw lines). Plan §19/§20 flags that if the user's 1200-line budget is interpreted as raw `git diff --numstat` over all files, the mandatory Drizzle snapshot alone exceeds it, and forbids silently skipping/compressing the snapshot or proceeding before user confirmation. The code-scope budget (≤503 production + ≤645 test = ≤1148 ≤ 1200) is internally consistent and arithmetically verified against §15. The ambiguity must be resolved by the user before implementation.

Release verdict: APPROVE — exact audited revision R1 (plan mode, full scope). Scope of approval: this verdict applies only to Revision R1 as read today. Implementation remains gated on (a) the primary recording this verdict per policy, setting `Status: approved`, `Approved revision: R1`, `Implementation allowed: yes` without substantive edits; and (b) the user resolving the NB-02 open decision on whether the 1200-line budget includes the generated `snapshot.json` raw lines before implementation begins, as the plan itself requires. Any substantive plan change invalidates this approval and requires a new full-scope audit.
```

任何实质变更必须递增 revision 并清空批准。本条为 verdict 行政记录，不含设计修改。实施开始前仍需用户解决 §20 的 NB-02 预算口径问题。

## 23. Implementation Evidence

### Actual Files and Diff

- `src/session/context-epoch.ts`（新增 184 行）：Stored/Update/SystemMessage schema（上游形状）、prepare（纯读快路径 + immediate 事务写路径 + 事务外采集/事务内胜者重读）、reconcile（日期追加、boundary/锚点重建）、projectUpdates（after/before/end 投影）。
- `src/session/system.ts`（+45/-28）：删除 cwd-keyed gitContextCache；environment 改 mandatory `{sessionID, model, registeredTools, history}` 输入并返回 `{system, updates}`；日期渲染自 baseline 尾部切片。
- `src/session/session.sql.ts`（+4）：SessionTable 增加 nullable `context_epoch` JSON 列（type-only 引用 Stored，避免运行时循环）。
- `src/session/prompt.ts`（+60/-11）：canonical history/proof 捕获；reminder 投影与逐消息块合并；decide 估算携带 reminder 文本；inputBreakdown.system 计入 reminder 一次。
- `migration/20260911173121_session_context_epoch/migration.sql`（生成，1 行 ADD COLUMN）+ `snapshot.json`（生成，2738 行，按 NB-02 用户确认不计入 1200 代码行口径）。
- `test/session/system.test.ts`（+279/-2）：T1/T2/T3/T4a/T4b + 投影三槽位纯函数测试。
- `test/session/prompt.test.ts`（+109/-1）：wire 集成三个用例（Git 冻结+日期回放、fork 独立、compaction 重建）。
- `test/session/llm.test.ts`（+100）：Anthropic wire 防护（中途 user reminder 不触发 system 块错误）。
- `test/storage/session-context-migration.test.ts`（新增 108 行）：旧库升级 NULL 初始化 + 真实文件 DB 双进程持久化。

合计：生产源 4 文件（加 migration 共 6 ≤ 8）；测试 4 文件。生产代码 333 行（≤503）；测试 599 行（≤645）；代码合计 932 行（≤1200，含注释；生成 snapshot.json 单独计数）。行数来自 git diff numstat 与新文件行数。

### Red-Green Test Evidence

- T1 red：旧签名无 Session 输入，`TypeError: model.api.id`（system.test.ts 首轮失败）；实现后 green。
- T3 red：`updates.length` 期望 1 收到 0；T4a/T4b red 同源；投影测试 red：`projectUpdates is not a function`。实现 reconcile/projectUpdates 后 green。
- 日期渲染 bug 由 T3 捕获（snapshot 日期被误用于前缀）：已修复为 baseline 尾部切片并复测 green。
- prompt 集成 red：`Today's date is now:` 出现 0 次（投影未接线）；接线后 green。
- 存储测试首轮 red 由环境残骸（中断 generate 留下的空迁移目录）触发；按生产加载器行为跳过无 migration.sql 目录后 green（与实现正确性无关的环境问题，已区分）。

### Verification Commands and Results

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test test/session/system.test.ts test/session/llm.test.ts test/storage/session-context-migration.test.ts --timeout 30000` | packages/opencode | 39 pass / 0 fail |
| `bun test test/session/prompt.test.ts -t 'session context' --timeout 30000` | packages/opencode | 3 pass / 0 fail（过滤名实测 3 个新用例） |
| `bun test test/session/prompt.test.ts --timeout 30000` | packages/opencode | 100 pass / 14 skip / 0 fail（496s） |
| `bun test test/session/message-v2.test.ts test/session/compaction.test.ts test/session/revert-compact.test.ts test/session/session-schema.test.ts --timeout 30000` | packages/opencode | 148 pass / 0 fail |
| `bun test test/session/session.test.ts --timeout 30000` | packages/opencode | 4 pass / 0 fail |
| `bun run db generate --name session_context_epoch` | packages/opencode | 生成单列迁移，无无关 DDL |
| `bun typecheck` | packages/opencode | 通过 |
| `git diff --check` | 仓库根 | 通过 |

### Original Feedback-Loop Result

§8 原始 loop 的两个症状由正式测试取代并转绿：RESTART_PREFIX_EQUAL 由 T1（服务层重建逐字相等）+ 存储双进程测试覆盖；CROSS_DAY_PREFIX_EQUAL 由 T3（baseline 前缀不变 + 追加一次更新）覆盖。

### Actual Secondary and Replacement Path Inventory

- NULL 初始化 / 已有复用 / 日期追加 / 代际重建：同一 prepare 合同的四个分支，无备选成功路径。
- 空窗口新代分支：reconcile 合同内支持域分支。
- 投影 after/before/end：同一投影合同的三个槽位。
- user reminder wire 适配：唯一投影路径，非失败后的备选。
- 新增诊断分支：0。新增 alternate success path：0。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines E | 825 | 8 个交付文件的非空行（含注释），排除 import-only 行与生成 snapshot.json；统计脚本见实现会话记录 |
| Qualifying Chinese comment lines C | 124 | 邻近修改点，解释不变量/边界/测试意图/compatibility |
| Ratio C / E | 15.03% | 124 / 825 |
| Required minimum C | 124 | ceil(825 × 0.15) |

### Remaining Unverified Items

- decide 模式的端到端 wire 验证未单独跑集成；投影逻辑由纯函数测试 + decide 估算路径类型检查覆盖。
- 真实 provider 的 cached-token 命中率不属于本任务可证明范围（服务端行为）。
- 工作区存在一个与本任务同名的空迁移目录残骸（`migration/20260911150040_session_context_epoch/`，中断 generate 遗留）；删除需要用户授权，未触碰。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings. | NB-01, NB-02, NB-03, NB-04, NB-05, NB-06, NB-07 | APPROVE | task_id ses_f6e512e1affey1KtHyMwQXIH9h |

Round 1 verdict（原样记录，未转述）：

```text
Blocking findings: No blocking findings.

NB-01 — Per-file line-estimate drift, hard caps preserved. Plan §15 estimated system.test.ts ≤155 (actual +279/-2) and llm.test.ts ≤70 (actual +100). The user-facing hard constraints hold: 6 production delivery files ≤ 8, and ~981 total code additions+deletions ≤ 1200 (generated snapshot.json excluded). Non-blocking.

NB-02 — E/C arithmetic drift. §23 records E=825, C=124, 15.03%. Independent recomputation gives E≈741, C≈119, ≈16.1%. Both clear the floor and the target; drift authorizes no lower ratio. Non-blocking.

NB-03 — NB-02 (plan-audit) budget-scope confirmation unverifiable from repo. §23 asserts the user confirmed the generated snapshot.json is excluded from the 1200-line scope. No repo artifact proves the confirmation, but the requirement's wording naturally covers code, and the code-scope total (~981) is internally consistent. Record note only.

NB-04 — Redundant cast. prompt.ts:3015 uses `.content as string` on a value constructed one statement earlier as a string literal. Safe by construction and consistent with existing casts in this file. Minor style note.

NB-05 — §23 file-size metadata drift. "context-epoch.ts 184 行" vs 197 actual; "migration test 108 行" vs 117 actual. Metadata-only; no release claim is false.

NB-06 — Full prompt.test.ts run not auditor-reproduced. §23 records 100 pass/14 skip/0 fail (496s). The auditor reproduced the 3 new integration tests, the 39 service/storage/wire tests, 148 adjacent regression tests, typecheck, and whitespace checks. Explicitly recorded as auditor-unverified.

NB-07 — Empty remnant migration directory. migration/20260911150040_session_context_epoch/ (interrupted generate) is untracked and absent from the delivered diff; the production loader skips directories without migration.sql. Behaviorally inert; deletion awaits user authorization.

Release verdict: APPROVE — applies only to the exact audited implementation diff against approved canonical plan revision R1. Reproduced verification: 39 pass/0 fail (system+llm+storage), 3 pass/0 fail (session context prompt integration), 148 pass/0 fail (message-v2/compaction/revert-compact/session-schema regression), bun typecheck exit 0, git diff --check clean. Auditor-unverified item recorded: NB-06.
```

本条为 verdict 行政记录，不含设计修改。
