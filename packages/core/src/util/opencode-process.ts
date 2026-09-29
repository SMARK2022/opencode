// 普通Shell只剥离宿主的运行身份，PATH、代理和用户环境仍原样交给子进程。
export function sanitizedProcessEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  delete env.OPENCODE_RUN_ID
  delete env.OPENCODE_PROCESS_ROLE
  return env
}

