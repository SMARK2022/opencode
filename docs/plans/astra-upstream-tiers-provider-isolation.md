# Canonical Implementation Plan: Astra Upstream Tiers and Provider Isolation

> Status: verified
>
> Revision: R1
>
> Approved revision: R1
>
> Audit mode: full-scope
>
> Requirement source: Session GOAL 原始需求（下文原文）
>
> Implementation allowed: yes
>
> Last updated: 2026-10-11

This file is the sole implementation specification for this task. Chat summaries, superseded revisions, and builder rationale outside this file are not implementation authority.

## 1. Verbatim Requirement

> OK，那对于这四个相应的一个分支的一个合并的一个点呢，那么讲而言你可以看一下。然后与此同时呢，关于你说的这个可选级排除项这一个点，这个可选级排除项中的这个 ASTRA 的提示词匹配从 GPT-6收窄到 ASTRAA，这个确实是可以去进行一个可选语意回移。但我不知道我们本地是什么样，我们本地如果本地就已经是匹配到这个 ASTRAA 的话，那本质上而言这个语义就不用进行回流了，所以你可以看一下。然后呢，因此这需要回流的一个点就是你所说的这四个修正，就是四个相应的分支的一个合并，然后还有一个东西呢，就是说收窄这个提示词的这个东西。然后与此同时呢，还有一个东西也需要去参与到本次的一个完整的 plan 的一个 first principle plan 的一个纳入中。也就是我们之前过度地放开了那个相应的缓存复用的一个机制，然后就导致了一个问题，就是其实不同的 provider 它们之间那个 CACHE 是不互通的，所以不同 provider 之间的 GPT 的缓存仍然不能进行一个直接的复用，所以请注意这一点。因为我们之前是直接强制所有的 GPT 都能够互相互通互用，但是经过我的调研发现就是不同账号之间是隔离的，所以本质上而言不同的 provider 大概率是使用不同的账号，所以这样的话，本质上而言不同的 provider 应该是保持这个缓存，或者说它那个 syncing 的那个加密的字段不进行重复。然后与此同时请这些东西你按照 first principle 的一个原则去进行一个重放，然后同时呢整体的实现的还有重放的内容呢保持克制，不要过度地堆积一些本质而言过度审计或者过度进行断言的一些逻辑。整体的修改呢保持整体克制，然后整体的修改的文件数呢按照我的理解应当是生产代码的文件的修改数呢最好是不要超过16个文件，然后修改的行数呢最好是不要超过2500行，就是这个生产代码行数。

四个修正指 #47385 / #47659 / #47671 / #53875；提示词语义来自 #50989。终态 verified-implementation；不提交、不 push。GOAL 合同要求独立方案与实现审计、TDD、完整映射及中文解释性注释门禁。

## 2. Explicit Non-Goals

- 不迁移 V2 配置系统、WebSocket、账号发现、数据驻留、Sol/Luna 白名单、GPT-5.6 限额或 effort 切换缓存协议。
- 不替换本地 Astra 提示词正文，不修改现有模型快照，不改用户已有工作区修改。
- 不探测两个 Provider 是否偶然共用账号；以已有 ProviderID 为本任务隔离边界。同 Provider 凭据更换无历史账号信息，属于未验证限制，不引入账号持久化。
- 不重新命名 promptCacheKey，不全局清空明文历史或删除历史数据库字段。服务端缓存 key 是提示性参数，不是加密续接内容；本地转换缓存已经按 Provider/Model/Variant 分隔。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| AGENTS.md | 最小修改、不新增 any、包目录运行测试与 bun typecheck |
| packages/opencode/AGENTS.md | 平铺模块、Effect 服务边界、不得在根目录运行测试 |
| packages/opencode/test/AGENTS.md | 复用 fixture、真实公共 seam、等待 readiness 而非 sleep |
| CONTEXT.md | V1 session 是生产路径；Provider alias 是 fork 已有语义；Message 包含 Parts |
| docs/adr/README.md | ADR 目录仅有 triage 决策，无本功能额外约束 |
| .opencode/policy/first-principles-engineering.md | first divergence、独立审计、无 fallback、双向映射及 E/C |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| packages/opencode/src/plugin/codex.ts:27-34,379-505 | OAuth model hook、版本过滤、请求体透传 | observed |
| packages/opencode/src/config/provider.ts:56-68；config.ts:213 | 对象式 options/variants；不需要新配置 | contracted |
| packages/opencode/src/provider/provider.ts:1475-1658,1933-2005 | model hook/config/alias 顺序，SDK fetch 包装与 id 剥离 | reachable |
| packages/opencode/src/session/llm.ts:132-179,384 | variant 合并和 providerOptions 传递 | reachable |
| packages/opencode/src/provider/transform.ts:215-237,854-865,1165-1167,1281-1328 | stateless reasoning 过滤、SDK namespace、cache key | reachable |
| packages/opencode/src/session/processor.ts:497-554 | SDK metadata 原样落 reasoning Part | reachable |
| packages/opencode/src/session/message-v2.ts:1414-1424,1576-1601,1643-1663 | GPT-family exception 绕过 differentModel，跨 Provider 回放 | observed |
| packages/opencode/src/session/prompt.ts:2644-2662,3094-3115 | chunks key 已包括 providerID，所有转换调用归于 MessageV2 | reachable |
| packages/opencode/src/session/system.ts:34-43 | 使用 API ID 路由；gpt-6 匹配过宽 | observed |
| packages/opencode/test/session/message-v2.test.ts:61-108,761-849 | 现有测试要求跨 Provider GPT 加密回放，需按新合同改正 | observed |
| packages/opencode/test/session/system.test.ts:349-383 | API ID 别名 fixture 和路由表 | observed |
| packages/opencode/test/plugin/codex.test.ts | 已有插件公共 hook 测试 | observed |
| packages/opencode/test/session/llm.test.ts:1279-1394 | 已有真实 LLM.stream 到本地 HTTP 请求捕获 seam | observed |
| packages/core/src/plugin/provider/openai.ts；test/plugin/provider-openai.test.ts | core 同时消费同版 SDK，需验证 | reachable |
| package.json:147-154；packages/{core,opencode}/package.json；bun.lock | 两处 3.0.53，无 OpenAI patch | observed |
| node_modules/@ai-sdk/openai/src/{responses,chat} 与模型能力判断 | ultrafast 不在 enum；GPT-6 不在 tier/reasoning 识别 | observed |
| 上游 gh pr diff/view #47385,#47659,#47671,#53875,#50989 | 精确迁移来源，合并 hash 下表固定 | observed |
| 下文实际执行的 bun -e 和现有 bun test | 不写测试文件的规划阶段反馈 | observed |

