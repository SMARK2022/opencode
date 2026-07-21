export * as SessionGoalProgress from "./goal-progress"

import path from "path"
import { FSUtil } from "../fs-util"
import { SessionMessage } from "./message"

// 两代历史只在入口归一化证据，去重和策略切换仍由这一处拥有。
export type Evidence =
  | { type: "patch"; files: readonly string[]; hash: string }
  | { type: "tool"; tool: string; state: { status: string; input: unknown; metadata?: unknown; output?: string } }

// #517：Goal progress gate：run-local 证据账本，不持久化、不写入 Goal 状态。
// exploration 只证明活动；advancement（Todo 完成/有效 diff/验证结果变化）才能退出 replan。
export type GoalProgressLedger = {
  // 每个集合都只属于一次 runLoop；Goal DB 不应被瞬时探索痕迹污染。
  todos: Set<string>
  // 文件键承载真实 diff/patch identity，不把同一文件的重复展示当作推进。
  files: Set<string>
  // read 键必须包含 canonical version 和 range，避免旧内容覆盖新证据。
  reads: Set<string>
  // search 键表示语义 scope，而不是 provider 传参的对象顺序。
  searches: Set<string>
  // 泛化 command 只证明模型仍在行动，不能单独清除 re-plan。
  commands: Set<string>
  // verification 按命令保存上一结果，只有结果改变才升级为 advancement。
  verifications: Map<string, string>
}

export function createGoalProgressLedger(): GoalProgressLedger {
  // synthetic continuation 共享此账本；同一 run 内的重复工具调用才能被识别。
  return {
    todos: new Set(),
    files: new Set(),
    reads: new Set(),
    searches: new Set(),
    commands: new Set(),
    verifications: new Map(),
  }
}

// #517：验证命令 allowlist——只识别仓库已有的验证入口，避免把任意带 check 字样的命令误判为测试。
function isVerificationShellCommand(command: string) {
  const cmd = command.trim().toLowerCase()
  // 不在此处扩展语义 evaluator；未知 command 保持 exploration-only。
  return (
    /^(bun|npm|pnpm|yarn)\s+(run\s+)?(typecheck|test|build|lint|check|audit)(\s|$)/.test(cmd) ||
    /^node\s+--check(\s|$)/.test(cmd) ||
    /^python\s+-m\s+py_compile(\s|$)/.test(cmd) ||
    /^tsc\s+--noemit(\s|$)/.test(cmd)
  )
}

// #517：Shell tool 会在 metadata.output 尾部追加含 elapsed_ms/path 的运行时 notice，
// 这些字段描述执行器而非验证结果，必须从 comparable signature 中移除。
function stableVerificationOutput(output: string) {
  return output.replace(/<opencode_notice\b[^>]*\/>/g, "").trim()
}

// #517：去重必须发生在强度分类之前，否则重复证据会反复刷新停滞计数。
function recordIfNew(set: Set<string>, key: string) {
  if (set.has(key)) return false
  set.add(key)
  return true
}

// #517：搜索 producer 会把相对路径解析到 instance directory；这里复现同一边界，
// 否则 path 缺省、`.` 和 `a/../.` 会被误判成不同搜索分支。
function normalizeSearchPatterns(value: unknown) {
  // producer 同时接受单个 glob 和数组；统一成排序后的列表才能识别等价输入。
  const patterns = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return patterns.map(String).filter(Boolean).toSorted()
}

function normalizedSearchScope(input: Record<string, unknown>, directory: string) {
  // 缺省 path 与当前 instance 根目录等价，canonicalization 复用 search producer 的 realpath 边界。
  const requestedPath = typeof input.path === "string" && input.path !== "" ? input.path : "."
  const requested = path.isAbsolute(requestedPath) ? requestedPath : path.join(directory, requestedPath)
  return {
    // #517：目标无 AppFileSystem；与 grep.ts producer 同源使用 FSUtil.resolve。
    path: FSUtil.resolve(requested),
    include: normalizeSearchPatterns(input.include),
    exclude: normalizeSearchPatterns(input.exclude),
  }
}

