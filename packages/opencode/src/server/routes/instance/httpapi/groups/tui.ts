import { TuiEvent } from "@/cli/cmd/tui/event"
import { TuiRequest as TuiRequestPayload } from "@/server/shared/tui-control"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/tui"
export const CommandPayload = Schema.Struct({ command: Schema.String })
const EventTuiPromptAppend = Schema.Struct({
  type: Schema.Literal(TuiEvent.PromptAppend.type),
  properties: TuiEvent.PromptAppend.properties,
}).annotate({ identifier: "EventTuiPromptAppend" })
const EventTuiCommandExecute = Schema.Struct({
  type: Schema.Literal(TuiEvent.CommandExecute.type),
  properties: TuiEvent.CommandExecute.properties,
}).annotate({ identifier: "EventTuiCommandExecute" })
const EventTuiToastShow = Schema.Struct({
  type: Schema.Literal(TuiEvent.ToastShow.type),
  properties: TuiEvent.ToastShow.properties,
}).annotate({ identifier: "EventTuiToastShow" })
const EventTuiSessionSelect = Schema.Struct({
  type: Schema.Literal(TuiEvent.SessionSelect.type),
  properties: TuiEvent.SessionSelect.properties,
}).annotate({ identifier: "EventTuiSessionSelect" })
export const TuiPublishPayload = Schema.Union([
  EventTuiPromptAppend,
  EventTuiCommandExecute,
  EventTuiToastShow,
  EventTuiSessionSelect,
])
export const ProviderEndpointStatusQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  // TUI 传入 provider baseURL 的 origin。使用 query 而不是 body 是为了保持
  // sidebar 轮询为幂等 GET；WorkspaceRoutingQueryFields 继续允许远端 workspace
  // 中间件识别 directory/workspace 参数，不破坏既有 TUI 路由行为。
  url: Schema.String,
})
export const ProviderEndpointStatus = Schema.Struct({
  url: Schema.String,
  // HTTP 响应只暴露 ok/down：首次探测由 handler 等待完成，TUI 自己保留本地
  // init 显示态。wire schema 不包含 init，避免外部调用方误以为 daemon 会返回
  // 一个需要再次轮询解释的未完成状态。
  status: Schema.Literals(["ok", "down"]),
  latency: Schema.NullOr(Schema.Number),
  route: Schema.Struct({
    // 只暴露 direct/proxy，不返回具体 proxy URL，避免把可能包含凭据的代理
    // 地址通过 TUI/plugin API 泄漏出去。
    type: Schema.Literals(["direct", "proxy"]),
    reason: Schema.String,
  }),
  checkedAt: Schema.Number,
})

export const TuiPaths = {
  appendPrompt: `${root}/append-prompt`,
  openHelp: `${root}/open-help`,
  openSessions: `${root}/open-sessions`,
  openThemes: `${root}/open-themes`,
  openModels: `${root}/open-models`,
  submitPrompt: `${root}/submit-prompt`,
  clearPrompt: `${root}/clear-prompt`,
  executeCommand: `${root}/execute-command`,
  showToast: `${root}/show-toast`,
  publish: `${root}/publish`,
  selectSession: `${root}/select-session`,
  providerEndpointStatus: `${root}/provider-endpoint-status`,
  controlNext: `${root}/control/next`,
  controlResponse: `${root}/control/response`,
} as const

export const TuiApi = HttpApi.make("tui")
  .add(
    HttpApiGroup.make("tui")
      .add(
        HttpApiEndpoint.post("appendPrompt", TuiPaths.appendPrompt, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.PromptAppend.properties,
          success: described(Schema.Boolean, "Prompt processed successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.appendPrompt",
            summary: "Append TUI prompt",
            description: "Append prompt to the TUI.",
          }),
        ),
        HttpApiEndpoint.post("openHelp", TuiPaths.openHelp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Help dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openHelp",
            summary: "Open help dialog",
            description: "Open the help dialog in the TUI to display user assistance information.",
          }),
        ),
        HttpApiEndpoint.post("openSessions", TuiPaths.openSessions, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Session dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openSessions",
            summary: "Open sessions dialog",
            description: "Open the session dialog.",
          }),
        ),
        HttpApiEndpoint.post("openThemes", TuiPaths.openThemes, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Theme dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openThemes",
            summary: "Open themes dialog",
            description: "Open the theme dialog.",
          }),
        ),
        HttpApiEndpoint.post("openModels", TuiPaths.openModels, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Model dialog opened successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.openModels",
            summary: "Open models dialog",
            description: "Open the model dialog.",
          }),
        ),
        HttpApiEndpoint.post("submitPrompt", TuiPaths.submitPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Prompt submitted successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.submitPrompt",
            summary: "Submit TUI prompt",
            description: "Submit the prompt.",
          }),
        ),
        HttpApiEndpoint.post("clearPrompt", TuiPaths.clearPrompt, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Prompt cleared successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.clearPrompt",
            summary: "Clear TUI prompt",
            description: "Clear the prompt.",
          }),
        ),
        HttpApiEndpoint.post("executeCommand", TuiPaths.executeCommand, {
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(Schema.Boolean, "Command executed successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.executeCommand",
            summary: "Execute TUI command",
            description: "Execute a TUI command.",
          }),
        ),
        HttpApiEndpoint.post("showToast", TuiPaths.showToast, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.ToastShow.properties,
          success: described(Schema.Boolean, "Toast notification shown successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.showToast",
            summary: "Show TUI toast",
            description: "Show a toast notification in the TUI.",
          }),
        ),
        HttpApiEndpoint.post("publish", TuiPaths.publish, {
          query: WorkspaceRoutingQuery,
          payload: TuiPublishPayload,
          success: described(Schema.Boolean, "Event published successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.publish",
            summary: "Publish TUI event",
            description: "Publish a TUI event.",
          }),
        ),
        HttpApiEndpoint.post("selectSession", TuiPaths.selectSession, {
          query: WorkspaceRoutingQuery,
          payload: TuiEvent.SessionSelect.properties,
          success: described(Schema.Boolean, "Session selected successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.selectSession",
            summary: "Select session",
            description: "Navigate the TUI to display the specified session.",
          }),
        ),
        HttpApiEndpoint.get("providerEndpointStatus", TuiPaths.providerEndpointStatus, {
          query: ProviderEndpointStatusQuery,
          success: described(ProviderEndpointStatus, "Provider endpoint route and latency"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.providerEndpointStatus",
            summary: "Get provider endpoint status",
            // TUI 只上报当前 provider origin；daemon 在自己的进程环境里解析
            // proxy 并执行 HEAD 探测，保证多 TUI 复用同一 daemon 时显示和真实
            // provider 请求使用同一个网络来源。
            description: "Return daemon-owned proxy route and latency for a provider endpoint origin.",
          }),
        ),
        HttpApiEndpoint.get("controlNext", TuiPaths.controlNext, {
          query: WorkspaceRoutingQuery,
          success: described(TuiRequestPayload, "Next TUI request"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.next",
            summary: "Get next TUI request",
            description: "Retrieve the next TUI request from the queue for processing.",
          }),
        ),
        HttpApiEndpoint.post("controlResponse", TuiPaths.controlResponse, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Unknown,
          success: described(Schema.Boolean, "Response submitted successfully"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tui.control.response",
            summary: "Submit TUI response",
            description: "Submit a response to the TUI request queue to complete a pending request.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "tui", description: "Experimental HttpApi TUI routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
