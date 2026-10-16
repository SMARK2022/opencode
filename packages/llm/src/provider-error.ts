import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

// 来源头、HTML和页面指纹缺一不可，不能把普通鉴权或JSON策略拒绝误判为拦截。
export const isCloudflareBlock = (status: number | undefined, headers: Readonly<Record<string, string>> | undefined, body: string) =>
  status === 403 &&
  headers?.server?.trim().toLowerCase() === "cloudflare" &&
  !!headers["cf-ray"]?.trim() &&
  /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body) &&
  (headers["cf-mitigated"]?.trim().toLowerCase() === "challenge" ||
    (body.includes("window._cf_chl_opt") && body.includes("/cdn-cgi/challenge-platform/")) ||
    (/\bid\s*=\s*["']cf-error-details["']/i.test(body) && body.includes("/cdn-cgi/styles/cf.errors.css")) ||
    (body.includes("Unable to load site") &&
      body.includes("Please try again later") &&
      body.includes("https://status.openai.com/")))

const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

const exclusions = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  (patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message))

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
