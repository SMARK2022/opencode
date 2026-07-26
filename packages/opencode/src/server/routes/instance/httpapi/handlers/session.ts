import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
// [local-smark] request usage tracking
import { SessionRequestUsage } from "@/session/request-usage"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
// [local-smark] session preview: 直接查 DB 获取用户消息预览文本
import { MessageTable, PartTable } from "@/session/session.sql"
import { Database, sql } from "@/storage/db"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
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
  // [local-smark] session preview payload schema
  PreviewPayload,
  SearchScanPayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
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
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const goalSvc = yield* SessionGoal.Service
    const summary = yield* SessionSummary.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    // searchMode 原样透传：缺省/all 保持旧全量搜索；title 供 progressive 首屏
    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        searchMode: ctx.query.searchMode,
        limit: ctx.query.limit,
      })
    })

    // progressive B2 HTTP：payload 带 scope 字段，directory 与 list 一样受 scope=project 影响
    // query.directory 作缺省，避免 TUI 只在 URL 上带 directory 时丢 scope
    const searchScan = Effect.fn("SessionHttpApi.searchScan")(function* (ctx: {
      payload: typeof SearchScanPayload.Type
      query: { directory?: string }
    }) {
      const payload = ctx.payload
      return yield* session.searchScan({
        search: payload.search,
        cursor: payload.cursor,
        batch: payload.batch,
        scope: payload.scope,
        path: payload.path,
        roots: payload.roots,
        start: payload.start,
        // scope=project 时忽略 directory，与 SessionHttpApi.list 一致
        directory: payload.scope === "project" ? undefined : (payload.directory ?? ctx.query.directory),
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
      const result = yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
      // internal get 保持 raw 给 repair/reviewer；这里只有普通 SDK wire 才应用 not-found visibility。
      if (result.info.hidden) return yield* ApiError.notFound(`Message not found: ${ctx.params.messageID}`)
      // visible parent 的 hidden Part 仍作为 tombstone producer 保留在 raw storage，但不进入 SDK response。
      return { ...result, parts: result.parts.filter((part) => !part.hidden) }
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
      const payload = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
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
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
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
        session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload?.messageID }),
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
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
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
      yield* requireSession(ctx.params.sessionID)
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      // Busy acquisition 与 revert cleanup 由 SessionPrompt 的 exclusive 边界统一负责，HTTP 层只做传输映射。
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
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // revert 进行中时阻止 prompt——避免 cleanup 与 in-progress revert 的消息/文件竞争
      yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
      const message = yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // revert 进行中时同步返回错误，不 fork——TUI 收到 BadRequest 保留草稿
      yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed").pipe(
              Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
            )
            yield* bus.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // command 内部调用 prompt()（含 cleanup），同样需要 revert 守卫
      yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // shell 内部调用 shellImpl（含 cleanup），同样需要 revert 守卫
      yield* SessionError.mapBusy(runState.assertNotReverting(ctx.params.sessionID))
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response })
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
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
      payload: typeof MessageV2.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      const parent = yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
      // parent visibility 必须在 updatePart 前判定，否则已知 Part ID 会重新产生普通事件。
      if (parent.info.hidden) return yield* ApiError.notFound(`Message not found: ${ctx.params.messageID}`)
      return yield* session.updatePart(payload)
    })

    // [local-smark] request_usage handlers for per-request cost tracking
    const requestUsageList = Effect.fn("SessionHttpApi.requestUsageList")(function* (ctx: {
      params: { sessionID: SessionID }
      query: { limit?: number; before?: number; rootRequestID?: MessageID; source?: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const usage = yield* SessionRequestUsage.Service
      return yield* usage.list({
        sessionID: ctx.params.sessionID,
        limit: ctx.query.limit,
        before: ctx.query.before,
        rootRequestID: ctx.query.rootRequestID,
        source: ctx.query.source as any,
      }).pipe(Effect.mapError(() => new HttpApiError.NotFound({})))
    })

    const requestUsageGet = Effect.fn("SessionHttpApi.requestUsageGet")(function* (ctx: {
      params: { sessionID: SessionID; requestID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const usage = yield* SessionRequestUsage.Service
      const result = yield* usage.get({ sessionID: ctx.params.sessionID, requestID: ctx.params.requestID }).pipe(
        Effect.mapError(() => new HttpApiError.NotFound({})),
      )
      if (!result) return yield* new HttpApiError.NotFound({})
      return result
    })

    const requestUsageAssistants = Effect.fn("SessionHttpApi.requestUsageAssistants")(function* (ctx: {
      params: { sessionID: SessionID; requestID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const usage = yield* SessionRequestUsage.Service
      const result = yield* usage.get({ sessionID: ctx.params.sessionID, requestID: ctx.params.requestID }).pipe(
        Effect.mapError(() => new HttpApiError.NotFound({})),
      )
      if (!result) return yield* new HttpApiError.NotFound({})
      return yield* usage.assistants({ sessionID: ctx.params.sessionID, requestID: ctx.params.requestID }).pipe(
        Effect.mapError(() => new HttpApiError.NotFound({})),
      )
    })

    // goal handler：读取当前 session 的持久化 goal
    const goalGet = Effect.fn("SessionHttpApi.goalGet")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* goalSvc.get(ctx.params.sessionID)
      // Option → null 映射，便于 JSON 序列化
      return { goal: result._tag === "Some" ? result.value : null }
    })

    // goal set handler：创建或更新 goal
    // objective 缺省时仅更新 status/budget，要求已有 goal
    // terminal status（complete/blocked）需要 reason
    // [local-smark] active mutation 后 fork prompt loop 使 idle session 恢复执行
    const goalSet = Effect.fn("SessionHttpApi.goalSet")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof GoalSetPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const goal = yield* goalSvc.set(ctx.params.sessionID, {
        objective: ctx.payload.objective,
        status: ctx.payload.status,
        tokenBudget: ctx.payload.tokenBudget,
        // [local-smark] 透传错误续跑策略到 domain service
        continueOnError: ctx.payload.continueOnError,
        // [local-smark] terminal reason 透传到 domain service
        reason: ctx.payload.reason,
      }).pipe(
        // GoalError 的具体原因（空/超长/budget/无goal/reason）透传到 wire 体 data.message，
        // 让 TUI 能展示真实拒绝原因，而非通用 "Failed to update goal"
        Effect.catchTag("GoalError", (error) =>
          Effect.fail(new GoalApiError({ name: "GoalError", data: { message: error.message } })),
        ),
      )
      // [local-smark] active mutation 只在已有 user Message 时恢复现有 loop；
      // empty Session 保留 active Goal，等待第一条真实 prompt 自然启动执行。
      if (goal.status === "active") {
        // 此处只判断 loop 是否有可消费的 user history，不重复 Goal-turn classifier；
        // canonical/technical 身份仍由 SessionPrompt 在唯一执行路径中权威判定。
        // role predicate 走热索引式分页，无 user 时不应因一次 Goal mutation 展开任何 cold Part。
        // 有匹配时只预热该 user；HTTP response contract 不暴露 cold_ref 或要求客户端传 read intent。
        const user = yield* session
          .findMessage(ctx.params.sessionID, (info) => info.role === "user")
          .pipe(Effect.orDie)
        if (Option.isSome(user)) {
          // busy Session 继续由 RunState.ensureRunning 去重；后台 failure 必须沿用现有
          // prompt_async observability，不能静默吞掉或伪造 mutation 成功后的执行结果。
          // startImmediately 让 fork 在 handler scope 内开始，随后仍由 RunState 决定 start/join；
          // HTTP 200 只承诺 mutation 已提交，不把后台执行成败混入 response contract。
          yield* promptSvc.loop({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("goal resume loop failed").pipe(
                  Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
                )
                yield* bus.publish(Session.Event.Error, {
                  sessionID: ctx.params.sessionID,
                  error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
                })
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }
      }
      return { goal }
    })

    // goal clear handler：删除 goal
    const goalClear = Effect.fn("SessionHttpApi.goalClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const cleared = yield* goalSvc.clear(ctx.params.sessionID)
      return { cleared }
    })

    // [local-smark] session preview handler
    // 单条 SQL 窗口函数查询批量获取多个 session 的最近 N 条用户消息文本，
    // 替代 TUI 中每 session 独立分页调用 session.messages 的 N×M 模式。
    // 过滤条件与 MessageV2.page(includeHidden=false) + textFromUserMessage 完全对齐：
    // - role = 'user' 且 message 无 hidden 标记
    // - part type = 'text' 且非 synthetic/ignored 且无 hidden 标记
    // - EXISTS 子查询确保只排名有可见 text part 的用户消息（与当前代码跳过
    //   无文本消息后继续扫描的行为一致）
    const preview = Effect.fn("SessionHttpApi.preview")(function* (ctx: {
      payload: typeof PreviewPayload.Type
    }) {
      const { sessionIDs, limit: rawLimit } = ctx.payload
      if (sessionIDs.length === 0) return {} as Record<string, string[]>
      const limit = rawLimit ?? 2

      // 参数化 IN 子句，防止 SQL 注入；SQLite 参数上限 32766，400 远在限内
      const idPlaceholders = sql.join(sessionIDs.map((id) => sql`${id}`), sql`, `)

      const rows = Database.use((db) =>
        db.all(sql`
          WITH ranked_messages AS (
            SELECT ${MessageTable.id} as message_id, ${MessageTable.session_id}, ${MessageTable.time_created},
              ROW_NUMBER() OVER (
                PARTITION BY ${MessageTable.session_id}
                ORDER BY ${MessageTable.time_created} DESC, ${MessageTable.id} DESC
              ) as msg_rn
            FROM ${MessageTable}
            WHERE json_extract(${MessageTable.data}, '$.role') = 'user'
              AND json_type(${MessageTable.data}, '$.hidden') IS NULL
              AND ${MessageTable.session_id} IN (${idPlaceholders})
              AND EXISTS (
                SELECT 1 FROM ${PartTable}
                WHERE ${PartTable.message_id} = ${MessageTable.id}
                  AND json_extract(${PartTable.data}, '$.type') = 'text'
                  AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
                  AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
                  AND json_type(${PartTable.data}, '$.hidden') IS NULL
              )
          ),
          preview_parts AS (
            SELECT rm.session_id, rm.msg_rn, ${PartTable.id} as part_id,
              json_extract(${PartTable.data}, '$.text') as text
            FROM ranked_messages rm
            INNER JOIN ${PartTable} ON ${PartTable.message_id} = rm.message_id
              AND json_extract(${PartTable.data}, '$.type') = 'text'
              AND coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
              AND coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
              AND json_type(${PartTable.data}, '$.hidden') IS NULL
            WHERE rm.msg_rn <= ${limit}
          )
          SELECT session_id, msg_rn, group_concat(text, ' ') as joined_text
          -- 子查询 ORDER BY 保证同一消息内多 text part 按 part.id 顺序拼接；
          -- SQLite group_concat 不保证 GROUP BY 内顺序，需子查询喂入有序行
          FROM (SELECT * FROM preview_parts ORDER BY part_id)
          GROUP BY session_id, msg_rn
          -- msg_rn 由窗口函数 ORDER BY time_created DESC 赋值：1=最新，2=次新。
          -- 此处 DESC 使次新先返回、最新后返回，JS push 随之产出正序（旧→新）数组
          ORDER BY session_id, msg_rn DESC
        `),
      ) as { session_id: string; msg_rn: number; joined_text: string | null }[]

      // JS 侧完成空白归一化（与 textFromUserMessage 的
      // .replace(/\s+/g, " ").trim() 对齐）并按 session 分组
      const result: Record<string, string[]> = {}
      for (const row of rows) {
        // group_concat 对无匹配行返回 NULL；空文本跳过，与 if (text) 一致
        const text = (row.joined_text ?? "").replace(/\s+/g, " ").trim()
        if (!text) continue
        if (!result[row.session_id]) result[row.session_id] = []
        result[row.session_id].push(text)
      }
      return result
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
      // [local-smark] request_usage endpoints
      .handle("requestUsageList", requestUsageList as any)
      .handle("requestUsageGet", requestUsageGet as any)
      .handle("requestUsageAssistants", requestUsageAssistants as any)
      // goal endpoint handler 注册
      .handle("goal", goalGet)
      .handle("goalSet", goalSet)
      .handle("goalClear", goalClear)
      // [local-smark] session preview handler 注册
      .handle("preview", preview as any)
      .handle("searchScan", searchScan as any)
  }),
)
