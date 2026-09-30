# Canonical Plan：共享后端语音转录、Profile Cookie 与完整取消

> Status: verified
> Revision: R27
> Approved revision: R27
> Implementation allowed: no further material changes without revision or rework
> Audit mode: full-scope
> Requirement source: 本会话用户原文，见 §1
> Target: verified-implementation
> Last updated: 2026-09-30

本文件是唯一实施规格。R27沿用§47-53全部修复，§54替换实际附件卡片解析。上限5生产文件/600行，仍为5文件，Bun1.3.14不变；不手填凭据、不调用question、不提交或推送。新增语义须当前修订完整批准后实施。

## 1. 用户原始要求

> 完整按照既有用户要求的生产模型进行完整实现，不得进行任何修改面的扩大或者状态机、护栏的添加，所有机制必须依赖于可靠的架构完整实现，其中既有所有架构都将移除，且整体实质性机制可靠性不得较原有框架模型有所下降，且生产代码文件修改数不超过16个文件，实质性增加量不得超过600行，其余修改仅能进行必要的机制位置移动且不得改变任何既有注释的完整性、代码逻辑，否则都将视为实质性修改的增加。

> 请注意我重复，任何试图在代码层级或位置移动中进行实质性机制修改更新的行为都会被视为实质性增加，只有行数删减才不被视为增加，需要重新完整进行审计，方案必须包含完整的实质性增加部分和需要进行删减以及移动的段标记
>
> 同时避免将方案过度冗长，保持信息量和避免重复叙述或者无意义记录

> 推荐的方案行数整体建议低于1200行

> 请注意，我将再次重复标准。如果代码发生了实质性修改，就会被认为是实质性新增，请注意这一点。与此同时，修改上限，实质性新增或者实质性修改上限为800行。只有删除、移动才不算实质性修改。

> 同时用户不在这里请自主全面完成任务，不要问。

> 不得进行 block。如果需要更新 BUN，你可以自己进行更新。但我大概率推断，即使你更新之后也不会有任何改观。

> 你看我使用同样的cookie，浏览器中的cookie去进行相应的转录都没有任何问题。

用户提供的成功请求同时含Cookie与Authorization；网页源码使用 `cm.safePost('/transcribe', {requestBody:i,authOption:Yh.SendIfAvailable})`。材料仅记录结构，凭据值留在用户原消息中；实验采用MCP自有账户。

> 注释应当在相应各种函数关键位置，譬如开头、中间你加很多东西的一个原因，等等内容，都全面完整地去进行阐释。理论上要求你每修改一个文件，那文件中你所有的实质性修改或实质性新增的部分，至少要大于百分之十的注释。请注意这一点。
>
> 同时，如果单纯只是chunk的移动，那本质上必须包含全量完整注释，甚至可以再增加一点点注释，否则都将视为实质性修改，因为你遗弃了内容。

> 注意一点，我观察到相应的agent在注释方面有较大的降级，我推荐你完整全面的进行检查，保持原来的那种注释风格，尤其是在众多紧凑代码中穿插注释保持整体代码可读，整体代码注释量要至少大于15%，确保每个chunk的修改都有完整均匀的注释，且不需要额外增加无意义的显而易见的注释，服从现有风格讲述原因和关键逻辑等等

> 不得新增任何文件，因此不得新增。你应当检查，理论上而言，我们当前是有相应的一个实现，就是是有一个相应的一个读取的那种那个接口，把那个接口不要让它使用浏览器的读取，让它把它改成profile的读取。而且不需要去定位系统的 profile，理论而言，ChatGPT Browser Agent这个MCP是有自己的 profile的。

> 请注意一点，当前是指读调研状态。然后与此同时，相应的逻辑应该是这样，就是由 TUI 去录制并进行相应的提交给后端。提交给后端之后，由后端进行自行转录。它如果转录不了，那本身去看一下，就是如果转录过程中有凭据问题，或者说凭据没有，那首先从那个 MCP 里面，理论上来说可以不打开浏览器的，通过 Profile 的形式直接去获取到相应的 Cookie。那如果这个操作获取到的 Cookie 有问题，或者说这还是不行，那本质上最后 fallback 到相应的完整的浏览器的一个转录。

> 因为我不希望保留 OpenCOD 的刷新，那本质上如果它自行刷新浏览器的内容将会失效，所以这就会导致两者互相冲突。所以你应当自行去检查，看看能不能不启动相应浏览器，直接读取 profile 获取 cookie。请注意我当前知晓并授权一切你读取的风险。

> 整体而言，我认为，请注意一点，对于转录而言，本质上我认为整个流程应当不超过120秒，那对于单次重试理论上而言，我认为整体而言也不得消耗超过40秒。注意，我指的单次转录是指最长的这种页面的转录，最长也不得超过40秒。

> 本质上而言，每次单次转路，上限就是40秒。那你不需要使用什么什么本轮剩余时间。本质上而言，倒点就扔掉就行了，倒点扔掉，然后后面有相应的扔掉之后的一个相应自动的 abort 的一个处理机制就行了。

> 你应该更新的不只是整轮120秒到点触发 abort，而是整套的完整的取消机制。请注意，取消机制需要保持完整，准确，同时包含具体实施的相关的核心代码等等内容。且整体内容不得使用模糊化表达。

用户已指定每轮重新审计使用全新 agent 上下文；blocker 复议才复用该轮 task_id。GOAL 的阶段及提交规则沿用 `docs/workflow.md` 和本次 GOAL 原文。

## 2. 最终范围

R01 三个 TUI 录音入口统一提交共享 daemon；R02 缓存 Cookie → profile Cookie → 浏览器转录；R03 浏览器维持认证更新；R04 用户级 MCP auth 统一持久化；R05 新增文件数 0、生产文件数 ≤16；R06 实质性增加 A ≤800；R07 完整取消与收尾；R08 清理链外旧语音机制；R09 每轮120秒、每次固定40秒；R10 移动代码及原注释完整保留。

清理范围是本任务的旧语音选择、认证、计时和调用实现。录音底座、共享 daemon、通用鉴权、MCP ask/image、浏览器底层资源设施按 §12 明确保留。生产操作在批准后按 TDD 执行，终态为独立验证通过并提交。

## 3. 仓库约定与基线

遵循根、packages/opencode、test、test/server、HttpApi 的 AGENTS.md；领域词汇来自 CONTEXT.md。HTTP 使用既有 HttpApiBuilder.group；Effect API 以已安装源码核对。测试及 bun typecheck 从包目录执行。

实施前基线：`sdks/vscode/.gitignore` 等其他改动保持；ChatGPT 子模块 HEAD 为 `b04aff7`，父仓库原 gitlink 差异保持归属记录。§4–5记录实施起点，当前工作区已完成部分R8切片；R9复审期间暂停继续编辑生产文件。

R9实施反馈：录音完整回归为10通过/1失败，失败用例是 `releases the recorder and leaves no WAV file when native reading fails`。该用例证明stop报告原错误后abort仍需保留既有清理语义。另据CLI/core的DAEMON_VERSION=24及ensureDaemon版本复用条件，新返回协议需同步递增版本，让既有选主流程取得新版daemon。两项均在既有文件内原位调整。

## 4. 当前证据与反馈信号

| 证据 | 当前事实 |
| --- | --- |
| prompt-voice-input.ts:44,172；三个组件调用点 | TUI 本地执行转录，五个录音状态及 generation 已存在 |
| tui/config/tui.ts:110,215,316；voice-auth.ts:38,195,249,296 | 前端配置选择、Bearer/session 刷新、进程内缓存与写回 |
| thread.ts:123；daemon.ts:345；server-lock.ts:62 | TUI 已复用一个 OpenCode daemon |
| sdk.tsx:43；HttpApi tui group/handler | 现有认证 HTTP 通道和可加入 binary endpoint 的位置 |
| recorder.ts:89,113；Worker:43 | closePromise 已有；abort 可先于 stop 写入完成执行 rm |
| Process.run:123；Flock.withLock:352 | pipe/exit Promise.all 与 await using 锁租约 |
| NodeHttpServer:175；effect internal:1043 | HTTP close 中断 fiber；callback 取消 finalizer 可等待原 Promise |
| chatgpt.js:873；core.js:2048 | auth-export 当前准备浏览器后读取 bootstrap/CDP |
| core.js:1966,2030；dom.js:188,760 | 页面 requestID、controller、取消及租约清理已有 |

以上为 observed 源码证据；目标 R01–R10 为 contracted。

真实诊断结果（2026-09-17，同一 OpenCode 账户）：当前 MCP Cookie 单独 POST `/backend-api/transcribe` 返回200及 hello/world；加入当前浏览器 Bearer 的对照亦为200；JSON 中旧 Bearer 返回401 token_expired；JSON Cookie 单独请求的该次响应为429。MCP 自有 profile 23条 v10 Cookie 经 DPAPI/AES-GCM 离线解密成功；后续活跃文件读取返回 EBUSY。本机 Node24.16 提供 node:sqlite。

红信号：`bun D:/Temp/opencode/voice-pipeline-repro.ts` 曾连续两次401并把旧 token 写回配置副本。长效反馈以 §16 的真实接口测试替代临时探针。完整离线→转录→持久化→下一请求复用属于实施验收；单项实验分别保留其实际来源。

## 5. 当前流程与首个偏离

```text
idle → starting → recording → stopping → transcribing → idle
                                      └→ TUI 读取 auth
                                          → token/Cookie 临期判断
                                          → session 刷新或浏览器导出
                                          → Bearer POST → 401 再刷新
                                          → 浏览器 argv → 文字
```

首次偏离分别位于 controller 默认本地调用、defaultFetchSession、auth-export 的 ensureDaemon、各 TUI 的独立写回，以及浏览器成功只返回 text。调整直接落在这些调用点。现有“程序种类唯一”收敛为共享后端锁内一次事务。

## 6. 数据和有效输入

```ts
type CookieSnapshot = {
  access_token?: string
  cookies: Record<string, { value: string; expires: number }>
  fetched_at: string
}
type CookieExport = {
  accessToken?: string
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number }>
  fetchedAt: string
}
type VoiceTarget = { config: string; key: string; interpreter: string; script: string; environment: Record<string, string> }
```

HTTP接收WAV bytes + directory，返回 `{text}`。auth继续存原用户级文件的 `mcp.<key>.auth`；读取Cookie及已有access_token，下一次写回替换完整快照。auth-export返回CookieExport的Cookie字段，浏览器CLI返回 `{text,auth:CookieExport}`，其中accessToken是本次成功POST实际使用的页面bootstrap值。后端唯一authFromHarvest转换成字典与access_token；JWT解析、临期判断、OpenCode session查询及刷新调用数0。

配置顺序：global → OPENCODE_CONFIG → OPENCODE_CONFIG_DIR；各目录 json → jsonc。每个 key 保留最后条目与来源，disabled 参与覆盖。选取启用的 ChatGPT local 项，command/environment/auth 同源；相对脚本路径按该配置文件目录解析。普通项目 MCP 继续保持，语音采用用户级文件。语音目标缺席返回配置错误。

## 7. 不变量

I01 所有语音请求从同一后端接口执行；I02 直连遵循SendIfAvailable，Cookie与快照中已有Bearer一起发送；I03 session刷新调用数0；I04 auth-export浏览器启动数0；I05 同配置文件事务互斥，成功新快照一次写回；I06 浏览器同次返回text/Cookie/实际使用的Bearer；I07 signal结束操作、操作结束后释放资源；I08 生产≤16文件、A≤800、新文件0；I09 固定120/40秒；I10 每个纯移动块逐字保留代码和关联注释。

## 8. 一条目标链

```text
录音完成 → TUI 120秒信号 → 上传 WAV → 后端锁内读 auth
 → 缓存认证快照 POST（已有Bearer随Cookie发送）
 → 缺少缓存或401/403：profile 读取并用所得 Cookie POST
 → 其余失败：一次完整浏览器转录，取得 text + Cookie + 本次Bearer
 → 新快照写回 → 返回 text → TUI 插入文字
```

成功立即返回；profile 读取或该步转录失败进入末级浏览器；末级错误直接结束。每处转移先 `requestSignal.throwIfAborted()`。写回在成功结果之后、转移 catch 之外。200空文字沿既有输入框 trim 判断处理。

## 9. 函数输入、输出、处理

| 函数 | 输入 → 输出 | 处理 |
| --- | --- | --- |
| createVoiceInputController | recorder/transcribe/insert 回调 → toggle/abort/status | 既有五状态、generation；调用提交函数 |
| submitVoice | file、signal、sdk → text | Bun.file 上传；await fetch及正文；检查 signal |
| voiceTranscribe handler | binary payload → {text} | 解析目标、单 operation Promise、音频/activity 收尾 |
| resolveVoiceTarget | 用户级文件列表 → VoiceTarget | 现有变量展开、文件读取、MCP 推导收敛 |
| transcribeVoiceFile | file、target、requestSignal → text | Flock.withLock 内执行 §8 |
| read/writeVoiceAuth | config/key/snapshot/signal → snapshot/void | JSONC 定点读写与 rename |
| transcribeDirect | file、snapshot、attemptSignal → 文字或状态 | 原FormData、NetworkProxy、Cookie及已有Bearer |
| defaultHarvest / transcribeArgv | target、signal、音频 → CookieSnapshot / {text,auth} | 原 Process.run，固定私有 CLI |
| exportProfileAuth | MCP profile 设置、signal → CookieExport | SQLite只读、DPAPI、AES-GCM、finally |
| runVoiceRequest / runVoiceTranscribe | runtime、音频、signal → {ok,text,auth} | 既有voice/submission/lease，附带同页Cookie及本次Bearer |

后端函数落入现有 `server/shared/tui-control.ts`；前端 submitVoice 落入现有 `prompt-voice-input.ts`；profile 函数落入现有 `chatgpt.js`。

## 10. 完整调用与取消核心代码

### 10.1 TUI

录音时 Alt+V 表示 stop+提交；转录时 Alt+V 或组件退出表示取消。starting 的迟到句柄沿原 generation 检查清理。以下是原 cancel 的替换段 S01：

```ts
const cancel = async () => {
  const current = ++generation
  const active = recorder
  const closeHere = status.type === "recording"
  const abort = transcribeAbort
  recorder = undefined
  transcribeAbort = undefined
  setStatus({ type: closeHere ? "stopping" : "idle" })
  abort?.abort()
  try { if (closeHere) await active?.abort() }
  finally { if (generation === current) setStatus({ type: "idle" }) }
}
```

stop 分支保持既有 active 存在性检查与 stopping 显示，随后执行：

```ts
const current = generation
try {
  await active.stop()
  if (current !== generation) return
  transcribeAbort = new AbortController()
  const signal = AbortSignal.any([transcribeAbort.signal, AbortSignal.timeout(120_000)])
  setStatus({ type: "transcribing" })
  const text = await input.transcribe(active.file, signal).catch((error) => {
    signal.throwIfAborted()
    throw error
  })
  signal.throwIfAborted()
  if (current !== generation) return
  if (text.trim()) input.insertText(text)
} catch (error) {
  if (current !== generation) return
  input.onError?.(error instanceof Error && error.name === "TimeoutError"
    ? "语音转录超时（120 秒）" : error instanceof Error ? error.message : String(error))
} finally {
  await active.abort().catch(() => {})
  if (current === generation) {
    recorder = undefined
    transcribeAbort = undefined
    setStatus({ type: "idle" })
  }
}
```

stopping/上传调用持有本地 WAV，取消后由该调用 finally 清理。原 recorder.abort 改为 `try { await close(false).catch(() => {}) } finally { await fs.rm(file,{force:true}) }`；现有closePromise先等待已有stop写入结算，stop调用者保留原错误，abort只执行既有清理合同。Worker原子停止、native stop/delete、terminal与退出原样保持。

### 10.2 HTTP 与后端完成点

`POST /tui/voice/transcribe` 使用现有 TuiApi group、鉴权及实例 middleware。payload 为 `Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({contentType:"audio/wav"}))`，解码阶段50MiB限制与现有默认 WAV 上限对齐。消息型502错误声明放现有 group 文件。sdk.fetch 使用调用时 URL、directory 和 signal；正文读取也处于同一调用。

handler 中 target 为当前后端配置，payload 为 WAV。操作 Promise 与资源使用同一个完成点：

```ts
return Effect.callback<{ text: string }, VoiceError>((resume, signal) => {
  const id = randomUUID()
  const file = path.join(os.tmpdir(), "opencode", "voice", `${id}.wav`)
  const operation = (async () => {
    signal.throwIfAborted()
    const release = SessionActivity.begin(`voice:${id}`)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      signal.throwIfAborted()
      await fs.writeFile(file, payload)
      signal.throwIfAborted()
      const text = await transcribeVoiceFile(file, target, signal)
      signal.throwIfAborted()
      return { text }
    } finally {
      try { await fs.rm(file, { force: true }) } finally { release() }
    }
  })()
  void operation.then(
    (value) => resume(Effect.succeed(value)),
    (error) => resume(Effect.fail(new VoiceError({ message: error instanceof Error ? error.message : String(error) }))),
  )
  return Effect.promise(() => operation.then(() => undefined, () => undefined))
})
```

HTTP close中断fiber，Effect先abort signal，再等待取消finalizer。finalizer只等待原operation，错误由resume/请求中断交付。文件放置路径直接满足MCP validateVoiceInput的既有准入。当前运行时保持Bun1.3.14，事件生产者与请求清理完成点按§28/30修复；§25的Bun1.4.2结果只保留为已撤回路线的历史实证。

### 10.3 锁、固定尝试及写回

`transcribeVoiceFile` 内唯一 `Flock.withLock(configPath, operation, {signal:requestSignal,timeoutMs:120_000})`，覆盖读取、转录与写回；现有竞争机制决定取得顺序。每个 TUI 从自己的 WAV 完成时开始120秒，上传和等锁均计时。

每次开始一个步骤创建 `AbortSignal.any([requestSignal,AbortSignal.timeout(40_000)])`。缓存POST为一次；profile读取加POST共用一次；浏览器CLI从启动到Cookie结果共用一次。所有catch转移先检查requestSignal；各步await正文/CLI结束后检查attemptSignal，成功交付前再检查requestSignal。remaining字段、减法和预算分配数量为0。

写回按 `requestSignal.throwIfAborted(); try { await Bun.write(temp,next); requestSignal.throwIfAborted(); await fs.rename(temp,config) } finally { await fs.rm(temp,{force:true}) }; requestSignal.throwIfAborted()` 执行。rename已完成时保留快照，当前文字交付服从取消。成功或错误后才释放配置锁。

### 10.4 CLI、profile 与子进程

`auth-export --json` 原位直接调用 `exportProfileAuth(signal)`；现有 `/auth/export` 复用同一函数。MCP已配置的BROWSER_USER_DATA_DIR默认指向STATE_DIR/profile，子profile沿用BROWSER_PROFILE_DIRECTORY或Default。读取根路径chatgpt.com Cookie；meta v24按域SHA-256前缀处理；输出只含CookieExport。

Windows/DPAPI/v10/Node24是本机已验证组合；读取操作返回错误时进入 §8 浏览器步骤。DPAPI子进程接入signal，数据库/key Buffer在finally关闭或清零。CLI信号注册移入main，core导入该函数时只加载声明。

Process.run调用中profile使用killTree:true，浏览器CLI使用killTree:false，两者保留1秒升级终止。原Process.run中加入failure controller并与opts.abort组合；closed在spawn后立即监听close。原输出映射后接：

```ts
const pending = [proc.exited, buffer(proc.stdout), buffer(proc.stderr)] as const
const out = await Promise.all(pending)
  .then(([code, stdout, stderr]) => ({ code, stdout, stderr }))
  .catch((error) => {
    failed.abort(error)
    if (!opts.nothrow) throw error
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(errorMessage(error)) }
  })
  .finally(async () => { await Promise.allSettled(pending); await closed })
```

以上补齐既有进程完成合同，原code/nothrow返回规则保留；所有改写计入S11。

### 10.5 浏览器与页面

HTTP语音路由建立disconnect controller，response提前close时abort；与固定40秒timeout组合后传入runVoiceRequest。route finally移除监听。runVoiceRequest调用runtime.withVoice，进入回调先检查signal，再validateVoiceInput和runVoiceTranscribe；保留原 `operation.catch(error => runtime.onFatal?.(error))` 及其完整注释。

原cancelSignal改为一次abort事件，映射VOICE_CANCELLED/VOICE_TIMEOUT，stop移除监听；原makeRequestContext及语音remaining删除。runVoiceTranscribe的direct与cancelSignal组成现有race；withSubmission进入时先检查signal。保留lease/requestID/submitted/queueStarted清理机制，cancelledBeforeSubmission改由signal表示。

两个取消码均执行现有cancelDirectVoice→settle→release/discard；保留500ms取消、500mssettle、1000ms结束检查、3000ms页面关闭及fatal传播。页面fetch固定40秒，保留requestID/controller、提前取消标记及finally删除请求。业务到点触发abort，资源随后完成退出或隔离；共享browser继续运行。

浏览器成功时，在同一submission/lease内把原runAuthExport的CDP Cookie片段移动到文字返回之后，组成 `{text,auth:CookieExport}`。DOM既有bootstrap解析位置保持，成功结果原位增加accessToken；transcribeAudioFile从返回字符串改为返回 `{text,accessToken}`，core直接消费该结果并附入auth。凭据只走私有IPC和用户级配置，公共TUI响应仍为 `{text}`；原耗时日志只记录耗时。CDP detach归入finally。后端唯一authFromHarvest转换并写回，语音外层四次尝试收缩为一次调用。

`chatgpt.js`与`chatgpt-core.js`的既有DAEMON_VERSION同步递增为26；版本差异沿原ensureDaemon退役/启动路径处理。此变更计入S08，保证新CLI消费同次含Bearer的新版auth响应。普通ask/image请求与公开MCP schema保持原接口。

## 11. 路径分类

缓存直连为主步骤；profile与完整浏览器是 §1 用户逐字指定的恢复步骤。取消、最终错误和写回错误结束调用。新增诊断成功路径0，诊断决策面0%。普通ask/image及既有公共浏览器运行保持原用途。

## 12. 删除段 D 与保留设施

| 段标记 | 现有位置/完整语义段 | 处理 |
| --- | --- | --- |
| D01 | voice-auth.ts 的jwtExpiresAt/tokenAlive、6h/48h常量、sessionCredentialUsable、buildSessionRequest/defaultFetchSession、mergeSetCookieCookies | 删除 |
| D02 | 同文件memoryAuth/ensureInflight/authNotices、persistCredential及scope分支 | 删除；保留函数重组后删除原文件 |
| D03 | prompt-voice-input.ts 的direct/argv联合、activeTranscriber、requireTranscriber和本地默认执行 | 删除 |
| D04 | tui.ts/tui-schema.ts 的voice.transcriber、PATH默认、project/env-only语音选择 | 删除；普通MCP保持 |
| D05 | chatgpt.js auth-export的ensureDaemon/HTTP/四次重试、token摘要 | 删除，替换为S07 |
| D06 | chatgpt-core.js runAuthExport的bootstrap/lease；makeRequestContext与remaining；重复语音计时 | 删除，Cookie片段按M03/S08归类 |
| D07 | transcribe-file外层四次尝试；1237/30/80秒等旧语音预算 | 删除，固定120/40秒 |

保留全集：五个UI状态与generation；recorder closePromise/Worker/native停止/terminal/旧音频清理；sdk认证与HTTP close；Effect callback；Flock心跳和租约；Process终止/stdio；JSONC原子写；SessionActivity；browser withVoice/withSubmission/voiceLease/页面稳定与隔离/fatal；页面requestID/controller；共享daemon选主、冷启动、登录及ask/image。全部保留项在 §9–10 有调用位置，§12之外的新增相关设施须先修订审计。

## 13. 原样移动段 M

M是可逐块核对的候选，只有目标代码和完整关联注释与源一致时扣除；编辑过的部分标为S。格式行单列，语义与注释改变均计S。

| 段标记 | 源起止锚点 → 目标 | 关联S |
| --- | --- | --- |
| M01 | voice-auth.ts 中 formatting前解释注释及const formatting；writeVoiceAuth内“定点替换”注释至const next → server/shared/tui-control.ts | S04；函数签名、取消和异常处理计S |
| M02 | prompt-voice-input.ts 的commandExists完整函数；Process.run旁killTree解释及保持原样的调用选项 → tui-control.ts | S04；调用参数/结果形状调整计S |
| M03 | core.js runAuthExport中CDP形状解释与校验、slim映射及完整关联注释 → runVoiceTranscribe同一submission闭包 | S08；try/finally和返回auth计S |
| M04 | tui.ts 中MCP命令数组筛选及mcp-server.js识别、interpreter/script推导的原样子段与注释 → resolveVoiceTarget | S03；来源、路径基准、disabled覆盖、environment计S |

其余跨层级函数整体标为S，内部只有经过上述对应证明的原样子段按M扣除。移出旧文件产生的删除行按D单列。每个M条目实施记录源文件/行段、目标文件/行段、原样非空行数及对应diff锚点。

## 14. 实质增加段 S 与必要性

| 段 | 所有新增/改写内容 | 对应要求 |
| --- | --- | --- |
| S01 | controller取消及120秒、submitVoice、结果与文件完成点 | R01/R07/R09 |
| S02 | 三个组件注入提交函数及提示接线 | R01 |
| S03 | 后端用户配置来源、覆盖、environment；前端删除后的类型接线 | R04/R08 |
| S04 | Cookie及可选Bearer快照读写/解析、文件锁内三步编排、CLI结果解析 | R02/R04/R07 |
| S05 | SendIfAvailable请求、固定attemptSignal、正文消费与状态输出 | R02/R03/R09 |
| S06 | binary endpoint、消息型错误、operation完成点、临时WAV/activity | R01/R07 |
| S07 | 原CLI中的profile SQLite/DPAPI解密、signal、输出及纯导入接线 | R02/R03 |
| S08 | core事件取消、固定40秒、浏览器text+Cookie+Bearer、语音CLI简化、协议版本同步递增 | R02/R07/R09 |
| S09 | DOM固定40秒、成功结果携带实际使用的Bearer及原页面取消语义接线 | R02/R07/R09 |
| S10 | recorder.abort等待已有closePromise再删除 | R07 |
| S11 | Process.run错误时终止并等待全部完成 | R07 |
| S12 | server.ts通过公开IncomingMessage/ServerResponse扩展点保留请求体EOF后的断连通知；响应finish/close归还原生销毁方法，仅补做已延期的正常EOF清理 | R07/R09/I11 |

上述每段包含其新增或修改的注释。跨文件重新组织代码、改函数参数、调整调用时机、改错误处理均归入S。

## 15. 生产文件清单与计数

前12项均位于 `packages/opencode/src/`；操作数16，符合16上限。

| 文件 | 操作 | 段 |
| --- | --- | --- |
| cli/cmd/tui/prompt-voice-input.ts | 修改 | S01/D03/M02 |
| cli/cmd/tui/component/prompt/index.tsx | 修改 | S02 |
| cli/cmd/tui/ui/dialog-prompt.tsx | 修改 | S02 |
| cli/cmd/tui/routes/session/question.tsx | 修改 | S02 |
| cli/cmd/tui/config/tui.ts | 修改 | S03/D04/M04 |
| cli/cmd/tui/config/tui-schema.ts | 删除voice段 | D04/S03 |
| cli/cmd/tui/util/voice-auth.ts | 删除文件 | D01/D02/M01 |
| server/shared/tui-control.ts | 接收移动和更新 | S03/S04/S05/M01/M02/M04 |
| server/routes/instance/httpapi/groups/tui.ts | 修改 | S06 |
| server/routes/instance/httpapi/handlers/tui.ts | 修改 | S06 |
| cli/cmd/tui/prompt-voice-recorder.ts | 修改 | S10 |
| util/process.ts | 修改 | S11 |
| thirdparty/chatgpt-browser-agent/chatgpt.js | 修改 | S07/S08/D05/D07 |
| thirdparty/chatgpt-browser-agent/chatgpt-core.js | 修改 | S08/M03/D06 |
| thirdparty/chatgpt-browser-agent/chatgpt-dom.js | 修改 | S09 |
| server/server.ts | Node HTTP请求销毁完成点与标准socket绑定 | S12 |

