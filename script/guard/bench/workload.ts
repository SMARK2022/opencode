import path from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"

export const relative = (i: number) => `src/d${i % 30}/f${i}.ts`
export const editFiles = Array.from({ length: 20 }, (_, i) => relative(i))
export const original = (i: number) => `// ${i === 0 ? "bench_unique_match" : i}\n`.padEnd(2047, " ") + "\n"

export function populate(dir: string) {
  writeFileSync(path.join(dir, ".gitattributes"), "*.ts -text\n")
  for (let i = 0; i < 30; i++) mkdirSync(path.join(dir, "src", `d${i}`), { recursive: true })
  for (let i = 0; i < 3000; i++) writeFileSync(path.join(dir, relative(i)), original(i))
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    const p = Bun.spawnSync(["git", ...args], { cwd: dir })
    if (!p.success) throw new Error(p.stderr.toString())
  }
}

type Message = { role: string; content: string | { type: string; text?: string }[]; tool_call_id?: string }
export function lastUser(messages: Message[]) {
  const body = messages.findLast((m) => m.role === "user")?.content
  return typeof body === "string" ? body : body?.map((p) => p.text ?? "").join(" ") ?? ""
}

export function scripted(messages: Message[], dir: string, compact: boolean) {
  const user = lastUser(messages)
  const edit = user.includes("bench:edit")
  if (!compact && !edit && !user.includes("bench:tools")) return
  const after = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1)
  const results = after.filter((m) => m.role === "tool")
  const invoke = (name: string, args: object, index = 0) => ({
    index, id: `bench_${name}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) },
  })
  const file = (i: number) => path.join(dir, relative(i))
  let calls
  if (compact && user.startsWith("Call context_compact(propose) now as your only action,")) {
    const tailStartID = JSON.parse(user.split("\n")[1]).candidates[0]?.tailStartID
    calls = [
      invoke("context_compact", {
        operation: "propose",
        tailStartID,
        summary: "Bench summary.",
      }),
    ]
  } else if (!compact && !results.length) {
    calls = edit ? editFiles.map((entry, i) => invoke("write", { filePath: path.join(dir, entry), content: "edited" }, i))
      : [invoke("grep", { pattern: "bench_unique_match", path: path.join(dir, "src") })]
  } else if (!compact && !edit && !results.some((m) => m.tool_call_id === "bench_read_0")) {
    calls = [invoke("read", { filePath: file(0) })]
  }
  const choice = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
    id: "bench", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
  })}

`
  const body = choice(calls ? { tool_calls: calls } : { content: compact ? "Bench summary." : "done" }, null)
    + choice({}, calls ? "tool_calls" : "stop") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
