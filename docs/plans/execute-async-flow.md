# Execute 设计与验证计划

## 1. 要达到的使用方式

Execute 用一段 JavaScript/TypeScript 组合工具调用，在代码里筛选和汇总中间结果，把下一步判断需要的内容交给模型。简单调用直接写，独立调用可以并发，前后有数据依赖的调用按数据流连接。模型不必替执行器维护取消、任务回收、参数包装和输出协议。

这次修改沿用现有解释器、工具入口和 Session 权限检查。异步函数、组合器、宿主调用和 sleep 共用一次执行的根作用域；Notebook 环境只保存变量、函数、闭包和数据，不保存上一轮权限。目录、搜索和运行时使用同一份真实工具合同。

以下方案覆盖 PR #1 相对共同基线 `a012050340b7eeed68488018205f2ed4cf8d4f0f` 的全部修改和本方案候选。目标分支为 `dev1-smark`，更新已有功能分支 `execute-async-flow`。

## 2. 一条执行路径，各层各负其责

1. Tool Registry 保存实际解码器。插件可修改展示说明，但不能把展示 schema 变成执行合同。
2. SessionTools 取当前可用工具、实际输入合同和输出协议，建立本次目录。
3. 宿主去掉一个完整的外层代码围栏，取得环境租约。同一个环境的执行串行到清理完成。
4. 解释器复制环境做有界预跑，收集已能确定的工具调用；宿主用同一段代码和已收集调用做整段检查。
5. 真实执行使用当前工具、权限、超时和日志。函数各有局部帧，闭包共享它捕获的 Binding。
6. 每个宿主调用经过唯一的八许可入口，拿到许可后才开始实际调用。原工具负责自身参数校验、权限和超时。
7. 脚本返回、抛错、超时或被取消时，根作用域停止并等完未结束的工作；随后交付结果、日志、调用终态、附件和环境 ID。
8. 最后释放环境租约，下一单元才能使用该环境。

解释器负责语言和词法状态；ToolRuntime 负责工具数据边界、签名和准入；宿主负责 Session、权限、MCP 协议资格、环境租约及模型可见输出。不要在数组方法、组合器或各工具外再接一层调度和清理。

## 3. 异步函数、组合器与清理

### 3.1 函数返回值与局部帧

`CodeModeFunction` 保存 AST 的 async 标志。`invokeFunction` 是普通调用、数组回调、Map/Set 回调和 replace 回调共用的入口。

每次调用创建新的 Interpreter 局部状态及参数 Map，捕获的外层 Map/Binding 保持共享。这样 `items.map(async (item, i) => ...)` 的 `item`、`i`、局部变量不会串扰，而两个闭包仍能共同修改同一个外层计数器。不能复制所有外层 Binding 来“隔离”回调，那会改变 JavaScript 闭包语义。

async 函数的参数默认值、函数体、返回值采用都在它自己的 Promise 生产者里运行。默认参数抛错也应成为拒绝，不能在调用处同步逸出。同步函数仍返回普通值；不把普通 map/filter 回调隐式改成 await。

`await` 普通值及已结算 Promise 也让出执行机会，再恢复后半段。否则 async 回调会抢在调用者随后的同步语句前执行。

验证：在公共 `CodeMode.execute` 同时启动多个 async 回调，用可控宿主等待交错恢复，分别检查局部参数、每个工厂实例的私有变量和共享外层计数。另测 async throw、默认值 throw、返回另一个 Promise 和 await 普通值的顺序。

### 3.2 Promise 只有一个生命周期所有者

`createPromise` 将工具调用、async 函数和组合器的生产者放入本次根 Scope。Promise 列表只记录身份和终态，用来在根清理后释放旧 Fiber 引用及产生未观察失败回执，不再维护另一套 pending 清理集合。

`observePromise` 读取生产者的 Exit；`settlePromise` 对 Promise 还原其语言结果或错误，对普通值原样交付。await、组合器、async 函数和链式回调共用这个结算入口。取消观察者不会取消生产者。

- `Promise.all` 同时观察所有成员，输出按输入顺序排列。后一项失败不能被一直等待的前一项挡住。
- `Promise.allSettled` 把普通拒绝变成 `{ status, reason }`，保留所有结果；宿主中断仍向外传播，不伪装成可继续的普通结果。
- `Promise.race` 只选择最先结算的结果。败方仍能再次 await；空数组保持 pending，直到本次执行超时或取消。
- 组合器本身也返回 Promise，能嵌套和传给另一个组合器。

`.then(onFulfilled, onRejected)` 和 `.catch(onRejected)` 返回根 Scope 中的新 Promise。读取成员时复用 IntrinsicReference 保留源 Promise；调用时先让出一次调度，再观察源的 Exit。纯宿主中断直接穿透，普通拒绝才作为回调参数；缺省或非函数 handler 原样传递结算。

handler 复用集合方法已有的 callback 入口，脚本函数、String、URI 函数和 sleep 不另建一套分发。同步或 async 回调返回的 Promise 都交给共同 settlePromise 采用终态；回调抛错进入新 Promise。回调直接返回正在建立的链式 Promise 时以 TypeError 拒绝，避免永远等待自己。

函数调用恢复原有 Effect.suspend 层次，但在其中新建独立 Interpreter 帧，不恢复旧共享 scope 交换。参数默认值和闭包共享仍按既有语义运行；原参数绑定/body 保持基线缩进，减少无关diff，不增加第二种函数调用路径。

验证：批量工具失败由catch恢复后再then变换；成功源不触发拒绝handler；非函数handler保留拒绝对象身份；String、URI与sleep共享回调入口；同步/async返回Promise及抛错、回调晚于当前语句、直接自循环、并发局部帧/共享闭包、宿主中断和跨格快照分别通过公共执行入口观察。

根 Scope 在正常返回、未捕获异常、超时和外部取消时统一收尾。已完成的工具不回滚；未完成工作必须结束清理后，宿主才得到最终结果。组合器里不手动 abort 兄弟任务。

`createPromise` 的 forkIn 和 Promise 登记在一个不可中断区内完成，子 Fiber 仍可中断。否则取消可以落在启动与登记之间，漏掉未完成工作。保留 async 首次 await 前的同步执行，不通过推迟所有子调用启动来避开这个窗口。

宿主工具还可能在原生回调内同步触发 AbortSignal。外层 timeout/race 若在登记根 Fiber 前就同步进入脚本，取消会漏掉这段执行。整段 operation 开始时让出一次调度，先完成外层登记，再进行复制、编译和脚本执行。这个让出点不放在取消通知或每个 async 函数内，仍保留同步取消与脚本内部的同步前缀顺序。

验证使用真实宿主 producer 的阻塞 finalizer：同步取消与已登记后取消都等清理完成，迟到结果不再发进度；真实 MCP 权限拒绝仍以中断结束，不能被脚本 catch 后返回成功。预取消不启动工具。两条路径共用同一根入口，不加末尾状态补判。

根结束后，保留环境中的 Promise 改存安全终态，不再持有 Fiber、私有宿主错误 cause 或旧权限。普通抛值仍可在后续单元观察；上一单元中断转为明确失败，不复活旧任务。

验证：保留一个共享 async 生产者，让它参加两次 race，再显式 await，预期生产者只完成一次且未被 race 中断。用前项挂起、后项失败检查 all；用后项直接和 async 包装的宿主中断检查 allSettled。分别在真实 question、shell、权限等待和实例关闭处验证取消、清理及已完成事实。

### 3.3 replace 与 for-await

异步 `String.replace` 是现有扩展，仍由字符串替换方法结算明确 async 回调的 SandboxPromise；捕获组、offset、groups 和 Unicode 零长度匹配沿用原实现。只在这个已有扩展处等待，不能把所有集合回调都自动 await。同步 replacer 返回 Promise 继续接受原数据边界检查。

`for await...of` 复用已有 Array、string、Map、Set 迭代入口。每次 next，包括 done，都有异步观察；产出 Promise 时等待它，再绑定循环变量。break、return、throw 的迭代关闭也遵循异步顺序，并释放循环绑定。普通 for-of 不改变。

验证：与原生 JavaScript 对照普通值、Promise 项、空迭代和退出顺序；保留解构绑定失败及 replace 的捕获、拒绝、中断、嵌套调用测试。这些属于不同方法的实际行为，不能因为已有 Promise 测试就全部删除。

## 4. 并发入口与计时

### 4.1 工具并发只放在 ToolRuntime

ToolRuntime 创建一个八许可 Semaphore。除同步 search 外，工具和 fetch 都经过同一个 `invoke` 包装；拿到许可后才做本次调用的计数、running 回执、真实参数解码及执行。

这使二十个独立调用能够同时进入脚本，但最多八个实际运行，其余等待。等待者取消不会生成一个假 running 调用，也不能在根结束后迟到地执行。

当前没有统一的 per-call timeout 参数。保留每个叶子工具自己的超时：它从真正调用叶子工具开始，因此不包含许可排队。不要为了满足“排队不计时”另造一层通用计时器。

验证：用二十个可控调用证明八个活动、十二个等待；逐个释放许可后再启动后排。给叶子工具装真实短计时器，让后排等待超过这个时长，取得许可后仍能完成。根取消后检查活动数归零，队列不再启动调用。

### 4.2 Execute 的可暂停预算

宿主 timeout 缺省为600000毫秒。脚本预算包含工具许可排队和普通工具工作；环境租约等待、预跑及初始整段审查发生在计时前。运行中的 question 和权限审批等待暂停预算，最后一个等待结束后只恢复剩余时间，不能重新获得完整十分钟。外部取消不受暂停影响。

库仍只有一个根执行与期限的竞争。宿主可提供 waitForTimeout(milliseconds)，库在真正运行时启动它；没有这个能力时用原 Effect.sleep，有明确 timeout 才创建期限竞争。期限先通知结束并等待同一根 Scope 清理，再构造最终超时回执。无需第二套后台任务或额外 root controller。

一次 Execute 在 SessionTools 创建一个预算对象，保存当前剩余时间、起算点、并发等待数及一个变更 Deferred。首个等待扣除已用时间并唤醒计时器；暂停期间不启动新的到期 sleep；最后一个等待结束后更新起算点并继续等待剩余时间。等待开始/结束用 acquireUseRelease 配对，拒绝、异常、中断都释放自己的计数。

SessionTools 将 pause 闭包放在本次 Execution 中，实际 child 与 fetch 上下文显式携带它。跨独立 run.promise 也引用同一预算，不能假定 Effect 上下文自动继承。ctx.ask 包住整个权限询问/审批过程；question 的实际工具执行包住同一个 pause。重叠审批和问题只暂停一次墙钟区间，其他 Execute 各自计时。

timeout 的支持范围为1至2147483647毫秒，库和宿主参数一致。现用 Effect 对更大的 sleep 不注册计时器，Number.MAX_SAFE_INTEGER 实际不是可靠期限；入口拒绝这个真实不支持范围，不增加分段长计时器。默认600000不变。

隔离实验使用公开 CodeMode.execute 和 TestClock：先用30毫秒，重叠等待期间推进2000毫秒仍不超时；取消一个等待者后仍暂停，最后一个结束后69毫秒仍运行，第70毫秒超时并清理。独立 runPromise 的暂停闭包有效，另一执行仍按自己的100毫秒预算到期。真实宿主回归再覆盖 question 回答/拒绝、权限升阶、等待中取消，以及普通工具等待仍会超时。

### 4.3 sleep 沿用根作用域

sleep(ms) 使用 Effect 的可取消等待，属于当前根 Scope，不占工具许可。sleep 保存为带身份的 builtin 引用，跨单元调用别名时绑定当前执行，不能捕获旧 Scope。宿主可提供本次 sleep 的 Effect；真实执行缺省仍为 Effect.sleep，只有预跑传入立即完成的 Effect.void，让探针跳过轮询时间。它仍创建根作用域内的 Promise，参数校验、异步观察和取消不变。毫秒值要求有限、非负且不超过2147483647。

不添加原生 setTimeout 管理表。已有可取消 sleep 满足脚本等待，根 Scope 负责释放计时器。验证默认与显式期限、环境排队后完整预算、真实 timer 注册及根退出释放、保存 sleep 别名后跨单元使用。

## 5. 输入合同与确定性简写

### 5.1 原解码器贯穿展示与执行

工具 wrapper 保存实际闭包使用的 `runtimeParameters`，Registry 在插件 description hook 之后仍保留这个引用。SessionTools 将它交给 `CatalogEntry.runtimeParameters`，宿主 `toolTree` 再传为 `Tool.make` 的 `inputContract`。

`Tool.make` 取实际 Effect input 为第一来源，其次取宿主明确提供的原合同，最后才使用 JSON schema。签名、字段搜索和简写从这一个来源派生；实际 decoder 仍只在原工具入口运行一次。

否则插件改了展示字段后，模型看到和简写识别的参数就可能不再是实际工具接受的参数。用 decoder 执行一次来猜输入形式也不可行：它可能转换值、应用 default 或产生效果，随后真实执行会重复一次。

### 5.2 只保留对象合同的正向简写

从 encoded schema 元数据识别确定性字段：只有一个必填字段，或整个对象只有一个属性。单个原始值可包装到该字段，随后继续经过原数据边界和 decoder。false、0、null 不能因真假判断丢失。

多必填字段不猜，高频名称列表不参与选择。`{ path, command }` 不能因为看见 path 就替用户选语义。只有一个可选字段的既有简写仍保留，default/refinement 仍由原 decoder 处理。

删除标量合同的任意单键对象反向拆包。字符串工具收到 `{ anything: "value" }` 时应由原字符串 decoder 拒绝，不能把包装键当成无意义内容抹去。encoded string→number 的转换也只接受原来的 string 输入。

`inputForms` 只作为内部派生实现，不另导出一个仅供测试使用的分类 API；测试通过 `Tool.make` 和 `CodeMode.execute` 验证实际行为。

验证：原始标量、唯一必填、唯一可选、多必填、false/0/null、encoded 转换、default/refinement、展示 schema 被修改时的实际权限和参数。隔离实验中，删除反向拆包后十个对照场景通过；两个错误对象包装均未触发宿主执行。

### 5.3 工具身份使用规范路径

调用使用 catalog/search 给出的完整工具路径，例如 `tools.$opencode.read("a.ts")`。对象合同的单参数简写负责消除包装差异，工具身份仍由这个明确路径确定，继续进入同一参数校验、权限和准入入口。

全局短名不能仅凭“当前有一个同名工具”就替代未解析的变量。例如 `await glob(); if (false) var glob;` 中，局部声明本应阻止工具调用；直接回退会把名称解析错误变成实际副作用。正确处理还涉及参数、解构默认值、循环和 catch 的声明域，不是修改工具分发入口就能解决。

这里保留明确路径，不把工具发现功能扩成解释器声明规则改造。模型误调 namespace 时仍直接得到该组签名，参数包装仍由第5.2节处理；这两项恢复均不猜测工具身份。

## 6. 工具发现：紧凑目录，详细搜索

### 6.1 一份签名，四个出口

`tool-schema.ts` 从真实 inputContract 和真实 output 生成紧凑单行 TS 签名。没有输出合同就写 unknown，不能为 grep/read 等工具编造数组或字符串返回值。

catalog、instructions、search 和 namespace 误调用提示复用同一个签名函数。签名只展示标准具名输入，不给每个工具重复追加简写 union；运行时简写不受影响。

内联目录从完整工具索引选择展示项，选择不删除实际能力。宿主只给当前确实存在的原生 read、grep、glob、edit 路径优先级；全局 search 是独立发现入口，不伪装成一个 leaf tool。其余项按签名长度、完整路径稳定排序，namespace 标题也计入预算。预算太小时可能连核心项也放不下，因此用完整 search 接续，不声称排序就能保证任何工具永远显示。

搜索仍按 query 相关性和路径排序，不能把内联目录的优先级和长度排序偷偷用于搜索。

namespace 被当作函数调用时，现有 UnknownTool 错误直接附该 namespace 下的真实可用签名，2000 字符预算内只放完整签名，余项注明数量和 search 入口。不要自动选择一个工具执行，错误恢复不能制造副作用。

### 6.2 搜索分简略与详细两种视图

宽泛 search 默认简略视图，返回规范路径、工具说明和完整紧凑 TS 签名。它回答“该用哪个工具”，不会顺手广播每个候选的完整 schema。查询精确工具路径时自动进入详细视图，宽泛搜索也可显式使用 `detail: true`，在相同工具说明和签名之外补充字段合同，适合确定工具后查参数、默认值与限制。两种视图共用既有排名、精确路径匹配和同一个签名 renderer，不建第二套工具表。

详细命中项提供 `inputSchema`，有输出合同时再提供 `outputSchema`，从该工具的真实 inputContract 发射 JSON Schema，并把 `definitions` 接回 `$defs`。字段 description、default（包括 false/0）、format、minItems 和引用保留。输入按 encoded 域发射，输出按 decoded 域发射；例如 Effect NumberFromString 输出 schema 包含 number 及其非有限数哨兵，直接保留库发射结果。

详情仅在详细视图选中条目后生成，不加进 catalog 的 ToolDescription。SearchOutput 把详情字段声明为可选；简略视图不发射 schema，详细视图继续提供可选的 `schemaUnavailable`。

Effect 合同可能合法却无法表示为 JSON Schema，例如 Symbol 属性或索引。输入、输出各在详情发射处处理这种失败：失败侧返回 null，并在 `schemaUnavailable` 中列出 input 或 output；另一侧与同页其他工具保持完整。工具路径、签名和排名不丢失，也不用空对象假装完整合同。只处理 schema 发射异常，分页序列化及实际工具执行错误仍走原错误出口。

完整字段资料不能为了减少默认输出而被永久删去。工具已有的使用示例随详细 description 保留；不根据参数名自动编造每个工具的示例，也不另造多行 pretty renderer。

### 6.3 数量与16K软预算共同分页

沿用现有 `limit`、`offset`、`remaining` 和 `next.offset`。简略视图缺省十项；详细视图缺省并至多三项，用户可用 limit 取得更少项。精确路径查询只匹配该工具，自动带详情且只返回一项；detail:false 不隐藏精确命中的合同。模型想读更多详情时继续下一页，而不是一次请求全部 schema。

两个视图都按完整 `JSON.stringify(response).length` 计算页面大小，目标16384个 JavaScript 字符单位。按既有排名加入完整条目，首次达到或超过预算便结束；跨过阈值的这一项保留。所以单个超长工具仍完整可见，下一页从后一项开始，不分割 schema、不引入碎片协议。返回的 remaining 与 next 依据实际加入的数量，不依据请求 limit 推算。

read 的正文限制是16384 UTF-8字节，另有默认200行与16000估算token检查；它会整行省略超长行。search 使用完整条目向上取整，不能沿用会丢掉唯一工具说明的行为。字符不是UTF-8字节或真实模型token。

验证使用同一十四工具集，分别记录默认简略、详细三项、精确详细一项的字符与工具数；另遍历全部页面，确认完整条目有序、没有重漏。该夹具默认简略十项1368字符，详细三项2167字符；同一精确工具的基本字段171字符，加完整详情746字符。最终精确路径直接返回详情，不需要第二轮查同一个工具。两种视图签名逐字一致，详细 limit:99 仍只返回三项，limit:1 返回一项，沿 next 遍历十四项没有重漏。数字只适用于该工具集，不能推断真实模型token或所有工具的费用比例。

字段回归显式使用详细视图：真实 encoded 合同、嵌套/$defs、false/0 default、字段文档及逐侧不可表示标记。简略视图验证不会发射 schema，签名仍完整。两种视图分别覆盖 limit、offset、跨阈值、超长单项与Unicode/转义；目录内容仍来自同一个 renderer。

### 6.4 目录密度实测

同一工具集、同一目录预算下分别跑修改前后 `prepare`，记录实际展示数量、签名字符和完整 instructions 字符，不用猜测百分比。

已有2000估算 token 预算样本：九个真实内置工具仍为9→9；九十六个受控工具66→72；一百零五个混合集55→60。签名字符分别2944→2881、8735→7007、11680→9889。更多工具被装进目录时，完整 instructions 可能略增，不能把签名缩短直接称为总输入或费用下降。

## 7. Notebook 环境

### 7.1 保存什么，刷新什么

Environment 保存 globals 和用户 bindings 两个根。普通变量、函数、闭包、数组、对象和受支持容器跨单元保留。每轮重新绑定 tools、fetch、sleep、日志、调用计数、根 Scope 和超时。

顶层可在后续单元重新声明变量，方便重跑；同一单元及函数局部仍保留重复声明约束。失败前已经发生的变量修改和工具副作用不自动回滚。

宿主每次返回可见的 Environment ID，后续传入即可复用；不传则新建。错误或取消时也保留已创建 ID。ID 使用仓库现有生成器并检查当前集合碰撞，不为了六位外观引入新的碰撞算法。

### 7.2 同环境串行和回收

`execute-environments.ts` 使用现有 InstanceState、SessionStore 和事件服务。ID 归属同一 Session、directory、workspace；拿到租约后再核对当前位置，运行期监听删除、移动与 workspace 变化。

