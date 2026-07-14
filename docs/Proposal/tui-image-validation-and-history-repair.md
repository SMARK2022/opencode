# TUI Sharp 打包链恢复与历史图片无损迁移方案

Status: approved after independent audit; user selected a distributable repository migration script and authorized implementation

Date: 2026-07-14

## 0. 推荐方案摘要

本次只做两件事：

1. **生产端 A**：继续使用现有 Sharp 0.34.5，不引入 Bun.Image 或第二图片后端。修复 Bun compiled executable 对 Sharp native addon/libvips 的打包、释放和加载链，并删除三处会在 Sharp 不可用时发送原图的 fallback。
2. **存储端 C**：在 TUI 再次消费目标 Session 前，事务化地把唯一损坏的 Tool attachment 替换为从已确认完整原件经过现有 Sharp 管线生成的有效附件。迁移前由SQLite生成包含已提交WAL页面的一致数据库快照，不删除任何不可恢复数据。

**消费端 B 不修改。** C 完成迁移后，现有数据库读取和 `MessageV2.toModelMessagesEffect()` 自然只会读到修复后的有效附件。

不修改图片格式支持、metadata fast path、GIF行为、base64规则、MIME策略、Provider转换、plugin、compaction、Assistant生命周期、数据库schema或通用日志。

最终 Git 修改 **10个文件（包含本文）以内**，预计代码增删 **低于800行**；当前实现为9个任务文件，新增Processor定向回归测试后为10个。

## 1. 已重新阅读和确认的文件

### 1.1 Sharp生产与调用链

| 文件 | 为什么相关 |
| --- | --- |
| `packages/opencode/src/image/image.ts` | 当前唯一图片处理实现，动态加载Sharp，执行metadata、resize和encode |
| `packages/opencode/src/tool/read.ts` | 本次坏附件的首个生产入口；Sharp不可用时返回原始bytes |
| `packages/opencode/src/session/processor.ts` | Tool result附件入库前再次normalize；Sharp不可用时再次返回原附件 |
| `packages/opencode/src/session/prompt.ts` | 用户图片入库前normalize；Sharp不可用时返回原Part |
| `packages/opencode/test/image/image.test.ts` | 已覆盖现有Sharp正常图片、尺寸、预算和SizeError行为 |
| `packages/opencode/test/tool/read.test.ts` | 明确把“resizer不可用时返回原图”锁成现有测试契约，必须反转 |
| `packages/opencode/test/session/prompt.test.ts` | 现有真实Prompt/Processor/LLM测试层可覆盖另外两处fallback的持久化行为 |
| `packages/opencode/test/session/processor-effect.test.ts` | 真实Tool result链验证Sharp不可用时保留工具文本并省略图片 |

### 1.2 Bun编译与发布链

| 文件 | 为什么相关 |
| --- | --- |
| `packages/opencode/script/build.ts` | Bun executable构建、目标矩阵、虚拟资源、PvRecorder native嵌入先例和当前仅`--version` smoke |
| `packages/opencode/script/install-target.ts` | build目标OS/CPU安装规则 |
| `packages/opencode/package.json` | `sharp@0.34.5`已是optionalDependency |
| `package.json` | 固定Bun 1.3.14；现有patchedDependencies和workspace安装边界 |
| `bun.lock` | 已包含Sharp及各平台`@img/sharp-*`、`@img/sharp-libvips-*`包 |
| `packages/opencode/src/cli/cmd/tui/prompt-voice-recorder.ts` | 已有“原生文件嵌入exe、释放到cache、校验、绝对路径require”的同仓库先例 |
| `.github/workflows/build-opencode.yml` | macOS/Linux/Windows发布构建和打包方式 |
| `packages/opencode/script/postinstall.mjs` | npm平台包只复制最终binary的行为 |
| `install` | curl安装器只安装最终binary的行为 |
| `packages/opencode/Dockerfile` | 镜像只复制最终binary的行为 |

### 1.3 B/C和迁移边界

