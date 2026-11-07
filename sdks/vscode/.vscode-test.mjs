import { defineConfig } from "@vscode/test-cli"

export default defineConfig({
  files: "out/test/**/*.test.js",
  // artifact验收需要真实工作区，输出使用原.opencode/cache路径且不修改notebook。
  workspaceFolder: import.meta.dirname,
})
