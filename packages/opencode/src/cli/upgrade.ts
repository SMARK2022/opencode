import { Config } from "@/config/config"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// Checking never installs anything. Updates only happen when the user runs `/update` or `opencode upgrade`.
export function shouldNotify(input: {
  autoupdate: boolean | "notify" | undefined
  disabled: boolean
  always: boolean
  current: string
  latest: string
}) {
  if (input.autoupdate === false || input.disabled) return false
  if (input.always) return true
  return Installation.isUpdate(input.current, input.latest)
}

// Returns undefined when checks are disabled or fail, so the TUI only suggests OpenCode 2 after a successful check.
export async function upgrade() {
  // 更新检查与 discovery 使用同一全局读取入口，客户端复用远程 owner 后也不会触发本地建库。
  const config = await Effect.runPromise(Config.readGlobalConfig())
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const latest = await Installation.latest(await Installation.method()).catch(() => {})
  if (!latest) return
  if (
    shouldNotify({
      autoupdate: config.autoupdate,
      disabled: Flag.OPENCODE_DISABLE_AUTOUPDATE,
      always: Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE,
      current: InstallationVersion,
      latest,
    })
  )
    return { type: "available" as const, version: latest }
  return { type: "major" as const }
}
