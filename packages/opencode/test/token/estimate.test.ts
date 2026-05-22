// #193：测试随模块归入 token 域，消费端 import 与生产路径同步指向 token/estimate
// #175：单测锁定消毒、远程跳过与分项 token
import { describe, expect, test } from "bun:test"
// #193：测试路径与 token/estimate.ts 对齐，避免生产与测试引用分裂
// #194：改用 TokenEstimate
import { TokenEstimate } from "@/token/estimate"

const stepFinish = (inputChars: number, inputTokens: number, inputBreakdown?: { messages?: { attachments?: number }; media?: { rawChars: number; textChars: number; tokens: number; count: number; imageTokens: number; pdfTokens: number; otherTokens: number } }) => ({ type: "step-finish", inputChars, inputBreakdown, tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })

describe("TokenEstimate", () => {
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
    const estimate = TokenEstimate.estimateUploadInput({ text: "x".repeat(827_111), attachments: TokenEstimate.emptyAttachmentEstimate(), history: [{ info: { role: "assistant", providerID: "p", modelID: "m" }, parts: [stepFinish(827_111, 128_159)] }], model: { providerID: "p", id: "m" } })
    expect(estimate.source).toBe("model-history")
    expect(estimate.charsPerToken).toBeCloseTo(6.45, 1)
    expect(estimate.inputTokens).toBeGreaterThan(120_000)
    expect(estimate.inputTokens).toBeLessThan(135_000)
  })

  // #194：旧附件排除
  test("ignores legacy attachment samples that lack media token metadata", () => {
    const estimate = TokenEstimate.estimateUploadInput({ text: "x".repeat(80_000), attachments: TokenEstimate.emptyAttachmentEstimate(), history: [{ info: { role: "assistant", providerID: "p", modelID: "m" }, parts: [stepFinish(269_504, 12_886, { messages: { attachments: 210_514 } })] }], model: { providerID: "p", id: "m" } })
    expect(estimate.source).toBe("default")
    expect(estimate.inputTokens).toBe(20_000)
  })

  // #194：media 分开
  test("uses media metadata as separate tokens when learning text density", () => {
    const estimate = TokenEstimate.estimateUploadInput({ text: "x".repeat(65_000), attachments: TokenEstimate.emptyAttachmentEstimate(), history: [{ info: { role: "assistant", providerID: "p", modelID: "m" }, parts: [stepFinish(3_989_772, 16_280, { messages: { attachments: 3_924_846 }, media: { rawChars: 3_924_846, textChars: 31, tokens: 1_600, count: 1, imageTokens: 1_600, pdfTokens: 0, otherTokens: 0 } })] }], model: { providerID: "p", id: "m" } })
    expect(estimate.source).toBe("model-history")
    expect(estimate.charsPerToken).toBeCloseTo(4.42, 1)
    expect(estimate.inputTokens).toBeGreaterThan(14_000)
    expect(estimate.inputTokens).toBeLessThan(16_000)
  })
})