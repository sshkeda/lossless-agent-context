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

describe("edge case: causality field preservation through canonical-only kinds", () => {
  it("model.completed with causality survives pi → import via lac:event line", () => {
    const sessionId = "pi-cause-1";
    const completed: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.completed",
      causality: {
        parentEventId: `${sessionId}:000000`,
        causedByEventId: `${sessionId}:000000`,
        turnId: "turn-7",
        requestId: "req-abc",
        spanId: "span-1",
        parentSpanId: "span-0",
      },
      payload: { provider: "openai", model: "gpt-4o" },
      native: { source: "pi", raw: { type: "lac:model_completed", provider: "openai", model: "gpt-4o" } },
    });
    const piText = exportPiSessionJsonl([piSession(sessionId), completed]);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "model.completed");
    expect(re).toBeDefined();
    if (re?.kind !== "model.completed") throw new Error("type narrowing");
    expect(re.causality?.turnId).toBe("turn-7");
    expect(re.causality?.requestId).toBe("req-abc");
    expect(re.causality?.spanId).toBe("span-1");
    expect(re.causality?.parentSpanId).toBe("span-0");
  });

  it("runtime.error with causality survives claude → import via lac:event line", () => {
    const sessionId = "claude-cause-1";
    const errEvent: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "runtime.error",
      causality: { turnId: "turn-x", requestId: "req-y" },
      payload: { code: "EBOOM", message: "kaboom" },
      native: { source: "claude-code", raw: { type: "lac:runtime_error", code: "EBOOM" } },
    });
    const claudeText = exportClaudeCodeJsonl([claudeSession(sessionId), errEvent]);
    const reimported = importClaudeCodeJsonl(claudeText, emptySidecar());
    const re = reimported.find((e) => e.kind === "runtime.error");
    expect(re).toBeDefined();
    if (re?.kind !== "runtime.error") throw new Error("type narrowing");
    expect(re.causality?.turnId).toBe("turn-x");
    expect(re.causality?.requestId).toBe("req-y");
  });

  it("model.requested with causality survives codex → import via lac:event line", () => {
    const sessionId = "codex-cause-1";
    const requested: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.requested",
      causality: { spanId: "span-codex" },
      payload: { provider: "openai", model: "gpt-5" },
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
    expect(re.causality?.spanId).toBe("span-codex");
  });
});

describe("edge case: extensions field preservation through canonical-only kinds", () => {
  it("model.completed with extensions survives pi → import via lac:event line", () => {
    const sessionId = "pi-ext-1";
    const completed: CanonicalEvent = event({
      sessionId,
      branchId: "main",
      seq: 1,
      timestamp: TS,
      kind: "model.completed",
      extensions: {
        custom_billing_tag: "team-alpha",
        request_priority: 2,
        nested: { deep: { value: true } },
      },
      payload: { provider: "openai", model: "gpt-4o" },
      native: { source: "pi", raw: { type: "lac:model_completed", provider: "openai", model: "gpt-4o" } },
    });
    const piText = exportPiSessionJsonl([piSession(sessionId), completed]);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "model.completed");
    expect(re).toBeDefined();
    if (re?.kind !== "model.completed") throw new Error("type narrowing");
    expect(re.extensions?.custom_billing_tag).toBe("team-alpha");
    expect(re.extensions?.request_priority).toBe(2);
    expect(re.extensions?.nested).toEqual({ deep: { value: true } });
  });

  it("branch.created with extensions survives pi → import via lac:event line", () => {
    const sessionId = "pi-ext-2";
    const branch: CanonicalEvent = event({
      sessionId,
      branchId: "feature-x",
      seq: 1,
      timestamp: TS,
      kind: "branch.created",
      extensions: { sourceCommit: "abc123", workspaceId: "ws-7" },
      payload: { fromBranchId: "main", reason: "experiment" },
      native: {
        source: "pi",
        raw: { type: "lac:branch_created", branchId: "feature-x", fromBranchId: "main" },
      },
    });
    const piText = exportPiSessionJsonl([piSession(sessionId), branch]);
    const reimported = importPiSessionJsonl(piText);
    const re = reimported.find((e) => e.kind === "branch.created");
    expect(re).toBeDefined();
    if (re?.kind !== "branch.created") throw new Error("type narrowing");
    expect(re.extensions?.sourceCommit).toBe("abc123");
    expect(re.extensions?.workspaceId).toBe("ws-7");
  });
});

