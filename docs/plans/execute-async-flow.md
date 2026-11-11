<!-- 本文对应完整设计与验收；逐字用户原文另在私下交付的同一计划末尾保留。 -->

# Execute 设计与验证计划

## 1. 要达到的使用方式

Execute 用一段 JavaScript/TypeScript 组合工具调用，在代码里筛选和汇总中间结果，把下一步判断需要的内容交给模型。简单调用直接写，独立调用可以并发，前后有数据依赖的调用按数据流连接。模型不必替执行器维护取消、任务回收、参数包装和输出协议。

这次修改沿用现有解释器、工具入口和 Session 权限检查。异步函数、组合器、宿主调用和 sleep 共用一次执行的根作用域；Notebook 环境只保存变量、函数、闭包和数据，不保存上一轮权限。目录、搜索和运行时使用同一份真实工具合同。

以下方案覆盖 PR #1 相对共同基线 `a012050340b7eeed68488018205f2ed4cf8d4f0f` 的全部修改，包括当前工作树。目标分支为 `dev1-smark`，更新已有功能分支 `execute-async-flow`。

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

`observePromise` 读取生产者的 Exit；`settlePromise` 将 Exit 还原为语言结果或错误。取消观察者不会取消生产者。

- `Promise.all` 同时观察所有成员，输出按输入顺序排列。后一项失败不能被一直等待的前一项挡住。
- `Promise.allSettled` 把普通拒绝变成 `{ status, reason }`，保留所有结果；宿主中断仍向外传播，不伪装成可继续的普通结果。
- `Promise.race` 只选择最先结算的结果。败方仍能再次 await；空数组保持 pending，直到本次执行超时或取消。
- 组合器本身也返回 Promise，能嵌套和传给另一个组合器。

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

### 4.2 Execute 与 sleep

宿主 `timeout` 缺省为 600000 毫秒，显式值仍走参数 schema。脚本执行预算包含工具许可排队，但环境租约等待、预跑及整段检查不消耗真实脚本预算。

`sleep(ms)` 用 Effect 的可取消等待，属于当前根 Scope，不占工具许可。sleep 保存为带身份的 builtin 引用，跨单元调用别名时绑定当前执行，不能捕获旧 Scope。毫秒值要求有限且非负。

不添加一套原生 setTimeout 管理表。已有可取消 sleep 能满足脚本等待，根 Scope 负责释放计时器。

验证：默认与显式 timeout、环境排队超过预算后仍有完整执行时间、真实 timer 注册与根结束释放、保存 sleep 别名后跨单元使用。

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

### 6.2 搜索保留字段说明

search 的每个命中项新增 `inputSchema`，有输出合同时再提供 `outputSchema`，从该工具的真实 inputContract 发射 JSON Schema，并把 `definitions` 接回 `$defs`。字段 description、default（包括 false/0）、format、minItems 和引用必须保留。输入按 encoded 域发射，输出按 decoded 域发射；例如 Effect NumberFromString 输出 schema 会包含 number 及其非有限数哨兵，直接保留库发射结果。

紧凑签名仍是概览；完整 schema 只在用户主动搜索命中项时生成，不加进 catalog 的 ToolDescription，也不提前为所有工具广播一遍。SearchOutput 同时声明详情字段，以及可选的 `schemaUnavailable`。

Effect 合同可能合法却无法表示为 JSON Schema，例如 Symbol 属性或索引。输入、输出各在详情发射处处理这种失败：失败侧返回 null，并在 `schemaUnavailable` 中列出 input 或 output；另一侧与同页其他工具保持完整。工具路径、签名和排名不丢失，也不用空对象假装完整合同。只处理 schema 发射异常，分页序列化及实际工具执行错误仍走原错误出口。

这样不恢复第二套多行 pretty renderer：签名负责快速读形状，原 schema 负责字段详情。复杂工具的说明不能为省 token 被永久丢弃。

### 6.3 16K 软预算分页

沿用现有 `limit`、`offset`、`remaining` 和 `next.offset`。默认十项，limit 仍是数量上限；页面另以完整 `JSON.stringify(response).length` 计量，目标 16384 个 JavaScript 字符单位。

按既有搜索顺序加入完整条目，每加入一项就计算包含 remaining/next 的整页长度，首次达到或超过预算便结束。跨过阈值的这一项保留，所以单个超长工具仍完整可见；下一页从后一项开始，不分割 schema，不引入碎片协议。

read 的正文限制是 16384 UTF-8 字节，另有默认200行与16000估算 token 检查；它会整行省略超长行。search 用完整条目向上取整，不沿用会丢掉唯一工具说明的行为。

受控实测：十五个工具中，默认十项原输出1666字符，加完整输入 schema 后8956；一个两万中文字说明的工具原本已输出20173字符。隔离分页用七个6000字符说明得到3/3/1项，满页19383字符；超长工具放首、中、尾均完整且下一页推进，没有重漏。字符不等于 UTF-8 字节或真实模型 token。

验证：真实 encoded contract、嵌套/$defs、false/0 default、字段文档；catalog 条目形状和文字不变；完整 instructions 在受控样本保持380字符，部分目录因 search 的返回签名声明详情字段与不可表示标记从517增至610字符；正常/输入不可表示/输出不可表示/双侧不可表示工具混合一页，失败侧标记准确、正常侧保留；普通分页、limit 小于尺寸阈值、跨阈值完整条目、单项超长、Unicode/转义和遍历无重漏。

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

集合最多64个环境。满时只淘汰最早闲置项，活动和排队中的环境不能淘汰；全部忙则明确返回暂不能创建。最后一个租约释放时才更新闲置顺序。无需 TTL 时钟、每 owner 配额或第二个缓存。

退休先关闭准入，再发取消；保留条目直到使用人数归零。实例关闭等待所有真实 finalizer，不能只删 Map 引用就声称清理完成。Session 在自己的 cell 内被删除时，事件回调只发退休，不等待自己，避免死锁。

验证：跨格闭包与别名、重声明、失败状态、当前工具/权限、同环境排队、排队取消、闲置淘汰、全忙上限、Session delete/move/workspace 和真实 Instance.dispose 等待清理。

### 7.3 每次预跑使用独立的环境副本

预跑在已有环境租约内深复制一次 Environment，再用当前探测工具执行同一份源码。它可以读取上一单元的变量和 helper；变量赋值、闭包私有计数及对象变异只发生在副本中。预跑结束后沿同一根 Scope 收尾，副本不进入环境注册表，随后释放引用。

复制只有一个递归入口和一个身份 memo。Map 的键和值、Set 的成员、类实例的自身字段都递归复制；新对象先登记再复制成员，闭包循环和对象别名因此指向同一个副本。保留解释器类的只读原型，函数捕获的 Map/Binding 作为普通自身数据一起复制，不另维护一套闭包恢复规则。

RegExp 用原 source/flags 创建，再复制 lastIndex 等自身描述符。自身属性按描述符复制，不执行 getter，同时保留非枚举错误品牌和 text。原文来源存于 WeakMap，在共同复制出口复用 rawText/withRawText，使 String、模板字符串和 text 不改变待审工具参数。

不能沿这个入口安全复制的 URL、宿主函数或访问器直接结束本次预跑。它仍是启发式探针：工具返回 null，脚本依赖真实结果时也可能提前停止。宿主保留已经收集的调用，整段审查使用同一规范化源码；真实调用始终经过现有权限入口。无需另设复制失败类型、恢复器或模型提示。

预跑只设一个2000毫秒执行期限，保留已有日志留存限额，不增加访问次数或工具调用次数预算。期限沿用解释器的取消语义；同步复制和编译不能被同线程定时器硬抢占，不为探针再引入线程或调度器。

选择这个小入口是为了既保留闭包原型，又不共享 Map 对象键等可写状态。现成复制方案的实测分别出现原型丢失、闭包环失败或旧对象共享；不以增加依赖来隐藏这些语义差异。当前正常排版的核心复制函数为42行（含必要注释）。

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

源码先转译成 JS，当前运行时位置可能指向生成代码；不直接按这个位置截原 TS 当作“精确代码框”。先改善可验证的类型/形状提示，不接一个错误的源位置映射。

验证：对象误用 map、标量不可调用、receiver/key/arguments 各只求值一次、可选链不求值参数。旧实现四例中三例失败，候选四例及353项库测试通过。

### 9.3 日志追加有界，结果交统一截断

为日志增加独立的 `maxLogBytes` 执行限额。宿主和预跑都从已有 Truncate 配置取 maxBytes，不增新配置项。所有函数帧调用本次执行的同一个 log 函数；累计 UTF-8 字节超限后停止保存新行，只计省略数，最后返回一条截断标记。

这个限额约束日志留存，不改变业务 return 的值。现有 maxOutputBytes 是执行后的结果预算，不能代替追加时限制。单次日志格式化仍会产生那一行字符串，追加限制解决的是循环持续累积的留存。

Execute 只组成最终正文：Environment ID、未观察失败提醒、实际收取的上下文、脚本结果和已捕获日志。正文交给既有 Tool.wrap，沿统一 Truncate.Service 截断、落盘和返回恢复路径。宿主不另写折半 JSON 预览，不手动设置 truncated/outputPath，也不在 copyOut 中悄悄截掉业务数组或改变返回类型。

截断后的正文可能只有 JSON 的一部分，统一提示会明确省略内容并给出完整文件路径，模型可用 read 分页继续读取。SessionTools 沿原规则清空没有完整交付的 loaded/skills 声明，下一轮可以补交；附件继续单独交付。

验证：长循环日志受限且业务对象不变；并发函数共享 UTF-8 预算，错误出口保留日志标记。再用一个真实 Tool.init/wrap 大结果流程确认只落盘一次、正文有统一提示与恢复路径、完整文件中保留 Environment ID、全部业务结果、上下文及已捕获日志。验证恢复文件的完整 JSON，不要求截断片段本身是合法 JSON。

## 10. 提示词和文档

提示词按“用途与收益 → 使用时机 → 一条真实例子 → 必要边界”组织。工具路径和返回值以实际 schema 为准，不照搬平铺的 glob/read 或把 read 当字符串。

只在需要的工具没显示时搜索。例子先 glob，取前八个文件并行读取一行以取得行数信息，再返回超过200行的文件；保留 listing 的截断信息及 totalLinesExact，不能把采样说成完整项目统计。

直接说明 return 的结果、最后表达式、简短 console、sleep、宿主可选 fetch 和 Environment ID 复用。Promise.allSettled 用于保留部分结果，说明失败也在其中。代码如何处理具体业务错误由任务决定，提示词不规定每次调用都包 try/catch。

共享 `code-mode.txt` 的两个宿主出口一起检查。例子从实际 description 提取后执行，使用真实文件工具，验证普通文件、截断列表、超过200行和不精确行数。README 同步真实全局 search、标准工具路径、race 只选结果、根清理、环境和输出行为。

`@@ comment` 是已有分段格式，中文维护说明不会进入模型文本。说明保留在有实际维护价值的位置，例如八文件采样和不精确行数；删除重复描述“共用一个 renderer”的注释。

## 11. 测试按最终功能组织

保留四层验证：语言/值的公共 CodeMode 入口，工具 schema 与协议适配，真实 Execute 宿主，真实 Session 资源生命周期。测试夹具复用已有入口；一项断言有不同文字，不代表它需要一项独立测试。

| 测试文件 | 保留的独立行为 | 精简方式 |
| --- | --- | --- |
| codemode/test/codemode.test.ts | 发现、核心优先、极小预算、namespace、fetch | 删除模拟 glob/read 示范，用真实宿主示例覆盖 |
| codemode/test/environment.test.ts | 跨格闭包、状态、当前能力、快照隔离 | 删除中间图克隆器的反序 URL/访问预算矩阵；保留三项公开组合场景 |
| codemode/test/primitive-input.test.ts | 原合同、正向简写、default/refinement、歧义 | 删除已移除反向拆包的细分用例，保留标量原 decoder 拒绝 |
| codemode/test/promise.test.ts | async、all/allSettled/race、根清理、准入、sleep | 多个旧 race 取消机制变体合为共享生产者流程；六种 timer 退出合为真实 timer 释放；保留独立根失败和同步取消登记窗口 |
| codemode/test/signature.test.ts | 四出口同源、真实 encoded 合同、搜索详情/分页 | 复用现有合同 fixture，删除重复四出口示范 |
| codemode/test/stdlib.test.ts | replace、for-await、原 builtin | 保留方法自己的绑定、关闭和回调边界 |
| codemode/test/text-result.test.ts | JSON 投影、原文、业务 text、decoder/出口 | 五处重复执行脚手架复用已有 run fixture |
| opencode/test/mcp/catalog.test.ts | 真实协议资格与 SDK 输出校验 | 保留真实 transport，避免只测内存对象 |
| opencode/test/session/execute.test.ts | 权限、HTTP、question/shell 清理、可见回执、真实例子 | 用 async race 后继续 await/return/abort 的一个流程替代更弱的 question-only 变体 |
| opencode/test/tool/code-mode-integration.test.ts | wire JSON、附件和公开参数 | 保留协议到宿主的薄集成 |
| opencode/test/tool/code-mode.test.ts | 预跑、整段检查、租约预算、取消、统一输出截断/进度 | 在现有夹具补关键行为，不复制另一套宿主 |
| opencode/test/tool/execute-environments.test.ts | owner、容量、闲置、退休和实例回收 | 删较弱 registry dispose/queued-cancel，用真实实例等待 finalizer 和真实排队宿主覆盖 |
| opencode/test/tool/registry.test.ts | 插件展示变化与原参数、两个提示出口 | 保留实际 registry 路径 |

共享 race 流程检查输出 `["first", 7, 7]`、生产者完成一次、未被 race 中断。根失败用例检查 result.ok=false、未完成生产者清理且之后无迟到副作用。实例关闭保留阻塞 finalizer，并断言持有者失败；简单“调用过 dispose”不足以替代。

保留测试有对应负控：恢复 race 取消成员、让 sleep 不注册 timer、每格重建词法根，测试分别失败。删除已经被这些共同入口覆盖的中间机制测试，保持正常换行，不按预设比例删断言。

### 逐项红绿验证

1. 异步和根生命周期：先跑公共同步取消登记复现。工具在开始时发就绪、finalizer 等待第二个门闩；旧实现会过早返回，修复必须等清理门闩。随后跑 async 顺序、组合器及真实 Session 资源测试。
2. 输入与签名：先用原 scalar 合同拒绝任意单键对象的断言变红，再删除反向拆包；正向简写和原 decoder 转换仍通过。签名仅显示标准输入。工具身份保持规范路径，未绑定短名不进入宿主调用。
3. search：先断言字段文档、encoded 类型和16K完整条目分页，旧实现缺字段/无尺寸限制；按需发射 schema 与原 offset 分页后变绿。
4. 环境预跑：旧 helper 在真实执行调用工具、但 host.begin 看到空列表的复现先失败；通用深复制后验证探测调用和真实状态各自正确。复制失败和超时允许少收集，不能写回原环境。
5. 回执：已 catch/allSettled 不应有未观察提醒，未 await/即时拒绝应有；混合时不误报工具名字。先改变断言，再收敛 Promise 观察位和最终提醒。
6. 进度：在实际宿主入口量测突发更新数量、运行中可见状态、最终完整状态和取消后的无事件。窗口检查必须在列表复制之前。
7. 诊断与输出：对象误用 map 的错误先失败；保存一次 member reference 后核对形状和求值次数。长日志和大结果通过原 Tool.wrap 验证，保证日志留存上限、完整恢复文件、统一截断提示和附件。