// #517：各文件 producer 的 diff metadata 形状不同，按既有 producer 顺序读取而不新增 fallback。
function effectiveDiffSignal(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return false
  const filediff = metadata.filediff
  if (filediff && typeof filediff === "object" && !Array.isArray(filediff)) {
    const additions = Number((filediff as { additions?: unknown }).additions ?? 0)
    const deletions = Number((filediff as { deletions?: unknown }).deletions ?? 0)
    // additions/deletions 为零时，成功调用可能只是 formatter/no-op，不应推进 Goal。
    if (additions > 0 || deletions > 0) return true
  }
  const files = metadata.files
  if (Array.isArray(files)) {
    // apply_patch 聚合多个文件，必须先确认至少一个文件有非零变化。
    for (const file of files) {
      // 不完整的 file entry 只能忽略，不能因为对象存在就误判为成功编辑。
      if (!file || typeof file !== "object") continue
      const additions = Number((file as { additions?: unknown }).additions ?? 0)
      const deletions = Number((file as { deletions?: unknown }).deletions ?? 0)
      if (additions > 0 || deletions > 0) return true
      const patch = (file as { patch?: unknown }).patch
      // patch 文本是旧 producer 的兼容形状，仍要求真实 diff 行而非文件对象存在。
      if (typeof patch === "string" && /(?:^|\n)[+-](?![+-]{2})/.test(patch)) return true
    }
  }
  // write/edit/apply_patch 的主路径最终都可能只留下 metadata.diff。
  const diff = metadata.diff
  return typeof diff === "string" && /(?:^|\n)[+-](?![+-]{2})/.test(diff)
}

// #517：扫描刚完成的 Goal turn 内 assistant tool/patch 结果，更新账本并返回证据强度。
export function absorbGoalTurnEvidence(
  messages: Iterable<readonly Evidence[]>,
  directory: string,
  ledger: GoalProgressLedger,
): { exploration: boolean; advancement: boolean } {
  let exploration = false
  let advancement = false
  // 调用方按各自持久化 lineage 选定 eligible turn，不能把旧 turn 赊给新 turn。
  for (const parts of messages) {
    for (const part of parts) {
      if (part.type === "patch" && part.files.length > 0) {
        // patch part 证明工作树发生了实际文件变更；它比普通 tool metadata 更接近
        // processor 最终持久化的 diff，因此必须直接成为 advancement。
        if (recordIfNew(ledger.files, `patch:${part.hash}:${part.files.join("\0")}`)) advancement = true
        continue
      }
      // pending/running/error 不提供可靠的完成结果，不能先计入 progress ledger。
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const input = part.state.input as Record<string, unknown>
      const metadata = part.state.metadata as Record<string, unknown>

      if (part.tool === "todowrite") {
        // Todo 只在同一内容/优先级首次进入 completed 时推进；重复快照是模型重述，
        // 不能让停滞任务靠反复写相同清单离开 re-plan。
        const todos = Array.isArray(metadata.todos) ? metadata.todos : Array.isArray(input.todos) ? input.todos : []
        for (const todo of todos) {
          // 读取 metadata 优先于 input，因为完成状态可能由 tool processor 回写。
          if (!todo || typeof todo !== "object") continue
          const content = String((todo as { content?: unknown }).content ?? "")
          const priority = String((todo as { priority?: unknown }).priority ?? "")
          const status = String((todo as { status?: unknown }).status ?? "")
          if (status !== "completed" || content === "") continue
          // status/content/priority 组成 Todo 完成 identity；其他展示字段不应影响去重。
          if (recordIfNew(ledger.todos, `${content}\0${priority}`)) advancement = true
        }
        continue
      }

      if (part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch") {
        // 文件工具可能成功但产生空 diff；只有真实 additions/deletions 才拥有 advancement 语义。
        if (effectiveDiffSignal(metadata)) {
          const file = String(
            metadata.filepath ??
              input.filePath ??
              (Array.isArray(metadata.files) ? JSON.stringify(metadata.files) : part.tool),
          )
          // diff 文本进入 key，防止同一路径的新改动被旧工具调用吞掉。
          if (recordIfNew(ledger.files, `${part.tool}:${file}:${String(metadata.diff ?? "")}`)) advancement = true
        }
        continue
      }

      if (part.tool === "read") {
        const read = metadata.read
        if (
          read &&
          typeof read === "object" &&
          !Array.isArray(read) &&
          // stub 只表示导航提示，不是新文件版本；缺少完整 version identity 也不计入。
          (read as { stub?: unknown }).stub !== true &&
          typeof (read as { canonicalPath?: unknown }).canonicalPath === "string" &&
          typeof (read as { size?: unknown }).size === "number" &&
          typeof (read as { modifiedMs?: unknown }).modifiedMs === "number" &&
          typeof (read as { fp?: unknown }).fp === "string" &&
          (read as { fp: string }).fp !== "" &&
          typeof (read as { start?: unknown }).start === "number" &&
          typeof (read as { end?: unknown }).end === "number"
        ) {
          const r = read as {
            canonicalPath?: unknown
            size?: unknown
            modifiedMs?: unknown
            fp?: unknown
            start?: unknown
            end?: unknown
          }
          // range 参与 identity，覆盖读取不能把不同未检查区间折叠成一个证据点。
          // size/mtime 不是完整版本身份；read producer 已提供 head-sample fp（#511），
          // 同尺寸且 mtime 精度不足时也必须允许新内容触发 exploration。
          const key = [r.canonicalPath, r.size, r.modifiedMs, r.fp, r.start, r.end].map(String).join("\0")
          if (recordIfNew(ledger.reads, key)) exploration = true
        }
        continue
      }

      if (part.tool === "grep" || part.tool === "glob") {
        // timeout、permission metadata 和数组顺序不改变语义；key 必须匹配 producer
        // 的 canonical path/scope，避免同一搜索通过不同 spelling 无限制造探索。
        const scope = normalizedSearchScope(input, directory)
        const key = JSON.stringify({
          // pattern 是匹配语义的一部分，不能只按 path 去重所有搜索。
          tool: part.tool,
          pattern: input.pattern ?? "",
          ...scope,
        })
        // search 完成但没有命中也仍是一次新分支；命中数量不改变 scope identity。
        if (recordIfNew(ledger.searches, key)) exploration = true
        continue
      }

      if (part.tool === "bash" || part.tool === "shell") {
        const command = String(input.command ?? "")
        const exit = metadata.exit
        const hasErrors = metadata.hasErrors === true
        // shell metadata.output 是稳定的 stdout 摘要；fallback 到 state.output 兼容旧持久化 Part。
        const output = String(metadata.output ?? part.state.output ?? "")
        if (isVerificationShellCommand(command)) {
          const vkey = command.trim().toLowerCase()
          // 验证签名刻意忽略 duration/path，避免计时或截断路径噪声制造假变化；
          // 只有同一命令的结果真正改变才从 re-plan 回到 ordinary。
          const signature = `${String(exit)}\0${hasErrors ? "1" : "0"}\0${stableVerificationOutput(output)}`
          const prev = ledger.verifications.get(vkey)
          // 第一次结果建立 baseline；没有 baseline 就不能声称发生了状态变化。
          if (prev === undefined) {
            ledger.verifications.set(vkey, signature)
            exploration = true
          } else if (prev !== signature) {
            ledger.verifications.set(vkey, signature)
            advancement = true
          }
          continue
        }
        // generic command 也要去重，但它只影响 raw no-progress，不会清除 re-plan。
        const ckey = `${command.trim().toLowerCase()}\0${String(exit)}\0${output}`
        if (recordIfNew(ledger.commands, ckey)) exploration = true
      }
    }
  }
  return { exploration, advancement }
}

