import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Token } from "../src/util/token"

test("calibrates input density with thresholds, cache-inclusive samples and a shared cutoff", () => {
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 100000, input: 40000 }])).toBe(2.5)
  // 这组普通输入只有30000，结果仍为2.5才证明缓存读写也进入了输入侧样本分母。
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 100000, input: 30000 + 5000 + 5000 }])).toBe(2.5)
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 1000, input: 125 }])).toBe(8)
  expect(Token.charsPerTokenFromHistory([])).toBe(4)
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 50, input: 10 }])).toBe(4)
  // 500与501跨过累计门槛；它独立于单样本100字符的准入条件，两个阈值不能混为一次过滤。
  for (const bodyChars of [200, 500]) expect(Token.charsPerTokenFromHistory([{ bodyChars, input: 40 }])).toBe(4)
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 501, input: 167 }])).toBe(3)
  for (const input of [0, -1, Infinity, NaN]) expect(Token.charsPerTokenFromHistory([{ bodyChars: 1000, input }])).toBe(4)
  // 缺分桶时由最近确认点约束绝对量，较旧的极端点不能改变该密度。
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 50000, input: 20000 }, { bodyChars: 50000, input: 20000 }, { bodyChars: 100000, input: 1 }])).toBe(2.5)
  // 附件只从字符分子扣除；纯附件不足文本门槛时仍回到 /4。
  const inputBreakdown = { system: 0, instructions: 0, skills: 0, tools: 0,
    messages: { userText: 1000, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 99000, total: 100000 } }
  const history = [{ bodyChars: 100000, input: 400, inputBreakdown }]
  // #194：旧附件只有 raw 字符，缺媒体确认量时不能继续学习这个样本。
  expect(Token.charsPerTokenFromHistory(history)).toBe(4)
  expect(Token.estimateRequest({ messages: [] }, history, []).charsPerToken).toBe(4)
  expect(Token.charsPerTokenFromHistory([{ ...history[0], inputBreakdown: { ...inputBreakdown, messages: { ...inputBreakdown.messages, attachments: 100000 } } }])).toBe(4)
})

test("confirmed mixed densities estimate encrypted reasoning without inflating ordinary text", () => {
  const breakdown = (reasoning: number): SessionMessage.InputBreakdown => ({
    system: 0, instructions: 0, skills: 0, tools: 0,
    messages: { userText: 0, assistantText: 0, reasoning, toolInput: 0, toolOutput: 0, attachments: 0, total: reasoning },
  })
  // 两个确认点独立给定 /4 正文和 /16 推理，改变组成后仍应得到约50万输入。
  const history = [
    { bodyChars: 1_000_000, input: 212_500, inputBreakdown: breakdown(200_000) },
    { bodyChars: 1_000_000, input: 100_000, inputBreakdown: breakdown(800_000) },
  ]
  const result = Token.estimateRequest({
    instructions: "t".repeat(1_600_000),
    input: [{ type: "reasoning", encrypted_content: "r".repeat(1_600_000) }],
  }, history, [])
  expect(result.input).toBeGreaterThanOrEqual(500_000)
  expect(result.input).toBeLessThan(500_100)
  expect(result.charsPerToken).toBe(4)
  expect(result.charsPerToken).toBe(Token.charsPerTokenFromHistory(history))
  // 共线的混合样本不能把推理的高密度泄漏给后续纯文本请求。
  const plain = Token.estimateRequest({ instructions: "t".repeat(5_000_000) }, [
    { bodyChars: 1_001_000, input: 31_500, inputBreakdown: breakdown(1_000_000) },
  ], [])
  expect(plain.charsPerToken).toBe(8)
  expect(plain.input).toBeGreaterThanOrEqual(625_000)
})

