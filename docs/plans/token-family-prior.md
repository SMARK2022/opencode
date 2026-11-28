# 请求输入估算：密文分量与同族首轮校准

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: full-scope
>
> Requirement source: 本会话下列用户原话与其确认的伪代码
>
> Implementation allowed: completed
>
> Target: verified-implementation-and-commit；基线 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`；2026-11-28

## 1. 原始需求

> 没有问题，按照这套逻辑去检查一下我们Document里面有个Guide里面有个Workflow逻辑，然后按照Workflow dot Markdown里面的Verified implementation and commit的逻辑。进行精准的plan等等的构建。我已经说过了，我的要求和需求就这么一点，更改现有的估算逻辑，其他都不要动，任何东西都不要动。你不要为了这些东西去改各种的入口啊，各种各样的一些节点。我已经说的很清晰了。按照你的这套逻辑和我的理解，同族模型你也不要需不需要写的很精准。按理来讲，同族模型大概率就是模型ID的就是横杠前面那个东西，就比如说Kimi横杠K3.1横杠Pro，那这种Kimi就是他的这个前面的这个模型家族，像是GPT也是一样，就比如说GPT六点几，巴拉巴拉这种东西。然后同时，按理来说你只需要去修改一下既有的测试即可，最多你新增两个测试，其他都不要去动，不要去过度实现。请注意这一点。按照我看你的实现，生产代码的修改行数不得超过120行，测试代码的修改行数不得超过120行。

> 就是就是目标模型有效确认就是自身校准，真首轮就是拿这个东西。然后如果不是真首轮，就是如果是有这个同族模型，那就拿同族模型东西，那其他的就按照4跟16，你不要说再算一个这个倍率再乘，因为你倍率的话就会导这个问题，你明文跟密文的比例，它们之间是完全卡死了1:4，这就导致存在这个表示的宽松性和灵活性的一个退化。

> 我已经说了，既然之前的Reasoning计算逻辑是有问题的，那就做精准替换。不要说你保留两套东西，然后又说一会要保留，一会说怎么什么的。我已经说的很清晰了，这套逻辑整体替换成你估算的逻辑，替换成你所说的这套逻辑就OK。同时不要引起退化，比如说不要说引起什么把什么历史又全量读了呀，怎么怎么样，然后又导致这个DAEMON负载过大，怎么怎么样。现在怎么读的，你就用怎么读。按理来说只需要调整算法就OK。

最新范围原话：
> 在算法层上做修改，不要去试图更改Schema等等一些东西，或者说极力要避免去修改这些东西。更避免去以meta data这种形式去加一些这种逻辑，这种逻辑很脏，很不干净。
> 同时你要跑对应的HTTP API测试。
> 新增行的行平均长度不得超过旧的行的行平均长度的1.2倍。
> 或者1.1倍不要让一些函数过分地去把整个历史啊什么都读进去，只读必要的东西，尽量减少性能负担。最终commit之后，你可以push一次，push之后它会触发pre push去给你汇报对应的性能基准测试。必须使得最终的性能基准测试通过
> 算了，我允许你进行必要的修改，但我希望你适当收敛一下。我觉得当前比如说像是读取了History，我觉得History这种输入是不是都可以被移除掉，或者说都可以被规避掉。就是我觉得你不应该引入不必要的，或者说不是完全必要的这种类型的逻辑修改，因为你当前这样修改会造成一些接口的一些破坏呀，这种无关的一些改动。当然你可以超过6个文件，但是你不应该，你应该在现有基础上，我觉得你应该适当收敛一点。
> 算了，我想了一下，我允许你说增加这个密文字段。但是就是其他你看一下吧。我觉得你这个呃这个token计数的这个breakdown去增加一个这个加，呃，这个密文字符，我觉得我我就是去记录这个密文的这个token量，我觉得也是允许的。请注意这点，这个我是允许的。但是其他的我不建议你说去过分的进行什么for each啊什么这各种这种拆分，就是反正尽量你避免去对性能造成影响，同时实现尽可能避免去增加不必要的一些接口逻辑。
> 换言之，我可以这样要求你，你现在新实现的东西不得比旧实现的东西多。
> 也就是你新实现的东西，相对于暂存区的内容逻辑，只能减少不能增加。

## 2–4. 范围、约束、证据

用户限定：「我们的对话记录就是你上一次所给的伪代码，就这么一点东西，伪代码之外的所有内容都不要去实现，都不要去写，都不要去做。」以最新纠正后的四种来源为准：目标模型、真首轮、同族模型、普通先验。用户本次完整交付的 Workflow 指定：「用户明确更新需求时，将原文与来源同步到 plan；若方案实质性改变则以更新后的完整需求新建审计任务，延续已有轮次记录。」据此重新交接直接复用密度合同；后续同合同复议复用该 Task。

只改请求估算及其现有历史读取。`docs/guides/workflow.md`、工程 policy、canonical 模板、根/包 AGENTS、CONTEXT 的 Session History / Native Continuation Metadata 定义适用；ADR 索引无本域决策。无 UI、路由、compaction 策略、模型配置、后台服务、数据库迁移或新调用入口。

| 证据（当前仓库） | 结论 |
|---|---|
| `core/src/util/token.ts`、`core/test/util-token.test.ts` | observed：同一 JSON visitor 按 reasoning 父节点累计结构、摘要和密文；最终整桶除以 reasoning 密度。已有按同模型最多 20 点的学习器。 |
| `opencode/src/session/llm.ts:380`、`provider/transform.ts:258`、`llm/src/protocols/openai-responses.ts:285`、`openai-chat.ts:261` | observed：SDK 的 reasoning part 带 `providerOptions.openai.reasoningEncryptedContent`，Responses reasoning item 带 `encrypted_content`；摘要和 Chat `reasoning_content` 可读。同名工具参数是业务数据。 |
| `schema/src/session-message.ts:175`、`schema/src/v1/session.ts`、`tui/src/util/token-accounting.ts` | contracted：V1/V2 已共享 breakdown，六个消息子项之和为 total。用户允许独立密文字符字段，reasoning原显示桶保持原义。 |
| `opencode/src/token/estimate.ts`、`session/message-v2.ts:1370`、`session/processor.ts:1233`、`session/prompt.ts:1647`、`core/src/session/runner/llm.ts:430` | observed：取样先按精确 ID 过滤；DB 精确样本按时间排序，V1 回放窗口可能重排，daemon 已有热 carrier/冷 finish 事务。其余消费者调用同一个 Core。 |
| `opencode/test/{token/estimate,session/messages-pagination}.test.ts`、`tui/test/util/token-estimate.test.ts` | contracted：可见性、同 Session/provider、完整 cache 输入、单助手一点、cold 预算、无历史的独立粗估兼容。 |

## 5–9. 行为、偏差与职责

`准备请求 → 收集已确认历史 → Core 计数、校准 → 既有 inputEstimate → 窗口判断/显示`。I1：可读摘要和思考按正文密度，仅协议明确标为加密的值采用密文密度。偏差始于 visitor 将显示桶直接用于折算。I2：真首轮与有历史但无合格同族确认分别采用 4.5/16、4/16；缺样本本身不能证明首轮。I3：精确模型有效历史优先，缺少时在当前 Session、同 provider 内用最近一个可计算组成的同族确认。偏差始于 DB 和内存两个既有历史适配的精确 ID 条件。I4：确认与请求体成对，包含 cache.read/write；媒体单独加一次，估算值不进入确认账本。

## 10. 唯一设计

1. 保留用户允许的 breakdown.encrypted：在原 visitor 同一次遍历计数 **E=明确密文字段的序列化值字符数**；所有可读内容及JSON包装按正文。原reasoning显示桶不变。reasoning桶内识别 SDK/native 的 `reasoningEncryptedContent`，以及 reasoning item 自身的 `encrypted_content` 字符串；工具literal保持隔离。删除 Node.metadata 状态和 encryptedSample 单次helper，直接读取可选encrypted测量。旧无encrypted字段样本只留在原模型scalar校准、密文默认16；同族取样要求显式encrypted（包括零），不从旧reasoning合计推断，不重读正文反推。保留仅该字段对应的Schema及15行生成差异。
2. `C=bodyChars-media.rawChars+media.textChars`，`T=C-E`。新会话第一次发送使用 `round(T/4.5+E/16)+media.tokens`。有历史无样本用 `4/16`。首轮依据已有可见窗口中是否有助手或 checkpoint，排除当前空壳助手。无会话窗口的独立调用用普通 4/16。
3. **以用户指定的暂存区逻辑为上限**：撤回create取样回调，prompt/compaction沿暂存区已有process参数交付现有窗口引用；目标DB校准有效时不使用该窗口，无校准时才提取数字样本，最多20个。未新增入口、回调或数据来源，LLM参数不变，DB SQL、冷恢复及水位不变。删除内部metadata标记、encryptedSample函数和InputHistory类型别名；缺密文字段的旧scalar保留原模型边界，同族只借显式encrypted确认。其余为正常分行及现有Handle签名复用。
4. 精确和同族样本均用同一个 `learnInputRatios`，将旧拟合轴从整个 reasoning 改为明确密文 E。用学出的 `(text, encrypted)` **原样**计算 `round(T/text+E/encrypted)+media.tokens`。没有另一步乘倍率。同一模型内拟合两轴的已有确认锚点保留，不约束两轴为固定比例。单纯正文只能校准正文密度，缺乏可用的密文证据时用16；无可用确认对用 4/16。已发布有效输入、媒体以及诊断分项维持各自语义。

## 11–14. 路径及双向映射

两个 decide 只把候选切片用于正文；从裁剪前的 `context` / `input.messages` 在循环外取一次确认历史。native checkpoint 证明已经发生过会话历史。对应文件为 `core/src/session/runner/to-llm-message.ts` 和 `opencode/src/session/prompt.ts` 原估算表达式，不改变选窗或其他入口。visitor 在同一 reasoning part 内也识别 native `providerMetadata.openai` 及 SDK `providerOptions.copilot` 的 `reasoningEncryptedContent`，与 `providerOptions.openai` 和 Responses 字段同值计量。

密文字段跨 OpenAI/Azure/Copilot 名称相同，计数发生在已识别的reasoning桶内，无新增命名空间枚举或 provider metadata 状态。工具字面 JSON 保留原分桶。

V1 压缩窗口的摘要可能排在更旧的 tail 前；选同族来源和其最近样本时按已有助手的 `(time.created,id)` 而非窗口位置排序，只处理候选确认的元数据，正文投影顺序不变。验证使用较新的摘要和较旧的尾部、不同模型和密度的 fixture。

| 要求 | 仅此变更及理由 | 验证 |
|---|---|---|
| I1/I4 | Core visitor 分离已授权的密文字符测量，保持展示分项。 | 现有 mixed-density、schema round-trip、媒体/JSON 单遍用例 |
| I2 | 在取样结果附带首轮事实，只在已有调用内交接；不猜测 model ID 或消息长度。 | 真首轮与跨族空采样 |
| I3/I4 | native/V1 内存取样共用族定义；由单一学习器处理 donor。精确路径优先于更近的 sibling。 | 现有 V1/Core 取样、prepared 集成与至多两个行为用例 |

主路径分支为首轮、普通先验、peer、精确确认；旧持久样本沿 scalar 合同。诊断面 0，失败后替代路径 0。其余入口、显示/费用、水位、压缩保留均复用原实现。

## 15–19. 实施、TDD、硬预算

最终保留手写生产为 Core token/runner-to-llm-message，V1 token/processor/prompt/compaction，Schema session-message；生成文件仅保留授权密文测量的必要差异。process参数与prompt/compaction传参逻辑沿用户指定的暂存区，create回调完全撤回。仅修订原3个测试文件，新增用例0；原基线断言保持，新增同族验证归入已有混合密度用例并复用fixture。其他线程修改不纳入。

**按相对固定基线的新增+删除实计，生产和测试各最多120，新增 test/it 最多2**。每个改动文件新增行平均字符数 <= 原文件全部行（含空行）平均字符数的1.1倍；采用正常分行，不添加空白或注释凑平均值。撤回文件最终净差异必须为零。文档独列。

反馈：在 `packages/core` 用 `bun -e` 执行 `Token.estimateRequest`，`16k` 明文摘要 + `16k` SDK 密文基线为 **8035**；`45k` 单 user 基线为 **11261**。独立 oracle 是普通先验时密文增量1000、明文增量4000、真首轮45k正文增量10000。同一模型的两次确认 `C=1M, E=200k/800k, U=220k/130k` 可辨识 `(4,10)`，已用原学习器实测；切到其 sibling 后密文增量应按 `/10`。前次只读留出回放 7,544 点固定 4/16 的 MAPE 为7.79%；未将其他迁移方法的结果作为本方案证据。

从包目录运行 `bun test test/util-token.test.ts test/session-compaction.test.ts test/session-runner-model.test.ts` (core)，`bun test --timeout 30000 test/token/estimate.test.ts test/session/messages-pagination.test.ts test/session/processor-effect.test.ts test/session/message-v2.test.ts` (opencode)，`bun test test/util/token-estimate.test.ts test/util/token-accounting.test.ts` (tui)，core/schema/opencode 包 `bun typecheck`。`git diff --check`、按路径 `git diff --numstat`、独立全范围实现审计、verified 后 path-only 中文 commit。

## 20–21. 边界与审计

更新现有 processor fixture：真首轮4.5，复用已载入确认数据，混合样本给出明确密文数。根 `bun ./script/generate.ts` 的授权字段生成结果核对不变。HTTP API 在 packages/opencode 运行 `bun test --timeout 30000 test/server/httpapi-event.test.ts test/server/httpapi-session.test.ts test/server/httpapi-sdk.test.ts test/server/httpapi-public-openapi.test.ts test/server/httpapi-schema-error-body.test.ts`。既有回归、typecheck、Gate仍执行。

R4既有测量验证仍适用：OpenAI/Azure/Copilot 明文16000→4000、密文16000→1000；显式encrypted字段按新字符数保存。通过实际取样的parts getter失败探针验证只消费已载入的数字确认，不读正文。最终实测生产120行、测试113行，每文件新增行平均长度比均≤1.1，V1 typecheck通过。目标首轮、同族独立密度规则不变。

verified后按路径提交，再按用户授权 push 一次并执行正常 pre-push。性能检查失败则调查、修复本范围原因，不跳过hook、不调整性能门禁来放行；远端只推进验收成功的提交。

精确校准继续使用实际确认，切换不会证明不同模型 tokenizer 相同。缺少可拆分历史时应用先验，不读取正文补采样。生成/工作树若出现非本任务变更不纳入。无产品开放决定；Follow-up：无。仅 auditor 按原始需求、固定基线和本计划完整审查。

## 22. Revision Delta / Plan Audit

R1 full-scope，`ses_dde6d38f8ffeL85u3SEl5rVZbt`。Blocking：B-01 裁剪后的窗口会把已有历史的会话判成首轮；B-02 同一份 OpenAI 密文在预检和准备发送时会按不同密度计数；B-03 计划要求运行的 V1 测试与新合同直接冲突；B-04 共享字段已进入公开协议，验证清单漏掉生成步骤。Non-blocking：7,544 点回放为历史观察。Follow-up：无。**BLOCK — `docs/plans/token-family-prior.md` R1，第 1 轮全范围方案审计。**

R2 delta：§10–14 补充完整选样历史、checkpoint 和真实密文形态，按最新原文将 DB 保持不动，同族确认只来自已读窗口；§15–21 纳入既有 processor 断言和完整生成验证。前次 R2 调用中止，未出具 verdict。

R2 full-scope，`ses_dde6d38f8ffeL85u3SEl5rVZbt`：B-05 同族分支更换了算法和验收值，仍沿用原任务与 R2 编号；B-06 V1 已读窗口的回放顺序不能证明哪个同族模型最近。Non-blocking：7,544 点回放仅描述固定 4/16。Follow-up：无。**BLOCK — `docs/plans/token-family-prior.md` R2，第 2 轮全范围方案审计。**

R3 delta：B-05 按用户最新更正，以同族两项密度直接初始化取代旧倍率合同，16,000 密文的 `/10` 验收为 1,600 token。B-06 在现有 V1 窗口内按消息时序取确认。按用户明确要求，对更新后的完整需求继续使用原审计 Task。

R3 full-scope 及同 revision 复议，`ses_dde6d38f8ffeL85u3SEl5rVZbt`。B-01 至 B-04、B-06 已关闭。Blocking B-05：原交接与 R3 对同一请求给出不同验收值。原 Task 确认 R3 与最新两段用户原话一致，但拒绝以续审消息替换首次交接基准。Non-blocking：V1 顺序概括偏宽，第 54 行执行规则已明确。Follow-up：无。复议 verdict：**BLOCK — `docs/plans/token-family-prior.md` R3，内容标识 `c8e802065c79539f13a295552eadd92c864704f7`。** 未获独立计划放行。

更新完整需求交接后的第4轮，`ses_dde3cfee2ffeXJzTMlf5zYWohz`：B-05 解除；Blocking B-07 密文识别遗漏现有 Azure Responses 路径。Non-blocking：无新增。Follow-up：无。**BLOCK — `docs/plans/token-family-prior.md` R3。** 标识 `25a75686a4d44db9a9a2052481f961ea0abadfee`。

R4 delta：B-07 在同一 visitor 内按字段及 reasoning metadata 位置识别 Azure 等既有命名空间，扩展原形态 fixture；其余设计和硬预算保持。

第5轮 full-scope，`ses_dde3cfee2ffeXJzTMlf5zYWohz`：**No blocking findings.** B-07 已关闭。Non-blocking：无新增。Follow-up：无。**APPROVE — `docs/plans/token-family-prior.md` R4。** 精确内容标识 `8c2e31867929bc7db1a9501d0ed527e43e0b083c`，固定基线 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`。仅放行该修订；实施和验证及独立实现审计完成后进入 verified/commit。

