// @ts-nocheck
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "./keybind"
import { Schema } from "effect"
import { isRecord } from "@/util/record"
import { Filesystem } from "@/util/filesystem"
import { TuiAttentionSoundNames, type TuiAttentionSoundName } from "@opencode-ai/plugin/tui"

export type TuiAttentionSoundPaths = Partial<Record<TuiAttentionSoundName, string>>

export function isAttentionSoundName(value: string): value is TuiAttentionSoundName {
  return TuiAttentionSoundNames.includes(value as TuiAttentionSoundName)
}

export function resolveAttentionSoundPaths(
  root: string,
  sounds: unknown,
  options?: { trim?: boolean },
): TuiAttentionSoundPaths {
  if (!isRecord(sounds)) return {}
  return Object.fromEntries(
    Object.entries(sounds).flatMap(([name, file]) => {
      if (!isAttentionSoundName(name)) return []
      if (typeof file !== "string") return []
      const value = options?.trim ? file.trim() : file
      if (!value) return []
      return [[name, Filesystem.resolveFilePath(root, value)]]
    }),
  )
}

export const KeymapLeaderTimeoutDefault = 2000
const KeymapLeaderTimeout = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Leader key timeout in milliseconds",
})

const TuiAttentionSounds = Schema.Struct({
  default: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  permission: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  done: Schema.optional(Schema.String),
  subagent_done: Schema.optional(Schema.String),
})

export const ScrollSpeed = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))

export const ScrollAcceleration = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Enable scroll acceleration" }),
}).annotate({ description: "Scroll acceleration settings" })

export const DiffStyle = Schema.Literals(["auto", "stacked"]).annotate({
  description: "Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column",
})

export const Attention = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  notifications: Schema.optional(Schema.Boolean),
  sound: Schema.optional(Schema.Boolean),
  volume: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))),
  sound_pack: Schema.optional(Schema.String),
  sounds: Schema.optional(TuiAttentionSounds),
}).annotate({ description: "Attention notification and sound settings" })

const VoiceTranscriber = Schema.Struct({
  command: Schema.String.annotate({ description: "Executable used to transcribe a recorded WAV file" }),
  // args 是 argv 数组，不是 shell 字符串；其中一项必须包含 `{file}`，确保录音路径按字面量传递。
  // 这样即使路径包含空格、重定向符、管道或环境变量字符，也不会被解释成 shell 语法。
  args: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Arguments for the transcriber command; include {file} for the WAV path" }),
})

export const Voice = Schema.Struct({
  transcriber: Schema.optional(VoiceTranscriber),
}).annotate({ description: "Prompt voice input settings" })

export const TuiInfo = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides),
  plugin: Schema.optional(Schema.Array(ConfigPlugin.Spec)),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  leader_timeout: Schema.optional(KeymapLeaderTimeout),
  attention: Schema.optional(Attention),
  voice: Schema.optional(Voice),
  scroll_speed: Schema.optional(ScrollSpeed).annotate({
    description: "TUI scroll speed",
  }),
  scroll_acceleration: Schema.optional(ScrollAcceleration),
  diff_style: Schema.optional(DiffStyle),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable or disable mouse capture (default: true)" }),
})
