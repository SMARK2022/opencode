# 图片读取、处理与入库统一化实现方案

状态：Draft

目标：在不做数据库迁移、不重写 TUI、不新增大抽象的前提下，收敛当前图片处理入口，降低重复处理和大图延迟，让 `read` 工具、用户粘贴图片、路径图片和 tool-result 图片复用同一套图片规整逻辑。

## 1. 需要阅读和确认的现有文件

| 类型 | 文件 | 需要确认的点 |
| --- | --- | --- |
| 图片附件服务 | `packages/opencode/src/image/image.ts` | `Image.Service.normalize` 是用户消息和工具结果入库前的图片规整 seam，应作为本次主切入点 |
| 图片 MIME 工具 | `packages/opencode/src/util/media.ts` | `read` 独占的 `processImageWithTokenBudget` 与 `Image.normalize` 重复，应收敛 |
| `read` 工具 | `packages/opencode/src/tool/read.ts` | 图片/PDF 分支、权限检查、MIME sniff、binary fallback 必须保持 |
| TUI 粘贴 | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | TUI 当前只负责收集图片、PDF 和占位符，本次不重写 UI 流程 |
| 剪贴板读取 | `packages/opencode/src/cli/cmd/tui/util/clipboard.ts` | 平台剪贴板读取逻辑已有，不应改平台命令或权限面 |
| 用户消息入库 | `packages/opencode/src/session/prompt.ts` | `resolvedParts` 入库前调用 `image.normalize`，这是保留的用户图片入库边界 |
| 工具结果入库 | `packages/opencode/src/session/processor.ts` | tool-result attachments 入库前调用 `image.normalize`，失败时已有 omitted 文本 |
| 模型消息转换 | `packages/opencode/src/session/message-v2.ts` | provider-specific tool-result media 兼容逻辑必须保持 |
| provider 能力兜底 | `packages/opencode/src/provider/transform.ts` | `capabilities.input.image` 不支持时替换为错误文本，继续作为最后安全网 |
| token 估算 | `packages/opencode/src/token/estimate.ts` | 当前图片按 base64 payload 估算，本次不替换为完整 vision tile estimator |
| 配置 schema | `packages/opencode/src/config/attachment.ts` | 已有 `attachment.image` 配置，本次不新增配置项 |
| 依赖 | `packages/opencode/package.json` | `sharp` 和 `@silvia-odwyer/photon-node` 已存在，不新增依赖 |
| 图片测试 | `packages/opencode/test/image/image.test.ts` | 主测试落点，覆盖 normalize 行为 |
| `read` 测试 | `packages/opencode/test/tool/read.test.ts` | 覆盖图片 read、MIME sniff、large image |
| message 转换测试 | `packages/opencode/test/session/message-v2.test.ts` | 保证 tool-result media 转模型消息行为不退化 |
| TUI 提交测试 | `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | 本次默认不改 TUI，但可作为回归验证 |

当前仓库未发现相关 `CONTEXT.md` 或 `docs/adr/**/*.md`，本次方案不依赖 ADR 变更。

## 2. 当前职责边界和必须保持的既有行为

| Module | 当前职责 | 必须保持的行为 |
| --- | --- | --- |
| TUI prompt | 收集用户输入、图片/PDF 占位符和 file part | `[Image N]`、`[PDF N]` 占位符行为不变 |
| Clipboard util | 从系统剪贴板取 text/image | 不改平台命令，不扩大权限面 |
| `SessionPrompt.createUserMessage` | 把 prompt parts 解析成持久化 message parts | text/plain 文件展开、目录 read、file URL read 行为不变 |
| `Image.Service` | 入库前规整 image file part | 保持 data URL 输入输出、typed errors、`attachment.image` 配置语义 |
| `ReadTool` | 读取文件/目录，图片/PDF 返回 attachments | 保持外部目录权限、read 权限、PDF 原样 attachment、binary 文件拒绝 |
| `SessionProcessor` | 处理 tool-result，规范化 attachments 后落库 | 保持 resize 失败时 omitted 文本，不让坏图片破坏整轮工具结果 |
| `MessageV2.toModelMessagesEffect` | 把持久化 message parts 转成 AI SDK `ModelMessage` | 保持 provider-specific tool-result media 兼容逻辑 |
| `ProviderTransform` | provider 请求前最终清理/能力兜底 | 保持不支持 image 时转错误文本，避免 provider 硬失败 |
| `TokenEstimate` | 估算上下文和附件成本 | 本次不替换为完整 vision tile estimator，只保持不回归 |

必须保持的用户可见行为：

| 行为 | 保持方式 |
| --- | --- |
| 小图片能快速被发送 | normalize fast path 返回原 part |
| 大图片会被缩小到模型可接受范围 | 仍受 `attachment.image` 限制 |
| `read` 能读取 JPG/PNG/WebP/GIF 和 PDF | `read.ts` 图片/PDF 分支不删除 |
| 模型不支持图片时不会真实发送图片 | `ProviderTransform.unsupportedParts` 继续兜底 |
| 图片处理失败不会静默丢失错误 | 保持 `Image.SizeError`、`DecodeError`、omitted 文本 |
| 不新增数据库迁移 | 继续使用现有 `MessageV2.FilePart.url` data URL 存储 |

## 3. 推荐的最小实现方案

推荐方案：以现有 `Image.Service.normalize` 为唯一图片规整入口，优化其内部实现，再让 `read` 工具也调用它。

这不是“把所有入口接到当前的 normalize”。当前 `Image.normalize` 使用 `photon-node`，在大 PNG 上实测明显慢于 `read` 的 `sharp` 路径。如果只是让 `read` 调当前 normalize，会统一入口但造成性能退化。

真正推荐的路径是：

```text
read / TUI / tool-result
        ↓
