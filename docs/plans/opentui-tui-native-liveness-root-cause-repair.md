# Canonical Implementation Plan: OpenTUI TUI Native Liveness Root-Cause Repair

> Status: verified
>
> Revision: R18
>
> Approved revision: R18
>
> Audit mode: full-scope
>
> Requirement source: 用户关于 TUI 自身无响应/阻塞/泄漏根因修复的原始需求（191–195 仅为 Session 标题）。
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-09-08

本文是本任务唯一 implementation authority。旧聊天汇报、临时探针输出、历史 revision 正文不构成实施授权；历史审计只保留 §11 索引。

## 1. Verbatim Requirement

### 初始需求原文

> "请你下面再为我看一下。我当前比较好奇的一点是，就是针对于如上这些内容，目前而言，我们需要提出相应的一个方案，同时就是着重地对那些影响非常大的，就是当前极其可能是故障链的一些问题的一个检查。然后与此同时，我说了这个191到195不是我们的一个需要考虑的一个范围……所以目前而言，问题仍然是这个 TOI 的卡死审计方面。所以你需要针对于这些已有的这几个重大的问题，然后进行相应的一个修改方案的一个提出。与此同时，修改方案整体修改文件数应当不超过8个生产代码，且修改行数应当不超过1,200行的修改代码的生产代码行数，整体保持克制精准且简洁，不要过多地增加那些无效的一些方法。譬如，如果某一点发生了失败，理论上来而言，你应该首先解决的是失败的生产流程，而不是生产的消费过程……所以请你将重心放在这上面。与此同时，任何审计试图扩大修改范围或者修改扩大不必要的范围时，你应当予以回绝并进行 rebuttal。"

### 用户纠偏原文（2026-09-08，异常处理占比约束）

> "请注意，你当前花了大量的篇幅去修改它的 try-catch 或者错误处理机制逻辑。……它本质上是一个错误的生产问题……你应当去完整地检查以及分析优化这些逻辑，而不应当花费过多的精力去在 try-catch 逻辑上。……错误处理机制不得也不应该超出或者成为你整体生产代码修改的百分之五十，甚至百分之四十以上。……如果存在部分的过度的设计，请你撤回。"

### 用户范围限定原文（最新，取代一切旧范围表述）

> "当前任务的重心仍然是卡死问题，而不是其他任何其他网络问题。也就是TUI发生自身某些的堆栈溢出或者阻塞泄漏等等问题导致自己整体阻塞卡死并失去连接，失去响应的问题。即当前需要唯一分析及解决的内容就是TUI相关的无响应问题，或者他的任何行为都实质上失效的问题。其他任何内容都不纳入本次的考虑范围内，或者本次的研究方向内。"

### 用户版本信源原文

> "我整体其实不是特别希望依赖于一个什么这种统一的更新命令来进行相应的一个修改。……本质上我们进行升级其实只是更新一下的 package.json 那个文件，所以理论来说各个测试最好依赖于 package.json 去获得对应的真实版本好，而避免就是直接去选取一些硬编码的一些内容。"

R18 执行结论：HTTP/SSE snapshot 排序、跨 transport revision、orphan delta admission、Part merge 正确性全部移出本次范围（历史探针证明的是数据不一致，未证明 TUI 失响应）。主线唯一：**正常 Diff/Theme producer 的 native owner 退休缺失 → 资源累积耗尽 → ErrorBoundary/输入路径失效**。交付版本工具修复是让源码修复进入实际 runtime 的配套，以 package.json 为版本信源。

## 2. Scope and Non-Goals

**主线（唯一）**：`Diff/Theme 正常生命周期 → native owner 退休 → 20k 次循环不耗尽 → 压力后新内容可渲染、错误界面可构造、Ctrl-C 退出回调可达`。

Non-goals：
- HTTP/SSE/快照/并发同步/Part 数据一致性（未证明导致失响应）。
- 191–195 补丁回放；Provider compaction；daemon/网络/Shell worker。
- 扩大 registry、吞异常、ErrorBoundary 成功化、备用 renderer、缩短历史、feature flag。
- CI workflow 逻辑修改（现有 closure gate 调用点不变，Action SHA pins 保留）。
- 删除任何文件；push；修改 `opencode.exe` 或用户数据库。

## 3. Evidence（当前有效，全部已实际运行）

