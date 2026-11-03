import { expect, test } from "bun:test"
import type { V2Event } from "@opencode-ai/sdk/v2"
import { createRoot } from "solid-js"
import { createDataEventQueue } from "../../src/context/data-deltas"

function delta(id: string, text: string, textID = "text") {
  return {
    id,
    type: "session.next.text.delta" as const,
    location: { directory: "/test" },
    data: { timestamp: 0, sessionID: "session", assistantMessageID: "message", textID, delta: text },
  } satisfies V2Event
}

test("coalesces only adjacent native cells and preserves the first event identity", () => {
  const received: V2Event[] = []
  const scope = createRoot((dispose) => ({ dispose, queue: createDataEventQueue((event) => received.push(event)) }))
  try {
    scope.queue.push(delta("first", "a"))
    scope.queue.push(delta("second", "b"))
    scope.queue.push(delta("other", "c", "other"))
    scope.queue.push(delta("last", "d"))
    expect(received).toEqual([])
    scope.queue.flush()
    // 交错目标是硬边界，不能把最后的 d 搬到另一单元的 c 之前。
    expect(received).toMatchObject([
      { id: "first", data: { delta: "ab" } },
      { id: "other", data: { delta: "c" } },
      { id: "last", data: { delta: "d" } },
    ])
  } finally {
    scope.dispose()
  }
})

test("flushes native deltas before the complete-value boundary", () => {
  const received: V2Event[] = []
  const scope = createRoot((dispose) => ({ dispose, queue: createDataEventQueue((event) => received.push(event)) }))
  try {
    scope.queue.push(delta("fragment", "a"))
    const end = {
      ...delta("end", ""),
      type: "session.next.text.ended" as const,
      data: { ...delta("end", "").data, text: "a" },
    }
    scope.queue.push(end)
    // 完整正文替换在增量之后执行，不能再把已包含的 a 补写一次。
    expect(received).toMatchObject([{ id: "fragment" }, { id: "end", data: { text: "a" } }])
    const hidden = {
      id: "hidden",
      type: "session.next.messages.hidden",
      location: { directory: "/test" },
      data: {
        sessionID: "session",
        timestamp: 0,
        messageIDs: ["message"],
        hidden: { time: 0, reason: "permission-reviewer-protocol-retry" },
      },
    } satisfies V2Event
    scope.queue.push(delta("before-hide", "b"))
    scope.queue.push(hidden)
    // tombstone也是顺序屏障，隐藏前的缓存片段不能拖到删除之后才提交。
    expect(received.map((event) => event.id)).toEqual(["fragment", "end", "before-hide", "hidden"])
    scope.queue.flush()
    expect(received).toHaveLength(4)
  } finally {
    scope.dispose()
  }
})

test("publishes a native frame and drops pending work on disposal", async () => {
  const received: V2Event[] = []
  const scope = createRoot((dispose) => ({ dispose, queue: createDataEventQueue((event) => received.push(event)) }))
  try {
    scope.queue.push(delta("first", "a"))
    scope.queue.push(delta("second", "b"))
    await Bun.sleep(40)
    expect(received).toMatchObject([{ id: "first", data: { delta: "ab" } }])
    scope.queue.push(delta("disposed", "c"))
    scope.dispose()
    await Bun.sleep(40)
    // dispose 后不能再有 timer 写入，也不能把末帧冒充终态提交。
    expect(received).toHaveLength(1)
  } finally {
    scope.dispose()
  }
})
