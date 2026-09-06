import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { ConfigParse } from "../../../src/config/parse"
import { ConfigMCP } from "../../../src/config/mcp"
import {
  authFromHarvest,
  buildDirectTranscribeRequest,
  ensureVoiceCredential,
  jwtExpiresAt,
  mergeSetCookieCookies,
  readVoiceAuth,
  takeVoiceAuthNotice,
  transcribeDirect,
  VOICE_COOKIE_HARVEST_MARGIN_S,
  VOICE_TOKEN_MARGIN_S,
  VOICE_TRANSCRIBE_URL,
  writeVoiceAuth,
  type VoiceAuth,
  type VoiceAuthRuntime,
} from "../../../src/cli/cmd/tui/util/voice-auth"
import type { VoiceTranscriberDirect } from "../../../src/cli/cmd/tui/prompt-voice-input"

const auth: VoiceAuth = {
  access_token: "token-1",
  token_expires_at: 1_800_000_000,
  fetched_at: "2026-09-06T00:00:00Z",
  cookies: { "oai-did": { value: "did-1", expires: 0 } },
}

// 手写配置含注释、trailing comma 与 auth 之外的兄弟字段，是注释保真写入的真实输入域。
const handwritten = `{
  // 用户手写注释必须原样保留
  "model": "test/model",
  "mcp": {
    "chatgpt": {
      "type": "local",
      "command": ["node", "mcp-server.js"],
      "enabled": true,
    },
  },
}
`

describe("voice auth node", () => {
  // 写入方唯一合同：只替换 mcp.<key>.auth 节点，注释、缩进与兄弟字段逐字保留。
  // 手写内容含 trailing comma 与嵌套缩进，是注释保真写入的最严输入域。
  test("writes only the auth node and preserves comments and sibling fields", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, handwritten)

    await writeVoiceAuth(config, "chatgpt", auth)

    const after = await Bun.file(config).text()
    expect(after).toContain("// 用户手写注释必须原样保留")
    expect(after).toContain('"model": "test/model"')
    expect(after).toContain('"command": ["node", "mcp-server.js"]')
    expect(await readVoiceAuth(config, "chatgpt")).toEqual(auth)
  })

  // 重复收割必须原地替换而不是堆积重复键；旧 token 不能在文件中残留。
  test("replaces a stale auth node in place without duplicating keys", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.jsonc")
    await Bun.write(config, handwritten)

    await writeVoiceAuth(config, "chatgpt", auth)
    const refreshed: VoiceAuth = { ...auth, access_token: "token-2" }
    await writeVoiceAuth(config, "chatgpt", refreshed)

    const after = await Bun.file(config).text()
    // access_token 唯一性防止旧 token 残留：残留值会被状态机当作缓存继续消费。
    expect((after.match(/"access_token"/g) ?? []).length).toBe(1)
    expect(await readVoiceAuth(config, "chatgpt")).toEqual(refreshed)
  })

  // 读取边界：缺 auth 节点或文件不可解析时返回 undefined，不抛错破坏语音主路径。
  // 文件不存在与解析失败同路径：都降级为无凭据，状态机自行进入收割。
  test("returns undefined for missing auth node or unparsable config", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, handwritten)
    expect(await readVoiceAuth(config, "unknown-key")).toBeUndefined()

    const broken = path.join(tmp.path, "broken.json")
    await Bun.write(broken, "{ not json")
    expect(await readVoiceAuth(broken, "chatgpt")).toBeUndefined()

    expect(await readVoiceAuth(path.join(tmp.path, "absent.json"), "chatgpt")).toBeUndefined()
  })

  // 形状校验：auth 节点缺关键字段时视为不存在，避免半写状态进入凭据状态机。
  // 残缺凭据被拒绝后状态机重新收割，不尝试"部分可用"拼凑。
  test("rejects malformed auth nodes instead of returning partial credentials", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "x"], auth: { access_token: 42 } } } }))
    expect(await readVoiceAuth(config, "chatgpt")).toBeUndefined()
  })
})