总计修改15个、删除1个、新增0个；package.json恢复基线，新增修改位置为既有server/server.ts。测试使用既有文件，生成文件变更0。普通TUI control queue及工作流接线保持。

## 16. TDD 行为切片

按一项RED→最小实现→GREEN推进，测试入口是实际HTTP、CLI、controller、recorder和Process接口。

| 切片 | 既有测试文件 | 可观察结果 |
| --- | --- | --- |
| 认证请求、来源与写回 | test/cli/tui/voice-auth.test.ts | 匿名请求429、浏览器返回快照、第二次发送保存的Bearer及Cookie并成功；profile保持Cookie-only输出 |
| profile导出 | agent test-mcp.js | 独立已知明文SQLite fixture解密一致，浏览器启动0 |
| 三入口及取消 | test/cli/tui/prompt-voice-input.test.ts | HTTP回调收到WAV；迟到文字丢弃；新录音保持 |
| HTTP、等锁、资源完成 | test/server/tui-provider-endpoint-status.test.ts | 两客户端顺序转录；取消后操作先完成再释放WAV/activity/锁 |
| 文件来源 | test/config/tui.test.ts | 用户级覆盖与environment一致，项目文件保持 |
| stop写入期间abort | test/cli/tui/prompt-voice-recorder.test.ts | 先等写入、再删除、上传0；stop错误保持原反馈，随后abort完成清理 |
| 子进程完成 | test/util/process.test.ts | exit/pipe错误和abort后等待close；原nothrow结果保持 |
| 页面及结果 | agent test-mcp.js | 同次text+Cookie；HTTP关闭中止页面；保留fatal回调及下一请求；旧版本经原选主路径切换 |
| 固定计时 | 上述voice/server/agent文件 | 每TUI独立120秒；三次固定40秒；正文计时；早到401立即推进 |
| 运行时断连与连接复用 | 同一HTTP生命周期文件、httpapi-listen.test.ts与最小TCP探针 | Bun1.3.14取消红/绿，以及R13同连接第二次请求超时红/§30修复绿；真实SSE收尾及后继请求保持 |
| rename与取消 | voice-auth.test.ts | 提交前清理临时文件；提交后保留快照并结束文字交付 |

网络fixture验证实际请求；测试用就绪信号控制并发完成点。计时由测试时钟/AbortSignal控制；真实取消使用HTTP断开和CLI退出。生产测试接口新增数0。

## 17. 注释口径

E/C按仓库规则独立计算；总量继续采用 `C >= floor(E*0.15)+1`，E=0时C=0。用户最新要求逐修改文件的新增/改写部分严格超过10%，在函数入口、中段关键决策和收尾处均匀解释原因；每个S段及主要语义chunk保持邻近说明。解释覆盖Cookie-only、profile域摘要、计时、原子提交和完成点。package.json已恢复基线，运行时兼容说明位于实际修改的serverLayer旁。M扣除以原代码和完整关联注释逐块一致为前提，新增说明本身计A；改写、缺失注释的相关移动块归S。测试/配置的E/C单列，生产800行限额按§19。

## 18. 验证与真实验收

| 命令 | 目录 |
| --- | --- |
| bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/config/tui.test.ts | packages/opencode |
| bun test test/server/tui-provider-endpoint-status.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/util/process.test.ts | packages/opencode |
| bun typecheck | packages/opencode |
| npm test | thirdparty/chatgpt-browser-agent |
| git diff --check；逐段S/D/M核对 | 根与子模块 |

真实验收依次完成：profile关闭落盘时原auth-export读取，匿名结果按服务端响应推进；浏览器末级text+Cookie+Bearer写回；后继账户认证直连hello/world且浏览器提交增量保持1；两TUI共用后端及缓存复用；录音/等锁/上传/页面期间取消和新请求成功。session刷新请求0。测试失败保留真实错误，按批准范围修复。

## 19. 统一800行实质增加口径

`A = 生产diff中新增或改写后的非空行 − 经逐段证明的原样移动行`。新增/修改注释计A；改变参数、机制、执行时机或层级绑定的行计A。删除行D独立统计，A采用增加侧计数。格式整理单列并保持最小。原样移动须同时满足代码和关联注释完整；匹配失败即计S，移动名义本身提供的扣减为0。

| S段 | A预算上限 |
| --- | ---: |
| S01 controller与提交 | 70 |
| S02 三处UI接线 | 15 |
| S03 用户配置解析与类型接线 | 45 |
| S04 快照、事务、CLI及写回 | 105 |
| S05 Cookie请求与尝试 | 40 |
| S06 HTTP接口及完成点 | 80 |
| S07 profile与原CLI导出 | 110 |
| S08 core浏览器结果与取消 | 75 |
| S09 DOM | 8 |
| S10 recorder | 6 |
| S11 Process | 24 |
| 语义接线余量 | 22 |
| 既有分段预算合计 | 600 |
| S12 原版本HTTP完成点及说明 | 45 |
| R12已批准认证传递改写预算 | 40 |
| 用户调整的剩余额度，使用仍须归属批准机制 | 115 |
| 合计上限 | 800 |

R12生产diff增加侧非空行484、删除侧非空行840，包含父仓库与子模块；此数包含imports且M扣减采用0，作为A的保守上界。M01–M04候选全部按S计入额度，本次主计量M=0；完整保留的移动块仅在独立E/C核算时按规则排除。删除侧独立展示，增加侧484保持原值。

## 20. 已知事实与验收项

profile离线解密已实测成功。早先Cookie-only HTTP200只证明当时端点接受请求；R12同账户对照确定账户身份由Bearer承载，详见§26。文件占用返回错误后进入指定浏览器步骤。固定业务计时触发abort，清理随后结束。用户级配置与公共浏览器设施已列明，其他语音恢复路径新增数0。

## 21. 双向映射与审计合同

R01→S01/S02/S06→HTTP与三入口测试；R02/R03→S04/S05/S07/S08→Cookie/profile/browser测试；R04→S03/S04→文件与双客户端测试；R05/R06/R10→§13/15/19→逐段计量；R07/R09→S01/S06/S08–S12→完整取消测试；R08→D01–D07→旧引用清理。S12修复事件生产者的运行时行为，复用原NodeHttpServer与Effect取消消费者；新增取消协议、状态或替代服务器数0。所有S段的反向理由见 §14，所有保留设施见 §12。

每轮审计新建上下文，仅接收用户原始要求、本文路径、仓库root和audit mode。覆盖全部R01–R10、实际接口、取消代码及S/D/M口径。blocker先核对归属；复议使用该轮task_id提供事实。实质修订递增revision、清空批准并全范围重审。

## 22. 方案审计记录

R17全范围方案审计及同轮复议 `ses_f4b624102ffeeghVd3yZV0yzOA` 最终原文：

> No blocking findings.
>
> **APPROVE — Revision R17 full-scope plan audit.**
>
> This approval applies only to the canonical R17 plan. Implementation remains prohibited until the primary agent records the clean R17 audit result, then implements the approved revision and obtains a separate full-scope implementation audit.

原初B-01（顶部R16摘要残留）与B-02（历史Bun授权引文）均由同轮复议撤销为blocking，作为non-blocking记录一致性事项保留；600/800历史差异同样明确800为现行上限。本次行政记录同步顶部R17摘要，不删除历史原文、不改变设计。

R16全范围独立方案审计 `ses_f4c9cded5ffeOasMVIQT3nrtNn` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R16，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现发布仍须关闭已知失败、完成当前版本验证和实际计量，并取得全范围独立实现审计批准，之后才满足用户要求的提交前提。

Non-blocking findings原文：

> **N-01：最终验证仍未闭环。** 已直接读取 `D:/Temp/opencode/r15-sse-event-order.log:36` 的 SSE 归零失败及 `D:/Temp/opencode/r15-mcp-final.err.log:1` 的 viewport 失败。R16 §35 给出了对应修复和敏感验证；其余已知失败继续按 §34–35 定向复验。本轮方案批准不构成当前实现通过。
>
> **N-02：历史修订文字仍有残留。** `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md:12` 仍要求取得 R15 批准，顶部元数据与 §35 已明确当前为 R16。属于记录一致性问题；执行及后续批准必须绑定 R16。

N-02已在本次行政记录中同步顶部当前修订说明，设计没有改变。

R15全范围独立方案审计 `ses_f4d060118ffeLai8qpg0JCqCSa` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R15，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现完成仍须通过当前版本验证、实际范围与 A/E/C 核算及完整独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

Non-blocking findings原文：

> **N-01：R15 的窗口 fixture 修正仍待执行验证。** 当前测试直接设置 500×400 布局，再断言恢复到宽 >700、高 >500，没有建立真实大窗口前提（`thirdparty/chatgpt-browser-agent/test-mcp.js:3094`）。生产同步函数依据窗口与布局差值决定是否处理（`thirdparty/chatgpt-browser-agent/chatgpt-core.js:434`）。§32 将修正限定在测试准备阶段，保留原始 pin、同步调用和恢复断言，归属正确。
>
> **N-02：实现验收尚未闭环。** Linux 等价执行、PTY upgrade、当前完整 A/E/C 计量、最终测试及独立实现审计仍须完成。本轮仅检查方案、源码和测试，没有执行命令，也没有将历史通过记录当作本轮独立复现。
>
> **N-03：历史交付措辞仍有残留。** 顶部提交目标及历史 Bun 升级记录应继续按历史材料理解；当前执行约束是保持 Bun 原版本、不操作 git 或远端。它们不构成执行授权。

R14全范围独立方案审计 `ses_f4d0f9b8effeql569KRmM6jLZd` 原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R14，全范围独立方案审计。**
>
> 批准仅适用于该修订。实现完成仍须通过当前版本的行为回归、验证闭环、实际 A/E/C 计量及全范围独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

Non-blocking findings原文：

> **N-01：R14 的运行时验证仍属于实施验收。** 当前 `packages/opencode/src/server/server.ts:218` 仍无条件调用原生 `_destroy`；§30 已明确替换该调用，并安排同一 socket 两次请求的 RED/GREEN、真实 SSE 收尾及原语音取消回归。本轮核对了源码、测试接口和方案敏感性，未执行命令，未将方案记录的探针结果视为本轮独立复现。
>
> **N-02：历史通过记录不能替代当前实现证据。** §29 保留的 Linux fixture 执行域缺口、MCP viewport 波动，以及当前 A/E/C 复算仍须在实现验收中闭环；R12 的测试、构建与计量结果不能直接转用为 R14 通过结论。
>
> **N-03：历史交付措辞存在残留。** 文件顶部及部分历史章节仍含提交目标、Bun 升级与旧状态描述。当前执行边界以最新原始约束和 §28–30 为准：保持 Bun 原版本，不操作 git、远端或提交。

R13全范围方案审计 `ses_f4d548242ffeANhAoSeKDgpkvS` 原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R13，全范围方案审计。
>
> 批准仅适用于该修订。当前实现完成、Bun 1.3.14 等价 CI 验证及最终全量测试尚未由本轮确认；实施完成仍需全范围独立实现审计。本结论不授权 git、暂存、提交、远端操作或 Bun 更新。

N-01：R13运行时与CI验证属于实施验收；N-02：历史运行时文字残留由§28当前合同取代，实施仅依R13。此前暂存内容冻结，额外修改保持unstaged；本轮git、远端、提交、暂存操作数0。以下历史审计保留原文。

R12全新上下文全范围审计：`ses_f4dbffd19ffeJIQzh60NX1CL2f`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R12，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须通过回归、包级检查、构建、真实场景验收、实际 S/D/M 与 E/C 计量，以及全新上下文的独立实现审计。本结论不认定当前实现已完成，也不构成提交或推送授权。

**N-01原文：** R12 的实现证据仍待完成。当前后端仍丢弃 Bearer（`packages/opencode/src/server/shared/tui-control.ts:153`），页面成功结果仍未返回本次使用的 accessToken（`thirdparty/chatgpt-browser-agent/chatgpt-dom.js:828`）。R12 §6、§10.5、§16 已明确对应修复及回归路径；这是方案批准后的实施工作，不构成方案缺陷。

本轮仅执行只读源码、测试及git检查，测试、构建及真实账户请求的历史结果保持独立验收责任。R12新增范围为可选Bearer快照、同次DOM成功返回、已有直连header及私有版本递增；全部计S，估算40行以内，计入800行额度。

R11全新上下文全范围审计：`ses_f4dde4f04ffecUiEB8nvgs8NU8`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R11，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须通过新版运行时下的回归、包级检查、现场验收、实际计量及全新上下文的独立实现审计。本结论不构成实现完成或提交授权。

**Non-blocking finding原文：** R11 的运行时修复仍需完成实现验收。当前 `package.json:7` 保持 `bun@1.3.14`，方案明确将其更新为 `1.4.2`。本轮核对了运行时版本的构建入口、HTTP 断连消费者和回归测试源码；未执行测试，也未将方案记录的通过结果视为本轮独立复现。

R9新上下文全范围审计：`ses_f4f69f620ffe7upyapwtwhOWb0`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R9，全范围独立方案审计。
>
> 批准仅适用于该修订。实现完成仍须具备 RED/GREEN、包级检查、现场验收、实际计量及独立实现审计证据。本结论不构成提交或推送授权。

R8 全新上下文审计：`ses_f4fb35913ffeSCPLBjLVshpqNC`。原文：

> No blocking findings.
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R8，全范围独立方案审计。
>
> 批准仅适用于该修订的方案。实现仍须完成RED/GREEN、包级检查、现场验收、实际S/D/M与E/C计量及独立实现审计。本结论不构成提交或推送授权。

**N-01 原文：** E/C 数值估算尚未单列。§17 明确承诺15%中文解释注释目标，§19将新增、改写注释计入600行预算，但没有分别列出预计 E、C。这是估算记录缺口，未授权降低门槛，也没有证据证明预算必然超限。实施审计须按实际 diff 独立计算。

计量记录补充：估算 E 约700行（生产与测试合计，按§17排除项扣减），R9对应 C 至少106行；最终采用实际 E/C。现场实验复核沿§18完成。R7历史批准任务为 `ses_f4fdb3b49ffePi2x6lmtgY0qwL`。提交授权来自用户本次GOAL的目标终态。

## 23. 实施与提交证据

已完成Cookie请求、三来源转录、用户配置、TUI提交、录音写入/取消、Process管道故障的RED→GREEN。旧voice-auth.ts已在用户明确授权删除后移除，旧JWT/session刷新和前端认证调用退出实现。

| 验证命令 | 工作目录 | 当前结果 |
| --- | --- | --- |
| npx --yes --package=bun@1.4.2 bun typecheck | packages/opencode | R12通过 |
| npx --yes --package=bun@1.4.2 bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/config/tui.test.ts test/util/process.test.ts test/cli/cmd/tui/prompt-submit-transport.test.tsx test/server/tui-provider-endpoint-status.test.ts | packages/opencode | R12最终174通过、4个opt-in用例跳过、583断言；包含真实120秒独立预算与完整HTTP取消 |
| bun test test/cli/tui/prompt-voice-recorder.test.ts test/util/process.test.ts | packages/opencode | 最新录音断言加强后24通过、59断言 |
| npm test | thirdparty/chatgpt-browser-agent | R12最终73通过，syntax/deps通过；前轮EPERM单项与完整重跑记录保留 |
| npx --yes --package=bun@1.4.2 bun run script/build.ts --single --skip-install --skip-embed-web-ui | packages/opencode | Windows EXE、版本启动及compiled voice Worker smoke通过；构建自动改写的models-snapshot.js已恢复至构建前干净基线 |
| git diff --check | 根与子模块 | 通过 |

生产文件为15修改、1删除、0新增，总计16。逐文件非空新增侧粗计如下，全部改写及注释纳入，原样移动扣减0；E/C为diff机械候选值，最终由独立审计核验语义与M排除。

| 生产文件（缩写，对应§15） | A上界 | E候选 | C候选 |
| --- | ---: | ---: | ---: |
| prompt-voice-input.ts | 48 | 37 | 10 |
| component/prompt/index.tsx | 3 | 2 | 1 |
| ui/dialog-prompt.tsx | 6 | 3 | 2 |
| routes/session/question.tsx | 3 | 2 | 1 |
| config/tui.ts | 2 | 1 | 1 |
| config/tui-schema.ts | 0 | 0 | 0 |
| util/voice-auth.ts（删除） | 0 | 0 | 0 |
| shared/tui-control.ts | 193 | 147 | 33 |
| httpapi/groups/tui.ts | 12 | 9 | 2 |
| httpapi/handlers/tui.ts | 46 | 29 | 8 |
| prompt-voice-recorder.ts | 4 | 2 | 2 |
| util/process.ts | 10 | 7 | 3 |
| chatgpt.js | 84 | 69 | 15 |
| chatgpt-core.js | 59 | 50 | 9 |
| chatgpt-dom.js | 12 | 4 | 8 |
| package.json | 2 | 1 | 1 |
| 合计 | 484 | 363 | 96 |

生产候选C/E为26.45%；含测试的机械候选E=1693、C=330、19.49%，测试逐文件最低13.51%、生产最低18%。解释分布在配置来源、三步编排、认证解析、提交点、临时文件完成点及profile解密关键位置；最终合格C及pure-move排除见§24。审计时提交数量0；verified后按本GOAL路径提交，其他工作区内容保持原状。

R12认证RED/GREEN：新测试 `reuses the browser account snapshot after anonymous dictation is rejected` 原结果第二次仍为browser transcript；修复DOM/core快照及后端消费后，后端完整51项通过。MCP对应DOM/core红测试分别捕获字符串返回和缺accessToken，修改后完整73项通过。

真实验收命令为 `CHATGPT_VOICE_E2E=1 CHATGPT_VOICE_DEFAULT_PROFILE_E2E=1 CHATGPT_VOICE_DIFFERENTIAL_E2E=0 CHATGPT_VOICE_USER_CONFIG=<实际用户配置> npx --yes --package=bun@1.4.2 bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "actual default MCP profile"`（packages/opencode；PowerShell用env变量赋值）：1通过、31断言。原profile关闭落盘后导出28条Cookie且Bearer缺席；profile场景真实状态[429,200]、强制browser场景[503,200]（首次503明确注入），两种场景Bearer发送[false,true]、浏览器提交增量1、两次hello/world均命中，快照复用匹配。用户配置逐字未变，私有fixture及音频删除，MCP版本26、连接正常、pending/locks/voice-active/queued均0。

## 24. 实施审计记录

全新上下文全范围实现审计：`ses_f4d9fbc43ffe4ZVY8OOEKwGxKx`，R12当前全部实际diff。初次完成本地验证后提出B-01验收证据缺口；按同轮复议补充原始构建输出、机器产物与真实账户执行授权，auditor独立重验后撤销B-01。生产行为修订次数0，N-01单行测试说明按审计更正。

最终原文：

> No blocking findings.
>
> 撤销 B-01。本轮通过独立执行真实账户验收、核对编译产物哈希及运行两个 compiled smoke，关闭了此前的验收证据缺口。复议保持 R12 原始要求与全部实际 diff 范围。
>
> APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R12，当前实际 diff 的全范围独立实现审计。
>
> 批准包含本次已核对的单行测试注释修正。B-01 已撤销，无剩余阻断项；此结论不替代提交或推送授权。

**N-01已解决，原文：** `packages/opencode/test/cli/tui/voice-auth.test.ts:505` 已正确限定为 profile 的 Cookie-only 输入域；重新运行该文件，51 通过、0 失败、188 断言。

**N-02保留为验证记录，原文：** MCP 首次全套出现子进程 `ETIMEDOUT`，单项复核出现 `EPERM`；随后未修改代码、未调整超时、未跳过用例的完整重跑，73 项全部通过。尚无证据将该启动波动归因于本次生产改动。

最终独立E/C：生产与配置E337/C87（25.82%），测试E1318/C232（17.60%），总E1655/C319（19.27%）。排除空行、文档、import-only、确认的纯移动与仅修改注释的代码行，移动旧注释排除，合格行内解释计入。全部E>0文件超过10%；A采用含imports与注释且M扣减0的保守484行。

独立验收：174通过/4 opt-in跳过、typecheck通过、MCP73通过；实际profile验收1通过/31断言，两场景浏览器各提交一次，后继账户请求200；结束restored/idle/configUnchanged/temporaryRemoved均true。EXE哈希匹配，版本0.0.0-dev-smark-202609180229与voice-worker-probe-ok均独立运行通过。原始RED未重放，当前断言敏感性和GREEN已核对；完整构建生成步骤采用原始执行记录与机器产物复核。提交授权沿用用户GOAL。

## 25. 运行时根因与修复实证

R07/I07要求客户端取消传到后端原操作。生产 `src/server/server.ts:191` 使用node:http与NodeHttpServer；已安装 `@effect/platform-node/src/NodeHttpServer.ts:176` 依赖response.close中断fiber。Windows Bun1.3.14在请求体消费完毕后遇到TCP断开时缺失该通知，因而锁等待、fetch及正文消费持续运行。首个偏离在运行时HTTP事件生产者。

- 最小对照：同一http.createServer + raw net客户端destroy探针，Node24.16收到response.close/socket.close，Bun1.3.14保持静默。
- 直接使用已安装NodeHttpServer.makeHandler的可中断handler：Node触发abort及finalizer，Bun保持原操作；原生Bun.serve + HttpEffect.toWebHandler则触发完整取消。
- 已检查req.close、flushHeaders、100/102/103、响应正文、HttpServerRequest.toWeb及现有WebHandler。req.close表示请求体完成；toWeb的signal需要调用者提供；更换整个listener同时涉及PTY upgrade与shutdown合同。
- `package.json:7`固定bun@1.3.14；构建/test工作流从package.json读取版本，说明此事实涉及产品构建。当前PATH仅发现该Bun可执行文件。
- 用户授权更新Bun后，通过npx安装隔离Bun1.4.2；最小raw TCP探针输出 `response close false`、`{"bun":"1.4.2","closed":true}` 并退出0。
- `npx --yes --package=bun@1.4.2 bun test test/server/tui-provider-endpoint-status.test.ts --test-name-pattern "voice HTTP lifecycle"`（packages/opencode）：6通过、0失败、61断言，覆盖此前三个红用例；测试及生产逻辑保持原内容。
- 真实profile只读探针返回 `ERR_SQLITE_ERROR: unable to open database file`，零Cookie值输出；完整现场链仍按§18验收，现有浏览器恢复步骤保持原合同。

S12直接将标准node:http断连通知恢复的运行时固定为1.4.2，现有NodeHttpServer、Effect、WAV清理及Flock消费链保持原结构。取消映射、私有symbol读取、替代服务器工作流新增数0。先前只读诊断任务：`ses_f4e21a97effevyXHoPU8OiJW78`。新版完整包级回归、构建、现场及独立实现审计继续执行。

## 26. 账户认证根因实证

同一账户、同一音频、28条当前Cookie的六次有界POST：外部Cookie-only、仅加浏览器User-Agent、再加Origin、浏览器页面Cookie-only均为429；浏览器页面及原NetworkProxy外部请求仅增加当前bootstrap Bearer后均为200，hello/world命中。429 JSON的detail为：`You've hit the limit for dictation without an account. Log in or sign up to continue dictating, or try again later.`。

红信号为既有文件中的opt-in实际默认profile验收：两次直连429导致浏览器提交增量2，合同期望1。独立对照排除了本次UA/Origin/代理改变作为修复来源；实际Bearer来自MCP已登录页面，用户粘贴凭据使用数0，session端点调用数0。取值位置就是DOM本次POST已有的accessToken局部量，继续由浏览器维护更新。

profile只读导出Cookie，支持网页SendIfAvailable的匿名输入域；服务端返回401/403/429等结果后沿原三步流程推进。浏览器成功快照提供后续账户直连输入。R12修复S04/S05首个丢失账户授权的边界及S08/S09成功结果生产者，复用原页面解析、文件锁和原子写回，额外刷新机制数0。

## 27. 交付记录

用户在最终权限确认中明确选择“授权本地提交”。MCP提交为 `a317195`（基于实施前已有 `b04aff7`，保留其历史）；主仓库实现与本记录同次提交，标题为 `fix(voice): 将转录归并共享后端并保留浏览器认证所有权`。全部提交保留hooks、普通提交及本地边界。

