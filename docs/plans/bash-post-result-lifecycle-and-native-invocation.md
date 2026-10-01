# Canonical Implementation Plan: Bash 执行完成后的正常返回

> Status: verified
>
> Revision: R11
>
> Approved revision: R11
>
> Audit mode: full-scope
>
> Requirement source: 本会话用户原文，见 §1
>
> Implementation allowed: completed; further material changes require revision
>
> Last updated: 2026-10-01
>
> Repository baseline: `378033d16a3662197a264fb3fe96ef2e74a8c5f1`

本文件只保留当前有效需求、证据、单一修改方案和验证门禁。已提交修复是工作基线。历史批准及完整执行记录保存在提交 `45d9daa2ed35f4ebc2acb277860704565c0cf349` 的同路径文档中，不在正文重复展开，也不作为R11实施许可。

## 1. 用户要求

最新主线要求：

> 注意主线任务是调查原有 Bash 调用中“工作已经完成、工具却仍在等待”的原因，并在现有执行链上做最小根修最终要求我最开始给你的相应命令不会再次发生相应的 batch 调用之后 PowerShell 或者相应内容不正常退出或者返回的情况。本质上命令完成了它就应该返回。如果不返回应当就是调用要么调用方式存在问题，要么所有权、管道转移不正常。，不得偏移任务而进行其他无关或者弱关联内容修改。同时请注意测试断言要符合逻辑自然，避免过多增大不必要的或者为了断言而进行的不必要断言；同时整体生产代码修改数在5个文件以内，在800行生产代码修改以内，期间不要使用question因为用户不在这里

### 目标

> 我要的是命令正常执行并在执行后进行正确返回而不是阻塞着不动

> 譬如那个命令理论上都运行到了最后一个命令内容且完整运行了，他都不正确进行退出以及把bash交还给主agent

> 我再次声明，我最终的目的并不是让错误或者超时及时抛出。我要的是从根源上就解决这个超时，不该有的超时问题。就譬如说理论上，一个程序或者说一个命令，它已经正常运行完了，同时甚至都已经运行到了最后一个字符嘛。本身而言，这个程序它应该已经去结束了。但是这个 Bash 相应的这么一个工具，它没有正常地去进行相应的返回啊等等机制。那当前而言，你的修改，我不知道它是不是集中在这个错误抛出阶段。那如果集中在这个地方，本身而言修改的方式和修改的方向本身不适合我的这个修改的目标。当然你这些修改是合理的，但是你最终仍然可能没有达到我的一个目的。那与此同时请注意，你也不得以一些其他的这种启发式的方式来分析命令有没有结束。因为本身而言，命令有没有结束应当是一个确定性的、准确性的一个东西。你也不得说，长时间命令不输出，那我们就把它结束掉，这本身是不合理的。所以请你全面检查到底什么情况。那本身而言，按照我的理解，你就譬如说之前模型去调用了一些，比如说 Conda 去运行 Python 啊等等的命令，那本身都已经，命令都已经执行完了，管道都应该已经结束掉了，但是它依然还存在，这本身是不合理的，请你检查。那本身你不得说当前只能保证到这一步。你也不得说这个什么输出 consumer 的这个读取失败，什么及时交付错误。请注意交付错误并不是目的，解决错误才是真正的目的。也就是说，让错误根本就不再发生，也就是解决错误的这个代码生产源。但是解决的方式不得以这个 try catch 的，或者等等的方式，就最好不要以这种方式来进行处理，而是你就找到真正错误的根源。比如说某一行的时序啊等等有问题，或者说某一行这个机制处理不完善，导致相应的这个出现了一条错误路径。所以请检查。那本身我不认为这是完成的。

### 调查范围

> 完整检查相应逻辑，理论上git相关命令本身确实审批，审批本身的耗时不计入；那需要关心的主要是全部完整的内容，看看相应的harness或者prompt（极度克制，如果动的最少最好）需要作何修改能够解决相应的完整问题；类似于这种python的啊，还有相应的包装啊，还有等等内容；全量完整检查，并给出完整准确的修改方案，同时你要写出具体修改方法。同时请注意修改不得违背用户fork的本身的意图，也就是不能以缩短时间来规避掉用户本身期望的审批啊等等的一些流程

初始数据库：`C:/Users/Lenovo/.local/share/opencode/opencode.db`。覆盖最近一至两个月的异常长尾、超时和用户终止记录，区分业务本身仍在运行与工作完成后的错误等待。数据库保持只读，冷数据按需内存解码。

### 实施约束

> 我们目前的内容是一个非这种交互式的，就是一种等待 Bash 命令运行之后，它才会返回给主 Agent 的一个机制。也就是说我们没有打算去增加那些，比如在调用命令之后返回一个可交互的 Bash，允许命令进行等待时或者不等待时的一些操作。

> 不进行提示词的修改，因为你加的内容本质上模型难以理解且容易诱导模型提高复杂度。同时请注意测试断言要符合逻辑自然，避免过多增大不必要的或者为了断言而进行的不必要断言；同时整体生产代码修改数在5个文件以内，在800行生产代码修改以内，期间不要使用question因为用户不在这里

> 注意不要因为审计而增加不必要的复杂度，适当battle；或者调整现有逻辑而不是扩充新逻辑新分支，避免增加复杂度

> 我说过了好几遍了，本质上而言，这个命令正常执行完，bash就结束。你不得是让它写额外去写文件，这本身不是更轻的方法，这本身是更加复杂而且不稳定的方法。我再次声明。