| 文件 | 为什么相关 |
| --- | --- |
| `packages/opencode/src/session/message-v2.ts` | Part hydration与Tool attachment转ModelMessage的现有消费链 |
| `packages/opencode/src/session/session.ts` | `Session.updatePart()`写回边界；本方案不在运行期调用 |
| `packages/opencode/src/session/session.sql.ts` | `part.data`是ToolPart JSON的真实持久化位置 |
| `packages/opencode/src/data-migration.ts` | 现有通用后台迁移框架；经确认不适合本次用户特定文件恢复 |
| `packages/opencode/src/effect/app-runtime.ts` | DataMigration异步启动，无法保证在B首次消费前完成 |

### 1.4 Git历史

已确认：

- `981e00971a`：原Photon WASM打包修复，使用嵌入资源和运行时路径。
- `edae95237e`：将Image.Service从Photon改成Sharp，并引入三处ResizerUnavailable原图fallback。
- `1efc5c8a2a`：把Sharp 0.34.5加入optionalDependencies。

Sharp业务实现已经存在；缺失的是compiled TUI的native dependency packaging，而不是图片后端能力。

## 2. 通过搜索和实验确认的调用点

### 2.1 A：图片生产

1. `Image.Service.normalize()`：`packages/opencode/src/image/image.ts:68-158`
2. Read构造图片并调用normalize：`packages/opencode/src/tool/read.ts:615-641`
3. Processor处理Tool attachments：`packages/opencode/src/session/processor.ts:561-591`
4. Prompt处理用户图片并随后入库：`packages/opencode/src/session/prompt.ts:1914-1962`

三处原图fallback：

- `read.ts:635-641`
- `processor.ts:574-578`
- `prompt.ts:1928-1933`

### 2.2 B：历史消费

1. 数据库Part hydration：`packages/opencode/src/session/message-v2.ts:734-769`
2. 模型消息转换入口：`message-v2.ts:787-1092`
3. Tool attachment成为media output：`message-v2.ts:815-842`、`955-984`
4. 主请求调用转换：`packages/opencode/src/session/prompt.ts:2479-2480`

B没有产生、截断或修改图片；它只是忠实消费C中的坏附件。本方案不在B增加校验、迁移、删除、重试或fallback。

### 2.3 C：实际存储

目标记录：

| 字段 | 值 |
| --- | --- |
| Session | `ses_0c4482da0ffeHCysC6mhb0iR2d` |
| Part | `prt_f5af04c69001KEtWbmwrZrOjt3` |
| Message | `msg_f5aeda089001kbKBOGJGRw7PP3` |
| Tool | `read` |
| 状态 | completed |
| 附件位置 | `part.data.state.attachments[0]` |
| MIME | `image/png` |
| 损坏bytes | 7,340,032 |
| 损坏SHA-256 | `f4b050a0e963768712ce7bc5b241bc03faac0ad9ad8da3e654f945cdfe4dfe98` |

数据库自身状态：

- `PRAGMA integrity_check = ok`
- `PRAGMA quick_check = ok`
- `PRAGMA foreign_key_check`无违规
- 全库441个图片附件中只有该附件无法完整解码

所以C的问题是单条业务payload损坏，不是SQLite/WAL损坏。

## 3. 根因已经如何确认

### 3.1 图片不是被数据库或base64截断

Tool输入路径为：

```text
E:\个人资料\本科荣誉证明\03_竞赛获奖\2024年_第十一届全国泰迪杯数据分析技能挑战赛_本科组_国家级三等奖.png
```

该磁盘文件当前也是7,340,032 bytes，与数据库附件SHA-256完全相同。Sharp metadata能读到3496x2355，但完整PNG decode返回：

```text
pngload_buffer: libspng read error
```

因此ReadTool完整读取了当时的磁盘文件；数据库和base64没有二次截断。

### 3.2 完整原件仍存在，可以无损恢复

完整副本：

```text
E:\个人资料\本科\03_学科竞赛与科研成果\03_泰迪杯数据挖掘\【“泰迪杯”数据挖掘挑战赛组委会】第十一届“泰迪杯”数据挖掘挑战赛本科组 国家三等奖.png
```

