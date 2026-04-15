# lossless-agent-context

Provider-agnostic, lossless session and event storage for AI coding agents.

## Goal

`lossless-agent-context` is a canonical event schema for agent runtimes that need to:

- hot-swap providers and models
- preserve conversation, tool calls, tool results, and reasoning
- keep exact replay/debugging history
- support branching and session metadata
- project into other formats like AI SDK messages and tracing systems

## Design

The architecture has three layers:

1. **Raw ingest**
   - Preserve native source events from systems like Pi, Codex CLI, Claude Code, OpenAI Agents tracing, and AI SDK streams.
2. **Canonical event log**
   - A provider-agnostic, append-only event model that becomes the source of truth.
3. **Projections**
   - Derived views for AI SDK `UIMessage`, observability/tracing, replay UIs, analytics, and provider-specific prompt formats.

## Why not just use AI SDK or OpenTelemetry?

- AI SDK is excellent for chat/message persistence, but it is not a full agent runtime event log.
- OpenTelemetry/OpenInference are excellent for tracing, but not ideal as the primary session transcript and replay format.
- Provider-native formats are too provider-shaped to be the long-term canonical source of truth.

## Initial scope

This repo starts with:

- a typed canonical event envelope
- core event kinds for sessions, messages, reasoning, model runs, tool calls/results, branching, and errors
- Zod schemas for validation

## Next steps

- add importers for Pi, Codex CLI, Claude Code, and OpenAI Agents traces
- add AI SDK projection utilities
- add OpenInference/OpenTelemetry projection utilities
- add branch/replay helpers
- add storage adapters (JSONL and database-backed)
