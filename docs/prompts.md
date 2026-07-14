# Prompt 存档

本文件是 prompt 片段存档。各片段按顺序构成一条工作流链：① 只调研，输出完整方案 → ② 方案审计与放行 → ③ TDD 手术级实现 → ④ 创建 commit。可整链顺序运行，也可按任务场景单独复制对应片段。

-------------

## 新版：基于 Skills 与 Session GOAL 的第一性工作流

本节是当前推荐工作流。它只负责组织现有 policy、skills、canonical template 和独立 auditor，不复制或弱化这些文件中的完整规则。每次执行都必须读取磁盘上的当前版本；本节与它们发生冲突时，以用户原始需求、仓库指令和当前 policy 为准。下一个分隔符之后的旧版 prompts 保持原样，仅作为历史存档。

### 使用方式

1. 在目标 Session 中运行 `/goal`，创建或编辑 GOAL。
2. 复制下面的 GOAL objective，并替换所有 `<...>` 占位符。
3. `目标终态` 必须明确选择 `approved-plan-only`、`verified-implementation` 或 `verified-implementation-and-commit`。
4. 未明确选择 commit 终态时，不得 stage、commit 或 push。任何终态都不包含 push；push 需要另一条明确的用户指令。
5. 下面的模板本体保持在 5500 字符以内，为具体目标原文预留空间；Session GOAL objective 的硬上限为 6400 字符。只复制代码块，不要复制本节说明。
6. 如果替换原始需求后会超过上限，不得截断需求。先把完整原文保存到稳定的 issue 或 specification 文件，再在 objective 中填写该路径。

### GOAL Objective

