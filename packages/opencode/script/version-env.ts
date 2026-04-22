// MUST be loaded before any other imports (especially @opencode-ai/script)
// to ensure OPENCODE_VERSION is set at module evaluation time.
// Usage: bun run build.ts --version=1.14.19-smark
const versionFromEquals = process.argv.find((arg) => arg.startsWith("--version="))?.replace("--version=", "")
if (versionFromEquals) {
  process.env.OPENCODE_VERSION = versionFromEquals
}

const versionIndex = process.argv.findIndex((arg) => arg === "--version")
if (versionIndex >= 0 && process.argv[versionIndex + 1]) {
  process.env.OPENCODE_VERSION = process.argv[versionIndex + 1]
}