验证结果：

| 项目 | 值 |
| --- | --- |
| 完整bytes | 7,835,144 |
| 完整SHA-256 | `3777c34cb8bf42900875843715c05114693602e38863a48a80f9ddac1ed08202` |
| 与坏文件关系 | 前7,340,032 bytes完全一致 |
| 缺失尾部 | 495,112 bytes |
| Sharp完整decode | 成功 |

使用当前未改动的`Image.Service.normalize(..., { tokenBudget: 1600 })`处理完整原件，得到：

| 项目 | 值 |
| --- | --- |
| 输出MIME | `image/jpeg` |
| 输出尺寸 | 2000x1347 |
| 输出bytes | 455,913 |
| base64字符数 | 607,884 |
| 输出SHA-256 | `91484e537ba88954efc9c7ebb95767e368c1a800b810420ade5b52fd76633d43` |

这正是Sharp链正常时ReadTool本应生成的附件。

### 3.3 Sharp compiled dependency chain确实断裂

Sharp 0.34.5的JS loader在`node_modules/sharp/lib/sharp.js:13-30`动态require：

```text
@img/sharp-<runtime>/sharp.node
```

Windows x64真实运行文件为：

```text
@img/sharp-win32-x64/lib/sharp-win32-x64.node
@img/sharp-win32-x64/lib/libvips-42.dll
@img/sharp-win32-x64/lib/libvips-cpp-8.17.3.dll
```

Linux/macOS还需要对应`@img/sharp-libvips-<runtime>/lib/**`。

当前`build.ts`没有显式导入这些动态native文件，所以Bun compile只打入Sharp JS，运行时找不到addon/libvips。

### 3.4 三种打包假设的独立实验

1. 默认bundle：compiled exe找不到Sharp native addon，失败。
2. `--external sharp` + 邻近`node_modules`：Bun 1.3.14 compiled resolver仍无法稳定解析external package，失败；不采用sidecar发布方案。
3. Sharp JS继续bundle，目标`@img`原生文件使用`with { type: "file" }`嵌入exe，运行时释放到真实目录，并让Sharp loader优先require该绝对`.node`路径：成功运行Sharp 0.34.5 metadata、resize和PNG encode。

第三种方案保持单文件发布，不需要修改npm/curl/Homebrew/AUR/Docker安装方式。

## 4. 必须保持的既有行为

- Image.Service继续使用Sharp 0.34.5。
- 现有metadata fast path保持，不增加“所有小图完整decode”。
- PNG/JPEG/WebP/GIF及其他现有Sharp格式行为不变。
- 现有resize尺寸、quality、alpha、tokenBudget和配置行为不变。
- Processor仍保留“单个失败附件省略、Tool文本继续”的既有语义。
- Prompt图片处理失败时不保存半条用户消息。
- MessageV2、ProviderTransform、plugin、compaction和远程URL行为不变。
- 发布产物仍是单个`opencode`/`opencode.exe`文件。
- C迁移保留Tool input/title/output/metadata/time和所有其他Part字段。

## 5. 推荐的最小实现

### 5.1 `build.ts`完整嵌入目标Sharp native资源

增加两个build-private函数：

1. `sharpRuntimeTarget(item)`：把现有target映射为Sharp命名，例如`win32-x64`、`darwin-arm64`、`linux-x64`、`linuxmusl-x64`。
2. `createSharpNativeFileMap(item)`：
   - Windows嵌入`@img/sharp-<target>/lib/**`；
   - macOS/Linux嵌入addon包和`@img/sharp-libvips-<target>/lib/**`；
   - key保留`@img/.../lib/...`相对布局；
   - 目标包缺失、没有`.node`或没有必要shared library时立即使build失败。

每个target生成`opencode-sharp.gen.ts`虚拟模块，通过`with { type: "file" }`把16-20 MB目标native资源嵌入当前exe。该模块必须同时加入当前target的`files`和`entrypoints`；现有PvRecorder注释已经证明只有`files`不足以让compiled dynamic import可达。只嵌入当前target，不把全部平台资源塞入每个binary。

