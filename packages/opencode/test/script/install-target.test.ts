import { describe, expect, test } from "bun:test"
import { resolveInstallTarget } from "../../script/install-target"

describe("resolveInstallTarget", () => {
  // macOS CI 传 --os=darwin，需要 darwin-arm64 和 darwin-x64 两个原生包
  test("--os=darwin 且无 --arch 时安装该 OS 的全部 arch 变体", () => {
    expect(resolveInstallTarget("darwin", undefined, false)).toEqual({ os: "darwin", cpu: "*" })
  })

  // Windows CI 传 --os=win32 --arch=x64，精确到单个平台变体
  test("--os=win32 --arch=x64 精确到单 arch", () => {
    expect(resolveInstallTarget("win32", "x64", false)).toEqual({ os: "win32", cpu: "x64" })
  })

  // Linux CI 传 --os=linux，需两个 arch
  test("--os=linux 且无 --arch 时安装该 OS 的全部 arch 变体", () => {
    expect(resolveInstallTarget("linux", undefined, false)).toEqual({ os: "linux", cpu: "*" })
  })

  // 本地 --single 构建：target 过滤逻辑中 singleFlag 优先于 osFilter（build.ts L158-179），
  // install 目标必须与之一致，否则会安装非目标平台的原生包
  test("--single 优先于 --os，使用当前平台", () => {
    const result = resolveInstallTarget("darwin", undefined, true)
    expect(result.os).toBe(process.platform)
    expect(result.cpu).toBe(process.arch)
  })

  test("--single 且无 --os 时使用当前平台", () => {
    const result = resolveInstallTarget(undefined, undefined, true)
    expect(result.os).toBe(process.platform)
    expect(result.cpu).toBe(process.arch)
  })

  // 本地全平台构建（无任何过滤参数），需所有平台原生包供 Bun.compile 交叉编译
  test("无参数时回退到全平台 --os=* --cpu=*", () => {
    expect(resolveInstallTarget(undefined, undefined, false)).toEqual({ os: "*", cpu: "*" })
  })

  // --arch 单独使用时仍安装该 arch 的全部 OS 变体
  test("仅 --arch=arm64 时 CPU 过滤但 OS 保持全部", () => {
    expect(resolveInstallTarget(undefined, "arm64", false)).toEqual({ os: "*", cpu: "arm64" })
  })

  // 回归：osFilter 和 singleFlag 同时存在时 singleFlag 优先，
  // 防止 --single --os=darwin 在 Linux 上错误安装 darwin 包
  test("singleFlag + osFilter + archFilter 同时存在时 singleFlag 优先", () => {
    const result = resolveInstallTarget("linux", "x64", true)
    expect(result.os).toBe(process.platform)
    expect(result.cpu).toBe(process.arch)
  })
})
