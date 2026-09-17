# VS Code 复用现有 LSP 注册机制

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 本会话LSP统一受控要求及2026-09-17完整workflow授权
>
> Implementation allowed: verified; commit task files only
>
> Last updated: 2026-09-17

## 1. 需求

> 那请你检查如何把相应的 VS Code 插件这种等等内容去挂载到相应的这个语言服务器的机制里面，而不要去进行独立外拆。也就是说让相应的这个 LSP 的整体的这么一个模块去管住 VS Code，而不要让 Open Code 直接去管这个机制。

配置省略或 `lsp: false` 时关闭整个 OpenCode LSP 功能。`touchFile` 和各项查询不自行读取开关；VS Code 相关能力复用现有 LSP 注册、选择、调用和生命周期机制。保留现有配置schema，不建设unified层。优先移动、删除和复用；生产实质新增/修改上限400行，移动和删除分别统计。本阶段仅在Testing验证原型，不实施生产修改。

## 2. 非目标

不改变 Notebook 功能、VS Code 用户设置、现有 HTTP 协议或用户自行使用 VS Code 的语言功能。不启动或结束用户的 VS Code 进程。不添加自动启用、额外配置开关、自动重试、诊断失败后换后端、通用插件框架或额外边界场景。

## 3. 仓库约束

遵循根及 packages/opencode 的 AGENTS.md、CONTEXT.md、first-principles-engineering policy。配置和资源按 Instance 管理；Session 表达使用关系。复用 InstanceState、现有 Session claim 和释放流程，不另建平行注册表。ADR 索引未包含决定本次连接接入方式的记录。

## 4. 代码证据

| 文件 | 已核对内容 |
|---|---|
| `packages/opencode/src/config/config.ts:230` | 省略或false关闭，true/对象启用；Config.get按Instance返回合并配置 |
| `packages/opencode/src/config/lsp.ts` | 既有布尔/服务器配置结构；disabled条目与自定义进程配置 |
| `packages/opencode/src/lsp/server.ts:27` | Handle必须包含ChildProcess；Info声明id、extensions、root、spawn |
| `packages/opencode/src/lsp/client.ts:586` | 原生client暴露connection、文档同步、诊断等待与缓存；shutdown结束所属进程 |
| `packages/opencode/src/lsp/lsp.ts` | 开关只作用于内置servers；bridge有独立发现、调用、状态、claim和诊断快照路径 |
| `packages/opencode/src/effect/instance-state.ts` | 按目录缓存、随Instance释放失效 |
| `packages/opencode/src/ide/vscode-bridge.ts:186` | 公共HTTP传输、工作区匹配及发现缓存，Notebook也使用该模块 |
| `sdks/vscode/src/lsp.ts` | touch隐藏打开文档；800ms观察；hover/definition等现有能力 |
| `packages/opencode/src/tool/{edit,write,apply_patch,lsp}.ts` | 调用LSP.Service；编辑工具用diagnostics与status生成输出 |
| `packages/opencode/test/lsp/{index,lifecycle,client}.test.ts` | 内置禁用、bridge调用、诊断失败、共享client生命周期等既有行为测试 |
| `.temp/testing/lsp-registration/` | 三个模块的实验副本、原始客户端回归副本、真实宿主及差异统计；原生产文件未修改 |

## 5. 当前路径

```text
编辑工具 / LSP工具 -> LSP.Service
  内置路径 -> servers -> getClients -> spawn -> LSPClient
  VS Code路径 -> 各方法直接resolveBridge/callBridge -> VS Code HTTP
```

`lsp.ts:190`只清空内置服务器。`touchFile`、`status`、`hasClients`、hover、definition、references、documentSymbol、workspaceSymbol另行发现bridge。因此统一接口存在，但统一启停和资源管理尚未成立。

## 6. 支持域

只覆盖现有本地文件、现有配置类型、内置/自定义stdio服务器和现有VS Code HTTP能力。bridge已知支持touch/diagnostics、hover、definition、references、documentSymbol、workspaceSymbol；implementation和call hierarchy目前由原生客户端提供，不假设VS Code HTTP支持它们。

## 7. 不变量

