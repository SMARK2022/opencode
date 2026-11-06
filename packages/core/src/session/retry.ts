import type { NamedError } from "../util/error"
import { SessionV1 } from "../v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { isCloudflareBlock, isContextOverflowFailure, LLMError, LLMEvent, type ProviderErrorEvent } from "@opencode-ai/llm"
import { iife } from "../util/iife"
import { GO_UPSELL_MESSAGE, GO_UPSELL_URL } from "./retry-constants"
export { GO_UPSELL_MESSAGE, GO_UPSELL_URL }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export type Err = ReturnType<NamedError["toObject"]> | LLMError | ProviderErrorEvent

// 只投影原字段；资格仍归同一 policy，HTTP 正文和头用于原有限额动作与等待。
export function apiError(error: LLMError | ProviderErrorEvent) {
  const http = error instanceof LLMError && "http" in error.reason ? error.reason.http : undefined
  return new SessionV1.APIError({
    message: error instanceof LLMError ? error.reason.message : error.message,
    isRetryable: error instanceof LLMError ? error.retryable : error.retryable ?? false,
    statusCode: http?.response?.status,
    responseHeaders: http?.response?.headers,
    responseBody: http?.body,
  })
}

// 旧消息格式仍需具体错误类别；识别和字段适配集中在这里，消息层不再重复解释原生错误。
export function fromError(error: unknown, providerID: string) {
  if (!(error instanceof LLMError) && !LLMEvent.is.providerError(error)) return
  const projected = apiError(error)
  if (isContextOverflowFailure(error)) return new SessionV1.ContextOverflowError({
    message: projected.data.message, responseBody: projected.data.responseBody,
  }).toObject()
  if (error instanceof LLMError && error.reason._tag === "Authentication") return new SessionV1.AuthError({
    providerID, message: error.reason.message,
  }).toObject()
  if (error instanceof LLMError && error.reason._tag === "ContentPolicy")
    return new SessionV1.ContentFilterError({ message: error.reason.message }).toObject()
  return new SessionV1.APIError({ ...projected.data, isRetryable: !!retryable(error, providerID) }).toObject()
}

export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
// [local-smark] 将有 header 时的 retry 上限从 32 位整数极值（~24.8 天）改为 30 分钟。
// 原值允许 provider 的 retry-after header 指定天级等待，导致 session 假死；
// 30 分钟覆盖 transient 429/503 以及 quota reset（通常分钟到小时级）场景，
// 超过 30 分钟的 retry-after 被截断，避免 session 长时间假死。
export const RETRY_MAX_DELAY = 1_800_000 // 30 minutes
// 保留原次数合同；安全整数上限在实际会话中不可达，等效持续恢复。
export const RETRY_MAX_RETRIES = Number.MAX_SAFE_INTEGER

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError | LLMError, random = Math.random()): number {
  if (error instanceof LLMError) {
    const projected = apiError(error)
    const headers = projected.data.responseHeaders
    // 原始头先走旧解析；过期 HTTP 日期归一化的零不能冒充显式零等待。
    if (error.retryAfterMs !== undefined && headers?.["retry-after-ms"] === undefined && headers?.["retry-after"] === undefined) {
      return cap(error.retryAfterMs)
    }
    return delay(attempt, projected, random)
  }
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(exponential(attempt, random))
    }
  }

  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  // 等待达到上限后不再增长指数，避免无限重试中的 Infinity * 0 变成 NaN。
  const base = Math.min(RETRY_MAX_DELAY, RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

export function retryable(error: Err, provider: string) {
  if (error instanceof LLMError) {
    // 明确上下文/业务拒绝先于文本匹配，不能被“unavailable”等正文重新放行。
    if (isContextOverflowFailure(error)) return undefined
    const http = "http" in error.reason ? error.reason.http : undefined
    // 旧 parseAPICallError 仅对 openai* 的 404 覆盖 SDK 否决；其他暂时故障沿上游 retryable。
    const openai404 = error.reason._tag === "InvalidRequest" && provider.startsWith("openai") && http?.response?.status === 404
    if (!error.retryable && !openai404) return undefined
    // 获准的原生错误进入原 APIError 分支，Free/Go 的动作和链接保持同一来源。
    return retryable(new SessionV1.APIError({ ...apiError(error).data, isRetryable: true }).toObject(), provider)
  }
  if (LLMEvent.is.providerError(error)) {
    // 未标记流错误统一恢复；显式拒绝和上下文溢出仍保留已有语义。
    if (error.classification === "context-overflow" || error.retryable === false) return undefined
    return { message: error.message }
  }
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    // #191：移除 status !== undefined 守卫——无 statusCode 的可重试错误（transport）也应重试
    // SDK的不可重试标志不能覆盖明确429或Cloudflare拦截，退避与既有文本识别仍归原policy。
    if (
      !error.data.isRetryable &&
      status !== 429 &&
      !isCloudflareBlock(status, error.data.responseHeaders, error.data.responseBody ?? "") &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      // #191：FreeUsageLimitError 是计费门槛，优先于通用 5xx 重试判定
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse?: (error: unknown) => Err | undefined
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number; error: SessionV1.APIError["data"] }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      // 原生入口默认直接交原错误；只有旧 SDK 或既有语义额度才需要调用方适配。
      const error = opts.parse?.(meta.input) ?? (
        meta.input instanceof LLMError || LLMEvent.is.providerError(meta.input)
          ? meta.input : { name: "UnknownError", data: {} }
      )
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, error instanceof LLMError || SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        const data = error instanceof LLMError || LLMEvent.is.providerError(error)
          ? apiError(error).data : SessionV1.APIError.isInstance(error) ? error.data : undefined
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
          error: { ...data, message: retry.message, isRetryable: true },
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

// #214：retry 封装——将 policy 分类/延迟集中一处，供 processor 和 reviewer 子代理流复用
// #214：hidden reviewer 子代理流无法进入 processor 而不创建依赖环——复用同一重试策略
// #214：调用方仍拥有 set 副作用——主会话更新 status，reviewer 子代理流重试时不发明独立 UI 状态
export function retry(opts: Parameters<typeof policy>[0]) {
  return <A, E, R>(self: Effect.Effect<A, E, R>) => self.pipe(Effect.retry(policy(opts)))
}

export * as SessionRetry from "./retry"