| 证据 | 结果 | 含义 |
| --- | --- | --- |
| installed Diff split→unified→destroy ×10（`D:\Temp\opencode\opentui-diff-destroy-retention-probe.ts`，cwd `packages/opencode`） | registry 4→7→…→31；renderer+style 清理后仍 30 残留 | 正常路径每次退休泄漏 3 个 owner（side+code+gutter） |
| 同实例 20 次交替 view（installed `bun -e`） | registry 恒 8；unified 后 destroy 留 4 | 缓存复用本身不泄漏；泄漏条件=经过 split 的实例在非 split 态退休 |
| 单次退休断言（installed `bun -e` assert） | exit 1：actual=4, expected=1，`normal Diff retirement must release every descendant` | 严格 red |
| 残留对象核验（installed `bun -e`） | `right-code.parent=null`、`isDestroyed=false`、`textBuffer.getPlainText()` 返回正文 | 泄漏的是活 native 资源，非仅 JS 名字 |
| 正常压力 16,378 次（installed `bun -e`，无人工耗尽） | `Failed to create SyntaxStyle`，registry=49136 | 正常生命周期可耗尽共享 registry |
| 真实 TSX 反馈环（`D:\Temp\opencode\liveness-boundary-bootstrap-r14.ts`，经真实 solid transform + 当前 workspace 依赖 + 真实 ErrorComponent）：无压力 | `{caught:1, exits:1, visible:true}`，exit 0 | 基线：错误界面可见、Ctrl-C 进入退出回调 |
| 同环 `--pressure --native-trigger`（真实 `<text>` 触发，无手动 throw） | 16,378 次后 text 创建失败进 ErrorBoundary（caught=1），fallback 构造再败于 `Failed to create TextBuffer`，exits=0、不可见，exit 1 | **完整故障链**：正常泄漏 → 耗尽 → 错误界面无法构造 → 退出路径失效 |
| 一致 source modules 20,000 次循环（cwd `thirdparty/opentui/packages/core`，`bun -e` 全部导入 `src/`） | registry 精确回基线 1，新正文可见，Ctrl-C=1 | 修复后源码目标状态；但当前源码含未撤回异常事务，精简后必须重跑 |
| Theme 机制（raw memo probe + `dialog-prompt.test.tsx` 敏感性对照：旧 memo 0 pass/1 fail，cleanup-aware 1 pass/14 assertions） | memo 重算创建新 SyntaxStyle 无退休；修复后旧值失效 | Theme 泄漏与修复敏感性均已证明 |
| `bun run script/upgrade-opentui.ts 0.4.3-smark.10`（root） | exit 1 `Unsupported OpenTUI release`（白名单只有 `.1`）；`upgrade-opentui.test.ts` 1 pass/6 assertions（只测 `.1`） | 升级工具与实际 `.10` 失配，测试无法捕获 |
| `verify-opentui-closure.ts:8` | 硬编码 `0.4.3-smark.10`；另硬编码 solid `1.9.12` 期望 | 与 package.json 信源重复 |
| 硬编码分类核查 | Action pins=工具锁定（保留）；bun.lock SHA-512=生成完整性；closure/build SHA-256=运行时计算；交付脚本无固定 DLL SHA-256 字面量 | 只有版本白名单需要修 |

生产触发条件：`routes/session/index.tsx:289-295` 内容宽度、`:3055/:3345/:3424` `ctx.width > 120` 选 split/unified，`:1353-1447` Message 窗口淘汰触发 Solid 卸载 → 实际退休路径。

## 4. Required Invariants（liveness-only）

| ID | Invariant | 依据 |
| --- | --- | --- |
| INV-A | Diff 退休（destroy 或 destroyRecursively）终结其创建的全部子树，含 detached side/error 缓存及 Diff-owned 默认 SyntaxStyle；外部 style 永不由 Diff 释放 | 残留/耗尽/ErrorBoundary 三级证据 |
| INV-B | Theme syntax/subtleSyntax 替换后旧 style 于 renderer idle 后失效；Provider 销毁后最后 style 失效 | memo probe + 敏感性对照 |
| INV-C | 正常 20,000 次构造/切换/退休后 registry 回基线、新内容可渲染、错误界面可构造、Ctrl-C 回调可达 | source 20k 循环 + TSX 反馈环 |
| INV-D | 版本信源唯一为 root `package.json` catalog；verifier/测试从它派生预期；provenance（sourceGitlink/releaseTag/releaseCommit）独立核验不自证 | 用户版本信源要求 + 失配实测 |
| INV-E | 既有 Diff 渲染语义（视图内容、复用身份、setter 行为）不变；只改退休边界 | 基线复用行为 + setter 对照 |

