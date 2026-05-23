import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"

import { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import type { ToolPart, User, Assistant, TextPart, ReasoningPart } from "@opencode-ai/core/v1/session"
import { jsonSchema, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { mergeDeep } from "remeda"
import { PermissionReviewerPrompt } from "./prompt"
import { Assessment, ReviewerRequest } from "./schema"
import { PermissionReviewerTranscript } from "./transcript"
import type { PermissionAuto } from "../auto"

// #198：reviewer 不可用——服务已禁用，回退到用户审批
// #198：Disabled 是配置信号——approvals_reviewer 非 auto_review 时抛出，auto.ts 将其转为 ask
export class ReviewerDisabled extends Schema.TaggedErrorClass<ReviewerDisabled>()("PermissionReviewerDisabled", {}) {
  override get message() {
    return "auto reviewer is disabled"
  }
}

// #198：reviewer 回退到用户——fallback=user 时非 Disabled 错误转为此类型，由 auto.ts 回退到用户审批
// #198：FallbackToUser 保留原始错误原因——审计日志可追溯回退原因（超时、provider 错误等）
export class ReviewerFallbackToUser extends Schema.TaggedErrorClass<ReviewerFallbackToUser>()(
  "PermissionReviewerFallbackToUser",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

// #198：reviewer 超时——超过配置的 timeout_ms 后中断，fail closed
// #198：超时是可预期故障——provider 响应慢不应导致无限等待，超时后 deny 保持 fail-closed
export class ReviewerTimedOut extends Schema.TaggedErrorClass<ReviewerTimedOut>()("PermissionReviewerTimedOut", {}) {
  override get message() {
    return "auto reviewer timed out"
  }
}

// #198：reviewer 运行错误——provider 错误、schema 错误等非超时非禁用错误，fail closed
// #198：RunError 包装不可预期错误——provider API 故障、schema 验证失败等，统一为 fail-closed 信号
export class ReviewerRunError extends Schema.TaggedErrorClass<ReviewerRunError>()("PermissionReviewerRunError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export type Error = ReviewerDisabled | ReviewerFallbackToUser | ReviewerTimedOut | ReviewerRunError

export interface Interface extends PermissionAuto.Reviewer {}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionReviewer") {}

// #206：拉取比最终 reviewer prompt 更宽的最近窗口——transcript 选择再保留用户锚点并限制条目/字符，避免在权限路径遍历过旧会话
const REVIEWER_MESSAGE_FETCH_LIMIT = 120

// #209：合并 provider options 与 model.options——reviewer stream 需与正常 SessionPrompt 一致的 provider 适配
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    // #206：layer 内捕获 Database 服务——review 经 provideService 消化 page 的 DB 需求且不泄漏类型
    const database = yield* Database.Service
    // #208：Session.Service 已在 patch 206 保留——复用为 session 变量避免 Database.Service 泄漏
    const session = yield* Session.Service
    // #208：每父会话一个 Semaphore——并发工具审查复用同一 reviewer transcript
    const reviewerSessionLocks = new Map<SessionID, Semaphore.Semaphore>()

    const review: Interface["review"] = (input) =>
      // #209：streaming refactor——generateObject 替换为 streamText + permission_review_decision tool，让 reviewer 子会话留下可审计的推理与文本轨迹
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const permission = cfg.permission
        // #203：reviewerEnabled 统一判定——显式 user 禁用，显式 auto_review 启用，无配置时原生 Auto 隐式启用
        if (!reviewerEnabled(permission, input.metadata)) return yield* new ReviewerDisabled()
        const autoReview = permission?.auto_review

        const run = Effect.gen(function* () {
          const request = new ReviewerRequest({
            permission: input.permission,
            patterns: [...input.patterns],
            metadata: { ...input.metadata },
            precheck: input.precheck,
          })
          // #209：模型解析提前到 transcript 之前——streamText 需要具体 model 对象而非仅在 generateObject 调用点解析
          const model = autoReview?.model
            ? yield* provider.getModel(
                Provider.parseModel(autoReview.model).providerID,
                Provider.parseModel(autoReview.model).modelID,
                )
            : yield* Effect.gen(function* () {
                const current = yield* provider.defaultModel()
                return (
                  (yield* provider.getSmallModel(current.providerID)) ??
                  (yield* provider.getModel(current.providerID, current.modelID))
                )
              })
          // #208：获取或创建 reviewer 子会话——复用同一 transcript 追加请求/决策轮次
          const reviewerSession = input.sessionID ? yield* getReviewerSession(SessionID.make(input.sessionID), model) : undefined
          // #209：标记工具状态为 reviewing 并附带 reviewer 子会话 ID——UI 可导航到 reviewer 子会话查看完整推理
          yield* markToolReviewing(input, reviewerSession?.id)
          const tenantPolicy = yield* loadTenantPolicy(autoReview)
          // #206：transcript 收集双重有界——先拉 120 条宽窗口再由 transcript 选择保留用户锚点和截短条目
          // #206：page.more 表示获取窗口外还有更早消息（含 hidden 行的原始窗口探测）——hidden 挤占
          // #206：窗口时可见条目可能 ≤ENTRY_LIMIT，必须与 selectEntries 截短合并披露，否则 reviewer
          // #206：会把部分历史当作完整对话评估 user_authorization（page.more 语义合并）
          const transcript = input.sessionID
            ? yield* MessageV2.page({ sessionID: SessionID.make(input.sessionID), limit: REVIEWER_MESSAGE_FETCH_LIMIT }).pipe(
                // #206：provideService 在调用点消化 Database 需求——review 类型不泄漏 Database.Service
                Effect.provideService(Database.Service, database),
                Effect.map((page) => {
                  const transcript = PermissionReviewerTranscript.fromMessages(page.items)
                  // #206：窗口溢出与条目截短任一存在都置 truncated——省略标记是 reviewer 的缺失证据
                  return { ...transcript, truncated: transcript.truncated || page.more }
                }),
                // #206：失败时返回空 transcript 含 entryTruncated:false——保持 TranscriptDelta 新字段类型完整
                Effect.catch(() => Effect.succeed({ entries: [], truncated: false, entryTruncated: false })),
              )
            : { entries: [], truncated: false, entryTruncated: false }
          const messages = buildMessages({
            system: PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy),
            userItems: PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason),
          })
          // #209：在子会话中记录 reviewer 请求——metadata 标记防止被误认为人类授权，但保留可检查性
          const reviewerUser = reviewerSession
            ? yield* recordReviewerRequest({
                session: reviewerSession,
                model,
                text: renderReviewerPrompt(messages),
              })
            : undefined
          // #209：streamText + permission_review_decision tool——流式持久化 reasoning/text/tool part，替代一次性 generateObject 黑盒
          const assessment = yield* runReviewerAgent({
            session: reviewerSession,
            model,
            parentID: reviewerUser?.id,
            messages,
          }).pipe(
            // #198：超时控制——默认 90 秒，超时后返回 ReviewerTimedOut 而非等待不确定的 provider 响应
            Effect.timeoutOrElse({
              duration: `${autoReview?.timeout_ms ?? 90_000} millis`,
              orElse: () => Effect.fail(new ReviewerTimedOut()),
            }),
            // #198：mapError 将非 reviewer 错误包装为 RunError——provider/schema 错误统一为可处理的 fail-closed 信号
            Effect.mapError((error) =>
              isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }),
            ),
          )
          // #209：标记工具审查结果——allowed/denied 状态和 reviewer 评估详情写入工具 metadata 供 UI 渲染
          yield* markToolReviewed(input, assessment)

          return {
            action: assessment.outcome,
            reason: assessment.rationale,
            // #208：reviewID 由 auto.ts mint 后传入——不再在此处随机生成
            reviewID: input.reviewID,
            risk_level: assessment.risk_level,
            user_authorization: assessment.user_authorization,
          } satisfies PermissionAuto.ReviewDecision
        })

        // #209：错误时标记工具审查失败——fallback=user 标记 fallback_user，超时标记 timed_out，其他标记 failed，使 UI 能展示失败原因
        return yield* run.pipe(
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              yield* markToolReviewFailed(
                input,
                autoReview?.fallback === "user" && !(error instanceof ReviewerDisabled)
                  ? "fallback_user"
                  : error instanceof ReviewerTimedOut
                    ? "timed_out"
                    : "failed",
                errorMessage(error),
              )
              // 显式禁用沿用人工路由，其余失败仅按用户配置回退，默认仍拒绝执行。
              if (autoReview?.fallback === "user" && !(error instanceof ReviewerDisabled)) {
                return yield* new ReviewerFallbackToUser({ reason: errorMessage(error) })
              }
              return yield* Effect.fail(error)
            }),
          ),
        )
      })

    return Service.of({ review })

    // #208：获取或创建 reviewer 子会话——每父会话一个可复用的 permission-reviewer 子会话
    function getReviewerSession(parentID: SessionID, model: Provider.Model) {
      return reviewerSessionLock(parentID).withPermits(1)(Effect.gen(function* () {
        // #208：优先复用已有 permission-reviewer 子会话——每次审查创建新 transcript 会丢失前序请求/决策上下文
        const existing = (yield* session.children(parentID)).find((item) => item.agent === "permission-reviewer")
        if (existing) return existing
        // #208：单个子会话镜像 Codex guardian trunk——后续审查追加新请求/决策轮次
        return yield* session.create({
          parentID,
          title: "Auto permission review (@permission-reviewer subagent)",
          agent: "permission-reviewer",
          model: { providerID: model.providerID, id: model.id },
        })
      }))
    }

    function reviewerSessionLock(parentID: SessionID) {
      const existing = reviewerSessionLocks.get(parentID)
      if (existing) return existing
      // #208：get-or-create 非原子——每父会话锁保持并发工具审查复用同一 reviewer transcript
      const next = Semaphore.makeUnsafe(1)
      reviewerSessionLocks.set(parentID, next)
      return next
    }

    // #209：记录 reviewer 请求为可见用户消息——metadata 标记防止被误认为人类授权
    function recordReviewerRequest(input: { session: Session.Info; model: Provider.Model; text: string }) {
      return Effect.gen(function* () {
        const message = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.session.id,
          time: { created: Date.now() },
          agent: "permission-reviewer",
          model: { providerID: input.model.providerID, modelID: input.model.id },
        } satisfies User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: input.session.id,
          messageID: message.id,
          type: "text",
          // #209：metadata 标记替代 synthetic——reviewer 子会话请求 cell 可见但不可作为授权证据，transcript 投影据此排除
          metadata: { permissionReviewerRequest: true },
          text: input.text,
        } satisfies TextPart)
        return message
      })
    }

    // #209：runReviewerAgent——有子会话时持久化流式 part，无子会话时仅提取 assessment
    function runReviewerAgent(input: {
      session: Session.Info | undefined
      model: Provider.Model
      parentID: MessageID | undefined
      messages: readonly ModelMessage[]
    }) {
      const sessionInfo = input.session
      const parentID = input.parentID
      // #209：无子会话或无 parentID 时走纯流式提取——不持久化中间 part，仅从 tool-call 事件取出 assessment
      if (!sessionInfo || !parentID) return runReviewerStream(input.messages, input.model)
      return Effect.gen(function* () {
        // #209：先创建 assistant 消息壳——流式 part 挂载到该消息，错误时也能回填 error 字段
        const message: Assistant = {
          id: MessageID.ascending(),
          parentID,
          role: "assistant",
          mode: "permission-reviewer",
          agent: "permission-reviewer",
          path: { cwd: sessionInfo.directory, root: sessionInfo.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model.id,
          providerID: input.model.providerID,
          sessionID: sessionInfo.id,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(message)
        const assessment = yield* runReviewerStream(input.messages, input.model, {
          sessionID: sessionInfo.id,
          messageID: message.id,
        }).pipe(
          // #209：流式错误时仍持久化 assistant 消息的 error 字段——审计可见失败原因，而非丢失在内存中
          Effect.tapError((error) =>
            Effect.gen(function* () {
              message.error = MessageV2.fromError(error, { providerID: input.model.providerID })
              message.time.completed = Date.now()
              yield* session.updateMessage(message)
            }),
          ),
        )
        // #209：流结束后补全 finish 与 completed——tool-calls 标记决策工具已被调用
        message.finish = "tool-calls"
        message.time.completed = Date.now()
        yield* session.updateMessage(message)
        return assessment
      })
    }

    // #209：runReviewerStream——streamText + permission_review_decision tool，流式消费 fullStream 事件并逐 part 持久化
    function runReviewerStream(
      messages: readonly ModelMessage[],
      model: Provider.Model,
      persist?: { sessionID: SessionID; messageID: MessageID },
    ) {
      return Effect.acquireUseRelease(
        // #209：AbortController 在 release 时中止 streamText——Effect 取消/超时能立即停止 provider 流
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            const language = yield* provider.getLanguage(model)
            const providerInfo = yield* provider.getProvider(model.providerID)
            // #209：无 persist 时用固定标识——ProviderTransform.options 需要一个 sessionID 做 provider 适配键，无子会话时用常量避免空值
            const sessionID = persist?.sessionID ?? "permission-reviewer"
            // #209：合并 provider options 与 model.options——与 SessionPrompt 保持一致的 provider 适配，避免 reviewer 流缺少必要选项
            const options = mergeOptions(
              ProviderTransform.options({ model, sessionID, providerOptions: providerInfo.options }),
              model.options,
            )
            // #209：wrapLanguageModel 注入 message 归一化中间件——reviewer 流与 SessionPrompt 共享同一 provider 适配层
            const result = streamText({
              model: wrapLanguageModel({
                model: language,
                middleware: [
                  {
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream") {
                        // 与普通请求共用消息归一化，避免审查流跳过provider适配。
                        // @ts-expect-error AI SDK's internal prompt type is narrower than ModelMessage here.
                        args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
                      }
                      return args.params
                    },
                  },
                ],
              }),
              messages: [...messages],
              tools: {
                permission_review_decision: tool({
                  description: "Submit the structured allow/deny decision for this permission review.",
                  // #209：ToolJsonSchema.fromSchema 将 Effect Assessment schema 转为 AI SDK jsonSchema——替代原 generateObject 的双重 schema
                  inputSchema: jsonSchema(ToolJsonSchema.fromSchema(Assessment) as Parameters<typeof jsonSchema>[0]),
                  // #209：execute 返回 title/metadata/output——SDK 调用此函数但真正持久化在 tool-call 事件处理器中完成
                  execute: async (assessment) => ({
                    title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                    metadata: assessment,
                    output: JSON.stringify(assessment),
                  }),
                }),
              },
              // 部分兼容provider拒绝强制工具选择，缺失决策调用仍由下方拒绝。
              maxRetries: 0,
              providerOptions: ProviderTransform.providerOptions(model, options),
              maxOutputTokens: ProviderTransform.maxOutputTokens(model),
              abortSignal: abort.signal,
            })
            // #209：assessment 可变——由 tool-call 事件设置，流结束时检查是否为空决定 fail-closed
            let assessment: Schema.Schema.Type<typeof Assessment> | undefined
            // #209：textPart/reasoningPart 可变——跨 start/delta/end 事件保持引用以增量更新同一 part
            let textPart: TextPart | undefined
            let reasoningPart: ReasoningPart | undefined
            // #209：toolParts/toolInput 按 callID 索引——一个 tool-call 的 input-start/delta/end/call 共享同一 callID
            const toolParts = new Map<string, ToolPart>()
            const toolInput = new Map<string, string>()

            yield* Stream.runForEach(
              // #209：fullStream 聚合 reasoning/text/tool 全部事件——逐事件持久化使子会话 transcript 实时可审计
              Stream.fromAsyncIterable(result.fullStream, (error) => error),
              // #209：fnUntraced 避免每个 stream 事件创建 span——fullStream 事件高频，tracing 噪声远大于诊断价值
              Effect.fnUntraced(function* (event) {
                // #209：无 persist 时仅提取 assessment——不持久化中间 part，用于无子会话的纯判定路径
                if (!persist) {
                  if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                    assessment = Schema.decodeUnknownSync(Assessment)(event.input)
                  }
                  return
                }
                if (event.type === "reasoning-start") {
                  // #209：reasoning part 先建空壳——delta 事件增量更新 text，end 事件收尾时间
                  reasoningPart = yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "reasoning",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies ReasoningPart)
                  return
                }
                if (event.type === "reasoning-delta" && reasoningPart) {
                  // #209：增量追加 reasoning 文本——每次 delta 都 updatePart 使 UI 实时显示推理进度
                  reasoningPart.text += event.text
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* session.updatePart(reasoningPart)
                  return
                }
                if (event.type === "reasoning-end" && reasoningPart) {
                  reasoningPart.time = { ...reasoningPart.time, end: Date.now() }
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* session.updatePart(reasoningPart)
                  reasoningPart = undefined
                  return
                }
                if (event.type === "text-start") {
                  // #209：text part 与 reasoning 同样的 start/delta/end 三段式——保持与正常 assistant 消息一致的持久化形状
                  textPart = yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "text",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies TextPart)
                  return
                }
                if (event.type === "text-delta" && textPart) {
                  textPart.text += event.text
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* session.updatePart(textPart)
                  return
                }
                if (event.type === "text-end" && textPart) {
                  textPart.time = { start: textPart.time?.start ?? Date.now(), end: Date.now() }
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* session.updatePart(textPart)
                  textPart = undefined
                  return
                }
                if (event.type === "tool-input-start") {
                  // #209：工具输入先建 pending 壳——delta 缓冲到 toolInput Map，end 时回填 raw
                  const part = yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "tool",
                    callID: event.id,
                    tool: event.toolName,
                    state: { status: "pending", input: {}, raw: "" },
                  } satisfies ToolPart)
                  toolParts.set(event.id, part)
                  return
                }
                if (event.type === "tool-input-delta") {
                  // #209：缓冲工具输入 delta——不在每个 delta 持久化，避免高频写入，end 时一次性回填 raw
                  toolInput.set(event.id, (toolInput.get(event.id) ?? "") + event.delta)
                  return
                }
                if (event.type === "tool-input-end") {
                  const part = toolParts.get(event.id)
                  // #209：part 不存在或已非 pending 时跳过——tool-call 可能先于 tool-input-end 到达导致状态已 completed
                  if (!part || part.state.status !== "pending") return
                  const next = {
                    ...part,
                    state: { ...part.state, raw: toolInput.get(event.id) ?? "" },
                  } satisfies ToolPart
                  toolParts.set(event.id, yield* session.updatePart(next))
                  return
                }
                if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                  // #209：tool-call 携带最终 input——Schema.decode 验证并提取 assessment，同时把 tool part 标记 completed
                  assessment = Schema.decodeUnknownSync(Assessment)(event.input)
                  // #209：toolCallId 可能与 tool-input-start 的 event.id 不同——无 existing 时新建 part 壳
                  const existing = toolParts.get(event.toolCallId)
                  const part = yield* session.updatePart({
                    ...(existing ?? {
                      id: PartID.ascending(),
                      sessionID: persist.sessionID,
                      messageID: persist.messageID,
                      type: "tool" as const,
                      callID: event.toolCallId,
                      tool: event.toolName,
                    }),
                    state: {
                      status: "completed",
                      input: assessment,
                      title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                      metadata: assessment,
                      output: JSON.stringify(assessment),
                      time: { start: Date.now(), end: Date.now() },
                    },
                  } satisfies ToolPart)
                  toolParts.set(event.toolCallId, part)
                  return
                }
                if (event.type === "tool-error") {
                  // #209：工具执行错误转为 RunError——fail closed，不应让 provider 工具错误静默为 allow
                  return yield* new ReviewerRunError({ reason: errorMessage(event.error) })
                }
                if (event.type === "error") {
                  // #209：stream 级错误同样转为 RunError——保持单一 fail-closed 错误出口
                  return yield* new ReviewerRunError({ reason: errorMessage(event.error) })
                }
              }),
            )

            // #209：流结束后收尾未关闭的 text/reasoning part——provider 可能不发 *-end 事件，避免 part 残留无结束时间
            if (textPart)
              yield* session.updatePart({
                ...textPart,
                time: { start: textPart.time?.start ?? Date.now(), end: Date.now() },
              })
            if (reasoningPart)
              yield* session.updatePart({
                ...reasoningPart,
                time: { start: reasoningPart.time.start, end: Date.now() },
              })
            // #209：模型未调用 permission_review_decision——fail closed，未给出明确 allow 即拒绝
            if (!assessment)
              return yield* new ReviewerRunError({ reason: "reviewer did not call permission_review_decision" })
            return assessment
          }),
        // #209：release 时中止 AbortController——确保 Effect 取消时 streamText 立即停止，不再消耗 provider 配额
        (abort) => Effect.sync(() => abort.abort()),
      )
    }

    // #209：标记工具状态为 reviewing——附带 reviewer 子会话 ID 供 UI 导航
    function markToolReviewing(input: PermissionAuto.ReviewInput, reviewerSessionID: SessionID | undefined) {
      return updateToolAutoReview(input, {
        status: "reviewing",
        ...(reviewerSessionID ? { sessionID: reviewerSessionID } : {}),
      })
    }

    // #209：标记工具审查完成——allowed/denied 状态和 reviewer 评估详情
    function markToolReviewed(input: PermissionAuto.ReviewInput, assessment: Schema.Schema.Type<typeof Assessment>) {
      return updateToolAutoReview(input, {
        status: assessment.outcome === "allow" ? "allowed" : "denied",
        result: {
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
          rationale: assessment.rationale,
        },
      })
    }

    // #209：标记工具审查失败——timed_out/failed/fallback_user 状态和错误原因
    function markToolReviewFailed(
      input: PermissionAuto.ReviewInput,
      status: "timed_out" | "failed" | "fallback_user",
      reason: string,
    ) {
      return updateToolAutoReview(input, { status, error: reason })
    }

    // #209：统一更新工具 autoReview metadata——合并现有 metadata 与新 patch，保留 reviewID/precheck 等渐进字段
    function updateToolAutoReview(
      input: PermissionAuto.ReviewInput,
      patch: {
        status: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user"
        sessionID?: SessionID
        error?: string
        result?: {
          risk_level: Schema.Schema.Type<typeof Assessment>["risk_level"]
          user_authorization: Schema.Schema.Type<typeof Assessment>["user_authorization"]
          rationale: string
        }
      },
    ) {
      // 无工具绑定时不写UI标记；捕获绑定以保持异步闭包内的类型收窄。
      const sessionID = input.sessionID
      const tool = input.tool
      if (!sessionID || !tool) return Effect.void
      return Effect.gen(function* () {
        // #208：用 session.messages 替代 MessageV2.get——避免 Database.Service 泄漏到 review 类型
        const messages = yield* session.messages({ sessionID: SessionID.make(sessionID), limit: 50 })
        const message = messages.find((m) => m.info.id === tool.messageID)
        if (!message) return
        const part = message.parts.find(
          (item): item is ToolPart => item.type === "tool" && item.callID === tool.callID,
        )
        if (!part || (part.state.status !== "pending" && part.state.status !== "running")) return
        // #209：保留现有 autoReview metadata——reviewing → allowed/denied 渐进更新不覆盖已写入的 reviewID/precheck
        const metadata = part.state.status === "running" ? part.state.metadata : {}
        const current =
          metadata?.autoReview && typeof metadata.autoReview === "object" && !Array.isArray(metadata.autoReview)
            ? metadata.autoReview
            : {}
        yield* session.updatePart({
          ...part,
          state: {
            status: "running",
            input: part.state.status === "pending" ? { raw: part.state.raw } : part.state.input,
            // #209：title 随状态变化——reviewing 显示 precheck level，其余显示具体状态供 UI 区分
            title:
              patch.status === "reviewing" ? `Auto review: ${input.precheck.level}` : `Auto review: ${patch.status}`,
            metadata: {
              ...metadata,
              // #208：metadata 小而稳定——客户端可展示 precheck 交接而不渲染隐藏 reviewer prompt
              autoReview: {
                ...current,
                reviewID: input.reviewID,
                precheck: input.precheck,
                ...patch,
              },
            },
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now() },
          },
        } satisfies ToolPart)
      }).pipe(
        // #208：review 展示是 best-effort——过期工具引用不应将有效 reviewer 决策转为 fail-closed deny
        Effect.catch(() => Effect.void),
      )
    }
  }),
)