Windows产物：`packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，版本 `0.0.0-dev-smark-202609180229`，Bun1.4.2构建，SHA-256 `f565feb1868358e757dfca880c0ae6c616b382709e20d62114062af69ea9a668`。构建使用skip-embed-web-ui，已验证CLI与录音Worker。系统PATH原Bun的原位upgrade返回EPERM；本次全部最终回归、验收及编译采用已安装的隔离Bun1.4.2，仓库构建版本固定为1.4.2。

## 28. R13 当前修复合同

最新用户要求：保持Bun原版本；远端及提交撤回，原改动暂存，额外修改只留工作区；后续git、远端、question操作数0；所有增加行逐行对应删除侧超过80%相似原文或计新增，机制变化仍计新增，注释完整保留。计量可采用全部增加行计新增的更保守上界，删除独立统计。当前历史生产上界484，去除package.json升级2行、增加以下监听器修复约35行，预计上界约517，限额800。

已复现：OpenTUI CI原命令在Bun1.3.14为10通过/4失败，起点是DialogPrompt的SDK Provider缺席；HttpApi auth/coverage均157通过/missing1，缺POST /tui/voice/transcribe；静态Puppeteer导入在本地解析成功、模拟干净CI依赖域解析失败。原core代码保持，回退提交的Linux/macOS CI核心门已成功，运行时升级所触发的kill差异随版本恢复退出当前改动范围。

测试修复仅三处：删除已完成诊断的一次性differentialE2E及其私有node_modules静态导入，保留真实profile/browser验收；DialogPrompt测试用真实SDKProvider及原事件清理；exerciser登记真实binary WAV路由并断言401和缺配置502，保留fail-on-missing与fail-on-skip。

HTTP根因：Bun1.3.14的IncomingMessage._destroy在正常body EOF时清掉原handle.onabort；ServerResponse优化绑定还省略socket.close到response.close的标准监听。调用点修复为serverLayer的createServer公开options：

```ts
const server = createServer({
  IncomingMessage: class extends IncomingMessage {
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      if (!error && this.complete && this.readableEnded) { callback(null); return }
      super._destroy(error, callback)
    }
  },
  ServerResponse: class extends ServerResponse {
    assignSocket(socket: Socket) { super.assignSocket(socket) }
  },
})
server.on("request", (request, response) => {
  const finish = () => {
    response.off("finish", finish)
    response.off("close", finish)
    IncomingMessage.prototype._destroy.call(request, null, () => {})
  }
  response.once("finish", finish)
  response.once("close", finish)
})
```

正常EOF只移动原清理时机；响应完成或断开执行原清理，提前上传错误仍走原_destroy。复用NodeHttpServer/Effect取消及原WebSocket/shutdown合同，版本判断、私有symbol读取、新取消registry与新状态数0。内存loopback实证：基线无response.close；上述组合在Bun1.3.14得到aborted=1、cleaned=101（一次取消+100次正常请求）。

行为验证由原voice HTTP集成测试改为调用真实Server.listen，借既有Effect scope管理listener；上游仍是既有独立NodeHttpServer fixture。保留双客户端、等待者取消、原operation完成前资源存活、正文取消、后继请求及50MiB全部断言。集中执行原CI consumer、HttpApi三模式、包级typecheck、相关回归、core原有测试；独立实现审计按全部原需求与当前工作区范围核验。该节为当前修复的具体覆盖，历史R11/R12运行时升级叙述由本节取代。

## 29. R13 定向验证与审计进度

用户最新执行要求：先解决已知失败，逐项最小复现与相关回归；全部修复和审计收敛后才执行最终全量检查。前次600秒全量调用被终端时限中断，后次调用由用户中断；两次均无完整汇总，均不计通过。中断后进程查询未发现对应test-ci或reporter-outfile子进程。后续没有启动新的全量测试。本节只补充证据，不改变R13生产合同或允许增加修改范围。

| 检查与工作目录 | 当前证据 |
| --- | --- |
| `bun typecheck`，packages/opencode | R13通过，Bun1.3.14 |
| `bun run test:ci`，packages/core | 360通过、0失败、658断言、48文件；这是已完成的前轮结果 |
| server/provider/listen/mdns及原OpenTUI四文件组合，packages/opencode | 32通过、7项既有跳过、0失败、143断言；Windows PTY upgrade仍未验证 |
| HttpApi auth、coverage，packages/opencode | 各158通过，fail/skip/missing/extra均0 |
| `bun run script/httpapi-exercise.ts --mode effect --fail-on-missing --fail-on-skip --progress --trace`，packages/opencode | 完整结果156通过、2失败、skip/missing/extra均0；失败为pty.create与worktree.reset；语音场景通过。原始输出tool_0b2c7840e001PBq5N639ww0V2Q |
| `npm test`，thirdparty/chatgpt-browser-agent | syntax/deps通过；MCP在viewport用例断言500x400失败后退出，不能计为完整73项通过 |
| `node test-mcp.js testViewportResyncClearsStaleLayoutSize`，同上 | 单项通过；随后与testPrivateBrowserDoesNotExposeAutomationFlag组合2项通过。原失败尚未稳定复现，重跑通过不等于修复 |

### 已知失败的窄范围归因

worktree：原命令增加`--include worktree.reset --trace`，10.7秒复现400、`Worktree not found`。environment.ts使用`process.env.TMPDIR ?? "/tmp"`，本机未设置TMPDIR时显示`\tmp\opencode-httpapi-global-<pid>`，Windows路径缺盘符。主工作区在F盘、临时仓库在D盘。只在本次PowerShell子进程设置`$env:TMPDIR = $env:TEMP`，保持源码和断言不变，重新执行同一场景得到200，1通过、0失败。后续Windows本地exerciser使用已有TMPDIR入口提供绝对路径，不引入生产路径补偿。

PTY：设置绝对TMPDIR后仅运行`--include pty.create`仍是正常创建500、非法输入场景通过。dsl.ts的controlledPtyInput固定`/bin/sh -c "sleep 30"`，该门的工作流明确运行在ubuntu-latest。同一生产`src/pty/pty.bun.ts` adapter的有界诊断中，`/bin/sh -c "exit 0"`返回`PTY spawn failed`，`C:\\WINDOWS\\system32\\cmd.exe /d /c "exit 0"`返回exitCode0。这证明当前Windows执行域不满足该Linux fixture，不将本地失败改写为CI通过，也不修改其200断言或新增skip。

两场景通过HttpRouter.toWebHandler调用，未经过R13的serverLayer。尚缺Ubuntu等价执行结果；本机docker命令不可用，先前WSL探针未找到Bun。未安装或更新运行时来掩盖该验证缺口。

### 独立实现审计记录

审计任务：`ses_f4d3d9738ffeSGH2366Gap6fVZ`，R13全范围实现审计；原始需求范围保持。初轮及本轮复议原文均包含：

> No blocking findings.

复议发布结论原文：

> **BLOCK — Revision R13 当前实现。**
>
> 复议结果：**N-02 的“历史原始 diff 不可用”部分关闭；当前精确计量仍待完成。N-01 从 pending 更新为 effect 门禁已观察到两项失败。** 当前应优先处理这两项已知失败的归因与闭环，不启动新的完整测试套件。

上述“No blocking findings”指尚未证明新增行为级缺陷，不构成APPROVE。当前状态保持implementation-audit-required，不能沿用R12批准。审计仍待当前增加侧A、E/C与逐文件比例复算、实际范围完整性、keepalive/流式响应/upgrade证据及最终验证闭环。

历史原始diff已恢复可读：父仓库生产tool_0b260cfd2001QUD64uJuFrfpO6、子模块tool_0b260ce18001FlBp0D5UJxX3pb，位于既有`C:/Users/Lenovo/.local/share/opencode/tool-output/`。这些是R12历史diff，含已撤回的Bun升级，必须与当前R13变化分开核对；历史484行和19.27%不标作当前实测。冻结后未执行Git或远端操作，当前修复和本记录仅保留工作区。

## 30. R14 请求销毁完成点修正

### 证据、范围与首个偏离

本轮读取当前serverLayer、真实Server.listen测试及global SSE handler，根及包级AGENTS约束保持；CONTEXT中的Server/AppRuntime职责保持。docs/adr现有条目为triage标签，无HTTP生命周期专属ADR。R01–R10、16个生产文件清单及原语音链全部保持，不以本次回归缩小审计。

**I11（contracted）：** 本次修复不得降低原共享HTTP listener的连接复用与流式响应可靠性。普通客户端可以在同一TCP连接顺序发送两个GET；请求体结束、响应结束是两个独立完成点，原生请求销毁不得被提前调用。

**Observed RED：** `packages/opencode`中Bun1.3.14内存探针创建隔离XDG目录、内存DB和真实Server.listen；一个net.Socket先发送`GET /global/health`，收到healthy后在原socket再次发送。首个响应200、156字节，第二个无响应，5秒上界报`keepalive timeout; bytes=156; sentSecond=true`。探针finally销毁自有socket、停止listener、关闭DB并删除其专属临时目录。最初探针的HTTP framing亦用CRLF明确构造后复核，故不把探针编码问题作为生产结论。

最小对照同样只用一个net.Socket发送两次GET：原生createServer、仅IncomingMessage子类、仅ServerResponse子类、两个子类均得到responses=2；增加R13的finish清理后responses=1且socket关闭。清理时实际request.complete=false、readableEnded=false、destroyed=false。首次偏离就是server.ts:218无条件调用原生_destroy，原运行时把仍未读完的请求当作中断销毁其连接；调用者重连、客户端重试或替换HTTP栈均不属于修复。

### 同一primary path的修正

owner仍是serverLayer的请求生命周期适配。保留R13构造器扩展及正常body EOF延期；仅在响应finish/close完成点归还原生销毁方法。若请求已经因正常EOF进入destroyed、complete且readableEnded，则补做此前延期的原生清理；尚未销毁或提前错误的请求交回原运行时处理，不主动提前销毁它：

```ts
response.off("finish", finish)
response.off("close", finish)
request._destroy = IncomingMessage.prototype._destroy
if (request.destroyed && request.complete && request.readableEnded)
  IncomingMessage.prototype._destroy.call(request, null, () => {})
