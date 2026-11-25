# Canonical Implementation Plan: 会话选择与内置 Auto 默认值

> Status: verified
>
> Revision: R9
>
> Approved revision: R9 (user-directed scope reduction from R8)
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户原文，§1
>
> Implementation allowed: verified; implementation frozen for scoped commit
>
> Last updated: 2026-11-26

唯一计划。固定实施前基线 `07395e4a82d40d950e6c83186cbbbf51680b6888`。先前 R6 已完成 Verified Plan；本轮目标为 `verified-implementation-and-commit`，使用 `git commit --only` 隔离其他人的工作树和暂存修改。

## 1. Verbatim Requirement

> 这一块怎么办呢？你看一看现有的所有的切换逻辑，或者说它的这个使用源能不能让把它做一个调整或者优化。你看如果做优化的话，应该怎么做调整做优化？我希望以最少的这种代码的修改和最小的模型破坏，来实现对应的一个效果。就是不管怎么样，就是如果用户有自己的选择，就用用户的选择。如果没有用户的选择，就直接用上一次的模型。然后同时这个对应的这个Agent模式也是要么用上一次选择，要么是用这个用户的一个模选择。用户有选择就用用户的，而且这个用户不随着刷新而变化。

> OK，那默认值，这个default model这个东西，能不能让这个随着二进制一块？就不要说让用户再去手动配这个default model的JSON配置。我希望这个default model就是呃就是呃说错了，这个default agent默认就是AUTO。

> OK，那你读取一下Document里面有个Guide里面有个Workflow逻辑流程。按照Workflow的Markdown来去做。然后生产代码的一个修改行数，我的给你的上限是修改160行以内。然后同时请注意一点，保持你的Hunk修改的面尽可能少，同时你代码不要以压缩的形式去进行给出，因为你压缩的话，你本身格式化之后还会再展开，所以避免把代码写得很长，因为用户的需求其实很简单，请注意一点，用户的需求很简单。如果旧的逻辑有问题，你直接把旧的去做个精准替换就OK了。不要说留两套分支啊，或者两套怎么怎么样。然后同时用户没有让你做的调整，不要去进行额外的一个接线啊以及调整这种。然后生产文件的修改个数呢，你保持在5个以内。然后测试的文件的修改个数呢，保持在4个以内。测试文件修改行数保持在160行以内。请注意这些内容，按照这套流程进行。最终验收状态为Verified Plan

场景：同一 TUI 打开旧会话、手选模型、发送、切到另一个终端、回来再发，以及撤回重发。最新范围只管运行时选择。

> 我听不懂什么是mini请注意这一点。我我我我不知道你说什么mini会显示成build这一行。按理来说用户的需求已经很清晰了，就是TUI呀就是TUI呀，不要去搞其他东西。请注意这一点。而且Core V2本身如果没有纳入生产逻辑，那就不需要去改呀。请注意这点。

> 按照Verified implementation and commit的逻辑，现在进行相应的修改。

R7 的额外一轮计划审计由用户明确授权：“同意追加一轮 (Recommended)”。文件与行数上限不变。

R8 用户直接放行剩余实施：“那你就实施呗，实施完之后你把对应的Plan的对应章节给它移除掉不就好了？剩下的内容原样按照plan实施，不要去新增东西不就OK了？” 本修订未单独进行计划审计；保留实施验证与独立实现审计。

> 说过了不要调用Task进行实现。调用Task实现它只会扩张你的方案。
>
> 什么叫同意退出Play？没有人让同意退出Play呢，哪有这种逻辑呀？ Agent它自己肯定不能调用什么同意退出Play后立即关窗，这什么鬼东西啊？不要去加这种恶心的逻辑。
>
> 以及不只有这个对应的模型要恢复，对应模型的档位也是啊，模式的档位也不能乱动。
>
> 用户已经说的很清晰了，这整个都是关于TUI的东西，和落盘和存储没有任何关联。
>
> 譬如你的方案里面没有对档位进行测试，那你就不要去添加这些测试。
>
> 你的换言之，你修改的新增的每一行的长度的平均值不得超出我们旧的整个文件的平均值。

R9 用户限定手选入口，原文：

> 这样吧，我把我的需求细化一下。用户有选择就用用户的选择，这里指的是用户的选择，指的是用户通过 Ctrl 加 P 打开命令面板，选择 Switch Mode，并选择对应的模型，按回车。或者用户选到 Switch Agent，并在其中选择 Agent。或者用户按 Ctrl X 加 M 选择模型，这其实这本质也是在命令面板选择。或者用户按 Tab 键切换模型，切换 Agent。或者用户按 Ctrl T 去切换退力档位。或者用户在命令面板选择 Switch Model Variant。就这么几种，其他都不要去写，其他都不要去管，其他东西都是移除掉。
>
> 什么叫原本就在？没列出的循环功能。你说的其他移除是指哪一种？其他移除是你不要进行任何 Git 改动。
>
> 保持准确，不要施加用户没有让你去施加的额外Git改动。

追加实施审计轮次的授权原文：

> 授权你进行额外的六次的实现审计，但我希望你一次做好，不要在这个地方改改改改改，这很麻烦，按照workflow进行。

用户后续授权提交后推送，原文：

> 没有问题的话，最终你在commit之后，你可以进行一次push。但是push请注意，你要只push你所commit的这个内容，因为它会跑一个pre hook，就是pre push的hook，pre push它会触发preflight等等一些东西，避免让当前工作区的一些内容去影响到你这个pre push的hook的一个跑，就因为它会测一些这个呃这个节点的一些type check啊等等一些东西，它会跑一些smoke test。

命令名以仓库现有 `Switch model` 为准；Tab 现有绑定是切 Agent。最近模型、收藏循环、CLI 启动、Question、工具自动切 Agent 的调用点保持基线，不作为本次手选入口。以下 R9 范围取代旧轮次增加的处理要求。

