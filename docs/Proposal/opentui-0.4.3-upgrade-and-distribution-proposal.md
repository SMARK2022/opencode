# Canonical Implementation Plan: OpenTUI 0.4.3 SMARK 分支、CJK 修复与独立分发

> Status: verified
>
> Revision: R12
>
> Approved revision: R12
>
> Audit mode: implementation
>
> Requirement source: 本文第 1 节逐字引用的用户要求
>
> Implementation allowed: no; exact R12 implementation verified
>
> Last updated: 2026-07-17

本文是该任务唯一的实现规范。聊天摘要、被替代的修订和本文之外的构建者说明均不构成实现授权。

## R12 User Release Decision

本次用户放行与独立full-scope方案审计所检查的R12技术内容完全一致，不增加或改变
behavior、interface、owner、file、test、fallback或verification route。R12 auditor确认technical
requirement、ownership、primary path、fallback、双向traceability、testing和plan-stage
comment gate均完整，唯一blocking finding是历史audit record已经超过6轮上限。合同要求
轮次耗尽后把该事项作为开放决定交给用户；用户于2026-07-17明确决定不新开周期、不再
重复技术审计，直接放行R12实施。

用户原文放行：

> 理论上来说,你已经,如果没有实质上的审计问题的话,那我直接放行你不就完了吗?
>
> 没有问题的话,我们就放行你,通过了算是,就把这个不要当成新周期。
>
> 12

该决定不改写R12 auditor的`BLOCK`原文，也不伪造独立`APPROVE`；它只解决auditor明确
交还用户决定的轮次门禁。R12实施仍受本文完整范围、TDD、验证、中文注释和独立full-scope
implementation audit约束；没有implementation auditor的`No blocking findings`不得标记
verified或创建最终OpenCode commit。

## R8 Revision Delta: GitHub Actions Immutable-Release Permission Boundary

R7实施期间产生了一个新的、可重复的release阻塞事实：tag
`v0.4.3-smark.1`已指向已推送且public CI全绿的OpenTUI commit
`cbe492a538137842961d561c33f55fdb7587b40e`，producer和四平台release
verifier均通过，但`.github/workflows/release.yml`的
`Require repository release immutability`步骤失败。失败日志显示：

```text
gh: Resource not accessible by integration (HTTP 403)
```

同一接口由已认证维护者token查询返回：

```json
{"enabled":true,"enforced_by_owner":false}
```

因此第一处分歧在release workflow使用`GITHUB_TOKEN`查询repository
administration接口，而不是在immutable设置本身或package producer。该token
拥有`contents: write`但不能读取该管理接口；失败发生在创建draft之前，当前tag
没有普通release、draft或部分assets。

R8只允许修复这一责任边界：release workflow不得把它自身无权读取的管理接口
当作release成功的前置验证；immutable setting仍必须由仓库维护者在tag发布前用
管理token确认，并保留可审计证据。workflow必须继续依赖`contents: write`创建
draft、上传完整closure并publish，不能创建普通release、移动tag、覆盖asset、
使用registry或submodule fallback。该修复不改变package、tag、OpenCode
dependency或release asset contract。

R8计划状态为`audit-required`，此前R7 approval失效。必须先取得R8完整方案审计
通过，才允许修改`.github/workflows/release.yml`并重试当前不可移动的tag；若
workflow本身不能重用已存在的tag，必须创建递增的`smark.N` tag，不能覆盖或移动
`v0.4.3-smark.1`。

## R9 Revision Delta: Reconciled Release Identity

R8审计发现canonical plan仍混有早期阶段快照。R9以当前仓库和GitHub远端事实为

```text
OpenTUI source/default branch: cbe492a538137842961d561c33f55fdb7587b40e
OpenTUI tag: v0.4.3-smark.1 -> cbe492a538137842961d561c33f55fdb7587b40e
OpenCode gitlink: thirdparty/opentui -> cbe492a538137842961d561c33f55fdb7587b40e
GitHub Release: not created because the first release workflow stopped before draft creation
```

`v0.4.3-smark.1`已经push且不可移动；不能创建新tag替代它，也不能把它指向
`ea4ed655`或任何其他commit。R9唯一允许的retry是修复release workflow的
`GITHUB_TOKEN`权限边界后重新运行同一tag的workflow。修复必须保持维护者在tag
发布前已用管理token确认`immutable-releases.enabled=true`的证据，并由workflow
继续执行四平台closure、draft、完整12 assets上传和publish。release成功后，11个
assets、checksums、attestation和OpenCode URL消费必须全部指向
`cbe492a538137842961d561c33f55fdb7587b40e`。

R9不引入新的package source、tag fallback、普通release、submodule build或
OpenCode dependency路径；它只修复release workflow的权限检查责任边界，并统一
所有INV-09、gitlink、tag和release状态映射。

## R10 Revision Delta: Executable Retry From Current Workflow Revision

R9审计证明“修复后重跑原tag workflow”不可执行：GitHub rerun固定原始事件的
`GITHUB_SHA=cbe492a5`和`GITHUB_REF=refs/tags/v0.4.3-smark.1`，因此不会加载
之后提交到`smark/main`的修正版workflow。R10将retry收敛为一个可执行的同一
release primary path：

1. `.github/workflows/release.yml`增加`workflow_dispatch`入口，要求显式输入
   `release-tag=v0.4.3-smark.1`和`source-sha=cbe492a538137842961d561c33f55fdb7587b40e`。
2. 当前workflow先断言`source-sha`正是不可移动tag的`^{commit}`、当前public
   `smark/main`包含该commit、tag尚未有GitHub Release；随后所有prepare、producer、
   matrix verifier和publish步骤都使用这两个输入，不使用dispatch分支HEAD替代
   source package identity。
3. `.github/workflows/build-native.yml`的reusable producer增加同名`source-sha`
   可选输入，并在checkout时显式checkout该SHA；默认push/PR producer继续使用
   当前event SHA。这样release workflow文件来自修复后的`smark/main`，11个package
   内容仍来自`cbe492a5`。
4. maintainer先用管理token记录immutable setting响应，再从`smark/main` dispatch
   该workflow；不rerun旧tag event，不移动tag，不创建递增tag，不使用Actions临时
   artifact、registry、official package或submodule source。

R10只增加release orchestration的可达入口和source pin传递，不改变package family、
tag、asset names、checksums、attestation、OpenCode URL或submodule contract。

## R11 Revision Delta: Complete OpenCode 0.4.3 Consumer Migration

R10实施已完成immutable release、root 11-URL graph、Goal CJK、upgrade CLI和closure
验证，但首次在真实`0.4.3-smark.1` types上运行`bun typecheck`暴露出4个此前未进入
file plan的可达consumer分歧：

1. `component/dialog-provider.tsx`的`ApiMethod`仍把直接JSX传给
   `DialogPrompt.description`，而该public prop明确是`() => JSX.Element`。上游
   OpenCode PR #35226的对应迁移是`description={() => (...)}`。
2. legacy Session route把`props.message.error?.data.message`（unknown）直接作为
   `<text>` child。上游同一PR改为既有`errorMessage(props.message.error)` owner。
3. SMARK本地`feature-plugins/system/session-v2.tsx`把结构化
   `SessionErrorUnknown`对象直接作为`<text>` child；该SDK类型的public message字段
   是string，必须只渲染`props.message.error.message`。
4. SMARK permission-review tool view的`rationale()`通过`Show` accessor仍被0.4.3
   JSX推断为unknown；owner memo必须收敛为显式string结果再交给`<text>`，不改变
   reviewer metadata或fallback语义。

同一typecheck还发现两个新验证脚本的本地类型边界：artifact smoke应复用现有
`src/pty/pty.node.ts` typed adapter，而不是直接导入package export缺失的声明；closure
verifier对`process.report.getReport()`必须在读取`header`前做object shape检查。这些只
修复验证代码类型，不改变production behavior。

R11只增加以上6个精确文件/表达式和对应行为验证；不引入0.4.3兼容layer、alternate
renderer、错误对象stringify fallback或测试专用生产开关。R10 approval已失效，R11
必须重新进行完整范围方案审计后才允许修改这些production/test files。

## R12 Revision Delta: Authoritative Cumulative State and V2 Renderer Test

R11审计发现本文仍把早期阶段的“release不存在/official 0.3.4”快照当作current state，
并且v2 structured error只映射到typecheck。R12定义以下唯一authoritative current
state；旧revision verdict和0.3.4文字只作为历史red evidence，不构成待执行步骤：

```text
OpenTUI source/tag/gitlink: cbe492a538137842961d561c33f55fdb7587b40e
OpenTUI default branch: smark/main at e1b90732d4edc7c79965ac655df6b20753e67fc5
GitHub Release: v0.4.3-smark.1 published, immutable, 11 tgz + SHA256SUMS
OpenTUI CI: release dispatch and current default-branch package CI both success
OpenCode catalog/overrides: 0.4.3-smark.1 + 11 exact release URLs
OpenCode lock/install: 11 URL entries with integrity, one solid-js@1.9.12 runtime
Completed OpenCode red/green: Goal 3->2, updater 3->11 URLs, Solid closure 2->1,
DialogPrompt factory invisible->visible
```

当前remaining implementation只有：R11列出的4个consumer typecheck修正和2个script
typing修正；v2 error独立renderer fixture；旧Solid patch删除；3份README；build native
evidence；final artifact smoke；test/build workflows；all-target和consumer verification；
implementation evidence/audit/final commit。不得重新发布tag、重做已完成的dependency
migration或把release workflow临时artifact当成新source。

v2 error行为测试新增独立fixture：通过`internalTuiPlugins({experimentalEventSystem:true})`
取得真实`SessionV2Debug` plugin，注册其route，在测试renderer中提供structured
`SessionErrorUnknown {type:"unknown", message:"v2 failure"}`，导航到
`session.v2.messages`并断言最终frame包含`v2 failure`且不含`[object Object]`。该测试
驱动真实plugin/route renderer，不复制其格式化逻辑，也不增加production test hook。

## 执行摘要

结论分成两个互不替代的问题：

