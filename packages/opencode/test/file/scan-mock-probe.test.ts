import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { File } from "../../src/file"
import { Ripgrep } from "../../src/file/ripgrep"
import { Git } from "../../src/git"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(File.defaultLayer, AppFileSystem.defaultLayer))

it.instance("probe: mocked ripgrep drives search results", () =>
  Effect.gen(function* () {
    let scans = 0
    const built = yield* Layer.build(
      Layer.fresh(File.layer).pipe(
        Layer.provide([
          AppFileSystem.defaultLayer,
          Git.defaultLayer,
          Layer.mock(Ripgrep.Service, {
            files: () => {
              scans++
              return Stream.fromIterable(["src/a.ts", "src/b.ts"])
            },
          }),
        ]),
      ),
    )
    const file = Context.get(built, File.Service)
    const result = yield* file.search({ query: "", type: "file" })
    console.log("probe scans", scans, "result", JSON.stringify(result))
    expect(result).toEqual(["src/a.ts", "src/b.ts"])
  }),
)
