# Canonical Implementation Plan: 图片完整解码与失败省略链路

> Status: verified
>
> Revision: R7
>
> Approved revision: R7
>
> Audit mode: implementation
>
> Requirement source: 当前 Session GOAL 中的原始需求
>
> Implementation allowed: complete
>
> Last updated: 2026-07-23

This file is the sole implementation specification for this task. Chat
summaries, superseded revisions, and builder rationale outside this file are
not implementation authority.

## 1. Verbatim Requirement

> 需要在当前的opencode仓库中完整的使用pi的相关链路：Pi
> magic + IHDR（+ BMP 规则）
> Photon open/resize
> open 成功且未超限则 pass-through
> Image omitted 文本
> 否（omit 后继续）；使用统一的processImage（统一 pipeline）；保持较小修改，也就是自行根据需求选择看使用sharp还是Photon等，要求全部图片都要经过一遍decode解码，并适当处理，保持整体高性能且不会破坏原有的正常行为、阈值和落库表现；整体保持较小修改，避免大范围改动。保持甜点级别修改，修改代码数在6个以内，行数在1200行以内；保持整体实现核心简洁不臃肿。同时要保证二进制准确正常打包而不会出现打不进去包的情况问题（sharp曾单独做过处理，以及你可以看看，如果pi使用的生态库更容易打包，我们可以换用其使用的依赖库库而不使用sharp）

目标终态：`verified-implementation-and-commit`。

## 2. Explicit Non-Goals

- 不改数据库 schema、消息 schema、SDK/OpenAPI 或配置 schema。
- 不批量改写用户的 `opencode.db`；已有只读 preview / 显式 `--apply` 的图片迁移脚本继续负责历史库存。
- 不在每次 provider 请求组装时重新解码全部历史图片；新图片在唯一入库 seam 处理，旧库存由既有迁移脚本处理。
- 不改 PDF、音频、视频、provider vision capability、token estimator 或 TUI 剪贴板平台命令。
- 不为 SVG、APNG、AVIF、TIFF、动画 GIF 等各建专属算法或改变其格式语义；任何当前能被 Sharp 完整 decode 的非 BMP `image/*` 继续走同一 generic Sharp contract，正常历史 bytes 应保持。
- 不新增图片 cache、worker、并发队列、配置开关、重试后端或第二套通用 resize 算法。
- 不移除 `sharp` 或 `@silvia-odwyer/photon-node` 依赖，也不改 lockfile；两者都是当前仓库已固定的依赖和打包资产。
- 不把 `IEND` 扫描当作完整性判断；真实故障证明合法头部之后仍可能存在损坏的像素流。

## 3. Repository Context

| Source | Why it constrains this task |
| --- | --- |
| `AGENTS.md` | 默认分支为 `dev`；测试必须从 package 目录运行；保持小函数和已有模块 owner；仅按用户明确要求 commit。 |
| `packages/opencode/AGENTS.md` | `Image.Service` 必须保持 Effect service/module shape；typed error 使用 `Schema.TaggedErrorClass`；不新建 barrel 或 ambient runtime shim。 |
| `packages/opencode/test/AGENTS.md` | Effect 测试使用现有 fixture / `testEffect`；不以固定 sleep 同步；测试从公共 seam 观察行为。 |
| `CONTEXT.md` | `packages/opencode/src/image/` 是图片处理 owner；`session/` v1 是当前生产链，不能把 v2 迁移当成已完成。 |
| `docs/adr/README.md` | 单次图片处理修复是现有模块内的责任，不需要新增 ADR。 |
| `docs/adr/0001-triage-labels-and-team-assignment-coexist.md` | 与图片链路无关，不约束设计。 |
| `.opencode/policy/first-principles-engineering.md` | 必须修复 first divergence，禁止 fallback，完成 forward/reverse mapping、中文注释门禁和独立审计。 |
| `docs/draft/image-processing-unification-plan.md` | 这是已被实现状态超越的旧 Draft：其中“Photon primary / read 独立 Sharp”已不符合当前源码；只作为历史证据，不是本计划 authority。 |

## 4. Files and Evidence Read

| Evidence | Relevance | Evidence class |
| --- | --- | --- |
| `C:\Users\Lenovo\.local\share\opencode\opencode.db` 中 `ses_10fb7b41cfferSWcJIpOXdJIGj`、`prt_f89c96bb90016ur068DCoFY85s`、`msg_f89c98509001VLDBWjgUc4Ga17` | tool 以 `image/png` 完成并落入 2552-byte attachment；下一请求只有 1 张图片，provider 返回 400 `Invalid PNG image.`。 | observed |
| 同一 attachment bytes 和 `H:\Hyper\FRCheck\temp\ruoyi_captcha.png` | PNG signature 正确、没有 `IEND`；数据库 bytes 与本地文件一致，排除 base64/落库变形。 | observed |
| 当前 `Image.normalize` 临时 harness（3 次） | 64x64 合法 PNG 的 IDAT 首字节损坏后，`Image.normalize` 三次均原样 success；命令 exit 1，稳定捕获原始缺陷。 | observed |
| `sharp(...).metadata()` / `.raw().toBuffer()` 对真实坏图 | metadata 返回 160x60 PNG；完整像素解码以 `pngload_buffer: libspng read error` 失败。 | observed |
| `packages/opencode/src/image/image.ts` | 当前统一 normalize owner；在 metadata 后、尺寸与字节达标时直接 `return input`，没有像素解码。 | observed |
| `packages/opencode/src/tool/read.ts` | `read` 以 4096-byte sample 做 magic sniff，图片调用 `Image.normalize(..., { tokenBudget: 1600 })`；normalize error 当前使 tool 失败。 | observed |
| `packages/opencode/src/util/media.ts` | 已有 PNG/JPEG/GIF/BMP/WebP magic sniff；PNG 只看 signature，BMP 只看 `BM`。 | observed |
| `packages/opencode/src/session/prompt.ts` | 用户 file part 在 `updateMessage/updatePart` 前统一 normalize；任一错误当前终止 prompt，不落半条消息。 | observed |
| `packages/opencode/src/session/processor.ts` | 任意 tool-result image attachment 在完成/落库前统一 normalize；失败图片已经移除并追加 omitted 文本，整轮继续。 | observed |
| `packages/opencode/src/session/message-v2.ts` | 已落库 file/tool attachments 直接转换成模型 media；它是 consumer，不是 raw-image processing owner。 | reachable |
| `packages/opencode/script/migrate-image-attachment.ts` | 历史顶层和 tool 图片复用 `Image.normalize`；DecodeError 可移除旧 tool 坏图，preview 默认只读。 | observed |
| `packages/opencode/src/config/attachment.ts` | 现有 `auto_resize/max_width/max_height/max_base64_bytes` 是必须保持的阈值 contract。 | contracted |
| `packages/opencode/script/build.ts` | Sharp native addon/libvips 按 target 嵌入并有 compiled `Image.Service` smoke；当前 smoke 强制 resize/encode。 | observed |
| `patches/@silvia-odwyer%2Fphoton-node@0.3.4.patch` | Photon loader 已支持 `globalThis.__OPENCODE_PHOTON_WASM_PATH`；历史实现通过 `type: file` 静态导入 WASM。 | observed |
| `git show edae95237e^:packages/opencode/src/image/image.ts` | 证明当前仓库曾以静态 WASM asset + cached dynamic import 在 production 使用 Photon，并正确 free decoded image。 | observed |
| Sharp / Photon benchmark | 3.75MB fixture full decode：Sharp 20.7ms、Photon 59.0ms；2.69MB large fixture：Sharp 51-54ms、Photon 93-141ms。 | observed |
| Tiny BMP probe | 当前 Sharp 构建报告 unsupported image format；Photon 成功 decode 1x1 BMP 并输出合法 PNG。 | observed |
| `packages/opencode/test/image/image.test.ts` | 已锁定 PNG/JPEG/WebP 正常输入、pass-through、token budget、尺寸/字节限制和 typed SizeError。 | observed |
| `packages/opencode/test/tool/read.test.ts` | 已锁定 read 图片、magic 内容识别、坏 JPEG、无 resizer fail-closed、large image 和历史迁移。 | observed |
| `packages/opencode/test/session/prompt.test.ts` | 已锁定 resizer unavailable 时不落半条消息，以及正常图片 token preflight。 | observed |
| 基线命令 | Image tests 6/6；read 图片/迁移筛选 7/7；prompt 图片筛选在 `--timeout 30000` 下 2/2。 | observed |
| R2 plan audit `ses_075558eb4ffeVCiWNOF7942Cl7` | ReadTool 的封闭 MIME set 绕过 TIFF/AVIF/SVG；成功 read attachment 在 SessionProcessor 中会第二次 full decode。 | observed/reachable |

