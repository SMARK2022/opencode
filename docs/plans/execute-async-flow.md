# Execute 设计与验证

## 1. 使用方式与范围

Execute 用一段 JavaScript/TypeScript 串联工具、并发独立查询，并在代码里筛选和汇总结果。模型只需返回下一步判断需要的内容，不必自行维护权限、取消、任务回收或输出存储。

本计划覆盖 `execute-async-flow` 相对共同基线 `a012050340b7eeed68488018205f2ed4cf8d4f0f` 的累计修改。它沿用现有解释器、工具注册、Session 权限、图片处理和截断服务，不改变普通工具的默认输出策略，也不引入后台执行。

本轮同时完成七项改进：宽泛搜索摘要、实际依赖调用示例、三种显示模式一致、最终模型回执的36,000字符预算、纯解析复用、删除重复入参复制、URL环境快照。

## 2. 从工具目录到模型回执

1. Tool Registry 保留包装器实际使用的 decoder。插件可改展示说明，但不改变实际输入合同。
2. SessionTools 从当前可用工具及 MCP 连接建立完整目录，并按配置决定哪些直接入口对模型可见。
3. 宿主将一个完整代码围栏规范化一次，取得环境租约。同一环境串行到上次真实清理完成。
4. 预跑在词法状态副本上收集能确定的调用，再用同一段源码和已收集参数进行整段检查。
5. 实际执行使用当前工具、权限、根预算和日志。每次真实调用继续走原权限、before/after hooks、child记录和取消清理。
6. 执行根停止并等待未完成的工作，交出业务值、已捕获日志、子调用终态、附件和环境 ID。
7. SessionProcessor 在耗时提示、原错误、取消提示和图片省略文本齐备后，调用现有 Truncate 服务一次，持久化最终回执。
8. 下一轮模型从持久历史取得该回执。环境租约只有在真实 Fiber 及其子清理结束后才释放。

解释器拥有语言与词法状态；ToolRuntime 拥有数据边界、签名与工具准入；宿主拥有 Session、权限、环境身份和模型交付。图片仍由 Image 处理，裁剪和恢复文件仍由 Truncate 处理。

## 3. 异步执行与并发

同步函数返回普通值，async 函数返回 Promise，并采用它返回的 Promise。参数默认值和函数体中的错误都按实际函数身份传播。每次调用有独立的参数和局部栈，闭包仍共享捕获的 Binding。

`await` 普通值也让出执行机会。`Promise.all` 保持结果顺序并在观察到失败时拒绝；`allSettled` 保留成功和普通拒绝；`race` 只选择首个结算结果，不取消败方。组合器返回可复用的 Promise，空 race 继续等待当前执行的超时或取消。

then/catch 在让出执行前建立观察，finally 与它们共用回调入口。缺少或不可调用的 handler 按原结果透传；finally 等待零参数清理，清理失败会替换原结算。宿主中断始终穿透脚本 catch，不能被改写为成功。

所有 Promise 生产者属于当前根 Scope。脚本返回、失败、超时或取消时都停止并等待剩余生产者，而不是让组合器或观察者代管它们。完成的外部副作用不回滚。根清理后只把安全终态留给 Notebook，未结束的旧 Promise 在下一格可捕获地拒绝，不恢复旧后台工作。

真正的工具与 fetch 共用八个许可。拿到许可后才解码、记录运行和启动叶调用，排队不冒充 running，也不消耗叶调用期限。同步 search、纯 Promise 观察和 sleep 不占槽；等待工具槽仍消耗执行根预算。

`sleep(ms)` 使用当前根，支持保存的别名和回调，结束时释放 timer。`for await...of` 仅扩展已支持的数组、字符串、Map、Set，逐项等待后绑定；break、continue、return和取消仍按原循环/根清理。String.replace/replaceAll 的既有异步回调扩展保留，普通 map 不被改成隐式 await。

## 4. Notebook 环境与租约

省略 `environmentID` 时创建新环境；提供完整 ID 时只复用同 Session、directory 和 workspace 的状态。空、未知、已回收或其它位置的 ID 都拒绝，不悄悄创建替代环境。成功、失败、取消正文和最早持久 metadata 都保留 `Environment: env_...`。

复用的是变量、函数、闭包与数据，不是旧工具、权限或解释器。新格可重新声明以前的顶层名字，旧闭包读取更新后的绑定；同一格重复声明和当前 const 赋值仍失败。解析失败不执行，运行失败、超时或取消不回滚此前完成的状态修改。

注册表直接持有每个实际 lease Fiber，集合同时包含正在执行和排队的租约。同环境 gate 保证串行，不同环境可并行。登记 Fiber 与公开条目在恢复可中断性之前完成，取消时直接通知实际 Fiber，不另维护 users、cancel、drained 影子状态。

回收挂在 Fiber 的真实终态观察者上，不能在较早的 callback 或 work finalizer 返回时删除引用。租约不替换 callback 原有 Scope 服务，也不包含调用者在 use 返回后做的其它工作。

每个 Session 和 Location 保留最近八个唯一调用的环境，调用准入刷新顺序，完成顺序不刷新。每次租约结束清理窗口外的闲置环境，忙或排队环境保留，允许暂时超过八个。这不是八环境并发上限，也不限制总字节或峰值内存。

Session 删除、移动及实例关闭先禁止新准入，再取消实际租约。关闭先通知全部，再等待所有真实 Fiber 及其清理；不以清理超时伪造成功。权威 Session 位置读取覆盖先发生的移动，事件订阅覆盖后发生的移动。compaction 不删除仍属于当前位置的环境。

## 5. 预跑与解析复用

预跑在租约内复制一次完整 Environment，共用一个身份 memo。Map键和值、Set、循环、闭包作用域及共享对象都保留副本内的别名关系。属性按 descriptor 复制，不执行 getter，并保留非枚举错误品牌和原文来源。

URL 由 href 重建并同时登记其 searchParams。参数视图先出现时先复制所属 URL；独立 URLSearchParams 独立复制。保存的方法和闭包仍指向同一副本，预跑对URL、容器和计数的修改不写回真实环境。原生函数和不能安全复制的访问器会停止本次探针，不改用真实环境重跑。

探针最多执行1,024次工具调用、500毫秒；sleep立即完成。每次调用仍计入上限，审查记录只按工具身份及严格参数等价保留首次记录，缺省键与undefined不混为一谈。工具返回占位值，依赖真实结果的脚本可能提前结束；已收集调用仍有检查价值。真实执行不继承探针调用次数上限，所有实际请求仍需当前权限。

源码在去除围栏后不再变化。parseProgram 私有缓存最多八项成功 AST，覆盖用户源码及 fetch 常量工厂，失败不缓存，满时移除最早项。缓存只省去重复转译/解析，不保存环境、权限、工具、日志或执行预算；有状态的 RegExp 每次仍新建。同步复制和编译不能被协作式超时抢占，500毫秒不是包含清理的严格墙钟上限。

## 6. 工具参数与发现

### 实际合同与简写

包装器从自己的原 parameters 编译 decoder，并返回同一来源引用。Effect encoded schema 决定输入签名、可搜索字段和确定性简写，输出签名使用真实decoded合同，不通过运行decoder猜测结构。

只有唯一必填标量字段，或整个对象只有一个可选标量字段时，才将 scalar 包装为该对象字段。false、0、null按类型处理；undefined/default/refinement留给原decoder。多必填、索引签名、符号和不透明结构不猜。`constructor`、`__proto__`、`prototype`不生成简写。

输入先通过既有copyOut(copyIn(...))数据隔离，再规范化安全静态包装键并调用原decoder一次。不再对已隔离参数做第二次全图复制。原标量合同不接受任意单键对象反向拆包，也不通过短名猜工具身份。

### 目录与搜索

catalog、instructions、search、namespace误调用提示共享紧凑具名签名。展示预算只选择内联项，完整可调用目录和搜索索引保留。原生read、grep、glob、edit优先；Execute-only额外优先bash、apply_patch、write，且只能来自真实native合同，不给同名MCP或custom工具隐式权限。

宽泛search只返回首行trim后的120字符摘要和完整紧凑签名，长摘要以省略号收尾。detail:true或精确路径查找保留完整说明及两侧schema。字段搜索、相关性排名、同排名路径顺序不变。默认宽泛10项、详情最多3项；16,384字符软预算在完整条目后停页，单条超长schema仍完整返回。remaining和next只描述后续页。

namespace误调用仍失败，只提供预算内的完整真实签名及后续发现提示，不自动猜工具执行。不可调用值的诊断只显示有限类型/键形状，不泄露业务值，不重新求值receiver、key或参数。可靠的TS解析位置来自用户源码；包装器或EOF位置不编造行列。

## 7. 返回数据与最终输出

### 数据和原文

显式return是业务结果，否则沿用最后一个顶层表达式；undefined按原数据出口归一化。多行文件摘录应组合为字符串，如模板字符串或join("\n\n")，而不是改变JSON.stringify对业务对象的合同。

MCP协议层只为成功、单文本、无声明outputSchema且无structuredContent的结果提供rawText候选。独立媒体走附件，多文本、资源、错误和声明输出保留协议语义。宿主显式调用fromJsonText，Schema.Json接收有限JSON容器，唯一数据边界继续检查危险键和深度；不适用的文本保留原字符串。

WeakMap保存原文，String和模板可读取；非枚举只读text别名不覆盖业务text。输出decoder先验证，重建对象后继续传来源；JSON.stringify和最终工具参数仍只有业务字段。普通spread得到新根，不继承原文身份。

### 捕获与交付的两个边界

日志在追加时按现有16KiB UTF-8预算留存，超限后只记省略数，不再保存新行。所有函数帧共用本次预算。它限制的是已捕获日志；恢复文件不声称包含源头已经丢弃的字节。search的完整条目分页和库可选maxOutputBytes合同各自保留。

CodeModeTool组成完整的中间正文，Tool.wrap继续清理可见文本，不在此提前裁剪。SessionTools完成原hooks并追加真实耗时/取消事实。SessionProcessor先经过Image唯一入口，再把完整成功或失败回执交给Truncate.output(text,{maxChars:36_000})一次。

36,000按JavaScript string.length计量，即UTF-16单位，不是token或UTF-8字节。完整恢复notice及四个换行也计入预算；剩余空间首尾各取一半，奇数余额可空置，边缘半代理对向内收一单位。省略的是中间段，短正文不落盘，长正文只保存一次完整已捕获、已组合的终态文本。

真正截断后清空未完整交付的loaded/skills声明，子调用状态和附件保留。失败仍保存原state.error及error状态，metadata.output保存有界完整回执并标记finalizedError。MessageV2直接回放新标记正文，不再重复原错误/abort提示；未标记历史失败继续原协议。

原processor.process先注册Part、等待工具执行、等待完成/失败持久化，再交付结果。用户取消发送原abort信号后先等待实际Execute调用及完整回执结算，再运行通用cleanup；普通工具与未实际调用的事件Part仍保留两秒孤儿宽限。执行与回执持久化处于同一不可中断区，之后的doom-loop人工询问仍可取消，不能把人工等待误当成工具清理。SDK回声通过原终态检查跳过，避免重复图片proof、裁剪和落盘。completeToolCall保持原void公共合同。debug不运行模型回合，可能打印完整中间结果，不承诺stdout也有36K限额。

### 进度与未观察失败

父进度在复制列表前检查100毫秒机会窗口，不增加timer。最早环境metadata和最终结算持久化，中间进度ephemeral；所有子调用的权限、hook和终态记录照常发生。

Promise真正交付Exit后才标记observed，取消等待不误称已观察。根清理后仍未观察的失败只产生事实提醒，不替换业务值；catch/allSettled处理过的失败不再额外告警。内部失败原因保持宿主私有。

## 8. 配置和提示词

`opencode.json`中的codemode接受boolean或`{ enabled?: boolean, keep_tools?: boolean }`，两个最终缺省均true。显式OPENCODE_CODEMODE及OPENCODE_CODEMODE_KEEP_TOOLS覆盖对应JSON字段；未设置环境变量不遮掉JSON false。旧OPENCODE_EXECUTE名称不另加兼容别名。

模式由Registry同一入口提供：关闭时无Execute；保留直接入口时，简单操作用direct、依赖链/批量过滤用Execute；隐藏直接入口时，目录内工具包括简单操作都走Execute。只有Execute实际可用且目录非空才注入建议。控制工具保留原职责，权限仍作用于两条入口。

工具说明依次介绍用途、调用方式、发现、结果、globals和状态。实际示例先grep TODO，最多取八项，read各命中附近五行，再join成多行字符串；明确采样，并按真实text-page合同取content。不会引导每次先search已经内联的read，也不要求每次都包装所有分页元数据。

执行timeout默认600,000毫秒，允许1到2,147,483,647的整数。根预算在同环境排队、预跑和整段审查后启动，仅运行中的question/permission人工等待暂停；重叠等待只扣一次，普通I/O不暂停。取消和叶工具自己的期限独立有效。

## 9. 验证入口

库测试从`packages/codemode`运行`bun test`和`bun typecheck`。重点覆盖Promise顺序/拒绝/清理、当前工具与词法状态、编码参数、数据隔离、搜索详情/分页和URL快照。宽泛长手册另经公开CodeMode.execute对照验证摘要及完整详情；纯解析复用通过隔离计量并结合当前工具/RegExp行为验证，不向生产增加计数器。

宿主从`packages/opencode`运行：

```sh
OPENCODE_DISABLE_MODELS_FETCH=1 bun test --timeout 30000 test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/registry.test.ts test/session/execute.test.ts test/session/tools.test.ts test/mcp/catalog.test.ts test/tool/truncation.test.ts
bun typecheck
```

最终模型回执覆盖35,999、36,000、36,001、60,000字符、原错误、24K/60K partial、实际坏图片省略、真实取消及真实121秒成功。分别验证模型与持久化一致、零或一个恢复文件、文件等于完整正文、一次最终准备和首尾对半。租约测试通过真实Deferred屏障覆盖Scope身份、子finalizer、调用者后续工作及自退休。

取消回归覆盖200ms和3000ms插件清理在取消、错误、超时下的完整上下文/partial/恢复文件；额外验证普通不合作Bash、声明而未调用、doom-loop已询问与未开始两个窗口，以及混合回合取消后没有迟到改写。

三个原测试文件已全量迁入已有codemode.test.ts和code-mode.test.ts，独立describe保留各自hooks。MCP测试仍在其协议owner。迁移没有删旧断言、脚本、字符串或解释性注释。

CLI三文件按顺序分别运行，避免并发进程共享夹具：

```sh
bun test test/cli/db-maintenance.test.ts
bun test test/cli/run/run-process.test.ts
bun test test/cli/tui/daemon.test.ts
```

`packages/core`运行`bun test test/project-copy.test.ts`。容器HOME只读时仅用命令行XDG目录隔离，不改仓库资源配置。