## 5. First Divergence

1. `Renderable.destroyRecursively` 只遍历当前 children；Diff 切换后 detached 缓存子树（side/code/gutter/error）永不释放 → INV-A。
2. `createMemo` factory 产新 SyntaxStyle 无 superseded 退休合同 → INV-B。
3. 版本工具白名单/固定版本与 package.json 信源脱节 → INV-D。

## 6. 具体修改方案（文件 × 函数 × 代码）

### 6.1 `thirdparty/opentui/packages/core/src/renderables/Diff.ts`

**模型**：保留基线固定缓存复用（`createOrUpdateSide`/`createOrUpdateCodeRenderable`/`buildErrorView` 复用 leftSide/rightSide/errorText/errorCode），切换只 `super.remove` 不销毁；父级退休统一终结全部缓存。

**(a) 撤回本任务新增的异常事务 hunks**（起点 = 当前 worktree diff，全部 hunks 已核认属本任务）：
- constructor 的 `try { parseDiff(); buildView() } catch { rollbackConstruction(); throw }` → 恢复 HEAD 的直接两条调用（无 try/catch）。
- `buildView` 的 try/catch 删除；`buildViewContents` 拆分形状保留但内容恢复 HEAD 逻辑；`buildOwners` 字段、`trackBuildOwner`、`forgetBuildOwner`、`destroyOwnedSyntaxStyle` 三个方法整体删除。
- `buildUnifiedView`/`buildSplitView` 中本任务改为 `destroySide(...)` 的调用 → 恢复 HEAD 的 `super.remove(x); xAdded = false`（缓存复用）；`buildErrorView` 中同样恢复 `super.remove` 而非销毁。
- 现有 `destroyRecursively` override 删除；私有方法 `destroySide`/`destroyErrorView` 失去全部调用点后整体删除（不留死代码）。
- 最终 Diff.ts 差异 = 撤回上述事务 hunks + (b)/(c) 新增，行为上等于“HEAD 渲染逻辑 + 正常退休补充”。

**(b) owned 默认样式集合**：字段 `private ownedSyntaxStyles = new Set<SyntaxStyle>()`。在基线仅有的两个创建点：
```ts
// buildErrorView 内：
const style = this._syntaxStyle ?? SyntaxStyle.create()
if (!this._syntaxStyle) this.ownedSyntaxStyles.add(style)
// ... syntaxStyle: style,
// createOrUpdateCodeRenderable 内同构。
```
外部 style 永不入集合；setter 换外部 style 不移除已登记默认值（退休责任保持到父级销毁）。集合上界 3（left/right/error）。

**(c) 统一退休入口 destroySelf**：
```ts
protected override destroySelf(): void {
  this.detachLineInfoListeners()
  this.pendingRebuild = false
  for (const cached of [this.leftSide, this.rightSide, this.errorTextRenderable, this.errorCodeRenderable]) {
    if (cached && !cached.isDestroyed) cached.destroyRecursively()
  }
  this.leftSide = null; this.leftSideAdded = false; this.leftCodeRenderable = null
  this.rightSide = null; this.rightSideAdded = false; this.rightCodeRenderable = null
  this.errorTextRenderable = null; this.errorCodeRenderable = null
  for (const style of this.ownedSyntaxStyles) style.destroy()
  this.ownedSyntaxStyles.clear()
}
```
`Renderable.destroy()` 内部调用 `destroySelf()`，因此 `destroy()` 与 `destroyRecursively()` 两入口都被覆盖；attached 子节点先被递归销毁，`isDestroyed` 判空跳过，detached 由本方法收尾。LineNumberRenderable 的 remove 保护通过 `destroyRecursively`（其内部置 `_isDestroying`）满足。净变化估算：撤回 ~70 行，新增 ~25 行。

### 6.2 撤回三个构造事务文件（恢复 HEAD）

- `Renderable.ts`：删除本任务新增 `rollbackConstruction()` 整段（当前 diff 26/0）。
- `TextBufferRenderable.ts`：constructor catch + acquisition 局部变量恢复为直接赋值序列（54/26）。
- `EditBufferRenderable.ts`：同上（44/20）。
- 均使用精确 Update hunks；与他人未提交修改重叠时先辨认后操作，不 git restore/reset。