test("one serializer accounts for lowered messages, tools, source sections and JSON escapes", () => {
  let reads = 0
  // 引号、反斜杠与换行会增加wire字符；消息另含控制字符和孤立surrogate以覆盖不同转义长度。
  const instructions = "Instructions from: fixture\nquoted \"rule\"\\path"
  const skills = "<available_skills>\nfixture\n</available_skills>"
  // 同一指令被两个来源声明也只归属一次；重复来源不能把system余量扣成负值或扩大instructions。
  const sections: Token.SystemSection[] = [{ kind: "instructions", text: instructions }, { kind: "skills", text: skills }, { kind: "instructions", text: instructions }]
  const body = {
    model: "api-model", system: [{ type: "text", text: ["default system", instructions, skills].join("\n\n") }],
    messages: [
      { role: "user", content: [{ type: "text", text: "synthetic text\u0000\ud800" }, { type: "image", source: { data: "x".repeat(1500) } }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reason" }, { type: "tool_use", id: "c", name: "read", input: { messages: ["argument"], tools: ["argument"] } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "tool output" }] },
    ],
    tools: [{ name: "read", input_schema: { type: "object", properties: { system: { type: "string" }, messages: { type: "array" } } } }],
    // getter是序列化次数的观察点；先断言再执行独立JSON oracle，避免oracle本身被算成第二次生产遍历。
    get temperature() { reads++; return 0.25 },
  }
  const result = Token.estimateRequest(body, [], sections)
  expect(reads).toBe(1)
  const bd = Schema.decodeUnknownSync(SessionMessage.InputBreakdown)(result.inputBreakdown)
  expect(result.bodyChars).toBe(JSON.stringify(body).length)
  // 总和与原生JSON长度分别对照，既能发现跨桶重复计数，也能发现漏标点后仅靠桶内相等伪通过。
  expect(bd.system + bd.instructions + bd.skills + bd.tools + bd.messages.total).toBe(result.bodyChars)
  expect(Object.values(bd.messages).filter((_, index) => index < 6).every(value => value > 0)).toBe(true)
  expect(bd.messages.total).toBe(bd.messages.userText + bd.messages.assistantText + bd.messages.reasoning + bd.messages.toolInput + bd.messages.toolOutput + bd.messages.attachments)
  // 两个外围引号归system结构，片段只分走实际转义正文；去掉内部转义会破坏这个精确oracle。
  expect(bd.instructions).toBe(JSON.stringify(instructions).length - 2)
  expect(bd.skills).toBe(JSON.stringify(skills).length - 2)
  const absent = Token.estimateRequest({ system: "default system" }, [], sections)
  expect(absent.inputBreakdown?.instructions).toBe(0)
  expect(absent.inputBreakdown?.skills).toBe(0)
  // wrapped日期以user角色传输，归因只转移一次，转义、总长和估算输入必须守恒。
  const reminder = "<system-reminder>\nToday's date is now: \"next\"\\date\n</system-reminder>"
  const messages = { messages: [{ role: "user", content: "actual user" }, { role: "user", content: reminder }] }
  const ordinary = Token.estimateRequest(messages, [], [])
  const attributed = Token.estimateRequest(messages, [], [{ kind: "system", text: reminder }, { kind: "system", text: reminder }])
  const size = JSON.stringify(reminder).length - 2
  expect(attributed.bodyChars).toBe(ordinary.bodyChars)
  expect(attributed.input).toBe(ordinary.input)
  expect(attributed.inputBreakdown?.system).toBe((ordinary.inputBreakdown?.system ?? 0) + size)
  expect(attributed.inputBreakdown?.messages.userText).toBe((ordinary.inputBreakdown?.messages.userText ?? 0) - size)
  expect(attributed.inputBreakdown?.messages.total).toBe(attributed.inputBreakdown?.messages.userText)
  // 无实际载荷的声明和普通instructions提示不能窃取真实user正文。
  expect(Token.estimateRequest(messages, [], [{ kind: "system", text: "absent" }, { kind: "instructions", text: "actual user" }]).inputBreakdown)
    .toEqual(ordinary.inputBreakdown)
})

test("learning consumes only twenty eligible samples and separates legacy media from text", () => {
  let consumed = 0
  function* history() {
    for (let index = 0; index < 10000; index++) {
      consumed++
      yield { bodyChars: 1000, input: 250 }
    }
  }
  // 可迭代数据是调用方持有的样本，不得为了一个scalar结果读完无关旧历史。
  expect(Token.charsPerTokenFromHistory(history())).toBe(4)
  expect(consumed).toBe(20)
  const media = { rawChars: 99000, textChars: 0, tokens: 1600 }
  const sample = { bodyChars: 100000, input: 1850, inputBreakdown: { media, messages: { attachments: 99000 } } }
  expect(Token.charsPerTokenFromHistory([sample])).toBe(4)
  // 媒体输入已从确认量分离；缺media元数据的旧附件仍不能参与学习。
  expect(Token.charsPerTokenFromHistory([{ ...sample, inputBreakdown: { messages: { attachments: 99000 } } }])).toBe(4)
  expect(Token.charsPerTokenFromHistory([{ bodyChars: 1000, input: 0 }, { bodyChars: 1000, input: 125 }])).toBe(8)
  // 样本数组可重复供scalar和prepared估算使用，重试不共享耗尽的iterator。
  const samples = [{ bodyChars: 1000, input: 125 }]
  expect(Token.estimateRequest({ instructions: "hello" }, samples)).toEqual(Token.estimateRequest({ instructions: "hello" }, samples))
})

test("Chat, Responses and SDK bodies use the same estimator without reparsing schemas", () => {
  for (const body of [
    { messages: [{ role: "developer", content: "system" }, { role: "user", content: "hello" }, { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "{}" } }] }, { role: "tool", content: "done" }] },
    { instructions: "system", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }, { type: "function_call", arguments: "{}" }, { type: "function_call_output", output: "done" }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }], providerOptions: { openai: { instructions: "system" } } },
  ]) {
    const result = Token.estimateRequest(body, [], [])
    const bd = Schema.decodeUnknownSync(SessionMessage.InputBreakdown)(result.inputBreakdown)
    expect(bd.system + bd.instructions + bd.skills + bd.tools + bd.messages.total).toBe(JSON.stringify(body).length)
    expect(bd.messages.userText).toBeGreaterThan(0)
    expect(bd.system).toBeGreaterThan(0)
  }
})