仓库根运行完整`bun script/generate.ts`，覆盖legacy SDK、两种Client及OpenAPI，再运行一次核对无漂移。生成文件不手工修改。对受影响TS运行现有type-aware lint及format检查，并运行git diff --check和原pre-push；已有失败与本次新增问题分开报告，不以局部测试替代全量检查。

## 10. 逐段修改说明

以下136个职责条目覆盖138个累计生产/prompt/生成差异块；H033和H035各对应两个物理块。每项列出职责、机制、必要性、删除后果与验证入口。路径与行段对应当前候选，不包含私人授权或过程记录。

### H001 · 按实际能力组织说明与依赖调用示例

路径：`packages/codemode/src/code-mode.txt`；`@@ -1,27 +1,42 @@`

职责：说明真实调用、发现、全局能力与结果形式。
机制：保留原说明结构，用通用路径示例和 grep→最多八个 TODO 命中→附近五行 read→文本 join 替换 glob 行数样本；非 text-page 不作字符串，明确采样并建议多行片段返回字符串。
必要性：R2 要展示依赖调用及正文筛选，并避免 JSON 转义换行。
不做会怎样：旧例仍只提供文件行数元数据；模型缺少真实内容组合示例。

生产者→消费者：共享 description 文本 → CodeMode.description → CodeModeTool 定义 → Session 模型工具说明
源码：packages/codemode/src/code-mode.txt:1-42
验证：packages/opencode/test/session/execute.test.ts：published composition example samples actual files。

### H002 · 提供环境的公共类型与工厂

路径：`packages/codemode/src/codemode.ts`；`@@ -1,11 +1,17 @@`

职责：让宿主持有、创建解释器环境，不暴露独立的宿主状态容器。
机制：导出 Environment 类型和 createEnvironment()；Environment 导入服务工厂，withRawText 导入归 H008 的文本投影使用。
必要性：宿主环境注册表需要稳定入口创建词法状态；来源投影也需要复用同一个元数据函数。
不做会怎样：缺少工厂就没有公共环境创建入口；单独删掉配套导入会留下未解析标识符。导入本身没有额外运行时策略。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:1-17
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H003 · 声明日志预算与目录优先级

路径：`packages/codemode/src/codemode.ts`；`@@ -14,12 +20,16 @@ export type ExecutionLimits = {`

职责：在公共选项中区分日志留存预算和目录展示优先级。
机制：ExecutionLimits 增加 maxLogBytes；DiscoveryOptions 增加由宿主提供的规范路径 priority。
必要性：日志追加限制不能由执行结束后的 maxOutputBytes 代替；原生核心工具优先级也不能靠库猜名字。
不做会怎样：调用者无法通过类型明确传入这两项需求；实际行为仍分别由 H045 和 H063 实现。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:20-35
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H004 · 声明复用与预跑环境选项

路径：`packages/codemode/src/codemode.ts`；`@@ -30,16 +40,25 @@ export type ResolvedExecutionLimits = {`

职责：把环境复用和独立预跑作为一次执行的显式选择。
机制：ResolvedExecutionLimits携带日志预算；ExecuteOptions增加复用/快照环境与宿主waitForTimeout能力。宿主计时器可排除人类等待，库仍拥有唯一根执行和期限竞争。 ExecuteOptions另提供本次sleep效果，探针可省略真实等待而不改变执行期限。
必要性：宿主需要选择旧词法状态、安全预跑和计时来源；不能在库里引入Session/审批概念，也不能在宿主再包第二套相互竞争的超时。
不做会怎样：缺少环境字段会失去Notebook状态或安全预跑；缺少计时能力入口，运行中question和审批仍会消耗固定预算。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:40-64
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H005 · 在成功结果中声明未观察失败

路径：`packages/codemode/src/codemode.ts`；`@@ -92,6 +111,8 @@ export const Success = Schema.Struct({`

职责：让脚本成功与异步子任务的失败事实同时表达。
机制：Success schema 增加可选 unobservedFailure，字段只在根清理后发现未观察失败时给出。
必要性：宿主需要一个真实结果字段决定是否附提醒，不能把所有 child error 都称作未处理。
不做会怎样：成功结果合同无法携带这项事实，宿主只能遗漏提醒或自行猜测。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:111-118
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H006 · 校验日志预算

路径：`packages/codemode/src/codemode.ts`；`@@ -123,17 +144,21 @@ const validateLimit = <Value extends number | undefined>(`

职责：让 maxLogBytes 与现有执行限额共用合法值检查。
机制：resolveExecutionLimits 调用 validateLimit，允许零预算，保留未设置为 undefined。 timeoutMs复用validateLimit的上限参数，限定到Effect真实支持的2147483647毫秒；其它限额仍保留安全整数范围。
必要性：日志限制需要在进入执行器前完成数值校验，零值也应保留。
不做会怎样：只声明字段而不解析，执行器拿不到已校验的日志预算，追加限额无法按请求工作。 超过32位的期限会因底层不注册timer而悄悄失去超时约束。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:144-164
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H007 · 把宿主优先级交给当前目录

路径：`packages/codemode/src/codemode.ts`；`@@ -152,7 +177,8 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`

职责：为每次创建的 CodeMode runtime 计算正确的内联工具选择。
机制：ToolRuntime.prepare 增收 options.discovery?.priority，仍以这次 tools 和预算构建目录。
必要性：优先级必须作用于当前可用工具，不能跨执行缓存旧能力。
不做会怎样：公共选项虽存在，目录仍按原规则选择；宿主标记的原生工具不会获得本次优先权。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:177-184
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H008 · 由现成 JSON schema 接收可投影文本

路径：`packages/codemode/src/codemode.ts`；`@@ -160,3 +186,19 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`

职责：提供宿主显式选择的无 schema 文本投影入口。
机制：Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json)) 解析并约束 JSON 数值；失败、null 和标量原样返回。容器仍过 ToolRuntime.copyIn 并登记原文；仅 InvalidDataValue 被转回原文，其他异常抛出。
必要性：复用 JSON 所有者和唯一安全复制边界，删除手写 reviver 与解析异常分类。
不做会怎样：删除整个投影将失去字段访问和原文恢复；仅恢复旧解析实现可维持原目标，但保留重复解析规则。

生产者→消费者：宿主 CodeMode.make 的目录需求→ToolRuntime.prepare；CodeMode.execute 的执行需求→ToolRuntime.searchIndex；二者经 resolveExecutionLimits→executeWithLimits；显式文本候选 → fromJsonText → 沙箱值
源码：packages/codemode/src/codemode.ts:186-204
验证：packages/codemode/test/codemode.test.ts：retained environments、JSON text results和execution limits；signature.test.ts：compact signatures。

### H009 · 保存两个词法根

路径：`packages/codemode/src/interpreter/model.ts`；`@@ -28,6 +28,19 @@ export type Binding = {`

职责：Environment 只持有内建根和用户绑定根。
机制：类内 roots 含 globals、bindings 两个 Map，解释器通过静态 scopes 取回同一组引用。
必要性：后续单元的闭包需要继续指向原 Binding；当前能力则在执行入口刷新 globals。
不做会怎样：每格重建词法根会丢失变量和闭包；若连旧执行器一起存下，则会保留上一轮权限与取消状态。

生产者→消费者：源码 AST/宿主 createEnvironment → Environment/CodeModeFunction/内建引用 → Interpreter 与跨格闭包
源码：packages/codemode/src/interpreter/model.ts:28-46
验证：packages/codemode/test/promise.test.ts：async function composition、retained chain methods；codemode.test.ts：retained environments。

### H010 · 保存函数的 async 身份

路径：`packages/codemode/src/interpreter/model.ts`；`@@ -45,6 +58,8 @@ export class CodeModeFunction {`

职责：让所有函数调用入口知道函数是否应返回 Promise。
机制：CodeModeFunction 构造器增加默认 false 的 async 字段，创建函数值时由 AST 填入。
必要性：普通调用和集合回调都要依据同一函数值作决定。
不做会怎样：async 与同步函数在值模型里无法区分，统一调用入口无法正确保持两种返回语义。

生产者→消费者：源码 AST/宿主 createEnvironment → Environment/CodeModeFunction/内建引用 → Interpreter 与跨格闭包
源码：packages/codemode/src/interpreter/model.ts:58-65
验证：packages/codemode/test/promise.test.ts：async function composition、retained chain methods；codemode.test.ts：retained environments。

### H011 · 为可持久化 sleep 别名提供身份

路径：`packages/codemode/src/interpreter/model.ts`；`@@ -86,7 +101,8 @@ export class GlobalNamespace {`

职责：把 sleep 表示成解释器识别的内建引用。
机制：GlobalMethodReference 的 namespace 增加私有 $builtin；引用只存名字，不捕获执行上下文。
必要性：保存到环境的 sleep 别名需要在调用时绑定当前根 Scope。
不做会怎样：若用捕获旧执行器的宿主回调保存别名，后续单元会关联旧取消状态；这里提供的身份由 H032/H033 调度。

生产者→消费者：源码 AST/宿主 createEnvironment → Environment/CodeModeFunction/内建引用 → Interpreter 与跨格闭包
源码：packages/codemode/src/interpreter/model.ts:101-108
验证：packages/codemode/test/promise.test.ts：async function composition、retained chain methods；codemode.test.ts：retained environments。

### H012 · 同步可调用语法诊断

路径：`packages/codemode/src/interpreter/model.ts`；`@@ -121,8 +137,9 @@ export type DiagnosticKind =`

职责：共享诊断文案准确描述解释器已实现的语言面。
机制：把then/catch禁用提示改为共享callback及返回Promise采用语义，其余能力清单不变。
必要性：模型应按真实可用API修复调用，不能被旧错误说明诱导改写本来合法的链式调用。
不做会怎样：普通语法错误会附带错误的Promise限制，造成不必要的重试。

生产者→消费者：源码 AST/宿主 createEnvironment → Environment/CodeModeFunction/内建引用 → Interpreter 与跨格闭包
源码：packages/codemode/src/interpreter/model.ts:137-145
验证：packages/codemode/test/promise.test.ts：async function composition、retained chain methods；codemode.test.ts：retained environments。

### H013 · 接入唯一执行根 Scope

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1,5 +1,5 @@`

职责：给根生命周期提供依赖。
机制：Effect import 以 Scope 替换 Semaphore；原文元数据导入实际位于 H016，不在本 hunk。
必要性：实际宿主许可已移到 ToolRuntime；解释器根 Scope 负责所有生产者清理。
不做会怎样：单删配套导入使根 Scope 使用处缺少符号；注释不独立改变行为。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1-5
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H014 · 接入词法环境类型

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -25,6 +25,7 @@ import {`

