// 测试选择的升级规则。只允许人类在独立 PR 中修改。

// 命中任意一条 → 该包（或全仓）跑全量。这些是 import 图看不见、却影响所有测试的输入。
export const ESCALATE_FULL: RegExp[] = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^patches\//,
  /^tsconfig\.json$/,
  /^packages\/[^/]+\/(package\.json|tsconfig\.json|bunfig\.toml)$/,
  /^packages\/[^/]+\/test\/(preload\.ts|fixture\/|lib\/|fake\/)/,
  /^packages\/core\/(migration|drizzle)\//,
  /\.sql\.ts$/,
  /^script\/guard\//,
]

// 无论改了什么都要跑：预算、冒烟、守卫自身。
export const ALWAYS_RUN: RegExp[] = [/\/test\/budget\//, /\/test\/smoke\//]

// 某个包的受影响测试超过这个比例，直接跑该包全量（避免挑选本身的开销和遗漏）。
export const FULL_RATIO = 0.5
