# Record 0140-8acb3fecbfe7

## Identity
- Index: **140**
- Current: `.temp/patches/current/0140-8acb3fecbfe7.patch`
- Current SHA-256: `b8078d883e4bed3398d675bac4d5d4ee4dbb1db3704079a264592640dfb7111c`
- Bytes: **8246**
- E/C: **E=78 C=13 need>=12** (PASS)
- Batch typecheck: `typecheck-0140-2026-07-23T20-46-41-697Z.json` 30/30
- Install: `b1965193fab202bc94ddf89ee12a7024f63620bdf86156961857675dddb79977`
- Tip: `.temp/patches/states/0140-8acb3fecbfe7`

## Source / tip / current fusion
见本文件后续实质说明与三方对照；current 已按 dual audit BLOCK 项全量修复并重新 materialize。

## 审计修复（dual BLOCK 后）
- **B-01 已修**：移植 `auto compaction resumes without compacting retained old tail usage again`。
- 生产：clamp [3,4]、tokenEstimate 回退、overflow 在 estimatedInput 之后。


## 验证
- `bun .temp/patches/src/apply-cumulative.ts --rebuild --materialize 140` PASS
- `bun .temp/patches/src/apply-cumulative.ts --typecheck 140` → `typecheck-0140-2026-07-23T20-46-41-697Z.json` all passed
- 独立 E/C 达标；record sha/bytes 与磁盘 current 一致

## 先前实质说明（保留）
## Source intent
Original 解决 auto-compaction **preflight 误触发**：

1. 用历史 step-finish 的 `inputChars` 与 input(+cache read/write) tokens 估计 **charsPerToken**。  
2. **clamp 到 [3, 4]**：异常样本不得把 preflight 估得过乐观（该压不压）或过悲观（过早连环压）。  
3. 样本不足（历史 chars ≤500 或无 tokens）→ **Token.estimate**（chars/4）。  
4. **overflow 时点**：在 assembled prompt 得到 `estimatedInput` 之后判断，而不是在 assemble 前用 `lastFinished.tokens`（那是上一轮结束用量，含可能已被 filter 掉的巨大 tail）。  
5. 目的：auto compact 对齐「即将发送」窗口，避免 tail 旧巨量导致压完立刻再压。

## 上游 / tip@139
- tip 已在 messages/tools/system assemble 后计算 history 比率与 `estimatedInput`，并写入 assistant message 供 TUI。  
- 但 tip **未夹紧** charsPerToken；且 loop 在 assemble **前**仍可能用 `lastFinished.tokens` 调 `compaction.isOverflow`。  
- `Token.estimate`：`@/util/token` re-export core，`CHARS_PER_TOKEN=4`。  
- #137 已保证手动 compact `!auto` break；本 patch 只动 auto overflow 触发点。

## first divergence
1. 无 clamp → 极端比值。  
2. lastFinished overflow 与即将发送窗口不一致 → 错误 auto compact 节奏。

## 目标适配
1. 模块顶（import 后）：`INPUT_CHARS_HISTORY_LIMIT=100_000`、`MIN/MAX_CHARS_PER_TOKEN=3/4`、`clampCharsPerToken`。  
2. `import { estimate as tokenEstimate } from "@/util/token"`。  
3. 删除 assemble 前 lastFinished overflow 块，注释标明迁到 estimatedInput 后。  
4. history 循环用命名 limit；足够样本：`round(inputChars / clamp(historyChars/historyTokens))`；否则 `tokenEstimate(systemText+messagesText+toolsText)`。  
5. 立刻 `isOverflow({ tokens: { input: estimatedInput, output:0, reasoning:0, cache:{read:0,write:0} } })` → `compaction.create(auto:true)` 并 `return "continue"`。  
6. 仍写 `handle.message.tokens.input = estimatedInput`（TUI 流式），真实 step-finish 覆盖。

## 三方对照
| 点 | Source | tip@139 | Current |
|---|---|---|---|
| clamp [3,4] | 有 | 无 | 有 |
| 无样本 | Token.estimate | 字面 /4 | tokenEstimate |
| overflow 时点 | estimatedInput 后 | lastFinished 前 | estimatedInput 后 |
| 历史窗口 | 100k | 100k 字面量 | INPUT_CHARS_HISTORY_LIMIT |
| 手动 compact | 另 commit | #137 break | 不破坏 |

## 修订记录
1. 首次 patch 把 helpers 锚到 tip 不存在的 `const log = Log.create...` → 使用处符号未定义（TS2304）。  
2. helpers 改放到 import 后模块顶；补 tokenEstimate；dry-run OK；typecheck 30/30。

## tip 摘录
  packages/opencode/src/session/prompt.ts:62
    61| // #140：无历史样本时回退 Token.estimate（chars/4）
    62| import { estimate as tokenEstimate } from "@/util/token"
    63| 
  packages/opencode/src/session/prompt.ts:65
    64| // #140：输入侧 chars/token 样本窗口与夹紧范围
    65| const INPUT_CHARS_HISTORY_LIMIT = 100_000
    66| const MIN_CHARS_PER_TOKEN = 3
  packages/opencode/src/session/prompt.ts:69
    68| // #140：防止异常样本把 preflight 估得过乐观/过悲观
    69| function clampCharsPerToken(value: number) {
    70|   return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value))
  packages/opencode/src/session/prompt.ts:1243
    1242| 
    1243|           // #140：overflow 改到 assembled prompt 的 estimatedInput 之后，避免 tail 旧用量连环压缩
    1244| 

## 注释（C）
- `// #140：无历史样本时回退 Token.estimate（chars/4）`
- `// #140：输入侧 chars/token 样本窗口与夹紧范围`
- `// #140：防止异常样本把 preflight 估得过乐观/过悲观`
- `// #140：overflow 改到 assembled prompt 的 estimatedInput 之后，避免 tail 旧用量连环压缩`
- `// #140：输入侧比率校准（历史 step-finish inputChars/tokens），夹紧到 [3,4]`
- `// #140：样本不足时回退 Token.estimate；有样本则夹紧比值`
- `// #140：用即将发送的 estimatedInput 做 overflow，而非 lastFinished 历史巨量`

## 验证
- `bun .temp/patches/src/apply-cumulative.ts --rebuild --materialize 140` → `.temp/patches/states/0140-8acb3fecbfe7`
- typecheck `typecheck-0140-2026-07-23T20-07-14-017Z.json` **30/30**
- install `b1965193fab202bc94ddf89ee12a7024f63620bdf86156961857675dddb79977`
- 无 `lastFinished.tokens` overflow；有 clamp + preflight overflow

## 最终
preflight 对齐即将发送窗口；chars/token 夹紧；样本不足回退 Token.estimate；E/C 达标。


## Dual independent audit
- FORWARD: **PASS** (all five; no open B/G)
- REVERSE: **PASS** (all five; no open B/G)
- Typecheck: `typecheck-0140-2026-07-23T21-35-57-482Z.json` 30/30
- Install: `b1965193fab202bc94ddf89ee12a7024f63620bdf86156961857675dddb79977`
- Tip: `.temp/patches/states/0140-8acb3fecbfe7`
- Closed: 2026-07-23 batch 136-140
