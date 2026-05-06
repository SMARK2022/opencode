import { Effect } from "effect"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { z } from "zod"
import * as VscodeBridge from "@/ide/vscode-bridge"
import { VscodeNotebookDescriptions } from "./vscode-bridge-descriptions"

const requiredFilePath = {
  filePath: z
    .string()
    .describe("Absolute notebook path or file URI. Required; the bridge never infers a notebook from VS Code focus or open documents."),
}

const optionalCellId = {
  cellId: z
    .string()
    .optional()
    .describe("Stable notebook cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Prefer this over display indexes."),
}

const requiredEditCellId = {
  cellId: z
    .string()
    .describe(
      "Target cell ID. Use #VSC-xxxxxxxx from vscode_notebook_summary. For editType=insert, use TOP, BOTTOM, or a #VSC cell ID to insert after that cell.",
    ),
}

const sourceArgs = {
  ...requiredFilePath,
  ...optionalCellId,
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based global virtual source line offset. With cellId, omit this to start at that cell's first global line."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum rendered source lines to return, capped at 1000."),
}

const runArgs = {
  ...requiredFilePath,
  type: z
    .enum(["cell", "range"])
    .optional()
    .describe("Optional run kind hint. The bridge runs a range whenever endCellId is provided; otherwise it runs one cell."),
  cellId: z.string().describe("Stable start cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx."),
  endCellId: z
    .string()
    .optional()
    .describe("Stable ending cell ID, formatted like #VSC-xxxxxxxx. When provided, the bridge runs from cellId through this cell, inclusive."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Per-cell execution timeout in milliseconds. Defaults to 300000, maximum 600000."),
}

const outputArgs = {
  ...requiredFilePath,
  ...optionalCellId,
}

const editArgs = {
  ...requiredFilePath,
  ...requiredEditCellId,
  editType: z
    .enum(["insert", "edit", "delete"])
    .describe("Notebook edit kind: insert a new cell, edit an existing cell, or delete the target cell."),
  oldCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Existing source fragment to replace inside the target cell. It must identify one unique match; include enough surrounding lines from vscode_notebook_source."),
  newCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("New source for insert or edit. Required for insert, full-cell replacement, and oldCode replacement. Do not wrap in Markdown fences unless the fences are literal content."),
  language: z
    .string()
    .optional()
    .describe("Cell language. Use 'markdown' for Markdown cells; use 'python' or another language for code cells. On edit, language alone changes cell kind/language while preserving source."),
}

async function call(
  endpoint: string,
  args: Record<string, unknown>,
  context: Pick<ToolContext, "directory" | "abort">,
  timeoutMs?: number,
) {
  const value = await VscodeBridge.callBridge({
    cwd: context.directory,
    path: endpoint,
    body: args,
    filePath: typeof args.filePath === "string" ? args.filePath : undefined,
    signal: context.abort,
    timeoutMs,
  })
  return VscodeBridge.summaryOnly(value)
}

async function ask(context: ToolContext, permission: string, args: Record<string, unknown>) {
  const pattern = typeof args.filePath === "string" ? args.filePath : "*"
  await Effect.runPromise(
    context.ask({
      permission,
      patterns: [pattern],
      always: [pattern],
      metadata: { args },
    }),
  )
}

export const VscodeBridgePlugin = async () => ({
  tool: {
    vscode_notebook_summary: tool({
      description: VscodeNotebookDescriptions.summary,
      args: requiredFilePath,
      execute: async (args, context) => ({
        output: await call("/notebook/summary", args, context, 10_000),
        metadata: { endpoint: "/notebook/summary" },
      }),
    }),
    vscode_notebook_source: tool({
      description: VscodeNotebookDescriptions.source,
      args: sourceArgs,
      execute: async (args, context) => ({
        output: await call("/notebook/source", args, context, 10_000),
        metadata: { endpoint: "/notebook/source" },
      }),
    }),
    vscode_notebook_run: tool({
      description: VscodeNotebookDescriptions.run,
      args: runArgs,
      execute: async (args, context) => {
        await ask(context, "vscode_notebook_run", args)
        const timeoutMs = args.timeoutMs ?? 300_000
        return {
          output: await call("/notebook/run", { ...args, timeoutMs }, context, timeoutMs + 5_000),
          metadata: { endpoint: "/notebook/run" },
        }
      },
    }),
    vscode_notebook_output: tool({
      description: VscodeNotebookDescriptions.output,
      args: outputArgs,
      execute: async (args, context) => ({
        output: await call("/notebook/output", args, context, 30_000),
        metadata: { endpoint: "/notebook/output" },
      }),
    }),
    vscode_notebook_edit: tool({
      description: VscodeNotebookDescriptions.edit,
      args: editArgs,
      execute: async (args, context) => {
        await ask(context, "edit", args)
        return {
          output: await call("/notebook/edit", args, context, 30_000),
          metadata: { endpoint: "/notebook/edit" },
        }
      },
    }),
    vscode_notebook_env: tool({
      description: VscodeNotebookDescriptions.env,
      args: requiredFilePath,
      execute: async (args, context) => ({
        output: await call("/notebook/env", args, context, 10_000),
        metadata: { endpoint: "/notebook/env" },
      }),
    }),
    vscode_notebook_restart_kernel: tool({
      description: VscodeNotebookDescriptions.kernel,
      args: {
        ...requiredFilePath,
        reason: z.string().optional().describe("Why the kernel is being restarted, for logging and user context."),
      },
      execute: async (args, context) => ({
        output: await call("/notebook/kernel", args, context, 30_000),
        metadata: { endpoint: "/notebook/kernel" },
      }),
    }),
  },
})