## 2. Explicit Non-Goals

范围只限普通交互式 TUI。它随二进制发布、请求中显式传 Agent；不改服务端的省略参数默认、Core V2、mini、Web、桌面、默认模型、权限、数据库、SDK、daemon 重连或 Undo/Redo。没有跨机器偏好漫游。

## 3–4. Repository Context / Files and Evidence Read

|文件（相对仓库根）|决定本设计的事实|证据|
|---|---|---|
|`docs/guides/workflow.md`、`.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md`、`AGENTS.md`、`packages/opencode/{AGENTS.md,test/AGENTS.md}`、`CONTEXT.md`、`docs/adr/README.md`|计划与实施分门禁；package-local 验证；Session 历史和 provider 执行独立。无 Agent 默认或 TUI 选择 ADR。|contracted|
|`packages/tui/src/context/local.tsx:64–130,151–259,289–452`、`component/dialog-{agent,model,variant}.tsx`、`src/app.tsx:574–593,719–730,768–873`（组件路径均相对 `packages/tui/src`）|同一 initialized 位被三个字段认领；现行模型按 Agent；恢复直接传入消息对象；启动参数先在首页应用；新会话只导航。|observed|
|`packages/tui/src/context/{sync.tsx:408–444,925–933,1081–1118,1498–1507,1591–1695,1736,sdk.tsx:76,140–165,route.tsx:27–42}`、`src/attention.ts:129–143`|已有带租约的 Session detail/page 原子合并；成功空页与失败页有区别；全局 ready、SSE 来的 user、300 条缓存都不能证明首屏完整；焦点没有选择写入。|observed|
|`packages/tui/src/routes/session/{index.tsx:314–320,340–375,473–542,1212–1270,1979–2005,dialog-message.tsx:48–93}`、`component/prompt/index.tsx:1125–1179,1255–1267,1318–1345,1707–1732`|路由获知就绪/呈现输入框；Prompt 的 disabled 防早发；Retry 读当前选择；真实 Plan 工具事件和 HTTP 页刷新的调用点不同。|observed|
|`packages/tui/src/{context/kv.tsx:15–29,54–61,util/persistence.ts:22–32,app.tsx:287–314,334–340,438}`、`packages/opencode/src/index.ts`|KV/model.json 整份快照存在跨窗口覆盖；原子同目录 rename 模式已有；退出最终可结束进程。|reachable|
|`packages/sdk/js/src/v2/gen/types.gen.ts:184–236`、`packages/core/src/v1/session.ts:89–96`、`packages/opencode/src/session/{session.ts:495–518,726–747,792–827,prompt.ts:1096–1172,revert.ts:174–220}`|Session 已携带可选的 agent/model；普通 prompt 更新两项，fork 可以没有，两项不能保存客户端未发送的选择。|observed|
|`packages/opencode/src/agent/agent.ts:88–92,150–216,366–373,419–453`、`packages/core/src/{agent.ts:10,67–107,plugin/agent.ts:118–159,config/plugin/agent.ts:74–105}`、`packages/opencode/src/{cli/cmd/tui.ts,server/routes/instance/httpapi/handlers/instance.ts}`|有内置 Auto；列表和执行分别求默认；Core 的 defaultID 还用作 Build 的注册 ID、无 Info 标识；编译入口复用这些源。|observed|
|`packages/core/src/session/{projector.ts:576–593,message-updater.ts:113–134}`、`packages/opencode/src/{acp/service.ts:771–795,cli/cmd/run/runtime.lifecycle.ts:125,tool/plan.ts:50–76}`|native switch 会改共享执行状态/历史；mini label、ACP 和明确同意的 Plan 转换不决定 full TUI 无配置默认。|reachable|
|`packages/{core/test/agent.test.ts,opencode/test/agent/agent.test.ts}`、`packages/tui/test/cli/cmd/tui/{session-message-render.test.tsx:62–129,prompt-submit-transport.test.tsx:703–764,sync-live-hydration.test.tsx}`、`packages/tui/test/routes/session/auto-review-render.test.tsx:789–849`|可复用真实 Session/Prompt/SDK transport；旧默认和权限有各自断言。|observed|

## 5–6. Current Behavior / Supported Domain

`/agent → legacy list → Local.current → footer 与 promptAsync`。另一条是 `Session 首次访问 → 第一个可见缓存中的最后 user → model.set(msg.model) → Solid Store → message.updated / reconcile(page) → 下一次请求`。成功手选并不会解除旧的对象关联；concurrent TUI 提交可以改变共享 Session 行，但不是本窗口的手选。

|条件|生产路径与上游保证|owner / classification|
|---|---|---|
|有效显式 Agent、provider/model、CLI、快捷键|Agent 必须可见非 subagent；模型必须在当前目录；已经有校验|Local / contracted|
|正常、空、fork 或有撤回边界的会话|已取 Session detail 和有界时间排序页；`undefined` 的失败页不等于 `[]`；服务端不会随撤回回写旧模型|Sync 投影、Local 选择 / reachable|
|不同终端|各自的 Local 内存，另一个终端的发送只影响共享消息历史|Local / contracted|
|无配置、显式配置、Auto 不可选|TUI 已同时取得 `sync.data.agent`、`sync.data.config.default_agent`；服务端排序第一项可继续作为已有的配置/不可选回退|Local / contracted|

## 7–9. Invariants / First Divergence / Responsibility

|ID|必须保持的行为|第一次错误及负责修复的位置|
|---|---|---|
|S1|首个可发送帧按字段取手选，再取最后有效 user；无记录才用默认。|Local 提前认领缓存。Session 行也可能落后于 shell user（prompt.ts:898–919），非空不证明最新。|
|S2|运行中手选 Agent、模型及模型档位优先于历史刷新；实际请求读取同一选择。|Local 把历史模型对象引用当作可修改的当前模型，刷新可将它改回旧值。|
|S3|同一窗口按会话区分手选。新进程只从既有消息恢复已发送的选择。|手选与历史原先未隔离。无新增文件读写或存储需求。|
|S4|普通 TUI 无指定且 Auto 可选时显示并实际提交 Auto；带配置、明确手选和隐蔽/subagent 过滤保持。|目前 `agent.current()` 无当前值就取列表首项 Build。只改 Local 默认项，不改两个服务端 registry。|