```

赋回的是该请求原有方法，判断依赖已有stream生命周期属性；不增加标志、注册表、版本分支、独立超时或恢复状态。响应已完成后新发生的请求EOF沿恢复后的原生_destroy收尾，避免继续延期到已经触发过的finish事件。正常已延期、尚未销毁、提前错误是同一请求合同内的完成时序，不是失败后的备用成功路径。删去R13的无条件手工销毁；原注释保留并补充其适用时序。仅在内存探针尝试该修正，responses=2；当前生产文件仍是RED版本，审批前不实施。

### 映射、文件及验证

| 映射 | 所属与证据 | 变更与行为证明 |
| --- | --- | --- |
| I11 → 请求清理owner | serverLayer同时提供普通HTTP和语音listener；上游业务handler不拥有请求销毁 | 修改既有src/server/server.ts的finish；既有test/server/httpapi-listen.test.ts加入一个socket两个成功响应的敏感测试 |
| R07/I07 → 延期正常EOF | WAV读完仍需response.close中断原operation | 保留tui-provider-endpoint-status中的完整取消/锁/文件完成点六场景；不得以keepalive修复撤掉取消 |
| I11 → 流式收尾 | global.ts的onSseClientCountChange本来就向daemon公开连接计数 | 在既有httpapi-listen.test.ts通过真实/global/event收到server.connected后断开，等待既有计数回零及后继health成功，finally复原该测试注册的回调 |
| 方法归还与既有状态条件 → I11 | 当前无条件清理提前关闭连接；仅删除调用又会遗漏已延期EOF收尾 | 复用原生方法和stream状态，不将业务判断或新状态放入transport |

仅额外修改上述1个既有生产文件和1个既有测试文件，生产总数仍16、新增仓库文件0。S12总预算45行；相对R13预计实质代码E增加约4行、邻近中文解释C增加至少2行。两个测试预计E不超过90、C至少14，分别解释同socket判定、等待真实响应而非sleep、stream完成信号、断开前后资源归属和finally清理；不弱化已有注释。整体当前A/E/C最终仍须独立复算，不能沿用历史值。

TDD顺序：先写同socket两请求测试并运行RED；按本节改finish并运行GREEN；再补真实SSE生命周期验证，最后合并原voice生命周期、listener/shutdown/mdns与typecheck。命令均在packages/opencode：`bun test test/server/httpapi-listen.test.ts --test-name-pattern "keepalive"`；`bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts`；`bun typecheck`。平台已有PTY skip保持并明确未覆盖，不能冒充upgrade通过。最终全量检查继续延后到失败归因与修复收敛后一次执行。

已确认风险是请求与响应完成顺序不同，修复必须同时覆盖正常未消费GET、WAV已读完取消、SSE断开以及普通请求完成。其他假想输入不驱动扩展代码。MCP viewport波动和Linux fixture执行域仍按§29保留，不把它们夹入本次生产修复。本节是材料修订，R13批准失效；R14须按原始完整需求重新独立方案审计，再实施并独立实现审计。

## 31. R14 实施证据（尚未完成最终验收）

R14批准后仅修改既有server.ts与httpapi-listen.test.ts。生产finish先归还请求的原生_destroy，再针对destroyed/complete/readableEnded的正常EOF补做延期清理；原五条相关中文注释保持，新增两条解释请求/响应完成顺序和未消费GET的连接复用边界。新增测试通过一个原始TCP socket顺序发送两个health请求，SSE测试通过真实/global/event首事件、客户端断开、daemon原有连接计数通知回零及后继health响应观察完整收尾。

| 顺序 | 命令（工作目录packages/opencode，Bun1.3.14） | 结果 |
| --- | --- | --- |
| RED，生产finish未修改 | `bun test test/server/httpapi-listen.test.ts --test-name-pattern "keepalive"` | 0通过、1失败、11过滤；`keepalive connection closed before both responses`，约3.4秒 |
| GREEN，按批准R14修改finish | 同上 | 1通过、0失败、11过滤、2断言，约3.2秒 |
| 相关回归 | `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts` | 20通过、7项既有平台跳过、0失败、95断言，约26.6秒；含真实SSE和原语音取消 |
| 类型检查 | `bun typecheck` | tsgo --noEmit退出0 |

未启动全量套件，未修改Bun版本、暂存区或远端。Windows跳过项不作upgrade验证证据；Linux执行域、viewport波动、当前全范围A/E/C与最终独立实现审计仍待闭环。当前结果只证明上述R14定向修复，尚不具备verified或完成声明条件。

## 32. R15 可见浏览器测试前提修正

**Observed：** 当前test-mcp.js:3086的viewport测试在隔离profile内启动真实可见Edge，未指定窗口大小，直接把布局override为500x400后调用syncPageViewportWithWindow，再断言宽>700且高>500。生产函数chatgpt-core.js:434依据窗口与布局差值判断，widthGap<=150且heightGap<=250时保持原状；浏览器launch参数没有最大化或固定尺寸。测试注释的“窗口已最大化”不是fixture实际提供的前提。

本轮只在专属临时profile、about:blank及原testing接口执行内存探针，未连接用户浏览器或ChatGPT：默认窗口1050x1000时布局500x400恢复1028x908；控制窗口600x500时没有触发同步，立即及下一animation frame均为500x400，复现前轮失败值；控制窗口1200x900时恢复1178x809，立即及下一帧一致。探针只改变真实窗口尺寸这一输入，使用同一生产同步函数；最后closeOwnedBrowser返回true，临时profile清理完成。

**不变量与首个偏离：** 测试声称模拟“大窗口内renderer卡在小尺寸”，却只固定renderer而没有固定窗口，使合法的小窗口进入正常差值域后被错误断言为同步失败。owner是既有testViewportResyncClearsStaleLayoutSize的fixture；生产的stale判断与同步方法不承担保证测试窗口尺寸的责任。

**唯一修正：** 在既有测试的page CDP session中取得Browser.getWindowForTarget结果，先通过Browser.setWindowBounds设windowState=normal，再设width=1200、height=900。用有界page.waitForFunction等待实际布局达到宽>700、高>500后才设置500x400 override；原fixture pin断言、sync调用和最终恢复断言完整保持。等待观察布局就绪，不增加固定sleep、断言重试包装、扩大测试超时、skip或生产fallback。5秒上界与同仓测试短时就绪检查一致，仅限制测试准备阶段。

| 双向映射 | 责任与证据 | 修改/验证 |
| --- | --- | --- |
| 既有viewport恢复验证可靠性 → 测试窗口fixture | 小窗口时生产明确保持正常布局差值，原测试阈值不能成立 | 仅修改thirdparty/chatgpt-browser-agent/test-mcp.js既有函数，建立大窗口前提 |
| 固定窗口与就绪谓词 → 保留现有同步断言 | 单独设置500x400 override无法保证与真实窗口存在stale差值 | 保留500宽pin及恢复宽>700/高>500；测试仍调用真实syncPageViewportWithWindow |

TDD反馈沿前轮npm test的500x400失败及上述受控窗口实验；批准后先运行原单测记录当前结果，再修改fixture并执行`node test-mcp.js testViewportResyncClearsStaleLayoutSize`及与`testPrivateBrowserDoesNotExposeAutomationFlag`组合。可在小窗口启动的有界诊断中复验前提恢复，结果不能用重复直到通过代替。全量MCP及仓库全量继续留到定向修复收敛后的最终一轮。

生产修改数、生产A、所有语音路径均不变；新增仓库文件0。预计测试E增加6行、邻近C增加2行，原详细注释完整保留；整体当前A/E/C仍待独立计量。此项属于测试行为材料修订，故递增R15并清空批准；重审仍覆盖原始R01–R10/I01–I11/S01–S12。Linux Bun登录shell探针仍未找到可执行文件，Linux等价验证缺口保留；不将其夹带为runtime升级或生产平台兼容修改。

### R15 实施记录

批准后先执行未修改的`node test-mcp.js testViewportResyncClearsStaleLayoutSize`，本次1通过，约4.3秒；不把这次通过当作消除前轮波动的证据。随后按批准范围仅在原test-mcp.js fixture增加4行窗口准备与就绪代码、2行邻近中文原因说明，原pin、同步、恢复及清理断言完整保留，生产函数零改动。执行`node test-mcp.js testPrivateBrowserDoesNotExposeAutomationFlag testViewportResyncClearsStaleLayoutSize`得到2通过、0失败，约8.3秒；`node --check test-mcp.js`退出0。工作目录均为thirdparty/chatgpt-browser-agent。本轮没有全量重跑、依赖或Bun更新、Git或远端操作，最终完整验证与独立实现计量尚待完成。

## 33. R15 Linux定向验证与独立计量

在临时目录`D:/Temp/opencode/bun-linux-1.3.14`准备npm发布的同版本Linux运行时，WSL中输出1.3.14；Windows Bun、package.json和锁文件未变。此步骤补齐本地等价执行环境，不升级已有运行时。WSL工作目录为`/mnt/f/ML/PythonAIProject/Claude-Code/opencode/packages/opencode`，执行文件为`/mnt/d/Temp/opencode/bun-linux-1.3.14/package/bin/bun`。

| Linux命令 | 结果 |
| --- | --- |
| `bun run script/httpapi-exercise.ts --mode effect --include pty.create --fail-on-missing --fail-on-skip --trace` | 2通过、0失败，正常创建200、非法输入400 |
| `bun run script/httpapi-exercise.ts --mode effect --include worktree.reset --fail-on-missing --fail-on-skip --trace` | 1通过、0失败，reset返回200 |
| `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts` | 默认5秒上界下26通过、1个目录绑定测试超时；其余upgrade、shutdown、取消均完成 |
| `bun test test/server/httpapi-listen.test.ts --test-name-pattern "PTY connect token requires matching directory" --timeout 30000` | 1通过，目标用例约5464毫秒 |
| `bun test test/server/httpapi-listen.test.ts test/server/tui-provider-endpoint-status.test.ts test/server/httpapi-mdns.test.ts --timeout 30000` | 27通过、0失败、无skip、126断言，29.81秒 |

30000是仓库script/test-ci.ts既有REPORTER_ARGS，不是修改测试源码或为本次错误新增放宽值。测试使用原有临时fixture仓库；没有操作主/子仓库索引、提交或远端。Linux环境前轮“无可执行Bun”的缺口现已补齐；最终完整套件仍按用户要求留到定向修复收敛之后。

独立实现审计任务`ses_f4cfeb906ffeKW1k0S0qSL5eCa`，完整R15范围，原文结论：

> No blocking findings.
>
> **N-02关闭：四个基线身份已获得独立历史记录支持，当前计量可以正式确认。N-01仍有最终验证缺口。**

N-02由auditor自行读取旧unified diff、恢复删除/移动源文、计算blob身份，并与历史Turbo 2.8.13的opencode#test:ci inputs清单核对。历史清单位于`tool_0ab44e71d001nL6bUGbeMNiow8`，补齐server.ts、dialog-prompt.test.tsx、httpapi-exercise/index.ts和httpapi-listen.test.ts的身份。整个过程没有新Git命令或Git内部读取。

| 当前独立实测 | 数值 |
| --- | ---: |
| 生产操作文件 | 16：15修改、1删除、0新增 |
| 测试文件 | 11 |
| 生产增加侧非空行A₀，含import/注释且不扣移动 | 518 |
| 已核实代码及完整注释原样移动M | 31 |
| 扣除已核实移动的A | 487 |
| 生产E / C | 366 / 93 |
| 测试E / C | 1392 / 246 |
| 总E / C | 1758 / 339 |
| 总C/E | 19.2833% |

auditor确认所有实质增加文件的C/E均超过10%，总量超过15%，增加量低于800；删除行没有抵扣增加量。E排除注释、完整import及已核实纯移动，C排除原样旧注释与无关说明；主交付采用更保守的A₀=518，不依赖相似度扣减。

N-01原文要点：auditor独立运行LinuxBun版本得到1.3.14，核对CI的30000参数；27项结果在该次复议中尚未读取原始执行输出，因此不登记为独立执行确认。其拒绝重跑含git:true的fixture，保留自身不执行Git的边界。最终原文：

> **BLOCK — R15当前实现仍待最终验证闭环。**
>
> 本轮明确关闭N-02，不再保留基线或A/E/C计量缺口。当前剩余事项属于N-01：审查Linux定向执行原始证据，并完成适用的最终验证。当前没有已证明的新增行为级阻断缺陷，但尚不能登记为完整实现发布批准。

上述计量已确认不代表最终APPROVE；状态继续为implementation-audit-required。最终测试须保留可直接读取的原始报告供同轮审计核验，不以父代理摘要替代。

## 34. 最终验证发现的新失败（未关闭）

在定向修复收敛后执行了一轮完整验证，原始日志保存在D:/Temp/opencode：r15-opencode-final.log、r15-httpapi-final.log、r15-core-final.log、r15-mcp-final.out.log及r15-mcp-final.err.log。typecheck退出0。HttpApi coverage/auth/effect各158通过、0失败、0skip/missing/extra；这三个门已在Linux原输入域完成。其余套件未通过，不能将§33计量通过表述为实现完成。

- OpenCode完整core片3648通过、8失败，TUI片766通过、3失败。失败涉及database maintenance CLI三项超时、legacy config不可写、SSE计数收尾、goal progress断言、stale-turn完成、write拒绝、daemon两项生命周期及语音后代就绪。具体名称及堆栈保留在原始日志。
- core包358通过、2失败，均为不可写目录拒绝测试。WSL默认身份实测uid=0；以既有smark普通用户运行两项原断言，2通过、0失败，证据r15-core-permissions-narrow.log。根用户执行与CI身份不等价，原358/2结果不计绿。
- MCP全量再次在viewport断言得到500x400后失败；R15固定窗口前提不足以证明波动已消除。后续同页面10次受控探针均成功，仅说明该探针未再复现，不能撤销完整套件失败。
- SSE已最小化为先运行httpapi-event.test.ts再运行httpapi-listen.test.ts：16通过、1失败，仍为SSE count未归零，日志r15-sse-event-order.log；仅compression前置组合通过。下一步需核对前置in-process流的取消与新测试的全局计数假设，尚未归因或修改生产。
- 语音后代就绪在普通用户下单项仍失败，日志r15-voice-child-narrow.log。挂载盘Bun空启动约4.15秒，原生Linux文件系统空启动约0.029秒，但改用同版本原生运行时后目标单项仍在2.5秒就绪断言失败，日志r15-voice-child-native.log；因此磁盘启动成本不是已证明的完整根因。原生工具位于/home/smark/.cache/opencode-r15-tools，版本保持Bun1.3.14/Node24.16.0；没有放宽就绪断言或业务期限。

本轮最终验证的失败使任务返回定向诊断阶段，不再重复全量长跑。当前独立计量所覆盖代码未因这些诊断改变，后续任何材料修复仍需修订同一plan并全范围审计。目标保持未完成，禁止提交/暂存/远端与Bun升级的边界继续保持。

## 35. R16 测试资源所有权与可观察完成点

最新用户原文：“应当准确全面完整完成相应的任务，并最终解决完所有问题，经过审计之后进行相应的 commit。”“不得工作到一半就直接报告停下，我再次声明一遍。”当前授权完整审计通过后的本地提交及必要的Git检查；仍不推送远端或升级Bun。未通过前保留原暂存内容，修复在工作区。§28–34的禁止commit记录是当时约束，不覆盖本次新授权。

本修订保持全部原需求、生产16文件及800行上限，生产实现不变；只调整两个已证实测试fixture的责任边界。R15只有方案批准，最终套件失败保持真实记录。

### SSE请求所有者

只读诊断任务ses_f4cbddb83ffeEh3PAqda2HfxZN将失败最小化为两个in-process/global/event请求：读取首事件后reader.cancel返回，但GlobalBus listener数不变、计数停在2；再运行新listener测试实际经历2→3→2，其要求1→0因前置资源残留失败。仅abort原两请求后计数依次1→0，新测试原样通过。原global.ts:76明确以Request.signal结束全局PassThrough、heartbeat与订阅，disposeAllInstances没有这些全局请求的所有权。

首个偏离位于test/server/httpapi-event.test.ts的viewer用例：142/145创建请求没有可控signal，185/186只取消reader；Bun1.3.14的raw Response reader取消在此不能替代请求结束。修复该用例，在两个请求之前建立同一个AbortController并传入两次request，finally先abort再保留原两个reader.cancel。两个流均属于该用例，controller无需进入生产；不改全局计数、不改新测试的归零断言、不增加生产清理分支。原双流投影断言和详细注释完整保留。

### viewport完成时序

只读诊断任务ses_f4cbddb06ffekAsYuN23tfZ7Kl在隔离about:blank可见浏览器、1200x900窗口中复现：clearDeviceMetricsOverride于2131.09ms确认，session于2131.53ms detach，2132.43ms读取仍500x400，2135.20ms布局已1178x809、2142ms JS同样恢复。生产与fixture各自保留session均可复现，故不是detach必然故障。一次sync、一次clear、无重试即可最终恢复；省略sync的两个负对照在2秒观察期保持500x400。仅加完成条件观察的12次探针通过，其中三次立即读仍500x400而6–10ms后恢复。

首个偏离是test-mcp.js同步调用后立即读取布局的断言时机；CDP应答并未承诺同tick页面布局已可见。生产helper维持协议调用合同，不添加轮询。仅在原单次sync后使用page.waitForFunction等待现有最终宽>700/高>500条件（5秒上界），然后执行原最终断言；不重试sync、不修改断言阈值、不增加固定sleep、不扩大已有每项60秒期限。新增等待仅观察结果，负对照证明它本身不能修复故障注入。

| 要求/反向映射 | owner与理由 | 文件/敏感验证 |
| --- | --- | --- |
| I07/I11及CI无资源残留 → SSE请求abort | 原fixture持有两个请求；生产已提供正确signal清理入口 | 既有test/server/httpapi-event.test.ts；同一进程先event再listen的17项组合从归零失败转绿 |
| 既有viewport恢复断言 → 可观察布局完成 | renderer异步完成，CDP确认不是布局barrier；测试拥有等待观察的责任 | 既有agent test-mcp.js；保留500pin、单次sync及恢复断言；负对照缺sync仍失败 |

新增生产文件/行/机制0，测试新增文件0。预计SSE E增加4行、C增加2行；viewport E增加1行、C增加2行；原注释完整保留。既有518生产A₀不变；整体E/C实施后重新计量，不直接沿用旧比率。删除/替换仅限SSE缺signal的请求参数与测试即时读取时序，无新备用成功路径，诊断生产决策面0%。

TDD：保留r15-sse-event-order.log的16pass/1fail及r15-mcp-final.err.log原500x400红证据；批准后先修SSE，运行`bun test test/server/httpapi-event.test.ts test/server/httpapi-listen.test.ts --timeout 30000`；再修viewport，执行`node test-mcp.js testViewportResyncClearsStaleLayoutSize testPrivateBrowserDoesNotExposeAutomationFlag`及原负对照。包级typecheck保持。其余全量失败先用普通用户、原生Linux源码与依赖路径复验，避免NTFS模块加载成本：同一原生Bun子进程cwd为挂载包时启动3715ms、/tmp时17ms。修正运行域不能替代未通过结果；DB、daemon和语音子进程失败未闭环前不宣告完成，也不扩大生产范围。

原源码与依赖的Linux原生副本位于/home/smark/.cache/opencode-r16-worktree，准备完成后只执行原失败名称，保持所有超时和断言。其他未证实生产问题不推动修复。R16材料改动须独立全范围方案审计，再实施和独立实现审计；最终所有门禁通过后才可按最新用户授权提交。

## 36. R16 最终实现证据

按批准R16完成两项测试修正，生产文件不新增修改：viewer用例同时拥有两个Request.signal并先abort再cancel reader；viewport保持一次sync，在CDP确认后等待原恢复条件可见。SSE前置组合从16pass/1fail变为17pass/0fail，原始日志r16-sse-green.log；viewport与marker组合2通过。typecheck与父/子仓库diff --check通过。

Linux普通用户smark、Bun1.3.14、Node24.16.0，源码与依赖位于原生文件系统/home/smark/.cache/opencode-r16-worktree。依赖仅从本机现有安装复制，无安装或下载（一次隔离安装请求被策略拒绝后未重试）。完整依赖闭包核对1870包、5060关系、948链接，必需缺失0；源码、测试、脚本逐文件checksum与主工作区一致，.git未复制。记录为r16-snapshot-dependencies.json、r16-import-readiness.json。最初不完整副本产生缺包失败，均保留原始日志；最终结果单列如下，不能把准备期失败删去。

| 最终验证 | 原始证据（D:/Temp/opencode/） | 结果 |
| --- | --- | --- |
| 原生Linux `bun run test:ci`，packages/opencode | r16-native-final-complete.log | core片3656通过/19既有skip/0失败；TUI片769通过/9既有skip/0失败；父runner退出0 |
| Linux普通用户 `bun run test:ci`，packages/core | r16-core-final.log | 360通过、0失败、658断言 |
| Linux `bun run test:httpapi`，packages/opencode | r15-httpapi-final.log | coverage/auth/effect各158通过、0fail/skip/missing/extra；R16仅两个测试fixture修正，没有改变这些路由 |
| Windows `bun typecheck`，packages/opencode | 工具原始退出0记录；r15-typecheck-final.log为前轮同生产版本 | R16修改后tsgo --noEmit退出0 |
| 隔离Linux构建及smoke | r16-build-final.log | 指定channel/version、--single --skip-install --skip-embed-web-ui；编译、Sharp、版本启动、voice Worker全部退出0 |

构建产物为快照packages/opencode/dist/opencode-linux-x64/bin/opencode，版本0.0.0-r16-verification。使用无网络命名空间及现有模型源码，不更新主仓库生成文件。build首次缺显式channel及has-flag依赖，分别通过既有环境入口和本地版本一致链接补齐；没有修改构建逻辑或安装包。

### 最终失败归因与关闭证据

root导致不可写测试假绿的执行域已改普通用户；core完整360通过。DB三项与daemon两项在原生源码/依赖副本按原时限5项全部通过，日志r16-native-remaining.log。语音后代就绪原断言在原生环境通过。Goal测试的四个工具最初因缺tree-sitter资源在执行前失败；补齐本地已装bash/powershell解析器后实际退出分别0/0/0/1、最终断言通过，生产Goal代码未改。完整最终suite再次覆盖并通过这些用例。

### MCP跨平台证据与未验证边界

r16-mcp-final.out.log在Windows记录连续67项PASS（包括修复后的viewport）后停在testVoicePageHealthCheck；无SUITE完成行，不能称Windows单次全套通过。隔离健康用例的独立文件输出r16-health-detached.err.log明确为spawnSync Node EPERM，执行工具在请求20–35秒超时时异常等待约1800秒。重复同机制没有给出有效业务失败，因此停止重复。只读诊断任务ses_f4bf42267ffeTEnwSO3pdcNdeG用WSL普通用户、Node24.16、Linux timeout25秒运行原健康用例：1通过，runtime内部4.5–9秒健康替换断言成立，测试总11.347秒。

余下六项按原命名过滤完整覆盖：健康用例及testTranscribeCancelDoesNotStartAnotherPath/testDirectVoiceSubmitsOnce在Linux分别1+2通过；testVoiceCancelSendSafeOnClosedRes/testEmptyAssistantTurnCompletes/testForegroundPulseInterval8s在Windows3通过，22.326秒。没有新增skip、改断言或改生产health逻辑。合计73个默认测试均有成功执行证据，但单次Windows npm test全套退出0未取得；该平台执行器EPERM属于最终需明确裁决的验证边界，不作隐瞒。syntax/deps阶段已有通过结果。真实账户R12验收保留历史性质，本轮未再次发送账户音频。

### 当前差异及审计

最新用户授权审计后commit后恢复必要的只读Git检查；至此未stage/commit/push。主工作区packages/opencode/config.json仅行尾状态、sdks/vscode/.gitignore及既有未跟踪目录均不属于本任务，不纳入提交。R16相对R15新增测试httpapi-event.test.ts及test-mcp.js等待注释；生产A₀仍518，最终E/C由新全范围实现审计对当前diff重新确认。当前任务未verified，须由auditor审查全部当前diff、最终日志及MCP执行域边界后裁决。

## 37. R17 保留既有fatal终止合同

R16全范围实现审计ses_f4b6f187cffejjiqKogFcKIjpI最终原文：

> **BLOCK — R16 当前实际实现差异。**
>
> 本轮完整审查形成一个必要阻断项 **B-01**。应在既有 owner 恢复 fatal 终止合同、补齐敏感回归，并提供 typecheck 原始结果后，进行同一原始完整范围的实现复审。当前不满足“审计通过后 commit”的前提。

**B-01原文标题：删除旧 request context 时丢失了既有 fatal 终止判定。** 已核对归属：基线chatgpt-core.js的request context在运行前检查runtime.fatalError，本次删除context后runVoiceRequest:2019只保留signal检查。runtime.fail:1742、withVoice:1873和runVoiceTranscribe:1992/2005仍形成可达producer/consumer：前项隔离失败设置sticky fatal，Promise队列启动已排队后项，daemon onFatal仅在setImmediate阶段启动退出，不能阻止更早的Promise任务。此遗漏违反R07/I07及§12保留fatal传播的合同，属于本次修改引入，需修复；不扩展无关故障处理。

唯一修正位置是既有runVoiceRequest的withVoice回调开头，在signal检查和validateVoiceInput之前加入`if (runtime.fatalError) throw runtime.fatalError`，恢复基线fatal优先顺序。复用原错误实例和原onFatal，不创建状态、护栏机制、恢复路径、额外重试或新公共接口。正常路径及固定120/40秒合同不变，生产文件仍16。

在既有testVoiceDeadlineAndForeground中强化最后stalled场景：前项已进入挂起的页面准备后，提交后项进入同一withVoice队列；后项使用同一fixture WAV，在前项仍持有队列时删除该文件，再取消前项以触发现有隔离失败。断言后项立即返回同一VOICE_RUNTIME_FATAL实例，不能返回ENOENT或等待自身取消。等待任务进入以fixture newPage就绪信号同步，不用sleep估计。保留已有fatal回调、页面隔离期限及取消后正常请求的断言。测试在缺fatal检查时确定性捕获后项非法继续，修复后绿。

| 双向映射 | 证据与owner | 文件与验证 |
| --- | --- | --- |
| R07/I07 → fatal先于文件读取/排队提交 | 前项取消不能隔离时runtime已产生fatal；旧context消费该事实 | chatgpt-core.js原runVoiceRequest入口恢复判定；test-mcp.js既有deadline用例覆盖排队后继 |
| 既有fatal检查 → 原可靠性不下降 | onFatal的setImmediate退出晚于Promise队列启动，不代替入口判定 | 后项必须传播同一错误且不消费已删除音频 |

预计生产增加侧+2行（1代码、1中文解释），E+1/C+1；测试E约12/C至少3，原注释完整保留。生产A₀预计520，低于800，新增文件0，新增生产诊断/备用路径0。当前实际R16独立计量E1763/C343、19.46%，该数为历史R16，R17实施后重新核算。R16审计已核验73个MCP默认用例跨平台覆盖、HttpApi三门158各通过、完整OpenCode4425通过、core360通过及构建smoke；Windows单次MCP套件的EPERM依然单列执行环境边界，不能推定为本修正对象。

TDD先执行`node test-mcp.js testVoiceDeadlineAndForeground`捕获RED，再修改原入口，执行GREEN及取消/排队相关测试；该mock-only用例可用已装LinuxNode加25秒timeout运行，避免Windows健康用例的执行异常。随后完整独立实现审计按全部原始需求复核当前diff，typecheck输出保留原始文件。当前材料修订递增R17，R16批准不授权本新增修正，必须先全范围方案审计。

R17实施结果：先补既有deadline用例中的真实排队后继场景。挂载盘Linux首次运行触发原fixture的5秒启动上界（r17-fatal-red.log），不将该超时当作目标RED；Windows同命令随后明确断言失败，actual为`Voice file does not exist`，expected为同一`VOICE_RUNTIME_FATAL`实例，约3.579秒。仅恢复入口fatal检查后，`node test-mcp.js testVoiceDeadlineAndForeground testQueuedVoiceCancelHasZeroSideEffects testVoiceTaskLifecycle testTranscribeCancelDoesNotStartAnotherPath testDirectVoiceSubmitsOnce`得到5通过、0失败、6.491秒，原始结果r17-fatal-green.log。未增加fixture期限或修改原生产取消期限。typecheck退出0，命令结果保留r17-typecheck.log及工具输出。所有日志在D:/Temp/opencode。父仓库生产未再改变，最终Linux4425+core360通过及构建证据仍对应同一父仓库生产内容；子模块本轮2行恢复和13行测试增加待完整独立复核。

## 38. R17 最终独立实现批准

全新上下文全范围实现审计及同轮证据复议：`ses_f4b5b9ca0ffe5X5l1RAoGOVDJ8`。最终原文：

> No blocking findings.
>
> **APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R17，当前实际差异的全范围独立实现审计。**
>
> 同轮复议关闭 N-01、N-02，无剩余阻断项。批准仅适用于本轮核对的 R17 和实际实现差异；N-03 作为明确验证边界保留。

Non-blocking findings最终原文：

> **N-01 已关闭：** 同轮复议已独立执行 `bun typecheck`，成功退出。
>
> **N-02 已关闭：** 本轮通过 `readOnly:true` 数据库连接及 `PRAGMA query_only=ON`，直接核验历史工具记录，确认真实账户验收和目标 RED/GREEN；不再依赖转交文本或历史总结。
>
> **N-03 保留为验证边界：** Windows MCP 单次全套仍未取得成功退出记录；73 个默认用例已有跨平台成功执行证据。Windows 健康用例的 EPERM 不作为生产缺陷，也不表述为 Windows 全套通过。

审计核验的真实账户原始记录：Session `ses_f4d9fbc43ffe4ZVY8OOEKwGxKx` / Part `prt_0b2740d21001iNhDoHqU14unbL`，1通过/31断言/exit0；R17目标RED：Session `ses_f8aefd1efffer9qxMHqUeLpEtq` / Part `prt_0b4a2d47f001P7WD2XZH3atCvZ`，exit1且实际WAV不存在错误；GREEN同Session / Part `prt_0b4a36b02001SxE7SlmfZ8p63h`，5通过/exit0。上述只读原始来源核验不重新访问账户，不输出凭据。

最终独立计量：生产15修改、1删除、0新增；增加侧保守A₀=520、删除侧841独立列出，删除未抵扣。生产E366/C94，测试E1408/C253，合计E1774/C347、19.56%，所有E>0文件超过10%。排除空行、文档、import-only、完整纯移动及仅改注释的原代码行；合格C不包含搬移旧注释与显然说明。父/子diff --check均通过。

全范围路径裁决：共享后端唯一编排、用户指定profile/浏览器恢复、浏览器认证所有权、固定120/40秒、完整取消及原fatal终止合同通过；无新增隐藏重发、替代成功算法、取消状态机。此前R16 B-01生产问题通过R17修复和敏感回归关闭。最终4425个OpenCode、360个core测试、HttpApi三门各158、73个MCP跨平台覆盖、构建/Worker smoke及独立typecheck已核验。真实账户验收保留历史运行时属性，其后listener与fatal差异由当前1.3.14回归覆盖。

状态据本轮原文切为verified；按用户最新明确授权进入本地提交，保留hooks与无关工作区，不push。这次提交不宣称Windows MCP单次全套通过，不宣称已执行远端CI。

## 39. R18 发布后回归证据与修正方案

### 原始新证据与执行约束

用户报告：“近期就只有你的改动”“之前的1.3.14都是正常的，只有你这次有问题”“每次只有进行alt+v的转录，结束的时候必定出crash”，并要求检查远端macOS testCI、禁止task、完整调查。当前已发布基线为父仓库5d1a74dea6、子仓库725cee4。调查不重启现用daemon、不修改账户配置、不升级Bun、不操作远端历史。曾出现的user_abort输出只反映工具abort状态；output-notice.ts:98不记录取消发起者，日志中daemon继续运行，尚无证据把该标记等同用户点击停止或daemon退出。

### I12：编译版上传正文的有效所有权

Observed：截图崩溃发生于Windows Bun1.3.14 standalone；解码链为FetchTasklet.clearData:246 → request_body.detach → Blob.InternalBlob.bytes.clearAndFree:4712 → allocator free。首次偏离在新增submitVoice:16将Bun.file直接交给fetch，进入文件转内部正文分配/释放分支。原native录音器可以保留，不能因native参与就改其生命周期。

已实际运行的最小反馈：D:/Temp/opencode/actual-submit-voice.exe由Bun1.3.14编译，直接import当前生产submitVoice，仅加载已安装pv_recorder.node并向隔离回环HTTP上传已有fixture WAV。约195ms崩溃、exit3，堆栈与用户相同的Blob.detach/FetchTasklet.clearData，不调用用户daemon或外部转录服务。更小的native-loaded-file.exe只require native addon和fetch(Bun.file)，约177ms崩溃，无Worker、录音和音频删除。

单变量对照compiled-native-voice-matrix.exe保持同一真实Worker、短录音、回环响应及清理：file正文第一次崩溃；no-terminate仍崩溃；bytes（先arrayBuffer）和内存Blob均连续两轮通过。源码模式真实录音通过、没有native addon的单次编译file上传通过；故原单元测试和只确认Worker可启动的smoke不足以覆盖组合。复现只使用本地回环，测试录音已清理；崩溃退出的专属临时目录可能保留，仅含诊断音频，不属仓库修改。

修正owner是submitVoice上传入口：先signal.throwIfAborted()，await Bun.file(file).arrayBuffer()，再次signal.throwIfAborted()，然后现有sdk.fetch使用这份bytes。整个读取和上传继续受现有120秒调用信号约束，读取期间不能强行中断文件API，但完成后禁止被取消请求进入网络。URL、认证头、directory、Content-Type、响应解析和本地WAV清理保持原样。统一走字节正文，不增加Windows版本分支、尝试失败后fallback或第二次请求。

### I13：取消测试观察响应生命周期

远端run35359491055的attempt1/job105646939765与attempt2/job105654416613均在voice-auth.test.ts相同四项30秒超时：never advances/cache、profile-post，以及keeps body/cache、profile。两次均4428通过、21跳过、4失败；不是未确认的随机CI波动。原始日志tool_0b535ce0b001hFQ0VKH9UeQqOu、tool_0b5301ce5001iKboSFDlJoHY0s保存在既有tool-output目录。

四项都用未结束响应正文制造等待，并只靠IncomingMessage.aborted兑现closed.promise。该事件描述请求体销毁，不等同响应读取取消。Bun1.3.14本地对照中，正文读完后client为AbortError、request.complete/readableEnded均true，却没有request.aborted；Node标准HTTP对照同样只得到response.close。真实macOS未插入阶段日志，因此当前不能断言每项停在哪一个await；已证明的是其共同取消观测前提不成立，后续必须保留macOS实跑门禁。

拟在既有voice-auth.test.ts原backendFixture中以Bun.serve提供模拟外部转录上游，handler改为标准Request → Response/Promise<Response>。正常用例消费上传后返回原状态/JSON；取消用例在读取正文后监听原Request.signal，返回含原未完成JSON的真实ReadableStream；/ready CLI握手保留可控Promise响应与既有就绪信号。用原生signal观察连接取消，不依赖node:http的请求体事件。该fixture测试的是后端原生fetch事务，不是Effect HTTP middleware；真实生产HTTP/Effect取消继续由tui-provider-endpoint-status.test.ts覆盖，生产serverLayer不修改。已有macOS/Windows不对称事件路径不通过复制生产HTTP补丁解决。

原生fixture的本地可行性探针已经执行：服务端先await request.arrayBuffer()，监听request.signal；返回未完成响应；客户端解析期间abort，输出client AbortError及server Request.signal aborted。只证明该seam本地成立，不替代macOS最终结果。closed就绪等等待使用已有withTimeout明确给出失败阶段，保持原30秒测试总期限，不添加skip或放宽时间，不删除服务端取消、禁止后继步骤、配置字节不变和独立40秒断言。

### 双向映射、范围和TDD

| 要求/不变量 | owner与生产链 | 文件与行为证明 |
| --- | --- | --- |
| R01/R07/I12 | submitVoice拥有上传bytes的生命周期；已有SDK负责认证与目标连接 | 既有prompt-voice-input.ts仅改正文准备；既有prompt-voice-input.test.ts编译真实函数、加载native、单次回环上传后正常退出 |
| R07/R09/I13 | 模拟外部转录上游拥有连接断开事实；请求体完成不代表响应完成 | 既有voice-auth.test.ts调整backendFixture和handler表达；保留四项及全部相关原断言，macOS必须实跑 |
| owned bytes → I12 | native加载后的file正文原生释放已确定性崩溃，内存字节同条件通过 | 不能只断言类型或重新抄写submitVoice，回归必须import真实生产函数 |
| 原生Request.signal → I13 | 旧aborted事件仅保证未完成请求体，不能承载响应取消观测 | 请求正文先完成再取消仍观察服务端断连；不把client抛错代替server资源收尾 |

生产文件仍16（修改现有submitVoice所在文件），新增仓库文件0。测试编译产物及源入口仅放测试专属tmp并在finally释放；Windows用已安装pvrecorder包解析native路径，fixture WAV由已知PCM字节生成，不依赖未checkout的子模块音频或录音权限。兼容回归属于Windows standalone输入域，在Windows CI自动运行，其他平台仍运行原上传/取消测试。构建使用当前process.execPath及Bun.build，不安装或升级工具。

新增生产实质代码预计E4、邻近解释C2，含替换增加侧预算不超过10行，原全任务A₀520加本轮仍远低于800；所有改写注释和测试adapter重写按实质新增计量，不凭相似度扣除语义变化。测试预计E120/C至少20，最终逐文件及总量按原门槛重算。旧fixture所有说明保留其完整意图，描述已失效事件假设的注释改为准确说明响应取消所有权，不能降低详细程度。

TDD顺序：生产import编译回归先跑RED exit3；改submitVoice最小字节准备后同exe回归GREEN，并检查预取消不进入fetch、读取结束后取消不上传、已知音频字节/认证/响应保持。然后原backendFixture迁移，先用“上传读完、响应尚未结束”触发旧事件红信号，再验证标准signal的新fixture；运行voice-auth整文件和原生产HTTP生命周期文件。命令在packages/opencode：bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "compiled|submits|cancels the HTTP"；bun test test/cli/tui/voice-auth.test.ts --timeout 30000；bun test test/server/tui-provider-endpoint-status.test.ts --timeout 30000；bun typecheck。最终Windows实际编译artifact必须执行新增组合smoke，macOS四项及完整testCI必须保留真实结果。未经用户授权不推送实验分支或触发发布来测试。

### 当前门禁

R17已发布实现存在本轮真实回归，其历史APPROVE不能作为R18实施授权。用户先禁止task，随后明确“授权task”，现已完成独立R18方案审计，记录见§40。Windows根因已复现；macOS具体await阶段和修正后的平台结果仍待补齐，不将本地对照说成远端通过。

## 40. R18 独立方案审计

Invocation: ses_f4a956730ffeL0jcs2xtHDwg4T；Audit mode: plan；Revision: R18；full-scope。

首次裁决原文：“No blocking findings.” “BLOCK — R18 暂不批准，独立证据核验未完成。” 独立核验获准后复用同一审计会话，最终裁决原文如下：

### Blocking findings

No blocking findings.

### Non-blocking findings

- **N-01：R18 的 Windows 根因已独立复现。** `D:/Temp/opencode/actual-submit-voice.exe` 和 `D:/Temp/opencode/native-loaded-file.exe` 均在 Bun 1.3.14 standalone 环境中发生 segmentation fault，退出码为 3；前者输出 `Blob`/上传路径相关 Bun 崩溃，后者在 native addon 已加载后直接执行文件正文上传也崩溃。该证据支持 §39 将 owner 定位到 `submitVoice` 的 `Bun.file(file)` 请求正文路径。
- **N-02：`compiled-native-voice-matrix.exe` 未完成完整对照矩阵。** 本次独立执行只记录 `recorded file 0 48128`，随后同样在 Bun 内崩溃，没有产生 bytes/no-terminate 等后续对照输出。因此 §39 中“bytes 与内存 Blob 连续通过”的历史描述不能由当前 artifact 独立确认；计划已经要求新增真实编译回归，不将该历史摘要作为唯一验收证据。
- **N-03：本地现状测试为绿，不能替代 standalone RED。** `bun test test/cli/tui/voice-auth.test.ts --timeout 30000` 得到 51 pass、0 fail；上传/取消定向测试得到 3 pass、0 fail。这些测试覆盖源码运行时和协议行为，无法触发 standalone + native-loaded + `Bun.file` 的崩溃组合。§39 规定的编译产物回归仍是必要门禁。
- **N-04：macOS 原始失败证据已核验。** 两份只读 CI 日志均记录同四项测试在 30 秒超时，结果为 4428 passed、21 skipped、4 failed：cache、profile-post 两个取消等待，以及 cache/profile 两个 response-body deadline 测试。该结果与 §39 的 fixture 事件假设冲突一致。
- **N-05：授权记录存在行政性过时文本。** §39 第957、996行仍保留“禁止task”等历史约束；本轮用户消息已明确授权 task。该项不改变 R18 行为规格，也不阻断计划批准，但实施前应由记录方单独更新。

### Release verdict

**APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R18，full-scope plan audit。**

批准仅适用于 R18 方案本身，不代表 R18 已实施或已通过实现审计。实施后必须继续取得：

- standalone 编译上传 RED/GREEN 原始证据；
- `submitVoice` 预取消、读取完成后取消、正文/认证/响应保持的行为证据；
- macOS 四项取消测试及完整 testCI 结果；
- 最终独立实现审计和实际 E/C 计量。

## 41. R18 实施证据

本轮仅修改已有生产prompt-voice-input.ts及两个既有测试文件；记录方修改本canonical。其他config.json、sdks/vscode/.gitignore、未跟踪调查文档及thirdparty/opencode-11720均不属本轮，保持原样。Bun保持1.3.14。未提交、推送、访问账户或重启现用daemon。

### Red / Green 与集成验证

所有测试和typecheck从packages/opencode执行。

| 命令/反馈 | 实际结果 |
| --- | --- |
| bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "native-loaded standalone executable"，修正前 | RED：真实生产import、已安装native、回环HTTP的EXE segmentation fault，exit3；构建准备错误不计为RED |
| bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "native-loaded standalone executable\|already cancelled\|after the file has been read"，修正后 | 3 pass、0 fail、8断言 |
| bun test test/cli/tui/prompt-voice-input.test.ts | 34 pass、3既有账户E2E skip、0 fail、109断言，含真实120秒测试 |
| 旧Node HTTP fixture先消费完正文，再跑 never advances after cancellation / keeps body consumption | RED：7 pass、4 fail；cache/profile/profile-post/browser旧aborted观测在约30秒超时，随后移除诊断变更 |
| bun test test/cli/tui/voice-auth.test.ts --timeout 30000 | 51 pass、0 fail、188断言 |
| bun test test/server/tui-provider-endpoint-status.test.ts --timeout 30000 | 11 pass、0 fail、76断言 |
| bun test test/cli/tui/prompt-voice-input.test.ts test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/server/tui-provider-endpoint-status.test.ts --timeout 30000 | primary集成实跑：107 pass、3既有skip、0 fail、410断言，194.51秒 |
| bun typecheck | agent并行准备期曾出现编译target类型错误；最终agent及primary独立执行均退出0 |
| git diff --check（仓库根） | 退出0 |

实现主路径为预取消检查→读取独立ArrayBuffer→读后取消检查→原sdk.fetch；没有新重试或fallback、没有生产HTTP/Worker/状态机变更。fixture统一完整读取请求体后交给handler，并使用原生Request.signal观察响应取消；旧依赖未消费请求体触发aborted的临时策略已移除。行为测试保留协议字节、认证、directory、文字结果、请求禁止推进、配置原字节和40秒尝试期限。

### 完整Windows artifact与原始反馈

Invocation ses_f4a739783ffe09TCpWIqf5n6Q1；使用临时隔离副本的原script/build.ts执行 bun run script/build.ts --single --skip-install，包含完整Web UI。未在用户工作树执行会删除dist/改写models snapshot的构建。原构建脚本Sharp、version、voice Worker smoke通过。

完整artifact：D:/Temp/opencode/r18-artifact-verification-20260919/repo/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe；169604096 bytes；SHA256 dfef91fd88bedd6e77725e933527559dd487af586bb0ff44c877ce904fa5a0b3。

ConPTY真实Alt+V组合验证：两个独立完整EXE attach进程共四轮录音→停止→生产submitVoice→回环响应→文字回填→WAV清理，exit均0。上传52268、51244、53292、51244 bytes，均RIFF/WAVE、16kHz、单声道、audio/wav，directory和测试认证头正确；两次录音目录无残留WAV，native哈希与已安装依赖相同。证据位于D:/Temp/opencode/r18-artifact-verification-20260919/verification-final.json及combined-smoke6、combined-smoke7；primary已读取汇总原文件。

隔离构建曾遇到跨盘native导入与OpenTUI重复依赖造成的renderer/WrongGeneration错误，仅修正临时副本的依赖布局后通过，失败日志保留；不是上传回归GREEN证据。核验4949个原仓库输入文件无变化，副本仅构建自动生成models snapshot文本变化，JSON等价。回环返回固定文字，不代表真实ChatGPT账户或MCP外部链路验收；未测试baseline/ARM64或长压。

### 计量与开放门禁

本轮生产增加侧6行（4实质代码、2解释），替换前1行删除；全任务生产仍16文件，历史A₀520加6为526，低于800。prompt-voice-input.test.ts增加165行，E135/C22，排除空行及import-only；voice-auth.test.ts +88/-60，E74/C13，排除import-only。本轮E213/C37=17.37%，分文件50%、16.30%、17.57%。无纯移动或formatter扣减。代表性解释为上传正文所有权、不可中断读取后的取消边界、真实compiled seam、PCM格式、请求EOF与响应取消区别及fixture清理。

完整macOS testCI及修正后的四项平台结果尚不可验证：当前是Windows主机，未获准推送改动到远端分支/触发新CI，也没有已提供macOS执行环境。旧run重跑只会测试旧commit，不能用来验证本地diff。该缺口保留为发布门禁，不能将Windows通过写成macOS通过。独立实现审计尚待裁决，不标记verified或完成、不按旧批准提交。

## 42. R18 独立实现审计第一轮

Invocation: ses_f4a5c4f71ffe5taTTmOWKa9Vjj；Audit mode: implementation；Revision R18；full-scope。同一会话补齐本地执行授权澄清后，保留完整范围复核，最终原文：

### Blocking findings

### B-01 修正后的 macOS 回归与完整 testCI 门禁仍未关闭

- Violated invariant: R18 要求在原失败平台验证四项取消测试及完整 testCI。
- Evidence class: contracted
- Producer and execution path: macOS testCI → `backendFixture` → 实际转录请求 → 未完成响应正文 → 取消或超时 → 服务端断连断言。
- Source evidence: `.github/workflows/test.yml:92`；`packages/opencode/test/cli/tui/voice-auth.test.ts:287`；`packages/opencode/test/cli/tui/voice-auth.test.ts:372`。
- Canonical-plan evidence: §39 I13、§40 验收要求；`docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md:1063`。
- Responsibility owner: R18 跨平台验证及发布流程。
- Concrete production, test, or contract consequence, not estimate, wording, metadata, or evidence-placement discrepancy: 原 macOS 四项失败尚无当前差异的成功运行结果，平台回归反馈循环未闭合。
- Why this is not speculative: 历史失败已有两次原始 CI 记录，macOS 验收属于批准版本的明确门禁。
- Minimal correction direction: 对当前差异取得 macOS 四项回归及完整 testCI 原始结果，再进行全范围复审；Windows 结果不能替代。

### Non-blocking findings

**上一轮“本地独立复跑未执行”的验证缺口已关闭。** 本轮从 `packages/opencode` 独立执行，运行时为 Bun 1.3.14：

| 验证 | 实际结果 |
|---|---|
| standalone 上传、预取消、读取后取消 | 3 pass、0 fail、8 断言；6.08 秒 |
| 两个修改测试文件＋录音器＋生产 HTTP 生命周期 | 107 pass、3 skip、0 fail、410 断言；196.03 秒 |
| `bun typecheck` | 成功退出 |
| 定向 `git diff --check` | 成功退出，仅 LF/CRLF 提示 |

显式关闭账户 E2E，3 个 skip 为既有账户用例。没有访问账户、重启用户 daemon、修改实现或计划、进行远端写操作。修复前 standalone RED 的历史证据未在本轮重新执行；本轮直接确认了当前实现的 GREEN。

### Release verdict

**BLOCK — R18 与当前指定 diff。**

本地独立验证已通过，未发现额外实现缺陷。B-01 的 macOS 四项回归及完整 testCI 门禁继续保留，当前不能标记 verified 或发布完成。

记录方判定：B-01直接对应原用户macOS CI回归和批准要求，保留此项，不扩大生产修改。现有test.yml支持workflow_dispatch，可在获准的临时远端验证分支运行原CI，无需修改workflow；临时分支提交/推送及dispatch尚待用户明确授权，当前工作树不提交、不发布。

## 43. R19 用户指定等价验收

### 最新原文与边界

用户对临时CI分支明确答复：“不得进行相应的CI临时分支，但仍需完成任务，做等价检查，不得进行block，最终完整完成后进行审计+commit”。此消息改变验收方式并明确本地commit授权，禁止临时远端分支与相关CI操作。R19不改R18生产或测试修复；保留所有原有行为断言、时间期限和独立全范围审计，不以跳过失败构造完成。

R18 B-01作为历史发布门禁记录保留；本版以用户要求的等价检查矩阵替代“必须远端macOS实跑”条件，不把Linux运行写成Darwin验证。不增加生产fallback、版本分支、状态机、仓库文件或测试skip。本轮新增生产/测试E0/C0，R18实际E213/C37和累计增加侧预算保持。

### 当前证据与执行环境

已直接读取当前test-ci.ts：原CI默认core/TUI两个子进程，固定每项30秒，保留退出码和JUnit；Windows可选分片但本轮Linux不设置分片。test.yml的macOS命令为bun turbo test:ci --filter=opencode --continue=dependencies-successful --log-order=stream。当前Windows两轮primary/auditor的107tests、完整EXE四轮Alt+V和typecheck证据见§41-42。

WSL Ubuntu-22.04可用，普通用户smark/UID1000，Linux6.6.114.1 x86_64、glibc2.35；已有Bun1.3.14与Node24.16.0，位于/home/smark/.cache/opencode-r15-tools/{bun,node}/package/bin。历史/home/smark/.cache/opencode-r16-worktree仅用作Linux依赖复制源；根lock/package/bunfig与当前一致，依赖解析探针通过，但历史测试成绩不计入本轮。实际无依赖回环探针输出：{"bun":"1.3.14","platform":"linux","bytes":4,"client":"AbortError","serverRequestSignalAborted":true}，exit0；上传正文已读完后才取消未结束响应，复现I13相同公开seam。

### 等价映射与命令

| 原验收责任 | 本版执行证据 | 保留限制 |
| --- | --- | --- |
| I12 Windows native + standalone原始崩溃闭环 | 保留当前真实生产import RED/GREEN、完整EXE Alt+V四轮、native/正文/清理证据 | 仅Windows x64，账户服务使用隔离回环 |
| I13原macOS四项失败的取消语义 | 当前相同测试在独立Linux/POSIX Bun1.3.14执行；fixture完整消费正文，原生Request.signal、禁止推进、配置字节与40秒断言全部保留；Windows对应敏感旧fixture RED已实跑 | 不证明Darwin特定运行时或内核实现 |
| 完整testCI回归 | 从当前工作树隔离复制，真实运行原Turbo依赖构建与opencode test:ci，禁用旧缓存命中，不设置shard，不删测试 | 当前源码哈希、命令、日志和JUnit关联；不能用旧R16成绩替代 |
| 类型与资源清理 | Linux及Windows包级typecheck；原fixture显式收尾、真实进程退出码及无残留WAV | 本轮不执行真实账户E2E，其既有skip保持 |

隔离位置为Linux /tmp/opencode-r19.XXXXXX，复制当前受跟踪源码的工作树内容（含未提交修复），排除真实账户配置、.git、Windows node_modules和缓存；使用独立HOME/XDG/TMPDIR，无继承账户凭据。复制历史Linux依赖但不硬链接、不改源副本，检查workspace manifest/lock/patch哈希、符号链接与native加载。必要正常依赖构建只发生在副本；不改CI配置、不操作远端。测试在专属临时fixture内的git init/commit/config和fixture daemon收尾属于测试自身资源，不涉及用户仓库或现用daemon；最新完整验证/commit要求允许这些既有测试步骤，不能误读成禁止运行测试。

packages/opencode工作目录：bun test test/cli/tui/voice-auth.test.ts --test-name-pattern 'never advances after cancellation|keeps .* body consumption' --timeout 30000；bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts --timeout 30000；bun typecheck。隔离repo根只运行Turbo编排（不直接bun test）：bun turbo test:ci --filter=opencode --continue=dependencies-successful --log-order=stream --force --cache=local:。以45分钟外层上限和原测试30秒期限保留真实失败；全量依赖构建及退出结果写专属evidence。完整CI环境保持OPENCODE_DISABLE_LSP_DOWNLOAD=true、Linux FILEWATCHER=false、关闭账户E2E，NODE/Bun路径明确。禁用测试缓存不改变行为或断言。

所有失败先判断是否本轮实际引入或环境配置问题，只修正隔离环境中确证缺失条件；新生产/测试范围变更必须重新修订审计。最终完整full-scope实现审计覆盖原需求及当前全部diff，核对等价矩阵每项真实结果与未验证限制。只有R19审计APPROVE和本地验证完成后才标记verified，并按用户原要求仅本地commit相关四文件，保留hooks和无关改动、不push。

## 44. R19 独立方案批准

Invocation ses_f4a4cf655ffeUy0tCUtFO58vgg；Audit mode: plan；Revision R19；full-scope。以下分类与裁决原文记录：

### Blocking findings

No blocking findings.

### Non-blocking findings

- **N-01：等价检查有明确平台边界。** R19 §43 保留相同取消断言、Bun 1.3.14、完整 `test:ci` 编排及真实退出码，符合本次交接中用户明确要求的“做等价检查”。Linux 结果只能证明对应 Linux/POSIX 执行路径；Darwin 特定运行时行为仍须列为未验证项，不能报告为 macOS CI 通过。
- **N-02：计划批准不代表验证完成。** §43 的当前源码隔离复制、哈希关联、禁用缓存后的完整 CI、Linux typecheck 尚属于待执行验收。本轮仅进行了只读源码、diff、计划和已有证据检查，没有执行测试，也没有将历史审计结论作为当前实现批准。

### Release verdict

**APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R19，full-scope plan audit。**

批准仅适用于 R19 方案。R18 的 macOS 阻断保留为历史结论；R19 依据交接中的明确用户原文采用等价验收，并保留平台限制。完成 §43 验证及新的全范围独立实现审计前，不能标记实现完成或据此直接提交。

## 45. R19 等价验收实际结果

Invocation ses_f4a525157ffeBcwEPEprY7lm2T；Linux副本/home/smark/.cache/opencode-r19-clean-DP5rF6/repo；证据/home/smark/.cache/opencode-r19-clean-evidence-20260919。使用普通用户smark、独立HOME/XDG/TMPDIR及Git配置，无账户继承，Bun1.3.14、Node24.16.0。未修改共享生产/测试或CI，未远端操作；测试只在隔离fixture使用Git/daemon。primary读取原始日志/汇总及最终更正记录，不采用agent错误摘要。

### 当前源码与依赖对应

复制当前工作树5426个tracked输入，包含本轮未提交实现；排除.git、真实配置/账户、两个子模块、Windows node_modules与产物。共享源码前后变化0；副本仅原依赖build生成sdk.gen.ts和types.gen.ts两个既有生成文件变化。33个manifest/patch无变化。Linux依赖初始复制285903文件哈希匹配，无硬链接，6972链接检查无外部或悬空指向。最终补齐本机缓存中的turbo-linux-64、workspace-local anthropic3.0.71、OpenTUI nested diff9.0.0；native加载及版本探针通过。中间verification-summary.json保留修正前diff8.0.2错误，不能作为最终无错误证明；最终索引为dependency-final-record.txt、native-dependency-versions.json及r19-final-fact-corrections.txt。

### 实跑与命令兼容修正

- 定向原取消场景：7 pass、0 fail、exit0，日志副本evidence/directed.log。
- voice-auth + prompt-voice-input两文件：84 pass、4 skip、0 fail、294断言、137.85秒；其中3个既有账户E2E，1个本轮Windows-only standalone在Linux按批准输入域skip。agent首次“4个全既有”摘要已由primary据原log纠正；Windows该compiled测试已真实执行通过。
- 包级bun typecheck：exit0，日志副本evidence/typecheck.log。
- 原计划--force与--cache=local:同时使用被Turbo2.8.13在测试前拒绝，exit1，失败日志副本evidence/turbo-exact.log。此为工具参数兼容修正，不改测试范围、期限或缓存验收：使用原完整命令加--cache=local:，日志证实三个任务均cache bypass/force executing、0 cached。
- 最终实际命令（隔离repo根）：timeout --signal=TERM --kill-after=30s 2700s bun turbo test:ci --filter=opencode --continue=dependencies-successful --log-order=stream --cache=local:。未设置shard，执行原依赖构建与完整core/TUI子进程，保留30秒每项期限。exit0，core3656 pass/19 skip/0 fail；TUI771 pass/10 skip/0 fail；合计4427 pass/29 skip/0 fail；3 successful/3 total、0 cached/3 total、15m39.477秒。
- 原始日志turbo-equivalent.log与turbo-equivalent-status.txt；JUnit junit-core.xml SHA256 743618b91a8d960d9a81ab0e78103910a0827389245e77a2f55b6a8f426d6705；junit-tui.xml SHA256 a46b966798da52e93e447250b27d6078a2808842e88e24acc3b1c200f47b3678，均在最终证据目录。

准备期失败全部保留：缺turbo-linux-64导致未开跑；Turbo参数冲突；中间副本的空Darwin @types/plist、@types/verror触发TS2688；错误workspace anthropic3.0.64造成一项失败；OpenTUI误解析diff8.0.2。仅修正隔离依赖布局与无效类型目录，恢复manifest要求版本后取得最终全量结果，无共享源文件修改或测试弱化。

### 平台与skip解释

最终FILEWATCHER=false（即禁用开关值为false）；七项FileWatcher skip来自既有FileWatcher.hasNativeBinding()条件，Linux source-run中的OPENCODE_LIBC未定义导致capability=false，filewatcher-runtime-probe.json保留原始stderr和结果；本轮没有新增或修改该skip。其余skip由原平台/账户条件及已批准Windows专用compiled输入域决定。该限制不扩展到本轮语音取消七项，后者全执行通过。Linux不能表述为macOS实跑，Darwin内核/native runner仍未直接验证；本轮按用户明确要求完成等价检查。

R19没有额外生产/测试代码修改，R18 E213/C37及独立计量仍有效；当前三个代码文件与Windows审计时相同。最终full-scope实现审计待执行；不得将验证agent自述的审计桥接失败当本会话审计结果，primary使用正常adversarial-auditor入口。

## 46. R19 最终独立实现批准

Invocation ses_f49c3d8c9ffe6TQhDdouaqglx8；Audit mode: implementation；Revision R19；full-scope。首次裁决为验证待完成，同一会话实际执行后最终原文如下。此前C37为builder/R18计量，最终以本轮独立剔除两条复述后的C35为准，仍满足门槛。

### Blocking findings

No blocking findings.

### Non-blocking findings

- **N-01：等价验收的平台边界保留。** Linux/POSIX 验证符合 R19 用户指定的等价检查方式；Darwin 特定运行时行为仍未直接验证，不能报告为 macOS CI 通过。
- **N-02 已关闭：独立执行验证完成。** 本轮在 `packages/opencode` 使用 Bun 1.3.14 运行四文件回归：107 pass、3 skip、0 fail、410 断言，188.30 秒。三个 skip 为关闭的既有账户 E2E。`bun typecheck` 成功退出。
- **N-03 已关闭：原始崩溃独立复现。** 本轮执行 `actual-submit-voice.exe` 和 `native-loaded-file.exe`，分别在约 230ms、239ms 出现 Bun segmentation fault，均退出 3。当前真实生产 import 的 native-loaded standalone 回归在四文件测试中通过。
- 定向 `git diff --check` 通过，仅有 LF/CRLF 提示。本轮未编辑实现、访问外部账户、操作远端或用户现用 daemon。

### Primary-path and fallback verdict

**通过。**

上传保持唯一权威路径：预取消检查 → 独立字节读取 → 读后取消检查 → 原 SDK 上传。修正落在拥有正文生命周期的 `submitVoice`，没有失败后改走其他正文实现。

既有后端缓存、profile、浏览器编排保持原用户合同，本轮没有增加备用成功路径。新增生产诊断路径为 0。

### Code quality and Chinese-comment verdict

**通过。** 独立按实际 diff 增加侧计算：

| 文件 | E | 合格 C | C/E |
|---|---:|---:|---:|
| `prompt-voice-input.ts` | 4 | 2 | 50.00% |
| `prompt-voice-input.test.ts` | 135 | 21 | 15.56% |
| `voice-auth.test.ts` | 74 | 12 | 16.22% |
| 合计 | 213 | 35 | 16.43% |

排除空行、文档、import-only，以及两处仅复述行为的注释；没有使用纯移动或格式化扣减。三个文件均达到 15% 目标。未发现新增类型逃逸、测试断言弱化、生产职责泄漏或无依据的实现概念。

### Release verdict

**APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R19，当前指定四文件相对 HEAD 的实际 diff，full-scope implementation audit。**

前次待核验事项已关闭。批准仅适用于本次核验的 R19 和实际差异，保留 Darwin 未直接验证及账户 E2E 未执行的明确边界。

记录方据此设置verified。方案审计R18、R19各一轮（R18补齐执行授权后同会话批准），实现审计R18一轮保留旧平台门禁、R19一轮按新用户验收完成。R19没有增加生产行为；全量Linux CI等价、Windows原始崩溃反馈、源码回归、typecheck、完整artifact与独立计量均已获得证据。提交仅包含canonical、prompt-voice-input.ts及两个测试文件，保留无关工作树与hooks，不创建CI分支、不push。

## 47. R20：当前页面输入框合同替换与 HTTP 恢复闭环

### 47.1 原文、范围与约定

> 你应当准确全面完整检查并给出针对性的修复方式和修复方案。那本质上而言，相应的修改的生产代码行数不得超过200行，相应的修改文件数不得超过4个生产文件。那请你给出相应的修改方案以及具体的修改内容，甚至说给出相应的 diff。同时必须确保现行的流程不再会出现类似问题。同时你要保持你的流程逻辑简洁，不要过度的防御型。那本身而言，呃我认为整体的流程应当是比如说旧的逻辑啊或者旧的参数有问题，那本身你使用新的参数组装去进行替换即可。你不要在上面去加啊加啊加啊改啊改啊改。这样你会导致你的主逻辑非常的冗余，函数非常的多。那而且与此同时，当前我进行相应的 ALT 加V进行相应的转录。那理论上而言，Open Code的侧不会受到 DOM 的影响。那本质上而言，它只是进行 HTTP 请求。那如果这个都有问题，那说明从根源处就是都会有很大问题，因为当前我进行了一次请求，它最终 fallback 到浏览器都没有正常成功，所以我认为这是有问题的。

> 当前我试过了，直接alt+v的opencode内置路径仍然不行，还有log在

此前本轮用户明确要求“不修改工作区”；最新消息要求方案及 diff，故只授权本 canonical 文档修改，拟议 diff 不应用。不得把历史 commit/push 指令用于本轮。保持既有认证、取消、期限、原生录音正文修复及解释注释，不扩展状态机、备用 selector、认证刷新或重试。外部网页任意未来改版无法作永久保证；本轮承诺的是当前已观察输入域的完整行为回归与端到端验收，不用测试 fixture 的通过冒充线上已恢复。

约定来源：根 AGENTS.md、packages/opencode/AGENTS.md、packages/opencode/test/AGENTS.md、httpapi/AGENTS.md、CONTEXT.md、first-principles-engineering policy 和 canonical 模板。本轮未找到 thirdparty 内额外 AGENTS 或相关 voice/browser ADR。既有 canonical 全文及 R19 审计由只读研究 invocation ses_f139533f3ffea9KqE11PuKuyGr 核对；新批准只覆盖 R20 原始完整范围。

### 47.2 当前调用链与证据边界

```text
三个 TUI 输入 -> submitVoice(独立 WAV 字节) -> SDK POST /tui/voice/transcribe
 -> resolveVoiceTarget(用户级 MCP 配置) -> 配置文件锁内 readVoiceAuth
 -> cached Cookie + 可选 Bearer 的 NetworkProxy HTTP POST
 -> 无缓存/401/403 时 offline auth-export + Cookie-only HTTP POST
 -> 仍未成功时 CLI transcribe-file -> daemon bootstrap -> voice page stability
 -> page fetch /backend-api/transcribe -> 同次 text/Cookie/Bearer -> 原子写回