1. Goal 右侧区域的 CJK 换行重复不是 OpenCode 自己算错 sidebar 宽度，也不是终端字体问题。第一处分歧发生在 OpenTUI `word` wrap：列偏移 `char_offset` 前进后，UTF-8 `byte_offset` 没有在同一位置前进。后续 virtual chunk 可能从双宽 grapheme 的第二个 cell 开始，绘制阶段又回到该 grapheme 的首字节，于是边界汉字在上一视觉行越过文本盒边界绘制一次、在下一行再绘制一次。上游精确修复是 [anomalyco/opentui#845](https://github.com/anomalyco/opentui/pull/845)。
2. 偶发中文乱码或残影、只有全量更新才恢复，是另一条可达路径。OpenTUI `0.3.4` 的 buffered renderer 每个输出缓冲区固定为 `2 MiB`；超出后写入错误被渲染代码中的 `catch {}` 吞掉，但 cell diff 仍被提交。终端只收到截断的 ANSI，renderer 却认为整帧已经同步。OpenTUI `0.4.3` 所含 [#1224](https://github.com/anomalyco/opentui/pull/1224) 改为按需扩容，扩容失败则丢弃整帧并强制下一帧 full repaint。它能修复这一类 stale-frame 损坏，但不包含 #845。
3. 因此，只升级到官方 `0.4.3` 是不完整方案；只把 #845 backport 到 `0.3.4` 也不会取得 `0.4.3` 的 stale-frame 修复。
4. 唯一主路线是：创建 public `SMARK2022/opentui` fork，以 `v0.4.3` commit `5803b2cfa2942c45a3aedbb3601754e27f2cdc68` 为基线，把 #845 的完整三文件 diff 合入默认分支 `smark/main`，并以版本 `0.4.3-smark.1`、tag `v0.4.3-smark.1` 独立发布 core、Solid、keymap 和 8 个 native npm tarballs。OpenCode 的 catalog保留语义版本，root overrides固定这11个GitHub Release URL；最终Bun executable嵌入目标native library，终端用户运行时不再在线解析OpenTUI包。
5. OpenTUI `0.4.3` 的 Solid/keymap manifests 精确要求 `solid-js@1.9.12`。当前 root catalog 的 `1.9.10` 以及 `patches/solid-js@1.9.10.patch` 必须一并迁移：升级唯一 Solid runtime 到 `1.9.12`，删除旧 patch；该 patch 的 transition 修复已在 `1.9.12` 发布代码中出现，不能保留一个版本专属 patch。
6. OpenCode把该public fork注册为 `thirdparty/opentui` submodule，并固定release commit。submodule只承载源码可发现性、独立Git提交和provenance；OpenCode正常install/build不得从submodule源码构建，也不得在Release URL失败时回退到submodule。这个职责分离避免把Zig工具链和OpenTUI workspace bootstrap引入OpenCode root install。
7. GitHub repository启用immutable releases。release先以draft上传11个`.tgz`和`SHA256SUMS`，再发布并用`gh release verify`/`verify-asset`验证GitHub attestation；OpenCode的`bun.lock`同时固定每个URL的integrity。
8. 当前Bun 1.3.14隔离探针已证明HTTP tarball可作为catalog/override来源，且当前`bun install --os/--cpu @opentui/core@catalog:`调用保持可用。URL overrides会把8个native包都保存到Bun隔离store，因此最终target binary的native内容和体积必须实测，不把“只下载一个平台包”作为保证。

### 方案比较

| 路线 | Goal CJK 重复 | stale-frame 乱码 | package family 完整性 | 一次性复杂度 | 持续维护 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 官方 `0.4.3` | 不修复 | 修复 | 官方完整 | 低 | 低 | 不完整，拒绝作为主路线 |
| 当前 `0.3.4` + #845 | 修复 | 不修复 | 需自建完整 native family | 中 | 中 | 仅适合单一事故，不满足本任务完整范围 |
| 当前 `0.3.4` + #845 + 手工移植 #1224 | 可修复 | 可修复 | 需自建完整 native family | 高 | 高 | #1224 整体无法 clean apply，容易形成自维护 renderer 分叉 |
| 上游 #845 当前 head 的产物 | 修复 | 取决于其 `0.4.2` 基线 | 当前无可安装产物 | 低 | 低 | 当前不可用，且基线不是 `0.4.3` |
| **SMARK public fork `smark/main`: `0.4.3` + #845，immutable GitHub Release** | **修复** | **修复** | **11个同commit tarballs + attestation** | **中** | **低到中** | **唯一主路线** |
| `thirdparty/opentui` 参与OpenCode源码构建 | 修复 | 修复 | 可控，但产生root install bootstrap | 很高 | 高 | 拒绝；submodule仅作源码/provenance |
| 只改 `@opentui/core` 为 Git URL | 不可靠 | 不可靠 | native 仍可能来自 registry 旧版 | 低 | 高风险 | 无效方案 |
| `patchedDependencies` 仅打 JS patch | 不修复 | 不修复 | 无法承载 native 二进制修复 | 低 | 高风险 | 无效方案 |

## 1. Verbatim Requirement

> 因此请你检查检查上游又没有修复好的pr？理论上实在不行的话我们的生产环境可以使用那个pr的产物

> 4。3解决了文字尤其是CJK文字buffer损坏的问题吗？有的时候我的中文汉字会出现渲染成乱码，只有全量更新才解决

> 因此请你详细完整进行比较,以及完整审计一下OpenTUI升级到0.4.3,同时其相应依赖链也进行升级,和相关生态也进行升级之后,我们的调用等等方式会发生什么改变,整体复杂度多高,同时我们如果想引入修复PR的话,整体的难度如何?我们能自己在当前仓库里面开一个third party,然后进行相应的实现吗?还是说怎么办?也就是我们如果真的要进行打包和分发,也就是在GitHub的Action里面进行相应操作,应该如何进行?请你详细完整进行分析并给出完整的报告。报告构建在我们的docs文件夹的proposal文件夹里面。

> 因此当前我们首先需要构建一个新的 OpenTUI 分支,这个分支理论上来说我还是想放在我们的项目内,但是你可以放一个独立的 worktree 里面,也就是譬如你可以放在 third party 里面,新增一个文件夹,然后让这个文件夹内部的东西单独进行 Git 提交。同时让这个 OpenTUI 也注册为我们的 fork,只是为了方便以后的其他人进行 Git 下载,就是注册成一个 submodule。但是最终编译的时候,打包的时候,我们是让 OpenTUI 单独进行打包,打包完之后进行相应的发布,然后我们主仓库的 worktree 从相应的 OpenTUI的仓库里面的产物去获取构建结果。所以理论上来说,复杂度应该不算很高,只是说我们把文件放在了这里,其他 worktree 等等层级关系依然保持不变。因此目标当前需要进行 OpenTUI 及其 OpenCode 相关依赖的完整构建以及打包,你可以自行进行 GitHub 上传等等内容。

> 注意理论上来说,我们要构建的TOI分支是0.4.3的包含PR合并的分支。这个内容你可以构建为一个发布库,我当前GH有登入,你可以构建为一个public仓库。同时这个public仓库主分支要设定为我们的当时的smark的分支。

本revision的目标终态是`verified-implementation-and-commit`。规划阶段只修订本文；exact revision通过独立方案审计后，才实施fork、submodule、release、OpenCode消费、验证和提交。

## 2. Explicit Non-Goals

- 不在当前修订重新批准前继续修改production、tests、config、workflow、generated文件或创建外部repository。
- 不通过改 Goal 的 `wrapMode`、缩短 objective、额外 padding 或手工插入换行绕过 OpenTUI native 缺陷。
- 不把 #1224 的 stale-frame 修复与 #845 的 word-wrap 修复描述成同一个问题。
- 不引入运行时“官方包失败后再加载 fork 包”的 fallback。
- 不改 OpenCode 最终安装脚本或 release asset 格式；native 选择发生在 dependency/build seam，最终 CLI 分发仍沿用现有 zip、tar.gz、deb 和 exe。
- 不为尚无证据的终端、字体、locale 或 Unicode edge case增加生产逻辑。
- 不向npm registry或GitHub Packages发布`@opentui`；没有scope权限证据，唯一分发源是public GitHub immutable Release assets。
- 不使用`pkg-pr-new`、workflow临时artifact或上游过期artifact作为生产依赖源。
- 不让OpenCode正常build从`thirdparty/opentui`源码编译，也不在Release下载失败时回退到submodule、npm官方包或registry native包。
- 不把upstream `main`设为fork默认分支；public fork默认分支固定为`smark/main`。
- 不push最终OpenCode commit；用户显式要求的OpenTUI source commit/tag/push/release是建立可消费artifact identity的实施前置动作，OpenCode commit仍在full implementation audit后创建。
- 不宣称fork Windows DLL具有上游Azure Authenticode签名；当前账户没有该secret/证书producer证据。Windows package和最终OpenCode binary以实际Windows consumer/build验证，不伪造签名状态。
- 不删除现有 `captureCJKFrame()`；它防护的是 `getRealCharBytes()` 精确满行换行行为，与本次 virtual chunk 重复不是同一缺陷。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 默认分支是 `dev`；测试和 typecheck 必须从 package 目录执行；SDK 生成有专用脚本；优先自动化。 |
| `packages/opencode/AGENTS.md` | TUI 位于 `packages/opencode/src/cli/cmd/tui`；不能阻塞前台运行 TUI；遵守模块与 Effect 约束。 |
| `packages/opencode/test/AGENTS.md` | 测试使用真实实现和现有 fixture，避免定时竞态与不必要 mocks。 |
| `CONTEXT.md` | `Goal` 是 Session 的结构化目标；报告和测试使用该术语，不漂移为 objective/target 作为领域名。 |
| `docs/adr/README.md` | 当前没有与 OpenTUI dependency ownership 冲突的 accepted ADR；triage ADR 与本任务无关。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复第一处分歧，禁止 caller workaround 和新 fallback，要求双向 traceability 与独立审计。 |
| `.opencode/templates/canonical-plan.md` | 本文必须完整覆盖 24 个 canonical sections。 |
| `.gitmodules`、`README.md`、`docs/readme/README.en.md`、`docs/readme/README.zht.md` | 现有`thirdparty/chatgpt-browser-agent`提供`SMARK2022` public fork、`smark/main` branch、gitlink和clone说明的仓库先例。 |
| `docs/proposal/upstream-v1.17.18-merge-governance.md:691-744` | 已确立“一份 OpenTUI runtime/context/native graph”和 release-binary closure gate 的项目方向。 |
| `docs/proposal/tui-malformed-sgr-mouse-fix.md` | 现有 TUI 问题报告的证据表达约定；同时证明 `0.4.3` 不是所有 TUI parser/render 缺陷的通用修复。 |

## 4. Files and Evidence Read

### OpenCode 生产与测试路径

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/goal.tsx:20-45` | Goal objective 进入 `<text wrapMode="word">` 的生产入口 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx:26-49` | 固定 42-cell sidebar、左右 padding 2、content paddingRight 1 | observed |
| `packages/opencode/src/cli/cmd/tui/routes/session/layout.ts:1` | `SESSION_SIDEBAR_WIDTH = 42` | contracted |
| `packages/opencode/src/cli/cmd/tui/app.tsx:177-199` | OpenCode renderer config 未覆盖 buffered output/thread 的生产设置 | observed |
| `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts:81-149` | 第二个 renderer consumer；直接操作生命周期和 scrollback | reachable |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx:14-17,116-151` | `description` 已是 factory，但当前渲染为 `{props.description}` | observed |
| `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx:90-98,310-367` | description factory 的生产调用者 | observed |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/plugins.tsx:38-64` | public plugin API 的 reactive description consumer | observed |
| `packages/opencode/src/cli/cmd/tui/plugin/api.tsx:237-253` | plugin `DialogPrompt` pass-through seam | contracted |
| `packages/plugin/src/tui.ts:19-50,145-154,300-337` | 公共插件包暴露 OpenTUI types、keymap 和 DialogPrompt factory | contracted |
| `packages/opencode/src/cli/cmd/tui/component/spinner.tsx:4-20` | 当前显式注册 `SpinnerRenderable`，避免 packaged Bun 的 catalogue 时序问题 | observed |
| `packages/opencode/test/cli/cmd/tui/spinner.test.tsx` | Solid reconciler spinner registration 行为护栏 | observed |
| `packages/opencode/test/cli/cmd/tui/session-layout.test.ts:106-227` | 现有 CJK 与 spinner 测试；未覆盖 42/35-cell Goal odd boundary | observed |
| `packages/opencode/test/cli/tui/slot-replace.test.tsx` | Solid slot/reconciler 升级回归面 | reachable |
| `packages/opencode/test/cli/tui/plugin-loader*.test.ts` | keymap runtime-module 和 plugin subpath 回归面 | reachable |
| `.opencode/plugins/tui-smoke.tsx` | repository-local 外部式 consumer；upgrade helper 明确跳过 `.opencode` | reachable |

### Dependency 与构建路径

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `package.json:31-52,130-149` | 当前trio为`0.4.3-smark.1`，11个overrides固定SMARK release URLs；spinner仍为`0.0.7` | observed |
| `packages/opencode/package.json:112-148` | CLI 的直接 OpenTUI 与 spinner dependencies | observed |
| `packages/plugin/package.json:24-43` | 公共plugin peers当前最低`>=0.4.3-smark.1` | contracted |
| `package.json:85,130-149` | root catalog/override统一`solid-js@1.9.12`；旧patch entry已移除 | observed |
| `patches/solid-js@1.9.10.patch` | 已不被manifest引用，R12 remaining cleanup要求删除 | observed |
| `bun.lock` 的 OpenTUI 和 native entries | 当前3个framework+8个platform packages全部锁定同tag URL和integrity | observed |
| `node_modules/opentui-spinner/package.json:67-82` | 最新 `0.0.7` peers 仍是 `^0.3.4` | contracted |
| `node_modules/opentui-spinner/dist/src-DjeqLSfu.mjs` | SpinnerRenderable 继承 `@opentui/core` Renderable 并调用 render lib | observed |
| `node_modules/opentui-spinner/dist/solid.mjs` | 上游 side-effect registration 走 `@opentui/solid/components`；当前应用已绕开 | observed |
| `script/upgrade-opentui.ts` | 当前只接受已发布`0.4.3-smark.1`，原子更新catalog/11 URLs/peers并排除thirdparty | observed |
| `packages/opencode/test/script/upgrade-opentui.test.ts` | 旧CLI在3 overrides处red；新CLI 11 URLs且nested manifest byte-identical | observed |
| `bunfig.toml` | hoisted/exact install 和 OpenTUI release-age exceptions | contracted |
| `.github/actions/setup-bun/action.yml` | CI setup 与 root install 发生在 build 前 | observed |
| `.github/workflows/test.yml` | OpenCode/core 在 Linux、Windows、macOS 的 required tests | contracted |
| `.github/workflows/typecheck.yml` | package typecheck gate | contracted |
| `.github/workflows/build-opencode.yml` | macOS、Linux、Windows build/package/release matrix | contracted |
| `packages/opencode/script/install-target.ts` | `--single`、`--os`、`--arch` 到 Bun install target 的映射 | observed |
| `packages/opencode/script/build.ts:63-179,375-510` | target-specific core install、parser worker、Bun compile、smoke 和 release asset | observed |

### OpenTUI 上游证据

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| OpenTUI `v0.3.4` commit `9b216a58...` | 当前基线源码 | observed |
| OpenTUI `v0.4.3` commit `5803b2cf...` | 升级目标源码 | observed |
| OpenTUI `v0.4.3 packages/solid/package.json:60-73` | 精确 peer `solid-js: 1.9.12` | contracted |
| OpenTUI `v0.4.3 packages/keymap/package.json:70-88` | Solid adapter peer同样要求 `solid-js: 1.9.12` | contracted |
| `solid-js@1.9.12/dist/solid.js` | 已包含旧 patch 的 `if (!Transition.sources.has(node)) node.value = nextValue` | observed |
| `v0.3.4`/`v0.4.0`/`v0.4.1`/`v0.4.2`/`v0.4.3` release notes | 46 commits中的发布主题和 breaking areas | contracted |
| `v0.3.4` 与 `v0.4.3` core/solid/keymap manifests | exports、native optional deps、`bun-ffi-structs`、Yoga 变化 | observed |
| `v0.4.3 packages/core/src/zig/text-buffer-view.zig:1143-1315` | #845 前的错误 offset 演进 | observed |
| PR #845 head `6fbf515c...` 同文件 `1143-1312` | 修复后在每次 add 后同步 byte offset | observed |
| `v0.4.3 packages/core/src/zig/buffer.zig:1383-1437` | virtual chunk column offset 到 UTF-8 byte 的绘制转换 | observed |
| `v0.3.4 packages/core/src/zig/renderer-output.zig:163-394` | 固定 `2 MiB` buffer、BufferFull 和仍返回 `.ok` | observed |
| `v0.4.3 packages/core/src/zig/renderer-output.zig:168-419` | 动态扩容、整帧失败和 64 小帧后 shrink | observed |
| `v0.4.3 packages/core/src/zig/renderer.zig` | `.failed` 触发 full repaint | observed |
| PR #845 | 3 files, +119/-13，当前`OPEN`、`MERGEABLE`、`BLOCKED`，head `6fbf515c...` | observed |
| PR #1224 | 74 files, +1206/-256, 29 checks；已进入 `v0.4.3` | observed |
| PR #1171 | packaged Solid catalogue 通过 consumer-selected root module 共享 | contracted |
| OpenTUI `.github/workflows/build-native.yml` | Bun `1.3.14`、Zig `0.15.2`、macOS cross-build 8 targets，并汇总core/Solid/keymap dist与native dirs | observed |
| OpenTUI `.github/workflows/npm-latest-release.yml:115-165` | 上游使用`npm pack --dry-run`验证生成后的core/Solid/keymap package；这是tarball producer合同 | observed |
| OpenTUI `.github/workflows/release.yml` | 上游tag release依赖Blacksmith、npm token和Azure签名secret，最终GitHub Release只上传native/examples ZIP，不上传npm tarballs | observed |
| OpenTUI `packages/core/scripts/build.ts` | native package naming、exports 和 core optionalDependencies 生成 | observed |
| OpenTUI `packages/core/scripts/publish.ts` | core 和全部 native packages 是一个发布闭包 | contracted |
| OpenTUI `scripts/prepare-release.ts` | 现有lockstep owner把9个`@opentui/*` workspace manifests与8个core optional deps统一到显式prerelease version | observed |

### 历史与执行证据

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| OpenCode commit `1cad1628d4` | 记录 spinner `0.0.6/0.0.7` 与早期 0.4.3 尝试的 segfault 风险 | observed |
| OpenCode commit `98dcea02a8` | `0.4.2` 曾被回退到 `0.3.4` | observed |
| OpenCode commit `561070fbc2` / upstream PR #35226 | 官方 OpenCode 升到 `0.4.3`；Linux/Windows unit、E2E、typecheck 全过 | observed |
| OpenCode commit `d886a91089` | 当前显式 spinner registration 修复 compiled bundle 时序 | observed |
| `npm view opentui-spinner ...` on 2026-07-16 | npm 最新仍是 `0.0.7`，无 0.4.x peer release | observed |
| `https://pkg.pr.new/@opentui/core@6fbf515` | 2026-07-16 返回 404，#845 尚无 preview | observed |
| PR #845 workflow artifact `7903328346` | 已过期且只含 native libraries，不是完整 package family | observed |
| npm snapshot 查询 | 不存在 `@opentui/core@0.0.0-20260626-6fbf515c` | observed |
| `npm view @xterm/headless` on 2026-07-16 | `6.0.0`，可作为 final artifact ANSI terminal model | observed |
| `npm view pkg-pr-new` on 2026-07-16 | publisher版本 `0.0.78`，记录dist integrity | observed |
| GitHub-hosted runners reference on 2026-07-16 | public repository标准runner提供Linux arm64 label `ubuntu-24.04-arm` | contracted |
| `gh api user` on 2026-07-17 | authenticated login是`SMARK2022`；用户明确授权创建public fork、push、tag和release | contracted / observed |
| `gh repo view SMARK2022/opentui` on 2026-07-17 | public fork存在，default branch=`smark/main`，parent=`anomalyco/opentui` | observed |
| Bun 1.3.14 direct URL/catalog probes | HTTP`.tgz`可作为catalog/override；`bun install --os=linux --cpu=x64 @opentui/core@catalog:`保持catalog spec并解析URL | observed |
| Bun 1.3.14 packed closure probe | 本地HTTP提供11个真实`npm pack` tarballs时，core/Solid/keymap、8 native和`solid-js@1.9.12`共110 packages安装且四个入口成功import | observed |
| local `v0.4.3` package build/pack probe | Zig 0.15.2 cross-build 8 native，core/Solid/keymap build成功，`npm pack`生成恰好11个tarballs和SHA-256；总压缩体积约22 MiB | observed |
| `bun install --frozen-lockfile` at pristine `v0.4.3` | Bun 1.3.14拒绝；非frozen install给`bun.lock`补8个native entries | observed |
| GitHub immutable release docs/API | `PUT /repos/{owner}/{repo}/immutable-releases`启用；发布后tag/assets锁定并生成release attestation | contracted |
| `gh 2.96.0 release verify/verify-asset` | 当前环境可验证immutable release及单个下载asset的cryptographic attestation | observed |
| 本地 #845 native test | `1675 passed, 2 skipped, 0 failed` | observed |
| 本地 #845 JS/render tests | `156 passed, 0 failed` | observed |
| 本地 `v0.4.3` native test | `1680 passed, 2 skipped, 0 failed` | observed |
| `git apply --check` #845 -> `v0.3.4` | clean | observed |
| `git apply --check` #845 -> `v0.4.3` | clean | observed |
| `git apply --check` #1224 -> `v0.3.4` | fails across package/core/renderer/framework files | observed |

## 5. Current Behavior

### 5.1 Goal CJK 路径

```text
Session Goal objective
  -> sidebar Goal plugin
  -> 42-cell Sidebar
  -> 2+2 sidebar padding
  -> 1 content paddingRight
  -> 2 Goal paddingLeft
  -> 35-cell <text wrapMode="word">
  -> OpenTUI TextBufferView virtual lines
  -> OptimizedBuffer
  -> native ANSI diff
  -> terminal cells
```

实际几何是：文本从 framebuffer 的 x=4 开始，35-cell 文本盒覆盖 x=4..38。错误 virtual chunk 允许一个双宽汉字从 x=38 开始，占用 x=38..39。OpenTUI 当前只在 framebuffer/scissor 边界裁剪，x=39 仍位于 42-cell framebuffer 内，因此上一行多画该汉字；下一 virtual line 又从 x=4 画同一个汉字。复制文本仍按源顺序，视觉 framebuffer 已重复。

### 5.2 stale-frame 路径

```text
large render diff (>2 MiB ANSI)
  -> BufferedBackend fixed buffer
  -> writer returns BufferFull
  -> renderer output sites catch and discard error
  -> truncated ANSI reaches terminal
  -> currentRenderBuffer is still committed
  -> later differential frames omit cells believed current
  -> stale/garbled terminal survives until full repaint
```

`0.4.3` 的路径改为：

```text
large render diff
  -> grow active buffer
  -> complete frame flush
  -> commit cells

allocation failure
  -> mark frameWriteFailed
  -> do not flush partial ANSI
  -> endFrame returns failed
  -> force next full repaint
```

### 5.3 当前 dependency/build 路径

```text
root catalog + overrides
  -> hoisted bun install
  -> packages/opencode build.ts
  -> bun install --os/--cpu @opentui/core@catalog:
  -> resolve parser.worker.js and platform native package
  -> Bun.build --compile
  -> target executable embeds selected native library
  -> GitHub Actions packages executable
```

所以修复必须在 Bun compile 之前成为完整 package graph。最终 zip/tar/deb/exe 上传层没有能力替换错误 native library。

### 5.4 当前 fork/submodule/artifact 路径

```text
SMARK2022/opentui:smark/main exists at cbe492a538137842961d561c33f55fdb7587b40e
  -> root worktree has .gitmodules entry and gitlink thirdparty/opentui at the same commit
  -> immutable tag v0.4.3-smark.1 points at the same commit
  -> immutable GitHub Release contains 11 npm tarballs plus SHA256SUMS and verified attestations
  -> OpenCode catalog resolves 0.4.3-smark.1
  -> root overrides and bun.lock cover all 11 release URLs with integrity
  -> initialized submodule is clean at cbe492a5; default branch may advance independently for workflow maintenance
```

OpenTUI source producer、immutable artifact producer和OpenCode consumer现已形成一条可执行连接。submodule仍只承载source/provenance；OpenCode install从同commit的release assets取得11-package closure，不从submodule源码构建。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 含 ASCII、标点和 CJK 双宽 grapheme 的 Goal objective | Goal API / DialogGoal | objective 是普通 Unicode string | Goal sidebar `wrapMode="word"` | OpenTUI TextBufferView | observed |
| 35-cell odd-width 文本盒，外层 framebuffer 更宽 | 固定 sidebar layout | 42/35 几何由当前源码确定 | Sidebar -> Goal | OpenCode layout + OpenTUI clip | observed |
| 超过 `2 MiB` 的 ANSI frame | 大 terminal、全量刷新、高密度样式输出 | 0.3.4 无动态容量保证 | renderer output | OpenTUI BufferedBackend | reachable；上游测试 observed |
| buffered/threaded output | `createCliRenderer` 默认与平台行为 | Linux 在 0.4.3 禁用 thread；macOS 可 threaded | app renderer config | OpenTUI renderer | reachable |
| `DialogPrompt.description` factory | provider/plugin UI | public plugin type明确为 `() => JSX.Element` | plugin API -> DialogPrompt | OpenCode DialogPrompt | observed |
| 一份 `solid-js` runtime | root catalog、9个 workspace consumers、OpenTUI Solid/keymap peers | OpenTUI 0.4.3精确要求1.9.12 | app/TUI/plugin component graph | root dependency catalog | contracted |
| duplicate renderable id 或 object reparent | Solid slot/reconciler | 0.4.3 改为 object identity | plugin slots | OpenTUI core/Solid | reachable |
| macOS arm64/x64 | release workflow | current release artifact | build.ts target install | OpenCode build | contracted |
| Linux arm64/x64 glibc/musl native package | OpenTUI package family；OpenCode `--os=linux --cpu=*` | core optional deps 列出 4 variants | build.ts | OpenTUI package producer | contracted |
| Windows x64/arm64 native package | OpenTUI package family | core optional deps 列出 2 variants | current release用x64；family含arm64 | OpenTUI package producer | contracted/reachable |
| public OpenTUI fork与SMARK默认分支 | 用户要求、authenticated `SMARK2022` GitHub账户 | fork保持upstream public可见性；默认分支可由repository API设定 | `SMARK2022/opentui:smark/main` | GitHub repository settings | contracted |
| OpenTUI submodule gitlink | `.gitmodules`和现有chatgpt submodule先例 | gitlink固定commit，branch字段只辅助update | OpenCode checkout -> `thirdparty/opentui` | OpenCode repository metadata | contracted / observed |
| 11个GitHub Release npm tarballs | OpenTUI build scripts与Bun URL dependency | package内name/version必须与`0.4.3-smark.1`闭包一致 | release URL -> root override -> Bun lock/install | OpenTUI release workflow | contracted / observed |
| immutable release attestation | repository immutable-release setting | draft可上传；发布后tag/assets不可修改并产生attestation | `gh release verify` / `verify-asset` | GitHub release service | contracted |
| user运行`bun run upgrade-opentui <version>` | root package script | 当前CLI承诺更新OpenTUI dependency versions | root catalog/overrides与package peers | `script/upgrade-opentui.ts` | reachable |
| 任意字体把中文算成非双宽 | 未发现 producer/contract | 无 | 无证据 | terminal | speculative，不驱动方案 |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 一个源 grapheme 在一次静态 Goal 渲染中只占一个连续 cell span，不跨行重复 | 用户现象、42/35 repro | 无；现有 CJK 测试未覆盖外层 framebuffer 更宽 |
| INV-02 | virtual chunk 的 column offset 与 UTF-8 byte offset 在每次消费后表示同一位置 | #845 diff 与 local red/green | 上游 #845 Zig/Markdown tests |
| INV-03 | renderer 只有在整帧 ANSI 成功输出后才能把 cell state 视为 committed | #1224 / 0.4.3 renderer code | `v0.4.3` native renderer tests |
| INV-04 | 一个运行进程只能解析到一份 core、Solid、keymap graph 和同一release commit/version的目标 native binary | root overrides、public plugin types、build path | 无完整 closure gate |
| INV-05 | `DialogPrompt.description` factory 必须在 owner component 中求值并渲染返回 JSX | public plugin type、upstream 0.4.3 OpenCode diff | 现有 smoke plugin 可达，缺专门回归 |
| INV-06 | release binary 必须嵌入当前 target 对应的 OpenTUI native package，而不是 host 或 registry 旧版本 | build.ts target install + Bun compile | 当前仅 `--version` smoke，不验证 native hash |
| INV-07 | full upgrade 不得破坏 spinner registration、slot replacement、keymap runtime loading 和 renderer shutdown | current call-surface inventory | 分散存在相关测试 |
| INV-08 | OpenCode、`@opentui/solid`、keymap Solid adapter和 spinner必须解析到一份满足 peer contract 的 `solid-js@1.9.12` runtime | 0.4.3 manifests、当前 root catalog/patch | 无完整 runtime closure gate |
| INV-09 | public fork默认分支、OpenCode gitlink、immutable release tag和11个package repository metadata必须指向同一个`v0.4.3 + #845` source owner/commit | 用户的fork/submodule/default-branch要求；GitHub attestation contract | gitlink/tag/package metadata统一指向`cbe492a5`；default branch `e1b90732`只增加workflow retry，不改变tag source |
| INV-10 | OpenCode build只从11个可公开下载且integrity固定的release tarballs取得OpenTUI，不从submodule、official npm或mixed native graph取得替代成功 | 用户要求独立打包后消费；Bun URL probe | release、11 root URLs、lock integrity和installed closure已验证；final target compile/smoke待完成 |
| INV-11 | OpenTUI维护命令必须原子更新version catalog、11个artifact overrides和peer floor，并保持`thirdparty/opentui`独立Git工作树clean | 现有upgrade CLI与新增submodule边界 | temp fixture已从3个catalog override red转为11 URLs green，thirdparty byte-identical |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01/INV-02 | `word` wrap 选择 punctuation boundary 后只推进 `char_offset`，`byte_offset` 未在统一消费点推进 | OpenTUI `TextBufferView` word-wrap iterator | `v0.4.3` lines 1210-1217、1275-1287、1291-1297 与 #845 lines 1284-1293 对比；exact layout red/green |
| INV-03 | 0.3.4 `bufferWrite` 返回 BufferFull，但调用点吞错，`endFrame` 仍置 `hasCommittedFrame=true` 并返回 `.ok` | OpenTUI `BufferedBackend` / renderer commit contract | 0.3.4 renderer-output lines 322-394；0.4.3 lines 342-419 |
| INV-04/INV-06 | 只替换 core JS 时，core optionalDependencies 仍按 package version解析 8 个 native 包；build.ts 又按 target 重新安装 core | package family / OpenCode build seam | manifests、core build script、OpenCode build.ts |
| INV-05 | 0.4.3 兼容迁移要求 factory invocation，而当前 owner 仍把 function object 作为 child | OpenCode `DialogPrompt` | upstream OpenCode commit `561070fbc2` 精确改为 `{props.description?.()}`；当前 line 127 未迁移 |
| INV-08 | 初次切catalog后`@solidjs/start`仍嵌套1.9.10，closure verifier先得到2个runtime | root dependency overrides | 新增root `solid-js: catalog:`后closure green为唯一1.9.12；旧patch文件仍待删除 |
| INV-09/INV-10 | 已完成：release workflow permission/dispatch、11 assets、root URLs和lock建立同一source identity | GitHub repository/submodule/release producer与OpenCode dependency seam | run `29567923763`、release attestations、gitlink/tag `cbe492a5`、closure verifier green |
| INV-11 | 已完成：旧CLI只更新catalog/3 overrides；新CLI生成11 URLs并排除thirdparty | `script/upgrade-opentui.ts` maintenance interface | temp fixture exact red/green及nested manifest byte equality |

### Red-capable feedback loop

工作目录：`packages/opencode`

```bash
bun -e 'import { BoxRenderable, TextRenderable } from "@opentui/core"; import { createTestRenderer } from "@opentui/core/testing"; const input="检查log，请你自行独立完整完成相应的调研与检查，并进行多轮的负载并发、高压"; const count=(value:string,needle:string)=>value.split(needle).length-1; const results=[]; for(let run=1;run<=3;run++){ const setup=await createTestRenderer({width:42,height:6,footerHeight:0,useThread:false,consoleMode:"disabled"}); try { const sidebar=new BoxRenderable(setup.renderer,{width:42,height:6,paddingLeft:2,paddingRight:2}); const content=new BoxRenderable(setup.renderer,{flexShrink:0,gap:1,paddingRight:1}); const goal=new BoxRenderable(setup.renderer,{paddingLeft:2}); goal.add(new TextRenderable(setup.renderer,{content:input,wrapMode:"word"})); content.add(goal); sidebar.add(content); setup.renderer.root.add(sidebar); for(let i=0;i<3;i++) await setup.renderOnce(); const frame=setup.captureCharFrame(); results.push({run,rows:frame.split("\n").slice(0,3).map((row)=>row.trimEnd()),sourceCount:count(input,"查"),renderedCount:count(frame,"查")}); } finally { setup.renderer.destroy() } } console.log(JSON.stringify(results)); if(results.some((result)=>result.renderedCount!==result.sourceCount)) throw new Error("Goal rendering duplicates a wide glyph at the wrap boundary")'
```

当前 `0.3.4` 连续三次均为：

```text
sourceCount=2
renderedCount=3
rows[1]="    请你自行独立完整完成相应的调研与检查"
rows[2]="    查，并进行多轮的负载并发、高压"
Error: Goal rendering duplicates a wide glyph at the wrap boundary
```

同一几何和断言改为导入已构建的 #845 `dist/index.js`、`dist/testing.js` 后连续三次：

```text
sourceCount=2
renderedCount=2
rows[1]="    请你自行独立完整完成相应的调研与检"
rows[2]="    查，并进行多轮的负载并发、高压"
exit=0
```

最小 load-bearing 条件是：`word` wrap、标点后的 CJK chunk、35-cell odd width、文本盒右侧仍有 framebuffer cell。把 framebuffer 也缩到 35 时，越界第二 cell 被 framebuffer 裁掉，不能复现用户视觉缺陷；所以测试必须保留真实 42/35 geometry。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| grapheme wrap offset 同步 | OpenTUI TextBufferView | 生成不拆分/重复 grapheme 的 virtual lines | 第一处分歧在 native text layout | Goal caller只提供 string 和 wrap mode，不应实现 Unicode layout |
| frame 原子提交 | OpenTUI BufferedBackend/renderer | terminal bytes 与 committed cell state一致 | 输出缓冲和 commit 都在 native renderer | OpenCode 不知道 partial ANSI 或 native allocator 状态 |
| 修复源码所有权 | public `SMARK2022/opentui:smark/main` | 一个可审计release commit包含`v0.4.3 + #845` | 修复和8个binary来自同一源码，默认分支满足用户SMARK要求 | OpenCode repo不应复制native algorithm |
| source可发现性与pin | OpenCode `.gitmodules` + gitlink | `thirdparty/opentui`固定release commit并可独立clone/update | submodule metadata属于consumer repository | submodule不拥有package build或运行时fallback |
| package closure发布 | OpenTUI fork workflow + immutable GitHub Release | 一次tag发布同commit/version的11个tarballs、checksums和attestation | 上游已有cross-build/pack seam；GitHub拥有公开immutable artifact boundary | OpenCode release upload已晚于dependency resolution |
| dependency pin与target install | OpenCode catalog/overrides/lock/build.ts | 语义版本与11个release URL固定，编译时只选择目标native import | 当前dependency/build seam已承担这项职责 | 最终installer只搬运executable，submodule只存源码 |
| fork dependency维护 | `script/upgrade-opentui.ts` | 一个CLI事务更新catalog、11个URLs和peer floor且不进入thirdparty | 当前CLI是全仓OpenTUI版本owner | 手工改多个manifest会形成漂移，submodule内部version由其fork独立维护 |
| description factory 求值 | OpenCode DialogPrompt | public plugin factory 返回的 JSX 被渲染 | owner component 定义 child semantics | plugin callers不应知道 Solid reconciler版本差异 |
| Solid runtime版本与patch处置 | OpenCode root catalog/patchedDependencies | 所有 workspace和OpenTUI adapters共享满足 peer的 runtime | catalog/patch是全仓版本owner | TUI package不能单独覆盖其他8个 Solid consumers |
| spinner compatibility | OpenCode explicit registration + tests | 一份 catalogue 和 core graph | 当前已是值导入、显式 extend | 不需要复制 spinner scheduler |

## 10. Single Approved Primary-Path Design

唯一主路线如下：

```text
OpenTUI v0.4.3
  -> public SMARK fork default branch smark/main完整合入#845
  -> prepare-release 0.4.3-smark.1 + committed Bun 1.3.14 lock
  -> public-runner native/JS/framework tests and 11 npm packs
  -> draft GitHub Release upload -> immutable publish -> attestation verify
  -> OpenCode thirdparty/opentui gitlink固定同一release commit
  -> OpenCode catalog version + 11 Release URL overrides + lock integrity
  -> DialogPrompt 迁移 factory invocation
  -> clean install 验证唯一 graph/native hash
  -> Linux/macOS/Windows package consumers + OpenCode target builds
  -> final executable PTY/ConPTY smoke
  -> verified OpenCode commit; no OpenCode push
```

### 10.1 OpenTUI source branch

- 用GitHub fork关系创建public `SMARK2022/opentui`，不是脱离upstream lineage的新vendor repository。
- 基线必须是 commit `5803b2cfa2942c45a3aedbb3601754e27f2cdc68`（tag `v0.4.3`）。
- 从该commit创建并push `smark/main`，随后把repository default branch设置为`smark/main`；upstream `main`只保留同步参考，不是SMARK发布branch。
- 完整应用 #845 head `6fbf515ca60c1171ce0d6335088a66bbc94a354f` 的三个文件aggregate diff；`git apply --check`已重新证明对`v0.4.3` clean。这样满足“包含PR合并”的内容要求，同时不把PR的旧0.4.2 base metadata当发布基线。
- 不手工重写 #845 算法，不增加 caller clipping，也不 cherry-pick #1224，因为 `v0.4.3` 已包含后者。
- 使用现有`bun scripts/prepare-release.ts 0.4.3-smark.1`统一更新9个lockstep workspace manifests和8个core optional dependency versions；在Bun 1.3.14下更新并提交`bun.lock`，随后CI必须`--frozen-lockfile`。
- 初始release source commit必须记录base SHA、#845 head SHA和最终tree SHA；tag固定为`v0.4.3-smark.1`。后续修订只递增`smark.N`，绝不重用或移动已发布tag。
- OpenTUI source commit/tag/push是用户明确要求的public artifact identity前置动作；它发生在完整本地red-green和fork package verification之后、OpenCode dependency修改之前。最终OpenCode commit仍等待full implementation audit。

### 10.2 Required package family

OpenCode 所需闭包是11个同release commit、同`0.4.3-smark.1`version的packages，而不是三个版本号：

| Layer | Packages |
| --- | --- |
| JS/framework | `@opentui/core`, `@opentui/solid`, `@opentui/keymap` |
| macOS | `@opentui/core-darwin-arm64`, `@opentui/core-darwin-x64` |
| Linux glibc | `@opentui/core-linux-arm64`, `@opentui/core-linux-x64` |
| Linux musl | `@opentui/core-linux-arm64-musl`, `@opentui/core-linux-x64-musl` |
| Windows | `@opentui/core-win32-arm64`, `@opentui/core-win32-x64` |

core、Solid和keymap source manifests的`repository.url`必须改为`https://github.com/SMARK2022/opentui`；core build会把该值复制进8个native packages。artifact verifier同时断言11个packed manifests都指向public fork，不能让SMARK binary伪装成upstream release metadata。

`opentui-spinner@0.0.7` 不是 OpenTUI family 的构建产物。npm 当前没有更新版本；主路线保留它，通过 root overrides 强制实际 core/Solid graph，并以现有显式 registration、direct render test 和 compiled-binary smoke证明兼容。上游 OpenCode PR #35226 在保留 `0.0.7` 的情况下通过 unit/E2E/typecheck，说明 peer range mismatch 是已知 metadata debt，不等同于已观察运行失败。

OpenTUI family之外还有一个必须同步的 runtime contract：

- root catalog把 `solid-js` 从 `1.9.10` 升到 `1.9.12`。
- 删除 root `patchedDependencies` 中的 `solid-js@1.9.10` entry并删除 `patches/solid-js@1.9.10.patch`。
- 不把旧 patch重放到 `1.9.12`：其 load-bearing transition赋值已存在于 `1.9.12/dist/solid.js`。
- clean-install closure同时解析 OpenCode、`@opentui/solid`、`@opentui/keymap/solid`和 spinner实际使用的 `solid-js` realpath；必须只有一个 `1.9.12` runtime。
- 因 root catalog有9个直接 consumer，实施验证覆盖 `packages/opencode`、`app`、`web`、`ui`、`storybook`、`enterprise`、`desktop`、`console/mail`和`console/app`各自现有 typecheck/build/test script；不添加每包兼容分支。

### 10.3 Independent package build and immutable distribution

- `.github/workflows/build-native.yml`继续作为唯一package producer，但把不可用的Blacksmith runner改为public `macos-15`，固定Bun `1.3.14`、Zig `0.15.2`，并使用已提交lock执行`bun install --frozen-lockfile --omit=optional --linker=hoisted`。`--omit=optional`只作用于producer的source bootstrap：8个prerelease native optional packages在此时尚未由本次tag生成，随后由同一job的`build:native --all`生成；`--linker=hoisted`只稳定producer内跨workspace、子进程fixture的source resolution，不改变发布包或OpenCode consumer graph；真实consumer/matrix仍必须安装并验证完整11-pack。
- producer先运行#845 native regression、完整native tests、core JS/render tests，再执行`build:native --all`、core `build:lib`、Solid build、keymap build和三个现有packed-consumer tests。任一失败都不产生可发布success。
- producer严格使用上游已验证的`npm pack --pack-destination`，分别从core dist、Solid dist、keymap dist和8个generated native directories生成11个文件；隔离实测证明`bun pm pack`会在Solid/keymap workspace metadata上失败，因此禁止替换打包器。
- 新增`scripts/verify-release-packages.ts --directory <tarball-dir> --version <version>`作为artifact public seam：断言恰好11个预期文件、SHA-256清单、package name/version和`SMARK2022/opentui` repository metadata，启动本地HTTP server后用version catalog + 11 overrides执行Bun install，并通过公开exports创建test renderer，运行42/35 CJK assertion。脚本始终清理server/temp目录，失败返回非零，不生成替代包。
- 新增`.github/workflows/smark-ci.yml`，只监听`smark/main` push/PR；调用同一producer并在`macos-15`、`ubuntu-latest`、`ubuntu-24.04-arm`和`windows-latest`运行artifact verifier。musl和Windows arm64没有对应public runtime runner，只由cross-build、package metadata/checksum和OpenCode cross-target compile验证，不伪造运行结果。
- `.github/workflows/release.yml`只监听`v*-smark.*` tag，验证tag version等于9个lockstep manifests且tag commit位于`smark/main`，调用同一producer和consumer matrix。它不调用npm publish、Blacksmith或Azure signing jobs。
- release workflow不得由`GITHUB_TOKEN`读取`/immutable-releases`管理接口：该token在真实tag run中已被GitHub以HTTP 403拒绝，而维护者管理token已确认`enabled:true`。workflow只保留`contents: write`所需的draft/upload/publish路径；维护者在tag push前执行`gh api repos/SMARK2022/opentui/immutable-releases --jq .enabled`并把响应写入implementation evidence，确认值为`true`后才允许tag workflow继续。该检查修复不创建普通release、不移动tag、不切换artifact source。
- release失败后的唯一可执行retry是修复后`smark/main`上的`workflow_dispatch`，输入固定`release-tag`与`source-sha`；workflow显式checkout并验证该tag的`^{commit}`，reusable producer通过`source-sha`输入checkout同一commit。禁止依赖旧tag event rerun，因为GitHub rerun固定旧workflow SHA；禁止移动既有tag或以递增tag替代当前release identity。
- 上游遗留`.github/workflows/pkg-pr-new.yml`只服务PR开发预览，不监听`smark/main` tag、不进入OpenCode URL overrides、lock或release source；它不是本任务的production分发路径，后续文档必须保留该边界。
- repository创建后先执行`PUT /repos/SMARK2022/opentui/immutable-releases`。release job先创建draft并上传11个`.tgz`和`SHA256SUMS`，全部资产就绪后再publish；immutable release锁定tag/assets并生成GitHub attestation。
- 发布后执行`gh release verify v0.4.3-smark.1 -R SMARK2022/opentui`，下载全部12个assets并逐个执行`gh release verify-asset`和`shasum -a 256 -c SHA256SUMS`。失败保持实施blocked，不覆盖asset、不移动tag、不切换到其他源。
- Windows DLL明确为unsigned fork artifact，因为没有上游Azure signing credentials。workflow和release notes必须如实记录；Windows x64 consumer smoke负责证明load/behavior，不把“未签名”转换为成功声明。
- OpenCode只消费`https://github.com/SMARK2022/opentui/releases/download/v0.4.3-smark.1/<asset>.tgz`。GitHub Release是build-time package source；发布后的Bun executable已嵌入native library。

### 10.4 OpenCode compatibility migration

- `.gitmodules`新增`thirdparty/opentui`，URL为`https://github.com/SMARK2022/opentui.git`，branch为`smark/main`；gitlink固定`v0.4.3-smark.1` release commit。README简中、英文和繁中说明初始化命令与“build消费release而非submodule源码”的边界。
- root catalog把core/Solid/keymap设为语义版本`0.4.3-smark.1`；root overrides把这3个名称和8个native名称全部映射到同tag GitHub Release URL，`bun.lock`固定URL与integrity。catalog不直接写URL，使workspace peer/version语义保持可读；actual source由overrides唯一拥有。
- root Solid runtime升级到 `1.9.12`并删除已吸收的 `1.9.10` patch。
- `packages/plugin` peer floor升到`>=0.4.3-smark.1`，该range同时包含initial prerelease、stable 0.4.3和后续版本；URL不写入peer range。
- `DialogPrompt` 改为 `{props.description?.()}`，与已存在的 factory type 和 upstream 0.4.3 migration一致。
- 保留 spinner 的显式 `extend({ spinner: SpinnerRenderable })`。
- 不直接调用 OpenTUI breaking `remove(id: string)`；全仓 search 已证明当前 TUI/plugin 无该调用。
- `.opencode/plugins/tui-smoke.tsx` 必须在升级后真实加载，因为 upgrade helper 不会遍历 `.opencode`。
- `script/upgrade-opentui.ts`保留一个`<version>`入口，但新增11个package name到immutable Release URL的确定性映射，并把`thirdparty`加入scan exclusion；一次运行更新catalog、overrides和peer floors。它不创建release、不网络探测、不改submodule源码；release必须先独立存在并通过attestation gate。

### 10.5 Release build integration

OpenCode build workflow不编译submodule中的OpenTUI；它只在install后加入closure gate：

1. 解析 root、`packages/opencode`、`packages/plugin` 和 spinner consumer看到的 core/Solid/keymap realpath。
2. 解析9个 workspace consumers、OpenTUI Solid/keymap adapter和 spinner看到的 `solid-js` realpath，断言唯一版本为 `1.9.12`。
3. 断言11个package各只有一个realpath、version都是`0.4.3-smark.1`、lock resolution都是同一immutable release tag，并拒绝任何`registry.npmjs`/`npmmirror` OpenTUI package URL。
4. 读取gitlink并与immutable release tag commit比较；`thirdparty/opentui`初始化时还断言nested HEAD一致且clean。branch tip不是pin authority。
5. 在`build.ts` target-specific install后解析target native package，计算library SHA-256；URL overrides可能缓存全部8包，但实际target import/hash必须唯一。
6. Bun compile后保存executable hash、target native hash、binary size和package report。与当前0.3.4 host build比较体积；如果URL resolution把无关native嵌入binary，修复package/build owner后重建，不接受无界膨胀。
7. 继续使用当前macOS、Linux、Windows target build和release archive格式；submodule不加入workspace、不传给Bun build。

### 10.6 Final artifact PTY/ConPTY contract

新增 `packages/opencode/script/smoke-opentui-artifact.ts`，唯一接口是：

```text
bun run script/smoke-opentui-artifact.ts --binary <absolute-extracted-binary-path>
```

脚本只测试已从最终 zip/tar.gz解压的 executable，不接受 workspace入口、build-tree shim或 `process.execPath`替代。它使用现有 `@lydell/node-pty` 在 Unix创建 PTY、Windows创建 ConPTY，并用新增 dev dependency `@xterm/headless@6.0.0` 维护终端 cell model。完整行为契约是：

1. 创建临时 Project和隔离的 `OPENCODE_LOCK_PATH`、`OPENCODE_DB`、`OPENCODE_TEST_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_CONFIG_HOME`、`XDG_STATE_HOME`；设置 `OPENCODE_PROCESS_ROLE=main`、`OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS=60000`和禁用 project plugin/config的现有 flags。
2. 启动本地 OpenAI-compatible SSE fixture；`OPENCODE_CONFIG_CONTENT`固定 model为 `test/test-model`，base URL指向 fixture，不访问外网。fixture收到 prompt后先保持1秒 busy窗口，再发送 `ok`和 finish chunk。
3. 第一次用 extracted binary在160x30 PTY/ConPTY启动 TUI，只用于启动真实 shared daemon。轮询隔离 lock file并对 lock port健康检查，最长60秒。
4. 经真实 HTTP seam发送 `POST /session`，header `x-opencode-directory=<temp-project>`，body为固定 title；随后发送 `POST /session/<id>/goal`，同一 header，body objective为第8节精确 CJK字符串。
5. 向第一次 TUI发送 Ctrl+C并等待10秒退出；daemon保留。第二次运行同一个 extracted binary：`<binary> <temp-project> --session <id>`，仍为160x30。
6. 每次 PTY data按到达顺序写入 headless terminal；归一化 frame为30行 `translateToString(true)`。轮询到 `Goal`和objective出现后，断言全 frame中 `查`恰好2次、无 `\uFFFD`，且三行文字顺序与第8节 green literal一致。
7. 调用 PTY resize到150x28再恢复160x30；每次等待frame稳定，重复 `查===2`、无 replacement char和Goal仍可见断言。
8. 向 prompt写入 `hello`和 Enter；fixture确认请求到达后，在1秒 busy窗口内断言 frame出现 `SPINNER_FRAMES`之一；fixture完成后等待 `ok`，再断言 spinner glyph不残留。
9. 发送 Ctrl+C，要求TUI在10秒内以预期状态退出。随后运行同一 extracted binary的 `daemon stop`命令，最长60秒；断言 lock PID死亡、无 harness记录的child仍存活。
10. 任一步失败时，finally必须kill PTY process和隔离 daemon PID、关闭SSE fixture、删除临时目录；把最后frame、转义后的bounded ANSI transcript、binary SHA、native SHA、exit code和process inventory写到 `.artifacts/opentui-smoke/`。

三平台 workflow在签名/打包后先解压自身刚生成的最终 archive到 runner temp，再调用同一脚本。macOS两个archive分别在现有 `macos-latest` arm64 host执行；x64 archive通过 runner自带 Rosetta执行并记录 `uname -m`、binary architecture和Rosetta availability，缺少Rosetta即阻止发布。Windows x64在现有 `windows-latest` 通过 ConPTY执行。

Linux固定为两条、没有二选一的权威路径：

1. 现有 `build-linux` job在 `ubuntu-latest` 打包后解压 `opencode-linux-x64.tar.gz`，运行 x64 artifact smoke，并上传 `opentui-smoke-linux-x64` evidence。
2. 新增 `smoke-linux-arm64` job，`runs-on: ubuntu-24.04-arm`，`needs: build-linux`。它 checkout同一 SHA、setup Bun/install source-side harness dependencies、下载 `release-assets-linux` artifact、只解压 `opencode-linux-arm64.tar.gz`，运行 `bun run --cwd packages/opencode script/smoke-opentui-artifact.ts --binary "$RUNNER_TEMP/opentui-smoke/opencode"`，并上传 `opentui-smoke-linux-arm64` evidence。
3. `smoke-linux-arm64` 对 archive missing、binary architecture非aarch64、harness失败、timeout或cleanup失败均返回非零；不允许 `continue-on-error`。
4. `checksums` job的 `needs` 增加 `smoke-linux-arm64`，并继续硬依赖含x64 smoke的 `build-linux`；GitHub默认 success依赖保证任一 smoke failure/cancel都会跳过 checksums和后续 release upload。
5. 当前 `SMARK2022/opencode` 是 public repository；GitHub官方runner reference明确列出标准Linux arm64 label `ubuntu-24.04-arm`。因此本计划不依赖不存在的self-hosted runner，也不保留“没有runner时照常发布”的路径。

### 10.7 Commit and publication ordering

1. 在`thirdparty/opentui`独立Git工作树完成各TDD slice、full tests、11-pack verifier、E/C计算和diff检查；任何失败都不得commit或publish。
2. 创建一个OpenTUI source/release commit，中文多行信息为`fix(opentui): 发布含 CJK 修复的 0.4.3 SMARK 构建`并说明base/#845/package boundary。这个commit是用户明确要求的独立repository identity，也是submodule gitlink和GitHub Actions唯一可引用的producer，因此属于实施前置，不是最终OpenCode可选commit。
3. push`smark/main`，等待public CI通过；创建并push`v0.4.3-smark.1` tag，等待immutable release成功并完成attestation/asset验证。失败时修复原因、创建新commit和递增`smark.N` tag；不amend已push commit、不移动tag、不覆盖asset。
4. release可公开安装后，OpenCode才新增submodule gitlink、catalog/overrides/lock和compatibility改动，并完成全部source/all-target/final-host验证。
5. 对OpenTUI已发布exact commit与OpenCode实际diff执行full-scope implementation audit。blocking finding若要求改变OpenTUI package/source，则创建新fork commit和新`smark.N` release，再更新gitlink/URLs并full-scope重审。
6. 只有overall status为`verified`后，才在OpenCode root使用`git commit --only -- <GOAL paths...>`创建中文多行commit`fix(tui): 使用 SMARK OpenTUI 0.4.3 发布产物`；不amend、不跳hook、不push。OpenTUI和OpenCode的无关staged/unstaged内容保持原样。

这条路线直接修复两个 owning native paths，没有 alternate renderer、运行时 fallback 或 Goal caller workaround。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| `SMARK2022/opentui:smark/main` `0.4.3 + #845` -> immutable 11-package release -> OpenCode URL graph | proposed | primary-contract branch | yes | 100% | preserve as sole implementation path |
| root `solid-js@1.9.12` runtime | proposed | supported-domain dependency branch | yes | 属于同一primary graph | preserve；删除1.9.10 patch |
| `thirdparty/opentui` gitlink | proposed | contracted source/provenance pass-through | no；不产生build success | 0% | preserve；必须与release commit一致 |
| 官方 `0.4.3` alone | candidate | forbidden fallback/incomplete replacement | 部分 | 0% | reject；不修复 INV-01 |
| `0.3.4 + #845` | candidate | incomplete replacement | 部分 | 0% | reject for this scope；不修复 INV-03 |
| `0.3.4 +` 手工 #1224 | candidate | competing implementation | yes if fully rebuilt | 0% | reject；whole PR不 clean apply且重复上游 0.4.3 |
| Goal 改 `wrapMode`/padding/manual newline | candidate | forbidden fallback | 表面 yes | 0% | reject；绕过 owner defect |
| core Git URL + registry native | candidate | mixed graph | 不可靠 | 0% | reject |
| `pkg-pr-new` preview | candidate | replacement package source | yes | 0% | reject；用户要求独立public release且当前无preview |
| GitHub workflow artifact ZIP | candidate | temporary replacement source | yes before expiry | 0% | reject；30天过期且不是11个npm tarballs |
| Release URL失败后从submodule源码build | candidate | forbidden fallback | yes | 0% | reject；违反独立package producer/consumer边界 |
| runtime fork-on-failure loader | candidate | forbidden fallback | yes | 0% | reject |
| upstream official future release | future migration | speculative，不是当前路径 | unknown | 0% | 不在本 revision 自动切换 |

新 alternate success path 数量为 0；diagnostic-only closure checks不产生成功替代，预计 decision surface占比低于 10%。

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| 无 Goal caller workaround | 当前没有通过截断/手工换行隐藏问题 | native owner修复后无需新增 | Not applicable |
| `captureCJKFrame()` | 规避 `getRealCharBytes()` 满行缺 newline 的测试读取缺陷 | #845 不修复该独立行为 | preserve |
| explicit spinner registration | 修复 Bun compile chunk/catalouge 时序 | 0.4.3 #1171降低风险，但当前 explicit value dependency仍是已验证路径 | preserve |
| root OpenTUI overrides | 防止多 renderer/context graph | full-family pin仍需要 | preserve and expand to 11 immutable URLs |
| upstream fork `release.yml` npm/Azure/Blacksmith jobs | upstream拥有npm scope、Azure secrets和private runner | SMARK只拥有public GitHub Release producer | 在fork中收敛为public-runner immutable tarball release；不保留并行tag workflow |
| current `upgrade-opentui.ts` semver-only scan | official npm版本是旧唯一source | release graph还需要11 URLs且thirdparty是独立Git边界 | 修改同一CLI owner；排除thirdparty并原子更新catalog/overrides/peers |

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01/INV-02 Goal 不重复 CJK | OpenTUI TextBufferView | SMARK OpenTUI fork应用 #845 | exact 42/35 Goal test red->green；#845 native tests |
| INV-03 stale frame可恢复 | OpenTUI renderer-output | 基线升级到含 #1224 的 `v0.4.3` | `v0.4.3` >2 MiB、allocation failure native tests |
| INV-04 唯一 package graph | root install/overrides | version catalog、11 immutable URLs、lock、closure verifier | clean install closure command |
| INV-08 唯一 Solid runtime | root catalog/patchedDependencies | `solid-js@1.9.12`、删除旧patch、closure verifier | 9个consumer typecheck/build + realpath检查 |
| INV-05 factory child正确渲染 | DialogPrompt | `dialog-prompt.tsx` factory invocation | DialogPrompt/plugin description behavior test |
| INV-05全部factory callers符合0.4.3 contract | provider API key dialog -> DialogPrompt | `component/dialog-provider.tsx`把provider JSX映射包成factory | 同一DialogPrompt renderer test覆盖provider description文本 |
| INV-07结构化错误继续显示可读文本 | legacy/v2 Session message renderers | legacy复用`errorMessage`；v2读取SDK `SessionErrorUnknown.message` | 现有session message renderer fixtures + typecheck |
| INV-07 permission reviewer rationale保持string child | reviewer metadata -> tool renderer | rationale memo显式返回string并由Show gate控制 | 现有permission review decision renderer fixtures + typecheck |
| INV-06 target native进入 binary | build.ts target install/Bun compile | build closure evidence step + artifact smoke harness | all target builds + extracted archive PTY/ConPTY行为 |
| INV-07 ecosystem不回归 | spinner/slots/keymap/runtime | peer floor更新；保留 explicit registration | spinner、slot、plugin-loader、footer tests；artifact smoke |
| INV-09 public fork/default branch/source pin | GitHub fork -> `smark/main` -> tag -> submodule gitlink | fork branch/settings、`.gitmodules`、gitlink、README | repo API/default branch、tag/gitlink equality、submodule clean |
| INV-10 独立package release且无source fallback | OpenTUI producer -> immutable release -> OpenCode overrides | fork build/release workflows、artifact verifier、root URLs | 11-pack local red/green、GitHub matrix、release attestation、clean OpenCode install |
| INV-11 可重复升级且不污染submodule | root upgrade CLI -> catalog/overrides/peers | `script/upgrade-opentui.ts`和CLI behavior test | temp fixture断言11 URLs、peer floor和thirdparty unchanged |
| 用户要求GitHub Actions分发 | fork tag -> draft assets -> immutable publish -> OpenCode build | fork workflows + OpenCode build gate | 11 assets/checksums/attestation、target builds、release smoke |
| 用户要求thirdparty/submodule方便下载 | `.gitmodules` -> gitlink -> documented init | `.gitmodules`、`thirdparty/opentui`、3份README | fresh `git submodule update --init`后nested HEAD/repo/default branch证据 |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| public fork + default `smark/main` | INV-09 | 用户明确要求public repository和SMARK主分支；当前fork/default已验证 | upstream repo不能承载SMARK release commit/default branch |
| OpenCode submodule gitlink | INV-09 | 用户明确要求thirdparty独立Git提交与submodule | package URL不提供source checkout；普通目录不固定独立commit |
| immutable `v0.4.3-smark.1` release | INV-09/INV-10 | 用户要求独立打包发布；GitHub API/attestation可用 | workflow artifact会过期，npm scope无权限，普通release可被覆盖 |
| same-release 11-package family | INV-04/INV-06/INV-10 | core optionalDeps与dynamic imports；11-pack probe | 单core URL仍解析registry native，submodule源码不参与root install |
| fork artifact verifier | INV-01/INV-02/INV-10 | local HTTP 11-pack probe和多平台native reachability | `npm pack --dry-run`不证明Bun consumer、CJK behavior或checksums |
| OpenCode closure verifier | INV-04/INV-06/INV-09/INV-10 | hoisted install + target reinstall + plugin peers + gitlink | lockfile文本不能单独证明realpath、release provenance或native binary实际进入executable |
| artifact-aware upgrade CLI | INV-11 | existing maintenance command + new independent submodule boundary | current helper不更新URLs并会扫描thirdparty；手工步骤无法原子维护11项 |
| `description?.()` migration | INV-05 | upstream OpenCode 0.4.3 commit与当前 factory type | 当前 function child 依赖旧 reconciler语义 |
| provider description factory caller migration | INV-05 | `bun typecheck`与upstream PR #35226精确diff | owner prop已是factory，直接JSX不再满足public contract |
| structured error/rationale text normalization | INV-07 | 0.4.3 TextChildren收紧、SDK公开message字段和既有`errorMessage` | 直接传object/unknown无法编译；renderer不应隐式决定对象显示语义 |
| exact 42/35 regression | INV-01 | 35-wide framebuffer不会复现，真实 sidebar会 | 现有 pure CJK/even-width测试缺少外层可绘制 cell |
| final PTY/ConPTY smoke | INV-06/INV-07 | compiled bundle曾出现 spinner registration时序问题 | source test和 `--version` 都不执行真实 TUI/native frame |
| root `solid-js@1.9.12` + patch删除 | INV-08 | 0.4.3精确 peers与1.9.12已含patch语义 | 1.9.10不满足contract，旧patch不能跨版本保留 |
| `@xterm/headless` artifact model | INV-01/INV-06/INV-07 | final ANSI需要跨平台独立cell expected value | raw byte计数会把多次diff重绘误判为重复glyph |

## 15. File-Level Change Plan

### 15.1 Separate `SMARK2022/opentui` fork

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/core/src/zig/text-buffer-view.zig` | modify | 应用 #845，统一在 virtual chunk消费后推进 byte offset | upstream #845 +约 35/-13 |
| `packages/core/src/zig/tests/text-buffer-view_test.zig` | modify | 覆盖 punctuation + CJK odd boundary | upstream #845 +约 70 |
| `packages/core/src/renderables/__tests__/Markdown.test.ts` | modify | framework-visible CJK wrap regression | upstream #845 +约 14 |
| `packages/{core,examples,keymap,qrcode,react,solid,ssh,three,web}/package.json` | generated modify | 现有`prepare-release`把9个lockstep packages统一为`0.4.3-smark.1`并更新core 8个optional deps | 约18 |
| `packages/{core,solid,keymap}/package.json` | modify | shipped package repository metadata指向`SMARK2022/opentui`；8 native manifests由core build继承 | 3 |
| `bun.lock` | generated modify | Bun 1.3.14记录prerelease workspace与8个native optional declarations；producer用frozen lock并省略尚未生成的optional native，consumer仍验证完整11-pack | 约20-35 |
| `scripts/verify-release-packages.ts` | add | 验证11 assets/checksums，HTTP安装完整closure并在真实native上运行42/35 CJK行为 | 约130-180 |
| `.github/workflows/build-native.yml` | modify | public macOS producer：frozen source install（仅省略未生成的optional native）、tests、8-target cross-build、core/Solid/keymap build、11次`npm pack`和checksums | 约90-130净改动 |
| `.github/workflows/smark-ci.yml` | add | `smark/main` push/PR调用唯一producer并在public macOS/Linux x64/Linux arm64/Windows x64验证packed artifacts | 约55-80 |
| `.github/workflows/release.yml` | replace | `v*-smark.*`唯一tag path；复用producer/matrix、draft upload、immutable publish，不调用npm/Azure/Blacksmith | 约90-130 |
| `README.md` | modify | 记录SMARK base/#845/version/default branch、unsigned Windows声明和immutable release消费方式 | 约12-20 |

### 15.2 Current OpenCode repository

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `.gitmodules` | modify | 注册`thirdparty/opentui`、public URL和`smark/main`update branch | 4 |
| `thirdparty/opentui` | add gitlink | 固定immutable `v0.4.3-smark.1` source commit；不进入workspace/build | 1 gitlink |
| `README.md`, `docs/readme/README.en.md`, `docs/readme/README.zht.md` | modify | 说明submodule init、独立repo和release-artifact build边界 | 约9-15 |
| `package.json` | modify | catalog设`0.4.3-smark.1`；11个overrides固定同tagGitHub assets；Solid升1.9.12并移除旧patch entry | 约14-18 |
| `patches/solid-js@1.9.10.patch` | delete | 1.9.12已包含该transition修复 | -58 |
| `bun.lock` | generated modify | 记录11个GitHub URL、integrity和Solid 1.9.12闭包 | 约40-90 |
| `packages/plugin/package.json` | modify | peer floor升到`>=0.4.3-smark.1` | 3 |
| `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx` | modify | 调用 description factory | 1 |
| `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` | modify | `ApiMethod`把provider说明映射包成description factory，与public prop和upstream迁移一致 | 2 |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | modify | legacy error使用既有`errorMessage`；permission rationale收窄为string child | 2-4 |
| `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx` | modify | v2结构化error只渲染SDK定义的message string | 1 |
| `packages/opencode/test/cli/cmd/tui/session-layout.test.ts` | modify | exact 42/35 Goal CJK multiplicity regression | 35-45 |
| `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | add | public description factory行为 | 25-40 |
| `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx` | add | 通过真实internal plugin/route renderer断言structured error message可见且无object coercion | 35-55 |
| `script/upgrade-opentui.ts` | modify | 一个CLI原子维护version catalog、11 release overrides和peers，并排除`thirdparty`独立Git树 | 约35-55 |
| `packages/opencode/test/script/upgrade-opentui.test.ts` | add | 通过temp CLI fixture验证URL literals、peer floor及submodule package不变 | 约55-75 |
| `packages/opencode/script/verify-opentui-closure.ts` | add | 输出/断言package realpaths、versions、URL source、gitlink/release commit和target native hash | 约70-100 |
| `packages/opencode/script/smoke-opentui-artifact.ts` | add | extracted executable的PTY/ConPTY、HTTP fixture、headless frame与cleanup契约 | 180-240 |
| `packages/opencode/package.json` | modify | 增加 `@xterm/headless@6.0.0` dev dependency | 1 |
| `.github/workflows/test.yml` | modify | 在 clean install后运行 closure与目标 TUI tests | 8-15 |
| `.github/workflows/build-opencode.yml` | modify | 每个平台编译前后保存closure/native hash，解压最终archive并运行统一 artifact smoke | 35-55 |
| `.github/workflows/build-opencode.yml` | modify | 新增硬门槛 `smoke-linux-arm64` (`ubuntu-24.04-arm`) 并加入 checksums `needs` | 25-40 |
| `.opencode/plugins/tui-smoke.tsx` | preserve/test | 作为外部式 consumer执行，不做无证据源码改动 | 0 |
| 9个 `solid-js` catalog consumer manifests/source | preserve/test | 版本由root catalog统一；无真实API错误前不做源码兼容修改 | 0 |
| `docs/Proposal/opentui-0.4.3-upgrade-and-distribution-proposal.md` | current plan | canonical specification与审计记录 | documentation only |

若release package metadata、attestation、gitlink或Bun install不能保持同commit/version closure，实施必须停止并修正OpenTUI package producer；不得在OpenCode runtime增加loader或submodule fallback。

## 16. TDD Behavior Slices

约定测试 seams：OpenTUI public renderer/test renderer、OpenCode public DialogPrompt/plugin UI、clean package resolution、最终 compiled CLI。实施前由用户批准本文即视为确认这些 seams；未批准前不写测试。

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | 先只加入#845的native/Markdown behavior tests，`v0.4.3`在punctuation + odd CJK boundary失败 | word wrap消费column后没有同步byte offset | 只应用#845 owner算法变更，原tests由red转green，完整native/JS suites继续green | 第一处分歧与上游PR内容 |
| 2 | fork artifact verifier对已保存的official `v0.4.3` 11-pack运行，HTTP安装成功但42/35 frame得到`source=2/rendered=3` | package transport正确但source仍缺#845 | 同一verifier对`0.4.3-smark.1` 11-pack在host/matrix得到2/2并校验name/version/checksum | release tarballs确实承载修复，不是错误source的可安装包 |
| 3 | upgrade CLI temp fixture只得到裸semver、缺8 native URLs，并修改`thirdparty/opentui` package manifest | current maintenance owner不知道artifact naming且扫描nested repo | 同一CLI一次生成version catalog、11 exact release URLs、peer floor且thirdparty byte-identical | 后续`smark.N`升级不混源、不污染submodule |
| 4 | OpenCode exact 42/35 Goal test在当前0.3.4 graph稳定得到frame 3 | current dependency仍含native offset bug | 只切换已验证release family后同一public renderer seam得到frame 2 | 用户截图中的跨行重复 |
| 5 | `DialogPrompt` description factory在0.4.3 consumer中不显示/语义不稳定 | owner渲染function object而非返回JSX | 只改为`props.description?.()` | provider与plugin reactive description |
| 5b | `bun typecheck`拒绝ApiMethod直接JSX、legacy/v2 error object和permission rationale unknown作为TextChildren；v2 renderer fixture在旧实现不能显示独立message string | 0.4.3明确factory与TextChildren类型，不再接受隐式object child | provider caller包成factory；legacy复用errorMessage；v2读取message；rationale显式string | provider/legacy fixtures与独立v2 plugin route frame共同证明可读文本 |
| 6 | closure verifier在旧graph报告无gitlink、registry 0.3.4、Solid 1.9.10或错误target native | 当前source pin、artifact source和runtime closure都不满足新contract | submodule/release pin、11 URL overrides、Solid 1.9.12后所有consumer解析同graph，target native hash唯一 | source/release漂移、FFI/renderer ABI/peer混版 |
| 7 | spinner、slot、runtime-module targeted tests在新graph运行 | 0.4.x Solid catalogue、slot identity、lazy runtime modules变化 | 不加兼容分支，仅修已证实的DialogPrompt差异 | ecosystem integration |
| 8 | extracted release binary在`smoke-opentui-artifact.ts`中出现CJK重复、replacement char、spinner残留、resize丢失或child泄漏 | source/package tests不覆盖Bun compile、native embedding、PTY和final archive | 同一个archive binary通过固定HTTP/PTY/ConPTY契约 | 发布物与源码/package验证漂移 |

每个 slice 必须先在目标依赖状态看到 red，再做最小 green；不得一次写完所有 tests再调整实现。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | 约 900 | 包含fork #845、release verifier/workflows、OpenCode updater/tests、closure/artifact scripts和workflows；排除imports、generated lock/version-only manifests、格式化和纯移动 |
| Required Chinese explanatory comments `C` | 至少 135 | `ceil(900 * 0.15) = 135`；实际E增加时同步提高 |

计划分布：

- OpenTUI fork的text-buffer owner和两个regressions旁至少20行，解释column/byte invariant、odd boundary和测试expected value；不改算法，只补owner约束。
- fork release package verifier旁至少25行，解释11-package闭包、HTTP consumer、独立expected value、checksum、temp/server cleanup和平台边界。
- fork build/CI/release workflows旁至少20行，解释frozen lock、producer为何只`--omit=optional`、public runner、draft-before-immutable、unsigned Windows和失败阻断发布的原因。
- upgrade CLI与其behavior test旁至少12行，解释version/URL双层owner、asset naming和nested Git exclusion。
- exact Goal与DialogPrompt tests旁至少12行，解释42/35 geometry、外层framebuffer cell和factory seam。
- closure verifier旁至少15行，解释realpath、release URL、gitlink/tag、Solid peer和target native hash为什么缺一不可。
- artifact smoke旁至少27行，解释两次TUI启动、HTTP注入、headless terminal、busy窗口、resize、timeout和process cleanup边界。
- OpenCode workflow/build gate旁至少4行，解释package resolution必须发生在Bun compile之前以及final installer为何已太晚。
- `description?.()` 本身显而易见，不为凑比例添加逐行翻译式评论。
- 实施审计使用实际 `E/C` 重算；若实际 `E` 增大，`C` 同步达到至少 15%。

## 18. Verification

### 18.1 已执行的调查验证

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| 第 8 节 exact 42/35 `bun -e`，连续3次 | `packages/opencode` | 当前 `sourceCount=2`, `renderedCount=3`, exit 1 |
| 同一 harness导入 #845 built dist | OpenTUI PR core directory | `sourceCount=2`, `renderedCount=2`, exit 0 |
| `zig build test --summary all` | #845 `packages/core/src/zig` | 1675 pass, 2 skip, 0 fail |
| targeted JS/render tests | #845 `packages/core` | 156 pass, 0 fail |
| `zig build test --summary all` | `v0.4.3 packages/core/src/zig` | 1680 pass, 2 skip, 0 fail |
| `gh pr checks 35226 -R anomalyco/opencode` | repo root | upstream OpenCode 0.4.3 unit/E2E/typecheck全过 |
| `gh pr diff 845 ... \| git apply --check` | OpenTUI `v0.3.4` 和 `v0.4.3` | 两个基线均 clean |
| `gh pr diff 1224 ... \| git apply --check` | OpenTUI `v0.3.4` | whole PR不 clean apply |
| `gh pr view 845 ...` + `gh api .../tags/v0.4.3` | repository root | #845当前OPEN/MERGEABLE/BLOCKED，head`6fbf515c...`；annotated tag解引用为`5803b2cf...` |
| `bun install --frozen-lockfile` | clean `opentui-v0.4.3` temp clone | exit 1；Bun 1.3.14检测tag lock缺8个native entries |
| `grep` current fork `bun.lock` workspace/package sections | `opentui-smark-r4` | 8个`0.4.3-smark.1` native只出现在workspace optional declarations，`packages` resolution map没有对应prerelease entries；producer在自身release产生前不能让普通optional resolver成为成功路径 |
| `bun install --help` | `opentui-smark-r4` | Bun 1.3.14提供`--omit=optional`，可让producer frozen bootstrap跳过随后由同一job生成的8个native而不放宽lockfile |
| `gh run watch 29556088217 -R SMARK2022/opentui --exit-status` | public `SMARK2022/opentui:smark/main` | source frozen install、focused/native tests和8-target cross-build通过；Solid `261/262`，唯一失败为子进程fixture找不到`three`，因此未进入pack/verifier |
| `bun tests/runtime-plugin-support-configure.fixture.ts` | `thirdparty/opentui/packages/solid` | 独立复现同一模块解析失败：`Cannot find package 'three'`；fixture通过`packages/three/src/index.ts`可达，说明producer source workspace linker需要显式稳定布局 |
| `bun install` + `build:native --all` + core/Solid/keymap builds | temp `opentui-v0.4.3` | 8 native targets与3个OpenCode-relevant JS packages全部构建成功 |
| 11次`npm pack --pack-destination ...` + `shasum -a 256` | built temp OpenTUI closure | 恰好11个npm tarballs，总压缩体积约22 MiB，全部有SHA-256 |
| local Bun HTTP server + `bun install` + public imports | isolated packed consumer | 11个本地tarballs、Solid 1.9.12共110 packages安装；core/Solid/keymap/native imports成功 |
| semantic `0.4.3-smark.1` catalog + URL overrides + exact target reinstall probe | isolated Bun workspace | nonexistent registry prerelease仍由override解析HTTP tarball；`bun install --os=linux --cpu=x64 @opentui/core@catalog:`保持catalog并成功 |
| `GET /repos/SMARK2022/opencode/immutable-releases` + `gh release verify --help` | repository root | immutable API返回shape已确认；gh 2.96.0支持release/asset attestation验证 |

### 18.2 实施阶段必跑命令

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| `bun test test/cli/cmd/tui/session-layout.test.ts` | `packages/opencode` | exact Goal CJK、layout、spinner direct smoke |
| `bun test test/cli/cmd/tui/dialog-prompt.test.tsx` | `packages/opencode` | description factory输出可见 |
| `bun test test/script/upgrade-opentui.test.ts` | `packages/opencode` | version catalog、11 URLs、peer floor与thirdparty exclusion CLI行为 |
| `bun test test/cli/cmd/tui/spinner.test.tsx test/cli/tui/slot-replace.test.tsx test/cli/tui/plugin-loader.test.ts` | `packages/opencode` | Solid catalogue、slot、runtime modules |
| `bun typecheck` | `packages/opencode` | current application APIs与 0.4.3 types兼容 |
| `bun test test/cli/cmd/tui/dialog-prompt.test.tsx test/cli/cmd/tui/session-message-render.test.tsx` | `packages/opencode` | provider/plugin description factory、legacy/v2 error与permission rationale保持可见string |
| `bun typecheck` | `packages/plugin` | public plugin type surface兼容 |
| `bun run script/verify-opentui-closure.ts` | `packages/opencode` | 唯一realpath、release URL/version、gitlink/tag、Solid/runtime与spinner actual graph |
| `bun run script/smoke-opentui-artifact.ts --binary <absolute-extracted-binary-path>` | `packages/opencode` | final archive中的Goal CJK、spinner、resize、exit、process cleanup |
| `bun typecheck` | `packages/opencode` | 通过；artifact harness与OpenTUI consumer typing无错误 |
| `bun test test/script/upgrade-opentui.test.ts test/cli/cmd/tui/session-layout.test.ts test/cli/cmd/tui/dialog-prompt.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx` | `packages/opencode` | 8 pass、0 fail、28 expect；KV ENOENT仅为非阻断日志 |
| `bun run build` | `packages/app`, `packages/enterprise`, `packages/console/app`, `packages/storybook`, `packages/web` | 五个consumer build通过；desktop独立prebuild仍因既有`opencode-sharp.gen.ts`生成缺口失败，未将其伪记为OpenTUI green |
| `bun run build` | `packages/desktop` | 失败；`scripts/prebuild.ts`调用`build-node.ts`，但`src/image/image.ts`要求未生成的`opencode-sharp.gen.ts`，与本次OpenTUI diff无关 |
| `bun run script/verify-opentui-closure.ts` | `packages/opencode` | 当前closure通过，11 packages、Solid 1.9.12、gitlink/tag和darwin native SHA均一致 |
| `bun run script/build.ts --single --skip-embed-web-ui` | `packages/opencode` | host executable可编译并嵌入目标native；保存0.3.4/SMARK binary size对比 |
| `bun run script/build.ts --skip-embed-web-ui` | `packages/opencode` | 12个macOS/Linux/Windows target directories都编译成功且各有target native evidence |
| `bun test` | `packages/opencode` | package full regression；不得从 repo root运行 |
| `bun typecheck` | 每个受影响 package | package-local typecheck；不得直接运行 `tsc` |
| 各自现有 typecheck/build/test script | 9个Solid catalog consumer package目录 | `solid-js@1.9.12`生态兼容 |
| `bun scripts/prepare-release.ts 0.4.3-smark.1 --dry-run` then non-dry-run once | `thirdparty/opentui` | 9个lockstep manifests/8 optional deps；release commit中提交Bun 1.3.14 lock |
| `bun install --frozen-lockfile --omit=optional --linker=hoisted` | `thirdparty/opentui` | producer source bootstrap不改lock且不解析尚未由本次build生成的8个prerelease native；hoisted布局让跨workspace子进程fixture解析`three`等source依赖；随后`build:native --all`必须生成native |
| native/JS full tests + `bun scripts/verify-release-packages.ts --directory <dir> --version 0.4.3-smark.1` | `thirdparty/opentui` | #845/#1224/native Yoga、11 packs、HTTP CJK consumer |
| `gh api repos/SMARK2022/opentui/immutable-releases --method PUT` then GET | repository root | release immutability实际启用 |
| `gh repo view SMARK2022/opentui --json visibility,defaultBranchRef,isFork,parent` | repository root | public fork关系且default=`smark/main` |
| `gh run watch <fork-ci-run> --repo SMARK2022/opentui --exit-status` | repository root | public-runner package producer与macOS/Linux x64/Linux arm64/Windows x64 consumers通过 |
| `gh release verify v0.4.3-smark.1 -R SMARK2022/opentui` + 12个`verify-asset` | downloaded release directory | immutable release tag/commit/assets cryptographic attestation |
| `git submodule status thirdparty/opentui` + nested status/remote/default branch checks | OpenCode root | gitlink等于release commit，nested repo clean，origin/fork正确 |
| macOS/Linux/Windows workflow target build specification + local all-target compile | OpenCode | 所有release targets和native hashes；因OpenCode禁止push，本轮不伪造远端workflow run |
| installed binary PTY/ConPTY smoke | extracted release asset | Goal、spinner、resize、退出、无残留 child |

### 18.3 本轮未执行项

用户已经明确授权OpenTUI/OpenCode完整构建、打包和GitHub上传。OpenTUI commit/push、default branch、immutable setting、fixed-source release workflow、12 assets、attestation、public CI、root submodule、11 URL install/lock、CJK/updater/closure/DialogPrompt red-green、consumer typecheck、all-target compile和当前CI closure/test gates均已完成或已接入。当前剩余：旧Solid patch删除、3份README核对、artifact smoke的第二次TUI真实attach、desktop既有`opencode-sharp.gen.ts`构建前置缺口是否由本轮终态明确排除、OpenCode workflow远端执行、implementation audit/final commit。artifact smoke当前真实失败点为：第一阶段TUI退出后，第二次`<binary> <project> --session <id>`进程启动但未建立daemon SSE，daemon control/health在等待期间不可响应；不得用`/tui/select-session`作为fallback。非host final executable只有在对应workflow实际运行后才能记为runtime verified；若本轮不push最终OpenCode commit，则继续如实列为unverified，不能用cross-compile冒充。

## 19. Diff Budget

### OpenCode repository

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 4 + 1 gitlink | DialogPrompt test、upgrade CLI test、closure verifier、artifact smoke、OpenTUI submodule pin |
| Files modified | 14-17 | `.gitmodules`、3 README、root/package manifests、lock、plugin peer、DialogPrompt、layout test、upgrade CLI、workflows |
| Files deleted | 1 | 已被Solid 1.9.12吸收的旧patch |
| Production lines | 35-60 | description factory + artifact-aware upgrade CLI；dependency metadata不计业务逻辑 |
| Test lines | 115-160 | Goal、DialogPrompt、upgrade CLI三个behavior seams |
| Build/verification lines | 320-440 | closure script、artifact PTY/ConPTY harness与workflow gates |
| Generated lines | 40-90 | `bun.lock`，实际由Bun决定 |

### OpenTUI fork

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 2 | release package verifier、`smark-ci.yml` |
| Files modified | 16-19 | #845三文件、9 version manifests、lock、build/release workflows、README |
| Source/test delta | +119/-13 | GitHub PR reported diff；不重写owner算法 |
| Build/verification lines | 270-390 | package verifier、public CI和immutable release orchestration |
| Generated/version-only lines | 35-55 | 9 manifests与Bun lock；由existing prepare-release/Bun生成 |
| New algorithms | 0 | 不重写，只承接 upstream patch |
| Chinese explanatory comments | 与OpenCode合计至少135行 | 分布按第17节；实际E/C在实现审计重算 |

该 budget 是审计信号，不授权额外 vendor tree、loader、feature flag或 fallback。

## 20. Real Risks and Open Decisions

### 20.1 已证实风险

| Risk | Evidence | Impact | Required control |
| --- | --- | --- | --- |
| 官方 0.4.3不含 #845 | tag blob与 PR blob不同；snapshot也未含 | 版本升级后 Goal仍错 | fork必须同时含 #845 |
| #845 当前无可安装产物 | preview URL 404、artifact过期、npm无snapshot | OpenCode不能直接pin当前PR | fork从精确`v0.4.3`构建11个immutable release tarballs |
| #845 branch使用旧base | PR五个commit最终只改三文件，head metadata不是0.4.3 release | 直接把PR head设默认分支不符合用户基线 | `smark/main`从精确`v0.4.3`创建并完整应用aggregate diff |
| spinner peer mismatch | npm latest `0.0.7` peers `^0.3.4` | install warning和未声明兼容 | root唯一 graph + direct/compiled tests；不混版 |
| Solid runtime mismatch | root 1.9.10 vs OpenTUI peers 1.9.12 | peer contract失败或多runtime | root升1.9.12、删旧patch、9 consumers验证、realpath gate |
| `remove(child)` breaking change | #1224 release body | 直接 id调用会 runtime throw | 全仓 search已排除 direct TUI调用；slot tests保留 |
| native Yoga | 0.4.1 #1126；core移除 JS `yoga-layout`并新增 `./yoga` | layout/cleanup行为变化 | layout、slot、scrollbox full tests |
| Solid catalogue/runtime changes | #1171、JSX runtime exports变化 | custom intrinsic/packaged app风险 | 保留 explicit spinner registration + compiled smoke |
| target reinstall可能改变 graph | build.ts lines 375-395 | host测试与release target不一致 | reinstall后再次 closure/hash gate |
| pristine v0.4.3 lock不满足Bun 1.3.14 frozen install | 实测缺8个native lock entries | CI若现场改lock则不可重复 | release commit先用fixed Bun更新lock，CI只frozen install |
| prerelease native optional packages在producer bootstrap时尚未存在 | current fork lock只有8个workspace optional declarations，没有对应package resolution entries；native packages由同一producer稍后生成 | 普通frozen optional resolver会把source build错误地依赖尚未发布的release | producer固定`--frozen-lockfile --omit=optional --linker=hoisted`，build后对完整11-pack执行HTTP consumer verifier；OpenCode/matrix不使用omit |
| producer source子进程无法解析workspace生态依赖 | public CI `261/262`失败，fixture独立报`Cannot find package 'three'`；fixture从Solid进入`packages/three/src`并由Bun子进程加载 | source suite无法完整覆盖runtime plugin及相关生态，不能进入pack/release | producer source bootstrap显式使用`--linker=hoisted`；只改变producer workspace layout，不改变11-pack或OpenCode consumer graph |
| URL overrides保留全部8个native artifacts | Bun隔离store与lock实测出现全部8包，OS/CPU metadata在URL lock entry显示`{}` | install体积增加，compiled binary可能误嵌入无关native | 记录target native hash与binary size；all-target compile和host artifact inspection阻止无界膨胀 |
| GitHub release默认可修改 | ordinary release允许替换asset/tag | URL相同但内容漂移 | repository启用immutable releases；draft完整上传后publish；attestation + Bun integrity双gate |
| upstream workflows依赖fork没有的服务 | Blacksmith labels、npm token、Azure签名secret | tag workflow会失败或虚假跳过 | 用一个public-runner SMARK release path替换原`v*` workflow，不保留并行tag成功路径 |
| fork Windows DLL unsigned | 无Azure credential producer | Windows reputation/签名属性不同于upstream | release notes显式声明；Windows x64真实load/behavior test；不声称已签名 |
| OpenCode禁止push | Session GOAL commit合同 | 修改后的Linux/Windows OpenCode workflow不能在本轮远端执行 | fork侧native runtime matrix + local all-target compile + macOS final smoke；非host final executable runtime明确列为remaining unverified |

### 20.2 OpenTUI `0.3.4 -> 0.4.3` 变化审计

GitHub compare显示 46 commits；compare files API达到 300-file上限，前300项至少 +11,446/-1,397，其中 core 180 files、Solid 23 files、keymap 3 files。该数字用于说明内部变更广度，不把 examples/docs变化等同于 OpenCode调用修改。

| Area | Change | Current OpenCode impact | Complexity |
| --- | --- | --- | --- |
| core exports | 保留当前入口，新增 `./yoga` | 现有 imports均仍存在 | low |
| native ABI | `bun-ffi-structs 0.2.2 -> 0.2.4`、native Yoga、renderer internals变化 | JS/native必须同 family | high if mixed；low if full family |
| renderer config | 已审阅的 `CliRendererConfig` shape基本稳定 | app config source-compatible | low |
| output backpressure | 0.4.1/0.4.2处理 skip/thread pressure；0.4.3 atomic large frame | 修复 stale output但需 lifecycle regression | medium |
| renderable child API | `remove(id)` -> `remove(child)`，identity bookkeeping | 无 direct caller；slots/reconciler受内部影响 | medium |
| Solid JSX runtime | `jsx-runtime`从 declaration-only变为 JS export；catalogue共享 | build plugin和custom intrinsic需实测 | medium |
| Solid slots | native Yoga和child identity cleanup | plugin slots直接可达 | medium |
| keymap exports | relevant subpaths保持 | named imports source-compatible | low |
| keymap runtime modules | eager framework imports改 lazy loaders | plugin runtime直接可达 | medium |
| terminal capabilities | 增加 OSC52 state字段 | 当前只消费 TerminalColors，无完整 object construction | low |
| parser worker | export/path保留 | build.ts realpath逻辑仍适用 | low |
| DialogPrompt child | upstream OpenCode需显式调用 factory | 当前 fork存在同一待迁移点 | medium but one-line fix |
| spinner ecosystem | 无0.4.x release；peer metadata旧 | runtime在 upstream PR CI通过，当前 explicit registration更稳 | medium residual |

### 20.3 为什么保留 `thirdparty/opentui`，但不从它构建

用户已经明确选择public fork + in-repo submodule。最小正确职责分解是：

- `thirdparty/opentui`保存完整源码、独立Git历史、release commit和便捷clone入口。
- `.gitmodules`的`branch = smark/main`只辅助`git submodule update --remote`；OpenCode gitlink才是source pin。
- OpenTUI fork自身拥有Bun/Zig、cross-build、11-package pack、checksums和immutable release。
- OpenCode root install直接访问public release tarballs；不要求submodule initialized，也不要求本机安装Zig。
- OpenCode closure gate比较gitlink、release tag commit、package version/URL和installed native hash，证明源码与产物对应。

如果OpenCode直接从submodule build，会要求在root `bun install`之前先bootstrap另一个workspace并产生循环，也会使普通clone缺Zig时无法安装。若Release URL失败后才从submodule build，则成为明确禁止的alternate success path。当前路线同时满足用户的源码可发现性和独立artifact消费要求，不引入这两个问题。

### 20.4 GitHub Actions 生产流程

推荐 workflow stages：

| Stage | Repository | Action | Output/gate |
| --- | --- | --- | --- |
| 1. repository | GitHub | fork`anomalyco/opentui`为public`SMARK2022/opentui`，创建/默认`smark/main` | fork关系、visibility、default branch API evidence |
| 2. source | fork | exact`v0.4.3`base完整合入#845，prepare`0.4.3-smark.1` | base/PR/tree SHA、9 manifests、committed lock |
| 3. source test | fork | native red-green、full native/core/Solid/keymap tests | 零失败logs |
| 4. cross-build | fork | `build:native --all` + core/Solid/keymap build | 11 required package directories |
| 5. pack | fork | 11次`npm pack` + `SHA256SUMS` + local artifact verifier | exact filenames/name/version/checksums/CJK 2/2 |
| 6. public CI | fork | `smark/main` matrix consumers | macOS、Linux x64、Linux arm64、Windows x64 package behavior |
| 7. immutable publish | fork | draft upload 12 assets -> publish -> `gh release verify` | protected tag/assets + attestation |
| 8. source pin | OpenCode | add submodule/gitlink anddocs | gitlink == immutable tag commit；nested clean |
| 9. consume | OpenCode | version catalog、11 URL overrides、Solid 1.9.12、clean install | unique realpath/source/integrity report |
| 10. source checks | OpenCode | updater/Goal/DialogPrompt/ecosystem/full tests与package typechecks | behavior与API compatibility |
| 11. target build | OpenCode | existing all-target `build.ts` + closure/native/binary size evidence | 12 target directories和native hashes |
| 12. artifact smoke | OpenCode | extracted host archive PTY；workflow specification覆盖其他hosts | Goal/resize/spinner/exit frames与process inventory |
| 13. independent audit/commit | both repos | full-scope implementation audit；root commit不push | verified verdict、OpenTUI commit、OpenCode commit IDs |

30天workflow artifact只在同一次CI run中把producer输出传给matrix，不能成为OpenCode dependency source。唯一长期build input是immutable GitHub Release中的npm-compatible tarballs；最终OpenCode zip/tar/exe格式保持不变。

### Open Decisions Requiring the User

R4没有仍需用户选择的产品决策。用户已明确授权public fork、`smark/main`默认分支、submodule、独立OpenTUI build/package/release、GitHub上传和完整OpenCode相关构建。实现不得额外发布OpenCode GitHub Release或push OpenCode commit；这些不是完成本目标所需的外部动作。

### Rejected Speculation

- “所有中文乱码都由 #1224 修复”：证据只覆盖输出缓冲截断/stale cell路径；字体、终端编码等无 producer证据，不作保证。
- “0.4.3 会因 `remove(child)` 直接编译失败”：全仓 search未发现 OpenTUI renderable `.remove(id)` caller。
- “必须 fork spinner”：npm peer range确实旧，但 upstream OpenCode 0.4.3 CI和当前 direct registration证明可以先通过真实 graph测试，不应无证据增加第二个 fork。
- “最终 installer需要知道 OpenTUI”：Bun compile已嵌入 native，installer只搬运 executable。
- “只要文本复制顺序正确就不是 buffer问题”：exact framebuffer capture已观察到 visual cell重复，复制源顺序不能反证 render buffer缺陷。
- “有submodule就应从源码build”：用户同时明确要求OpenTUI先独立打包发布、主仓库消费产物；submodule是source/provenance pass-through，不是dependency fallback。
- “HTTP tarball不能进入Bun catalog/overrides”：Bun 1.3.14 catalog、target reinstall和11-pack本地HTTP probes均已成功；真实GitHub URL仍必须在release后重跑。
- “unsigned Windows DLL必然无法加载”：签名属性确实不同，但是否可加载由Windows x64实际consumer test决定；没有证据要求伪造或跳过该test。

## 21. Audit Contract

独立 auditor 必须：

- 阅读本文和第 1 节原始要求。
- 从 repository、上游源码和可重复命令独立重建行为。
- 把 builder summary视为不可信。
- 每轮覆盖完整原始范围，不缩到最近修改段落。
- 每个 blocking finding必须给出 observed、contracted或reachable证据。
- 同时检查 under-design与over-design。
- 检查 root-cause repair、fallback、ownership、tests、code quality和15%中文解释性评论计划。
- 特别验证“fork package family”没有退化为 core-only Git依赖或 mixed native graph。
- 特别验证public fork/default branch、gitlink、immutable tag和11 assets属于同一source commit/version，且OpenCode没有submodule/npm fallback。
- 特别验证OpenTUI prerequisite commit/push只承载已经测试的artifact identity，最终OpenCode commit仍遵守post-audit/no-push合同。
- 特别验证 #1224 与 #845 没有被错误合并为同一修复声明。

## 22. Plan Audit Record

### R5 Revision Delta

R4批准后，隔离OpenTUI fork的当前lock/workflow实施暴露出一个此前未被明确写入producer contract的兼容事实：`bun.lock`的8个`0.4.3-smark.1` native只存在于`packages/core`的`optionalDependencies` workspace声明，lockfile的`packages` resolution map没有这些尚未发布的prerelease entries。producer必须先在同一job中由`build:native --all`生成它们，不能在生成release之前让source bootstrap解析它们。

因此R5只收敛producer bootstrap命令为`bun install --frozen-lockfile --omit=optional`，并明确该省略仅属于OpenTUI source producer；11-package artifact verifier、public CI matrix和OpenCode consumer仍必须安装完整native closure。没有增加fallback、第二个package source、runtime loader或新的consumer成功路径。R4 approval已清空，R5必须按原始完整范围重新审计。

### R6 Revision Delta

R5批准后的public CI在source install、focused/native tests和8-target cross-build均通过后，于Solid suite的`runtime-plugin-support-configure.fixture.ts`失败。该fixture通过Bun子进程从Solid source进入`packages/three/src/index.ts`，独立执行同样得到`Cannot find package 'three'`。失败发生在producer source workspace layout，不在CJK owner、native binary、package verifier或OpenCode consumer。

R6只把producer bootstrap固定为`bun install --frozen-lockfile --omit=optional --linker=hoisted`。hoisted是source-test子进程的确定性workspace resolution，不改变11个release asset、consumer verifier、OpenCode URL overrides或任何fallback路径。R5 approval已清空，R6必须按原始完整范围重新审计。

### R7 Revision Delta

R6独立审计发现canonical plan内部把已经发生的状态同时写成“已完成”和“尚未创建”。该段是R6/R7历史快照，不是当前状态；R9的current state以`cbe492a538137842961d561c33f55fdb7587b40e`为唯一source identity。

R7只统一canonical evidence和执行边界，不增加新的实现路径。R9已进一步确认source/default/tag/gitlink均为`cbe492a5`；唯一未完成的OpenTUI发布步骤是GitHub Release draft/assets/attestation，原因是workflow token无法读取administration接口。`pkg-pr-new`仍仅作为上游PR开发预览而非生产source。

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | B-01 Solid依赖链/旧patch未纳入；B-02 final artifact smoke不可执行 | comment estimate未计fork；audit mode metadata | BLOCK | `ses_0981f4e92ffeGiXHLu0OdJ6pc6` |
| 2 | R2 | yes | B-01 Linux arm64 release archive未收敛到唯一执行gate | fork preview前置条件、revision文字、重复项、额外preview packages | BLOCK | `ses_0981331d4ffeUxEZ5q7JLAUrlW` |
| 3 | R3 | yes | No blocking findings. | 无。 | APPROVE — exact canonical plan revision R3 only. | `ses_0980c0bc2ffe6w3oix4GhiZNLN` |
| 4 | R4 | yes | No blocking findings. | R4审计记录待回填；Audit mode元数据应统一；upgrade CLI未来/非法版本规则较抽象；非host final executable runtime须保留为未验证边界。 | APPROVE — exact canonical plan revision R4 only. | `ses_091cd2d69ffeTncUda0MdFXuQT` |
| 5 | R5 | yes | No blocking findings. | R5历史/阶段性元数据需行政回填；未来/非法版本URL规则需在实施时拒绝不存在release；非host final executable runtime须保留未验证边界；artifact smoke需使用readiness signal而非固定sleep。 | APPROVE — exact canonical plan revision R5 only. | `ses_091a7434affeDIQKoJuL1QwXxV` |
| 6 | R6 | yes | B-01 canonical implementation state contradicts repository/fork/submodule state | historical audit metadata；pkg-pr-new preview workflow边界；non-host final runtime未验证 | BLOCK | `ses_0918350a7ffe3l93q9pbB8JFzV` |
| 7 | R7 | yes | No blocking findings. | 历史revision metadata需行政归档；跨仓库实施面需按阶段审计；非host final runtime须保留未验证；未来版本URL策略、artifact readiness contract需在实施时具体化。 | APPROVE — exact canonical plan revision R7 only. | `ses_0917e9837ffeYywNfW4A7tGLoP` |
| 8 | R8 | yes | B-01 release/source identity contradicted by stale `ea4ed655` and no-tag snapshots while current tag/gitlink are `cbe492a5` | 历史审计记录与维护者immutable evidence位置需补充 | BLOCK | `ses_090c826ddffeMN5Oxe6121Lubo` |
| 9 | R9 | yes | B-01 corrected release workflow cannot be reached by rerunning the already-pushed tag event because reruns retain the old workflow SHA/ref | several stale implementation-evidence snapshots; release-failure rule duplicated | BLOCK | `ses_090c43519ffeeoAWu82ABP9Osf` |
| 10 | R10 | yes | No blocking findings. | R10 audit metadata remains to be administratively recorded; dispatch invocation should be recorded as an exact verification command; direct API state was not independently queryable in auditor environment | APPROVE — exact canonical plan revision R10 only. | `ses_090bf8bddffeaoLcsOanBpLIiQ` |
| 11 | R11 | yes | B-01 release/root consumer current state contradicted live manifest；B-02 v2 structured error缺少renderer-level behavior test | historical audit blocks需与current contract分离；E/C计划算术可行 | BLOCK — exact canonical plan revision R11. | `ses_0907e30cbffetDPNZSbajzBuxa` |
| 12 | R12 | yes | B-01 canonical plan已超过policy允许的6轮full-scope plan audit，不能通过既有cycle批准 | historical material需更清晰归档；verification table应直接列v2 focused test；E/C计划可行 | BLOCK — exact canonical plan revision R12. | `ses_090746efcffehmE1V281L14A14` |

任何 substantive revision都会使此前 approval失效。

### R11 Independent Verdict (verbatim)

```text
## Blocking findings

### B-01 R11 has no authoritative release and consumer state

R11 says the immutable release and root 11-URL graph are complete while other
normative current-state sections say the release does not exist and OpenCode
still resolves official 0.3.4. Reconcile release, assets, catalog, overrides,
lock, gitlink, completed work and remaining steps into one authoritative state.

### B-02 The R11 v2 error rendering change has no behaviorally sensitive verification

The v2 plugin route is reachable when experimentalEventSystem is enabled, but
the planned legacy fixture and typecheck cannot prove the structured error's
message string is visible. Add a renderer-level assertion through the real v2
plugin/route seam and reject object coercion.

## Release verdict

BLOCK — exact canonical plan revision R11.
```

### R12 Independent Verdict (verbatim)

```text
## Blocking findings

### B-01 R12 is beyond the permitted plan-audit round limit

A canonical plan may receive at most six full-scope plan-audit rounds. The
canonical audit record already reached the sixth round at R6 and continued
through R11, so this R12 invocation cannot grant approval under the current
contract. Treat R12 approval as an open user decision; do not authorize further
implementation through the exhausted audit cycle.

## Release verdict

BLOCK — exact canonical plan revision R12.

The technical requirement, ownership, primary-path, fallback, forward-
traceability, reverse-traceability, testing, and plan-stage comment gates are
otherwise covered. Release is blocked solely because the repository's hard
six-round plan-audit limit was exceeded before R12.
```

### R8 Independent Verdict (verbatim)

```text
## Blocking findings

### B-01 R8 leaves the release/source identity in contradictory states

INV-09 requires the public fork default branch, OpenCode gitlink, immutable
release tag, and package metadata to identify one exact source commit. The
canonical plan still named `cbe492a...` as the tag commit while other normative
and implementation-evidence sections named `ea4ed655...` and stated that the
tag did not exist. The plan therefore did not define one executable retry
contract for the already-pushed tag and gitlink.

Minimal correction: reconcile the current plan so one exact source commit, tag
status, gitlink status, and retry rule are authoritative while preserving the
R8 permission-boundary repair.

## Release verdict

BLOCK
```

### R9 Independent Verdict (verbatim)

```text
## Blocking findings

### B-01 The prescribed retry cannot execute the corrected release workflow

The existing tag event fixes `GITHUB_SHA` and `GITHUB_REF` to the original
`cbe492a5` event. A rerun therefore loads the old failing workflow and cannot
reach a corrected workflow committed later on `smark/main`. The canonical plan
must define an executable current-workflow invocation whose package source is
still explicitly pinned to `cbe492a5`; it must not move the existing tag or add
an alternate artifact source.

## Release verdict

BLOCK — exact canonical plan revision R9.
```

### R10 Independent Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Release verdict

APPROVE — exact canonical plan revision R10 only.

This approval applies only to the canonical plan at Revision R10. Any
substantive change to the plan, OpenTUI workflow, source identity, package
family, release contract, submodule pin, or OpenCode consumer path requires a
new full-scope plan audit.
```

### R7 Independent Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

1. **Revision metadata仍存在历史状态漂移。** 当前文档顶部是 `Revision: R7`、`Audit mode: plan`、`Approved revision: none`，第 22 节仍保留 R5/R6 的历史审计记录，第 23 节明确 R7 尚未获得实施授权，第 24 节尚未开始 implementation audit。该状态不会阻塞本轮计划审计，但在记录本轮结果时应仅做行政性回填，避免把历史 `APPROVE` 或 `PENDING` 误读为 R7 的批准。

2. **计划包含较大的跨仓库执行面，实施阶段必须严格按阶段审计。** 计划同时涉及 OpenTUI fork、独立 source commit、GitHub Actions、immutable release、11 个 package tarballs、OpenCode submodule、Bun lock、Solid runtime、最终 target build 和 artifact smoke。当前计划已经明确这些阶段的先后顺序以及“OpenTUI 先发布、OpenCode 后消费”的边界，但任一 OpenTUI source/workflow/package contract 的实质变化都会使 R7 失效并要求重新进行完整范围计划审计。

3. **非 host 的最终 OpenCode executable runtime 仍是明确未验证边界。** 计划没有把 OpenTUI package matrix 或 cross-target compile 冒充为 Linux/Windows 最终 OpenCode executable 的运行时验证，并已在 `18.3`、`20.1` 和 `23` 中披露这一限制。实施报告必须继续保留该边界，不能将其写成“所有最终平台运行验证通过”。

4. **`script/upgrade-opentui.ts` 的未来版本策略仍需在实施时具体化。** R7 已明确本次 `0.4.3-smark.1` 的 11 个 asset URL、`thirdparty` 排除和 peer floor 更新，但对官方版本、后续 `smark.N` 版本、缺失 release 和非法输入的拒绝行为仍主要以“确定性映射”和 release 前置条件描述。实施时不得静默生成不存在的 URL 或产生无法安装的 lockfile。

5. **最终 artifact smoke 的同步实现必须遵守 readiness contract。** 计划已经写明 lock-file、health check、状态轮询、PTY/ConPTY 清理和 timeout 边界；实际实现不得退化为固定 `sleep` 作为唯一后台进程就绪信号，也不得把 cleanup 失败吞掉。

## Release verdict

**APPROVE — exact canonical plan revision R7 only.**

该结论仅适用于：`docs/Proposal/opentui-0.4.3-upgrade-and-distribution-proposal.md`, `Revision: R7`, `Audit mode: plan`。本结论不授权实施本身；记录方应仅行政性回填R7 approved metadata，任何后续 substantive plan/source/workflow/package-release change都需要重新完整范围审计。
```

### R4 Independent Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

- **R4 的审计记录仍未回填独立审计结果。** 第 22 节明确显示 R4 为 `pending`，这是当前正确的状态，不影响本轮审计；只有审计结果被记录后，才能转为 `approved`。
- **`Audit mode` 元数据写作 `full-scope`，而本次调用模式为 `plan`。** 这不改变计划行为或实现约束，但在实施前应统一元数据，避免后续审计工具误判阶段。
- **`script/upgrade-opentui.ts` 对未来版本的 URL 映射规则仍较抽象。** 当前 R4 已明确本次 `0.4.3-smark.1` 的 11 个 asset URL、排除 `thirdparty` 扫描并保持单一依赖图；但实施时应明确对官方版本、后续 `smark.N` 版本和非法版本输入的处理，不得将不存在的 release URL 静默写入 lockfile。
- **最终 OpenCode Linux/Windows 非 host executable 的运行时验证被计划明确列为未验证。** 该限制已如实记录，并未被错误报告为通过；因此不是阻塞缺陷，但发布报告必须保留该边界。

## Rejected speculation

- 不能仅凭 `opentui-spinner@0.0.7` 的旧 peer range 判定 0.4.3 一定运行失败。当前已有显式 `SpinnerRenderable` 注册，且上游 OpenCode 0.4.3 迁移保留该 spinner 后通过了相关 CI；计划要求继续执行 spinner、编译产物和最终 artifact 验证。
- 不能把所有 CJK 乱码都归因于 #1224。计划区分了两条已证实路径：#845 的 virtual chunk UTF-8 offset 错位，以及 #1224 的大帧缓冲提交损坏；字体、locale、终端编码等没有当前 producer 或契约证据，计划未将其转化为生产逻辑。
- 不能要求仅升级官方 OpenTUI 0.4.3 就满足完整需求。计划已提供证据说明官方 0.4.3 包含 #1224 但不包含 #845，因此官方版本单独使用无法覆盖 INV-01/INV-02。
- 不能要求从 `thirdparty/opentui` 源码参与 OpenCode 正常安装或在 release URL 失败时回退源码。用户要求的是独立构建、发布后由主仓库消费产物；计划将 submodule 限定为源码可发现性和 provenance，符合该边界。
- 不能仅凭 URL override 可能缓存多个 native package 就认定最终 executable 一定嵌入错误平台库。计划已将 target reinstall、native hash、binary size 和最终 artifact 检查列为硬验证项；在缺少实际实施结果前，该风险只能作为待验证风险。

### R5 Independent Verdict (verbatim)

```text
## Blocking findings

No blocking findings.

## Non-blocking findings

1. **R5 的历史审计记录仍包含未回填/阶段性元数据。**
   `docs/Proposal/opentui-0.4.3-upgrade-and-distribution-proposal.md:844-850` 仍将 R5 标记为 `pending`，且 `:932-945` 的正文释放结论仍是 `PENDING`。这不会阻止当前计划审计，但在记录独立审计结论后，必须只进行行政性回填，将 R5 状态更新为 `approved`、`Approved revision: R5`、`Implementation allowed: yes`；不得同时修改设计内容。

2. **`script/upgrade-opentui.ts` 对未来版本和非法版本的行为仍未完全具体化。**
   计划已经明确本次 `0.4.3-smark.1` 的 11 个 release URL、`thirdparty` 排除规则及 peer floor，但没有完全规定官方版本、后续 `smark.N` 版本、缺失 release 和非法输入的拒绝行为。相关计划位置：`:440`、`:593-594`、`:865`。实施时不能静默写入不存在的 URL 或产生无法安装的 lockfile。

3. **非 host 的最终 OpenCode executable runtime 验证仍是明确边界。**
   计划如实说明 Linux/Windows 非 host 最终可执行文件不会通过修改后的 OpenCode 远端 workflow 验证，而是依赖 fork package matrix、cross-target compile 和 host smoke：`:475-483`、`:696-698`、`:749`、`:984-992`。这不是当前阻塞项，因为该限制已被明确披露；发布报告必须继续保留该限制，不能把 cross-compile 或 native package smoke 表述为最终 OpenCode binary 的运行时验证。

4. **实施阶段的 cleanup/同步契约需要严格遵守测试仓库规则。**
   最终 artifact smoke 计划使用 PTY/ConPTY、daemon、HTTP fixture 和轮询：`:454-475`。实施时应避免将固定 `sleep` 作为后台进程就绪的唯一同步手段；`packages/opencode/test/AGENTS.md` 要求使用可观察 readiness signal。该问题属于实施质量提醒，不构成当前计划级阻塞，因为计划已经定义 lock/health-check、状态轮询和 cleanup 边界。

## Rejected speculation

- **“OpenTUI 0.4.3 已经解决全部 CJK 乱码”**：不成立。计划正确地区分了两个已证实路径：
  - #845：`TextBufferView` 的 CJK/virtual-chunk column 与 UTF-8 byte offset 不同步；
  - #1224：大 ANSI frame 输出缓冲区损坏及 stale-frame commit。
  上游 #1224 的公开 PR 描述明确包含“output buffers grow on demand”“partial frames are not flushed”“failed growth forces full repaint”；官方 `v0.4.3` release 也列出 #1224。计划没有把字体、locale、终端编码等无证据因素转化为生产逻辑，符合“无证据不增加 edge case”的要求。

- **“官方 0.4.3 单独升级即可解决用户现象”**：不成立。计划的当前反馈回路在 `:318-346` 给出了 0.3.4 的 `source=2/rendered=3` 与应用 #845 后的 `2/2`。官方 0.4.3 包含 #1224，但不包含 #845，因此不能单独满足 INV-01/INV-02。

- **“必须 fork `opentui-spinner`”**：当前没有足够证据。计划记录了旧 peer range，但同时保留现有显式 `SpinnerRenderable` 注册，并要求 spinner、compiled binary 和 artifact smoke 验证：`:407-415`、`:437`、`:769`。这符合不因 metadata mismatch 擅自引入第二个 fork 的原则。

- **“submodule 必须参与 OpenCode 源码构建”**：不是用户要求的唯一解释。用户同时要求 OpenTUI 独立构建、打包、发布，再由主仓库消费产物。计划把 submodule 定义为源码可发现性和 provenance pin，把 GitHub Release 定义为唯一 package source：`:348-360`、`:771-781`。这不是 fallback，因为 submodule 不产生 OpenCode 构建成功结果，也不会在 release URL 失败后激活。

- **“URL overrides 可能把多个 native 包放入 Bun store，所以最终一定嵌入错误平台库”**：目前只有已记录的可达风险，没有证明必然失败。计划要求 target reinstall、native hash、binary size、all-target compile 和 extracted artifact inspection：`:444-452`、`:742-745`。该风险应在实施中验证，不能据此提前判定方案错误。

- **“GitHub immutable release 没有可验证的 attestation 能力”**：不成立。GitHub 官方文档确认 immutable release 会锁定 tag/assets 并自动生成 release attestation，`gh release verify` 与 `gh release verify-asset` 是对应验证入口。计划在 `:417-428`、`:688-691` 使用该能力的方式与当前平台契约一致。

## Requirement and traceability coverage

- **上游 PR 调研与路线比较**：已覆盖官方 `0.4.3`、#845、#1224、0.3.4 backport、混合 native graph、Git URL、preview artifact 和 workflow artifact 等路线，见 `:32-43`、`:496-514`。
- **CJK 重复渲染**：INV-01/INV-02 明确表达了“不重复、不拆分 grapheme”及 column/byte offset 同步要求，见 `:290-296`。
- **buffer/stale-frame 损坏**：INV-03 指定 renderer commit invariant，并将责任归属 OpenTUI renderer，而非 OpenCode caller，见 `:296-297`、`:310-312`。
- **完整依赖链**：INV-04、INV-06、INV-08 覆盖 core、Solid、keymap、8 个 native packages、spinner 和唯一 `solid-js@1.9.12` runtime，见 `:297-301`。
- **OpenCode 调用变化**：`DialogPrompt.description` 从传递 function object 改为 owner component 中调用 factory，见 `:313`、`:430-440`。
- **Solid 生态迁移**：root `solid-js` 从 1.9.10 升级到 1.9.12，并移除已被上游吸收的 patch，见 `:409-415`。
- **fork/submodule/release provenance**：INV-09/INV-10/INV-11 覆盖 public fork、`smark/main`、gitlink、immutable tag、11 个 tarballs、checksums、integrity 和升级 CLI，见 `:302-305`、`:527-542`。
- **GitHub Actions 分发**：producer、public matrix、immutable publish、attestation、consumer install 和最终 OpenCode build 均有路径与验证项，见 `:417-428`、`:783-803`。
- **原始用户可观察场景**：42-cell sidebar、35-cell odd text box、外层 framebuffer 仍有可绘制 cell 的真实几何已被明确保留，见 `:318-346`。
- **测试敏感性**：TDD slices 能在当前缺陷上形成 red，包括 CJK `2/3`、官方包缺少 #845、升级 CLI 漂移、DialogPrompt factory、closure/native hash 和最终 artifact smoke，见 `:607-622`。
- **反向追踪**：主要新增生产概念均有 requirement ID、证据及现有逻辑不足理由，见 `:544-559`。
- **未验证边界**：尚未发布 fork、尚未创建真实 GitHub release、尚未进行 OpenCode clean install/all-target build，以及非 host final runtime 限制均已显式列出，见 `:949-992`。

## Primary-path and fallback verdict

计划建立了单一 authoritative primary path：

```text
OpenTUI v0.4.3
  -> 应用 #845 owner-level TextBufferView 修复
  -> 同一 source commit 的 11-package family
  -> immutable GitHub Release
  -> OpenCode catalog/URL overrides/lock integrity
  -> target-specific native install
  -> Bun compile
  -> extracted final artifact smoke
```

判断如下：

- #845 修复的是 OpenTUI `TextBufferView` 的第一处分歧，没有把修复下移到 Goal caller。
- #1224 由 OpenTUI 0.4.3 renderer 提供，没有在 OpenCode 层重复实现。
- 没有新增 alternate renderer、caller clipping、手工换行、runtime loader 或“官方包失败后加载 fork”的 fallback。
- `thirdparty/opentui` 是 provenance/pass-through，不是 OpenCode 构建的第二成功来源。
- 11 个 package URL override 构成同一 release family，而不是 core-only Git dependency 或 registry/native 混合图。
- 现有 spinner registration、`captureCJKFrame()` 和 root overrides 均有明确的保留理由，没有被无证据删除。
- 计划对官方 0.4.3、0.3.4 backport、手工移植 #1224、preview artifact、workflow artifact、submodule fallback 等竞争路径均作出拒绝或保留决定，且没有引入新的成功路径。

Primary-path、root-cause、ownership 和 fallback hard gates 均满足。

## Code quality and Chinese-comment verdict

本次是 **plan audit**，没有 implementation diff，因此不能计算实际实现阶段的 `E/C`，也不存在实际代码质量或注释比例失败。

计划层面满足以下约束：

- 遵守 package-local test/typecheck working-directory 规则。
- 没有计划通过 `any`、类型抑制、错误吞掉或兼容分支解决升级问题。
- 保留已有 explicit spinner registration，未引入重复 renderer/catalogue 方案。
- 将 native 算法修复留在 OpenTUI owner module。
- 将 package verifier、OpenCode closure verifier 和 final artifact smoke 放在各自责任边界。
- 明确实施阶段按：

```text
if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))
```

  重新计算中文解释性注释。
- 计划提交的估算为 `E ≈ 900`、`C >= 135`，并明确生成 lockfile、纯版本变更、import-only 和格式化行不计入 `E`：`:624-642`。
- 由于当前没有实现 diff，不能把计划中的 `E/C` 估算当作实现阶段通过证明；后续 implementation audit 必须按实际 diff 重算。

## Release verdict

**APPROVE — exact canonical plan revision R5.**

本结论仅适用于：

```text
docs/Proposal/opentui-0.4.3-upgrade-and-distribution-proposal.md
Revision: R5
Audit mode: plan
```

该结论不授权实施本身。按照仓库策略，记录方仍必须把本次独立审计结果原样回填到第 22 节，并将元数据转换为：

```text
Status: approved
Revision: R5
Approved revision: R5
Implementation allowed: yes
```

任何后续 substantive plan change 都会使本次 R5 审计失效，并需要重新进行完整范围审计。

```

