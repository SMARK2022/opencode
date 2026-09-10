export async function verifyRemoteAnnotatedTagCommit(input: {
  repository: string
  tag: string
  cwd: string
  expectedCommit: string | undefined
}) {
  // 只构造tag namespace下的完整ref，避免同名branch或用户输入被Git按模糊revision规则解析。
  const ref = `refs/tags/${input.tag}`
  // ls-remote读取public producer的当前ref，不要求shallow submodule预先下载本地tag对象。
  // 查询保持只读且不fetch到工作树，CI shallow checkout的对象集合不会成为验证结果的一部分。
  const proc = Bun.spawn(["git", "ls-remote", "--tags", input.repository, ref, `${ref}^{}`], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  // 同时排空两个pipe，远端错误较长时也不能因stderr背压掩盖真实exit code。
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr || `git ls-remote ${input.repository} ${ref} exited ${code}`)
  // Map以完整ref名为identity，输出顺序变化不会影响base与peeled两项的配对。
  const refs = new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, name] = line.trim().split(/\s+/, 2)
        return [name, commit] as const
      }),
  )
  // base ref与peeled ref分开检查，才能区分“发布不存在”和“存在但不是annotated tag”。
  if (!refs.has(ref)) throw new Error(`OpenTUI release tag ${input.tag} was not found in ${input.repository}`)
  // annotated tag必须提供peeled commit；接受lightweight ref会丢失tag object这一独立发布身份。
  const commit = refs.get(`${ref}^{}`)
  if (!commit) throw new Error(`OpenTUI release ${input.tag} is not an annotated tag in ${input.repository}`)
  // remote tag与root gitlink是两个独立producer；解析成功但身份不等仍必须在同一provenance seam失败。
  if (!input.expectedCommit || commit !== input.expectedCommit) {
    throw new Error(`OpenTUI gitlink ${input.expectedCommit} does not match ${input.tag} commit ${commit}`)
  }
  return commit
}
