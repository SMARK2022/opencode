import { expect, test } from "bun:test"
import { createOpenAI, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai"

// 两个协议共用显式 tier 合同；不能只修 Responses 而让 Chat 继续拒绝相同配置。
test.each(["responses", "chat"] as const)("OpenAI %s forwards explicit service tiers", async (route) => {
  // default 是未加速对照；其余值分别覆盖静态能力删除和 ultrafast 枚举拒绝。
  for (const serviceTier of ["ultrafast", "default", "priority", "flex"] as const) {
    const requests: unknown[] = []
    const stop = new Error("request captured")
    const provider = createOpenAI({
      apiKey: "offline-test",
      // Bun 的 fetch 类型包含 preconnect；离线 transport 保持同一接口，不伪装成全局 fetch。
      fetch: Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          requests.push(await new Request(url, init).json())
          throw stop
        },
        { preconnect() {} },
      ),
    })
    // 真实 SDK 在发请求之前完成校验，sentinel 证明没有在 options 阶段提前失败。
    await expect(
      provider[route]("gpt-6-astra").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        providerOptions: {
          // 类型声明也必须接受新值，避免运行时补丁与使用者编译合同分离。
          openai: { serviceTier, reasoningEffort: "high" } satisfies OpenAILanguageModelResponsesOptions,
        },
      }),
    ).rejects.toBe(stop)
    expect(requests).toEqual([expect.objectContaining({ model: "gpt-6-astra", service_tier: serviceTier })])
    // SDK 升级同时修正 GPT-6 reasoning 识别；仅把 tier 注入 fetch 不足以满足该行为。
    expect(requests[0]).toMatchObject(
      route === "responses" ? { reasoning: { effort: "high" } } : { reasoning_effort: "high" },
    )
  }
})

test("OpenAI preserves explicit tiers for models outside its capability list", async () => {
  // Astra 在新版能力表中已被识别，用未知模型才能独立锁定 #47671 的透传修复。
  const requests: unknown[] = []
  const stop = new Error("request captured")
  const provider = createOpenAI({
    apiKey: "offline-test",
    fetch: Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(url, init).json())
        throw stop
      },
      { preconnect() {} },
    ),
  })
  for (const route of ["responses", "chat"] as const) {
    for (const serviceTier of ["priority", "flex"] as const) {
      await expect(
        provider[route]("custom-model").doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          providerOptions: { openai: { serviceTier } },
        }),
      ).rejects.toBe(stop)
    }
  }
  // 服务端是否接受由服务端判断；客户端不得静默退回默认 tier。
  expect(requests).toEqual(
    ["priority", "flex", "priority", "flex"].map((service_tier) => expect.objectContaining({ service_tier })),
  )
})
