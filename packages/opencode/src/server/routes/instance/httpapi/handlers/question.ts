import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"
import { mapStorageNotFound } from "./session-errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const session = yield* Session.Service

    // 不传 sessionID 时保持 App 的全局列表；传入时复用同一 pending owner 做存在性检查和过滤。
    const list = Effect.fn("QuestionHttpApi.list")(function* (ctx: { query: { sessionID?: SessionID } }) {
      if (ctx.query.sessionID) yield* mapStorageNotFound(session.get(ctx.query.sessionID))
      return (yield* svc.list()).filter((row) => !ctx.query.sessionID || row.sessionID === ctx.query.sessionID)
    })

    // reply 在原 handler 内先验证配对，再进入唯一 Deferred 回答路径。
    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: { params: { sessionID: SessionID; requestID: QuestionID }; payload: Question.Reply }) {
      yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    // reply/reject 共用存在性与配对校验；requestID 来自两个 mutation 的必选路径参数。
    const requireOwnedRequest = Effect.fn("QuestionHttpApi.requireOwnedRequest")(function* (sessionID: SessionID, requestID: QuestionID) {
      yield* mapStorageNotFound(session.get(sessionID))
      const owned = (yield* svc.list()).some((row) => row.id === requestID && row.sessionID === sessionID); if (owned) return
      return yield* new QuestionNotFoundError({ requestID: String(requestID), message: `Question request not found: ${requestID}` })
    })

    // reject 同样在原 handler 内验证，不存在或错配都不能触碰另一 Session 的等待方。
    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { sessionID: SessionID; requestID: QuestionID } }) {
      yield* requireOwnedRequest(ctx.params.sessionID, ctx.params.requestID)
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    // 公共协议只保留 list/reply/reject 三个 handler，没有 Session 版与实例版双分支。
    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