const SESSION_COOKIE = "__Secure-next-auth.session-token"
const now = 1_800_000_000_000

// 一次性提示是模块级队列：排空后断言，顺序无关且不受先前用例残留影响（controller 同款排水语义）。
function drainNotices(): string[] {
  const drained: string[] = []
  for (let notice = takeVoiceAuthNotice(); notice !== undefined; notice = takeVoiceAuthNotice()) drained.push(notice)
  return drained
}

// 直连变体 fixture：config 指向临时文件，interpreter/script 指向可执行假 CLI。
async function directFixture(scope: "user" | "project", initAuth?: VoiceAuth) {
  const tmp = await tmpdir()
  const config = path.join(tmp.path, "opencode.json")
  const script = path.join(tmp.path, "fake-agent.cjs")
  await Bun.write(script, "")
  await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "mcp-server.js"] } } }))
  await writeVoiceAuth(config, "chatgpt", initAuth ?? validAuth())
  const direct: VoiceTranscriberDirect = {
    type: "chatgpt-direct",
    config,
    key: "chatgpt",
    interpreter: process.execPath,
    script,
    scope,
    transcriber: { command: "unused", args: ["transcribe-file", "--file", "{file}", "--json"] },
  }
  return { tmp, direct }
}

function validAuth() {
  // 健康域 fixture：token 7 天、会话凭据 90 天，均远离两个 margin，任何路径都不应触发收割。
  return {
    access_token: "alive-token",
    token_expires_at: (now + 7 * 86_400_000) / 1000,
    fetched_at: "2026-09-06T00:00:00Z",
    cookies: { [SESSION_COOKIE]: { value: "sess", expires: (now + 90 * 86_400_000) / 1000 } },
  }
}

function expiredTokenAuth(sessionExpiresMs: number, extraCookies: Record<string, { value: string; expires: number }> = {}) {
  // 过期域 fixture：token 已死，会话凭据剩余寿命由参数钉定，驱动状态机在刷新与收割间分岔。
  return {
    access_token: "expired-token",
    token_expires_at: (now - 1000) / 1000,
    fetched_at: "2026-09-06T00:00:00Z",
    cookies: {
      [SESSION_COOKIE]: { value: "sess", expires: sessionExpiresMs / 1000 },
      ...extraCookies,
    },
  }
}

function spyRuntime(overrides: Partial<VoiceAuthRuntime> = {}): VoiceAuthRuntime & { counts: { fetchSession: number; harvest: number } } {
  // spy 基线默认全部失败路径；成功场景由用例按需覆盖，counts 是零网络/零收割断言的独立证据。
  const counts = { fetchSession: 0, harvest: 0 }
  return {
    counts,
    now: () => now,
    fetchSession: async () => {
      counts.fetchSession++
      return undefined
    },
    harvest: async () => {
      counts.harvest++
      throw new Error("harvest spy must be overridden")
    },
    directFetch: async () => new Response("{}"),
    ...overrides,
  }
}