Image.normalize(...)
        ↓
sharp metadata fast path
        ↓
需要处理时 sharp resize/compress
        ↓
photon fallback 或 typed error
```

实现原则：

| 原则 | 方案 |
| --- | --- |
| 不新增大 Module | 不新增 `MediaService`，不做全量 MediaPipeline 重构 |
| 不改 DB schema | 继续持久化 `MessageV2.FilePart` data URL |
| 不新增配置 | 复用 `attachment.image`，`read` 的 token budget 作为内部调用参数 |
| 不改 TUI 主流程 | TUI 仍只负责收集图片和占位符 |
| 收敛重复逻辑 | 删除或内聚 `processImageWithTokenBudget`，让 `read` 也走 `Image.Service` |
| 提升性能 | `Image.normalize` 增加 metadata fast path，重图处理优先使用 `sharp` |
| 减少重复处理 | 已经符合限制的图片二次 normalize 必须近似 no-op |

建议对 `Image.Service` 做一个小接口扩展：

```ts
interface Interface {
  readonly normalize: (
    input: MessageV2.FilePart,
    options?: {
      tokenBudget?: number
    },
  ) => Effect.Effect<MessageV2.FilePart, Error>
}
```

这个扩展保持克制：

| 理由 | 说明 |
| --- | --- |
| 仍在现有 `Image.Service` seam 内 | 没有新增公共配置、状态机或顶层 Module |
| 调用方少 | 当前只有 prompt、processor，新增 read |
| 兼容旧调用 | `options` 可选，现有调用无需改行为 |
| 解决真实重复 | `read` 不再维护自己的压缩实现 |
| 支持本需求 | 同一图片处理入口能覆盖 TUI、路径粘贴、tool-result、read |

不推荐的替代方案：

| 方案 | 不推荐原因 |
| --- | --- |
| 新建完整 `MediaService` | 架构更理想，但本次文件数、接口、状态和测试面都会明显扩大 |
| 让 `read` 返回原图，只靠 processor normalize | 简单但性能退化，`read` direct execution 也会返回巨大附件 |
| 只优化 `Image.normalize`，保留 `read` 独立压缩 | 性能会变好，但重复入口和行为不一致仍存在 |
| 引入磁盘 cache / DB asset 表 | 需要清理策略、迁移、兼容层，超出手术刀范围 |
| 改 TUI 图片能力 gate | 有价值，但不是图片处理性能和统一入口的最小必要条件 |

## 4. 预计修改、新增和删除的文件

| 文件 | 操作 | 具体改动 |
| --- | --- | --- |
| `packages/opencode/src/image/image.ts` | 修改 | 保留 `Image.Service`，重写内部 normalize 策略为统一入口 |
| `packages/opencode/src/image/image.ts` | 修改 | 增加可选 `tokenBudget` 参数，默认行为保持 `attachment.image` 限制 |
| `packages/opencode/src/image/image.ts` | 修改 | 使用 `sharp.metadata()` 做尺寸/MIME metadata fast path |
| `packages/opencode/src/image/image.ts` | 修改 | 已满足 `maxBase64Bytes/maxWidth/maxHeight` 时直接返回原 part |
| `packages/opencode/src/image/image.ts` | 修改 | 需要处理时使用 `sharp` resize/re-encode，失败映射到现有 typed errors |
| `packages/opencode/src/image/image.ts` | 修改 | 对透明图片优先保留 PNG，对非透明或预算紧张图片优先 JPEG |
| `packages/opencode/src/image/image.ts` | 修改 | 保留 `ResizerUnavailableError`、`InvalidDataUrlError`、`DecodeError`、`SizeError` 语义 |
| `packages/opencode/src/util/media.ts` | 修改/收敛 | 保留 `isMedia`、`isImageAttachment`、`isPdfAttachment`、`sniffAttachmentMime`、`formatSize` |
| `packages/opencode/src/util/media.ts` | 删除/替换 | 删除或内聚 `processImageWithTokenBudget` 和它私有的 `getSharp` 压缩实现 |
| `packages/opencode/src/tool/read.ts` | 修改 | 注入 `Image.Service`，图片分支构造 file part 后调用 `image.normalize(..., { tokenBudget: 1600 })` |
| `packages/opencode/src/tool/read.ts` | 修改 | 移除 `processImageWithTokenBudget` import，仍保留 `sniffAttachmentMime` 和 `formatSize` |
| `packages/opencode/src/tool/read.ts` | 修改 | PDF 分支保持原样，不走 image normalize |
| `packages/opencode/test/image/image.test.ts` | 修改/新增测试 | 覆盖 fast path、oversize resize、token budget、透明/非透明基本行为 |
| `packages/opencode/test/tool/read.test.ts` | 修改/新增测试 | 覆盖 `read` 图片走统一 normalize 且附件没有 runtime ids |
| `packages/opencode/test/session/message-v2.test.ts` | 可能不改 | 只在行为受影响时更新断言，目标是不改 |
| `packages/opencode/test/cli/cmd/tui/prompt-submit-transport.test.tsx` | 不改 | 本次不改 TUI submit 协议 |
| `packages/opencode/package.json` | 不改 | `sharp` 已存在，不新增依赖 |
| SDK/OpenAPI 生成文件 | 不改 | 不改配置 schema 和 API schema |
| DB migration | 不改 | 不改存储结构 |

不建议本次删除：

| 文件或依赖 | 原因 |
| --- | --- |
| `packages/opencode/src/image/image.ts` | 这是现有正确 seam，应保留并加深 |
| `@silvia-odwyer/photon-node` 依赖 | 即使实现转向 `sharp`，是否移除依赖应另开小 PR 确认打包影响 |
| TUI clipboard 逻辑 | 与本次统一处理入口相关但不是瓶颈，不应顺手重写 |

## 5. 正常路径、错误路径、并发、退出、清理和安全边界

### 正常路径

| 场景 | 处理方式 |
| --- | --- |
| TUI 剪贴板图片 | TUI 仍生成 data URL file part，入库前由 `Image.normalize` 统一处理 |
| TUI 粘贴图片路径 | TUI 仍读取文件并生成 data URL，入库前由 `Image.normalize` 统一处理 |
| `read` 工具读图片 | `read` 读取 bytes，构造临时 file part，调用 `Image.normalize` 并返回 normalized attachment |
| tool-result 图片 | processor 调 `Image.normalize`，如果图片已符合限制则 fast path 返回 |
| 小 JPEG/JPG/WebP | metadata 检查通过后直接返回，不完整解码 resize |
| 大 PNG/JPEG/WebP | 按 `attachment.image` 和可选 `tokenBudget` resize/re-encode |
| PDF | 保持现有原样 attachment，不进入 image normalize |
| 模型不支持图片 | 本次不提前拦截，继续由 `ProviderTransform` 最后转错误文本 |

### 错误路径

| 错误 | 处理方式 |
| --- | --- |
| data URL 非 base64 | 返回 `InvalidDataUrlError`，保持现有语义 |
| 图片为空 | 返回 `DecodeError` 或明确 Size/Decode 错误，不允许空 base64 进入模型 |
| `sharp` 不可用 | 返回 `ResizerUnavailableError`，prompt 现有逻辑会保留原 part，processor 现有逻辑会 omitted |
| decode 失败 | 返回 `DecodeError`，不伪装成文本 |
| `auto_resize: false` 且超限 | 返回 `SizeError` |
| resize 后仍超限 | 返回 `SizeError` |
| `read` 文件不存在/权限失败 | 保持 `read.ts` 现有 `miss`、permission、external_directory 行为 |
| binary 非图片 | 保持 `Cannot read binary file` |

### 并发和退出

| 方面 | 处理方式 |
| --- | --- |
| 多图片并发 | 保持 `SessionPrompt` 现有 `Effect.forEach` 行为，不新增队列 |
| sharp 并发 | 使用 sharp 自身调度，不新增全局 semaphore |
| abort | `read` 工具仍沿用现有 tool abort signal，图片处理不引入额外后台任务 |
| 退出 | 不创建临时文件，不需要新 cleanup |
| 重复处理 | 依靠 fast path 降低二次 normalize 成本，不引入 cache 状态 |

### 清理和存储

| 方面 | 处理方式 |
| --- | --- |
| DB | 继续存 data URL file part |
| 磁盘 | 不新增 image cache 目录 |
| 历史 | 不新增 prompt history 图片持久化策略 |
| 日志 | 不记录 base64，只记录 mime、bytes、dimensions 等安全 metadata |
| 生成文件 | 无 |

### 安全边界

| 边界 | 处理方式 |
| --- | --- |
| 外部目录 | `read` 继续在读取前执行 `assertExternalDirectoryEffect` |
| TUI 本地路径 | 保持既有行为，不扩大读文件权限 |
| provider 能力 | 保留 `ProviderTransform.unsupportedParts` 最后兜底 |
| 恶意图片 | decode 失败即 typed error，不回退为文本内容 |
| base64 日志泄露 | 新日志禁止输出 data URL/payload |
| PDF | 不借图片路径改 PDF 行为 |

## 6. 历史 session 兼容策略

推荐做兼容优化，不做数据库迁移。

历史 session 里的图片已经以 `MessageV2.FilePart.url` 的 data URL 形式存在。当前读取和模型消息转换都能继续识别：

```ts
part.type === "file" && part.mime.startsWith("image/") && part.url.startsWith("data:image/")
```

因此没有必要为了本次需求迁移历史数据。

| 场景 | 处理方式 |
| --- | --- |
| 历史 user 图片 part | 保持原 data URL，不主动重压缩、不改库 |
| 历史 tool-result 图片 attachment | 保持原 attachment，不主动重压缩、不改库 |
| 历史 session 被重新发送给模型 | 继续由 `MessageV2.toModelMessagesEffect` 转换，必要时由 provider transform 做能力兜底 |
| 历史图片再次经过 normalize | 使用 fast path：符合限制就直接返回，不重复重编码 |
| 历史图片超出当前限制 | 不在加载时迁移；只在“重新进入模型请求前”按当前 policy 处理或降级 |
| 历史图片损坏/空 base64 | 保持现有错误/placeholder 行为，不做批量修复 |

不做迁移的原因：

| 原因 | 说明 |
| --- | --- |
| data URL 是当前合法表示 | 不是坏数据 |
| 迁移成本高 | 历史 session 可能很多，扫大 base64 成本高 |
| 重压缩有损 | 批量迁移会不可逆地改变历史内容 |
| 未来 policy 不确定 | 不同模型/provider 的目标尺寸和预算不同 |
| 运行时兼容足够 | 目标可以通过 fast path 和懒处理解决 |
| 风险不符合本次范围 | DB migration 会扩大测试和回滚成本 |

需要避免的方案：

| 方案 | 不建议原因 |
| --- | --- |
| 扫库迁移所有历史 data URL | 慢、风险高、有损、收益不明确 |
| 启动时重压缩历史 session | 启动慢，不可控 |
| 读 session 时自动修改历史 part | 副作用隐蔽，容易破坏审计/回放 |
| 把历史 data URL 全部抽到文件 cache | 需要清理策略和 schema/引用兼容，超出本次范围 |
| 在 `MessageV2.toModelMessagesEffect` 每次都 normalize | 请求组装变慢，可能在无需要时重复压缩 |

## 7. 行为级测试计划

先写测试 1：`Image.normalize` 支持 `tokenBudget`。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/image/image.test.ts` |
| 测试 | 大 PNG 调 `image.normalize(part, { tokenBudget: 1600 })` |
| 当前实现缺口 | 当前 `normalize` 没有 `tokenBudget` 参数，测试会编译失败或无法表达需求 |
| 实现后验证 | 输出 base64 明显小于原图，尺寸不超过限制，MIME 为 `image/jpeg` 或 `image/png` |

