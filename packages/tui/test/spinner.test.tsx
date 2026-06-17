import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SpinnerIcon } from "../src/component/spinner"

test("spinner icon renders without a custom OpenTUI intrinsic", async () => {
  const app = await testRender(
    () => (
      <box width={8} height={1}>
        <SpinnerIcon
          frames={["ab"]}
          interval={0}
          color={(_frameIndex, charIndex) => (charIndex === 0 ? RGBA.fromHex("#ff0000") : RGBA.fromHex("#00ff00"))}
        />
      </box>
    ),
    { width: 8, height: 1 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ab")
  } finally {
    app.renderer.destroy()
  }
})

test("spinner icon updates repeated block frames in place", async () => {
  const app = await testRender(
    () => (
      <box width={12} height={1}>
        <SpinnerIcon frames={["■⬝⬝⬝", "⬝■⬝⬝"]} interval={1} width={4} color={RGBA.fromHex("#ff0000")} />
      </box>
    ),
    { width: 12, height: 1 },
  )

  try {
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(2)
      await app.renderOnce()
      expect(app.captureCharFrame().split("\n")[0]?.trimEnd()).toMatch(/^[■⬝]{4}$/)
    }
  } finally {
    app.renderer.destroy()
  }
})