## 5. Current Behavior

```text
本地文件 / clipboard / API file part / tool attachment
  -> ReadTool magic sniff 或 SessionPrompt resolved FilePart
  -> Image.normalize(data URL)
  -> Sharp metadata()
  -> 达到尺寸和 base64 阈值
  -> 原 bytes 未经像素解码即 pass-through
  -> SessionPrompt / SessionProcessor 持久化
  -> MessageV2 转换 media
  -> provider 严格解码
  -> 坏 PNG 400 Invalid PNG image
```

当前有四个调用 `Image.normalize` 的真实入口：用户消息入库、read tool、任意 tool-result 入库和显式历史迁移。前三个是在线 producer，迁移脚本是 persisted-data maintenance。内置 read 的成功 attachment 当前先按 1600-token budget normalize，再被 SessionProcessor 以默认 budget normalize；metadata fast-path 下成本很小，full-decode 修复后会对同一 bytes 解码两次。`MessageV2` 和 provider transform 只消费已规范化附件，不拥有原始字节解码。

## 6. Supported Input Domain and Reachability

| Input or condition | Producer | Upstream guarantees | Reachable path | Owner | Classification |
| --- | --- | --- | --- | --- | --- |
| 合法 PNG/JPEG/GIF/WebP data URL | TUI、API、read、tools | MIME 可能来自 extension/content-type；base64 shape 由 caller 构造或外部输入提供 | prompt/read/processor -> `Image.normalize` | `Image.Service` | observed |
| Sharp 当前可以完整 decode 的其他 `image/*`（例如 SVG、APNG MIME、AVIF、TIFF） | 公共 FilePartInput、plugin/tool attachments、本地 read MIME map | MIME/URL 是开放字符串；当前 ReadTool 封闭 set 会绕过 TIFF/AVIF/SVG | read/prompt/processor -> generic Sharp normalize branch | `ReadTool` classification + `Image.Service` | observed/reachable |
| Sharp 不支持或 bytes 无效的任意非 BMP `image/*` | 同一公共输入 | 无格式白名单或上游 decode 保证 | generic Sharp decode -> typed DecodeError -> caller omission | `Image.Service` + adapters | reachable |
| 有 PNG signature 和 IHDR、但 IDAT 损坏/截断 | SSH/base64 文件传输后由 read 读取 | 只有文件 bytes；没有完整解码保证 | read -> normalize metadata fast-path -> DB -> provider | `Image.Service` | observed |
| 结构有效 BMP | 本地 `.bmp`、扩展名无关但 `BM` magic 的 read 文件、用户 file part | 当前 sniff 只保证 `BM`；不保证 DIB/planes/bpp | read/prompt/processor -> normalize | `Image.Service` | contracted |
| `BM` 开头但 BMP header 无效 | 当前测试 `BM text content`、公共本地文件 seam | 无 | read -> normalize | `Image.Service` | reachable |
| 超尺寸或超 base64 预算的可解码图片 | 用户图片、read token budget、tools | 上游不限制 | normalize -> resize/encode | `Image.Service` | observed |
| 图片处理 backend 不可用 | 发布包缺 native/WASM 或 loader defect | 无 | normalize loader | build smoke + caller error behavior | `Image.Service` / build | reachable |
| 历史已落库坏图 | 当前用户数据库和其他旧 session | 已是 persisted data，可能绕过新 ingress | migration script；若不迁移则 MessageV2 replay | migration script / user-controlled apply | observed |
| PDF | read / prompt | MIME `application/pdf` | 独立 PDF attachment path | existing PDF path | observed，out of scope |
| APNG/动画格式的逐帧语义 | 文件输入 | 当前代码只承诺 Sharp 能 decode 后按现有 bytes/resize 行为处理，没有逐帧 contract | generic Sharp path | unchanged | speculative for special handling |

## 7. Required Invariants

| ID | Behavioral invariant | Evidence | Existing test |
| --- | --- | --- | --- |
| INV-01 | 任何即将被 pass-through、resize、convert 或持久化的新 `image/*` 都必须至少完成一次完整像素解码；metadata 不构成 decode 成功。BMP 由 Photon decode，其他格式由 generic Sharp decode；多页/多帧必须验证全部 pages。 | 用户原文；公共 FilePartInput；真实坏 PNG；Sharp 默认 `pages=1` contract | malformed IDAT/generic tests planned；R5 audit adds later-frame gap |
| INV-02 | 合法且未超阈值的所有 Sharp-decodable 非 BMP `image/*` 在完整 decode 后保持原 MIME、data URL 和 bytes pass-through；BMP 按显式合同转换成 PNG。 | 用户原文；现有 normal behavior；公共 MIME seam | 现有 WebP 有精确 equality；PNG/JPEG/GIF 及 generic 格式缺少精确测试 |
| INV-03 | 图片尺寸、base64、token budget、alpha/quality、`auto_resize` 和 typed SizeError contract 不变。 | 配置 schema；用户要求不破坏阈值 | `image.test.ts` 全部现有 tests；`read.test.ts` large image |
| INV-04 | BMP 先执行 Pi 等价 header 规则和 Photon decode，再规范化为 PNG；无效 BMP 不能作为附件送给 provider。 | 用户原文；Sharp/Photon probes | 当前没有正向 BMP attachment test |
| INV-05 | 内容图片无法 decode/convert/fit 时，read 和直接 user prompt 保存明确 `Image omitted` 文本、不保存该 file attachment，并继续请求；tool-result 维持已有 omit-and-continue。 | 用户原文；Pi behavior；现有 processor behavior | processor 已有；read/prompt 当前相反或覆盖不足 |
| INV-06 | 正常图片落库 schema 和正常 pass-through bytes 不变；坏图片只落 synthetic diagnostic text，不落 undecodable bytes 或半条消息。 | 用户原文；MessageV2 schemas；prompt atomicity test | prompt unavailable test 当前只覆盖全失败无落库 |
| INV-07 | 源码运行和 Bun compiled binary 都必须能走 Sharp PNG/JPEG 路径和 Photon BMP/WASM 路径。 | 用户原文；现有 build native smoke；Photon patch | 当前 build smoke 只走 Sharp PNG |
| INV-08 | 最终代码修改最多 6 个文件，总代码 diff 少于 1200 行，不引入新依赖或 schema/migration。 | 用户原文 | implementation diff / git evidence |
| INV-09 | 内置 ReadTool 的成功图片在真实 Session tool-result 和 Prompt `@image` 文件引用链中只执行一次完整 decode；任意改写后的 attachment 仍由所属 final seam normalize。 | 用户高性能/统一 pipeline 要求；R2/R6 audits；两条 ReadTool consumer paths | 当前没有文件引用组合路径测试 |
| INV-10 | 普通 tool-result、abort direct completion、MCP/provider-executed completion 等所有可持久化 Tool success 都必须先经过同一 attachment prepare/omission seam。 | R4 audit；WebFetch raw image producer；`completeToolCall` direct persistence | 当前没有 abort-image completion test |
| INV-11 | 合法多页图片未超限时保持原 bytes；任何后续 page 损坏都必须在 pass-through/resize/reject 前成为 DecodeError。 | R5 audit；GIF/WebP/TIFF reachable；Sharp constructor default pages=1 | 当前 GIF characterization 只覆盖合法 bytes |

## 8. First Divergence and Root Cause

