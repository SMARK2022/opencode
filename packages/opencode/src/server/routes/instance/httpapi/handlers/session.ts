import * as InstanceState from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRequestUsage } from "@/session/request-usage"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RequestUsageQuery,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import * as SessionError from "./session-errors"

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const requestUsage = yield* SessionRequestUsage.Service
    const summary = yield* SessionSummary.Service
    const bus = yield* Bus.Service
    const store = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    const sessionExecutionContext = Effect.fn("SessionHttpApi.sessionExecutionContext")(function* (sessionID: SessionID) {
      const info = yield* session.get(sessionID).pipe(Effect.mapError(() => new HttpApiError.NotFound({})))
      return {
        instance: yield* store.load({ directory: info.directory }),
        workspace: yield* InstanceState.workspaceID,
      }
    })

    const inSessionDirectory = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const execution = yield* sessionExecutionContext(sessionID)
        return yield* effect.pipe(
          Effect.provideService(InstanceRef, execution.instance),
          Effect.provideService(WorkspaceRef, execution.workspace),
        )
      })

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
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

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const requestUsageList = Effect.fn("SessionHttpApi.requestUsageList")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof RequestUsageQuery.Type
    }) {
      return yield* requestUsage.list({
        sessionID: ctx.params.sessionID,
        limit: ctx.query.limit,
        before: ctx.query.before,
        rootRequestID: ctx.query.rootRequestID,
        source: ctx.query.source as SessionRequestUsage.Source | undefined,
      })
    })

    const requestUsageGet = Effect.fn("SessionHttpApi.requestUsageGet")(function* (ctx: {
      params: { sessionID: SessionID; requestID: MessageID }
    }) {
      const result = yield* requestUsage.get(ctx.params)
      if (result) return result
      return yield* new HttpApiError.NotFound({})
    })

    const requestUsageAssistants = Effect.fn("SessionHttpApi.requestUsageAssistants")(function* (ctx: {
      params: { sessionID: SessionID; requestID: MessageID }
    }) {
      return yield* requestUsage.assistants(ctx.params)
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
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* session.messages({ sessionID: ctx.params.sessionID })
      }

      const page = MessageV2.page({
        sessionID: ctx.params.sessionID,
        limit: ctx.query.limit,
        before: ctx.query.before,
      })
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
        Effect.try({
          try: () => MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
          catch: (error) => error,
        }).pipe(Effect.catch((error) => (NotFoundError.isInstance(error) ? Effect.fail(error) : Effect.die(error)))),
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

      const json = yield* Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => new HttpApiError.BadRequest({}),
      })
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
      const current = yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
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
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID }),
      )
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* session.get(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.NotFound({})))
      // Session runners are stored per instance directory. Route abort through
      // the session's own directory so a differently-normalized TUI request can
      // still interrupt the run that created the session.
      yield* store.provide({ directory: info.directory }, promptSvc.cancel(ctx.params.sessionID))
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* inSessionDirectory(
        ctx.params.sessionID,
        promptSvc.command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        }),
      )
      return true
    })

    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* shareSvc.unshare(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      const info = yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      const execution = {
        instance: yield* store.load({ directory: info.directory }),
        workspace: yield* InstanceState.workspaceID,
      }
      yield* Effect.gen(function* () {
        yield* revertSvc.cleanup(info)
        const messages = yield* session.messages({ sessionID: ctx.params.sessionID })
        const defaultAgent = yield* agentSvc.defaultAgent()
        const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

        yield* compactSvc.create({
          sessionID: ctx.params.sessionID,
          agent: currentAgent,
          model: {
            providerID: ctx.payload.providerID,
            modelID: ctx.payload.modelID,
          },
          auto: ctx.payload.auto ?? false,
        })
        yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      }).pipe(
        Effect.provideService(InstanceRef, execution.instance),
        Effect.provideService(WorkspaceRef, execution.workspace),
      )
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const execution = yield* sessionExecutionContext(ctx.params.sessionID)
      return HttpServerResponse.stream(
        Stream.fromEffect(
          promptSvc
            .prompt({
              ...ctx.payload,
              sessionID: ctx.params.sessionID,
            })
            .pipe(
              Effect.provideService(InstanceRef, execution.instance),
              Effect.provideService(WorkspaceRef, execution.workspace),
            ),
        ).pipe(
          Stream.map((message) => JSON.stringify(message)),
          Stream.encodeText,
        ),
        { contentType: "application/json" },
      )
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* inSessionDirectory(
        ctx.params.sessionID,
        promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
              yield* bus.publish(Session.Event.Error, {
                sessionID: ctx.params.sessionID,
                error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            }),
          ),
        ),
      ).pipe(
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        promptSvc.command({ ...ctx.payload, sessionID: ctx.params.sessionID }),
      )
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      return yield* inSessionDirectory(
        ctx.params.sessionID,
        promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }),
      )
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      return yield* revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload })
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* revertSvc.unrevert({ sessionID: ctx.params.sessionID })
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response })
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* runState.assertNotBusy(ctx.params.sessionID)
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof MessageV2.Part.Type
    }) {
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        throw new Error(
          `Part mismatch: body.id='${payload.id}' vs partID='${ctx.params.partID}', body.messageID='${payload.messageID}' vs messageID='${ctx.params.messageID}', body.sessionID='${payload.sessionID}' vs sessionID='${ctx.params.sessionID}'`,
        )
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("requestUsageList", requestUsageList)
      .handle("requestUsageGet", requestUsageGet)
      .handle("requestUsageAssistants", requestUsageAssistants)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handle("fork", fork)
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
  }),
)
