import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount } from "./sync-fixture"

test("refresh reuses message and part identities while applying changed values", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const id = "ses_snapshot_identity"
  const messageID = "msg_snapshot_identity"
  const partID = "prt_snapshot_identity"
  let reads = 0
  const { app, sync } = await mount(url => {
    if (url.pathname === `/session/${id}`) return json({ id, title: "identity", time: { created: 0, updated: 0 } })
    if (url.pathname === `/session/${id}/message`) return json([{
      info: { id: messageID, sessionID: id, role: "assistant", parentID: "msg_user", agent: "build", modelID: "model", providerID: "test", mode: "build", path: { cwd: "/tmp/opencode", root: "/tmp/opencode" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, completed: ++reads + 1 } },
      parts: [{ id: partID, messageID, sessionID: id, type: "text", text: reads === 1 ? "before" : "after refreshed" }],
    }])
    if ([`/session/${id}/todo`, `/session/${id}/diff`].includes(url.pathname)) return json([])
    if (url.pathname === `/session/${id}/goal`) return json({ goal: null })
  }, tmp.path)
  try {
    const lease = await sync.session.acquireParts(id)
    const message = sync.data.message[id][0]
    const part = sync.data.part[messageID][0]
    await sync.session.sync(id, { force: true })
    // 验证复用而不是停止更新：相同身份仍要接收服务端的新完成时间和正文。
    expect({ message: sync.data.message[id][0] === message, part: sync.data.part[messageID][0] === part }).toEqual({ message: true, part: true })
    expect(sync.data.message[id][0].time).toMatchObject({ completed: 3 })
    expect(sync.data.part[messageID][0]).toMatchObject({ type: "text", text: "after refreshed" })
    lease.release()
  } finally {
    app.renderer.destroy()
  }
})