describe("edge case: native-encoded extensions (claude thinking signature) round-trip", () => {
  it("claude thinking block with signature exposes signature in extensions", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-sig-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-sig-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret thought", signature: "sig-deadbeef" }],
      },
    })}\n`;
    const events = importClaudeCodeJsonl(input, emptySidecar());
    const reasoning = events.find((e) => e.kind === "reasoning.created");
    expect(reasoning).toBeDefined();
    if (reasoning?.kind !== "reasoning.created") throw new Error("type narrowing");
    expect(reasoning.extensions?.signature).toBe("sig-deadbeef");
  });
});

describe("edge case: cross-provider causality preservation on native-equivalent kinds (lossless export)", () => {
  it("tool.call causality survives claude → pi roundtrip", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-tc-1",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-tc-1",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } }],
      },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const toolCallIndex = c1.findIndex((e) => e.kind === "tool.call");
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    const original = c1[toolCallIndex];
    if (!original) throw new Error("tool.call missing");
    c1[toolCallIndex] = canonicalEventSchema.parse({
      ...original,
      causality: { turnId: "turn-7", requestId: "req-abc", spanId: "span-1" },
      extensions: { custom_tag: "team-alpha" },
    });

    const piText = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piText);
    const toolCall = c2.find((e) => e.kind === "tool.call");
    expect(toolCall).toBeDefined();
    if (toolCall?.kind !== "tool.call") throw new Error("type narrowing");
    expect(toolCall.causality?.turnId).toBe("turn-7");
    expect(toolCall.causality?.requestId).toBe("req-abc");
    expect(toolCall.causality?.spanId).toBe("span-1");
    expect(toolCall.extensions?.custom_tag).toBe("team-alpha");
  });

  it("reasoning extensions (signature) survives claude → pi → claude", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-sig-rt",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-15T12:00:01.000Z",
      sessionId: "claude-sig-rt",
      cwd: "/tmp",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret", signature: "sig-roundtrip" }],
      },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const piT = exportPiSessionJsonl(c1);
    const c2 = importPiSessionJsonl(piT);
    const claudeT = exportClaudeCodeJsonl(c2);
    const c3 = importClaudeCodeJsonl(claudeT, emptySidecar());
    const reasoning = c3.find((e) => e.kind === "reasoning.created");
    expect(reasoning).toBeDefined();
    if (reasoning?.kind !== "reasoning.created") throw new Error("type narrowing");
    expect(reasoning.extensions?.signature).toBe("sig-roundtrip");
  });

  it("tool.result causality+extensions survives claude → codex → pi", () => {
    const input = `${JSON.stringify({
      type: "system",
      subtype: "init",
      timestamp: TS,
      sessionId: "claude-tr-cause",
      cwd: "/tmp",
      version: "2.1.76",
    })}\n${JSON.stringify({
      type: "user",
      timestamp: "2026-04-15T12:00:02.000Z",
      sessionId: "claude-tr-cause",
      cwd: "/tmp",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_x", content: "ok", is_error: false }],
      },
    })}\n`;
    const c1 = importClaudeCodeJsonl(input, emptySidecar());
    const trIndex = c1.findIndex((e) => e.kind === "tool.result");
    expect(trIndex).toBeGreaterThanOrEqual(0);
    const original = c1[trIndex];
    if (!original) throw new Error("tool.result missing");
    c1[trIndex] = canonicalEventSchema.parse({
      ...original,
      causality: { turnId: "turn-tr", parentSpanId: "span-parent" },
      extensions: { latency_ms: 42 },
    });

    const codexT = exportCodexJsonl(c1);
    const c2 = importCodexJsonl(codexT);
    const piT = exportPiSessionJsonl(c2);
    const c3 = importPiSessionJsonl(piT);
    const tr = c3.find((e) => e.kind === "tool.result");
    expect(tr).toBeDefined();
    if (tr?.kind !== "tool.result") throw new Error("type narrowing");
    expect(tr.causality?.turnId).toBe("turn-tr");
    expect(tr.causality?.parentSpanId).toBe("span-parent");
    expect(tr.extensions?.latency_ms).toBe(42);
  });
});
