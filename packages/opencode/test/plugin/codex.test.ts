import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Provider } from "@opencode-ai/sdk/v2"
import {
  CODEX_HEADERS,
  CODEX_USER_AGENT,
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("filters OAuth GPT versions without treating minor versions as decimals", async () => {
    // 只调用 models hook；完整输入满足插件接口，但不启动认证或实际 HTTP 请求。
    const hooks = await CodexAuthPlugin({
      client: createOpencodeClient(),
      project: { id: "test", worktree: ".", time: { created: 0 } },
      directory: ".",
      worktree: ".",
      serverUrl: new URL("http://localhost"),
      $: Bun.$,
      experimental_workspace: { register() {} },
    })
    const models = hooks.provider?.models
    if (!models) throw new Error("Codex models hook missing")
    // 独立预期包含整数与多位 minor；5.10 大于 5.4，不能按十进制小数排序。
    const allowed = ["gpt-6-astra", "gpt-6", "gpt-5.10", "gpt-10", "gpt-5.5"]
    // 本地原有白名单仍放行 5.2；回移不能夹带上游的模型下线策略。
    const legacy = ["gpt-5.2", "gpt-5.4"]
    // suffix 不能提升版本，4.99 的大 minor 也不能越过 major 边界。
    const blocked = ["gpt-5", "gpt-5.4-astra", "gpt-4.99", "not-a-gpt-model"]
    const provider: Provider = {
      id: "openai",
      name: "OpenAI",
      source: "config",
      env: [],
      options: {},
      models: Object.fromEntries(
        [...allowed, ...legacy, ...blocked].map((id) => [
          id,
          {
            id,
            providerID: "openai",
            name: id,
            api: { id, url: "https://example.com", npm: "@ai-sdk/openai" },
            capabilities: {
              temperature: false,
              reasoning: true,
              attachment: false,
              toolcall: true,
              interleaved: false,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
            },
            // 非零 API 价格让 OAuth 的零计费转换可被观察，而非零值 fixture 的自证。
            cost: { input: 1, output: 2, cache: { read: 1, write: 1 } },
            limit: { context: 100, output: 10 },
            status: "active",
            options: {},
            headers: {},
            release_date: "",
          },
        ]),
      ),
    }
    // API-key 目录不受订阅筛选影响；OAuth 的免费计费元数据仍由插件维护。
    expect(await models(provider, { auth: { type: "api", key: "offline" } })).toEqual(provider.models)
    const filtered = await models(provider, {
      auth: { type: "oauth", access: "offline", refresh: "offline", expires: 0 },
    })
    expect(Object.keys(filtered)).toEqual([...allowed, ...legacy])
    expect(filtered["gpt-6-astra"]?.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    // 版本比较不负责重定义上下文窗口；5.5 特例和其他模型原限额均须保持。
    expect(filtered["gpt-5.5"]?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(filtered["gpt-6-astra"]?.limit).toEqual({ context: 100, output: 10 })
  })

  test("uses Codex TUI User-Agent for OAuth model requests", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const options = await hooks.auth!.loader!(() =>
      Promise.resolve({
        type: "oauth" as const,
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 60_000,
      }),
      {} as never,
    )
    expect(options.headers).toEqual(CODEX_HEADERS)
  })

  test("sets Codex TUI User-Agent in chat headers", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const output = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(
      {
        sessionID: "session-id",
        agent: "build",
        model: { providerID: "openai" },
        provider: {},
        message: {},
      } as never,
      output,
    )
    expect(output.headers["Content-Type"]).toBe("application/json")
    expect(output.headers.originator).toBe("codex-tui")
    expect(output.headers["User-Agent"]).toBe(CODEX_USER_AGENT)
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })
})