describe("ensure voice credential", () => {
  // 懒收割合同：token 有效时零网络零收割，浏览器绝不为刷新而被启动。
  test("uses a valid cached token without any network or harvest", async () => {
    const { tmp, direct } = await directFixture("user", validAuth())
    const runtime = spyRuntime()
    const auth = await ensureVoiceCredential(direct, { runtime })
    expect(auth.access_token).toBe("alive-token")
    expect(runtime.counts).toEqual({ fetchSession: 0, harvest: 0 })
    await tmp[Symbol.asyncDispose]()
  })

  // token 过期但会话凭据健康：走 /api/auth/session 刷新并写回 auth 节点，不开浏览器。
  test("refreshes an expired token from cookies and persists the result", async () => {
    const { tmp, direct } = await directFixture("user", expiredTokenAuth(now + 90 * 86_400_000))
    const refreshed = { ...validAuth(), access_token: "refreshed-token" }
    const runtime = spyRuntime({ fetchSession: async () => {
      runtime.counts.fetchSession++
      return refreshed
    } })
    const auth = await ensureVoiceCredential(direct, { runtime })
    expect(auth.access_token).toBe("refreshed-token")
    expect(runtime.counts.harvest).toBe(0)
    // 直接读文件断言持久化真实发生，而不是仅内存返回值。
    expect(await readVoiceAuth(direct.config, "chatgpt")).toEqual(refreshed)
    await tmp[Symbol.asyncDispose]()
  })

  // 无可用凭据：真实 spawn agent CLI 收割（假脚本输出 JSON），并写回 auth 节点。
  // 假脚本不启动任何 daemon：收割协议只依赖 stdout JSON 合同。
  test("harvests through the agent CLI when no credential is usable", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "mcp-server.js"] } } }))
    const script = path.join(tmp.path, "fake-agent.cjs")
    const payload = JSON.stringify({
      authStatus: "logged_in",
      accessToken: "harvested-token",
      cookies: [{ name: "oai-did", value: "did-9", expires: -1 }],
      fetchedAt: "2026-09-06T01:00:00Z",
    })
    await Bun.write(script, `process.stdout.write(${JSON.stringify(payload)})`)
    const direct: VoiceTranscriberDirect = {
      type: "chatgpt-direct",
      config,
      key: "chatgpt",
      interpreter: process.execPath,
      script,
      scope: "user",
      transcriber: { command: "unused", args: [] },
    }
    const auth = await ensureVoiceCredential(direct, { runtime: { now: () => now } })
    expect(auth.access_token).toBe("harvested-token")
    // CDP 会话 cookie expires=-1 归一为 0
    expect(auth.cookies["oai-did"]).toEqual({ value: "did-9", expires: 0 })
    expect(await readVoiceAuth(config, "chatgpt")).toEqual(auth)
  })

  // 并发去重：同一凭据键的并发 ensure 只触发一次收割 spawn。
  test("deduplicates concurrent ensures into a single harvest", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: {} }))
    const counter = path.join(tmp.path, "count")
    const script = path.join(tmp.path, "fake-agent.cjs")
    const payload = JSON.stringify({ authStatus: "logged_in", accessToken: "harvested-token", cookies: [], fetchedAt: "2026-09-06T01:00:00Z" })
    await Bun.write(script, `require('fs').writeFileSync(${JSON.stringify(counter)}, String(Number(require('fs').readFileSync(${JSON.stringify(counter)}, 'utf8') || '0') + 1)); setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 50)`)
    await Bun.write(counter, "0")
    const direct: VoiceTranscriberDirect = { type: "chatgpt-direct", config, key: "chatgpt", interpreter: process.execPath, script, scope: "user", transcriber: { command: "unused", args: [] } }
    const runtime: Partial<VoiceAuthRuntime> = { now: () => now }
    const [a, b] = await Promise.all([
      ensureVoiceCredential(direct, { runtime }),
      ensureVoiceCredential(direct, { runtime }),
    ])
    // 计数文件是真实 spawn 次数的磁盘证据，不依赖 promise 身份或实现内部锁。
    expect(a).toEqual(b)
    expect(await Bun.file(counter).text()).toBe("1")
  })

  // 收割失败：agent CLI 非零退出时上抛其诊断（不含凭据），不合成成功。
  test("rejects with the agent diagnostics when the harvest CLI fails", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: {} }))
    const script = path.join(tmp.path, "fail-agent.cjs")
    await Bun.write(script, "process.stderr.write('login required'); process.exit(3)")
    const direct: VoiceTranscriberDirect = { type: "chatgpt-direct", config, key: "chatgpt", interpreter: process.execPath, script, scope: "user", transcriber: { command: "unused", args: [] } }
    await expect(ensureVoiceCredential(direct, { runtime: { now: () => now } })).rejects.toThrow(/login required/)
  })

  // B-01 回归锁：临期谓词只看会话凭据 cookie；短 TTL __cf_bm 不得禁用刷新。
  // 双向 fixture：24h 剩余必须收割，90d 剩余必须刷新——两种解读只能同时满足一种。
  test("skips refresh only when the session credential itself is near death", async () => {
    const nearDeath = await directFixture("user", expiredTokenAuth(now + 24 * 3_600_000, { __cf_bm: { value: "cf", expires: (now + 1_800_000) / 1000 } }))
    const skipRuntime = spyRuntime({ harvest: async () => {
      skipRuntime.counts.harvest++
      return validAuth()
    } })
    await ensureVoiceCredential(nearDeath.direct, { runtime: skipRuntime })
    expect(skipRuntime.counts.fetchSession).toBe(0)
    expect(skipRuntime.counts.harvest).toBe(1)
    await nearDeath.tmp[Symbol.asyncDispose]()

    const healthy = await directFixture("user", expiredTokenAuth(now + 90 * 86_400_000, { __cf_bm: { value: "cf", expires: (now + 1_800_000) / 1000 } }))
    const refreshRuntime = spyRuntime({ fetchSession: async () => {
      refreshRuntime.counts.fetchSession++
      return { ...validAuth(), access_token: "refreshed" }
    } })
    await ensureVoiceCredential(healthy.direct, { runtime: refreshRuntime })
    expect(refreshRuntime.counts.fetchSession).toBe(1)
    expect(refreshRuntime.counts.harvest).toBe(0)
    await healthy.tmp[Symbol.asyncDispose]()
  })

  // B-01 安全网：写回失败（如目标不可读/被锁且非等价冲突）必须降级为内存态+一次性提示，绝不破坏用户配置。
  test("degrades to memory with a one-time notice when the write-back fails", async () => {
    await using tmp = await tmpdir()
    const direct: VoiceTranscriberDirect = {
      type: "chatgpt-direct",
      config: path.join(tmp.path, "absent", "opencode.json"),
      key: "chatgpt",
      interpreter: process.execPath,
      script: path.join(tmp.path, "agent.cjs"),
      scope: "user",
      transcriber: { command: "unused", args: [] },
    }
    const runtime = spyRuntime({ harvest: async () => {
      runtime.counts.harvest++
      return validAuth()
    } })
    const auth = await ensureVoiceCredential(direct, { runtime })
    expect(auth.access_token).toBe("alive-token")
    expect(drainNotices().some((notice) => notice.includes("写回失败"))).toBe(true)
    // 内存降级后第二次 ensure 不再收割：凭据在本进程内仍然可用。
    await ensureVoiceCredential(direct, { runtime })
    expect(runtime.counts.harvest).toBe(1)
  })

  // 写回范围（slice 18）：project 来源只驻内存并一次性提示；user 来源正常落盘。
  // 提示文案本身不含任何凭据字段（INV-05）。
  test("keeps project-scope credentials in memory with a one-time notice", async () => {
    const { tmp, direct } = await directFixture("project", expiredTokenAuth(0))
    const runtime = spyRuntime({ harvest: async () => {
      runtime.counts.harvest++
      return validAuth()
    } })
    const auth = await ensureVoiceCredential(direct, { runtime })
    expect(auth.access_token).toBe("alive-token")
    const notices = drainNotices()
    expect(notices.some((notice) => notice.includes("用户级配置"))).toBe(true)
    expect(takeVoiceAuthNotice()).toBeUndefined()
    // 内存驻留：第二次 ensure 不再收割；project 作用域也读不到磁盘凭据（磁盘无该键）。
    await ensureVoiceCredential(direct, { runtime })
    expect(runtime.counts.harvest).toBe(1)
    await tmp[Symbol.asyncDispose]()
  })
})

