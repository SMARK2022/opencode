import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const decode = Schema.decodeUnknownSync(ModelV2.Ref)

test("empty models validate IDs and own their mutable defaults", () => {
  // 固定默认值直接构造后，仍须满足公开 schema，且不同模型不能共享可变容器。
  const providerID = ProviderV2.ID.make("provider")
  const modelID = ModelV2.ID.make("model")
  const first = ModelV2.Info.empty(providerID, modelID)
  const second = ModelV2.Info.empty(providerID, modelID)
  expect(Schema.is(ModelV2.Info)(first)).toBe(true)
  expect(first).toEqual(second)
  expect(first.request.body).not.toBe(second.request.body)
  expect(first.capabilities.input).not.toBe(second.capabilities.input)
  // 只省去固定结构的重复校验，调用方提供的两个 ID 仍在原边界验证。
  expect(() => ModelV2.Info.empty(42 as unknown as ProviderV2.ID, modelID)).toThrow()
  expect(() => ModelV2.Info.empty(providerID, 42 as unknown as ModelV2.ID)).toThrow()
})

describe("ModelV2.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic", variant: "high" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
      variant: ModelV2.VariantID.make("high"),
    })
  })
})
