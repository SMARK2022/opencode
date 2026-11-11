import { SessionListing } from "@opencode-ai/core/session/listing"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { columns, selection, withRequests } from "@opencode-ai/core/session/info"
import { RequestUsage } from "@opencode-ai/schema/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@opencode-ai/llm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV2 } from "@opencode-ai/core/session"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { locationServiceMapLayer } from "@opencode-ai/core/location-services"

import { NotFoundError, Storage } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageV2 } from "./message-v2"
// #0500：diff 聚合的唯一 DB 权威在 SummaryCache——session.diff 只是镜像写出与读取 seam。
import { SummaryCache } from "./summary-cache"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { Global } from "@opencode-ai/core/global"
import { SessionPath } from "@opencode-ai/core/session/path"
// #132：Windows 全局 path 规范化
import { Effect, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optional } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { createDefaultTitle, isDefaultTitle } from "./title"
import { searchCondition, type SearchMode } from "./search"
// #113：兼容 Session.isDefaultTitle 导出名
export { isDefaultTitle }

// 公共映射不要求摘要恢复正文，避免后续迁移为了补齐类型而重新使用 SELECT *。
type SessionRow = Omit<typeof SessionTable.$inferSelect, "summary_seed"> & { request?: RequestUsage }

export function fromRow(row: SessionRow): Info {
  return SessionV1.fromRow(row)
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert
      ? {
          messageID: SessionMessage.ID.make(info.revert.messageID),
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
          diff: info.revert.diff,
          revertedPaths: info.revert.revertedPaths,
        }
      : null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

function sessionPath(worktree: string, cwd: string) {
  // #132：create/fork 写路径必须走 SessionPath.relative（Win 全局保留盘符）
  return SessionPath.relative(worktree, cwd)
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(Snapshot.FileDiff)),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optional(NonNegativeInt),
  archived: optional(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
  // 被 revert 的工具触碰文件列表（绝对路径），供 restore 精确恢复；
  // 与 schema 包 Revert.State.revertedPaths 对应，旧数据缺省时整目录恢复。
  revertedPaths: optional(Schema.Array(Schema.String)),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optional(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optional(WorkspaceV2.ID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  summary: optional(Summary),
  cost: optional(Schema.Finite),
  tokens: optional(Tokens),
  // 旧 HTTP 返回请求投影；全量 tokens 不改变语义，也不缩到请求范围。
  request: optional(RequestUsage),
  share: optional(Share),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model),
  version: Schema.String,
  metadata: optional(Metadata),
  time: Time,
  permission: optional(PermissionV1.Ruleset),
  revert: optional(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optional(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  /** title：首屏子集；all（默认）：完整 title∨content，兼容旧客户端 */
  searchMode?: SearchMode
  limit?: number
}

export type SearchScanInput = ListInput & {
  search: string
  cursor?: { time_updated: number; id: string }
  /** 候选窗口大小，默认 50 */
  batch?: number
}

export type SearchScanResult = {
  sessions: Info[]
  nextCursor: { time_updated: number; id: string } | null
  done: boolean
}

export type GlobalListInput = {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

export const Event = {
  Created: SessionV1.Event.Created,
  Forked: SessionV1.Event.Forked,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: SessionV1.Event.Diff,
  Error: SessionV1.Event.Error,
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const finite = (value: number) => (Number.isFinite(value) ? value : 0)
  const safe = (value: number) => Math.max(0, finite(value))
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  return {
    cost:
      typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
        ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
        : safe(
            new Decimal(0)
              .add(new Decimal(tokens.input).mul(finite(costInfo?.input ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.output).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.cache.read).mul(finite(costInfo?.cache?.read ?? 0)).div(1_000_000))
              .add(new Decimal(tokens.cache.write).mul(finite(costInfo?.cache?.write ?? 0)).div(1_000_000))
              // TODO: update models.dev to have better pricing model, for now:
              // charge reasoning tokens at the same rate as output tokens
              .add(new Decimal(tokens.reasoning).mul(finite(costInfo?.output ?? 0)).div(1_000_000))
              .toNumber(),
          ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  /** progressive B2：同 list 宇宙 keyset 扫候选，完整 searchCondition 过滤命中 */
  readonly searchScan: (input: SearchScanInput) => Effect.Effect<SearchScanResult>
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    workspaceID?: WorkspaceV2.ID
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly setAgentModel: (input: {
    sessionID: SessionID
    agent: string
    model: NonNullable<Info["model"]>
    time: number
  }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  // fromMessageID：尾部裁剪读取（0393 revert messages 裁剪优化）
  readonly messages: (input: { sessionID: SessionID; limit?: number; fromMessageID?: MessageID; includeHidden?: boolean }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  // active 只由取消路径提供；普通列表仍返回全部子会话，活动后代的空闲祖先也不会被跳过。
  readonly children: (parentID: SessionID, active?: readonly string[]) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  // #0500：summaryOnly 更新入口——只改派生 per-user diffs，不触发 aggregate 失效。
  readonly updateMessageSummary: (msg: SessionV1.User) => Effect.Effect<SessionV1.User>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    includeHidden?: boolean
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  readonly publishPartProgress: (part: SessionV1.ToolPart) => Effect.Effect<void>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  // #493：predicate 只接收 HotInfo 热字段——扫描不得为冷存的 tool/reasoning payload 预热；匹配项才 hydrate。
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (info: MessageV2.HotInfo) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | RuntimeFlags.Service | Database.Service | EventV2Bridge.Service | Storage.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, sync } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const storage = yield* Storage.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      // 默认标题与 created 必须共用一次时钟读取，标题生成才能精确识别本 Session 的 root fallback。
      const created = Date.now()
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? createDefaultTitle(!!input.parentID, created),
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created,
          updated: Date.now(),
        },
      }
      yield* Effect.logInfo("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db.select(selection(id)).from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(database, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        // #143：worktree 供 directoryMatchesPath
        worktree: ctx.worktree,
        ...input,
      })
    })

    // B2 服务入口：与 list 同 Instance project/worktree，复用 listUniverseConditions
    // ctx.worktree 参与 directoryMatchesPath 判定——scan 候选宇宙与 list 逐字一致。
    const searchScan = Effect.fn("Session.searchScan")(function* (input: SearchScanInput) {
      const ctx = yield* InstanceState.context
      return yield* searchScanByProject(database, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        worktree: ctx.worktree,
        ...input,
      })
    })

    const listGlobal = Effect.fn("Session.listGlobal")(function* (input?: GlobalListInput) {
      const conditions: SQL[] = []
      if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
      if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
      if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
      if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
      if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))
      const search = input?.search
      // #121：全局列表——标题或消息内容
      if (search) {
        // archived与cursor先限定本次宇宙，冷正文也预约同一连接。
        const condition = yield* Database.withSync(database, (sync) =>
          searchCondition(sync, search, { roots: input?.roots, scope: and(...conditions) }),
        )
        if (condition) conditions.push(condition)
      }

      const query =
        conditions.length > 0
          ? db
              // 两条列表分支都只取公共列，不能在条件查询中重新搬运内部摘要 seed。
              .select(columns)
              .from(SessionTable)
              .where(and(...conditions))
          // 先固定页面，再绑定每条身份读取完整请求，避免相关CTE反复展开。
          : db.select(columns).from(SessionTable)
      const rows = yield* db.transaction(() => query
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 100)
        .all()
        .pipe(Effect.flatMap((rows) => withRequests(db, rows))),
      ).pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = new Map<string, ProjectInfo>()
      if (ids.length > 0) {
        const items = yield* db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const item of items) {
          projects.set(item.id, {
            id: item.id,
            name: item.name ?? undefined,
            worktree: item.worktree,
          })
        }
      }
      return rows.map((row) => ({ ...fromRow(row), project: projects.get(row.project_id) ?? null }))
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID, active?: readonly string[]) {
      if (active?.length === 0) return []
      // 从活动身份向上追溯，查询规模随活动链深度增长，不遍历全部已结束后代。
      const rows = yield* db.transaction(() => db
        // 子代理独立 Session 使用自己的请求投影，不继承父请求费用。
        .select(columns)
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID), active && sql`${SessionTable.id} in (
          with recursive active_tree(id, parent_id) as (
            select id, parent_id from ${SessionTable} where id in (${sql.join(active.map(id => sql`${id}`), sql`, `)})
            union
            select s.id, s.parent_id from ${SessionTable} s join active_tree a on s.id = a.parent_id
          ) select id from active_tree
        )`))
        .all()
        .pipe(Effect.flatMap((rows) => withRequests(db, rows))),
      ).pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      // `remove` needs to work in all cases, such as broken sessions that
      // run cleanup without instance state.
      const hasInstance = yield* InstanceState.directory.pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      )

      if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
      const kids = yield* children(sessionID)
      for (const child of kids) {
        yield* remove(child.id)
      }

      // #493：cold release 与删除失败必须向上传播——静默吞错会留下违反引用计数不变式的库。
      yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
      yield* events.remove(sessionID)
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: msg.sessionID, info: msg })
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updateMessageSummary = Effect.fn("Session.updateMessageSummary")(function* (msg: SessionV1.User) {
      // #0500：summaryOnly 标记让 projector 跳过 aggregate 失效——diffs 是派生 metadata。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: msg.sessionID, info: msg, summaryOnly: true })
      return msg
    })

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    // 进度快照只广播不落盘：PartProgress 事件未注册 durable manifest，
    // 发布端借此把工具输出推进的磁盘写入从每次 tick 降频到 1s 一写。
    const publishPartProgress = (part: SessionV1.ToolPart): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* events.publish(SessionV1.Event.PartProgress, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
      }).pipe(Effect.withSpan("Session.publishPartProgress"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
            // 单Part读取先约束父子可见性；内部终态写者才能显式选择raw。
            input.includeHidden ? undefined : sql`json_type(${PartTable.data}, '$.hidden') is null`,
            input.includeHidden ? undefined : sql`exists (
              select 1 from ${MessageTable} where ${MessageTable.id} = ${PartTable.message_id}
              and ${MessageTable.session_id} = ${PartTable.session_id}
              and json_type(${MessageTable.data}, '$.hidden') is null
            )`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      // #493：direct read 与批量 hydrate 共享 cold-aware decoder——corruption 必须失败而不是返回占位。
      return yield* Database.withSync(database, () => MessageV2.decodePartRow(sync, row))
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      workspaceID?: WorkspaceV2.ID
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      // #493：复用 layer 内已解构的 database 服务——避免新增 Effect R 依赖泄漏到 Interface。
      const { sync } = database
      // 显式 fork 边界缺失须在创建子会话前失败，raw 读取仍占用同一预留连接。
      const raw = yield* Database.withSync(database, () => MessageV2.rawForkRows(sync, { sessionID: input.sessionID, messageID: input.messageID }))
      if (raw.missing) return yield* Effect.fail(new NotFoundError({ message: `Message not found: ${input.messageID}` }))
      const session = yield* createNext({
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        workspaceID: original.workspaceID,
        title,
        metadata: structuredClone(original.metadata),
      })
      // #493：source→target 映射在业务 owner 生成，projector 只消费确定映射；父子 ID 永不共享。
      // raw rows 不经过 Message decoder，cold prefix 不会因 fork 被预热后重新压缩。
      const messageMap = raw.messages.map((row) => ({ sourceID: row.id, targetID: MessageID.ascending() }))
      const partMap = raw.parts.map((row) => ({ sourceID: row.id, targetID: PartID.ascending() }))
      yield* events
        .publish(Event.Forked, {
          sourceSessionID: input.sessionID,
          targetSessionID: session.id,
          messageMap,
          partMap,
        })
        .pipe(
          // #493：target session 已创建；clone 事务拒绝时删除空 target，不留用户可见 orphan。
          // 清理只处理本次新建 session，不回退到 hydrate-and-copy 的第二条成功路径。
          Effect.tapError(() => remove(session.id)),
        )
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      yield* patch(input.sessionID, { metadata: input.metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setAgentModel = Effect.fn("Session.setAgentModel")(function* (input: {
      sessionID: SessionID
      agent: string
      model: NonNullable<Info["model"]>
      time: number
    }) {
      yield* patch(input.sessionID, {
        agent: input.agent,
        model: input.model,
        time: { updated: input.time },
      }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      // #0500：DB 权威聚合经 SummaryCache 读取；外部 session_diff 只作兼容镜像同步写出。
      const result = SummaryCache.normalizeDiffPaths(yield* SummaryCache.load({ sessionID, storage }).pipe(Effect.provideService(Database.Service, database)))
      yield* storage.write(["session_diff", sessionID], result).pipe(Effect.ignore)
      return result
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      // #493：0 是显式有界空范围而非“未提供”——退化为全量会在 cold session 上触发无意义持久预热。
      if (input.limit !== undefined) {
        // #106：过滤下沉到 MessageV2.page，避免 limit 路径双重 filter
        return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit, fromMessageID: input.fromMessageID, includeHidden: input.includeHidden }).pipe(
          Effect.provideService(Database.Service, database),
        )).items
      }

      // 无 limit 复用 stream 的隐藏过滤；先确认会话，保留公开列表的 NotFound 语义。
      yield* get(input.sessionID)
      // 把边界交给既有分页查询，不能全量hydrate后再作内存过滤。
      const newestFirst = yield* MessageV2.stream(input.sessionID, { fromMessageID: input.fromMessageID, includeHidden: input.includeHidden }).pipe(
        Effect.provideService(Database.Service, database),
      )
      // stream 为 newest-first；Session.messages 契约为 chronological oldest-first
      return newestFirst.slice().reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      // #493：热扫描代理到 findHot——每页只构造 HotInfo，冷 owner 不变；首个匹配才完整 hydrate。
      return yield* MessageV2.findHot({ sessionID, predicate }).pipe(Effect.provideService(Database.Service, database))
    })

    return Service.of({
      list,
      searchScan,
      listGlobal,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setMetadata,
      setAgentModel,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      updateMessageSummary,
      removeMessage,
      removePart,
      updatePart,
      publishPartProgress,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function* listByProject(
  database: Database.Interface,
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
    worktree: string
  },
) {
  // #544：scope/start 谓词与 searchScan 共用 listUniverseConditions，避免 path 语义分叉
  // searchMode 只作用于 list——缺省 all 与历史行为逐字一致，旧客户端零感知。
  const conditions = listUniverseConditions(input)
  const search = input.search
  // #121：项目列表——空白 search 不注入条件
  if (search) {
    // roots/title保持零解压，完整搜索只恢复当前候选范围的子正文。
    const condition = yield* Database.withSync(database, (sync) =>
      searchCondition(sync, search, { mode: input.searchMode ?? "all", roots: input.roots, scope: and(...conditions) }),
    )
    if (condition) conditions.push(condition)
  }

  const limit = input.limit ?? 100

  // 页面与请求保持同一读快照，后台更新不能在两段读取间拼出混合版本。
  return yield* database.db.transaction(() => database.db
    // 列表先取公共信息，再补权威请求统计；大 seed 只由摘要存储模块读取。
    .select(columns)
    .from(SessionTable)
    // #228：home 切换查询故意无 project/path 谓词——undefined 表示无 WHERE，只保留 start/search/roots 过滤
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // 与scan的keyset完全同序，同毫秒更新的top-400也保持一致。
    .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
    .limit(limit)
    .all()
    .pipe(
      Effect.flatMap((rows) => withRequests(database.db, rows)),
      Effect.map((rows) => rows.map(fromRow)),
    ),
  ).pipe(Effect.orDie)
}

/**
 * #544 progressive B2 核心实现。
 * - 候选窗固定 batch 行，推进 recency 宇宙（非 browse 缓存）
 * - 命中用完整 searchCondition(mode=all)，保证 multi-token 跨字段 AND
 * - nextCursor 落在候选页最后一行，即使该行未命中也要推进，避免死循环
 * - done=true 当候选页不足 batch，表示宇宙耗尽
 */
function* searchScanByProject(
  database: Database.Interface,
  input: SearchScanInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
    worktree: string
  },
) {
  // batch 上限 100 防止单次扫过大 JSON；默认 50 对齐 TUI CONTENT_BATCH
  // clamp 而非拒绝：payload schema 已限 1-100，这里兜底服务内直调的越界值。
  const batch = Math.min(Math.max(input.batch ?? 50, 1), 100)
  // 候选页：与 list 同 scope/start，故意不含 search，保证每批固定扫 N 行候选
  // 候选宇宙显式重建而非复用调用方 conditions：scan 不得携带 search 谓词。
  const universe = listUniverseConditions({
    projectID: input.projectID,
    experimentalWorkspaces: input.experimentalWorkspaces,
    worktree: input.worktree,
    directory: input.directory,
    scope: input.scope,
    path: input.path,
    workspaceID: input.workspaceID,
    roots: input.roots,
    start: input.start,
  })
  if (input.cursor) {
    // keyset：time_updated DESC, id DESC 的下一页（id 用 sql 比较避免 brand 与 string 过载冲突）
    // 二元组比较与 orderBy 严格同序——错序会让翻页漏行或重复。
    universe.push(
      or(
        lt(SessionTable.time_updated, input.cursor.time_updated),
        and(
          eq(SessionTable.time_updated, input.cursor.time_updated),
          sql`${SessionTable.id} < ${input.cursor.id}`,
        ),
      )!,
    )
  }

  const page = yield* database.db
    // 候选页只用于 ID 过滤和分页；命中后才读取公共会话信息。
    .select({ id: SessionTable.id, time_updated: SessionTable.time_updated })
    .from(SessionTable)
    .where(universe.length > 0 ? and(...universe) : undefined)
    .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
    .limit(batch)
    .all()
    .pipe(Effect.orDie)
  // 空页即宇宙耗尽：nextCursor=null 让 TUI 端的 done 短路，不再发起下一批。
  if (page.length === 0) return { sessions: [], nextCursor: null, done: true }

  // 第二段 SQL：在候选 id 集合上施加完整 searchCondition（title∨content AND）
  // 与「先 search 再 limit 50 命中」不同：这里保证每页固定推进 50 候选
  // 固定 all：complete 召回不得被首屏 title 子集口径污染（INV-09 的服务端锚点）。
  const ids = page.map((row) => row.id)
  // 冷匹配只检查固定候选页，未命中的满页仍按既有cursor推进。
  const full = yield* Database.withSync(database, (sync) =>
    searchCondition(sync, input.search, { mode: "all", roots: input.roots, scope: inArray(SessionTable.id, ids) }),
  )
  // 命中集合走第二段 SQL 按候选 ID 收窄，再读取与普通列表一致的公共列。
  const matched = yield* database.db.transaction(() => database.db
    .select(columns)
    .from(SessionTable)
    .where(and(inArray(SessionTable.id, ids), full))
    .all()
    .pipe(Effect.flatMap((rows) => withRequests(database.db, rows))),
  ).pipe(Effect.orDie)
  // 命中行保留同一请求投影，输出仍按候选页排序而非第二次SQL的返回顺序。
  const byID = new Map(matched.map((row) => [row.id, row]))
  const sessions = page.flatMap((row) => {
    const match = byID.get(row.id)
    return match ? [fromRow(match)] : []
  })
  const last = page[page.length - 1]!
  // done 判定只看候选页是否填满：命中为 0 的满页仍要继续翻，直到宇宙耗尽。
  const done = page.length < batch
  const nextCursor = done ? null : { time_updated: last.time_updated, id: last.id }
  return { sessions, nextCursor, done }
}

/**
 * #544：list / searchScan 共用的 scope+start 谓词（不含 search）。
 * 故意与 listByProject 历史 path 语义逐字对齐（#143/#228 注释原样保留）：home 切换放宽、
 * directory fallback、global path 并集。searchScan 必须复用此函数，禁止另写 browse 缓存宇宙。
 */
function listUniverseConditions(
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
    worktree: string
  },
): SQL[] {
  const conditions: ReturnType<typeof eq>[] = []

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    // 已定义的空根也使用共享相关查询，不能被真值判断吞掉。
    const condition = SessionListing.related({ projectID: input.projectID, worktree: input.worktree, path: input.path, directory: input.directory, home: input.scope !== "project" ? Global.Path.home : undefined })
    if (condition) conditions.push(condition)
  } else {
    conditions.push(eq(SessionTable.project_id, input.projectID))
    if (input.scope !== "project" && input.directory) conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }

  return conditions
}
export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, RuntimeFlags.node, Database.node, EventV2Bridge.node, Storage.node],
})

export * as Session from "./session"
