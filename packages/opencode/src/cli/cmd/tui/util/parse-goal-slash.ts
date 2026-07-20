// Goal 输入框 slash 解析：只在命令名处切一刀，rest 整串保留空格（INV-01）
// 禁止 argv/$1 词切——objective 是自然语言整段，domain 字段也是单 string。

export type GoalSlashIntent =
  | { type: "dialog" }
  | { type: "set-objective"; objective: string }
  | { type: "start"; objective: string }
  | { type: "resume" }
  | { type: "pause" }
  | { type: "clear" }
  | { type: "continue"; continueOnError: boolean }

// 首个 ASCII 空白 run 处切分：left=命令 token，right=其后全部字符（可含空格/换行）
// 换行故意放进 rest（[\s\S]），与 server command 多行 arguments 一体哲学对齐
function splitOnceOnFirstWhitespace(text: string): { head: string; rest: string } {
  const match = text.match(/^(\S+)(?:[ \t\f\v]+([\s\S]*))?$/)
  if (!match) return { head: text, rest: "" }
  return { head: match[1] ?? text, rest: match[2] ?? "" }
}

// clear 同义整段匹配；不得对 payload 再切词
const CLEAR_ALIASES = new Set(["clear", "delete", "remove"])

export function parseGoalSlashInput(raw: string): GoalSlashIntent | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("/")) return undefined

  const body = trimmed.slice(1)
  const { head, rest } = splitOnceOnFirstWhitespace(body)
  if (head.toLowerCase() !== "goal") return undefined

  // 无 rest 或仅空白 → 打开 dialog（零参数 discoverability）
  const restTrimmed = rest.trim()
  if (!restTrimmed) return { type: "dialog" }

  const lower = restTrimmed.toLowerCase()

  // INV-10：resume/pause/clear 必须 rest 整段等于动词，
  // 否则 “resume the work” 会被误当成 resume 而丢失任务文本
  if (lower === "resume") return { type: "resume" }
  if (lower === "pause") return { type: "pause" }
  if (CLEAR_ALIASES.has(lower)) return { type: "clear" }

  // continue 同样整段精确匹配；多出 trailing 词时降级为 free-objective
  if (lower === "continue on" || lower === "continue true") {
    return { type: "continue", continueOnError: true }
  }
  if (lower === "continue off" || lower === "continue false") {
    return { type: "continue", continueOnError: false }
  }

  // set/edit/start：显式动词消费后，payload 再次一体（消歧任务以 resume 开头）
  // 动词后无 payload 时不当动词——整 rest 仍是 objective（如 "/goal set"）
  const { head: verb, rest: payload } = splitOnceOnFirstWhitespace(restTrimmed)
  const verbLower = verb.toLowerCase()
  const payloadTrimmed = payload.trim()
  if ((verbLower === "set" || verbLower === "edit") && payloadTrimmed) {
    return { type: "set-objective", objective: payloadTrimmed }
  }
  if (verbLower === "start" && payloadTrimmed) {
    // start = objective + 显式 active，与裸 set 的 domain 默认 status 规则区分
    return { type: "start", objective: payloadTrimmed }
  }

  // 默认 free-objective：整 rest 即 objective（含首词碰巧是保留词但带后续文本）
  return { type: "set-objective", objective: restTrimmed }
}