**计划阶段反馈。** 在 `packages/tui` 用 `bun --conditions=browser -e` 驱动真实 `LocalProvider`（只替换网络、文件读写及上游 context），手选→插入 GPT 新 user→`reconcile` Kimi 旧行；输入框输出 `manual pick: Astra`、`append new user: Astra`、`live refresh old row: Old`、`HTTP page refresh old row: Old latest row: Astra`。撤回标记后重进也确实读到了被撤回的尾行。没有操作用户会话。

可重复的最小机制命令（PowerShell，工作目录 `packages/tui`），已执行，基线红 `actual: Kimi, expected: GPT`：

```powershell
bun --conditions=browser -e 'import {createStore,reconcile} from "solid-js/store"; import assert from "node:assert/strict"; const row=(id,modelID)=>({id,model:{providerID:"p",modelID}}); const [s,put]=createStore({rows:[row("u1","Kimi")]}); const [p,pick]=createStore({model:{}}); pick("model","auto",s.rows[0].model); pick("model","auto",row("u2","GPT").model); put("rows",reconcile([row("u1","Kimi"),row("u2","GPT")])); assert.equal(p.model.auto.modelID,"GPT")'
```

控制变量只改第一次赋值为 provider/model 两标量副本：同一刷新 `aliased:false, next:GPT, latest:GPT`；不复制 `aliased:true, next:Kimi, latest:GPT`。该命令解释机制；实施绿灯要跑真实组件/实际请求的 T1，不以这段独立命令替代。默认基线：legacy Agent 文件 48 pass；Core `bun test test/agent.test.ts` 7 pass。尚未声称候选产品代码或二进制已通过。

## 10. Single Primary Path

**Local 是普通 TUI 下一条请求的选择来源。** 只有模型选择框、Agent 选择框/Tab、档位选择框/Ctrl+T 写入会话手选值。模型和 Agent 选择框明确传手选标记；未列出的调用点与原有循环函数保持基线。手选值优先，首页 create 的回执把这次手选交给新 Session。

* **打开时只恢复一次。** Sync 在现有 detail/page 合并完成后发布就绪信号；释放或删除时清除。Local 从完整合并页的最后 user 复制模型与档位，沿已有 setter 恢复普通状态；恢复不写入手选。撤掉此前新增的撤回边界裁剪、Session 行补值、CLI 特殊优先级。
* **字段优先级。** 指定入口的手选值优先于原有状态。未手选时恢复最近 user，再沿用现有默认。手选 Agent 保留当前模型；手选模型与档位复制值，隔离历史对象引用。
* **仅内存。** 不新增偏好文件、数据库字段、写队列、退出逻辑或存储接口。既有收藏、最近模型和 variant 的用户偏好机制保持原样。
* **模型档位。** Ctrl+T 和 Switch model variant 的选择与对应模型一起保留；发送使用选定值。历史恢复仅把档位写入已有的按模型索引的内存表，并保留已经手选的档位；后续手调更新同一张表，避免切回模型时读到过期快照。恢复不调用偏好保存。Default 沿用现有显式含义。删除本次新增的档位下架处理、发送拦截与自动设 Default。不新增档位测试。
* **问答与工具。** 保持原有 Question、Session 路由和 plan 工具处理不动。不解释 Yes/No，不复制英文选项，不存批准意图或工具回执，不补发任何查询。普通终端重开只恢复输入框的选择，并遵从用户要求的手选优先。
* **默认 Agent。** 普通 TUI 优先手选/显式配置/历史，否则选可见的 Auto。Auto 不可选时保留原首项。选择器依然显示服务端提供的列表顺序，避免改变 Tab 循环约定；输入框和提交使用同一当前 Agent。

## 11–12. Secondary Paths / Workaround Deletion

|路径|分类 / 处置|
|---|---|
|指定入口的手选、最后 user、既有默认|手选优先；恢复读取已合并消息页。|
|旧消息对象与当前模型共享引用|setter 复制模型；手选保存在 Local 内存。原有未列入口的状态和调用保留，避免修改其代码。|
|既有默认链、recent/favorite、无效模型的诊断|沿用既有适用域；不增加备用成功路径。|
|每次重连重套手选、监视另一个终端、改数据库、添加 JSON 配置项、追加 timer|拒绝；绕过 Local 的错误写入或超出需求。|

## 13–14. Forward / Reverse Traceability

|要求 → 行为 → 验收|反向：为何需要这项改动|
|---|---|
|S1 → Sync 唯一成功页标记 / Local 标量 / 原有 Prompt 门 → T2|只有已合并页才能区分 stale HTTP、成功空页和失败页；不另发历史请求。|
|S2 → Local 保有独立标量、刷新不写选择 → T1/T2|源头引用在 setter，改发送/撤回不能消除它；独立字段防止选 Agent 又丢模型。|
|S3 → Local 会话内存、create 回执交接 → T2|只持有两个会话字段，退出后不另存。|
|S4 → Local 的可选默认 → T4/普通 TUI 二进制 smoke|服务器列表首项原为 Build；TUI 显式提交，改其他默认路径没有必要。|

## 15、19. File-Level Change Plan / Diff Budget

计数是**格式化后 `git diff --numstat` 的新增 + 删除**，不是净增。固定上限不借用另一类余量，不压行、多语句合行或整文件格式化。实施若超额，先收敛原逻辑；仍不能满足则停下，不擅自扩大。 每个代码及测试文件另外核算：`git diff -U0` 新增行字符数/新增行数，须 ≤ 固定基线整文件字符数/行数；两边均含缩进、原有空行，均不计换行符。