围栏在一个轻量真实宿主用例中验证同一规范化源码进入预检、整段审查和执行。Session 权限回归分别保留动态与预检路径，不再与 fenced/raw 交叉翻倍运行。

同步测试使用 Deferred/就绪信号，不靠固定 sleep 猜任务是否已启动。只有节流窗口和真实计时器本身的测试等待实际时间。
## 12. 每处生产修改的职责与必要性

本节对应共同基线 `a012050340b7eeed68488018205f2ed4cf8d4f0f` 到候选的全部生产差异。Git 默认三行上下文共切分为17个文件、91个 hunk。每个文件列出源文件和候选文件 SHA-256；每个 hunk 列出完整差异的 SHA-256、精确边界与职责。首尾片段取自该候选 hunk 的连续原文，在各自文件中唯一；` ⏎ ` 表示一个原始换行，保留其余字符。新文件的源哈希按空文件计算，源状态另行注明。

各项“不做会怎样”描述省去对应修改的具体后果。导入和字段传递说明服务哪个实际调用点；注释与格式只说明维护作用。hunk 哈希覆盖原始 `@@` 头、逐行差异和尾换行，不含文件头。

### packages/codemode/src/code-mode.txt：共享提示词

源文件 SHA-256：`6cec77efb4382902e35a16cc62b88f98c0cd4c1cbfa23ef133763c79ccd304e5`
候选 SHA-256：`da3b37fcb7d7c909e2fadec4fb991fa6e7eb8fb0fedfaa60d3118d5d03136e61`

#### H001 · 按实际工具合同说明 Execute 的使用方式

差异：`@@ -1,26 +1,40 @@`；SHA-256：`3a7dfd667a4426ceebcce9fc59bbdccd9f60e31b79ddd9850918efb46fdcfb07`
首段：`@@ comment.description ⏎ 中文维护说明：目录未显示所需工具时才发现；实际 glob/read 示例保留并发与有界摘要，不承诺可选能力。`
尾段：` ⏎ - {{searchSignature}}`

职责：共享提示词说明何时组合调用、如何控制输出，以及完整和局部目录的发现方式。

机制：先写用途，再给真实的 glob/read 示例：最多取八个文件，并行读取一行，保留 listing、totalLines 和 totalLinesExact；只在所需工具未显示时 search。补充 return、日志、sleep 和宿主可选 fetch。@@ comment 维护说明留在源码分段中。

必要性：模型需要能直接执行的示例，并知道采样范围和当前能力。完整目录与局部目录分别给出发现指引。

不做会怎样：旧说明仍称 sleep 不存在、fetch 总可用；示例和输出约束也无法传达本次新增能力。中文注释自身不改变模型输出，不能把注释精简算作运行时修复。

### packages/codemode/src/codemode.ts：公共接口

源文件 SHA-256：`33421e122353da5a3fd495318578fbe56c3b604e964778ea3db26b85fad3bf54`
候选 SHA-256：`ee619c62f9481b550fa715d905cec93615010425be02604f074870e4a7bc03e5`

#### H002 · 提供环境的公共类型与工厂

差异：`@@ -1,11 +1,17 @@`；SHA-256：`1d25ddcd9e41b3437c19f06128db3d9b70a7d6a2d63fda2dae059bd8a21b98a6`
首段：`import { withRawText } from "./raw-text.js" ⏎ import { Effect, Schema } from "effect"`
尾段：`export type ExecutionLimits = { ⏎   /** Maximum wall-clock execution time in milliseconds. No default: absent means no timeout. */`

职责：让宿主持有、创建解释器环境，不暴露独立的宿主状态容器。

机制：导出 Environment 类型和 createEnvironment()；Environment 导入服务工厂，withRawText 导入归 H008 的文本投影使用。

必要性：宿主环境注册表需要稳定入口创建词法状态；来源投影也需要复用同一个元数据函数。

不做会怎样：缺少工厂就没有公共环境创建入口；单独删掉配套导入会留下未解析标识符。导入本身没有额外运行时策略。

配套修改：H008、H010、H084。

#### H003 · 声明日志预算与目录优先级

差异：`@@ -14,12 +20,16 @@ export type ExecutionLimits = {`；SHA-256：`5ba73aea0f5e431a01d237b25e65f5eb8da029edc6c17a79cd78e337941bd29f`
首段：`  readonly maxToolCalls?: number ⏎   /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */`
尾段：` ⏎ type ToolTree<R = never> = {`

职责：在公共选项中区分日志留存预算和目录展示优先级。

机制：ExecutionLimits 增加 maxLogBytes；DiscoveryOptions 增加由宿主提供的规范路径 priority。

必要性：日志追加限制不能由执行结束后的 maxOutputBytes 代替；原生核心工具优先级也不能靠库猜名字。

不做会怎样：调用者无法通过类型明确传入这两项需求；实际行为仍分别由 H039 和 H058 实现。

配套修改：H039、H058。

#### H004 · 声明复用与预跑环境选项

差异：`@@ -30,12 +40,17 @@ export type ResolvedExecutionLimits = {`；SHA-256：`715a522efca5c7f495dd2df1beef4bf64ffa5171c9057d019b186ab55c239480`
首段：`  readonly timeoutMs: number | undefined ⏎   readonly maxToolCalls: number | undefined`
尾段：`  tools?: Tools & ToolTree<Services<Tools>> ⏎   /** HTTP由宿主显式提供；未提供时沙箱没有环境网络权限。 */`

职责：把环境复用和独立预跑作为一次执行的显式选择。

机制：ResolvedExecutionLimits 携带 maxLogBytes；ExecuteOptions 增加 environment 与 snapshotEnvironment，tools 和 fetch 继续属于本次调用。

必要性：同一 API 要能执行真实环境和它的探针副本，并把已校验日志预算送到执行器。

不做会怎样：缺少这些字段，宿主无法通过公共合同选择旧词法状态或安全预跑；这里不保存旧工具和权限。

配套修改：H040、H083。

#### H005 · 在成功结果中声明未观察失败

差异：`@@ -92,6 +107,8 @@ export const Success = Schema.Struct({`；SHA-256：`7bfba2e92b1f623f09d523aa27ae5edd4092598759f407c7d322e6790719f0a9`
首段：`  value: Schema.Json, ⏎   logs: Schema.optionalKey(Schema.Array(Schema.String)),`
尾段：`}) ⏎ /** Successful execution after the result has crossed the plain-data boundary. */`

职责：让脚本成功与异步子任务的失败事实同时表达。

机制：Success schema 增加可选 unobservedFailure，字段只在根清理后发现未观察失败时给出。

必要性：宿主需要一个真实结果字段决定是否附提醒，不能把所有 child error 都称作未处理。

不做会怎样：成功结果合同无法携带这项事实，宿主只能遗漏提醒或自行猜测。

配套修改：H040、H083。

#### H006 · 校验日志预算

差异：`@@ -134,6 +151,8 @@ const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimi`；SHA-256：`2c5f9c4918eb8c99fb8c4060e8ef0b4f1337a08072f104a2994900ca613cc3b5`
首段：`  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1), ⏎   maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),`
尾段：` ⏎ /** Executes one Effect-native CodeMode program without constructing a reusable runtime. */`

职责：让 maxLogBytes 与现有执行限额共用合法值检查。

机制：resolveExecutionLimits 调用 validateLimit，允许零预算，保留未设置为 undefined。

必要性：日志限制需要在进入执行器前完成数值校验，零值也应保留。

不做会怎样：只声明字段而不解析，执行器拿不到已校验的日志预算，追加限额无法按请求工作。

配套修改：H003、H039。

#### H007 · 把宿主优先级交给当前目录

差异：`@@ -152,7 +171,8 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`；SHA-256：`1a2e25e16c615b957acb6ec2f3b4c3f59864619aeff0559221540ad2bfce554a`
首段：`  const tools = (options.tools ?? {}) as HostTools<Services<Tools>> ⏎   ToolRuntime.assertValidTools(tools) ⏎   const limits = resolveExecutionLimits(options.limits)`
尾段：`  return { ⏎     catalog: () => prepared.catalog,`

职责：为每次创建的 CodeMode runtime 计算正确的内联工具选择。

机制：ToolRuntime.prepare 增收 options.discovery?.priority，仍以这次 tools 和预算构建目录。

必要性：优先级必须作用于当前可用工具，不能跨执行缓存旧能力。

不做会怎样：公共选项虽存在，目录仍按原规则选择；宿主标记的原生工具不会获得本次优先权。

配套修改：H058、H083。

#### H008 · 将合格 JSON 文本转为沙箱数据

差异：`@@ -160,3 +180,28 @@ export const make = <const Tools extends Record<string, unknown> = {}>(`；SHA-256：`9a6f794dada69c958f87026df0112fe99519ac09b66cfa00b39bb32689dfea5b`
首段：`    execute: (code) => executeWithLimits<Tools>({ ...options, code }, limits, prepared.searchIndex), ⏎   }`
尾段：`    throw error ⏎   } ⏎ }`

职责：提供宿主明确调用的无 schema 文本投影入口。

机制：fromJsonText 只接收解析后为对象或数组的 JSON；数值溢出、JSON 语法错误及 copyIn 的 InvalidDataValue 返回原文本，其他异常继续抛出；成功值登记原文。

必要性：复用既有深度、危险键和普通数据边界，既让无类型 JSON 可组合，又保留 String(value) 的原文本。

不做会怎样：合格 JSON 仍只是一段字符串，脚本需自行解析；若跳过 copyIn 或吞掉全部错误，会扩大可表示数据范围或掩盖内部错误。

配套修改：H042、H076、H083。

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
候选 SHA-256：`2604e322cf88a97c40d6b382bd8b8abffb167cd9c58cef222a0ae6a078735669`

#### H010 · 保存两个词法根

差异：`@@ -28,6 +28,19 @@ export type Binding = {`；SHA-256：`79e5550464b0483e79155146fc45ae15244840f8a2e1c8b2b5d4cdd194cb40bf`
首段：`  initialized?: boolean ⏎ }`
尾段：`  | { kind: "none" } ⏎   | { kind: "value"; value: unknown }`

职责：Environment 只持有内建根和用户绑定根。

机制：类内 roots 含 globals、bindings 两个 Map，解释器通过静态 scopes 取回同一组引用。

必要性：后续单元的闭包需要继续指向原 Binding；当前能力则在执行入口刷新 globals。

不做会怎样：每格重建词法根会丢失变量和闭包；若连旧执行器一起存下，则会保留上一轮权限与取消状态。

配套修改：H018、H019、H038。

#### H011 · 保存函数的 async 身份

差异：`@@ -45,6 +58,8 @@ export class CodeModeFunction {`；SHA-256：`fe1151573e4bfddf8b826b3ee70337ccb8c43eb59f19768e6177d5931845640c`
首段：`    readonly parameters: ReadonlyArray<AstNode>, ⏎     readonly body: AstNode,`
尾段：`    readonly async = false, ⏎   ) {} ⏎ }`

职责：让所有函数调用入口知道函数是否应返回 Promise。

机制：CodeModeFunction 构造器增加默认 false 的 async 字段，创建函数值时由 AST 填入。

必要性：普通调用和集合回调都要依据同一函数值作决定。

不做会怎样：async 与同步函数在值模型里无法区分，统一调用入口无法正确保持两种返回语义。

配套修改：H021、H032。

#### H012 · 为可持久化 sleep 别名提供身份

差异：`@@ -86,7 +101,8 @@ export class GlobalNamespace {`；SHA-256：`5f20944d498df0d407684e29770bd0423961aa36899d4ba84dc5fdd3502da051`
首段：`export class GlobalMethodReference { ⏎   constructor(`
尾段：`    readonly namespace: GlobalNamespaceName | "Number" | "String" | "$builtin", ⏎     readonly name: string, ⏎   ) {} ⏎ }`

职责：把 sleep 表示成解释器识别的内建引用。

机制：GlobalMethodReference 的 namespace 增加私有 $builtin；引用只存名字，不捕获执行上下文。

必要性：保存到环境的 sleep 别名需要在调用时绑定当前根 Scope。

不做会怎样：若用捕获旧执行器的宿主回调保存别名，后续单元会关联旧取消状态；这里提供的身份由 H029/H030 调度。

配套修改：H018、H029、H030。

### packages/codemode/src/interpreter/runtime.ts：解释器执行与生命周期

源文件 SHA-256：`0a8d2830a207aa07405da2d35a11433b2e97be642a07e967f7cbc0e45471882a`
候选 SHA-256：`b45f9b99de9f2d5528a5d429c618db2cf800d6254197f9d8c1311dcb565bb00d`

#### H013 · 接入根 Scope 与原文元数据

差异：`@@ -1,5 +1,7 @@`；SHA-256：`f46ccba278d71c3889c699123ccfda540fef929ed6dc59242e785f243be7c56a`
首段：`import { parse } from "acorn" ⏎ import { rawText, withRawText } from "../raw-text.js"`
尾段：`import { ⏎   copyIn,`

职责：为根生命周期和环境快照提供所需依赖。

机制：导入 Scope 替换原解释器 Semaphore，并导入 rawText/withRawText。

必要性：这些导入归 H017、H020、H040 的实现使用，八许可调度已转交 ToolRuntime。

不做会怎样：本 hunk 没有独立行为；只删导入会造成对应实现的符号缺失。注释仅解释归属。

配套修改：H017、H020、H040、H061、H064。

#### H014 · 接入词法环境类型

差异：`@@ -25,6 +27,8 @@ import {`；SHA-256：`aa32145bc83bd66594f38a1aa5940c051b66d5e0968e1d5295f3fcd9165b9190`
首段：`  type AstNode, ⏎   asNode,`
尾段：`  CoercionFunction, ⏎   ComputedValue,`

职责：为解释器构造和快照使用共用 Environment 模型。

机制：从 model 导入 Environment。

必要性：解释器构造、环境复制和执行入口需要引用 H010 的同一个 Environment，避免各自声明不同状态结构。

不做会怎样：没有独立运行时修改；单独去掉导入会使这些环境实现无法解析该类型和值。

配套修改：H017、H018、H040。

#### H015 · 移除解释器并发常量依赖

