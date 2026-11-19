# Canonical Implementation Plan: daemon 请求计量与发送阻塞

> Status: verified
>
> Revision: R4
>
> Approved revision: R4
>
> Audit mode: full-scope
>
> Requirement source: Sentinel_6f118a67f63481919c9cbe06a84a896f；Sentinel_d529ab7083a481918370f29f07126c68
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-19

本文件是唯一canonical plan，当前R4以目标分支实时HEAD `e93b66fd8473e94fb414151af0fecbb31a299266` 为基线，目标为完成审计、验证、单提交并按最新授权推送独立分支和创建PR。目标分支保持dev1-smark，不直接推送目标分支、不合并。R3本地提交459eec663及其完整恢复包保留；R4只对齐新增的共享系统指引，计量四文件设计保持，当前R4实现与批准候选逐字一致。历史各revision的基线、审批和数据保持原口径。

## 1. Verbatim Requirement

2026-11-17 19:01:40 UTC，Sentinel_6f118a67f63481919c9cbe06a84a896f：

> 与此同时，既然你有6个Agent，按照我的理解，你可以你你还可以再去验证一点事情。因为刚刚我们提交了3个Commit上去，但是好像3个Commit上去之后，DAEMON的这个性能有退化，你看一下到底是你可以派两个Agent去验证一下，跑一下相同的一些东西啊，你看一看像那个Benchmark看一看如何。就是经常表现是，就是说我发送消息，以前的时候它是能够直接正常去运行了，就是立马就去运行了。现在新的我发送出去，它会显示断连一会，然后才能运行。

2026-11-18 04:47:02 UTC，Sentinel_d529ab7083a481918370f29f07126c68：

> 没有关系，如果你验证了大部分时间，你都说这个东西可能不是由这3个去引入的，那你也可以去看一看它是由历史的哪一些内容去引入的。那引入的这些东西是否有方法去进行以这种较小的commit或者说较小的这种hunk来去改动，使得我们整体的这个DAEMON啊，或者说这个运行性能能够大幅度提升，来减少这种offline这种时间，或者说这种延迟的波动，或者说这种用户体感操作这种阻塞延迟的这种感觉。比如说你也可以去提一个新的PR。

REQ-1 保留三提交同场景比较与历史追溯。REQ-2 以真实发送期间的控制面响应和端到端耗时判断小改动收益。REQ-3 保留完整请求、计费估算与交互行为。

## 2. Explicit Non-Goals

本候选不改变3秒探测预算、SSE心跳、模型输入、消息分页、权限、持久化格式、Token公开接口和配置。Execute取消死锁由独立任务处理。用户的整体体感目标仍由端到端验证覆盖；计量微基准改善不足以完成REQ-2。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| 根 AGENTS.md、packages/opencode/AGENTS.md | 包内运行检查，遵守 Effect/模块约定 |
| CONTEXT.md | Provider Turn、Model Tool Output、完整请求估算等语义保持 |
| .opencode/skills/first-principles-planning/SKILL.md | 基于当前HEAD，先验证关键假设，未批准只改Plan |
| .opencode/policy/first-principles-engineering.md | 修复成本产生处、单一路径、完整正反映射与中文注释 |
| .opencode/templates/canonical-plan.md | 本文24节结构 |
| docs/adr/README.md、0001-triage-labels-and-team-assignment-coexist.md | 当前仅有分诊ADR，没有请求计量算法决策 |
| 恢复的 diagnosing-bugs、tdd skill | 真实红信号、公共seam、逐行为切片 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| packages/core/src/util/token.ts:117–240 | estimateRequest现有唯一JSON visitor及bodyChars消费 | observed |
| packages/core/test/util-token.test.ts | getter一次、字符桶求和、媒体/推理校准 | contracted |
| packages/opencode/src/session/processor.ts:1239 | 真实请求准备回调同步调用估算 | reachable |
| packages/opencode/src/session/prompt.ts:1646 | 估算结果选择历史窗口；INV-1全返回值等价覆盖此合同 | reachable |
| core permission/reviewer.ts、session/compaction.ts、session/runner/{llm,to-llm-message}.ts 的 estimateRequest 引用 | 全部直接消费者需保持结果 | reachable |
| /workspace/shared/daemon-three-commit-recheck/REPORT.md、原始f04-send-stress.log、f04-profile.log、profiles | 真实daemon发送红信号及CPU热点 | observed |
| 同目录 0ab-exclusive.log | 新独占旧基线仍超时，修正旧报告中旧基线未完成项 | observed |
| evidence/HISTORY-AND-SMALL-DIFF.md、low-memory/json-accounting.log | 历史定位及13项长度恒等式验证 | observed |
| candidate-suite.log、candidate-diff-bench.log（同一recheck目录） | 原/候选全套估算合同与3005项返回值差分、1MiB微基准 | observed |
| 同目录abba/{run.py,results.json,summary.json,original-token.ts,candidate-token.ts,1-A.log至8-A.log及stderr} | 两组ABBA真实daemon、全部原始探测和变体源码 | observed |

0ab独占日志178次控制请求，health 3009.34ms和endpoint 3014.91ms超时；SSE14帧持续打开。f04两次发送8939.63/9516.56ms，同样有两控制路由3秒超时，模型各收到一次完整请求并回复。两版本均有原始症状的充分触发条件，未得到三提交新增退化的统计结论。

## 5. Current Behavior

历史消息 → 请求准备 → processor.onRequestPrepared → Token.estimateRequest同步JSON visitor生成整份字符串后取length → SDK生成真正wire JSON → timeoutFetch为fetch.start调用bodyBytes，将wire字符串编码为整份UTF8缓冲后仅取byteLength → 实际fetch → 模型回复。

两处日志/估算计量都只消费长度，却生成与请求正文同量级的临时输出。125MiB构造会话已在真实daemon HTTP、worker、SSE链复现控制请求超时。精确依赖阶段采样见§26；Token候选仍保留SDK必需的完整wire序列化，新增bodyBytes候选进一步省去诊断副本。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 大字符串消息/工具正文 | 历史投影、provider适配 | 准备好的JS请求对象 | processor回调 | Token | observed |
| 媒体、reasoning、工具参数 | 各provider adapter | 保留原始请求形态 | 同visitor分类 | Token/AttachmentToken | reachable |
| getter/toJSON、boxed primitive、循环/BigInt | estimateRequest unknown入口及现有测试 | JSON.stringify本身定义行为 | 公共估算入口 | Token | contracted |
| Unicode、转义、重复引用、数组空位 | 合法JS请求值 | JSON语义 | 同入口 | Token | contracted |
| wire字符串，包括中文、emoji、孤立surrogate | SDK与gateway request body | 已缓冲JS string，HTTP以UTF8编码 | timeoutFetch→bodyBytes→fetch.start | Provider | observed/contracted |
| Uint8Array及其他body | custom/gateway fetch配置 | body类型保持现有unknown分支 | 同wrapper | Provider | reachable；既有行为保持 |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-1 | 全部估算字段保持相同，包括bodyChars、分类、媒体、ratio | 现有调用者消费结果 | util-token |
| INV-2 | 原请求不变，getter/toJSON观察次数与异常行为保持 | provider实际发送原body | getter一次及JSON合同 |
| INV-3 | 减少产生处的同步工作且降低发送阻塞 | REQ-2和daemon红信号 | 隔离真实daemon反馈 |
| INV-4 | 请求成功、回复完整、SSE与导航交互保持 | REQ-3 | daemon反馈及最终完整TUI |
| INV-5 | fetch.start的bodyBytes保持实际UTF8长度，诊断不消费或复制请求正文；Uint8Array取既有byteLength，其他类型仍undefined | provider.ts111现有注释与传输日志合同 | 真实SDK请求及日志长度oracle |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-3 | 计量只取length，却生成整份大型JSON | Token.estimateRequest | 原HEAD CPU约2001ms；候选全返回值等价及低扰动ACCA |
| INV-3、INV-5 | 日志只取UTF8 byteLength，却分配整份编码缓冲 | provider.ts bodyBytes | encode采样283.14ms及无副本对照；既有注释明确不复制请求 |

Token历史根源：069bc6593请求级JSON长度、d98357f0 replacer分类；当前9f911f0 stringChars修正早于三个嫌疑提交。Token和processor在0ab→f04无diff。bodyBytes的encode由d8cf82c372（2026-05-27）引入，同样早于三个嫌疑提交。

原始反馈为真实worker/HTTP/global SSE/本地模型/隔离数据库发送期间两条控制路由3秒成功断言。最新无CPU采样ACCA中HEAD两轮均红、组合两轮均绿；BCCBBCCB中R1一轮红、组合四轮绿。完整波动和较早带CPU的候选失败全部保留，见§25–28。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 精确字符计量及分类 | Token.estimateRequest | 同请求返回一致计量 | 成本起源 | TUI不应补偿daemon同步工作 |
| 实际JSON传输 | SDK适配 | 发送完整body | 请求传输合同 | 估算器不替换SDK正文 |
| 请求日志字节长度 | Provider.bodyBytes，由timeoutFetch调用 | 不复制/消费body，报告精确已缓冲长度 | 此函数直接产生冗余UTF8缓冲 | NetworkProxy及TUI不拥有诊断计量 |
| offline判定 | 既有侧栏探测 | 现有3秒预算 | 本次仅观测 | 不通过放宽预算掩盖阻塞 |

## 10. Single Proposed Primary-Path Design

当前R4候选从最新目标HEAD e93b66fd仅改变两个计量点；以下设计保持，当前基线证据和审批状态以§36–37为准。

1. Token保留原JSON.stringify遍历、分类、媒体识别和toJSON；replacer末端仅将primitive string返回空字符串，同时累计其转义长度减2，最终短JSON长度加累计值得到bodyChars。boxed String和其他值保持原路径，原body不改写。
2. Provider.bodyBytes的string分支改为Buffer.byteLength(body, "utf8")，直接计算长度，省去TextEncoder输出缓冲。Uint8Array和其他类型分支原样保留。Buffer在同包shell/read/truncate/llm已有使用，不引入依赖、公开导出或新接口。

实际wire JSON仍由原SDK序列化并发送；Token计量body与SDK wire body形态不同，不共用或缓存编码结果。timeoutFetch的普通SDK路径provider.ts2269及gateway路径1158继续复用同一字节计量owner。yield、Worker、替代serializer、预算修改均不纳入。R2依据完整低扰动数据及公开日志合同验证送审，审批前仅隔离实验。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| JSON visitor字符计量 | proposed | primary-contract branch | yes | 新增primitive string分支 | R2候选 |
| string字节计量 | proposed | primary-contract branch | yes | 替换既有分支内部表达式，无新决策 | R2候选 |
| Uint8Array/其他body | current | pass-through | yes | 既有分支不变 | preserve |
| boxed/non-string保持原值 | current | pass-through | yes | 既有合同 | preserve |
| 后备估算器/Worker/缓存/超时增加 | rejected | forbidden fallback或无证据扩展 | — | 0 | reject |

新增诊断生产分支0，新增备用成功路径0。

## 12. Workaround Deletion and Replacement

没有既有fallback需删除。直接删除两处只取长度却产生整份正文输出的成本；保留分类、序列化错误、日志字段和传输流程。全部阶段探针、CPU采样、yield干预及独立诊断测试只在仓库外，不进入产品diff。

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| REQ-1 | 0ab/f04同HTTP发送 | 无产品修改，保留逐版本证据 | 同场景真实daemon |
| REQ-2、INV-3 | 请求准备计量 | core/src/util/token.ts候选 | 同body ABBA及daemon控制请求 |
| INV-1、INV-2 | 公开estimateRequest | core/test/util-token.test.ts扩展合同 | 完整返回值与独立JSON长度oracle |
| REQ-3、INV-4 | provider发送与TUI | 原路径保持 | 完整请求、回复、SSE及TUI操作 |
| REQ-2、INV-3、INV-5 | timeoutFetch的请求日志计量 | provider/provider.ts string分支 | B/C隔离对照及A/C完整反馈 |
| INV-5 | Provider.getLanguage→SDK→fetch.start | test/provider/provider.test.ts合同用例 | 实际wire字节长度独立oracle、body保持、EOF与取消 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| 单次visitor内补偿被省去的字符 | REQ-2、INV-1/2 | 完整JSON只取length | 原逻辑构造所有正文；既有分类计数可复用，增加一个累计量 |
| 不分配输出缓冲的UTF8长度计算 | REQ-2、INV-3/5 | 现有注释、encode CPU与内存分配实测、1010项长度等价 | TextEncoder接口总会产出Uint8Array；Buffer.byteLength已支持同一UTF8长度合同且仓库已有使用 |

