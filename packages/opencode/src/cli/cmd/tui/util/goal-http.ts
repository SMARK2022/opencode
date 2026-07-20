import { MAX_OBJECTIVE_CHARS, type Goal as SessionGoalInfo } from "@/session/goal"
import type { GoalSlashIntent } from "./parse-goal-slash"

export type GoalHttpSetInput = {
  objective?: string
  status?: string
  continueOnError?: boolean
}

export type GoalHttpDeps = {
  url: string
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  onError: (message: string) => void
}

// 与 dialog-goal / prompt submit 共用用户写适配器：只走既有 Goal HTTP，不新增 domain 写路径（INV-06）
export async function goalHttpSet(deps: GoalHttpDeps, input: GoalHttpSetInput) {
  // 仅对 objective 做长度预检；status-only 更新必须跳过，否则会误拦 Pause/Resume
  // 上限常量与 SessionGoal.MAX_OBJECTIVE_CHARS 一致，提前拦截避免无效往返
  if (input.objective !== undefined && input.objective.trim().length > MAX_OBJECTIVE_CHARS) {
    deps.onError(`Goal objective must be at most ${MAX_OBJECTIVE_CHARS} characters`)
    return undefined
  }
  try {
    const resp = await deps.fetch(deps.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!resp.ok) {
      const body = await resp.json().catch(() => null)
      deps.onError(body?.data?.message ?? "Failed to update goal")
      return undefined
    }
    return await resp.json()
  } catch {
    deps.onError("Failed to update goal")
    return undefined
  }
}

export async function goalHttpClear(deps: GoalHttpDeps) {
  try {
    const resp = await deps.fetch(deps.url, { method: "DELETE" })
    if (!resp.ok) {
      deps.onError("Failed to clear goal")
      return false
    }
    return true
  } catch {
    deps.onError("Failed to clear goal")
    return false
  }
}

export function goalEndpointUrl(base: string, sessionID: string, directory?: string) {
  const url = new URL(`/session/${sessionID}/goal`, base)
  if (directory) url.searchParams.set("directory", directory)
  return url.toString()
}

export type ExecuteGoalSlashInput = {
  intent: GoalSlashIntent
  sessionID: string
  sdkUrl: string
  directory?: string
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  onError: (message: string) => void
  // HTTP body.goal → 调用方 sync.goal.reconcile
  onReconcile: (goal: SessionGoalInfo) => void
  openDialog: (hasGoal: boolean) => void
  hasGoal: boolean
}

// intent → HTTP/dialog 的唯一执行映射；返回 false 表示失败（调用方保留草稿、不 navigate）
export async function executeGoalSlashIntent(input: ExecuteGoalSlashInput): Promise<boolean> {
  // 零参数：打开 dialog 算控制面成功，仍走 submit 共享成功尾（home 时 navigate）
  if (input.intent.type === "dialog") {
    input.openDialog(input.hasGoal)
    return true
  }

  const deps: GoalHttpDeps = {
    url: goalEndpointUrl(input.sdkUrl, input.sessionID, input.directory),
    fetch: input.fetch,
    onError: input.onError,
  }

  // clear 走 DELETE；其余 verb/set 统一 POST GoalSetPayload
  if (input.intent.type === "clear") {
    return await goalHttpClear(deps)
  }

  // 封闭映射：每种 intent 只对应一种 HTTP body，禁止隐式默认 status
  // set-objective 只传 objective（domain 自管 status）；start 显式 active
  const body: GoalHttpSetInput =
    input.intent.type === "set-objective"
      ? { objective: input.intent.objective }
      : input.intent.type === "start"
        ? { objective: input.intent.objective, status: "active" }
        : input.intent.type === "resume"
          ? { status: "active" }
          : input.intent.type === "pause"
            ? { status: "paused" }
            : { continueOnError: input.intent.continueOnError }

  const result = await goalHttpSet(deps, body)
  // undefined = 预检失败或 HTTP 错误；调用方不得清草稿/navigate
  if (result === undefined) return false
  // response 形状 { goal }；reconcile 供 TUI store 立即更新（不等 SSE）
  if (result && typeof result === "object" && result !== null && "goal" in result) {
    const goal = (result as { goal?: SessionGoalInfo | null }).goal
    if (goal) input.onReconcile(goal)
  }
  return true
}