|拟改的现有文件|职责|增删合计预算|
|---|---|---:|
|`packages/tui/src/context/local.tsx`|指定入口的会话手选、历史恢复和 Auto。|141|
|`packages/tui/src/component/dialog-agent.tsx`|标记选择框操作为手选。|5|
|`packages/tui/src/component/dialog-model.tsx`|标记选择框操作为手选。|5|
|`packages/tui/src/component/prompt/index.tsx`|使用已选模型档位，首页创建后交接快照。|4|
|`packages/tui/src/context/sync.tsx`|发布现有成功页的就绪信号及释放。|5|
|`packages/tui/test/cli/cmd/tui/session-message-render.test.tsx`|既有真实 Session + Prompt 回归，验证刷新和撤回后的实际请求。|45|
|`packages/tui/test/cli/cmd/tui/prompt-submit-transport.test.tsx`|真实 create/submit、默认与显式选择、fixture 成功页。|92|
|`packages/opencode/script/smoke-opentui-artifact.ts`|编译产物检查 Auto 标签和首条用户记录。|20|

最多 **5 个生产文件 / 160 行，3 个测试文件 / 160 行**；局部 hunk，新增/删除文件 0，generated 0。文件间预算可在同一文件清单内收敛，类别硬顶不可变。计划文件不计入生产/测试。此为预算，不是实施 diff 实测值。

## 16–18. TDD Slices / Comments / Verification

|顺序|独立可见预期与基线失败原因|
|---|---|
|T1|从真实历史恢复，手选新模型，刷新、撤回，用恢复草稿重发；旧历史与实际请求分别保留原模型与手选模型。|
|T2|复用 T1 的实时 user 先到、HTTP 页后到场景，核对首个请求。复用首页选择模型再选 Agent 的提交测试，核对 create、普通请求和新会话选择。撤掉此前扩展的命令模型覆盖、撤回边界、失败重连等组合验收。|
|T3|仅运行时手选；不测试已取消的磁盘持久化或问题审批。没有新增档位用例。|
|T4|给普通 TUI 原服务端顺序 `[build,auto,…]`、无配置：默认标签与请求均为 Auto；已有配置/禁用对照保留。产物 smoke 只改 Auto 默认对应断言，撤掉新增的 `--build` 测试入口。|

测试不 mock Local 选择算法。真实 Session 从 Probe 暴露原 PromptRef，读实际 Request body；空页不等非空。`withPrompt` 仅挂 Prompt，没有 Session loader：已有 Session 用例在 fixture 提供真实 detail、成功 GET `/message` 空页、todo/status/goal/diff 后，显式 `await sync.session.sync(id)` 再提交；首页没有 ID 时保持原流程。override 按 method 和 path 分开记录，请求失败用例只令 POST `/prompt_async` 失败，GET `/message` 不增加提交次数；shell/command 同样断言各自 POST。断言实际请求到达后再检查草稿，不能用一次读页制造绿灯。

|工作目录|实施阶段命令 / 证明|
|---|---|
|`packages/tui`|`bun test test/cli/cmd/tui/session-message-render.test.tsx`（先红后绿）；`bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx test/routes/session/auto-review-render.test.tsx test/context/local.test.ts`|
|`packages/tui`|`bun test test/routes/session/question.test.tsx`，计划阶段基线 3 pass/0 fail。|
|`packages/tui` / `packages/opencode`|`bun typecheck`（TUI 包）；在 opencode 包构建单平台产物，以已有隔离 smoke 启动普通 TUI，不配 default_agent，验证输入框 Auto 与首条用户记录。不增加其他入口测试。|
|仓库根|`git diff --check`；`git diff --numstat 07395e4a82 -- <上述生产路径>` 与测试路径分组核算，审阅每个 hunk，排除他人的工作树变更。|

## 20. Risks / Open Decisions

历史恢复不关联批准、问题或工具记录。仅保存实际选择的字段；无外部客户端历史合并和后台重试需求。

|Follow-up|基线事实 / 处置|
|---|---|
|ACP 自定义 `mode: all` 展示|独立既有筛选问题，不纳入本任务。|
|B-05：外部 native 客户端与 full TUI 混用时的历史恢复|两个 full TUI 都发送 V1；外部 native 写另一个消息表，pre-R1/R3 均不合并。R2 复议改为 Follow-up，不增加跨协议接线。|
|时间恰好两三分钟|90 秒无事件可能重连，但无现场日志；不承诺找到该次触发者。|

排除推测：没有看到终端 focus 直接写 model；不改焦点、heartbeat、revert 或为 Kimi/GPT 写特例。

## 21. Audit Contract

独立审计只接收原始需求、仓库根、此文件和模式；从固定基线重查完整需求、调用路径、合规预算、用例敏感性。任何阻断按 workflow 修订并全范围重审；仅 exact revision `No blocking findings` + `APPROVE` 允许记录 plan-only 终态。

## 22. Revision Delta / Plan Audit Record