一个环境最多有一个实际执行者。排队者计入使用人数，取消只释放自己的租约，不取消持有者。根 Scope 的 finalizer 完成之前不放行下一格。

每个 Session/Location 保留最近调用的八个唯一环境。Map 顺序只在 acquire 接纳调用时刷新；复用同一 ID 移到最近位置，不增加数量。释放租约不改顺序，避免较早开始的慢调用因最后完成而变成“最近使用”。

新建第九个环境时选该 owner 最旧的一项。若它仍有人持有或排队，新建者等待已有 drained 信号，然后重新读取最新使用顺序；等待可以被外层取消，不提前分配第九个环境，也不跳过最旧忙项去删较新的状态。最旧项闲置后按原退休路径删除，再创建新环境。其他 owner 的调用不挤占这八项。去掉全局64项策略，不叠加 TTL、历史调用扫描或第二个缓存。

退休先关闭准入，再发取消；保留条目直到使用人数归零。实例关闭等待所有真实 finalizer，不能只删 Map 引用就声称清理完成。Session 在自己的 cell 内被删除时，事件回调只发退休，不等待自己，避免死锁。

验证：跨格闭包与别名、重声明、失败状态、当前工具/权限、同环境排队、排队取消、九进八出、复用刷新、重复不占槽和 owner 隔离。并发实验让两个新建者等最旧活动环境，取消第三个等待者，再复用旧环境更新顺序；收尾后必须依据新顺序淘汰，取消者不能留下租约。保留 Session delete/move/workspace 和真实 Instance.dispose 等待清理。

### 7.3 每次预跑使用独立的环境副本

预跑在已有环境租约内深复制一次 Environment，再用当前探测工具执行同一份源码。它可以读取上一单元的变量和 helper；变量赋值、闭包私有计数及对象变异只发生在副本中。预跑结束后沿同一根 Scope 收尾，副本不进入环境注册表，随后释放引用。

复制只有一个递归入口和一个身份 memo。Map 的键和值、Set 的成员、类实例的自身字段都递归复制；新对象先登记再复制成员，闭包循环和对象别名因此指向同一个副本。保留解释器类的只读原型，函数捕获的 Map/Binding 作为普通自身数据一起复制，不另维护一套闭包恢复规则。

RegExp 用原 source/flags 创建，再复制 lastIndex 等自身描述符。自身属性按描述符复制，不执行 getter，同时保留非枚举错误品牌和 text。原文来源存于 WeakMap，在共同复制出口复用 rawText/withRawText，使 String、模板字符串和 text 不改变待审工具参数。

不能沿这个入口安全复制的 URL、宿主函数或访问器直接结束本次预跑。它仍是启发式探针：工具返回 null，脚本依赖真实结果时也可能提前停止。宿主保留已经收集的调用，整段审查使用同一规范化源码；真实调用始终经过现有权限入口。无需另设复制失败类型、恢复器或模型提示。

预跑只设一个2000毫秒执行期限，保留已有日志留存限额，不增加访问次数或工具调用次数预算。sleep 在预跑中立即结算，不重复真实轮询等待；普通工具仍返回 null。到期会发起根取消并等待清理，因此整体返回可晚于2000毫秒；同步复制和编译也不能被同线程定时器硬抢占。

选择这个小入口是为了既保留闭包原型，又不共享 Map 对象键等可写状态。现成复制方案的实测分别出现原型丢失、闭包环失败或旧对象共享；不以增加依赖来隐藏这些语义差异。核心复制函数维持正常排版，复用同一个身份 memo。

验收保留三个组合场景：旧 helper、私有计数、对象别名/Map 与原文参数共同验证可发现且不写回；无法复制时停止预跑、真实环境仍可正常使用；两秒超时后真实状态保持。原来空环境下旧 helper 不可见的复现与省略复制导致污染的隔离负控分开记录，不把负控冒称原生产行为。

## 8. 返回值、协议投影与失败事实

### 8.1 JSON 文本投影由 MCP 协议层决定

MCP catalog 仅为成功、单 text、无 outputSchema、无 structuredContent 的结果标记 `rawText`。独立媒体仍由附件通道交付。多块内容、资源、协议错误和有声明输出的结果保持原协议语义。

宿主只对这个标记调用 `CodeMode.fromJsonText`。文本是 JSON 对象/数组时，经过原 copyIn 边界进入解释器；不是对象/数组或不可表示时保留原文本。不要递归拆业务对象里恰好叫 content/text 的字段，也不要把声明为 string 的工具悄悄改成 object。

WeakMap 保存原文本。String 和模板字符串可取原文；内部副本在业务对象没有 text 属性时可提供非枚举原文别名。业务 text 优先，JSON.stringify 和最终结果反映当前业务数据；map/spread 得到的新根不继承旧文本。

输出 decoder 先验证，随后再传递来源，避免非枚举别名影响合同。copyIn 的数组和对象分支都传来源，内部沙箱值复用同一个类型判断，不维护第二份容器名单。

验证：真实 MCP transport/SDK 输出验证、JSON 对象与数组、业务 text、修改后 stringify、decoder 重建、structuredContent、错误/多块/资源、附件和已声明字符串。不能仅用模拟返回对象替代协议测试。

### 8.2 返回结果与日志分开

显式 return 是业务结果；没有 return 时使用已有最后一个产值表达式。Console 走独立 logs 通道，无业务返回时仍可见，但不能把一条日志当作失败后的成功结果。

附件和已加载指令属于宿主交付，即使脚本只 `return 1` 也不能丢掉。环境 ID 在成功、错误和中断出口都保留。

### 8.3 只提醒未观察的异步失败

根 Promise 清单记录一个 `observed` 位：观察者真正收到 Exit 后才置位，不在开始等待时置位。否则观察者先被取消，生产者随后失败，会被误认为已经处理。即时 Promise.resolve/reject 也进入同一登记路径。

根清理后，若仍有未观察的失败或中断，成功 Result 带 `unobservedFailure: true`。宿主附一句通用提醒，不把所有 failed child 的名字都归到未观察任务名下。try/catch 和 allSettled 已观察的失败仍保留在调用审计中，但不再重复警告。

这个位表示“结果是否被观察”，不声称理解脚本是否认真处理了错误。未捕获失败仍走错误出口，已经完成的副作用不回滚。

现有输出限额重建 Result 时用原 Result 展开，保留新增事实，原有日志截断标记继续覆盖被裁剪的日志。

验证：已 catch、allSettled、未 await 工具失败、即时 Promise.reject、取消等待后失败，以及同脚本混合已观察/未观察两类失败。警告只反映未观察事实，最终调用状态和已完成结果仍准确；截断后这个事实仍存在。

## 9. 进度、诊断与输出体积

### 9.1 在发送前合并进度

宿主 `publish` 在复制调用列表之前检查100毫秒机会窗口。创建环境的第一条更新持久化；第一条真实进度立即以 ephemeral 发送，窗口内后续进度跳过快照和发送。下一次事件到来再判断，不建立 timer、后台 fiber 或新的调度器。

最终成功走既有 ToolResult 持久化，失败和取消走既有 onExit 持久化。子调用的权限、hook、持久化审计和终态不合并、不跳过。每条发送都带同一个 Environment ID。

原实现20次调用产生41条父进度、420份浅条目复制；100次产生201条、10100份。隔离候选的短突发均为2条父进度、1份条目复制，最终结果仍含全部20/100项。200毫秒长调用运行中可见，结束后无延迟事件。这里测的是实际宿主回调和快照体积，不是数据库延迟。

无定时刷新意味着窗口内被抑制的中间状态可暂时滞后，下一事件或最终结果会纠正；不为这个短暂 UI 状态另建后台任务。

### 9.2 报清楚调用对象，不重新执行它

当前 `x={files:[]}; x.map(...)` 报“只有工具可调用”，掩盖了实际问题：x 是对象，不是数组。

调用入口只计算一次 member reference，把已有 reference 传给共同 `readMember`，失败时利用同一 receiver 提供类型与最多八个键名，每个最多64字符。只展示形状，不读属性值，也不再求值 receiver、computed key 或参数。可选链保持短路。

TypeScript 解析失败时，从原始 SourceFile 和 diagnostic.start 取得位置；只有 start 落在用户脚本内才附上 source line/column。包装函数占一行，位置扣除这一行，列号使用 TypeScript 的 UTF-16 偏移。EOF 或诊断落在包装器里时只保留原错误，不编造源码位置。

源码转译后的运行期位置仍可能指向生成代码。这里只为解析阶段补可靠位置，不把现有运行期位置当作原始 TS 代码框，不引入另一套 sourcemap 管线。

验证：对象误用 map、标量不可调用、receiver/key/arguments 各只求值一次、可选链不求值参数。解析位置用单行、多行、中文/emoji、CRLF 和越界诊断验证；隔离实验分别得到源码1:11、2:24、1:28、3:24，越界诊断不附位置，合法 TypeScript 仍返回原值。该位置相对于去掉围栏后的脚本。

### 9.3 日志追加有界，结果交统一截断

为日志增加独立的 `maxLogBytes` 执行限额。宿主和预跑都从已有 Truncate 配置取 maxBytes，不增新配置项。所有函数帧调用本次执行的同一个 log 函数；累计 UTF-8 字节超限后停止保存新行，只计省略数，最后返回一条截断标记。

这个限额约束日志留存，不改变业务 return 的值。现有 maxOutputBytes 是执行后的结果预算，不能代替追加时限制。单次日志格式化仍会产生那一行字符串，追加限制解决的是循环持续累积的留存。

Execute 只组成最终正文：Environment ID、未观察失败提醒、实际收取的上下文、脚本结果和已捕获日志。正文交给既有 Tool.wrap，沿统一 Truncate.Service 截断、落盘和返回恢复路径。宿主不另写折半 JSON 预览，不手动设置 truncated/outputPath，也不在 copyOut 中悄悄截掉业务数组或改变返回类型。

截断后的正文可能只有 JSON 的一部分，统一提示会明确省略内容并给出完整文件路径，模型可用 read 分页继续读取。SessionTools 沿原规则清空没有完整交付的 loaded/skills 声明，下一轮可以补交；附件继续单独交付。

验证：长循环日志受限且业务对象不变；并发函数共享 UTF-8 预算，错误出口保留日志标记。再用一个真实 Tool.init/wrap 大结果流程确认只落盘一次、正文有统一提示与恢复路径、完整文件中保留 Environment ID、全部业务结果、上下文及已捕获日志。验证恢复文件的完整 JSON，不要求截断片段本身是合法 JSON。

## 10. 提示词和文档

提示词按“用途与收益 → 使用时机 → 一条真实例子 → 必要边界”组织。工具路径和返回值以实际 schema 为准，不照搬平铺的 glob/read 或把 read 当字符串。

只在需要的工具没显示时搜索；默认先看简略候选，精确路径会自动返回完整参数与说明，detail:true 可一次查看少量候选的详情。例子先 glob，取前八个文件并行读取一行以取得行数信息，再返回超过200行的文件；保留 listing 的截断信息及 totalLinesExact，不能把采样说成完整项目统计。

直接说明 return 的结果、最后表达式、简短 console、sleep、宿主可选 fetch 和 Environment ID 复用。Promise.allSettled 用于保留部分结果，说明失败也在其中。代码如何处理具体业务错误由任务决定，提示词不规定每次调用都包 try/catch。

共享 `code-mode.txt` 的两个宿主出口一起检查。例子从实际 description 提取后执行，使用真实文件工具，验证普通文件、截断列表、超过200行和不精确行数。README 同步真实全局 search、标准工具路径、race 只选结果、根清理、环境和输出行为。

`code-mode.txt` 删除新增的中文维护段，不新增中文注释，也不计入本计划的中文说明分子、分母或逐 hunk 注释检查。提示词仍按真实能力写清抽样和行数精度。目录只说明“在 execute 内使用这些路径”，不再声称这些工具只能在 execute 中调用；是否能直接调用由本次 provider 工具清单决定。

### 10.1 Execute 与原工具的两个开关

沿用已有 RuntimeFlags 配置服务，增加 OPENCODE_EXECUTE 与 OPENCODE_EXECUTE_KEEP_TOOLS 两个布尔环境变量，均缺省为true。前者决定是否启用 Execute，后者只在 Execute 启用时决定是否把原工具同时展示给模型。它们在启动时读取，修改后重启生效；不改变工具执行权限，也不复用 tools 字典中的权限兼容项。

- OPENCODE_EXECUTE=false：显示原工具，不提供 Execute 及它的动态目录；第二个开关不影响这个模式。
- 两项为true或缺省：维持 Execute 加原工具双入口。
- OPENCODE_EXECUTE=true、OPENCODE_EXECUTE_KEEP_TOOLS=false：原工具仍进入 Execute 的完整可用目录，只从 provider 的直接工具集合隐藏。StructuredOutput、权限审查等不进入脚本目录的控制工具保持原用途。

Registry.all 在共同列表出口过滤关闭的 Execute，ids、实际工具、TUI 选择器和调试入口因此一致。SessionTools 先生成经过当前权限筛选的 eligible 和 catalog，再应用 provider 显示选择。隐藏原工具不删内部定义；权限禁止某项时，无论直接或嵌套调用都继续禁止。Execute 被权限禁止时不悄悄恢复被设置隐藏的原工具。

这些开关属于进程级运行模式，不提供逐项目 JSON 配置。现有 RuntimeFlags 已由实际运行和测试层提供，增加字段不改变公开 Config HTTP/SDK 合同，也不复制另一条配置解析链。实际 SessionTools 验证三种模式，Execute-only 仍能真实读文件；权限拒绝不改变显示策略。再通过 ConfigProvider 验证默认值和环境变量字符串 false 的真实解码。

## 11. 测试按最终功能组织

保留四层验证：语言/值的公共 CodeMode 入口，工具 schema 与协议适配，真实 Execute 宿主，真实 Session 资源生命周期。测试夹具复用已有入口；一项断言有不同文字，不代表它需要一项独立测试。

| 测试文件 | 保留的独立行为 | 精简方式 |
| --- | --- | --- |
| codemode/test/codemode.test.ts | 发现、核心优先、namespace、输入合同、语法位置与限额 | primitive 输入用例归入已有 schema flexibility 组；完整保留 fixture、断言与说明，只删重复 import |
| codemode/test/environment.test.ts | 跨格闭包、状态、当前能力、快照隔离 | 删除中间图克隆器的反序 URL/访问预算矩阵；保留三项公开组合场景 |

| codemode/test/promise.test.ts | async、all/allSettled/race、根清理、准入、sleep | 多个旧 race 取消机制变体合为共享生产者流程；六种 timer 退出合为真实 timer 释放；保留独立根失败和同步取消登记窗口 |
| codemode/test/signature.test.ts | 四出口同源、真实 encoded 合同、搜索详情/分页 | 复用现有合同 fixture，删除重复四出口示范 |
| codemode/test/stdlib.test.ts | replace、for-await、原 builtin | 保留方法自己的绑定、关闭和回调边界 |
| codemode/test/text-result.test.ts | JSON 投影、原文、业务 text、decoder/出口 | 五处重复执行脚手架复用已有 run fixture |
| opencode/test/mcp/catalog.test.ts | 真实协议资格与 SDK 输出校验 | 保留真实 transport，避免只测内存对象 |
| opencode/test/session/execute.test.ts | 权限、HTTP、question/shell 清理、可见回执、真实例子 | 用 async race 后继续 await/return/abort 的一个流程替代更弱的 question-only 变体 |
| opencode/test/tool/code-mode-integration.test.ts | wire JSON、附件和公开参数 | 保留协议到宿主的薄集成 |
| opencode/test/tool/code-mode.test.ts | 预跑、整段检查、租约预算、取消、统一输出截断/进度 | 在现有夹具补关键行为，不复制另一套宿主 |
| opencode/test/tool/execute-environments.test.ts | owner、最近八项、调用顺序、等待和实例回收 | 删较弱 registry dispose/queued-cancel，用真实实例等待 finalizer 和真实排队宿主覆盖 |
| opencode/test/tool/registry.test.ts | 插件展示变化与原参数、两个提示出口 | 保留实际 registry 路径 |

共享 race 流程检查输出 `["first", 7, 7]`、生产者完成一次、未被 race 中断。根失败用例检查 result.ok=false、未完成生产者清理且之后无迟到副作用。实例关闭保留阻塞 finalizer，并断言持有者失败；简单“调用过 dispose”不足以替代。

保留测试有对应负控：恢复 race 取消成员、让 sleep 不注册 timer、每格重建词法根，测试分别失败。删除已经被这些共同入口覆盖的中间机制测试，保持正常换行，不按预设比例删断言。

### 逐项红绿验证

1. 异步和根生命周期：先跑公共同步取消登记复现。工具在开始时发就绪、finalizer 等待第二个门闩；旧实现会过早返回，修复必须等清理门闩。随后跑 async 顺序、组合器及真实 Session 资源测试。
2. 输入与签名：先用原 scalar 合同拒绝任意单键对象的断言变红，再删除反向拆包；正向简写和原 decoder 转换仍通过。签名仅显示标准输入。工具身份保持规范路径，未绑定短名不进入宿主调用。
3. search：默认模式先断言没有 schema、详细模式最多三项；旧实现默认广播详情且不限制详细数量。详细模式保留字段文档、encoded 类型和16K完整条目分页，仍沿同一个 offset 入口。
4. 环境预跑：旧 helper 在真实执行调用工具、但 host.begin 看到空列表的复现先失败；通用深复制后验证探测调用和真实状态各自正确。复制失败和超时允许少收集，不能写回原环境。
5. 回执：已 catch/allSettled 不应有未观察提醒，未 await/即时拒绝应有；混合时不误报工具名字。先改变断言，再收敛 Promise 观察位和最终提醒。
6. 进度：在实际宿主入口量测突发更新数量、运行中可见状态、最终完整状态和取消后的无事件。窗口检查必须在列表复制之前。
7. 诊断与输出：对象误用 map 的错误先失败；保存一次 member reference 后核对形状和求值次数。长日志和大结果通过原 Tool.wrap 验证，保证日志留存上限、完整恢复文件、统一截断提示和附件。

围栏在一个轻量真实宿主用例中验证同一规范化源码进入预检、整段审查和执行。Session 权限回归分别保留动态与预检路径，不再与 fenced/raw 交叉翻倍运行。

同步测试使用 Deferred/就绪信号，不靠固定 sleep 猜任务是否已启动。只有节流窗口和真实计时器本身的测试等待实际时间。

8. 暂停预算与最近八项：先以当前固定 timeout 复现 question 等待消耗预算、当前64项/释放顺序保留错误环境；再通过 TestClock 和真实租约门闩验证剩余预算、重叠等待、独立执行、取消以及最新使用顺序。原真实 Session 超时清理用例改由普通工具阻塞触发，保留已经完成写入和迟到写入禁止的断言。
9. 显示开关：旧模式无论配置都同时提供 Execute 与原工具；实际 SessionTools 用三种组合验证目标工具集合和内部调用能力。默认组合保持原回归，其他组合新增针对性测试，不整批 skip 权限和生命周期覆盖。
## 12. 每处生产修改的职责与必要性

本节对应共同基线 `a012050340b7eeed68488018205f2ed4cf8d4f0f` 到候选的全部生产差异。Git 默认三行上下文共切分为18个文件、109个 hunk。每个文件列出源文件和候选文件 SHA-256；每个 hunk 列出完整差异的 SHA-256、精确边界与职责。首尾片段取自该候选 hunk 的连续原文，在各自文件中唯一；` ⏎ ` 表示一个原始换行，保留其余字符。新文件的源哈希按空文件计算，源状态另行注明。

各项“不做会怎样”描述省去对应修改的具体后果。导入和字段传递说明服务哪个实际调用点；注释与格式只说明维护作用。hunk 哈希覆盖原始 `@@` 头、逐行差异和尾换行，不含文件头。

### packages/codemode/src/code-mode.txt：共享提示词

源文件 SHA-256：`6cec77efb4382902e35a16cc62b88f98c0cd4c1cbfa23ef133763c79ccd304e5`
候选 SHA-256：`c3d657af12c704bb63455a534222b208c06bf48795cdaed66c357920e7d0df4b`

#### H001 · 按实际工具合同说明 Execute 的使用方式

差异：`@@ -1,27 +1,35 @@`；SHA-256：`6ace2acaa2f5e1ba3bd2d86d1ef4ac33f578f11cc410e57655c77f6441d37d09`
首段：`@@ description ⏎ Run JavaScript/TypeScript in a confined runtime to compose tool calls and filter intermediate data before returning a concise result.`
尾段：`- {{searchSignature}} ⏎  ⏎ ## Code Mode tools`

职责：共享提示词说明何时组合调用、如何控制输出，以及完整和局部目录的发现方式。

机制：先写用途，再给真实glob/read有界示例，保留listing、totalLines和totalLinesExact；只在需要的工具未显示时search。简略候选确定工具后可用detail:true查询完整字段。删除新增中文分段，目录只描述execute内的调用路径，不再限制同一工具直调。

