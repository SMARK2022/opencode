# Canonical Implementation Plan: OpenTUI 收尾时继续填入末表

> Status: verified
>
> Revision: R5
>
> Approved revision: R5
>
> Audit mode: full-scope
>
> Requirement source: 本次会话的两张截图、用户对性能的提问和范围确认（§1）
>
> Implementation allowed: complete; no further material changes without revision or rework
>
> Last updated: 2026-11-22

固定基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。这是本任务唯一实施规格。此基线的目标路径没有待保留的未提交实施改动。

## 1. Verbatim Requirement

> 这一个表格，它中间可能由于一些Markdown，它导致它解析成一个片段的东西了。
>
> 表格是什么问题导致的。如果要修改，准备怎么修改。它会撤回，或者说使得部分我们已有的一些性能收益下降吗？按照我的理解，我们之前的逻辑难道本身它不就是说，在表格未闭合的时候仍然保持整个表格的这种更新吗？那为什么还会出现这种问题？清晰准确解释，不要使用一些过度复杂的一些逻辑，或者说术语，或者过度凝练的东西。

用户确认范围：“修复 OpenTUI 断表、保留流式性能，按方案和实现两轮审计后只提交本任务文件？” 答：“实施并提交”。确认的测试入口是已安装的 `MarkdownRenderable`，交付形式为现有 OpenCode 仓内补丁。

发布要求：“实在不行的话，你可以先push我们的Open TUI的部分，但是当前可能需要先进行Rebase一下。” 独立修复的归属按用户原话：“如果和前两个目标的 commit 的一些，比如它不是它引入了，或者说不是它，而且不是由前面所相关的，那你可以引入第三个 commit。” 在 `57a50ae146` 上重放的是 `0e34596926`，结果为 `82063d8b24`，仅这两个提交的 `range-diff` 为 `=`。与 R2 审过的 `5e820f7acb` 相比，还带有 §15–17 所列的三处高亮夹具调整。帧和开页滚动收尾另行提交；本次 OpenTUI 推送不包含 compaction。

## 2. Explicit Non-Goals

不升级 OpenTUI、不发 fork，不改流事件/存储顺序、消息正文、列宽算法、高亮 worker、原生库或 harness。直接渲染完整消息以及正常流式窗沿用现有路径。

## 3–4. Repository Context / Files and Evidence

| 文件/证据 | 对设计的约束 | 类别 |
| --- | --- | --- |
| 根、`packages/opencode`、`packages/opencode/test` 的 `AGENTS.md`，`CONTEXT.md`，`docs/adr/README.md` | 包目录运行测试和类型检查；持久化会话与客户端显示分工。ADR 无表格特例 | contracted |
| `package.json` 的 catalog、overrides、patchedDependencies；`bun.lock`；`patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 入口是 fork 发布包的 `index.js`，仓内已有 core 补丁，不向 submodule 重复交付 | observed |
| `packages/tui/src/routes/session/index.tsx` 的 `TextPart`、`context/sdk.tsx` 的 `flush`、`context/sync.tsx` | 正文 trim 后交给一个 markdown，完成态与正文可同一批应用，二者独立 setter | reachable |
| `thirdparty/opentui/packages/core/src/renderables/{Markdown.ts,markdown-parser.ts}`、安装包 `index.js` 的 `parseMarkdownIncremental` | 同一个增量解析器；完成态沿用全部匹配块；表格渲染器另有不变单元格缓存 | observed |
| `thirdparty/opentui/packages/core/src/renderables/__tests__/Markdown.test.ts`、`packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | 前者测完整行切完成/流中更改；后者是本仓已安装包回归入口 | observed |
| `packages/opencode/src/cli/cmd/run/scrollback.{surface.ts,writer.tsx}`、`test/cli/run/scrollback.surface.test.ts` | CLI 也用同一组件；surface 先写内容后设完成，按稳定块提交。无需改其调用约定 | reachable |
| 两张截图及当时只读原文；§8 安装包重现 | 一处断在第二列，一处在第三列；正文里均无段落分隔 | observed |

## 5–7. Current Behavior / Supported Domain / Invariants

`TextPart -> MarkdownRenderable.streaming / content -> updateBlocks -> parseMarkdownIncremental -> TextTableRenderable`。正常流式将末两块留待更新；结束通知本身合法，正文 setter 也允许在完成态更新。加粗、链接可出现在任何列，不判断内容标点或 Markdown 是否“闭合”。

| ID | 可达条件及上游保证 | 验收行为及证据 |
| --- | --- | --- |
| INV-1 | 已识别末表；先关闭流式，再在原文后追加同一单元格的后半句、列或行。两次 setter 都接受合法值 | 重新加载与追加后的单元格一致，尾文和列分隔符留在表格结构中。两张截图及公开接口复现 |
| INV-2 | 通常的流式追加；无新字的结束通知；有稳定前文的末表 | 普通流式词法扫描量不增长；末表独立可解析时保留前文复用，表格与未变单元格缓存继续使用。现有 OpenTUI 用例及 §18 隔离测量；不承诺任意尺寸的耗时 |

