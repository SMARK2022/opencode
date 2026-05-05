import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Process } from "@/util/process"
import { IdeEvent } from "@opencode-ai/schema/ide-event"



// 扩展完整 ID 必须等于 package.json 的 publisher + "." + name
// publisher=SMARK2022：SMARK 分支发布者，避免与上游 sst 扩展冲突
// name=opencode-ide-bridge：notebook/bridge 工具宿主扩展名
// CLI --install-extension 只允许此常量，禁止散落字面量
// 与 registry 发现解耦：安装身份不等于运行时 token 传递
// #87 已删除 OPENCODE_VSCODE_BRIDGE_*，此处不得恢复 env 注入
// LICENSE(MIT) 随扩展分发，声明 SMARK 分支维护权
// README 安装说明必须引用同一 ID，避免用户装错扩展
// .vscodeignore 排除 env/log/临时 vsix，降低打包泄漏面
// packages/identity 品牌 mark 与扩展市场图标一致
// 预置 vsix 供离线安装；文件名可保留历史版本号
// package.json version 跟随 monorepo 目标版本线
// 改 ID 的唯一合法入口：本常量与 package.json 同步修改
// alreadyInstalled 探测宿主注入，不解析显示名
// 安装失败抛 InstallFailedError 并携带宿主 stderr
// Process.run 走宿主 CLI，不内嵌 marketplace HTTP 客户端
const VSCODE_BRIDGE_EXTENSION_ID = "SMARK2022.opencode-ide-bridge" as const

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

export const Event = IdeEvent

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
  const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["OPENCODE_CALLER"] === "vscode" || process.env["OPENCODE_CALLER"] === "vscode-insiders"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  const p = await Process.run([cmd, "--install-extension", VSCODE_BRIDGE_EXTENSION_ID], {
    nothrow: true,
  })
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) {
    throw new InstallFailedError({ stderr })
  }
  if (stdout.includes("already installed")) {
    throw new AlreadyInstalledError({})
  }
}

export * as Ide from "."