describe("voice auth helpers", () => {
  // JWT exp 独立期望值：payload {"exp":1800000200} 手工构造。
  test("parses the exp claim from a harvested access token", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_200 })).toString("base64url")
    expect(jwtExpiresAt(`h.${payload}.s`)).toBe(1_800_000_200)
    expect(jwtExpiresAt("not-a-jwt")).toBe(0)
  })

  // set-cookie 合并：新值覆盖旧值，无 Expires 属性的条目保持 expires=0（会话语义）。
  test("merges set-cookie updates into stored cookies", () => {
    const cookies = { [SESSION_COOKIE]: { value: "old", expires: 1_900_000 }, other: { value: "keep", expires: 0 } }
    const merged = mergeSetCookieCookies(cookies, [
      `${SESSION_COOKIE}=new; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT; Secure; HttpOnly`,
      "oai-sc=1; Path=/",
    ])
    expect(merged[SESSION_COOKIE]?.value).toBe("new")
    expect(merged[SESSION_COOKIE]?.expires).toBe(Date.parse("Fri, 01 Jan 2027 00:00:00 GMT") / 1000)
    expect(merged.other).toEqual({ value: "keep", expires: 0 })
    expect(merged["oai-sc"]).toEqual({ value: "1", expires: 0 })
  })

  // agent 导出 JSON → auth 节点的映射：CDP expires=-1 归 0，JWT exp 驱动 token_expires_at。
  test("maps the agent export payload onto the auth node shape", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_500 })).toString("base64url")
    const auth = authFromHarvest({
      authStatus: "logged_in",
      accessToken: `h.${payload}.s`,
      cookies: [
        { name: "a", value: "1", expires: -1 },
        { name: "b", value: "2", expires: 1_900_000 },
      ],
      fetchedAt: "2026-09-06T02:00:00Z",
    })
    expect(auth).toEqual({
      access_token: `h.${payload}.s`,
      token_expires_at: 1_800_000_500,
      fetched_at: "2026-09-06T02:00:00Z",
      cookies: { a: { value: "1", expires: 0 }, b: { value: "2", expires: 1_900_000 } },
    })
  })

  // INV-08：auth 节点是 mcp 条目的未知嵌套字段，不得破坏 opencode 的 MCP schema 解码
  //（Effect decode 剥离未知嵌套字段，顶层未知键检查不受影响）。这是凭据内嵌配置文件的前提。
  test("keeps the auth node invisible to the mcp config schema", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", "mcp-server.js"] } } }))
    await writeVoiceAuth(config, "chatgpt", auth)
    const data = ConfigParse.jsonc(await Bun.file(config).text(), config)
    const server = (data as { mcp: { chatgpt: unknown } }).mcp.chatgpt
    const decoded = ConfigParse.schema(ConfigMCP.Info, server, config)
    expect(decoded.type).toBe("local")
    expect("auth" in decoded).toBe(false)
  })

  // 分块会话凭据（.0/.1 变体）各自携带 expires：族内最早过期者决定可刷新性。
  test("uses the earliest expiry across chunked session cookies", async () => {
    const chunked = {
      access_token: "expired-token",
      token_expires_at: (now - 1000) / 1000,
      fetched_at: "2026-09-06T00:00:00Z",
      cookies: {
        [`${SESSION_COOKIE}.0`]: { value: "a", expires: (now + 90 * 86_400_000) / 1000 },
        [`${SESSION_COOKIE}.1`]: { value: "b", expires: (now + 24 * 3_600_000) / 1000 },
      },
    }
    const { tmp, direct } = await directFixture("user", chunked)
    const runtime = spyRuntime({ harvest: async () => {
      runtime.counts.harvest++
      return validAuth()
    } })
    await ensureVoiceCredential(direct, { runtime })
    expect(runtime.counts.fetchSession).toBe(0)
    expect(runtime.counts.harvest).toBe(1)
    await tmp[Symbol.asyncDispose]()
  })

  // 预警常量锁定：token margin 6h（EchoPaper 实证）、cookie margin 48h（用户"一两天"语义）。
  test("keeps the documented margin constants", () => {
    expect(VOICE_TOKEN_MARGIN_S).toBe(6 * 3_600)
    expect(VOICE_COOKIE_HARVEST_MARGIN_S).toBe(48 * 3_600)
  })
})