| ID | 行为 |
|---|---|
| L1 | false/省略时，LSP调用不会发现或请求bridge、启动语言服务器或打开文档 |
| L2 | VS Code与内置服务器从同一配置筛选后的注册集合取得，方法本体不再独立选择bridge |
| L3 | 开启时保留现有语言能力；操作执行前选择支持该能力的连接 |
| L4 | status、hasClients、touch和diagnostics使用同一组注册及连接事实，关闭时不报告连接或检查成功 |
| L5 | Session共享和Instance释放复用现有管理；释放外部连接只释放本地引用，不关闭VS Code |
| L6 | 诊断失败保持不可用，不能返回检查成功或执行失败后切换另一后端 |

## 8. 首次分歧与实测

首次分歧在注册管理：配置仅筛选stdio定义，VS Code能力不进入被筛选的集合。随后各查询方法直接发现bridge，把“外部bridge存在”当作可以使用LSP的依据。

已运行：

```text
cwd: packages/opencode
bun test F:\ML\PythonAIProject\Claude-Code\opencode\.temp\testing\lsp-provider-registration.test.ts
0 pass / 2 fail / 2 assertions
Expected number of calls: 0
Received number of calls: 1
```

两个用例分别设置false与省略配置，通过真实LSP.Service调用touchFile(document)，观察到了不应发生的bridge调用。随后在Testing构建最小接入原型：7项行为测试通过；原client.test.ts只重定向import至原型，12项原断言全部通过，合计19 pass/0 fail/50 assertions。原型类型检查通过。

VS Code 1.138.0隔离宿主结果见host-results.json：false和省略配置均opened=false、HTTP调用0、status为空；启用后的light warm仍不开文档且无HTTP调用；strong touch产生一次POST /lsp/touch、opened=true并返回Error诊断。诊断来自实验扩展的DiagnosticCollection，证明真实文档事件及传输路径，不等同于真实编译器诊断。初次TypeScript隐藏文档预热20秒未发布诊断，日志保留在profile目录；后续一次宿主复跑被中断，不作通过证据。

## 9. 职责

| 内容 | Owner |
|---|---|
| 读取启用配置、筛选服务器、选取连接、Session使用关系 | LSP模块的Instance级注册管理 |
| stdio启动、初始化、文档协议和进程退出 | 现有server/client实现 |
| bridge发现、既有LSP请求与HTTP操作转换 | server.ts中的VS Code注册项及私有接入函数 |
| 通用bridge传输与工作区匹配 | 既有ide/vscode-bridge模块，继续服务Notebook等调用者 |
| 打开VS Code文档及调用语言扩展 | 既有SDK端lsp.ts |

## 10. 主路径调整

```text
Config.get（原配置schema）
    -> 原servers注册集合（包含vscode项）
    -> 原getClients / LSPClient.create
    -> 原LSP请求、诊断缓存及Session生命周期
    -> vscode注册项将请求转交既有HTTP接口
```

1. 在server.ts按现有Info定义增加vscode注册项。root使用现有bridge发现确认当前工作区可连接；spawn返回本地协议接入句柄。原LSP.state在false/省略时跳过全部服务器注册，关闭不需要新增配置判断；现有对象配置的`vscode: { disabled: true }`直接生效，配置schema不变。
2. 仅将内部Handle扩为“进程句柄或现成MessageConnection及本地释放函数”。保留LSPClient.create的原初始化、文档同步、pull/push诊断和查询实现，只在连接创建、进程日志、PID和释放四处识别句柄来源。
3. 私有接入函数使用现有vscode-jsonrpc库和两条内存流，提供真实MessageConnection。处理initialize、已有五类查询和textDocument/diagnostic，转交现有HTTP路径；诊断返回标准pull报告进入原缓存。初始化只声明实际提供的能力，不伪造进程、不建立新管理框架、不新增SDK端协议。
4. 删除独立bridge选择分支及bridgeOwners/bridgeSnapshot；保留原getClients/run/runAll、Session claim和退出清理。诊断有效性属于LSP模块：原客户端等待函数返回实际取得pull报告/匹配push的布尔值，等待到期返回false；strong touch汇总参与连接的结果，以通用diagnosticsFailed记录没有可用结果或任一失败。失败时status不向现有编辑工具提供“已检查”信号；成功空报告仍有效。此事实不再限定于bridge，避免存活但没有诊断的stdio连接掩盖HTTP失败。
5. 沿用现有多服务器遍历和结果聚合规则，取消bridge的独立抢占路径。启用哪些注册项由现有配置决定；原生独有操作仍经原连接处理。不增加一套优先级机制或失败后的后端切换。
6. 对外部句柄监听MessageConnection的dispose，复用removeExitedClient。HTTP请求失败时关闭本地连接并保留失败，不继续报告已连接。释放Session只释放内存流和本地引用，真实宿主仍可访问；stdio继续结束所属进程。
7. light warm只发送到本地连接，不转交HTTP打开文档；strong touch通过已有pull诊断请求进入SDK。SDK仍用800ms观察，HTTP调用仍为1秒；整个等待沿用原LSPClient，失败实验约5秒，不能宣称保持旧bridge整段1秒上限。
8. 冷启动workspaceSymbol也走getClients：以Instance目录获取已有Info.global标记的注册项，再复用runAll。VS Code注册项标global=true，不启动需要具体文件才能匹配的内置服务器；无需预先touch文件，关闭配置仍为空集合。
9. SDK的SymbolKind从0计数，LSP从1计数；私有协议接入在documentSymbol/workspaceSymbol返回前将kind加1，其他已传出字段保留。用真实VS Code Class=4验证转为LSP Class=5，不能让原生kind过滤器丢掉类符号。