差异：`@@ -67,7 +71,8 @@ import {`；SHA-256：`e92c69ed2d5c4154ff0105d79dbd5bf322181eb6ab0aac56fc079d02e6050b98`
首段：`  numberStatics, ⏎ } from "../stdlib/number.js"`
尾段：`  escapeRegexHint, ⏎   invokeRegExpMethod,`

职责：让解释器只导入 Promise 方法集合。

机制：promiseStatics 导入保留，TOOL_CALL_CONCURRENCY 导入移到 ToolRuntime。

必要性：并发入口归 H061/H064，Promise 观察和 async 函数不占工具许可。

不做会怎样：仅保留一个不用的 import 不会改变执行行为；实际并发差异来自许可入口迁移。

配套修改：H020、H061、H064。

#### H016 · 更新错误归一化注释

差异：`@@ -219,7 +224,7 @@ const normalizeError = (error: unknown): Diagnostic => {`；SHA-256：`f3ae77005403a9dd922159aa46583b788d528fcc98b68f705d8a45b4fbb3dc98`
首段：`  } ⏎ } ⏎  ⏎ // catch 与 allSettled 共享普通失败归一化；宿主中断不转换为脚本数据。`
尾段：`  if (thrown instanceof ProgramThrow) return thrown.value ⏎   if (thrown instanceof InterpreterRuntimeError) return createErrorValue(thrown.errorName, thrown.message)`

职责：使 caughtErrorValue 的说明对应当前 Promise 语义。

机制：注释改为 catch/allSettled 的普通失败归一化，删去 race losers 的旧描述。

必要性：race 不再主动中断败方，注释应与 H032 保持一致。

不做会怎样：只保留旧注释不会改变执行结果，但会把维护者引向已移除的 race 取消机制。

配套修改：H032。

#### H017 · 复制一次预跑环境

差异：`@@ -241,6 +246,53 @@ const isRuntimeReference = (value: unknown): boolean =>`；SHA-256：`19bf95d5c880c5a62175719bd7ef8bf786fec158fce7dacd6104ceddaf019377`
首段：`  value instanceof ErrorConstructorReference || ⏎   isSandboxValue(value)`
尾段：`const containsRuntimeReference = (value: unknown, seen = new Set<object>()): boolean => { ⏎   if (isRuntimeReference(value)) return true ⏎   if (value === null || typeof value !== "object") return false`

职责：让探针读取旧变量、闭包和对象关系，同时隔离它造成的修改。

机制：snapshotEnvironment 只有一个 copy 和身份 memo。Map 键值、Set 成员递归复制，普通实例保留原型并按自身数据描述符复制；目标先入 memo，保留循环和别名。RegExp 重建 source/flags，再复制自身字段；共同出口转交原文 WeakMap 元数据。遇到宿主函数、URL/URLSearchParams 或访问器就终止本次预跑。 注释说明沙箱函数是可复制的 AST/作用域对象，并区分不可重建的原生函数。

必要性：闭包捕获的 Map/Binding 与容器数据须在同一复制关系里重绑；描述符复制避免调用 getter，并保留非枚举错误品牌和 text。一个通用 copy 核心从整个环境根递归，身份 memo 同时保留别名和循环。

不做会怎样：旧空环境探针看不到保存的 helper；直接使用真实环境则会提前改变私有计数和对象。复制失败只使本次探针停止，已收集调用及真实权限检查仍由宿主继续处理。

配套修改：H040、H083。

#### H018 · 分开执行共享状态与函数局部栈

差异：`@@ -599,36 +651,54 @@ const collectPatternNames = (pattern: AstNode, out: Array<string> = []): Array<s`；SHA-256：`2284e5e7808ed78c0baf8c76ee0cce7cc9a984f3ec42c1eb289292364d2bbde7`
首段：`  return out ⏎ }`
尾段：`    globalScope.set("undefined", { mutable: false, value: undefined }) ⏎     globalScope.set("Object", { mutable: false, value: new GlobalNamespace("Object") })`

职责：建立一次执行共有的工具、日志、根 Scope 和 Promise 清单，同时保留每个 Interpreter 的局部词法栈。

机制：新增 Execution；Interpreter.make 从 Environment 取得两个根，清空并重新播种 globals，注入当前 invokeTool/toolKeys/log/scope/promises，sleep 存为 builtin 引用；declared 只记录本格顶层声明。

必要性：并发函数共享能力和外层 Binding，但不能互相替换参数与局部作用域。globals 复用原 Map 才能刷新旧闭包看到的能力。

不做会怎样：沿用单实例 scopes 切换会让交错 async 回调串用局部状态；重建或保留旧 globals 又会分别破坏闭包引用或沿用旧能力。

配套修改：H019、H032、H038。

#### H019 · 在当前执行绑定 fetch 响应和用户根

差异：`@@ -664,21 +734,28 @@ class Interpreter<R> {`；SHA-256：`952a50c881b302d0deeb384d88363595ad5c31701070280ad13298c42d81af3f`
首段：`    if (hasFetch) { ⏎       globalScope.set("fetch", { mutable: false, value: new ToolReference(["$codemode", "fetch"]) })`
尾段：`      self.hoistFunctions(program.body) ⏎       let value: unknown = undefined`

职责：让 fetch 响应方法与普通函数共用本次能力，并保留用户顶层状态。

机制：响应工厂放入 execution.fetchResponse；make 返回以 globals、roots.bindings 为栈的 Interpreter。run 不再临时 push 一个执行结束即丢弃的用户根。

必要性：fetch 可见性和响应方法必须属于本次执行；用户变量则需跨格保留。

不做会怎样：旧临时 module scope 会丢失顶层状态，旧实例字段也不适合并发函数共享。工厂表达式的换行只是排版，不增加功能。

配套修改：H018、H032。

#### H020 · 统一 Promise 生产、观察和根清理归属

差异：`@@ -707,71 +784,60 @@ class Interpreter<R> {`；SHA-256：`95cfb4ee8bbc4e4f2be35acaa21c13514831195c38e2e6eebceab65132abbbcf`
首段：`      // without an explicit await, exactly as in JS. ⏎       if (value instanceof SandboxPromise) value = yield* self.settlePromise(value)`
尾段：` ⏎   private evaluateStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {`

职责：工具、async 函数与组合器都通过同一创建入口登记到根 Scope，观察者只读结果。

机制：createToolCallPromise 复用 execution.invokeTool；createPromise 用 startImmediately 的 forkIn，并将 fork 和 trackPromise 放入不可中断区。observePromise 等到 Exit 到达才标 observed；settlePromise flatten Exit。删去 pendingSettlements、局部许可和 raceInterrupted 特判，run 也不再自行清理一份 pending 集合。 trackPromise 也登记只有 Exit 的即时拒绝，供根收尾判断其是否未观察。

必要性：同步启动时立刻收到取消，也必须先完成根登记；取消一次 await 或 race 观察不能取消共享生产者。清理只由根 Scope 拥有。

不做会怎样：旧登记窗口可让 Execute 在真实 finalizer 完成前返回；旧 pending 集合和 race 特判会把观察取消与生产者寿命混在一起。遗漏 observed 的时机调整还会吞掉取消等待之后的未观察失败。

配套修改：H032、H040、H074。

#### H021 · 把 AST async 标志写入函数值

差异：`@@ -857,6 +923,8 @@ class Interpreter<R> {`；SHA-256：`a0112099cedbefb6ed91a715d0cbb016c2e8ae5e79d35ad828c6ef4c8e0f69d6`
首段：``      getArray(node, "params").map((parameter, index) => asNode(parameter, `params[${index}]`)), ⏎       getNode(node, "body"),``
尾段：`      node.async === true, ⏎     ) ⏎   }`

职责：把声明和表达式中的 async 身份交给共用调用入口。

机制：makeFunction 构造 CodeModeFunction 时传 node.async === true。

必要性：H011 的字段需要真实语法来源，所有调用者才能使用 H032 的 Promise 分支。

不做会怎样：字段保持默认 false 时，源码写了 async 的函数仍按同步函数运行。

配套修改：H011、H032。

#### H022 · 开放已有容器的 for-await 入口

差异：`@@ -1065,11 +1133,8 @@ class Interpreter<R> {`；SHA-256：`0d0aaee18acc10aaa7b3be936302f5ed18cee9e68ace2aaed9e87d6f0f1ce2a5`
首段：`    }).pipe(Effect.ensuring(Effect.sync(() => self.popScope()))) ⏎   } ⏎  ⏎   // 同一循环路径接纳同步与异步迭代，异步 next 与关闭沿既有 await 调度让出。`
尾段：`  private evaluateForOfStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> { ⏎     const self = this ⏎     return Effect.gen(function* () { ⏎       const left = getNode(node, "left")`

职责：允许 for await...of 继续进入现有迭代代码。

机制：删除入口处一概抛出的 unsupported 错误；具体 next、产值等待和退出顺序由 H023/H024 处理。

必要性：现有 Array/string/Map/Set 迭代入口可复用，无需新增独立异步迭代协议。

不做会怎样：入口仍会在读取已有容器前拒绝 for-await，后续实现无法触达。

配套修改：H023、H024。

#### H023 · 按异步顺序取值并清理循环绑定

差异：`@@ -1100,15 +1165,26 @@ class Interpreter<R> {`；SHA-256：`98f1374bd561c883d8ecd0273796426f6c4651461a7877ab7b0c51d4417119bb`
首段：`        throw new InterpreterRuntimeError("Unsupported for...of binding.", left) ⏎       }`
尾段：`          Effect.onError(() => (getBoolean(node, "await") ? Effect.yieldNow : Effect.void)), ⏎           Effect.ensuring( ⏎             Effect.sync(() => { ⏎               if (declaration) self.popScope()`

职责：在已有同步容器上实现 for-await 的 next、值结算和异常收尾。

机制：手动取得 iterator；每次 next（包括 done）先 yieldNow；仅对产出的 SandboxPromise settle。声明绑定和循环体放进同一 ensuring，异常路径对 for-await 再让出一次，最后释放循环帧。

必要性：普通值与空迭代也有异步观察顺序，解构默认值失败也必须释放已创建的迭代作用域。

不做会怎样：只等待 Promise 项会漏掉普通值和终止时的调度边界；绑定发生在 ensuring 外则可能留下失败迭代帧。Map 产出的键值数组不递归等待。

配套修改：H022、H024。

#### H024 · 补齐 for-await 的 break/return 顺序

差异：`@@ -1116,6 +1192,8 @@ class Interpreter<R> {`；SHA-256：`e7a5577afd11a2a826c006e148eb0d11aa0283e9d5daf487a43c4241b24968e8`
首段：`          ), ⏎         ) ⏎  ⏎         // break 与 return 也会关闭异步迭代，须让调用者先于后续语句获得调度。`
尾段：`        if (getBoolean(node, "await") && (result.kind === "return" || result.kind === "break")) yield* Effect.yieldNow ⏎         if (result.kind === "return") { ⏎           return result ⏎         }`

职责：让正常提前退出也经过异步关闭的让出点。

机制：在处理 return/break 的 StatementResult 前，仅对 await 循环 yieldNow。

必要性：H023 的异常分支之外，还要覆盖 break 和 return。支持的容器没有自定义 return 方法，此处保持它们的关闭调度边界。

不做会怎样：提前退出会少一次异步让出，后续语句与调用者的先后顺序偏离该循环语义；普通 for-of 保持原顺序。

配套修改：H023。

#### H025 · 从执行共享状态枚举工具

差异：`@@ -1144,7 +1222,8 @@ class Interpreter<R> {`；SHA-256：`1288b07112735c795c1868b90eaba02502f100aa22c95aae2c5a0fc5123c9ca3`
首段：`  // Returns undefined for everything else so callers can raise a contextual error. ⏎   private enumerableKeys(value: unknown): Array<string> | undefined {`
尾段：`    if (Array.isArray(value)) { ⏎       return Object.keys(value)`

职责：让各函数帧看到同一份当前工具目录。

机制：enumerableKeys 的 ToolReference 分支改用 this.execution.toolKeys。

必要性：配合 H018 的局部帧拆分，工具能力仍由同一个宿主入口决定。

不做会怎样：旧实例字段已移除，保留旧访问会让工具枚举引用不存在的字段；这里沿共享 Execution 读取目录，枚举规则保持原样。

配套修改：H018。

#### H026 · 让 await 普通值也交出执行机会

差异：`@@ -1447,11 +1526,13 @@ class Interpreter<R> {`；SHA-256：`b98a19403fa297336ee4f32098f86b373f9728c95a32622a734d378c5f89d67b`
首段：`      case "UpdateExpression": ⏎         return this.evaluateUpdateExpression(node)`
尾段：`      } ⏎       case "NewExpression":`

职责：保持 async 函数首次 await 后的调度顺序。

机制：先求参数表达式，再 yieldNow，之后结算 SandboxPromise 或返回普通值。

必要性：await 1 和 await 已结算 Promise 也应让调用者继续同步语句。

不做会怎样：直接透传普通值会让 async 后半段抢先运行；只有工具挂起的场景无法覆盖这个顺序问题。

#### H027 · 只求值一次被调用成员

差异：`@@ -1897,7 +1978,12 @@ class Interpreter<R> {`；SHA-256：`9bb3ea49e866dfce2ae5b15d63d47163be4f3b4ef8495b9e9926d09a4efa78bd`
首段：`    const self = this ⏎     return Effect.gen(function* () { ⏎       // 形状诊断复用这次求值，不能为解释错误再次执行 receiver 或 computed key。`
尾段：`      if (callable === OptionalShortCircuit) return OptionalShortCircuit ⏎       if ((callable === null || callable === undefined) && node.optional === true) return OptionalShortCircuit`

职责：为调用诊断保留 receiver 和 computed key 的首次求值结果。

机制：MemberExpression 先调用 getMemberReference，再把同一 reference 作为 Effect.succeed 传给 readMember；其他 callee 仍走 evaluateExpression，可选链短路位置保留。

必要性：H030 需要知道接收者形状，但诊断不得再次执行带副作用的表达式。

不做会怎样：若只在报错时重新求值 receiver/key，会制造额外副作用；若不保留引用，则无法准确说明是哪个接收者不可调用。

配套修改：H030、H037。

#### H028 · 把同步 search 接到当前执行

差异：`@@ -1905,9 +1991,9 @@ class Interpreter<R> {`；SHA-256：`974811904374245adba458986ecfa2261529f9c0d014ac37127e35aeeffc6239`
首段：`      if (callable instanceof ToolReference) { ⏎         if (callable.path.length === 0) throw new InterpreterRuntimeError("The tools root is not callable.", callee)`
尾段：`        return yield* self.createToolCallPromise(callable.path, args) ⏎       }`

职责：维持 search 的同步值返回，同时使用共享调用入口。

机制：ToolReference 的 $codemode.search 分支改为 execution.invokeTool；其他工具仍创建 Promise。