## 15. File-Level Change Plan

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| packages/core/src/util/token.ts | modify，待审批 | 原visitor末端压缩计量中间字符串 | 约5–10行逻辑 |
| packages/core/test/util-token.test.ts | modify，待审批 | 公共计量合同及回归 | 约40–80行 |
| packages/opencode/src/provider/provider.ts | modify，待审批 | 仅string bodyBytes避免UTF8副本；就近注释 | 1行逻辑加注释 |
| packages/opencode/test/provider/provider.test.ts | modify，待审批 | 通过公开Provider/SDK验证日志字节长度与发送body保持 | 约35–75行 |
| 本canonical plan | add | 唯一规划证据与审计记录 | 文档 |

## 16. TDD Behavior Slices

公共seam为Token.estimateRequest、Provider.getLanguage→SDK公开发送及实际fetch.start日志、真实daemon HTTP发送；由完整Plan审计确认，不导出私有bodyBytes或新增生产测试开关。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 真实长历史发送期间控制请求超时 | 同步冗余JSON成本已有观测 | 先隔离候选证明因果，批准后最小修改 | offline与发送完整性 |
| 2 | 语义差分遇到候选错误必须失败 | 这类合同当前HEAD已通过，作为回归而非伪造功能红测 | 各字段、异常与观察次数完全相同 | Unicode/媒体/toJSON/boxed/重复引用 |
| 3 | 实际wire的bodyBytes被改错必须失败 | 当前HEAD保持该语义，作为性能修复的行为回归 | Logger捕获实际fetch.start，用TextEncoder独立oracle和短literal长度核对；发送正文原样 | 中文/emoji/转义及UTF8长度；EOF、取消仍走现有流合同 |

