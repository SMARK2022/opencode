export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Cause, Clock, Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import type { SessionGoal } from "../session/goal"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ToolSelection } from "./selection"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { formatExecutionNotice, formatLongExecutionNotice } from "../util/output-notice"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
  readonly goalTurn?: SessionGoal.GoalTurnContext
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset, selection?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  // 内部通知只接收本边界已经限幅的取消快照，不暴露 leaf 路径回调或第二个 executor。
  readonly settle: (input: ExecuteInput, onInterrupted?: (output: ToolOutputStore.BoundResult) => Effect.Effect<void>) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object, onInterrupted?: (output: ToolOutputStore.BoundResult) => Effect.Effect<void>) {
      const startedAt = yield* Clock.currentTimeMillis
      // canonical结算统一计时，叶子仍拥有授权与执行；不记录输入、输出和metadata。
      const timing = { source: "native", tool: input.call.name, sessionID: input.sessionID, messageID: input.assistantMessageID, callID: input.call.id }
      yield* Effect.logInfo("tool timing", { phase: "tool.start", ...timing })
      // 把暂存原文的清理绑定整个 settlement，而不是仅绑定成功返回路径。
      return yield* Effect.gen(function* () {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        // 保留对象身份，使get的快照可被同turn后续provider step中的mark消费。
        goalTurn: input.goalTurn,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      // 本地/MCP成功在同一限幅前收口；Bash自己装饰，日志计时不能替代模型反馈。
      const notice = input.call.name === "bash" ? undefined : formatLongExecutionNotice("tool", (yield* Clock.currentTimeMillis) - startedAt)
      const output = notice
        ? { ...pending.output, content: [
            // 空content原本由模型JSON投影承载，追加提示之前保留同一实际结果。
            ...(pending.output.content.length ? pending.output.content : ToolOutput.fromResultValue({ type: "text", value: pending.output.structured })!.content),
            { type: "text" as const, text: notice },
          ] }
        : pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
      }).pipe(
        Effect.onExit((exit) => Effect.gen(function* () {
          if (exit._tag !== "Failure" || !Cause.hasInterruptsOnly(exit.cause) || !onInterrupted) return
          const identity = { sessionID: input.sessionID, toolCallID: input.call.id }
          const output = yield* resources.interrupted(identity)
          // 新调用即使没有partial也交付取消耗时；只写Progress，后续仍Failed并传播原Cause。
          const interrupted = input.call.name === "bash" && output ? output : {
            ...output,
            structured: output?.structured,
            content: [...(output?.content ?? []), { type: "text" as const, text: formatExecutionNotice({ source: "tool", severity: "warning", reason: "user_abort", elapsed_ms: Math.max(0, Math.floor((yield* Clock.currentTimeMillis) - startedAt)) }) }],
          }
          // 同一 bound 移交原文所有权后才能通知；存储/持久化失败不能改写成成功。
          const bounded = yield* resources.bound({ ...identity, output: interrupted })
          yield* onInterrupted(bounded)
        })),
        Effect.ensuring(resources.discard({ sessionID: input.sessionID, toolCallID: input.call.id })),
        // 模型可见的error结果也记失败，真实失败/中断仍原样传播，不做catch-and-success。
        Effect.onExit((exit) => Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.logInfo("tool timing", {
          phase: "tool.end", ...timing,
          status: exit._tag === "Success" && exit.value.result.type !== "error" ? "completed" : "error",
          durationMs: now - startedAt,
        })),
        )),
      )
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = [], selection = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        // 同一快照同时约束广告与settlement，关闭工具不能通过伪造调用绕回执行。
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions) || !ToolSelection.enabled(name, selection)) registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input, onInterrupted) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity, onInterrupted)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