| Invariant | First divergence | Owning module/interface | Proof |
| --- | --- | --- | --- |
| INV-01 / INV-05 / INV-06 | `Image.normalize` 在 `metadata()` 返回宽高后立即以阈值判断并 `return input`；IDAT 未被解码。 | `src/image/image.ts` / `Image.Interface.normalize` | 真实坏图 metadata 成功、raw decode 失败；同一输入 normalize 原样成功。 |
| INV-04 | read 的 coarse `BM` sniff 后，`SUPPORTED_IMAGE_MIMES` 不含 BMP；即使直达 normalize，当前 Sharp build 不支持 BMP。 | `Image.normalize` supported-format branch；`ReadTool` accepted domain | Sharp BMP probe fail；Photon probe success；`.bmp` 当前测试落入 text。 |
| INV-05 direct prompt | normalize 内容错误直接逸出 `Effect.forEach`，`updateMessage/updatePart` 不运行；没有 diagnostic user part。 | `SessionPrompt.prompt` image ingestion boundary | `prompt.ts:2244-2248`；当前 unavailable test 期望 failure。 |
| INV-05 read | normalize 内容错误直接使 `ReadTool.execute` 失败；没有 text-only tool result。 | `ReadTool` output adapter | `read.ts:637-668`；当前 broken JPEG/no-resizer tests 期望 failure。 |
| INV-07 | Photon package patch 存在，但当前 compiled image smoke 没有执行 BMP/Photon branch。 | `script/build.ts` compiled smoke | 当前 smoke 输入只有 PNG，并只检查 Sharp output metadata。 |
| INV-09 | ReadTool normalize 后返回 attachment，SessionPrompt tool adapter 复制并允许 `tool.execute.after` plugin 修改，SessionProcessor 随后无条件再次 normalize。 | ReadTool output / Session orchestration seam | `read.ts:637-668`; `prompt.ts:1235-1249`; `processor.ts:567-584` |
| INV-10 | abort signal 在 Tool 返回后触发时，Prompt adapter 直接调用 `completeToolCall`；当前函数把 raw `output.attachments` 写入 completed Part，不经过普通 tool-result normalization。 | SessionProcessor common completion/persistence boundary | `prompt.ts:1235-1259`; `processor.ts:297-346`; WebFetch raw image output |
| INV-11 | generic Sharp 构造器默认只读第一页；R5 设计的 raw validation 没有传 `pages:-1`，因此后续帧可绕过。 | `Image.Service.normalize` generic decode | Sharp 0.34.5 constructor contract；reachable GIF/WebP/TIFF |

R1 audit finding `B-01` 还证明了一个计划层分歧：R1 把 Sharp branch 写成 PNG/JPEG/GIF/WebP 白名单，但生产 seam 实际接收任意 `image/*`。R2 将其修正为“BMP 预选 Photon；其余全部进入同一个 generic Sharp decode contract”，不新增按 MIME 枚举的旁路。

R2 audit finding `B-01` 进一步证明 ReadTool 本身仍有封闭 MIME set，导致 TIFF/AVIF/SVG 在进入 Image owner 前绕行；R3 改为所有 `image/*`（仅排除已证明是 MIME false-positive 的 `image/vnd.fastbidsheet`）进入 normalize。R2 finding `B-02` 证明真实 read Session path 会 double decode；R3 用与最终 MIME/URL 绑定、不可持久化的 transient Symbol provenance，让 Processor 只跳过同一已规范化 bytes，plugin 改写会使 proof 自动失效。

R4 audit finding `B-01` 证明 abort-time direct `completeToolCall` 是第二条可持久化 success path。R5 把 attachment normalization/omission 抽成 Processor 内部唯一 `prepareToolOutput`：普通 tool-result 在发布事件前调用，`completeToolCall` 在任何 direct completion 时也调用；prepared Symbol proof 避免同一 output 在普通路径重复 decode，并在最终落库时剥离。

R5 audit finding `B-01` 证明 generic Sharp 默认 `pages=1` 不能兑现“完整 decode”。R6 根据 metadata pages 选择全页 validation：单页保持当前低成本 decode；`pages>1` 使用 `sharp(buffer, { pages: -1 })` 完整 raw decode。多页超限路径先做一次全页 validation，再保持现有首帧 resize/encode 语义；这是多页输入的必要额外成本，不改变合法 in-limit bytes。

R6 audit finding `B-01` 证明 Prompt `@image` 文件引用是 ReadTool 的第二个 consumer：ReadTool 已 normalize，但 final user-part loop 再 normalize。R7 让该 final loop 先验证并消费同一个 MIME/URL-bound proof；proof 匹配时剥离后直接持久化，`chat.message` plugin 改写 MIME/URL 后 proof 失效并重新进入 `Image.normalize`。direct user files 没有 proof，仍完整 normalize。

Downstream `grok-oauth` 的 400 是严格 provider decoder 对坏 bytes 的拒绝，不是 root cause。数据库保存和 base64 编码也不是 first divergence，因为数据库附件 bytes 与本地坏文件逐字一致。

### Red-capable feedback loop

Working directory: `packages/opencode`。

已运行的最小 harness 通过 Photon 生成合法 64x64 PNG，只把首个 IDAT data byte 改为 `0`，再调用真实 `Image.Service.normalize` 三次。命令断言任何 success 都是 RED，并以 exit 1 结束。

Observed output:

```text
RED 1: malformed IDAT passed unchanged=true
RED 2: malformed IDAT passed unchanged=true
RED 3: malformed IDAT passed unchanged=true
exit_code=1
```

原始生产证据 loop 是只读 SQLite 查询：目标 attachment 有 PNG signature、`hasIEND=false`，失败 assistant message 为 status 400 `Invalid PNG image.`、`mediaCount=1`。

## 9. Responsibility and Seam

| Concern | Owner | Interface promise | Why it belongs here | Why another module does not own it |
| --- | --- | --- | --- | --- |
| 原始图片完整 decode、阈值、resize、format conversion | `Image.Service.normalize` | 接收任意 `image/*` data URL FilePart，BMP 用 Photon，其余由 generic Sharp decode；返回 provider-safe FilePart 或 typed error | 所有在线 producer 和迁移已经共用此 seam | read/prompt/processor 不应各自实现 decoder |
| PNG IHDR / BMP header 轻量规则 | `Image.Service` 内部 raw-byte gate | 在昂贵 backend 前拒绝结构明显不成立的已知格式 | direct prompt/tool 可绕过 read sniff，因此不能只放 `ReadTool` | `util/media.ts` 只拥有 read sample MIME sniff，无法保证全量 bytes |
| BMP decode/PNG conversion | `Image.Service` 的 supported-domain BMP branch | BMP 是显式支持输入，输出 provider-safe PNG | 当前 Sharp 不支持，现有 Photon 是唯一已证明 backend | 不能在 read 增加专属 converter，否则 prompt/tool 再次分叉 |
| content failure -> omitted text | read / prompt output adapters；processor 保持现状 | 每个 adapter 决定自己的 tool/user 文本和持久化形态 | Image service 只拥有 typed processing error，不能拥有 MessageV2 展示文案 | provider adapter 太晚，坏 bytes 已落库 |
| read normalized provenance | Image 内部 proof helper；ReadTool 标记；SessionProcessor 验证并剥离 | 只证明同一 MIME/URL 已经过统一 normalize，不保存第二套结果 | 消除已证明的 read double decode，同时让 plugin 改写和任意 Tool 继续受通用 guard | 单靠 tool 名称可被 custom override 混淆，持久字段会污染 schema |
| all Tool success attachment preparation | `SessionProcessor.prepareToolOutput` + `completeToolCall` | 每条可持久化 success 在事件/DB 前得到同一 normalized-or-omitted output | abort direct completion 是真实绕过路径；common completion seam 必须封口 | Prompt/WebFetch/MCP 不拥有通用 attachment persistence |
| native/WASM packaging | `script/build.ts` compiled Image smoke | release binary 必须真实装载同一 production service 和 assets | build 是唯一发布资产 owner | 单元测试只能证明 node_modules 源码运行 |
| 历史坏图改写 | 既有 `migrate-image-attachment.ts` | 默认只读 preview，`--apply` 显式事务改库 | persisted-data maintenance 已有 owner | 在线请求不应每轮重复 decode/改库 |

## 10. Single Approved Primary-Path Design