下一次录音从已写回的缓存重新 HTTP 直连。
```

缓存直连与 profile HTTP 不调用 DOM。浏览器启动和 voice lease 都消费 DOM 的 sessionPageFact，因而末级恢复会受 DOM 影响。浏览器恢复失败时没有新快照提交；后继 Alt+V 仍使用此前快照。此为可达因果链，不证明用户那次第一步的具体状态码。

| 证据/源文件 | 观察与用途 | 分类 |
|---|---|---|
| chatgpt-dom.js:856-906、15 处旧输入框引用 | 要求旧 ID 才判 authenticated；还影响 Project 状态、等待、fill/send、附件及 image 表单范围 | observed |
| chatgpt-core.js:1700-1735、2382-2514 | startup/voice 共用上述事实；不收敛会刷新/退出；不能只修 TUI | reachable |
| chatgpt.js:898-955 | Node24、DPAPI/v10、只读 SQLite 离线导出 Cookie，不产出 Bearer | observed |
| tui-control.ts 全部 voice 路径 | HTTP 现有 Cookie/Bearer、multipart、代理、分支与原子写回；前两步异常未保留给最终调用者 | observed |
| prompt-voice-input.ts、handlers/tui.ts:134-166 | 真实 TUI 到后端路径、WAV/活动租约清理、末级错误交付 | reachable |
| packages/core/src/network-proxy.ts；src/util/process.ts | provider fetch 保留 headers/body/signal；Process.run timeout=1000 是 abort 后 kill grace，不是一秒执行期限 | observed |
| test-mcp.js:2798、voice lifecycle/export 测试 | 旧 fixture 自带 prompt-textarea，无法发现当前真实网页移除 ID | observed |
| voice-auth.test.ts:188-205、209-240、取消/期限测试 | 已有 HTTP 持久化与恢复分支的行为 seam，不能拿假 browser text 代替本轮真实页面验收 | observed |
| 用户手动网页听写 | 用户报告当前网页输入与听写正常 | contracted |

日志位置为用户目录 C:/Users/Lenovo/AppData/Local/opencode/chatgpt-browser-agent/state/daemon.log；不复制凭据。14256 行记录 08:22:50Z `...after one reload: inconsistent`。最新 14274-14277 行记录 09:13:23Z 启动、09:13:27Z `Navigating frame was detached`。本轮探针与用户操作曾时间重叠，frame/Target closed 不能直接归因于新的生产竞态；不据此新增生命周期机制。C:/Users/Lenovo/.local/share/opencode/log/2026-09-29T082132.log 仍只有启动记录，dev.log 为空，未找到该次直连上游状态。

**必须保留的不确定性：** 未读取当前生效用户配置的认证缓存；此前敏感配置读取预检拒绝，未绕过。无法从现有日志还原用户那次 cached POST 是 401、429、网络失败还是缺快照。严禁把“缓存过期”“Cookie 变格式”写成已证实事实。需要获准的、仅输出状态/认证字段存在性而不输出值的实际调用证据，或者修复后的用户原路径闭环，才能进一步判定。此项限制不授权修改 HTTP 参数。

### 47.3 已执行反馈与最小复现

全部使用当前代码，未给 production 打补丁。命令工作目录分别为 thirdparty/chatgpt-browser-agent（Node）和 packages/opencode（Bun）。临时浏览器只用于诊断，未发送聊天消息；HTTP 测试音频是内存中生成的一秒 16kHz PCM 静音 WAV，结果空 text 属合法 200，不等于真实语音准确率验收。浏览器 profile 自身缓存更新位于用户目录。

1. **原探针 RED/单变量对照：** Node `CHATGPT_TEST_HOOKS=1` 导入 core.testing，使用 launchBrowser、prepareBootstrapPage、dom.sessionPageFact。页面 HTTP 200、ready complete、authStatus logged_in、token 存在、无登录按钮；唯一可见输入框为表单内 div.ProseMirror、role=textbox、contenteditable=true，无旧 ID。原探针连续返回 inconsistent。仅临时赋旧 ID，原函数返回 authenticated；还原 ID，原函数再次返回 inconsistent。未改变 Cookie、网络、token 或原函数。
2. **HTTP 原路径：** Bun 导入原 buildDirectTranscribeRequest、NetworkProxy.fetch，对当前浏览器 Cookie + Bearer 发 POST，HTTP 200、hasText=true、textLength=0、无 cf-mitigated。不是重新实现一个 fetch 成功来替代原路径。
3. **profile 单变量实验：** 原 exportProfileAuth 真实离线成功，29 cookies、session cookie 存在、无 Bearer。固定这份 Cookie、同一 WAV、同一原 HTTP 构造：不带 Bearer 为 429；只补当前 Bearer 为 200/hasText=true/textLength=0。证明本机当前 Cookie 解密与传输并非必然失败，但不证明用户缓存内容。
4. **页面 fetch 对照：** 当前 bootstrap Bearer、credentials=include、file multipart，返回 200/hasText=true/textLength=0。初次诊断脚本误将 Web Response.status 当函数，捕获 TypeError；已纠正诊断脚本后重测，不将其作为 production 失败证据。
5. **反证修正：** 早先确实见到 HTTP403/cf-mitigated=challenge，但随后的多次 HTTP200 仍稳定重现旧 selector 故障。challenge 脚本存在本身不能证明页面被挑战阻挡，因此撤回其为共同根因的判断。

最小 RED 可复现程序主体（不含账户凭据）：

```js
const before = await dom.sessionPageFact(page, { waitForTerminal: false })
// 页面由 MCP 原启动方式取得；只在实验新页面临时改变一个属性并恢复。
const saved = await page.evaluate(() => {
  const el = document.querySelector('form [contenteditable="true"][role="textbox"]')
  const id = el.getAttribute('id')
  el.id = 'prompt-textarea'
  return id
})
try {
  const during = await dom.sessionPageFact(page, { waitForTerminal: false })
  console.log(before.kind, during.kind) // 实测 inconsistent authenticated
} finally {
  await page.evaluate(id => {
    const el = document.querySelector('#prompt-textarea')
    if (id === null) el.removeAttribute('id')
    else el.setAttribute('id', id)
  }, saved)
}
console.log((await dom.sessionPageFact(page, { waitForTerminal: false })).kind)
// 实测恢复后 inconsistent；本属性补写仅为诊断，禁止带入生产方案。
```

### 47.4 不变量、首个分歧与责任

| ID | 不变量/支持输入域 | 首个分歧与 owner | 修复/验证 |
|---|---|---|---|
| V20-1 | 正常已登录的当前网页可完成启动与 voice page 准备 | DOM adapter 把旧 ID 等同 composer 存在 | 替换定位合同；原 sessionPageFact 在无 ID 当前 DOM 上返回 authenticated |
| V20-2 | 同一 composer 的 Project、文字、附件和发送消费者一致 | 15 个 literal 仍绑定旧 ID | 全部一次替换，保持表单归属和原操作顺序；submit/附件/Project seam 回归 |
| V20-3 | 有效缓存 HTTP 成功时不进入 browser；恢复成功写回供下一轮直连 | HTTP 实验可成功，用户该次首步原因未观测 | 保持 HTTP 代码；cache401/403→profile429→browser成功→下一轮cache200 闭环验收 |
| V20-4 | 正常调用使用修复版 daemon | CLI 同版本会复用已加载旧 adapter 的进程 | 沿既有版本淘汰合同同时 bump CLI/core；不新增重启机制 |
| V20-5 | 取消、固定期限、无秘密日志、无重复提交保持 | 尚无本轮违反证据 | 重跑既有行为回归，禁止为了通过而弱化认证或增时 |
| V20-6 | ≤4生产文件、≤200生产修改行；无过度防御 | 用户约束 | 计划3文件；同时报告新增侧及增删总量，删除不抵扣；不新增 helper/state/fallback |

支持范围：当前 ChatGPT 首页、Project/对话内实际 composer；非表单的其它 editable 不属于 composer。定位不依赖中文 aria-label、CSS 构建哈希、ProseMirror-focused 或旧 ID。没有证据要求 selector 候选数组、按失败逐个尝试、token 解析器或代理切换。现有 frame 导航恢复不扩展。

### 47.5 单一路径与替换清单

将 chatgpt-dom.js 内全部 15 处 `#prompt-textarea` 替换为同一个 CSS 合同：`form [contenteditable="true"][role="textbox"]`。保留原 querySelector、waitForSelector、waitForFunction 的使用位置、可见性/期限和 closest('form') 操作；直接替换参数，不引入新的函数。认证判断仍要求原 bootstrap、token、无登录入口，不通过删除 composer 检查绕过故障。

旧 ID 查询全部退出生产；不保留 `old || new`、selector 列表、运行时补 ID、通用“任意 editable”或中文 label 后备。为保持现有重复调用结构，本轮只替换 literal，不增加 page.evaluate 参数层或新的 resolver 框架。统一替换由完整调用点清单和行为测试约束，不用源码 grep 充当功能测试。

CLI/core DAEMON_VERSION 从26同步改27，仅触发既有正常调用的版本选主。其意义是代码版本失配，非 IPC schema 修改。部署时子模块已提交引用随主仓库正常分发；当前方案阶段不操作 Git 或现用 daemon。

现有附加路径清单：cache/profile/browser 属用户明确合同，保留；浏览器启动的既有 reload/cold recovery 保留，本次没有新增；模式/附件既有行为保持。新 alternate success path=0，新诊断生产分支=0，变更诊断决策面=0%。不为不可还原的旧 HTTP 错误添加新日志状态或“缓存修复”算法。

### 47.6 文件清单与预算

| 文件 | 拟议变更 | 生产新增侧/增删总量预算 |
|---|---|---|
| thirdparty/chatgpt-browser-agent/chatgpt-dom.js | 替换15处输入框 literal；邻近补充3条解释，保留原注释 | 18 / 33 |
| thirdparty/chatgpt-browser-agent/chatgpt.js | DAEMON_VERSION 26→27，补1条版本原因注释，保留凭据合同注释 | 2 / 3 |
| thirdparty/chatgpt-browser-agent/chatgpt-core.js | 同步 DAEMON_VERSION，补1条版本原因注释 | 2 / 3 |
| thirdparty/chatgpt-browser-agent/test-mcp.js | 修正现有网页 fixtures，覆盖无旧ID真实DOM、submit/Project/附件及认证反例；版本复用回归 | 非生产，预计80–180行实质修改 |
| thirdparty/chatgpt-browser-agent/test-voice-robustness.js | 更新现有独立页面断言的旧ID fixture/定位，使实测不再绑定退休属性 | 非生产，预计5–15行 |
| packages/opencode/test/cli/tui/voice-auth.test.ts | 新增完整401/403→profile429→browser快照→第二次cache200一项行为切片，沿用fixture | 非生产，预计25–45行 |
| 本 canonical | R20 方案、拟议diff、审计 | 非生产 |

生产新增侧预计22行、增删总量39行，保守上限60行；3生产文件，新增文件0，依赖/config/generated修改0。不能以净增代替计量。若证据证明另有生产缺陷，先修订本 canonical 并重审，仍受4文件/200行约束，不能占第四文件猜修。

### 47.7 拟议 diff（尚未应用）

以下省略 unchanged context，15处替换逐项列出；函数名是定位锚点，实施以当时文件为准。