| PR | Merge commit | Scope |
| --- | --- | --- |
| #47385 | 02a167e048d3bd7299225068d79e4fce5c830d67 | major/minor 最终比较，包含 #47384 整数支持 |
| #47659 | 23ec4f55c8bf4009068c44635a448d602914f1f7 | 两处 SDK 升级到 3.0.88 |
| #47671 | ea2d59d7ca8028951a16d4ebc558104258440bf9 | 注册 SDK 显式 tier 补丁 |
| #53875 | 5e2df97a8945faa59064682c1160aadaee1b8ded | 最终累计 SDK patch，ultrafast 类型和校验 |
| #50989 | 6e0857cc0e2e (PR 固定 diff) | Astra 提示词只匹配 astra |

## 5. Current Behavior

```text
config/models catalog -> Codex models hook -> config/alias registration -> Provider model
selected variant -> LLM.stream -> ProviderTransform.providerOptions -> OpenAI SDK -> OAuth fetch
SDK reasoning metadata -> processor -> persisted MessageV2 Part
history + target Model -> MessageV2.toModelMessages -> ProviderTransform.message -> SDK request
model.api.id -> SystemPrompt.provider -> LLM system/instructions
```

Codex 仅匹配带小数版本。SDK 3.0.53 丢 priority、拒 ultrafast。MessageV2 的 GPT-family exception 未检查 ProviderID；输出 encrypted state 到另一 Provider。SystemPrompt 按 gpt-6 选 Astra。plain reasoning_content 可移植文本和不透明 OpenAI metadata 是不同责任。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| GPT 整数/多位 minor API ID | 模型目录/config | 字符串 model.api.id | Codex OAuth models hook | codex.ts | observed |
| priority/flex/ultrafast | model options、已选 variant | options record；SDK 自有 enum | LLM -> SDK | OpenAI SDK patch | observed |
| 同 Provider GPT 模型切换 | session user model 选择 | assistant 持久化 providerID/modelID | projection -> adapter | MessageV2 | contracted |
| 不同 Provider，相同或不同 GPT 模型 | Provider alias/模型选择 | providerID 明确；不保证账号相同 | 同上 | MessageV2 | observed |
| 空/非空 reasoning summary | SDK streaming Parts | text 字符串，metadata 可选 | 同上 | MessageV2 | reachable |
| OpenAI-compatible reasoning_content | 模型 capabilities.interleaved | 声明明文协议 | 同上 | 既有 projection/transform | contracted |
| API id 是 Astra/GPT-6 Sol/Luna/Codex | 模型目录/config alias | id 与 display name 分开 | SystemPrompt.provider | system.ts | observed |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | OAuth 保留 newer GPT 整数与多位 minor；已有 allowlist 保持 | #47385 | codex.test.ts 待加 |
| INV-02 | 两个包使用 3.0.88；显式 tier 在 Chat/Responses 请求中保留，ultrafast 被接受 | 三个 SDK PR | openai.test.ts 待加；core provider suite |
| INV-03 | Astra prompt 只对 GPT 路由内含 astra 的 API id 生效；其他 GPT/Codex 原路由保持 | 用户 + #50989 | system.test.ts 路由表 |
| INV-04 | 跨 Provider 不回放不透明 OpenAI reasoning metadata；保留可见文本与答案、工具历史 | 用户 | message-v2.test.ts 更新 |
| INV-05 | 同 Provider GPT 跨模型回放保持；同模型元数据行为和兼容明文 reasoning 保持 | 缩小用户要求的边界，保留现有合法路径 | message-v2.test.ts 与 transform.test.ts |
| INV-06 | 持久化历史不变、无恢复重试或新配置、有限修改 | 用户与 policy | 非变异断言、diff 检查 |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 | model hook 正则要求小数且 parseFloat 错比 5.10 | CodexAuthPlugin.provider.models | 实跑 catalog [] |
| INV-02 | SDK enum 拒绝 ultrafast；capability gate 删除 tier | SDK options/schema 与 language-model | 实跑 wireTier undefined；invalid openai provider options |
| INV-03 | system.ts includes(gpt-6) | SystemPrompt.provider | 实跑 Astra/Sol/Luna 均 true |
| INV-04/05 | GPT exception 只检查两端 GPT 名称 | MessageV2.toModelMessagesEffect | 输出 encrypted-source 到 target Provider |

### Executed Feedback Loops

全部从 `packages/opencode` 运行，不使用真实凭据或模型服务。以下为实际运行的命令；SDK 和跨 Provider loop 均 exit 1。