增加一个build plugin，只在bundle Sharp 0.34.5的`lib/sharp.js`时完成两处精确替换：

1. 把`globalThis.__OPENCODE_SHARP_NATIVE_PATH`加入候选路径首位；
2. 把Linux x64官方`path.startsWith('@img/sharp-linux-x64')` CPU guard改为`runtimePlatform === 'linux-x64'`，避免绝对cache路径绕过`_isUsingX64V2()`检查。

两处都必须各命中一次，否则build失败。Linux x64-v1旧CPU由Sharp官方guard明确fail closed；Bun baseline只表示不要求AVX2，不等于取消Sharp上游x86-64-v2最低边界。其余Sharp源码保持原样。

### 5.2 `image.ts`负责compiled资源释放和Sharp加载

只调整现有`loadSharp`前置步骤：

1. 非compiled/dev路径仍直接`import("sharp")`。
2. compiled路径导入`opencode-sharp.gen.ts`。
3. 将资源按原相对布局释放到`Global.Path.cache/native/sharp/0.34.5/<target>/`。
4. 已有文件只有在大小和SHA-256都等于嵌入资源时才复用。
5. 写入使用同目录唯一temp + rename；`finally`始终清理自己的temp。
6. rename遇到`EEXIST`、`EPERM`或Windows sharing violation时，重新校验winner目标；大小和SHA-256一致则复用，否则失败。所有资源校验完成后才能加载addon。
7. 把释放后的`.node`绝对路径写入build plugin约定的global，再执行现有`import("sharp")`。
8. 任一步失败仍返回现有`ResizerUnavailableError`，不增加第二后端。

不修改metadata、resize、encode或错误类型。

### 5.3 删除三处原图fallback

- Read：Sharp不可用时Tool失败，不返回原始attachment。
- Processor：删除ResizerUnavailable到原attachment的转换；后续现有`Effect.exit`会按既有附件省略语义处理。
- Prompt：Sharp不可用时prompt失败，Part不会入库。

这样未来即使Sharp打包再次回归，也只会暴露明确错误，不会把未经处理的原图写入C。

### 5.4 C通过仓库内可分发脚本执行离线、可回滚、无损事务迁移

C迁移不进入Prompt、MessageV2或后台通用DataMigration代码。新增`packages/opencode/script/migrate-image-attachment.ts`作为显式调用的离线维护工具，使其他用户可以对自己的`db + part + 完整source`执行同一修复，而不把用户路径/Part硬编码进运行时。

脚本默认dry-run；`--apply`必须同时提供DB、Part、完整源、旧attachment SHA、源SHA、dry-run得到的新SHA和备份目录。步骤固定为：

1. 解析显式参数并定位精确Part，只接受`completed ToolPart`中的`image/*` File attachment；不扫描数据库或目录。
2. 验证旧attachment SHA和完整原件SHA，使用仓库真实`Image.Service`和Sharp生成新附件，再次由Sharp完整decode并验证dry-run得到的新SHA。
3. 仅在`--apply`全部内容前置条件通过后检查备份盘空间，避免错误参数和幂等重跑制造2GB级无用副本。
4. 对live连接执行SQLite原生`VACUUM INTO`，让SQLite在一个一致读快照中把主库及已提交WAL页面合并为单一master数据库，避免手工依次复制DB/WAL/SHM形成跨时间点备份。
5. 记录master SHA-256；只复制master生成disposable validation clone，在clone上验证integrity和foreign keys，删除clone后再次验证master manifest。唯一master不被SQLite打开。
6. 开启SQLite transaction，以`id + 原始data完整值`作为CAS条件，只替换目标attachment的`mime/url`。
7. `changes`必须严格等于1；同一transaction内重读完整Part JSON并执行foreign-key/integrity检查，任一失败由SQLite自动rollback。
8. 保留一致master、损坏磁盘副本和完整原件，不覆盖或删除任何外部文件。

幂等规则：当前attachment等于预期新SHA时返回`already migrated`；等于旧SHA时才允许迁移；两者都不等时立即停止。脚本不扫描、不猜测、不按文件名寻找替代源。

