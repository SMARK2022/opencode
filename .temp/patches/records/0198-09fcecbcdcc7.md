# 0198 — feat(permission): add reviewer auto decision service

## Source
- SHA: 09fcecbcdcc7eb4d37ee39df54807e25ac78648f
- Subject: feat(permission): add reviewer auto decision service
- Files: 11 (all NEW: auto.ts, cache/session-cache.ts, reviewer/*, policy/*, tests)

## Source vs Upstream vs Target Comparison

### Source (SMARK)
The source patch creates the reviewer auto-decision service that sits between the deterministic precheck and user approval. It includes: (1) PermissionAuto.evaluate router (precheck → fast-path allow → deny → reviewer → fail-closed), (2) PermissionSessionCache per-session allow/deny cache with canonical key, (3) PermissionCircuitBreaker consecutive + sliding-window denial counters, (4) PermissionReviewer provider-backed generateObject service with 90s timeout, (5) Reviewer prompt builder with policy + transcript, (6) Assessment schema (outcome/risk_level/user_authorization/rationale), (7) Transcript projection (bounded 40 messages, 4000 chars/part), (8) Policy files (default tenant policy + guardian-style prompt template).

### Upstream (v1.17.20)
The upstream target has no auto-review pipeline. All permission requests that aren't deterministically allowed or denied route directly to user approval. There is no reviewer service, no session cache, no circuit breaker, and no policy template. The target uses `LayerNode` + `AppNodeBuilderV1` + `EventV2Bridge` + `PermissionV1` namespace architecture.

### Target Adaptation
All files are new — patch is purely additive. Key adaptations:

1. **service.ts**: `Config.defaultLayer` → `Config.node`, `Provider.defaultLayer` → `Provider.node`. Added `export const node = LayerNode.make(...)` with deps `[Config.node, Provider.node, Session.node]` for 199 wiring. Session does NOT import Permission in target architecture (verified via grep), so no module cycle.

2. **session-cache.ts**: Added `export const node = LayerNode.make(...)` with empty deps (InstanceState is scope-based, not a node dependency).

3. **circuit-breaker.ts**: Added `export const node = LayerNode.make(...)` with empty deps.

4. **transcript.ts**: `MessageV2` imports → `@opencode-ai/core/v1/session` (target doesn't re-export `WithParts`/`Part`/`ToolPart`).

5. **policy/policy.md** (8 lines): Default tenant auto-review policy — deny credential exfiltration, retry bypasses, require authorization for irreversible VCS/destructive operations, allow bounded read-only inspection.

6. **policy/policy_template.md** (37 lines): Guardian-style prompt template — evidence handling (untrusted), user authorization scoring, base risk taxonomy, policy configuration placeholder, investigation guidelines, outcome policy.

## File-by-File Adaptation Details

### packages/opencode/src/permission/auto.ts (132 lines)
- Decision type: allow/ask/deny with source tracking (precheck/reviewer/reviewer_unavailable)
- ReviewDecision type: narrower than Decision — no ask, reviewer must decide allow/deny
- Reviewer interface: injected (not constructed) for testability and fail-closed when absent
- evaluate(): precheck → fast-path allow (disabled in strict) → deny → reviewer (fail-closed on error)
- Strict mode: disables fast-path but preserves deny; reason annotated for audit logs
- Reviewer failure: Disabled/FallbackToUser → ask; all other errors → deny (fail closed)
- invalidReviewContract: hard guardrail — empty rationale, critical+allow, non-low-risk+allow+unknown-authorization → deny
- Helper functions: errorTag (extract _tag), errorMessage (extract message), reviewerFailureMessage (stable timeout reason)

### packages/opencode/src/permission/cache/session-cache.ts (75 lines)
- Per-session allow/deny cache using InstanceState (scope-based)
- canonicalKey: JSON.stringify of [permission, pattern, command, cwd, shell, filepath, diff] — prevents context mismatch
- has(): every pattern must be "allow" for cache hit (partial hit still prompts)
- node: empty deps (InstanceState is not a node dependency)

### packages/opencode/src/permission/reviewer/circuit-breaker.ts (113 lines)
- Consecutive denial counter + sliding window (default 50) denial density counter
- Triggered flag is sticky — once tripped, session auto-approval permanently interrupted
- recordNonDenial: resets consecutive counter but pushes to window (preserves history)
- Config-driven limits: max_consecutive_denials (default 3), max_recent_denials (default 10), recent_denial_window (default 50)
- positiveInt: filters undefined/NaN/zero/negative to prevent misconfiguration

### packages/opencode/src/permission/reviewer/prompt.ts (65 lines)
- DEFAULT_TENANT_POLICY: imported from policy.md
- buildSystemPrompt: replaces {tenant_policy_config} placeholder in template, appends output contract
- buildUserPromptItems: transcript (untrusted evidence) + optional retry reason + planned action JSON
- renderTranscript: [role]-tagged entries, truncated marker for missing evidence

### packages/opencode/src/permission/reviewer/schema.ts (34 lines)
- RiskLevel: low/medium/high/critical
- UserAuthorization: unknown/low/medium/high
- Assessment: outcome/risk_level/user_authorization/rationale — used for generateObject structured output
- ReviewerRequest: permission/patterns/metadata/precheck — precheck.action fixed to "prompt"

### packages/opencode/src/permission/reviewer/service.ts (185 lines)
- 4 error types: ReviewerDisabled (service off), ReviewerFallbackToUser (fallback=user), ReviewerTimedOut (90s), ReviewerRunError (provider/schema errors)
- review(): disabled check → build ReviewerRequest → load tenant policy → get transcript (40 msgs, catch → empty) → build messages → resolve model (configured or default+small) → generateObject with timeout → return ReviewDecision
- fallback=user: non-Disabled errors → FallbackToUser (back to user approval); Disabled stays as-is (explicit signal)
- node deps: [Config.node, Provider.node, Session.node] — reviewer yields all three services

### packages/opencode/src/permission/reviewer/transcript.ts (50 lines)
- ENTRY_LIMIT=40, PART_CHAR_LIMIT=4000 — bounded for token budget
- renderPart: hidden skipped, text/reasoning/tool/file/subtask/patch/agent each formatted
- renderTool: pending/running/completed/error states with input/output
- truncate: explicit <truncated chars="N" /> marker

### packages/opencode/src/permission/reviewer/policy/policy.md (8 lines)
- Default tenant policy: deny credential exfiltration, retry bypasses, require authorization for irreversible ops

### packages/opencode/src/permission/reviewer/policy/policy_template.md (37 lines)
- Guardian-style prompt: evidence handling, authorization scoring, risk taxonomy, outcome policy

## E/C Calculation
- **E** (effective modified lines: non-empty, non-import added lines): 792
- **C** (qualified Chinese `#198` explanatory comments): 144 — distributed across auto.ts, session-cache.ts, circuit-breaker.ts, prompt.ts, schema.ts, service.ts, transcript.ts at decision points
- **Need**: max(1, ceil(792 * 0.15)) = 119
- **Gate**: 144 >= 119 → PASS
- Representative comment locations:
  - auto.ts:5 — 三态决策与 source 追踪的 rationale
  - auto.ts:12 — ReviewDecision 比 Decision 更窄的 invariant
  - auto.ts:37 — reviewer 注入而非构造的 testability rationale
  - auto.ts:48 — fast-path allow 保留无提示行为的 rationale
  - auto.ts:57 — prompt 是 review 边界的 boundary
  - auto.ts:73 — Disabled/FallbackToUser vs 其他错误 fail closed 的 decision
  - auto.ts:83 — 硬护栏防止矛盾模型输出的 invariant
  - session-cache.ts:37 — 缓存命中要求每个 pattern 都已放行的 invariant
  - session-cache.ts:55 — 规范化缓存键包含上下文字段的 rationale
  - circuit-breaker.ts:54 — triggered 一旦置位永久中断的 invariant
  - circuit-breaker.ts:63 — 非拒绝重置连续但不重置窗口的 rationale
  - service.ts:62 — approvals_reviewer 非 auto_review 时禁用的 decision
  - service.ts:80 — 模型解析配置优先 vs 默认+small 的 rationale
  - service.ts:101 — 超时控制默认 90 秒的 boundary
  - service.ts:124 — fallback=user 时 Disabled 不转换的 rationale

## Current
- SHA-256: `483c8f094df04b4c65610786773c67d1ce95b626a62a810e05874f2428f5d0b2`
- Bytes: 52740
- Lines: 992

## Install
- Fingerprint: bfd9217687f98d6db47035044c1b3c6a51a6d00496972d6f8f1b5fadee0a426f

## Test
- Typecheck: PASS (all 30 workspaces)
- Focused tests: pending

## Dependencies
- Prerequisite: patches 1-197 (tip@197)
- Enables: patch 199 (wire auto review into permission flow)

## DUAL-AUDIT SEAL

- Sealed: 2026-07-26T23:58:47Z
- FORWARD: BATCH PASS (ses_fwd_196_200_v3) - no open B/G
- REVERSE: BATCH PASS (ses_rev_200_196_v3) - no open B/G
- Tip: states/0200-d4f24d4434a4
- Typecheck: typecheck-0200-2026-07-26T23-48-04-286Z.md
- Install: bfd9217687f98d6db47035044c1b3c6a51a6d00496972d6f8f1b5fadee0a426f
- Non-blocking N only (do not reopen seal)