## 8–9. First Divergence / Responsibility

起因在 `markdown-parser.ts:35–54`：表格 token 的旧 `raw` 是新正文的前缀，并不能证明新正文在该处也有一个块边界。完成态的 `trailingUnstable=0` 使计算出的复用边界正好落在半行后；只对余下字符串做词法解析就得到了独立段落。列宽和绘制只消费这个错误结构。应用层交换 setter 顺序只能处理同批属性变化；独立到达的合法追加仍会走错。归属为 OpenTUI 复用边界。

基线 red 命令：在 `packages/opencode` 运行以下 `bun -e` 脚本；两次 setter 间无需 sleep。实际返回 1，第三列 `No.`，子块为 `TextTableRenderable, CodeRenderable`。

```js
import { MarkdownRenderable, SyntaxStyle, TextTableRenderable } from '@opentui/core';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';
const { renderer } = await createTestRenderer({ width: 110, height: 12, useThread: false });
const style = SyntaxStyle.create(), client = new MockTreeSitterClient();
const head = '| Version | Change | Verdict |\n|---|---|---|\n| A | correct | yes |\n| B | links | **No.**';
const md = new MarkdownRenderable(renderer, {content: head, streaming: true, internalBlockMode: 'top-level', syntaxStyle: style, treeSitterClient: client});
try {
  md.streaming = false; md.content = head + ' Tail belongs here. |';
  const table = md.getChildren().find(x => x instanceof TextTableRenderable);
  if (!table?.content.at(-1)?.[2]?.map(c => c.text).join('').includes('Tail belongs here.')) process.exitCode = 1;
} finally { md.destroyRecursively(); renderer.destroy(); style.destroy(); await client.destroy(); }
```

## 10–12. Primary Path / Secondary Paths / Workarounds

在发行包 `parseMarkdownIncremental` 的现有 `reuseCount = Math.max(0, reuseCount - trailingUnstable)` 之前：只有 `trailingUnstable === 0`、匹配的旧块结束偏移等于 `prevState.content.length`、该偏移小于新长度，并且最后匹配的块类型为 `table` 时，重新确定词法解析起点。无前置链接定义时，将 `reuseCount` 减一。若表头前出现引用定义必需的 `]:` 标记，则设为 0，让同一个 lexer 也读到定义。`tableStart = offset - 最后匹配块.raw.length`；用 `prevState.content.lastIndexOf("]:", tableStart - 2)` 判断标记是否完整出现在表头前，无须截取字符串或解析第二遍。偶然出现相同字面量只使这次重读从头开始，不改变语义。后续仍由原有 lexer 识别表格和新段落；选定一次起点，不是在失败后重试。内容未变、普通流式和不同开头沿用原路径。

唯一新增决定是上述主路径的复用边界。已有初次解析、词法错误处理、预算内外渲染、scrollback 提交均保留不改。新增诊断/替代成功路径占比 0%；无待删 workaround。重新打开会话只是此前用户的手动恢复办法。

### 发布门禁：待执行的帧与开页滚动

