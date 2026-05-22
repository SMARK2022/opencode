// #193：测试随模块归入 token 域，消费端 import 与生产路径同步指向 token/estimate
// #175：单测锁定消毒、远程跳过与分项 token
import { describe, expect, test } from "bun:test"
// #193：测试路径与 token/estimate.ts 对齐，避免生产与测试引用分裂
import { AttachmentToken } from "@/token/estimate"

describe("AttachmentToken", () => {
  test("estimates image data URLs separately from sanitized text", () => {
    const payload = "a".repeat(7500)
    const estimate = AttachmentToken.sanitizeModelMessagesForTokenEstimate([
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
    const estimate = AttachmentToken.sanitizeModelMessagesForTokenEstimate([
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
})