```text
image FilePart
  -> validate base64 data URL and decode bytes
  -> known-header structural check (PNG signature+IHDR; BMP header/planes/bpp)
  -> format-selected decode
       BMP signature + valid BMP header: Photon -> PNG
       every other image/*: generic Sharp decode (no MIME whitelist)
  -> within limits: exact pass-through (BMP uses converted PNG)
  -> over limits: existing Sharp resize/PNG-or-JPEG candidate policy
  -> normalized FilePart OR typed Image.Error
  -> ReadTool success only: bind transient Symbol proof to final MIME/URL
  -> caller-owned diagnostic text with no attachment; request continues
```

实现继续加深现有 `Image.normalize`，它就是本仓库的统一 `processImage` seam；不新增同义 service/function 或改公共配置。除结构有效 BMP 外，所有公开可达 `image/*` 都进入同一个 generic Sharp branch；没有 PNG/JPEG/GIF/WebP 白名单，因此 SVG、APNG MIME、AVIF、TIFF 等当前 Sharp 能 decode 的输入保持现有 in-limit bytes，不能 decode 的输入得到同一个 typed DecodeError。常见格式继续使用 Sharp，因为实测 full decode 比 Photon 快约 2-3 倍且当前 binary native smoke 已成熟。Photon 只处理已证明 Sharp 不支持、用户明确要求的 BMP domain branch；这不是 Sharp 失败后尝试另一后端，而是在任何 backend 运行前按 `BM` + BMP header 确定的互斥格式分支。

Sharp 路径先读 metadata 以保留当前阈值策略。单页满足 pass-through 时执行一次 raw decode；多页/多帧使用 `pages:-1` 解码全部 pages 后才返回原 part。单页 resize/encode 本身完成 decode，不增加预解码；多页 resize 前先做全页 validation，再保持当前首帧 resize 输出语义。`auto_resize:false` 同样先完成全部可达 pages decode，再返回 SizeError。BMP 使用 cached Photon 完整 decode，取得 PNG bytes；达标直接返回 PNG part，超限再进入同一 Sharp resize policy。

ReadTool 删除封闭的 supported-image set，任何 `image/*` 都进入 Image owner，仅保留仓库已证明应按文本读取的 `image/vnd.fastbidsheet` 例外。它保留 1600-token normalize 和 direct-tool safe output，并在成功 attachment 上添加 enumerable Symbol proof，proof 快照只含最终 MIME/URL。SessionPrompt 的 object spread 会携带 Symbol；tool-result 由 SessionProcessor `prepareToolOutput` 消费 proof，Prompt `@image` 则由 final user-part normalization 消费 proof。两处都只在 snapshot 匹配时跳过 decode并剥离 proof；任何 plugin MIME/URL 改写、无 proof、custom/provider attachment 均重新进入 `Image.normalize`。普通 tool-result 在事件发布前 prepare；`completeToolCall` 对所有 direct completion 也 prepare。Symbol 不进入 JSON、MessageV2 schema 或数据库。

`Image.normalize` 仍返回 typed error。read 和 prompt 各自在自己的 output adapter 写入字面一致的 synthetic `Image omitted` 文本并删除该 attachment；文案不从 `Image` module 导出，避免让 decoder owner 吸收 Message 展示责任。processor 已有相同行为，不改其持久化流程。Omission 不伪造图片成功，模型能看到缺失原因并继续处理同一请求的其余文字/工具输出。

## 11. Secondary and Replacement Path Inventory

| Path | Current or proposed | Classification | Produces success? | Decision-surface share | Disposition |
| --- | --- | --- | --- | --- | --- |
| Sharp decode + in-limit exact bytes | proposed repair of current | contracted pass-through | yes | primary | preserve after full decode |
| Sharp resize/PNG-JPEG candidate loop | current | supported-domain branch | yes | primary | preserve thresholds/quality |
| BMP header + Photon decode -> PNG | proposed | supported-domain branch | yes | primary | add; format-selected, not failure-selected |
| read/prompt omitted text | proposed | diagnostic | no image success | estimated 2 of >=24 modified decisions, <=8.4% | add at owning adapters |
| processor omitted text | current | diagnostic | no image success | unchanged | preserve |
| resizer unavailable typed error inside Image | current | diagnostic error | no | primary error outcome | preserve; build smoke prevents silent release defect |
| provider unsupported-image text replacement | current | existing compatibility | no image success | unchanged | preserve |
| explicit historical migration | current | diagnostic / persisted maintenance | no online success | unchanged | preserve |
| retry Sharp with Photon after failure | rejected | forbidden fallback | would | 0 | do not add |
| verified read attachment proof | proposed | contracted orchestration pass-through | yes, preserves already-normalized result | primary performance path | add; MIME/URL mismatch invalidates proof |
| common prepared Tool output proof | proposed | contracted orchestration pass-through | yes, preserves one prepared output | primary completion path | add; skips only matching MIME/URL and is stripped at persistence |

New alternate success path count: zero. BMP chooses its decoder before either backend runs; no error-triggered backend retry exists.

## 12. Workaround Deletion and Replacement

| Existing workaround or duplicate | Why it existed | Why the approved route supersedes it | Delete or collapse location |
| --- | --- | --- | --- |
| metadata-only “small image is valid” assumption | optimized repeated normalization | full decode is now required before pass-through; keeping it reproduces the provider 400 | replace early `return input` condition in `image.ts` with decode-before-pass-through |
| read 对图片 normalize error 直接抛错 | before omit-and-continue requirement | caller must return text-only diagnostic while preserving permission/file-read errors | collapse only Image processing errors in `read.ts` |
| prompt 对图片 normalize error 终止整条消息 | protected against partial persistence | synthetic diagnostic part preserves atomic one-message persistence without bad attachment | replace image branch in `prompt.ts`; do not catch unrelated prompt errors |
| closed ReadTool image MIME set | previously limited read attachments to common provider formats | public file MIME map proves TIFF/AVIF/SVG are real images and must reach unified owner | replace set with `image/*` gate plus fastbidsheet text exception |
| unconditional Processor re-normalization of built-in read output | protected arbitrary tool attachments | verified transient proof distinguishes unchanged first-party read bytes without trusting tool name | verify/strip proof in `processor.ts`; preserve normalize for every unverified attachment |

The historical migration script, provider compatibility, and processor omission are not workarounds for the first divergence and remain unchanged.

## 13. Forward Traceability

| Requirement or invariant | Production path | Planned file/change | Behavioral test |
| --- | --- | --- | --- |
| INV-01 complete decode | 任意 `image/*` read/prompt/tool -> `Image.normalize` | `src/image/image.ts`: BMP 预选 Photon；其余 generic Sharp；decode before pass-through；resize remains decoding path | malformed-IDAT read/prompt；generic SVG/APNG-MIME prompt；original harness green |
| INV-02 exact normal pass-through | generic Sharp in-limit path | `src/image/image.ts`: return exact input only after decode | read PNG/JPEG/GIF exact byte equality；existing WebP equality；prompt generic `image/*` exact parts |
| INV-03 thresholds/performance | Image metadata routing + existing candidate loop | `src/image/image.ts`: no constant/config/quality change | existing Image + large read tests unchanged; benchmark recorded |
| INV-04 BMP | read accepts BMP -> Image Photon -> PNG | `src/tool/read.ts`, `src/image/image.ts` | read valid BMP returns PNG; invalid `BM` returns omitted text |
| INV-05 omit-and-continue | Image error -> read/prompt adapter; processor current path | `src/tool/read.ts`, `src/session/prompt.ts` | malformed-IDAT and unavailable-backend read/prompt tests |
| INV-06 landing behavior | prompt synthetic text before `updateMessage/updatePart`; read completed output | `src/session/prompt.ts`, `src/tool/read.ts` | prompt persisted parts contain text/no file; read output text/no attachment |
| INV-07 packaging | Image static `type:file` import embeds Photon WASM；existing build keeps Sharp target map/smoke | `src/image/image.ts`; no build-script change | existing single build + temporary compiled Photon BMP smoke using production Image service |
| INV-08 size | exactly six code files, no dependency/schema files | all planned files | `git diff --stat`, `git diff --numstat`, typecheck/build |
| INV-09 one decode on both ReadTool consumer paths | ReadTool normalize+proof -> tool-result Processor or file-reference Prompt final seam -> verify/strip | `src/image/image.ts`, `src/tool/read.ts`, `src/session/processor.ts`, `src/session/prompt.ts` | full Session tool read and real `@image` prompt each succeed with one-shot Image layer；plugin-mutated proof re-normalizes |
| INV-10 every Tool completion prepared | ordinary tool-result + abort direct complete -> common Processor prepare -> persist | `src/session/processor.ts` | abort-time raw malformed image is persisted as omission text/no attachment；ordinary path event and DB share prepared output |
| INV-11 all pages decoded | generic Sharp metadata.pages -> single/all-page validation -> pass-through/resize/error | `src/image/image.ts` | valid two-frame GIF exact bytes；first-frame-valid/later-frame-corrupt GIF omission；multi-page no-resize DecodeError |
| Historical bad attachments | existing explicit migration reuses repaired Image service | no script change | existing migration test plus optional read-only preview on user DB |

