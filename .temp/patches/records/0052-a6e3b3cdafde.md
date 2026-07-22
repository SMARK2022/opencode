# Patch Record 0052

## 1. Identity
- Index: 52 · SHA12 `a6e3b3cdafde`
- Current SHA-256: `541c5e2ac07eab334265b627471a5509647289f51877de1fc0e44884ba10993a` · bytes 1393
- State: `states/0052-a6e3b3cdafde` · cumul=None status=None builtAt=None
- Baseline 4473fc3c… · tip d0ceb469…

## 2. Upstream design (after #47/#49)
Daemon spawn env is built inside `discoverOrSpawnDaemon` in `packages/opencode/src/cli/cmd/tui.ts` by forwarding full `process.env` (minus undefined) into `deps.spawn`. There is no `sanitizedProcessEnv` on this path. Full parent env already includes proxy and CA variables if the shell exported them.

## 3. SMARK design
V1 used sanitize then `proxyEnv()` to re-inject HTTP(S)_PROXY / NO_PROXY / CA with dual-case normalization, because sanitize dropped them.

## 4. This adaptation
Rebuild current against the real owner (`discoverOrSpawnDaemon`), not obsolete `_spawn`/`target()` context:
- Keep full env forward (already stronger than selective re-inject).
- Explicitly re-assign common proxy/CA keys from `process.env` (identity assign) so the primary path documents and locks the invariant that proxies must reach the daemon.
- Chinese comments explain full-forward + key list.

## 5. Why not reintroduce proxyEnv
Redundant vs full env. Later SMARK #71 moves to applyProxyEnv platform normalize; resurrecting proxyEnv here creates conflict. Dual-case fill only mattered after sanitize; with full env, parent keys are forwarded as-is.

## 6. Metrics
E=16 C=3 required=3 gate=PASS

## 7. Verification
- materialize 52; apply-check on 51 clean
- thread single-server|forwards still green under injectable spawn

## 8. Verdict
`PASS` — dual independent auditors FORWARD+REVERSE batch 50-54, no open B/G.

## 9. Dual audit closure
- Batch 50-54 FORWARD: PASS
- Batch 50-54 REVERSE: PASS

## 10. Call chain
1. TUI client calls `discoverOrSpawnDaemon` when no healthy daemon lock/endpoint is found.
2. Spawn env is built from full parent `process.env` plus worker role / run id / socket path.
3. Explicit re-assignment of proxy/CA keys documents the invariant that corporate proxy settings reach the worker even if a future edit reintroduces selective env.
4. Worker process inherits that env for outbound provider HTTP.

## 11. Divergence from original path ownership
Original SMARK patched V1 `thread.ts` spawn helpers that no longer exist in this tree. Applying the hunks against dead `_spawn`/`target()` context produced non-applyable or no-op patches. Rebuild against `discoverOrSpawnDaemon` is required adaptation, not scope reduction: the consumer of proxy-bearing env is the daemon spawn path after #47.

## 12. Residuals
Does not implement dual-case key normalization (later #71 / applyProxyEnv). Does not sanitize role off install children (that is #56 `installChildEnv`).
## 13. Owner file
- `packages/opencode/src/cli/cmd/tui.ts` — `discoverOrSpawnDaemon` env object construction after full process.env copy.
- Explicit keys include HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY (and common case variants) plus SSL/NODE CA bundle paths when present in parent env.