必要性：模型需要能直接执行的示例，并知道采样范围和当前能力。完整目录与局部目录分别给出发现指引。

不做会怎样：旧说明仍称sleep不存在、fetch总可用，并把默认可以直接调用的工具错误地标成只能在execute内调用。示例不能表达有界采样和按需详情；中文注释删除不影响模型文本。

### packages/codemode/src/codemode.ts：公共接口

源文件 SHA-256：`33421e122353da5a3fd495318578fbe56c3b604e964778ea3db26b85fad3bf54`
候选 SHA-256：`83520882978794c82410e8d95cb5af7060eccb2b85bdd0f7780387c675e6b58a`

#### H002 · 提供环境的公共类型与工厂

差异：`@@ -1,11 +1,17 @@`；SHA-256：`1d25ddcd9e41b3437c19f06128db3d9b70a7d6a2d63fda2dae059bd8a21b98a6`
首段：`import { withRawText } from "./raw-text.js" ⏎ import { Effect, Schema } from "effect"`
尾段：`export type ExecutionLimits = { ⏎   /** Maximum wall-clock execution time in milliseconds. No default: absent means no timeout. */`

职责：让宿主持有、创建解释器环境，不暴露独立的宿主状态容器。

机制：导出 Environment 类型和 createEnvironment()；Environment 导入服务工厂，withRawText 导入归 H008 的文本投影使用。

必要性：宿主环境注册表需要稳定入口创建词法状态；来源投影也需要复用同一个元数据函数。

不做会怎样：缺少工厂就没有公共环境创建入口；单独删掉配套导入会留下未解析标识符。导入本身没有额外运行时策略。

配套修改：H008、H010、H101。

#### H003 · 声明日志预算与目录优先级

差异：`@@ -14,12 +20,16 @@ export type ExecutionLimits = {`；SHA-256：`5ba73aea0f5e431a01d237b25e65f5eb8da029edc6c17a79cd78e337941bd29f`
首段：`  readonly maxToolCalls?: number ⏎   /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */`
尾段：` ⏎ type ToolTree<R = never> = {`

职责：在公共选项中区分日志留存预算和目录展示优先级。

机制：ExecutionLimits 增加 maxLogBytes；DiscoveryOptions 增加由宿主提供的规范路径 priority。

必要性：日志追加限制不能由执行结束后的 maxOutputBytes 代替；原生核心工具优先级也不能靠库猜名字。

不做会怎样：调用者无法通过类型明确传入这两项需求；实际行为仍分别由 H045 和 H064 实现。

配套修改：H045、H064。

#### H004 · 声明复用与预跑环境选项

差异：`@@ -30,16 +40,25 @@ export type ResolvedExecutionLimits = {`；SHA-256：`78df7a74903287f5492432dfbdb29d9853fd5418c2b4aecfed630d6b33722274`
首段：`  readonly timeoutMs: number | undefined ⏎   readonly maxToolCalls: number | undefined`
尾段：`  limits?: ExecutionLimits ⏎   /** Observes decoded tool input immediately before tool execution. */`

职责：把环境复用和独立预跑作为一次执行的显式选择。

机制：ResolvedExecutionLimits携带日志预算；ExecuteOptions增加复用/快照环境与宿主waitForTimeout能力。宿主计时器可排除人类等待，库仍拥有唯一根执行和期限竞争。 ExecuteOptions另提供本次sleep效果，探针可省略真实等待而不改变执行期限。

必要性：宿主需要选择旧词法状态、安全预跑和计时来源；不能在库里引入Session/审批概念，也不能在宿主再包第二套相互竞争的超时。

不做会怎样：缺少环境字段会失去Notebook状态或安全预跑；缺少计时能力入口，运行中question和审批仍会消耗固定预算。

配套修改：H046、H100。

#### H005 · 在成功结果中声明未观察失败

差异：`@@ -92,6 +111,8 @@ export const Success = Schema.Struct({`；SHA-256：`e5c091b61c790070df6369ffba1c78fdb0adc7c94fc0998a5a10a28c01401f19`
首段：`  value: Schema.Json, ⏎   logs: Schema.optionalKey(Schema.Array(Schema.String)),`
尾段：`}) ⏎ /** Successful execution after the result has crossed the plain-data boundary. */`

职责：让脚本成功与异步子任务的失败事实同时表达。

机制：Success schema 增加可选 unobservedFailure，字段只在根清理后发现未观察失败时给出。

必要性：宿主需要一个真实结果字段决定是否附提醒，不能把所有 child error 都称作未处理。

不做会怎样：成功结果合同无法携带这项事实，宿主只能遗漏提醒或自行猜测。

配套修改：H046、H100。

#### H006 · 校验日志预算

差异：`@@ -123,17 +144,21 @@ const validateLimit = <Value extends number | undefined>(`；SHA-256：`103f39f324efef1640f1853416b5af1d70328059f340d412854e457b90e04548`
首段：`  name: keyof ExecutionLimits, ⏎   value: Value,`
尾段：` ⏎ /** Executes one Effect-native CodeMode program without constructing a reusable runtime. */`

职责：让 maxLogBytes 与现有执行限额共用合法值检查。

机制：resolveExecutionLimits 调用 validateLimit，允许零预算，保留未设置为 undefined。 timeoutMs复用validateLimit的上限参数，限定到Effect真实支持的2147483647毫秒；其它限额仍保留安全整数范围。

必要性：日志限制需要在进入执行器前完成数值校验，零值也应保留。

不做会怎样：只声明字段而不解析，执行器拿不到已校验的日志预算，追加限额无法按请求工作。 超过32位的期限会因底层不注册timer而悄悄失去超时约束。

配套修改：H003、H045。

#### H007 · 把宿主优先级交给当前目录

差异：`@@ -152,7 +177,8 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`；SHA-256：`71b86c42cb3a044179de7cac84abe086deb44a0ce0ab5681c4f657e5478d2c0f`
首段：`  const tools = (options.tools ?? {}) as HostTools<Services<Tools>> ⏎   ToolRuntime.assertValidTools(tools) ⏎   const limits = resolveExecutionLimits(options.limits)`
尾段：`  return { ⏎     catalog: () => prepared.catalog,`

职责：为每次创建的 CodeMode runtime 计算正确的内联工具选择。

机制：ToolRuntime.prepare 增收 options.discovery?.priority，仍以这次 tools 和预算构建目录。

必要性：优先级必须作用于当前可用工具，不能跨执行缓存旧能力。

不做会怎样：公共选项虽存在，目录仍按原规则选择；宿主标记的原生工具不会获得本次优先权。

配套修改：H064、H100。

#### H008 · 将合格 JSON 文本转为沙箱数据

差异：`@@ -160,3 +186,28 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`；SHA-256：`66999b1d953d622f2196ca1d561be3cdc50e623eb52dcdec6b18ce617b13248a`
首段：`    execute: (code) => executeWithLimits<Tools>({ ...options, code }, limits, prepared.searchIndex), ⏎   }`
尾段：`    throw error ⏎   } ⏎ }`

职责：提供宿主明确调用的无 schema 文本投影入口。

机制：fromJsonText 只接收解析后为对象或数组的 JSON；数值溢出、JSON 语法错误及 copyIn 的 InvalidDataValue 返回原文本，其他异常继续抛出；成功值登记原文。

必要性：复用既有深度、危险键和普通数据边界，既让无类型 JSON 可组合，又保留 String(value) 的原文本。

不做会怎样：合格 JSON 仍只是一段字符串，脚本需自行解析；若跳过 copyIn 或吞掉全部错误，会扩大可表示数据范围或掩盖内部错误。

配套修改：H048、H083、H100。

### packages/codemode/src/input-forms.ts：确定性输入简写

源文件 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（基线不存在此文件）
候选 SHA-256：`7b38c0cb7fcedee90ec43d173cff76396f0c3ba56244a055f3b14b9fa6af7eca`

#### H009 · 从真实编码合同派生单值简写

差异：`@@ -0,0 +1,50 @@`；SHA-256：`49898e7f2f6507c0c21a603c6b20ed45ea5633921f54e4bdcb51b755f6aef258`
首段：`import { Schema, SchemaAST } from "effect" ⏎ `
尾段：`  return matches(value) ? { [forms.key]: value } : value ⏎ }`

职责：只把语义明确的原始值包装进对象合同的单个标量字段。

机制：读取 Schema.toEncoded 的 AST；对象须无索引签名和符号字段，选择唯一必填字段，或全可选对象的唯一字段。标量 union 逐项检查，undefined 原样通过；normalizeInput 按类型包装 false、0、null，不运行 decoder。 字段自己的 encoded 类型保留在 scalar 中，数字字符串先按 string 匹配，转换仍留给真实 decoder。

必要性：参数形式由真实合同决定，转换、default 和 refinement 留给原 decoder 一次执行。

不做会怎样：没有这一层，合法单值简写仍被对象 decoder 拒绝；猜字段或反向拆任意单键对象会改变真实输入合同。本文件没有标量合同的反向拆包。

### packages/codemode/src/interpreter/model.ts：词法值模型

源文件 SHA-256：`985fbdb7c4ebc86a877e5fb45ca34acf7914ad1f407e3637601e80bf183e6628`
候选 SHA-256：`6e61d2f1827f62eb7b5ba053dbf6220ed10bc16c504677401f64cd3c1360b807`

#### H010 · 保存两个词法根

差异：`@@ -28,6 +28,19 @@ export type Binding = {`；SHA-256：`79e5550464b0483e79155146fc45ae15244840f8a2e1c8b2b5d4cdd194cb40bf`
首段：`  initialized?: boolean ⏎ }`
尾段：`  | { kind: "none" } ⏎   | { kind: "value"; value: unknown }`

职责：Environment 只持有内建根和用户绑定根。

机制：类内 roots 含 globals、bindings 两个 Map，解释器通过静态 scopes 取回同一组引用。

必要性：后续单元的闭包需要继续指向原 Binding；当前能力则在执行入口刷新 globals。

不做会怎样：每格重建词法根会丢失变量和闭包；若连旧执行器一起存下，则会保留上一轮权限与取消状态。

配套修改：H021、H022、H044。

#### H011 · 保存函数的 async 身份

差异：`@@ -45,6 +58,8 @@ export class CodeModeFunction {`；SHA-256：`fe1151573e4bfddf8b826b3ee70337ccb8c43eb59f19768e6177d5931845640c`
首段：`    readonly parameters: ReadonlyArray<AstNode>, ⏎     readonly body: AstNode,`
尾段：`    readonly async = false, ⏎   ) {} ⏎ }`

职责：让所有函数调用入口知道函数是否应返回 Promise。

机制：CodeModeFunction 构造器增加默认 false 的 async 字段，创建函数值时由 AST 填入。

必要性：普通调用和集合回调都要依据同一函数值作决定。

不做会怎样：async 与同步函数在值模型里无法区分，统一调用入口无法正确保持两种返回语义。

配套修改：H024、H036。

#### H012 · 为可持久化 sleep 别名提供身份

差异：`@@ -86,7 +101,8 @@ export class GlobalNamespace {`；SHA-256：`5f20944d498df0d407684e29770bd0423961aa36899d4ba84dc5fdd3502da051`
首段：`export class GlobalMethodReference { ⏎   constructor(`
尾段：`    readonly namespace: GlobalNamespaceName | "Number" | "String" | "$builtin", ⏎     readonly name: string, ⏎   ) {} ⏎ }`

职责：把 sleep 表示成解释器识别的内建引用。

机制：GlobalMethodReference 的 namespace 增加私有 $builtin；引用只存名字，不捕获执行上下文。

必要性：保存到环境的 sleep 别名需要在调用时绑定当前根 Scope。

不做会怎样：若用捕获旧执行器的宿主回调保存别名，后续单元会关联旧取消状态；这里提供的身份由 H032/H033 调度。

配套修改：H021、H032、H033。

#### H013 · 同步可调用语法诊断

差异：`@@ -121,8 +137,9 @@ export type DiagnosticKind =`；SHA-256：`8108699ad79f71fbccb805ef002410d15619b8f200c924a0050625f131b28264`
首段：`export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit") ⏎ `
尾段：`export class InterpreterRuntimeError extends Error { ⏎   readonly node?: AstNode`

职责：共享诊断文案准确描述解释器已实现的语言面。

机制：把then/catch禁用提示改为共享callback及返回Promise采用语义，其余能力清单不变。

必要性：模型应按真实可用API修复调用，不能被旧错误说明诱导改写本来合法的链式调用。

不做会怎样：普通语法错误会附带错误的Promise限制，造成不必要的重试。

### packages/codemode/src/interpreter/runtime.ts：解释器执行与生命周期

源文件 SHA-256：`0a8d2830a207aa07405da2d35a11433b2e97be642a07e967f7cbc0e45471882a`
候选 SHA-256：`dee800fee149a1c8ab424d57c28365f8f12c11de92de7c52c33bd255b2bf81e9`

#### H014 · 接入根 Scope 与原文元数据

差异：`@@ -1,5 +1,7 @@`；SHA-256：`f46ccba278d71c3889c699123ccfda540fef929ed6dc59242e785f243be7c56a`
首段：`import { parse } from "acorn" ⏎ import { rawText, withRawText } from "../raw-text.js"`
尾段：`import { ⏎   copyIn,`

职责：为根生命周期和环境快照提供所需依赖。

机制：导入 Scope 替换原解释器 Semaphore，并导入 rawText/withRawText。

必要性：这些导入归 H020、H023、H046 的实现使用，八许可调度已转交 ToolRuntime。

不做会怎样：本 hunk 没有独立行为；只删导入会造成对应实现的符号缺失。注释仅解释归属。

配套修改：H020、H023、H046、H067、H070。

#### H015 · 接入词法环境类型

差异：`@@ -25,6 +27,8 @@ import {`；SHA-256：`aa32145bc83bd66594f38a1aa5940c051b66d5e0968e1d5295f3fcd9165b9190`
首段：`  type AstNode, ⏎   asNode,`
尾段：`  CoercionFunction, ⏎   ComputedValue,`

职责：为解释器构造和快照使用共用 Environment 模型。

机制：从 model 导入 Environment。

必要性：解释器构造、环境复制和执行入口需要引用 H010 的同一个 Environment，避免各自声明不同状态结构。

不做会怎样：没有独立运行时修改；单独去掉导入会使这些环境实现无法解析该类型和值。

配套修改：H020、H021、H046。

#### H016 · 移除解释器并发常量依赖

差异：`@@ -67,7 +71,8 @@ import {`；SHA-256：`e92c69ed2d5c4154ff0105d79dbd5bf322181eb6ab0aac56fc079d02e6050b98`
首段：`  numberStatics, ⏎ } from "../stdlib/number.js"`
尾段：`  escapeRegexHint, ⏎   invokeRegExpMethod,`

职责：让解释器只导入 Promise 方法集合。

机制：promiseStatics 导入保留，TOOL_CALL_CONCURRENCY 导入移到 ToolRuntime。

必要性：并发入口归 H067/H070，Promise 观察和 async 函数不占工具许可。

不做会怎样：仅保留一个不用的 import 不会改变执行行为；实际并发差异来自许可入口迁移。

配套修改：H023、H067、H070。

#### H017 · 在解析诊断中标出可靠的源码位置

差异：`@@ -113,7 +118,9 @@ import {`；SHA-256：`72fcfb7e969d36b16d06187076f4cf4274f42ce5592d61c6c12b15d8e41e8d63`
首段：`} from "../values.js" ⏎ `
尾段：`    compilerOptions: { ⏎       target: ScriptTarget.ESNext,`

职责：解析入口负责把TypeScript原始诊断映射回用户脚本。

机制：保留包装前缀长度，只在diagnostic.start落入用户源码半开区间时取原SourceFile位置，扣掉包装行并按UTF-16列号显示。

必要性：生成JS的AST位置不能当作原始TS位置；已有parse diagnostic已有准确来源，不需要增加sourcemap。

不做会怎样：常见缺表达式错误仍没有可定位的源码行列；若不排除wrapper/EOF，可能给出误导位置。

#### H018 · 在解析诊断中标出可靠的源码位置

差异：`@@ -123,8 +130,17 @@ const parseProgram = (code: string): ProgramNode => {`；SHA-256：`48d4d8433fb58eb6cecccc12aac81d2676d0bce2142748c04243fbe7e09b362a`
首段：`  const diagnostic = transpiled.diagnostics?.find((item) => item.category === DiagnosticCategory.Error) ⏎ `
尾段：`      "ParseError", ⏎     )`

职责：解析入口负责把TypeScript原始诊断映射回用户脚本。

机制：保留包装前缀长度，只在diagnostic.start落入用户源码半开区间时取原SourceFile位置，扣掉包装行并按UTF-16列号显示。

必要性：生成JS的AST位置不能当作原始TS位置；已有parse diagnostic已有准确来源，不需要增加sourcemap。

不做会怎样：常见缺表达式错误仍没有可定位的源码行列；若不排除wrapper/EOF，可能给出误导位置。

#### H019 · 更新错误归一化注释

差异：`@@ -219,7 +235,7 @@ const normalizeError = (error: unknown): Diagnostic => {`；SHA-256：`52117caa7742b54ec51513182decb9563433380dce74d4b2e29ee8f65cacd770`
首段：`  } ⏎ } ⏎  ⏎ // catch 与 allSettled 共享普通失败归一化；宿主中断不转换为脚本数据。`
尾段：`  if (thrown instanceof ProgramThrow) return thrown.value ⏎   if (thrown instanceof InterpreterRuntimeError) return createErrorValue(thrown.errorName, thrown.message)`

职责：使 caughtErrorValue 的说明对应当前 Promise 语义。

机制：注释改为 catch/allSettled 的普通失败归一化，删去 race losers 的旧描述。

必要性：race 不再主动中断败方，注释应与 H036 保持一致。

不做会怎样：只保留旧注释不会改变执行结果，但会把维护者引向已移除的 race 取消机制。

配套修改：H036。

#### H020 · 复制一次预跑环境

差异：`@@ -241,6 +257,53 @@ const isRuntimeReference = (value: unknown): boolean =>`；SHA-256：`a05aa50034b55a5d2d3b96018a950b5f13d5d8a62d18d06a6d4ba2d8e2b98f64`
首段：`  value instanceof ErrorConstructorReference || ⏎   isSandboxValue(value)`
尾段：`const containsRuntimeReference = (value: unknown, seen = new Set<object>()): boolean => { ⏎   if (isRuntimeReference(value)) return true ⏎   if (value === null || typeof value !== "object") return false`

职责：让探针读取旧变量、闭包和对象关系，同时隔离它造成的修改。

机制：snapshotEnvironment 只有一个 copy 和身份 memo。Map 键值、Set 成员递归复制，普通实例保留原型并按自身数据描述符复制；目标先入 memo，保留循环和别名。RegExp 重建 source/flags，再复制自身字段；共同出口转交原文 WeakMap 元数据。遇到宿主函数、URL/URLSearchParams 或访问器就终止本次预跑。 注释说明沙箱函数是可复制的 AST/作用域对象，并区分不可重建的原生函数。

必要性：闭包捕获的 Map/Binding 与容器数据须在同一复制关系里重绑；描述符复制避免调用 getter，并保留非枚举错误品牌和 text。一个通用 copy 核心从整个环境根递归，身份 memo 同时保留别名和循环。

不做会怎样：旧空环境探针看不到保存的 helper；直接使用真实环境则会提前改变私有计数和对象。复制失败只使本次探针停止，已收集调用及真实权限检查仍由宿主继续处理。

配套修改：H046、H100。

#### H021 · 分开执行共享状态与函数局部栈

差异：`@@ -599,36 +662,57 @@ const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<s`；SHA-256：`d29ca1941c2b0dfd6d4fee4f6c39866775334bb47c493045c838ea0f18eff948`
首段：`  return out ⏎ }`
尾段：`    globalScope.set("undefined", { mutable: false, value: undefined }) ⏎     globalScope.set("Object", { mutable: false, value: new GlobalNamespace("Object") })`

职责：建立一次执行共有的工具、日志、根 Scope 和 Promise 清单，同时保留每个 Interpreter 的局部词法栈。

机制：新增 Execution；Interpreter.make 从 Environment 取得两个根，清空并重新播种 globals，注入当前 invokeTool/toolKeys/log/scope/promises，sleep 存为 builtin 引用；declared 只记录本格顶层声明。 本次sleep效果也保存在Execution，默认Effect.sleep，探针可单独跳过等待；旧别名不会捕获上一轮计时策略。

必要性：并发函数共享能力和外层 Binding，但不能互相替换参数与局部作用域。globals 复用原 Map 才能刷新旧闭包看到的能力。

不做会怎样：沿用单实例 scopes 切换会让交错 async 回调串用局部状态；重建或保留旧 globals 又会分别破坏闭包引用或沿用旧能力。

配套修改：H022、H036、H044。

#### H022 · 在当前执行绑定 fetch 响应和用户根

差异：`@@ -664,21 +748,28 @@ class Interpreter<R> {`；SHA-256：`c928c7ad0a55ef002d7a7cecc373daf78fd8920f8cc169cc2c29922665733109`
首段：`    if (hasFetch) { ⏎       globalScope.set("fetch", { mutable: false, value: new ToolReference(["$codemode", "fetch"]) })`
尾段：`      self.hoistFunctions(program.body) ⏎       let value: unknown = undefined`