```markdown
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
- 仅在目标终态被当前证据逐项证明后标记 `complete`。同一真实阻塞连续至少 3 个 GOAL turns 且无法继续推进时才标记 `blocked`。

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
- forward mapping：requirement/invariant -> path/file/test。reverse mapping：concept -> requirement/invariant/safety evidence + 不可复用原因。缺失映射不得提交审计。
- 完成后设置 `Status: audit-required`、`Approved revision: none`、`Implementation allowed: no`。

## 阶段 2：独立方案审计

### Primary Agent

- 只调用 `adversarial-auditor`、发送 handoff、接收并原样记录 verdict。
- 不加载 `adversarial-audit`，不发送自评、问题猜测、设计辩护、建议审计范围或“已经检查过”的声明。
- handoff 仅含原始需求、plan 路径、repository root 和 `Audit mode: plan`。

### Auditor Subagent

- 本轮开始时自行加载 `adversarial-audit`、policy 和必要仓库证据。
- 按自身 skill 独立审计；primary agent 不复述、筛选或预判审计标准。

### 放行

- 任一 blocking finding 都要求修订同一 plan、递增 revision、清空 approval，并按原始需求和完整 affected interface full-scope 重审，禁止 delta-only review。
- 最多 6 轮。连续调用失败 3 次后记录 `independent-audit-unavailable`，不得 self-review。轮次用尽后 blockers 仍保持 blocking，并作为开放决定交给用户。
- exact revision 仅在获得 `No blocking findings` 和 `APPROVE` 后，才原样记录 verdict，设置 `Status: approved`、`Approved revision: <current>`、`Implementation allowed: yes`；不得夹带设计修改。
- `approved-plan-only` 在完成逐项终态审计后标记 GOAL `complete`，不得实施代码。

## 阶段 3：按批准 Revision 实施

### 此时加载

- 仅在目标包含 implementation 且 exact revision 已批准时加载 `approved-plan-implementation`，并加载或继续执行 `tdd`。
- bug 类任务继续使用既有 `diagnosing-bugs` feedback loop。

### TDD 和修改边界

- 实施前重读批准范围。interface、producer、consumer、invariant、owner、tests 或 file plan 发生相关漂移时停止，修订 plan 并重新审计；不覆盖、不回退、不夹带无关 worktree 修改。
- 在批准 seam 逐个执行 `red -> minimal approved behavior -> green -> regression`。expected value 必须独立；不得断言 private helper、源码、调用次数、复制 production algorithm 或 horizontal slicing。
- 只执行 approved repair/rollback。任何 behavior/scope/interface/ownership/fallback/test seam/file/concept 偏离都必须停止，递增 revision、清空 approval 并 full-scope plan audit。禁止 auditor 事后批准未计划设计。
- 必要安全增强若在实施中才被发现，必须作为新事实进入 plan 和审计，不能静默加入，也不能仅因未逐字出现在用户需求中而直接删除。
- 保持仓库命名、分层、类型、错误处理、module shape 和测试组织。禁止无依据的 refactor/dependency/public API/config/migration、类型逃逸、dead/unused/test-only code、弱化测试或安全约束，并删除淘汰 workaround。

### 注释和验证

- `E` 排除空行、import-only、formatter-only、generated 和 pure-move 变化。必须满足 `if E = 0: C = 0` 与 `if E > 0: C >= max(1, ceil(E * 0.15))`。
- `C` 只计算邻近修改点并解释 invariant、真实边界、常量、测试意图、compatibility 或 safety 的中文注释。复述代码、翻译 identifier、重复测试名、显然流程、集中堆放和拆行凑数均不计入。
- 从最窄测试扩展到 regression、原始 loop、package-local typecheck/lint/build/generation/migration/integration。遵守工作目录，不跳过、隐藏或弱化失败，并记录命令、目录、结果和修正。

## 阶段 4：独立实现审计

- implementation evidence 记录 files/diff、red-green、verification、原始 loop、paths、E/C、排除行、未验证项。设置 `Status: implementation-audit-required`，未经 revision 不再 material change。
- primary agent 只发送原始需求、plan/approved revision、repository root、`Audit mode: implementation`、changed files/diff，不发送实现辩护、自评、怀疑点或缩减范围。
- auditor subagent 自行加载审计 skill、policy 和仓库证据，按原始需求和完整 affected interface 审计，禁止只看最近修正。
- blocker 必须返工并 full-scope 重审，最多 3 轮。连续失败 3 次后记录 `independent-audit-unavailable`，不得 self-review。轮次用尽仍有 blocker 时标记 `blocked`，不得 `complete`。
- 只有实际 diff 获得 `No blocking findings` 和 `APPROVE`，且测试、验证、责任边界、workaround 删除和中文注释门禁全部通过，才能原样记录 verdict 并设置 `Status: verified`。

## 可选 Commit

仅当终态是 `verified-implementation-and-commit` 且状态已 verified：

1. 检查 `git status`、`git diff`、`git diff --cached` 和 `git log --oneline -10`。
2. 只 stage 本 GOAL 相关文件，排除 secret、credential 和无关修改。index 已有无关内容时不得夹带或擅自清除，应停止并报告。
3. 不创建空 commit。提交信息使用中文多行格式：`type(scope): 简短中文说明`，type 只取 `fix|feat|refactor|test|chore`，scope 使用受影响模块，后续 1 至 2 段说明原因、行为边界和避免的回归。
4. 不得 amend、不得 `--no-verify`、不得跳过 hook、不得 push。
5. hook 拒绝时修复原因并创建新 commit，不得 amend 失败尝试。commit 成功后检查 `git status` 并报告 commit id。其他目标终态不得 commit。

## 最终证据

- 报告 plan/revision、核心文件、测试/验证结果、approved-route 证据、删除的 workaround、path verdict、E/C 与代表性注释、全部审计轮次、剩余风险/未验证项及每个改动的必要性。
- token budget、turn 结束、部分成果或总结文本都不能证明完成。仍有 required work 时保持 GOAL active。
```

-------------

请注意！！！你需要从头开始！！！从调研开始进行，在你接到一个新的任务或者需求的时候，你必须从第一项调研开始进行，不能直接认为你之前已经完整审计过了就直接进行跳步，这不被允许！！！

## 只调研，不改代码，输出完整方案


请先不要实施代码修改。请基于当前仓库的已有设计思想、模块边界、代码风格和测试组织，进行完整详细的完整探索，尽量遍及那些可能存在的冲突或者依赖、兼容、边界、时序问题，为本次需求构建一份完整、可执行、克制的实现方案。