### 最新范围与篇幅要求

> 我没说出现过32位崩溃
> 这不是我的任务的问题
> 重新阅读我的要求和任务

> 整体方案不得超过1200行，不建议超过1000行

> 理论上有问题的或者冗余的或者弃用的内容不需要重复陈述

当前目标为 `verified-implementation`。停止以临时原型自身的故障驱动工作；只调查原有Bash问题。方案按1000行内收敛、1200行封顶，正文不保留逐轮试错日志。本次整理只改文档，生产文件及累计变更账本保持原基线。

执行安排：修改与实验由主agent直接完成，subagent仅用于独立审计；优先少量聚焦用例，避免反复大批量测试。按用户要求以一小时内完成为工作目标；弱关联支线不阻断主任务。

## 2. 核心合同

| ID | 必须保持的行为 | 验证依据 |
| --- | --- | --- |
| INV-01 | 原审批流程完整保留，审批耗时不计入执行预算 | Permission及Shell审批测试 |
| INV-02 | 原生命令、所选shell和同步单结果接口保持 | `cmd`、`psEncoded`及原生输入测试 |
| INV-03 | 命令正常完成后交付真实退出结果与完整输出 | 真实execute反馈环 |
| INV-04 | 完成由实际执行与资源状态决定 | 进程退出、输出完成、资源释放及Tool返回记录 |
| INV-05 | 静默前台、已产生的缓冲输出及通用spawner的late-output保持；Windows PowerShell Bash的完成边界见§6 | core/Shell真实进程测试 |
| INV-06 | 提示词、schema与组装保持原样 | 实际diff及shell-prompt回归 |
| INV-07 | 修复错误首次发生的位置，优先调整现有逻辑 | producer到consumer的因果证据 |
| INV-08 | 全量调查保留分类与证据边界 | 历史调用索引及逐例结论 |
| INV-09 | 变更精简、断言自然、独立审计通过后交付 | 累计diff、行为测试、审计verdict |

正常返回的验收结果是普通成功或真实非零退出；timeout、abort和强制结束只属于取消语义。保持一个同步Bash，不增加后台交互接口或额外文件捕获。

## 3. 仓库依据与当前执行链

适用依据：根与package `AGENTS.md`、`CONTEXT.md`、`.opencode/policy/first-principles-engineering.md`、`.opencode/templates/canonical-plan.md`。现有ADR没有另立Shell完成合同。

```text
Agent原始命令
  -> Snapshot / 插件 / Permission
  -> ShellTool.run
  -> cmd / psEncoded
  -> CrossSpawnSpawner
  -> configured shell / 用户程序
  -> exitCode + stdout/stderr消费
  -> decoder / progress / truncation / scope释放
  -> Tool结果与Session终态
```

| 当前源码 | 职责与检查位置 |
| --- | --- |
| `packages/opencode/src/tool/shell.ts:427` | shell参数、stdin、detached及原生命令包装 |
| `packages/opencode/src/tool/shell.ts:470` | UTF-16LE传输、编码、退出码和PowerShell流重定向 |
| `packages/opencode/src/tool/shell.ts:788` | 子进程环境及插件覆盖 |
| `packages/opencode/src/tool/shell.ts:913` | 实际spawn、输出消费和完成竞争 |
| `packages/core/src/cross-spawn-spawner.ts:240` | source、tap、eager buffering与scope所有权 |
| `packages/core/src/cross-spawn-spawner.ts:298` | 进程exit与stdio close信号 |
| `packages/core/src/cross-spawn-spawner.ts:412` | 实际spawn选项和进程释放 |
| `packages/opencode/src/tool/progress.ts` | 增量更新及终态flush |
| `packages/opencode/src/session/prompt.ts`、`processor.ts` | Tool取消、结果持久化与Session终态 |

共享spawner还服务AppProcess、MCP、ripgrep和direct shell；对公共适配器的修改须覆盖这些实际消费者。

## 4. 已完成调查

### 历史覆盖

调查窗口为北京时间2026-07-29至2026-09-29：109,686条Bash Part，101,939次唯一调用。详细分类覆盖8,102次调用，包括全部错误、取消、时长前5%与此前候选。

| 分类 | 数量或结果 |
| --- | --- |
| error记录 | 1,520 |
| 取消或stream-ended | 540 |
| 已辨识最终输出或启动确认后持续等待 | 40 |
| 上述40条中由取消结束 | 22 |
| Conda词法相关调用 | 2,032，异常153条逐条分类 |
| 实际`conda run` | 60次：58次exit0，2次明确COM错误；最大30.846秒 |

索引与逐例材料位于`D:/Temp/opencode/bash-longtail-*`、`post-result-tail-cases.json`、`post-result-final-case-table.md`、`conda-historical-*`。这些是历史分类证据；新增根修须由对应真实执行路径验证。

### 已提交基线

提交：`45d9daa2ed35f4ebc2acb277860704565c0cf349`，`fix(shell): 修复命令结束后的生命周期挂起`。