```diff
--- a/thirdparty/chatgpt-browser-agent/chatgpt-dom.js
+++ b/thirdparty/chatgpt-browser-agent/chatgpt-dom.js
@@ readProjectHomeState
-        composer: !!document.querySelector('#prompt-textarea'),
+        composer: !!document.querySelector('form [contenteditable="true"][role="textbox"]'),
@@ selectComposerMode
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ selectImageAspectRatio
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ uploadFiles
-        await page.waitForSelector('#prompt-textarea', { timeout: 15_000 });
+        await page.waitForSelector('form [contenteditable="true"][role="textbox"]', { timeout: 15_000 });
@@ clearComposerAttachments
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ waitForComposer
-    await page.waitForSelector('#prompt-textarea', { visible: true, timeout: 45_000 });
+    // 当前网页移除了输入框 ID；以表单内可编辑 textbox 定位，避免语言或构建样式改变影响等待。
+    await page.waitForSelector('form [contenteditable="true"][role="textbox"]', { visible: true, timeout: 45_000 });
@@ readSessionPageFact
-        const composer = !!document.querySelector('#prompt-textarea');
+        // 会话就绪与实际提交使用同一输入框合同，不能把已退休 ID 的缺席当成未登录页面。
+        const composer = !!document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ waitForUploadReady
-        const input = document.querySelector('#prompt-textarea');
+        const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ attachmentState
-        const input = document.querySelector('#prompt-textarea');
+        const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ fillPrompt
-    await page.waitForSelector('#prompt-textarea', { visible: true, timeout: 45_000 });
+    await page.waitForSelector('form [contenteditable="true"][role="textbox"]', { visible: true, timeout: 45_000 });
@@ fillPrompt / waitForFunction
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ replaceComposerText
-      const el = document.querySelector('#prompt-textarea');
+      const el = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ clickSend / waitForFunction
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ clickSend / before
-      const input = document.querySelector('#prompt-textarea');
+      const input = document.querySelector('form [contenteditable="true"][role="textbox"]');
@@ clickSend / evaluateHandle
-    const handle = await page.evaluateHandle(() => document.querySelector('#prompt-textarea')?.closest('form')?.querySelector('button[data-testid="send-button"]'));
+    // 输入框改为语义定位，发送按钮仍归属其表单，不能扩大为页面全局按钮。
+    const handle = await page.evaluateHandle(() => document.querySelector('form [contenteditable="true"][role="textbox"]')?.closest('form')?.querySelector('button[data-testid="send-button"]'));
--- a/thirdparty/chatgpt-browser-agent/chatgpt.js
+++ b/thirdparty/chatgpt-browser-agent/chatgpt.js
@@ DAEMON_VERSION
-const DAEMON_VERSION = 26;
+// 页面适配已替换旧输入框合同；正常调用必须淘汰仍持有旧 adapter 的 daemon。
+const DAEMON_VERSION = 27;
--- a/thirdparty/chatgpt-browser-agent/chatgpt-core.js
+++ b/thirdparty/chatgpt-browser-agent/chatgpt-core.js
@@ DAEMON_VERSION
-const DAEMON_VERSION   = 26;
+// 与 CLI 同步代码版本，避免新客户端复用旧的页面就绪判定。
+const DAEMON_VERSION   = 27;
```

### 47.8 正反映射、TDD 与验收

正向：V20-1→sessionPageFact/bootstrap/voice→DOM literal→无ID页面RED/GREEN；V20-2→全部15消费者→同文件替换→Project/submit/附件实际行为；V20-3→transcribeVoiceFile/read-write auth→仅测试→跨两次请求的真实HTTP/原子快照；V20-4→ensureDaemon/version→CLI/core常量→旧daemon被正常调用退役、新版本被复用；V20-5→既有取消/lease/截止时间→无生产变更→原回归；V20-6→diff文件清单→审计实际增加侧/总修改。

反向：新 selector→V20-1/2，旧ID真实消失、直接参数替换足够；版本常量更新→V20-4，原同版本进程会保留旧函数，复用既有淘汰机制即可。新增helper/state/config/parser/retry=0。不新建 Cloudflare 分类分支，不移除身份检查，不把profile凭空变成Bearer producer。

预定公共测试 seam：createChatGPTDom 的 sessionPageFact/projectHomeState/submit、CLI 正常调用与本地daemon协议、后端 transcribeVoiceFile 及真实 `/tui/voice/transcribe`。实施依次 red→最小替换→green，不在方案阶段改测试。

1. 真实浏览器 fixture 使用手写 `<form><div role="textbox" contenteditable="true"></div></form>`，故意无ID且不从生产导入selector；原 sessionPageFact 必须RED。保留logged_out、缺token、登录入口冲突、loading/Mutation收敛及返回不含秘密；增加表单外 editable 不满足合同的反例。
2. 原 submit 公共入口在无ID fixture 完成文字输入、可信send、用户turn确认；Project状态、附件归属/清理与既有 image 表单选择测试采用同一实际页面形态。不能只在probe补ID让旧消费者继续运行。
3. 用既有 backendFixture 让旧cache401/403、profile429、browser返回同次有效Bearer与Cookie；第一轮成功并写回，第二轮仅cache HTTP200。断言真实headers、文字、配置快照与无后继CLI，而非只断言stub返回成功。保留预取消/读后取消、配置锁、错误写回、固定40/120秒的原测试。
4. 使用既有版本fixture证明旧版daemon在新CLI正常调用时被淘汰；新版本不被重复淘汰。不是在发布脚本中无条件stop或kill。
5. **最终用户原路径验收不可省略：** 用户实际安装的OpenCode、有效MCP目标、一次已授权真实短录音，经本地HTTP/浏览器恢复取得文字并按正常事务写回；紧接着第二次录音从缓存直连成功。记录上游状态、字段存在性和daemon是否被调用，不记录值。没有这组证据时不能宣称“内置Alt+V已恢复”。实测必须与其它profile实验串行，探针只关闭自身新建页，禁止把MCP-owned误当experiment-owned关闭用户窗口。
6. 发布前在真实首页及Project/对话页验证composer、send和附件控件可用。当前初始页面未找到 `#upload-files`，但尚未执行附件控件展开或上传，不能据此断言其移除，也不能宣称附件已验收；若公共upload行为失败，必须查明实际控件生命周期后修订此方案，禁止直接换通用file input猜修。不得在完整验收中静默skip此项。

定向命令（实施后）：thirdparty/chatgpt-browser-agent 下 `node test-mcp.js testSessionPageFactUsesBootstrapAuth`，以及新增/受影响既有公共行为测试的实际名称；随后 `npm run test:syntax`、`npm run test:mcp`。packages/opencode 下先 `bun test test/cli/tui/voice-auth.test.ts -t "reuses the browser account snapshot"` 与新增三步切片，再四文件voice/真实HTTP相关回归及 `bun typecheck`。最终一次相关完整CI编排，沿R19平台边界记录真实平台，不反复全量或冒称macOS已实跑。

注释预算：production E≈17，C=5，dom E15/C3，两个版本文件各E1/C1；全部保留既有详细注释。测试 E 约80–160，邻近约束/fixture来源/敏感输出/两次请求意图中文注释 C≥ceil(E×0.15)，实施按实际diff核算，不以既有注释充数。最终新增侧、删除侧、生产文件数、每文件E/C均由独立审计复算。

### 47.9 风险、开放证据与审计合同

当前首步cached请求的现场状态未取到；profile Cookie-only429和同Cookie加Bearer200已独立实测，但不替代该现场事实。不需要用户决定新业务分支，原三步合同继续有效。若后续获准读取配置，只在受控进程中使用，输出限定字段存在性/HTTP状态；先前拒绝不得绕过。新selector适配当前DOM，外部未来任意改版无法保证；通过真实DOM形态回归、各消费者一致替换和发布前真实闭环降低同类遗漏。

本轮恢复仍未实施。独立审计须重建全部三个生产文件拟议diff及直接消费者、HTTP两轮闭环、所有新增测试计划和边界；不能把“网页可手动用”或新鲜凭据200作为内置路径通过。Reject：Bun升级、API参数猜换、从Cookie推导Bearer、新增验证码绕过、加超时、更多重试、selector回退链、frame错误驱动新状态机。

R20 implementation evidence/audit：不适用，本轮只有方案，不得标verified或提交实现。

### 47.10 R20 独立全范围方案审计

Invocation：ses_f13888865ffedRjWmzIFP9C6LN；Audit mode：plan；Revision：R20；full-scope；第1轮。以下保留审计分类与裁决原文；本次批准不是运行恢复证明。

#### Blocking findings

No blocking findings.

#### Non-blocking findings

- **N-01：现场 HTTP 首次失败原因仍未确认。** `transcribeVoiceFile` 的前两阶段会继续进入后续步骤，最终错误不足以还原缓存请求的状态，见 `packages/opencode/src/server/shared/tui-control.ts:105`。R20 明确保留这一不确定性，并要求两次真实录音闭环，因此不阻止方案批准；实施后不能仅凭新鲜凭据 HTTP 200 宣称 Alt+V 已恢复。
- **N-02：本次独立核验限于源码、测试及现有日志。** 日志确有 `after one reload: inconsistent`，见 `C:/Users/Lenovo/AppData/Local/opencode/chatgpt-browser-agent/state/daemon.log:14256`。本次未重新执行浏览器单变量实验、联网转录或测试命令；§47.3 的实验结果没有被当作本审计独立复现的结果。

#### Rejected speculation

- 不把 `Navigating frame was detached`、`Target closed` 直接归因为新的生产竞态；现有材料不足以排除实验与用户操作重叠。
- 不要求新增 selector 后备链、认证刷新、代理切换、重试或延长期限。
- 不凭初始页面缺少 `#upload-files` 判定上传合同已经失效；R20 已把真实上传行为列为不可静默跳过的验收项。
- 不把未来任意网页改版、多输入框假设或未证实的 Cookie 格式变化作为新增防御逻辑的依据。

#### Requirement and traceability coverage

审计对象为 `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md` **R20，§47 全部有效增量**。

| 要求／不变量 | 独立核验与覆盖结论 |
|---|---|
| Alt+V 的 HTTP 与浏览器职责边界 | 三个 TUI 入口共用 `submitVoice`；后端缓存和 profile 请求不读取 DOM。浏览器末级通过 CLI、daemon、页面稳定检查后才执行转录。 |
| V20-1：修复错误的页面就绪判定 | `chatgpt-dom.js:868` 确实将旧 ID 存在性作为认证条件；`chatgpt-core.js:1714` 和 `chatgpt-core.js:2382` 消费该事实。修改位于 DOM adapter，未绕过 token 或登录态检查。 |
| V20-2：所有 composer 消费者一致 | 独立检索确认生产文件中恰有 15 处旧 selector，拟议 diff 全部覆盖；包括 Project、等待、输入、发送、附件及 image 表单定位。计划包含公共行为测试。 |
| V20-3：恢复后下一轮 HTTP 复用 | `tui-control.ts:125` 接收浏览器文字及认证快照，成功后写回；下一轮在锁内重新读取。计划新增三阶段失败／恢复及第二轮直连测试，并另设真实 Alt+V 验收。 |
| V20-4：正常调用取得新代码 | `chatgpt.js:546` 已按版本决定复用或淘汰 daemon；CLI/core 同步升级常量有直接消费者，不需要新生命周期机制。 |
| V20-5：取消、期限和错误语义 | 拟议生产修改不改变这些机制；计划保留并重跑相关回归，不以增加期限或重复提交掩盖故障。 |
| V20-6：修改规模和简洁性 | 3 个生产文件；15 处参数替换、2 处版本替换及邻近说明。按拟议 diff 为新增侧 22 行、删除侧 17 行，总量 39 行，低于两项用户限制。 |

测试敏感性成立：无旧 ID、具有表单内可编辑 textbox 的 fixture，会使当前 `sessionPageFact` 返回 `inconsistent`；替换后才能满足预期的 `authenticated`。提交测试继续验证可信点击和新增 user turn，未降低成功标准。

反向映射完整：新增生产概念仅为统一 selector 合同及同步代码版本；没有新增 helper、状态、配置、解析器或依赖。

#### Primary-path and fallback verdict

通过。

- 缓存 HTTP → profile HTTP → 浏览器转录属于已有、用户明确要求的编排；R20 不增加第四条成功路径。
- DOM adapter 统一替换旧定位参数，不保留 `old || new`、候选列表或运行时补 ID。
- 浏览器同次成功结果提供文字、Cookie 和实际使用的 Bearer，后端原子提交后供下一轮使用，见 `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1960`。
- 既有启动恢复和 image 行为保持原状；本次新增 alternate success path 为 **0**，新增诊断决策面为 **0%**。

#### Code quality and Chinese-comment verdict

方案阶段通过；实际 implementation diff 尚不存在。

拟议生产代码 **E=17、C=5，C/E≈29.4%**；其中 DOM 为 15/3，两个版本文件各为 1/1。注释解释定位合同、表单归属及版本淘汰原因，具备有效性。测试修改明确承诺按实际 E 补足至少 15% 的邻近中文解释注释。

拟议修改没有无关重构、接口扩大或新增防御层。最终生产与测试的实际 E/C、文件数及增删行数仍须在实施审计中重新计算。

#### Release verdict

**APPROVE — 仅批准 R20 方案。**

该结论覆盖三个生产文件的全部拟议修改、直接消费者、测试计划及真实两轮 HTTP／浏览器恢复闭环，不代表当前 Alt+V 已恢复，也不构成实现发布批准。

本次未修改任何文件，未启动或停止 daemon。实施完成仍须通过 §47.8 的真实录音、第二轮缓存直连、页面消费者验收，以及完整独立实施审计。

## 48. R21：实际缓存拒绝已复现，补齐认证持久化 owner 修复

### 48.1 新授权与需求原文

> 那我的opencode的内置的转录为什么不行？我试了好多次我说过了，必须找到问题，我现在内置转录直接越过或者很快失败就进入下一个浏览器环节
>
> 我进行过不下十次，且最近一个小时
>
> 全部完整进行，我授权你读取全部完整等任何凭据
>
> 所有的读取都授权
>
> 理论上所有的auth都是从gpt的mcp或者浏览器读取的，理论上应该有，没有说明有问题，而且之前都行，必须找到根源问题以及解决方式，不得采用手动填补的方式
>
> 理论上直接浏览器读取应当包含的
>
> 那按照我的实测呢，之前的时候我们明明都是可以去进行的。也就是说之前的时候，它都是可以去进行相应的这个AUTH的一个保存啊等等的一些机制，而且它相应的这个Cookie呀，相应的这个认证内容都是包含的，之前都是正常

读取授权发生于明确说明 Cookie/Bearer 风险、仅内存使用和脱敏输出之后。它不授权手填认证、改写真实配置或把方案当实施；§47 的 4 文件/200 行、简洁替换与只写方案限制继续有效。

### 48.2 现场事实与历史来源的区别

**Observed：实际缓存直连已复现。** 运行 package-local Bun，导入原 resolveVoiceTarget、readVoiceAuth、buildDirectTranscribeRequest 和 NetworkProxy.fetch。真实解析来源为用户级 `opencode.json` 的 `mcp.chatgpt`，解释器 D:/Program Files/nodejs/node.exe，脚本指向本工作树 chatgpt.js。原缓存有26项Cookie、均可发送、session Cookie存在，access_token和accessToken均不存在；fetched_at为2026-09-29T08:07:52.122Z。仅输出结构及非敏感元数据。

固定内存静音WAV，原缓存请求连续返回HTTP429，耗时602、572、537、521ms；最后经脱敏读取的上游原文为：

```text
You've hit the limit for dictation without an account. Log in or sign up to continue dictating, or try again later.
```

这明确是本次Cookie-only请求被按无账户听写额度拒绝，不是40秒期限提前触发。tui-control.ts:110只在401/403时开启profile步骤，因此本次429约0.6秒后直接进入浏览器，符合用户重复观察；前两步错误未保留解释了最终只见浏览器错误。§47.3 已实测固定profile Cookie只补当前Bearer即429→200；不得把该补值诊断转为生产手填或常驻凭据。

**Observed：磁盘形状不是字段别名漏读。** 只读核验 invocation ses_f1331ae11ffeNaaDvu3n8Q8tr9 确认真实auth只有cookies/fetched_at，无environment覆盖。浏览器成功路径 dom.transcribeAudioFile→core.runVoiceTranscribe→CLI JSON→authFromHarvest→writeVoiceAuth 确实保留同次accessToken，当前代码没有该路径中已证实的单字段剥离。离线exportProfileAuth则按合同只产出Cookie，不能将两种producer等同。

**仍不可反推：** 当前文件无写入审计历史，无法证明08:07:52快照由哪一次操作写入。以下持久化缺陷是用原公共入口独立复现的真实缺陷，但没有证据把它断言为这次快照缺Bearer的唯一历史来源。可能出现“整个auth被删→profile成功补回Cookie-only”这一现有可达链；目前不宣称其在用户当天实际发生。此前正常保存/使用与后续写入丢失并不冲突。

### 48.3 新的 RED：无关全局配置更新删除认证

只用合成凭据、隔离 HOME/XDG/TEMP，调用原 `Config.Service.updateGlobal({model:'synthetic/after'})`，不是复制写回算法。真实fs和Config.layer，账号/安装依赖沿用test/config/config.test.ts的既有测试层，禁止真实MCP执行。运行记录 invocation ses_f132dcdf8ffe7T1SqWZIfQhhCq，临时根 D:/Temp/opencode/config-auth-probe-a0dcd2c7bba24c51bb0427e34f636afa，Global.Path全部位于该根。

| 原入口观察 | Cookie-only 合成字段 | Cookie+access_token 合成字段 |
|---|---|---|
| 更新前auth存在且内容相同 | true | true |
| 无关model更新成功 | true | true |
| 更新后磁盘auth存在 | false | false |
| 返回配置auth存在 | false | false |
| command/enabled保留 | true | true |

独立primary纯内存原ConfigParse.schema(Config.Info,...)重现：beforeAuthPresent=true，afterAuthPresent=false，remainingMcpKeys=[type,command]。服务实验使用opaque合成payload来证明整个字段丢失；正式回归另用真实VoiceAuth字典形状和fetched_at，避免无效fixture掩盖生产兼容。

**首个分歧：** config/config.ts:815-820的`.json`分支把schema解码后的公共配置对象当成原始持久化文档整体序列化。config/mcp.ts没有私有auth字段，所以schema在嵌套解码时剥离整个auth，随后无关更新将其永久写掉。`.jsonc`已有patchJsonc原文定点修改路径，不存在这次整体序列化分歧。

**owner：** 全局配置持久化，不是HTTP请求构造、Cookie解密、TUI或浏览器提取。Config.update项目级写入不是本次用户级voice配置来源，不扩展修改。

### 48.4 修复选择与第四个文件

保留R20三个生产文件全部替换；增加且只增加 `packages/opencode/src/config/config.ts` 的 updateGlobal 修复：`.json`与`.jsonc`统一走已有patchJsonc，对原文只修改用户请求的字段，schema只验证更新后的有效配置并生成原有公开返回值。删除`.json`专属的schema→merge→整体JSON.stringify分支。没有新helper、auth备份、迁移、fallback、配置项或token填补。

**不采用在MCP schema加auth字段的简化。** 已用内存schema实测它会把auth同时带入decode/encode；global GET/PATCH和instance config GET均用Config.Info返回，且未设置server password时现有服务可不鉴权。将私有凭据纳入公共返回形状会扩大泄露面。复用原文patch既保留磁盘快照，又保持公开schema剥离auth的现有边界；无需新增redaction代码。

```diff
--- a/packages/opencode/src/config/config.ts
+++ b/packages/opencode/src/config/config.ts
@@ updateGlobal
-      let next: Info
-      let changed: boolean
-      if (!file.endsWith(".jsonc")) {
-        const existing = ConfigParse.schema(Info, ConfigParse.jsonc(before, file), file)
-        const merged = mergeDeep(writable(existing), patch)
-        const serialized = JSON.stringify(merged, null, 2)
-        changed = serialized !== before
-        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
-        next = merged
-      } else {
-        const updated = patchJsonc(before, patch)
-        next = ConfigParse.schema(Info, ConfigParse.jsonc(updated, file), file)
-        changed = updated !== before
-        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
-      }
+      // 公共 schema 不包含语音认证快照；它可验证配置，但不能替代原文作为整份文件的写回来源。
+      // JSON 与 JSONC 都只修改请求字段，磁盘私有认证保留，公开返回值仍由原 schema 限定。
+      const updated = patchJsonc(before, patch)
+      const next = ConfigParse.schema(Info, ConfigParse.jsonc(updated, file), file)
+      const changed = updated !== before
+      if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
```

保留验证成功后才写盘、writableGlobal过滤plugin_origins与空shell语义、changed/invalidate、现有文件选择优先级。复用既有`.jsonc`的叶子patch规则，数组仍整体替换；空对象patch的无操作语义需加入JSON/JSONC一致性测试。明确由用户更换整个MCP条目或mcp add的行为不在本次自动保留承诺中，不加入额外合并护栏。

### 48.5 不变量、映射与预算更新

新增V21-1：更新无关全局设置不能删除既有私有认证；producer=writeVoiceAuth，consumer=updateGlobal/.json持久化，首个分歧=decoded对象整份写回，owner=config/config.ts。新增V21-2：保留磁盘认证不能扩大公开Config.Info返回；由原schema和原返回链保障。其余V20-1至V20-6仍完整适用。

正向：V21-1→updateGlobal→复用patchJsonc→真实公共服务更新前后auth精确保留；V21-2→schema/返回→无schema修改→result.info/GET编码无auth。反向：移除`.json`独立序列化分支→V21-1/2→原公共服务RED与公开编码证据；没有新增概念、helper或分支。新增alternate success path=0、诊断分支=0%。

总生产文件4个。R20拟议diff为+22/-17；本文件拟议+6/-15，合计+28/-32=60行增删，保守≤80，远低于200；不以删除抵扣增加侧。新增文件0，依赖/generated/schema修改0。production E≈21、C7，每文件仍满足中文解释比例。本修订增加测试文件packages/opencode/test/config/config.test.ts（非生产），预计50–100行，保持测试E/C≥15%。

### 48.6 新增TDD与完整恢复验收

在已有config测试层加一条垂直切片：原`.json`含有效形状Cookie/Bearer快照→只更新model→磁盘auth保持完全相同且新model生效，原实现RED；最小替换后GREEN。参数化`.jsonc`保持原行为。返回result.info必须不含auth，不把秘密打印到断言错误。再覆盖Cookie-only、重复同值patch的changed=false、空shell删除、数组替换、嵌套设置/空对象patch、非法配置不落盘、plugin_origins不持久化；使用已有测试避免重复实现。

两阶段原场景门禁扩展为：浏览器正常转录自动产出Bearer和Cookie→原writeVoiceAuth提交→无关全局设置变更→后继原readVoiceAuth仍取得同一完整快照→下一次Alt+V原HTTP直连成功。不能手填token来获得GREEN，不能只验证直接请求构造函数。实际失败现场缓存429已证实，集成用例另覆盖cached Cookie-only429→直接browser恢复，准确对应本次分支，而非仅401/403→profile429。

定向运行package-local `bun test test/config/config.test.ts -t "global"`，新增保留认证测试使用明确名称并执行；随后完整config文件、voice-auth、原四文件voice/HTTP回归与bun typecheck。子仓库保持§47所有DOM、版本与真实页面消费者验证。全量只在定向全部通过后执行一次，最后全范围独立实现审计，仍不能把本方案批准当运行恢复。

### 48.7 证据边界与审计

R20 N-01的“当前缓存首步原因未确认”由实际cache请求及上游错误关闭；“历史上哪次写入造成缺Bearer”仍未知，不能混为一项。新发现持久化错误独立复现，与当前快照历史来源无关也违反已持久化凭据不应被无关设置清除的不变量。此前正常的用户报告保留为事实，不暗示用户手动损坏配置。

本轮只诊断并修订方案；真实配置和认证未改写，生产和测试未修改。R21批准必须重新覆盖原需求、R20全部DOM/HTTP恢复内容和本节持久化修复；不得只审第四文件。旧R20批准不适用于此修订。独立审计待执行。

## 49. R22：统一写回保持原支持的类型替换

### 49.1 R21 全范围审计记录

Invocation ses_f13257ca8ffeB900SVoDvlYXBs；full-scope plan audit；R21；第2轮。分类与裁决原文：

#### Blocking findings

### B-01 全量改用叶子 patch 会破坏 `.json` 配置的合法类型切换

- **Violated invariant:** 修复认证持久化时，必须保留全局配置接口已经支持的有效更新；不能使原本成功的配置更新失败。
- **Evidence class:** reachable。
- **Producer and execution path:** 已有 `opencode.json` 包含 `"formatter": false`；客户端通过全局配置 PATCH 提交 `{"formatter":{"prettier":{"disabled":true}}}`。两种形状均通过现有 schema。请求进入 `Config.updateGlobal` 后，R21 将其改送 `patchJsonc`；该函数递归至 `["formatter","prettier","disabled"]`，最终尝试向已有布尔节点添加属性，触发异常。
- **Source evidence:** `packages/opencode/src/config/formatter.ts:12` 明确接受 Boolean 或配置字典；`packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:74` 使用 `Config.Info` 校验 PATCH；`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:158` 直接调用更新服务；`packages/opencode/src/config/config.ts:352` 的 patch 递归没有处理已有非对象节点；`node_modules/jsonc-parser/lib/umd/impl/edit.js:159` 对此抛出 `Can not add index to parent of type boolean`。原 `.json` 分支在 `packages/opencode/src/config/config.ts:817` 使用 `mergeDeep`，其对象覆盖语义见 `node_modules/remeda/dist/chunk-PDQFB3TV.js:1`，允许该更新。
- **Canonical-plan evidence:** §48.4 拟议 diff；§48.6 的回归清单未覆盖布尔值到对象的有效切换。
- **Responsibility owner:** `Config.updateGlobal` 及其原文更新逻辑。
- **Concrete production, test, or contract consequence:** 使用 `.json` 的用户无法通过现有接口将 formatter 从布尔设置切换为对象配置；请求在写盘前失败。问题在旧 `.jsonc` 路径中已经存在，但本方案把它新引入原本支持此操作的 `.json` 路径，因此属于本次变更的回归。
- **Why this is not speculative:** 输入是公开 schema 明确接受的两种配置形状，上游没有禁止二者切换；从 HTTP handler 到依赖库异常分支的路径完整可达，无需假设损坏配置或未来输入。
- **Minimal correction direction:** 在配置持久化 owner 内保留原有合法类型替换语义，同时保留未被请求修改的私有认证。补充经 `Config.Service.updateGlobal` 执行的类型切换回归；不要引入失败后换另一种写入算法的 fallback。

#### Non-blocking findings

- **N-01：历史来源仍不能确定。** 源码支持“无关 `.json` 更新会删除私有 auth”的结论，但无法据此认定它就是当天 Cookie-only 快照的唯一来源。§48.2、§48.7 已保留这一边界，应继续保留。
- **N-02：本次为静态方案审计。** 独立读取了当前源码、依赖实现、相关测试和拟议 diff；未执行 shell、联网转录或浏览器实验。方案记录的现场 HTTP 结果没有被当作本审计独立复现的结果。

#### Rejected speculation

- 不以未来网页改版、假想多个 composer 或未证实的 Cookie 格式变化要求增加 selector 后备链。
- 不将 frame detached、Target closed 直接认定为新的生产竞态。
- 不要求从离线 Cookie 推导 Bearer、手填 token、新增认证刷新或延长期限。
- 不因初始页面缺少上传控件就断言附件流程失效；真实公共上传验收仍须执行。
- 不把其他未修改的既有恢复逻辑单独作为本轮 blocker。

#### Release verdict

**BLOCK — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R21。**

B-01 未解决，当前修订不得批准实施。需要修订配置持久化路径及其类型切换测试，再进行完整范围复审。DOM 修复方向和认证丢失的 owner 判断成立，但不能据此越过新增配置回归。

### 49.2 判级核对与最小修订