职责：让 fetch 响应方法与普通函数共用本次能力，并保留用户顶层状态。

机制：响应工厂放入 execution.fetchResponse；make 返回以 globals、roots.bindings 为栈的 Interpreter。run 不再临时 push 一个执行结束即丢弃的用户根。

必要性：fetch 可见性和响应方法必须属于本次执行；用户变量则需跨格保留。

不做会怎样：旧临时 module scope 会丢失顶层状态，旧实例字段也不适合并发函数共享。工厂表达式的换行只是排版，不增加功能。

配套修改：H021、H036。

#### H023 · 统一 Promise 生产、观察和根清理归属

差异：`@@ -707,71 +798,60 @@ class Interpreter<R> {`；SHA-256：`2b19df33f17f289a49c025f203b60393d5a9b567b6e9a03cdbe135bbf6c26a47`
首段：`      // without an explicit await, exactly as in JS. ⏎       if (value instanceof SandboxPromise) value = yield* self.settlePromise(value)`
尾段：` ⏎   private evaluateStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {`

职责：工具、async 函数与组合器都通过同一创建入口登记到根 Scope，观察者只读结果。

机制：createToolCallPromise 复用 execution.invokeTool；createPromise 用 startImmediately 的 forkIn，并将 fork 和 trackPromise 放入不可中断区。observePromise 等到 Exit 到达才标 observed；settlePromise flatten Exit。删去 pendingSettlements、局部许可和 raceInterrupted 特判，run 也不再自行清理一份 pending 集合。 trackPromise 也登记只有 Exit 的即时拒绝，供根收尾判断其是否未观察。 当前执行保存宿主sleep能力，默认Effect.sleep；保留的别名仍在当前根创建Promise。 settlePromise同时接纳普通值与SandboxPromise，await、async返回值和链式handler共用采用规则。

必要性：同步启动时立刻收到取消，也必须先完成根登记；取消一次 await 或 race 观察不能取消共享生产者。清理只由根 Scope 拥有。

不做会怎样：旧登记窗口可让 Execute 在真实 finalizer 完成前返回；旧 pending 集合和 race 特判会把观察取消与生产者寿命混在一起。遗漏 observed 的时机调整还会吞掉取消等待之后的未观察失败。

配套修改：H036、H046、H080。

#### H024 · 把 AST async 标志写入函数值

差异：`@@ -857,6 +937,8 @@ class Interpreter<R> {`；SHA-256：`138ae101647824f079422de9823e9a07b03aead051691ce6c4022f04c67f8b0a`
首段：``      getArray(node, "params").map((parameter, index) => asNode(parameter, `params[${index}]`)), ⏎       getNode(node, "body"),``
尾段：`      node.async === true, ⏎     ) ⏎   }`

职责：把声明和表达式中的 async 身份交给共用调用入口。

机制：makeFunction 构造 CodeModeFunction 时传 node.async === true。

必要性：H011 的字段需要真实语法来源，所有调用者才能使用 H036 的 Promise 分支。

不做会怎样：字段保持默认 false 时，源码写了 async 的函数仍按同步函数运行。

配套修改：H011、H036。

#### H025 · 开放已有容器的 for-await 入口

差异：`@@ -1065,11 +1147,8 @@ class Interpreter<R> {`；SHA-256：`90feafa097637033fef2fa717a15cdabac17b69009351bed18835307943b815c`
首段：`    }).pipe(Effect.ensuring(Effect.sync(() => self.popScope()))) ⏎   } ⏎  ⏎   // 同一循环路径接纳同步与异步迭代，异步 next 与关闭沿既有 await 调度让出。`
尾段：`  private evaluateForOfStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> { ⏎     const self = this ⏎     return Effect.gen(function* () { ⏎       const left = getNode(node, "left")`

职责：允许 for await...of 继续进入现有迭代代码。

机制：删除入口处一概抛出的 unsupported 错误；具体 next、产值等待和退出顺序由 H026/H027 处理。

必要性：现有 Array/string/Map/Set 迭代入口可复用，无需新增独立异步迭代协议。

不做会怎样：入口仍会在读取已有容器前拒绝 for-await，后续实现无法触达。

配套修改：H026、H027。

#### H026 · 按异步顺序取值并清理循环绑定

差异：`@@ -1100,15 +1179,26 @@ class Interpreter<R> {`；SHA-256：`d3cb1a24f164839e956565c2750379747b8612eacea95c2ccf66bf3f77feffcb`
首段：`        throw new InterpreterRuntimeError("Unsupported for...of binding.", left) ⏎       }`
尾段：`          Effect.onError(() => (getBoolean(node, "await") ? Effect.yieldNow : Effect.void)), ⏎           Effect.ensuring( ⏎             Effect.sync(() => { ⏎               if (declaration) self.popScope()`

职责：在已有同步容器上实现 for-await 的 next、值结算和异常收尾。

机制：手动取得 iterator；每次 next（包括 done）先 yieldNow；仅对产出的 SandboxPromise settle。声明绑定和循环体放进同一 ensuring，异常路径对 for-await 再让出一次，最后释放循环帧。

必要性：普通值与空迭代也有异步观察顺序，解构默认值失败也必须释放已创建的迭代作用域。

不做会怎样：只等待 Promise 项会漏掉普通值和终止时的调度边界；绑定发生在 ensuring 外则可能留下失败迭代帧。Map 产出的键值数组不递归等待。

配套修改：H025、H027。

#### H027 · 补齐 for-await 的 break/return 顺序

差异：`@@ -1116,6 +1206,8 @@ class Interpreter<R> {`；SHA-256：`ce04d07fef46040e6967d6bd2c160673cc83bec0ec14aed1f1bd4b0fa54a73d8`
首段：`          ), ⏎         ) ⏎  ⏎         // break 与 return 也会关闭异步迭代，须让调用者先于后续语句获得调度。`
尾段：`        if (getBoolean(node, "await") && (result.kind === "return" || result.kind === "break")) yield* Effect.yieldNow ⏎         if (result.kind === "return") { ⏎           return result ⏎         }`

职责：让正常提前退出也经过异步关闭的让出点。

机制：在处理 return/break 的 StatementResult 前，仅对 await 循环 yieldNow。

必要性：H026 的异常分支之外，还要覆盖 break 和 return。支持的容器没有自定义 return 方法，此处保持它们的关闭调度边界。

不做会怎样：提前退出会少一次异步让出，后续语句与调用者的先后顺序偏离该循环语义；普通 for-of 保持原顺序。

配套修改：H026。

#### H028 · 从执行共享状态枚举工具

差异：`@@ -1144,7 +1236,8 @@ class Interpreter<R> {`；SHA-256：`12bc636d50f34c1cfc637f56cdf3a2c4faece42657d985bafc61d5eae2591615`
首段：`  // Returns undefined for everything else so callers can raise a contextual error. ⏎   private enumerableKeys(value: unknown): Array<string> | undefined {`
尾段：`    if (Array.isArray(value)) { ⏎       return Object.keys(value)`

职责：让各函数帧看到同一份当前工具目录。

机制：enumerableKeys 的 ToolReference 分支改用 this.execution.toolKeys。

必要性：配合 H021 的局部帧拆分，工具能力仍由同一个宿主入口决定。

不做会怎样：旧实例字段已移除，保留旧访问会让工具枚举引用不存在的字段；这里沿共享 Execution 读取目录，枚举规则保持原样。

配套修改：H021。

#### H029 · 让 await 普通值也交出执行机会

差异：`@@ -1447,11 +1540,13 @@ class Interpreter<R> {`；SHA-256：`52c5962864ff0cb236c598565bc3f1630afc4658b3a697017320535d6d262599`
首段：`      case "UpdateExpression": ⏎         return this.evaluateUpdateExpression(node)`
尾段：`      } ⏎       case "NewExpression":`

职责：保持 async 函数首次 await 后的调度顺序。

机制：先求参数表达式，再 yieldNow，之后结算 SandboxPromise 或返回普通值。

必要性：await 1 和 await 已结算 Promise 也应让调用者继续同步语句。

不做会怎样：直接透传普通值会让 async 后半段抢先运行；只有工具挂起的场景无法覆盖这个顺序问题。

#### H030 · 只求值一次被调用成员

差异：`@@ -1897,7 +1992,12 @@ class Interpreter<R> {`；SHA-256：`827cfb79c2c416122e56e381879d4e03b7db7395d7a63b25bd3bcf8db8be46cb`
首段：`    const self = this ⏎     return Effect.gen(function* () { ⏎       // 形状诊断复用这次求值，不能为解释错误再次执行 receiver 或 computed key。`
尾段：`      if (callable === OptionalShortCircuit) return OptionalShortCircuit ⏎       if ((callable === null || callable === undefined) && node.optional === true) return OptionalShortCircuit`

职责：为调用诊断保留 receiver 和 computed key 的首次求值结果。

机制：MemberExpression 先调用 getMemberReference，再把同一 reference 作为 Effect.succeed 传给 readMember；其他 callee 仍走 evaluateExpression，可选链短路位置保留。

必要性：H033 需要知道接收者形状，但诊断不得再次执行带副作用的表达式。

不做会怎样：若只在报错时重新求值 receiver/key，会制造额外副作用；若不保留引用，则无法准确说明是哪个接收者不可调用。

配套修改：H033、H043。

#### H031 · 把同步 search 接到当前执行

差异：`@@ -1905,9 +2005,9 @@ class Interpreter<R> {`；SHA-256：`f6641922ca7f8d4cce6db66f86a1c87486021b9150b1cccd07b8c108526ddd27`
首段：`      if (callable instanceof ToolReference) { ⏎         if (callable.path.length === 0) throw new InterpreterRuntimeError("The tools root is not callable.", callee)`
尾段：`        return yield* self.createToolCallPromise(callable.path, args) ⏎       }`

职责：维持 search 的同步值返回，同时使用共享调用入口。

机制：ToolReference 的 $codemode.search 分支改为 execution.invokeTool；其他工具仍创建 Promise。

必要性：函数局部帧拆分后，search 仍要经过同一执行的验证、计数和 hooks，保持同步发现结果。

不做会怎样：使用移除的实例字段会断开调用；把 search 改成普通异步工具则会改变现有发现用法。

配套修改：H021、H060、H070。

#### H032 · 把 builtin 别名分发到当前 sleep

差异：`@@ -1921,6 +2021,8 @@ class Interpreter<R> {`；SHA-256：`97d1b98e82ef4f52cf0bcb330e5acdf10511a5061af40bca56a1ae479f00cf99`
首段：`        return yield* self.invokeIntrinsic(callable, args, node) ⏎       }`
尾段：`        if (callable.namespace === "Object" && args[0] instanceof ToolReference) { ⏎           return self.invokeObjectMethodOnTools(callable.name, args[0] as ToolReference, node)`

职责：允许直接调用和跨格别名调用进入本次计时器创建入口。

机制：GlobalMethodReference 的 $builtin 分支调用 invokeSleep，console/Object 等分支保留。

必要性：身份引用本身不携带旧执行器，调用时才能关联当前 Scope。

不做会怎样：存下的 sleep 引用没有执行分支，或被误当成其他全局方法；实际参数和计时规则由 H033 负责。

配套修改：H012、H033。

#### H033 · 提供形状诊断和受根管理的 sleep

差异：`@@ -1937,10 +2039,33 @@ class Interpreter<R> {`；SHA-256：`63c7c9835e64d8d5086518e9778dfee61dab21518982a62b25a05a3ab2affc40`
首段：`      if (callable instanceof ErrorConstructorReference) { ⏎         return createErrorValue(callable.name, args[0] === undefined ? "" : coerceToString(args[0]))`
尾段：`  // namespace/tool names from the host tool tree - the discovery idiom a model reaches for ⏎   // first. Every other Object helper cannot produce data from a tool reference, so it fails`

职责：本 hunk 连续修改两个独立入口：不可调用值的错误说明，以及 sleep 的执行。

机制：诊断使用 H030 保存的 receiver，显示类型及最多八个、每个最多64字符的键名，不读取属性值。invokeSleep 仅接受 0 至 2147483647 的有限 number，经 createPromise(execution.sleep(ms)) 返回根 Scope 的 Promise，不占工具许可和计数。 实际等待由本次宿主能力提供，期限和参数检查保持独立。

必要性：错误应说明对象形状而非笼统声称只有工具可调用；脚本等待要用已有可取消计时器并绑定当前执行。

不做会怎样：对象误用 map 仍只能得到误导提示；没有 sleep 分支则无法等待。字符串、负数、无限值和超范围计时不能靠隐式转换进入 Effect timer。

配套修改：H023、H030、H032、H043。

#### H034 · 让所有函数帧写同一个日志出口

差异：`@@ -1959,7 +2084,8 @@ class Interpreter<R> {`；SHA-256：`b1b858714709b4e515d638e0d09291fcc1df983881f750797ad86b6f2d139216`
首段：`  private invokeConsole(name: string, args: Array<unknown>, node: AstNode): undefined { ⏎     if (!consoleMethods.has(name))`
尾段：`    this.execution.log(publicErrorMessage(this.formatConsoleMessage(name, args, node))) ⏎     return undefined ⏎   }`

职责：收集并限制整段执行的日志，而非每帧各存一份。

机制：invokeConsole 保留方法白名单和原格式化流程，改调用 execution.log。

必要性：H045 的 UTF-8 留存预算必须覆盖并发函数和集合回调产生的全部日志。

不做会怎样：直接写局部 logs 会绕过共同预算或遗漏子函数日志。

配套修改：H021、H045。

#### H035 · 让组合器返回 Promise，并隔离函数局部帧

差异：`@@ -2102,133 +2228,97 @@ class Interpreter<R> {`；SHA-256：`a530e3b0082f78306bb7f2ac62f1dc0054c4a5015f319c18cb3924be68962c35`
首段：`    }) ⏎   } ⏎  ⏎   // 组合器消费已有 Promise，而不是执行另一套工具调度；其返回值仍可继续组合。`
尾段：`        } ⏎         for (const [index, parameter] of fn.parameters.entries()) {`

职责：修正 all/allSettled/race 的观察语义，以及 async 函数的调用和返回语义。

机制：resolve/reject 登记即时 Exit；其他组合器由 createPromise 启动。all 并发观察且结果保序，allSettled 并发收集普通拒绝并传播纯中断，race 竞争观察结果而不取消生产者，空 race 为 Effect.never。invokeFunction 新建局部 Interpreter 和参数 Map，共享 capturedScopes；async 的参数绑定、函数体及返回 Promise 采用均放在根生产者中。 函数保留原Effect.suspend延迟层次，在每次运行内分配独立帧；参数/body缩进沿共同基线，async返回值通过共享settlePromise。

必要性：后一项失败或中断不能被前项挂起遮蔽，组合器要能嵌套；多个 async 回调的局部参数要隔离，而闭包外层 Binding 保持共享。

不做会怎样：顺序观察会遮住后项失败；取消 race 败方会破坏后续 await；沿用一个可变 scopes 栈会串扰局部变量；在 Promise 外绑定默认参数会把 async 默认值错误变成同步抛出。

配套修改：H023、H024、H029、H080。

**1. 即时 Promise 与组合结果都保留 Promise 身份**

resolve 对已有 SandboxPromise 原样返回，对普通值登记成功 Exit；reject 登记 ProgramThrow 的失败 Exit。all、allSettled、race 的输入检查和执行放在 createPromise 的生产者中，使组合器返回值可以继续 await、嵌套或交给另一组合器。即时拒绝也进入根清单，才能在无人观察时形成回执。

**2. all 和 allSettled 并发观察，仍按输入保序**

all 用 Effect.all 的无界观察，限制实际工具并发的仍是 ToolRuntime 八许可。allSettled 对普通失败调用 caughtErrorValue 生成 rejected 数据，对纯中断传播 cause。后一项失败或中断能及时结束观察，不必等一直挂起的前项。

**3. race 只竞争观察**

raceAll 竞争每个成员的 Exit，再 flatten 胜方结果；被结束的是败方观察，不是原 Promise 的生产者。空数组返回 Effect.never，等待根执行的取消或超时。删去旧败方 interrupt 循环和专用 interrupted 标记后，同一生产者仍可参加另一个 race 或再次 await。

**4. 每次函数调用有独立局部帧**

新 Interpreter 共用 execution，只复制 capturedScopes 的数组，并追加新的参数 Map；外层 Map/Binding 仍是原引用。参数先建立 TDZ 槽，再绑定默认值、rest 和函数体。async 把这整段执行与返回值采用放进 createPromise，同步函数直接返回 run，集合方法也不因此隐式 await 全部回调。

#### H036 · 让组合器返回 Promise，并隔离函数局部帧

差异：`@@ -2246,13 +2336,9 @@ class Interpreter<R> {`；SHA-256：`5a9c3239887e86e5d61827f2aba74c6c44f0624dda9e7c0a1f000f9bd928e0e6`
首段：`        return yield* self.evaluateExpression(fn.body) ⏎       })`
尾段：`      return fn.async ? this.createPromise(run.pipe(Effect.flatMap((value) => self.settlePromise(value)))) : run ⏎     }) ⏎   }`

职责：修正 all/allSettled/race 的观察语义，以及 async 函数的调用和返回语义。

机制：resolve/reject 登记即时 Exit；其他组合器由 createPromise 启动。all 并发观察且结果保序，allSettled 并发收集普通拒绝并传播纯中断，race 竞争观察结果而不取消生产者，空 race 为 Effect.never。invokeFunction 新建局部 Interpreter 和参数 Map，共享 capturedScopes；async 的参数绑定、函数体及返回 Promise 采用均放在根生产者中。

必要性：后一项失败或中断不能被前项挂起遮蔽，组合器要能嵌套；多个 async 回调的局部参数要隔离，而闭包外层 Binding 保持共享。

不做会怎样：顺序观察会遮住后项失败；取消 race 败方会破坏后续 await；沿用一个可变 scopes 栈会串扰局部变量；在 Promise 外绑定默认参数会把 async 默认值错误变成同步抛出。

配套修改：H023、H024、H029、H080。

**1. 即时 Promise 与组合结果都保留 Promise 身份**

resolve 对已有 SandboxPromise 原样返回，对普通值登记成功 Exit；reject 登记 ProgramThrow 的失败 Exit。all、allSettled、race 的输入检查和执行放在 createPromise 的生产者中，使组合器返回值可以继续 await、嵌套或交给另一组合器。即时拒绝也进入根清单，才能在无人观察时形成回执。

**2. all 和 allSettled 并发观察，仍按输入保序**

all 用 Effect.all 的无界观察，限制实际工具并发的仍是 ToolRuntime 八许可。allSettled 对普通失败调用 caughtErrorValue 生成 rejected 数据，对纯中断传播 cause。后一项失败或中断能及时结束观察，不必等一直挂起的前项。

**3. race 只竞争观察**

raceAll 竞争每个成员的 Exit，再 flatten 胜方结果；被结束的是败方观察，不是原 Promise 的生产者。空数组返回 Effect.never，等待根执行的取消或超时。删去旧败方 interrupt 循环和专用 interrupted 标记后，同一生产者仍可参加另一个 race 或再次 await。

**4. 每次函数调用有独立局部帧**

新 Interpreter 共用 execution，只复制 capturedScopes 的数组，并追加新的参数 Map；外层 Map/Binding 仍是原引用。参数先建立 TDZ 槽，再绑定默认值、rest 和函数体。async 把这整段执行与返回值采用放进 createPromise，同步函数直接返回 run，集合方法也不因此隐式 await 全部回调。

#### H037 · 在共同方法入口结算Promise链式回调

差异：`@@ -2261,6 +2347,33 @@ class Interpreter<R> {`；SHA-256：`d8aaca0848753ab6cfd1cd1b5a8440b7b199c255fcd8a8097e2815feaab051cd`
首段：`    args: Array<unknown>, ⏎     node: AstNode, ⏎   ): Effect.Effect<unknown, unknown, R> { ⏎     if (ref.receiver instanceof SandboxPromise) {`
尾段：`      if ( ⏎         (ref.name === "replace" || ref.name === "replaceAll") &&`

职责：解释器的方法调用owner把源结算交给handler，新Promise仍属于唯一根Scope。

机制：先yield再observe源Exit，纯中断穿透；按then/catch选择handler，非函数传递原Exit，函数复用applyCollectionCallback。返回值交settlePromise，直接返回自身转为TypeError。

必要性：现有工具Promise已可组合，链式调用只需同一观察与回调入口，不能再要求模型把catch改成手写try/catch。

不做会怎样：自然批量catch/then仍被拒绝；若把中断交给handler，脚本可把用户取消伪装为成功；若不采用返回Promise则会把未结算值传下去。

#### H038 · 为 async replacer 绑定当前解释器