```powershell
bun -e 'import {MessageV2} from "./src/session/message-v2.ts"; import {ProviderTransform} from "./src/provider/transform.ts"; const model={id:"gpt-5.5",providerID:"target",api:{id:"gpt-5.5",npm:"@ai-sdk/openai",url:"https://example.com"},capabilities:{interleaved:false,input:{},output:{}},limit:{context:100,output:10},options:{}}; const input=[{info:{id:"msg_a",sessionID:"ses_a",role:"assistant",providerID:"source",modelID:"gpt-6-astra",time:{created:0}},parts:[{id:"prt_a",sessionID:"ses_a",messageID:"msg_a",type:"reasoning",text:"summary",metadata:{openai:{itemId:"rs_test",reasoningEncryptedContent:"encrypted-source"}},time:{start:0}},{id:"prt_b",sessionID:"ses_a",messageID:"msg_a",type:"text",text:"answer"}]}]; const output=ProviderTransform.message(await MessageV2.toModelMessages(input,model),model,{}); console.log(JSON.stringify(output)); if(JSON.stringify(output).includes("encrypted-source"))throw Error("CROSS_PROVIDER_ENCRYPTED_REPLAY");'
bun -e 'import {createOpenAI} from "@ai-sdk/openai"; import {CodexAuthPlugin} from "./src/plugin/codex.ts"; const hooks=await CodexAuthPlugin({});const models=Object.fromEntries(["gpt-6-astra","gpt-5.10"].map(id=>[id,{id,api:{id}}]));console.log("catalog",Object.keys(await hooks.provider.models({models},{auth:{type:"oauth"}})));for(const serviceTier of ["priority","ultrafast"]){let body;const sdk=createOpenAI({apiKey:"offline",fetch:async(_,init)=>{body=JSON.parse(init.body);throw Error("captured")}});try{await sdk.responses("gpt-6-astra").doStream({prompt:[{role:"user",content:[{type:"text",text:"hi"}]}],providerOptions:{openai:{serviceTier}}})}catch(e){console.log({serviceTier,wireTier:body?.service_tier,error:e.message});if(body?.service_tier!==serviceTier)process.exitCode=1}}'
bun -e 'await import("./src/server/projectors.ts");const {SystemPrompt}=await import("./src/session/system.ts");const astra=(await import("./src/session/prompt/gpt-astra.txt")).default;for(const id of ["gpt-6-astra","gpt-6-sol","gpt-6-luna"]){const usesAstra=SystemPrompt.provider({api:{id}})[0]===astra;console.log(id,usesAstra);if(id!=="gpt-6-astra"&&usesAstra)process.exitCode=1}'
```

Prompt 最初直接 import system 出现既有 Ruleset 循环初始化异常；按测试 preload 使用的 projectors 引导后反馈成功，未修改生产导入。现有 `bun test test/session/system.test.ts -t 'provider'` 为 7 pass，它证明的是旧宽泛合同，后续必须更新独立预期。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 目录筛选 | Codex model hook | 按 OAuth 合同选择模型 | 版本首次被拒绝的位置 | 不改用户 config 补偿 |
| tier 编码与校验 | SDK patch | SDK providerOptions -> wire | enum/delete 正在该包 | 不在 fetch 注入 body 绕过 SDK |
| 历史隔离 | MessageV2 projection | 有 source providerID 和 target Provider | 唯一拥有两端 provenance 的转换入口 | transform/wire 已无源 Provider，不加下游重复过滤 |
| prompt 选择 | SystemPrompt.provider | API ID -> 模板 | 本地唯一生产路由 | 不改模板正文和 UI |

## 10. Single Approved Primary-Path Design

1. 将 #47385 最终版本比较回移到本地 codex.ts，保留本地 whitelist、成本和 limit 行为。无需 #47384 的中间实现或上游插件重构。
2. 按 #47659 把 core/opencode 两处 OpenAI SDK pin 升至 3.0.88。以 #53875 merge commit 中完整累计 patch 作为 #47671+#53875 的产物；根 patchedDependencies 与 bun.lock 注册。同一 upstream patch 覆盖源码、CJS/ESM、internal 入口及声明，不复制生产算法。
3. SystemPrompt 的 GPT 分支把 includes("gpt-6") 改为 includes("astra")，保留本地 API ID 判断及 Codex/旧 GPT 优先级。这里用户 ASTRAA 按既有模型名 astra 理解，不新增拼写别名。
4. 在 MessageV2 现有 replaysForeignOpenAIReasoning 判定增加 `model.providerID === msg.info.providerID`。保留两端 GPT 前缀条件。不同 Provider 回到已有 foreign-model 处理：可见 reasoning 降为 text，空 reasoning 丢弃，metadata 不传。兼容 reasoning_content 分支仍保留明文 reasoning 但不带外部签名。相同 Provider 跨 GPT 模型维持 OpenAI-only metadata；同 Provider 同模型原样处理。
5. 不修改 PromptWindowCache：其 modelKey 已包含 ProviderID。promptCacheKey 保持 SessionID；它不携带他账号的密文。绝不由 cache key 猜测账号相同。

这是 primary path 边界修复，不引入失败后的备用成功路径。不请求数据迁移、不改认证，不声称不同 Provider 的真实账号一定不同。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| 相同 Provider GPT 跨模型加密回放 | current narrowed | primary-contract branch | yes | 主路径 | preserve |
| 跨 Provider 可见 reasoning 文本 | existing | primary-contract branch | yes | 主路径 | preserve |
| reasoning_content 明文协议 | existing | existing compatibility | yes | 主路径 | preserve |
| SDK 显式 tier 请求 | proposed upstream | contracted pass-through | yes | 主路径 | preserve |
| config 手动模型与 alias hook | existing | existing compatibility | yes | 未修改 | preserve |
| fetch 失败后注入 tier/尝试他账号/删除密文重试 | absent | forbidden fallback | yes | 0 | reject |

