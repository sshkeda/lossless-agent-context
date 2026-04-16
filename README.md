# lossless-agent-context

A Turborepo for provider-agnostic, lossless session and event storage for AI coding agents.

## Packages

- `@lossless-agent-context/core`
  - canonical event schemas and shared types
- `@lossless-agent-context/adapters`
  - native importers from provider/runtime logs into canonical events
- `@lossless-agent-context/projection-ai-sdk`
  - AI SDK-style message projection from canonical events
- `@lossless-agent-context/projection-openinference`
  - OpenInference-style span projection from canonical events
- `@lossless-agent-context/replay`
  - deterministic branch-aware timeline replay helpers
- `@lossless-agent-context/e2e`
  - fixture-driven end-to-end integration tests for every supported conversion path

## Why this exists

AI SDK messages are excellent UI state. OpenTelemetry/OpenInference are excellent traces. Provider-native logs are excellent raw evidence. None of them alone are the right source of truth for a hot-swappable coding-agent runtime.

`lossless-agent-context` uses:

1. raw native inputs
2. a canonical, append-only event model
3. projection/export layers into other ecosystems

## Scripts

```bash
bun install
bun run build
bun run check
bun run test
```

## Current conversion coverage

- Pi session JSONL -> canonical events
- Claude Code JSONL -> canonical events
- Codex JSONL -> canonical events
- AI SDK-style messages -> canonical events
- canonical events -> AI SDK-style message projection
- canonical events -> Pi / Claude Code / Codex JSONL (native exporters)
- cross-provider conversion (e.g. Pi -> Claude Code) with lossless `__lac_foreign` envelope carry-through
- semantic Pi -> Claude Code export validated by the real `@anthropic-ai/claude-agent-sdk` (`getSessionMessages` parses converted output, returning the original Pi user/assistant chain)

## Testing philosophy

The `e2e` package is the beginning of the whole-system test harness.

Implemented today:
- golden fixture corpus e2e
- exact canonical-output assertions
- exact AI SDK projection assertions
- exact OpenInference-style exporter assertions
- projection round-trip stability checks
- branch-aware replay e2e
- env-gated real local log import tests
- env-gated live provider smoke e2e via local authenticated `claude`, `codex`, and `pi` CLIs
- provider-roundtrip e2e (native ↔ canonical lossless per provider)
- cross-provider e2e (provider A -> provider B -> provider A lossless via foreign envelopes)
- sdk-validation e2e (real `@anthropic-ai/claude-agent-sdk` reads our Pi -> Claude conversion via `getSessionMessages`)

Planned and tracked explicitly for the future system:
- none in the current matrix

See [TESTING.md](./TESTING.md) for the full matrix.
