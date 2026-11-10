# Canonical Implementation Plan: Auto 模式统一复用自动权限审批

> Status: verified
>
> Revision: R17
>
> Approved revision: R17
>
> Audit mode: full-scope
>
> Requirement source: 当前会话中用户关于 Read/ENV、auto 优先级、公共 Permission 路径、最小 diff、根 manifest/lock 和 HEAD 方案基线的连续明确要求（逐字摘录见 §1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-10

This file is the sole implementation specification for this task. Chat summaries, superseded revisions, and builder rationale outside this file are not implementation authority.

## Plan Baseline and Completeness

本 revision 的全部设计均以当前 HEAD 为基线；§15 是完整且封闭的最终文件修改清单，不是相对任何旧 revision 的增量。当前或后续属于本 GOAL 的每个 hunk 都必须能映射到 §10 和 §15；未列入清单的实现不得保留、送审或提交。旧 revision 仅用于保留审计历史，不构成实施步骤，也不在本方案中安排所谓“回滚旧方案”。













## 1. Verbatim Requirement

用户最初报告的 Read/ENV 问题：

> 先我需要你检查一下我们当前这个 read 的逻辑。我当前发现它一旦阅读这种凭据，巴拉巴拉东西，它就会直接调起这个 ask。但按理来说用户已经选择了 auto 模式，auto 模式下应该是自动去进行这个一些处理的，因为这种凭据，巴拉巴拉，我们这个 auto reviewer，或者说这个 preview，pre-check，说错了，pre-check 这种逻辑应该是有相应的一个捕获，或者说相应的一个处理的。或者换言之，按理来说这种 ENV 或者这种凭据的东西，它不应该在我们的 auto 下还要去有相应的一个捕获。你查一下怎么回事。我这个分支当前是从这个 DEV SMRK 分支拉过来的。你看看是当前分支没有去同步对应的修改，还是说什么情况。注意read only检查。
>
> →Read config\jp\dashboard.env [offset=1, limit=22]

用户对 auto 与 ask 的顺序要求：

> 按理来说，auto应该是最浅置的，auto之后才能是什么 ask 巴拉巴拉的。也就是按理来说，在 auto 规则下应该是先 auto 再去 ask 巴拉巴拉的。就是所有的 ask 都应该理论上被转换成 auto 的吧？

用户对完整 auto 模式语义的要求：




> 那我的希望是相应的这一，就是反正就是，只要用户配置了Auto模式，那所有的这种因为权限或者因为什么造成的这种Ask，我觉得应该被Auto所审批，而不应该去被Ask所审批。因为用户选择Auto，他的初衷就是他不想去手动进行这个权限审批。所以请注意这一点。你看一下，如果要调整的话，本质上应该调整多少？然后请注意是 read only。你比如说要调整的话，要调整多少行，要改几个生成代码。

用户对最小实现面的硬约束：





> 那既然按照这套逻辑呢，我希望你的这个相应的 hunk 数保持尽量的精简，然后相应的生产文件各种的修改保持尽量的克制，能不扩张修改文件数就不扩张修改文件数。然后相应的这个修改的行数的上限呢，我认为是保持在生产代码保持在100行的修改以内。

用户对 reviewer 失败后复用现有 auto 最终逻辑的明确回答：

> 那这个当然是允许的。我指的只是意思是说把这套逻辑先去让它复用 auto 那套逻辑，然后 auto 如果不行的话，本质上你就按 auto 最终的逻辑走，因为 auto 最终它会走到 unavailable。也就是说注意是复用复用复用。



用户对根 manifest、lock 和不必要依赖改动的要求：

> 你没有在回答问题，你确实新增类相应的gitlabai provider，我要求如果你没有准确清晰的理由的话需要移除不必要的依赖新增，换言之bun.lock以及package.json的更新需要有依据，譬如你无法在现有的包环境下解决某件事情，否则不得引入额外的具有风险的package

> 换言之我不希望主仓库的package和bunlock发生不必要的改变，譬如检查opencode的upstream 1.19.5或者2.2.5到底如何

用户对公共调用点和 fork 架构的要求：

> 我没有说只允许，我的意思是你可以通过修改公共路径，交小的 Hunk 来实现较大数量的改动。要不然的话你每一个调用点都要去修改，万一上游去增加了过多的一些东西，本质上你的兼容性等等各种逻辑都需要去跟着大改，这很难，要跟着修改方向走。

> 与此同时，你也可以去对比一下。按理来说，我们之前的上游的一些各种各样的一些修改，可能和上游已经有分歧了，分歧点可能就是在我们进行的一些，比如说这个 external directory 等等的一些修改上面。那既然这些 provider 我们整体可以收敛到一处，所以你也可以去检查一下，适当地去降低我们本地和这个上游 upstream 的，也就是 1.19.5，或者说等等这种分支的一个分歧，降低这种，降低对于我们 fork 的一个依赖性。这样的话就能够让现在 hunk 独立存在，而且去避免它去过度地去修改。所以请你注意这一套架构。按理来说，这种修改最好是在这种公共调用点去补齐一下，然后去就 OK。这样无论后续实现任何各种各样的一些tool调用，本身它都能够去得到一个实现一个比较好的泛化性。

用户对 Canonical Plan 完整性和 HEAD 基线的要求：

> 你的方案必须包含你所有要修改的东西。如果它没有被包含，相应的内容必须被撤回。

> 你不需要写他是否需要被回滚，需要回滚的自己去进行回滚。

> 你的所有的 plan 的口径应当是基于现有的仓库中，也就是 HAD 状态下的。

用户对禁止前置接线和必要性判断的最新要求：

> 怎么又workflow了，又干什么呀？你要干什么呀？说过很多遍了。在接线处前面东西都不要动，你动它干什么。避免不必要的Hunk。所有的这种边界情况，你靠内部处理这种抽象优秀的抽象机制来解决。你不要试图去给各种各样的边界情况加补丁，加补丁是堵不住的。
>
> 保持在100行的修改以内

> 你每进行相应的这个修改的调整的时候，你都需要去思考，到底用户关不关心这种东西，到底是不是必要的逻辑，到底为什么需要这种东西。

> 以及请注意当前其实我并不是特别限制你这个文件的数量。我只给你的四个只是说一个建议。我建议你不要去过多地修改一些与此无关的一些逻辑，因为本身我们的模式内容已经很清晰了，就是这么一个，比如读取凭据，或者说等等这种操作，它仍然具有这种 ask 分支，所以我希望的东西就是去收拢这套逻辑。

目标终态为 `verified-implementation-and-commit`。只有 R17 exact revision 获独立方案批准后才能实施；实施审计通过并达到 `verified` 后，才允许仅提交 §15 中本 GOAL 文件。











## 2. Explicit Non-Goals

- 不改变 `allow`、`deny`、raw deny、已保存审批或 forbidden 终审语义；不把默认 `allow` 扩成 `auto`。
- 不改变现有 `PermissionAuto.evaluate` 的 safe/general 快速放行、cautious/dangerous 送 reviewer、forbidden 拒绝路由。
- 不改变 reviewer 已执行后的 `unavailable`、`auto_review.fallback=user|deny`、`approvals_reviewer=user` 或人工回复协议。用户明确要求复用 auto 最终逻辑，不新增强制 deny。
- 不新增第二套 reviewer、权限服务、auto mode 配置字段、marker rule、Schema/Protocol/HttpApi 字段或持久化格式。
- 不逐工具增加权限补丁，不修改 `ReadTool` 的文件读取职责。

- 不强制所有原 ask 都调用 LLM reviewer；沿用 pre-check 的风险分层，仅补齐已观察到的敏感 Read 分类缺口。
- 不处理 `Question` 工具的正常需求澄清或非权限交互。

