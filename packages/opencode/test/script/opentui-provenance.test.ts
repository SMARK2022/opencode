import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { verifyRemoteAnnotatedTagCommit, verifySourceRevisionAuthorization } from "../../script/opentui-provenance"
import { tmpdir } from "../fixture/fixture"

test("resolves an annotated release tag from a remote when the shallow checkout has no tags", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const shallow = path.join(tmp.path, "shallow")
  await fs.mkdir(source, { recursive: true })
  await git(["init"], source)
  await git(["config", "user.email", "test@opencode.test"], source)
  await git(["config", "user.name", "Test"], source)
  await Bun.write(path.join(source, "source.txt"), "immutable source\n")
  await git(["add", "source.txt"], source)
  await git(["commit", "-m", "release source"], source)
  await git(["tag", "-a", "v0.4.3-smark.6", "-m", "immutable release"], source)
  await git(["tag", "v0.4.3-lightweight"], source)
  const commit = (await git(["rev-parse", "HEAD"], source)).stdout.trim()
  // tag后再提交生成同仓库的有效mismatch，避免用伪造hash绕过远端确实包含该commit的现实条件。
  await Bun.write(path.join(source, "source.txt"), "new untagged source\n")
  await git(["commit", "-am", "move gitlink candidate"], source)
  const mismatch = (await git(["rev-parse", "HEAD"], source)).stdout.trim()
  const repository = pathToFileURL(source).href

  // file:// 强制 Git 遵守 depth/no-tags；直接复制本地目录会把完整 refs 带进 fixture。
  await git(["clone", "--depth", "1", "--no-tags", repository, shallow], tmp.path)
  const local = await git(["rev-parse", "v0.4.3-smark.4^{commit}"], shallow, false)
  expect(local.code).not.toBe(0)

  // resolver 读取 remote 的 peeled ref，不依赖 actions/checkout 是否附带 submodule tag refs。
  expect(
    await verifyRemoteAnnotatedTagCommit({
      repository,
      tag: "v0.4.3-smark.6",
      cwd: shallow,
      expectedCommit: commit,
    }),
  ).toBe(commit)
  // 有效annotated tag也必须与gitlink相等；只测试resolver成功会遗漏closure比较被删除的回归。
  await expect(
    verifyRemoteAnnotatedTagCommit({
      repository,
      tag: "v0.4.3-smark.6",
      cwd: shallow,
      expectedCommit: mismatch,
    }),
  ).rejects.toThrow("does not match")
  // provenance gate 只接受 annotated tag；lightweight tag 没有独立 peeled ref，不能降级成成功。
  await expect(
    verifyRemoteAnnotatedTagCommit({
      repository,
      tag: "v0.4.3-lightweight",
      cwd: shallow,
      expectedCommit: commit,
    }),
  ).rejects.toThrow("annotated tag")
  // missing与lightweight必须分别断言，二者虽都没有peeled commit，却对应不同发布诊断和修复动作。
  await expect(
    verifyRemoteAnnotatedTagCommit({
      repository,
      tag: "v0.4.3-missing",
      cwd: shallow,
      expectedCommit: commit,
    }),
  ).rejects.toThrow("not found")
})

test("source-authorized closure rejects a clean source revision outside the manifest", () => {
  // negative fixture保持parent/nested两处一致，只改变manifest authority，锁定真正的失败边界。
  const authorized = "a".repeat(40)
  const unauthorized = "b".repeat(40)
  const manifest = {
    schema: 1 as const,
    sourceGitlink: authorized,
    releaseTag: "v0.4.3-smark.6" as const,
    releaseCommit: "c".repeat(40),
  }

  expect(() =>
    verifySourceRevisionAuthorization({
      parentGitlink: authorized,
      nestedHead: authorized,
      nestedStatus: "",
      manifest,
    }),
  ).not.toThrow()

  expect(() =>
    verifySourceRevisionAuthorization({
      parentGitlink: unauthorized,
      nestedHead: unauthorized,
      nestedStatus: "",
      manifest,
    }),
  ).toThrow("authorized source revision")
})

async function git(args: string[], cwd: string, required = true) {
  // helper返回非零结果仅服务预期red probe，其余fixture命令必须立即失败，不能制造虚假的shallow前提。
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  // fixture setup失败必须保留原始Git stderr；只有预期的local tag缺失允许返回非零结果。
  if (required && code !== 0) throw new Error(stderr || `git ${args.join(" ")} exited ${code}`)
  return { code, stdout, stderr }
}
