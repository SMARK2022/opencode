# Canonical Implementation Plan: OpenTUI 收尾时继续填入末表

> Status: verified
>
> Revision: R2
>
> Approved revision: R2
>
> Audit mode: full-scope
>
> Requirement source: 本次会话的两张截图、用户对性能的提问和范围确认（§1）
>
> Implementation allowed: no further material changes without revision or rework
>
> Last updated: 2026-11-20

固定基线 `0dfffcda2bcd07e28014d1e82270453e3dc586d3`。这是本任务唯一实施规格。此基线的目标路径没有待保留的未提交实施改动。

## 1. Verbatim Requirement

> 这一个表格，它中间可能由于一些Markdown，它导致它解析成一个片段的东西了。
>
> 表格是什么问题导致的。如果要修改，准备怎么修改。它会撤回，或者说使得部分我们已有的一些性能收益下降吗？按照我的理解，我们之前的逻辑难道本身它不就是说，在表格未闭合的时候仍然保持整个表格的这种更新吗？那为什么还会出现这种问题？清晰准确解释，不要使用一些过度复杂的一些逻辑，或者说术语，或者过度凝练的东西。

用户确认范围：“修复 OpenTUI 断表、保留流式性能，按方案和实现两轮审计后只提交本任务文件？” 答：“实施并提交”。确认的测试入口是已安装的 `MarkdownRenderable`，交付形式为现有 OpenCode 仓内补丁。

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

## 13–14. Forward / Reverse Mapping

| 需求 | Owner / 文件 | 验证 |
| --- | --- | --- |
| INV-1 正确分栏和链接语义 | 安装包 `index.js` 的增量解析，通过已注册的 core patch 交付 | 安装包测试使用同一追加样例的行内链接与前文定义链接两种拼写；验证一起显示正确的链接地址和续文，最后一个可见块仍是表。两张真实原文回放 |
| INV-2 保留已有流式性能 | 同一函数的既有流式窗、`Markdown.ts` 中表格和单元格缓存保留 | §18 对照扫描字符数、稳定前缀；对照同一表格/未变单元格身份。仅诊断测量，不写锁实现的回归断言 |

反向：新增“可延续的末表退出已完成前缀”对应 INV-1；旧逻辑只比较旧字符，无法确认末表在新文中的边界。选择起点时保留跨块定义，因为 `Lexer.lex(尾文)` 使用一个新的定义表，`[说明][r]` 的地址只在前文。已在顶层、列表及引用块前置定义上做隔离验证，三者都与一次性加载的 `https://example.org` 和后半句相同。复用已有计数与词法器以满足 INV-2，不加状态、解析器或配置。

## 15–17. File Plan / TDD / Comments

| 文件 | 变更 |
| --- | --- |
| `patches/@opentui%2Fcore@0.4.3-smark.13.patch` | 在 `index.js` 增一段约 4–9 行的 hunk，原有 ScrollBox 等补丁继续生效 |
| `packages/opencode/test/cli/cmd/tui/opentui-streaming-runtime.test.ts` | 一个约 25–35 行的安装包用例，使用公开 setter、子元素与表格 `content`。只隔离无关的高亮客户端，finally 释放资源 |
| `docs/plans/opentui-final-table-append.md` | 本规格、审计与结果 |

TDD：在安装包上先观察两种拼写均有尾句落到表外（基线 fail），仅改 owner 补丁、重新应用 Bun 补丁后转绿，再回放截图。同一个公开结果断言中纳入链接目标和续文，保留断表基线敏感性；不新增仅检测中间方案的独立用例。注释解释表头以前的链接定义决定重读起点。没有 schema、公开 API 或 native 改动。

## 18. Verification

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

新增文档 1，修改补丁和测试各 1，删除 0，源码约 4–9 行，测试约 25–35 行，无生成文件。完成态重复向同一大表追加，每次可能重读末表；该路径区别于普通流式输出。上面的字符计数不预估端到端延迟。

Open decisions: none。Follow-up: none。Rejected speculation: 图片不足以证明 SSE 乱序、原文损坏或原生字符宽度异常；在无这些条件的公开接口上已独立复现。

## 21. Audit Contract

独立审计看固定基线到目标的完整差异及公开行为，按仓库 policy 完成全范围方案与实现审计。仅记录原样 verdict，不以自查代替。测试不通过时继续定位；无关并行工作不纳入本提交。

## 22. Revision Delta / Plan Audit Record