性能判别保留独占端到端反馈，不把固定CPU毫秒阈值塞入普通单元测试。13项长度恒等式实验后已执行原生产估算器与候选完整返回差分；详见§18。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| E | 70–160 | 生产与测试有效代码，排除imports/格式/生成 |
| C | 至少ceil(E×0.15)，约11–24 | 就近解释JSON补偿、boxed、getter、UTF8编码长度、日志不复制正文及公开seam独立oracle |

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/util-token.test.ts` | packages/core | 原合同与候选返回一致 |
| `bun run typecheck` | packages/core | 类型检查 |
| `bun test test/session/processor-effect.test.ts` | packages/opencode | 真实prepared callback回归 |
| `bun test test/provider/provider.test.ts test/provider/header-timeout.test.ts` | packages/opencode | 实际日志/请求/EOF/取消与现有deadline合同 |
| `bun run --bun typecheck` | packages/opencode及packages/core，各自运行 | 两个变更包完整类型检查 |
| `bun run script/build.ts --single` | packages/opencode | 本机完整产品构建，保留正常安装/嵌入步骤 |
| 官方Sky运行完整最终TUI并直接截图 | 原生桌面 | 真实发送内容、流式回复、会话导航；沿R1已验证夹具对R2重验 |
| 既有diagnostic-send-stress.test.ts命令 | 隔离packages/opencode | 3秒控制请求、发送完成、SSE |
| ABBA同body及相同daemon夹具 | 隔离目录 | 中位数、全部样本、峰值控制延迟、退出码与stderr |
| `python /workspace/shared/daemon-three-commit-recheck/abba-noalloc/run.py` | 独立archive，脚本指定包cwd；正式复验使用最终源码等价副本 | R2固定BCCBBCCB、ACCA两组，精确依赖，恢复原文件；旧abba/run.py仅历史证据 |

### 保留的R1历史实验（当前R2结论见§28）

低内存实测：原util-token九测试与仅替换导入的候选九测试共18 pass、0 fail、220 assertions。完整返回值差分3005项通过，其中1000组随机body各配三种sections，另含boxed、toJSON、稀疏数组及getter。1,049,054字节body交替12轮，原中位3.389ms、候选1.089ms；原范围1.049–11.280ms、候选0.156–4.735ms。候选尚未接入生产，局部计量收益保留抖动，不替代发送体验结果。原始日志见§4。

已执行125MiB场景两组ABBA，PR6 hook及其他重载明确错峰。相同f04 archive、Bun1.4.4、依赖和2001条×65536字符夹具，唯一切换core/src/util/token.ts。每轮剩余可用内存约6396–6873MiB。A源码SHA256为809194e2e1c6482cc41934999caf7b5b520acb32fb2cd09289acc884ebb83a26，B为5c06448644defa3efa1ef36b304c27054b61b8248a94cdb084c06eb776289f43；运行结束A已恢复。原始结果由本计划负责人逐轮核读并与脚本、源码diff对照。

| 轮次 | 变体 | 发送ms | health最大ms | endpoint最大ms | 超时请求数 | 测试退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A | 6571 | 3001 | 3001 | 2 | 1 |
| 2 | B | 5462 | 1882 | 1948 | 0 | 0 |
| 3 | B | 5476 | 1846 | 2015 | 0 | 0 |
| 4 | A | 9550 | 3001 | 3001 | 2 | 1 |
| 5 | A | 6290 | 3000 | 3001 | 2 | 1 |
| 6 | B | 6110 | 2338 | 2402 | 0 | 0 |
| 7 | B | 7251 | 1984 | 2191 | 0 | 0 |
| 8 | A | 7134 | 3001 | 3001 | 2 | 1 |

A中位6852.20ms，B5793.17ms，减少1059.04ms/15.46%。八轮均POST200、模型恰收到一次请求、返回完整diagnostic reply、SSE未结束；显式关闭daemon后退出码全0、stderr全空。A测试退出1是既有控制请求全部成功断言失败，daemon自身正常。B全部通过该原红信号。SSE数据块数11–14受分块影响，不把块数相同作为消息语义要求。模型夹具读取完整请求后返回固定回复，日志直接验证请求成功与回复出现；INV-4的实际发送内容与完整TUI操作仍在正式实施验收核对。

完整应用启动与真实屏幕截取仍属后续实施验收；现场原始历史及用户客户端环境尚待材料。该实验使用构造长历史，不把125MiB负载称作用户真实数据。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1文档 | 唯一Plan |
| Files modified | 4候选 | 两个成本owner与各自既有测试 |
| Files deleted | 0 | 无独立冗余模块 |
| Production lines | 约6–12逻辑加就近注释 | 复用原visitor及现有body类型分支 |
| Test lines | 75–155 | 两个公开合同；不改无关用例 |
| Generated lines | 0 | 无接口变化 |

## 20. Real Risks and Open Decisions

本节以下数字保留R2规划时的无CPU采样分组记录；最新目标基线ece062da8的当前结果见§32。

SDK完整wire序列化仍存在。带CPU采样的组合候选仍曾超时；无采样12轮中C六轮控制成功，最慢endpoint2882.56ms。B/C发送中位C慢2.51%，A/C完整组合快25.27%，分组分别报告。该样本为固定125MiB构造长历史，样本轮数有限；最终实施保留完整同口径反馈及真实TUI验收，不把某一微基准或一次绿测替代全部门禁。

关键方案假设：Token全返回值等价已通过3005项；UTF8长度1010项通过；公开SDK日志合同隔离试验4pass/16断言，见§28。任何行为差异先修订Plan，停止产品实施。现场原始会话数据尚无可用材料，构造历史覆盖原故障的相同worker/HTTP/SSE路由和同步热点。

### Open Decisions Requiring the User

当前无需新增产品决策；沿原授权继续验证及独立审计。

### Rejected Speculation

三个提交的时间相邻不足以建立回归归因。单次yield未显示必要性，排除；不增加Worker、缓存、替代serializer、探测期限或诊断生产开关。

## 21. Audit Contract

独立auditor自行读取原始需求、本文、仓库policy与实际证据，full-scope审计owner、因果信号、正反映射、单一路径、测试及中文注释。primary不加载adversarial-audit或进行自审；handoff仅含原始需求、plan路径、repository root、Audit mode: plan。

## 22. Plan Audit Record

R1独立方案审计第1轮，由/root发起并传回以下完整裁决。R1当时获得No blocking findings / APPROVE；仅更新行政审批字段，设计未变。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §4 补列直接消费者 `packages/opencode/src/session/prompt.ts:1646`。它使用估算结果选择历史窗口；INV-1 的完整返回值等价已覆盖其合同，补充引用即可。
- §8“候选端到端因果仍待验证”和§20“先完成低内存合同实验”应更新为§18的已完成状态，属于记录补正。
- 当前模型夹具读取完整请求后返回固定回复，日志直接证明请求成功及回复出现。后续实施验收仍按 INV-4 核对发送内容及完整 TUI 操作。

## Rejected speculation

- 不将三个提交与症状的时间相邻认作回归归因。旧基线同样出现控制面超时，计量路径早于三个嫌疑提交。
- 不要求修改探测期限、SSE心跳、SDK序列化、分页、缓存或引入 Worker。
- 125MiB构造历史提供了可重复性能信号；用户实际历史和客户端验收保留为后续实施要求。
- 既有调用者的其他分支不属于本次修改范围。

## Requirement and traceability coverage

审计对象为 **R1**，基线为 `f04f9307957774ad5a21b4cfe70921a4fce20d5a`。工作树仅新增 canonical plan。

已核对源码、调用者、现有测试、实验脚本、候选差异、历史提交及原始运行日志：

- 当前估算器在同一个 JSON visitor 中分类计数，最终整份字符串仅用于取长度。真实请求准备回调同步调用该估算器。
- 候选只增加省略字符累计量，在分类完成后将 primitive string 的序列化返回值替换为空字符串，再补回长度；原对象、boxed primitive、原生遍历及异常路径保持。
- 既有生产估算器与候选合同测试共18 pass、220次断言；完整返回值差分及独立 JSON 长度检查支持 INV-1、INV-2。
- 两组 ABBA 仅切换计量源码。原版四轮均触发控制请求超时，候选四轮均通过；发送中位数由6852.20ms降至5793.17ms，下降15.46%。
- 八轮均收到成功响应和回复，daemon关闭退出码均为0。原版测试失败位置是控制请求成功断言。
- 文件计划、公共测试边界、正式红绿与回归步骤明确；生产改动限定在成本产生处，测试保持独立 oracle。
- §17承诺实际 C 至少达到 `max(1, ceil(E×0.15))`，预算可执行。

## Primary-path and fallback verdict

修复归属 `Token.estimateRequest`，直接减少计量阶段冗余字符串构造。分类、媒体估算、历史校准及真正发送请求继续沿原路径执行。

只有一个计量算法；新增备用成功路径0，新增生产诊断分支0。隔离实验代码排除在正式 diff 外。

## Release verdict

**APPROVE**

仅批准 **R1**。当前目标为 approved-plan-only，可原样记录裁决并更新审批字段。后续实施按该版本完成正式验证及独立实现审计。

## 23. Implementation Evidence

以下为R1历史实施证据，已于R2规划开始恢复HEAD；R2尚未实施。

### Actual Files and Diff

R1当时正式diff为core/src/util/token.ts（+7/-1）和core/test/util-token.test.ts（+38/-0），以及本Plan。生产只加入字符补偿量和primitive string分支；测试走公开estimateRequest。诊断脚本放在仓库外 /workspace/shared/daemon-perf-implementation-evidence，不进入提交。

### Red-Green Test Evidence

正式HEAD红测：同一真实daemon反馈，发送8347.17ms，两个控制请求超时（最大3002.02ms），test exit1。随后按R1修改owner；正式绿测发送5797.78ms，控制请求0失败（最大2462.81ms），1pass/11断言、exit0。两轮都POST200、模型请求1次、回复出现、SSE未结束。

公共语义回归：新增用例首次未传sections却读取可选breakdown，产生夹具TypeError；修正为公开接口显式sections=[]后，原HEAD10pass/130断言。正式候选同样10pass/130断言。该错误属于测试设置并保留semantic-head.log，不冒充性能红信号。实际性能红绿见formal-red.log/formal-green.log。红测期间有一次约0.44秒的轻量合同复跑，独占性能结论采用前述8轮ABBA，不以此单轮正式红绿计算稳定改善幅度。

### Verification Commands and Results

证据目录 /workspace/shared/daemon-perf-implementation-evidence：

- packages/opencode：`bun test --timeout 90000 /workspace/shared/daemon-perf-implementation-evidence/daemon-feedback.test.ts -t 'diagnostic real daemon'`，formal-red / formal-green日志如上。
- packages/core：`bun test test/util-token.test.ts`，semantic-green.log，10pass/130断言。
- packages/core：常规`bun run typecheck`因宿主node链接循环exit126；改用Bun支持的`bun run --bun typecheck`运行同一tsgo --noEmit，core-typecheck-bun.log，exit0。
- packages/opencode：首次`bun test test/session/processor-effect.test.ts`为40pass/1fail（midstream server_error收到stop）。查明复用archive的包级openai-compatible为循环链接，回退到2.0.37；HEAD锁要求2.0.41及仓库patch。仅修复本任务node_modules依赖，恢复2.0.41并应用仓库已有patch，产品diff未变。同依赖HEAD/候选单例各1pass/4断言；完整复跑processor-regression-correct-deps.log为41pass/220断言，exit0，51.19秒。
- 之前8轮ABBA双方使用同一旧依赖，证据保留为历史实验。精确锁定依赖8轮已完成，见下文；最终TUI也使用修正依赖。

### Original Feedback-Loop Result

0ab/f04大历史发送均出现控制请求3秒超时。

### Actual Secondary and Replacement Path Inventory

primitive string补偿与其他JSON值保留构成原计量合同内分支；新增备用路径0、生产诊断路径0。没有新增workaround。

### Chinese Comment Calculation

当前E=38、C=6，最低ceil(38×0.15)=6。按新增/实质改动代码行计，排除空行、import-only和文档；六行中文注释就近解释转义oracle、boxed拆箱、分类总和、getter观察时点、异常保留及生产补偿恒等式。待实现审计独立复算。

### Remaining Unverified Items

完整TUI与发送内容已验证，见下文。精确锁定依赖反馈仍有候选超时，性能终态尚未满足；用户现场历史尚待可用材料。

## 24. Implementation Audit Record

R1未进入实施审计且已撤回。R2等待本revision独立方案审计；目标verified-implementation-and-commit保持，按R2批准后正式红测、实现及独立实现审计，满足门禁后提交，不push。GOAL active。


## 25. 锁定依赖复验及当前门禁

本节更新验证事实，保持R1批准设计与完整审计原文；R1当时生产diff冻结，继续隔离定位；R2规划时已恢复HEAD。§18的15.46%与4/4绿对应旧2.0.37依赖，正式终态以本节锁定2.0.41及仓库patch的结果判断。

原始材料为 `/workspace/shared/daemon-three-commit-recheck/abba-locked-deps/` 的 results.json、summary.json、dependency-metadata.json、resolution.log、run.py、8组stdout/stderr及原/候选源码。顺序ABBAABBA，同一archive只切token.ts；结束恢复原版SHA。A四轮发送8401.47、6503.72、6376.18、6533.59ms；B四轮6693.08、5814.60、5510.80、7510.56ms。A中位6518.65ms，B6253.84ms，下降264.81ms/4.06%。A四轮均有health及endpoint超时；B前三轮通过，第四轮（全局第7轮）两个请求分别3000.65/3000.67ms超时。B通过轮endpoint峰值2934.52、2772.71、2530.77ms。八轮发送成功、回复出现、SSE保持、退出0、stderr空。

当前门禁判断：INV-1/2合同回归通过，INV-4完整应用功能验收通过；INV-3原始控制请求反馈在B第7轮继续失败。R1具备局部计量收益及本组发送中位改善，当前实验尚未满足完整反馈全绿，不进入verified或commit。保留失败样本与全部时序，不通过放宽3秒探测、删轮次或改成功断言消除失败。

完整TUI证据 `/workspace/shared/daemon-perf-native/REPORT.md`：官方Sky直接运行完整应用，主模型请求1次、2条messages/13tools，实际ASCII引号和反斜线输入逐字一致；首段后36.171秒受控挂起期间命令面板及会话导航可用，最终SSE拼接正文与期望逐字相等，中文emoji实机显示。5张原生截图及报告已归档Library `libfile_84804fcd9330819185bbcb30e52a63c3` version0，234675bytes，SHA256 `0fb907b4fe2b9a6f96980df3b524ab4d8f3d7d8add0df487be06cb0955695dfe`，回下载空目录全部hash通过。此次为短合成请求；性能使用上述125MiB构造会话。

下一项诊断沿既有发送链寻找连续阻塞的首个耗时阶段。旧f04 CPU采样记录计量stringify约2001ms、SDK请求stringify约2004ms，均发生在发送链；最新第7轮同时阻塞无provider依赖的health，优先对齐准备计量结束、SDK序列化起止、fetch实际发出与控制请求入队时间。旧profile与新失败轮不是同一运行，阶段归因须用精确依赖候选的隔离探针核实。只在独立副本采集，不增加正式生产分支。若证实需要改变owner/范围/文件或算法，修订同一Plan为R2、清空审批并重新独立方案审计后实施。

精确依赖ABBA证据已由执行者独立持久化到Library `libfile_d92346d369188191b6131971a30e7b27` version5，包SHA256 `0f8ca160e8b58b91118ce77700d94f62bc203f6c951dabe37804e7a2d4f70716`；回下载到空目录后完成包hash及逐目录diff核对。阶段探针由consult_check在独立archive准备并执行，baseline_check独立核查调用链与时序，我维护唯一Plan；正式R1源码保持冻结。


## 26. R2 规划中的精确阶段证据

`stage-locked/analysis.txt`、run.log、trace.stderr.log与CPU profile记录同一轮精确依赖B：计量437.94ms，19.24ms后SDK stringify开始并持续2514.07ms，生成131301719字符，2.70ms后fetch开始。100ms事件循环计时器跨整段延迟4152.34ms。失败health/endpoint请求在计量前521.45ms发起，在SDK序列化尚在执行时达到3001ms。fetch发出后约690.93ms才恢复计时器，响应在1279.96ms后到达。SDK stringify CPU自耗2513.12ms与墙钟阶段相符。源码和局部依赖链接结束恢复，restoration.json三项SHA核对均true。证据已归档同Library version6并读回校验。

已观测的首个调度分歧是准备回调中的同步计量完成后，19.24ms内直接进入SDK大请求序列化，期间控制请求无执行机会。R1减少计量CPU工作，剩余相邻同步阶段仍累积超过既有3秒预算。SDK实际传输必须生成完整请求；当前先验证既有Effect调度让步能否在准备与传输边界实际服务积压控制请求，再判断是否值得作为源头调度修复。该干预不会减少SDK自身序列化成本，若单段SDK和fetch仍越过反馈预算则排除此单点方案。

隔离候选位置为processor的onRequestPrepared在publishAssistant完成后、返回给传输前，沿既有Effect.yieldNow调度。现有MixedScheduler使用setImmediate，yieldNow取消会阻止排队的fiber继续。需以实际bridge/runtime证明控制请求在SDK开始前完成，并验证发送内容、overflow抢先中止、取消期间不启动provider，以及SDK/native两条已存在调用路径。现阶段只作可证伪实验，不列为已通过生产方案。

单点让步隔离结果（stage-yield）：timer版先完成，计量393ms、让步4.12ms；health在让步期间完成，耗时886.73ms。相同起点endpoint仍需后续异步阶段，受到下一段SDK同步工作阻塞，3000.40ms超时；SDK stringify1792.31ms，fetch至事件循环恢复约494ms。发送6133.47ms、回复完整、SSE持续、退出0。此证据排除“仅在prepare尾部让步一次即可通过双控制反馈”的设计，R2不纳入该单点生产修改，也不追加任意多次yield。下一检查转SDK是否重复生成完整请求或现有传输是否有可复用编码能力，先源码取证。

R2规划开始后，R1实现已保存到仓库外 `daemon-perf-implementation-evidence/r1-frozen/`：implementation.patch SHA256 7184440dbe425f562c605c5c661af4fcd4b72c5b004dd4298ed3a94cbd351c47，token.ts SHA维持f1b4106e…，测试SHA d29af803566631bb636736289a21070239ec1367441e61f39ba4863aaae0e243。保存文件逐一cmp，反向apply --check后撤回，再正向apply --check确认可重放；正式树生产与测试恢复HEAD，仅canonical plan未跟踪。此前“冻结diff”是进入R2前状态。

后续源码核查发现发送日志计量的独立冗余：provider.ts bodyBytes(string)调用TextEncoder.encode(body).byteLength，在fetch.start参数构造时对完整wire字符串再分配UTF8缓冲。此处仅消费长度，可测试Buffer.byteLength同UTF8长度合同而省去整份输出缓冲。先做Unicode及surrogate等价，再用既有无yield夹具隔离验证实际耗时、内存与控制反馈；验证成功后再确定R2是否纳入该owner，当前无生产实现授权。

无UTF8副本隔离验证：1010项字符串长度差分全部相同。首轮B+Buffer.byteLength、无yield为health峰值2741ms、endpoint2889ms、发送6789ms；同探针成对复核原B发送8848.51ms、两控制3000.43/3000.38ms超时，B+noalloc发送7404.60ms、两控制3056.25ms超时。原bodyBytes encode采样CPU283.14ms，候选该分配消失；进程采样峰值RSS分别2007969792和1962237952字节。SDK序列化仍2403/1856ms。所有请求回复、SSE及退出正常，源码恢复。原始目录stage-byte-baseline、stage-byte-candidate。此处已验证长度合同及冗余缓冲消除，单次端到端对照仍红，R2继续保留draft，不以首轮通过覆盖后续失败。

下一项先对齐候选失败probe跨越的实际阶段，检查计量前后未标记的区间；CPU采样与无采样需分别记录。若评估源头无副本与既有调度让步的组合，保持同一主路径、单次调度、相同超时和实际请求合同，先用关闭CPU采样的轻量阶段对照验证，失败则排除，不机械叠加让步。

成对无副本失败的同钟细分：以Token开始为0，probe起点-455.07ms，Token结束329.45ms，SDK开始357.82ms、结束2213.63ms，fetch2219.48ms，probe超时2601.13ms。故本轮超时覆盖SDK前813ms、SDK1856ms和fetch后382ms；不是SDK单段独自超3秒。完整证据Library version8，SHA256 c986136c04591d4a2cdb88cc52a782191ffad973994422ca1e42f7520752f56f，已回下载空目录校验。

调度候选若通过性能信号，行为验证必须经过实际SDK/native调用者。SDK的transformParams在llm.ts383以bridge.promise执行准备回调，随后return args.params；该调用未显式传入abort options，需在真实模型发送边界核对取消后的provider请求数，不能只用独立Effect.yieldNow小例子替代。native-runtime.ts136将同一回调交LLMClient.stream，其compile/transport语义与SDK不同；保持既有overflow先于publish/让步，以及现有processor取消回归。

## 27. R2 低扰动重复试验预注册

轻量成对（stage-light-noalloc、stage-light-yield，无CPU采样）均通过：无副本发送5252ms、health2070ms/endpoint2125ms；无副本+Effect.yieldNow发送5055ms、health1828ms/endpoint1926ms。yield实际1.29ms，两个慢probe均在SDK序列化后完成，未观察到它提前服务控制请求。SDK各1322/1149ms，计量168/100ms；峰值RSS1280962560/1254248448。CPU采样轮与无采样轮耗时明显不同，接下来性能判别统一不采样；yield缺乏独立必要性，从R2候选排除。

预先固定以下变体及顺序，再执行和看结果。A为当前目标HEAD的原Token与原UTF8 encode计量；B为R1 Token候选与原UTF8 encode；C为同一Token候选与Buffer.byteLength。三者精确依赖、fixture、运行时、模型回复及控制探测预算相同；不包含yield。第一组B-C-C-B-B-C-C-B共8轮，隔离无副本的贡献；第二组A-C-C-A共4轮，检查候选完整组合相对HEAD的实际收益。分组分别报告，不把所有原版或候选混成一个大样本。

每轮运行全新daemon和同一构造历史，前轮退出后启动下一轮。禁用CPU profile、附加stage trace与周期RSS读取，仅保留原反馈的控制请求与发送数据，以及每轮前后静态内存状态。以原独占执行安排防止其他回归负载污染。保存每轮源码/依赖哈希、命令、原始stdout/stderr、退出值；每个失败轮保持原样，预定12轮全部执行，不因先出现通过而提前停止，不因失败追加选择性重试。

判读指标为逐轮发送时长、health/endpoint各自最大时长及超时数，回复完整性、模型请求次数、SSE和退出行为。报告组内中位、范围及逐轮值；同时列出相邻B/C和A/C正反顺序比较，保留抖动。C任一轮原反馈失败则完整验收继续失败；B全部通过时，本组只能判断发送/控制延迟变化，不能宣称该组证明消除超时。关键结果是原始反馈是否保持绿色及相对HEAD收益是否重复出现，最终仍需完整行为与实现审计。

R2目前考虑的完整终态仅包含两个已观测冗余成本owner：Token计量省去长度之外的正文输出；provider bodyBytes省去仅用于取长度的UTF8输出缓冲。正式文件范围拟为core util/token及合同测试、opencode provider/provider及其已有公开fetch日志计量合同测试。新增公共API、调度分支、配置、Worker、序列化算法均为0。文件/TDD映射待本轮因果结果及现有测试seam核查完成后更新到§13–19并送完整独立审计。


## 28. R2 关键假设与完整结果

本节记录方案审计时的数据，顶层SDK已锁定，后来发现传递链回落；完整闭包修正和最终同序列重验结果见§30，原数据保留供追溯。

### 低扰动预注册12轮

已逐轮检查summary、results、原始发送/控制日志、runner及恢复记录。配置为精确锁定openai-compatible2.0.41及仓库patch、Bun1.4.4，相同独立archive。每轮只切Token和bodyBytes预定源码，原HEAD及候选SHA记录在results；无CPU、stage与周期RSS采样。restoration.json的token/provider均true。

| 轮次 | 变体 | 发送ms | health最大ms | endpoint最大ms | 超时数 |
| --- | --- | --- | --- | --- | --- |
| 1 | B | 6318.60 | 2898.28 | 3056.13 | 1 |
| 2 | C | 5908.66 | 2765.16 | 2882.56 | 0 |
| 3 | C | 6175.48 | 2099.59 | 2137.87 | 0 |
| 4 | B | 6953.24 | 2807.36 | 2893.52 | 0 |
| 5 | B | 5469.68 | 1951.00 | 1996.78 | 0 |
| 6 | C | 5043.85 | 2247.95 | 2428.74 | 0 |
| 7 | C | 6600.24 | 2571.83 | 2639.09 | 0 |
| 8 | B | 4369.48 | 1584.23 | 1641.43 | 0 |
| 9 | A | 6117.19 | 3000.44 | 3000.47 | 2 |
| 10 | C | 4681.34 | 1699.43 | 1741.39 | 0 |
| 11 | C | 6185.68 | 2328.33 | 2415.95 | 0 |
| 12 | A | 8424.29 | 3000.66 | 3000.66 | 2 |

BCCBBCCB组B中位5894.14ms，C6042.07ms（C慢2.51%）；四对正反顺序的C相对B发送变化为-409.94、-777.76、-425.83、+2230.76ms，保留第四对反向结果。B1/4红、C0/4红支持本组控制反馈改善，单独无副本的发送中位收益未获支持。

ACCA组A中位7270.74ms，C5433.51ms，下降25.27%；两对C相对A各-1435.86、-2238.61ms。A2/2红、C0/2红。C合计六轮全绿，endpoint最慢2882.56ms。12轮全部HTTP200、模型请求1次、回复出现、SSE未结束、清理exit0、stderr空。结果符合此前预注册的候选反馈判据；较早有CPU采样的失败保持在§26，有限样本和合成负载边界保持可见。

原始路径 `/workspace/shared/daemon-three-commit-recheck/abba-noalloc/{run.py,results.json,summary.json,restoration.json,1-B.log…12-A.log}`。目录独立保存源版本，不覆盖此前失败轮。

### 字节长度与真实公开seam

`stage-noalloc/equality.ts`及equality.log：1010组ASCII、Unicode、孤立surrogate、随机UTF16及1MiB字符串，Buffer.byteLength与TextEncoder.byteLength完全一致。

`provider-public/diagnostic-byte-public.test.ts`为仓库外测试副本，在真实Provider.getLanguage捕获logger前注入真实文件logger，SDK发送时只mock网络边界NetworkProxy.fetch。实际fetch.start观察到165字节，TextEncoder对捕获wire计算也为165；JSON解析出的用户内容逐字等于输入，包含中文、emoji、引号、反斜线、换行、tab、孤立surrogate。消费模型流到EOF后sse.end存在。另原三项不同前序logger的在途取消/EOF例通过。命令为隔离packages/opencode执行 `bun test test/provider/diagnostic-byte-public.test.ts -t 'diagnostic public SDK bodyBytes|SSE wrap: in-flight cancel'`，4pass、0fail、16断言，13.89秒。产品provider结束恢复。此隔离测试证明公开接缝可行；正式实现沿仓库排版及中文注释规则新增合同用例，去除diagnostic命名、console采样和非空断言，不复制整份测试文件到正式树。

普通SDK及gateway均调用timeoutFetch的既有bodyBytes。变更只在string分支；Uint8Array的直接byteLength与其他类型undefined分支不变。正式测试核对实际发送字节和原内容，不断言私有函数调用次数、不mock Buffer或TextEncoder、不以堆分配时长作单元测试断言。原始性能红绿继续通过实际daemon反馈验证。

### 持久化与下一门禁

完整12轮及公开seam证据已归档Library `libfile_d92346d369188191b6131971a30e7b27` version11，file_id `file_00000000070081fba33ae3f5c7659991`，SHA256 `2ad5fdfee76aa75a493cd1f35ff94c6e1812d367e85d3d60d10bae7b8dc55a31`。执行者回下载到空目录，包hash与逐目录diff通过。

R2关键方案假设已在隔离副本验证，正式树仍为当前HEAD。下一门禁为独立完整方案审计；R1的APPROVE仅作为历史，不放行R2。获R2批准后按§16正式HEAD红测、两个最小owner实现、合同与关联回归、相同低扰动反馈、完整build及TUI，随后独立实现审计；verified后方可按授权commit，禁止push。

## 29. R2 独立方案审计原文

由/root发起的独立方案审计；以下原样记录完整verdict。本行政审批记录不修改设计。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §18 保留了 R1 的 ABBA 命令。正式 R2 性能复验应使用§28的 `abba-noalloc/run.py`，保持 BCCBBCCB、ACCA 两组及精确依赖。
- §22“当前revision获得批准”、§23“正式diff目前为”、§25“当前生产diff冻结”等历史描述应明确标注为 R1 当时状态，避免与当前 R2 待批准状态混读。
- 单独替换字节计量的 B/C 组发送中位数慢2.51%；完整组合的 A/C 组快25.27%。保持两组分别报告。

## Rejected speculation

- 不因残余 SDK 序列化成本要求增加 Worker、缓存、替代序列化器或调度让步。
- 不要求调整3秒控制探测、请求期限或 SSE 心跳。
- 不因生产日志仍存在而要求删除日志。此次修改保留日志合同，只消除计量产生的临时编码缓冲。
- 不将旧依赖实验、CPU采样实验与精确依赖低扰动结果混合统计。

## Requirement and traceability coverage

审计对象为 **R2**，基线为 `f04f9307957774ad5a21b4cfe70921a4fce20d5a`。实际工作树仅新增 canonical plan，生产和测试保持 HEAD。

已重新核查完整需求、两个修改点、直接调用路径、候选源码差异、实验脚本与原始日志：

- Token 候选保持同一原生 JSON 遍历及分类，在末端补偿 primitive string 的省略长度。全部返回字段、对象观察和异常行为有公共合同验证。
- `provider.ts:110–115` 当前为字符串分配完整 UTF8 缓冲后取长度；`:329–332` 在实际 fetch 前同步调用。普通 SDK 和 gateway 均复用该 owner。
- 候选仅将字符串分支改为 `Buffer.byteLength`；Uint8Array及其他类型分支保持，原发送正文不变。
- 1010项 UTF8 长度差分通过。真实 Provider/SDK 接缝观察到日志165字节，与独立 TextEncoder oracle一致；输入正文逐字保持，EOF日志存在。关联取消测试与该用例共4 pass、16次断言。
- 预定12轮全部保留。完整组合 C 六轮控制反馈全绿；ACCA组 HEAD 两轮均红，组合两轮均绿。各轮请求成功、回复出现、SSE保持，清理退出码均为0。
- 两个生产 owner、各自现有测试文件及计划文件均有正反映射。正式红绿、关联回归、类型检查、完整构建、真实 TUI截图和实现审计均列入终态。
- 中文注释承诺满足实际 `C >= max(1, ceil(E×0.15))`，预算可执行。

## Primary-path and fallback verdict

R2直接优化两个已观测的计量成本源头：请求字符计量和发送日志字节计量。实际 SDK 序列化、传输、取消、EOF及错误路径保持。

新增备用成功路径0；日志字段、诊断分支和错误结果均未扩展。隔离探针、采样、yield候选及诊断副本排除在正式 diff 外。

## Release verdict

**APPROVE**

仅批准 **R2**。可原样记录裁决并按批准范围实施。达到 verified、完成独立实现审计后方可提交；按本计划禁止 push。


R2非实质记录补正：§18正式复验命令已指向abba-noalloc；§22/23/25加R1历史时点；B/C慢2.51%与A/C快25.27%仍分别保留。设计与审批revision未变。

## 30. R2 正式实施证据（进行中）

批准revision为R2，完整独立verdict见§29。实施前正式tree仅Plan、四个预定生产/测试文件均与HEAD一致。正式HEAD真实daemon红测（r2/formal-red.log）发送7537.32ms，两控制超时、最大3000.77ms，exit1。Token新增合同在HEAD10pass/130断言；按批准算法实施后10pass/130断言。provider新增公开日志合同在HEAD1pass/4断言；随后仅替换string bodyBytes并加解释注释，候选同样1pass/4断言。合同HEAD通过是保持语义回归；性能红信号来自真实daemon。

正式组合绿测（r2/formal-green.log）发送6205.43ms，控制0失败、最大2539.01ms，1pass/11断言，17.51秒。两轮模型请求1、HTTP200、回复出现、SSE保持，清理正常。processor完整回归41pass/220断言、50.05秒。随后工具连接断开；重连后provider回归日志只有中途输出、进程已不存在，未计通过。已按正常审批重跑完整provider/header-timeout并接opencode类型检查。

证据统一位于 `/workspace/shared/daemon-perf-implementation-evidence/r2/`。测试从对应packages/core或packages/opencode运行；真实daemon脚本位于仓库外daemon-feedback.test.ts，导入正式树，保持原fixture与断言。最终12轮使用批准BCCBBCCB和ACCA分组；build/TUI及独立实现审计随后执行。

当前实际diff：Token +7/-1、core合同 +38、provider +2/-1、provider合同 +61，加唯一Plan。初算E=92、C=14，ceil(92×0.15)=14；排除空行及文档，未新增imports。注释分布在JSON补偿、独立oracle、boxed/getter/异常、日志不复制正文、真实网络seam、UTF8输入、EOF就绪和logger捕获处。待最终实现审计复算。

回归状态纠正：连接恢复后write_stdin取得第一次回归的完整退出值，provider-regression.log确为129pass/2fail、35.76秒；此前仅看到中途日志时误判为运行中止。第二次完整复跑同样129pass/2fail、353断言、39.38秒。两项失败均为header-timeout.ts119/274期望ResponseStreamError而实际收到SDK包装的AI_APICallError。排查发现openai-compatible2.0.41的传递依赖provider-utils4.0.23（bun.lock的opencode/core scoped条目）当前落到了root4.0.51；已安排核查完整传递链并从现有官方缓存修复本任务局部依赖，不改锁文件或测试断言。此前“精确依赖”仅核到顶层SDK和patch，完整传递链结论在修正前保留为环境缺口，性能与回归将重验。

首次opencode类型检查为SIGKILL、exit1，日志完整保留；进程已退出，重新用同一官方tsgo二进制加GOMAXPROCS=1分别对opencode/core运行完整--noEmit，未缩减检查范围。

完整SDK闭包修正：`/workspace/shared/daemon-perf-sdk-locked/` manifest和resolution记录7包来源/每文件SHA/实际递归解析。openai-compatible2.0.41+原patch，provider-utils4.0.23、provider3.0.8、standard-schema/spec1.1.0、eventsource-parser3.1.0、json-schema0.4.0、zod4.1.8，全部按锁文件解析且不回落外层。正式opencode与core scoped入口指该闭包。修正后原两文件完整回归131pass/0fail/354断言、45.15秒，产品逻辑和失败断言均未更改。

GOMAXPROCS=1单独限制Go并发仍使opencode检查SIGKILL；core完整--noEmit通过。随后按官方help使用--singleThreaded，opencode完整检查正常结束并报告5项错误。新增provider合同的tmpdirScoped引入未提供服务，改用已有TestInstance.directory，窄测1pass/4断言；另4项由依赖布局导致：OpenAI解析到3.0.48，改为锁定3.0.88及嵌套provider3.0.14/utils4.0.40，原仓库patch反向check通过；Gitlab/Poe共享包的真实路径解析旧工作树plugin产生名义类型冲突，复制为本任务本地包以解析当前workspace。仅node_modules调整，锁文件不变。类型检查将在完整依赖稳定后重跑。

最终低扰动12轮复验已由独立执行者启动，使用正式Token SHA f1b4106eae8fbf89547f53409da73100ce1ca106aa5c9df747104714ec288e84、provider SHA e4e38fe5baa8239d177aaed9c3d3d9e63c013257d0922c1fa2085471ecf87279及HEAD对照，所有变体同一完整7包SDK闭包。旧“精确依赖”轮次保留为顶层精确、传递链修正前证据，最终验收以新完整闭包结果为准。

完整锁定传递链后的最终12轮（abba-final）已逐轮核对：BCCBBCCB组B中位6385.76ms、C6313.60ms，C减少1.13%；B第8轮endpoint3035.63ms超时，B1/4红、C0/4红。ACCA组A7039.15ms、C6010.20ms，减少14.62%；A2/2红、C0/2红。C六轮全部控制请求通过，最慢endpoint2891.19ms。12轮全部请求/回复/SSE正常、清理exit0、stderr空。最终Token快照f1b4106e…、provider e4e38fe…；随后正式provider仅增加一行孤立代理项兼容注释（post-run-comment.diff），行为代码一致，正式hash 2e0bcb204c8947c7804572bf28795881f66ee827db6c8b4ccf7cd0d9060438cf。最终E=92、C=15，待实现审计复算。

最终性能证据与完整SDK manifest归档Library同ID version12，file_id file_00000000556081f59eb49cf98ca007a5，SHA256 d64c4c66cb700a7aa27077593c26eee0a72692cd4de1034215e7ceb8af2d8c8d，空目录回下载及目录diff通过。旧数据按其依赖/采样环境分别保留，最终验收采用本轮。

独立构建副本 `/workspace/shared/daemon-perf-build-r2` 从同HEAD建立并应用四文件最终diff，私有cache与XDG/HOME避免构建自带安装/清cache步骤触碰共享依赖。完整构建保留原build.ts --single的WebUI和native步骤。最终opencode --noEmit --singleThreaded检查已exit0，core及关联回归仍按序执行。


最终完整类型检查：同一官方tsgo `--noEmit --singleThreaded`、GOMAXPROCS=1，从packages/opencode与packages/core分别执行，两者exit0。最终core合同10pass/130断言；opencode合并执行provider/provider.test.ts、provider/header-timeout.test.ts、session/processor-effect.test.ts，共172pass/0fail/574断言、86.39秒。日志分别为opencode-typecheck-final.log、core-typecheck-final.log、core-contract-final.log、associated-regression-final.log。此时SDK完整闭包、OpenAI嵌套版本和plugin workspace身份均已修正。

独立build的 `bun install --frozen-lockfile` 与原 `bun run script/build.ts --single` 已按正常工具审核启动，未跳安装、WebUI或native步骤，使用私有cache及HOME/XDG；执行日志和退出值正在收集。

完整构建通过。第一次frozen安装因tree-sitter-bash原脚本找不到node-gyp-build退出127；将私有cache中锁定4.8.4的原bin.js加入本任务PATH后重跑，2102包安装完成（141.99秒）。原postinstall fix-node-pty与prepare husky均执行。随后原build.ts --single包含WebUI构建/嵌入、三项native安装、本机编译、--version smoke及voice worker smoke，全部exit0。

产物 `/workspace/shared/daemon-perf-build-r2/packages/opencode/dist/opencode-linux-x64/bin/opencode`，236239024字节，SHA256 6e6bf89d5a4207a04b9890cba437ad5103ba9cc8f2f41e12bc7df935347dae93，版本0.0.0--202611181703。opentui-build.json记录native0.4.3-smark.13与libopentui.so SHA ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d。完整日志build-install-tool-path.log/full-build.log保留首次失败及重跑。

构建原安装步骤重写隔离副本bun.lock（registry地址/顺序及闭包记录），diff另存build-lock-rewrite.diff，不进入正式树或本任务提交。构建实际SDK七包递归解析记录build-sdk-resolution.json，版本全部与最终性能闭包一致；SDK仓库patch反向check通过。四个正式修改文件逐一cmp构建副本一致。正式树锁文件保持HEAD。

heavy已交probe_review，使用本次实际二进制重新执行R2完整TUI/请求内容/导航及真实截图；不沿用R1屏幕作为R2验收。完成后补齐本节并申请独立实现审计。

真实二进制TUI首次暴露构建环境配置问题：独立构建副本为detached HEAD，packages/script/src/index.ts默认channel读取git branch --show-current得到空串，build将其注入产物。worker写出channel=""的锁；server-lock.ts既有read拒绝空channel，launcher每次读不到owner，60秒失败。00-binary-startup-timeout.png与print-logs现场由TUI验收保留。产品源码及锁校验原样。

按仓库已支持的OPENCODE_CHANNEL=dev1-smark重新执行原完整build.ts --single，保持有效preview身份（InstallationLocal=false），环境配置不新增产品逻辑。重建exit0，WebUI/native及version/voice worker smoke全过。最终产物同路径、236239024字节，版本0.0.0-dev1-smark-202611181710，SHA256 c6b8b82c48f3047c1d627f48ae6201cc4dcaf2044ccdaa6654f732d78c34f0f0；full-build-channel.log与最终opentui-build.json为当前构建证据。旧空channel产物哈希仅作失败现场记录。heavy已重新交probe_review验证实际二进制。


### R2 最终完整应用与实现审计交接

有效channel的构建二进制已在真实Xfce终端启动，使用Sky直接截取6张屏幕。主stream-model请求1次、title-model请求1次，主请求2条消息和13个工具；用户文本与expected-user.txt逐字相同。首段挂起12.372秒期间命令菜单、会话列表和返回原会话均成功，最终SSE与expected-final.txt逐字相同，屏幕显示中文、emoji、列表及完整结束标记。Ctrl+C退出应用，脚本trap清理本地provider。报告 `/workspace/shared/daemon-perf-native-r2/REPORT.md`，原空channel失败与成功现场分别保留。

TUI证据Library `libfile_fcf25ba7a2f88191a8867af774b4258d` version0，归档SHA256 `087fd768f996a93ed9399ec106bf7f256612bf08e593a43b9c394b90fc7d85c0`，空目录回下载23项SHA通过。归档含屏幕、夹具、预期正文、请求摘要和时序；实际请求正文已本地逐字核对，auth锁token及运行数据库不入归档。

本轮终态检查：core合同10 pass/130断言；provider、header-timeout和processor关联回归172 pass/574断言；core和opencode完整类型检查均exit0（官方--singleThreaded）；完整build.ts --single在有效channel下exit0；完整闭包最终12轮性能及真实二进制TUI结果如上。正式四文件diff为109增、2删，git diff --check通过。E=92、C=15，排除空行、import-only和Plan；代表注释解释JSON省略补偿、UTF8孤立代理项、一次getter观察及真实EOF日志收尾。

正式修改路径仅为packages/core/src/util/token.ts、packages/core/test/util-token.test.ts、packages/opencode/src/provider/provider.ts、packages/opencode/test/provider/provider.test.ts及本Plan。实现保持批准的两个计量owner、SDK请求和错误/取消/EOF原路径；临时探针、采样和隔离候选仅在外部诊断副本。新增生产诊断分支0、备用成功路径0，淘汰workaround0。依赖闭包修正、构建私有PATH与channel配置均已记录，正式锁文件保持HEAD。

当前状态为implementation-audit-required，批准R2的设计范围保持；材料冻结并交独立实现审计。待该审计裁决后按GOAL推进verified及可选commit，当前尚未提交。用户实际长历史未提供，本轮性能使用125MiB构造历史及真实daemon链路；原始现场归因、各历史数据的依赖与采样边界保留。性能/完整TUI均已独立持久化，正式代码与Plan的最终自包含恢复包将在审计及提交阶段完成。


## 31. R2 独立实现审计原文

调用引用：主线程 /root 发起的 /root/adversarial_auditor；Audit mode: implementation；完整范围R2。以下原样记录裁决。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §30补记两份 `*-typecheck-audit-recheck.log`。本轮已核对其中的实际命令、包目录、起止时间及两项 `exit_code=0`。
- 最终性能报告使用完整依赖闭包的 `abba-final`：A/C发送中位数改善14.62%，B/C改善1.13%；早期数据继续作为历史记录保留。

## Rejected speculation

- 不要求增加调度让步、Worker、缓存、重试或探测期限。
- 不要求修改现有 SDK 序列化、请求内容、错误映射、取消及 EOF 行为。
- 构建空 channel 问题已用仓库既有构建参数修正，实际产品 diff 未扩展。
- 本轮性能结论对应125MiB构造历史；用户现场历史的具体归因仍按计划保留。

## Requirement and traceability coverage

本轮完整审计 **R2** 相对基线 `f04f9307957774ad5a21b4cfe70921a4fce20d5a` 的全部实际 hunk及直接行为路径。

- 四个代码与测试文件共 **109行新增、2行删除**，另有 canonical plan。实际 diff 与批准范围一致，锁文件及配置未改。
- Token只改变计量中间字符串，分类、媒体、getter/toJSON、boxed值及原生异常合同保持。
- Provider只替换字符串字节长度计算；原正文、Uint8Array及其他类型分支保持。
- 正式性能反馈完成 HEAD 红测与候选绿测。最终12轮中，完整候选六轮控制请求全部成功；A/C组原版两轮均红，候选两轮均绿。
- Core合同 **10 pass、130次断言**；Provider、header-timeout及processor关联回归 **172 pass、574次断言**。
- 两个变更包完整类型检查均退出0；资源参数仅限制编译并发。
- 完整构建包含 WebUI、native、版本及voice worker检查。构建副本的两个生产文件与正式源码一致。
- 已查看真实终端的会话导航和最终画面，并核对请求及SSE记录：输入逐字保持，挂起期间导航可用，最终回复完整。
- `git diff --check`通过；临时探针、采样和诊断副本均未进入正式 diff。

## Primary-path and fallback verdict

两个修改均落在已观测的成本产生处，分别消除计量整份JSON和日志UTF8缓冲的冗余构造。

实际发送、取消、错误及EOF继续沿原路径执行。新增备用成功路径0，新增生产诊断分支0；既有日志合同保持。没有需删除而仍残留的 workaround。

## Code quality and Chinese-comment verdict

独立复算结果：

| 范围 | E | C |
|---|---:|---:|
| 生产代码 | 7 | 3 |
| 测试代码 | 85 | 12 |
| 合计 | **92** | **15** |

C/E为 **16.30%**，最低要求14行，实际15行。排除空行和计划文档；没有新增 import、generated或纯移动行。

注释邻近修改点，解释JSON长度补偿、UTF8兼容、独立oracle、观察次数和EOF边界。没有新增 `any`、非空断言、类型压制或公共接口。

## Release verdict

**APPROVE**

批准 **R2当前实际实现 diff**。可原样记录裁决并转为 verified，再按计划执行提交前检查及提交；保持禁止 push。

### 非实质记录补正

类型检查原始记录为 `/workspace/shared/daemon-perf-implementation-evidence/r2/opencode-typecheck-audit-recheck.log` 与 `core-typecheck-audit-recheck.log`。两者分别在packages/opencode与packages/core运行 `GOMAXPROCS=1 /workspace/shared/pr5-ci-investigation/node_modules/@typescript/native-preview-linux-x64/lib/tsgo --noEmit --singleThreaded`，UTC 2026-11-18 17:16:15–17:17:26与17:17:26–17:17:46，两份记录均有exit_code=0。最终性能口径采用§30完整依赖闭包结果。R2状态转为verified；后续按本GOAL路径提交，禁止push。

## 32. R3 最新目标基线与隔离关键假设验证

R3重新查询远端 `dev1-smark`，得到 `ece062da81044966a3a66bc812d7b8db6da94b0d`。旧目标f04f9307之后有16f6ba3e6与ece062da8两个提交，共12文件变更；候选四个计量源/测试文件均未变。ece062da8在promptWindowProof逐消息之间加入八毫秒时间预算和让步，并改变审批证据读取的线程/只读连接，影响真实发送前的竞争背景。本轮保留这些上游行为，重新测量本候选；旧基线的14.62%收益保留为历史数据。

正式工作树仍保留已经审计的8bf7a9aec提交，R3只修改本计划。隔离worktree `/workspace/shared/daemon-perf-latest-check` 的HEAD为ece062da8，候选四文件补丁109增/2删经 `git apply --check` 和实际重放均成功。四文件逐字等于原已审候选，锁文件与目标HEAD一致。该实验副本是验证输入，不授予正式代码实施许可。证据 `baseline-and-source.json` 记录基线、候选SHA256与逐字相等结果。

### R3 设计与行为边界

§1的完整需求及§6–17的输入合同、两个owner、正反映射和垂直切片保持。R3从新HEAD仍只提出：在Token原JSON visitor内用空primitive string缩短计量中间结果并补回长度；在Provider原bodyBytes string分支用Buffer.byteLength避免诊断缓冲。SDK真正发送、getter/toJSON、boxed值、原生异常、媒体分类、取消和EOF均沿目标HEAD路径。最新上游的让步、审批Worker和会话查询优化作为基线保留，不纳入本候选修改或收益归因。

本轮预计文件和行数仍为四个代码/测试文件及本计划，109增/2删代码测试行；R2独立计数E92/C15可作为估算，实施审计重新核对。原测试对新HEAD已有语义继续作为回归，性能差异通过真实daemon反馈重新判别。计划批准前只运行隔离实验。

### 当前隔离验证记录

Bun版本1.4.4。`packages/core`运行 `bun test test/util-token.test.ts` 得10 pass、130断言。`packages/opencode`运行 `bun test --timeout 30000 test/provider/provider.test.ts test/provider/header-timeout.test.ts test/session/processor-effect.test.ts`，最终172 pass、574断言，94.27秒。日志在 `/workspace/shared/daemon-perf-latest-evidence`，core原始日志为 `/workspace/shared/daemon-perf-implementation-evidence/r2/latest-core-contract.log`。

依赖准备时曾把包内SDK目录错误链接到自身，导致首轮回退到根目录openai-compatible2.0.37，midstream重试用例失败。修正包内链接后实际解析2.0.41及provider3.0.8/provider-utils4.0.23，失败单例和完整关联回归均绿。该首轮不计作代码回归。另一次类型检查发现外部auth插件从原工作树解析Plugin类型，引入两个SDK类身份；将两个同版本auth包放到隔离node_modules下，复用本树Plugin身份，源码保持原样。所有失败日志保留，`sdk-resolution.jsonl`记录最终SDK闭包。

R3关键假设验证已完成，独立方案批准原文现记录于§33。后续正式实现、新基线构建及完整TUI验收按批准R3推进；R2已审提交作为旧基线恢复点保留。

### R3 完整包检查与最新基线ACCA

两个包分别在自己的包目录执行 `GOMAXPROCS=1 GOMEMLIMIT=1500MiB GOGC=20 bun typecheck --singleThreaded`，均exit0。opencode最终日志为 `opencode-typecheck-corrected.log`，core为 `core-typecheck.log`；`verification-summary.json`记录命令、工作目录、返回码和对应日志。资源参数仅控制类型检查进程并发和内存，检查范围保持整个包。

性能实验执行 `python3 /workspace/shared/daemon-perf-latest-evidence/abba/run.py`。脚本在最新基线隔离worktree内按ACCA顺序切换两个源文件，测试本身和依赖保持相同；A为ece062da8的原始源文件，C为本计划两个计量候选。2001条各65536字符的历史、真实daemon worker/HTTP、3次完整历史读取、两条控制路由3秒期限、全局SSE和本地模型沿原反馈夹具。每轮从干净临时数据库启动，结束走daemon退出和临时目录清理，不带CPU采样。记录源码哈希、发送结果、每次探测、标准错误和清理退出码。

| 顺序 | 变体 | 发送ms | health最大ms | endpoint最大ms | 超时请求数 | 测试退出码 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A | 9563.65 | 3001.09 | 3001.17 | 2 | 1 |
| 2 | C | 8235.06 | 2451.38 | 2494.72 | 0 | 0 |
| 3 | C | 6361.76 | 2716.10 | 2778.98 | 0 | 0 |
| 4 | A | 7746.93 | 3000.81 | 3000.95 | 2 | 1 |

A发送中位8655.29ms，C为7298.41ms，减少1356.88ms/15.68%。A的两轮均捕获原控制面超时症状，C的两轮均通过原判别。四轮POST200、模型各收到一次请求、完整回复存在、SSE未结束；全部daemon清理exit0且stderr为空。A测试退出1对应控制请求成功断言失败。原始结果在 `abba/results.json` 与逐轮 `.log/.stderr.log`，汇总在 `abba/summary.json`。这组数据对应新基线及本次相同构造历史，旧基线数据保持原口径。

实验finally恢复C两个源文件并删除临时 `diagnostic-latest.test.ts`。隔离worktree最终只剩四个批准候选文件的109增/2删，`git diff --check`通过，正式树只有本Plan变化。新HEAD已经包含proof让步及审批线程；本候选仍在独立计量点减少冗余输出构造，原超时红信号和候选绿信号说明这两个成本点仍有修复价值。R3不把上游优化计入本候选diff或新增设计。

### R3 后续门禁与交接

独立方案审计以§1完整原文、最新HEAD ece062da8、§6–21设计合同及本节全部新增证据为范围。批准后在最新基线建立正式候选，复用原红绿反馈与四文件合同，执行完整包检查、包含最新证据Worker入口的完整构建，并用该构建启动真实TUI验证请求、回复、导航和屏幕。之后进行完整实现审计，按本GOAL创建新提交并持久化可空目录重放的恢复包。正式代码、构建和提交均不得以旧R2审批越过R3门禁；当前禁止push和amend。

## 33. R3 独立方案审计原文

调用引用：`/root/daemon_diff/adversarial_auditor`；Audit mode: plan；完整范围R3。以下原样记录裁决。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §20仍列旧基线性能数字。加上对应实验标签，并指向§32的R3结果，便于区分各轮数据。
- 本轮夹具沿用 `evidence/diagnostic-abba.test.ts`，已核对真实daemon启动、HTTP发送、3秒控制请求断言和清理路径。将该夹具及哈希随R3原始日志保存，补全可重放材料。

## Rejected speculation

- 不要求新增Worker、缓存、调度让步、备用估算器或扩大探测期限。
- 不把三个提交与症状的时间关系作为归因。计量路径的历史提交及旧版本红信号支持继续修复这两个成本点。
- 不要求修改SDK序列化、模型正文、取消、错误及EOF行为。

## Requirement and traceability coverage

本轮完整审计 **R3**，基线为 `ece062da81044966a3a66bc812d7b8db6da94b0d`。

已独立读取适用规则、policy、领域文档、ADR、源码及直接调用者，并核对候选差异、实验脚本、源码快照和原始运行记录。

- 原始需求完整保留；历史追踪、发送阻塞、请求语义和最终TUI验证均有对应路径。
- Token修改位于实际请求准备和窗口估算共用的计量owner；分类完成后缩短中间字符串，再补回精确长度。
- Provider修改位于普通SDK和gateway共用的日志计量owner；字符串改用无输出缓冲的UTF8长度计算。
- 两个实验源文件的A快照逐字对应当前HEAD，C快照逐字对应四文件候选中的生产源码。
- 最新ACCA原始记录中，A两轮均有两条控制请求超时，C两轮均通过；发送中位数由8655.29毫秒降至7298.41毫秒，下降15.68%。
- 四轮均POST 200、模型请求一次、回复存在、SSE保持打开；daemon清理退出码均为0。
- 合同回归记录为Core 10 pass、130次断言，以及Provider、header-timeout、processor合计172 pass、574次断言。
- 正反映射覆盖两个新增生产概念；四文件范围、公开测试边界、完整构建、真实TUI和后续实现审计门禁明确。
- §17承诺实际中文解释注释达到 `C >= max(1, ceil(E × 0.15))`，预算可执行。

## Primary-path and fallback verdict

两个修改直接减少计量owner产生的冗余输出，保留原JSON遍历、媒体分类、getter/toJSON、boxed值、异常和SDK发送路径。

新增备用成功路径0，新增生产诊断分支0。最新基线中的proof让步及审批线程行为保持原样。临时夹具和采样代码排除在产品diff外。

## Release verdict

**APPROVE**

仅批准 **R3方案**，以 `ece062da81044966a3a66bc812d7b8db6da94b0d` 为基线。可原样记录裁决并设置：

- `Status: approved`
- `Approved revision: R3`
- `Implementation allowed: yes`

按R3继续正式实施、最新基线完整构建、真实TUI验收和独立实现审计。

### 非实质记录补正

§20旧数字对应R2规划时的无CPU采样组，当前最新基线采用§32的R3 ACCA。正式夹具已逐字保存到 `/workspace/shared/daemon-perf-latest-evidence/abba/diagnostic-latest.test.ts`，SHA256 `8ed97f2d8f41400f5ee6f2eff713b4c9b26dad09f6df2b94d41aa83867cafcfc`，与原输入文件相同。

## 34. R3 批准后实施与验证记录

本轮按§33批准范围在最新基线worktree `/workspace/shared/daemon-perf-latest-check` 继续实施，四文件保持批准的109增/2删，目标HEAD再次查询仍为ece062da8。独立构建树 `/workspace/shared/daemon-perf-build-r3` 使用相同HEAD及四文件逐字相同补丁，依赖复制为私有目录，构建安装不会修改共享依赖。完整构建和真实TUI按重负载队列继续执行。

批准后的最窄检查：在packages/core运行 `bun test test/util-token.test.ts`，10 pass/130断言；在packages/opencode运行 `bun test test/provider/provider.test.ts -t 'provider request byte accounting preserves UTF8 content and stream completion'`，1 pass/4断言。日志和命令元数据位于 `/workspace/shared/daemon-perf-r3-implementation`。

正式红绿命令 `python3 /workspace/shared/daemon-perf-r3-implementation/red-green.py`，内部在packages/opencode运行既有真实daemon反馈。先恢复目标HEAD的两个计量源文件，原控制面断言失败；再应用批准的两个源文件，原断言通过。原测试、期限、2001条历史与HTTP/SSE/worker路径保持，临时夹具在finally删除并恢复批准候选。

| 变体 | 测试退出 | 发送ms | health最大ms | endpoint最大ms | 超时数 |
|---|---:|---:|---:|---:|---:|
| 目标HEAD A |1|6247.22|3000.70|3000.77|2|
| 批准候选 C |0|7277.93|2919.72|2965.55|0|

两轮均POST200、模型请求一次、完整回复存在、SSE保持打开；daemon显式退出0、stderr空。此对证明原offline判别的红绿，单对发送耗时C较A慢1030.70ms；发送收益统计继续保留§32的完整ACCA结果，全部原始样本均保留。控制面最慢2965.55ms同样如实记录，未改变3秒期限。

独立静态核对代理 `/root/cancellation_paths` 复算四文件E92/C15；若把两条删除行额外算入则E94/C15，两种计数均过门槛。具体source/consumer和逐文件数字见 `STATIC-REVIEW.md`，完整实现审计待全构建与真实TUI完成后执行。

批准后关联回归完成：packages/opencode执行 `bun test --timeout 30000 test/provider/provider.test.ts test/provider/header-timeout.test.ts test/session/processor-effect.test.ts`，172 pass/574断言，84.22秒。两个包各在本包目录执行 `GOMAXPROCS=1 GOMEMLIMIT=1500MiB GOGC=20 bun typecheck --singleThreaded`，core和opencode均exit0。完整命令脚本 `regression.sh`、原日志和 `exit-codes.txt` 保存在R3实施证据目录。资源已明确交PR5构建，随后执行本轮构建与原生TUI。

### R3 完整构建与真实二进制验收

独立构建树执行原 `bun install --frozen-lockfile`，2902 installs/2727 packages无变化检查成功，postinstall和husky均执行。随后packages/opencode执行原 `OPENCODE_CHANNEL=dev1-smark bun run script/build.ts --single`，包含WebUI、三个native安装、实际本机编译、版本和voice worker smoke，全部exit0。完整命令为R3实施证据目录的build.sh，未跳过步骤。构建自己的bun.lock经native安装产生的改写单独保存build-lock-rewrite.diff，正式四文件树锁文件保持HEAD。

最终二进制版本0.0.0-dev1-smark-202611182057，236247216 bytes，SHA256 `86bcc4ed09630faa5475acf12cc515a0030d8167582b17c4a98f2acedef3141d`；opentui-build.json记录native0.4.3-smark.13与libopentui.so SHA ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d。构建四个源/测试文件与正式候选逐字一致，最新上游证据Worker入口沿原build.ts编译。

真实Xfce终端运行本轮完整二进制，六张Sky直接截图在 `/workspace/shared/daemon-perf-native-r3`。主模型和标题模型各一次请求，主请求2条消息/13工具；用户引号、反斜杠文本逐字相同。首段20:59:35.400至门释放21:00:16.023，40.623秒挂起期间命令菜单、会话导航和返回正常；21:00:16.026完整回复结束，SSE逐字等于expected-final.txt，屏幕显示中文、emoji、列表和END R3 ACCEPTANCE。应用exit0、daemon stop清理exit0、后台停止。REPORT.md、输入/回复、事件摘要及六张原生截图归档 `daemon-perf-native-r3-evidence.tar.gz`，SHA256 0055024c14d14ee178c066bc90b826fc8bc5d4cef8e76db8f01a75e9699e8b50。

R3实际修改范围四个代码/测试文件109增/2删，以及本Plan。E92/C15，排除2空行与计划文档；生产E7/C3，测试E85/C12，16.30%达到14行门槛。注释解释JSON省略补偿、UTF8孤立代理项、原生oracle、一次观察和EOF日志收尾。新增生产诊断0、备用成功路径0、淘汰workaround0。临时反馈测试已删除，`git diff --check`通过。完整实现材料现冻结并提交独立实现审计；当前禁止push/amend，持久恢复包在审计和提交后按空目录重放验证。

## 35. R3 独立实现审计原文

调用引用：根线程 /root 独立派发并转交裁决；Audit mode: implementation；完整范围R3。以下逐字记录。

## Blocking findings

No blocking findings.

## Non-blocking findings

性能报告继续分别保留两组口径：R3 ACCA 的发送中位数下降 15.68%；批准后单对红绿实验中，候选发送慢 1,030.70 毫秒，同时消除了该轮两条控制请求超时。§34 已如实记录，两组结果均应随最终归档保存。

## Rejected speculation

- 不要求新增 Worker、缓存、调度机制或备用估算器。
- 不扩大三秒探测期限，不改变 SDK 正文序列化、模型输入、取消和 EOF 合同。
- 不把三个历史提交与症状的时间关系直接作为退化归因。

## Requirement and traceability coverage

本轮审计覆盖批准的 **R3**、完整原始需求及全部四文件实际 diff，基线为 `ece062da81044966a3a66bc812d7b8db6da94b0d`。

独立核对结果：

- 当前 `git diff` 与提交审计的 `actual.diff` 逐字一致，共 **109 行增加、2 行删除**，`git diff --check` 通过。
- 四文件哈希与实施清单、最终构建树逐一相同。红测的两个源码快照逐字对应目标 HEAD。
- Token 在原 JSON visitor 完成分类后缩短计量中间字符串，再补回精确长度；原请求、分类、媒体计量、getter/toJSON、boxed 值及原生异常路径保持。
- Provider 在原字符串分支计算 UTF-8 长度，保留 Uint8Array 和其他 body 的既有处理；实际发送仍消费原请求正文。
- 修改归属真实请求准备及传输日志的两个计量 owner，直接消费者保持原接口。

已核对原始验证记录：

| 验证 | 结果 |
|---|---:|
| Core 合同测试 | 10 pass，130 次断言 |
| Provider 定向测试 | 1 pass，4 次断言 |
| Provider、header-timeout、processor 回归 | 172 pass，574 次断言 |
| 两包完整类型检查 | 全部 exit 0 |
| 完整产品构建、版本及 voice worker smoke | 通过 |

真实 daemon 反馈保持 2,001 条历史、HTTP、worker、SSE 和三秒控制请求期限：

- R3 ACCA：目标 HEAD 两轮均出现两条控制请求超时，候选两轮均通过；发送中位数由 8,655.29 毫秒降至 7,298.41 毫秒。
- 批准后红绿：目标 HEAD 测试 exit 1，候选 exit 0；候选最慢控制请求为 2,965.55 毫秒。
- 各轮均 POST 200、模型请求一次、完整回复存在，daemon 清理 exit 0。

已直接查看真实终端的会话导航及完整回复截图，并核对事件记录：流式首段挂起 40.623 秒期间能打开导航并返回，最终正文保留中文、emoji、引号和反斜杠。应用与 daemon 清理均 exit 0。

最终二进制 SHA256 为 `86bcc4ed09630faa5475acf12cc515a0030d8167582b17c4a98f2acedef3141d`。构建树仅增加原构建过程产生的锁文件重排，其唯一包版本、元数据和完整性集合与正式树一致。

## Primary-path and fallback verdict

两处修改直接减少计量产生的冗余输出，保持原计量、发送及失败传播路径。

新增备用成功路径 **0**，新增生产诊断分支 **0**。临时 daemon 夹具已从实际产品 diff 中移除。

## Code quality and Chinese-comment verdict

独立逐行统计：

| 范围 | E | C |
|---|---:|---:|
| 生产代码 | 7 | 3 |
| 测试代码 | 85 | 12 |
| 合计 | **92** | **15** |

排除 2 行空行及计划文档。中文解释比例 **16.30%**，超过最低 14 行要求。

注释邻近 JSON 长度补偿、UTF-8 语义、独立 oracle、一次观察及 EOF 收尾验证。实际 diff 未增加公共接口、依赖、类型抑制或无关重构。

## Release verdict

**APPROVE**

批准 **R3** 对应的本次完整四文件实现 diff。可原样记录裁决并设置 `Status: verified`，随后按批准流程创建新提交，完成持久化归档与空目录重放交付。

### Canonical 路径迁移记录

R3审计通过后，唯一活动Plan迁入最新目标实现树 docs/plans/daemon-request-accounting-performance.md；旧R2树保留既有提交中的历史版本。设计、裁决与证据正文保持。R3最新实现树为正式提交树，后续只在该树维护本Plan。


## 36. R4 发布授权与最新基线对齐

### 用户最新原文

Sentinel_0bb14ee74ed88191bb56def8a7acb427：

> Workflow 里面也没有要求你不准朴实啊，允许朴实啊

Sentinel_124c73f22c38819185fde1539f28b7a2：

> 完成方案，只要你审计了就可以去实施，然后实施完审计完就可以去进行铺市

结合本轮明确询问的推送上下文，上述授权允许完成方案及实现审计后推送本性能修复独立分支并创建PR；§1原文的新PR要求继续适用。先前revision的禁止push限制作为历史记录保留，当前发布流程使用本节授权；不推目标分支、不合并、不amend、不跳hook。

### 实时上游变化

发布前git ls-remote和GitHub compare共同确认dev1-smark为e93b66fd8473e94fb414151af0fecbb31a299266，比R3基线ece062da8多一个提交。该提交只改git-safety.txt、system-context/builtins.ts及对应builtins.test.ts/tool-bash.test.ts，共26增/6删；生产变化都是共享提示文本。四个计量修复文件、计量接口、调用者执行顺序、原生构建路径、锁文件和workflow policy均未改。新增系统正文经同一公共Token估算器及Provider日志owner，属于既有字符串输入域。

R4保留最新上游全部文字和测试，§6–17的invariant、责任边界、正反映射、四文件设计与E/C门禁保持。新的基线不引出缓存、Worker、调度或附加分支。正式R3提交保持原样；隔离worktree `/workspace/shared/daemon-perf-r4-probe` 从e93b66fd建立并重放四文件补丁，供最新基线关键假设验证。

### R4 验收与发布门禁

方案批准前验证最新系统指引合同与Token合同、真实daemon同一长历史控制面红绿，记录全部样本。批准后在新HEAD对齐正式候选，保留新目标文本；执行关联回归、两包完整typecheck、原完整构建和二进制真实TUI，再做完整实现审计。通过后创建单提交（真实pre-commit），运行真实pre-push并推送独立分支；复查远端head及base后创建目标为dev1-smark的PR。四个计量文件产品diff保持109增/2删，Plan另计；若基线再次改变则按实际受影响路径重新评估。

### R4 当前关键假设验证

新基线隔离树packages/core执行 `bun test test/util-token.test.ts test/system-context/builtins.test.ts`，20 pass/231断言，2.55秒。四文件与R3逐字一致；实际Token导入指向R4 probe，openai-compatible解析仍为2.0.41，复用R3完整外部依赖。

首次独占AC反馈中A发送7941.71ms、两条控制请求约3001ms超时，命中原红信号；C完成会话创建、SSE及三次完整历史读取断言后，在POST进入模型前整例90秒超时，模型请求计数0，最后控制请求计时约72.49秒。stderr为空。原始数据保存在 `/workspace/shared/daemon-perf-r4-evidence`，本失败保留，不调整期限或筛除样本。该时点异常尚待阶段诊断，方案当时保持draft；后续阶段记录及独占确认见下文，当前审批见§37。

阶段诊断在下一独占窗口运行 `python3 /workspace/shared/daemon-perf-r4-evidence/stages/run.py`，仅给临时夹具加入history/send/model headers/body时间标记和外部每秒CPU/RSS采样，原3秒/90秒期限及全部断言保持。顺序CA：候选C总发送5301.14ms、send到model headers3784ms、模型正文读取964ms、控制峰值1536.73ms，全部成功；目标A总9631.14ms、前段8232ms、正文读取576ms，4条控制请求超时。两轮模型各请求一次、完整回复、SSE保持，daemon清理exit0；临时测试已删并恢复四文件候选。

40次外部采样最大间隔1.087秒；本轮可见进程只有测试与daemon，候选daemon峰值RSS1102768KiB，A峰值1583692KiB。该采样仅描述本轮环境，不回填首轮未采集的资源状态。首轮异常C的执行时段由日志mtime及runner实测duration得到22:32:25.828–22:33:59.251 UTC，其72秒停顿的具体原因继续保留待核。新阶段证据再次捕获原红信号、候选正常发送和控制面绿信号，四文件设计与R3保持。后续批准实施的无阶段采样反馈需再次验证，并与全部历史样本一起呈现。

资源记录补充：`cancellation_paths`只读核对Execute的r3-typecheck-first.log，创建22:32:31.459701301 UTC、最后写入22:33:59.234926130 UTC，末尾为tsgo SIGKILL。它与失败C的22:32:25.828–22:33:59.251时段重叠约88秒。由此确认首轮C未满足独占条件；时间重叠本身不确定72秒停顿的完整因果。失败仍保留在全样本记录，另用明确独占、无探针ACCA验证关键假设，不筛选成功结果。

### R4 独占无探针ACCA确认

在PR5完整验收结束并明确释放后，执行 `/workspace/shared/daemon-perf-r4-evidence/confirmation/run.py`，全部流程保持原始夹具，未加入阶段采样。结束后明确交Execute检查，四轮期间未安排其他重负载。

| 顺序 | 变体 | 发送ms | health最大ms | endpoint最大ms | 超时数 | 测试退出 |
|---|---|---:|---:|---:|---:|---:|
|1|A|7424.40|3002.59|3002.59|2|1|
|2|C|5337.58|2035.19|2101.50|0|0|
|3|C|6478.26|2464.88|2525.94|0|0|
|4|A|6785.16|3000.58|3000.74|2|1|

A发送中位7104.78ms，C5907.92ms，减少1196.86ms/16.85%。四轮POST200、模型各一次、回复完整、SSE保持、daemon清理exit0，stderr为空。临时测试已删，候选四文件逐字恢复。前面的并发重叠异常组和阶段诊断组继续独立保留，不混入本组统计。新HEAD的系统文本变化经过当前核心合同和真实发送反馈验证；本轮关键假设满足，完整R4方案送独立审计，批准后继续最新基线正式实施与终态验收。

## 37. R4 独立方案审计原文

调用引用：`/root/daemon_diff/adversarial_auditor`；Audit mode: plan；完整范围R4。

## Blocking findings

No blocking findings.

## Non-blocking findings

- §10仍将R3称作当前候选，§36首轮记录仍写“本轮方案保持draft”。补上历史阶段标签，并将当前基线统一指向R4的 `e93b66fd8473e94fb414151af0fecbb31a299266`。
- 首轮C的90秒超时继续保留为异常样本。当前独占ACCA已有完整红绿证据；发布材料分别列出两组条件和结果。

## Rejected speculation

- 上游新增系统文本属于现有字符串输入域，不要求增加计量分支或兼容层。
- 首轮异常没有形成指向本候选逻辑的因果证据，不据此增加Worker、重试、缓存或延长期限。
- 不要求修改SDK发送、取消、错误、EOF或控制面探测策略。

## Requirement and traceability coverage

本轮完整审计 **R4方案**，基线为 `e93b66fd8473e94fb414151af0fecbb31a299266`。

已核对完整需求、发布步骤、当前源码、全部候选hunk、直接调用路径、适用规则、实验夹具和原始日志。

- 上游较R3新增四文件26增/6删，生产变化为共享提示文本；计量接口、调用顺序及依赖锁保持。
- 候选仍为四文件109增/2删，两个生产修改分别位于Token计量和Provider日志计量的成本产生处。
- Token保留分类、媒体、观察次数、原生异常及请求内容；Provider保留实际UTF8字节长度和其他body分支。
- 独占ACCA的A快照逐字对应当前HEAD，C快照逐字对应候选源码，每轮记录哈希一致；夹具与此前原始反馈逐字一致。
- A两轮均出现两条控制请求超时，C两轮均通过；发送中位数由7104.78毫秒降至5907.92毫秒，下降16.85%。
- 四轮均POST 200、模型请求一次、回复存在、SSE保持，daemon清理退出码0、stderr为空。
- 当前Token及系统指引合同记录为20 pass、231次断言。
- 正反映射、四文件边界、中文注释最低比例、完整包检查、构建、真实TUI和独立实现审计均有明确门禁。
- 发布流程包含真实hook、独立分支推送、远端head/base复查及目标为dev1-smark的PR。

## Primary-path and fallback verdict

两个修改沿既有计量路径减少冗余字符串和UTF8输出缓冲，实际请求继续由原SDK序列化并发送。

新增备用成功路径0，新增生产诊断分支0。临时采样与反馈夹具排除在产品diff外；最新上游文本完整保留。

## Release verdict

**APPROVE**

仅批准 **R4方案**。可原样记录裁决并设置：

- `Status: approved`
- `Approved revision: R4`
- `Implementation allowed: yes`

按R4完成正式实施、最新基线验证和独立实现审计，再执行计划中的提交与发布步骤。

### R4 活动Plan迁移

R4批准后，唯一活动Plan迁入 `/workspace/shared/daemon-perf-build-r4/docs/plans/daemon-request-accounting-performance.md`；该树HEAD为e93b66fd，四文件与批准probe逐字相同，使用独立私有依赖完成正式实施、完整构建、提交与发布。latest-check恢复R3已提交的历史Plan。

## 38. R4 正式实施与完整应用证据

正式实施目录为 `/workspace/shared/daemon-perf-build-r4`，HEAD为e93b66fd8473e94fb414151af0fecbb31a299266。批准四文件保持109增/2删，与R3候选逐字相同。实际差分与哈希保存于 `/workspace/shared/daemon-perf-r4-implementation/actual.diff` 和 `implementation-sha256.txt`。独立依赖及完整构建均位于该树；原构建改写的bun.lock已保存为build-lock-rewrite.diff，恢复HEAD锁文件后产品diff只含批准四文件。Plan单独计入提交。

### 正式红绿及回归

执行 `python3 /workspace/shared/daemon-perf-r4-implementation/red-green.py`，工作目录packages/opencode。先运行当前HEAD源文件，再恢复批准候选，2001条长历史、真实HTTP/worker/SSE、本地模型及3秒探测期限保持：

| 变体 | 发送ms | 控制峰值ms | 超时数 | 测试退出 |
|---|---:|---:|---:|---:|
|HEAD A|10057.85|3001.47|2|1|
|候选 C|6526.50|2335.67|0|0|

两轮POST200、模型请求各一次、完整回复存在、SSE保持，daemon清理exit0。临时诊断测试在finally移除，候选恢复后哈希一致。此组与§36无探针ACCA、首轮异常及阶段采样分别保留，不混算。

运行 `OPENCODE_DISABLE_MODELS_FETCH=1 /workspace/shared/daemon-perf-r4-implementation/regression.sh`。脚本分别从packages/core、packages/opencode运行以下完整命令：

- `bun test test/util-token.test.ts test/system-context/builtins.test.ts`：20 pass，231断言。
- `bun test --timeout 30000 test/provider/provider.test.ts test/provider/header-timeout.test.ts test/session/processor-effect.test.ts`：172 pass，574断言。
- 两包各自 `GOMAXPROCS=1 GOMEMLIMIT=1500MiB GOGC=20 bun typecheck --singleThreaded`：均exit0，全包tsconfig范围保持。

首次回归因后台models目录GET触发执行器中止。原日志保存在interrupted-online；使用仓库现有禁用模型目录刷新开关重跑，测试范围、数据与断言保持，上述结果为完整重跑。core-contract日志的两次exit0均保留。

### 完整构建与真实终端

运行 `/workspace/shared/daemon-perf-r4-implementation/build.sh`，先根目录原 `bun install --frozen-lockfile`，再packages/opencode原 `OPENCODE_CHANNEL=dev1-smark bun run script/build.ts --single`。WebUI构建与嵌入、三个native安装、CLI编译、版本及voice worker smoke均通过，build.exit为0。首次构建等待被工具中断，保留full-build-interrupted.log；完整重跑成功的full-build.log为最终证据。

最终二进制版本0.0.0-dev1-smark-202611182312，236279984字节，SHA256 `cf651e8e4bd25c1bd16df4b65564bed3a1df528e7cb379a0fe661b1e3e574fa0`。OpenTUI 0.4.3-smark.13，libopentui.so哈希ab485d6a31b3ace0f35ec221f9f2d4d78cd558200361a18fa4fabc299fdebe0d。

在真实Xfce终端运行 `/workspace/shared/daemon-perf-native-r4/start-session.sh`，使用上述完整二进制、独立配置和本地模型。模型收到正文与expected-user逐字相同；流式首段挂起31.629秒期间打开命令面板、进入会话导航并返回；释放后完整回复保留中文、emoji、引号、反斜杠及结束标记。六张真实桌面截图、流式事件、报告和退出记录保存在 `/workspace/shared/daemon-perf-native-r4`，清理后归档为 `/workspace/shared/daemon-perf-native-r4-evidence.tar.gz`。应用退出0，daemon stop清理0。

### 修改映射与注释

Token生产修改归属原JSON visitor计量，测试覆盖既有公共估算器的精确结果及观察语义。Provider生产修改归属日志bodyBytes，公开SDK测试覆盖实际发送正文、UTF8长度和EOF。直接调用者仍消费原接口；新备用成功路径0，新生产诊断分支0，临时夹具不进入产品差分。

四文件E92/C15，生产E7/C3，测试E85/C12，排除2空行及Plan；比例16.30%，最低14。邻近中文解释分别说明JSON精确长度补偿、UTF8长度、独立oracle、一次观察与EOF收尾。完整原始样本均保留；首轮并发重叠异常及构建/回归中断如上单列。当前实现与证据冻结，送R4独立完整实现审计，审计通过后执行真实提交hook及发布门禁。

## 39. R4 独立实现审计原文

调用引用：`/root/daemon_diff/adversarial_auditor`；Audit mode: implementation；完整范围R4。

## Blocking findings

No blocking findings.

## Non-blocking findings

- Plan开头“当前生产代码仍为已审R3”更新为“当前R4实现与批准候选逐字一致”。§38已准确记录正式实施状态。

## Rejected speculation

- 不要求增加Worker、缓存、重试、备用计量器或延长探测期限。
- 首轮并发重叠异常继续按原条件保留，不据此扩展产品修改。
- 不要求调整原SDK序列化、取消、错误或EOF路径。

## Requirement and traceability coverage

本轮完整审计 **R4实际实现**，基线为 `e93b66fd8473e94fb414151af0fecbb31a299266`。

- 实际产品diff与送审 `actual.diff` 逐字一致，四文件109增/2删；四文件也与批准候选逐字一致。
- Token修改保留分类、媒体、getter/toJSON、boxed值、异常和输入对象；Provider修改保留实际UTF8长度、原正文及其他body分支。
- 正式红绿记录中，HEAD发送10057.85毫秒、两条控制请求超时；候选发送6526.50毫秒、控制峰值2335.67毫秒、全部通过。
- 两轮模型各收到一次请求，返回成功回复，SSE保持打开，daemon清理退出码均为0；运行源码哈希与保存快照一致。
- Core及系统指引合同 **20 pass、231次断言**；Provider、header-timeout和processor关联回归 **172 pass、574次断言**。
- 两包完整类型检查均退出0。命令在各自包目录执行，保留全包检查范围。
- 原完整构建通过WebUI、native、CLI编译、版本及voice worker检查。实际二进制SHA256为 `cf651e8e4bd25c1bd16df4b65564bed3a1df528e7cb379a0fe661b1e3e574fa0`，与验收记录一致。
- 已查看真实终端会话导航和最终画面，核对请求正文、流式事件及退出记录：正文逐字保持，挂起期间导航可用，回复完整，应用与清理均退出0。
- `git diff --check`通过；锁文件保持HEAD，临时夹具及采样代码均未进入产品diff。

## Primary-path and fallback verdict

两个修改直接消除计量owner中的冗余输出构造，实际发送继续沿既有SDK路径。

新增备用成功路径0，新增生产诊断分支0。没有遗漏的淘汰workaround；最新上游系统文本保持原样。

## Code quality and Chinese-comment verdict

独立逐行复算：

| 范围 | E | C |
|---|---:|---:|
| 生产代码 | 7 | 3 |
| 测试代码 | 85 | 12 |
| 合计 | **92** | **15** |

排除2行空行及Plan。中文解释比例 **16.30%**，达到最低14行要求。

注释邻近长度补偿、UTF8语义、独立oracle、一次观察及EOF验证。实际diff未增加公共接口、依赖、类型抑制或无关重构。

## Release verdict

**APPROVE**

批准 **R4当前完整实际实现diff**。可原样记录裁决并设置 `Status: verified`，随后按§36执行真实提交hook、独立分支推送、远端复查和PR发布门禁。