R5 delta（用户明确收敛要求）：保留最终授权的密文字符字段；去掉完整history接口、compaction参数、内部metadata状态和单次解码helper，按需提供最多20个数字样本；增加1.1倍平均行长约束、HTTP API测试和一次push的pre-push性能验收。R5前次调用中止，无verdict。R4实施记录为历史，不作为R5放行证据。

第6轮 full-scope，`ses_dde3cfee2ffeXJzTMlf5zYWohz`：Blocking B-10 旧混合密度被允许跨模型当作正文密度使用；B-11 撤回摘要取样交接后，压缩模型切换无法使用同族校准。Non-blocking：一次push可能只启动异步preflight后等待；按对应提交最终结果验收，再次push需额外授权。Follow-up：无。**BLOCK — `docs/plans/token-family-prior.md` R5，第6轮全范围方案审计。** 标识 `79397acf24f8f3305b179a97ac4c89e71c246143`。本轮达到默认轮次上限，R5未实施。开放决定：是否允许追加一轮原Task审计，以保留R4已有的旧scalar原模型边界，并将摘要交接收敛为同一个按需数字样本输入。

用户已回答「允许追加一轮」。R6 delta：B-10仅允许显式密文测量的peer，保留旧scalar原模型边界；B-11普通与摘要使用同一个内部create数字取样回调，恢复原process/LLM参数。无新增历史读取。当前R4工作区的HTTP API基线命令已执行：5文件84 pass / 0 fail / 3097 expectations；R6实施后重跑。

