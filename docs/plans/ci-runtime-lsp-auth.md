# Canonical Implementation Plan: Windows LSP 与 HttpApi auth CI 收尾

> Status: implementation-audit-required
>
> Revision: R19
>
> Approved revision: R19
>
> Audit mode: full-scope
>
> Requirement source: §1 逐字需求、原始 CI 附件与基线修复范围更新
>
> Implementation allowed: no
>
> Last updated: 2026-11-21

此文件是 #11 唯一方案，终态为 `verified-implementation-and-commit`：独立、单提交、质量达到可合并，合并由用户决定。固定 R1 前 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3` 用于定位原 Windows LSP 与 HttpApi Auth 故障；当前交付基线为 `dev1-smark` `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0`，树 `7856a04183fb9aa562da776477c27243f8c9874f`。终态保留真实 Windows LSP 往返与 Auth 原 225 项后自然退出，并修复当前交付基线中已有、在精确 #11 上仍可重现的 PAT 用例隔离缺陷。5bc 已具备原 Auth 修复，候选不改 Auth harness；§15 给出当前基线到终态的完整差分范围。R17 及以前的裁决与回执仍按原身份留档。

## 1. Verbatim Requirement

> 同时请注意一点，相应的Workflow也更新了。要按照新的Workflow，还有新的审计等等来走，请注意这点。

> 也就是把当前仓库全部都变到最新的，然后全部按照最新的路径以及文件来走。

> 同时你还需要去派一个Agent去分析解决这个问题，提一个相应的PR，按照Workflow来走。

> 注意是这两个，也就这两个问题需要一并解决。也就是或者换言之，你直接看，这个新的这个Agent需要做的东西是去检查分析CI中的问题，然后去进行调整和修正，也就是近期CI中出现的这些问题。当然这些问题不包括我们之前提，就是你提交的其他几个PR。

