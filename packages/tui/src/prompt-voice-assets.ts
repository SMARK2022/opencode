export * as PromptVoiceAssets from "./prompt-voice-assets"

import path from "path"
import { createRequire } from "module"

// 两个构建入口共用目标资源契约，包从TUI依赖边界解析，import路径则相对各自构建根。
export function createPvRecorderNativeFileMap(item: { os: string; arch: string }, root: string) {
  const pvRecorderLib = path.join(path.dirname(createRequire(import.meta.url).resolve("@picovoice/pvrecorder-node/package.json")), "lib")
  const files = pvRecorderNativeFilesForTarget(item)
  const imports = files.map((file, index) => {
    // Bun file-loader负责嵌入字节；生成模块只保存平台key到资源地址的映射。
    const spec = path.relative(root, path.join(pvRecorderLib, ...file.split("/"))).replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, index) => `  ${JSON.stringify(file)}: file_${index},`)
  return [...imports, "export default {", ...entries, "}"].join("\n")
}

function pvRecorderNativeFilesForTarget(item: { os: string; arch: string }) {
  if (item.os === "win32") {
    // Picovoice的Windows x64目录名与Bun target不同，不能直接拼接arch。
    if (item.arch === "x64") return ["windows/amd64/pv_recorder.node"]
    if (item.arch === "arm64") return ["windows/arm64/pv_recorder.node"]
  }
  if (item.os === "darwin") {
    // Intel与Apple Silicon保持独立资源，运行时使用同样的平台key选择。
    if (item.arch === "x64") return ["mac/x86_64/pv_recorder.node"]
    if (item.arch === "arm64") return ["mac/arm64/pv_recorder.node"]
  }
  if (item.os === "linux") {
    // glibc/musl只区分外层Bun runtime，Picovoice包内x64资源key相同。
    if (item.arch === "x64") return ["linux/x86_64/pv_recorder.node"]
    if (item.arch === "arm64") return [
      "raspberry-pi/cortex-a53-aarch64/pv_recorder.node",
      "raspberry-pi/cortex-a72-aarch64/pv_recorder.node",
      "raspberry-pi/cortex-a76-aarch64/pv_recorder.node",
    ]
  }
  return []
}
