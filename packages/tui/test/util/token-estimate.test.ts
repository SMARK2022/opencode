import { expect, test } from "bun:test"
import type { AssistantMessage, Part, SessionRequestUsage, StepFinishPart, UserMessage } from "@opencode-ai/sdk/v2"
import { computeFinalTokens, estimateUserInputTokens, getBootstrapInputTokens } from "../../src/util/token-estimate"

test("bootstrap yields to confirmed usage and preserves projected request totals", () => {
  const user: UserMessage = { id: "u", sessionID: "s", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }
  const assistant: AssistantMessage = {
    id: "a", sessionID: "s", role: "assistant", parentID: "u", time: { created: 2 }, agent: "build",
    providerID: "p", modelID: "m", mode: "build", path: { cwd: "/", root: "/" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const request: SessionRequestUsage = { messageID: "u", input: 0, output: 0, cost: 0, stepInput: 0, stepOutput: 0 }
  const identity = { sessionID: "s", messageID: "u" }
  // 三种 synthetic producer 都送出正文；ignored 再长也不应改变输入估算。
  const parts: Part[] = [
    { ...identity, id: "file", type: "file", mime: "text/plain", url: "file:///context.txt" },
    { ...identity, id: "data-text", type: "file", mime: "text/plain", url: `data:text/plain;base64,${"x".repeat(800)}` },
    { ...identity, id: "file-text", type: "text", synthetic: true, text: "f".repeat(800) },
    { ...identity, id: "editor", type: "text", synthetic: true, text: "e".repeat(800) },
    { ...identity, id: "mcp", type: "text", synthetic: true, text: "m".repeat(800) },
    { ...identity, id: "ignored", type: "text", synthetic: true, ignored: true, text: "i".repeat(4000) },
    { ...identity, id: "plain", type: "text", text: "test" },
  ]
  expect(estimateUserInputTokens(parts)).toBe(601)
  expect(getBootstrapInputTokens([user], request, () => parts)).toBe(3401)
  // 缓存缺失不能借用另一个用户，也不能凭空创建 2800 的系统开销输入。
  expect(getBootstrapInputTokens([{ ...user, id: "other" }], request, () => parts)).toBe(0)
  const active = { ...request, assistantID: "a" }
  const text: Part = { id: "tail", sessionID: "s", messageID: "a", type: "text", text: "abcdefgh" }
  expect(computeFinalTokens(undefined, [], request, 2800)).toEqual({ input: 2800, output: 0, totalInput: 2800, totalOutput: 0 })
  expect(computeFinalTokens(assistant, [text], active, 2800)).toEqual({ input: 2800, output: 2, totalInput: 2800, totalOutput: 2 })
  const finish: StepFinishPart = {
    id: "finish", sessionID: "s", messageID: "a", type: "step-finish", reason: "stop", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  // 零确认不能被 truthiness 当成尚未确认；completed=0 也属于合法终态。
  expect(computeFinalTokens(assistant, [finish], active, 2800)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  expect(computeFinalTokens({ ...assistant, time: { created: 2, completed: 0 } }, [text], active, 2800)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  const settled = { ...active, input: 4000, output: 30, stepInput: 1000, stepOutput: 10 }
  const completed = { ...assistant, time: { created: 2, completed: 3 } }
  // 单步完成的 100 已进入请求累计，不能再加末步 100 或 2800 的引导。
  expect(computeFinalTokens(completed, [], { ...active, input: 100, output: 10, stepInput: 100, stepOutput: 10 }, 2800)).toEqual({ input: 100, output: 10, totalInput: 100, totalOutput: 10 })
  // 请求累计刻意大于末 step，能发现退回缓存求和或把两种范围合并的问题。
  expect(computeFinalTokens(completed, [], settled, 2800)).toEqual({ input: 1000, output: 10, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens(undefined, [], settled, 2800)).toEqual({ input: 1000, output: 10, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens(undefined, [], active, 2800)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  const confirmedFinish = { ...finish, tokens: { input: 700, output: 8, reasoning: 2, cache: { read: 100, write: 200 } } }
  const confirmed = { ...active, input: 1000, output: 10, stepInput: 1000, stepOutput: 10 }
  // 下一请求引导以末步上下文为基数，不能把全部请求累计或固定开销再叠加。
  const previous = { ...completed, id: "previous", parentID: "prior", time: { created: 0, completed: 0 } }
  expect(getBootstrapInputTokens([previous, user, assistant], request, (id) => id === "previous" ? [confirmedFinish] : parts)).toBe(1611)
  expect(computeFinalTokens(assistant, [confirmedFinish], confirmed, 2800)).toEqual({ input: 1000, output: 10, totalInput: 1000, totalOutput: 10 })
  // 1000 输入和 10 输出成为下一步上下文；完成前的新增估算只进入累计一次。
  expect(computeFinalTokens(assistant, [confirmedFinish, text], confirmed, 2800)).toEqual({ input: 1010, output: 2, totalInput: 2010, totalOutput: 12 })
  const tool: Part = {
    id: "tool", sessionID: "s", messageID: "a", type: "tool", callID: "call", tool: "read",
    state: { status: "completed", input: {}, output: "abcdefgh", title: "read", metadata: {}, time: { start: 2, end: 3 } },
  }
  // 工具的 8 字符补 2 输入；多步累计 4000 不替代末步上下文 1010。
  expect(computeFinalTokens(assistant, [confirmedFinish, tool], confirmed, 2800)).toEqual({ input: 1012, output: 1, totalInput: 2012, totalOutput: 11 })
  expect(computeFinalTokens(assistant, [confirmedFinish, tool], { ...settled, stepInput: 0, stepOutput: 0 }, 2800)).toEqual({ input: 1012, output: 1, totalInput: 5012, totalOutput: 31 })
  // 真实下一轮换助手且不传旧 parts，投影的 1010 保留完整末步上下文而非累计 4000。
  const nextAssistant = { ...assistant, id: "next" }
  const nextRequest = { ...settled, assistantID: "next", stepInput: 0, stepOutput: 0, pendingInput: 1010 }
  expect(computeFinalTokens(nextAssistant, [], nextRequest, 2800)).toEqual({ input: 1010, output: 0, totalInput: 5010, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [{ ...text, messageID: "next" }], nextRequest, 2800)).toEqual({ input: 1010, output: 2, totalInput: 5010, totalOutput: 32 })
  expect(computeFinalTokens(undefined, [], nextRequest, 2800)).toEqual({ input: 1010, output: 0, totalInput: 5010, totalOutput: 30 })
  // 零基数不触发 bootstrap；确认事件先于 Session 快照到达也必须停止旧估算。
  expect(computeFinalTokens(nextAssistant, [], { ...nextRequest, input: 0, output: 0, pendingInput: 0 }, 2800)).toEqual({ input: 0, output: 0, totalInput: 0, totalOutput: 0 })
  expect(computeFinalTokens({ ...nextAssistant, time: { created: 2, completed: 0 } }, [], nextRequest, 2800)).toEqual({ input: 0, output: 0, totalInput: 4000, totalOutput: 30 })
  expect(computeFinalTokens(nextAssistant, [{ ...finish, messageID: "next" }], nextRequest, 2800)).toEqual({ input: 0, output: 0, totalInput: 4000, totalOutput: 30 })
  // 工具结果只补下一轮输入，已确认零的旧 step 不应触发新的 bootstrap。
  expect(computeFinalTokens(assistant, [finish, tool], active, 2800)).toEqual({ input: 2, output: 1, totalInput: 2, totalOutput: 1 })
})