- **上游修复 PR 调研：** 已区分并审计 #845、#1224，以及官方 0.4.3、0.3.4 backport、PR head artifact 等路线。
- **CJK 行为：** INV-01/INV-02 明确描述“不重复、不拆分 grapheme”及 column/byte offset 同步；第 8 节给出了当前 0.3.4 `2/3` 失败与 #845 构建后 `2/2` 成功的反馈回路。
- **buffer/stale-frame 行为：** INV-03 明确要求只有完整 ANSI frame 成功提交后才能标记 committed；计划把责任归属 OpenTUI BufferedBackend/renderer，而不是 OpenCode caller。
- **完整依赖链：** INV-04、INV-06、INV-08 覆盖 core、Solid、keymap、8 个 native packages、spinner 和唯一 `solid-js@1.9.12` runtime。
- **OpenCode 调用迁移：** INV-05 覆盖 `DialogPrompt.description` factory 求值，计划修改 owner component 为 `props.description?.()`。
- **source/package/release provenance：** INV-09、INV-10、INV-11 覆盖 public fork、`smark/main`、submodule gitlink、immutable tag、11 个 tarballs、integrity 和升级 CLI。
- **构建与分发：** 第 10.3、10.5、10.6 节覆盖 OpenTUI 独立构建、GitHub Actions、immutable release、Bun target install、OpenCode compile 和最终 PTY/ConPTY smoke。
- **测试敏感性：** TDD slices 能在当前行为上形成 red，包括 42/35 几何的 CJK 回归、official 0.4.3 artifact 失败、升级 CLI 漂移、DialogPrompt factory、closure/native hash 和最终编译产物。
- **反向追踪：** 第 14 节为新增 fork、submodule、release、verifier、closure gate、升级 CLI、headless terminal 和 factory migration 提供了 requirement ID、证据和现有逻辑不足的理由。
- **未验证边界：** 第 18.3、23 节明确列出了尚未创建 fork、尚未发布 release、尚未 clean install、尚未执行 all-target build 和非 host 最终 executable runtime 的项目，没有把调查证据伪装成实施证据。