用户两份原始附件独立留存；其校验值与对应官方失败入口如下：
- Windows LSP 原始附件，101 行，SHA-256 `65cda387d52f271a7e520b2934e5cf45ff541f0503bd6860e748d081d02d72ca`；[原 Windows runtime job](https://github.com/SMARK2022/opencode/actions/runs/44608985562/job/135860195310)。
- HttpApi Auth 原始附件，248 行，SHA-256 `5c57195d5c0471619b015f6c52d0bacc5e5353c1e7334ecb2119d7e4c8ab4928`；[原 HttpApi auth job](https://github.com/SMARK2022/opencode/actions/runs/44608985562/job/135860194918)。

接受范围为 Windows runtime 的 LSP workspaceFolders/registerCapability 失败，以及 HttpApi auth 已报告 225/225 成功却未退出。保持零净增测试实例，不增加超时、不跳过检查。

> 要求最终验收的版本是能够被合并的版本，但你不需要去合并。意思是说要求的达到的是质量可以能够满足能够合并的版本。

> 不要大幅度地补各种各样的测试，我再说一遍

> 不得修改gate

> 我还是听不懂什么叫计时器方案，按理来说，我们之前修复的4个 PR 没有一个是关于计时器的，你也不应该针对于计时器新开一个 PR，同时，仓库里面确实已经禁用，且上游官方也声称应当在测试中避免使用计时器

对应 §10 原诊断操作释放已有私有等待、§16 用真实协议回执替换两例固定等待。保持原预算和原 Gate；不引入计时器，也不开独立计时器 PR。

### 最新基线、Gate 与提交要求（逐字）

- 用户关于最新目标分支的指令：
  > 相应的Git已经更新了，你可以把最新的内容去rebase一下。
- 用户关于最新 Gate 的指令：
  > 相应的GATE已经更新了，你可以使用最新的GATE的内容。最新的GATE规定了和解决了之前GATE的一些bug。
- 用户关于提交数量的指令：
  > 同时请注意，你的这几个PR都应该是单个Commit。
- 用户关于 Windows 验证草稿的指令：
  > ②早都允许了  ①听不懂，按理来说已经说的很清楚了，新PR本身要么是一个要么是两个，用户的原始需求你都有如果是新PR那个那就允许

其中 ② 回答了「是否让新 CI 在 #5 前发单提交草稿跑 Windows」。因此本任务不再以 #5 发布为前置；用户授权的是新 CI 的独立单提交草稿及其真实 Windows 验收。① 对应的另项基线问题由上游合入处理，不扩入本 PR。

- 用户关于依赖与线上验收的指令（来源 `Sentinel_b683db3372f8819193441f19af28f09a`）：
  > 不好意思，我没有办法接入，因为你本身你没有办法具备外网的连接能力。所以我没有办法去进行帮你进行这种锁文件的下载呀等等一些东西，所以请你注意这一点。我之前已经说过了，如果你必须要去进行一些test测试啊等等，你可以在线上你所提交的PR里面去进行。

- 用户关于当前 Auth 范围和最小改动的原文：
  > 你可以看一下，应该是我的本地的Agent也把Auth对应的部分修了一下。如果你观察到我对应的内容已经把它修好了的话，那你可以让那个新的CI的东西的修改不需要再去改那部分，也就是相应的方案得到收缩，需求得到收缩。你可以看一下，如果它没有改得非常完全的话，那你也可以去适当的精准改那么一点点。然后同时请注意，我希望你所有的这些涉及面呢，就是你这个CI改动的一个涉及面呢，尽可能的小就尽可能的小，就是尽量对生产结构逻辑啊、流程做最少的这种破坏性，或者说这种极少的破坏性修改，然后它的修改的量呢，能多小就多小。当然你这个文档什么的就就是就是没有问题，我指的是具体代码实现上。

- 用户关于当前 CI 基线验收范围的原文（用户补充说明）：
  > 你当前还没有达到验收标准，所以你需要继续去做。而且你说它基线里面有问题，这我不确定。按理来讲，你的任务就是你的修复CI的东西，就是去修复基线问题。

## 2. Explicit Non-Goals

#5、#6、#8 的产品修改与既有 Gate 诊断不纳入此 PR，不另开 timer PR。LSP 请求、诊断结果及公开接口、通用会话取消、权限语义、auth scenario 列表均维持既有合同。只处理现有诊断等待已经结束但其内部未结算的资源，保持 5/10 秒期限及原 debounce。禁止靠增大 timeout、修改 Gate、忽略失败或强制成功退出取得绿灯。并发独立调用 `shutdown()` 期间是否还应提前结束待完成的诊断请求未纳入本修订。

权限夹具变化只涉及其已有临时项目；不修改产品 Config/Npm/Arborist、全局配置源、网络超时及重试。不吸收独立 #8 文件；不另设计时器 PR。

PAT 仅修改原用例自己的传输夹具和断言。保持生产 Provider、ModelsDev 目录及刷新、NetworkProxy、Gate/get 和所有工作流不变；不另开 PR、分支，不增加用例或计时器。macOS 单次前台 Task 超时不进入本修订；该用例在同树候选及多个历史 macOS 分片原样通过，目前未定位发生故障的状态转换。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `docs/guides/workflow.md` | 当前 HEAD 的四阶段、固定 R1 基线、完整映射、独立审计、Revision Delta、Follow-up 合同 |
| `.opencode/skills/first-principles-planning/SKILL.md` | 实测首个分歧与源头，先验证设计关键假设，当前只写 Plan |
| `.opencode/policy/first-principles-engineering.md` | 单路径、职责边界、源码风格、无注释配额、独立裁决记录 |
| `.opencode/templates/canonical-plan.md` | 本文 24 节结构，全文上限 2000 行 |
| `AGENTS.md`、`packages/opencode/AGENTS.md` | 包内运行检查，Effect 与实例作用域约定 |
| `packages/opencode/test/AGENTS.md` | 临时目录、真实进程用 live、同步用就绪信号，不用固定 sleep 代替握手 |
| `CONTEXT.md` | AppRuntime 为共享运行时、InstanceState 为目录实例；LSP 独立协议职责 |
| `docs/adr/README.md` | 当前 ADR 目录只有分诊标签决策，与本次生命周期修复无直接约束 |
| 外部已有 `diagnosing-bugs`、`tdd` 技能 | 当前仓库未携带这两包，复用已保存技能构建可执行反馈；源码、policy、template 以本次 HEAD 为准 |
| `packages/opencode/test/server/AGENTS.md` 与 `packages/core/src/npm.ts:159–205` | Auth 的服务作用域归 harness，Skill 的本地依赖状态由私有临时项目提供；原 npm 检查与清理不动 |
| [Node.js filesystem API: symlink](https://nodejs.org/api/fs.html#fspromisessymlinktarget-path-type) | `type` 仅影响 Windows；传 `junction` 时应使用绝对目录目标。Linux 的实际 Bun 1.4.4 行为另有本机 A/B |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| GitHub run `44608985562` | 2026-11-19 20:28:10 UTC，head 为固定基线，包含两个问题 job | observed |
| Windows job `135860195310` 全日志 | 首例 30000.84 ms，第二例 13593.19 ms；3727 pass / 12 skip / 2 fail / 1 error | observed |
| 前次 Windows job `135783098317` | head `5ab67f8bbb62914f33e4911c3f2cd7798779380b`，两例 607.92/255.97 ms 通过 | observed |
| `test/lsp/client.test.ts` | 先 spawn，再 withTestInstance(cwd)，然后触发通知、等 100 ms、只断言 connection 存在 | observed |
| `test/fixture/lsp/fake-lsp-server.js` | stdio JSON-RPC fake server，现有 pendingClientRequests 负责请求回传 | observed |
| `src/lsp/client.ts` | initialize 45 秒预算、协议 handlers、shutdown 释放连接与进程；instance 参数当前未使用 | observed |
| `test/fixture/fixture.ts` | withTestInstance 调 InstanceRuntime.load，未在该 helper 中执行 dispose | observed |
| `test/preload.ts`、`src/effect/app-runtime.ts` | 当前全局 ManagedRuntime 到 afterAll 才关闭；每例不能销毁共享的 AppRuntime | observed |
| `src/project/instance-store.ts`、`src/util/process.ts` 和对应 core 实现 | 真实例 load/dispose 有直接 service 接口；LSP shutdown 在 Linux 发出 kill 即返回，不等待 Node child close | observed |
| `src/lsp/client.ts:449–546,643–658` | 判断 push、pull、registration 的现有竞争关系及两个后台等待者的实际清理边界；现有公开 shutdown 没有取消该等待的接口 | observed |
| `src/project/instance-runtime.ts`、`instance-store.ts`、`bootstrap.ts` | load 进入真实 AppRuntime、project/config/plugin/LSP/snapshot bootstrap | observed |
| `src/plugin/index.ts`、`src/project/project.ts` | bootstrap 的依赖与仓库发现边界 | observed |
| `src/config/plugin.ts:18–29`、`src/config/config.ts:537–568,720–724` | 自动发现只扫描ts/js；npm依赖fiber由插件初始化显式join | observed |
| 提交 `adf7e89f119554899207190db3f5e075d9d3f9d3` | 首次新增仓库guard.ts；此前只有tsx插件文件，不匹配后端自动发现glob | observed |
| `test/server/httpapi-exercise/{index,runner,backend,runtime,environment,types}.ts` | 场景调度、认证探针、请求头、scope及临时资源owner | observed |
| `test/server/AGENTS.md` | 请求使用测试自有临时项目，服务作用域释放有明确owner | contracted |
| 交付基线的 `.github/workflows/{test,guard}.yml` | `test.yml` 的 PR 触发、原 Windows runtime 和 HttpApi 三模式；`guard.yml` 注释、触发和 job 条件明确区分第三方 Agent PR 的线上 preflight 与本地 pre-push 派发的跨平台 preflight | contracted |
| [现有 #11](https://github.com/SMARK2022/opencode/pull/11) 的 GitHub 只读原始元数据及当前目标分支提交查询 | #11 是同仓 open draft，源分支 `ci-runtime-lsp-auth`，观察时旧 head `bd353ff9812b863157f673605466fb89fb9e389a`；PR 记录仍报旧 base SHA，单独查询 `dev1-smark` 的真实当前 SHA 为 `8aead09f…`，发布前按实时 ref 重新校验 | observed |
| [原 Auth job](https://github.com/SMARK2022/opencode/actions/runs/44608985562/job/135860194918) 与 §18 原 Auth A/B 记录 | auth summary后卡点、单路由A/B、完整225与450probe计数 | observed |
| [原 CI workflow run](https://github.com/SMARK2022/opencode/actions/runs/44608985562) 与 §8、§18 私有诊断回执的校验值 | 原 job 日志、历史对照、临时测时脚本与退出码 | observed |
| `test/agent/agent.test.ts`、`packages/plugin/package.json`、`Npm.install`、`ConfigPaths.directories`、npm v3 lock | 权限输入是本地技能文件，未准备的 .opencode 同时成为插件依赖安装目标；真正本地包可按原依赖检查承载 | observed |
| `test/agent/agent.test.ts:43–44,754–769`、`test/lib/effect.ts`、`test/fixture/fixture.ts:21,77,242–254`、`src/project/{instance-runtime,instance-store}.ts` | 该文件的既有用例经局部测试层获得真实 Store；其文件级 afterEach 另走全局 Store；终止前者不需要启动后者 | observed |
| R7 同进程 A/B、完整 Agent 与 Logger 归因回执，见 §18 | 原门禁不变的两例重复 A/B、原 agent 48 项 A/B，以及同进程 Logger 纤维证据 | observed |
| 最新 `script/guard/{check,rules}.ts`、R10 完整图原始命令与实际八路径，见 §18 | 精确候选树 `6f92cbccbb6f616d187201e00bb8ce68ea7b7c9a`，原完整图检查报告 `test-platform-branch`，Agent 文件:676，计数 1、预算 0 | observed |
| 本轮仓外 `fixture-check.mjs` 与 `gate-rule-check.mjs` | 真实 Bun/Linux 目录链接和本地 npm 安装树边的 A/B；只将候选调用投影到内存，验证原规则命中位置 | observed |
| [0b → 98a 官方对照](https://github.com/SMARK2022/opencode/compare/0b5754df48177fccb05259e705a189df2f50ca2d...98a9f13f30372c8c80a68cf40fcaf371974bd2b3)、真提交和同一源码回放 | ahead 4 / behind 0，八个上游 Guard 路径与本任务八路径无交集。真基线、新旧父、完整 R12 补丁和八路径 mode/blob 均逐项核验 | observed |
| `script/guard/select-tests.ts`、`guard.yml`、`bench/opencode.ts` 的最新目标对象 | 覆盖图生成、受保护路径提醒和 benchmark 种子改动。原 Windows 分片和规则执行入口未改 | observed / contracted |
| [98a → 27f5 官方对照](https://github.com/SMARK2022/opencode/compare/98a9f13f30372c8c80a68cf40fcaf371974bd2b3...27f5f6259b43678482bd0f98eb42361e6a768849)；`f0eb1b28` 和 `27f5f625` | 两提交中九条上游 Guard 路径均在交付八路径之外。对照取 GitHub 的八个 PR blob 与精确新树，隔离回放无冲突，七个源码/测试 blob 不变 | observed |
| 最新 `script/guard/{gate,affected,affected-rules,select-tests}.ts`、`.github/workflows/{guard,guard-nightly}.yml` | 新失败摘要、失败日志归档、可用覆盖记录与静态计划并集、最新两包契约；这些是验收所用目标基线资产 | observed / contracted |
| [27f5 → 8aead 官方对照](https://github.com/SMARK2022/opencode/compare/27f5f6259b43678482bd0f98eb42361e6a768849...8aead09f29652c5acf5004675845873ab1d22a58)、真 Git 对象及空索引回放 | 一个上游提交、五条路径，无交付重叠。原七源码差分的全索引 SHA-256 仍为 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`，含历史 Plan 的对照树 `d5f65f744c2d8a0595cbe782f3604a0c022559c3` | observed |
| `packages/core/src/{plugin/internal.ts,location-services.ts,effect/app-node-builder.ts}` 与 HttpApi `runner.ts`、`src/effect/app-runtime.ts` | `AppLayer` 通过位置服务构建 Core 插件层。8aead 把 provider registry 读取从静态导入移到 Core 既有层创建时；R15 保留该上游owner及其装配顺序，在同基线复验 Auth、Agent 和 LSP | observed / reachable |
| 8aead 的 `affected.ts`、`select-tests.ts` 与选择测试 | SDK-next 仍进入依赖图，但不作为独立测试套件运行；覆盖图建图与选择先解析包路径真实位置，保留 R14 的 `null` 和静态并集规则 | observed / contracted |
| [8aead → 5bc 官方对照](https://github.com/SMARK2022/opencode/compare/8aead09f29652c5acf5004675845873ab1d22a58...5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0)、当前完整 Git 树 | 三提交/十三路径；与旧 #11 重叠三个 Auth 文件，LSP/Agent 及 Guard、test.yml 不重叠。最新官方原 Auth 225、自然退出；详细对照见 §18 | observed |

| `packages/opencode/test/provider/provider.test.ts:2464–2509`、`packages/opencode/src/provider/provider.ts:1237–1308` | 原 PAT 用例直接调用既有 provider fetch，断言由共享传输 spy 捕获；生产保持 POST 变换、取消及 SSE 恢复 | observed / reachable |
| `packages/core/src/network-proxy.ts:201–249`、`packages/core/src/models-dev.ts:182–198,272–274`、`packages/opencode/test/preload.ts:44` | 共享传输入口接收 Request、URL 或字符串；目录 fixture 不关闭后台刷新，该刷新通过原 transport 发送目录 GET | contracted / reachable |
| 精确 `755fbf72` 窄测红与隔离候选绿，见 §18 | 旧总数断言期望 1 实得 3；隔离探针记录两条 npm GET 和一条 PAT POST，PAT 仅一条且原有变换通过 | observed |

## 5. Current Behavior

Windows runtime 两个原 LSP 用例从仓库工作目录启动真实实例，握手前可能等仓库插件安装；建立连接后的断言无法证明客户端真的回传反向请求。原诊断操作在选定结果后还会留下本次的 5/10 秒等待。Agent Skill 权限用例创建私有 .opencode，却没有准备已存在的插件加载路径需要的本地依赖，业务断言完成后原 Guard 仍看到安装资源。

Auth 原事故是 225 项汇总后卡在作用域退出。5bc 已让请求等待真实 HTTP 状态并取消响应体，为原 TUI 长轮询提供真实队列项，并修复 InstanceStore 启动结果发布及所属运行时收尾。当前目标的正式 Auth 已通过。

PAT 原用例在调用 `Provider.list` 前安装共享网络 spy，再由真实 Snowflake provider 变换发向显式本地目标的 POST；同一窗口，初始化服务可能经过原入口发送 npm 探测或 ModelsDev 目录刷新。旧 spy 给所有输入同一 fake SSE，随后按全入口调用计数。

## 6. Supported Input Domain and Reachability

| 输入 | 可达路径 | 现有证据 |
| --- | --- | --- |
| workspaceFolders、registerCapability | 原两条 Windows runtime 用例 → 同一临时实例和 LSP 根 → stdio 反向回执 | 官方原失败、历史真实回执正负对照 |
| push/pull/动态注册 | 原 LSP client 一次诊断操作 → 原完成通知 | 5bc 原 preload 六处 5/10 秒残留 |
| 外部 Skill 目录权限 | 原临时项目 → 已有 config/npm → 临时真实插件就绪 → 原权限测试 | 5bc 原 preload 20/10 秒残留 |
| Auth/Coverage/Effect | 原 test.yml → 现有 probe/seed、真实 HTTP 状态 → 应用与路径收尾 | 5bc 官方现有三模式，Auth 225 后确切退出 |
| 配置 PAT，目标地址及背景网络请求 | 原 provider 变换 → NetworkProxy 共享 seam；测试作用域内另有初始化流量 | 精确树红 3 次调用；候选探针含两条 npm GET 和一条 PAT POST |

## 7. Required Invariants

- INV-01/02：原两个用例观察真实反向协议结果；错误仍返回错误；Windows 路径按文件 URL 处理。
- INV-03/05：保留 5bc Auth 225 项、真实响应与自然退出，Coverage/Effect 保留原场景、预算和结束顺序。
- INV-04：保持原 Guard、工作流、预算、锁和测试数量；同一单父草稿用于正式线上验证，不合并。
- INV-06/07：单例释放自己的实例、运行时和子进程；每次诊断仅结算自身未完成的已有等待，不改请求结果、排队和 5/10 秒期限。
- INV-08/09：不改变 Agent 既有 testEffect 层、清理和权限断言。只准备原 Skill 用例自己的同盘真实插件，原 48 项维持。
- INV-10：PAT 用例仅为其精确目标地址返回合成 SSE，且该地址恰好收到一次请求；核对 POST、provider 用途、同一取消信号、Authorization、请求体转换及 assistant 响应。其他地址走原传输，不计入 PAT 断言。

## 8. First Divergence and Root Cause

1. 两条原 LSP 用例把仓库 cwd 交给会发现插件的真实实例；同一窗口里，应通过反向回执确认结果的断言只检查连接对象。原固定基线上，外部延迟插件 cwd 曾捕获超时；同平台 A/B 及丢失往返、JSON-RPC -32603 负控捕获弱断言。真实 Windows 原失败日志独立保留。
2. 项目实例与 AppRuntime 是两个 owner。旧独立真实反馈表明，只关项目仍留 AppLayer 的资源；关全局 AppRuntime 会污染其他用例。复用单例独占运行时和 child close，保持全部 12 个原行为。
3. 当前 5bc 上，同一次诊断选择结果后，Promise.race 不结算败方，pull 完成也可能遗留 push。原 stock 两文件反馈报告生产 LSP 的六条 5/10 秒句柄，指向 client.ts 的原创建点。应由当前操作结束时调用原清理。
4. Skill 用例建立能触发插件发现的 .opencode，却没有放入 npm 识别的真正本地依赖。原 owner 采样为 Config.loadInstanceState → Npm.install → Npm.reify → EffectFlock.acquire。当前 5bc 仍显示 20/10 秒安装残留。准备已就绪的同盘依赖，不碰生产 npm、权限和计时器。
5. Auth 旧 probe 用伪 status 代替实际 Response，InstanceStore 原可中断发布也可能让关闭等待未发布 entry。5bc 保留真实路由并修复这些 owner；当前官方 225 汇总自然退出。淘汰 R16 的另一条临时目录路线。
6. PAT 原用例先在共享入口安装不分地址的 mock；该入口收到其他地址时就错误返回 PAT SSE，末尾又把这些调用计入 PAT 计数。精确候选未改窄测期望 1、实得 3；隔离候选同入口记录两条 npm GET `/-/ping?write=false` 与一条 PAT POST。此前对照也捕获过 ModelsDev 的 infrastructure GET `/api.json`，包 preload 的本地目录文件不关闭其独立刷新。变化的是同一窗口进入共享入口的其他调用；根因和修复 owner 都在用例自己的 spy，原 Provider、npm 和目录服务不动。

## 9. Responsibility and Seam

测试 fixture 持有同一临时项目、真实 stdio 与 runtime。fake server 复用 pending 替客户端转回真实结果。生产诊断只管理该次操作的原等待。Agent 私有测试准备真实 package/link/lock，原配置与权限 owner 不动。Auth probe、项目启动、HTTP 清理继续由目标已有 owner 负责。

PAT 用例持有自己注入的精确 URL、SSE 响应和对该 URL 的断言。Provider 持有请求及响应变换；ModelsDev 和 NetworkProxy 持有目录刷新及基础设施传输，用例不接管两者。

## 10. Single Approved Primary-Path Design

- 将 test/lsp/client.test.ts 的原用例统一放进同一类单例夹具，每例独立创建并释放真实实例/runtime/child；只给原前两例用真实反向回执替代 sleep 和弱连接断言。
- 现有 fake-lsp-server.js 用原 pending map 记录反向 ID 与控制 ID，转发原 result/error。保持真实 stdio，不增加测试文件或新 IPC 通道。
- 在 src/lsp/client.ts 该次操作内，用私有 AbortController 结算两个原 waiter；保持原 finish、结果、期限和调用顺序。该处是本 PR 唯一生产改动，不扩展 shutdown。
- test/agent/agent.test.ts 仅为原 Skill 用例准备同一临时项目内的实际包、原 npm v3 lock 识别的 link 及同盘 junction；保留同一个权限 seam 与原 48 例。
- Auth 源码和 fixture 原样留在 5bc。出现新的真实候选差异时走原 Workflow 重新定位；不恢复 R16 目录补丁作为备用。
- 原 Snowflake PAT 用例复用同一个显式 loopback URL 发起请求、选择合成 SSE 和筛选 spy 调用。按 `Request.url`、`URL` 或字符串取得地址，不用 method 或 purpose 筛选，确保同一地址的错误方法或重复传输仍可被断言检出。安装 spy 前保留原 `NetworkProxy.fetch`，非 PAT 地址用原参数直接走原入口；PAT 地址的 SSE 与真实 Provider 响应变换保持。沿用原 finalizer 恢复 spy。

## 11. Secondary and Replacement Path Inventory

原 LSP push/pull、注册、空 workspace、RPC error 与 Agent 权限/Reference 都是单一路径的既有分支。5bc Auth 三模式属于既有验收合同。隔离投影与负控只用于诊断，不纳入提交；无新备用成功路径。

PAT 夹具仅替换单一目标的传输响应；其他地址原样透传，属于测试 seam 的输入分流，与失败后的备用行为无关。仓外探针与印证背景流量的诊断输出不进入代码差分。

## 12. Workaround Deletion and Replacement

两条 LSP 原用例的固定 sleep、弱连接断言换成真实协议回执。R16 的 Auth 三文件改动退出候选；基线 backend.ts、runner.ts、index.ts、types.ts 保持。原测试和 Guard 不弱化。

去掉 PAT 用例对所有传输统一返回 SSE 及总调用数断言，只保留目标请求的单次调用契约，保留原变换断言。

## 13. Forward Traceability

| 需求或 invariant | Owner → 文件、行为验收 |
| --- | --- |
| 原 Windows / INV-01/02/06 | 私有真实 stdio、应用与项目 → lsp/client.test.ts、fake-lsp-server.js → 原两例、全 12、正式 Windows runtime |
| INV-07 | 原诊断 owner → src/lsp/client.ts → 同一 60 项原 stock、删 owner 负控 |
| INV-08/09 | 原 Skill fixture → agent.test.ts → 原 48、删准备负控、真实 Windows |
| 原 Auth / INV-03/05 | 5bc probe、TUI fixture 和 InstanceStore → 本 PR 零改动 → 正式三模式同 SHA 与自然退出 |
| 线上验证 / INV-04 | 原 test.yml、guard.yml 及 #11 draft → 无 CI diff → §18 真 checkout、lease、原 job/JUnit |
| 基线 CI / INV-10 | Snowflake PAT provider → 原 NetworkProxy → `provider.test.ts` 原用例的地址级 spy → 混有其他地址 GET 时目标仍仅一条 POST，原变换断言保持 |

## 14. Reverse Traceability

独占 runtime/child 保证单例不污染其他例，原共享实例不能承担其释放；真实反向 ID 用现有 pending map 才能观察原协议错误；原 Promise.race 不关败方，私有诊断 scope 只做原 finish；现有 npm ready 路径可靠接管真实 fixture，原测试缺准备；Auth 已由目标链路承载，旧补丁没有新增职责。

PAT 无新增生产概念。地址级匹配和原入口透传由已有测试 spy 承担；旧总计数及响应桩无法表达同一共享入口的不同请求 owner。

## 15. File-Level Change Plan

| 文件 | 唯一职责 |
| --- | --- |
| docs/plans/ci-runtime-lsp-auth.md | 唯一 Plan，固定原始基线与现行终态、审计和验收 |
| packages/opencode/src/lsp/client.ts | 该次诊断结算已有等待，唯一生产文件 |
| packages/opencode/test/agent/agent.test.ts | 原 Skill 私有真实依赖，原 48 例 |
| packages/opencode/test/fixture/lsp/fake-lsp-server.js | 转发真实 stdio 反向回执 |
| packages/opencode/test/lsp/client.test.ts | 单例真 runtime/实例和 child，原两条回执，原 12 例 |
| packages/opencode/test/provider/provider.test.ts | 仅原 PAT 用例按目标地址拦截、计数并核对真实变换；其余 provider 用例不动 |

## 16. TDD Behavior Slices

先原协议两条的真实回执及损坏负控，再同一 5bc 原 stock 两文件的 20/10 与 5/10 秒清理红绿，删单路径验证拥有者，最后在原 GitHub Windows shard 和 HTTP 三模式验证精确候选。现有 48＋12 测试无净增；外部样本不进入交付。

PAT 使用同一已有用例：基线与未改精确 #11 保留实际红测；隔离投影仅修该用例并加临时调用打印，确认存在额外地址时、目标仍恰好一条 POST 并通过原变换断言。窄测后运行原整个 provider 文件与候选正式验证。不新增永久负控、计时器或实例。

## 17. Comments

沿用非显然约束：双协议 ID、Windows 的文件 URL、独占运行时和 child close、归属本次诊断的等待、同盘 npm lock/link。排除纯移动、导入、空白、格式化和生成内容，已移除的 Auth 注释不参与。

PAT 仅在解释后台初始化请求为什么可能与测试共用 spy 的位置写中文注释。最终按 §15 五个代码、测试／夹具路径逐 hunk 记录 E/C。

## 18. Verification

**当前目标身份与正式基线。** 当前 dev1-smark 精确父 5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0／树 7856a04183fb9aa562da776477c27243f8c9874f。原 GitHub [push test 44893573585](https://github.com/SMARK2022/opencode/actions/runs/44893573585) 的 [Auth 136814372657](https://github.com/SMARK2022/opencode/actions/runs/44893573585/job/136814372657)、[Coverage 136814372651](https://github.com/SMARK2022/opencode/actions/runs/44893573585/job/136814372651)、[Effect 136814372687](https://github.com/SMARK2022/opencode/actions/runs/44893573585/job/136814372687) 均为原 SHA，225 pass/0 fail/0 skip/0 missing/0 extra，作业成功。Auth 10:17:22.513 UTC 汇总，10:17:23.241 UTC 进入 Post job cleanup。上游已满足原 Auth 目标，候选不用其三个旧后像。固定 R1 前历史 [Windows runtime 135860195310](https://github.com/SMARK2022/opencode/actions/runs/44608985562/job/135860195310) 与当前 [5bc Windows runtime 136814372691](https://github.com/SMARK2022/opencode/actions/runs/44893573585/job/136814372691) 均捕获两个原 LSP 失败；当前基线为 3729 pass／12 skip／2 fail。R17 草稿的 [Windows runtime 136825064060](https://github.com/SMARK2022/opencode/actions/runs/44895058784/job/136825064060) 由 `9dfcbe7`（`755fbf72` 合入 `5bc061bb` 的验证检出）跑到 3731 pass／12 skip／0 fail；两原例分别 585.89 ms 与 438.76 ms。此回执保留为原 LSP 同基线对照；R19 须按新 SHA 核对。

**当前 5bc 可红反馈。** 使用锁定 Bun 1.4.4，在包目录执行原 stock preload 的 test/agent/agent.test.ts 与 test/lsp/client.test.ts，保留 30 秒原用例预算；同一已有只读、仅 loopback 运行器，无外部注册表。当前工程目录代码保持 HEAD；候选和负控只在外部临时投影，原 Guard 与测试入口未改。

| 同口径运行 | 观察 | 出口 |
| --- | --- | --- |
| 精确 5bc | 60 个业务用例通过，原清理报告 LSP 5/10 秒六条及 Agent 20/10 秒两条；6.64 秒 | 1 |
| 仅四文件旧 LSP/Agent 后像，Auth 留 5bc | 60 pass/0 fail、168 断言；9.01 秒 | 0 |
| 去掉 LSP 生产 owner、其余不变 | 60 个业务用例通过，恰好六条 LSP 5/10 秒残留 | 1 |
| 去掉 Agent 准备、其余不变 | 首轮 60/60 自然退出；同入口复跑 60 个业务用例通过，20/10 秒两条清理失败 | 首轮 0，复跑 1 |
| 去掉 Agent 准备，单跑原 Skill/Reference | 两条业务用例通过，20/10 秒两条清理失败；5bc 原同名窄测另轮自然通过，说明有运行波动 | 1／0 |
| 四文件保留，单跑同两例 | 两条业务用例通过，清理正常退出 | 0 |

此前 8aead 的 Windows 普通分片原日志（job 136796854921） 中，同名 Skill/Reference 两例分别在 1440.01／1385.01 ms 通过；普通分片与上述 Linux 原泄漏 preload 的 afterAll 不是同一入口。当前保留 Agent 文件，仅因本轮同一原 Guard 反馈两次重现安装残留；保留范围限于旧 Skill 用例内创建已就绪本地依赖，保持其权限断言、Reference 和其余原用例不变。

各命令、原输出和退出清单 SHA-256 7ddfce0c83de2cfcacdad54db9ce77bd77fef84ee4ad4e22b2bd52fb053dba5d。历史固定基线的真实协议正负控与两条原 Windows 日志仍按 R16 冻结记录取证：缺失反向请求与真实 RPC error 都能让旧弱断言漏过的问题被新用例检出，本轮 Linux 同入口验证原 12 条，但只有正式 Windows runtime 给出该平台候选结果。四路径隔离差分 SHA-256 883298c678fd14d9dc0b8d647c238233b3883cd3cb36d8ea627277e539d481b6，树 0fadd66b012e4ee367829f02bf1a1feb90b7ee93，七路径 R16 历史审计仅供追踪。

**PAT 红绿与验收口径。** 基线 A/A 与 #8 B 对照曾各捕获目录 infrastructure GET 和本用例的 PAT POST 混入同一 spy。由 GitHub 原对象重建精确 #11 `755fbf725e819ac3be8257cdd0122536529e3821`，索引树 `75cc6199885e363e0368d594b79128bd8067a20a`。位于投影的 `packages/opencode`，使用 Bun 1.4.4、同一只读依赖及原包 preload，以 `TMPDIR=<projection>/.case/tmp PATH=<Bun 1.4.4 bin>:$PATH timeout 70s bun test --timeout 20000 test/provider/provider.test.ts -t 'routes Snowflake PAT transformations through NetworkProxy'` 运行原用例。未更改 ModelsDev 开关。隔离绿臂仅将路径换为临时同目录副本；临时代码与输出不提交。

| 同入口对照 | 实测 |
| --- | --- |
| 精确 #11 原文件 | 第 2486 行期望调用数 1、实得 3；0 pass、1 fail，用例 7410.10ms；日志 SHA-256 `2d03a4a22d6bc14fa43eb56904d6e1ed1493245529da5ab531149b47f9a7fc53` |
| 精确 #11 的单用例隔离投影 | 两条 `GET /-/ping?write=false`（npm），一条口径为目标 URL 的 `POST /v1/chat/completions`（provider）；1 pass、0 fail、8 条断言，用例 4607.98ms；日志 SHA-256 `1d375729b788a77d51c629a165f420c524e2c185e936183820e90f87680f6101` |

目标必须数量为 1 且 method=POST；保留用途、同一 signal、认证、token 字段和 SSE role 的原断言。R19 在同一仅启用 loopback 的受控环境用原 preload 复跑原用例与整个 provider 文件（包目录，`bun test --timeout 30000 --max-concurrency 2 test/provider/provider.test.ts`），再运行同一候选原 PR test、Guard/A-B、typecheck 与本节其他交付门禁。不依赖公网 registry；实验 fixture 只配置本轮进程中的两个现有服务源，不修改测试套件默认值。原文件与临时投影的验证属于方案证据，不能替代正式实现回执。

初次纯回环补充探针印证：旧 spy 为两个非目标地址错误返回 PAT SSE，地址级 mock 原样透传并收到各自 JSON。该探针的两臂又都在进入 PAT 调用前达到同一 30 秒上限，故只将其用于验证背景响应归属，不计作完整用例红绿或重复请求、错误方法的负控通过。原文件红与前表真实隔离绿是本阶段完整行为的实测。

**纯回环关键假设验证。** 后续实验在只启动 loopback 的网络隔离进程内，分别以既有 `OPENCODE_MODELS_URL` 和 `OPENCODE_NPM_REGISTRY` 使用临时本地 fixture。目录初始化读原 models JSON；registry 用私有回环响应完成已观察到的初始化请求。被测用例的背景探针模拟两类已观察到的地址和请求类型，真实转发的结果与 PAT 的 SSE 由各自接收端产生。私有 fixture、诊断打印及变异用例不提交。

| 同一 Bun 1.4.4／网络隔离 | 结果（整命令耗时） | 原日志 SHA-256 |
| --- | --- | --- |
| 旧 spy，给非目标地址统一返回 SSE | 原计数断言 1 对 3，退出 1（3.62 秒） | `e764e0e047dac87e8db6a2eaff530edb185ed4b6ceb6d79c3ceff3828eabdeb5` |
| 原 seam，仅隔离精确 PAT URL | 两条 GET 透传并返回 JSON；一条 PAT POST，1 pass、9 条断言、退出 0（3.83 秒） | `81b84c74881101ec16f4a9e8211fe815dca6cb244bab33d3cc0f6144302806be` |
| 保持背景流量，追加同目标 POST | 目标计数 1 对 2，退出 1（4.04 秒） | `47659ebf1b4c385e0b7c8a61d8a5b8071747cbb4bcf5e18bdea76f9d51a162f2` |
| 保持背景流量，将目标方法改成 GET | 目标方法 POST 对 GET，退出 1（3.89 秒） | `552f2e784327e4f8d3aaff0357fe13d8f755ecacf431279729fd477bb8066cfa` |

执行脚本及私有 fixture 回执分别为 `888035924fbc60baafa2e7c4c875963385b39e9fae1d308dda69aa0e58209d82`、`06d86fd11de98bba322be84a9a453effc0ab45907524aee6c592bf4f488243c4`。这里证明在零公网入口时，原用例仍有可靠红绿，并能拒绝目标重复和错误方法；临时输入不替代原测试文件与精确候选 GitHub 回执。

**无人工流量的原测试与全文件回归。** 用同一仅回环环境、临时独立目录和原 preload，分别运行未改原文件、单用例临时投影及包含该投影的原整个文件。仅用现有进程级设置把 models 源指向仓库现有 models fixture JSON，把 npm registry 指向返回最小本地元数据的响应；不改仓库环境、共享 preload 或运行时默认值。本组不主动发送背景请求，不替代前表可控红测。

| 原用例入口／范围 | 实测 | 原日志 SHA-256 |
| --- | --- | --- |
| 未改原用例 | 此轮未触发竞态，1 pass、0 fail、7 条断言，退出 0 | `4298c9a035cc7953d40da26ec57f7b266c65b40c7ab0221adde8a72a35405186` |
| 仅 PAT 地址级 mock 的同一用例 | 1 pass、0 fail、8 条断言，退出 0 | `777e9f7936c481aec6e8c7046448ffafc0df222070fe3e004ba781b68c5261c0` |
| 原整个 provider 文件的同一临时投影 | 119 pass、0 fail、333 条断言，25.28 秒，退出 0 | `c48e0c2ac93a8e906d62fce6fbb43341d38764b9aa2e92e0a85c69a1d1175ad8` |

运行形态为 `bun test --timeout 30000 --max-concurrency 2 <original-file-or-private-projection> [-t 'routes Snowflake PAT transformations through NetworkProxy']`，包目录不变。相同私有 inputs 下全文件通过，因此没有证据要求将本地 registry、目录 fixture 或进程配置写进永久测试；第 15 节仍只给原用例自己的目标地址设桩。

**按当前官方工作流执行。**

| 原命令/入口 | 位置 | 验收 |
| --- | --- | --- |
| bun test --timeout 30000 --max-concurrency 2 --preload ../../script/guard/leak-preload.ts test/agent/agent.test.ts test/lsp/client.test.ts | packages/opencode | 60 条原用例自然退出；本地同源红绿保存 |
| bun run typecheck --singleThreaded | packages/opencode | 原类型检查；只有已具备同锁环境时本地执行，其余查原 GitHub 类型工作流 |
| bun script/guard/check.ts . --changed-since 5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0 --files "$files" | 仓库根，§15 精确六路径 | 原完整图静态检查、运行时选测来源与确切出口 |
| 原 Guard stop、contracts，原 guard.yml PR 检查与适用 A/B | 仓库根及原 GitHub 工作流 | 检查 schema/protocol、选测实际范围、正式规则和基准。原 LSP fixture 路径会触发包级全量，须核对真实原选集 |
| 原 test.yml 的 opencode-windows-runtime，及 HttpApi auth/coverage/effect | 同一 hosted PR 候选 | Windows 原分片真实 stdio、JUnit、自然退出，三模式各 225 项和自然退出 |

当前本地缺历史锁定分发依赖，不改锁、仓库配置或公网策略；按用户原话使用现有 #11 的官方 GitHub runner。独立方案放行后，冻结 §15 五个代码、测试／夹具路径和本 Plan，核对候选精确 tree、mode/blob 与唯一父。只读再核实真实 dev1-smark、同仓 #11 仍为 draft、源分支 ci-runtime-lsp-auth 与实际当前 head；旧 PR base 字段不替代目标 ref。仅使用单父线上验证草稿和已支持 expected_sha + force 的分支 lease；身份不符或 lease 拒绝立即停写。回读 PR/head、ref、原父、完整树和六路径字节。保持 draft，不写目标，不合并；线上验证提交不记录本地 hook 通过，也不提前算最终交付。

原 test.yml 的 PR 事件跑 Windows runtime 与三个原 HttpApi jobs。原 guard.yml 明确由规则、契约及适用 A/B 验证第三方 Agent PR，单元测试由 test.yml 执行。另有 workflow_dispatch 三平台 preflight 入口，独立记录其候选 SHA、基线与 macOS/Linux/Windows 结果；当前连接器能读取既有结果、重跑原 job，但尚无确认的新 dispatch 能力。不要将 PR 入口或旧任务重跑算三平台派发。若 runner 检出 GitHub 合成提交，逐项校验真实 checkout 的候选、目标父、树身份并单列该 SHA。所有正式结论绑定实际同一候选，保留原验收日志/JUnit 与阶段 4 独立审计；最终按原提交合同及钩子确认相同单提交并空仓恢复。

## 19. Diff Budget

仅五条源码/测试路径和唯一 Plan。只有 LSP 诊断清理触及生产；测试实例净增 0，无生成文件、依赖、CI 或预算改动。四条移交路径历史物理 +376/-443，其中大段原 LSP suite 迁入同一真实 fixture；PAT 增量限于一个已有用例。有效 E/C 随实际差分单列，不把缩进、纯移动或导入当行为。

## 20. Real Risks and Open Decisions

真实 Windows 候选和独立三平台 preflight 尚需实际回执；正式前重查 ref 与同源 checkout。当前范围不再调整 Auth，若候选在同源原入口出现新失败，按实际第一分歧走修订和审计。不得用旧 Auth 目录补丁、计时器、额外 CI 或弱化验证收尾。现阶段无需用户准备依赖或提供额外授权。

R17 的线上 Windows、HttpApi、Guard/A-B 和类型回执是既有四路径的历史验证，当前 R19 须按新精确 SHA 取得回执；PAT 间歇性由已确认的调用混入解释，单轮线上绿无法代替隔离试验。单独 macOS 前台 Task 超时详见 §2，不作为本轮修复成果。

## 21. Audit Contract

按从固定 R1 HEAD 到当前目标的完整行为审计两项原需求和当前基线 CI 范围，按 5bc 到候选的六路径检查全部实际差分。核对旧 Auth 补丁移除后三模式原验收、每一保留 LSP/Agent hunk 的实际 owner、PAT 测试夹具边界、官方 #11 真实验证路径与 hook/终态。独立裁决仅适用于本 revision；在原样记录 No blocking findings 与 APPROVE 前不实施。

## 22. Revision Delta and Plan Audit Record

| Revision | Sections changed | Prior findings and resolution | Invariants, states, concepts, or files added or removed |
| --- | --- | --- | --- |
| R1 | 初始完整方案 | 尚无前轮 | 两轨，四个harness文件 |
| R2 | §6、10–19、20、22 | B-01：两原失败例改为真实回执，执行正负隔离反馈 | 增加既有fake server文件；删除两例sleep与弱断言；auth设计不变 |
| R3 | 元数据、§7–8、10–11、13–16、18、22–23 | R2 正式实现审计 BLOCK 原样保留；新增发现精确 R2 的 Effect 全量回归，隔离恢复原组合收尾两次全量转绿；同一处理组 Auth、Coverage 全量复验均通过 | 补记 INV-05；index.ts 为既有变更文件，范围仍为原两轨、五个测试/验收文件、净增测试 0；无新实现授权 |

| R4 草稿 | 元数据、§17、§22 | 补回用户明确要求的 E/C 验收；R3 原独立裁决下文原样保留 | 仅注释约束与实施后的计数，不改变 R3 可执行行为、文件范围、请求、场景或超时。 |

| R5 草稿 | 元数据、§17、§22 | R4 B-01：以独立的可达路径约束替换两条复述性注释；原组合 finalizer 按 pure-move 排除，E=87，最低 C=14。 | 只变更注释合同并保留原五文件行为差分；实际 C 待核验。 |
| R6 | 元数据、§1、4、7–10、12–20、21–23 | 原 stock 检查稳定重现：两种运行顺序下两侧同 12 例失败；两个 60 秒 owner 已证，同一进程中两条原测试经独占真实运行时以原检查退出 0 | 加入 INV-06；仅改变测试夹具 owner 的拟议路线，HTTP 路径及原五文件范围保留。R5 以前裁决保留下文，不授权 R6。 |
| R7 | 元数据、§2、4、7–21、22、23 | 已实施 R6 清理后仍有六条生产诊断 waiter；固定 0dff 同源。临时只结算原 operation owner 后原三例红绿、全 12 例双入口绿 | 加入 INV-07 和唯一生产路径；原五文件、Windows 原症状、HTTP 全原路径、单一 PR、零新增用例保留。R6 独立裁决保留下文，不能作为 R7 授权。 |
| R11 | 元数据、§3–5、§7–10、§11–22 | 0b 的真实全图检出 Agent 用例平台分支；同盘真链接与 Arborist 的两臂均通过，历史 R10 实现 B-01 的完整 Gate 和真实 Windows 留待实际验收 | 更新 INV-09。测试不再选择 OS；由同一个既有文件系统 API 承担。交付仍七代码路径加本 Plan、单提交、零净增测试；其余 LSP/Auth 行为、原 hook、Gate、锁和配置不变。 |
| R12 | 元数据、§1、§22 | R11 独立方案审计 BLOCK B-01：补齐用户关于计时器的逐字要求并映射 §10、§16；说明两份原始日志的历史路径在本环境未物化、改用原 Library ID 与 SHA 作稳定出处。 | 只补需求原文、追踪和来源说明；完整目标行为、文件范围、验证和实施门不变。 |
| R13 | 元数据、§1、§4、§18、§20、§22 | 目标 0b→98a：核对四个提交与八个上游 Guard 路径；在 98a 私有索引无冲突重放原八路径，R12 全 diff SHA 仍为 `d748c59b01ed65706bb9866466d8bae8e8ebc0d852169aea7303886682c3f203`，历史 R12 Plan 的对照树为 `1e152666322b974d7cf6042f95d46c7a1e637de3`。 | 七条源码、行为、文件模式和测试数不变；更新交付基线与门禁证据路径。按用户原话取消 #5 先行依赖；只允许独立单提交草稿验证，原 Gate 和真实 Windows 仍必过，不授予合并。 |
| R14 | 元数据、§4、§18、§20、§22 | 目标 98a→27f5：核对两个上游提交和最新官方树；历史 R13 八路径在最新基线无冲突精确回放，隔离树为 `08376bc470ad4dda4310c7cae7d07ff8f212c325`，只用于校验差分。当前 Plan 修订需独立审计。 | 七源码/测试路径及四个行为边界不变，零新增测试。验收合同更新为两包契约、覆盖图与静态计划并集、正式三平台失败日志；无 Gate 或 workflow 改动。 |
| R15 | 元数据、§4、§18、§20、§22 | 目标 27f5→8aead；五条上游文件与交付八路径无重叠，原七路径完整差分逐字不变。Core 插件层可达变化及当前选择器重新实证，批准前不得应用到工程工作树。 | 保留原两轨、单提交、七源码路径和零净增测试，更新实际验收基线与选择范围。没有修改 Gate、provider 层或计时器。 |

| R16 | 元数据、§1、§4、§13、§18、§20–22 | 保持 8aead 与全量既有故障路线；按用户新增的线上验收指令，验证原仓库 PR 行为与只读远端分支身份，补充草稿 lease 与 checkout 证据边界。 | 唯一改动为验收运行位置及草稿发布验证；七源码/测试 byte、原预算、锁、Gate/workflow、单提交与不合并约束不变。R15 批准及证据仅作历史。 |

| R17 | 元数据、§1、§4–22 | 最新目标 8aead→5bc，三提交、十三路径，三个旧 Auth 文件重叠；当前官方原 Auth 的真实 225 及自然退出已证，按新用户原话保留上游实现，重新验证保留的 LSP 路径。 | 原两项验收目标、原 Gate、单父草稿/不合并保持，删除当前候选的三条旧 Auth 修改。历史冻结证据不替代 R17 的独立审计。 |

| R18 | 元数据、§1–2、4–22 | 用户要求继续完成基线 CI。保留 R17 四路径与其证据；精确 `755fbf72` 仍红，旧 PAT spy 全局计数期望 1 实得 3；隔离候选在两条 npm GET 同时出现时原用例通过。旧验收和裁决不授权新改动。 | 新增 INV-10 与原 `provider.test.ts` 单个用例修改；单父、零净增用例、无额外生产改动、无 Gate/get/计时器或新分支。 |
| R19 | 元数据、§18、20、22 | R18 B-01：纯回环试验为原 ModelsDev 与 npm 配置各自本地输入，再实测原作用路径、重复请求与错误方法；没有外加流量的原整个文件 119/119。修正当前 Windows 数字，保留历史原失败。 | 保持原 PAT 精确地址 mock 及单用例范围；新增方案证据与回环验收条件，不给仓库增加全局 fixture、配置或运行时路线。 |

### R19 独立方案审计裁决

#### Blocking findings

No blocking findings.

#### Release verdict

**APPROVE**。批准的独立审计输入是精确 R19，SHA-256 `77063f631e806900aed9fb8ebf98462e941cab3a41596fb088ee1608e2d3df25`。

### R18 独立方案审计裁决（原文节录）

#### Blocking findings

B-01 PAT 夹具把真实注册表访问带回了离线必过路径

Minimal correction direction: 保留精确 PAT 地址的 spy；先用现有私有 fixture 准备依赖，实际跑通同一原用例的隔离红绿，并记录必要初始化流量归属。不改生产网络、Gate 或计时器。

#### Release verdict

**BLOCK**。适用 R18，SHA-256 dc3cc8fe7909b114b1ab806438abad71c541ea2d2f4490ed778744eb47ef6738。

### R17 独立方案审计裁决原文（full-scope）

## Blocking findings

No blocking findings.

## Non-blocking findings

保留的历史测试后像包含 namespace import，与 AGENTS.md 的静态风格要求有差异。此差异不是 R17 删减引入，也不改变验收行为。

## Follow-up

按 §18 在同一精确候选上验收原 Windows runtime、HttpApi 三模式、原 Gate 和适用的 A/B。GitHub 合成提交须单列实际 checkout；草稿验证不算最终发布通过。

## Rejected speculation

一次移除 Agent 夹具后的通过不能证明该夹具可删：完整用例复跑与原 Skill/Reference 窄测分别重现了清理失败。现有证据也不证明 Windows 普通分片必然失败。无需为此新增生产依赖、改 Auth 或调大等待期限。

## Requirement and traceability coverage

独立核验了精确 `5bc061bb`、R17 方案及四路径投影，`git apply --check` 和原始回执完整性校验通过。GitHub 上 `5bc061bb` 的原 Auth、Coverage、Effect 均成功，Windows runtime 仍在运行。候选删去三个 Auth 修改，测试透过原入口保留这项验收；唯一生产改动仍是 LSP 诊断完成后释放该次操作的等待。对照中，去掉该生产改动会重新留下六个等待句柄；完整四文件候选 60 项、168 条断言全通过，正常退出。

## Primary-path and fallback verdict

LSP 保留原 push/pull 与注册行为，原本次操作负责释放自己的等待。测试用原 stdio 回执确认协议结果，Agent 夹具只准备原权限用例已需的本地依赖。Auth 沿用目标分支实现。新增备用成功路径为零。

## Release verdict

**APPROVE**。仅批准精确 **PR #11 R17 方案**，SHA-256 `72b06bb1a8ab43ecb4c3a53aa70241531b5fc9be1f5413ba35e9091351638189`。此裁决允许按方案实施，不认证实现差分、线上结果或可合并状态。

### R16 独立方案审计裁决原文（full-scope）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的历史 preflight 段落仍写“仅用 R15 正式日志判断当前是否仍出现”。当前验收应读作 R16；同节执行顺序已明确要求绑定 R16 候选，不影响放行。

## Follow-up

核对 #11 实际远端 head、唯一父提交和 workflow checkout 后，再登记 Windows runtime、HttpApi 三模式及 Guard 的结果。三平台 dispatch 和最终提交条款仍按各自合同验收。

## Rejected speculation

原 `guard.yml` 明确支持 Agent PR 的线上验证。按 R16 运行该入口不会改变原 Gate，也不构成本地 hook 通过。旧任务重跑不会证明新候选，方案已排除此做法。

## Requirement and traceability coverage

核对了两项原 CI 故障、Windows 草稿授权及最新线上验收指令。实查交付父提交 `8aead09f`、基线树 `ea7fc403`，七条源码和测试路径差分 SHA-256 仍为 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`。原 `test.yml` 的 Windows runtime 分片覆盖 Agent 与 LSP 测试，HttpApi 三模式保留原命令；原 `guard.yml` 分开记录 PR 检查和独立三平台 preflight。

## Primary-path and fallback verdict

产品行为与测试入口不变。线上验证只使用现有 #11 草稿、精确单父候选和带预期 SHA 的分支更新；身份不符即停止，保留单提交和不合并约束。

## Release verdict

**APPROVE**，仅适用于 R16 方案，SHA-256 `c23abfa9ffc23dff5bdc29bd2581abfbbbbf584e24f817354fb54888a89b4869`。本裁决不认证实现或线上结果。

R12 实现审计 BLOCK：缺绑定其精确候选的原完整 Gate 与真实 Windows runtime。这两项保留开放。冻结 0b 树 `000ee26e175a9178c7d7be45f18631f5b05f38ce`、完整差分 `d748c59b…`、批准裁决和原测试回执都保留于独立恢复档 `new-ci-R12-Stage4-reference-overlay.tar.gz`，SHA-256 `32a1c511fb8e1eb3c5dac02e9fce865b817d2b13572e3b37fac5fc5072274278`。原完整实施 verdict 另存，冻结 Plan 保持原字节。正式报告分开标注两个基线及两次审计，不以 R12 验收覆盖 R13。

### R13 独立方案审计裁决原文（full-scope）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 留有“正式候选通过 Workflow 放行后才供 Windows job 检出”的旧句。请标明它指正式交付，独立验证草稿按同节新增边界执行。

## Follow-up

在 `98a9f13f…` 上重跑原完整 Gate，保存当前选测清单和自然退出。真实 Windows job 需同时记录候选 SHA、实际 checkout SHA、目标基线、退出结果和 JUnit。R12 的本地绿灯只作历史对照。

## Rejected speculation

上游更新集中在八个 Guard 路径，与本任务八路径无交集。无需扩大源码改动、修改 Gate 或另开计时器 PR。

## Requirement and traceability coverage

已核对新父提交、上游四提交和重放校验清单。Windows LSP 的真实协议回执、Auth 225 场景后的自然退出、原 Gate 和单提交要求均保留。用户授权的草稿用于 Windows 验证，可先于 #5；正式放行和合并仍按原门禁。

## Primary-path and fallback verdict

LSP、Auth 和 Skill 继续走各自的原执行路径。草稿与独立 Windows 工作副本是同一源码的验收环境，不新增产品执行路径，也不替代完整 Gate。

## Release verdict

**APPROVE**。仅批准 R13 方案，SHA-256 `46f8f990782714044ad7999e5e5efc9325840fbe86c40c93bfa55095bc71ff4c`。

R10 实现审计 B-01 的原裁决 SHA-256 为 `252c69317b052b4a456d253befc83c4ec3655450fc44cb78096b71a18125b730`，对应旧八路径差分 `5b9a078c1da1a3ea3e1c37cd3bedd20e760648728bde10c35178f7c40e2fa29c`。

### R12 独立方案审计裁决原文（full-scope）

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的交付核对仍写着“不以历史 R10 回放代替 R11”。记录本轮裁决时，将终态版本更正为 R12。

## Follow-up

完整原 Gate 和真实 Windows runtime 仍是实施验收门禁。用 R12 精确候选保留自然退出、JUnit 和候选身份；Linux 链接实验只支撑方案。

## Rejected speculation

无需新增计时器、平台分流或备用链接。原 LSP 用例等待真实协议回执；Skill 夹具用同一个文件系统接口建立同盘目录链接。

## Requirement and traceability coverage

R11 的 B-01 已关闭。§1 逐字补齐计时器要求，并映射到 §10、§16；两份原始日志保留 Library ID 和校验值。Windows LSP、HttpApi Auth、原 Gate、单提交和用户决定合并的约束均保留。

## Primary-path and fallback verdict

保持原三条路径：LSP 真实 stdio 与现有等待清理，Auth 现有请求与作用域，Skill 本地链接与原 npm 就绪检查。文件范围与测试数量不变，无备用成功路径。

## Release verdict

**APPROVE**。仅批准 R12 方案，SHA-256 `3459c547164bce980e7ede79071d3389452154f0e2270785ae53e893b2b49a4f`。

R7 修订所保留的 R6 方案及历史回执 SHA256 `47e8da62a047ead32965967654005d8877f90b465f26aee8ef1abb799b5c22c2`。R6 §23 是历史阶段 3 证据，不表示 R7 已实施。

R4 送审 Plan SHA256 `f3a3971d55d41bd9b0c117127ec7dc3d822c9c0defa20587b906c1539759f8bb`；独立审计 BLOCK，B-01。注册参数注释的源码依据为 `src/lsp/client.ts:182–190`：只有该方法进入动态诊断注册分支，其他注册项被忽略；不声称此回执断言验证了注册后的诊断结果。Effect 注释只解释组合登记的作用域边界；第 18 节全量对照证明该登记形态恢复基线行为，不证明实际有哪个其他释放步骤插入。

R3 原送审 Plan SHA256 `178ca1ecabdcc1a756e0a4b2b174c37811a885c78bff077d44aecb9849e3fe4f`；含原样批准裁决的 R3 Plan SHA256 `245054e4f2dbfb0d00b35cdd625e8f2fcba0fbb7b3ba7742242d2d6d1cafc951`。R3 五文件行为差分（`git diff --binary --abbrev=9`）SHA256 `bde09d3df314edc88b56463f8aa95bffe83516f345ffbb29e3ed62449a69931f`，本次仅修订 Plan，原差分不变。R3 批准记录不授权 R4。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | 是 | B-01 | auth既有超时判据、完整Gate/Windows仍需验证 | BLOCK | 本节原裁决 |
| 2 | R2 | 是 | No blocking findings | 真实Windows、完整验证待实施 | APPROVE | 复用原审计任务，完整裁决如下 |

R1 完整裁决原文如下。

## Blocking findings

### B-01 两个 LSP 用例的绿灯无法证明协议往返完成

- Violated invariant: §7 INV-01 要求 `workspace/workspaceFolders`、`client/registerCapability` 通过真实 stdio 往返，在既有预算内完成。
- Evidence class: observed。
- Producer and execution path: 两个既有用例在初始化后发出 `test/trigger` 通知，等待 100 ms，然后断言初始化时已存在的 `connection`。断言不读取触发后的协议回执。
- Source evidence: `packages/opencode/test/lsp/client.test.ts:34–40,58–64`；`packages/opencode/test/fixture/lsp/fake-lsp-server.js:107–109,133,152`。
- Canonical-plan evidence: §7 要求真实往返；§10、§12 保留固定等待和现有断言；§13、§16、§18 以两例转绿作为验收。
- Responsibility owner: 这两个既有用例及其 fake server 的测试边界。
- Concrete behavioral consequence: 即使 fake server 没有发出请求，或请求的回复未送达，只要初始化成功，两例仍能绿。目录隔离 A/B 已验证启动卡点，但这个断言无法验证修复后原协议路径确实执行完。
- Minimal correction direction: 复用 fake server 的请求回传机制，在两条既有用例等待指定回执并断言结果，保留真实子进程、原预算和零净增用例；无需扩大到其余测试。

## Non-blocking findings

auth 原场景集合保持不动。225/225 自然退出的对照覆盖本次收尾故障；`tui.control.next` 合法请求的既有超时判据跟随原记录单列。完整 Gate 及真实 Windows 验收仍是交付条件。

## Rejected speculation

不改生产 LSP、认证、TUI 队列或 guard；不提高超时，也不靠强制退出取得绿灯。

## Requirement and traceability coverage

两份附件对应的缺陷均进入同一方案。LSP 原失败复现定位到 stdio 握手前的仓库启动链，测试目录隔离归现有测试负责。auth 已用原 CLI 实证汇总后挂住，再以请求显式绑定测试自有目录取得 225/225 和自然退出；非 auth 路径保留原行为。

## Primary-path and fallback verdict

两个改动均留在既有测试链路，生产逻辑不动。LSP 的真实回执需落实为验收证据。

## Release verdict

**BLOCK**。R1 SHA256 `d979d54d8e55ac30596fc0692cea820f8d8a4961f3626aa3f8f43ce08724a398`。

### R2 独立方案审计裁决原文

## Blocking findings

No blocking findings.

## Non-blocking findings

本地隔离验证已通过。真实 Windows 分片、完整 auth 与 coverage、正式 Gate 仍须在实施阶段运行并记录结果。

## Rejected speculation

不扩大到第三个 unregister 用例，不改生产 LSP、认证或 Gate，不提高超时，不新增测试实例。

## Requirement and traceability coverage

- **B-01 已关闭。** 两个原失败用例复用 fake server 请求关联，等待真实 JSON-RPC 回执。`workspaceFolders` 校验临时项目 URI，`registerCapability` 校验 `null`。注入错误响应和阻止请求发出的负控均转红；首例失败后子进程退出，下一例仍通过。在同一污染目录条件下，完整 LSP 文件 12 项通过、22 个断言。
- **HttpApi auth** 继续沿原 CLI 和认证路径，由验收入口持有临时目录并显式传入请求。原型保持 225/225，进程自然退出，非 auth 控制组通过。

## Primary-path and fallback verdict

沿原真实 stdio 和 HttpApi 入口修复测试隔离与收尾，复用现有响应关联与清理路径。

## Release verdict

**APPROVE**。仅放行 R2 方案，送审 SHA256 `ee5e80e50a30f2b1407bded51afa4c79cb4865e2c5890c0bcef4dd49c1abad5c`。

### R3 独立方案审计原文

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> - §1 补录“达到可合并质量但不执行合并”和“不要大幅度补测试”两条用户原文。当前设计已覆盖这两项约束。
> - 将失效的旧证据路径指向恢复包及其展开目录，并把 §23 的提交前 Gate 与提交后 push Gate 分工同步到 §18。push Gate 只检查已提交范围，不能代替候选工作树验证。
>
> ## Follow-up
>
> 批准后仅在现有五文件范围内落实 R3。正式候选仍须通过包类型检查、当前 Gate、完整 Auth/Coverage/Effect 验收及真实 Windows runtime CI。上一轮实现审计的验收阻塞仍待关闭。
>
> ## Rejected speculation
>
> Effect 候选曾停在第 83 项附近，但基线与候选各自重跑前 83 项都能退出。现有证据支持恢复组合收尾，不支持把某个 worktree handler 或嵌套资源认定为根因。
>
> ## Requirement and traceability coverage
>
> 核对了固定基线 `0dfffcda`、两份原 CI 附件及现有五文件差分。LSP 两个既有用例从固定等待改为断言真实 stdio 往返回执；原错误及省略回执负控均转红，同一污染目录下完整 12 例、22 个断言通过。Auth 在现有验收入口持有独立临时项目，并由请求构造层传递目录，保持原认证判据和 225 个场景。
>
> R3 的唯一行为增量是恢复 Effect 原有组合收尾。从恢复证据核验：基线 225/225、退出 0；R2 精确候选被外部观察器终止、退出 124；仅改验收入口的处理组先后两次 225/225、退出 0，同组 Auth 和 Coverage 也各 225/225、退出 0。隔离补丁 SHA256 与 §18 一致。本轮生产改动和净增测试实例均为 0。
>
> ## Primary-path and fallback verdict
>
> LSP 沿原客户端和 fake server 的 stdio 请求链；Auth 沿原认证与实例中间件；Effect 按现有模式恢复固定基线的组合收尾。方案没有新增备用成功路径、强制成功退出或超时放宽。
>
> ## Release verdict
>
> **APPROVE**
>
> 批准精确 **R3 方案**，SHA256 `178ca1ecabdcc1a756e0a4b2b174c37811a885c78bff077d44aecb9849e3fe4f`。原样记录裁决后可按 R3 实施；实施完成后仍须独立审计固定基线到最终候选的完整实际差分。

### R4 独立方案审计原文

> ## Blocking findings
>
> ### B-01 §17 的注释方案未达到用户要求的有效行数
>
> - **Violated invariant:** 用户的 E/C 硬门禁要求 `C >= ceil(E × 0.15)`，复述代码的注释不计。
> - **Evidence class:** contracted。
> - **Producer and execution path:** §17 按表实施注释，再对固定基线到最终候选逐行核算。
> - **Source evidence:** `packages/opencode/test/lsp/client.test.ts:63–75` 和 `packages/opencode/test/server/httpapi-exercise/index.ts:2008–2012`。
> - **Canonical-plan evidence:** §17 恰好规划 14 行。注册例“null 是成功回执的空负载”复述紧邻的 `toBeNull()`；其余半句重复 fake server 回传 `error` 的理由。Effect 注释“关闭应用后再清全局路径”复述 `disposeApps().pipe(Effect.andThen(cleanupExercisePaths))`，未解释两步为何要由同一个 finalizer 登记。
> - **Responsibility owner:** §17 注释设计与实施核算。
> - **Concrete consequence:** 当前五文件实际增加 90 行，排除空行、注释和原组合 finalizer 的纯移动，E 仍为 87，最低 C=14。按当前表逐字落地，上述两行不能计入，最多 C=12。
> - **Pre-R1 baseline:** 原组合 finalizer 已存在；其移动不增加 E，也无法用旧代码中已有的顺序解释充当新增有效注释。
> - **Round basis:** R4 新增的明确门禁及注释设计。
> - **Minimal correction direction:** 将上述两行换成有独立源码或实验依据、无法从紧邻代码读出的约束，并更新移动排除账。保持执行代码和测试数量原样。
>
> ## Non-blocking findings
>
> §1 已补齐可合并但不合并、克制增测两条原文。旧证据路径及提交前、提交后 Gate 的分工仍按 R3 建议同步到当前记录。
>
> ## Follow-up
>
> 保留正式候选的包类型检查、当前 Gate、完整 Auth/Coverage/Effect 验收及真实 Windows runtime CI。
>
> ## Rejected speculation
>
> 本轮无需增加测试、调整超时、改写生命周期或扩展文件范围来满足注释门禁。
>
> ## Requirement and traceability coverage
>
> 精确 R4 SHA256 为 `f3a3971d55d41bd9b0c117127ec7dc3d822c9c0defa20587b906c1539759f8bb`。固定基线 `0dfffcda` 到当前五文件行为差分的 SHA256 与 §22 一致。复核了 LSP 往返回执、Auth 隔离项目和 Effect 原组合收尾；R4 未改变这些已审路径，也未扩大两条 CI 的修复范围。
>
> ## Primary-path and fallback verdict
>
> 保持 R3 已批准的 LSP stdio、HttpApi 认证及 Effect 收尾路径。R4 没有新增备用成功路径。
>
> ## Release verdict
>
> **BLOCK**
>
> 修正 §17 的有效注释方案后，递增 revision 并按完整原始范围重审。

### R5 独立方案审计原文

> ## Blocking findings
>
> No blocking findings.
>
> ## Non-blocking findings
>
> 旧证据路径应指向可读恢复包；§18 可明确区分提交前工作树 Gate 与提交后 push Gate。两项均为记录修正。
>
> ## Follow-up
>
> 实施后复算实际 E/C，逐条检查注释是否仍贴近对应改动。包类型检查、当前 Gate、完整 Auth/Coverage/Effect 和真实 Windows runtime CI 仍是正式验收门禁。
>
> ## Rejected speculation
>
> Effect 的隔离实验支持恢复组合 finalizer。R5 的注释说明组合登记能保证两步连续执行，不把某个具体资源的释放认定为实测根因。
>
> ## Requirement and traceability coverage
>
> **R4 B-01 已关闭。** 两条替代注释分别解释诊断注册参数为何进入客户端实际处理分支，以及两步收尾为何放在同一个 finalizer。它们都有对应的源码语义，不复述紧邻断言或调用顺序。规划口径排除原组合 finalizer 的纯移动后为 E=87，最低 C=14；14 行方案可进入实施，实际 C 由实现审计核定。
>
> 已复核固定基线 `0dfffcda` 到当前五文件差分，SHA256 为 `bde09d3df314edc88b56463f8aa95bffe83516f345ffbb29e3ed62449a69931f`，与 R3 相同。LSP、Auth、Effect 的职责、测试数量和验收要求保持原样。
>
> ## Primary-path and fallback verdict
>
> R5 仅修订注释合同。三条既有验证路径不变，未新增备用成功路径。
>
> ## Release verdict
>
> **APPROVE**
>
> 批准精确 **R5 方案**，SHA256 `5235f33b2713f6f1f61f8e335428d5e5cd9a6d6b75820fac4e04f5f8adceb80f`。原样记录裁决后可按 R5 实施；随后对完整实际差分及验收证据开展独立实现审计。

### R6 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§18 可补写提交前工作树 Gate 与提交后 push Gate 的顺序，并将旧证据路径指向可读的恢复位置。R6 实际 E/C 按最终差分复算，R5 的计数只作历史记录。

## Follow-up

正式候选须跑完原 12 例普通及 stock-preload 两套入口，复验初始化失败后的清理、真实 Windows runtime、三组 HTTP 验收、包类型检查与原 Gate。当前两例实测验证的是夹具可行性。

## Rejected speculation

不把全量 Gate 的 643 项失败归给 LSP；不把尚未关联到 Fiber 的 1 秒计时器认定为已定位资源。

## Requirement and traceability coverage

核对了固定基线 `0dfffcda`、两份原始 CI 附件及 R6 隔离证据。独立校验新夹具源码、原观察日志和退出回执的哈希均与方案一致。原逐例检查复现 LSP 子进程与计时器未及时释放；两条原用例改用各自的真实运行时后，在同一进程内通过未改动的 stock-preload，2 pass、4 个断言，退出 0。

方案在测试夹具内处理真实子进程、实例和应用运行时的释放。仍只涉及原五个测试及验收文件，生产代码和 Gate 不变，测试实例净增 0。Auth 目录隔离与 Effect 组合收尾保持已审路径。

## Primary-path and fallback verdict

单一测试夹具持有并释放资源；初始化未完成时沿原 `Process.stop` 释放已获取的子进程，错误继续向外报告。无备用成功路径、放宽超时或跳过检查。

## Release verdict

**APPROVE**

批准精确 **R6 方案**，SHA256 `3c60945e0535056ab689a7610506655d07744289305cccd2358229f570380a1f`。原样记录裁决后可按 R6 实施，最终差分及正式验收须再接受独立实现审计。

### R7 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

把 §18 的隔离日志与补丁路径更新为实际可读位置。Windows 原 runtime job 与 Guard 的 Windows preflight 分别记录，继续使用各自原命令。

## Follow-up

正式候选重跑原 12 例的普通及 stock-preload 入口，核验原错误路径和慢 pull 的结果合并；随后完成三组 HTTP 验收、类型检查、原 Gate 与同一候选提交的真实 Windows runtime job。

## Rejected speculation

本次证据指向诊断调用已经结束后残留的私有等待。无需扩大到并发 `shutdown()`、修改全局计时器或提前取消仍由原聚合器处理的慢 pull。历史全量 Gate 的 643 项失败不归给本次修法。

## Requirement and traceability coverage

核对了固定基线 `0dfffcda` 的 LSP 实现、R7 隔离改动与四份原始日志。原三例在未改的 stock-preload 下从 3 fail 转为 3 pass；完整原 12 例在普通和 stock-preload 入口分别通过，22 和 34 个断言。修复落在决定诊断结果的现有生产调用，测试只观察资源是否释放。原两条 CI 修复、HTTP 场景、诊断期限、公开接口与 Gate 保持既有合同，测试实例净增 0。

## Primary-path and fallback verdict

每次诊断调用只在原结果或错误已确定后，用原 `finish` 清理自己的未完成等待。保留原竞争顺序、慢 pull 合并及其他调用的独立生命周期。无新增备用成功路径。

## Release verdict

**APPROVE**

批准精确 **R7 方案**，SHA-256 `1929700e4d9fbe6cbb66ad52e3f6c1261aa12eb2c4c4b9e44435c3259d5242c4`。原样记录裁决后可实施，正式差分与验收结果仍须独立实现审计。

**R8 草稿差异。** 固定原目标仍为 `0dfffcda2bcd07e28014d1e82270453e3dc586d3` 到整个 CI 候选。补记 INV-08、一个测试文件和实际窄及全文件实测；原 R7 （含 §23 Gate 回执）证据快照为 `38242bef08c6eb37d12580d5f983848932e98f61f1fb67908a08e81b1271529d`，原独立裁决原文保持。R8 设计证据齐备，可按完整原始需求和固定 0dff→整组目标独立方案审计；本轮尚未取得审计裁决。

### R8 独立方案审计原文

## Blocking findings

No blocking findings.

## Non-blocking findings

§19 的测试行数仍引用 R5。§15、§22 和诊断补丁已明确 R8 的唯一增量为 `test/agent/agent.test.ts` 的 `+2/-6`。实施后用固定基线到最终差分的实际统计更新 §19 和 E/C 台账。

## Follow-up

原完整 Gate 仍是发布门禁。R7 实测退出 1，4796 通过、45 跳过、641 失败；R8 隔离实验中，agent 全文件由 44/48 提升到 46/48，仍退出 1。保留 agent 剩余两例和完整 Gate 中 LSP 的 30 秒失败，继续用原入口定位。最终候选须通过原 Gate、真实 Windows runtime 分片、HttpApi 原 Auth/Coverage/Effect 三组验收和独立实现审计。

## Rejected speculation

现有证据支持一处错 owner，不支持把其余 Gate 失败归给 Logger，也不支持按时长给全包的 30 秒资源指定 owner。无需扩大本次删除范围、调整计时或修改 Guard。

## Requirement and traceability coverage

核对了两份原始附件、固定基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`，以及 R8 的完整目标。Windows 两例仍走真实 stdio 请求回执；HttpApi Auth 保留 225 个场景并验证退出；诊断等待由发起该操作的客户端结算。保持单一 PR、零净增测试实例、不修改 Gate，合并由用户决定。

R8 新增范围已有独立可核对的源码与原始回执：`testEffect(...).instance` 经 `withTmpdirInstance` 使用用例局部 Store，文件级 `afterEach` 则经 `InstanceRuntime` 调用全局 Store。隔离补丁只删除后者和两个闲置导入。核验 ABAB 四次退出分别为 1、0、1、0，每次四条断言；全文件两臂均执行 48 例、194 条断言。该证据支持此处删除，也保留了完整验收中的其他失败。

## Primary-path and fallback verdict

保留局部 Store 原有释放路径，移除误用的全局清理调用。原 LSP 与 HttpApi 入口、错误结果和超时预算保持；新增备用成功路径与生产诊断分支均为零。

## Release verdict

**APPROVE**

批准精确 **R8 方案**，SHA-256 `0b15d3fc016dced1b61ff1bbba47a28703d4d182e56f5148d7f920c315ec3b3e`。原样记录裁决后可实施；最终实际差分和验收结果仍须独立实现审计。

**R9 修订。** 原完整 R8 证据与裁决逐字保留（快照 SHA b05bbd793589261645ec9fc60269587ce307d51e58a695863951e565d3b0d826）。保持固定 0dff → Windows LSP／HttpApi 原两个 CI 结果与所有已批约束，只在原 agent.test.ts 增加已实测的 Skill 本地依赖布置（INV-09），不新增路径。前置生产生命周期原型已经被 503／慢 stall 反证排除，收据 dadcea2022b47ab9d24ffe761f6ccc483092f6308d9dc3760d4f111b30679eac，仅作历史诊断。当前为待审的完整方案，尚无实施许可。

R14 · Independent plan audit · 2026-11-21 · audited SHA-256 `1d29997d7d2772d2a83dd8aaf3da182a05939381735db1b5fe4b43cb80d37812`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的「本 Plan 同级隔离证据目录」沿用了历史位置。记录本轮裁决时，建议把该实验标为历史收据，保留校验值。

## Follow-up

按 `27f5f625…` 重跑原完整 Gate。此次 LSP fixture 使 `packages/opencode` 升级为全包测试；保留三平台完整日志、实际选测范围、Windows runtime JUnit 和 Auth 自然退出回执。Linux 先用完整日志确认第二条失败的名称，再判定归属。

## Rejected speculation

R13 夜间建图中的 `httpapi-session.test.ts` 失败不能用来认定正式 Linux 预检中被截断的那条失败。无需据此扩改产品、加计时器或修改 Gate。

## Requirement and traceability coverage

核对了 §1 全部原话、目标 `27f5f625…` 及上游两提交。上游九条 Guard 路径与交付八路径无交集。新基线的原契约入口执行 `schema`、`protocol` 两包；LSP fixture 仍触发全包测试。两条原故障、零新增用例、单提交草稿及用户决定合并的约束均保留。

## Primary-path and fallback verdict

LSP 仍等待真实协议回执并释放本次操作的资源；Auth 仍沿原请求进入隔离项目并自然退出；Skill 仍用原 npm 就绪路径。上游日志和选测变化只影响验收，不新增产品备用路径。R13 的完整 Gate 失败仍待实施验收解决。

## Release verdict

**APPROVE**。仅批准 R14 方案，SHA-256 `1d29997d7d2772d2a83dd8aaf3da182a05939381735db1b5fe4b43cb80d37812`。
```

R15 · Independent plan audit · 2026-11-21 · audited SHA-256 `715d3005ac972e0449a27bc9f61ef3953b26fe8a14c93c173d0866e511c91cda`

```markdown
## Blocking findings

No blocking findings.

## Non-blocking findings

§18 的“本 Plan 同级隔离证据目录”指向历史实验。归档时标明历史版本，保留原校验值。

## Follow-up

R15 实施后，用同一候选跑最新原完整 Gate、真实 Windows runtime 和三组 HTTP 验收。当前窄测覆盖原故障反馈；全包验收仍按选测结果执行 323 个文件。

## Rejected speculation

8aead 的 Core 插件装配变动确实可达 Auth 测试流程。新基线对照已跑通原修法，无需在本 PR 另改 provider 装配、Gate 或计时器。

## Requirement and traceability coverage

核对了 §1 用户原文、目标 `8aead09…`、隔离差分和原始收据。七路径源码差分逐字一致。Agent／LSP 原预载组合由基线 60 项通过但收尾 exit 1 转为候选 60 项通过、exit 0；原 Auth 两侧均汇总 225/225，基线随后卡住、外层 exit 124，候选自然 exit 0。两条原故障、零新增测试、独立单提交和用户决定合并的约束均保留。

## Primary-path and fallback verdict

保留真实 LSP 协议回执、现有诊断等待的资源归属、Auth 原请求与作用域，以及 Skill 的原 npm 就绪路径。无新增备用成功路径。

## Release verdict

**APPROVE**。仅批准 R15 方案，SHA-256 `715d3005ac972e0449a27bc9f61ef3953b26fe8a14c93c173d0866e511c91cda`。
```

## 23. Implementation Evidence

### R19 精确实现回执

批准的 R19 方案 SHA-256 `77063f631e806900aed9fb8ebf98462e941cab3a41596fb088ee1608e2d3df25`。以 `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0` 的官方文件 blob 重建实际差分；五个源码、测试和夹具路径的 full-index diff SHA-256 为 `6f6cffb947a351096a1be98a2b79c17a3693d6c0025f95140e4e4182c976126f`。其中 R17 四个路径与其已验证后像及差分逐字相同（SHA-256 `883298c678fd14d9dc0b8d647c238233b3883cd3cb36d8ea627277e539d481b6`）；R19 只改原 PAT 用例。所有非目标请求返回原传输；同一目标用同一个地址判定 matcher 选取响应和原 RPC 入口记录，另强制断言请求方法、次数及原行为。全局总调用数及给全地址返回 SSE 的旧做法已删除。没有新的实现路径、永久 fixture、测试实例或计时器。

实际五路径物理增删为 +396/−453。R17 四路径 E/C 为 132/20；PAT +20/−10，E/C 为 14/2（去掉两条评论、两条仅调整块关闭形式的行、同一 SSE 语句和改为引用同一地址的原调用行，其余含等价断言重排也计入）。总 E/C 为 146/22，最低要求 22。两条邻近说明分别给出后台流量为何不能消耗本用例响应、为何同目标错误方法仍属于被测流量。

在 `packages/opencode` 用 Bun 1.4.4、原包 preload、仅 loopback 的独立网络环境与 §18 同类临时 ModelsDev/npm fixture，直接运行已修改的原 `test/provider/provider.test.ts`，不再使用临时文件副本或主动背景注入。命令 `bun test --timeout 30000 --max-concurrency 2 test/provider/provider.test.ts`，窄测使用同命令加原用例 `-t`。同一原文件 SHA-256 `fb1a4db445345f944c8d3dc2d136551a409a59097f8148ffcc0e3e8584dd2fb0`。

| 原入口 | 实测 | 日志 SHA-256 |
| --- | --- | --- |
| PAT 窄测 | 1 pass／0 fail，8 断言，退出 0，3.37 秒 | `4663b7bdc3435be54ce6c4cb9bfa3e9989cd0b01fa7fa062962155370ad53d88` |
| 全 provider 文件 | 119 pass／0 fail，333 断言，退出 0，24.01 秒 | `365fc01e76e4c781786cb14037bd40d92bdf89f5c98be629b7aa7ba544046389` |

§18 保留原红、局部绿和重复、错误方法负控。运行脚本、私有 fixture 输出和隔离负控不进入差分。实际差分送独立审计；R19 正式候选 SHA 的原 Windows、三个 HttpApi 模式、Guard/A-B、类型检查、最终提交钩子及恢复校验继续按 §18 取证。


### R17 精确实现回执

独立批准方案 SHA-256 `72b06bb1a8ab43ecb4c3a53aa70241531b5fc9be1f5413ba35e9091351638189`，裁决原文见 §22。只从实际交付父提交 `5bc061bb2a1d3a7ebf16eef076ebaf4a9cc4a9c0` 应用 §15 的四个源码/测试后像。代码 diff 完整 SHA-256 `883298c678fd14d9dc0b8d647c238233b3883cd3cb36d8ea627277e539d481b6`，与 §18 的实际红绿投影逐字一致（60 通过／168 条断言、自然退出）；工作树、索引和原基线的 Auth harness、流程、Gate、锁和配置保持同一字节。原用户需求中的 Auth 仍以当前目标已通过与精确草稿同一 workflow 的复验作为门禁。

| 路径（相对 packages/opencode） | 实际物理 ＋／－ | 逐 hunk 保守 E/C |
| --- | --- | --- |
| src/lsp/client.ts | 61/41 | 22/4 |
| test/agent/agent.test.ts | 30/0 | 24/4 |
| test/fixture/lsp/fake-lsp-server.js | 9/1 | 6/2 |
| test/lsp/client.test.ts | 276/401 | 80/10 |
| 合计 | 376/443 | 132/20 |

此统计移出三个古旧 Auth 路径，四路径前后像及 hunk 与旧台账相同；E 排除空白、import-only、formatter-only、生成和已明确的纯移动，仍保留未判纯移位的边界用作保守上界；最低 C 为 20。对应双向 stdio ID、Child close、该次诊断败方清理和同盘真实 npm link；零净增测试。使用真实回执替代两例历史固定等待与弱连接断言，没有后备成功路线。

仓库根运行原 `check.ts`，以精确 5bc 及五路径为输入，检查四源码文件、零错误零提示、exit 0；首轮空依赖映射缺 @tsconfig/bun、exit 2，恢复同锁只读依赖映射后原样复跑，代码未变。原 `affected.ts` 同输入选择全量 OpenCode 323 文件、always 0，原因是原 fake-lsp-server.js 全局输入路径；均为本地静态检查，未执行全量 Gate。清单 SHA-256 `1b1e62016c3f40217064a24a551e5776f03eb2a007d8ec8b0257f49ca692713b`，原选集 JSON SHA-256 `75d5fc2654acf4e294a1d2b8db75a176fd9b58864d5c8dacc899c50bc15ce99b`。

实际五路径冻结待独立实现审计。候选尚未创建正式草稿 SHA，现行 Windows runtime、候选三模式、原完整 Gate、适用 A/B、类型和最终提交验收按 §18 保持开放。未记录本地 hook 通过。

### R16 精确实现回执

本修订只改变既有 #11 的验证运行位置及草稿发布证据。独立方案审计批准输入 SHA-256 `c23abfa9ffc23dff5bdc29bd2581abfbbbbf584e24f817354fb54888a89b4869`，完整原文在 §22。生产、测试与夹具仍为交付父提交 `8aead09f29652c5acf5004675845873ab1d22a58` 上的七个已验证 postimage，各路径 Git mode/blob 与 R15 完全相同；七路径完整差分 SHA-256 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`，E/C 按同一代码差分为 168/26，测试实例净增为零。沿用 §18 同基线同源码窄红绿、下节同源码的本地静态规则和三模式结果，不把旧候选的命令或 exit 记作本次线上结果。

当前实际八路径完整差分独立冻结，Git diff 检查通过；Gate、GitHub workflow、锁和配置没有变化。现有 Draft #11 索引仅供按 §18 取得正式证据；本修订的独立实现审计、原 GitHub jobs、正式 Gate 与最终 SHA 尚待核对，不记录本地 hook 或当前候选正式测试通过。

### R15 精确实现回执

独立方案审计批准的原始 Plan SHA-256 为 `715d3005ac972e0449a27bc9f61ef3953b26fe8a14c93c173d0866e511c91cda`，裁决原文见 §22。实现从当前基线 `8aead09f29652c5acf5004675845873ab1d22a58` 仅应用 §15 七个源码、测试和夹具文件。七个文件的 Git blob 与 §18 隔离红绿候选逐字相同，文件模式相同；完整 diff SHA-256 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`，物理 +418/−455。按 §26 逐 hunk 去掉空白、导入、注释、纯移动等后，保守 E/C 168/26，门槛 26，保持测试数量不变。注释解释 LSP 双向错误响应、诊断等待归属、Agent 同盘本地依赖和 Auth 测试作用域。未修改 Gate、Core 插件、TUI、锁或配置。

| 核验 | 当前精确范围与结果 |
| --- | --- |
| 原反馈红绿 | §18 所列两臂为当前真实基线与实际交付的七个相同源码/测试 blob。原 Agent/LSP 的 60 项通过但清理失败，候选 60 项全过、自然退出；原 Auth 汇总 225 项后超时，候选相同汇总并在 6.689 秒退出 0。原始清单 SHA-256 `f503e2e53e3ea1d0270742384620b7bb7d713116ac0e27063dd9c74ead4f8655` |
| 当前静态规则 | 仓库根，原 `check.ts . --changed-since 8aead09f29652c5acf5004675845873ab1d22a58 --files "$files"`，锁定 Bun 与现有同锁依赖，八路径输入、七源码检查、0 错误、0 提示、退出 0；原输出 SHA-256 `0c6f5564bd5a18946e13623478ea6da699b26353c2edb6da0dcd12242f094a73` |
| 当前静态选择 | §18 原选择器在当前完整隔离对照上正常退出，OpenCode 全量 323 文件，schema/protocol 契约独立。正式 Gate 尚需记录实际选择范围，不能从静态结果得出通过 |
| 当前原 HttpApi 三组 | `packages/opencode`，按原 `test.yml` 使用 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip`，每组均 225 pass，fail/skip/missing/extra 均为 0，自然退出 0。Auth 对照及清单见 §18；Coverage 4.104 秒，清单 SHA-256 `bc7438ee275b72e039cf9959895fc04a8b18bbb0d59190a16d5f9f544a24b284`；Effect 147.896 秒，清单 SHA-256 `f00c800e974b539e567d5bce2845b2272616c0ffa1d739366e20199ec48e0691`。Coverage/Effect 均核对送审原始树 `8484407c…` 的全部 7,347 个普通文件 blob |
| Effect 观察时限 | 第一轮 Effect 在外层 75 秒停止、退出 124，未收到汇总，仅为观察窗口耗尽；既有正式同类运行耗时 189.915 秒。使用同原命令和参数、只把隔离观察时限改为 270 秒后正常通过；测试内部预算保持原值 |
| 原暂存区提交规则 | 仓库根，Bun 1.4.4、同锁 TypeScript、拟提交中文消息，执行 `bun script/guard/gate.ts commit --message <消息文件>`，在原送审八路径索引上通过，退出 0；收据清单 SHA-256 `7c1a6b1fba20b9dd2230d041343feda72f7b6d076c7ce1e3faf822d5b9c872e9`。它只覆盖 commit-msg 规则，没有创建 Git 提交或运行安装类钩子 |
| 本地完整安装条件 | 仅在回环隔离的可写副本用 Bun 1.4.4 原锁做离线依赖可用性诊断；禁用安装脚本只用于诊断，不抵原钩子。现有候选缓存产生 1,302 条不同的缓存缺失结果、退出 1，锁保持不变；收据清单 SHA-256 `163e3dc91c5ee26d24b6aa0d2b27be29def68ef6b7550b1d6e36c4da6c98f168`。正式验证仍使用原安装脚本，不替换依赖来源或改锁 |
| 初次实现审计 B-01，仍开放 | 原审计对象为 `8484407c…`（八路径差分 SHA-256 `3d7c0b18c2e9f83ed9a6121ed98f4c5a8fbab68e116ec4a6ba3e2dfbdc42fa6c`）。仍缺与当前精确候选绑定的正式 Gate 和真实 Windows runtime/JUnit。此处补充实际本地验收回执，保持实施审计阶段；R14 的型查、契约或其他绿灯只作历史对照 |

原 LSP 轮询中的固定 sleep 与弱断言由真实双向协议回执替代；诊断调用收尾其原等待，Agent Skill 仅准备测试私有的同盘工作区插件。Auth 保留三种原入口和原 Effect 组合收尾，真实认证轮询交还其私有项目 owner。没有新增备用成功路径、计时器或假定通过的跳过分支。

### R14 精确实现回执

R14 全范围独立方案审计批准的输入 SHA-256 为 `1d29997d7d2772d2a83dd8aaf3da182a05939381735db1b5fe4b43cb80d37812`，原文见 §22。实际从 `27f5f6259b43678482bd0f98eb42361e6a768849` 的精确仓库树取出七个已批准的源码、测试和夹具 postimage；每个 Git blob 和文件模式都与 §18 隔离回放、R13 的正式 PR 对照一致。七路径全索引二进制 diff 执行 `git diff --cached HEAD --full-index --binary -- packages/opencode`，SHA-256 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`，物理 +418/−455。逐 hunk 统计沿用逐字相同的 §26，排除空白、纯 import、注释与纯移动；保守 E/C 为 168/26，最低 26。代表性中文注释解释 LSP 两向错误响应归属、Auth teardown 顺序、Agent npm lock 本地链接，未加入 Gate、workflow、锁、配置或测试实例。

原路径保持真实 stdio 和既有挂起诊断等待，移除两条协议用例中固定 sleep 与无关连接断言；Auth 保留原三种模式的场景表和组合释放，只让所属临时项目实际收到 `tui.control.next`；Agent 保留原测试 setup/cleanup 和 npm 依赖判断，仅给既有 Skill 用例准备真实同盘本地包。未增加备用成功路径，§11 的已有分支分类不变。

| 本阶段核对项 | 原入口、工作目录和结果 |
| --- | --- |
| 原 Agent/LSP 红绿 | `packages/opencode`，同一 Bun 1.4.4 和仅回环环境：`bun test --timeout 30000 --max-concurrency 2 --preload ../../script/guard/leak-preload.ts test/agent/agent.test.ts test/lsp/client.test.ts`。27f5 的 60 例通过后，原 `afterAll` 报一条失败并退出 1（6.69 秒）；R14 的 60 例全部通过并自然退出 0（9.05 秒）。收据清单 SHA-256 `fa023e023523446500d99730bae60af13965bc0852f7fc074358ac5b3f5cf583` |
| 最新静态规则 | 仓库根，锁定 Bun 1.4.4、同锁本地只读依赖，执行 §18 原 `check.ts`（27f5、完整八个文件）。实际检查七个源文件，0 错误／0 提示，exit 0；原输出 SHA-256 `4fafbdb667088d4fad620dc1419b923dc55453570c9f9a7ac39994c559677564` |
| 最新选测口径 | 原 `affected.ts` 实跑，PR 常规范围为 OpenCode 323 文件全量；用同一 `36ec378c…` 选择纯基线与候选的 Linux A/B，分别 39/47 个变更路径，两边实际静态文件清单逐项一致（OpenCode 323、Core 161，另六组完全相同）；不等于正式 hosted 回执，也不替代各自契约 |
| 最新原契约 | 仓库根，`bun script/guard/gate.ts contracts`，schema 与 protocol 两组各 0.2 秒通过并自然退出 0。原输出 SHA-256 `4ff386c8f3626216ff4a5c0f07381f3ae3d94dd5fdecf70b39936d886d4aa423` |
| 原包类型 | `packages/opencode`，`bun run typecheck` 执行原默认 `tsgo --noEmit`，20.057 秒自然退出 0，无诊断；收据清单 SHA-256 `34a03edb1d6488ffd7a959dcbd23c843d0153547fac1f0032170a3e55b86313b`。先前单线程运行 150 秒超时，曾报退出 124，按不同运行口径保留 |
| 原 HttpApi Auth | `packages/opencode`，按 `test.yml` 使用 `bun run script/httpapi-exercise.ts --mode auth --fail-on-missing --fail-on-skip`。27f5 的本地对照打印 selected=225 后无汇总，70 秒超过外层限制退出 124；R14 完成 225 pass，fail/skip/missing/extra 均为 0，约 8 秒自然退出 0。收据清单 SHA-256：基线 `566a1efe1902b8a9778e33493cf58a2456ad74f5f5adf41d26a89ea47818127b`，候选 `43a34c7c3d1f875e196f2e630cb1ea515bf784e994a4d6244a7fa26becc28ebd`。旧正式 CI 是汇总后卡住；两个现象分别记录 |
| 原 HttpApi Coverage / Effect | 同一工作目录、原命令和两项 fail 参数，仅按照 `test.yml` 改 mode。两组各 225 pass，fail/skip/missing/extra 均为 0，各自自然退出 0。Coverage 4.334 秒，Effect 148.519 秒；收据清单 SHA-256 `d5c372d0f5002ee9d009b679687e90cb480215dd48a256148ad5b9651f12c90e` |
| 空仓恢复预检 | 首轮实现审计快照 `5336a4a878ad0224dbd311e1fda20d64935f7b9d` 从 27f5 的只读对象库在独立空仓应用补丁复得，八条 Git 文件模式/blob 相同，严格 `git fsck` 通过；87,886 字节的本地恢复包在独立目录解包后通过逐项哈希，SHA-256 `67e08da404a22843b44ca0f463e50fc2ef169381689d6dff84e0e7fafad6da18`。该快照早于本文这次回执增记，七路径相同；最终提交仍需按其精确身份重放 |

本地运行使用现成同锁依赖、隔离临时目录和仅回环网络，HttpApi 使用仓库现有场景及测试 LLM，不改场景或判定。正式 GitHub 三平台 Gate 与真实 Windows runtime 仍要在当前候选与用户修好后最新目标基线复验，另记录实际 checkout、选测范围及原始日志。R13 的正式结果及 27f5 的本地回执分别保留，由独立 auditor 按完整需求审查，不将它们写成新基线的正式绿灯。

### R13 当前目标回执

原样记录的 R13 独立批准绑定送审 Plan SHA-256 `46f8f990782714044ad7999e5e5efc9325840fbe86c40c93bfa55095bc71ff4c`。本次以 98a 固定父提交与 §15 七条源码为准，源差分 SHA-256 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a` 与 R12 逐字相同，前后校验一致。真实修改仍 +418/-455、E/C 168/26（按同一逐 hunk 口径），新增正式测试 0；不改 Gate、锁、workflow 或责任路径。文档仅更新实际回执和引用：逐字需求、已记录独立裁决、技术内容及校验值保持，公开出处采用仓库相对路径、GitHub 工作流及哈希。完整原始证据独立保存。

| 原入口，锁定 Bun 1.4.4、同锁依赖、隔离 HOME/TMP | 2026-11-21 香港时间 | 实测结果 |
| --- | --- | --- |
| 仓库根：§18 原 `check.ts` 完整依赖图（`--changed-since 98a9f13f…`，八实际路径） | 03:52:14–03:52:23 | exit 0，分析七源文件，0 错误／0 提示 |
| `packages/opencode`：原 Skill 与 Reference、原 stock preload | 03:52:23–03:52:27 | exit 0，2 pass／0 fail／2 断言 |
| 同包：原 Agent 整文件、原 stock preload | 03:52:27–03:52:31 | exit 0，48 pass／0 fail／146 断言 |
| 同包：原 Agent→LSP `workspaceFolders` 同进程 stock 回归 | 03:52:31–03:52:34 | exit 0，2 pass／0 fail／2 断言 |
| 仓库根：原 `bun script/guard/gate.ts stop --files "$files"` 默认模式 | 03:52:34–03:52:43 | exit 0，八路径规则通过；原静态选测把 OpenCode 全量交 preflight，两条既有非阻断提示 |
| 仓库根：原 `bun script/guard/gate.ts contracts` | 03:52:43–03:52:44 | exit 0，schema、protocol、client、sdk-next 四组通过。两个构建测试目录仅在子进程有私有临时写空间，原文件不变 |

原命令和工作目录、原 stdout/stderr、终态、工具身份及前后源码差分均独立留存；清单 SHA-256 `0279a187b5dff5a70347d75494d68d3728bf4c91fe1d7a1927148b24ead89070`。完整图、默认 Stop 和四组契约是不同回执；默认 Stop 的输出明确把全量交给预检。未把旧 R12 结果或此次局部结果记为 98a 的原全量 Gate。原完整 Gate、原 benchmark（若当前仓库要求）、真实 Windows runtime（候选 SHA、实际 checkout SHA、目标及 JUnit）、远端 required 和空仓持久回放均未交付，保持 Stage 4 待验。

### R12 实际终态与本轮回执

R12 独立方案批准的送审 SHA 为 `3459c547164bce980e7ede79071d3389452154f0e2270785ae53e893b2b49a4f`；原样落裁决和行政更正后的批准快照 SHA 为 `29d5d5abf5c0f3f3ae0aa39fc60d4f113987973b260e5c0e9c3786adbbb00d4a`。阶段 3 的实际源码只包含 §15 七条批准路径，比较基线 `0b5754df48177fccb05259e705a189df2f50ca2d`；无 Gate、workflow、锁或配置改动。全源码差分为 +418/-455，运行前后 SHA-256 均为 `c27db4dfc0904b67e9eaa66f642c2854270ec756a8a2491f774c5c444890441a`。对照原 R10 精确源码差分 `4990aa1e37f067b65f657bf4f4d3198630007a9944b963aba7e8df83c9998bbe`，其余六个文件逐字相同，Agent 文件唯一变动是把目录链接参数固定为 `"junction"`。无新增生产概念、平台分支、计时器、备用路径或正式测试实例，原 Agent 的全局清理 hook 保留。

**红→绿。** 实施前从最新 0b 重放审核过的 R10 七路径，逐字复核其完整源码差分与本轮原红收据对应。R10 八路径完整图实际 exit 1，唯一是 Agent:676 `test-platform-branch`（1 > 0）。保留原权限测试和原依赖/锁，实施单一目录链接调用后，以下均在同锁只读 donor、Bun 1.4.4、私有 HOME/TMP、仅回环的隔离副本执行；没有改 Gate 或使用新测试覆写。

| 原入口 | 香港时间（2026-11-21） | 实测终态 |
| --- | --- | --- |
| §18 两个原 Skill/Reference 具名用例，原 stock preload | 03:24:34–03:24:38 | 2 pass、0 fail、2 断言，46 项未选择；exit 0 |
| §18 完整 `test/agent/agent.test.ts`，原 stock preload | 03:24:38–03:24:42 | 48 pass、0 fail、146 断言；exit 0 |
| 同一完整 Agent 文件，普通包 preload | 03:24:42–03:24:46 | 48 pass、0 fail、146 断言；exit 0 |
| 原 `defaultAgent…custom agent with mode all` 后接真实 LSP `workspace/workspaceFolders`，同进程 stock preload | 03:24:46–03:24:49 | 2 pass、0 fail、2 断言，58 项未选择；exit 0 |
| §18 原根目录 `check.ts . --changed-since 0b5754df… --files <八条实际路径>` | 03:24:49–03:24:56 | 完整依赖图，分析 7 个源文件，0 错误、0 提示；exit 0。此工作区子门禁不计作正式 Push、全量或 hosted |

原命令、目录、时序、stdout/stderr、exit、工具身份、运行前后源码和唯一行差分独立保留；清单 SHA-256 `2e4357c384790711915867e3605c132d32981b008f2a519175d2eaaab80b5b36`。原 R10 对应红回执 SHA 见 §18。完整源码 E/C 保守界 168/26，达到用户最低 26；沿用独立 R10 对七路径的核算并逐 hunk 核对唯一同一有效代码行替换未改变 E 或 C。排除空行、import-only、纯重排、生成文件与复述；代表性解释保留在 stdio 两向回执、私有诊断 waiter 释放、同盘真包和锁根条目。新增/删除匹配的可执行测试注册 4/4，属于对原有 LSP 条目的就地迁移；实际 Agent 仍 48，LSP 仍 12。

**同源回归和待验范围。** 当前只有一个 Agent 夹具参数从运行时二选一改为文件系统接口已经接受的 `junction`，HTTP 三模式的三个源码文件、LSP 客户端、fixture、测试文件、锁和 preload 均与 R10 正式类型/LSP/HTTP 回执逐字同源。R10 的包类型检查 exit 0、LSP 普通＋stock 各 12/22、Auth/Coverage/Effect 各 225 且自然 exit 0 作为未变路径回归证据；本轮没有在 R12 重新运行这些完整入口。原全量 Stop/Push、契约合并验收、真实 Windows runtime 以及最终单提交空仓持久化仍待正式回执，当前完成的是静态与已列的局部验收。本阶段冻结全部八路径送与原需求同范围的独立实现审计，待验项目不记通过。

### R7 当前阶段 1

本修订只改 Plan，未修改任何固定基线跟踪的源文件；§8 和 §18 的临时红绿及双入口结果是方案准备记录，不是 R7 实施、类型或交付证据。下面保留 R6 及较早阶段的实测和审计原文，不能用于放行 R7。

### R7 当前阶段 3

- 固定基线仍为 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。正式 R7 候选从精确 R6 五文件差分建立，第六条路径只有生产诊断 owner `packages/opencode/src/lsp/client.ts`；其余四条旧测试/验收路径逐字不动，既有 LSP 测试只补边界说明。当前只核对实际实现及回执，未宣布独立实现审计通过。
- 整体候选五＋一文件的 `git diff --binary --abbrev=9 HEAD` 摘要 `b15c69e3014f7c9e8989b48ca14a1aa20c078dea6cbdd7275415af06289503a2`；`git diff --check HEAD` 通过。原始增删 +388/-455，含原测试体和生产循环缩进迁移；测试实例净增 0。按近邻不变项 `git diff -w HEAD` 排除空行、7 条纯导入、22 条有必要的中文说明以及 9 对能确认的纯移动（原测试标题/夹具值/组合 finalizer），记录 E=135、C=22、有效删除 204；把移动也保守计入时 E≤144，最低 C 仍不超过 22。明细 `ec-ledger.tsv` SHA256 `84fba437a99e9495e8c2d5ad47022c3fd88ccf0b868efc94a451c4c5f6c77a04`。代表说明是一个操作多轮 registration，已完成轮次解绑 abort；先订阅真实 child close，避免初始化前退出时错过信号；同一个真实 store 先释放实例后释放本例 runtime。
- 正式重跑原窄 stock red 背景为未改生产的精确 R6：0 pass/3 fail/10 断言，4.97 秒，exit 1；同范围正式候选 narrow green 3 pass/0 fail/10 断言，3.79 秒，exit 0。最终含注释的候选原 stock 全 LSP 12 pass/0 fail/34 断言，6.60 秒，exit 0；普通全 LSP 12 pass/0 fail/22 断言，6.74 秒，exit 0；都没有过滤测试，慢 pull 原例继续通过。未改的 stock 静态入口覆盖其可计数的 5 个文件，0 错误/0 提示，exit 0，不等同完整 Gate。
- 独立诊断负控仍用真实假服务：只让首个 initialize 返回 -32603，该原测试保持失败，后续 register 与空 workspace 原测试正常；对同一已验证空 workspace 用例追加过期 `after` 的 document/full 控制，验证两者仍返回 false，原逐例检查无泄漏。合计 2 pass/1 expected fail、7 断言、3.40 秒、exit 1。该临时测试覆盖不进入正式候选；没有通过修改计时期限来制造结果。
- 香港时间 21:49:25 开始串行重跑精确 R7 的原 Auth、Coverage、Effect。分别以 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip` 在 `packages/opencode` 中执行；三种模式各 225 pass、零 fail/skip/missing/extra、自然 exit 0。原日志 SHA256 分别是 `e20d43fc704a3cdf35e6ce1bcb2d986507d0f28dd431847fc9e09de57811b496`、`d6ba5d6aa18bb6751792d6c991f59ca4cd133e38d410f009c53214463242dc8c`、`39874037002cc4b81be85e96a297bd0e85e01bbf2b577fc78d0ba7310c5e53db`。最终候选差分前后核对一致，保留每个模式的实际退出文件；三种模式的结果不替代原 Gate 或真实 Windows。
- 香港时间 21:52:42–21:54:10，同一 R7 差分 `b15c69e3014f7c9e8989b48ca14a1aa20c078dea6cbdd7275415af06289503a2` 启动并完成原包级 `bun run typecheck --singleThreaded`。实际调用 `tsgo --noEmit --singleThreaded`，原包范围无跳过；启动 7,045,488 KiB 可用，使用 `GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB`。自然 exit 0；原日志 SHA256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`；源差分前后相同。整仓类型、完整 Gate、原生 Windows、独立实现审计仍待完成。

- 原始本地完整 Gate，香港时间 22:00:46–22:20:28。固定 HEAD 与六源差分不变；第七路径为上节 Plan 证据快照（SHA256 `07505abfec5b553425a232419e46493e0adfe0e7872d78fc7ce64aa2ff251a31`）。从候选根以 `GUARD_TESTS=full bun script/guard/gate.ts stop --files "$files"` 执行，`files` 是 `gate-seven.paths` 的逐行逗号连接（SHA256 `dc8767cef24315de3106becda5edbe0ffb8214e38cdc5ad367cee9337644645f`）。七文件规则与静态选择通过、额外防御检查为提示；原入口仅选择 `packages/opencode` 全量，使用未改的原 `leak-preload.ts`。自然 exit 1；4796 pass、45 skip、641 fail，5482 用例／323 文件，Bun 1168.55 秒。外层 raw SHA256 `fcecafa5e8043e87ec0ca1292e8e406c385b6a150fa4d2347d3b30ac15aebff8`，内层完整原失败日志 `r7-gate-native-test.log` SHA256 `6efe50f684305e8251fc5929fda38b679959beaf7f35163d169fdb00472667bd`。
- 641 项中 612 项记录原 guard 泄漏断言（可以与其他错误重叠）。按路径、用例名及两个相同资源栈位与独立 0dff 原 stock 对照严格匹配的只有 3 项 OpenTUI；不归因其余 638 项。同一 Linux launcher 隔离为私有回环、私有 devpts、源／依赖只读、无 `/dev/zero`，Gate 子目录在私有 Git tmpfs；固定基线对照是单文件，完整 Gate 是跨文件同进程，分别保留证据。专用 READ launcher 额外提供 `/dev/zero`，其结果不参与此比较。真实 Windows 不在该次验证内。
- 全包中的 LSP 六条均在原 stock 泄漏断言上失败，无子进程残留或 `ERR_STREAM_DESTROYED`。workspaceFolders、unsupported capabilities、incremental didChange、document pull、workspace pull 五条各有一个 Effect 1000ms timer；document matching push 一条为同调度栈的 30000ms timer。R6 独立六条红测分别在原 `client.ts:463/491` 有 5/10 秒等待，R7 全包六条中未再出现这些原栈位。按路径、名称、时长与栈位匹配，0dff 单文件的 workspaceFolders 与 incremental didChange 已各含同一 1000ms Effect 栈，同时带额外资源；其他四项目的 owner 仍待定位。下一项先在未改原 preload 上用相邻触发文件和 LSP 的 workspaceFolders 做最小跨文件对照，用只观察创建栈和释放顺序的隔离诊断区分当前 fixture 与前序全局资源，再决定是否修订实现方案。全量 Gate 仍失败；原生 Windows 和独立实现审计未完成。


2026-11-20 20:06:15–20:07:29 香港时间：精确 R6 五路径差分 `f7748dc7e321b5f04d66a6e5f234c6691d89a52bd10ddd2cc1866fffa64a337a` 前后相同。在 `packages/opencode` 运行 `bun run typecheck --singleThreaded`，入口实际执行 `tsgo --noEmit --singleThreaded`；环境 `GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB`，启动可用内存 7,168,256 KiB。包原范围无跳过，exit 0，原日志 SHA256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`。此项覆盖同一候选的包级类型检查；现有 R6 stock LSP 六项失败、完整 Gate 与真实 Windows 结论不变。

### R6 阶段 1 证据边界

当前独立副本只改本 Plan，未实施 R6。R5 私有候选仍为固定 HEAD 的原五个 harness 文件。Linux 独立 Auth、Coverage、Effect 各 225/225 且 exit 0，普通 LSP 12/12；包级原类型检查完成 exit 0。原 Gate 全量失败，详细原输出 `r5-gate-full.log` SHA256 `a141ef1533a73ec777d02dd73309bbf953e8b5b06bd3b8bf29df23d5f1e72546`；以原 runner 汇总为准：4794 pass、45 skip、643 fail，323 文件、5482 用例。没有分类并独立对照的 643 项不归因给任何一个 owner，也不把 Linux 接受为 Windows。真实 Windows 尚无候选 ref，未通过阶段 4。

### R6 阶段 3 实施证据（候选未冻结为送审实现）

- 在独立工作树按固定 Git HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3`，只按 R6 替换 LSP 测试的夹具所有者，12 个现有用例与断言不删。原 R5 中其余四个路径逐字不变，包括真实 fake stdio 路由与 HTTP 三文件。当前五路径严格差分 `f7748dc7e321b5f04d66a6e5f234c6691d89a52bd10ddd2cc1866fffa64a337a`，LSP 测试文件 SHA256 `a361517e6e8eeaa16fd72cd0cc451c753e93c4553eda1b4e086548974b0f9907`；生产、Gate、超时、测试实例净增均 0，`git diff --check HEAD` 通过。包含原协议体缩进迁移的原始增删为 +325/-414，纯移动另核，不能以此代替最终 E/C。
- 原 stock 入口 red：未编辑的精确 R5 0 pass/12 fail，34 断言，3.89 秒，exit 1，日志 `7a0db88d7219eff0e4c5c507ff89a8d40d8c7edabb5c892fe28a0a810fa265e5`。R6 原普通入口 12 pass/0 fail，22 断言，5.93 秒，exit 0，日志 `3aaede7db50d5cf0ae41247bf412780ed0736971e47a699bc3dd6738a8181279`。原 stock 入口真实结果是 6 pass/6 fail，34 断言，6.75 秒，exit 1，日志 `5d350a0277830bea27e4e2374990a344637b5d7ef66d1f4b110d78d4a0f1df6e`；未报告子进程或原 1/60 秒资源。
- 六个剩余失败独立记录：document mode falls back to push diagnostics、document mode accepts matching push diagnostics published before waiting 是注册监听 `client.ts:463` 的 5 秒 timer；document mode waits for pull diagnostics、document mode does not wait for the slowest pull identifier after current-file diagnostics arrive 是 `client.ts:491` 的 5 秒 timer；full mode includes workspace pull diagnostics、full mode treats an empty workspace pull response as handled 是同处 10 秒 timer。现有 `Promise.race` 返回之后不会取消失败方；文档/工作区 pull 直接成功时也会绕过已建立的 push waiter。现有 shutdown 关闭连接与子进程，公开接口无取消这些监听或 timer 的方法。该 owner 不属于批准的测试夹具变更范围，不修改生产、计时、等待预算或 Gate 来消除结果。
- 原初始化失败的隔离负控用真实 fake server 对第一条 initialize 返 -32603；首例按原失败路径报错，下一个 register 用例通过；没有额外泄漏或 between-tests 异常。1 pass/1 expected fail、3 断言，3.81 秒、exit 1，日志 `e47dde2f9657237c460cdb5e95129e7b4570b348a7b8223be2fd3a3962f04360`。负控只在单独临时副本，不进入候选。
- 精确 R6 的 Auth、Coverage、Effect 均 225 pass/0 fail/skip/missing/extra、自然 exit 0。既有命令为 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip`，在 `packages/opencode` 内运行。原日志 SHA256 依次为 `e20d43fc704a3cdf35e6ce1bcb2d986507d0f28dd431847fc9e09de57811b496`、`d6ba5d6aa18bb6751792d6c991f59ca4cd133e38d410f009c53214463242dc8c`、`39874037002cc4b81be85e96a297bd0e85e01bbf2b577fc78d0ba7310c5e53db`。整仓类型、完整 Gate 和真实 Windows 尚无精确 R6 通过回执（包级类型见本节起始记录）。不得将本阶段失败的候选移交为已验证实现；若要改变诊断 waiter 的生产生命周期，先修订单一 Canonical Plan、获得范围许可并重审。

### R5 当前精确实现

- 固定基线为 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。五个测试/验收源文件的严格差分 SHA256 `a87303eaa87f4d1b6985fd8a6d8d343e438bb2154c5c348831df2d0896b85c73`；`git diff --abbrev=9 --binary` 生成该输入。实际 +103/-42，生产文件与测试实例净增均为 0，`git diff --check` 通过。
- 仅新增 §17 授权的 13 行注释；逐文件移除这 13 行可还原 R3 字节，R3 差分 SHA256 `bde09d3df314edc88b56463f8aa95bffe83516f345ffbb29e3ed62449a69931f`。五文件验证按前述原差分校验。固定基线实际 E=87、C=14；新增侧排除 1 空行、14 说明行、1 原组合 finalizer 纯移动，删除侧有效行 39 单列。代表例子：注册参数到达诊断分支、组合收尾防止另一释放步骤插入。
- 从 `packages/opencode` 用同锁隔离副本复跑精确 R5：原普通 LSP 12/12、22 断言，3.548 秒 exit 0；真实 Auth 原挂起窄用例 1/1，5.462 秒 exit 0。当前规则检查 exit 0、0 错误；JS 不在此静态统计。Prettier 对现有 `index.ts` 的 10 处差异在固定基线及 R5 的去/加内容逐字相同且全部在正式变更之前，保留基线排版。
- 正式 R3 的可执行代码与 R5 可逐字还原。R3 精确副本 Auth、Coverage、Effect 各 225/225、exit 0，用时 7.902／3.284／200.067 秒；同包 `bun run typecheck` exit 0，25.984 秒。保留当前验证口径和哈希，不把它们登记成注释后的完整正式运行。
- 原 Gate 策略和泄漏检测保持不变。R2 的 450 秒全量工作树 Gate 被外层终止；相同检测器下基线与候选的 12 个 LSP 失败相同，另一个 write 样本两边各 4 个资源断言失败，不能为其余全量失败归因。精确 R5 提交前工作树 Gate、独立实现审计、正式提交后的 push Gate、整仓类型及真实 Windows runtime 仍是独立门禁。目前未提交，未发布。


本节为 R2 历史实现与审计依据，不能作为 R3 的实施或验收结果。R3 当前只有第 18 节的隔离实验；正式候选尚未按 R3 修改。

### Actual Files and Diff

R2 五个批准测试harness文件已实施：fake server +7/-1、client.test.ts +46/-29、backend.ts +13/-3、index.ts +11/-2、runner.ts +7/-7，合计+84/-42。生产0，新增测试实例0；原LSP12例及auth225场景保持。另留固定 0dff 到候选的完整差分。排版展开导致行数高于估算，行为、文件与批准设计一致。

### Red-Green Test Evidence

实施前重跑原污染cwd反馈，原 LSP 红日志为0pass/2fail/1error、exit1、39.37秒；两批准LSP文件落地后，同污染cwd跑完整12例，`lsp-green.log/.exit`为12pass/22断言、exit0、4.12秒。最终源文件的外部错误回执负控`lsp-negative.log/.exit`两例均失败，exit1、4.79秒；该preload及副本只在外部证据目录。

实施前原auth单next CLI输出1pass后仍不退出，外部25秒诊断终止exit124，`auth-red.log/.exit`。随后批准三文件落地，原auth全225与coverage全225均0fail/skip/missing/extra、exit0，分别为`auth-green.log/.exit`及`coverage-green.log/.exit`。

### Verification Commands and Results

命令工作目录均为`packages/opencode`，Bun1.4.4；BASH_ENV保持login shell能找到同Bun，OPENCODE_DISABLE_LSP_DOWNLOAD与OPENCODE_DISABLE_MODELS_FETCH为true。LSP使用原30000ms预算，`bun test --timeout 30000 --preload <外部slow-cwd.ts> <完整client.test.ts路径>`；auth/coverage使用`bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip`。git diff --check通过。完整Effect同入口225/225、0fail/skip/missing/extra、exit0，原 Effect 绿日志及退出码。

首轮全包`bun typecheck --singleThreaded`在GOMEMLIMIT900MiB/GOGC10/GOMAXPROCS1下遭native tsgo SIGKILL，返回1，原日志`typecheck.log/.exit`。只读核对发现两个共享auth依赖的peer指向旧pr8树packages/plugin；锁中版本/integrity逐字一致，26文件SHA逐项验证后仅将本树node_modules中的两包物理私有化，peer现解析本树packages/plugin。证据为`private-auth-packages/manifest.json`、`plugin-peers-before.log`与`plugin-peers-after.log`，五个候选源文件SHA保持。类型复跑等待独占窗口，尚未宣称解决。

原worktree `GUARD_TESTS=full bun script/guard/gate.ts stop --files <五文件>`规则通过，静态图选中opencode全量；末次可见13m30、2242/~2429、379失败，连续30秒增加一个失败。协调器指定14分钟诊断边界后对本轮session发Ctrl-C，工具返回130。原进度`gate-stop.log`及中断说明`gate-interruption.txt`保留；Gate父进程内部逐例缓冲未正常落盘，本轮归为未通过/有界终止，不把失败全部归到共享timer。随后单独原`bun script/guard/gate.ts contracts`四包schema/protocol/client/sdk-next均通过，`contracts.log/.exit`为0。后续正式完整Gate仍须重跑。

现行push Gate只检查since..HEAD已提交range，当前尚未commit；实施阶段使用原stop --files五文件与contracts验证实际工作区，最终提交后再执行push层，不能用0文件range冒充候选验收。

### Original Feedback-Loop Result

原Windows CI及auth挂起日志保留。Linux同源冷启动红→完整LSP绿和完整auth退出绿已取得；真实Windows原分片待CI发布阶段。

### Actual Secondary and Replacement Path Inventory

保持§11批准分类，全部测试通过原stdio/HttpApi路径；auth模式目录传值属于主合同分支；外部负控不进入仓库。删除两例100ms等待与connection弱断言，删除五例cwd耦合。index中一条中文注释说明scope逆序释放约束。

### Remaining Unverified Items

真实Windows候选回归、正式类型/门禁、独立实现审计及发布待继续执行。基线共享timer守卫问题按Follow-up保持可见；全量Gate本次失败尚未逐例归类。

私有peer修正后的原范围类型检查只重跑一次：`bun typecheck --singleThreaded`，Node24.22.3/Bun1.4.4，native tsgo SHA256 `bd22808f4476437b42f023be45f76a761d536f06988e818dc2ad8fbeb7fc0b62`。环境GOMEMLIMIT900MiB/GOGC10/GOMAXPROCS1，TMPDIR 使用独立可写磁盘临时目录。56.60秒后native SIGKILL，包装器exit1、无类型诊断，峰值RSS2,386,216KiB；保留原类型检查日志、资源记录和退出码。当前类型检查未通过，按协调器安排停止同条件重试并提交独立实现审计，后续资源/Guard验证继续作为开放门禁，不声明verified或complete。

### R8 阶段 1 的试验边界

生产、正式候选与 Gate 未改，只有可销毁的只读执行快照独立变更 agent 测试钩子。§18 的 A/B 只证明文件级错 owner 与已观测跨例失败，不是 R8 正式实施、不替代 Windows 或完整可合并验收。


### R8 阶段 3 的精确候选和轻量实测

- 固定 HEAD `0dfffcda2bcd07e28014d1e82270453e3dc586d3` 及 R7 六文件不变；在只读执行隔离中先跑原窄红，随后只落批准的 `test/agent/agent.test.ts` 的测试文件级 hook 删除和两处闲置导入。差分 `fe92a8a7fbb4fb9259f5d2bd0ea814c4ae93801f3366dc3bbe53110b5fa23f95`，七个代码路径，+390/-461；其中 Agent +2/-6，新增两行仅 import，删除三条有效 hook 行，一空行，E=135/C=22，实际有效删除按同一账本为 207。不改原 Gate、计时、协议、真实逐例实例层与测试计数；`git diff --check HEAD` 通过。
- 香港时间 22:40:59–22:41:03，按 §18 命令在空环境原始 LSP 与 Agent 同进程，应用批准变更前：两条原 1s 失败，0/2、4 断言、exit 1、3.87s；同工作树实施后 22:41:31–22:41:35，2/2、4 断言、exit 0、3.15s（用例与原 stock preload 原样）。
- 同一精确候选、不筛测试：原 stock LSP 12/12、34 断言、6.78s、exit 0；普通 LSP 12/12、22 断言、7.43s、exit 0。原 stock Agent 全文件 46/48、194 断言、4.12s、exit 1，仍是已知 skill-directory 20 秒安装锁心跳与 project-reference 10 秒 JS retry。未从正式入口排除。全包原 30 秒现场仍未归因。
- 原始过程、逐臂时间与退出收据、七代码文件差分及八路径 Gate 清单独立保留，原执行材料清单 SHA256 `144c184406cc748b7bb42b6e1eb6498cc405c8806e67f75b263fdfff61d2ee1d`。完整 Gate、真实 Windows 及独立实现审计仍待推进。
- 香港时间 22:43:31–22:46:31 在精确七代码文件候选（`fe92a8a7fbb4fb9259f5d2bd0ea814c4ae93801f3366dc3bbe53110b5fa23f95`）用原 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip` 串行逐模式实跑。Auth、Coverage、Effect 各 225 通过、fail/skip/missing/extra 各 0、各自然 exit 0。日志依次为 `e20d43fc704a3cdf35e6ce1bcb2d986507d0f28dd431847fc9e09de57811b496`、`d6ba5d6aa18bb6751792d6c991f59ca4cd133e38d410f009c53214463242dc8c`、`39874037002cc4b81be85e96a297bd0e85e01bbf2b577fc78d0ba7310c5e53db`；文本结果与 R7 完全一致，但本次各有独立启动、结束与退出收据。
- 香港时间 22:46:31–22:47:58，精确相同候选在原 `packages/opencode` 运行 `bun run typecheck --singleThreaded`，实际 `tsgo --noEmit --singleThreaded`、全包范围无跳过。启动空闲 7,132,580 KiB，`GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB`，自然 exit 0。日志 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`，前后七代码路径一致；四项独立证据清单 `r8-exact-http-type.sha256` SHA256 `f18b5c6aff22d1ea3d54e94b8195e33112d67f42d3ce4e92efadccd8b9548b05`。

- 香港 22:49:53–23:08:36 运行原完整本地 Stop，七个代码文件差分仍 `fe92a8a7…3f95`，八路径第八是本 Plan 冻结版 `bfcd3624…a52c`。原根目录 `GUARD_TESTS=full bun script/guard/gate.ts stop --files "$files"`，其中 `files` 为 `gate-eight.paths` 的逗号拼接，未改原 guard、锁、preload 和隔离配置。原规则/选测试通过，附加规则为提示；`packages/opencode` 全组自然 exit 1，4829 pass／45 skip／608 fail，5482 项／323 文件／1108.73 秒。外层 raw SHA256 `61eca3357e69958bc5123e5dcc4b35fbd6b9eec4faf1c5364a9a051605867080`；内层原失败日志 `042969ba176da332f5ec3f91b6e3e312f0e1760f3233059691542036bcc1a56c`。守卫输出和比较全记录 R8 原全量 Gate 校验清单 SHA256 `96131f6f33d76dcc66beadf7047636de33bcfc391ed2be505a6566186b2d96c1`。
- 同一原 profile 的 R7/R8 按路径与用例名对照：两边同失败 407 条，R7 独有 234，R8 独有 201；R8 608 条里 582 带原泄漏断言。不能按总数差 33 建因果。R8 全包四个 LSP 失败是 registerCapability、workspace/configuration、matching-push、fast-pull 不等最慢 identifier，均为原 Effect 通用栈的 1 秒计时器，无 child 泄漏。R7 的 matching-push 30 秒本轮换成 1 秒，workspaceFolders 本轮通过，30 秒仍未找到 owner。R8 agent 全包只见 legacy tools config 的 1 秒；独立全文件仍有 20/10 秒两条失败，两入口分别保留。完整 Gate 未过，真实 Windows 和独立实现审计仍待执行。

### R9 第三阶段精确候选记录

- 固定基线：`0dfffcda2bcd07e28014d1e82270453e3dc586d3`。送审 R9 方案快照 SHA-256 `67395045408ad08839f0c984a6b767f53ddd9efb60666d423303f30078924224`；加入原样裁决后的获批方案 SHA-256 `e66c5063c9570c95490be6d7e8410deead07ce4928025b09861e8a4744098e36`。实施仍在第三阶段，未送第四阶段。
- 固定基线→候选的七路径全索引二进制差分为 R9 原源码差分，SHA-256 `e04294be5f5d9476c13fbe5f975feb858f7c7ee16e31b53894b3268f35d232f7`，`git diff --check` 通过。路径与物理新增/删除如下；本 Plan 单列。

| 路径（均在 packages/opencode） | 新增/删除 | 保守 E/C |
| --- | --- | --- |
| src/lsp/client.ts | 61/41 | 22/4 |
| test/agent/agent.test.ts | 32/6 | 24/4 |
| test/fixture/lsp/fake-lsp-server.js | 9/1 | 6/2 |
| test/lsp/client.test.ts | 276/401 | 80/10 |
| test/server/httpapi-exercise/backend.ts | 14/3 | 13/1 |
| test/server/httpapi-exercise/index.ts | 20/2 | 16/4 |
| test/server/httpapi-exercise/runner.ts | 8/7 | 7/1 |
| 合计 | 420/461 | 168/26 |

- 保守 E/C 用 `git diff -w -U0` 对照固定基线，E 排除新增空行、导入和注释；保留可能属于原样移位的行，故是新增有效行的上界。C 按新增且说明清理职责、作用域排序、协议契约及跨盘约束的邻近解释计数。仓库 Workflow 的注释按语义计；本次会话的 15% 门槛为 26，本候选实算 26。R8→R9 只新增原 Skill 用例的本地依赖素材、链接、清单及锁（两条新增导入排除，E=24/C=4）；其余六条路径与冻结 R8 逐字一致。R9 唯一源增量 SHA-256 `f23658be869ca135940118036ccb5b74e635662db750075b0c6c176ed04398f6`，可执行行与放行的同盘投影逐字一致；新增三条邻近注释解释首次配置读取前的准备、插件 exports 指向源码、锁中链接身份。
- 固定 no-egress launcher、Bun 1.4.4 和原 stock preload。在 `packages/opencode` 运行 `bun test --preload ../../script/guard/leak-preload.ts test/agent/agent.test.ts --test-name-pattern 'skill directories are allowed for external_directory|project reference directories are allowed for external_directory'`：冻结 R8 实际退出 1（1 pass / 1 fail，4 断言，Skill 的 20000 ms 资源断言；reference 此次通过）；R9 退出 0（2 pass / 0 fail，4 断言）。历史可重复双红记录另存，不与本次混写。
- R9 去掉名称筛选复跑原全文件，48 pass / 0 fail / 194 断言，退出 0、5.92 秒。三组原始命令、stdout、原生日志、退出码和时间分别留存于 R9 红、绿及全文件执行回执。新增正式测试实例 0，原断言保持。
- 精确 R9 源码 SHA-256 `e04294be5f5d9476c13fbe5f975feb858f7c7ee16e31b53894b3268f35d232f7` 已跑完原 Auth 和 Coverage。使用原 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip` 在 `packages/opencode` 中运行，两者各 225 pass / 0 fail / 0 skip / 0 missing / 0 extra，自然退出 0。Auth 香港时间 00:59:24–00:59:34，日志 SHA-256 `e20d43fc704a3cdf35e6ce1bcb2d986507d0f28dd431847fc9e09de57811b496`；Coverage 00:59:34–00:59:37，日志 SHA-256 `d6ba5d6aa18bb6751792d6c991f59ca4cd133e38d410f009c53214463242dc8c`。原命令、stdout、时间及退出码分别留存于 R9 Auth、Coverage 的两组 225 项原回执。
- 同一精确源码的原 Effect 模式于香港时间 01:06:37–01:09:27 完成：225 pass / 0 fail / 0 skip / 0 missing / 0 extra，自然退出 0。完整命令、日志、stdout 和时间留存于 R9 Effect 原 225 项回执；日志 SHA-256 `39874037002cc4b81be85e96a297bd0e85e01bbf2b577fc78d0ba7310c5e53db`。
- 精确 R9 原包类型检查在香港时间 01:10:05–01:11:24 自然退出 0（79 秒、零诊断）。原命令使用同一只读依赖挂载，`GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB bun run typecheck --singleThreaded`，实际执行 `tsgo --noEmit --singleThreaded`。启动时 MemAvailable 7,297,832 KiB、可用盘 6,082,692 KiB；运行前后七路径差分 SHA-256 均为 `e04294be5f5d9476c13fbe5f975feb858f7c7ee16e31b53894b3268f35d232f7`。原日志 SHA-256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`；命令、stdout、开始与结束时间和实际退出码留存于 R9 原包类型检查回执。完整 Gate、同一候选真实 Windows runtime、第四阶段独立裁决与交付仍待实际回执。本次只补证据，不修改生产、测试、Gate 或配置。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 等待第1轮 | R2 | 完整原需求与固定0dff到当前五文件diff | 未裁定 | 未裁定 | implementation-audit-required | 待独立调用 |

### R2 独立实现审计第 1 轮原文

## Blocking findings

### B-01 当前候选仍缺通过的完整 Gate、类型检查和真实 Windows 验收

- Violated invariant: R2 §18 的正式验收要求。
- Evidence class: observed。
- Producer and execution path: 候选五文件 → 完整 Gate、全包类型检查、Windows 原 runtime 分片。
- Source evidence: 原 Stop 日志 最后记录 2242/~2429、379 项失败，随后中断退出 130；`typecheck-private.log/.exit` 显示 `tsgo` 遭 SIGKILL、退出 1。无真实 Windows 候选通过记录。
- Canonical-plan evidence: §18、§23。
- Responsibility owner: 候选集成验收。
- Concrete behavioral consequence: 本地用例已证明两条修复路径，但当前候选尚不能标记为可合并。已有日志也不足以给 379 项失败逐一归因。
- Minimal correction direction: 在足够资源下对目标和候选保留完整 Gate 失败明细，完成原范围类型检查及真实 Windows 分片，使用最终候选的结果重新送审。

## Non-blocking findings

五个测试与验收文件合计 +84/-42，高于方案估算，但改动仍在批准的目录、请求回执、参数传递和收尾路径；生产文件及新增测试实例均为 0。

## Rejected speculation

不把类型检查进程退出解释成已发现类型错误，也不预判 Gate 失败全由共享计时器造成。不提高预算、不跳过失败、不强制成功退出。

## Requirement and traceability coverage

两个原失败 LSP 用例等待实际 JSON-RPC 回执，断言临时项目 URI 和注册结果，失败时走 `finally`。相同污染目录反馈由 2 fail/1 error 转为完整文件 12 pass、22 断言；错误回执负控仍红。HttpApi 原入口由报告后挂起转为 225/225 自然退出；coverage、Effect 同入口均 225/225。`git diff --check` 通过。

## Primary-path and fallback verdict

两条修复沿原 stdio 与 HttpApi 路径。目录归各自现有测试入口持有；auth scope 先关闭应用，再删除临时项目。无新增成功回退。

## Code quality and Chinese-comment verdict

已有中文注释解释 scope 的逆序释放原因。参数只在测试与验收现有接口传递，生产、配置和超时不变。

## Release verdict

**BLOCK**。送审完整 diff SHA256 `c87b3ad61d2ca5acbb281ebe4965c9c4ac6d72d2e4a677972533000fa007f14f`。

### R9 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§19 的测试行数仍引用 R5，§21 的审计摘要停在 R8。实施记录中按固定基线更新实际差分、E/C 和 R9 两条原用例的复验命令。现有 §10、§13、§15、§16 已给出可执行的范围及行为映射。

## Follow-up

保留原完整 Gate、同一候选的真实 Windows runtime 分片、原 HTTP Auth/Coverage/Effect 三组、全包类型检查和独立实现审计。R8 全包的 1 秒与 30 秒资源记录仍是正式验收输入，不能以 R9 Agent 单文件通过替代。

## Rejected speculation

R9 的证据支持修正 Skill 测试的私有依赖形态，范围止于实际用例。没有证据要求改变产品 npm 安装生命周期、全局配置、重试或 Gate。

## Requirement and traceability coverage

独立核对两份原始附件：Windows 的两个具名 LSP 失败及跨例错误，HttpApi Auth 的 225/225 后取消。固定基线 `0dfffcda…` 到完整候选分别保留真实 stdio 往返、Auth 自然退出、原 Effect 组合收尾、诊断等待释放与相同用例数量。新增 Agent 布置仅落在原 Skill 用例；独立校验原回执集合及 portable 投影，确认原 Agent 文件 48 通过、0 失败、194 条断言、退出码 0。Windows junction 和完整 Gate 留给精确候选验收。

## Primary-path and fallback verdict

保留真实配置和 npm 的原就绪路径、LSP 与 HttpApi 的原入口及错误合同。测试私有目录、真实局部 runtime 和诊断等待各由原 owner 收尾，无备用成功路径。

## Release verdict

**APPROVE**，仅批准精确 **R9 方案**，SHA-256 `67395045408ad08839f0c984a6b767f53ddd9efb60666d423303f30078924224`。正式实现和发布仍依各自门禁验收。


## 25. R10 最新基线差异和阶段门禁

- 原始固定缺陷基线继续用于需求归因；`0b5754df48177fccb05259e705a189df2f50ca2d` 是本轮固定集成基线，tree `f1a5c66ebe5c8b423b84ba7d316fceee9e29d876`。两提交 32 路径与旧七路径及 Plan 无交集；私有索引重放旧 R9 补丁逐字相同，无冲突。旧 R9 同基线的完整证据另以 `R9-prior-stage3.snapshot.md`（SHA-256 `4ede2904f0cfd5fea5f86c29c96c059c3824483af181c9468c38801f10547659`）保存；旧 Auth/Coverage/Effect 以及包级类型 exit 0 不计作本轮验收。
- 原 Guard `leak-preload.ts` 已从逐例报告切换为整轮 `afterAll`，排除 `hasRef() === false`，检查仍会阻止退出的剩余资源。最新 blob `b000b0bfec035161a3df2d32f951daf33bd0da70`；A/B 共用该 blob、相同 Bun 1.4.4、原包 preload、只读依赖、无外网。原 Skill/Reference 两例保留原断言：A（无 Skill 准备）窄测两项与全文件 48 项原测试均通过，但两臂 A 运行均额外在真实门禁的 unnamed afterAll 留下 20s 与 10s 计时器、exit 1；B（仅 Skill 准备）2/2、48/48 均 exit 0。保留 Skill 私有准备。
- 保持 Skill 布置，仅还原原 Agent 全局 hook 和两处导入：新 stock 的原 Agent 全文件两臂均 48/48、146 个断言、exit 0，原 defaultAgent→LSP workspaceFolders 前序组合两臂均 2/2、2 个断言、exit 0。R10 不带旧 hook 删除。该结论覆盖当前实测路径，不外推到全部测试顺序。两组原命令、日志、退出回执和差分按上述完整 Agent 与已知前序两组分别留存；拟定七路径源码重放差分 SHA-256 `4990aa1e37f067b65f657bf4f4d3198630007a9944b963aba7e8df83c9998bbe`，只作方案阶段小对照。
- Windows `.github/workflows/test.yml` blob `498a8a9a0aa743750cc780dd57721a53db127004` 与旧基线逐字相同；原 `opencode-windows-runtime`（原 run 44608985562、job 135860195310）继续作为正式验收，使用确切候选 SHA 和原分片。PR 事件的合成 merge ref 与候选 SHA 分别核对；需要 exact checkout 时，在已授权的候选 ref 上使用原 workflow_dispatch。新的 Guard 平台预检与原真实 Windows 分片分别记录。当前没有候选的真实 Windows 回执。
- 其他保留路径：真实 stdio 两例回执和子进程收尾；生产诊断等待的现有 owner；HttpApi Auth 私有实例与 Effect 的原组合释放；原三模式各 225 场景、原类型检查、全 Gate。实现和本地验证依次走最新 Gate stop、完整原三模式、类型、窄与相邻回归；再独立按完整源码差分审计。交付分支仅一个提交；真实 Windows 和精确 push Gate 只能用最终候选验收，不直接合并。§16 原第5切片、§18 历史逐例 Guard 和 §23 历史验证均不作 R10 放行输入。

R10 状态为 audit-required / Approved revision: none / Implementation allowed: no。旧 R9 approval 不授权此修订实施。

### R10 独立方案审计裁决（原文）

## Blocking findings

No blocking findings.

## Non-blocking findings

§7 的 INV-06 仍写「逐例泄漏门禁检测所有资源」。§25 已明确最新 Gate 在整轮 `afterAll` 检查仍会阻止进程退出的资源；建议把 §7 旧表述标为历史。

## Follow-up

按最新目标复验完整原 Gate、真实 Windows runtime、三组 HTTP、类型检查和独立实现审计。旧基线结果与当前窄对照均不替代这些验收。

## Rejected speculation

最新 Gate 下，带原 Agent 清理钩子的对照与删钩子的对照均通过。没有证据要求把旧钩子删除纳入交付。

## Requirement and traceability coverage

核对了原 Windows LSP 和 HttpApi Auth 两项需求、原始固定基线 `0dfffcda…`、最新集成基线 `0b5754df…` 与完整七路径隔离差分。新 stock 对照保留原测试：未准备 Skill 依赖时，两组在整轮收尾报告 20 秒和 10 秒定时器；仅准备该用例的私有依赖后，两例及全 48 例均通过。恢复原钩子后，Agent 48 例和已知 LSP 前序两例仍通过。零新增测试实例，Gate 不改，交付为一个提交，合并由用户决定。

## Primary-path and fallback verdict

LSP 仍走真实 stdio，诊断等待由当前调用释放。Auth 保留原场景并由私有实例收尾；Skill 仍走既有 npm 就绪路径。没有新增备用成功路径。

## Release verdict

**APPROVE**，仅批准精确 **R10 方案**，SHA-256 `fffe142f3e8bdacef82cc694e74f415549623ada97e5095d463bc821bf511994`。


## 26. R10 第三阶段精确候选冻结

- 独立批准的原方案 SHA-256 `fffe142f3e8bdacef82cc694e74f415549623ada97e5095d463bc821bf511994`；仅写入裁决后的批准快照 SHA-256 `ad43b7596f1a886859222201061f4320cc9123c3e95b31517a9a58c52b7cb9c5`。提交目标基线 `0b5754df48177fccb05259e705a189df2f50ca2d`；当前仍为第三阶段，未送第四阶段。
- 冻结七路径的实际全索引差分逐字匹配隔离的批准方案对照，SHA-256 `4990aa1e37f067b65f657bf4f4d3198630007a9944b963aba7e8df83c9998bbe`。原 Agent hook 与其原导入完全保留；仅增加既有 Skill 用例所需的本地依赖准备。无新增测试、依赖、超时、Guard 修改或未批准运行时路径。 `git diff --check HEAD` 通过。

| 七路径（均在 packages/opencode） | 物理新增/删除 | 保守 E/C |
| --- | --- | --- |
| src/lsp/client.ts | 61/41 | 22/4 |
| test/agent/agent.test.ts | 30/0 | 24/4 |
| test/fixture/lsp/fake-lsp-server.js | 9/1 | 6/2 |
| test/lsp/client.test.ts | 276/401 | 80/10 |
| test/server/httpapi-exercise/backend.ts | 14/3 | 13/1 |
| test/server/httpapi-exercise/index.ts | 20/2 | 16/4 |
| test/server/httpapi-exercise/runner.ts | 8/7 | 7/1 |
| 合计 | 418/455 | 168/26 |

- E 按 `git diff -w -U0 HEAD` 统计新增实际行，排除空白、导入与注释；保留可能的原样移位，故是保守上界。C 的 26 条均临近改动，解释 stdio 两向请求、诊断等待所有权、scope 顺序和真实包的同盘路径等不变量；达到本会话最低 ⌈168×15%⌉=26。Agent 唯一现行增量 E=24/C=4。
- 计划阶段原生 A/B 按同一目标新 Guard blob `b000b0bfec035161a3df2d32f951daf33bd0da70` 验证：无 Skill 准备时原测试断言通过、整轮资源门禁因 20 秒和 10 秒计时器退出 1；只增加 Skill 准备后，窄 2 项与全文件 48 项均通过并退出 0。精确候选还保留原 hook；其 48 项／146 断言、原 defaultAgent→workspaceFolders 顺序窄测 2 项／2 断言均退出 0。仅删 hook 的对照也全绿，故没有纳入删除。断言差异来自新 Guard 不再对每个测试附加资源断言；原测试断言未删。原始命令、日志、时间和退出码按 R10 原验证身份独立保留。
- 这些是在方案审计前完成的实测，待资源窗口按批准的精确身份复验；最新 #9 Gate、三模式 HTTP、包类型和真实 Windows 回执均未完成。旧 R9 的验收是 `0dfffcda` 历史回执，不替代本轮。本次只冻结七路径、复算并更新本 Plan，没有运行测试或发布。

- 批准后精确 R10 原包类型检查在香港时间 01:33:19–01:34:45（86 秒）自然退出 0，零诊断。原命令为 `GOMAXPROCS=1 GOGC=10 GOMEMLIMIT=900MiB bun run typecheck --singleThreaded`，实际执行 `tsgo --noEmit --singleThreaded`；采用相同只读依赖、锁定 Bun。Git HEAD、树、最新 Guard blob、源码前后校验与命令/退出码按以下 R10 日志 SHA 与源码 SHA 核对。原日志 SHA-256 `c86265c83b885eb05094eb4d4d29a6d95cd86760e8e8f1336e1163e26211eea1`，源码差分前后均为 `4990aa1e37f067b65f657bf4f4d3198630007a9944b963aba7e8df83c9998bbe`。本轮只运行包级类型检查，其余 §26 回执继续待跑。

### 批准后原 HttpApi 三模式回执

在精确 R10 源码上，于 `packages/opencode` 逐个运行原命令 `bun run script/httpapi-exercise.ts --mode <mode> --fail-on-missing --fail-on-skip`。每组均为 225 pass、0 fail、0 skip、0 missing、0 extra，自然退出 0。三次运行前后七路径全索引差分均为 `4990aa1e37f067b65f657bf4f4d3198630007a9944b963aba7e8df83c9998bbe`。

| 原模式 | 实际起止（香港时间） | 原输出 SHA-256 |
| --- | --- | --- |
| Auth | 01:36:35–01:36:44 | `e20d43fc704a3cdf35e6ce1bcb2d986507d0f28dd431847fc9e09de57811b496` |
| Coverage | 01:36:44–01:36:48 | `d6ba5d6aa18bb6751792d6c991f59ca4cd133e38d410f009c53214463242dc8c` |
| Effect | 01:36:48–01:39:27 | `39874037002cc4b81be85e96a297bd0e85e01bbf2b577fc78d0ba7310c5e53db` |

原命令、输出、退出码、时间和源校验按上表三个对应哈希独立留存。这组回执完成最新候选的原 HttpApi 三模式，包类型检查也已通过；仍待批准后 LSP 普通及新 stock 原入口复验、最新 #9 完整 Gate、精确候选的真实 Windows runtime 与独立实现审计。先完成 #5 远端临时候选验证；本候选当前未提交、未推送、未启动第四阶段。

### 批准后原 LSP 双入口回执

精确 R10（基线 `0b5754df…`，七路径差分 `4990aa1e…`）在 `packages/opencode` 运行原 `test/lsp/client.test.ts`。保持原 30,000 ms 用例预算、并发 2 和全部断言，始终使用真实子进程进行 stdio 协议往返。两次均 12 pass、0 fail、22 条断言、实际退出 0。

- 最新 stock `afterAll`（blob `b000b0bfec035161a3df2d32f951daf33bd0da70`），香港时间 01:40:47–01:40:54。workspaceFolders 920.95 ms；registerCapability 304.82 ms。日志 SHA-256 `70d8a4c9c4413727a9252c56df5edb67dc058e22012020f6523a51e5f83a0fe6`。
- 普通包 preload，香港时间 01:40:54–01:41:00。workspaceFolders 791.06 ms；registerCapability 279.35 ms。日志 SHA-256 `86686495f95148f5420fb71947b4169a4debee84435ff37c49dc342f342ee84c`。

原命令、日志、退出码和时序按上述两套日志哈希独立留存。两次验证前后源码差分逐字相同。此结果只覆盖本地 LSP 文件；独立审计、最新完整 Gate 和真实 Windows runtime 仍待完成，按约定先做 #5 远端验证。