|Revision|变化 / 处置|
|---|---|
|R2|§2、7–11、13–20。B-01 优先成功页有效 user；B-02 首页同一字段选择；B-03 已批准转换复用持久 setter；B-04 Mini 改中性标签。以 Mini 单行替代 route 改动，增加已有首页 transport 测试文件；两类硬顶未变。N-01/02 修正命令、观察点。S1–S4 不变。|
|R3|§10、13–20：B-06 交给本次 create ID，B-03 记录已批准工具回执水位，增加漏收与后手选对照。Prompt 替换 Sync 文件名额；Local 自己获取一次有界成功 viewer 元数据。B-05 复议改为 Follow-up。不新增 invariant 或放宽预算。|
|R4|用户明确只改普通 TUI，重定 S4 为 TUI 内置默认；撤掉 legacy/Core registry、Mini 实施与测试。B-07 删除 Local 平行读取，复用 Sync 成功合并；B-08 恢复只读；B-09 点击即同步保存无条件名称。B-03 的 Yes 以具体工具身份作为用户动作，不再维护跨时钟水位。修正 N-03。5 个生产 / 3 个测试，分别 ≤160。|
|R5|§10、14–18：B-10 用按选择标识的成功事实解除已生效选择对可撤回工具的依赖；B-11 删除回答之前的身份 GET，文案仅限缩待核验引用，核验依据仍是工具身份。B-12 独立 Prompt fixture 驱动真实成功页，将历史 GET 与提交 POST 分开。文件清单与总硬顶不变。|
|R6|§10、16：B-13 明确“待核验”属于现有 Agent 字段未就绪，旧值不可发送；T3 在页未返回时实际按回车并检查草稿和首个 POST。复用同一 Local、Prompt 守卫及已规划的 T3，无新增文件、数据源或预算。|
|R7|由计划验收进入用户明确授权的实施及提交。新发现：`.github/workflows/build-opencode.yml:414,445,477,519` 多平台执行 `smoke-opentui-artifact.ts`；其 366–370 只传 title，463 没有 `--agent`，551 断言 Build，与新产品行为正面冲突。将该测试列入第 4 个测试文件；不改工作流，不放宽任何类别行数。T1 已保留的 pre-R1→当前变动：真实 Session 透出 PromptRef/默认 slot，无网络 API 改动；在 model setter 复制 providerID/modelID。其余 §10、T2–T4 仍全部必需。实施若在正常格式化下触顶，禁止以部分实现提交。|
|R8|用户明确删除所有额外 Plan/Question 接线，并要求模型自己的档位随会话恢复。移除批准回执、额外读取和相关用例；保留原路由原 Question，git diff 已核实为零，其原测试 3 pass。S2、T1/T3 将档位纳入真实请求。生产/测试各 3 文件、各 ≤160 行。实施由主线程亲自执行。|
|R8 最终范围|应用户明确要求移除选择落盘、额外的退出/问答/工具处理及其测试；保留模型与档位一起恢复。代码在单个 TUI 实现。新增行长约束按文件实测。|

R1，全范围，invocation `ses_ded5b24efffe9CE2vW6l8G6Onm`。独立 verdict（分类和原文）：

* Blocking B-01 Session 字段有值，也可能比上一次使用记录旧
* Blocking B-02 首页先选模型再切 Agent，首条请求仍会丢掉手选模型
* Blocking B-03 用户确认从 Plan 切到 Build 后，重开会恢复更早的 Plan
* Blocking B-04 二进制的 Mini 模式会显示 Build，实际执行 Auto
* Non-blocking N-01 验证命令会漏跑。N-02 二进制验收需写明观察点。
* Follow-up：ACP 对自定义 `mode: all` 的展示筛选可保留为后续事项；它不影响上述四条结论，也无需借本次修改调整桌面或 Web。
* Rejected speculation：没有把终端焦点、resize 或“两三分钟后重连”判为根因。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R1，全范围计划审计。** 当前修订未获批准，不得标记 **Verified Plan**。按 workflow 修订同一计划、记录 B-01 至 B-04 的处置，再提交下一修订做全范围复审。

R2 全范围、复议，invocation `ses_ded5b24efffe9CE2vW6l8G6Onm`。Blocking：B-03 用户已确认切到 Build，但重开仍可能恢复 Plan；B-05 把 legacy 消息页固定排在 Session 字段之前，仍会读错“上一次”；B-06 首页手选能进入创建请求，却没有归属到刚创建的会话。N-01、N-02 已解决。Follow-up ACP，Rejected speculation 焦点或断线时长。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R2，全范围计划审计。** B-03、B-05、B-06 未解决；当前修订不能记录为 **Verified Plan**。

复议最终分类：Blocking B-03 已确认切到 Build，漏收完成事件后仍会恢复 Plan；Blocking B-06 首页手选没有交给刚创建的会话；Follow-up B-05：外部 native 客户端与 full TUI 混用时的历史恢复。N-01、N-02 维持已解决。Rejected speculation：撤回“检查两个 registry 的默认 Agent，就必须合并两套会话历史”的推断。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R2。** 本次复议不变更修订号；仅 B-03、B-06 阻止 R2 达到 **Verified Plan**。

R3，全范围，invocation `ses_ded5b24efffe9CE2vW6l8G6Onm`。Blocking B-07 独立读取的旧消息页可以压过已经到达的新选择；B-08 慢窗口的历史恢复会覆盖快窗口较新的手选；B-09 开页期间手选 Agent，立即退出仍可能丢失。Non-blocking N-03：计划第 128 行的首页 `/command` 验收写在 T2 表格的额外一列。Follow-up B-05；Rejected speculation：不因 R3 未给出实施 diff 就判定超出 160 行，也不把终端焦点或断线时长当作故障原因。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R3，全范围计划审计。** B-07、B-08、B-09 未解决，当前修订不能标记为 **Verified Plan**。

R4，全范围，invocation `ses_ded48d9a2ffeKpLr5GEmIhS7mj`。Blocking B-10 已确认切到 Build，撤回消息后重开仍会变回 Plan；B-11 普通问题点 Yes，也会等一次与回答无关的历史读取；B-12 提交测试没有成功消息页，到不了要验证的发送接口。Non-blocking：无新增。Follow-up：外部客户端混用另一套会话历史、ACP 的 Agent 展示仍是既有后续事项，均不进入本次普通 TUI 修改。Rejected speculation：没有把终端焦点或断线时长认定为模型变化的原因。计划中的 160 行是硬预算；当前没有实施 diff，不能据此认定超额。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R4，全范围计划审计。** B-10、B-11、B-12 须在同一计划修订后复审。当前不能标记 **Verified Plan**，也不进入实施。