## Primary-path and fallback verdict

- 计划建立了唯一主路径：

  v0.4.3
    -> #845 owner-level patch
    -> 11-package same-version family
    -> immutable GitHub Release
    -> OpenCode URL overrides + lock integrity
    -> target-specific native install
    -> Bun compile
    -> final package smoke

- #845 修复的是 OpenTUI `TextBufferView` 的第一处分歧；#1224 由 0.4.3 原生 renderer 提供，未在 OpenCode 层重复实现。
- 计划没有引入 runtime fork-on-failure、official package fallback、submodule source fallback、alternate renderer、Goal caller clipping 或手工换行。
- `thirdparty/opentui` 是 provenance/pass-through，不产生 OpenCode build success，因此不构成 alternate success path。
- 现有 `build.ts` 的安装重试属于同一 URL/source 的缓存恢复，不是竞争语义的第二个成功实现。
- secondary/replacement inventory 已覆盖官方 0.4.3 单独使用、0.3.4 backport、手工移植 #1224、Git URL 混合 native、workflow artifact、submodule fallback 等路径，并全部作出拒绝或保留决定。
- 计划的 primary-path、root-cause、ownership 和 fallback hard gates 满足当前 R4 的范围。

## Code quality and Chinese-comment verdict

本轮为 **plan audit**，没有 implementation diff，不能计算实际实现阶段的 `E/C`，也不存在可审计的实际代码质量失败。