必要性：函数局部帧拆分后，search 仍要经过同一执行的验证、计数和 hooks，保持同步发现结果。

不做会怎样：使用移除的实例字段会断开调用；把 search 改成普通异步工具则会改变现有发现用法。

配套修改：H018、H054、H064。

#### H029 · 把 builtin 别名分发到当前 sleep

差异：`@@ -1921,6 +2007,8 @@ class Interpreter<R> {`；SHA-256：`6856287b2f7dd1861aa0d29976efea12ac8c218a3f3fe819fd87e4060b4e89ec`
首段：`        return yield* self.invokeIntrinsic(callable, args, node) ⏎       }`
尾段：`        if (callable.namespace === "Object" && args[0] instanceof ToolReference) { ⏎           return self.invokeObjectMethodOnTools(callable.name, args[0] as ToolReference, node)`

职责：允许直接调用和跨格别名调用进入本次计时器创建入口。

机制：GlobalMethodReference 的 $builtin 分支调用 invokeSleep，console/Object 等分支保留。

必要性：身份引用本身不携带旧执行器，调用时才能关联当前 Scope。

不做会怎样：存下的 sleep 引用没有执行分支，或被误当成其他全局方法；实际参数和计时规则由 H030 负责。

配套修改：H012、H030。

#### H030 · 提供形状诊断和受根管理的 sleep

差异：`@@ -1937,10 +2025,33 @@ class Interpreter<R> {`；SHA-256：`386b172663c5ce5332059e6261aba61e2c31f3573e7f83b1411812e68d80f265`
首段：`      if (callable instanceof ErrorConstructorReference) { ⏎         return createErrorValue(callable.name, args[0] === undefined ? "" : coerceToString(args[0]))`
尾段：`  // namespace/tool names from the host tool tree - the discovery idiom a model reaches for ⏎   // first. Every other Object helper cannot produce data from a tool reference, so it fails`

职责：本 hunk 连续修改两个独立入口：不可调用值的错误说明，以及 sleep 的执行。

机制：诊断使用 H027 保存的 receiver，显示类型及最多八个、每个最多64字符的键名，不读取属性值。invokeSleep 仅接受 0 至 2147483647 的有限 number，经 createPromise(Effect.sleep(ms)) 返回根 Scope 的 Promise，不占工具许可和计数。

必要性：错误应说明对象形状而非笼统声称只有工具可调用；脚本等待要用已有可取消计时器并绑定当前执行。

不做会怎样：对象误用 map 仍只能得到误导提示；没有 sleep 分支则无法等待。字符串、负数、无限值和超范围计时不能靠隐式转换进入 Effect timer。

配套修改：H020、H027、H029、H037。

#### H031 · 让所有函数帧写同一个日志出口

差异：`@@ -1959,7 +2070,8 @@ class Interpreter<R> {`；SHA-256：`df52b4a446a8bb1a981246f62a6b48004af09cd9631bf1c21e5e27747cbf1d8f`
首段：`  private invokeConsole(name: string, args: Array<unknown>, node: AstNode): undefined { ⏎     if (!consoleMethods.has(name))`
尾段：`    this.execution.log(publicErrorMessage(this.formatConsoleMessage(name, args, node))) ⏎     return undefined ⏎   }`

职责：收集并限制整段执行的日志，而非每帧各存一份。

机制：invokeConsole 保留方法白名单和原格式化流程，改调用 execution.log。

必要性：H039 的 UTF-8 留存预算必须覆盖并发函数和集合回调产生的全部日志。

不做会怎样：直接写局部 logs 会绕过共同预算或遗漏子函数日志。

配套修改：H018、H039。

#### H032 · 让组合器返回 Promise，并隔离函数局部帧

差异：`@@ -2102,158 +2214,122 @@ class Interpreter<R> {`；SHA-256：`447a426065ba4fdd1c09546913b7a7ad38dd3be44b3715d21621bf51a66648d0`
首段：`    }) ⏎   } ⏎  ⏎   // 组合器消费已有 Promise，而不是执行另一套工具调度；其返回值仍可继续组合。`
尾段：` ⏎   private invokeIntrinsic(`

职责：修正 all/allSettled/race 的观察语义，以及 async 函数的调用和返回语义。

机制：resolve/reject 登记即时 Exit；其他组合器由 createPromise 启动。all 并发观察且结果保序，allSettled 并发收集普通拒绝并传播纯中断，race 竞争观察结果而不取消生产者，空 race 为 Effect.never。invokeFunction 新建局部 Interpreter 和参数 Map，共享 capturedScopes；async 的参数绑定、函数体及返回 Promise 采用均放在根生产者中。

必要性：后一项失败或中断不能被前项挂起遮蔽，组合器要能嵌套；多个 async 回调的局部参数要隔离，而闭包外层 Binding 保持共享。

不做会怎样：顺序观察会遮住后项失败；取消 race 败方会破坏后续 await；沿用一个可变 scopes 栈会串扰局部变量；在 Promise 外绑定默认参数会把 async 默认值错误变成同步抛出。

配套修改：H020、H021、H026、H074。

**1. 即时 Promise 与组合结果都保留 Promise 身份**

resolve 对已有 SandboxPromise 原样返回，对普通值登记成功 Exit；reject 登记 ProgramThrow 的失败 Exit。all、allSettled、race 的输入检查和执行放在 createPromise 的生产者中，使组合器返回值可以继续 await、嵌套或交给另一组合器。即时拒绝也进入根清单，才能在无人观察时形成回执。

**2. all 和 allSettled 并发观察，仍按输入保序**

all 用 Effect.all 的无界观察，限制实际工具并发的仍是 ToolRuntime 八许可。allSettled 对普通失败调用 caughtErrorValue 生成 rejected 数据，对纯中断传播 cause。后一项失败或中断能及时结束观察，不必等一直挂起的前项。

**3. race 只竞争观察**

raceAll 竞争每个成员的 Exit，再 flatten 胜方结果；被结束的是败方观察，不是原 Promise 的生产者。空数组返回 Effect.never，等待根执行的取消或超时。删去旧败方 interrupt 循环和专用 interrupted 标记后，同一生产者仍可参加另一个 race 或再次 await。

**4. 每次函数调用有独立局部帧**

新 Interpreter 共用 execution，只复制 capturedScopes 的数组，并追加新的参数 Map；外层 Map/Binding 仍是原引用。参数先建立 TDZ 槽，再绑定默认值、rest 和函数体。async 把这整段执行与返回值采用放进 createPromise，同步函数直接返回 run，集合方法也不因此隐式 await 全部回调。

#### H033 · 为 async replacer 绑定当前解释器

差异：`@@ -2303,6 +2379,8 @@ class Interpreter<R> {`；SHA-256：`a33e72666de340b891925482a182f00b0a7774d9d1cb5860cf4ea380d387c913`
首段：`    args: Array<unknown>, ⏎     node: AstNode, ⏎   ): Effect.Effect<unknown, unknown, R> { ⏎     // replacer 结算复用本次执行的解释器边界，不能把既有 async 扩展改成普通回调。`
尾段：`    const matches: Array<{ readonly match: string; readonly offset: number; readonly args: Array<unknown> }> = [] ⏎     const collect = (...callbackArgs: Array<unknown>): string => {`

职责：为字符串替换中等待 async 回调的结果提供调用上下文。

机制：在现有替换方法内保存 const self = this，供 H034 的生成器使用。

必要性：H034 的生成器需借 self 访问当前解释器，settlePromise 才能沿本次执行的 Promise 观察路径等待回调。

不做会怎样：单独删掉 self 会使后续结算无法引用解释器；本 hunk 本身没有新增替换规则。

配套修改：H034。

#### H034 · 保留 String.replace 的 async 扩展

差异：`@@ -2346,9 +2424,15 @@ class Interpreter<R> {`；SHA-256：`3bb15e4d1c0e32348e9fd707626ee8f190ba7a6b0bd65a2851ffdc40a7781447`
首段：`      const output: Array<string> = [] ⏎       let end = 0`
尾段：`        end = match.offset + match.match.length ⏎       }`

职责：在明确 async 的替换回调中等待返回 Promise，再按原规则转为替换字符串。

机制：先执行 apply；只有 CodeModeFunction.async 且结果为 SandboxPromise 才 settle，随后仍经过 boundedData 和 coerceToString。匹配位置、捕获组与拼接流程不变。

必要性：H032 让 async 函数真实返回 Promise 后，原字符串替换扩展需要在自己的方法边界结算它。

不做会怎样：已支持的 async replacer 会落入数据边界报错；若对全部回调自动 await，又会改变同步回调返回 Promise 的既有检查。

配套修改：H032、H033。

#### H035 · 在共用集合回调入口接纳 sleep

差异：`@@ -2367,16 +2451,20 @@ class Interpreter<R> {`；SHA-256：`0ac6a4dcb408f457d6d8f109b0542794d9e903864f8064f8c08c8df2bc0fc181`
首段：`    if ( ⏎       !(callback instanceof CodeModeFunction) &&`
尾段：` ⏎   private invokeMapMethod(`

职责：让 sleep 可作为数组、Map/Set 等既有回调入口的内建函数。

机制：白名单仅额外允许 $builtin.sleep，并分发到 invokeSleep；CodeModeFunction、CoercionFunction、UriFunction 保留原路径。

必要性：sleep 已表示成身份引用，集合方法需要显式识别该引用，不能把全部全局方法一并放行。

不做会怎样：map(sleep) 等用法会被当作非函数拒绝；扩大到全部全局方法则会超出当前回调白名单。

配套修改：H030、H036。

#### H036 · 数组复用已有集合回调入口

差异：`@@ -2642,24 +2730,8 @@ class Interpreter<R> {`；SHA-256：`ae75beb1a1ac99730ee7cea2c736f742f4a3d4f74f6538c9730d31ed9bd6386d`
首段：`        return Effect.succeed(Array.from(target.entries(), ([index, item]): Array<unknown> => [index, item])) ⏎     }`
尾段：`      // Iterate a snapshot taken at call time so a callback that mutates the array can't ⏎       // self-extend the loop - matching JS, where elements appended during iteration are not visited.`

职责：删除数组方法单独维护的回调分类分发。

机制：使用 applyCollectionCallback(args[0], Array 方法名, node)，后续数组快照迭代不变。

必要性：H035 的 sleep 支持及函数调用语义应在各集合方法一致。

不做会怎样：保留重复入口会让数组继续遗漏 sleep；除此之外，这段删除主要减少同一白名单的重复实现。

配套修改：H032、H035。

#### H037 · 让成员读取接收已求值引用

差异：`@@ -3124,8 +3196,9 @@ class Interpreter<R> {`；SHA-256：`0b813d72743fd7da0ca22abb8c1ad15ccc1bae51091de40f07ccc32eb7e29ecc`
首段：`    }) ⏎   } ⏎  ⏎   // 调用入口可传入已求值引用；普通成员读取仍在此计算，二者共用相同访问规则。`
尾段：`      if (reference instanceof ComputedValue) return reference.value ⏎       if (`

职责：共用原访问规则，避免调用场景重复解析成员。

机制：readMember 增加默认值为 getMemberReference(node) 的 resolved 参数；普通读取按默认路径，调用入口传已有 reference。

必要性：H027 的一次求值结果需要穿过原有可选链、ComputedValue 和访问控制分支。

不做会怎样：只在调用处保存引用却不改 readMember，仍会再次计算 receiver/key，或被迫复制一套访问规则。

配套修改：H027、H030。

#### H038 · 只放宽跨格顶层重声明

差异：`@@ -3259,10 +3332,13 @@ class Interpreter<R> {`；SHA-256：`0152e42e7110c555e37cff98cf11c1acd6936a233ff9668a795cc9e9d2290a38`
首段：`    // A pre-seeded parameter slot (initialized === false) is being bound for the first time; ⏎     // anything else already present is a genuine duplicate declaration.`
尾段：`    scope.set(name, { mutable, value, initialized: true }) ⏎   }`

职责：允许 Notebook 重跑定义，同时保留本格与函数局部的重复声明检查。

机制：比较当前 scope 与 moduleScope；本格 declared Set 记录已声明名称，已有参数 TDZ 槽仍按原规则初始化。

必要性：用户需要在后续单元重新声明顶层变量，函数参数和局部作用域语义不能一起放宽。

不做会怎样：复用环境后，旧顶层名称会全部报重复；若直接取消重复检查，同格重复和函数局部错误也会被放过。

配套修改：H018、H019。

#### H039 · 在追加时限制共享日志留存

差异：`@@ -3356,7 +3432,27 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`；SHA-256：`899979513868cc8cc5e1cc1f61653b1ed040a1e26177184ed890a252c51614ca`
首段：`    options.fetch, ⏎   )`
尾段：`  if (options.code.trim().length === 0) { ⏎     return Effect.succeed({`

职责：控制循环及并发函数累计保存的日志内存，并在各结果出口说明省略。

机制：log 以 UTF-8 字节加换行计费；首次超预算后只增加 droppedLogs，logged() 追加省略行数标记并设置 truncated。未设置 maxLogBytes 时保留既有无限额行为。

必要性：执行结束后的结果裁剪无法限制执行期间日志持续累积；所有帧必须共享这个累计值。

不做会怎样：长循环仍可持续占用日志内存；没有统一 logged() 标记，成功或失败输出无法说明日志已省略。单行格式化仍先产生该行字符串，此处限制的是留存。

配套修改：H006、H031、H083。

#### H040 · 在根结束后交付结果与安全 Promise 终态

差异：`@@ -3367,18 +3463,60 @@ export const executeWithLimits = <const Tools extends Record<string, unknown>>(`；SHA-256：`10278a60e7e98edd9e87a899f3b5f622cf736a596e68425915708e85ff3c8492`
首段：`  } ⏎  ⏎   const operation = Effect.gen(function* () {`
尾段：`    return program.pipe( ⏎       Effect.timeoutOrElse({`

职责：把快照选择、根 Scope 清理和未观察失败回执接到公共执行路径。

机制：operation 先 yieldNow，让外层 timeout/race 完成登记，再选择环境副本、解析和启动脚本。scopedWith 包住 Interpreter.run；Scope 关闭后读取各 Promise Exit，记录未观察失败，并将 Fiber 状态换成安全 Exit。纯中断变成供后续单元观察的明确错误，普通拒绝保留沙箱抛值；成功结果附 unobservedFailure，再按原 copyIn/copyOut 交付业务值。

必要性：执行起点先给外层观察者完成登记的机会，同时保留子生产者 startImmediately 和原子登记；宿主得到结果前必须等真实清理，Notebook 中保存的 Promise 也不能保活旧 Fiber、私有 cause 和权限上下文。

不做会怎样：脚本同步触发宿主取消时，外层观察可能尚未登记，完成/取消顺序会失真；缺少根收尾和终态替换还会让未结束工作越过执行边界、跨格 Promise 保留旧上下文，或在成功结果中遗漏未观察失败。