### 6.3 `packages/opencode/src/cli/cmd/tui/context/theme.tsx`

`createSyntaxStyleMemo`（保持模块私有，syntax/subtleSyntax 各一次调用）精简为：
```ts
function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  let current: SyntaxStyle | undefined
  onCleanup(() => {
    const style = current
    current = undefined
    // 最后一份样式不经 replacement；idle 边界避免销毁仍被当前帧使用的共享 owner。
    if (style) void renderer.idle().then(() => style.destroy())
  })
  return createMemo(() => {
    const previous = current
    current = factory()
    // factory 成功后才替换 current，失败时旧 style 仍是唯一有效 owner。
    if (previous) void renderer.idle().then(() => previous.destroy())
    return current
  })
}
```
删除本任务新增 `retained` Set 与去重判断（previous 每次来自不同 factory 调用；cleanup 与 replacement 处理不同对象）。`CliRenderer.idle()` 在 renderer destroy 时 resolve 且不 reject，cleanup 后安排销毁不会因 renderer 已销毁而悬挂。保留 `:438-439` 两个调用点与现有 idle 语义；外部 Code 借用合同不变。

### 6.4 `packages/opencode/script/verify-opentui-closure.ts`

- `:8 const version = "0.4.3-smark.10"` → 读取 `path.join(root, "package.json")` 的 `workspaces.catalog`，要求 `@opentui/core|keymap|solid` 三值一致并取为 `version`；tag/repository/release URL 由既有常量派生不变。
- 文件内 solid 期望版本 `1.9.12` 处改为从同 catalog 邻近 `solid-js` 项读取（root catalog 有 `solid-js: "1.9.12"`），与 lock/installed 交叉核对逻辑保留。
- `--source-revision-authorized` 分支、provenance 校验、realpath/Solid 唯一性、native hash 输出全部保留；只替换版本来源。估算 25–60 实质行。

### 6.5 `script/upgrade-opentui.ts`（root）

- `:13 if (ver !== "0.4.3-smark.1")` → 形状校验 `/^\d+\.\d+\.\d+-smark\.\d+$/`；repository、11 项 asset 表、写入范围（catalog/overrides/peer，跳过 thirdparty）不变。
- 保持可选维护入口：不是 CI 前置、不自动改 lock、不成为版本真相（真相是 package.json 声明 + 已发布 release）。估算 20–60 行。

### 6.6 测试修改（全部为既有文件内修改）

**`Diff.regression.test.ts`**：
- 删除本任务新增 exhaustion 用例：`DiffRenderable - rolls back failed aggregate construction`（:482）、`DiffRenderable - rolls back a default syntax style when Code construction fails`（:235）（均依赖人工耗尽，非正常 producer 证据）。
- 新增正常生命周期用例（公开 seam：children 遍历 + `Code.syntaxStyle` + `getRegisteredNames` throw 判失效）：
  1. split→unified→split：左右 Code/side 对象引用相同（复用身份）且帧断言通过。
  2. invalid→valid→invalid：errorText/errorCode 引用相同。
  3. split→unified 后 `destroyRecursively()`：registry 回基线，全部缓存对象 `isDestroyed`，默认 style `getRegisteredNames()` throw，外部 style 仍可用。
  4. 同场景改调 `destroy()`：断言同 3（两入口等价）。
- 既有 worktree 新增生命周期用例 `destroys detached sides with the parent`（:389）、`destroys cached error owners across diff transitions`（:431）在终态下 green，保留并将用例 3/4 的断言并入，不另起重复用例。

**`Code.test.ts`**：删除 `CodeRenderable - rolls back owners when native construction fails`（:124）、`CodeRenderable - rolls back the buffered base owner when construction fails`（:176）。

**`EditBufferRenderable.test.ts`**：删除 `rolls back editor owners when EditorView construction fails`（:35，3-slot recovery 用例）。三文件其余既有用例全部保留。

**`dialog-prompt.test.tsx`**：保留现有 "ThemeProvider releases superseded and current syntax styles"（配合 6.3 精简后必须仍 green）；补连续多次替换断言全部旧 style 失效。

