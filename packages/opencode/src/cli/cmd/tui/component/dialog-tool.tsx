import { TextAttributes } from "@opentui/core"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { ToolSelection } from "@/tool/selection"
import { createMemo, createResource, createSignal } from "solid-js"

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  if (props.loading) return <span style={{ fg: theme.textMuted }}>⋯ Saving</span>
  if (props.enabled) return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogTool(props: { sessionID: string }) {
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal<string>()

  const [tools] = createResource(async () => {
    const result = await sdk.client.tool.ids({ workspace: project.workspace.current() }, { throwOnError: true })
    return result.data.filter(ToolSelection.isUserConfigurable)
  })

  const session = () => sync.session.get(props.sessionID)
  const enabled = (id: string) => ToolSelection.enabled(id, session()?.permission)

  async function toggle(id: string) {
    if (loading()) return
    const next = !enabled(id)
    setLoading(id)
    const workspace = project.workspace.current()
    const result = await sdk.client.session.update(
      {
        workspace,
        sessionID: props.sessionID,
        // Session.update merges rules server-side; the matching exact rule is
        // compacted there so repeated toggles do not accumulate stale entries.
        permission: [{ permission: id, pattern: "*", action: next ? "allow" : "deny" }],
      },
      { throwOnError: false },
    )
    if (result.error) {
      toast.show({ variant: "error", message: "Failed to update tool settings", duration: 5000 })
      setLoading(undefined)
      return
    }
    await sync.session.refresh().catch(() => undefined)
    setLoading(undefined)
  }

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    (tools() ?? []).toSorted().map((id) => {
      const active = enabled(id)
      return {
        value: id,
        title: id,
        category: active ? "Enabled" : "Disabled",
        footer: <Status enabled={active} loading={loading() === id} />,
        gutter: () => <text fg={active ? theme.success : theme.textMuted}>{active ? "✓" : "○"}</text>,
      }
    }),
  )

  return (
    <DialogSelect
      title="Tools"
      placeholder="Search tools..."
      options={options()}
      actions={[{ command: "dialog.tool.toggle", title: "toggle", onTrigger: (option) => void toggle(option.value) }]}
      onSelect={(option) => void toggle(option.value)}
    />
  )
}
