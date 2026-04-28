import {
  emptySidecar,
  exportClaudeCodeJsonl,
  exportCodexJsonl,
  exportPiSessionJsonl,
  importClaudeCodeJsonl,
  importCodexJsonl,
  importPiSessionJsonl,
} from "@lossless-agent-context/adapters";
import { CANONICAL_SCHEMA_VERSION, type CanonicalEvent, canonicalEventSchema } from "@lossless-agent-context/core";
import { describe, expect, it } from "vitest";

function event(input: Omit<CanonicalEvent, "schemaVersion" | "eventId" | "seq"> & { seq: number }): CanonicalEvent {
  return canonicalEventSchema.parse({
    ...input,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: `${input.sessionId}:${String(input.seq).padStart(6, "0")}`,
  });
}

const TS = "2026-04-15T12:00:00.000Z";

function piSession(sessionId: string): CanonicalEvent {
  return event({
    sessionId,
    branchId: "main",
    seq: 0,
    timestamp: TS,
    kind: "session.created",
    payload: { startedAt: TS, workingDirectory: "/tmp" },
    native: { source: "pi", raw: { type: "session", version: 3, id: sessionId, timestamp: TS, cwd: "/tmp" } },
  });
}

function claudeSession(sessionId: string): CanonicalEvent {
  return event({
    sessionId,
    branchId: "main",
    seq: 0,
    timestamp: TS,
    kind: "session.created",
    payload: { startedAt: TS, workingDirectory: "/tmp" },
    native: {
      source: "claude-code",
      raw: { type: "system", subtype: "init", timestamp: TS, sessionId, cwd: "/tmp", version: "x" },
    },
  });
}

function codexSession(sessionId: string): CanonicalEvent {
  return event({
    sessionId,
    branchId: "main",
    seq: 0,
    timestamp: TS,
    kind: "session.created",
    payload: { startedAt: TS, workingDirectory: "/tmp" },
    native: {
      source: "codex",
      raw: {
        timestamp: TS,
        type: "session_meta",
        payload: { id: sessionId, timestamp: TS, cwd: "/tmp", model_provider: "openai" },
      },
    },
  });
}

describe("edge case: model.requested event preservation through native exporters", () => {
  const requestedRaw = {
    type: "lac:model_requested",
    provider: "anthropic",
    model: "claude-opus-4-7",
    settings: { temperature: 0.2, max_tokens: 4096 },
  };

  it("model.requested with full payload survives pi → import via foreign sidecar", () => {
    const sessionId = "pi-mr-1";
    const requested: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.requested",
      payload: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        input: { messages: [{ role: "user", content: "hi" }] },
        settings: { temperature: 0.2, max_tokens: 4096 },
      },
      native: { source: "pi", raw: requestedRaw },
    });
    const piText = exportPiSessionJsonl([piSession(sessionId), requested]);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "model.requested");
    expect(re).toBeDefined();
    if (re?.kind !== "model.requested") throw new Error("type narrowing");
    expect(re.payload.provider).toBe("anthropic");
    expect(re.payload.model).toBe("claude-opus-4-7");
    expect(re.payload.settings).toEqual({ temperature: 0.2, max_tokens: 4096 });
  });

  it("model.requested survives claude → import via foreign sidecar", () => {
    const sessionId = "claude-mr-1";
    const requested: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.requested",
      payload: { provider: "anthropic", model: "claude-sonnet-4-6" },
      native: {
        source: "claude-code",
        raw: { type: "lac:model_requested", provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    });
    const claudeText = exportClaudeCodeJsonl([claudeSession(sessionId), requested]);
    const reimported = importClaudeCodeJsonl(claudeText, emptySidecar());
    const re = reimported.find((e) => e.kind === "model.requested");
    expect(re).toBeDefined();
    if (re?.kind !== "model.requested") throw new Error("type narrowing");
    expect(re.payload.provider).toBe("anthropic");
    expect(re.payload.model).toBe("claude-sonnet-4-6");
  });

  it("model.requested survives codex → import via foreign sidecar", () => {
    const sessionId = "codex-mr-1";
    const requested: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.requested",
      payload: { provider: "openai", model: "gpt-5", settings: { stream: true } },
      native: {
        source: "codex",
        raw: { type: "lac:model_requested", provider: "openai", model: "gpt-5" },
      },
    });
    const codexText = exportCodexJsonl([codexSession(sessionId), requested]);
    const reimported = importCodexJsonl(codexText);
    const re = reimported.find((e) => e.kind === "model.requested");
    expect(re).toBeDefined();
    if (re?.kind !== "model.requested") throw new Error("type narrowing");
    expect(re.payload.settings).toEqual({ stream: true });
  });

  it("paired model.requested + model.completed survive together through pi", () => {
    const sessionId = "pi-mr-mc-1";
    const requested: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.requested",
      payload: { provider: "openai", model: "gpt-5" },
      native: { source: "pi", raw: { type: "lac:model_requested", provider: "openai", model: "gpt-5" } },
    });
    const completed: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 2,
      timestamp: TS,
      kind: "model.completed",
      payload: { provider: "openai", model: "gpt-5", usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 } },
      native: { source: "pi", raw: { type: "lac:model_completed", provider: "openai", model: "gpt-5" } },
    });
    const piText = exportPiSessionJsonl([piSession(sessionId), requested, completed]);
    const reimported = importPiSessionJsonl(piText);
    expect(reimported.find((e) => e.kind === "model.requested")).toBeDefined();
    const re = reimported.find((e) => e.kind === "model.completed");
    if (re?.kind !== "model.completed") throw new Error("type narrowing");
    expect(re.payload.usage?.totalTokens).toBe(18);
  });
});