计划本身已：

- 约束 OpenCode 测试和 typecheck 从 package 目录执行；
- 明确保留现有 explicit spinner registration；
- 禁止新增 runtime loader、fallback、无证据兼容分支；
- 将 native 算法修复限定在 OpenTUI owner module；
- 将 release verifier、closure verifier 和最终 artifact smoke 放在各自责任边界；
- 在第 17 节承诺实现阶段至少按 `E≈900`、`C≥135` 执行中文解释性评论预算，并明确实施审计重新计算；
- 明确生成文件、lockfile 和纯版本变更不计入 `E`。

实施阶段仍必须实际重算：

if E = 0: C = 0
if E > 0: C >= max(1, ceil(E * 0.15))

该计划审计不能替代后续 implementation audit 的代码质量和中文评论硬门槛。

## Release verdict

**APPROVE — exact canonical plan revision R7 only.**

本结论仅适用于当前文件的R7；R7只完成canonical state reconciliation，不替代后续implementation audit：

docs/Proposal/opentui-0.4.3-upgrade-and-distribution-proposal.md
Revision: R7

实施前仍必须由记录方将R7独立审计结果写入第 22 节，并把状态转换为：

Status: approved
Revision: R7
Approved revision: R7
Implementation allowed: yes

任何后续 substantive plan change、OpenTUI source change、producer workflow change或package/release contract change都会使R7批准失效，并需要重新进行完整范围审计。
```

## 23. Implementation Evidence

R12批准范围已经完成实施并停止material change。OpenTUI source、package producer、public fork、default branch、immutable release、root submodule pin、11-package consumer graph、OpenCode兼容迁移、build evidence、closure、artifact smoke和workflow gates均已形成同一primary path。后续只允许处理独立implementation auditor确认的blocking finding；不得在审计期间夹带新行为。

### Actual Files and Diff

已提交并push的OpenTUI source commit `cbe492a538137842961d561c33f55fdb7587b40e`包含`v0.4.3 + #845`、11-package build/pack/verifier和release source；workflow-only commit `e1b90732d4edc7c79965ac655df6b20753e67fc5`位于default `smark/main`。OpenCode root commit `d0ceb469011412b4ac5058a12d5fe4f247bdac79`将gitlink固定到同一source/tag commit。当前OpenCode worktree中的本GOAL路径为：