test("public optional fields round-trip on the real current and V1 schemas", () => {
  const estimate = Token.estimateRequest({ messages: [] }, [], [])
  // undefined必须从wire省略而数值零必须保留，两者分别表达无游标与已冻结的未知预算。
  const encoded = Schema.encodeSync(SessionMessage.InputEstimate)({ ...estimate, afterPartID: undefined, contextLimit: 0 })
  expect(encoded).not.toHaveProperty("afterPartID")
  expect(encoded).toHaveProperty("contextLimit", 0)
  const part = Schema.decodeUnknownSync(SessionV1.StepFinishPart)({ id: "prt_fixture", messageID: "msg_fixture",
    sessionID: "ses_fixture", type: "step-finish", reason: "stop", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    inputChars: estimate.bodyChars, inputBreakdown: estimate.inputBreakdown })
  expect(Schema.decodeUnknownSync(SessionV1.StepFinishPart)(Schema.encodeSync(SessionV1.StepFinishPart)(part)).inputBreakdown).toEqual(estimate.inputBreakdown)
})

test("source JSON and mixed-content calibration exercises the estimator rather than a formula copy", () => {
  const json = { messages: Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `code ${i} and repeated tool result text`.repeat(8) })),
    tools: Array.from({ length: 5 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: "object", properties: { input: { type: "string" } } } })) }
  const chars = JSON.stringify(json).length
  const calibrated = Token.estimateRequest(json, [{ bodyChars: 100000, input: 40000 }])
  // 确认样本给出输入密度，oracle只计算独立正文长度；不能拿估算输出反过来充当校准数据自证。
  expect(calibrated.input).toBe(Math.round(chars / 2.5))
  expect(Token.estimateRequest(json, []).input).toBeLessThan(calibrated.input)
  const mixed = "The quick brown fox jumps over the lazy dog. ".repeat(100)
    + JSON.stringify({ key: "value", nested: { array: [1, 2, 3, 4, 5] } }).repeat(50)
    + "function example(x: number): string { return x.toString(); }\n".repeat(30)
  const normal = Token.estimateRequest(mixed, [])
  const dense = Token.estimateRequest(mixed, [{ bodyChars: 90000, input: 45000 }])
  const middle = Token.estimateRequest(mixed, [{ bodyChars: 90000, input: 30000 }])
  expect(normal.input).toBeLessThan(middle.input)
  expect(dense.input).toBeGreaterThan(middle.input)
})