| 已交付行为 | 位置 | 原因 |
| --- | --- | --- |
| 普通Shell复用`sanitizedProcessEnv()` | `packages/opencode/src/tool/shell.ts` | 避免继承内部worker身份后把有限CLI启动成常驻服务 |
| destroyed owner停止下一轮streaming | `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 避免清理后重新创建worker，导致最终输出后进程仍存活 |
| 完整调用监督及capture资源释放 | `shell.ts`与`cross-spawn-spawner.ts` | 保持取消/deadline覆盖和scope资源所有权 |

前两项有自然退出的根因红绿证据；第三项是生命周期安全基线。新增截图问题仍需单独根修。

R4独立验证为500 pass、15 skip、0 fail，两包typecheck及closure通过，隔离安装和build记录通过。生产3文件、118变更行；六个源码/测试文件的E=518、C=85。完整审计原文见上述提交中的同路径§29，task `ses_f16001a07ffeRBBxLv3zWfGiv3`。这些是历史结果，本轮文档整理未重跑测试。

## 5. 当前未解决的真实案例

### 截图调用

Part：`prt_0f1eca3700016UIn4f7HfJ37D0`。原调用用`Start-Process`启动PowerShell部署脚本，stdout/stderr分别重定向到用户指定日志，参数含`-WindowStyle Hidden -PassThru`，随后打印启动PID。

截图命令原文（仅记录，不重放部署）：

```powershell
$log="D:\Temp\opencode\deploy_out.txt"; $err="D:\Temp\opencode\deploy_err.txt"; Remove-Item $log,$err -ErrorAction SilentlyContinue; $p=Start-Process -FilePath "powershell" -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','H:\Hyper\FRCheck\scripts\deploy.ps1' -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden -PassThru; "started deploy PID=$($p.Id)"
```

截图输出为`started deploy PID=15136`。调用目标是启动后台部署；命令没有`-Wait`。

| 记录 | 值 |
| --- | --- |
| 输入timeout | 30000ms |
| 最终状态 | completed / exit0 |
| metadata.durationMs | 651832ms |
| notice.elapsed_ms | 651831ms |

数据库没有该次独立的root-exit、EOF和deadline阶段时间。调查未重放用户部署。当前源码与当时运行产物的对应关系仍需保留在归因中，审批差值单独处理。

### 同形有限复现

`D:/Temp/opencode/launch-hidden-observe.mjs`与`launch-hidden-child.ps1`保留启动参数，只将业务替换为Sleep4有限子程序。Bun/Node、pwsh/Windows PowerShell及有无Harness包装的组合均出现：启动确认约0.4–0.7秒，外层进程随后exit0，输出EOF约4.8–5.0秒。

已执行反馈命令，cwd=`D:/Temp/opencode`：

```powershell
node D:/Temp/opencode/launch-hidden-observe.mjs
bun D:/Temp/opencode/launch-hidden-observe.mjs
```

此复现定位了一个实际等待：后台进程在自身输出重定向后，仍额外继承了捕获管道的写端，延长EOF。PowerShell v7.6.6源提交`f260eb9c31ec72c5282f98e5ea24d9be4f8d7536`的`Process.cs`中，标准句柄设置与`CreateProcess(..., bInheritHandles: true, ...)`对应这一机制。它是同形复现的因果证据，不替代截图全部历史阶段的记录。

当前源码的真实ShellTool正常完成对照见`D:/Temp/opencode/current-shell-normal-20261001-a.test.ts`及`current-shell-normal-1790840236153-8536-{hidden,simple}.json`：两例正常exit0、无kill/timeout。Hidden案例root退出至Tool返回4548.9841ms，其中等待原生EOF为4543.8056ms；public EOF至Tool返回3.8940ms。普通输出案例root退出后0.5993ms返回。该对照使用立即完成的metadata记录回调，未覆盖真实Session持久化延迟；当前已定位的长尾发生在输出管道等待，而非此对照中的scope释放。

## 6. 当前修复工作与责任边界

### 完成边界及行为变化

R11提议将Windows PowerShell Bash的捕获寿命绑定到本次前台shell：真实进程退出后结算本地在途读取、排空已经产生的输出，然后返回。后台任务按原命令独立运行；截图中的两个后台日志保持正常。通用spawner、其他shell和其他consumer仍使用原EOF合同。

该提议修正Harness将一次前台启动调用的完成绑定到后代所有写端寿命的责任边界，**不声称修复PowerShell内部的句柄继承实现**。输出最后一行、静默时间、timeout和后代PID都不参与完成判定。

明确的兼容影响：Windows PowerShell Bash以往会继续收集root退出后后代未来写入的字节；R11在完成排空后结束本次捕获，这些未来字节不进入已完成结果，继续写向该管道的后台程序可能收到broken-pipe。此项属于实质行为变化，须由独立方案审计依据§1完整用户要求判断，不能当成无语义变化的内部重构。已产生的输出必须完整交付；其他consumer的未来输出合同保持。

### 精确接入

1. 在`windows-shell-output.ts`使用模块私有WeakSet标记由ShellTool创建的Windows PowerShell `StandardCommand`；不增加public schema、配置或命令字符串检测。
2. core对已标记命令创建两条内存named pipe，读取端由Harness通过OVERLAPPED I/O拥有；写端用现有`node:fs.openSync(name, O_WRONLY)`取得与运行时兼容的fd。
3. 继续调用原`cross-spawn`，保留可执行文件、argv、cwd、env、stdin、进程信号和终止路径，只将stdout/stderr fd传给原启动器。启动完成后关闭父进程写端。没有第二个launcher、DLL注入或输出文件。
4. `setupOutput`接收拥有的两条Readable，沿用eager tap、decoder、progress及输出压缩。生产代码不篡改ChildProcess对象；临时试验的对象属性替换只验证接入机制。
5. 原root `exit`事件保持真实exitCode，同时触发owned capture的`finish`。成功结果仍沿Shell现有`exitCode + output`完成竞争，故不是提前中断既有output fiber。

### 排空与资源算法

- 每个pipe最多一个owned OVERLAPPED读取，使用独立buffer/event；复制结果后才复用buffer。Readable背压决定继续提交读取，root退出观察独立于消费速度。
- `finish`先停止新的一般读取，对本模块仍pending的读取调用`CancelIoEx`，等待每个操作真正settled。已经完成的读取结果继续交付；取消请求不代表可以释放其buffer。
- 在所有在途操作settled后，对两个pipe各做一次`PeekNamedPipe`，冻结各自剩余字节数；之后只读固定额度，不重新peek、不等未来写端关闭。两者冻结前不进行下一轮额度排空。
- 排空结束后Readable正常结束，既有Tool消费完所有缓冲再返回。EOF早于root时仍由真实exitCode保持等待；正常非零退出码原样交付。
- capture scope先于process scope取得，后于process finalizer释放。取消或失败沿原进程终止流程；owned close停止提交、取消并等待本地pending读取，再关闭fd/handle/event及FFI library。清理必须幂等，并保持原始失败，不转为正常成功。
- `bun:ffi`仅在标记域lazy import；未标记Node/POSIX消费图不会加载它。Win64数据结构使用Windows x64/ARM64公共ABI，32位子程序仍由原启动器启动，不存在子进程注入。
- marked handle的ref/unref要同步控制本地I/O轮询timer，保证原handle合同；使用可ref/unref的现有Node timer机制，轮询只检查真实I/O完成，不作超时猜测。

| 责任 | 当前owner | 需要证明的事实 |
| --- | --- | --- |
| 启动参数、包装及环境 | ShellTool | 是否在进入用户程序前引入额外等待或错误资源归属 |
| 原始进程与捕获流 | CrossSpawnSpawner及owned output模块 | root退出、settle、固定排空、缓冲消费与释放的次序 |
| 用户命令创建的进程与资源 | 原生命令及对应资源API | 哪个引用延长完成，是否属于本次调用的合法输出责任 |
| 最终结果交付 | ToolProgress / Session | 输出完成后是否仍有持久化或终态等待 |

## 7. 需求与改动追溯

| 需求 | 生产路径 | 文件/测试安排 |
| --- | --- | --- |
| 正常完成后返回 | Shell→marked spawner→owned output→Tool | §6单一路径；真实execute回归 |
| 启动后台任务后正确返回 | 原命令启动与输出归属 | 同形Start-Process有限夹具，验证返回与后台正常工作的顺序 |
| 前台输出完整、静默运行正确 | capture与completion | 现有core/Shell测试及必要的真实输出断言 |
| 审批与执行预算 | Permission→run | 沿用审批门禁测试 |
| 原生命令与零prompt变更 | cmd/psEncoded/schema | native-input与shell-prompt回归、实际diff |
| 共享consumer兼容 | core适配器 | AppProcess、MCP、ripgrep、direct shell回归 |
| 全量调查准确 | 数据库分类及对应复现 | 保留逐例证据，不用单一案例概括所有长尾 |

| 新增概念 | 必要性及复用边界 |
| --- | --- |
| 私有command标记 | 只改变本Tool的WinPS捕获寿命，避免改变共享spawner其他consumer |
| owned内存pipe | Bun内部在途I/O不由本scope拥有，直接取消可能丢缓冲；原spawn仍可接受fd，无需重写启动器 |
| settle与一次排空额度 | 已产生输出完整且结束不依赖后台未来写入，分别对应INV-03/04 |
| close/ref/unref | 沿用scope和公开handle的资源、进程存活合同 |

仅在原支持域中选择确定的capture实现；不在读取失败后换backend。标记域原有opaque pipe创建被owned pipe替换，旧tap与结果流程复用；零新增alternate-success路径。

### 文件与预算

| 文件 | 改动 | 预计新增+删除行 |
| --- | --- | ---: |
| `packages/core/src/windows-shell-output.ts` | 新增；标记、owned pipe、正常排空、释放/ref | 250–340 |
| `packages/core/src/cross-spawn-spawner.ts` | 修改；capture取得、stdio fd、exit通知、source传递、ref联动 | 50–90 |
| `packages/opencode/src/tool/shell.ts` | 修改；仅标记既有WinPS命令 | 5–12 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 保留已提交内容 | 新增0 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | 修改；完整字节/晚订阅/释放与未标记兼容 | 测试不计生产预算 |
| `packages/opencode/test/tool/shell.test.ts` | 修改；截图启动、正常返回及既有行为变化 | 测试不计生产预算 |

与R4累计为4个生产文件、约423–560行，包含正常格式与中文解释。新增有效代码/测试E预计350–520，合格邻近中文说明C预计55–85；最终按实际累计diff重新计数。

### 已执行的聚焦反馈

主agent执行的当前源码红测：`bun test --preload ./test/preload.ts D:/Temp/opencode/current-shell-normal-20261001-a.test.ts --test-name-pattern 'current normal ShellTool completion: hidden' --timeout 20000`，cwd=`packages/opencode`，DB=`:memory:`。1 fail，5断言：Tool返回时后台已退出，期望仍存活；证据`current-shell-normal-screenshot-1790841050392-5976-hidden.json`。

同命令仅TEMP capture试验开启`CURRENT_SHELL_PIPE_PROBE=1`：1 pass，root退出后10.39ms返回，后台仍活且后来完整写出双日志；证据`current-shell-normal-screenshot-1790841611801-37880-hidden.json`。原命令正文、现有spawn与真实ShellTool保持；此结果不是生产green。

`bun D:/Temp/opencode/current-shell-pipes-check.ts`通过两例：双流各2097152字节慢消费完整；root退出后才订阅的双流各16384字节完整，退出码17保留。试验模块`current-shell-pipes.ts`为139行未交付原型，生产还须完成scope错误路径、ref、正常格式与解释注释。

## 8. TDD与验证

公开seam使用`ShellTool.execute`和`ChildProcessSpawner.spawn`。测试以真实退出、完整字节及调用返回为结果；ready/release只建立必要的因果顺序，watchdog只负责测试失败清理。将截图red转换为仓库公开seam测试，先red再实现；后台夹具用显式release保持存活，Tool返回后才放行，避免以短时间阈值代替因果断言。

| 顺序 | 行为 | 通过条件 |
| --- | --- | --- |
| 1 | 同形短命令的异常长尾 | 旧实现捕获原症状，修后自然返回真实结果 |
| 2 | 已产生输出完整交付 | stdout/stderr内容完整，无提前截断 |
| 3 | 静默前台、late subscription与未标记late output | 真实工作结束才完成，已产生字节完整；通用consumer保留原EOF合同 |
| 4 | 审批、非零退出、取消 | 原流程及语义保持 |
| 5 | 共享消费者与既有R4根修 | 对应package回归通过 |

现有`shell.test.ts:2237`真实WinPS post-root三mode夹具与新完成边界冲突：WinPS部分改为验证前台结束后正常返回，后台使用自身日志继续完成；POSIX及公开fake handle的post-root错误/取消监督保留。明确记录断言变化依据为§1正常完成返回要求及§6行为变化，不能声称原late-output语义全部保持。core未标记late-output断言保持。

新增scope失败/取消用例只覆盖真实pending读取和创建资源的释放；验证spawn失败、消费者提前停止、两次并发调用隔离。新增compiled小型consumer验证lazy `bun:ffi`和系统DLL解析，再执行受影响的package回归及typecheck。测试由主agent运行，auditor只审计证据和代码。

批准并实施后按影响面运行：

| 命令 | cwd |
| --- | --- |
| `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | `packages/opencode` |
| `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | `packages/core` |
| `bun test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp test/plugin/trigger.test.ts --timeout 30000` | `packages/opencode` |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts test/cli/tui/scroll-layout.test.ts --timeout 30000` | 隔离patched安装的`packages/opencode` |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` |
| `bun typecheck` | `packages/core`、`packages/opencode`分别执行 |
| `bun run script/verify-opentui-closure.ts` | 隔离工作区的`packages/opencode` |
| `bun run script/build.ts --single --skip-install --skip-embed-web-ui` | 隔离工作区的`packages/opencode` |

构建环境删除`OPENCODE_RELEASE`并隔离数据、配置和临时目录，不发布或替换live产物。测试失败保留原始结果，先核对与实际变更的关系，再决定修正范围。

## 9. 预算与审计

| 项目 | 当前值或门禁 |
| --- | --- |
| 方案篇幅 | 目标1000行以内，硬上限1200行；只保留有效内容 |
| 已提交生产基线 | 3文件、118变更行 |
| 当前累计生产变更 | 4文件、417新增+删除行，详见§12 |
| 累计生产预算 | 最多5文件、800变更行，从原始基线累计核算；方案文档篇幅另按1000/1200行限制 |
| 中文解释注释 | E=0时C=0；否则C≥max(1, ceil(E×0.15)) |
| 当前批准 | R11完整独立方案及实现审计通过，原样verdict见§11、§13 |

E排除空行、import-only、formatter-only、generated和pure-move；人工实现及模板内生产逻辑如实计入相应预算。C只计邻近修改点、解释真实约束和测试意图的有效中文注释。

放行顺序：当前证据与具体单一路径完整→`audit-required`→独立全范围方案批准→TDD实施→原始反馈环及回归→独立全范围实现批准→`verified`。

独立方案审计handoff只提供原始需求、此路径、仓库root和审计模式；实现审计另附批准revision与实际diff。verdict原样记录，材料性修改递增revision并清空批准。审计发现须先核对实际需求、影响路径及引入关系，避免扩张范围。

## 10. 验收状态

- R11独立全范围实现审计通过，源码与隔离构建完成验证。
- 截图历史运行产物及阶段时间的对应性，作为历史归因边界单独记录。

完成标准保持用户原目标：命令正常执行完后，Bash正确结束并将完整结果和控制权交还主Agent。

## 11. 独立方案审计

Task: `ses_f097f49b7ffeqTsvwekbn7EvMZ`。R11第一轮全范围审计提出B-01；同轮事实复议后撤回。以下记录复议后的最终verdict原文，未修改批准设计。

## Blocking findings

No blocking findings.

**撤回 B-01。** 独立核对 Git 历史后，该 finding 将本任务中新增的测试假设提升成了用户必须保留的输出合同，依据不足。

- `git blame` 确认 `packages/opencode/test/tool/shell.test.ts:2237` 开始的整个 post-root fixture，包括 `LATE_STDOUT/LATE_STDERR` 断言，均由本任务提交 `45d9daa2ed3` 引入。
- 基线 diff 确认原实现确实无条件等待 `Fiber.join(output)`；其邻近注释强调缓冲 chunk 和 metadata 的完整消费。这证明原有行为会继续等待 EOF，但不能单凭该行为推出“启动调用结束后，必须继续等待后台未来输出”的独立需求。
- 初始 handoff 已明确要求“这个命令正常执行完，bash就结束”，并指出目标命令只是启动进程。R11 §6 将本次前台调用与后台未来工作分离，同时保留已产生输出的结算、排空和消费，符合该要求。
- 因而，R11 §8 修改本任务中与完成边界冲突的断言，具有需求依据。不能仅因它改变了当前测试，就认定为通过弱化测试掩盖回归。

此结论基于原始要求、当前 R11 和直接核实的 Git 证据；未将本次补充消息视为新的授权。

## Non-blocking findings

- **行为变化仍然存在：** Windows PowerShell Bash 完成排空后，不再收集后台未来写入；继续写原捕获管道的程序可能收到 broken-pipe。R11 已明确披露。它是本次调用完成边界的后果，不再作为 B-01 阻断。
- TEMP capture 的正常返回证据仍只是原型验证。正式接入的失败传播、scope 释放、ref/unref、compiled consumer 和回归必须在实施阶段完成。
- 截图历史 651832ms 的完整阶段归因仍未证实；同形复现已证明当前 EOF 等待。两者不能混同。

## Rejected speculation

- 本任务新增的 late-output fixture，不能自行创设高于原始用户要求的后台未来输出义务。
- 仅凭旧实现等待 EOF，不能要求在修复其错误等待时无条件保留该等待边界。
- 不要求增加命令字符串识别、后台进程分类、额外捕获文件或备用 backend 来满足已撤回的 finding。
- 不将 32 位原型问题、未证实的 Session 持久化延迟或无关工作区变更纳入修复范围。

## Requirement and traceability coverage

本次复议保留上一轮完整审计范围，重新判断了需求与输出合同的关系；当前 canonical 内容仍为同一 R11。

- **正常返回与输出完整性：** 真实 root exit 触发本地 pending I/O 结算和双流固定额度排空；既有 consumer 消费完缓冲后交付结果。没有用最后一行、静默时间或 timeout 判断正常完成。
- **责任与接入：** ShellTool 选择本次调用的捕获寿命；core 拥有 pipe、在途读取及释放。原 launcher、命令正文、退出码、decoder、progress 和结果通路继续复用。
- **保留行为：** 审批先于执行预算；同步单结果接口、原生命令、prompt/schema 保持。未标记 core consumer、其他 shell 和 POSIX 的既有 EOF 行为保持。
- **测试覆盖：** 截图同形用例以“Tool 返回后才放行后台”建立因果顺序；完整字节、静默前台、晚订阅、非零退出、取消、创建失败、提前停止及并发隔离均有验证安排。旧实现能够在核心返回用例上失败。
- **反向追溯：** command 标记用于限制影响域；owned pipe 用于取得可结算的读取所有权；settle、固定排空、close/ref/unref 分别对应输出完整性、确定完成和资源合同。未发现无需求依据的新增生产概念。
- **质量与预算：** 313 行方案及预计累计 4 个生产文件、423–560 行符合限制。计划明确承诺有效中文解释注释达到 15%；实际代码质量、累计变更量和 E/C 留待实现审计核算。

## Primary-path and fallback verdict

**通过方案级门禁。**

R11 在明确输入域内使用一条确定的捕获路径，没有失败后换 backend、catch-and-default success、额外 launcher 或交互式后台接口。

当前证据支持将错误定位于：一次已结束的前台启动调用，其完成仍被后台继承写端的寿命延长。R11 在捕获所有权边界修正这一等待，同时保留已产生数据；无需将其认定为必须另行授权的功能回滚。

## Release verdict

**APPROVE — 仅批准 `docs/plans/bash-post-result-lifecycle-and-native-invocation.md` 的 R11，全范围方案审计。**

B-01 撤回。本次未修改文件、未执行实验或测试。

该 verdict 允许按 R11 进入实施；不构成实现批准。达到 `verified-implementation` 仍须完成计划内红绿验证、回归、构建、实际预算与注释核算，以及独立全范围实现审计。

## 12. R11实施证据

所有修改、实验和测试由primary执行。未修改prompt/schema、审批、SDK或构建配置；共享工作区的冷存储等并行修改保持原样。实现冻结供独立审计。

### 实际路径与文件

`ShellTool.cmd → WindowsShellOutput.mark → 原CrossSpawnSpawner/原cross-spawn → owned内存pipe → 原tap/decoder/progress → 原Tool结果`。未标记路径保持原输出实现；无失败后换backend、额外launcher或文件捕获。原opaque捕获仅在批准的标记域被替换。

| 生产文件，相对原始基线 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/windows-shell-output.ts` | 257 | 0 |
| `packages/core/src/cross-spawn-spawner.ts` | 72 | 22 |
| `packages/opencode/src/tool/shell.ts` | 52 | 38 |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch`（R4保留） | 13 | 0 |

累计4文件454行。测试修改位于既有core spawner及Shell测试；R4 installed-runtime测试内容未变。新模块采用DisposableStack确保部分创建与正常scope释放，poll timer支持ref/unref，错误沿原PlatformError/Readable链传播。

验证后应用户要求做过一轮**纯可读性重构**（不改行为）：全部 Win32 魔法数字改为命名常量（ERROR_IO_PENDING 等）、OVERLAPPED 布局抽为常量、`stopped/closed` 布尔收敛为 `open/draining/closing` 显式阶段、删除永不命中的无效句柄比较。重构后重跑：core spawner 34 pass、Shell 220 pass、两包 typecheck、prettier、编译后 FFI 消费链检查均通过。

### 红绿与验证

| primary实际执行命令 | cwd | 结果 |
| --- | --- | --- |
| `bun test test/tool/shell.test.ts --test-name-pattern 'returns after pwsh launches a redirected background process' --timeout 30000`，生产修改前 | `packages/opencode` | 1 fail：返回时后台done已存在，期望未完成；3断言 |
| `bun test test/tool/shell.test.ts --test-name-pattern 'launches a redirected background process' --timeout 30000`，生产修改后 | `packages/opencode` | 2 pass，10断言；pwsh与Windows PowerShell均先返回，再放行后台完整双日志 |
| `bun test test/tool/shell.test.ts test/tool/shell-prompt.test.ts --timeout 30000` | `packages/opencode` | 248 pass，0 fail，1248断言 |
| `bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts --timeout 30000` | `packages/core` | 55 pass，0 fail，98断言 |
| `bun test test/effect/cross-spawn-spawner.test.ts --test-name-pattern 'owned' --timeout 30000`，最终类型修正后 | `packages/core` | 5 pass，0 fail，9断言 |
| `bun test test/shell/shell.test.ts test/file/ripgrep.test.ts test/mcp test/plugin/trigger.test.ts --timeout 30000` | `packages/opencode` | 70 pass，1 skip，0 fail |
| `bun test test/session/prompt.test.ts --timeout 30000` | `packages/opencode` | 115 pass，14 skip，0 fail，516断言，523.22秒；503为既有reviewer夹具输出 |
| `bun typecheck` | 两个package分别执行 | 均通过 |
| `bun run script/verify-opentui-closure.ts` | `packages/opencode` | 11包闭包及原release身份通过 |
| `bun build --compile --target=bun-windows-x64 --minify --conditions=browser D:/Temp/opencode/current-shell-compiled-check.ts --outfile D:/Temp/opencode/current-shell-compiled-check-final.exe`，随后执行该exe | repo root | 120模块编译通过；真实marked spawner双流为`compiled out`/`compiled err`，exit17保留 |
| 编译consumer的`--unref-owner`模式 | repo root | 输出owned child PID后自然退出；没有生产强制exit |
| `git diff --check -- <本任务路径>` | repo root | 通过 |

重复聚焦用例不累加覆盖数量。当前完整执行的四组suite合计488 pass、15 skip、0 fail。生产反馈测试保持原Start-Process参数组合，将部署替换为受控有限任务，且只有Tool返回后才写release；验收不靠输出文本或短耗时阈值。

保留已纠正的测试问题：初次“缺失命令”夹具会触发cross-spawn原有cmd启动行为，改用现存无效exe验证真正OS创建失败；测试cleanup的Effect.promise回调类型及ExitCode品牌类型已修正。没有改生产退出码、延长测试期限或吞掉失败来通过。

### 计数与验证边界

实际累计diff从原始基线核算，新文件单独计入；排除顶层import-only、空白、纯格式调整及patch envelope，嵌入fixture代码计入E。最终采用独立审计口径E=850、合格C=131，要求128，比例15.41%。解释分布在命令寿命域、OVERLAPPED存活、复制与冻结顺序、资源释放/ref和测试因果关系处。

本轮既验证新增模块的minify/browser-condition消费链，也完成下述完整应用隔离构建。当前工作区旧installed OpenTUI chunk保持原样；隔离安装已应用R4 patch并重新通过runtime测试。代码修改、测试产物与运行中部署分别报告。

R11源码的正常返回已由生产公开seam验证；截图旧记录651832ms的完整阶段及当时产物身份继续单列历史边界。本轮无commit、push或live产物替换。

### 完整应用构建

独立实现审计第一轮提出I-01：需完成批准的完整应用构建；源码、预算和注释门禁通过。Primary确认这是本任务已批准的验证要求，执行后保持源码冻结供完整复审，没有扩大生产改动。

隔离工作区：`D:/Temp/opencode/r11-full-build-4yGgNS/workspace`。由primary运行`bun D:/Temp/opencode/current-shell-full-build.ts`生成独立源文件快照、隔离HOME/XDG/TEMP/cache，剔除发布凭据与内部worker身份；`OPENCODE_RELEASE`缺省，构建明确记录`release:false`。未使用live依赖链接、替换系统CLI或发布产物。

| 命令 | cwd | 结果 |
| --- | --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | 隔离workspace | exit0 |
| `bun run script/build.ts --single --skip-install --skip-embed-web-ui` | 隔离`packages/opencode` | exit0，stderr为空 |
| build内置version smoke | 同上 | `0.0.0-r11-verify`，通过 |
| build内置compiled voice Worker smoke | 同上 | 通过 |
| `bun test test/cli/cmd/tui/opentui-streaming-runtime.test.ts test/cli/tui/scroll-layout.test.ts --timeout 30000` | 同上 | 16 pass，0 fail，105断言 |

直接证据：同根下`report.json`、`install.out/.err`、`build.out/.err`、`runtime-tests.out/.err`。测试总计504 pass、15 skip、0 fail，不重复累加聚焦重跑。

产物：`workspace/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，152631296字节，SHA256=`936bb839365a7ff05c3a0d1ae827d7d2eb89bc6c95eebb498b61f1bafa0de6f3`。相邻`opentui-build.json`记录native及exe身份。

