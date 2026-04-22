import type { CommandModule } from "yargs"

type Args = {}

export const GenerateCommand = {
  command: "generate",
  builder: (yargs) => yargs,
  handler: async () => {
    const json = await generateOpenApiJson()
    // Wait for stdout to finish writing before process.exit() is called
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule<object, Args>

// CLI 与 SDK 共用同一文档、示例和格式化工厂，防止两条输出路径产生不同的 wire 契约。
// Server 仍按调用懒加载；SDK 可读取静态 OpenAPI，无需导入 CLI 主入口或执行 bootstrap。
export async function generateOpenApiJson() {
  const { Server } = await import("../../server/server")
  const specs = (await Server.openapi()) as {
    paths: Record<string, Record<string, any>>
  }
  for (const item of Object.values(specs.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation?.operationId) continue
      operation["x-codeSamples"] = [
        {
          lang: "js",
          source: [
            `import { createOpencodeClient } from "@opencode-ai/sdk`,
            ``,
            `const client = createOpencodeClient()`,
            `await client.${operation.operationId}({`,
            `  ...`,
            `})`,
          ].join("\n"),
        },
      ]
    }
  }
  const raw = JSON.stringify(specs, null, 2)

  // Format through prettier so output is byte-identical to committed file
  // regardless of whether ./script/format.ts runs afterward.
  const prettier = await import("prettier")
  const babel = await import("prettier/plugins/babel")
  const estree = await import("prettier/plugins/estree")
  const format = prettier.format ?? prettier.default?.format
  return await format(raw, {
    parser: "json",
    plugins: [babel.default ?? babel, estree.default ?? estree],
    printWidth: 120,
  })
}