R5，全范围，invocation `ses_ded48d9a2ffeKpLr5GEmIhS7mj`。首次调用因模型不可用未产生 verdict；在同一审计上下文恢复后完成。Blocking B-13 重开会话时，已保存的旧 Agent 可以先于切换结果发出。Non-blocking：无新增。上一轮 B-10、B-11、B-12 的原场景已在计划中得到处理。Follow-up：其他客户端的历史与 Agent 展示沿用已有后续项，不扩大本次 TUI 范围。Rejected speculation：本次未把焦点切换或断线时长当作根因，也未凭计划估算认定超出行数上限。

> **BLOCK — `docs/plans/tui-session-selection-and-auto-default.md`，R5，全范围计划审计。** 仅 B-13 阻止放行；修订后重审，当前不进入实施。

R6，全范围计划审计，invocation `ses_ded48d9a2ffeKpLr5GEmIhS7mj`。终态：**Verified Plan**。独立裁决原文：

> **Blocking findings**
>
> No blocking findings.
>
> **R6 已通过全范围计划审计。** 上一轮的 B-13 已解决：重开会话时，如果还没确定上次切换 Agent 是否成功，按回车只保留草稿，不会用旧 Agent 发送。用户此时重新手选 Agent，新选择立即生效。计划第 88、132 行把这条规则和验收步骤写在了一起：先检查零提交，再核对第一条实际请求使用的 Agent 和模型。
>
> **Non-blocking findings**
>
> 无。
>
> **Follow-up**
>
> 其他客户端的历史恢复和 Agent 展示维持原范围，不纳入本次普通 TUI 修改。
>
> **Rejected speculation**
>
> 已核对的刷新路径足以解释手选模型被覆盖；无需把终端焦点切换或断线时长当作根因。
>
> **Requirement and traceability coverage**
>
> | 要求 | R6 的验收方式 |
> |---|---|
> | 手选优先，否则沿用上一次；刷新不改选择 | 模型和 Agent 分别恢复。T1–T3 检查手选后刷新、撤回、重开，以及只改其中一项时，下一条实际请求是否仍用正确的值。 |
> | 默认 Agent 为 Auto，无需手配 JSON | 没有手选、历史或显式配置且 Auto 可用时，T4 同时检查输入框显示 **Auto**、请求携带 `agent: "auto"`。默认模型、服务端和 Core V2 保持原样。 |
> | 控制改动规模 | 计划限定 **5 个生产文件、3 个测试文件**；生产和测试各自不超过格式化后新增与删除合计 **160 行**。这是实施硬上限，实际行数留到有代码差异时核算。 |
>
> **Primary-path and fallback verdict**
>
> 普通 TUI 只由 `Local` 决定当前选择，输入框和发送共用这个结果。R6 复用了现有的发送前检查（`packages/tui/src/component/prompt/index.tsx:1131–1132`），无需新增发送分支或自动重发。
>
> **Release verdict**
>
> **APPROVE — `docs/plans/tui-session-selection-and-auto-default.md`，R6。** 按 workflow，可将本裁决原样登记为 **Verified Plan**。本次验收止于计划，不进入代码实施。

## 23–24. Implementation Evidence / Implementation Audit

R7 审计前轮次门禁，invocation `ses_ded48d9a2ffeKpLr5GEmIhS7mj`：Blocking B-14　R7 改变了测试文件清单，已达到计划审计轮次上限。裁决：**BLOCK — R7 等待追加计划审计轮次的明确授权。** 用户授权追加后，R7 全范围审计结论：No blocking findings. Non-blocking：当前 T1 用例检查了刷新后实际请求仍使用 GPT，但在撤回后手动填入了 `retry`，没有验证撤回恢复的草稿，也没有断言原历史模型保持不变。Follow-up：无新增。Core V2 和其他客户端不在本次修改范围内。Rejected speculation：不能用当前的局部差异断定最终实现已满足或超出行数上限。

> **APPROVE — `docs/plans/tui-session-selection-and-auto-default.md`，R7。** 主流程登记本裁决后可按 R7 继续实施。当前通过的是计划审计；完整实现通过测试和独立实现审计后，才能标记为 **Verified Implementation** 并提交本任务的改动。

原始反馈：真实 TUI 请求红灯 `model` 而非 `gpt`；修复后通过，已验证历史模型未被改写且 Undo 恢复草稿。最终包 `bun typecheck` 通过；规定的五个 TUI 回归文件合计 149 pass、0 fail。Windows `bun run script/build.ts --single --skip-install --skip-embed-web-ui` 及既有 `script/smoke-opentui-artifact.ts` 通过，ConPTY 驱动输入，核对 Auto 和实际发送记录。旧门禁中报错的 3 个 CLI 参数、2 个 daemon 生命周期用例分别独立复跑全部通过，未改变别的包的行为或超时。

实际改动（固定基线，增删相加）：生产 3 文件 +109/-51 = 160；测试 3 文件 +142/-18 = 160。新增行平均/基线平均：local.tsx 30.3034/30.3259，prompt/index.tsx 33.3333/35.9639，sync.tsx 42.4000/44.6314，session-message-render 51.7407/57.6630，prompt-submit-transport 37.2857/38.8691，artifact smoke 39.7222/39.8704。历史恢复不再把消息模型传给 setter；手选值仅在本窗口按会话保留。

2026-11-26 全六个文件 stop 门禁：规则检查通过，完整联跑 TUI 406 pass/1 fail（折叠工具帧未就绪），opencode 120 pass/35 skip/5 fail（Windows daemon 启动/阶段标志超时）。不跳过检查或降低阈值。逐项结果与独立审计另记。

其中 `block tool folds long denied error` 单跑 1 pass。五个 daemon 用例同组复跑为 3 pass、2 fail：`worker deadline terminates a hanging instance disposer` 与 `daemon reports TUI clients and exits after the last SSE client disconnects` 分别超时；这两项先前单独成组为 2 pass。整体门禁尚未放行，不能以单跑成功代替。

