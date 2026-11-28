// #193：测试随模块归入 token 域，消费端 import 与生产路径同步指向 token/estimate
// #175：单测锁定消毒、远程跳过与分项 token
import { describe, expect, test } from "bun:test"
// #193：测试路径与 token/estimate.ts 对齐，避免生产与测试引用分裂
// #194：改用 TokenEstimate
import { TokenEstimate } from "@/token/estimate"
import { Token } from "@opencode-ai/core/util/token"

const info = { id: "m", time: { created: 1 }, role: "assistant",
  providerID: "p", modelID: "m" }

const stepFinish = (inputChars: number, inputTokens: number, inputBreakdown?: { messages?: { attachments?: number }; media?: { rawChars: number; textChars: number; tokens: number; count: number; imageTokens: number; pdfTokens: number; otherTokens: number } }) => ({ type: "step-finish", inputChars, inputBreakdown, tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })

describe("TokenEstimate", () => {
  test("adapts one same-model confirmation per assistant and prefers a qualified carrier", () => {
    const tokens = { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const older = { info: { ...info, id: "old", time: { created: 0 } },
      parts: [stepFinish(1000, 200), stepFinish(2000, 0)] }
    const latest = { info: { ...info, id: "latest", tokens,
      inputEstimate: { bodyChars: 2000, input: 500, confirmed: true } }, parts: [stepFinish(1000, 100)] }
    // carrier和finish代表同一确认，不能重复；新prepared的旧tokens也不能校准新body。
    expect(TokenEstimate.inputHistory([older, latest], { providerID: "p", id: "m" })).toEqual([
      { bodyChars: 2000, input: 500, inputBreakdown: undefined },
      { bodyChars: 1000, input: 200, inputBreakdown: undefined },
    ])
    expect(TokenEstimate.inputHistory([{ ...latest, info: { ...latest.info,
      inputEstimate: { ...latest.info.inputEstimate, bodyChars: 9000, confirmed: false } } }], { providerID: "p", id: "m" }))
      .toEqual([{ bodyChars: 1000, input: 100, inputBreakdown: undefined }])
    expect(TokenEstimate.inputHistory([older, latest], { providerID: "p", id: "other" })).toEqual([])
    const source = (modelID: string, time: number,
      encrypted: number, input: number) => ({ info: {
      ...latest.info, modelID, id: `msg_${time}`, time: { created: time },
      tokens: { ...tokens, input }, inputEstimate: { confirmed: true,
        bodyChars: 1000000, inputBreakdown: { encrypted } },
    }, parts: [] })
    // 按确认时间选最新同族，摘要可以位于旧尾部前。
    const peer = [source("gpt-new", 3, 200000, 220000),
      source("gpt-new", 2, 800000, 130000), source("gpt-old", 1, 0, 500000)]
    const model = { providerID: "p", id: "gpt-target" }
    const body = { input: [{ type: "reasoning", encrypted_content: "x".repeat(16000) }] }
    const estimate = (
      msgs: Parameters<typeof TokenEstimate.inputHistory>[0], mdl = model,
    ) => Token.estimateRequest(body, TokenEstimate.inputHistory(msgs, mdl), [])
    const next = estimate(peer)
    expect(next.input).toBe(1614)
    const short = source("gpt-target", 4, 0, 40)
    short.info.inputEstimate.bodyChars = 200
    expect(estimate([...peer, short]).input).toBe(next.input)
    const unfinished = source("gpt-old", 10, 0, 500000)
    unfinished.info.inputEstimate.confirmed = false
    expect(estimate([...peer, unfinished]).input).toBe(next.input)
    const own = source("gpt-target", 0, 0, 200000)
    expect(estimate([own, ...peer]).charsPerToken).toBe(5)
    expect(estimate([]).charsPerToken).toBe(4.5)
    expect(estimate(peer, { ...model, providerID: "other" }).charsPerToken).toBe(4)
  })

  test("estimates image data URLs separately from sanitized text", () => {
    const payload = "a".repeat(7500)
    const estimate = TokenEstimate.sanitizeModelMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file", mediaType: "image/png", url: `data:image/png;base64,${payload}`, filename: "chart.png" },
          { type: "file", url: `data:application/pdf;base64,${payload}` },
        ],
      },
    ])

    expect(estimate.attachments.tokens).toBe(17)
    expect(estimate.attachments.rawChars).toBe(`data:image/png;base64,${payload}`.length + `data:application/pdf;base64,${payload}`.length)
    expect(estimate.text).not.toContain(payload)
    expect(estimate.text).toContain("[Attached image/png: chart.png]")
    expect(estimate.text).toContain("[Attached application/pdf: file]")
  })

  test("does not treat remote file URLs as uploaded media payloads", () => {
    const estimate = TokenEstimate.sanitizeModelMessages([
      {
        role: "user",
        content: [
          { type: "file", mediaType: "image/png", data: "https://example.com/image.png" },
          { type: "file", mediaType: "image/png", data: "//example.com/image.png" },
        ],
      },
    ])

    expect(estimate.attachments.tokens).toBe(0)
    expect(estimate.text).toContain("https://example.com/image.png")
    expect(estimate.text).toContain("//example.com/image.png")
  })

  // #194：学习上传密度
  test("learns upload input density above the legacy four-character fallback", () => {
    const samples = TokenEstimate.inputHistory([
      { info, parts: [stepFinish(827_111, 128_159)] },
    ], { providerID: "p", id: "m" })
    const estimate = Token.estimateRequest({ messages: [{ role: "user", content: "x".repeat(827_111) }] }, samples, [])
    expect(estimate.charsPerToken).toBeCloseTo(6.45, 1)
    expect(estimate.input).toBeGreaterThan(120_000)
    expect(estimate.input).toBeLessThan(135_000)
  })

  // #194：旧附件排除
  test("ignores legacy attachment samples that lack media token metadata", () => {
    const samples = TokenEstimate.inputHistory([{ info, parts: [stepFinish(269_504, 12_886, { messages: { attachments: 210_514 } })] }], { providerID: "p", id: "m" })
    const body = { messages: [{ role: "user", content: "x".repeat(80_000) }] }
    const estimate = Token.estimateRequest(body, samples, [])
    expect(estimate.charsPerToken).toBe(4)
    expect(estimate.input).toBe(Token.estimateRequest(body, []).input)
  })

  // #194：media 分开
  test("uses media metadata as separate tokens when learning text density", () => {
    const samples = TokenEstimate.inputHistory([{ info, parts: [stepFinish(3_989_772, 16_280, { messages: { attachments: 3_924_846 }, media: { rawChars: 3_924_846, textChars: 31, tokens: 1_600, count: 1, imageTokens: 1_600, pdfTokens: 0, otherTokens: 0 } })] }], { providerID: "p", id: "m" })
    const estimate = Token.estimateRequest({ messages: [{ role: "user", content: "x".repeat(65_000) }] }, samples, [])
    expect(estimate.charsPerToken).toBeCloseTo(4.42, 1)
    expect(estimate.input).toBeGreaterThan(14_000)
    expect(estimate.input).toBeLessThan(16_000)
  })
})
