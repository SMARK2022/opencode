import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceStore } from "@/project/instance-store"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { MessageV2 } from "@/session/message-v2"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPreview } from "@opencode-ai/core/session/preview"
import { Database } from "@opencode-ai/core/database/database"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  GoalApiError,
  GoalSetPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PreviewPayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const store = yield* InstanceStore.Service
    // 稳定服务在 handler layer 捕获，查询不重新构造数据库层或项目作用域。
    const usageSvc = yield* SessionRequestUsage.Service
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const goalSvc = yield* SessionGoal.Service
    const database = yield* Database.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    // #153：session 级操作的 InstanceRef/WorkspaceRef 必须来自持久化 session 目录，
    // 而非请求级 ambient directory，否则跨目录请求的事件会发布到错误实例。
    // 泛型透传保持 effect 的 E/R 签名，包装不改变调用方的错误契约
    const inSessionDirectory = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        // requireSession 在 session 不存在时走 NotFound 契约，包装层不吞错误
        const info = yield* requireSession(sessionID)
        return yield* store.provide({ directory: info.directory }, effect)
      })

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.compact(Permission.merge(current.permission ?? [], ctx.payload.permission)),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      // #132：优先用会话 directory provide；找不到则退回当前实例 cancel
      // #132：abort 不抛 NotFound 以匹配 HTTP 契约
      const info = yield* session.get(ctx.params.sessionID).pipe(Effect.option)
      if (info._tag === "Some") {
        yield* store.provide({ directory: info.value.directory }, promptSvc.cancel(ctx.params.sessionID))
      } else {
        yield* promptSvc.cancel(ctx.params.sessionID)
      }
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // #153：INIT 消息会作为 session 首条记录落库，必须在持久化目录上下文执行
      yield* inSessionDirectory(
        ctx.params.sessionID,
        promptSvc
          .command({
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
            command: Command.Default.INIT,
            arguments: "",
          })
          .pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      // #153：compaction 摘要消息与 revert 清理的落库位置跟随 session 持久化目录
      yield* inSessionDirectory(
        ctx.params.sessionID,
        Effect.gen(function* () {
          // #242：busy 会话先拒绝——revert 清理或模型选择前拦截，避免手动 compact
          // 改完状态后又在进行中的 prompt 后面空转
          yield* SessionError.mapBusy(runState.assertNotBusy(info.id))
          yield* revertSvc.cleanup(info)
          const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
          const defaultAgent = yield* agentSvc.defaultAgent()
          // 空会话回退 defaultAgent，保证 compaction 始终有可用 agent
          const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

          // #242：Summarize 直接经 SessionPrompt 执行 compaction——取消归属 runner，
          // 历史中不再遗留可被后续请求重放的 pending compact 命令
          yield* SessionError.mapBusy(
            promptSvc.compact({
              sessionID: ctx.params.sessionID,
              agent: currentAgent,
              model: {
                providerID: ctx.payload.providerID,
                modelID: ctx.payload.modelID,
              },
              auto: ctx.payload.auto ?? false,
            }),
          )
        }),
      )
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // #153：流式返回的 message 必须来自 session 所属实例，防止跨目录读写
      const message = yield* inSessionDirectory(
        ctx.params.sessionID,
        Effect.gen(function* () {
          // 守卫必须与执行同属持久会话目录，否则会读到另一份InstanceState。
          yield* runState.assertNotReverting(ctx.params.sessionID)
          return yield* promptSvc.prompt({
            ...ctx.payload,
            sessionID: ctx.params.sessionID,
          })
        }).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // #153：后台 fork 的 Error 事件必须发布到 session 所属实例，订阅方才能收到
      yield* inSessionDirectory(
        ctx.params.sessionID,
        Effect.gen(function* () {
          // 同步拒绝发生在fork之前，不能把revert冲突藏进后台Error事件。
          yield* runState.assertNotReverting(ctx.params.sessionID).pipe(
            Effect.catchTag("SessionBusyError", () => new HttpApiError.BadRequest({})),
          )
          yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
          // catchCause 后统一转 Error 事件，单次失败不影响请求作用域内其他 fiber
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
              yield* events.publish(Session.Event.Error, {
                sessionID: ctx.params.sessionID,
                error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            }),
          ),
          ).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // #153：命令消息持久化与 agent 解析依赖 session 目录上下文
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        Effect.gen(function* () {
          yield* runState.assertNotReverting(ctx.params.sessionID)
          return yield* promptSvc.command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        }).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // #153：shell 的输出落盘与快照写入 session 所在存储根，跨目录会写到错误位置
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        SessionError.mapBusy(
          runState.assertNotReverting(ctx.params.sessionID).pipe(Effect.andThen(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))),
        ),
      )
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // revert与四个提交入口必须读写同一目录作用域的reverting集合。
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload })),
      )
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID })),
      )
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* inSessionDirectory(ctx.params.sessionID, Effect.gen(function* () {
        // assertNotBusy新增reverting语义后，删除检查也要消费同一目录状态。
        yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
        yield* session.removeMessage(ctx.params)
      }))
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    // 沿用原始 wire 对象；只有数据库边界把整数微美元转换成美元。
    const requestUsageList = Effect.fn("SessionHttpApi.requestUsageList")(function* (ctx: {
    params: { sessionID: SessionID }
    query: { limit?: number; before?: number; rootRequestID?: MessageID; source?: SessionRequestUsage.Source }
  }) {
    yield* requireSession(ctx.params.sessionID)
    return yield* usageSvc.list({ sessionID: ctx.params.sessionID, ...ctx.query })
  })
  // 资源缺失保持 404，不把有效 requestID 当成格式错误。
    const requestUsageGet = Effect.fn("SessionHttpApi.requestUsageGet")(function* (ctx: { params: { sessionID: SessionID; requestID: MessageID } }) {
    yield* requireSession(ctx.params.sessionID)
    const result = yield* usageSvc.get({ sessionID: ctx.params.sessionID, requestID: ctx.params.requestID })
    // 复用现有 name/data.message 404 body，不能用内建空错误改掉 source JSON 契约。
    if (!result) return yield* notFound(`Request usage not found: ${ctx.params.requestID}`)
    return result
  })
  // assistant明细属于具体父请求，缺失请求不能被解释为空的成功列表。
    const requestUsageAssistants = Effect.fn("SessionHttpApi.requestUsageAssistants")(function* (ctx: { params: { sessionID: SessionID; requestID: MessageID } }) {
    yield* requireSession(ctx.params.sessionID)
    const result = yield* usageSvc.get(ctx.params)
    // 复用get端点的已声明JSON错误，不增加内建空错误的第二种wire格式。
    if (!result) return yield* notFound(`Request usage not found: ${ctx.params.requestID}`)
    return yield* usageSvc.assistants(ctx.params)
  })

  // #364：goal handler：读取当前 session 的持久化 goal
  const goalGet = Effect.fn("SessionHttpApi.goalGet")(function* (ctx: {
    params: { sessionID: SessionID }
  }) {
    // requireSession 先校验 session 存在性，未命中直接 404
    yield* requireSession(ctx.params.sessionID)
    const result = yield* goalSvc.get(ctx.params.sessionID)
    // Option → null 映射，便于 JSON 序列化
    return { goal: result._tag === "Some" ? result.value : null }
  })

  // #364：goal set handler：创建或更新 goal
  // objective 缺省时仅更新 status/budget，要求已有 goal
  // GoalError（校验失败）映射为 400，其他错误正常传播
  const goalSet = Effect.fn("SessionHttpApi.goalSet")(function* (ctx: {
    params: { sessionID: SessionID }
    payload: typeof GoalSetPayload.Type
  }) {
    yield* requireSession(ctx.params.sessionID)
    const goal = yield* inSessionDirectory(ctx.params.sessionID, goalSvc.set(ctx.params.sessionID, {
      objective: ctx.payload.objective,
      status: ctx.payload.status,
      tokenBudget: ctx.payload.tokenBudget,
    })).pipe(
      // GoalError 的具体原因（空/超长/budget/无goal）透传到 wire 体 data.message，
      // 让 TUI 能展示真实拒绝原因，而非通用 "Failed to update goal"；
      // 校验失败仍映射为 4xx，保持错误面契约：不伪装成 5xx
      Effect.catchTag("GoalError", (error) =>
        Effect.fail(new GoalApiError({ name: "GoalError", data: { message: error.message } })),
      ),
    )
    return { goal }
  })

  // #364：goal clear handler：删除 goal
  // [local-smark] DELETE 幂等：goal 不存在时 cleared=false 而非报错，
  // 使客户端重复清除或竞态清除不产生用户可见失败
  const goalClear = Effect.fn("SessionHttpApi.goalClear")(function* (ctx: {
    params: { sessionID: SessionID }
  }) {
    yield* requireSession(ctx.params.sessionID)
    const cleared = yield* inSessionDirectory(ctx.params.sessionID, goalSvc.clear(ctx.params.sessionID))
    return { cleared }
  })

  // 两代端点共用批量查询入口；V1只读原有message/part，不与Native历史互补。
  const preview = Effect.fn("SessionHttpApi.preview")(function* (ctx: {
    payload: typeof PreviewPayload.Type
  }) {
    return yield* SessionPreview.load(database.db, ctx.payload, "v1")
  })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
    .handle("requestUsageList", requestUsageList)
    .handle("requestUsageGet", requestUsageGet)
    .handle("requestUsageAssistants", requestUsageAssistants)
    // #364：goal endpoint handler 注册
    .handle("goal", goalGet)
    .handle("goalSet", goalSet)
    .handle("goalClear", goalClear)
    .handle("preview", preview)
  }),
)