先写测试 2：小图 fast path 不改变数据。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/image/image.test.ts` |
| 测试 | 小 JPEG/WebP 在限制内返回原对象或同等 url/mime |
| 当前实现缺口 | WebP 已有测试，小 JPEG fast path 未覆盖 |
| 实现后验证 | 小 JPEG 不被重编码，避免无谓损耗 |

先写测试 3：大图默认 normalize 仍遵守 `attachment.image` 限制。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/image/image.test.ts` |
| 测试 | `picture-5mb-base64.png` 仍能 resize 到 `max_width/max_height/max_base64_bytes` 内 |
| 当前实现缺口 | 已有类似测试，但应允许输出 MIME 变化 |
| 实现后验证 | 输出不超限，尺寸不超限，不强制 PNG |

先写测试 4：`read` 图片使用统一 normalize。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/tool/read.test.ts` |
| 测试 | 读取 `large-image.png`，返回 attachment，attachment 没有 id/sessionID/messageID，base64 小于原图 |
| 当前实现缺口 | 当前也可能小于原图，但走的是另一套 `processImageWithTokenBudget` |
| 实现后验证 | 行为保持，但实现路径变成 `Image.Service` |

先写测试 5：`read` MIME sniff 保持。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/tool/read.test.ts` |
| 测试 | `.bin` 文件内含 JPEG magic bytes 时仍识别为 `image/jpeg` |
| 当前实现缺口 | 现有测试已覆盖，应保持通过 |
| 实现后验证 | 不因移动压缩逻辑破坏 sniff |