构建前SHA256及构建后`git hash-object --no-filters`核对均证明四个生产文件与工作区一致。独立审计计数采用E=850、合格C=131，要求128，比例15.41%；剔除了一个范围表述不够准确的旧root-exit注释。此计数取代前面的primary保守估计作为最终审计口径。

## 13. 独立实现审计

Task: `ses_f097f49b7ffeqTsvwekbn7EvMZ`；implementation第二轮，full-scope，批准revision R11。以下为最终verdict原文；只更新行政验收状态，生产实现保持冻结。

## Blocking findings

No blocking findings.

**I-01 已解决。** 本次直接检查了隔离构建的 runner、原始输出和退出记录：

- `D:/Temp/opencode/r11-full-build-4yGgNS/report.json` 记录 frozen install、完整应用 build、runtime tests 均 exit0。
- `D:/Temp/opencode/r11-full-build-4yGgNS/build.out` 确认 `release:false`，完整 Windows x64 构建、版本 smoke 和 compiled voice Worker smoke 通过；`build.err` 为空。
- `D:/Temp/opencode/r11-full-build-4yGgNS/runtime-tests.err` 记录 **16 pass、0 fail、105 assertions**。
- 独立通过 `git hash-object --no-filters` 比较全部七个任务源码/测试文件，隔离验证副本与当前工作区逐项一致。
- 直接读取隔离 installed OpenTUI chunk，确认 `!this.isDestroyed` guard 已实际应用。

