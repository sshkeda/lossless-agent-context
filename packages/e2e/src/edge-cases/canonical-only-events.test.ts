import {
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

const SESSION_ID = "edge-canon-1";
const TS = "2026-04-15T12:00:00.000Z";

const sessionEvent: CanonicalEvent = event({
  sessionId: SESSION_ID,
  branchId: "main",
  seq: 0,
  timestamp: TS,
  kind: "session.created",
  payload: { startedAt: TS, workingDirectory: "/tmp" },
  native: { source: "pi", raw: { type: "session", version: 3, id: SESSION_ID, timestamp: TS, cwd: "/tmp" } },
});

describe("edge case: canonical-only event kinds preserved through native exporters", () => {
  it("model.completed survives pi → import via foreign sidecar", () => {
    const completedRaw = {
      type: "lac:model_completed",
      provider: "openai",
      model: "gpt-4o",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const completed: CanonicalEvent = event({
      sessionId: SESSION_ID,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.completed",
      payload: { provider: "openai", model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 50 } },
      native: { source: "pi", raw: completedRaw },
    });
    const events = [sessionEvent, completed];
    const piText = exportPiSessionJsonl(events);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "model.completed");
    expect(re).toBeDefined();
    if (re?.kind !== "model.completed") throw new Error("type narrowing");
    expect(re.payload.provider).toBe("openai");
    expect(re.payload.usage?.inputTokens).toBe(100);
  });

  it("runtime.error survives claude → import via foreign sidecar", () => {
    const errorRaw = { type: "lac:runtime_error", code: "ETIMEDOUT", message: "request timed out" };
    const errEvent: CanonicalEvent = event({
      sessionId: "claude-err-1",
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "runtime.error",
      payload: { code: "ETIMEDOUT", message: "request timed out" },
      native: { source: "claude-code", raw: errorRaw },
    });
    const sessionClaude: CanonicalEvent = event({
      sessionId: "claude-err-1",
      branchId: "main",
      seq: 0,
      timestamp: TS,
      kind: "session.created",
      payload: { startedAt: TS, workingDirectory: "/tmp" },
      native: {
        source: "claude-code",
        raw: { type: "system", subtype: "init", timestamp: TS, sessionId: "claude-err-1", cwd: "/tmp", version: "x" },
      },
    });
    const claudeText = exportClaudeCodeJsonl([sessionClaude, errEvent]);
    const reimported = importClaudeCodeJsonl(claudeText);
    const re = reimported.find((e) => e.kind === "runtime.error");
    expect(re).toBeDefined();
    if (re?.kind !== "runtime.error") throw new Error("type narrowing");
    expect(re.payload.code).toBe("ETIMEDOUT");
    expect(re.payload.message).toBe("request timed out");
  });

  it("model.completed survives codex → import via foreign sidecar", () => {
    const completed: CanonicalEvent = event({
      sessionId: "codex-mc-1",
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.completed",
      payload: { provider: "openai", model: "gpt-5", usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } },
      native: { source: "codex", raw: { type: "lac:model_completed", provider: "openai", model: "gpt-5" } },
    });
    const sessionCodex: CanonicalEvent = event({
      sessionId: "codex-mc-1",
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
          payload: { id: "codex-mc-1", timestamp: TS, cwd: "/tmp", model_provider: "openai" },
        },
      },
    });
    const codexText = exportCodexJsonl([sessionCodex, completed]);
    const reimported = importCodexJsonl(codexText);
    const re = reimported.find((e) => e.kind === "model.completed");
    expect(re).toBeDefined();
    if (re?.kind !== "model.completed") throw new Error("type narrowing");
    expect(re.payload.usage?.totalTokens).toBe(15);
  });

  it("branch.created survives pi → import via foreign sidecar", () => {
    const branchEvent: CanonicalEvent = event({
      sessionId: SESSION_ID,
      branchId: "feature-branch",
      seq: 1,
      timestamp: TS,
      kind: "branch.created",
      payload: { fromBranchId: "main", reason: "user fork" },
      native: { source: "pi", raw: { type: "lac:branch_created", branchId: "feature-branch", fromBranchId: "main" } },
    });
    const piText = exportPiSessionJsonl([sessionEvent, branchEvent]);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "branch.created");
    expect(re).toBeDefined();
    if (re?.kind !== "branch.created") throw new Error("type narrowing");
    expect(re.payload.fromBranchId).toBe("main");
  });
});