- `.github/workflows/build-opencode.yml`、`.github/workflows/test.yml`
- `README.md`、`docs/readme/README.en.md`、`docs/readme/README.zht.md`
- `package.json`、`bun.lock`、`packages/plugin/package.json`、`packages/opencode/package.json`
- `script/upgrade-opentui.ts`
- `packages/opencode/script/build.ts`
- `packages/opencode/script/verify-opentui-closure.ts`
- `packages/opencode/script/smoke-opentui-artifact.ts`
- `packages/opencode/src/cli/cmd/tui/ui/dialog-prompt.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/src/cli/cmd/tui/feature-plugins/system/session-v2.tsx`
- `packages/opencode/test/cli/cmd/tui/session-layout.test.ts`
- `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx`
- `packages/opencode/test/cli/cmd/tui/session-v2-error.test.tsx`
- `packages/opencode/test/script/upgrade-opentui.test.ts`
- 删除`patches/solid-js@1.9.10.patch`；用户于2026-07-17对该确切文件明确授权删除。

无关dirty路径`packages/core/src/models-snapshot.js`、`sdks/vscode/.gitignore`、`docs/plans/vscode-extension-release-surface-reliability.md`和session markdown不属于本GOAL，未修改、未回退、不得进入最终commit。

### Red-Green Test Evidence