R8 第一轮独立实现审计 `ses_dec77f95fffepuCMxTiP6FWWqi`：**BLOCK**。返工保留同模型的历史档位，按有效性选择 CLI/历史模型，档位检查只作用于模型请求。T1 复用原来的真实 Session：实时 user 先到、HTTP 页仍未返回时提交为零；合并后检查第一条 POST，手选、刷新、Undo 后检查恢复的草稿、旧消息和重发请求。

最终候选验证（2026-11-26）：

- `packages/tui`：`bun typecheck` 成功。按 §16–18 的五个文件加 `test/routes/session/question.test.tsx` 一起执行 `bun test --timeout 30000 --only-failures`：152 pass、0 fail，1180 个断言。
- `packages/opencode`：`bun run script/smoke-opentui-artifact.ts --binary dist/opencode-windows-x64/bin/opencode.exe`，相同命令另加 `--build`，均成功。无 Agent 参数及显式 `--agent build` 分别在 ConPTY 显示 Auto、Build，首条实际 user 为对应的 `auto`、`build`，模型均为 `test/test-model`。
- 仓库根：`git diff --check 07395e4a82 -- <六文件>` 成功；`bun script/guard/gate.ts stop --files <§15六文件，逗号分隔>` 退出 0，TUI 39 个文件、opencode 15 个文件均通过。先前超时未在本轮重现。
- §16–18 T2 的首页命令与随后普通请求、首页手选后手动打开其他会话：已有首页普通提交及独立命令测试。源码中 `session/prompt.ts:2512–2519` 优先命令自己的模型，TUI 仅对 create 回执调用 `adopt(sessionID)`；这两条组合操作尚无端到端运行记录。

R8 第二轮只读复审，同一 invocation：**BLOCK — R8，第二轮独立实现复审，相对 `07395e4a82` 的六文件 diff。** B-04：T2 的部分跨步骤请求未联验；B-06：首页档位检查晚于 create；B-07：有效 CLI Agent 等待历史；B-08：未选档位的手选模型遮住同模型历史档位；B-09：退出条件改写无关。Non-blocking：上一轮无效 CLI Agent 和已下架历史模型的两个场景已修正。Follow-up 无新增；Rejected speculation：不以旧失败日志推翻后续门禁绿灯。

### R9 用户收缩范围后的验证

R8 的产物、门禁与行数记录仅对应当时版本。R9 删除档位名单校验、发送拒绝、自动 Default、撤回边界裁剪、Session 字段补值、CLI 特殊优先级与 `--build` smoke 开关。`app.tsx`、Question、Session 路由、keybind、最近模型及收藏循环函数相对基线均为零差异。模型/Agent 选择框传明确的手选标记；Tab 和 Ctrl+T 复用现有入口。

- `packages/tui`：`bun typecheck` 退出 0；§16–18 的六文件回归 `bun test --timeout 30000 --only-failures` 为 152 pass / 0 fail、1180 个断言。只有原有测试内的手选调用参数调整，没有新增用例或档位专测。
- 仓库根：八文件 `bun script/guard/check.ts . --files <本次八文件>` 为 0 错误、1 个提示；`git diff --check 07395e4a82 -- <本次八文件>` 通过。
- `packages/opencode`：`bun run script/build.ts --single --skip-install --skip-embed-web-ui` 成功，最终产物版本 `0.0.0-dev1-smark-202611251801`；`bun run script/smoke-opentui-artifact.ts --binary dist/opencode-windows-x64/bin/opencode.exe` 成功，真实 ConPTY 中 Auto 标签与实际 user 一致。
- 仓库根完整门禁：`bun script/guard/gate.ts stop --files 'packages/tui/src/context/local.tsx,packages/tui/src/context/sync.tsx,packages/tui/src/component/prompt/index.tsx,packages/tui/src/component/dialog-agent.tsx,packages/tui/src/component/dialog-model.tsx,packages/tui/test/cli/cmd/tui/session-message-render.test.tsx,packages/tui/test/cli/cmd/tui/prompt-submit-transport.test.tsx,packages/opencode/script/smoke-opentui-artifact.ts'` 退出 0，TUI 39 文件与 opencode 15 文件均通过。最终 TUI `bun typecheck` 退出 0。
- 最终差异：生产 5 文件 +105/-24 = 129；测试 3 文件 +137/-17 = 154。新增平均行长/基线平均：Local 29.7303/30.3259，Sync 42.4000/44.6314，Prompt 35.6667/35.9639，Agent 对话框 17.7500/22.5161，Model 对话框 23.0000/33.3208，提交测试 37.7143/38.8691，消息测试 52.0741/57.6630，产物 smoke 38.2308/39.8704。
- 独立 R9 实现审计 `ses_dec14ebd2ffeqktG3C7uvRBgb2`，全范围，累计第三轮：**BLOCK — R9，相对 `07395e4a82d40d950e6c83186cbbbf51680b6888` 的当前八文件 diff。** Blocking B-10：模型选择框从 B/high 切到 A 后再选回 B，A 的手选档位会遮住历史 B/high，导致落到旧偏好 B/low。Non-blocking 无新增；Follow-up 沿用跨协议/ACP；Rejected speculation：不恢复用户已取消的 CLI、Question、档位下架检查或额外测试。范围及行数核对通过。
- B-10 返工局限于 Local 模型档位：复用已有 `modelStore.variant`，初始化时恢复历史值并保留手选，之后手调更新同一张表。删除会遮住后续手调的历史档位快照；就绪信号改为 boolean。不增加状态表、测试、磁盘读写或其他入口接线。
- 用户已授权额外六轮实现审计，累计最多九轮；下一轮为总第四轮、追加授权的第一轮。仍需全范围独立 APPROVE 和完整验证后提交。