先写测试 6：tool-result message 转换不变。

| 项目 | 内容 |
| --- | --- |
| 文件 | `packages/opencode/test/session/message-v2.test.ts` |
| 测试 | 现有 `preserves jpeg tool-result media for anthropic models` 和 `moves bedrock pdf tool-result media into a separate user message` |
| 当前实现缺口 | 不应暴露新缺口 |
| 实现后验证 | 保持通过，证明模型消息转换层未被误改 |

不建议本次新增的测试：

| 测试 | 不建议原因 |
| --- | --- |
| TUI image capability gate 测试 | 本次不改 TUI gate，避免扩大范围 |
| DB asset/cache 清理测试 | 本次不新增 cache/storage |
| 跨 provider 视觉 token 精算测试 | 本次不替换 token estimator |
| 性能断言测试 | CI 环境不稳定，不适合用 ms 作为硬断言 |

## 8. 建议运行的验证命令

所有命令都从 `packages/opencode` 目录运行。

```powershell
bun test test/image/image.test.ts
```

```powershell
bun test test/tool/read.test.ts -t "image|attachment media|large image"
```

```powershell
bun test test/session/message-v2.test.ts -t "tool-result media|bedrock pdf"
```

```powershell
bun test test/cli/cmd/tui/prompt-submit-transport.test.tsx
```

