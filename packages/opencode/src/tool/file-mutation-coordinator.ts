import { Effect, Semaphore } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Hash } from "@opencode-ai/core/util/hash"

export type FileVersion =
  | { state: "absent" }
  | { state: "file"; fingerprint: string }
  | { state: "other"; kind: string }

// coordinator 只保存一次 execute 内的短生命周期事实，不把 version 放进 Tool schema、Message 或 DB。
// `file` 的 fingerprint 覆盖完整 raw bytes，避免 size/mtime 或 head sample 把变化隐藏起来。
// `absent`/`file` 的区分只解决可观测的状态变化，不扩展成 inode generation 或跨进程事务。
// 这使 coordinator 保持在 built-in Tool seam，而不是吸收 filesystem 全局治理职责。

export type MutationRead = {
  path: string
  canonicalPath: string
  version: FileVersion
  bytes: Uint8Array
}

// proposal owner 消费 bytes，commit owner 消费 version/path；两个字段必须来自同一 read。

export class MutationConflict extends Error {
  constructor(filePath: string) {
    // conflict 是 diagnostic/error outcome；调用方必须重新 read，不能复用旧 Permission。
    super(`File changed while waiting for permission: ${filePath}. Read the file again and retry.`)
    this.name = "MutationConflict"
  }
}

// version 同时描述路径状态和内容身份；空文件必须与不存在路径分开，避免 create proposal
// 在 Permission 等待期间遇到外部创建的空文件时仍被误判为 unchanged。

type QueueEntry = {
  semaphore: Semaphore.Semaphore
  users: number
}

// users 是引用计数而非 permit 数：等待者尚未取得 permit，也必须阻止历史 entry 被删除。
// 这避免新调用创建第二个 semaphore 后与旧 waiter 并行写入同一 canonical path。

const queues = new Map<string, QueueEntry>()

export function read(fs: AppFileSystem.Interface, filePath: string) {
  return Effect.gen(function* () {
    const canonicalPath = AppFileSystem.resolve(filePath)
    // canonicalization 只复用既有 realpath/resolved fallback，不扩展 hard-link 或 lstat identity。
    const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info) {
      // 缺失路径保留 resolved fallback key；后续路径变成 existing file 会在 commit recheck 冲突。
      // proposal owner 仍可把 bytes 当作空文本，但 version 永远保留 absent 标签。
      return {
        path: filePath,
        canonicalPath,
        version: { state: "absent" as const },
        bytes: new Uint8Array(),
      }
    }
    if (info.type !== "File") {
      // Directory 等非文件状态不进入 proposal 成功域，避免 writeFile 的底层错误成为隐式分支。
      // 这里返回 other 供 Tool 在 Permission 前拒绝，而不是把错误延迟到 commit callback。
      return {
        path: filePath,
        canonicalPath,
        version: { state: "other" as const, kind: String(info.type) },
        bytes: new Uint8Array(),
      }
    }
    // fingerprint 与 proposal 消费的 bytes 来自同一次读取，禁止在 proposal 后补读版本。
    const bytes = yield* fs.readFile(filePath)
    return {
      path: filePath,
      canonicalPath,
      version: { state: "file" as const, fingerprint: Hash.fast(Buffer.from(bytes)) },
      bytes,
    }
  })
}

export function decode(readResult: MutationRead) {
  // decoder 与原 Bom.readFile 保持 UTF-8/ignoreBOM 语义，coordinator 不接管文本匹配。
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(readResult.bytes)
}

export type CommitInput<A, E> = {
  fs: AppFileSystem.Interface
  expected: readonly MutationRead[]
  execute: Effect.Effect<A, E>
}

// caller 必须先完成 proposal 与 Permission；commit 只接受已构造的 content，不重新匹配输入文本。

export function commit<A, E>(input: CommitInput<A, E>) {
  // Permission 已在 caller 完成；这里才注册 key，因此审批时间不会阻塞同文件的其他 proposal。
  const entries = register(input.expected)
  const run = withLocks(
    entries,
    Effect.gen(function* () {
      for (const expected of input.expected) {
        const current = yield* read(input.fs, expected.path)
        // 所有 expected state 都在第一笔写入前检查；冲突不触发 retry 或 stale partial commit。
        if (!sameVersion(expected.version, current.version)) {
          return yield* Effect.fail(new MutationConflict(expected.path))
        }
      }
      return yield* input.execute
    }),
  )
  // ensuring 覆盖 success、conflict、I/O error、formatter error 和 interruption。
  return run.pipe(Effect.ensuring(Effect.sync(() => unregister(entries))))
}

function register(reads: readonly MutationRead[]) {
  const entries = new Map<string, QueueEntry>()
  // 同一次多文件 commit 只注册每个 canonical key 一次，避免重复 permit 与错误 cleanup。
  for (const readResult of reads) {
    if (entries.has(readResult.canonicalPath)) continue
    // canonical key 使用 path identity，而不是 content fingerprint；同内容不同文件仍可并发。
    const current = queues.get(readResult.canonicalPath)
    const entry = current ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    entry.users++
    // users 覆盖 holder 与 waiter；只有最后一个引用离开时才允许删除 Map entry。
    queues.set(readResult.canonicalPath, entry)
    entries.set(readResult.canonicalPath, entry)
  }
  return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function withLocks<A, E>(entries: Array<[string, QueueEntry]>, effect: Effect.Effect<A, E>) {
  // 所有 key 按 canonical 字典序嵌套，既保持不同文件并发，也避免 multi-file deadlock。
  return entries.reduceRight((next, [, entry]) => entry.semaphore.withPermits(1)(next), effect)
}

function unregister(entries: Array<[string, QueueEntry]>) {
  for (const [key, entry] of entries) {
    entry.users--
    // 已经有 successor 时 users 不会归零；旧 entry 继续服务原有 waiter。
    // identity 检查防止旧 tail 释放时删除已被新 waiter 接管的 entry。
    if (entry.users === 0 && queues.get(key) === entry) queues.delete(key)
  }
}

function sameVersion(expected: FileVersion, current: FileVersion) {
  // state 先比较，只有两个 file state 才比较 fingerprint；empty file 不会等同 absent。
  if (expected.state !== current.state) return false
  // absent -> empty 是状态变化；file -> same bytes 的 ABA 则保持明确的不可观测边界。
  if (expected.state === "other" && current.state === "other") return expected.kind === current.kind
  if (expected.state !== "file" || current.state !== "file") return true
  return expected.fingerprint === current.fingerprint
}