第四轮送审候选：生产 5 文件 +115/-24 = 139，测试 3 文件 +137/-17 = 154；Local 新增行平均 30.2020，低于基线 30.3259，其余七文件平均值不变。最终代码 `bun typecheck` 与两份修改测试为 55 pass / 0 fail；之前六份回归 152 pass / 0 fail，其中出现三条测试临时目录 KV rename 的 ENOENT 日志，未改动 KV 或测试清理代码。最终单平台构建及已有 smoke 成功，版本 `0.0.0-dev1-smark-202611251849`。

用户随后提供的自动门禁为 TUI 366 pass，opencode 122 pass / 35 skip / 3 fail，三个失败均为 `thread.test.ts` 的 CLI 参数错误文本为空。原命令 `bun test --timeout 30000 --only-failures test/cli/tui/thread.test.ts --test-name-pattern 'rejects mini-only options without --mini|routes attached sessions to mini mode|rejects network options in mini mode'` 在 opencode 包复跑为 3 pass / 0 fail，未修改这些文件。最终八文件完整门禁另行执行，单跑结果不替代完整门禁。

第四轮独立审计，同一 invocation `ses_dec14ebd2ffeqktG3C7uvRBgb2`，全范围：

> **BLOCK — R9，累计第 4 轮实现审计、追加授权第 1 轮。**
>
> **B-10 已解决，当前唯一阻断是 B-11 的最终验证。** 当前八文件差异尚不能标记 Verified Implementation；后续工作限于完成并核验既定门禁结果。
>
> Non-blocking findings：无新增。
>
> Follow-up：沿用跨协议历史恢复、ACP 展示事项，不增加本次修改义务。CLI 门禁失败的原因仍待验证，不据此要求修改 CLI 或 daemon。

同轮最终完整门禁：TUI 407 pass；opencode 124 pass / 35 skip / 1 fail / 1 error，失败变为 `worker deadline terminates a hanging instance disposer`，在启动阶段 20 秒超时，随后 fixture 报 60 秒内未启动。该原用例单独复跑在候选工作区为 1 pass；在 `D:/Temp/opencode/tui-explicit-math-local` 的固定基线 `07395e4a82`（无生产修改，Core 依赖解析也在该基线 worktree）同命令为 1 fail、20001ms 超时。候选生产代码、测试超时与 daemon 均不再变动。随后仅单独重跑完整门禁，所有失败记录保留。

最终完整门禁通过（2026-11-26，同一八文件候选，生产及测试自第四轮送审后无修改）。仓库根执行前述完整八文件 `bun script/guard/gate.ts stop --files ...` 命令，退出码 0，耗时 785400ms。原始成功输出如下；门禁只落盘失败日志，因此 `.git/guard/logs` 中保留的前轮失败日志不会被此次成功覆盖。

```text
[gate] ✓ 规则检查  本会话 8 个文件  26.1s
[gate] ✓ 选测试  静态依赖图 · 8 个文件  29.9s
[gate] ✓ 测试  packages/tui · 39 个文件 · 静态依赖图  407 通过  1m02s
[gate] ✓ 测试  packages/opencode · 15 个文件 · 静态依赖图  70 通过  12m17s
```

上述通过数是门禁进度器输出，保留原值；没有跳过、过滤、放宽测试或修改门禁。既有 28 条多余防御提示不阻断，未借本功能修改这些无关行。

### 最终实施审计

Invocation `ses_dec14ebd2ffeqktG3C7uvRBgb2`，全范围，R9，累计第五轮、追加授权第二轮。以下原样登记裁决；当前状态为 **Verified Implementation**。

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> 无新增。
>
> - **B-10 已解决**：历史恢复与后续手调复用既有按模型索引的档位表，模型往返切换保持对应档位。
> - **B-11 已解决**：当前候选的完整八文件门禁成功记录已补齐。已核对门禁实现以子进程退出码判定成功；界面中的通过数量来自进度计数，不作为测试总数。
>
> ## Follow-up
>
> 沿用跨协议历史恢复、ACP 展示事项。此前 CLI／daemon 测试失败记录继续保留，不增加本次生产修改范围。
>
> ## Rejected speculation
>
> - 不将旧失败日志继续视为最终候选未通过：门禁仅保存失败日志，后续成功不会覆盖旧文件。
> - 不恢复用户已取消的 CLI 特殊处理、Question／工具接线、档位下架检查或额外测试。
> - 不把终端焦点、重连时长认定为模型变化原因。
>
> ## Requirement and traceability coverage
>
> 已复审原始需求、R9、八文件全部差异及直接影响路径。当前生产和测试差异与第四轮候选一致，本轮新增内容为验证记录。
>
> ## Primary-path and fallback verdict
>
> **通过。** Local 负责选择，Sync 负责历史页就绪，Prompt 消费选择并交接新会话。修复位于原始错误的状态所有者，未引入备用成功路径、额外存储机制或其他入口接线。
>
> ## Code quality verdict
>
> **通过。**
>
> - 实际核对生产 **5 文件、139 行**，测试 **3 文件、154 行**，满足各自 160 行上限。
> - 已独立重算八文件新增行平均长度，全部低于对应基线整文件平均值。
> - `git diff --check` 通过。
> - 未列出的入口、相关 CLI／daemon 测试和门禁实现保持基线。
> - 已核对计划补齐的完整门禁成功输出及其退出码判定逻辑，并复核当前差异未改变。测试、typecheck、构建和 smoke 的执行结论依据记录中的验证结果；本轮未重新执行这些命令。
>
> ## Release verdict
>
> **APPROVE — R9，累计第 5 轮实现审计、追加授权第 2 轮。**
>
> 批准范围仅为当前八文件相对 `07395e4a82d40d950e6c83186cbbbf51680b6888` 的完整差异。可按 workflow 原样记录本裁决，将当前实现标记为 **Verified Implementation**，随后进入已授权的本任务隔离提交流程。