```powershell
bun typecheck
```

可选手动 benchmark，不作为 CI 必跑：

```powershell
bun -e "<small local benchmark for Image.normalize and ReadTool image path>"
```

不建议本次运行：

| 命令 | 原因 |
| --- | --- |
| 根目录测试 | 仓库说明禁止从 repo root 跑测试 |
| 全量 build | 本次不改构建产物，除非 typecheck 或局部测试暴露打包问题 |
| SDK 生成 | 不改 OpenAPI/config schema |
| DB migration | 不改 schema |

## 9. 预估 git 文件数、增删行数和生成物

| 项目 | 预估 |
| --- | ---: |
| 修改文件数 | 4 到 5 个 |
| 新增实现文件数 | 0 |
| 删除文件数 | 0 |
| 净增行数 | 约 `+80` 到 `+180` |
| 删除行数 | 约 `-80` 到 `-160` |
| 主要代码文件 | `image.ts`、`media.ts`、`read.ts` |
| 主要测试文件 | `image.test.ts`、`read.test.ts` |
| 生成文件 | 无 |
| DB migration | 无 |
| SDK/OpenAPI | 无 |
| package lock | 无 |
| 文档 | 默认无，除非实现时发现需要补一行 config 说明 |

预计 diff 形态：

| 文件 | 粗略变化 |
| --- | ---: |
| `src/image/image.ts` | `+120/-80` |
| `src/util/media.ts` | `+10/-90` |
| `src/tool/read.ts` | `+20/-15` |
| `test/image/image.test.ts` | `+60/-10` |
| `test/tool/read.test.ts` | `+25/-5` |