## Non-blocking findings

- **部署边界保持。** 隔离安装及构建产物已验证；当前工作区旧 installed dependency 和 live 服务未替换。实现批准不意味着运行中的程序已经更新。
- **历史归因边界保持。** 当前同形等待有明确反馈环；截图旧记录 651832ms 的全部阶段和当时产物身份仍未完整确认。
- **注释范围。** `packages/core/src/cross-spawn-spawner.ts:270` 的“不绑定 root exit”只适用于未标记路径。该表述未影响实现，本次继续不计入合格中文注释。
- **验证方式。** 本次审计未执行测试或构建。新增构建门禁依据直接读取的执行产物确认，不表述为 auditor 独立重跑。

## Rejected speculation

- 不恢复已撤回的方案 B-01；后台未来输出截止属于批准 R11 的完成边界。
- 不要求额外后台接口、命令文本识别、静默时间判断、输出文件捕获或备用 backend。
- 不把未证实的 32 位问题、Session 持久化延迟或无关工作区修改纳入本次修复。
- 不因主工作区尚未部署而要求替换 live 产物；验证与部署分别处理。

## Requirement and traceability coverage

本轮保持完整原始范围，复核当前累计 diff、批准 R11、全部任务文件身份及直接影响路径；没有将审计缩减为构建记录检查。