不要只阅读入口文件、表层实现或少量显眼测试后就输出方案。必须尽量完整确认与本需求相关的调用链、引用链、测试链、配置链、错误链路、兼容链路、生成链路、并发/退出/清理链路和安全边界。
要求：
- 按照项目现有设计理念和分层方式解决问题。
- 优先复用或微调已有逻辑；不要新增不必要抽象、状态机、配置项、公共 API 或大范围重构。
- 不要过度假设不存在的问题；只处理本需求真实需要覆盖的正常路径、边界路径和错误路径。
- 修改应是手术刀式的：切入点少、行为链路清晰、git 净增量和文件数可控。
- 如果旧逻辑冗余、过期、重复或与新需求冲突，请说明应删除/替换/收敛，而不是叠加新逻辑。
- 注释只解释非显然约束、安全边界、兼容性原因、常量含义和不变量；需要注释时使用清晰中文。
请输出：
1. 需要阅读和确认的现有文件/测试/文档。
2. 当前相关逻辑的职责边界和必须保持的既有行为。
3. 推荐的最小实现方案，并说明为什么比其他方案更符合现有设计。
4. 预计修改/新增/删除的文件，以及每个文件的具体改动。
5. 正常路径、错误路径、并发/退出/清理/安全边界的处理方式。
6. 行为级测试计划：先写哪些测试、当前实现下会暴露什么缺口、实现后如何验证。
7. 建议运行的验证命令。
8. 预估 git 文件数、增删行数和是否涉及生成文件/迁移/文档。
9. 真实风险与开放问题；没有必须用户决策的问题就不要阻塞，但不能把未经确认的关键路径轻描淡写地跳过。

输出方案前必须明确说明：

1. 已阅读哪些文件、测试和文档，以及它们为什么相关；
2. 通过搜索确认了哪些调用点、引用点和旧逻辑；
3. 哪些既有行为必须保持；
4. 哪些边界、兼容、时序或安全问题已经确认；
5. 哪些地方曾经不确定，以及最终如何确认。

只输出方案，不要改代码。
请你进行完整的调研而不是只进行简单的脱离底层实现以及边界情况的顶层规划。
最终请给出推荐方案摘要。请注意所有不确定的内容你要完整确认直到你已经把所有潜在的问题都考虑在内了，且方案已经足够完善且自然，我不希望存在未经确认或者仍需探索的任何相关代码部分，最终执行将会按照方案进行。

-------------

## 方案审计与放行

在完整设计方案之后，必须给 subagent 进行完整检查，看看方案设计是否合理、冗余是否足够小、依赖与兼容是否已经完整考虑。

subagent 检查是硬性步骤，不允许省略，不允许降级为自检。如果 task / subagent 调用失败，必须继续重试；在成功完成独立复核前，不得输出最终方案结论。

完整进行相应的审计与检查，subagent 均无任何的阻塞性意见之后再进行修改；如果 subagent 运行之后有任何的意见，均需要再次进行完整方案的构建然后再进行相应的 subagent 的原标准以及原范围的完整方案审计，不能进行任何的审计范围收缩与下降。

阻塞性意见指会导致回归、安全降级、兼容降级、边界漏洞、bug、时序问题或逻辑错误等行为级缺陷；纯代码风格、命名偏好、格式类意见不属阻塞项。

在此期间请你自主进行决策，根据代码库的设计风格和用户的指示进行，最多迭代 6 轮：6 轮后若subagent仍有阻塞意见，强制收敛为「开放问题」交用户决策，不再无限重建。subagent 连续调用失败超过 N 次时，标注「未完成独立复核」并交用户决策，不静默降级为自检。

subagent 无阻塞性意见后放行结束本阶段。但请注意当前并没有允许进行相应的完整修改，你需要完整进行相应的汇报。

请注意，接收到本prompt的任何流程都应该从上方的完整方案构建开始，不能进行任何偷懒跳过。本流程阶段的放行条件是：上一阶段产生的方案在本阶段存在一次完整的无任何阻塞性意见的审计结果，假设有 1 个阻塞性意见，必须全部回退到最开头，不允许直接修改方案后不进行二次审计就完整跳过。

-------------

## TDD 手术级实现

请按当前仓库的原始代码风格进行一次手术级实现。目标是在不扩大修改面的前提下，完整实现本次需求，并确保后续重构不会破坏既有行为。

工作方式必须遵循 加载TDD skill 的完整指令：

1. 先阅读相关代码、测试、文档和现有约定，定位最小修改面。不要急于实现。
2. 先补充或修改测试。测试必须是行为复现级断言，而不是检测源码结构、函数名、字符串片段或实现细节。测试应覆盖正常路径、边界条件、错误路径、回归风险和与既有行为的兼容性。
3. 确认新增测试在当前实现下能够暴露缺口；随后再实现功能。
4. 实现后运行相关测试、类型检查、lint 或仓库中已有的等价校验命令。失败时继续修复，直到与本次修改相关的检查通过。