Master一致快照只作为灾难恢复源，不承诺跨D:到C:做不存在的原子覆盖恢复。若事务失败，live行由SQLite回滚；若后续需要灾难恢复，停止TUI后由用户从已验证master执行明确恢复，不由脚本自动覆盖2.14 GB live DB。

UPDATE前失败是零写入，事务内失败是rollback。全程没有删除附件、占位文本、模糊文件搜索或自动猜测替代文件，master备份始终不可变。

## 6. 为什么不修改B

C事务在重新启动TUI前完成。之后：

```text
PartTable正确JSON -> MessageV2 hydrate -> 现有toModelMessagesEffect -> Provider
```

B看到的从一开始就是正确数据。给B增加图片校验或读时迁移会：

- 混淆消费与存储职责；
- 重复处理每次请求；
- 影响compaction/title/summary/测试fixture；
- 无法凭空恢复缺失的495,112 bytes；
- 扩大本次不需要的行为面。

因此B相关生产文件修改数为0。

### 6.1 单一normalize链复核

实现阶段再次搜索确认：生产代码只有Read、Processor、Prompt三处`image.normalize()`调用，全部进入同一个Sharp-backed `Image.Service`；三处`ResizerUnavailableError -> 原对象`分支均已删除。`src`中不存在Photon、`processImageWithTokenBudget`或第二resize backend。Processor的`Effect.exit`只保留既有“失败附件省略”语义，不调用替代处理器也不返回原图。Photon仅在`image.test.ts`中生成测试fixture，未进入生产bundle或normalize链，因此不作为生产fallback删除。

## 7. 预计修改文件

| # | 文件 | 修改 |
| ---: | --- | --- |
| 1 | `docs/proposal/tui-image-validation-and-history-repair.md` | 本方案与独立审计记录 |
| 2 | `packages/opencode/script/build.ts` | target Sharp资源表、虚拟模块、Sharp loader build plugin和build-time完整性断言 |
| 3 | `packages/opencode/src/image/image.ts` | compiled native资源释放、校验和现有Sharp加载 |
| 4 | `packages/opencode/src/tool/read.ts` | 删除ResizerUnavailable原图fallback |
| 5 | `packages/opencode/src/session/processor.ts` | 删除ResizerUnavailable原附件fallback |
| 6 | `packages/opencode/src/session/prompt.ts` | 删除ResizerUnavailable原Part fallback |
| 7 | `packages/opencode/test/tool/read.test.ts` | 把原图fallback测试改成fail-closed行为测试 |
| 8 | `packages/opencode/script/migrate-image-attachment.ts` | 可分发的dry-run/apply、一致快照、Sharp重建、CAS和验证工具 |
| 9 | `packages/opencode/test/session/prompt.test.ts` | 验证Prompt在Sharp不可用时不持久化用户图片请求 |
| 10 | `packages/opencode/test/session/processor-effect.test.ts` | 验证Processor保留工具文本并省略无法normalize的图片 |

不修改：

- `package.json`、`packages/opencode/package.json`、`bun.lock`，因为Sharp 0.34.5及平台包已经存在；
- `.github/workflows/build-opencode.yml`、`install`、`postinstall.mjs`、Dockerfile，因为native资源嵌入单exe；
- MessageV2、LLM、ProviderTransform、plugin、compaction；
- Drizzle schema/migration/snapshot、DataMigration；
- SDK/generated文件；
- Desktop。

## 8. 正常、错误、并发、退出和安全边界

### 正常路径

- Dev/source：继续从node_modules加载Sharp。
- Compiled TUI：释放当前target资源，Sharp从绝对`.node`路径加载，现有normalize逻辑不变。
- 第二次使用：hash一致则复用cache，不重复写20 MB文件。
- C迁移：完整原件经过同一Image.Service生成有效attachment，再事务替换。

### 错误路径