native targeted slice先得到`expected 14, found 15`，修复后`19/19`；official `v0.4.3` 11-pack verifier得到`source=2/rendered=3`，SMARK `0.4.3-smark.1` 11-pack得到`2/2`。OpenCode exact 42/35 Goal regression在official 0.3.4得到source 2/rendered 3，安装immutable `0.4.3-smark.1`后得到2/2。DialogPrompt factory、11-URL updater、v2 structured error和artifact两次TUI/resize/model fixture都先在旧或不完整路径得到可重复red，当前focused行为全部green。

### Verification Commands and Results

已执行并保存以下证据：

- OpenTUI fork source/full regressions、11次`npm pack`、`SHA256SUMS`、本地HTTP package verifier、fixed-source immutable release和12 asset attestation；public CI producer与macOS/Linux x64/Linux arm64/Windows x64 consumer matrix全绿。
- `bun install`从11个真实immutable release URLs生成integrity lock；closure输出`packages=11`、`solid=1.9.12`、gitlink/tag均为`cbe492a5...`，当前darwin arm64 native SHA为`5610edd4e283e3a0a9f666c03e5d907aa0ace7376f1a641e01cec72210cfd2f6`。
- `bun test test/script/upgrade-opentui.test.ts test/cli/cmd/tui/session-layout.test.ts test/cli/cmd/tui/dialog-prompt.test.tsx test/cli/cmd/tui/session-v2-error.test.tsx test/cli/cmd/tui/spinner.test.tsx test/cli/tui/slot-replace.test.tsx test/cli/tui/plugin-loader.test.ts`：`22 pass / 0 fail / 105 expect`。
- `bun typecheck`在`packages/opencode`、`plugin`、`app`、`ui`、`enterprise`、`desktop`、`console/app`、`console/core`、`sdk/js`和`slack`分别通过；root `bun typecheck` turbo运行14个可达typecheck task也全部通过。
- `bun run build`在`packages/app`、`enterprise`、`console/app`、`storybook`和`web`通过；`packages/desktop`仍在既有`build-node.ts`路径因缺少`opencode-sharp.gen.ts`失败，该文件和生成owner不属于本R12 OpenTUI diff。
- `bun run script/build.ts --single --skip-install --skip-embed-web-ui`通过并输出非空compiled `--version`；`bun run script/build.ts --skip-embed-web-ui`完成12个macOS/Linux/Windows target compile和各target native/executable evidence。
- `bun run script/smoke-opentui-artifact.ts --binary /Users/sunbenteng/Project/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode`通过：两次真实compiled TUI、公开Session/Goal HTTP、160x30 -> 150x28 -> 160x30、local model request、completion、daemon stop和cleanup均green，输出`sourceCount=2`、`renderedCount=2`、`modelRequests=1`。
- `bun test`在`packages/opencode`执行完整suite：`3773 pass / 13 skip / 3 fail / 1 error`；失败为现有file watcher timeout、临时reviewer 503及migration/fixture环境噪声，不位于本GOAL changed files，focused OpenTUI regression全部green。
- `.github/workflows/test.yml`已接入closure、focused regressions和Solid consumer typecheck硬门禁；`.github/workflows/build-opencode.yml`已接入closure及macOS arm64/x64、Linux x64/arm64、Windows x64解压archive artifact smoke，checksums/release依赖全部green job。
- 两份workflow均由`yaml` parser成功解析；`git diff --check`通过。