差异：`@@ -2303,6 +2416,8 @@ class Interpreter<R> {`；SHA-256：`2dbcd9c51ffe4d311221ebdc33fb393ba4a4f7b571b23a65f7f118bf2d72499f`
首段：`    args: Array<unknown>, ⏎     node: AstNode, ⏎   ): Effect.Effect<unknown, unknown, R> { ⏎     // replacer 结算复用本次执行的解释器边界，不能把既有 async 扩展改成普通回调。`
尾段：`    const matches: Array<{ readonly match: string; readonly offset: number; readonly args: Array<unknown> }> = [] ⏎     const collect = (...callbackArgs: Array<unknown>): string => {`

职责：为字符串替换中等待 async 回调的结果提供调用上下文。

机制：在现有替换方法内保存 const self = this，供 H039 的生成器使用。

必要性：H039 的生成器需借 self 访问当前解释器，settlePromise 才能沿本次执行的 Promise 观察路径等待回调。

不做会怎样：单独删掉 self 会使后续结算无法引用解释器；本 hunk 本身没有新增替换规则。

配套修改：H039。

#### H039 · 保留 String.replace 的 async 扩展

差异：`@@ -2346,9 +2461,15 @@ class Interpreter<R> {`；SHA-256：`d15009aca165930572936bd583ccdfab79e8d6a73c6c94a9642c2ce724bd61e9`
首段：`      const output: Array<string> = [] ⏎       let end = 0`
尾段：`        end = match.offset + match.match.length ⏎       }`

职责：在明确 async 的替换回调中等待返回 Promise，再按原规则转为替换字符串。

机制：先执行 apply；只有 CodeModeFunction.async 且结果为 SandboxPromise 才 settle，随后仍经过 boundedData 和 coerceToString。匹配位置、捕获组与拼接流程不变。

必要性：H036 让 async 函数真实返回 Promise 后，原字符串替换扩展需要在自己的方法边界结算它。

不做会怎样：已支持的 async replacer 会落入数据边界报错；若对全部回调自动 await，又会改变同步回调返回 Promise 的既有检查。

配套修改：H036、H038。

#### H040 · 在共用集合回调入口接纳 sleep

差异：`@@ -2367,16 +2488,20 @@ class Interpreter<R> {`；SHA-256：`d9d68e0b307de87ff271e33b317e9c1c9b76403ca78e3910cd15655e53380106`
首段：`    if ( ⏎       !(callback instanceof CodeModeFunction) &&`
尾段：` ⏎   private invokeMapMethod(`

职责：让 sleep 可作为数组、Map/Set 等既有回调入口的内建函数。

机制：白名单仅额外允许 $builtin.sleep，并分发到 invokeSleep；CodeModeFunction、CoercionFunction、UriFunction 保留原路径。

必要性：sleep 已表示成身份引用，集合方法需要显式识别该引用，不能把全部全局方法一并放行。

不做会怎样：map(sleep) 等用法会被当作非函数拒绝；扩大到全部全局方法则会超出当前回调白名单。

配套修改：H033、H041。

#### H041 · 数组复用已有集合回调入口

差异：`@@ -2642,24 +2767,8 @@ class Interpreter<R> {`；SHA-256：`0855e12aadeb528303a4f0d4e394b950851a0772824577c4af512bd6e2e7f03d`
首段：`        return Effect.succeed(Array.from(target.entries(), ([index, item]): Array<unknown> => [index, item])) ⏎     }`
尾段：`      // Iterate a snapshot taken at call time so a callback that mutates the array can't ⏎       // self-extend the loop - matching JS, where elements appended during iteration are not visited.`

职责：删除数组方法单独维护的回调分类分发。

机制：使用 applyCollectionCallback(args[0], Array 方法名, node)，后续数组快照迭代不变。

必要性：H040 的 sleep 支持及函数调用语义应在各集合方法一致。

不做会怎样：保留重复入口会让数组继续遗漏 sleep；除此之外，这段删除主要减少同一白名单的重复实现。

配套修改：H036、H040。

#### H042 · 把then和catch绑定到已有Promise方法引用

差异：`@@ -3066,11 +3175,10 @@ class Interpreter<R> {`；SHA-256：`1e6e09eb05fb2855a87ad2cdb6b0ca40c36c165f3008a818a045735fbd2564e5`
首段：`        return new ComputedValue(undefined) ⏎       } ⏎  ⏎       // 链式方法绑定当前 Promise；其它属性仍提示先 await，避免误读工具结果。`
尾段：``            `Promise.prototype.${String(key)} is not supported in CodeMode; use await instead (with try/catch to handle failures) - e.g. \`const result = await tools.ns.tool(...)\`.`, ⏎             propertyNode,``

职责：成员读取只解析调用目标，不执行handler或另造Promise实现。

机制：then/catch返回同类IntrinsicReference，绑定当前SandboxPromise；finally及未await结果属性继续走原诊断。

必要性：链式调用必须从普通成员访问进入同一方法分发；共享引用模型还能让环境副本复制receiver身份。

不做会怎样：新回调实现不可达，脚本仍在读取then/catch时被旧禁用分支中断。

#### H043 · 让成员读取接收已求值引用

差异：`@@ -3124,8 +3232,9 @@ class Interpreter<R> {`；SHA-256：`b64d6908f931ea40513371a99fca581ff117f951ffc303b1a1af9cee0efcd143`
首段：`    }) ⏎   } ⏎  ⏎   // 调用入口可传入已求值引用；普通成员读取仍在此计算，二者共用相同访问规则。`
尾段：`      if (reference instanceof ComputedValue) return reference.value ⏎       if (`

职责：共用原访问规则，避免调用场景重复解析成员。

机制：readMember 增加默认值为 getMemberReference(node) 的 resolved 参数；普通读取按默认路径，调用入口传已有 reference。

必要性：H030 的一次求值结果需要穿过原有可选链、ComputedValue 和访问控制分支。

不做会怎样：只在调用处保存引用却不改 readMember，仍会再次计算 receiver/key，或被迫复制一套访问规则。

配套修改：H030、H033。

#### H044 · 只放宽跨格顶层重声明

差异：`@@ -3259,10 +3368,13 @@ class Interpreter<R> {`；SHA-256：`d5441f64d66e095d2ceb7ac2688a7518d728ab8d5f5e8cc67aaf6d0d13b241fb`
首段：`    // A pre-seeded parameter slot (initialized === false) is being bound for the first time; ⏎     // anything else already present is a genuine duplicate declaration.`
尾段：`    scope.set(name, { mutable, value, initialized: true }) ⏎   }`

职责：允许 Notebook 重跑定义，同时保留本格与函数局部的重复声明检查。

机制：比较当前 scope 与 moduleScope；本格 declared Set 记录已声明名称，已有参数 TDZ 槽仍按原规则初始化。

必要性：用户需要在后续单元重新声明顶层变量，函数参数和局部作用域语义不能一起放宽。

不做会怎样：复用环境后，旧顶层名称会全部报重复；若直接取消重复检查，同格重复和函数局部错误也会被放过。

配套修改：H021、H022。

#### H045 · 在追加时限制共享日志留存

差异：`@@ -3356,7 +3468,27 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`；SHA-256：`b457ec562c402d91acddc727fd16c55a560710ed26ffa014ed40dce3d8b85a5e`
首段：`    options.fetch, ⏎   )`
尾段：`  if (options.code.trim().length === 0) { ⏎     return Effect.succeed({`

职责：控制循环及并发函数累计保存的日志内存，并在各结果出口说明省略。

机制：log 以 UTF-8 字节加换行计费；首次超预算后只增加 droppedLogs，logged() 追加省略行数标记并设置 truncated。未设置 maxLogBytes 时保留既有无限额行为。

必要性：执行结束后的结果裁剪无法限制执行期间日志持续累积；所有帧必须共享这个累计值。

不做会怎样：长循环仍可持续占用日志内存；没有统一 logged() 标记，成功或失败输出无法说明日志已省略。单行格式化仍先产生该行字符串，此处限制的是留存。

配套修改：H006、H034、H100。

#### H046 · 在根结束后交付结果与安全 Promise 终态

差异：`@@ -3367,30 +3499,75 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`；SHA-256：`5744f2429b9d390a8c830b43b0ec49bac84e549dbe7fc0cbbcfbe23744f80b01`
首段：`  } ⏎  ⏎   const operation = Effect.gen(function* () {`
尾段：`    ) ⏎   })`

职责：把快照选择、根 Scope 清理和未观察失败回执接到公共执行路径。

机制：operation 先 yieldNow，让外层 timeout/race 完成登记，再选择环境副本、解析和启动脚本。scopedWith 包住 Interpreter.run；Scope 关闭后读取各 Promise Exit，记录未观察失败，并将 Fiber 状态换成安全 Exit。纯中断变成供后续单元观察的明确错误，普通拒绝保留沙箱抛值；成功结果附 unobservedFailure，再按原 copyIn/copyOut 交付业务值。 waitForTimeout或原Effect.sleep只负责选出到期；race先等待根清理，再构造超时回执。sleep capability独立传给本次Interpreter，不改变根期限。

必要性：执行起点先给外层观察者完成登记的机会，同时保留子生产者 startImmediately 和原子登记；宿主得到结果前必须等真实清理，Notebook 中保存的 Promise 也不能保活旧 Fiber、私有 cause 和权限上下文。

不做会怎样：脚本同步触发宿主取消时，外层观察可能尚未登记，完成/取消顺序会失真；缺少根收尾和终态替换还会让未结束工作越过执行边界、跨格 Promise 保留旧上下文，或在成功结果中遗漏未观察失败。

配套修改：H020、H023、H036、H045、H080。

**1. 根清理之后校验结果，无期限路径保留同一根**

copyIn/copyOut 在 Scope 关闭及 Promise 终态替换之后执行，返回值校验失败也不会提前交回仍在清理的工具。外层 timeoutMs 为 undefined 时继续返回同一个 program。此处新增注释解释已有顺序和无期限分支；该分支没有额外算法修改。

#### H047 · 裁剪结果时保留附加事实

差异：`@@ -3462,7 +3639,6 @@ const boundOutput = (result: Result, maxOutputBytes: number): Result => {`；SHA-256：`da5a038b0516e092d668b39f37fb5a8937b00924bcd6736dee76687ba8c6e859`
首段：`  if (!truncated) return result ⏎   const logsPart = kept.length > 0 ? { logs: kept } : {}`
尾段：`  return result.ok ? { ...result, value, ...logsPart, truncated: true } : { ...result, ...logsPart, truncated: true } ⏎ }`

职责：使既有 maxOutputBytes 结果重建保留 unobservedFailure 等已有字段。

机制：成功和失败分支先展开原 result，再覆盖 value、保留下来的 logs 和 truncated。

必要性：结果预算只应改变被裁剪部分，不应删除本次执行已经确认的事实。

不做会怎样：旧手写字段重建会漏掉新增的未观察失败字段。此处没有新增 JSON 预览或改变业务类型的宿主截断器。

配套修改：H005、H046。

### packages/codemode/src/raw-text.ts：原文来源

源文件 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（基线不存在此文件）
候选 SHA-256：`ea0ef5ff8ff82d3328349dbafbee99f9f92c55e33942b8ee816e488a2a1e3eac`

#### H048 · 集中保存 JSON 文本来源

差异：`@@ -0,0 +1,17 @@`；SHA-256：`63a8662b18866502d91de2683a403d5e4aab687d859bc0e755831e7b1c070ea5`
首段：`// 来源元数据不写入业务对象，避免输出解码器把便利字段当成真实数据。 ⏎ // 弱引用随值回收，不为 Notebook 或单次执行增加独立生命周期。`
尾段：`  return value ⏎ }`

职责：用弱引用元数据保留原文，并只在内部副本上提供便捷 text 别名。

机制：rawText 查询 WeakMap；withRawText 首次登记后不改写，exposeAlias 为真且没有自有 text 时，定义非枚举只读别名。

必要性：原文不能成为输出 decoder 或 JSON.stringify 的业务字段，已有业务 text 也必须优先。

不做会怎样：直接加可枚举 text 会污染合同和输出；不留元数据则 String/模板无法恢复原有空白和格式。弱引用无需另建回收表。

配套修改：H008、H020、H049、H056、H057、H069。

### packages/codemode/src/stdlib/value.ts：字符串转换

源文件 SHA-256：`ab7399b36f12f51f437c81af56e4809ad4cf12cb1bf85563d882c4c248a0fccc`
候选 SHA-256：`b1c06c530c7af060a1f018398faaf8b81c6dafeb4a78c34fd46742f2f85e2cdd`

#### H049 · 字符串转换优先读取登记原文

差异：`@@ -28,6 +28,9 @@ export const errorBrandName = (value: unknown): string | undefined =>`；SHA-256：`c174205cd84030eea381ed73121b16294a909f51e0bea628883495b4f658f69f`
首段：`export const boundedData = (value: unknown, label: string): unknown => copyIn(value, label, true) ⏎ `
尾段：`  if (value === undefined) return "undefined" ⏎   if (value instanceof SandboxDate)`

职责：让投影后的对象或数组在 String 和模板字符串中保留原 JSON 文本。

机制：coerceToString 先查 rawText；没有来源时继续原 null、undefined、日期和普通值转换。

必要性：脚本可以组合业务字段，也可以取得协议原文，两种用途共用同一内部值。

不做会怎样：投影对象会变成普通对象字符串，原文中的空白与格式丢失；普通对象的转换规则无需因此变化。

配套修改：H048。

#### H050 · 接入字符串转换的来源查询

差异：`@@ -74,6 +77,8 @@ export const invokeCoercion = (ref: CoercionFunction, args: Array<unknown>, node`；SHA-256：`50e7eaee252de3e38949988272556527519960f936633a9185152dc2d2670f6e`
首段：`  return coerceToString(value) ⏎ }`
尾段：`import { ⏎   isSandboxValue,`

职责：给 H049 提供 rawText 函数。

机制：新增 raw-text 导入，既有 copyIn 和沙箱值导入不变。

必要性：与 H049 属于同一原文转换修改。

不做会怎样：本 hunk 不独立改变行为；去掉导入会使原文查询缺少符号，注释本身不影响结果。

配套修改：H049。

### packages/codemode/src/tool-runtime.ts：工具边界与发现

源文件 SHA-256：`5ca5e0cc8ff716a26f4517cc70660a2d9d970006c46f07c146ef52765d9af430`
候选 SHA-256：`de40492ebdce0c9f328963b2925e539b7f8e9d04f7fc817f3828388407d46dab`

#### H051 · 接入输入适配、来源和统一许可依赖

差异：`@@ -1,4 +1,8 @@`；SHA-256：`c5b7b4ff415f5d9a8b9f94b94808edfac16bc16e906bd3ae6b69ce5ec0ca767e`
首段：`// 参数形式、来源快照与宿主限流各守自己的边界，不向解释器引入宿主策略。 ⏎ import { normalizeInput } from "./input-forms.js"`
尾段：`import { ToolError, toolError } from "./tool-error.js" ⏎ import {`

职责：为 ToolRuntime 的三个既有边界提供实现依赖。

机制：新增 normalizeInput、rawText/withRawText、TOOL_CALL_CONCURRENCY、Semaphore 导入。

必要性：导入分别归 H068、H056/H057/H069、H067/H070 的行为使用。

不做会怎样：没有独立调度或适配行为；仅删导入会留下未解析引用。不能把这些 import 单算成额外功能。

配套修改：H056、H057、H067、H068、H069、H070。

#### H052 · 接入统一沙箱值判断

差异：`@@ -11,6 +15,8 @@ import {`；SHA-256：`6b96b8e26f1e9d906bfec6d9d2b422b44ad1019819a5be08cccf35c3e014d5f4`
首段：`} from "./tool-schema.js" ⏎ import { isDefinition as isToolDefinition, type Definition } from "./tool.js"`
尾段：`  SandboxMap, ⏎   SandboxPromise,`

职责：让内部复制使用公共品牌判断。

机制：从 values 导入 isSandboxValue。

必要性：作为 H055 删除重复类型名单的依赖。

不做会怎样：移除导入会使 copyBounded 中的 isSandboxValue 无法解析；可保留值的判断由 H055 的公共品牌集合决定，导入和注释都不扩展数据边界。

配套修改：H055。

#### H053 · 限定 namespace 错误提示长度

差异：`@@ -96,9 +102,13 @@ export type SafeObject = Record<string, unknown>`；SHA-256：`2e37f26fef4cd063b72cf9fe69b160e408670a1d2b5ed4513c0c4ca6a4fc2bd9`
首段：`const reservedNamespace = "$codemode" ⏎ const defaultCatalogBudget = 2_000`
尾段：`  namespace: Schema.optionalKey(Schema.String), ⏎   limit: Schema.optionalKey(PositiveInt),`

职责：为 namespace 误调用中的补充签名设置独立展示预算。

机制：新增 namespaceSignatureBudget = 2000，H066 按完整签名累计字符。 SearchInput增加可选detail:true，使模型明确选择少量完整合同；省略时返回概览。

必要性：大 namespace 的一次错误不能输出整份目录。

不做会怎样：H066 没有明确的提示长度上限，或只能截断半条签名。该预算不删除工具能力。

配套修改：H066。

#### H054 · 声明 search 详情与逐侧不可表示标记

差异：`@@ -108,6 +118,10 @@ const SearchItem = Schema.Struct({`；SHA-256：`6d39071d3efd7492775396295baff980cac8e858c512f150ade0bd1770a6ad6c`
首段：`  path: Schema.String, ⏎   description: Schema.String,`
尾段：`const SearchOutput = Schema.Struct({ ⏎   items: Schema.Array(SearchItem),`

职责：让搜索结果合同表达输入详情、可选输出详情和 schema 发射失败。

机制：SearchItem的inputSchema和outputSchema只在详细视图出现，schemaUnavailable按失败侧标记；基本路径、说明和签名始终保留。

必要性：合法 Effect 合同也可能无法发射 JSON Schema，搜索需要表达哪一侧缺失而保留其他信息。

不做会怎样：若详情仍是必填，默认紧凑结果无法满足自己的返回合同；若删除字段定义，详细搜索又无法准确声明完整元数据。

配套修改：H061。

#### H055 · 复用既有沙箱值品牌集合

差异：`@@ -220,19 +234,8 @@ const copyBounded = (`；SHA-256：`f9d1b1680a087694ddd88df405ab6972c2c44a4509eb126314c63b66ec77a3ea`
首段：`  } ⏎  ⏎   if (preserveSandboxValues) {`
尾段：`    // the boundary first), but wrap them defensively rather than degrading to JSON forms. ⏎     if (value instanceof Date) return new SandboxDate(value.getTime())`

职责：减少内部复制检查点重复维护的容器类型列表。

机制：preserveSandboxValues 分支改用 isSandboxValue，后续宿主实例包装和真实跨界序列化保持原路径。

必要性：新增沙箱类型时，内部检查不应漏更新第二份 instanceof 名单。

不做会怎样：在当前品牌集合相同时，保留旧名单不会立即改变结果；这是一处同义收敛，主要风险是今后名单漂移。

配套修改：H052。

#### H056 · 数组副本继承原文来源

差异：`@@ -286,7 +289,8 @@ const copyBounded = (`；SHA-256：`67a2b40c0ce8d5d45689736143f9fc987903514b978f5d485882f8d041a8b4e5`
首段：`  if (Array.isArray(value)) { ⏎     const copied = value.map((item) => copyBounded(item, label, depth + 1, seen, preserveSandboxValues))`
尾段：` ⏎   const prototype = Object.getPrototypeOf(value)`

职责：在 copyIn 的数组分支保留明确登记的文本来源。

机制：递归复制元素并释放 seen 后，用 withRawText(copied, rawText(value), true) 返回内部副本。

必要性：JSON 数组与对象同样需要 String/模板和 text 兼容。

不做会怎样：数组一旦过内部复制就丢失原文。map/spread 创建的新根没有原来源，仍按普通数组处理。

配套修改：H048、H049、H057。

#### H057 · 对象副本继承原文来源

差异：`@@ -302,7 +306,8 @@ const copyBounded = (`；SHA-256：`9b49e5a8de1553e1c724ef56fdcd8aa9b2a5ade01cc1fd4ae3f00544c072208c`
首段：`    copied[key] = copyBounded(item, label, depth + 1, seen, preserveSandboxValues) ⏎   }`
尾段：` ⏎ export const copyOut = (value: unknown, undefinedAsNull = false): unknown => {`

职责：在业务字段复制完成后为内部对象转交原文并按条件提供 text 别名。

机制：返回值改为 withRawText(copied, rawText(value), true)；copyOut 继续只遍历业务可枚举字段。

必要性：原文别名应在输出验证后的内部副本出现，并让同名业务字段优先。

不做会怎样：内部复制会丢掉来源；若把别名变成可枚举字段，则会改变最终 JSON 和键遍历。

配套修改：H048、H069。

#### H058 · 统一工具的紧凑具名签名

差异：`@@ -338,12 +343,13 @@ const definitions = <R>(`；SHA-256：`6bd290f54ed79691ab3e497bc2b56ac002ac84075ac7e2251760a17cc8c0f60d`
首段：`} ⏎  ⏎ const describeDefinition = <R>(path: string, definition: Definition<R>): ToolDescription => {`
尾段：``    signature: `${toolExpression(path)}(${input === "{}" ? "" : `input: ${input}`}): Promise<${outputTypeScript(definition)}>`, ⏎   } ⏎ }``