## 10. 真实风险与开放问题

真实风险：

| 风险 | 缓解 |
| --- | --- |
| `sharp` 在某些发布环境可用性不如 photon | `sharp` 已是依赖；失败仍映射 `ResizerUnavailableError`，保持现有 fallback 语义 |
| PNG 透明度可能被 JPEG fallback 破坏 | 有 alpha 时优先 PNG；只有 PNG 无法满足预算时才允许 JPEG fallback |
| GIF/WebP 动画语义不明确 | 本次不新增动画支持承诺，只保持现有“能处理为附件”的语义 |
| read 输出 MIME 可能从 PNG 变 JPEG | 现有测试应允许 PNG/JPEG；用户可见影响是体积更小但格式变化 |
| tokenBudget 映射仍是估算 | 保持当前 `payload.length / 750` 的预算模型，不假装精确 |
| 多张大图并发时仍可能卡顿 | 本次不加 queue；先解决重复入口和单张处理效率 |
| TUI 仍可能在模型不支持 image 时允许粘贴 | 保留 ProviderTransform 兜底；UI gate 可作为后续独立小改 |
| 旧 data URL 历史仍占空间 | 本次不改存储模型；cache/asset ref 是后续项目 |
| 性能改善依赖具体图片类型 | 增加行为测试，不增加硬性能测试；可用手动 benchmark 观察 |

开放问题：

| 问题 | 是否阻塞 |
| --- | --- |
| 是否彻底移除 photon 依赖 | 不阻塞，本次不建议移除 |
| 是否新增磁盘 image cache | 不阻塞，本次不做 |
| 是否增加 TUI 模型图片能力 gate | 不阻塞，建议另做 |
| 是否把 token estimator 改成 tile-based | 不阻塞，建议另做 |
| 是否为自定义 provider 默认 image=true | 不阻塞，且不建议本次改变 provider 默认能力语义 |

## 推荐方案摘要

本次不要做完整 MediaPipeline 重构。最克制、最符合当前仓库设计的方案是加深现有 `Image.Service`，让它成为唯一图片规整 seam。

具体做法：优化 `src/image/image.ts`，让 `normalize` 支持 fast path、`sharp` 优先 resize/compress、可选 `tokenBudget`；让 `read` 工具也调用 `Image.Service.normalize`；删除或收敛 `src/util/media.ts` 里重复的 `processImageWithTokenBudget`；保持 TUI、DB、`MessageV2`、`ProviderTransform` 的现有职责边界不变。

这样可以用 4 到 5 个文件的手术刀式改动，解决当前真实问题：多入口图片处理策略不一致、`read` 与入库 normalize 重复、当前 `Image.normalize` 性能偏慢，同时避免新增大抽象、迁移、缓存状态和公共配置。