配置跟随既有Instance释放/重建生效，不增加配置轮询。只有语言能力连接纳入管理；共用的VS Code HTTP服务及Notebook调用不随LSP关闭而停止。

## 11. 路径分类

| 路径 | 分类 | 处理 |
|---|---|---|
| stdio与已注册VS Code接入 | 原注册集合中的两种句柄来源 | 复用原客户端及多服务器遍历 |
| bridge light warm | 既有公开行为 | 只建立本地使用关系，不打开文档 |
| bridge失败后再查内置 | 当前部分查询中的备用成功路径 | 删除；不增加重试 |
| false/省略 | 配置域中的关闭状态 | 空集合，不激活任何连接 |
| 诊断不可用 | 现有诊断结果 | 保留事实，不生成成功快照 |

不增加额外诊断决策分支，新增备用成功路径为零。

## 12. 删除清单

将必要的HTTP映射并入server.ts的私有接入函数，删除lsp.ts的独立bridge分支、bridgeOwners和专属快照。诊断缓存及释放直接复用client.ts与现有ClientEntry管理，不另造共同连接接口。原型在lsp.ts新增12行、删除167行。

## 13. 正向映射

| 不变量 | 修改 | 验证 |
|---|---|---|
| L1/L2 | state注册集合、统一获取连接 | false与省略；逐项公开操作均无bridge/进程副作用 |
| L3 | 已注册接入句柄及原客户端 | bridge已支持操作、原生客户端原有回归、没有bridge时已启用的原生诊断 |
| L4/L6 | 原等待结果及通用诊断失败事实 | 禁用不报告connected；成功空快照有效；混合连接中安静stdio不能掩盖bridge失败 |
| L5 | ClientEntry及释放接口 | 两Session共享、最后使用者释放、Instance释放；VS Code进程保持运行 |

## 14. 反向映射

| 概念 | 必要性 |
|---|---|
| Handle的MessageConnection分支 | L2/L5：已实测现有客户端可直接复用协议连接；只改变句柄来源 |
| 统一注册集合 | L1/L2：旧servers集合未包含VS Code，开关筛选不完整 |
| 原有多服务器请求机制 | L3：继续允许原生服务器提供HTTP接口未实现的能力，不扩展HTTP协议 |
| 外部连接的本地释放 | L5：OpenCode不拥有VS Code进程，不能沿用Process.stop |

## 15. 文件计划

| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/opencode/src/lsp/server.ts` | modify | vscode注册项及私有协议接入，Handle增加现成连接分支 |
| `packages/opencode/src/lsp/lsp.ts` | modify | 删除bridge旁路和重复状态；复用退出清理与客户端诊断缓存 |
| `packages/opencode/src/lsp/client.ts` | modify | 连接来源和释放四处小调整，原型新增5行/删除4行 |
| `packages/opencode/test/lsp/index.test.ts` | modify | 禁用与注册/能力选择行为；旧bridge用例显式启用LSP |
| `packages/opencode/test/lsp/lifecycle.test.ts` | modify | 共同连接释放；保持Session和外部进程所有权 |

实验确认3个现有生产文件足以承载原型，新增生产文件为0；正式测试预计修改2个现有测试文件，另维护本方案文档。实验adapter.ts仅为原型组织，统计候选已将其合入server.ts并通过类型检查和回归。配置schema、编辑工具、SDK插件、通用HTTP传输和Notebook未改变。

## 16. TDD切片

先以LSP.Service公开接口固定false/省略的红测，再实现共同注册；接着验证开启后的bridge诊断及查询，再验证原生独有能力；最后验证共享与释放。每片先红后绿。原有“省略配置仍调用bridge”的测试应改为显式开启，保留操作断言，并增加独立的禁用断言。假bridge只验证调度；最终用隔离真实宿主验证关闭时不打开文档、开启时产生诊断。

## 17. 注释预算

有效代码和中文解释注释按正式diff复算，C满足ceil(E*0.15)。解释限于现有注册启停、真实进程所有权和协议接入。实验代码尚未按生产注释要求补齐；新增注释及正式回归纳入最终统计。

## 18. 验证

全部命令在packages/opencode运行：

- `bun test test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/lsp/client.test.ts`
- B-01对应的编辑工具回归在`test/lsp/index.test.ts`通过真实LSP服务执行混合连接，再调用现有编辑工具消费的diagnostics/status接口，断言无诊断时status为空；同时运行`bun test test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts`中现有诊断相关用例。
- `bun typecheck`
- 仅对受影响编辑工具的现有诊断用例做定向回归，不跑无关全套。
- Testing隔离扩展宿主：关闭时修改文件不触发OpenCode的文档打开；开启时诊断正常；释放Session不结束VS Code。

## 19. 修改预算

生产实质新增/修改上限400行，移动和删除单列，不将400误作普通diff总行数。当前候选按正常格式统计：

| 文件 | 新增 | 删除 |
|---|---:|---:|
| client.ts | 15 | 13 |
| server.ts | 126 | 4 |
| lsp.ts | 29 | 185 |
| 合计 | 170 | 202 |

所有新增均保守计入实质新增上界，不扣除搬迁，生产候选170行新增、202行删除。正式测试与配置也单列实质修改，完整实施有效新增/修改目标控制在400行内；不能通过转移到测试规避预算。数值仅对应实验候选，正式注释和验证代码仍需统计。

## 20. 风险与范围

需保留的实际差异只有stdio/HTTP所有权、现有能力集合和结果表示；在适配器内解决。禁用OpenCode LSP不会禁止用户自己在VS Code里打开文件。跨平台、远程窗口和未出现的异常组合不驱动额外修改。无须用户裁定的新产品开关。

## 21. 审计要求

审查完整L1至L6和实际调用链，特别确认不存在各方法自行读取开关或独立发现bridge的旁路。核对原生能力保留、外部进程所有权、无失败后换后端、测试行为及注释预算。此计划尚未审计，不授权实施。

## 22. 方案审计记录

R1：`ses_f51fb53e2ffewrLxuY1paP7hbx`，全范围。

> **BLOCK — `docs/plans/lsp-vscode-unified-registration.md`，R1。**

- B-01：混合连接中，失败bridge被移除后，安静stdio仍存活会导致误报检查成功。
- B-02：冷启动CLI workspaceSymbol没有预热，runAll空集合直接返回空。
- B-03：VS Code零起始SymbolKind未转换，进入原生过滤器后丢失类符号。

三项均以原型新回归复现：符号kind 4≠5、冷查询返回空、混合失败仍返回fake连接。R2在原等待结果、注册连接获取及协议转换三个owner修复，原型21 pass/54 assertions，类型检查通过。完整范围待复审。

R2：`ses_f51f1ddcbffeUCGQ3UucAtzOhF`，全范围。

> No blocking findings.
>
> **APPROVE — `docs/plans/lsp-vscode-unified-registration.md`，R2，全范围方案审计。**

Non-blocking：正式实现须验证操作前能力选择，原型不能替代该契约；实验统计的历史19项与最新21项及client变更量应区分；编辑工具验证应按诊断测试名称筛选。正式实施须核算生产、测试和配置的实质修改及中文注释比例。

## 23. 实施证据

正式实施修改3个生产文件（lsp.ts/client.ts/server.ts）、2个测试文件（index.test.ts/lifecycle.test.ts），无新增生产文件、schema变更或依赖。此前Testing候选仅为原型证据，最终验证使用实际生产模块。

| 验证 | 命令及结果 |
|---|---|
| 原始red | false/省略配置均观察到错误bridge调用，2 fail；原型补充3项审计问题均先失败再通过 |
| LSP回归 | `bun test test/lsp/index.test.ts test/lsp/client.test.ts test/lsp/lifecycle.test.ts`：65 pass、0 fail、138 assertions，39.54秒 |
| 编辑工具诊断回归 | `bun test test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts -t "diagnostic\|LSP\|lsp"`：4 pass、0 fail、8 assertions；192个无关用例被名称过滤 |
| 类型 | cwd packages/opencode，`bun typecheck`通过 |
| 实际扩展宿主 | VS Code1.138.0，production-profile：false/unset均无HTTP且不开文档；warm建立本地连接但不开文档；strong仅1次/lsp/touch并打开文档取得诊断；4子进程测试均通过 |
| 生命周期 | 正式lifecycle测试使用真实HTTP监听和registry，两Session共享一个client，最后claim释放后HTTP健康请求仍成功 |
| 能力选择 | 正式index测试取得真实MessageConnection，implementation和call hierarchy在请求前跳过未声明能力，公开sendRequest无调用；原生client原回归保留 |
| 日志 | 宿主启动mutex提示、内置git/TS配置作用域警告、copilotcli关闭警告及DEP0169来自VS Code/内置扩展；控制实验4场景通过 |

主路径：原Config schema筛选server.ts导出项→原getClients→原LSPClient→私有HTTP协议接入。删除方法级bridge分支、bridgeOwners及独立快照；未新增备用成功路径，失败诊断状态由原等待结果汇总。SDK和Notebook未修改。

实际普通diff：生产新增157/删除190，测试新增181/删除15；总新增338/删除205。有效新增/实质修改E=277（生产124，测试153），不扣除潜在搬迁，低于400；C=44，要求ceil(277×0.15)=42。计数排除空行、imports及注释，未通过移动或压缩统计隐藏生产实现。代表注释解释关闭注册、外部进程所有权、符号编号转换、冷查询获取连接及混合诊断有效性。脚本及精确diff位于Testing的measure.ts、implementation.diff。

未验证：真实TypeScript编译器诊断预热曾超时，最终宿主诊断来自受控DiagnosticCollection，不能外推为所有语言服务器正确性；跨平台未运行。无需运行无关全套测试。

## 24. 实现审计记录

第一轮：`ses_f51dd5cd0ffeNF1Nuo2WnXdT2A`，全范围。

> **BLOCK — R2 对应的当前五文件实现 diff。**

B-01：普通HTTP查询误用1秒诊断预算；已通过参数回归先red，再恢复非诊断查询默认预算。B-02：原生strong diagnostics缺少服务层敏感回归；已加入真实stdio夹具的LSP.Service测试并通过。Testing native-mutation.ts恢复旧提前返回后该测试以诊断undefined失败，caught=true；不修改正式源码进行变异。

返工后65项LSP测试及类型检查通过。Non-blocking：受控宿主不等同于真实编译器，未外推；初轮审计未独立执行测试。待完整范围复审。

第二轮：`ses_f51d381dbffetZYZza3SBuVzwK`，全范围实现复审。

> No blocking findings.
>
> **APPROVE — `docs/plans/lsp-vscode-unified-registration.md` R2，以及 `.temp/testing/lsp-registration/implementation.diff` 对应的当前五文件实现。**
>
> 本结论为全范围实现复审，仅适用于上述精确 diff；不包含无关工作树改动，也未执行提交或推送。

审计员独立执行：LSP回归65 pass/138 assertions；编辑工具诊断定向4 pass/8 assertions；bun typecheck通过。独立复算E277/C44（15.88%），生产+157/-190、测试+181/-15；主路径、fallback及代码质量门禁通过。

Non-blocking findings：真实宿主使用受控DiagnosticCollection，不能外推真实编译器验证；index.test.ts旧light warm注释仍暗示bridge优先语义，当前.repro隔离外部注册项，混合连接另有真实stdio回归。未纳入无关边界修复。