职责：为 catalog、instructions、search 和 namespace 提示生成同一签名。

机制：describeDefinition 只用无 pretty 参数的输入/输出 renderer，非空输入写为 input: 类型，空对象保留零参展示。

必要性：模型需要稳定的真实参数与返回类型概览；字段详情转到按需 search schema。

不做会怎样：各出口会继续展示多行签名或不同形状，减少同预算可展示工具数。未声明输出仍由 renderer 返回 unknown。

配套修改：H061、H066、H073、H075。

#### H059 · 让搜索索引保存原合同引用

差异：`@@ -365,6 +371,9 @@ export type DiscoveryPlan = {`；SHA-256：`e1afb662c194227446e9d375717362b811feffc5c17f48d36f21e89d396c0cca`
首段：`export type SearchEntry = { ⏎   readonly description: ToolDescription`
尾段：`  /** Lowercased path + description + input property names/descriptions, for substring matching. */ ⏎   readonly searchText: string`

职责：为命中后按需发射完整 schema 留下真实输入和输出来源。

机制：SearchEntry 增加 inputContract、outputContract，而 ToolDescription 仍只保存路径、说明和签名。

必要性：详情应仅为搜索命中的条目生成，不预先扩充整个内联目录。

不做会怎样：搜索只剩文字摘要，无法从真实合同恢复字段说明、约束与引用。

配套修改：H061、H062。

#### H060 · 补齐内建 search 的输入合同

差异：`@@ -420,8 +429,10 @@ const rank = (entries: ReadonlyArray<SearchEntry>, query: string): Array<SearchE`；SHA-256：`28e64ba5229a2abe280fd15741d1b7b525daff44ef68ed1c5ee4d825c972349b`
首段：`const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition => ({ ⏎   _tag: "CodeModeTool",`
尾段：`    Effect.sync(() => { ⏎       const request = input as typeof SearchInput.Type`

职责：让 search 自身也满足新的 Definition 结构。

机制：makeSearchTool 以同一个 SearchInput 同时填写 inputContract 和 input，run 仍为内存索引上的 Effect.sync。

必要性：签名和实际解码同源规则也适用于全局 search。

不做会怎样：Definition 接口和 renderer 缺少 search 的真实输入来源；这条修改不使 search 占用工具许可。

配套修改：H077、H079、H070。

#### H061 · 按需生成搜索详情并按完整条目分页

差异：`@@ -445,25 +456,60 @@ const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition =>`；SHA-256：`d4d61d519e6c3f19b8260e4198f47dbc42b13a9a4402c04a419ac953fb78d814`
首段：`          : scoped.find( ⏎               (entry) => entry.description.path === pathQuery || toolExpression(entry.description.path) === trimmed,`
尾段：``   const description = line.length > 120 ? line.slice(0, 117) + "..." : line ⏎   return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}` ``

职责：保留原相关性排序和 offset/limit 接口，补齐真实 schema 详情及16K软预算。

机制：复用现有排名、精确匹配、offset/next和16K完整条目预算。默认至多十项，detail:true至多三项，只有详细命中项发射encoded输入和decoded输出schema，各侧发射失败用null及schemaUnavailable说明。 精确路径自动返回详情；宽泛limit:1不改变视图，显式detail:true才展开少量候选。

必要性：默认发现不应把候选的全部schema广播进上下文；确定工具后仍须取得准确字段文档。条数与完整条目软预算共同限制输出而不丢工具。

不做会怎样：保留默认全schema会继续产生不必要大输出；删详情则复杂参数/default/format不可发现；没有逐侧异常边界，一项不可表示合同会拖垮整页。

配套修改：H054、H059、H062、H075。

**1. 命中项才生成详情**

SearchEntry 保存原合同引用；每个进入本页的命中项才调用 describeSchema。Effect 输入从原合同发射 encoded schema，输出先取 Schema.toType；生成文档的 definitions 接回 $defs。普通 JSON schema 直接保留，因此字段描述、false/0 默认值和约束不用另写一套文字 renderer。

**2. 发射失败按输入、输出分别处理**

describeSchema 的 try/catch 只包这一侧的 schema 发射与文档组装。失败侧返回 null，并将 input 或 output 加入 schemaUnavailable；成功侧、工具路径、签名、相关性排序和同页其他工具继续保留。页面 JSON.stringify 与实际工具执行不在这个 catch 内。

**3. 用完整响应计量，保留跨阈值条目**

每轮先加入整项，再计算含 items、remaining、next 的序列化长度，首次达到或超过16×1024就停止。limit 继续限制条目数，offset 按已加入项数推进；单个超长项也完整返回。原相关性排序没有换成内联目录的优先级和短签名排序。

#### H062 · 把定义合同放入完整搜索索引

差异：`@@ -471,6 +517,9 @@ const catalogLine = (tool: ToolDescription) => {`；SHA-256：`34915d1f48f9e1384efeccd830da15d3c0d202bc8e755d3382efe2d74fd69bb6`
首段：`const toSearchEntry = <R>(path: string, definition: Definition<R>, description: ToolDescription): SearchEntry => ({ ⏎   description,`
尾段：`  searchText: [ ⏎     path,`

职责：构建索引时传递真实合同，保持字段搜索文本原来源。

机制：toSearchEntry 复制 definition.inputContract 和 definition.output 的引用，原 pathWords/searchText 构建继续。

必要性：H059 只定义结构，H061 需要在每个实际索引项上取得合同。

不做会怎样：详情发射拿不到每个工具的原来源；若改拿 ToolDescription，则只能恢复已压缩的字符串。

配套修改：H059、H061。

#### H063 · 先建立完整索引再安排目录展示

差异：`@@ -493,26 +542,23 @@ export const assertValidTools = <R>(tools: HostTools<R>): void => {`；SHA-256：`1eb540dab9b7a991a386ac8004c47435b092f4f7db2cd03b4a7b01712e9f33c0`
首段：`  } ⏎ } ⏎  ⏎ // 优先级只是宿主给出的当前路径；目录预算不会增加实际工具或绕过过滤。`
尾段：`    const group = namespaces.get(namespace) ?? [] ⏎     group.push(tool)`

职责：把全量能力索引与预算内文字选择分开。

机制：prepare 接收 priority，先从 visibleDefinitions 创建 index，再从 index 的 description 分组；预算仍校验非负安全整数。

必要性：优先级只影响当前过滤目录的展示，不改变可发现工具全集。

不做会怎样：若从选中条目反推索引，目录放不下的工具会从搜索消失；没有 priority 参数也无法接入宿主偏好。

配套修改：H007、H064、H065。

#### H064 · 按优先路径和签名长度选择内联项

差异：`@@ -520,64 +566,49 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`；SHA-256：`2684220da1d7dbc35f93e4c3514a0d5aebc8d6a19b08f3d88a3ddc157bfbd971`
首段：`  } ⏎   const ordered = [...namespaces].sort(([left], [right]) => compareText(left, right))`
尾段：`    } ⏎   }`

职责：在预算内优先展示宿主确认的核心工具，并让余下选择稳定。

机制：priority 变 Set；按是否优先、signature.length、完整路径排序。先扣 namespace 标题成本，再逐项尝试，超长项跳过；最后按 namespace 输出已选项及准确 shown 计数。 新注释明确 picked 只影响展示，完整 catalog 和搜索索引保留。

必要性：同样预算可先放常用入口，同时让未展示数量明确，过长一项不阻塞后项。

不做会怎样：原 round-robin 规则不会应用宿主核心优先级，也保留旧的选项分组结构。极小预算仍可能放不下优先工具，此实现不保证核心项必显。

配套修改：H063、H065、H100。

#### H065 · 返回未裁剪的搜索索引

差异：`@@ -585,7 +616,8 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`；SHA-256：`84d7e5162eb5484d84de894901a97a3e1c76373e067a6f813a6a28a45a636675`
首段：`  return { ⏎     catalog: described,`
尾段：`    searchIndex: index, ⏎   } ⏎ }`

职责：保证预算只影响 instructions 的内联展示。

机制：prepare 的 searchIndex 直接返回预先创建的完整 index。

必要性：与 H063/H064 共用一次索引构建，隐藏签名的工具仍可精确搜索。

不做会怎样：保留旧的完整索引重建也能维持能力，但会重复构建；直接返回 index 复用 H063 已完成的工作，旧行本身不会删除工具。

配套修改：H063、H064。

#### H066 · 在 namespace 误调用时提供真实签名

差异：`@@ -638,7 +670,23 @@ const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>, index: Rea`；SHA-256：`649eb2785c3518409b5053470163991ba59ab3bf01f4e8e590e37aa46fca3b46`
首段：`  } ⏎  ⏎   if (typeof value !== "function" && !isDefinition(value)) {`
尾段：`    ]) ⏎   } ⏎  ⏎   return value`

职责：给错误调用提供可恢复信息，同时保持 UnknownTool 失败。

机制：筛选当前 namespace 前缀下索引项，按2000字符预算加入整条签名；遗漏项给数量和 search 指引，绝不自动选择 leaf 执行。

必要性：模型把一组工具当函数调用时，需要知道实际可调用路径；恢复提示不得制造副作用。

不做会怎样：原错误只有 not callable，缺少当前目录可用项；自动猜工具则会把命名错误变成真实调用。

配套修改：H053、H058。

#### H067 · 在 ToolRuntime 创建唯一工具许可池

差异：`@@ -660,6 +708,8 @@ export const make = <R>(`；SHA-256：`ba6c28a10ec8f84d37aa67744470ffa49d807d1d687b84daf82973ce3e25492b`
首段：`  hooks?: ToolCallHooks<R>, ⏎   fetch?: HostTool<R>,`
尾段：`  const callableTools = { ⏎     ...tools,`

职责：把实际宿主并发控制放在数据与调用边界。

机制：每次 make 创建一个 TOOL_CALL_CONCURRENCY 大小的 Semaphore，当前常量为八。

必要性：所有工具和 fetch 要共用一组许可，async 包装与组合器不应占槽。

不做会怎样：只迁移调用包装而没有当前池，无法约束宿主并发；解释器原许可也不能再作为第二层重复调度。

配套修改：H016、H023、H070。

#### H068 · 在原解码前应用正向简写

差异：`@@ -723,7 +773,17 @@ export const make = <R>(`；SHA-256：`74fef328b825b1ffcd4877f7f3550f17cbaa95cb178079fca7812252c1288a7d`
首段：``            throw new ToolRuntimeError("InvalidToolInput", `Tool '${name}' expects at most one input object.`) ⏎           // 零参沿上游按{}进入原decoder，必填字段仍在执行前拒绝；显式undefined不替换。``
尾段：``              new ToolRuntimeError("InvalidToolInput", `Invalid input for tool '${name}': ${String(cause)}`), ⏎           })``

职责：将明确的标量简写转成对象输入，再沿原参数校验入口执行。

机制：normalizeInput 使用 tool.inputForms；结果再过 copyIn/copyOut 后交 decodeToolInput。零参仍为 {}，显式 undefined 保留，转换错误仍归 InvalidToolInput。

必要性：新构造键值也须经过危险键和普通数据检查；真实 decoder 负责 default/refinement/transform。

不做会怎样：只定义形式而不在入口应用，简写不会生效；绕过数据边界包装则可能把新字段绕进 decoder。标量合同没有反向拆包路径。

配套修改：H009、H079。

#### H069 · 输出校验后再转交原文来源

差异：`@@ -739,7 +799,8 @@ export const make = <R>(`；SHA-256：`b4c355aeb770dc08453a02e4304b1b01b71f7bcd598d5fa2272ac7d8695ac305`
首段：``                try: () => decodeToolOutput(tool, raw), ⏎                 catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),``
尾段：`            currentCall, ⏎           )`

职责：让 decoder 重建的业务结果保留来源，且不让 text 别名参与输出合同。

机制：先 decodeToolOutput(tool, raw)，再 withRawText(result, rawText(raw))，最后走 decodeOutput 的沙箱复制。

必要性：原文元数据应跨过 decoder 重建，但业务验证必须先完成。

不做会怎样：来源会在 decoder 返回新对象时丢失；若先注入 text 别名再验证，原合同会看到不属于业务的数据。

配套修改：H048、H056、H057。

#### H070 · 把许可包在实际调用入口外

差异：`@@ -750,7 +811,13 @@ export const make = <R>(`；SHA-256：`9041d27006d8825ba61b2474f339d63d3294b2780ccd98e5a7148a0033d5a7f1`
首段：`          }), ⏎           currentCall,`
尾段：`      ), ⏎   } ⏎ }`

职责：使排队先于实际校验、计数、running 通知和宿主执行。

机制：invoke 的整个 Effect 用 permits.withPermits(1) 包装；仅 $codemode.search 直通，fetch 与全部宿主调用共用许可。 两行注释分别说明准入后的计数/超时起点，以及同步 search 例外；注释压缩保持原调用语义。

必要性：队列等待不应制造假 running，也不应消耗叶子工具自身的执行超时；根取消必须能停止等待者。

不做会怎样：未包住全部入口会出现已计费但尚未运行的记录，或超出八个实际调用；把 search 也异步排队则改变其同步发现合同。

配套修改：H067、H023。

### packages/codemode/src/tool-schema.ts：合同与签名展示

源文件 SHA-256：`7d93eac35df2d6b0bd29bc1c944c4d062afc1ff1b5c2b95df0d881ddcd5e748f`
候选 SHA-256：`f216d4953b417d6f07fd99a98dddea9ecd15cb142f62987ccc5511b4a822105a`

#### H071 · 移除多行 renderer 的状态开关

差异：`@@ -34,10 +34,9 @@ const intersection = (members: ReadonlyArray<string>): string => {`；SHA-256：`f546765bd1372ea46ad67ca106d6621c37e977451206069a0f023c3c0a70ffcd`
首段：` */ ⏎ const MAX_RENDER_DEPTH = 8`
尾段：` ⏎ const hasUnresolvedRef = (`

职责：让签名渲染只携带引用定义。

机制：RenderContext 删除 pretty 字段。

必要性：和 H072/H073 一起收敛为一套紧凑 renderer。

不做会怎样：单独保留未使用的状态字段不会改变行为；这里是接口清理，真实展示变化在 H073/H075。

配套修改：H072、H073、H075。

#### H072 · 删除 JSDoc 拼装器

差异：`@@ -64,46 +63,7 @@ const hasUnresolvedRef = (`；SHA-256：`9450d312f35328ed131773b399eeb900813f2032d369cf2739764a2e7a6e417b`
首段：`  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited)) ⏎ }`
尾段：`  schema: JsonSchema, ⏎   ctx: RenderContext,`

职责：去掉第二套多行字段文档文本生成。

机制：移除 docTags 和 jsdoc，renderSchema 继续负责类型形状。

必要性：字段完整说明由 H061 的原 schema 按需交付，无需同时维护 JSDoc 转写。

不做会怎样：保留未调用的辅助函数不会破坏执行；这项删除减少重复实现，不代表字段详情应丢失。

配套修改：H061、H073。

#### H073 · 让所有 schema 渲染为紧凑类型

差异：`@@ -177,41 +137,31 @@ const renderSchema = (`；SHA-256：`31da79a83b8223e81802fbb03442cf637a7af36192250bbde6193f5561c574a9`
首段：``     const field = ([name, value]: readonly [string, JsonSchema]) => ⏎       `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}` ``
尾段：`    return renderSchema(schema, { definitions: { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } }) ⏎   } catch { ⏎     return "unknown" ⏎   }`

职责：统一对象字段、索引签名及 Effect/JSON schema 的 TS 概览输出。

机制：renderSchema 只拼单行字段；toTypeScript、jsonSchemaToTypeScript 去掉 pretty 参数，引用解析和发射失败回退 unknown 保留。

必要性：四个模型出口应复用同一概览，按需 schema 详情负责类型之外的约束。

不做会怎样：目录与搜索仍可能走不同的多行形态，同工具的签名不再同源；这项改动只影响展示，不修改 decoder。

配套修改：H058、H061、H075。

#### H074 · 字段搜索使用真实输入合同

差异：`@@ -231,16 +181,17 @@ export type InputProperty = {`；SHA-256：`7fa1c60f240bce3bfce7a0fd61422ceed93409ba9d28c0869eef3361ca99a450`
首段：`` * directly, resolving a trivial top-level `$ref` into `$defs`/`definitions` when present. ⏎  * Anything unresolvable yields `[]` (search falls back to path + description).``
尾段：`    const definitions = document.definitions ?? {} ⏎     let schema = document.schema`

职责：让字段名和字段描述的索引来源与签名、简写一致。

机制：inputProperties 从 definition.inputContract 发射或读取 JSON schema，保留 definitions/$defs 和原 top-level ref 处理。

必要性：展示 schema 经插件改写后，仍需按实际可调用字段查找工具。

不做会怎样：搜索可能按展示字段命中却与真实 decoder 不符；正向简写不适用的复杂对象也不能因此失去完整字段索引。

配套修改：H077、H079。

#### H075 · 从真实合同生成唯一输入输出签名