- 不重新生成或手改 Client/SDK generated；不修改根 `package.json`、`bun.lock`，不新增依赖、第三方 patch 或 provider 修改。
- 不修改 workflow、doom_loop 或任何 Permission 之前的 producer/provider 接线；host/provider 预批准和工具名级缓存不属于实际 Permission Ask，不为它们增加 hunk。
- 不反查历史消息或重建 provider-turn 生命周期；Permission 只使用请求 metadata、当前 Session 与 Config，普通工具的 metadata.agent 始终优先。
- 不通过整文件同步 upstream 删除本地 `external_directory`、ExecuteReview、raw deny、strict 等既有安全能力；只把本任务新增差异收敛到公共 Permission 路径。
- 不做无关重构、格式化或文档迁移。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 权限修改须最小化；测试/typecheck 必须从 package 目录运行；公共 Protocol/HttpApi 变化才触发生成。 |
| `packages/opencode/AGENTS.md` | Effect service、模块边界和复用约束；不建立平行 namespace/service。 |
| `packages/opencode/test/AGENTS.md` | 使用 `testEffect`、真实 fixture 和 readiness 信号，不用固定 sleep 代替同步。 |
| `packages/core/src/tool/AGENTS.md` | Tool Registry 不拥有执行授权；授权留在 Permission leaf/service，不在 Registry 或逐工具重复实现。 |
| `CONTEXT.md:122-125,243-260,361-399` | Agent 由 Permission ruleset 驱动；工具经 `ask(Permission.Request)` 升级；Permission 是独立模块；auto 仅显式选择。 |
| `docs/adr/README.md`、唯一 ADR-0001 | 当前没有权限语义 ADR；本任务不借权限实现扩展 triage 文档。 |
| `docs/proposal/opencode-sandbox-windows-design.md:80-105` | 记录旧语义：auto 只接 bash/edit/external_directory，read 等未纳入；实施后需做最小同步。 |
| `packages/core/src/permission/subagent.ts`、对应测试 | auto 是 action 驱动的 admission ceiling，子代理可继承 auto；父/子规则求值不能只看内置 agent 名。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/tool/read.ts:386-429` | Read 仅解析路径并调用 `ctx.ask(permission=read)`，不是人工审批的 first divergence。 | observed |
| `packages/opencode/src/session/tools.ts:132-175,187-224` | 普通工具统一注入 `metadata.agent`，合并 agent/session ruleset，并复用 Permission/ExecuteReview。 | observed |
| `packages/opencode/src/agent/agent.ts:124-217` | 默认 `*.env/*.env.*=ask`；auto agent 仅覆盖 bash/edit/external_directory；user 规则最后合并。 | observed |
| `packages/opencode/src/permission/index.ts:50-59,90-287,289-364` | V1 `matchRequest` 先将 ask 设为 needsAsk；ExecuteReview 的父/叶 `check` 又无条件 precheck/reviewAuto，必须单独保持非 auto 与静态 allow 路由。 | observed |
| `packages/core/src/permission.ts:91-105,156-263,291-319` | V2 先算 effects，auto resources 为空则提前返回；否则复用同一 `PermissionAuto.evaluate`；ask/assert 共用求值。 | observed |
| `packages/core/src/permission/auto.ts:48-138` | 现有 auto 五级路由和 reviewer unavailable/fallback 契约，可原样复用。 | contracted |
| `packages/core/src/permission/precheck.ts:228-273,1460-1529` | 非 bash 默认 general；已有 `hasSensitivePath` 可复用，但 native read 未调用，`dashboard.env` 未命中本地敏感后缀。 | observed |
| `packages/opencode/src/session/session.ts` | `Session.Service` 提供当前 `Info.agent/permission`；该模块只引用 PermissionV1 Schema，没有运行时 Permission 循环依赖。 | observed |
| `packages/opencode/src/agent/agent.ts` | Agent 运行时导入 `Permission.merge/fromConfig`，Permission 不得反向导入 Agent.Service；配置合并顺序可用于保持调用方规则优先级。 | observed |
| `Config.default_agent`、全局/agent permission 与现有 `Permission.fromConfig` | 内存探针已验证 `defaultAuto=true`、`customAuto=true`、`sessionAuto=true`、`nonAuto=false`、`deny=deny`，可复用同一规则解析。 | observed |
| `D:/Temp/opencode/auto-mode-session-context-repro.test.ts` | Session=auto、请求 ruleset=[] 且无 agent metadata，当前首先产生 Asked；`0 pass / 1 fail`，Expected auto / Received ask。 | observed |
| upstream `v1.19.5` 与 `v2.2.5` 只读比较 | v1.19.5 没有本地 auto reviewer/precheck；精确命令 `gh api "repos/anomalyco/opencode/git/trees/v2.2.5?recursive=1" --jq ...` 仅命中 `packages/core/src/permission.ts` 和 `packages/core/src/session/runner/llm.ts`，V1 `packages/opencode/src/session/llm.ts`、`packages/opencode/src/permission/index.ts` 均不存在，故没有可直接同步的同构修复。 | observed |
| `D:/Temp/opencode/upstream-1.19.5/` | upstream/local HEAD 只读比较副本；本地 V1/Core 相对 upstream 已有约 321/109 行新增安全能力，不能整文件回退。 | observed |
| `packages/core/src/plugin/agent.ts:94-160` | V2 内置 auto 与默认 env ask 的对应规则。 | observed |
| `packages/core/src/permission/subagent.ts:23-92` | 父子 auto ceiling 推导及具体 deny 保留。 | contracted |
| `packages/opencode/test/permission/next.test.ts` | V1 auto、mixed auto+ask、fallback、cache 和 pending 行为 seam。 | observed |
| `packages/core/test/permission.test.ts` | V2 ask/assert、auto reviewer、mixed effects 和 fallback 行为 seam。 | observed |
| `packages/opencode/test/permission/precheck.test.ts` | shell 敏感读取与非 shell general 的现有分类合同。 | observed |
| `packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts` | auto ceiling 与 parent ask/child auto 的现有优先级测试。 | observed |
| `Layer.mock(Session.Service)` 与两代 Permission 测试 fixture | 可在公共 Permission seam 直接覆盖空 rules、synthetic permission、default_agent 和 session-only auto，无需 producer 专用测试。 | observed |
| `packages/schema/src/v1/permission.ts:16-56`、`packages/schema/src/permission.ts:54-67` | auto 已在两代内部规则词汇中；无需新增公开字段。 | contracted |
| `D:/Temp/opencode/auto-mode-ask-repro.test.ts` 两次运行 | 真实 Permission service 均得到 `Expected review / Received ask`；native read 均得到 `Expected cautious / Received general`；每次 0 pass/2 fail。 | observed |
| 内存候选求值探针（cwd `packages/core`） | autoEnv=auto、inheritedEnv=auto、nonAutoEnv=ask、autoWithoutAutoRules=auto、denyPreserved=deny。 | observed |
| `dev-smark`/`origin/dev-smark` 直接内容比较 | 来源分支同样保留 env ask 和有限 auto 覆盖，未发现漏同步的现成修复。 | observed |

## 5. Current Behavior

V1 普通 Read：

```text
Read(filePath)
  -> SessionTools.context: metadata.agent + agent/session ruleset
  -> Permission.matchRequest
  -> evaluate(read, relativePath): *.env => ask
  -> needsAsk=true
  -> Permission.reviewAuto 不会因其他 permission 上存在 auto 而接管 read
  -> Permission.requestUser
  -> Permission.Event.Asked / 人工 pending
```

V1 auto 请求原本已有以下路径，本任务复用而不重建：

```text
matched action=auto
  -> Permission.reviewAuto
  -> PermissionAuto.evaluate
  -> PermissionPrecheck.evaluate
  -> safe/general allow，cautious/dangerous reviewer，forbidden deny
  -> reviewer unavailable 时沿用 fallback=user|deny
```

V2：




```text
Permission.ask/assert
  -> configured(agent permissions + session permissions)


  -> denied/raw deny

  -> effects = evaluate(resource)

  -> resources = effects === auto

  -> resources 为空时提前返回 ask/allow/deny

  -> 否则 PermissionAuto.evaluate
  -> decision=ask 时才创建人工 pending
```

公共入口的上下文缺口：

- 普通工具已由 SessionTools 交付有效 agent/rules；某些 synthetic permission 只提供 sessionID 和空/不完整 rules，V1 公共入口目前没有从 Session/Config 补齐 auto 上下文。
- 因此 owner 是 V1 `Permission.matchRequest`，不是各个 producer；任何实际到达 Permission 的 permission 名称都应获得同一上下文解析。


















Native Read 分类：

```text


PermissionPrecheck.evaluate(permission=read)

  -> externalDirectoryEffect: 不适用

  -> structuredFileEffect: 仅 edit delete


  -> permission !== bash => general

  -> auto.ts general => allow（不会进入 reviewer）

```


`hasSensitivePath` 已服务 shell 本地敏感读取，但当前只认 basename `.env`、`.env.*` 等；`config/jp/dashboard.env` 的 shell 读取也实测为 safe。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 内置 auto agent，含默认或用户覆盖规则 | Agent/Session selection | auto 仅显式选择 | 普通工具、execute、doom_loop、workflow | V1/V2 Permission | contracted |
| 有效 ruleset 中已有任一 auto action | Agent config、session ceiling、subagent derive | auto action 已属公开规则词汇 | mixed auto+ask、自定义 auto、父子继承 | V1/V2 Permission | contracted |
| 非 auto agent 且无 auto action | Agent/Session selection | 现有 manual/auto/allow/deny 语义 | 全部 Permission 请求 | V1/V2 Permission | observed |
| `read` 任意 basename 的 `*.env`、`*.env.*`（含 `dashboard.env.local`） | Read/Grep/Shell 路径参数 | 默认规则 `*.env`/`*.env.*` 与 precheck 接收同一 patterns | auto admission -> precheck -> reviewer | PermissionPrecheck | observed / reachable |
| ENV 大小写变体 | 同上 | Windows Wildcard 忽略大小写，POSIX 不忽略 | auto admission -> precheck | PermissionPrecheck | reachable |
| 同工具名的不同载荷 | synthetic permission + `auto_review.strict` | PermissionAuto 应按完整 args 复审 | 公共 Permission -> 后续不同载荷 | V1 Permission cache | reachable |
| 非 auto 子代理仅有 session auto ceilings | Task derive + session.permission | agent 名不是 auto，但 Session rules 含 auto | 任意 synthetic permission -> Permission | V1 Permission | reachable |
| 普通非敏感 Read | 同上 | 无敏感路径命中 | auto admission -> general fast path | PermissionPrecheck | contracted |
| 空 rules、无 agent metadata 的 synthetic permission | workflow/doom_loop 等调用形态 | sessionID 可定位当前 Session | Session/Config -> 公共 Permission | V1 Permission | reachable |
| 自定义 default_agent 含 auto action | Config + fromConfig | agent 名不必是内置 auto | Config -> 公共 Permission | V1 Permission | reachable |
| reviewer unavailable/failure | PermissionAuto reviewer | 现有 fallback 配置 | auto 决策完成后的 ask/deny | PermissionAuto | contracted |
| Question/需求澄清 | Question 工具 | 非 Permission 审批 | 独立交互 | 不在本任务 | speculative for this diff |

## 7. Required Invariants









| ID | Behavioral invariant | Evidence | Existing test |

| --- | --- | --- | --- |
| INV-01 | auto 上下文中，规则求值得到的 ask 必须在人工 pending 之前转为 auto；auto 上下文由当前 auto agent 身份或有效 ruleset 中的 auto action 确定。 | 用户明确要求；`subagent.ts` auto ceiling | 当前无；R1 红色 harness 捕获 |
| INV-02 | 非 auto 上下文的 ask/allow/deny 行为不变；auto 上下文的 allow/deny/raw deny/保存审批不放宽。 | 用户完整要求 + 既有权限契约 | `next.test.ts`、`core/test/permission.test.ts` 既有矩阵 |
| INV-03 | 转换后必须复用现有 PermissionAuto/precheck/reviewer/fallback，不新增平行成功路径；reviewer unavailable 后仍按原 auto 最终逻辑。 | 用户“复用复用复用”及 fallback 回答 | 既有 auto/fallback 测试必须保持 |
| INV-04 | 默认规则覆盖的任意 basename `*.env`、`*.env.*` native read 均须 cautious，包括 `dashboard.env.local`；Windows 与规则一样忽略大小写，POSIX 保持大小写敏感。普通 Read 仍 general；`.envrc` 不误判；既有 `*.env.example=allow` 规则不被改写。 | R1 harness + R1 audit B-01 | 当前无完整 native ENV 形态测试 |
| INV-05 | V1/V2、普通工具、execute/subagent 及任意实际到达 Permission 的 synthetic permission 都使用同一求值语义；V1 在公共入口从当前 Session/Config 补齐上下文，producer/provider 均不修改。 | 用户“所有权限 ask”、禁止前置接线和收拢 ask 逻辑的要求 | 两代 Permission 测试 + 空 rules/default_agent/session-only auto + Session deny 对照 |
| INV-06 | 生产修改保持最少文件/hunk，实际有效生产修改不超过 100 行；根 package/bun.lock、依赖 patch、Client/SDK generated 均为 0 差异。 | 用户硬约束 | 最终完整路径清单、numstat/diff 审核 |
| INV-07 | 公共 Schema/Protocol/HttpApi、Reviewer 请求/响应、Permission 事件结构保持兼容，无需代码生成。 | 现有内部接口已足够 | typecheck + generated-path 空 diff |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 (V1) | `matchRequest` 在 `evaluate` 得到 ask 后直接设置 `needsAsk`，没有将 auto 上下文应用于该 resource。 | V1 `Permission.matchRequest` | `index.ts:116-133`；真实 harness 首先收到 Asked |
| INV-01 (V2) | `effects` 保留 ask，auto resources 为空时在 `PermissionAuto.evaluate` 前提前返回。 | V2 `Permission.evaluateInput/configured` | `permission.ts:186-198` |
| INV-04 | native read 在非 bash general 返回前没有复用敏感路径分类；谓词只覆盖 basename 以 `.env` 开头的形态，漏掉任意前缀的 `*.env.*`，且 Windows 未归一大小写。 | `PermissionPrecheck.evaluate` + `hasSensitivePath` | 两次 red harness；R1 audit B-01 证明 dashboard.env.local 可达 |
| INV-05 (V1 context) | `matchRequest` 只凭请求 metadata/rules 判断 auto；空 rules、无 metadata 的 synthetic 请求无法使用 Session/default_agent 的 auto 事实。 | V1 `Permission.matchRequest` | 中央 Session harness：Session=auto 仍首先 Asked |
| INV-02/04 (ExecuteReview) | 父/叶 check 无条件 precheck，新增 native-read cautious 会影响非 auto 和静态 allow。 | V1 ExecuteReview check | `permission/index.ts:319-364`；R4 B-02 |
| INV-05 (test seam) | 纯 evaluate/derive 不断言 Session/Config 到 Permission 的交付，无法对空上下文缺陷变红。 | 行为测试 seam | 中央 Session harness 当前 0 pass/1 fail |

根因不是 Read 缺少人工审批 guard，也不是 reviewer 已经处理后错误回退；根因是两代 Permission owner 未将 auto 上下文应用于 ask admission，且 V1 在请求上下文不完整时没有从 Session/Config 补齐同一事实。敏感 Read 是同一 auto 管线内的第二个确定性分类缺口。












**Red-capable feedback loop**



```text
Command: bun test "D:/Temp/opencode/auto-mode-ask-repro.test.ts"
Working directory: packages/opencode
Observed (two consecutive runs): 0 pass, 2 fail
  1. Expected "review", received "ask"
  2. Expected "cautious", received "general"
```

该 harness 驱动真实 `Permission.Service.ask` 和 `PermissionPrecheck.evaluate`，以 Asked/ReviewStarted 的首事件及独立分类等级捕获用户原始症状；reviewer 是同步确定返回的 test fixture，无 provider/network/真实凭据读取。









候选求值内存探针已验证 auto/继承/non-auto/空规则 auto/deny 五种关键分支，结果符合 §7，不需要新 Schema 或 marker。

## 9. Responsibility and Seam














| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| auto 上下文下的 ask admission | V1 `Permission.matchRequest` | 将有效规则与请求上下文转成 needsAuto/needsAsk | 这是人工 pending 与 auto review 分流的首个错误点 | Read/SessionTools 不应复制规则优先级 |
| V2 同等 admission | V2 `configured/evaluateInput` | ask/assert 共用有效 agent/session 求值 | V2 auto resources 在这里形成 | Core plugin/agent 只生产规则，不拥有运行时覆盖 |
| 敏感路径风险等级 | `PermissionPrecheck.evaluate` | 为 PermissionAuto 提供确定性 level/reason | reviewer 只消费 precheck，不应另写路径正则 | Read/Reviewer 不应重复 shell 已有谓词 |
| V1 Session/Config 上下文 | V1 `Permission.matchRequest` | 补齐上下文只用于 auto 身份发现和 auto 求值；非 auto 继续原 caller ruleset；NotFound 不泄漏新错误 | 这是所有实际 Permission 请求必经的公共入口 | 不让 Config 静态规则改变人工模式，不导入 Agent.Service |
| reviewer cache 身份 | `PermissionSessionCache.canonicalKey` | 字符串 metadata 与既有字段共同决定缓存槽，结构化 metadata 跳过缓存 | 所有 synthetic/普通 auto 请求共用一个缓存键 owner | 不在 producer 或具体 permission 名称上绕过缓存 |
| ExecuteReview 分类适用域 | V1 ExecuteReview check | 仅 matched.needsAuto 的请求使用新增 native-read 分类；非 auto/静态 allow 保持旧 general | check 已同时拥有 request 与 caller 的 matched 结果 | PermissionPrecheck 不应知道 Execute 编排，非 auto 不应被新 reviewer 截获 |
| auto reviewer/fallback | 既有 PermissionAuto/Reviewer | 保持现有裁决和 unavailable/fallback | 用户明确要求复用 | 本任务不新增实现 |
| 测试 | 两代 Permission 公共接口与 Session mock | 观察 Asked/ReviewStarted/effect/precheck level | 可独立证明公共路径行为，不断言私有 helper | 不做 producer 专用或 source-text 伪行为测试 |

## 10. Single Approved Primary-Path Design

采用一条请求局部的 auto admission 主路径，不修改持久化 ruleset，也不改变纯函数 `Permission.evaluate` 的通用 last-match-wins 契约。






1. **V1 公共上下文**：`matchRequest` 通过 `Effect.serviceOption(Session.Service)` 获取可选 Session service，存在时读取当前 Session；仅以 `Effect.catchTag("NotFoundError", ...)` 把 Session 不存在解释为无可补充上下文，其他错误不吞。以 `metadata.agent ?? current.agent ?? cfg.default_agent` 确定 selected agent；普通工具的 metadata 始终优先，缺省 synthetic 请求使用当前 Session/default，不反查历史消息。
2. **V1 身份发现与裁决分离**：复用 `fromConfig` 形成“全局配置 → agent 配置 → caller rules → Session permission”的 effectiveRules，仅用于发现 auto action 和 auto 路径求值。以 `metadata.agent === "auto" || selected === "auto" || effectiveRules.some(action === "auto")` 判定 automatic；非 auto 请求继续使用原 caller ruleset 和原 raw deny，不把 Config 静态 allow/deny 引入 HEAD 的人工模式裁决。auto 路径才用 effectiveRules，Session ceilings 最后，ask 请求局部转 auto，allow/deny/raw deny/remembered allow 不变。不同 action 不去重，不导入 Agent.Service，不修改 producer。
3. **V2 对等**：`configured` 在现有 Session/Agent 解析位置返回 `{ rules, automatic }`；`evaluateInput` 在 denied、remembered allow 之后应用同一 ask→auto，`reply` 的第二个消费者机械读取 `.rules`。不改公共接口。
4. **复用 auto 最终逻辑并修正缓存身份**：不改 PermissionAuto.evaluate、fallback、熔断、事件和人工回复。`PermissionSessionCache.canonicalKey` 在现有字段后加入按 key 排序的全部字符串 metadata；`has/put` 在现有 tool-origin external_directory 短路旁，对任何已定义的非字符串 metadata 直接跳过缓存，不序列化未知对象。相同字符串 metadata 仍命中，不同字符串 metadata 分槽；workflow tools、doom_loop input 等结构化载荷逐次经过现有分类/reviewer，避免 circular/BigInt 等新序列化错误。不按 permission 名称排除缓存。
5. **敏感 Read**：在非 bash general 返回前，native `permission=read` 调用 `hasSensitivePath(["read", ...patterns], true)`。谓词新增 `nativeRead=false` 默认参数；只有 true 使用 Windows lowercase、basename `/\.env(?:\.|$)/` 与任意前缀 `.env`/`.env.*` 目录正则，false 完整保留旧 shell 分类。ExecuteReview 沿用普通 Permission 的自动管辖视图：auto 时以 `{ ...request, patterns: matched.autoPatterns }` 调用 check，非 auto 保持原 request 和旧 general。混合 auto+静态 allow 时 reviewer 只见 autoPatterns，静态 `.env.example` 不被带入；matched.needsAsk 仍对原 request 处理。

```text

agent/session/producer evidence
  -> 现有 evaluate(resource)
  -> 仅 auto 上下文中的 ask 改为 auto
  -> 现有 PermissionAuto + PermissionPrecheck
  -> 现有 reviewer/fallback/allow/deny
  -> 仅非 auto 或 auto 最终 decision=ask 时创建人工 pending
```

该设计直接修复 §8 的 owner 分歧，auto 判定、当前 Session 身份、Session ceilings、缓存身份和 reviewer 路由都在公共 Permission/Session/cache 抽象内；不增加 producer/provider、依赖、配置或替代成功路径。应用生产文件预计为 4 个、55–90 个有效修改行，硬上限 100 行。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 非 auto 的 allow/ask/deny | current | primary-contract branch | allow=yes；ask/deny=no | 既有，不计新增 | preserve |
| auto safe/general fast path | current | primary-contract branch | yes | 既有，不计新增 | preserve |
| cautious/dangerous reviewer allow/deny | current | primary-contract branch | allow=yes；deny=no | 既有，不计新增 | preserve |
| forbidden precheck deny | current | primary-contract branch | no | 既有，不计新增 | preserve |
| reviewer unavailable -> fallback=user | current | existing compatibility | no（等待人工，非自动成功） | 0% 新增 | preserve |
| reviewer unavailable -> fallback=deny | current | existing compatibility | no | 0% 新增 | preserve |
| remembered/session allow | current | contracted pass-through | yes | 0% 新增 | preserve |
| 规则直接 ask 在 auto 中先转 auto | proposed | primary-path repair | 由既有 auto 决定 | 100% 新增决策面 | implement |
| native read cautious | proposed | primary-path repair | 仅分类，不直接成功 | 同上单一分类入口 | implement |
| Session/Config 补齐空或不完整请求上下文 | proposed | primary-path repair | no | 仅公共入口事实补齐 | implement |
| PermissionSessionCache 字符串 metadata 入键、结构化 metadata 跳过缓存 | proposed | primary-contract repair | 仅相同可安全入键的完整上下文复用既有 reviewer allow | 不同/结构化 synthetic 载荷不复用，不新增成功路径 | implement |
| Session permission 最后形成 ceilings | proposed | primary-path repair | no | 防止 caller Agent ask 覆盖 Session deny | implement |
| ExecuteReview 非 auto/静态 allow 保持 general | proposed | existing compatibility | 按旧人工/allow 决定 | 仅限制新分类适用域，不新增审批路径 | implement |
| Session service 不可用或 Session NotFound 时沿用请求上下文 | proposed | existing isolated-environment compatibility | 由原规则决定 | 0% 新增决策面 | preserve |
| 强制所有原 ask 进 LLM | rejected | forbidden fallback/成本旁路 | yes/no | 0% | reject |
| auto reviewer 失败强制 deny | rejected by user | 非 requested rollback | no | 0% | reject |

新增 alternate success path 为 0；新增 diagnostic path 为 0，diagnostic 占比 0%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无生产 workaround 可删除 | 当前问题是 auto admission 未覆盖，而非已有替代审批器 | 本任务直接修复 owner，不保留新增并行实现 | Not applicable |
| `read.ts` 直接 ctx.ask | Read 的正常权限升级 producer | 不能删除，否则工具会绕过 Permission | 保留，不修改 |

| auto bash/edit/external_directory 限定规则 | 旧产品范围 | 新 admission 统一消费这些 auto 信号，不需重写 agent 默认规则 | 保留，避免额外 hunks |
| mixed auto+ask 的旧运行时预期 | 旧优先级 | auto 优先后行为合法改变，更新真实 Permission seam 的少量断言；纯 evaluate/derive 测试不改 | `next.test.ts`、`core/test/permission.test.ts` |
| ExecuteReview 无条件 native-read 分类 | 原 check 为 execute 风险审查直接调用 precheck | 非 auto/静态 allow 继续旧 general，新增 cautious 只随 matched.needsAuto 进入 | `permission/index.ts` check 调用参数 |









## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 V1 | `Permission.matchRequest` per-resource ask→auto | `packages/opencode/src/permission/index.ts` | V1 Permission.ask mixed rules + Asked/ReviewStarted；原始 harness |
| INV-01 V2 | `configured/evaluateInput` auto context + auto resources；`reply` 同步使用 `.rules` | `packages/core/src/permission.ts` | V2 ask/assert mixed rules + 既有 pending Always 释放测试 |
| INV-02 | deny/raw deny/remembered allow 先保持；非 auto 不改 | 同两代 Permission 文件 | 既有 allow/deny/manual/fallback 矩阵 |
| INV-03 | 继续调用现有 reviewAuto/PermissionAuto；不改 fallback | 无新增文件 | 既有 reviewer unavailable user/deny 测试保持通过 |
| INV-04 | native read 复用 hasSensitivePath；basename ENV 正则 + Windows lowercase | `packages/core/src/permission/precheck.ts` | `.env`/任意前缀 `*.env`/`*.env.*`/大小写/`.envrc`/普通文件 + 原始 harness |
| INV-05 公共上下文 | 当前 Session/Config/default_agent/fromConfig + Session-last ceilings | `packages/opencode/src/permission/index.ts` | 空 rules、default_agent、session-only auto、Session deny 与 NotFound |
| INV-03/05 缓存身份 | 字符串 metadata 排序入键；非字符串 metadata 在 has/put 跳过缓存 | `packages/opencode/src/permission/cache/session-cache.ts` | strict 下同工具不同 input 重新 reviewer；相同字符串 metadata 命中；结构化载荷不序列化 |
| INV-02/04/05 ExecuteReview | auto 时 check 只接收 matched.autoPatterns；非 auto 保持原 request/general | `packages/opencode/src/permission/index.ts` | `execute.test.ts` 验证父/叶 auto、非 auto ENV、单独及混合 patterns 的静态 ENV allow |
| INV-06 | 4 个应用生产文件；无 producer/provider/依赖补丁 | §15 | 完整路径清单 + numstat + implementation audit，生产 E≤100 |
| INV-07 | 只用现有 metadata/action/event/schema | 无 Schema/Protocol/HttpApi 文件 | typecheck + generated paths 空 diff |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 当前 Session/Config 上下文与 Session-last ceilings | INV-01/02/05 | 中央 Session harness；defaultAuto/customAuto/sessionAuto 探针；普通 Agent→Session 合同 | 空 rules/缺 metadata 无法证明 auto；Permission 不导入 Agent.Service，Session deny 必须最后 |
| 仅请求局部 ask→auto | INV-01/02/03 | 红色 harness；用户要求 auto 优先且复用 | 持久化 ruleset/纯 evaluate 改全局会破坏非 auto 与 last-match-wins |
| PermissionSessionCache 字符串 metadata 入键、结构化 metadata 跳过缓存 | INV-03/05 | 现键只含固定字符串字段，doom_loop input/workflow tools 不入键 | 同一缓存 owner 对所有 permission 泛化，无需按名称禁用缓存或对未知对象序列化 |
| Session-last ceilings | INV-02/05 | 普通工具 Agent→Session 顺序已存在 | 防止 caller Agent ask 覆盖 Session deny，不修改 producer或反查历史 |
| V2 configured automatic + reply `.rules` | INV-01/02 | V2 auto resources 为空会提前返回；reply 是 configured 第二消费者 | 在同一 configured owner 返回事实，不建立第二求值器 |
| native read 复用 `hasSensitivePath(tokens, true)` | INV-02/04 | 原始 read harness general；R8 B-02 证明共享重写会侵入非 auto Execute shell | nativeRead=true 才启用扩展匹配；默认 false 保留 shell 旧分支，避免 dashboard/.envrc 双向回归 |
| native-only basename `/\.env(?:\.|$)/` + 任意前缀 `.env`/`.env.*` 目录段 + Windows lowercase | INV-04 | R1～R3 ENV findings 与 R8 B-02 | 文件/目录/大小写需覆盖，但 shell 旧语义不能改；native 分支同时满足两类要求 |
| 新 Schema/配置/marker/helper package | 无 | 现有接口足够 | reject：无独立需求，会扩大文件与生成面 |
| 强制 deny reviewer failure | 无 | 用户明确允许 auto 最终 fallback | reject：改变既有 fallback 契约且增加测试 hunks |

## 15. File-Level Change Plan


















| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |

| --- | --- | --- | --- |
| `packages/opencode/src/permission/index.ts` | modify | V1 当前 Session/Config auto 身份发现、非 auto 原 ruleset、auto effectiveRules/Session-last ceilings、NotFound、Execute autoPatterns | 约 32–48 个有效修改行，少量集中 hunks |
| `packages/opencode/src/permission/cache/session-cache.ts` | modify | 字符串 metadata 排序入键；非字符串 metadata 在 has/put 跳过缓存，不做未知对象序列化 | 约 8–14 行，少量集中 hunks |
| `packages/core/src/permission.ts` | modify | V2 configured 返回 automatic；evaluateInput 转换；reply 使用 `.rules` | 约 10–16 行，3 hunks |
| `packages/core/src/permission/precheck.ts` | modify | `hasSensitivePath` 增加 native-only 分支；native read 显式传 true，shell 默认 false 不变 | 约 8–12 行，2 hunks |
| `packages/opencode/test/permission/next.test.ts` | modify | V1 auto admission、ENV review、mixed/subagent、空 rules、default_agent、session-only、Session deny、非 auto 静态 Config allow 对照、NotFound 与 metadata cache | 约 80–130 行 |
| `packages/core/test/permission.test.ts` | modify | V2 对等覆盖及 mixed 预期 | 约 20–40 行 |
| `packages/opencode/test/permission/precheck.test.ts` | modify | 任意 basename ENV 形态、大小写、`.envrc` 与普通文件分类及 shell 对照 | 约 15–25 行 |
| `packages/opencode/test/permission/execute.test.ts` | modify | 父/叶 auto+ask、非 auto ENV Read、单独及混合 patterns 的 `.env.example` allow、非 auto/static-allow shell 分类保持 | 约 40–60 行 |
| `docs/proposal/opencode-sandbox-windows-design.md` | modify | 将旧“read 不纳入 auto”描述同步为统一 auto admission | 约 3–6 行 |
| `docs/plans/auto-mode-permission-ask-promotion.md` | add | 唯一 Canonical Plan/审计记录 | 本文档，不计生产 E |

本清单覆盖本 GOAL 从 HEAD 起的全部最终修改。最终 diff 如出现其他属于本 GOAL 的路径，必须先撤回，不得将其作为未记录的实现保留。无关既有 worktree 内容不属于本 GOAL。

## 16. TDD Behavior Slices











已确认的公共 seam：

- V1 `Permission.Service.ask`：捕获直接人工 Asked、auto ReviewStarted、最终 pending；不能覆盖 V2 或 producer 漏传身份。
- V2 `PermissionV2.Service.ask/assert`：捕获 effect、人工 pending 与 reviewer 路由；不能证明 V1。
- `PermissionPrecheck.evaluate`：捕获独立风险等级，不断言内部 helper。
- `Permission.Service.ask` + `Layer.mock(Session.Service)`：直接验证空 rules、无 metadata、default_agent 与 session-only auto 在公共入口的行为，不依赖 producer 专用 fixture。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 已运行临时 harness：auto env 首事件应 ReviewStarted，实际 Asked | V1 matchRequest 直接 needsAsk | V1 per-resource ask→auto；非 auto 对照仍 ask | V1 主修复及原始症状 |
| 2 | 已运行临时 harness + R9 扩展：native Read 的 dashboard.env(.local)、`.env.local/` 目录应 cautious，普通文件与 `.envrc` 不升级；Windows 大写命中；shell 分类不变 | native read 未复用谓词，但共享重写会侵入非 auto Execute shell | precheck `hasSensitivePath(tokens, nativeRead)`，仅 true 使用扩展匹配；Execute 非 auto 保持 general | ENV 文件/目录、普通 Read、静态 allow 与既有 shell 分类 |
| 3 | V1 mixed auto+ask：全部经 auto，非 auto mixed 仍人工 | 当前另一个 ask pattern 独立 pending | 同一 matchRequest 修改；既有 fallback 测试不动 | allow/deny/cache/fallback |
| 4 | V2 auto agent/env 与 mixed effects 对等测试 | auto resources 为空提前返回；mixed 仍 ask | configured/evaluateInput 修改 | V2 ask/assert、remembered allow、fallback |
| 5 | 在真实 Permission.ask 使用派生 agent/session rules：parent ask/child auto 应先转 auto；纯 evaluate/derive 断言不变 | R1 纯函数 slice 不经过 matchRequest，无法红 | 在 `next.test.ts` 增加运行时 seam，不改 derive 或纯函数测试 | 子代理继承、具体 deny、测试敏感性 |
| 6 | 中央 Session harness：Session=auto、ruleset=[]、无 agent metadata，workflow_tool_approval 不得直接人工 pending，应沿现有 general auto fast path 完成；在 `next.test.ts` 固化 synthetic permission、default_agent 自定义 auto 与 session-only auto | 当前 matchRequest 只看请求 metadata/rules，首先 Asked；但 general 本就不产生 ReviewStarted | 公共入口从当前 Session/Config 补齐上下文，Session ceilings 最后；非 auto 对照仍人工；不要求 general 调 reviewer | 任意 synthetic permission、普通工具、显式 allow/deny/raw deny；ENV cautious/strict 才断言 ReviewStarted |
| 7 | ExecuteReview 父/叶 auto+ask 不直接 pending；非 auto ENV Read 仍人工；单独及混合 auto+allow patterns 的 `.env.example` 均不进入 reviewer；shell 分类不变 | 全量 request precheck 会把静态 allow ENV 混入另一资源的 auto 审查 | auto 时 check 只接收 matched.autoPatterns；非 auto 原 request/general；shell false 不变 | 父/叶、多 pattern 静态 allow、既有 shell 分类 |
| 8 | default_agent 为自定义 auto agent、非 auto agent 携带 session-only auto ceilings 均不直接 pending；非 auto 且无 auto rules 对照不变 | 请求自身可能完全缺少这些上下文 | Config/default_agent/fromConfig + current.permission，均在同一 matchRequest | 自定义 agent、子代理继承、非 auto 对照 |
| 9 | V2 pending Always 释放回归 | configured 返回形状变化可能影响 reply 第二消费者 | reply 只机械取 `.rules` | remembered allow/denied/pending release |
| 10 | 原始 Read harness 与中央 Session harness 全绿，相关文件回归与 typecheck | 前序任一路径漏改都会失败 | 只做已批准行为 | 原始症状、公共上下文与 V1/V2 兼容性 |
| 11 | strict 下同工具不同 failed input 均触发 reviewer；相同字符串 metadata 保持缓存命中；结构化 metadata 不发生序列化异常 | 当前 canonicalKey 不含 tool/input，第二次不同 input 会错误命中 | 字符串 metadata 排序入键；非字符串 metadata 在 has/put 跳过缓存 | doom_loop/workflow、普通 cache、circular/BigInt 输入 |
| 12 | metadata.agent 始终优先；缺省 synthetic 请求使用当前 Session/default auto，非 auto Session 对照不变 | 空 rules/缺 metadata 无法证明当前 auto | 当前 Session/Config 解析，不反查历史或修改 producer | 普通工具身份、synthetic 空上下文、非 auto 对照 |
| 13 | Session service 存在但 get 返回 NotFound 时，caller allow/ask 仍按原规则返回且不抛新错误 | 直接 Session 查询会泄漏 NotFound | 仅 catchTag NotFound 为无上下文，其他错误不吞 | 公共 ask 错误联合、无 Session 嵌入环境 |
| 14 | caller 为 Agent doom_loop=ask、Session 为 doom_loop=deny 时必须 deny；普通 caller allow 在无 Session ceiling 时不变 | caller-last 会让 Agent ask 覆盖 Session deny | auto effectiveRules 中 Session ceilings 最后 | doom_loop deny、普通 Agent→Session 顺序、raw deny |
| 15 | 非 auto、空 caller rules、Config 对 permission=allow 时仍按 HEAD 人工 ask；auto 对照才使用补齐规则 | 全量重并会把非 auto 从 ask 变为静态 allow | 非 auto 原 caller ruleset；auto 才用 effectiveRules | 非 auto 成功/人工路径不变、auto 身份发现 |

每个 slice 先观察当前实现失败，再写最小生产修改；测试预期来自用户契约和独立字面结果，不复制候选求值函数，不测试私有方法。






## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 200–345（生产 55–90，测试 145–255；按实际计算） | 排除空行、import-only、formatter-only、generated、pure-move 和 Markdown |
| Required Chinese explanatory comments `C` | 按上界预留至少 52；实际必须 `C >= max(1, ceil(E * 0.15))` | 按最终生产+测试有效行重新计算，不用拆行凑数 |




















必须有价值的注释位置：


- V1 当前 Session/Config 上下文：说明 selected agent 来源、Session-last ceilings，以及不导入 Agent.Service 的循环依赖边界。
- V1/V2 auto admission：说明 auto action 同时承载子代理继承，ask 只在请求局部提升；allow/deny/raw deny 不改。
- precheck：说明 basename 正则覆盖 `*.env`/`*.env.*`，Windows 与 Wildcard 共用忽略大小写语义；shell 默认分支不变。
- ExecuteReview：说明只有 matched.needsAuto 才能启用新增 native-read 分类，非 auto 与静态 allow 不被 reviewer 截获。
- synthetic/default_agent/session-only 测试：分别说明空请求、配置默认和 Session ceilings 的测试意图，避免只靠请求 rules 碰巧含 auto 而假绿。
- Session NotFound：说明无可补充上下文不能新增错误；当前 Session/default 只在请求缺省时使用。
- Session ceilings：说明 Session permission 最后，防止 caller 的 Agent ask 覆盖 deny。
- cache：说明字符串 metadata 入键、结构化 metadata 跳过缓存是为完整审批载荷隔离且避免未知对象序列化。
- mixed auto+ask/fallback：说明运行时 Permission seam 锁定 auto 优先，纯 evaluate/derive 与 reviewer unavailable 合同不变。

## 18. Verification






| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test "D:/Temp/opencode/auto-mode-session-context-repro.test.ts"` | `packages/opencode` | 中央 Session 红色反馈实施后转绿 |
| `bun test "D:/Temp/opencode/auto-mode-ask-repro.test.ts"` | `packages/opencode` | 原始 Read/ENV 反馈为 2 pass/0 fail；无真实凭据读取 |
| `bun test test/permission/next.test.ts test/permission/precheck.test.ts test/permission/execute.test.ts test/agent/plan-mode-subagent-bypass.test.ts` | `packages/opencode` | V1 admission、公共 Session/Config、precheck、mixed、ExecuteReview、subagent 与 fallback 回归 |
| `bun test test/permission.test.ts` | `packages/core` | V2 ask/assert、mixed、fallback、reviewer 回归 |
| `bun typecheck` | `packages/core` | Core 类型与私有 configured 返回形状 |
| `bun typecheck` | `packages/opencode` | V1 Session/Config 公共路径类型 |
| `git diff --check` | repository root | 空白错误 |
| `git status --short; git diff --name-only; git diff --cached --name-only` | repository root | 本 GOAL 全部路径逐项属于 §15；无未记录实现，不混入无关 worktree |
| `git diff --numstat -- packages/opencode/src/permission/index.ts packages/opencode/src/permission/cache/session-cache.ts packages/core/src/permission.ts packages/core/src/permission/precheck.ts` | repository root | 4 个生产文件实际有效修改不超过 100 行 |
| `git diff --name-only -- packages/client/src/generated packages/client/src/generated-effect packages/sdk/js/src/gen packages/sdk/js/src/v2/gen` | repository root | 本 GOAL 新生成代码为 0 |

不得从 repository root 运行测试或 typecheck，不运行生成命令，不跳过失败。









## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1（Canonical Plan） | 不新增应用生产模块、测试文件、依赖或 patch |
| Files modified | 9：4 个生产文件、4 个测试文件、1 个设计文档 | 与 §15 完整清单一致 |
| Files deleted | 0 | 无 HEAD 中既有生产 workaround 文件需要删除 |
| Production lines | 4 个生产文件预计 55–90；**硬上限 100** | 用户硬约束，审计逐 hunk 验证 |
| Test lines | 预计 145–255 | 当前 Session/Config、Session ceilings、缓存、ENV、Execute 与 V2 行为矩阵 |
| Generated lines | Client/SDK generated、根 package/bun.lock、依赖 patch 均为 0 | 无公共 Schema/Protocol/HttpApi 或依赖变化 |

若完整需求不能在该预算内实现，不得以缩减行为换取通过；先修订同一 plan 并重新 full-scope 审计。






## 20. Real Risks and Open Decisions

- **有意优先级变化**：有效 ruleset 同时含 auto 与 ask 时，ask 会先转 auto；这会改变 mixed patterns 和 parent ask/child auto 的旧结果，必须由行为测试明确锁定，allow/deny 不得被放宽。


- **既有 fast path**：未知 non-bash 仍可能 general allow，这是用户要求复用的 auto 契约；本任务只补已观察的敏感 Read，不以“所有工具都可能敏感”为由扩张分类器。
- **公共上下文优先级**：补齐规则只用于 auto 身份发现和 auto 求值；非 auto 继续原 caller ruleset，避免 Config 静态 allow 改变 HEAD 人工行为。auto effectiveRules 中 Session ceilings 最后，不同 action 不去重。无 Session service 或 NotFound 时保留请求原行为，其他错误不吞。
- **缓存身份**：字符串 metadata 全量排序入键，结构化 metadata 直接跳过缓存；相同可入键上下文仍可复用，不同/结构化载荷不复用，不引入未知对象序列化错误。
- **依赖方向**：Permission 可使用只依赖 PermissionV1 Schema 的 Session.Service，但不得反向导入运行时依赖 Permission 的 Agent.Service。
- **ENV 影响面**：扩展 basename/目录与 Windows 大小写只服务 nativeRead=true；shell 默认 false 完整保留旧 `.envrc`、dashboard.env 和目录分类，非 auto Execute 不新增或降低审批。
- **fork 分歧**：upstream v1.19.5 没有本地 auto 能力，不能整文件覆盖；本任务只收敛公共入口，不删除 external_directory 等本地能力。
- **测试 seam**：纯 evaluate/derive 仍是 last-match-wins，不能验证请求局部提升；运行时测试必须在 Permission.ask 证明修复前变红。
- **无关 worktree**：当前存在多个其他 plan；`bun.lock` 在本任务已恢复后又被外部删除一行 console 注释，该变化不是本 GOAL 设计内容，不覆盖、不暂存、不提交。相关路径若继续出现外部修改，停止并请求处理。

### Open Decisions Requiring the User

无方案开放决定；R17 已获 full-scope `No blocking findings / APPROVE`。当前等待独立实现审计。



























reviewer 失败后的边界已明确：复用现有 auto 最终 unavailable/fallback 逻辑。

### Rejected Speculation


- 不假设所有非 bash 工具都需要 cautious；没有对应 producer/症状证据。
- 不新增 auto marker、公共 mode 字段、Agent.Service 反向依赖或 producer 专用接线。
- 不强制 reviewer 每次调用 LLM；safe/general fast path 是既有 auto 主契约。
- 不强制 reviewer failure deny；用户已明确拒绝这种替代。
- 不新增 provider patch、依赖升级或远程协议行为。
- 不将 Question 工具或普通用户问答纳入权限审批转换。

## 21. Audit Contract










The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, the production ≤100-line constraint, and the 15 percent Chinese explanatory-comment plan.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 `dashboard.env.*` 仍会绕过 reviewer 并直接放行（Blocking）；B-02 workflow 将一次 auto 批准扩大成整个工具名的会话级放行（Blocking）；B-03 workflow 仍丢失仅存在于 session rules 中的 auto 上下文（Blocking）；B-04 doom_loop 同样丢失 session-only auto 上下文（Blocking）；B-05 子代理 TDD slice 不能对原缺陷形成红色反馈（Blocking） | 无额外非阻塞项 | **BLOCK** — 不得批准或实施 R1。修正 B-01～B-05、递增 canonical revision 后，需要重新进行完整范围的 plan audit。 | adversarial-auditor task `ses_e3db29bbbffeSOAuVjvyWT5HSt` |
| 2 | R2 | yes | B-01 workflow 的人工基线会覆盖显式 deny（Blocking）；B-02 workflow 的 Permission 缓存仍未区分完整 args（Blocking）；B-03 保留宽泛目录匹配会使嵌套 `.envrc` 仍被误判（Blocking）；B-04 ExecuteReview 的变更路径没有行为测试或回归命令（Blocking） | 两项：V1 分支比较不能外推 V2；E/C 上界须按最终值计算 | **BLOCK** — 不得批准或实施 Canonical Plan **R2**。需要递增 revision，修复 B-01～B-04，并对新 revision 重新进行完整范围 plan audit。本轮仅进行了源码、测试和只读 git 检查，未修改文件或实施代码。 | adversarial-auditor task `ses_e3d9a9c54ffe3VVBR42fw4oeuu` |
| 3 | R3 | yes | B-01 workflow 的默认人工 ask 被改成静态 allow，绕过 auto 审批（Blocking）；B-02 ENV 目录收窄会使既有敏感 shell 读取从 cautious 降为 safe（Blocking） | 测试行数估算漂移；实际 C 必须按最终 E 计算 | **BLOCK** — 不得批准或实施 Canonical Plan **R3**。需要递增 revision，修复 B-01、B-02，并对新 revision 重新进行完整范围 plan audit。本轮未修改文件或实施代码。 | adversarial-auditor task `ses_e3d859bbeffeHmMj1aQiXwmkjO` |
| 4 | R4 | yes | B-01 Workflow 的自动审批仍可被工具名级预批准绕过（Blocking）；B-02 新增 native Read 分类会侵入 ExecuteReview 的非 auto 与静态 allow 路径（Blocking） | V2 configured 的 reply 第二消费者需同步记录；生产估算需随修复更新 | **BLOCK** — 不得批准或实施 Canonical Plan **R4**。需要递增 revision，修复 **B-01、B-02**，并对新 revision 重新进行完整范围 plan audit。本轮仅进行了源码、依赖源码、测试、临时 harness 和只读 git 检查；未修改文件、未实施代码、未运行测试。 | adversarial-auditor task `ses_e3d739293ffe4q8OSa5KzgUgtm` |
| 5 | R5 | yes | B-01 全局清空 provider 默认预批准会使 Core V2 workflow 无法完成审批（Blocking） | 无额外非阻塞项 | **BLOCK** — 不批准 Canonical Plan **R5**，不得据此实施。需要递增 revision，收窄 provider 默认值修改的作用域并补齐 Core V2 回归验证，然后重新进行 full-scope plan audit。 | adversarial-auditor task `ses_e3d5a506bffe7UeSmvyxJo4SIi` |
| 6 | R6 | yes | B-01 Workflow 过滤会吞掉用户显式通用 allow（Blocking） | §18 numstat 占位命令需替换实际路径 | **BLOCK — Canonical Plan R6 不得批准或实施。** 这是记录中的第 6 轮 plan audit，已达到迭代上限；B-01 保持为 **blocking open decision**，不得因轮次耗尽而降级或撤回。 | adversarial-auditor task `ses_e3d488914ffe1o34FgYdTEQGZa` |
| 7 | R7 | yes | B-01 混合 allow/ask 的 Read 仍会被整工具名预批准（Blocking）；B-02 按 sessionID 修改 provider 默认值会给非 auto V1 新增人工审批（Blocking） | numstat 占位与估算需更新 | **BLOCK — Canonical Plan R7 不得批准或实施。** 需要递增 revision，修复 **B-01、B-02**，更新对应 workflow 行为测试与估算，然后重新进行 full-scope plan audit。本轮仅进行了源码、依赖源码、测试和只读 git 检查；未修改文件、未实施代码、未运行测试。 | adversarial-auditor task `ses_e3c80bb7cffeGmGckAg8YhNC2c` |
| 8 | R8 | yes | B-01 Workflow 的空预批准配置会污染后续非 auto 请求（Blocking）；B-02 共享 ENV 谓词重写侵入非 auto Execute shell 分类（Blocking） | §7/§11/§12 初始列表记录需统一 | **BLOCK — Canonical Plan R8 不得批准或实施。** 需要递增 revision，修复 B-01、B-02，并重新进行完整范围的 plan audit。 | adversarial-auditor task `ses_e3c7096ceffe9jqkHDoongI9Os` |
| 9 | R9 | yes | B-01 共享缓存模型的逐流预批准配置会在并发请求间串流（Blocking） | N-01 numstat 占位命令需替换实际路径 | **BLOCK — 不得批准或实施 Canonical Plan R9。** 需要修复 B-01、递增 canonical revision，并重新进行完整范围的 plan audit。本轮仅进行了源码、依赖源码、测试、文档和只读 git 检查；未修改文件、未实施代码、未运行测试。 | adversarial-auditor task `ses_e3c606bcfffe8je32WCqgvMYUo` |
| 10 | R10 | yes | B-01 doStream 内快照仍无法隔离调用前的共享模型覆盖（Blocking） | N-01 生产行数验证命令仍含占位符 | **BLOCK — 不得批准或实施 Canonical Plan R10。** 需要修复 **B-01**、递增 canonical revision，并对新 revision 重新进行完整范围的 plan audit。本轮仅进行了只读源码、依赖源码、测试和文档检查；未修改文件，未实施代码，未运行测试。 | adversarial-auditor task `ses_e3c5205b8ffe9H73aUeQWSKEkH` |
| 11 | R11 | yes | 初审 B-01 父 Execute probe 绕过 non-auto/静态 allow 分类豁免；复查确认父递归 `patterns: []`，新谓词无路径输入，撤回该 blocker，最终 **No blocking findings** | N-01 numstat 占位命令已替换为实际路径 | 初审 **BLOCK**；同一 auditor 复查后 **APPROVE — Canonical Plan R11 通过 full-scope plan audit。** 本结论仅适用于 exact R11，不适用于 R12。 | adversarial-auditor task `ses_e3c44b3fcffeBtPIDDJf7Ox7HB`（含复查） |
| 12 | R12 | yes | 初审 B-01～B-04；同一 auditor 复查后明确“原 B-01 撤回，不再作为阻塞项”，因为 provider 预批准不形成 Permission Ask 且未被本 diff 改差。最终阻塞仅为 B-02 doom_loop 缓存、B-03 历史 agent、B-04 Session NotFound | N-01 upstream 证据需精确记录；N-02 复查确认 workflow/manifest/patch 路径干净，但 bun.lock 出现一行外部注释删除 | **BLOCK — 不得批准或实施 Canonical Plan R12。** 阻塞依据仅为 **B-02、B-03、B-04**。原 B-01 已独立撤回，R11 的旧批准仍不适用于 R12；剩余问题继续作为 **blocking open decisions** 保留。 | `ses_e3ae2dfdcffeOYraLojRnN9i3m`（含复查）；首次中止调用 `ses_e3b14eec9ffeAOw4qpr5cc0qpq` |
| 13 | R13 | yes | B-01 Workflow 的一次自动批准仍会扩大成整个工具名的会话级放行；B-02 Caller-last 合并会让 doom_loop 的 Agent 规则覆盖 Session deny | 无额外非阻塞项 | **BLOCK — Canonical Plan R13 不得批准或实施。** B-01、B-02 保持为 **blocking open decisions**。用户先授权继续 R14，随后明确禁止任何前置 producer/provider 接线并要求只在内部抽象处理边界；R14 按该更新后的完整需求修订。 | `ses_e3a917085fferg2LdVIS2vK8cB` |
| 14 | R14 | yes | B-01 `findMessage` 会把上一轮身份误认为当前 synthetic 请求身份；B-02 ExecuteReview 会让静态 allow 的 ENV 资源混入另一资源的自动审查 | 无额外非阻塞项 | **BLOCK — 不批准 Canonical Plan R14，不得据此实施。** 需要递增 revision，修复 B-01、B-02，并重新进行 full-scope plan audit。 | `ses_e3a640faaffe7wR5btDj5mGBf9` |
| 15 | R15 | yes | B-01 V1 上下文补齐会将非 auto synthetic 请求从人工 ask 改为静态 allow | 无额外非阻塞项 | **BLOCK — 不批准 Canonical Plan R15，`Implementation allowed` 必须保持 `no`。** 需要递增 revision，修复 B-01 并补齐对应非 auto 回归测试，然后重新进行 full-scope plan audit；当前不得实施或提交。 | `ses_e3a4bf9afffe6Zh0WukHQP73E6` |
| 16 | R16 | yes | B-01 Session 上下文测试切片要求了不会发生的 ReviewStarted | 无额外非阻塞项 | **BLOCK — 不得批准或依据 Canonical Plan R16 实施。** 修复 B-01、递增 canonical revision 后，需要重新进行 full-scope plan audit。 | `ses_e3a36cd11ffeAtLbjhyTu4k8tO` |
| 17 | R17 | yes | No blocking findings. | 无。 | **APPROVE — 仅批准 Canonical Plan R17。** 本结论只适用于本次读取的 `docs/plans/auto-mode-permission-ask-promotion.md` **R17 exact revision**，不批准当前未提交实现、其他 worktree 修改或提交操作。由主代理按规范记录 verdict 并将该 exact revision 标记为 approved 后，才可实施；完成后仍需完整独立 implementation audit。 | `ses_e3a22dd77ffetbBSg7c33Q74xo` |

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without paraphrasing. A clean verdict may update only the administrative approval fields for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

R17 已按批准范围实施。实际路径逐项匹配 §15：4 个生产文件、4 个测试文件、1 个设计文档及本 Canonical Plan；未修改 producer/provider、根 manifest、依赖 patch 或 generated。

### Actual Files and Diff

| 类别 | 实际路径 | 结果 |
| --- | --- | --- |
| V1 生产 | `packages/opencode/src/permission/index.ts`、`permission/cache/session-cache.ts` | 当前 Session/Config 上下文、非 auto 原 ruleset、auto effectiveRules/Session-last、autoPatterns、metadata cache |
| Core 生产 | `packages/core/src/permission.ts`、`permission/precheck.ts` | V2 ask→auto 与 reply `.rules`；native ENV cautious |
| 测试 | `packages/opencode/test/permission/{next,execute,precheck}.test.ts`、`packages/core/test/permission.test.ts` | 公共 Permission、Execute、precheck、cache、V2 行为矩阵 |
| 文档 | `docs/proposal/opencode-sandbox-windows-design.md`、本 plan | 同步统一 auto admission 与实施证据 |

生产 numstat 为 81 additions / 31 deletions；独立实现审计按完整口径计算有效生产代码 `E=59`，低于 100 行。测试有效代码 `E=268`。无新增或删除 HEAD 文件，无 generated diff。

### Red-Green Test Evidence

- 原始 Read/ENV harness：规划前两次均 0 pass/2 fail；实施后 2 pass/0 fail。
- 中央 Session harness：规划前及实施前均 0 pass/1 fail，Expected auto / Received ask；实施后 1 pass/0 fail。
- 永久 Session 测试：旧 automatic/matchedRules mutation 下 4 fail/2 pass（两个非 auto 对照按预期通过）；恢复 R17 后 6 pass/0 fail。
- cache：修复前同值命中后不同字符串 metadata 错误返回 true，Expected false / Received true；实施后 1 pass/0 fail，含结构化及 circular 输入。
- Execute 混合 patterns：修复前静态 allow ENV 使 reviewer 被调用，Expected [] / Received ["execute"]；实施后 1 pass/0 fail。
- V2 与 native ENV 保留规划前红色证据，相关回归现均通过。

### Verification Commands and Results

规划阶段已执行：

- 原始 Read/ENV harness 两次均稳定复现 `ask` 与 `general`。
- 中央 Session harness 实测 Session=auto、空请求上下文仍首先 Asked，0 pass/1 fail。
- Core 内存候选求值探针输出 `autoEnv=auto`、`inheritedEnv=auto`、`nonAutoEnv=ask`、`autoWithoutAutoRules=auto`、`denyPreserved=deny`。
- Session/Config 候选探针输出 `defaultAuto=true`、`customAuto=true`、`sessionAuto=true`、`nonAuto=false`、`deny=deny`。
- ENV 谓词探针覆盖文件、目录、`.envrc` 和 Windows/POSIX 大小写边界。
- upstream v1.19.5/v2.2.5 只读比较确认没有可直接同步的同构 auto 修复。

实施后执行：

| Command | Working directory | Result |
| --- | --- | --- |
| `bun test "D:/Temp/opencode/auto-mode-session-context-repro.test.ts"` | `packages/opencode` | 1 pass / 0 fail |
| `bun test "D:/Temp/opencode/auto-mode-ask-repro.test.ts"` | `packages/opencode` | 2 pass / 0 fail |
| `bun test test/permission/next.test.ts test/permission/precheck.test.ts test/permission/execute.test.ts test/agent/plan-mode-subagent-bypass.test.ts` | `packages/opencode` | 277 pass / 0 fail，1060 assertions |
| `bun test test/permission.test.ts` | `packages/core` | 18 pass / 0 fail，349 assertions |
| `bun test test/permission/next.test.ts --test-name-pattern "synthetic permission\|auto effective rules\|non-auto synthetic\|missing session\|cache - isolates metadata"` | `packages/opencode` | 7 pass / 0 fail |
| `bun typecheck` | `packages/core` | pass |
| `bun typecheck` | `packages/opencode` | pass；修正测试 fixture readonly 与 helper 泛型后通过，未改生产行为 |
| `git diff --check` | repository root | pass |
| generated paths `git diff --name-only` | repository root | 空 |

测试环境修正：Config override 移入 layer graph，避免已构造 Permission 捕获旧 Config；`Session.Info` 使用带品牌的直接字面量，`raceSynthetic` 保留环境泛型。均未降低断言或跳过失败。

实现审计 round 1 的 B-01 修复后复跑：V1 相关回归 277 pass / 0 fail，Core V2 18 pass / 0 fail，两条原始 harness 合计 3 pass / 0 fail，`packages/core` 与 `packages/opencode` 的 `bun typecheck` 均通过。

### Original Feedback-Loop Result

两条原始反馈均已用原命令转绿：Read/ENV 为 2 pass/0 fail，中央 Session 为 1 pass/0 fail。未读取真实凭据，未调用 provider/network。

### Actual Secondary and Replacement Path Inventory

实际新增 alternate success path=0，diagnostic path=0。非 auto 继续原 caller ruleset；auto general fast path、cautious/dangerous reviewer、forbidden deny、remembered allow 和 reviewer unavailable/fallback 都是既有主合同分支。Session NotFound 仅表示无可补充上下文，不产生成功结果；结构化 cache bypass 后仍进入同一 PermissionAuto，不形成替代审批路径。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |

| --- | --- | --- |
| Effective changed code lines `E` | **327**（生产 59，测试 268） | 独立审计从 409 个新增/修改行排除 21 空行、6 import-only、52 注释、2 formatter-only、1 pure-move；Markdown 不计 |
| Qualifying Chinese comment lines `C` | **52**（生产 17，测试 35） | 邻近修改点，解释 Session/非 auto 边界、Session ceilings、autoPatterns、cache 安全、ENV 平台语义和测试意图 |
| Ratio `C / E` | **15.90%** | `52 / 327` |
| Required minimum `C` | **50** | `ceil(327 * 0.15)=50`；实际 52，满足 |

代表性注释：`非 auto 仍按原 caller ruleset`、`Session ceilings 最后`、`auto 叶子只审查 autoPatterns`、`结构化 metadata 不参与未知对象序列化`。这些均解释不可放宽的权限或缓存边界。

### Remaining Unverified Items

批准范围内的行为、原始反馈、相关回归、typecheck、E/C 和生产行数均已验证。未运行全仓库测试套件，未做真实 provider/network 调用或真实凭据读取；这些不属于本 plan 的验证承诺。当前等待独立 full-scope implementation audit。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R17 | yes | B-01 新增 Session NotFound 分支违反包级 `Effect.void` 强制规约 | 无。 | **BLOCK**。当前结论仅适用于 **Canonical Plan R17 与本次实际 HEAD diff**。必须先修正 B-01；随后需要重新进行完整范围 implementation audit，并在放行前取得相关 Bun 测试及两包 typecheck 的可复现通过结果。 | `ses_e39a7ce98ffe0qSdIghq0ST2M0` |
| 2 | R17 | yes | No blocking findings. | N-01 Core 测试在并行验证负载下出现一次超时；随后无并发负载原样复跑 18 pass / 0 fail，349 assertions。该现象未复现为当前 diff 的行为回归，但不宣称所有并发负载下都不会超时。 | **APPROVE** — 仅适用于 **Canonical Plan R17** 与本次审计列出的十个路径的完整 HEAD diff。当前实现通过本轮 full-scope implementation audit，可以进入既定的 verified 状态记录流程；本结论不授权提交、推送或纳入其他工作树修改。 | `ses_e3984344bffemwaeiArcwQmXOd`（含只读验证续审） |

The task may be marked `verified` only after an independent full-scope result of `No blocking findings` for the current implementation and approved plan revision.