| 范围 | 结论 |
|---|---|
| 正常返回 | root 的真实退出触发 owned capture 结算与固定排空，Tool 等待已捕获输出消费后返回。 |
| 输出完整性 | 在途操作结算、buffer 复制、双流额度冻结及后续消费顺序符合批准算法。 |
| 资源与失败 | capture、process、source/tap 各自所有权明确；错误沿原失败链传播，不转换为正常成功。 |
| 审批和执行预算 | 审批保留且位于执行预算之前；同步单结果接口保持。 |
| 原生命令 | shell、正文、参数、cwd、环境覆盖顺序及真实退出码保持；prompt/schema 未改。 |
| 共享消费者 | 标记限定于 Windows PowerShell ShellTool；未标记消费者继续使用原 EOF 路径。 |
| R4 根修 | 内部身份隔离和 destroyed streaming owner guard 保留；隔离安装验证了实际 patch 消费。 |
| 测试敏感性 | 返回顺序、完整字节、晚订阅、取消、失败释放、并发隔离和自然退出均有对应反馈或回归。 |
| 应用交付 | 当前完整应用构建与 smoke 门禁已补齐，I-01 关闭。 |

## Primary-path and fallback verdict

**通过。**

每项责任保留一个权威执行路径。标记域在启动前选择 owned capture，未标记域保留既有捕获；失败后不会换实现获取成功。

