import { mkdir, readdir } from "node:fs/promises"
import { resolve } from "node:path"

type CommitEntry = {
  // index 固定后续 patch、record 和审计批次的唯一顺序。
  index: number
  // SHA 与 parent 从 source Git 读取，禁止由文件名推导或手工录入。
  sha: string
  parent: string
  author: string
  email: string
  authoredAt: string
  subject: string
  // original/current 路径必须由同一 index 和 SHA 生成，防止映射错位。
  originalPatch: string
  currentPatch: string
}

type Manifest = {
  // schemaVersion 让后续验证器能够拒绝未知生成格式，而不是猜测字段含义。
  schemaVersion: 1
  generatedAt: string
  // sourceRef 是人类可读标签，sourceTip 才是这次集合的不可变边界。
  sourceRepo: string
  sourceRef: string
  sourceTip: string
  // firstSmarkCommit 和 forkBase 固定迁移的历史起点与比较基线。
  firstSmarkCommit: string
  forkBase: string
  targetRepo: string
  targetBaseline: string
  selection: string
  // commits 必须完整写出，不生成隐含范围或可选子集。
  commits: CommitEntry[]
}

const targetRepo = resolve(import.meta.dir, "../../..")
const sourceRepo = resolve(targetRepo, "../..")
const patchRoot = resolve(targetRepo, ".temp/patches")
const originalDir = resolve(patchRoot, "original")
const currentDir = resolve(patchRoot, "current")

function runGit(cwd: string, args: string[]) {
  // 文本命令只用于 metadata 和引用解析，失败时保留完整 stderr 供定位。
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`)
  }
  return stdout
}

function runGitBytes(cwd: string, args: string[]) {
  // patch 可能含二进制 payload，生成过程必须保留 stdout 原始字节。
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode})\n${stderr}`)
  }
  return result.stdout
}

async function requireEmpty(directory: string) {
  // 原始 patch 一旦生成就成为证据；非空目录意味着可能覆盖既有事实。
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory)
  if (entries.length > 0) {
    throw new Error(`refusing to overwrite non-empty patch directory: ${directory}`)
  }
}

function isSmarkAuthor(name: string, email: string) {
  // 作者识别兼容显示名和稳定邮箱，避免提交显示名变化导致起点漂移。
  return /^(smark|smark2022)$/i.test(name.trim()) || email.trim().toLowerCase() === "3222301373@qq.com"
}

function hasExternalChanges(status: string) {
  // 只允许生成器自身的 ignored 工件和已授权 gitignore；其他变化会污染 baseline。
  return status
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const path = line.slice(3)
      return path !== ".gitignore" && path !== ".temp/patches" && !path.startsWith(".temp/patches/")
    })
}

function commitMetadata(sha: string) {
  // 每项 metadata 直接读取 source commit，manifest 不接受摘要或人工复制值。
  const lines = runGit(sourceRepo, ["show", "-s", "--format=%H%n%P%n%an%n%ae%n%aI%n%s", sha]).trimEnd().split("\n")
  return {
    sha: lines[0],
    parent: lines[1]?.split(" ")[0] ?? "",
    author: lines[2] ?? "",
    email: lines[3] ?? "",
    authoredAt: lines[4] ?? "",
    subject: lines.slice(5).join("\n"),
  }
}

async function main() {
  // 生成器只负责建立一次不可变输入集合，后续适配绝不能重新生成 original。
  await requireEmpty(originalDir)
  await requireEmpty(currentDir)

  const targetBaseline = runGit(targetRepo, ["rev-parse", "HEAD"]).trim()
  // target baseline 来自目标当前 commit；目标 worktree 的未提交内容不进入 patch。
  const targetStatus = runGit(targetRepo, ["status", "--porcelain"])
  if (hasExternalChanges(targetStatus)) {
    throw new Error("target worktree is dirty; patch generation refuses to use a moving baseline")
  }

  // branch 会继续前进，因此先钉住本次生成的 source tip，再用该 SHA 枚举历史。
  const sourceTip = runGit(sourceRepo, ["rev-parse", "dev-smark"]).trim()
  const authorRecords = runGit(sourceRepo, ["log", "--first-parent", "--reverse", "--format=%H%x00%an%x00%ae", sourceTip])
    .split("\n")
    .filter(Boolean)
    .map((record) => {
      const [sha, author, email] = record.split("\0")
      return { sha, author, email }
    })
  const firstSmark = authorRecords.find((record) => isSmarkAuthor(record.author, record.email))
  // 找不到稳定作者起点时宁可停止，也不能从一个看似相关的 subject 猜起点。
  if (!firstSmark) {
    throw new Error("could not identify the first SMARK/SMARK2022 commit on dev-smark first-parent history")
  }

  const forkBase = runGit(sourceRepo, ["rev-parse", firstSmark.sha + "^"]).trim()
  // 只收集第一父线非 merge commit，避免把 merge 的重复语义引入迁移顺序。
  const commits = runGit(sourceRepo, ["rev-list", "--first-parent", "--reverse", "--no-merges", firstSmark.sha + "^.." + sourceTip])
    .trim()
    .split("\n")
    .filter(Boolean)
  const entries: CommitEntry[] = []

  for (const [position, sha] of commits.entries()) {
    // 每个 source commit 单独生成邮件 patch，后续可以逐项调查、编辑和回滚。
    const metadata = commitMetadata(sha)
    const patchNumber = String(position + 1).padStart(4, "0")
    // 文件名同时编码顺序和 source 身份，防止人工移动后仍被错误 index 消费。
    const filename = patchNumber + "-" + sha.slice(0, 12) + ".patch"
    const originalPatch = resolve(originalDir, filename)
    const currentPatch = resolve(currentDir, filename)

    // 原始 patch 保留完整邮件头和二进制 diff，后续只允许编辑 current 副本。
    // current 初始复制 original，确保首次适配前两份证据完全一致。
    await Bun.write(originalPatch, runGitBytes(sourceRepo, ["format-patch", "--stdout", "--no-stat", "--full-index", "--binary", "--no-signature", "-1", sha]))
    await Bun.write(currentPatch, Bun.file(originalPatch))
    entries.push({
      index: position + 1,
      ...metadata,
      originalPatch: "original/" + filename,
      currentPatch: "current/" + filename,
    })
  }

  const manifest: Manifest = {
    // manifest 的 sourceTip 把生成时的移动 branch 转换为稳定审计边界。
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRepo,
    sourceRef: "dev-smark",
    sourceTip,
    firstSmarkCommit: firstSmark.sha,
    forkBase,
    targetRepo,
    targetBaseline,
    selection: "first-parent non-merge commits from the first SMARK/SMARK2022 commit through the pinned source tip",
    commits: entries,
  }
  // JSON 是脚本权威输入；写完后 apply 脚本会再次从 source 独立重建和校验。
  await Bun.write(resolve(patchRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

  const tsv = [
    // TSV 供人工审阅和独立 auditor 使用，必须与 JSON commits 逐行同序。
    "index\tsha\tparent\tauthor\temail\tauthoredAt\tsubject\toriginalPatch\tcurrentPatch",
    ...entries.map((entry) =>
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
  ].join("\n")
  // 两份 manifest 视图同时落盘，任何内容漂移都会在下一次物化前被拒绝。
  await Bun.write(resolve(patchRoot, "manifest.tsv"), tsv + "\n")
  console.log(`generated ${entries.length} patches`)
  console.log(`first SMARK commit: ${firstSmark.sha}`)
  console.log(`fork base: ${forkBase}`)
  console.log(`target baseline: ${targetBaseline}`)
}

await main()