### Original Feedback-Loop Result

Historical official `0.3.4`: red，连续三次 source 2 / rendered 3。

Installed immutable `0.4.3-smark.1`: green，source 2 / rendered 2。

### Actual Secondary and Replacement Path Inventory

唯一成功路径保持为`v0.4.3 + #845 -> 11 immutable packages -> OpenCode URL overrides -> target native install -> Bun compile -> extracted executable smoke`。没有official npm fallback、submodule source build fallback、registry fallback、Goal caller clipping、手工换行、parallel renderer或catch-and-success。`thirdparty/opentui`只保存source/provenance；artifact smoke删除了调试期`/tui/select-session`路径，最终只使用第二次`<binary> <project> --session <id>`公开CLI路径。workflow中的macOS/Linux/Windows分支是同一release artifact contract的平台实现，不是竞争语义的替代成功路径。

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | `1118` upper bound | tracked added code/config/test lines`352` + untracked code/test/script lines`766`；已排除空行、import-only、generated `bun.lock`、README/plan、pure version metadata、删除旧patch和qualifying comment lines；未进一步扣除formatter-only行，因此是保守上界 |
| Qualifying Chinese comment lines `C` | `178` | tracked邻近修改点`52` + new files`126`；均解释ABI/identity、Goal geometry、factory/error seam、fixture readiness、PTY/ConPTY、cleanup、workflow gate或测试独立expected |
| Ratio `C / E` | `15.92%` | `178 / 1118` |
| Required minimum `C` | `168` | `ceil(1118 * 0.15)`；实际超过10行 |

### Remaining Unverified Items

- OpenCode最终commit按合同不得push，因此新增OpenCode workflow在本轮不能产生远端run；Linux/Windows最终OpenCode executable runtime仍明确为workflow-specified但未远端执行，不能用OpenTUI package matrix冒充。
- `packages/desktop`完整build被本GOAL之前已存在的`opencode-sharp.gen.ts`生成缺口阻断；desktop typecheck通过，OpenTUI依赖迁移本身没有新增该缺口。
- OpenCode完整`bun test`保留`3 fail / 1 error`的既有非OpenTUI环境失败；本GOAL focused tests、typecheck、closure、build和artifact smoke均green，不隐藏该结果。

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R12 | yes | No blocking findings. | 4项，原样记录如下 | APPROVE | `ses_08f614ea8ffe9v5R1O9udbMhKk` |

### R12 Implementation Audit Round 1 (verbatim classifications)

#### Blocking findings

No blocking findings.

#### Non-blocking findings

1. **Worktree contains unrelated dirty paths outside the audited scope.**  
   `packages/core/src/models-snapshot.js`, `sdks/vscode/.gitignore`, `docs/plans/vscode-extension-release-surface-reliability.md`, and session markdown files are present in the worktree but are not part of the stated OpenTUI implementation scope. They must remain excluded from any final OpenCode commit.

2. **Full package suite is not entirely green.**  
   The recorded full `packages/opencode` suite has `3773 pass / 13 skip / 3 fail / 1 error`, with the failures reported as pre-existing watcher/reviewer/migration fixture issues. The audited OpenTUI-focused tests, typecheck, closure verification, and artifact evidence are green. This does not block the OpenTUI diff because the failures are not in the affected behavior path, but they remain release-environment noise.

3. **Local YAML validation initially lacked PyYAML.**  
   Ruby YAML parsing was subsequently used successfully:
   - `.github/workflows/build-opencode.yml: valid`
   - `.github/workflows/test.yml: valid`

4. **The current worktree does not contain the generated `dist` executable or smoke artifact.**  
   The audit did not rerun the build because doing so would generate and modify build outputs in the shared worktree. The recorded implementation evidence and workflow structure were audited instead.

#### Rejected speculation

- **Submodule fallback risk:** rejected. `thirdparty/opentui` is only used for source provenance and gitlink validation. The dependency graph remains URL-based and does not fall back to submodule source.
- **Registry/native mixed graph risk:** rejected for the audited path. Root overrides enumerate all 11 OpenTUI release assets, and `bun.lock` contains the corresponding immutable URLs and integrity values.
- **Multiple Solid runtimes:** rejected for the verified installation. `verify-opentui-closure.ts` checks both realpath uniqueness and exact `solid-js@1.9.12`.
- **OpenTUI release workflow permission regression:** rejected for the current default-branch implementation. The audited `smark/main` workflow commit `e1b90732d4edc7c79965ac655df6b20753e67fc5` removes the invalid administration API precheck and adds the fixed-source dispatch path. The immutable tag remains pinned to `cbe492a538137842961d561c33f55fdb7587b40e`.
- **Diagnostic behavior exceeding the budget:** rejected. No new alternate success implementation or runtime renderer fallback was introduced.

#### Primary-path and fallback verdict

The implementation preserves one authoritative production path:

```text
OpenTUI 0.4.3 + #845
→ same-commit 11-package family
→ immutable GitHub Release
→ root URL overrides and lock integrity
→ target-specific native installation
→ Bun compilation
→ extracted archive PTY/ConPTY smoke
```

The audit found no official-package fallback, registry fallback, submodule-source build fallback, alternate renderer, caller-side CJK clipping/manual wrapping, catch-and-success, second parser, competing dependency source, or new runtime compatibility layer.

#### Code quality and Chinese-comment verdict

```text
E = 1118 upper-bound lines
C = 178
required = 168
ratio = 15.92%
```

The 15% hard gate passes.

#### Release verdict

**APPROVE**

This verdict applies only to the exact audited R12 implementation scope and actual associated commits/diff. The implementation has no evidence-backed blocking defect.

Invocation reference: `ses_08f614ea8ffe9v5R1O9udbMhKk`.