B-01 确实属于本轮把 `.json` 路径改为原文 patch 新引入的行为回归，owner 仍为同一个 config/config.ts；不扩大文件范围。保留 §48.4 的单一路径，修正既有 patchJsonc 在对象合并与节点替换之间的判断：只有目标已有对象且补丁也是对象时递归；其余情况原位整体替换这个节点。删除“无论原节点类型都递归”的错误假设，不采用 catch 后第二写入算法。

新增V22-1：公开配置schema接受的布尔值/对象切换、对象缺席时建立、数组替换及空对象语义保持既有`.json` mergeDeep的结果。owner=原patchJsonc，证据=formatter公开输入合同和依赖modify的错误分支。改变的是同一算法的支持输入分支，新增诊断/备用成功路径为0。

附加拟议diff（仍未应用；与§47、§48的拟议diff共同构成完整R22）：

```diff
--- a/packages/opencode/src/config/config.ts
+++ b/packages/opencode/src/config/config.ts
@@
-import { applyEdits, modify } from "jsonc-parser"
+import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser"
@@ function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
-  if (!isRecord(patch)) {
+  const root = parseTree(input)
+  // 只有双方都是对象才逐字段合并；布尔开关切换为配置对象或原节点缺席时，必须整体替换该节点。
+  if (!isRecord(patch) || (root && findNodeAtLocation(root, path)?.type) !== "object") {
```

使用已安装jsonc-parser的实际AST API；不新增依赖、helper或缓存，不用类型断言/non-null断言。根文档与子节点由同一递归规则处理，数组/标量沿原modify直接替换；最后仍由原Config.Info验证后才写盘及返回。

### 49.3 设计实验、TDD与预算

已在packages/opencode通过Bun内存实验运行上述拟议递归规则及实际jsonc-parser/remeda依赖，七组输出 `matchesExistingJsonMerge=true`：boolean-to-object、object-to-boolean、missing-object、empty-missing-object、empty-existing-object、array-replacement、preserve-auth。该实验是方案算法对照，不冒充已修改的生产服务GREEN。

在§48.6公共Config.Service.updateGlobal测试中加入上述合法类型切换，JSON与JSONC分别执行；测试独立写出固定期望对象，不在正式测试中复制patch算法或仅比较实现细节。缺席空对象应建立对象，已有对象收到空对象补丁保持原内容；此处覆盖并更正§48.4先前笼统“空对象无操作”的描述。所有认证保留、公开结果不含auth、invalid更新不落盘和voice端到端验收保持。

四个生产文件不变。附加import+1/-1、函数+3/-1，完整预计新增侧32、删除侧34，增删总量66，保守≤90（限额200）。有效production E≈23、C8；本文件E6/C3；原DOM E15/C3及两个version文件各E1/C1保持。新增函数0、配置项0、依赖0、公开schema修改0。

R22全范围审计待执行，须同时覆盖§47全部DOM消费者、§48实际HTTP证据/认证保存修复和本节类型切换，不能只复查B-01。尚未实施，当前真实Alt+V仍不可宣称恢复。

### 49.4 R22 全范围独立批准

Invocation ses_f131e47afffeXLYNLobu9Mpq6A；full-scope plan audit；R22；第3轮。以下保留分类和裁决原文，旧R21 B-01已由本轮全范围审计复核。

#### Blocking findings

No blocking findings.

#### Non-blocking findings

- **N-01：当天 Cookie-only 快照的历史来源仍未确定。** 当前源码可以证明，无关 `.json` 配置更新会丢弃私有 `auth`；但不能据此认定它就是当天缺少 Bearer 的唯一原因。R22 §48.2、§48.7 保留了这一证据边界，没有把可达链冒充历史事实。
- **N-02：本轮为只读方案审计。** 独立核验了源码、相关测试、`jsonc-parser` 实现及日志。日志仍有页面不收敛记录，包括 `C:/Users/Lenovo/AppData/Local/opencode/chatgpt-browser-agent/state/daemon.log:14286`。未运行测试、联网转录或浏览器实验；方案中的 HTTP 实测数据没有被当作本审计独立复现的结果。

#### Rejected speculation

- 不从 `frame detached`、`Target closed` 推导新的生命周期缺陷，也不要求新增状态机或重试。
- 不要求离线 Cookie 导出凭空提供 Bearer；实际 producer 在 `thirdparty/chatgpt-browser-agent/chatgpt.js:951` 仅返回 Cookie。
- 不根据初始页面缺少上传控件就认定附件流程失效。真实上传验收仍是方案明确保留的发布门禁。
- 不以未来 DOM 改版、假想多个输入框或未知 Cookie 格式要求 selector 后备链。
- 未修改的既有恢复逻辑，不因同处一个文件就自动成为本次 blocker。

#### Requirement and traceability coverage

审计对象：`docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，**Revision R22，§47、§48、§49 的全部有效拟议变更**。

| 要求／不变量 | 独立核验结论 |
|---|---|
| 内置 HTTP 与浏览器职责分离 | 三个 TUI 入口调用同一 `submitVoice`。缓存和 profile 转录经 `NetworkProxy.fetch`，不读取 DOM；浏览器末级才经过页面稳定检查。见 `packages/opencode/src/server/shared/tui-control.ts:99`。 |
| V20-1：修复页面就绪误判 | `thirdparty/chatgpt-browser-agent/chatgpt-dom.js:868` 将旧 ID 存在性作为认证条件；startup 和 voice 均消费该事实。替换定位参数落在正确 owner，保留 bootstrap、Bearer 和登录入口检查。 |
| V20-2：全部 composer 消费者一致 | 独立检索并阅读确认 15 处旧 selector，拟议 diff 全覆盖 Project、模式、附件、等待、输入及发送。表单归属、可信点击和新增 user turn 成功标准保持。 |
| V20-3：浏览器恢复后复用 HTTP | 页面请求返回实际使用的 Bearer，core 与 CLI 保留它，后端转换并写回。见 `thirdparty/chatgpt-browser-agent/chatgpt-core.js:1978`、`packages/opencode/src/server/shared/tui-control.ts:185`。计划覆盖恢复后第二轮缓存直连，并在中间加入无关配置更新。 |
| V20-4：正常调用取得新代码 | CLI/core 同步升级版本，复用现有版本淘汰机制。见 `thirdparty/chatgpt-browser-agent/chatgpt.js:548`。没有新增重启机制。 |
| V21-1／V21-2：保留私有认证且不扩大公开返回 | 当前 `.json` 分支先 schema 解码再整份序列化，确实会删除 MCP schema 未定义的 `auth`。R22 改为原文定点更新，公开结果仍由原 schema 生成。见 `packages/opencode/src/config/config.ts:815`、`packages/opencode/src/config/mcp.ts:4`。 |
| V22-1：合法类型切换保持 | R22 在目标与补丁均为对象时递归，其余整体替换节点。布尔值转对象不再深入布尔父节点，因而避开依赖明确抛错的路径。见 `node_modules/jsonc-parser/lib/umd/impl/edit.js:159`。R21 B-01 的具体回归已在方案中消除。 |
| 简洁性、修改规模与验证 | 四个生产文件；没有新增 helper、状态、配置项或依赖。拟议增删约 66 行，低于 200 行。取消、期限、错误提交语义保持，并有回归及真实两轮录音验收。 |

**测试敏感性成立：**

- 无旧 ID、具有表单内可编辑 textbox 的 fixture，会使当前认证探针失败。
- 含私有认证的 `.json` 经原 `Config.Service.updateGlobal` 更新无关设置，会丢失认证。
- 类型切换测试约束统一写回后的行为；固定期望值不依赖复制生产算法。
- 真实录音恢复、自动写回、无关配置更新和第二轮 HTTP 成功，被保留为完整恢复门禁，不能由合成浏览器响应替代。

反向映射完整：selector 修复对应 DOM 合同；版本更新对应旧 daemon 的实际复用；原文写回对应认证丢失；AST 节点判断对应公开 schema 支持的类型替换。

#### Primary-path and fallback verdict

**通过。**

- 保留缓存 HTTP、profile HTTP、浏览器末级的既有编排，本修订新增备用成功路径为 **0**。
- DOM 定位直接替换旧合同，不保留候选列表、失败后换 selector 或运行时补 ID。
- 配置写回统一为一条原文更新路径；对象合并和节点替换属于同一算法的输入分支，没有 catch 后换算法。
- 新增诊断决策面为 **0%**；认证快照仍由正常浏览器成功路径产生，不依赖手填。

#### Code quality and Chinese-comment verdict

**方案阶段通过。**

按拟议代码计，生产 **E=23、合格 C=8，C/E≈34.8%**；排除 import-only、文档及未修改上下文。注释分别解释 DOM 定位合同、版本淘汰、私有认证边界及类型替换原因。

测试修改承诺实际 E/C 至少 15%。当前没有 implementation diff，最终生产及测试的实际计量、类型检查和测试结果仍须在实施审计中核验。

#### Release verdict

**APPROVE — 仅批准 `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md` 的 R22 方案。**

本结论覆盖全部四个生产文件的拟议修改及直接影响路径，不代表当前 Alt+V 已恢复，也不构成实现发布批准。实施完成仍须通过计划中的真实录音闭环、页面消费者验收、相关回归和独立全范围实现审计。

本轮未修改文件、真实配置、浏览器或 daemon，未输出凭据。

## 50. R23 实施授权与验证约束

> 保持修改逻辑准确自然同时请注意测试断言要符合逻辑自然，避免过多增大不必要的或者为了断言而进行的不必要断言；同时整体生产代码修改数在5个文件以内，在600行生产代码修改以内，期间不要使用question因为用户不在这里
>
> 目标终态：verified-implementation

R23不更改R22修复路径或增添生产概念。沿用§47-49四文件拟议diff；新增测试只验证公开行为及实际回归，不添加内部调用计数、源码形状、重复实现算法或为了行数配额而增加的断言。测试复用已有fixtures与断言，保留原始断言深度、取消/期限及敏感字段边界。

重新核对的工作树中，子仓库干净，目标config/config.ts未被修改；主仓库另有shell、cross-spawn、OpenTUI、VSCode与其它计划文件的并行修改及暂存内容，全部保留，不加入本次diff。现有生产代码仍是已复现RED的版本。新预算不授权扩展范围；若真实页面消费者验证暴露新的确定缺陷，按同一canonical递增revision并全范围审计，最多5生产文件、600行。

实施先完成定向RED/GREEN再扩展回归，真实浏览器/转录使用已有授权的MCP账户，秘密仅在本地进程中传递；不手填token。正常成功路径写回是用户请求的功能验证，与人工编辑认证区别明确。测试如需更改配置，先用隔离配置和合成值验证；用户实际配置只允许正常语音成功事务写回，不用无关设置更改真实配置充当测试。真实录音闭环的无关设置更新在与真实成功快照相同内容的隔离配置中通过原公共服务执行，并由下一次原HTTP读取验证。

不得关闭并发用户browser/daemon。实验只清理自己创建的页面/进程；正常CLI版本选主行为由既有实现所有。最终目标只到验证与独立实现批准，不进行git add/commit/push。R23方案全范围审计待执行。

### 50.1 R23 独立方案批准

Invocation ses_f1291f811ffexZ7X6A9Fgfk88L；full-scope plan audit；R23；第4轮。以下分类及裁决原文：

#### Blocking findings
No blocking findings.

#### Non-blocking findings
- **N-01：缺少 Bearer 的历史来源仍不能确定。** 当前源码证明，无关 `.json` 全局配置更新会通过 schema 解码后整体写回，丢弃私有 `auth`，见 `packages/opencode/src/config/config.ts:815`。这足以支持持久化修复，但不能证明它就是当天 Cookie-only 快照的唯一来源。R23 保留了这一证据边界。
- **N-02：本轮是静态方案审计。** 已独立读取源码、相关测试、依赖实现及全部有效拟议修改；未执行测试、联网转录或浏览器实验。方案中的现场 HTTP 结果未被当作本审计独立复现的结果。

#### Rejected speculation
- 不要求增加 selector 候选链、认证刷新、额外重试、代理切换或更长超时。
- 不从 `frame detached`、`Target closed` 推导新的生命周期缺陷。
- 不要求离线 profile Cookie 导出提供 Bearer；该 producer 当前只返回 Cookie，见 `thirdparty/chatgpt-browser-agent/chatgpt.js:951`。
- 不凭初始页面缺少上传控件判定附件合同失效；方案已保留真实上传验收门禁。
- 不将未被本次修改引入或加重的既有恢复逻辑、并发写入问题扩大为本轮阻断项。

#### Release verdict
**APPROVE — 仅批准 R23 方案。**

该批准允许实施 §47–50 的准确范围，不代表 Alt+V 已恢复或达到 `verified-implementation`。完成仍须取得定向 RED/GREEN、相关回归与 typecheck、真实转录后下一轮缓存直连、隔离配置中的认证保留验证、真实页面消费者验收，以及全范围独立实施批准。

本轮未修改文件、未输出凭据、未操作现用浏览器或 daemon。

## 51. R24：真实提交与上传控件合同一并替换

### 51.1 已完成实施与新事实

R23配置和DOM修改已实施，production四文件+32/-34；原配置公开服务RED/GREEN、无ID页面原探针RED/GREEN均取得。完整config文件90pass/2既有skip，voice相关四文件109pass/3既有账户skip，子仓库73项完整离线测试全通过，包级typecheck通过。详细执行记录由后续实施证据统一归档。

真实链路脚本D:/Temp/opencode/r23-voice-verify.ts第二次执行（第一次网络连接中断）已经通过：原submitVoice→真实Server.listen→cached429(625ms)→原browserCLI成功(14589ms)→正常自动写回Bearer/Cookie。私有快照与browser producer逐值一致。隔离副本经原/global/config PATCH成功保留快照且公开响应无auth；第二次原transcribeVoiceFile HTTP200(800ms)，CLI执行0，hello-world识别正确。用户配置仅正常语音事务写回，未手填凭据。daemon保持运行version27，active/queued/locks均0。

随后执行真实MCP公共验证 `node test-mcp.js testE2EAskBasic testE2EAskWithFileUpload`（cwd子仓库），daemon检测通过，basic因等待发送按钮10秒失败。纯CDP只读检查当前Project页面：有1个正常可编辑表单textbox，文本已填充，1个启用的`button type=submit aria-label=发送`，但所有按钮均无旧data-testid。未发生user turn，故没有重复发送风险；不把填字成功当提交成功。

同一页面及首页均有3个表单file input，全部multiple、动态React id；accept依次image/*,video/*、image/*、属性缺席。`form input[type="file"][multiple]:not([accept])`恰好匹配1个通用文件输入。当前添加内容按钮没有composer-plus-btn ID，具有`data-composer-navigation-target="add-context"`；模型菜单则为reasoning，scope可明确区分。上述属性为真实DOM读取，不根据未来可能的页面猜测。

### 51.2 Owner、替换与完整diff增量

新V24-1：已填好的当前composer能够按原可信click提交，并等待新增user turn；首个分歧为同表单发送按钮旧testid查询。新V24-2：原附件上传选择通用文件input、原模式选择打开添加内容菜单；首个分歧是已退休ID。owner均为同一个chatgpt-dom.js，不新增文件或抽象，不扩大到DOM结果提取或其它浏览器状态。

替换现有参数，不提供旧新候选：四处`button[data-testid="send-button"]`改为`button[type="submit"]`，均保留当前composer.closest('form')范围、disabled判断、文字比较、trusted click与新增user turn确认。uploadFiles使用唯一通用file input；显式change事件沿原持有ElementHandle派发，避免再次按已退休ID查找。image原入口改同表单add-context按钮，保留原菜单语言选项与image确认合同。

```diff
--- a/thirdparty/chatgpt-browser-agent/chatgpt-dom.js
+++ b/thirdparty/chatgpt-browser-agent/chatgpt-dom.js
@@ selectComposerMode
-    const plus = await page.waitForSelector('#composer-plus-btn', { timeout: 10_000 });
+    const plus = await page.waitForSelector('form button[data-composer-navigation-target="add-context"]', { timeout: 10_000 });
@@ uploadFiles
-          const input = await page.waitForSelector('#upload-files', { timeout: 15_000 });
+          // 当前表单含图片/视频专用输入；无 accept 限制的 multiple 输入才是通用文件上传入口。
+          const input = await page.waitForSelector('form input[type="file"][multiple]:not([accept])', { timeout: 15_000 });
@@ uploadFiles
-          await page.evaluate(() => document.getElementById('upload-files')?.dispatchEvent(new Event('change', { bubbles: true })));
+          await input.evaluate(element => element.dispatchEvent(new Event('change', { bubbles: true })));
@@ waitForUploadReady
-        const button = input?.closest('form')?.querySelector('button[data-testid="send-button"]');
+        const button = input?.closest('form')?.querySelector('button[type="submit"]');
@@ clickSend / waitForFunction
-      const button = form?.querySelector('button[data-testid="send-button"]');
+      const button = form?.querySelector('button[type="submit"]');
@@ clickSend / before
-      const button = form?.querySelector('button[data-testid="send-button"]');
+      const button = form?.querySelector('button[type="submit"]');
@@ clickSend / evaluateHandle
-    const handle = await page.evaluateHandle(() => document.querySelector('form [contenteditable="true"][role="textbox"]')?.closest('form')?.querySelector('button[data-testid="send-button"]'));
+    // 网页移除了发送 testid；submit 类型保留表单提交语义，不依赖本地化按钮标签。
+    const handle = await page.evaluateHandle(() => document.querySelector('form [contenteditable="true"][role="textbox"]')?.closest('form')?.querySelector('button[type="submit"]'));
```

版本仍27：尚未发布，本轮新进程已拥有R23适配但新增修复需正常重载才能实测。验证以自行创建的新daemon进程/隔离state配合已有授权profile或正常CLI版本淘汰进行，不强行关闭用户现用进程；若需再次bump来使已启动27加载最终代码，可在这同一CLI/core版本合同中同步改28并记录实际值，不引入新恢复机制。

### 51.3 TDD、映射与预算

在原testSubmitUsesTrustedClick fixture移除发送testid、按钮设type=submit；模拟网页正常preventDefault而非让浏览器导航掉fixture。原可信点击/user turn/route-only失败断言保持，先RED再替换production参数GREEN。上传fixture移除input固定ID，并同时布置带accept的image/video输入；既有文件内容及chip断言识别是否选错入口，不加内部查询次数。image fixture改为add-context属性，原选图模式/比例/发送行为继续验证；测试脚本的定位同时对应新fixture，不用源码grep充当行为测试。

正向V24-1→submit公共seam→四处按钮参数→原trusted-submit与真实MCP数学题。V24-2→uploadFiles/selectComposerMode→三个定位/事件表达式→既有文件上传/image tests及真实附件标记读取。反向每一处替换都来自本轮真实失败或相同页面的直接消费者；无新增helper/候选链/重试/guard。保留原shape与协议，生产diagnostic决策0%、alternate success0。

完整production仍4文件，新增增删约16行，预计总量82，保守≤120（限额600）；E预计30/C10，每文件均满足15%。测试继续复用现有case，只有必要fixture变化和说明。新failure没有扩展成功判定：必须新增user turn、文件内容真正被模型读到；超时不放宽。用户真实voice闭环已通过也不能据此跳过本节MCP消费者。

完整验收保持§47-50全部要求，并在本节修复后重跑受影响offline tests、真实basic ask和file upload；如新一轮出现不同故障，保留原始输出再定位，禁止增加备用算法凑通过。R24方案全范围重审待执行。

### 51.4 R24 独立方案批准

Invocation ses_f1276544affeuJL2uiFF5geeDT；full-scope plan audit；R24；第5轮。分类及裁决原文：

#### Blocking findings
No blocking findings.

#### Non-blocking findings
- **N-01：现有验证脚本未覆盖真实快捷键和录音器。** `D:/Temp/opencode/r23-voice-verify.ts:100` 将已有 WAV 交给源码版 `submitVoice`，第二轮在 `D:/Temp/opencode/r23-voice-verify.ts:139` 直接调用 `transcribeVoiceFile`。它可以验证后端恢复、持久化和缓存复用，但不能独立证明实际安装版本的 Alt+V 录音入口恢复。R24 保留了 §47.8 的原场景验收，因此不阻止方案批准；实现验收仍须区分这两类证据。
- **N-02：最终验收必须确认运行进程已加载 R24。** `thirdparty/chatgpt-browser-agent/chatgpt.js:549` 会直接复用健康的同版本 daemon。§51.2 已允许同步升级至28或使用自行创建的新进程；仅修改磁盘代码、继续调用旧27进程不能验证新增修复。
- **N-03：本轮为静态、只读方案审计。** 独立检查了源码、测试、依赖实现及现有差异，没有执行测试或联网实验。方案记载的真实 DOM、HTTP 状态和通过数量未被当作本审计独立复现的结果。

#### Rejected speculation
- 不以未来网页改版、假想多个 composer、未知 Cookie 格式要求增加候选 selector、重试或状态机。
- 不从 `frame detached`、`Target closed` 推导未经证明的新生命周期缺陷。
- 不要求离线 profile 导出产生 Bearer；现有 producer 明确只返回 Cookie。
- 不将当前 Cookie-only 快照的历史来源认定为已查明；配置写回缺陷的可达性不等于当天事件的唯一因果证明。
- 不将未修改的既有浏览器恢复和 image 行为自动纳入本轮缺陷修复范围。

#### Release verdict
**APPROVE — 仅批准 R24 方案。**

该批准覆盖四个生产文件的完整修复计划及直接影响行为，不代表当前实现已达到 `verified-implementation`。完成仍须通过 R24 新增切片、真实 MCP ask／附件验收、原 Alt+V 场景验证及全范围独立实现审计。

本轮未修改文件、真实配置、浏览器或 daemon，未输出凭据。

## 52. R25：消息接收和读取沿用当前角色合同

### 52.1 原始场景与新RED

安装版F:/include/CLI/opencode.exe（1.15.14-smark）已通过Windows ConPTY两轮真正Alt+V开始/停止PvRecorder；源码真实Server.listen后端两轮HTTP200，16kHz单声道PCM WAV分别98348/97324字节，客户端与上传hash一致，无CLI调用，前后端WAV正常清理，TUI与自有服务exit0。原始事件D:/Temp/opencode/r24-altv-owned-faYXeH/events.jsonl。录音为静音，空text不冒充有声识别；有声hello-world由§51.1已知语音真实转录补充。

R24参数替换已实施，离线完整73项通过。真实`node test-mcp.js testE2EAskBasic testE2EAskWithFileUpload`正常选主到version28后，在20秒“新增user turn”确认失败。只读CDP证明已经进入conversation路由、编辑器清空、页面有回答95，但旧user/assistant role查询均0。完整DOM事实：当前用户消息单元是`data-chatgpt-search-unit-key="fallback-turn-0:0:user"`，回答单元是同属性`fallback-turn-0:2:assistant`，共同turn容器是`data-content-search-turn-key="fallback-turn-0"`；各role单元包含各自正文，旧data-message-author-role、旧conversation-turn testid和article均不存在。不是未点击成功，必须修复接收事实owner，不能把路由变化当提交成功。

全量`bun run test:ci`默认core合并运行在30分钟外层期限结束，无最终pass/fail摘要；child PID38788已确认退出。没有将此运行算通过。相关109项、配置90项和子仓库73项已有完整通过记录。后续按实际Windows shard验证并保留全量限制，不通过增加timeout或改测试掩盖失败。

### 52.2 单一替换与受影响消费者

新V25-1：可信发送之后只能以新增用户消息单元证明接受；新V25-2：回答状态、正文、产物与滚动读取同一当前角色/turn语义。owner均chatgpt-dom.js。直接替换已退休属性，保留原数量增长、正文稳定、stop/placeholder、引用/表格转换、产物归属和pending规则，不加HTTP会话读取或备用解析器。

完整替换表（不是候选列表）：

| 原定位/字段 | 新定位/字段 | 消费者 |
|---|---|---|
| `[data-message-author-role="user"]` | `[data-chatgpt-search-unit-key$=":user"]` | clickSend前后计数、assistantState、空turn归属 |
| `[data-message-author-role="assistant"]` | `[data-chatgpt-search-unit-key$=":assistant"]` | state、dump、extractAssistant、sandbox发现/点击、空turn归属 |
| `[data-testid^="conversation-turn"]` | `[data-content-search-turn-key]` | assistantState turn计数、scrollToEnd |
| dump的`[data-message-author-role]`与角色读取 | 两种上述role单元的集合，角色值取key最后的冒号字段 | 仅非敏感诊断结构，不输出完整key或正文 |

CSS `$=`匹配的是已有角色后缀，不绑定临时turn编号或message ID。dump union表示两个支持的角色，不是失败后回退。所有查询在原位置替换，不新增函数。旧没有role的空回答case继续按最新turn与既有固定标签判定，不引入新的空成功规则。四处生产文件保持，CLI/core版本同步29，以原正常调用使已启动28加载最终代码。

代表性diff；表中列出的所有消费者均须同次替换：

```diff
-      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
-      const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
+      // 当前消息单元以搜索key的角色后缀标识；状态和正文读取不能再依赖已退休的author属性。
+      const msgs = document.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]');
+      const userCount = document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]').length;
-      const turns = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
+      const turns = [...document.querySelectorAll('[data-content-search-turn-key]')];
```

注释分别放在可信接受计数、状态/正文一致性、非敏感dump角色提取和最新turn滚动，解释为什么仍需本轮user增长及最新回答归属，保留旧原理说明。新增生产代码约18–25行，含替换删除的总量预计≤180，低于600；E≈47/C≥12，最终按实际diff独立计量。无新helper/state/config/retry。

### 52.3 测试与验证

在原trusted-submit fixture以当前role属性生成新user单元，先RED20秒未确认，再替换计数GREEN；无user只有route变化的反例继续失败。所有使用角色/turn的既有state/emptyAssistant/foreground/table-citation/sandbox fixtures改为独立手写当前属性，保留原行为断言与顺序，不能通过导入生产selector来生成fixture。增加或复用一条公开state/extractAssistant用例含历史user/assistant和最新回答，预期只取最新正文，不把早前回答或按钮文本当本轮文字；不复制生产转换算法。

真实basic ask必须返回95且归属MCP Project，再沿同session执行真实文件上传，模型读出文件独有标记。出现已提交但确认超时的session只读检查/恢复，不重发同一prompt，不删除历史用户对话。已尝试在daemon外创建未登记临时页验证上传，该页被关闭导致detached；此诊断不等于正式upload失败，后续只使用daemon正常登记页面做上传E2E，不改变生命周期机制。

保留全部R23/R24语音及配置验收，最终在新version29执行语音账户返回/后继HTTP验证以确认新进程没有回归。本轮第6次方案全范围审计必须覆盖§47-52全部当前修复，不能仅审消息selector；如仍有阻断按既定审计上限处理，不能自审放行。

### 52.4 R25 全范围方案批准

Invocation ses_f123bb4faffefdTkSyB1hZJIGw；full-scope plan audit；R25；第6轮。分类与裁决原文：

#### Blocking findings
No blocking findings.

#### Non-blocking findings
- **N-01：完整验证尚未结束。** §52明确保留 version29 下真实 MCP ask、同会话附件读取、语音恢复与后继缓存 HTTP 验证。已有测试记录不能替代这些最终验收；全量 CI 超时也不能计为通过。
- **N-02：Alt+V 证据应保持准确边界。** 已直接读取 `D:/Temp/opencode/r24-altv-owned-faYXeH/events.jsonl:10`：安装版 TUI attach 到源码服务，两轮真实录音上传均返回 HTTP200，并完成 WAV 清理；两轮 `textLength` 均为0。这支持快捷键、录音、上传和缓存直连链路，不单独证明有声识别、文字插入或浏览器恢复。
- **N-03：当天缺失 Bearer 的历史来源仍未确定。** 原配置写回确实存在删除私有 auth 的路径，但不能据此认定它是当天快照的唯一来源。方案保留了这一区分。
- **N-04：本轮是只读方案审计。** 未执行测试或操作真实 browser、daemon、配置；方案记载的现场 DOM 和联网实验未被冒充为本审计独立复现。

#### Rejected speculation
- 不根据未来 DOM 改版、假想重复 composer 或未知角色格式要求增加 selector 候选链。
- 不从 `detached`、`Target closed` 推导新的生命周期缺陷或要求新增重试、状态机。
- 不要求离线 profile 导出产生 Bearer；其实际返回合同只有 Cookie 与时间，见 `thirdparty/chatgpt-browser-agent/chatgpt.js:952`。
- 不把同文件内未修改、且本次未加重的既有兼容行为自动列为阻断项。

#### Release verdict
**APPROVE — 仅批准 `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md` 的 R25 方案。**

批准覆盖§47–52全部有效范围，不构成当前实现发布批准。达到 `verified-implementation` 仍须完成 R25 RED/GREEN、version29 真实页面及语音闭环、规定回归与类型检查，并取得全范围独立实现批准。

## 53. R26：临时会话 URL 不能进入正式 registry

### 53.1 原需求与审计轮次说明

最新用户原文：“继续，避免不必要的全量疯狂测试”。因此不再重跑全量，仅执行当前变更的必要定向回归及真实用户链路；先前全量超时与OpenTUI失败保留原始记录，不冒充通过。当前verified-implementation目标从R23启动，本次为该目标第4次方案审计；R20–R22属于已结束的方案目标，历史连续编号保留。§52所称第6次是canonical历史累计，不以它抹去本次实施目标的独立审计要求；本目标仍最多6次方案审计、3次实现审计。

### 53.2 已观察RED与首个分歧

R25消息定位替换后，真实CLI已发送并读取到回答，但finishAsk拒绝返回：`Session #a040291b4c left its recorded ChatGPT conversation before response collection`。调用原readSessionEntry与只读CDP对照得到：registry URL为目标Project下`/c/local-chatgpt%3A354552e7-2f90-4a63-9e9a-bc4f5fc2e3f9`；实际同一页面最终URL为同Project下`/c/6abc0224-6a64-83ee-a1b9-1b5a22ad1cc8`，user/assistant均1、generating=false。此处记录的是本轮合成验证会话，不含凭据。