test("prepared media handles SDK binary, base64 and native fields without inflating text tokens", () => {
  const bytes = Buffer.alloc(5625)
  // 同一7500字符图片负载经过不同 provider 准备格式，视觉预算与 raw JSON 计数都应一致。
  for (const content of [
    { type: "file", mediaType: "image/png", data: bytes },
    { type: "file", mediaType: "image/png", data: new Uint8Array(bytes) },
    { type: "file", mediaType: "image/png", data: bytes.toString("base64") },
    { type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` },
    { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } },
    // MIME与载荷决定计量，SDK类型别名和协议包装共用同一个媒体预算。
    { type: "image-data", mediaType: "image/png", data: bytes.toString("base64") },
    { type: "file-data", mediaType: "image/png", data: bytes.toString("base64") },
    // 新类型名不需要追加枚举，媒体身份来自协议内容中的MIME与载荷。
    { type: "future-media", mime: "image/png", data: bytes.toString("base64") },
    { inlineData: { mimeType: "image/png", data: bytes.toString("base64") } },
    // Bedrock把格式与bytes分放在父子节点，预算需要保留这份格式关联。
    { image: { format: "png", source: { bytes: bytes.toString("base64") } } },
  ]) {
    const body = { messages: [{ role: "user", content: [content] }] }
    const result = Token.estimateRequest(body, [], [])
    expect(result.bodyChars).toBe(JSON.stringify(body).length)
    expect(result.inputBreakdown?.media?.tokens).toBe(10)
    expect(result.inputBreakdown?.media?.count).toBe(1)
    // 文本估量只含包装与占位，不能把二进制展开或 base64 再除四计入。
    expect(result.input).toBeLessThan(250)
  }
})

test("prepared media preserves PDF MIME and leaves tool JSON as text", () => {
  const data = "A".repeat(7500)
  for (const part of [
    { type: "file-data", mediaType: "application/pdf", data },
    { inlineData: { mimeType: "application/pdf", data } },
    { document: { format: "pdf", source: { bytes: data } } },
  ]) {
    const result = Token.estimateRequest({ messages: [{ role: "user", content: [part] }] }, [], [])
    // 7500字符的PDF预算为7；误用图片或普通文本策略会得到不同结果。
    expect(result.inputBreakdown?.media?.tokens).toBe(7)
  }
  const value = { type: "image-data", mediaType: "image/png", data, path: "/media/file/data.png" }
  for (const body of [
    { messages: [{ role: "assistant", content: [{ type: "tool-call", input: value }] }] },
    { messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value } }] }] },
    { contents: [{ role: "user", parts: [{ functionResponse: { name: "read", response: value } }] }] },
    { messages: [{ role: "user", content: [{ toolResult: { content: [{ json: value }] } }] }] },
  ]) {
    // 业务JSON即使具有同名字段仍是正文，避免泛化识别降低真实输入预算。
    const result = Token.estimateRequest(body, [], [])
    expect(result.inputBreakdown?.media).toBeUndefined()
    expect(result.input).toBeGreaterThan(1800)
  }
})
