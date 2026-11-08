import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import {
  createQuestionBodyState,
  questionConfirm,
  questionReject,
  questionSave,
  questionSelect,
  questionSetSelected,
  questionStoreCustom,
  questionSubmit,
  questionSync,
} from "@/cli/cmd/run/question.shared"

function req(input: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "question-1",
    sessionID: "session-1",
    questions: [
      {
        question: "Mode?",
        header: "Mode",
        options: [{ label: "chunked", description: "Incremental output" }],
        multiple: false,
      },
    ],
    ...input,
  }
}

describe("run question shared", () => {
  test("replies immediately for a single-select question", () => {
    const out = questionSelect(createQuestionBodyState("question-1"), req())

    // 立即回答必须同时携带 Session 与 request 身份。
    expect(out.reply).toEqual({
      sessionID: "session-1",
      requestID: "question-1",
      answers: [["chunked"]],
    })
  })

  test("advances multi-question flows and submits from confirm", () => {
    const ask = req({
      questions: [
        {
          question: "Mode?",
          header: "Mode",
          options: [{ label: "chunked", description: "Incremental output" }],
          multiple: false,
        },
        {
          question: "Output?",
          header: "Output",
          options: [
            { label: "yes", description: "Show tool output" },
            { label: "no", description: "Hide tool output" },
          ],
          multiple: false,
        },
      ],
    })

    let state = questionSelect(createQuestionBodyState("question-1"), ask).state
    expect(state.tab).toBe(1)

    state = questionSetSelected(state, 1)
    state = questionSelect(state, ask).state
    expect(questionConfirm(ask, state)).toBe(true)
    // Confirm 提交不能丢掉同一 Session 身份。
    expect(questionSubmit(ask, state)).toEqual({
      sessionID: "session-1",
      requestID: "question-1",
      answers: [["chunked"], ["no"]],
    })
  })

  test("toggles answers for multiple-choice questions", () => {
    const ask = req({
      questions: [
        {
          question: "Tags?",
          header: "Tags",
          options: [{ label: "bug", description: "Bug fix" }],
          multiple: true,
        },
      ],
    })

    let state = questionSelect(createQuestionBodyState("question-1"), ask).state
    expect(state.answers).toEqual([["bug"]])

    state = questionSelect(state, ask).state
    expect(state.answers).toEqual([[]])
  })

  test("stores and submits custom answers", () => {
    let state = questionSetSelected(createQuestionBodyState("question-1"), 1)
    let next = questionSelect(state, req())
    expect(next.state.editing).toBe(true)

    state = questionStoreCustom(next.state, 0, "  custom mode  ")
    next = questionSave(state, req())
    // 自定义回答与预置选项使用相同配对合同。
    expect(next.reply).toEqual({
      sessionID: "session-1",
      requestID: "question-1",
      answers: [["custom mode"]],
    })
  })

  test("resets state when the request id changes and builds reject payloads", () => {
    const state = questionSetSelected(createQuestionBodyState("question-1"), 1)

    expect(questionSync(state, "question-1")).toBe(state)
    expect(questionSync(state, "question-2")).toEqual(createQuestionBodyState("question-2"))
    // reject payload 同样包含 Session，而不是只保留 requestID。
    expect(questionReject(req())).toEqual({
      sessionID: "session-1",
      requestID: "question-1",
    })
  })
})