新增备用成功路径 0；新增 diagnostic surface 0%，无 retry、日志、配置开关或备用 parser。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| GPT-only 无 Provider 限制的加密回放例外 | 先前追求所有 GPT 互通 | Provider 是当前可用 provenance 边界 | 原判定加 Provider 限制，旧注释与跨 Provider 正向测试同步替换 |
| SDK tier 静态能力删除 | 旧模型能力猜测 | 上游显式 tier 合同 | 累计 SDK patch 删除 Chat/Responses gates |
| 泛 GPT-6 Astra 路由 | Astra 初期 GPT-6 唯一模板 | Sol/Luna 不能因 major 版本继承 Astra | 替换一个路由条件 |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 / #47385 | catalog -> OAuth hook | plugin/codex.ts | public models hook 整数、多位 minor、旧模型、API key passthrough |
| INV-02 / #47659 | 两包 import SDK | 两 manifest + lock | 两包 typecheck/core suite；SDK reasoning/tier 请求 |
| INV-02 / #47671+#53875 | SDK -> HTTP | root package.json + upstream patch | Chat/Responses doStream 捕获 tier；LLM.stream 选中 variant 的 HTTP body |
| INV-03 / #50989 | API ID -> prompt | session/system.ts | Astra、GPT-6、Sol/Luna、Codex、旧 GPT 路由表 |
| INV-04 | persisted history -> projection -> SDK | session/message-v2.ts | 不同 Provider 相同/不同 GPT model、空/非空 summary、wire 无 encrypted_content、输入不变 |
| INV-05 | same Provider projection | 同上 | 同 Provider 同/不同 GPT model 保留密文，非 GPT/兼容明文既有测试 |
| INV-06 | 全部路径 | 有限文件与已有 seam | git diff --check/范围检查，无持久化修改 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| major/minor 数值比较 | INV-01 | upstream #47385 与 loop | parseFloat 折叠 minor，强制小数漏整数 |
| SDK 3.0.88 + 累计补丁 | INV-02 | 三个上游 PR | 本地 enum、capabilities 不识别目标行为 |
| ProviderID 同一性限制 | INV-04/05 | 用户 + 密文 loop | GPT 名字不证明账号/Provider 域相同 |
| Astra API ID 匹配 | INV-03 | 用户 + #50989 | major 版本不能表达模型家族 |

无新生产 helper、状态、public API、配置字段或抽象。

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| packages/opencode/src/plugin/codex.ts | modify | major/minor 过滤 | 10 |
| packages/opencode/src/session/system.ts | modify | prompt family 匹配 | 4 |
| packages/opencode/src/session/message-v2.ts | modify | Provider 加密回放边界 | 8 |
| packages/opencode/package.json | modify | SDK pin | 2 |
| packages/core/package.json | modify | SDK pin | 2 |
| package.json | modify | Bun patchedDependencies | 1 |
| patches/@ai-sdk%2Fopenai@3.0.88.patch | add | 精确上游累计补丁，可在修改源码 hunk 附中文解释且保持相同运行语义 | ~448 |
| bun.lock | modify generated | dependency/patch resolution，仅必要关联变更 | <150 |
| packages/opencode/test/plugin/codex.test.ts | modify | 目录边界表 | ~45 |
| packages/opencode/test/session/system.test.ts | modify | 更新独立路由预期 | ~12 |
| packages/opencode/test/session/message-v2.test.ts | modify | 更新 GPT 回放矩阵，wire 隔离及不变性 | ~90 |
| packages/opencode/test/provider/openai.test.ts | add | 上游 SDK test 与 tier/协议矩阵 | ~65 |
| packages/opencode/test/session/llm.test.ts | modify | 复用 Responses test 增加 Astra ultrafast variant/真实请求验证，保留原 GPT-5 case | ~20 |
| docs/plans/astra-upstream-tiers-provider-isolation.md | add/update | canonical evidence/audit | 文档 |

## 16. TDD Behavior Slices

审计批准即确认下列公共 seams；按 GOAL 自动推进，不另设审批。每片先 red，再唯一所属修复，最后 regression。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 跨 Provider GPT 不能带密文；同 Provider 可带 | 旧 GPT exception 无 Provider 判断 | 增加 ProviderID 条件 | 明文兼容、same model、可见 text、不修改历史；通过 SDK 捕获 wire |
| 2 | GPT-6 Sol/Luna 用通用 prompt、Astra 用 Astra | gpt-6 broad match | astra match | Codex 与旧 GPT 路由 |
| 3 | OAuth Astra、5.10 可见 | 正则与 parseFloat | 上游最终 major/minor 比较 | whitelist、旧 GPT 排除、非 OAuth passthrough |
| 4 | SDK Chat/Responses 支持 ultrafast/priority/flex/default，Astra reasoning 不被丢 | 旧 SDK enum/capability | 3.0.88 + upstream cumulative patch | 两协议显式 tier、错误仍抛；core 使用同版 |
| 5 | 配置 selected ultrafast variant 经 LLM.stream 到本地 HTTP | 旧 SDK 无此能力 | 已批准 SDK 修复 | 既有 GPT-5 Responses、tool/transport 回归 |

不得测试 source text 或 helper 调用计数。HTTP 捕获是外部边界；终止异常使用固定 sentinel，断言真实 body，不请求在线模型。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines E | 150-230 | 新增/实质修改 production/test/config；排除 imports、空行、纯格式、generated lock/dist/type declarations、patch context 与删除行 |
| Required Chinese explanatory comments C | 23-35，最终按实际公式 | E=0 则 C=0，否则 C>=max(1,ceil(E*0.15)) |

