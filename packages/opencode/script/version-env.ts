// 必须在所有其他 import 之前加载（尤其是 @opencode-ai/script），
// 确保 OPENCODE_VERSION 在模块求值时已设置。
// 用法: bun run build.ts --version=1.18.32-smark
const versionArg = process.argv[2]
if (versionArg?.startsWith("--version=")) {
  process.env.OPENCODE_VERSION = versionArg.replace("--version=", "")
}
