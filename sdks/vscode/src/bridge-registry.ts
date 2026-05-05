import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"

const HOST = "127.0.0.1"
const HEARTBEAT_MS = 5_000

export type RegistryHandle = {
  id: string
  dispose(): Promise<void>
}

type RegistryInput = {
  id: string
  port: number
  token: string
  createdAt?: number
}

export async function registerBridge(input: RegistryInput): Promise<RegistryHandle> {
  const dir = registryDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)

  const file = path.join(dir, `${input.id}.json`)
  const createdAt = Date.now()
  const write = () => writeRegistryFile(file, manifest({ ...input, createdAt }))
  await write()
  const timer = setInterval(() => void write(), HEARTBEAT_MS)

  return {
    id: input.id,
    async dispose() {
      clearInterval(timer)
      await fs.unlink(file).catch((error) => {
        if (error?.code !== "ENOENT") throw error
      })
    },
  }
}

export function registryDir() {
  return process.env.OPENCODE_IDE_REGISTRY_DIR ?? path.join(xdgStateHome(), "opencode", "ide")
}

export function manifest(input: RegistryInput) {
  const now = Date.now()
  return {
    schema: 1,
    id: input.id,
    pid: process.pid,
    port: input.port,
    token: input.token,
    host: HOST,
    transport: "http",
    ideName: vscode.env.appName,
    ideKind: "vscode",
    remoteName: vscode.env.remoteName ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      uri: folder.uri.toString(),
      fsPath: folder.uri.fsPath,
    })),
    active: {
      textEditor: vscode.window.activeTextEditor?.document.uri.toString(),
      notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
    },
    capabilities: {
      notebook: true,
      notebookRun: true,
      notebookEdit: true,
      notebookOutputArtifacts: true,
      notebookSource: true,
      lmToolsProxy: false,
    },
  }
}

async function writeRegistryFile(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 })
  await chmod(file, 0o600)
}

async function chmod(file: string, mode: number) {
  if (process.platform === "win32") return
  await fs.chmod(file, mode)
}

function xdgStateHome() {
  return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
}