## 14. Reverse Traceability

| Proposed production concept | Requirement ID | Evidence | Why existing logic cannot carry it |
| --- | --- | --- | --- |
| generic Sharp pixel-decode gate for every non-BMP `image/*` before pass-through | INV-01/02 | public MIME seam；metadata-success/raw-fail real image and harness | `metadata()` deliberately does not decode pixels；R1 four-format wording omitted reachable inputs |
| PNG IHDR and BMP structural predicates in Image owner | INV-01/04 | user names Pi rules; direct prompt bypasses read sample sniff | current `util/media` checks signature only and is not on every producer path |
| cached Photon BMP loader + PNG conversion | INV-04/07 | Sharp BMP fails; Photon BMP and patched WASM succeed | Sharp cannot carry this accepted format in current binary build |
| read Image-error adaptation | INV-05 | current read throws processing error | Image service cannot construct Tool.Info output/persistence |
| prompt Image-error adaptation | INV-05/06 | current prompt aborts before persistence | Image service cannot construct a synthetic user MessageV2 part |
| temporary compiled Photon/BMP verification harness | INV-07 | runtime WASM loading depends on patched global path | existing permanent Sharp smoke does not execute Photon；file limit forbids unrelated build-script churn |
| transient MIME/URL-bound Symbol proof | INV-09 | observed ReadTool->Processor duplicate chain；plugin mutation seam | tool name is forgeable/overridable；cache adds state；raw skip would weaken arbitrary Tool guard |
| common `prepareToolOutput` before event/persistence | INV-10 | reachable WebFetch/MCP abort direct completion | current ordinary event branch is bypassable；duplicating logic in each adapter would recreate parallel paths |
| Sharp `pages:-1` validation for metadata.pages>1 | INV-01/11 | reachable GIF/WebP/TIFF；Sharp default pages=1 contract；later-frame vector | single-page raw decode cannot validate bytes that will still be passed through |

No new config, dependency, schema, cache, retry, public provider behavior, or migration concept is proposed.

## 15. File-Level Change Plan

Exactly six code files are authorized. The canonical plan itself is documentation and is not counted as a code file.

| File | Add / modify / delete | Exact responsibility of the change | Expected line delta |
| --- | --- | --- | --- |
| `packages/opencode/src/image/image.ts` | modify | generic non-BMP full decode；PNG/BMP structure；cached Photon BMP->PNG；transient normalized proof helpers；preserve Sharp limits/candidates | `+115/-20` |
| `packages/opencode/src/tool/read.ts` | modify | route all real `image/*` except fastbidsheet；Image errors become text-only omission；mark successful normalized attachments | `+32/-12` |
| `packages/opencode/src/session/prompt.ts` | modify | direct user Image errors become synthetic text before atomic persistence | `+18/-5` |
| `packages/opencode/src/session/processor.ts` | modify | common prepare for ordinary/direct completion；verify/strip proof；unverified attachments normalize/omit；events use prepared output | `+48/-24` |
| `packages/opencode/test/tool/read.test.ts` | modify | malformed-IDAT omission；PNG/JPEG/GIF exact byte pass-through；BMP conversion/invalid BMP；unavailable backend text-only result；preserve migration/normal cases | `+82/-18` |
| `packages/opencode/test/session/prompt.test.ts` | modify | malformed-IDAT and unavailable-backend synthetic omission persistence；generic Sharp-decodable SVG/APNG-MIME exact pass-through | `+58/-12` |

No file addition/deletion, package manifest, lockfile, migration, generated file, `util/media.ts`, `script/build.ts`, or `message-v2.ts` change is authorized.

## 16. TDD Behavior Slices

Agreed existing public seams: `ReadTool.execute`, `SessionPrompt.prompt`, persisted `MessageV2` returned by session APIs, and the compiled `Image.Service` smoke. Private helpers and call counts are not test seams.

| Order | Red behavior | Why current code fails | Minimal green behavior | Regression protected |
| --- | --- | --- | --- | --- |
| 1 | read a valid-IHDR PNG with corrupted IDAT; expect text containing `Image omitted`, no attachment, completed tool result | metadata fast-path returns bad attachment | full decode in Image + read Image-error adapter | original Grok 400 producer path |
| 2 | read with mocked unavailable Image backend; expect text-only omission and no attachment | current read propagates backend error | generalize the same Image-error adapter without catching file/permission errors | Pi omit-and-continue for processing failure |
| 3 | submit corrupted-IDAT user file with `noReply`; expect persisted synthetic omission text and no file | repaired Image returns DecodeError, current prompt aborts | prompt adapts only Image errors to text part before save | direct user attachment chain and atomic landing |
| 4 | submit with mocked unavailable Image backend; expect same one-message text-only persistence | current test expects total failure/no messages | use the same prompt adapter for all typed Image errors | package/runtime processing failure remains visible to model/user |
| 5 | read a structurally valid 1x1 BMP; expect `image/png` attachment with PNG magic | BMP not in read accepted set; Sharp cannot decode it | accept BMP and use format-selected Photon conversion in Image owner | explicit Pi BMP requirement |
| 6 | read `BM` text / malformed BMP; expect omission and no attachment | current coarse sniff can classify by magic only | Pi-equivalent BMP header validation before Photon | false-positive BMP magic |
| 7 | read a TIFF/SVG through ReadTool; expect normalized attachment rather than text/binary bypass | current closed set excludes it | route every real `image/*` except fastbidsheet to Image | R2 `B-01` |
| 8 | full Session read with a one-shot Image layer; expect clean persisted attachment instead of second-call omission | Processor calls normalize again | MIME/URL-bound proof survives adapter spread, is verified and stripped | R2 `B-02` double decode |
| 9 | plugin changes marked attachment URL/MIME; expect Processor to normalize/omit it | trusting marker presence alone would bypass guard | proof snapshot must match final MIME/URL | arbitrary plugin/tool safety remains |
| 10 | call public `Image.Service.normalize` with `auto_resize:false`, a low dimension limit, and metadata-readable/corrupt-IDAT PNG; expect `ImageDecodeError`, not `ImageSizeError` | current code returns SizeError from metadata before pixel decode | full decode must precede the no-resize SizeError branch | every accepted image is decoded before rejection |
| 11 | read PNG vectors with first chunk length !=13 or type !=IHDR; expect omission/no attachment | current sample sniff only sees PNG signature | Image raw-byte gate rejects before Sharp route | explicit Pi PNG IHDR contract |
| 12 | read valid 1x1 BMP mutated to declared-size=1 and pixel-offset=10; expect omission/no attachment even though Photon probe accepts both | relying on Photon alone would return PNG | Pi-equivalent BMP declared-size/offset validation | explicit BMP structure contract |
| 13 | abort-time Tool completion returns malformed raw image; expect completed persisted output with omission text and no attachment | direct `completeToolCall` currently writes attachment unchanged | `completeToolCall` invokes common prepare before persistence | R4 abort bypass finding |
| 14 | ordinary tool-result publishes EventV2 and persists the same prepared output | moving prepare only into persistence could expose raw event content | ordinary branch calls common prepare before event, proof prevents repeat in complete | event/DB parity |
| 15 | valid two-frame GIF remains byte-exact; same GIF with byte 89 corrupted has first frame readable but `pages:-1` failure and must be omitted | default Sharp page 1 can accept the corrupt vector | metadata.pages>1 selects all-page raw validation | complete multi-frame decode contract |
| 16 | corrupt-later-page GIF with `auto_resize:false` and low threshold returns DecodeError rather than SizeError | metadata-only threshold branch can reject before all-page decode | all-page validation precedes no-resize rejection | multi-page decode ordering |
| 17 | submit a real Prompt `@image` file reference with a one-shot Image layer; expect clean persisted attachment rather than second-call omission | ReadTool normalizes, final user-part loop normalizes again | final loop verifies/strips matching proof before normalize | R6 duplicate-decode finding |
| 18 | `chat.message` plugin changes a file-reference MIME/URL after ReadTool; expect proof invalidation and Image omission/re-normalization | trusting proof presence would bypass plugin mutation | final loop compares proof snapshot to final values | Prompt plugin safety |