配套修改：H017、H020、H032、H039、H074。

**1. 根清理之后校验结果，无期限路径保留同一根**

copyIn/copyOut 在 Scope 关闭及 Promise 终态替换之后执行，返回值校验失败也不会提前交回仍在清理的工具。外层 timeoutMs 为 undefined 时继续返回同一个 program。此处新增注释解释已有顺序和无期限分支；该分支没有额外算法修改。

#### H041 · 裁剪结果时保留附加事实

差异：`@@ -3462,7 +3600,6 @@ const boundOutput = (result: Result, maxOutputBytes: number): Result => {`；SHA-256：`e1ed356b870555a5c5ae8dc54e243da222f38cfcff3f8f5f601c88d90543ffd2`
首段：`  if (!truncated) return result ⏎   const logsPart = kept.length > 0 ? { logs: kept } : {}`
尾段：`  return result.ok ? { ...result, value, ...logsPart, truncated: true } : { ...result, ...logsPart, truncated: true } ⏎ }`

职责：使既有 maxOutputBytes 结果重建保留 unobservedFailure 等已有字段。

机制：成功和失败分支先展开原 result，再覆盖 value、保留下来的 logs 和 truncated。

必要性：结果预算只应改变被裁剪部分，不应删除本次执行已经确认的事实。

不做会怎样：旧手写字段重建会漏掉新增的未观察失败字段。此处没有新增 JSON 预览或改变业务类型的宿主截断器。

配套修改：H005、H040。

### packages/codemode/src/raw-text.ts：原文来源

源文件 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（基线不存在此文件）
候选 SHA-256：`ea0ef5ff8ff82d3328349dbafbee99f9f92c55e33942b8ee816e488a2a1e3eac`

#### H042 · 集中保存 JSON 文本来源

差异：`@@ -0,0 +1,17 @@`；SHA-256：`63a8662b18866502d91de2683a403d5e4aab687d859bc0e755831e7b1c070ea5`
首段：`// 来源元数据不写入业务对象，避免输出解码器把便利字段当成真实数据。 ⏎ // 弱引用随值回收，不为 Notebook 或单次执行增加独立生命周期。`
尾段：`  return value ⏎ }`

职责：用弱引用元数据保留原文，并只在内部副本上提供便捷 text 别名。

机制：rawText 查询 WeakMap；withRawText 首次登记后不改写，exposeAlias 为真且没有自有 text 时，定义非枚举只读别名。

必要性：原文不能成为输出 decoder 或 JSON.stringify 的业务字段，已有业务 text 也必须优先。

不做会怎样：直接加可枚举 text 会污染合同和输出；不留元数据则 String/模板无法恢复原有空白和格式。弱引用无需另建回收表。

配套修改：H008、H017、H043、H050、H051、H063。

### packages/codemode/src/stdlib/value.ts：字符串转换

源文件 SHA-256：`ab7399b36f12f51f437c81af56e4809ad4cf12cb1bf85563d882c4c248a0fccc`
候选 SHA-256：`b1c06c530c7af060a1f018398faaf8b81c6dafeb4a78c34fd46742f2f85e2cdd`

#### H043 · 字符串转换优先读取登记原文

差异：`@@ -28,6 +28,9 @@ export const errorBrandName = (value: unknown): string | undefined =>`；SHA-256：`c174205cd84030eea381ed73121b16294a909f51e0bea628883495b4f658f69f`
首段：`export const boundedData = (value: unknown, label: string): unknown => copyIn(value, label, true) ⏎ `
尾段：`  if (value === undefined) return "undefined" ⏎   if (value instanceof SandboxDate)`

职责：让投影后的对象或数组在 String 和模板字符串中保留原 JSON 文本。

机制：coerceToString 先查 rawText；没有来源时继续原 null、undefined、日期和普通值转换。

必要性：脚本可以组合业务字段，也可以取得协议原文，两种用途共用同一内部值。

不做会怎样：投影对象会变成普通对象字符串，原文中的空白与格式丢失；普通对象的转换规则无需因此变化。

配套修改：H042。

#### H044 · 接入字符串转换的来源查询

差异：`@@ -74,6 +77,8 @@ export const invokeCoercion = (ref: CoercionFunction, args: Array<unknown>, node`；SHA-256：`50e7eaee252de3e38949988272556527519960f936633a9185152dc2d2670f6e`
首段：`  return coerceToString(value) ⏎ }`
尾段：`import { ⏎   isSandboxValue,`

职责：给 H043 提供 rawText 函数。

机制：新增 raw-text 导入，既有 copyIn 和沙箱值导入不变。

必要性：与 H043 属于同一原文转换修改。

不做会怎样：本 hunk 不独立改变行为；去掉导入会使原文查询缺少符号，注释本身不影响结果。

配套修改：H043。

### packages/codemode/src/tool-runtime.ts：工具边界与发现

源文件 SHA-256：`5ca5e0cc8ff716a26f4517cc70660a2d9d970006c46f07c146ef52765d9af430`
候选 SHA-256：`8ef26a59ecd02963a7358bd6805d485a35cc415a96c12fccbd4431818329f132`

#### H045 · 接入输入适配、来源和统一许可依赖

差异：`@@ -1,4 +1,8 @@`；SHA-256：`c5b7b4ff415f5d9a8b9f94b94808edfac16bc16e906bd3ae6b69ce5ec0ca767e`
首段：`// 参数形式、来源快照与宿主限流各守自己的边界，不向解释器引入宿主策略。 ⏎ import { normalizeInput } from "./input-forms.js"`
尾段：`import { ToolError, toolError } from "./tool-error.js" ⏎ import {`

职责：为 ToolRuntime 的三个既有边界提供实现依赖。

机制：新增 normalizeInput、rawText/withRawText、TOOL_CALL_CONCURRENCY、Semaphore 导入。

必要性：导入分别归 H062、H050/H051/H063、H061/H064 的行为使用。

不做会怎样：没有独立调度或适配行为；仅删导入会留下未解析引用。不能把这些 import 单算成额外功能。

配套修改：H050、H051、H061、H062、H063、H064。

#### H046 · 接入统一沙箱值判断

差异：`@@ -11,6 +15,8 @@ import {`；SHA-256：`6b96b8e26f1e9d906bfec6d9d2b422b44ad1019819a5be08cccf35c3e014d5f4`
首段：`} from "./tool-schema.js" ⏎ import { isDefinition as isToolDefinition, type Definition } from "./tool.js"`
尾段：`  SandboxMap, ⏎   SandboxPromise,`

职责：让内部复制使用公共品牌判断。

机制：从 values 导入 isSandboxValue。

必要性：作为 H049 删除重复类型名单的依赖。

不做会怎样：移除导入会使 copyBounded 中的 isSandboxValue 无法解析；可保留值的判断由 H049 的公共品牌集合决定，导入和注释都不扩展数据边界。

配套修改：H049。

#### H047 · 限定 namespace 错误提示长度

差异：`@@ -96,6 +102,8 @@ export type SafeObject = Record<string, unknown>`；SHA-256：`6437ef6317d449e715de7e3d7c01611240a86de72268ec1912fa776e1c8049a5`
首段：`const reservedNamespace = "$codemode" ⏎ const defaultCatalogBudget = 2_000`
尾段：`const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) ⏎ const SearchInput = Schema.Struct({`

职责：为 namespace 误调用中的补充签名设置独立展示预算。

机制：新增 namespaceSignatureBudget = 2000，H060 按完整签名累计字符。

必要性：大 namespace 的一次错误不能输出整份目录。

不做会怎样：H060 没有明确的提示长度上限，或只能截断半条签名。该预算不删除工具能力。

配套修改：H060。

#### H048 · 声明 search 详情与逐侧不可表示标记

差异：`@@ -108,6 +116,10 @@ const SearchItem = Schema.Struct({`；SHA-256：`7409dc6495a418a5be9c618903b2440a877a66f7fbf59429eb4189b11091bbcb`
首段：`  path: Schema.String, ⏎   description: Schema.String,`
尾段：`const SearchOutput = Schema.Struct({ ⏎   items: Schema.Array(SearchItem),`

职责：让搜索结果合同表达输入详情、可选输出详情和 schema 发射失败。

机制：SearchItem 新增 inputSchema、可选 outputSchema，以及成员仅为 input/output 的 schemaUnavailable。

必要性：合法 Effect 合同也可能无法发射 JSON Schema，搜索需要表达哪一侧缺失而保留其他信息。

不做会怎样：返回详情缺少公开合同，或只能把缺失侧伪装成完整空对象；实际异常处理位于 H055。

配套修改：H055。

#### H049 · 复用既有沙箱值品牌集合

差异：`@@ -220,19 +232,8 @@ const copyBounded = (`；SHA-256：`621ec55ee16fa913d364ec84f412cb2541c824c0b80a297ed63ac306648b10b0`
首段：`  } ⏎  ⏎   if (preserveSandboxValues) {`
尾段：`    // the boundary first), but wrap them defensively rather than degrading to JSON forms. ⏎     if (value instanceof Date) return new SandboxDate(value.getTime())`

职责：减少内部复制检查点重复维护的容器类型列表。

机制：preserveSandboxValues 分支改用 isSandboxValue，后续宿主实例包装和真实跨界序列化保持原路径。

必要性：新增沙箱类型时，内部检查不应漏更新第二份 instanceof 名单。

不做会怎样：在当前品牌集合相同时，保留旧名单不会立即改变结果；这是一处同义收敛，主要风险是今后名单漂移。

配套修改：H046。

#### H050 · 数组副本继承原文来源

差异：`@@ -286,7 +287,8 @@ const copyBounded = (`；SHA-256：`9f566c2bcf0195a535a04115b5c3595afd6e6326142216c4c9e25b5d1b291ceb`
首段：`  if (Array.isArray(value)) { ⏎     const copied = value.map((item) => copyBounded(item, label, depth + 1, seen, preserveSandboxValues))`
尾段：` ⏎   const prototype = Object.getPrototypeOf(value)`

职责：在 copyIn 的数组分支保留明确登记的文本来源。

机制：递归复制元素并释放 seen 后，用 withRawText(copied, rawText(value), true) 返回内部副本。

必要性：JSON 数组与对象同样需要 String/模板和 text 兼容。

不做会怎样：数组一旦过内部复制就丢失原文。map/spread 创建的新根没有原来源，仍按普通数组处理。

配套修改：H042、H043、H051。

#### H051 · 对象副本继承原文来源

差异：`@@ -302,7 +304,8 @@ const copyBounded = (`；SHA-256：`a06314e67532a74986df13f1182362c8fc206868408d8044a000e1bb6b1ca9d3`
首段：`    copied[key] = copyBounded(item, label, depth + 1, seen, preserveSandboxValues) ⏎   }`
尾段：` ⏎ export const copyOut = (value: unknown, undefinedAsNull = false): unknown => {`

职责：在业务字段复制完成后为内部对象转交原文并按条件提供 text 别名。

机制：返回值改为 withRawText(copied, rawText(value), true)；copyOut 继续只遍历业务可枚举字段。

必要性：原文别名应在输出验证后的内部副本出现，并让同名业务字段优先。

不做会怎样：内部复制会丢掉来源；若把别名变成可枚举字段，则会改变最终 JSON 和键遍历。

配套修改：H042、H063。

#### H052 · 统一工具的紧凑具名签名

差异：`@@ -338,12 +341,13 @@ const definitions = <R>(`；SHA-256：`645fafe12d518b97b84b750d10c85db64357aaea24df861b62824e3dde43a13e`
首段：`} ⏎  ⏎ const describeDefinition = <R>(path: string, definition: Definition<R>): ToolDescription => {`
尾段：``    signature: `${toolExpression(path)}(${input === "{}" ? "" : `input: ${input}`}): Promise<${outputTypeScript(definition)}>`, ⏎   } ⏎ }``

职责：为 catalog、instructions、search 和 namespace 提示生成同一签名。

机制：describeDefinition 只用无 pretty 参数的输入/输出 renderer，非空输入写为 input: 类型，空对象保留零参展示。

必要性：模型需要稳定的真实参数与返回类型概览；字段详情转到按需 search schema。

不做会怎样：各出口会继续展示多行签名或不同形状，减少同预算可展示工具数。未声明输出仍由 renderer 返回 unknown。

配套修改：H055、H060、H067、H069。

#### H053 · 让搜索索引保存原合同引用

差异：`@@ -365,6 +369,9 @@ export type DiscoveryPlan = {`；SHA-256：`bd28bccb0f304aa1e1eb793e7031539f5999073d418903f28b1c460d40af33d2`
首段：`export type SearchEntry = { ⏎   readonly description: ToolDescription`
尾段：`  /** Lowercased path + description + input property names/descriptions, for substring matching. */ ⏎   readonly searchText: string`

职责：为命中后按需发射完整 schema 留下真实输入和输出来源。

机制：SearchEntry 增加 inputContract、outputContract，而 ToolDescription 仍只保存路径、说明和签名。

必要性：详情应仅为搜索命中的条目生成，不预先扩充整个内联目录。

不做会怎样：搜索只剩文字摘要，无法从真实合同恢复字段说明、约束与引用。

配套修改：H055、H056。

#### H054 · 补齐内建 search 的输入合同

差异：`@@ -420,8 +427,10 @@ const rank = (entries: ReadonlyArray<SearchEntry>, query: string): Array<SearchE`；SHA-256：`acd74f516ec2fbee2fe6a5d5626443b239a92706154c17f92333dd206acdeb80`
首段：`const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition => ({ ⏎   _tag: "CodeModeTool",`
尾段：`    Effect.sync(() => { ⏎       const request = input as typeof SearchInput.Type`

职责：让 search 自身也满足新的 Definition 结构。

机制：makeSearchTool 以同一个 SearchInput 同时填写 inputContract 和 input，run 仍为内存索引上的 Effect.sync。

必要性：签名和实际解码同源规则也适用于全局 search。

不做会怎样：Definition 接口和 renderer 缺少 search 的真实输入来源；这条修改不使 search 占用工具许可。

配套修改：H071、H073、H064。

#### H055 · 按需生成搜索详情并按完整条目分页