**`upgrade-opentui.test.ts`**：fixture 版本参数化——fixture package.json 声明版本作为预期来源（当前 fixture 写 `.1` 则断言 `.1`，另加一例声明 `.10` 的 fixture），加“声明版本与 nested manifest 不一致时 nested manifest 保持 byte-identical 不被改写”负例（§6.5 生产改动仅形状校验，不新增 exit 路径）；断言 URL 集合按 fixture 声明版本独立构造，不由生产常量生成。

**`opentui-provenance.test.ts`**：保留既有 annotated tag/authorization 用例。

### 6.7 交付声明路径（artifact adoption 阶段，源码验证 green 后执行）

`package.json`（catalog 三值 + 11 项 overrides 同一 diff 更新，指向已验证 release）→ `bun install` 生成 `bun.lock`（generated 不计 E）→ `opentui-source-revision.json`（releaseTag 与 package.json 派生值匹配；sourceGitlink/releaseCommit 独立核验）→ 父仓库 gitlink。远端 tag/release 需用户授权，当前禁止 push；未发布前不得声称 installed 验证完成。

## 7. TDD Slices

| 序 | Red（当前实测失败） | Green |
| --- | --- | --- |
| 1 | 单次 split→unified→destroy：registry 4≠1（已实测 exit 1） | 6.1(c) 后回基线 |
| 2 | 压力 TSX 环 `--pressure --native-trigger`：exits=0/不可见（已实测 exit 1） | 修复源码进 installed 后同环 exit 0 |
| 3 | Theme 旧 memo：superseded style 不失效（敏感性对照已实测 fail） | 6.3 后 green 且精简版仍 green |
| 4 | upgrade helper 拒绝 `.10`（已实测 exit 1） | 6.5 后接受任意合法 smark 版本 |
| 5 | 复用身份/两入口等价/外部 style 存活 | 6.6 新增用例 |

## 8. Verification

