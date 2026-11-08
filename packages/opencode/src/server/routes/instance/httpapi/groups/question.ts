import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, QuestionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/question"
const ReplyPayload = Schema.Struct({
  answers: Schema.Array(Question.Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
})

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        // 同一 list 兼容 App 的全局引导；TUI 传 sessionID 时由同一 handler 验证并过滤。
        HttpApiEndpoint.get("list", root, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.optional(SessionID) }),
          success: described(Schema.Array(Question.Request), "List of pending questions"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "List pending questions",
            description: "Get pending questions globally or for one Session.",
          }),
        ),
        // 原 reply 直接升级为 Session 身份路径，不保留第二套 mutation 端点。
        HttpApiEndpoint.post("reply", `${root}/session/:sessionID/:requestID/reply`, {
          params: { sessionID: SessionID, requestID: QuestionID }, query: WorkspaceRoutingQuery, payload: ReplyPayload,
          success: described(Schema.Boolean, "Question answered successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reply",
            summary: "Reply to question request",
            description: "Provide answers to a question request from the AI assistant.",
          }),
        ),
        // reject 与 reply 共用同一 Session/request 配对边界。
        HttpApiEndpoint.post("reject", `${root}/session/:sessionID/:requestID/reject`, {
          params: { sessionID: SessionID, requestID: QuestionID }, query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Question rejected successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reject",
            summary: "Reject question request",
            description: "Reject a question request from the AI assistant.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "question",
          description: "Question routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
