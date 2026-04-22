// MUST be loaded before any other imports (especially @opencode-ai/script)
// to ensure OPENCODE_VERSION is set at module evaluation time.
// Usage: bun run build.ts --version=1.14.19-smark
const versionArg = process.argv[2]
if (versionArg?.startsWith("--version=")) {
  process.env.OPENCODE_VERSION = versionArg.replace("--version=", "")
}