- 构建缺目标`@img`包/shared library：build立即失败。
- Sharp loader源码升级导致plugin不再精确命中：build立即失败。
- native释放/校验/import失败：现有ResizerUnavailableError向上传播，三处调用方不再发送原图。
- C前置空间、backup/clone hash、decode、CAS或row count不匹配：零写入或rollback。
- C收到非图片Part、未知hash或变化后的完整源：明确拒绝，不创建无用备份、不修改live行。
- 完整原件不存在/变化：不迁移，不删除旧附件。

### 并发与退出

- Image.Service现有`Effect.cached`继续保证单进程只执行一次Sharp加载。
- temp + rename及rename冲突后的winner复验保证多进程不会加载半写native文件，也不会把另一个进程的成功误报为ResizerUnavailable。
- SQLite快照保证备份跨WAL一致，完整旧JSON CAS保证并发修改目标Part时拒绝覆盖；实际迁移仍应关闭TUI以减少无意义竞争。
- C transaction只更新一行，不跨Sharp处理持有SQLite锁。

### 数据安全

- native cache只接受exe内嵌资源，复用前校验SHA-256。
- C修改前生成包含已提交WAL页面的单文件一致master并记录SHA-256。
- C只打开disposable clone验证，不打开或修改master，不删除坏attachment对应磁盘副本，也不覆盖两个磁盘文件。
- 不把图片payload加入日志、commit或proposal。

## 9. 行为级TDD与验证计划

### Red 1：禁止原图fallback

先修改`read.test.ts`现有`noResizer`测试：

- 当前实现返回原图，测试先红；
- 目标断言Read失败且没有attachment；
- 再删除Read fallback。

Processor和Prompt分别由现有真实链路测试覆盖：Prompt验证失败发生在持久化前，Processor验证工具文本保留且失败图片被省略。为满足行为级回归要求，新增测试仍控制在用户授权的10文件上限内。

### Red 2：compiled Sharp依赖链

使用`D:\Temp\opencode`临时harness，必须先复现：

```text
Could not load the "sharp" module using the win32-x64 runtime
```

随后由`build.ts`生成临时smoke entry，导入仓库真实`Image.Service`并复用同一个Sharp plugin、`opencode-sharp.gen.ts`和compiled define；在没有邻近node_modules的目录执行：

- 用必定进入resize/encode分支的fixture调用真实`normalize()`；
- 输出MIME、尺寸、payload budget和Sharp完整decode正确；
- 首次释放后再次运行验证cache复用；
- 两个进程对全新临时cache并发启动，验证rename loser复验winner后也成功；
- 临时产物不进入Git。

当前独立原型已经在Bun 1.3.14 Windows x64通过Sharp加载；正式实现的green标准必须升级为上述真实Image.Service链。当前CI宿主能运行的Windows/Linux/macOS target执行动态smoke；交叉架构target只做包名、恰好一个`.node`、shared library和相对布局静态断言，不伪称已执行。

### C迁移dry-run和post-check

迁移前dry-run必须打印且校验上述旧hash、完整源hash、预期新hash，但不写DB。正式事务后再验证：

- 目标attachment MIME/bytes/hash正确；
- Sharp完整decode成功；
- 目标Part其他字段深相等；
- DB integrity/foreign keys仍通过；
- 目标Session下一次请求不再包含旧hash并不再出现invalid-image 400。

`read.test.ts`中的CLI集成fixture验证dry-run零写入、真实Sharp迁移、master快照、already-migrated幂等和非图片拒绝；实现阶段还用临时SQLite独立验证错误旧hash拒绝。完整旧JSON CAS位于同一SQLite transaction，目标行在读取后发生变化时`changes !== 1`并rollback，不增加测试专用生产钩子。

### 回归命令

从`packages/opencode`执行：

```powershell
bun test test/tool/read.test.ts
bun test test/session/prompt.test.ts
bun test test/image/image.test.ts
bun typecheck
bun run script/build.ts --single --skip-install --skip-embed-web-ui
& ".\dist\opencode-windows-x64\bin\opencode.exe" --version
```

再运行临时compiled Sharp harness和数据库只读验证。相关检查通过后才允许执行C写事务。

## 10. Git规模与注释