差异：`@@ -262,26 +213,20 @@ export const inputProperties = <R>(definition: Definition<R>): Array<InputProper`；SHA-256：`0c74be22c7057609570833173a9ae07434edae31551d035ecc331f67b8aba829`
首段：`  } ⏎ } ⏎  ⏎ // 只展示原始输入合同；运行时简写仍由同一合同推导，不把宽容形式重复注入每条签名。`
尾段：``/** ⏎  * Decodes tool input before `run` is invoked. Effect Schemas validate (throwing on failure);``

职责：把 inputContract 用于输入概览，保留真实输出来源。

机制：inputTypeScript 对 Effect 合同按 encoded 域渲染；outputTypeScript 按 decoded 域，缺失则 unknown；两者都删除 pretty 参数，也不追加简写 union。

必要性：签名展示标准输入，宽容简写由运行时派生，避免给每个工具重复扩充类型。

不做会怎样：模型仍可能看到插件改过的展示输入，或看到另一套多行签名；根据工具名字猜返回类型没有合同依据。

配套修改：H058、H073、H079。

### packages/codemode/src/tool.ts：工具定义

源文件 SHA-256：`e297f881d51f281d21376ce58cd30909aa0e69f8ec1b722334c09834d6f6a1bd`
候选 SHA-256：`77c69403bba814c18cbfb9d76422e7e72f470054fa110e2d964056b25708b428`

#### H076 · 接入输入形式派生函数

差异：`@@ -1,4 +1,6 @@`；SHA-256：`96f86dd607a2c48b58e75ef9c03a593e0f14ccb661c113b5b18550e465fe843c`
首段：`import { Effect, Schema } from "effect" ⏎ // 形式识别随真实输入合同派生，避免展示 schema 改写后简写误选字段。`
尾段：`/** ⏎  * JSON Schema subset accepted for render-only tool schemas.`

职责：为 Tool.make 从真实合同推导简写提供依赖。

机制：导入 inputForms 和 InputForms 类型。

必要性：归 H077/H079 的定义和构造使用。

不做会怎样：没有独立行为；单独删导入会造成函数或类型引用缺失，注释不增加简写规则。

配套修改：H009、H077、H079。

#### H077 · 区分输入来源合同与本层 decoder

差异：`@@ -36,6 +38,9 @@ export type SchemaType = Schema.Decoder<unknown> | JsonSchema`；SHA-256：`255e5707e036793ca9e8c1500f58fcae9cab6fe7446302ef5fa364030d56515d`
首段：`export type Definition<R = never> = { ⏎   readonly _tag: "CodeModeTool"`
尾段：`  readonly output: SchemaType | undefined ⏎   readonly run: (input: unknown) => Effect.Effect<unknown, unknown, R>`

职责：在工具定义中保存完整合同和派生形式。

机制：Definition 增加必填 inputContract、可选 inputForms；既有 input 继续决定本层是否执行 Effect 解码。

必要性：宿主适配器要展示真实合同，同时让实际解码留在原宿主入口。

不做会怎样：只复用 input 会把展示与执行混在一起，难以同时避免重复 decoder 和展示漂移。

配套修改：H068、H074、H075、H079。

#### H078 · 允许宿主传入原 decoder 来源

差异：`@@ -50,6 +55,8 @@ type ResultType<S> = S extends Schema.Decoder<unknown> ? S["Encoded"] : unknown`；SHA-256：`e87cd0dde0334497f1082a1339fb50636b6a3121a507eda35ff81821d9959757`
首段：`/** Options for defining one CodeMode tool. */ ⏎ export type Options<I extends SchemaType, O extends SchemaType | undefined, R = never> = {`
尾段：`  readonly output?: O ⏎   readonly run: (input: InputType<I>) => Effect.Effect<ResultType<O>, unknown, R>`

职责：给只用 JSON input 展示的适配器传递真实合同的选项。

机制：Options 新增可选 inputContract: Schema.Decoder<unknown>。

必要性：ToolRuntime 可以依据真实合同生成签名和简写，而原工具仍执行自己的 decoder。

不做会怎样：适配器只剩展示 JSON schema，无法证明真实参数结构和 encoded 域。

配套修改：H079、H099、H100。

#### H079 · 以同一实际合同派生展示和简写

差异：`@@ -87,10 +94,17 @@ export const isDefinition = <R = never>(value: unknown): value is Definition<R>`；SHA-256：`b1755a3b09d927457b76064538548a447a6aa52dc868617c9aa16e87dd629628`
首段：` */ ⏎ export const make = <I extends SchemaType, const O extends SchemaType | undefined = undefined, R = never>(`
尾段：`  } ⏎ }`

职责：在 Tool.make 集中确定合同优先级，不执行 decoder 探测。

机制：input 是 Effect schema 时优先使用它；否则用明确传入的 inputContract，最后才回退 JSON input。只有 Effect 合同派生 inputForms，原 input/output/run 保留。

必要性：原始输入与转换语义需要一个来源；纯展示 JSON 不能额外授予调用形式。

不做会怎样：展示、字段搜索和简写可能各用不同来源；先运行 decoder 猜形式还会重复 default/transform 的效果。

配套修改：H009、H068、H074、H075、H077、H078。

### packages/codemode/src/values.ts：Promise 值

源文件 SHA-256：`61069ee6cec59ded1c14f1214d243e91fd59cd27ab78d3851ca2112aade745a9`
候选 SHA-256：`8f6f6d092347dddc2ec2418aca2a6703cf23c8df03309b889a8e94181a9e8510`

#### H080 · 用 Fiber 或终态表示 Promise

差异：`@@ -1,11 +1,10 @@`；SHA-256：`ecf593e4ee8587c6e83366a01ea6ec3fb60a4bbd063e21dc80d3a69952009f2a`
首段：`import type { Exit, Fiber } from "effect" ⏎ `
尾段：` ⏎ export class SandboxDate {`

职责：把在途状态与跨单元可保存的结果分开，并记录结果是否被观察。

机制：SandboxPromise 改为 state 联合 { fiber } | { exit }，observed 默认 false；删去 interrupted 和 immediate Effect 字段。

必要性：H023/H046 可以统一即时与异步 Promise，并在根结束后释放旧 Fiber 引用。

不做会怎样：保留旧结构会把 race 专属取消标记和即时 Effect 带入新语义，也无法统一表达已安全退休的 Promise 结果。

配套修改：H023、H036、H046。

### packages/opencode/src/effect/runtime-flags.ts：运行模式配置

源文件 SHA-256：`fd372b725c92a47355cab7e6e55dd0b8549fdff59814c65b8ced33e0325983c3`
候选 SHA-256：`23d8ecf3d9a12878baf03a9fd58d0d1455c113396dbe057ab6cb1442d7f1b0b5`

#### H081 · 在既有运行配置中定义两个显示开关

差异：`@@ -14,6 +14,9 @@ const enabledByExperimental = (name: string) =>`；SHA-256：`55e90969efeb04aebc13a654159e236e1138991145fef247c2f429b691f44760`
首段：`  ) ⏎  ⏎ export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {`
尾段：`  pure: bool("OPENCODE_PURE"), ⏎   disableDefaultPlugins: bool("OPENCODE_DISABLE_DEFAULT_PLUGINS"),`

职责：RuntimeFlags负责进程级配置解码和缺省值，不承担权限判断。

机制：OPENCODE_EXECUTE与OPENCODE_EXECUTE_KEEP_TOOLS都使用已有Config.boolean，缺省true，启动读取。

必要性：用户需要关闭Execute或只展示Execute；现有tools兼容字典会被翻译成权限，不能独立表达显示选择。

不做会怎样：模型仍始终同时看到两种入口；用权限模拟显示可能把本应留给Execute的内部工具也删掉。

### packages/opencode/src/mcp/catalog.ts：MCP 协议投影

源文件 SHA-256：`fafeb96cf45c3c8769e13395b1d6e3a9d9628802f41eb9678a2d86f7b8796e1e`
候选 SHA-256：`bece9223f0b0b25d121d7b4c4164fe9950559304e5d1c9e9f1a4b7cf3e533f64`

#### H082 · 让 MCP 投影接收输出声明

差异：`@@ -58,7 +58,11 @@ export async function callTool(entry: MCP.McpTool, args: unknown, signal?: Abort`；SHA-256：`7f456c6c4ac30fa12dbbfbe2a8b8a0ad97457152536ae5a6340d578497ef6876`
首段：`} ⏎  ⏎ // 同一次 transport 的程序投影保留结构化值；媒体留在宿主，避免字节进入解释器。`
尾段：`  const text: string[] = [] ⏎   const attachments: NonNullable<Tool.ExecuteResult["attachments"]> = []`

职责：把判断文本投影资格所需的协议合同带到 owner。

机制：programResult 新增可选 outputSchema 参数，structuredContent 和附件处理流程保留。

必要性：只有 MCP 适配层同时知道原结果和工具声明，宿主不能仅凭文本长得像 JSON 决定。

不做会怎样：H083 无法排除已声明输出的结果，可能改变有类型工具的返回语义。

配套修改：H083、H095。

#### H083 · 标记可投影的成功单文本结果

差异：`@@ -95,7 +99,18 @@ export function programResult(result: CallToolResult): NonNullable<Tool.ExecuteR`；SHA-256：`a2846d3840d745fe3eee9f353e3247c41f1a60c271e2f389c3ab12ea0bc381da`
首段：`  // 媒体专用结果也返回可组合的普通值，让脚本知道调用成功而无需接触字节。 ⏎   const value = result.structuredContent ?? (text.length > 0 ? text.join("\n")`
尾段：` ⏎ export * as McpCatalog from "./catalog"`

职责：严格限定哪些 MCP 文本允许后续转成对象或数组。

机制：仅在非 isError、无 outputSchema、无 structuredContent、恰有一个文本且其余内容仅 image/audio 时给出 rawText。原 value 与独立 attachments 保留。

必要性：一段 schema-less JSON 文本可供脚本组合，分段文本、资源、错误和声明输出仍遵循原协议。

不做会怎样：无标记时宿主无法安全选择投影；宽泛解析会把已声明字符串、错误正文或多块协议内容改成另一种结果。

配套修改：H008、H082、H095、H100、H106。

### packages/opencode/src/session/tools.ts：Session 目录与清理

源文件 SHA-256：`c68bfb2c4427423c536a24a26c4c81c76fbc85ba373fce560ef5d7cee9eee862`
候选 SHA-256：`e370e9bf5bf4a3406cfcd8fd399fe8705a69fa2faef79c11d79b264ea3445c22`

#### H084 · 读取既有运行模式服务

差异：`@@ -1,3 +1,5 @@`；SHA-256：`ccf54147d5f62276081e163d0ecbe74cb96136937d6f9e25e0825e58f065503c`
首段：`// 工具面使用宿主现有运行配置，避免另建一套权限或项目配置解析。 ⏎ import { RuntimeFlags } from "@/effect/runtime-flags"`
尾段：`import { SessionV1 } from "@opencode-ai/core/v1/session" ⏎ import { Provider } from "@/provider/provider"`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：导入RuntimeFlags并由同一resolve调用读取，配套后面的provider显示筛选。

必要性：模式应沿宿主现有配置服务传递，不能用全局环境变量查询另开一条读取路径。

不做会怎样：显示筛选没有对应配置来源，无法提供两个独立运行模式开关。

#### H085 · 把本次预算接到真实宿主等待

差异：`@@ -28,7 +30,8 @@ import { EffectBridge } from "@/effect/bridge"`；SHA-256：`08e41730d167eeb332ff9887b4790f4b17c646cf5f264206f2cdba7395c823c0`
首段：`import { ProviderV2 } from "@opencode-ai/core/provider" ⏎ import { ModelV2 } from "@opencode-ai/core/model"`
尾段：`type ToolTimingInput = { ⏎   source: "local" | "mcp"`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：复用已有code-mode模块的预算工厂导入，由本次Execute分支创建实例。

必要性：同一宿主模块已经提供CodeModeHost与HTTP能力，不另建计时模块或全局状态。

不做会怎样：缺少配套导入，实际创建预算的分支无法解析；导入本身不增加另一种计时政策。

#### H086 · 把进程模式带入本次工具解析

差异：`@@ -108,6 +111,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`a330adbddf7fb6355c35e6a7c44b60d0bfab8b95707997d614d952f653b0b21f`
首段：`  const run = yield* EffectBridge.make() ⏎   const plugin = yield* Plugin.Service`
尾段：`  const mcp = yield* MCP.Service ⏎   const truncate = yield* Truncate.Service`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：从已提供的RuntimeFlags.Service取得当前启动配置，后续筛选只使用这份状态。

必要性：显示模式与权限结果是不同输入；不能从eligible里是否存在execute反推模式。

不做会怎样：Execute权限被禁止时可能错误恢复用户选择隐藏的原工具。

#### H087 · 把本次预算接到真实宿主等待

差异：`@@ -116,6 +121,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`42805c2a45570193a4f3de53825dc18473668805bea29ee5287cbd4679c51e78`
首段：`  type Execution = { ⏎     // child 继承本次批准与已完成上下文，身份始终由宿主分配而非脚本传参。`
尾段：`    review: Permission.ExecuteReview ⏎     messages: SessionV1.WithParts[]`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：私有Execution类型增加泛型pause包装器，工具child携带当前根预算。

必要性：child执行经过独立run.promise，不能依赖隐式Fiber上下文传递。

不做会怎样：没有这个字段，ctx.ask无法对正在计时的根预算暂停，或不得不从全局猜当前执行。

#### H088 · 把本次预算接到真实宿主等待

差异：`@@ -172,7 +179,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`aa401ef9e57be33631916f59250b69a6fcac94839fccde2c331cec9d5393faa2`
首段：`        }) ⏎         // #216：权限询问与 abort 信号竞速——cancel 时不再阻塞在 permission.ask 而是立即失败`
尾段：` ⏎   const inventory: Record<string, Tool.Def> = Object.fromEntries((yield* registry.tools({`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：context.ask在执行权限询问/审批的同一Effect外调用execution.pause，直接工具无Execution仍走原调用。现有abort竞争和错误传播保留。

必要性：所有真实native、MCP与fetch权限都通过这个ctx.ask；暂停应由这个共同owner定义。

不做会怎样：运行中升阶审批仍消耗脚本期限，用户回答前整个Execute可能被误判超时。

#### H089 · 把本次预算接到真实宿主等待

