# TESTING

`lossless-agent-context` needs end-to-end coverage across the whole future system, not just current fixture conversions.

## Domains

The repo tracks six required e2e domains:

1. `fixture-corpus`
   - committed fixtures from supported source formats
   - exact golden canonical outputs
   - exact golden projection outputs
2. `real-local-logs`
   - optional imports from real local Pi / Claude Code / Codex logs
3. `projection-roundtrip`
   - canonical -> projection -> canonical -> projection stability
4. `replay-engine`
   - future replay/checkpoint/fork runtime tests
5. `openinference-export`
   - future canonical -> OpenInference / OTEL exporter tests
6. `live-provider-smoke`
   - future live provider smoke tests behind env flags

## What exists today

Implemented now:
- fixture corpus e2e
- projection roundtrip e2e
- real local log e2e harness (env-gated)
- OpenInference exporter e2e
- replay engine e2e
- live provider smoke e2e (env-gated)

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

Run live provider smoke e2e:

```bash
LAC_ENABLE_LIVE_PROVIDER_E2E=1 \
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
LAC_OPENAI_MODEL=gpt-4.1-mini \
LAC_ANTHROPIC_MODEL=claude-3-5-haiku-latest \
bun run test
```

## Rule

A future subsystem is not considered complete until it has a corresponding e2e domain in the matrix and passing tests in that domain.