注释邻近解释：Provider 是可用历史 provenance；same Provider 切换 GPT 保留；空 summary 无需造占位；reasoning_content 是明文；持久化不可变；API ID 不等于显示别名；多位 minor 非小数；旧 allowlist 合同；SDK 源码与发布入口同时补丁；公开 tier 指令由服务端判定；离线 sentinel/请求 body 的独立行为预期；variant 必须选中。上游 patch 的生成入口不增加无意义注释；有效 SDK 源码补丁纳入 E。不得集中堆放、逐行复述或通过拆行凑数。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| 第 8 节三条 bun -e | packages/opencode | 原始症状消失，目录另由明确测试断言 |
| bun test test/session/message-v2.test.ts test/provider/transform.test.ts --timeout 30000 | packages/opencode | 投影隔离与协议兼容 |
| bun test test/session/system.test.ts test/plugin/codex.test.ts --timeout 30000 | packages/opencode | 提示词、目录及认证既有行为 |
| bun test test/provider/openai.test.ts --timeout 30000 | packages/opencode | patched SDK 请求体 |
| bun test test/session/llm.test.ts test/provider/provider.test.ts --timeout 30000 | packages/opencode | variant 到 wire、Provider resolution/alias、transport |
| bun test test/plugin/provider-openai.test.ts --timeout 30000 | packages/core | 第二 SDK consumer |
| bun typecheck | packages/opencode 与 packages/core 分别 | 类型与升级兼容 |
| bun install --ignore-scripts；bun install --frozen-lockfile --ignore-scripts | repository root | 依赖安装和 patch 可重现；仅依赖操作，非跳过测试/提交 hook |
| git diff --check；git diff --stat | repository root | 范围、空白、生产预算 |

若环境/既有测试失败，记录独立证据并定位，不降低断言、不改无关实现；真实 blocker 按 GOAL 处理。线上 entitlement/实际计费 tier 不验证，不使用用户凭据。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 3 | SDK patch、SDK test、canonical plan |
| Files modified | 11 | 3 production source、3 manifests、lock、4 tests |
| Files deleted | 0 | 无 |
| Production lines | <600（含完整 patch 文本） | 7 个 production/config/patch 文件，保守含 lock 为 8，低于 16；低于 2500 行 |
| Test lines | <300 | 复用 fixture 与既有路由/Responses case |
| Generated lines | <150 lock；patch 中生成内容约 350 | 必需 SDK 发布入口，不编辑模型快照 |

## 20. Real Risks and Open Decisions

- 本地 SDK 3.0.53 -> 3.0.88 跨度超过上游 3.0.84 -> 3.0.88，必须两包类型检查和已有请求测试。
- ProviderID 是本次隔离合同，不记录历史 account；同 Provider 替换凭据的回放权限无本地依据，明确未验证，不扩展账号系统。
- 上游累计补丁只加入 ultrafast，不加入 V2 的 fast 字符串；不把模型后缀 -fast 等同参数 fast。
- 本地存在无关 staged/unstaged 改动，保持不变。

### Open Decisions Requiring the User

无。用户已指定四项回移及隔离行为；本方案选择上游 3.0.88 基线，不维持并行 SDK 路线。

### Rejected Speculation

不加账号自动识别、换 key migration、密文重试、通用 body 注入、额外 provider 黑名单或不可达 malformed 内部对象防御。prompt cache 服务端是否命中不能由本地强制；本任务只阻止不透明 state 跨 Provider。

## 21. Audit Contract

独立 auditor 读取原始需求与 exact revision，重建受影响 interface/producer/consumer。每轮完整范围，按 policy 证据判级，检查 first divergence、ownership、无 fallback、双向映射、TDD、代码质量与中文注释门禁。primary 不自审、不缩小审计范围。最多 6 轮 plan、3 轮 implementation；调用连续失败 3 次记录 unavailable。

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | No blocking findings | N-01 | APPROVE | ses_ed6a472f6ffekIYIy6vVZT9cCr |

### Independent Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

- **N-01：#50989 的固定引用尚未在本地复核。** 计划第 4 节列出的 `6e0857cc0e2e` 无法通过本地 `git show` 解析。本次已直接确认本地路由仍是 `includes("gpt-6")`，收窄到 `astra` 有原始需求支撑，因此该引用缺口不影响方案的行为判断。上游来源记录应补充可复核的完整引用。

## Rejected speculation

- 不要求增加账号发现或凭据切换迁移。原始需求明确要求跨 Provider 隔离，当前历史记录能够提供的边界是 `providerID`。
- 不要求修改 `promptCacheKey`。它是请求提示参数；此次确认的问题是历史不透明 metadata 被跨 Provider 投影。
- 不要求清空历史或转换缓存。`prompt.ts:2647-2658` 已使用 Provider、Model、Variant 区分转换结果。
- 不要求在 fetch 层重复过滤、删除密文重试或另建兼容路径。历史投影层已拥有源与目标 Provider 信息。

## Requirement and traceability coverage

本轮覆盖 R1 的完整原始需求及所有计划变更区域。

| 需求 | 独立核查结果 |
|---|---|
| #47385 模型版本比较 | `codex.ts:383-408` 确认现有小数正则与 `parseFloat` 的缺陷；上游提交确认采用 major/minor 比较。计划保留本地 allowlist、成本和 limit 行为。 |
| #47659 SDK 升级 | 上游提交确认 core、opencode 两处升级到 `3.0.88`；本地两处仍为 `3.0.53`。两包检查与依赖安装验证已映射。 |
| #47671、#53875 tier 修正 | 已读取固定提交中的累计补丁，覆盖 Chat/Responses 的 tier 校验、能力过滤及发布入口。配置 → variant → `LLM.stream` → SDK 的路径成立。 |
| Astra 提示词收窄 | `system.ts:34-43` 确认本地尚未收窄；计划在现有 API ID 路由处修复，并更新独立模板预期。 |
| 跨 Provider 加密状态隔离 | `processor.ts:497-554` 生产 metadata；`message-v2.ts:1420-1422` 的 GPT 例外首次绕过 Provider 边界；计划在该责任点增加 Provider 同一性条件。 |
| 保留合法历史与控制范围 | 同 Provider 回放、可见文本、兼容明文 reasoning、工具历史和输入不变性均有测试映射；未增加迁移、配置或账号状态。 |

计划的回归测试能够对当前缺陷产生敏感结果：跨 Provider 密文断言、GPT-6 非 Astra 模板断言、整数及多位 minor 目录断言、tier 请求体断言均可区分修复前后行为。

