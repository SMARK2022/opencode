import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const source = readFileSync(path.join(import.meta.dir, "../../../src/component/dialog-session-list.tsx"), "utf8")

test("session list wires the two-message preview into rendered details", () => {
  expect(source).toContain("const SESSION_LIST_PREVIEW_LINES = 2")
  expect(source).toContain("details: previews()[x.id]")
  expect(source).not.toContain("previewLines: previews()[x.id]")
})