function buildMessages(input: { system: string; userItems: readonly PermissionReviewerPrompt.UserPromptItem[] }) {
  // #198：system 消息包含策略模板和输出合约——user 消息包含 transcript 和 approval request
  return [
    { role: "system", content: input.system },
    // #198：user 消息拼接所有 userItems——用双换行分隔 transcript、retry reason、planned action
    { role: "user", content: input.userItems.map((item) => item.text).join("\n\n") },
  ] satisfies ModelMessage[]
}

// #209：渲染 reviewer prompt 为可检查文本——子会话用户消息可见但不可作为授权证据
function renderReviewerPrompt(messages: readonly ModelMessage[]) {
  return messages
    .map((message) =>
      [
        `${message.role}:`,
        typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2),
      ].join("\n"),
    )
    .join("\n\n")
}

// #198：判断是否为 reviewer 自身错误——TimedOut 和 RunError 是可预期的运行时错误，其他错误向上传播
// #209：streaming refactor 后错误来源变为 streamText 的 fullStream 事件，但 RunError 仍是唯一可预期包装
function isReviewerError(error: unknown): error is Error {
  return error instanceof ReviewerTimedOut || error instanceof ReviewerRunError
}

// #203：reviewer 启用判定——显式配置优先：user 保留人工审批，auto_review 对所有 auto 规则启用。
// #203：无全局配置时原生 Auto agent 隐式启用 reviewer；否则选 Auto 只会把 cautious 降级成普通 ask
function reviewerEnabled(permission: ConfigPermissionV1.Info | undefined, metadata: Readonly<Record<string, unknown>>) {
  if (permission?.approvals_reviewer === "user") return false
  if (permission?.approvals_reviewer === "auto_review") return true
  return metadata.agent === "Auto"
}