Each slice is run red before its minimal change and green immediately after. The malformed test mutates a known-good PNG IDAT byte; expected behavior is a literal text/no-attachment contract and does not reproduce production decoder logic.

在 Slice 1 前先加入并运行 characterization regressions：小 PNG、JPEG、GIF 经 `ReadTool.execute` 后的 MIME 与 decoded data URL bytes 必须逐字等于 fixture；小 WebP 保留现有 `Image.normalize(input) === input` 断言；direct prompt 中合法 SVG 和以 `image/apng` 声明的合法 PNG 必须保存原 MIME/URL。它们在修复前应为 green baseline，实施后再次运行，用独立输入 bytes 锁定 R1 audit finding `B-02` 指出的 pass-through contract。generic non-BMP 只用代表性 SVG/APNG-MIME 覆盖同一无白名单代码路径，不为每个 Sharp codec 复制一套测试。

Slice 10 使用 `Image.Service.normalize` 公共 Effect seam，但仍放在已授权的 `test/session/prompt.test.ts`，避免增加第七个代码文件。fixture 的 threshold、corrupt IDAT 和期望 error tag 都是独立字面值。Slice 12 特意采用实测 Photon 会接受的 malformed BMP，因此删除 header predicate、只依赖 Photon 的实现会使测试失败；PNG vectors 则锁定用户明示的首 chunk contract，并与合法-IHDR/corrupt-IDAT 用例分离。

## 17. Chinese Comment Budget

| Metric | Estimate | Method |
| --- | --- | --- |
| Effective changed code lines `E` | about 265 | Exclude imports, formatting, plan docs, generated files, comment-only lines, and pure moves |
| Required Chinese explanatory comments `C` | at least 40 | `ceil(265 * 0.15) = 40`; implementation must recalculate actual E/C and meet the actual ceiling |

Qualifying comments will be distributed next to:

- metadata 与完整像素 decode 的不变量，以及为什么 pass-through 前的 raw decode 不可删除；
- generic Sharp branch 必须覆盖所有非 BMP `image/*`，不得退化成常见 MIME 白名单；
- resize/encode 已经执行 decode，避免为了“全解码”再重复做一次；
- PNG IHDR/BMP header 只是廉价结构 gate，不能替代 backend decode；
- BMP 是输入格式分支而非 Sharp 失败后的 fallback；
- Photon WASM global path 必须在 dynamic import 前设置；
- Photon image 的 `free()` cleanup 约束；
- read/prompt omitted 文本不等于图片处理成功，只保留其余请求；
- prompt diagnostic part 必须在原有 atomic persistence boundary 内生成；
- build smoke 必须走 production `Image.Service`，不能用裸 backend 掩盖 loader 接线；
- malformed-IDAT fixture 的测试意图：metadata 可读但像素不可读；
- BMP fixture 的 DIB/planes/bpp 独立预期和 provider-safe PNG 结果；
- unavailable backend 测试锁定“可观察文本 + 无 attachment”，不依赖内部调用次数。
- transient proof 必须绑定 MIME/URL 并在落库前删除，不能信任 tool 名称或污染 MessageV2；
- one-shot Session 测试锁定可观察 attachment 结果，不直接断言 normalize 调用次数。
- `auto_resize:false` 测试必须区分 DecodeError 与 metadata-only SizeError，锁定 decode 顺序；
- BMP malformed vectors 选择 Photon 实测会接受的字段值，测试意图是区分 header owner 与 backend；
- PNG 首 chunk vectors 独立锁定 length/type contract，不与 IDAT corruption 混成一个断言。
- abort test 必须命中 `completeToolCall` direct path，不以普通 tool-result 测试冒充；
- ordinary event/DB 测试锁定同一个 prepared snapshot，避免修复 abort 时产生第二套语义。
- multi-frame fixture 使用已记录的 95-byte two-frame GIF；只改 byte 89 后 default page decode 成功、`pages:-1` 失败，能区分首帧与全页实现；
- 合法 multi-frame pass-through 必须逐字相等，不能以“验证完整性”为由重编码正常动画。

无意义流程翻译、重复测试名、集中堆注释均不计数。

## 18. Verification

| Command | Working directory | Evidence produced |
| --- | --- | --- |
| malformed-IDAT `bun -e` feedback harness（Section 8 同一命令） | `packages/opencode` | 修复前 exit 1 / 三次 RED；修复后 ImageDecodeError / exit 0 |
| `bun test --timeout 30000 test/tool/read.test.ts -t "image|attachment media|BMP|image attachment migration"` | `packages/opencode` | read 正常/坏图/BMP/large/migration behavior |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "image|resizer is unavailable|preflight estimates image"` | `packages/opencode` | prompt omitted persistence、正常图片和 token accounting |
| `bun test --timeout 30000 test/image/image.test.ts` | `packages/opencode` | pass-through、尺寸/字节/token budget、alpha/format、typed SizeError 不回归 |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "image attachment"` | `packages/opencode` | 任意 tool-result 仍 omit-and-continue |
| `bun test --timeout 30000 test/session/message-v2.test.ts -t "attachments|media"` | `packages/opencode` | 落库附件转换到 provider messages 不回归 |
| `bun typecheck` | `packages/opencode` | package-local types 和 Effect unions 正确 |
| `bun run script/build.ts --single --skip-install --skip-embed-web-ui` | `packages/opencode` | 当前 Windows target build 和现有 production Sharp native/Image resize smoke；静态 Photon WASM 进入 build graph |
| temporary `Bun.build({ compile })` Photon BMP harness，直接 import production `Image.Service` 后执行 BMP normalize | `packages/opencode`，artifact 仅写 `D:\Temp\opencode` | compiled executable 真实装载 patched Photon WASM 并输出 PNG；不改 build script，不把 temp artifact 计入 repo diff |
| `bun script/migrate-image-attachment.ts C:\Users\Lenovo\.local\share\opencode\opencode.db`（只读 preview） | `packages/opencode` | 修复后的统一 decoder 能识别真实历史坏 tool attachment；不改数据库 |
| `git diff --check` | repository root | whitespace / conflict marker hygiene |
| `git diff --numstat -- <six code paths>` | repository root | 六个 code files、总代码行数 `<1200`、E/C calculation evidence |
| implementation audit APPROVE 后按 GOAL commit protocol 检查 status/diff/log，使用 `git commit --only -- <goal paths>` 创建中文多行 commit，再检查 status | repository root | verified implementation 被单独提交；不 amend、不跳 hook、不 push |

若全库迁移 preview 因 1.47GB 数据库耗时无法在验证窗口完成，必须记录为未验证项；不能以 narrow unit test 冒充该全库结果。用户没有授权 `--apply`，禁止写数据库。

## 19. Diff Budget

| Metric | Estimate | Justification |
| --- | --- | --- |
| Files added | 1 documentation plan | canonical artifact only |
| Code files modified | exactly 6 | user hard limit; listed in Section 15 |
| Files deleted | 0 | no replacement module or migration |
| Production lines | about `+189/-45` | one deepened service, read/prompt adapters, processor provenance guard |
| Test lines | about `+140/-30` | two behavioral test files only；增加 exact pass-through characterization |
| Total code diff | comfortably `<1200` | expected gross changed lines below 400 |
| Generated lines | 0 | no schema/API generation |

The budget cannot be used to omit a confirmed behavior. Any seventh code file or production behavior beyond this table requires a substantive R3 revision and full plan re-audit.