实现要求：

- 保持原项目的命名、分层、错误处理、测试组织和代码风格。
- 优先复用、扩展或微调已有逻辑；只有在现有抽象无法承载需求时才新增代码。
- 不做无关重构，不改无关格式，不引入新的依赖，不扩大 public API 或配置面，除非需求本身必须如此。
- 新增代码必须短小、凝练、可读，避免重复分支、过度抽象、临时兼容层、死代码、unused helper 或仅为测试服务的生产逻辑。
- 注释是硬性要求，不是可选项。凡是本次 git diff 中新增或修改的生产代码、测试代码、配置逻辑、常量、分支条件、错误处理、边界处理、兼容处理和安全处理，都必须优先考虑补充中文注释。
- 本次 git diff 中新增或修改的有效代码行，至少应有 15% 的行数对应到中文解释性注释。有效代码行不包括空行、纯格式调整、import 排序和仅由格式化工具产生的变化。
- 注释不能集中堆在文件顶部、函数顶部或单个代码块中，必须分布在关键修改点附近。
- 注释必须解释“为什么这样做”、该分支保护什么边界、该常量/字符串代表什么语义、这里需要保持什么不变量、未来修改时不能破坏什么行为。
- 不允许用复述代码表面行为的注释凑数量，例如“设置变量”“调用函数”“返回结果”这类无意义注释不计入 15%。
- 即使是小需求，也不能因为改动少、逻辑短或测试简单就省略注释；至少应在关键行为变化、测试断言意图、兼容边界或常量含义处留下中文说明。
- 不允许通过削弱测试、跳过校验、删除既有断言、吞掉错误或放宽安全约束来让测试通过。
- 如果涉及命令、权限、路径、解析器或 shell 字符串处理，必须额外覆盖引号、转义、空格路径、环境变量、管道、重定向、子命令、危险操作、空输入、非法输入和 approval / deny / auto 边界。

完成实现后，必须调用 task / subagent 做独立复核。该步骤是硬性门槛，不允许省略，不允许降级为自检，不允许因为一次调用失败就跳过。

如果 task / subagent 调用失败，必须继续重试；在成功完成独立复核前，不得输出最终完成结论。复核时不要告诉 subagent 你的实现方案、修改设计理由或自我判断，只告诉它本次需求、当前修改位置的文件路径、git 可以看到的你涉及的修改文件列表和必要上下文，让它从外部审查：

1. 是否存在冗余、unused、重复抽象或不必要的修改；
2. 是否引入潜在冲突、边界漏洞、回归风险或逻辑错误；
3. 功能行为、测试覆盖和需求说明是否对齐；
4. 注释是否清晰、完整充分，是否满足 git 有效修改行 15% 中文注释，并清晰解释关键常量、边界和不变量；
5. 是否相较修改前造成任何功能降级、安全降级或兼容性降级；
6. 每个修改是否必要，且实现链路是否完整准确。

复核采用与方案审计相同的循环规则：subagent 提出任何阻塞性意见（回归、安全降级、兼容降级、边界漏洞、bug、时序问题、逻辑错误等行为级缺陷；不含纯代码风格意见）都必须返工重修，再按原标准原范围重新审计，不能收缩审计范围。最多迭代 3 轮，3 轮后仍有阻塞意见则强制收敛为「开放问题」交用户决策。subagent 连续调用失败超过 N 次时，标注「未完成独立复核」并交用户，不静默降级为自检。

根据复核结果继续修正。最终输出不能只给三四行摘要，必须逐项给出可审计证据：

- 修改了哪些核心文件；
- 新增或更新了哪些行为级测试；
- 本次修改中哪些关键位置添加了中文注释，如何满足 15% 硬指标；
- 运行了哪些验证命令及结果，失败时如何继续修复；
- subagent 独立复核发现了什么问题，以及如何处理；
- 仍然存在的风险或无法验证项；
- 为什么当前实现是最小且必要的修改。

-------------



## 创建 commit

请为当前相关修改创建一次 commit。首先检查git status以及git diff --cached，提交信息按本仓库风格使用中文多行 message：第一行采用 `type(scope): 简短中文说明`，type 从 `fix/feat/refactor/test/chore` 中选择，scope 使用受影响模块；后续 1-2 段说明修改原因、行为边界或避免的回归风险。不要 amend，不要 push，不要提交无关文件。