本轮执行了只读 Git 检查，并直接读取源码、测试和上游补丁；未运行测试、安装依赖或复现计划中声称已执行的命令。实际 red-green、两包类型检查和安装可重现性仍属于实现阶段验收。

## Primary-path and fallback verdict

**通过。**

每项责任均落在已有唯一主路径上：

- 模型筛选：Codex models hook。
- tier 校验与编码：OpenAI SDK。
- 历史 provenance 隔离：MessageV2 projection。
- 提示词选择：SystemPrompt provider 路由。

跨 Provider 的可见 reasoning 转文本，以及 `reasoning_content` 明文兼容，均是既有合同分支。计划未引入失败后备用成功路径，新增 diagnostic surface 为 0%。

## Code quality and Chinese-comment verdict

**方案阶段通过。**

生产变更集中于三个现有源码文件、依赖声明、累计补丁及 lockfile，预算低于用户提出的 16 文件、2500 行。新增生产概念均能反向对应已确认需求，没有额外 helper、公共接口、状态或配置。

第 17 节承诺按实际 `E` 达到 `C ≥ ceil(E × 0.15)`，并明确排除生成内容、导入、格式及 patch context，估算具备可行性。本次为方案审计，实际 `E/C` 留待实现 diff 独立重算。

## Release verdict

**APPROVE — 仅适用于 `docs/plans/astra-upstream-tiers-provider-isolation.md` 的 R1。**

该结论允许记录 R1 的方案批准并进入实现阶段。`verified-implementation` 仍须完成计划中的验证，并取得完整范围的独立实现审计批准。

### N-01 Record Correction

`gh pr view 50989 --repo anomalyco/opencode --json mergeCommit,url,mergedAt` 返回完整 hash `6e0857cc0e2e5aaf152d6026a3880e0c44019959`、mergedAt `2026-09-23T22:43:13Z`，URL https://github.com/anomalyco/opencode/pull/50989 。这是来源记录补正，不改变 R1 设计或批准。

## 23. Implementation Evidence

Implemented approved R1; independent implementation audit approved below. No commit or push.

### Actual Files and Diff

Production paths: `package.json`, `bun.lock`, `packages/core/package.json`, `packages/opencode/package.json`, `packages/opencode/src/plugin/codex.ts`, `packages/opencode/src/session/message-v2.ts`, `packages/opencode/src/session/system.ts`, `patches/@ai-sdk%2Fopenai@3.0.88.patch`.

Tests: `packages/opencode/test/plugin/codex.test.ts`, `packages/opencode/test/session/message-v2.test.ts`, `packages/opencode/test/session/system.test.ts`, `packages/opencode/test/session/llm.test.ts`, new `packages/opencode/test/provider/openai.test.ts`.

8 production/dependency paths, including lock and patch; 3 production TypeScript files. Tracked production/dependency diff: 38 additions / 14 deletions; new upstream patch: 448 lines. Conservative total including patch wrapper and generated contexts: 500 changed lines, below 2500. Five test files and this evidence document are separate. Existing unrelated worktree changes remain untouched.

Patch blob hash `cf467ee4f4c401132cc3e94edc29c78cd3fe87e0` equals `5e2df97a8945faa59064682c1160aadaee1b8ded:patches/@ai-sdk%2Fopenai@3.0.88.patch` exactly. Both SDK consumers pin 3.0.88; the cumulative upstream patch includes explicit tier handling and ultrafast support.

### Red-Green Test Evidence

Provider isolation: six table cases initially produced three cross-Provider failures and three same-Provider passes. Adding ProviderID equality made all six pass; captures use the real SDK with `store:false`, assert the final encrypted field and unchanged input history.

Prompt routing: five failing routing cases before the change; 28 system tests pass after narrowing to astra. Codex catalog initially omitted four expected models; 16 plugin tests pass after major/minor comparison.

SDK wire tests initially failed three cases under 3.0.53 (ultrafast enum rejection and explicit tier removal). New Astra LLM integration timed out before HTTP capture while the GPT-5.2 control passed. After dependency and upstream patch installation both integration cases and all SDK cases pass. Chat/Responses test default, priority, flex and ultrafast; unknown-model explicit tiers exercise removal of static capability gating.

Initial typecheck found missing Bun fetch.preconnect and assistant/user content union narrowing. Tests now supply a typed fetch with preconnect and narrow assistant content before flattening; subsequent typechecks pass without unchecked casts added for these fixes.

### Verification Commands and Results

All commands completed on 2026-10-11, Bun 1.3.14.

| Working directory | Command | Result |
| --- | --- | --- |
| repository root | `bun install --ignore-scripts` | success, generated lockfile |
| repository root | `bun install --frozen-lockfile --ignore-scripts` | success, reproducible frozen resolution |
| packages/opencode | `bun test test/session/message-v2.test.ts test/provider/transform.test.ts test/session/system.test.ts test/plugin/codex.test.ts test/provider/openai.test.ts test/session/llm.test.ts test/provider/provider.test.ts --timeout 30000` | 460 pass, 0 fail, 983 expectations |
| packages/opencode | `bun typecheck` | exit 0 |
| packages/core | `bun typecheck` | exit 0 |
| packages/core | `bun test test/plugin/provider-openai.test.ts --timeout 30000` | 6 pass, 0 fail, 9 expectations |
| packages/core | offline SDK request probe | core SDK ultrafast wire verified |
| repository root | `git diff --check` | exit 0 |

Package-local narrow checks preceded the combined run. No tests ran from repository root. No live credentials or network inference were used.

### Original Feedback-Loop Result

Reran all three §8 commands from packages/opencode after the final changes, each exit 0:

- Catalog: `[ "gpt-6-astra", "gpt-5.10" ]`; priority and ultrafast each equal their captured wireTier. The `captured` sentinel deliberately stops transport after request serialization.
- Cross-Provider replay: `[{"role":"assistant","content":[{"type":"text","text":"summary"},{"type":"text","text":"answer"}]}]`; no encrypted-source or opaque metadata.
- Prompt routing: `gpt-6-astra true`, `gpt-6-sol false`, `gpt-6-luna false` for Astra template identity. The standalone probe loads server/projectors first, as the test preload does.