首个分歧是chatgpt-project.js:71的conversationRef将浏览器临时local-chatgpt ID误认为持久远端conversation；rememberCurrentSessionUrl已有20秒轮询在首次误判时写入临时ID并结束，后续正确永久ID被当成外来会话。owner为现有无副作用URL身份策略，而非等待器、registry迁移或响应提取。V26-1：本地临时创建地址和既有`/c/new`同样不是可恢复身份；V26-2：真正不同的已建立会话仍立即拒绝，绝不能取消原sameConversation保护。

### 53.3 最小精确替换与预算

新增第五生产文件thirdparty/chatgpt-browser-agent/chatgpt-project.js，只在现有两个已解析的conversation ID判定中排除local-chatgpt前缀（冒号原文或URL编码%3A，编码大小写均合法）。不解码或改变其它ID，不增加helper或轮询、重试、放宽身份。

```diff
@@ conversationRef / scoped
-    return project && scoped[2] !== 'new' ? { id: scoped[2], projectID: project.id } : null;
+    // 新网页先暴露客户端临时 ID；它与 /c/new 一样不能成为 registry 的远端身份。
+    return project && scoped[2] !== 'new' && !/^local-chatgpt(?::|%3a)/i.test(scoped[2]) ? { id: scoped[2], projectID: project.id } : null;
@@ conversationRef / plain
-  return plain && plain[1] !== 'new' ? { id: plain[1], projectID: null } : null;
+  // 历史 plain 路由也沿用同一 ID 语义；只保留已经建立的会话，不扩大兼容范围。
+  return plain && plain[1] !== 'new' && !/^local-chatgpt(?::|%3a)/i.test(plain[1]) ? { id: plain[1], projectID: null } : null;
```

CLI/core同步version30以沿原选主机制加载新策略；其它生产路径保持R25。正向V26-1→conversationRef→两处ID判定→纯策略与原rememberCurrentSessionUrl临时到永久用例；V26-2→sameConversation→无改变→旧跨会话拒绝回归。反向新增前缀排除由真实registry错误证明，属于原身份域校正，不是备用成功路径或额外防御。

预计总生产增删≤190行（仍小于600），5文件。新增策略E2/C2，其它文件原注释预算维持，全部生产与测试按实际E/C至少15%复算。新增函数/状态/配置/依赖0，不修改历史session，不手动改registry来取得通过。

### 53.4 验证门禁

在既有testProjectIdentityPolicy加入Project/plain两种临时ID的固定预期null，以及永久会话仍接受；在既有testCoreProjectStateMachine使用原rememberCurrentSessionUrl、页面URL由临时自然变永久的fixture，期望只返回/保存永久URL。先RED（原策略立即把临时URL返回），再GREEN；不以调用次数断言代替身份结果。异项目与同项目另一个永久ID的拒绝断言保持。

定向跑策略、core状态、trusted submit和回答提取相关测试；真实新会话basic ask及附件读取必须成功。对已发送失败的测试会话只读检查、不重发同一请求；新的测试使用新session。同时保留所有voice/配置验证，不扩大fullsuite。当前最新验证门禁包括原安装TUI+源码后端、正常自动认证写回与二次直连；最终报告明确部署边界。

R26需针对§47–53全部有效需求和五文件完整重审；不得只审新策略。未经批准不实施此增量。

### 53.5 R26 全范围方案批准

Invocation ses_f119498b8ffeuW20cY6gTusP2z；full-scope plan audit；R26；本次实施目标第4轮。以下分类和裁决原文：

#### Blocking findings
No blocking findings.

#### Non-blocking findings
- **N-01：最终运行验证仍未完成。** R26 的临时 URL 修复尚未实施；version30 下的新会话 ask、同会话附件读取、语音自动认证写回及后继 HTTP 复用仍是实现验收门禁。方案批准不能替代这些结果。
- **N-02：已有 Alt+V 证据有明确边界。** 独立读取 `D:/Temp/opencode/r24-altv-owned-faYXeH/events.jsonl:10`，确认安装版 TUI attach 到源码后端，两轮录音上传返回 HTTP200、完成 WAV 清理；两轮文字长度均为0。它证明快捷键、录音、上传和缓存直连链路，不单独证明有声识别、文字插入或最终部署版本已经恢复。
- **N-03：缺失 Bearer 的历史来源仍不能确定。** 原全局配置写回存在删除私有认证的路径，但不能据此认定它就是当天 Cookie-only 快照的唯一来源。方案正确保留了这一证据边界。
- **N-04：本轮为静态、只读方案审计。** 核验了源码、现有差异、测试及上述事件记录；未执行测试、联网转录或操作真实 browser、daemon、配置。canonical 中其他现场实验没有被当作本审计独立复现的结果。

#### Rejected speculation
- 不因未来 DOM 改版、假想重复 composer 或未知角色格式要求增加 selector 候选链。
- 不从 `detached`、`Target closed` 推导新的生命周期缺陷。
- 不要求离线 profile 导出提供 Bearer；其返回合同明确只有 Cookie 与时间，见 `thirdparty/chatgpt-browser-agent/chatgpt.js:952`。
- 不要求迁移或猜修已经登记的临时会话；R26 保留失败会话的防重发边界，验证使用新 session。
- 不把同文件内未改变、且本轮未加重的既有兼容或恢复行为自动列为阻断项。

#### Release verdict
**APPROVE — 仅批准 `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md` 的 R26 方案，full-scope。**

批准覆盖§47–53全部有效范围，不构成实现发布批准。达到 `verified-implementation` 仍须完成R26定向RED/GREEN、version30真实MCP与语音闭环、必要回归和类型检查，并取得完整独立实现批准。

## 54. R27：附件卡片解析替换退休属性

### 54.1 真实验收与RED

R26原identity/core公共测试取得RED/GREEN，源码version30。真实MCP `testE2EAskBasic`通过（32109ms），证明创建Project永久conversation、发送并返回95已闭环。随后同会话`testE2EAskWithFileUpload`报`Attachment chips made no progress after upload`。不把basic成功替代附件验收。

在本轮测试自己的已登记conversation中通过真实通用input上传无敏感`chip-probe.txt`，只读DOM确认：form中role=group数量0；文件名SPAN的祖先是`.composer-attachment-surface`（静态语义类），其父为单张卡片容器；移除按钮标注“移除 chip-probe.txt”，发送按钮type=submit启用。现有attachmentTexts只扫描role=group然后扫描attachment/file testid，故两个旧解析都返回空。这是实际上传完成后的卡片表示漂移，不是上传HTTP失败。

### 54.2 Owner与唯一算法

V27-1：每个已挂载附件卡片计一次且可验证文件名，不能把输入控件当卡片。owner为现有attachmentState/attachmentTexts；保留外层namesPresent和normalize、上传/取消流程、计数阈值与期限。直接用当前`.composer-attachment-surface`卡片文本替换旧role/testid双路径，删除不再有调用的isUploadControl。清理移除按钮的现有逻辑在当前页面仍匹配，保持不变；不新增选择器后备或另一套计数算法。

```diff
@@ attachmentTexts
-        const texts = new Set();
-        // 当前文件 tile 优先暴露 role=group + 文件名 aria-label；data-testid 只作后备。
-        // 先读 tile 容器可以避免把“移除文件”按钮和同一个文件名重复计数成两份附件。
-        for (const el of root.querySelectorAll('[role="group"][aria-label]')) {
-          const text = normalize(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
-          if (text) texts.add(text);
-        }
-        if (texts.size > 0) return [...texts];
-        for (const el of root.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"]')) {
-          if (isUploadControl(el)) continue;
-          const text = normalize(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
-          if (text && !/^(send|stop|attach files?|upload files?|发送|停止|上传文件|添加文件等)$/.test(text)) texts.add(text);
-        }
-        return [...texts];
+        // 当前每份附件有独立语义卡片；读取卡片本身，避免把移除按钮或上传输入重复计数。
+        // 文件名仍由外层独立核对；未挂到表单的历史文件不能满足本轮上传条件。
+        return [...root.querySelectorAll('.composer-attachment-surface')]
+          .map(el => normalize(el.textContent || ''))
+          .filter(Boolean);
@@
-      function isUploadControl(el) {
-        return /^(input|textarea)$/i.test(el.tagName) || /^(upload-files|upload-photos|upload-camera)$/.test(el.id || '') || /upload-photos-input|composer-plus-btn/.test(el.getAttribute('data-testid') || '');
-      }
```

删除的旧中文注释描述已经退役的role/testid两算法，用两条准确的新合同解释替代，不降低当前机制解释深度；其它注释原样保留。CLI/core同步31使正常调用加载最终adapter。生产文件保持5、预计总增删≤210（限额600），无新增函数，删除1个失效helper；新计数无额外条件分支。该替换新增E3/C2，仍逐文件满足15%，实际完整diff另计。

### 54.3 TDD、验证与审计

修改既有testFileUploadUsesStableLocalCopy及其它附件fixture，让卡片含`.composer-attachment-surface`和真实文件名、移除按钮为其兄弟；不带旧role/testid。先运行原公共submit得到附件计数RED，再替换production后GREEN。保持原附件内容、重复残留清理、可信发送与新user单元断言；不增加为断言而造的production接口。既有文件输入/图片输入decoy继续存在，确保不会混算控件。

正向V27-1→attachmentState→当前卡片文本→公共上传submit与真实文件独有marker读取；反向新class唯一依据真实卡片，不将新旧解析并存。无备用成功路径，旧后备解析被删除而非再加一层。

仅重跑本次附件/submit/image相关定向测试、真实basic+附件+voice；不重跑全量。voice与配置既有完整证据保留，最终当前进程验证仍必须取得。R27是当前实施目标从R23开始的第5轮方案审计，要求§47–54全部有效范围全审，不仅附件段。

### 54.4 R27 全范围方案批准

Invocation ses_f117a055dffeeaez56DLYZMSSt；full-scope plan audit；R27；本次实施目标第5轮。分类和裁决原文：

#### Blocking findings
No blocking findings.

#### Non-blocking findings
- **N-01：最终运行验收仍待完成。** R27 的附件解析替换和 version31 尚未形成最终验证证据。真实附件标记读取、当前进程的语音自动认证写回及后继 HTTP 复用，仍须按方案完成。
- **N-02：Alt+V 证据有明确边界。** 独立读取 `D:/Temp/opencode/r24-altv-owned-faYXeH/events.jsonl:10`：安装版 TUI 连接源码后端，两轮真实录音上传返回 HTTP200、完成 WAV 清理，但文字长度均为0。它证明快捷键、录音、上传和缓存直连链路，不单独证明有声识别、文字插入或最终部署版本恢复。
- **N-03：缺失 Bearer 的历史来源仍不能确定。** 原配置整体写回存在丢弃私有 auth 的路径；这支持持久化修复，但不足以认定其为当天 Cookie-only 快照的唯一来源。
- **N-04：本轮为静态、只读方案审计。** 已核验源码、差异、测试和上述事件记录；未执行测试、联网转录或操作现用 browser、daemon、真实配置。方案记载的其他现场实验未被视为本审计独立复现。

#### Rejected speculation
- 不依据未来 DOM 改版、假想嵌套卡片或重复 composer，要求增加 selector 后备链。
- 不从 `detached`、`Target closed` 推导未经证明的生命周期缺陷。
- 不要求离线 profile Cookie 导出凭空提供 Bearer，也不要求手填凭据或新增刷新机制。
- 不把同文件内未改变、且本轮未加重的既有兼容、重试和恢复行为列为阻断项。

#### Release verdict
**APPROVE — 仅批准 R27 方案，full-scope。**

批准覆盖§47–54全部有效范围，不构成 `verified-implementation` 批准。完成仍须取得 R27 定向 RED/GREEN、version31 真实附件与语音闭环、必要回归及类型检查，并通过完整独立实现审计。

本轮未修改文件、真实配置或运行进程，未输出凭据。

## 55. R27 实施证据与最终验证边界

当前实际生产修改严格覆盖§47–54批准路线；没有额外认证刷新、手填token、生产helper、状态机、依赖或fallback。配置整体序列化分支与旧附件双解析/isUploadControl已删除；取消/40秒/120秒和跨会话隔离保持。CLI/core最终version31。以下是builder核验记录，独立实现审计仍需自行重建。

### 55.1 当前差异与计量

| 文件 | 新增/删除 | E | C |
|---|---|---|---|
| packages/opencode/src/config/config.ts | 10/17 | 6 | 3 |
| thirdparty/chatgpt-browser-agent/chatgpt-dom.js | 49/53 | 38 | 11 |
| thirdparty/chatgpt-browser-agent/chatgpt-project.js | 4/2 | 2 | 2 |
| thirdparty/chatgpt-browser-agent/chatgpt.js | 2/1 | 1 | 1 |
| thirdparty/chatgpt-browser-agent/chatgpt-core.js | 2/1 | 1 | 1 |
| packages/opencode/test/config/config.test.ts | 100/0 | 81 | 16 |
| packages/opencode/test/cli/tui/voice-auth.test.ts | 7/5 | 5 | 2 |
| thirdparty/chatgpt-browser-agent/test-mcp.js | 127/70 | 99 | 24 |
| thirdparty/chatgpt-browser-agent/test-voice-robustness.js | 2/1 | 1 | 1 |

生产5文件，新增侧67、删除74、总修改141（不以删除抵扣）；全部E234/C61≈26.1%，生产E48/C18=37.5%。E排除注释、空行、import-only，C按邻近解释单列，实际独立计量以审计结果为准。没有新增仓库文件。主仓库其它计划/VSCode暂存及thirdparty/opencode-11720保留，未git add/commit/push；过程中其它agent提交的shell/OpenTUI内容不纳入本次diff。

### 55.2 定向RED/GREEN与回归

配置执行在packages/opencode，浏览器执行在thirdparty/chatgpt-browser-agent，Bun1.3.14不变：

- `bun test test/config/config.test.ts -t "without losing or exposing private auth"`：生产修改前JSON丢auth为RED（1pass/1fail）；原文patch后2pass。
- `bun test test/config/config.test.ts -t "formatter types and object patches"`：AST修复前2fail，`Can not add index to parent of type boolean`；修复后`-t "updates global"`6pass。
- `bun test test/config/config.test.ts -t "global"`：15pass；完整config文件90pass/2既有skip/0fail，198断言。
- `node test-mcp.js testSessionPageFactUsesBootstrapAuth`：无旧ID fixture原实现inconsistent RED，替换后GREEN。
- `node test-mcp.js testSubmitUsesTrustedClick`：当前role fixture在原20秒期限下RED，角色参数替换后GREEN。
- `node test-mcp.js testProjectIdentityPolicy`：原策略接受local-chatgpt而预期null RED；`testCoreProjectStateMachine`原记录返回临时URL而预期永久URL RED；修复后两项PASS（8243ms）。
- `node test-mcp.js testFileUploadUsesStableLocalCopy`：无旧role/testid卡片导致`Attachment chips made no progress after upload` RED；新解析后与trusted-submit/image合并3PASS（33753ms）。
- `bun test test/cli/tui/voice-auth.test.ts -t "reuses the browser account snapshot"`：429/401/403三种恢复及后继直连均PASS。第一次新增fixture错误把auth-export包成browser response，导致漏过profile POST；仅修正测试协议后通过，未据此改生产。
- `bun test test/cli/tui/voice-auth.test.ts test/cli/tui/prompt-voice-input.test.ts test/cli/tui/prompt-voice-recorder.test.ts test/server/tui-provider-endpoint-status.test.ts`：109pass/3既有账户E2E skip/0fail，420断言，210.10秒。
- R23/R24各取得73项完整离线PASS；R25完整离线运行在27项PASS后工具中断，没有最终summary，不计完整通过。按用户最新要求，此后不重跑全量。
- 最终必要定向 `node test-mcp.js testSessionPageFactUsesBootstrapAuth testProjectIdentityPolicy testCoreProjectStateMachine testTableCitationExtraction testEmptyAssistantTurnCompletes testDirectVoiceUsesBootstrapAuth`：6PASS/36977ms；与R27附件/提交/image三项共同覆盖最终变更。
- `npm run test:syntax`、`node --check chatgpt-project.js`、`node --check test-voice-robustness.js`通过；package-local `bun typecheck`最终通过；两个仓库定向`git diff --check`通过，仅既有LF/CRLF提示。

### 55.3 真实语音与页面验收

1. 初始真实用户缓存实测无Bearer、429约0.6秒；原transcribeVoiceFile观测到cached429→transcribe-file直接推进，未执行profile。修复后的原submitVoice→真实Server.listen在R23成功恢复并正常写回，下一轮HTTP200，已在§51记录；这是正常事务，不是人工填值。
2. 最终version31以全新ACL私有隔离MCP配置（无auth）执行同一原入口。原profile导出因正在运行的浏览器占用数据库退出1/2210ms，原编排自然进入browser；原CLI成功911ms，首轮API200/4363ms，实际hello-world文字12字符，Bearer/Cookie与自动写回快照完全一致。原/global/config PATCH更新隔离model后快照逐值保持、公开响应无auth；第二轮同一原submitVoice/API HTTP200/913ms，上游757ms，全部CLI调用0。真实用户配置逐字节不变，shared daemon31保持connected/idle。原始脱敏证据：D:/Temp/opencode/r27-no-auth-1790709679193.jsonl，primary已直接读取31行确认。
3. 原安装程序F:/include/CLI/opencode.exe 1.15.14-smark，通过ConPTY真正Alt+V两轮录音上传，客户端/HTTP WAV哈希一致、均16kHz单声道PCM，HTTP200，上游1196/553ms，CLI0，前后端WAV删除，owned TUI/server exit0。事件D:/Temp/opencode/r24-altv-owned-faYXeH/events.jsonl已读取；安装TUI接源码后端，未声称已安装daemon完成代码升级；静音text0只证明录音/上传，不冒充有声识别。已知有声音频的原入口实测补足有声转录证据。
4. 最终version31真实 `node test-mcp.js testE2EAskBasic testE2EAskWithFileUpload testE2EVoiceTranscribe`：检测现用daemon，3PASS（20874/31298/1196ms，总53718ms）。basic返回95且永久Project conversation成立；附件返回文件中唯一随机标记；voice识别hello。前一轮附件请求因浏览器窗口hidden导致IntersectionObserver未触发而55秒客户端超时；仅将现有测试窗口移到可见位置后原请求继续、userCount由1到2，未重发。随后原CLI恢复同session返回ZEBRA-1OMAY、Status completed、Prompt sent:no。上述最终3PASS是在窗口可见后自然通过，未修改生产超时或加替代点击算法。

### 55.4 广域CI与部署限制

全量检查不能报告全绿：`bun run test:ci`默认core合并运行在本地30分钟外层期限被终止，没有最终summary；随后干净环境Windows三片监督运行runtime/integration各13分钟预算耗尽，不能冒称达到CI实际45分钟限制。TUI完成769pass/14skip/5fail。证据D:/Temp/opencode/windows-ci-20260929-1528/results.json及各日志，primary已读results。

五个TUI失败独立运行原opentui-streaming-runtime.test.ts仍1pass/5fail。只读归属核验发现已提交45d9daa2ed的OpenTUI lifecycle补丁与当前node_modules不一致：patch中while带!isDestroyed，实际安装包仍无该条件。证据D:/Temp/opencode/opentui-streaming-independent-20260930.xml；与本次五个生产文件无共同修改，未擅自重装/更改依赖或修无关代码。runtime/integration只有局部预算结论，未证明失败归属，不隐藏未完成。

用户最新明确避免不必要全量，故此后只做直接相关回归与真实场景。上述广域环境限制交独立审计判定，不通过缩水用例、跳过失败或延长期限得到假绿。本任务目标verified-implementation，不包含构建安装替换已运行OpenCode服务、commit或push。最终报告须明确源码后端已验证、用户已安装后端尚未部署本次配置修复；MCP源码由正常CLI加载version31。

### 55.5 实现审计交接

R27当前全部实际diff进入独立full-scope implementation audit；目前状态implementation-audit-required。不再材料性修改直到审计返工或新revision批准。测试/实现子任务的“不能自行委派审计”不构成主流程审计不可用，主流程正常调用独立auditor。

## 56. R27 全范围独立实现批准

Invocation ses_f115f539fffevtq3tG7VrfJGR0；full-scope implementation audit；Revision R27；实现审计第1轮，同会话补齐独立执行。初次因等待定向执行确认而暂缓，没有代码blocking finding；明确既有本地验证授权后独立执行并作最终裁决。以下分类、结论及执行结果为原文：

### Blocking findings
No blocking findings.

### Non-blocking findings
- **N-01：部署边界保持。** 本次批准源码实现；安装版 TUI 已连接源码后端验证，用户已安装后端尚未部署配置修复。不能将实现批准表述为所有现用进程均已升级。
- **N-02：历史归因保持不确定性。** 原配置写回存在删除私有认证的确定路径，但不能据此断言它是当天 Cookie-only 快照的唯一来源。
- **N-03：不宣称全量 CI 全绿。** 既有广域运行存在超时和 TUI 失败。本轮没有重复全量，也没有发现这些结果与本次修改之间的证据链；当前变更的必要定向验证已独立通过。

### Rejected speculation
- 不要求新增 selector 后备链、认证刷新、额外重试、状态机或延长生产期限。
- 不以假想重复 composer、嵌套卡片、未来网页改版作为阻断依据。
- 不要求离线 profile 导出凭空提供 Bearer。
- 不将同文件内未修改、且未被本次变更加重的既有行为扩大为阻断项。

### Requirement and traceability coverage

本轮延续原完整范围，审计 **R27 §47–54、全部指定实际 diff、直接影响的生产者与消费者，以及相关测试**，未缩减为最后一处附件修复。

| 要求 | 核验结论 |
|---|---|
| 页面认证与输入框一致 | 表单 textbox 合同覆盖认证、Project、模式、输入、附件与发送；认证条件保持。 |
| 提交与回答归属 | 新角色/turn 属性贯穿计数、状态、正文、产物与滚动；新增用户消息仍是接受事实。 |
| 附件完整提交 | 当前卡片解析替换退休属性；文件名、数量、残留清理、可信发送保持。 |
| 持久会话身份 | 临时 ID 在 URL 策略 owner 被排除；原轮询等待永久地址，跨会话保护保持。 |
| 私有认证持久化 | 原文 patch 保存未修改的认证；公开返回继续由 schema 限定，合法类型切换保持。 |
| 新实现加载 | CLI/core 同步31，使用原版本淘汰机制。 |
| 语音恢复与复用 | 缓存/profile/browser 既有编排保持；成功快照自动写回，后继 HTTP 消费同一快照。 |
| 取消与期限 | 独立回归确认取消、固定期限、资源释放及后继请求可用。 |

关键路径已直接核验：`packages/opencode/src/config/config.ts:352`、`packages/opencode/src/config/config.ts:810`、`packages/opencode/src/server/shared/tui-control.ts:99`、`thirdparty/chatgpt-browser-agent/chatgpt-project.js:71`、`thirdparty/chatgpt-browser-agent/chatgpt-core.js:1400`。

**本轮独立执行结果：**
- global 配置：**15 pass，0 fail**。
- `voice-auth.test.ts`：**53 pass，0 fail，198断言**；包含先前单独通过的3项账户快照复用测试。
- DOM、身份、Project、上传、image、回答与产物读取：**13 pass**。
- 隔离取消及旧 daemon 消费路径：**3 pass**。
- 包级 `bun typecheck`：**通过**。
- 两仓库定向 `git diff --check`：**通过**，仅既有行尾提示。

测试固定期望独立于生产算法；无旧属性的 fixtures、认证原文保留和临时 URL 用例均对原错误行为敏感。本轮未重新制造历史 RED，也未将 builder 的 RED 汇总冒充独立执行结果。

真实恢复证据已直接读取：`D:/Temp/opencode/r27-no-auth-1790709679193.jsonl:9` 记录浏览器恢复、自动写回、隔离配置更新后认证保持，以及第二轮 HTTP200、CLI调用0。Alt+V 记录证明录音上传与清理，其静音结果边界继续保留。

### Primary-path and fallback verdict

**通过。**

新增备用成功路径为0。配置更新统一为原文 patch；对象合并与类型替换属于同一算法。附件旧双解析及失效 helper 已删除。缓存/profile/browser 沿既有明确合同执行，没有手填凭据或绕过主路径的新增机制。

新增诊断决策路径为0；现有 dump 的属性替换不产生成功替代路径。

### Code quality and Chinese-comment verdict

实际 diff 独立计量：

| 范围 | E | 合格 C | C/E |
|---|---:|---:|---:|
| 五个生产文件 | 48 | 18 | 37.50% |
| 四个测试文件 | 186 | 43 | 23.12% |
| 合计 | **234** | **61** | **26.07%** |

排除空行、import-only 和文档；没有生成代码或纯移动扣减。合格注释邻近解释认证保存、DOM合同、身份边界及测试意图，达到15%目标。

生产修改为 **5文件，新增67行、删除74行，增删共141行**，满足5文件/600行限制。未新增依赖、配置项、状态机或生产 helper；未发现无依据的生产概念或接口扩张。

### Release verdict

**APPROVE — `docs/plans/chatgpt-voice-direct-transcribe-mcp-auth.md`，Revision R27，当前实际 diff 的全范围独立实现审计。**

前轮暂缓所需的定向验证与 typecheck 已由本轮独立执行关闭。本结论允许记录该精确修订和 diff 达到 `verified-implementation`；不代表全量 CI 全绿，也不代表已安装 OpenCode 后端已经部署。

本轮未修改实现或用户配置，未操作账户浏览器或现用 daemon，未提交、暂存或推送。

记录方据此设为verified。当前实施目标方案审计R23/R24/R25/R26/R27共5轮，全部按原范围；实现审计1轮同会话闭合。R20-R22属前一方案目标的历史审计，保留不作当前代码放行依据。当前目标不包含发布，改动留在工作树，不提交、不推送；无关暂存内容保留。