## 20. Real Risks and Open Decisions

### Real Risks

| Risk | Evidence | Planned control |
| --- | --- | --- |
| Full decode makes in-limit images slower than metadata-only | measured metadata 1-7ms vs Sharp full decode 20-54ms on large fixtures | use faster Sharp for common formats; only one decode on pass-through, and resize path does not predecode twice |
| Full raw pass-through validation allocates decoded pixels | max accepted pass-through dimensions default 2000x2000; Sharp has its own input pixel guard | validate at Image owner; preserve thresholds; do not introduce unbounded cache |
| 多页全量 validation 比默认首帧更耗 CPU/内存 | GIF/WebP/TIFF 是明确 reachable，完整 decode 是用户 contract | 仅 metadata.pages>1 启用 `pages:-1`；单页和现有 resize fast path不增加该成本 |
| Photon WASM missing in compiled binary | loader reads a file path at module init | static `type:file` import + patched global path + temporary compiled production-Service BMP smoke |
| BMP false-positive on `BM` text | current sniff checks only two bytes | apply Pi-equivalent file size/offset/DIB/planes/bpp rules before Photon |
| Omission could hide a broken release backend | processing error becomes visible text rather than silent drop | compiled smoke is release blocker; diagnostic text is persisted and attachment absent |
| Existing corrupt DB rows remain until migration apply | real target row already persisted | repaired read-only preview identifies it; no automatic or unauthorized DB write |

### Open Decisions Requiring the User

用户授权原文（2026-07-23）：`授权 R7 + 1 轮（Recommended）`。该原文明确覆盖本 GOAL 的 6 轮 plan-audit 上限并授权 R7 后额外 1 轮 full-scope plan audit；该轮已由审计 invocation `ses_074d73673ffeZwKXiyL9LEW3cp` 消耗。用户仍未授权 migration `--apply` 或 push。

R7 行为设计在该轮获得 `Primary-path/fallback 设计判定：PASS`，但 auditor 因授权原文当时未写入 canonical plan 而保持 BLOCK。继续复审需要用户再明确授权 1 轮；未授权前 implementation 仍为 `no`。

用户最终 override 原文：`用户override放行那些文书问题，审计的实质性问题不存在之后适当修改即可进行下一步   不重复进行审计`。该指令明确把 R7 唯一剩余的文书/轮次 finding 作为非阻塞并禁止重复 plan audit；R7 据此获得用户例外批准。行为审计原文仍保留：`Primary-path/fallback 设计判定：PASS`，不得将此 override 扩张到任何实施期实质性 finding。

### Rejected Speculation

- **检查 `IEND` 即可**：拒绝。真实故障和 malformed-IDAT harness 证明像素流可在合法头部/尾部形态之外损坏；decoder 才是 owner。
- **所有格式改用 Photon**：拒绝。当前 benchmark 对两个大图都显示 Photon 明显慢于 Sharp，且 current Sharp thresholds/alpha policy 已有回归覆盖。
- **Sharp 失败后再试 Photon**：拒绝。这是 forbidden fallback；Photon 只允许在预先识别的 BMP domain branch 使用。
- **自写 BMP pixel decoder**：拒绝。现有 Photon 已证明支持且打包 patch 已存在；自写实现会扩大格式兼容和测试面。
- **每次 provider 请求重解码历史 media**：拒绝。新 ingress 和显式 migration 已有 owner；request-time 重复工作破坏高性能且形成下游 workaround。
- **本次拒绝 APNG/动画 GIF 或为其新增专属算法**：拒绝。generic Sharp contract 保持当前能 decode 的输入与 exact in-limit bytes；没有证据支持逐帧策略或格式特判。
- **新增图片 cache/worker/semaphore**：拒绝。没有并发或延迟故障证据，不能由 speculative performance concern 驱动。

## 21. Audit Contract

The independent auditor must:

- Read this exact file and the original requirement.
- Reconstruct behavior from repository evidence.
- Treat builder summaries as untrusted.
- Audit the complete original scope on every round.
- Require evidence for every blocking finding.
- Check both under-design and over-design.
- Check root-cause repair, fallback, ownership, tests, code quality, and the 15 percent Chinese explanatory-comment plan.
- Check that the plan modifies no more than six code files and keeps gross code changes below 1200 lines.
- Check that Sharp/Photon selection is format-based, never failure-based.

## 22. Plan Audit Record

| Round | Audited revision | Full scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R1 | yes | `B-01 统一图片链路未覆盖当前可达的完整 image/* 输入域`; `B-02 pass-through 回归测试无法锁定 PNG、JPEG 和 GIF 的原字节保持合同` | `Canonical metadata 写的是 Audit mode: full-scope，而本次输入和技能定义的模式是 plan。`; `Section 9 将 omission 文案归属于 read/prompt adapters，但 Section 15 又计划从 image.ts 导出固定 omission 文本。` | **BLOCK — Revision R1** | `ses_0755d0cfcffeADmzhF4cY4lmLo` |
| 2 | R2 | yes | `B-01 ReadTool 仍绕过部分可达的 image/* 输入`; `B-02 ReadTool 的真实 Session 链路会执行两次完整像素解码` | None. | **BLOCK — Revision R2** | `ses_075558eb4ffeVCiWNOF7942Cl7` |
| 3 | R3 | yes | `B-01 auto_resize:false 路径缺少“先完整解码”的敏感验证`; `B-02 Pi 的 PNG IHDR 与 BMP 结构规则缺少可区分实现的行为测试` | `verified-implementation-and-commit 已记录，但最终验证表没有明确列出实施审计通过后创建 commit 并检查状态的收尾步骤。`; `Section 6 把在线 Image.normalize 入口概括为四个；webfetch、MCP 和其他 Tools 实际经 SessionProcessor 汇入同一入口，因此总体调用链结论成立。` | **BLOCK — Revision R3** | `ses_07542bc54ffebsxgK40KVDa6xE` |
| 4 | R4 | yes | `B-01 abort completion path can persist unprocessed Tool images` | None. | **BLOCK — Revision R4.** | `ses_0753b547effesz9UhAzZMoOiL5` |
| 5 | R5 | yes | `B-01 多帧图片没有保证完整像素解码` | None. | **BLOCK — Revision R5，full-scope plan audit round 5。** | `ses_075312e6cffe85IJGOM4AWYKsR` |
| 6 | R6 | yes | `B-01 文件引用图片仍会执行两次完整解码` | None. | **BLOCK — Revision R6，full-scope plan audit round 6。** | `ses_075294c11ffe6xyru26JzwGs7I` |
| 7 | R7 | yes | `B-01 R7 已超过计划审计轮次上限，且缺少有效的用户例外授权原文` | `@image 文件引用的失败组合路径可能产生两条 omission 文本。`; `Processor 现有 omission 文案对非 size error 的诊断原因可能不准确。` | **BLOCK — Revision R7。** | `ses_074d73673ffeZwKXiyL9LEW3cp` |

R2 resolves `B-01` by defining one generic Sharp contract for every reachable non-BMP `image/*`, with representative direct-prompt pass-through and invalid-input coverage. R2 resolves `B-02` by adding exact MIME/data-URL byte assertions for PNG, JPEG, GIF and generic Sharp-decodable inputs while preserving the existing WebP equality assertion. R2 also applies both non-blocking record corrections: metadata now says `Audit mode: plan`, and omission wording remains owned by read/prompt adapters rather than exported by `Image`.

R3 resolves R2 `B-01` by replacing ReadTool's closed image set with an `image/*` gate plus the observed fastbidsheet text exception and a TIFF/SVG read behavior slice. R3 resolves R2 `B-02` with MIME/URL-bound transient Symbol provenance, a full Session one-shot Image test, and a plugin-mutation invalidation test; arbitrary Tool attachments remain normalized by SessionProcessor.

R4 resolves R3 `B-01` with a public Image seam test that requires DecodeError before the `auto_resize:false` SizeError branch. R4 resolves R3 `B-02` with independent PNG first-chunk vectors and BMP declared-size/pixel-offset vectors that Photon is observed to accept. R4 also records the required post-audit commit/status sequence.

