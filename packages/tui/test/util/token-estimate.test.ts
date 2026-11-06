import { expect, test } from "bun:test"
import type { AssistantMessage, Part, SessionRequestUsage, StepFinishPart } from "@opencode-ai/sdk/v2"
import { computeFinalTokens, estimateDataUrlInputTokens, getContextLimit, sumConfirmed } from "../../src/util/token-estimate"
import { Token } from "@opencode-ai/core/util/token"

test("prepared input yields to confirmation and preserves projected request totals", () => {
  const assistant: AssistantMessage = {
    id: "a", sessionID: "s", role: "assistant", parentID: "u", time: { created: 2 }, agent: "build",
    providerID: "p", modelID: "m", mode: "build", path: { cwd: "/", root: "/" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const request: SessionRequestUsage = { messageID: "u", input: 0, output: 0, cost: 0, stepInput: 0, stepOutput: 0 }
  const body = { system: ["system"], messages: [{ role: "user", content: "abcdefgh" }], tools: [] }
  const estimate = Token.estimateRequest(body, [])
  expect(estimate).toEqual({ input: 21, bodyChars: 82, confirmed: false })
  const advertised = { ...request, assistantID: assistant.id, estimatedInput: estimate.input }
  expect(computeFinalTokens(undefined, [], advertised)).toEqual({ input: 21, output: 0, totalInput: 21, totalOutput: 0 })
  expect(computeFinalTokens(assistant, [], advertised)).toEqual({ input: 21, output: 0, totalInput: 21, totalOutput: 0 })
  expect(estimateDataUrlInputTokens(`data:image/png;base64,${"x".repeat(1500)}`, "image/png")).toBe(2)
  expect(estimateDataUrlInputTokens(`data:application/pdf;base64,${"x".repeat(2200)}`, "application/pdf")).toBe(2)
  const active = { ...request, assistantID: "a" }
  const text: Part = { id: "tail", sessionID: "s", messageID: "a", type: "text", text: "abcdefgh" }
  expect(computeFinalTokens(undefined, [], request)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  expect(computeFinalTokens(assistant, [text], active)).toEqual({ input: 0, output: 2, totalInput: 0, totalOutput: 2 })
  const finish: StepFinishPart = {
    id: "finish", sessionID: "s", messageID: "a", type: "step-finish", reason: "stop", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  // 零确认不能被 truthiness 当成尚未确认；completed=0 也属于合法终态。
  expect(computeFinalTokens(assistant, [finish], active)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  expect(computeFinalTokens({ ...assistant, time: { created: 2, completed: 0 } }, [text], active)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  const settled = { ...active, input: 4000, output: 30, stepInput: 1000, stepOutput: 10 }
  const completed = { ...assistant, time: { created: 2, completed: 3 } }
  // 单步完成的 100 已进入请求累计，不能再加末步 100 或 2800 的引导。
  expect(computeFinalTokens(completed, [], { ...active, input: 100, output: 10, stepInput: 100, stepOutput: 10 })).toEqual({ input: 100, output: 10, totalInput: 100, totalOutput: 10 })
  // 请求累计刻意大于末 step，能发现退回缓存求和或把两种范围合并的问题。
  expect(computeFinalTokens(completed, [], settled)).toEqual({ input: 1000, output: 10, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens(undefined, [], settled)).toEqual({ input: 1000, output: 10, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens(undefined, [], active)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  const confirmedFinish = { ...finish, tokens: { input: 700, output: 8, reasoning: 2, cache: { read: 100, write: 200 } } }
  const confirmed = { ...active, input: 1000, output: 10, stepInput: 1000, stepOutput: 10 }
  expect(sumConfirmed([completed], () => [confirmedFinish])).toEqual({ input: 1000, output: 10 })
  expect(computeFinalTokens(assistant, [confirmedFinish], confirmed)).toEqual({ input: 1000, output: 10, totalInput: 1000, totalOutput: 10 })
  // 1000 输入和 10 输出成为下一步上下文；完成前的新增估算只进入累计一次。
  expect(computeFinalTokens(assistant, [confirmedFinish, text], confirmed)).toEqual({ input: 1010, output: 2, totalInput: 2010, totalOutput: 12 })
  const tool: Part = {
    id: "tool", sessionID: "s", messageID: "a", type: "tool", callID: "call", tool: "read",
    state: { status: "completed", input: {}, output: "abcdefgh", title: "read", metadata: {}, time: { start: 2, end: 3 } },
  }
  // 工具的 8 字符补 2 输入；多步累计 4000 不替代末步上下文 1010。
  expect(computeFinalTokens(assistant, [confirmedFinish, tool], confirmed)).toEqual({ input: 1012, output: 1, totalInput: 2012, totalOutput: 11 })
  expect(computeFinalTokens(assistant, [confirmedFinish, tool], { ...settled, stepInput: 0, stepOutput: 0 })).toEqual({ input: 1012, output: 1, totalInput: 5012, totalOutput: 31 })
  // 宿主子调用不是模型生成的新参数，也不能让已确认步骤重新进入下一轮。
  const child: Part = { ...tool, id: "z-child", metadata: { executeParent: "call" } }
  expect(computeFinalTokens(assistant, [confirmedFinish, child], confirmed)).toEqual({ input: 1000, output: 10, totalInput: 1000, totalOutput: 10 })
  // 真实下一轮换助手且不传旧 parts，投影的 1010 保留完整末步上下文而非累计 4000。
  const nextAssistant = { ...assistant, id: "next" }
  const nextRequest = { ...settled, assistantID: "next", stepInput: 0, stepOutput: 0, pendingInput: 1010 }
  expect(computeFinalTokens(nextAssistant, [], nextRequest)).toEqual({ input: 1010, output: 0, totalInput: 5010, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [{ ...text, messageID: "next" }], nextRequest)).toEqual({ input: 1010, output: 2, totalInput: 5010, totalOutput: 32 })
  expect(computeFinalTokens(undefined, [], nextRequest)).toEqual({ input: 1010, output: 0, totalInput: 5010, totalOutput: 30 })
  // 零基数不新增输入；收到零报告时仍保留已有估算。
  expect(computeFinalTokens(nextAssistant, [], { ...nextRequest, input: 0, output: 0, pendingInput: 0 })).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  expect(computeFinalTokens({ ...nextAssistant, time: { created: 2, completed: 0 } }, [], nextRequest)).toEqual({ input: 1010, output: 0, totalInput: 5010, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [{ ...finish, messageID: "next" }], nextRequest)).toEqual({ input: 0, output: 0, totalInput: 4000, totalOutput: 30 })
  // 工具结果只补下一轮输入，已确认零的旧 step 不应触发新的 bootstrap。
  expect(computeFinalTokens(assistant, [finish, tool], active)).toEqual({ input: 2, output: 1, totalInput: 2, totalOutput: 1 })
  // 已有 fixture 扩展 server 分支；独立常数 oracle 不复制 estimator 实现。
  const prepared = { ...nextRequest, estimatedInput: 777 }
  const captured = { ...nextAssistant, inputEstimate: { input: 777, bodyChars: 3108, confirmed: false, afterPartID: "tool" } }
  // cleanup 保存的正文与 prepared 元数据足以重建估算，不依赖旧 TUI 的最后一帧。
  const interrupted = { ...captured, time: { created: 2, completed: 3 } }
  expect(computeFinalTokens(interrupted, [text], prepared)).toEqual({ input: 777, output: 2, totalInput: 4777, totalOutput: 32 })
  expect(computeFinalTokens(captured, [tool], prepared)).toEqual({ input: 777, output: 1, totalInput: 4777, totalOutput: 31 })
  expect(computeFinalTokens(undefined, [], prepared)).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [tool], prepared)).toEqual({ input: 779, output: 1, totalInput: 4779, totalOutput: 31 })
  expect(computeFinalTokens(nextAssistant, [], { ...prepared, estimatedInput: 0 })).toEqual({ input: 0, output: 0, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens({ ...nextAssistant, time: { created: 2, completed: 0 } }, [], prepared)).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [finish], prepared)).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30 })
  expect(Token.estimateRequest("abcdefgh", [])).toEqual({ input: 3, bodyChars: 10, confirmed: false })
  expect(Token.estimateRequest("abcdefgh", [{ bodyChars: 800, input: 100 }])).toEqual({ input: 1, bodyChars: 10, confirmed: false })
  expect(Token.estimateRequest("abcdefgh", [{ bodyChars: 800, input: 0 }])).toEqual({ input: 3, bodyChars: 10, confirmed: false })
  const providers = [{ id: "p", models: {
    "test-model": { api: { id: "api-test-model" }, limit: { context: 2000 } },
    "other-alias": { api: { id: "api-test-model" }, limit: { context: 8000 } },
    "api-test-model": { api: { id: "api-test-model" }, limit: { context: 4000 } },
  } }]
  const frozen = { ...prepared, model: { providerID: "p", modelID: "api-test-model", contextLimit: 2000 } }
  const limit = getContextLimit(providers, frozen.model.providerID, frozen.model.modelID, frozen.model.contextLimit)
  expect(limit).toBe(2000)
  expect(limit && Math.round((computeFinalTokens(undefined, [], frozen).input / limit) * 100)).toBe(39)
  expect(getContextLimit(providers, "p", "test-model")).toBe(2000)
  providers[0].models["test-model"].limit.context = 9000
  expect(getContextLimit(providers, "p", "api-test-model", frozen.model.contextLimit)).toBe(2000)
  expect(getContextLimit(providers, "p", "api-test-model", 0)).toBe(0)
  expect(getContextLimit([], "p", "api-test-model", frozen.model.contextLimit)).toBe(2000)
  // 输入密度只影响新增工具结果；live 输出使用独立密度，完整请求累计保持不变。
  const dense = { ...prepared, inputEstimate: { input: 777, bodyChars: 1943, confirmed: false, charsPerToken: 2.5 } }
  expect(computeFinalTokens(nextAssistant, [{ ...text, messageID: "next" }], dense)).toEqual({ input: 777, output: 2, totalInput: 4777, totalOutput: 32 })
  expect(computeFinalTokens(nextAssistant, [{ ...text, messageID: "next" }], dense, 8)).toEqual({ input: 777, output: 1, totalInput: 4777, totalOutput: 31 })
  expect(computeFinalTokens(nextAssistant, [tool], dense)).toEqual({ input: 780, output: 1, totalInput: 4780, totalOutput: 31 })
  // captured的游标已覆盖该工具结果，新密度不能把同一份结果再次追加到prepared输入。
  expect(computeFinalTokens(captured, [tool], dense)).toEqual({ input: 777, output: 1, totalInput: 4777, totalOutput: 31 })
  expect(computeFinalTokens(undefined, [], dense)).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30 })
  // 零报告保留777估算，输入密度变化不重算已保存的请求体。
  expect(computeFinalTokens(nextAssistant, [finish], dense)).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30 })
  const pending: Part = { id: "pending", sessionID: "s", messageID: "next", type: "tool", callID: "call", tool: "bash",
    state: { status: "pending", input: {}, raw: "pending-raw-text" } }
  const before = { ...text, text: "ab", messageID: "next" }
  const after = { ...text, id: "after", text: "cd", messageID: "next" }
  // 同样的输出字符不随输入密度变化；传入输出校准后才改变估算。
  expect(computeFinalTokens(nextAssistant, [before, pending, after], dense, 2.5).output).toBe(8)
  expect(computeFinalTokens(nextAssistant, [before, pending, after], prepared).output).toBe(5)
  // 非法密度只影响显示估算，沿默认密度得到有限尾部值，不得产生Infinity/NaN污染整帧用量。
  for (const density of [0, -1, NaN, Infinity]) {
    expect(computeFinalTokens(nextAssistant, [text], { ...dense, inputEstimate: { ...dense.inputEstimate, charsPerToken: density } }).output).toBe(2)
  }
  const bodyEstimate = Token.estimateRequest(body, [{ bodyChars: 1000, input: 400 }], [])
  expect(bodyEstimate.input).toBe(33)
  expect(bodyEstimate.bodyChars).toBe(82)
  expect(bodyEstimate.inputBreakdown?.messages.attachments).toBe(0)
})
