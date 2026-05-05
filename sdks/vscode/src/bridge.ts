/**
 * HTTP bridge server for the opencode VS Code extension.
 *
 * Exposes notebook tool endpoints on `127.0.0.1:<random port>` so that
 * the opencode CLI daemon can invoke notebook operations without going
 * through Copilot's LM tool proxy (which adds confirmation dialogs and
 * strips binary output).
 *
 * Endpoints:
 *   GET  /health                – liveness check
 *   POST /notebook/summary      – notebook structure overview
 *   POST /notebook/source       – paginated virtual source text
 *   POST /notebook/run          – execute one cell or a cell-id range
 *   POST /notebook/edit         – insert/edit/delete cells
 *   POST /notebook/output       – artifact-first output export
 *   POST /notebook/cell-output  – alias for /notebook/output
 *   POST /notebook/env          – kernel/environment snapshot
 */
import * as http from "node:http"
import { isRecord, stringProp } from "./util"
import { notebookSummary } from "./notebook/summary"
import { notebookSource } from "./notebook/source"
import { runNotebook } from "./notebook/run"
import { editNotebook } from "./notebook/edit"
import { readNotebookCellOutput } from "./notebook/output"
import { notebookEnv } from "./notebook/env"
import { manifest, registerBridge, type RegistryHandle } from "./bridge-registry"

const BRIDGE_HOST = "127.0.0.1"

export type BridgeInfo = { port: number; token: string }

/** The active server instance — closed on extension deactivation. */
let server: http.Server | undefined
let registry: RegistryHandle | undefined

export async function closeBridge() {
  await registry?.dispose()
  registry = undefined
  server?.close()
  server = undefined
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * Starts the HTTP bridge server on a random port.
 * Returns the port and auth token for environment injection into the terminal.
 */
export async function startBridge(output: { appendLine(value: string): void }): Promise<BridgeInfo> {
  const { randomUUID } = await import("node:crypto")
  const id = randomUUID()
  const token = randomUUID()

  const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`)
    output.appendLine(`[bridge] ${request.method} ${url.pathname}`)

    try {
      if (!safeLocalRequest(request)) {
        return writeJson(response, 403, { ok: false, error: "Forbidden" })
      }

      // Health check — no auth required
      if (request.method === "GET" && url.pathname === "/health") {
        return writeJson(response, 200, { ok: true, service: "opencode-vscode-bridge" })
      }

      // All other endpoints require auth
      if (!authorized(request, url, token)) {
        return writeJson(response, 401, { ok: false, error: "Unauthorized" })
      }

      if (request.method === "GET" && url.pathname === "/manifest") {
        return writeJson(response, 200, manifest({ id, port: addressPort(httpServer), token: "<redacted>" }))
      }

      // Route to notebook handlers
      const result = await routeRequest(request.method ?? "", url.pathname, request, output)
      if (result !== undefined) {
        return writeJson(response, 200, result)
      }

      writeJson(response, 404, { ok: false, error: "Not found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[bridge] error: ${message}`)
      writeJson(response, 500, { ok: false, error: message })
    }
  })

  return await new Promise((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(0, BRIDGE_HOST, () => {
      server = httpServer
      const address = httpServer.address()
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve bridge server port"))
        return
      }

      const base = `http://${BRIDGE_HOST}:${address.port}`
      output.appendLine(`[bridge] listening on ${base}`)
      output.appendLine("[bridge] token <redacted>")
      for (const ep of ["health", "notebook/summary", "notebook/source", "notebook/run", "notebook/edit", "notebook/output", "notebook/env"]) {
        output.appendLine(`[bridge] ${ep.padEnd(20)} ${base}/${ep}`)
      }
      registerBridge({ id, port: address.port, token })
        .then((handle) => {
          registry = handle
          output.appendLine(`[bridge] registry ${handle.id}`)
          resolve({ port: address.port, token })
        })
        .catch(reject)
    })
  })
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function routeRequest(
  method: string,
  pathname: string,
  request: http.IncomingMessage,
  output: { appendLine(value: string): void },
) {
  if (method !== "POST") return undefined

  const body = await readJson(request)
  if (!isRecord(body)) {
    throw new Error("Expected JSON object body")
  }

  switch (pathname) {
    case "/notebook/summary": {
      const filePath = stringProp(body, "filePath")
      if (!filePath) throw new Error("filePath is required")
      return await notebookSummary(filePath)
    }

    case "/notebook/source":
      return await notebookSource(body)

    case "/notebook/run":
      return await runNotebook(body)

    case "/notebook/edit":
      return await editNotebook(body)

    case "/notebook/output":
    case "/notebook/cell-output": {
      const filePath = stringProp(body, "filePath")
      if (!filePath) throw new Error("filePath is required")
      const cellId = typeof body.cellId === "string" ? body.cellId : undefined
      output.appendLine(`[bridge] reading raw notebook output ${filePath} cellId=${cellId ?? "<auto>"}`)
      return await readNotebookCellOutput(filePath, undefined, cellId)
    }

    case "/notebook/env": {
      const filePath = stringProp(body, "filePath")
      if (!filePath) throw new Error("filePath is required")
      return await notebookEnv(filePath)
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authorized(request: http.IncomingMessage, url: URL, token: string) {
  void url
  return request.headers.authorization === `Bearer ${token}`
}

function safeLocalRequest(request: http.IncomingMessage) {
  if (request.headers.origin) return false
  const host = request.headers.host
  return !host || host.startsWith("127.0.0.1:") || host.startsWith("localhost:")
}

function addressPort(httpServer: http.Server) {
  const address = httpServer.address()
  if (!address || typeof address === "string") throw new Error("Bridge server port is not available")
  return address.port
}

function writeJson(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value, null, 2))
}

function readJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}
