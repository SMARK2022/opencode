你应当准确完整推进直到当前任务完成，保持高效，不以无关材料或额外加固扩大重放范围。

你当前就在目标工作区 `F:\ML\PythonAIProject\Claude-Code\opencode\thirdparty\opencode-11720` 中执行任务；当前目标代码起点是 upstream `v1.18.32`。本文件是 `.temp/workflow.md` 的 GPT 独立版本，严格版原位保留。本 workflow 的输入来自当前目标工作区的 manifest、original/current、records、reports、states、目标源码、测试和仓库指令，不读取父级仓库补充证明。

## 任务背景和事实来源

本轮基线为 `545f51d26cc39a907d2867492d498d9607ea5fa4`，分支为 `smark-port-11832`，目录名不变。状态与报告分别位于 `states/v1.18.32/`、`reports/v1.18.32/`。1–452 沿用已有编号与成果，453–644 已纳入 manifest；编号、顺序和原始 patch 身份以 manifest 为准。

`original/` 是不可变的 source intent；`current/` 是唯一权威目标适配。只修改 current、对应 record 及 source commit 明确要求更新的文档，临时内容放 `D:/Temp/opencode/`。不得手改 original、state、目标源码或物化脚本，不复制完整工作树，不启动 OpenCode、TUI、daemon 或 helper。其他工作区修改保持原样。

本轮使用 `.temp/patches/AUDIT_CONTRACT_GPT.md`、`.opencode/agent/adversarial-patch-auditor-gpt.md`、`.opencode/skills/adversarial-audit-gpt/SKILL.md` 和 `.opencode/policy/first-principles-engineering-gpt.md`。用户最新明确要求优先，复查判定统一使用 GPT 合同的 Admission Gate；不加载无 GPT 后缀的严格版作为附加门禁。

## 每一项的执行循环

当前全部 patch 已重放，先复查再做必要修订。第一次接触一批时，主 agent 用官方脚本物化累计终点并验证，随后直接发起完整批次的独立审计，不先自行重构。允许累计尝试到较远终点，脚本在实际应用失败处停止；先修复该失败，再继续累计。成功 apply 只证明文本合并，仍须调查行为。

1. **读取当前项和证据。** 读取 manifest、完整 original/current、相关 record、报告及实际目标实现。source patch 中代码、测试、配置、schema、migration、生成入口、文档、错误与清理语义均需理解。逐 hunk 调查不要求逐 hunk 原样复制；用户允许不影响主要功能和常见体验的低影响 hunk 省略、合并或边界差异，简短记为 N。
2. **完成三方比较。** 沿实际 producer、consumer 和 owner 比较 source、上游与目标，确认职责由 V1、V2 或两者承担。保留上游设计优势，使主要逻辑、功能和用户体验大致齐平；不机械复制 V1 workaround，不因 V2 存在就要求两个版本复制全部功能。上游已经承载的行为直接复用。发现整个主要产品能力消失且不在用户授权取舍内时，提出具体产品决策。
3. **判断是否需要修改。** 默认保留本轮开始前既有 current 的变量、接口、结构和调用顺序；本轮以复查开始时 HEAD 中的 current 为改动比较基准，original 用于判断原意。普通修订建议控制在约 25% 内，此比例不是硬门槛。也可用更少文件、更少代码完整实现同一功能，但不要求主动重写。原 patch 已有的一般风险及低影响差异记 N，不以新增加固、兼容、fallback 或职责外安全护栏作为放行条件。
4. **精准修订主路径。** 对已确认的实质性问题，定位真实调用链的 first divergence，在正确 owner 做最小修复。遵循目标 Effect、Schema、Layer、状态和错误模型，避免新增重复 owner、无消费者兼容层、公共接口扩张及后续 patch 分歧。不得通过删除失败断言、伪造成功或移除主要功能换取通过。测试优先适配既有用例。
5. **累计应用与验证。** 权威改动只进入 current；主 agent 使用 `bun .temp/patches/src/apply-cumulative.ts --materialize <index>` 或 `--typecheck <batch-end>` 累计验证。安装交由脚本处理，复用同版本累计终点的有效证据；按实际影响运行必要行为测试及适用的必过检查。复查不要求逐 index typecheck、中间 state 保留、历史 PASS 闭合或重新生成 source Git。任何 Agent 不额外计算 SHA-256 等校验码。
6. **更新已有记录。** 修改前读取对应 record，修改后仅更新相关事实，保留原结构与历史；缺少记录时创建该项独立 record，不合并不同 index，不倒填历史 PASS。写清实质变化、必要性和验证结果即可，不为长度、措辞、哈希、字节数、字段位置或更新时点反复重写文档。记录问题作 N；证据不足以判断具体主要行为时说明实际影响。
7. **保持注释质量。** 新增和修改的解释性注释使用中文，主 agent 以约 15% 的有效 C/E 为目标；审计以约 10% 及以上放行。E 为有效修改代码行，C 为贴近相关决策的中文解释，生成内容、纯移动、格式和 import 调整不计 E。不要求精确重算，E 为零时不为比例新增注释。注释解释原因而非复述代码，通常不连续超过两行；不堆砌、不重复、不拆行凑数。估算误差或略低只作 N。