### Actual Secondary and Replacement Path Inventory

Only approved primary paths changed. The old blanket GPT cross-Provider exception is replaced by same-Provider GPT reuse; no persisted history is deleted. The broad GPT-6 prompt match is replaced by Astra matching. Decimal version comparison is replaced by integer components, retaining local whitelist and limits. Upstream cumulative SDK patch removes static explicit-tier capability filtering and extends tier enums. No fallback, error-triggered retry, account detector, new cache, configuration field or public API was introduced. Existing Provider-aware prompt conversion cache and promptCacheKey remain unchanged.

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines E | 188 | changed nonblank, non-import code additions, including two SDK source enum additions |
| Qualifying Chinese comment lines C | 32 | adjacent boundary, compatibility and test-intent explanations |
| Ratio C/E | 17.02% | 32 / 188 |
| Required minimum C | 29 | ceil(188 * 0.15) |

Per-file E/C: root manifest 1/0; core manifest 1/0; opencode manifest 1/0; codex source 5/1; message source 1/2; system source 1/1; codex test 57/7; message test 46/8; system test 6/2; llm test 12/3; new openai test 55/8; SDK patch source enum additions 2/0. Excluded imports, blank lines, generated lockfile and generated SDK dist/declarations, patch context and deletions; no pure moves. Representative comments explain ProviderID as available account-domain provenance, why same-Provider GPT reuse remains, why store:false is necessary for encrypted wire assertions, and why minor versions cannot be decimal numbers.

### Remaining Unverified Items

Live OAuth account entitlement and actual server tier remain unverified; no production call authorized or required for local behavior proof.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | none | none | APPROVE | ses_ed6392cfeffeJ8sCGtGhwsOUDK |

本轮第一次返回静态无阻塞，但因尚未独立执行验证而暂缓放行；复用同一 task_id 明确既有执行授权后，审计员独立重跑并给出以下最终 verdict。没有实现返工或范围变更。

### Independent Final Verdict (Verbatim)

## Blocking findings

No blocking findings.

## Non-blocking findings

无。

本轮此前缺少的运行验证证据，现已通过独立执行取得；该放行限制已解除。

## Rejected speculation

- 不要求增加账号识别或同 Provider 换凭据迁移。本次隔离合同以 ProviderID 为边界，持久化历史没有可靠的账号身份信息。
- 不要求修改 `promptCacheKey` 或清空历史。`prompt.ts:2647-2658` 已按 Provider、Model、Variant 隔离转换缓存。
- 不要求在 fetch 层重复过滤密文，或在失败后删除密文重试。MessageV2 projection 已拥有源与目标 Provider 信息。
- 未修改的模型别名识别、其他提示词路由及 transport 行为，不因位于相关文件而成为本次阻塞项。

## Requirement and traceability coverage

本轮覆盖 R1 原始完整需求、全部指定 diff hunks、两个新增实现文件，以及决定其行为的生产者和消费者。当前 revision 与 approved revision 均为 R1。

| 需求 | 独立核查结果 |
|---|---|
| #47385 模型版本比较 | `codex.ts:383-415` 在原 models hook 修复整数版本和多位 minor 比较；保留原 allowlist、OAuth 零计费及 5.5 limit。测试覆盖允许、拒绝和 API-key 透传行为。 |
| #47659 SDK 升级 | core、opencode 的 manifest、lockfile 和实际安装包均为 `3.0.88`；两个消费者的测试及类型检查通过。 |
| #47671、#53875 tier 修正 | 补丁覆盖 Chat/Responses 源码、CJS/ESM、internal 和声明入口。当前补丁与固定上游提交的 blob 哈希一致：`cf467ee4f4c401132cc3e94edc29c78cd3fe87e0`。 |
| 显式 tier 到请求体 | `llm.ts:132-143,384` 将选中 variant 合并并交给 SDK。SDK 测试检查真实序列化字段；未知模型用例独立验证静态能力过滤已移除；LLM 测试覆盖配置到 HTTP 请求。 |
| Astra 提示词收窄 | `system.ts:34-43` 在既有 API ID 路由内改为匹配 `astra`，保留旧 GPT 和 Codex 优先级。独立复现确认 Astra 命中专用模板，Sol/Luna 不命中。 |
| 跨 Provider 不透明状态隔离 | `processor.ts:497-554` 保存 reasoning metadata；`message-v2.ts:1415-1424` 在原 GPT 回放例外处加入 Provider 同一性条件。跨 Provider 进入 `1578-1603` 的已有文本投影路径，不携带密文 metadata。 |
| 保留合法历史 | 同 Provider 同模型、跨 GPT 模型、空/非空摘要均有矩阵覆盖；测试检查输入不变及真实 SDK 的 `encrypted_content`。既有工具历史和明文 `reasoning_content` 测试保留并通过。 |
| 克制修改 | 生产、依赖及补丁共 8 个路径，其中生产 TypeScript 为 3 个；低于用户提出的文件数和行数预算。未增加账号状态、迁移或配置接口。 |

新增测试能够区分原始缺陷与修复结果。原跨 Provider 密文回放预期按新需求替换为隔离断言；GPT-5.2 请求测试继续作为对照。已直接读取 SDK ultrafast 校验失败及提示词路由失败的原始红测输出，并独立完成最终绿测和原始反馈循环。

**本轮独立执行结果：**