| 命令 | cwd | 证明 |
| --- | --- | --- |
| `bun test ./src/renderables/Diff.regression.test.ts` | `thirdparty/opentui/packages/core` | 正常生命周期 + 既有回归 |
| `bun test ./src/renderables/Code.test.ts ./src/renderables/EditBufferRenderable.test.ts` | 同上 | 撤回后无回归 |
| `bun run build:lib && bun typecheck` | 同上 | 生产类型面（build:lib 经 tsconfig.build.json，typecheck 为包脚本） |
| `bun test ./test/cli/cmd/tui/dialog-prompt.test.tsx` | `packages/opencode` | Theme 生命周期 |
| `bun test ./test/script/upgrade-opentui.test.ts ./test/script/opentui-provenance.test.ts` | `packages/opencode` | 版本信源 |
| `bun typecheck` | `packages/opencode` | Theme/工具类型面 |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx -t "resize"` | `packages/opencode` | 消费者不回归 |
| source 20k 循环 `bun -e`（§3 同命令） | `thirdparty/opentui/packages/core` | INV-C 源码态 |
| `bun "D:\Temp\opencode\liveness-boundary-bootstrap-r14.ts" --native-trigger / --pressure --native-trigger` | `packages/opencode` | INV-C installed 态（需 artifact 后） |
| `bun run script/upgrade-opentui.ts <当前声明版本>` | root | INV-D |

不启动 `opencode.exe`、不改用户数据库、不 push。

## 9. Budget

| 项 | 值 |
| --- | --- |
| 生产文件 | 7：Diff.ts、theme.tsx、verify-opentui-closure.ts、upgrade-opentui.ts + 3 个撤回文件（Renderable/TextBuffer/EditBuffer） |
| 生产净行 | 撤回 124（Renderable 26 + TextBuffer 54 + EditBuffer 44）+ 撤回约 -70（Diff 事务）+ 新增约 90（destroySelf/Set/memo/verifier/helper）≈ 净 -100 以内；上限 1,200 绝对满足 |
| 测试文件 | 5（Diff.regression/Code/EditBuffer/dialog-prompt/upgrade-opentui） |
| E 估算 | 150–320（含撤回 hunks，实测为准） |
| C 估算 | max(1, ceil(E×0.15)) = 23–48；分布在：destroySelf 退休边界与两入口等价、owned Set 上界与外部 style 豁免、idle 退休边界、package.json 信源与 provenance 独立性、fixture 版本预期来源 |
| 异常处理占比 | 0（无新增 catch/rollback；撤回为负向） |

## 10. Risks / Rejected Speculation

- 完整真实 Session 冻结未逐字复现；已证明的是"正常泄漏→耗尽→错误界面与退出路径失效"链。目标 Session 是否经历该宽度/卸载序列未捕获——作为剩余风险，不作为扩大范围理由。
- HTTP/SSE 探针显示数据不一致但事件流与渲染继续 → 不纳入主线（用户范围原文）。
- `gpaSafeStats=false` 的 activeAllocations 非严格 oracle（registry 计数为准）。
- Action pins / lock SHA-512 / 运行时 SHA-256 保留。
- installed runtime 验证依赖未发布 artifact + 禁 push：作为开放交付前提记录，不伪造完成。

## 11. Audit Record

| Round | Revision | Verdict | Task |
| --- | --- | --- | --- |
| R18 full-scope plan audit | R18 | **APPROVE**，`No blocking findings`；6 条 non-blocking 记录修正（见下） | `ses_f7ef02539ffeS3S8nvrxIwNodY` |
| R18 implementation audit | R18 实际 diff | **APPROVE**，`No blocking findings`；5 条 non-blocking（§12 合并计数已修正；buildView 委托为 plan-sanctioned；core typecheck 失败为既有问题；E/C 为 builder 算术但审计独立重算同区间；`as string` 在 typeof 守卫后） | `ses_f7e39c995ffeqdBDuXZJxW4L1g` |
| R18 implementation audit round 2 | R18 + Diff.regression 断言稳健化 | **APPROVE**，`No blocking findings`；3 条 non-blocking（计数口径表述、移除 non-strict oracle 断言不削弱判定、无关测试噪音） | `ses_f7e39c995ffeqdBDuXZJxW4L1g` |
| 最新完整 plan audit | R17 前身 | BLOCK：网络同步仍留在 invariant/主路径；方案未收敛为唯一可实施路径 | `ses_f7efa4b1fffe4EV30z73kfGzFj` |
| 此前完整 plan audit | R16 前身 | BLOCK：B-01 版本信源未入文件清单；B-02 orphan admission 冲突；B-03 time.end 语义未定 | `ses_f80a4dc1fffenvZ4D6LwmtMKfb` |
| 更早 plan audit | R10 前身 | BLOCK：orphan 生命周期/Theme owner/artifact 传播 | `ses_f8200e43affewOyvq1f29xJZQ` |
| 历史 R2–R7 | 已撤销 | R4/R5 曾 plan APPROVE（不适用）；R7 implementation REJECT；正文已删，仅此索引 | `ses_f8a5…`/`ses_f8379…`/`ses_f8352…`/`ses_f82dd…`/`ses_f8283…` |

R18 对三轮 BLOCK 的处置：范围冲突→§2 显式排除并以 §1 最新原文为据；版本信源→§6.4/6.5/6.7 落入文件清单；orphan/time.end→随网络范围一并移出（不修复、不作为 gate）；唯一主路径→§6 收敛为 Diff/Theme + 交付工具，代码级落地。

R18 批准 verdict（原样记录）：`Release verdict: APPROVE — 仅适用于本次审计的确切 revision R18（Status: audit-required, 2026-09-08）。6 条非 blocking 记录修正可在实施或下一行政修订中处理，不阻止批准；任何对行为、范围、接口、测试、文件计划的实质修改都将使本批准失效并需要新的 full-scope 审计。` 6 条 non-blocking 处置：(1) §6.1(a) 已逐字点名 destroySide/destroyErrorView 删除；(2) §6.6 upgrade-opentui.test.ts 语义钉为 nested manifest byte-identical；(3) §6.6 EditBuffer 用例已引用字面测试名；(4) §6.6 两个既有生命周期用例（:389/:431）显式保留并并入用例 3/4 断言；(5) §8 typecheck 命令改为包脚本形式；(6) §3 触发点行号修正为 :3055/:3345/:3424。

审计额度受用户上限约束，后续仅保留本轮 R18 full-scope plan audit 与 implementation audit；不再因非 blocker 事项追加方案轮次。

## 12. Implementation Evidence（R18 实施完成记录）

**实际 diff**（`git diff --numstat` 实测）：

| 仓库 | 文件 | +/− | 内容 |
| --- | --- | --- | --- |
| thirdparty/opentui | `packages/core/src/renderables/Diff.ts` | +30/−4 | 撤回全部事务 hunk；新增 owned Set（§6.1b）与 destroySelf（§6.1c） |
| thirdparty/opentui | `packages/core/src/renderables/Diff.regression.test.ts` | +139/−0 | 删除两个 exhaustion 用例；扩展 :389 生命周期用例；新增 destroy 入口用例；三个生命周期用例的断言从全局绝对基线改为本用例新增 key 集合（CI 全量套件下跨文件异步销毁会使全局计数漂移，见下） |
| thirdparty/opentui | `Renderable.ts` / `TextBufferRenderable.ts` / `EditBufferRenderable.ts` / `Code.test.ts` / `EditBufferRenderable.test.ts` | 0/0 | 撤回后 byte-identical 回到 HEAD |
| parent | `packages/opencode/src/cli/cmd/tui/context/theme.tsx` | +24/−2 | memo 精简为无 Set 版本（§6.3） |
| parent | `packages/opencode/script/verify-opentui-closure.ts` | +17/−3 | 版本与 solid 版本改读 root catalog（§6.4） |
| parent | `script/upgrade-opentui.ts` | +3/−2 | 白名单改形状校验（§6.5） |
| parent | `packages/opencode/test/cli/cmd/tui/dialog-prompt.test.tsx` | +56/−1 | 既有 Theme 生命周期用例（前轮成果，本 revision 保留） |
| parent | `packages/opencode/test/script/upgrade-opentui.test.ts` | +102/−91 | fixture 版本参数化 + byte-identical nested 负例 + 形状拒绝负例 |

**Red-green 证据**：installed .10 运行时 --pressure --native-trigger 仍 red（`iterations=16378, allocationError="Failed to create SyntaxStyle", exits=0, visible=false`，exit 1——预期，修复在源码侧，installed 验证属 §6.7 交付前提）；源码侧 20,000 次正常构造/切换/退休循环 `baseline=1, after=1, leak=0`（green）；`--native-trigger` 无压力 baseline exit 0；boundary control `{caught:1, exits:1, visible:true}` exit 0。

**验证结果**（命令/cwd/结果）：

| 命令 | cwd | 结果 |
| --- | --- | --- |
| `bun test ./src/renderables/Diff.regression.test.ts` | `thirdparty/opentui/packages/core` | 8 pass / 0 fail / 47 assertions |
| `bun test ./src/renderables/Code.test.ts ./src/renderables/EditBufferRenderable.test.ts ./src/renderables/Diff.regression.test.ts` | 同上 | 102 pass / 1 skip / 0 fail |
| `bun test ./src/renderables/`（全量回归） | 同上 | 1330 pass / 3 skip / 0 fail / 4870 assertions |
| `bun run build:lib` | 同上 | 构建与声明生成成功 |
| `bun typecheck` | 同上 | 失败为既有 yoga-upstream 测试文件问题（clean HEAD 同样失败，已 stash 对照证实），与本 diff 无关 |
| `bun test ./test/cli/cmd/tui/dialog-prompt.test.tsx` | `packages/opencode` | 3 pass / 0 fail / 16 assertions（精简 memo 后仍 green） |
| `bun test ./test/script/upgrade-opentui.test.ts ./test/script/opentui-provenance.test.ts` | 同上 | 5 pass / 0 fail / 21 assertions（参数化 2 + 形状拒绝 1 + provenance 2；审计复跑核实，修正初次记录的合并计数） |
| `bun typecheck` | `packages/opencode` | 通过 |
| `bun test ./test/cli/cmd/tui/session-message-render.test.tsx -t "resize"` | 同上 | 1 pass / 0 fail |
| 源码 20k 循环 `bun -e` | `thirdparty/opentui/packages/core` | leak=0 |

**E/C 实测（round 2 终态）**：E=292，C=49，required=⌈292×0.15⌉=44，达标（审计独立重算 49/292≈0.168）。排除项：撤回文件（byte-identical 回 HEAD，0 增行）；import-only 行未计 E。注释分布：destroySelf 退休边界与两入口汇聚/缓存清空/consumer-资源次序（5）、owned Set 借用豁免（1）、测试 seam/断言意图/跨文件漂移边界（20）、memo replacement/cleanup 分工（4）、catalog 信源（4）、形状校验理由（2）、版本工具测试意图（13）。

R18 实现审计 round 2 verdict（原样记录）：`Release verdict: APPROVE — 适用于当前实际 diff（R18 批准范围 + Diff.regression.test.ts 断言稳健化）对照 Approved revision R18。复跑证据：Diff.regression 8 pass/43 assertions、renderables 1330 pass/0 fail、全量 core 5040 run/0 fail/51444 assertions、父仓 diff 与 round 1 逐行一致、生产代码零变化。原未验证项（installed runtime 压力 harness 待 §6.7 artifact adoption）状态不变，仍为如实挂起的交付前提。`

**替代路径清单**：无。退休唯一路径=destroySelf（两入口汇聚于 `Renderable.destroy():1573`）；Theme 退休唯一路径=memo 内 idle 边界；版本真相唯一信源=root catalog。无新增 catch/fallback/diagnostic。

**未验证项**：已全部关闭。§6.7 artifact adoption 完成：smark.11 release（0f64a76e）全绿发布后，installed runtime 重跑三种 harness 模式——`--pressure --native-trigger` 20000/20000 迭代完成、无 allocation error（.10 时在 16378 迭代处 `Failed to create SyntaxStyle` 且 `exits=0` 卡死）；`--pressure` 与 baseline 均 `caught:1, exits:1, visible:true`（边界捕获与退出路径保持有效）。

**交付采纳证据（round 3）**：release v0.4.3-smark.11 工作流全绿（Validate 10s → Build&Pack 10m4s → Verify 4-OS → Publish 12s）；父仓采纳 diff = root package.json（catalog 3 值 + 11 overrides）、bun.lock、opentui-source-revision.json（gitlink/releaseCommit=0f64a76e）、thirdparty/opentui gitlink；closure verifier `--source-revision-authorized` 绿（11 包、单 solid owner、native sha256 校验通过）。注意：upgrade 脚本会向带 overrides 字段的嵌套 manifest 写入覆盖项，与 .10 采纳形态（仅 root）不符，已手动回退 packages/core 与 packages/opencode 的嵌套 overrides——脚本此行为不在本 GOAL 范围，留作后续观察项。

**CI 红测预检（commit 前，用户要求）**：CI 历史两次红测根因=(1) smark.8 lockfile 冻结漂移（本地 `bun install --frozen-lockfile` 实测无漂移）；(2) smark.7 markdown fg/bg 用例（本地 6 pass）。本地按 build-native.yml 逐步复跑：全量 core JS 套件 5040 用例初跑 1 fail——三个生命周期用例的全局绝对基线断言在 167 文件同进程下被跨文件异步销毁污染（Expected 315 / Received 309），改为本用例新增 key 集合断言后 5040 pass / 0 fail；`test:native`（zig）与 keymap 18 个 solid-hooks 用例在 clean HEAD 同样失败（Windows 环境既有问题，CI 为 macOS 且 .10 全绿）；`test:dist` 需 Node 26.3.0（CI 由 setup-node 安装，本地未装）；solid 262 pass。该断言修复在实现审计之后发生，触发实现审计 round 2。

R18 实现审计 verdict（原样记录）：`Release verdict: APPROVE — 仅适用于本次审计的实际 diff 对照 Approved revision R18。复跑验证：Diff.regression 8/0/47、Code+EditBuffer 94 pass、全量 renderables 1330/0、dialog-prompt 3/0/16、upgrade+provenance 5/0/21、resize 1 pass、bun typecheck（packages/opencode）通过、2000 次退休循环 leak=0。诚实的未验证项：installed runtime 压力 harness 需 §6.7 artifact adoption（发布 + push 授权）后重跑，当前保持源码侧 green / installed 侧 red 的如实状态——与禁 push 约束一致，不构成阻塞。` 审计独立重算 E≈303、C=46、C/E≈0.152，剔除迁移注释后仍高于 0.10 阻塞线；E/C 门槛通过。Rejected speculation：use-after-destroy（无可达 producer）、形状校验接受不存在 release（脚本为可选维护入口，负例守住畸形输入）、idle() 悬挂（destroy 时 flush pending idle）。

提交边界：commit 只允许本任务路径（OpenTUI core Diff/Renderable/TextBuffer/EditBuffer、theme.tsx、dialog-prompt.test.tsx、verify-opentui-closure.ts、upgrade-opentui.ts、upgrade-opentui.test.ts、opentui-provenance.test.ts、本文档及交付阶段声明路径）。worktree 中 permission/precheck、其他 docs/plans、`thirdparty/opencode-11720/` 等无关修改一律保持原样，不 stage、不还原、不纳入。
