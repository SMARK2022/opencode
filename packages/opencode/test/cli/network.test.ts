import { afterEach, describe, expect, test } from "bun:test"
import { resolveNetworkOptionsNoConfig, type NetworkOptions } from "../../src/cli/network"

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
})

function networkArgs(overrides: Partial<NetworkOptions> = {}): NetworkOptions {
  return {
    port: 0,
    hostname: "127.0.0.1",
    mdns: false,
    "mdns-domain": "opencode.local",
    cors: [],
    ...overrides,
  }
}

describe("resolveNetworkOptionsNoConfig", () => {
  test("treats --port=... as explicit so config.server.port cannot override SDK launches", () => {
    process.argv = ["opencode", "serve", "--port=1234"]

    expect(
      resolveNetworkOptionsNoConfig(networkArgs({ port: 1234 }), {
        server: { port: 9999 },
      } as Parameters<typeof resolveNetworkOptionsNoConfig>[1]).port,
    ).toBe(1234)
  })

  test("treats --hostname=... and --mdns-domain=... as explicit", () => {
    process.argv = ["opencode", "web", "--hostname=0.0.0.0", "--mdns-domain=custom.local"]
    const result = resolveNetworkOptionsNoConfig(
      networkArgs({ hostname: "0.0.0.0", "mdns-domain": "custom.local" }),
      {
        server: { hostname: "127.0.0.1", mdnsDomain: "config.local" },
      } as Parameters<typeof resolveNetworkOptionsNoConfig>[1],
    )

    expect(result.hostname).toBe("0.0.0.0")
    expect(result.mdnsDomain).toBe("custom.local")
  })

  test("treats --no-mdns as explicit", () => {
    process.argv = ["opencode", "web", "--no-mdns"]

    expect(
      resolveNetworkOptionsNoConfig(networkArgs({ mdns: false }), {
        server: { mdns: true },
      } as Parameters<typeof resolveNetworkOptionsNoConfig>[1]).mdns,
    ).toBe(false)
  })
})