差异：`@@ -446,24 +455,57 @@ const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition =>`；SHA-256：`f1d37000f302d06cc3ffa95b42919dd61772b9371ebdae17823f9f7b1ae99abc`
首段：`              (entry) => entry.description.path === pathQuery || toolExpression(entry.description.path) === trimmed, ⏎             )`
尾段：``   const description = line.length > 120 ? line.slice(0, 117) + "..." : line ⏎   return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}` ``

职责：保留原相关性排序和 offset/limit 接口，补齐真实 schema 详情及16K软预算。

机制：每个命中项分别发射输入 encoded 合同、输出 decoded 合同；definitions 接回 $defs，普通 JSON schema 原样提供。各侧发射异常只把该侧设为 null 并追加 schemaUnavailable，保留另一侧和同页工具。每加完整条目后，以含 remaining/next 的 JSON.stringify(response()).length 计量，达到16384字符就结束本页；跨阈值条目完整保留。searchSignature 改用同源紧凑具名签名。 页内诊断数组为每个条目单独创建，普通 JSON schema 不重新发射或删改字段元数据。

必要性：紧凑签名不能替代字段 description/default/format/约束；单个无法表示或超长的合同不能使发现整页消失。

不做会怎样：旧搜索没有详情和尺寸预算；整页捕获异常会丢正常工具；严格截断会破坏唯一长条目的 schema，offset 也可能失去稳定推进。这里的计量是 JavaScript 字符单位，不是 UTF-8 字节或模型 token。

配套修改：H048、H053、H056、H069。

**1. 命中项才生成详情**

SearchEntry 保存原合同引用；每个进入本页的命中项才调用 describeSchema。Effect 输入从原合同发射 encoded schema，输出先取 Schema.toType；生成文档的 definitions 接回 $defs。普通 JSON schema 直接保留，因此字段描述、false/0 默认值和约束不用另写一套文字 renderer。

**2. 发射失败按输入、输出分别处理**

describeSchema 的 try/catch 只包这一侧的 schema 发射与文档组装。失败侧返回 null，并将 input 或 output 加入 schemaUnavailable；成功侧、工具路径、签名、相关性排序和同页其他工具继续保留。页面 JSON.stringify 与实际工具执行不在这个 catch 内。

**3. 用完整响应计量，保留跨阈值条目**

每轮先加入整项，再计算含 items、remaining、next 的序列化长度，首次达到或超过16×1024就停止。limit 继续限制条目数，offset 按已加入项数推进；单个超长项也完整返回。原相关性排序没有换成内联目录的优先级和短签名排序。

#### H056 · 把定义合同放入完整搜索索引

差异：`@@ -471,6 +513,9 @@ const catalogLine = (tool: ToolDescription) => {`；SHA-256：`a125ef7e3dac7265aea98deb78b8231f31d0c9691c248270963cba5d3592a4bf`
首段：`const toSearchEntry = <R>(path: string, definition: Definition<R>, description: ToolDescription): SearchEntry => ({ ⏎   description,`
尾段：`  searchText: [ ⏎     path,`

职责：构建索引时传递真实合同，保持字段搜索文本原来源。

机制：toSearchEntry 复制 definition.inputContract 和 definition.output 的引用，原 pathWords/searchText 构建继续。

必要性：H053 只定义结构，H055 需要在每个实际索引项上取得合同。

不做会怎样：详情发射拿不到每个工具的原来源；若改拿 ToolDescription，则只能恢复已压缩的字符串。

配套修改：H053、H055。

#### H057 · 先建立完整索引再安排目录展示

差异：`@@ -493,26 +538,23 @@ export const assertValidTools = <R>(tools: HostTools<R>): void => {`；SHA-256：`21ace36f69455c27c8c09dc07da0476b34e95db8371856b9c769969fcab4e0ac`
首段：`  } ⏎ } ⏎  ⏎ // 优先级只是宿主给出的当前路径；目录预算不会增加实际工具或绕过过滤。`
尾段：`    const group = namespaces.get(namespace) ?? [] ⏎     group.push(tool)`

职责：把全量能力索引与预算内文字选择分开。

机制：prepare 接收 priority，先从 visibleDefinitions 创建 index，再从 index 的 description 分组；预算仍校验非负安全整数。

必要性：优先级只影响当前过滤目录的展示，不改变可发现工具全集。

不做会怎样：若从选中条目反推索引，目录放不下的工具会从搜索消失；没有 priority 参数也无法接入宿主偏好。

配套修改：H007、H058、H059。

#### H058 · 按优先路径和签名长度选择内联项

差异：`@@ -520,64 +562,49 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`；SHA-256：`053f7036400c404eb8ada45c77dcef7ab6bf6cad32653635b6f910c8f196151c`
首段：`  } ⏎   const ordered = [...namespaces].sort(([left], [right]) => compareText(left, right))`
尾段：`    } ⏎   }`

职责：在预算内优先展示宿主确认的核心工具，并让余下选择稳定。

机制：priority 变 Set；按是否优先、signature.length、完整路径排序。先扣 namespace 标题成本，再逐项尝试，超长项跳过；最后按 namespace 输出已选项及准确 shown 计数。 新注释明确 picked 只影响展示，完整 catalog 和搜索索引保留。

必要性：同样预算可先放常用入口，同时让未展示数量明确，过长一项不阻塞后项。

不做会怎样：原 round-robin 规则不会应用宿主核心优先级，也保留旧的选项分组结构。极小预算仍可能放不下优先工具，此实现不保证核心项必显。

配套修改：H057、H059、H083。

#### H059 · 返回未裁剪的搜索索引

差异：`@@ -585,7 +612,8 @@ export const prepare = <R>(tools: HostTools<R>, catalogBudget = defaultCatalogBu`；SHA-256：`825e34f7381860320442cf83e22cac730b70415e2136d9917d36cb6d90edd040`
首段：`  return { ⏎     catalog: described,`
尾段：`    searchIndex: index, ⏎   } ⏎ }`

职责：保证预算只影响 instructions 的内联展示。

机制：prepare 的 searchIndex 直接返回预先创建的完整 index。

必要性：与 H057/H058 共用一次索引构建，隐藏签名的工具仍可精确搜索。

不做会怎样：保留旧的完整索引重建也能维持能力，但会重复构建；直接返回 index 复用 H057 已完成的工作，旧行本身不会删除工具。

配套修改：H057、H058。

#### H060 · 在 namespace 误调用时提供真实签名

差异：`@@ -638,7 +666,23 @@ const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>, index: Rea`；SHA-256：`4527c93e206cccdd34caed1b29d7bcce8678065331623b9c967cd58773010109`
首段：`  } ⏎  ⏎   if (typeof value !== "function" && !isDefinition(value)) {`
尾段：`    ]) ⏎   } ⏎  ⏎   return value`

职责：给错误调用提供可恢复信息，同时保持 UnknownTool 失败。

机制：筛选当前 namespace 前缀下索引项，按2000字符预算加入整条签名；遗漏项给数量和 search 指引，绝不自动选择 leaf 执行。

必要性：模型把一组工具当函数调用时，需要知道实际可调用路径；恢复提示不得制造副作用。

不做会怎样：原错误只有 not callable，缺少当前目录可用项；自动猜工具则会把命名错误变成真实调用。

配套修改：H047、H052。

#### H061 · 在 ToolRuntime 创建唯一工具许可池

差异：`@@ -660,6 +704,8 @@ export const make = <R>(`；SHA-256：`146d26dada7df64db2e68501f73b4dcfd4ee946cf5eb2bf1f2132c10076abc92`
首段：`  hooks?: ToolCallHooks<R>, ⏎   fetch?: HostTool<R>,`
尾段：`  const callableTools = { ⏎     ...tools,`

职责：把实际宿主并发控制放在数据与调用边界。

机制：每次 make 创建一个 TOOL_CALL_CONCURRENCY 大小的 Semaphore，当前常量为八。

必要性：所有工具和 fetch 要共用一组许可，async 包装与组合器不应占槽。

不做会怎样：只迁移调用包装而没有当前池，无法约束宿主并发；解释器原许可也不能再作为第二层重复调度。

配套修改：H015、H020、H064。

#### H062 · 在原解码前应用正向简写

差异：`@@ -723,7 +769,17 @@ export const make = <R>(`；SHA-256：`a742daa3d9771c73ceee18aa03a9fdab9c2ab56799a14f3ffb600f1b5e1b8db6`
首段：``            throw new ToolRuntimeError("InvalidToolInput", `Tool '${name}' expects at most one input object.`) ⏎           // 零参沿上游按{}进入原decoder，必填字段仍在执行前拒绝；显式undefined不替换。``
尾段：``              new ToolRuntimeError("InvalidToolInput", `Invalid input for tool '${name}': ${String(cause)}`), ⏎           })``

职责：将明确的标量简写转成对象输入，再沿原参数校验入口执行。

机制：normalizeInput 使用 tool.inputForms；结果再过 copyIn/copyOut 后交 decodeToolInput。零参仍为 {}，显式 undefined 保留，转换错误仍归 InvalidToolInput。

必要性：新构造键值也须经过危险键和普通数据检查；真实 decoder 负责 default/refinement/transform。

不做会怎样：只定义形式而不在入口应用，简写不会生效；绕过数据边界包装则可能把新字段绕进 decoder。标量合同没有反向拆包路径。

配套修改：H009、H073。

#### H063 · 输出校验后再转交原文来源

差异：`@@ -739,7 +795,8 @@ export const make = <R>(`；SHA-256：`717cef888e826648c9b4b4fc0ec504f9008e436e2a6baeef8cb22529344e4766`
首段：``                try: () => decodeToolOutput(tool, raw), ⏎                 catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),``
尾段：`            currentCall, ⏎           )`

职责：让 decoder 重建的业务结果保留来源，且不让 text 别名参与输出合同。

机制：先 decodeToolOutput(tool, raw)，再 withRawText(result, rawText(raw))，最后走 decodeOutput 的沙箱复制。

必要性：原文元数据应跨过 decoder 重建，但业务验证必须先完成。

不做会怎样：来源会在 decoder 返回新对象时丢失；若先注入 text 别名再验证，原合同会看到不属于业务的数据。

配套修改：H042、H050、H051。

#### H064 · 把许可包在实际调用入口外

差异：`@@ -750,7 +807,13 @@ export const make = <R>(`；SHA-256：`d68e4d6050029b8bbe22f8e9e2cd42abe45db44b4e1ff8f7cd67003d701dba5c`
首段：`          }), ⏎           currentCall,`
尾段：`      ), ⏎   } ⏎ }`

职责：使排队先于实际校验、计数、running 通知和宿主执行。

机制：invoke 的整个 Effect 用 permits.withPermits(1) 包装；仅 $codemode.search 直通，fetch 与全部宿主调用共用许可。 两行注释分别说明准入后的计数/超时起点，以及同步 search 例外；注释压缩保持原调用语义。

必要性：队列等待不应制造假 running，也不应消耗叶子工具自身的执行超时；根取消必须能停止等待者。

不做会怎样：未包住全部入口会出现已计费但尚未运行的记录，或超出八个实际调用；把 search 也异步排队则改变其同步发现合同。

配套修改：H061、H020。

### packages/codemode/src/tool-schema.ts：合同与签名展示

源文件 SHA-256：`7d93eac35df2d6b0bd29bc1c944c4d062afc1ff1b5c2b95df0d881ddcd5e748f`
候选 SHA-256：`f216d4953b417d6f07fd99a98dddea9ecd15cb142f62987ccc5511b4a822105a`

#### H065 · 移除多行 renderer 的状态开关

差异：`@@ -34,10 +34,9 @@ const intersection = (members: ReadonlyArray<string>): string => {`；SHA-256：`f546765bd1372ea46ad67ca106d6621c37e977451206069a0f023c3c0a70ffcd`
首段：` */ ⏎ const MAX_RENDER_DEPTH = 8`
尾段：` ⏎ const hasUnresolvedRef = (`

职责：让签名渲染只携带引用定义。

机制：RenderContext 删除 pretty 字段。

必要性：和 H066/H067 一起收敛为一套紧凑 renderer。

不做会怎样：单独保留未使用的状态字段不会改变行为；这里是接口清理，真实展示变化在 H067/H069。

配套修改：H066、H067、H069。

#### H066 · 删除 JSDoc 拼装器

差异：`@@ -64,46 +63,7 @@ const hasUnresolvedRef = (`；SHA-256：`9450d312f35328ed131773b399eeb900813f2032d369cf2739764a2e7a6e417b`
首段：`  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited)) ⏎ }`
尾段：`  schema: JsonSchema, ⏎   ctx: RenderContext,`

职责：去掉第二套多行字段文档文本生成。

机制：移除 docTags 和 jsdoc，renderSchema 继续负责类型形状。

必要性：字段完整说明由 H055 的原 schema 按需交付，无需同时维护 JSDoc 转写。

不做会怎样：保留未调用的辅助函数不会破坏执行；这项删除减少重复实现，不代表字段详情应丢失。

配套修改：H055、H067。

#### H067 · 让所有 schema 渲染为紧凑类型

差异：`@@ -177,41 +137,31 @@ const renderSchema = (`；SHA-256：`31da79a83b8223e81802fbb03442cf637a7af36192250bbde6193f5561c574a9`
首段：``     const field = ([name, value]: readonly [string, JsonSchema]) => ⏎       `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}` ``
尾段：`    return renderSchema(schema, { definitions: { ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } }) ⏎   } catch { ⏎     return "unknown" ⏎   }`

职责：统一对象字段、索引签名及 Effect/JSON schema 的 TS 概览输出。

机制：renderSchema 只拼单行字段；toTypeScript、jsonSchemaToTypeScript 去掉 pretty 参数，引用解析和发射失败回退 unknown 保留。

必要性：四个模型出口应复用同一概览，按需 schema 详情负责类型之外的约束。

不做会怎样：目录与搜索仍可能走不同的多行形态，同工具的签名不再同源；这项改动只影响展示，不修改 decoder。

配套修改：H052、H055、H069。

#### H068 · 字段搜索使用真实输入合同

差异：`@@ -231,16 +181,17 @@ export type InputProperty = {`；SHA-256：`7fa1c60f240bce3bfce7a0fd61422ceed93409ba9d28c0869eef3361ca99a450`
首段：`` * directly, resolving a trivial top-level `$ref` into `$defs`/`definitions` when present. ⏎  * Anything unresolvable yields `[]` (search falls back to path + description).``
尾段：`    const definitions = document.definitions ?? {} ⏎     let schema = document.schema`

职责：让字段名和字段描述的索引来源与签名、简写一致。

机制：inputProperties 从 definition.inputContract 发射或读取 JSON schema，保留 definitions/$defs 和原 top-level ref 处理。

必要性：展示 schema 经插件改写后，仍需按实际可调用字段查找工具。

不做会怎样：搜索可能按展示字段命中却与真实 decoder 不符；正向简写不适用的复杂对象也不能因此失去完整字段索引。

配套修改：H071、H073。

#### H069 · 从真实合同生成唯一输入输出签名