| 工作目录 | 验证 | 结果 |
|---|---|---|
| `packages/opencode` | R1 §18 七文件组合测试 | **460 pass、0 fail、983 expectations** |
| `packages/core` | `test/plugin/provider-openai.test.ts` | **6 pass、0 fail、9 expectations** |
| `packages/opencode` | `bun typecheck` | **exit 0** |
| `packages/core` | `bun typecheck` | **exit 0** |
| 仓库根目录 | `bun install --frozen-lockfile --ignore-scripts` | **exit 0** |
| `packages/opencode` | frozen install 后重跑 SDK 与 MessageV2 测试 | **67 pass、0 fail、176 expectations** |
| `packages/opencode` | R1 §8 三条原始反馈命令 | **全部 exit 0** |
| 仓库根目录 | `git diff --check` | **通过** |

原始反馈实际输出确认：

- 目录包含 `gpt-6-astra`、`gpt-5.10`。
- `priority`、`ultrafast` 与最终 `wireTier` 分别一致。
- 跨 Provider 投影只剩 `summary`、`answer` 文本。
- Astra 模板匹配结果为 Astra `true`、Sol `false`、Luna `false`。

安装后复核的受审 tracked diff blob 标识与此前一致，SDK 补丁哈希也保持一致。

## Primary-path and fallback verdict

**通过。**

每项责任均在既有唯一主路径修复：

- 模型目录筛选：Codex models hook。
- tier 校验与编码：OpenAI SDK。
- 历史 Provider 隔离：MessageV2 projection。
- 模板选择：SystemPrompt provider 路由。

非 OAuth 目录透传、跨 Provider 可见 reasoning 转文本、兼容协议的明文 `reasoning_content`，均属于已有合同分支。

新增备用成功路径为 **0**，新增 diagnostic decision surface 为 **0%**。原无 Provider 限制的 GPT 回放例外、宽泛 GPT-6 模板匹配及 SDK 静态 tier 删除逻辑均已在各自责任点修正，未增加下游补偿。

## Code quality and Chinese-comment verdict

**通过。**

未发现新增 `any`、未检查类型转换、非空断言、生产测试专用接口、无关抽象或职责泄漏。测试、类型检查和 diff 检查均通过。

按实际 diff 独立计数：

| 范围 | E | C |
|---|---:|---:|
| 三处 manifest | 3 | 0 |
| 三处生产 TypeScript 修改 | 7 | 4 |
| Codex 测试 | 57 | 7 |
| MessageV2 测试 | 46 | 8 |
| SystemPrompt 测试 | 6 | 2 |
| LLM 测试 | 12 | 3 |
| 新增 OpenAI SDK 测试 | 55 | 8 |
| SDK 补丁源码新增枚举行 | 2 | 0 |
| **合计** | **188** | **32** |

**C/E = 17.02%**，达到 policy 的 15% 要求，最低需 29 行。

计数排除导入、空行、生成的 lockfile、SDK dist/声明产物、补丁上下文和删除行。有效注释邻近对应变更，解释 Provider 身份边界、同域复用、版本比较、stateless 请求及独立 wire 断言等约束。

## Release verdict

**APPROVE — 仅适用于 `docs/plans/astra-upstream-tiers-provider-isolation.md` 的已批准 R1，以及本轮实际审查并验证的实现 diff。**

本轮完整范围实现审计通过，可将本 verdict 原文记录后推进至 `verified`。

真实 OAuth entitlement 和服务端最终计费 tier 保持明确未验证；本次已验证客户端目录、路由、隔离、参数校验及最终请求编码。审计未编辑实现文件、测试或计划，未创建提交或推送。

## 25. Extended CI Verification and Commit Authorization

用户在实现审计后要求检查历史依赖升级的 CI 风险，授权正常 install/test，随后授权无重大问题时 commit；仍未授权 push。该授权仅改变提交安排，不改变已批准 R1 的实现设计。

2026-10-11 本地 Windows、Bun 1.3.14 扩大验证：

| Scope | Command / environment | Result |
| --- | --- | --- |
| 根目录正常安装 | `bun install --frozen-lockfile`，包含 fix-node-pty 和 husky hooks | exit 0 |
| packages/core 全套 | `bun run test:ci` | 378 pass, 1 skip, 0 fail; 51 files; 77.82s |
| packages/opencode integration | `OPENCODE_TEST_SHARD=integration`，`bun run script/test-ci.ts` | 1009 pass, 34 skip, 0 fail; 80 files; 2086.16s |
| packages/opencode runtime | `OPENCODE_TEST_SHARD=runtime`，同上 | 2917 pass, 13 skip, 0 fail; 157 files; 1994.02s |
| packages/opencode tui | `OPENCODE_TEST_SHARD=tui`，同上 | 801 pass, 14 skip, 0 fail; 80 files; 737.34s |
| 两包类型检查 | 分别在 packages/core、packages/opencode 执行 `bun typecheck` | 均 exit 0 |

OpenCode 三个分片共 4727 pass / 61 skip / 0 fail，使用与 Windows CI 相同的 `OPENCODE_DISABLE_LSP_DOWNLOAD=true` 和 `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`。最初未分片的本地调用在工具的 30 分钟上限内未完成，未获得完整报告；改用 CI 的三个独立分片后全部正常退出。最后可见的 httpapi-sdk.test.ts 另行单跑为 16 pass / 0 fail。超时那次不计为成功，也没有据此修改测试或生产代码。

历史调查：上游 #47659 的 Linux/Windows unit、E2E 和 typecheck 全绿（run 34058065693）；#53875 同样全绿（run 37734044186）。#47671 的 Windows 唯一失败为插件并发安装子进程 exit 1（run 34061836622/job/101563617709），日志未指向 OpenAI SDK。fork 已提交 HEAD 7234496bfa 的 test/typecheck/build 全绿；此前 shell 隐私测试日志 sink 串扰由 194535bedd 修复。这些历史结果仅作为风险证据，不替代当前本地测试。

本次未执行远程 CI，未在本地复现 Linux/macOS runner、浏览器 E2E、全仓类型检查、发布构建或独立 shell 压力 job；不声称这些检查已经通过。当前扩大检查未发现 SDK 升级造成的红测。