// #198：提取错误消息——provider/model 错误在 reason 中暴露用于诊断，但 AutoDeniedError 仍阻止鼓励绕过策略的重试建议
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

// #198：加载租户策略——默认策略 + policy_path 文件 + policy 内联文本，三者拼接，空值过滤
// #198：策略来源优先级——DEFAULT_TENANT_POLICY 是基线，policy_path 和 policy 是追加覆盖
function loadTenantPolicy(autoReview: { policy?: string; policy_path?: string } | undefined) {
  return Effect.gen(function* () {
    // #198：policy_path 文件读取失败转为 RunError——策略加载失败不应静默回退到默认策略
    const pathPolicy = autoReview?.policy_path
      ? yield* Effect.promise(() => Bun.file(autoReview.policy_path!).text()).pipe(
          Effect.mapError((error) =>
            new ReviewerRunError({ reason: `failed to load auto_review.policy_path: ${String(error)}` }),
          ),
        )
      : ""
    // #198：三者拼接——默认策略 + 文件策略 + 内联策略，空值过滤后用双换行分隔
    return [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, pathPolicy, autoReview?.policy]
      .filter((item): item is string => Boolean(item?.trim()))
      .join("\n\n")
  })
}

export const defaultLayer = layer.pipe(
  Layer.provide(LayerNode.compile(Config.node)),
  Layer.provide(LayerNode.compile(Provider.node)),
)

// #203：Permission.defaultLayer 消费此 bundled reviewer 层来构建 Permission.Service。
// #203：Layer.suspend 保留历史循环边界：Session 导入 Permission 类型，故 Session.defaultLayer
// #203：不能在本模块初始化期间被解引用
export const defaultLayerWithSession = Layer.suspend(() => defaultLayer.pipe(Layer.provide(LayerNode.compile(Session.node))))

// #198：node deps 包含 Config/Provider/Session——reviewer layer yield 三个 service，Session 不导入 Permission 故无循环依赖
// #206：deps 补 Database.node——layer 捕获 db 供 page 溢出探测，仍不泄漏进 review 类型
export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, Provider.node, Session.node, Database.node] })

export * as PermissionReviewer from "./service"
