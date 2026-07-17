import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

type PatchEntry = {
  // index 是迁移的唯一串行位置，任何缺口或重复都表示 source 范围被改写。
  index: number
  // sha 绑定真实 source commit，不能由 patch 文件名或 record 标题代替。
  sha: string
  // parent 保存该提交自己的第一父提交，用于发现 manifest 元数据漂移。
  parent: string
  author: string
  email: string
  authoredAt: string
  subject: string
  // original 是不可变 source 证据；运行时会与 fresh format-patch 逐字比较。
  originalPatch: string
  // current 是唯一允许适配目标架构的 patch，状态构建只消费这一侧。
  currentPatch: string
}

type Manifest = {
  // schema 版本阻止旧生成器产物被新验证逻辑静默解释。
  schemaVersion: 1
  generatedAt: string
  // sourceRepo 和 sourceRef 共同确定重新枚举 452 项历史的权威来源。
  sourceRepo: string
  sourceRef: string
  // sourceTip 固定生成时的 commit；移动中的分支名只保留为人类可读标签。
  sourceTip: string
  // firstSmarkCommit 与 forkBase 封闭迁移起点，不能由 builder 手工前移。
  firstSmarkCommit: string
  forkBase: string
  // targetRepo 与 targetBaseline 确定每个状态必须重建的唯一目标起点。
  targetRepo: string
  targetBaseline: string
  selection: string
  // commits 是完整有序集合；脚本不接受临时子集 manifest。
  commits: PatchEntry[]
}

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type Outcome = {
  // outcome 对应一个 manifest 项，报告不能把多个 commit 合并为一条结果。
  index: number
  sha: string
  subject: string
  patch: string
  // status 只描述文本累计应用；行为 PASS 仍由测试和独立审计决定。
  status: "passed" | "failed"
  // phase 区分输入缺失、上下文冲突和真实 apply 失败，便于回到正确调查点。
  phase: "check" | "apply" | "setup"
  // reason 是导航类别，stdout/stderr 才保存完整可复核失败证据。
  reason: string
  // 该列表明确是 baseline 到当前项的累计文件集合，禁止误读为单项 diff。
  cumulativeChangedFiles: string[]
  stdout: string
  stderr: string
}

type Report = {
  schemaVersion: 1
  // mode 区分全量验证和可保留状态构建，避免把临时 clone 当成发布状态。
  mode: "verify-all" | "materialize"
  // 时间只用于报告身份和最近发布排序，不参与 source commit 顺序判断。
  startedAt: string
  finishedAt?: string
  // 两份 manifest 哈希让状态和报告绑定到同一轮输入视图。
  manifestJsonSha256: string
  manifestTsvSha256: string
  sourceRef: string
  sourceTip: string
  targetBaseline: string
  // patchCount 是本次实际请求的前缀长度；全局总数仍由 manifest 固定为 452。
  patchCount: number
  passed: number
  stoppedAt?: number
  // temporaryRepo 只允许显式失败诊断保留，物化失败始终自动回收。
  temporaryRepo?: string
  materializedIndex?: number
  // stateDirectory 只有事务发布完成后才出现，不能在 staging 阶段提前写入。
  stateDirectory?: string
  // retainedStates 按成功发布时间排序，绝不按 index 大小排序。
  retainedStates?: string[]
  // source HEAD 单独记录，防止只比较 dirty diff 时遗漏分支或提交漂移。
  sourceRepoHeadBefore: string
  sourceRepoHeadAfter?: string
  // 仓库指纹覆盖 status、tracked diff 和未跟踪内容，保护用户并发修改。
  sourceRepoFingerprintBefore: string
  sourceRepoFingerprintAfter?: string
  targetRepoFingerprintBefore: string
  targetRepoFingerprintAfter?: string
  // preflight 证明 simulation 在应用第一个 current patch 前确实为空白 baseline。
  simulationPreflight?: {
    head: string
    statusSha256: string
    worktreeDiffSha256: string
    indexDiffSha256: string
  }
  // integrityFailure 与 patch 冲突分开报告，避免把仓库并发漂移误判为 patch 缺陷。
  integrityFailure?: string
  outcomes: Outcome[]
}

type MaterializedState = {
  schemaVersion: 1
  // builtAt 是成功发布时间；它决定最近五个状态的回收顺序。
  builtAt: string
  // index 0 表示 exact baseline，1..452 表示对应 current 前缀。
  index: number
  // sha 在 index 0 绑定 target baseline，其余 index 绑定 source commit。
  sha: string
  // head 必须始终等于 targetBaseline，因为 patch 作为 staged diff 存在。
  head: string
  targetBaseline: string
  // manifest 哈希变化会使状态失效，防止旧状态跨输入集合复用。
  manifestJsonSha256: string
  manifestTsvSha256: string
  // 累计 patch 指纹覆盖 1..index，任何早期 current 改动都会使后续状态失效。
  cumulativePatchSha256: string
  // 三个 repo 指纹分别保护路径集合、unstaged 内容和 staged 累计结果。
  statusSha256: string
  worktreeDiffSha256: string
  indexDiffSha256: string
  // repo 使用固定相对名，metadata 不能把验证器引向状态目录之外。
  repo: "repo"
}