差异：`@@ -197,6 +205,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`f91f440b906e1c70bd5c3fd93491d8601047f315477494d3ae93ecb2c96f01c9`
首段：`            let parent: SessionV1.ToolPart | undefined ⏎             return yield* Effect.gen(function* () {`
尾段：`              // 用户取消与权限终止共享 signal，后续 leaf 和已运行任务观察同一结束原因。 ⏎               const signal = AbortSignal.any(options.abortSignal ? [options.abortSignal, controller.signal] : [controller.signal])`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：每次execute创建独立预算，并把wait闭包交给CodeModeHost。创建不扣时，解释器启动竞争时才调用wait。

必要性：暂停状态不能跨Execute共享，也不能在预跑或初始审批时开始消耗真实执行预算。

不做会怎样：全局或过早起算会使别的Execute受影响，或用户还在初始审批时已失去执行时间。

#### H090 · 把本次预算接到真实宿主等待

差异：`@@ -204,6 +214,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`086059ae663521e58f0eb569b34a5f89455bcf741005ade3844d1fa719da5689`
首段：`              let sequence = 0 ⏎               ctx.codeMode = {`
尾段：`                fetch: (url, init) => Effect.gen(function* () { ⏎                   if (signal.aborted) return yield* Effect.interrupt ⏎                   const approved = review`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：每次execute创建独立预算，并把wait闭包交给CodeModeHost。创建不扣时，解释器启动竞争时才调用wait。

必要性：暂停状态不能跨Execute共享，也不能在预跑或初始审批时开始消耗真实执行预算。

不做会怎样：全局或过早起算会使别的Execute受影响，或用户还在初始审批时已失去执行时间。

#### H091 · 把本次预算接到真实宿主等待

差异：`@@ -212,6 +224,7 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`17730cb905ed481544f8dab75cd85552458de802913a43c2c4e1bd381949c7c7`
首段：`                  // 复用真实子调用的权限上下文，HTTP也服从整段批准、升阶及终止。 ⏎                   return yield* fetchHTTP(url, init, context({}, { ...options, abortSignal: signal }, {`
尾段：`                }), ⏎                 begin: (code, calls) => Effect.gen(function* () {`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：fetch的私有Execution携带budget.pause，让其ctx.ask引用当前根预算。

必要性：HTTP复用相同权限上下文，但不通过普通child构建点；这个唯一差别需要明确传递同一个能力。

不做会怎样：HTTP权限审批会继续扣脚本时间，即使普通工具审批已暂停；真实HTTP请求自己的30秒期限不改变。

#### H092 · 把本次预算接到真实宿主等待

差异：`@@ -253,6 +266,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`fa28e32f06b3656c6acf95ab9eedfb94bfb3ebb78d85d48bbfd4c0b6924de1d2`
首段：`                    }) ⏎                   const child: Execution = {`
尾段：`                  } ⏎                   return yield* input.processor.runChild({ parentCallID: options.toolCallId, callID, tool: id, input: args },`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：child Execution携带budget.pause，随后经原invoke/run.promise进入ctx.ask。

必要性：每个独立宿主Promise必须接到同一次Execute预算，不能各自开启或重置计时器。

不做会怎样：真实子调用与库根计时器断开，单独改变ctx.ask并不能排除人工等待时间。

#### H093 · 说明并展开 child 的取消与清理边界

差异：`@@ -261,9 +276,17 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`30f23967d4fedfac8c08e8aac3010a65ce8b08310fb269bd5d83caafad236bbc`
首段：`                      const cancel = new AbortController() ⏎                       const pending = invoke(leaf, args, { ...options, toolCallId: callID, abortSignal: AbortSignal.any([signal, cancel.signal]) }, child)`
尾段：`                    }), ⏎                   ).pipe(Effect.onExit(() => Effect.gen(function* () {`

职责：说明真实 child 的取消通知和清理完成顺序，并展开原 pending 回调以便阅读。

机制：注释说明根 Scope 或宿主中断触发取消、abort 仅发通知、ensuring 等原 pending 完成；Effect.ensuring/Effect.promise/pending.then 的原表达式分行显示，两个回调仍分别返回 undefined。

必要性：race 只竞争观察，实际 child 由根或宿主取消；同环境下一格接管资源仍依赖原 Promise 完成。分行后能直接看清两个完成分支都归同一清理等待。

不做会怎样：保留旧排版不改变执行。缺少准确注释会让维护者误把 race 获胜当作生产者取消，或把 abort 通知当作资源已释放；本 hunk 没有取消或清理算法变更。

配套修改：H023、H036、H100。

#### H094 · 把本次预算接到真实宿主等待

差异：`@@ -303,7 +326,11 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`5ee63c54e322ec5a833f53dd19e1466e82778e7b9212b9b857a47bbc1eb4cff3`
首段：`              // hook 后的真实参数留给原 decoder/body；权限事实由工具自身的 ctx.ask 产生。 ⏎               yield* input.processor.updateToolCall(options.toolCallId, (part) => ({ ...part, state: { ...part.state, input: args } }))`
尾段：`              ...result, ⏎               attachments: result.attachments?.map((attachment) => ({`

职责：SessionTools在自己的执行上下文中连接宿主计时能力。

机制：仅本次Execute中的question工具body由execution.pause包住，再进入原timedToolExecution；普通工具body不暂停。

必要性：question的等待不调用ctx.ask，必须在其已有真实工具边界纳入同一预算。

不做会怎样：用户回答问题仍会耗尽脚本期限；若包住所有工具，则shell、读文件和网络等待会错误变成无限额工作。

#### H095 · 把 MCP 原输出声明交给投影

差异：`@@ -601,7 +628,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`162af125ca03407163636e124c5bf3cef0d653b6a3c108333896687b675dfc15`
首段：`            output: truncated.content, ⏎             attachments,`
尾段：`        }).pipe(Effect.orDie), ⏎     }`

职责：在实际 Session MCP 返回路径接通资格判断。

机制：McpCatalog.programResult(result, entry.def.outputSchema) 替代只传 result。

必要性：H082/H083 的条件需要实际工具定义，不能由展示结果倒推。

不做会怎样：声明输出的 MCP 结果会被误认为无 schema 候选；SDK 原输出验证仍由既有调用负责。

配套修改：H082、H083。

#### H096 · 把原 decoder 来源放进 Session 目录

差异：`@@ -621,10 +649,19 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`d420fda774892194742a24a25eebc13c5364c3944db9e575325cbde1fc31893a`
首段：`        : "$opencode" ⏎       const local = entry && item.id.startsWith(server + "_") ? item.id.slice(server.length + 1) : item.id`
尾段：`    // Provider 只负责参数呈现；直接与嵌套入口都继续复用工具原来的运行时校验。 ⏎     tools[item.id] = tool({`

职责：让宿主目录携带真实 runtimeParameters，同时保留现有展示 schema 和输出合同。

机制：目录项传递item.runtimeParameters，返回对象保持逐字段展开；catalog.push、filter、namespace查找等未变语句恢复基线排版。 完整catalog构建后，provider循环按RuntimeFlags隐藏脚本可调用工具；控制工具保留，权限禁止不自动切换模式。

必要性：真实decoder来源必须经SessionTools到toolTree，插件展示变化不能夺取参数合同。未改变的筛选和命名语句无需重新排版。

不做会怎样：省去runtimeParameters会丢失实际合同；恢复未变语句原文不改变行为，只减少主干无关diff。 若先从inventory删除工具，Execute-only会连带失去内层调用能力；若依据权限回退，显示模式会违背用户选择。

配套修改：H099、H100、H104、H108、H109。

### packages/opencode/src/tool/code-mode.ts：Execute 宿主

源文件 SHA-256：`2d16bff069c584a73689cdc821aa0b39e9508163dba369c84367e6ded1b8369d`
候选 SHA-256：`30a6eba87b256429395a94ac8591240bfbb799a4fb2429e3f8a11153dbe42dca`

#### H097 · 建立宿主可暂停预算并声明环境和期限参数

差异：`@@ -1,13 +1,74 @@`；SHA-256：`55880206c5ce4cfb38f7d3b2e4750a4b3fd9eb6a516cc83df795ab68a5e55a0e`
首段：`import { Tool } from "./tool" ⏎ import { Truncate } from "./truncate"`
尾段：`    description: "Script body executed by the confined interpreter.", ⏎   }),`

职责：宿主拥有人工等待政策，提供本次独立剩余预算，参数仍由公共schema验证。

机制：makeExecutionBudget使用Clock、等待计数、剩余时间和单个变更Deferred；首次人工等待扣除已用时间，最后一个离开后恢复，acquireUseRelease保证异常/中断归还。真正wait调用才起算，外部取消保持独立。environmentID可选，timeout默认600000且上限2147483647。

必要性：固定墙钟会把用户等待计入执行工作；并发问题不能重置或重复扣除预算。已创建对象不能提前消耗预跑和初始审批时间。

不做会怎样：用户稍晚回答会被脚本超时打断；一个等待结束可能错误恢复仍有其他等待的预算；超大参数会悄悄变成无期限。

配套修改：H100、H101。

#### H098 · 在每份进度 metadata 保留环境 ID

差异：`@@ -16,6 +77,8 @@ export const Parameters = Schema.Struct({`；SHA-256：`29ec35c45ef7b7403e0668986ee5e40a110a5a5db91cbfb50a01980647d79565`
首段：`type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> } ⏎ `
尾段：`  error?: boolean ⏎   loaded?: string[]`

职责：使成功、进度与错误回执可以指回同一环境。

机制：Metadata 增加 environmentID 字段；H100 在每次整对象更新时填写。

必要性：进度 metadata 被替换时，环境句柄不能只存在第一份回执。

不做会怎样：仅开始时发 ID，后续更新会丢结构化句柄，出错或取消后难以复用。

配套修改：H100。

#### H099 · 声明目录项中的原 decoder 来源

差异：`@@ -25,16 +88,19 @@ type Metadata = {`；SHA-256：`e0c8a8056e48b20d0b893bf709a1aec5ba4d958227620ada737642b7d8a7923f`
首段：`type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number] ⏎ `
尾段：`  begin(code: string, calls: readonly PermissionPrecheck.ExecuteCall[]): Effect.Effect<void> ⏎   invoke(id: string, input: unknown): Effect.Effect<Tool.ExecuteResult, unknown>`

职责：把 Session 目录与 CodeMode Tool.make 的真实合同入口连起来。

机制：CatalogEntry 新增可选 runtimeParameters，inputSchema 继续负责展示 JSON。

必要性：工具可有真实 Effect decoder，也可只有 MCP/自定义 schema，类型需保留这一区别。

不做会怎样：宿主适配器无法把 H096 收到的原合同传给 H078/H079，或只能把展示 schema 当实际来源。

配套修改：H096、H100。

#### H100 · 串起真实 Execute 的环境、预跑与交付

差异：`@@ -84,139 +150,263 @@ const toolTree = Effect.fn("CodeMode.toolTree")(function* (`；SHA-256：`771a95ca8a268f5f6f8eb2072feeff1c4190ac010f2ed4f68c32c0e619c40902`
首段：`      description: entry.description, ⏎       // 沿用 V1 原 JSON Schema 签名适配：对象原样透传，真实输入校验仍由工具拥有。`
尾段：`    } ⏎     return init`

职责：在现有宿主入口组合当前工具、环境租约、预跑检查、真实执行、进度和最终输出。

机制：toolTree 传原 inputContract；discovery 只优先当前原生 read/grep/glob/edit。完整单一 JS/TS 外围栏规范化一次，外层同步 abort 观察覆盖租约排队。租约内创建 runtime，真实预算默认十分钟，探针用同一源码和环境副本、两秒期限。进度先检查100毫秒窗口再复制列表；结果保留 ID、上下文、附件、日志与未观察提醒，把完整正文交既有 wrapper 截断。 实际runtime接收宿主waitForTimeout；该预算只在真实执行起算，预跑仍用自己的两秒期限。

必要性：这组连续改动把各库能力接到真实 Session 路径：权限与工具校验沿原入口，环境串行持续到根清理完成，输出事实不由脚本的 return 筛掉。

不做会怎样：只改库而不接宿主，环境和输入合同不会生效；原空环境预跑看不到旧 helper；每事件都快照会放大父进度开销；成功或失败正文也缺少环境 ID 和新增异步失败事实。输出直接复用既有统一截断，最终实现没有宿主折半 JSON 预览。

配套修改：H008、H020、H045、H046、H064、H083、H097、H098、H099、H101。

**1. 合同来源与原生核心项**

toolTree 把 runtimeParameters 作为 inputContract，input 仍是原 JSON 展示适配，原工具执行 decoder。discovery 只接受当前目录中带 runtimeParameters、namespace 为 $opencode、id 为 read/grep/glob/edit 的项。describeCatalog 与真实 runtime 共用这个选择，既不添加已过滤工具，也不提升同名 MCP 工具。

**2. 同一份规范化源码进入三个阶段**

只移除完整、唯一、标签为 JS/TS 或无标签的外层代码围栏；混合文本和内层围栏仍交原编译器。规范化后的 code 同时传给探针、host.begin 和真实 runtime.execute，避免权限审查和实际执行看到不同源码。

**3. 取消覆盖环境等待，执行起点登记修复留在库内**

宿主保留 AbortSignal 的同步 resume(Effect.interrupt)，外层 raceFirst 包住 environments.use，所以排队也能被取消；监听器退出时移除。公共执行入口的 yieldNow 归 H040，它在脚本启动前让外层 timeout/race 完成登记，子生产者仍同步启动并原子登记。此处没有给 abort listener 延迟通知。

**4. 环境 ID、进度和最终状态分别交付**

拿到租约后先发 durable 更新，把同一 ID 放进 metadata 和正文。真实调用的首条 ephemeral 进度立即发送，后续事件先检查100毫秒窗口再复制 calls；没有定时刷新任务。跳过的是父进度快照，child hooks、权限和调用终态照常记录。最终成功由原 ToolResult 持久化，失败/中断由 onExit 保存 ID、完整 calls、错误与已收上下文。

**5. 工具结果、媒体与上下文分开**

每次 host.invoke 返回后先收取附件，并按 kind:key 去重实际收到的 context。只有 program.rawText 标记触发 fromJsonText；其他 program.value，包括 null、false、0，原样选用。脚本 return 1 也不会撤掉宿主已经收到的规则正文和媒体。

**6. 真实预算与探针期限分开**

真实 runtime 在租约内绑定 lease.environment、当前 tools/fetch、默认600000毫秒或显式 timeout，以及现有 Truncate maxBytes 派生的 maxLogBytes。环境排队、预跑和 host.begin 都在 runtime.execute 之外。探针复制同一环境，使用当前桩工具和两秒 timeout，无旧128次工具调用上限；HTTP 桩只记录意图，不发网络。探针失败前已观察到的调用仍交给 host.begin，真实权限检查继续负责后来才确定的调用。

**7. 完整正文交现有 wrapper**

普通失败保持 Effect.fail，正文含 ID、诊断、建议与已捕获日志。成功正文合并 ID、必要的未观察失败提醒、上下文和业务结果，附件单独返回；提醒只陈述未观察事实，不罗列全部失败 child 名称。宿主按原规则 stringify 完整业务值，未添加折半 JSON 预览、手工 truncated/outputPath 或业务数组裁剪；Tool.wrap 继续负责统一截断、落盘和恢复路径。

**8. 展开已有表达式并注明交付约束**

fetch 的 method/url 展示、probe 的 toolTree 回调和 HTTP 桩结果展开为多行，求值顺序与字段值保持。注释说明 context 按 kind:key 更新、调用终态沿启动 index 回写、成功仅由 ToolResult 持久化、日志合并和重复错误提示过滤；这些说明不增加新的执行策略。

### packages/opencode/src/tool/execute-environments.ts：环境租约

源文件 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（基线不存在此文件）
候选 SHA-256：`52ebece9f63d1e8a9bef35a574a2c1282258d2b6de0a40525021dd8ca470b761`

#### H101 · 按 Session 与位置管理串行环境租约

差异：`@@ -0,0 +1,234 @@`；SHA-256：`3842e44d8798fcdeb70cca97f4de658aedd58000e49a3a61ea0ee053197b06bd`
首段：`import { CodeMode } from "@opencode-ai/codemode" ⏎ import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"`
尾段：`export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node, SessionStore.node] }) ⏎ export * as ExecuteEnvironments from "./execute-environments"`

职责：为跨格词法状态提供归属、容量、串行和真实回收。

机制：使用原owner校验、gate、cancel、drained和users管理租约。每个owner最多八项，Map顺序在acquire刷新，release只处理清理；新建超过八项时等待最旧活动项drain并重新选择，只取消自己的等待。Session退休和实例关闭仍先关闭准入再取消并等清理。

必要性：Notebook需保留最近使用的唯一环境，慢调用的结束顺序不能改变LRU；不能为腾槽取消仍在运行的工具或跳过更旧环境淘汰较新状态。

不做会怎样：原64项/闲置顺序与最近八项不符；若忙时直接删Map或跳过最旧项，可能丢失真实执行/保留错误集合；没有drain和finally则排队取消可能永久占槽。

配套修改：H010、H100、H105。

**1. 状态、租约和退休各自承担一种职责**

Environment保存词法状态；gate串行实际执行；users包含排队；drained表示当前租约清理完毕；cancel只用于整环境退休。acquire与释放逻辑的安装保持不可中断，只有等待最旧drain这一段可中断，避免增计数后失去释放者。

**2. 调用顺序决定保留集合**

每次成功接纳同一ID只移动原条目，不增加环境数。新建者在等待后重读owner集合，保留等待期间发生的复用刷新；release不重新排序。旧ID被淘汰后明确不可用，不自动创建替代环境。

### packages/opencode/src/tool/registry.ts：Registry 合同和依赖

源文件 SHA-256：`fb07f6ea12655025ef2fd758a055f613651361560c992b28c8317d203247343b`
候选 SHA-256：`e676077221ff0c0fa7890d6776a61be4db8bc5efe969d1d5377e51ce55493d66`

#### H102 · 导入环境服务节点

差异：`@@ -59,6 +59,8 @@ import { MCP } from "@/mcp"`；SHA-256：`bec3cb2322772a964ca1e3c8071100aa559465cd5c1afcb8f2e613b2164b22cc`
首段：`import { PermissionV1 } from "@opencode-ai/core/v1/permission" ⏎ // #277：read 工具的图片附件处理收敛到 Image.Service，registry 需要装配该依赖`
尾段：`export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) { ⏎   return (`

职责：为 Registry 依赖图接入环境管理提供符号。

机制：新增 ExecuteEnvironments import。

必要性：归 H105 的依赖装配使用。

不做会怎样：本 hunk 没有独立缓存或生命周期行为；单独删导入会使节点引用无法解析。

配套修改：H105。

#### H103 · 在共同工具列表出口应用Execute开关

差异：`@@ -281,7 +283,8 @@ const layer = Layer.effect(`；SHA-256：`fe36907b484461378cd7d36e656bb40eb11f0d24c8fbcc1e227857546f709d23`
首段：`    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () { ⏎       const s = yield* InstanceState.get(state)`
尾段：` ⏎     const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {`

职责：Registry.all拥有本地工具集合，供实际调用与ids展示共用。

机制：仅当flags.execute为false时移除execute，原工具与插件条目保留。

必要性：SessionTools、HTTP、TUI及debug都读取同一Registry，不能只隐藏其中一个界面。

不做会怎样：关闭Execute后工具选择器仍出现它，或用户可以经另一入口看到与设置不一致的工具集合。

#### H104 · 插件修改展示后仍保留原合同

差异：`@@ -347,6 +350,9 @@ const layer = Layer.effect(`；SHA-256：`c69d5b071858b4ace9f0f6fb6b8272b46bc9948dda504c2115df78409e0acd88`
首段：`              .filter(Boolean) ⏎               .join("\n"),`
尾段：`            output: tool.output, ⏎             // #557：plugin 只能改 Provider definition；server policy 始终取原 Tool.Def。`

职责：在 Registry 的 definition hook 之后把实际 decoder 来源传下去。

机制：返回定义使用 output.parameters 展示，同时 runtimeParameters 取原 tool.runtimeParameters。

必要性：插件可改说明和展示参数，实际 wrapper 闭包仍使用原 decoder，两者需保持清晰。

不做会怎样：Session 只能看到插件修改后的展示参数，签名和简写会与真实校验产生偏差。

配套修改：H096、H108、H109。

#### H105 · 沿现有依赖图提供环境服务

差异：`@@ -466,6 +472,8 @@ export const node = LayerNode.make({`；SHA-256：`4fd65a6a1004e5fe96c6b1798a85b205857524dcbb3c97ab289c755b9bfa1932`
首段：`    Instruction.node, ⏎     FSUtil.node,`
尾段：`    CrossSpawnSpawner.node, ⏎     Format.node,`

职责：让 Execute 初始化获得 InstanceState 下的环境 owner。

机制：ToolRegistry 的 LayerNode deps 加入 ExecuteEnvironments.node，其 SessionStore/事件依赖由该节点提供。

必要性：环境管理应随既有实例生命周期创建与释放，不在 resolver 每次建立另一份缓存。

不做会怎样：CodeModeTool 取不到所需服务，或被迫把状态放到错误的 resolver 寿命中。

配套修改：H101、H102。

### packages/opencode/src/tool/tool.ts：工具 wrapper

源文件 SHA-256：`8f7e44cd4dbd379e51847285a82e1cbedc8c2f81d41bc68de79c78039c1ad2ac`
候选 SHA-256：`c09b229b7b358a69e6ff606934d57ea0f1ef68f44b5d64be97cfebc9675f1e5c`

#### H106 · 在程序结果通道声明 rawText

差异：`@@ -57,7 +57,12 @@ export interface ExecuteResult<M extends Metadata = Metadata> {`；SHA-256：`a0eb22acf61cacaf02c59816bed8cc580b6134a01057a8f2e6d4467a7144f1b4`
首段：`  output: string ⏎   attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]`
尾段：`  context?: { kind: "instruction" | "skill"; key: string; text: string }[] ⏎ }`

职责：给协议 owner 的候选标记提供宿主类型出口。

机制：ExecuteResult.program 扩展为 value、可选 rawText 和 attachments；普通 output 与 context 继续分开。

必要性：MCP 投影要把资格事实传到 Execute，不应通过正文猜测或改变用户可见 MCP output。

不做会怎样：H083 的标记无法沿实际结果结构传到 H100；把它塞进业务 value 则会污染脚本数据。

配套修改：H083、H100。

#### H107 · 在工具定义声明原参数来源

差异：`@@ -69,6 +74,8 @@ export interface Def<`；SHA-256：`73078c9d25047f41e1b02400f367a2b9a12245209b4cc1368e3651a986afc1a1`
首段：`  id: string ⏎   description: string`
尾段：`  // 程序值的同一声明服务目录和解码；输入校验仍由 parameters 独立拥有。 ⏎   output?: Schema.Decoder<unknown> | JSONSchema7`

职责：让 wrapper 保留的 decoder 引用可经过 Registry 与 Session。

机制：Def 增加只读可选 runtimeParameters，parameters/jsonSchema/output 的职责不变。

必要性：这条类型链只保存已有来源，不在工具启动路径引入解释器依赖。

不做会怎样：后续层没有标准字段接收真实 decoder，只能依赖可能被插件修改的展示参数。

配套修改：H104、H108、H109。

#### H108 · 固定 wrapper 实际使用的参数来源

差异：`@@ -146,10 +153,10 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`；SHA-256：`ff51a6e0c36956e82902fd97fa795d05075a34ffe01509c95ecaf63f10335e85`
首段：`  return () => ⏎     Effect.gen(function* () {`
尾段：`      toolInfo.execute = (args, ctx) => { ⏎         // #155：streaming metadata 先消毒再转发，避免终端转义序列先落 UI`

职责：在编译 parser 的同一位置保存原 schema 引用。

机制：runtimeParameters = toolInfo.parameters，decodeUnknownEffect 用这个引用在 init 时编译一次；未调用 decoder 做形式探测。原连续三行英文说明改成两处单行中文注释，分别贴近合同捕获和 parser 编译。

必要性：保存来源必须与真实闭包所用合同完全一致，default/transform 也不能因分类先执行一次。

不做会怎样：仅接受 initializer 自报 runtimeParameters 可能与实际 parser 不一致；原 decoder 仍应只在真实调用执行。注释替换保留了每次 init 只编译一次的维护约束，自身不改变执行。

配套修改：H107、H109。

#### H109 · 返回由 wrapper 确认的原参数来源

差异：`@@ -199,7 +206,8 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`；SHA-256：`0728d1ef8e21d0a4072f9f51530cfe56fd50295a005a5fc30fd97fb75656c8d7`
首段：`          } ⏎         }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))`
尾段：`    }) ⏎ }`

职责：将真实 parser 来源交给后续 Registry，并覆盖 initializer 同名字段。

机制：wrap 返回 { ...toolInfo, runtimeParameters }，把 H108 捕获的引用放在展开之后。

必要性：原合同的权威来源是 wrapper 编译 decoder 的位置。

不做会怎样：后续层拿不到保存的原引用，或 initializer 提供的同名字段覆盖它，导致展示和简写再次偏离真实执行。

配套修改：H096、H104、H108。

## 13. 修改范围与代码写法

生产修改集中在前述18个文件，测试12个文件，文档为 README 和现有计划文件，共32个路径。输入形式、原文来源、环境租约各有一个清楚的所有者，其余都扩展现有函数。

长调用和多分支按仓库120列正常排版，保留空行。既有文件只展开实际修改的完整语句；新文件整体排版。保留原 fetchHTTP、未改的 Session 主干和原解释器方法格式，避免把功能改动变成全文件重排。

注释写在需要解释的代码旁：根 Scope 与观察者的区别、原子登记窗口、闭包局部帧、真实 encoded 合同、准入后计时、图复制的共享身份、协议投影资格、统一截断中的完整恢复正文。删除重复翻译变量名、逐行复述赋值和只记录旧方案的注释。

整个 PR 相对共同基线的生产新增加删除最多2000行，净增最多1200行；测试和文档另算。有效变更代码 E 排除空行、仅 import、纯格式、生成物及纯移动。合格中文说明 C 按逻辑注释块计数，必须严格超过 E 的15%；需要的最少条数是 floor(E × 0.15) + 1。逐 hunk 对应此前提交和当前修改，不能只补本轮。

普通注释连续最多两行，一段连续说明只算一条，不能用空行拆开同一个意思增加数量。函数 docstring 可超过两行，但只说明该函数的输入、输出、效果、生命周期或错误合同，一块仍算一条。文档、仅导入旁说明和重复代码含义的文字不能代替邻近的有效解释。code-mode.txt 按用户要求完全排除 C、E 和逐 hunk 中文说明检查。

关键生产代码分别说明调用登记、闭包共享、参数来源、准入和清理的责任；重要测试在实际观察点解释夹具如何建立前提、门闩为何能捕获过早返回、预期值从哪里来，以及怎样排除权限或副作用的假通过。复杂步骤不能只靠段首概述，说明应靠近各自负责的代码；不重复翻译变量和断言，也不写与函数无关的设计辩论。

当前候选相对共同基线：生产新增1418行、删除574行，总修改1992行、净增844行；18个生产文件、12个测试文件和2份文档，共32个路径。全PR有效修改 E=5456，合格中文逻辑说明 C=886，比例16.24%；严格门槛819条。排除code-mode.txt后235个hunk均有对应中文说明，新增普通注释没有超过连续两行。

生产和测试逐文件记录新增、删除及净增；共同基线使用原字节，不先格式化基线减小修改量。中文说明先按 AST/统一排版排除纯格式，再对应原始源行，保留逐条语义分类和逻辑注释块清单。两类统计分开，不能用有效行 E 代替生产新增加删除上限。最终候选重新核算每个 hunk 的邻近说明、连续行数、C/E 与全部路径。

### 常用组合能力的选择

保留当前 all、allSettled、race、for-await 和 sleep，并在共同回调入口加入 then/catch。八许可已经在宿主入口统一生效，另加 mapLimit 或 Promise.all 自动分批会重复并发策略，也可能改变脚本的启动顺序；这一需求由现有入口完成。

路径继续使用工具返回的完整 path 和原工具参数。跨平台 path.join/dirname 需要明确采用哪种平台语义，不能因为一段建议示例就让同一字符串在不同宿主下改变含义。Object.fromEntries 和 Array.at 已有实现，公开组合回归直接验证 entries→filter→fromEntries 及 at(-1)，不新增替代代码。Promise.any 不能直接照搬 Effect.raceAll：实测 interrupt 与延迟成功竞争会返回成功，与 never 竞争会继续等待，全部失败的原因还按结算顺序排列。它需要新的首成功/中断与输入顺序错误归集合同，本轮保留明确的现有组合器，不把 race 当作 any。

社区方案借鉴具体做法：Pi 的短用途说明、代码内组合和过滤；上游 #62336 的 namespace 发现缺口；#62176 的目录可发现性目标。本分支用一个稳定目录选择器和完整搜索满足它，不引入另一套 namespace 展开状态机。#60709 的后台 job 依赖另一套执行生命周期，这里仍由当前 Execute 根 Scope 收尾。

#62316、#62336、#58708、#59566 是 issue；#62176、#60709 是提案 PR。它们说明问题和方向，不能当作本分支已测的 token、费用或重试收益。实际比较使用本计划第6、9节的同工具集实验。

## 14. 验证命令与交付检查

库测试从 packages/codemode 执行：

```sh
bun test
bun run typecheck
```

宿主受影响回归从 packages/opencode 执行：

```sh
bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/execute-environments.test.ts test/tool/registry.test.ts test/session/execute.test.ts test/session/tools.test.ts test/mcp/catalog.test.ts test/tool/truncation.test.ts
bun run typecheck
```

类型检查内存不足时，用同一个包的单线程编译补充验证，命令行设置不写进仓库：

```sh
GOMEMLIMIT=512MiB GOGC=20 bun run typecheck --singleThreaded
```

CLI 和 Session 整合回归仍覆盖实际进程启动、数据库与清理，从对应包执行：

```sh
bun test test/cli/db-maintenance.test.ts test/cli/run/run-process.test.ts test/cli/tui/daemon.test.ts
```

从 packages/core 执行：

```sh
bun test test/project-copy.test.ts
```

对改动 TS 运行仓库现有 lint/format 检查，并与共同基线区分既有警告。`git diff --check` 检查空白错误；逐文件 `git diff --numstat a012050 --` 给出生产、测试、文档三类新增/删除和路径数。格式化不得改 AST、字符串内容或模型实际收到的 prompt 段。

在同一份最终候选上重跑真实提示词例子、输入 schema 权威性、环境复用与权限、根生命周期、分页、回执、日志和统一截断。单项隔离实验通过以后，仍要跑整合回归，避免在共同 runtime/host 入口合并时破坏另一项行为。

全量实现审查逐一对照本计划和最终生产 diff。审查通过后检查本地提交、远端功能分支和目标分支，保留用户新提交；仅更新已有 PR 功能分支。必要的 rebase 后重新跑受影响检查，不推目标分支、不合并。

发布前核对远端提交和完整 tree 与本地一致，PR 描述列实际测试结果。原样 pre-push 由 `sh .husky/pre-push` 执行；若资源限制再次导致 SIGKILL，按用户允许的 hook 例外提交，同时写明未通过的原门禁和实际通过的补充检查。

测试中的 CallEntry 期望数组使用 `as const` 保留 completed/error 状态字面量，避免 map 把它推宽为 string；不改变预期值和断言。该文件同时运行行为测试与类型检查。