| 区域 | 预计增删行 |
| --- | ---: |
| `build.ts` | 150-220 |
| `image.ts` | 100-150 |
| 三处fallback | 15-25 |
| `read.test.ts` | 90-110 |
| `migrate-image-attachment.ts` | 250-290 |
| 合计 | 610-680 |

最终核算以Git有效代码行为计数，当前任务代码仍低于800行；任务Git文件数为 **10以内**（包含本文和两个定向回归测试文件）。

中文注释至少占有效修改行15%，只解释：

- 为什么Sharp动态native依赖必须显式嵌入；
- target到`@img`包名的映射；
- 为什么shared libraries必须保持相对布局；
- 为什么虚拟模块必须同时进入`files`和`entrypoints`；
- 为什么绝对路径不能绕过Sharp官方Linux x64 CPU guard；
- 为什么cache复用前校验hash；
- 为什么rename失败后必须复验并复用并发winner；
- 为什么三处不得再回退原图；
- 为什么C必须使用SQLite一致快照、不可打开的master、validation clone和完整旧JSON CAS。

不通过格式性注释凑比例。

## 11. 真实风险与开放问题

### 已确认风险

1. 每个binary增加约16-20 MB未压缩native资源。这是完整携带Sharp/libvips依赖的必要成本，不通过第二图片后端规避。
2. Build plugin依赖Sharp 0.34.5 loader中的两个精确锚点。构建时分别强制单次命中，把升级风险转成显式build失败。
3. Sharp Linux x64预编译包要求x86-64-v2；不满足的旧CPU由官方guard明确fail closed，不以Bun baseline名义绕过。
4. native资源首次使用需要释放到cache。原子写、hash验证和并发winner复验防止半文件/错误复用。
5. 当前损坏磁盘副本本身仍不可解码。本方案不擅自覆盖用户文件；C从已确认完整副本恢复数据库附件。

### 无需用户决策的结论

- 不使用Bun.Image。
- 不删除损坏attachment。
- 不在B做迁移。
- 不新增schema、配置、公共API或通用迁移框架。
- 不修改图片格式和解码策略。

## 12. 独立审计状态

前4轮围绕Bun.Image和消费端repair的方案均已作废，不构成放行依据。

第5轮两位独立subagent对Sharp方向本身无异议，但提出5类阻塞项：virtual module entrypoint遗漏、真实Image.Service smoke不足、Processor/Prompt红测缺失、Windows rename竞态、C备份/commit后恢复顺序，以及一位审计者补充的Linux x64 CPU guard绕过。本文已全部按原范围修正，第5轮不能作为放行结果。

第6轮必须重新完整审计：

- Sharp addon/libvips每个现有target是否完整；
- Bun virtual file、cache释放、loader plugin和单文件发布是否闭环；
- 三处fallback删除后是否仍存在原图通路；
- C是否真正无损、可回滚、在B消费前完成；
- 是否误改任何图片行为或B边界；
- 10文件、800行上限和15%中文注释是否可信。

第6轮结果发生分歧：

- 早期独立subagent给出明确`NO BLOCKING FINDINGS`，确认Sharp target资源、loader CPU guard、entrypoint、并发释放、真实Image.Service smoke、B不变、C的CAS闭环；后续实现审计按用户授权扩大至10文件并补齐Prompt/Processor定向测试。
- 另一位独立subagent仅对C提出2个阻塞意见：唯一物理备份不能被SQLite打开验证；D:到C:无法对2.14 GB DB/WAL/SHM承诺跨盘三文件原子恢复。Sharp/A/B及代码预算没有其他阻塞。

方案阶段最终将C收敛为immutable master + disposable validation clone，并删除“跨盘原子物理恢复”承诺。实现阶段第一轮独立复核进一步指出逐文件复制DB/WAL/SHM仍可能跨时间点；实现遂改用SQLite原生`VACUUM INTO`一致快照，删除不必要的commit后反向CAS，补充非图片硬拒绝和CLI集成测试。该变化减少分支并强化数据一致性，不改变Sharp/A/B/C职责边界。
