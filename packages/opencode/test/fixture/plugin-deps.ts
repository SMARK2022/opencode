import { mkdir } from "fs/promises"
import path from "path"

export async function markConfigDependenciesInstalled(dir: string) {
  // Config 会为每个配置目录补齐 @opencode-ai/plugin；测试里的本地 file 插件已经可直接导入，
  // 这里仅写入生产 Npm.install 认可的最小安装标记，避免 Windows CI 在单测中真实跑 Arborist。
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  // package-lock.json 的根 dependencies 记录的是“配置目录依赖已满足”的契约，
  // 不是 fixture 要加载的插件源码；插件源码仍来自 .opencode/plugin 下的真实文件。
  await Bun.write(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "0.0.0" } } } }),
  )
}