describe("direct transcribe", () => {
  // INV-07 请求形态锁：multipart 仅 file 字段（字节与文件名原样），Bearer/oai-device-id/oai-language 齐备。
  test("builds the documented direct transcribe request shape", async () => {
    const auth = { ...validAuth(), cookies: { ...validAuth().cookies, "oai-did": { value: "did-7", expires: 0 } } }
    const bytes = new Uint8Array([1, 2, 3, 4])
    const request = buildDirectTranscribeRequest({ file: "C:/tmp/voice .wav", bytes, auth })
    expect(request.input).toBe(VOICE_TRANSCRIBE_URL)
    expect(request.init.method).toBe("POST")
    // 文件名带空格锁定 basename 原样进入 multipart，不发生任何 shell/路径改写。
    const headers = request.init.headers as Record<string, string>
    expect(headers["authorization"]).toBe("Bearer alive-token")
    expect(headers["oai-device-id"]).toBe("did-7")
    expect(headers["oai-language"]).toBe("en-US")
    const form = request.init.body as FormData
    const file = form.get("file") as File
    expect(file.name).toBe("voice .wav")
    expect(file.type).toBe("audio/wav")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })

  // 401 编排重试：第一次 401 后强制刷新凭据再重试一次；成功后不再有第三次请求。
  test("retries once through a forced refresh after a 401", async () => {
    const { tmp, direct } = await directFixture("user", validAuth())
    const seen: number[] = []
    let harvests = 0
    let refreshes = 0
    const runtime: Partial<VoiceAuthRuntime> = {
      now: () => now,
      fetchSession: async () => {
        refreshes++
        return { ...validAuth(), access_token: "refreshed-token" }
      },
      directFetch: async () => {
        const status = seen.length === 0 ? 401 : 200
        seen.push(status)
        return new Response(status === 200 ? JSON.stringify({ text: "retried text" }) : "{}", { status })
      },
      harvest: async () => {
        harvests++
        return validAuth()
      },
    }
    const text = await transcribeDirect("voice.wav", direct, { runtime })
    expect(text).toBe("retried text")
    // seen 顺序锁定第二次请求发生在强制刷新之后，而不是简单的同凭据重发。
    expect(seen).toEqual([401, 200])
    // forceRefresh 跳过缓存但会话凭据健康：一次刷新、零收割。
    expect(refreshes).toBe(1)
    expect(harvests).toBe(0)
    await tmp[Symbol.asyncDispose]()
  })

  // 非 401 失败（如 Cloudflare 403）直接上抛，交给上层 argv 回退，不做第二算法。
  test("rejects on non-401 failures without retry", async () => {
    const { tmp, direct } = await directFixture("user", validAuth())
    let calls = 0
    const runtime: Partial<VoiceAuthRuntime> = {
      now: () => now,
      directFetch: async () => {
        calls++
        return new Response("{}", { status: 403 })
      },
    }
    await expect(transcribeDirect("voice.wav", direct, { runtime })).rejects.toThrow(/HTTP 403/)
    // 单次调用断言防止未来出现隐藏的自动重试或第二请求算法。
    expect(calls).toBe(1)
    await tmp[Symbol.asyncDispose]()
  })

  // 空文本合法（slice 17）：200 + "" 是端点对静音的合同结果，不当作错误。
  test("returns an empty string for silent audio", async () => {
    const { tmp, direct } = await directFixture("user", validAuth())
    const runtime: Partial<VoiceAuthRuntime> = {
      now: () => now,
      // 200+空串（静音）与结构失败（无 text 字段）是两个不同合同：前者合法返回，后者必须抛错。
      directFetch: async () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    }
    expect(await transcribeDirect("voice.wav", direct, { runtime })).toBe("")
    await tmp[Symbol.asyncDispose]()
  })
})
