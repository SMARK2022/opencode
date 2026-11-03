// 本机 registry：写心跳文件供 CLI 发现活跃扩展实例
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"

const HOST = "127.0.0.1"
const HEARTBEAT_MS = 5_000

export type RegistryHandle = {
  // VS Code 实例 ID：通常为工作区路径的哈希
  id: string
  dispose(): Promise<void>
}

type RegistryInput = {
  id: string
  // HTTP 服务器端口：VS Code 扩展启动时分配的随机端口
  port: number
  // 认证 token：每个桥接实例生成唯一 token，防止未授权调用
  token: string
  createdAt?: number
}

// 注册桥接：写入锁文件并启动心跳，供客户端发现
export async function registerBridge(input: RegistryInput): Promise<RegistryHandle> {
  const dir = registryDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)

  const file = path.join(dir, `${input.id}.json`)
  const createdAt = Date.now()
  // registry 原子写：先 tmp 再 rename，防半写 JSON
  const write = () => writeRegistryFile(file, manifest({ ...input, createdAt }))
  await write()
  // 心跳定时器：每 5 秒更新锁文件时间戳
  const timer = setInterval(() => void write(), HEARTBEAT_MS)

  return {
    id: input.id,
    // 清理责任：VS Code 关闭时调用 dispose 删除注册文件，opencode 端通过 stale 检查兜底
    // 清理责任：VS Code 关闭时删除注册文件，opencode 端通过 stale 检查兜底
    async dispose() {
      clearInterval(timer)
      await fs.unlink(file).catch((error) => {
        if (error?.code !== "ENOENT") throw error
      })
    },
  }
}

// 获取锁文件目录：用户配置目录下的 bridges 子目录
export function registryDir() {
  return process.env.OPENCODE_IDE_REGISTRY_DIR ?? path.join(xdgStateHome(), "opencode", "ide")
}

export function manifest(input: RegistryInput) {
  const now = Date.now()
  return {
    // Schema 版本：用于未来注册文件格式迁移，当前固定为 1
    schema: 1,
    id: input.id,
    // PID 记录：注册文件包含 VS Code 进程 PID，opencode 端通过 PID 存活检查判断桥接是否可用
    // PID 记录：opencode 端通过 PID 存活检查判断桥接是否可用
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

// #219：先写临时文件再 rename 发布——崩溃或 VS Code 关闭最多留下 .tmp 孤儿，不会截断正在使用的清单
// Write into the registry directory first and publish with rename: readers only
// scan final `${uuid}.json` files, so a crash or VS Code shutdown can leave at
// worst a `.tmp` orphan instead of truncating the manifest currently used by
// OpenCode. The suffix parts are only for collision avoidance between the 5s
// heartbeat and extension reloads; they are not part of the public registry API.
async function writeRegistryFile(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await chmod(temp, 0o600)
    await fs.rename(temp, file)
    await chmod(file, 0o600)
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined)
    throw error
  }
}

async function chmod(file: string, mode: number) {
  if (process.platform === "win32") return
  await fs.chmod(file, mode)
}

function xdgStateHome() {
  return process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
}