[OpenTUI 单提交 preflight](https://github.com/SMARK2022/opencode/actions/runs/45006739138) 的性能与规则检查通过；macOS 与 Linux 的 `packages/tui` 全套在 `leak-preload.ts` 收尾失败。macOS 留下约 16ms 的帧计时器，Linux 同时留下 `scheduleSessionOpenScroll` 的 50ms 计时器。空渲染器即可复现前者，不需要加载表格。修复分别落在创建计时器的两个位置：

| 行为合同 | 首处分歧与修改 | 验证 |
| --- | --- | --- |
| INV-3：待绘制单帧可由手动绘制消费；重复暂停不得取消它；`idle()` 在实际交付或销毁前不能因句柄为 0 就提前结束 | 在安装包 `index-b5dpwnes.js` 保留 `requestRender()` 的 `updateScheduled` 和 `activateFrame()`。延迟单帧把句柄保存在已有 `renderTimeout`，到期先置空再进入原回调；零延迟仍走 `nextTick`。`internalPause()` 仅取消非单帧的非 null 句柄。`loop()` 不再先丢弃句柄，手动绘制遇非 null 计时器时清除原预约、归零句柄并将 `updateScheduled` 置 false。`cleanupBeforeDestroy()` 以非 null 判定取消；`requestRender()` 在已有的禁止调度检查处包含 `_isDestroyed`。实际调用栈为 `finalizeDestroy → root.destroyRecursively → remove → requestRender`，所以清理后不能再预约。 | 公开时钟分别返回 0、1 作首次句柄，重复 pause 后实际交付；手动画帧和销毁时不留 timer。真实 teardown、导航和高亮测试沿用同一版本。 |
| INV-4：页面存活时各次开页滚动仍按原 50ms 延迟、顺序和调用者意图执行；卸载后不再执行或预约 | `packages/tui/src/routes/session/index.tsx` 的 `scheduleSessionOpenScroll` 丢弃句柄。Session 组件持有仅属于该实例的 timer Set；每次登记、回调开头从捕获的 Set 删除，再调用原 `applySessionOpenScroll(respectUserScroll)`。Solid `onCleanup` 取消全部剩余句柄并把 Set 置为 `undefined`，异步 `sync.session.sync()` 在卸载后完成时不再预约。原应用滚动函数已检查 scroll 存活，不重复检查。不得合并多个预约，否则会混淆导航锚点与尊重用户滚动的补滚。 | 相同的 Session 页面挂载、销毁和导航用例，带原泄漏检查运行。 |

`updateScheduled` 表示单帧尚待交付，不覆盖该帧产生的下一次重绘。`activateFrame()` 验证标志后、进入 `loop()` 前将它置 false，原 `finally` 只通知等待空闲的调用者；正在绘制由已有的 `rendering` 标志表示。这样 `frame` 事件中请求重绘，随后在微任务中暂停，取消的是后续重绘，不会把它误作第一帧。`cleanupBeforeDestroy()` 开始清理时也将 `updateScheduled` 置 false，使已取消的预约不再出现在 `getSchedulerState().hasScheduledRender` 中。

两个 timer 都在对应 owner 内结束。键盘、鼠标、滚动意图、Markdown setter、泄漏检查和测试 teardown 不变；其它既有 timer 不是这次修改目标。归属还是仓内已注册的 OpenTUI core patch，以及 Session 组件；不修改依赖缓存、submodule 或 CI。

## 13–14. Forward / Reverse Mapping

| 需求 | Owner / 文件 | 验证 |
| --- | --- | --- |
| INV-1 正确分栏和链接语义 | 安装包 `index.js` 的增量解析，通过已注册的 core patch 交付 | 安装包测试使用同一追加样例的行内链接与前文定义链接两种拼写；验证一起显示正确的链接地址和续文，最后一个可见块仍是表。两张真实原文回放 |
| INV-2 保留已有流式性能 | 同一函数的既有流式窗、`Markdown.ts` 中表格和单元格缓存保留 | §18 对照扫描字符数、稳定前缀；对照同一表格/未变单元格身份。仅诊断测量，不写锁实现的回归断言 |

反向：新增“可延续的末表退出已完成前缀”对应 INV-1；旧逻辑只比较旧字符，无法确认末表在新文中的边界。选择起点时保留跨块定义，因为 `Lexer.lex(尾文)` 使用一个新的定义表，`[说明][r]` 的地址只在前文。已在顶层、列表及引用块前置定义上做隔离验证，三者都与一次性加载的 `https://example.org` 和后半句相同。复用已有计数与词法器以满足 INV-2，不加状态、解析器或配置。

## 15–17. File Plan / TDD / Comments

发布候选保留 `4e3c2be7b3` 在既有安装包高亮测试中的 +13/−12 行（`git diff 5e820f7acb 82063d8b24 -- packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts`）。三项分别是：增量分块按 `idle → highlightingDone → idle` 观察已预约帧，并释放测试自己创建的 code 和 style；单个过期请求在 `entered` 后换正文，再观察下一次已预约帧；重叠请求分别等待两次 `entered` 后才释放旧请求。后两项销毁 code/client 后等待渲染器空闲，再释放 renderer/style。保留它们是为了让原有文字、公式、标志和新一代高亮断言观察真实交付顺序；不以这些等待代替不等待 `idle()` 的销毁检查。它们属于本次完整审计，不沿用 R2 对这三处改动的批准。

| 文件 | 变更 |
| --- | --- |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 在 `index.js` 增一段约 4–9 行的 hunk，原有 ScrollBox 等补丁继续生效 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | 一个约 25–35 行的安装包用例，使用公开 setter、子元素与表格 `content`。只隔离无关的高亮客户端，finally 释放资源 |
| `docs/plans/opentui-final-table-append.md` | 本规格、审计与结果 |

TDD：在安装包上先观察两种拼写均有尾句落到表外（基线 fail），仅改 owner 补丁、重新应用 Bun 补丁后转绿，再回放截图。同一个公开结果断言中纳入链接目标和续文，保留断表基线敏感性；不新增仅检测中间方案的独立用例。注释解释表头以前的链接定义决定重读起点。没有 schema、公开 API 或 native 改动。

## 18. Verification

发布修复仅另改 `packages/tui/src/routes/session/index.tsx` 与同一个 core patch 的 `index-b5dpwnes.js` 区段，并在本文件记录结果。测试复用两个已经报错的文件及全套泄漏检查，额外提交的测试用例 0 个、测试代码 0 行。修复提交预计额外改动 20–35 行生产代码（增删合计）；表格提交保持独立。

在 `packages/tui` 执行 `bun test --preload ../../script/guard/leak-preload.ts ./test/cli/cmd/tui/dialog-session-list.test.tsx ./test/cli/cmd/tui/session-message-render.test.tsx --only-failures --timeout 30000`。原实现 58 pass、1 fail，剩余 50ms 和约 16ms 的 timeout。隔离候选在全包、真实 leak preload 下为 739 pass、2 skip、0 fail；带入的安装包高亮测试亦经隔离复跑。这是规划实验；正式包和远端验证须另记。

独立时钟的 `now()` 固定为 100，首次句柄分别为 0 和 1，其后递增，保存各句柄的回调，取消即删除。`createTestRenderer({width:40,height:10,useThread:false,clock})` 后 `await renderOnce(); renderer.pause(); renderer.requestRender()`。在没有下一次请求的情况下再 `pause()`，经过一个微任务确认 `idle()` 尚未返回、原句柄仍在；驱动该回调后 `idle()` 返回，恰好交付一帧。另两组分别直接销毁、手动绘制后销毁；销毁监听器再请求绘制以覆盖真实子树拆除。对两个首句柄，候选三组的（新增帧数，剩余句柄数）均为 `(1,0)/(0,0)/(1,0)`。原版直接销毁或手动绘制后销毁剩余一个句柄。

页面另一顺序的独立对照：在 `withRenderedSession` 的 `Probe` 挂载真正的 `<Session />` 前，把 `sync.session.sync` 包成先 await 原调用、通知已进入，再等待一个由夹具释放的 Promise。保持原 `sessionID`；收到通知后销毁 renderer，再释放 Promise，等一个 `setImmediate`。只在这段期间记录从 `scheduleSessionOpenScroll` 创建的 50ms 定时器，仍转发原时钟调用。相同挂载输入、相同未更换的路由：原实现创建 1 个，候选为 0。可在隔离副本 `packages/tui` 中设置 `SCROLL_LATE_PROBE=1`，运行上述 leak preload 和 `session-message-render.test.tsx -t 'new Write collapsed preview preserves'`；`SCROLL_BASELINE_PROBE=1` 选择原方法作反例。计数探针与这两个开关只用于实验，正式测试不带它们。

正式验证使用实际应用的 Bun patch，不带实验 preload。在 `packages/tui` 先跑上述两文件，再跑 `bun test --preload ../../script/guard/leak-preload.ts --only-failures --timeout 30000` 与 `bun typecheck`；同时复跑下表的表格、scrollback 和布局测试。在两个提交均通过正常 preflight 后，普通推送并以远端 `refs/heads/dev1-smark` 核实。

方案阶段在内存将候选条件插入当前源码函数，使用该模块解析到的同一个 `marked.Lexer`。前置 400 个段落、总长 4,878 字符；在 `Lexer.lex` 入参处测新增工作（字符数，非 wall-clock，也不含原有前缀比较）。正常流式前/后 80/80；完成后追加 12/78（旧结果缺尾句，新结果含尾句）；完成后另起合法段落 5/71，仍是独立段落；内容未变 0/0。各组的前文首块身份相同。渲染器内存对照也保留表格对象与不变单元格。无 native 或平台专用逻辑。

| 工作目录 | 命令 / 验收 |
| --- | --- |
| `packages/opencode` | `bun test ./test/cli/cmd/tui/opentui-streaming-runtime.test.ts -t 'final table cell'` 先红后绿；复跑 §8 并以截图原文、原断点和重新打开的完整结果对照 |
| 根 | `bun install --frozen-lockfile --ignore-scripts`；若当前 node_modules 仍链接旧补丁，以 Bun 支持的强制重新安装/隔离冷安装核对，不能仅手改已安装包。现有 URL、版本和锁保持不变 |
| `packages/opencode` | `bun test ./test/cli/cmd/tui/opentui-streaming-runtime.test.ts ./test/cli/run/scrollback.surface.test.ts`；`bun typecheck` |
| `packages/tui` | `bun test ./test/cli/tui/scroll-layout.test.ts`（原 core 补丁安装回归），`bun typecheck` |
| 根 | `git diff --check`（统一 diff 的嵌套上下文按补丁语法检查）、目标路径状态、提交路径核对 |

截图回放的可脱敏输入：用 §8 的表头与第一行，表尾分别替换为下列 `old + delta`，在 `old` 后设置完成，再写 `old + delta`；检查两例的末行三个单元格与同一完整文本新建渲染器一致。真实原文可在本机 OpenCode 存储中以该条助手回复的文本标题/正文精确定位，只读导出文本并 trim，不将会话 ID、原文或截图纳入测试数据。

| 原文定位（两段同时匹配） | old 末行 | delta |
| --- | --- | --- |
| `移植到哪个上游版本有收益`、`更关键的是，**正式标签里` | `\| 1.110.0 \| Router 已切到 Rust 核心。更关键的是，` | `**正式标签里仍有一个已知引用环**，见 [修复 PR](https://example.org)。 \| **不建议用于这次降内存。** \|` |
| `截图里的表格还原如下`、`不建议用于这次降内存。** 它会重新引入此前` | `\| 1.110.0 \| Router 已切到 Rust 核心。 \| **不建议用于这次降内存。**` | ` 它会重新引入此前处理过的同类问题。 \|` |

复跑扫描量：从仓库根运行下列 `bun -e` 脚本（PowerShell 可用单引号包围脚本）。候选条件只注入内存函数；以实际函数的词法调用入参计量。若存在前置定义，还会读取包含定义的前文；无定义时的数字见上表说明。

```js
import {parseMarkdownIncremental as parse} from "./thirdparty/opentui/packages/core/src/renderables/markdown-parser.ts";
import {resolve} from "node:path";
const {Lexer}=await import(Bun.resolveSync("marked",resolve("thirdparty/opentui/packages/core/src/renderables")));
const src=parse.toString(), n=src.match(/([\w$]+)\.lex\(/)[1], a="reuseCount = Math.max(0, reuseCount - trailingUnstable)";
const rule=`if(trailingUnstable===0 && offset===prevState.content.length && offset<newContent.length && prevState.tokens[reuseCount-1]?.type==="table"){const start=offset-prevState.tokens[reuseCount-1].raw.length;reuseCount=prevState.content.lastIndexOf("]:",start-2)>=0?0:reuseCount-1;}`;
const head="先前已经显示的段落。\n\n".repeat(400)+"| 版本 | 改动 | 判断 |\n|---|---|---|\n| A | 正常 | 对照 |\n| B | 更新 | **不建议。**";
for(const [name,add,m] of [["late"," 它会重新引入问题。 |",0],["stream"," 它会重新引入问题。 |",2],["space","\n\n新段落",0],["unchanged","",0]]) {
  for(const body of [src,src.replace(a,rule+a)]) {
    let work=0; const f=Function(n,"return ("+body+")")({lex:(s,opt)=>{work+=s.length;return Lexer.lex(s,opt)}});
    const old=parse(head,null,m), r=f(head+add,old,m);
    console.log(name,work,r.tokens[0]===old.tokens[0],r.tokens.find(t=>t.type==="table").rows.at(-1)[2].text);
  }
}
```

## 19–20. Diff Budget / Risks / Follow-up

规划期补充对照（原有 timeout 类型、原安装包）：分别用 0、1 作为首句柄，按直接销毁、手动绘制后销毁、第一帧到期前再次 pause、第一帧 `frame` 回调内 `requestRender()` 再 `queueMicrotask(() => renderer.pause())` 四个顺序运行。第四组不再请求第三帧，等待原 `idle()`。销毁监听器再调用一次 `requestRender()`。两种句柄下实际新增帧数均为 `0/1/1/1`，四组最终队列均为空、`hasScheduledRender=false`。上一候选在第四组剩一帧，直接销毁也会留下 true 标志。同一修订的隔离检查：先前失败的两文件 58 pass，完整 TUI 739 pass、2 skip、0 fail。正式安装后重跑这四组与 §18 的原始门禁。

从固定基线计，任务涉及本文件、core patch、安装包表格测试、Session 页面，共 4 个路径。表格修复的原预算为源码约 4–9 行、测试约 25–35 行；实际改动见 §23。发布收尾的增删预算单列于 §18，无新增生成文件。完成态重复向同一大表追加，每次可能重读末表；该路径区别于普通流式输出。上面的字符计数不预估端到端延迟。

Open decisions：无。Follow-up：连续绘制期间的 `requestRender()` 和 `scheduleRenderTimer()` 对句柄 0 可能重复预约，固定基线同样如此；不列入本次验收或改动。Rejected speculation: 图片不足以证明 SSE 乱序、原文损坏或原生字符宽度异常；在无这些条件的公开接口上已独立复现。

## 21. Audit Contract

独立审计看固定基线到目标的完整差异及公开行为，按仓库 policy 完成全范围方案与实现审计。仅记录原样 verdict，不以自查代替。测试不通过时继续定位；无关并行工作不纳入本提交。

## 22. Revision Delta / Plan Audit Record

R3：保留固定 R1 基线至表格修复的完整设计和既有审计；因独立发布门禁新增 INV-3、INV-4、一个页面文件及两项 owner 修复。全范围方案审计 `ses_dfd448517ffeEzyC28W1ag0AY6`：B-01（reachable）延迟帧改用 `renderTimeout` 后，仍待绘制的帧可能被当作已经结束；B-02（observed）待推送的表格提交比 R2 获批内容多了三处既有测试改动；B-03（contracted）开页滚动的验收漏掉了“先卸载，后完成同步”。Non-blocking findings：无。Follow-up：无。

**BLOCK — `docs/plans/opentui-final-table-append.md`，R3。** 保留表格修复；修订帧调度、补齐卸载后预约的验证，并对齐实际提交范围后，再做全范围方案复审。

R4：§1、§10–12、§15–18。保留原单帧的标记与回调；补充现有高亮夹具清单和迟到同步的基线/候选实测。全范围方案复审 `ses_dfd448517ffeEzyC28W1ag0AY6`：B-01（reachable）第一帧已经画完时，`pause()` 可能保留本应取消的下一帧；B-02（reachable）销毁取消了计时器，却留下“仍有帧待画”的公开状态。Non-blocking findings：无。Follow-up：无。

**BLOCK — `docs/plans/opentui-final-table-append.md`，R4。** 下一版需修正上述两处帧状态转换并复审。表格修复和已核清的提交边界无需返工。

R5：只调整待交付标志的结束时机，增加对已绘制、已销毁两个公开状态的隔离验收。无新增状态、文件或提交测试。全范围方案审计 `ses_dfd448517ffeEzyC28W1ag0AY6`：No blocking findings.

Non-blocking findings：方案第 86 行的“手动绘制可消费待绘制单帧”可写得更准确：这里验证的是**带计时器的延迟单帧**。零延迟仍走原有 `nextTick` 路径。只需收准措辞。Follow-up：无。

**APPROVE — `docs/plans/opentui-final-table-append.md`，仅限 R5 方案。** 可按 R5 实施。推送前仍须用实际 Bun 补丁完成回归、类型检查、独立实现审计和正常 preflight；帧与开页滚动修复独立提交，本次不带入 compaction。

R1 首审，full scope，`ses_e0a5cbfd8ffeLDN4r4iy2bWxPX`：`Blocking`：`B-01 重读末表时会丢失表格前面定义的链接`；`B-02 原例回放和性能对照缺少可复跑的输入`。Non-blocking findings：无。Follow-up：无。

**BLOCK — `docs/plans/opentui-final-table-append.md`，R1，全范围方案审计。** 修订 B-01、B-02 后重新审计；本轮不授权实施或提交。

R2 delta：§5–7、10–18。B-01 已复现旧表保留链接而仅重读末表会丢链接；调整同一算法的解析起点并用链接+尾句一起验收。B-02 补截图输入、断点与扫描计量脚本。原有两条 invariant，无新增文件、缓存、持久状态或 API。

R2 全范围复审，`ses_e0a5cbfd8ffeLDN4r4iy2bWxPX`。No blocking findings.

**N-01：性能说明应沿用 §10–12 写明的实际条件。** `docs/plans/opentui-final-table-append.md:50` 的“末表独立可解析时保留前文复用”说得偏宽。按第 74 行的规则，只要表头前出现 `]:`，这次完成后的追加就会重读全文，即使它只是代码示例 `map[key]: value` 的一部分。正常流式更新不走这个分支。交付时讲清这笔开销即可，无需为辨认代码示例再加一套规则。

Follow-up：无。

**APPROVE — `docs/plans/opentui-final-table-append.md`，R2，全范围方案审计通过。** 本结论批准按 R2 实施。提交前仍须完成安装包红绿测试、两处原例回放和独立实现审计；提交范围限于方案列出的三个文件。

## 23. Implementation Evidence

**R5 正式安装包，Windows / Bun 1.4.4。** 表格提交 `82063d8b24` 上的新增实现只有开页滚动清理（`packages/tui/src/routes/session/index.tsx`，+11/−2）和已注册的 core patch 中的帧调度修复（JS 内层 diff +11/−7）。没有新增测试或公共接口；固定基线到当前实现还包括 §15–17 的表格及高亮测试。根目录经授权执行 `bun install --offline --frozen-lockfile --ignore-scripts`，退出 0，`package.json`、`bun.lock` 无变化。以下正式验证不加载实验补丁。

| 目录 | 检查 | 实测 |
| --- | --- | --- |
| `packages/tui` | §18 两个泄漏用例文件，使用仓库 `leak-preload.ts` | 原版 58 pass、1 fail（50ms 滚动及约 16ms 帧）；安装后 58 pass、0 fail |
| `packages/tui` | §19 独立时钟四种顺序，首句柄为 0 和 1 | 两组均交付 `0/1/1/1` 帧；八例最终均无 timer，`hasScheduledRender=false` |
| `packages/tui` | `bun test --preload ../../script/guard/leak-preload.ts --only-failures --timeout 30000`；`bun test ./test/cli/tui/scroll-layout.test.ts` | 全套 739 pass、2 skip、0 fail；布局 10 pass |
| `packages/opencode` | §18 的 `opentui-streaming-runtime.test.ts` 与 `scrollback.surface.test.ts` | 27 pass、1 skip、0 fail |
| 两个包各自目录；仓库根 | `bun typecheck`；`git diff --check`、`git apply --numstat` 解析完整 core patch | 均通过 |

页面不再依靠定时器到期后才发现已卸载；渲染器不再丢弃帧句柄。现有高亮等待、真正的渲染及权限路径不变。迟到同步的 1→0 对照是 §18 的隔离证据。Linux、macOS 和发布性能以此次独立修复提交的正式 preflight 为准，不能引用此前失败的 `82063d8b24` 运行作放行。

**B-01 返工验证。** 经 §24 单次授权，重新执行上述离线安装，锁与 manifest 均无 diff。相同的 `nextTick → frame 内请求 → 微任务再次请求` 顺序，首句柄 0 和 1 均只排一个回调，共画两帧，销毁后剩余计时器为 0。八组时钟复验同上（通过 `getSchedulerState().hasScheduledRender` 读取）；原两文件 58 pass，完整 TUI 739 pass、2 skip、0 fail，表格/scrollback 27 pass、1 skip，布局 10 pass；两包类型检查通过。最终 renderer 生命周期 hunk 为 +12/−8。

**B-02 返工验证。** 用户在“B-02 正式验证”选择“验证并复审”，授权一次相同的离线安装和原任务复审。正式包在首句柄为 0、1 时结果一致：回调前均只有一个预约，`hasScheduledRender=true` 且 `idle()` 未返回；回调后队列为空，`hasScheduledRender=false` 且 `idle()` 已返回，共画两帧。十组暂停、销毁、手动绘制及合并顺序全部通过，未提交探针。重新运行 §18：原泄漏用例 58 pass，TUI 全套 739 pass、2 skip、0 fail，布局 10 pass，表格/scrollback 27 pass、1 skip；两包类型通过，锁与 manifest 无变化。最终帧补丁 +14/−10，开页滚动 +11/−2。

**B-03 返工验证。** 同一正式包入口执行 `start → idle → stop`，首句柄为 0、1 均无需推进时钟，队列即为空，已返回空闲，公开预约状态为 false。两类句柄下其余 12 个帧序列全部通过。原泄漏 58 pass；全套 TUI 739 pass、2 skip、0 fail；布局 10 pass；表格/scrollback 27 pass、1 skip；两个包类型检查通过，manifest 与锁无改动。最终帧生命周期补丁 +15/−11；两处基线已有的连续绘制重复预约判断未改。

**原表格修复记录：**

- 实际 diff：§15 中的三个文件；core 补丁在增量解析器内新增 6 行，原有 hunk 的目标行号顺延；安装包用例分别输入行内链接和前文定义链接；本文记录回放及审计。无 submodule、manifest、锁、原生或生成代码更改。
- 红绿：在 `packages/opencode` 跑 §18 的 `final table cell` 命令。基线 2 fail，实际单元格最后为 `)`，期望 ` still pending.`。根目录执行经授权的 `bun install --frozen-lockfile --ignore-scripts` 后，同一命令 2 pass、0 fail。安装包 `index.js:7928` 已含本次 hunk，`git status --short -- bun.lock package.json` 无输出。
- §8 原脚本：从两个块和缺少尾句，变为一个 `TextTableRenderable`，第三列 `No. Tail belongs here.`。真实消息只读加载并在原断点 1275、683 截断；执行完成后追加，对照同一完整消息一次性渲染。两例全部块类型、全部单元格显示文字及链接 URL 相同；旧表对象和首个未变数据单元格均复用。
- 回归：§18 的 OpenCode 两文件测试 27 pass、0 fail、1 skip（`scrollback.surface.test.ts` 已有的 Windows 跳过条件）；TUI 滚动测试 10 pass。两包各自 `bun typecheck` 均通过。`git diff --check` 对本任务实现文件通过。
- 路径与开销：流式窗不变，只有完成后正文追加到末表才调整起点。前有 `]:` 时，这一次会重读全文，包含同样符号的代码示例也如此；其余重读末表。没有新增替代成功路径、诊断、临时 workaround 或待删除的兼容逻辑。
- 未验证：未测端到端延迟和非 Windows 平台。未改 Zig 或发布包版本；平台跳过项保持原状。Follow-up：无。

## 24. Implementation Audit Record

R5 全范围实现审计 `ses_dfd0b4b83ffeH5n08eC9IvA8Sd`。Blocking findings：B-01 后续帧的计时器句柄为 `0` 时，R5 会重复预约一帧（`reachable`，`introduced by delta`）。Non-blocking findings：无新增项。Follow-up：无。

**BLOCK — `docs/plans/opentui-final-table-append.md` R5，当前完整实现差异不放行。** 保留独立的表格提交；修正 B-01、核验安装包结果并完成全范围复审后，再进入推送前的正常 preflight。

本次授权：用户在“验证与复审授权”中选“两项均授权”，即再做一次根目录离线冻结安装，并在回归通过后用本轮原审计任务追加一轮全范围实现复审。

正式包复现：首帧走 `nextTick`，在 `frame` 回调内请求重绘，再在微任务里请求一次。首句柄为 0 时队列为 `[0,1]`，共画 3 帧；首句柄为 1 时队列为 `[1]`，共画 2 帧。返工只把空闲 `requestRender()` 的无预约判定改为 `renderTimeout === null`。未改不变量、文件范围或测试夹具；以上一版的通过数字不代替本次验证。

R5 追加的全范围实现复审 `ses_dfd0b4b83ffeH5n08eC9IvA8Sd`：B-01 已关闭。Blocking findings：B-02 重绘请求已经合并，`idle()` 却会在该帧画出前返回（`reachable`，`introduced by delta`）。Non-blocking findings：无新增项。Follow-up：无。

**BLOCK — R5 当前完整实现差异不放行。** 保留独立表格提交及 B-01 修复；修正 B-02 并完成全范围复审后，再进入推送前的正常 preflight。

正式包复现：`intermediateRender()` 后立即请求重绘，计时器到期前，句柄 0 的队列里仍有一帧，`idle()` 已返回、`hasScheduledRender=false`；以 1 为首句柄，这两项分别为未返回及 true。对两项查询沿用同一 `null` 空值判定，无额外分支、状态或 API。

R5 第三轮全范围实现审计 `ses_dfd0b4b83ffeH5n08eC9IvA8Sd`：B-01、B-02 已关闭。Blocking findings：B-03 连续绘制停止后，句柄为 `0` 的下一帧仍会让 `idle()` 等待（`reachable`，`introduced by delta`）。Non-blocking findings：无新增项。Follow-up：见 §19–20。

**BLOCK — R5 当前完整实现差异不放行。** 表格修复保持独立，B-01、B-02 保持关闭。R5 实现审计已达三轮上限；B-03 作为未决阻塞项交由用户决定是否授权返工后追加复审。在此之前不放行推送。

正式包对照 `start → idle → stop`，不驱动时钟：首句柄为 0，队列仍有 1 帧，空闲等待未结束；为 1 时队列为空，空闲等待已结束。

用户在“停止绘制的修复”中选“修复并复审”，授权只改 `internalStop()` 的取消判断、一次离线冻结安装、回归和一次原审计任务复审。

R5 授权追加的全范围实现复审 `ses_dfd0b4b83ffeH5n08eC9IvA8Sd`。源码核对为 No blocking findings；本轮初判 **BLOCK（仅待核验最终运行结果）— R5 当前实际差异。** 同一任务收到本次原始输出后独立复跑停止序列、两组回归、布局与类型检查，核对完整 TUI 日志。最终 Blocking findings：No blocking findings. B-03 已关闭，B-01、B-02 保持关闭。Non-blocking findings：无新增项。Follow-up：§19–20 的基线重复预约。

**APPROVE — `docs/plans/opentui-final-table-append.md` R5，当前四个任务文件的完整实现差异通过全范围复审。** 上轮待核验项已关闭。按 §1 保留独立表格提交，帧与开页滚动收尾另行提交；正常 preflight 通过后再普通推送，本次不带入 compaction。

实现审计第 1 轮，R2，全范围，`ses_e0a3c68fcffeHM5rqjg31ryO42`。Blocking findings：No blocking findings. Non-blocking findings：无。Follow-up：无。

**BLOCK（待核验运行结果）。** 源码审查未发现需要返工的缺陷。方案 §23 记录了红绿测试、两处原例回放和类型检查结果；本轮尚未取得可独立核对的原始输出。请提供本任务对应的命令输出，或授权在两个包目录运行 §18 的检查并使用其中的脱敏原例回放。核验前暂不放行提交。

实现审计第 2 轮，R2，全范围，`ses_e0a3c68fcffeHM5rqjg31ryO42`。Blocking findings：No blocking findings. Non-blocking findings：无。Follow-up：无。

**APPROVE — `docs/plans/opentui-final-table-append.md`，R2，全范围实现复审通过。** 上轮待核验项已关闭，可提交本次审计的方案、安装包回归测试和 OpenTUI 补丁三个文件。