R5 resolves R4 `B-01` by making `SessionProcessor.prepareToolOutput` the common attachment boundary used by ordinary tool-result before event publication and by every direct `completeToolCall` before persistence, with abort-time malformed-image and event/DB parity tests.

R6 resolves R5 `B-01` by using Sharp all-page validation when metadata reports multiple pages and by adding a deterministic two-frame GIF whose first page decodes but byte-89 corruption makes `pages:-1` fail, plus exact valid-animation pass-through and no-resize ordering tests.

R6 audit finding `B-01` remains unresolved at the six-round plan-audit limit. It is recorded as an Open Decision in Section 20; approval and implementation remain prohibited.

The user explicitly authorized R7 plus one additional full-scope plan audit. R7 resolves R6 `B-01` by consuming the same MIME/URL-bound proof in SessionPrompt's final user-part normalization and adds real file-reference one-shot and plugin-mutation tests.

Any substantive revision invalidates earlier approval.

The orchestrating primary agent must copy the independent verdict without
paraphrasing. A clean verdict may update only the administrative approval fields
for the exact audited revision. It must not be combined with a design change.

## 23. Implementation Evidence

Complete only after implementation.

### Actual Files and Diff

Modified exactly these six code files: `src/image/image.ts`, `src/tool/read.ts`, `src/session/prompt.ts`, `src/session/processor.ts`, `test/tool/read.test.ts`, and `test/session/prompt.test.ts`. No new dependency, schema, migration, or build-script change was made for the image pipeline. The worktree also contains unrelated pre-existing/build-generated changes; they are excluded from this implementation path.

### Red-Green Test Evidence

RED: the malformed-IDAT harness previously passed the damaged PNG unchanged three consecutive times and exited 1. GREEN: after the Image owner change, the same class of corruption produces `ImageDecodeError`/omission; the new ReadTool IDAT test passes. Direct Prompt malformed-image persistence, disabled-resize decode ordering, one-shot proof reuse, and proof invalidation tests all pass.

### Verification Commands and Results

| Command | Result |
| --- | --- |
| `bun test --timeout 30000 test/tool/read.test.ts` | 82 pass, 0 fail |
| `bun test --timeout 30000 test/session/prompt.test.ts -t "image|Image|resizer|preflight estimates|direct tool completion|same prepared ordinary|file-reference proof|chat.message plugin"` | 7 pass, 0 fail |
| `bun test --timeout 30000 test/session/processor-effect.test.ts -t "image attachment|tool-result|abort"` | 4 pass, 0 fail |
| `bun test --timeout 30000 test/session/message-v2.test.ts -t "attachments|media"` | 3 pass, 0 fail |
| `bun test test/image/image.test.ts` | 6 pass, 0 fail |
| `bun typecheck` | pass |
| `bun run script/build.ts --single --skip-install --skip-embed-web-ui` | Windows x64 build and `--version` smoke pass; final executable SHA-256 `296b4826404398afa320eb92714e5e9597a145b577273ade70c9bf00caf99be2` |
| temporary compiled production-`Image.Service` BMP harness | pass outside repository bunfig: `compiled Photon BMP smoke passed`; temporary source deleted with explicit user authorization |
| `git diff --check` | pass |
| read-only migration preview | blocked by an existing database row with a non-base64 image URL; no `--apply` was used and no DB write occurred |
| full `test/session/prompt.test.ts` | not clean: two unrelated reviewer-outage/timeout cases failed with HTTP 503 and dangling-process timeout; image-focused subset is green |

### Original Feedback-Loop Result

The original feedback loop is preserved: the investigated attachment had a valid PNG signature but a damaged/truncated compressed stream; `sharp.metadata()` succeeded while raw pixel decode failed. The production path now rejects it before pass-through and Read/Prompt adapters persist bounded `Image omitted` text instead of forwarding the bytes.

### Actual Secondary and Replacement Path Inventory

| Path | Current behavior |
| --- | --- |
| ReadTool image file | all real `image/*` except `image/vnd.fastbidsheet` enter `Image.normalize`; typed failure becomes omission text |
| Direct Prompt image | proof mismatch or absent proof enters `Image.normalize`; typed failure becomes a text part |
| Prompt file-reference/ReadTool handoff | MIME/URL-bound transient proof is consumed once; plugin URL/MIME mutation invalidates it |
| Ordinary tool-result | `prepareToolOutput` runs before event publication and completion; event/DB share the prepared snapshot |
| Abort/direct completion | `completeToolCall` prepares unprepared output through the same boundary |
| BMP | valid structural header selects Photon before decode; Photon output enters the common Sharp resize/quality contract; malformed header is omitted, with no decoder fallback |
| Non-BMP image | Sharp full pixel decode, including all pages when metadata reports multiple pages; only then exact in-limit pass-through |

### Chinese Comment Calculation

| Metric | Actual | Exclusions and evidence |
| --- | --- | --- |
| Effective changed code lines `E` | 575 | independent audit calculation; import-only, blank, generated, formatter-only, comment, and unrelated lines excluded |
| Qualifying Chinese comment lines `C` | 90 | independent audit calculation after synthetic-omission and packaging corrections |
| Ratio `C / E` | 15.65% | `90 / 575` |
| Required minimum `C` | 87 | `ceil(575 * 0.15)` |

### Remaining Unverified Items

The full historical migration preview remains blocked by an existing non-base64 database row and stopped safely without writes. The full prompt suite retains unrelated reviewer outage/timeout failures described above. Compiled Photon execution and the final Windows production build are verified.

## 24. Implementation Audit Record

| Round | Plan revision | Full original scope? | Blocking findings | Non-blocking findings | Result | Invocation reference |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | R7 | yes | `B-01 resize paths perform an unnecessary full decode before resizing`; `B-02 approved Pi-style BMP structural gate is incomplete`; `B-03 required R7 behaviorally sensitive tests were not implemented`; `B-04 new common Tool-output boundary introduces any`; `B-05 Chinese explanatory-comment hard gate fails` | Six-file and then-current 943-line budget passed; focused tests/typecheck/build/compiled Photon smoke passed; full Prompt failures were unrelated | **BLOCK — approved R7 implementation cannot be released.** | `ses_074a49994ffePrT0Lnh3HJu4Uy` |
| 2 | R7 | yes | `B-01 ReadTool still bypasses the unified image decoder for SVG` | Exact diff/comment/build certification unavailable because auditor did not run requested shell commands; no additional source-level blockers | **BLOCK** | `ses_0747399f3ffenM4JGAzvOukkil` |
| 3 | R7 | yes | `B-01 Prompt omission is persisted as user-authored text`; `B-02 implementation exceeds the hard 1,200-line gross diff budget`; `B-03 compiled Photon execution remains unverified` | Primary/fallback architecture and Chinese comment gate passed (`E=566`, `C=88`, required 85); focused tests/typecheck/Windows Sharp build passed | **BLOCK — approved R7 implementation cannot be released.** | `ses_0746ef616ffe38gp1SE1whCc2R` |
| 3 continuation | R7 | yes | `B-01 six-file diff still contains unrelated formatting churn and fails repository formatting` | All behavior, 1,184-line budget, E/C, packaging, tests, and primary/fallback architecture passed | **BLOCK — behavior complete; formatter-only cleanup required.** | `ses_0746ef616ffe38gp1SE1whCc2R` |
| 3 final continuation | R7 | yes | `B-01 five formatter-only hunks remain in image.ts` | All behavior, packaging, tests, E/C, six-file scope, 810-line budget, typecheck, and primary/fallback gates independently passed | **BLOCK only on five exact formatter-only hunks.** | `ses_0746ef616ffe38gp1SE1whCc2R` |
| User override release | R7 | yes | none remaining | The five exact `image.ts` wrapping hunks at former lines 279, 301, 316, 443, and 451 were restored to HEAD; `git diff --unified=0` now contains only R7 image behavior. User explicitly prohibited repeated audit for non-substantive documentation/procedure findings after substantive findings are gone. Final raw diff is 719 additions + 64 deletions = 783. | **VERIFIED by explicit user override after all independently identified substantive gates passed and the sole formatting finding was directly removed.** | user override recorded in Section 20 |

The task may be marked `verified` only after an independent full-scope result of
`No blocking findings` for the current implementation and approved plan
revision.