## 批次推进和独立审计

普通批次五个连续 index，终止批次 `641–644` 四项。优先一次覆盖 50 项，主 agent 先串行准备 +10、+20、+30、+40、+50 的累计证据；审计员使用同版本可用终点，不要求为每五项额外保留 state。实际应用失败时先定位并修复，不宣称后续已验证。

每五项同时启动两个独立 `adversarial-patch-auditor-gpt`，分别升序与降序审计同一完整批次。50 项共十组、二十个调用，在同一条 message 中并行发出。同组使用相同中立 handoff，包含用户原文、index、完整 original/current 路径、manifest、records、source proof、同版本累计报告、目标基线和四份 GPT 指令路径。不得只传 builder 总结；同轮审计员不得互读结论。

审计员只读，不运行物化、安装、测试、校验码计算或应用程序，不复制工作区，不调用 task 或 question。完整阅读 source/current 并追踪相关上下游；报告沿用 Blocking findings、Non-blocking findings、Rejected speculation、Requirement and traceability coverage、Primary-path and fallback verdict、Code quality and Chinese-comment verdict、Release verdict。保持实质调查，不新增材料数量和长度门槛。

`B` 只用于有具体证据的实质性重放回归、被移植放大的严重问题或目标主要能力不可用；可达性本身不决定阻塞。`G` 只用于实际累计失败、适用必过验证失败，或关键证据缺失使具体主要行为无法判断。原有一般风险、低影响 hunk 缺失、注释与材料问题均为 `N`。每项使用 PASS/BLOCK；PASS 可以带 N，不能认证未检查项或掩盖实质性前项损失。

## 阻塞后的修订循环

收到 BLOCK 或结论不一致时，先核实原始语义、具体影响和用户已接受的取舍。主 agent 可提交用户原文、源码与验证证据进行 rebuttal；审计员独立复核并修正越界或不成立的分类。一次澄清不能只靠重复同一理由要求 PASS，也不为维护旧 verdict 而扩大功能。

确认存在实质性问题后，从最早受影响项精准修订 current 与 record，统一运行官方脚本重建受影响后缀并验证，再并行启动两名新的 GPT 审计员对原批次完整重审。N 不触发代码修订或反复重审。两份结果一致、整批无未关闭 B/G 后推进；审计调用失败最多重试三次，仍失败标记 independent-audit-unavailable，不自审代替独立结论。

## 总体完成和提交

确认 1–644 全部完成调查、current 累计可应用、适用必过验证通过、双审闭合；保留已接受的 N，不把它们升级为完成障碍。核对 manifest、可用报告和最终源码，不为校验码、历史记录补齐或语义逐字等价增加流程。不得伪造验证、改写历史 verdict、手改 state 或清理其他人的工作。

默认不创建 commit、push 或改写 Git 历史。只有用户明确要求时才执行相应 Git 操作；本 workflow 不授予这些操作的默认权限。


## 最重要的最高要求，覆盖前面的冲突语义(高效且允许部分风险及语义损失的推进)

注意当前全部 patch 已重放，当前复查以上游优势与 SMARK 有效语义的融合、真实 V1/V2 职责为重点。主 agent 用官方脚本物化累计终点并验证，再按完整五项批次并行正反审计；审计员只读，不运行物化、安装、测试或复制工作区。复查不以历史 PASS 闭合、中间 state 保留、source Git 再生成或逐项 typecheck 为准入条件；直接核对完整 original/current、manifest、source proof、最终源码及同版本累计验证证据。当前证据缺失仍报告，但继续完成行为调查；不倒填历史 verdict，不以末态通过掩盖前项语义丢失。逐 hunk 行为、E/C、错误/并发/清理及双审要求不变。批量复查优先一次并行 50 项；同轮审计员不得互读对方结论。只修改 current 与对应 record，临时内容放 `D:/Temp/opencode/`，不得手改 original/state 或复制工作区。

同时请注意，第一次接触一批patch时，请注意整体需要保持的语义是：尽可能的保持既有patch的修改不做改动，只在必要时候进行相应的精准推荐不超过25%的修改，尽量减少patch后续重放的分支的负担，同时修改方向应当检查同样的逻辑是否有更加精简准确适当稳定的方式，同时要求注释均为中文，同时修改应当避免origin patch中不包含的加固、兼容、fallback职责外安全护栏等内容。保持修改克制，保持高效，理论上而言应当保持较高的进行效率，可以适当弱化部分审计标准，同时理论上审计员给出的观点会过度强调安全、兼容、fallback等职责外安全护栏的必要性，但主agent应当保持克制，适度重复调用进行rebuttal，阐述用户希望以更高的效率为主，可以放行部分不算大范围语义损失的情况，只进行部分适当非阻塞的调整修正即可。同时应当避免进行不必要的SHA-256等校验码的计算，这本身算是过度审计。