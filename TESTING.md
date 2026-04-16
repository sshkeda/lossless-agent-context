# TESTING

`lossless-agent-context` needs end-to-end coverage across the whole future system, not just current fixture conversions.

## Domains

The repo tracks nine required e2e domains:

1. `fixture-corpus`
   - committed fixtures from supported source formats
   - exact golden canonical outputs
   - exact golden projection outputs
2. `real-local-logs`
   - optional imports from real local Pi / Claude Code / Codex logs
3. `projection-roundtrip`
   - canonical -> projection -> canonical -> projection stability
4. `replay-engine`
   - replay/checkpoint/fork runtime tests
5. `openinference-export`
   - canonical -> OpenInference / OTEL exporter tests
6. `live-provider-smoke`
   - live provider smoke tests behind env flags
7. `provider-roundtrip`
   - native -> canonical -> native byte/semantic equivalence per provider
   - importer regression guard (every source line referenced by canonical event)
8. `cross-provider`
   - native A -> canonical -> native B -> canonical -> native A byte equivalence
   - foreign envelope carry-through under `__lac_foreign`
   - semantic Pi -> Claude exporter (real Claude line shapes with `__lac_foreign` sidecar)
9. `sdk-validation`
   - real `@anthropic-ai/claude-agent-sdk` parses the Pi -> Claude conversion via `getSessionMessages`

## What exists today

Implemented now:
- fixture corpus e2e
- projection roundtrip e2e
- real local log e2e harness (env-gated)
- OpenInference exporter e2e
- replay engine e2e
- live provider smoke e2e (env-gated)
- provider-roundtrip e2e (lossless same-provider native ↔ canonical)
- cross-provider e2e (lossless cross-provider conversion via `__lac_foreign` envelopes, plus semantic Pi -> Claude with sidecar)
- sdk-validation e2e (real Claude Agent SDK reads our converted output)

Planned for future subsystems:
- none in the current matrix

## Commands

```bash
bun run check
bun run build
bun run test
```

Run local real-log e2e:

```bash
LAC_ENABLE_REAL_LOG_E2E=1 \
LAC_REAL_PI_SESSION=~/.pi/agent/sessions/...jsonl \
LAC_REAL_CLAUDE_SESSION=~/.claude/projects/...jsonl \
LAC_REAL_CODEX_SESSION=~/.codex/archived_sessions/...jsonl \
bun run test
```

Run live provider smoke e2e with your existing local CLI auth:

```bash
LAC_ENABLE_LIVE_PROVIDER_E2E=1 \
bun run test
```

This suite uses the locally authenticated `claude`, `codex`, and `pi` CLIs rather than API-key env vars.

## Rule

A future subsystem is not considered complete until it has a corresponding e2e domain in the matrix and passing tests in that domain.
