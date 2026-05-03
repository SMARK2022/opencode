# Prepared Input Breakdown

V1 processor and V2 runner estimate the body delivered by their existing prepared-request callback. Native V1 and V2 observe the validated protocol body from their single compile, matching `LLMClient.prepare<Body>`; the AI SDK path uses its post-transform middleware. Transport-only metadata and WebSocket envelopes do not expand this character-based estimate. Transport preparation, encoding and authentication keep their upstream owners, with the observer completing before frames execute. Neither path writes provisional values to confirmed `tokens.input`.

`InputEstimate.bodyChars` uses one canonical JSON serialization. Its optional `inputBreakdown` partitions that same character count into system, instructions, skills, advertised tools and messages. Property names, punctuation, escaping and attachments belong to their enclosing payload category. The six message subcategories sum to `messages.total`; the five top-level categories sum to `bodyChars`. This is a character-based estimate, not a provider tokenizer or media-billing claim.

System categories match only actual server-rendered instruction/skill sections inside the prepared system payload. Model defaults, plugin replacements and other unattributed system text remain in system. SystemContext's optional render observer shares the original observation/rendering; ContextEpoch persists the attribution beside the original comparison snapshot in its existing JSON column. Historical bare snapshots decode unchanged and do not invent provenance from current files. Context updates retain earlier rendered sections until epoch replacement resets the baseline/history boundary.

The server freezes `charsPerToken` from same-provider/API confirmed input plus cache reads/writes. Samples under 100 characters, zero/non-finite confirmations and aggregates at or under 500 characters do not calibrate; the recent sample cutoff is 100000 characters for both numerator and denominator. Default density is four. Density does not change confirmed tokens, costs, RequestID, permissions, continuation or the number of streams.

`Session.request.inputEstimate` carries the same metadata before the first native Started event and after confirmation. Existing `estimatedInput` remains the provisional-display authority; zero confirmation and completion still stop it. Prompt, sidebar and subagent footer use the shared helper's frozen density only for unconfirmed tails. The context panel consumes server categories, with legacy V1 confirmation-part support only when no request projection exists. It does not reconstruct a bootstrap input floor.

## Canonical Generation

The additions change public Schema reused by current Protocol events, Server HttpApi Session responses and V1 message/part events. Main must run the legacy SDK build (`bun run packages/sdk/js/script/build.ts`) and `bun run generate` from `packages/client`, then capture their actual generated and generated-effect changes. Do not edit generated code by hand. No physical database column or migration is added; only the existing ContextEpoch JSON value gains a typed wrapper with legacy decoding.

## Verification

Replay current71 then this patch on canonical state70, perform canonical generation, and run package typechecks. Run Core token, system-context, session-runner, prepared-model and projector tests; opencode processor, native LLM, MessageV2, compaction and HTTP/SSE tests; and the full TUI token/context suites. Keep the existing 2789/697, 8000/2000, one-stream, zero-confirmation, request-ledger and frozen-context-limit oracles. Subsequent patches 74/75 must consume the new context-details/helper owners rather than resurrect window aliases or a client bootstrap.