R1 首审，full scope，`ses_e0a5cbfd8ffeLDN4r4iy2bWxPX`：`Blocking`：`B-01 重读末表时会丢失表格前面定义的链接`；`B-02 原例回放和性能对照缺少可复跑的输入`。Non-blocking findings：无。Follow-up：无。

**BLOCK — `docs/plans/opentui-final-table-append.md`，R1，全范围方案审计。** 修订 B-01、B-02 后重新审计；本轮不授权实施或提交。

R2 delta：§5–7、10–18。B-01 已复现旧表保留链接而仅重读末表会丢链接；调整同一算法的解析起点并用链接+尾句一起验收。B-02 补截图输入、断点与扫描计量脚本。原有两条 invariant，无新增文件、缓存、持久状态或 API。

R2 全范围复审，`ses_e0a5cbfd8ffeLDN4r4iy2bWxPX`。No blocking findings.

**N-01：性能说明应沿用 §10–12 写明的实际条件。** `docs/plans/opentui-final-table-append.md:50` 的“末表独立可解析时保留前文复用”说得偏宽。按第 74 行的规则，只要表头前出现 `]:`，这次完成后的追加就会重读全文，即使它只是代码示例 `map[key]: value` 的一部分。正常流式更新不走这个分支。交付时讲清这笔开销即可，无需为辨认代码示例再加一套规则。

Follow-up：无。

**APPROVE — `docs/plans/opentui-final-table-append.md`，R2，全范围方案审计通过。** 本结论批准按 R2 实施。提交前仍须完成安装包红绿测试、两处原例回放和独立实现审计；提交范围限于方案列出的三个文件。

## 23. Implementation Evidence

- 实际 diff：§15 中的三个文件；core 补丁在增量解析器内新增 6 行，原有 hunk 的目标行号顺延；安装包用例分别输入行内链接和前文定义链接；本文记录回放及审计。无 submodule、manifest、锁、原生或生成代码更改。
- 红绿：在 `packages/opencode` 跑 §18 的 `final table cell` 命令。基线 2 fail，实际单元格最后为 `)`，期望 ` still pending.`。根目录执行经授权的 `bun install --frozen-lockfile --ignore-scripts` 后，同一命令 2 pass、0 fail。安装包 `index.js:7928` 已含本次 hunk，`git status --short -- bun.lock package.json` 无输出。
- §8 原脚本：从两个块和缺少尾句，变为一个 `TextTableRenderable`，第三列 `No. Tail belongs here.`。真实消息只读加载并在原断点 1275、683 截断；执行完成后追加，对照同一完整消息一次性渲染。两例全部块类型、全部单元格显示文字及链接 URL 相同；旧表对象和首个未变数据单元格均复用。
- 回归：§18 的 OpenCode 两文件测试 27 pass、0 fail、1 skip（`scrollback.surface.test.ts` 已有的 Windows 跳过条件）；TUI 滚动测试 10 pass。两包各自 `bun typecheck` 均通过。`git diff --check` 对本任务实现文件通过。
- 路径与开销：流式窗不变，只有完成后正文追加到末表才调整起点。前有 `]:` 时，这一次会重读全文，包含同样符号的代码示例也如此；其余重读末表。没有新增替代成功路径、诊断、临时 workaround 或待删除的兼容逻辑。
- 未验证：未测端到端延迟和非 Windows 平台。未改 Zig 或发布包版本；平台跳过项保持原状。Follow-up：无。

## 24. Implementation Audit Record

实现审计第 1 轮，R2，全范围，`ses_e0a3c68fcffeHM5rqjg31ryO42`。Blocking findings：No blocking findings. Non-blocking findings：无。Follow-up：无。

**BLOCK（待核验运行结果）。** 源码审查未发现需要返工的缺陷。方案 §23 记录了红绿测试、两处原例回放和类型检查结果；本轮尚未取得可独立核对的原始输出。请提供本任务对应的命令输出，或授权在两个包目录运行 §18 的检查并使用其中的脱敏原例回放。核验前暂不放行提交。

实现审计第 2 轮，R2，全范围，`ses_e0a3c68fcffeHM5rqjg31ryO42`。Blocking findings：No blocking findings. Non-blocking findings：无。Follow-up：无。

**APPROVE — `docs/plans/opentui-final-table-append.md`，R2，全范围实现复审通过。** 上轮待核验项已关闭，可提交本次审计的方案、安装包回归测试和 OpenTUI 补丁三个文件。