职责：为解释器构造和快照使用共用 Environment 模型。
机制：从 model 导入 Environment。
必要性：解释器构造、环境复制和执行入口需要引用 H009 的同一个 Environment，避免各自声明不同状态结构。
不做会怎样：没有独立运行时修改；单独去掉导入会使这些环境实现无法解析该类型和值。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:25-31
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H015 · 移除解释器并发常量依赖

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -67,7 +68,7 @@ import {`

职责：让解释器只导入 Promise 方法集合。
机制：promiseStatics 导入保留，TOOL_CALL_CONCURRENCY 导入移到 ToolRuntime。
必要性：并发入口归 H066/H069，Promise 观察和 async 函数不占工具许可。
不做会怎样：仅保留一个不用的 import 不会改变执行行为；实际并发差异来自许可入口迁移。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:68-74
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H016 · 接入沙箱值的原文来源

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -105,6 +106,8 @@ import {`

职责：解释器从沙箱值的共同元数据入口读取和保存原文。
机制：rawText和withRawText随其他值类型从values导入；该弱引用来源同copyIn/copyOut及String转换共用。
必要性：环境快照与HTTP文本投影必须保存同一原文，不应在解释器再维护一份字典。
不做会怎样：去掉接线后，预跑副本或响应对象会丢失原文；独立重复字典则无法随同一个业务值保持身份。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:106-113
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H017 · 查找纯解析缓存并保存包装前缀

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -112,8 +115,14 @@ import {`

职责：parseProgram 拥有纯编译结果复用及原始诊断定位。
机制：模块私有 Map 以精确源码查询 ProgramNode；未命中继续原 transpile，并显式保存 wrapper prefix。
必要性：R5 避免同源码重复预跑/执行的纯编译；prefix 支持后续诊断位置映射。
不做会怎样：仅删除缓存仍可执行但重复编译；删除 prefix 配套变更使后续位置映射失去真实包装边界。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:115-128
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H018 · 在解析诊断中标出可靠的源码位置

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -123,8 +132,17 @@ const parseProgram = (code: string): ProgramNode => {`

职责：解析入口负责把TypeScript原始诊断映射回用户脚本。
机制：保留包装前缀长度，只在diagnostic.start落入用户源码半开区间时取原SourceFile位置，扣掉包装行并按UTF-16列号显示。
必要性：生成JS的AST位置不能当作原始TS位置；已有parse diagnostic已有准确来源，不需要增加sourcemap。
不做会怎样：常见缺表达式错误仍没有可定位的源码行列；若不排除wrapper/EOF，可能给出误导位置。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:132-148
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H019 · 仅缓存成功解析并限定八项

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -145,6 +163,10 @@ const parseProgram = (code: string): ProgramNode => {`

职责：成功解析出口限制缓存寿命与数量。
机制：Program 形状确认后，满八项删除最旧插入项，再登记本次源码及 AST。命中不刷新顺序，属于 FIFO 而非 LRU。
必要性：R5 同时容纳用户源码和 fetch 工厂，不保存失败、工具或环境。
不做会怎样：无登记则查询无收益；无淘汰则跨执行累计保留任意多个源文本和 AST。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:163-172
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H020 · 复制一次预跑环境

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -241,6 +263,64 @@ const isRuntimeReference = (value: unknown): boolean =>`

职责：让探针读取旧变量、闭包和对象关系，同时隔离它造成的修改。
机制：snapshotEnvironment 只有一个 copy 和身份 memo。Map 键值、Set 成员递归复制，普通实例保留原型并按自身数据描述符复制；目标先入 memo，保留循环和别名。RegExp 重建 source/flags，再复制自身字段；共同出口转交原文 WeakMap 元数据。遇到宿主函数或访问器就终止本次预跑。 注释说明沙箱函数是可复制的 AST/作用域对象，并区分不可重建的原生函数。
必要性：闭包捕获的 Map/Binding 与容器数据须在同一复制关系里重绑；描述符复制避免调用 getter，并保留非枚举错误品牌和 text。一个通用 copy 核心从整个环境根递归，身份 memo 同时保留别名和循环。
不做会怎样：旧空环境探针看不到保存的 helper；直接使用真实环境则会提前改变私有计数和对象。复制失败只使本次探针停止，已收集调用及真实权限检查仍由宿主继续处理。
R24 更新：URL/URLSearchParams 不再拒绝。先复制 SandboxURLSearchParams.owner，native URL 分支同时登记 URL 与其 searchParams；独立 params 单独构造并共用 memo。宿主函数/访问器仍拒绝。必要性是 R7 的反序别名、保存的方法和原环境隔离；删除会恢复 URL 探针失败或割裂绑定。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:263-326
验证：packages/codemode/test/codemode.test.ts：retained environments、URL preview；promise.test.ts：当前工具和RegExp状态；解析复用另作隔离计量。

### H021 · 分开执行共享状态与函数局部栈

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -599,36 +691,43 @@ const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<s`

职责：建立一次执行共有的工具、日志、根 Scope 和 Promise 清单，同时保留每个 Interpreter 的局部词法栈。
机制：新增 Execution；Interpreter.make 从 Environment 取得两个根，清空并重新播种 globals，直接接收本次 Execution，sleep 存为 builtin 引用；declared 只记录本格顶层声明。 本次sleep效果也保存在Execution，缺省由调用处提供Effect.sleep，探针可单独跳过等待；旧别名不会捕获上一轮计时策略。
必要性：并发函数共享能力和外层 Binding，但不能互相替换参数与局部作用域。globals 复用原 Map 才能刷新旧闭包看到的能力。
不做会怎样：沿用单实例 scopes 切换会让交错 async 回调串用局部状态；重建或保留旧 globals 又会分别破坏闭包引用或沿用旧能力。
R24 更新：Interpreter.make 直接接收已构造的 Execution，而非散列能力参数后再拼对象；缺省 sleep 在 executeWithLimits 调用处决定。删掉这项合并不会必然改变行为，但恢复一层纯转发。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:691-733
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H022 · 在当前执行绑定 fetch 响应和用户根

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -669,16 +768,20 @@ class Interpreter<R> {`

职责：让 fetch 响应方法与普通函数共用本次能力，并保留用户顶层状态。
机制：响应工厂放入 execution.fetchResponse；make 返回以 globals、roots.bindings 为栈的 Interpreter。run 不再临时 push 一个执行结束即丢弃的用户根。
必要性：fetch 可见性和响应方法必须属于本次执行；用户变量则需跨格保留。
不做会怎样：旧临时 module scope 会丢失顶层状态，旧实例字段也不适合并发函数共享。工厂表达式恢复基线紧凑排版，不增加功能。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:768-787
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H023 · 统一 Promise 生产、观察和根清理归属

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -707,71 +810,61 @@ class Interpreter<R> {`

职责：工具、async 函数与组合器都通过同一创建入口登记到根 Scope，观察者只读结果。
机制：createToolCallPromise 复用 execution.invokeTool；createPromise 用 startImmediately 的 forkIn，并将 fork 和 trackPromise 放入不可中断区。observePromise 等到 Exit 到达才标 observed；settlePromise flatten Exit。删去 pendingSettlements、局部许可和 raceInterrupted 特判，run 也不再自行清理一份 pending 集合。 trackPromise 也登记只有 Exit 的即时拒绝，供根收尾判断其是否未观察。 当前执行保存宿主sleep能力，默认Effect.sleep；保留的别名仍在当前根创建Promise。 settlePromise同时接纳普通值与SandboxPromise，await、async返回值和链式handler共用采用规则。
必要性：同步启动时立刻收到取消，也必须先完成根登记；取消一次 await 或 race 观察不能取消共享生产者。清理只由根 Scope 拥有。
不做会怎样：旧登记窗口可让 Execute 在真实 finalizer 完成前返回；旧 pending 集合和 race 特判会把观察取消与生产者寿命混在一起。遗漏 observed 的时机调整还会吞掉取消等待之后的未观察失败。
R24 更新：observePromise 接收 unknown，普通值直接变成功 Exit；settlePromise、allSettled 与 race 统一复用，删除重复 instanceof 分支。未改变根生产者与观察者职责。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:810-870
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H024 · 把 AST async 标志写入函数值

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -857,6 +950,8 @@ class Interpreter<R> {`

职责：把声明和表达式中的 async 身份交给共用调用入口。
机制：makeFunction 构造 CodeModeFunction 时传 node.async === true。
必要性：H010 的字段需要真实语法来源，所有调用者才能使用 H036 的 Promise 分支。
不做会怎样：字段保持默认 false 时，源码写了 async 的函数仍按同步函数运行。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:950-957
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H025 · 开放已有容器的 for-await 入口

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1065,11 +1160,8 @@ class Interpreter<R> {`

职责：允许 for await...of 继续进入现有迭代代码。
机制：删除入口处一概抛出的 unsupported 错误；具体 next、产值等待和退出顺序由 H026/H027 处理。
必要性：现有 Array/string/Map/Set 迭代入口可复用，无需新增独立异步迭代协议。
不做会怎样：入口仍会在读取已有容器前拒绝 for-await，后续实现无法触达。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1160-1167
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H026 · 按异步顺序取值并清理循环绑定

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1100,15 +1192,26 @@ class Interpreter<R> {`

职责：在已有同步容器上实现 for-await 的 next、值结算和异常收尾。
机制：手动取得 iterator；每次 next（包括 done）先 yieldNow；仅对产出的 SandboxPromise settle。声明绑定和循环体放进同一 ensuring，异常路径对 for-await 再让出一次，最后释放循环帧。
必要性：普通值与空迭代也有异步观察顺序，解构默认值失败也必须释放已创建的迭代作用域。
不做会怎样：只等待 Promise 项会漏掉普通值和终止时的调度边界；绑定发生在 ensuring 外则可能留下失败迭代帧。Map 产出的键值数组不递归等待。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1192-1217
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H027 · 补齐 for-await 的 break/return 顺序

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1116,6 +1219,8 @@ class Interpreter<R> {`

职责：让正常提前退出也经过异步关闭的让出点。
机制：在处理 return/break 的 StatementResult 前，仅对 await 循环 yieldNow。
必要性：H026 的异常分支之外，还要覆盖 break 和 return。支持的容器没有自定义 return 方法，此处保持它们的关闭调度边界。
不做会怎样：提前退出会少一次异步让出，后续语句与调用者的先后顺序偏离该循环语义；普通 for-of 保持原顺序。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1219-1226
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H028 · 从执行共享状态枚举工具

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1144,7 +1249,8 @@ class Interpreter<R> {`

职责：让各函数帧看到同一份当前工具目录。
机制：enumerableKeys 的 ToolReference 分支改用 this.execution.toolKeys。
必要性：配合 H021 的局部帧拆分，工具能力仍由同一个宿主入口决定。
不做会怎样：旧实例字段已移除，保留旧访问会让工具枚举引用不存在的字段；这里沿共享 Execution 读取目录，枚举规则保持原样。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1249-1256
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H029 · 让 await 普通值也交出执行机会

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1447,11 +1553,13 @@ class Interpreter<R> {`

职责：保持 async 函数首次 await 后的调度顺序。
机制：先求参数表达式，再 yieldNow，之后结算 SandboxPromise 或返回普通值。
必要性：await 1 和 await 已结算 Promise 也应让调用者继续同步语句。
不做会怎样：直接透传普通值会让 async 后半段抢先运行；只有工具挂起的场景无法覆盖这个顺序问题。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:1553-1565
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H030 · 只求值一次被调用成员

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1897,7 +2005,12 @@ class Interpreter<R> {`

职责：为调用诊断保留 receiver 和 computed key 的首次求值结果。
机制：MemberExpression 先调用 getMemberReference，再把同一 reference 作为 Effect.succeed 传给 readMember；其他 callee 仍走 evaluateExpression，可选链短路位置保留。
必要性：H033 需要知道接收者形状，但诊断不得再次执行带副作用的表达式。
不做会怎样：若只在报错时重新求值 receiver/key，会制造额外副作用；若不保留引用，则无法准确说明是哪个接收者不可调用。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2005-2016
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H031 · 把同步 search 接到当前执行

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1907,7 +2020,7 @@ class Interpreter<R> {`

职责：维持 search 的同步值返回，同时使用共享调用入口。
机制：ToolReference 的 $codemode.search 分支改为 execution.invokeTool；其他工具仍创建 Promise。
必要性：函数局部帧拆分后，search 仍要经过同一执行的验证、计数和 hooks，保持同步发现结果。
不做会怎样：使用移除的实例字段会断开调用；把 search 改成普通异步工具则会改变现有发现用法。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2020-2026
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H032 · 把 builtin 别名分发到当前 sleep

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1921,6 +2034,8 @@ class Interpreter<R> {`

职责：允许直接调用和跨格别名调用进入本次计时器创建入口。
机制：GlobalMethodReference 的 $builtin 分支调用 invokeSleep，console/Object 等分支保留。
必要性：身份引用本身不携带旧执行器，调用时才能关联当前 Scope。
不做会怎样：存下的 sleep 引用没有执行分支，或被误当成其他全局方法；实际参数和计时规则由 H033 负责。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2034-2041
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H033 · 提供形状诊断和受根管理的 sleep

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -291,6 +371,18 @@ const typeofValue = (value: unknown): string => {`；`packages/codemode/src/interpreter/runtime.ts`；`@@ -1937,10 +2052,25 @@ class Interpreter<R> {`

职责：本条覆盖两个物理hunk：有界形状owner及原不可调用出口，并保留同一修改段中的根管理sleep。
机制：一次receiver资格同时形成value与label；describeValueShape以early return完成同一value的互斥分类，保留8键/64单位及不读取业务值。原错误直接消费shape，不再重复type/keys/shape选择，原callee入口不变。sleep仍在既有能力入口校验number与计时范围，用execution.sleep创建受根Scope管理的Promise，不另开计时器。
必要性：错误应说明对象形状而非笼统声称只有工具可调用；脚本等待要用已有可取消计时器并绑定当前执行。
不做会怎样：对象误用 map 仍只能得到误导提示；没有 sleep 分支则无法等待。字符串、负数、无限值和超范围计时不能靠隐式转换进入 Effect timer。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:371-388；packages/codemode/src/interpreter/runtime.ts:2052-2076
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H034 · 让所有函数帧写同一个日志出口

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -1959,7 +2089,8 @@ class Interpreter<R> {`

职责：收集并限制整段执行的日志，而非每帧各存一份。
机制：invokeConsole 保留方法白名单和原格式化流程，改调用 execution.log。
必要性：H045 的 UTF-8 留存预算必须覆盖并发函数和集合回调产生的全部日志。
不做会怎样：直接写局部 logs 会绕过共同预算或遗漏子函数日志。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2089-2096
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H035 · 让组合器返回 Promise，并隔离函数局部帧

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2102,11 +2233,7 @@ class Interpreter<R> {`；`packages/codemode/src/interpreter/runtime.ts`；`@@ -2118,109 +2245,59 @@ class Interpreter<R> {`

职责：修正 all/allSettled/race 的观察语义，以及 async 函数的调用和返回语义。
机制：all与allSettled共用Effect.forEach并发/保序遍历，只在每个item的结算策略处区分；原Effect.all本就调用同一forEach引擎，race保留独立首结算路径。resolve/reject 登记即时 Exit；其他组合器由 createPromise 启动。all 并发观察且结果保序，allSettled 并发收集普通拒绝并传播纯中断，race 竞争观察结果而不取消生产者，空 race 为 Effect.never。invokeFunction 新建局部 Interpreter 和参数 Map，共享 capturedScopes；async 的参数绑定、函数体及返回 Promise 采用均放在根生产者中。 函数保留原Effect.suspend延迟层次，在每次运行内分配独立帧；参数/body缩进沿共同基线，async返回值通过共享settlePromise。
必要性：后一项失败或中断不能被前项挂起遮蔽，组合器要能嵌套；多个 async 回调的局部参数要隔离，而闭包外层 Binding 保持共享。
不做会怎样：顺序观察会遮住后项失败；取消 race 败方会破坏后续 await；沿用一个可变 scopes 栈会串扰局部变量；在 Promise 外绑定默认参数会把 async 默认值错误变成同步抛出。
R24 更新：allSettled/race 直接调用接纳普通值的 observePromise；不再各自构造普通值 Exit。race 的 flatten/raceAll/map 恢复为一个短表达式。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2233-2239；packages/codemode/src/interpreter/runtime.ts:2245-2303
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H036 · 让组合器返回 Promise，并隔离函数局部帧

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2246,13 +2323,9 @@ class Interpreter<R> {`

职责：修正 all/allSettled/race 的观察语义，以及 async 函数的调用和返回语义。
机制：resolve/reject 登记即时 Exit；其他组合器由 createPromise 启动。all 并发观察且结果保序，allSettled 并发收集普通拒绝并传播纯中断，race 竞争观察结果而不取消生产者，空 race 为 Effect.never。invokeFunction 新建局部 Interpreter 和参数 Map，共享 capturedScopes；async 的参数绑定、函数体及返回 Promise 采用均放在根生产者中。
必要性：后一项失败或中断不能被前项挂起遮蔽，组合器要能嵌套；多个 async 回调的局部参数要隔离，而闭包外层 Binding 保持共享。
不做会怎样：顺序观察会遮住后项失败；取消 race 败方会破坏后续 await；沿用一个可变 scopes 栈会串扰局部变量；在 Promise 外绑定默认参数会把 async 默认值错误变成同步抛出。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2323-2331
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H037 · 共用回调入口处理then、catch和finally

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2261,6 +2334,39 @@ class Interpreter<R> {`

职责：方法调用入口负责观察源、调用handler和采用返回终态，新Promise仍属于唯一根Scope。
机制：先observe源Exit，再yield延迟handler；纯宿主中断穿透。then/catch按源状态选handler，finally无参数执行后恢复源Exit；回调失败覆盖原终态。非函数透传，所有可调用handler复用applyCollectionCallback，返回Promise交settlePromise，自返回循环转TypeError。
必要性：自然链式调用和清理应复用现有Promise及回调模型。观察与让出先后必须清楚区分源已结算和新链尚未完成。
不做会怎样：旧then/catch在让出时源尚未记为已观察；finally仍不支持。若清理未等待就恢复原值，会丢掉异步清理失败；若吞宿主中断，取消可被伪装成功。未等待的新链被根取消仍保留未完成提醒。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2334-2372
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H038 · 为 async replacer 绑定当前解释器

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2303,6 +2409,8 @@ class Interpreter<R> {`

职责：为字符串替换中等待 async 回调的结果提供调用上下文。
机制：在现有替换方法内保存 const self = this，供 H039 的生成器使用。
必要性：H039 的生成器需借 self 访问当前解释器，settlePromise 才能沿本次执行的 Promise 观察路径等待回调。
不做会怎样：单独删掉 self 会使后续结算无法引用解释器；本 hunk 本身没有新增替换规则。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2409-2416
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H039 · 保留 String.replace 的 async 扩展

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2346,9 +2454,15 @@ class Interpreter<R> {`

职责：在明确 async 的替换回调中等待返回 Promise，再按原规则转为替换字符串。
机制：先执行 apply；只有 CodeModeFunction.async 且结果为 SandboxPromise 才 settle，随后仍经过 boundedData 和 coerceToString。匹配位置、捕获组与拼接流程不变。
必要性：H036 让 async 函数真实返回 Promise 后，原字符串替换扩展需要在自己的方法边界结算它。
不做会怎样：已支持的 async replacer 会落入数据边界报错；若对全部回调自动 await，又会改变同步回调返回 Promise 的既有检查。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2454-2468
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H040 · 在共用集合回调入口接纳 sleep

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2367,16 +2481,20 @@ class Interpreter<R> {`

职责：让 sleep 可作为数组、Map/Set 等既有回调入口的内建函数。
机制：白名单仅额外允许 $builtin.sleep，并分发到 invokeSleep；CodeModeFunction、CoercionFunction、UriFunction 保留原路径。
必要性：sleep 已表示成身份引用，集合方法需要显式识别该引用，不能把全部全局方法一并放行。
不做会怎样：map(sleep) 等用法会被当作非函数拒绝；扩大到全部全局方法则会超出当前回调白名单。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2481-2500
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H041 · 数组复用已有集合回调入口

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -2642,24 +2760,8 @@ class Interpreter<R> {`

职责：删除数组方法单独维护的回调分类分发。
机制：使用 applyCollectionCallback(args[0], Array 方法名, node)，后续数组快照迭代不变。
必要性：H040 的 sleep 支持及函数调用语义应在各集合方法一致。
不做会怎样：保留重复入口会让数组继续遗漏 sleep；除此之外，这段删除主要减少同一白名单的重复实现。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:2760-2767
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H042 · 把链式成员绑定到现有方法引用

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3066,18 +3168,9 @@ class Interpreter<R> {`

职责：成员读取只解析调用目标，不启动另一套执行器。
机制：then、catch、finally统一返回绑定当前SandboxPromise的IntrinsicReference；删除finally专属拒绝分支。未await结果的普通属性继续给出原诊断。
必要性：三种方法必须从同一个成员读取出口进入共同回调处理；副本也要保留receiver的对象身份。
不做会怎样：只改invokeIntrinsic而不开放成员读取，finally仍在调用前失败；另造方法值则需再接一套快照与调用分发。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3168-3176
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H043 · 让成员读取接收已求值引用

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3124,8 +3217,9 @@ class Interpreter<R> {`

职责：共用原访问规则，避免调用场景重复解析成员。
机制：readMember 增加默认值为 getMemberReference(node) 的 resolved 参数；普通读取按默认路径，调用入口传已有 reference。
必要性：H030 的一次求值结果需要穿过原有可选链、ComputedValue 和访问控制分支。
不做会怎样：只在调用处保存引用却不改 readMember，仍会再次计算 receiver/key，或被迫复制一套访问规则。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3217-3225
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H044 · 只放宽跨格顶层重声明

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3259,10 +3353,13 @@ class Interpreter<R> {`

职责：允许 Notebook 重跑定义，同时保留本格与函数局部的重复声明检查。
机制：比较当前 scope 与 moduleScope；本格 declared Set 记录已声明名称，已有参数 TDZ 槽仍按原规则初始化。
必要性：用户需要在后续单元重新声明顶层变量，函数参数和局部作用域语义不能一起放宽。
不做会怎样：复用环境后，旧顶层名称会全部报重复；若直接取消重复检查，同格重复和函数局部错误也会被放过。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3353-3365
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H045 · 在追加时限制共享日志留存

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3356,7 +3453,26 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`

职责：控制循环及并发函数累计保存的日志内存，并在各结果出口说明省略。
机制：log 以 UTF-8 字节加换行计费；首次超预算后只增加 droppedLogs，logged() 追加省略行数标记并设置 truncated。未设置 maxLogBytes 时保留既有无限额行为。
必要性：执行结束后的结果裁剪无法限制执行期间日志持续累积；所有帧必须共享这个累计值。
不做会怎样：长循环仍可持续占用日志内存；没有统一 logged() 标记，成功或失败输出无法说明日志已省略。单行格式化仍先产生该行字符串，此处限制的是留存。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3453-3478
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H046 · 在根结束后交付结果与安全 Promise 终态

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3367,30 +3483,79 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`

职责：把快照选择、根 Scope 清理和未观察失败回执接到公共执行路径。
机制：根Scope收尾后，仍在途的Fiber只在原主路径中等待并安全归档；未观察事实直接读唯一state.exit，不再重复选择Fiber/即时Exit。operation 先 yieldNow，让外层 timeout/race 完成登记，再选择环境副本、解析和启动脚本。scopedWith 包住 Interpreter.run；Scope关闭后仅对仍携带Fiber的Promise等待并安全归档，再从state.exit判断未观察失败；即时Exit不转换。纯中断变成供后续单元观察的明确错误，普通拒绝保留沙箱抛值；成功结果附 unobservedFailure，再按原 copyIn/copyOut 交付业务值。 waitForTimeout或原Effect.sleep只负责选出到期；race先等待根清理，再构造超时回执。sleep capability独立传给本次Interpreter，不改变根期限。
必要性：执行起点先给外层观察者完成登记的机会，同时保留子生产者 startImmediately 和原子登记；宿主得到结果前必须等真实清理，Notebook 中保存的 Promise 也不能保活旧 Fiber、私有 cause 和权限上下文。
不做会怎样：脚本同步触发宿主取消时，外层观察可能尚未登记，完成/取消顺序会失真；缺少根收尾和终态替换还会让未结束工作越过执行边界、跨格 Promise 保留旧上下文，或在成功结果中遗漏未观察失败。
R24 更新：执行入口就地构造 Execution 对象传给 Interpreter.make，sleep: options.sleep ?? Effect.sleep；不缓存能力或环境。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3483-3561
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H047 · 裁剪结果时保留附加事实

路径：`packages/codemode/src/interpreter/runtime.ts`；`@@ -3462,7 +3627,6 @@ const boundOutput = (result: Result, maxOutputBytes: number): Result => {`

职责：使既有 maxOutputBytes 结果重建保留 unobservedFailure 等已有字段。
机制：成功和失败分支先展开原 result，再覆盖 value、保留下来的 logs 和 truncated。
必要性：结果预算只应改变被裁剪部分，不应删除本次执行已经确认的事实。
不做会怎样：旧手写字段重建会漏掉新增的未观察失败字段。此处没有新增 JSON 预览或改变业务类型的宿主截断器。

生产者→消费者：CodeMode.execute 的源码、当前能力和环境 → parseProgram/Interpreter/根 Scope → Result 与终态 Promise
源码：packages/codemode/src/interpreter/runtime.ts:3627-3632
验证：packages/codemode/test/promise.test.ts：async function composition、composable promise combinators、promise chaining、async standard-library callbacks and iteration；codemode.test.ts：limits与retained environments。

### H048 · 字符串转换优先读取登记原文

路径：`packages/codemode/src/stdlib/value.ts`；`@@ -28,6 +28,9 @@ export const errorBrandName = (value: unknown): string | undefined =>`

职责：让投影后的对象或数组在 String 和模板字符串中保留原 JSON 文本。
机制：coerceToString 先查 rawText；没有来源时继续原 null、undefined、日期和普通值转换。
必要性：脚本可以组合业务字段，也可以取得协议原文，两种用途共用同一内部值。
不做会怎样：投影对象会变成普通对象字符串，原文中的空白与格式丢失；普通对象的转换规则无需因此变化。

生产者→消费者：登记原文的内部值 → coerceToString → String/模板字符串结果
源码：packages/codemode/src/stdlib/value.ts:28-36
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H049 · 接入字符串转换的来源查询

路径：`packages/codemode/src/stdlib/value.ts`；`@@ -77,6 +80,7 @@ import { type AstNode, CoercionFunction, InterpreterRuntimeError } from "../inte`

职责：给 H048 提供 rawText 函数。
机制：从已有values模块导入rawText，与Promise值和业务对象来源共用同一所有者；既有copyIn转换入口不变。
必要性：与 H048 属于同一原文转换修改。
不做会怎样：本 hunk 不独立改变行为；去掉导入会使原文查询缺少符号，注释本身不影响结果。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：登记原文的内部值 → coerceToString → String/模板字符串结果
源码：packages/codemode/src/stdlib/value.ts:80-86
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H050 · 接入宿主许可依赖

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -1,4 +1,5 @@`

职责：ToolRuntime 拥有实际工具并发入口。
机制：导入 TOOL_CALL_CONCURRENCY 和 Semaphore。normalizeInput/rawText/withRawText 在 H051 接入。
必要性：本次 runtime 建立唯一宿主许可池，解释器 Promise 观察不占许可。
不做会怎样：许可实现缺少符号；导入本身不独立新增调度政策。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:1-5
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H051 · 接入参数简写与原文元数据

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -7,10 +8,13 @@ import {`

职责：真实工具数据边界使用合同派生简写与共同原文所有者。
机制：新增 normalizeInput、rawText、withRawText 导入；当前候选没有导入 isSandboxValue。
必要性：分别支持 H066 的单次解码以及 H054/H055/H066 的来源传递。
不做会怎样：相关调用缺少符号。历史 H051/H054 的公共品牌 helper 替换已撤回，不能沿用那项理由。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:8-20
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H052 · 限定 namespace 错误提示长度

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -96,9 +100,13 @@ export type SafeObject = Record<string, unknown>`

职责：为 namespace 误调用中的补充签名设置独立展示预算。
机制：新增 namespaceSignatureBudget = 2000，H065 按完整签名累计字符。 SearchInput增加可选detail:true，使模型明确选择少量完整合同；省略时返回概览。
必要性：大 namespace 的一次错误不能输出整份目录。
不做会怎样：H065 没有明确的提示长度上限，或只能截断半条签名。该预算不删除工具能力。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:100-112
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H053 · 声明 search 详情与逐侧不可表示标记

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -108,6 +116,10 @@ const SearchItem = Schema.Struct({`

职责：让搜索结果合同表达输入详情、可选输出详情和 schema 发射失败。
机制：SearchItem的inputSchema和outputSchema只在详细视图出现，schemaUnavailable按失败侧标记；基本路径、说明和签名始终保留。
必要性：合法 Effect 合同也可能无法发射 JSON Schema，搜索需要表达哪一侧缺失而保留其他信息。
不做会怎样：若详情仍是必填，默认紧凑结果无法满足自己的返回合同；若删除字段定义，详细搜索又无法准确声明完整元数据。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:116-125
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H054 · 数组副本继承原文来源

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -286,7 +298,8 @@ const copyBounded = (`

职责：在 copyIn 的数组分支保留明确登记的文本来源。
机制：递归复制元素并释放 seen 后，用 withRawText(copied, rawText(value), true) 返回内部副本。
必要性：JSON 数组与对象同样需要 String/模板和 text 兼容。
不做会怎样：数组一旦过内部复制就丢失原文。map/spread 创建的新根没有原来源，仍按普通数组处理。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:298-305
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H055 · 对象副本继承原文来源

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -302,7 +315,8 @@ const copyBounded = (`

职责：在业务字段复制完成后为内部对象转交原文并按条件提供 text 别名。
机制：返回值改为 withRawText(copied, rawText(value), true)；copyOut 继续只遍历业务可枚举字段。
必要性：原文别名应在输出验证后的内部副本出现，并让同名业务字段优先。
不做会怎样：内部复制会丢掉来源；若把别名变成可枚举字段，则会改变最终 JSON 和键遍历。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:315-322
验证：packages/codemode/test/codemode.test.ts：JSON text results；signature.test.ts：输入/输出schema详情。

### H056 · 统一工具的紧凑具名签名

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -338,12 +352,13 @@ const definitions = <R>(`

职责：为 catalog、instructions、search 和 namespace 提示生成同一签名。
机制：describeDefinition 只用无 pretty 参数的输入/输出 renderer，非空输入写为 input: 类型，空对象保留零参展示。
必要性：模型需要稳定的真实参数与返回类型概览；字段详情转到按需 search schema。
不做会怎样：各出口会继续展示多行签名或不同形状，减少同预算可展示工具数。未声明输出仍由 renderer 返回 unknown。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:352-364
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H057 · 让搜索索引保存原合同引用

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -365,6 +380,9 @@ export type DiscoveryPlan = {`

职责：为命中后按需发射完整 schema 留下真实输入和输出来源。
机制：SearchEntry 增加 inputContract、outputContract，而 ToolDescription 仍只保存路径、说明和签名。
必要性：详情应仅为搜索命中的条目生成，不预先扩充整个内联目录。
不做会怎样：搜索只剩文字摘要，无法从真实合同恢复字段说明、约束与引用。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:380-388
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H058 · 补齐内建 search 的输入合同

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -420,6 +438,7 @@ const rank = (entries: ReadonlyArray<SearchEntry>, query: string): Array<SearchE`

职责：让 search 自身也满足新的 Definition 结构。
机制：makeSearchTool 以同一个 SearchInput 同时填写 inputContract 和 input，run 仍为内存索引上的 Effect.sync。
必要性：签名和实际解码同源规则也适用于全局 search。
不做会怎样：Definition 接口和 renderer 缺少 search 的真实输入来源；这条修改不使 search 占用工具许可。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:438-444
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H059 · 按需生成搜索详情并按完整条目分页；把定义合同放入完整搜索索引

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -445,32 +464,74 @@ const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition =>`

职责：保留原相关性排序和 offset/limit 接口，补齐真实 schema 详情及16K软预算。
机制：复用现有排名、精确匹配、offset/next和16K完整条目预算。默认至多十项，detail:true至多三项，只有详细命中项发射encoded输入和decoded输出schema，各侧发射失败用null及schemaUnavailable说明。 精确路径自动返回详情；宽泛limit:1不改变视图，显式detail:true才展开少量候选。
必要性：默认发现不应把候选的全部schema广播进上下文；确定工具后仍须取得准确字段文档。条数与完整条目软预算共同限制输出而不丢工具。
不做会怎样：保留默认全schema会继续产生不必要大输出；删详情则复杂参数/default/format不可发现；没有逐侧异常边界，一项不可表示合同会拖垮整页。

职责：构建索引时传递真实合同，保持字段搜索文本原来源。
机制：toSearchEntry 复制 definition.inputContract 和 definition.output 的引用，原 pathWords/searchText 构建继续。
必要性：H058 只定义结构，H060 需要在每个实际索引项上取得合同。
不做会怎样：详情发射拿不到每个工具的原来源；若改拿 ToolDescription，则只能恢复已压缩的字符串。
R24 更新（R1）：本 hunk 合并历史 H060/H061，且 summary 与 catalogLine 同属此处。非详情 description 使用首行 trim 后最多 120 单位摘要（超长为 117 + ...）；精确路径即使 detail:false 仍给完整 description 与 schema，全文索引不改。删此更新会让宽泛搜索继续广播长手册。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:464-537
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H060 · 目录选择只接收宿主优先级

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -493,18 +554,12 @@ export const assertValidTools = <R>(tools: HostTools<R>): void => {`

职责：prepare 接受当前目录的 priority 并保留预算合法值检查。机制：删去旧 round-robin 长说明，增加第三个参数；描述列表恢复直接从 visibleDefinitions 取得。必要性：展示偏好不应通过构造 SearchEntry 再取 description 的往返实现。不做会怎样：删除 priority 会失去原生工具优先展示；恢复往返构造只增加冗余，不增强能力。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:554-565
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H061 · 明确零预算标题保持可见

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -512,6 +567,7 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`

职责：解释 namespace 标题与签名预算的区别。机制：在原 described 分组循环前增加一行注释，循环逻辑与基线相同。必要性：维护者应保留零预算下未展示工具数量。不做会怎样：删除注释不改变运行行为；不能将本 hunk 宣称为新索引算法。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:567-573
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H062 · 按优先路径和签名长度选择内联项

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -520,64 +576,48 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`

职责：在预算内优先展示宿主确认的核心工具，并让余下选择稳定。
机制：priority 变 Set；按是否优先、signature.length、完整路径排序。先扣 namespace 标题成本，再逐项尝试，超长项跳过；最后按 namespace 输出已选项及准确 shown 计数。 完整 catalog 与搜索能力仍保留；重复的 picked 注释已删除。
必要性：同样预算可先放常用入口，同时让未展示数量明确，过长一项不阻塞后项。
不做会怎样：原 round-robin 规则不会应用宿主核心优先级，也保留旧的选项分组结构。极小预算仍可能放不下优先工具，此实现不保证核心项必显。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:576-623
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H063 · 说明完整索引不随展示裁剪

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -585,6 +625,7 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`

职责：说明 prepare 返回的 searchIndex 保留全量可见工具。机制：原 visible.map(toSearchEntry) 保持，新增解释性注释；R25 的先建 index 再反取 description 已撤回。必要性：搜索能力与目录展示分离。不做会怎样：删注释不改变代码；若错误地改从 picked 构建索引才会丢失未展示工具。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:625-631
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H064 · 在 namespace 误调用时提供真实签名

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -638,7 +679,23 @@ const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>, index: Rea`

职责：给错误调用提供可恢复信息，同时保持 UnknownTool 失败。
机制：筛选当前 namespace 前缀下索引项，按2000字符预算加入整条签名；遗漏项给数量和 search 指引，绝不自动选择 leaf 执行。
必要性：模型把一组工具当函数调用时，需要知道实际可调用路径；恢复提示不得制造副作用。
不做会怎样：原错误只有 not callable，缺少当前目录可用项；自动猜工具则会把命名错误变成真实调用。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:679-701
验证：packages/codemode/test/signature.test.ts：compact signatures in catalogs and search、完整条目分页；codemode.test.ts：目录预算与namespace错误；宽泛摘要由公开执行入口长手册对照验证。

### H065 · 在 ToolRuntime 创建唯一工具许可池

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -660,6 +717,8 @@ export const make = <R>(`

职责：把实际宿主并发控制放在数据与调用边界。
机制：每次 make 创建一个 TOOL_CALL_CONCURRENCY 大小的 Semaphore，当前常量为八。
必要性：所有工具和 fetch 要共用一组许可，async 包装与组合器不应占槽。
不做会怎样：只迁移调用包装而没有当前池，无法约束宿主并发；解释器原许可也不能再作为第二层重复调度。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:717-724
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H066 · 隔离后的参数只规范化并解码一次

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -723,7 +782,9 @@ export const make = <R>(`

职责：真实工具调用入口将确定的简写送入原 decoder。
机制：保留此前 externalArgs 的完整 copyIn/copyOut；normalizeInput 仅透传隔离值或加一个静态安全键，直接交 decodeToolInput，不再做第二次全图复制。零参 {} 和显式 undefined 保持原区别。
必要性：R6 删除重复遍历，危险候选键由 H075 排除，default/transform 仍归原 decoder。
不做会怎样：删掉规范化会拒绝合法简写；恢复第二次复制只增加重复工作。若撤掉键约束却保留本路径，则新包装键不再受已证明的静态约束。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:782-790
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H067 · 输出校验后再转交原文来源

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -739,7 +800,8 @@ export const make = <R>(`

职责：让 decoder 重建的业务结果保留来源，且不让 text 别名参与输出合同。
机制：先 decodeToolOutput(tool, raw)，再 withRawText(result, rawText(raw))，最后走 decodeOutput 的沙箱复制。
必要性：原文元数据应跨过 decoder 重建，但业务验证必须先完成。
不做会怎样：来源会在 decoder 返回新对象时丢失；若先注入 text 别名再验证，原合同会看到不属于业务的数据。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:800-807
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H068 · 把许可包在实际调用入口外

路径：`packages/codemode/src/tool-runtime.ts`；`@@ -750,7 +812,13 @@ export const make = <R>(`

职责：使排队先于实际校验、计数、running 通知和宿主执行。
机制：invoke 的整个 Effect 用 permits.withPermits(1) 包装；仅 $codemode.search 直通，fetch 与全部宿主调用共用许可。 两行注释分别说明准入后的计数/超时起点，以及同步 search 例外；注释压缩保持原调用语义。
必要性：队列等待不应制造假 running，也不应消耗叶子工具自身的执行超时；根取消必须能停止等待者。
不做会怎样：未包住全部入口会出现已计费但尚未运行的记录，或超出八个实际调用；把 search 也异步排队则改变其同步发现合同。

生产者→消费者：可信工具定义及沙箱参数 → prepare/search 或 invoke 数据/许可边界 → 原 decoder/run 与沙箱结果
源码：packages/codemode/src/tool-runtime.ts:812-824
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H069 · 接入真实编码合同的结构查询

路径：`packages/codemode/src/tool-schema.ts`；`@@ -1,4 +1,4 @@`

职责：schema所有者同时负责展示和确定性简写的结构信息。
机制：引入SchemaAST供inputForms识别对象、必填字段和编码域，不执行decoder。
必要性：展示与简写同属原合同派生，合并到现有模块可避免额外input-forms文件及重复导入。
不做会怎样：省略AST接口无法判断唯一可包装字段；改读展示JSON则可能被插件的展示修改授予错误调用形式。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:1-4
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H070 · 移除多行 renderer 的状态开关

路径：`packages/codemode/src/tool-schema.ts`；`@@ -34,10 +34,9 @@ const intersection = (members: ReadonlyArray<string>): string => {`

职责：让签名渲染只携带引用定义。
机制：RenderContext 删除 pretty 字段。
必要性：和 H072/H073 一起收敛为一套紧凑 renderer。
不做会怎样：单独保留未使用的状态字段不会改变行为；这里是接口清理，真实展示变化在 H073/H075。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:34-42
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H071 · 删除 JSDoc 拼装器

路径：`packages/codemode/src/tool-schema.ts`；`@@ -64,46 +63,7 @@ const hasUnresolvedRef = (`

职责：去掉第二套多行字段文档文本生成。
机制：移除 docTags 和 jsdoc，renderSchema 继续负责类型形状。
必要性：字段完整说明由 H060 的原 schema 按需交付，无需同时维护 JSDoc 转写。
不做会怎样：保留未调用的辅助函数不会破坏执行；这项删除减少重复实现，不代表字段详情应丢失。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:63-69
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H072 · 让所有 schema 渲染为紧凑类型

路径：`packages/codemode/src/tool-schema.ts`；`@@ -177,41 +137,31 @@ const renderSchema = (`

职责：统一对象字段、索引签名及 Effect/JSON schema 的 TS 概览输出。
机制：renderSchema 只拼单行字段；toTypeScript、jsonSchemaToTypeScript 去掉 pretty 参数，引用解析和发射失败回退 unknown 保留。
必要性：四个模型出口应复用同一概览，按需 schema 详情负责类型之外的约束。
不做会怎样：目录与搜索仍可能走不同的多行形态，同工具的签名不再同源；这项改动只影响展示，不修改 decoder。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:137-167
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H073 · 字段搜索使用真实输入合同

路径：`packages/codemode/src/tool-schema.ts`；`@@ -231,16 +181,17 @@ export type InputProperty = {`

职责：让字段名和字段描述的索引来源与签名、简写一致。
机制：inputProperties 从 definition.inputContract 发射或读取 JSON schema，保留 definitions/$defs 和原 top-level ref 处理。
必要性：展示 schema 经插件改写后，仍需按实际可调用字段查找工具。
不做会怎样：搜索可能按展示字段命中却与真实 decoder 不符；正向简写不适用的复杂对象也不能因此失去完整字段索引。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:181-197
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H074 · 从真实合同生成唯一输入输出签名

路径：`packages/codemode/src/tool-schema.ts`；`@@ -262,26 +213,19 @@ export const inputProperties = <R>(definition: Definition<R>): Array<InputProper`

职责：把 inputContract 用于输入概览，保留真实输出来源。
机制：inputTypeScript 对 Effect 合同按 encoded 域渲染；outputTypeScript 按 decoded 域，缺失则 unknown；两者都删除 pretty 参数，也不追加简写 union。
必要性：签名展示标准输入，宽容简写由运行时派生，避免给每个工具重复扩充类型。
不做会怎样：模型仍可能看到插件改过的展示输入，或看到另一套多行签名；根据工具名字猜返回类型没有合同依据。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:213-231
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H075 · 从真实编码合同派生单值简写

路径：`packages/codemode/src/tool-schema.ts`；`@@ -299,3 +243,46 @@ export const decodeOutput = <R>(definition: Definition<R>, value: unknown): unkn`

职责：schema模块识别唯一的对象字段包装，原decoder仍负责实际解码。
机制：inputForms仅接受无索引、无符号字段的对象：一个必填字段，或全可选且仅一个字段；字段编码域须是原始值。normalizeInput按类型包装单值，对象与undefined原样交付。与渲染代码同处一模块，tool.ts只有类型依赖反向引用。
必要性：read("path")不应只因对象包装重试，但不能猜多键主键、反向吞掉对象、重复运行default或transform。
不做会怎样：不做时合法单值直觉调用仍报参数外形错误；若任意拆包或猜键，可能执行错误目标。独立小模块没有额外消费者，合并可减少路径而不改变参数合同。
R24 更新（R6）：候选集合为有必填时的 required，否则全部 propertySignatures，仅允许唯一项；String/Number/Boolean/Null 用标签统一映射。排除 constructor/**proto**/prototype，保证 normalizeInput 不产生首个隔离边界之外的新危险键；这不是独立任意 inputForms 校验。

生产者→消费者：原 Effect/JSON 合同 → renderer/inputForms/normalizeInput → 模型签名、搜索字段或唯一 decoder
源码：packages/codemode/src/tool-schema.ts:243-288
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H076 · 接入输入形式派生函数

路径：`packages/codemode/src/tool.ts`；`@@ -1,4 +1,5 @@`

职责：为 Tool.make 从真实合同推导简写提供依赖。
机制：导入 inputForms 和 InputForms 类型。
必要性：归 H078/H080 的定义和构造使用。
不做会怎样：没有独立行为；单独删导入会造成函数或类型引用缺失，注释不增加简写规则。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：Tool.make 的 input/inputContract → Definition/inputForms → ToolRuntime.describe/invoke
源码：packages/codemode/src/tool.ts:1-5
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H077 · 区分输入来源合同与本层 decoder

路径：`packages/codemode/src/tool.ts`；`@@ -36,6 +37,9 @@ export type SchemaType = Schema.Decoder<unknown> | JsonSchema`

职责：在工具定义中保存完整合同和派生形式。
机制：Definition 增加必填 inputContract、可选 inputForms；既有 input 继续决定本层是否执行 Effect 解码。
必要性：宿主适配器要展示真实合同，同时让实际解码留在原宿主入口。
不做会怎样：只复用 input 会把展示与执行混在一起，难以同时避免重复 decoder 和展示漂移。

生产者→消费者：Tool.make 的 input/inputContract → Definition/inputForms → ToolRuntime.describe/invoke
源码：packages/codemode/src/tool.ts:37-45
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H078 · 允许宿主传入原 decoder 来源

路径：`packages/codemode/src/tool.ts`；`@@ -50,6 +54,8 @@ type ResultType<S> = S extends Schema.Decoder<unknown> ? S["Encoded"] : unknown`

职责：给只用 JSON input 展示的适配器传递真实合同的选项。
机制：Options 新增可选 inputContract: Schema.Decoder<unknown>。
必要性：ToolRuntime 可以依据真实合同生成签名和简写，而原工具仍执行自己的 decoder。
不做会怎样：适配器只剩展示 JSON schema，无法证明真实参数结构和 encoded 域。

生产者→消费者：Tool.make 的 input/inputContract → Definition/inputForms → ToolRuntime.describe/invoke
源码：packages/codemode/src/tool.ts:54-61
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H079 · 以同一实际合同派生展示和简写

路径：`packages/codemode/src/tool.ts`；`@@ -87,10 +93,17 @@ export const isDefinition = <R = never>(value: unknown): value is Definition<R>`

职责：在 Tool.make 集中确定合同优先级，不执行 decoder 探测。
机制：input 是 Effect schema 时优先使用它；否则用明确传入的 inputContract，最后才回退 JSON input。只有 Effect 合同派生 inputForms，原 input/output/run 保留。
必要性：原始输入与转换语义需要一个来源；纯展示 JSON 不能额外授予调用形式。
不做会怎样：展示、字段搜索和简写可能各用不同来源；先运行 decoder 猜形式还会重复 default/transform 的效果。

生产者→消费者：Tool.make 的 input/inputContract → Definition/inputForms → ToolRuntime.describe/invoke
源码：packages/codemode/src/tool.ts:93-109
验证：packages/codemode/test/codemode.test.ts：schema flexibility、原decoder/default/undefined与数据隔离；signature.test.ts：adapter contract和encoded input。

### H080 · 统一Promise终态和业务值原文来源

路径：`packages/codemode/src/values.ts`；`@@ -1,11 +1,28 @@`

职责：值模块保存沙箱值身份和随值回收的原文元数据。
机制：SandboxPromise只保存fiber或安全exit及observed位；原文用WeakMap保存，已有来源不覆盖，只在沙箱副本缺少业务text字段时提供不可枚举只读别名。原raw-text模块原样归入values。
必要性：根清理后不能保活旧Fiber或权限；JSON文本投影还须支持String(value)恢复原文而不污染输出键。
不做会怎样：保留旧Promise字段会残留race专属取消状态；没有来源映射则投影后的对象无法恢复精确文本；把元数据写成可枚举字段会改变业务合同。

生产者→消费者：沙箱值创建/原文投影/URL 包装 → Promise 状态、WeakMap、URL owner → snapshot/字符串转换/结果复制
源码：packages/codemode/src/values.ts:1-28
验证：packages/codemode/test/codemode.test.ts：JSON text results、URL preview、retained promises。

### H081 · 保留 URL 参数视图的归属

路径：`packages/codemode/src/values.ts`；`@@ -28,13 +45,17 @@ export class SandboxSet {`

职责：URL 包装器描述自身参数视图的真实绑定。
机制：SandboxURLSearchParams 增加可选 readonly owner；仅 SandboxURL 构造其绑定视图时传入 native URL，独立 params 不传。
必要性：R7 快照先遇 params 时也能找到并复制同一 URL 内部槽。
不做会怎样：按 params 独立复制会割裂 URL.search 与保存的参数别名；本字段不授予脚本读取内部 owner 的能力。

生产者→消费者：沙箱值创建/原文投影/URL 包装 → Promise 状态、WeakMap、URL owner → snapshot/字符串转换/结果复制
源码：packages/codemode/src/values.ts:45-61
验证：packages/codemode/test/codemode.test.ts：JSON text results、URL preview、retained promises。

### H082 · 声明JSON配置的唯一公开合同

路径：`packages/core/src/v1/config/config.ts`；`@@ -49,6 +49,18 @@ export const Info = Schema.Struct({`

职责：ConfigV1接收项目和全局Codemode选项，HTTP与SDK由它派生。
机制：codemode为boolean或含enabled/keep_tools可选布尔字段的对象；沿用原配置合并，说明由Schema传到生成类型。
必要性：用户需要opencode.json控制显示模式，不能只保留进程环境开关或在宿主手工解析未知JSON字段。
不做会怎样：不加字段时配置解码无法保留用户的Codemode设置，HTTP和SDK也不知道该配置；独立手工解析会与公开配置合同脱节。

生产者→消费者：用户 JSON/env 合并配置 → ConfigV1 schema → configuration/Registry 与生成 SDK/OpenAPI
源码：packages/core/src/v1/config/config.ts:49-66
验证：packages/opencode/test/tool/code-mode.test.ts：配置矩阵；test/session/execute.test.ts：execute display switches；完整生成链。

### H083 · 让 MCP 投影接收输出声明

路径：`packages/opencode/src/mcp/catalog.ts`；`@@ -58,7 +58,11 @@ export async function callTool(entry: MCP.McpTool, args: unknown, signal?: Abort`

职责：把判断文本投影资格所需的协议合同带到 owner。
机制：programResult 新增可选 outputSchema 参数，structuredContent 和附件处理流程保留。
必要性：只有 MCP 适配层同时知道原结果和工具声明，宿主不能仅凭文本长得像 JSON 决定。
不做会怎样：H084 无法排除已声明输出的结果，可能改变有类型工具的返回语义。

生产者→消费者：MCP CallToolResult 与 outputSchema → programResult 资格标记 → CodeMode 工具树显式文本投影
源码：packages/opencode/src/mcp/catalog.ts:58-68
验证：packages/opencode/test/mcp/catalog.test.ts；test/session/execute.test.ts：真实MCP structured call及输出验证。

### H084 · 标记可投影的成功单文本结果

路径：`packages/opencode/src/mcp/catalog.ts`；`@@ -95,7 +99,18 @@ export function programResult(result: CallToolResult): NonNullable<Tool.ExecuteR`

职责：严格限定哪些 MCP 文本允许后续转成对象或数组。
机制：仅在非 isError、无 outputSchema、无 structuredContent、恰有一个文本且其余内容仅 image/audio 时给出 rawText。原 value 与独立 attachments 保留。
必要性：一段 schema-less JSON 文本可供脚本组合，分段文本、资源、错误和声明输出仍遵循原协议。
不做会怎样：无标记时宿主无法安全选择投影；宽泛解析会把已声明字符串、错误正文或多块协议内容改成另一种结果。

生产者→消费者：MCP CallToolResult 与 outputSchema → programResult 资格标记 → CodeMode 工具树显式文本投影
源码：packages/opencode/src/mcp/catalog.ts:99-116
验证：packages/opencode/test/mcp/catalog.test.ts；test/session/execute.test.ts：真实MCP structured call及输出验证。

### H085 · 标记终态错误不重复追加取消提示

路径：`packages/opencode/src/session/message-v2.ts`；`@@ -888,10 +888,12 @@ export const toModelMessagesEffect = Effect.fnUntraced(function* (`

职责：MessageV2 消费已完成的 Execute 错误回执。机制：仅 execute 且 metadata.finalizedError===true 判定为新终态，rawElapsed 不再生成第二份 abort notice。必要性：SessionProcessor 已把取消提示计入 36K；回放后追加会越界或重复。不做会怎样：新记录再次追加提示；旧无标记记录必须继续原行为。

生产者→消费者：持久化 error Part 的 finalizedError/output → toModelMessagesEffect → 模型 error 输出，旧记录原路
源码：packages/opencode/src/session/message-v2.ts:888-899
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H086 · 回放标记错误的已准备正文

路径：`packages/opencode/src/session/message-v2.ts`；`@@ -918,7 +920,8 @@ export const toModelMessagesEffect = Effect.fnUntraced(function* (`

职责：错误工具消息复用持久化终态正文，不把 error 改为成功。机制：finalized 且 executeOutput !== undefined 时直接选其正文；其余 task resume、旧 partial 与原 error 路径保留。必要性：原错误已由 processor 放进全文并计费。不做会怎样：再次前置原错误可能超出上限并产生重复原因。

生产者→消费者：持久化 error Part 的 finalizedError/output → toModelMessagesEffect → 模型 error 输出，旧记录原路
源码：packages/opencode/src/session/message-v2.ts:920-927
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H087 · 接入终态回执依赖

路径：`packages/opencode/src/session/processor.ts`；`@@ -34,6 +34,8 @@ import type { EventV2 } from "@opencode-ai/core/event"`

职责：processor 使用既有 Truncate 与统一执行提示。机制：导入 Truncate 和 formatExecutionNotice。必要性：最终 owner 复用单一存储/裁剪算法及现有提示格式。不做会怎样：后续准备和失败组合缺少符号；导入自身不产生额外存储 owner。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:34-41
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H088 · 取得共同截断服务

路径：`packages/opencode/src/session/processor.ts`；`@@ -221,6 +223,7 @@ const layer = Layer.effect(`

职责：processor 的 Layer 取得 Truncate.Service。机制：与 Image 等既有服务同层获取。必要性：所有终态路径调用同一服务，不另造文件写入。不做会怎样：准备函数缺少服务实例。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:223-229
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H089 · 准备入口按真实工具身份决定处理

路径：`packages/opencode/src/session/processor.ts`；`@@ -394,7 +397,8 @@ const layer = Layer.effect(`

职责：prepareToolOutput 同时处理既有图片与 Execute 最终预算。机制：私有 options 参数替换为 tool?: string。必要性：read 的图片预算与 execute 的正文预算由当前工具身份选择。不做会怎样：调用端需继续重复传策略，最终 owner 无法识别 Execute。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:397-404
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H090 · 保留图片规范化并延后最终返回

路径：`packages/opencode/src/session/processor.ts`；`@@ -403,11 +407,11 @@ const layer = Layer.effect(`

职责：先得到图片处理和 omission 的完整结果。机制：read 仍向 image.normalize 传 tokenBudget:1600，其余 undefined；原返回对象存为 result 供后续字符预算使用。必要性：图片省略提示必须纳入最终正文，不能裁完再追加。不做会怎样：丢掉 read 预算会改变普通图片策略；直接返回则最终 Execute 预算无法执行。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:407-417
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H091 · 在完整回执后应用唯一最终预算

路径：`packages/opencode/src/session/processor.ts`；`@@ -418,6 +422,19 @@ const layer = Layer.effect(`

职责：SessionProcessor 统一准备 Execute 最终文本。机制：普通工具直接返回 result；Execute 在图片规范化/真实省略提示之后调用 truncate.output(result.output,{maxChars:36_000})，准备其正文和元数据供原完成/事件路径持久化，截断时清空 loaded/skills 并记录 outputPath。必要性：耗时、取消、图片提示都必须计入同一 36K，恢复文件保存裁剪前完整回执。不做会怎样：前级预算不能覆盖后装饰；未清交付声明会误认为完整规则已经传达。Truncate 仍是算法/落盘 owner，不是新存储器。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:422-440
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H092 · 在既有完成路径传递真实工具身份

路径：`packages/opencode/src/session/processor.ts`；`@@ -438,7 +455,7 @@ const layer = Layer.effect(`

职责：既有 completeToolCall 在 permit 内按真实 Part 工具准备并持久化终态。机制：唯一累计改动是 prepareToolOutput 的第二参数从 Read options 改为 match.part.tool；原 void、无 match 返回、terminal settle/return、private prepared 标志及存储流程保持。必要性：准备 owner 同时识别原 Read 图片预算与 Execute 最终正文预算，不需公开 tool 参数、无 Part fallback 或返回快照。不做会怎样：准备函数缺少当前工具身份，无法在唯一 owner 选择 Execute 预算。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:455-461
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H093 · 错误原因与完整 partial 合成后预算

路径：`packages/opencode/src/session/processor.ts`；`@@ -480,17 +497,41 @@ const layer = Layer.effect(`

职责：failToolCall 保持 error 状态并准备可恢复终态错误正文。机制：先求 failure、elapsed 和保留/中断 metadata；仅 Execute 将原错误、完整 metadata.output、真实 abort notice 合成后交 prepareToolOutput，并写 finalizedError:true 与准备正文。state.error 继续为原 failure，普通工具不走新准备。必要性：错误发生后才能知道完整原因，提前截断 partial 会遗漏最终前后缀。不做会怎样：错误总正文超预算或丢失完整恢复内容；缺少标记让 MessageV2 再加一遍原因/提示。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:497-537
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H094 · 原事件准备流程传入事件工具名

路径：`packages/opencode/src/session/processor.ts`；`@@ -793,7 +834,7 @@ const layer = Layer.effect(`

职责：tool-result 事件保留原 prepare→complete(prepared:true) 流程。机制：prepareToolOutput(rawOutput,value.name) 替换调用方构造 Read options；existing terminal 检查先跳过已完成/error 回声。必要性：图片策略和 Execute 字符预算在同一私有 owner 决定。不做会怎样：事件分支缺少 Execute 身份或继续重复构造图片策略；本变更没有增加提前 completion，也没有删除 prepared 协议。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:834-840
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H095 · 装配 Truncate 层依赖

路径：`packages/opencode/src/session/processor.ts`；`@@ -1314,6 +1364,7 @@ export const node = LayerNode.make({`

职责：processor LayerNode 获得既有 Truncate 节点。机制：deps 新增 Truncate.node。必要性：与获取 Service 的变更配套。不做会怎样：层构建缺少准备输出所需服务；本 hunk 不增加独立配置。

生产者→消费者：原 processor.process 工具包装器先 startToolCall→await execute→await complete/fail→原始 exit；既有事件 terminal 检查及 private prepared 流程→prepareToolOutput→持久化 Part→MessageV2 下一模型回合
源码：packages/opencode/src/session/processor.ts:1364-1370
验证：packages/opencode/test/session/execute.test.ts：final Execute model receipt、failure、image omission、interruption、long success；test/tool/truncation.test.ts：默认字节/行行为。

### H096 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -28,7 +28,7 @@ import { EffectBridge } from "@/effect/bridge"`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：复用已有code-mode模块的预算工厂导入，由本次Execute分支创建实例。
必要性：同一宿主模块已经提供CodeModeHost与HTTP能力，不另建计时模块或全局状态。
不做会怎样：缺少配套导入，实际创建预算的分支无法解析；导入本身不增加另一种计时政策。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:28-34
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H097 · 读取注册表确定的显示模式

路径：`packages/opencode/src/session/tools.ts`；`@@ -108,7 +108,9 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools消费工具注册表已解析的模式，不再自己读取另一套配置服务。
机制：从原ToolRegistry.Service调用codemode()，此状态用于provider工具过滤和 describeCatalog 的目录优先级，不再进入执行 host。
必要性：Registry已经拥有Config并负责execute能否列出，Session复用同一入口可避免向SessionPrompt追加Config接线。
不做会怎样：各处分别读配置可能采用不同缺省或优先级；从权限结果反推模式又会在execute被禁用时恢复用户隐藏的工具。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:108-116
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H098 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -116,6 +118,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：私有Execution类型增加泛型pause包装器，工具child携带当前根预算。
必要性：child执行经过独立run.promise，不能依赖隐式Fiber上下文传递。
不做会怎样：没有这个字段，ctx.ask无法对正在计时的根预算暂停，或不得不从全局猜当前执行。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:118-125
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H099 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -172,7 +176,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：context.ask在执行权限询问/审批的同一Effect外调用execution.pause，直接工具无Execution仍走原调用。现有abort竞争和错误传播保留。
必要性：所有真实native、MCP与fetch权限都通过这个ctx.ask；暂停应由这个共同owner定义。
不做会怎样：运行中升阶审批仍消耗脚本期限，用户回答前整个Execute可能被误判超时。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:176-183
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H100 · 每次 Execute 创建暂停预算

路径：`packages/opencode/src/session/tools.ts`；`@@ -197,6 +202,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools 为本次执行创建唯一预算实例。机制：execute 分支 yield\* makeExecutionBudget，初始审批后由解释器启动计时。必要性：不能跨 Execute 共享剩余时间。不做会怎样：运行中人类等待无法被当前根计时排除。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:202-209
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H101 · 将根预算等待能力交给 Execute

路径：`packages/opencode/src/session/tools.ts`；`@@ -204,6 +211,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：当前 codeMode host 只传执行所需能力。机制：waitForTimeout:budget.wait；不再转发 keepTools。必要性：计时有消费者，实际 runtime 的 discovery 优先级只影响未读取的 instructions，故删除无用显示模式接线。不做会怎样：删 waitForTimeout 会恢复固定计时；恢复 keepTools 不改变实际 searchIndex 或执行能力，只增加无用字段。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:211-218
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H102 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -212,6 +221,7 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：fetch的私有Execution携带budget.pause，让其ctx.ask引用当前根预算。
必要性：HTTP复用相同权限上下文，但不通过普通child构建点；这个唯一差别需要明确传递同一个能力。
不做会怎样：HTTP权限审批会继续扣脚本时间，即使普通工具审批已暂停；真实HTTP请求自己的30秒期限不改变。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:221-227
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H103 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -253,6 +263,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：child Execution携带budget.pause，随后经原invoke/run.promise进入ctx.ask。
必要性：每个独立宿主Promise必须接到同一次Execute预算，不能各自开启或重置计时器。
不做会怎样：真实子调用与库根计时器断开，单独改变ctx.ask并不能排除人工等待时间。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:263-270
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H104 · 保留 child 清理说明并撤回纯分行

路径：`packages/opencode/src/session/tools.ts`；`@@ -261,8 +273,9 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：说明取消通知与清理完成是不同阶段。
机制：保留根/宿主取消及 pending 等待说明；Effect.ensuring(Effect.promise(() => pending.then(...))) 恢复基线单行，不再是历史所说的分行展开。
必要性：注释帮助维护者保留真实资源清理边界；排版本身没有功能收益。
不做会怎样：删注释不会改变行为，但会丢失非显然约束；恢复多行也不改变算法，仅增加累计差异。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:273-281
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H105 · 把本次预算接到真实宿主等待

路径：`packages/opencode/src/session/tools.ts`；`@@ -303,7 +316,11 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。
机制：仅本次Execute中的question工具body由execution.pause包住，再进入原timedToolExecution；普通工具body不暂停。
必要性：question的等待不调用ctx.ask，必须在其已有真实工具边界纳入同一预算。
不做会怎样：用户回答问题仍会耗尽脚本期限；若包住所有工具，则shell、读文件和网络等待会错误变成无限额工作。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:316-326
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H106 · 删除 SessionTools 重复交付声明清理

路径：`packages/opencode/src/session/tools.ts`；`@@ -327,11 +344,7 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools 仅保留既有耗时/取消装饰及普通输出返回；最终预算 owner 决定截断后的 loaded/skills。机制：删除 execute && output.metadata.truncated 时的 loaded/skills 清空块，原成功-abort completion 不变。必要性：CodeMode 中间结果尚未最终裁剪，规则清理应跟随 processor 的真实最终截断结果。不做会怎样：保留该块造成职责重复且不覆盖最终图片/notice 导致的裁剪；不应为补偿此块新增无条件 Execute early completion。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:344-350
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H107 · 失败清理只保存完整 partial 事实

路径：`packages/opencode/src/session/tools.ts`；`@@ -343,11 +356,7 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：SessionTools 收集已完成副作用与请求，不提前决定最终错误正文。机制：metadata.output 保存完整 text，保留 error:true、loaded/skills 清空；删除 partial truncate/outputPath 写入。必要性：原错误与取消提示稍后由 failToolCall 一次合成、一次预算。不做会怎样：预裁 partial 的文件不是完整最终回执，后续再次截断形成多个 owner。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:356-362
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H108 · 把 MCP 原输出声明交给投影

路径：`packages/opencode/src/session/tools.ts`；`@@ -601,7 +610,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：在实际 Session MCP 返回路径接通资格判断。
机制：McpCatalog.programResult(result, entry.def.outputSchema) 替代只传 result。
必要性：H083/H084 的条件需要实际工具定义，不能由展示结果倒推。
不做会怎样：声明输出的 MCP 结果会被误认为无 schema 候选；SDK 原输出验证仍由既有调用负责。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:610-617
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H109 · 保留完整调用目录，再选择provider入口

路径：`packages/opencode/src/session/tools.ts`；`@@ -621,10 +631,19 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：目录携带原decoder来源，显示选择不改变脚本可调用能力。
机制：目录项逐字段转交runtimeParameters与原output合同，MCP命名沿原入口；provider循环才依据Registry模式隐藏catalog内普通工具，控制工具保留。
必要性：真实参数与展示schema不能混为一谈，隐藏直调也不能把工具从Execute内部删除。
不做会怎样：省略原合同会按展示字段猜参数；若构建目录前先删工具，Execute-only失去内部能力；按权限自动恢复隐藏项会违背显示设置。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:631-649
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H110 · 依据当前入口与非空目录生成建议

路径：`packages/opencode/src/session/tools.ts`；`@@ -635,7 +654,18 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`

职责：Session 系统说明反映本轮真实工具入口。
机制：eligible.execute 且 catalog 非空才给出建议及目录；keepTools=true 推荐简单动作直调，false 明确目录工具的简单动作也用 execute。
必要性：R3 消除隐藏直调与空目录下的矛盾建议。
不做会怎样：Execute-only 仍建议不存在的直调入口，空目录仍诱导执行。

生产者→消费者：Registry 定义与当前 Session→resolver/host/既有耗时或取消装饰→原始返回；模型执行由既有 processor.process 完成持久化，下一回合 MessageV2 消费终态
源码：packages/opencode/src/session/tools.ts:654-671
验证：packages/opencode/test/session/execute.test.ts与test/session/tools.test.ts：真实权限、question等待、child记录/取消、模式入口及最终回执。

### H111 · 集中配置解释、暂停预算和公开参数

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -1,13 +1,86 @@`

职责：宿主提供单一Codemode配置解释、可暂停执行预算及公开环境/期限参数。
机制：configuration通过Effect ConfigProvider解析两个OPENCODE_CODEMODE环境变量，以合并后的JSON或true作为缺省；Registry拥有配置读取。makeExecutionBudget用等待计数、单Deferred和剩余时间处理重叠人工等待；Parameters声明environmentID和毫秒timeout。
必要性：配置优先级与预算是共享宿主入口的职责，不能在Registry、Session或各子调用复制策略；环境句柄和可调期限需要真实schema。
不做会怎样：环境默认true可能遮掉JSONfalse，或两个工具面产生不同模式；普通固定timeout会在用户仍审批时终止脚本，重叠等待也可能重复扣时。缺参数合同则模型无法明确复用环境或调整期限。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:1-86
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H112 · 声明环境身份与中间未裁状态

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -16,8 +89,11 @@ export const Parameters = Schema.Struct({`

职责：CodeMode Metadata 可表达跨格环境与尚未最终裁剪的文本。机制：environmentID 与可选 truncated 字段；成功输出设置 false，由 Session 最终更新。必要性：wrapper 识别已有显式状态以保留完整中间输出，ID 不随进度替换丢失。不做会怎样：generic wrapper 仍提前裁剪或类型不支持中间状态。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:89-99
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H113 · 传递真实参数与本次等待能力

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -25,16 +101,19 @@ type Metadata = {`

职责：CatalogEntry 携带原 validator，CodeModeHost 携带 waitForTimeout。机制：runtimeParameters 与 waitForTimeout 保留，不再有 keepTools 字段；显示模式仅 describeCatalog 使用。必要性：真实合同/计时是执行所需，显示优先级对执行消费的 searchIndex 无影响。不做会怎样：缺合同使简写按展示 schema 猜，缺等待能力则审批消耗期限；旧 keepTools 接线没有必要恢复。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:101-119
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H114 · 在一个边界中持有取消、租约和真实执行

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -84,67 +163,154 @@ const toolTree = Effect.fn("CodeMode.toolTree")(function* (`

职责：宿主将当前工具合同、环境租约与取消绑定为一次完整操作。
机制：toolTree传原inputContract；describeCatalog按最终显示模式优先真实内置工具，执行Effect本身不构建unused展示。文件内withEnvironment先验证host并安装外层abort竞争，取得租约后运行完整业务generator，清理完才释放。generator统一规范化围栏、创建当前runtime、收取附件和上下文；进度在复制调用列表前检查100ms窗口。
必要性：租约和取消属于一个生命周期，不能在预跑、begin或真实脚本里各包一层。独立边界让业务保持原层次，而不是把整个文件不断缩进；当前工具合同和进度事实必须贯穿各阶段。
不做会怎样：若abort只放在取得租约后，排队者无法及时退出；若业务返回即释放，下一单元会与旧cleanup重叠。缺合同接线则展示和真实validator分叉；没有发送前窗口会重复复制全部调用记录。
R27 当前owner变化：discovery辅助函数原先只有describeCatalog一个消费者，现priority数组就地在describeCatalog计算，传CodeMode.make({tools,discovery:{priority}}).instructions()；真实执行不消费该目录展示构造。CodeModeTool使用现有CodeMode.execute({code,tools,environment,limits,fetch,waitForTimeout,hooks})直接构造本次Effect，删除为了execute一次而创建make runtime并生成未读取instructions的中间对象。host.begin后才yield该Effect，不引入额外thunk/prepare协议。当前真实budget.wait返回Effect.suspend，计时在Effect运行时启动；不是向任意会产生构造副作用的假想wait回调承诺兼容。工具/参数与当前权限仍由同一ToolRuntime和根Scope拥有。最终正文预算仍在SessionProcessor，Truncate只在这里提供日志源头limit。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:163-316
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H115 · 有界预跑、唯一记录和统一错误交付

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -155,48 +321,90 @@ export const CodeModeTool = Tool.define(`

职责：预跑只收集确定的调用，整段检查与真实执行继续共用同一源码。
机制：在当前租约内复制环境，sleep立即结算；500ms与总1024调用限制来自同一runtime。record以工具身份和严格参数值去重，普通工具与fetch共用入口，先出现者保持顺序；随后host.begin使用唯一列表。真实runtime不继承探测上限，失败/取消保留环境ID与完整调用事实。
必要性：轮询不能将相同意图存成数万条，但不同参数必须保留；去重也不能延长可执行次数。环境副本避免探测修改真实状态，独立真实权限入口承担未发现调用。
不做会怎样：不设总调用限制会在期限内累积大量探测；只在检查时去重仍浪费记录。若按unique计数则重复轮询永远不触发调用上限；若共享真实环境则变量和闭包会被预跑执行两遍。
R24 更新：formatOutput 统一环境前缀与空段过滤，错误 metadata 和错误返回复用；成功结果在 H116 也复用。此处不提前裁剪正文。
R27：预跑及host.begin完成后执行的是此前由CodeMode.execute构造的execute Effect，不再调用runtime.execute(code)。当前入口的源码、工具与日志/期限选项不变；少构造未消费的目录instructions，并非跳过searchIndex或真实授权。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:321-410
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H116 · CodeMode 返回完整未裁中间回执

路径：`packages/opencode/src/tool/code-mode.ts`；`@@ -206,18 +414,29 @@ export const CodeModeTool = Tool.define(`

职责：CodeMode 组合环境、提醒、强制上下文、业务结果和已捕获日志并收集附件。机制：未观察事实一次形成原警告和结果前缀，不按警告字符串再反推标签；withLogs/formatOutput及完整已捕获回执合同保持。metadata.truncated:false 使原 wrapper 只执行清理而不提前裁剪；formatOutput 统一前缀，unobservedFailure 才触发提醒，附件独立返回。必要性：SessionProcessor 还会添加最终耗时/图片等信息，必须收到完整中间文本才能保存最终全文。不做会怎样：wrapper 提前裁掉的正文无法在最终恢复文件补回。最终 loaded/skills 清理由 Session 截断结果决定；不宣称恢复源头已省略的日志。

生产者→消费者：Session 当前工具 host 与源码 → 环境租约/预跑/实际 CodeMode → 完整中间回执 → wrapper 清理 → SessionProcessor
源码：packages/opencode/src/tool/code-mode.ts:414-442
验证：packages/opencode/test/tool/code-mode.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：配置、预算、预跑、环境、进度、完整中间回执和最终模型回执。

### H117 · 真实租约 Fiber 唯一拥有取消与终态回收

路径：`packages/opencode/src/tool/execute-environments.ts`；`@@ -0,0 +1,192 @@`

职责：环境服务保留跨格词法状态、同环境串行、owner/位置隔离、最近八个唯一调用的闲置回收和实例关闭等待。R28 不删除这些合同，只用真实租约 Fiber 替换 users/cancel/drained 三套派生状态。
机制：新环境只由共同的调用顺序准入块写入entries，不再先写一次后立即删/重写；服务Interface从同一个make实现成功类型推导，泛型成功/错误/所需环境不维护第二份声明。use 构造本身不占容量；执行时在 scopedWith 的独立 Fiber 中运行 work。uninterruptibleMask 内先取得真实 Fiber，再同步校验 owner/位置、创建或取回环境、登记活动集合并安装终态 observer。排队者先入集合，gate 仍覆盖 run；restore 保持用户工作可中断。forkIn 绑定租约自身生命周期而非调用者 use 后续工作；Fiber.await 得 Exit 再 flatten，避免 join 的中断观察清理影响其他等待者。scopedWith 不把调用者原 Scope 服务替换成租约 scope。
终态所有权：retire 先 closed 禁准入，再 interruptUnsafe 全部真实租约；仅集合为空才删除条目。observer 在 Fiber 子任务和 finalizer 全部结束后删除自身、回收已关闭条目，并仅淘汰同 owner 最近八个调用窗口外闲置项。close 先禁新准入并向全部条目广播退休，再 Fiber.awaitAll 等真实终态；无虚假成功超时。Session 已解码事件和存储 owner 校验沿用原合同。
必要性：callback 返回并非租约终态，早期 R28 简化原型在 work.ensuring 回收会早于子 Fiber 的隐式关闭；同例 R27 原实现对照通过，终态 observer 是保全原合同，不是证明 R27 存在该行为缺陷。真实 Fiber 同时提供取消目标、活动身份和最终完成观察，不再复制计数/取消/完成通知。独立 lease Fiber 又避免把调用者 use 之后的其它工作算进租约寿命。
不做会怎样：仅等待 callback 或计数归零会早报清理完成；跟踪外层调用者 Fiber 会延长 close 等待甚至与调用者尾部互等；删除活动集合会失去排队/holder 身份和真实清理等待；删除 closed、gate、owner 校验或调用顺序回收会破坏原合同。这里描述实际候选机制，不把构建侧说明当作独立正确性审查。

生产者→消费者：Session/Location 与 environmentID → use 的独立租约 Fiber/串行 gate → run及其子任务/finalizer → Fiber终态observer、retire/close awaitAll；Session事件与存储仍提供owner失效事实。
源码：packages/opencode/src/tool/execute-environments.ts:1-192
验证：packages/opencode/test/tool/code-mode.test.ts：环境生命周期及lease fiber ownership regressions全部用例。

### H118 · 导入环境服务节点

路径：`packages/opencode/src/tool/registry.ts`；`@@ -59,6 +59,7 @@ import { MCP } from "@/mcp"`

职责：为 Registry 依赖图接入环境管理提供符号。
机制：新增 ExecuteEnvironments import。
必要性：归 H109 的依赖装配使用。
不做会怎样：本 hunk 没有独立缓存或生命周期行为；单独删导入会使节点引用无法解析。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:59-65
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H119 · 向工具消费者提供同一模式入口

路径：`packages/opencode/src/tool/registry.ts`；`@@ -80,6 +81,8 @@ type State = {`

职责：Registry是可用工具和显示配置的共同服务边界。
机制：接口新增codemode()，返回解析后的enabled与keepTools；不新增服务层或权限状态。
必要性：Session本来依赖Registry，复用该入口能消除Config向调用链层层传递。
不做会怎样：不提供入口，Session只能复制配置读取或增加上游服务注入，导致显示策略接线分散。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:81-88
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H120 · 在共同工具列表出口应用Execute开关

路径：`packages/opencode/src/tool/registry.ts`；`@@ -279,9 +282,15 @@ const layer = Layer.effect(`

职责：Registry.all拥有本地工具集合，供实际调用与ids展示共用。
机制：读取共同配置入口的enabled，仅当它为false时移除execute，原工具与插件条目保留。
必要性：SessionTools、HTTP、TUI及debug都读取同一Registry，不能只隐藏其中一个界面。
不做会怎样：关闭Execute后工具选择器仍出现它，或用户可以经另一入口看到与设置不一致的工具集合。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:282-296
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H121 · 仅转交真实 decoder 来源

路径：`packages/opencode/src/tool/registry.ts`；`@@ -347,6 +356,8 @@ const layer = Layer.effect(`

职责：Registry 区分 hook 展示 parameters 与原执行闭包 decoder。机制：runtimeParameters:tool.runtimeParameters；R25 outputOptions 透传已完全移除。必要性：简写/签名需原合同，而最终预算不再由工具选项链传递。不做会怎样：删除 decoder 来源会混淆展示与执行；恢复 outputOptions 只是已经无消费者的旧协议。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:356-363
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H122 · 在原服务出口发布模式读取

路径：`packages/opencode/src/tool/registry.ts`；`@@ -366,7 +377,7 @@ const layer = Layer.effect(`

职责：实际Layer提供接口承诺的模式入口。
机制：Service.of返回codemode与原ids/all/named/tools，测试fake也提供该方法。
必要性：声明接口并不等于运行时可调用，既有消费者要从同一个Registry实例获得它。
不做会怎样：Session调用会拿到undefined，或测试只用缺失的替身掩盖实际依赖；无需另建Config服务链。
R26 核对：部分重复中文说明已撤回或缩短；以本 hunk 实际 diff 为准，不把历史提到的注释保留情况当作当前事实。功能接线未因注释清理改变。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:377-383
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H123 · 沿现有依赖图提供环境服务

路径：`packages/opencode/src/tool/registry.ts`；`@@ -466,6 +477,8 @@ export const node = LayerNode.make({`

职责：让 Execute 初始化获得 InstanceState 下的环境 owner。
机制：ToolRegistry 的 LayerNode deps 加入 ExecuteEnvironments.node，其 SessionStore/事件依赖由该节点提供。
必要性：环境管理应随既有实例生命周期创建与释放，不在 resolver 每次建立另一份缓存。
不做会怎样：CodeModeTool 取不到所需服务，或被迫把状态放到错误的 resolver 寿命中。

生产者→消费者：Config、Tool.Def 和 definition hook → Registry 可信字段/显示模式 → SessionTools 与工具服务依赖
源码：packages/opencode/src/tool/registry.ts:477-484
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H124 · 在程序结果通道声明 rawText

路径：`packages/opencode/src/tool/tool.ts`；`@@ -57,7 +57,12 @@ export interface ExecuteResult<M extends Metadata = Metadata> {`

职责：给协议 owner 的候选标记提供宿主类型出口。
机制：ExecuteResult.program 扩展为 value、可选 rawText 和 attachments；普通 output 与 context 继续分开。
必要性：MCP 投影要把资格事实传到 Execute，不应通过正文猜测或改变用户可见 MCP output。
不做会怎样：H084 的标记无法沿实际结果结构传到 H102；把它塞进业务 value 则会污染脚本数据。

生产者→消费者：Tool initializer parameters/program → wrapper decoder/可见文本清理 → Registry/Session；Execute 显式 truncated:false 不触发早裁剪
源码：packages/opencode/src/tool/tool.ts:57-68
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H125 · Def 只保留实际 decoder 来源

路径：`packages/opencode/src/tool/tool.ts`；`@@ -69,6 +74,8 @@ export interface Def<`

职责：工具宿主类型保留原参数 schema 引用。机制：readonly runtimeParameters?；无 outputOptions 字段。必要性：真实 decoder 捕获需要跨 Registry/Session 传递，最终 Execute 预算已由 processor 拥有。不做会怎样：缺引用会回到展示推断；旧输出选项声明没有当前消费者。

生产者→消费者：Tool initializer parameters/program → wrapper decoder/可见文本清理 → Registry/Session；Execute 显式 truncated:false 不触发早裁剪
源码：packages/opencode/src/tool/tool.ts:74-81
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H126 · 直接按原参数合同编译decoder

路径：`packages/opencode/src/tool/tool.ts`；`@@ -146,9 +153,8 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`

职责：wrapper在init时用真实toolInfo.parameters编译一次decoder。机制：删除仅转发一次的runtimeParameters局部别名，直接Schema.decodeUnknownEffect(toolInfo.parameters)；同一原toolInfo.parameters在返回处显式作为runtimeParameters字段交出。必要性：展示hook发生在返回之后，真实decoder与返回合同来源不因移除别名改变。不做会怎样：删除真实来源字段会混淆展示/解码；恢复别名不增加保护，只保留无用转发。两条邻近中文说明继续分别表达捕获时点和只编译一次约束。

生产者→消费者：Tool initializer parameters/program → wrapper decoder/可见文本清理 → Registry/Session；Execute 显式 truncated:false 不触发早裁剪
源码：packages/opencode/src/tool/tool.ts:153-160
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H127 · 以原字段返回权威decoder来源

路径：`packages/opencode/src/tool/tool.ts`；`@@ -199,7 +205,8 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`

职责：wrap返回原parser的schema来源，并覆盖initializer同名字段。机制：返回{...toolInfo,runtimeParameters:toolInfo.parameters}，字段置于展开之后，真实execute闭包只替换toolInfo.execute，不改parameters。必要性：Registry/Session仍收到与decodeUnknownEffect相同的对象引用，无需独立局部别名。不做会怎样：若只保留initializer自报值或把字段放在展开前，真实来源可能被覆盖。

生产者→消费者：Tool initializer parameters/program → wrapper decoder/可见文本清理 → Registry/Session；Execute 显式 truncated:false 不触发早裁剪
源码：packages/opencode/src/tool/tool.ts:205-212
验证：packages/opencode/test/tool/registry.test.ts、code-mode-integration.test.ts与test/session/execute.test.ts：真实decoder、目录模式、层构建和标准工具调用。

### H128 · 声明独立字符预算

路径：`packages/opencode/src/tool/truncate.ts`；`@@ -23,6 +23,8 @@ export const GLOB = path.join(TRUNCATION_DIR, "*")`

职责：输出所有者定义可选字符模式。
机制：Truncate.Options 新增 maxChars；未设值继续旧字节/行模式。
必要性：R4 的 36,000 UTF-16 单位不能冒充 maxBytes 或行数。
不做会怎样：调用者无法明确选择字符模式；重用旧字段会混淆 Unicode 计费与输出上限。

生产者→消费者：SessionProcessor 完整回执与 maxChars:36000 → Truncate.output/write/notice → 有界首尾正文与完整恢复路径
源码：packages/opencode/src/tool/truncate.ts:23-30
验证：packages/opencode/test/session/execute.test.ts：最终模型35,999/36,000/36,001/60,000字符及失败/取消/图片；test/tool/truncation.test.ts：原默认截断。

### H129 · 在唯一输出 owner 中保存并首尾对半

路径：`packages/opencode/src/tool/truncate.ts`；`@@ -83,6 +85,21 @@ const layer = Layer.effect(`

职责：Truncate.output 产生带完整恢复提示的有界可见正文。
机制：maxChars 模式下短输出直接返回；长输出先 write 全文，复用 notice 并扣掉 notice 和四个换行，再各取 floor(余额/2) 首尾，边缘半个代理对向内收。未选字符模式继续原路径。
必要性：R4 要求 36K 包含提示、首尾 50:50 且恢复已捕获完整正文，不能先裁剪再保存。
不做会怎样：继续旧行/字节限制会裁掉短字符正文；无 notice 计费会超目标；无代理对边界处理会显示损坏 Unicode。此依据是当前内部调用的 36,000，不把它泛称任意小 maxChars 都有同样保证。

生产者→消费者：SessionProcessor 完整回执与 maxChars:36000 → Truncate.output/write/notice → 有界首尾正文与完整恢复路径
源码：packages/opencode/src/tool/truncate.ts:85-105
验证：packages/opencode/test/session/execute.test.ts：最终模型35,999/36,000/36,001/60,000字符及失败/取消/图片；test/tool/truncation.test.ts：原默认截断。

### H130 · 同步公开配置的生成类型

路径：`packages/sdk/js/src/v2/gen/types.gen.ts`；`@@ -2286,6 +2286,15 @@ export type Config = {`

职责：SDK客户端与ConfigV1 HTTP合同保持一致。
机制：运行仓库SDK build自动生成codemode布尔或对象联合，以及从Schema传来的中文说明；client生成检查零差异。
必要性：JSON新字段是公开配置API，SDK不能继续把合法设置视为不存在。
不做会怎样：只改服务端会让类型化客户端无法提交或读取Codemode配置；手工改生成物则下次生成丢失或漂移。
生成验证须从仓库根运行完整生成器并再次检查无漂移；仅比较冻结哈希不能替代实际运行。

生产者→消费者：ConfigV1 schema → 完整 SDK 生成器 → SDK Config 类型
源码：packages/sdk/js/src/v2/gen/types.gen.ts:2286-2300
验证：根bun script/generate.ts完整执行并重复生成；SDK、Client、OpenAPI全部生成路径无漂移。

### H131 · 同步公开配置的OpenAPI快照

路径：`packages/sdk/openapi.json`；`@@ -25497,6 +25497,26 @@`

职责：公开OpenAPI快照与ConfigV1和SDK类型使用同一配置合同。
机制：由根生成器最后一步导出codemode的boolean或对象联合，保留enabled、keep_tools与现有中文字段说明；只产生20行，不改生成脚本或运行逻辑。
必要性：SDK子脚本生成类型后会删除自己的临时JSON，不能代替仓库保存的公开OpenAPI文件。
不做会怎样：服务端和SDK接受codemode而公开快照缺少它；CI重跑完整生成器必然产生未提交差异，generated门禁继续失败。
生成验证须从仓库根运行完整生成器并再次检查无漂移；仅比较冻结哈希不能替代实际运行。

生产者→消费者：ConfigV1 schema → 历史 OpenAPI 生成链 → 公开配置快照
源码：packages/sdk/openapi.json:25497-25522
验证：根bun script/generate.ts完整执行并重复生成；SDK、Client、OpenAPI全部生成路径无漂移。

### H132 · 区分取消的真实 Execute 等待义务

路径：`packages/opencode/src/session/processor.ts`；`@@ -1136,6 +1177,8 @@ const layer = Layer.effect(`

职责：区分取消的真实 Execute 等待义务。
机制：正常和断流继续沿原 executions 等待全部登记及持久化；用户取消只额外等待实际 Execute invocation Promise。executeJobs 仅持有原 Promise 引用，不维护第二套完成标志或工具状态。
必要性：普通不合作工具与仅有事件的 Part 必须保留两秒孤儿宽限，不能把所有工具都变成无限等待。
不做会怎样：取消可能提前终态化丢失回执，或错误扩散为等待普通工具/人工询问而不能返回。

生产者→消费者：真实模型工具 wrapper → 原 SessionTools 调用/finalizer → Processor 终态回执 → 取消等待 → 通用 cleanup 与下一轮模型回放
源码：packages/opencode/src/session/processor.ts:1177-1184
验证：packages/opencode/test/session/execute.test.ts：200/3000ms三种退出、普通Bash、声明未调用、取消前后doom-loop及mixed cancellation。

### H133 · 把实际调用与回执持久化放在同一中断边界

路径：`packages/opencode/src/session/processor.ts`；`@@ -1144,6 +1187,7 @@ const layer = Layer.effect(`

职责：把实际调用与回执持久化放在同一中断边界。
机制：登记、原调用及 complete/fail 属于同一 bridge 执行区；进入真正人工询问之前保持该区不可中断。这里解释的 mask 在同一短控制块的下端施加，不增加独立生产者。
必要性：分离的 EffectBridge 根不能仅因消费流退出就提前写入错误；原调用 finalizer 必须先交出完整 partial 与上下文。
不做会怎样：取消可能提前终态化丢失回执，或错误扩散为等待普通工具/人工询问而不能返回。

生产者→消费者：真实模型工具 wrapper → 原 SessionTools 调用/finalizer → Processor 终态回执 → 取消等待 → 通用 cleanup 与下一轮模型回放
源码：packages/opencode/src/session/processor.ts:1187-1193
验证：packages/opencode/test/session/execute.test.ts：200/3000ms三种退出、普通Bash、声明未调用、取消前后doom-loop及mixed cancellation。

### H134 · 保护结算并取消后续人工询问

路径：`packages/opencode/src/session/processor.ts`；`@@ -1156,12 +1200,15 @@ const layer = Layer.effect(`

职责：保护结算并取消后续人工询问。
机制：bridge 使用原 toolAbort.signal，实际 start/调用/终态区 uninterruptible，终态后的 doom-loop ask 明确 interruptible。仅在真实同步 wrapper 启动 Execute 时把原 job 加入 executeJobs，原 executions 的错误归档和正常屏障保持原样。
必要性：只等待整个旧 job 会卡在已结算后的人工询问；只让 bridge 整体被 signal 中断又会抢在真实 finalizer 之前提交错误。
不做会怎样：取消可能提前终态化丢失回执，或错误扩散为等待普通工具/人工询问而不能返回。

生产者→消费者：真实模型工具 wrapper → 原 SessionTools 调用/finalizer → Processor 终态回执 → 取消等待 → 通用 cleanup 与下一轮模型回放
源码：packages/opencode/src/session/processor.ts:1200-1214
验证：packages/opencode/test/session/execute.test.ts：200/3000ms三种退出、普通Bash、声明未调用、取消前后doom-loop及mixed cancellation。

### H135 · 按真实 provider attempt 重置等待清单

路径：`packages/opencode/src/session/processor.ts`；`@@ -1173,6 +1220,7 @@ const layer = Layer.effect(`

职责：按真实 provider attempt 重置等待清单。
机制：原 executions 清空处同步清空 Execute 取消义务列表；前一 attempt 已由原正常屏障结算，两份列表只索引本 attempt 的真实调用。
必要性：旧调用引用不能在后续 attempt 重复计入等待；重置必须发生在接受新工具调用之前。
不做会怎样：取消可能提前终态化丢失回执，或错误扩散为等待普通工具/人工询问而不能返回。

生产者→消费者：真实模型工具 wrapper → 原 SessionTools 调用/finalizer → Processor 终态回执 → 取消等待 → 通用 cleanup 与下一轮模型回放
源码：packages/opencode/src/session/processor.ts:1220-1226
验证：packages/opencode/test/session/execute.test.ts：200/3000ms三种退出、普通Bash、声明未调用、取消前后doom-loop及mixed cancellation。

### H136 · 先完成 Execute 清理再运行通用取消收尾

路径：`packages/opencode/src/session/processor.ts`；`@@ -1262,6 +1310,8 @@ const layer = Layer.effect(`

职责：先完成 Execute 清理再运行通用取消收尾。
机制：用户取消先设置 aborted 并发送原 toolAbort，再 allSettled 等待真实 Execute job 的调用及回执落库，之后 halt/cleanup 沿原路径处理其它工具。普通工具和事件孤儿仍使用原有两秒宽限。
必要性：两秒只是普通孤儿宽限，不是 Execute producer 清理完成的凭证；否则三秒插件 finalizer 已读取的规则上下文、实际 partial 和恢复文件会丢失。
不做会怎样：取消可能提前终态化丢失回执，或错误扩散为等待普通工具/人工询问而不能返回。

生产者→消费者：真实模型工具 wrapper → 原 SessionTools 调用/finalizer → Processor 终态回执 → 取消等待 → 通用 cleanup 与下一轮模型回放
源码：packages/opencode/src/session/processor.ts:1310-1317
验证：packages/opencode/test/session/execute.test.ts：200/3000ms三种退出、普通Bash、声明未调用、取消前后doom-loop及mixed cancellation。