// #517：更新 no-progress 计数与 replan 模式：advancement 清零并退出；exploration 只清计数。
// 这个优先级保证“读到了新分支”和“真正改变状态”不会被混成一个强度。
export function updateGoalProgressGate(
  state: { noProgressTurns: number; replanRequired: boolean },
  signal: { exploration: boolean; advancement: boolean },
) {
  if (signal.advancement) {
    // advancement 是唯一允许退出 strategy-switch 的证据等级。
    state.noProgressTurns = 0
    state.replanRequired = false
    return
  }
  if (signal.exploration) {
    // exploration 证明 frontier 前进过，但不证明 Goal state 已向终态收敛。
    state.noProgressTurns = 0
    return
  }
  // 没有结构化证据的 turn 才累积停滞；模型 prose 和 token 消耗不在这里计数。
  state.noProgressTurns += 1
  // 连续两轮无探索也无推进，才切换并保持 replan，直到出现 advancement。
  if (state.noProgressTurns >= 2) state.replanRequired = true
}

// 原生消息保留自己的结构；这里只投影进度所需字段，不回造 V1 Part 或公共 schema。
export function nativeEvidence(messages: readonly SessionMessage.Message[]): Evidence[][] {
  return messages.flatMap((message) => {
    if (message.type !== "assistant") return []
    const parts: Evidence[] = []
    if (message.snapshot?.files?.length) {
      // Step owner 的快照证明实际变化，成功 write 本身不等同于有效 diff。
      parts.push({ type: "patch", files: message.snapshot.files, hash: `${message.snapshot.start ?? ""}:${message.snapshot.end ?? ""}` })
    }
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const metadata = part.state.structured
      // Bash 首段是稳定输出，后附耗时说明不能制造验证结果变化。
      const output = part.state.content.flatMap((content) => content.type === "text" ? [content.text] : [])[0] ?? ""
      parts.push({
        type: "tool",
        tool: part.name,
        state: {
          status: "completed",
          input: part.state.input,
          // Read 版本凭证与 Bash 错误标记由真实 producer 拥有，不从正文或诊断行数重建。
          metadata,
          output,
        },
      })
    }
    return [parts]
  })
}