const targetRepo = resolve(import.meta.dir, "../../..")
const sourceRepo = resolve(targetRepo, "../..")
const patchRoot = resolve(targetRepo, ".temp/patches")
const reportsDir = resolve(patchRoot, "reports")
// statesDir 只保存成功发布态；所有未完成构建使用隐藏 staging 目录。
const statesDir = resolve(patchRoot, "states")
// 五个状态正好覆盖一个普通审计批次，同时限制完整 clone 的磁盘占用。
const maxMaterializedStates = 5

function runGit(cwd: string, args: string[]): CommandResult {
  // Git 输出必须完整捕获到报告，避免终端截断后只剩 builder 的失败摘要。
  // 非零退出由调用点按 check、apply 或 setup 语义分类，不能统一吞成异常。
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

function runGitBytes(cwd: string, args: string[]) {
  // 原始邮件 patch 必须按字节比较；文本解码会掩盖二进制 diff 的身份变化。
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${new TextDecoder().decode(result.stderr)}`)
  }
  return new Uint8Array(result.stdout)
}

function sha256(value: string | Uint8Array) {
  // 所有状态身份都使用内容哈希，避免把文件名或 builder 声明当成真实证据。
  return createHash("sha256").update(value).digest("hex")
}

async function fileSha256(path: string) {
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()))
}

function isHash(value: unknown, length: number) {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
}

function isPatchEntry(value: unknown): value is PatchEntry {
  // 单项 shape 验证阻止伪造路径在后续 resolve 中越过 original/current 目录合同。
  if (!value || typeof value !== "object") return false
  if (!("index" in value) || !Number.isInteger(value.index) || Number(value.index) < 1) return false
  if (!("sha" in value) || !isHash(value.sha, 40)) return false
  if (!("parent" in value) || !isHash(value.parent, 40)) return false
  if (!("author" in value) || typeof value.author !== "string") return false
  if (!("email" in value) || typeof value.email !== "string") return false
  if (!("authoredAt" in value) || typeof value.authoredAt !== "string") return false
  if (!("subject" in value) || typeof value.subject !== "string") return false
  if (!("originalPatch" in value) || typeof value.originalPatch !== "string") return false
  return "currentPatch" in value && typeof value.currentPatch === "string"
}

function isManifest(value: unknown): value is Manifest {
  // manifest 直接驱动 452 次文件读取和 Git 操作，必须在任何路径解析前验证完整 shape。
  if (!value || typeof value !== "object") return false
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) return false
  if (!("generatedAt" in value) || typeof value.generatedAt !== "string") return false
  if (!("sourceRepo" in value) || typeof value.sourceRepo !== "string") return false
  if (!("sourceRef" in value) || typeof value.sourceRef !== "string") return false
  if (!("sourceTip" in value) || !isHash(value.sourceTip, 40)) return false
  if (!("firstSmarkCommit" in value) || !isHash(value.firstSmarkCommit, 40)) return false
  if (!("forkBase" in value) || !isHash(value.forkBase, 40)) return false
  if (!("targetRepo" in value) || typeof value.targetRepo !== "string") return false
  if (!("targetBaseline" in value) || !isHash(value.targetBaseline, 40)) return false
  if (!("selection" in value) || typeof value.selection !== "string") return false
  return "commits" in value && Array.isArray(value.commits) && value.commits.every(isPatchEntry)
}

function isMaterializedState(value: unknown): value is MaterializedState {
  // metadata 是生成态的信任入口；字段缺失或类型漂移必须触发重建，不能带病排序。
  if (!value || typeof value !== "object") return false
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) return false
  if (!("builtAt" in value) || typeof value.builtAt !== "string" || Number.isNaN(Date.parse(value.builtAt))) return false
  if (!("index" in value) || !Number.isInteger(value.index) || Number(value.index) < 0) return false
  if (!("sha" in value) || !isHash(value.sha, 40)) return false
  if (!("head" in value) || !isHash(value.head, 40)) return false
  if (!("targetBaseline" in value) || !isHash(value.targetBaseline, 40)) return false
  if (!("manifestJsonSha256" in value) || !isHash(value.manifestJsonSha256, 64)) return false
  if (!("manifestTsvSha256" in value) || !isHash(value.manifestTsvSha256, 64)) return false
  if (!("cumulativePatchSha256" in value) || !isHash(value.cumulativePatchSha256, 64)) return false
  if (!("statusSha256" in value) || !isHash(value.statusSha256, 64)) return false
  if (!("worktreeDiffSha256" in value) || !isHash(value.worktreeDiffSha256, 64)) return false
  if (!("indexDiffSha256" in value) || !isHash(value.indexDiffSha256, 64)) return false
  return "repo" in value && value.repo === "repo"
}

function requireGit(cwd: string, args: string[]) {
  // 这里只用于没有合法失败分支的基础设施命令；预期失败必须调用 runGit。
  const result = runGit(cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function classifyFailure(output: string) {
  // 原因类别只负责导航调查，完整 stdout/stderr 始终保留为权威失败证据。
  const text = output.toLowerCase()
  if (text.includes("does not exist") || text.includes("no such file") || text.includes("can't find file")) return "file-not-found"
  if (text.includes("does not apply") || text.includes("patch failed") || text.includes("conflict")) return "conflict"
  if (text.includes("binary")) return "binary-mismatch"
  if (text.includes("permission denied")) return "permission"
  return "unknown"
}

function commandText(result: CommandResult) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
}

async function repositoryFingerprint(repo: string) {
  // status 文本不能识别“同一路径仍为 modified、但内容再次变化”，所以同时纳入完整 diff。
  // 指纹只用于确认脚本没有改变用户工作区，不要求用户在运行前清理已有修改。
  const head = requireGit(repo, ["rev-parse", "HEAD"]).trim()
  const status = requireGit(repo, ["status", "--porcelain", "--untracked-files=all"])
  const worktreeDiff = requireGit(repo, ["diff", "--binary", "--full-index", "--no-ext-diff"])
  const indexDiff = requireGit(repo, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"])
  const untracked = requireGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
  // 未跟踪文件不会进入 git diff；内容哈希保证并发改写也会改变仓库指纹。
  const untrackedHashes = await Promise.all(
    untracked.map(async (path) => `${path}\t${await fileSha256(resolve(repo, path))}`),
  )
  return sha256([head, status, worktreeDiff, indexDiff, ...untrackedHashes].join("\0"))
}

function isSmarkAuthor(name: string, email: string) {
  return /^(smark|smark2022)$/i.test(name.trim()) || email.trim().toLowerCase() === "3222301373@qq.com"
}

async function validateManifest(manifest: Manifest, manifestTsvPath: string) {
  // 路径和 ref 也是 manifest 身份的一部分，不能只验证 commits 数组。
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported manifest schema ${manifest.schemaVersion}`)
  if (resolve(manifest.sourceRepo) !== sourceRepo) throw new Error("manifest source repository does not match this workspace")
  if (resolve(manifest.targetRepo) !== targetRepo) throw new Error("manifest target repository does not match this workspace")
  if (manifest.sourceRef !== "dev-smark") throw new Error(`unexpected manifest source ref ${manifest.sourceRef}`)
  // 452 是当前迁移的封闭集合，数量漂移必须在应用任何 patch 前终止。
  if (manifest.commits.length !== 452) throw new Error(`expected 452 manifest entries, got ${manifest.commits.length}`)
  const authorRecords = requireGit(sourceRepo, ["log", "--first-parent", "--reverse", "--format=%H%x00%an%x00%ae", manifest.sourceTip])
    .split("\n")
    .filter(Boolean)
    .map((record) => {
      const [sha, author, email] = record.split("\0")
      return { sha, author, email }
    })
  const firstSmark = authorRecords.find((record) => isSmarkAuthor(record.author, record.email))
  if (!firstSmark || firstSmark.sha !== manifest.firstSmarkCommit) {
    throw new Error("manifest first SMARK commit does not match independent author enumeration")
  }
  if (requireGit(sourceRepo, ["rev-parse", manifest.firstSmarkCommit + "^"]).trim() !== manifest.forkBase) {
    throw new Error("manifest fork base does not match the first SMARK commit parent")
  }
  // 独立重建第一父线序列，防止被缩短或重排的 manifest 获得局部通过。
  const expected = requireGit(sourceRepo, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--no-merges",
    manifest.firstSmarkCommit + "^.." + manifest.sourceTip,
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
  if (expected.length !== manifest.commits.length || expected.some((sha, index) => sha !== manifest.commits[index]?.sha)) {
    throw new Error("manifest commit sequence does not match an independent first-parent source enumeration")
  }
  const seen = new Set<string>()
  for (const [position, entry] of manifest.commits.entries()) {
    // index、SHA 和真实第一父提交共同确定单项身份，不能只相信显示顺序。
    if (entry.index !== position + 1) throw new Error(`manifest index gap at position ${position + 1}`)
    if (seen.has(entry.sha)) throw new Error(`duplicate manifest commit ${entry.sha}`)
    seen.add(entry.sha)
    const metadata = requireGit(sourceRepo, ["show", "-s", "--format=%H%n%P", entry.sha]).trim().split("\n")
    if (metadata[0] !== entry.sha || metadata[1]?.split(" ")[0] !== entry.parent) {
      throw new Error(`manifest metadata mismatch for ${entry.sha}`)
    }
    const filename = `${String(entry.index).padStart(4, "0")}-${entry.sha.slice(0, 12)}.patch`
    if (entry.originalPatch !== `original/${filename}` || entry.currentPatch !== `current/${filename}`) {
      throw new Error(`manifest patch path mismatch for ${entry.sha}`)
    }
    // original 和 current 必须成对存在；缺少任何一侧都无法建立可审计映射。
    const originalPatch = resolve(patchRoot, entry.originalPatch)
    if (!(await Bun.file(originalPatch).exists())) throw new Error(`missing original patch ${entry.originalPatch}`)
    if (!(await Bun.file(resolve(patchRoot, entry.currentPatch)).exists())) throw new Error(`missing current patch ${entry.currentPatch}`)
    // original 必须逐字等于 source commit 的 fresh format-patch，不能靠历史哈希自证。
    const sourcePatch = runGitBytes(sourceRepo, ["format-patch", "--stdout", "--no-stat", "--full-index", "--binary", "--no-signature", "-1", entry.sha])
    if ((await fileSha256(originalPatch)) !== sha256(sourcePatch)) throw new Error(`original patch changed for ${entry.sha}`)
  }
  // TSV 是给人和 auditor 使用的第二视图，必须与 JSON 的完整语义逐字一致。
  const expectedTsv = [
    "index\tsha\tparent\tauthor\temail\tauthoredAt\tsubject\toriginalPatch\tcurrentPatch",
    ...manifest.commits.map((entry) =>
      [
        entry.index,
        entry.sha,
        entry.parent,
        entry.author,
        entry.email,
        entry.authoredAt,
        entry.subject.replace(/[\t\r\n]+/g, " "),
        entry.originalPatch,
        entry.currentPatch,
      ].join("\t"),
    ),
  ].join("\n") + "\n"
  if ((await Bun.file(manifestTsvPath).text()) !== expectedTsv) throw new Error("manifest TSV does not match manifest JSON")
}

function parseMaterializeIndex(manifest: Manifest) {
  // 物化 index 表示从 baseline 到该项的完整前缀，绝不表示只应用单个 patch。
  // index 0 是未应用 patch 的 exact baseline；其他越界值在 clone 前直接拒绝。
  const position = process.argv.indexOf("--materialize")
  if (position === -1) return
  const value = Number(process.argv[position + 1])
  if (!Number.isInteger(value) || value < 0 || value > manifest.commits.length) {
    throw new Error(`--materialize requires an integer from 0 through ${manifest.commits.length}`)
  }
  return value
}

function materializedStateName(index: number, sha: string) {
  // index 负责顺序，SHA 负责身份；二者同时进入目录名以阻断错位状态复用。
  return `${String(index).padStart(4, "0")}-${sha.slice(0, 12)}`
}

async function cumulativePatchSha256(entries: PatchEntry[]) {
  // 状态指纹覆盖每个 current patch 的内容，任一早期 patch 改动都会使状态过期。
  const identities = await Promise.all(
    entries.map(async (entry) => `${entry.index}\t${entry.sha}\t${await fileSha256(resolve(patchRoot, entry.currentPatch))}`),
  )
  return sha256(identities.join("\n"))
}

async function removeInterruptedBuilds() {
  await mkdir(statesDir, { recursive: true })
  // backup 目录表示一次未完成的发布事务；目标已出现时丢弃旧版本，否则恢复旧状态。
  for (const entry of (await readdir(statesDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(".backup-"),
  )) {
    const backup = join(statesDir, entry.name)
    const targetName = await (async () => {
      try {
        const value: unknown = await Bun.file(join(backup, "publication.json")).json()
        if (!value || typeof value !== "object" || !("target" in value)) return
        return typeof value.target === "string" && /^\d{4}-[0-9a-f]{12}$/.test(value.target) ? value.target : undefined
      } catch {
        return
      }
    })()
    const published = targetName ? await Bun.file(join(statesDir, targetName, "state.json")).exists() : false
    if (!published) {
      // 未出现新目标说明发布没有完成；逐个恢复被替换和预回收的成功状态。
      for (const state of (await readdir(backup, { withFileTypes: true })).filter(
        (state) => state.isDirectory() && /^\d{4}-[0-9a-f]{12}$/.test(state.name),
      )) {
        const destination = join(statesDir, state.name)
        if (await Bun.file(join(destination, "state.json")).exists()) continue
        await rename(join(backup, state.name), destination)
      }
    }
    await rm(backup, { recursive: true, force: true })
  }
  // `.building-*` 没有发布语义；启动时删除可确保中断不会持续占用磁盘。
  await Promise.all(
    (await readdir(statesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".building-"))
      .map((entry) => rm(join(statesDir, entry.name), { recursive: true, force: true })),
  )
}

async function materializedStateDirectories() {
  // 只有发布命名符合 index-SHA 合同的目录才是状态；辅助文件不进入回收集合。
  return (await readdir(statesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-[0-9a-f]{12}$/.test(entry.name))
    .map((entry) => entry.name)
}

async function removeStaleMaterializedStates(
  manifest: Manifest,
  manifestJsonSha256: string,
  manifestTsvSha256: string,
) {
  // 早期 current patch 变化会使所有后续状态失真；状态身份必须覆盖完整前缀。
  for (const name of await materializedStateDirectories()) {
    const directory = join(statesDir, name)
    const valid = await (async () => {
      try {
        // metadata 必须同时绑定顺序、source 身份、target 基线和两份 manifest 内容。
        // repo 存在但 provenance 不匹配时仍是 stale，不能提供给主 agent 调查。
        const value: unknown = await Bun.file(join(directory, "state.json")).json()
        if (!isMaterializedState(value) || value.index > manifest.commits.length) return false
        const metadata = value
        const entry = manifest.commits[metadata.index - 1]
        const expectedSha = metadata.index === 0 ? manifest.targetBaseline : entry?.sha
        if (!expectedSha || metadata.sha !== expectedSha || name !== materializedStateName(metadata.index, expectedSha)) return false
        if (metadata.head !== manifest.targetBaseline || metadata.targetBaseline !== manifest.targetBaseline) return false
        if (metadata.manifestJsonSha256 !== manifestJsonSha256 || metadata.manifestTsvSha256 !== manifestTsvSha256) return false
        if (metadata.cumulativePatchSha256 !== (await cumulativePatchSha256(manifest.commits.slice(0, metadata.index)))) return false
        const repo = join(directory, metadata.repo)
        if (!(await Bun.file(join(repo, ".git", "HEAD")).exists())) return false
        if (requireGit(repo, ["rev-parse", "HEAD"]).trim() !== manifest.targetBaseline) return false
        const status = requireGit(repo, ["status", "--porcelain", "--untracked-files=all"])
        const worktreeDiff = requireGit(repo, ["diff", "--binary", "--full-index", "--no-ext-diff"])
        const indexDiff = requireGit(repo, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"])
        return (
          metadata.statusSha256 === sha256(status) &&
          metadata.worktreeDiffSha256 === sha256(worktreeDiff) &&
          metadata.indexDiffSha256 === sha256(indexDiff)
        )
      } catch {
        // 无法解析的 metadata 没有可证明身份，必须视为中断或损坏状态并回收。
        return false
      }
    })()
    // stale 状态不能为了便于回退而保留；回退必须重新物化可证明的历史前缀。
    if (!valid) await rm(directory, { recursive: true, force: true })
  }
}

async function orderedMaterializedStates() {
  const states = (
    await Promise.all(
      (await materializedStateDirectories()).map(async (name) => {
        try {
          const value: unknown = await Bun.file(join(statesDir, name, "state.json")).json()
          if (!isMaterializedState(value)) {
            await rm(join(statesDir, name), { recursive: true, force: true })
            return
          }
          return { name, metadata: value }
        } catch {
          // 排序入口同样拒绝损坏 metadata，避免失败报告被一个坏状态再次打断。
          await rm(join(statesDir, name), { recursive: true, force: true })
          return
        }
      }),
    )
  ).filter((state): state is { name: string; metadata: MaterializedState } => state !== undefined)
  // 每个发布目录携带自己的成功时间；回收依据真实发布时间，不依据 index 大小。
  return states.toSorted(
    (left, right) => right.metadata.builtAt.localeCompare(left.metadata.builtAt) || right.metadata.index - left.metadata.index,
  )
}

async function pruneMaterializedStates() {
  // 保留顺序按成功发布时间决定；index 大小不能代表最近一次实际构建。
  const ordered = await orderedMaterializedStates()
  // 第六个成功状态发布后立即回收最旧目录，失败构建从不进入该集合。
  await Promise.all(ordered.slice(maxMaterializedStates).map((state) => rm(join(statesDir, state.name), { recursive: true, force: true })))
  return ordered.slice(0, maxMaterializedStates).map((state) => state.name)
}

async function publishMaterializedState(tempRoot: string, stateName: string) {
  // 发布事务同时保护同 index 旧状态和容量回收对象，任何 rename 失败都恢复二者。
  const stateDirectory = join(statesDir, stateName)
  const ordered = await orderedMaterializedStates()
  const existing = ordered.find((state) => state.name === stateName)
  const evictions = ordered.filter((state) => state.name !== stateName).slice(maxMaterializedStates - 1)
  const moving = [existing, ...evictions].filter(
    (state, index, states): state is { name: string; metadata: MaterializedState } =>
      state !== undefined && states.findIndex((candidate) => candidate?.name === state.name) === index,
  )
  // 先把旧同 index 状态和必要的最旧状态移入事务备份，使新状态出现时总数不超过五个。
  const backup = await mkdtemp(join(statesDir, `.backup-${randomUUID()}-`))
  await Bun.write(join(backup, "publication.json"), `${JSON.stringify({ target: stateName })}\n`)
  try {
    for (const state of moving) await rename(join(statesDir, state.name), join(backup, state.name))
    // rename 在同一文件系统内发布完整 staging；失败时 catch 会恢复全部旧成功状态。
    await rename(tempRoot, stateDirectory)
  } catch (error) {
    for (const state of moving) {
      const source = join(backup, state.name)
      if (await Bun.file(join(source, "state.json")).exists()) await rename(source, join(statesDir, state.name))
    }
    await rm(backup, { recursive: true, force: true })
    throw error
  }
  await rm(backup, { recursive: true, force: true })
  return stateDirectory
}

async function writeReports(report: Report, runID: string) {
  // JSON 服务后续机械核验，Markdown 服务人工审计；两者必须来自同一个 report。
  // latest 只是导航指针，带 runID 的历史报告才是某次执行的稳定证据。
  await mkdir(reportsDir, { recursive: true })
  const jsonPath = join(reportsDir, `${runID}.json`)
  const markdownPath = join(reportsDir, `${runID}.md`)
  await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `# Patch Dry Run ${runID}`,
    "",
    `- Source: \`${report.sourceRef}\``,
    `- Source tip: \`${report.sourceTip}\``,
    `- Mode: ${report.mode}`,
    `- Target baseline: \`${report.targetBaseline}\``,
    `- Manifest JSON SHA-256: \`${report.manifestJsonSha256}\``,
    `- Manifest TSV SHA-256: \`${report.manifestTsvSha256}\``,
    `- Patch count: ${report.patchCount}`,
    `- Passed: ${report.passed}`,
    `- Stopped at: ${report.stoppedAt ?? "none"}`,
    `- Temporary repo: ${report.temporaryRepo ? `\`${report.temporaryRepo}\`` : "cleaned"}`,
    `- Materialized index: ${report.materializedIndex ?? "none"}`,
    `- State directory: ${report.stateDirectory ? `\`${report.stateDirectory}\`` : "none"}`,
    `- Retained states: ${report.retainedStates?.join(", ") || "none"}`,
    `- Source repository unchanged: ${report.sourceRepoHeadAfter === undefined ? "pending" : report.sourceRepoHeadBefore === report.sourceRepoHeadAfter && report.sourceRepoFingerprintBefore === report.sourceRepoFingerprintAfter}`,
    `- Target repository unchanged: ${report.targetRepoFingerprintAfter === undefined ? "pending" : report.targetRepoFingerprintBefore === report.targetRepoFingerprintAfter}`,
    `- Simulation preflight: ${report.simulationPreflight ? `clean at \`${report.simulationPreflight.head}\`` : "pending"}`,
    report.integrityFailure ? `- Integrity failure: ${report.integrityFailure}` : "",
    "",
    "| # | SHA | Status | Phase | Reason | Subject |",
    "|---:|---|---|---|---|---|",
    ...report.outcomes.map((outcome) =>
      `| ${outcome.index} | \`${outcome.sha.slice(0, 12)}\` | ${outcome.status} | ${outcome.phase} | ${outcome.reason} | ${outcome.subject.replace(/\|/g, "\\|")} |`,
    ),
    "",
    "## Failure Output",
    "",
    report.outcomes
      .filter((outcome) => outcome.status === "failed")
      .map((outcome) => `### #${outcome.index} ${outcome.sha}\n\n\`\`\`text\n${[outcome.stdout, outcome.stderr].filter(Boolean).join("\n") || "(no output)"}\n\`\`\``)
      .join("\n\n") || "No failures.",
    "",
  ]
  await Bun.write(markdownPath, lines.join("\n"))
  await Bun.write(join(reportsDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(join(reportsDir, "latest.md"), lines.join("\n"))
}

async function checkpoint(repo: string, path: string) {
  // checkpoint 只保存已经成功的累计 diff，失败恢复不会重新解释任何 patch。
  // 每轮 check 前重建快照，确保 rollback 精确落在上一成功 index。
  requireGit(repo, ["add", "--all"])
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repo, "diff", "--cached", "--binary", "--full-index", "--no-ext-diff"],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  await Bun.write(path, result.stdout)
}

async function restore(repo: string, baseline: string, checkpointPath: string) {
  // 先回到 exact baseline，再恢复最后成功快照，保证失败 patch 没有残留状态。
  requireGit(repo, ["reset", "--hard", baseline])
  requireGit(repo, ["clean", "-fdx"])
  if ((await Bun.file(checkpointPath).arrayBuffer()).byteLength === 0) return
  requireGit(repo, ["apply", "--index", checkpointPath])
}

async function main() {
  const keepFailure = process.argv.includes("--keep-failure")
  const manifestPath = join(patchRoot, "manifest.json")
  const manifestTsvPath = join(patchRoot, "manifest.tsv")
  const manifestInput: unknown = await Bun.file(manifestPath).json()
  if (!isManifest(manifestInput)) throw new Error("manifest JSON does not match schema version 1")
  const manifest = manifestInput
  // manifest 验证发生在模式解析之前，任何命令都不能绕过 452 项集合证明。
  await validateManifest(manifest, manifestTsvPath)
  const materializeIndex = parseMaterializeIndex(manifest)
  const selectedCommits = manifest.commits.slice(0, materializeIndex ?? manifest.commits.length)
  const manifestJsonSha256 = await fileSha256(manifestPath)
  const manifestTsvSha256 = await fileSha256(manifestTsvPath)
  if (materializeIndex !== undefined) {
    await removeInterruptedBuilds()
    await removeStaleMaterializedStates(manifest, manifestJsonSha256, manifestTsvSha256)
    // 中断恢复可能还原第六个旧状态，正式构建前再次收敛到最近五个。
    await pruneMaterializedStates()
  }
  const sourceRepoHeadBefore = requireGit(sourceRepo, ["rev-parse", "HEAD"]).trim()
  // 主仓库允许已有用户修改，但脚本运行期间必须保持同一 HEAD 和状态指纹。
  const sourceRepoFingerprintBefore = await repositoryFingerprint(sourceRepo)
  const report: Report = {
    schemaVersion: 1,
    mode: materializeIndex === undefined ? "verify-all" : "materialize",
    startedAt: new Date().toISOString(),
    manifestJsonSha256,
    manifestTsvSha256,
    sourceRef: manifest.sourceRef,
    sourceTip: manifest.sourceTip,
    targetBaseline: manifest.targetBaseline,
    patchCount: selectedCommits.length,
    passed: 0,
    materializedIndex: materializeIndex,
    sourceRepoHeadBefore,
    sourceRepoFingerprintBefore,
    targetRepoFingerprintBefore: "",
    outcomes: [],
  }
  const runID = `${report.mode}-${materializeIndex === undefined ? "" : String(materializeIndex).padStart(4, "0") + "-"}${report.startedAt.replace(/[:.]/g, "-")}`
  report.targetRepoFingerprintBefore = await repositoryFingerprint(targetRepo)
  // 目标 worktree 可以在 baseline 之后继续提交；只要求 immutable baseline 对象仍可独立 clone。
  requireGit(targetRepo, ["cat-file", "-e", manifest.targetBaseline + "^{commit}"])

  // 物化构建位于 states 同一文件系统，成功目录发布可以使用原子 rename。
  const tempRoot = await mkdtemp(
    materializeIndex === undefined ? join(tmpdir(), "smark-patch-dry-run-") : join(statesDir, ".building-"),
  )
  const simulationRepo = join(tempRoot, "repo")
  const checkpointPath = join(tempRoot, "last-success.patch")
  await Bun.write(checkpointPath, new Uint8Array())
  // 从目标仓库复制测试环境，避免依赖父仓库当前 HEAD 或目标 worktree 的脏内容。
  requireGit(tempRoot, ["clone", "--no-local", "--no-hardlinks", targetRepo, simulationRepo])
  requireGit(simulationRepo, ["checkout", "--detach", manifest.targetBaseline])
  // 物化状态必须从空白 exact baseline 开始，不能继承主工作区或旧状态内容。
  const simulationStatus = requireGit(simulationRepo, ["status", "--porcelain", "--untracked-files=all"])
  const simulationWorktreeDiff = requireGit(simulationRepo, ["diff", "--binary", "--full-index", "--no-ext-diff"])
  const simulationIndexDiff = requireGit(simulationRepo, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"])
  const simulationHead = requireGit(simulationRepo, ["rev-parse", "HEAD"]).trim()
  report.simulationPreflight = {
    head: simulationHead,
    statusSha256: sha256(simulationStatus),
    worktreeDiffSha256: sha256(simulationWorktreeDiff),
    indexDiffSha256: sha256(simulationIndexDiff),
  }
  if (simulationHead !== manifest.targetBaseline || simulationStatus || simulationWorktreeDiff || simulationIndexDiff) {
    throw new Error("simulation clone is not a clean exact target-baseline clone")
  }

  // 循环严格按 manifest 前缀推进；首个失败会阻断所有更高 index。
  for (const entry of selectedCommits) {
    const patchPath = resolve(patchRoot, entry.currentPatch)
    const outcomeBase = {
      index: entry.index,
      sha: entry.sha,
      subject: entry.subject,
      patch: entry.currentPatch,
      cumulativeChangedFiles: [],
    }

    if (!(await Bun.file(patchPath).exists())) {
      report.stoppedAt = entry.index
      report.outcomes.push({ ...outcomeBase, status: "failed", phase: "setup", reason: "file-not-found", stdout: "", stderr: `missing patch: ${patchPath}` })
      break
    }

    await checkpoint(simulationRepo, checkpointPath)
    // check 与 apply 使用同一个 patch 和 index；check 失败后禁止尝试后续项。
    const check = runGit(simulationRepo, ["apply", "--check", "--index", "--verbose", patchPath])
    if (check.exitCode !== 0) {
      await restore(simulationRepo, manifest.targetBaseline, checkpointPath)
      report.stoppedAt = entry.index
      report.outcomes.push({ ...outcomeBase, status: "failed", phase: "check", reason: classifyFailure(commandText(check)), stdout: check.stdout, stderr: check.stderr })
      break
    }

    const apply = runGit(simulationRepo, ["apply", "--index", patchPath])
    if (apply.exitCode !== 0) {
      await restore(simulationRepo, manifest.targetBaseline, checkpointPath)
      report.stoppedAt = entry.index
      report.outcomes.push({ ...outcomeBase, status: "failed", phase: "apply", reason: classifyFailure(commandText(apply)), stdout: apply.stdout, stderr: apply.stderr })
      break
    }

    const cumulativeChangedFiles = requireGit(simulationRepo, ["diff", "--cached", "--name-status"]).trim().split("\n").filter(Boolean)
    // outcome 在每项成功后立即落盘，避免进程中断后由摘要倒推已经完成的范围。
    report.passed += 1
    report.outcomes.push({ ...outcomeBase, status: "passed", phase: "apply", reason: "applied", cumulativeChangedFiles, stdout: apply.stdout, stderr: apply.stderr })
    await writeReports(report, runID)
  }

  report.finishedAt = new Date().toISOString()
  // 源仓库和目标工作区在运行前后必须逐字保持同一 HEAD 与状态指纹。
  const sourceRepoHeadAfter = requireGit(sourceRepo, ["rev-parse", "HEAD"]).trim()
  report.sourceRepoHeadAfter = sourceRepoHeadAfter
  report.sourceRepoFingerprintAfter = await repositoryFingerprint(sourceRepo)
  report.targetRepoFingerprintAfter = await repositoryFingerprint(targetRepo)
  if (sourceRepoHeadAfter !== sourceRepoHeadBefore || report.sourceRepoFingerprintAfter !== report.sourceRepoFingerprintBefore) {
    report.integrityFailure = "source repository changed during dry-run"
  }
  if (report.targetRepoFingerprintAfter !== report.targetRepoFingerprintBefore) {
    report.integrityFailure = "target repository changed during dry-run"
  }
  if (report.stoppedAt !== undefined || report.integrityFailure) {
    // 物化失败始终回收 staging；保留失败 clone 只适用于显式 dry-run 诊断。
    if (keepFailure && materializeIndex === undefined) report.temporaryRepo = simulationRepo
    else await rm(tempRoot, { recursive: true, force: true })
  } else if (materializeIndex !== undefined) {
    // 只有完整前缀通过且仓库指纹未漂移时，staging 才具有发布资格。
    const entry = selectedCommits.at(-1)
    const stateIndex = entry?.index ?? 0
    const stateSha = entry?.sha ?? manifest.targetBaseline
    const stateName = materializedStateName(stateIndex, stateSha)
    const stateStatus = requireGit(simulationRepo, ["status", "--porcelain", "--untracked-files=all"])
    const stateWorktreeDiff = requireGit(simulationRepo, ["diff", "--binary", "--full-index", "--no-ext-diff"])
    const stateIndexDiff = requireGit(simulationRepo, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"])
    const metadata: MaterializedState = {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      index: stateIndex,
      sha: stateSha,
      head: simulationHead,
      targetBaseline: manifest.targetBaseline,
      manifestJsonSha256,
      manifestTsvSha256,
      cumulativePatchSha256: await cumulativePatchSha256(selectedCommits),
      statusSha256: sha256(stateStatus),
      worktreeDiffSha256: sha256(stateWorktreeDiff),
      indexDiffSha256: sha256(stateIndexDiff),
      repo: "repo",
    }
    // metadata 与 repo 在 staging 中共同完成后才替换旧的同 index 状态。
    await rm(checkpointPath, { force: true })
    await Bun.write(join(tempRoot, "state.json"), `${JSON.stringify(metadata, null, 2)}\n`)
    const stateDirectory = await publishMaterializedState(tempRoot, stateName)
    // 同 index 重建先替换旧目录，再按发布时间回收，保证全局最多五个成功状态。
    report.stateDirectory = stateDirectory
    report.retainedStates = await pruneMaterializedStates()
  } else {
    await rm(tempRoot, { recursive: true, force: true })
  }
  // 失败报告也必须展示仍可使用的历史状态，不能把“本次未发布”写成“没有状态”。
  if (materializeIndex !== undefined && report.retainedStates === undefined) {
    report.retainedStates = (await orderedMaterializedStates()).map((state) => state.name)
  }
  await writeReports(report, runID)
  console.log(`passed ${report.passed}/${report.patchCount}`)
  if (report.stoppedAt !== undefined || report.integrityFailure) {
    console.error(report.integrityFailure ?? `stopped at patch #${report.stoppedAt}`)
    process.exitCode = 1
  } else if (report.stateDirectory) {
    console.log(`materialized patch state #${materializeIndex} at ${report.stateDirectory}`)
  }
}

await main()
