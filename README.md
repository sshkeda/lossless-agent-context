# lossless-agent-context

Lossless session switching between Claude Code, Codex, and Pi.

Each of those tools stores its session context in its own native JSONL shape. This repo converts between them without dropping information, so you can hot-swap a session from one tool to another and keep working.

## Product standard

The product standard is strict native fidelity:

- `provider -> LAC -> other format -> LAC -> provider` must round-trip back to the original native session bytes.
- This applies uniformly to Claude Code, Codex, and Pi.
- If a rebuilt provider session is not byte-for-byte identical to the original native session, that is a bug in LAC.
- Provider-specific workarounds that rely on replaying preserved raw files instead of reconstructing them are not the intended end state; reconstruction itself must be lossless.

Current gap:

- **Claude resume seeds are not yet natively lossless.** Real experiments showed Claude Code can reject synthetic resume seeds with `API Error: 400 due to tool use concurrency issues.` once enough historical `tool_result` pairs are preserved.
- The required fix is exact native fidelity in reconstruction: `Claude -> LAC -> pi -> LAC -> Claude` must produce the same native Claude bytes, including historical tool execution state.

## Usage

```bash
bun install

# Pi -> Claude Code
bun packages/cli/src/index.ts convert session.jsonl --to claude-code -o claude.jsonl

# stdin piping, auto-detected source
cat session.jsonl | bun packages/cli/src/index.ts convert - --to codex

# explicit source
bun packages/cli/src/index.ts convert session.jsonl --from pi --to codex
```

Providers: `pi` | `claude-code` | `codex`. `--from` is auto-detected from the first JSONL line if omitted.

## Packages

- `@lossless-agent-context/cli` — `lac convert` CLI
- `@lossless-agent-context/core` — canonical event schema
- `@lossless-agent-context/adapters` — Pi / Claude Code / Codex JSONL importers + exporters
- `@lossless-agent-context/e2e` — fixture-driven integration tests

## How it works

1. raw native JSONL (Pi / Claude Code / Codex)
2. a canonical, append-only event model
3. exporters back into any of the three native shapes

When going cross-provider (e.g. Pi → Claude Code), the exporter carries foreign native lines as `__lac_foreign` / `__lac_canonical` sidecars so a subsequent Claude → Pi export produces the original Pi bytes.

## Scripts

```bash
bun install
bun run verify:portable
```

`verify:portable` runs lint + typecheck + the portable fixture-driven test suite. This is what CI proves.

For a machine-local proof against real session logs (reads the most recent session from `~/.pi/agent/sessions`, `~/.claude/projects`, `~/.codex/archived_sessions`):

```bash
bun run test:real-logs
```

Override the picked files with `LAC_REAL_PI_SESSION` / `LAC_REAL_CLAUDE_SESSION` / `LAC_REAL_CODEX_SESSION`.

## Conversion coverage

- Pi JSONL ↔ canonical
- Claude Code JSONL ↔ canonical
- Codex JSONL ↔ canonical
- cross-provider export (e.g. Pi → Claude Code) with lossless `__lac_foreign` / `__lac_canonical` carry-through
- semantic Pi → Claude Code export validated by the real `@anthropic-ai/claude-agent-sdk` (`getSessionMessages` parses the converted output and returns the original Pi user/assistant chain)
