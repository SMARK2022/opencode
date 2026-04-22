import { createHash, randomUUID } from "crypto"
import { xxh64 } from "@node-rs/xxhash"

// --- Constants ---
export const VERSION = "2.1.117"
const SALT = "59cf53e54c78"
const ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
].join(",")

export const CLI_IDENTITY_BLOCK = {
  type: "text" as const,
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
  cache_control: { type: "ephemeral" as const },
}

export const MAIN_SYSTEM_BLOCK = {
  type: "text" as const,
  text: [
    "You are an interactive agent that helps users with software engineering tasks.",
    "Use the instructions below and the tools available to you to assist the user.",
    "",
    "# System",
    " - All text you output outside of tool use is displayed to the user.",
    " - Tool results and user messages may include <system-reminder> tags.",
    " - The conversation has unlimited context through automatic summarization.",
  ].join("\n"),
  cache_control: { type: "ephemeral" as const },
}

// --- Session State Management ---
export interface CubenceSession {
  sessionId: string
  deviceId: string
  accountUuid: string
}

let sessionInstance: CubenceSession | null = null

export function getSession(opts?: { deviceId?: string }): CubenceSession {
  if (!sessionInstance) {
    sessionInstance = {
      sessionId: randomUUID(),
      deviceId: opts?.deviceId ?? randomUUID(),
      accountUuid: "",
    }
  }
  return sessionInstance
}

// --- Logic functions ---
export function computeFingerprint(messageText: string, version: string): string {
  const pick = (i: number) => (messageText.length > i ? messageText[i] : "0")
  const chars = pick(4) + pick(7) + pick(20)
  const input = `${SALT}${chars}${version}`
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 3)
}

export function buildBillingHeaderBlock(fp: string) {
  return {
    type: "text" as const,
    text: [
      `x-anthropic-billing-header:`,
      ` cc_version=${VERSION}.${fp};`,
      ` cc_entrypoint=cli;`,
      ` cch=00000;`,
    ].join(""),
  }
}

export function buildSystemBlocks(fp: string) {
  return [buildBillingHeaderBlock(fp), CLI_IDENTITY_BLOCK, MAIN_SYSTEM_BLOCK]
}

export function buildMetadataUserId(opts: { deviceId: string; sessionId: string; accountUuid?: string }) {
  return JSON.stringify({
    device_id: opts.deviceId,
    account_uuid: opts.accountUuid ?? "",
    session_id: opts.sessionId,
  })
}

export function buildRequestHeaders(opts: { token: string; sessionId: string }): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ANTHROPIC_BETAS,
    "x-app": "cli",
    "user-agent": `claude-cli/${VERSION} (external, cli)`,
    "x-claude-code-session-id": opts.sessionId,
    authorization: `Bearer ${opts.token}`,
  }
}

// --- CCH computation ---
export function computeCch(bodyBytes: Uint8Array): string {
  const hash: bigint = xxh64(bodyBytes)
  const low20 = hash & BigInt(0xfffff)
  return low20.toString(16).padStart(5, "0")
}

export function patchCch(bodyStr: string): string {
  const PLACEHOLDER = "cch=00000"

  const idx = bodyStr.indexOf(PLACEHOLDER)
  if (idx === -1) {
    console.warn("[claudecode] cch placeholder not found in body, skipping patch")
    return bodyStr
  }

  const bodyBytes = new TextEncoder().encode(bodyStr)
  const cch = computeCch(bodyBytes)

  return bodyStr.slice(0, idx + 4) + cch + bodyStr.slice(idx + 9)
}

// --- Fetch Wrapper ---
export function createClaudeCodeFetch(opts: { session: CubenceSession; token: string; baseUrl: string }) {
  const { session, token, baseUrl } = opts

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()

    if (!url.includes("/v1/messages")) {
      return fetch(input, init)
    }

    const originalBody = init?.body
      ? JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      : {}

    const firstUserMessage = (originalBody.messages ?? []).find((m: { role: string }) => m.role === "user")

    const firstUserText = (() => {
      if (!firstUserMessage) return ""
      const content = firstUserMessage.content
      if (typeof content === "string") return content
      if (Array.isArray(content)) {
        return content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("")
      }
      return ""
    })()

    const fp = computeFingerprint(firstUserText, VERSION)

    const patchedBody = {
      ...originalBody,
      system: buildSystemBlocks(fp),
      metadata: {
        user_id: buildMetadataUserId({
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          accountUuid: session.accountUuid,
        }),
      },
      thinking: originalBody.thinking ?? {
        type: "enabled",
        budget_tokens: 31999,
      },
    }

    const bodyWithPlaceholder = JSON.stringify(patchedBody)
    const finalBodyStr = patchCch(bodyWithPlaceholder)

    const headers = buildRequestHeaders({
      token,
      sessionId: session.sessionId,
    })

    const requestHeaders = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value)
    }
    // Remove the default authorization since we manually set it, but keep others?
    // Wait, the auth might have been set by the SDK, we just overwrite it with ours.
    
    // Some endpoints may require dropping `/v1/messages` duplicate if `baseUrl` already includes it
    // Wait, `baseUrl` in custom provider is passed to the SDK. 
    // If the sdk is Anthropic, it appends `/v1/messages` itself!
    // But `input` is what SDK sends. We can just use `input` instead of concatenating `baseUrl/v1/messages`.
    // Wait! SDK sends to `baseUrl/v1/messages` automatically, so `input` is already the correct full URL.
    // So let's just use `input`.
    
    return fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: requestHeaders,
      body: finalBodyStr,
    })
  }
}

// --- Provider registration ---
export function createClaudeCodeProvider(token: string, baseUrl: string) {
  const session = getSession()

  return {
    baseURL: `${baseUrl}/v1`,
    fetch: createClaudeCodeFetch({
      session,
      token,
      baseUrl,
    }),
    headers: {}, // Let our fetch wrapper handle headers
  }
}