新增 alternate-success 路径为 **0**，新增独立生产 diagnostic 决策面为 **0%**。完成判断不依赖输出文字、静默时间、超时或后台 PID。

## Code quality and Chinese-comment verdict

**通过。**

当前实现文件与上一轮已审查内容一致，累计生产预算为 **4 文件、417 新增＋删除行**，符合限制。

独立累计计数保持：

| 文件 | E | 合格 C |
|---|---:|---:|
| Windows owned output | 179 | 33 |
| Core spawner | 54 | 8 |
| Shell | 26 | 11 |
| Core tests | 154 | 18 |
| Shell tests | 325 | 41 |
| Installed runtime tests | 111 | 19 |
| OpenTUI patch 人工 runtime payload | 1 | 1 |
| **合计** | **850** | **131** |

排除顶层 import-only、空行、纯格式调整及 patch 元数据/上下文；嵌入 fixture 逻辑计入 E，范围不准确的注释不计入 C。

**C/E = 15.41%**，达到 15% 目标。未发现新增类型压制、无用途抽象、重复成功算法或无关生产重构。

## Release verdict

**APPROVE — 批准当前累计七个源码/测试文件的实现 diff，基于批准 R11，full-scope。**

比较基线为 `378033d16a3662197a264fb3fe96ef2e74a8c5f1`，包含未跟踪的 `packages/core/src/windows-shell-output.ts`。批准对象与本轮独立核对的隔离验证副本一致。

当前实现满足 `verified-implementation` 的独立审计条件。Primary 可原样记录本 verdict 后更新 canonical 状态，同时保留历史归因和 live 部署边界。本批准不授权 commit、push、发布或替换运行中产物。