第7轮 full-scope（用户追加），复用 `ses_dde3cfee2ffeXJzTMlf5zYWohz`：**No blocking findings.** B-10、B-11方案层面关闭。Non-blocking：无新增，异步preflight等待不视为性能通过，再次push需额外授权。Follow-up：无。**APPROVE — `docs/plans/token-family-prior.md` R6，第7轮全范围方案审计。** 标识 `3aaeb92bcf0d43799af938a6b52c021d09d00a35`，固定基线 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`。仅放行该精确修订，仍须最终diff实现审计。

R7 delta：用户明确要求新逻辑相对暂存区只能减少，故撤回R6回调试作，保留暂存区原传参；删内部metadata状态、单次encryptedSample函数和额外类型别名。拆分过长新增行，生产120/测试113，逐文件平均行长约束通过。用户已回答「允许继续复核」。当前HTTP API复跑：event/sdk/schema-error三文件32 pass，session/public-openapi两文件52 pass，合计84 pass / 0 fail / 3097 expectations。

第8轮 full-scope（用户追加），`ses_dde3cfee2ffeXJzTMlf5zYWohz`：**No blocking findings.** Non-blocking N-01：§23旧实施数据须标明R4历史。Follow-up：无。**APPROVE — `docs/plans/token-family-prior.md` R7，第8轮全范围方案审计。** 计划标识 `56d9d3732d916eef5ae46ddad378ebadbde42aff`，固定基线不变。本轮独立执行Core29、V1 47、HTTP API84/3097、core/opencode typecheck、Gate 0 errors/3 hints；还原任务diff核对生产120/测试113、新增0测试、最大平均行长比1.09918。R7只有经最终diff实现审计后才verified；提交后仍须对应SHA的性能验收。

## 23. 实施证据

### R4 历史实施记录

实际生产7个手写文件：Core token/runner-to-llm-message，V1 token/processor/prompt/compaction，共享 session-message schema；生成3文件：client types、legacy SDK types、OpenAPI。测试3个既有文件：core util-token、V1 token/estimate、processor-effect；只新增1个 native 行为用例。

按相对固定基线的 `git diff --numstat -- packages` 累计新增+删除：生产102，测试82。`message-v2.ts` 及全部 DB 查询、冷读取、权限、工具和 compaction 选择逻辑无差异。调用处只交付已有 canonical/input.messages 引用；decide 的现有采样移到循环前。

Red/green：16k密文增量基线4000→1000；native sibling 缺样本初值1014不能满足已知 `/10` 的1600–1620范围→通过；V1 sibling 同样见红后通过。processor同族 `/5,/10` 测试在未交接历史时得到4.5而非5→交接后发布5且确认账本仍为provider的100。新首轮4.5、已有checkpoint/跨provider4、本模型优先等由同组行为断言覆盖。

| cwd | 执行命令 | 结果 |
|---|---|---|
| packages/core | `bun test test/util-token.test.ts test/session-compaction.test.ts test/session-runner-model.test.ts` | 30 pass / 0 fail / 281 expectations；补充checkpoint断言后util-token单独11 pass / 156 expectations |
| packages/core | `bun test test/session-runner.test.ts -t "decide bounds"` | 1 pass / 25 expectations |
| packages/opencode | `bun test --timeout 30000 test/token/estimate.test.ts test/session/messages-pagination.test.ts test/session/processor-effect.test.ts test/session/message-v2.test.ts test/session/compaction.test.ts` | 255 pass / 1 skip / 0 fail / 921 expectations |
| packages/opencode | 下列 prompt 聚焦命令 | 4 pass / 29 expectations |
| packages/tui | `bun test test/util/token-estimate.test.ts test/util/token-accounting.test.ts test/context-usage.test.ts test/request-usage.test.ts` | 47 pass / 535 expectations |
| core/schema/opencode/client/tui 各包 | `bun typecheck` | 全部通过 |
| 根 | `bun ./script/generate.ts` | 成功，仅 encrypted 可选测量的15行机械差异 |
| 根 | `bun script/guard/check.ts --files <10个手写生产/测试路径>`；`git diff --check` | 0 errors；3项非阻断 optional-field 提示；空白检查通过 |

```sh
bun test --timeout 30000 test/session/prompt.test.ts --test-name-pattern "^(decide|auto compaction resumes|preflight estimates)"
```

与基线真实 visitor 的内存对照：准备估算140对交错测量 P50/P95 为0.5444/1.8509ms→0.4875/1.8085ms；1000个已加载热助手的同族查找 P50/P95 为0.0976/0.1849ms，parts getter 一旦被读取就抛错，探针通过。计时限于本次估算函数，不含网络。无新增历史I/O；同模型命中仍在原20点窗口结束。

现有学习器的样本轴替换为 encrypted；未增加第二个倍率算法。媒体保持原点访问，去除由合格样本推出的fit.input条件，并以相对行列式的同一0.01条件合并既有退化判断。一个单次helper仅负责密文字段的协议边界；样本归一、族函数和精确采样均有复用。未来模型/密文真实误差及跨会话校准不在此次发布结论中。

返工验证：B-08 的 native/V1 组合场景先见红（1014而非1614），以现有学习器能否产生校准决定目标是否有效，保留原500字符学习门槛。同族只选最近有效确认所属的一个ID，不逐族试算其他ID。B-09恢复原媒体点访问。Core最终30 pass / 283 expectations；V1 token+processor整套47 pass / 246 expectations，简化同族选样后聚焦8 pass / 39 expectations；Core/V1 typecheck通过。1000条热记录最终probe为parts读取0、P50/P95 0.1420/0.5413ms。

## 24. 实现审计

### R4 历史实现审计

第1轮 full-scope，`ses_dde3cfee2ffeXJzTMlf5zYWohz`：Blocking B-08 样本非空被误当作目标模型已有有效校准；B-09 媒体归一化引入不必要的一次性解构。Non-blocking：Gate的3项defensive-check为提示，不直接认定为新增防御逻辑。Follow-up：无。**BLOCK — approved R4 对应的当前实现 diff，第1轮全范围实现审计。** 独立复现Core30、V1 255/1skip、prompt4、TUI47及5包typecheck、Gate0errors。按上列返工进行全范围复审。

第2轮 full-scope，复用 `ses_dde3cfee2ffeXJzTMlf5zYWohz`：**No blocking findings.** B-08、B-09 已关闭。Non-blocking：Gate 的3项 `defensive-check` 仍为非阻断提示，未发现新增错误恢复、隐藏失败或备用成功路径。Follow-up：无。独立复现Core30、native decide1、V1 255/1skip、prompt4、TUI47；Core/opencode/legacy SDK typecheck通过，未变的schema/client/tui复用上轮结果；Gate 0 errors/3 hints；diff check通过。OpenAPI与7个Client生成文件内存重生成哈希一致。实际生产102、测试82、新增1个测试；DB查询文件差异为空。

**APPROVE — approved R4 对应的当前实现 diff，第2轮全范围实现审计。** 固定基线 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`；13个包文件完整diff标识 `0e6e7e50359291d1c6a98ec725030376c1dc4502`；审计时计划标识 `697243795457b39ecdfd7cd35e0641f2faa294eb`。该结论仅适用于精确diff；可记录verdict、进入verified并按workflow提交本任务路径。