差异：`@@ -262,26 +213,20 @@ export const inputProperties = <R>(definition: Definition<R>): Array<InputProper`；SHA-256：`0c74be22c7057609570833173a9ae07434edae31551d035ecc331f67b8aba829`
首段：`  } ⏎ } ⏎  ⏎ // 只展示原始输入合同；运行时简写仍由同一合同推导，不把宽容形式重复注入每条签名。`
尾段：``/** ⏎  * Decodes tool input before `run` is invoked. Effect Schemas validate (throwing on failure);``

职责：把 inputContract 用于输入概览，保留真实输出来源。

机制：inputTypeScript 对 Effect 合同按 encoded 域渲染；outputTypeScript 按 decoded 域，缺失则 unknown；两者都删除 pretty 参数，也不追加简写 union。

必要性：签名展示标准输入，宽容简写由运行时派生，避免给每个工具重复扩充类型。

不做会怎样：模型仍可能看到插件改过的展示输入，或看到另一套多行签名；根据工具名字猜返回类型没有合同依据。

配套修改：H052、H067、H073。

### packages/codemode/src/tool.ts：工具定义

源文件 SHA-256：`e297f881d51f281d21376ce58cd30909aa0e69f8ec1b722334c09834d6f6a1bd`
候选 SHA-256：`77c69403bba814c18cbfb9d76422e7e72f470054fa110e2d964056b25708b428`

#### H070 · 接入输入形式派生函数

差异：`@@ -1,4 +1,6 @@`；SHA-256：`96f86dd607a2c48b58e75ef9c03a593e0f14ccb661c113b5b18550e465fe843c`
首段：`import { Effect, Schema } from "effect" ⏎ // 形式识别随真实输入合同派生，避免展示 schema 改写后简写误选字段。`
尾段：`/** ⏎  * JSON Schema subset accepted for render-only tool schemas.`

职责：为 Tool.make 从真实合同推导简写提供依赖。

机制：导入 inputForms 和 InputForms 类型。

必要性：归 H071/H073 的定义和构造使用。

不做会怎样：没有独立行为；单独删导入会造成函数或类型引用缺失，注释不增加简写规则。

配套修改：H009、H071、H073。

#### H071 · 区分输入来源合同与本层 decoder

差异：`@@ -36,6 +38,9 @@ export type SchemaType = Schema.Decoder<unknown> | JsonSchema`；SHA-256：`255e5707e036793ca9e8c1500f58fcae9cab6fe7446302ef5fa364030d56515d`
首段：`export type Definition<R = never> = { ⏎   readonly _tag: "CodeModeTool"`
尾段：`  readonly output: SchemaType | undefined ⏎   readonly run: (input: unknown) => Effect.Effect<unknown, unknown, R>`

职责：在工具定义中保存完整合同和派生形式。

机制：Definition 增加必填 inputContract、可选 inputForms；既有 input 继续决定本层是否执行 Effect 解码。

必要性：宿主适配器要展示真实合同，同时让实际解码留在原宿主入口。

不做会怎样：只复用 input 会把展示与执行混在一起，难以同时避免重复 decoder 和展示漂移。

配套修改：H062、H068、H069、H073。

#### H072 · 允许宿主传入原 decoder 来源

差异：`@@ -50,6 +55,8 @@ type ResultType<S> = S extends Schema.Decoder<unknown> ? S["Encoded"] : unknown`；SHA-256：`e87cd0dde0334497f1082a1339fb50636b6a3121a507eda35ff81821d9959757`
首段：`/** Options for defining one CodeMode tool. */ ⏎ export type Options<I extends SchemaType, O extends SchemaType | undefined, R = never> = {`
尾段：`  readonly output?: O ⏎   readonly run: (input: InputType<I>) => Effect.Effect<ResultType<O>, unknown, R>`

职责：给只用 JSON input 展示的适配器传递真实合同的选项。

机制：Options 新增可选 inputContract: Schema.Decoder<unknown>。

必要性：ToolRuntime 可以依据真实合同生成签名和简写，而原工具仍执行自己的 decoder。

不做会怎样：适配器只剩展示 JSON schema，无法证明真实参数结构和 encoded 域。

配套修改：H073、H082、H083。

#### H073 · 以同一实际合同派生展示和简写

差异：`@@ -87,10 +94,17 @@ export const isDefinition = <R = never>(value: unknown): value is Definition<R>`；SHA-256：`b1755a3b09d927457b76064538548a447a6aa52dc868617c9aa16e87dd629628`
首段：` */ ⏎ export const make = <I extends SchemaType, const O extends SchemaType | undefined = undefined, R = never>(`
尾段：`  } ⏎ }`

职责：在 Tool.make 集中确定合同优先级，不执行 decoder 探测。

机制：input 是 Effect schema 时优先使用它；否则用明确传入的 inputContract，最后才回退 JSON input。只有 Effect 合同派生 inputForms，原 input/output/run 保留。

必要性：原始输入与转换语义需要一个来源；纯展示 JSON 不能额外授予调用形式。

不做会怎样：展示、字段搜索和简写可能各用不同来源；先运行 decoder 猜形式还会重复 default/transform 的效果。

配套修改：H009、H062、H068、H069、H071、H072。

### packages/codemode/src/values.ts：Promise 值

源文件 SHA-256：`61069ee6cec59ded1c14f1214d243e91fd59cd27ab78d3851ca2112aade745a9`
候选 SHA-256：`8f6f6d092347dddc2ec2418aca2a6703cf23c8df03309b889a8e94181a9e8510`

#### H074 · 用 Fiber 或终态表示 Promise

差异：`@@ -1,11 +1,10 @@`；SHA-256：`ecf593e4ee8587c6e83366a01ea6ec3fb60a4bbd063e21dc80d3a69952009f2a`
首段：`import type { Exit, Fiber } from "effect" ⏎ `
尾段：` ⏎ export class SandboxDate {`

职责：把在途状态与跨单元可保存的结果分开，并记录结果是否被观察。

机制：SandboxPromise 改为 state 联合 { fiber } | { exit }，observed 默认 false；删去 interrupted 和 immediate Effect 字段。

必要性：H020/H040 可以统一即时与异步 Promise，并在根结束后释放旧 Fiber 引用。

不做会怎样：保留旧结构会把 race 专属取消标记和即时 Effect 带入新语义，也无法统一表达已安全退休的 Promise 结果。

配套修改：H020、H032、H040。

### packages/opencode/src/mcp/catalog.ts：MCP 协议投影

源文件 SHA-256：`fafeb96cf45c3c8769e13395b1d6e3a9d9628802f41eb9678a2d86f7b8796e1e`
候选 SHA-256：`bece9223f0b0b25d121d7b4c4164fe9950559304e5d1c9e9f1a4b7cf3e533f64`

#### H075 · 让 MCP 投影接收输出声明

差异：`@@ -58,7 +58,11 @@ export async function callTool(entry: MCP.McpTool, args: unknown, signal?: Abort`；SHA-256：`7f456c6c4ac30fa12dbbfbe2a8b8a0ad97457152536ae5a6340d578497ef6876`
首段：`} ⏎  ⏎ // 同一次 transport 的程序投影保留结构化值；媒体留在宿主，避免字节进入解释器。`
尾段：`  const text: string[] = [] ⏎   const attachments: NonNullable<Tool.ExecuteResult["attachments"]> = []`

职责：把判断文本投影资格所需的协议合同带到 owner。

机制：programResult 新增可选 outputSchema 参数，structuredContent 和附件处理流程保留。

必要性：只有 MCP 适配层同时知道原结果和工具声明，宿主不能仅凭文本长得像 JSON 决定。

不做会怎样：H076 无法排除已声明输出的结果，可能改变有类型工具的返回语义。

配套修改：H076、H078。

#### H076 · 标记可投影的成功单文本结果

差异：`@@ -95,7 +99,18 @@ export function programResult(result: CallToolResult): NonNullable<Tool.ExecuteR`；SHA-256：`a2846d3840d745fe3eee9f353e3247c41f1a60c271e2f389c3ab12ea0bc381da`
首段：`  // 媒体专用结果也返回可组合的普通值，让脚本知道调用成功而无需接触字节。 ⏎   const value = result.structuredContent ?? (text.length > 0 ? text.join("\n")`
尾段：` ⏎ export * as McpCatalog from "./catalog"`

职责：严格限定哪些 MCP 文本允许后续转成对象或数组。

机制：仅在非 isError、无 outputSchema、无 structuredContent、恰有一个文本且其余内容仅 image/audio 时给出 rawText。原 value 与独立 attachments 保留。

必要性：一段 schema-less JSON 文本可供脚本组合，分段文本、资源、错误和声明输出仍遵循原协议。

不做会怎样：无标记时宿主无法安全选择投影；宽泛解析会把已声明字符串、错误正文或多块协议内容改成另一种结果。

配套修改：H008、H075、H078、H083、H088。

### packages/opencode/src/session/tools.ts：Session 目录与清理

源文件 SHA-256：`c68bfb2c4427423c536a24a26c4c81c76fbc85ba373fce560ef5d7cee9eee862`
候选 SHA-256：`a37c418c3df53a5b1e4e18123f5d82e9a1fc10d936452bec8dbbeb38652d7a04`

#### H077 · 说明并展开 child 的取消与清理边界

差异：`@@ -261,9 +261,17 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`ab217267131a6d893c436e36ad4d7b5b5326b1045fd923613162994ae7c3588e`
首段：`                      const cancel = new AbortController() ⏎                       const pending = invoke(leaf, args, { ...options, toolCallId: callID, abortSignal: AbortSignal.any([signal, cancel.signal]) }, child)`
尾段：`                    }), ⏎                   ).pipe(Effect.onExit(() => Effect.gen(function* () {`

职责：说明真实 child 的取消通知和清理完成顺序，并展开原 pending 回调以便阅读。

机制：注释说明根 Scope 或宿主中断触发取消、abort 仅发通知、ensuring 等原 pending 完成；Effect.ensuring/Effect.promise/pending.then 的原表达式分行显示，两个回调仍分别返回 undefined。

必要性：race 只竞争观察，实际 child 由根或宿主取消；同环境下一格接管资源仍依赖原 Promise 完成。分行后能直接看清两个完成分支都归同一清理等待。

不做会怎样：保留旧排版不改变执行。缺少准确注释会让维护者误把 race 获胜当作生产者取消，或把 abort 通知当作资源已释放；本 hunk 没有取消或清理算法变更。

配套修改：H020、H032、H083。

#### H078 · 把 MCP 原输出声明交给投影

差异：`@@ -601,7 +609,8 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`789439770008cae74ef07b2dd87649eda4ba714d0a49fc55c725a500647f0688`
首段：`            output: truncated.content, ⏎             attachments,`
尾段：`        }).pipe(Effect.orDie), ⏎     }`

职责：在实际 Session MCP 返回路径接通资格判断。

机制：McpCatalog.programResult(result, entry.def.outputSchema) 替代只传 result。

必要性：H075/H076 的条件需要实际工具定义，不能由展示结果倒推。

不做会怎样：声明输出的 MCP 结果会被误认为无 schema 候选；SDK 原输出验证仍由既有调用负责。

配套修改：H075、H076。

#### H079 · 把原 decoder 来源放进 Session 目录

差异：`@@ -610,20 +619,32 @@ export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {`；SHA-256：`b19908b2abb4c5e0041e65a41f2b4ef7d77c42ac0fd61cf1126960552a36511f`
首段：`  const eligible = ToolSelection.filter(inventory, input.agent.permission, input.session.permission, input.userTools) ⏎   // 捕获的 Agent 和模型工具选择保持整轮稳定，运行中只刷新 Session 开关与连接成员。`
尾段：`    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item)) ⏎     // Provider 只负责参数呈现；直接与嵌套入口都继续复用工具原来的运行时校验。`

职责：让宿主目录携带真实 runtimeParameters，同时保留现有展示 schema 和输出合同。

机制：目录项增加 item.runtimeParameters；catalog.push 的过滤、server/local 派生、map 和返回对象按完整语句分行。原排除列表、MCP namespace 选择、展示 schema 与 output 回退值保持原语义。

必要性：原 wrapper 来源要经 SessionTools 继续传到 toolTree，才能用于签名和正向简写。完整目录表达式的多行排版让筛选、命名和构造边界可直接辨认。

不做会怎样：省去 runtimeParameters 会在 Session 层丢失真实合同，使插件展示变化再次成为唯一来源。保留原单行表达式只影响阅读，不改变目录成员、MCP 命名或输出选择。

配套修改：H082、H083、H086、H090、H091。

### packages/opencode/src/tool/code-mode.ts：Execute 宿主

源文件 SHA-256：`2d16bff069c584a73689cdc821aa0b39e9508163dba369c84367e6ded1b8369d`
候选 SHA-256：`22a0f30e843290c8eefa9f6dcabd6a0f2885728cb5c3520f2d95d020bb914aeb`

#### H080 · 开放环境 ID 与执行 timeout 参数

差异：`@@ -1,13 +1,25 @@`；SHA-256：`90d66c0284884b6a5ddd123860e45d68e3b61731031d0d5e167372c9350a15c8`
首段：`import { Tool } from "./tool" ⏎ import { Truncate } from "./truncate"`
尾段：`    description: "Script body executed by the confined interpreter.", ⏎   }),`

职责：向调用者提供跨格复用和毫秒执行预算入口。

机制：Parameters 新增可选 environmentID 字符串及正安全整数 timeout，说明默认600000毫秒；引入 ExecuteEnvironments 和 Truncate 作为 H083 依赖。

必要性：环境句柄和超时应由公共参数表达，空字符串保留为显式无效句柄，不能当缺省新建。

不做会怎样：调用者无法恢复旧变量或调节预算；单删服务导入会使 H083 无法取得环境注册表与输出限额，不构成独立功能变更。

配套修改：H083、H084。

#### H081 · 在每份进度 metadata 保留环境 ID

差异：`@@ -16,6 +28,8 @@ export const Parameters = Schema.Struct({`；SHA-256：`338b4dc5163868178aa7b948b892dde8f84eeacba8a8bdea65dafd9aac597fb2`
首段：`type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> } ⏎ `
尾段：`  error?: boolean ⏎   loaded?: string[]`

职责：使成功、进度与错误回执可以指回同一环境。

机制：Metadata 增加 environmentID 字段；H083 在每次整对象更新时填写。

必要性：进度 metadata 被替换时，环境句柄不能只存在第一份回执。

不做会怎样：仅开始时发 ID，后续更新会丢结构化句柄，出错或取消后难以复用。

配套修改：H083。

#### H082 · 声明目录项中的原 decoder 来源

差异：`@@ -25,11 +39,13 @@ type Metadata = {`；SHA-256：`07e77ecde8f6022ba34dd576f0d96e1860ad67bc1ca45f4af3a82a456a77cbf7`
首段：`type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number] ⏎ `
尾段：`  outputSchema?: JSONSchema7 | Schema.Decoder<unknown> ⏎ }`

职责：把 Session 目录与 CodeMode Tool.make 的真实合同入口连起来。

机制：CatalogEntry 新增可选 runtimeParameters，inputSchema 继续负责展示 JSON。

必要性：工具可有真实 Effect decoder，也可只有 MCP/自定义 schema，类型需保留这一区别。

不做会怎样：宿主适配器无法把 H079 收到的原合同传给 H072/H073，或只能把展示 schema 当实际来源。

配套修改：H079、H083。

#### H083 · 串起真实 Execute 的环境、预跑与交付

差异：`@@ -84,139 +100,260 @@ const toolTree = Effect.fn("CodeMode.toolTree")(function* (`；SHA-256：`32e209e21fb79e4e1166608ff23c5a52aebe93f70ff1c87fc04266e9d27fd602`
首段：`      description: entry.description, ⏎       // 沿用 V1 原 JSON Schema 签名适配：对象原样透传，真实输入校验仍由工具拥有。`
尾段：`    } ⏎     return init`

职责：在现有宿主入口组合当前工具、环境租约、预跑检查、真实执行、进度和最终输出。

机制：toolTree 传原 inputContract；discovery 只优先当前原生 read/grep/glob/edit。完整单一 JS/TS 外围栏规范化一次，外层同步 abort 观察覆盖租约排队。租约内创建 runtime，真实预算默认十分钟，探针用同一源码和环境副本、两秒期限。进度先检查100毫秒窗口再复制列表；结果保留 ID、上下文、附件、日志与未观察提醒，把完整正文交既有 wrapper 截断。

必要性：这组连续改动把各库能力接到真实 Session 路径：权限与工具校验沿原入口，环境串行持续到根清理完成，输出事实不由脚本的 return 筛掉。

不做会怎样：只改库而不接宿主，环境和输入合同不会生效；原空环境预跑看不到旧 helper；每事件都快照会放大父进度开销；成功或失败正文也缺少环境 ID 和新增异步失败事实。输出直接复用既有统一截断，最终实现没有宿主折半 JSON 预览。

配套修改：H008、H017、H039、H040、H058、H076、H080、H081、H082、H084。

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
候选 SHA-256：`dbabfa0002d1cffd5e491ece8edab5a71a562b5bb4c99ca139194c5639cf73ca`

#### H084 · 按 Session 与位置管理串行环境租约

差异：`@@ -0,0 +1,236 @@`；SHA-256：`c84e968b4db3f336b559dd3ab3582c4bbc4682f24b001944dea2fa44fb303ad8`
首段：`import { CodeMode } from "@opencode-ai/codemode" ⏎ import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"`
尾段：`export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node, SessionStore.node] }) ⏎ export * as ExecuteEnvironments from "./execute-environments"`

职责：为跨格词法状态提供归属、容量、串行和真实回收。

机制：每项保存 owner、单许可 gate、cancel/drained 和 users；acquire 校验 owner，64项满时只淘汰最早闲置项。use 把排队者也计入 users，提前装释放 finalizer，许可覆盖回调清理；retire 先关准入再取消，close 等全部 drain。InstanceState 复用现有事件和 SessionStore，租约后核对权威位置，并监听删除、移动、workspace 更新。 acquire 的状态变化发生在 Effect.suspend 执行时；retireSession 保留与目的位置匹配的环境。各字段注释明确 gate、cancel、drained 和 users 的不同职责。

必要性：同环境不能并行改词法状态，取消排队者不能取消持有者，实例关闭必须等真实 finalizer。owner 由 Session、directory、workspace 共同确定。

不做会怎样：只有 Map 缓存会允许交错修改、误复用或丢失仍在清理的条目；简单删除引用不能证明回收完成；事件回调等待发布删除的当前单元还会死锁。此实现只发退休信号，由 close 等待 drain。

配套修改：H010、H083、H087。

**1. 归属与容量**

Owner 同时比较 sessionID、directory 和 workspaceID。省略 ID 才创建环境，空字符串照显式句柄校验。ID 沿用 Identifier.create，并在当前集合中检查碰撞。容量64项，满时只选 users 为零且未关闭的最早闲置项；全部忙则明确报错。

**2. 租约包括排队和真实清理**

acquire 在不可中断区增加 users，并为新一轮活跃期创建 drained。gate 的一个许可包住回调及其 finalizer；拿到许可后再检查 closed，回调结束后也检查，避免自发删除后报告成功。恢复可中断性前已安装释放逻辑，排队取消只释放自己的 users，保持持有者继续运行。

**3. 退休先关准入，实例关闭等 drain**

retire 先标 closed，再完成 cancel，活动项保留到 users 归零。最后一个租约释放后才删除并将未关闭项放回 Map 尾部，形成闲置顺序。close 先阻止新 acquire，再退休所有项并等待真实 drained；没有用超时或删 Map 冒充清理完成。

**4. 事件与权威位置共同覆盖移动窗口**

InstanceState 建立注册表并监听 Session Deleted、Moved 和 legacy Updated；事件 data 已解码，读取时使用 Schema.toType。取得租约后再查 SessionStore 的当前位置，覆盖已发生的删除/移动；随后的变化由监听器退休。事件回调只发取消信号，避免当前 cell 删除自身时等待自身退出；实例 finalizer 调用 close，完成后再移除监听器。

### packages/opencode/src/tool/registry.ts：Registry 合同和依赖

源文件 SHA-256：`fb07f6ea12655025ef2fd758a055f613651361560c992b28c8317d203247343b`
候选 SHA-256：`9230dfa6a330854248b49991b4406a82bb278bf7110be14ab1268248bc0da26c`

#### H085 · 导入环境服务节点

差异：`@@ -59,6 +59,8 @@ import { MCP } from "@/mcp"`；SHA-256：`bec3cb2322772a964ca1e3c8071100aa559465cd5c1afcb8f2e613b2164b22cc`
首段：`import { PermissionV1 } from "@opencode-ai/core/v1/permission" ⏎ // #277：read 工具的图片附件处理收敛到 Image.Service，registry 需要装配该依赖`
尾段：`export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) { ⏎   return (`

职责：为 Registry 依赖图接入环境管理提供符号。

机制：新增 ExecuteEnvironments import。

必要性：归 H087 的依赖装配使用。

不做会怎样：本 hunk 没有独立缓存或生命周期行为；单独删导入会使节点引用无法解析。

配套修改：H087。

#### H086 · 插件修改展示后仍保留原合同

差异：`@@ -347,6 +349,9 @@ const layer = Layer.effect(`；SHA-256：`f6a5e6ddb8335b5fd0fc22757a6458d7f04c1eb6144658d128d9bfef60811064`
首段：`              .filter(Boolean) ⏎               .join("\n"),`
尾段：`            output: tool.output, ⏎             // #557：plugin 只能改 Provider definition；server policy 始终取原 Tool.Def。`

职责：在 Registry 的 definition hook 之后把实际 decoder 来源传下去。

机制：返回定义使用 output.parameters 展示，同时 runtimeParameters 取原 tool.runtimeParameters。

必要性：插件可改说明和展示参数，实际 wrapper 闭包仍使用原 decoder，两者需保持清晰。

不做会怎样：Session 只能看到插件修改后的展示参数，签名和简写会与真实校验产生偏差。

配套修改：H079、H090、H091。

#### H087 · 沿现有依赖图提供环境服务

差异：`@@ -466,6 +471,8 @@ export const node = LayerNode.make({`；SHA-256：`a78bddd9f313360f8260c25450df80a78663163261092512f8ba190d311c151c`
首段：`    Instruction.node, ⏎     FSUtil.node,`
尾段：`    CrossSpawnSpawner.node, ⏎     Format.node,`

职责：让 Execute 初始化获得 InstanceState 下的环境 owner。

机制：ToolRegistry 的 LayerNode deps 加入 ExecuteEnvironments.node，其 SessionStore/事件依赖由该节点提供。

必要性：环境管理应随既有实例生命周期创建与释放，不在 resolver 每次建立另一份缓存。

不做会怎样：CodeModeTool 取不到所需服务，或被迫把状态放到错误的 resolver 寿命中。

配套修改：H084、H085。

### packages/opencode/src/tool/tool.ts：工具 wrapper

源文件 SHA-256：`8f7e44cd4dbd379e51847285a82e1cbedc8c2f81d41bc68de79c78039c1ad2ac`
候选 SHA-256：`c09b229b7b358a69e6ff606934d57ea0f1ef68f44b5d64be97cfebc9675f1e5c`

#### H088 · 在程序结果通道声明 rawText

差异：`@@ -57,7 +57,12 @@ export interface ExecuteResult<M extends Metadata = Metadata> {`；SHA-256：`a0eb22acf61cacaf02c59816bed8cc580b6134a01057a8f2e6d4467a7144f1b4`
首段：`  output: string ⏎   attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]`
尾段：`  context?: { kind: "instruction" | "skill"; key: string; text: string }[] ⏎ }`

职责：给协议 owner 的候选标记提供宿主类型出口。

机制：ExecuteResult.program 扩展为 value、可选 rawText 和 attachments；普通 output 与 context 继续分开。

必要性：MCP 投影要把资格事实传到 Execute，不应通过正文猜测或改变用户可见 MCP output。

不做会怎样：H076 的标记无法沿实际结果结构传到 H083；把它塞进业务 value 则会污染脚本数据。

配套修改：H076、H083。

#### H089 · 在工具定义声明原参数来源

差异：`@@ -69,6 +74,8 @@ export interface Def<`；SHA-256：`73078c9d25047f41e1b02400f367a2b9a12245209b4cc1368e3651a986afc1a1`
首段：`  id: string ⏎   description: string`
尾段：`  // 程序值的同一声明服务目录和解码；输入校验仍由 parameters 独立拥有。 ⏎   output?: Schema.Decoder<unknown> | JSONSchema7`

职责：让 wrapper 保留的 decoder 引用可经过 Registry 与 Session。

机制：Def 增加只读可选 runtimeParameters，parameters/jsonSchema/output 的职责不变。

必要性：这条类型链只保存已有来源，不在工具启动路径引入解释器依赖。

不做会怎样：后续层没有标准字段接收真实 decoder，只能依赖可能被插件修改的展示参数。

配套修改：H086、H090、H091。

#### H090 · 固定 wrapper 实际使用的参数来源

差异：`@@ -146,10 +153,10 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`；SHA-256：`ff51a6e0c36956e82902fd97fa795d05075a34ffe01509c95ecaf63f10335e85`
首段：`  return () => ⏎     Effect.gen(function* () {`
尾段：`      toolInfo.execute = (args, ctx) => { ⏎         // #155：streaming metadata 先消毒再转发，避免终端转义序列先落 UI`

职责：在编译 parser 的同一位置保存原 schema 引用。

机制：runtimeParameters = toolInfo.parameters，decodeUnknownEffect 用这个引用在 init 时编译一次；未调用 decoder 做形式探测。原连续三行英文说明改成两处单行中文注释，分别贴近合同捕获和 parser 编译。

必要性：保存来源必须与真实闭包所用合同完全一致，default/transform 也不能因分类先执行一次。

不做会怎样：仅接受 initializer 自报 runtimeParameters 可能与实际 parser 不一致；原 decoder 仍应只在真实调用执行。注释替换保留了每次 init 只编译一次的维护约束，自身不改变执行。

配套修改：H089、H091。

#### H091 · 返回由 wrapper 确认的原参数来源

差异：`@@ -199,7 +206,8 @@ function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadat`；SHA-256：`0728d1ef8e21d0a4072f9f51530cfe56fd50295a005a5fc30fd97fb75656c8d7`
首段：`          } ⏎         }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))`
尾段：`    }) ⏎ }`

职责：将真实 parser 来源交给后续 Registry，并覆盖 initializer 同名字段。

机制：wrap 返回 { ...toolInfo, runtimeParameters }，把 H090 捕获的引用放在展开之后。

必要性：原合同的权威来源是 wrapper 编译 decoder 的位置。

不做会怎样：后续层拿不到保存的原引用，或 initializer 提供的同名字段覆盖它，导致展示和简写再次偏离真实执行。

配套修改：H079、H086、H090。

## 13. 修改范围与代码写法

生产修改集中在前述17个文件，测试13个文件，文档为 README 和现有计划文件，共32个路径。输入形式、原文来源、环境租约各有一个清楚的所有者，其余都扩展现有函数。

长调用和多分支按仓库120列正常排版，保留空行。既有文件只展开实际修改的完整语句；新文件整体排版。保留原 fetchHTTP、未改的 Session 主干和原解释器方法格式，避免把功能改动变成全文件重排。

注释写在需要解释的代码旁：根 Scope 与观察者的区别、原子登记窗口、闭包局部帧、真实 encoded 合同、准入后计时、图复制的共享身份、协议投影资格、统一截断中的完整恢复正文。删除重复翻译变量名、逐行复述赋值和只记录旧方案的注释。

整个 PR 相对共同基线的生产新增加删除最多2000行，净增最多1200行；测试和文档另算。有效变更代码 E 排除空行、仅 import、纯格式、生成物及纯移动。合格中文说明 C 按逻辑注释块计数，必须严格超过 E 的15%；需要的最少条数是 floor(E × 0.15) + 1。逐 hunk 对应此前提交和当前修改，不能只补本轮。

普通注释连续最多两行，一段连续说明只算一条，不能用空行拆开同一个意思增加数量。函数 docstring 可超过两行，但只说明该函数的输入、输出、效果、生命周期或错误合同，一块仍算一条。文档、仅导入旁说明和重复代码含义的文字不能代替邻近的有效解释。

关键生产代码分别说明调用登记、闭包共享、参数来源、准入和清理的责任；重要测试在实际观察点解释夹具如何建立前提、门闩为何能捕获过早返回、预期值从哪里来，以及怎样排除权限或副作用的假通过。复杂步骤不能只靠段首概述，说明应靠近各自负责的代码；不重复翻译变量和断言，也不写与函数无关的设计辩论。

正常排版的整合候选为生产+1313/−584，共1897行、净增729行；测试+5551/−818，共6369行、净增4733行，文档另列。统计对照真实共同基线，不先格式化基线，也不将测试计入生产预算。测试保留正常换行，复用夹具和组合场景减少重复；不通过压行减少统计数字。隔离候选按上述逻辑块口径得到 E=4766、C=834（17.50%），严格门槛为715条；生产 E=774/C=214，测试 E=3992/C=620。文件概述、旧代码旁补字、重复说明和仅导入说明不计入 C。最终实施后重新统计，中文解释按实际有效修改核算。

### 常用组合能力的选择

保留当前 all、allSettled、race、for-await 和 sleep。八许可已经在宿主入口统一生效，另加 mapLimit 或 Promise.all 自动分批会重复并发策略，也可能改变脚本的启动顺序；这一需求由现有入口完成。

路径继续使用工具返回的完整 path 和原工具参数。跨平台 path.join/dirname 需要明确采用哪种平台语义，不能因为一段建议示例就让同一字符串在不同宿主下改变含义。当前没有缺失 Promise.any 导致原任务失败的复现，先把已使用组合器修正完整。

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
bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts test/tool/execute-environments.test.ts test/tool/registry.test.ts test/session/execute.test.ts test/mcp/catalog.test.ts test/tool/truncation.test.ts
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