### R7 当前实施证据

实际13个包文件仍为§23列出的相同路径；相对暂存R4只删除metadata状态、旧样本推断helper和InputHistory类型别名，采用推断/既有签名并重排过长新增行。无create回调、无LLM接口改动；process/history原传参沿暂存实现。固定基线生产120行（含15行生成差异）、测试113行、新增测试0，逐文件新增行平均长度<=旧全部行平均的1.1倍。旧基线断言保留，原新增native验证合并到混合密度用例复用fixture。

当前验证：core util-token/session-compaction/session-runner-model共29 pass；V1 token/processor共47 pass；core/opencode typecheck通过；HTTP API event/sdk/schema-error为32 pass/2709，session/public-openapi为52 pass/388。独立方案复核再以原整组命令执行HTTP API84 pass/3097，181.65秒；此前工具窗口180秒、120秒超时仅是未完成观察，最终整组通过，单例30秒限制未改。Gate 0 errors/3 hints，任务diff空白检查通过。其余未变代码的既有回归/生成证据沿R4，最终实现审计按当前diff复核。

R7实现已独立放行；待提交及一次正常push触发的最终SHA性能验收。其他线程文件不在本任务差异或提交中。

### R7 当前实现审计

第3轮 full-scope，复用 `ses_dde3cfee2ffeXJzTMlf5zYWohz`：**No blocking findings.** B-08/B-09/B-10/B-11修正保持有效。Non-blocking：Gate的3项defensive-check为提示；N-01旧记录标注已处理。Follow-up：无。独立核对生产120/测试113、新增测试0，最大行长比1.09918，parts读取0。Core29、native decide1、V1 47+208/1skip、prompt4、TUI47、HTTP API84/3097及六包typecheck通过；Gate 0 errors/3 hints、diff check通过；OpenAPI及7个Client生成文件内存重生成一致。

**APPROVE — approved R7 对应的当前实现 diff，第3轮全范围实现审计。** 固定基线 `e13f6751b240a6496ee1b8bd8d1a3b1fd0d8d0d8`；完整实现diff标识 `78406dc3c5bf635d121a976528cfd52f206e1ad4`；审计时计划标识 `7df1ca6fc2673969d10f25c06b90210fb05db8b0`。可记录verdict、进入verified并按workflow提交。**最终提交SHA的pre-push性能验收仍待完成，异步等待状态不视为通过。**
